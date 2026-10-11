import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Activity, Radio, Swords, Trophy } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useIndex } from '../data/hooks';
import { headToHead, seatEdge, standings } from '../data/stats';
import type { IndexGame, Seat, TournamentIndex } from '../data/types';
import { failedSeat, fmtMs, ratedSeat, timingText } from '../data/result';
import { botColor } from '../lib/cards';
import { hrefGame } from '../lib/route';

export function TournamentPage({ tid }: { tid: string }) {
    const { data, error } = useIndex(tid);
    if (error && !data) {
        return <div className="p-8 text-p2">Couldn't load tournament {tid}: {error}</div>;
    }
    if (!data) {
        return <div className="p-8 text-dim">Loading {tid}…</div>;
    }
    return <Tournament idx={data} />;
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–');

function Tournament({ idx }: { idx: TournamentIndex }) {
    const { rows, history } = useMemo(() => standings(idx.bots, idx.games), [idx]);
    const running = idx.games.filter((g) => g.outcome === 'running');
    const seats = seatEdge(idx.games);
    const done = idx.games.filter((g) => g.outcome !== 'running');
    const avgSteps = done.length ? Math.round(done.reduce((a, g) => a + g.steps, 0) / done.length) : 0;
    const avgRounds = done.length ? (done.reduce((a, g) => a + g.rounds, 0) / done.length).toFixed(1) : '–';
    const color = (b: string) => botColor(idx.bots, b);
    const maxElo = Math.max(...rows.map((r) => r.elo), 1000);
    const minElo = Math.min(...rows.map((r) => r.elo), 1000);

    return (
        <div className="flex flex-col gap-4 p-4 md:p-6 max-w-[1400px]">
            <header className="flex flex-wrap items-end gap-x-6 gap-y-3">
                <div className="min-w-0">
                    <div className="eyebrow">Tournament · round robin · {idx.gamesPerPairing} per pairing</div>
                    <h1 className="text-3xl md:text-4xl font-extrabold m-0 mt-1 break-all">{idx.id}</h1>
                    <div className="text-dim text-sm mt-1">
                        {new Date(idx.createdAt).toLocaleString()} · engine <span className="num">{idx.engine ?? 'unknown'}</span>
                    </div>
                </div>
                <div className="flex flex-wrap gap-2 md:ml-auto">
                    {running.length > 0 && <span className="chip !text-p2 !border-p2/50"><Radio size={12} className="animate-pulse" />{running.length} live</span>}
                    <Stat label="games" value={`${done.length}/${idx.games.length}`} />
                    <Stat label="avg rounds" value={avgRounds} />
                    <Stat label="avg decisions" value={String(avgSteps)} />
                    <Stat label="first seat wins" value={pct(seats.p1, seats.n)} />
                </div>
            </header>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
                <section className="panel p-4 min-w-0" aria-labelledby="standings-h">
                    <h2 id="standings-h" className="eyebrow m-0 mb-3 flex items-center gap-2"><Trophy size={13} />Standings</h2>
                    <div className="flex flex-col gap-1">
                        {rows.map((r, i) => (
                            <motion.div key={r.bot} layout className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] md:grid-cols-[1.5rem_minmax(0,9rem)_minmax(0,1fr)_auto_auto] items-center gap-3 py-2 border-b border-line/60 last:border-0">
                                <span className="font-display text-faint text-lg">{i + 1}</span>
                                <span className="flex items-center gap-2 min-w-0">
                                    <i className="size-2.5 rounded-full shrink-0" style={{ background: color(r.bot), boxShadow: `0 0 10px ${color(r.bot)}` }} />
                                    <span className="font-display font-semibold truncate">{r.bot}</span>
                                </span>
                                <div className="hidden md:block h-2 rounded-full bg-ink overflow-hidden" title={`Elo ${Math.round(r.elo)}`}>
                                    <motion.div className="h-full rounded-full" style={{ background: color(r.bot) }} initial={{ width: 0 }}
                                        animate={{ width: `${20 + ((r.elo - minElo) / Math.max(1, maxElo - minElo)) * 80}%` }} transition={{ duration: 0.8, delay: i * 0.06 }} />
                                </div>
                                <span className="num text-right"><b className="text-fg">{Math.round(r.elo)}</b></span>
                                <span className="hidden md:flex items-center gap-2">
                                    <span className="num text-dim text-xs w-16 text-right" title={r.failed ? `${r.failed} of the ${r.losses} losses: ${r.bot} broke the game (error)` : undefined}>
                                        {r.wins}–{r.losses}{r.draws ? `–${r.draws}` : ''}{r.failed > 0 && <span className="text-p2"> ({r.failed}✕)</span>}
                                    </span>
                                    <span className="flex gap-0.5" aria-label="Recent form">
                                        {r.form.slice(-6).map((f, k) => <i key={k} className={`w-1.5 h-4 rounded-sm ${f === 'W' ? 'bg-good' : f === 'L' ? 'bg-p2/70' : 'bg-dim'}`} title={f} />)}
                                    </span>
                                </span>
                            </motion.div>
                        ))}
                    </div>
                </section>

                <section className="panel p-4 min-w-0" aria-labelledby="elo-h">
                    <h2 id="elo-h" className="eyebrow m-0 mb-3 flex items-center gap-2"><Activity size={13} />Elo race</h2>
                    <div className="h-56">
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={history.map((h, i) => ({ ...h, g: i }))} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                                <CartesianGrid vertical={false} strokeDasharray="2 4" />
                                <XAxis dataKey="g" tickLine={false} axisLine={false} />
                                <YAxis domain={['dataMin - 10', 'dataMax + 10']} tickLine={false} axisLine={false} width={48} />
                                <Tooltip contentStyle={{ background: '#0f1829ee', border: '1px solid #1d2a44', borderRadius: 10, fontSize: 12 }} labelFormatter={(l) => `after game ${l}`} />
                                {idx.bots.map((b) => <Line key={b} type="monotone" dataKey={b} stroke={color(b)} strokeWidth={2.2} dot={false} animationDuration={900} />)}
                            </LineChart>
                        </ResponsiveContainer>
                    </div>
                </section>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
                <section className="panel p-4 min-w-0" aria-labelledby="h2h-h">
                    <h2 id="h2h-h" className="eyebrow m-0 mb-3 flex items-center gap-2"><Swords size={13} />Head to head <span className="normal-case tracking-normal text-faint">row's win rate vs column</span></h2>
                    <div className="overflow-x-auto">
                        <table className="border-separate border-spacing-1 text-xs">
                            <thead>
                                <tr><th />{idx.bots.map((b) => <th key={b} className="font-normal text-dim px-1 max-w-[5rem] truncate" title={b}>{b}</th>)}</tr>
                            </thead>
                            <tbody>
                                {idx.bots.map((r) => (
                                    <tr key={r}>
                                        <th className="text-right font-normal pr-2 whitespace-nowrap" style={{ color: color(r) }}>{r}</th>
                                        {idx.bots.map((c) => {
                                            if (r === c) {
                                                return <td key={c} className="size-12 rounded-md bg-ink/60" />;
                                            }
                                            const { wins, n } = headToHead(idx.games, r, c);
                                            const rate = n ? wins / n : null;
                                            const bg = rate == null ? 'transparent' : `color-mix(in oklab, ${rate >= 0.5 ? '#4fe0a8' : '#ff5f6d'} ${Math.round(Math.abs(rate - 0.5) * 150 + 8)}%, #0b1220)`;
                                            return (
                                                <td key={c} className="size-12 rounded-md text-center num border border-line/50" style={{ background: bg }} title={`${r} vs ${c}: ${wins}/${n}`}>
                                                    {rate == null ? <span className="text-faint">–</span> : <><b className="text-fg">{Math.round(rate * 100)}</b><span className="block text-[10px] text-fg/70">{wins}/{n}</span></>}
                                                </td>
                                            );
                                        })}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
                <Matches idx={idx} color={color} />
            </div>
        </div>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div className="panel !rounded-xl px-3 py-2 min-w-[6.5rem]">
            <div className="eyebrow !text-[9px]">{label}</div>
            <div className="num text-lg text-fg">{value}</div>
        </div>
    );
}

function Matches({ idx, color }: { idx: TournamentIndex; color: (b: string) => string }) {
    const [bot, setBot] = useState<string | null>(null);
    const games = [...idx.games].reverse().filter((g) => !bot || g.p1 === bot || g.p2 === bot);
    return (
        <section className="panel p-4 min-w-0 flex flex-col" aria-labelledby="games-h">
            <div className="flex flex-wrap items-center gap-2 mb-3">
                <h2 id="games-h" className="eyebrow m-0 mr-auto">Games</h2>
                <button className="chip" aria-pressed={bot == null} style={bot == null ? { color: '#dce6fb', borderColor: '#dce6fb55' } : undefined} onClick={() => setBot(null)}>all</button>
                {idx.bots.map((b) => (
                    <button key={b} className="chip" aria-pressed={bot === b} onClick={() => setBot(bot === b ? null : b)}
                        style={bot === b ? { color: color(b), borderColor: color(b) } : undefined}>{b}</button>
                ))}
            </div>
            <ol className="flex flex-col gap-1 max-h-[420px] overflow-y-auto pr-1">
                {games.map((g) => <GameRow key={g.id} tid={idx.id} g={g} color={color} />)}
            </ol>
        </section>
    );
}

function GameRow({ tid, g, color }: { tid: string; g: IndexGame; color: (b: string) => string }) {
    const live = g.outcome === 'running';
    // a bot that broke the game (v2 `by`) loses it
    const by = failedSeat(g);
    const ws = by ? ratedSeat(g) : g.winnerSeat;
    const name = (b: string, seat: Seat) => {
        const t = g.timing?.[seat];
        return (
            <span className={`truncate ${ws && ws !== seat && !live ? 'opacity-45' : ''}`} style={{ color: color(b) }}>
                {ws === seat && <Trophy size={11} className="inline mr-1 text-gold -mt-0.5" />}{b}
                {t && t.n > 0 && <span className="num text-[10px] text-faint ml-1.5" title={`${timingText(b, t)} (timed by the referee)`}>{fmtMs(t.ms / t.n)}</span>}
            </span>
        );
    };
    return (
        <li>
            <a href={hrefGame(tid, g.id)} className="grid grid-cols-[minmax(0,1fr)_1.5rem_minmax(0,1fr)_5.5rem] items-center gap-2 px-3 py-2 rounded-lg hover:bg-raise transition-colors">
                {name(g.p1, 'p1')}
                <span className="text-faint text-xs font-display">vs</span>
                {name(g.p2, 'p2')}
                <span className="num text-xs text-dim text-right whitespace-nowrap">
                    {live ? <span className="text-p2 inline-flex items-center gap-1"><Radio size={11} className="animate-pulse" />live</span>
                        : by ? <span className="text-p2" title={`${g[by]} failed (error); ${g[by === 'p1' ? 'p2' : 'p1']} wins${g.error ? `\n${g.error}` : ''}`}>{by} failed</span>
                        : g.outcome !== 'won' ? <span className="text-gold">{g.outcome}</span>
                            : <>R{g.rounds} · {g.steps}</>}
                </span>
            </a>
        </li>
    );
}
