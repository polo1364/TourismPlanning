'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const Reader = require('../itinerary-file.js');

function file(name, content, overrides = {}) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    return { name, size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer, ...overrides };
}
// A complete PDF with xref offsets, ordinary page objects and text streams.
// Tests exercise the actual vendored parser, not a mock that merely returns text.
function pdf(linesByPage = [['Day 1 Taipei', '09:00 Breakfast']], encrypted = false, traditionalChinese = false) {
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        `<< /Type /Pages /Kids [${linesByPage.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${linesByPage.length} >>`,
        traditionalChinese
            ? `<< /Type /Font /Subtype /Type0 /BaseFont /MSung-Light /Encoding /UniCNS-UCS2-H /DescendantFonts [${4 + linesByPage.length * 2} 0 R] >>`
            : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    ];
    for (let i = 0; i < linesByPage.length; i++) {
        const content = linesByPage[i].map((line, n) => {
            const literal = traditionalChinese ? `<${Buffer.from(line, 'utf16le').swap16().toString('hex')}>` : `(${line.replace(/[\\()]/g, '\\$&')})`;
            return `BT /F1 12 Tf 1 0 0 1 50 ${750 - n * 20} Tm ${literal} Tj ET`;
        }).join('\n');
        const width = Math.max(595, ...linesByPage[i].map(line => line.length * 10 + 100));
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
        objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    }
    if (traditionalChinese) objects.push('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /MSung-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (CNS1) /Supplement 0 >> /DW 1000 >>');
    if (encrypted) objects.push(`<< /Filter /Standard /V 1 /R 2 /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> /P -4 >>`);
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

test('PDF without text requests OCR, and mixed blank pages identify the missing pages', async () => {
    await assert.rejects(Reader.read(file('scan.pdf', pdf([[], []]))), { code: 'PDF_NO_TEXT' });
    const result = await Reader.read(file('mixed.pdf', pdf([['Day 1'], [], ['Day 3']])));
    assert.equal(result.text, 'Day 1\n\nDay 3'); assert.match(result.warnings.join('\n'), /第 2 頁/);
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
    assert.equal((await Reader.read(file('limit-blank.pdf', pdf([['a'.repeat(Reader.MAX_CHARACTERS)], [' ']])))).text.length, Reader.MAX_CHARACTERS);
    await assert.rejects(Reader.read(file('long.pdf', pdf([['a'.repeat(Reader.MAX_CHARACTERS + 1)]]))), { code: 'TEXT_LIMIT' });
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
