'use strict';

/**
 * Check the importer against ground truth: compare every frame of an importer/capture.js capture with the recorder's
 * snapshot of the same decision.
 *
 *   node importer/verify.js <dir from capture.js> [--json]
 *
 * For each <game>.<view>.jsonl next to <game>.truth.jsonl, frame k is the board after decision k, so it must match
 * truth step k field by field. Cards the view cannot see (the other hand, or both for a spectator) only have to match
 * in number. Upgrade order is compared as a multiset (the engine lists upgrades by zone, the recorder by attach order).
 */

const fs = require('fs');
const path = require('path');
const { readText } = require('./sources');
const { readFrames } = require('./karabast');

const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

// Board fields the referee adds that no capture carries (spec/MIGRATION.md): card ids, epic, captured cards.
const REFEREE_ONLY = new Set(['id', 'epic', 'cap']);
const capturable = (x) => JSON.parse(JSON.stringify(x, (k, v) => (REFEREE_ONLY.has(k) ? undefined : v)));

function normUnits(units) {
    return units.map((u) => ({ ...u, u: u.u ? [...u.u].sort((a, b) => `${a.n}${a.s}`.localeCompare(`${b.n}${b.s}`)) : undefined }));
}

/** List of {path, want, got} differences between a truth snapshot and an imported one. */
function diffSnapshot(truth, got, hiddenSeats) {
    const out = [];
    const cmp = (p, a, b) => {
        if (JSON.stringify(a) !== JSON.stringify(b)) {
            out.push({ path: p, want: a, got: b });
        }
    };
    cmp('round', truth.round, got.round);
    cmp('phase', truth.phase, got.phase);
    cmp('initiative', truth.initiative, got.initiative);
    for (const seat of ['p1', 'p2']) {
        const t = capturable(truth.players[seat]);
        const g = got.players[seat];
        for (const k of ['base', 'leader', 'res', 'deck', 'discard']) {
            cmp(`${seat}.${k}`, t[k], g[k]);
        }
        if (hiddenSeats.includes(seat)) {
            cmp(`${seat}.hand.length`, t.hand.length, g.hand.length);
            if (g.hand.some((c) => !c.hid)) {
                out.push({ path: `${seat}.hand`, want: 'hidden', got: 'visible cards' });
            }
        } else {
            cmp(`${seat}.hand`, t.hand, g.hand);
        }
        cmp(`${seat}.ground`, normUnits(t.ground), normUnits(g.ground));
        cmp(`${seat}.space`, normUnits(t.space), normUnits(g.space));
    }
    return out;
}

function verifyGame(dir, id, view) {
    const truth = readJsonl(path.join(dir, `${id}.truth.jsonl`)).filter((e) => e.t === 'step');
    const cap = readText(fs.readFileSync(path.join(dir, `${id}.${view}.jsonl`), 'utf8'));
    const seats = cap.meta.capture?.seats;
    const r = readFrames(cap.frames, { seats });
    const hidden = view === 'spectator' ? ['p1', 'p2'] : [view === 'p1' ? 'p2' : 'p1'];
    const res = { id, view, frames: r.items.length, truthSteps: truth.length, mismatchedFrames: 0, byPath: {}, examples: [], pov: r.pov };
    for (let k = 0; k < Math.min(truth.length, r.items.length); k++) {
        const d = diffSnapshot(truth[k].state, r.items[k].state, hidden);
        if (d.length) {
            res.mismatchedFrames++;
            for (const x of d) {
                const key = x.path.replace(/\[\d+\]/g, '');
                res.byPath[key] = (res.byPath[key] ?? 0) + 1;
                if (res.examples.length < 8) {
                    res.examples.push({ step: k, ...x });
                }
            }
        }
    }
    if (truth.length !== r.items.length) {
        res.lengthMismatch = { truth: truth.length, frames: r.items.length };
    }
    return res;
}

function main() {
    const dir = process.argv[2];
    if (!dir) {
        console.error('usage: node importer/verify.js <capture dir> [--json]');
        process.exit(2);
    }
    const ids = fs.readdirSync(dir).filter((f) => f.endsWith('.truth.jsonl')).map((f) => f.replace(/\.truth\.jsonl$/, '')).sort();
    const results = [];
    for (const id of ids) {
        for (const view of ['p1', 'p2', 'spectator']) {
            if (fs.existsSync(path.join(dir, `${id}.${view}.jsonl`))) {
                results.push(verifyGame(dir, id, view));
            }
        }
    }
    if (process.argv.includes('--json')) {
        console.log(JSON.stringify(results, null, 2));
    } else {
        for (const r of results) {
            console.log(`${r.id} ${r.view.padEnd(9)} frames ${r.frames}/${r.truthSteps} pov=${r.pov} mismatched ${r.mismatchedFrames}${Object.keys(r.byPath).length ? ' ' + JSON.stringify(r.byPath) : ''}`);
            for (const e of r.examples.slice(0, 3)) {
                console.log(`   step ${e.step} ${e.path}: want ${JSON.stringify(e.want)?.slice(0, 160)} got ${JSON.stringify(e.got)?.slice(0, 160)}`);
            }
        }
    }
    const bad = results.filter((r) => r.mismatchedFrames || r.lengthMismatch).length;
    console.log(`${results.length - bad}/${results.length} captures match the truth on every frame`);
    process.exitCode = bad ? 1 : 0;
}

if (require.main === module) {
    main();
}

module.exports = { diffSnapshot, verifyGame };
