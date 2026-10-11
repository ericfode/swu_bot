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
import { edgeTerms } from '../data/derive';
import { evalsByIndex } from '../data/evals';
import { useSettings } from '../lib/settings';
import { loadArtPack, setArtResolver, type ArtResolver } from '../lib/cards';
import { parseGame } from '../data/source';
import type { EvalFile } from '../data/evals';
import type { Game } from '../data/types';

export interface MountOptions {
    /** the game: a parsed Game, the .jsonl text, or a URL to fetch it from (exactly one) */
    game?: Game;
    jsonl?: string;
    url?: string;
    /** re-fetch `url` every second while the game has no end record (a game still being played); default true */
    follow?: boolean;
    /** position evaluations (dashboard/evals/<gameId>.json contract), or a URL to fetch them from */
    evals?: EvalFile | null;
    evalsUrl?: string;
    /** first step to show (index into the game's steps) */
    step?: number;
    /** 'full' (default) adds the card inspector and decision log; 'compact' is board + timeline + spine */
    layout?: 'full' | 'compact';
    /** called with the step index whenever the playhead moves */
    onStep?: (step: number) => void;
    /** load the viewer's Google fonts into the host document (default true; fonts can't load from inside a shadow root) */
    fonts?: boolean;
}

export interface ViewerHandle {
    seek(step: number): void;
    play(): void;
    pause(): void;
    setGame(game: Game | string): void;
    setEvals(evals: EvalFile | null): void;
    destroy(): void;
}

const FONTS = 'https://fonts.googleapis.com/css2?family=Oxanium:wght@500;600;700;800&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap';

// Registered custom properties (@property) are ignored inside shadow roots, so always apply Tailwind's fallback defaults.
const shadowCss = css.replace(/@layer properties\s*\{\s*@supports[^{]*\{/, '@layer properties{@supports (display:block){')
    + ':host{display:block;color:var(--color-fg);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}'
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

    let game: Game | null = opts.game ?? (opts.jsonl ? parseGame(opts.jsonl, true) : null);
    let evals: EvalFile | null = opts.evals ?? null;
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
            <MotionConfig reducedMotion="user">
                <GameViewer key={key} game={game} live={!game.end} startStep={opts.step ?? 0} evals={evals} layout={opts.layout ?? 'full'} onStep={opts.onStep}
                    control={(c) => {
                        ctl = c;
                        if (pending != null) {
                            c.seek(pending);
                            pending = null;
                        }
                    }} />
            </MotionConfig>
        );
    };
    const fetchGame = async () => {
        try {
            const r = await fetch(opts.url!);
            if (!r.ok) {
                throw new Error(`${opts.url}: ${r.status}`);
            }
            const g = parseGame(await r.text(), true);
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
    if (!evals && opts.evalsUrl) {
        fetch(opts.evalsUrl).then((r) => (r.ok ? r.json() : null)).then((e) => {
            evals = e;
            render();
        }, () => undefined);
    }

    return {
        seek: (n) => (ctl ? ctl.seek(n) : (pending = n)),
        play: () => ctl?.play(),
        pause: () => ctl?.pause(),
        setGame: (g) => {
            game = typeof g === 'string' ? parseGame(g, true) : g;
            render();
        },
        setEvals: (e) => {
            evals = e;
            render();
        },
        destroy: () => {
            dead = true;
            clearTimeout(timer);
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
 * Draw one action icon (see ActionIcon: glyph < 22px, chip < 48px, card < 96px, card + caption above) into an element.
 * Get actions from classifyGame(game) or pivotal(game, evals).
 */
export function mountActionIcon(el: HTMLElement, props: ActionIconProps) {
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${shadowCss}:host{display:inline-block;vertical-align:middle}</style><span></span>`;
    const root = createRoot(shadow.lastElementChild as HTMLElement);
    root.render(<ActionIcon {...props} />);
    return { update: (p: Partial<ActionIconProps>) => root.render(<ActionIcon {...props} {...p} />), destroy: () => root.unmount() };
}

/** The k most game-changing actions, using the evaluations' swing when given, else the board score's. */
export function pivotal(game: Game, evals?: EvalFile | null, k = 8): Action[] {
    return pivotalActions(classifyGame(game, evalsByIndex(game, evals)), k);
}

/** Switch every viewer and icon on the page between card art (true) and generated tiles (false). */
export function setCardArt(on: boolean) {
    useSettings.getState().setArt(on);
}

export { setArtResolver, loadArtPack };
export type { ArtResolver };
export { GameViewer, Glyph, Spine, ActionIcon, EdgeBreakdown, parseGame, classifyGame, pivotalActions, describe, edgeTerms, tierFor, ACTION_CLASSES };
export type { EvalFile, Game, Action, ActionClass, ActionIconProps };
