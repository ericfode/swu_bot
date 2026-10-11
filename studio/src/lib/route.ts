import { useEffect, useState } from 'react';

// Same hash routes as the original viewer, so its deep links (#/t/<tournament>/g/<game>?step=300) open here too.
export type Route =
    | { page: 'home' }
    | { page: 'tournament'; tid: string; g: string | null }
    | { page: 'game'; tid: string; gid: string; step: number };

export function parseRoute(hash: string): Route {
    const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
    const parts = path.split('/').map(decodeURIComponent);
    const q = new URLSearchParams(query);
    if (parts[0] === 't' && parts[1] && parts[2] === 'g' && parts[3]) {
        return { page: 'game', tid: parts[1], gid: parts[3], step: Number(q.get('step') ?? 0) || 0 };
    }
    if (parts[0] === 't' && parts[1]) {
        return { page: 'tournament', tid: parts[1], g: q.get('g') };
    }
    return { page: 'home' };
}

export const hrefHome = () => '#/';
export const hrefTournament = (tid: string) => `#/t/${encodeURIComponent(tid)}`;
export const hrefGame = (tid: string, gid: string, step?: number) => `#/t/${encodeURIComponent(tid)}/g/${encodeURIComponent(gid)}${step ? `?step=${step}` : ''}`;

export function useRoute(): Route {
    const [route, setRoute] = useState(() => parseRoute(window.location.hash));
    useEffect(() => {
        const on = () => setRoute(parseRoute(window.location.hash));
        window.addEventListener('hashchange', on);
        return () => window.removeEventListener('hashchange', on);
    }, []);
    return route;
}

/** Updates ?step= without adding a history entry or re-routing. */
export function replaceStep(tid: string, gid: string, step: number) {
    const url = hrefGame(tid, gid, step);
    try {
        if (window.location.hash !== url) {
            history.replaceState(null, '', url);
        }
    } catch {
        // sandboxed frames may refuse history access; the step just isn't kept in the URL
    }
}
