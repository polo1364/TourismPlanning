const { test } = require('node:test');
const assert = require('node:assert/strict');
const client = require('../claude.js');

function message(text = '{"spots":"台北101","food":"牛肉麵"}', stopReason = 'end_turn', extra = {}) {
    const body = {
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: stopReason, stop_sequence: null,
        content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text }],
        usage: { input_tokens: 10, output_tokens: 20 }, ...extra
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
}

test('sends an authenticated Claude request through the SDK and returns parsed JSON', async (t) => {
    let request;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        request = { url: String(url), init, headers: new Headers(init.headers) };
        return message();
    });
    assert.deepEqual(await client.generate({ key: ' test-key ', prompt: '請推薦台北 JSON' }), { spots: '台北101', food: '牛肉麵' });
    assert.match(request.url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
    assert.equal(request.init.method, 'POST');
    assert.equal(request.headers.get('authorization'), 'Bearer test-key');
    assert.equal(request.headers.get('anthropic-dangerous-direct-browser-access'), 'true');
    assert.match(request.headers.get('anthropic-beta'), /server-side-fallback-2026-07-01/);
    assert.ok(!request.url.includes('test-key'));
    const body = JSON.parse(request.init.body);
    assert.equal(body.model, 'claude-opus-5-5');
    assert.equal(body.fallbacks, 'default');
    assert.deepEqual(body.output_config, { effort: 'medium' });
    assert.equal(body.max_tokens, 16000);
    assert.equal(body.thinking, undefined);
    assert.match(body.system, /JSON/);
    assert.deepEqual(body.messages, [{ role: 'user', content: '請推薦台北 JSON' }]);
});

test('Haiku is sent without the server-side fallback, which it does not support', async (t) => {
    let request;
    t.mock.method(globalThis, 'fetch', async (_, init) => {
        request = { body: JSON.parse(init.body), headers: new Headers(init.headers) };
        return message('{"itinerary":[]}');
    });
    assert.deepEqual(await client.generate({ key: 'test-key', model: 'claude-haiku-5-5', prompt: 'JSON' }), { itinerary: [] });
    assert.equal(request.body.model, 'claude-haiku-5-5');
    assert.equal(request.body.fallbacks, undefined);
    assert.ok(!String(request.headers.get('anthropic-beta') || '').includes('server-side-fallback'));
});

test('a stray code fence around the JSON is tolerated', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => message('```json\n{"itinerary":[1]}\n```'));
    assert.deepEqual(await client.generate({ key: 'test-key', model: 'claude-sonnet-5-5', prompt: 'JSON' }), { itinerary: [1] });
});

test('invalid inputs fail before any paid request', async (t) => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => message());
    for (const [options, code] of [
        [{}, 'KEY'],
        [{ key: '   ', prompt: 'JSON' }, 'KEY'],
        [{ key: 'test-key', model: 'deepseek-flash', prompt: 'JSON' }, 'MODEL'],
        [{ key: 'test-key', prompt: '   ' }, 'PROMPT'],
        [{ key: 'test-key', prompt: 'JSON', timeoutMs: 0 }, 'TIMEOUT_CONFIG'],
        [{ key: 'test-key', prompt: 'JSON', signal: AbortSignal.abort() }, 'CANCELLED']
    ]) {
        await assert.rejects(client.generate(options), (error) => error.code === code);
    }
    assert.equal(fetch.mock.callCount(), 0);
});

test('HTTP failures map to fixed messages, never retry and never echo provider bodies', async (t) => {
    for (const status of [400, 401, 403, 404, 413, 429, 500, 529]) {
        const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(
            JSON.stringify({ type: 'error', error: { type: 'x', message: 'secret body test-key' } }),
            { status, headers: { 'content-type': 'application/json' } }
        ));
        await assert.rejects(client.generate({ key: 'test-key', prompt: 'JSON' }), (error) => {
            assert.equal(error.code, 'HTTP');
            assert.equal(error.status, status);
            assert.ok(!error.message.includes('test-key') && !error.message.includes('secret'));
            return true;
        });
        assert.equal(fetch.mock.callCount(), 1, `status ${status} must not be retried`);
        fetch.mock.restore();
    }
});

test('refusal, truncation, empty and non-JSON replies are reported, not saved', async (t) => {
    for (const [reply, code] of [
        [message('', 'refusal'), 'CONTENT_FILTER'],
        [message('{"itinerary":', 'max_tokens'), 'LENGTH'],
        [message('   '), 'EMPTY'],
        [message('這不是 JSON'), 'JSON'],
        [message('[1,2]'), 'JSON']
    ]) {
        t.mock.method(globalThis, 'fetch', async () => reply);
        await assert.rejects(client.generate({ key: 'test-key', prompt: 'JSON' }), (error) => error.code === code);
    }
});

test('cancelling and network failures are distinguished', async (t) => {
    const controller = new AbortController();
    t.mock.method(globalThis, 'fetch', (_, init) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        controller.abort();
    }));
    await assert.rejects(client.generate({ key: 'test-key', prompt: 'JSON', signal: controller.signal }), (error) => error.code === 'CANCELLED');
    t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch test-key'); });
    await assert.rejects(client.generate({ key: 'test-key', prompt: 'JSON' }), (error) => error.code === 'NETWORK' && !error.message.includes('test-key'));
});

// Streaming replies (import and SVG) arrive as server-sent events.
function streamReply(text, stopReason = 'end_turn') {
    const events = [
        ['message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } }],
        ['message_stop', { type: 'message_stop' }]
    ];
    const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('import sends the prompt and every labelled attachment as image blocks, streamed', async (t) => {
    let body;
    t.mock.method(globalThis, 'fetch', async (_, init) => { body = JSON.parse(init.body); return streamReply('{"city":"花蓮","days":[]}'); });
    const images = [{ name: '行程.pdf', page: 1, mime: 'image/png', dataBase64: 'iVBORw0KGgo=' }, { name: '照片.jpg', mime: 'image/jpeg', dataBase64: '/9j/4AAQ' }];
    assert.deepEqual(await client.readItinerary({ key: 'test-key', prompt: '整理行程 JSON', images }), { city: '花蓮', days: [] });
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 32000);
    assert.match(body.system, /不可信/);
    const content = body.messages[0].content;
    assert.equal(content[0].text, '整理行程 JSON');
    assert.deepEqual(JSON.parse(content[1].text), { source: '行程.pdf', page: 1 });
    assert.deepEqual(content[2], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } });
    assert.deepEqual(JSON.parse(content[3].text), { source: '照片.jpg', page: null });
    assert.equal(content[4].source.media_type, 'image/jpeg');
});

test('import rejects bad attachments before any paid request', async (t) => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => streamReply('{}'));
    for (const [images, code] of [
        [Array.from({ length: 61 }, () => ({ mime: 'image/png', dataBase64: 'AAAA' })), 'IMPORT_IMAGES'],
        [[{ mime: 'image/gif', dataBase64: 'AAAA' }], 'IMPORT_IMAGE'],
        [[{ mime: 'image/png', dataBase64: 'not base64!' }], 'IMPORT_IMAGE']
    ]) await assert.rejects(client.readItinerary({ key: 'test-key', prompt: 'JSON', images }), (error) => error.code === code);
    assert.equal(fetch.mock.callCount(), 0);
});

test('SVG drawing streams, passes place names as data and returns only the svg element', async (t) => {
    let body;
    t.mock.method(globalThis, 'fetch', async (_, init) => { body = JSON.parse(init.body); return streamReply('好的：\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1536 1024"><rect width="1536" height="1024" fill="#fbf6ea"/></svg>\n完成'); });
    const svg = await client.drawSvg({ key: 'test-key', subject: { city: '花蓮', role: 'scene', places: [{ title: '瑞穗牧場', address: '瑞穗鄉' }] } });
    assert.equal(svg, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1536 1024"><rect width="1536" height="1024" fill="#fbf6ea"/></svg>');
    assert.equal(body.stream, true);
    assert.match(body.messages[0].content, /"title":"瑞穗牧場"/);
    assert.match(body.messages[0].content, /禁止 <script>/);
});

test('SVG drawing reports a reply without an svg and refuses an incomplete subject without calling the API', async (t) => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => streamReply('抱歉，我無法畫圖。'));
    await assert.rejects(client.drawSvg({ key: 'test-key', subject: { city: '花蓮', role: 'unknown', places: [] } }), (error) => error.code === 'SUBJECT');
    assert.equal(fetch.mock.callCount(), 0);
    await assert.rejects(client.drawSvg({ key: 'test-key', subject: { city: '花蓮', role: 'cover', places: [] } }), (error) => error.code === 'SVG');
});

test('every completed reply is recorded for usage, and a reached budget blocks sending', async (t) => {
    const records = [];
    let blocked = false;
    globalThis.ClaudeUsage = { guard() { if (blocked) throw new Error('本月已達預算上限'); }, record(entry) { records.push(entry); } };
    t.after(() => { delete globalThis.ClaudeUsage; });
    const fetch = t.mock.method(globalThis, 'fetch', async () => message('{"ok":true}', 'end_turn', { usage: { input_tokens: 120, output_tokens: 30 } }));
    await client.generate({ key: 'test-key', prompt: 'JSON' });
    assert.deepEqual(records, [{ model: 'claude-opus-5-5', feature: 'plan', usage: { input_tokens: 120, output_tokens: 30 } }]);
    // A refused reply is still billed, so it is still counted.
    t.mock.method(globalThis, 'fetch', async () => message('', 'refusal'));
    await assert.rejects(client.generate({ key: 'test-key', prompt: 'JSON' }), (error) => error.code === 'CONTENT_FILTER');
    assert.equal(records.length, 2);
    blocked = true;
    const blockedFetch = t.mock.method(globalThis, 'fetch', async () => message());
    await assert.rejects(client.generate({ key: 'test-key', prompt: 'JSON' }), (error) => error.code === 'BUDGET' && /預算/.test(error.message));
    assert.equal(blockedFetch.mock.callCount(), 0);
    assert.equal(fetch.mock.callCount(), 1);
});
