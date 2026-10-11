import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ASPECTS, aspectGradient, aspectsOf, monogram } from '../lib/cards';
import type { CardText } from '../lib/cardText';

/** One aspect as a coloured dot (the face's header, and [Aspect] costs inside rules text). */
export function AspectPip({ aspect, size = '0.9em' }: { aspect: string; size?: string }) {
    const a = ASPECTS[aspect.toLowerCase()];
    if (!a) {
        return null;
    }
    return (
        <span role="img" aria-label={a.label} title={a.label} className="inline-block rounded-full shrink-0"
            style={{ width: size, height: size, background: a.pip, boxShadow: 'inset 0 0 0 1px #ffffff5c, 0 1px 2px #0008', verticalAlign: '-0.1em' }} />
    );
}

const KEYWORDS = ['ambush', 'bounty', 'coordinate', 'exploit', 'fortify', 'grit', 'hidden', 'overwhelm', 'piloting', 'plot', 'raid', 'restore', 'saboteur', 'sentinel', 'shielded', 'smuggle', 'support'];
const title = (w: string) => w.replace(/\b\w/g, (c) => c.toUpperCase());

/** A cost or condition in brackets, "[1 resource, Exhaust]" or "[Villainy]": a small inline box, aspects as pips. */
function Bracket({ inner }: { inner: string }) {
    const parts = inner.split(/(\b(?:vigilance|command|aggression|cunning|heroism|villainy)\b)/i);
    return (
        <span className="rounded-[0.3em] px-[0.25em] bg-white/[0.08] ring-1 ring-white/10 [box-decoration-break:clone]">
            {parts.map((p, i) => (i % 2 ? <AspectPip key={i} aspect={p} size="0.8em" /> : p))}
        </span>
    );
}

/** One paragraph of rules text: the trigger ("On Attack:", "Action [Exhaust]:") or keyword in bold, reminder text dim. */
function Para({ text }: { text: string }) {
    let lead: string | null = null;
    let rest = text;
    const trig = text.match(/^((?:[A-Z][\w'’-]*(?:[ /][A-Z][\w'’-]*)*)(?: \[[^\]]*\])?:)\s*/);
    const kw = text.match(new RegExp(`^((?:${KEYWORDS.join('|')})(?: \\d+)?)(?=$|[\\s(—,.])`, 'i'));
    if (trig) {
        lead = trig[1];
        rest = text.slice(trig[0].length);
    } else if (kw) {
        lead = kw[1];
        rest = text.slice(kw[0].length);
    }
    const inline = (s: string, key: string): ReactNode[] => s.split(/(\[[^\]]*\]|\([^)]*\))/).map((p, i) => (
        !p ? null
            : p.startsWith('[') ? <Bracket key={`${key}${i}`} inner={p.slice(1, -1)} />
                : p.startsWith('(') ? <span key={`${key}${i}`} className="italic text-dim">({inline(p.slice(1, -1), `${key}${i}.`)})</span>
                    : p
    ));
    return (
        <p className="m-0">
            {lead && <b className="font-semibold text-white">{lead.includes('[') ? inline(lead, 'l') : lead}{trig ? ' ' : ''}</b>}
            {inline(rest, 'r')}
        </p>
    );
}

function Rules({ text }: { text: string }) {
    return <>{text.trim().split(/\n+/).filter(Boolean).map((p, i) => <Para key={i} text={p.trim()} />)}</>;
}

function Stat({ v, kind, plus = false }: { v: number; kind: 'pw' | 'hp'; plus?: boolean }) {
    return (
        <span className="inline-grid place-items-center rounded-[0.35em] px-[0.35em] min-w-[1.75em] h-[1.75em] font-display font-bold text-white text-[1.15em] shadow-[0_2px_6px_#0009]"
            style={{ background: kind === 'pw' ? '#c2333f' : '#2a6fd6' }} title={kind === 'pw' ? (plus ? 'Power bonus' : 'Power') : (plus ? 'HP bonus' : 'HP')}>
            {plus && v >= 0 ? '+' : ''}{v}
        </span>
    );
}

const MAX_K = 0.056;
const MIN_K = 0.034;

/**
 * A readable card drawn from its printed data, for a card with no image (art off, missing from the pack, a CDN failure,
 * an unreleased set): name, cost, aspects, types and traits, rules text, a leader's epic action and deployed side, and
 * printed stats. Fills the card box it is drawn in (its --w sets the type size), framed in the card's aspect colours.
 */
export function CardTextFace({ text, back = false, shape = 'tall' }: { text: CardText; back?: boolean; shape?: 'tall' | 'wide' }) {
    const ty = text.ty ?? [];
    const leader = ty.includes('leader');
    const token = ty.includes('token');
    const base = ty.includes('base');
    const upgrade = ty.includes('upgrade') && !ty.includes('unit');
    const unitSide = ty.includes('unit') || (leader && back);
    const aspects = aspectsOf(text.as);
    // what the box holds: a leader's front is its leader text and epic action, with the deployed side summarised under them
    const main = leader && back ? text.db ?? '' : text.tx ?? '';
    const shown = leader && !back ? `${main}${text.ea ?? ''}${text.db ?? ''}` : main;
    const missingKw = (text.kw ?? []).filter((kw) => !shown.toLowerCase().includes(kw.toLowerCase()));
    const typeLabel = leader ? (back ? 'Leader unit' : 'Leader') : token ? `Token ${ty.find((t) => t !== 'token') ?? ''}`.trim() : title(ty[0] ?? 'card');
    const typeLine = [typeLabel, unitSide && text.ar ? title(text.ar) : null].filter(Boolean).join(' · ');
    const traits = (text.tr ?? []).map(title).join(' · ');
    const cost = !leader && !base && !token ? text.c : undefined;
    // type size: as large as fits (the picture area gives up its room first), stepping down until the rules text needs
    // no scrolling; everything is in em of the card's --w, so the fit holds at any card width
    const [k, setK] = useState(MAX_K);
    const box = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => setK(MAX_K), [text, back]);
    useLayoutEffect(() => {
        const el = box.current;
        if (el && el.scrollHeight > el.clientHeight + 1 && k > MIN_K) {
            setK((v) => Math.max(MIN_K, v - 0.002));
        }
    }, [k, text, back]);
    const fs = `clamp(8px, calc(var(--w) * ${(shape === 'wide' ? k * 0.74 : k).toFixed(4)}), 14px)`;
    const grad = aspectGradient(text.as);
    const stats = unitSide && text.p != null && text.h != null;
    const pilot = !upgrade && (text.up != null || text.uh != null) && (ty.includes('unit') || (leader && back));
    return (
        <div className="absolute inset-0 p-[0.38em] text-left" style={{ fontSize: fs, background: `radial-gradient(circle at 30% 0%, #ffffff26, transparent 60%), ${grad}` } as CSSProperties}>
            <div className="h-full flex flex-col gap-[0.35em] rounded-[0.6em] overflow-hidden text-fg leading-[1.32] px-[0.6em] pt-[0.5em] pb-[0.5em]"
                style={{ background: 'linear-gradient(180deg, #0e1627f2, #090e19f7)', boxShadow: 'inset 0 0 0 1px #ffffff14' }}>
                <div className="flex items-start gap-[0.5em]">
                    {cost != null && (
                        <span className="grid place-items-center shrink-0 size-[1.9em] rounded-[0.45em] font-display font-extrabold text-[1.15em] text-white bg-[#22314f] shadow-[inset_0_0_0_1px_#ffffff33]" title="Cost">{cost}</span>
                    )}
                    <div className="min-w-0 flex-1">
                        <div className="font-display font-bold text-[1.22em] leading-[1.15] text-white">
                            {text.u ? <span className="text-[0.7em] align-[0.15em] mr-[0.3em] text-dim" title="Unique">◆</span> : null}{text.t}
                        </div>
                        {text.st && <div className="italic text-dim text-[0.92em] leading-tight truncate">{text.st}</div>}
                    </div>
                    {aspects.length > 0 && <span className="flex gap-[0.2em] shrink-0 pt-[0.2em]">{aspects.map((a) => <AspectPip key={a} aspect={a} size="1.05em" />)}</span>}
                </div>
                <div className="text-[0.74em] uppercase tracking-[0.08em] leading-tight border-y border-white/10 py-[0.3em]">
                    <span className="font-semibold text-fg">{typeLine}</span>
                    {traits && <span className="text-dim"> · {traits}</span>}
                </div>
                {missingKw.length > 0 && (
                    <div className="flex flex-wrap gap-[0.3em]">
                        {missingKw.map((kw) => <span key={kw} className="text-[0.8em] font-semibold rounded-[0.3em] px-[0.4em] bg-white/10 text-white">{title(kw)}</span>)}
                    </div>
                )}
                {/* where the art would be: the aspect colours and the monogram, giving its room up to the text when the text is long */}
                <div className="flex-[1_1_0] min-h-0 rounded-[0.45em] grid place-items-center overflow-hidden" aria-hidden="true"
                    style={{ background: `radial-gradient(circle at 30% 20%, #ffffff22, transparent 55%), ${grad}`, boxShadow: 'inset 0 0 0 1px #ffffff1a' }}>
                    <span className="font-display font-extrabold leading-none text-white/80" style={{ fontSize: 'calc(var(--w) * 0.2)', textShadow: '0 2px 10px #0008' }}>{monogram(text.t)}</span>
                </div>
                <div ref={box} className="flex-[0_1_auto] min-h-0 overflow-y-auto flex flex-col gap-[0.4em] p-px [scrollbar-width:thin]">
                    {main ? <Rules text={main} /> : !leader && <p className="m-0 text-faint italic">No rules text.</p>}
                    {leader && !back && text.ea && (
                        <div className="rounded-[0.4em] bg-white/[0.06] ring-1 ring-white/10 px-[0.5em] py-[0.3em]"><Rules text={text.ea} /></div>
                    )}
                    {leader && !back && (text.db || text.p != null) && (
                        <div className="rounded-[0.4em] ring-1 ring-white/10 px-[0.5em] py-[0.3em] text-dim">
                            <div className="text-[0.74em] uppercase tracking-[0.08em] text-fg font-semibold mb-[0.15em]">
                                Deployed{text.p != null && text.h != null ? <> · <span className="text-[#ff8a94]">{text.p}</span>/<span className="text-[#7fb0ff]">{text.h}</span></> : null}{text.ar ? ` · ${title(text.ar)}` : ''}
                            </div>
                            {text.db && <Rules text={text.db} />}
                        </div>
                    )}
                </div>
                {(stats || (upgrade && (text.up != null || text.uh != null)) || (base && text.h != null)) && (
                    <div className="flex items-center gap-[0.4em] shrink-0">
                        {stats && <Stat v={text.p!} kind="pw" />}
                        {upgrade && text.up != null && <Stat v={text.up} kind="pw" plus />}
                        <span className="flex-1 text-center text-[0.8em] text-dim truncate">
                            {pilot ? `as a pilot +${text.up ?? 0}/+${text.uh ?? 0}` : upgrade ? 'to the attached unit' : ''}
                        </span>
                        {stats && <Stat v={text.h!} kind="hp" />}
                        {upgrade && text.uh != null && <Stat v={text.uh} kind="hp" plus />}
                        {base && text.h != null && <Stat v={text.h} kind="hp" />}
                    </div>
                )}
            </div>
        </div>
    );
}
