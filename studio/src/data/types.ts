// Replay format, from viewer/src/core/types.ts (written by bot/recorder.js and bot/tournament.js), plus the optional
// protocol v2 fields (spec/replay-format.md, marked "v2"): header.v stays 1 and older files simply lack them.
// Holotable reads the same files as the original viewer and adds nothing to them.

export type Seat = 'p1' | 'p2';

/** v2: `id` is the card's id ("c41"), stable for the whole game (older files have none) */
export interface CardRef { n: string; s: string | null; id?: string }
export interface UpgradeRef extends CardRef { t: 0 | 1 }
/** v2: `cap` lists the cards this unit has captured (open information) */
export interface UnitRef extends CardRef { p: number; h: number; d: number; x?: 1; sn?: 1; u?: UpgradeRef[]; cap?: CardRef[] }
/** v2: `epic: 1` once the leader's deploy (its epic action) is used */
export interface LeaderRef extends CardRef { dep: 0 | 1; x: 0 | 1; epic?: 1 }
/** v2: `epic: 1` once the base's epic action is used */
export interface BaseRef extends CardRef { hp: number; d: number; epic?: 1 }

export interface PlayerSnap {
    name: string;
    base: BaseRef;
    leader: LeaderRef | null;
    res: { ready: number; total: number };
    hand: CardRef[];
    deck: number;
    discard: CardRef[];
    ground: UnitRef[];
    space: UnitRef[];
    /** v2: cards in hand (the hand is still listed) */
    handCount?: number;
    /** v2: 1 when the player has the Force token; credit tokens. Both absent when zero */
    force?: 1;
    credits?: number;
    /** v2, action phase only: passed its last action; done for the phase (claimed the initiative, or both passed) */
    passed?: 1;
    out?: 1;
}

export interface Snapshot {
    round: number;
    phase: string;
    initiative: Seat | null;
    players: Record<Seat, PlayerSnap>;
}

export interface Step {
    t: 'step';
    n: number;
    pid?: Seat;
    prompt?: string;
    title?: string | null;
    /** v2 adds `i` (its index among the legal actions), `id` (the card it acts on) and `split` (a distribute action's amounts) */
    action?: { kind: string; label: string; i?: number; id?: string; split?: { id: string; amount: number }[] };
    legal?: number;
    label?: string;
    state: Snapshot;
}

export interface Header {
    t: 'header';
    v: number;
    seed: number;
    engine: string | null;
    /** v2: `lang`, the bot program's language when it declares one */
    players: { id: Seat; bot: string; deck: string; lang?: string }[];
    /** v2: both full deck lists */
    decks?: Partial<Record<Seat, DeckList>>;
}

/** A deck list as Env.newGame takes it (cards by set code). */
export interface DeckList {
    metadata?: { name?: string; author?: string };
    leader: { id: string; count: number };
    base: { id: string; count: number };
    deck: { id: string; count: number }[];
    isPresentInDb?: boolean;
}

export interface End {
    t: 'end';
    winner: Seat | 'draw' | null;
    round: number;
    steps: number;
    outcome: string;
    error: string | null;
    /** v2: for an ERROR, the seat whose bot caused it (it loses), or null (engine or referee: no result) */
    by?: Seat | null;
    key?: string;
}

export interface Game {
    header: Header;
    steps: Step[];
    end: End | null;
}

export interface IndexGame {
    id: string;
    seed: number;
    p1: string;
    p2: string;
    winner: string | null;
    winnerSeat: Seat | 'draw' | null;
    rounds: number;
    steps: number;
    outcome: string;
    error: string | null;
    ms: number;
    /** v2: as End.by */
    by?: Seat | null;
    /** v2: per seat decision times, in ms, measured by the referee */
    timing?: Partial<Record<Seat, SeatTiming>>;
    key?: string;
}

export interface SeatTiming {
    /** decisions, total ms, and per decision p50 / p95 / max */
    n: number;
    ms: number;
    p50: number;
    p95: number;
    max: number;
}

export interface TournamentIndex {
    id: string;
    createdAt: string;
    engine: string | null;
    bots: string[];
    gamesPerPairing: number;
    games: IndexGame[];
}

export interface TournamentSummary {
    id: string;
    createdAt: string;
    engine: string | null;
    bots: string[];
    games: number;
}
