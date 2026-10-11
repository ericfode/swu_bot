'use strict';

/**
 * Inlines meta.json, theory.json, the Atlas kit (atlas-kit.js) and the shared viewer kit into page.html:
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
const atlasKitFile = path.join(__dirname, 'atlas-kit.js');
const atlasKit = fs.readFileSync(atlasKitFile, 'utf8');

// The kit's spot names must match what analyze.js measured, or the icons would describe the wrong spots.
const { SPOT } = require(atlasKitFile);
for (const s of JSON.parse(meta).situations) {
    const k = SPOT[s.id];
    if (!k || k.label !== s.label || k.short !== s.short) throw new Error(`atlas-kit.js spot ${s.id} does not match analyze.js SITUATIONS`);
}
// Function replacers: the kit's source contains `$&`-style sequences that a string replacement would expand.
const html = tpl
    .replace('/*__META__*/null', () => safe(meta))
    .replace('/*__THEORY__*/null', () => safe(theory))
    .replace('/*__ATLAS_KIT__*/', () => atlasKit)
    .replace('/*__KIT__*/', () => kit);
fs.writeFileSync(out, html);
console.log(`page: ${out} (${(html.length / 1024).toFixed(0)} KB)`);
