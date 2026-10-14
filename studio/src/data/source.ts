import type { EvalFile } from './evals';
import { readLensIndex, type LensDirIndex, type LensFile, type LensIndex } from './lensFile';
import type { CardTextFile } from '../lib/cardText';
import type { End, Game, Header, Step, TournamentIndex, TournamentSummary } from './types';
import { resultText } from './result';

/** Where replays come from: the replays server (GET /api/tournaments and /replays/*, spec/replay-format.md) or fixtures baked into the build. */
export interface DataSource {
    kind: 'http' | 'static';
    listTournaments(): Promise<TournamentSummary[]>;
    loadIndex(tid: string): Promise<TournamentIndex>;
    /** Raw JSON Lines text of one game; a game still being played may end mid-line. */
    loadGameText(tid: string, gid: string): Promise<string>;
    /** Position evaluations for a game (dashboard evals contract), or null when it has none. */
    loadEvals(tid: string, gid: string): Promise<EvalFile | null>;
    /** lens/evaluators.json: the dirs that hold scores and the one to open first; null when there is none. */
    loadLensIndex(): Promise<LensIndex | null>;
    /** lens/<dir>/index.json ('' = lens/index.json): one score's games; null when there is none. */
    loadLensDirIndex(dir: string): Promise<LensDirIndex | null>;
    /** One score's lens file for a game (swu-lens/1) from lens/<dir>/ ('' = the default path); null when it has none. */
    loadLens(tid: string, gid: string, dir?: string): Promise<LensFile | null>;
    /** Printed card data (swu-card-text/1) for cards without art, or null when the server or preview has none. */
    loadCardText(): Promise<CardTextFile | null>;
}

/** A lens path: dirs use only [a-z0-9._@-], so '@' stays readable; every other character is encoded. */
export const lensPath = (dir: string, file: string) => `${dir ? `${encodeURIComponent(dir).replace(/%40/g, '@')}/` : ''}${encodeURIComponent(file)}`;

/** A dir index as read, or null when it isn't one (only its games list is used). */
export function readDirIndex(raw: unknown): LensDirIndex | null {
    const r = raw as LensDirIndex | null;
    return r && typeof r === 'object' && r.schema === 'swu-lens-index/1' ? { ...r, games: Array.isArray(r.games) ? r.games.filter((g) => typeof g === 'string') : undefined } : null;
}

/** JSON at a URL, or null for a missing file (404), a network error or a body that isn't JSON. */
async function json(url: string): Promise<unknown> {
    try {
        const r = await fetch(url);
        return r.ok ? await r.json() : null;
    } catch {
        return null;
    }
}

// the registry and the dir indexes, fetched once per page
let lensIndex: Promise<LensIndex | null> | null = null;
const dirIndexes = new Map<string, Promise<LensDirIndex | null>>();

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
    loadLensIndex: () => (lensIndex ??= json('/lens/evaluators.json').then(readLensIndex)),
    loadLensDirIndex: (dir) => {
        let p = dirIndexes.get(dir);
        if (!p) {
            p = json(`/lens/${lensPath(dir, 'index.json')}`).then(readDirIndex);
            dirIndexes.set(dir, p);
        }
        return p;
    },
    loadLens: async (_tid, gid, dir = '') => {
        const r = await fetch(`/lens/${lensPath(dir, `${gid}.json`)}`);
        return r.ok ? r.json() : null;
    },
    loadCardText: async () => {
        try {
            const r = await fetch('/card-text.json');
            return r.ok ? await r.json() : null;
        } catch {
            // a server without the route may answer with the app's HTML
            return null;
        }
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

/**
 * Why a finished game file has no board to show, or null: v2 writes the header before the bots' hello, so a game whose
 * bot failed there has a header and an end and no step.
 */
export function noBoardReason(text: string): string | null {
    let header: Header | null = null;
    let end: End | null = null;
    for (const line of text.split('\n')) {
        try {
            const e = line ? JSON.parse(line) : null;
            if (e?.t === 'step') {
                return null;
            }
            header = e?.t === 'header' ? e : header;
            end = e?.t === 'end' ? e : end;
        } catch {
            // an unfinished last line
        }
    }
    if (!header || !end) {
        return null;
    }
    const bots = { p1: header.players.find((p) => p.id === 'p1')?.bot ?? 'p1', p2: header.players.find((p) => p.id === 'p2')?.bot ?? 'p2' };
    return `the game ended before the first board: ${resultText(end, bots)}${end.error ? ` (${end.error})` : ''}`;
}
