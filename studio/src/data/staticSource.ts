import type { DataSource } from './source';
import type { TournamentIndex, TournamentSummary } from './types';

// Tournaments staged into studio/static-replays by fixtures/stage.mjs (real replays or generated fixtures), bundled as raw text.
const files = import.meta.glob('../../static-replays/**/*.{json,jsonl}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const PREFIX = '../../static-replays/';
const byPath = new Map(Object.entries(files).map(([k, v]) => [k.slice(PREFIX.length), v]));
const t0 = Date.now();

function read(rel: string): string {
    const v = byPath.get(rel);
    if (v == null) {
        throw new Error(`${rel}: not in the bundled replays`);
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
        const t = byPath.get(`_evals/${gid}.json`);
        return t ? JSON.parse(t) : null;
    },
    async loadLens(_tid, gid) {
        const t = byPath.get(`_lens/${gid}.json`);
        return t ? JSON.parse(t) : null;
    },
    kind: 'static',
    async listTournaments() {
        const out: TournamentSummary[] = [];
        for (const [rel, text] of byPath) {
            const m = rel.match(/^([^/]+)\/index\.json$/);
            if (m) {
                const idx = JSON.parse(text) as TournamentIndex;
                out.push({ id: m[1], createdAt: idx.createdAt, engine: idx.engine, bots: idx.bots, games: idx.games.length });
            }
        }
        return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async loadIndex(tid) {
        return JSON.parse(read(`${tid}/index.json`));
    },
    async loadGameText(tid, gid) {
        const idx = JSON.parse(read(`${tid}/index.json`)) as TournamentIndex;
        const text = read(`${tid}/games/${gid}.jsonl`);
        return idx.games.find((g) => g.id === gid)?.outcome === 'running' ? revealLive(text) : text;
    }
};
