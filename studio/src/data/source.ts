import type { EvalFile } from './evals';
import type { LensFile } from './lens';
import type { End, Game, Header, Step, TournamentIndex, TournamentSummary } from './types';

/** Where replays come from: the replays server (same routes as viewer/server.cjs) or fixtures baked into the build. */
export interface DataSource {
    kind: 'http' | 'static';
    listTournaments(): Promise<TournamentSummary[]>;
    loadIndex(tid: string): Promise<TournamentIndex>;
    /** Raw JSON Lines text of one game; a game still being played may end mid-line. */
    loadGameText(tid: string, gid: string): Promise<string>;
    /** Position evaluations for a game (dashboard evals contract), or null when it has none. */
    loadEvals(tid: string, gid: string): Promise<EvalFile | null>;
    /** The omni bot's card values for a game (swu-lens/1), or null when it has none. */
    loadLens(tid: string, gid: string): Promise<LensFile | null>;
}

async function get(url: string): Promise<Response> {
    const r = await fetch(url);
    if (!r.ok) {
        throw new Error(`${url}: ${r.status}`);
    }
    return r;
}

const httpSource: DataSource = {
    kind: 'http',
    listTournaments: async () => (await get('/api/tournaments')).json(),
    loadIndex: async (tid) => (await get(`/replays/${encodeURIComponent(tid)}/index.json`)).json(),
    loadGameText: async (tid, gid) => (await get(`/replays/${encodeURIComponent(tid)}/games/${encodeURIComponent(gid)}.jsonl`)).text(),
    loadEvals: async (_tid, gid) => {
        const r = await fetch(`/evals/${encodeURIComponent(gid)}.json`);
        return r.ok ? r.json() : null;
    },
    loadLens: async (_tid, gid) => {
        const r = await fetch(`/lens/${encodeURIComponent(gid)}.json`);
        return r.ok ? r.json() : null;
    }
};

let chosen: Promise<DataSource> | null = null;
export function dataSource(): Promise<DataSource> {
    if (!chosen) {
        chosen = import.meta.env.MODE === 'static' ? import('./staticSource').then((m) => m.staticSource) : Promise.resolve(httpSource);
    }
    return chosen;
}

/**
 * Same parsing rules as the original viewer's loadGame: one header, steps (step 0 is the opening board), one end.
 * With allowPartial, an unfinished last line is ignored and a file with no complete step yet returns null.
 */
export function parseGame(text: string, allowPartial: boolean): Game | null {
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
        throw new Error('game file has no header or steps');
    }
    return { header, steps, end };
}
