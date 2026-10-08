import { Reader } from '../binary/Reader.js';
import { Writer } from '../binary/Writer.js';
import { requireThat } from '../binary/ProtocolError.js';

export const MONITOR_LIMITS = Object.freeze({ maxMonitors: 16, maxDimension: 8192, maxPixels: 16777216 });
const integer = (value, min, max, field) => {
    requireThat(Number.isInteger(value) && value >= min && value <= max,
        'MONITOR_FIELD', `Invalid monitor ${field}`);
    return value;
};
/** Copies, validates and freezes topology. Coordinates are primary-monitor relative;
 * canvas/input coordinates remain bounding-desktop relative. Limits also cover gaps. */
export function normalizeMonitorLayout(input, { maxMonitors = 16, maxArea = null, evenWidth = true } = {}) {
    requireThat(Array.isArray(input) && input.length >= 1 && input.length <= Math.min(16, maxMonitors),
        'MONITOR_COUNT', 'Monitor count exceeds negotiated or client limits');
    const monitors = input.map(source => {
        requireThat(source && typeof source === 'object', 'MONITOR_FIELD', 'Invalid monitor definition');
        const left = integer(source.left ?? 0, -32766, 32766, 'left');
        const top = integer(source.top ?? 0, -32766, 32766, 'top');
        const width = integer(source.width, 200, 8192, 'width');
        const height = integer(source.height, 200, 8192, 'height');
        requireThat(!evenWidth || width % 2 === 0, 'MONITOR_WIDTH', 'Display-control width must be even');
        const primary = source.primary === true;
        requireThat(source.primary === undefined || typeof source.primary === 'boolean', 'MONITOR_PRIMARY', 'Primary flag must be Boolean');
        requireThat(!primary || (left === 0 && top === 0), 'MONITOR_PRIMARY', 'Primary monitor must start at (0, 0)');
        const orientation = source.orientation ?? 0;
        requireThat([0, 90, 180, 270].includes(orientation), 'MONITOR_ORIENTATION', 'Invalid display orientation');
        const desktopScaleFactor = integer(source.desktopScaleFactor ?? 100, 100, 500, 'desktop scale');
        const deviceScaleFactor = source.deviceScaleFactor ?? 100;
        requireThat([100, 140, 180].includes(deviceScaleFactor), 'MONITOR_SCALE', 'Invalid device scale');
        const physicalWidth = integer(source.physicalWidth ?? Math.round(width * 25.4 / 96), 10, 10000, 'physical width');
        const physicalHeight = integer(source.physicalHeight ?? Math.round(height * 25.4 / 96), 10, 10000, 'physical height');
        return Object.freeze({ left, top, width, height, primary, orientation, desktopScaleFactor,
            deviceScaleFactor, physicalWidth, physicalHeight });
    });
    requireThat(monitors.filter(m => m.primary).length === 1, 'MONITOR_PRIMARY', 'Exactly one primary monitor is required');
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity, area = 0;
    for (let i = 0; i < monitors.length; i++) {
        const m = monitors[i];
        left = Math.min(left, m.left); top = Math.min(top, m.top);
        right = Math.max(right, m.left + m.width); bottom = Math.max(bottom, m.top + m.height);
        area += m.width * m.height;
        for (let j = 0; j < i; j++) {
            const n = monitors[j];
            requireThat(!(m.left < n.left + n.width && n.left < m.left + m.width &&
                m.top < n.top + n.height && n.top < m.top + m.height), 'MONITOR_OVERLAP', 'Monitors must not overlap');
        }
    }
    const width = right - left, height = bottom - top;
    requireThat(width <= 8192 && height <= 8192 && width * height <= 16777216,
        'MONITOR_BUDGET', 'Bounding desktop exceeds the 8192-dimension / 16-megapixel renderer budget');
    requireThat(maxArea === null || BigInt(area) <= BigInt(maxArea), 'MONITOR_AREA', 'Monitor area exceeds server capabilities');
    return Object.freeze({ monitors: Object.freeze(monitors), left, top, width, height, area });
}

/** TS_MONITOR_DEF: right/bottom are inclusive, unlike JS half-open rectangles. */
export function writeMonitorDefinitions(writer, layout) {
    for (const m of layout.monitors)
        writer.i32le(m.left).i32le(m.top).i32le(m.left + m.width - 1)
            .i32le(m.top + m.height - 1).u32le(m.primary ? 1 : 0);
    return writer;
}
export function encodeServerMonitorLayout(input) {
    const layout = normalizeMonitorLayout(input, { evenWidth: false });
    return writeMonitorDefinitions(new Writer().u32le(layout.monitors.length), layout).finish();
}
export function parseServerMonitorLayout(bytes) {
    const r = new Reader(bytes), count = r.u32le();
    requireThat(count >= 1 && count <= 16 && r.remaining === count * 20,
        'MONITOR_LENGTH', 'Invalid server monitor layout length');
    const monitors = [];
    for (let i = 0; i < count; i++) {
        const left = r.i32le(), top = r.i32le(), right = r.i32le(), bottom = r.i32le(), flags = r.u32le();
        requireThat((flags & ~1) === 0, 'MONITOR_FLAGS', 'Reserved monitor flags are set');
        monitors.push({ left, top, width: right - left + 1, height: bottom - top + 1, primary: flags === 1 });
    }
    r.end();
    return normalizeMonitorLayout(monitors, { evenWidth: false });
}
