import { createContext, createElement, useContext, type ReactNode } from 'react';
import { createStore, useStore, type StoreApi } from 'zustand';
import type { Seat } from '../data/types';

export type Perspective = 'god' | Seat;

export interface Settings {
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

type Saved = Pick<Settings, 'art' | 'lens' | 'perspective' | 'speed'>;

function load(key: string): Partial<Saved> {
    try {
        return JSON.parse(localStorage.getItem(key) ?? '{}');
    } catch {
        return {};
    }
}
function save(key: string | null, s: Saved) {
    if (!key) {
        return;
    }
    try {
        localStorage.setItem(key, JSON.stringify({ art: s.art, lens: s.lens, perspective: s.perspective, speed: s.speed }));
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
export function createSettingsStore(persistKey: string | null = null, initial: Partial<Saved> = {}): StoreApi<Settings> {
    const saved = { ...(persistKey ? load(persistKey) : {}), ...initial };
    const store = createStore<Settings>((set, get) => ({
        art: saved.art ?? true,
        lens: saved.lens ?? false,
        artVersion: 0,
        perspective: saved.perspective ?? 'god',
        speed: saved.speed ?? 1,
        setArt: (art) => (set({ art }), save(persistKey, { ...get(), art })),
        setLens: (lens) => (set({ lens }), save(persistKey, { ...get(), lens })),
        setPerspective: (perspective) => (set({ perspective }), save(persistKey, { ...get(), perspective })),
        setSpeed: (speed) => (set({ speed }), save(persistKey, { ...get(), speed }))
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
export function setEverywhere(patch: Partial<Saved>) {
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
    }
}

/** A card-art source changed: make every card re-resolve its image. */
export function bumpArtVersion() {
    for (const s of live) {
        s.setState((st) => ({ artVersion: st.artVersion + 1 }));
    }
}
