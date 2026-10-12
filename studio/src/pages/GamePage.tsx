import { useCallback, useEffect, useRef, useState } from 'react';
import { GameViewer } from '../kit/GameViewer';
import { useGame } from '../data/hooks';
import { dataSource, type DataSource } from '../data/source';
import type { EvalFile } from '../data/evals';
import type { LensIndex } from '../data/lensFile';
import type { LensInput } from '../data/score';
import { hashParam, hrefTournament, replaceStep } from '../lib/route';

/**
 * Every lens file this game has: the default path, then each dir the registry lists. A dir whose index.json lists its
 * games is asked only when it lists this one (no 404 per missing game); a missing file means that score has none.
 */
async function loadLenses(s: DataSource, tid: string, gid: string): Promise<{ registry: LensIndex | null; files: LensInput[] }> {
    const registry = await s.loadLensIndex().catch(() => null);
    const dirs = [...new Set(['', ...(registry?.evaluators.map((e) => e.dir) ?? [])])];
    const files = await Promise.all(dirs.map(async (dir): Promise<LensInput | null> => {
        // without a registry only the default path is asked, as before (no request for an index nobody wrote)
        const idx = registry ? await s.loadLensDirIndex(dir).catch(() => null) : null;
        if (idx?.games && !idx.games.includes(gid)) {
            return null;
        }
        const file = await s.loadLens(tid, gid, dir).catch(() => null);
        return file ? { dir, file } : null;
    }));
    return { registry, files: files.filter((f): f is LensInput => !!f) };
}

export function GamePage({ tid, gid, startStep }: { tid: string; gid: string; startStep: number }) {
    const { game, error, live } = useGame(tid, gid);
    const [evals, setEvals] = useState<EvalFile | null>(null);
    const [lens, setLens] = useState<{ registry: LensIndex | null; files: LensInput[] } | null>(null);
    // ?score=<dir> opens on that score; picking another keeps the URL in step with the view
    const [score, setScore] = useState(() => hashParam('score'));
    const at = useRef(startStep);
    // a new ?score= in the address (a pasted link to the same game) switches the score, as a new ?step= moves the playhead
    useEffect(() => {
        const on = () => setScore(hashParam('score'));
        window.addEventListener('hashchange', on);
        return () => window.removeEventListener('hashchange', on);
    }, []);
    useEffect(() => {
        let alive = true;
        dataSource().then((s) => s.loadEvals(tid, gid)).then((e) => alive && setEvals(e), () => undefined);
        dataSource().then((s) => loadLenses(s, tid, gid)).then((l) => alive && setLens(l), () => undefined);
        return () => {
            alive = false;
        };
    }, [tid, gid]);
    const onStep = useCallback((s: number) => {
        at.current = s;
        replaceStep(tid, gid, s, score);
    }, [tid, gid, score]);
    const onScore = useCallback((key: string) => {
        setScore(key);
        replaceStep(tid, gid, at.current, key);
    }, [tid, gid]);
    if (error && !game) {
        return <div className="p-8 text-p2">Couldn't load this game: {error}</div>;
    }
    if (!game) {
        return <div className="p-8 text-dim">Loading game…</div>;
    }
    return (
        <div className="px-4 py-3 md:py-4">
            <GameViewer key={`${tid}/${gid}`} game={game} live={live} startStep={startStep} evals={evals} lens={lens?.files ?? null} registry={lens?.registry ?? null}
                score={score} onScore={onScore} keyboard="window" fillWindow back={{ href: hrefTournament(tid), label: tid }} onStep={onStep} />
        </div>
    );
}
