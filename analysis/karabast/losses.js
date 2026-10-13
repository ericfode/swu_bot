#!/usr/bin/env node
'use strict';
/**
 * Why our bot lost to people on Karabast: per-game facts read from the replays games.js wrote, and a summary that
 * compares lost games with won ones.
 *
 *   node analysis/karabast/losses.js --games <games.js out dir> [--json facts.json]
 *
 * Only games that reached round 2 count (an opponent who leaves at the start is no game). Per game it reads the log
 * lines and the board at the start of each action phase:
 * - duplicate uniques: our own "defeats 1 copy of X due to the uniqueness rule" (we played a unique card we already had);
 * - leader deploys (as a unit or as a Pilot) and our deployed leader's defeats, with the rounds in between;
 * - attacks on bases and on units, the base damage each base attack did, base healing, and the opponent's removal plays
 *   (a card or ability of theirs that defeats, damages, takes control of, returns or captures). An attack with an On
 *   Attack prompt resolves over several steps, so a base attack's damage is what its target base took from the attack
 *   step until the next action (an attack, a play, a deploy, a pass or claim) or the end of the round;
 * - the race at the start of each round: base damage, board power and unit HP, resources and hand size per side.
 * The facts are leads from logs, not proof: a removal play can target our base or miss, and log lines name cards only.
 */
const fs = require('fs');
const path = require('path');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r1 = (x) => Math.round(x * 10) / 10;
const units = (P) => [...(P.ground ?? []), ...(P.space ?? [])];
// a log line that starts a new action: the damage after it no longer belongs to the attack before it
const ACTION = /^(p[12] (attacks|plays|passes|claims)|p[12] uses .+ to deploy|Round: )/;

function gameFacts(row, events) {
    const me = row.ours;
    const opp = me === 'p1' ? 'p2' : 'p1';
    const end = events[events.length - 1];
    const steps = events.filter((x) => x.t === 'step' && x.state);
    const f = {
        id: row.id, won: end.winner === me, how: end.how, round: end.round, oppDeck: row.decks?.[opp] ?? null,
        dupUnique: [], deploys: [], leaderDefeats: [], attacks: { me: { base: 0, unit: 0 }, opp: { base: 0, unit: 0 } },
        baseHits: { me: [], opp: [] }, healed: { me: 0, opp: 0 }, oppRemoval: 0, rounds: []
    };
    const leader = events[0].players.find((p) => p.id === me)?.deck?.split(' / ')[0] ?? null;
    let deployedAt = null;
    let prev = null;
    let open = null; // the base attack still resolving: who made it, the base it hit, the damage so far
    const close = () => {
        if (open) {
            f.baseHits[open.who].push(open.d);
            open = null;
        }
    };
    for (const x of steps) {
        const s = x.state;
        if ((x.log ?? []).some((line) => ACTION.test(line))) {
            close();
        }
        for (const line of x.log ?? []) {
            let m;
            if ((m = /^(p[12]) defeats 1 copy of (.+) due to the uniqueness rule/.exec(line)) && m[1] === me) {
                f.dupUnique.push({ round: s.round, card: m[2] });
            }
            if (leader && line.startsWith(`${me} uses ${leader} to deploy ${leader}`)) {
                f.deploys.push({ round: s.round, pilot: /pilot/i.test(line) });
                deployedAt = s.round;
            }
            if (leader && line.startsWith(`${me}'s ${leader} is defeated`) && deployedAt !== null) {
                f.leaderDefeats.push({ round: s.round, after: s.round - deployedAt });
                deployedAt = null;
            }
            if ((m = /^(p[12]) attacks (.+?) with (.+)$/.exec(line))) {
                const who = m[1] === me ? 'me' : 'opp';
                const onBase = /^p[12]'s base$/.test(m[2]);
                f.attacks[who][onBase ? 'base' : 'unit']++;
                if (onBase && prev) {
                    open = { who, target: who === 'me' ? opp : me, d: 0 };
                }
            }
            if (new RegExp(`^${opp} (plays|uses) .+? to (defeat|deal \\d+ damage to|take control of|return|capture)`).test(line)) {
                f.oppRemoval++;
            }
        }
        if (prev && open) {
            open.d += Math.max(0, s.players[open.target].base.d - prev.players[open.target].base.d);
        }
        if (prev) {
            for (const [who, q] of [['me', me], ['opp', opp]]) {
                const d = s.players[q].base.d - prev.players[q].base.d;
                if (d < 0) {
                    f.healed[who] -= d;
                }
            }
        }
        prev = s;
    }
    close();
    const seen = new Set();
    for (const x of steps) {
        const s = x.state;
        if (s.phase !== 'action' || seen.has(s.round)) {
            continue;
        }
        seen.add(s.round);
        const side = (q) => {
            const P = s.players[q];
            return {
                baseD: P.base.d, baseHp: P.base.hp, power: units(P).reduce((a, u) => a + (u.p ?? 0), 0),
                unitHp: units(P).reduce((a, u) => a + (u.h ?? 0) - (u.d ?? 0), 0), units: units(P).length,
                res: P.res?.total ?? 0, hand: (P.hand ?? []).length
            };
        };
        f.rounds.push({ r: s.round, me: side(me), opp: side(opp) });
    }
    return f;
}

function summary(facts) {
    const out = [];
    const say = (...a) => out.push(a.join(' '));
    const lost = facts.filter((f) => !f.won);
    const won = facts.filter((f) => f.won);
    say(`games that reached round 2: ${facts.length} (won ${won.length}, lost ${lost.length})`);
    const how = {};
    for (const f of facts) {
        const k = `${f.won ? 'won' : 'lost'}, ${f.how}`;
        how[k] = (how[k] ?? 0) + 1;
    }
    say('how they ended:', JSON.stringify(how));
    const endRounds = {};
    for (const f of lost) {
        endRounds[f.round] = (endRounds[f.round] ?? 0) + 1;
    }
    say('round of the loss:', JSON.stringify(endRounds));
    const dups = facts.flatMap((f) => f.dupUnique);
    const byCard = {};
    for (const d of dups) {
        byCard[d.card] = (byCard[d.card] ?? 0) + 1;
    }
    say(`duplicate uniques played: ${dups.length} in ${facts.filter((f) => f.dupUnique.length).length} games (lost ${lost.filter((f) => f.dupUnique.length).length}, won ${won.filter((f) => f.dupUnique.length).length}):`, JSON.stringify(byCard));
    const deploys = facts.flatMap((f) => f.deploys);
    const defeats = facts.flatMap((f) => f.leaderDefeats);
    say(`leader deploys: ${deploys.length} (as a Pilot ${deploys.filter((d) => d.pilot).length}); defeated afterwards ${defeats.length}: same round ${defeats.filter((d) => d.after === 0).length}, next ${defeats.filter((d) => d.after === 1).length}, later ${defeats.filter((d) => d.after > 1).length}`);
    for (const [name, set] of [['lost', lost], ['won', won]]) {
        const sum = (k, t) => set.reduce((a, f) => a + f.attacks[k][t], 0);
        const hits = (k) => set.flatMap((f) => f.baseHits[k]);
        say(`${name}: base attacks per game us ${r1(sum('me', 'base') / set.length)} (${r1(mean(hits('me')))} damage each), them ${r1(sum('opp', 'base') / set.length)} (${r1(mean(hits('opp')))} each); unit attacks us ${r1(sum('me', 'unit') / set.length)}, them ${r1(sum('opp', 'unit') / set.length)}`);
        say(`${name}: their removal plays per game ${r1(mean(set.map((f) => f.oppRemoval)))}, base damage they healed per game ${r1(mean(set.map((f) => f.healed.opp)))}`);
        for (let r = 2; r <= 8; r++) {
            const at = set.map((f) => f.rounds.find((x) => x.r === r)).filter(Boolean);
            if (at.length < 4) {
                continue;
            }
            const m = (fn) => r1(mean(at.map(fn)));
            say(`  ${name} round ${r} start (${at.length} games): base damage taken ${m((x) => x.me.baseD)} dealt ${m((x) => x.opp.baseD)} | power ${m((x) => x.me.power)} v ${m((x) => x.opp.power)} | unit HP ${m((x) => x.me.unitHp)} v ${m((x) => x.opp.unitHp)} | resources ${m((x) => x.me.res)} v ${m((x) => x.opp.res)} | hand ${m((x) => x.me.hand)} v ${m((x) => x.opp.hand)}`);
        }
    }
    const left = lost.map((f) => {
        const last = f.rounds[f.rounds.length - 1];
        return last ? last.opp.baseHp - last.opp.baseD : null;
    }).filter((x) => x !== null);
    say(`their base HP left at the start of the round we lost: median ${left.sort((a, b) => a - b)[Math.floor(left.length / 2)]}, 5 or less in ${left.filter((x) => x <= 5).length} of ${left.length}`);
    return out.join('\n');
}

function main() {
    const dir = arg('games');
    if (!dir) {
        throw new Error('usage: losses.js --games <games.js out dir> [--json facts.json]');
    }
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    const facts = [];
    for (const row of index) {
        if (!['p1', 'p2'].includes(row.ours) || !(row.round >= 2)) {
            continue;
        }
        const events = fs.readFileSync(path.join(dir, 'games', `${row.id}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        facts.push(gameFacts(row, events));
    }
    const json = arg('json');
    if (json) {
        fs.writeFileSync(json, JSON.stringify(facts) + '\n');
    }
    console.log(summary(facts));
}

if (require.main === module) {
    main();
}

module.exports = { gameFacts, summary };
