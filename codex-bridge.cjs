'use strict';
// Personal loopback bridge. Credentials stay in the official Codex CLI.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { tokenUsage, readLimits, createUsageReader, stopChild } = require('./codex-usage.cjs');
const PORT = 8081;
const MAX_BODY = 128 * 1024;
const MAX_OUTPUT = 2 * 1024 * 1024;
const TIMEOUT = 180000;
const ORIGINS = new Set(['http://127.0.0.1:8080', 'http://localhost:8080']);
const fail = (message, code = 'CODEX', status = 502) => Object.assign(new Error(message), { code, status });

function cliCommand() {
    for (const folder of (process.env.PATH || '').split(path.delimiter)) {
        const launcher = path.join(folder, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        if (fs.existsSync(launcher)) return { command: process.execPath, prefix: [launcher] };
        const binary = path.join(folder, process.platform === 'win32' ? 'codex.exe' : 'codex');
        if (fs.existsSync(binary)) return { command: binary, prefix: [] };
    }
    throw fail('找不到 Codex CLI。請先安裝官方 Codex CLI，再執行 codex login。', 'CLI', 503);
}

function childEnv() {
    // Inherit OS/runtime settings, never API credentials or endpoint overrides.
    const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOME|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|SYSTEMDRIVE|CODEX_HOME|CODEX_CA_CERTIFICATE|NODE_EXTRA_CA_CERTS)$/i;
    return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
}

async function checkLogin() {
    const cli = cliCommand();
    try {
        const result = await execFileAsync(cli.command, [...cli.prefix, 'login', 'status'], { env: childEnv(), windowsHide: true, timeout: 10000, maxBuffer: 65536 });
        if (!/Logged in using ChatGPT/i.test(result.stdout + result.stderr)) throw fail('請用 codex login 登入 ChatGPT；此連接只使用 Codex 額度。', 'LOGIN', 401);
        return { ready: true, auth: 'chatgpt' };
    } catch (error) {
        if (error.code === 'LOGIN') throw error;
        throw fail('Codex 尚未登入 ChatGPT，請在本機執行 codex login 後重新檢查。', 'LOGIN', 401);
    }
}

function cliArgs(cwd, model = '') {
    const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--color', 'never', '--cd', cwd];
    for (const config of ['model_provider="openai"', 'forced_login_method="chatgpt"', 'approval_policy="never"', 'project_doc_max_bytes=0', 'web_search="disabled"']) args.push('-c', config);
    // No shell, plugins, connected apps, browser or subagents are needed for JSON planning.
    for (const feature of ['shell_tool', 'apps', 'plugins', 'hooks', 'memories', 'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'view_image', 'code_mode', 'code_mode_host', 'skill_search', 'workspace_dependencies', 'goals', 'sleep_tool']) args.push('--disable', feature);
    if (model) args.push('--model', model);
    return [...args, '-'];
}

const readUsage = createUsageReader(() => readLimits(cliCommand(), childEnv()));
async function validateModel(model, usage) {
    if (model === undefined || model === '') return '';
    if (typeof model !== 'string' || model.length > 150) throw fail('模型選擇無效。', 'MODEL', 400);
    const info = await usage();
    if (!info.models?.length) throw fail('暫時無法取得模型清單，請更新後再試，或選擇官方預設。', 'MODEL', 503);
    if (!info.models.some(item => item.id === model)) throw fail('此模型目前不在可用清單，請重新選擇。', 'MODEL', 400);
    return model;
}

function parseEvents(output) {
    let completed = false, text = '';
    for (const line of output.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { throw fail('Codex 回應格式不完整，結果未儲存。', 'RESPONSE'); }
        if (event.type === 'turn.failed' || event.type === 'error') throw fail('Codex 未完成請求；請確認額度與登入狀態後再試。', 'PROVIDER');
        if (event.type === 'turn.completed') completed = true;
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text;
    }
    if (!completed || !text) throw fail('Codex 沒有完整回覆，結果未儲存。', 'RESPONSE');
    // Some CLI models wrap JSON despite the instruction; only unwrap an entire fence.
    text = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1');
    let data;
    try { data = JSON.parse(text); } catch { throw fail('Codex 未回傳有效 JSON，請重試這一天。', 'JSON'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('Codex 回覆不是行程物件。', 'JSON');
    return data;
}

async function runCodex(prompt, signal, { model = '', onUsage = () => {} } = {}) {
    if (signal.aborted) throw fail('已取消 Codex 生成。', 'CANCELLED', 499);
    const cli = cliCommand();
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'roam-codex-'));
    try {
        return await new Promise((resolve, reject) => {
            const child = spawn(cli.command, [...cli.prefix, ...cliArgs(cwd, model)], { env: childEnv(), windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
            let output = '', failure = null;
            const stop = error => {
                if (failure) return;
                failure = error;
                stopChild(child);
            };
            const abort = () => stop(fail('已取消 Codex 生成。', 'CANCELLED', 499));
            const timer = setTimeout(() => stop(fail('Codex 回應逾時，已保留完成內容；請稍後手動接續。', 'TIMEOUT', 504)), TIMEOUT);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', chunk => {
                output += chunk;
                if (Buffer.byteLength(output) > MAX_OUTPUT) stop(fail('Codex 回覆超過長度限制。', 'LENGTH'));
            });
            child.stderr.on('data', () => {}); // Never forward diagnostics, prompts or credentials.
            child.stdin.on('error', () => {});
            child.once('error', () => { failure = fail('無法啟動 Codex CLI。', 'CLI', 503); });
            child.once('close', code => {
                clearTimeout(timer);
                signal.removeEventListener('abort', abort);
                onUsage(tokenUsage(output));
                if (failure) return reject(failure);
                if (code !== 0) return reject(fail('Codex 執行失敗；請檢查登入、額度或 CLI 版本。', 'PROVIDER'));
                try { resolve(parseEvents(output)); } catch (error) { reject(error); }
            });
            child.stdin.end('你是旅遊行程規劃助理。只輸出符合下方欄位要求的有效 JSON 物件，不要程式碼框或額外說明。使用臺灣繁體中文。不要使用工具、讀取檔案、操作電腦或執行指令；只依旅行需求產生內容。\n\n' + prompt);
        });
    } finally {
        // Only remove our empty temporary working directory, never recursive user data.
        await fs.promises.rmdir(cwd).catch(() => {});
    }
}

function createBridge({ login = checkLogin, generate = runCodex, usage = readUsage } = {}) {
    const token = crypto.randomBytes(32).toString('hex');
    let busy = false;
    return http.createServer(async (req, res) => {
        const json = (status, data) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); } };
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const expectedHost = `127.0.0.1:${req.socket.localPort}`;
        if (req.headers.host !== expectedHost || !ORIGINS.has(req.headers.origin)) return json(403, { error: '僅允許本機旅遊網頁連線。', code: 'ORIGIN' });
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Vary', 'Origin');
        if (req.method === 'OPTIONS') {
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Roam-Token');
            res.writeHead(204); return res.end();
        }
        let measuredUsage;
        try {
            if (req.method === 'GET' && req.url === '/status') {
                const state = await login();
                return json(200, { service: 'roam-codex', ready: state.ready, auth: state.auth, token });
            }
            if (req.method === 'GET' && req.url === '/usage') {
                if (req.headers['x-roam-token'] !== token) return json(403, { error: '請重新檢查連線。', code: 'TOKEN' });
                await login();
                return json(200, await usage());
            }
            if (req.method !== 'POST' || req.url !== '/generate') return json(404, { error: '找不到此功能。' });
            if (req.headers['x-roam-token'] !== token) return json(403, { error: '本機連線已更新，請重新檢查連線。', code: 'TOKEN' });
            if (req.headers['content-type'] !== 'application/json') return json(415, { error: '請使用 JSON。' });
            if (busy) return json(409, { error: 'Codex 正在生成另一份內容，請等待或取消後再試。', code: 'BUSY' });
            busy = true;
            const controller = new AbortController();
            const abort = () => controller.abort();
            req.once('aborted', abort);
            res.once('close', abort);
            try {
                const chunks = []; let bytes = 0;
                for await (const chunk of req) {
                    bytes += chunk.length;
                    if (bytes > MAX_BODY) throw fail('旅行需求過長，請縮短後再試。', 'SIZE', 413);
                    chunks.push(chunk);
                }
                let body;
                try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('JSON 格式錯誤。', 'BODY', 400); }
                if (typeof body?.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 60000) throw fail('請提供有效旅行需求。', 'PROMPT', 400);
                await login(); // Require ChatGPT auth for every request; never fall back to API billing.
                const model = await validateModel(body.model, usage);
                if (controller.signal.aborted) throw fail('已取消。', 'CANCELLED', 499);
                const data = await generate(body.prompt, controller.signal, { model, onUsage: value => { measuredUsage = value; } });
                if (!controller.signal.aborted) json(200, { data, usage: measuredUsage });
            } finally {
                busy = false;
                req.removeListener('aborted', abort);
                res.removeListener('close', abort);
            }
        } catch (error) {
            json(error.status || 500, { error: error.status ? error.message : '本機 Codex 連線失敗，請重新檢查。', code: error.status ? error.code : 'BRIDGE', usage: measuredUsage });
        }
    });
}

if (require.main === module) {
    const server = createBridge();
    server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Codex bridge port 8081 is already in use.' : 'Codex bridge could not start.'); process.exitCode = 1; });
    server.listen(PORT, '127.0.0.1', () => console.log('Codex bridge ready at http://127.0.0.1:8081 (personal local use only).'));
}
module.exports = { createBridge, parseEvents, cliArgs, childEnv, checkLogin, runCodex, readUsage, validateModel };
