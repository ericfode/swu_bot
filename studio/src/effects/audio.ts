import { useLayoutEffect, useRef } from 'react';
import type { CardEffectCue } from './types';
import type { SoundEvent, SoundVoice } from './soundTypes';
import { scoreEffect } from './soundScore';

const TAU = Math.PI * 2;
const MASTER_GAIN = .3;
const MAX_EVENTS = 48;
const MAX_CONCURRENT_VOICES = 12;
const STOP_FADE_SECONDS = .018;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const finite = (value: number | undefined, fallback: number) => value != null && Number.isFinite(value) ? value : fallback;
const volumeOf = (volume: number) => clamp(finite(volume, 0), 0, 1);
const durationOf = (cue: CardEffectCue) => clamp(finite(cue.definition.durationMs, 1000) / 1000, .05, 12);
const VOICES: SoundVoice[] = ['laser', 'impact', 'rumble', 'crackle', 'whoosh', 'chime', 'pulse', 'shatter', 'card', 'shield', 'servo'];

export interface EffectAudioPlayback {
    /** Fade and cancel every source owned by this cue, including sources scheduled in the future. */
    stop(): void;
    /** Adjusts this playback only. It does not restart or reschedule the score. */
    setVolume(volume: number): void;
}

interface ScheduleOptions {
    destination?: AudioNode;
    startTime?: number;
    volume?: number;
}

let sharedContext: AudioContext | null = null;

/** Call directly from the user's sound-enable gesture. No effect or background task resumes audio. */
export async function unlockEffectAudio(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    try {
        const AudioContextClass = window.AudioContext
            ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextClass) return false;
        if (!sharedContext || sharedContext.state === 'closed') sharedContext = new AudioContextClass({ latencyHint: 'interactive' });
        if (sharedContext.state !== 'running') await sharedContext.resume();
        return sharedContext.state === 'running';
    } catch {
        return false;
    }
}

/** Original deterministic synthesis: no samples, asset requests, or live audio context are needed. */
export function synthesizeSound(event: SoundEvent, seconds: number, sampleRate: number): Float32Array<ArrayBuffer> {
    const rate = clamp(Math.round(finite(sampleRate, 48000)), 8000, 96000);
    const duration = clamp(finite(seconds, .1), 1 / rate, 12);
    const length = Math.max(2, Math.round(duration * rate));
    const samples = new Float32Array(length);
    const defaults: Record<SoundVoice, [number, number, number, number]> = {
        laser: [1000, 100, .004, .025], impact: [130, 34, .003, .07], rumble: [52, 30, .07, .16],
        crackle: [180, 74, .012, .045], whoosh: [280, 700, .03, .06], chime: [660, 660, .005, .08],
        pulse: [180, 230, .035, .09], shatter: [1450, 760, .003, .07], card: [1500, 480, .006, .025],
        shield: [420, 640, .03, .1], servo: [150, 310, .01, .035],
    };
    const voice = VOICES.includes(event.voice) ? event.voice : 'whoosh';
    const [basePitch, endPitch, attackSeconds, releaseSeconds] = defaults[voice];
    const pitch = clamp(finite(event.pitch, basePitch), 20, rate / 8);
    const pitchEnd = clamp(finite(event.pitchEnd, event.pitch == null ? endPitch : pitch), 20, rate / 8);
    const logSweep = Math.log(pitchEnd / pitch);
    const gain = clamp(finite(event.gain, .6), 0, 1);
    const attack = Math.min(attackSeconds, duration * .22);
    const release = Math.min(releaseSeconds, duration * .42);
    let seed = (finite(event.seed, 1) >>> 0) || 1;
    let phase = 0, lowNoise = 0, midNoise = 0;
    // Low and mid noise bands make the voices physical without harsh full-band white noise.
    const lowAlpha = 1 - Math.exp(-TAU * 120 / rate);
    const midAlpha = 1 - Math.exp(-TAU * 2200 / rate);
    for (let i = 0; i < length; i++) {
        const x = i / (length - 1), time = i / rate;
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        const noise = (seed >>> 0) / 2147483648 - 1;
        lowNoise += lowAlpha * (noise - lowNoise);
        midNoise += midAlpha * (noise - midNoise);
        const band = midNoise - lowNoise;
        phase += TAU * pitch * Math.exp(logSweep * x) / rate;
        const sine = Math.sin(phase);
        let sound = 0, body = 1;
        switch (voice) {
            case 'laser':
                sound = .76 * Math.sin(phase + 1.5 * Math.sin(phase * .501) * (1 - x)) + .18 * band;
                body = Math.exp(-3.7 * x);
                break;
            case 'impact':
                sound = .75 * sine + 2.1 * lowNoise + .32 * band * Math.exp(-8 * x);
                body = Math.exp(-4.3 * x);
                break;
            case 'rumble':
                sound = .43 * sine + .26 * Math.sin(phase * .501) + 2.2 * lowNoise;
                body = (.8 + .2 * Math.sin(time * 17)) * Math.sin(Math.PI * x) ** .55;
                break;
            case 'crackle':
                sound = band * (1.2 + .9 * Math.sin(time * 79) * Math.sin(time * 131)) + .19 * Math.sin(phase + 3 * Math.sin(phase * 1.93));
                body = .65 + .35 * Math.sin(Math.PI * x);
                break;
            case 'whoosh':
                sound = band * 1.8 + lowNoise * 1.4 + .09 * sine;
                body = Math.sin(Math.PI * x) ** .8;
                break;
            case 'chime':
                sound = .56 * sine + .22 * Math.sin(phase * 2.003) * Math.exp(-2 * x) + .12 * Math.sin(phase * 3.011) * Math.exp(-4 * x);
                body = Math.exp(-3.3 * x);
                break;
            case 'pulse':
                sound = .59 * sine + .21 * Math.sin(phase * 2.001) + .15 * Math.sin(phase * .5);
                body = (.72 + .28 * Math.cos(time * 24)) * Math.sin(Math.PI * x) ** .4;
                break;
            case 'shatter':
                sound = .24 * Math.sin(phase) + .2 * Math.sin(phase * 1.419) + .17 * Math.sin(phase * 2.731) + .63 * band;
                body = Math.exp(-4 * x) * (.72 + .28 * Math.sin(time * 91) ** 2);
                break;
            case 'card':
                sound = (noise - midNoise) * .75 + band * .52;
                body = Math.exp(-2.8 * x) * (.7 + .3 * Math.sin(time * 53) ** 2);
                break;
            case 'shield':
                sound = .49 * Math.sin(phase + .7 * Math.sin(phase * 2)) + .19 * Math.sin(phase * 1.5) + .26 * band;
                body = Math.sin(Math.PI * x) ** .6 * (.83 + .17 * Math.sin(time * 31));
                break;
            case 'servo':
                sound = .43 * sine + .27 * Math.sin(phase * 2) + .15 * Math.sin(phase * 3) + .22 * band;
                body = (.65 + .35 * Math.sin(time * 57) ** 2) * Math.sin(Math.PI * x) ** .4;
                break;
        }
        const fadeIn = Math.sin(clamp(time / attack, 0, 1) * Math.PI / 2) ** 2;
        const fadeOut = Math.sin(clamp((duration - time - 1 / rate) / release, 0, 1) * Math.PI / 2) ** 2;
        samples[i] = Math.tanh(sound) * body * fadeIn * fadeOut * gain;
    }
    samples[0] = 0;
    samples[length - 1] = 0;
    return samples;
}

/** Reject malformed notes and bound both total work and simultaneous voices before allocating buffers. */
export function boundedSoundEvents(events: SoundEvent[]): SoundEvent[] {
    const activeEnds: number[] = [];
    const accepted: SoundEvent[] = [];
    const ordered = events.filter(event => VOICES.includes(event.voice) && Number.isFinite(event.at) && Number.isFinite(event.duration)
        && event.at >= 0 && event.at < 1 && event.duration > 0 && finite(event.gain, .6) > 0).sort((a, b) => a.at - b.at);
    for (const event of ordered) {
        for (let i = activeEnds.length - 1; i >= 0; i--) if (activeEnds[i] <= event.at) activeEnds.splice(i, 1);
        if (activeEnds.length >= MAX_CONCURRENT_VOICES) continue;
        const note = { ...event, duration: Math.min(event.duration, 1 - event.at) };
        accepted.push(note);
        activeEnds.push(note.at + note.duration);
        if (accepted.length >= MAX_EVENTS) break;
    }
    return accepted;
}

/** Shared realtime/offline graph. Every returned handle owns only its own sources and output gain. */
export function scheduleEffectAudio(context: BaseAudioContext, cue: CardEffectCue, options: ScheduleOptions = {}): EffectAudioPlayback {
    const output = context.createGain();
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 6;
    limiter.ratio.value = 16;
    limiter.attack.value = .003;
    limiter.release.value = .12;
    limiter.connect(output);
    output.connect(options.destination ?? context.destination);
    output.gain.value = MASTER_GAIN * volumeOf(options.volume ?? .35);
    const sources: AudioBufferSourceNode[] = [];
    const panners: StereoPannerNode[] = [];
    let stopped = false, remaining = 0;
    const disconnect = () => {
        for (const source of sources) source.disconnect();
        for (const panner of panners) panner.disconnect();
        limiter.disconnect();
        output.disconnect();
    };
    const duration = durationOf(cue);
    const synthesisRate = clamp(Math.round(context.sampleRate), 8000, 96000);
    // Synthesis happens before reading currentTime so buffer generation cannot bunch early notes together.
    const notes = boundedSoundEvents(scoreEffect(cue)).map(event => {
        const samples = synthesizeSound(event, event.duration * duration, synthesisRate);
        // The buffer keeps its synthesis rate; Web Audio resamples for high-rate output devices.
        const buffer = context.createBuffer(1, samples.length, synthesisRate);
        buffer.copyToChannel(samples, 0);
        return { event, buffer };
    });
    const start = Math.max(context.currentTime, finite(options.startTime, context.currentTime));
    for (const { event, buffer } of notes) {
        const source = context.createBufferSource();
        const panner = context.createStereoPanner();
        source.buffer = buffer;
        panner.pan.value = clamp(finite(event.pan, 0), -1, 1);
        source.connect(panner);
        panner.connect(limiter);
        sources.push(source);
        panners.push(panner);
        remaining++;
        source.onended = () => { source.disconnect(); panner.disconnect(); if (--remaining === 0) disconnect(); };
        source.start(start + event.at * duration);
    }
    if (!notes.length) disconnect();
    return {
        stop() {
            if (stopped) return;
            stopped = true;
            const now = context.currentTime;
            output.gain.cancelScheduledValues(now);
            output.gain.setTargetAtTime(0, now, .003);
            for (const source of sources) source.stop(now + STOP_FADE_SECONDS);
        },
        setVolume(volume: number) {
            if (stopped) return;
            const now = context.currentTime;
            output.gain.cancelScheduledValues(now);
            output.gain.setTargetAtTime(MASTER_GAIN * volumeOf(volume), now, .015);
        },
    };
}

/** Renders the full score silently for WAV export, peak/RMS checks, and timing inspection. */
export async function renderEffectAudio(cue: CardEffectCue, options: { sampleRate?: number; volume?: number } = {}): Promise<AudioBuffer> {
    const sampleRate = clamp(Math.round(finite(options.sampleRate, 48000)), 8000, 96000);
    const context = new OfflineAudioContext(2, Math.ceil((durationOf(cue) + .1) * sampleRate), sampleRate);
    scheduleEffectAudio(context, cue, { startTime: 0, volume: options.volume ?? .35 });
    return context.startRendering();
}

/** One hook = one cancellable score. Snapshot churn and volume updates never retrigger a cue. */
export function useCardEffectAudio(cue: CardEffectCue | null, enabled: boolean, volume: number): void {
    const latestCue = useRef(cue);
    const latestVolume = useRef(volume);
    const playback = useRef<EffectAudioPlayback | null>(null);
    latestCue.current = cue;
    latestVolume.current = volume;
    const key = cue?.key;
    const seek = cue?.previewProgress;
    useLayoutEffect(() => {
        const stop = () => { playback.current?.stop(); playback.current = null; };
        const current = latestCue.current;
        // No context creation or resume here: enabling sound is always an explicit gesture.
        if (enabled && current && seek == null && !document.hidden && sharedContext?.state === 'running') {
            playback.current = scheduleEffectAudio(sharedContext, current, { volume: latestVolume.current });
        }
        const onVisibility = () => { if (document.hidden) stop(); };
        document.addEventListener('visibilitychange', onVisibility);
        return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
    }, [key, enabled, seek]);
    useLayoutEffect(() => { playback.current?.setVolume(volume); }, [volume]);
}
