const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { build, files } = require('../scripts/build-pages.cjs');

test('Pages artifact contains only the allowlisted frontend and all relative HTML assets', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'roam-pages-test-'));
    const output = path.join(temp, 'dist');
    try {
        assert.equal(build(output), 28);
        const actual = fs.readdirSync(output, { recursive: true }).filter(file => fs.statSync(path.join(output, file)).isFile());
        assert.deepEqual(actual.map(file => file.replaceAll('\\', '/')).sort(), [...files, '.nojekyll'].sort());
        const html = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
        for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
            if (/^(https?:|\$)/.test(match[1])) continue;
            assert.ok(fs.existsSync(path.join(output, match[1])), match[1]);
        }
        fs.writeFileSync(path.join(output, 'unexpected.txt'), 'stale');
        assert.throws(() => build(output), { code: 'EEXIST' });
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

for (const saved of [null, 'codex']) {
    test(`public origin never probes loopback or silently switches saved provider (${saved})`, async () => {
        const elements = Object.fromEntries(['aiProvider', 'deepseekSettings', 'codexSettings', 'codexStatus', 'hostedNotice'].map(id => [id, { value: id === 'aiProvider' ? 'deepseek' : '', hidden: true }]));
        let requests = 0;
        const context = vm.createContext({
            location: { protocol: 'https:', hostname: 'polo1364.github.io' },
            document: { getElementById: id => elements[id] },
            localStorage: { getItem: () => saved },
            window: {}, updateApiStatus() {}, isBusy: false,
            fetch() { requests++; throw new Error('Unexpected loopback request'); }
        });
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../codex-local.js'), 'utf8'), context);
        await context.window.CodexLocal.init();
        assert.equal(elements.hostedNotice.hidden, false);
        assert.equal(elements.aiProvider.value, saved || 'deepseek');
        await assert.rejects(context.window.CodexLocal.generate('test'), /僅供本機版/);
        assert.equal(requests, 0);
    });
}
