'use strict';
// node analysis/fixtures/sim.js [--seed 23] [--out analysis/fixtures/fixture-game.jsonl] [--scan 40]
//
// A small SWU-like simulator that writes a game in the exact replay format bot/recorder.js produces
// (header, step* with a full board snapshot, end). It exists only so the analysis pipeline can be built and
// demoed without the forceteki engine and card data. It is NOT the real rules: cards are a simplified pool
// (units, a few removal/heal events, leader deploy), no card text beyond that, set codes are null so the
// viewer shows stat tiles. Real games from bot/tournament.js drop in unchanged.
//
// --scan N tries seeds 1..N and reports how often the lead changed hands, to pick an interesting fixture.

const fs = require('fs');
const path = require('path');

// same PRNG as bot/env.js seededRng (copied so this file runs without the engine build)
function seededRng(seedStr) {
    let h = 1779033703 ^ String(seedStr).length;
    for (let i = 0; i < String(seedStr).length; i++) {
        h = Math.imul(h ^ String(seedStr).charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19);
    }
    let a = h >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const U = (name, cost, arena, p, h, extra = {}) => ({ name, cost, type: 'unit', arena, p, h, ...extra });
const E = (name, cost, effect) => ({ name, cost, type: 'event', effect });

const POOLS = {
    rebel: [
        U('Battlefield Marine', 2, 'ground', 3, 3), U('Battlefield Marine', 2, 'ground', 3, 3),
        U('Alliance X-Wing', 2, 'space', 2, 3), U('Alliance X-Wing', 2, 'space', 2, 3),
        U('Rebel Pathfinders', 3, 'ground', 2, 5, { sentinel: 1 }), U('Fleet Lieutenant', 3, 'ground', 3, 3),
        U('Wing Leader', 2, 'space', 1, 3), U('Wampa', 4, 'ground', 4, 5), U('Wampa', 4, 'ground', 4, 5),
        U('Rogue Squadron Skirmisher', 3, 'space', 3, 4), U('Yoda, Old Master', 3, 'ground', 2, 4),
        U('Home One', 8, 'space', 7, 7), U('Chewbacca, Loyal Companion', 5, 'ground', 3, 6, { sentinel: 1 }),
        U('Luke\'s Lightsaber Squad', 6, 'ground', 6, 6), U('Restored ARC-170', 2, 'space', 2, 3),
        E('Repair', 1, 'heal3'), E('Repair', 1, 'heal3'), E('Takedown', 4, 'defeat5'), E('Vanquish', 5, 'defeatAny'),
        E('For a Cause I Believe In', 3, 'base4')
    ],
    imperial: [
        U('Death Star Stormtrooper', 1, 'ground', 3, 1), U('Death Star Stormtrooper', 1, 'ground', 3, 1),
        U('TIE/ln Fighter', 1, 'space', 2, 1), U('TIE/ln Fighter', 1, 'space', 2, 1),
        U('Imperial Interceptor', 4, 'space', 3, 2), U('General Tagge', 2, 'ground', 2, 2),
        U('Admiral Piett', 2, 'ground', 1, 4), U('AT-ST', 6, 'ground', 6, 7), U('Gladiator Star Destroyer', 6, 'space', 4, 8, { sentinel: 1 }),
        U('Seventh Sister', 3, 'ground', 3, 4), U('Grand Moff Tarkin', 4, 'ground', 2, 4), U('Emperor\'s Royal Guard', 3, 'ground', 2, 5, { sentinel: 1 }),
        U('Devastator', 10, 'space', 8, 10), U('Fifth Brother', 4, 'ground', 4, 4), U('Snowtrooper Lieutenant', 2, 'ground', 2, 2),
        E('Overwhelming Barrage', 5, 'base4'), E('Takedown', 4, 'defeat5'), E('Vanquish', 5, 'defeatAny'),
        E('Force Choke', 2, 'dmg5ground'), E('Force Choke', 2, 'dmg5ground')
    ]
};

const SIDES = [
    { pool: 'rebel', leader: { name: 'Luke Skywalker, Faithful Friend', p: 4, h: 7, deployAt: 6 }, base: { name: 'Echo Base', hp: 30 }, deck: 'Hoth Rebels (fixture)' },
    { pool: 'imperial', leader: { name: 'Darth Vader, Dark Lord of the Sith', p: 5, h: 8, deployAt: 7 }, base: { name: 'Administrator\'s Tower', hp: 30 }, deck: 'Vader Aggro (fixture)' }
];

const internal = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const ref = (c) => ({ n: c.name, s: null });

function simulate(seed, botNames = ['heuristic-aggro', 'heuristic-control']) {
    const rng = seededRng('fixture' + seed);
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const shuffle = (arr) => {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    };

    const players = SIDES.map((s, i) => ({
        id: `p${i + 1}`, name: botNames[i], style: i === 0 ? 'aggro' : 'control',
        deck: shuffle([...POOLS[s.pool], ...POOLS[s.pool]].map((c) => ({ ...c }))),
        hand: [], discard: [], resources: [], ready: 0,
        base: { ...s.base, d: 0 }, leaderDef: s.leader, leader: { name: s.leader.name, dep: 0, x: 0 },
        ground: [], space: []
    }));
    const opp = (pl) => players[1 - players.indexOf(pl)];
    let round = 1;
    let phase = 'setup';
    let initiative = players[Math.floor(rng() * 2)];
    let winner = null;
    const events = [];
    let n = 0;

    const unitSnap = (u) => {
        const o = { n: u.name, s: null, p: u.p, h: u.h, d: u.d };
        if (u.x) {
            o.x = 1;
        }
        if (u.sentinel) {
            o.sn = 1;
        }
        return o;
    };
    const snap = () => ({
        round, phase, initiative: initiative.id,
        players: Object.fromEntries(players.map((p) => [p.id, {
            name: p.name,
            base: { n: p.base.name, s: null, hp: p.base.hp, d: p.base.d },
            leader: { n: p.leader.name, s: null, dep: p.leader.dep, x: p.leader.x },
            res: { ready: p.ready, total: p.resources.length },
            hand: p.hand.map(ref), deck: p.deck.length, discard: p.discard.map(ref),
            ground: p.ground.map(unitSnap), space: p.space.map(unitSnap)
        }]))
    });
    const step = (pl, prompt, title, kind, label, legal) => {
        n++;
        events.push({ t: 'step', n, pid: pl.id, prompt, title, action: { kind, label }, legal, state: snap() });
    };

    const draw = (p, k) => {
        for (let i = 0; i < k && p.deck.length; i++) {
            p.hand.push(p.deck.shift());
        }
    };
    const units = (p) => [...p.ground, ...p.space];
    const unitScore = (u) => u.p * 1.3 + (u.h - u.d) * 0.9;
    const damageBase = (p, k) => {
        p.base.d = Math.min(p.base.hp, p.base.d + k);
        if (p.base.d >= p.base.hp) {
            winner = opp(p);
        }
    };
    const defeat = (owner, u) => {
        owner[u.arena] = owner[u.arena].filter((x) => x !== u);
        if (u.isLeader) {
            owner.leader.dep = 0;
            owner.leader.x = 1;
        } else {
            owner.discard.push(u.card);
        }
    };
    const chooseResource = (p) => {
        // keep cheap units and removal, resource the most expensive card we cannot cast soon
        const sorted = [...p.hand].sort((a, b) => b.cost - a.cost);
        const c = p.resources.length < 5 ? sorted[0] : (sorted[0].cost > p.resources.length + 2 ? sorted[0] : null);
        return c;
    };
    const resourceCard = (p, c) => {
        p.hand.splice(p.hand.indexOf(c), 1);
        p.resources.push(c);
    };

    // ---- setup: draw 6, resource 2
    for (const p of players) {
        draw(p, 6);
    }
    events.push({ t: 'header', v: 1, seed, engine: 'fixture-sim', players: players.map((p, i) => ({ id: p.id, bot: p.name, deck: SIDES[i].deck })) });
    events.push({ t: 'step', n: 0, label: 'Game start', state: snap() });
    for (const p of [initiative, opp(initiative)]) {
        for (let k = 0; k < 2; k++) {
            const legal = p.hand.length;
            const c = [...p.hand].sort((a, b) => b.cost - a.cost)[k === 0 ? 0 : Math.floor(rng() * 2)];
            resourceCard(p, c);
            step(p, 'resource|multiple', 'Select 2 cards to resource', 'card', internal(c.name), legal);
        }
        step(p, 'resource|multiple', 'Select 2 cards to resource', 'button', 'Done', 1);
    }

    // ---- rounds
    while (!winner && round <= 30) {
        phase = 'action';
        for (const p of players) {
            p.ready = p.resources.length;
        }
        let active = initiative;
        let passes = 0;
        let claimed = null;
        while (!winner && passes < 2) {
            const p = active;
            const o = opp(p);
            if (claimed === p) {
                active = o;
                continue;
            }
            const options = [];
            for (const c of p.hand) {
                if (c.cost <= p.ready) {
                    options.push({ type: 'play', c });
                }
            }
            for (const u of units(p)) {
                if (!u.x) {
                    options.push({ type: 'attack', u });
                }
            }
            if (!p.leader.dep && !p.leader.x && p.resources.length >= p.leaderDef.deployAt) {
                options.push({ type: 'deploy' });
            }
            const legal = options.length + (claimed ? 1 : 2);
            // score options with a little noise so seeds differ
            let best = { type: 'pass', s: 0.6 + rng() * 0.6 };
            for (const op of options) {
                let s = 0;
                if (op.type === 'play') {
                    const c = op.c;
                    if (c.type === 'unit') {
                        s = 2 + c.cost * 0.8;
                    } else if (c.effect === 'heal3') {
                        s = p.base.d >= 6 ? 2.5 : 0.2;
                    } else if (c.effect === 'base4') {
                        s = p.style === 'aggro' ? 3.5 : 1.5;
                    } else {
                        const targets = units(o).filter((u) => !u.isLeader && (c.effect === 'defeatAny' || (c.effect === 'defeat5' && u.h - u.d <= 5) || (c.effect === 'dmg5ground' && u.arena === 'ground')));
                        s = targets.length ? 1.5 + Math.max(...targets.map(unitScore)) * 0.6 : -1;
                    }
                } else if (op.type === 'attack') {
                    s = 2.5 + op.u.p * (p.style === 'aggro' ? 0.6 : 0.35);
                } else {
                    s = 6;
                }
                s += rng() * 1.5;
                if (s > best.s) {
                    best = { ...op, s };
                }
            }

            if (best.type === 'pass') {
                // claiming initiative also passes for the rest of the round; the phase ends on two passes in a row,
                // or when the other player passes after someone claimed
                if (!claimed && rng() < 0.5) {
                    claimed = p;
                    initiative = p;
                    step(p, 'actionWindow', 'Choose an action', 'button', 'Claim Initiative', legal);
                } else {
                    step(p, 'actionWindow', 'Choose an action', 'button', 'Pass', legal);
                }
                passes = claimed && claimed !== p ? 2 : passes + 1;
                active = o;
                continue;
            }
            passes = 0;

            if (best.type === 'deploy') {
                p.leader.dep = 1;
                const lu = { name: p.leaderDef.name, card: null, arena: 'ground', p: p.leaderDef.p, h: p.leaderDef.h, d: 0, x: 0, isLeader: true };
                p.ground.push(lu);
                step(p, 'actionWindow', 'Choose an action', 'button', `Deploy ${p.leaderDef.name.split(',')[0]}`, legal);
            } else if (best.type === 'play') {
                const c = best.c;
                p.hand.splice(p.hand.indexOf(c), 1);
                p.ready -= c.cost;
                if (c.type === 'unit') {
                    p[c.arena].push({ name: c.name, card: c, arena: c.arena, p: c.p, h: c.h, d: 0, x: 1, sentinel: c.sentinel });
                    step(p, 'actionWindow', 'Choose an action', 'card', internal(c.name), legal);
                } else {
                    p.discard.push(c);
                    if (c.effect === 'heal3') {
                        const hurt = units(p).filter((u) => u.d > 0).sort((a, b) => b.d - a.d)[0];
                        step(p, 'actionWindow', 'Choose an action', 'card', internal(c.name), legal);
                        if (hurt && (p.base.d < 6 || rng() < 0.3)) {
                            hurt.d = Math.max(0, hurt.d - 3);
                            step(p, 'select|single', 'Heal 3 damage from a unit or base', 'card', internal(hurt.name), units(p).length + 1);
                        } else {
                            p.base.d = Math.max(0, p.base.d - 3);
                            step(p, 'select|single', 'Heal 3 damage from a unit or base', 'card', internal(p.base.name), units(p).length + 1);
                        }
                    } else if (c.effect === 'base4') {
                        damageBase(o, 4);
                        step(p, 'actionWindow', 'Choose an action', 'card', internal(c.name), legal);
                    } else {
                        const targets = units(o).filter((u) => !u.isLeader && (c.effect === 'defeatAny' || (c.effect === 'defeat5' && u.h - u.d <= 5) || (c.effect === 'dmg5ground' && u.arena === 'ground')));
                        step(p, 'actionWindow', 'Choose an action', 'card', internal(c.name), legal);
                        if (targets.length) {
                            const t = targets.sort((a, b) => unitScore(b) - unitScore(a))[0];
                            if (c.effect === 'dmg5ground') {
                                t.d += 5;
                                if (t.d >= t.h) {
                                    defeat(o, t);
                                }
                            } else {
                                defeat(o, t);
                            }
                            step(p, 'select|single', c.effect === 'dmg5ground' ? 'Deal 5 damage to a ground unit' : 'Defeat a unit', 'card', internal(t.name), targets.length);
                        }
                    }
                }
            } else {
                // attack
                const a = best.u;
                const enemies = o[a.arena];
                const sentinels = enemies.filter((u) => u.sentinel);
                const targets = sentinels.length ? sentinels : [...enemies, 'base'];
                step(p, 'actionWindow', 'Choose an action', 'card', internal(a.name), legal);
                // pick target: aggro hits base unless a good trade; control trades
                let t = 'base';
                const killable = targets.filter((u) => u !== 'base' && u.h - u.d <= a.p);
                if (!targets.includes('base')) {
                    t = targets.sort((x, y) => (x.h - x.d) - (y.h - y.d))[0];
                } else if (killable.length && (p.style === 'control' || rng() < 0.35)) {
                    t = killable.sort((x, y) => unitScore(y) - unitScore(x))[0];
                }
                a.x = 1;
                if (t === 'base') {
                    damageBase(o, a.p);
                    step(p, 'select|single', 'Choose a target for attack', 'card', internal(o.base.name), targets.length);
                } else {
                    t.d += a.p;
                    a.d += t.p;
                    step(p, 'select|single', 'Choose a target for attack', 'card', internal(t.name), targets.length);
                    if (t.d >= t.h) {
                        defeat(o, t);
                    }
                    if (a.d >= a.h) {
                        defeat(p, a);
                    }
                }
            }
            active = o;
        }
        if (winner) {
            break;
        }

        // ---- regroup: draw 2, resource up to 1, ready
        phase = 'regroup';
        for (const p of players) {
            draw(p, 2);
            if (p.deck.length === 0 && p.hand.length === 0) {
                damageBase(p, 3);
            }
        }
        for (const p of [initiative, opp(initiative)]) {
            const c = p.hand.length ? chooseResource(p) : null;
            if (c) {
                resourceCard(p, c);
                step(p, 'resource|multiple', 'Select between 0 and 1 cards to resource', 'card', internal(c.name), p.hand.length + 2);
            }
            step(p, 'resource|multiple', 'Select between 0 and 1 cards to resource', 'button', 'Done', 1);
        }
        for (const p of players) {
            for (const u of units(p)) {
                u.x = 0;
            }
            p.leader.x = 0;
            p.ready = p.resources.length;
        }
        round++;
    }

    phase = 'action';
    events.push({ t: 'end', winner: winner ? winner.id : null, round, steps: n, outcome: winner ? 'won' : 'STEP_CAP', error: null });
    return events;
}

/** How many times the base-damage race changed leader, a cheap proxy for an interesting game. */
function leadChanges(events) {
    let last = 0;
    let changes = 0;
    for (const e of events) {
        if (e.t !== 'step') {
            continue;
        }
        const s = e.state.players;
        const diff = Math.sign(s.p2.base.d - s.p1.base.d);
        if (diff && last && diff !== last) {
            changes++;
        }
        if (diff) {
            last = diff;
        }
    }
    return changes;
}

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

if (require.main === module) {
    const scan = Number(arg('scan', 0));
    if (scan) {
        for (let s = 1; s <= scan; s++) {
            const ev = simulate(s);
            const end = ev[ev.length - 1];
            console.log(`seed ${s}: ${end.winner} wins R${end.round}, ${end.steps} steps, ${leadChanges(ev)} lead changes`);
        }
    } else {
        const seed = Number(arg("seed", 23));
        const out = path.resolve(arg('out', path.join(__dirname, 'fixture-game.jsonl')));
        const ev = simulate(seed);
        fs.writeFileSync(out, ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
        const end = ev[ev.length - 1];
        console.log(`wrote ${out}: ${end.winner} wins R${end.round}, ${end.steps} steps, ${leadChanges(ev)} lead changes`);
    }
}

module.exports = { simulate };
