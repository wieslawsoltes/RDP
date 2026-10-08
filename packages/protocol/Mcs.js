import { Reader } from '../binary/Reader.js';
import { Writer, concat } from '../binary/Writer.js';
import { tlv, sequence, integer, octet, readTlv, readInteger } from '../binary/Asn1.js';
import { requireThat } from '../binary/ProtocolError.js';
import { conferenceRequest, parseConferenceResponse } from './Gcc.js';
import { dataPdu } from './X224.js';
function domainParameters(channels, users, tokens, maxPdu) {
    return sequence(...[channels, users, tokens, 1, 0, 1, maxPdu, 2].map(v => integer(v)));
}
export function connectInitial(options, channels) {
    const body = concat(octet(Uint8Array.of(1)), octet(Uint8Array.of(1)), tlv(1, Uint8Array.of(255)), domainParameters(34, 2, 0, 65535), domainParameters(1, 1, 1, 1056), domainParameters(65535, 64535, 65535, 65535), octet(conferenceRequest(options, channels)));
    return dataPdu(tlv(0x7f65, body));
}
export function parseConnectResponse(bytes, options) {
    const r = new Reader(bytes), body = readTlv(r, 0x7f66).reader;
    r.end();
    requireThat(readInteger(body, 10) === 0, 'MCS_CONNECT', 'MCS connection rejected');
    readInteger(body);
    const params = readTlv(body, 0x30).reader;
    const values = [];
    while (params.remaining)
        values.push(readInteger(params));
    requireThat(values.length === 8 && values[6] >= 1024 && values[7] === 2, 'MCS_PARAMETERS', 'Invalid MCS domain parameters');
    const gcc = readTlv(body, 4).reader;
    body.end();
    return { ...parseConferenceResponse(gcc.bytes, options), maxPdu: values[6] };
}
export const erectDomainRequest = () => dataPdu(Uint8Array.of(4, 1, 0, 1, 0));
export const attachUserRequest = () => dataPdu(Uint8Array.of(0x28));
export function parseAttachConfirm(bytes) {
    const r = new Reader(bytes);
    r.expect(0x2e);
    requireThat(r.u8() === 0, 'MCS_ATTACH', 'MCS user attachment rejected');
    const userId = r.u16be() + 1001;
    r.end();
    requireThat(userId <= 65535, 'MCS_USER', 'Invalid MCS user');
    return userId;
}
export const joinRequest = (userId, channelId) => dataPdu(new Writer().u8(0x38).u16be(userId - 1001).u16be(channelId).finish());
export function parseJoinConfirm(bytes, userId, channelId) {
    const r = new Reader(bytes);
    r.expect(0x3e);
    requireThat(r.u8() === 0 && r.u16be() + 1001 === userId && r.u16be() === channelId && r.u16be() === channelId, 'MCS_JOIN', 'MCS channel join rejected or mismatched');
    r.end();
}
export function sendData(userId, channelId, bytes) {
    return dataPdu(new Writer(bytes.length + 8).u8(0x64).u16be(userId - 1001).u16be(channelId).u8(0x70).perLength(bytes.length).put(bytes).finish());
}
export function parseSendData(bytes, server = true) {
    const r = new Reader(bytes);
    r.expect(server ? 0x68 : 0x64);
    const initiator = r.u16be() + 1001, channelId = r.u16be(), priority = r.u8();
    // Only unsegmented MCS packets are negotiated. Static channels fragment separately.
    requireThat((priority & 0x30) === 0x30, 'MCS_SEGMENT', 'Segmented MCS traffic was not negotiated');
    const data = r.take(r.perLength());
    r.end();
    return { initiator, channelId, data };
}
