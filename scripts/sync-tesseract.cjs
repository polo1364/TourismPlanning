'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const expected = require('../package.json').dependencies;
const packages = ['tesseract.js', 'tesseract.js-core', '@tesseract.js-data/chi_tra', '@tesseract.js-data/eng'];
const sources = Object.fromEntries(packages.map(name => {
    const directory = path.dirname(require.resolve(`${name}/package.json`));
    const version = require(path.join(directory, 'package.json')).version;
    if (version !== expected[name]) throw new Error(`Expected ${name} ${expected[name]}, installed ${version}. Run npm ci.`);
    return [name, { directory, version }];
}));
const copies = [
    ['tesseract.js', 'dist/worker.min.js', 'worker.min.js'],
    ['tesseract.js', 'dist/worker.min.js.LICENSE.txt', 'worker.LICENSE.txt'],
    ['tesseract.js', 'LICENSE.md', 'LICENSE.md'],
    ['tesseract.js-core', 'LICENSE', 'core/LICENSE']
];
// All LSTM variants selected by the pinned worker's feature detection are local.
for (const variant of ['', '-simd', '-relaxedsimd']) {
    for (const suffix of ['wasm.js', 'wasm']) {
        const file = `tesseract-core${variant}-lstm.${suffix}`;
        copies.push(['tesseract.js-core', file, `core/${file}`]);
    }
}
for (const language of ['chi_tra', 'eng']) {
    copies.push([`@tesseract.js-data/${language}`, `4.0.0_best_int/${language}.traineddata.gz`, `lang/${language}.traineddata.gz`]);
    copies.push([`@tesseract.js-data/${language}`, 'package.json', `lang/${language}.package.json`]);
    copies.push([`@tesseract.js-data/${language}`, 'README.md', `lang/${language}.README.md`]);
}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const assets = copies.map(([packageName, source, destination]) => ({ package: packageName, source, path: `vendor/tesseract/${destination}`, sha256: hash(fs.readFileSync(path.join(sources[packageName].directory, source))) }));
// The npm language packages omit their repository's full traineddata license.
// Pin the upstream copy, retaining original package metadata without inferring a license from it.
assets.push({ sourceURL: 'https://raw.githubusercontent.com/naptha/tessdata/806cd9adc8c6e8abc11c782db1818c990576bebc/LICENSE', path: 'vendor/tesseract/lang/LICENSE.tessdata', sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4' });
const manifest = JSON.stringify({ versions: Object.fromEntries(packages.map(name => [name, sources[name].version])), assets }, null, 2) + '\n';
const check = process.argv.includes('--check');
async function sync() {
for (const asset of assets) {
    const destination = path.join(root, asset.path);
    if (check) {
        if (!fs.existsSync(destination) || hash(fs.readFileSync(destination)) !== asset.sha256) throw new Error(`Vendor copy is out of date: ${asset.path}`);
    } else {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        if (asset.package) fs.copyFileSync(path.join(sources[asset.package].directory, asset.source), destination);
        else {
            const response = await fetch(asset.sourceURL, { redirect: 'error', signal: AbortSignal.timeout(20000) });
            if (!response.ok) throw new Error('Unable to fetch the pinned traineddata license.');
            const bytes = Buffer.from(await response.arrayBuffer());
            if (hash(bytes) !== asset.sha256) throw new Error('The traineddata license checksum does not match.');
            fs.writeFileSync(destination, bytes);
        }
    }
}
const manifestPath = path.join(root, 'vendor/tesseract/manifest.json');
if (check) {
    if (fs.readFileSync(manifestPath, 'utf8') !== manifest) throw new Error('Tesseract asset manifest is out of date.');
} else fs.writeFileSync(manifestPath, manifest);
console.log(`Tesseract.js ${sources['tesseract.js'].version}: ${assets.length} local assets ${check ? 'verified' : 'synced'} (SHA-256).`);
}
sync().catch(error => { console.error(error.message); process.exitCode = 1; });
