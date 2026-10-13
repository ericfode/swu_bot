import { createContext, createElement, useContext, type ReactNode } from 'react';
import { createStore, useStore, type StoreApi } from 'zustand';
import type { Seat } from '../data/types';

export type Perspective = 'god' | Seat;

export interface Settings {
    art: boolean;
    /**
     * card values forced on or off from outside (the kit's showLens option, setLensView); null lets each game decide (on
     * when it has a lens file for the chosen score). Never saved: the Card values button only overrides the game in view.
     */
    lens: boolean | null;
    /** the score source last picked (a lens dir, '' = the default path), opened on in games that have it */
    score: string | null;
    perspective: Perspective;
    speed: number;
    /** Sound is enabled by a user gesture for this viewer session. */
    sound: boolean;
    volume: number;
    /** bumps when a card-art source changes, so cards re-resolve their images */
    artVersion: number;
    setArt: (v: boolean) => void;
    setLens: (v: boolean | null) => void;
    setScore: (v: string | null) => void;
    setPerspective: (v: Perspective) => void;
    setSpeed: (v: number) => void;
    setSound: (v: boolean) => void;
    setVolume: (v: number) => void;
}

type Saved = Pick<Settings, 'art' | 'perspective' | 'speed' | 'score' | 'volume'>;

function load(key: string): Partial<Saved> {
    try {
        // earlier builds also saved 'lens' (card values on or off for every game): no longer applied
        const { art, perspective, speed, score, volume } = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {};
        return { art, perspective, speed, ...(Number.isFinite(volume) ? { volume } : {}), ...(typeof score === 'string' ? { score } : {}) };
    } catch {
        return {};
    }
}
function save(key: string | null, s: Saved) {
    if (!key) {
        return;
    }
    try {
        localStorage.setItem(key, JSON.stringify({ art: s.art, perspective: s.perspective, speed: s.speed, score: s.score, volume: s.volume }));
    } catch {
        // storage blocked: settings just don't persist
    }
}

export const SPEEDS = [{ label: '0.5×', ms: 900 }, { label: '1×', ms: 420 }, { label: '3×', ms: 140 }, { label: '10×', ms: 40 }];

// every live store, so page-wide switches (setCardArt, a new art pack) reach every viewer
const live = new Set<StoreApi<Settings>>();

/**
 * One viewer's settings. Holotable shares one store saved under 'holotable.settings'; each embedded viewer (kit mount)
 * gets its own, saved only when the host asks for a key, so viewers on one page don't switch each other.
 */
export function createSettingsStore(persistKey: string | null = null, initial: Partial<Saved & Pick<Settings, 'lens'>> = {}): StoreApi<Settings> {
    const saved: Partial<Saved & Pick<Settings, 'lens'>> = { ...(persistKey ? load(persistKey) : {}), ...initial };
    const store = createStore<Settings>((set, get) => ({
        art: saved.art ?? true,
        lens: saved.lens ?? null,
        score: saved.score ?? null,
        artVersion: 0,
        perspective: saved.perspective ?? 'god',
        speed: saved.speed ?? 1,
        sound: false,
        volume: Number.isFinite(saved.volume) ? Math.max(0, Math.min(1, saved.volume!)) : .35,
        setArt: (art) => (set({ art }), save(persistKey, { ...get(), art })),
        setLens: (lens) => set({ lens }),
        setScore: (score) => (set({ score }), save(persistKey, { ...get(), score })),
        setPerspective: (perspective) => (set({ perspective }), save(persistKey, { ...get(), perspective })),
        setSpeed: (speed) => (set({ speed }), save(persistKey, { ...get(), speed })),
        setSound: (sound) => set({ sound }),
        setVolume: (value) => {
            const volume = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
            set({ volume });
            save(persistKey, { ...get(), volume });
        }
    }));
    live.add(store);
    return store;
}

/** Stop page-wide switches from reaching a store (its viewer was destroyed). */
export function releaseSettingsStore(store: StoreApi<Settings>) {
    live.delete(store);
}

/** The store for components rendered outside any provider (kit icons and boards); never saved. Holotable provides its own, saved one. */
export const appSettings = createSettingsStore(null);

const SettingsContext = createContext<StoreApi<Settings>>(appSettings);

export function SettingsProvider({ store, children }: { store: StoreApi<Settings>; children: ReactNode }) {
    return createElement(SettingsContext.Provider, { value: store }, children);
}

interface UseSettings {
    (): Settings;
    <T>(selector: (s: Settings) => T): T;
}

/** The nearest viewer's settings (zustand hook: pass a selector to re-render only when that value changes). */
export const useSettings: UseSettings = <T,>(selector?: (s: Settings) => T) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useStore(useContext(SettingsContext), selector ?? ((s: Settings) => s as unknown as T));

/** Change a setting in every live viewer on the page. */
export function setEverywhere(patch: Partial<Saved & Pick<Settings, 'lens'>>) {
    for (const s of live) {
        const st = s.getState();
        if (patch.art != null) {
            st.setArt(patch.art);
        }
        if (patch.lens != null) {
            st.setLens(patch.lens);
        }
        if (patch.perspective != null) {
            st.setPerspective(patch.perspective);
        }
        if (patch.speed != null) {
            st.setSpeed(patch.speed);
        }
        if (patch.volume != null) {
            st.setVolume(patch.volume);
        }
    }
}

/** A card-art source changed: make every card re-resolve its image. */
export function bumpArtVersion() {
    for (const s of live) {
        s.setState((st) => ({ artVersion: st.artVersion + 1 }));
    }
}
