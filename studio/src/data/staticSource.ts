import type { DataSource } from './source';
import type { TournamentIndex, TournamentSummary } from './types';

// Tournaments staged by fixtures/stage.mjs (real replays or generated fixtures). Either bundled into the page as raw
// text (studio/static-replays), or, with STATIC_DATA=files, published as files beside the page under data/ (with a
// data/manifest.json listing the tournaments) and fetched when opened, so a preview can carry more games than fit in one file.
const files = import.meta.glob('../../static-replays/**/*.{json,jsonl}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const PREFIX = '../../static-replays/';
const byPath = new Map(Object.entries(files).map(([k, v]) => [k.slice(PREFIX.length), v]));
const bundled = byPath.size > 0;
const t0 = Date.now();
const fetched = new Map<string, Promise<string | null>>();

/** A staged file's text, or null when it isn't there. */
function get(rel: string): Promise<string | null> {
    if (bundled) {
        return Promise.resolve(byPath.get(rel) ?? null);
    }
    let p = fetched.get(rel);
    if (!p) {
        p = fetch(`data/${rel}`).then((r) => (r.ok ? r.text() : null)).catch(() => null);
        fetched.set(rel, p);
    }
    return p;
}

async function read(rel: string): Promise<string> {
    const v = await get(rel);
    if (v == null) {
        throw new Error(`${rel}: not in the preview's replays`);
    }
    return v;
}

/**
 * A game the fixture index lists as "running" has no end record. To show live following, its lines are revealed a
 * few per second from the moment the page opened, the way the tournament runner appends them.
 */
function revealLive(text: string): string {
    const lines = text.split('\n').filter(Boolean);
    const shown = Math.min(lines.length, Math.floor(lines.length * 0.35) + Math.floor((Date.now() - t0) / 700));
    return lines.slice(0, shown).join('\n') + '\n';
}

export const staticSource: DataSource = {
    async loadEvals(_tid, gid) {
        const t = await get(`_evals/${gid}.json`);
        return t ? JSON.parse(t) : null;
    },
    async loadLens(_tid, gid) {
        const t = await get(`_lens/${gid}.json`);
        return t ? JSON.parse(t) : null;
    },
    kind: 'static',
    async listTournaments() {
        const ids = bundled
            ? [...byPath.keys()].map((rel) => rel.match(/^([^/]+)\/index\.json$/)?.[1]).filter((x): x is string => !!x)
            : (JSON.parse(await read('manifest.json')) as { tournaments: string[] }).tournaments;
        const out: TournamentSummary[] = [];
        for (const id of ids) {
            const idx = JSON.parse(await read(`${id}/index.json`)) as TournamentIndex;
            out.push({ id, createdAt: idx.createdAt, engine: idx.engine, bots: idx.bots, games: idx.games.length });
        }
        return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async loadIndex(tid) {
        return JSON.parse(await read(`${tid}/index.json`));
    },
    async loadGameText(tid, gid) {
        const idx = JSON.parse(await read(`${tid}/index.json`)) as TournamentIndex;
        const text = await read(`${tid}/games/${gid}.jsonl`);
        return idx.games.find((g) => g.id === gid)?.outcome === 'running' ? revealLive(text) : text;
    }
};
