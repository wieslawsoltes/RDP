import { Reader } from '../binary/Reader.js';
import { Writer } from '../binary/Writer.js';
import { requireThat } from '../binary/ProtocolError.js';
export const DISPLAY_CHANNEL = 'Microsoft::Windows::RDS::DisplayControl';
export class DisplayControl {
    constructor(send, emit = () => { }) { this.send = send; this.emit = emit; this.caps = null; }
    receive(bytes) {
        const r = new Reader(bytes), type = r.u32le(), length = r.u32le();
        requireThat(length === bytes.length && type === 5 && length === 20, 'DISPLAY_CAPS', 'Invalid display-control capabilities');
        const maxMonitors = r.u32le(), factorA = r.u32le(), factorB = r.u32le();
        r.end();
        requireThat(maxMonitors > 0 && maxMonitors <= 1024 && factorA > 0 && factorB > 0, 'DISPLAY_CAPS', 'Invalid monitor-area limits');
        this.caps = { maxMonitors, maxArea: BigInt(maxMonitors) * BigInt(factorA) * BigInt(factorB) };
        this.emit({ type: 'ready', maxMonitors, maxArea: this.caps.maxArea.toString() });
    }
    resize(width, height, scale = 100) {
        requireThat(this.caps, 'DISPLAY_STATE', 'Server has not enabled dynamic resolution');
        requireThat(Number.isInteger(width) && width >= 200 && width <= 8192 && width % 2 === 0 && Number.isInteger(height) && height >= 200 && height <= 8192 && width * height <= 16777216, 'DISPLAY_SIZE', 'Unsupported desktop dimensions');
        requireThat(BigInt(width * height) <= this.caps.maxArea && [100, 125, 150, 175, 200, 250, 300, 400, 500].includes(scale), 'DISPLAY_AREA', 'Monitor layout exceeds server capabilities');
        const physicalWidth = Math.max(10, Math.min(10000, Math.round(width * 25.4 / 96))), physicalHeight = Math.max(10, Math.min(10000, Math.round(height * 25.4 / 96)));
        const pdu = new Writer().u32le(2).u32le(56).u32le(40).u32le(1)
            .u32le(1).i32le(0).i32le(0).u32le(width).u32le(height).u32le(physicalWidth).u32le(physicalHeight).u32le(0).u32le(scale).u32le(100).finish();
        this.send(pdu);
        this.emit({ type: 'requested', width, height });
    }
    close() { this.caps = null; this.emit({ type: 'closed' }); }
}
