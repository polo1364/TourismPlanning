const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { tokenUsage, normalizeLimits, normalizeModels, createUsageReader, readLimits } = require('../codex-usage.cjs');
const { createBridge, cliArgs, validateModel } = require('../codex-bridge.cjs');
const { createCloud, digest } = require('../cloud-server.cjs');
const http = require('node:http');
const example = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, totalTokens: 120 };

test('tokens include cached input once, and missing/invalid usage stays unknown', () => {
    assert.deepEqual(tokenUsage(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 40 } })), example);
    for (const usage of [null, {}, { input_tokens: -1, output_tokens: 20 }, { input_tokens: '100', output_tokens: 20 }]) {
        assert.equal(tokenUsage(JSON.stringify({ type: 'turn.completed', usage })), null);
    }
    assert.equal(tokenUsage('partial {'), null);
});
test('quota uses multi-bucket data, clamps remaining and never coerces null to zero', () => {
    const result = normalizeLimits({ rateLimits: { primary: { usedPercent: 1 } }, rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 103, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: null }, secret: 'private' },
        other: { primary: { usedPercent: 0 } }
    }});
    assert.equal(result.limits.length, 2);
    assert.equal(result.limits[0].windows.length, 1);
    assert.equal(result.limits[0].windows[0].remainingPercent, 0);
    assert.equal(result.limits[1].windows[0].remainingPercent, 100);
    assert.equal(result.limits[1].windows[0].resetsAt, null);
    assert.doesNotMatch(JSON.stringify(result), /private/);
    assert.equal(normalizeLimits({}).available, false);
});
test('only visible model API identifiers enter the allowlist', async () => {
    const models = normalizeModels({ data: [{ id: 'picker', model: 'test-model', displayName: 'Test', isDefault: true }, { id: 'hidden', hidden: true }, { id: '--bad option' }] });
    assert.deepEqual(models, [{ id: 'test-model', name: 'Test', isDefault: true }]);
    assert.equal(await validateModel('test-model', async () => ({ models })), 'test-model');
    await assert.rejects(validateModel('injected', async () => ({ models })), { code: 'MODEL', status: 400 });
    await assert.rejects(validateModel('test-model', async () => ({ models: [] })), { status: 503 });
    assert.equal(await validateModel('', () => { throw new Error('must not query'); }), '');
    const args = cliArgs('/tmp/test', 'test-model');
    assert.equal(args[args.indexOf('--model') + 1], 'test-model');
});
test('quota cache shares in-flight reads and caches failures without stale percentages', async () => {
    let now = 100, calls = 0, reject = false;
    const read = createUsageReader(async () => { calls++; if (reject) throw new Error('secret'); return { available: true }; }, { now: () => now, ttl: 30 });
    await Promise.all([read(), read(), read()]); assert.equal(calls, 1);
    now = 131; reject = true;
    assert.equal((await read()).available, false);
    assert.deepEqual((await read()).limits, []); assert.equal(calls, 2);
});
test('app-server handshake only performs two reads; handles split frames and errors', async () => {
    const methods = [];
    const launch = () => {
        const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.stdin.on('data', chunk => {
            const request = JSON.parse(chunk); methods.push(request.method);
            let response;
            if (request.id === 1) response = { id: 1, result: { userAgent: 'fixture' } };
            if (request.id === 2) response = { id: 2, error: { message: 'private provider diagnostics' } };
            if (request.id === 3) response = { id: 3, result: { data: [{ id: 'model-fixture' }] } };
            if (response) setImmediate(() => { const line = JSON.stringify(response) + '\n'; child.stdout.write(line.slice(0, 5)); child.stdout.write(line.slice(5)); });
        }); return child;
    };
    const result = await readLimits({ command: 'fake', prefix: [] }, {}, { launch });
    assert.equal(result.available, false); assert.equal(result.models[0].id, 'model-fixture');
    assert.deepEqual(methods, ['initialize', 'initialized', 'account/rateLimits/read', 'model/list']);
    assert.doesNotMatch(JSON.stringify(result), /private/);
});
test('app-server exit or timeout fails safely', async () => {
    for (const earlyExit of [true, false]) {
        const launch = () => {
            const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
            if (earlyExit) setImmediate(() => child.emit('close', 1));
            return child;
        };
        await assert.rejects(readLimits({ command: 'fake', prefix: [] }, {}, { launch, timeout: 15 }), /unavailable/);
    }
});
for (const cloud of [false, true]) test(`${cloud ? 'cloud' : 'local'} quota auth and generation model/usage contract`, async t => {
    let reads = 0, calls = 0, shouldFail = false;
    const options = { login: async () => ({ ready: true, auth: 'chatgpt' }), usage: async () => { reads++; return { available: true, models: [{ id: 'fixture-model' }], limits: [] }; },
        generate: async (_prompt, _signal, { model, onUsage }) => { calls++; assert.equal(model, 'fixture-model'); onUsage(example); if (shouldFail) throw Object.assign(new Error('invalid JSON'), { code: 'JSON', status: 502 }); return { ok: true }; } };
    const server = cloud ? createCloud({ ...options, origin: 'https://example.test', passwordHash: digest('fixture-password').toString('hex') }) : createBridge(options);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const headers = cloud ? { Host: 'example.test', Origin: 'https://example.test', 'X-Forwarded-Proto': 'https', Authorization: 'Basic ' + Buffer.from('roam:fixture-password').toString('base64') } : { Origin: 'http://127.0.0.1:8080' };
    const request = (route, extra = {}, body) => new Promise(resolve => {
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: (cloud ? '/codex' : '') + route, method: body ? 'POST' : 'GET', headers: { ...headers, ...extra } }, res => {
            let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
        }); req.end(body ? JSON.stringify(body) : undefined);
    });
    assert.equal((await request('/usage')).status, 403); assert.equal(reads, 0);
    const token = (await request('/status')).data.token;
    const authorized = { 'X-Roam-Token': token, 'Content-Type': 'application/json' };
    assert.equal((await request('/usage', authorized)).status, 200);
    assert.equal((await request('/usage', { ...authorized, Origin: 'https://evil.test' })).status, 403);
    if (cloud) assert.equal((await request('/usage', { ...authorized, Authorization: '' })).status, 401);
    assert.equal((await request('/generate', authorized, { prompt: 'test', model: 'bad-model' })).status, 400); assert.equal(calls, 0);
    const result = await request('/generate', authorized, { prompt: 'test', model: 'fixture-model' });
    assert.deepEqual(result.data, { data: { ok: true }, usage: example });
    shouldFail = true;
    const failure = await request('/generate', authorized, { prompt: 'test', model: 'fixture-model' });
    assert.equal(failure.status, 502); assert.deepEqual(failure.data.usage, example);
});
