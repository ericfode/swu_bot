'use strict';
/**
 * Writes the research dashboard's strategy panel for the ISMCTS bots (schema in /mnt/project-files/dashboard/README.md,
 * section 5) from ladder results and the bots' live thoughts.
 *
 *   node bot/ismcts-panel.js --runs <ladderDir>[,<ladderDir>...] [--thoughts <dir>] [--out <panel.json>] [--watch 10]
 *
 * --runs: ladder.js run folders (each has ladder.json). --thoughts: the ISMCTS_THOUGHTS folder the bots write to.
 * --out defaults to /mnt/project-files/dashboard/panels/ismcts.json. --watch N rewrites it every N seconds until every
 * run is done. Writes are atomic. The panel keeps its own rolling list of thoughts across rewrites.
 */
const fs = require('fs');
const path = require('path');
const { W } = require('./players/heuristic');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const readJson = (f) => {
    try {
        return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
        return null;
    }
};

function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file);
}

const pct = (x) => (x === null || x === undefined ? '-' : `${Math.round(x * 100)}%`);
const isIsmcts = (n) => /^ismcts/.test(n);

/** Per ISMCTS bot and opponent: wins/decided from the finished games of all runs. */
function sweepTable(runs) {
    const rows = new Map();
    for (const run of runs) {
        for (const g of run.games ?? []) {
            if (g.outcome === 'running') {
                continue;
            }
            for (const [me, opp] of [[g.p1, g.p2], [g.p2, g.p1]]) {
                if (!isIsmcts(me) || isIsmcts(opp)) {
                    continue;
                }
                const k = `${me}|${opp}`;
                const r = rows.get(k) ?? { bot: me, opp, wins: 0, decided: 0, errors: 0, ms: 0, windows: 0 };
                if (g.outcome === 'won') {
                    r.decided++;
                    if (g.winner === me) {
                        r.wins++;
                    }
                } else {
                    r.errors++;
                }
                const st = (g.botStats ?? [])[me === g.p1 ? 0 : 1];
                if (st?.windows) {
                    r.ms += st.ms;
                    r.windows += st.windows;
                }
                rows.set(k, r);
            }
        }
    }
    return [...rows.values()];
}

function betaOf(name) {
    if (/-peek/.test(name)) {
        return null;
    }
    const m = /-b([0-9.]+)/.exec(name);
    return m ? Number(m[1]) : 1;
}

function build(runDirs, thoughtsDir, prev) {
    const runs = runDirs.map((d) => readJson(path.join(d, 'ladder.json'))).filter(Boolean);
    const table = sweepTable(runs);
    const bots = [...new Set(table.map((r) => r.bot))].sort();
    const opps = [...new Set(table.map((r) => r.opp))].sort();
    const running = runs.some((r) => r.status === 'running');

    // live thoughts: newest file per bot
    const live = [];
    if (thoughtsDir && fs.existsSync(thoughtsDir)) {
        for (const f of fs.readdirSync(thoughtsDir).filter((x) => x.endsWith('.json'))) {
            const t = readJson(path.join(thoughtsDir, f));
            if (t?.t) {
                live.push(t);
            }
        }
    }
    live.sort((a, b) => (a.t < b.t ? -1 : 1));
    const newest = live[live.length - 1] ?? null;

    const say = (t) => {
        const alts = (t.top ?? []).slice(1, 3).map((x) => `${x.label} ${pct(x.value)}`).join(', ');
        const hand = (t.oppHand ?? []).slice(0, 3).map((x) => `${x.name.split('#')[0]} ${pct(x.p)}`).join(', ');
        return `${t.bot}, round ${t.round}: ${t.chosen} (${pct(t.value)} over ${t.iterations} sampled worlds)` +
            (alts ? `; next best ${alts}` : '') + (hand ? `. Thinks the opponent's ${t.oppHandSize} cards likely include ${hand}` : '') + '.';
    };
    const thoughts = [...(prev?.thoughts ?? [])];
    for (const t of live) {
        const text = say(t);
        if (!thoughts.some((x) => x.t === t.t && x.text === text)) {
            thoughts.push({ t: t.t, text });
        }
    }
    thoughts.sort((a, b) => (a.t < b.t ? -1 : 1));

    // win rate against each baseline as a function of beta (fair variants only)
    const series = opps.slice(0, 4).map((opp) => ({
        name: `vs ${opp}`,
        points: table.filter((r) => r.opp === opp && betaOf(r.bot) !== null && r.decided)
            .map((r) => [betaOf(r.bot), r.wins / r.decided]).sort((a, b) => a[0] - b[0])
    }));
    const rowsFor = bots.map((b) => {
        const mine = table.filter((r) => r.bot === b);
        const wins = mine.reduce((s, r) => s + r.wins, 0);
        const dec = mine.reduce((s, r) => s + r.decided, 0);
        const ms = mine.reduce((s, r) => s + r.ms, 0);
        const win = mine.reduce((s, r) => s + r.windows, 0);
        return [b, ...opps.map((o) => {
            const r = mine.find((x) => x.opp === o);
            return r && r.decided ? `${r.wins}/${r.decided}` : '-';
        }), dec ? pct(wins / dec) : '-', win ? `${Math.round(ms / win)}` : '-'];
    });
    const finished = runs.reduce((s, r) => s + (r.progress?.finished ?? 0), 0);
    const scheduled = runs.reduce((s, r) => s + (r.progress?.scheduled ?? 0), 0);

    const widgets = [
        { type: 'stats', items: [
            { label: 'games finished', value: `${finished}/${scheduled}` },
            { label: 'sampled worlds / decision', value: newest?.iterations ?? '-' },
            { label: 'ms / decision (latest bot)', value: newest?.stats?.windows ? Math.round(newest.stats.ms / newest.stats.windows) : '-' },
            { label: 'failed playouts', value: newest?.stats?.playouts ? pct(newest.stats.failedPlayouts / newest.stats.playouts) : '-' }
        ] },
        { type: 'line', title: 'Win rate vs belief sharpness beta', x: 'beta', yFormat: 'pct', series },
        { type: 'table', title: 'Sweep: wins/decided games per opponent', columns: ['bot', ...opps, 'overall', 'ms/decision'], rows: rowsFor }
    ];
    if (newest?.top?.length) {
        widgets.push({ type: 'bars', title: `Visits at ${newest.bot}'s last decision (round ${newest.round})`,
            items: newest.top.map((x) => ({ label: x.label, value: x.visits })) });
    }
    if (newest?.tree) {
        widgets.push({ type: 'tree', title: `${newest.bot}: search tree at its last decision`,
            caption: 'Root = the real position. Children = the end of one imagined world after that action and the opponent\'s reply (hidden cards are sampled, not real). Value = P(p1 wins).',
            root: newest.tree });
    }
    if (newest?.oppHand?.length) {
        widgets.push({ type: 'table', title: `What ${newest.bot} thinks is in the opponent's hand (${newest.oppHandSize} cards)`,
            columns: ['card', 'P(in hand)'], rows: newest.oppHand.map((x) => [x.name, pct(x.p)]) });
    }

    return {
        schema: 1,
        id: 'ismcts',
        title: 'Known-decklist ISMCTS (belief-weighted)',
        thread: 'Known-decklist ISMCTS bot',
        bots,
        status: running ? 'running' : 'done',
        updatedAt: new Date().toISOString(),
        now: newest ? say(newest) : (running ? 'Waiting for the first search.' : 'Sweep finished.'),
        goal: 'Use both known decklists: sample the opponent\'s hidden hand by belief, search over many sampled worlds, and find how hard to trust the belief (beta).',
        mentalModel: {
            summary: 'Information Set MCTS: each iteration samples a world (my deck order, which unseen opponent cards are in hand/resources/deck, weighted by exp(-beta * evidence) where evidence counts windows the opponent could afford a card but did not play one), walks one shared tree of my decisions with UCB, lets the opponent reply from its sampled hand, and scores the result with the heuristic evaluation.',
            features: [
                { name: 'belief sharpness beta', weight: newest?.beta ?? 1, note: '0 = uniform over the decklist' },
                ...Object.entries(W).filter(([k]) => k !== 'exhaustedMult').map(([name, weight]) => ({ name: `eval: ${name}`, weight }))
            ]
        },
        plan: [
            { text: 'Belief model + world sampler with exact rollback', state: 'done' },
            { text: 'ISMCTS over my turn, opponent replies from sampled hand', state: 'done' },
            { text: 'Sweep beta against heuristic, tempo and rush', state: running ? 'doing' : 'done' },
            { text: 'Unfair peek control: what hidden info is worth', state: running ? 'doing' : 'done' },
            { text: 'Better opponent model and deeper horizon', state: 'todo' }
        ],
        thoughts: thoughts.slice(-40),
        widgets
    };
}

function main() {
    const runDirs = (arg('runs', '') || '').split(',').filter(Boolean);
    const thoughtsDir = arg('thoughts', null);
    const out = arg('out', '/mnt/project-files/dashboard/panels/ismcts.json');
    const watch = Number(arg('watch', 0));
    const once = () => {
        const doc = build(runDirs, thoughtsDir, readJson(out));
        writeJson(out, doc);
        return doc;
    };
    let doc = once();
    console.log(`wrote ${out} (${doc.status})`);
    if (watch > 0) {
        const timer = setInterval(() => {
            doc = once();
            if (doc.status === 'done') {
                clearInterval(timer);
                console.log(`wrote ${out} (done)`);
            }
        }, watch * 1000);
    }
}

if (require.main === module) {
    main();
}

module.exports = { build, sweepTable };
