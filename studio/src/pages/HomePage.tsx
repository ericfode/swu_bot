import { motion } from 'motion/react';
import { ArrowRight } from 'lucide-react';
import { useTournaments } from '../data/hooks';
import { botColor } from '../lib/cards';
import { hrefTournament } from '../lib/route';

export function HomePage() {
    const { data, error } = useTournaments();
    return (
        <div className="p-4 md:p-8 flex flex-col gap-6 max-w-[1100px]">
            <header>
                <div className="eyebrow">Star Wars: Unlimited · bot lab</div>
                <h1 className="text-4xl md:text-5xl font-extrabold m-0 mt-2">Tournaments</h1>
                <p className="text-dim max-w-[60ch] mt-2 mb-0">Every recorded bot tournament in <span className="num">replays/</span>. Open one for standings, the Elo race and head-to-heads, then any game for a full replay.</p>
            </header>
            {error && !data && <div className="text-p2">Couldn't list tournaments: {error}</div>}
            {data && data.length === 0 && <div className="panel p-6 text-dim">No tournaments yet. Run <code className="num text-fg">npm run demo</code> in the repo root to record one.</div>}
            <div className="grid gap-3 sm:grid-cols-2">
                {data?.map((t, i) => (
                    <motion.a key={t.id} href={hrefTournament(t.id)} className="panel p-5 group flex flex-col gap-3 hover:border-p1/50 transition-colors"
                        initial={{ opacity: 0.4, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
                        <div className="flex items-start gap-2">
                            <div className="min-w-0">
                                <h2 className="m-0 text-xl font-bold break-all">{t.id}</h2>
                                <div className="text-faint text-xs mt-1">{new Date(t.createdAt).toLocaleString()}</div>
                            </div>
                            <ArrowRight size={18} className="ml-auto text-faint group-hover:text-fg group-hover:translate-x-1 transition" />
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            {t.bots.map((b) => <span key={b} className="chip" style={{ color: botColor(t.bots, b) }}>{b}</span>)}
                        </div>
                        <div className="num text-sm text-dim">{t.games} games · engine {t.engine ?? 'unknown'}</div>
                    </motion.a>
                ))}
            </div>
        </div>
    );
}
