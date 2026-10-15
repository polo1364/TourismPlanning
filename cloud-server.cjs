'use strict';
// Personal, authenticated HTTPS deployment. Caddy is the only public listener.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { checkLogin, runCodex, readUsage, validateModel } = require('./codex-bridge.cjs');
const { files } = require('./scripts/build-pages.cjs');
const { createShareStore, MAX_BYTES, PUBLIC_CSP, ID } = require('./book-shares.cjs');
const { createImageJobs, imageRoute } = require('./image-jobs.cjs');
const digest = value => crypto.createHash('sha256').update(value).digest();
const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

function createCloud({ origin, passwordHash, root = __dirname, shareDirectory = path.join(root, '.roam-shares'), login = checkLogin, generate = runCodex, usage = readUsage, imageGenerate, imageDirectory = process.env.ROAM_IMAGE_DIR || path.join(root, '.roam-images') } = {}) {
    const publicURL = new URL(origin);
    if (publicURL.protocol !== 'https:' || publicURL.origin !== origin || publicURL.username || publicURL.password) throw new Error('A canonical HTTPS origin is required.');
    // Hash a generated >= 192-bit random password, not a human-chosen password.
    if (!/^[a-f0-9]{64}$/.test(passwordHash || '')) throw new Error('ROAM_PASSWORD_SHA256 is required.');
    const expectedPassword = Buffer.from(passwordHash, 'hex');
    const token = crypto.randomBytes(32).toString('hex');
    const assets = new Set(files);
    const failures = new Map();
    const shares = createShareStore(shareDirectory);
    let shareStarts = [];
    let busy = false;
    let starts = [];
    const images = createImageJobs({ directory: imageDirectory, generate: imageGenerate,
        authorize: async model => { await login(); return validateModel(model, usage); },
        acquire: () => {
            if (busy) throw fail('另一個生成工作尚未完成。', 409, 'BUSY');
            starts = starts.filter(time => Date.now() - time < 3600000);
            if (starts.length >= 60) throw fail('已達每小時 60 次生成上限。', 429, 'RATE');
            busy = true; starts.push(Date.now()); return () => { busy = false; };
        }
    });
    const server = http.createServer(async (req, res) => {
        const json = (status, data) => {
            if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
        };
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'same-origin');
        if (req.headers.host !== publicURL.host || req.headers['x-forwarded-proto'] !== 'https') return json(403, { error: '請使用正式 HTTPS 網址。' });
        // Only a single, unguessable read-only snapshot is public. All other routes keep authentication.
        const pathname = req.url.split('?')[0];
        if (pathname.startsWith('/s/')) {
            res.setHeader('Referrer-Policy', 'no-referrer');
            res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
            res.setHeader('Content-Security-Policy', PUBLIC_CSP);
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            if (!['GET', 'HEAD'].includes(req.method)) return json(405, { error: '分享小冊僅供閱讀。' });
            try {
                const record = await shares.read(pathname.slice(3));
                if (record) return res.end(req.method === 'HEAD' ? undefined : record.html);
                res.statusCode = 404;
                return res.end(req.method === 'HEAD' ? undefined : '<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>分享已取消</title><body style="font:18px/1.8 system-ui;padding:32px;background:#f6f3eb;color:#193b4c"><h1>這份小冊已取消分享或不存在</h1><p>請向旅程提供者索取新的分享網址。</p></body></html>');
            } catch { return json(503, { error: '暫時無法讀取小冊，請稍後再試。' }); }
        }
        // The peer is the loopback Caddy proxy; Caddy overwrites X-Forwarded-For.
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).slice(0, 128);
        const now = Date.now();
        for (const [key, entry] of failures) if (entry.until <= now) failures.delete(key);
        if ((failures.get(ip)?.count || 0) >= 10) { res.setHeader('Retry-After', '60'); return json(429, { error: '登入嘗試過多，請一分鐘後再試。' }); }
        let user = '', password = '';
        if (/^Basic [A-Za-z0-9+/]+=*$/.test(req.headers.authorization || '')) {
            const credentials = Buffer.from(req.headers.authorization.slice(6), 'base64').toString('utf8');
            const colon = credentials.indexOf(':');
            if (colon >= 0) { user = credentials.slice(0, colon); password = credentials.slice(colon + 1); }
        }
        if (!crypto.timingSafeEqual(digest(password), expectedPassword) || user !== 'roam') {
            if (failures.size < 1000 || failures.has(ip)) {
                const previous = failures.get(ip);
                failures.set(ip, { count: (previous?.count || 0) + 1, until: previous?.until || now + 60000 });
            }
            res.setHeader('WWW-Authenticate', 'Basic realm="ROAM private travel book", charset="UTF-8"');
            return json(401, { error: '請登入私人旅遊書。' });
        }
        failures.delete(ip);
        if (req.headers.origin && req.headers.origin !== origin) return json(403, { error: '不接受其他網站的請求。', code: 'ORIGIN' });
        let measuredUsage;
        try {
            if (pathname === '/codex/images' || pathname.startsWith('/codex/images/')) {
                if (req.method === 'POST' && req.headers.origin !== origin) return json(403, { error: '不接受其他網站的圖片請求。' });
                if (await imageRoute(req, json, images, '/codex/images', token)) return;
            }
            if (pathname === '/api/shares' || pathname.startsWith('/api/shares/')) {
                if (req.method === 'GET' && pathname === '/api/shares') {
                    return json(200, { token, shares: (await shares.list()).map(item => ({ ...item, url: `${origin}/s/${item.id}` })) });
                }
                if (req.headers.origin !== origin || req.headers['x-roam-token'] !== token) return json(403, { error: '連線已更新，請重新整理分享清單。', code: 'TOKEN' });
                if (req.method === 'POST' && pathname === '/api/shares') {
                    if (req.headers['content-type'] !== 'application/json') return json(415, { error: '請使用 JSON。' });
                    shareStarts = shareStarts.filter(time => Date.now() - time < 3600000);
                    if (shareStarts.length >= 30) return json(429, { error: '已達每小時 30 次建立分享上限，請稍後再試。' });
                    shareStarts.push(Date.now());
                    const chunks = []; let bytes = 0;
                    for await (const chunk of req) {
                        bytes += chunk.length;
                        if (bytes > MAX_BYTES + 256 * 1024) throw fail('小冊內容過大。', 413, 'SIZE');
                        chunks.push(chunk);
                    }
                    let body;
                    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('JSON 格式錯誤。', 400, 'BODY'); }
                    const item = await shares.create(body);
                    return json(201, { ...item, url: `${origin}/s/${item.id}` });
                }
                if (req.method === 'DELETE' && ID.test(pathname.slice('/api/shares/'.length))) {
                    await shares.revoke(pathname.slice('/api/shares/'.length));
                    return json(200, { revoked: true });
                }
                return json(405, { error: '不支援此分享操作。' });
            }
            if (req.method === 'GET' && req.url === '/codex/status') {
                const state = await login();
                return json(200, { service: 'roam-cloud', ready: state.ready, auth: state.auth, token });
            }
            if (req.method === 'GET' && req.url === '/codex/usage') {
                if (req.headers['x-roam-token'] !== token) return json(403, { error: '請重新檢查連線。', code: 'TOKEN' });
                await login();
                return json(200, await usage());
            }
            if (req.method === 'POST' && req.url === '/codex/generate') {
                if (req.headers.origin !== origin || req.headers['x-roam-token'] !== token) return json(403, { error: '連線已更新，請重新檢查連線。', code: 'TOKEN' });
                if (req.headers['content-type'] !== 'application/json') return json(415, { error: '請使用 JSON。' });
                if (busy) return json(409, { error: '另一個生成工作尚未完成，請稍後再試。', code: 'BUSY' });
                starts = starts.filter(time => now - time < 3600000);
                if (starts.length >= 60) return json(429, { error: '已達每小時 60 次生成上限，請稍後再試。', code: 'RATE' });
                busy = true;
                const controller = new AbortController();
                const abort = () => controller.abort();
                req.once('aborted', abort);
                res.once('close', abort);
                try {
                    const chunks = []; let bytes = 0;
                    for await (const chunk of req) {
                        bytes += chunk.length;
                        if (bytes > 128 * 1024) throw fail('旅行需求過長。', 413, 'SIZE');
                        chunks.push(chunk);
                    }
                    let body;
                    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('JSON 格式錯誤。', 400, 'BODY'); }
                    if (typeof body?.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 60000) throw fail('請提供有效旅行需求。', 400, 'PROMPT');
                    await login();
                    const model = await validateModel(body.model, usage);
                    if (controller.signal.aborted) return;
                    starts.push(now);
                    const data = await generate(body.prompt, controller.signal, { model, onUsage: value => { measuredUsage = value; } });
                    if (!controller.signal.aborted) json(200, { data, usage: measuredUsage });
                } finally {
                    busy = false;
                    req.removeListener('aborted', abort);
                    res.removeListener('close', abort);
                }
                return;
            }
            if (!['GET', 'HEAD'].includes(req.method)) return json(405, { error: '不支援此操作。' });
            if (pathname === '/cloud-config.js') {
                res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
                return res.end(req.method === 'HEAD' ? '' : 'window.ROAM_CLOUD = true;');
            }
            const file = pathname === '/' ? 'index.html' : pathname.slice(1);
            if (!assets.has(file)) return json(404, { error: '找不到頁面。' });
            const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/plain' };
            res.setHeader('Content-Type', (types[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8');
            let content = await fs.promises.readFile(path.join(root, file));
            if (file === 'index.html') content = Buffer.from(content.toString('utf8').replace('</head>', '<script src="/cloud-config.js"></script></head>'));
            res.end(req.method === 'HEAD' ? undefined : content);
        } catch (error) {
            json(error.status || 500, { error: error.status ? error.message.replaceAll('本機', '雲端主機') : '雲端服務暫時無法使用。', code: error.status ? error.code : 'CLOUD', usage: measuredUsage });
        }
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.keepAliveTimeout = 5000;
    server.on('close', () => images.stop());
    return server;
}

if (require.main === module) {
    const server = createCloud({ origin: process.env.ROAM_ORIGIN, passwordHash: process.env.ROAM_PASSWORD_SHA256, shareDirectory: process.env.ROAM_SHARE_DIR || path.join(__dirname, '.roam-shares') });
    server.listen(8090, '127.0.0.1', () => console.log('ROAM private cloud backend ready on loopback port 8090.'));
}
module.exports = { createCloud, digest };
