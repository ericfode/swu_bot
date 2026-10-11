import { useEffect, useState } from 'react';
import { GameViewer } from '../kit/GameViewer';
import { useGame } from '../data/hooks';
import { dataSource } from '../data/source';
import type { EvalFile } from '../data/evals';
import type { LensFile } from '../data/lens';
import { hrefTournament, replaceStep } from '../lib/route';

export function GamePage({ tid, gid, startStep }: { tid: string; gid: string; startStep: number }) {
    const { game, error, live } = useGame(tid, gid);
    const [evals, setEvals] = useState<EvalFile | null>(null);
    const [lens, setLens] = useState<LensFile | null>(null);
    useEffect(() => {
        let alive = true;
        dataSource().then((s) => s.loadEvals(tid, gid)).then((e) => alive && setEvals(e), () => undefined);
        dataSource().then((s) => s.loadLens(tid, gid)).then((l) => alive && setLens(l), () => undefined);
        return () => {
            alive = false;
        };
    }, [tid, gid]);
    if (error && !game) {
        return <div className="p-8 text-p2">Couldn't load this game: {error}</div>;
    }
    if (!game) {
        return <div className="p-8 text-dim">Loading game…</div>;
    }
    return (
        <div className="px-4 py-3 md:py-4">
            <GameViewer key={`${tid}/${gid}`} game={game} live={live} startStep={startStep} evals={evals} lens={lens} keyboard="window" fillWindow
                back={{ href: hrefTournament(tid), label: tid }} onStep={(s) => replaceStep(tid, gid, s)} />
        </div>
    );
}
