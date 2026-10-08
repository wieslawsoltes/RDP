/** Synthetic test desktop, never represented as a real operating system. */
export class LabDesktop {
    constructor(server, canDraw = () => true) {
        this.server = server;
        this.canDraw = canDraw;
        this.counter = 0;
        this.typed = '';
        this.clipboard = 'Clipboard ready';
        this.inputCount = 0;
        this.pointer = { x: 0, y: 0 };
        this.running = true;
        server.onActive = (width, height) => this.resize(width, height);
        server.onInput = events => this.input(events);
        server.onClipboard = text => { this.clipboard = text; this.redrawPanel(); };
        this.timer = setInterval(() => this.animate(), 100);
    }
    resize(width, height) {
        this.width = width;
        this.height = height;
        this.canvas = new OffscreenCanvas(width, height);
        this.context = this.canvas.getContext('2d', { alpha: false, willReadFrequently: true });
        const c = this.context, gradient = c.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, '#17283d');
        gradient.addColorStop(0.55, '#152633');
        gradient.addColorStop(1, '#244536');
        c.fillStyle = gradient;
        c.fillRect(0, 0, width, height);
        c.strokeStyle = '#ffffff07';
        c.lineWidth = 1;
        for (let x = 0; x < width; x += 40) {
            c.beginPath();
            c.moveTo(x, 0);
            c.lineTo(x, height);
            c.stroke();
        }
        for (let y = 0; y < height; y += 40) {
            c.beginPath();
            c.moveTo(0, y);
            c.lineTo(width, y);
            c.stroke();
        }
        c.fillStyle = '#101a27';
        c.fillRect(0, 0, width, 38);
        c.fillStyle = '#b6cfcb';
        c.font = '12px sans-serif';
        c.fillText('LRDP  /  PROTOCOL LOOPBACK', 18, 24);
        c.textAlign = 'right';
        c.fillText('Synthetic desktop · no remote OS', width - 18, 24);
        c.textAlign = 'left';
        this.panel = { x: Math.max(12, Math.round(width * 0.12)), y: 76, w: Math.min(width - 24, 690), h: Math.min(height - 120, 415) };
        if (this.panel.h < 120)
            this.panel.h = 120;
        this.drawPanel();
        this.push(0, 0, width, height);
    }
    text(value, x, y, color = '#c8d4de', size = 13) { const c = this.context; c.fillStyle = color; c.font = `${size}px sans-serif`; c.fillText(String(value), x, y); }
    drawPanel() {
        if (!this.context)
            return;
        const c = this.context, p = this.panel;
        c.fillStyle = '#0c1420';
        c.fillRect(p.x, p.y, p.w, p.h);
        c.strokeStyle = '#3d525e';
        c.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
        c.fillStyle = '#1b2837';
        c.fillRect(p.x + 1, p.y + 1, p.w - 2, 38);
        this.text('Protocol Lab', p.x + 18, p.y + 25, '#e3ecef', 14);
        c.save();
        c.beginPath();
        c.rect(p.x + 12, p.y + 44, p.w - 24, p.h - 54);
        c.clip();
        this.text('A real packet-to-pixel path.', p.x + 22, p.y + 78, '#eef4f4', 24);
        this.text('Local RDP test peer → MCS → Share Data → bitmap decoder → renderer', p.x + 22, p.y + 108, '#879dac', 12);
        this.text('INPUT EVENTS', p.x + 22, p.y + 149, '#61d8b2', 10);
        this.text(`${this.inputCount} received  ·  pointer ${this.pointer.x}, ${this.pointer.y}`, p.x + 22, p.y + 173);
        this.text('UNICODE INPUT', p.x + 22, p.y + 211, '#61d8b2', 10);
        this.text(this.typed.slice(-65) || 'Use the keyboard panel to send text, including Unicode.', p.x + 22, p.y + 235);
        this.text('REMOTE CLIPBOARD', p.x + 22, p.y + 273, '#61d8b2', 10);
        this.text(this.clipboard.replace(/\n/g, ' ↵ ').slice(0, 75), p.x + 22, p.y + 297);
        this.text('Resize uses the display-control channel and session reactivation.', p.x + 22, p.y + 338, '#879dac', 12);
        this.text('This fixture is not a Windows interoperability test.', p.x + 22, p.y + 362, '#ddba77', 12);
        c.restore();
    }
    input(events) {
        for (const event of events) {
            this.inputCount++;
            if (event.type === 0x8001 || event.type === 0x8002)
                this.pointer = { x: event.a, y: event.b };
            if (event.type === 5 && !(event.flags & 0x8000))
                this.typed = (this.typed + String.fromCharCode(event.a)).slice(-256);
            if (event.type === 4 && !(event.flags & 0x8000) && event.a === 0x0e)
                this.typed = this.typed.slice(0, -1);
        }
        this.dirty = true;
    }
    redrawPanel() { this.dirty = true; }
    animate() {
        if (!this.context || this.server.state !== 'active' || !this.canDraw())
            return;
        if (this.dirty) {
            this.dirty = false;
            this.drawPanel();
            const p = this.panel;
            this.push(p.x, p.y, p.w, p.h);
        }
        const c = this.context, y = this.height - 30, w = Math.min(this.width, 330);
        c.fillStyle = '#101a27';
        c.fillRect(0, y, w, 30);
        this.counter++;
        this.text(`●  LIVE FIXTURE     frame ${this.counter}     ${this.width} × ${this.height}`, 16, y + 20, '#77d6b6', 11);
        this.push(0, y, w, 30);
    }
    push(x, y, width, height) {
        const x0 = Math.max(0, x), y0 = Math.max(0, y), w = Math.min(width, this.width - x0), h = Math.min(height, this.height - y0);
        if (w > 0 && h > 0)
            this.server.bitmap(x0, y0, w, h, this.context.getImageData(x0, y0, w, h).data);
    }
    close() { clearInterval(this.timer); this.server.close(); this.context = this.canvas = null; }
}
