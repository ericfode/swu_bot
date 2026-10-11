import { useEffect, useState } from 'react';

export type Route =
    | { page: 'home' }
    | { page: 'tournament'; tid: string; g: string | null }
    | { page: 'game'; tid: string; gid: string; step: number };

function parse(hash: string): Route {
    const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
    const parts = path.split('/').map(decodeURIComponent);
    const step = Number(new URLSearchParams(query).get('step') ?? 0) || 0;
    if (parts[0] === 't' && parts[1] && parts[2] === 'g' && parts[3]) {
        return { page: 'game', tid: parts[1], gid: parts[3], step };
    }
    if (parts[0] === 't' && parts[1]) {
        return { page: 'tournament', tid: parts[1], g: new URLSearchParams(query).get('g') };
    }
    return { page: 'home' };
}

export const hrefTournament = (tid: string) => `#/t/${encodeURIComponent(tid)}`;
export const hrefGame = (tid: string, gid: string) => `#/t/${encodeURIComponent(tid)}/g/${encodeURIComponent(gid)}`;

export function useRoute(): Route {
    const [route, setRoute] = useState<Route>(parse(window.location.hash));
    useEffect(() => {
        const on = () => setRoute(parse(window.location.hash));
        window.addEventListener('hashchange', on);
        return () => window.removeEventListener('hashchange', on);
    }, []);
    return route;
}

/** Polls a loader while the page is open, so tournaments still running show up as games finish. */
export function usePolled<T>(load: () => Promise<T>, deps: unknown[], everyMs = 0): { data: T | null; error: string | null } {
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        let alive = true;
        const run = () => load().then((d) => {
            if (alive) {
                setData(d);
                setError(null);
            }
        }, (e: Error) => {
            if (alive) {
                setError(e.message);
            }
        });
        setData(null);
        run();
        const t = everyMs > 0 ? setInterval(run, everyMs) : null;
        return () => {
            alive = false;
            if (t) {
                clearInterval(t);
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
    return { data, error };
}
