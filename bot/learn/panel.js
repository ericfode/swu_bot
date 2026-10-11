'use strict';
// node bot/learn/panel.js [--state /mnt/project-files/learn/panel-state.json] [--thoughts /tmp/learned-thoughts.json] [--out /mnt/project-files/dashboard/panels/rust-learned.json]
//
// Writes the research-dashboard strategy panel (dashboard/README.md, section 5) for the Rust learned bot from:
// - a small state file kept by hand or by scripts: now, plan, thoughts, model generations with their win rates,
// - the training logs (<model>.train.json) named in it,
// - the bot's latest decision (SWU_LEARNED_THOUGHTS file), shown as the action model's view of its last choice.
const fs = require('fs');
const path = require('path');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const readJson = (p) => {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return null;
    }
};

const st = readJson(arg('state', '/mnt/project-files/learn/panel-state.json')) ?? {};
const thoughts = readJson(arg('thoughts', process.env.SWU_LEARNED_THOUGHTS ?? '/tmp/learned-thoughts.json'));
const out = arg('out', '/mnt/project-files/dashboard/panels/rust-learned.json');

const widgets = [];
const gens = st.generations ?? [];
if (gens.length) {
    widgets.push({
        type: 'table', title: 'Model generations', columns: ['model', 'trained on', 'vs random-a', 'vs rust-greedy'],
        rows: gens.map((g) => [g.name, g.data, g.vsRandom ?? '-', g.vsGreedy ?? '-'])
    });
    const pts = gens.filter((g) => g.vsRandomRate != null).map((g, k) => [k + 1, g.vsRandomRate]);
    if (pts.length) {
        widgets.push({ type: 'line', title: 'Win rate vs random by generation', x: 'generation', yFormat: 'pct', series: [{ name: 'rust-learned', points: pts }] });
    }
}
const logs = (st.trainLogs ?? []).map((p) => ({ p, j: readJson(p) })).filter((x) => x.j);
if (logs.length) {
    widgets.push({
        type: 'line', title: 'Validation loss of the action model (lower is better)', x: 'epoch',
        series: logs.slice(-4).map(({ p, j }) => ({ name: path.basename(p, '.train.json'), points: j.epochs.map((e) => [e.epoch + 1, Number(e.val_q.toFixed(4))]) }))
    });
}
if (thoughts?.top) {
    widgets.push({
        type: 'bars', title: `Last decision: "${thoughts.prompt ?? ''}" (round ${thoughts.round}, ${thoughts.you}); P(win) per action`,
        items: thoughts.top.map((t) => ({ label: `${t.chosen ? '> ' : ''}${t.label}`, value: Number(t.pWin.toFixed(3)) }))
    });
    // value is the bot's estimated chance for player 1, as the tree widget expects
    const p1 = (v) => (thoughts.you === 'p1' ? v : 1 - v);
    widgets.push({
        type: 'tree', title: 'Action model at the last decision', caption: 'Each child: predicted win chance if the action is taken',
        root: {
            label: `${thoughts.you} to act, value ${(thoughts.vNow * 100).toFixed(0)}%`, value: p1(thoughts.vNow), state: thoughts.state,
            children: thoughts.top.slice(0, 6).map((t) => ({ label: t.label, chosen: t.chosen, value: p1(t.pWin), children: [] }))
        }
    });
}
widgets.push({ type: 'stats', items: (st.stats ?? []) });

const panel = {
    schema: 1, id: 'rust-learned', title: 'Rust learned model (Burn)', thread: 'Rust learned model bot',
    bots: st.bots ?? ['rust-learned'], status: st.status ?? 'running', updatedAt: new Date().toISOString(),
    now: st.now ?? '', goal: 'A tiny learned world + action model in Rust that beats random, then keeps improving by self-play.',
    mentalModel: {
        summary: 'For every legal action it predicts "do I win if I take this?" (action model) and how the board will look at its next turn (world model); it plays the action with the best predicted win chance, optionally adding the value of the predicted board and a hand-written heuristic.',
        features: st.features ?? []
    },
    plan: st.plan ?? [],
    thoughts: (st.thoughts ?? []).slice(-12),
    widgets
};
const tmp = `${out}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(panel, null, 1));
fs.renameSync(tmp, out);
console.log(`wrote ${out}`);
