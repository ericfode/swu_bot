#!/usr/bin/env node
'use strict';
/**
 * The games helper's live view (bot/arena/HELPER.md): the games your computer is playing for the arena, their boards,
 * the seeds it finished, and how much of the computer it uses. helper.sh starts it when its output is a terminal.
 *
 *   node bot/arena/ops/helper-tui.js run [--slots N]   run helper.sh under the view (q stops the helper)
 *   node bot/arena/ops/helper-tui.js watch             watch a helper that already runs (q leaves it running)
 *
 * It reads only what the helper already makes: helper.sh's and the container's log lines, `docker stats`, and the
 * games in play, which a small reader prints once a second from inside the container (`docker exec -u arena`): each
 * lease's job.json and the last line of each replay in its out/ folder. Everything it reads is shown as data: names
 * and log lines are cleaned of control characters before they reach the terminal (bots and decks name them).
 * Keys: q quit, + and - choose the slots (Enter restarts the helper with them, and helper.sh keeps the choice in
 * ~/.config/swu-helper/slots), l the log, ? help. No packages: Node 18 or later.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONTAINER = 'swu-helper';
const SLOTS_FILE = path.join(os.homedir(), '.config', 'swu-helper', 'slots');
// run mode keeps the lines it read here (docker run --rm leaves no logs behind), the last 10 MB and the 10 MB before
const LOG_FILE = process.env.SWU_HELPER_LOG || path.join(os.homedir(), '.config', 'swu-helper', 'helper.log');
const LOG_MAX = 10 << 20;
const MAX_SLOTS = 16; // what the coordinator accepts
const TARGET = Number(process.env.SWU_HELPER_TARGET) || 25; // the share of this computer the CPU gauge marks, in %
const FPS = 8;
const CPU_SAMPLES = 150; // about five minutes of docker stats

// --- pure parts (bot/test/helper-tui.test.js)

// C0 and C1 controls, DEL, bidi and zero-width marks: nothing a name or a log line may send to the terminal
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
// characters most terminals draw two cells wide (CJK, emoji, astral planes): one '?' keeps the columns straight
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/g;
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-_]/g;

/** A string from the helper or its games, safe to print: one line, no controls, one cell per character, at most max. */
function clean(value, max = 200) {
    const s = String(value ?? '').replace(ANSI, '').replace(/[\r\n\t]+/g, ' ').replace(CONTROL, '').replace(WIDE, '?');
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** "rust-greedy2-wasm-vs-node-search-wasm-3250146062" -> {p1, p2, seed}; bot names never hold "-vs-". */
function splitGameId(id) {
    const m = /^(.+?)-vs-(.+)-(\d+)$/.exec(String(id));
    return m ? { p1: m[1], p2: m[2], seed: m[3] } : { p1: String(id), p2: '?', seed: '' };
}

/** One game of a helper's lease line ("<id> won p1", "<id> ERROR p2", "<id> STEP_CAP"): its bots and its winner. */
function gameOutcome(text) {
    const [id, outcome = '?', seat = null] = String(text).trim().split(' ');
    const { p1, p2 } = splitGameId(id);
    const winner = (outcome === 'won' || outcome === 'ERROR') && (seat === 'p1' || seat === 'p2') ? (seat === 'p1' ? p1 : p2) : null;
    return { id, p1, p2, outcome, seat, winner };
}

const SCRIPT = [
    [/^building the coordinator/, () => ({ kind: 'building' })],
    [/^pulling (\S+)/, (m) => ({ kind: 'pulling', image: m[1] })],
    [/^(?:built|using) swu-helper:([0-9a-f]{7})/, (m) => ({ kind: 'built', sha: m[1] })],
    [/^playing with (\d+) slots/, (m) => ({ kind: 'starting', slots: Number(m[1]) })],
    [/^the games machine runs another build/, () => ({ kind: 'newbuild' })],
    [/^fetching commit ([0-9a-f]{7})/, (m) => ({ kind: 'building', sha: m[1] })],
    [/^helper\.sh: (.*)/, (m) => ({ kind: 'fatal', why: m[1] })],
    [/^Rust simulations are not available/, () => ({ kind: 'norust' })],
    [/^#\d+ /, () => ({ kind: 'buildlog' })],
];

const COORD = [
    [/^lease (\S+) \(seed (\d+|\?)\): failed \((.*)\); (\d+) s(.*)$/, (m) => ({ kind: 'failed', lease: m[1], seed: m[2], why: m[3], secs: Number(m[4]) })],
    [/^lease (\S+) \(seed (\d+|\?)\): (.*); (\d+) s(.*)$/, (m) => ({ kind: 'seed', lease: m[1], seed: m[2], games: m[3].split(', ').map(gameOutcome), secs: Number(m[4]), note: m[5].trim() })],
    [/knows this helper as (\S+); (\d+) slots/, (m) => ({ kind: 'hello', name: m[1], slots: Number(m[2]) })],
    [/^hello: no answer/, () => ({ kind: 'nomachine' })],
    [/^slot \S+: no claim/, () => ({ kind: 'nomachine' })],
    [/answers again/, () => ({ kind: 'machine' })],
    [/took it back/, () => ({ kind: 'takenBack' })],
    [/the computer slept/, () => ({ kind: 'slept' })],
    [/SIGTERM received/, () => ({ kind: 'stopping' })],
];

/**
 * A line of helper.sh or of the helper's coordinator ("03:28:13.148 [warning] hello: ..."), as an event:
 * {kind, time?, level?, text} plus the kind's fields. Unknown lines are kind 'log'.
 */
function parseLine(raw) {
    const text = clean(raw, 400);
    const m = /^(\d\d:\d\d:\d\d)(?:\.\d+)? \[(\w+)\] (.*)$/.exec(text);
    const [time, level, msg] = m ? [m[1], m[2], m[3]] : [null, null, text];
    for (const [re, make] of m ? COORD : SCRIPT) {
        const hit = re.exec(msg);
        if (hit) {
            return { ...make(hit), time, level, text, msg };
        }
    }
    return { kind: 'log', time, level, text, msg };
}

/** docker stats' "1.2GiB" -> bytes */
function bytes(text) {
    const m = /([\d.]+)\s*([KMGT]?i?B)/i.exec(String(text));
    if (!m) {
        return null;
    }
    const unit = { b: 0, kb: 1, kib: 1, mb: 2, mib: 2, gb: 3, gib: 3, tb: 4, tib: 4 }[m[2].toLowerCase()] ?? 0;
    return Number(m[1]) * (m[2].toLowerCase().includes('i') || unit === 0 ? 1024 : 1000) ** unit;
}

/** A line of `docker stats --format '{{json .}}'` (it may carry cursor codes) -> {cores, mem, limit} or null. */
function parseStats(line) {
    const json = /\{.*\}/.exec(String(line).replace(ANSI, ''));
    if (!json) {
        return null;
    }
    try {
        const s = JSON.parse(json[0]);
        const [used, limit] = String(s.MemUsage ?? '').split('/');
        return { cores: (parseFloat(s.CPUPerc) || 0) / 100, mem: bytes(used), limit: bytes(limit) };
    } catch {
        return null;
    }
}

/**
 * What the view shows of a replay line (spec/replay-format.md): a step's position, or the end. Runs here and, as
 * source, in the reader inside the container, so it uses nothing but its argument.
 */
function summarizeStep(x) {
    if (!x || typeof x !== 'object') {
        return null;
    }
    if (x.t === 'end') {
        return { end: { winner: x.winner ?? null, outcome: x.outcome ?? null, round: x.round ?? null, steps: x.steps ?? null } };
    }
    if (x.t !== 'step' || !x.state || typeof x.state !== 'object') {
        return null;
    }
    const units = (list) => (Array.isArray(list) ? list.slice(0, 12).map((u) => [u?.p ?? 0, u?.h ?? 0, u?.d ?? 0, u?.x ? 1 : 0]) : []);
    const side = (p) => (p && typeof p === 'object' ? {
        base: String(p.base?.n ?? ''), hp: Number(p.base?.hp) || 0, d: Number(p.base?.d) || 0,
        leader: String(p.leader?.n ?? ''), dep: p.leader?.dep ? 1 : 0,
        ready: Number(p.res?.ready) || 0, total: Number(p.res?.total) || 0,
        hand: Number(p.handCount ?? (Array.isArray(p.hand) ? p.hand.length : 0)) || 0, deck: Number(p.deck) || 0,
        ground: units(p.ground), space: units(p.space),
    } : null);
    const label = x.action && typeof x.action === 'object' ? x.action.label ?? x.action.kind ?? '' : '';
    return {
        n: Number(x.n) || 0, actor: x.pid ?? null, label: String(label), round: Number(x.state.round) || 0,
        phase: String(x.state.phase ?? ''), p1: side(x.state.players?.p1), p2: side(x.state.players?.p2),
    };
}

/**
 * The reader that runs inside the container as the bots' user (`docker exec -u arena ... node -e`), once a second:
 * one JSON line, {t, rust, slots: [{slot, lease, seed, since, games: [{id, bots, size, mtime, last}]}]}. It opens
 * only regular files (lstat), reads at most the first 64 KB and the last 256 KB of a replay, and caches headers.
 */
function reader(summarize, ROOT) {
    const fs = require('fs');
    const path = require('path');
    const HEAD = 65536;
    const TAIL = 131072;
    const headers = new Map();
    const jobs = new Map();
    const regular = (p) => {
        try {
            const s = fs.lstatSync(p);
            return s.isFile() ? s : null;
        } catch {
            return null;
        }
    };
    const readRange = (file, start, length) => {
        const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
        try {
            const buf = Buffer.alloc(length);
            const n = fs.readSync(fd, buf, 0, length, start);
            return buf.subarray(0, n).toString('utf8');
        } finally {
            fs.closeSync(fd);
        }
    };
    const firstLine = (file, size) => {
        if (!headers.has(file)) {
            const text = readRange(file, 0, Math.min(size, HEAD));
            const end = text.indexOf('\n');
            if (end < 0) {
                return null;
            }
            try {
                const h = JSON.parse(text.slice(0, end));
                headers.set(file, Array.isArray(h.players) ? h.players.map((p) => String(p?.bot ?? '?')) : null);
            } catch {
                headers.set(file, null);
            }
        }
        return headers.get(file);
    };
    const lastLine = (file, size) => {
        const start = Math.max(0, size - TAIL);
        const lines = readRange(file, start, size - start).split('\n');
        if (start > 0) {
            lines.shift();
        }
        for (let i = lines.length - 1; i >= 0 && i >= lines.length - 3; i--) {
            if (lines[i]) {
                try {
                    return summarize(JSON.parse(lines[i]));
                } catch {
                    // the line being written
                }
            }
        }
        return null;
    };
    const list = (dir) => {
        try {
            return fs.readdirSync(dir);
        } catch {
            return [];
        }
    };
    const tick = () => {
        const slots = [];
        const seen = new Set();
        // the slots' folders are "1" to "16"; /data/helper itself may not be listed by this user
        for (let i = 1; i <= 16; i++) {
            for (const lease of list(`${ROOT}/${i}`)) {
                const dir = path.join(ROOT, String(i), lease);
                const jobFile = path.join(dir, 'job.json');
                seen.add(jobFile);
                const js = regular(jobFile);
                if (js && !jobs.has(jobFile) && js.size < 1 << 20) {
                    try {
                        const j = JSON.parse(readRange(jobFile, 0, js.size));
                        jobs.set(jobFile, { seed: j.seed ?? null, games: Array.isArray(j.games) ? j.games.map((g) => ({ id: String(g?.id ?? ''), bots: [String(g?.p1 ?? '?'), String(g?.p2 ?? '?')] })) : [] });
                    } catch {
                        // written in a moment
                    }
                }
                const job = jobs.get(jobFile) ?? { seed: null, games: [] };
                const games = job.games.map((g) => {
                    const file = path.join(dir, 'out', `${g.id}.jsonl`);
                    seen.add(file);
                    const s = regular(file);
                    if (!s) {
                        return { id: g.id, bots: g.bots, size: 0, mtime: null, last: null };
                    }
                    let last = null;
                    try {
                        firstLine(file, s.size);
                        last = lastLine(file, s.size);
                    } catch {
                        // gone meanwhile
                    }
                    return { id: g.id, bots: headers.get(file) ?? g.bots, size: s.size, mtime: s.mtimeMs, last };
                });
                slots.push({ slot: i, lease, seed: job.seed, since: js ? js.mtimeMs : null, games });
            }
        }
        for (const cache of [headers, jobs]) {
            for (const key of cache.keys()) {
                if (!seen.has(key)) {
                    cache.delete(key);
                }
            }
        }
        const rust = fs.existsSync('/app/bot/omni-wasm/pkg/node/omni_wasm.js');
        process.stdout.write(JSON.stringify({ t: Date.now(), rust, slots }) + '\n');
    };
    tick();
    setInterval(tick, 1000);
    // the view holds stdin open (docker exec -i): when it goes, so does this reader
    process.stdin.on('end', () => process.exit(0));
    process.stdin.on('error', () => process.exit(0));
    process.stdin.resume();
    process.stdout.on('error', () => process.exit(0));
}

/**
 * The reader's line as the view keeps it: every string cleaned, every number a finite number, lists cut to size.
 * The reader runs where the bots run, so its output is treated as data from them.
 */
function sanitizeLive(x, depth = 0) {
    if (depth > 12) {
        return null;
    }
    if (typeof x === 'string') {
        return clean(x, 80);
    }
    if (typeof x === 'number') {
        return Number.isFinite(x) ? x : 0;
    }
    if (typeof x === 'boolean' || x === null) {
        return x;
    }
    if (Array.isArray(x)) {
        return x.slice(0, 16).map((v) => sanitizeLive(v, depth + 1));
    }
    if (typeof x === 'object') {
        const o = {};
        for (const k of Object.keys(x).slice(0, 24)) {
            o[clean(k, 20)] = sanitizeLive(x[k], depth + 1);
        }
        return o;
    }
    return null;
}

/** The reader as one `node -e` program, for the helper folder root (the container's /data/helper). */
const readerSource = (root = '/data/helper') => `(${reader})(${summarizeStep}, ${JSON.stringify(root)});`;

const BLOCKS = ' ▏▎▍▌▋▊▉█';
/** A bar of width cells, fraction filled, in eighths. */
function bar(fraction, width) {
    const f = Math.max(0, Math.min(1, Number(fraction) || 0)) * width;
    const full = Math.floor(f);
    const part = Math.round((f - full) * 8);
    let s = '█'.repeat(full);
    if (full < width) {
        s += part ? BLOCKS[part] : '';
    }
    return s.padEnd(width, ' ').slice(0, width);
}

const SPARK = '▁▂▃▄▅▆▇█';
/** The last width values as a sparkline, top at max. */
function sparkline(values, width, max) {
    const v = values.slice(-width);
    const top = max || Math.max(1e-9, ...v);
    return v.map((x) => SPARK[Math.max(0, Math.min(7, Math.round((x / top) * 7)))]).join('').padStart(width, ' ');
}

const pad2 = (n) => String(n).padStart(2, '0');
/** 75 -> "1:15", 3800 -> "1h03m" */
function duration(secs) {
    const s = Math.max(0, Math.floor(secs));
    return s >= 3600 ? `${Math.floor(s / 3600)}h${pad2(Math.floor((s % 3600) / 60))}m` : `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

// --- drawing: a frame is a list of lines, a line a list of [text, style] segments, cut or padded to the width

const ESC = '\u001b[';
const fg = (n) => `${ESC}38;5;${n}m`;
const S = {
    dim: fg(244), faint: fg(239), text: fg(252), white: fg(231), bold: `${ESC}1m`,
    p1: fg(81), p2: fg(211), gold: fg(221), green: fg(78), yellow: fg(221), red: fg(203), blue: fg(75), violet: fg(141),
};
const hpStyle = (f) => (f > 0.6 ? S.green : f > 0.3 ? S.yellow : S.red);

/** A line's segments as text of exactly width cells (segment texts are cleaned and one cell per character). */
function renderLine(segs, width) {
    let out = '';
    let used = 0;
    for (const [text, style] of segs) {
        if (used >= width) {
            break;
        }
        const t = String(text).replace(CONTROL, '').slice(0, width - used);
        used += t.length;
        out += style ? `${style}${t}${ESC}0m` : t;
    }
    return out + ' '.repeat(width - used);
}

const visible = (segs) => segs.reduce((n, [t]) => n + String(t).length, 0);
/** segments cut to at most width cells */
function cut(segs, width) {
    const out = [];
    let used = 0;
    for (const [text, style] of segs) {
        const t = String(text).slice(0, Math.max(0, width - used));
        if (t) {
            out.push([t, style]);
        }
        used += t.length;
    }
    return out;
}
/** left, then right aligned to the end of width */
function spread(left, right, width) {
    const gap = width - visible(left) - visible(right);
    return gap >= 1 ? [...left, [' '.repeat(gap)], ...right] : left;
}

const short = (name, n) => (name.length > n ? name.slice(0, n - 1) + '…' : name.padEnd(n));

// --- the view's state

function newState(mode, now = Date.now()) {
    return {
        mode, phase: 'starting', note: '', name: null, slots: null, nextSlots: null, sha: null, rust: null,
        started: now, cpu: [], cores: os.cpus().length, model: (os.cpus()[0]?.model ?? '').trim(), mem: null, limit: null,
        peakMem: 0, seeds: 0, games: 0, failed: 0, takenBack: 0, seedSecs: [], wins: new Map(), results: [],
        live: null, liveAt: 0, shown: new Map(), ends: new Map(), logs: [], lastEvent: null, showLog: false, help: false,
        buildLine: '', buildSince: null, exit: null, stopping: false, ticks: 0, stars: null,
    };
}

function tally(state, bot, key) {
    const t = state.wins.get(bot) ?? { w: 0, l: 0, o: 0 };
    t[key]++;
    state.wins.set(bot, t);
}

/** Applies one parsed line to the state. */
function apply(state, ev, now = Date.now()) {
    if (ev.kind !== 'buildlog') {
        state.logs.push(ev);
        if (state.logs.length > 300) {
            state.logs.shift();
        }
    }
    if (ev.level === 'warning' || ev.level === 'error' || ev.kind === 'fatal' || ev.kind === 'failed') {
        state.lastEvent = { text: ev.msg ?? ev.text, level: ev.kind === 'fatal' || ev.level === 'error' ? 'error' : 'warning', at: now };
    }
    switch (ev.kind) {
    case 'building':
    case 'pulling':
        state.phase = 'building';
        state.buildSince ??= now;
        state.note = ev.kind === 'pulling' ? 'pulling the games image' : 'building the helper image for this computer';
        break;
    case 'buildlog':
        state.buildLine = ev.text;
        break;
    case 'built':
        state.sha = ev.sha;
        state.buildSince = null;
        break;
    case 'starting':
        state.phase = 'connecting';
        state.slots = ev.slots;
        state.note = 'starting the helper';
        break;
    case 'hello':
        state.phase = 'connected';
        state.name = ev.name;
        state.slots = ev.slots;
        state.note = '';
        break;
    case 'nomachine':
        state.phase = 'nomachine';
        break;
    case 'machine':
        state.phase = 'connected';
        break;
    case 'newbuild':
        state.phase = 'building';
        state.note = 'the games machine moved to a new build';
        state.buildSince = now;
        break;
    case 'norust':
        state.rust = false;
        break;
    case 'takenBack':
        state.takenBack++;
        break;
    case 'failed':
        state.failed++;
        state.results.unshift({ at: now, time: ev.time, seed: ev.seed, failed: ev.why, secs: ev.secs });
        break;
    case 'seed':
        state.seeds++;
        state.games += ev.games.length;
        state.seedSecs.push(ev.secs);
        for (const g of ev.games) {
            if (g.winner) {
                tally(state, g.winner, 'w');
                tally(state, g.winner === g.p1 ? g.p2 : g.p1, 'l');
            } else {
                tally(state, g.p1, 'o');
                tally(state, g.p2, 'o');
            }
        }
        state.results.unshift({ at: now, time: ev.time, seed: ev.seed, games: ev.games, secs: ev.secs, note: ev.note });
        break;
    case 'stopping':
        state.phase = 'stopping';
        break;
    case 'fatal':
        state.note = ev.why;
        break;
    default:
    }
    state.results.length = Math.min(state.results.length, 60);
}

function applyStats(state, s) {
    state.cpu.push(s.cores);
    if (state.cpu.length > CPU_SAMPLES) {
        state.cpu.shift();
    }
    state.mem = s.mem;
    state.limit = s.limit;
    state.peakMem = Math.max(state.peakMem, s.mem ?? 0);
}

function applyLive(state, raw, now = Date.now()) {
    const live = sanitizeLive(raw);
    if (!live || typeof live !== 'object') {
        return;
    }
    state.live = live;
    state.liveAt = now;
    if (typeof live.rust === 'boolean') {
        state.rust = live.rust;
    }
    if (live.slots?.length && ['connected', 'nomachine', 'connecting'].includes(state.phase)) {
        state.phase = 'connected';
    }
    for (const sl of live.slots ?? []) {
        for (const g of sl.games ?? []) {
            const last = g.last;
            if (last?.end && !state.ends.has(g.id)) {
                state.ends.set(g.id, now);
            }
            if (!last || last.end) {
                continue;
            }
            // the bases' remaining hp eases toward the real value, and a hit flashes for a moment
            const prev = state.shown.get(g.id);
            const real = [last.p1, last.p2].map((p) => (p && p.hp ? (p.hp - p.d) / p.hp : 1));
            if (!prev) {
                state.shown.set(g.id, { hp: real.slice(), real, hit: [0, 0], seen: now });
            } else {
                for (const k of [0, 1]) {
                    if (real[k] < prev.real[k] - 1e-9) {
                        prev.hit[k] = now;
                    }
                }
                prev.real = real;
                prev.seen = now;
            }
        }
    }
    for (const [id, d] of state.shown) {
        if (now - d.seen > 60000) {
            state.shown.delete(id);
        }
    }
    for (const [id, at] of state.ends) {
        if (now - at > 600000) {
            state.ends.delete(id);
        }
    }
}

/** One animation step: eased hp, moving stars. */
function step(state, dt = 1 / FPS) {
    state.ticks++;
    for (const d of state.shown.values()) {
        for (const k of [0, 1]) {
            d.hp[k] += (d.real[k] - d.hp[k]) * Math.min(1, dt * 6);
        }
    }
}

// --- the frame

const PHASES = {
    starting: ['STARTING', S.blue], building: ['BUILDING', S.violet], connecting: ['CONNECTING', S.blue],
    connected: ['READY', S.green], playing: ['PLAYING', S.green], nomachine: ['MACHINE ASLEEP', S.yellow],
    stopping: ['STOPPING', S.yellow], stopped: ['STOPPED', S.red], watching: ['WATCHING', S.blue],
};
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const TITLE = 'SWU ARENA HELPER';
const RAMP = [33, 39, 45, 51, 87, 123, 159, 195, 159, 123, 87, 51, 45, 39];

function liveSlots(state, now) {
    return state.live && now - state.liveAt < 5000 ? state.live.slots ?? [] : [];
}

function phaseOf(state, now) {
    if (state.exit !== null) {
        return 'stopped';
    }
    if (state.stopping) {
        return 'stopping';
    }
    if (state.phase === 'connected' && liveSlots(state, now).length) {
        return 'playing';
    }
    return state.phase;
}

/** Stars across width cells; they fly faster the harder the computer works. */
function starfield(state, width, row, speed) {
    state.stars ??= {};
    let field = state.stars[row];
    if (!field || field.width !== width) {
        let seed = 7 + row * 101;
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        field = state.stars[row] = { width, list: Array.from({ length: Math.max(3, Math.floor(width / 9)) }, () => ({ x: rnd() * width, depth: 0.3 + rnd() * 0.7 })) };
    }
    const cells = Array(width).fill(null);
    for (const s of field.list) {
        s.x -= s.depth * speed;
        if (s.x < 0) {
            s.x += width;
        }
        const x = Math.min(width - 1, Math.floor(s.x));
        const trail = speed * s.depth > 1.2 ? Math.min(6, Math.round(speed * s.depth * 2)) : 0;
        for (let k = trail; k >= 1; k--) {
            if (x + k < width && !cells[x + k]) {
                cells[x + k] = ['─', S.faint];
            }
        }
        cells[x] = [s.depth > 0.75 ? '✦' : s.depth > 0.5 ? '•' : '·', s.depth > 0.75 ? S.white : S.dim];
    }
    return cells.map((c) => c ?? [' ']);
}

function header(state, W, now) {
    const phase = phaseOf(state, now);
    const [label, style] = PHASES[phase] ?? [phase.toUpperCase(), S.text];
    const title = [...TITLE].map((ch, i) => [ch, `${S.bold}${fg(RAMP[(i + Math.floor(state.ticks / 2)) % RAMP.length])}`]);
    const who = state.name ? `${state.name} → swu-arena-games` : 'swu-arena-games';
    const left = [[' ✦ ', S.gold], ...title, ['   '], [who, S.dim], ['   ● ', style], [label, `${S.bold}${style}`]];
    const right = [[`  ${duration((now - state.started) / 1000)} `, S.dim]];
    const share = state.cpu.length ? state.cpu[state.cpu.length - 1] / state.cores : 0;
    const speed = 0.15 + 2.2 * Math.min(2, share / (TARGET / 100));
    const gap = W - visible(left) - visible(right);
    const lines = [gap > 0 ? [...left, ...starfield(state, gap, 0, speed), ...right] : left];
    lines.push(starfield(state, W, 1, speed));
    return lines;
}

function gauges(state, W) {
    const cores = state.cpu.length ? state.cpu[state.cpu.length - 1] : 0;
    const share = cores / state.cores;
    const gw = Math.max(10, Math.min(40, W - 64));
    const g = bar(share, gw).split('');
    const mark = Math.min(gw - 1, Math.round((TARGET / 100) * gw));
    const near = Math.abs(share * 100 - TARGET) <= 5;
    const cpuStyle = near ? S.green : share * 100 > TARGET ? S.yellow : S.blue;
    const gauge = g.map((c, i) => (i === mark && c === ' ' ? ['│', S.gold] : [c, cpuStyle]));
    const avg = state.cpu.length ? state.cpu.reduce((a, b) => a + b, 0) / state.cpu.length / state.cores : 0;
    const cpu = [[' CPU ', S.dim], ['▕', S.faint], ...gauge, ['▏', S.faint],
        [` ${String(Math.round(share * 100)).padStart(3)}%`, `${S.bold}${cpuStyle}`], [' of this computer', S.dim],
        [`  ${cores.toFixed(1)}/${state.cores} cores`, S.text], [`  aim ${TARGET}%`, S.gold], [`  avg ${Math.round(avg * 100)}%`, S.dim]];
    const sw = W - visible(cpu) - 2;
    if (sw >= 8) {
        cpu.push(['  '], [sparkline(state.cpu, sw, state.cores * 0.5), cpuStyle]);
    }
    const memShare = state.mem && state.limit ? state.mem / state.limit : 0;
    const gb = (b) => (b / 1024 ** 3).toFixed(1);
    const mem = [[' MEM ', S.dim], ['▕', S.faint], [bar(memShare, gw), memShare > 0.8 ? S.red : memShare > 0.6 ? S.yellow : S.violet], ['▏', S.faint],
        [state.mem ? ` ${gb(state.mem)} of ${gb(state.limit)} GB` : ' -', S.text], [state.peakMem ? `  peak ${gb(state.peakMem)} GB` : '', S.dim],
        [state.slots ? `   ${state.slots} slots · ${state.slots * 2} games at once` : '', S.text],
        [state.slots && state.nextSlots && state.nextSlots !== state.slots ? `  → ${state.nextSlots} (Enter restarts)` : '', S.gold]];
    const hours = Math.max(1 / 60, (Date.now() - state.started) / 3600000);
    const avgSeed = state.seedSecs.length ? Math.round(state.seedSecs.reduce((a, b) => a + b, 0) / state.seedSecs.length) : null;
    const stats = [[' ', null], [String(state.games), `${S.bold}${S.white}`], [' games  ', S.dim], [String(state.seeds), S.white], [' seeds  ', S.dim],
        [String(Math.round(state.games / hours)), S.white], [' games/h  ', S.dim],
        [avgSeed === null ? '-' : `${avgSeed} s`, S.white], [' per seed  ', S.dim],
        [String(state.failed), state.failed ? S.red : S.white], [' failed  ', S.dim],
        [String(state.takenBack), state.takenBack ? S.yellow : S.white], [' taken back  ', S.dim],
        ['Rust sims ', S.dim], state.rust === null ? ['?', S.dim] : state.rust ? ['on', S.green] : ['off', S.yellow]];
    return [cpu, mem, stats];
}

function hpBar(frac, hit, width, mirrored, now) {
    const fresh = hit && now - hit < 1200;
    const b = bar(frac, width);
    const style = fresh && Math.floor(now / 150) % 2 ? S.white : hpStyle(frac);
    const filled = b.trimEnd();
    const empty = ' '.repeat(width - filled.length).replace(/ /g, '░');
    return mirrored
        ? [[empty, S.faint], [[...filled].reverse().join('').replace(/[▏▎▍▌▋▊▉]/g, '▐'), style]]
        : [[filled, style], [empty, S.faint]];
}

function unitsText(p) {
    if (!p) {
        return [];
    }
    const segs = [];
    for (const [list, mark] of [[p.ground, '▪'], [p.space, '▴']]) {
        for (const [pow, , , x] of list) {
            segs.push([`${mark}${pow} `, x ? S.dim : S.text]);
        }
    }
    return segs.length ? segs : [['no units ', S.faint]];
}

/** One game: a line with both bases (and a board line when roomy). */
function gameLines(state, g, W, roomy, now) {
    const last = g.last;
    const [b1, b2] = (g.bots ?? []).map((b) => clean(b, 40));
    if (!last) {
        return [[['     '], [SPIN[state.ticks % SPIN.length], S.blue], [` ${b1} vs ${b2}`, S.text], ['  loading the bots…', S.dim]]];
    }
    if (last.end) {
        const e = last.end;
        const w = e.winner === 'p1' ? b1 : e.winner === 'p2' ? b2 : null;
        const sparkle = '✦✧★✧'[Math.floor(now / 200) % 4];
        const ended = state.ends.get(g.id) ?? now;
        const band = now - ended < 4000 ? [...'  ✦ · ✧ · ★ · ✧ · '.repeat(4)].slice(state.ticks % 6, (state.ticks % 6) + 24).join('') : '';
        const lines = [[['     '], [w ? `${sparkle} ${w} wins` : `${clean(e.outcome ?? 'over', 20)}`, `${S.bold}${S.gold}`],
            [`   ${b1} vs ${b2} · R${e.round ?? '?'} · ${e.steps ?? '?'} steps`, S.dim], [band, S.gold]]];
        return roomy ? [...lines, [['']]] : lines;
    }
    const shown = state.shown.get(g.id) ?? { hp: [1, 1], hit: [0, 0] };
    // 34 cells of fixed parts; the rest goes to the names and the bars
    const avail = W - 34;
    const nameW = Math.max(8, Math.min(22, Math.floor((avail * 0.6) / 2)));
    const barW = Math.max(4, Math.min(16, Math.floor((avail - 2 * nameW) / 2)));
    const hp = (p) => (p ? `${Math.max(0, p.hp - p.d)}`.padStart(3) : '  ?');
    const actor = last.actor === 'p1' ? 0 : last.actor === 'p2' ? 1 : -1;
    const spin = SPIN[(state.ticks + g.id.length) % SPIN.length];
    const line = [
        ['  '], [`R${last.round}`.padStart(3), S.text], [` ${String(last.n).padStart(4)} `, S.dim],
        [actor === 0 ? spin : ' ', S.p1], [` ${short(b1, nameW)} `, `${S.bold}${S.p1}`], ['▕', S.faint], ...hpBar(shown.hp[0], shown.hit[0], barW, false, now), ['▏', S.faint],
        [hp(last.p1), S.white], ['  vs  ', S.faint], [hp(last.p2).trim().padEnd(3), S.white], ['▕', S.faint], ...hpBar(shown.hp[1], shown.hit[1], barW, true, now), ['▏', S.faint],
        [` ${short(b2, nameW)}`, `${S.bold}${S.p2}`], [actor === 1 ? ` ${spin}` : '  ', S.p2],
    ];
    const out = [line];
    if (roomy) {
        const lead = (p, style) => (p ? [[` ${short(clean(p.leader, 16), 16)}`, style], [` ${p.hand}h ${p.ready}/${p.total}r  `, S.dim]] : []);
        // p1's side ends under "vs", where p2's begins
        const vsCol = 21 + nameW + barW;
        const left = cut([['        '], ...lead(last.p1, S.p1), ...unitsText(last.p1)], vsCol);
        out.push([...left, [' '.repeat(Math.max(1, vsCol - visible(left)))], ['│ ', S.faint], ...lead(last.p2, S.p2), ...unitsText(last.p2),
            [`  ${clean(last.label, 30)}`, S.faint]]);
    }
    return out;
}

function slotLines(state, W, rows, now) {
    const slots = liveSlots(state, now);
    const lines = [];
    const phase = phaseOf(state, now);
    if (!slots.length) {
        const why = {
            building: `${state.note || 'building'}${state.buildSince ? ` · ${duration((now - state.buildSince) / 1000)}` : ''}`,
            nomachine: 'the games machine is asleep or restarting: the helper asks again every 30 s',
            connected: 'waiting for a round: every slot is asking the games machine for a seed',
            connecting: 'saying hello to the games machine',
            starting: state.mode === 'watch' ? 'looking for the helper (docker container swu-helper)' : 'starting',
            stopping: 'stopping: seeds in play go back to the games machine',
            stopped: state.note || 'the helper stopped',
        }[phase] ?? '';
        const dots = '.'.repeat(1 + (Math.floor(state.ticks / 4) % 3)).padEnd(3);
        lines.push([['   '], [SPIN[state.ticks % SPIN.length], S.blue], [`  ${why}${phase === 'stopped' ? '' : dots}`, S.text]]);
        if (phase === 'building' && state.buildLine) {
            lines.push([['      '], [clean(state.buildLine, W - 8), S.faint]]);
        }
        return lines;
    }
    const perGame = slots.length * 5 + 1 <= rows ? 2 : 1;
    for (const sl of slots) {
        const since = sl.since ? duration((now - sl.since) / 1000) : '';
        lines.push(spread([[' ▌', S.violet], [`slot ${sl.slot}`, `${S.bold}${S.violet}`], [`  seed ${sl.seed ?? '?'}`, S.dim]], [[since, S.dim], [' ']], W));
        for (const g of sl.games ?? []) {
            lines.push(...gameLines(state, g, W, perGame === 2, now));
        }
    }
    return lines;
}

function resultLines(state, W, rows) {
    const lines = [];
    for (const r of state.results.slice(0, rows)) {
        if (r.failed) {
            lines.push([[` ${r.time ?? ''}  `, S.dim], [`seed ${r.seed} failed: ${clean(r.failed, W - 30)}`, S.red]]);
            continue;
        }
        const [a, b] = r.games.length ? [r.games[0].p1, r.games[0].p2] : ['?', '?'];
        const wa = r.games.filter((g) => g.winner === a).length;
        const wb = r.games.filter((g) => g.winner === b).length;
        const odd = r.games.filter((g) => g.outcome !== 'won').map((g) => (g.outcome === 'ERROR' ? 'a forfeit' : clean(g.outcome, 12)));
        const nameW = Math.max(10, Math.min(24, Math.floor((W - 40) / 2)));
        lines.push([[` ${r.time ?? ''}  `, S.dim],
            [short(clean(a, 40), nameW), wa > wb ? `${S.bold}${S.gold}` : S.text], [`  ${wa} – ${wb}  `, S.white], [short(clean(b, 40), nameW), wb > wa ? `${S.bold}${S.gold}` : S.text],
            [`  ${r.secs} s`, S.dim], [odd.length ? `  ${odd.join(', ')}` : '', S.yellow], [r.note ? `  ${clean(r.note, 40)}` : '', S.red]]);
    }
    if (!lines.length) {
        lines.push([['   no seed finished yet', S.faint]]);
    }
    return lines;
}

function boardLines(state, rows) {
    const list = [...state.wins.entries()].sort(([, x], [, y]) => y.w - x.w || x.l - y.l).slice(0, rows);
    return list.map(([bot, t]) => {
        const n = t.w + t.l;
        return [[` ${short(clean(bot, 40), 22)}`, S.text], [` ${String(t.w).padStart(3)}-${String(t.l).padEnd(3)}`, S.white],
            [` ${bar(n ? t.w / n : 0, 8)}`, S.green], [n ? ` ${Math.round((t.w / n) * 100)}%` : '', S.dim]];
    });
}

function helpLines() {
    return [
        [[' What you see', `${S.bold}${S.white}`]],
        [['  Your computer plays some of each arena round for the games machine (bot/arena/HELPER.md).', S.text]],
        [['  A slot plays one seed: the same deal twice, once from each seat. Each line is a game:', S.text]],
        [['  round, step, then each bot with its base\'s remaining hp; ⠋ marks the side that just moved.', S.text]],
        [['  Below a game when there is room: leader, cards in hand (h), ready/total resources (r), units (▪ ground, ▴ space, power).', S.text]],
        [['  CPU is the share of this computer the helper uses; the gold mark is the aim (SWU_HELPER_TARGET).', S.text]],
        [['  The stars fly faster the harder it works.', S.text]],
        [['']],
        [[' Keys', `${S.bold}${S.white}`]],
        [['  q  quit (in run mode the helper stops; seeds in play go back to the games machine at once)', S.text]],
        [['  +  -  choose the slots, Enter restarts the helper with them (helper.sh keeps the choice)', S.text]],
        [['  l  the log    ?  this help', S.text]],
    ];
}

/** The whole frame: H lines of exactly W cells. */
function frame(state, W, H, now = Date.now()) {
    const out = [...header(state, W, now), ...gauges(state, W), [['']]];
    const footerKeys = state.mode === 'watch' ? ' q quit (the helper keeps running) · l log · ? help'
        : state.exit !== null ? ' r restart · q quit · +/- slots · l log · ? help' : ' q quit · +/- slots · l log · ? help';
    const ev = state.lastEvent && now - state.lastEvent.at < 120000 ? state.lastEvent : null;
    const footer = spread([[footerKeys, S.faint]], ev ? [[`${clean(ev.text, Math.max(10, W - footerKeys.length - 4))} `, ev.level === 'error' ? S.red : S.yellow]] : [], W);
    const room = H - out.length - 1;
    let body;
    if (state.help) {
        body = helpLines();
    } else {
        // the games in play first, then as many finished seeds as fit (at least 3)
        const liveRoom = Math.max(2, room - 6);
        const live = slotLines(state, W, liveRoom, now).slice(0, liveRoom);
        body = [[[' LIVE', `${S.bold}${S.white}`], [`  ${liveSlots(state, now).length} seed${liveSlots(state, now).length === 1 ? '' : 's'} in play`, S.dim]], ...live, [['']]];
        const resultRows = Math.max(3, room - body.length - 1);
        if (state.showLog) {
            body.push([[' LOG', `${S.bold}${S.white}`]], ...state.logs.slice(-resultRows).map((e) => [[` ${clean(e.text, W - 2)}`, e.level === 'error' ? S.red : e.level === 'warning' ? S.yellow : S.dim]]));
        } else {
            const title = [[' FINISHED SEEDS', `${S.bold}${S.white}`], ['  newest first, wins from both seats', S.dim]];
            const results = resultLines(state, W >= 130 ? W - 46 : W, resultRows);
            if (W >= 130) {
                const board = boardLines(state, resultRows);
                body.push(spread(title, [[' ON THIS COMPUTER', `${S.bold}${S.white}`], ['  W-L ', S.dim], [' '.repeat(18)]], W));
                for (let i = 0; i < resultRows; i++) {
                    const left = cut(results[i] ?? [['']], W - 47);
                    body.push([...left, [' '.repeat(Math.max(0, W - 46 - visible(left)))], ['│', S.faint], ...(board[i] ?? [])]);
                }
            } else {
                body.push(title, ...results);
            }
        }
    }
    const lines = [...out, ...body.slice(0, room)];
    while (lines.length < H - 1) {
        lines.push([['']]);
    }
    lines.push(footer);
    return lines.slice(0, H).map((segs) => renderLine(segs, W));
}

// --- the processes it reads

function lines(stream, onLine) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.search(/[\r\n]/)) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (line.trim()) {
                onLine(line);
            }
        }
        if (buf.length > 1 << 20) {
            buf = '';
        }
    });
}

/** Keeps a command running: started again 2 s after it ends, until stop(). */
function keep(cmd, args, onLine, { stdin = 'ignore' } = {}) {
    let child = null;
    let stopped = false;
    let timer = null;
    const start = () => {
        if (stopped) {
            return;
        }
        child = spawn(cmd, args, { stdio: [stdin, 'pipe', 'pipe'] });
        lines(child.stdout, onLine);
        child.stderr.resume();
        child.on('error', () => {});
        child.on('exit', () => {
            child = null;
            timer = setTimeout(start, 2000);
        });
    };
    start();
    return {
        stop() {
            stopped = true;
            clearTimeout(timer);
            if (child) {
                child.kill('SIGTERM');
            }
        },
    };
}

/** Appends cleaned lines to LOG_FILE, moving it to LOG_FILE.1 past LOG_MAX; never throws. */
function logWriter(file) {
    let fd = null;
    let size = 0;
    const open = () => {
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
            fd = fs.openSync(file, 'a', 0o600);
            size = fs.fstatSync(fd).size;
        } catch {
            fd = null;
        }
    };
    open();
    return (line) => {
        if (fd === null) {
            return;
        }
        try {
            const text = `${clean(line, 2000)}\n`;
            fs.writeSync(fd, text);
            size += Buffer.byteLength(text);
            if (size > LOG_MAX) {
                fs.closeSync(fd);
                fs.renameSync(file, `${file}.1`);
                open();
            }
        } catch {
            fd = null;
        }
    };
}

function readSavedSlots() {
    try {
        const n = Number(fs.readFileSync(SLOTS_FILE, 'utf8').trim());
        return Number.isInteger(n) && n >= 1 && n <= MAX_SLOTS ? n : null;
    } catch {
        return null;
    }
}

function main(argv) {
    const mode = argv[0] === 'watch' ? 'watch' : 'run';
    const args = argv[0] === 'run' || argv[0] === 'watch' ? argv.slice(1) : argv;
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
        console.error('helper-tui.js needs a terminal; run helper.sh with SWU_HELPER_PLAIN=1 for plain output');
        process.exit(2);
    }
    const state = newState(mode);
    if (mode === 'watch') {
        state.phase = 'watching';
    }
    const helperSh = path.join(__dirname, 'helper.sh');
    let helper = null;
    let helperArgs = args.slice();
    const out = process.stdout;
    const restore = () => {
        try {
            process.stdin.setRawMode?.(false);
        } catch {
            // the terminal went away
        }
        out.write(`${ESC}0m${ESC}?25h${ESC}?1049l`);
    };
    process.on('exit', restore);

    const log = mode === 'run' ? logWriter(LOG_FILE) : () => {};
    const feed = (line) => {
        log(line);
        apply(state, parseLine(line));
    };
    const startHelper = () => {
        state.exit = null;
        state.started = Date.now();
        helper = spawn('sh', [helperSh, 'run', ...helperArgs], { env: { ...process.env, SWU_HELPER_PLAIN: '1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        lines(helper.stdout, feed);
        lines(helper.stderr, feed);
        helper.on('exit', (code, signal) => {
            helper = null;
            state.exit = code ?? signal;
            if (state.restart) {
                state.restart = false;
                state.stopping = false;
                startHelper();
            } else if (state.quitting) {
                finish(0);
            }
        });
    };

    const watchers = [
        keep('docker', ['stats', '--format', '{{json .}}', CONTAINER], (line) => {
            const s = parseStats(line);
            if (s) {
                applyStats(state, s);
            }
        }),
        keep('docker', ['exec', '-i', '-u', 'arena', CONTAINER, 'node', '-e', readerSource()], (line) => {
            try {
                applyLive(state, JSON.parse(line));
                if (state.phase === 'watching' || state.phase === 'starting') {
                    state.phase = 'connected';
                }
            } catch {
                // not the reader's line
            }
        }, { stdin: 'pipe' }),
    ];
    if (mode === 'watch') {
        watchers.push(keep('docker', ['logs', '-f', '--tail', '400', CONTAINER], feed));
    } else {
        state.nextSlots = (() => {
            const i = helperArgs.indexOf('--slots');
            return i >= 0 ? Number(helperArgs[i + 1]) || null : readSavedSlots();
        })();
        startHelper();
    }

    // stopping the helper: docker stop lets the coordinator hand its seeds back at once; then helper.sh ends
    const stopHelper = () => {
        state.stopping = true;
        const done = spawn('docker', ['stop', '-t', '30', CONTAINER], { stdio: 'ignore' });
        done.on('exit', () => {
            if (helper) {
                try {
                    process.kill(-helper.pid, 'SIGINT');
                } catch {
                    // gone
                }
                setTimeout(() => {
                    if (helper) {
                        try {
                            process.kill(-helper.pid, 'SIGKILL');
                        } catch {
                            // gone
                        }
                    }
                }, 15000).unref();
            }
        });
        done.on('error', () => {});
    };

    let finished = false;
    const finish = (code) => {
        if (finished) {
            return;
        }
        finished = true;
        for (const w of watchers) {
            w.stop();
        }
        restore();
        process.exit(code);
    };

    const quit = () => {
        if (mode === 'watch' || !helper) {
            finish(0);
        } else if (state.quitting) {
            // a second q: do not wait
            try {
                process.kill(-helper.pid, 'SIGKILL');
            } catch {
                // gone
            }
            finish(130);
        } else {
            state.quitting = true;
            stopHelper();
        }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (key) => {
        if (key === 'q' || key === '\u0003' || key === 'Q') {
            quit();
        } else if (key === '?' || key === 'h') {
            state.help = !state.help;
        } else if (key === 'l') {
            state.showLog = !state.showLog;
        } else if (key === '\u001b' && state.help) {
            state.help = false;
        } else if (mode === 'run' && (key === '+' || key === '=' || key === '-' || key === '_')) {
            const now = state.nextSlots ?? state.slots ?? 1;
            state.nextSlots = Math.max(1, Math.min(MAX_SLOTS, now + (key === '+' || key === '=' ? 1 : -1)));
        } else if (mode === 'run' && key === '\r' && state.nextSlots && state.nextSlots !== state.slots) {
            try {
                fs.mkdirSync(path.dirname(SLOTS_FILE), { recursive: true, mode: 0o700 });
                fs.writeFileSync(SLOTS_FILE, `${state.nextSlots}\n`);
            } catch {
                // the next start uses --slots anyway
            }
            helperArgs = [...helperArgs.filter((a, i, all) => a !== '--slots' && all[i - 1] !== '--slots'), '--slots', String(state.nextSlots)];
            state.slots = state.nextSlots;
            if (helper) {
                state.restart = true;
                stopHelper();
            } else {
                startHelper();
            }
        } else if (mode === 'run' && key === 'r' && !helper) {
            startHelper();
        }
    });
    // The terminal closed (or someone stopped the view): `docker stop` runs on its own, detached, since this process may
    // be killed before it would finish, and a container outlives the `docker run` that started it.
    for (const sig of ['SIGTERM', 'SIGHUP']) {
        process.on(sig, () => {
            if (mode === 'run' && helper) {
                spawn('docker', ['stop', '-t', '30', CONTAINER], { stdio: 'ignore', detached: true }).unref();
                try {
                    process.kill(-helper.pid, 'SIGINT');
                } catch {
                    // gone
                }
            }
            finish(0);
        });
    }
    process.on('uncaughtException', (e) => {
        restore();
        console.error(e);
        if (mode === 'run' && helper) {
            console.error('the helper keeps running; stop it with: docker stop swu-helper');
        }
        process.exit(1);
    });

    out.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
    let last = '';
    const draw = () => {
        step(state);
        const W = Math.max(40, out.columns || 100);
        const H = Math.max(12, out.rows || 30);
        const text = frame(state, W, H).join(`${ESC}K\r\n`);
        if (text !== last) {
            last = text;
            out.write(`${ESC}H${text}${ESC}K${ESC}J`);
        }
    };
    out.on('resize', () => {
        last = '';
        out.write(`${ESC}2J`);
        draw();
    });
    setInterval(draw, 1000 / FPS);
    draw();
}

module.exports = { clean, splitGameId, gameOutcome, parseLine, parseStats, bytes, summarizeStep, reader, readerSource, bar, sparkline, duration, renderLine, newState, apply, applyStats, applyLive, step, frame };

if (require.main === module) {
    main(process.argv.slice(2));
}
