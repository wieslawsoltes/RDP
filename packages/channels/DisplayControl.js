import { Reader } from '../binary/Reader.js';
import { Writer } from '../binary/Writer.js';
import { requireThat } from '../binary/ProtocolError.js';
import { normalizeMonitorLayout } from '../protocol/MonitorLayout.js';
export const DISPLAY_CHANNEL = 'Microsoft::Windows::RDS::DisplayControl';

export function encodeDisplayLayout(layout) {
    const w = new Writer().u32le(2).u32le(16 + 40 * layout.monitors.length).u32le(40).u32le(layout.monitors.length);
    for (const m of layout.monitors)
        w.u32le(m.primary ? 1 : 0).i32le(m.left).i32le(m.top).u32le(m.width).u32le(m.height)
            .u32le(m.physicalWidth).u32le(m.physicalHeight).u32le(m.orientation)
            .u32le(m.desktopScaleFactor).u32le(m.deviceScaleFactor);
    return w.finish();
}
export function parseDisplayLayout(bytes, limits) {
    const r = new Reader(bytes);
    requireThat(r.u32le() === 2 && r.u32le() === bytes.length && r.u32le() === 40,
        'DISPLAY_LAYOUT', 'Invalid display layout header');
    const count = r.u32le();
    requireThat(count >= 1 && count <= 16 && r.remaining === count * 40, 'DISPLAY_LAYOUT', 'Invalid display layout count');
    const monitors = [];
    for (let i = 0; i < count; i++) {
        const flags = r.u32le();
        requireThat((flags & ~1) === 0, 'MONITOR_FLAGS', 'Invalid display layout flags');
        monitors.push({ primary: flags === 1, left: r.i32le(), top: r.i32le(), width: r.u32le(), height: r.u32le(),
            physicalWidth: r.u32le(), physicalHeight: r.u32le(), orientation: r.u32le(),
            desktopScaleFactor: r.u32le(), deviceScaleFactor: r.u32le() });
    }
    r.end();
    return normalizeMonitorLayout(monitors, limits);
}
export class DisplayControl {
    constructor(send, emit = () => { }) { this.send = send; this.emit = emit; this.caps = null; }
    receive(bytes) {
        const r = new Reader(bytes), type = r.u32le(), length = r.u32le();
        requireThat(length === bytes.length && type === 5 && length === 20, 'DISPLAY_CAPS', 'Invalid display-control capabilities');
        const maxMonitors = r.u32le(), factorA = r.u32le(), factorB = r.u32le();
        r.end();
        requireThat(maxMonitors > 0 && factorA > 0 && factorB > 0, 'DISPLAY_CAPS', 'Invalid monitor-area limits');
        this.caps = { maxMonitors, maxArea: BigInt(maxMonitors) * BigInt(factorA) * BigInt(factorB) };
        this.emit({ type: 'ready', maxMonitors: Math.min(16, maxMonitors), maxArea: this.caps.maxArea.toString() });
    }
    layout(monitors) {
        requireThat(this.caps, 'DISPLAY_STATE', 'Server has not enabled display control');
        const layout = normalizeMonitorLayout(monitors, this.caps);
        this.send(encodeDisplayLayout(layout));
        this.emit({ type: 'requested', ...layout });
        return layout;
    }
    resize(width, height, scale = 100) {
        return this.layout([{ primary: true, left: 0, top: 0, width, height, desktopScaleFactor: scale }]);
    }
    close() { this.caps = null; this.emit({ type: 'closed' }); }
}
