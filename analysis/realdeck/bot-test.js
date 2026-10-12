'use strict';

/**
 * The standard bot test on the real decks: one pass of the real Premier deck lists against c-clock, on the same deals
 * as every bot tested before, then one report on every bot tested so far.
 *
 *   node analysis/realdeck/bot-test.js --bot <bot> [--mirror] [--record] [--workers N] [--dir <folder>] [--panel <file>]
 *   node analysis/realdeck/bot-test.js --report [--dir <folder>] [--panel <file>]
 *   (npm run realdeck:test -- ...; --dry-run prints the commands without playing)
 *
 * --bot plays `node bot/ladder.js --decks <deck file> --bots <bot> --vs c-clock --games 2P --seed 1 --key K` into
 * <dir>/test-<bot>-<n> (P = deck pairs: 702 games for 27 decks, every deck pair twice with the seats swapped). K is the
 * run key of the first finished gauntlet against c-clock in <dir> on the same deck file and seed, so every bot gets the
 * same deals and two bots pair game for game. With no such gauntlet yet, ladder.js draws a new key and that run sets
 * the deals for the ones after it. --mirror also plays the bot against itself (<dir>/mirror-<bot>-<n>, one pass) and
 * reruns compare.js into <dir>/compare-702.json, so the report has the bot's agreement with humans. --record keeps
 * every game (games/<id>.jsonl, the replay format). --resume <run id> finishes a gauntlet that stopped (ladder.js
 * --resume: the games already played are kept).
 *
 * The report reads every gauntlet in <dir> against c-clock on that deck file, seed and key (the others are listed with
 * the reason they were left out), keeps the newest run of each challenger (by createdAt: a bot tested again replaces
 * its older games), joins them with <dir>/compare-702.json (compare.js on one-pass mirrors) through skill.js and
 * writes <dir>/skill.json and skill.txt. --panel <file> also writes the research dashboard panel (dashboard README
 * section 5): each bot's score against c-clock as a face-off, a table of each bot's score by the deck type it holds,
 * the latest bot's deck-type row as face-offs, and agreement with humans for the bots with a mirror. The prose fields
 * of an existing panel file (goal, mental model, plan, thoughts) are kept.
 *
 * <dir> defaults to /mnt/project-files/human-meta/realdeck when that folder exists, else results/realdeck in the repo.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readDeckFile, deckMeta } = require('./compare');
const { STYLES, readGauntlet, skillVsAgreement, summaryText } = require('./skill');

const ROOT = path.join(__dirname, '..', '..');
const REFERENCE = 'c-clock';
const DECKS = path.join(ROOT, 'bot', 'decks', 'ash-meta-2026-09.json');
const SEED = 1;
const COMPARE = 'compare-702.json';
const SHARED = '/mnt/project-files/human-meta/realdeck';
const ONLINE = '/mnt/project-files/human-meta/swustats/human-summary.json';
const PANEL_ID = 'realdeck-test';
const THREAD = 'Analyze real human games';
const STYLE_LABEL = { hyperaggro: 'Hyper-aggro', softaggro: 'Soft aggro', midrange: 'Midrange', softcontrol: 'Soft control', hardcontrol: 'Hard control' };
// Atlas edge scale (meta/kit/kit.json edgeSteps and its --pos-N / --neg-N tokens, light and dark)
const EDGE_STEPS = [0.03, 0.08, 0.14, 0.22, 0.32];
const EDGE = {
    light: { pos: ['#dbe8fb', '#a9c8f3', '#5f9be8', '#2a6fd0', '#184f95'], neg: ['#fbe0dc', '#f4b0a6', '#e8735f', '#cc4632', '#962a1c'], ink: '#0f1420', ink2: '#4a5263', line: '#c9ced8', strong: '#ffffff' },
    dark: { pos: ['#1d2c45', '#23467a', '#2f66b3', '#4a8ae6', '#8db8f5'], neg: ['#3a2220', '#6a2f27', '#a5412f', '#d9654f', '#f2a092'], ink: '#eef0f4', ink2: '#b4bac8', line: '#343a48', strong: '#0f1420' }
};

function parseArgs(argv) {
    const a = { bot: null, mirror: false, record: false, workers: null, dir: null, panel: null, report: false, dryRun: false, decks: DECKS, compare: null, online: null, resume: null };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const value = () => {
            if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
                throw new Error(`${k} needs a value`);
            }
            return argv[++i];
        };
        if (k === '--bot') {
            a.bot = value();
        } else if (k === '--mirror') {
            a.mirror = true;
        } else if (k === '--record') {
            a.record = true;
        } else if (k === '--workers') {
            a.workers = value();
        } else if (k === '--dir') {
            a.dir = value();
        } else if (k === '--panel') {
            a.panel = value();
        } else if (k === '--report') {
            a.report = true;
        } else if (k === '--dry-run') {
            a.dryRun = true;
        } else if (k === '--decks') {
            a.decks = value();
        } else if (k === '--compare') {
            a.compare = value();
        } else if (k === '--online') {
            a.online = value();
        } else if (k === '--resume') {
            a.resume = value();
        } else {
            throw new Error(`unknown option ${k}`);
        }
    }
    if (!a.bot && !a.report) {
        throw new Error('give --bot <bot> to test a bot, or --report to rebuild the report');
    }
    if (a.bot && /[#,\s]/.test(a.bot)) {
        throw new Error(`--bot takes one bot name without a #tag, got ${JSON.stringify(a.bot)}`);
    }
    if (a.resume && !a.bot) {
        throw new Error('--resume <run id> goes with --bot');
    }
    if (a.bot === REFERENCE) {
        throw new Error(`${REFERENCE} is the reference: it scores 50% by definition`);
    }
    return a;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** ladder.js keeps the run key out of ladder.json until the run is done and names it meanwhile by this id. */
const keyId = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);

/** 'h@linear-deck-g4' -> 'h-linear-deck-g4', for run ids. */
const slug = (bot) => String(bot).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'bot';

/** The first free `<prefix>-<n>` folder name in dir. */
function nextId(dir, prefix) {
    let n = 1;
    while (fs.existsSync(path.join(dir, `${prefix}-${n}`))) {
        n++;
    }
    return `${prefix}-${n}`;
}

/** Every run folder in dir whose ladder.json reads: [{dir, id, createdAt, status, config}], oldest first. */
function listRuns(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, e.name, 'ladder.json');
        if (!e.isDirectory() || !fs.existsSync(file)) {
            continue;
        }
        let doc;
        try {
            doc = readJson(file);
        } catch {
            continue; // a run that has not written its first report yet
        }
        out.push({ dir: path.join(dir, e.name), id: String(doc.id ?? e.name), createdAt: doc.createdAt ?? null, status: doc.status ?? null, config: doc.config ?? {} });
    }
    return out.sort((x, y) => String(x.createdAt ?? '').localeCompare(String(y.createdAt ?? '')) || x.id.localeCompare(y.id));
}

/**
 * The gauntlets of the standard test among runs (from listRuns): against the reference alone, on this deck file
 * (sha256) and first seed, dealt from the key of the first finished one. Returns {key, keyId, use, ignored}; key is null
 * while no finished gauntlet has published one (then only that question is open, and nothing is used).
 */
function standardGauntlets(runs, { reference = REFERENCE, sha256, firstSeed = SEED }) {
    const ignored = [];
    const candidates = [];
    for (const r of runs) {
        const c = r.config;
        if (c.format !== 'gauntlet') {
            continue;
        }
        const why = !Array.isArray(c.vs) || c.vs.length !== 1 || c.vs[0] !== reference ? `plays against ${JSON.stringify(c.vs)}, the test is against ${reference}`
            : c.decks?.sha256 !== sha256 ? 'another deck file'
                : c.firstSeed !== firstSeed ? `first seed ${c.firstSeed}, the test uses ${firstSeed}` : null;
        if (why) {
            ignored.push({ id: r.id, reason: why });
        } else {
            candidates.push(r);
        }
    }
    const first = candidates.find((r) => r.status === 'done' && typeof r.config.key === 'string');
    if (!first) {
        return { key: null, keyId: null, use: [], ignored: [...ignored, ...candidates.map((r) => ({ id: r.id, reason: 'no finished gauntlet has set the deals yet' }))] };
    }
    const id = keyId(first.config.key);
    const use = [];
    for (const r of candidates) {
        const rid = typeof r.config.key === 'string' ? keyId(r.config.key) : r.config.keyId ?? null;
        if (rid === id) {
            use.push(r);
        } else {
            ignored.push({ id: r.id, reason: rid === null ? 'its key is not known (a run from before ladder.js named it)' : 'another key, so other deals' });
        }
    }
    return { key: first.config.key, keyId: id, use, ignored };
}

const base = (name) => String(name).replace(/#.*$/, '');

/**
 * Keeps each challenger's newest run (by createdAt, then id). runs: [{id, createdAt, vs, challengers, games}]. A bot
 * tested again loses its games in the older runs; a run left with no challenger is dropped. Returns {runs, superseded}.
 */
function newestPerChallenger(runs) {
    const newer = (x, y) => String(x.createdAt ?? '').localeCompare(String(y.createdAt ?? '')) > 0
        || (String(x.createdAt ?? '') === String(y.createdAt ?? '') && x.id > y.id);
    const owner = new Map();
    for (const r of runs) {
        for (const c of r.challengers) {
            const cur = owner.get(base(c));
            if (!cur || newer(r, cur)) {
                owner.set(base(c), r);
            }
        }
    }
    const superseded = [];
    const out = [];
    for (const r of runs) {
        const drop = new Set(r.challengers.map(base).filter((b) => owner.get(b) !== r));
        for (const b of drop) {
            superseded.push({ bot: b, run: r.id, by: owner.get(b).id });
        }
        if (!drop.size) {
            out.push(r);
            continue;
        }
        const challengers = r.challengers.filter((c) => !drop.has(base(c)));
        if (challengers.length) {
            const ref = r.vs[0];
            out.push({ ...r, challengers, games: r.games.filter((g) => !drop.has(base(g.p1 === ref ? g.p2 : g.p1))) });
        }
    }
    return { runs: out, superseded };
}

const pct = (x) => (x === null || x === undefined ? '-' : `${Math.round(100 * x)}`);
const r3 = (x) => (x === null || x === undefined ? null : Math.round(x * 1000) / 1000);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Edge step of a score against 50%: 0 (level) to 5, signed. */
function edgeStep(rate) {
    const d = rate - 0.5;
    const n = EDGE_STEPS.filter((s) => Math.abs(d) >= s).length;
    return d < 0 ? -n : n;
}

/** Aggro minus control from a deck-type row: score with hyper and soft aggro decks minus soft and hard control. */
function aggroMinusControl(row) {
    const pool = (names) => {
        const xs = names.map((s) => row?.[s]).filter(Boolean);
        const n = xs.reduce((a, x) => a + x.decided, 0);
        return n ? xs.reduce((a, x) => a + x.score, 0) / n : null;
    };
    const a = pool(['hyperaggro', 'softaggro']);
    const c = pool(['softcontrol', 'hardcontrol']);
    return a === null || c === null ? null : a - c;
}

/** The deck-type table as a self-contained html widget (it renders in a sandboxed frame, so the colours are inline). */
function styleTableHtml(bots, reference) {
    const cols = STYLES.filter((s) => bots.some((b) => b.skill.byStyle?.[s]));
    const vars = (t) => `--ink:${t.ink};--ink2:${t.ink2};--line:${t.line};--strong:${t.strong};${t.pos.map((c, i) => `--p${i + 1}:${c}`).join(';')};${t.neg.map((c, i) => `--n${i + 1}:${c}`).join(';')}`;
    const cell = (x) => {
        if (!x) {
            return '<td>-</td>';
        }
        const s = edgeStep(x.winRate);
        const cls = s > 0 ? ` class="p${s}"` : s < 0 ? ` class="n${-s}"` : '';
        return `<td${cls} title="${esc(`${x.score} of ${x.decided} decided games`)}">${pct(x.winRate)}%</td>`;
    };
    const rows = bots.map((b) => {
        const gap = aggroMinusControl(b.skill.byStyle);
        return `<tr><td class="b">${esc(b.bot)}</td>${cols.map((s) => cell(b.skill.byStyle[s])).join('')}<td class="o">${pct(b.skill.winRate)}%</td>` +
            `<td class="o">${gap === null ? '-' : `${gap >= 0 ? '+' : '−'}${Math.abs(Math.round(100 * gap))}`}</td></tr>`;
    }).join('');
    return '<style>' +
        `:root{color-scheme:light dark;${vars(EDGE.light)}}@media (prefers-color-scheme:dark){:root{${vars(EDGE.dark)}}}` +
        'body{margin:0;font:13px system-ui,sans-serif;color:var(--ink);background:transparent}' +
        'table{border-collapse:collapse;width:100%;font:inherit}th{font-weight:600;color:var(--ink2);padding:4px;text-align:center;font-size:12px}' +
        'td{padding:6px 4px;text-align:center;border-top:1px solid var(--line);font-variant-numeric:tabular-nums}' +
        'td.b{text-align:left;overflow-wrap:anywhere;min-width:7em}td.o{color:var(--ink2)}.w{overflow-x:auto}' +
        '@media (max-width:480px){body{font-size:11px}th{font-size:10px;padding:3px 1px}td{padding:5px 2px}td.b{min-width:5em}}' +
        '.p1{background:var(--p1)}.p2{background:var(--p2)}.p3{background:var(--p3)}.p4{background:var(--p4);color:var(--strong)}.p5{background:var(--p5);color:var(--strong)}' +
        '.n1{background:var(--n1)}.n2{background:var(--n2)}.n3{background:var(--n3)}.n4{background:var(--n4);color:var(--strong)}.n5{background:var(--n5);color:var(--strong)}' +
        'p{color:var(--ink2);margin:8px 0 0;font-size:12px}</style>' +
        `<div class="w"><table><tr><th></th>${cols.map((s) => `<th>${esc(STYLE_LABEL[s] ?? s)}</th>`).join('')}<th>All</th><th>Aggro − control</th></tr>${rows}</table></div>` +
        `<p>Score against ${esc(reference)} with the bot holding each deck type. Blue is above 50%, red below (Atlas edge steps). ` +
        'Aggro − control: points scored with aggro decks minus with control decks.</p>';
}

/**
 * The dashboard panel (README section 5) for a skillVsAgreement result. existing: the panel file as it is (its prose
 * fields are kept); latest: the bot whose deck-type row gets its own face-offs; thought: a line to add to the thoughts.
 */
function panelOf(result, { existing = null, now = new Date(), latest = null, thought = null, running = false, decks = null } = {}) {
    const ref = result.reference;
    const tested = result.bots.filter((b) => !b.reference && b.skill && typeof b.skill.winRate === 'number');
    const stamp = now.toISOString().replace(/\.\d+Z$/, 'Z');
    const what = `${decks ?? 'the'} real decks`;
    const widgets = [{
        type: 'faceoff', title: `Against ${ref} on ${what}: one pass each, the same deals for every bot`,
        items: tested.map((b) => ({
            a: b.bot, b: ref, share: r3(b.skill.winRate), n: b.skill.decided,
            note: `95% CI ${pct(b.skill.ci?.[0])}-${pct(b.skill.ci?.[1])}%${b.skill.incomplete ? `; ${b.skill.incomplete} engine-error games left out` : ''}`
        }))
    }];
    const withRow = tested.filter((b) => b.skill.byStyle);
    if (withRow.length) {
        widgets.push({ type: 'html', title: 'Score by the deck type the bot holds', height: Math.min(600, 130 + 34 * withRow.length), html: styleTableHtml(withRow, ref) });
    }
    const last = tested.find((b) => b.bot === latest && b.skill.byStyle);
    if (last) {
        widgets.push({
            type: 'faceoff', title: `${last.bot} against ${ref}, by the deck type ${last.bot} holds`,
            items: Object.entries(last.skill.byStyle).map(([s, x]) => ({ a: last.bot, b: ref, share: r3(x.winRate), n: x.decided, note: `${STYLE_LABEL[s] ?? s} decks` }))
        });
    }
    const agree = result.bots.filter((b) => b.agreement);
    if (agree.length) {
        const f2 = (x) => (x === null || x === undefined ? '-' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}`);
        const pts = (x) => (x === null || x === undefined ? '-' : `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(100 * x))}`);
        widgets.push({
            type: 'table', title: 'Agreement with humans: each bot\'s deck ranking from its mirror (r with the human ranking, same favourite in a matchup, aggro lean)',
            columns: ['bot', 'deck r', 'same favourite', 'aggro lean (humans)'],
            rows: agree.map((b) => [b.bot, f2(b.agreement.deckR), b.agreement.favouriteShare === null ? '-' : `${pct(b.agreement.favouriteShare)}%`,
                `${pts(b.agreement.style.botGap)} (${pts(b.agreement.style.humanGap)})`])
        });
    }
    const old = existing ?? {};
    const lead = tested.find((b) => b.bot === latest) ?? null;
    const thoughts = [...(Array.isArray(old.thoughts) ? old.thoughts : []), ...(thought ? [{ t: stamp, text: thought }] : [])].slice(-12);
    return {
        schema: 1, id: PANEL_ID, title: old.title ?? `Standard bot test: real decks against ${ref}`, thread: old.thread ?? THREAD,
        bots: [...new Set([...tested.map((b) => b.bot), ref])], status: running ? 'running' : 'done', updatedAt: stamp,
        now: lead ? `${lead.bot} scored ${pct(lead.skill.winRate)}% against ${ref} (95% CI ${pct(lead.skill.ci?.[0])}-${pct(lead.skill.ci?.[1])}%) over ${lead.skill.decided} games`
            : `${tested.length} bots tested against ${ref} on ${what}`,
        goal: old.goal ?? `One score per bot that every other bot's score can be compared with: one pass of ${what} against ${ref}, the same deals for every bot, and the same score split by the deck type the bot holds.`,
        mentalModel: old.mentalModel ?? {
            summary: 'A game\'s result comes from the cards each side holds, how well each bot pilots its deck type, and skill. Every bot gets the same deals, with each deck on both sides, so the cards cancel out of the score: the score measures skill against c-clock, and the row by deck type shows where the bot pilots worse.',
            features: []
        },
        plan: old.plan ?? [
            { text: 'Test the seven bots of the real-deck study', state: 'done' },
            { text: 'Test every new bot: npm run realdeck:test -- --bot <bot>', state: 'doing' }
        ],
        thoughts,
        widgets
    };
}

/** Writes a file through a temporary name, so a reader never sees half of it. */
function writeAtomic(file, text) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}

/** Runs node with args from the repo root, or prints the command with --dry-run. */
function run(args, dryRun) {
    const shown = `node ${args.map((a) => (/^[\w@./:=,#-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')}`;
    console.log(`$ ${shown}`);
    if (dryRun) {
        return;
    }
    const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) {
        throw new Error(`failed (exit ${r.status ?? r.signal}): ${shown}`);
    }
}

const USAGE = 'usage: node analysis/realdeck/bot-test.js --bot <bot> [--mirror] [--record] [--workers N] [--resume <run id>] [--dir <folder>] [--panel <file>] [--dry-run]\n' +
    '       node analysis/realdeck/bot-test.js --report [--dir <folder>] [--panel <file>]';

function main() {
    let a;
    try {
        a = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(`${e.message}\n${USAGE}`);
        process.exit(2);
    }
    const dir = path.resolve(a.dir ?? (fs.existsSync(SHARED) ? SHARED : path.join(ROOT, 'results', 'realdeck')));
    fs.mkdirSync(dir, { recursive: true });
    const deckFile = readDeckFile(a.decks);
    const decks = deckMeta(deckFile.raw);
    const games = decks.length * (decks.length - 1);
    const compareFile = path.resolve(a.compare ?? path.join(dir, COMPARE));
    const rel = (p) => {
        const r = path.relative(ROOT, path.resolve(p));
        return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : path.resolve(p);
    };
    let thought = null;

    if (a.bot) {
        const std = standardGauntlets(listRuns(dir), { sha256: deckFile.sha256 });
        if (!std.key) {
            console.log(`no finished gauntlet against ${REFERENCE} in ${dir} yet: this run draws the key the next ones reuse`);
        }
        const id = a.resume ?? nextId(dir, `test-${slug(a.bot)}`);
        run([rel(path.join(ROOT, 'bot', 'ladder.js')), '--decks', rel(a.decks), '--bots', a.bot, '--vs', REFERENCE, '--games', String(games),
            '--seed', String(SEED), ...(std.key ? ['--key', std.key] : []), '--id', id, '--out', dir, ...(a.resume ? ['--resume'] : []),
            ...(a.record ? ['--record'] : []), ...(a.workers ? ['--workers', a.workers] : [])], a.dryRun);
        if (a.mirror) {
            const mid = nextId(dir, `mirror-${slug(a.bot)}`);
            run([rel(path.join(ROOT, 'bot', 'ladder.js')), '--decks', rel(a.decks), '--bots', `${a.bot}#a,${a.bot}#b`, '--games', String(games),
                '--seed', String(SEED), '--id', mid, '--out', dir, ...(a.record ? ['--record'] : []), ...(a.workers ? ['--workers', a.workers] : [])], a.dryRun);
            // the mirrors compare.js last used, with this bot's replaced by the new one
            const prev = fs.existsSync(compareFile) ? readJson(compareFile) : null;
            const keep = (prev?.runs ?? []).filter((r) => r.mirror && r.bot !== a.bot && r.dir && fs.existsSync(r.dir)).map((r) => r.dir);
            const human = a.decks.replace(/\.json$/, '.human.json');
            const online = a.online ?? (fs.existsSync(ONLINE) ? ONLINE : null);
            const o = prev?.options ?? {};
            run([rel(path.join(__dirname, 'compare.js')), '--runs', [...keep, path.join(dir, mid)].join(','), '--decks', rel(a.decks), '--human', rel(human),
                ...(online ? ['--online', online] : []), '--permute', String(o.permute ?? 2000), '--min-games', String(o.minGames ?? 10),
                '--max-incomplete', String(o.maxIncomplete ?? 0.1), '--out', compareFile], a.dryRun);
        }
        if (a.dryRun) {
            return;
        }
    }

    const std = standardGauntlets(listRuns(dir), { sha256: deckFile.sha256 });
    for (const x of std.ignored) {
        console.log(`left out: ${x.id} (${x.reason})`);
    }
    if (!std.use.length) {
        console.log(`no gauntlet of the standard test in ${dir} yet`);
        return;
    }
    const meta = new Map(std.use.map((r) => [r.id, r]));
    const gauntlets = std.use.map((r) => ({ ...readGauntlet(r.dir), createdAt: r.createdAt }));
    const { runs, superseded } = newestPerChallenger(gauntlets);
    for (const x of superseded) {
        console.log(`replaced: ${x.bot} in ${x.run} by its newer run ${x.by}`);
    }
    const cmp = fs.existsSync(compareFile) ? readJson(compareFile) : null;
    const styles = new Map(decks.map((d) => [d.name, d.style]).filter(([, s]) => s));
    const now = new Date();
    const result = skillVsAgreement(runs, cmp, { now, styles });
    result.standard = {
        reference: REFERENCE, deckFile: { file: path.basename(a.decks), sha256: deckFile.sha256, decks: decks.length }, firstSeed: SEED,
        gamesPerBot: games, keyId: std.keyId, compare: cmp ? compareFile : null, ignored: std.ignored, superseded
    };
    const text = summaryText(result);
    console.log(text);
    writeAtomic(path.join(dir, 'skill.json'), JSON.stringify(result, null, 1));
    writeAtomic(path.join(dir, 'skill.txt'), `${text}\n`);
    console.log(`wrote ${path.join(dir, 'skill.json')} and skill.txt`);

    if (a.panel) {
        const newest = [...runs].sort((x, y) => String(y.createdAt ?? '').localeCompare(String(x.createdAt ?? '')))[0];
        const latest = a.bot ?? (newest?.challengers.length === 1 ? base(newest.challengers[0]) : null);
        const lead = result.bots.find((b) => b.bot === latest && b.skill && !b.skill.reference);
        if (a.bot && lead) {
            thought = `${a.bot} tested: ${pct(lead.skill.winRate)}% against ${REFERENCE} over ${lead.skill.decided} games (95% CI ${pct(lead.skill.ci?.[0])}-${pct(lead.skill.ci?.[1])}%).`;
        }
        const existing = fs.existsSync(a.panel) ? readJson(a.panel) : null;
        const running = runs.some((r) => meta.get(r.id)?.status === 'running');
        const panel = panelOf(result, { existing, now, latest, thought, running, decks: decks.length });
        writeAtomic(a.panel, `${JSON.stringify(panel, null, 1)}\n`);
        console.log(`wrote ${a.panel}`);
    }
}

if (require.main === module) {
    try {
        main();
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
}

module.exports = { REFERENCE, USAGE, parseArgs, keyId, slug, nextId, listRuns, standardGauntlets, newestPerChallenger, edgeStep, aggroMinusControl, styleTableHtml, panelOf };
