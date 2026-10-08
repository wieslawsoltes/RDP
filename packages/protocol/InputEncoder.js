import { Writer } from '../binary/Writer.js';
import { requireThat } from '../binary/ProtocolError.js';
export const MouseFlags = Object.freeze({ MOVE: 0x800, DOWN: 0x8000, LEFT: 0x1000, RIGHT: 0x2000, MIDDLE: 0x4000, WHEEL: 0x200, HWHEEL: 0x400 });
export function encodeInput(events) {
    requireThat(events.length >= 1 && events.length <= 128, 'INPUT_LIMIT', 'Invalid input batch size');
    const w = new Writer().u16le(events.length).u16le(0);
    for (const event of events) {
        w.u32le(0);
        if (event.type === 'key') {
            requireThat(Number.isInteger(event.code) && event.code >= 0 && event.code <= 255, 'KEYCODE', 'Invalid keyboard scan code');
            w.u16le(4).u16le((event.up ? 0x8000 : 0) | (event.extended ? 0x100 : 0) | (event.extended1 ? 0x200 : 0)).u16le(event.code).u16le(0);
        }
        else if (event.type === 'unicode') {
            requireThat(Number.isInteger(event.code) && event.code >= 0 && event.code <= 65535, 'KEYCODE', 'Invalid UTF-16 code unit');
            w.u16le(5).u16le(event.up ? 0x8000 : 0).u16le(event.code).u16le(0);
        }
        else if (event.type === 'mouse' || event.type === 'mousex') {
            requireThat(Number.isInteger(event.x) && Number.isInteger(event.y) && event.x >= 0 && event.y >= 0 && event.x <= 65535 && event.y <= 65535, 'POINTER_COORDINATE', 'Invalid pointer coordinate');
            w.u16le(event.type === 'mouse' ? 0x8001 : 0x8002).u16le(event.flags).u16le(event.x).u16le(event.y);
        }
        else if (event.type === 'sync')
            w.u16le(0).u16le(0).u16le(event.toggles & 15).u16le(0);
        else
            throw new Error('Unknown input event');
    }
    return w.finish();
}
export function unicodeEvents(text) {
    requireThat(typeof text === 'string' && text.length <= 65536, 'TEXT_LIMIT', 'Input text too long');
    const events = [];
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        events.push({ type: 'unicode', code }, { type: 'unicode', code, up: true });
    }
    return events;
}
