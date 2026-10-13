import { useEffect, useState } from 'react';

// Same hash routes as the original viewer, so its deep links (#/t/<tournament>/g/<game>?step=300) open here too.
export type Route =
    | { page: 'home' }
    | { page: 'tournament'; tid: string; g: string | null }
    | { page: 'game'; tid: string; gid: string; step: number }
    | { page: 'effects' }
    | { page: 'icons'; tid: string | null; gid: string | null };

export function parseRoute(hash: string): Route {
    const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
    const parts = path.split('/').map(decodeURIComponent);
    const q = new URLSearchParams(query);
    if (parts[0] === 'effects') {
        return { page: 'effects' };
    }
    if (parts[0] === 'icons') {
        return { page: 'icons', tid: q.get('t'), gid: q.get('g') };
    }
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
export function hrefGame(tid: string, gid: string, step?: number, score?: string | null) {
    const q = new URLSearchParams({ ...(step ? { step: String(step) } : {}), ...(score != null ? { score } : {}) }).toString();
    return `#/t/${encodeURIComponent(tid)}/g/${encodeURIComponent(gid)}${q ? `?${q}` : ''}`;
}

/** A query parameter of the current hash route (?score= on a game page), or null. */
export const hashParam = (key: string) => new URLSearchParams(window.location.hash.split('?')[1] ?? '').get(key);

export function useRoute(): Route {
    const [route, setRoute] = useState(() => parseRoute(window.location.hash));
    useEffect(() => {
        const on = () => setRoute(parseRoute(window.location.hash));
        window.addEventListener('hashchange', on);
        return () => window.removeEventListener('hashchange', on);
    }, []);
    return route;
}

/** Updates ?step= (and ?score=, the score shown) without adding a history entry or re-routing. */
export function replaceStep(tid: string, gid: string, step: number, score?: string | null) {
    const url = hrefGame(tid, gid, step, score);
    try {
        if (window.location.hash !== url) {
            history.replaceState(null, '', url);
        }
    } catch {
        // sandboxed frames may refuse history access; the step just isn't kept in the URL
    }
}
