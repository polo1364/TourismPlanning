'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createOpenAI } = require('../openai-api.cjs');
const { createCloud, digest } = require('../cloud-server.cjs');
const key = 'sk-testing-only-not-a-real-api-key';
const ok = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const completed = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"days":[]}' }] }], usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20, input_tokens_details: { cached_tokens: 3 } } };
const supported = ['gpt-6-sol', 'gpt-5.3-codex', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6-astra'];
async function fixture(t, response = () => ok(completed), available = ['gpt-6-sol', 'gpt-image-1.5', 'unrecognized']) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-api-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'openai.json');
    const calls = [];
    const api = createOpenAI({ file, fetcher: async (url, options) => {
        calls.push({ url, options });
        assert.equal(options.headers.Authorization, 'Bearer ' + key);
        assert.equal(options.redirect, 'error');
        return url.endsWith('/models') ? ok({ data: available.map(id => ({ id })) }) : response(url, options);
    } });
    return { api, file, directory, calls };
}
test('API key validation persists only on server and does not generate billable content', async t => {
    const { api, file, calls } = await fixture(t);
    assert.equal((await api.login()).auth, 'api');
    await api.save({ apiKey: key });
    assert.deepEqual(await api.login(), { auth: 'api', ready: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.openai.com/v1/models');
    const info = await api.usage();
    assert.equal(info.billing, 'api'); assert.equal(info.available, false); assert.deepEqual(info.limits, []);
    assert.deepEqual(info.models.map(m => m.id), ['gpt-6-sol']);
    assert.ok(!JSON.stringify(info).includes(key));
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).apiKey, key);
    if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await createOpenAI({ file }).login()).ready, true);
    await assert.rejects(api.save({ apiKey: key, baseURL: 'https://elsewhere.example' }), /有效/);
});

test('server and browser support the same expanded model list with exact selected IDs', async t => {
    const { api, calls } = await fixture(t, undefined, [...supported].reverse().concat(['gpt-image-1.5', 'gpt-realtime', 'text-embedding-3-small', 'unknown']));
    await api.save({ apiKey: key });
    const models = (await api.usage()).models;
    assert.deepEqual(models.map(m => m.id), supported);
    assert.equal(models.filter(m => m.isDefault).length, 1);
    for (const model of supported) {
        await api.generate('JSON itinerary', undefined, { model });
        assert.equal(JSON.parse(calls.at(-1).options.body).model, model);
    }
});
test('all imported images retain source order, JSON completion and real token usage', async t => {
    const { api, calls } = await fixture(t);
    await api.save({ apiKey: key });
    let usage;
    const images = Array.from({ length: 60 }, (_, i) => ({ name: `scan-${i}.pdf`, page: i + 1, mime: 'image/png', bytes: Buffer.from('fixture-' + i) }));
    const result = await api.generate('原始資料與手動補充', new AbortController().signal, { images, onUsage: u => { usage = u; } });
    assert.deepEqual(result, { days: [] });
    assert.deepEqual(usage, { inputTokens: 12, outputTokens: 8, totalTokens: 20, cachedInputTokens: 3 });
    const request = JSON.parse(calls.at(-1).options.body);
    assert.equal(calls.at(-1).url, 'https://api.openai.com/v1/responses');
    assert.equal(request.store, false); assert.equal(request.tools, undefined);
    assert.equal(request.input[0].content.length, 121);
    images.forEach((image, i) => {
        assert.equal(request.input[0].content[i * 2 + 1].text, JSON.stringify({ source: image.name, page: i + 1 }));
        assert.equal(request.input[0].content[i * 2 + 2].image_url, `data:image/png;base64,${image.bytes.toString('base64')}`);
    });
});
test('incomplete, refused and invalid API output cannot become a saved itinerary', async t => {
    for (const result of [{ ...completed, status: 'incomplete' }, { ...completed, output: [{ type: 'message', content: [{ type: 'refusal' }] }] }, { ...completed, output: [] }]) {
        const { api } = await fixture(t, () => ok(result));
        await api.save({ apiKey: key });
        await assert.rejects(api.generate('JSON', new AbortController().signal), /未完整|無法處理|有效 JSON/);
    }
});
test('provider errors never leak raw errors, keys or retry a billable request', async t => {
    const { api, calls } = await fixture(t, () => new Response(JSON.stringify({ error: { message: key } }), { status: 429 }));
    await api.save({ apiKey: key });
    await assert.rejects(api.generate('JSON', new AbortController().signal), error => error.status === 429 && !error.message.includes(key));
    assert.equal(calls.filter(c => c.url.endsWith('/responses')).length, 1);
    await assert.rejects(api.generate('JSON', new AbortController().signal, { model: 'unrecognized' }), /選擇/);
});
test('cancellation stops request and never falls back to CLI or retries', async t => {
    const { api, calls } = await fixture(t, (_, options) => new Promise((resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    await api.save({ apiKey: key });
    const controller = new AbortController();
    const task = api.generate('JSON', controller.signal);
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(task, error => error.code === 'CANCELLED');
    assert.equal(calls.filter(c => c.url.endsWith('/responses')).length, 1);
});
test('illustrations also use API billing and return validated image bytes', async t => {
    const bytes = Buffer.from([137,80,78,71,13,10,26,10,0]);
    const { api, calls } = await fixture(t, () => ok({ data: [{ b64_json: bytes.toString('base64') }] }));
    await api.save({ apiKey: key });
    assert.deepEqual((await api.imageGenerate({ city: '台北' }, new AbortController().signal)).bytes, bytes);
    assert.equal(calls.at(-1).url, 'https://api.openai.com/v1/images/generations');
    assert.equal(JSON.parse(calls.at(-1).options.body).model, 'gpt-image-1.5');
});
test('private settings retain password, origin, token and input size protection', async t => {
    const { api, directory, file } = await fixture(t);
    const origin = 'https://travel.example.test';
    const auth = 'Basic ' + Buffer.from('roam:test-password').toString('base64');
    const server = createCloud({ api, origin, passwordHash: digest('test-password').toString('hex'), shareDirectory: path.join(directory, 'shares'), imageDirectory: path.join(directory, 'images') });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const request = (route, options = {}) => new Promise((resolve, reject) => {
        const req = require('node:http').request({ hostname: '127.0.0.1', port: server.address().port, path: route, method: options.method || 'GET', headers: { Host: 'travel.example.test', 'X-Forwarded-Proto': 'https', Authorization: auth, ...options.headers } }, res => {
            const chunks = []; res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })));
        });
        req.on('error', reject); req.end(options.body);
    });
    const status = await (await request('/codex/status')).json();
    assert.equal(status.auth, 'api');
    const headers = { Origin: origin, 'X-Roam-Token': status.token, 'Content-Type': 'application/json' };
    const options = { method: 'POST', headers, body: JSON.stringify({ apiKey: key }) };
    assert.equal((await request('/codex/settings', { ...options, headers: { ...headers, Authorization: '' } })).status, 401);
    assert.equal((await request('/codex/settings', { ...options, headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request('/codex/settings', { ...options, headers: { ...headers, 'X-Roam-Token': '' } })).status, 403);
    assert.equal((await request('/codex/settings', { ...options, body: 'x'.repeat(2049) })).status, 413);
    const saved = await request('/codex/settings', options);
    assert.equal(saved.status, 200); assert.ok(!(await saved.text()).includes(key));
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).apiKey, key);
    assert.equal((await request('/openai.json')).status, 404);
});
