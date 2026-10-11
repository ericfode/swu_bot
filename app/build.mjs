#!/usr/bin/env node
// Builds the SWU Arena app (arena + research) into one self-contained HTML file. See app/README.md.
// The page opens on the snapshot built here and, where the viewer allows project files, keeps reading them live.
//
//   node app/build.mjs [--data DIR] [--out FILE] [--public]
//
// --data    the shared project folder to read (default $SWU_DATA, else /mnt/project-files)
// --out     output file (default app/dist/app.html, or app/dist/public.html with --public)
// --public  the friends build (Eric's pick 6): no Lab, no thread names, no live mode
// --shell   no data: the page loads it from the arena window's API (bot/arena/window.js); used for the window's image
//
// Parts reused read-only from their owners: the research console's loader and board glyphs (dashboard/site, in this
// repo once committed, else in the data folder), the Strategy Atlas kit (meta/atlas-kit.js), the viewer kit (studio, or its copy in the data folder)
// and the arena strategy renderer (arena/strategy, in the data folder).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const src = p => path.join(here, 'src', p);
const req = createRequire(import.meta.url);

function parseArgs(argv) {
    const o = { data: process.env.SWU_DATA || '/mnt/project-files', out: null, public: false, shell: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--public') o.public = true;
        else if (a === '--shell') o.shell = true;
        else if (a === '--data' || a === '--out') { if (argv[i + 1] == null) throw new Error(`${a} needs a value`); o[a.slice(2)] = argv[++i]; }
        else if (a === '-h' || a === '--help') o.help = true;
        else throw new Error(`unknown argument: ${a}`);
    }
    o.data = path.resolve(o.data);
    o.out = path.resolve(o.out || path.join(here, 'dist', o.public ? 'public.html' : 'app.html'));
    return o;
}

const opts = (() => { try { return parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); } })();
if (opts.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(3, 10).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
// a shell build reads an empty folder, so the page carries code and an empty model
const root = opts.shell ? fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'app-shell-')) : opts.data;
if (!opts.shell && !fs.existsSync(root)) { console.error(`data folder not found: ${root} (pass --data or set SWU_DATA)`); process.exit(2); }

// the first file that exists, else null
const first = (...ps) => ps.find(p => p && fs.existsSync(p)) || null;
const parts = {
    core: first(path.join(repo, 'dashboard/site/core.cjs'), path.join(opts.data, 'dashboard/site/core.cjs')),
    glyph: first(path.join(repo, 'dashboard/site/glyph.cjs'), path.join(opts.data, 'dashboard/site/glyph.cjs')),
    atlasKit: first(path.join(repo, 'meta/atlas-kit.js'), path.join(opts.data, 'meta/kit/atlas-kit.js')),
    viewerKit: first(path.join(repo, 'studio/dist-kit/swu-viewer-kit.js'), path.join(opts.data, 'viewer-kit/swu-viewer-kit.js')),
    strategy: first(path.join(opts.data, 'arena/strategy/strategy-diagram.js'), path.join(repo, 'bot/arena/web/strategy-diagram.js')),
};
for (const k of ['core', 'atlasKit']) if (!parts[k]) { console.error(`missing ${k}: the app needs it to load the data (see app/README.md)`); process.exit(2); }

const core = req(parts.core);
globalThis.AtlasKit = req(parts.atlasKit);
req(src('atlas.js')); // sets globalThis.SWUAtlas, which model.cjs uses for the Atlas framework
const model = req(src('model.cjs'));

const reader = {
    list: async d => { const p = path.join(root, d); if (!fs.existsSync(p)) return []; return fs.readdirSync(p, { withFileTypes: true }).map(e => ({ name: e.name, path: `${d}/${e.name}`, isDirectory: e.isDirectory() })); },
    text: async f => { const p = path.join(root, f); return fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null; },
};
const loaded = await core.loadSources(reader);
const extra = await model.loadExtra(reader);
const M = model.buildModel(loaded, extra, core);

// which games have a replay file (live mode loads any of them on demand)
const has = {};
for (const r of M.runs) if (r.dir && fs.existsSync(path.join(root, r.dir, 'games'))) has[r.id] = new Set(fs.readdirSync(path.join(root, r.dir, 'games')).map(f => f.replace(/\.jsonl$/, '')));
M.replay = M.games.map(g => (has[M.runs[g[0]].id]?.has(g[1]) ? 1 : 0)).join('');

// games bundled in the snapshot: the newest game, an arena round game, the analysed game, an omni game with card values
const bundle = {}, MAXB = 1.5e6;
const add = (run, id) => { const r = M.runs.find(x => x.id === run); if (!r?.dir) return false; const f = path.join(root, r.dir, 'games', `${id}.jsonl`); if (!fs.existsSync(f) || fs.statSync(f).size > MAXB) return false; const t = fs.readFileSync(f, 'utf8'); if ((t.match(/"t":"step"/g) || []).length < 2) return false; bundle[`${run}/${id}`] = t; return true; };
const picks = {};
for (const c of core.liveCandidates(loaded.runs)) if (add(c.run, c.id)) { picks.hero = `${c.run}/${c.id}`; break; }
const ar = M.runs.find(r => r.kind === 'arena' && r.dir);
if (ar) {
    const gs = M.games.filter(g => M.runs[g[0]].id === ar.id && g[4] < 2 && g[5]).sort((a, b) => b[5] - a[5]);
    for (const g of gs.slice(3)) if (add(ar.id, g[1])) { picks.arena = `${ar.id}/${g[1]}`; break; }
}
for (const e of loaded.evals || []) { const m = /results\/([^/]+)\/games\/([^/]+)\.jsonl$/.exec(e.replay || ''); if (m && add(m[1], m[2])) { picks.eval = `${m[1]}/${m[2]}`; break; } }
for (const lensId of ['heuristic-vs-omni-110', 'heuristic-vs-omni-104']) {
    const g = M.games.find(x => x[1] === lensId && M.replay[M.games.indexOf(x)] === '1');
    if (g && add(M.runs[g[0]].id, g[1])) { picks.lens = `${M.runs[g[0]].id}/${g[1]}`; break; }
}

// small boards for the live grid: the running games, the newest arena round games and the newest finished games,
// each cut to ~60 frames of slim state (the grid replays them when nothing is running in the snapshot)
const traces = {};
{
    const frames = t => {
        const steps = []; let end = null;
        for (const line of t.split('\n')) { if (!line) continue; if (line.startsWith('{"t":"step"')) { try { steps.push(JSON.parse(line)); } catch {} } else if (line.startsWith('{"t":"end"')) { try { end = JSON.parse(line); } catch {} } }
        const play = steps.filter(s => s.state?.round >= 1);
        if (play.length < 4) return null;
        const k = Math.max(1, Math.ceil(play.length / 60)), out = [];
        for (let i = 0; i < play.length; i += k) out.push(model.slimState(play[i].state));
        if ((play.length - 1) % k) out.push(model.slimState(play.at(-1).state));
        return { f: out, end: end ? { w: end.winner || null, r: end.round ?? null } : null };
    };
    const take = (ix, cap) => { let n = 0; for (const i of ix) { if (n >= cap) break; const g = M.games[i], r = M.runs[g[0]], key = `${r.id}/${g[1]}`; if (traces[key] || M.replay[i] !== '1') continue; const f = path.join(root, r.dir, 'games', `${g[1]}.jsonl`); if (!fs.existsSync(f) || fs.statSync(f).size > 3e6) continue; const tr = frames(fs.readFileSync(f, 'utf8')); if (tr) { traces[key] = tr; n++; } } };
    const newest = [...M.games.keys()].reverse();
    take(newest.filter(i => M.games[i][4] === 3), 12);
    const arenaRun = M.runs.findLastIndex(r => r.kind === 'arena' && r.dir);
    if (arenaRun >= 0) take(newest.filter(i => M.games[i][0] === arenaRun && M.games[i][4] < 2), 6);
    const perRun = {}; take(newest.filter(i => M.games[i][4] < 2 && M.games[i][5] >= 4 && M.replay[i] === '1' && (perRun[M.games[i][0]] = (perRun[M.games[i][0]] || 0) + 1) <= 3), 12);
}
const evals = Object.fromEntries((loaded.evals || []).map(e => [e.gameId, e]));
const lens = {};
for (const k of Object.keys(bundle)) { const id = k.split('/')[1], f = path.join(root, 'dashboard/lens', `${id}.json`); if (fs.existsSync(f)) lens[id] = JSON.parse(fs.readFileSync(f, 'utf8')); }

// card art for the bundled games
const art = {};
for (const t of Object.values(bundle)) for (const m of t.matchAll(/"s":"([A-Z0-9]+)_(\d+)"/g)) for (const back of ['', '-b']) {
    const k = `${m[1]}_${m[2]}${back}`, f = path.join(root, 'card-art', m[1], `${m[2]}${back}.webp`);
    if (!(k in art) && fs.existsSync(f)) art[k] = `data:image/webp;base64,${fs.readFileSync(f).toString('base64')}`;
}

// arena archived panels (test tournament) feed the round preview
const t0panels = [];
const t0dir = path.join(root, 'arena/archive/t0/panels');
if (fs.existsSync(t0dir)) for (const f of fs.readdirSync(t0dir).filter(f => /^arena-.*\.json$/.test(f) && f !== 'arena-leaderboard.json')) { try { t0panels.push(JSON.parse(fs.readFileSync(path.join(t0dir, f), 'utf8'))); } catch {} }

const DATA = { audience: opts.public ? 'public' : 'project', model: opts.public ? model.publicModel(M) : M, bundle, picks, evals, lens, art, t0panels: opts.public ? t0panels.map(model.publicPanel) : t0panels, traces };
const read = p => (p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const html = read(src('page.html'))
    .replace('/*__ATLASCSS__*/', () => globalThis.AtlasKit.css()) // the Atlas colours, from the kit (the app's own tokens follow and win)
    .replace('/*__CSS__*/', () => read(src('style.css')))
    .replace('/*__KIT__*/', () => read(parts.viewerKit))
    .replace('/*__CORE__*/', () => read(parts.core))
    .replace('/*__ATLASKIT__*/', () => read(parts.atlasKit))
    .replace('/*__ATLAS__*/', () => read(src('atlas.js')))
    .replace('/*__MODEL__*/', () => read(src('model.cjs')))
    .replace('/*__STRATEGY__*/', () => read(parts.strategy))
    .replace('/*__GLYPH__*/', () => read(parts.glyph))
    .replace('/*__APP__*/', () => read(src('app.js')))
    .replace('/*__DATA__*/null', () => JSON.stringify(DATA).replace(/</g, '\\u003c'));
fs.mkdirSync(path.dirname(opts.out), { recursive: true });
fs.writeFileSync(opts.out, html);
if (opts.shell) fs.rmSync(root, { recursive: true, force: true });
const missing = Object.entries(parts).filter(([, p]) => !p).map(([k]) => k);
console.log(JSON.stringify({ out: opts.out, audience: DATA.audience, bytes: html.length, bots: M.order.length, games: M.games.length, ratings: M.ratings.from, bundled: Object.keys(bundle).length, traces: Object.keys(traces).length, art: Object.keys(art).length, missing, warnings: loaded.warnings }));
