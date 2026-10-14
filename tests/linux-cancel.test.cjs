const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCodex } = require('../codex-bridge.cjs');

test('Linux cancellation terminates a fake CLI launcher and its child', { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'roam-cancel-test-'));
    const launcher = path.join(folder, 'node_modules/@openai/codex/bin/codex.js');
    const pidFile = path.join(folder, 'pids.json');
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(launcher, `const cp=require('node:child_process'); const fs=require('node:fs'); const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)']); fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000);`);
    const oldPath = process.env.PATH;
    const abort = new AbortController();
    let pids = [];
    try {
        process.env.PATH = folder;
        const job = runCodex('fake cancellation test; no network or AI', abort.signal);
        const outcome = job.then(() => null, error => error);
        for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 30));
        assert.ok(fs.existsSync(pidFile), 'fake CLI started');
        pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
        abort.abort();
        assert.equal((await outcome).code, 'CANCELLED');
        await new Promise(resolve => setTimeout(resolve, 100));
        for (const pid of pids) {
            const stat = `/proc/${pid}/stat`;
            assert.ok(!fs.existsSync(stat) || /\) Z /.test(fs.readFileSync(stat, 'utf8')), `process ${pid} stopped`);
        }
    } finally {
        abort.abort(); process.env.PATH = oldPath;
        for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
        fs.rmSync(folder, { recursive: true, force: true });
    }
});
