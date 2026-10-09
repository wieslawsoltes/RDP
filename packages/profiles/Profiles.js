const STORAGE_KEY = 'lrdp.profiles.v1';
const allowed = ['id', 'name', 'targetId', 'username', 'domain', 'security', 'width', 'height', 'bpp', 'backend', 'clipboard', 'richClipboard', 'resize', 'audio', 'microphone', 'surfaceGraphics', 'surfaceQuality'];
export function sanitizeProfile(input) {
    const value = {};
    for (const key of allowed)
        if (Object.hasOwn(input, key))
            value[key] = input[key];
    for (const key of ['id', 'name', 'targetId', 'username', 'domain'])
        value[key] = String(value[key] ?? '').replace(/[\0\r\n]/g, '').slice(0, 256);
    value.name ||= 'Remote desktop';
    value.security = value.security === 'tls' ? 'tls' : 'nla';
    value.width = Math.min(8192, Math.max(200, Math.round(Number(value.width) || 1280) & ~1));
    value.height = Math.min(8192, Math.max(200, Math.round(Number(value.height) || 800)));
    if (value.width * value.height > 16777216) {
        value.width = 1280;
        value.height = 800;
    }
    value.bpp = [15, 16, 24, 32].includes(Number(value.bpp)) ? Number(value.bpp) : 24;
    value.backend = ['auto', 'webgpu', 'webgl2', 'canvas'].includes(value.backend) ? value.backend : 'auto';
    value.clipboard = value.clipboard !== false;
    value.richClipboard = value.clipboard && value.richClipboard === true;
    value.resize = value.resize !== false;
    value.audio = value.audio === true;
    value.microphone = value.microphone === true; // Channel offer only; never device consent.
    value.surfaceGraphics = value.surfaceGraphics === true;
    value.surfaceQuality = value.surfaceQuality === 'balanced' ? 'balanced' : 'sharp';
    if (value.surfaceGraphics) value.bpp = 32;
    return value;
}
export class Profiles {
    constructor(storage = globalThis.localStorage) { this.storage = storage; this.items = []; this.load(); }
    load() {
        try {
            const data = JSON.parse(this.storage.getItem(STORAGE_KEY) || '[]');
            this.items = Array.isArray(data) ? data.slice(0, 100).map(sanitizeProfile) : [];
        }
        catch {
            this.items = [];
        }
    }
    save(profile) {
        const item = sanitizeProfile(profile);
        item.id ||= crypto.randomUUID();
        const existing = this.items.findIndex(value => value.id === item.id);
        if (existing >= 0)
            this.items[existing] = item;
        else {
            if (this.items.length >= 100)
                throw new Error('Profile limit reached');
            this.items.push(item);
        }
        this.storage.setItem(STORAGE_KEY, JSON.stringify(this.items));
        return item;
    }
    remove(id) { this.items = this.items.filter(item => item.id !== id); this.storage.setItem(STORAGE_KEY, JSON.stringify(this.items)); }
}
/** Imports connection metadata only. .rdp credentials and gateway settings are never trusted. */
export function importRdp(text) {
    if (text.length > 65536)
        throw new Error('.rdp file exceeds 64 KiB');
    const raw = new Map(), ignored = [];
    for (const line of text.replace(/^\ufeff/, '').split(/\r?\n/)) {
        const match = /^([^:]+):([isb]):(.*)$/.exec(line);
        if (!match)
            continue;
        raw.set(match[1].toLowerCase(), match[3]);
    }
    const known = new Set(['full address', 'username', 'domain', 'desktopwidth', 'desktopheight', 'session bpp', 'redirectclipboard']);
    for (const key of raw.keys())
        if (!known.has(key))
            ignored.push(key);
    return { profile: sanitizeProfile({ name: raw.get('full address') || 'Imported connection', username: raw.get('username'), domain: raw.get('domain'), width: raw.get('desktopwidth'), height: raw.get('desktopheight'), bpp: raw.get('session bpp'), clipboard: raw.get('redirectclipboard') !== '0' }), address: raw.get('full address') || '', ignored };
}
export function exportRdp(profile) {
    const p = sanitizeProfile(profile);
    // The allowlisted target ID is intentionally not misrepresented as a DNS address.
    return [`; LRDP profile: ${p.name}`, `; Bridge target ID: ${p.targetId}`, `username:s:${p.username}`, `domain:s:${p.domain}`, `desktopwidth:i:${p.width}`, `desktopheight:i:${p.height}`, `session bpp:i:${p.bpp}`, `redirectclipboard:i:${p.clipboard ? 1 : 0}`, 'enablecredsspsupport:i:1', 'authentication level:i:1', ''].join('\r\n');
}
