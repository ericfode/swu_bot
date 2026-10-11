'use strict';
/**
 * Writes the research dashboard's strategy panel for the learned bot (schema in /mnt/project-files/dashboard/README.md).
 *
 *   node bot/learned/panel.js --out /mnt/project-files/dashboard/panels/learned-world-model.json \
 *        [--model models/learned/current.json] [--results /mnt/project-files/results/learned-v1] \
 *        [--thoughts /tmp/learned-thoughts.json] [--state bot/learned/panel-state.json] [--watch 5]
 *
 * --state is a small JSON with the parts written by hand or by scripts: {status, now, plan, thoughts, history}.
 * --thoughts is the file the bots write while playing (SWU_LEARNED_THOUGHTS): the last decision's policy and value.
 * With --watch N the panel is rewritten every N seconds, so the page shows the bot thinking during a run.
 */
const fs = require('fs');
const path = require('path');
const F = require('./features');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}
const readJson = (f) => {
    try {
        return f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
    } catch {
        return null;
    }
};
const pct = (x) => (x == null ? '-' : `${(x * 100).toFixed(1)}%`);

function build() {
    const model = readJson(path.resolve(arg('model', 'models/learned/current.json')));
    const rep = model?.meta?.report ?? {};
    const ladder = readJson(arg('results', null) && path.join(arg('results'), 'ladder.json'));
    const thought = readJson(arg('thoughts', null));
    const st = readJson(arg('state', path.join(__dirname, 'panel-state.json'))) ?? {};

    // what the value head pays attention to: d value / d feature (standardised), largest first
    const sens = (rep.value_sensitivity ?? []).map((w, i) => ({ name: F.STATE_NAMES[i], weight: Number(w.toFixed(3)) }))
        .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 14);

    const widgets = [];
    widgets.push({
        type: 'stats', items: [
            { label: 'training decisions', value: rep.data?.decisions ?? 0 },
            { label: 'training games', value: rep.data?.games ?? 0 },
            { label: 'copies teacher at action windows', value: pct(rep.policy_acc_val?.window) },
            { label: 'copies teacher elsewhere', value: pct(rep.policy_acc_val?.other) },
            { label: 'value predicts winner', value: pct(rep.value_sign_acc_val) },
            { label: 'dynamics error vs "no change"', value: rep.dyn_mse_val ? `${(rep.dyn_mse_val / rep.dyn_mse_nochange * 100).toFixed(0)}%` : '-' }
        ]
    });
    if (thought) {
        widgets.push({
            type: 'bars', title: `Last decision (${thought.bot}, round ${thought.round}): "${thought.prompt}" value ${thought.value.toFixed(2)}`,
            items: thought.top.map((t) => ({ label: t.label, value: Number((t.p * 100).toFixed(1)) }))
        });
    }
    const byRound = rep.value_sign_acc_by_round ?? {};
    if (Object.keys(byRound).length) {
        widgets.push({
            type: 'line', title: 'Value head: how often it names the winner, by round', x: 'round', yFormat: 'pct',
            series: [{ name: 'held-out games', points: Object.entries(byRound).map(([r, [acc]]) => [Number(r), acc]) }]
        });
    }
    if (ladder) {
        widgets.push({
            type: 'table', title: `Arena ${path.basename(arg('results'))} (${ladder.progress.finished}/${ladder.progress.scheduled} games, ${ladder.status})`,
            columns: ['bot', 'elo', 'W-L', 'win rate', '95% CI'],
            rows: ladder.bots.map((b) => [b.name, String(b.elo), `${b.wins}-${b.losses}`, pct(b.winRate), `${pct(b.winRateCI95[0])} - ${pct(b.winRateCI95[1])}`])
        });
    }
    if (st.history?.length) {
        widgets.push({ type: 'line', title: 'Win rate by model version', x: 'version', yFormat: 'pct', series: st.history });
    }
    return {
        schema: 1, id: 'learned-world-model', title: 'Learned world model + action model (tinygrad)', thread: 'Learned bot (tinygrad world model)',
        bots: ['learned-pi', 'learned-v'], status: st.status ?? 'running', updatedAt: new Date().toISOString(),
        now: st.now ?? '', goal: 'A small network that encodes the position (world model), predicts who wins (value), what happens next (dynamics) and what to play (policy), trained from heuristic play and then self-play.',
        mentalModel: {
            summary: 'One encoder turns the board into a 128-number latent. The value head scores the latent; the policy head scores each legal action against it. learned-pi plays the top policy action; learned-v searches one ply on the engine and scores the results with the value head. Weights below: how much the value moves per standard deviation of each feature.',
            features: sens
        },
        plan: st.plan ?? [], thoughts: (st.thoughts ?? []).slice(-12), widgets
    };
}

function write() {
    const out = path.resolve(arg('out', '/mnt/project-files/dashboard/panels/learned-world-model.json'));
    const tmp = `${out}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(build(), null, 1));
    fs.renameSync(tmp, out);
}

write();
const every = Number(arg('watch', 0));
if (every > 0) {
    setInterval(write, every * 1000);
}
