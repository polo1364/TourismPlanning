'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const key = 'sk-fake-unit-test-only-1234567890';
const completed = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"days":[]}' }] }], usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } };
function fixture(reply = () => new Response(JSON.stringify(completed)), saved = new Map()) {
    const calls = [], events = {};
    const context = vm.createContext({
        window: { addEventListener(name, fn) { events[name] = fn; }, TripArtworkStore: { validateImage: async () => ({ width: 10, height: 10 }) } },
        AbortSignal, TextDecoder, atob, btoa,
        localStorage: { getItem: name => saved.get(name) || null, setItem: (name, value) => saved.set(name, value), removeItem: name => saved.delete(name) },
        sessionStorage: { setItem() { throw Error('Keys must not be persisted'); } },
        fetch: async (url, options) => {
            calls.push({ url, options });
            assert.equal(options.headers.Authorization, 'Bearer ' + key);
            assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
            assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.cache, 'no-store');
            return url.endsWith('/models') ? new Response(JSON.stringify({ data: [{ id: 'gpt-6-sol' }, { id: 'unknown' }] })) : reply(url, options);
        }
    });
    vm.runInContext(fs.readFileSync(require.resolve('../openai-browser.js'), 'utf8'), context);
    return { api: context.window.OpenAIBrowser, calls, saved, events };
}
test('browser key stays in memory, only official endpoint receives credentials, clear prevents use', async () => {
    const { api, calls } = fixture();
    await assert.rejects(api.generate('JSON'), /API Key/);
    assert.equal(calls.length, 0);
    await api.save(key);
    assert.equal(calls[0].url, 'https://api.openai.com/v1/models');
    assert.equal(calls.length, 1); assert.equal(api.ready(), true);
    assert.ok(!JSON.stringify(await api.usage()).includes(key));
    api.clear(); assert.equal(api.ready(), false);
    await assert.rejects(api.generate('JSON'), /API Key/);
    assert.equal(calls.length, 1);
});
test('browser sends all 60 source images in order and validates complete JSON with usage', async () => {
    const { api, calls } = fixture();
    await api.save(key);
    const images = Array.from({ length: 60 }, (_, i) => ({ name: `scan-${i}.pdf`, page: i + 1, mime: 'image/png', dataBase64: btoa('image') }));
    let usage;
    const result = await api.generate('來源與手動補充 JSON', undefined, { images, onUsage: u => { usage = u; } });
    assert.equal(JSON.stringify(result), '{"days":[]}');
    assert.equal(usage.totalTokens, 20);
    const body = JSON.parse(calls.at(-1).options.body);
    assert.equal(calls.at(-1).url, 'https://api.openai.com/v1/responses');
    assert.equal(body.store, false); assert.equal(body.tools, undefined);
    assert.equal(body.input[0].content.length, 121);
    images.forEach((image, i) => {
        assert.equal(body.input[0].content[i * 2 + 1].text, JSON.stringify({ source: image.name, page: i + 1 }));
        assert.equal(body.input[0].content[i * 2 + 2].image_url, `data:${image.mime};base64,${image.dataBase64}`);
    });
});
test('browser rejects incomplete, refused, malformed or non-object responses', async () => {
    for (const result of [{ ...completed, status: 'incomplete' }, { ...completed, output: [{ type: 'message', content: [{ type: 'refusal' }] }] }, { ...completed, output: [] }, { ...completed, output: [{ type: 'message', content: [{ type: 'output_text', text: '[]' }] }] }]) {
        const { api, calls } = fixture(() => new Response(JSON.stringify(result)));
        await api.save(key);
        await assert.rejects(api.generate('JSON'));
        assert.equal(calls.length, 2);
    }
});
test('browser rejects invalid image limits and models before a paid request', async () => {
    const { api, calls } = fixture();
    await api.save(key);
    for (const options of [{ model: 'unknown' }, { images: Array(61).fill({}) }, { images: [{ name: 'a.png', mime: 'text/html', dataBase64: btoa('image') }] }, { images: [{ name: '../a.png', mime: 'image/png', dataBase64: btoa('image') }] }]) await assert.rejects(api.generate('JSON', undefined, options));
    assert.equal(calls.length, 1);
});
test('browser sanitizes API failure and does not retry or fall back', async () => {
    const { api, calls } = fixture(() => new Response(JSON.stringify({ error: { message: key } }), { status: 429 }));
    await api.save(key);
    await assert.rejects(api.generate('JSON'), error => !error.message.includes(key) && /額度不足/.test(error.message));
    assert.equal(calls.length, 2);
});
test('browser cancellation before send never creates a paid request', async () => {
    const { api, calls } = fixture();
    await api.save(key);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(api.generate('JSON', controller.signal), { code: 'CANCELLED' });
    assert.equal(calls.length, 1);
});

test('remember is opt-in, survives a new page and can be disabled without losing the current key', async () => {
    const { api, saved, events } = fixture();
    await api.save(key);
    assert.equal(saved.size, 0);
    api.setRemember(true);
    assert.equal(saved.get('roamOpenAIKey_v1'), key);
    events.pagehide();
    assert.equal(api.ready(), false);
    assert.equal(saved.size, 1);
    const reopened = fixture(undefined, saved);
    assert.equal(reopened.api.restore(), '');
    assert.equal(reopened.api.ready(), true);
    assert.equal(reopened.api.remembered(), true);
    assert.equal(reopened.calls.length, 0);
    reopened.api.setRemember(false);
    assert.equal(reopened.api.ready(), true);
    assert.equal(saved.size, 0);
    reopened.events.pagehide(); reopened.api.restore();
    assert.equal(reopened.api.ready(), false);
});

test('save remembers only after validation and clear removes both memory and browser settings', async () => {
    const { api, saved } = fixture();
    await assert.rejects(api.save('invalid', true));
    assert.equal(saved.size, 0);
    await api.save(key, true);
    assert.equal(api.remembered(), true);
    assert.equal(saved.size, 1);
    api.clear();
    assert.equal(api.ready(), false);
    assert.equal(saved.size, 0);
});

test('failed storage update is explicit and does not pretend a new key was saved', async () => {
    const saved = new Map();
    saved.set = () => { throw Error('quota with secret ' + key); };
    const { api } = fixture(undefined, saved);
    await assert.rejects(api.save(key, true), e => e.code === 'KEY_STORAGE' && !e.message.includes(key));
    assert.equal(api.ready(), false);
    assert.equal(api.remembered(), false);
    await api.save(key);
    await assert.rejects(async () => api.setRemember(true), { code: 'KEY_STORAGE' });
    assert.equal(api.ready(), true);
    assert.equal(api.remembered(), false);
});
