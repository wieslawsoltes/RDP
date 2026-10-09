import { bitmapComputeWgsl, presentWgsl } from './shaders.js';
import { planBatches } from './BatchPlanner.js';
import { defaultPalette } from '../codecs/Pixels.js';
import { cursorState, updateCursor, cursorCss } from './Cursor.js';
import { requireThat } from '../binary/ProtocolError.js';
const align = (value, n) => Math.ceil(value / n) * n;
const grow = n => 2 ** Math.ceil(Math.log2(Math.max(256, n)));
export class WebGpuRenderer {
    static async create(canvas, options = {}) {
        requireThat(navigator.gpu, 'WEBGPU_UNAVAILABLE', 'WebGPU is not exposed by this browser');
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        requireThat(adapter, 'WEBGPU_ADAPTER', 'No WebGPU adapter is available');
        const timestamps = adapter.features.has('timestamp-query');
        const device = await adapter.requestDevice({ requiredFeatures: timestamps ? ['timestamp-query'] : [] });
        const renderer = new WebGpuRenderer(canvas, adapter, device, { ...options, timestamps });
        try {
            await renderer.initialize();
            return renderer;
        }
        catch (error) {
            renderer.destroy();
            throw error;
        }
    }
    constructor(canvas, adapter, device, { onLost = () => { }, timestamps }) {
        this.canvas = canvas;
        this.adapter = adapter;
        this.device = device;
        this.onLost = onLost;
        this.timestamps = timestamps;
        this.destroyed = false;
        this.cursor = cursorState();
        this.width = this.height = 0;
        this.resources = {};
        this.scratch = new Uint8Array(256);
        this.jobScratch = new Uint32Array(12);
        this.stats = { backend: 'WebGPU compute', frames: 0, rectangles: 0, pixels: 0, uploadedBytes: 0, submitMs: 0, gpuMs: null, timestampQueries: timestamps, adapter: adapter.info?.description || adapter.info?.device || 'WebGPU adapter' };
        device.lost.then(info => {
            if (!this.destroyed)
                onLost(info.message || 'WebGPU device lost');
        });
        device.addEventListener('uncapturederror', event => {
            if (!this.destroyed)
                onLost(event.error.message);
        });
    }
    async initialize() {
        const d = this.device;
        d.pushErrorScope('validation');
        this.context = this.canvas.getContext('webgpu');
        requireThat(this.context, 'WEBGPU_CONTEXT', 'Unable to create WebGPU canvas');
        this.format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({ device: d, format: this.format, alphaMode: 'opaque' });
        const computeModule = d.createShaderModule({ code: bitmapComputeWgsl, label: 'RDP packed pixel conversion' }), presentModule = d.createShaderModule({ code: presentWgsl, label: 'RDP framebuffer + exact cursor' });
        for (const module of [computeModule, presentModule]) {
            const info = await module.getCompilationInfo();
            const errors = info.messages.filter(m => m.type === 'error');
            requireThat(!errors.length, 'WGSL_COMPILE', errors.map(m => `${m.lineNum}: ${m.message}`).join('\n'));
        }
        this.computeLayout = d.createBindGroupLayout({ entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 } }
            ] });
        this.computePipeline = await d.createComputePipelineAsync({ layout: d.createPipelineLayout({ bindGroupLayouts: [this.computeLayout] }), compute: { module: computeModule, entryPoint: 'main' } });
        this.presentPipeline = await d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: presentModule, entryPoint: 'vertexMain' }, fragment: { module: presentModule, entryPoint: 'fragmentMain', targets: [{ format: this.format }] }, primitive: { topology: 'triangle-list' } });
        this.paletteBuffer = d.createBuffer({ size: 1024, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        this.setPalette(defaultPalette());
        this.viewBuffer = d.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.cursorTexture = d.createTexture({ size: [1, 1], format: 'rgba8uint', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        d.queue.writeTexture({ texture: this.cursorTexture }, new Uint8Array(4), { bytesPerRow: 4 }, [1, 1]);
        this.uniformAlignment = d.limits.minUniformBufferOffsetAlignment;
        this.ensureBuffer('source', 256, GPUBufferUsage.STORAGE);
        this.ensureBuffer('jobs', 256, GPUBufferUsage.STORAGE);
        this.ensureBuffer('batches', 256, GPUBufferUsage.UNIFORM);
        if (this.timestamps) {
            this.querySet = d.createQuerySet({ type: 'timestamp', count: 2 });
            this.queryBuffer = d.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
            this.queryRead = d.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        }
        this.resize(640, 400);
        const error = await d.popErrorScope();
        requireThat(!error, 'WEBGPU_VALIDATION', error?.message || 'WebGPU validation failed');
    }
    ensureBuffer(name, size, usage) {
        const current = this.resources[name];
        if (current?.size >= size)
            return;
        const capacity = grow(size);
        requireThat(capacity <= this.device.limits.maxBufferSize && (usage !== GPUBufferUsage.STORAGE || capacity <= this.device.limits.maxStorageBufferBindingSize), 'GPU_LIMIT', 'GPU buffer limit exceeded');
        const next = this.device.createBuffer({ size: capacity, usage: usage | GPUBufferUsage.COPY_DST, label: `LRDP ${name}` });
        this.resources[name] = next;
        this.computeBindGroup = null;
        if (current)
            this.device.queue.onSubmittedWorkDone().then(() => current.destroy(), () => current.destroy());
    }
    resize(width, height) {
        requireThat(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= this.device.limits.maxTextureDimension2D && height <= this.device.limits.maxTextureDimension2D && width * height <= 16777216, 'GPU_DESKTOP_LIMIT', 'Desktop exceeds GPU limits');
        if (this.width === width && this.height === height)
            return;
        const old = this.surface;
        this.width = this.canvas.width = width;
        this.height = this.canvas.height = height;
        this.surface = this.device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC, label: 'Persistent RDP framebuffer' });
        this.computeBindGroup = this.presentBindGroup = null;
        this.present();
        if (old)
            this.device.queue.onSubmittedWorkDone().then(() => old.destroy(), () => old.destroy());
    }
    setPalette(palette) { requireThat(palette.length === 1024, 'PALETTE_SIZE', 'Palette must contain 256 RGBA entries'); this.device.queue.writeBuffer(this.paletteBuffer, 0, palette); }
    setPointer(event) {
        if (updateCursor(this.cursor, event)) {
            const old = this.cursorTexture, { width, height, pixels } = this.cursor;
            this.cursorTexture = this.device.createTexture({ size: [width, height], format: 'rgba8uint', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
            this.device.queue.writeTexture({ texture: this.cursorTexture }, pixels, { bytesPerRow: width * 4 }, [width, height]);
            this.presentBindGroup = null;
            this.device.queue.onSubmittedWorkDone().then(() => old.destroy(), () => old.destroy());
        }
        cursorCss(this.canvas, this.cursor);
    }
    bindGroups() {
        if (!this.computeBindGroup)
            this.computeBindGroup = this.device.createBindGroup({ layout: this.computeLayout, entries: [
                    { binding: 0, resource: { buffer: this.resources.source } }, { binding: 1, resource: { buffer: this.resources.jobs } },
                    { binding: 2, resource: this.surface.createView() }, { binding: 3, resource: { buffer: this.paletteBuffer } },
                    { binding: 4, resource: { buffer: this.resources.batches, offset: 0, size: 16 } }
                ] });
        if (!this.presentBindGroup)
            this.presentBindGroup = this.device.createBindGroup({ layout: this.presentPipeline.getBindGroupLayout(0), entries: [
                    { binding: 0, resource: this.surface.createView() }, { binding: 1, resource: this.cursorTexture.createView() }, { binding: 2, resource: { buffer: this.viewBuffer } }
                ] });
    }
    apply(rectangles) {
        requireThat(!this.destroyed, 'RENDERER_CLOSED', 'Renderer is closed');
        const start = performance.now(), plan = planBatches(rectangles, this.width, this.height);
        this.ensureBuffer('source', Math.max(4, plan.dataSize), GPUBufferUsage.STORAGE);
        this.ensureBuffer('jobs', Math.max(48, rectangles.length * 48), GPUBufferUsage.STORAGE);
        this.ensureBuffer('batches', Math.max(16, plan.batches.length * this.uniformAlignment), GPUBufferUsage.UNIFORM);
        if (this.scratch.length < plan.dataSize)
            this.scratch = new Uint8Array(grow(plan.dataSize));
        if (this.jobScratch.length < rectangles.length * 12)
            this.jobScratch = new Uint32Array(grow(rectangles.length * 48) / 4);
        let offset = 0;
        for (let i = 0; i < rectangles.length; i++) {
            const r = rectangles[i];
            this.scratch.set(r.data, offset);
            this.jobScratch.set([offset, r.stride, r.width, r.height, r.bpp, r.bottomUp === false ? 0 : 1, r.x, r.y, r.drawWidth, r.drawHeight, r.encoding === 'nscodec' ? 1 : 0,
                r.encoding === 'nscodec' ? (r.subsampled ? 1 : 0) | (r.sourceBpp === 24 ? 2 : 0) | (r.colorLossLevel << 8) : 0], i * 12);
            offset = align(offset + r.data.length, 4);
        }
        const uniforms = new Uint32Array(plan.batches.length * this.uniformAlignment / 4);
        plan.batches.forEach((b, i) => uniforms.set([b.first, b.count, 0, 0], i * this.uniformAlignment / 4));
        const q = this.device.queue;
        if (rectangles.length) {
            q.writeBuffer(this.resources.source, 0, this.scratch, 0, plan.dataSize);
            q.writeBuffer(this.resources.jobs, 0, this.jobScratch, 0, rectangles.length * 12);
            q.writeBuffer(this.resources.batches, 0, uniforms);
        }
        this.bindGroups();
        const encoder = this.device.createCommandEncoder(), measure = this.timestamps && !this.queryPending;
        for (let i = 0; i < plan.batches.length; i++) {
            const b = plan.batches[i], descriptor = measure && i === 0 ? { timestampWrites: { querySet: this.querySet, beginningOfPassWriteIndex: 0 } } : {};
            const pass = encoder.beginComputePass(descriptor);
            pass.setPipeline(this.computePipeline);
            pass.setBindGroup(0, this.computeBindGroup, [i * this.uniformAlignment]);
            pass.dispatchWorkgroups(b.groupX, b.groupY, b.count);
            pass.end();
        }
        this.encodePresent(encoder, measure, plan.batches.length > 0);
        if (measure) {
            encoder.resolveQuerySet(this.querySet, 0, 2, this.queryBuffer, 0);
            encoder.copyBufferToBuffer(this.queryBuffer, 0, this.queryRead, 0, 16);
        }
        q.submit([encoder.finish()]);
        if (measure)
            this.readTiming();
        this.stats.frames++;
        this.stats.rectangles += rectangles.length;
        this.stats.pixels += plan.pixels;
        this.stats.uploadedBytes += plan.dataSize;
        this.stats.submitMs = performance.now() - start;
    }
    encodePresent(encoder, measure, computed) {
        this.bindGroups();
        const c = this.cursor, values = new Int32Array([this.width, this.height, c.x, c.y, c.hotX, c.hotY, c.width, c.height, c.mode, 0, 0, 0]);
        this.device.queue.writeBuffer(this.viewBuffer, 0, values);
        const descriptor = { colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] };
        if (measure)
            descriptor.timestampWrites = { querySet: this.querySet, ...(computed ? {} : { beginningOfPassWriteIndex: 0 }), endOfPassWriteIndex: 1 };
        const pass = encoder.beginRenderPass(descriptor);
        pass.setPipeline(this.presentPipeline);
        pass.setBindGroup(0, this.presentBindGroup);
        pass.draw(3);
        pass.end();
    }
    present() {
        if (this.surface && !this.destroyed)
            this.apply([]);
    }
    readTiming() {
        this.queryPending = true;
        this.queryRead.mapAsync(GPUMapMode.READ).then(() => {
            if (!this.destroyed) {
                const t = new BigUint64Array(this.queryRead.getMappedRange());
                this.stats.gpuMs = Number(t[1] - t[0]) / 1e6;
                this.queryRead.unmap();
            }
        }).catch(() => { }).finally(() => { this.queryPending = false; });
    }
    whenComplete() {
        requireThat(!this.destroyed, 'WEBGPU_CLOSED', 'Renderer is closed');
        return this.device.queue.onSubmittedWorkDone();
    }
    async readSurface() {
        const width = this.width, height = this.height, row = align(width * 4, 256), buffer = this.device.createBuffer({ size: row * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), encoder = this.device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: this.surface }, { buffer, bytesPerRow: row }, [width, height]);
        this.device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const source = new Uint8Array(buffer.getMappedRange()), result = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++)
            result.set(source.subarray(y * row, y * row + width * 4), y * width * 4);
        buffer.unmap();
        buffer.destroy();
        return result;
    }
    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        for (const resource of Object.values(this.resources))
            resource.destroy();
        this.surface?.destroy();
        this.cursorTexture?.destroy();
        this.paletteBuffer?.destroy();
        this.viewBuffer?.destroy();
        this.querySet?.destroy();
        this.queryBuffer?.destroy();
        this.queryRead?.destroy();
        this.context?.unconfigure();
        this.device.destroy();
    }
}
