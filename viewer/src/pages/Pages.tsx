import { useMemo, useState } from 'react';
import { listTournaments, loadGame, loadIndex } from '../core/api';
import { Replay } from '../core/Replay';
import { standings, headToHead } from '../core/stats';
import { hrefGame, hrefTournament, usePolled } from '../core/useRoute';
import type { IndexGame } from '../core/types';

function Status({ error, loading, what }: { error: string | null; loading: boolean; what: string }) {
    if (error) {
        return <p className="banner">Could not load {what}: {error}</p>;
    }
    return loading ? <p className="muted">Loading {what}…</p> : null;
}

export function HomePage() {
    const { data, error } = usePolled(listTournaments, [], 5000);
    return (
        <section className="page">
            <h1>Tournaments</h1>
            <p className="muted">Folders under <code>replays/</code>. Create one with <code>node bot/tournament.js --bots a,b --games 10 --out replays/my-run</code>.</p>
            <Status error={error} loading={!data} what="tournaments" />
            {data && data.length === 0 && <p className="empty">No tournaments yet. Run <code>npm run demo</code> from the repo root to record a few games.</p>}
            <div className="cards">
                {data?.map((t) => (
                    <a key={t.id} className="tcard" href={hrefTournament(t.id)}>
                        <strong>{t.id}</strong>
                        <span className="muted">{t.bots.join(' · ')}</span>
                        <span className="mono">{t.games} games · engine {t.engine ?? 'unknown'}</span>
                        <span className="muted">{new Date(t.createdAt).toLocaleString()}</span>
                    </a>
                ))}
            </div>
        </section>
    );
}

export function GamePage({ tid, gid, step }: { tid: string; gid: string; step: number }) {
    const { data, error } = usePolled(() => loadGame(tid, gid), [tid, gid]);
    return (
        <section className="page wide">
            <nav className="crumbs"><a href="#/">Tournaments</a> / <a href={hrefTournament(tid)}>{tid}</a> / <span className="mono">{gid}</span></nav>
            <Status error={error} loading={!data} what="game" />
            {data && <Replay game={data} startStep={step} />}
        </section>
    );
}

function pct(wins: number, n: number): string {
    return n === 0 ? '–' : `${Math.round((wins / n) * 100)}%`;
}

export function TournamentPage({ tid }: { tid: string }) {
    const { data: index, error } = usePolled(() => loadIndex(tid), [tid], 4000);
    const [pair, setPair] = useState<[string, string] | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const game = usePolled(() => (selected ? loadGame(tid, selected) : Promise.resolve(null)), [tid, selected]);
    const rows = useMemo(() => (index ? standings(index.bots, index.games) : []), [index]);
    const shown: IndexGame[] = useMemo(() => {
        if (!index) {
            return [];
        }
        const all = pair ? index.games.filter((g) => (g.p1 === pair[0] && g.p2 === pair[1]) || (g.p1 === pair[1] && g.p2 === pair[0])) : index.games;
        return all;
    }, [index, pair]);
    const maxElo = Math.max(1100, ...rows.map((r) => r.elo));
    const minElo = Math.min(900, ...rows.map((r) => r.elo));

    return (
        <section className="page wide">
            <nav className="crumbs"><a href="#/">Tournaments</a> / <span>{tid}</span></nav>
            <Status error={error} loading={!index} what="tournament" />
            {index && (
                <>
                    <div className="grid2">
                        <div className="panel">
                            <h2>Head to head</h2>
                            <p className="muted small">Row bot's win rate against column bot. Select a cell to list just those games.</p>
                            <div className="matrix-wrap">
                                <table className="matrix">
                                    <thead><tr><th />{index.bots.map((b) => <th key={b}>{b}</th>)}</tr></thead>
                                    <tbody>
                                        {index.bots.map((r) => (
                                            <tr key={r}>
                                                <th scope="row">{r}</th>
                                                {index.bots.map((c) => {
                                                    if (r === c) {
                                                        return <td key={c} className="self">–</td>;
                                                    }
                                                    const { wins, n } = headToHead(index.games, r, c);
                                                    const rate = n ? wins / n : 0.5;
                                                    const on = pair?.[0] === r && pair?.[1] === c;
                                                    const mix = Math.round(Math.abs(rate - 0.5) * 2 * 55);
                                                    return (
                                                        <td key={c}>
                                                            <button
                                                                className={on ? 'on' : ''}
                                                                style={n ? { background: `color-mix(in srgb, var(${rate >= 0.5 ? '--good' : '--bad'}) ${mix}%, var(--surface))` } : undefined}
                                                                onClick={() => setPair(on ? null : [r, c])}
                                                                aria-pressed={on}
                                                                aria-label={`${r} versus ${c}: ${wins} of ${n} won`}
                                                            >
                                                                {pct(wins, n)}<small>{n ? `${wins}/${n}` : ''}</small>
                                                            </button>
                                                        </td>
                                                    );
                                                })}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                        <div className="panel">
                            <h2>Standings</h2>
                            <p className="muted small">Elo is a simple sequential rating from 1000, K=24.</p>
                            <div className="elo">
                                {rows.map((r) => (
                                    <div key={r.bot} className="elo-row">
                                        <span>{r.bot}</span>
                                        <div className="bar"><i style={{ width: `${((r.elo - minElo) / (maxElo - minElo)) * 100}%` }} /></div>
                                        <b className="mono">{Math.round(r.elo)}</b>
                                        <span className="muted mono small">{r.wins}-{r.losses}{r.draws ? `-${r.draws}` : ''}{r.errors ? ` · ${r.errors} err` : ''}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div className="grid2 games-split">
                        <div className="panel">
                            <h2>Games{pair ? `: ${pair[0]} vs ${pair[1]}` : ''} <span className="muted small">({shown.length})</span></h2>
                            {pair && <button className="btn small" onClick={() => setPair(null)}>Show all</button>}
                            <ul className="game-list">
                                {shown.map((g) => (
                                    <li key={g.id}>
                                        <button className={selected === g.id ? 'on' : ''} onClick={() => setSelected(g.id)}>
                                            <span className="mono">seed {g.seed}</span>
                                            <span>{g.p1} vs {g.p2}</span>
                                            <span className={g.outcome === 'won' ? '' : 'bad'}>{g.outcome === 'won' ? `${g.winner} · R${g.rounds}` : g.outcome}</span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                        <div className="panel preview-panel">
                            {!selected && <p className="muted">Choose a game to watch it here.</p>}
                            {selected && (
                                <>
                                    <div className="row-between">
                                        <h2 className="mono">{selected}</h2>
                                        <a className="btn small" href={hrefGame(tid, selected)}>Open full page</a>
                                    </div>
                                    <Status error={game.error} loading={!game.data} what="game" />
                                    {game.data && <Replay game={game.data} />}
                                </>
                            )}
                        </div>
                    </div>
                </>
            )}
        </section>
    );
}
