import { BrowserMicrophone } from './BrowserMicrophone.js';
import { BrowserAudio } from './BrowserAudio.js';
import { readBrowserClipboard, writeBrowserClipboard, releaseClipboardContent, ClipboardSnapshot } from './BrowserClipboard.js';
import { normalizeMonitorLayout } from '../../packages/protocol/MonitorLayout.js';
import { createRenderer } from '../../packages/render/RendererFactory.js';
import { InputController } from '../../packages/input/InputController.js';
import { chord } from '../../packages/input/ScanCodes.js';
import { icon, button, download, toast, formatBytes, element } from './ui.js';
export class SessionView {
    constructor({ options, mode, password, token, onClose, onSelect, onReconnect }) {
        this.id = crypto.randomUUID();
        this.options = { ...options, audio: options.audio === true && typeof globalThis.AudioContext === 'function',
            microphone: mode === 'remote' && options.microphone === true && typeof globalThis.AudioWorkletNode === 'function' && !!navigator.mediaDevices?.getUserMedia };
        this.mode = mode;
        this.onClose = onClose;
        this.onReconnect = onReconnect;
        this.width = options.width;
        this.height = options.height;
        this.state = 'initializing';
        this.fit = true;
        this.zoom = 1;
        this.commands = [];
        this.log = [];
        this.stats = {};
        this.displayReady = false;
        this.closed = false;
        this.clipboardSnapshot = new ClipboardSnapshot();
        this.clipboardReading = false;
        this.rendering = false;
        this.tab = element('div', 'session-tab');
        this.tab.append(icon(mode === 'lab' ? 'chip' : 'monitor'));
        const title = button(mode === 'lab' ? 'Protocol Lab' : options.name, { className: 'tab-title' });
        title.onclick = onSelect;
        const close = button('', { className: 'icon-button close-tab', symbol: 'close', title: 'Disconnect and close session' });
        close.onclick = () => onClose(this);
        this.tab.append(title, close);
        this.root = element('section', 'session-view');
        this.root.setAttribute('aria-label', title.textContent);
        this.build();
        this.ready = this.initialize({ password, token });
    }
    build() {
        const toolbar = this.toolbar = element('div', 'toolbar');
        this.fitButton = button('Fit', { className: 'small-button', title: 'Fit remote desktop to viewport' });
        this.fitButton.onclick = () => { this.fit = true; this.layout(); };
        this.nativeButton = button('1:1', { className: 'small-button', title: 'One CSS pixel per remote pixel' });
        this.nativeButton.onclick = () => { this.fit = false; this.zoom = 1; this.layout(); };
        const resolution = this.resolution = element('select');
        resolution.setAttribute('aria-label', 'Remote desktop resolution');
        for (const [label, value] of [['Resize desktop', ''], ['800 × 600', '800x600'], ['1280 × 800', '1280x800'], ['1600 × 900', '1600x900'], ['1920 × 1080', '1920x1080'], ['2560 × 1440', '2560x1440'], ['Fit remote size to viewport', 'viewport']]) {
            const option = element('option', '', label);
            option.value = value;
            resolution.append(option);
        }
        resolution.disabled = true;
        resolution.onchange = () => this.requestResize(resolution.value);
        toolbar.append(this.fitButton, this.nativeButton, element('span', 'separator'), resolution);
        const cad = button('Ctrl Alt Del', { className: 'small-button', title: 'Send Ctrl+Alt+Delete to the remote session' });
        cad.onclick = () => this.post({ type: 'input', events: chord(['ControlLeft', 'AltLeft', 'Delete']) });
        toolbar.append(cad, element('span', 'separator'));
        if (this.options.audio) {
            this.audio = new BrowserAudio({ consume: (id, disposition) => this.post({ type: 'audio-consumed', id, disposition }),
                status: value => { if (this.audioStatus) this.audioStatus.textContent = `Sound: ${value}`; } });
            const enable = button('Enable sound', { className: 'small-button', title: 'Allow PCM audio playback for this session' });
            enable.onclick = () => this.audio.enable().catch(error => toast(`Sound: ${error.message}`));
            const mute = button('Mute sound', { className: 'small-button', title: 'Stop queued audio and mute this session' });
            mute.onclick = () => this.audio.mute();
            const volume = element('input'); volume.type = 'range'; volume.min = '0'; volume.max = '100'; volume.value = '100';
            volume.setAttribute('aria-label', 'Remote sound volume'); volume.style.width = '70px';
            volume.oninput = () => this.audio.setVolume(Number(volume.value) / 100);
            this.audioStatus = element('span', 'muted', 'Sound: awaiting formats');
            toolbar.append(enable, mute, volume, this.audioStatus);
        }
        if (this.options.microphone) {
            this.micStart = button('Start mic', { className: 'small-button', title: 'Start microphone capture for this remote session' });
            this.micStop = button('Stop mic', { className: 'small-button', title: 'Stop microphone capture and release the device' });
            this.micStatus = element('span', 'muted', 'Mic: awaiting server request');
            this.micStatus.setAttribute('role', 'status'); this.micStatus.setAttribute('aria-label', 'Microphone status');
            this.micStart.disabled = this.micStop.disabled = true;
            this.microphone = new BrowserMicrophone({ send: (value, transfer) => this.post(value, transfer), status: value => {
                this.micStatus.textContent = `Mic: ${value}`;
                this.micStart.disabled = this.closed || ['failed', 'closed'].includes(this.state) || !this.microphone?.request || !!this.microphone?.run;
                this.micStop.disabled = !this.microphone?.run;
            } });
            this.micStart.onclick = () => this.microphone.enable();
            this.micStop.onclick = () => this.microphone.stop();
            this.micVisibility = () => { if (document.hidden) this.microphone.stop('tab hidden'); };
            this.micPageHide = () => this.microphone.stop('page hidden');
            document.addEventListener('visibilitychange', this.micVisibility);
            window.addEventListener('pagehide', this.micPageHide);
            toolbar.append(this.micStart, this.micStop, this.micStatus);
        }
        for (const [symbol, label, action] of [
            ['refresh', 'Request full desktop refresh', () => this.post({ type: 'refresh' })],
            ['desktop', 'Monitor layout', () => this.openDrawer('display')],
            ['clip', 'Text clipboard', () => this.openDrawer('clipboard')],
            ['keyboard', 'Keyboard and Unicode input', () => this.openDrawer('keyboard')],
            ['chart', 'Session diagnostics', () => this.openDrawer('diagnostics')],
        ]) {
            const item = button('', { className: 'icon-button', symbol, title: label });
            item.onclick = action;
            toolbar.append(item);
        }
        const end = element('div', 'toolbar-end');
        const screenshot = button('', { className: 'icon-button', symbol: 'download', title: 'Save desktop screenshot' });
        screenshot.onclick = () => this.screenshot();
        const fullscreen = button('', { className: 'icon-button', symbol: 'expand', title: 'Toggle fullscreen' });
        fullscreen.onclick = async () => {
            try {
                if (document.fullscreenElement)
                    await document.exitFullscreen();
                else
                    await this.root.requestFullscreen();
            }
            catch (error) {
                toast(`Fullscreen: ${error.message}`);
            }
        };
        end.append(screenshot, fullscreen);
        toolbar.append(end);
        this.root.append(toolbar);
        if (this.mode === 'lab') {
            const banner = element('div', 'fixture-banner');
            banner.append(element('b', '', 'LOCAL FIXTURE'), document.createTextNode('Synthetic desktop over encoded RDP packets. No remote OS or network authentication.'));
            this.root.append(banner);
        }
        this.body = element('div', 'session-body');
        this.viewport = element('div', 'viewport');
        this.host = element('div', 'screen-host');
        this.viewport.append(this.host);
        this.body.append(this.viewport);
        this.overlay = element('div', 'session-overlay');
        const card = element('div', 'overlay-card');
        this.overlayHeading = element('h2', '', 'Opening workspace');
        this.overlayDetail = element('p', '', 'Selecting an available renderer…');
        card.append(icon('monitor'), this.overlayHeading, this.overlayDetail);
        this.reconnectButton = button('Reconnect…', { className: 'primary', title: 'Return to connection setup with fresh credentials' });
        this.reconnectButton.hidden = true;
        this.reconnectButton.onclick = () => {
            if (this.mode === 'remote' && !this.closed && ['failed', 'closed'].includes(this.state)) this.onReconnect?.(this);
        };
        card.append(this.reconnectButton);
        this.overlay.append(card);
        this.body.append(this.overlay);
        this.drawer = element('aside', 'drawer');
        this.drawer.hidden = true;
        this.body.append(this.drawer);
        this.root.append(this.body);
        this.footer = element('div', 'session-foot');
        this.stateLabel = element('span', '', 'Initializing');
        this.metrics = element('div', 'live-stats');
        this.healthLabel = element('span', 'muted', this.mode === 'lab' ? '' : 'Gateway: connecting');
        this.healthLabel.setAttribute('aria-label', 'Gateway connection health');
        this.healthLabel.setAttribute('role', 'status');
        this.footer.append(this.stateLabel, this.healthLabel, this.metrics);
        this.root.append(this.footer);
        this.observer = new ResizeObserver(() => this.layout());
        this.observer.observe(this.viewport);
    }
    async initialize({ password, token }) {
        try {
            this.renderer = await createRenderer(this.host, { preferred: this.options.backend, onLost: message => this.recoverRenderer(message) });
            if (this.closed) {
                this.renderer.destroy();
                return;
            }
            this.bindInput();
            this.layout();
            this.worker = new Worker(new URL('./session-worker.js', import.meta.url), { type: 'module', name: `lrdp-${this.id}` });
            this.worker.onmessage = ({ data }) => {
                try {
                    this.event(data);
                }
                catch (error) {
                    this.error({ code: 'UI_PROTOCOL', message: error.message });
                }
            };
            this.worker.onerror = event => this.error({ code: 'WORKER_FAILED', message: event.message || 'Protocol worker failed' });
            const url = this.options.gatewayUrl ? new URL(this.options.gatewayUrl) : new URL('/bridge', location.href);
            if (!this.options.gatewayUrl) url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            this.worker.postMessage({ type: 'start', mode: this.mode, options: this.options, password, token, url: url.href });
            password = token = '';
            this.metricsTimer = setInterval(() => this.updateMetrics(), 1000);
            this.updateMetrics();
        }
        catch (error) {
            this.error({ code: 'INITIALIZATION', message: error.message });
        } finally { password = token = ''; }
    }
    bindInput() {
        this.input?.destroy();
        this.input = new InputController(this.renderer.canvas, {
            send: events => this.post({ type: 'input', events }), text: text => this.post({ type: 'text', text }), dimensions: () => ({ width: this.width, height: this.height }),
            position: position => {
                this.renderer.setPointer({ kind: 'position', ...position });
                if (this.renderer.cursor.mode && !this.cursorRaf)
                    this.cursorRaf = requestAnimationFrame(() => {
                        this.cursorRaf = 0;
                        if (!this.closed)
                            this.renderer.present();
                    });
            },
        });
    }
    post(value, transfer = []) {
        if (!this.closed && this.worker) { this.worker.postMessage(value, transfer); return true; }
        return false;
    }
    event(value) {
        if (this.closed)
            return;
        if (this.state === 'failed' && ['state', 'stage'].includes(value.type))
            return;
        if (value.type === 'frame') {
            this.commands.push(value);
            this.scheduleRender();
            return;
        }
        if (value.type === 'statistics') {
            this.stats = value;
            return;
        }
        if (value.type === 'connection-health') {
            if (!['failed', 'closed'].includes(this.state)) {
                this.connectionHealth = { status: value.status, phase: value.phase };
                this.healthLabel.textContent = `Gateway: ${value.status}`;
            }
            return;
        }
        if (value.type === 'latency') {
            this.bridgeRttMs = value.bridgeRttMs;
            return;
        }
        if (value.type === 'microphone') { this.microphone?.receive(value); return; }
        if (value.type === 'microphone-consumed') { this.microphone?.consumed(value); return; }
        if (value.type === 'audio') {
            if (value.kind === 'samples') {
                if (this.audio && !this.closed && !['failed', 'closed'].includes(this.state)) this.audio.receive(value);
                else { for (const plane of value.planes) plane.fill(0); this.post({ type: 'audio-consumed', id: value.id, disposition: 'dropped' }); }
            } else if (value.kind === 'reset') this.audio?.reset();
            else if (value.kind === 'closed') this.audio?.close();
            else if (value.kind === 'formats' && this.audioStatus) this.audioStatus.textContent = `Sound: ${value.formats.length} PCM formats; enable playback`;
            return; // Audio sample data must never enter logs or diagnostics.
        }
        if (value.type === 'clipboard') {
            if (this.state === 'failed' || this.state === 'closed') return;
            if (this.clipboardSnapshot.apply(value)) {
                this.remoteClipboard = this.clipboardSnapshot.value.text || '';
                this.updateClipboardControls();
            }
            if (['rejected', 'timeout'].includes(value.kind)) toast(value.message);
            return; // Contents never enter diagnostics or the DOM as markup.
        }
        if (value.type === 'monitor-layout') {
            this.monitorLayout = value;
            this.log.push({ at: new Date().toISOString(), type: 'monitor-layout', count: value.monitors.length, width: value.width, height: value.height });
            return;
        }
        if (value.type === 'display' && value.kind === 'ready') {
            this.displayReady = true;
            this.resolution.disabled = false;
        }
        if (value.type === 'display' && value.kind === 'closed') {
            this.displayReady = false;
            this.resolution.disabled = true;
        }
        if (value.type === 'notice') {
            toast(value.message);
            return;
        }
        if (value.type === 'security')
            this.security = { mode: value.mode || this.options.security, authentication: value.authentication, certificate: value.certificate };
        if (value.type === 'error') {
            this.error(value);
            return;
        }
        if (value.type === 'state' || value.type === 'stage') {
            this.state = value.state;
            if (value.state === 'closed') {
                this.clipboardSnapshot.clear(); this.audio?.close(); this.microphone?.close(); this.input?.destroy();
                this.displayReady = false; this.resolution.disabled = true;
                this.healthLabel.textContent = 'Gateway: disconnected';
            }
            this.reconnectButton.hidden = value.state !== 'closed' || this.mode !== 'remote' || !this.onReconnect;
            this.updateClipboardControls();
            this.stateLabel.textContent = value.state;
            this.overlay.hidden = value.state === 'active';
            this.overlayHeading.textContent = value.state === 'closed' ? 'Session disconnected' : 'Connecting';
            this.overlayDetail.textContent = value.state.replaceAll('-', ' ');
            if (value.state === 'active')
                this.renderer.canvas.focus({ preventScroll: true });
        }
        this.log.push({ at: new Date().toISOString(), type: value.type, kind: value.kind, state: value.state });
        if (this.log.length > 100)
            this.log.shift();
    }
    scheduleRender() {
        if (!this.renderRaf && !this.rendering)
            this.renderRaf = requestAnimationFrame(() => { this.renderRaf = 0; this.renderFrames(); });
    }
    renderFrames() {
        if (this.closed || this.rendering || !this.renderer)
            return;
        try {
            while (this.commands.length) {
                const frame = this.commands.shift();
                let rectangles = [], pointerChanged = false;
                const flush = () => {
                    if (rectangles.length) {
                        this.renderer.apply(rectangles);
                        rectangles = [];
                        pointerChanged = false;
                    }
                };
                for (const command of frame.commands) {
                    if (command.type === 'bitmaps') {
                        if (rectangles.length + command.rectangles.length > 4096)
                            flush();
                        rectangles.push(...command.rectangles);
                    }
                    else {
                        flush();
                        if (command.type === 'desktop') {
                            this.width = command.width;
                            this.height = command.height;
                            this.renderer.resize(this.width, this.height);
                            this.layout();
                            this.resolution.value = '';
                        }
                        else if (command.type === 'palette') {
                            this.palette = command.palette.slice();
                            this.renderer.setPalette(command.palette);
                        }
                        else if (command.type === 'pointer') {
                            this.renderer.setPointer(command);
                            pointerChanged = true;
                        }
                    }
                }
                flush();
                if (pointerChanged)
                    this.renderer.present();
                this.post({ type: 'frame-ack', id: frame.id });
            }
            this.updateMetrics();
        }
        catch (error) {
            this.error({ code: 'RENDER_FAILED', message: error.message });
        }
    }
    async recoverRenderer(message) {
        if (this.closed || this.rendering)
            return;
        this.rendering = true;
        this.input?.destroy();
        this.renderer?.destroy();
        this.host.replaceChildren();
        toast(`Graphics device lost: ${message}. Switching to Canvas and requesting a complete refresh.`);
        try {
            this.renderer = await createRenderer(this.host, { preferred: 'canvas' });
            this.renderer.resize(this.width, this.height);
            if (this.palette)
                this.renderer.setPalette(this.palette);
            this.bindInput();
            this.layout();
            this.rendering = false;
            this.renderFrames();
            this.post({ type: 'refresh' });
        }
        catch (error) {
            this.rendering = false;
            this.error({ code: 'RENDER_RECOVERY', message: error.message });
        }
    }
    layout() {
        if (!this.renderer || !this.viewport.clientWidth || !this.viewport.clientHeight)
            return;
        const padding = parseFloat(getComputedStyle(this.viewport).paddingLeft) * 2;
        const scale = this.fit ? Math.min((this.viewport.clientWidth - padding) / this.width, (this.viewport.clientHeight - padding) / this.height, 1) : this.zoom;
        const width = Math.max(1, Math.round(this.width * scale)), height = Math.max(1, Math.round(this.height * scale));
        this.renderer.canvas.style.width = `${width}px`;
        this.renderer.canvas.style.height = `${height}px`;
        this.host.style.width = `${width}px`;
        this.host.style.height = `${height}px`;
        this.viewport.style.placeItems = this.fit ? 'center' : 'start';
        this.fitButton.style.color = this.fit ? 'var(--accent)' : '';
        this.nativeButton.style.color = this.fit ? '' : 'var(--accent)';
    }
    requestResize(value) {
        if (!value)
            return;
        let [width, height] = value === 'viewport' ? [Math.max(200, this.viewport.clientWidth - 32) & ~1, Math.max(200, this.viewport.clientHeight - 32)] : value.split('x').map(Number);
        this.post({ type: 'resize', width, height, scale: 100 });
        toast(`Requested ${width} × ${height}; waiting for server reactivation.`);
    }
    openDrawer(kind) {
        if (this.drawerKind === kind && !this.drawer.hidden) {
            this.drawer.hidden = true;
            this.drawerKind = null;
            this.layout();
            return;
        }
        this.input?.release();
        this.drawerKind = kind;
        this.drawer.hidden = false;
        this.drawer.replaceChildren();
        const header = element('div', 'drawer-header'), close = button('', { className: 'icon-button', symbol: 'close', title: 'Close panel' });
        close.onclick = () => { this.drawer.hidden = true; this.drawerKind = null; this.layout(); };
        header.append(element('h3', '', { display: 'Monitor layout', clipboard: 'Clipboard', keyboard: 'Keyboard', diagnostics: 'Diagnostics' }[kind]), close);
        this.drawer.append(header);
        if (kind === 'display') {
            this.drawer.append(element('p', '', 'Coordinates are relative to the primary monitor at (0, 0). All monitors share one virtual-desktop canvas. Maximum 16 monitors within an 8192-pixel / 16-megapixel desktop.'));
            const topology = element('textarea');
            topology.setAttribute('aria-label', 'Monitor layout JSON');
            topology.rows = 10;
            topology.maxLength = 12000;
            topology.value = JSON.stringify(this.monitorLayout?.monitors || [{ primary: true, left: 0, top: 0, width: this.width, height: this.height }], null, 2);
            const actions = element('div', 'actions');
            const dual = button('Two monitors');
            dual.onclick = () => { topology.value = JSON.stringify([
                { primary: true, left: 0, top: 0, width: 1280, height: 800 },
                { primary: false, left: -1280, top: 0, width: 1280, height: 800 },
            ], null, 2); };
            const apply = button('Apply topology', { className: 'primary' });
            apply.onclick = () => {
                try {
                    if (!this.displayReady) throw new Error('Server display control is not ready');
                    const layout = normalizeMonitorLayout(JSON.parse(topology.value));
                    this.post({ type: 'monitor-layout', monitors: layout.monitors });
                    toast('Monitor layout requested; awaiting server reactivation');
                } catch (error) { toast(error.message); }
            };
            actions.append(dual, apply);
            this.drawer.append(topology, actions);
        }
        else if (kind === 'clipboard') {
            this.drawer.append(element('p', '', 'Text is exchanged with the remote cliprdr channel. Reading or writing your system clipboard always requires an explicit action.'));
            const local = element('textarea');
            local.placeholder = 'Text to copy to the remote clipboard…';
            local.setAttribute('aria-label', 'Local clipboard text');
            local.maxLength = 1000000;
            const actions = element('div', 'actions');
            const read = button('Read local', { symbol: 'clip' });
            read.onclick = async () => {
                try {
                    if (!navigator.clipboard?.readText)
                        throw new Error('Clipboard reading is unavailable');
                    local.value = await navigator.clipboard.readText();
                }
                catch (error) {
                    toast(`Clipboard permission: ${error.message}`);
                }
            };
            const send = button('Send remote', { className: 'primary' });
            send.onclick = () => { this.post({ type: 'clipboard', text: local.value }); toast('Clipboard format announced to the remote server'); };
            actions.append(read, send);
            this.drawer.append(local, actions, element('div', 'eyebrow', 'REMOTE TEXT'));
            this.remoteArea = element('textarea');
            this.remoteArea.value = this.remoteClipboard || '';
            this.remoteArea.readOnly = true;
            this.remoteArea.setAttribute('aria-label', 'Received remote clipboard text');
            const copy = button('Copy to local device', { symbol: 'clip' });
            copy.onclick = async () => {
                try {
                    if (!navigator.clipboard?.writeText)
                        throw new Error('Clipboard writing is unavailable');
                    await navigator.clipboard.writeText(this.remoteArea.value);
                    toast('Copied remote text to this device');
                }
                catch (error) {
                    toast(`Clipboard permission: ${error.message}`);
                }
            };
            this.drawer.append(this.remoteArea);
            const copyActions = element('div', 'actions');
            copyActions.append(copy);
            this.drawer.append(copyActions);
            if (this.options.richClipboard) this.buildRichClipboard();
            this.updateClipboardControls();
        }
        else if (kind === 'keyboard') {
            this.drawer.append(element('p', '', 'The canvas sends physical scan codes. Use Unicode input for IME, mobile keyboards or text outside the active remote keyboard layout. Browser-reserved shortcuts may stay local.'));
            const actions = element('div', 'actions');
            for (const [label, keys] of [['Windows key', ['MetaLeft']], ['Alt + Tab', ['AltLeft', 'Tab']], ['Ctrl + Esc', ['ControlLeft', 'Escape']], ['Ctrl + Alt + Del', ['ControlLeft', 'AltLeft', 'Delete']]]) {
                const item = button(label);
                item.onclick = () => this.post({ type: 'input', events: chord(keys) });
                actions.append(item);
            }
            this.drawer.append(actions);
            const text = element('textarea', 'mobile-text');
            text.maxLength = 65536;
            text.placeholder = 'Type with your device keyboard…';
            text.setAttribute('aria-label', 'Unicode text to send');
            const send = button('Send Unicode text', { className: 'primary' });
            send.onclick = () => { this.post({ type: 'text', text: text.value }); text.value = ''; };
            const release = button('Release all held keys');
            release.onclick = () => this.input.release();
            const row = element('div', 'actions');
            row.append(send, release);
            this.drawer.append(text, row);
        }
        else {
            this.drawer.append(element('p', '', 'Submission time measures CPU renderer update/submission, not end-to-end remote latency. Bridge RTT does not include the remote RDP host. No passwords or clipboard contents appear in this report.'));
            const pre = element('pre');
            pre.textContent = JSON.stringify(this.diagnostics(), null, 2);
            this.drawer.append(pre);
            const save = button('Export diagnostic JSON', { symbol: 'download' });
            save.onclick = () => download('lrdp-diagnostics.json', JSON.stringify(this.diagnostics(), null, 2), 'application/json');
            this.drawer.append(save);
        }
        this.layout();
    }
    buildRichClipboard() {
        this.drawer.append(element('div', 'eyebrow', 'HTML AND IMAGES'));
        this.drawer.append(element('p', '', 'Read and send shares the supported formats from this device. Fetch reads the remote selection into this session only. Copy writes it to your system clipboard. HTML is never rendered here. Limits: 8 MiB per format, 2 megapixels.'));
        this.richStatus = element('p', 'fineprint');
        this.richStatus.setAttribute('role', 'status');
        this.richStatus.setAttribute('aria-label', 'Rich clipboard status');
        const read = this.richRead = button('Read and send rich clipboard');
        read.onclick = async () => {
            if (this.closed || this.state !== 'active' || this.clipboardReading) return;
            this.clipboardReading = true; this.updateClipboardControls();
            const epoch = this.clipboardSnapshot.epoch;
            let content;
            try {
                content = await readBrowserClipboard();
                if (this.closed || this.state !== 'active' || epoch !== this.clipboardSnapshot.epoch) {
                    releaseClipboardContent(content);
                    throw new Error('Session or clipboard changed while permission was pending; retry the action.');
                }
                const buffers = [content.png?.buffer, content.image?.rgba?.buffer].filter(Boolean);
                this.post({ type: 'clipboard-content', content }, [...new Set(buffers)]);
                toast('Clipboard formats sent for remote negotiation');
            } catch (error) { releaseClipboardContent(content); if (!this.closed) toast(error.message); }
            finally { this.clipboardReading = false; this.updateClipboardControls(); }
        };
        const fetchActions = element('div', 'actions');
        this.richFetch = new Map();
        for (const [format, title] of [['html', 'Fetch remote HTML'], ['image', 'Fetch remote image']]) {
            const fetch = button(title);
            fetch.onclick = () => this.post({ type: 'clipboard-request', format });
            this.richFetch.set(format, fetch); fetchActions.append(fetch);
        }
        this.richWrite = button('Copy received formats to this device', { symbol: 'clip' });
        this.richWrite.onclick = async () => {
            try {
                if (this.state !== 'active' || this.closed) throw new Error('The session is not active');
                await writeBrowserClipboard(this.clipboardSnapshot.value);
                if (!this.closed) toast('Received formats copied to this device');
            } catch (error) { if (!this.closed) toast(error.message); }
        };
        this.drawer.append(read, fetchActions, this.richStatus, this.richWrite);
    }
    updateClipboardControls() {
        if (this.drawerKind !== 'clipboard') return;
        if (this.remoteArea) this.remoteArea.value = this.clipboardSnapshot.value.text || '';
        if (!this.richStatus?.isConnected) return;
        const active = this.state === 'active' && !this.closed;
        this.richRead.disabled = !active || this.clipboardReading;
        for (const [format, control] of this.richFetch) control.disabled = !active || !this.clipboardSnapshot.formats.includes(format);
        const value = this.clipboardSnapshot.value;
        const ready = [value.text != null ? 'text' : '', value.html != null ? 'HTML' : '',
            value.png || value.image ? 'image' : ''].filter(Boolean);
        this.richWrite.disabled = !active || !ready.length;
        this.richStatus.textContent = `Remote offers: ${this.clipboardSnapshot.formats.join(', ') || 'none'}. Received: ${ready.join(', ') || 'none'}.`;
    }
    diagnostics() { return { version: '0.1.0', mode: this.mode, state: this.state, dimensions: [this.width, this.height], renderer: this.renderer?.stats, fallbacks: this.renderer?.fallbackReasons, protocol: this.stats, bridgeRttMs: this.bridgeRttMs ?? null, connectionHealth: this.connectionHealth || null, security: this.security, events: this.log }; }
    updateMetrics() {
        if (!this.renderer || this.closed)
            return;
        const now = performance.now(), frames = this.renderer.stats.frames;
        if (!this.lastMetrics || now - this.lastMetrics.time >= 950) {
            this.fps = this.lastMetrics ? (frames - this.lastMetrics.frames) * 1000 / (now - this.lastMetrics.time) : 0;
            this.lastMetrics = { time: now, frames };
        }
        this.stateLabel.textContent = `${this.state} · ${this.width} × ${this.height} · ${this.renderer.stats.backend}`;
        this.metrics.replaceChildren();
        const values = [`${(this.fps || 0).toFixed(0)} presents/s`, `${formatBytes(this.stats.receivedBytes || 0)} received`, `${this.renderer.stats.submitMs.toFixed(2)} ms submit`];
        if (this.renderer.stats.gpuMs !== null)
            values.push(`${this.renderer.stats.gpuMs.toFixed(2)} ms GPU`);
        for (const value of values)
            this.metrics.append(element('span', '', value));
    }
    error(error) {
        this.state = 'failed';
        this.displayReady = false; this.resolution.disabled = true;
        this.reconnectButton.hidden = this.mode !== 'remote' || !this.onReconnect;
        this.healthLabel.textContent = this.mode === 'remote' ? 'Gateway: disconnected' : '';
        this.audio?.close(); this.microphone?.close();
        this.clipboardSnapshot.clear();
        this.remoteClipboard = '';
        this.updateClipboardControls();
        this.overlay.hidden = false;
        this.overlayHeading.textContent = error.code || 'Connection failed';
        this.overlayHeading.classList.add('error-label');
        this.overlayDetail.textContent = error.message;
        this.input?.destroy();
        this.post({ type: 'close' });
        this.stateLabel.textContent = `failed · ${error.code}`;
        this.log.push({ at: new Date().toISOString(), code: error.code, message: error.message });
    }
    async screenshot() {
        try {
            const width = this.width, height = this.height, rgba = await this.renderer.readSurface();
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            if (!blob)
                throw new Error('Screenshot encoding failed');
            download('lrdp-desktop.png', blob);
        }
        catch (error) {
            toast(error.message);
        }
    }
    select(active) {
        this.root.hidden = !active;
        this.tab.classList.toggle('active', active);
        if (!active) { this.input?.release(); this.microphone?.stop('session hidden'); }
        else
            requestAnimationFrame(() => this.layout());
    }
    close() {
        if (this.closed)
            return;
        this.input?.destroy();
        this.audio?.close(); this.microphone?.close();
        this.post({ type: 'close' });
        this.closed = true;
        this.clipboardSnapshot.clear();
        setTimeout(() => this.worker?.terminate(), 100);
        document.removeEventListener('visibilitychange', this.micVisibility);
        window.removeEventListener('pagehide', this.micPageHide);
        this.observer.disconnect();
        clearInterval(this.metricsTimer);
        if (this.renderRaf)
            cancelAnimationFrame(this.renderRaf);
        if (this.cursorRaf)
            cancelAnimationFrame(this.cursorRaf);
        this.renderer?.destroy();
        this.root.remove();
        this.tab.remove();
        this.remoteClipboard = '';
        this.commands = [];
    }
}
