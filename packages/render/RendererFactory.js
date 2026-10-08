import { WebGpuRenderer } from './WebGpuRenderer.js';
import { WebGlRenderer } from './WebGlRenderer.js';
import { CanvasRenderer } from './CanvasRenderer.js';
export async function createRenderer(container, { preferred = 'auto', onLost = () => { } } = {}) {
    const candidates = preferred === 'auto' ? [WebGpuRenderer, WebGlRenderer, CanvasRenderer] : preferred === 'webgpu' ? [WebGpuRenderer] : preferred === 'webgl2' ? [WebGlRenderer] : [CanvasRenderer];
    const failures = [];
    for (const candidate of candidates) {
        const canvas = document.createElement('canvas');
        canvas.className = 'desktop-canvas';
        canvas.tabIndex = 0;
        canvas.setAttribute('role', 'application');
        canvas.setAttribute('aria-label', 'Remote desktop. Press Escape to leave full screen.');
        container.append(canvas);
        try {
            const renderer = await candidate.create(canvas, { onLost });
            renderer.fallbackReasons = failures;
            return renderer;
        }
        catch (error) {
            failures.push(error.message);
            canvas.remove();
        }
    }
    throw new Error(failures.join('; '));
}
