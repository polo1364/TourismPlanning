const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const installed = path.dirname(require.resolve('motion/package.json'));
const files = [['dist/motion.js', 'motion.js'], ['LICENSE.md', 'motion.LICENSE.md']];
const check = process.argv.includes('--check');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
if (!check) fs.mkdirSync(path.join(root, 'vendor'), { recursive: true });
for (const [source, destination] of files) {
    const input = fs.readFileSync(path.join(installed, source));
    const output = path.join(root, 'vendor', destination);
    if (check) {
        if (!fs.existsSync(output) || hash(fs.readFileSync(output)) !== hash(input)) throw new Error(`Vendor copy is out of date: ${destination}`);
    } else fs.writeFileSync(output, input);
}
console.log(`Motion ${require('motion/package.json').version}: local browser bundle ${check ? 'verified' : 'synced'}.`);
