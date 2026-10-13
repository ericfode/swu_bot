import { BatchA16Signature, batchA16Covers, isBatchA16, batchA16IntermediateLayout } from './batchA16Signatures';
import { BatchA16SecondarySignature, batchA16SecondaryCovers, isBatchA16Secondary } from './batchA16SecondarySignatures';
import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { CardRef, Seat, UnitRef } from '../data/types';
import { isToken } from '../lib/cardText';
import { sideLayout } from '../components/Board';
import { useSettings, type Perspective } from '../lib/settings';
import type { CardEffectCue } from './types';
import { previewPlayCost } from './previewCosts';
import { A02_DEFINITIONS } from './batchA02';
import { easeInOut, easeOut, envelope, phase, useAnimationProgress } from './animationTimeline';
import { AbilityGlyph, CardGhost, Debris, EnergyBeam, OutcomeVisual, Shockwave, colorOf, hexPoints, offset, outcomeLabel, outcomeStats, screenCardSize, screenRotate, sequence, type EffectBox, type PlacedOutcome, type Point } from './primitives';
import './effects.css';
import { BatchA01Signature } from './batchA01Signatures';
import { BatchA02Signature, batchA02Covers, isBatchA02 } from './batchA02Signatures';
import { BatchA03Signature, batchA03Covers, isBatchA03 } from './batchA03Signatures';
import { BatchA04Signature, batchA04Covers, isBatchA04 } from './batchA04Signatures';
import { BatchA05Signature, batchA05Covers, isBatchA05 } from './batchA05Signatures';
import { BatchA05SecondarySignature, batchA05SecondaryCovers, isBatchA05Secondary } from './batchA05SecondarySignatures';
import { BatchA06SecondarySignature, batchA06SecondaryCovers, isBatchA06Secondary } from './batchA06SecondarySignatures';
import { BatchA06Signature, batchA06Covers, isBatchA06 } from './batchA06Signatures';
import { BatchA07SecondarySignature, batchA07SecondaryCovers, isBatchA07Secondary } from './batchA07SecondarySignatures';
import { BatchA07Signature, batchA07Covers, isBatchA07 } from './batchA07Signatures';
import { BatchA08SecondarySignature, batchA08SecondaryCovers, isBatchA08Secondary } from './batchA08SecondarySignatures';
import { BatchA08Signature, batchA08Covers, isBatchA08 } from './batchA08Signatures';
import { BatchA09SecondarySignature, batchA09SecondaryCovers, isBatchA09Secondary } from './batchA09SecondarySignatures';
import { BatchA09Signature, batchA09Covers, isBatchA09 } from './batchA09Signatures';
import { BatchA10Signature, batchA10Covers, isBatchA10 } from './batchA10Signatures';
import { BatchA10SecondarySignature, batchA10SecondaryCovers, isBatchA10Secondary } from './batchA10SecondarySignatures';
import { BatchA11SecondarySignature, batchA11SecondaryCovers, isBatchA11Secondary } from './batchA11SecondarySignatures';
import { BatchA11Signature, batchA11Covers, isBatchA11 } from './batchA11Signatures';
import { BatchA12SecondarySignature, batchA12SecondaryCovers, isBatchA12Secondary } from './batchA12SecondarySignatures';
import { BatchA13SecondarySignature, batchA13SecondaryCovers, isBatchA13Secondary } from './batchA13SecondarySignatures';
import { BatchA13Signature, batchA13Covers, isBatchA13 } from './batchA13Signatures';
import { BatchA14Signature, batchA14Covers, isBatchA14, batchA14IntermediateLayout } from './batchA14Signatures';
import { BatchA14SecondarySignature, batchA14SecondaryCovers, isBatchA14Secondary } from './batchA14SecondarySignatures';
import { BatchA15Signature, batchA15Covers, isBatchA15, batchA15IntermediateLayout } from './batchA15Signatures';
import { BatchA15SecondarySignature, batchA15SecondaryCovers, isBatchA15Secondary } from './batchA15SecondarySignatures';
import { BatchA12Signature, batchA12Covers, isBatchA12 } from './batchA12Signatures';

interface Props {
    cue: CardEffectCue | null;
    boardRef: RefObject<HTMLDivElement | null>;
    onComplete?: () => void;
    previewProgress?: number;
}

type Geometry = {
    source: EffectBox;
    target: EffectBox;
    friendlyBase: EffectBox;
    outcomes: PlacedOutcome[];
    zones: Record<string, EffectBox>;
    cards: Record<string, EffectBox>;
    endingCards: Record<string, EffectBox>;
    intermediateCards: Record<string, EffectBox>;
    pockets: Record<string, EffectBox>;
    endingPockets: Record<string, EffectBox>;
    endingCaptured: Record<string, EffectBox>;
    resourceCards: Record<string, EffectBox>;
    endingResources: Record<string, EffectBox>;
};
const W = 1000;
const H = 600;
const enemyOf = (seat: Seat): Seat => seat === 'p1' ? 'p2' : 'p1';
const fallback = (seat: Seat): EffectBox => ({ x: 530, y: seat === 'p1' ? 450 : 150, w: 78, h: 105, exact: false });
const cardKey = (card: CardRef | null | undefined) => card?.id ?? `${card?.s ?? ''}:${card?.n ?? ''}`;
const sameCard = (a: CardRef | null | undefined, b: CardRef | null | undefined) => !!a && !!b && cardKey(a) === cardKey(b);

function findCard(scope: Element, card: CardRef | null | undefined): HTMLElement | null {
    if (!card) return null;
    const cards = [...scope.querySelectorAll<HTMLElement>('[data-effect-card], [data-effect-upgrade]')];
    const matches = card.id ? cards.filter(el => el.dataset.effectId === card.id)
        : cards.filter(el => (el.dataset.effectCard ?? el.dataset.effectUpgrade) === card.n && (!card.s || el.dataset.effectCode === card.s));
    return matches.length === 1 ? matches[0] : null;
}

function findCaptured(scope: Element, captor: CardRef | null | undefined, captive: CardRef | null | undefined): HTMLElement | null {
    if (!captor || !captive) return null;
    const host = findCard(scope, captor);
    const pocket = host?.parentElement?.querySelector('[data-effect-pocket]');
    if (!pocket) return null;
    const slots = [...pocket.querySelectorAll<HTMLElement>('[data-effect-captured]')];
    const matches = captive.id ? slots.filter(slot => slot.dataset.effectId === captive.id)
        : slots.filter(slot => slot.dataset.effectCaptured === captive.n && (!captive.s || slot.dataset.effectCode === captive.s));
    return matches.length === 1 ? matches[0] : null;
}

function findResource(scope: Element, card: CardRef | null | undefined): HTMLElement | null {
    if (!card?.id) return null;
    const matches = [...scope.querySelectorAll<HTMLElement>('[data-effect-resource]')].filter(element => element.dataset.effectId === card.id);
    return matches.length === 1 ? matches[0] : null;
}

/** The probe uses the same fixed pocket footprint as the ordinary board. */
function endingPocket(board: Element, unit: UnitRef, seat: Seat): HTMLElement | null {
    if (unit.cap === undefined) return null;
    const existing = findCard(board, unit)?.parentElement?.querySelector('[data-effect-pocket]');
    const pocket = existing?.cloneNode(true) as HTMLElement | undefined ?? document.createElement('div');
    pocket.className = `captured-pocket${unit.cap.length > 1 ? ' multi' : ''}`;
    pocket.replaceChildren();
    const count = document.createElement('span');
    count.className = 'captured-count';
    count.innerHTML = `<span>CAPTIVE</span><b>${unit.cap.length}</b>`;
    const slots = document.createElement('div');
    slots.className = 'captured-slots';
    for (const captive of unit.cap) {
        const original = findCaptured(board, unit, captive);
        const slot = original?.cloneNode(true) as HTMLElement | undefined ?? document.createElement('span');
        slot.className = 'captured-slot';
        slot.dataset.effectCaptured = captive.n;
        if (captive.id) slot.dataset.effectId = captive.id;
        if (!original) {
            const tile = document.createElement('span'); tile.className = 'captured-unknown'; tile.textContent = '◇'; slot.append(tile);
            if (captive.owner) { const owner = document.createElement('small'); owner.textContent = captive.owner.toUpperCase(); slot.append(owner); }
        }
        slots.append(slot);
    }
    pocket.append(count, slots); pocket.dataset.effectCaptorSeat = seat;
    return pocket;
}

function project(element: Element, board: DOMRect, exact = false): EffectBox {
    const rect = element.getBoundingClientRect();
    const hp = element.hasAttribute('data-effect-base') ? element.parentElement?.querySelector('svg[aria-label^="Base HP"]')?.getBoundingClientRect() : null;
    const powerCounter = element.querySelector('.stat.pw')?.getBoundingClientRect(), hpCounter = element.querySelector('.stat.hp')?.getBoundingClientRect();
    const counter = (r: DOMRect) => ({ x: (r.left + r.width / 2 - board.left) / board.width * W, y: (r.top + r.height / 2 - board.top) / board.height * H, w: r.width / board.width * W, h: r.height / board.height * H });
    const statusBoxes = Object.fromEntries([...element.querySelectorAll<HTMLElement>('[data-effect-title-boost-id], [data-effect-generated-restriction-id], [data-effect-generated-sentinel-id], [data-effect-generated-sentinel-mark-id]')].map(status => [(status.dataset.effectTitleBoostId ?? status.dataset.effectGeneratedRestrictionId ?? status.dataset.effectGeneratedSentinelId ?? `${status.dataset.effectGeneratedSentinelMarkId}:sentinel`)!, counter(status.getBoundingClientRect())]));
    return { x: (rect.left + rect.width / 2 - board.left) / board.width * W,
        y: (rect.top + rect.height / 2 - board.top) / board.height * H,
        w: rect.width / board.width * W, h: rect.height / board.height * H, exact, sx: board.width / W, sy: board.height / H,
        ...(element instanceof HTMLElement && element.classList.contains('card') ? { cardSize: { w: element.offsetWidth, h: element.offsetHeight } } : {}),
        ...(Object.keys(statusBoxes).length ? { statusBoxes } : {}),
        ...(powerCounter && hpCounter ? { counters: { power: counter(powerCounter), hp: counter(hpCounter) } } : {}),
        ...(hp ? { stat: { x: (hp.left + hp.width / 2 - board.left) / board.width * W, y: (hp.top + hp.height / 2 - board.top) / board.height * H, w: hp.width / board.width * W, h: hp.height / board.height * H } } : {}) };
}

type EndingLayout = { arrivals: Map<string, EffectBox>; intermediate: Map<string, EffectBox>; hands: Map<string, EffectBox>; waypoints: Map<string, EffectBox>; pockets: Map<string, EffectBox>; captured: Map<string, EffectBox>; resources: Map<string, EffectBox>; laneHeights: Map<HTMLElement, number> };

/** Mirror the ordinary card's stacked facts, so final names/statuses place counters at their real height. */
function endingCardFacts(card: HTMLElement, unit: UnitRef, seat: Seat, leader: boolean) {
    card.classList.remove('sm', 'lg', 'xl', 'wide', 'card-back');
    card.classList.add('named');
    card.classList.toggle('exh', unit.x === 1);
    card.style.removeProperty('--w');
    card.querySelector('.top')?.remove();
    card.querySelector('.ups')?.remove();
    const top = document.createElement('div'); top.className = 'top';
    const marks = document.createElement('span'); marks.className = 'marks';
    const mark = (cls: string, text: string) => {
        const item = document.createElement('span'); item.className = `mark ${cls}`; item.textContent = text; marks.append(item); return item;
    };
    if (leader) mark('leader', 'Leader');
    if (unit.t === 1 || isToken(unit)) mark('token', 'TOKEN');
    if (unit.sn) {
        const sentinel = mark('sentinel', 'SEN');
        const generated = unit.status?.find(status => status.generatedSentinel)?.generatedSentinel;
        if (generated) sentinel.dataset.effectGeneratedSentinelMarkId = generated.id;
    }
    if (unit.cap?.length) mark('cap', `CAP${unit.cap.length > 1 ? ` ${unit.cap.length}` : ''}`);
    if (marks.childElementCount) top.append(marks);
    if (top.childElementCount || unit.u?.length) card.append(top);

    const foot = card.querySelector<HTMLElement>('.foot') ?? document.createElement('div');
    foot.className = 'foot';
    const lens = foot.querySelector('.lens');
    foot.replaceChildren();
    const saboteurLost = unit.status?.some(status => status.lostKeyword === 'Saboteur');
    const shown = unit.status?.filter(status => !(saboteurLost && status.keyword?.name === 'Saboteur') && !(status.keywordWindow && status.keyword?.name === 'Sentinel'));
    if (shown?.length) {
        const statuses = document.createElement('div'); statuses.className = 'card-statuses';
        Object.assign(statuses.style, { position: 'static', marginInline: '2px' });
        for (const status of shown) {
            const item = document.createElement('span');
            item.className = `card-status ${status.kind}${status.lostKeyword && status.keywordWindow ? ' keyword-window' : ''}${status.grantedAbility ? ' granted' : ''}${status.generatedRestriction ? ' generated-restriction' : ''}${status.generatedSentinel ? ' generated-sentinel' : ''}${status.keyword?.name === 'Restore' ? ' restore' : ''}${status.keyword?.name === 'Overwhelm' && status.duration === 'phase' ? ' overwhelm' : ''}`;
            if (status.titleBoost) item.dataset.effectTitleBoostId = status.titleBoost.id;
            if (status.generatedRestriction) item.dataset.effectGeneratedRestrictionId = status.generatedRestriction.id;
            if (status.generatedSentinel) item.dataset.effectGeneratedSentinelId = status.generatedSentinel.id;
            const lines = status.lostKeyword === 'Saboteur' && status.keywordWindow ? unit.sn ? ['SENTINEL · PHASE', 'NO SABOTEUR'] : ['NO SABOTEUR', 'PHASE']
                : status.generatedRestriction && status.restriction === 'cannot-attack-base' ? ['NO BASE', 'PHASE']
                : status.generatedSentinel ? ['SENTINEL', 'PHASE']
                : status.grantedAbility ? ['WHEN DEFEATED', status.grantedAbility.effect === 'create-clone' ? 'CREATE CLONE' : 'ENEMY UNIT 2', 'PHASE']
                : status.keyword?.name === 'Restore' ? [`RESTORE ${status.keyword.amount}${status.duration === 'phase' ? ' · PHASE' : ''}`]
                : status.keyword?.name === 'Overwhelm' && status.duration === 'phase' ? ['OVERWHELM', 'PHASE']
                : status.restriction === 'must-attack' && status.duration === 'next-action' ? [`NEXT ${seat.toUpperCase()} ACTION`, 'ATTACK IF ABLE'] : [status.label];
            lines.forEach((line, i) => { if (i) item.append(document.createElement('br')); item.append(document.createTextNode(line)); });
            statuses.append(item);
        }
        foot.append(statuses);
    }
    if (lens) foot.append(lens);
    const stats = document.createElement('div'); stats.className = 'stats';
    const power = document.createElement('span'); power.className = 'stat pw'; power.textContent = String(unit.p);
    const hp = document.createElement('span'); hp.className = `stat hp${unit.d > 0 ? ' hurt' : ''}`;
    if (unit.d > 0) { const damage = document.createElement('span'); damage.className = 'dmg'; damage.textContent = String(unit.d); hp.append(damage); }
    hp.append(document.createTextNode(String(unit.h - unit.d))); stats.append(power, hp); foot.append(stats);
    const name = document.createElement('span'); name.className = 'nmbar'; name.textContent = unit.n; foot.append(name);
    card.append(foot);
    return top;
}

/** Let the existing flex/grid CSS lay out the ending arena, including wrapped mobile rows. */
function measureEndingLayout(board: HTMLDivElement, cue: CardEffectCue, layout = cue.transition?.after, perspective: Perspective = 'god'): EndingLayout {
    const result: EndingLayout = { arrivals: new Map(), intermediate: new Map(), hands: new Map(), waypoints: new Map(), pockets: new Map(), captured: new Map(), resources: new Map(), laneHeights: new Map() };
    if (!layout || !cue.outcomes?.some(outcome => ['control', 'play', 'create', 'draw', 'recover', 'return', 'rescue', 'attach', 'capture', 'resource'].includes(outcome.kind) || isBatchA06(cue) && outcome.kind === 'attack' || outcome.kind === 'defeat' && outcome.zone === 'leader' || outcome.kind === 'buff' && !!outcome.cards?.length || isBatchA03(cue) && outcome.kind === 'discard') || !board.parentElement) return result;
    const rect = board.getBoundingClientRect();
    if (!rect.width || !rect.height) return result;
    const probe = board.cloneNode(true) as HTMLDivElement;
    probe.querySelectorAll('.card-effect-overlay').forEach(element => element.remove());
    Object.assign(probe.style, { position: 'absolute', left: '0', top: '0', width: `${rect.width}px`, height: 'auto', visibility: 'hidden', pointerEvents: 'none' });
    probe.setAttribute('aria-hidden', 'true');
    probe.inert = true;
    const cards = new Map<string, HTMLElement>();
    const pockets = new Map<string, HTMLElement>(), captured = new Map<string, HTMLElement>(), resources = new Map<string, HTMLElement>();
    const lanes = new Map<HTMLElement, HTMLElement>();
    const sideProbes: { row: HTMLElement; hq: HTMLElement; wide: boolean; ground: number; space: number }[] = [];
    const template = board.querySelector<HTMLElement>('.lane .card') ?? board.querySelector<HTMLElement>('.card:not(.wide)');
    for (const seat of ['p1', 'p2'] as Seat[]) {
        const side = probe.querySelector(`[data-effect-seat="${seat}"]`);
        const originalSide = board.querySelector(`[data-effect-seat="${seat}"]`);
        for (const arena of ['ground', 'space'] as const) {
            const lane = side?.querySelector<HTMLElement>(`[data-effect-zone="${arena}"]`);
            const original = originalSide?.querySelector<HTMLElement>(`[data-effect-zone="${arena}"]`);
            if (!lane || !original) continue;
            const label = lane.querySelector('.lane-label');
            lane.replaceChildren(...(label ? [label] : []));
            for (const unit of layout.players[seat][arena]) {
                const previous = findCard(board, unit);
                // A former upgrade has a chip footprint; arena entries need the ordinary card footprint.
                const existing = previous?.classList.contains('card') ? previous : template;
                if (!existing) continue;
                const card = existing.cloneNode(true) as HTMLElement;
                const leader = layout.players[seat].leader;
                const leaderMark = !!leader?.dep && (unit.n === leader.n && unit.s === leader.s || !!unit.u?.some(upgrade => upgrade.n === leader.n));
                // A new arrival cannot inherit a template unit's positional score or search tag.
                if (existing !== previous || !previous?.closest('.lane')) { card.querySelector('.lens')?.remove(); card.classList.remove('lensed'); }
                const top = endingCardFacts(card, unit, seat, leaderMark);
                // Explicit animation boards keep individual physical upgrades inside the top rail.
                if (unit.u?.length) {
                    const upgrades = document.createElement('div');
                    upgrades.className = 'ups';
                    for (const upgrade of unit.u) {
                        const chip = document.createElement('span');
                        chip.className = `up${upgrade.t ? ' token' : ''}${upgrade.t && upgrade.n === 'Shield' ? ' shield' : ''}${upgrade.s === 'SOR_054' ? ' lightsaber' : ''}`;
                        chip.textContent = upgrade.n;
                        if (upgrade.controller && upgrade.owner && upgrade.controller !== upgrade.owner) {
                            chip.classList.add('transferred');
                            const name = document.createElement('span'); name.className = 'up-name'; name.textContent = upgrade.n;
                            chip.replaceChildren(name);
                            const label = document.createElement('small'); label.textContent = `O:${upgrade.owner.toUpperCase()} C:${upgrade.controller.toUpperCase()}`; chip.append(label);
                        }
                        upgrades.append(chip);
                        cards.set(`${seat}:${cardKey(upgrade)}`, chip);
                    }
                    top.append(upgrades);
                }
                const wrapper = document.createElement('div');
                wrapper.className = 'relative';
                wrapper.append(card);
                const pocket = endingPocket(board, unit, seat);
                if (pocket) {
                    wrapper.append(pocket);
                    pockets.set(`${seat}:${cardKey(unit)}`, pocket);
                    const slots = [...pocket.querySelectorAll<HTMLElement>('.captured-slot')];
                    unit.cap?.forEach((captive, i) => captured.set(`${seat}:${cardKey(unit)}:${cardKey(captive)}`, slots[i]));
                }
                lane.append(wrapper);
                cards.set(`${seat}:${cardKey(unit)}`, card);
            }
            const reserved = Number(original.dataset.effectReservedSlots ?? 0);
            for (let i = layout.players[seat][arena].length; i < reserved; i++) {
                const wrapper = document.createElement('div'); wrapper.className = 'relative arena-footprint'; wrapper.setAttribute('aria-hidden', 'true');
                const footprint = document.createElement('div'); footprint.className = 'card'; wrapper.append(footprint); lane.append(wrapper);
            }
            lanes.set(original, lane);
        }
        const row = side?.querySelector<HTMLElement>('[data-effect-zone="ground"]')?.parentElement;
        const hq = side?.querySelector<HTMLElement>('.base-frame')?.parentElement;
        const breakpoint = originalSide?.querySelector<HTMLElement>(':scope > span[aria-hidden="true"]');
        if (row && hq && breakpoint) sideProbes.push({ row, hq, wide: getComputedStyle(breakpoint).display !== 'none',
            ground: Math.max(layout.players[seat].ground.length, Number(originalSide?.querySelector<HTMLElement>('[data-effect-zone="ground"]')?.dataset.effectReservedSlots ?? 0)),
            space: Math.max(layout.players[seat].space.length, Number(originalSide?.querySelector<HTMLElement>('[data-effect-zone="space"]')?.dataset.effectReservedSlots ?? 0)) });
        const pips = side?.querySelector<HTMLElement>('[data-effect-zone="resources"]');
        if (pips) {
            const player = layout.players[seat];
            pips.replaceChildren();
            pips.style.maxWidth = !player.resources && player.res.total > 12 ? `${Math.ceil(player.res.total / 2) * 12}px` : '';
            for (let i = 0; i < player.res.total; i++) { const pip = document.createElement('i'); if (i >= player.res.ready) pip.className = 'spent'; pips.append(pip); }
        }
        const rack = side?.querySelector<HTMLElement>('.resource-manifest');
        const finalResources = layout.players[seat].resources;
        if (rack && finalResources) {
            const templateSlot = rack.querySelector<HTMLElement>('.resource-slot');
            rack.replaceChildren();
            finalResources.forEach((resource, i) => {
                const slot = templateSlot?.cloneNode(true) as HTMLElement | undefined ?? document.createElement('span');
                slot.className = `resource-slot${resource.x ? ' spent' : ''}`; slot.textContent = '';
                const number = document.createElement('b'); number.textContent = String(i + 1); slot.append(number);
                rack.append(slot); resources.set(`${seat}:${cardKey(resource)}`, slot);
            });
        }
        const leader = side?.querySelector<HTMLElement>('[data-effect-zone="leader"]');
        if (leader && cue.outcomes.some(outcome => outcome.kind === 'defeat' && outcome.zone === 'leader' && outcome.ownerSeat === seat)) {
            // The ending leader uses the ordinary small landscape card's exhausted footprint.
            leader.classList.add('exh'); cards.set(`${seat}:${cardKey(layout.players[seat].leader)}`, leader);
        }
        const hand = side?.querySelector<HTMLElement>('[data-effect-zone="hand"]');
        if (hand) {
            const finalHand = layout.players[seat].hand, count = layout.players[seat].handCount ?? finalHand.length;
            const visible = perspective === 'god' || perspective === seat;
            const handTemplate = originalSide?.querySelector<HTMLElement>('[data-effect-zone="hand"] .card:not(.card-back)')
                ?? board.querySelector<HTMLElement>('[data-effect-zone="hand"] .card:not(.card-back)') ?? template;
            const label = hand.querySelector<HTMLElement>('.hand-label') ?? document.createElement('span');
            label.className = 'hand-label'; label.textContent = `Hand · ${count}${count !== finalHand.length ? ` (${finalHand.length} listed)` : ''}`;
            const strip = hand.querySelector<HTMLElement>('.hand-cards') ?? document.createElement('div');
            strip.className = 'hand-cards'; strip.replaceChildren();
            const handValue = finalHand.length ? hand.querySelector(':scope > .lens-chip') : null;
            hand.replaceChildren(label, strip, ...(handValue ? [handValue] : []));
            for (const item of finalHand) {
                const previous = visible ? findCard(board, item) : null;
                const original = previous?.classList.contains('card') ? previous : handTemplate;
                const card = visible && original ? original.cloneNode(true) as HTMLElement : document.createElement('div');
                if (visible) {
                    card.classList.remove('lg', 'xl', 'wide', 'exh', 'named', 'lensed', 'card-back');
                    card.classList.add('card', 'sm'); card.style.removeProperty('--w');
                    card.querySelector('.top')?.remove(); card.querySelector('.foot')?.remove();
                } else card.className = 'card card-back sm';
                const wrapper = document.createElement('div'); wrapper.className = 'hand-card'; wrapper.append(card);
                if (visible) { const name = document.createElement('span'); name.className = 'hand-name'; name.textContent = item.n; wrapper.append(name); }
                strip.append(wrapper); cards.set(`${seat}:${cardKey(item)}`, card);
            }
            if (!finalHand.length) { const empty = document.createElement('span'); empty.className = 'text-faint text-xs self-center'; empty.textContent = 'empty'; strip.append(empty); }
        }
    }
    // No duplicate identities, seats, or IDs are exposed to board/capture queries.
    for (const element of [probe, ...probe.querySelectorAll<HTMLElement>('*')]) {
        for (const attribute of [...element.attributes]) {
            if (attribute.name.startsWith('data-effect-') || attribute.name === 'id') element.removeAttribute(attribute.name);
        }
        element.style.transition = 'none';
        element.style.animation = 'none';
    }
    try {
        board.parentElement.append(probe);
        // Reuse the real Side decision with final counts; a crowded arrival/return can change both the
        // lane split and whether HQ sits above them. Keep reserved footprints in the same calculation.
        for (const { row, hq, wide, ground, space } of sideProbes) {
            const { stack, weights } = sideLayout({ row: Math.round(row.clientWidth), hqW: Math.round(hq.offsetWidth), hqH: Math.round(hq.offsetHeight), wide }, ground, space);
            row.classList.toggle('@2xl:grid-cols-[minmax(0,var(--gw,1fr))_auto_minmax(0,var(--sw,1fr))]', !stack);
            hq.parentElement?.classList.toggle('@2xl:col-span-1', !stack);
            hq.parentElement?.classList.toggle('@2xl:order-none', !stack);
            for (const [i, key] of ['--gw', '--sw'].entries()) {
                if (weights) row.style.setProperty(key, `${weights[i]}fr`);
                else row.style.removeProperty(key);
            }
        }
        const bounds = probe.getBoundingClientRect();
        const origin = new DOMRect(bounds.left, bounds.top, rect.width, rect.height);
        cards.forEach((card, key) => result.arrivals.set(key, project(card, origin, true)));
        for (const seat of ['p1', 'p2'] as Seat[]) for (const card of layout.players[seat].hand) {
            const element = cards.get(`${seat}:${cardKey(card)}`);
            if (element) result.hands.set(`${seat}:${cardKey(card)}`, project(element, origin, true));
        }
        pockets.forEach((pocket, key) => result.pockets.set(key, project(pocket, origin, true)));
        captured.forEach((slot, key) => result.captured.set(key, project(slot, origin, true)));
        resources.forEach((slot, key) => result.resources.set(key, project(slot, origin, true)));
        lanes.forEach((lane, original) => result.laneHeights.set(original, lane.getBoundingClientRect().height));
    } finally {
        probe.remove();
    }
    return result;
}

/** Explicit staged return/draw then hand-play gets a measured hand waypoint,
 * separate from the same physical card's final arena or attachment position.
 * This probe is presentation geometry and never changes either truth snapshot. */
function measureHandWaypoints(board: HTMLDivElement, cue: CardEffectCue, ending: EndingLayout, perspective: Perspective) {
    if (!cue.exampleLabel || !cue.transition) return;
    for (const [index, play] of (cue.outcomes ?? []).entries()) {
        if (play.kind !== 'play' || play.fromZone !== 'hand' || (!play.requiresReturn && play.playAs !== 'upgrade') || !play.card?.id) continue;
        const seat = play.fromSeat ?? play.ownerSeat ?? play.seat;
        const incoming = cue.outcomes?.slice(0, index).find(outcome => outcome.seat === seat &&
            (outcome.kind === 'return' && outcome.destination === 'hand' && sameCard(outcome.card, play.card)
                || outcome.kind === 'draw' && (sameCard(outcome.card, play.card) || outcome.cards?.some(card => sameCard(card, play.card)))));
        if (!incoming) continue;
        const waypoint = structuredClone(cue.transition.after);
        for (const side of ['p1', 'p2'] as Seat[]) for (const arena of ['ground', 'space'] as const) {
            waypoint.players[side][arena] = waypoint.players[side][arena].filter(unit => !sameCard(unit, play.card));
            for (const unit of waypoint.players[side][arena]) unit.u = unit.u?.filter(upgrade => !sameCard(upgrade, play.card));
        }
        if (!waypoint.players[seat].hand.some(card => sameCard(card, play.card))) waypoint.players[seat].hand.push(play.card);
        const measured = measureEndingLayout(board, cue, waypoint, perspective).hands.get(`${seat}:${cardKey(play.card)}`);
        if (measured) ending.waypoints.set(`${seat}:${cardKey(play.card)}`, measured);
    }
}

/** Measure an explicitly declared play before its later sacrifices without replacing either truth snapshot. */
function measureIntermediateEntries(board: HTMLDivElement, cue: CardEffectCue, ending: EndingLayout, perspective: Perspective) {
    const intermediateLayout = batchA14IntermediateLayout(cue) ?? batchA15IntermediateLayout(cue) ?? batchA16IntermediateLayout(cue);
    if (intermediateLayout) {
        const measured = measureEndingLayout(board, cue, intermediateLayout, perspective);
        measured.arrivals.forEach((box, key) => ending.intermediate.set(key, box));
        measured.laneHeights.forEach((height, lane) => ending.laneHeights.set(lane, Math.max(height, ending.laneHeights.get(lane) ?? 0)));
        return;
    }
    if (!['consolidation-of-power', 'the-invasion-of-christophsis'].includes(cue.definition.id) || !cue.exampleLabel || !cue.transition) return;
    const layout = structuredClone(cue.transition.before);
    let measured = false;
    if (cue.definition.id === 'the-invasion-of-christophsis') {
        const exploit = cue.playPayment?.kind === 'resources' ? cue.playPayment.exploit : undefined;
        if (!exploit || exploit.sourceId !== cue.source?.id) return;
        const prefix = cue.outcomes?.slice(0, exploit.units.length);
        if (!prefix || prefix.length !== exploit.units.length || prefix.some((o, i) => o.kind !== 'defeat' || o.prevented || o.paymentRole !== 'exploit' || o.seat !== cue.seat || o.card?.id !== exploit.units[i].id || o.incarnation !== exploit.units[i].incarnation || o.sourceCard?.id !== cue.source?.id)) return;
        for (const arena of ['ground', 'space'] as const) layout.players[cue.seat][arena] = layout.players[cue.seat][arena].filter(u => !exploit.units.some(c => c.id === u.id && c.incarnation === u.incarnation));
        measured = true;
    }
    for (const [index, play] of (cue.outcomes ?? []).entries()) {
        if (play.kind !== 'play' || play.prevented || play.entryType !== 'played' || play.fromZone !== 'hand' || play.fromSeat !== cue.seat || play.seat !== cue.seat || !play.unit?.id || !play.chosenUnitGroup || !play.chosenUnits
            || !layout.players[cue.seat].hand.some(c => sameCard(c, play.card))
            || cue.outcomes?.slice(0, index).some(o => o.kind === 'defeat' && o.chosenUnitGroup === play.chosenUnitGroup)) continue;
        const arena = play.zone === 'space' ? 'space' : 'ground';
        layout.players[cue.seat].hand = layout.players[cue.seat].hand.filter(c => !sameCard(c, play.card) && !sameCard(c, cue.source));
        layout.players[cue.seat][arena].push(structuredClone(play.unit));
        measured = true;
    }
    if (!measured) return;
    const intermediate = measureEndingLayout(board, cue, layout, perspective);
    intermediate.arrivals.forEach((box, key) => ending.intermediate.set(key, box));
    intermediate.laneHeights.forEach((height, lane) => ending.laneHeights.set(lane, Math.max(height, ending.laneHeights.get(lane) ?? 0)));
}

function readGeometry(board: HTMLDivElement | null, cue: CardEffectCue, ending?: EndingLayout): Geometry {
    const rect = board?.getBoundingClientRect();
    const zones: Record<string, EffectBox> = {};
    const cards: Record<string, EffectBox> = {};
    const pockets: Record<string, EffectBox> = {};
    const resourceCards: Record<string, EffectBox> = {};
    const seats: Seat[] = ['p1', 'p2'];
    for (const seat of seats) {
        const side = board?.querySelector(`[data-effect-seat="${seat}"]`);
        const center = rect?.width && rect.height && side ? project(side, rect) : fallback(seat);
        zones[`${seat}:center`] = { ...center, w: 90, h: 120 };
        for (const zone of ['ground', 'space', 'base', 'hand', 'deck', 'discard', 'resources', 'leader', 'resource-count', 'resource-cards', 'hand-count', 'base-protection']) {
            const element = zone === 'base' ? side?.querySelector('[data-effect-base]') : side?.querySelector(`[data-effect-zone="${zone}"]`);
            let measured = element && rect?.width && rect.height ? project(element, rect, zone === 'base') : { ...center, x: zone === 'deck' ? 150 : zone === 'discard' ? 245 : center.x, y: center.y + (zone === 'hand' ? 55 : 0), w: 65, h: 88 };
            if (zone === 'hand' && element && rect?.width && rect.height) {
                const cards = [...element.querySelectorAll('[data-effect-card], .card-back')];
                const first = cards[0], last = cards[cards.length - 1];
                if (first && last) {
                    const a = project(first, rect), b = project(last, rect);
                    measured = { ...a, x: (a.x - a.w / 2 + b.x + b.w / 2) / 2, y: a.y, w: b.x + b.w / 2 - a.x + a.w / 2, h: Math.max(a.h, b.h), exact: false, count: cards.length };
                }
            }
            zones[`${seat}:${zone}`] = measured;
        }
        if (side && rect?.width && rect.height) for (const permission of side.querySelectorAll<HTMLElement>('[data-effect-zone^="discard-permission"]')) {
            zones[seat + ':' + permission.dataset.effectZone] = project(permission, rect, true);
        }
    }
    const playerEffect = board?.querySelector('[data-effect-zone="player-effect"]');
    if (playerEffect && rect?.width && rect.height) zones['player-effect'] = project(playerEffect, rect, true);
    const locate = (card: CardRef | null | undefined, seat: Seat, zone?: string): EffectBox => {
        const side = board?.querySelector(`[data-effect-seat="${seat}"]`);
        const element = side ? zone === 'resources' ? findResource(side, card) : findCard(side, card) ?? (!zone ? findResource(side, card) : null) : null;
        if (element && rect?.width && rect.height) return project(element, rect, true);
        return zones[`${seat}:${zone ?? 'center'}`] ?? fallback(seat);
    };
    if (cue.transition) for (const seat of seats) {
        const player = cue.transition.before.players[seat];
        for (const card of [...player.hand, ...player.ground, ...player.space]) cards[`${seat}:${cardKey(card)}`] = locate(card, seat);
        for (const resource of player.resources ?? []) resourceCards[`${seat}:${cardKey(resource)}`] = locate(resource, seat, 'resources');
        for (const unit of [...player.ground, ...player.space]) for (const upgrade of unit.u ?? []) cards[`${seat}:${cardKey(upgrade)}`] = locate(upgrade, seat);
        if (board && rect?.width && rect.height) for (const unit of [...player.ground, ...player.space]) {
            const pocket = findCard(board, unit)?.parentElement?.querySelector('[data-effect-pocket]');
            if (pocket) pockets[`${seat}:${cardKey(unit)}`] = project(pocket, rect, true);
        }
    }
    const source = locate(cue.source, cue.seat);
    const target = locate(cue.target, cue.targetSeat ?? enemyOf(cue.seat));
    const positions = new Map<string, number>();
    const destinations = new Map<string, EffectBox>();
    const hasAttachmentEntry = cue.outcomes?.some(outcome => outcome.kind === 'attach' && !!outcome.unit);
    const outcomes = (cue.outcomes ?? []).map((outcome, index): PlacedOutcome => {
        const movement = ['draw', 'discard', 'mill', 'return', 'recover', 'resource'].includes(outcome.kind);
        const initialZone = outcome.kind === 'defeat' ? undefined : outcome.zone;
        let box = locate(outcome.card, outcome.seat, initialZone);
        if (!box.exact && sameCard(outcome.card, cue.target)) box = target;
        const zone = (name: string) => zones[`${outcome.seat}:${name}`];
        const hand = zone('hand');
        const handSize = screenCardSize(hand, 42, 60);
        const handArrival = { ...hand, x: Math.min(W - handSize.w / 2 - 8, hand.x + hand.w / 2 + handSize.w / 2 + 8), ...handSize };
        let from = box;
        let to = box;
        if (outcome.sourceCard) from = locate(outcome.sourceCard, outcome.fromSeat ?? cue.seat);
        const finalHand = ending?.waypoints.get(`${outcome.seat}:${cardKey(outcome.card)}`) ?? ending?.hands.get(`${outcome.seat}:${cardKey(outcome.card)}`) ?? handArrival;
        if (outcome.kind === 'draw') { from = zone('deck'); to = finalHand; }
        if (outcome.kind === 'discard') {
            const originSeat = outcome.fromSeat ?? outcome.seat;
            from = outcome.fromZone === 'deck' ? zones[`${originSeat}:deck`]
                : outcome.fromZone === 'resources' ? locate(outcome.card, originSeat, 'resources')
                : locate(outcome.card, originSeat, outcome.fromZone ?? 'hand');
            if (outcome.fromZone === 'capture') {
                const slot = board && rect?.width && rect.height ? findCaptured(board, outcome.sourceCard, outcome.card) : null;
                from = slot && rect ? project(slot, rect, true) : { ...locate(outcome.sourceCard, originSeat), exact: false };
            }
            to = zone('discard');
        }
        if (outcome.kind === 'mill') { from = zone('deck'); to = zone('discard'); }
        if (outcome.kind === 'return') {
            // Attached cards start at their own measured box on the controller's side.
            // Their host is evidence, rather than the object being moved.
            const origin = locate(outcome.card, outcome.fromSeat ?? outcome.seat, outcome.fromZone);
            from = origin.exact ? origin : box.exact ? box : sameCard(outcome.card, cue.target) ? target : zones[`${outcome.fromSeat ?? outcome.seat}:ground`];
            to = outcome.destination === 'deck-bottom' ? zones[`${outcome.ownerSeat ?? outcome.seat}:deck`] : finalHand;
        }
        if (outcome.kind === 'recover') { from = zone('discard'); to = outcome.zone === 'deck' ? zone('deck') : finalHand; }
        if (outcome.kind === 'resource') { from = outcome.fromZone ? locate(outcome.card, outcome.fromSeat ?? outcome.seat, outcome.fromZone) : zone('resources'); to = ending?.resources.get(`${outcome.seat}:${cardKey(outcome.card)}`) ?? zone('resources'); }
        if (outcome.kind === 'defeat') to = ending?.arrivals.get(`${outcome.ownerSeat ?? outcome.seat}:${cardKey(outcome.card)}`) ?? zones[`${outcome.ownerSeat ?? outcome.card?.owner ?? outcome.seat}:${outcome.zone === 'leader' ? 'leader' : 'discard'}`];
        if (outcome.kind === 'attach') {
            from = locate(outcome.card, outcome.fromSeat ?? outcome.seat, outcome.fromZone);
            to = ending?.arrivals.get(`${outcome.seat}:${cardKey(outcome.card)}`) ?? { ...(outcome.unit ? zone(outcome.zone === 'space' ? 'space' : 'ground') : locate(outcome.targetCard, outcome.seat, outcome.zone)), exact: false }; box = to;
        }
        if (outcome.kind === 'capture') {
            from = locate(outcome.card, outcome.fromSeat ?? outcome.seat, outcome.fromZone);
            to = ending?.captured.get(`${outcome.seat}:${cardKey(outcome.sourceCard)}:${cardKey(outcome.card)}`) ?? { ...locate(outcome.sourceCard, outcome.seat, outcome.zone), exact: false }; box = to;
        }
        if (outcome.kind === 'create') {
            const destination = zone(outcome.zone === 'space' ? 'space' : 'ground');
            to = ending?.arrivals.get(outcome.seat + ':' + cardKey(outcome.card)) ?? { ...destination, exact: false };
            from = to; box = to;
        }
        if (outcome.kind === 'control' || outcome.kind === 'play' || outcome.kind === 'rescue') {
            const arena = outcome.zone === 'space' ? 'space' : 'ground';
            from = locate(outcome.card, outcome.fromSeat ?? outcome.seat, outcome.fromZone ?? (outcome.kind === 'play' ? 'hand' : arena));
            if (outcome.kind === 'play' && outcome.fromZone === 'hand') from = ending?.waypoints.get(`${outcome.fromSeat ?? outcome.seat}:${cardKey(outcome.card)}`) ?? from;
            if (outcome.kind === 'rescue' && board && rect?.width && rect.height) {
                const pocket = findCaptured(board, outcome.sourceCard, outcome.card);
                from = pocket ? project(pocket, rect, true) : { ...locate(outcome.sourceCard, outcome.fromSeat ?? outcome.seat, outcome.fromZone), exact: false };
            }
            const destination = zone(arena);
            // Final snapshot identity and measured card CSS choose the actual landing slot.
            // If no ending evidence exists, keep the arena focus explicitly inexact.
            to = ending?.arrivals.get(`${outcome.seat}:${cardKey(outcome.card)}`)
                ?? { ...destination, ...screenCardSize(destination, 72, 101), exact: false };
            box = to;
            destinations.set(cardKey(outcome.card), to);
        }
        if (outcome.kind === 'search') { from = zone('deck'); to = zone('deck'); box = from; }
        if (outcome.kind === 'delay') { box = destinations.get(cardKey(outcome.card)) ?? box; from = box; to = box; }
        if (movement) box = to;
        const positionKey = `${outcome.seat}:${Math.round(box.x)}:${Math.round(box.y)}`;
        const slot = positions.get(positionKey) ?? 0;
        positions.set(positionKey, slot + 1);
        return { outcome, box, from, to, slot, ...(hasAttachmentEntry && outcome.kind === 'draw' ? { routeLabels: false } : {}), key: `${outcome.seat}:${cardKey(outcome.card)}:${outcome.kind}:${index}` };
    });
    return { source, target, friendlyBase: zones[`${cue.seat}:base`], zones, cards, endingCards: Object.fromEntries(ending?.arrivals ?? []), intermediateCards: Object.fromEntries(ending?.intermediate ?? []), pockets, endingPockets: Object.fromEntries(ending?.pockets ?? []), endingCaptured: Object.fromEntries(ending?.captured ?? []), resourceCards, endingResources: Object.fromEntries(ending?.resources ?? []), outcomes };
}

const retain = (before: EffectBox, after: EffectBox) => before.exact && !after.exact ? before : after;

/** A cue owns one Anime timeline. Seeking renders the exact same geometry as live playback. */
export function CardEffectOverlay({ cue, boardRef, onComplete, previewProgress }: Props) {
    return cue ? <EffectScene key={cue.key} cue={cue} boardRef={boardRef} onComplete={onComplete} previewProgress={previewProgress} /> : null;
}

function EffectScene({ cue, boardRef, onComplete, previewProgress }: Omit<Props, 'cue'> & { cue: CardEffectCue }) {
    const perspective = useSettings(settings => settings.perspective);
    // During render the ref can still contain the preceding cue's board. Measure
    // only after React commits this cue; an old exact box must never seed retain().
    const [geometry, setGeometry] = useState(() => readGeometry(null, cue));
    const captionRef = useRef<HTMLDivElement>(null);
    const progress = useAnimationProgress(cue.definition.durationMs, previewProgress ?? cue.previewProgress, onComplete);
    useLayoutEffect(() => {
        const board = boardRef.current;
        const originalHeights = new Map<HTMLElement, string>();
        const originalPadding = board?.style.getPropertyValue('padding-bottom') ?? '';
        const originalPaddingPriority = board?.style.getPropertyPriority('padding-bottom') ?? '';
        const handArrival = cue.outcomes?.some(outcome => outcome.seat === 'p1' && (outcome.kind === 'draw' || outcome.kind === 'return' && outcome.destination !== 'deck-bottom' && !outcome.label?.startsWith('TOKEN CEASES') || outcome.kind === 'recover' && outcome.zone === 'hand'
            || cue.definition.id === 'smoke-and-cinders' && outcome.kind === 'discard' && outcome.fromZone === 'hand' && outcome.chooserSeat === 'p1'));
        const handDeparture = cue.outcomes?.some(outcome => outcome.kind === 'play' && outcome.fromZone === 'hand' && (outcome.fromSeat ?? outcome.seat) === 'p1'
            && cue.transition?.before.players.p1.hand.some(card => sameCard(card, outcome.card)));
        const countedHand = cue.outcomes?.some(outcome => {
            const basis = outcome.basis, afterHand = cue.transition?.after.players.p1.hand;
            return basis?.kind === 'hand-count' && basis.player === 'p1' && basis.value > 0 && !!afterHand && basis.value === afterHand.length
                && basis.sourceIds.length === afterHand.length && new Set(basis.sourceIds).size === basis.sourceIds.length
                && basis.sourceIds.every(id => afterHand.some(card => card.id === id) && cue.transition?.before.players.p1.hand.some(card => card.id === id && !sameCard(card, cue.source)));
        });
        // Reserve the actual paid source too; early disposal must remain above the caption.
        const paidHandSource = (() => {
            if (!(isBatchA09(cue) || isBatchA09Secondary(cue) || isBatchA10(cue) || isBatchA10Secondary(cue) || isBatchA11(cue) || isBatchA11Secondary(cue) || isBatchA12Secondary(cue) || isBatchA13Secondary(cue) || isBatchA13(cue) || isBatchA14Secondary(cue) || isBatchA14(cue) || isBatchA15Secondary(cue) || isBatchA16Secondary(cue) || isBatchA16(cue) || isBatchA15(cue) || isBatchA12(cue) || cue.definition.id === 'uwing-reinforcement') || cue.stage || cue.seat !== 'p1' || !cue.transition || !cue.source?.id || cue.source.owner !== 'p1' || cue.source.n !== cue.definition.name) return false;
            if (cue.definition.id === 'uwing-reinforcement') {
                const canonical = A02_DEFINITIONS.find(d => d.id === cue.definition.id), before = cue.transition.before.players.p1, after = cue.transition.after.players.p1;
                if (!canonical || cue.playPayment !== undefined || cue.definition.name !== canonical.name || cue.definition.setCode !== canonical.setCode || cue.source.n !== canonical.name || cue.source.s !== canonical.setCode || cue.transition.before.round !== cue.transition.after.round || cue.transition.before.phase !== cue.transition.after.phase) return false;
                let cost: number; try { cost = previewPlayCost(canonical, cue.transition.before, 'p1', undefined); } catch { return false; }
                const source = (card: CardRef) => card.id === cue.source!.id && card.n === canonical.name && card.s === canonical.setCode && card.owner === 'p1';
                return cue.playCost === cost && before.hand.filter(source).length === 1 && !after.hand.some(card => card.id === cue.source!.id) && after.discard.filter(source).length === 1 && before.res.total === after.res.total && before.res.ready - after.res.ready === cost;
            }
            if (cue.playPayment?.kind !== 'resources' || cue.playPayment.smuggle) return false;
            const before = cue.transition.before.players.p1, after = cue.transition.after.players.p1, paid = cue.playPayment.cardIds;
            let cost: number; try { cost = previewPlayCost(cue.definition, cue.transition.before, 'p1', cue.playPayment); } catch { return false; }
            return cue.playCost === cost && !!paid && paid.length === cost && new Set(paid).size === cost
                && paid.every(id => before.resources?.some(r => r.id === id && !r.x))
                && before.hand.filter(c => sameCard(c, cue.source) && c.n === cue.source!.n && c.s === cue.source!.s && c.owner === 'p1').length === 1
                && !after.hand.some(c => sameCard(c, cue.source)) && after.discard.filter(c => sameCard(c, cue.source) && c.n === cue.source!.n && c.s === cue.source!.s && c.owner === 'p1').length === 1;
        })();
        const permissionClearance = !!cue.transition && [cue.transition.before, cue.transition.after].some(s => !!s.discardPlayPermissions?.length);
        const handClearance = handArrival || handDeparture || countedHand || paidHandSource || permissionClearance;
        const restorePadding = () => {
            if (!board) return;
            if (originalPadding) board.style.setProperty('padding-bottom', originalPadding, originalPaddingPriority);
            else board.style.removeProperty('padding-bottom');
        };
        const reserveCaptionFooter = () => {
            if (!board || !handClearance || !captionRef.current) return;
            // Keep actual hand arrivals and supported hand departures above the caption.
            // Padding changes the SVG projection, so every point is measured again afterward.
            restorePadding();
            const hand = board.querySelector<HTMLElement>('[data-effect-seat="p1"] [data-effect-zone="hand"]');
            if (!hand) return;
            const caption = captionRef.current;
            const bottom = Number.parseFloat(getComputedStyle(caption).bottom) || 0;
            const permissions = board.querySelector<HTMLElement>('[data-effect-seat="p1"] [data-effect-zone="discard-permissions"]');
            const handBottom = hand.getBoundingClientRect().bottom;
            const contentBottom = Math.max(handBottom, permissions?.getBoundingClientRect().bottom ?? handBottom);
            const needed = Math.max(0, contentBottom - board.getBoundingClientRect().bottom + caption.getBoundingClientRect().height + bottom + 10);
            const padding = Number.parseFloat(getComputedStyle(board).paddingBottom) || 0;
            board.style.setProperty('padding-bottom', `${padding + Math.ceil(needed)}px`);
        };
        const update = () => {
            originalHeights.forEach((height, lane) => { lane.style.minHeight = height; });
            reserveCaptionFooter();
            let ending = board ? measureEndingLayout(board, cue, undefined, perspective) : undefined;
            if (ending && board) measureIntermediateEntries(board, cue, ending, perspective);
            let expanded = false;
            ending?.laneHeights.forEach((height, lane) => {
                if (height <= lane.getBoundingClientRect().height + .5) return;
                if (!originalHeights.has(lane)) originalHeights.set(lane, lane.style.minHeight);
                lane.style.minHeight = `${height}px`;
                expanded = true;
            });
            // Reserve a wrapped arrival row before movement so it cannot cover the hand.
            if (expanded && board) {
                ending = measureEndingLayout(board, cue, undefined, perspective);
                measureIntermediateEntries(board, cue, ending, perspective);
            }
            if (ending && board) measureHandWaypoints(board, cue, ending, perspective);
            const next = readGeometry(board, cue, ending);
            setGeometry(previous => ({ ...next, source: retain(previous.source, next.source), target: retain(previous.target, next.target),
                outcomes: next.outcomes.map(placed => {
                    const before = previous.outcomes.find(item => item.key === placed.key);
                    return before ? { ...placed, box: retain(before.box, placed.box), from: retain(before.from, placed.from) } : placed;
                }) }));
        };
        update();
        if (!board) return;
        const observer = new ResizeObserver(update);
        observer.observe(board);
        if (handClearance && captionRef.current) observer.observe(captionRef.current);
        window.addEventListener('resize', update);
        return () => {
            observer.disconnect(); window.removeEventListener('resize', update);
            originalHeights.forEach((height, lane) => { lane.style.minHeight = height; });
            restorePadding();
        };
    }, [boardRef, cue, perspective]);
    const color = cue.definition.color;
    const heavy = ['superlaser-blast', 'bombing-run', 'overwhelming-barrage'].includes(cue.definition.id);
    const impact = envelope(progress, .34, .44, .65);
    const shake = heavy ? Math.sin(progress * 165) * impact * 4 : 0;
    const stage = progress < .3 ? 'ANTICIPATION' : progress < .63 ? 'RESOLUTION' : 'OUTCOME';
    const signatureSearch = cue.definition.id === 'recruit' && geometry.outcomes.some(item => item.outcome.kind === 'search');
    const covered = (placed: PlacedOutcome) => isBatchA02(cue) && batchA02Covers(cue, geometry, placed) || isBatchA03(cue) && batchA03Covers(cue, geometry, placed) || isBatchA04(cue) && batchA04Covers(cue, geometry, placed) || isBatchA05(cue) && batchA05Covers(cue, geometry, placed) || isBatchA05Secondary(cue) && batchA05SecondaryCovers(cue, geometry, placed) || isBatchA06Secondary(cue) && batchA06SecondaryCovers(cue, geometry, placed) || isBatchA06(cue) && batchA06Covers(cue, geometry, placed) || isBatchA07Secondary(cue) && batchA07SecondaryCovers(cue, geometry, placed) || isBatchA07(cue) && batchA07Covers(cue, geometry, placed) || isBatchA08Secondary(cue) && batchA08SecondaryCovers(cue, geometry, placed) || isBatchA08(cue) && batchA08Covers(cue, geometry, placed) || isBatchA09Secondary(cue) && batchA09SecondaryCovers(cue, geometry, placed) || isBatchA09(cue) && batchA09Covers(cue, geometry, placed) || isBatchA10(cue) && batchA10Covers(cue, geometry, placed) || isBatchA10Secondary(cue) && batchA10SecondaryCovers(cue, geometry, placed) || isBatchA11Secondary(cue) && batchA11SecondaryCovers(cue, geometry, placed) || isBatchA11(cue) && batchA11Covers(cue, geometry, placed) || isBatchA12Secondary(cue) && batchA12SecondaryCovers(cue, geometry, placed) || isBatchA12(cue) && batchA12Covers(cue, geometry, placed) || isBatchA13Secondary(cue) && batchA13SecondaryCovers(cue, geometry, placed) || isBatchA13(cue) && batchA13Covers(cue, geometry, placed) || isBatchA14Secondary(cue) && batchA14SecondaryCovers(cue, geometry, placed) || isBatchA14(cue) && batchA14Covers(cue, geometry, placed) || isBatchA15Secondary(cue) && batchA15SecondaryCovers(cue, geometry, placed) || isBatchA16Secondary(cue) && batchA16SecondaryCovers(cue, geometry, placed) || isBatchA16(cue) && batchA16Covers(cue, geometry, placed) || isBatchA15(cue) && batchA15Covers(cue, geometry, placed);
    const badgeGroups = groupBadges(geometry.outcomes.filter(({ outcome }) => {
        if (cue.definition.id === 'power-failure' && outcome.kind === 'defeat' && !sameCard(outcome.card, cue.target)) return false;
        if (signatureSearch && ['search', 'draw'].includes(outcome.kind)) return false;
        if (cue.definition.id === 'change-of-heart' && ['control', 'delay'].includes(outcome.kind)) return false;
        if (cue.stage !== 'regroup-start' && cue.definition.id === 'sneak-attack' && ['play', 'delay', 'cost', 'pay'].includes(outcome.kind)) return false;
        return true;
    }).filter(placed => !covered(placed)));
    const badgeStacks = new Map<string, typeof badgeGroups>();
    for (const badge of badgeGroups) {
        const key = `${Math.round(badge.placed.box.x)}:${Math.round(badge.placed.box.y)}`;
        badgeStacks.set(key, [...(badgeStacks.get(key) ?? []), badge]);
    }
    const stats = geometry.outcomes.filter(placed => !covered(placed) && outcomeStats(placed.outcome, !!cue.exampleLabel) && !geometry.outcomes.some(item => item.outcome.kind === 'defeat' && sameCard(item.outcome.card, placed.outcome.card)));
    const baseOpacity = .15 + envelope(progress, .01, .2, .76) * (heavy ? .46 : .28);
    return <div className={`card-effect-overlay ce-${cue.definition.id}`} data-effect-progress={progress.toFixed(4)} style={{ '--ce-color': color } as CSSProperties} aria-hidden="true">
        <div className="ce-table-vignette" style={{ opacity: baseOpacity }} />
        <svg className="ce-canvas" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ transform: `translate(${shake}px, ${shake * -.37}px)` }}>
            <defs>
                <filter id={`ce-glow-${cue.definition.id}`} x="-120%" y="-120%" width="340%" height="340%"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                <radialGradient id={`ce-halo-${cue.definition.id}`}><stop offset="0" stopColor="#fff3d2" stopOpacity=".8" /><stop offset=".16" stopColor={color} stopOpacity=".6" /><stop offset=".55" stopColor={color} stopOpacity=".18" /><stop offset="1" stopColor={color} stopOpacity="0" /></radialGradient>
            </defs>
            <g className="ce-scene">
                <Signature cue={cue} geometry={geometry} p={progress} />
                {geometry.outcomes.filter(placed => !covered(placed) && !(cue.definition.id === 'power-failure' && placed.outcome.kind === 'defeat')
                    && !(cue.definition.id === 'recruit' && placed.outcome.kind === 'draw' && geometry.outcomes.some(item => item.outcome.kind === 'search')))
                    .map(placed => <OutcomeVisual key={placed.key} placed={placed} p={progress} />)}
            </g>
        </svg>
        <div className="ce-outcome-labels">
            {[...badgeStacks].map(([key, stack]) => {
                const companionDraw = stack.some(({ placed }) => placed.outcome.kind === 'draw' && placed.routeLabels === false);
                const originalBox = stack[0].placed.box;
                const box = companionDraw ? { ...originalBox, x: originalBox.x + 120 / (originalBox.sx ?? 1) } : originalBox;
                // A removed unit leaves room for its receipt. Keep it on that
                // footprint so opposing arena-wide results cannot share a row.
                const tombstone = box.exact && stack.some(({ placed }) => placed.outcome.kind === 'defeat');
                const attachmentEntry = stack.some(({ placed }) => placed.outcome.kind === 'attach' && !!placed.outcome.unit);
                const above = !attachmentEntry && !companionDraw && (box.y > H * .65 || (stack.length > 2 && box.y > H * .45));
                const badgeY = tombstone || companionDraw ? box.y : box.y + (above ? -1 : 1) * (attachmentEntry ? box.h / 2 + 7 : Math.min(box.h / 2 + 7, 72));
                return <div key={key} className="ce-outcome-stack" style={{ left: `clamp(42px, ${box.x / W * 100}%, calc(100% - 42px))`, top: `clamp(40px, ${badgeY / H * 100}%, calc(100% - 75px))`, width: `calc(${box.w / W * 100}% + 4px)`, transform: `translate(-50%, ${tombstone ? '-50%' : above ? '-100%' : '0'})` }}>
                    {stack.map(({ placed, label }, i) => <div key={placed.key} className={`ce-outcome-badge ce-badge-${placed.outcome.kind}`} style={{ '--ce-proof': colorOf(placed.outcome.kind), opacity: easeOut(phase(progress, .51 + i * .025, .69 + i * .025)) } as CSSProperties}>
                        <svg viewBox="-22 -22 44 44"><AbilityGlyph kind={placed.outcome.kind} /></svg><span>{label}</span>
                    </div>)}
                </div>;
            })}
            {stats.map(placed => {
                const stat = outcomeStats(placed.outcome, !!cue.exampleLabel)!;
                const base = placed.outcome.zone === 'base';
                const anchor = base && placed.box.stat ? placed.box.stat : { x: placed.box.x + placed.box.w / 2, y: placed.box.y + placed.box.h / 2, w: placed.box.w, h: 24 };
                return <div key={`stat-${placed.key}`} className={`ce-stat-proof${base ? ' ce-stat-base' : ''}${stat.power != null ? ' ce-stat-pair' : ''}`} style={{ left: `${anchor.x / W * 100}%`, top: `${anchor.y / H * 100}%`, width: `${anchor.w / W * 100}%`, ...(base ? { height: `${anchor.h / H * 100}%` } : {}), '--ce-proof': colorOf(placed.outcome.kind), opacity: phase(progress, .42, .62) } as CSSProperties}>
                    {stat.power != null && <span className="ce-stat-power">{stat.power}<small>PWR</small></span>}<span>{stat.hp}<small>HP</small></span>
                </div>;
            })}
        </div>
        <div className="ce-phase-tag"><span className="ce-phase-dot" /><span>{stage}</span><span>{Math.round(progress * 100)}%</span></div>
        <div ref={captionRef} className="ce-caption" style={{ opacity: easeOut(phase(progress, 0, .08)) }}>
            <span className="ce-caption-mark">✦</span><div><span className="ce-caption-label">{cue.exampleLabel ? 'CHOREOGRAPHED EXAMPLE' : 'RECORDED CARD EFFECT'}</span><strong>{cue.definition.name}</strong><span className="ce-caption-description">{cue.exampleLabel ?? (geometry.outcomes.length ? 'Observed outcomes highlighted on the table' : 'No resolved outcomes are available in this recording')}</span></div>
            <span className="ce-caption-bar" style={{ transform: `scaleX(${1 - progress})` }} />
        </div>
    </div>;
}

function groupBadges(outcomes: PlacedOutcome[]): { placed: PlacedOutcome; label: string }[] {
    const groups = new Map<string, { placed: PlacedOutcome; count: number; label: string }>();
    for (const placed of outcomes) {
        const o = placed.outcome;
        const movement = ['draw', 'discard', 'mill', 'recover', 'resource'].includes(o.kind);
        const key = movement ? `${o.kind}:${o.seat}:${o.zone}` : placed.key;
        const existing = groups.get(key);
        if (existing) {
            existing.count += typeof o.amount === 'number' ? o.amount : 1;
            existing.label = `${existing.count} ${o.kind === 'recover' && o.zone === 'deck' ? '→ DECK BOTTOM' : o.kind === 'discard' || o.kind === 'mill' ? '→ DISCARD' : 'CARDS'}`;
        } else groups.set(key, { placed, count: typeof o.amount === 'number' ? o.amount : 1, label: outcomeLabel(o) });
    }
    return [...groups.values()];
}

function Arc({ from, to, p, start = .19, end = .5, color = '#fff2c9', bend = -100, width = 4 }: { from: Point; to: Point; p: number; start?: number; end?: number; color?: string; bend?: number; width?: number }) {
    const t = phase(p, start, end);
    return <path d={`M${from.x} ${from.y} Q${(from.x + to.x) / 2 + bend} ${(from.y + to.y) / 2 + bend} ${to.x} ${to.y}`} pathLength="1" stroke={color} strokeWidth={width} strokeDasharray="1" strokeDashoffset={1 - easeOut(t)} opacity={envelope(p, start, start + .1, end + .2)} className="ce-energy-arc" />;
}

function lightningPath(from: Point, to: Point, p: number, seed: number): string {
    const dx = to.x - from.x, dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    return sequence(18).map(i => {
        const t = i / 17;
        const deviation = i === 0 || i === 17 ? 0 : Math.sin(i * 5.3 + seed * 4.2 + p * 24) * (22 + seed * 4);
        return `${i ? 'L' : 'M'}${from.x + dx * t - dy / length * deviation} ${from.y + dy * t + dx / length * deviation}`;
    }).join(' ');
}

function Halo({ at, id, radius = 170, opacity = 1 }: { at: Point; id: string; radius?: number; opacity?: number }) {
    return <circle cx={at.x} cy={at.y} r={radius} fill={`url(#ce-halo-${id})`} stroke="none" opacity={opacity} />;
}

function Signature({ cue, geometry: g, p }: { cue: CardEffectCue; geometry: Geometry; p: number }) {
    if (isBatchA10(cue)) return <BatchA10Signature cue={cue} geometry={g} p={p} />;
    if (isBatchA10Secondary(cue)) return <BatchA10SecondarySignature cue={cue} geometry={g} p={p} />;
    if (isBatchA11Secondary(cue)) return <BatchA11SecondarySignature cue={cue} geometry={g} p={p} />;
    if (isBatchA11(cue)) return <BatchA11Signature cue={cue} geometry={g} p={p} />;
    if (isBatchA13(cue)) return <BatchA13Signature cue={cue} geometry={g} p={p} />;
    if (isBatchA13Secondary(cue)) return <BatchA13SecondarySignature cue={cue} geometry={g} p={p} />;
    if (isBatchA14(cue)) return <BatchA14Signature cue={cue} geometry={g} p={p} />;
    if (isBatchA14Secondary(cue)) return <BatchA14SecondarySignature cue={cue} geometry={g} p={p} />;
    if (isBatchA15(cue)) return <BatchA15Signature cue={cue} geometry={g} p={p} />;
    if (isBatchA16(cue)) return <BatchA16Signature cue={cue} geometry={g} p={p} />;
    if (isBatchA16Secondary(cue)) return <BatchA16SecondarySignature cue={cue} geometry={g} p={p} />;
    if (isBatchA15Secondary(cue)) return <BatchA15SecondarySignature cue={cue} geometry={g} p={p} />;
    if (isBatchA12Secondary(cue)) return <BatchA12SecondarySignature cue={cue} geometry={g} p={p} />;
    if (isBatchA12(cue)) return <BatchA12Signature cue={cue} geometry={g} p={p} />;
    if (isBatchA09(cue)) return <BatchA09Signature cue={cue} geometry={g} p={p} />;
    if (isBatchA09Secondary(cue)) return <BatchA09SecondarySignature cue={cue} geometry={g} p={p} />;
    if (isBatchA08(cue)) return <BatchA08Signature cue={cue} geometry={g} p={p} />;
    if (isBatchA08Secondary(cue)) return <BatchA08SecondarySignature cue={cue} geometry={g} p={p} />;
    if (isBatchA06(cue)) return <BatchA06Signature cue={cue} geometry={g} p={p} />;
    if (isBatchA06Secondary(cue)) return <BatchA06SecondarySignature cue={cue} geometry={g} p={p} />;
    if (isBatchA07Secondary(cue)) return <BatchA07SecondarySignature cue={cue} geometry={g} p={p} />;
    if (isBatchA07(cue)) return <BatchA07Signature cue={cue} geometry={g} p={p} />;
    if (isBatchA05(cue)) return <BatchA05Signature cue={cue} geometry={g} p={p} />;
    if (isBatchA05Secondary(cue)) return <BatchA05SecondarySignature cue={cue} geometry={g} p={p} />;
    if (isBatchA04(cue)) return <BatchA04Signature cue={cue} geometry={g} p={p} />;
    if (isBatchA03(cue)) return <BatchA03Signature cue={cue} geometry={g} p={p} />;
    if (isBatchA02(cue)) return <BatchA02Signature cue={cue} geometry={g} p={p} />;
    if (['moment-of-peace', 'mission-briefing', 'keep-fighting', 'outmaneuver', 'attack-pattern-delta', 'power-failure', 'change-of-heart', 'sneak-attack', 'recruit', 'strike-true'].includes(cue.definition.id)) {
        return <BatchA01Signature cue={cue} geometry={g} p={p} />;
    }
    const id = cue.definition.id;
    const source = g.source;
    const primary = g.outcomes.find(({ outcome }) => sameCard(outcome.card, cue.target) && !['draw', 'discard', 'recover', 'resource'].includes(outcome.kind))?.box
        ?? g.outcomes.find(({ outcome }) => ['damage', 'defeat', 'debuff', 'suppress', 'heal', 'buff', 'shield'].includes(outcome.kind))?.box ?? g.target;
    const damage = g.outcomes.filter(item => item.outcome.kind === 'damage');
    const defeats = g.outcomes.filter(item => item.outcome.kind === 'defeat');
    const buff = g.outcomes.find(item => item.outcome.kind === 'buff');
    const heal = g.outcomes.find(item => item.outcome.kind === 'heal');
    const power = envelope(p, .02, .24, .67);
    const hit = envelope(p, .3, .43, .76);
    const charge = easeOut(phase(p, .01, .3));
    const rotate = p * 140;
    const targetTransform = `translate(${primary.x} ${primary.y})`;
    if (!g.outcomes.length) return <g transform={`translate(${source.x} ${source.y})`} opacity={power}>
        <circle r={45 + charge * 40} strokeDasharray="4 13" strokeWidth="2" /><path d={hexPoints(0, 0, 30 + charge * 10)} strokeWidth="3" />
    </g>;
    switch (id) {
        case 'open-fire':
            return <>
                <g transform={`translate(${source.x} ${source.y})`} opacity={power}><circle r={28 + charge * 25} strokeWidth="3" /><path d="M-64 -13 H-23 L-5 -35 M-64 13 H-23 L-5 35 M64 -13 H23 L5 -35 M64 13 H23 L5 35" strokeWidth="4" /></g>
                {sequence(3).map(i => <g key={i}><EnergyBeam from={offset(source, (i - 1) * 23, 0)} to={offset(primary, (i - 1) * 13, 0)} p={p} start={.18 + i * .065} end={.42 + i * .065} width={7} /><Shockwave at={primary} p={p} start={.35 + i * .065} radius={100 + i * 35} /></g>)}
                <Halo at={primary} id={id} opacity={hit * .8} radius={200} />
            </>;
        case 'force-lightning':
            return <>
                <g transform={`translate(${source.x} ${source.y})`} opacity={power}><path d={hexPoints(0, 0, 50 + charge * 35)} transform={`rotate(${rotate})`} strokeDasharray="13 7" strokeWidth="3" /><circle r={25 * charge} fill="#dac6ff" stroke="none" /></g>
                {sequence(4).map(i => <path key={i} d={lightningPath(offset(source, (i - 1.5) * 13, 0), offset(primary, (i - 1.5) * 12, 0), p, i)} opacity={envelope(p, .18 + i * .035, .35, .68)} stroke={i ? '#b985ff' : '#f6e5ff'} strokeWidth={i ? 3 : 6} className="ce-lightning-line" />)}
                <g transform={targetTransform} opacity={hit}><circle r="105" stroke="#c89cff" strokeWidth="4" strokeDasharray="10 15" transform={`rotate(${-rotate})`} /><path d="M-86 86 L86 -86" stroke="#e4c9ff" strokeWidth="9" /></g>
                <Halo at={primary} id={id} opacity={hit * .5} /><Debris at={primary} p={p} count={32} radius={175} color="#c193ff" />
            </>;
        case 'force-choke':
            return <>
                <Arc from={source} to={primary} p={p} color="#ef798c" width={2} bend={70} />
                <g transform={targetTransform} opacity={power}>{sequence(5).map(i => <ellipse key={i} cx="0" cy={(i - 2) * (primary.h / 5)} rx={(primary.w * 1.3 + 25) * (1 - phase(p, .17, .47) * .62)} ry="14" strokeWidth={i % 2 ? 3 : 5} transform={`rotate(${(i - 2) * 8})`} />)}
                    <path d={`M${-primary.w * .9} ${-primary.h * .55} L${-primary.w * .65} 0 L${-primary.w * .9} ${primary.h * .55} M${primary.w * .9} ${-primary.h * .55} L${primary.w * .65} 0 L${primary.w * .9} ${primary.h * .55}`} strokeWidth="5" />
                </g>
                <Debris at={primary} p={p} inward start={.06} radius={240} count={30} color="#e96584" /><Halo at={primary} id={id} opacity={hit * .55} />
            </>;
        case 'takedown':
            return <>
                <g transform={`${targetTransform} rotate(${(1 - easeOut(phase(p, .01, .27))) * -50}) scale(${1.45 - charge * .45})`} opacity={power}>
                    <path d="M-105 -47 V-105 H-47 M47 -105 H105 V-47 M105 47 V105 H47 M-47 105 H-105 V47" strokeWidth="4" /><circle r="69" strokeDasharray="7 16" /><path d="M-145 0 H-40 M40 0 H145 M0 -145 V-40 M0 40 V145" strokeWidth="2" />
                </g><EnergyBeam from={source} to={primary} p={p} start={.27} end={.46} width={11} color="#a9e4ff" /><Shockwave at={primary} p={p} start={.41} radius={230} color="#85d1f3" />
            </>;
        case 'vanquish':
            return <>
                <Arc from={source} to={primary} p={p} start={.06} end={.27} color="#b6dcff" width={2} bend={120} />
                <g transform={targetTransform} opacity={power}><path d={`M${-primary.w * .9} ${primary.h * .65} L${primary.w * .9} ${-primary.h * .65}`} stroke="#a4cfff" strokeWidth="2" strokeDasharray="4 7" /></g>
                <EnergyBeam from={offset(primary, -190, 190)} to={offset(primary, 190, -190)} p={p} start={.23} end={.51} color="#accdff" width={14} />
                <EnergyBeam from={offset(primary, -125, 188)} to={offset(primary, 207, -125)} p={p} start={.3} end={.57} color="#719bff" width={5} /><Debris at={primary} p={p} count={35} radius={230} color="#d0e1ff" />
            </>;
        case 'superlaser-blast': {
            // The beam detonates over the table; rays terminate only on unit defeat receipts. Bases are never targets.
            const emitter = { x: 500, y: 300 };
            const fire = envelope(p, .26, .4, .62);
            return <>
                <g transform="translate(500 300)" opacity={power}>
                    {sequence(12).map(i => { const angle = i * Math.PI / 6; return <path key={i} d={`M${Math.cos(angle) * (320 - charge * 220)} ${Math.sin(angle) * (220 - charge * 150)} L0 0`} stroke="#a8ff6a" strokeWidth={i % 3 ? 2 : 4} />; })}
                    <circle r={95 - charge * 72} stroke="#b7ff8a" strokeWidth="5" strokeDasharray="15 9" transform={`rotate(${rotate})`} /><circle r={35 * charge} fill="#f1ffd2" stroke="none" />
                </g>
                <path d="M-100 300 H500" stroke="#97ff63" strokeWidth={60 * fire} opacity={fire * .55} /><path d="M-100 300 H500" stroke="#efffd0" strokeWidth={15 * fire} opacity={fire} />
                <Halo at={emitter} id={id} radius={360} opacity={fire} />
                {defeats.map((item, i) => <g key={item.key}><EnergyBeam from={emitter} to={item.box} p={p} start={.32 + i * .012} end={.49 + i * .012} color="#9aff64" width={7} /><Shockwave at={item.box} p={p} start={.42 + i * .012} radius={95} color="#bdff81" /></g>)}
                <Shockwave at={emitter} p={p} start={.34} radius={610} color="#aaff75" squash={.53} /><Shockwave at={emitter} p={p} start={.43} radius={530} color="#e2ffc9" squash={.55} /><Debris at={emitter} p={p} start={.32} radius={460} count={55} color="#adff70" />
            </>;
        }
        case 'overwhelming-barrage': {
            const turret = buff?.box ?? primary;
            return <>
                <g transform={`translate(${turret.x} ${turret.y})`} opacity={power}><circle r={Math.max(turret.w, turret.h) * .7} stroke="#fbd77f" strokeWidth="3" strokeDasharray="8 13" transform={`rotate(${rotate})`} /><g transform="translate(0 -52)"><AbilityGlyph kind="buff" size={38} /></g></g>
                {damage.map((item, i) => <g key={item.key}>{sequence(3).map(j => <EnergyBeam key={j} from={offset(turret, (j - 1) * 15, 0)} to={offset(item.box, (j - 1) * 12, 0)} p={p} start={.29 + i * .045 + j * .025} end={.49 + i * .045 + j * .025} width={5} color="#ffb057" />)}<Shockwave at={item.box} p={p} start={.45 + i * .03} radius={140} /></g>)}
            </>;
        }
        case 'bombing-run':
            return <>
                <path d={`M-80 ${primary.y - 105} L1080 ${primary.y - 105}`} stroke="#ffbf75" strokeWidth="2" strokeDasharray="9 11" opacity={power * .55} />
                <g transform={`translate(${-100 + easeInOut(phase(p, .05, .69)) * 1200} ${primary.y - 105})`} opacity={power}><path d="M-80 0 L-30 -10 L-12 -40 L10 -40 L18 -10 L75 0 L18 10 L10 40 L-12 40 L-30 10 Z" fill="#111e2f" stroke="#ffc887" strokeWidth="3" /><path d="M-80 -6 H-180 M-80 6 H-145" strokeWidth="4" opacity=".6" /></g>
                {damage.map((item, i) => <g key={item.key}><EnergyBeam from={offset(item.box, -95, -160)} to={item.box} p={p} start={.22 + i * .038} end={.43 + i * .038} color="#ffd082" width={7} /><Halo at={item.box} id={id} radius={115} opacity={envelope(p, .34 + i * .025, .46 + i * .025, .76)} /><Shockwave at={item.box} p={p} start={.38 + i * .03} radius={135} /></g>)}
            </>;
        case 'make-an-opening':
            return <>
                <g transform={`${targetTransform} scale(1 ${Math.min(1, (primary.sx ?? 1) / (primary.sy ?? 1))})`} opacity={power}><g transform={`rotate(${30 * (1 - charge)}) scale(${1.3 - phase(p, .1, .44) * .6})`}><path d={hexPoints(0, 0, 110)} stroke="#d5a6ff" strokeWidth="5" /><path d="M-63 -13 H63 M-63 13 H63" stroke="#e5caff" strokeWidth="4" /></g></g>
                {heal && sequence(7).map(i => <Arc key={i} from={primary} to={heal.box} p={p} start={.26 + i * .025} end={.6 + i * .02} color="#68efaf" bend={(i - 3) * 35} width={3} />)}
                {heal && <Shockwave at={heal.box} p={p} start={.54} radius={125} color="#68efaf" squash={.6} />}
            </>;
        case 'repair':
            return <>
                <g transform={targetTransform} opacity={power}>
                    {sequence(4).map(i => <g key={i} transform={`rotate(${i * 90}) translate(0 ${-(115 - charge * 55)})`}><path d="M-18 -12 H18 V12 H-18 Z M-7 0 H7 M0 -6 V6" stroke="#9cffcb" strokeWidth="3" /><path d="M0 15 V55" stroke="#66edab" strokeWidth="2" strokeDasharray="5 6" /></g>)}
                    <circle r={100 - charge * 26} stroke="#78f8b6" strokeWidth="2" strokeDasharray="7 10" transform={`rotate(${rotate})`} />
                </g><Debris at={primary} p={p} inward start={.08} radius={220} count={32} color="#6df8b5" /><Halo at={primary} id={id} opacity={hit * .6} />
            </>;
        case 'restock': {
            const recovered = g.outcomes.filter(item => item.outcome.kind === 'recover');
            const from = recovered[0]?.from ?? source, to = recovered[0]?.to ?? primary;
            return <>
                <Arc from={from} to={to} p={p} start={.05} end={.52} color="#b4edbb" width={5} bend={-120} />
                <g transform={`translate(${from.x} ${from.y})`} opacity={power}><path d="M-53 -24 A62 42 0 1 1 -25 42 M-25 42 L-40 20 M-25 42 L0 35" strokeWidth="4" /></g>
                <g transform={`translate(${to.x} ${to.y})`} opacity={phase(p, .43, .67)}><path d="M-43 34 H43 M-43 41 H43 M-43 48 H43 M0 70 V51 M-10 61 L0 51 L10 61" strokeWidth="4" /></g>
                <Debris at={to} p={p} start={.5} radius={120} count={18} color="#b4edbb" />
            </>;
        }
        case 'resupply': {
            const resource = g.outcomes.find(item => item.outcome.kind === 'resource');
            const to = resource?.to ?? primary;
            return <>
                <g transform={`translate(${to.x} ${to.y})`} opacity={power}><ellipse rx={125 - charge * 32} ry="45" stroke="#a3efa5" strokeWidth="3" strokeDasharray="24 11" transform={`rotate(${-12 + p * 30})`} /><path d="M-50 35 L0 65 L50 35 M-50 46 L0 76 L50 46" strokeWidth="4" /></g>
                <Debris at={to} p={p} inward start={.13} radius={185} count={24} color="#9fe88f" />
            </>;
        }
        case 'command':
            return <>
                <g transform={`translate(${source.x} ${source.y})`} opacity={power}><circle r={70 + charge * 25} stroke="#f7d58a" strokeDasharray="8 10" transform={`rotate(${rotate})`} /><path d="M-40 18 L0 -20 L40 18 M-40 -2 L0 -40 L40 -2" stroke="#ffdf9b" strokeWidth="7" /></g>
                {g.outcomes.filter(item => ['damage', 'buff', 'heal', 'shield', 'recover', 'resource'].includes(item.outcome.kind)).map((item, i) => <Arc key={item.key} from={i > 0 && buff ? buff.box : source} to={item.box} p={p} start={.17 + i * .08} end={.49 + i * .06} color={colorOf(item.outcome.kind)} bend={i % 2 ? 110 : -110} width={5} />)}
            </>;
        case 'vigilance':
            return <>
                <g transform={`translate(${source.x} ${source.y})`} opacity={power}><path d="M-90 0 Q0 -95 90 0 Q0 95 -90 0 Z" stroke="#a8e8ff" strokeWidth="4" /><circle r={20 + charge * 16} stroke="#c5efff" strokeWidth="5" /></g>
                {g.outcomes.map((item, i) => <Arc key={item.key} from={source} to={item.box} p={p} start={.14 + i * .07} end={.48 + i * .05} color={colorOf(item.outcome.kind)} bend={i % 2 ? 70 : -70} width={4} />)}
            </>;
        case 'aggression':
            return <>
                {damage.map(item => <g key={item.key} transform={`translate(${item.box.x} ${item.box.y})`} opacity={power}><path d="M-170 110 Q-160 -180 115 -125" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - easeOut(phase(p, .12, .43))} stroke="#ff674d" strokeWidth="12" /><path d="M170 110 Q160 -180 -115 -125" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - easeOut(phase(p, .2, .5))} stroke="#fff2d5" strokeWidth="6" /></g>)}
                {g.outcomes.filter(item => item.outcome.kind === 'ready').map(item => <Arc key={item.key} from={source} to={item.box} p={p} color={colorOf('ready')} bend={90} width={5} />)}
            </>;
        case 'cunning':
            return <>
                {g.outcomes.filter(item => item.outcome.kind === 'return' || item.outcome.kind === 'exhaust').map((item, i) => <g key={item.key}>
                    <Arc from={source} to={item.from} p={p} start={.1 + i * .04} end={.43 + i * .04} color={colorOf(item.outcome.kind)} width={3} bend={(i - 1) * 100} />
                    <g transform={`translate(${item.from.x} ${item.from.y})`} opacity={power * .65}>{[-1, 1].map(side => <g key={side} transform={`translate(${side * 55 * charge} ${-20 * charge}) ${screenRotate(side * 16 * charge, item.from)}`}><CardGhost card={item.outcome.card} box={screenCardSize(item.from)} opacity={.4} /></g>)}</g>
                </g>)}
            </>;
        case 'power-of-the-dark-side':
            return <>
                <g transform={targetTransform} opacity={power}><circle r={150 - charge * 70} fill="#06050a" stroke="#d289ff" strokeWidth="6" /><circle r={164 - charge * 70} stroke="#da99ff" strokeWidth="2" strokeDasharray="15 11" transform={`rotate(${-rotate})`} />
                    {sequence(12).map(i => <g key={i} transform={`rotate(${i * 30 + p * 30})`}><path d={`M0 ${-100 + charge * 20} L-10 -165 L6 -130 L12 -220`} stroke="#c47cff" strokeWidth="2" opacity=".7" /></g>)}
                </g><Debris at={primary} p={p} inward start={.02} count={40} radius={275} color="#c489f4" /><Shockwave at={primary} p={p} start={.47} radius={250} color="#ce8af7" />
            </>;
        case 'the-force-is-with-me': {
            const chosen = buff?.box ?? primary;
            return <>
                <g transform={`translate(${chosen.x} ${chosen.y})`} opacity={power}>{sequence(4).map(i => <ellipse key={i} cx="0" cy={70 - phase(p, .04 + i * .04, .53 + i * .04) * 155} rx={70 + i * 17} ry={24 + i * 4} stroke="#c7ffb3" strokeWidth="3" opacity=".65" />)}<path d={hexPoints(0, 0, 125)} stroke="#beffc6" strokeDasharray="10 12" transform={`rotate(${rotate * .35})`} /></g>
                <Halo at={chosen} id={id} radius={220} opacity={power * .7} />
                <Debris at={chosen} p={p} inward start={.02} radius={230} count={30} color="#c1fca3" />
                {damage.map(item => <EnergyBeam key={item.key} from={chosen} to={item.box} p={p} start={.38} end={.57} color="#d4ffc5" width={8} />)}
            </>;
        }
        case 'waylay': {
            const returned = g.outcomes.find(item => item.outcome.kind === 'return');
            const from = returned?.from ?? primary;
            return <g transform={`translate(${from.x} ${from.y})`} opacity={power}>
                {sequence(6).map(i => <ellipse key={i} rx={(58 + i * 18) * (1 - phase(p, .18, .63) * .65)} ry={(25 + i * 8) * (1 - phase(p, .18, .63) * .55)} stroke={i % 2 ? '#c7e9ff' : '#93ceff'} strokeWidth={i % 2 ? 2 : 4} strokeDasharray="45 18" transform={`rotate(${i * 28 + p * 175})`} />)}
            </g>;
        }
        case 'spark-of-rebellion': {
            const discarded = g.outcomes.find(item => item.outcome.kind === 'discard');
            const hand = g.zones[`${enemyOf(cue.seat)}:hand`];
            const selected = discarded?.from ?? hand;
            const count = Math.min(10, hand.count ?? 0);
            const cardSize = screenCardSize(hand, 44, 62);
            const gap = Math.min(50 / (hand.sx ?? 1), (W - cardSize.w - 48) / Math.max(1, count - 1));
            const halfWidth = ((count - 1) * gap + cardSize.w) / 2 + 18;
            const center = { x: Math.max(halfWidth, Math.min(W - halfWidth, hand.x)), y: Math.max(cardSize.h / 2 + 14, hand.y) };
            return <>
                {count > 0 && <g transform={`translate(${center.x} ${center.y})`} opacity={power}>{sequence(count).map(i => { const offset = i - (count - 1) / 2; return <g key={i} transform={`translate(${offset * gap} ${Math.abs(offset) * 4}) ${screenRotate(offset * 6, hand)}`}><CardGhost box={cardSize} back /></g>; })}<path d={`M${-halfWidth} ${-cardSize.h / 2 + phase(p, .06, .42) * cardSize.h} H${halfWidth}`} stroke="#ffebbd" strokeWidth="4" /><rect x={-halfWidth} y={-cardSize.h / 2 - 5} width={halfWidth * 2} height={cardSize.h + 10} rx="5" strokeWidth="2" /></g>}
                <g transform={`translate(${selected.x} ${selected.y})`} opacity={envelope(p, .26, .45, .7)}><path d="M-48 -63 H-18 M-48 -63 V-32 M48 63 H18 M48 63 V32 M48 -63 H18 M48 -63 V-32 M-48 63 H-18 M-48 63 V32" stroke="#ffe1a0" strokeWidth="5" /><g transform={`scale(${.7 + hit})`}><AbilityGlyph kind="inspect" size={25} /></g></g>
            </>;
        }
        default: return null;
    }
}
