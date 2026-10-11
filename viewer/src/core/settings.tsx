import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type CardMode = 'images' | 'tiles';
/** Whose hand is visible: both (god view), or only the given player's, as that player would see it. */
export type Perspective = 'god' | 'p1' | 'p2';

interface Settings {
    cardMode: CardMode;
    perspective: Perspective;
    setCardMode: (m: CardMode) => void;
    setPerspective: (v: Perspective) => void;
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
    const stored = read('perspective');
    const [perspective, setPersp] = useState<Perspective>(stored === 'p1' || stored === 'p2' ? stored : 'god');
    const setCardMode = useCallback((m: CardMode) => {
        setMode(m);
        write('cardMode', m);
    }, []);
    const setPerspective = useCallback((v: Perspective) => {
        setPersp(v);
        write('perspective', v);
    }, []);
    const value = useMemo(() => ({ cardMode, perspective, setCardMode, setPerspective }), [cardMode, perspective, setCardMode, setPerspective]);
    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings(): Settings {
    const v = useContext(Ctx);
    if (!v) {
        throw new Error('SettingsProvider missing');
    }
    return v;
}
