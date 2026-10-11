import { useMemo, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { atlasKit, groupColor, iconVars, type AtlasKitApi, type SpotGroup, type SpotTimeline } from '../data/atlas';
import type { Seat } from '../data/types';

const GROUPS: SpotGroup[] = ['Behind', 'Even', 'Ahead'];

/** The kit's icon text classes (bd-*), once per strip; its colour tokens go on the element as custom properties. */
function IconCss({ kit }: { kit: AtlasKitApi }) {
    const css = useMemo(() => kit.css({ base: false, scope: '.atlas-icons' }), [kit]);
    return <style>{css}</style>;
}

function spotTitle(kit: AtlasKitApi, id: string, bot: string): string {
    const s = kit.SPOT[id];
    return `${s.label} (${kit.GROUP[s.group] ?? s.group}) for ${bot}\n${s.say}\nRule: ${s.rule}, read from ${bot}'s side. The Strategy Atlas checks it at the start of each round.`;
}

/**
 * The Atlas spots that hold for one seat right now, as chips by its base: the spot's icon and name, coloured by group
 * (When behind, Close or long, When ahead). A new spot fades in. Nothing is drawn without the Atlas kit or a spot.
 */
export function SpotChips({ ids, bot }: { ids: string[]; bot: string }) {
    const kit = atlasKit();
    const vars = useMemo(() => (kit ? (iconVars(kit) as CSSProperties) : undefined), [kit]);
    if (!kit) {
        return null;
    }
    return (
        <div className="atlas-icons spot-chips" style={vars} role="list" aria-label={`Atlas spots for ${bot}`}>
            <IconCss kit={kit} />
            <AnimatePresence initial={false} mode="popLayout">
                {ids.filter((id) => kit.SPOT[id]).map((id) => {
                    const s = kit.SPOT[id];
                    return (
                        <motion.span key={id} layout role="listitem" className="spot-chip" style={{ '--g': groupColor(kit, s.group) } as CSSProperties} title={spotTitle(kit, id, bot)}
                            initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={{ duration: 0.25 }}>
                            <span className="spot-ico" dangerouslySetInnerHTML={{ __html: kit.spotSvg(id, { mini: true, label: false, cls: 'spot-svg' }) }} />
                            {s.label}
                        </motion.span>
                    );
                })}
            </AnimatePresence>
        </div>
    );
}

/**
 * One thin lane per seat under the timeline: bars where each group of spots holds (When behind on top, When ahead at
 * the bottom), and a mark at each round start where a spot begins, the snapshots the Atlas reads. A ringed mark is where
 * the Atlas counts this game in that spot (its first round start there). A mark seeks to its step.
 */
export function SpotLanes({ tl, last, inset, step, bots, onSeek, stepN }: {
    tl: SpotTimeline; last: number; inset: number; step: number; bots: Record<Seat, string>; onSeek: (i: number) => void; stepN: (i: number) => number;
}) {
    const kit = atlasKit();
    const bars = useMemo(() => {
        if (!kit) {
            return [];
        }
        // one bar per seat, group and run where any spot of the group holds
        const out: { seat: Seat; group: SpotGroup; from: number; to: number }[] = [];
        for (const seat of ['p1', 'p2'] as Seat[]) {
            for (const group of GROUPS) {
                let run: { seat: Seat; group: SpotGroup; from: number; to: number } | null = null;
                for (let i = 0; i < tl.at.length; i++) {
                    if (!tl.at[i][seat].some((id) => kit.SPOT[id]?.group === group)) {
                        continue;
                    }
                    if (run && run.to === i - 1) {
                        run.to = i;
                    } else {
                        run = { seat, group, from: i, to: i };
                        out.push(run);
                    }
                }
            }
        }
        return out;
    }, [kit, tl]);
    if (!kit) {
        return null;
    }
    const pct = (i: number) => `${(i / last) * 100}%`;
    const lane = (seat: Seat) => (
        <div key={seat} className="spot-lane" style={{ '--seat': `var(--color-${seat})` } as CSSProperties} aria-label={`Atlas spots for ${bots[seat]}`}>
            {bars.filter((b) => b.seat === seat).map((b) => (
                <span key={`${b.group}${b.from}`} className="spot-bar" title={`${kit.GROUP[b.group]} for ${bots[seat]}: steps ${stepN(b.from)}-${stepN(b.to)}`}
                    style={{ left: pct(b.from), width: `max(2px, ${((b.to + 1 - b.from) / last) * 100}%)`, top: 2 + GROUPS.indexOf(b.group) * 7, background: groupColor(kit, b.group) }} />
            ))}
            {tl.starts.filter((s) => s.seat === seat && kit.SPOT[s.id]).map((s) => {
                const sp = kit.SPOT[s.id];
                const where = s.atlas ? `The Atlas counts this game in ${sp.label} for ${bots[seat]} from here.` : `${sp.label} again for ${bots[seat]}; the Atlas already counted this game there.`;
                return (
                    <button key={`${s.id}${s.i}`} className={`spot-mark${s.atlas ? ' counted' : ''}${s.i <= step ? '' : ' ahead'}`} onClick={() => onSeek(s.i)}
                        style={{ left: pct(s.i), top: 3 + GROUPS.indexOf(sp.group) * 7, '--g': groupColor(kit, sp.group) } as CSSProperties}
                        title={`${sp.label} · round ${s.round} start · step ${stepN(s.i)}\n${sp.say}\n${where}`} aria-label={`${bots[seat]}: ${sp.label} from round ${s.round}, step ${stepN(s.i)}`} />
                );
            })}
        </div>
    );
    return (
        <div className="mt-1 flex flex-col gap-1" style={{ marginRight: inset }} aria-label="Atlas spots">
            {lane('p1')}
            {lane('p2')}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pt-0.5 text-[11px] text-dim">
                <span className="text-faint">Atlas spots, top lane {bots.p1}, bottom {bots.p2}; rows from the top:</span>
                {GROUPS.map((g) => (
                    <span key={g} className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-[3px] rounded-full" style={{ background: groupColor(kit, g) }} />{kit.GROUP[g]}</span>
                ))}
                <span className="inline-flex items-center gap-1.5"><span className="spot-mark counted" style={{ position: 'static', margin: '0 3px', '--g': 'var(--color-dim)' } as CSSProperties} aria-hidden="true" />where the Atlas counts the game (a round start)</span>
            </div>
        </div>
    );
}
