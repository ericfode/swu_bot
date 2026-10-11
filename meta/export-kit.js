'use strict';

/**
 * Publishes the Atlas kit for other pages: node meta/export-kit.js [out dir]   (default /mnt/project-files/meta/kit)
 * Writes atlas-kit.js, kit.json (all words and data, no code), kit.css, README.md, demo.html and spots/<id>[-full][-anim].svg.
 * refresh.sh runs it every hour, so the shared copy always matches the Atlas.
 */
const fs = require('fs');
const path = require('path');
const K = require('./atlas-kit.js');

const out = process.argv[2] || '/mnt/project-files/meta/kit';
fs.mkdirSync(path.join(out, 'spots'), { recursive: true });

// Write through a temp file so a page reading the folder never sees half a file.
const put = (rel, text) => { const f = path.join(out, rel); fs.writeFileSync(f + '.tmp', text); fs.renameSync(f + '.tmp', f); };

const svgCss = K.css({ scope: 'svg' });
const wrap = (spot, body, w) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 150" width="${w}" height="${w * 150 / 240}" role="img" aria-label="${spot.label}: ${spot.short}"><title>${spot.label}: ${spot.short}</title><style>${svgCss}</style>${body}</svg>\n`;

/** One looping SVG: hold the even opening, tween into the spot, hold the spot. Frames switch with SMIL, so it plays in an <img>. */
function animated(spot, mini) {
  const T = K.TIMING, total = T.hold0 + T.tween + T.hold1, steps = 24;
  const frames = [{ k: 0, t0: 0, t1: T.hold0 }];
  for (let i = 1; i < steps; i++) frames.push({ k: K.ease(i / steps), t0: T.hold0 + (i - 1) * T.tween / (steps - 1), t1: T.hold0 + i * T.tween / (steps - 1) });
  frames.push({ k: 1, t0: T.hold0 + T.tween, t1: total });
  const f = (x) => +(x / total).toFixed(4);
  const body = frames.map(({ k, t0, t1 }) => {
    const a = f(t0), b = f(t1);
    const anim = a === 0 ? `values="1;0" keyTimes="0;${b}"` : b >= 1 ? `values="0;1" keyTimes="0;${a}"` : `values="0;1;0" keyTimes="0;${a};${b}"`;
    return `<g opacity="${a === 0 ? 1 : 0}"><animate attributeName="opacity" dur="${total / 1000}s" repeatCount="indefinite" calcMode="discrete" ${anim}/>${K.drawBoard(spot.id, k, { mini })}</g>`;
  }).join('');
  return wrap(spot, body, mini ? 120 : 480);
}

for (const s of K.SPOTS) {
  put(`spots/${s.id}.svg`, wrap(s, K.drawBoard(s.id, 1, { mini: true }), 120));
  put(`spots/${s.id}-full.svg`, wrap(s, K.drawBoard(s.id, 1), 480));
  put(`spots/${s.id}-anim.svg`, animated(s, false));
  put(`spots/${s.id}-mini-anim.svg`, animated(s, true));
}

put('atlas-kit.js', fs.readFileSync(path.join(__dirname, 'atlas-kit.js'), 'utf8'));
put('kit.json', JSON.stringify({
  schema: 'atlas-kit/1', version: K.VERSION, generatedAt: new Date().toISOString(),
  groups: K.GROUPS, spots: K.SPOTS, open: K.OPEN, iconParts: K.ICON_PARTS, styles: K.STYLES, traits: K.TRAITS,
  families: K.FAMILIES, terms: K.TERMS, tokens: K.TOKENS, minGames: K.MIN_GAMES, thin: K.THIN, edgeSteps: K.EDGE_STEPS,
  cssVars: K.CSS_VARS, cssClasses: K.CSS_CLASSES,
}, null, 1));
put('kit.css', K.css() + '\n');
put('README.md', fs.readFileSync(path.join(__dirname, 'kit-README.md'), 'utf8'));

put('demo.html', `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Atlas Kit</title><script src="atlas-kit.js"></script>
<style>
body { margin: 0; padding: 24px 16px 48px; background: #f5f6f8; color: var(--ink); font: 15px/1.45 system-ui, sans-serif; }
@media (prefers-color-scheme: dark) { body { background: #0e1118; } }
main { max-width: 980px; margin: 0 auto; display: grid; gap: 28px; }
h1, h2 { margin: 0; font-family: "Saira Semi Condensed", "Arial Narrow", system-ui, sans-serif; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.tile { background: var(--panel); border: 1px solid var(--line-2); border-radius: 10px; padding: 10px; display: grid; gap: 4px; }
.tile svg { width: 100%; height: auto; } .tile b { font-size: 14px; } .tile small { color: var(--ink-2); }
.guide { background: var(--panel); border: 1px solid var(--line-2); border-radius: 10px; padding: 14px; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: center; }
@media (max-width: 700px) { .guide { grid-template-columns: 1fr; } }
#g { width: 100%; max-width: 440px; height: auto; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 0; } dt { font-weight: 600; } dd { margin: 0; color: var(--ink-2); }
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 6px; }
</style></head><body><main>
<header><h1>Atlas Kit</h1><p>The Strategy Atlas's spot icons, styles, families and terms, for every page that describes bots.</p></header>
<section class="guide"><svg id="g" viewBox="0 0 240 150"></svg><div><h2 id="gt"></h2><p id="gs"></p><p><small id="gr"></small></p></div></section>
<section><h2>Spots</h2><div class="grid" id="spots"></div></section>
<section><h2>Reading an icon</h2><dl id="parts"></dl></section>
<section><h2>Styles</h2><dl id="styles"></dl></section>
<section><h2>Families</h2><dl id="fams"></dl></section>
<section><h2>Terms</h2><dl id="terms"></dl></section>
</main><script>
const K = AtlasKit; K.injectCss();
const $ = (id) => document.getElementById(id);
$('spots').innerHTML = K.SPOTS.map((s) => '<div class="tile">' + K.spotSvg(s.id) + '<b>' + s.label + '</b><small>' + s.short + '</small></div>').join('');
$('parts').innerHTML = K.ICON_PARTS.map((p) => '<dt>' + p.part + '</dt><dd>' + p.text + '</dd>').join('');
$('styles').innerHTML = K.STYLES.map((s) => '<dt>' + s.id + '</dt><dd>' + s.text + '</dd>').join('');
$('fams').innerHTML = K.FAMILIES.map((f) => '<dt><span class="dot" style="background:var(--f-' + f.id + ')"></span>' + f.label + '</dt><dd>family "' + f.family + '"</dd>').join('');
$('terms').innerHTML = Object.entries(K.TERMS).map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('');
K.animate($('g'), { onSpot: (s) => { $('gt').textContent = s.label; $('gs').textContent = s.say; $('gr').textContent = 'counts when, at the start of a round: ' + s.short; } });
</script></body></html>
`);
console.log(`kit: ${out} (${K.SPOTS.length} spots x 4 SVGs, atlas-kit.js, kit.json, kit.css, demo.html, README.md)`);
