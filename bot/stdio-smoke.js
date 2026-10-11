'use strict';
// Protocol smoke test for an out-of-process bot, no card data needed:
//   node bot/stdio-smoke.js [--games 3] [--out dir] -- <cmd> [args...]
//   node bot/stdio-smoke.js -- python3 bot/examples/random_bot.py
// Plays a tiny fake game (not SWU rules: play a unit, distribute 3 damage, pass) through the real match.js, recorder.js
// and ExternalBot against the random bot, so it checks the stdio wiring and the bot's replies, not its strategy.
// With --out, writes <dir>/game-<seed>.jsonl replays (the real format, fake cards) and <dir>/stdio.jsonl, a transcript
// of every line sent and received.

const fs = require('fs');
const path = require('path');
const { EnvGame } = require('./env');
const { playGame } = require('./match');
const { snapshot } = require('./recorder');
const { ExternalBot } = require('./players/external');
const { createRandomBot } = require('./players/random');

let uid = 0;
function fakeCard(title, number, { zone, controller, unit = true } = {}) {
    const c = {
        uuid: `card-${++uid}`, title, internalName: title.toLowerCase().replace(/ /g, '-'), setId: { set: 'SOR', number },
        zoneName: zone, controller, cardData: { power: 2, hp: 3 }, upgrades: [], damage: 0, exhausted: false,
        isUnit: () => unit, isToken: () => false
    };
    c.getSummary = () => ({ power: 2, hp: 3, damage: c.damage, exhausted: c.exhausted, onStartingSide: true });
    return c;
}

function fakePlayer(id, name) {
    const p = { id, name, readyResourceCount: 2, drawDeck: new Array(40), promptState: { selectedCards: [], selectableCards: [] } };
    p.zones = { hand: [fakeCard('Wampa', 42, { zone: 'hand', controller: p })], discard: [], resource: [], groundArena: [], spaceArena: [] };
    p.getCardsInZone = (z) => p.zones[z];
    p.base = fakeCard('Echo Base', 23, { zone: 'base', unit: false });
    p.base.cardData.hp = 12;
    p.leader = fakeCard('Luke Skywalker', 5, { zone: 'base', unit: false });
    p.getAllDeckLeaders = () => [p.leader];
    return p;
}

/** Just enough of EnvGame for match.js, recorder.js and observe.js. */
class FakeGame {
    constructor() {
        this.ids = ['111', '222'];
        this.names = ['p1', 'p2'];
        this.pl = { 111: fakePlayer('111', 'p1'), 222: fakePlayer('222', 'p2') };
        this.pl[111].opponent = this.pl[222];
        this.pl[222].opponent = this.pl[111];
        this.turn = '111';
        this.turns = 0;
        this.mode = 'window';
        this.winnerNames = [];
        this.phase = 'action';
        this.round = 1;
    }

    async start() {}

    get over() {
        return this.winnerNames.length > 0;
    }

    get winners() {
        return this.winnerNames;
    }

    player(pid) {
        const p = this.pl[pid];
        p.currentPrompt = () => this.prompt(pid);
        p.hasInitiative = () => pid === '111';
        return p;
    }

    prompt(pid) {
        if (pid !== this.turn) {
            return { menuTitle: 'Waiting for opponent', buttons: [] };
        }
        return this.mode === 'window'
            ? { promptType: 'actionWindow', menuTitle: 'Choose an action', buttons: [] }
            : { promptType: 'distributeAmongTargets', menuTitle: 'Distribute 3 damage among enemy targets', promptTitle: 'Wampa' };
    }

    promptSignature(pid) {
        return this.mode === 'window' || pid !== this.turn ? `${this.prompt(pid).promptType ?? '-'}|-` : 'distributeAmongTargets|-|dist';
    }

    isActionWindow(pid) {
        return this.mode === 'window' && pid === this.turn;
    }

    legalActions(pid) {
        if (pid !== this.turn || this.over) {
            return [];
        }
        const me = this.pl[pid];
        const opp = me.opponent;
        if (this.mode === 'dist') {
            const targets = [opp.base, ...opp.zones.groundArena];
            return [{
                kind: 'distribute', label: 'distribute 3', uuid: 'prompt-dist',
                spec: { type: 'distributeDamage', amount: 3, isIndirectDamage: false, canDistributeLess: false, canChooseNoTargets: false },
                targets: targets.map((c) => c.uuid), caps: targets.map(() => Infinity)
            }];
        }
        const out = [{ kind: 'button', label: 'Pass', arg: 'pass', uuid: 'prompt-window', method: undefined }];
        const hand = me.zones.hand[0];
        if (hand) {
            out.push({ kind: 'card', label: hand.internalName, cardUuid: hand.uuid, card: hand });
        }
        return out;
    }

    apply(pid, a, rng) {
        const me = this.pl[pid];
        const opp = me.opponent;
        if (a.kind === 'card') {
            const unit = fakeCard('Battlefield Marine', 95, { zone: 'groundArena', controller: me });
            unit.exhausted = true;
            me.zones.groundArena.push(unit);
            this.mode = 'dist';
            return;
        }
        if (a.kind === 'distribute') {
            // the split goes through env.js's real apply, so a bot-chosen distribution is checked end to end
            let sent = null;
            EnvGame.prototype.apply.call({ game: { statefulPromptResults: (_p, r) => (sent = r), continue: () => undefined } }, pid, a, rng);
            const total = sent.valueDistribution.reduce((s, e) => s + e.amount, 0);
            if (total !== 3) {
                throw new Error(`distribution totals ${total}, expected 3`);
            }
            for (const e of sent.valueDistribution) {
                [opp.base, ...opp.zones.groundArena].find((c) => c.uuid === e.uuid).damage += e.amount;
            }
            opp.zones.groundArena = opp.zones.groundArena.filter((u) => u.damage < 3);
            this.mode = 'window';
        }
        if (opp.base.damage >= opp.base.cardData.hp) {
            this.winnerNames = [me.name];
        }
        this.turn = opp.id;
        this.turns++;
        this.round = 1 + Math.floor(this.turns / 4);
    }
}

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && i < process.argv.indexOf('--') ? process.argv[i + 1] : dflt;
}

async function main() {
    const sep = process.argv.indexOf('--');
    const [cmd, ...args] = sep > 0 ? process.argv.slice(sep + 1) : [];
    if (!cmd) {
        console.error('usage: node bot/stdio-smoke.js [--games 3] [--out dir] -- <cmd> [args...]');
        process.exit(2);
    }
    const games = Number(arg('games', 3));
    const out = arg('out', null);
    const env = { randomDeck: () => ({ metadata: { name: 'luke-skywalker#faithful-friend / echo-base' } }), newGame: () => new FakeGame(), engineRev: 'fake' };
    const transcript = [];
    let failed = 0;
    for (let seed = 1; seed <= games; seed++) {
        const ext = new ExternalBot('external', { cmd, args, cwd: process.cwd(), timeoutMs: 5000 });
        if (out) {
            const call = ext.call.bind(ext);
            ext.call = (msg, ms) => {
                transcript.push(msg);
                const reply = call(msg, ms);
                transcript.push(reply);
                return reply;
            };
        }
        // external bot takes p1 in odd games and p2 in even ones
        const bots = seed % 2 ? [ext, createRandomBot('random')] : [createRandomBot('random'), ext];
        const events = [];
        const r = await playGame(env, { seed, bots, record: true, snapshot, maxSteps: 200, onEvent: (e) => events.push(e) });
        ext.close();
        const seat = seed % 2 ? 'p1' : 'p2';
        console.log(`game ${seed} (external as ${seat}): ${r.outcome} winner=${r.winner} steps=${r.steps}${r.error ? ' ' + r.error : ''}`);
        if (r.outcome !== 'won') {
            failed++;
        }
        if (out) {
            fs.mkdirSync(out, { recursive: true });
            fs.writeFileSync(path.join(out, `game-${seed}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
        }
    }
    if (out) {
        fs.writeFileSync(path.join(out, 'stdio.jsonl'), transcript.map((m) => JSON.stringify(m)).join('\n') + '\n');
    }
    console.log(failed ? `${failed} of ${games} games failed` : `ok: ${games} games`);
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
