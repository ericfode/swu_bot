export type SoundVoice = 'laser' | 'impact' | 'rumble' | 'crackle' | 'whoosh' | 'chime' | 'pulse' | 'shatter' | 'card' | 'shield' | 'servo';

/** Timing is a fraction of the card animation; pitches are Hz, gain 0..1, pan -1..1. */
export interface SoundEvent {
    at: number;
    duration: number;
    voice: SoundVoice;
    pitch?: number;
    pitchEnd?: number;
    gain?: number;
    pan?: number;
    seed?: number;
}
