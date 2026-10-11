import { deltas as diff, edgeTerms } from './derive';
import type { EvalPoint } from './evals';
import { LENS_SCALE, type LensStep } from './lens';
import type { CardRef, Game, PlayerSnap, Seat, Snapshot, Step } from './types';

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
    /** damage dealt to the opponent's base */
    baseDamage: number;
    /** opponent units that left play (steals and bounces are counted on their own) */
    defeated: number;
    /** own units that entered play, a deployed leader included (stolen units are counted on their own) */
    entered: number;
    /** opponent units that came over to the actor's side */
    stolen?: number;
    /** opponent units returned to a hand */
    bounced?: number;
    /** damage the actor's own base took */
    selfBaseDamage?: number;
    /** own units that left play or went over to the opponent */
    lost?: number;
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
    /**
     * How much the action moved the game toward its player, in percentage points of p1's winning chance: the share of
     * the evaluation change it caused when the game is annotated, else the change of (1 + board edge) / 2.
     */
    swing: number;
    /** resource: the cards that went into the resource zone (empty when the player skipped) */
    cards?: CardRef[];
    /** the steps that make up the action when that is not all of index..until (a resource window interleaves both players' clicks) */
    steps?: number[];
    /** what the prompt was about, as a clause for describe(): "mulligans", "pays 3 resources instead of exhausting Kylo Ren" */
    detail?: string;
    /** whose side the target is on */
    targetSeat?: Seat;
    /** the bot name of the target's controller, when that is the opponent */
    targetOwner?: string;
}

/** Below this eval swing (percentage points) a pass or an initiative claim that left the board alone earns no credit. */
const QUIET_SWING = 10;

const SEATS: Seat[] = ['p1', 'p2'];
const other = (s: Seat): Seat => (s === 'p1' ? 'p2' : 'p1');
const units = (p: PlayerSnap) => [...p.ground, ...p.space];
const norm = (s: string) => s.toLowerCase().split('#')[0].replace(/[^a-z0-9]/g, '');
const nameMatches = (label: string, card: CardRef) => norm(label) === norm(card.n);
const countIn = (cards: CardRef[], label: string) => cards.filter((c) => nameMatches(label, c)).length;

const isTop = (prompt: string | undefined) => !!prompt && prompt.startsWith('actionWindow');
const isResource = (prompt: string | undefined) => !!prompt && prompt.startsWith('resource');
const isSetup = (s: Step) => (s.prompt ?? '').startsWith('initiative') || /mulligan/i.test(s.title ?? '');
const isTriggerPrompt = (prompt: string | undefined) => /^(optionalTrigger|triggerWindow|batchTriggerResolution)/.test(prompt ?? '');
const phaseKey = (s: Snapshot) => `${s.round}:${s.phase}`;
const ATTACK_TARGET = /target for attack/i;
/** prompt titles whose card pick is the effect's target; cost prompts (exploit, discard, pay) never name one */
const EFFECT = /\b(deal|damage|heal|exhaust|ready|give|attach|capture|defeat|return|control|bounce)\b/i;
const COST = /exploit|discard|\bpay\b|cost|credit|resource/i;

interface Found {
    card: CardRef;
    seat: Seat;
    base: boolean;
}

/** A card named by an engine label on the board (units, their upgrades, leader, base), then in hands; `first` is searched first. */
function locate(s: Snapshot, label: string, first: Seat): Found | null {
    const order = [first, other(first)];
    for (const seat of order) {
        const p = s.players[seat];
        const u = units(p).find((c) => nameMatches(label, c)) ?? units(p).flatMap((c) => c.u ?? []).find((c) => nameMatches(label, c));
        if (u) {
            return { card: u, seat, base: false };
        }
        if (p.leader && nameMatches(label, p.leader)) {
            return { card: p.leader, seat, base: false };
        }
        if (nameMatches(label, p.base)) {
            return { card: p.base, seat, base: true };
        }
    }
    for (const seat of order) {
        const h = s.players[seat].hand.find((c) => nameMatches(label, c));
        if (h) {
            return { card: h, seat, base: false };
        }
    }
    return null;
}

/** Whether the board changed: units (ignoring exhaustion) or base damage. Readying at regroup is not a board change. */
function boardMoved(a: Snapshot, b: Snapshot): boolean {
    const key = (s: Snapshot) => SEATS.map((k) => `${s.players[k].base.d}|${units(s.players[k]).map((u) => `${u.n}/${u.p}/${u.h}/${u.d}/${(u.u ?? []).map((x) => x.n).join(',')}`).sort().join(';')}`).join('||');
    return key(a) !== key(b);
}

const samePlayers = (a: Snapshot, b: Snapshot) => JSON.stringify(a.players) === JSON.stringify(b.players);

function humanizeLabel(l: string) {
    return l.split('#')[0].split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

/** "a, b and c" */
function list(xs: string[]): string {
    return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/** A prompt title as a clause: first line, no "(because ...)" aside, no trailing colon or period. */
function cleanTitle(t: string | null | undefined): string {
    return (t ?? '').split('\n')[0].replace(/\s*\(because[^)]*\)?/i, '').replace(/[.:\s]+$/, '').trim();
}

const VERBS = new Set(['deal', 'give', 'choose', 'select', 'attach', 'exhaust', 'heal', 'return', 'defeat', 'put', 'play', 'attack', 'create', 'search',
    'discard', 'draw', 'pay', 'ready', 'distribute', 'look', 'reveal', 'use', 'take', 'move', 'capture', 'disclose', 'view', 'resolve']);

/** "Deal 1 damage to a unit" -> "deals 1 damage to a unit"; titles that are not orders are quoted. */
function thirdPerson(title: string): string {
    const m = /^collect bounty:\s*/i.exec(title);
    if (m) {
        return `collects a bounty: ${thirdPerson(title.slice(m[0].length))}`;
    }
    const [w, ...rest] = title.split(' ');
    const v = w.toLowerCase();
    if (!VERBS.has(v)) {
        return `resolves "${title}"`;
    }
    const s = /(s|sh|ch|x)$/.test(v) ? `${v}es` : /[^aeiou]y$/.test(v) ? `${v.slice(0, -1)}ies` : `${v}s`;
    return [s, ...rest].join(' ');
}

const botNames = (game: Game): Record<Seat, string> => ({
    p1: game.header.players.find((p) => p.id === 'p1')?.bot ?? 'p1',
    p2: game.header.players.find((p) => p.id === 'p2')?.bot ?? 'p2'
});

/** Groups a game's decisions into actions. Steps that only answer a follow-up prompt fold into the action they belong to. */
export function classifyGame(game: Game, evals?: Map<number, EvalPoint>, lens?: Map<number, LensStep>): Action[] {
    const steps = game.steps;
    const names = botNames(game);
    // the recorded deck is "leader-id / base-id"; a leader keeps that label when it flips or deploys under another name
    const leaderId = Object.fromEntries(SEATS.map((k) => [k, game.header.players.find((p) => p.id === k)?.deck.split(' / ')[0] ?? ''])) as Record<Seat, string>;
    // upgrades on a base are not in the snapshots; remember which ones were attached so their abilities read as abilities
    const baseUpgrades: Record<Seat, Set<string>> = { p1: new Set(), p2: new Set() };
    const out: Action[] = [];
    let lastTop = 0;
    let i = 1;
    while (i < steps.length) {
        const s = steps[i];
        const prompt = s.prompt ?? '';
        if (isResource(prompt)) {
            let end = i;
            while (end + 1 < steps.length && isResource(steps[end + 1].prompt)) {
                end++;
            }
            out.push(...resourceWindow(game, i, end));
            i = end + 1;
            continue;
        }
        const seat = s.pid ?? 'p1';
        const foe = other(seat);
        const setup = isSetup(s);
        let until = i;
        while (!setup && until + 1 < steps.length && folds(steps, i, until + 1, seat)) {
            until++;
        }
        const before = steps[i - 1].state;
        const after = steps[until].state;
        const label = s.action?.label ?? '';
        const kind = s.action?.kind;
        const me = before.players[seat];
        const follow = steps.slice(i + 1, until + 1);
        let cls: ActionClass = 'choose';
        let card: CardRef | null = null;
        let target: Found | null = null;
        let detail: string | undefined;
        const name = (f: Found) => (f.seat !== seat && !f.base ? `${names[f.seat]}'s ${f.card.n}` : f.card.n);
        // card picks in this action, with the board as it was when each was made
        const picks = follow.map((x, j) => ({ st: x, k: i + 1 + j })).filter((x) => x.st.action?.kind === 'card' || x.st.action?.kind === 'displayCard');
        const effectTarget = () => {
            const p = picks.find((x) => EFFECT.test(x.st.title ?? '') && !COST.test(x.st.title ?? '') && !ATTACK_TARGET.test(x.st.title ?? '') && !/^attack with/i.test(x.st.title ?? ''));
            return p ? locate(steps[p.k - 1].state, p.st.action!.label, /friendly/i.test(p.st.title ?? '') ? p.st.pid ?? seat : other(p.st.pid ?? seat)) : null;
        };
        // every attack in the action: its target (searched on the foe's side first) and the unit picked to make it
        const attacks = follow.map((x, j) => ({ st: x, k: i + 1 + j })).filter((x) => ATTACK_TARGET.test(x.st.title ?? '')).map(({ st, k }) => {
            let attacker: CardRef | null = null;
            for (let j = k - 1; j >= i && !attacker; j--) {
                const lb = steps[j].action?.kind === 'card' ? steps[j].action!.label : null;
                attacker = lb ? units(steps[j].state.players[seat]).find((u) => nameMatches(lb, u)) ?? null : null;
            }
            return { attacker, target: st.action?.kind === 'card' ? locate(steps[k - 1].state, st.action.label, foe) : null };
        });
        const attackClause = () => {
            const hits = attacks.filter((a) => a.target);
            if (!hits.length) {
                return undefined;
            }
            const by = [...new Set(hits.flatMap((a) => (a.attacker ? [a.attacker.n] : [])))];
            const at = [...new Set(hits.map((a) => name(a.target!)))];
            return `${by.length ? `${list(by)} ${by.length > 1 ? 'attack' : 'attacks'}` : 'attacks'} ${list(at)}`;
        };
        if (setup) {
            cls = 'setup';
            detail = s.prompt?.startsWith('initiative')
                ? (/yourself/i.test(label) ? 'wins the flip and goes first' : `wins the flip and lets ${names[foe]} go first`)
                : /mulligan/i.test(label) ? 'mulligans' : /keep/i.test(label) ? 'keeps its opening hand' : thirdPerson(cleanTitle(s.title));
        } else if (isTop(prompt) && kind === 'button') {
            lastTop = i;
            cls = /initiative/i.test(label) ? 'initiative' : 'pass';
            // ready power that can reach the base (an arena with an enemy Sentinel can't) against the HP it has left
            const ready = (['ground', 'space'] as const).reduce((n, arena) => n + (before.players[foe][arena].some((u) => u.sn) ? 0 : me[arena].filter((u) => !u.x).reduce((m, u) => m + u.p, 0)), 0);
            const lethal = cls === 'pass' && ready >= before.players[foe].base.hp - before.players[foe].base.d;
            const ends = phaseKey(after) !== phaseKey(before);
            detail = lethal ? `with lethal on board${ends ? ', ending the phase' : ''}` : ends ? 'and ends the phase' : undefined;
        } else if (isTop(prompt) && kind === 'card') {
            lastTop = i;
            const inHand = me.hand.some((c) => nameMatches(label, c));
            const fromHand = countIn(me.hand, label) > countIn(after.players[seat].hand, label);
            const leader = label === leaderId[seat] || (!leaderId[seat] && !!me.leader && nameMatches(label, me.leader));
            // a deployed leader acts as its unit, which carries the leader's current name ("The Death Star" for Tarkin)
            const onBoard = leader ? (me.leader?.dep ? units(me).find((u) => u.n === me.leader!.n) ?? null : null) : units(me).find((u) => nameMatches(label, u)) ?? null;
            const upgrade = units(me).flatMap((u) => u.u ?? []).find((u) => nameMatches(label, u)) ?? null;
            const zone = leader && !onBoard ? 'leader'
                : inHand && (fromHand || !onBoard) ? 'hand'
                : onBoard ? 'unit'
                : nameMatches(label, me.base) ? 'base'
                : upgrade || baseUpgrades[seat].has(norm(label)) ? 'upgrade'
                : 'elsewhere';
            card = zone === 'leader' ? me.leader : zone === 'unit' ? onBoard : zone === 'base' ? me.base : zone === 'hand' ? me.hand.find((c) => nameMatches(label, c))!
                : zone === 'upgrade' ? upgrade ?? { n: humanizeLabel(label), s: null } : null;
            if (follow.some((x) => x.action?.label === 'Cancel') && samePlayers(before, after)) {
                // backed out: nothing changed on the board
                cls = 'cancel';
                detail = zone === 'hand' || zone === 'elsewhere' ? 'play' : attacks.length || follow.some((x) => /^attack$/i.test(x.action?.label ?? '')) ? 'attack' : 'use';
            } else if (zone === 'leader') {
                cls = follow.some((x) => /^deploy/i.test(x.action?.label ?? '')) ? 'deploy' : 'ability';
                target = attacks[0]?.target ?? effectTarget();
                const flipped = after.players[seat].leader && me.leader && after.players[seat].leader!.n !== me.leader.n ? `flips to ${after.players[seat].leader!.n}` : undefined;
                detail = cls === 'ability' ? attackClause() ?? flipped : undefined;
            } else if (zone === 'unit' && attacks.length) {
                target = attacks[0].target;
                cls = target?.base && target.seat === foe ? 'attack-base' : 'attack';
            } else if (zone === 'unit' || zone === 'base' || zone === 'upgrade') {
                cls = 'ability';
                target = attacks[0]?.target ?? effectTarget();
                detail = attackClause();
                if (zone === 'upgrade' && countIn(after.players[seat].discard, label) > countIn(me.discard, label)) {
                    baseUpgrades[seat].delete(norm(label));
                }
            } else {
                // a card played from the hand, or from somewhere the snapshot does not show (Smuggle from resources, the discard)
                const nUnits = (st: Snapshot) => SEATS.flatMap((k) => units(st.players[k])).filter((u) => nameMatches(label, u)).length;
                const nUps = (st: Snapshot) => SEATS.flatMap((k) => units(st.players[k]).flatMap((u) => u.u ?? [])).filter((u) => nameMatches(label, u)).length;
                const attach = picks.find((x) => /^attach/i.test(x.st.title ?? ''));
                cls = nUnits(after) > nUnits(before) ? 'play-unit' : nUps(after) > nUps(before) || attach ? 'play-upgrade' : 'play-event';
                card = card ?? locate(after, label, seat)?.card ?? { n: humanizeLabel(label), s: null };
                target = cls === 'play-upgrade' && attach ? locate(steps[attach.k - 1].state, attach.st.action!.label, seat) : attacks.find((a) => a.target)?.target ?? effectTarget();
                const mine = (st: Snapshot, k: Seat) => units(st.players[k]).filter((u) => nameMatches(label, u)).length;
                // a unit that ends up on the other side (an opponent takes control of it when played)
                const given = cls === 'play-unit' && mine(after, seat) <= mine(before, seat) ? `${names[foe]} takes control of it` : undefined;
                detail = cls === 'play-upgrade' ? undefined : attackClause() ?? given;
                if (cls === 'play-upgrade' && target?.base) {
                    baseUpgrades[seat].add(norm(label));
                }
            }
        } else {
            // a prompt that does not follow this player's own top-level choice: a triggered ability (upkeep at the start
            // of a phase, the opponent's response to an action) or a leftover choice
            const changed = phaseKey(steps[i - 1].state) !== phaseKey(steps[Math.max(0, lastTop - 1)].state) || !lastTop;
            const prevSeat = out.length ? out[out.length - 1].seat : seat;
            cls = isTriggerPrompt(prompt) || changed || prevSeat !== seat ? 'trigger' : 'choose';
            const r = promptDetail(steps, i, until, seat, name, names);
            detail = r.detail;
            card = r.card;
            target = r.target;
        }
        out.push({
            index: i, until, seat, cls, card,
            target: target?.card ?? null,
            outcome: cls === 'setup' || cls === 'cancel' ? { baseDamage: 0, defeated: 0, entered: 0 } : outcomeOf(before, after, seat),
            swing: 0,
            ...(detail ? { detail } : {}),
            ...(target ? { targetSeat: target.seat } : {}),
            ...(target && target.seat !== seat ? { targetOwner: names[target.seat] } : {})
        });
        i = until + 1;
    }
    out.sort((a, b) => a.index - b.index);
    applySwings(game, out, evals, lens);
    return out;
}

/** Whether step k still belongs to the action that started at step i (taken by `seat`). */
function folds(steps: Step[], i: number, k: number, seat: Seat): boolean {
    const nx = steps[k];
    if (isTop(nx.prompt) || isResource(nx.prompt) || isSetup(nx)) {
        return false;
    }
    // the action ended the phase: what follows is the next phase's own business
    if (phaseKey(steps[k - 1].state) !== phaseKey(steps[i - 1].state)) {
        return false;
    }
    // an opponent prompt inside the action answers it ("an opponent chooses", indirect damage, a when-attacked effect):
    // the engine often finishes the action (combat damage) in that very step, so it stays part of the action. Only the
    // opponent's own trigger windows (optional abilities, trigger order) start an action of their own.
    return nx.pid === seat || !isTriggerPrompt(nx.prompt);
}

/**
 * One resource window: both players click cards on and off, then Confirm (or Skip). One action per player, ending at
 * its Confirm; the resourced cards are what left that player's hand when its resource count rose.
 */
function resourceWindow(game: Game, from: number, to: number): Action[] {
    const steps = game.steps;
    const out: Action[] = [];
    for (const seat of SEATS) {
        const mine: number[] = [];
        for (let k = from; k <= to; k++) {
            if (steps[k].pid === seat) {
                mine.push(k);
            }
        }
        if (!mine.length) {
            continue;
        }
        let cards: CardRef[] = [];
        for (let k = from; k <= Math.min(to + 1, steps.length - 1); k++) {
            const a = steps[k - 1].state.players[seat];
            const b = steps[k].state.players[seat];
            if (b.res.total > a.res.total) {
                const rest = b.hand.map((c) => c.n);
                cards = a.hand.filter((c) => {
                    const j = rest.indexOf(c.n);
                    return j >= 0 ? (rest.splice(j, 1), false) : true;
                });
                break;
            }
        }
        const last = mine[mine.length - 1];
        const skipped = /skip/i.test(steps[last].action?.label ?? '') || !cards.length;
        out.push({
            index: mine[0], until: last, seat, cls: 'resource',
            card: cards[0] ?? null, target: null,
            outcome: outcomeOf(steps[mine[0] - 1].state, steps[last].state, seat),
            swing: 0, cards, steps: mine,
            ...(skipped ? { detail: 'skips resourcing' } : {})
        });
    }
    return out;
}

/** What a trigger or a leftover prompt was about, from its title and the answers given. */
function promptDetail(steps: Step[], i: number, until: number, seat: Seat, name: (f: Found) => string, names: Record<Seat, string>): { detail: string; card: CardRef | null; target: Found | null } {
    const run = steps.slice(i, until + 1).map((st, j) => ({ st, k: i + j }));
    const generic = /^(you may trigger this ability|you have multiple triggers|both players have triggered|pausing for)/i;
    const head = run.find((x) => !generic.test(x.st.title ?? '')) ?? run[0];
    const first = head.st;
    const title = cleanTitle(first.title);
    const answer = first.action;
    const me = steps[head.k - 1].state.players[seat];
    // the card the prompt is about: one of the player's units or its leader named in the title, else the first own card picked
    const named = [...units(me), ...(me.leader ? [me.leader] : [])].find((u) => title.toLowerCase().includes(u.n.toLowerCase())) ?? null;
    const picked = run.filter((x) => x.st.pid === seat && x.st.action?.kind === 'card')
        .map((x) => units(steps[x.k - 1].state.players[seat]).find((u) => nameMatches(x.st.action!.label, u)))
        .filter((u): u is NonNullable<typeof u> => !!u);
    const pick = run.find((x) => x.st.action?.kind === 'card' && EFFECT.test(x.st.title ?? '') && !COST.test(x.st.title ?? ''));
    const target = pick ? locate(steps[pick.k - 1].state, pick.st.action!.label, /friendly/i.test(pick.st.title ?? '') ? pick.st.pid ?? seat : other(pick.st.pid ?? seat)) : null;
    const card = named ?? picked[0] ?? null;
    let detail: string;
    const keep = /pay (\d+) resources? for each of them to keep them (\w+)/i.exec(title);
    const upkeep = /^\[exhaust\] (.+?) or \[pay\] (\d+) resources?/i.exec(title);
    const label = answer?.label ?? '';
    if (keep) {
        const kept = [...new Set(picked.map((u) => u.n))];
        detail = kept.length ? `pays ${keep[1]} resource each to keep ${list(kept)} ${keep[2]}` : `pays nothing and lets its units exhaust`;
    } else if (upkeep) {
        detail = /pay/i.test(label) ? `pays ${upkeep[2]} resources instead of exhausting ${upkeep[1]}` : `exhausts ${upkeep[1]} instead of paying ${upkeep[2]} resources`;
    } else if (generic.test(first.title ?? '')) {
        detail = first.prompt?.startsWith('triggerWindow') ? `resolves "${label}" first`
            : /pass|no/i.test(label) ? 'declines an optional ability' : 'uses an optional ability';
    } else if (/^(select one|choose an option|choose an ability|choose a number)/i.test(title) && answer) {
        detail = `chooses "${label.replace(/^#/, '')}"`;
    } else {
        // the answer to the prompt: the card picked (found on the board, foe's side first unless the prompt says friendly), or the button
        const own = first.pid ?? seat;
        const found = answer?.kind === 'card' || answer?.kind === 'displayCard' ? locate(steps[head.k - 1].state, label, /friendly/i.test(first.title ?? '') ? own : other(own)) : null;
        const said = found ? ` (${name(found)})` : answer?.kind === 'card' || answer?.kind === 'displayCard' ? ` (${humanizeLabel(label)})`
            : /^(pass|cancel|no)$/i.test(label) ? ' (declined)' : answer?.kind === 'button' && !/^(done|ok|resolve next)$/i.test(label) ? `: ${label}` : '';
        detail = thirdPerson(title) + said;
    }
    // the telling prompt was the other player's answer (an opponent chooses, a target for the trigger's owner to pick)
    if (head !== run[0] && first.pid && first.pid !== seat) {
        const opener = generic.test(run[0].st.title ?? '') ? (/pass|no/i.test(run[0].st.action?.label ?? '') ? 'declines an optional ability' : 'uses an optional ability') : 'triggers an ability';
        detail = `${opener}, and ${names[first.pid]} ${detail}`;
    }
    return { detail, card, target };
}

function outcomeOf(a: Snapshot, b: Snapshot, seat: Seat): Outcome {
    const foe = other(seat);
    const d = diff(a, b);
    const n = (s: Seat, ...kinds: string[]) => d.filter((x) => x.seat === s && kinds.includes(x.kind)).length;
    const o: Outcome = {
        baseDamage: Math.max(0, b.players[foe].base.d - a.players[foe].base.d),
        defeated: n(foe, 'defeat'),
        entered: n(seat, 'enter', 'deploy')
    };
    const extra: Omit<Outcome, 'baseDamage' | 'defeated' | 'entered'> = {
        stolen: n(seat, 'steal'),
        bounced: n(foe, 'bounce'),
        selfBaseDamage: Math.max(0, b.players[seat].base.d - a.players[seat].base.d),
        lost: n(seat, 'defeat', 'bounce') + n(foe, 'steal')
    };
    for (const [k, v] of Object.entries(extra) as [keyof typeof extra, number][]) {
        if (v) {
            o[k] = v;
        }
    }
    return o;
}

const evalValue = (p: EvalPoint) => p.objective_state ?? p.objective_hindsight ?? p.p1_subjective ?? null;

/**
 * Swing of every action on one scale, percentage points toward the acting player.
 * Board: the change of (1 + edge) / 2 where edge = tanh(board score / 25), so a swing counts less once the game is
 * decided. Pass, initiative and resource count only when the board itself changed (not the initiative token).
 * Evals: each checkpoint-to-checkpoint change is shared among the actions in that interval in proportion to how far
 * each moved the board the same way; when none did and the change is at least QUIET_SWING, it goes to the passes and
 * initiative claims in the interval (passing with lethal on board), else to the interval's plays evenly.
 */
function applySwings(game: Game, acts: Action[], evals?: Map<number, EvalPoint>, lens?: Map<number, LensStep>) {
    const steps = game.steps;
    const memo = new Map<number, { sum: number; init: number }>();
    const score = (i: number) => {
        let v = memo.get(i);
        if (!v) {
            const e = edgeTerms(steps[i].state, lens?.get(i) ?? null);
            v = { sum: e.sum, init: e.terms.find((t) => t.key === 'initiative')?.points ?? 0 };
            memo.set(i, v);
        }
        return v;
    };
    const pp = (x: number) => 50 * (1 + Math.tanh(x / LENS_SCALE));
    const quiet = (c: ActionClass) => c === 'pass' || c === 'initiative' || c === 'resource';
    // board change of each action, p1's way
    const board = acts.map((a) => {
        if (a.cls === 'setup' || a.cls === 'cancel') {
            return 0;
        }
        const from = score(a.index - 1);
        const to = score(a.until);
        if (quiet(a.cls)) {
            return boardMoved(steps[a.index - 1].state, steps[a.until].state) ? pp(to.sum - to.init) - pp(from.sum - from.init) : 0;
        }
        return pp(to.sum) - pp(from.sum);
    });
    const toward = (a: Action) => (a.seat === 'p1' ? 1 : -1);
    acts.forEach((a, k) => {
        a.swing = board[k] * toward(a);
    });
    if (!evals?.size) {
        return;
    }
    const pts = [...evals].flatMap(([i, p]) => {
        const v = evalValue(p);
        return v == null ? [] : [[i, v] as const];
    }).sort((x, y) => x[0] - y[0]);
    for (let c = 0; c + 1 < pts.length; c++) {
        const [from, v0] = pts[c];
        const [to, v1] = pts[c + 1];
        const dE = (v1 - v0) * 100;
        const inside = acts.flatMap((a, k) => (a.until > from && a.until <= to ? [k] : []));
        const w = inside.map((k) => Math.max(0, board[k] * Math.sign(dE)));
        const total = w.reduce((x, y) => x + y, 0);
        let share = w.map((x) => (total > 0 ? x / total : 0));
        if (total === 0) {
            const quietOk = Math.abs(dE) >= QUIET_SWING;
            let cands = quietOk ? inside.filter((k) => acts[k].cls === 'pass' || acts[k].cls === 'initiative') : [];
            if (!cands.length) {
                cands = inside.filter((k) => classInfo(acts[k].cls).major && acts[k].cls !== 'initiative');
            }
            share = inside.map((k) => (cands.includes(k) ? 1 / cands.length : 0));
        }
        inside.forEach((k, j) => {
            acts[k].swing = dE * share[j] * toward(acts[k]);
        });
    }
}

/** The k actions that moved the game most, kept at least `gap` steps apart, in game order. Passes and initiative claims need a swing of QUIET_SWING. */
export function pivotalActions(actions: Action[], k = 8, gap = 6): Action[] {
    const counts = (a: Action) => (a.cls === 'pass' || a.cls === 'initiative' ? Math.abs(a.swing) >= QUIET_SWING : classInfo(a.cls).major);
    const ranked = actions.filter(counts).sort((a, b) => Math.abs(b.swing) - Math.abs(a.swing));
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

/** The outcome as clauses: "defeating 2 units", "taking 4 on its own base". `skipBase` when the sentence already says it. */
function outcomeClauses(o: Outcome, skipBase: boolean): string[] {
    const units = (n: number) => (n === 1 ? 'a unit' : `${n} units`);
    return [
        o.defeated ? `defeating ${units(o.defeated)}` : '',
        o.stolen ? `taking control of ${units(o.stolen)}` : '',
        o.bounced ? `returning ${units(o.bounced)} to hand` : '',
        o.baseDamage && !skipBase ? `dealing ${o.baseDamage} to the enemy base` : '',
        o.lost ? `losing ${units(o.lost)}` : '',
        o.selfBaseDamage ? `taking ${o.selfBaseDamage} on its own base` : ''
    ].filter(Boolean);
}

/** One-line description, e.g. "heuristic attacks random-a's Wampa with Darth Vader, defeating a unit". */
export function describe(a: Action, bot: string): string {
    const info = classInfo(a.cls);
    const c = a.card?.n;
    const t = a.target ? (a.targetOwner && a.cls !== 'attack-base' ? `${a.targetOwner}'s ${a.target.n}` : a.target.n) : null;
    const tail = (s: string, skipBase = false) => {
        const more = outcomeClauses(a.outcome, skipBase);
        return more.length ? `${s}, ${list(more)}` : s;
    };
    switch (a.cls) {
        case 'attack':
            return tail(`${bot} attacks ${t ?? 'a unit'}${c ? ` with ${c}` : ''}`);
        case 'attack-base':
            return a.outcome.baseDamage
                ? tail(`${bot} hits ${t ?? 'the base'} for ${a.outcome.baseDamage}${c ? ` with ${c}` : ''}`, true)
                : tail(`${bot} attacks ${t ?? 'the base'}${c ? ` with ${c}` : ''}`);
        case 'pass':
        case 'initiative':
            return tail(`${bot} ${info.verb}${a.detail ? ` ${a.detail}` : ''}`);
        case 'play-upgrade':
            return tail(`${bot} attaches ${c ?? 'an upgrade'}${t ? ` to ${t}` : ''}`);
        case 'play-unit':
            return tail(`${bot} plays ${c ?? 'a unit'}${t ? `, targeting ${t}` : ''}${a.detail ? `; ${a.detail}` : ''}`);
        case 'play-event':
            return tail(a.detail ? `${bot} plays ${c ?? 'an event'}: ${a.detail}` : `${bot} plays ${c ?? 'an event'}${t ? ` on ${t}` : ''}`);
        case 'deploy':
            return tail(`${bot} deploys ${c ?? 'its leader'}`);
        case 'ability':
            return tail(a.detail ? `${bot} uses ${c ?? 'an ability'}: ${a.detail}` : `${bot} uses ${c ?? 'an ability'}${t ? ` on ${t}` : ''}`);
        case 'resource':
            return a.cards?.length ? `${bot} resources ${list(a.cards.map((x) => x.n))}` : `${bot} ${a.detail ?? 'skips resourcing'}`;
        case 'cancel':
            return a.detail === 'attack' ? `${bot} starts an attack with ${c ?? 'a unit'}, then backs out`
                : `${bot} starts to ${a.detail ?? 'play'} ${c ?? 'a card'}, then backs out`;
        case 'trigger':
        case 'choose':
        case 'setup':
            return tail(`${bot} ${a.detail ?? info.verb}`);
        default:
            return tail(`${bot} ${info.verb}${c ? ` ${c}` : ''}`);
    }
}
