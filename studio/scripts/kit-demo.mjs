// Writes a single-file demo page for the viewer kit: the IIFE bundle, one game and (optionally) its evals and lens inlined.
//   node scripts/kit-demo.mjs <game.jsonl> [evals.json] [out.html] [--lens lens.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const li = argv.indexOf('--lens');
const lensPath = li >= 0 ? argv.splice(li, 2)[1] : null;
const [gamePath, evalsPath, outPath = path.join(here, '..', 'dist-kit', 'demo.html')] = argv;
if (!gamePath) {
    console.error('usage: node scripts/kit-demo.mjs <game.jsonl> [evals.json] [out.html]');
    process.exit(1);
}
const kit = fs.readFileSync(path.join(here, '..', 'dist-kit', 'swu-viewer-kit.js'), 'utf8');
const jsonl = fs.readFileSync(gamePath, 'utf8');
const evals = evalsPath && fs.existsSync(evalsPath) ? fs.readFileSync(evalsPath, 'utf8') : 'null';
const lens = lensPath && fs.existsSync(lensPath) ? fs.readFileSync(lensPath, 'utf8') : 'null';
// </script> inside inlined text would end the script element early
const safe = (s) => s.replace(/<\/script/gi, '<\\/script');

const html = `<meta charset="utf-8">
<title>SWU Viewer Kit</title>
<style>
  /* A deliberately different host page: light, serif, its own resets. The kit renders in a shadow root and keeps its own look. */
  :root { --paper: #f4f2ee; --ink: #1d1b19; --muted: #6d6860; --rule: #d9d4cb; color-scheme: light; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.55 Georgia, 'Times New Roman', serif; }
  main { max-width: 1320px; margin: 0 auto; padding-block: 28px 64px; padding-inline: 16px; display: flex; flex-direction: column; gap: 28px; }
  h1 { font-size: 28px; margin: 0; } h2 { font-size: 18px; margin: 0 0 8px; } p { margin: 0; color: var(--muted); max-width: 70ch; }
  button { font: inherit; }
  .icons { display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-end; }
  .sizes { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 13px; background: #e9e5de; padding: 1px 5px; border-radius: 4px; }
</style>
<main>
  <header><h1>SWU viewer kit</h1><p>The same viewer Holotable uses, embedded in a page with completely different styles. Below: the full viewer with its evaluations and the omni bot's card values (press Lens), the compact layout, and the pivotal plays drawn with <code>mountActionIcon</code> at every size tier.</p></header>
  <section><h2>Full viewer</h2><div id="full"></div></section>
  <section><h2>Compact viewer</h2><div id="compact" style="max-width: 860px"></div></section>
  <section><h2>Pivotal plays</h2><div class="icons" id="pivotal"></div></section>
  <section><h2>One action at each size</h2><div class="sizes" id="sizes"></div></section>
</main>
<script>${safe(kit)}</script>
<script>
  const jsonl = ${JSON.stringify(safe(jsonl))};
  const evals = ${safe(evals)};
  const lens = ${safe(lens)};
  const game = SWUViewer.parseGame(jsonl, true);
  const full = SWUViewer.mount(document.getElementById('full'), { game, evals, lens });
  const compact = SWUViewer.mount(document.getElementById('compact'), { game, lens, layout: 'compact', step: Math.floor(game.steps.length / 2) });
  const bots = { p1: game.header.players[0].bot, p2: game.header.players[1].bot };
  const piv = SWUViewer.pivotal(game, evals, 8, lens);
  for (const a of piv) {
    const el = document.createElement('span');
    el.style.cursor = 'pointer';
    el.title = 'Jump the full viewer to this play';
    el.onclick = () => { full.seek(a.index); document.getElementById('full').scrollIntoView({ behavior: 'smooth' }); };
    document.getElementById('pivotal').appendChild(el);
    SWUViewer.mountActionIcon(el, { cls: a.cls, seat: a.seat, card: a.card, outcome: a.outcome, size: 110, caption: SWUViewer.describe(a, bots[a.seat]) + ' · step ' + game.steps[a.index].n });
  }
  const a0 = piv[0];
  if (a0) for (const size of [14, 18, 28, 40, 64, 120]) {
    const el = document.createElement('span');
    document.getElementById('sizes').appendChild(el);
    SWUViewer.mountActionIcon(el, { cls: a0.cls, seat: a0.seat, card: a0.card, outcome: a0.outcome, size, caption: SWUViewer.describe(a0, bots[a0.seat]) });
  }
</script>
`;
fs.writeFileSync(outPath, html);
console.log(`wrote ${outPath} (${(html.length / 1e6).toFixed(1)} MB)`);
