import { scanCode } from './ScanCodes.js';
import { MouseFlags as M } from '../protocol/InputEncoder.js';
/** Local touch/pen map to one mouse pointer, not native RDP touch redirection. */
export class InputController {
    constructor(canvas, { send, text, position = () => { }, dimensions }) {
        this.canvas = canvas;
        this.send = send;
        this.text = text;
        this.position = position;
        this.dimensions = dimensions;
        this.keys = new Map();
        this.buttons = new Set();
        this.abort = new AbortController();
        this.last = { x: 0, y: 0 };
        this.pendingMove = null;
        const on = (target, name, callback, options = {}) => target.addEventListener(name, callback, { ...options, signal: this.abort.signal });
        on(canvas, 'keydown', event => this.key(event, false));
        on(canvas, 'keyup', event => this.key(event, true));
        on(canvas, 'compositionend', event => {
            if (event.data)
                text(event.data);
        });
        on(canvas, 'contextmenu', event => event.preventDefault());
        on(canvas, 'pointerdown', event => this.pointer(event, true));
        on(canvas, 'pointerup', event => this.pointer(event, false));
        on(canvas, 'pointercancel', () => this.release());
        on(canvas, 'lostpointercapture', () => this.releaseButtons());
        on(canvas, 'pointermove', event => {
            if (event.isPrimary === false)
                return;
            this.last = this.coordinates(event);
            this.position(this.last);
            this.pendingMove = { type: 'mouse', flags: M.MOVE, ...this.last };
            if (!this.raf)
                this.raf = requestAnimationFrame(() => { this.raf = 0; this.flushMove(); });
        });
        on(canvas, 'wheel', event => {
            event.preventDefault();
            this.flushMove();
            this.last = this.coordinates(event);
            const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 240 : 1;
            for (const [delta, flag, sign] of [[event.deltaY, M.WHEEL, -1], [event.deltaX, M.HWHEEL, 1]]) {
                if (!delta)
                    continue;
                const rotation = Math.max(-255, Math.min(255, Math.round(delta * scale * sign))) || sign;
                this.send([{ type: 'mouse', flags: flag | (rotation & 0x1ff), ...this.last }]);
            }
        }, { passive: false });
        on(canvas, 'blur', () => this.release());
        on(window, 'blur', () => this.release());
        on(document, 'visibilitychange', () => {
            if (document.hidden)
                this.release();
        });
    }
    coordinates(event) {
        const rect = this.canvas.getBoundingClientRect(), { width, height } = this.dimensions();
        return {
            x: Math.max(0, Math.min(width - 1, Math.floor((event.clientX - rect.left) * width / Math.max(1, rect.width)))),
            y: Math.max(0, Math.min(height - 1, Math.floor((event.clientY - rect.top) * height / Math.max(1, rect.height)))),
        };
    }
    key(event, up) {
        if (event.isComposing || event.key === 'Process' || event.key === 'Dead')
            return;
        const key = scanCode(event.code, up);
        if (!key) {
            if (!up && !event.ctrlKey && !event.metaKey && event.key?.length === 1) {
                event.preventDefault();
                this.text(event.key);
            }
            return;
        }
        event.preventDefault();
        if (up)
            this.keys.delete(event.code);
        else
            this.keys.set(event.code, key);
        this.send([key]);
    }
    flushMove() {
        if (this.pendingMove) {
            this.send([this.pendingMove]);
            this.pendingMove = null;
        }
    }
    pointer(event, down) {
        if (event.isPrimary === false)
            return;
        event.preventDefault();
        this.flushMove();
        this.last = this.coordinates(event);
        this.position(this.last);
        if (down) {
            this.canvas.focus({ preventScroll: true });
            this.canvas.setPointerCapture(event.pointerId);
            this.buttons.add(event.button);
        }
        else
            this.buttons.delete(event.button);
        this.send([this.buttonEvent(event.button, down)]);
        if (!down && !this.buttons.size && this.canvas.hasPointerCapture(event.pointerId))
            this.canvas.releasePointerCapture(event.pointerId);
    }
    buttonEvent(button, down) {
        if (button >= 3)
            return { type: 'mousex', flags: (button === 3 ? 1 : 2) | (down ? M.DOWN : 0), ...this.last };
        return { type: 'mouse', flags: [M.LEFT, M.MIDDLE, M.RIGHT][button] | (down ? M.DOWN : 0), ...this.last };
    }
    releaseButtons() {
        const events = [...this.buttons].map(button => this.buttonEvent(button, false));
        this.buttons.clear();
        if (events.length)
            this.send(events);
    }
    release() {
        this.flushMove();
        this.releaseButtons();
        const events = [...this.keys.values()].map(key => ({ ...key, up: true }));
        this.keys.clear();
        for (let index = 0; index < events.length; index += 128)
            this.send(events.slice(index, index + 128));
    }
    destroy() {
        this.release();
        this.abort.abort();
        if (this.raf)
            cancelAnimationFrame(this.raf);
    }
}
