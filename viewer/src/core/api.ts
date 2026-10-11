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

/**
 * A game file is JSON Lines: one header, one step per decision (step 0 is the opening board), one end.
 * With `allowPartial`, a game that is still being written is fine: an unfinished last line is ignored and a file
 * with no complete step yet returns null.
 */
export async function loadGame(tid: string, gid: string, allowPartial: true): Promise<Game | null>;
export async function loadGame(tid: string, gid: string): Promise<Game>;
export async function loadGame(tid: string, gid: string, allowPartial = false): Promise<Game | null> {
    const r = await fetch(`/replays/${encodeURIComponent(tid)}/games/${encodeURIComponent(gid)}.jsonl`);
    if (!r.ok) {
        throw new Error(`game ${gid}: ${r.status}`);
    }
    const text = await r.text();
    const lines = text.split('\n');
    if (!text.endsWith('\n')) {
        lines.pop();
    }
    let header: Header | null = null;
    let end: End | null = null;
    const steps: Step[] = [];
    for (const line of lines) {
        if (!line) {
            continue;
        }
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
        if (allowPartial) {
            return null;
        }
        throw new Error(`game ${gid}: file has no header or steps`);
    }
    return { header, steps, end };
}
