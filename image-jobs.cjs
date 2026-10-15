'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { runImage, imageType } = require('./codex-images.cjs');
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = (message, status = 400, code = 'IMAGE') => Object.assign(new Error(message), { status, code });
function validateSubject(value) {
    if (!value || typeof value.city !== 'string' || !value.city.trim() || value.city.length > 200 || !['cover','scene','detail'].includes(value.role) || !Array.isArray(value.places) || !value.places.length || value.places.length > 5) throw fail('插圖主題格式無效。');
    return { city: value.city.trim(), role: value.role, places: value.places.map(place => {
        if (!place || typeof place.title !== 'string' || !place.title.trim() || place.title.length > 400 || typeof place.address !== 'string' || place.address.length > 600) throw fail('插圖景點資料無效。');
        return { title: place.title.trim(), address: place.address.trim() };
    }) };
}
function createImageJobs({ directory, generate = runImage, authorize = async () => {}, acquire = () => () => {} }) {
    let queue = Promise.resolve(), initialized = false;
    const running = new Map();
    const serial = fn => { const work = queue.then(fn); queue = work.catch(() => {}); return work; };
    const file = (id, suffix = '.json') => path.join(directory, id + suffix);
    const write = async record => {
        await fs.writeFile(file(record.id, '.tmp'), JSON.stringify(record), { mode: 0o600 });
        await fs.rename(file(record.id, '.tmp'), file(record.id));
    };
    async function init() {
        if (initialized) return;
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        for (const name of await fs.readdir(directory)) {
            if (!name.endsWith('.json') || !ID.test(name.slice(0, -5))) continue;
            const record = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
            if (record.status === 'running') { record.status = 'interrupted'; record.error = '服務曾重新啟動，請手動重新生成；不會自動重送。'; await write(record); }
        }
        initialized = true;
    }
    async function read(id) {
        if (!ID.test(id)) throw fail('圖片工作編號無效。');
        try { return JSON.parse(await fs.readFile(file(id), 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') throw fail('找不到圖片工作。', 404, 'NOT_FOUND'); throw error; }
    }
    return {
        get: id => serial(async () => { await init(); return read(id); }),
        create: body => serial(async () => {
            if (!body || !ID.test(body.id)) throw fail('請提供有效的圖片請求識別碼。');
            const subject = validateSubject(body.subject);
            await init();
            let previous;
            try { previous = await read(body.id); } catch (error) { if (error.status !== 404) throw error; }
            if (previous) {
                if (JSON.stringify(previous.subject) !== JSON.stringify(subject)) throw fail('圖片請求識別碼已用於不同主題。', 409);
                return previous;
            }
            const model = await authorize(body.model);
            const release = acquire();
            const record = { id: body.id, subject, status: 'running', createdAt: new Date().toISOString() };
            try { await fs.writeFile(file(record.id), JSON.stringify(record), { flag: 'wx', mode: 0o600 }); }
            catch (error) { release(); throw error; }
            const controller = new AbortController(); running.set(record.id, controller);
            // The durable request exists before starting. HTTP disconnects do not submit again.
            Promise.resolve().then(() => generate(subject, controller.signal, { model })).then(async result => {
                if (controller.signal.aborted) throw fail('已停止插圖生成。', 409, 'CANCELLED');
                const mime = imageType(result.bytes);
                await fs.writeFile(file(record.id, '.image.tmp'), result.bytes, { mode: 0o600 });
                await fs.rename(file(record.id, '.image.tmp'), file(record.id, '.image'));
                await serial(async () => { record.status = 'completed'; record.mime = mime; record.bytes = result.bytes.length; await write(record); });
            }).catch(async error => {
                await serial(async () => {
                    record.status = controller.signal.aborted ? 'cancelled' : 'failed';
                    record.error = error.status ? error.message : '圖片工作或儲存失敗，未自動重送。';
                    await write(record);
                }).catch(() => {}); // A remaining running record is recovered as interrupted on restart.
            }).finally(() => { running.delete(record.id); release(); });
            return { ...record };
        }),
        cancel: id => serial(async () => {
            await init(); const record = await read(id);
            if (record.status === 'running') running.get(id)?.abort();
            return record;
        }),
        image: id => serial(async () => {
            await init(); const record = await read(id);
            if (record.status !== 'completed') throw fail('圖片尚未完成。', 409);
            const bytes = await fs.readFile(file(id, '.image'));
            return { mime: imageType(bytes), base64: bytes.toString('base64') };
        }),
        stop: () => { for (const controller of running.values()) controller.abort(); }
    };
}
async function imageRoute(req, json, jobs, prefix, token) {
    if (!(req.url === prefix || req.url.startsWith(prefix + '/'))) return false;
    if (req.headers['x-roam-token'] !== token) throw fail('圖片連線已更新，請重新檢查連線。', 403, 'TOKEN');
    const parts = req.url.slice(prefix.length).split('/').filter(Boolean);
    if (req.method === 'GET' && parts.length === 1) json(200, await jobs.get(parts[0]));
    else if (req.method === 'GET' && parts.length === 2 && parts[1] === 'image') json(200, await jobs.image(parts[0]));
    else if (req.method === 'POST' && parts.length === 2 && parts[1] === 'cancel') json(200, await jobs.cancel(parts[0]));
    else if (req.method === 'POST' && !parts.length) {
        if (req.headers['content-type'] !== 'application/json') throw fail('請使用 JSON。', 415);
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 16384) throw fail('插圖主題過長。', 413); chunks.push(chunk); }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('插圖請求 JSON 無效。'); }
        json(202, await jobs.create(body));
    } else throw fail('不支援此圖片操作。', 405);
    return true;
}
module.exports = { createImageJobs, imageRoute, validateSubject };
