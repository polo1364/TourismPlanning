const { test } = require('node:test');
const assert = require('node:assert/strict');
const client = require('../deepseek.js');

function response(content = '{"spots":"台北101","food":"牛肉麵"}', finishReason = 'stop') {
    return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: finishReason, message: { content } }] }) };
}

test('sends an authenticated DeepSeek JSON request and returns parsed data', async (t) => {
    let request;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        request = { url, init };
        return response();
    });
    assert.deepEqual(await client.generate({ key: ' test-key ', prompt: '請推薦台北 JSON' }), { spots: '台北101', food: '牛肉麵' });
    assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.headers.Authorization, 'Bearer test-key');
    assert.ok(!request.url.includes('test-key'));
    const body = JSON.parse(request.init.body);
    assert.equal(body.model, 'deepseek-flash');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 8192);
    assert.match(body.messages[0].content, /JSON/);
    assert.equal(body.messages[1].content, '請推薦台北 JSON');
});

test('supports the current Pro model', async (t) => {
    t.mock.method(globalThis, 'fetch', async (_, init) => {
        assert.equal(JSON.parse(init.body).model, 'deepseek-v4-pro');
        return response('{"itinerary":[]}');
    });
    assert.deepEqual(await client.generate({ key: 'test-key', model: 'deepseek-v4-pro', prompt: 'JSON' }), { itinerary: [] });
});

test('invalid inputs fail before any paid request', async (t) => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => response());
    for (const [options, code] of [
        [{}, 'KEY'],
        [{ key: '   ', prompt: 'JSON' }, 'KEY'],
        [{ key: 'test-key', model: 'gemini-2.5-flash', prompt: 'JSON' }, 'MODEL'],
        [{ key: 'test-key', prompt: '   ' }, 'PROMPT'],
        [{ key: 'test-key', prompt: 'JSON', timeoutMs: 0 }, 'TIMEOUT_CONFIG']
    ]) {
        await assert.rejects(client.generate(options), (error) => error.code === code);
    }
    assert.equal(fetch.mock.callCount(), 0);
});

test('HTTP failures do not retry or echo provider bodies and credentials', async (t) => {
    for (const status of [400, 401, 402, 403, 422, 429, 500, 503, 504]) {
        const fetch = t.mock.method(globalThis, 'fetch', async () => ({
            ok: false,
            status,
            json: async () => { throw new Error('the error body should not be consumed: test-key'); }
        }));
        await assert.rejects(client.generate({ key: 'test-key', prompt: 'JSON' }), (error) => {
            assert.equal(error.code, 'HTTP');
            assert.equal(error.status, status);
            assert.ok(!error.message.includes('test-key'));
            return true;
        });
        assert.equal(fetch.mock.callCount(), 1);
        fetch.mock.restore();
    }
});

test('truncated and malformed output is rejected instead of repaired into partial trip data', async (t) => {
    for (const [result, code] of [
        [response('{"itinerary":[', 'length'), 'LENGTH'],
        [response('{}', 'content_filter'), 'CONTENT_FILTER'],
        [response('{}', 'insufficient_system_resource'), 'RESPONSE'],
        [response('  '), 'EMPTY'],
        [response('{"itinerary":[}'), 'JSON'],
        [response('```json\n{}\n```'), 'JSON'],
        [response('null'), 'JSON'],
        [response('"text"'), 'JSON'],
        [{ ok: true, json: async () => ({ choices: [] }) }, 'RESPONSE'],
        [{ ok: true, json: async () => ({ error: { message: 'test-key' } }) }, 'RESPONSE'],
        [{ ok: true, json: async () => { throw new SyntaxError('bad JSON'); } }, 'RESPONSE']
    ]) {
        const fetch = t.mock.method(globalThis, 'fetch', async () => result);
        await assert.rejects(client.generate({ key: 'test-key', prompt: 'JSON' }), (error) => error.code === code);
        assert.equal(fetch.mock.callCount(), 1);
        fetch.mock.restore();
    }
});

test('network errors are sanitized and never automatically retried', async (t) => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('network error includes test-key'); });
    await assert.rejects(client.generate({ key: 'test-key', prompt: 'JSON' }), (error) => error.code === 'NETWORK' && !error.message.includes('test-key'));
    assert.equal(fetch.mock.callCount(), 1);
});

function pendingUntilAborted(_, init) {
    return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
}

test('timeout aborts the request without a second POST', async (t) => {
    const fetch = t.mock.method(globalThis, 'fetch', pendingUntilAborted);
    await assert.rejects(client.generate({ key: 'test-key', prompt: 'JSON', timeoutMs: 10 }), (error) => error.code === 'TIMEOUT');
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(fetch.mock.calls[0].arguments[1].signal.aborted, true);
});

test('an already cancelled request never reaches the provider', async (t) => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => response());
    await assert.rejects(client.generate({ key: 'test-key', prompt: 'JSON', signal: AbortSignal.abort() }), (error) => error.code === 'CANCELLED');
    assert.equal(fetch.mock.callCount(), 0);
});

test('caller cancellation aborts an in-flight request', async (t) => {
    const fetch = t.mock.method(globalThis, 'fetch', pendingUntilAborted);
    const controller = new AbortController();
    const pending = client.generate({ key: 'test-key', prompt: 'JSON', signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error) => error.code === 'CANCELLED');
    assert.equal(fetch.mock.callCount(), 1);
});

test('timeout also covers a response body that has not finished arriving', async (t) => {
    t.mock.method(globalThis, 'fetch', async (_, init) => ({
        ok: true,
        json: () => pendingUntilAborted(null, init)
    }));
    await assert.rejects(client.generate({ key: 'test-key', prompt: 'JSON', timeoutMs: 10 }), (error) => error.code === 'TIMEOUT');
});
