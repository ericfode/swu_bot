import { useEffect, useState } from 'react';
import { dataSource, parseGame } from './source';
import type { Game, TournamentIndex, TournamentSummary } from './types';

/** Loads once, then reloads every `everyMs` while `keepPolling(data)` says so. */
function usePolled<T>(load: () => Promise<T>, deps: unknown[], everyMs: number, keepPolling: (d: T) => boolean) {
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        let alive = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        setData(null);
        setError(null);
        const run = async () => {
            try {
                const d = await load();
                if (!alive) {
                    return;
                }
                setData(d);
                setError(null);
                if (keepPolling(d)) {
                    timer = setTimeout(run, everyMs);
                }
            } catch (e) {
                if (alive) {
                    setError((e as Error).message);
                    timer = setTimeout(run, everyMs * 3);
                }
            }
        };
        run();
        return () => {
            alive = false;
            clearTimeout(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
    return { data, error };
}

export const useTournaments = () => usePolled<TournamentSummary[]>(async () => (await dataSource()).listTournaments(), [], 5000, () => true);

export const useIndex = (tid: string) =>
    usePolled<TournamentIndex>(async () => (await dataSource()).loadIndex(tid), [tid], 2000, (d) => d.games.some((g) => g.outcome === 'running'));

/** A game with no end record yet is still being played: it is re-read every second so new moves stream in. */
export function useGame(tid: string, gid: string | null) {
    const r = usePolled<Game | null>(
        async () => (gid ? parseGame(await (await dataSource()).loadGameText(tid, gid), true) : null),
        [tid, gid], 1000, (g) => !!gid && (g == null || g.end == null)
    );
    return { game: r.data, error: r.error, live: !!r.data && r.data.end == null };
}
