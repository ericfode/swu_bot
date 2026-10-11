'use strict';

/**
 * Fixed-size feature vectors for the learned bot.
 *
 * state(obs)            -> S numbers: the board from the deciding seat's point of view (public info + own hand)
 * prompt(sig, title)    -> P numbers: what kind of question is being asked
 * action(a, obs)        -> A numbers: one legal action (stdio shape, see observe.plainAction)
 *
 * Everything is computed from the stdio observation, so a Python or Rust bot can reproduce it from the protocol.
 * Values are scaled to roughly 0..1. Changing anything here changes the model input: bump VERSION and retrain.
 */
const { cardDb } = require('./cards');

const VERSION = 1;

const n = (x, d) => (Number.isFinite(x) ? x / d : 0);

function arenaFeats(units) {
    let power = 0, hp = 0, readyPower = 0, ready = 0, sentinel = 0, ups = 0, maxPower = 0;
    for (const u of units) {
        const rem = Math.max(0, (u.h ?? 0) - (u.d ?? 0));
        power += u.p ?? 0;
        hp += rem;
        maxPower = Math.max(maxPower, u.p ?? 0);
        if (!u.x) {
            readyPower += u.p ?? 0;
            ready++;
        }
        if (u.sn) {
            sentinel++;
        }
        ups += (u.u ?? []).length;
    }
    return [n(units.length, 6), n(power, 20), n(hp, 30), n(readyPower, 20), n(ready, 6), n(sentinel, 3), n(ups, 5), n(maxPower, 8)];
}

function sideFeats(ps, hasInit) {
    const baseHp = Math.max(0, (ps.base.hp ?? 30) - (ps.base.d ?? 0));
    return [
        n(baseHp, 30), n(ps.base.d ?? 0, 30), n(Math.max(0, 10 - baseHp), 10), baseHp <= 5 ? 1 : 0,
        n(ps.res.total, 10), n(ps.res.ready, 10),
        n(ps.handCount ?? (ps.hand ?? []).length, 10), n(ps.deck, 50), n((ps.discard ?? []).length, 20),
        hasInit ? 1 : 0, ps.leader?.dep ? 1 : 0, ps.leader?.x ? 1 : 0,
        ...arenaFeats(ps.ground ?? []), ...arenaFeats(ps.space ?? [])
    ];
}

function handFeats(hand, ready) {
    const db = cardDb();
    let units = 0, events = 0, upgrades = 0, costSum = 0, minCost = 99, affordable = 0, power = 0;
    for (const c of hand ?? []) {
        const d = db.get(c.s);
        if (!d) {
            continue;
        }
        if (d.types.includes('unit')) {
            units++;
            power += d.power;
        } else if (d.types.includes('event')) {
            events++;
        } else if (d.types.includes('upgrade')) {
            upgrades++;
        }
        costSum += d.cost;
        minCost = Math.min(minCost, d.cost);
        if (d.cost <= ready) {
            affordable++;
        }
    }
    const k = (hand ?? []).length;
    return [n(units, 6), n(events, 6), n(upgrades, 6), k ? n(costSum / k, 8) : 0, k ? n(minCost, 8) : 1, n(affordable, 5), n(power, 20)];
}

const PHASES = ['setup', 'action', 'regroup'];

function state(obs) {
    const me = obs.you;
    const opp = me === 'p1' ? 'p2' : 'p1';
    const P = obs.players;
    return [
        n(obs.round, 15), ...PHASES.map((x) => (obs.phase === x ? 1 : 0)), me === 'p1' ? 1 : 0,
        ...sideFeats(P[me], obs.initiative === me), ...sideFeats(P[opp], obs.initiative === opp),
        ...handFeats(P[me].hand, P[me].res.ready)
    ];
}

const PROMPT_TYPES = ['actionWindow', 'resource', 'initiative', 'optionalTrigger', 'triggerWindow', 'displayCards', 'distributeAmongTargets', 'number', 'batchTriggerResolution', 'passDelay'];
const TITLE_WORDS = [/attack/i, /defeat|damage|deal|destroy/i, /heal|shield|restore/i, /resource/i, /mulligan/i, /discard/i, /\bplay\b/i, /deploy/i, /exhaust/i, /return|capture/i, /ready/i, /friendly|your/i, /enemy|opponent/i];

function prompt(signature, title) {
    const parts = (signature ?? '-|-').split('|');
    const t = title ?? '';
    return [
        ...PROMPT_TYPES.map((x) => (parts[0] === x ? 1 : 0)), parts[0] === '-' ? 1 : 0,
        parts[1] === 'single' ? 1 : 0, parts[1] === 'multiple' ? 1 : 0,
        ...TITLE_WORDS.map((r) => (r.test(t) ? 1 : 0))
    ];
}

const KINDS = ['button', 'card', 'option', 'displayCard', 'perCardButton', 'distribute'];
const BUTTONS = [/^pass$/i, /^(done|confirm|submit|ok|continue)/i, /cancel|^no\b|skip|choose nothing|decline|don't/i, /trigger|^yes|^use|^play/i, /^keep/i, /mulligan/i, /yourself/i, /opponent/i, /resolve all/i];
const ZONE_LIST = ['hand', 'groundArena', 'spaceArena', 'base', 'resource', 'discard', 'deck'];
const KEYWORDS = ['sentinel', 'overwhelm', 'raid', 'saboteur', 'ambush', 'shielded', 'restore', 'grit', 'bounty', 'smuggle', 'piloting', 'hidden'];

function findUnit(obs, id) {
    for (const ps of Object.values(obs.players)) {
        for (const u of [...(ps.ground ?? []), ...(ps.space ?? [])]) {
            if (u.id === id) {
                return u;
            }
        }
    }
    return null;
}

function action(a, obs) {
    const f = KINDS.map((k) => (a.kind === k ? 1 : 0));
    const label = a.kind === 'perCardButton' ? String(a.label).split(':')[0] : String(a.label ?? '');
    f.push(...BUTTONS.map((r) => (a.kind === 'button' || a.kind === 'perCardButton') && r.test(label) ? 1 : 0));
    // card
    const c = a.card;
    const d = c ? cardDb().get(c.s) : null;
    const u = c ? findUnit(obs, c.id) : null;
    const isLeader = !!c && Object.values(obs.players).some((ps) => ps.leader?.id === c.id);
    const ready = obs.players[obs.you].res.ready;
    const zone = c ? (isLeader && !u ? 'leader' : c.zone) : null;
    f.push(...ZONE_LIST.map((z) => (zone === z ? 1 : 0)), zone === 'leader' ? 1 : 0);
    f.push(c && c.ctl === obs.you ? 1 : 0, c && c.ctl !== obs.you ? 1 : 0);
    const power = u ? u.p : d?.power ?? 0;
    const hp = u ? u.h : d?.hp ?? 0;
    const dmg = u ? u.d ?? 0 : 0;
    f.push(
        n(d?.cost ?? 0, 8), n(power, 8), n(hp, 8), n(dmg, 8), n(Math.max(0, hp - dmg), 8), u?.x ? 1 : 0, n((u?.u ?? []).length, 3),
        d && d.types.includes('unit') ? 1 : 0, d && d.types.includes('event') ? 1 : 0, d && d.types.includes('upgrade') ? 1 : 0,
        d && d.types.includes('base') ? 1 : 0, d && d.types.includes('leader') ? 1 : 0,
        d && d.cost <= ready ? 1 : 0, d && d.unique ? 1 : 0, n(d?.upgradePower ?? 0, 4), n(d?.upgradeHp ?? 0, 4)
    );
    f.push(...KEYWORDS.map((k) => (d && d.keywords.includes(k) ? 1 : 0)));
    // number / dropdown options and distribute amounts
    const num = a.kind === 'option' && /^#\d+$/.test(a.label) ? Number(a.label.slice(1)) : null;
    f.push(num !== null ? 1 : 0, n(num ?? 0, 10), a.kind === 'distribute' ? n(a.distribute?.amount ?? 0, 10) : 0);
    return f;
}

const S = state({ round: 0, phase: 'setup', initiative: null, you: 'p1', players: { p1: { base: {}, res: {}, hand: [] }, p2: { base: {}, res: {} } } }).length;
const P = prompt('-|-', '').length;
const A = action({ kind: 'button', label: 'Pass' }, { you: 'p1', players: { p1: { res: { ready: 0 } } } }).length;

const ARENA_NAMES = ['units', 'power', 'hp', 'ready power', 'ready units', 'sentinels', 'upgrades', 'max power'];
const SIDE_NAMES = ['base hp', 'base damage', 'base danger', 'base <= 5', 'resources', 'ready resources', 'hand size', 'deck size', 'discard size',
    'initiative', 'leader deployed', 'leader exhausted', ...ARENA_NAMES.map((x) => `ground ${x}`), ...ARENA_NAMES.map((x) => `space ${x}`)];
/** Human names of the state features, in order (for the dashboard panel). */
const STATE_NAMES = ['round', 'phase setup', 'phase action', 'phase regroup', 'seat p1',
    ...SIDE_NAMES.map((x) => `my ${x}`), ...SIDE_NAMES.map((x) => `opp ${x}`),
    'hand units', 'hand events', 'hand upgrades', 'hand avg cost', 'hand min cost', 'hand affordable', 'hand unit power'];
if (STATE_NAMES.length !== S) {
    throw new Error(`STATE_NAMES has ${STATE_NAMES.length} names for ${S} features`);
}

module.exports = { VERSION, S, P, A, STATE_NAMES, state, prompt, action };
