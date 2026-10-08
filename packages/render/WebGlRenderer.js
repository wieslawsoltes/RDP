import { glVertex, glFragment } from './shaders.js';
import { toRgba, defaultPalette } from '../codecs/Pixels.js';
import { planBatches } from './BatchPlanner.js';
import { cursorState, updateCursor, cursorCss } from './Cursor.js';
import { requireThat } from '../binary/ProtocolError.js';
export class WebGlRenderer {
    static async create(canvas, options) { return new WebGlRenderer(canvas, options); }
    constructor(canvas, { onLost = () => { } } = {}) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
        requireThat(this.gl, 'WEBGL_UNAVAILABLE', 'WebGL2 is unavailable');
        const gl = this.gl;
        canvas.addEventListener('webglcontextlost', event => {
            event.preventDefault();
            if (!this.destroyed)
                onLost('WebGL context lost');
        });
        const compile = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); requireThat(gl.getShaderParameter(s, gl.COMPILE_STATUS), 'GLSL_COMPILE', gl.getShaderInfoLog(s)); return s; };
        const vertex = compile(gl.VERTEX_SHADER, glVertex), fragment = compile(gl.FRAGMENT_SHADER, glFragment);
        this.program = gl.createProgram();
        gl.attachShader(this.program, vertex);
        gl.attachShader(this.program, fragment);
        gl.linkProgram(this.program);
        requireThat(gl.getProgramParameter(this.program, gl.LINK_STATUS), 'GLSL_LINK', gl.getProgramInfoLog(this.program));
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);
        this.uniforms = Object.fromEntries(['desktop', 'cursorImage', 'desktopSize', 'cursorPosition', 'hotspot', 'cursorSize', 'cursorMode'].map(name => [name, gl.getUniformLocation(this.program, name)]));
        this.palette = defaultPalette();
        this.cursor = cursorState();
        this.surface = this.texture();
        this.cursorTexture = this.texture();
        gl.bindTexture(gl.TEXTURE_2D, this.cursorTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
        this.stats = { backend: 'WebGL2', frames: 0, rectangles: 0, pixels: 0, uploadedBytes: 0, submitMs: 0, gpuMs: null };
        this.resize(640, 400);
    }
    texture() { const gl = this.gl, texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return texture; }
    resize(width, height) {
        const gl = this.gl, limit = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        requireThat(width > 0 && height > 0 && width <= limit && height <= limit && width * height <= 16777216, 'WEBGL_LIMIT', 'Desktop exceeds WebGL limits');
        this.width = this.canvas.width = width;
        this.height = this.canvas.height = height;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.surface);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        this.present();
    }
    setPalette(palette) { requireThat(palette.length === 1024, 'PALETTE_SIZE', 'Invalid palette'); this.palette = palette.slice(); }
    setPointer(event) {
        if (updateCursor(this.cursor, event)) {
            const gl = this.gl, c = this.cursor;
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, this.cursorTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, c.width, c.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, c.pixels);
        }
        cursorCss(this.canvas, this.cursor);
    }
    apply(rectangles) {
        const start = performance.now(), plan = planBatches(rectangles, this.width, this.height), gl = this.gl;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.surface);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        for (const r of rectangles) {
            const rgba = toRgba(r, this.palette);
            gl.pixelStorei(gl.UNPACK_ROW_LENGTH, r.width);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, r.drawWidth, r.drawHeight, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        }
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
        this.present();
        this.stats.rectangles += rectangles.length;
        this.stats.pixels += plan.pixels;
        this.stats.uploadedBytes += plan.dataSize;
        this.stats.submitMs = performance.now() - start;
    }
    present() {
        const gl = this.gl, c = this.cursor, u = this.uniforms;
        gl.viewport(0, 0, this.width, this.height);
        gl.useProgram(this.program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.surface);
        gl.uniform1i(u.desktop, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.cursorTexture);
        gl.uniform1i(u.cursorImage, 1);
        gl.uniform2i(u.desktopSize, this.width, this.height);
        gl.uniform2i(u.cursorPosition, c.x, c.y);
        gl.uniform2i(u.hotspot, c.hotX, c.hotY);
        gl.uniform2i(u.cursorSize, c.width, c.height);
        gl.uniform1i(u.cursorMode, c.mode);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.stats.frames++;
    }
    async readSurface() {
        const gl = this.gl, framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.surface, 0);
        const result = new Uint8Array(this.width * this.height * 4);
        gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, result);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(framebuffer);
        return result;
    }
    destroy() { this.destroyed = true; const gl = this.gl; gl.deleteTexture(this.surface); gl.deleteTexture(this.cursorTexture); gl.deleteProgram(this.program); gl.getExtension('WEBGL_lose_context')?.loseContext(); }
}
