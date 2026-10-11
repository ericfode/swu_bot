'use strict';

/**
 * Bots that use the learned model (bot/learned/model.js).
 *
 *   LearnedPolicyBot  ("learned-pi")  plays the action model's top choice at every prompt. No search, ~1 ms a decision.
 *   LearnedSearchBot  ("learned-v")   the heuristic bot's one-ply engine lookahead, but positions are scored by the
 *                                     learned value head instead of the hand-written formula; other prompts use the policy.
 *
 * Both read only the seat's own observation (bot/learned/observe.js): opponent hand and deck order stay hidden.
 */
const fs = require('fs');
const path = require('path');
const { Model } = require('./model');
const F = require('./features');
const { observe, plainAction } = require('./observe');
const { HeuristicBot } = require('../players/heuristic');

const DEFAULT_MODEL = path.join(__dirname, '..', '..', 'models', 'learned', 'current.json');
const models = new Map();

function loadModel(file = process.env.SWU_LEARNED_MODEL || DEFAULT_MODEL) {
    if (!models.has(file)) {
        models.set(file, Model.load(file));
    }
    return models.get(file);
}

function promptOf(eg, pid) {
    const pr = eg.player(pid).currentPrompt();
    return { sig: eg.promptSignature(pid), title: `${pr.menuTitle ?? ''} ${pr.promptTitle ?? ''}`.trim() };
}

/** Everything the model sees for one decision, as plain arrays (also what the data generator records). */
function featurize(eg, pid, actions, version = F.VERSION) {
    const obs = observe(eg, pid);
    const { sig, title } = promptOf(eg, pid);
    const plain = actions.map((a) => plainAction(eg, a));
    return { obs, sig, title, s: F.state(obs), p: F.prompt(sig, title), A: plain.map((a) => F.action(a, obs, version)), plain };
}

const softmax = (xs) => {
    const m = Math.max(...xs);
    const e = xs.map((x) => Math.exp(x - m));
    const t = e.reduce((a, b) => a + b, 0);
    return e.map((x) => x / t);
};

/** Live "inner thoughts" for the research dashboard: the last decision, written at most every few seconds. */
class Thoughts {
    constructor(name) {
        this.name = name;
        this.file = process.env.SWU_LEARNED_THOUGHTS || null;
        this.lastWrite = 0;
        this.last = null;
    }

    record(t) {
        this.last = { ...t, bot: this.name, at: new Date().toISOString() };
        if (this.file && Date.now() - this.lastWrite > 3000) {
            this.lastWrite = Date.now();
            const tmp = `${this.file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.last));
            fs.renameSync(tmp, this.file);
        }
    }
}

class LearnedPolicyBot {
    constructor(name = 'learned-pi', { model } = {}) {
        this.name = name;
        this.model = loadModel(model);
        this.thoughts = new Thoughts(name);
        this.game = null;
        this.visits = new Map();
    }

    /** Policy probabilities over `actions`, plus the value of the position, for the seat `pid`. */
    think(eg, pid, actions) {
        const f = featurize(eg, pid, actions, this.model.featureVersion);
        const z = this.model.encode(f.s);
        const logits = this.model.logits(z, f.p, f.A);
        return { f, z, value: this.model.value(z), logits };
    }

    choose({ game: eg, pid, actions }) {
        if (this.game !== eg) {
            this.game = eg;
            this.visits.clear();
        }
        const { f, value, logits } = this.think(eg, pid, actions);
        // loop guard: if this exact position and prompt come back (pick a unit, cancel, ...), try something else
        const key = `${f.sig}|${f.title}|${JSON.stringify(f.obs)}`;
        const tried = this.visits.get(key) ?? new Map();
        this.visits.set(key, tried);
        const adj = logits.map((l, i) => l - 4 * (tried.get(actions[i].label + '|' + (actions[i].cardUuid ?? actions[i].arg ?? '')) ?? 0));
        let best = 0;
        adj.forEach((l, i) => {
            if (l > adj[best]) {
                best = i;
            }
        });
        const k = actions[best].label + '|' + (actions[best].cardUuid ?? actions[best].arg ?? '');
        tried.set(k, (tried.get(k) ?? 0) + 1);
        const probs = softmax(logits);
        this.thoughts.record({
            round: f.obs.round, seat: f.obs.you, prompt: f.title || f.sig, value,
            top: actions.map((a, i) => ({ label: a.label, p: probs[i] })).sort((x, y) => y.p - x.p).slice(0, 6),
            picked: actions[best].label
        });
        return actions[best];
    }
}

class LearnedSearchBot extends HeuristicBot {
    constructor(name = 'learned-v', opts = {}) {
        super(name, opts);
        this.policy = new LearnedPolicyBot(name, opts);
        this.model = this.policy.model;
    }

    evaluate(eg, pid) {
        if (eg.over) {
            return super.evaluate(eg, pid);
        }
        const obs = observe(eg, pid);
        return this.model.value(this.model.encode(F.state(obs)));
    }

    choose(ctx) {
        if (!ctx.game.isActionWindow(ctx.pid)) {
            const planned = this.takePlanned(ctx.actions);
            if (planned) {
                return planned;
            }
            this.rng ??= require('../env').seededRng(`h${Math.floor(ctx.rng() * 1e9)}`);
            return this.policy.choose(ctx);
        }
        return super.choose(ctx);
    }
}

module.exports = { LearnedPolicyBot, LearnedSearchBot, featurize, loadModel, softmax };
