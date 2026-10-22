const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function client({ cloud = true, local = false, respond } = {}) {
    const requests = [], timeouts = [];
    const elements = { aiProvider: { value: 'deepseek' }, codexStatus: {}, codexTokenUsage: {} };
    const context = vm.createContext({
        window: { ROAM_CLOUD: cloud }, location: { protocol: local ? 'http:' : 'https:', hostname: local ? '127.0.0.1' : 'travel.example' },
        document: { getElementById: id => elements[id] }, localStorage: { getItem: () => null }, isBusy: false,
        AbortSignal: { any: AbortSignal.any.bind(AbortSignal), timeout(ms) { timeouts.push(ms); return AbortSignal.timeout(ms); } },
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (url.endsWith('/status')) return { ok: true, json: async () => ({ ready: true, auth: 'chatgpt', token: 'test-token' }) };
            return respond ? respond(url, options) : { ok: true, json: async () => ({ data: { days: [] }, usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } }) };
        }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../codex-local.js'), 'utf8'), context);
    return { api: context.window.CodexLocal, requests, timeouts, elements };
}

for (const local of [false, true]) test(`import sends all attachments once to Codex regardless of global provider (local=${local})`, async () => {
    const { api, requests, timeouts, elements } = client({ local, cloud: !local });
    const images = [{ name: 'scan.pdf', page: 2, mime: 'image/png', dataBase64: 'test-fixture' }];
    await api.importItinerary('source text', images, new AbortController().signal);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, local ? 'http://127.0.0.1:8081/import-itinerary' : '/codex/import-itinerary');
    assert.deepEqual(JSON.parse(requests[1].options.body), { prompt: 'source text', model: '', images });
    assert.equal(requests[1].options.headers['X-Roam-Token'], 'test-token');
    assert.ok(timeouts.includes(195000));
    assert.match(elements.codexTokenUsage.textContent, /15 Token/);
    assert.equal(elements.aiProvider.value, 'deepseek');
    await api.generate('ordinary planning', new AbortController().signal);
    assert.ok(requests[2].url.endsWith('/generate'));
    assert.equal('images' in JSON.parse(requests[2].options.body), false);
    assert.ok(timeouts.includes(195000));
});

test('public Pages refuses Codex import without probing localhost or another provider', async () => {
    const { api, requests } = client({ cloud: false });
    assert.equal(api.importsAvailable(), false);
    await assert.rejects(api.importItinerary('text', [], new AbortController().signal), /私人正式網站或本機版/);
    assert.equal(requests.length, 0);
});

test('cancelled import stops before requesting a token; provider failure does not retry or fall back', async () => {
    const { api, requests } = client({ respond: async () => ({ ok: false, json: async () => ({ error: 'quota exhausted', code: 'PROVIDER' }) }) });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(api.importItinerary('text', [], controller.signal), { code: 'CANCELLED' });
    assert.equal(requests.length, 0);
    await assert.rejects(api.importItinerary('text', []), /quota exhausted/);
    assert.equal(requests.length, 2);
});
