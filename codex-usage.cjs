'use strict';
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');

function stopChild(child) {
    if (!child.pid) return;
    if (process.platform === 'win32') {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
    }
}

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function tokenUsage(output) {
    let usage = null;
    for (const line of output.split(/\r?\n/)) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type !== 'turn.completed') continue;
        const input = count(event.usage?.input_tokens), out = count(event.usage?.output_tokens);
        if (input === null || out === null || !Number.isSafeInteger(input + out)) continue;
        const cached = count(event.usage?.cached_input_tokens);
        usage = { inputTokens: input, outputTokens: out, cachedInputTokens: cached !== null && cached <= input ? cached : null, totalTokens: input + out };
    }
    return usage;
}

function normalizeLimits(result) {
    const mapped = result?.rateLimitsByLimitId;
    const buckets = mapped && typeof mapped === 'object' && !Array.isArray(mapped) && Object.keys(mapped).length
        ? Object.entries(mapped) : [['codex', result?.rateLimits]];
    const limits = [];
    for (const [id, bucket] of buckets.slice(0, 20)) {
        if (!bucket || typeof bucket !== 'object') continue;
        const windows = [];
        for (const key of ['primary', 'secondary']) {
            const value = bucket[key];
            if (!value || typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent) || value.usedPercent < 0) continue;
            windows.push({ key, usedPercent: value.usedPercent, remainingPercent: Math.max(0, 100 - value.usedPercent),
                windowDurationMins: count(value.windowDurationMins), resetsAt: count(value.resetsAt) });
        }
        if (windows.length) limits.push({ id: String(id).slice(0, 100), name: typeof bucket.limitName === 'string' ? bucket.limitName.slice(0, 100) : String(id).slice(0, 100), windows });
    }
    return { available: limits.length > 0, limits, checkedAt: new Date().toISOString() };
}

function normalizeModels(result) {
    return (Array.isArray(result?.data) ? result.data : []).map(model => model && ({ ...model, id: model.model || model.id })).filter(model => model && !model.hidden && typeof model.id === 'string' && /^[a-zA-Z0-9._:-]{1,150}$/.test(model.id))
        .slice(0, 100).map(model => ({ id: model.id, name: typeof model.displayName === 'string' ? model.displayName.slice(0, 150) : model.id, isDefault: model.isDefault === true }));
}

// Only account/model reads are used. No turns, reset redemption or purchases.
function readLimits(cli, env, { launch = spawn, timeout = 10000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = launch(cli.command, [...cli.prefix, 'app-server', '--listen', 'stdio://', '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"'],
            { env, cwd: os.tmpdir(), windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
        let buffer = '', bytes = 0, done = false, initialized = false, limits, models;
        const finish = (error, value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            stopChild(child);
            if (error) reject(new Error('Codex usage unavailable')); else resolve({ ...normalizeLimits(value), models: normalizeModels(models) });
        };
        const timer = setTimeout(() => finish(true), timeout);
        const send = value => child.stdin.write(JSON.stringify(value) + '\n');
        child.on('error', () => finish(true));
        child.on('close', () => finish(true));
        child.stdin.on('error', () => finish(true));
        child.stderr.on('data', () => {});
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > 1024 * 1024) return finish(true);
            buffer += chunk;
            let index;
            while (!done && (index = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
                let message;
                try { message = JSON.parse(line); } catch { return finish(true); }
                if (message.id === 1 && !initialized) {
                    if (message.error || !message.result) return finish(true);
                    initialized = true;
                    send({ method: 'initialized', params: {} });
                    send({ id: 2, method: 'account/rateLimits/read' });
                    send({ id: 3, method: 'model/list', params: { includeHidden: false, limit: 100 } });
                } else if (message.id === 2 && initialized) {
                    limits = message.result || null;
                } else if (message.id === 3 && initialized) {
                    models = message.result || null;
                }
                if (limits !== undefined && models !== undefined) return finish(false, limits);
            }
        });
        send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'roam_travel', title: 'ROAM Travel', version: '1.0.0' } } });
    });
}

function createUsageReader(read, { now = Date.now, ttl = 30000 } = {}) {
    let cached, expires = 0, pending;
    return async () => {
        if (cached && now() < expires) return cached;
        if (!pending) pending = Promise.resolve().then(read).catch(() => ({ available: false, limits: [], models: [], checkedAt: new Date(now()).toISOString() }))
            .then(value => { cached = value; expires = now() + ttl; return value; }).finally(() => { pending = null; });
        return pending;
    };
}
module.exports = { tokenUsage, normalizeLimits, normalizeModels, readLimits, createUsageReader, stopChild };
