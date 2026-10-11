import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type CardMode = 'images' | 'tiles';

interface Settings {
    cardMode: CardMode;
    godView: boolean;
    setCardMode: (m: CardMode) => void;
    setGodView: (v: boolean) => void;
}

const Ctx = createContext<Settings | null>(null);

function read(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}
function write(key: string, value: string) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // storage unavailable: setting just lasts for this page load
    }
}

export function SettingsProvider({ children }: { children: ReactNode }) {
    const [cardMode, setMode] = useState<CardMode>(read('cardMode') === 'tiles' ? 'tiles' : 'images');
    const [godView, setGod] = useState<boolean>(read('godView') !== 'off');
    const setCardMode = useCallback((m: CardMode) => {
        setMode(m);
        write('cardMode', m);
    }, []);
    const setGodView = useCallback((v: boolean) => {
        setGod(v);
        write('godView', v ? 'on' : 'off');
    }, []);
    const value = useMemo(() => ({ cardMode, godView, setCardMode, setGodView }), [cardMode, godView, setCardMode, setGodView]);
    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings(): Settings {
    const v = useContext(Ctx);
    if (!v) {
        throw new Error('SettingsProvider missing');
    }
    return v;
}
