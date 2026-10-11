import { useEffect, useMemo, useState } from 'react';
import { Image, Shapes } from 'lucide-react';
import { ActionIcon, tierFor } from '../kit/ActionIcon';
import { ACTION_CLASSES, classifyGame, describe, pivotalActions, type Action, type ActionClass, type Outcome } from '../data/actions';
import { useGame } from '../data/hooks';
import { dataSource } from '../data/source';
import { useSettings } from '../lib/settings';
import { hrefGame } from '../lib/route';

const SIZES = [14, 18, 28, 40, 64, 120];
/** both sides of every tier boundary */
const EDGES = [16, 23, 24, 31, 32, 47, 48, 55, 56, 63, 64, 79, 80, 95, 96];
const LOG_SIZES = [14, 16, 18];
/** outcomes to check that tags fit and read as counts (stolen, selfBaseDamage and lost are optional Outcome fields) */
const TAG_CASES: { name: string; o: Outcome }[] = [
    { name: 'base + defeated', o: { baseDamage: 7, defeated: 1, entered: 0 } as Outcome },
    { name: 'two-digit base, 2 defeated', o: { baseDamage: 17, defeated: 2, entered: 0 } as Outcome },
    { name: 'stolen, own base, lost', o: { baseDamage: 0, defeated: 0, entered: 0, stolen: 1, selfBaseDamage: 4, lost: 2 } as Outcome }
];
const TAG_SIZES = [48, 56, 64, 80, 120];

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
    const withCard = [...sample.values()].filter((a) => a.card).sort((a, b) => b.outcome.baseDamage + b.outcome.defeated - a.outcome.baseDamage - a.outcome.defeated)[0];
    const cardless = sample.get('pass') ?? sample.get('initiative') ?? null;
    const bots = game ? { p1: game.header.players[0].bot, p2: game.header.players[1].bot } : { p1: 'p1', p2: 'p2' };
    return (
        <div className="p-4 md:p-8 flex flex-col gap-6 max-w-[1200px]">
            <header className="flex flex-wrap items-end gap-4">
                <div>
                    <div className="eyebrow">Viewer kit</div>
                    <h1 className="text-3xl font-extrabold m-0 mt-1">Action icons</h1>
                    <p className="text-dim max-w-[70ch] mt-2 mb-0 text-[13px]">
                        Each decision is grouped into an action and drawn with its card. The drawing changes with size so only legible detail is shown:
                        glyph under 32px (bare under 24px, on a ringed disc from 24px), chip under 48px, card under 96px, card with caption above.
                        Actions without a card (pass, initiative, choose, setup) become a pill with the glyph disc from 48px.
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
                <section className="panel p-4" aria-labelledby="log-h">
                    <h2 id="log-h" className="eyebrow m-0 mb-3">Glyphs side by side at decision-log sizes</h2>
                    <div className="flex flex-col gap-2" data-testid="glyph-rows">
                        {LOG_SIZES.flatMap((s) => (['p1', 'p2'] as const).map((seat) => (
                            <div key={`${s}${seat}`} className="flex items-center gap-3">
                                <span className="text-faint text-xs num w-16">{s}px {seat}</span>
                                {ACTION_CLASSES.map((c) => <ActionIcon key={c.cls} cls={c.cls} seat={seat} size={s} title={c.label} />)}
                            </div>
                        )))}
                    </div>
                </section>
            )}
            {game && withCard && (
                <section className="panel p-4 overflow-x-auto" aria-labelledby="edge-h">
                    <h2 id="edge-h" className="eyebrow m-0 mb-3">Tier boundaries</h2>
                    <div className="flex flex-col gap-4" data-testid="tier-edges">
                        {[withCard, cardless].filter((a): a is Action => !!a).map((a) => (
                            <div key={a.index} className="flex items-end gap-4">
                                {EDGES.map((s) => (
                                    <div key={s} className="flex flex-col items-center gap-1">
                                        <ActionIcon cls={a.cls} seat={a.seat} card={a.card} outcome={a.outcome} size={s} caption={describe(a, bots[a.seat])} />
                                        <span className="text-faint text-[11px] num whitespace-nowrap">{s} · {tierFor(s)}</span>
                                    </div>
                                ))}
                            </div>
                        ))}
                    </div>
                </section>
            )}
            {game && withCard?.card && (
                <section className="panel p-4 overflow-x-auto" aria-labelledby="tags-h">
                    <h2 id="tags-h" className="eyebrow m-0 mb-3">Outcome tags</h2>
                    <table className="border-separate border-spacing-x-4 border-spacing-y-3" data-testid="tag-matrix">
                        <tbody>
                            {TAG_CASES.map((tc) => (
                                <tr key={tc.name}>
                                    <td className="text-dim text-[13px] whitespace-nowrap align-middle">{tc.name}</td>
                                    {TAG_SIZES.map((s) => (
                                        <td key={s} className="align-bottom">
                                            <ActionIcon cls="attack" seat={withCard.seat} card={withCard.card} outcome={tc.o} size={s} caption={`${s}px`} />
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            )}
            {game && withCard && (
                <section className="rounded-xl p-4 bg-[#f4f6fb] text-[#1d2433]" aria-labelledby="light-h" data-testid="light-host">
                    <h2 id="light-h" className="eyebrow m-0 mb-3 !text-[#4a5675]">On a light host page</h2>
                    <div className="flex flex-wrap items-end gap-6">
                        <ActionIcon cls={withCard.cls} seat={withCard.seat} card={withCard.card} outcome={withCard.outcome} size={110} caption={describe(withCard, bots[withCard.seat])} />
                        {cardless && <ActionIcon cls={cardless.cls} seat={cardless.seat} size={110} caption={describe(cardless, bots[cardless.seat])} />}
                        {cardless && <ActionIcon cls={cardless.cls} seat={cardless.seat} size={64} />}
                        <span className="inline-flex items-center gap-2">
                            {ACTION_CLASSES.map((c) => <ActionIcon key={c.cls} cls={c.cls} seat={c.major ? 'p1' : 'p2'} size={18} title={c.label} />)}
                        </span>
                    </div>
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
