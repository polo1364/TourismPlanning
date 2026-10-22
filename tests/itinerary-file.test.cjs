'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const vm = require('node:vm');
const Reader = require('../itinerary-file.js');

function file(name, content, overrides = {}) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    return { name, size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer, ...overrides };
}
function imageReader(image, browser = false) {
    const sandbox = { Uint8Array, TextDecoder, URL };
    if (browser) {
        sandbox.window = { ItineraryImage: image };
        sandbox.document = { currentScript: { src: 'https://example.test/itinerary-file.js' } };
    } else {
        sandbox.module = { exports: {} };
        sandbox.require = name => { assert.equal(name, './itinerary-image.js'); return image; };
    }
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../itinerary-file.js'), 'utf8'), sandbox);
    return browser ? sandbox.window.ItineraryFile : sandbox.module.exports;
}
// A complete PDF with xref offsets, ordinary page objects and text streams.
// Tests exercise the actual vendored parser, not a mock that merely returns text.
function pdf(linesByPage = [['Day 1 Taipei', '09:00 Breakfast']], encrypted = false, traditionalChinese = false, imagePages = []) {
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        `<< /Type /Pages /Kids [${linesByPage.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${linesByPage.length} >>`,
        traditionalChinese
            ? `<< /Type /Font /Subtype /Type0 /BaseFont /MSung-Light /Encoding /UniCNS-UCS2-H /DescendantFonts [${4 + linesByPage.length * 2} 0 R] >>`
            : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    ];
    for (let i = 0; i < linesByPage.length; i++) {
        let content = linesByPage[i].map((line, n) => {
            const literal = traditionalChinese ? `<${Buffer.from(line, 'utf16le').swap16().toString('hex')}>` : `(${line.replace(/[\\()]/g, '\\$&')})`;
            return `BT /F1 12 Tf 1 0 0 1 50 ${750 - n * 20} Tm ${literal} Tj ET`;
        }).join('\n');
        if (imagePages.includes(i + 1)) content += '\nq 100 0 0 100 50 500 cm BI /W 1 /H 1 /CS /RGB /BPC 8 /F /ASCIIHexDecode ID ff0000> EI Q';
        const width = Math.max(595, ...linesByPage[i].map(line => line.length * 10 + 100));
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
        objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    }
    if (traditionalChinese) objects.push('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /MSung-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (CNS1) /Supplement 0 >> /DW 1000 >>');
    if (encrypted) objects.push(`<< /Filter /Standard /V 1 /R 2 /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> /P -4 >>`);
    return pdfObjects(objects, encrypted);
}
function pdfObjects(objects, encrypted = false) {
    let output = '%PDF-1.7\n';
    const offsets = [0];
    for (let i = 0; i < objects.length; i++) {
        offsets.push(Buffer.byteLength(output));
        output += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xref = Buffer.byteLength(output);
    output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    output += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
    output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encrypted ? ` /Encrypt ${objects.length} 0 R /ID [<00112233445566778899aabbccddeeff><00112233445566778899aabbccddeeff>]` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(output);
}

// Keep the real PDF parser and operator list; only canvas rasterization and OCR are
// substituted here. Actual rendering + recognition is covered by browser tests.
async function pdfReader(options = {}) {
    const actual = await import('../vendor/pdfjs/pdf.mjs');
    const state = { canvases: [], renders: [], encodings: [], ocrCalls: [], prepareCalls: [], cleaned: [], destroyed: 0 };
    const image = { read: async (bytes, settings) => {
        state.ocrCalls.push({ bytes, ...settings });
        if (options.ocr) return options.ocr(bytes, settings, state);
        throw Object.assign(new Error('No readable text'), { code: 'IMAGE_NO_TEXT' });
    }, prepare: async (bytes, settings) => {
        state.prepareCalls.push({ bytes, ...settings });
        if (options.prepare) return options.prepare(bytes, settings, state);
        return { text: '', format: 'image', pages: null, warnings: [], images: [{ mime: 'image/png', dataBase64: 'AQID', page: 1 }] };
    } };
    const parser = { ...actual, getDocument(settings) {
        const task = actual.getDocument(settings);
        return { promise: task.promise.then(document => ({ numPages: document.numPages, getPage: async number => {
            const page = await document.getPage(number);
            return new Proxy(page, { get(target, key) {
                if (key === 'render') return parameters => {
                    state.renders.push({ number, ...parameters });
                    return options.render?.(number, parameters, state) || { promise: Promise.resolve(), cancel() {} };
                };
                if (key === 'cleanup') return () => { state.cleaned.push(number); return page.cleanup(); };
                if (key === 'getOperatorList' && options.operators) return () => options.operators(number, actual.OPS);
                if (key === 'getViewport' && options.dimensions) return ({ scale }) => ({ width: options.dimensions[0] * scale, height: options.dimensions[1] * scale });
                const value = Reflect.get(target, key, target);
                return typeof value === 'function' ? value.bind(target) : value;
            } });
        } })), destroy: () => { state.destroyed++; return task.destroy(); } };
    } };
    const sandbox = { Uint8Array, TextDecoder, URL, setTimeout: options.setTimeout || setTimeout, clearTimeout,
        module: { exports: {} }, __dirname: path.join(__dirname, '..'),
        require: name => name === './itinerary-image.js' ? image : require(name),
        loadPDFModule: async () => parser,
        document: { createElement: tag => {
            assert.equal(tag, 'canvas');
            const canvas = { width: 0, height: 0, getContext: () => ({}), toBlob(callback, type, quality) {
                state.encodings.push({ type, quality, width: canvas.width, height: canvas.height });
                callback(options.blob?.(type) || { size: 3, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer });
            } };
            state.canvases.push(canvas);
            return canvas;
        } }
    };
    const source = fs.readFileSync(path.join(__dirname, '../itinerary-file.js'), 'utf8');
    assert.ok(source.includes("import('./vendor/pdfjs/pdf.mjs')"));
    vm.runInNewContext(source.replace("import('./vendor/pdfjs/pdf.mjs')", 'loadPDFModule()'), sandbox);
    return { reader: sandbox.module.exports, state };
}

test('UTF-8 TXT preserves Chinese, line breaks and literal untrusted markup', async () => {
    const progress = [];
    const result = await Reader.read(file('台北.TXT', '\uFEFF第一天 台北\r\n09:00 早餐\r<script>alert(1)</script>'), { onProgress: state => progress.push(state) });
    assert.equal(result.text, '第一天 台北\n09:00 早餐\n<script>alert(1)</script>');
    assert.equal(result.format, 'txt'); assert.equal(result.pages, null); assert.deepEqual(result.warnings, []);
    assert.deepEqual(progress.map(state => state.stage), ['reading', 'done']);
});

for (const extension of ['md', 'markdown', 'MD']) test(`Markdown .${extension} is read as literal text`, async () => {
    const result = await Reader.read(file(`trip.${extension}`, '# 京都\n- 清水寺'));
    assert.equal(result.format, 'md'); assert.equal(result.text, '# 京都\n- 清水寺');
});

for (const bigEndian of [false, true]) test(`UTF-16 ${bigEndian ? 'BE' : 'LE'} BOM is supported`, async () => {
    const bytes = Buffer.from('台北\r\n第二天', 'utf16le');
    if (bigEndian) bytes.swap16();
    const result = await Reader.read(file('trip.txt', Buffer.concat([Buffer.from(bigEndian ? [0xFE, 0xFF] : [0xFF, 0xFE]), bytes])));
    assert.equal(result.text, '台北\n第二天'); assert.deepEqual(result.warnings, []);
});

test('Big5 fallback preserves traditional Chinese and reports the fallback', async () => {
    const result = await Reader.read(file('trip.txt', Buffer.from([0xA5, 0x78, 0xA5, 0x5F])));
    assert.equal(result.text, '台北'); assert.match(result.warnings[0], /Big5/);
});

test('unsupported file extensions are rejected before reading', async () => {
    for (const name of ['trip.docx', 'trip.csv', 'trip.pdf.exe', 'trip']) {
        await assert.rejects(Reader.read(file(name, 'day 1', { arrayBuffer: () => { throw new Error('Must not read'); } })), { code: 'FORMAT' });
    }
});

test('image formats route through the Node OCR adapter with progress and source bytes', async () => {
    const calls = [], states = [];
    const reader = imageReader({ read: async (bytes, options) => {
        calls.push({ bytes: Array.from(bytes), extension: options.extension, signal: options.signal });
        options.onProgress?.({ stage: 'ocr', message: '正在辨識圖片文字' });
        return { text: '\uFEFF台北\r\n09:00 早餐 ', format: 'image', pages: null, warnings: ['請核對辨識文字'] };
    } });
    const controller = new AbortController();
    for (const extension of ['PNG', 'jpg', 'jpeg', 'webp']) {
        const result = await reader.read(file(`trip.${extension}`, Buffer.from([1, 2, 3])), { signal: controller.signal, onProgress: state => states.push(state.stage) });
        assert.equal(result.text, '台北\n09:00 早餐');
        assert.equal(result.format, 'image'); assert.equal(result.pages, null);
        assert.equal(result.warnings[0], '請核對辨識文字');
    }
    assert.deepEqual(calls.map(call => call.extension), ['png', 'jpg', 'jpeg', 'webp']);
    assert.ok(calls.every(call => call.signal === controller.signal && call.bytes.join(',') === '1,2,3'));
    assert.deepEqual(states, Array.from({ length: 4 }, () => ['reading', 'ocr', 'done']).flat());
});

test('browser image routing uses the global adapter and does not load OCR for TXT', async () => {
    let calls = 0;
    const reader = imageReader({ read: async () => { calls++; return { text: '圖片行程', warnings: [] }; } }, true);
    assert.equal((await reader.read(file('trip.txt', '文字行程'))).text, '文字行程');
    assert.equal(calls, 0);
    assert.equal((await reader.read(file('trip.png', 'image bytes'))).text, '圖片行程');
    assert.equal(calls, 1);
    await assert.rejects(imageReader(undefined, true).read(file('trip.png', 'bytes')), { code: 'IMAGE_ASSET' });
});

test('HEIC and HEIF receive conversion guidance before their contents are read', async () => {
    for (const extension of ['HEIC', 'heif']) {
        await assert.rejects(Reader.read(file(`trip.${extension}`, '', { arrayBuffer: () => { throw new Error('Must not read'); } })), error => error.code === 'FORMAT' && /JPG.*PNG/.test(error.message));
    }
});

test('image byte limits prevent OCR and accept the exact 8 MiB boundary', async () => {
    let calls = 0;
    const reader = imageReader({ read: async bytes => { calls++; assert.equal(bytes.length, Reader.MAX_BYTES); return { text: '行程', warnings: [] }; } });
    await assert.rejects(reader.read(file('trip.png', '', { size: Reader.MAX_BYTES + 1, arrayBuffer: () => { throw new Error('Must not read'); } })), { code: 'FILE_LIMIT' });
    await assert.rejects(reader.read(file('trip.jpg', Buffer.alloc(Reader.MAX_BYTES + 1), { size: 1 })), { code: 'FILE_LIMIT' });
    assert.equal(calls, 0);
    assert.equal((await reader.read(file('trip.webp', Buffer.alloc(Reader.MAX_BYTES)))).text, '行程');
    assert.equal(calls, 1);
});

test('OCR text length is checked by the file reader without silently truncating', async () => {
    const reader = imageReader({ read: async bytes => ({ text: '台'.repeat(bytes[0] ? Reader.MAX_CHARACTERS + 1 : Reader.MAX_CHARACTERS), warnings: [] }) });
    assert.equal((await reader.read(file('trip.png', Buffer.from([0])))).text.length, Reader.MAX_CHARACTERS);
    await assert.rejects(reader.read(file('trip.png', Buffer.from([1]))), { code: 'TEXT_LIMIT' });
});

test('empty or invalid OCR output is rejected and OCR error codes propagate', async () => {
    await assert.rejects(imageReader({ read: async () => ({ text: ' \r\n ', warnings: [] }) }).read(file('trip.png', 'bytes')), { code: 'IMAGE_NO_TEXT' });
    await assert.rejects(imageReader({ read: async () => ({ text: ['invalid'], warnings: [] }) }).read(file('trip.png', 'bytes')), { code: 'IMAGE_RESULT' });
    await assert.rejects(imageReader({ read: async () => { throw Object.assign(new Error('辨識逾時'), { code: 'IMAGE_TIMEOUT' }); } }).read(file('trip.png', 'bytes')), { code: 'IMAGE_TIMEOUT' });
});

test('image cancellation prevents OCR work or discards late OCR results', async () => {
    let calls = 0;
    const before = new AbortController(); before.abort();
    const reader = imageReader({ read: async () => { calls++; return { text: 'should not be used', warnings: [] }; } });
    await assert.rejects(reader.read(file('trip.png', 'bytes'), { signal: before.signal }), { name: 'AbortError' });
    const loading = new AbortController();
    await assert.rejects(reader.read(file('trip.png', '', { arrayBuffer: async () => { loading.abort(); return new ArrayBuffer(1); } }), { signal: loading.signal }), { name: 'AbortError' });
    assert.equal(calls, 0);
    const recognizing = new AbortController();
    const late = imageReader({ read: async () => { recognizing.abort(); return { text: 'late output', warnings: [] }; } });
    await assert.rejects(late.read(file('trip.png', 'bytes'), { signal: recognizing.signal }), { name: 'AbortError' });
});

test('size limits are checked before reading and against actual data', async () => {
    await assert.rejects(Reader.read(file('trip.pdf', '', { size: Reader.MAX_BYTES + 1, arrayBuffer: () => { throw new Error('Must not read'); } })), { code: 'FILE_LIMIT' });
    await assert.rejects(Reader.read(file('trip.txt', Buffer.alloc(Reader.MAX_BYTES + 1, 32), { size: 1 })), { code: 'FILE_LIMIT' });
    const within = Buffer.alloc(Reader.MAX_BYTES, 32); within[0] = 65;
    assert.equal((await Reader.read(file('trip.txt', within))).text, 'A');
});

test('empty text, binary and malformed text encodings are rejected', async () => {
    for (const value of ['', '\uFEFF \r\n\t']) await assert.rejects(Reader.read(file('trip.txt', value)), { code: 'EMPTY' });
    await assert.rejects(Reader.read(file('trip.txt', Buffer.from([65, 0, 66]))), { code: 'BINARY' });
    await assert.rejects(Reader.read(file('trip.txt', Buffer.from([0xFF, 0xFE, 0x41]))), { code: 'ENCODING' });
    await assert.rejects(Reader.read(file('trip.txt', Buffer.from([0x81]))), { code: 'ENCODING' });
});

test('text character limit accepts the boundary and rejects overflow without truncation', async () => {
    assert.equal((await Reader.read(file('trip.txt', '台'.repeat(Reader.MAX_CHARACTERS)))).text.length, Reader.MAX_CHARACTERS);
    await assert.rejects(Reader.read(file('trip.txt', '台'.repeat(Reader.MAX_CHARACTERS + 1))), { code: 'TEXT_LIMIT' });
});

test('file read errors are reported without exposing internal error data', async () => {
    await assert.rejects(Reader.read(file('trip.txt', '', { arrayBuffer: async () => { throw new Error('private path'); } })), { code: 'FILE_READ' });
});

test('actual PDF parser extracts lines and pages and reports progress', async () => {
    const states = [];
    const result = await Reader.read(file('trip.PDF', pdf([['Day 1 Taipei', '09:00 Breakfast'], ['Day 2 Kyoto']])) , { onProgress: state => states.push(state) });
    assert.equal(result.text, 'Day 1 Taipei\n09:00 Breakfast\n\nDay 2 Kyoto');
    assert.equal(result.format, 'pdf'); assert.equal(result.pages, 2); assert.equal(result.warnings.length, 1);
    assert.deepEqual(states.filter(state => state.stage === 'pdf').map(state => [state.page, state.pages]), [[1, 2], [2, 2]]);
});

test('PDF tries OCR on blank pages, then rejects all-blank or warns about individual empty pages', async () => {
    const { reader, state } = await pdfReader();
    await assert.rejects(reader.read(file('scan.pdf', pdf([[], []]))), error => error.code === 'PDF_NO_TEXT' && /仍沒有可讀文字/.test(error.message));
    const result = await reader.read(file('mixed.pdf', pdf([['Day 1'], [], ['Day 3']])));
    assert.equal(result.text, 'Day 1\n\nDay 3'); assert.match(result.warnings.join('\n'), /第 2 頁/);
    assert.equal(state.ocrCalls.length, 3);
    assert.equal(state.destroyed, 2);
    assert.ok(state.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('traditional Chinese PDF without embedded Unicode map uses bundled CNS CMaps', async () => {
    const result = await Reader.read(file('台北.pdf', pdf([['台北行程', '九點早餐', '十分瀑布']], false, true)));
    assert.equal(result.text, '台北行程\n九點早餐\n十分瀑布');
});

test('PDF page limit accepts 60 and refuses 61 pages', async () => {
    assert.equal((await Reader.read(file('sixty.pdf', pdf(Array.from({ length: 60 }, () => ['Day']))))).pages, 60);
    await assert.rejects(Reader.read(file('long.pdf', pdf(Array.from({ length: 61 }, () => ['Day'])))), { code: 'PAGE_LIMIT' });
});

test('PDF text limit accepts the exact boundary and refuses oversized text', async () => {
    assert.equal((await Reader.read(file('limit.pdf', pdf([['a'.repeat(Reader.MAX_CHARACTERS)]])))).text.length, Reader.MAX_CHARACTERS);
    const { reader } = await pdfReader();
    assert.equal((await reader.read(file('limit-blank.pdf', pdf([['a'.repeat(Reader.MAX_CHARACTERS)], [' ']])))).text.length, Reader.MAX_CHARACTERS);
    await assert.rejects(Reader.read(file('long.pdf', pdf([['a'.repeat(Reader.MAX_CHARACTERS + 1)]]))), { code: 'TEXT_LIMIT' });
});

test('actual PDF image operators trigger OCR on scans and native-header pages but not text-only pages', async () => {
    const progress = [];
    const { reader, state } = await pdfReader({ ocr: async (_, settings, current) => {
        settings.onProgress({ message: '正在辨識圖片文字… 50%', percent: 50 });
        return { text: current.ocrCalls.length === 1 ? '台北行程\n09:00 早餐' : 'Ｄａｙ　２\n10:00 Museum', warnings: ['請核對辨識文字'] };
    } });
    const result = await reader.read(file('mixed.pdf', pdf([[], ['Day 2'], ['Day 3 text only']], false, false, [1, 2])), { onProgress: value => progress.push(value) });
    assert.equal(result.text, '台北行程\n09:00 早餐\n\nDay 2\n10:00 Museum\n\nDay 3 text only');
    assert.equal(result.format, 'pdf'); assert.equal(result.pages, 3);
    assert.deepEqual(state.renders.map(render => render.number), [1, 2]);
    assert.equal(state.ocrCalls.length, 2);
    assert.equal(result.warnings.filter(warning => warning === '請核對辨識文字').length, 1);
    assert.match(result.warnings.join('\n'), /第 1、2 頁已使用圖片文字辨識/);
    assert.ok(progress.some(value => value.page === 2 && value.pages === 3 && value.percent === 50 && /PDF 第 2 \/ 3 頁文字辨識/.test(value.message)));
    assert.ok(state.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
    assert.deepEqual(state.cleaned, [1, 2, 3]); assert.equal(state.destroyed, 1);
});

test('PDF image detection covers masks, repeats, groups and nested tiling patterns', async () => {
    const names = ['paintImageMaskXObject', 'paintImageMaskXObjectGroup', 'paintImageXObject', 'paintInlineImageXObject',
        'paintInlineImageXObjectGroup', 'paintImageXObjectRepeat', 'paintImageMaskXObjectRepeat', 'paintSolidColorImageMask'];
    const { reader, state } = await pdfReader({ operators: async (number, ops) => number <= names.length
        ? { fnArray: [ops[names[number - 1]]], argsArray: [[]] }
        : { fnArray: [ops.setFillColorN], argsArray: [['TilingPattern', null, { fnArray: [ops.paintImageXObject], argsArray: [[]] }]] },
    ocr: async () => ({ text: 'Extra image text', warnings: [] }) });
    const result = await reader.read(file('patterns.pdf', pdf(Array.from({ length: 9 }, () => ['Header']))));
    assert.equal(state.ocrCalls.length, 9); assert.equal(result.pages, 9);
});

test('actual PDF tiling-pattern operator list triggers OCR despite having no top-level image operation', async () => {
    const content = 'BT /F1 12 Tf 1 0 0 1 10 180 Tm (Native header) Tj ET\n/Pattern cs /P1 scn 0 0 100 100 re f';
    const pattern = 'q 100 0 0 100 0 0 cm /Im1 Do Q';
    const bytes = pdfObjects([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> /Pattern << /P1 6 0 R >> >> /Contents 4 0 R >>',
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        `<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 100 100] /XStep 100 /YStep 100 /Resources << /XObject << /Im1 7 0 R >> >> /Length ${pattern.length} >>\nstream\n${pattern}\nendstream`,
        '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\nabc\nendstream'
    ]);
    const parser = await import('../vendor/pdfjs/pdf.mjs');
    const task = parser.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, verbosity: 0 });
    try {
        const page = await (await task.promise).getPage(1);
        const list = await page.getOperatorList();
        assert.ok(!list.fnArray.includes(parser.OPS.paintImageXObject));
        const entry = list.argsArray.find(args => args?.[0] === 'TilingPattern');
        assert.ok(entry?.[2].fnArray.includes(parser.OPS.paintImageXObject));
    } finally { await task.destroy(); }
    const { reader, state } = await pdfReader({ ocr: async () => ({ text: 'Native header\nScanned pattern itinerary', warnings: [] }) });
    assert.equal((await reader.read(file('pattern.pdf', bytes))).text, 'Native header\nScanned pattern itinerary');
    assert.equal(state.ocrCalls.length, 1);
});

test('PDF line merging removes normalized native duplicates but retains repeats within OCR text', async () => {
    const { reader } = await pdfReader({ ocr: async () => ({ text: 'Ｔａｉｐｅｉ\n09:00　Breakfast\n新活動\n新 活 動\n10:00 Train', warnings: [] }) });
    const result = await reader.read(file('hybrid.pdf', pdf([['Taipei', '09:00 Breakfast']], false, false, [1])));
    assert.equal(result.text, 'Taipei\n09:00 Breakfast\n新活動\n新 活 動\n10:00 Train');
});

test('PDF OCR preserves repeat visits to the same stop and only subtracts native line occurrences', async () => {
    const recognized = '09:00\nTaipei Station\n18:00\nTaipei Station';
    const { reader } = await pdfReader({ ocr: async () => ({ text: recognized, warnings: [] }) });
    assert.equal((await reader.read(file('scan.pdf', pdf([[]], false, false, [1])))).text, recognized);
    assert.equal((await reader.read(file('hybrid.pdf', pdf([['09:00', 'Taipei Station']], false, false, [1])))).text, recognized);
});

test('PDF retains native text and warns when an image has no readable text', async () => {
    const { reader } = await pdfReader();
    const result = await reader.read(file('photo.pdf', pdf([['Header']], false, false, [1])));
    assert.equal(result.text, 'Header');
    assert.match(result.warnings.join('\n'), /第 1 頁的圖片未辨識出文字/);
});

test('PDF rejects a real OCR failure on any page without returning partial extracted text', async () => {
    for (const code of ['IMAGE_ASSET', 'IMAGE_INVALID', 'IMAGE_TIMEOUT']) {
        const { reader, state } = await pdfReader({ ocr: async () => { throw Object.assign(new Error('private path or worker error'), { code }); } });
        await assert.rejects(reader.read(file('failed.pdf', pdf([['Native first page'], []], false, false, [2]))), error => error.code === 'PDF_OCR' && /未匯入任何部分結果/.test(error.message) && !/private/.test(error.message));
        assert.equal(state.destroyed, 1); assert.deepEqual(state.cleaned, [1, 2]);
        assert.ok(state.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
    }
});

test('PDF cumulative OCR and native text obey the 30000-character limit including page separators', async () => {
    const native = 'a'.repeat(Reader.MAX_CHARACTERS - 3);
    const within = await pdfReader({ ocr: async () => ({ text: '台', warnings: [] }) });
    assert.equal((await within.reader.read(file('limit.pdf', pdf([[native], []], false, false, [2])))).text.length, Reader.MAX_CHARACTERS);
    const over = await pdfReader({ ocr: async () => ({ text: '台北', warnings: [] }) });
    await assert.rejects(over.reader.read(file('over.pdf', pdf([[native], []], false, false, [2]))), { code: 'TEXT_LIMIT' });
    assert.equal(over.state.destroyed, 1);
    const duplicate = await pdfReader({ ocr: async () => ({ text: 'a'.repeat(Reader.MAX_CHARACTERS), warnings: [] }) });
    assert.equal((await duplicate.reader.read(file('same.pdf', pdf([['a'.repeat(Reader.MAX_CHARACTERS)]], false, false, [1])))).text.length, Reader.MAX_CHARACTERS);
});

test('PDF page rendering is bounded to 2400 pixels per side and 4 MP before OCR', async () => {
    const { reader, state } = await pdfReader({ dimensions: [5000, 8000], ocr: async () => ({ text: '行程', warnings: [] }) });
    await reader.read(file('large-page.pdf', pdf([[]])));
    assert.equal(state.encodings.length, 1);
    const { width, height } = state.encodings[0];
    assert.ok(width <= 2400 && height <= 2400 && width * height <= 4000000);
    assert.equal(state.renders[0].background, 'white');
});

test('PDF encodes oversized PNG as JPEG95 and refuses an oversized fallback without calling OCR', async () => {
    const { reader, state } = await pdfReader({ blob: type => ({ size: type === 'image/png' ? Reader.MAX_BYTES + 1 : 3, arrayBuffer: async () => new ArrayBuffer(3) }), ocr: async (_, settings) => {
        assert.equal(settings.extension, 'jpg'); return { text: '行程', warnings: [] };
    } });
    await reader.read(file('scan.pdf', pdf([[]])));
    assert.deepEqual(state.encodings.map(value => [value.type, value.quality]), [['image/png', 0.95], ['image/jpeg', 0.95]]);
    const over = await pdfReader({ blob: () => ({ size: Reader.MAX_BYTES + 1 }) });
    await assert.rejects(over.reader.read(file('scan.pdf', pdf([[]]))), { code: 'PDF_RENDER_LIMIT' });
    assert.equal(over.state.ocrCalls.length, 0);
    assert.ok(over.state.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('PDF rendering failure releases canvas, page and document without starting OCR', async () => {
    const { reader, state } = await pdfReader({ render: () => ({ promise: Promise.reject(new Error('private renderer path')), cancel() {} }) });
    await assert.rejects(reader.read(file('scan.pdf', pdf([[]]))), error => error.code === 'PDF_INVALID' && !/private/.test(error.message));
    assert.equal(state.ocrCalls.length, 0); assert.equal(state.destroyed, 1); assert.deepEqual(state.cleaned, [1]);
    assert.ok(state.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('PDF cancellation during rendering cancels the render task and permits a clean retry', async () => {
    const controller = new AbortController();
    let cancelCalls = 0, first = true;
    const { reader, state } = await pdfReader({ render: () => {
        if (!first) return;
        first = false;
        let reject;
        const promise = new Promise((_, fail) => { reject = fail; });
        queueMicrotask(() => controller.abort());
        return { promise, cancel() { cancelCalls++; reject(new Error('Rendering cancelled')); } };
    }, ocr: async () => ({ text: 'Retry itinerary', warnings: [] }) });
    await assert.rejects(reader.read(file('scan.pdf', pdf([[]])), { signal: controller.signal }), { name: 'AbortError' });
    assert.ok(cancelCalls >= 1); assert.equal(state.ocrCalls.length, 0);
    assert.equal((await reader.read(file('retry.pdf', pdf([[]])))).text, 'Retry itinerary');
    assert.equal(state.destroyed, 2);
    assert.ok(state.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('PDF cancellation exits a pending operator-list request even when the parser never rejects it', async () => {
    const controller = new AbortController();
    const { reader, state } = await pdfReader({ operators: () => {
        queueMicrotask(() => controller.abort());
        return new Promise(() => {});
    } });
    await assert.rejects(reader.read(file('pending.pdf', pdf([['Native header']])), { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(state.destroyed, 1); assert.deepEqual(state.cleaned, [1]);
    assert.equal(state.renders.length, 0); assert.equal(state.ocrCalls.length, 0);
});

test('PDF rendering timeout cancels and settles the render task before releasing its canvas', async () => {
    let cancelled = false;
    const { reader, state } = await pdfReader({ setTimeout: callback => setTimeout(callback, 1), render: () => {
        let reject;
        return { promise: new Promise((_, fail) => { reject = fail; }), cancel() { cancelled = true; reject(new Error('render cancelled')); } };
    } });
    await assert.rejects(reader.read(file('timeout.pdf', pdf([[]]))), { code: 'PDF_RENDER_TIMEOUT' });
    assert.equal(cancelled, true); assert.equal(state.destroyed, 1);
    assert.ok(state.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('PDF cancellation while OCR is running passes the signal and rejects late results', async () => {
    const controller = new AbortController();
    const { reader, state } = await pdfReader({ ocr: async (_, settings) => {
        assert.equal(settings.signal, controller.signal);
        controller.abort();
        settings.onProgress({ message: 'late progress' });
        return { text: 'late result must not escape', warnings: [] };
    } });
    const updates = [];
    await assert.rejects(reader.read(file('scan.pdf', pdf([[]])), { signal: controller.signal, onProgress: value => updates.push(value) }), { name: 'AbortError' });
    assert.ok(!updates.some(value => /late/.test(value.message) || value.stage === 'done'));
    assert.equal(state.destroyed, 1); assert.ok(state.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('prepareImages routes original images to prepare without OCR and accepts empty text with an attachment', async () => {
    let calls = 0;
    const reader = imageReader({ read: async () => { throw new Error('OCR must not run'); }, prepare: async (bytes, options) => {
        calls++; assert.equal(options.extension, 'png'); assert.equal(bytes.length, 3);
        return { text: '', warnings: ['請核對'], images: [{ mime: 'image/png', dataBase64: 'AQID', page: 1 }] };
    } });
    const result = await reader.read(file('trip.png', '123'), { prepareImages: true });
    assert.equal(result.text, ''); assert.equal(result.format, 'image'); assert.equal(result.pages, null); assert.equal(result.images[0].page, 1);
    assert.equal(calls, 1);
    for (const extension of ['txt', 'md']) {
        const text = await reader.read(file(`trip.${extension}`, 'Native text'), { prepareImages: true });
        assert.equal(text.text, 'Native text'); assert.equal(text.images.length, 0);
    }
    assert.equal(calls, 1);
});

test('prepareImages keeps native PDF text and includes scan, image-header and blank pages for Codex', async () => {
    const { reader, state } = await pdfReader();
    const updates = [];
    const result = await reader.read(file('mixed.pdf', pdf([['Native page'], [], ['Native header'], []], false, false, [2, 3])), { prepareImages: true, onProgress: value => updates.push(value) });
    assert.equal(result.text, 'Native page\n\nNative header'); assert.equal(result.pages, 4);
    assert.deepEqual(Array.from(result.images, image => image.page), [2, 3, 4]);
    assert.equal(state.prepareCalls.length, 3); assert.equal(state.ocrCalls.length, 0);
    assert.ok(updates.some(update => /第 4 \/ 4 頁圖片供 Codex/.test(update.message)));
    assert.ok(!result.warnings.some(warning => /已略過|沒有可讀文字/.test(warning)));
    assert.ok(state.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
    assert.equal(state.destroyed, 1);
    const blank = await reader.read(file('blank.pdf', pdf([[]])), { prepareImages: true });
    assert.equal(blank.text, ''); assert.equal(blank.images.length, 1);
    const native = await reader.read(file('text.pdf', pdf([['Only native text']])), { prepareImages: true });
    assert.equal(native.images.length, 0); assert.equal(native.text, 'Only native text');
});

test('prepareImages validates attachments and enforces the individual 2 MiB boundary', async () => {
    const boundary = Buffer.alloc(Reader.MAX_IMAGE_BYTES).toString('base64');
    const valid = imageReader({ prepare: async () => ({ images: [{ mime: 'image/jpeg', dataBase64: boundary, page: 1 }] }) });
    assert.equal((await valid.read(file('image.jpg', 'x'), { prepareImages: true })).images[0].dataBase64, boundary);
    for (const [attachment, code] of [
        [{ mime: 'image/png', dataBase64: Buffer.alloc(Reader.MAX_IMAGE_BYTES + 1).toString('base64') }, 'IMAGE_ATTACHMENT_LIMIT'],
        [{ mime: 'image/svg+xml', dataBase64: 'AQID' }, 'IMAGE_RESULT'],
        [{ mime: 'image/png', dataBase64: '<invalid>' }, 'IMAGE_RESULT'],
        [{ mime: 'image/png', dataBase64: '' }, 'IMAGE_RESULT']
    ]) {
        const reader = imageReader({ prepare: async () => ({ images: [attachment] }) });
        await assert.rejects(reader.read(file('image.png', 'x'), { prepareImages: true }), { code });
    }
});

test('prepareImages accepts exactly 20 MiB across pages and rejects overflow atomically', async () => {
    const attachment = { mime: 'image/png', dataBase64: Buffer.alloc(Reader.MAX_IMAGE_BYTES).toString('base64'), page: 1 };
    const { reader, state } = await pdfReader({ prepare: async () => ({ images: [attachment], warnings: [] }) });
    const within = await reader.read(file('ten.pdf', pdf(Array.from({ length: 10 }, () => []))), { prepareImages: true });
    assert.equal(within.images.length, 10);
    await assert.rejects(reader.read(file('eleven.pdf', pdf(Array.from({ length: 11 }, () => []))), { prepareImages: true }), { code: 'ATTACHMENT_LIMIT' });
    assert.equal(state.ocrCalls.length, 0); assert.equal(state.destroyed, 2);
    assert.ok(state.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('prepareImages retains the 60-page cap and allows 60 small attachments', async () => {
    const { reader, state } = await pdfReader();
    const result = await reader.read(file('sixty.pdf', pdf(Array.from({ length: 60 }, () => []))), { prepareImages: true });
    assert.equal(result.images.length, 60); assert.equal(result.images[59].page, 60);
    await assert.rejects(reader.read(file('sixty-one.pdf', pdf(Array.from({ length: 61 }, () => []))), { prepareImages: true }), { code: 'PAGE_LIMIT' });
    assert.equal(state.prepareCalls.length, 60); assert.equal(state.ocrCalls.length, 0);
});

test('prepareImages fails the whole PDF if a later page preparation fails and rejects late cancelled results', async () => {
    const failing = await pdfReader({ prepare: async (_, __, state) => {
        if (state.prepareCalls.length === 2) throw Object.assign(new Error('private image path'), { code: 'IMAGE_INVALID' });
        return { images: [{ mime: 'image/png', dataBase64: 'AQID', page: 1 }] };
    } });
    await assert.rejects(failing.reader.read(file('mixed.pdf', pdf([[], []])), { prepareImages: true }), error => error.code === 'PDF_PREPARE' && /未匯入任何部分結果/.test(error.message) && !/private/.test(error.message));
    assert.equal(failing.state.destroyed, 1); assert.equal(failing.state.ocrCalls.length, 0);
    const controller = new AbortController();
    const cancelled = await pdfReader({ prepare: async (_, options) => {
        assert.equal(options.signal, controller.signal);
        controller.abort();
        return { images: [{ mime: 'image/png', dataBase64: 'AQID', page: 1 }] };
    } });
    await assert.rejects(cancelled.reader.read(file('cancel.pdf', pdf([[]])), { prepareImages: true, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(cancelled.state.destroyed, 1);
});

test('password protected and malformed PDFs have specific errors', async () => {
    await assert.rejects(Reader.read(file('locked.pdf', pdf([['secret']], true))), { code: 'PDF_PASSWORD' });
    for (const bytes of ['', 'hello world', '%PDF-1.7\nthis is damaged\n%%EOF']) {
        await assert.rejects(Reader.read(file('broken.pdf', bytes)), { code: 'PDF_INVALID' });
    }
});

test('cancellation before reading, during file read, and during PDF extraction returns AbortError', async () => {
    const before = new AbortController(); before.abort();
    await assert.rejects(Reader.read(file('trip.txt', 'Day 1'), { signal: before.signal }), { name: 'AbortError' });
    const during = new AbortController();
    await assert.rejects(Reader.read(file('trip.txt', 'Day 1', { arrayBuffer: async () => { during.abort(); return new ArrayBuffer(0); } }), { signal: during.signal }), { name: 'AbortError' });
    const extracting = new AbortController();
    await assert.rejects(Reader.read(file('trip.pdf', pdf()), { signal: extracting.signal, onProgress: state => { if (state.stage === 'pdf') extracting.abort(); } }), { name: 'AbortError' });
    assert.equal((await Reader.read(file('after.pdf', pdf()))).pages, 1, 'reader can recover after cancellation');
});

test('vendored PDF parser and every explicit asset match exact installed package hashes', () => {
    const manifest = require('../vendor/pdfjs/manifest.json');
    assert.equal(manifest.version, require('../package.json').dependencies['pdfjs-dist']);
    const installed = path.dirname(require.resolve('pdfjs-dist/package.json'));
    for (const asset of manifest.assets) {
        const bytes = fs.readFileSync(path.join(__dirname, '..', asset.path));
        assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), asset.sha256, asset.path);
        assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(installed, asset.source))).digest('hex'), asset.sha256, asset.source);
    }
    assert.ok(manifest.assets.some(asset => asset.path.endsWith('B5pc-H.bcmap')));
    assert.ok(manifest.assets.some(asset => asset.path.endsWith('Adobe-CNS1-UCS2.bcmap')));
    assert.ok(!manifest.assets.some(asset => /sandbox|quickjs|\.map$/.test(asset.path)));
});

test('cloud serves PDF assets with usable MIME types while retaining authentication', async t => {
    const { createCloud, digest } = require('../cloud-server.cjs');
    const password = 'test-only-file-reader-password';
    const server = createCloud({ origin: 'https://file-reader.example.test', passwordHash: digest(password).toString('hex') });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    async function request(asset, authenticated = true) {
        return new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port: server.address().port, path: `/${asset}`, method: 'HEAD', headers: {
                Host: 'file-reader.example.test', 'X-Forwarded-Proto': 'https',
                ...(authenticated ? { Authorization: 'Basic ' + Buffer.from(`roam:${password}`).toString('base64') } : {})
            } }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], nosniff: res.headers['x-content-type-options'] })); });
            req.on('error', reject); req.end();
        });
    }
    for (const [asset, mime] of [['pdf.mjs', 'application/javascript'], ['pdf.worker.mjs', 'application/javascript'], ['cmaps/B5pc-H.bcmap', 'application/octet-stream'], ['wasm/openjpeg.wasm', 'application/wasm'], ['standard_fonts/LiberationSans-Regular.ttf', 'font/ttf']]) {
        const response = await request(`vendor/pdfjs/${asset}`);
        assert.equal(response.status, 200, asset); assert.equal(response.type.split(';')[0], mime); assert.equal(response.nosniff, 'nosniff');
    }
    assert.equal((await request('vendor/pdfjs/pdf.mjs', false)).status, 401);
    assert.equal((await request('node_modules/pdfjs-dist/build/pdf.mjs')).status, 404);
});

module.exports = { pdf };
