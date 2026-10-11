// Shared by build.mjs (Node, reads the disk) and the published page (reads project files live).
// A reader is { list(dir) -> [{name, path, isDirectory}], text(path) -> string|null }; paths are project-relative.
(function (root) {
    const LAST = {};
    const ORDER = { running: 0, planned: 1, done: 2, failed: 3 };
    const parse = (s, warn, p) => { if (s == null) return null; try { return JSON.parse(s); } catch (e) { warn.push(`${p}: ${e.message}`); return null; } };

    async function loadSources(reader) {
        const warn = [];
        // a file being rewritten can read half-written; fall back to its last good parse instead of dropping it
        const json = async p => { const w = []; const v = parse(await reader.text(p), w, p); if (v) return (LAST[p] = v); if (LAST[p]) return LAST[p]; warn.push(...w); return null; };
        const dirJson = async d => (await reader.list(d)).filter(e => !e.isDirectory && e.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name));
        // league: results/<run>/index.json plus dashboard/league/*.json
        const runs = [];
        for (const top of ['results', 'games']) {
            for (const e of (await reader.list(top)).filter(e => e.isDirectory && !e.name.startsWith('_') && e.name !== 'card-data')) {
                const ix = await json(`${top}/${e.name}/index.json`);
                if (ix && Array.isArray(ix.games) && !runs.some(r => r.id === ix.id)) { const lad = await json(`${top}/${e.name}/ladder.json`).catch(() => null); const extra = Object.fromEntries((lad?.games || []).map(g => [g.id, g]));
                    const games = ix.games.map(g => extra[g.id] ? { ...g, botStats: g.botStats ?? extra[g.id].botStats, timing: g.timing ?? extra[g.id].timing } : g);
                    runs.push({ ...ix, games, _dir: `${top}/${e.name}`, _bots: lad?.bots || null }); }
            }
        }
        let botMeta = [];
        for (const f of await dirJson('dashboard/league')) {
            const j = await json(`dashboard/league/${f.name}`);
            if (!j) continue;
            if (f.name === 'bots.json') botMeta = j.bots || [];
            else if (Array.isArray(j.games) && !runs.some(r => r.id === j.id)) runs.push({ ...j, _dir: null });
        }
        runs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        const many = async d => (await Promise.all((await dirJson(d)).map(f => json(`${d}/${f.name}`)))).filter(Boolean);
        const experiments = (await many('dashboard/experiments')).sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
        const evals = (await many('dashboard/evals')).sort((a, b) => String(a.gameId).localeCompare(String(b.gameId)));
        const panels = (await many('dashboard/panels')).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        const threads = (await json('dashboard/threads.json')) || { threads: [] };
        // bot cards (swu-bot/1, dashboard/bots/<id>.json); a card's family/lang/owner/oneLine win over bots.json
        const about = (await many('dashboard/bots')).filter(b => b && b.id && b.schema === 'swu-bot/1');
        const metaIdx = Object.fromEntries(botMeta.map((m, i) => [m.id, i]));
        for (const a of about) for (const id of [a.id, ...(a.aliases || [])]) {
            const m = { ...(botMeta[metaIdx[id]] || { id }) };
            if (a.family) m.family = a.family; if (a.lang) m.lang = a.lang; if (a.owner) m.owner = a.owner; if (a.oneLine) m.notes = a.oneLine;
            if (id in metaIdx) botMeta[metaIdx[id]] = m; else { metaIdx[id] = botMeta.length; botMeta.push(m); }
        }
        // meta analyzer model (swu-meta/1), slimmed to what the bot cards show
        const mj = await json('meta/meta.json');
        const meta = mj && Array.isArray(mj.bots) ? { generatedAt: mj.generatedAt, games: mj.totals?.games ?? null,
            situations: (mj.situations || []).map(s => ({ id: s.id, group: s.group, label: s.label, short: s.short, field: s.field })),
            style: mj.style || [],
            bots: Object.fromEntries(mj.bots.map(b => [b.id, { family: b.family, lang: b.lang, owner: b.owner, games: b.replayGames ?? b.games, played: b.games, rating: b.rating, msP50: b.msP50, style: b.style, forfeits: b.forfeits || 0,
                // Atlas scouting line: style tag, best and worst spot for its own level (by vsOwn)
                tag: b.summary?.style || null, best: b.summary?.best?.id || null, worst: b.summary?.worst?.id || null,
                situations: Object.fromEntries(Object.entries(b.situations || {}).map(([k, v]) => [k, { n: v.n, rate: v.rate, expected: v.expected, edge: v.edge, vsOwn: v.vsOwn }])) }])),
            // per spot: the 5 best bots by edge with 8+ games there (the Strategy Atlas picks its spot winner the same way), with replay examples
            spots: Object.fromEntries((mj.situations || []).map(s => [s.id, mj.bots.filter(b => (b.situations?.[s.id]?.n || 0) >= 8)
                .sort((a, b) => b.situations[s.id].edge - a.situations[s.id].edge).slice(0, 5)
                .map(b => ({ id: b.id, edge: b.situations[s.id].edge, n: b.situations[s.id].n, examples: (b.situations[s.id].examples || []).slice(0, 2) }))])),
            // per spot: the weakest non-random bot with 8+ games there (the Atlas tile's "worst" line)
            spotWorst: Object.fromEntries((mj.situations || []).map(s => [s.id, mj.bots.filter(b => b.family !== 'random' && (b.situations?.[s.id]?.n || 0) >= 8)
                .sort((a, b) => a.situations[s.id].edge - b.situations[s.id].edge).slice(0, 1).map(b => ({ id: b.id, edge: b.situations[s.id].edge, n: b.situations[s.id].n }))[0] || null])) } : null;
        // Lean theory thread: evaluator measurements (research/eval-theory/td-report.json); any evaluator added there shows up
        const td = await json('research/eval-theory/td-report.json');
        const theory = td && td.evaluators ? { games: td.games?.n ?? null, windows: td.games?.windows ?? null,
            evaluators: Object.entries(td.evaluators).map(([id, e]) => ({ id, dataset: e.dataset || null, fit: e.fit || null, brier: e.brier, tdLoss: e.td_loss, provenN: e.proven_n, provenAcc: e.proven_acc, provenBrier: e.proven_brier,
                byLeft: (e.by_left || []).map(b => ({ lo: b.lo, hi: b.hi, n: b.n, brier: b.brier })) })) } : null;
        // the one rating (Eric's pick, 2026-10-11 18:21): Strategy Atlas rules, written once by the meta analyzer
        const rj = await json('meta/ratings.json');
        const ratings = rj && rj.bots && typeof rj.bots === 'object' ? { generatedAt: rj.generatedAt || null, rules: rj.rules || null, bots: rj.bots } : null;
        return { runs, botMeta, about, meta, ratings, theory, experiments, evals, panels, threads, warnings: warn };
    }

    // Games worth watching, best first: running games (newest first), then the most recent finished one.
    function liveCandidates(runs) {
        const out = [];
        for (let i = runs.length - 1; i >= 0; i--) {
            const r = runs[i];
            if (!r._dir) continue;
            for (const g of [...r.games].reverse()) if (g.outcome === 'running') out.push({ run: r.id, id: g.id, path: `${r._dir}/games/${g.id}.jsonl`, running: true, p1: g.p1, p2: g.p2 });
        }
        // the newest run's last game may have no replay (some ladders do not record), so offer a few runs
        for (let i = runs.length - 1, k = 0; i >= 0 && k < 6; i--) {
            const r = runs[i], g = r._dir && [...r.games].reverse().find(g => g.outcome !== 'running');
            if (g) { out.push({ run: r.id, id: g.id, path: `${r._dir}/games/${g.id}.jsonl`, running: false, p1: g.p1, p2: g.p2 }); k++; }
        }
        return out;
    }
    const pickLiveGame = runs => liveCandidates(runs)[0] || null;

    // The Atlas rating for a league id: the Atlas names random-a/b/c (one random player per seat) just "random".
    // Only own entries with a finite rating count; numbers are coerced so the page can print them as they are.
    function atlasRating(ratings, id) {
        const R = ratings?.bots || {}, has = k => Object.prototype.hasOwnProperty.call(R, k);
        const as = has(id) ? id : /^random-[a-z]$/.test(id) && has('random') ? 'random' : null, e = as ? R[as] : null;
        if (!e || !Number.isFinite(+e.rating) || e.rating === null || e.rating === '') return null;
        const num = v => Number.isFinite(+v) && v !== null && v !== '' ? Math.round(+v) : null;
        return { rating: Math.round(+e.rating), se: num(e.se), games: num(e.games), as };
    }

    // ratings: meta/ratings.json (or null). Rows are ranked by that rating; the running Elo stays as "form" (its
    // history draws the chart, `trend` is its change over the last 30 games).
    function computeLeague(runs, meta, ratings) {
        const K = 24, rating = {}, stats = {}, history = {}, h2h = {};
        const bot = b => {
            if (!(b in rating)) { rating[b] = 1500; stats[b] = { games: 0, wins: 0, losses: 0, draws: 0, faults: 0, rounds: 0, firstSeen: null }; history[b] = []; }
            return stats[b];
        };
        let n = 0, errors = 0, p1Wins = 0, decided = 0, running = 0;
        const marks = [], recent = [];
        for (const t of runs) {
            marks.push({ game: n, id: t.id, createdAt: t.createdAt });
            for (const b of t.bots || []) { bot(b); if (!stats[b].firstSeen) stats[b].firstSeen = t.createdAt; if (!history[b].length) history[b].push([n, 1500]); }
            for (const g of t.games) {
                if (g.outcome === 'running') { running++; continue; }
                // A bot that sends a late or broken reply loses the game, as in the Strategy Atlas: protocol v2 ends it as
                // ERROR with `by` = the failing seat; older runs wrote ERROR "TIME_FORFEIT <bot> ...".
                const tf = g.outcome === 'ERROR' && !g.by && /^TIME_FORFEIT (\S+)/.exec(g.error || '');
                const by = g.outcome !== 'ERROR' ? null : g.by === 'p1' || g.by === 'p2' ? g.by : tf ? (tf[1] === g.p1 ? 'p1' : tf[1] === g.p2 ? 'p2' : null) : null;
                const forfeit = !!by;
                if (!g.p1 || !g.p2 || (!forfeit && (g.error || (!g.winner && !g.winnerSeat)))) { errors++; continue; }
                const a = bot(g.p1), b = bot(g.p2);
                const draw = !forfeit && g.winnerSeat === 'draw';
                const sa = draw ? 0.5 : forfeit ? (by === 'p2' ? 1 : 0) : (g.winner === g.p1 || g.winnerSeat === 'p1') ? 1 : 0;
                if (forfeit) (by === 'p1' ? a : b).faults++;
                const ea = 1 / (1 + 10 ** ((rating[g.p2] - rating[g.p1]) / 400));
                rating[g.p1] += K * (sa - ea); rating[g.p2] -= K * (sa - ea);
                n++;
                for (const [s, r] of [[a, sa], [b, 1 - sa]]) { s.games++; s.rounds += g.rounds || 0; r === 1 ? s.wins++ : r === 0 ? s.losses++ : s.draws++; }
                if (!draw && !forfeit) { decided++; if (sa === 1) p1Wins++; }
                for (const [x, y, r] of [[g.p1, g.p2, sa], [g.p2, g.p1, 1 - sa]]) { const k = `${x}|${y}`; (h2h[k] ||= { s: 0, n: 0 }); h2h[k].s += r; h2h[k].n++; }
                history[g.p1].push([n, Math.round(rating[g.p1])]); history[g.p2].push([n, Math.round(rating[g.p2])]);
                recent.push({ run: t.id, id: g.id, p1: g.p1, p2: g.p2, winner: draw ? 'draw' : sa ? g.p1 : g.p2, rounds: g.rounds, n, ...(forfeit ? { failed: by === 'p1' ? g.p1 : g.p2, error: g.error || null } : {}) });
            }
        }
        const metaBy = Object.fromEntries((meta || []).map(m => [m.id, m]));
        const lastBots = runs.at(-1)?.bots || [];
        const standings = Object.keys(rating).map(id => {
            const s = stats[id], hist = history[id];
            const back = hist.length > 1 ? hist[Math.max(0, hist.length - 31)][1] : 1500;
            return { id, elo: Math.round(rating[id]), trend: Math.round(rating[id] - back), ...s,
                winRate: s.games ? +((s.wins + s.draws / 2) / s.games).toFixed(3) : null,
                family: metaBy[id]?.family || 'other', lang: metaBy[id]?.lang || null, owner: metaBy[id]?.owner || null, notes: metaBy[id]?.notes || null,
                active: lastBots.includes(id) };
        }).map(s => { const r = atlasRating(ratings, s.id); return r ? { ...s, rating: r.rating, ratingSe: r.se ?? null, ratingGames: r.games ?? null, ratedAs: r.as } : { ...s, rating: null }; })
            .sort((a, b) => (b.rating != null) - (a.rating != null) || (b.rating ?? 0) - (a.rating ?? 0) || b.elo - a.elo);
        for (const id in history) { const h = history[id]; if (h.length > 500) { const st = Math.ceil(h.length / 500); history[id] = h.filter((_, i) => i % st === 0 || i === h.length - 1); } }
        const ids = standings.map(s => s.id);
        const cell = (a, b) => { const c = h2h[`${a}|${b}`]; return a === b || !c ? null : { rate: +(c.s / c.n).toFixed(3), n: c.n }; };
        const last = runs.at(-1);
        return { games: n, errors, running, firstSeatWinRate: decided ? +(p1Wins / decided).toFixed(3) : null,
            runs: runs.map(t => ({ id: t.id, createdAt: t.createdAt, games: t.games.length, bots: t.bots })),
            current: last ? { id: last.id, done: last.games.filter(g => g.outcome !== 'running').length,
                total: last.gamesPerPairing && last.bots ? last.gamesPerPairing * last.bots.length * (last.bots.length - 1) / 2 : null } : null,
            standings, history, marks, h2h: { ids, matrix: ids.map(a => ids.map(b => cell(a, b))) }, recent: recent.slice(-14).reverse() };
    }


    // Per-bot decision speed. Prefers harness timing (index entry `timing.p1/p2` = {n, ms, p50, p95, max}),
    // falls back to a bot's self-reported botStats {windows, ms} (search bots), else nothing.
    function computePerf(runs, meta, ladderBots) {
        const metaBy = Object.fromEntries((meta || []).map(m => [m.id, m]));
        const per = {};
        const add = (bot, s, source) => { const b = (per[bot] ||= { id: bot, games: 0, n: 0, ms: 0, p50s: [], p95s: [], max: 0, sources: new Set(), samples: [] });
            b.games++; b.n += s.n; b.ms += s.ms; if (s.p50 != null) b.p50s.push(s.p50); if (s.p95 != null) b.p95s.push(s.p95); b.max = Math.max(b.max, s.max ?? 0); b.sources.add(source); b.samples.push(+(s.ms / s.n).toFixed(3)); };
        for (const r of runs) for (const g of r.games) {
            if (g.outcome === 'running') continue;
            ['p1', 'p2'].forEach((seat, i) => {
                const bot = g[seat]; if (!bot) return;
                const h = g.timing?.[seat];
                if (h && h.n > 0) return add(bot, h, 'harness');
                const st = g.botStats?.[i];
                if (st && st.ms != null && st.windows > 0) add(bot, { n: st.windows, ms: st.ms }, 'self-reported');
            });
        }
        const pct = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
        return Object.values(per).map(b => ({ id: b.id, lang: metaBy[b.id]?.lang || ladderBots?.[b.id]?.lang || 'js', kind: ladderBots?.[b.id]?.kind || metaBy[b.id]?.family || null,
            games: b.games, decisions: b.n, mean: b.n ? b.ms / b.n : null, p50: b.p50s.length ? pct(b.p50s, 0.5) : pct(b.samples, 0.5), p95: b.p95s.length ? pct(b.p95s, 0.95) : null,
            max: b.max || null, source: [...b.sources].join(' + '), samples: b.samples.slice(-200) })).sort((a, b) => (a.mean ?? 1e9) - (b.mean ?? 1e9));
    }

    const api = { loadSources, computeLeague, computePerf, pickLiveGame, liveCandidates, atlasRating };
    if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SWU = api;
})(typeof window !== 'undefined' ? window : globalThis);
