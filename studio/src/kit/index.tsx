// SWU viewer kit: the Holotable replay viewer as one embeddable bundle (React and styles included).
//   <div id="game"></div>
//   <script src="swu-viewer-kit.js"></script>
//   <script>const v = SWUViewer.mount(document.getElementById('game'), { url: 'games/x.jsonl', evals, lens }); v.seek(120);</script>
// It renders into a shadow root, so its styles and the host page's styles never touch each other.
import { useMemo, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import css from '../styles.css?inline';
import effectsCss from '../effects/effects.css?inline';
import { GameViewer, lensInputs, type LensEntry, type ViewerControl } from './GameViewer';
import { Glyph } from './Glyph';
import { Spine } from './Spine';
import { ActionIcon, tierFor, type ActionIconProps } from './ActionIcon';
import { EdgeBreakdown } from './EdgeBreakdown';
import { ACTION_CLASSES, classifyGame, describe, pivotalActions, type Action, type ActionClass } from '../data/actions';
import { edgeTerms, trackUnits } from '../data/derive';
import { Board } from '../components/Board';
import { evalsByIndex } from '../data/evals';
import { createSettingsStore, releaseSettingsStore, setEverywhere, SettingsProvider, useSettings } from '../lib/settings';
import { loadArtPack, setArtResolver, type ArtResolver } from '../lib/cards';
import { cardTextBySet, cardTextVersion, loadCardText, loadedCardCost, type CardText, type CardTextFile } from '../lib/cardText';
import { lensPath, parseGame, readDirIndex } from '../data/source';
import type { EvalFile, EvalPoint } from '../data/evals';
import { estimateLens, lensAt, lensByIndex } from '../data/lens';
import { isObj, readLensIndex, type CardValues, type LensFile, type LensIndex, type LensStep, type Sees } from '../data/lensFile';
import {
    chooseDefault, resolveScore, scoreOfBoard, sourcesFor, type Chance, type FileStep, type LensInput, type ScoreSeries, type ScoreSource,
    type ScoreStep, type ScoreView
} from '../data/score';
import { OMNI_V1_ID } from '../data/omniV1';
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
    /**
     * the game's lens files (swu-lens/1: one score per file, with its card values): one file or a list. A bare file first
     * in the list is the default path (dashboard/lens/<gameId>.json); later bare files are keyed by their evaluator id
     * (plus @p1 / @p2); `{dir, file}` keeps a registry dir. Two or more add a score picker. Without any file, Omni v1 is
     * estimated from the board (see `estimate`).
     */
    lens?: LensEntry | LensEntry[] | null;
    /** URLs to fetch lens files from, read like `lens` in this order (`{dir, url}` names the dir); a 404 means none */
    lensUrl?: string | (string | { dir: string; url: string })[];
    /**
     * the lens registry (dashboard/lens/evaluators.json) to fetch: then the game's file from the default path and from
     * each dir it lists (`<dir>/<gameId>.json` beside it; a dir whose index.json lists its games is asked only when it
     * lists this one). Needs `gameId`, or `url` to take it from.
     */
    lensIndexUrl?: string;
    /** the game's id (its replay file name without .jsonl), for lensIndexUrl; default: from `url` */
    gameId?: string;
    /** the registry as an object, when the host loads the files itself (orders the picker, names the score to open first) */
    registry?: LensIndex | null;
    /** the score to open on: a lens dir ('' = the default path) or 'estimate'; default: the registry's default, then the default path */
    score?: string;
    /** the reader picked another score: its key */
    onScore?: (key: string) => void;
    /** estimate Omni v1 from the board for a game with no lens file (default true); false shows no score for it */
    estimate?: boolean;
    /**
     * the Strategy Atlas spots each seat is in ("Board behind", "Near death", ...): chips by each base and a lane per seat
     * under the timeline, by the Atlas kit's rules (window.AtlasKit when the page loaded it, else the built-in copy).
     * Default true; false hides them
     */
    spots?: boolean;
    /** card values on (true) or off (false) for every game; default: on when the chosen score has file values for the game, off for an estimate */
    showLens?: boolean;
    /** start with card art (true, default) or generated tiles (false) */
    art?: boolean;
    /**
     * printed card data (swu-card-text/1, viewer-kit/card-text.json), or a URL to fetch it from: cards without an image get
     * a readable text face in the inspector and tiles in their real aspect colours. Page-wide, like loadCardText().
     */
    cardText?: CardTextFile | string;
    /** save this viewer's switches (art, chosen score, speed, hand perspective) in localStorage under this key; default: not saved */
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
    /** replace the game's lens files: one file (the default path, as earlier builds took it), a list as in `lens`, or null */
    setLens(lens: LensEntry | LensEntry[] | null): void;
    /** add one lens file (a bare file after the first is keyed by its evaluator id) */
    addLens(lens: LensEntry): void;
    /** show the score with this key (a lens dir, '' = the default path, or 'estimate') */
    setScore(key: string): void;
    /** the game's scores, in picker order, with the one shown marked */
    getScores(): ScoreInfo[];
    destroy(): void;
}

/** One score a viewer can show (getScores). */
export interface ScoreInfo {
    /** a lens dir ('' = the default path) or 'estimate' */
    key: string;
    id: string;
    label: string;
    description: string;
    /** 'points', 'logit' or another unit */
    unit: string;
    /** fitted / model: a measured or own chance; rough: a guess, not fitted; none: no chance */
    chance: Chance;
    sees: Sees;
    perspective: Seat | null;
    cardValues: CardValues;
    origin: 'file' | 'estimate';
    /** the file was refused (e.g. another schema): why */
    error: string | null;
    /** the score in view */
    chosen: boolean;
}

const infoOf = (s: ScoreSource, chosen: ScoreSource | null): ScoreInfo => ({
    key: s.key, id: s.id, label: s.label, description: s.description, unit: s.unit, chance: s.chance, sees: s.sees,
    perspective: s.perspective, cardValues: s.cardValues, origin: s.origin, error: s.error, chosen: s === chosen
});

/** the lens entries given, without the nulls and non-objects a host may leave in a list */
const entries = (l: LensEntry | LensEntry[] | null | undefined): LensEntry[] => (Array.isArray(l) ? l : l ? [l] : []).filter((x) => isObj(x));

/** dirs use only [a-z0-9._@-] (never '.' or '..'), so a registry can't point a fetch outside its folder */
const goodDir = (d: string) => d === '' || (/^[a-z0-9._@-]+$/.test(d) && d !== '.' && d !== '..');

/** JSON at a URL, or null for a missing file, a network error or a body that isn't JSON */
async function getJson(url: string | URL): Promise<unknown> {
    try {
        const r = await fetch(url);
        return r.ok ? await r.json() : null;
    } catch {
        return null;
    }
}

/** The registry at `indexUrl`, then the game's file from the default path and every dir it lists (as Holotable's game page). */
async function fetchLenses(indexUrl: string, gameId: string): Promise<{ registry: LensIndex | null; files: LensInput[] }> {
    const base = new URL(indexUrl, document.baseURI);
    const registry = readLensIndex(await getJson(base));
    const dirs = [...new Set(['', ...(registry?.evaluators.map((e) => e.dir) ?? [])])].filter(goodDir);
    const files = await Promise.all(dirs.map(async (dir): Promise<LensInput | null> => {
        const idx = registry ? readDirIndex(await getJson(new URL(lensPath(dir, 'index.json'), base))) : null;
        if (idx?.games && !idx.games.includes(gameId)) {
            return null;
        }
        const file = await getJson(new URL(lensPath(dir, `${gameId}.json`), base));
        return file ? { dir, file } : null;
    }));
    return { registry, files: files.filter((f): f is LensInput => !!f) };
}

const FONTS = 'https://fonts.googleapis.com/css2?family=Oxanium:wght@500;600;700;800&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap';

// Registered custom properties (@property) are ignored inside shadow roots, so always apply Tailwind's fallback defaults.
const shadowCss = css.replace(/@layer properties\s*\{\s*@supports[^{]*\{/, '@layer properties{@supports (display:block){')
    + effectsCss
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
    if (opts.cardText) {
        loadCardText(opts.cardText).catch(() => undefined);
    }

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
    // the lens files as GameViewer's inputs (dirs settled once, so the array keeps its identity between renders)
    let lens: LensInput[] = lensInputs(entries(opts.lens));
    let registry: LensIndex | null = opts.registry ?? null;
    // bumps on setLens: a fetch started before it doesn't add its files
    let lensGen = 0;
    let scoreKey: string | null = opts.score ?? null;
    const onScore = (key: string) => {
        scoreKey = key;
        opts.onScore?.(key);
    };
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
                <GameViewer key={key} game={game} live={!game.end} startStep={opts.step ?? (opts.stepN != null ? indexOfN(opts.stepN) : 0)} evals={evals}
                    lens={lens} registry={registry} score={scoreKey} onScore={onScore} estimate={opts.estimate} spots={opts.spots !== false} layout={opts.layout ?? 'full'} onStep={opts.onStep}
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
    const setLensList = (l: LensEntry | LensEntry[] | null) => {
        lensGen++;
        lens = lensInputs(entries(l));
        render();
    };
    const addLensList = (more: LensEntry[], gen: number) => {
        if (gen !== lensGen || dead || !more.length) {
            return;
        }
        lens = lensInputs([...lens, ...entries(more)]);
        render();
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
    if (opts.lensUrl) {
        const urls = Array.isArray(opts.lensUrl) ? opts.lensUrl : [opts.lensUrl];
        const gen = lensGen;
        Promise.all(urls.map(async (u): Promise<LensEntry | null> => {
            const file = await getJson(typeof u === 'string' ? u : u.url);
            return !isObj(file) ? null : typeof u === 'string' ? (file as unknown as LensFile) : { dir: u.dir, file };
        })).then((got) => addLensList(got.filter((f): f is LensEntry => !!f), gen));
    }
    const gameId = opts.gameId ?? opts.url?.split(/[?#]/)[0].split('/').pop()?.replace(/\.jsonl$/, '');
    if (opts.lensIndexUrl && gameId) {
        const gen = lensGen;
        fetchLenses(opts.lensIndexUrl, gameId).then((r) => {
            if (gen !== lensGen || dead) {
                return;
            }
            registry = registry ?? r.registry;
            if (r.files.length) {
                addLensList(r.files, gen);
            } else {
                render();
            }
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
        setLens: (l) => setLensList(l),
        addLens: (l) => addLensList([l], lensGen),
        setScore: (key) => {
            scoreKey = key;
            render();
            ctl?.setScore(key);
        },
        getScores: () => {
            if (ctl) {
                const { sources, chosen } = ctl.scores();
                return sources.map((s) => infoOf(s, chosen));
            }
            if (!game) {
                return [];
            }
            // not drawn yet: the scores the viewer will offer, and the one it will open on
            const sources = sourcesFor(game, lens, registry, { estimate: opts.estimate });
            const chosen = chooseDefault(sources, { requested: scoreKey, saved: settings.getState().score, registryDefault: registry?.default ?? null });
            return sources.map((s) => infoOf(s, chosen));
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
 * mountBoard's board with its score worked out inside React, so the score is worked out again when card data arrives
 * (each load bumps artVersion): the estimate and Omni v1 files without parts take card cost from the loaded card data,
 * as the viewer and pivotal() do, and `cardText` given as a URL lands after the first draw.
 */
function KitBoard({ lens, ...props }: Omit<ComponentProps<typeof Board>, 'score'> & { lens: boolean | LensStep | FileStep | undefined }) {
    useSettings((s) => s.artVersion);
    const textVersion = cardTextVersion();
    const score = useMemo((): ScoreView | null => (lens ? scoreOfBoard(props.state, lens, { cardCost: loadedCardCost }) : null), [props.state, lens, textVersion]);
    return <Board {...props} score={score} />;
}

/**
 * Draw one position (a recorder Snapshot, i.e. a step's `state`) as the full animated board. update() animates to the next one.
 * `lens` (card values): true draws the Omni v1 estimate from the board; `{file, n}` draws the step with Step.n n of a
 * swu-lens/1 file, with that file's label, rules and chance (pass the snapshot of that step); a bare lens step (one entry
 * of a file's steps) is drawn as "lens step (evaluator unknown)": six rows, no rules and no chance, since a step alone
 * doesn't say which score it is (pass `{file, n}` to keep its label). `spots: false` hides the Atlas spot chips by each base.
 */
export function mountBoard(el: HTMLElement, state: Snapshot, opts: { bots?: Record<Seat, string>; fonts?: boolean; lens?: boolean | LensStep | FileStep; cardText?: CardTextFile | string; spots?: boolean } = {}) {
    if (opts.fonts !== false) {
        ensureFonts();
    }
    if (opts.cardText) {
        loadCardText(opts.cardText).catch(() => undefined);
    }
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${shadowCss}</style><div class="swuv-root"></div>`;
    const root = createRoot(shadow.lastElementChild as HTMLElement);
    const bots = opts.bots ?? { p1: state.players.p1.name, p2: state.players.p2.name };
    let prev: Snapshot | null = null;
    let n = 0;
    let lensOpt = opts.lens;
    const draw = (cur: Snapshot) => {
        const steps = (prev ? [prev, cur] : [cur]).map((st, i) => ({ t: 'step' as const, n: i, state: st }));
        const ids = trackUnits({ header: { t: 'header', v: 1, seed: 0, engine: null, players: [] }, steps, end: null });
        root.render(
            <MotionConfig reducedMotion="user">
                <KitBoard lens={lensOpt} spots={opts.spots !== false} state={cur} prev={prev} ids={ids[ids.length - 1]} prevIds={prev ? ids[0] : null} bots={bots} actor={null} step={n++} onFocus={() => undefined} />
            </MotionConfig>
        );
    };
    draw(state);
    return {
        update: (next: Snapshot, lens?: boolean | LensStep | FileStep) => {
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

/** The lens inputs a kit function takes: one file, a list as in mount's `lens`, or a resolved series. */
type ScoreArg = LensEntry | LensEntry[] | ScoreSeries | null | undefined;
const isSeries = (x: object): x is ScoreSeries => 'source' in x && 'scales' in x && Array.isArray((x as ScoreSeries).steps);

/**
 * A game's score over every step: the score with key `score` (a lens dir, '' = the default path, or 'estimate'), else
 * the one a mounted viewer opens on. `files` as in mount's `lens`; with none, the Omni v1 estimate unless `estimate` is
 * false. Card cost comes from the loaded card data, as in a mounted viewer, so call it after loadCardText() resolves.
 */
export function scoreSeries(game: Game, files?: LensEntry | LensEntry[] | null, opts: { score?: string | null; registry?: LensIndex | null; estimate?: boolean } = {}): ScoreSeries | null {
    const sources = sourcesFor(game, lensInputs(entries(files)), opts.registry ?? null, { estimate: opts.estimate });
    const source = chooseDefault(sources, { requested: opts.score, registryDefault: opts.registry?.default ?? null });
    return source ? resolveScore(game, source, { cardCost: loadedCardCost }) : null;
}

/** The score at step index i of a series: its source and that step (status, edge, p1Win, seat values, weights, search). */
export function scoreAt(series: ScoreSeries | null, i: number): ScoreView | null {
    const step = series?.steps[i];
    return series && step ? { source: series.source, step } : null;
}

/**
 * Every decision of a game grouped into actions. Pass the game's evals file (dashboard/evals) and its lens files or a
 * series when there are any: swings then come from the evaluations, else from the score (the default score of the
 * files, or the Omni v1 estimate without any; card cost once card data is loaded, so call it after loadCardText()
 * resolves to match a mounted viewer). Maps by step index (what earlier kit builds took) still work.
 */
function classify(game: Game, evals?: EvalFile | Map<number, EvalPoint> | null, lens?: ScoreArg | Map<number, LensStep>): Action[] {
    // a Map by step index (earlier builds, which only knew omni lens steps): read it as an omni-linear-v1 file
    const files = lens instanceof Map ? { schema: 'swu-lens/1', evaluator: { id: OMNI_V1_ID }, steps: [...lens].map(([i, st]) => ({ ...st, n: game.steps[i]?.n ?? st.n })) } as LensFile : lens;
    const series = files && !Array.isArray(files) && isSeries(files) ? files : scoreSeries(game, files);
    return classifyGame(game, evals instanceof Map ? evals : evalsByIndex(game, evals), series);
}

/** The k most game-changing actions: by the evaluations' swing when given, else by the score's (lens files or a series, as classifyGame). */
export function pivotal(game: Game, evals?: EvalFile | Map<number, EvalPoint> | null, k = 8, lens?: ScoreArg | Map<number, LensStep>): Action[] {
    return pivotalActions(classify(game, evals, lens), k);
}

/** Turn card values on or off for every viewer on the page (over each game's default and its Card values button). */
export function setLensView(on: boolean) {
    setEverywhere({ lens: on });
}

/** Switch every viewer and icon on the page between card art (true) and generated tiles (false). */
export function setCardArt(on: boolean) {
    setEverywhere({ art: on });
}

export { setArtResolver, loadArtPack, loadCardText, cardTextBySet as cardText };
export type { ArtResolver, CardText, CardTextFile };
export { GameViewer, Glyph, Spine, ActionIcon, EdgeBreakdown, parseGame, classify as classifyGame, pivotalActions, describe, tierFor, ACTION_CLASSES };
/** @deprecated kept for one release: earlier builds' Omni v1 helpers; read a score with scoreSeries and scoreAt */
export { edgeTerms, estimateLens, lensAt, lensByIndex };
export type { EvalFile, Game, Action, ActionClass, ActionIconProps, LensEntry, LensFile, LensIndex, LensStep, LensInput, FileStep };
export type { Chance, ScoreSeries, ScoreSource, ScoreStep, ScoreView };
