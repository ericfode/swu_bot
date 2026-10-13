import type { OnAttackAbilityRef, BaseDamageProtection, PhaseDiscardPlayPermission, CardRef, GrantedDefeatAbility, DefenseModifier, LeaderRef, NextActionConstraint, PendingEffect, PendingPlayerEffect, StagedMatchResult, ResourceRef, Seat, Snapshot, UnitRef, UpgradeRef } from '../data/types';
import type { PreviewAspect } from './previewCosts';
import type { AbilityKind } from './abilities';

export interface CardEffectDefinition {
    id: string;
    name: string;
    setCode: string;
    family: 'damage' | 'force' | 'tactics' | 'support';
    color: string;
    description: string;
    visual: string;
    durationMs: number;
}

/** Explicit staged deck operation. Rearranges a complete manifest without moving cards out of deck. */
export interface DeckOperation {
    scope: 'whole' | 'top';
    visibility: 'private' | 'public';
    policy: 'whole-search-shuffle' | 'top-search-bottom' | 'reveal-top-choice';
    looked: CardRef[];
    selectedIds: string[];
    revealedIds?: string[];
    /** Complete permutation, including selected cards until separate draw/play/discard receipts consume them. */
    remainingOrder: CardRef[];
    selectionLimit?: number;
    printedCostLimit?: number;
    printedCosts?: Record<string, number>;
    /** Explicit public, one-at-a-time reveal decisions; no new cards are created by repeated prefix prompts. */
    reveal?: { runningTotals: number[]; stop: 'chosen' | 'limit' | 'deck-end'; limit: number; damageThreshold: number };
}

/** Staged payment choice. Ordinary replays use recorded resources and never receive inferred alternatives. */
export type PreviewPlayPayment = { kind: 'resources'; cardIds?: string[]; smuggle?: { sourceId: string; resourcesAfterPayment: ResourceRef[] }; exploit?: { sourceId: string; units: { id: string; incarnation: string }[] } } | {
    kind: 'alternate-discard'; sourceId: string; cards: CardRef[]; requiredAspect: 'cunning'; replacesAllCosts: true;
};

/** A visible, recorded state change. A rules clause alone is not evidence that this outcome happened. */
export interface CardEffectOutcome {
    causeCard?:CardRef;
    damageAttempt?: {incoming:number;prevention:'none'|'shield'|'native-immunity';shieldId?:string};
    unpreventable?:boolean;
    indirectAllocation?: {id:string;sourceId:string;player:Seat;total:number;members:{id:string;incarnation?:string;amount:number}[]};
    lightspeed?: {id:string;sourceId:string;friendly:{id:string;incarnation:string;power:number};enemy?:{id:string;incarnation:string;power:number};stage:'defeat'|'direct'|'indirect';condition?:'resolved-clauses'};
    vehicleSources?: {id:string;sourceId:string;arena:'ground'|'space';targetId:string;targetIncarnation:string;members:{id:string;incarnation:string;power:number}[]};
    arenaSalvo?: {id:string;sourceId:string;unitId:string;incarnation:string;power:number;opponent:Seat;arena:'ground'|'space';members:{id:string;incarnation:string}[]};
    remainingHpDamage?: {sourceId:string;subjectId:string;incarnation:string;hp:number;wounds:number;computed:number};
    discountedVehiclePlay?: {sourceId:string;cardId:string;printedCost:number;aspects:PreviewAspect[];discount:3};
    onAttackWindow?: {id:string;sourceId:string;subjectId:string;incarnation:string;attackId:string;round:number;phase:string;effect:'trench-cost-difference'|'firespray-indirect'};
    onAttackOrigin?: {windowId:string;ability:OnAttackAbilityRef;attackId:string;round:number;phase:string;controlsBobaFett?:false};
    millCostDifference?: {windowId:string;cards:CardRef[];printedCosts:number[];difference:number};
    onAttackCensus?: {sourceId:string;subjectId:string;incarnation:string;abilities:OnAttackAbilityRef[];targets:{id:string;incarnation:string}[]};
    pairedDamage?: {id:string;sourceId:string;arena:'ground'|'space';friendly:{id:string;incarnation:string};enemy:{id:string;incarnation:string}};

    generatedSet?: {mechanic?:'base-restriction'|'sentinel';opponentResources?:{seat:Seat;total:number};id:string;sourceId:string;round:number;phase:string;members:{id:string;incarnation:string}[]};
    restrictionOperation?: 'grant'|'expire';
    distinctTitleBoost?: {id:string;sourceId:string;round:number;phase:string;members:{id:string;incarnation:string;title:string}[];titles:string[];amount:number};
    phaseStatsOperation?: 'grant'|'expire';
    exhaustedAttackPermission?: {sourceId:string;attackerId:string;incarnation:string;attackId:string;round:number;phase:string;unitTargetOnly:true};
    pilotDetach?: {hostId:string;hostIncarnation:string;upgradeId:string};
    unupgradedSet?: {id:string;sourceId:string;round:number;phase:string;members:{id:string;incarnation:string}[]};
    spaceExhaustion?: {id:string;sourceId:string;round:number;phase:string;members:{id:string;incarnation:string}[]};
    spaceCensus?: {sourceId:string;round:number;phase:string;player:Seat;opponent:Seat;own:{id:string;incarnation:string}[];other:{id:string;incarnation:string}[]};
    discardPlayDamage?: {sourceId:string;playedId:string;incarnation:string;sequenceId:string;printedCost:number;aspects:PreviewAspect[]};
    requiresAttack?: {attackId:string;attackerId:string;incarnation:string;arena:'space'};

    handBottom?: { id:string; player:Seat; drawnIds:string[]; tokenUnitIdsAtResolution:[]; selectedIds:string[]; order:string[] };
    woundBoost?: { subjectId:string; incarnation:string; wounds:number };
    spaceClearance?: { id:string; defeatedId:string; incarnation:string; opponent:Seat; remainingIdsAtDefeat:[] };
    baseProtection?: { operation:'grant'; effect:BaseDamageProtection } | { operation:'consume'; effectId:string; sourceId:string; incoming:number; prevented:number; channel:'direct'|'indirect' } | { operation:'expire'; effectId:string; sourceId:string };
    keywordOperation?: 'gain'|'lose'|'expire';
    keywordWindow?: { id:string; sourceId:string; round:number; phase:string; members:{id:string; incarnation:string; nativeSentinel:boolean}[] };

    requiresDiscard?: { id:string; seat:Seat };
    singleUnitPlay?: { player:Seat; unitId:string; incarnation:string; sharedTrait:string; printedCost:number; aspects:PreviewAspect[] };
    captureSelection?: {
        id:string; sourceId:string;
        captor:{id:string; incarnation:string; printedCost:number};
        target:{id:string; incarnation:string; printedCost:number};
    };
    damageDefeatOrigin?: { sourceId:string; subjectId:string; incarnation:string; controller:Seat; amount:number };
    traitGrant?: {
        id:string; trait:'republic'|'separatist'|'trooper'|'jedi'; scope:'up-to-one-any'|'all-friendly';
        members:{id:string; incarnation:string}[];
    };
    unitDefeatCount?: { round:number; phase:string; units:{id:string; incarnation:string}[] };
    defeatedEntry?: {id:string; incarnation:string};
    sameNameGroup?: {id:string; selectedId:string; selectedIncarnation:string; title:string; selectedPrintedCost:number; members:{id:string; incarnation:string}[]};
    requiresExhaust?: {id:string; incarnation:string};
    phasePlayPermission?: PhaseDiscardPlayPermission;
    phasePermissionId?: string;
    sharedTrait?: { id: string; trait: string; units: { id: string; incarnation: string }[] };
    defenderDamageAtStart?: { defenderId: string; incarnation?: string; zone: 'ground' | 'space' | 'base'; damage: number };
    gritBasis?: { attackerId: string; incarnation: string; damage: number; powerIncludesGrit: boolean };
    powerWindow?: { id: string; members: { id: string; incarnation: string; power: number; controller: Seat }[] };

    grantedAbility?: GrantedDefeatAbility;
    whenDefeatedOrigin?: { abilityId: string; sourceId: string; subjectId: string; incarnation: string; controller: Seat; round: number; phase: string };
    restoreOrigin?: { attackerId: string; incarnation: string; attackId: string; round: number; phase: string; amount: number };
    traitCondition?: { player: Seat; trait: 'official'; minimum: 3; units: { id: string; incarnation: string }[] };
    captureArena?: { captorId: string; incarnation: string; arena: 'ground'|'space' };

    kind: AbilityKind;
    card?: CardRef | null;
    seat: Seat;
    amount?: number | string;
    zone?: 'ground' | 'space' | 'base' | 'leader' | 'hand' | 'deck' | 'discard' | 'resources';
    label?: string;
    selection?: 'chosen' | 'random' | 'opponent' | 'all';
    /** Movement origin and damage source are separate from the event source and destination. */
    fromSeat?: Seat;
    fromZone?: CardEffectOutcome['zone'] | 'capture';
    sourceCard?: CardRef;
    ownerSeat?: Seat;
    /** Explicit staged search group or draw cards; never inferred from hidden replay data. */
    cards?: CardRef[];
    /** Complete staged entering unit; hand references cannot establish its arena stats. */
    unit?: UnitRef;
    entersReady?: boolean;
    entryType?: 'played' | 'rescued' | 'created' | 'detached';
    pending?: PendingEffect;
    duration?: 'phase' | 'attack' | 'regroup' | 'round' | 'token' | 'permanent' | 'next-action';
    deckOperation?: DeckOperation;
    keyword?: { name: 'Raid' | 'Saboteur' | 'Ambush' | 'Sentinel' | 'Restore' | 'Grit' | 'Overwhelm'; amount: number };
    restriction?: 'cannot-ready' | 'must-attack' | 'cannot-attack-base';
    round?: number;
    incarnation?: string;
    destination?: 'hand' | 'deck-bottom';
    printedCost?: number;
    chooserSeat?: Seat;
    attackId?: string;
    attackIndex?: number;
    combatOrder?: 'simultaneous' | 'attacker-first';
    damageType?: 'combat' | 'ability';
    trigger?: 'combat-damage';
    basis?: { kind: 'healed' | 'source-damage-plus-one' | 'printed-cost' | 'heroism-count' | 'printed-cost-sum' | 'source-power' | 'defeated-power' | 'played-printed-cost' | 'hand-count' | 'captured-count' | 'arena-unit-count'; sourceIds: string[]; value: number; arena?: 'ground' | 'space'; increment?: number; printedCosts?: Record<string, number>; threshold?: number; player?: Seat; countRule?: { zero: number; positive: number } };
    /** Explicit history prerequisite on staged recovery; never inferred from a discarded card. */
    defeatPhase?: { round: number; phase: string };
    baseDamagePhase?: { round: number; phase: string; player: Seat; targetId: string };
    choice?: { kind: 'controller-response'; decision: 'no' | 'damage'; subject: CardRef; controller: Seat }
        | { kind:'opponent-random-discard'; chooserSeat:Seat; handSeat:Seat; decision:'discard'|'decline'; result:'discarded'|'not-discarded'; selectedId?:string }
        | { kind: 'opponent-mode'; decision: 'resources' | 'unit'; chooser: Seat; actor: Seat }
        | { kind: 'controller-unless'; decision: 'pay' | 'exhaust'; subject: CardRef; controller: Seat; amount: 2 }
        | { kind: 'owner-replay'; decision: 'play-free' | 'decline'; owner: Seat; subjectId: string; returnedIncarnation: string }
        | { kind: 'private-top'; decision: 'leave' | 'play-discount' | 'play-free'; discount: number; freeAtRemainingHp: number };
    sequenceId?: string;
    sequenceIndex?: number;
    targetIncarnation?: string;
    attackPhase?: { round: number; phase: string; incarnation: string };
    upgradeCountBasis?: { sourceId: string; incarnation: string; upgradeIds: string[]; count: number; resolution: 'defeated' | 'prevented'; distributionId: string };
    allocation?: { id: string; limit: number };
    prevented?: boolean;
    targetCard?: CardRef;
    upgrade?: UpgradeRef;
    controllerSeat?: Seat;
    leader?: LeaderRef;
    requiresDefeat?: { id: string; incarnation: string };
    resourceReadySwap?: { readyId: string; exhaustedId: string };
    visibility?: 'private' | 'public';
    resourceReveal?: { playIds: string[] };
    attackOrigin?: { kind: 'ambush'; playedId: string; incarnation: string };
    controlExchange?: { id: string; memberIds: [string, string] };
    nextAction?: { operation: 'add'; constraint: NextActionConstraint }
        | { operation: 'consume'; constraintId: string; witness: {
            id: string; player: Seat; round: number; phase: string;
            action: 'attack-with-unit' | 'other' | 'phase-end'; result: 'satisfied' | 'unable' | 'expired';
            attackerId?: string; incarnation?: string; attackId?: string; targetId?: string; unableReason?: 'exhausted' | 'departed';
        } };
    captiveCleanup?: { id: string; captorId: string; incarnation: string; cards: CardRef[] };
    captiveCleanupId?: string;
    resolutionGroup?: { id: string; mode: 'simultaneous' };
    condition?: { kind: 'resources-more'; player: Seat; total: number; than: Seat; thanTotal: number } | { kind: 'initiative'; player: Seat; initiative: Seat | null };
    playerChoice?: { chooserSeat: Seat; selectedSeat: Seat };
    attackBonusBasis?: { kind: 'bounty-hunter' | 'damaged' | 'wookiee'; sourceId: string; incarnation: string; damage?: number };
    pendingOperation?: 'schedule' | 'consume';
    playerPending?: PendingPlayerEffect;
    matchResult?: StagedMatchResult;
    playAs?: 'unit' | 'upgrade';
    requiresReturn?: { id: string; incarnation: string; ownerSeat: Seat };
    attackRole?: 'attacker' | 'defender';
    attackArenaPermission?: 'space-to-ground' | 'space-to-ground-native';
    bountyResolution?: { id: string; hostId: string; incarnation: string; collector: Seat; abilitySourceId: string; index: number; kind: 'draw'; amount: number };
    enteredPhase?: { round: number; phase: string; incarnation: string };
    tokenType?: 'battle-droid' | 'clone-trooper' | 'x-wing' | 'tie-fighter';
    paymentRole?: 'exploit';
    defenseModifier?: DefenseModifier;
    defenseOrigin?: { protectedId: string; incarnation: string; sourceId: string };
    unitCountCondition?: { firstId: string; incarnation: string; player: Seat; against: Seat; ownCount: number; otherCount: number };
    chosenUnits?: { id: string; incarnation: string; power: number }[];
    chosenUnitGroup?: string;
    captureCost?: { captorPrintedCost: number; targetPrintedCost: number };
    upgradePlayPermission?: { sourceId: string; player: Seat; ignoreAspectPenalties: true; defeated: { id: string; incarnation: string } };
    captureBasis?: { round: number; phase: string; attackId: string; attackerId: string; incarnation: string; attackingSeat: Seat; defendingSeat: Seat; targetId: string };
}

/** A visual interpretation of a recorded, resolved card action. Never changes game state. */
export interface CardEffectCue {
    definition: CardEffectDefinition;
    seat: Seat;
    source: CardRef | null;
    target: CardRef | null;
    targetSeat?: Seat;
    key: string;
    outcomes?: CardEffectOutcome[];
    previewProgress?: number;
    exampleLabel?: string;
    /** Verified staged event payment, separate from nested/additional pay receipts. Unknown in ordinary recordings. */
    playCost?: number;
    playPayment?: PreviewPlayPayment;
    /** Explicitly selected staged boundary; never a wall-clock or inferred replay trigger. */
    stage?: 'regroup-start' | 'next-action' | 'phase-end';
    /** Presentation snapshots: replay values are recorded truth; previews use an explicit staged result. */
    transition?: { before: Snapshot; after: Snapshot; beforeStep?: number; afterStep?: number };
}

export interface EffectPreview {
    definition: CardEffectDefinition;
    nonce: number;
    seat?: Seat;
    progress?: number;
    stage?: 'regroup-start' | 'next-action' | 'phase-end';
}
