import type { Game, PlayerSnap, Seat, Snapshot, UnitRef } from './types';

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
const hpLeft = (u: UnitRef) => Math.max(0, u.h - u.d);

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
    /** p1's edge from the board alone, -1..1 (see materialEdge). */
    edge: number;
}

/**
 * A deliberately simple read of the board, from p1's side: base HP race, board power and toughness, cards and
 * resources, squashed to -1..1. It is a placeholder lane for the real evaluators (heuristic bots, LLM analysis).
 */
export function materialEdge(s: Snapshot): number {
    const v = (p: PlayerSnap) => {
        const myBase = p.base.hp - p.base.d;
        const urgency = Math.max(0, 12 - myBase) ** 2 / 8;
        return myBase * 0.6 - urgency + sum(units(p).map((u) => u.p * 1.2 + hpLeft(u) * 0.7)) + p.hand.length * 1.5 + p.res.total * 1.1;
    };
    const d = v(s.players.p1) - v(s.players.p2);
    return Math.tanh(d / 18);
}

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
            res2: p2.res.total,
            edge: materialEdge(st.state)
        };
    });
}

export interface Delta {
    seat: Seat;
    kind: 'enter' | 'defeat' | 'base' | 'heal' | 'deploy' | 'resource';
    text: string;
}

/** What visibly changed between two consecutive snapshots, for the log and the board's pop-ups. */
export function deltas(a: Snapshot, b: Snapshot): Delta[] {
    const out: Delta[] = [];
    for (const seat of SEATS) {
        const pa = a.players[seat];
        const pb = b.players[seat];
        const dmg = pb.base.d - pa.base.d;
        if (dmg > 0) {
            out.push({ seat, kind: 'base', text: `${pb.base.n} takes ${dmg}` });
        } else if (dmg < 0) {
            out.push({ seat, kind: 'heal', text: `${pb.base.n} heals ${-dmg}` });
        }
        if (pb.leader?.dep && !pa.leader?.dep) {
            out.push({ seat, kind: 'deploy', text: `${pb.leader.n.split(',')[0]} deploys` });
        }
        const before = units(pa).map((u) => u.n);
        const after = units(pb).map((u) => u.n);
        const rest = [...after];
        for (const n of before) {
            const i = rest.indexOf(n);
            if (i >= 0) {
                rest.splice(i, 1);
            } else {
                out.push({ seat, kind: 'defeat', text: `${n} defeated` });
            }
        }
        for (const n of rest) {
            if (!(pb.leader?.dep && !pa.leader?.dep && n === pb.leader.n)) {
                out.push({ seat, kind: 'enter', text: `${n} enters` });
            }
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
