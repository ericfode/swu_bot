// Lens check, run from studio/ (built by `npm run check:lens`, which bundles this file with the app's own modules):
//   npm run check:lens -- --golden <outDir> [--force] [--lens <dir>] [--replays <dir>...]
//       For every <gameId>.json in the lens folder (default /mnt/project-files/dashboard/lens), loads it and its replay
//       with the app's code and writes <outDir>/<gameId>.json: per step what the viewer shows (edge, both totals, every
//       card chip, the rough chance), per action its swing, and the pivotal actions. Two runs give the same bytes.
//       Each record says it was written by the series code (`producer`). A folder that already holds records is
//       refused unless --force is given, so the reference written by the code before the series (b8fa81b; its records
//       have no producer) is never replaced by accident.
//   npm run check:lens -- --compare <goldenDir> [--allow-partial] [--force] [--lens <dir>] [--replays <dir>...]
//       Recomputes the same records with the current code and reports per game how far they moved. Exits 1 on any
//       value off by more than 0.005, any swing off by more than 1e-6, or a different pivotal set. Also exits 1 when a
//       lens file has no golden record or a golden file has another format, unless --allow-partial is given, and when a
//       record was written by the series code itself (it would pass trivially), unless --force is given.
//   npm run check:lens -- --validate <dir> [--replays <dir>...]
//       Checks producer files against swu-lens/1: the schema major, the default-path rules D1-D4 for <dir>/<gameId>.json
//       and the invariants I1-I8 for every file, <dir>/<sub>/<gameId>.json included. Plain JSON and replay checks, plus
//       the viewer's reader (readLens) warnings. Prints every violation with its file, step n and rule id, and exits 1
//       when there is one.
//   npm run check:lens -- --selftest [<fixturesDir>]
//       The score layer's own tests: chance maps, display scales, rule templates, and (when the fixtures made by
//       fixtures/lens-cases/make.mjs exist; default fixtures/lens-cases/out) what the series and the swings give for them.
// --golden and --compare compute every number through the viewer's score series (readLens, sourcesFor, resolveScore,
// classifyGame with the series, pivotalActions): the golden written by the code before the series must still match.
// One intended difference from that code, not covered by the golden (it holds no evals): with evals, a board change
// under 1e-9 (float noise) no longer takes a share of the eval interval's change.
// Replays are found by game id in the --replays folders. By default: games/demo, results/demo and results/omni-* under
// /mnt/project-files, then (only for ids not found there) every other games/*/games and results/*/games folder. When
// several files share an id, the first whose header has the lens file's seed and bots wins. Relative paths are read
// from the folder npm was started in.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { classifyGame, pivotalActions, type Action } from '../src/data/actions';
import { FIXED_SIDE, isNum, isObj, LENS_SCHEMA, readLens, type LensFile, type WinMap } from '../src/data/lensFile';
import { chooseDefault, resolveScore, rowValue, sourcesFor, type ScoreSeries, type SeatScore } from '../src/data/score';
import { chanceState, mapAt, typicalOf, winProb } from '../src/data/calibrate';
import { displayScales } from '../src/data/format';
import { fillRule } from '../src/data/terms';
import { estimateOmniV1, OMNI_V1_EVALUATOR, OMNI_V1_ROUGH_MAP, OMNI_V1_WEIGHTS } from '../src/data/omniV1';
import { parseGame } from '../src/data/source';
import type { Game, Seat, UnitRef } from '../src/data/types';

const PROJECT = '/mnt/project-files';
const DEFAULT_LENS = path.join(PROJECT, 'dashboard', 'lens');
/** what GameViewer.tsx passes to pivotalActions: 10 actions, at least 6 steps apart (the default gap) */
const PIVOTAL_K = 10;
const PIVOTAL_GAP = 6;
/** --compare: how far values (points, and the rough chance in percentage points) and swings may move */
const VALUE_TOL = 0.005;
const SWING_TOL = 1e-6;
const FORMAT = 'lens-golden/1';
/** what --golden writes as a record's producer; records of the code before the series have none */
const PRODUCER = 'series';
const SEATS: Seat[] = ['p1', 'p2'];

type Mode = 'golden' | 'compare' | 'validate' | 'selftest';
interface Args { mode: Mode; dir: string; lens: string; replays: string[] | null; allowPartial: boolean; force: boolean }

function usage(msg: string): never {
    console.error(`check-lens: ${msg}`);
    console.error('usage: npm run check:lens -- --golden <outDir> [--force] | --compare <goldenDir> [--allow-partial] [--force] | --validate <dir> | --selftest [<fixturesDir>]  [--lens <dir>] [--replays <dir>...]');
    process.exit(2);
}

function parseArgs(argv: string[]): Args {
    const base = process.env.INIT_CWD ?? process.cwd();
    const abs = (p: string) => path.resolve(base, p);
    let mode: Mode | null = null;
    let dir = '';
    let lens = DEFAULT_LENS;
    let replays: string[] | null = null;
    let allowPartial = false;
    let force = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            const v = argv[++i];
            if (v == null || v.startsWith('--')) {
                usage(`${a} needs a folder`);
            }
            return abs(v);
        };
        if (a === '--golden' || a === '--compare' || a === '--validate' || a === '--selftest') {
            if (mode) {
                usage('give only one of --golden, --compare, --validate and --selftest');
            }
            mode = a.slice(2) as Mode;
            // the fixtures folder of --selftest is optional
            dir = a === '--selftest' && (argv[i + 1] == null || argv[i + 1].startsWith('--')) ? abs('fixtures/lens-cases/out') : next();
        } else if (a === '--lens') {
            lens = next();
        } else if (a === '--allow-partial') {
            allowPartial = true;
        } else if (a === '--force') {
            force = true;
        } else if (a === '--replays') {
            // every argument up to the next option is a folder; --replays may also be repeated
            replays = replays ?? [];
            const before = replays.length;
            while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
                replays.push(abs(argv[++i]));
            }
            if (replays.length === before) {
                usage('--replays needs at least one folder');
            }
        } else {
            usage(`unknown argument ${a}`);
        }
    }
    if (!mode) {
        usage('give --golden, --compare, --validate or --selftest');
    }
    return { mode, dir, lens, replays, allowPartial, force };
}

// ---------------------------------------------------------------------------------------------------------------------
// Files and replays

const isDir = (p: string) => fs.existsSync(p) && fs.statSync(p).isDirectory();
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** the <gameId>.json files of a folder (registry and index files are not games) */
const lensFilesIn = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'evaluators.json' && f !== 'index.json'
    && fs.statSync(path.join(dir, f)).isFile()).sort(byName);

function replayDirs(parents: string[], pick: (name: string) => boolean): string[] {
    const out: string[] = [];
    for (const p of parents) {
        if (!isDir(p)) {
            continue;
        }
        for (const d of fs.readdirSync(p).sort(byName)) {
            const g = path.join(p, d, 'games');
            if (pick(d) && isDir(g)) {
                out.push(g);
            }
        }
    }
    return out;
}

function listReplays(dirs: string[], into: Map<string, string[]>) {
    for (const d of dirs) {
        if (!isDir(d)) {
            continue;
        }
        for (const f of fs.readdirSync(d).sort(byName)) {
            if (f.endsWith('.jsonl')) {
                const id = f.slice(0, -'.jsonl'.length);
                into.set(id, [...(into.get(id) ?? []), path.join(d, f)]);
            }
        }
    }
}

/** Replay files for a game id: the given folders only, or the default folders and then every other replay folder. */
function replayFinder(dirs: string[] | null): (gameId: string) => string[] {
    const first = new Map<string, string[]>();
    if (dirs) {
        listReplays(dirs, first);
        return (id) => first.get(id) ?? [];
    }
    const defaults = [
        ...replayDirs([path.join(PROJECT, 'games')], (d) => d === 'demo'),
        ...replayDirs([path.join(PROJECT, 'results')], (d) => d === 'demo' || d.startsWith('omni-'))
    ];
    listReplays(defaults, first);
    let rest: Map<string, string[]> | null = null;
    return (id) => {
        const hit = first.get(id);
        if (hit) {
            return hit;
        }
        if (!rest) {
            rest = new Map();
            listReplays(replayDirs([path.join(PROJECT, 'games'), path.join(PROJECT, 'results')], () => true).filter((d) => !defaults.includes(d)), rest);
        }
        return rest.get(id) ?? [];
    };
}

interface HeaderLike { seed?: number; players?: { id: string; bot: string }[] }

function headerOf(text: string): HeaderLike | null {
    const end = text.indexOf('\n');
    const line = end < 0 ? text : text.slice(0, end);
    try {
        const h = JSON.parse(line);
        return h?.t === 'header' ? h : null;
    } catch {
        return null;
    }
}

/** The first candidate whose header has the lens file's seed and bots, else the first candidate with a note. */
function pickReplay(cands: string[], lens: HeaderLike): { file: string; text: string; note?: string } | null {
    const fits = (h: HeaderLike | null) => !!h && (lens.seed == null || h.seed === lens.seed)
        && (lens.players ?? []).every((p) => h.players?.find((q) => q.id === p.id)?.bot === p.bot);
    let first: { file: string; text: string } | null = null;
    for (const file of cands) {
        const text = fs.readFileSync(file, 'utf8');
        if (fits(headerOf(text))) {
            return { file, text };
        }
        first = first ?? { file, text };
    }
    return first ? { ...first, note: `replay header does not match the lens file's seed and bots (${first.file})` } : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// --golden and --compare: what the viewer shows, per game

interface SeatRecord { total: number; base: number; ground: number[]; space: number[]; hand: number[]; resources: number; initiative: number }
interface StepRecord {
    i: number;
    n: number;
    /** where the board's numbers came from: the lens file, or the estimate (or, from the series, a gap's status) */
    src: string;
    /** the board's centre line (the lens step's edge) */
    edge: number;
    /** the timeline, the breakdown and the swings (golden: p1 total − p2 total; series: the step's edge) */
    score: number;
    /** the chance p1 wins in percent (golden: 50·(1 + tanh(edge / 25)); series: the step's p1Win, the rough map for Omni v1) */
    rough: number;
    /** the chips on the board, per zone */
    p1: SeatRecord;
    p2: SeatRecord;
}
interface ActionRecord { index: number; until: number; seat: Seat; cls: string; swing: number }
interface GameRecord {
    format: string;
    gameId: string;
    /** 'series' when --golden wrote it; absent in the records of the code before the series */
    producer?: string;
    lens: { file: string; sha256: string };
    replay: { file: string; sha256: string };
    counts: { steps: number; lensSteps: number; fromFile: number; estimated: number; actions: number };
    steps: StepRecord[];
    actions: ActionRecord[];
    /** step index of each pivotal action, in game order */
    pivotal: number[];
}

/** fixed decimals, so the records don't change with float noise; -0 prints as 0 and NaN as null (never equal in --compare) */
const fix = (v: number, d: number) => {
    const x = Number(v.toFixed(d));
    return x === 0 ? 0 : x;
};
const val = (v: number) => fix(v, 6);

const NONE = Number.NaN;
const seatRecord = (s: SeatScore | null): SeatRecord => (s ? {
    total: val(s.total ?? NONE), base: val(s.base), ground: s.ground.map(val), space: s.space.map(val), hand: s.hand.map(val),
    resources: val(s.resources), initiative: val(s.initiative)
} : { total: NONE, base: NONE, ground: [], space: [], hand: [], resources: NONE, initiative: NONE });

/** The series the viewer shows for a game whose only file is at the default path (or the estimate without one). */
function defaultSeriesOf(game: Game, lens: unknown): ScoreSeries {
    const source = chooseDefault(sourcesFor(game, lens == null ? [] : [{ dir: '', file: lens }]));
    if (!source) {
        throw new Error('no score source');
    }
    if (source.error) {
        throw new Error(source.error);
    }
    return resolveScore(game, source);
}

/**
 * The numbers the viewer shows for one game, from the app's own code: the board, the timeline and the breakdown (the
 * resolved series), the actions and their swings (classifyGame with the series, no evals) and the pivotal markers
 * (pivotalActions as GameViewer calls it). The record keeps the golden's shape so --compare can hold the series'
 * numbers against the ones the code before it wrote.
 */
function measure(game: Game, lens: LensFile): Pick<GameRecord, 'counts' | 'steps' | 'actions' | 'pivotal'> {
    const series = defaultSeriesOf(game, lens);
    const steps = game.steps.map((st, i): StepRecord => {
        const v = series.steps[i];
        return {
            i, n: st.n, src: v.status,
            edge: val(v.edge ?? NONE), score: val(v.edge ?? NONE), rough: val(v.p1Win == null ? NONE : 100 * v.p1Win),
            p1: seatRecord(v.seats?.p1 ?? null), p2: seatRecord(v.seats?.p2 ?? null)
        };
    });
    const actions = classifyGame(game, undefined, series);
    const pivotal = pivotalActions(actions, PIVOTAL_K, PIVOTAL_GAP).map((a) => a.index);
    const fromFile = steps.filter((s) => s.src === 'file').length;
    return {
        counts: { steps: steps.length, lensSteps: lens.steps?.length ?? 0, fromFile, estimated: steps.length - fromFile, actions: actions.length },
        steps,
        actions: actions.map((a) => ({ index: a.index, until: a.until, seat: a.seat, cls: a.cls, swing: fix(a.swing, 9) })),
        pivotal
    };
}

/** One game's record from its lens file, or the game id when no replay has it. Throws on a file it can't read or the reader refuses. */
function record(lensPath: string, find: (id: string) => string[]): { rec: GameRecord; note?: string; warnings: string[] } | { noReplay: string } {
    const lensText = fs.readFileSync(lensPath, 'utf8');
    const lens = JSON.parse(lensText) as LensFile;
    const read = readLens(lens);
    if ('error' in read) {
        throw new Error(`readLens: ${read.error}`);
    }
    const gameId = lens.gameId ?? path.basename(lensPath, '.json');
    const replay = pickReplay(find(gameId), lens);
    if (!replay) {
        return { noReplay: gameId };
    }
    const game = parseGame(replay.text, true);
    if (!game) {
        throw new Error(`replay has no steps: ${replay.file}`);
    }
    const rec: GameRecord = {
        format: FORMAT, gameId, producer: PRODUCER,
        lens: { file: lensPath, sha256: sha256(lensText) },
        replay: { file: replay.file, sha256: sha256(replay.text) },
        ...measure(game, lens)
    };
    return { rec, note: replay.note, warnings: read.warnings };
}

/** Top-level keys one per line, steps and actions one per line: stable bytes that still diff well. */
function serialize(rec: GameRecord): string {
    const entries = Object.entries(rec);
    const lines = ['{'];
    entries.forEach(([k, v], j) => {
        const comma = j < entries.length - 1 ? ',' : '';
        if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
            lines.push(` ${JSON.stringify(k)}: [`);
            v.forEach((x, m) => lines.push(`  ${JSON.stringify(x)}${m < v.length - 1 ? ',' : ''}`));
            lines.push(` ]${comma}`);
        } else {
            lines.push(` ${JSON.stringify(k)}: ${JSON.stringify(v)}${comma}`);
        }
    });
    lines.push('}');
    return `${lines.join('\n')}\n`;
}

function golden(args: Args): number {
    if (!isDir(args.lens)) {
        usage(`no lens folder ${args.lens}`);
    }
    fs.mkdirSync(args.dir, { recursive: true });
    // only earlier records are replaced, and only with --force; anything else in the folder is left alone
    const earlier = fs.readdirSync(args.dir).map((f) => path.join(args.dir, f))
        .filter((p) => p.endsWith('.json') && fs.statSync(p).isFile() && fs.readFileSync(p, 'utf8').startsWith(`{\n "format": "${FORMAT}"`));
    if (earlier.length && !args.force) {
        console.log(`golden: ${args.dir} already holds ${earlier.length} records (those without a producer are the reference of the code before the series); give --force to replace them`);
        return 1;
    }
    for (const p of earlier) {
        fs.rmSync(p);
    }
    const find = replayFinder(args.replays);
    const files = lensFilesIn(args.lens);
    const missing: string[] = [];
    let written = 0;
    let errors = 0;
    let warned = 0;
    for (const f of files) {
        try {
            const r = record(path.join(args.lens, f), find);
            if ('noReplay' in r) {
                missing.push(r.noReplay);
                console.log(`  ${f}: no replay found for ${r.noReplay}`);
                continue;
            }
            if (r.note) {
                console.log(`  ${f}: ${r.note}`);
            }
            for (const w of r.warnings) {
                warned++;
                console.log(`  ${f}: readLens warning: ${w}`);
            }
            fs.writeFileSync(path.join(args.dir, `${r.rec.gameId}.json`), serialize(r.rec));
            written++;
        } catch (e) {
            errors++;
            console.log(`  ${f}: error: ${(e as Error).message}`);
        }
    }
    console.log(`golden: ${files.length} lens files in ${args.lens}, wrote ${written} records to ${args.dir}; ${missing.length} without a replay${missing.length ? ` (${missing.join(', ')})` : ''}; ${warned} readLens warnings; ${errors} errors`);
    return errors || missing.length ? 1 : 0;
}

interface GameDiff { edge: number; score: number; totals: number; chips: number; rough: number; src: number; swings: number; pivotal: boolean; shape: string[] }

/** a value that did not come out as a number (NaN in the record is null) never compares equal */
const delta = (a: number | null, b: number | null) => (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) ? Infinity : Math.abs(a - b));
const maxAbs = (a: number[], b: number[]) => (a.length !== b.length ? Infinity : a.reduce((m, x, k) => Math.max(m, delta(x, b[k])), 0));

function diffRecords(want: GameRecord, got: GameRecord): GameDiff {
    const d: GameDiff = { edge: 0, score: 0, totals: 0, chips: 0, rough: 0, src: 0, swings: 0, pivotal: true, shape: [] };
    if (want.steps.length !== got.steps.length) {
        d.shape.push(`steps ${want.steps.length} → ${got.steps.length}`);
    }
    want.steps.forEach((w, k) => {
        const g = got.steps[k];
        if (!g) {
            return;
        }
        if (w.n !== g.n) {
            d.shape.push(`step ${k} has n ${w.n} → ${g.n}`);
        }
        d.src += w.src === g.src ? 0 : 1;
        d.edge = Math.max(d.edge, delta(w.edge, g.edge));
        d.score = Math.max(d.score, delta(w.score, g.score));
        d.rough = Math.max(d.rough, delta(w.rough, g.rough));
        for (const s of SEATS) {
            d.totals = Math.max(d.totals, delta(w[s].total, g[s].total));
            const scalars = (['base', 'resources', 'initiative'] as const).map((z) => delta(w[s][z], g[s][z]));
            const zones = (['ground', 'space', 'hand'] as const).map((z) => maxAbs(w[s][z], g[s][z]));
            d.chips = Math.max(d.chips, ...scalars, ...zones);
        }
    });
    const same = (a: ActionRecord, b: ActionRecord | undefined) => !!b && a.index === b.index && a.until === b.until && a.seat === b.seat && a.cls === b.cls;
    if (want.actions.length !== got.actions.length || want.actions.some((a, k) => !same(a, got.actions[k]))) {
        d.shape.push(`actions differ (${want.actions.length} → ${got.actions.length})`);
    }
    want.actions.forEach((a, k) => {
        const g = got.actions[k];
        d.swings += g && same(a, g) && delta(a.swing, g.swing) <= SWING_TOL ? 0 : 1;
    });
    d.pivotal = want.pivotal.length === got.pivotal.length && want.pivotal.every((x, k) => x === got.pivotal[k]);
    return d;
}

const show = (v: number) => (v === 0 ? '0' : Number.isFinite(v) ? v.toExponential(1) : 'shape');

function compare(args: Args): number {
    if (!isDir(args.dir)) {
        usage(`no golden folder ${args.dir}`);
    }
    const find = replayFinder(args.replays);
    const goldens = fs.readdirSync(args.dir).filter((f) => f.endsWith('.json')).sort(byName);
    const seen = new Set<string>();
    let differ = 0;
    let errors = 0;
    let warned = 0;
    let changedInputs = 0;
    let otherFormat = 0;
    let bySeries = 0;
    const tally = { values: 0, swings: 0, pivotal: 0 };
    for (const f of goldens) {
        let want: GameRecord;
        try {
            want = JSON.parse(fs.readFileSync(path.join(args.dir, f), 'utf8'));
        } catch (e) {
            errors++;
            console.log(`  ${f}: unreadable golden record: ${(e as Error).message}`);
            continue;
        }
        if (want.format !== FORMAT) {
            otherFormat++;
            console.log(`  ${f}: not a ${FORMAT} record (format ${JSON.stringify(want.format)}), not compared`);
            continue;
        }
        seen.add(want.gameId);
        bySeries += want.producer ? 1 : 0;
        const lensPath = path.join(args.lens, `${want.gameId}.json`);
        if (!fs.existsSync(lensPath)) {
            differ++;
            console.log(`  DIFF ${want.gameId}: no lens file ${lensPath}`);
            continue;
        }
        let got: GameRecord;
        let note: string | undefined;
        try {
            const r = record(lensPath, find);
            if ('noReplay' in r) {
                errors++;
                console.log(`  ${want.gameId}: no replay found`);
                continue;
            }
            got = r.rec;
            note = r.note;
            for (const w of r.warnings) {
                warned++;
                console.log(`  ${want.gameId}: readLens warning: ${w}`);
            }
        } catch (e) {
            errors++;
            console.log(`  ${want.gameId}: error: ${(e as Error).message}`);
            continue;
        }
        const inputs = [want.lens.sha256 !== got.lens.sha256 && 'lens file', want.replay.sha256 !== got.replay.sha256 && 'replay'].filter(Boolean);
        changedInputs += inputs.length ? 1 : 0;
        const d = diffRecords(want, got);
        const valueOff = Math.max(d.edge, d.score, d.totals, d.chips, d.rough) > VALUE_TOL || d.src > 0;
        const bad = valueOff || d.swings > 0 || !d.pivotal || d.shape.length > 0;
        tally.values += valueOff || d.shape.length ? 1 : 0;
        tally.swings += d.swings > 0 ? 1 : 0;
        tally.pivotal += d.pivotal ? 0 : 1;
        differ += bad ? 1 : 0;
        console.log(`  ${bad ? 'DIFF' : 'ok  '} ${want.gameId}: edge ${show(d.edge)} · score ${show(d.score)} · totals ${show(d.totals)} · chips ${show(d.chips)} · rough % ${show(d.rough)}`
            + `${d.src ? ` · ${d.src} steps change between file and estimate` : ''} · swings over ${SWING_TOL.toExponential()}: ${d.swings} · pivotal ${d.pivotal ? 'same' : `${want.pivotal.join(',')} → ${got.pivotal.join(',')}`}`
            + `${d.shape.length ? ` · ${d.shape.join('; ')}` : ''}${inputs.length ? ` · ${inputs.join(' and ')} changed since the golden` : ''}${note ? ` · ${note}` : ''}`);
    }
    const unseen = isDir(args.lens) ? lensFilesIn(args.lens).map((f) => f.slice(0, -'.json'.length)).filter((id) => !seen.has(id)) : [];
    for (const id of unseen) {
        console.log(`  ${args.allowPartial ? 'note' : 'MISS'} ${id}: has a lens file but no golden record (not compared)`);
    }
    const producer = bySeries === 0 ? 'all written by the code before the series' : bySeries === seen.size ? `all written by the ${PRODUCER} code` : `${bySeries} written by the ${PRODUCER} code`;
    console.log(`compare: golden records ${producer}`);
    if (bySeries && !args.force) {
        console.log('compare: records written by the series code itself pass trivially; compare against the reference of the code before the series, or give --force');
    }
    console.log(`compare: ${seen.size} games, ${differ} with differences (values over ${VALUE_TOL}: ${tally.values}, swings over ${SWING_TOL.toExponential()}: ${tally.swings}, pivotal sets changed: ${tally.pivotal}); `
        + `${changedInputs} with inputs changed since the golden; ${unseen.length} lens files not in the golden; ${otherFormat} golden files of another format; ${warned} readLens warnings; ${errors} errors`);
    // a golden that misses games compares only part of the lens folder: a failure unless asked for
    const partial = unseen.length + otherFormat > 0;
    if (partial && !args.allowPartial) {
        console.log('compare: the golden does not cover every lens file (give --allow-partial to accept that)');
    }
    return differ || errors || (partial && !args.allowPartial) || (bySeries && !args.force) ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// --validate: swu-lens/1 rules for producers, from the JSON and the replay only

interface Problem { file: string; n: number | null; rule: string; msg: string }
interface Zones { ground: number; space: number; hand: number }
/** per Step.n, the length of each seat's ground, space and hand arrays in the replay snapshot */
interface Boards { ns: number[]; at: Map<number, Record<Seat, Zones>> }

type Obj = Record<string, unknown>;
const isNums = (v: unknown): v is number[] => Array.isArray(v) && v.every(isNum);
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const r4 = (v: number) => String(Number(v.toFixed(4)));
const DIR_NAME = /^[a-z0-9._@-]+$/;

function readBoards(text: string): Boards {
    const boards: Boards = { ns: [], at: new Map() };
    for (const line of text.split('\n')) {
        if (!line) {
            continue;
        }
        let e: Obj;
        try {
            e = JSON.parse(line);
        } catch {
            // an unfinished last line of a game still being written
            continue;
        }
        if (e.t === 'step' && isNum(e.n) && isObj(e.state) && isObj(e.state.players)) {
            const players = e.state.players as Record<Seat, Record<keyof Zones, unknown[]>>;
            const zones = (s: Seat): Zones => ({ ground: players[s]?.ground?.length ?? 0, space: players[s]?.space?.length ?? 0, hand: players[s]?.hand?.length ?? 0 });
            boards.ns.push(e.n);
            boards.at.set(e.n, { p1: zones('p1'), p2: zones('p2') });
        }
    }
    return boards;
}

/** Every rule one lens file breaks. `atDefault`: the file sits at the default path (<lens>/<gameId>.json), where D1-D4 apply. */
/**
 * scale.toWinProb against spec 5.4: a logistic with k > 0 or a table (edge strictly increasing, p non-decreasing in
 * 0..1, at least 2 points, the same length), byRound entries of the parent's kind, and for unit "logit" only
 * {logistic, k 1, b 0} (k may change per round, b stays 0).
 */
function validateMap(m: unknown, unit: unknown, add: (msg: string) => void) {
    if (m == null) {
        return;
    }
    if (!isObj(m) || (m.kind !== 'logistic' && m.kind !== 'table')) {
        add('scale.toWinProb kind must be "logistic" or "table"');
        return;
    }
    const tableMsg = (edge: unknown, p: unknown) => (!isNums(edge) || !isNums(p) || edge.length < 2 || edge.length !== p.length
        ? 'needs edge and p lists of numbers, at least 2 points, the same length'
        : !edge.every((e, k) => k === 0 || e > edge[k - 1]) ? 'edge must strictly increase'
        : !p.every((x, k) => x >= 0 && x <= 1 && (k === 0 || x >= p[k - 1])) ? 'p must not fall and must stay in 0..1' : null);
    if (m.kind === 'logistic') {
        if (!isNum(m.k) || m.k <= 0) {
            add(`scale.toWinProb is logistic with k ${String(m.k)}; k must be a number above 0`);
        }
        if (m.b != null && !isNum(m.b)) {
            add('scale.toWinProb b is not a number');
        }
    } else {
        const t = tableMsg(m.edge, m.p);
        if (t) {
            add(`scale.toWinProb table ${t}`);
        }
    }
    if (m.byRound != null && !Array.isArray(m.byRound)) {
        add('scale.toWinProb.byRound is not a list');
    }
    for (const [k, r] of (Array.isArray(m.byRound) ? m.byRound : []).entries()) {
        const at = `scale.toWinProb.byRound[${k}]`;
        if (!isObj(r) || !isNum(r.from) || !isNum(r.to)) {
            add(`${at} needs numbers from and to`);
            continue;
        }
        if (m.kind === 'logistic') {
            if (r.k != null && !(isNum(r.k) && r.k > 0)) {
                add(`${at} k must be a number above 0`);
            }
            if (r.b != null && !isNum(r.b)) {
                add(`${at} b is not a number`);
            }
            if (unit === 'logit' && r.b != null && r.b !== 0) {
                add(`${at} has b ${String(r.b)}; for unit "logit" b is 0 everywhere (an intercept goes in joint)`);
            }
        } else {
            const t = tableMsg(r.edge, r.p);
            if (t) {
                add(`${at} ${t}`);
            }
        }
    }
    if (unit === 'logit' && (m.kind !== 'logistic' || m.k !== 1 || (m.b ?? 0) !== 0)) {
        add('for unit "logit" scale.toWinProb is absent or {kind: "logistic", k: 1, b: 0} (k may change in byRound); write p1Win per step for anything else');
    }
}

function validateFile(rel: string, raw: unknown, atDefault: boolean, boards: Boards | null, add: (n: number | null, rule: string, msg: string) => void, warn: (msg: string) => void) {
    if (!isObj(raw) || !Array.isArray(raw.steps)) {
        add(null, 'shape', 'not a lens file: no steps list');
        return;
    }
    if (raw.schema === undefined) {
        warn('no schema: read as swu-lens/1');
    } else if (typeof raw.schema !== 'string' || !LENS_SCHEMA.test(raw.schema)) {
        add(null, 'schema', `${String(raw.schema)} refused: this viewer reads swu-lens/1`);
        return;
    }
    if (typeof raw.gameId === 'string' && `${raw.gameId}.json` !== path.basename(rel)) {
        warn(`gameId ${raw.gameId} does not match the file name`);
    }
    const ev = isObj(raw.evaluator) ? raw.evaluator : null;
    const scale = ev && isObj(ev.scale) ? ev.scale : null;
    const unit = scale?.unit ?? 'points';
    const cardValues = ev?.cardValues ?? 'additive';
    const sampling = ev?.sampling ?? 'every-step';
    const tol = (unit === 'logit' ? 0.005 : 0.05) + 1e-9;
    if (!['additive', 'ablation', 'none'].includes(String(cardValues))) {
        warn(`unknown cardValues "${String(cardValues)}": read as additive`);
    }
    if (!['every-step', 'decisions', 'checkpoints'].includes(String(sampling))) {
        warn(`unknown sampling "${String(sampling)}": read as every-step`);
    }
    if (ev && typeof ev.label === 'string' && ev.label.length > 24) {
        warn(`evaluator.label is ${ev.label.length} characters; 24 at most fit the badge`);
    }
    validateMap(scale?.toWinProb, unit, (msg) => add(null, '5.4', msg));
    // the sum rules (I1-I3) hold for additive card values only (spec 5.6); unknown values read as the defaults
    const additive = cardValues !== 'ablation' && cardValues !== 'none';
    const everyStep = sampling !== 'decisions' && sampling !== 'checkpoints';
    if (atDefault) {
        if (unit !== 'points') {
            add(null, 'D3', `scale.unit is "${String(unit)}"; the default path needs "points"`);
        }
        if (cardValues !== 'additive') {
            add(null, 'D3', `cardValues is "${String(cardValues)}"; the default path needs it absent or "additive"`);
        }
        if (sampling !== 'every-step') {
            add(null, 'D3', `sampling is "${String(sampling)}"; the default path needs it absent or "every-step"`);
        }
    }

    // I7: term keys, and which keys seat.extra and step.joint must carry
    const terms = ev && isObj(ev.terms) ? ev.terms : {};
    const keysOf = (group: string): string[] => {
        const list = terms[group];
        if (list === undefined) {
            return [];
        }
        if (!Array.isArray(list)) {
            add(null, 'I7', `terms.${group} is not a list`);
            return [];
        }
        const keys: string[] = [];
        for (const t of list) {
            const k = isObj(t) ? t.key : undefined;
            if (typeof k !== 'string' || !k) {
                add(null, 'I7', `a term in terms.${group} has no key`);
            } else if (keys.includes(k)) {
                add(null, 'I7', `terms.${group} has the key "${k}" twice`);
            } else {
                keys.push(k);
            }
        }
        return keys;
    };
    for (const g of ['unit', 'base']) {
        keysOf(g);
    }
    const extraKeys = keysOf('side').filter((k) => !FIXED_SIDE.includes(k));
    const jointKeys = keysOf('joint');
    if (atDefault) {
        for (const k of extraKeys) {
            add(null, 'D2', `side term "${k}" is an extra term; extra not allowed at the default path`);
        }
        if (jointKeys.length) {
            add(null, 'D2', `joint terms (${jointKeys.join(', ')}) not allowed at the default path`);
        }
    }
    const sameKeys = (o: Obj, want: string[]) => Object.keys(o).length === want.length && want.every((k) => k in o);

    // I8: named weight sets
    const sets = raw.weightSets;
    if (sets !== undefined && !isObj(sets)) {
        add(null, 'I8', 'weightSets is not an object');
    }

    let prevN = -Infinity;
    const ns = new Set<number>();
    for (const [k, st] of raw.steps.entries()) {
        if (!isObj(st)) {
            add(null, 'shape', `steps[${k}] is not an object`);
            continue;
        }
        const n = st.n;
        if (!Number.isInteger(n) || (n as number) < 0) {
            add(null, 'I5', `steps[${k}] has no valid n`);
            continue;
        }
        const at = n as number;
        const here = (rule: string, msg: string) => add(at, rule, msg);
        // I5: sorted, no repeats, and a step of this replay
        if (at === prevN) {
            here('I5', 'repeated n');
        } else if (at < prevN) {
            here('I5', `comes after n ${prevN}; steps must be sorted by n`);
        }
        prevN = Math.max(prevN, at);
        ns.add(at);
        const board = boards?.at.get(at) ?? null;
        if (boards && !board) {
            here('I5', 'not a Step.n of the replay');
        }
        // I6
        if (st.p1Win != null && !(isNum(st.p1Win) && st.p1Win >= 0 && st.p1Win <= 1)) {
            here('I6', `p1Win ${String(st.p1Win)} is not a number from 0 to 1`);
        }
        // I8
        if (isObj(sets)) {
            if (st.weightSet == null && !isObj(st.weights)) {
                here('I8', 'no weightSet and no inline weights (the file has weightSets)');
            }
        }
        if (st.weightSet != null && !(isObj(sets) && typeof st.weightSet === 'string' && Object.hasOwn(sets, st.weightSet))) {
            here('I8', `weightSet "${String(st.weightSet)}" is not in weightSets`);
        }
        // joint (I7; D2 at the default path)
        let jointSum = 0;
        if (st.joint !== undefined) {
            if (atDefault) {
                here('D2', 'joint not allowed at the default path');
            }
            if (!isObj(st.joint)) {
                here('I7', 'joint is not an object');
            } else {
                if (!sameKeys(st.joint, jointKeys)) {
                    here('I7', `joint has keys [${Object.keys(st.joint).join(', ')}], the declared joint terms are [${jointKeys.join(', ')}]`);
                }
                for (const [key, v] of Object.entries(st.joint)) {
                    if (!isNum(v)) {
                        here('I2', `joint.${key} is not a number`);
                    } else {
                        jointSum += v;
                    }
                }
            }
        } else if (jointKeys.length) {
            here('I7', `joint is missing (declared: ${jointKeys.join(', ')})`);
        }
        const edgeRule = atDefault ? 'D4' : 'I2';
        if (!isNum(st.edge)) {
            here(edgeRule, 'edge is missing or not a number');
        }
        // seats
        const totals: Partial<Record<Seat, number>> = {};
        for (const s of SEATS) {
            const seat = st[s];
            if (cardValues === 'none') {
                if (seat !== undefined) {
                    here('I4', `${s} given with cardValues "none" (leave the seats out)`);
                }
                continue;
            }
            if (!isObj(seat)) {
                here(atDefault ? 'D1' : 'I4', `${s} is missing (only cardValues "none" may leave the seats out)`);
                continue;
            }
            const scalarRule = atDefault ? 'D1' : 'I1';
            const arrayRule = atDefault ? 'D1' : 'I4';
            for (const f of ['base', 'resources', 'initiative'] as const) {
                if (!isNum(seat[f])) {
                    here(scalarRule, `${s}.${f} is missing or not a number`);
                }
            }
            for (const z of ['ground', 'space', 'hand'] as const) {
                if (!isNums(seat[z])) {
                    here(arrayRule, `${s}.${z} is missing or not a list of numbers`);
                } else if (board && seat[z].length !== board[s][z]) {
                    here('I4', `${s}.${z} has ${seat[z].length} values, the replay board has ${board[s][z]} cards there`);
                }
            }
            const total = seat.total;
            if (isNum(total)) {
                totals[s] = total;
            } else if (total != null) {
                here(scalarRule, `${s}.total is not a number`);
            } else if (cardValues !== 'ablation') {
                here(scalarRule, `${s}.total is ${total === null ? 'null' : 'missing'} (only cardValues "ablation" may leave it out)`);
            }
            // extra (I7; D2 at the default path)
            let extraSum = 0;
            if (seat.extra !== undefined) {
                if (atDefault) {
                    here('D2', `extra not allowed at the default path (${s}.extra)`);
                }
                if (!isObj(seat.extra)) {
                    here('I7', `${s}.extra is not an object`);
                } else {
                    if (!sameKeys(seat.extra, extraKeys)) {
                        here('I7', `${s}.extra has keys [${Object.keys(seat.extra).join(', ')}], the declared extra terms are [${extraKeys.join(', ')}]`);
                    }
                    for (const [key, v] of Object.entries(seat.extra)) {
                        if (!isNum(v)) {
                            here('I1', `${s}.extra.${key} is not a number`);
                        } else {
                            extraSum += v;
                        }
                    }
                }
            } else if (extraKeys.length) {
                here('I7', `${s}.extra is missing (declared: ${extraKeys.join(', ')})`);
            }
            const six = [seat.base, seat.resources, seat.initiative].every(isNum) && (['ground', 'space', 'hand'] as const).every((z) => isNums(seat[z]))
                ? (seat.base as number) + sum(seat.ground as number[]) + sum(seat.space as number[]) + sum(seat.hand as number[]) + (seat.resources as number) + (seat.initiative as number)
                : null;
            if (additive && isNum(total) && six != null) {
                // the default path allows no extra, so its rule is the plain six-field sum (D2); elsewhere I1 adds the extra terms
                const want = atDefault ? six : six + extraSum;
                if (Math.abs(total - want) > tol) {
                    here(atDefault ? 'D2' : 'I1', `${s}.total ${r4(total)} but the fields add up to ${r4(want)}`);
                }
            }
            // I3: parts add up to their values
            const parts = seat.parts;
            if (additive && parts !== undefined) {
                if (!isObj(parts)) {
                    here('I3', `${s}.parts is not an object`);
                    continue;
                }
                const partSum = (p: unknown, where: string): number | null => {
                    if (!isObj(p) || !Object.values(p).every(isNum)) {
                        here('I3', `${where} is not an object of numbers`);
                        return null;
                    }
                    return sum(Object.values(p) as number[]);
                };
                if (parts.base !== undefined && isNum(seat.base)) {
                    const t = partSum(parts.base, `${s}.parts.base`);
                    if (t != null && Math.abs(t - seat.base) > tol) {
                        here('I3', `${s}.parts.base adds up to ${r4(t)}, base is ${r4(seat.base)}`);
                    }
                }
                for (const z of ['ground', 'space'] as const) {
                    const list = parts[z];
                    const values = seat[z];
                    if (list === undefined || !isNums(values)) {
                        continue;
                    }
                    if (!Array.isArray(list) || list.length !== values.length) {
                        here('I3', `${s}.parts.${z} has ${Array.isArray(list) ? list.length : 'no'} entries for ${values.length} cards`);
                        continue;
                    }
                    list.forEach((p, i) => {
                        const t = partSum(p, `${s}.parts.${z}[${i}]`);
                        if (t != null && Math.abs(t - values[i]) > tol) {
                            here('I3', `${s}.parts.${z}[${i}] adds up to ${r4(t)}, the card's value is ${r4(values[i])}`);
                        }
                    });
                }
            }
        }
        // I2 (D4 at the default path): edge = p1.total − p2.total + Σjoint
        if (additive && isNum(st.edge) && totals.p1 != null && totals.p2 != null) {
            const want = totals.p1 - totals.p2 + (atDefault ? 0 : jointSum);
            if (Math.abs(st.edge - want) > tol) {
                here(edgeRule, `edge ${r4(st.edge)} but p1.total − p2.total${atDefault || !jointKeys.length ? '' : ' + Σjoint'} is ${r4(want)}`);
            }
        }
    }
    // I5: an every-step file has every Step.n of the replay (missing runs reported as ranges)
    if (boards && everyStep) {
        let run: number[] = [];
        const flush = () => {
            if (run.length) {
                add(run[0], 'I5', run.length === 1 ? 'missing (an every-step file has every Step.n of the replay)'
                    : `steps n ${run[0]}-${run[run.length - 1]} missing (${run.length} steps; an every-step file has every Step.n of the replay)`);
            }
            run = [];
        };
        for (const n of boards.ns) {
            if (ns.has(n)) {
                flush();
            } else {
                run.push(n);
            }
        }
        flush();
    }
}

function validate(args: Args): number {
    const root = args.dir;
    if (!isDir(root)) {
        usage(`no folder ${root}`);
    }
    const find = replayFinder(args.replays);
    const problems: Problem[] = [];
    const warnings: Problem[] = [];
    const boardsOf = new Map<string, Boards | null>();
    let files = 0;
    let atDefault = 0;
    const subdirs = fs.readdirSync(root).filter((d) => isDir(path.join(root, d))).sort(byName);

    const check = (rel: string, isDefault: boolean) => {
        files++;
        atDefault += isDefault ? 1 : 0;
        const add = (n: number | null, rule: string, msg: string) => problems.push({ file: rel, n, rule, msg });
        const warn = (msg: string) => warnings.push({ file: rel, n: null, rule: 'warning', msg });
        let raw: unknown;
        try {
            raw = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
        } catch (e) {
            add(null, 'shape', `not JSON: ${(e as Error).message}`);
            return;
        }
        const gameId = isObj(raw) && typeof raw.gameId === 'string' ? raw.gameId : path.basename(rel, '.json');
        if (!boardsOf.has(gameId)) {
            const pick = pickReplay(find(gameId), isObj(raw) ? raw as HeaderLike : {});
            boardsOf.set(gameId, pick ? readBoards(pick.text) : null);
            if (pick?.note) {
                warn(pick.note);
            }
        }
        const b = boardsOf.get(gameId) ?? null;
        if (!b) {
            warn(`no replay for ${gameId}: I4 and I5 against the replay not checked`);
        }
        validateFile(rel, raw, isDefault, b, add, warn);
        // what the viewer's reader says about the file (its schema refusal and the missing-schema note are reported above)
        const read = readLens(raw);
        if (!('error' in read)) {
            for (const w of read.warnings.filter((x) => !x.startsWith('no schema'))) {
                warn(`readLens: ${w}`);
            }
        }
    };

    for (const f of lensFilesIn(root)) {
        check(f, true);
    }
    for (const d of subdirs) {
        if (!DIR_NAME.test(d)) {
            problems.push({ file: `${d}/`, n: null, rule: 'layout', msg: 'folder name may use only a-z, 0-9 and . _ @ -' });
        }
        for (const f of lensFilesIn(path.join(root, d))) {
            check(`${d}/${f}`, false);
        }
    }
    // the registry and the per-folder indexes (optional files)
    const readIndex = (rel: string): Obj | null => {
        const p = path.join(root, rel);
        if (!fs.existsSync(p)) {
            return null;
        }
        try {
            const v = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (!isObj(v) || v.schema !== 'swu-lens-index/1') {
                problems.push({ file: rel, n: null, rule: 'layout', msg: 'schema is not swu-lens-index/1' });
            }
            return isObj(v) ? v : null;
        } catch (e) {
            problems.push({ file: rel, n: null, rule: 'layout', msg: `not JSON: ${(e as Error).message}` });
            return null;
        }
    };
    const reg = readIndex('evaluators.json');
    if (reg) {
        const list = Array.isArray(reg.evaluators) ? reg.evaluators.filter(isObj) : [];
        for (const e of list) {
            if (typeof e.dir !== 'string' || (e.dir !== '' && !subdirs.includes(e.dir))) {
                problems.push({ file: 'evaluators.json', n: null, rule: 'layout', msg: `dir "${String(e.dir)}" is not a folder here` });
            }
        }
        if (reg.default !== undefined && !list.some((e) => e.dir === reg.default)) {
            problems.push({ file: 'evaluators.json', n: null, rule: 'layout', msg: `default "${String(reg.default)}" is not one of the listed dirs` });
        }
    }
    for (const d of subdirs) {
        const idx = readIndex(`${d}/index.json`);
        if (!idx) {
            continue;
        }
        if (idx.dir !== undefined && idx.dir !== d) {
            problems.push({ file: `${d}/index.json`, n: null, rule: 'layout', msg: `dir "${String(idx.dir)}" is not the folder name` });
        }
        const have = new Set(lensFilesIn(path.join(root, d)).map((f) => f.slice(0, -'.json'.length)));
        const listed = Array.isArray(idx.games) ? idx.games.map(String) : [];
        for (const g of listed.filter((x) => !have.has(x))) {
            warnings.push({ file: `${d}/index.json`, n: null, rule: 'warning', msg: `lists ${g}, which has no file` });
        }
        for (const g of [...have].filter((x) => !listed.includes(x))) {
            warnings.push({ file: `${d}/index.json`, n: null, rule: 'warning', msg: `does not list ${g}, which has a file` });
        }
    }

    for (const p of [...problems, ...warnings]) {
        console.log(`${p.file}: ${p.n != null ? `n ${p.n}: ` : ''}${p.rule}: ${p.msg}`);
    }
    const byRule = new Map<string, number>();
    for (const p of problems) {
        byRule.set(p.rule, (byRule.get(p.rule) ?? 0) + 1);
    }
    const rules = [...byRule].sort((a, b) => byName(a[0], b[0])).map(([r, k]) => `${r} ${k}`).join(', ');
    console.log(`validate: ${files} files (${atDefault} at the default path, ${files - atDefault} in ${subdirs.length} folders), ${problems.length} violations${rules ? ` (${rules})` : ''}, ${warnings.length} warnings`);
    return problems.length ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// --selftest: the score layer's own tests (maps, scales, templates), then the fixtures when they exist

interface CaseInfo { name: string; lensDir: string; files: string[]; games: string[] }

function selftest(args: Args): number {
    let passed = 0;
    let failed = 0;
    const check = (name: string, ok: boolean, detail = '') => {
        if (ok) {
            passed++;
        } else {
            failed++;
        }
        console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
    };
    const near = (a: number | null | undefined, b: number, tol = 1e-9) => a != null && Math.abs(a - b) <= tol;

    // chance maps and display scales
    let worst = 0;
    let unlike = 0;
    for (let k = -80000; k <= 80000; k++) {
        // quarter points, and edges with float noise in them (two decimals, as the files store them)
        for (const e of [k / 4, k / 100 + 0.1 + 0.2]) {
            const got = 100 * winProb(OMNI_V1_ROUGH_MAP, e, 0);
            const old = 50 * (1 + Math.tanh(e / 25));
            worst = Math.max(worst, Math.abs(got - old));
            unlike += got === old ? 0 : 1;
        }
    }
    check('rough map: 100·winProb(e) is bit for bit 50·(1 + tanh(e / 25)) (so mirrored plays still tie exactly)', unlike === 0, `${unlike} differ, largest ${worst.toExponential(1)}`);
    const table: WinMap = { kind: 'table', edge: [-60, -20, 0, 20, 60], p: [0.03, 0.2, 0.52, 0.8, 0.97] };
    const t = (e: number) => winProb(table, e, 0);
    check('table map: flat past both ends', t(-61) === 0.03 && t(-1000) === 0.03 && t(61) === 0.97 && t(1e6) === 0.97, `${t(-1000)} and ${t(1e6)}`);
    check('table map: linear between points', near(t(10), 0.66, 1e-12) && near(t(-40), 0.115, 1e-12) && t(0) === 0.52, `${t(10)} and ${t(-40)}`);
    const phased: WinMap = { kind: 'logistic', k: 0.08, b: 0, fitted: true, byRound: [{ from: 0, to: 3, k: 0.05, b: 0.3 }, { from: 4, to: 6, k: 0.09, b: 0.2 }, { from: 7, to: 99, k: 0.1, b: -0.3 }] };
    const kAt = (r: number) => (mapAt(phased, r) as { k: number }).k;
    check('byRound: rounds 0, 3, 4, 50 take entries 1, 1, 2, 3; round 100 takes the top level', kAt(0) === 0.05 && kAt(3) === 0.05 && kAt(4) === 0.09 && kAt(50) === 0.1 && kAt(100) === 0.08,
        [0, 3, 4, 50, 100].map((r) => `${r}: k ${kAt(r)}`).join(', '));
    check('byRound: winProb uses the round\'s k and b', near(winProb(phased, 10, 4), 1 / (1 + Math.exp(-(0.09 * 10 + 0.2)))));
    const chanceOfMap = (unit: string, toWinProb: unknown) => {
        const r = readLens({ schema: 'swu-lens/1', evaluator: { id: 'x', scale: { unit, toWinProb } }, steps: [] });
        return 'error' in r ? r.error : `${chanceState(r.evaluator, false)}${r.warnings.length ? ` (${r.warnings.join('; ')})` : ''}`;
    };
    const chances = [chanceOfMap('logit', { kind: 'logistic', k: 1, b: 0 }), chanceOfMap('logit', { kind: 'table', edge: [-3, 3], p: [0.1, 0.9], fitted: false }),
        chanceOfMap('logit', { kind: 'logistic', k: 1, b: 0, fitted: true }), chanceOfMap('logit', null), chanceOfMap('points', null)];
    check('chance state: a map not fitted is rough for log-odds too; fitted is fitted; log-odds with no map are model; points with none have none',
        JSON.stringify(chances) === JSON.stringify(['rough', 'rough', 'fitted', 'model', 'none']), chances.join(', '));
    const flat = [chanceOfMap('points', { kind: 'logistic', k: 0 }), chanceOfMap('points', { kind: 'logistic', k: -0.08 })];
    check('a logistic map with k <= 0: no chance map, with a warning', flat.every((c) => c.startsWith('none (') && c.includes('k <= 0')), flat.join(', '));
    const setSteps = Array.from({ length: 50 }, (_, n) => (n === 30 ? { n, edge: 1 } : { n, edge: 1, weightSet: n === 40 ? 'Z' : 'A' }));
    const rs = readLens({ schema: 'swu-lens/1', evaluator: { id: 'x' }, weights: { hand: 1.8 }, weightSets: { A: { weights: { hand: 9 } } }, steps: setSteps });
    const setWarnings = 'error' in rs ? [rs.error] : rs.warnings;
    check('I8: a step naming no set in weightSets, and a step with neither weightSet nor weights, are warned about',
        setWarnings.some((w) => w.includes('names no set') && w.includes('n 40')) && setWarnings.some((w) => w.startsWith('no weightSet') && w.includes('n 30')), setWarnings.join('; '));
    const ds = displayScales(0.08);
    check('displayScales(0.08) = half-bar 15, tug 40, lead 0.5, heat floor 1, tolerance 0.05 (exactly)', ds.halfBar === 15 && ds.tug === 40 && ds.lead === 0.5 && ds.heatFloor === 1 && ds.tolerance === 0.05, JSON.stringify(ds));
    const ty = typicalOf({ unit: 'points', typical: null }, Array.from({ length: 100 }, (_, k) => k - 99.5));
    check('typical without scale.typical: 90th percentile of |edge|, rounded up to 1, 2 or 5 × 10^k', ty.value === 100 && ty.from === 'percentile', `${ty.value} from ${ty.from}`);

    // rule templates: the omni ones filled with the omni weights print the literal rules (danger as 0.167, not "/ 6")
    const ruleCases: { what: string; terms: { key: string; rule?: string; ruleTpl?: string }[]; note?: string; noteTpl?: string; w: Record<string, number> }[] = [];
    const built = OMNI_V1_EVALUATOR.terms!;
    ruleCases.push({ what: 'built-in descriptor', terms: [...built.unit!, ...built.base!, ...built.side!], note: built.unitNote, noteTpl: built.unitNoteTpl, w: OMNI_V1_WEIGHTS });
    const sample = path.join(args.lens, 'heuristic-vs-omni-102.json');
    if (fs.existsSync(sample)) {
        const f = JSON.parse(fs.readFileSync(sample, 'utf8')) as LensFile;
        const ft = f.evaluator?.terms ?? {};
        ruleCases.push({ what: path.basename(sample), terms: [...(ft.unit ?? []), ...(ft.base ?? []), ...(ft.side ?? [])], note: ft.unitNote, noteTpl: ft.unitNoteTpl, w: f.weights ?? {} });
    }
    for (const rc of ruleCases) {
        const bad = rc.terms.filter((x) => x.ruleTpl).flatMap((x) => {
            const got = fillRule(x.ruleTpl!, rc.w);
            const want = x.key === 'danger' ? (x.rule ?? '').replace(' / 6 x', ` x ${Number((1 / 6).toPrecision(3))} x`) : x.rule;
            return got === want ? [] : [`${x.key}: "${got}" vs "${want}"`];
        });
        const note = rc.noteTpl ? fillRule(rc.noteTpl, rc.w) : rc.note;
        check(`fillRule on every ruleTpl of the ${rc.what} gives the literal rule (danger: 0.167 for "/ 6"), and the unit note`, !bad.length && note === rc.note,
            bad.length ? bad.join('; ') : `${rc.terms.filter((x) => x.ruleTpl).length} terms`);
    }
    check('fillRule: 3 significant digits, ? for an unknown key', fillRule('{a} {b} {c} {zz}', { a: 1 / 6, b: 12, c: 1234.5 }) === '0.167 12 1230 ?');

    // fixtures
    const casesPath = path.join(args.dir, 'cases.json');
    if (!fs.existsSync(casesPath)) {
        console.log(`  skip: no fixtures in ${args.dir} (make them with node fixtures/lens-cases/make.mjs); fixture checks skipped`);
        console.log(`selftest: ${passed} passed, ${failed} failed, fixtures skipped`);
        return failed ? 1 : 0;
    }
    const meta = JSON.parse(fs.readFileSync(casesPath, 'utf8')) as { replays: string; cases: CaseInfo[] };
    const replays = path.join(args.dir, meta.replays);
    const games = new Map<string, Game>();
    const gameOf = (id: string) => {
        if (!games.has(id)) {
            games.set(id, parseGame(fs.readFileSync(path.join(replays, `${id}.jsonl`), 'utf8'), true)!);
        }
        return games.get(id)!;
    };
    const caseOf = (name: string) => meta.cases.find((c) => c.name === name);
    const rawOf = (c: CaseInfo, f: string) => JSON.parse(fs.readFileSync(path.join(args.dir, c.lensDir, f), 'utf8'));
    const load = (name: string, file?: string) => {
        const c = caseOf(name);
        if (!c) {
            return null;
        }
        const f = file ?? c.files[0];
        const dir = path.dirname(f) === '.' ? '' : path.dirname(f);
        const raw = rawOf(c, f);
        const game = gameOf(path.basename(f, '.json'));
        const source = sourcesFor(game, [{ dir, file: raw }])[0];
        return { c, raw, game, source, series: source.error ? null : resolveScore(game, source) };
    };
    const quiet = (a: Action) => a.cls === 'pass' || a.cls === 'initiative' || a.cls === 'resource';
    const toward = (a: Action) => (a.seat === 'p1' ? 1 : -1);
    const fixture = (name: string, body: (x: NonNullable<ReturnType<typeof load>>) => void) => {
        const x = load(name);
        if (!x) {
            console.log(`  skip: no fixture ${name}`);
            return;
        }
        body(x);
    };

    fixture('omni-today', ({ raw, game, source, series }) => {
        const r = readLens(raw);
        check('omni-today: readLens reads it with 0 warnings, as Omni v1', !('error' in r) && !r.warnings.length && r.builtIn === 'omni-v1' && r.evaluator.label === 'Omni v1');
        check('omni-today: chance rough, kEff 0.08, typical 25, every step from the file', source.chance === 'rough' && source.kEff === 0.08 && source.typical === 25 && series!.coverage.file === series!.steps.length,
            `${source.chance}, ${source.kEff}, ${source.typical}, ${series!.coverage.file}/${series!.steps.length}`);
        const noSchema = { ...raw };
        delete noSchema.schema;
        const r2 = readLens(noSchema);
        check('a file without schema: a warning, not an error', !('error' in r2) && r2.warnings.some((w) => w.startsWith('no schema')), 'error' in r2 ? r2.error : r2.warnings.join('; '));

        // malformed and partial inputs: read with a warning, never thrown at a view, never mixing two chances
        const copy = () => JSON.parse(JSON.stringify(raw)) as LensFile & { steps: Obj[] };
        const seriesOf = (f: unknown) => resolveScore(game, sourcesFor(game, [{ dir: '', file: f }])[0]);
        const swings = (f: unknown) => classifyGame(game, undefined, seriesOf(f));
        // card values are held only while the cards they scored are still there, by id when the replay has ids (v2):
        // omni-today kept on every 4th step and marked sparse, then the ids of one held step's cards set or swapped
        const sparse = copy() as unknown as { evaluator: Obj; steps: Obj[] };
        sparse.evaluator.sampling = 'decisions';
        sparse.steps = sparse.steps.filter((_, k) => k % 4 === 0);
        const sparseSeries = seriesOf(sparse);
        const h = sparseSeries.steps.find((x) => x.status === 'held' && x.seats && game.steps[x.i].state.players.p1.ground.length > 0);
        const heldWithIds = (swap: boolean) => {
            const steps = game.steps.map((st, i) => {
                if (!h || (i !== h.heldFrom && i !== h.i)) {
                    return st;
                }
                const state = structuredClone(st.state);
                for (const seat of ['p1', 'p2'] as const) {
                    for (const z of ['ground', 'space', 'hand'] as const) {
                        state.players[seat][z].forEach((c, k) => { c.id = `${seat}-${z}-${k}`; });
                    }
                }
                if (swap && i === h.i) {
                    // another copy of the same card in the scored one's place
                    state.players.p1.ground[0].id = 'another-copy';
                }
                return { ...st, state };
            });
            const g2 = { ...game, steps };
            return resolveScore(g2, sourcesFor(g2, [{ dir: '', file: sparse }])[0]).steps[h!.i];
        };
        const same = h ? heldWithIds(false) : null;
        const other = h ? heldWithIds(true) : null;
        check('held card values stay on the same card ids, and go when another copy of the card took its place (edge kept)',
            !!same && !!other && same.status === 'held' && !!same.seats && other.status === 'held' && other.seats == null && other.edge === same.edge,
            h ? `held step n ${h.n}: same ids ${same?.seats ? 'values' : 'none'}, another copy ${other?.seats ? 'values' : 'none'}` : 'no held step with card values on a p1 ground unit');

        const partial = copy();
        let withP = 0;
        for (const st of partial.steps) {
            if (st.search) {
                st.p1Win = 0.5;
                withP++;
            }
        }
        const a0 = swings(raw);
        const a1 = swings(partial);
        const moved = a1.filter((a, k) => Math.abs(a.swing - a0[k].swing) > 1e-9).length;
        const sp = seriesOf(partial);
        const ownKept = sp.steps.filter((x) => x.stepP1Win === 0.5).length;
        const onMap = sp.steps.every((x) => x.p1Win == null || x.p1WinFrom === 'map');
        check('p1Win on some steps of a rough file: chance stays rough, the chance and the swings stay on the rough map, the step\'s own p1Win kept apart',
            withP > 0 && sp.source.chance === 'rough' && moved === 0 && onMap && ownKept >= withP,
            `${withP} steps with p1Win, ${moved} swings changed, ${ownKept} steps keep their own p1Win, chance on the map: ${onMap}`);
        const bad = copy();
        bad.steps[5].p1Win = 1.7;
        const sb = seriesOf(bad);
        check('p1Win outside 0..1: left out (the map\'s chance instead), with a warning', sb.steps.find((x) => x.n === bad.steps[5].n)?.p1WinFrom === 'map'
            && sb.source.warnings.some((w) => w.startsWith('p1Win outside')), sb.source.warnings.join('; '));
        const tpl = copy();
        (tpl.evaluator!.terms!.side![0] as unknown as Obj).ruleTpl = 5;
        let tplOk = false;
        let tplWarn = '';
        try {
            const st = seriesOf(tpl);
            tplOk = st.source.rows.every((r) => typeof r.rule(st.steps[0].weights) === 'string');
            tplWarn = st.source.warnings.join('; ');
        } catch (e) {
            tplWarn = (e as Error).message;
        }
        check('a term with a ruleTpl that is not a string: dropped with a warning, no throw', tplOk && tplWarn.includes('ruleTpl'), tplWarn);
        const str = copy();
        const k = 60;
        const p1 = str.steps[k].p1 as unknown as Obj;
        const was = p1.base as number;
        p1.base = String(was);
        const ss = seriesOf(str);
        const at = ss.steps.find((x) => x.n === str.steps[k].n)!;
        check('a seat value that is not a number: read as 0 with a warning, and the Other row shows what it leaves out',
            at.seats?.p1.base === 0 && near(at.other?.p1 ?? 0, was, 0.06) && ss.source.warnings.some((w) => w.startsWith('seat values')), `base ${at.seats?.p1.base}, other ${at.other?.p1}`);
        const dup = copy();
        const twin = JSON.parse(JSON.stringify(dup.steps[k])) as Obj;
        twin.edge = (twin.edge as number) + 50;
        dup.steps.splice(k + 1, 0, twin);
        const sd = seriesOf(dup);
        check('a repeated step n: the last copy is read (as earlier builds did), with a warning', sd.steps.find((x) => x.n === twin.n)?.edge === twin.edge
            && sd.source.warnings.some((w) => w.startsWith('repeated step n')), sd.source.warnings.join('; '));
    });
    fixture('schema-2', ({ raw, source }) => {
        const r = readLens(raw);
        const want = 'This lens file is swu-lens/2; this viewer reads swu-lens/1.';
        check('schema-2: readLens refuses it with the message', 'error' in r && r.error === want, 'error' in r ? r.error : 'read');
        check('schema-2: its source carries the error and resolves to no values', source.error === want);
    });
    fixture('legacy-old-file', ({ raw, source, series }) => {
        const r = readLens(raw);
        check('legacy-old-file: read as "Omni v1 (old file)" with the rough chance', !('error' in r) && r.builtIn === 'legacy' && source.label === 'Omni v1 (old file)' && source.chance === 'rough', source.label);
        let units = 0;
        let off = 0;
        for (const st of series!.steps) {
            for (const s of SEATS) {
                const seat = st.seats?.[s];
                for (const z of ['ground', 'space'] as const) {
                    seat?.[z].forEach((v, k) => {
                        units++;
                        const p = seat.parts[z][k];
                        off += p && seat.partsFrom === 'computed' && near(Object.values(p).reduce((a, b) => a + b, 0), v) ? 0 : 1;
                    });
                }
            }
        }
        check('legacy-old-file: a split computed from the weights for every unit, adding up to its chip', units > 0 && off === 0, `${units} units, ${off} off`);
    });
    fixture('omni-fitted', ({ source }) => check('omni-fitted: chance fitted', source.chance === 'fitted', source.chance));
    fixture('misaligned', ({ game, series }) => {
        const s = series!;
        const gaps = new Set(s.steps.filter((x) => x.status === 'mismatch' || x.status === 'missing').map((x) => x.i));
        check('misaligned: one mismatch step and one missing step, both without values', s.coverage.mismatch === 1 && s.coverage.missing === 1 && [...gaps].every((i) => !s.steps[i].seats && s.steps[i].edge == null),
            JSON.stringify(s.coverage));
        const acts = classifyGame(game, undefined, s);
        const touching = acts.filter((a) => gaps.has(a.index - 1) || gaps.has(a.until));
        check('misaligned: swing 0 for every action that starts or ends at a gap', touching.length > 0 && touching.every((a) => a.swing === 0), `${touching.length} actions`);
    });
    fixture('sparse-decisions', ({ series }) => {
        const held = series!.steps.filter((x) => x.status === 'held');
        check('sparse-decisions: held steps, each with heldFrom at a file step', held.length > 0 && held.every((x) => x.heldFrom != null && series!.steps[x.heldFrom].status === 'file' && x.heldFromN === series!.steps[x.heldFrom].n),
            `${held.length} held, ${series!.coverage.file} from the file, ${series!.coverage.missing} before the first`);
    });
    fixture('phase-weights', ({ game, series }) => {
        const s = series!;
        const sw = s.steps.filter((x) => x.weightsChanged);
        check('phase-weights: weightsChanged at 2 steps, each with edgePrevWeights', sw.length === 2 && sw.every((x) => x.edgePrevWeights != null), sw.map((x) => `n ${x.n} ${x.weightSet} (prev ${x.edgePrevWeights})`).join(', '));
        const piv = pivotalActions(classifyGame(game, undefined, s), PIVOTAL_K, PIVOTAL_GAP);
        const across = piv.filter((a) => sw.some((x) => x.i >= a.index && x.i <= a.until));
        check('phase-weights: no pivotal action spans a weight switch', across.length === 0, across.map((a) => `${a.cls} at ${a.index} swing ${a.swing.toFixed(1)}`).join(', ') || `${piv.length} pivotal actions`);
    });
    fixture('inline-weights', ({ game, series }) => {
        const acts = classifyGame(game, undefined, series);
        check('inline-weights: weights change during the game, and swings across a change say so', series!.steps.some((x) => x.weightsChanged) && acts.some((a) => a.swingFrom?.weights?.switch === 'included'));
    });
    fixture('net-none', ({ game, source, series }) => {
        const s = series!;
        const acts = classifyGame(game, undefined, s).filter((a) => a.cls !== 'setup' && a.cls !== 'cancel' && !quiet(a));
        let checked = 0;
        let off = 0;
        for (const a of acts) {
            const p0 = s.steps[a.index - 1].p1Win;
            const p1 = s.steps[a.until].p1Win;
            if (p0 == null || p1 == null) {
                continue;
            }
            checked++;
            off += near(a.swing, 100 * (p1 - p0) * toward(a)) ? 0 : 1;
        }
        check('net-none: chance model from the steps\' p1Win, no seats', source.chance === 'model' && s.steps.every((x) => x.p1WinFrom === 'step' && !x.seats));
        check('net-none: every play\'s swing is its change of p1Win in pp', checked > 0 && off === 0, `${checked} actions, ${off} off`);
    });
    fixture('ablation', ({ source, series }) => {
        const s = series!;
        const tol = 0.05;
        let withOther = 0;
        let off = 0;
        for (const st of s.steps) {
            if (!st.seats || st.edge == null) {
                continue;
            }
            const rows = source.rows.filter((r) => r.group !== 'joint').reduce((a, r) => a + rowValue(r, st).edge, 0);
            const joint = Object.values(st.joint).reduce((a, b) => a + b, 0);
            const want = st.edge - rows - joint;
            withOther += st.other ? 1 : 0;
            off += st.other ? (near(st.other.edge, want) ? 0 : 1) : Math.abs(want) > tol ? 1 : 0;
        }
        check('ablation: the Other row is edge − Σ rows wherever they differ', withOther > 0 && off === 0, `${withOther} steps with Other, ${off} off`);
    });
    fixture('logit-linear', ({ source, series }) => {
        const ids = source.rows.map((r) => r.id);
        const st = series!.steps.find((x) => x.edge != null)!;
        check('logit-linear: chance model, kEff 1, half-bar 1.2, rows with deck, discard, pressure and the joint toAct',
            source.chance === 'model' && source.kEff === 1 && series!.scales.halfBar === 1.2 && ['extra.deck', 'extra.discard', 'extra.pressure', 'joint.toAct'].every((x) => ids.includes(x))
            && near(st.p1Win, 1 / (1 + Math.exp(-st.edge!))) && series!.unsplit === 0, ids.join(', '));
    });
    fixture('asymmetric-pair', ({ game, source, series }) => {
        const acts = classifyGame(game, undefined, series);
        check('asymmetric-pair: "Aggro, as heuristic weighs it", no chance, half-bar 18, swings sized from points',
            source.label === 'Aggro, as heuristic weighs it' && source.chance === 'none' && series!.scales.halfBar === 18 && acts.every((a) => a.swingFrom?.chance === 'none'),
            `${source.label}, ${source.chance}, ${series!.scales.halfBar}`);
    });
    fixture('uncalibrated-tenths', ({ source }) => check('uncalibrated-tenths: no chance, typical from the percentile', source.chance === 'none' && source.typicalFrom === 'percentile', `typical ${source.typical}`));
    fixture('search-proven', ({ series }) => {
        const st = series!.steps;
        const win = st.filter((x) => x.search?.sees === 'win').length;
        const loss = st.filter((x) => x.search?.sees === 'loss').length;
        const proven = st.filter((x) => x.proven);
        check('search-proven: sentinels read as "sees win/loss", proven only from step.proven', win === 1 && loss === 1 && proven.length === 2 && proven.every((x) => x.proven!.seat === 'p1' && x.proven!.by === 'and-or' && x.proven!.inWindows === 3),
            `win ${win}, loss ${loss}, proven ${proven.length}`);
    });
    const reg = caseOf('registry');
    if (reg) {
        const registry = JSON.parse(fs.readFileSync(path.join(args.dir, reg.lensDir, 'evaluators.json'), 'utf8'));
        const gid = 'heuristic-vs-omni-102';
        const files = reg.files.filter((f) => path.basename(f, '.json') === gid).map((f) => ({ dir: path.dirname(f) === '.' ? '' : path.dirname(f), file: rawOf(reg, f) }));
        const game = gameOf(gid);
        const sources = sourcesFor(game, [...files].reverse(), registry);
        check('registry: one source per file of the game, in the registry\'s order; "" first; ?score=linear-g2 opens it',
            sources.map((x) => x.key).join(',') === ',linear-g2,heur-aggro@p1' && chooseDefault(sources, { registryDefault: registry.default })?.key === '' && chooseDefault(sources, { requested: 'linear-g2' })?.key === 'linear-g2',
            sources.map((x) => x.key || '""').join(', '));
    }
    const nf = caseOf('no-file');
    if (nf) {
        const game = gameOf(nf.games[0]);
        const sources = sourcesFor(game, []);
        const series = resolveScore(game, sources[0]);
        check('no-file: the Omni v1 estimate on every step; with estimate off, no score', sources.length === 1 && sources[0].origin === 'estimate' && series.coverage.estimate === game.steps.length
            && chooseDefault(sourcesFor(game, [], null, { estimate: false })) === null, sources[0]?.label);
    }
    // the estimate rounds as the old viewer and the writer do: each unit's raw parts summed, then × exhaustedMult once
    const w = OMNI_V1_WEIGHTS;
    const oldUnit = (u: UnitRef) => {
        let v = u.p * w.power + Math.max(0, u.h - u.d) * w.hp;
        for (const up of u.u ?? []) {
            v += up.n === 'Shield' ? w.shield : w.upgrade;
        }
        v += u.sn ? w.sentinel : 0;
        return Math.round((u.x ? v * w.exhaustedMult : v) * 100) / 100;
    };
    const oldBase = (left: number) => {
        const hp = Math.max(0, left);
        return Math.round(w.baseMult * (hp * w.baseHp - (hp <= 12 ? (12 - hp) ** 2 / 6 : 0)) * 100) / 100;
    };
    let units = 0;
    let exhausted = 0;
    const offs: string[] = [];
    for (const f of fs.readdirSync(replays).filter((x) => x.endsWith('.jsonl')).sort(byName)) {
        for (const st of gameOf(f.slice(0, -'.jsonl'.length)).steps) {
            const e = estimateOmniV1(st.state);
            for (const s of SEATS) {
                const p = st.state.players[s];
                for (const z of ['ground', 'space'] as const) {
                    p[z].forEach((u, k) => {
                        units++;
                        exhausted += u.x ? 1 : 0;
                        if (e[s][z][k] !== oldUnit(u) && offs.length < 3) {
                            offs.push(`${f} n ${st.n} ${s}.${z}[${k}]: ${e[s][z][k]} vs ${oldUnit(u)}`);
                        }
                    });
                }
                if (e[s].base !== oldBase(p.base.hp - p.base.d) && offs.length < 3) {
                    offs.push(`${f} n ${st.n} ${s}.base: ${e[s].base} vs ${oldBase(p.base.hp - p.base.d)}`);
                }
            }
        }
    }
    check('estimate: every unit and base value equals the old formula, r2(mult × Σ raw parts), on every fixture replay', !offs.length && exhausted > 0,
        offs.length ? offs.join('; ') : `${units} unit values, ${exhausted} exhausted`);
    console.log(`selftest: ${passed} passed, ${failed} failed`);
    return failed ? 1 : 0;
}

const args = parseArgs(process.argv.slice(2));
process.exitCode = args.mode === 'golden' ? golden(args) : args.mode === 'compare' ? compare(args) : args.mode === 'selftest' ? selftest(args) : validate(args);

