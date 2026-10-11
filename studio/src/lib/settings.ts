import { create } from 'zustand';
import type { Seat } from '../data/types';

export type Perspective = 'god' | Seat;

interface Settings {
    art: boolean;
    perspective: Perspective;
    speed: number;
    /** bumps when a card-art source changes, so cards re-resolve their images */
    artVersion: number;
    setArt: (v: boolean) => void;
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
function save(s: Pick<Settings, 'art' | 'perspective' | 'speed'>) {
    try {
        localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
        // storage blocked: settings just don't persist
    }
}

export const SPEEDS = [{ label: '0.5×', ms: 900 }, { label: '1×', ms: 420 }, { label: '3×', ms: 140 }, { label: '10×', ms: 40 }];

const saved = load();
export const useSettings = create<Settings>((set, get) => ({
    art: saved.art ?? true,
    artVersion: 0,
    perspective: saved.perspective ?? 'god',
    speed: saved.speed ?? 1,
    setArt: (art) => (set({ art }), save({ ...get(), art })),
    setPerspective: (perspective) => (set({ perspective }), save({ ...get(), perspective })),
    setSpeed: (speed) => (set({ speed }), save({ ...get(), speed }))
}));
