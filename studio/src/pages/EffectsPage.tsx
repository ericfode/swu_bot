import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronLeft, ChevronRight, Image, Pause, Play, RotateCcw, Search, Shapes, Sparkles } from 'lucide-react';
import { GameViewer } from '../kit/GameViewer';
import { EffectSoundControls } from '../components/EffectSoundControls';
import { CARD_EFFECTS } from '../effects/catalogue';
import { ABILITY_LANGUAGE, cardAbilities, showcaseAbilities, showcaseLabel, type AbilityKind } from '../effects/abilities';
import type { CardEffectDefinition } from '../effects/types';
import { showcaseGame } from '../effects/showcase';
import { hasNextActionExample, hasRegroupExample, hasPhaseEndExample, phaseEndExampleLabelFor, previewExampleStages, nextActionExampleLabelFor, nextActionButtonLabel, regroupExampleLabel } from '../effects/previewStages';
import { cardImageUrl, monogram } from '../lib/cards';
import { createSettingsStore, releaseSettingsStore, SettingsProvider, useSettings } from '../lib/settings';
import '../effects/showcase.css';

type Family = CardEffectDefinition['family'];
const FAMILIES: { id: Family | 'all'; label: string }[] = [
    { id: 'all', label: 'All cards' },
    { id: 'damage', label: 'Damage' },
    { id: 'force', label: 'The Force' },
    { id: 'tactics', label: 'Tactics' },
    { id: 'support', label: 'Support' }
];
const familyLabel = (id: Family) => FAMILIES.find((f) => f.id === id)!.label;
const effectStyle = (color: string) => ({ '--effect-accent': color }) as CSSProperties;

function CardArt({ card, hero = false }: { card: CardEffectDefinition; hero?: boolean }) {
    const artVersion = useSettings((s) => s.artVersion);
    const url = useMemo(() => cardImageUrl(card.setCode), [card.setCode, artVersion]);
    const [failed, setFailed] = useState(false);
    useEffect(() => setFailed(false), [url]);
    return (
        <span className={`effect-card-art${hero ? ' hero' : ''}`} style={effectStyle(card.color)} aria-hidden="true">
            {url && !failed ? <img src={url} alt="" loading={hero ? 'eager' : 'lazy'} onError={() => setFailed(true)} /> : <span>{monogram(card.name)}</span>}
        </span>
    );
}

function EffectsShowcase() {
    const [initial] = useState(() => new URLSearchParams(window.location.hash.split('?')[1] ?? ''));
    const [selectedIndex, setSelectedIndex] = useState(() => Math.max(0, CARD_EFFECTS.findIndex((c) => c.id === initial.get('card'))));
    const [progress, setProgress] = useState<number | undefined>(() => {
        const value = initial.get('progress');
        return value !== null && Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value) / 100)) : undefined;
    });
    const [nonce, setNonce] = useState(0);
    const [boundary, setBoundary] = useState<'play' | 'regroup-start' | 'next-action' | 'phase-end'>(() => {
        const value = initial.get('stage');
        return value === 'regroup-start' || value === 'next-action' || value === 'phase-end' ? value : 'play';
    });
    const [playing, setPlaying] = useState(false);
    const [finished, setFinished] = useState(false);
    const [family, setFamily] = useState<Family | 'all'>('all');
    const [ability, setAbility] = useState<AbilityKind | 'all'>('all');
    const [query, setQuery] = useState('');
    const cardList = useRef<HTMLDivElement>(null);
    const activeCard = useRef<HTMLButtonElement>(null);
    const { art, setArt } = useSettings();
    const selected = CARD_EFFECTS[selectedIndex];
    const game = useMemo(() => showcaseGame(selected), [selected]);
    const stage = boundary === 'regroup-start' && hasRegroupExample(selected.id) ? 'regroup-start' as const
        : boundary === 'phase-end' && hasPhaseEndExample(selected.id) ? 'phase-end' as const
        : boundary === 'next-action' && hasNextActionExample(selected.id) ? 'next-action' as const : undefined;
    const preview = useMemo(() => ({ definition: selected, nonce, seat: 'p1' as const, progress, stage }), [selected, nonce, progress, stage]);
    const selectedAbilities = new Set(showcaseAbilities(selected.id).map((beat) => beat.kind));
    const filtered = CARD_EFFECTS.filter((c) => (family === 'all' || c.family === family)
        && (ability === 'all' || cardAbilities(c.id).some((beat) => beat.kind === ability))
        && `${c.name} ${c.description}`.toLowerCase().includes(query.toLowerCase().trim()));

    useEffect(() => {
        const list = cardList.current;
        const active = activeCard.current;
        if (!list || !active || list.scrollHeight <= list.clientHeight) {
            return;
        }
        const top = active.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
        if (top < list.scrollTop || top + active.clientHeight > list.scrollTop + list.clientHeight) {
            list.scrollTop = Math.max(0, top - list.clientHeight / 2 + active.clientHeight / 2);
        }
    }, [selectedIndex]);

    useEffect(() => {
        if (!playing) {
            return;
        }
        const timer = window.setTimeout(() => {
            if (selectedIndex === CARD_EFFECTS.length - 1) {
                setPlaying(false);
                setFinished(true);
            } else {
                setSelectedIndex((i) => i + 1);
                setNonce((n) => n + 1);
            }
        }, Math.max(4200, selected.durationMs + 700));
        return () => window.clearTimeout(timer);
    }, [playing, selectedIndex, selected.durationMs, nonce]);

    function choose(index: number, replay = false) {
        setPlaying(false);
        setProgress(undefined);
        setFinished(false);
        setSelectedIndex(index);
        if (!replay) setBoundary('play');
        setNonce((n) => n + 1);
    }
    function playAll() {
        setFamily('all');
        setAbility('all');
        setProgress(undefined);
        setQuery('');
        setSelectedIndex(0);
        setBoundary('play');
        setNonce((n) => n + 1);
        setFinished(false);
        setPlaying(true);
    }
    function scrub(value: number) {
        setPlaying(false);
        setProgress(value);
    }

    return (
        <div className="effects-page" style={effectStyle(selected.color)}>
            <header className="effects-heading">
                <div>
                    <div className="effects-kicker"><Sparkles size={13} />Holotable / Card effects</div>
                    <h1>Feel the impact. Read the play.</h1>
                    <p>{CARD_EFFECTS.length} signature animations, one shared language for what happens next.</p>
                </div>
                <div className="effects-count"><strong>{CARD_EFFECTS.length}</strong><span>cards brought<br />to life</span></div>
            </header>

            <div className="effects-workspace">
                <section className="effects-theatre" aria-label="Animation showcase">
                    <div className="effects-stage-label"><span className="effects-live-dot" />Animation showcase <span aria-hidden="true">·</span> Staged board</div>
                    <div className="effects-feature" aria-live="polite">
                        <CardArt key={selected.id} card={selected} hero />
                        <div className="effects-feature-copy">
                            <div className="effects-feature-meta"><span>{familyLabel(selected.family)}</span><span>{selected.setCode.replace('_', ' · ')}</span></div>
                            <h2>{selected.name}</h2>
                            <p>{selected.description}</p>
                            <div className="effects-ability-chips" aria-label="Abilities in this example">
                                {ABILITY_LANGUAGE.filter((a) => selectedAbilities.has(a.id)).map((a) => <span key={a.id} style={{ color: a.color }} title={a.visualRule}>{a.glyph} {a.label}</span>)}
                            </div>
                        </div>
                        <span className="effects-position num">{String(selectedIndex + 1).padStart(2, '0')}<span> / {CARD_EFFECTS.length}</span></span>
                    </div>
                    <div className="effects-example">{stage === 'next-action' ? nextActionExampleLabelFor(selected.id) : stage === 'phase-end' ? phaseEndExampleLabelFor(selected.id) : stage ? regroupExampleLabel(selected.id) : showcaseLabel(selected.id)}</div>
                    {(hasRegroupExample(selected.id) || hasNextActionExample(selected.id) || hasPhaseEndExample(selected.id)) && <div className="effects-boundary" role="group" aria-label="Example timing">
                        <span>Show:</span>{previewExampleStages(selected.id).map(value => <button key={value} className="btn" aria-pressed={boundary === value} onClick={() => {
                            setBoundary(value); setPlaying(false); setProgress(undefined); setNonce(n => n + 1);
                        }}>{value === 'play' ? 'Play the event' : value === 'next-action' ? nextActionButtonLabel(selected.id) : value === 'phase-end' ? 'Action phase ends' : 'Regroup begins'}</button>)}
                    </div>}
                    <div className="effects-board"><GameViewer game={game} layout="compact" keyboard="focus" spots={false} effectPreview={preview} /></div>
                    <div className="effects-transport">
                        <div className="effects-transport-primary">
                            <button className="btn effects-replay" onClick={() => choose(selectedIndex, true)}><RotateCcw size={15} />Replay effect</button>
                            <button className="btn effects-play" onClick={() => playing ? setPlaying(false) : playAll()} aria-pressed={playing}>
                                {playing ? <><Pause size={15} />Pause</> : <><Play size={15} />Play all {CARD_EFFECTS.length}</>}
                            </button>
                            <EffectSoundControls onEnabled={() => choose(selectedIndex, true)} />
                        </div>
                        <div className="effects-transport-secondary">
                            <button className="btn" aria-label="Previous card effect" disabled={selectedIndex === 0} onClick={() => choose(selectedIndex - 1)}><ChevronLeft size={17} /></button>
                            <button className="btn" aria-label="Next card effect" disabled={selectedIndex === CARD_EFFECTS.length - 1} onClick={() => choose(selectedIndex + 1)}><ChevronRight size={17} /></button>
                            <span className="effects-divider" />
                            <button className="btn" aria-label={art ? 'Use vector cards' : 'Use card art'} aria-pressed={art} onClick={() => setArt(!art)}>{art ? <Image size={15} /> : <Shapes size={15} />}<span>{art ? 'Card art' : 'Vector cards'}</span></button>
                        </div>
                    </div>
                    <div className="effects-scrubber">
                        <label><span>Inspect a frame</span><input aria-label="Animation progress" type="range" min="0" max="100" step="1" value={Math.round((progress ?? 0) * 100)} onChange={(e) => scrub(Number(e.target.value) / 100)} /><output>{progress === undefined ? 'Auto' : `${Math.round(progress * 100)}%`}</output></label>
                        <div>{[['Anticipation', .18], ['Impact', .46], ['Outcome', .72], ['Settle', .9], ['Final board', 1]].map(([label, value]) => <button key={label} aria-pressed={progress === value} onClick={() => scrub(Number(value))}>{label}</button>)}</div>
                    </div>
                    <div className="effects-stage-note"><span>{playing ? `Playing ${selectedIndex + 1} of ${CARD_EFFECTS.length}` : finished ? 'Collection complete. Choose any card to see it again.' : 'Select a card to preview its animation.'}</span><span>Also plays on matching cards in game replays.</span></div>
                </section>

                <aside className="effects-library" aria-label="Card effect library">
                    <div className="effects-library-heading"><h2>The collection</h2><span className="num">{filtered.length} / {CARD_EFFECTS.length}</span></div>
                    <label className="effects-search"><Search size={15} /><input type="search" placeholder="Find a card…" aria-label="Search card effects" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
                    <div className="effects-filters" role="group" aria-label="Filter card effects">
                        {FAMILIES.map((f) => <button key={f.id} aria-pressed={family === f.id} onClick={() => setFamily(f.id)}>{f.label}</button>)}
                    </div>
                    <label className="effects-ability-filter">Ability<select aria-label="Filter by ability" value={ability} onChange={(e) => setAbility(e.target.value as AbilityKind | 'all')}><option value="all">All abilities</option>{ABILITY_LANGUAGE.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label>
                    <div className="effects-card-list" ref={cardList}>
                        {filtered.map((card) => {
                            const i = CARD_EFFECTS.indexOf(card);
                            const active = i === selectedIndex;
                            return (
                                <button key={card.id} ref={active ? activeCard : undefined} className={`effects-card-pick${active ? ' active' : ''}`} style={effectStyle(card.color)} aria-pressed={active} onClick={() => choose(i)}>
                                    <CardArt card={card} />
                                    <span className="effects-card-copy"><strong>{card.name}</strong><span>{familyLabel(card.family)}</span></span>
                                    <span className="effects-card-number num">{active ? <Play size={13} fill="currentColor" /> : String(i + 1).padStart(2, '0')}</span>
                                </button>
                            );
                        })}
                        {filtered.length === 0 && <p className="effects-empty">No cards match. Try a different name or category.</p>}
                    </div>
                </aside>
            </div>
            <section className="effects-language" aria-label="Shared ability language">
                <h2>Same action. Same visual cue.</h2>
                <p>Each card adds its own entrance and character. These colors, shapes, and movements keep the outcome readable across the collection.</p>
                <div>{ABILITY_LANGUAGE.map((a) => <button key={a.id} onClick={() => { setFamily('all'); setAbility(a.id); }} style={{ '--ability-color': a.color } as CSSProperties}><span className="effects-language-glyph">{a.glyph}</span><span><strong>{a.label}</strong><span>{a.visualRule}</span></span></button>)}</div>
            </section>
        </div>
    );
}

export function EffectsPage() {
    const [settings] = useState(() => createSettingsStore(null, { art: true, lens: false, perspective: 'god' }));
    useEffect(() => () => releaseSettingsStore(settings), [settings]);
    return <SettingsProvider store={settings}><EffectsShowcase /></SettingsProvider>;
}
