// Hand-made fixture tournaments in the exact replay format bot/recorder.js + bot/tournament.js write
// (index.json + games/<id>.jsonl). The engine's card data can't be downloaded everywhere, so this plays a
// simplified SWU-like game (units, upgrades, events, base damage, initiative, regroup) to produce realistic files.
// Set codes use a fake "FIX" set so card art lookups 404 and the viewer falls back to tiles, as for tokens.
//   node fixtures/generate.mjs [outDir]   (default: studio/fixtures/replays)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] ?? path.join(here, 'replays'));

function rngFrom(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

let num = 0;
const code = () => `FIX_${String(++num).padStart(3, '0')}`;
const unit = (n, arena, cost, p, h, extra = {}) => ({ n, s: code(), type: 'unit', arena, cost, p, h, ...extra });
const POOL = [
    unit('Battlefield Marine', 'ground', 2, 3, 3),
    unit('Rebel Pathfinder', 'ground', 2, 2, 3),
    unit('Death Trooper', 'ground', 3, 3, 3),
    unit('Wampa', 'ground', 4, 4, 5),
    unit('Admiral Ackbar', 'ground', 2, 1, 3),
    unit('Fleet Lieutenant', 'ground', 3, 3, 3),
    unit('Wookiee Warrior', 'ground', 4, 4, 5),
    unit('Sundari Peacekeeper', 'ground', 3, 1, 6, { sn: 1 }),
    unit('Imperial Dark Trooper', 'ground', 5, 5, 6),
    unit('Grand Inquisitor', 'ground', 3, 3, 4),
    unit('Chewbacca, Loyal Companion', 'ground', 5, 3, 6, { sn: 1 }),
    unit('Han Solo, Reluctant Hero', 'ground', 6, 6, 6),
    unit('Darth Vader, Commanding the First Legion', 'ground', 7, 6, 7),
    unit('Avenger, Hunting Star Destroyer', 'space', 9, 8, 8),
    unit('TIE/ln Fighter', 'space', 1, 2, 1),
    unit('Alliance X-Wing', 'space', 2, 2, 3),
    unit('Green Squadron A-Wing', 'space', 2, 3, 1),
    unit('Ruthless Raider', 'space', 6, 4, 6),
    unit('Home One, Alliance Flagship', 'space', 8, 7, 7),
    unit('Millennium Falcon, Piece of Junk', 'space', 3, 3, 4),
    unit('Gladiator Star Destroyer', 'space', 6, 5, 6, { sn: 1 }),
    { n: 'Vambrace Flamethrower', s: code(), type: 'upgrade', cost: 2, p: 2, h: 0 },
    { n: 'Academy Training', s: code(), type: 'upgrade', cost: 2, p: 2, h: 2 },
    { n: 'Hardpoint Heavy Blaster', s: code(), type: 'upgrade', cost: 2, p: 2, h: 2 },
    { n: 'Open Fire', s: code(), type: 'event', cost: 3, dmg: 4 },
    { n: 'Takedown', s: code(), type: 'event', cost: 4, dmg: 99 },
    { n: 'Power of the Dark Side', s: code(), type: 'event', cost: 3, dmg: 99 },
    { n: 'Repair', s: code(), type: 'event', cost: 1, heal: 3 },
    { n: 'Moment of Peace', s: code(), type: 'event', cost: 1, shield: 1 },
    { n: 'Bombing Run', s: code(), type: 'event', cost: 6, dmg: 3, sweep: 1 }
];
const LEADERS = [
    { n: 'Luke Skywalker, Faithful Friend', s: code(), p: 4, h: 7 },
    { n: 'Darth Vader, Dark Lord of the Sith', s: code(), p: 5, h: 8 },
    { n: 'Sabine Wren, Galvanized Revolutionary', s: code(), p: 4, h: 6 },
    { n: 'Iden Versio, Inferno Squad Commander', s: code(), p: 4, h: 7 },
    { n: 'Grand Moff Tarkin, Oversector Governor', s: code(), p: 3, h: 7 },
    { n: 'Hera Syndulla, Spectre Two', s: code(), p: 4, h: 6 }
];
const BASES = [
    { n: 'Echo Base', s: code(), hp: 30 },
    { n: 'Administrator\'s Tower', s: code(), hp: 30 },
    { n: 'Chopper Base', s: code(), hp: 28 },
    { n: 'Command Center', s: code(), hp: 30 },
    { n: 'Dagobah Swamp', s: code(), hp: 30 },
    { n: 'Tarkintown', s: code(), hp: 25 }
];
const internal = (n) => n.toLowerCase().replace(/'/g, '').replace(/, /, '#').replace(/[^a-z0-9#]+/g, '-');
const ref = (c) => ({ n: c.n, s: c.s });

function playGame({ seed, bots, maxRound = 14, stopAt = Infinity }) {
    const rng = rngFrom(seed * 7919);
    const pick = (a) => a[Math.floor(rng() * a.length)];
    const shuffle = (a) => {
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    };
    const makeSide = (bot) => {
        const deck = shuffle(Array.from({ length: 50 }, () => pick(POOL)));
        const leader = pick(LEADERS);
        const base = pick(BASES);
        return {
            bot, leaderCard: leader, deckName: `Random ${leader.n.split(',')[0]} deck`,
            base: { ...ref(base), hp: base.hp, d: 0 }, leader: { ...ref(leader), dep: 0, x: 0 },
            res: { ready: 0, total: 0 }, hand: deck.splice(0, 6), deck, discard: [], ground: [], space: []
        };
    };
    const P = { p1: makeSide(bots[0]), p2: makeSide(bots[1]) };
    const other = (s) => (s === 'p1' ? 'p2' : 'p1');
    let round = 1;
    let phase = 'setup';
    let initiative = rng() < 0.5 ? 'p1' : 'p2';
    const events = [];
    let n = 0;
    let winner = null;

    const unitSnap = (u) => {
        const o = { n: u.n, s: u.s, p: u.p, h: u.h, d: u.d };
        if (u.x) {
            o.x = 1;
        }
        if (u.sn) {
            o.sn = 1;
        }
        if (u.u?.length) {
            o.u = u.u.map((x) => ({ n: x.n, s: x.s, t: x.t }));
        }
        return o;
    };
    const snapSide = (p) => ({
        name: p.bot, base: { ...p.base }, leader: { ...p.leader }, res: { ...p.res },
        hand: p.hand.map(ref), deck: p.deck.length, discard: p.discard.map(ref),
        ground: p.ground.map(unitSnap), space: p.space.map(unitSnap)
    });
    const snapshot = () => ({ round, phase, initiative, players: { p1: snapSide(P.p1), p2: snapSide(P.p2) } });
    const step = (pid, prompt, title, kind, label, legal) => {
        n++;
        events.push({ t: 'step', n, pid, prompt, title, action: { kind, label }, legal, state: snapshot() });
    };
    const allUnits = (p) => [...p.ground, ...p.space];
    const checkWin = () => {
        for (const s of ['p1', 'p2']) {
            if (P[s].base.d >= P[s].base.hp) {
                winner = other(s);
            }
        }
        return winner != null;
    };
    const defeat = (side, u) => {
        const p = P[side];
        for (const arena of ['ground', 'space']) {
            p[arena] = p[arena].filter((x) => x !== u);
        }
        if (u.leaderUnit) {
            p.leader.dep = 0;
            p.leader.x = 1;
            return;
        }
        p.discard.push(ref(u));
        for (const up of u.u ?? []) {
            if (!up.t) {
                p.discard.push(ref(up));
            }
        }
    };
    const dealTo = (side, u, amt) => {
        const sh = (u.u ?? []).findIndex((x) => x.n === 'Shield');
        if (sh >= 0) {
            u.u.splice(sh, 1);
            return;
        }
        u.d += amt;
        if (u.d >= u.h) {
            defeat(side, u);
        }
    };
    const smart = (pid) => P[pid].bot.startsWith('heuristic') || P[pid].bot.startsWith('aggro');
    const aggro = (pid) => P[pid].bot.startsWith('aggro');

    events.push({
        t: 'header', v: 1, seed, engine: 'fixture',
        players: ['p1', 'p2'].map((id) => ({ id, bot: P[id].bot, deck: P[id].deckName }))
    });
    events.push({ t: 'step', n: 0, label: 'Game start', state: snapshot() });

    // setup: mulligan, then two resources each
    for (const pid of [initiative, other(initiative)]) {
        step(pid, 'menu|-', 'Keep your hand or mulligan?', 'button', rng() < 0.85 ? 'Keep' : 'Mulligan', 2);
        for (let k = 0; k < 2; k++) {
            const i = Math.floor(rng() * P[pid].hand.length);
            const [c] = P[pid].hand.splice(i, 1);
            P[pid].res.total++;
            P[pid].res.ready++;
            step(pid, 'select|unlimited', 'Select 2 cards to resource', 'card', internal(c.n), P[pid].hand.length + 1);
        }
        step(pid, 'select|unlimited', 'Select 2 cards to resource', 'button', 'Done', 1);
    }

    while (!winner && round <= maxRound && n < stopAt) {
        phase = 'action';
        let actor = initiative;
        let passes = 0;
        let claimed = null;
        let guard = 0;
        while (passes < 2 && !winner && guard++ < 60 && n < stopAt) {
            const me = P[actor];
            const opp = P[other(actor)];
            if (claimed === actor) {
                actor = other(actor);
                continue;
            }
            const playable = me.hand.filter((c) => c.cost <= me.res.ready && (c.type !== 'upgrade' || allUnits(me).length) &&
                (c.type !== 'event' || (c.heal ? me.base.d > 0 : c.shield ? allUnits(me).length : allUnits(opp).length)));
            const attackers = allUnits(me).filter((u) => !u.x);
            const canDeploy = !me.leader.dep && !me.leader.x && me.res.total >= 6 && round >= 4;
            const legal = playable.length + attackers.length + (canDeploy ? 1 : 0) + 2;
            const options = [];
            for (const c of playable) {
                options.push({ k: 'play', c, w: smart(actor) ? (c.type === 'unit' ? 3 + c.cost : 2) : 1 });
            }
            for (const u of attackers) {
                options.push({ k: 'attack', u, w: smart(actor) ? 4 + u.p * (aggro(actor) ? 1.5 : 1) : 1 });
            }
            if (canDeploy) {
                options.push({ k: 'deploy', w: smart(actor) ? 6 : 1 });
            }
            options.push({ k: 'pass', w: smart(actor) ? 0.4 : 1 });
            if (!claimed) {
                options.push({ k: 'claim', w: smart(actor) ? (options.length <= 2 ? 3 : 0.2) : 0.5 });
            }
            let total = options.reduce((a, o) => a + o.w, 0);
            let r = rng() * total;
            const choice = options.find((o) => (r -= o.w) <= 0) ?? options[options.length - 1];

            if (choice.k === 'pass') {
                passes++;
                step(actor, 'actionWindow|-', 'Choose an action', 'button', 'Pass', legal);
            } else if (choice.k === 'claim') {
                passes++;
                claimed = actor;
                initiative = actor;
                step(actor, 'actionWindow|-', 'Choose an action', 'button', 'Claim Initiative', legal);
            } else {
                passes = 0;
                if (choice.k === 'deploy') {
                    me.leader.dep = 1;
                    const L = me.leaderCard;
                    me.ground.push({ n: L.n, s: L.s, p: L.p, h: L.h, d: 0, x: 0, leaderUnit: true });
                    step(actor, 'actionWindow|-', 'Choose an action', 'card', `${internal(L.n)}`, legal);
                    step(actor, 'menu|-', null, 'button', 'Deploy ' + L.n.split(',')[0], 2);
                } else if (choice.k === 'play') {
                    const c = choice.c;
                    me.hand.splice(me.hand.indexOf(c), 1);
                    me.res.ready -= c.cost;
                    if (c.type === 'unit') {
                        me[c.arena].push({ n: c.n, s: c.s, p: c.p, h: c.h, d: 0, x: 1, sn: c.sn, u: [] });
                        step(actor, 'actionWindow|-', 'Choose an action', 'card', internal(c.n), legal);
                    } else if (c.type === 'upgrade') {
                        step(actor, 'actionWindow|-', 'Choose an action', 'card', internal(c.n), legal);
                        const host = smart(actor) ? allUnits(me).sort((a, b) => b.h - b.d - (a.h - a.d))[0] : pick(allUnits(me));
                        host.u = [...(host.u ?? []), { n: c.n, s: c.s, t: 0 }];
                        host.p += c.p;
                        host.h += c.h;
                        step(actor, 'select|single', `Choose a unit to attach ${c.n}`, 'card', internal(host.n), allUnits(me).length);
                    } else {
                        step(actor, 'actionWindow|-', 'Choose an action', 'card', internal(c.n), legal);
                        if (c.heal) {
                            me.base.d = Math.max(0, me.base.d - c.heal);
                            step(actor, 'select|single', `Choose a target for ${c.n}`, 'card', internal(me.base.n), 1 + allUnits(me).length);
                        } else if (c.shield) {
                            const t = pick(allUnits(me));
                            t.u = [...(t.u ?? []), { n: 'Shield', s: null, t: 1 }];
                            step(actor, 'select|single', `Choose a unit to give a Shield token`, 'card', internal(t.n), allUnits(me).length);
                        } else if (c.sweep) {
                            const arena = opp.ground.length >= opp.space.length ? 'ground' : 'space';
                            step(actor, 'menu|-', 'Choose an arena', 'button', arena === 'ground' ? 'Ground' : 'Space', 2);
                            for (const side of ['p1', 'p2']) {
                                for (const u of [...P[side][arena]]) {
                                    dealTo(side, u, c.dmg);
                                }
                            }
                            step(actor, 'select|single', null, 'button', 'Done', 1);
                        } else {
                            const targets = allUnits(opp);
                            const t = smart(actor) ? targets.sort((a, b) => b.p - a.p)[0] : pick(targets);
                            dealTo(other(actor), t, c.dmg);
                            step(actor, 'select|single', `Choose a unit to deal damage to`, 'card', internal(t.n), targets.length);
                        }
                        me.discard.push(ref(c));
                    }
                } else {
                    const u = choice.u;
                    const arena = me.ground.includes(u) ? 'ground' : 'space';
                    step(actor, 'actionWindow|-', 'Choose an action', 'card', internal(u.n), legal);
                    u.x = 1;
                    const foes = opp[arena];
                    const sentinels = foes.filter((f) => f.sn);
                    const choices = sentinels.length ? sentinels : [...foes, 'base'];
                    let target;
                    if (smart(actor) && !sentinels.length) {
                        const killable = foes.filter((f) => f.h - f.d <= u.p && f.p < u.h - u.d);
                        target = aggro(actor) || !killable.length ? 'base' : killable.sort((a, b) => b.p - a.p)[0];
                    } else {
                        target = pick(choices);
                    }
                    if (target === 'base') {
                        opp.base.d = Math.min(opp.base.hp, opp.base.d + u.p);
                        step(actor, 'select|single', 'Choose a target for attack', 'card', internal(opp.base.n), choices.length);
                    } else {
                        const back = target.p;
                        dealTo(other(actor), target, u.p);
                        dealTo(actor, u, back);
                        step(actor, 'select|single', 'Choose a target for attack', 'card', internal(target.n), choices.length);
                    }
                    if (u.d === 0 && rng() < 0.15) {
                        u.u = [...(u.u ?? []), { n: 'Experience', s: null, t: 1 }];
                        u.p++;
                        u.h++;
                    }
                    checkWin();
                }
            }
            actor = other(actor);
        }
        if (winner || n >= stopAt) {
            break;
        }
        // regroup: draw two, resource one, ready everything
        phase = 'regroup';
        for (const pid of [initiative, other(initiative)]) {
            const p = P[pid];
            for (let k = 0; k < 2; k++) {
                if (p.deck.length) {
                    p.hand.push(p.deck.shift());
                } else {
                    p.base.d = Math.min(p.base.hp, p.base.d + 3);
                }
            }
            if (checkWin()) {
                break;
            }
            const wantRes = p.hand.length && (smart(pid) ? p.res.total < 8 : rng() < 0.75);
            if (wantRes) {
                const c = smart(pid) ? [...p.hand].sort((a, b) => b.cost - a.cost)[0] : pick(p.hand);
                p.hand.splice(p.hand.indexOf(c), 1);
                p.res.total++;
                step(pid, 'select|single', 'Select a card to resource', 'card', internal(c.n), p.hand.length + 2);
            } else {
                step(pid, 'select|single', 'Select a card to resource', 'button', 'Done', p.hand.length + 1);
            }
        }
        for (const pid of ['p1', 'p2']) {
            const p = P[pid];
            p.res.ready = p.res.total;
            p.leader.x = 0;
            for (const u of allUnits(p)) {
                u.x = 0;
            }
        }
        if (winner) {
            break;
        }
        round++;
    }
    if (n >= stopAt) {
        return { events, running: true, round, steps: n };
    }
    if (!winner) {
        winner = P.p1.base.hp - P.p1.base.d >= P.p2.base.hp - P.p2.base.d ? 'p1' : 'p2';
        P[other(winner)].base.d = P[other(winner)].base.hp;
        step(winner, 'actionWindow|-', 'Choose an action', 'button', 'Pass', 1);
    }
    events.push({ t: 'end', winner, round, steps: n, outcome: 'won', error: null });
    return { events, winner, round, steps: n };
}

function tournament(id, bots, perPair, firstSeed, createdAt, { runningLast = false } = {}) {
    const dir = path.join(OUT, id, 'games');
    fs.rmSync(path.join(OUT, id), { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const index = { id, createdAt, engine: 'fixture', bots, gamesPerPairing: perPair, games: [] };
    let seed = firstSeed;
    const pairs = [];
    for (let a = 0; a < bots.length; a++) {
        for (let b = a + 1; b < bots.length; b++) {
            for (let k = 0; k < perPair; k++) {
                pairs.push(k % 2 ? [bots[b], bots[a]] : [bots[a], bots[b]]);
            }
        }
    }
    pairs.forEach((seats, i) => {
        const gid = `${seats[0]}-vs-${seats[1]}-${seed}`;
        const last = runningLast && i === pairs.length - 1;
        const r = playGame({ seed, bots: seats, stopAt: last ? 55 : Infinity });
        fs.writeFileSync(path.join(dir, `${gid}.jsonl`), r.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
        const winnerBot = r.winner === 'p1' ? seats[0] : r.winner === 'p2' ? seats[1] : null;
        index.games.push({
            id: gid, seed, p1: seats[0], p2: seats[1], winner: winnerBot, winnerSeat: r.winner ?? null,
            rounds: r.round, steps: r.steps, outcome: r.running ? 'running' : 'won', error: null, ms: Math.round(r.steps * (4 + (seed % 5)))
        });
        seed++;
    });
    fs.writeFileSync(path.join(OUT, id, 'index.json'), JSON.stringify(index));
    console.log(`${id}: ${index.games.length} games`);
}

tournament('ladder-fixture', ['random-a', 'random-b', 'heuristic', 'aggro'], 3, 101, '2026-10-11T05:40:00.000Z', { runningLast: true });
tournament('demo-fixture', ['random-a', 'random-b', 'random-c'], 2, 1, '2026-10-10T21:15:00.000Z');
