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
 * run key of the standard deals: the key <dir>/skill.json names (standard.keyId) when a finished gauntlet in <dir> has
 * it, else the key of the gauntlet against c-clock on the same deck file and seed that finished first. So every bot gets
 * the same deals and two bots pair game for game. With no finished gauntlet yet, ladder.js draws a new key and that run
 * sets the deals for the ones after it. The echoed command names the key by its id only: the key rebuilds every hidden
 * card of the games. --mirror also plays the bot against itself (<dir>/mirror-<bot>-<n>, one pass) and reruns
 * compare.js into <dir>/compare-702.json and .txt, so the report has the bot's agreement with humans. --record keeps
 * every game (games/<id>.jsonl, the replay format). --resume <run id> finishes a gauntlet of the same bot that stopped
 * (ladder.js --resume: the games already played are kept); it is refused for a run of another bot, deck file, seed or
 * key, and for a run whose key is not published yet (its remaining games would be dealt from a new key).
 *
 * The report reads every gauntlet in <dir> against c-clock on that deck file, seed and key (the others are listed with
 * the reason they were left out) and keeps one run per challenger: its newest finished run, or its newest unfinished
 * one when it has none (a bot tested again replaces its older games once the new run is done). It joins them with
 * <dir>/compare-702.json (compare.js on one-pass mirrors) through skill.js and writes <dir>/skill.json and skill.txt.
 * --panel <file> also writes the research dashboard panel (dashboard README section 5): each bot's score against
 * c-clock as a face-off, a table of each bot's score by the deck type it holds next to what c-clock itself scores with
 * the same decks (skill.js `expected` and `edge`), the latest bot's deck-type row as face-offs, and agreement with
 * humans for the bots with a mirror. The prose fields of an existing panel file (goal, mental model, plan, thoughts)
 * are kept; a run still going is marked running, or stopped once it has not written for an hour.
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
const STALE_MS = 60 * 60 * 1000; // a running gauntlet that has not written its report for this long has stopped
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

/** A run config's key id: from the published key, else the id ladder.js wrote, else null (--key none or an old run). */
const configKeyId = (c) => (typeof c?.key === 'string' ? keyId(c.key) : c?.keyId ?? null);

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

/** Every run folder in dir whose ladder.json reads: [{dir, id, createdAt, updatedAt, status, progress, config}], oldest first. */
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
        out.push({
            dir: path.join(dir, e.name), id: String(doc.id ?? e.name), createdAt: doc.createdAt ?? null, updatedAt: doc.updatedAt ?? null,
            status: doc.status ?? null, progress: doc.progress ?? null, config: doc.config ?? {}
        });
    }
    return out.sort((x, y) => String(x.createdAt ?? '').localeCompare(String(y.createdAt ?? '')) || x.id.localeCompare(y.id));
}

/** A run's state for the report: 'done', 'running', or 'stopped' (running in ladder.json but silent for STALE_MS). */
function runState(r, now = new Date()) {
    if (r.status === 'done') {
        return 'done';
    }
    const t = Date.parse(r.updatedAt ?? r.createdAt ?? '');
    return r.status === 'running' && Number.isFinite(t) && now.getTime() - t < STALE_MS ? 'running' : 'stopped';
}

/**
 * The gauntlets of the standard test among runs (from listRuns): against the reference alone, on this deck file
 * (sha256) and first seed, dealt from one key. The key is the one `pinned` names (a key id, from the last report) when a
 * finished candidate has it, else the key of the candidate that finished first (by updatedAt). Returns {key, keyId, use,
 * ignored, waiting, pinnedMissing}; key is null while no finished gauntlet has published one (then nothing is used, and
 * waiting lists the candidates still running).
 */
function standardGauntlets(runs, { reference = REFERENCE, sha256, firstSeed = SEED, pinned = null }) {
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
    const done = candidates.filter((r) => r.status === 'done' && typeof r.config.key === 'string')
        .sort((x, y) => String(x.updatedAt ?? '').localeCompare(String(y.updatedAt ?? '')) || String(x.createdAt ?? '').localeCompare(String(y.createdAt ?? '')) || x.id.localeCompare(y.id));
    const first = (pinned && done.find((r) => keyId(r.config.key) === pinned)) || done[0];
    if (!first) {
        return {
            key: null, keyId: null, use: [], pinnedMissing: Boolean(pinned), waiting: candidates.filter((r) => r.status === 'running').map((r) => r.id),
            ignored: [...ignored, ...candidates.map((r) => ({ id: r.id, reason: 'no finished gauntlet has set the deals yet' }))]
        };
    }
    const id = keyId(first.config.key);
    const use = [];
    for (const r of candidates) {
        const rid = configKeyId(r.config);
        if (rid === id) {
            use.push(r);
        } else {
            ignored.push({ id: r.id, reason: rid === null ? 'its key is not known (a run from before ladder.js named it, or --key none)' : 'another key, so other deals' });
        }
    }
    return { key: first.config.key, keyId: id, use, ignored, waiting: [], pinnedMissing: Boolean(pinned) && pinned !== id };
}

const sameSet = (x, y) => Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v) => y.includes(v));

/** Why `<dir>/<id>` can not be resumed as bot's standard gauntlet (std: from standardGauntlets), or null when it can. */
function resumeProblem(dir, id, { bot, sha256, std, reference = REFERENCE, firstSeed = SEED }) {
    const file = path.join(dir, id, 'ladder.json');
    if (!fs.existsSync(file)) {
        return `${path.join(dir, id)} has no ladder.json, so there is no run ${id} to resume`;
    }
    let doc;
    try {
        doc = readJson(file);
    } catch {
        return `${file} is not readable JSON`;
    }
    const c = doc.config ?? {};
    if (c.format !== 'gauntlet' || !sameSet(c.vs, [reference]) || !sameSet(c.bots, [bot, reference])) {
        return `${id} is not a gauntlet of ${bot} against ${reference} (bots ${JSON.stringify(c.bots)}, vs ${JSON.stringify(c.vs)})`;
    }
    if (c.decks?.sha256 !== sha256) {
        return `${id} played another deck file`;
    }
    if (c.firstSeed !== firstSeed) {
        return `${id} starts at seed ${c.firstSeed}, the test uses ${firstSeed}`;
    }
    const rid = configKeyId(c);
    if (!std.key) {
        return `no finished gauntlet has published the standard key yet, so a resume of ${id} would deal its remaining games from a new key; start a new run instead`;
    }
    if (rid !== std.keyId) {
        return `${id} was dealt from ${rid === null ? 'an unknown key' : `key id ${rid}`}, the standard deals are key id ${std.keyId}`;
    }
    return null;
}

const base = (name) => String(name).replace(/#.*$/, '');

/**
 * Keeps one run per challenger: its newest finished run, else its newest unfinished one (by createdAt, then id).
 * runs: [{id, createdAt, status, vs, challengers, games}]. A bot tested again loses its games in the run not kept; a run
 * left with no challenger is dropped. Returns {runs, superseded}.
 */
function newestPerChallenger(runs) {
    const done = (r) => (r.status === 'done' ? 1 : 0);
    const newer = (x, y) => done(x) - done(y) > 0
        || (done(x) === done(y) && (String(x.createdAt ?? '').localeCompare(String(y.createdAt ?? '')) > 0
            || (String(x.createdAt ?? '') === String(y.createdAt ?? '') && x.id > y.id)));
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
const pts = (x) => {
    if (x === null || x === undefined) {
        return '-';
    }
    const v = Math.round(100 * x) || 0; // no '−0'
    return `${v >= 0 ? '+' : '−'}${Math.abs(v)}`;
};
const r3 = (x) => (x === null || x === undefined ? null : Math.round(x * 1000) / 1000);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Atlas edge step of a difference in score (points as a share, e.g. 0.1): 0 (level) to 5, signed. */
function edgeStep(d) {
    const n = EDGE_STEPS.filter((s) => Math.abs(d) >= s).length;
    return d < 0 ? -n : n;
}

/** A deck-type cell's edge: score minus what the reference scores with the same decks, else score minus 50%. */
const cellEdge = (x) => (typeof x?.edge === 'number' ? x.edge : x ? x.winRate - 0.5 : null);

/**
 * Aggro minus control from a deck-type row, on the edges (score minus the reference's expected score with the same
 * decks): the pooled edge with hyper and soft aggro decks minus the pooled edge with soft and hard control decks. Null
 * when either side has no expectation.
 */
function aggroMinusControl(row) {
    const pool = (names) => {
        const xs = names.map((s) => row?.[s]).filter((x) => x && typeof x.edge === 'number' && x.expectedGames);
        const n = xs.reduce((a, x) => a + x.expectedGames, 0);
        return n ? xs.reduce((a, x) => a + x.edge * x.expectedGames, 0) / n : null;
    };
    const a = pool(['hyperaggro', 'softaggro']);
    const c = pool(['softcontrol', 'hardcontrol']);
    return a === null || c === null ? null : a - c;
}

/** The reference's expected score per deck type over the bots' rows: from the row with the most games with an expectation. */
function referenceRow(bots) {
    const out = {};
    for (const b of bots) {
        for (const [s, x] of Object.entries(b.skill.byStyle ?? {})) {
            if (typeof x.expected === 'number' && (!out[s] || x.expectedGames > out[s].expectedGames)) {
                out[s] = { expected: x.expected, expectedGames: x.expectedGames };
            }
        }
    }
    return out;
}

/** The deck-type table as a self-contained html widget (it renders in a sandboxed frame, so the colours are inline). */
function styleTableHtml(bots, reference) {
    const cols = STYLES.filter((s) => bots.some((b) => b.skill.byStyle?.[s]));
    const refRow = referenceRow(bots);
    const model = Object.keys(refRow).length > 0;
    const vars = (t) => `--ink:${t.ink};--ink2:${t.ink2};--line:${t.line};--strong:${t.strong};${t.pos.map((c, i) => `--p${i + 1}:${c}`).join(';')};${t.neg.map((c, i) => `--n${i + 1}:${c}`).join(';')}`;
    const cell = (x) => {
        if (!x) {
            return '<td>-</td>';
        }
        const d = cellEdge(x);
        const s = edgeStep(d);
        const cls = s > 0 ? ` class="p${s}"` : s < 0 ? ` class="n${-s}"` : '';
        const tip = `${x.score} of ${x.decided} decided games${typeof x.expected === 'number' ? `; ${reference} with the same decks: ${pct(x.expected)}%` : ''}`;
        return `<td${cls} title="${esc(tip)}">${pct(x.winRate)}%<small>${typeof x.edge === 'number' ? pts(x.edge) : '&nbsp;'}</small></td>`;
    };
    const head = model
        ? `<tr class="r"><td class="b">${esc(reference)} itself</td>${cols.map((s) => `<td>${refRow[s] ? `${pct(refRow[s].expected)}%` : '-'}<small>same decks</small></td>`).join('')}<td class="o">50%</td><td class="o"></td></tr>`
        : '';
    const rows = bots.map((b) => {
        const gap = aggroMinusControl(b.skill.byStyle);
        return `<tr><td class="b">${esc(b.bot)}</td>${cols.map((s) => cell(b.skill.byStyle[s])).join('')}<td class="o">${pct(b.skill.winRate)}%</td>` +
            `<td class="o">${gap === null ? '-' : pts(gap)}</td></tr>`;
    }).join('');
    const note = model
        ? `Score against ${esc(reference)} with the bot holding each deck type, and below it the points above or below what ${esc(reference)} itself scores with the same decks on the same games (first row, from ${esc(reference)}'s mirror). ` +
            `Blue: the bot pilots that deck type better than ${esc(reference)}; red: worse (Atlas edge steps). Aggro − control: the bot's edge with aggro decks minus its edge with control decks.`
        : `Score against ${esc(reference)} with the bot holding each deck type, coloured against 50%: there is no mirror of ${esc(reference)} in the compare file, so the cards each type holds are still in these numbers.`;
    return '<style>' +
        `:root{color-scheme:light dark;${vars(EDGE.light)}}@media (prefers-color-scheme:dark){:root{${vars(EDGE.dark)}}}` +
        'body{margin:0;font:13px system-ui,sans-serif;color:var(--ink);background:transparent}' +
        'table{border-collapse:collapse;width:100%;font:inherit}th{font-weight:600;color:var(--ink2);padding:4px;text-align:center;font-size:12px}' +
        'td{padding:5px 4px;text-align:center;border-top:1px solid var(--line);font-variant-numeric:tabular-nums;line-height:1.25}' +
        'td small{display:block;font-size:11px;opacity:.8}tr.r td{color:var(--ink2);font-style:italic}' +
        'td.b{text-align:left;overflow-wrap:anywhere;min-width:7em}td.o{color:var(--ink2)}.w{overflow-x:auto}' +
        '@media (max-width:480px){body{font-size:11px}th{font-size:10px;padding:3px 1px}td{padding:4px 2px}td small{font-size:10px}td.b{min-width:5em}}' +
        '.p1{background:var(--p1)}.p2{background:var(--p2)}.p3{background:var(--p3)}.p4{background:var(--p4);color:var(--strong)}.p5{background:var(--p5);color:var(--strong)}' +
        '.n1{background:var(--n1)}.n2{background:var(--n2)}.n3{background:var(--n3)}.n4{background:var(--n4);color:var(--strong)}.n5{background:var(--n5);color:var(--strong)}' +
        'p{color:var(--ink2);margin:8px 0 0;font-size:12px}</style>' +
        `<div class="w"><table><tr><th></th>${cols.map((s) => `<th>${esc(STYLE_LABEL[s] ?? s)}</th>`).join('')}<th>All</th><th>Aggro − control</th></tr>${head}${rows}</table></div>` +
        `<p>${note}</p>`;
}

const DEFAULT_MODEL = (ref) => ({
    summary: `A game's result comes from the cards each side holds, how well each side pilots its deck, and skill. Every bot gets the same deals with each deck on both sides, so the cards cancel out of the overall score: it measures skill against ${ref}. ` +
        `Split by the deck type the bot holds, the cards no longer cancel, so each cell is compared with what ${ref} itself scores with the same decks (from ${ref}'s mirror): above that, the bot pilots that deck type better than ${ref}; below, worse.`,
    features: []
});

/**
 * The dashboard panel (README section 5) for a skillVsAgreement result. existing: the panel file as it is (its prose
 * fields are kept); latest: the bot whose deck-type row gets its own face-offs; thought: a line to add to the thoughts;
 * states: Map bot -> {state: 'done'|'running'|'stopped', finished, run} for the run each bot's games come from.
 */
function panelOf(result, { existing = null, now = new Date(), latest = null, thought = null, states = new Map(), decks = null, gamesPerBot = null } = {}) {
    const ref = result.reference;
    const tested = result.bots.filter((b) => !b.reference && b.skill && typeof b.skill.winRate === 'number');
    const stamp = now.toISOString().replace(/\.\d+Z$/, 'Z');
    const what = `${decks ?? 'the'} real decks`;
    const progress = (bot) => {
        const s = states.get(bot);
        if (!s || s.state === 'done') {
            return '';
        }
        const k = `${s.finished ?? '?'}${gamesPerBot ? ` of ${gamesPerBot}` : ''} games`;
        return s.state === 'running' ? `; running, ${k}` : `; stopped at ${k} (--resume ${s.run})`;
    };
    const widgets = [{
        type: 'faceoff', title: `Against ${ref} on ${what}: one pass each, the same deals for every bot`,
        items: tested.map((b) => ({
            a: b.bot, b: ref, share: r3(b.skill.winRate), n: b.skill.decided,
            note: `95% CI ${pct(b.skill.ci?.[0])}-${pct(b.skill.ci?.[1])}%${b.skill.incomplete ? `; ${b.skill.incomplete} games without a result left out` : ''}${progress(b.bot)}`
        }))
    }];
    const withRow = tested.filter((b) => b.skill.byStyle);
    if (withRow.length) {
        widgets.push({ type: 'html', title: `Score by the deck type the bot holds, next to ${ref} itself with the same decks`, height: Math.min(600, 150 + 44 * (withRow.length + 1)), html: styleTableHtml(withRow, ref) });
    }
    const last = tested.find((b) => b.bot === latest && b.skill.byStyle);
    if (last) {
        widgets.push({
            type: 'faceoff', title: `${last.bot} against ${ref}, by the deck type ${last.bot} holds`,
            items: Object.entries(last.skill.byStyle).map(([s, x]) => ({
                a: last.bot, b: ref, share: r3(x.winRate), n: x.decided,
                note: `${STYLE_LABEL[s] ?? s} decks${typeof x.expected === 'number' ? `; ${ref} itself ${pct(x.expected)}% with the same decks (${pts(x.edge)})` : ''}`
            }))
        });
    }
    const agree = result.bots.filter((b) => b.agreement);
    if (agree.length) {
        const f2 = (x) => (x === null || x === undefined ? '-' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}`);
        widgets.push({
            type: 'table', title: 'Agreement with humans: each bot\'s deck ranking from its mirror (r with the human ranking, same favourite in a matchup, aggro lean)',
            columns: ['bot', 'deck r', 'same favourite', 'aggro lean (humans)'],
            rows: agree.map((b) => [b.bot, f2(b.agreement.deckR), b.agreement.favouriteShare === null ? '-' : `${pct(b.agreement.favouriteShare)}%`,
                `${pts(b.agreement.style.botGap)} (${pts(b.agreement.style.humanGap)})`])
        });
    }
    const old = existing ?? {};
    const lead = tested.find((b) => b.bot === latest) ?? null;
    const leadState = lead ? states.get(lead.bot)?.state ?? 'done' : null;
    const thoughts = [...(Array.isArray(old.thoughts) ? old.thoughts : []), ...(thought ? [{ t: stamp, text: thought }] : [])].slice(-12);
    return {
        schema: 1, id: PANEL_ID, title: old.title ?? `Standard bot test: real decks against ${ref}`, thread: old.thread ?? THREAD,
        bots: [...new Set([...tested.map((b) => b.bot), ref])], status: [...states.values()].some((s) => s.state === 'running') ? 'running' : 'done', updatedAt: stamp,
        now: lead ? `${lead.bot} scored ${pct(lead.skill.winRate)}% against ${ref} (95% CI ${pct(lead.skill.ci?.[0])}-${pct(lead.skill.ci?.[1])}%) over ${lead.skill.decided} games${leadState === 'done' ? '' : ` so far (${leadState})`}`
            : `${tested.length} bots tested against ${ref} on ${what}`,
        goal: old.goal ?? `One score per bot that every other bot's score can be compared with: one pass of ${what} against ${ref}, the same deals for every bot, and the same score split by the deck type the bot holds.`,
        mentalModel: old.mentalModel ?? DEFAULT_MODEL(ref),
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

/** A command as it is echoed: the run key (secret) shows as its id, since it rebuilds every hidden card of the games. */
function shownCommand(args, secret = null) {
    return `node ${args.map((a) => (secret && a === secret ? `<key id ${keyId(secret)}>` : /^[\w@./:=,#-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')}`;
}

/** Runs node with args from the repo root (or only prints the command with dryRun); capture: returns its stdout. */
function run(args, { dryRun = false, secret = null, capture = false } = {}) {
    const shown = shownCommand(args, secret);
    console.log(`$ ${shown}`);
    if (dryRun) {
        return '';
    }
    const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8', maxBuffer: 64 << 20 });
    if (capture && r.stdout) {
        process.stdout.write(r.stdout);
    }
    if (r.status !== 0) {
        throw new Error(`failed (exit ${r.status ?? r.signal}): ${shown}`);
    }
    return r.stdout ?? '';
}

/** The key id the last report in dir used (skill.json standard.keyId), when it was for this deck file and seed. */
function pinnedKeyId(dir, sha256) {
    try {
        const s = readJson(path.join(dir, 'skill.json')).standard;
        return s?.deckFile?.sha256 === sha256 && s.firstSeed === SEED && typeof s.keyId === 'string' ? s.keyId : null;
    } catch {
        return null;
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
    const pinned = pinnedKeyId(dir, deckFile.sha256);
    const standard = () => {
        const std = standardGauntlets(listRuns(dir), { sha256: deckFile.sha256, pinned });
        if (std.pinnedMissing) {
            console.log(`the deals of the last report (key id ${pinned}) have no finished gauntlet in ${dir} any more; using ${std.keyId ? `key id ${std.keyId}` : 'none yet'}`);
        }
        return std;
    };
    let thought = null;

    if (a.bot) {
        const std = standard();
        if (a.resume) {
            const why = resumeProblem(dir, a.resume, { bot: a.bot, sha256: deckFile.sha256, std });
            if (why) {
                throw new Error(`--resume ${a.resume}: ${why}`);
            }
        }
        if (!std.key) {
            console.log(`no finished gauntlet against ${REFERENCE} in ${dir} yet: this run draws the key the next ones reuse`);
            for (const id of std.waiting) {
                console.log(`warning: ${id} is still running and draws its own key; whichever finishes first sets the deals and the other is left out of the report`);
            }
        }
        const id = a.resume ?? nextId(dir, `test-${slug(a.bot)}`);
        run([rel(path.join(ROOT, 'bot', 'ladder.js')), '--decks', rel(a.decks), '--bots', a.bot, '--vs', REFERENCE, '--games', String(games),
            '--seed', String(SEED), ...(std.key ? ['--key', std.key] : []), '--id', id, '--out', dir, ...(a.resume ? ['--resume'] : []),
            ...(a.record ? ['--record'] : []), ...(a.workers ? ['--workers', a.workers] : [])], { dryRun: a.dryRun, secret: std.key });
        if (a.mirror) {
            const mid = nextId(dir, `mirror-${slug(a.bot)}`);
            run([rel(path.join(ROOT, 'bot', 'ladder.js')), '--decks', rel(a.decks), '--bots', `${a.bot}#a,${a.bot}#b`, '--games', String(games),
                '--seed', String(SEED), '--id', mid, '--out', dir, ...(a.record ? ['--record'] : []), ...(a.workers ? ['--workers', a.workers] : [])], { dryRun: a.dryRun });
            // the mirrors compare.js last used, with this bot's replaced by the new one
            const prev = fs.existsSync(compareFile) ? readJson(compareFile) : null;
            const keep = [];
            for (const r of prev?.runs ?? []) {
                if (!r.mirror || r.bot === a.bot) {
                    continue;
                }
                const d = r.dir ? path.resolve(ROOT, r.dir) : null;
                if (d && fs.existsSync(path.join(d, 'ladder.json'))) {
                    keep.push(d);
                } else {
                    console.log(`left out of compare: the mirror ${r.id} of ${r.bot} (its folder ${r.dir ?? '?'} is gone)`);
                }
            }
            const human = a.decks.replace(/\.json$/, '.human.json');
            const online = a.online ?? (fs.existsSync(ONLINE) ? ONLINE : null);
            const o = prev?.options ?? {};
            const tmp = `${compareFile}.${process.pid}.tmp`;
            const out = run([rel(path.join(__dirname, 'compare.js')), '--runs', [...keep, path.join(dir, mid)].join(','), '--decks', rel(a.decks), '--human', rel(human),
                ...(online ? ['--online', online] : []), '--permute', String(o.permute ?? 2000), '--min-games', String(o.minGames ?? 10),
                '--max-incomplete', String(o.maxIncomplete ?? 0.1), '--out', tmp], { dryRun: a.dryRun, capture: true });
            if (!a.dryRun) {
                fs.renameSync(tmp, compareFile);
                writeAtomic(compareFile.replace(/\.json$/, '.txt'), `${out.replace(/\n?wrote [^\n]*\n?$/, '').trimEnd()}\n`);
                console.log(`wrote ${compareFile} and ${path.basename(compareFile.replace(/\.json$/, '.txt'))}`);
            }
        }
        if (a.dryRun) {
            return;
        }
    }

    const std = standard();
    for (const x of std.ignored) {
        console.log(`left out: ${x.id} (${x.reason})`);
    }
    if (!std.use.length) {
        console.log(`no gauntlet of the standard test in ${dir} yet`);
        return;
    }
    const now = new Date();
    const meta = new Map(std.use.map((r) => [r.id, r]));
    const gauntlets = std.use.map((r) => ({ ...readGauntlet(r.dir), createdAt: r.createdAt, status: r.status }));
    const { runs, superseded } = newestPerChallenger(gauntlets);
    for (const x of superseded) {
        console.log(`replaced: ${x.bot} in ${x.run} by its run ${x.by}`);
    }
    const states = new Map();
    for (const r of runs) {
        const m = meta.get(r.id);
        for (const c of r.challengers) {
            states.set(base(c), { state: runState(m, now), finished: m.progress?.finished ?? null, run: r.id });
        }
    }
    const cmp = fs.existsSync(compareFile) ? readJson(compareFile) : null;
    const styles = new Map(decks.map((d) => [d.name, d.style]).filter(([, s]) => s));
    const result = skillVsAgreement(runs, cmp, { now, styles });
    result.standard = {
        reference: REFERENCE, deckFile: { file: path.basename(a.decks), sha256: deckFile.sha256, decks: decks.length }, firstSeed: SEED,
        gamesPerBot: games, keyId: std.keyId, compare: cmp ? compareFile : null, ignored: std.ignored, superseded,
        runs: Object.fromEntries([...states].map(([bot, s]) => [bot, s]))
    };
    const text = summaryText(result);
    console.log(text);
    for (const [bot, s] of states) {
        if (s.state !== 'done') {
            console.log(`${bot}: its run ${s.run} is ${s.state} at ${s.finished ?? '?'} of ${games} games`);
        }
    }
    writeAtomic(path.join(dir, 'skill.json'), JSON.stringify(result, null, 1));
    writeAtomic(path.join(dir, 'skill.txt'), `${text}\n`);
    console.log(`wrote ${path.join(dir, 'skill.json')} and skill.txt`);

    if (a.panel) {
        const newest = [...runs].sort((x, y) => String(y.createdAt ?? '').localeCompare(String(x.createdAt ?? '')))[0];
        const latest = a.bot ?? (newest?.challengers.length === 1 ? base(newest.challengers[0]) : null);
        const lead = result.bots.find((b) => b.bot === latest && b.skill && !b.skill.reference);
        if (a.bot && lead && states.get(a.bot)?.state === 'done') {
            thought = `${a.bot} tested: ${pct(lead.skill.winRate)}% against ${REFERENCE} over ${lead.skill.decided} games (95% CI ${pct(lead.skill.ci?.[0])}-${pct(lead.skill.ci?.[1])}%).`;
        }
        const existing = fs.existsSync(a.panel) ? readJson(a.panel) : null;
        const panel = panelOf(result, { existing, now, latest, thought, states, decks: decks.length, gamesPerBot: games });
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

module.exports = {
    REFERENCE, USAGE, parseArgs, keyId, slug, nextId, listRuns, runState, standardGauntlets, resumeProblem, newestPerChallenger, edgeStep, cellEdge,
    aggroMinusControl, referenceRow, styleTableHtml, panelOf, shownCommand, pinnedKeyId
};
