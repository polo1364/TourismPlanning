'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
// An explicit list keeps local services, test reports and credentials out of Pages.
const files = [
    'index.html', 'favicon.ico', 'styles.css', 'editorial.css', 'scenes.css', 'book.css', 'boarding.css', 'postcard.css',
    'deepseek.js', 'codex-local.js', 'motion-ui.js', 'planner-checks.js',
    'planner-ui.js', 'trip-store.js', 'trip-library.js', 'scene-ui.js', 'book-ui.js', 'book-export.js', 'boarding-ui.js',
    'vendor/motion.js', 'vendor/motion.LICENSE.md',
    'assets/roam-coast.png', 'assets/roam-town.png'
];
function build(output = path.join(root, 'dist')) {
    // Fail on an existing output instead of accidentally publishing stale files.
    fs.mkdirSync(output);
    for (const file of files) {
        const destination = path.join(output, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(root, file), destination);
    }
    fs.writeFileSync(path.join(output, '.nojekyll'), '');
    return files.length + 1;
}
if (require.main === module) console.log(`Pages: ${build()} static files copied to dist/`);
module.exports = { build, files };
