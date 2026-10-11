import { deltas as diff, edgeTerms } from './derive';
import type { EvalPoint } from './evals';
import type { LensStep } from './lens';
import type { CardRef, Game, PlayerSnap, Seat, Snapshot } from './types';

/**
 * Action classes. A recorded decision is a prompt answer (click a card, press a button); these group the answers into
 * the things a player actually did, read from the prompt, the label and how the board changed. No card data is needed.
 */
export type ActionClass =
    | 'play-unit' | 'play-upgrade' | 'play-event'
    | 'attack' | 'attack-base'
    | 'deploy' | 'ability' | 'trigger'
    | 'resource' | 'pass' | 'initiative'
    | 'choose' | 'setup' | 'cancel';

export const ACTION_CLASSES: { cls: ActionClass; label: string; verb: string; major: boolean }[] = [
    { cls: 'play-unit', label: 'Play a unit', verb: 'plays', major: true },
    { cls: 'play-upgrade', label: 'Play an upgrade', verb: 'attaches', major: true },
    { cls: 'play-event', label: 'Play an event', verb: 'plays', major: true },
    { cls: 'attack', label: 'Attack a unit', verb: 'attacks', major: true },
    { cls: 'attack-base', label: 'Attack the base', verb: 'hits the base with', major: true },
    { cls: 'deploy', label: 'Deploy the leader', verb: 'deploys', major: true },
    { cls: 'ability', label: 'Use an ability', verb: 'uses', major: true },
    { cls: 'trigger', label: 'Resolve a trigger', verb: 'triggers', major: false },
    { cls: 'resource', label: 'Resource a card', verb: 'resources', major: false },
    { cls: 'pass', label: 'Pass', verb: 'passes', major: false },
    { cls: 'initiative', label: 'Claim initiative', verb: 'claims initiative', major: true },
    { cls: 'choose', label: 'Choose a target', verb: 'chooses', major: false },
    { cls: 'setup', label: 'Setup', verb: 'sets up', major: false },
    { cls: 'cancel', label: 'Cancel', verb: 'cancels', major: false }
];
export const classInfo = (c: ActionClass) => ACTION_CLASSES.find((x) => x.cls === c)!;

export interface Outcome {
    baseDamage: number;
    defeated: number;
    entered: number;
}

export interface Action {
    /** index of the step that started the action (an action may span several steps: attacker, then target) */
    index: number;
    /** index of its last step */
    until: number;
    seat: Seat;
    cls: ActionClass;
    /** the card acted with (unit, played card, leader); null for buttons like Pass */
    card: CardRef | null;
    /** the attack or effect target, when there is one */
    target: CardRef | null;
    /** what changed on the board over the whole action (enemy base damage, enemy units defeated, own units entered) */
    outcome: Outcome;
    /** how much the action moved the game: eval swing if the game is annotated, else material swing plus outcome */
    swing: number;
}

const norm = (s: string) => s.toLowerCase().split('#')[0].replace(/[^a-z0-9]/g, '');
const nameMatches = (label: string, card: CardRef) => norm(label) === norm(card.n);

function findCard(p: PlayerSnap, label: string): { zone: 'hand' | 'unit' | 'leader' | 'base' | 'resource'; card: CardRef } | null {
    const h = p.hand.find((c) => nameMatches(label, c));
    if (h) {
        return { zone: 'hand', card: h };
    }
    const u = [...p.ground, ...p.space].find((c) => nameMatches(label, c));
    if (u) {
        return { zone: 'unit', card: u };
    }
    if (p.leader && nameMatches(label, p.leader)) {
        return { zone: 'leader', card: p.leader };
    }
    if (nameMatches(label, p.base)) {
        return { zone: 'base', card: p.base };
    }
    return null;
}

/** A card named by an engine label, anywhere on the board (for targets). */
function findAnywhere(s: Snapshot, label: string): CardRef | null {
    for (const seat of ['p1', 'p2'] as Seat[]) {
        const f = findCard(s.players[seat], label);
        if (f) {
            return f.card;
        }
        const up = [...s.players[seat].ground, ...s.players[seat].space].flatMap((u) => u.u ?? []).find((c) => nameMatches(label, c));
        if (up) {
            return up;
        }
    }
    return null;
}

const isTop = (prompt: string | undefined) => !!prompt && prompt.startsWith('actionWindow');

/** Groups a game's decisions into actions. Steps that only answer a follow-up prompt fold into the action they belong to. */
export function classifyGame(game: Game, evals?: Map<number, EvalPoint>, lens?: Map<number, LensStep>): Action[] {
    const steps = game.steps;
    const out: Action[] = [];
    let i = 1;
    while (i < steps.length) {
        const s = steps[i];
        const before = steps[i - 1].state;
        const seat = s.pid ?? 'p1';
        const label = s.action?.label ?? '';
        const kind = s.action?.kind;
        const prompt = s.prompt ?? '';
        // the action runs until the next top-level choice or resource prompt
        let until = i;
        if (isTop(prompt)) {
            while (until + 1 < steps.length && !isTop(steps[until + 1].prompt) && !(steps[until + 1].prompt ?? '').startsWith('resource')) {
                until++;
            }
        }
        let cls: ActionClass = 'choose';
        let card: CardRef | null = null;
        let target: CardRef | null = null;
        const me = before.players[seat];
        if (prompt.startsWith('resource')) {
            cls = 'resource';
            card = kind === 'card' ? me.hand.find((c) => nameMatches(label, c)) ?? null : null;
        } else if (isTop(prompt) && kind === 'button') {
            cls = /initiative/i.test(label) ? 'initiative' : 'pass';
        } else if (isTop(prompt) && kind === 'card') {
            const f = findCard(me, label);
            card = f?.card ?? null;
            const follow = steps.slice(i + 1, until + 1);
            const cancelled = follow.some((x) => x.action?.label === 'Cancel') && follow.length <= 2;
            const attackStep = follow.find((x) => /target for attack/i.test(x.title ?? ''));
            if (cancelled) {
                cls = 'cancel';
            } else if (attackStep && f?.zone !== 'hand') {
                const t = attackStep.action?.kind === 'card' ? findAnywhere(before, attackStep.action.label) : null;
                target = t;
                const enemyBase = before.players[seat === 'p1' ? 'p2' : 'p1'].base;
                cls = t && t.n === enemyBase.n && t.s === enemyBase.s ? 'attack-base' : 'attack';
            } else if (f?.zone === 'leader') {
                cls = follow.some((x) => /^deploy/i.test(x.action?.label ?? '')) ? 'deploy' : 'ability';
            } else if (f?.zone === 'hand' || !f) {
                const after = steps[until].state.players[seat];
                const name = card?.n ?? '';
                const unitsBefore = [...me.ground, ...me.space].filter((u) => u.n === name).length;
                const unitsAfter = [...after.ground, ...after.space].filter((u) => u.n === name).length;
                const upgradesAfter = [...after.ground, ...after.space].flatMap((u) => u.u ?? []).filter((u) => nameMatches(label, u)).length;
                const upgradesBefore = [...me.ground, ...me.space].flatMap((u) => u.u ?? []).filter((u) => nameMatches(label, u)).length;
                cls = unitsAfter > unitsBefore ? 'play-unit' : upgradesAfter > upgradesBefore || follow.some((x) => /^attach/i.test(x.title ?? '')) ? 'play-upgrade' : 'play-event';
                if (!card) {
                    card = findAnywhere(steps[until].state, label) ?? { n: humanizeLabel(label), s: null };
                }
                const tStep = follow.find((x) => x.action?.kind === 'card');
                target = tStep?.action ? findAnywhere(before, tStep.action.label) : null;
            } else {
                cls = 'ability';
            }
        } else if (/trigger/i.test(prompt.split('|')[0])) {
            cls = 'trigger';
        } else if (/mulligan|initiative/i.test(s.title ?? '') || prompt.startsWith('initiative')) {
            cls = 'setup';
        } else if (label === 'Cancel') {
            cls = 'cancel';
        } else if (kind === 'card') {
            target = findAnywhere(before, label);
        }
        // passing or claiming hands the turn over; what happens next is not this action's doing
        const outcome = cls === 'pass' || cls === 'initiative' || cls === 'resource' || cls === 'setup'
            ? { baseDamage: 0, defeated: 0, entered: 0 }
            : outcomeOf(steps[i - 1].state, steps[until].state, seat);
        out.push({ index: i, until, seat, cls, card, target, outcome, swing: swingOf(game, i - 1, until, seat, outcome, evals, lens) });
        i = until + 1;
    }
    return out;
}

function humanizeLabel(l: string) {
    return l.split('#')[0].split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

function outcomeOf(a: Snapshot, b: Snapshot, seat: Seat): Outcome {
    const foe = seat === 'p1' ? 'p2' : 'p1';
    const d = diff(a, b);
    return {
        baseDamage: Math.max(0, b.players[foe].base.d - a.players[foe].base.d),
        defeated: d.filter((x) => x.seat === foe && x.kind === 'defeat').length,
        entered: d.filter((x) => x.seat === seat && (x.kind === 'enter' || x.kind === 'deploy')).length
    };
}

/** Swing toward the acting player: evaluation change when annotated (0..1 scale × 100), else board-score change + outcome. */
function swingOf(game: Game, from: number, to: number, seat: Seat, o: Outcome, evals?: Map<number, EvalPoint>, lens?: Map<number, LensStep>): number {
    const sign = seat === 'p1' ? 1 : -1;
    if (evals?.size) {
        const at = (i: number) => {
            let best: number | null = null;
            for (const [k, p] of evals) {
                const v = p.objective_state ?? p.objective_hindsight ?? p.p1_subjective;
                if (k <= i && v != null && (best == null || k > best)) {
                    best = k;
                }
            }
            const p = best == null ? null : evals.get(best)!;
            return p ? (p.objective_state ?? p.objective_hindsight ?? p.p1_subjective ?? 0.5) : 0.5;
        };
        const ev = (at(to) - at(from)) * 100 * sign;
        if (ev !== 0) {
            return ev + o.baseDamage * 0.5 + o.defeated;
        }
    }
    const score = (i: number) => edgeTerms(game.steps[i].state, lens?.get(i) ?? null).sum;
    const m = (score(to) - score(from)) * sign;
    return m + o.baseDamage * 0.6 + o.defeated * 2;
}

/** The k actions that moved the game most, kept at least `gap` steps apart, in game order. */
export function pivotalActions(actions: Action[], k = 8, gap = 6): Action[] {
    const ranked = actions.filter((a) => classInfo(a.cls).major).sort((a, b) => Math.abs(b.swing) - Math.abs(a.swing));
    const picked: Action[] = [];
    for (const a of ranked) {
        if (picked.length >= k) {
            break;
        }
        if (Math.abs(a.swing) < 1.5) {
            break;
        }
        if (picked.every((p) => Math.abs(p.index - a.index) >= gap)) {
            picked.push(a);
        }
    }
    return picked.sort((a, b) => a.index - b.index);
}

/** One-line description, e.g. "heuristic attacks Wampa with Darth Vader". */
export function describe(a: Action, bot: string): string {
    const info = classInfo(a.cls);
    const c = a.card?.n;
    switch (a.cls) {
        case 'attack':
            return `${bot} attacks ${a.target?.n ?? 'a unit'}${c ? ` with ${c}` : ''}`;
        case 'attack-base':
            return `${bot} hits the base${c ? ` with ${c}` : ''}`;
        case 'pass':
        case 'initiative':
            return `${bot} ${info.verb}`;
        case 'play-upgrade':
            return `${bot} attaches ${c ?? 'an upgrade'}${a.target ? ` to ${a.target.n}` : ''}`;
        case 'play-event':
            return `${bot} plays ${c ?? 'an event'}${a.target ? ` on ${a.target.n}` : ''}`;
        default:
            return `${bot} ${info.verb}${c ? ` ${c}` : ''}`;
    }
}
