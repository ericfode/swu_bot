import { CardBack, CardView } from './CardView';
import type { Focus } from './CardView';
import { useSettings } from './settings';
import type { PlayerSnap, Seat, Snapshot, UnitRef } from './types';

interface SideProps {
    seat: Seat;
    p: PlayerSnap;
    botName: string;
    active: boolean;
    hasInitiative: boolean;
    onFocus: (f: Focus | null) => void;
}

function Arena({ label, units, leaderS, onFocus }: { label: string; units: UnitRef[]; leaderS: string | null; onFocus: (f: Focus | null) => void }) {
    return (
        <div className="arena">
            <div className="arena-l">{label}</div>
            <div className="units">
                {units.length === 0 && <span className="muted">empty</span>}
                {units.map((u, i) => <CardView key={`${u.n}-${i}`} card={u} kind="unit" back={leaderS !== null && u.s === leaderS} unit={u} exhausted={!!u.x} onFocus={onFocus} />)}
            </div>
        </div>
    );
}

function Side({ seat, p, botName, active, hasInitiative, onFocus }: SideProps) {
    const { godView } = useSettings();
    const hpLeft = Math.max(0, p.base.hp - p.base.d);
    const low = hpLeft <= p.base.hp * 0.35;
    const leaderIsUnit = !!p.leader && p.leader.dep === 1;
    const leaderS = leaderIsUnit ? p.leader!.s : null;
    return (
        <section className={`side ${seat}${active ? ' active' : ''}`} aria-label={`${seat} board`}>
            <header className="side-head">
                <strong className={`${seat}c`}>{seat === 'p1' ? 'Player 1' : 'Player 2'}</strong>
                <span className="bot">{botName}</span>
                {hasInitiative && <span className="chip init">initiative</span>}
                {active && <span className="chip act">to act</span>}
            </header>
            <div className="hq">
                <CardView card={p.base} kind="base" onFocus={onFocus} />
                {p.leader && !leaderIsUnit && <CardView card={p.leader} kind="leader" exhausted={!!p.leader.x} onFocus={onFocus} />}
                {leaderIsUnit && p.leader && <div className="deployed-note">{p.leader.n} is deployed</div>}
                <div className="hq-stats">
                    <div className="hp-line"><span>Base</span><b>{hpLeft}</b><span className="muted">/ {p.base.hp}</span></div>
                    <div className={`hp-bar${low ? ' low' : ''}`}><i style={{ width: `${(hpLeft / p.base.hp) * 100}%` }} /></div>
                    <div className="pips" aria-label={`${p.res.ready} of ${p.res.total} resources ready`}>
                        {Array.from({ length: p.res.total }, (_, i) => <i key={i} className={i < p.res.ready ? 'ready' : 'spent'} />)}
                        <span className="muted">{p.res.ready}/{p.res.total}</span>
                    </div>
                    <div className="muted counts">hand {p.hand.length} · deck {p.deck} · discard {p.discard.length}</div>
                </div>
            </div>
            <Arena label="space" units={p.space} leaderS={leaderS} onFocus={onFocus} />
            <Arena label="ground" units={p.ground} leaderS={leaderS} onFocus={onFocus} />
            <div className="hand-row" aria-label="hand">
                {godView
                    ? p.hand.map((c, i) => <CardView key={`${c.n}-${i}`} card={c} kind="hand" onFocus={onFocus} />)
                    : p.hand.map((_, i) => <CardBack key={i} count={i + 1} label="hidden card" />)}
                {p.hand.length === 0 && <span className="muted">no cards in hand</span>}
            </div>
        </section>
    );
}

export function Board({ state, bots, actor, onFocus }: { state: Snapshot; bots: Record<Seat, string>; actor: Seat | null; onFocus: (f: Focus | null) => void }) {
    return (
        <div className="board">
            <Side seat="p2" p={state.players.p2} botName={bots.p2} active={actor === 'p2'} hasInitiative={state.initiative === 'p2'} onFocus={onFocus} />
            <div className="mid"><span>round {state.round}</span><span>{state.phase} phase</span></div>
            <Side seat="p1" p={state.players.p1} botName={bots.p1} active={actor === 'p1'} hasInitiative={state.initiative === 'p1'} onFocus={onFocus} />
        </div>
    );
}
