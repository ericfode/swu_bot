import { useEffect, useMemo, useState } from 'react';
import { Image, Shapes } from 'lucide-react';
import { ActionIcon, tierFor } from '../kit/ActionIcon';
import { ACTION_CLASSES, classifyGame, describe, pivotalActions, type Action, type ActionClass } from '../data/actions';
import { useGame } from '../data/hooks';
import { dataSource } from '../data/source';
import { useSettings } from '../lib/settings';
import { hrefGame } from '../lib/route';

const SIZES = [14, 18, 28, 40, 64, 120];

/** Every action class at every size tier, with real cards from a game, plus that game's pivotal plays. */
export function IconsPage({ tid, gid }: { tid: string | null; gid: string | null }) {
    const [pick, setPick] = useState<{ tid: string; gid: string } | null>(tid && gid ? { tid, gid } : null);
    useEffect(() => {
        if (pick) {
            return;
        }
        dataSource().then(async (s) => {
            const ts = await s.listTournaments();
            const t = ts.find((x) => x.engine !== 'fixture') ?? ts[0];
            if (t) {
                const idx = await s.loadIndex(t.id);
                const g = [...idx.games].filter((x) => x.outcome === 'won').sort((a, b) => b.steps - a.steps)[0] ?? idx.games[0];
                setPick({ tid: t.id, gid: g.id });
            }
        });
    }, [pick]);
    const { game } = useGame(pick?.tid ?? '', pick?.gid ?? null);
    const { art, setArt } = useSettings();
    const actions = useMemo(() => (game ? classifyGame(game) : []), [game]);
    const sample = useMemo(() => {
        const m = new Map<ActionClass, Action>();
        for (const a of actions) {
            const cur = m.get(a.cls);
            if (!cur || (!cur.card && a.card) || (a.outcome.baseDamage + a.outcome.defeated > cur.outcome.baseDamage + cur.outcome.defeated)) {
                m.set(a.cls, a);
            }
        }
        return m;
    }, [actions]);
    const pivotal = useMemo(() => pivotalActions(actions, 8), [actions]);
    const bots = game ? { p1: game.header.players[0].bot, p2: game.header.players[1].bot } : { p1: 'p1', p2: 'p2' };
    return (
        <div className="p-4 md:p-8 flex flex-col gap-6 max-w-[1200px]">
            <header className="flex flex-wrap items-end gap-4">
                <div>
                    <div className="eyebrow">Viewer kit</div>
                    <h1 className="text-3xl font-extrabold m-0 mt-1">Action icons</h1>
                    <p className="text-dim max-w-[70ch] mt-2 mb-0 text-[13px]">
                        Each decision is grouped into an action and drawn with its card. The drawing changes with size so only legible detail is shown:
                        glyph under 22px, chip under 48px, card under 96px, card with caption above.
                        {pick && game && <> Cards come from <a className="text-p1" href={hrefGame(pick.tid, pick.gid)}>{bots.p1} vs {bots.p2}</a> ({pick.tid}).</>}
                    </p>
                </div>
                <div className="inline-flex rounded-lg border border-line bg-ink p-0.5 ml-auto" role="group" aria-label="Card display">
                    <button className="btn !h-8 !border-0 !bg-transparent aria-pressed:!bg-raise text-dim aria-pressed:!text-fg" aria-pressed={!art} onClick={() => setArt(false)}><Shapes size={14} />Vector</button>
                    <button className="btn !h-8 !border-0 !bg-transparent aria-pressed:!bg-raise text-dim aria-pressed:!text-fg" aria-pressed={art} onClick={() => setArt(true)}><Image size={14} />Card art</button>
                </div>
            </header>
            {!game && <div className="text-dim">Loading a game…</div>}
            {game && (
                <section className="panel p-4 overflow-x-auto" aria-labelledby="matrix-h">
                    <h2 id="matrix-h" className="eyebrow m-0 mb-3">Every class at every size</h2>
                    <table className="border-separate border-spacing-x-4 border-spacing-y-3" data-testid="icon-matrix">
                        <thead>
                            <tr>
                                <th className="text-left text-faint font-normal text-xs">class</th>
                                {SIZES.map((s) => <th key={s} className="text-faint font-normal text-xs num text-left">{s}px · {tierFor(s)}</th>)}
                            </tr>
                        </thead>
                        <tbody>
                            {ACTION_CLASSES.map((c) => {
                                const a = sample.get(c.cls);
                                const seat = a?.seat ?? 'p1';
                                return (
                                    <tr key={c.cls} data-class={c.cls}>
                                        <td className="text-dim text-[13px] whitespace-nowrap align-middle">{c.label}{!a && <span className="text-faint"> (not in this game)</span>}</td>
                                        {SIZES.map((s) => (
                                            <td key={s} className="align-middle">
                                                <ActionIcon cls={c.cls} seat={seat} card={a?.card ?? null} outcome={a?.outcome} size={s} caption={a ? describe(a, bots[seat]) : c.label} />
                                            </td>
                                        ))}
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </section>
            )}
            {game && (
                <section className="panel p-4" aria-labelledby="piv-h">
                    <h2 id="piv-h" className="eyebrow m-0 mb-3">Pivotal plays in this game</h2>
                    <div className="flex flex-wrap gap-4" data-testid="pivotal">
                        {pivotal.map((a) => (
                            <a key={a.index} href={pick ? hrefGame(pick.tid, pick.gid, a.index) : undefined}>
                                <ActionIcon cls={a.cls} seat={a.seat} card={a.card} outcome={a.outcome} size={110} caption={`${describe(a, bots[a.seat])} · step ${game.steps[a.index].n}`} />
                            </a>
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
}
