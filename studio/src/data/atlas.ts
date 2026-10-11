// Strategy Atlas spots on a replay: which of the Atlas's game situations ("Board behind", "Near death", ...) hold for each
// seat at a step, and where in a game each one starts. The rules, words and icons all come from the Atlas kit
// (meta/atlas-kit.js, owned by the meta analyzer); nothing here re-implements a spot.
import bundled from 'virtual:atlas-kit';
import type { Game, Seat, Snapshot } from './types';

export type SpotGroup = 'Behind' | 'Even' | 'Ahead';

/** One spot as the kit describes it (AtlasKit.SPOT[id]). */
export interface AtlasSpot {
    id: string;
    group: SpotGroup;
    label: string;
    short: string;
    rule: string;
    say: string;
}

/** The parts of the Atlas kit the viewer uses. */
export interface AtlasKitApi {
    SPOTS: AtlasSpot[];
    SPOT: Record<string, AtlasSpot>;
    GROUP: Record<string, string>;
    TOKENS: { light: Record<string, string>; dark: Record<string, string> };
    spotsAt(state: Snapshot, pid: Seat): string[];
    spotSvg(id: string, opts?: { mini?: boolean; cls?: string; label?: boolean }): string;
    css(opts?: { base?: boolean; scope?: string }): string;
}

const isKit = (k: unknown): k is AtlasKitApi => !!k && typeof (k as AtlasKitApi).spotsAt === 'function' && typeof (k as AtlasKitApi).spotSvg === 'function' && !!(k as AtlasKitApi).SPOT;

/**
 * The Atlas kit: the one the host page loaded (window.AtlasKit, refreshed with the Atlas every hour), else the copy
 * built into the viewer; null when neither is there (then no spots are drawn).
 */
export function atlasKit(): AtlasKitApi | null {
    const host = typeof window !== 'undefined' ? (window as { AtlasKit?: unknown }).AtlasKit : undefined;
    return isKit(host) ? host : isKit(bundled) ? bundled : null;
}

export type SeatSpots = Record<Seat, string[]>;
const NONE: SeatSpots = { p1: [], p2: [] };

/** The spot ids that hold for each seat in a snapshot, read from that seat's side (so one seat's Board behind is the other's Board ahead). */
export function spotsOf(state: Snapshot, kit: AtlasKitApi | null = atlasKit()): SeatSpots {
    if (!kit) {
        return NONE;
    }
    return { p1: kit.spotsAt(state, 'p1'), p2: kit.spotsAt(state, 'p2') };
}

/** A spot holding at a round start the Atlas reads (the first action step of a round, as in meta/analyze.js) that didn't at the one before. */
export interface SpotStart {
    seat: Seat;
    id: string;
    /** step index */
    i: number;
    round: number;
    /** true where the Atlas counts this game in the spot: the first round start where it holds */
    atlas: boolean;
}

export interface SpotTimeline {
    /** per step index, the spots holding for each seat */
    at: SeatSpots[];
    /** runs of each spot per seat, as step index ranges (inclusive) */
    runs: { seat: Seat; id: string; from: number; to: number }[];
    /** the round starts where a spot holds that didn't at the previous round start, per seat */
    starts: SpotStart[];
}

const cache = new WeakMap<Game, { kit: AtlasKitApi; tl: SpotTimeline }>();

/** Spots over a whole game, for the timeline's spot lanes. Null without a kit. */
export function spotTimeline(game: Game, kit: AtlasKitApi | null = atlasKit()): SpotTimeline | null {
    if (!kit) {
        return null;
    }
    const hit = cache.get(game);
    if (hit && hit.kit === kit) {
        return hit.tl;
    }
    const at = game.steps.map((s) => spotsOf(s.state, kit));
    const runs: SpotTimeline['runs'] = [];
    const starts: SpotStart[] = [];
    for (const seat of ['p1', 'p2'] as Seat[]) {
        const open = new Map<string, { seat: Seat; id: string; from: number; to: number }>();
        at.forEach((sp, i) => {
            for (const id of sp[seat]) {
                const run = open.get(id);
                if (run && run.to === i - 1) {
                    run.to = i;
                } else {
                    const r = { seat, id, from: i, to: i };
                    open.set(id, r);
                    runs.push(r);
                }
            }
        });
        // the Atlas reads one snapshot per round: the first action step of each new round
        let lastRound = -Infinity;
        let before = new Set<string>();
        const counted = new Set<string>();
        game.steps.forEach((s, i) => {
            if (s.state.phase !== 'action' || s.state.round <= lastRound) {
                return;
            }
            lastRound = s.state.round;
            const now = at[i][seat];
            for (const id of now) {
                if (!before.has(id)) {
                    starts.push({ seat, id, i, round: s.state.round, atlas: !counted.has(id) });
                    counted.add(id);
                }
            }
            before = new Set(now);
        });
    }
    runs.sort((a, b) => a.from - b.from);
    starts.sort((a, b) => a.i - b.i);
    const tl = { at, runs, starts };
    cache.set(game, { kit, tl });
    return tl;
}

/** A group's colour: the Atlas's dark-theme tokens (Behind = its red, Ahead = its blue, Even = its grey ink). */
export function groupColor(kit: AtlasKitApi, group: SpotGroup): string {
    const t = kit.TOKENS.dark;
    return group === 'Behind' ? t['--neg-4'] : group === 'Ahead' ? t['--pos-4'] : t['--ink-2'];
}

/** CSS custom properties the kit's inline icons read, set on the element that holds them (the viewer is always dark). */
export function iconVars(kit: AtlasKitApi): Record<string, string> {
    return { ...kit.TOKENS.dark };
}
