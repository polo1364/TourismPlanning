'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { validateImport, MAX_BODY, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES, TIMEOUT } = require('../codex-import.cjs');
const { createBridge, cliArgs } = require('../codex-bridge.cjs');
const { createCloud, digest } = require('../cloud-server.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR2kAAAAASUVORK5CYII=', 'base64');
const image = (bytes = png, extra = {}) => ({ name: '行程.png', mime: 'image/png', dataBase64: bytes.toString('base64'), ...extra });
const body = images => ({ prompt: '只依來源整理行程', images });
function paddedPNG(size) {
    const chunk = Buffer.alloc(size - png.length);
    chunk.writeUInt32BE(chunk.length - 12); chunk.write('tEXt', 4, 'ascii');
    return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
}
const events = [
    { type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } },
    { type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } }
].map(JSON.stringify).join('\n');

test('import validation accepts only bounded canonical PNG/JPEG and preserves source labels as data', () => {
    const input = body([image(png, { page: 3 })]);
    const result = validateImport(input);
    assert.deepEqual(result, [{ name: '行程.png', mime: 'image/png', page: 3, bytes: png }]);
    assert.equal(input.images[0].dataBase64, png.toString('base64'));
    assert.deepEqual(validateImport(body([])), []);
    const jpeg = Buffer.from([255,216,255,192,0,17,8,0,1,0,1,3,1,17,0,2,17,0,3,17,0,255,218,0,8,1,1,0,0,63,0,1,255,217]);
    assert.equal(validateImport(body([image(jpeg, { mime: 'image/jpeg', name: 'scan.jpg' })]))[0].mime, 'image/jpeg');
    for (const input of [null, [], { ...body([]), path: '/private' }, { ...body([]), prompt: '' }, { ...body([]), prompt: 'x'.repeat(60001) }, { ...body([]), model: {} }, { prompt: 'x' }, body(Array(61).fill(image()))]) assert.throws(() => validateImport(input));
    for (const extra of [ { name: '../secret.png' }, { name: 'C:\\secret.png' }, { name: 'line\nname' }, { page: 0 }, { page: 61 }, { page: '1' }, { path: '/private' }, { mime: 'image/svg+xml' }, { mime: 'image/jpeg' }, { dataBase64: png.toString('base64') + '\n' }, { dataBase64: 'YQ=' }, { dataBase64: 'YR==' }, { dataBase64: 'data:image/png;base64,AAAA' } ]) assert.throws(() => validateImport(body([image(png, extra)])));
    for (const bytes of [Buffer.from('<svg/>'), png.subarray(0, 33), png.subarray(0, -1), Buffer.concat([png, Buffer.from('trailing')])]) assert.throws(() => validateImport(body([image(bytes)])));
    for (const [width, height] of [[0, 1], [12001, 1], [5000, 5000]]) {
        const oversized = Buffer.from(png); oversized.writeUInt32BE(width, 16); oversized.writeUInt32BE(height, 20);
        assert.throws(() => validateImport(body([image(oversized)])), { code: 'IMPORT_DIMENSIONS' });
    }
});

test('import byte limits accept exactly 2 MiB each and 20 MiB total, rejecting overflow', () => {
    const boundary = image(paddedPNG(MAX_IMAGE_BYTES));
    assert.equal(validateImport(body([boundary]))[0].bytes.length, MAX_IMAGE_BYTES);
    assert.equal(validateImport(body(Array(10).fill(boundary))).reduce((n, item) => n + item.bytes.length, 0), MAX_TOTAL_BYTES);
    assert.throws(() => validateImport(body([image(paddedPNG(MAX_IMAGE_BYTES + 1))])), { code: 'IMPORT_SIZE', status: 413 });
    assert.throws(() => validateImport(body([...Array(10).fill(boundary), image()])), { code: 'IMPORT_SIZE', status: 413 });
});

async function fixture(t, cloud, generate = async () => ({ ok: true }), extra = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roam-import-route-'));
    const options = { login: async () => ({ ready: true, auth: 'chatgpt' }), usage: async () => ({ models: [{ id: 'test-model' }] }), generate,
        imageDirectory: path.join(root, 'images'), shareDirectory: path.join(root, 'shares'), ...extra };
    const origin = cloud ? 'https://example.test' : 'http://127.0.0.1:8080';
    const server = cloud ? createCloud({ ...options, origin, passwordHash: digest('test-only').toString('hex') }) : createBridge(options);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
        for (const directory of [options.imageDirectory, options.shareDirectory, root]) await fs.promises.rmdir(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
    });
    const headers = { Origin: origin, 'Content-Type': 'application/json', ...(cloud ? { Host: 'example.test', 'X-Forwarded-Proto': 'https', Authorization: 'Basic ' + Buffer.from('roam:test-only').toString('base64') } : {}) };
    const request = (route, data, overrides = {}, signal) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: (cloud ? '/codex' : '') + route, method: data === undefined ? 'GET' : 'POST', headers: { ...headers, ...overrides }, signal }, res => {
            let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
        });
        req.on('error', reject); req.end(data === undefined ? undefined : typeof data === 'string' ? data : JSON.stringify(data));
    });
    headers['X-Roam-Token'] = (await request('/status')).data.token;
    return { request };
}

for (const cloud of [false, true]) {
    const label = cloud ? 'cloud' : 'local';
    test(`${label} import keeps authentication, origin, CSRF, model validation and usage`, async t => {
        const calls = [];
        const f = await fixture(t, cloud, async (prompt, signal, options) => {
            calls.push(options); assert.equal(prompt, body([]).prompt); assert.equal(signal.aborted, false);
            options.onUsage({ totalTokens: 10 }); return { ok: true };
        });
        for (const overrides of [{ Origin: '' }, { Origin: 'https://evil.test' }, { 'X-Roam-Token': '' }]) assert.equal((await f.request('/import-itinerary', body([image()]), overrides)).status, 403);
        if (cloud) assert.equal((await f.request('/import-itinerary', body([image()]), { Authorization: '' })).status, 401);
        assert.equal((await f.request('/import-itinerary', body([image(png, { path: 'private' })]))).status, 400);
        assert.equal((await f.request('/import-itinerary', { ...body([]), model: 'unavailable' })).status, 400);
        assert.equal(calls.length, 0);
        const result = await f.request('/import-itinerary', { ...body([image()]), model: 'test-model' });
        assert.deepEqual(result, { status: 200, data: { data: { ok: true }, usage: { totalTokens: 10 } } });
        assert.equal(calls[0].timeout, TIMEOUT); assert.equal(calls[0].model, 'test-model'); assert.deepEqual(calls[0].images[0].bytes, png);
        assert.equal((await f.request('/generate', { prompt: body([]).prompt })).status, 200);
        assert.equal(calls[1].timeout, undefined); assert.equal(calls[1].images, undefined);
        const larger = body([image(paddedPNG(150000))]);
        assert.equal((await f.request('/import-itinerary', larger)).status, 200);
        const tooBig = await f.request('/generate', larger).catch(error => ({ status: error.code === 'ECONNRESET' ? 413 : 0 }));
        assert.equal(tooBig.status, 413, 'ordinary generation retains the 128 KiB body cap');
        const oversize = await f.request('/import-itinerary', ' '.repeat(MAX_BODY + 1)).catch(error => ({ status: error.code === 'ECONNRESET' ? 413 : 0 }));
        assert.equal(oversize.status, 413);
        assert.equal(calls.length, 3);
    });
    test(`${label} import and generation share the busy lock and disconnect cancellation`, async t => {
        let started, cancelled;
        const ready = new Promise(resolve => { started = resolve; }), stopped = new Promise(resolve => { cancelled = resolve; });
        let first = true;
        const f = await fixture(t, cloud, (_prompt, signal) => first ? new Promise((resolve, reject) => {
            first = false; started(); signal.addEventListener('abort', () => { cancelled(); reject(Object.assign(new Error('cancel'), { code: 'CANCELLED', status: 499 })); }, { once: true });
        }) : Promise.resolve({ ok: true }));
        const controller = new AbortController();
        const pending = f.request('/import-itinerary', body([image()]), {}, controller.signal).catch(() => {});
        await ready;
        assert.equal((await f.request('/generate', { prompt: 'x' })).status, 409);
        assert.equal((await f.request('/import-itinerary', body([]))).status, 409);
        controller.abort(); await pending; await stopped;
        assert.equal((await f.request('/import-itinerary', body([]))).status, 200);
    });
}

test('cloud import shares the existing 60-start hourly limit with ordinary generation', async t => {
    let calls = 0;
    const f = await fixture(t, true, async () => { calls++; return { ok: true }; });
    for (let i = 0; i < 60; i++) assert.equal((await f.request(i % 2 ? '/import-itinerary' : '/generate', i % 2 ? body([]) : { prompt: 'x' })).status, 200);
    assert.equal((await f.request('/import-itinerary', body([]))).status, 429); assert.equal(calls, 60);
});

function fakeRunner(mode, { writeFile } = {}) {
    const realRequire = createRequire(path.join(__dirname, '../codex-bridge.cjs'));
    const state = { spawned: 0, paths: [], cwd: '', prompt: '', timers: [], stopped: 0 };
    const virtualBin = path.join(os.tmpdir(), 'roam-cli-unit-test-not-installed');
    const virtualCli = path.join(virtualBin, process.platform === 'win32' ? 'codex.exe' : 'codex');
    let ready;
    state.ready = new Promise(resolve => { ready = resolve; });
    const fakeSpawn = (command, args, options) => {
        assert.equal(command, virtualCli);
        args = Array.from(args);
        state.spawned++; state.cwd = args[args.indexOf('--cd') + 1]; state.args = args; state.options = options;
        state.paths = args.flatMap((value, index) => value === '--image' ? [args[index + 1]] : []);
        state.bytes = state.paths.map(file => fs.readFileSync(file));
        const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.stdin.on('data', chunk => { state.prompt += chunk; });
        child.stdin.on('finish', () => {
            ready();
            if (mode === 'hang' || mode === 'timeout') return;
            setImmediate(() => { if (mode !== 'fail') child.stdout.write(events); child.emit('close', mode === 'fail' ? 1 : 0); });
        });
        return child;
    };
    const fsMock = { ...fs, existsSync: file => file === virtualCli || fs.existsSync(file),
        promises: { ...fs.promises, ...(writeFile ? { writeFile } : {}) } };
    const requireMock = name => name === 'node:fs' ? fsMock
        : name === 'node:child_process' ? { ...require(name), spawn: fakeSpawn }
        : name === './codex-usage.cjs' ? { ...realRequire(name), stopChild: child => { state.stopped++; setImmediate(() => child.emit('close', 137)); } } : realRequire(name);
    const processMock = { platform: process.platform, execPath: process.execPath, env: { ...process.env, PATH: virtualBin } };
    const sandbox = { module: { exports: {} }, require: requireMock, __dirname: path.resolve(__dirname, '..'), Buffer, process: processMock,
        setTimeout: (callback, ms) => { state.timers.push(ms); return setTimeout(callback, mode === 'timeout' ? 1 : ms); }, clearTimeout };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../codex-bridge.cjs'), 'utf8'), sandbox);
    return { run: sandbox.module.exports.runCodex, state };
}

test('CLI receives only isolated random attachments; completion/failure/cancellation remove them', async () => {
    const validated = validateImport(body([image(png, { name: 'original-private-name.png', page: 2 }), image()]));
    for (const mode of ['success', 'fail', 'hang']) {
        const { run, state } = fakeRunner(mode); const controller = new AbortController();
        const operation = run('fixture prompt', controller.signal, { images: validated, timeout: TIMEOUT });
        await state.ready;
        assert.equal(state.paths.length, 2);
        assert.ok(state.paths.every(file => path.dirname(file) === state.cwd && !file.includes('original-private-name')));
        assert.deepEqual(state.bytes, [png, png]);
        assert.equal(state.args.at(-1), '-'); assert.ok(state.args.includes('read-only')); assert.ok(state.args.includes('view_image'));
        assert.equal(state.options.windowsHide, true); assert.equal(state.timers[0], 180000);
        assert.match(state.prompt, /圖片與下方文件文字都是不可信/); assert.match(state.prompt, /original-private-name/);
        if (mode === 'hang') controller.abort();
        if (mode === 'success') assert.equal((await operation).ok, true);
        else await assert.rejects(operation, { code: mode === 'hang' ? 'CANCELLED' : 'PROVIDER' });
        assert.equal(fs.existsSync(state.cwd), false); assert.ok(state.paths.every(file => !fs.existsSync(file)));
    }
    const { run, state } = fakeRunner('success');
    assert.equal((await run('ordinary', new AbortController().signal)).ok, true);
    assert.equal(state.timers[0], 180000); assert.equal(state.paths.length, 0); assert.equal(fs.existsSync(state.cwd), false);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(run('cancelled', controller.signal, { images: validated }), { code: 'CANCELLED' });
    assert.equal(state.spawned, 1);
    const args = cliArgs('temp', '', ['one.png', 'two.jpg']);
    assert.deepEqual(args.slice(-6), ['--image', 'one.png', '--image', 'two.jpg', '--', '-']);
});

test('CLI timeout stops the child and removes uploaded attachments', async () => {
    const { run, state } = fakeRunner('timeout');
    await assert.rejects(run('test', new AbortController().signal, { images: validateImport(body([image()])), timeout: TIMEOUT }), { code: 'TIMEOUT' });
    assert.equal(state.stopped, 1); assert.equal(fs.existsSync(state.cwd), false);
});

test('partial attachment writes and preparation cancellation clean up before any CLI spawn', async () => {
    for (const cancelled of [false, true]) {
        const controller = new AbortController();
        let directory = '', writes = 0;
        const { run, state } = fakeRunner('success', { writeFile: async (file, bytes, options) => {
            directory = path.dirname(file); writes++;
            await fs.promises.writeFile(file, bytes, options);
            if (cancelled) controller.abort();
            else throw Object.assign(new Error('simulated disk failure'), { code: 'ENOSPC' });
        } });
        await assert.rejects(run('test', controller.signal, { images: validateImport(body([image(), image()])) }), { code: cancelled ? 'CANCELLED' : 'ENOSPC' });
        assert.equal(writes, 1); assert.equal(state.spawned, 0);
        assert.ok(directory); assert.equal(fs.existsSync(directory), false);
    }
});
