'use strict';

/**
 * Inlines meta.json, theory.json and the shared viewer kit into page.html:
 *   node meta/build-page.js <meta.json> <theory.json> <out.html> [viewer-kit.js]
 */
const fs = require('fs');
const path = require('path');

const [metaFile, theoryFile, out, kitFile = '/mnt/project-files/viewer-kit/swu-viewer-kit.js'] = process.argv.slice(2);
const tpl = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');
const safe = (s) => s.replace(/</g, '\\u003c');
const meta = fs.readFileSync(metaFile, 'utf8');
const theory = fs.existsSync(theoryFile) ? fs.readFileSync(theoryFile, 'utf8') : '{"versions":[]}';
const kit = fs.existsSync(kitFile) ? fs.readFileSync(kitFile, 'utf8').replace(/<\/script/gi, '<\\/script') : '';
// Function replacers: the kit's source contains `$&`-style sequences that a string replacement would expand.
const html = tpl
    .replace('/*__META__*/null', () => safe(meta))
    .replace('/*__THEORY__*/null', () => safe(theory))
    .replace('/*__KIT__*/', () => kit);
fs.writeFileSync(out, html);
console.log(`page: ${out} (${(html.length / 1024).toFixed(0)} KB)`);
