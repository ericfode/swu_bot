import type { AbilityKind } from './abilities';
import type { CardEffectCue, CardEffectOutcome } from './types';
import type { SoundEvent, SoundVoice } from './soundTypes';

// A score is choreography, not rules resolution. It consumes the same explicit receipts as the picture.
const note = (voice: SoundVoice, at: number, duration: number, pitch: number, pitchEnd = pitch, gain = .5, pan = 0): SoundEvent =>
    ({ voice, at, duration, pitch, pitchEnd, gain, pan });
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const hash = (value: string) => { let seed = 2166136261; for (const character of value) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619); return seed >>> 0; };
const has = (cue: CardEffectCue, kind: AbilityKind) => (cue.outcomes ?? []).some(outcome => outcome.kind === kind && outcome.amount !== 0);

/** Quiet launch identities. These textures describe the card being played, never an unobserved result. */
function signature(id: string): SoundEvent[] {
    switch (id) {
        case 'open-fire': return [
            note('servo', .02, .085, 90, 190, .42), note('pulse', .105, .065, 110, 220, .38), note('servo', .19, .06, 220, 330, .32)
        ];
        case 'force-lightning': return [
            note('rumble', .02, .23, 43, 68, .38), note('crackle', .07, .18, 155, 310, .48), note('crackle', .2, .11, 310, 510, .34, -.2)
        ];
        case 'force-choke': return [
            note('rumble', .03, .29, 91, 33, .54), note('pulse', .09, .052, 84, 64, .5), note('pulse', .155, .04, 72, 54, .38), note('pulse', .24, .065, 63, 41, .47)
        ];
        case 'takedown': return [
            note('servo', .02, .08, 170, 440, .38, -.22), note('servo', .11, .05, 440, 440, .3, .22), note('whoosh', .2, .1, 550, 150, .42)
        ];
        case 'vanquish': return [
            note('whoosh', .025, .2, 160, 950, .44, -.25), note('pulse', .07, .16, 174, 261, .37), note('whoosh', .21, .105, 1250, 280, .48, .25)
        ];
        case 'superlaser-blast': return [
            note('rumble', .015, .305, 29, 56, .6), note('pulse', .045, .245, 73, 146, .44, -.3),
            note('pulse', .09, .2, 110, 220, .34, .3), note('pulse', .145, .145, 147, 294, .3), note('servo', .22, .075, 294, 588, .36)
        ];
        case 'overwhelming-barrage': return [
            note('servo', .02, .11, 76, 152, .46, -.16), note('servo', .12, .1, 152, 228, .41, .16), note('pulse', .23, .065, 114, 171, .42)
        ];
        case 'bombing-run': return [
            note('rumble', .015, .27, 50, 78, .48), note('whoosh', .035, .2, 160, 580, .53, -.6), note('whoosh', .19, .14, 580, 150, .43, .6)
        ];
        case 'make-an-opening': return [
            note('pulse', .025, .155, 294, 196, .39, -.18), note('whoosh', .14, .15, 640, 240, .3, .18), note('servo', .235, .055, 196, 147, .28)
        ];
        case 'repair': return [
            note('servo', .025, .085, 220, 330, .31, -.3), note('servo', .12, .075, 330, 440, .29, .3), note('pulse', .19, .115, 196, 294, .32)
        ];
        case 'restock': return [
            note('whoosh', .025, .19, 600, 160, .33, -.2), note('servo', .085, .1, 110, 220, .28), note('pulse', .23, .065, 196, 196, .3)
        ];
        case 'resupply': return [
            note('rumble', .02, .16, 66, 88, .29), note('servo', .085, .14, 98, 196, .43), note('pulse', .23, .06, 147, 220, .38)
        ];
        case 'command': return [
            note('pulse', .025, .065, 146.83, 146.83, .4, -.2), note('pulse', .115, .065, 220, 220, .4, .2), note('servo', .21, .09, 293.66, 440, .3)
        ];
        case 'vigilance': return [
            note('pulse', .025, .22, 261.63, 261.63, .28), note('whoosh', .04, .18, 800, 350, .3, -.28), note('pulse', .18, .115, 392, 523.25, .27, .28)
        ];
        case 'aggression': return [
            note('rumble', .02, .21, 82, 55, .4), note('servo', .06, .07, 164, 123, .5, -.25), note('servo', .16, .07, 185, 138, .5, .25), note('pulse', .24, .06, 110, 165, .4)
        ];
        case 'cunning': return [
            note('whoosh', .025, .11, 440, 660, .29, -.5), note('pulse', .065, .065, 329.63, 493.88, .35, .35), note('whoosh', .16, .12, 660, 330, .33, .5), note('pulse', .245, .045, 246.94, 329.63, .28, -.35)
        ];
        case 'power-of-the-dark-side': return [
            note('rumble', .025, .275, 61.74, 30.87, .56), note('pulse', .07, .19, 92.5, 58.27, .34, -.28), note('whoosh', .16, .145, 950, 100, .45, .28)
        ];
        case 'the-force-is-with-me': return [
            note('pulse', .025, .225, 130.81, 196, .34, -.18), note('pulse', .08, .19, 196, 261.63, .3, .18), note('whoosh', .15, .145, 220, 660, .29)
        ];
        case 'waylay': return [
            note('whoosh', .025, .14, 950, 230, .42, -.35), note('pulse', .09, .13, 246.94, 164.81, .36), note('whoosh', .185, .12, 230, 950, .42, .35)
        ];
        case 'spark-of-rebellion': return [
            note('servo', .025, .15, 176, 352, .34, -.4), note('crackle', .055, .07, 880, 440, .23), note('pulse', .215, .075, 352, 528, .32, .4)
        ];
        default: return [];
    }
}

/** Shared pitches, intervals and envelopes make the rules audible across unrelated card identities. */
function mechanic(outcome: CardEffectOutcome, at: number, pan: number): SoundEvent[] {
    const n = (voice: SoundVoice, offset: number, duration: number, pitch: number, pitchEnd = pitch, gain = .6) =>
        note(voice, at + offset, duration, pitch, pitchEnd, gain, pan);
    const count = typeof outcome.amount === 'number' && Number.isFinite(outcome.amount) ? clamp(Math.ceil(Math.abs(outcome.amount)), 1, 6) : 1;
    switch (outcome.kind) {
        case 'damage': return [n('impact', 0, .095, 138, 38, .75), n('crackle', .014, .04, 290, 140, .27)];
        case 'defeat': return [n('shatter', 0, .095, 1420, 620, .62), n('whoosh', .04, .14, 390, 85, .37)];
        case 'heal': return [n('chime', 0, .12, 392, 415, .52), n('chime', .045, .13, 523.25, 554.37, .5), n('chime', .09, .15, 659.25, 698.46, .47)];
        case 'shield': return [n('shield', 0, .19, 392, 587.33, .62), n('chime', .115, .12, 783.99, 783.99, .32)];
        case 'buff': return [n('chime', 0, .14, 261.63, 392, .53), n('chime', .06, .15, 523.25, 659.25, .48)];
        case 'debuff': return [n('pulse', 0, .15, 392, 196, .53), n('servo', .06, .11, 196, 98, .42)];
        case 'draw': return [n('card', 0, .07, 1300, 1900, .64), n('chime', .12, .07, 659.25, 659.25, .3)];
        case 'discard': return [n('card', 0, .09, 1200, 500, .65), n('servo', .125, .065, 135, 90, .4)];
        case 'mill': return [
            ...Array.from({ length: count }, (_, index) => n('card', index * .027, .035, 1500, 650, .46)),
            n('servo', .03 * count + .03, .055, 90, 70, .33)
        ];
        case 'return': return [n('whoosh', 0, .2, 140, 940, .55), n('card', .205, .065, 1800, 900, .6)];
        case 'recover': return [n('whoosh', 0, .145, 190, 470, .43), n('card', .155, .055, 1000, 550, .57), n('chime', .185, .08, outcome.zone === 'deck' ? 329.63 : 493.88, undefined, .27)];
        case 'resource': return [n('card', 0, .075, 1300, 450, .58), n('servo', .09, .105, 98, 146.83, .53), n('pulse', .17, .075, 146.83, 146.83, .38)];
        case 'ready': return [n('servo', 0, .13, 130.81, 261.63, .57), n('chime', .12, .08, 523.25, 523.25, .35)];
        case 'exhaust': return [n('servo', 0, .13, 261.63, 98, .55), n('pulse', .12, .07, 98, 65.41, .38)];
        case 'suppress': return [n('servo', 0, .14, 700, 87, .55), n('rumble', .06, .15, 64, 32, .37)];
        case 'attack': return [n('servo', 0, .055, 90, 180, .48), n('whoosh', .04, .15, 180, 760, .6)];
        case 'cost': return [n('servo', 0, .08, 330, 165, .38), n('pulse', .075, .065, 110, 82.41, .32)];
        case 'pay': return Array.from({ length: count }, (_, index) => n('servo', index * .035, .045, 196, 98, .44));
        case 'inspect': return [n('servo', 0, .2, 220, 440, .39), n('pulse', .21, .075, 440, 440, .34)];
        // New visual meanings have no approved sound design yet.
        case 'play': case 'control': case 'search': case 'delay': case 'keyword': case 'restrict': case 'rescue': case 'attach': case 'create':
        case 'capture': return [];
    }
}

function onset(cue: CardEffectCue, outcome: CardEffectOutcome, ordinal: number): number {
    const id = cue.definition.id;
    const stagger = Math.min(ordinal, 7) * .022;
    if (outcome.kind === 'cost') return .055;
    if (outcome.kind === 'inspect') return .12;
    if (outcome.kind === 'pay') return .31;
    if (id === 'force-lightning') {
        if (outcome.kind === 'suppress') return .345;
        if (outcome.kind === 'damage') return .505;
    }
    if (id === 'superlaser-blast' && outcome.kind === 'defeat') return .43 + Math.min(ordinal, 9) * .018;
    if (id === 'bombing-run' && outcome.kind === 'damage') return .38 + ordinal * .03;
    if (id === 'overwhelming-barrage') {
        if (outcome.kind === 'buff') return .22;
        if (outcome.kind === 'damage') return .47 + stagger;
    }
    if (id === 'the-force-is-with-me') {
        if (outcome.kind === 'buff') return .25;
        if (outcome.kind === 'shield') return .36;
        if (outcome.kind === 'attack') return .43;
        if (outcome.kind === 'exhaust') return .51;
        if (outcome.kind === 'damage') return .6;
    }
    if (id === 'make-an-opening' && outcome.kind === 'heal') return .54;
    if (id === 'force-choke' && outcome.kind === 'draw') return .59;
    if (outcome.kind === 'defeat') return .48 + stagger;
    if (['draw', 'discard', 'return', 'recover', 'resource', 'mill'].includes(outcome.kind)) return .4 + stagger;
    if (outcome.kind === 'attack') return .32;
    return .405 + stagger;
}

/** Additional movement is permitted only for an explicitly observed or selected matching outcome. */
function motion(cue: CardEffectCue): SoundEvent[] {
    const id = cue.definition.id;
    if (id === 'open-fire' && has(cue, 'damage')) return [0, 1, 2].map(index => note('laser', .18 + index * .065, .085, 920 - index * 95, 170, .48, (index - 1) * .12));
    if (id === 'force-lightning' && (has(cue, 'suppress') || has(cue, 'damage'))) return [note('crackle', .28, .2, 330, 92, .38, .15)];
    if (id === 'takedown' && has(cue, 'defeat')) return [note('laser', .27, .11, 1250, 95, .56)];
    if (id === 'vanquish' && has(cue, 'defeat')) return [note('whoosh', .27, .17, 1800, 230, .55, -.2), note('whoosh', .32, .16, 1000, 150, .35, .2)];
    if (id === 'superlaser-blast' && has(cue, 'defeat')) return [note('laser', .30, .16, 690, 38, .65), note('rumble', .335, .27, 43, 24, .75)];
    if (id === 'overwhelming-barrage' && has(cue, 'damage')) return [0, 1, 2].map(index => note('laser', .29 + index * .04, .1, 710 - index * 70, 115, .4));
    if (id === 'bombing-run' && has(cue, 'damage')) return [note('whoosh', .265, .17, 920, 115, .44, .4)];
    if (id === 'aggression' && has(cue, 'damage')) return [note('whoosh', .22, .15, 670, 145, .45, -.28), note('whoosh', .295, .145, 820, 130, .42, .28)];
    return [];
}

/** Deterministic, bounded score; changing a preview nonce does not change its sound design. */
export function scoreEffect(cue: CardEffectCue): SoundEvent[] {
    const id = cue.definition.id;
    const ordinal = new Map<AbilityKind, number>();
    const receipts = (cue.outcomes ?? []).filter(outcome => outcome.amount !== 0);
    const events = [...signature(id), ...motion(cue)];
    for (const outcome of receipts) {
        const index = ordinal.get(outcome.kind) ?? 0;
        ordinal.set(outcome.kind, index + 1);
        // Very large boards must not allocate unlimited voices or bury the distinct mechanics.
        if (index >= 10) continue;
        const pan = (outcome.seat === cue.seat ? -.23 : .23) + (index % 3 - 1) * .075;
        const sounds = mechanic(outcome, onset(cue, outcome, index), pan);
        const population = receipts.filter(receipt => receipt.kind === outcome.kind).length;
        const attenuation = 1 / Math.sqrt(Math.max(1, Math.min(population, 6) * .6));
        events.push(...sounds.map(event => ({ ...event, gain: event.gain! * attenuation })));
    }
    const ends: number[] = [];
    return events.map((event, index) => ({ ...event, seed: hash(`${id}:${index}:${event.voice}`) }))
        .sort((a, b) => a.at - b.at)
        .filter(event => {
            if (event.at >= 1) return false;
            for (let i = ends.length - 1; i >= 0; i--) if (ends[i] <= event.at) ends.splice(i, 1);
            if (ends.length >= 12) return false;
            event.duration = Math.min(event.duration, 1 - event.at);
            ends.push(event.at + event.duration);
            return true;
        }).slice(0, 48);
}
