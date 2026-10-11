import { create } from 'zustand';
import type { Seat } from '../data/types';

export type Perspective = 'god' | Seat;

interface Settings {
    art: boolean;
    /** draw each card's value (the omni bot's board score) on the board */
    lens: boolean;
    perspective: Perspective;
    speed: number;
    /** bumps when a card-art source changes, so cards re-resolve their images */
    artVersion: number;
    setArt: (v: boolean) => void;
    setLens: (v: boolean) => void;
    setPerspective: (v: Perspective) => void;
    setSpeed: (v: number) => void;
}

const KEY = 'holotable.settings';
function load(): Partial<Settings> {
    try {
        return JSON.parse(localStorage.getItem(KEY) ?? '{}');
    } catch {
        return {};
    }
}
function save(s: Pick<Settings, 'art' | 'lens' | 'perspective' | 'speed'>) {
    try {
        localStorage.setItem(KEY, JSON.stringify({ art: s.art, lens: s.lens, perspective: s.perspective, speed: s.speed }));
    } catch {
        // storage blocked: settings just don't persist
    }
}

export const SPEEDS = [{ label: '0.5×', ms: 900 }, { label: '1×', ms: 420 }, { label: '3×', ms: 140 }, { label: '10×', ms: 40 }];

const saved = load();
export const useSettings = create<Settings>((set, get) => ({
    art: saved.art ?? true,
    lens: saved.lens ?? false,
    artVersion: 0,
    perspective: saved.perspective ?? 'god',
    speed: saved.speed ?? 1,
    setArt: (art) => (set({ art }), save({ ...get(), art })),
    setLens: (lens) => (set({ lens }), save({ ...get(), lens })),
    setPerspective: (perspective) => (set({ perspective }), save({ ...get(), perspective })),
    setSpeed: (speed) => (set({ speed }), save({ ...get(), speed }))
}));
