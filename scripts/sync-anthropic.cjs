const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const esbuild = require('esbuild');

// The page has no build step, so the official Anthropic SDK is bundled once into vendor/ as a browser global.
const root = path.resolve(__dirname, '..');
// The package does not export package.json, so read it from the installed directory.
const installed = path.join(root, 'node_modules', '@anthropic-ai', 'sdk');
const version = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).version;
const check = process.argv.includes('--check');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

const bundle = esbuild.buildSync({
    stdin: { contents: "export { default } from '@anthropic-ai/sdk';", resolveDir: root, loader: 'js' },
    bundle: true,
    format: 'iife',
    globalName: 'AnthropicSDK',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    write: false
}).outputFiles[0].contents;
const banner = Buffer.from(`/* @anthropic-ai/sdk ${version} (MIT) - bundled by scripts/sync-anthropic.cjs; see anthropic-sdk.LICENSE */\n`);
const files = [['anthropic-sdk.js', Buffer.concat([banner, Buffer.from(bundle)])], ['anthropic-sdk.LICENSE', fs.readFileSync(path.join(installed, 'LICENSE'))]];

if (!check) fs.mkdirSync(path.join(root, 'vendor'), { recursive: true });
for (const [name, data] of files) {
    const output = path.join(root, 'vendor', name);
    if (check) {
        if (!fs.existsSync(output) || hash(fs.readFileSync(output)) !== hash(data)) throw new Error(`Vendor copy is out of date: ${name}`);
    } else fs.writeFileSync(output, data);
}
console.log(`Anthropic SDK ${version}: local browser bundle ${check ? 'verified' : 'synced'}.`);
