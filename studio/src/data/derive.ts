import type { Game, PlayerSnap, Seat, Snapshot } from './types';
import { estimateLens, LENS_SCALE, OMNI_WEIGHTS, type LensStep, type TermKey } from './lens';

export const SEATS: Seat[] = ['p1', 'p2'];
export const other = (s: Seat): Seat => (s === 'p1' ? 'p2' : 'p1');
type Arena = 'ground' | 'space';
const ARENAS: Arena[] = ['ground', 'space'];

/**
 * Snapshots carry no card ids, so units are matched from one step to the next by name (keeping order), which gives
 * each unit on the board a stable key for enter/exit animation and damage pop-ups.
 * ids[step][seat][arena][i] is the id of state.players[seat][arena][i].
 */
export type UnitIds = Record<Seat, Record<Arena, string[]>>[];

export function trackUnits(game: Game): UnitIds {
    let next = 0;
    const out: UnitIds = [];
    let prev: Record<Seat, Record<Arena, { n: string; id: string }[]>> | null = null;
    for (const step of game.steps) {
        const cur = { p1: { ground: [] as string[], space: [] as string[] }, p2: { ground: [] as string[], space: [] as string[] } };
        const keep = { p1: { ground: [] as { n: string; id: string }[], space: [] as { n: string; id: string }[] }, p2: { ground: [] as { n: string; id: string }[], space: [] as { n: string; id: string }[] } };
        for (const seat of SEATS) {
            for (const arena of ARENAS) {
                const pool = prev ? [...prev[seat][arena]] : [];
                for (const u of step.state.players[seat][arena]) {
                    const i = pool.findIndex((p) => p.n === u.n);
                    const id = i >= 0 ? pool.splice(i, 1)[0].id : `u${next++}`;
                    cur[seat][arena].push(id);
                    keep[seat][arena].push({ n: u.n, id });
                }
            }
        }
        out.push(cur);
        prev = keep;
    }
    return out;
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const units = (p: PlayerSnap) => [...p.ground, ...p.space];

export interface Metrics {
    step: number;
    round: number;
    base1: number;
    base2: number;
    power1: number;
    power2: number;
    hand1: number;
    hand2: number;
    res1: number;
    res2: number;
    /** p1's edge in the omni bot's board score, squashed to -1..1 (see edgeTerms). */
    edge: number;
    /** the same edge in points (p1 total - p2 total), unsquashed */
    score: number;
}

export interface EdgeTerm {
    key: TermKey;
    label: string;
    /** each side's points for this term (good for that side) */
    p1: number;
    p2: number;
    /** p1 - p2: points toward p1 (negative = toward p2) */
    points: number;
    /** what each side's points are made of, e.g. "3 units" */
    what: Record<Seat, string>;
    /** the rule in a few words, shown under the row */
    rule: string;
    /** the rule in full (tooltip) */
    how: string;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The board read the way the omniscient bot scores it at its search leaves (bot/omni, same weights as the heuristic
 * bot): each side's base, units, hand, resources and initiative in points, and p1's edge = p1 total - p2 total,
 * squashed to -1..1 with tanh(edge / 25) for the curves. With the game's lens file the values are the bot's own;
 * without it they are computed here and leave out card cost, which replays don't record.
 */
export function edgeTerms(s: Snapshot, lens?: LensStep | null): { terms: EdgeTerm[]; sum: number; edge: number; exact: boolean } {
    const v = lens ?? estimateLens(s);
    const w = OMNI_WEIGHTS;
    const { p1, p2 } = s.players;
    const hp = (p: PlayerSnap) => Math.max(0, p.base.hp - p.base.d);
    const t = (key: EdgeTerm['key'], label: string, a: number, b: number, what: Record<Seat, string>, rule: string, how: string): EdgeTerm =>
        ({ key, label, p1: Math.round(a * 10) / 10, p2: Math.round(b * 10) / 10, points: a - b, what, rule, how });
    const unitRule = `power × ${w.power} + HP × ${w.hp} + cost × ${w.cost} + upgrades, × ${w.exhaustedMult} if exhausted`;
    const unitHow = `per unit: power × ${w.power} + HP left × ${w.hp} + cost × ${w.cost} + ${w.shield} per Shield + ${w.upgrade} per other upgrade + ${w.sentinel} if Sentinel, all × ${w.exhaustedMult} if exhausted`;
    const terms: EdgeTerm[] = [
        t('base', 'Base', v.p1.base, v.p2.base, { p1: `${hp(p1)} HP`, p2: `${hp(p2)} HP` }, `${w.baseMult} × (${w.baseHp} per HP left − (12 − HP)² / 6 under 12)`, `${w.baseMult} × (${w.baseHp} per HP left, minus (12 − HP)² / 6 when 12 HP or less, so a base near 0 HP falls fast)`),
        t('ground', 'Ground units', sum(v.p1.ground), sum(v.p2.ground), { p1: count(p1.ground.length, 'unit'), p2: count(p2.ground.length, 'unit') }, unitRule, unitHow),
        t('space', 'Space units', sum(v.p1.space), sum(v.p2.space), { p1: count(p1.space.length, 'unit'), p2: count(p2.space.length, 'unit') }, unitRule, unitHow),
        t('hand', 'Hand', sum(v.p1.hand), sum(v.p2.hand), { p1: count(p1.hand.length, 'card'), p2: count(p2.hand.length, 'card') }, `${w.hand} per card`, `${w.hand} per card in hand`),
        t('resources', 'Resources', v.p1.resources, v.p2.resources, { p1: count(p1.res.total, 'resource'), p2: count(p2.res.total, 'resource') }, `${w.resource} per resource`, `${w.resource} per resource, ready or not`),
        t('initiative', 'Initiative', v.p1.initiative, v.p2.initiative, { p1: s.initiative === 'p1' ? 'has it' : 'no', p2: s.initiative === 'p2' ? 'has it' : 'no' }, `${w.initiative} for whoever holds it`, `${w.initiative} for the player holding the initiative`)
    ];
    const total = v.p1.total - v.p2.total;
    return { terms, sum: total, edge: Math.tanh(total / LENS_SCALE), exact: !!lens };
}

export const materialEdge = (s: Snapshot) => edgeTerms(s).edge;

/** Per-step series for the curves; `lensSteps` (lensByIndex) makes the edge the omni bot's own where the game has a lens file. */
export function metrics(game: Game, lensSteps?: Map<number, LensStep>): Metrics[] {
    return game.steps.map((st, i) => {
        const { p1, p2 } = st.state.players;
        return {
            step: i,
            round: st.state.round,
            base1: Math.max(0, p1.base.hp - p1.base.d),
            base2: Math.max(0, p2.base.hp - p2.base.d),
            power1: sum(units(p1).map((u) => u.p)),
            power2: sum(units(p2).map((u) => u.p)),
            hand1: p1.hand.length,
            hand2: p2.hand.length,
            res1: p1.res.total,
            res2: p2.res.total,
            ...(({ edge, sum: score }) => ({ edge, score }))(edgeTerms(st.state, lensSteps?.get(i) ?? null))
        };
    });
}

export interface Delta {
    /** the side it happened on: for 'steal', the side the unit went over to */
    seat: Seat;
    kind: 'enter' | 'defeat' | 'base' | 'heal' | 'deploy' | 'flip' | 'steal' | 'bounce' | 'resource';
    text: string;
}

/**
 * What visibly changed between two consecutive snapshots, for the log and the board's pop-ups. Units are matched by
 * name: one that leaves a side while a same-named unit arrives on the other changed control ('steal'), one whose name
 * turns up in a hand was returned ('bounce'). A leader whose unit enters an arena deploys; one that only changes face flips.
 */
export function deltas(a: Snapshot, b: Snapshot): Delta[] {
    const out: Delta[] = [];
    const names = (p: PlayerSnap) => units(p).map((u) => u.n);
    const gone = {} as Record<Seat, string[]>;
    const came = {} as Record<Seat, string[]>;
    for (const seat of SEATS) {
        const rest = names(b.players[seat]);
        gone[seat] = names(a.players[seat]).filter((n) => {
            const i = rest.indexOf(n);
            return i >= 0 ? (rest.splice(i, 1), false) : true;
        });
        came[seat] = rest;
    }
    // control changes, before anything is read as a defeat or an arrival
    const stolen: Delta[] = [];
    for (const seat of SEATS) {
        gone[seat] = gone[seat].filter((n) => {
            const i = came[other(seat)].indexOf(n);
            if (i < 0) {
                return true;
            }
            came[other(seat)].splice(i, 1);
            stolen.push({ seat: other(seat), kind: 'steal', text: `${n} changes sides` });
            return false;
        });
    }
    const inHands = (s: Snapshot, n: string) => SEATS.reduce((k, seat) => k + s.players[seat].hand.filter((c) => c.n === n).length, 0);
    for (const seat of SEATS) {
        const pa = a.players[seat];
        const pb = b.players[seat];
        const dmg = pb.base.d - pa.base.d;
        if (dmg > 0) {
            out.push({ seat, kind: 'base', text: `${pb.base.n} takes ${dmg}` });
        } else if (dmg < 0) {
            out.push({ seat, kind: 'heal', text: `${pb.base.n} heals ${-dmg}` });
        }
        if (pb.leader && pa.leader && ((pb.leader.dep && !pa.leader.dep) || pb.leader.n !== pa.leader.n)) {
            const i = came[seat].indexOf(pb.leader.n);
            const ups = (p: PlayerSnap) => units(p).flatMap((u) => u.u ?? []).filter((u) => u.n === pb.leader!.n).length;
            if (pb.leader.dep && i >= 0) {
                came[seat].splice(i, 1);
                out.push({ seat, kind: 'deploy', text: `${pb.leader.n.split(',')[0]} deploys` });
            } else if (pb.leader.dep && ups(pb) > ups(pa)) {
                out.push({ seat, kind: 'deploy', text: `${pb.leader.n.split(',')[0]} deploys as a pilot` });
            } else {
                out.push({ seat, kind: 'flip', text: pb.leader.n !== pa.leader.n ? `${pa.leader.n} flips to ${pb.leader.n}` : `${pb.leader.n} flips` });
            }
        }
        for (const n of gone[seat]) {
            // more copies of it in the hands than before (and than bounces already counted): it went back to a hand
            const back = inHands(b, n) - inHands(a, n) - out.filter((d) => d.kind === 'bounce' && d.text === `${n} returns to hand`).length;
            out.push(back > 0 ? { seat, kind: 'bounce', text: `${n} returns to hand` } : { seat, kind: 'defeat', text: `${n} defeated` });
        }
        out.push(...stolen.filter((d) => d.seat === seat));
        for (const n of came[seat]) {
            out.push({ seat, kind: 'enter', text: `${n} enters` });
        }
        if (pb.res.total > pa.res.total) {
            out.push({ seat, kind: 'resource', text: `resource ${pb.res.total}` });
        }
    }
    return out;
}

/** Index of the first step of each round, for chart bands and the scrubber. */
export function roundStarts(game: Game): { step: number; round: number }[] {
    const out: { step: number; round: number }[] = [];
    let r = -1;
    game.steps.forEach((s, i) => {
        if (s.state.round !== r) {
            r = s.state.round;
            out.push({ step: i, round: r });
        }
    });
    return out;
}
