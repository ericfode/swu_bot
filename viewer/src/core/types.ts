export type Seat = 'p1' | 'p2';

/** `id` (engine card id, stable for the game) is in replays written since protocol v2. */
export interface CardRef { id?: string; n: string; s: string | null }
export interface UpgradeRef extends CardRef { t: 0 | 1 }
export interface UnitRef extends CardRef { p: number; h: number; d: number; x?: 1; sn?: 1; u?: UpgradeRef[]; cap?: CardRef[] }
export interface LeaderRef extends CardRef { dep: 0 | 1; x: 0 | 1 }
export interface BaseRef extends CardRef { hp: number; d: number }

export interface PlayerSnap {
    name: string;
    base: BaseRef;
    leader: LeaderRef | null;
    res: { ready: number; total: number };
    handCount?: number;
    force?: 1;
    credits?: number;
    hand: CardRef[];
    deck: number;
    discard: CardRef[];
    ground: UnitRef[];
    space: UnitRef[];
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
    players: { id: Seat; bot: string; deck: string; lang?: string }[];
    decks?: Record<Seat, DeckList>;
}

export interface DeckList {
    metadata: { name: string; author: string };
    leader: { id: string; count: number };
    base: { id: string; count: number };
    deck: { id: string; count: number }[];
}

export interface End {
    t: 'end';
    winner: Seat | 'draw' | null;
    round: number;
    steps: number;
    outcome: string;
    error: string | null;
    by?: Seat | null;
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
    by?: Seat | null;
    ms: number;
    timing?: Record<Seat, Timing>;
}

/** Harness-measured decision times in ms: count, total, median, 95th percentile, max. */
export interface Timing { n: number; ms: number; p50: number; p95: number; max: number }

export interface TournamentIndex {
    id: string;
    createdAt: string;
    engine: string | null;
    bots: string[];
    gamesPerPairing: number;
    games: IndexGame[];
    key?: string | null;
}

export interface TournamentSummary {
    id: string;
    createdAt: string;
    engine: string | null;
    bots: string[];
    games: number;
}
