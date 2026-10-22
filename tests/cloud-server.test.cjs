const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCloud, digest } = require('../cloud-server.cjs');
const origin = 'https://travel.example.test';
const password = 'only-a-fixed-test-value-not-a-real-password';
const auth = 'Basic ' + Buffer.from('roam:' + password).toString('base64');

async function fixture(t, options = {}) {
    let calls = 0;
    const shareDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'roam-share-test-'));
    t.after(() => fs.rmSync(shareDirectory, { recursive: true, force: true }));
    const server = createCloud({ origin, passwordHash: digest(password).toString('hex'), shareDirectory, login: async () => ({ ready: true, auth: 'chatgpt' }), generate: async () => { calls++; return { ok: true }; }, ...options });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const request = (url = '/', { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method, headers: { Host: 'travel.example.test', 'X-Forwarded-Proto': 'https', Authorization: auth, ...headers } }, res => {
            let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
        });
        req.on('error', reject); req.end(body);
    });
    const token = (await request('/codex/status')).json().token;
    const post = (body = { prompt: '台北一天' }, headers = {}) => request('/codex/generate', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Roam-Token': token, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { request, post, server, token, shareDirectory, calls: () => calls };
}

const shareBody = { title: '台北旅行', html: '<!doctype html><html data-roam-book="1"><h1>分享測試</h1></html>' };
test('shares persist across restart, allow anonymous reading, and revoke idempotently', async t => {
    const first = await fixture(t);
    const headers = { Origin: origin, 'X-Roam-Token': first.token, 'Content-Type': 'application/json' };
    const created = await first.request('/api/shares', { method: 'POST', headers, body: JSON.stringify(shareBody) });
    assert.equal(created.status, 201);
    const { id, url } = created.json();
    assert.match(id, /^[a-f0-9]{48}$/); assert.equal(url, `${origin}/s/${id}`);
    const second = await fixture(t, { shareDirectory: first.shareDirectory });
    const list = (await second.request('/api/shares')).json();
    assert.equal(list.shares.length, 1); assert.equal(list.shares[0].id, id); assert.equal(list.shares[0].html, undefined);
    const publicBook = await second.request(`/s/${id}`, { headers: { Authorization: '' } });
    assert.equal(publicBook.status, 200); assert.equal(publicBook.text, shareBody.html);
    assert.equal(publicBook.headers['cache-control'], 'no-store'); assert.equal(publicBook.headers['referrer-policy'], 'no-referrer');
    assert.match(publicBook.headers['content-security-policy'], /sandbox allow-scripts/);
    assert.doesNotMatch(publicBook.headers['content-security-policy'], /allow-same-origin/);
    assert.match(publicBook.headers['x-robots-tag'], /noindex/);
    assert.equal((await second.request(`/s/${id}`, { method: 'HEAD', headers: { Authorization: '' } })).text, '');
    for (let i = 0; i < 2; i++) assert.equal((await second.request(`/api/shares/${id}`, { method: 'DELETE', headers: { Origin: origin, 'X-Roam-Token': second.token } })).status, 200);
    const gone = await second.request(`/s/${id}`, { headers: { Authorization: '' } });
    assert.equal(gone.status, 404); assert.match(gone.text, /取消分享/); assert.equal(gone.headers['www-authenticate'], undefined);
    assert.equal((await second.request('/api/shares')).json().shares.length, 0);
    assert.equal(first.calls() + second.calls(), 0);
});

test('share management keeps authentication, origin and CSRF protection', async t => {
    const { request, token } = await fixture(t);
    const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Roam-Token': token };
    for (const method of ['GET', 'POST', 'DELETE']) {
        const url = method === 'DELETE' ? '/api/shares/' + 'a'.repeat(48) : '/api/shares';
        assert.equal((await request(url, { method, headers: { ...headers, Authorization: '' }, body: method === 'POST' ? JSON.stringify(shareBody) : undefined })).status, 401);
    }
    for (const overrides of [{ Origin: '' }, { Origin: 'https://evil.test' }, { Origin: 'null' }, { 'X-Roam-Token': 'wrong' }]) {
        assert.equal((await request('/api/shares', { method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(shareBody) })).status, 403);
        assert.equal((await request('/api/shares/' + 'a'.repeat(48), { method: 'DELETE', headers: { ...headers, ...overrides } })).status, 403);
    }
    for (const url of ['/s/../cloud-server.cjs', '/s/%2e%2e/cloud-server.cjs', '/s/', '/s/' + 'a'.repeat(48) + '.json']) {
        assert.equal((await request(url, { headers: { Authorization: '' } })).status, 404);
    }
    assert.equal((await request('/book-shares.cjs')).status, 404);
    assert.equal((await request('/.roam-shares/a.json')).status, 404);
});

test('share creation validates content, bounds storage, and limits request starts', async t => {
    const { request, token } = await fixture(t);
    const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Roam-Token': token };
    const post = body => request('/api/shares', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
    assert.equal((await post('{')).status, 400);
    assert.equal((await post({ ...shareBody, title: '' })).status, 400);
    assert.equal((await post({ ...shareBody, html: 'invalid' })).status, 400);
    assert.equal((await post({ ...shareBody, html: shareBody.html + 'x'.repeat(5 * 1024 * 1024) })).status, 413);
    for (let i = 4; i < 30; i++) assert.equal((await post(shareBody)).status, 201);
    assert.equal((await post(shareBody)).status, 429);
    const { createShareStore } = require('../book-shares.cjs');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roam-share-cap-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const store = createShareStore(directory);
    const results = await Promise.allSettled(Array.from({ length: 51 }, () => store.create(shareBody)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 50);
    assert.equal(results.at(-1).reason.status, 409);
    assert.equal((await store.list()).length, 50);
});

test('cloud refuses insecure configuration', () => {
    assert.throws(() => createCloud({ origin: 'http://example.test', passwordHash: 'a'.repeat(64) }));
    assert.throws(() => createCloud({ origin, passwordHash: '' }));
});

test('every cloud asset and API requires authentication; failures are throttled', async t => {
    const { request, calls } = await fixture(t);
    for (const route of ['/', '/codex/status', '/cloud-config.js', '/assets/roam-coast.png']) {
        assert.equal((await request(route, { headers: { Authorization: '' } })).status, 401);
    }
    for (let i = 0; i < 6; i++) await request('/', { headers: { Authorization: '' } });
    assert.equal((await request()).status, 429);
    assert.equal(calls(), 0);
});

test('cloud rejects wrong host, plaintext proxy and foreign origin', async t => {
    const { request, post, calls } = await fixture(t);
    assert.equal((await request('/', { headers: { Host: 'evil.test' } })).status, 403);
    assert.equal((await request('/', { headers: { 'X-Forwarded-Proto': 'http' } })).status, 403);
    assert.equal((await post(undefined, { Origin: 'https://evil.test' })).status, 403);
    assert.equal((await post(undefined, { Origin: '' })).status, 403);
    assert.equal((await post(undefined, { 'X-Roam-Token': 'wrong' })).status, 403);
    assert.equal(calls(), 0);
});

test('cloud serves only frontend files and injects a same-origin mode flag', async t => {
    const { request } = await fixture(t);
    assert.match((await request()).text, /<script src="\/cloud-config.js"><\/script><\/head>/);
    assert.equal((await request('/cloud-config.js')).text, 'window.ROAM_CLOUD = true;');
    for (const file of ['/cloud-server.cjs', '/codex-bridge.cjs', '/auth.json', '/.env', '/../README.md', '/%2e%2e/auth.json', '/scripts/login-oracle-codex.ps1']) assert.equal((await request(file)).status, 404, file);
});

test('OCR worker, core and language assets are same-origin authenticated static files', async t => {
    const { request, calls } = await fixture(t);
    const assets = require('../vendor/tesseract/manifest.json').assets;
    const paths = ['itinerary-image.js', ...['worker.min.js', '.wasm', 'chi_tra.traineddata.gz', 'eng.traineddata.gz'].map(suffix => {
        const asset = assets.find(item => item.path.endsWith(suffix));
        assert.ok(asset, `Missing OCR asset ${suffix}`);
        return asset.path;
    })];
    for (const file of paths) {
        assert.equal((await request('/' + file, { headers: { Authorization: '' } })).status, 401);
        const response = await request('/' + file);
        assert.equal(response.status, 200, file);
        assert.equal(response.headers['x-content-type-options'], 'nosniff');
        assert.equal(response.headers['content-encoding'], undefined, 'compressed language files must reach the OCR decoder unchanged');
        if (file.endsWith('.js')) assert.match(response.headers['content-type'], /javascript/);
        if (file.endsWith('.wasm')) assert.equal(response.headers['content-type'], 'application/wasm');
    }
    assert.equal((await request('/vendor/tesseract/not-in-manifest.js')).status, 404);
    assert.equal(calls(), 0);
});

test('cloud validates bodies before generating and returns JSON', async t => {
    const { post, calls } = await fixture(t);
    assert.equal((await post('{')).status, 400);
    assert.equal((await post({ prompt: '' })).status, 400);
    assert.equal((await post({ prompt: 'a'.repeat(60001) })).status, 400);
    assert.equal((await post({ prompt: 'a'.repeat(140000) })).status, 413);
    assert.equal((await post(undefined, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal(calls(), 0);
    const result = await post();
    assert.equal(result.status, 200); assert.equal(result.json().data.ok, true); assert.equal(calls(), 1);
});

test('cloud serializes generation and releases slot after a failure', async t => {
    let rejectGeneration;
    let started;
    const began = new Promise(resolve => started = resolve);
    const { post } = await fixture(t, { generate: () => new Promise((resolve, reject) => { rejectGeneration = reject; started(); }) });
    const first = post(); await began;
    assert.equal((await post()).status, 409);
    rejectGeneration(new Error('private diagnostic should never appear'));
    const result = await first;
    assert.equal(result.status, 500); assert.doesNotMatch(result.text, /private diagnostic/);
    assert.equal((await post({ prompt: '' })).status, 400);
});

test('cloud limits generation starts per hour', async t => {
    const { post, calls } = await fixture(t);
    for (let i = 0; i < 60; i++) assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 429); assert.equal(calls(), 60);
});

test('disconnecting a cloud generation aborts the worker and frees the slot', async t => {
    let started, aborted;
    const began = new Promise(resolve => started = resolve);
    const stopped = new Promise(resolve => aborted = resolve);
    const { server, token, post } = await fixture(t, { generate: (prompt, signal) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { aborted(); reject(new Error('cancelled')); }, { once: true }); started();
    }) });
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/codex/generate', method: 'POST', headers: { Host: 'travel.example.test', 'X-Forwarded-Proto': 'https', Authorization: auth, Origin: origin, 'Content-Type': 'application/json', 'X-Roam-Token': token } });
    req.on('error', () => {}); req.end(JSON.stringify({ prompt: 'cancel me' }));
    await began; req.destroy(); await stopped;
    assert.equal((await post({ prompt: '' })).status, 400);
});

test('cloud frontend probes same-origin endpoint and preserves selected provider', async () => {
    const vm = require('node:vm');
    const fs = require('node:fs');
    const path = require('node:path');
    for (const saved of [null, 'deepseek']) {
        const elements = Object.fromEntries(['aiProvider', 'deepseekSettings', 'codexSettings', 'codexStatus', 'hostedNotice', 'codexHelp'].map(id => [id, { value: id === 'aiProvider' ? 'deepseek' : '', querySelector: () => ({}), hidden: true }]));
        const urls = [];
        const context = vm.createContext({ location: { protocol: 'https:', hostname: 'travel.example.test' }, document: { getElementById: id => elements[id] }, window: { ROAM_CLOUD: true }, localStorage: { getItem: key => key === 'aiProvider' ? saved : null }, updateApiStatus() {}, isBusy: false, AbortSignal,
            fetch: async url => { urls.push(url); return { ok: true, json: async () => ({ ready: true, auth: 'chatgpt', token: 'mock', data: { ok: true } }) }; } });
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../codex-local.js'), 'utf8'), context);
        await context.window.CodexLocal.init();
        assert.equal(elements.aiProvider.value, saved || 'codex');
        assert.equal(elements.hostedNotice.hidden, true);
        await context.window.CodexLocal.generate('test');
        assert.deepEqual(urls, ['/codex/status', '/codex/generate']);
    }
});
