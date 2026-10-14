'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 5 * 1024 * 1024;
const ID = /^[a-f0-9]{48}$/;
const problem = (message, status) => Object.assign(new Error(message), { status, code: 'SHARE' });
// The header is authoritative even if uploaded HTML contains a different meta CSP.
// An opaque sandbox origin cannot access the owner's storage or authenticated APIs.
const PUBLIC_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox";

function createShareStore(directory) {
    let queue = Promise.resolve();
    const serial = work => {
        const result = queue.then(work);
        queue = result.catch(() => {});
        return result;
    };
    const file = id => path.join(directory, id + '.json');
    async function read(id) {
        if (!ID.test(id)) return null;
        try { return JSON.parse(await fs.readFile(file(id), 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
    async function list() {
        let names;
        try { names = await fs.readdir(directory); }
        catch (error) { if (error.code === 'ENOENT') return []; throw error; }
        const records = [];
        for (const name of names.filter(name => /^[a-f0-9]{48}\.json$/.test(name))) {
            const record = await read(name.slice(0, -5));
            if (record) records.push({ id: record.id, title: record.title, createdAt: record.createdAt });
        }
        return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    return {
        read,
        list: () => serial(list),
        create: body => serial(async () => {
            if (!body || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200 ||
                typeof body.html !== 'string' || !/^<!doctype html>/i.test(body.html) || !body.html.includes('data-roam-book="1"')) {
                throw problem('請重新整理頁面，再建立小冊分享。', 400);
            }
            if (Buffer.byteLength(body.html) > MAX_BYTES) throw problem('小冊超過 5 MB，請減少內容後再分享。', 413);
            if ((await list()).length >= 50) throw problem('最多保留 50 份分享，請先取消不再使用的分享。', 409);
            await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            const record = { id: crypto.randomBytes(24).toString('hex'), title: body.title.trim(), createdAt: new Date().toISOString(), html: body.html };
            const temporary = path.join(directory, record.id + '.tmp');
            try {
                await fs.writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
                await fs.rename(temporary, file(record.id));
            } catch (error) {
                await fs.unlink(temporary).catch(() => {});
                throw error;
            }
            const { html, ...metadata } = record;
            return metadata;
        }),
        revoke: id => serial(async () => {
            if (!ID.test(id)) throw problem('分享網址無效。', 400);
            try { await fs.unlink(file(id)); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        })
    };
}

module.exports = { createShareStore, MAX_BYTES, PUBLIC_CSP, ID };
