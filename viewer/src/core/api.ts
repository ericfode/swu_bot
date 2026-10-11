import type { End, Game, Header, Step, TournamentIndex, TournamentSummary } from './types';

async function getJson<T>(url: string): Promise<T> {
    const r = await fetch(url);
    if (!r.ok) {
        throw new Error(`${url}: ${r.status}`);
    }
    return r.json() as Promise<T>;
}

export const listTournaments = () => getJson<TournamentSummary[]>('/api/tournaments');
export const loadIndex = (tid: string) => getJson<TournamentIndex>(`/replays/${encodeURIComponent(tid)}/index.json`);

/** A game file is JSON Lines: one header, one step per decision (step 0 is the opening board), one end. */
export async function loadGame(tid: string, gid: string): Promise<Game> {
    const r = await fetch(`/replays/${encodeURIComponent(tid)}/games/${encodeURIComponent(gid)}.jsonl`);
    if (!r.ok) {
        throw new Error(`game ${gid}: ${r.status}`);
    }
    const lines = (await r.text()).split('\n').filter(Boolean);
    let header: Header | null = null;
    let end: End | null = null;
    const steps: Step[] = [];
    for (const line of lines) {
        const e = JSON.parse(line);
        if (e.t === 'header') {
            header = e;
        } else if (e.t === 'step') {
            steps.push(e);
        } else if (e.t === 'end') {
            end = e;
        }
    }
    if (!header || steps.length === 0) {
        throw new Error(`game ${gid}: file has no header or steps`);
    }
    return { header, steps, end };
}
