'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const installed = path.dirname(require.resolve('pdfjs-dist/package.json'));
const version = require('pdfjs-dist/package.json').version;
const expectedVersion = require('../package.json').dependencies['pdfjs-dist'];
if (version !== expectedVersion) throw new Error(`Expected PDF.js ${expectedVersion}, installed ${version}. Run npm ci.`);
const check = process.argv.includes('--check');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const copies = [
    ['legacy/build/pdf.mjs', 'pdf.mjs'],
    ['legacy/build/pdf.worker.mjs', 'pdf.worker.mjs'],
    ['LICENSE', 'LICENSE']
];
// Explicit extension filters exclude source maps, viewers and the JavaScript sandbox.
for (const [directory, pattern] of [
    ['cmaps', /^(?:[A-Za-z0-9_-]+\.bcmap|LICENSE)$/],
    ['standard_fonts', /^(?:[A-Za-z0-9_-]+\.(?:pfb|ttf)|LICENSE_[A-Z]+)$/],
    ['wasm', /^(?:(?:jbig2|openjpeg|qcms_bg)\.wasm|(?:jbig2|openjpeg)_nowasm_fallback\.js|LICENSE_[A-Z0-9_]+)$/]
]) {
    for (const name of fs.readdirSync(path.join(installed, directory)).filter(name => pattern.test(name)).sort()) {
        copies.push([`${directory}/${name}`, `${directory}/${name}`]);
    }
}
const assets = copies.map(([source, destination]) => ({
    path: `vendor/pdfjs/${destination}`,
    source,
    sha256: hash(fs.readFileSync(path.join(installed, source)))
}));
const manifest = JSON.stringify({ version, assets }, null, 2) + '\n';
for (const asset of assets) {
    const output = path.join(root, asset.path);
    if (check) {
        if (!fs.existsSync(output) || hash(fs.readFileSync(output)) !== asset.sha256) throw new Error(`Vendor copy is out of date: ${asset.path}`);
    } else {
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.copyFileSync(path.join(installed, asset.source), output);
    }
}
const manifestPath = path.join(root, 'vendor/pdfjs/manifest.json');
if (check) {
    if (fs.readFileSync(manifestPath, 'utf8') !== manifest) throw new Error('PDF.js asset manifest is out of date.');
} else fs.writeFileSync(manifestPath, manifest);
console.log(`PDF.js ${version}: ${assets.length} local assets ${check ? 'verified' : 'synced'} (SHA-256).`);
