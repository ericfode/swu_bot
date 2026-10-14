import { useEffect, useState, type ReactNode } from 'react';
import { Command } from 'cmdk';
import { AnimatePresence, motion } from 'motion/react';
import { Command as CmdIcon, Gamepad2, Image, LayoutGrid, Search, Sparkles } from 'lucide-react';
import { dataSource } from '../data/source';
import type { TournamentIndex, TournamentSummary } from '../data/types';
import { hrefGame, hrefHome, hrefTournament, type Route } from '../lib/route';
import { useSettings } from '../lib/settings';

function Palette({ open, setOpen, route }: { open: boolean; setOpen: (v: boolean) => void; route: Route }) {
    const [ts, setTs] = useState<TournamentSummary[]>([]);
    const [idx, setIdx] = useState<TournamentIndex | null>(null);
    const { art, setArt, setPerspective } = useSettings();
    const tid = route.page === 'tournament' || route.page === 'game' ? route.tid : null;
    useEffect(() => {
        if (!open) {
            return;
        }
        dataSource().then(async (s) => {
            setTs(await s.listTournaments());
            setIdx(tid ? await s.loadIndex(tid) : null);
        }).catch(() => undefined);
    }, [open, tid]);
    const go = (href: string) => {
        window.location.hash = href;
        setOpen(false);
    };
    return (
        <AnimatePresence>
            {open && (
                <motion.div className="fixed inset-0 z-50 grid place-items-start justify-center pt-[12vh] bg-bg/70 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
                    <motion.div initial={{ y: -12, scale: 0.98 }} animate={{ y: 0, scale: 1 }} className="panel !bg-panel overflow-hidden shadow-2xl">
                        <Command label="Go to" loop>
                            <Command.Input autoFocus placeholder="Jump to a tournament, game or setting…" />
                            <Command.List>
                                <Command.Empty>Nothing matches.</Command.Empty>
                                {idx && (
                                    <Command.Group heading={`Games in ${idx.id}`}>
                                        {[...idx.games].reverse().map((g) => (
                                            <Command.Item key={g.id} value={`${g.id} ${g.p1} ${g.p2}`} onSelect={() => go(hrefGame(idx.id, g.id))}>
                                                <Gamepad2 size={14} /><span className="truncate">{g.p1} vs {g.p2}</span>
                                                <span className="ml-auto num text-xs text-faint">{g.outcome === 'running' ? 'live' : `${g.winner ?? g.outcome} · R${g.rounds}`}</span>
                                            </Command.Item>
                                        ))}
                                    </Command.Group>
                                )}
                                <Command.Group heading="Tournaments">
                                    {ts.map((t) => (
                                        <Command.Item key={t.id} value={`tournament ${t.id}`} onSelect={() => go(hrefTournament(t.id))}>
                                            <LayoutGrid size={14} />{t.id}<span className="ml-auto num text-xs text-faint">{t.games} games</span>
                                        </Command.Item>
                                    ))}
                                </Command.Group>
                                <Command.Group heading="Pages">
                                    <Command.Item value="card effects animations showcase" onSelect={() => go('#/effects')}><Sparkles size={14} />Card effects</Command.Item>
                                    <Command.Item value="action icons gallery" onSelect={() => go('#/icons')}><Gamepad2 size={14} />Action icon gallery</Command.Item>
                                </Command.Group>
                                <Command.Group heading="Settings">
                                    <Command.Item value="toggle card art" onSelect={() => { setArt(!art); setOpen(false); }}><Image size={14} />{art ? 'Hide' : 'Show'} card art</Command.Item>
                                    <Command.Item value="show both hands god view" onSelect={() => { setPerspective('god'); setOpen(false); }}>Show both hands</Command.Item>
                                    <Command.Item value="player 1 view hide hand" onSelect={() => { setPerspective('p1'); setOpen(false); }}>Player 1's view</Command.Item>
                                    <Command.Item value="player 2 view hide hand" onSelect={() => { setPerspective('p2'); setOpen(false); }}>Player 2's view</Command.Item>
                                </Command.Group>
                            </Command.List>
                        </Command>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
    const [open, setOpen] = useState(false);
    useEffect(() => {
        const on = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                setOpen((o) => !o);
            } else if (e.key === 'Escape') {
                setOpen(false);
            }
        };
        window.addEventListener('keydown', on);
        return () => window.removeEventListener('keydown', on);
    }, []);
    const crumbs: { label: string; href: string }[] = [{ label: 'Tournaments', href: hrefHome() }];
    if (route.page === 'icons') {
        crumbs.push({ label: 'Action icons', href: '#/icons' });
    } else if (route.page === 'effects') {
        crumbs.push({ label: 'Card effects', href: '#/effects' });
    } else if (route.page !== 'home') {
        crumbs.push({ label: route.tid, href: hrefTournament(route.tid) });
    }
    return (
        <div className="min-h-full flex flex-col">
            <nav className="sticky top-0 z-40 flex items-center gap-3 px-4 h-12 border-b border-line bg-bg/80 backdrop-blur-md" style={{ top: 'env(safe-area-inset-top, 0px)' }}>
                <a href={hrefHome()} className="flex items-center gap-2 font-display font-extrabold tracking-[0.18em] text-sm">
                    <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
                        <circle cx="12" cy="12" r="10" fill="none" stroke="#56c8ff" strokeWidth="1.6" />
                        <path d="M12 2v20M2 12h20" stroke="#ff5f6d" strokeWidth="1.2" opacity=".8" />
                        <circle cx="12" cy="12" r="3.2" fill="#f6c454" />
                    </svg>
                    HOLOTABLE
                </a>
                <ol className="hidden sm:flex items-center gap-2 text-sm text-dim min-w-0">
                    {crumbs.map((c) => <li key={c.href} className="truncate before:content-['/'] before:mr-2 before:text-faint"><a href={c.href} className="hover:text-fg">{c.label}</a></li>)}
                </ol>
                <a href="#/effects" className="btn ml-auto !h-8 text-dim" aria-label="Card effects" aria-current={route.page === 'effects' ? 'page' : undefined}><Sparkles size={14} /><span className="hidden sm:inline">Card effects</span></a>
                <button className="btn !h-8 text-dim" onClick={() => setOpen(true)} aria-label="Open command palette">
                    <Search size={14} /><span className="hidden sm:inline">Jump to…</span>
                    <kbd className="hidden sm:inline-flex items-center gap-0.5 text-[11px] text-faint num"><CmdIcon size={11} />K</kbd>
                </button>
            </nav>
            <main className="flex-1 min-w-0">{children}</main>
            <Palette open={open} setOpen={setOpen} route={route} />
        </div>
    );
}
