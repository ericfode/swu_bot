import { useEffect, useState } from 'react';
import { loadGame } from './api';
import type { Game } from './types';

/**
 * Loads a game and, while it has no end record yet (the tournament runner is still playing it), re-reads the file
 * every second so new moves show up. A finished game is fetched once.
 */
export function useGame(tid: string, gid: string | null): { game: Game | null; error: string | null; live: boolean } {
    const [game, setGame] = useState<Game | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [live, setLive] = useState(false);

    useEffect(() => {
        let alive = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        setGame(null);
        setError(null);
        setLive(false);
        if (!gid) {
            return undefined;
        }
        const tick = async () => {
            try {
                const g = await loadGame(tid, gid, true);
                if (!alive) {
                    return;
                }
                setError(null);
                if (g) {
                    setGame(g);
                }
                const finished = g?.end != null;
                setLive(!finished);
                if (!finished) {
                    timer = setTimeout(tick, 1000);
                }
            } catch (e) {
                if (alive) {
                    setError((e as Error).message);
                    setLive(false);
                }
            }
        };
        tick();
        return () => {
            alive = false;
            if (timer) {
                clearTimeout(timer);
            }
        };
    }, [tid, gid]);

    return { game, error, live };
}
