// Replay fields as spec/replay-format.md defines them (written by bot/recorder.js and bot/tournament.js).
// Optional presentation statuses are used by explicit staged examples; recorded snapshots stay unchanged.

export type Seat = 'p1' | 'p2';

export interface CardRef { id?: string; n: string; s: string | null; owner?: Seat }
export interface UpgradeRef extends CardRef { unitUpgrade?:boolean; traits?:string[]; t: 0 | 1; controller?: Seat; /** Explicit staged stat contributions, when known. */ p?: number; h?: number }
export interface ResourceRef extends CardRef { x?: 1 }
/** Explicit presentation statuses in staged examples; never inferred into a recorded snapshot. */
export type GrantedDefeatAbility = { id: string; sourceId: string; subjectId: string; incarnation: string; round: number; phase: string } & ({ effect: 'damage-enemy-unit'; amount: 2 } | { effect: 'create-clone'; amount: 1 });
export interface DefenseModifier { attackerPower: -4; sourceId: string; round: number; phase: string; incarnation: string }
export interface OnAttackAbilityRef {id:string;sourceId:string;subjectId:string;incarnation:string;origin:'native'|'granted';effect:'firespray-indirect'|'trench-cost-difference'|'unsupported';round?:number;phase?:string;requiresTrait?:string}
export interface UnitStatus {
    generatedSentinel?: {id:string;sourceId:string;subjectId:string;incarnation:string;round:number;phase:string};

    attachmentId?:string;
    generatedRestriction?: {id:string;sourceId:string;subjectId:string;incarnation:string;round:number;phase:string};
    titleBoost?: {id:string;sourceId:string;subjectId:string;incarnation:string;round:number;phase:string;amount:number};

    lostKeyword?: 'Saboteur';
    keywordWindow?: KeywordWindowMark;
    grantedAbility?: GrantedDefeatAbility;
    phase?: string;
    defenseModifier?: DefenseModifier;
    kind: 'suppressed' | 'buff' | 'debuff' | 'control' | 'delay' | 'keyword' | 'restrict';
    label: string;
    duration: 'phase' | 'attack' | 'regroup' | 'round' | 'permanent' | 'next-action';
    keyword?: { name: 'Raid' | 'Saboteur' | 'Ambush' | 'Sentinel' | 'Restore' | 'Grit' | 'Overwhelm'; amount: number };
    restriction?: 'cannot-ready' | 'must-attack' | 'cannot-attack-base'; round?: number; incarnation?: string; actionConstraintId?: string;
}
export interface UnitRef extends CardRef { onAttackAbilities?:OnAttackAbilityRef[]; printedTitle?: string; unique?: boolean; leaderUnit?: boolean; traits?: string[]; t?: 1; p: number; h: number; d: number; x?: 1; sn?: 1; u?: UpgradeRef[]; cap?: CardRef[]; status?: UnitStatus[]; incarnation?: string }
/** Staged obligations only. Recorded snapshots are never assigned inferred future consequences. */
export interface PendingEffect {
    id: string;
    sourceId: string;
    targetId: string;
    incarnation: string;
    trigger: 'regroup-start' | 'phase-end';
    kind: 'return-control' | 'defeat' | 'return-to-hand';
    returnController?: Seat;
}
export interface LeaderRef extends CardRef { dep: 0 | 1; x: 0 | 1; epic?: 1 }
export interface BaseDamageProtection { id:string; sourceId:string; baseId:string; seat:Seat; round:number; phase:string; uses:1 }
export interface KeywordWindowMark { id:string; sourceId:string; subjectId:string; incarnation:string; round:number; phase:string; nativeSentinel:boolean }
export interface BaseRef extends CardRef { hp: number; d: number; epic?: 1; damageProtection?:BaseDamageProtection[] }

export interface PlayerSnap {
    name: string;
    base: BaseRef;
    leader: LeaderRef | null;
    res: { ready: number; total: number };
    resources?: ResourceRef[];
    hand: CardRef[];
    deck: number;
    /** Optional complete, explicit staged deck. Absence preserves hidden information in recordings. */
    knownDeck?: CardRef[];
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

export interface NextActionConstraint {
    id: string; sourceId: string; subjectId: string; incarnation: string;
    controller: Seat; round: number; phase: string; targetUnitIfAble: true;
}
export interface PendingPlayerEffect { id: string; sourceId: string; player: Seat; trigger: 'regroup-start'; kind: 'lose-game' }
export interface StagedMatchResult { winner: Seat | 'draw'; loser?: Seat; reason: 'card-effect'; sourceId: string }
export interface PhaseDiscardPlayPermission { id:string; sourceId:string; cardId:string; player:Seat; round:number; phase:string; fromZone:'discard'; discount:2; cardType:'event'|'upgrade'; aspects:string[] }
export interface Snapshot {
    discardPlayPermissions?: PhaseDiscardPlayPermission[];
    enteredThisPhase?: { round: number; phase: string; units: { id: string; incarnation: string; entryType: 'played' | 'created' | 'rescued' | 'deployed' }[] };
    pendingPlayers?: PendingPlayerEffect[];
    matchResult?: StagedMatchResult;
    nextActionConstraints?: NextActionConstraint[];
    round: number;
    phase: string;
    initiative: Seat | null;
    players: Record<Seat, PlayerSnap>;
    pending?: PendingEffect[];
    /** Explicit staged history only; discard membership does not establish defeat timing. */
    defeatedThisPhase?: { round: number; phase: string; cards: { id: string; controller?: Seat; defeatedBy?: Seat; incarnation?: string; lastKnownType?: 'unit' | 'leader-unit' | 'resource' | 'upgrade' | 'token' | 'token-unit' | 'token-upgrade' }[] };
    mostRecentIncarnations?: Record<string, string>;
    /** Explicit staged damage attribution; existing base counters do not establish this history. */
    baseDamagedThisPhase?: { round: number; phase: string; damage: { player: Seat; sourceId: string; targetId: string; amount: number }[] };
    /** Explicit staged witnessed attacks; exhausted pose alone is not evidence. */
    attacksThisPhase?: { round: number; phase: string; attacks: { id: string; attackerId: string; incarnation: string; attackingSeat?: Seat; defendingSeat?: Seat; targetIds?: string[] }[] };
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
