import { Writer, utf16 } from '../binary/Writer.js';
import { requireThat } from '../binary/ProtocolError.js';
/** Secure settings. Caller MUST send only after certificate-verified TLS. */
export function clientInfo({ domain = '', username = '', password = '', keyboardLayout = 0x409, performanceFlags = 0x85, audio = false, nla = true, compression = true } = {}) {
    for (const value of [domain, username, password])
        requireThat(typeof value === 'string' && value.length <= 1024 && !value.includes('\0'), 'CREDENTIAL_LENGTH', 'Invalid credential field');
    // Negotiate MPPC 8/64 KiB, but no RemoteApp, saved credentials or reconnect cookie.
    const flags = (compression ? 0x280 : 0) | 1 | 2 | 0x10 | 0x20 | 0x100 | 0x10000 | (username && (password || nla) ? 8 : 0) | (audio ? 0 : 0x80000);
    const strings = [domain, username, nla ? '' : password, '', ''].map(s => utf16(s));
    const w = new Writer().u16le(0x40).u16le(0).u32le(keyboardLayout & 0xffff).u32le(flags);
    for (const s of strings)
        w.u16le(s.length);
    for (const s of strings)
        w.put(s).u16le(0);
    const address = utf16('0.0.0.0', true), directory = utf16('LRDP Web', true);
    w.u16le(2).u16le(address.length).put(address).u16le(directory.length).put(directory);
    // UTC, no DST. Dynamic time-zone redirection is intentionally not advertised.
    w.i32le(0).fixedUtf16('UTC', 64).zeros(16).i32le(0).fixedUtf16('UTC', 64).zeros(16).i32le(0)
        .u32le(0).u32le(performanceFlags).u16le(0).u16le(0).u16le(0);
    return w.finish();
}
