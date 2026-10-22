'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pdfAssets = require('../vendor/pdfjs/manifest.json').assets.map(asset => asset.path);
if (pdfAssets.some(file => !/^vendor\/pdfjs\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(file) || file.includes('..'))) throw new Error('Invalid PDF.js asset manifest.');
// An explicit list keeps local services, test reports and credentials out of Pages.
const files = [
    'index.html', 'favicon.ico', 'styles.css', 'editorial.css', 'scenes.css', 'book.css', 'boarding.css', 'postcard.css',
    'deepseek.js', 'codex-local.js', 'motion-ui.js', 'planner-checks.js',
    'itinerary-file.js', 'itinerary-import.js', 'itinerary-import.css',
    'planner-ui.js', 'trip-store.js', 'trip-library.js', 'scene-ui.js', 'book-ui.js', 'book-export.js', 'boarding-ui.js',
    'artwork-core.js', 'artwork-store.js', 'artwork-ui.js', 'artwork.css',
    'vendor/motion.js', 'vendor/motion.LICENSE.md',
    'assets/roam-coast.png', 'assets/roam-town.png',
    'vendor/pdfjs/manifest.json', ...pdfAssets
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
