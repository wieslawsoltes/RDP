import { randomBytes } from 'node:crypto';
import { Writer, concat } from '../binary/Writer.js';
import { requireThat, ProtocolError } from '../binary/ProtocolError.js';
import { LicenseType as T, parseLicenseHeader, parseLicenseRequest, parseLicenseError, parseNewLicense, readBlob, putBlob, encodeLicenseString, licensePdu } from './Messages.js';
import { deriveLicenseKeys, licensePublicKey, encryptPremaster, licenseMac, verifyLicenseMac, licenseCrypt } from './Crypto.js';

/**
 * Client-side MS-RDPELE exchange. Server-issued CAL bytes remain opaque.
 * The caller persists result.license BEFORE releasing the completed exchange.
 * No license is generated locally and server denials never become success.
 */
export class LicenseClient {
    constructor({ secureTransport, hardwareId, username, machineName, findLicense = () => null, serverCertificate } = {}) {
        requireThat(secureTransport === true, 'LICENSE_TRANSPORT', 'Licensing requires a separately authenticated encrypted transport');
        requireThat(hardwareId instanceof Uint8Array && hardwareId.length === 20, 'LICENSE_HWID', 'Licensing needs a stable 20-byte device identifier');
        requireThat(typeof findLicense === 'function', 'LICENSE_STORE', 'Invalid licensing store provider');
        this.hardwareId = hardwareId.slice();
        requireThat(typeof username === 'string' && username.length <= 2047 && !username.includes('\0'), 'LICENSE_STRING', 'Invalid licensing user name');
        this.username = username;
        this.machineName = encodeLicenseString(machineName);
        this.findLicense = findLicense; this.serverCertificate = serverCertificate;
        this.state = 'await-request'; this.keys = null; this.last = null; this.request = null;
        this.messages = 0; this.resends = 0; this.resets = 0;
    }
    receive(bytes) {
        try {
            requireThat(!['complete', 'closed', 'failed'].includes(this.state) && ++this.messages <= 32,
                'LICENSE_STATE', 'Licensing is complete, closed or exceeded its message budget');
            const { type, version, reader: r } = parseLicenseHeader(bytes);
            this.version = version;
            if (type === T.ERROR) return this.error(parseLicenseError(r));
            if (type === T.REQUEST) return this.begin(parseLicenseRequest(r));
            if (type === T.CHALLENGE) return this.challenge(r);
            if (type === T.NEW || type === T.UPGRADE) return this.issued(r, type);
            throw new ProtocolError('LICENSE_MESSAGE', 'Unexpected licensing message type');
        } catch (error) { this.clearExchange(); this.state = 'failed'; throw error; }
    }
    reply(type, body, status) {
        const response = licensePdu(type, body, this.version);
        this.last?.fill(0); this.last = response.slice();
        return { response, complete: false, status };
    }
    begin(request) {
        requireThat(this.state === 'await-request', 'LICENSE_STATE', 'Repeated licensing request without a reset');
        const publicKey = licensePublicKey(request.certificate, this.serverCertificate);
        const clientRandom = randomBytes(32), premaster = randomBytes(48);
        this.request = request;
        let encrypted;
        try {
            this.keys = deriveLicenseKeys(premaster, clientRandom, request.serverRandom);
            encrypted = encryptPremaster(premaster, publicKey);
        } finally { premaster.fill(0); }
        const platform = new DataView(this.hardwareId.buffer, this.hardwareId.byteOffset, 4).getUint32(0, true);
        const w = putBlob(new Writer().u32le(1).u32le(platform).put(clientRandom), 2, encrypted);
        clientRandom.fill(0); encrypted.fill(0);
        const stored = this.findLicense(request);
        this.state = 'await-challenge';
        if (stored) {
            requireThat(stored.data instanceof Uint8Array && stored.data.length > 0 && stored.data.length <= 60000,
                'LICENSE_STORE', 'Invalid cached license');
            const encryptedHwid = licenseCrypt(this.keys.encryption, this.hardwareId);
            putBlob(w, 1, stored.data); putBlob(w, 9, encryptedHwid);
            w.put(licenseMac(this.keys.mac, this.hardwareId)); encryptedHwid.fill(0);
            return this.reply(T.INFO, w.finish(), 'cached-license');
        }
        const userBytes = encodeLicenseString(this.username);
        try { putBlob(w, 15, userBytes); } finally { userBytes.fill(0); }
        putBlob(w, 16, this.machineName);
        return this.reply(T.NEW_REQUEST, w.finish(), 'requesting-license');
    }
    challenge(r) {
        requireThat(this.state === 'await-challenge' && this.keys, 'LICENSE_STATE', 'Platform challenge out of sequence');
        r.u32le(); // Reserved ConnectFlags.
        const encrypted = readBlob(r, undefined, 4096), mac = r.take(16); r.end();
        requireThat(encrypted.length > 0, 'LICENSE_CHALLENGE', 'Empty server challenge');
        const challenge = licenseCrypt(this.keys.encryption, encrypted);
        let answer, encryptedAnswer, encryptedHwid;
        try {
            verifyLicenseMac(this.keys.mac, challenge, mac);
            answer = new Writer().u16le(0x0100).u16le(0xff00).u16le(3).u16le(challenge.length).put(challenge).finish();
            encryptedAnswer = licenseCrypt(this.keys.encryption, answer);
            encryptedHwid = licenseCrypt(this.keys.encryption, this.hardwareId);
            const w = putBlob(putBlob(new Writer(), 9, encryptedAnswer), 9, encryptedHwid);
            w.put(licenseMac(this.keys.mac, answer, this.hardwareId));
            this.state = 'await-license';
            return this.reply(T.RESPONSE, w.finish(), 'challenge-verified');
        } finally { challenge.fill(0); answer?.fill(0); encryptedAnswer?.fill(0); encryptedHwid?.fill(0); }
    }
    issued(r, type) {
        requireThat(this.state === 'await-license' && this.keys, 'LICENSE_STATE', 'New or upgraded license out of sequence');
        // Old servers leave the blob type undefined; its bounded length still applies.
        const encrypted = readBlob(r), mac = r.take(16); r.end();
        const plain = licenseCrypt(this.keys.encryption, encrypted);
        let license;
        try {
            verifyLicenseMac(this.keys.mac, plain, mac);
            license = parseNewLicense(plain);
            requireThat(license.company === this.request.company && license.product === this.request.product &&
                this.request.scopes.includes(license.scope) && license.version >= this.request.version,
                'LICENSE_INDEX', 'Issued license does not match the requested product, scope or version');
            const result = { response: null, complete: true, status: type === T.NEW ? 'license-issued' : 'license-upgraded', license };
            this.clearExchange(); this.state = 'complete';
            return result;
        } catch (error) { license?.data.fill(0); throw error; }
        finally { plain.fill(0); }
    }
    error({ code, transition }) {
        if (code === 7 && transition === 2) {
            this.clearExchange(); this.state = 'complete';
            return { response: null, complete: true, status: 'valid-client' };
        }
        requireThat(code !== 7 && transition !== 1 && transition !== 2, 'LICENSE_DENIED', `Server licensing error ${code}, transition ${transition}`);
        if (transition === 3) {
            requireThat(++this.resets <= 3, 'LICENSE_RETRIES', 'Licensing reset limit exceeded');
            this.clearExchange(); this.state = 'await-request';
            return { response: null, complete: false, status: 'reset' };
        }
        requireThat(this.last && ++this.resends <= 3, 'LICENSE_RETRIES', 'No licensing message to resend or retry limit exceeded');
        return { response: this.last.slice(), complete: false, status: 'resent' };
    }
    clearExchange() {
        this.keys?.mac.fill(0); this.keys?.encryption.fill(0); this.keys = null;
        this.last?.fill(0); this.last = null;
        this.request?.serverRandom.fill(0); this.request?.certificate.fill(0); this.request = null;
    }
    close() {
        this.clearExchange(); this.hardwareId.fill(0); this.username = '';  this.machineName.fill(0);
        this.findLicense = () => null; this.serverCertificate = null; this.state = 'closed';
    }
}
