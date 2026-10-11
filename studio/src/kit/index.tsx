// SWU viewer kit: the Holotable replay viewer as one embeddable bundle (React and styles included).
//   <div id="game"></div>
//   <script src="swu-viewer-kit.js"></script>
//   <script>const v = SWUViewer.mount(document.getElementById('game'), { url: 'games/x.jsonl', evals }); v.seek(120);</script>
// It renders into a shadow root, so its styles and the host page's styles never touch each other.
import { createRoot, type Root } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import css from '../styles.css?inline';
import { GameViewer, type ViewerControl } from './GameViewer';
import { Glyph } from './Glyph';
import { Spine } from './Spine';
import { ActionIcon, tierFor, type ActionIconProps } from './ActionIcon';
import { EdgeBreakdown } from './EdgeBreakdown';
import { ACTION_CLASSES, classifyGame, describe, pivotalActions, type Action, type ActionClass } from '../data/actions';
import { edgeTerms, trackUnits } from '../data/derive';
import { Board } from '../components/Board';
import { evalsByIndex } from '../data/evals';
import { createSettingsStore, releaseSettingsStore, setEverywhere, SettingsProvider } from '../lib/settings';
import { loadArtPack, setArtResolver, type ArtResolver } from '../lib/cards';
import { parseGame } from '../data/source';
import type { EvalFile } from '../data/evals';
import { estimateLens, lensAt, lensByIndex, OMNI_WEIGHTS, type LensFile, type LensStep, type LensView } from '../data/lens';
import type { Game, Seat, Snapshot } from '../data/types';

export interface MountOptions {
    /** the game: a parsed Game, the .jsonl text, or a URL to fetch it from (exactly one) */
    game?: Game;
    jsonl?: string;
    /** recorder lines (each one JSON object, or already-parsed objects) */
    lines?: (string | object)[];
    url?: string;
    /** re-fetch `url` every second while the game has no end record (a game still being played); default true */
    follow?: boolean;
    /** position evaluations (dashboard/evals/<gameId>.json contract), or a URL to fetch them from */
    evals?: EvalFile | null;
    evalsUrl?: string;
    /** the omni bot's card values (dashboard/lens/<gameId>.json, swu-lens/1), or a URL to fetch them from; the Lens button estimates them without it */
    lens?: LensFile | null;
    lensUrl?: string;
    /** start with the Lens on (true) or off (false); default off */
    showLens?: boolean;
    /** start with card art (true, default) or generated tiles (false) */
    art?: boolean;
    /** save this viewer's switches (art, lens, speed, hand perspective) in localStorage under this key; default: not saved */
    persist?: string;
    /** first step to show (index into the game's steps); or stepN to give it as Step.n */
    step?: number;
    stepN?: number;
    /** 'full' (default) adds the card inspector and decision log; 'compact' is board + timeline + spine */
    layout?: 'full' | 'compact';
    /** called whenever the playhead moves, with the step index and that step's Step.n */
    onStep?: (step: number, n: number) => void;
    /** load the viewer's Google fonts into the host document (default true; fonts can't load from inside a shadow root) */
    fonts?: boolean;
}

export interface ViewerHandle {
    /** jump to a step index */
    seek(step: number): void;
    /** jump to the step whose Step.n is n (or the last one before it) */
    seekStepN(n: number): void;
    /** add recorder lines as a live game is tailed (JSONL text, or an array of lines/objects); the view follows if it was at the end */
    append(lines: string | (string | object)[]): void;
    getGame(): Game | null;
    play(): void;
    pause(): void;
    setGame(game: Game | string): void;
    setEvals(evals: EvalFile | null): void;
    setLens(lens: LensFile | null): void;
    destroy(): void;
}

const FONTS = 'https://fonts.googleapis.com/css2?family=Oxanium:wght@500;600;700;800&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap';

// Registered custom properties (@property) are ignored inside shadow roots, so always apply Tailwind's fallback defaults.
const shadowCss = css.replace(/@layer properties\s*\{\s*@supports[^{]*\{/, '@layer properties{@supports (display:block){')
    // all:initial stops the host page's inherited text styles (case, italics, nowrap, shadows, colour scheme) leaking in
    + ':host{all:initial;display:block;color-scheme:dark;color:var(--color-fg);font-family:var(--font-sans);font-size:14px;line-height:1.5;text-align:left;-webkit-font-smoothing:antialiased}'
    + '.swuv-root{background:var(--color-bg);border-radius:16px;padding:12px;container-type:inline-size}';

function ensureFonts() {
    if (!document.querySelector(`link[href="${FONTS}"]`)) {
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = FONTS;
        document.head.appendChild(l);
    }
}

export function mount(el: HTMLElement, opts: MountOptions = {}): ViewerHandle {
    if (opts.fonts !== false) {
        ensureFonts();
    }
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    shadow.innerHTML = '';
    const style = document.createElement('style');
    style.textContent = shadowCss;
    const host = document.createElement('div');
    host.className = 'swuv-root';
    shadow.append(style, host);
    const root: Root = createRoot(host);

    const toText = (ls: (string | object)[]) => ls.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
    let raw: string | null = opts.jsonl ?? (opts.lines ? toText(opts.lines) : null);
    let game: Game | null = opts.game ?? (raw ? parseGame(raw, true) : null);
    const indexOfN = (n: number) => {
        if (!game) {
            return 0;
        }
        let best = 0;
        game.steps.forEach((st, i) => {
            if (st.n <= n) {
                best = i;
            }
        });
        return best;
    };
    let evals: EvalFile | null = opts.evals ?? null;
    let lens: LensFile | null = opts.lens ?? null;
    // each viewer has its own switches, so two viewers on one page don't toggle each other
    const settings = createSettingsStore(opts.persist ?? null, {
        ...(opts.showLens != null ? { lens: opts.showLens } : {}),
        ...(opts.art != null ? { art: opts.art } : {})
    });
    let ctl: ViewerControl | null = null;
    let pending: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dead = false;

    const render = () => {
        if (dead) {
            return;
        }
        if (!game) {
            root.render(<div style={{ padding: 24, color: 'var(--color-dim)' }}>Loading game…</div>);
            return;
        }
        const key = `${game.header.seed}:${game.header.players.map((p) => p.bot).join('/')}`;
        root.render(
            <SettingsProvider store={settings}><MotionConfig reducedMotion="user">
                <GameViewer key={key} game={game} live={!game.end} startStep={opts.step ?? (opts.stepN != null ? indexOfN(opts.stepN) : 0)} evals={evals} lens={lens} layout={opts.layout ?? 'full'} onStep={opts.onStep}
                    control={(c) => {
                        ctl = c;
                        if (pending != null) {
                            c.seek(pending);
                            pending = null;
                        }
                    }} />
            </MotionConfig></SettingsProvider>
        );
    };
    const fetchGame = async () => {
        try {
            const r = await fetch(opts.url!);
            if (!r.ok) {
                throw new Error(`${opts.url}: ${r.status}`);
            }
            raw = await r.text();
            const g = parseGame(raw, true);
            if (g && !dead) {
                game = g;
                render();
            }
            if (!dead && opts.follow !== false && (!g || !g.end)) {
                timer = setTimeout(fetchGame, 1000);
            }
        } catch (e) {
            if (!dead && !game) {
                root.render(<div style={{ padding: 24, color: 'var(--color-p2)' }}>Couldn't load the game: {(e as Error).message}</div>);
            }
        }
    };

    render();
    if (!game && opts.url) {
        fetchGame();
    }
    if (!lens && opts.lensUrl) {
        fetch(opts.lensUrl).then((r) => (r.ok ? r.json() : null)).then((l) => {
            lens = l;
            render();
        }, () => undefined);
    }
    if (!evals && opts.evalsUrl) {
        fetch(opts.evalsUrl).then((r) => (r.ok ? r.json() : null)).then((e) => {
            evals = e;
            render();
        }, () => undefined);
    }

    return {
        seek: (n) => (ctl ? ctl.seek(n) : (pending = n)),
        seekStepN: (n) => {
            const i = indexOfN(n);
            if (ctl) {
                ctl.seek(i);
            } else {
                pending = i;
            }
        },
        append: (lines) => {
            const text = typeof lines === 'string' ? (lines.endsWith('\n') ? lines : lines + '\n') : toText(lines);
            if (raw == null && game) {
                raw = toText([game.header, ...game.steps, ...(game.end ? [game.end] : [])]);
            }
            raw = (raw ?? '') + text;
            const g = parseGame(raw, true);
            if (g) {
                game = g;
                render();
            }
        },
        getGame: () => game,
        play: () => ctl?.play(),
        pause: () => ctl?.pause(),
        setGame: (g) => {
            raw = typeof g === 'string' ? g : null;
            game = typeof g === 'string' ? parseGame(g, true) : g;
            render();
        },
        setEvals: (e) => {
            evals = e;
            render();
        },
        setLens: (l) => {
            lens = l;
            render();
        },
        destroy: () => {
            dead = true;
            clearTimeout(timer);
            releaseSettingsStore(settings);
            root.unmount();
            shadow.innerHTML = '';
        }
    };
}

/** Draw one board position as the compact glyph (the same drawing the research dashboard uses) into an element. */
export function mountGlyph(el: HTMLElement, state: Game['steps'][number]['state'], opts: { size?: number; value?: number | null } = {}) {
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${shadowCss}:host{display:inline-block}</style><span></span>`;
    const root = createRoot(shadow.lastElementChild as HTMLElement);
    root.render(<Glyph state={state} size={opts.size} value={opts.value} />);
    return { destroy: () => root.unmount() };
}

/**
 * Draw one action icon (see ActionIcon: glyph < 32px, chip < 48px, card < 96px, card + caption above) into an element.
 * Get actions from classifyGame(game) or pivotal(game, evals).
 */
export function mountActionIcon(el: HTMLElement, props: ActionIconProps) {
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${shadowCss}:host{display:inline-block;vertical-align:middle}</style><span></span>`;
    const root = createRoot(shadow.lastElementChild as HTMLElement);
    root.render(<ActionIcon {...props} />);
    return { update: (p: Partial<ActionIconProps>) => root.render(<ActionIcon {...props} {...p} />), destroy: () => root.unmount() };
}

/**
 * Draw one position (a recorder Snapshot, i.e. a step's `state`) as the full animated board. update() animates to the next one.
 * `lens`: true draws card values estimated from the board; a lens step (one entry of a swu-lens/1 file's steps) draws the omni bot's own.
 */
export function mountBoard(el: HTMLElement, state: Snapshot, opts: { bots?: Record<Seat, string>; fonts?: boolean; lens?: boolean | LensStep } = {}) {
    if (opts.fonts !== false) {
        ensureFonts();
    }
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${shadowCss}</style><div class="swuv-root"></div>`;
    const root = createRoot(shadow.lastElementChild as HTMLElement);
    const bots = opts.bots ?? { p1: state.players.p1.name, p2: state.players.p2.name };
    let prev: Snapshot | null = null;
    let n = 0;
    let lensOpt = opts.lens;
    const viewOf = (cur: Snapshot): LensView | null => !lensOpt ? null
        : lensOpt === true ? { ...estimateLens(cur), exact: false, weights: OMNI_WEIGHTS } : { ...lensOpt, exact: true, weights: OMNI_WEIGHTS };
    const draw = (cur: Snapshot) => {
        const steps = (prev ? [prev, cur] : [cur]).map((st, i) => ({ t: 'step' as const, n: i, state: st }));
        const ids = trackUnits({ header: { t: 'header', v: 1, seed: 0, engine: null, players: [] }, steps, end: null });
        root.render(
            <MotionConfig reducedMotion="user">
                <Board state={cur} prev={prev} ids={ids[ids.length - 1]} prevIds={prev ? ids[0] : null} bots={bots} actor={null} step={n++} onFocus={() => undefined} lens={viewOf(cur)} />
            </MotionConfig>
        );
    };
    draw(state);
    return {
        update: (next: Snapshot, lens?: boolean | LensStep) => {
            if (lens !== undefined) {
                lensOpt = lens;
            }
            prev = state;
            state = next;
            draw(next);
        },
        destroy: () => root.unmount()
    };
}

/**
 * Every decision of a game grouped into actions. Pass the game's evals file (dashboard/evals) and lens file (swu-lens/1)
 * when there are any: swings then come from the evaluations, or from the omni bot's exact board score.
 */
function classify(game: Game, evals?: EvalFile | null, lens?: LensFile | null): Action[] {
    return classifyGame(game, evalsByIndex(game, evals), lensByIndex(game, lens));
}

/** The k most game-changing actions, using the evaluations' swing when given, else the omni board score's (exact with a lens file). */
export function pivotal(game: Game, evals?: EvalFile | null, k = 8, lens?: LensFile | null): Action[] {
    return pivotalActions(classify(game, evals, lens), k);
}

/** Turn the card-value Lens on or off for every viewer on the page. */
export function setLensView(on: boolean) {
    setEverywhere({ lens: on });
}

/** Switch every viewer and icon on the page between card art (true) and generated tiles (false). */
export function setCardArt(on: boolean) {
    setEverywhere({ art: on });
}

export { setArtResolver, loadArtPack };
export type { ArtResolver };
export { GameViewer, Glyph, Spine, ActionIcon, EdgeBreakdown, parseGame, classify as classifyGame, pivotalActions, describe, edgeTerms, tierFor, ACTION_CLASSES, estimateLens, lensAt, lensByIndex };
export type { EvalFile, Game, Action, ActionClass, ActionIconProps, LensFile, LensStep };
