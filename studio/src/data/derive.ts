import type { CardRef, Game, PlayerSnap, Seat, Snapshot } from './types';
import type { LensStep } from './lensFile';
import { rowFacts, rowValue, scoreOfBoard } from './score';

export const SEATS: Seat[] = ['p1', 'p2'];
export const other = (s: Seat): Seat => (s === 'p1' ? 'p2' : 'p1');
type Arena = 'ground' | 'space';
const ARENAS: Arena[] = ['ground', 'space'];

/**
 * A stable key per unit on the board, for enter/exit animation and damage pop-ups: the card's id when the replay has
 * one (v2), else units are matched from one step to the next by name (keeping order).
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
                    const i = u.id ? -1 : pool.findIndex((p) => p.n === u.n);
                    const id = u.id ? `#${u.id}` : i >= 0 ? pool.splice(i, 1)[0].id : `u${next++}`;
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

/** The card with this id (v2) anywhere on a board: bases, leaders, units, upgrades, captured cards, hands, discards. */
export function cardById(s: Snapshot, id: string): CardRef | null {
    for (const seat of SEATS) {
        const p = s.players[seat];
        const units = [...p.ground, ...p.space];
        const all: (CardRef | null)[] = [p.base, p.leader, ...units, ...units.flatMap((u) => [...(u.u ?? []), ...(u.cap ?? [])]), ...p.hand, ...p.discard];
        const c = all.find((x) => x?.id === id);
        if (c) {
            return c;
        }
    }
    return null;
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const units = (p: PlayerSnap) => [...p.ground, ...p.space];

/** Board facts per step, for the curves. The score is not here: it comes from the resolved series (score.ts). */
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
}

/** @deprecated one row of a score's breakdown; read rows from the series (score.ts rowsAt / rowValue) */
export interface EdgeTerm {
    /** the row: 'base', 'ground', 'space', 'hand', 'resources', 'initiative', or a row id of another source */
    key: string;
    label: string;
    /** each side's value for this row (good for that side), to 1 decimal */
    p1: number;
    p2: number;
    /** p1 - p2: toward p1 (negative = toward p2) */
    points: number;
    /** what each side's value is made of, e.g. "3 units" */
    what: Record<Seat, string>;
    /** the rule in a few words, shown under the row */
    rule: string;
    /** the rule in full (tooltip) */
    how: string;
}

/**
 * @deprecated The Omni v1 breakdown of one board, from a lens step or (without one) the estimate: the rows, the edge
 * in points (`sum`), the edge as 2·chance − 1 with the rough map (`edge`, -1..1) and whether the values came from a
 * file. Use the series (score.ts) instead.
 */
export function edgeTerms(s: Snapshot, lens?: LensStep | null): { terms: EdgeTerm[]; sum: number; edge: number; exact: boolean } {
    let v = lens ? scoreOfBoard(s, lens, { bareAs: 'omni-v1' }) : null;
    // no step, or one that doesn't fit this board: the estimate, not exact (as lensAt does)
    const exact = !!v?.step.seats;
    if (!exact) {
        v = scoreOfBoard(s, true);
    }
    const seats = v?.step.seats;
    if (!v || !seats) {
        return { terms: [], sum: 0, edge: 0, exact: false };
    }
    const { source, step } = v;
    const terms = source.rows.filter((r) => r.group !== 'joint').map((r): EdgeTerm => {
        const val = rowValue(r, step);
        return {
            key: r.group === 'side' ? r.key : r.id, label: r.label,
            p1: Math.round((val.p1 ?? 0) * 10) / 10, p2: Math.round((val.p2 ?? 0) * 10) / 10, points: val.edge,
            what: rowFacts(r, s) ?? { p1: '', p2: '' }, rule: r.rule(step.weights), how: r.how(step.weights)
        };
    });
    const total = (seats.p1.total ?? 0) - (seats.p2.total ?? 0);
    return { terms, sum: total, edge: 2 * (step.p1Win ?? 0.5) - 1, exact };
}

/** Per-step board facts for the curves. */
export function metrics(game: Game): Metrics[] {
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
            res2: p2.res.total
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
    // v2: cards held captured under units
    const captured = (s: Snapshot, n: string) => SEATS.reduce((k, seat) => k + units(s.players[seat]).reduce((j, u) => j + (u.cap ?? []).filter((c) => c.n === n).length, 0), 0);
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
            const taken = captured(b, n) - captured(a, n) - out.filter((d) => d.kind === 'defeat' && d.text === `${n} captured`).length;
            out.push(back > 0 ? { seat, kind: 'bounce', text: `${n} returns to hand` } : { seat, kind: 'defeat', text: taken > 0 ? `${n} captured` : `${n} defeated` });
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
