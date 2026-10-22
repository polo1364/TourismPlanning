'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const Reader = require('../itinerary-image.js');
const source = fs.readFileSync(path.join(__dirname, '../itinerary-image.js'), 'utf8');

function png(width = 1600, height = 800) {
    const bytes = new Uint8Array(33);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    bytes.set([73, 72, 68, 82], 12);
    const view = new DataView(bytes.buffer); view.setUint32(16, width); view.setUint32(20, height);
    return bytes;
}
function jpeg() {
    return new Uint8Array([255, 216, 255, 192, 0, 17, 8, 3, 32, 6, 64, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217]);
}
function webp(kind = 'VP8X') {
    const bytes = new Uint8Array(32);
    for (const [text, offset] of [['RIFF', 0], ['WEBP', 8], [kind, 12]]) bytes.set(Buffer.from(text), offset);
    if (kind === 'VP8X') { bytes[24] = 63; bytes[25] = 6; bytes[27] = 31; bytes[28] = 3; }
    if (kind === 'VP8L') { bytes[20] = 47; new DataView(bytes.buffer).setUint32(21, 1599 | (799 << 14), true); }
    if (kind === 'VP8 ') { bytes.set([157, 1, 42, 64, 6, 32, 3], 23); }
    return bytes;
}
function browser(options = {}) {
    const state = { workers: [], revoked: [], images: [], canvasSizes: [], requests: [], encodings: [], clearCount: 0 };
    class TestURL extends URL {
        static createObjectURL() { return 'blob:http://example.test/image'; }
        static revokeObjectURL(value) { state.revoked.push(value); }
    }
    class TestImage {
        constructor() { this.naturalWidth = options.width || 1600; this.naturalHeight = options.height || 800; state.images.push(this); }
        set src(value) {
            this.value = value;
            if (value && !options.decodeHang) queueMicrotask(() => options.decodeError ? this.onerror?.() : this.onload?.());
        }
    }
    class TestWorker {
        constructor(url) { this.url = url; this.terminated = 0; state.workers.push(this); }
        terminate() { this.terminated++; }
        postMessage(packet) {
            state.requests.push(packet);
            options.onAction?.(packet.action);
            if (options.hang === packet.action) return;
            queueMicrotask(() => {
                if (options.workerError === packet.action) { this.onerror?.({ preventDefault() {} }); return; }
                const message = { ...packet, status: options.reject === packet.action ? 'reject' : 'resolve', data: packet.action === 'recognize' ? { text: options.text ?? '台北行程\r\n09:00 早餐' } : {} };
                this.onmessage?.({ data: message });
            });
        }
    }
    const document = { currentScript: { src: 'https://example.test/app/itinerary-image.js' }, baseURI: 'https://example.test/app/', createElement(type) {
        assert.equal(type, 'canvas');
        const canvas = { width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage() { state.canvasSizes.push([canvas.width, canvas.height]); } }), toBlob(callback, type, quality) {
            state.encodings.push({ type, quality });
            options.onEncode?.();
            if (options.encodeHang) return;
            const size = options.encodeSize?.(type, quality) ?? png().length;
            callback({ type, size, arrayBuffer: async () => { options.onBuffer?.(); return options.encodeSize ? new ArrayBuffer(size) : png().buffer; } });
        } };
        state.canvas = canvas;
        return canvas;
    } };
    const context = vm.createContext({ window: {}, document, location: { origin: 'https://example.test', protocol: options.protocol || 'https:' }, URL: TestURL, Worker: TestWorker, Image: TestImage, Blob, Uint8Array, DataView, btoa,
        setTimeout: (fn, ms) => setTimeout(fn, options.timeout ? 5 : ms), clearTimeout: timer => { state.clearCount++; clearTimeout(timer); } });
    vm.runInContext(source, context);
    return { api: context.window.ItineraryImage, state };
}

test('image header and extension validation rejects unsupported, mismatched, empty and oversized input', async () => {
    for (const extension of ['gif', 'svg', 'heic', 'pdf', '']) await assert.rejects(Reader.read(png(), { extension }), { code: 'IMAGE_FORMAT' });
    await assert.rejects(Reader.read(new Uint8Array(), { extension: 'png' }), { code: 'IMAGE_INVALID' });
    await assert.rejects(Reader.read(jpeg(), { extension: 'png' }), { code: 'IMAGE_INVALID' });
    await assert.rejects(Reader.read(png(), { extension: 'jpg' }), { code: 'IMAGE_INVALID' });
    await assert.rejects(Reader.read(new Uint8Array(Reader.MAX_BYTES + 1), { extension: 'png' }), { code: 'IMAGE_LIMIT' });
});

test('image dimension limits reject before browser decoding allocates image pixels', async () => {
    for (const bytes of [png(12001, 10), png(5000, 5000)]) await assert.rejects(Reader.read(bytes, { extension: 'png' }), { code: 'IMAGE_DIMENSIONS' });
    await assert.rejects(Reader.read(png(0, 100), { extension: 'png' }), { code: 'IMAGE_INVALID' });
    await assert.rejects(Reader.read(png(12000, 2000), { extension: 'png' }), { code: 'IMAGE_ASSET' }, 'valid boundary proceeds to the browser check');
});

for (const [extension, bytes] of [['png', png()], ['jpg', jpeg()], ['JPEG', jpeg()], ['webp', webp()], ['webp', webp('VP8L')], ['webp', webp('VP8 ')]]) {
    test(`valid ${extension} header supports OCR and cleans every resource`, async () => {
        const { api, state } = browser();
        const progress = [];
        const result = await api.read(bytes, { extension, onProgress: event => progress.push(event.message) });
        assert.equal(result.text, '台北行程\n09:00 早餐'); assert.equal(result.format, 'image'); assert.equal(result.pages, null);
        assert.match(result.warnings[0], /誤字/);
        assert.deepEqual(state.requests.map(item => item.action), ['load', 'loadLanguage', 'initialize', 'recognize']);
        assert.equal(state.workers[0].url, 'https://example.test/app/vendor/tesseract/worker.min.js');
        assert.equal(state.requests[0].payload.options.corePath, 'https://example.test/app/vendor/tesseract/core');
        assert.equal(state.requests[1].payload.options.langPath, 'https://example.test/app/vendor/tesseract/lang');
        assert.deepEqual(Array.from(state.requests[1].payload.langs), ['chi_tra', 'eng']);
        assert.ok(progress.some(message => message.includes('首次需下載')));
        assert.equal(state.workers[0].terminated, 1); assert.equal(state.revoked.length, 1); assert.equal(state.canvas.width, 0); assert.equal(state.images[0].value, '');
    });
}

test('large valid image is scaled to bounded OCR pixels and warns about small text', async () => {
    const { api, state } = browser({ width: 6000, height: 4000 });
    const result = await api.read(png(6000, 4000), { extension: 'png' });
    const [width, height] = state.canvasSizes[0];
    assert.ok(width <= Reader.OCR_SIDE && height <= Reader.OCR_SIDE && width * height <= Reader.OCR_PIXELS);
    assert.match(result.warnings.join('\n'), /縮小/);
});

test('animated WebP and damaged decoding fail clearly without starting a worker', async () => {
    const animated = webp(); animated[20] = 2;
    await assert.rejects(Reader.read(animated, { extension: 'webp' }), { code: 'IMAGE_FORMAT' });
    const { api, state } = browser({ decodeError: true });
    await assert.rejects(api.read(png(), { extension: 'png' }), { code: 'IMAGE_INVALID' });
    assert.equal(state.workers.length, 0); assert.equal(state.revoked.length, 1);
});

test('file protocol and non-browser calls explain the local server requirement', async () => {
    const { api, state } = browser({ protocol: 'file:' });
    await assert.rejects(api.read(png(), { extension: 'png' }), /本機服務或網站/);
    assert.equal(state.workers.length, 0);
});

test('load, language, initialize and recognition failures are sanitized and terminate the worker', async () => {
    for (const action of ['load', 'loadLanguage', 'initialize', 'recognize']) {
        const { api, state } = browser({ reject: action });
        await assert.rejects(api.read(png(), { extension: 'png' }), { code: action === 'recognize' ? 'IMAGE_INVALID' : 'IMAGE_ASSET' });
        assert.equal(state.workers[0].terminated, 1);
        assert.equal(state.revoked.length, 1);
    }
    const { api, state } = browser({ workerError: 'load' });
    await assert.rejects(api.read(png(), { extension: 'png' }), { code: 'IMAGE_ASSET' });
    assert.equal(state.workers[0].terminated, 1);
});

test('empty and oversized OCR results cannot be returned as partial text', async () => {
    for (const [text, code] of [[' \n', 'IMAGE_NO_TEXT'], ['a'.repeat(30001), 'TEXT_LIMIT']]) {
        const { api, state } = browser({ text });
        await assert.rejects(api.read(png(), { extension: 'png' }), { code });
        assert.equal(state.workers[0].terminated, 1);
    }
    const { api } = browser({ text: 'a'.repeat(30000) });
    assert.equal((await api.read(png(), { extension: 'png' })).text.length, 30000);
});

test('already aborted and in-flight cancellation reject promptly and terminate without late success', async () => {
    const before = new AbortController(); before.abort();
    await assert.rejects(Reader.read(png(), { extension: 'png', signal: before.signal }), { name: 'AbortError' });
    for (const action of ['load', 'loadLanguage', 'initialize', 'recognize']) {
        const controller = new AbortController();
        const { api, state } = browser({ onAction: current => { if (current === action) controller.abort(); } });
        await assert.rejects(api.read(png(), { extension: 'png', signal: controller.signal }), { name: 'AbortError' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(state.workers[0].terminated, 1); assert.equal(state.workers[0].onmessage, null); assert.equal(state.revoked.length, 1);
    }
});

test('timeout bounds stalled initialization and a later read can succeed', async () => {
    const { api, state } = browser({ hang: 'initialize', timeout: true });
    await assert.rejects(api.read(png(), { extension: 'png' }), { code: 'IMAGE_TIMEOUT' });
    assert.equal(state.workers[0].terminated, 1);
    const next = browser(); assert.equal((await next.api.read(png(), { extension: 'png' })).format, 'image');
});

test('prepare returns one bounded attachment with empty text and never starts OCR', async () => {
    for (const [extension, bytes] of [['png', png()], ['jpg', jpeg()], ['webp', webp()]]) {
        const { api, state } = browser();
        const result = await api.prepare(bytes, { extension });
        assert.equal(result.text, ''); assert.equal(result.format, 'image'); assert.equal(result.pages, null);
        assert.equal(result.images.length, 1); assert.equal(result.images[0].page, 1); assert.equal(result.images[0].mime, 'image/png');
        assert.equal(Buffer.from(result.images[0].dataBase64, 'base64').length, png().length);
        assert.equal(state.workers.length, 0); assert.equal(state.requests.length, 0);
        assert.equal(state.revoked.length, 1); assert.equal(state.images[0].value, '');
        assert.equal(state.canvas.width, 0); assert.equal(state.canvas.height, 0);
    }
});

test('prepare validates magic, encoding and source dimensions before allocation', async () => {
    await assert.rejects(Reader.prepare(png(), { extension: 'jpg' }), { code: 'IMAGE_INVALID' });
    await assert.rejects(Reader.prepare(png(), { extension: 'heic' }), { code: 'IMAGE_FORMAT' });
    await assert.rejects(Reader.prepare(new Uint8Array(Reader.MAX_BYTES + 1), { extension: 'png' }), { code: 'IMAGE_LIMIT' });
    for (const bytes of [png(12001, 1), png(5000, 5000)]) await assert.rejects(Reader.prepare(bytes, { extension: 'png' }), { code: 'IMAGE_DIMENSIONS' });
    const { api, state } = browser({ decodeError: true });
    await assert.rejects(api.prepare(png(), { extension: 'png' }), { code: 'IMAGE_INVALID' });
    assert.equal(state.workers.length, 0); assert.equal(state.revoked.length, 1);
});

test('prepare resizes to 2400 pixels and 4 MP, uses bounded JPEG quality fallback, and enforces 2 MiB', async () => {
    const { api, state } = browser({ width: 6000, height: 4000, encodeSize: (type, quality) => quality === 0.85 ? Reader.MAX_ATTACHMENT_BYTES : Reader.MAX_ATTACHMENT_BYTES + 1 });
    const result = await api.prepare(png(6000, 4000), { extension: 'png' });
    const [width, height] = state.canvasSizes[0];
    assert.ok(width <= 2400 && height <= 2400 && width * height <= 4000000);
    assert.equal(result.images[0].mime, 'image/jpeg'); assert.equal(Buffer.from(result.images[0].dataBase64, 'base64').length, Reader.MAX_ATTACHMENT_BYTES);
    assert.deepEqual(state.encodings.map(value => value.quality), [undefined, 0.95, 0.85]);
    assert.match(result.warnings.join('\n'), /縮小/); assert.match(result.warnings.join('\n'), /壓縮/);
    const over = browser({ encodeSize: () => Reader.MAX_ATTACHMENT_BYTES + 1 });
    await assert.rejects(over.api.prepare(png(), { extension: 'png' }), { code: 'IMAGE_ATTACHMENT_LIMIT' });
    assert.equal(over.state.encodings.length, 5); assert.equal(over.state.canvas.width, 0); assert.equal(over.state.workers.length, 0);
});

test('prepare cancellation before decoding, during encoding and after byte loading never returns late attachments', async () => {
    const before = new AbortController(); before.abort();
    await assert.rejects(Reader.prepare(png(), { extension: 'png', signal: before.signal }), { name: 'AbortError' });
    for (const hook of ['onEncode', 'onBuffer']) {
        const controller = new AbortController();
        const { api, state } = browser({ [hook]: () => controller.abort() });
        await assert.rejects(api.prepare(png(), { extension: 'png', signal: controller.signal }), { name: 'AbortError' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(state.revoked.length, 1); assert.equal(state.canvas.width, 0); assert.equal(state.workers.length, 0);
    }
});

test('prepare timeout bounds stalled decoding or encoding and releases resources', async () => {
    for (const stage of ['decodeHang', 'encodeHang']) {
        const { api, state } = browser({ [stage]: true, timeout: true });
        await assert.rejects(api.prepare(png(), { extension: 'png' }), { code: 'IMAGE_TIMEOUT' });
        assert.equal(state.revoked.length, 1); assert.equal(state.workers.length, 0);
        if (state.canvas) assert.equal(state.canvas.width, 0);
    }
});

test('all OCR vendor assets match locked installed packages and include every LSTM variant', () => {
    const manifest = require('../vendor/tesseract/manifest.json');
    const dependencies = require('../package.json').dependencies;
    assert.equal(manifest.versions['tesseract.js'], '7.0.0', 'direct worker protocol requires review on version updates');
    for (const [name, version] of Object.entries(manifest.versions)) assert.equal(version, dependencies[name]);
    const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
    for (const asset of manifest.assets) {
        assert.equal(hash(fs.readFileSync(path.join(__dirname, '..', asset.path))), asset.sha256, asset.path);
        if (asset.package) assert.equal(hash(fs.readFileSync(path.join(path.dirname(require.resolve(`${asset.package}/package.json`)), asset.source))), asset.sha256, asset.source);
        else {
            assert.match(asset.sourceURL, /^https:\/\/raw\.githubusercontent\.com\/naptha\/tessdata\/[a-f0-9]{40}\/LICENSE$/);
            assert.match(fs.readFileSync(path.join(__dirname, '..', asset.path), 'utf8'), /Apache License/);
        }
    }
    for (const variant of ['', '-simd', '-relaxedsimd']) assert.ok(manifest.assets.some(asset => asset.path.endsWith(`tesseract-core${variant}-lstm.wasm.js`)));
    for (const language of ['chi_tra', 'eng']) assert.ok(manifest.assets.some(asset => asset.path.endsWith(`${language}.traineddata.gz`)));
});
