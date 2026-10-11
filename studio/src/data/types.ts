// Replay format, copied unchanged from viewer/src/core/types.ts (written by bot/recorder.js and bot/tournament.js).
// Keep the two in sync: Holotable reads the same files as the original viewer and adds nothing to them.

export type Seat = 'p1' | 'p2';

export interface CardRef { n: string; s: string | null }
export interface UpgradeRef extends CardRef { t: 0 | 1 }
export interface UnitRef extends CardRef { p: number; h: number; d: number; x?: 1; sn?: 1; u?: UpgradeRef[] }
export interface LeaderRef extends CardRef { dep: 0 | 1; x: 0 | 1 }
export interface BaseRef extends CardRef { hp: number; d: number }

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
    action?: { kind: string; label: string };
    legal?: number;
    label?: string;
    state: Snapshot;
}

export interface Header {
    t: 'header';
    v: number;
    seed: number;
    engine: string | null;
    players: { id: Seat; bot: string; deck: string }[];
}

export interface End {
    t: 'end';
    winner: Seat | 'draw' | null;
    round: number;
    steps: number;
    outcome: string;
    error: string | null;
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
