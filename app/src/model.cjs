// App data model. Shared by app/build.mjs (Node, reads the disk) and the page (reads project files live).
// Input: the research console's loader output (dashboard/site/core.cjs loadSources, reused read-only), plus the arena
// files, the Strategy Atlas model (meta/meta.json) and its ratings (meta/ratings.json) read by loadExtra below.
// Output: one model every page renders from.
// Bot identity follows the Strategy Atlas (meta/analyze.js canonical): random-a/b/c are one bot "random"; in runs
// made before the heuristic fix, heuristic is "legacy" and its profiles "legacy-aggro" etc. So ratings match the Atlas's.
(function (root) {
    const FAMILIES = ['search', 'learned', 'llm', 'heuristic', 'rules', 'random', 'other'];

    function guessFamily(id) {
        const s = String(id).toLowerCase();
        if (/^random|-random$|^py-random/.test(s)) return 'random';
        if (/ismcts|omni|pimc|mcts|search|alpha|minimax/.test(s)) return 'search';
        if (/learn|jepa|world|nn|net/.test(s)) return 'learned';
        if (/jev|llm|duel_|claude|opus|sonnet|haiku/.test(s)) return 'llm';
        if (/greedy|rush/.test(s)) return 'rules';
        if (/heur|tempo|aggro|control|legacy|clock|forecast/.test(s)) return 'heuristic';
        return 'other';
    }

    // ---------- identity (the Atlas's rule) ----------
    const HEURISTIC_PROFILES = new Set(['heuristic', 'aggro', 'tempo', 'control']);
    const FIXED_ERA_RUNS = new Set(['wasm-ladder-1', 'lisp-ladder-1']);
    // The Atlas's rule since 18:30 (meta/analyze.js canonical): runs made after the base-danger sign fix keep their
    // names; in older runs the heuristic is the old evaluation, so it is `legacy` and its profiles `legacy-aggro` etc.
    const FIX_ON_MAIN = Date.parse('2026-10-11T11:36:54Z');
    function canonical(name, fixedEra) {
        if (/^random(-[a-z])?$/.test(name)) return 'random';
        if (fixedEra || !HEURISTIC_PROFILES.has(name)) return name;
        return name === 'heuristic' ? 'legacy' : `legacy-${name}`;
    }

    // ---------- extra files: arena state and the Atlas model ----------
    async function loadExtra(reader) {
        const json = async p => { try { const t = await reader.text(p); return t ? JSON.parse(t) : null; } catch { return null; } };
        const roster = await json('arena/roster.json');
        const tournament = await json('arena/tournament.json');
        let standings = await json('arena/standings.json'), archived = null;
        const rounds = {};
        const readRounds = async dir => { for (const e of await reader.list(dir)) { const m = /^r(\d+)\.md$/.exec(e.name); if (m && !e.isDirectory) rounds[m[1]] = await reader.text(`${dir}/${e.name}`); } };
        await readRounds('arena/rounds');
        if (!standings || !(standings.rounds || []).length) {
            // nothing rated in the current tournament yet: show the last archived test tournament, clearly marked
            const old = await json('arena/archive/t0/standings.json');
            if (old) { standings = old; archived = 'Test tournament t0 (archived)'; await readRounds('arena/archive/t0/rounds'); }
        }
        const versions = {};
        for (const e of await reader.list('arena/versions')) {
            const m = /^([a-z][a-z0-9_]*)-v(\d+)$/.exec(e.name);
            if (!m || !e.isDirectory) continue;
            const s = await json(`arena/versions/${e.name}/SUBMISSION.json`);
            (versions[m[1]] ||= []).push({ v: +m[2], name: e.name, ...(s || {}) });
        }
        for (const k in versions) versions[k].sort((a, b) => a.v - b.v);
        // the Atlas model, slimmed to what the app draws
        const mj = await json('meta/meta.json');
        const meta = mj && Array.isArray(mj.bots) ? {
            generatedAt: mj.generatedAt, totals: mj.totals, situations: mj.situations, style: mj.style,
            fixedEra: Object.fromEntries((mj.sources || []).map(s => [s.run, !!s.fixedEra])),
            bots: mj.bots.map(b => ({ id: b.id, family: b.family, lang: b.lang, rating: b.rating, games: b.games, wins: b.wins, forfeits: b.forfeits || 0, replayGames: b.replayGames, msP50: b.msP50, style: b.style, summary: b.summary,
                situations: Object.fromEntries(Object.entries(b.situations || {}).map(([k, v]) => [k, { n: v.n, wins: v.wins, edge: v.edge, vsOwn: v.vsOwn, examples: (v.examples || []).slice(0, 2) }])) })),
        } : null;
        // ratings are written once, by the meta analyzer, with the Atlas's rules (Eric's pick, 18:21)
        const rj = await json('meta/ratings.json');
        const ratings = rj && rj.bots && typeof rj.bots === 'object' ? { generatedAt: rj.generatedAt || null, rules: rj.rules || null, bots: rj.bots } : null;
        return { arena: { roster, tournament, standings, archived, rounds, versions }, meta, ratings };
    }

    // ---------- ratings ----------
    // Bradley-Terry on the Elo scale (MM algorithm, prior 1, as bot/ratings.js), plus a standard error per bot.
    function bradleyTerry(names, results, { prior = 1, iters = 500, mean = 1500 } = {}) {
        const n = names.length, idx = new Map(names.map((x, i) => [x, i]));
        const wins = new Array(n).fill(prior / 2), pair = new Map();
        for (const g of results) {
            const i = idx.get(g.a), j = idx.get(g.b);
            wins[i] += g.score; wins[j] += 1 - g.score;
            const k = i < j ? i * n + j : j * n + i; pair.set(k, (pair.get(k) || 0) + 1);
        }
        const opp = Array.from({ length: n }, () => []);
        for (const [k, c] of pair) { const i = Math.floor(k / n), j = k % n; opp[i].push([j, c]); opp[j].push([i, c]); }
        let gamma = new Array(n).fill(1);
        for (let it = 0; it < iters; it++) {
            const next = gamma.map((gi, i) => { let d = prior / (gi + 1); for (const [j, c] of opp[i]) d += c / (gi + gamma[j]); return d > 0 ? wins[i] / d : gi; });
            let delta = 0; for (let i = 0; i < n; i++) delta = Math.max(delta, Math.abs(next[i] - gamma[i]));
            gamma = next; if (delta < 1e-10) break;
        }
        const S = 400 / Math.LN10, lg = gamma.map(g => S * Math.log(g)), shift = mean - lg.reduce((a, x) => a + x, 0) / (n || 1);
        const out = {};
        names.forEach((name, i) => {
            let info = prior * gamma[i] / (gamma[i] + 1) ** 2;
            for (const [j, c] of opp[i]) info += c * gamma[i] * gamma[j] / (gamma[i] + gamma[j]) ** 2;
            out[name] = { rating: Math.round(lg[i] + shift), se: Math.round(S / Math.sqrt(info || 1e-9)) };
        });
        return out;
    }

    function runKind(id) {
        if (/^arena-/.test(id)) return 'arena';
        if (/^karabast(-|$)/.test(id)) return 'people'; // our bots against people on karabast.net (the Karabast Sprite's feed)
        if (/eval|ismcts-evaluators|position|oracle/.test(id)) return 'study';
        if (/ladder|league|^demo$/.test(id)) return 'ladder';
        return 'test';
    }

    // ---------- the model ----------
    function buildModel(src, extra, core, opts = {}) {
        const runs = src.runs || [], metaRaw = extra?.meta || null;
        const about = {}; for (const a of src.about || []) for (const id of [a.id, ...(a.aliases || [])]) about[id] ||= a;
        const metaBy = Object.fromEntries((src.botMeta || []).map(m => [m.id, m]));
        const atlasBy = Object.fromEntries((metaRaw?.bots || []).map(b => [b.id, b]));
        const panelsByBot = {};
        for (const p of src.panels || []) for (const b of p.bots || []) panelsByBot[b] ||= p.id;

        const botIx = new Map(), botList = [];
        const bi = id => { if (!botIx.has(id)) { botIx.set(id, botList.length); botList.push(id); } return botIx.get(id); };
        const games = [], results = [], rec = {}, h2h = {}, lastSeen = {}, runsOf = {}, rawOf = {};
        const R = id => (rec[id] ||= { games: 0, w: 0, l: 0, d: 0, faults: 0, rounds: 0 });
        const runInfo = runs.map((r, ri) => {
            const names = new Set(r.bots || r.games.flatMap(g => [g.p1, g.p2]));
            const fixed = metaRaw?.fixedEra?.[r.id] ?? (names.has('legacy') || FIXED_ERA_RUNS.has(r.id) || (typeof r.fixedEra === 'boolean' ? r.fixedEra : Date.parse(r.createdAt) >= FIX_ON_MAIN));
            const can = n => { const c = canonical(n, fixed); (rawOf[c] ||= new Set()).add(n); return c; };
            const st = {}; let decided = 0, running = 0, errors = 0, abandoned = 0;
            // games against people show in the grid, the run and the game pages, and stay out of bot records and ratings
            // a run an outside feed sent (the window stamps `feed` on it) is never rated, whatever its name
            const kind = typeof r.feed === 'string' && r.feed ? 'people' : runKind(r.id), people = kind === 'people';
            // a person is never named: in a people run, a seat outside the run's own bots list (which names our bots) is "opponent"
            const ours = people ? [...new Set((r.bots || []).map(can))] : null;
            // (with no bots list the person cannot be told from our bot, so every seat is "opponent")
            const seat = n => people && !ours.includes(canonical(n, fixed)) ? 'opponent' : can(n);
            for (const g of r.games) {
                const p1 = seat(g.p1), p2 = seat(g.p2);
                let res, forfeit = null; // res: 0 p1 won, 1 p2 won, 2 draw, 3 running, 4 not rated, 5 abandoned (people only)
                if (g.outcome === 'running') { res = 3; running++; }
                else if (g.outcome === 'won' && (g.winnerSeat === 'p1' || g.winnerSeat === 'p2')) res = g.winnerSeat === 'p1' ? 0 : 1;
                else if (g.outcome === 'ERROR' && /^TIME_FORFEIT (\S+)/.test(g.error || '')) { forfeit = seat(RegExp.$1) === p1 ? 'p1' : 'p2'; res = forfeit === 'p1' ? 1 : 0; }
                else if (g.outcome === 'ERROR' && (g.by === 'p1' || g.by === 'p2')) { forfeit = g.by; res = g.by === 'p1' ? 1 : 0; }
                else if (g.winnerSeat === 'draw') { res = 2; errors++; }
                else { res = 4; errors++; }
                // a game against people that never started or went silent is abandoned, not an engine error
                if (people && res === 4 && g.outcome === 'abandoned') { res = 5; errors--; abandoned++; }
                games.push([ri, g.id, bi(p1), bi(p2), res, g.rounds ?? null, g.steps ?? null, forfeit ? 1 : 0]);
                if (people) {
                    // a finished game against a person, a draw included, counts in the run's own table only
                    if (res <= 2 && p1 && p2) {
                        decided++;
                        if (res === 2) errors--;
                        for (const [x, s] of [[p1, res === 0 ? 1 : res === 1 ? 0 : 0.5], [p2, res === 1 ? 1 : res === 0 ? 0 : 0.5]]) { const T = (st[x] ||= { w: 0, l: 0, d: 0 }); s === 1 ? T.w++ : s === 0 ? T.l++ : T.d++; }
                    }
                    continue;
                }
                if (res > 1 || !p1 || !p2) continue;
                decided++;
                const sa = res === 0 ? 1 : 0;
                results.push({ a: p1, b: p2, score: sa });
                for (const [x, y, s] of [[p1, p2, sa], [p2, p1, 1 - sa]]) {
                    const q = R(x); q.games++; q.rounds += g.rounds || 0; s === 1 ? q.w++ : q.l++;
                    const H = ((h2h[x] ||= {})[y] ||= [0, 0, 0]); H[s === 1 ? 0 : 1]++;
                    const T = (st[x] ||= { w: 0, l: 0, d: 0 }); s === 1 ? T.w++ : T.l++;
                    lastSeen[x] = r.createdAt; (runsOf[x] ||= new Set()).add(r.id);
                }
                if (forfeit) R(forfeit === 'p1' ? p1 : p2).faults++;
            }
            const table = Object.entries(st).filter(([id]) => !people || id !== 'opponent').map(([id, t]) => ({ id, ...t, n: t.w + t.l + t.d, pct: (t.w + t.d / 2) / Math.max(1, t.w + t.l + t.d) })).sort((a, b) => b.pct - a.pct || b.n - a.n);
            // a people run lists every seat (each person as "opponent"; its bots list may leave the people out), so its grid shows
            // before any game ends; `ours` keeps the run's own bots list, which names our bots and never the people
            const bots = [...new Set([...(r.bots || []).map(can), ...(people ? r.games.flatMap(g => [seat(g.p1), seat(g.p2)]) : []), ...table.map(t => t.id)])];
            const planned = r.gamesPerPairing && r.bots ? r.gamesPerPairing * r.bots.length * (r.bots.length - 1) / 2 : null;
            return { id: r.id, createdAt: r.createdAt, kind, fixedEra: fixed, bots, n: r.games.length, planned, decided, running, errors, ...(people ? { abandoned, ours } : {}), table, dir: r._dir, gamesPerPairing: r.gamesPerPairing ?? null };
        });

        // the Atlas's ratings when the meta analyzer wrote them; the app's own fit (same rules) for bots it does not list
        const own = bradleyTerry(Object.keys(rec), results), atlasR = extra?.ratings?.bots || {};
        const bt = Object.fromEntries(Object.keys(rec).map(id => [id, Number.isFinite(atlasR[id]?.rating) ? { rating: atlasR[id].rating, se: atlasR[id].se ?? own[id].se, from: 'atlas' } : { ...own[id], from: 'app' }]));
        // form: sequential Elo (K 24) in run order, sampled to about 48 points per bot
        const elo = {}, form = {};
        for (const g of results) {
            const ra = elo[g.a] ?? 1500, rb = elo[g.b] ?? 1500, ea = 1 / (1 + 10 ** ((rb - ra) / 400));
            elo[g.a] = ra + 24 * (g.score - ea); elo[g.b] = rb - 24 * (g.score - ea);
            (form[g.a] ||= [1500]).push(Math.round(elo[g.a])); (form[g.b] ||= [1500]).push(Math.round(elo[g.b]));
        }
        let perf = [];
        try { const ladderBots = Object.assign({}, ...runs.map(r => Object.fromEntries((r._bots || []).map(b => [b.id || b.name, b])))); perf = core?.computePerf ? core.computePerf(runs, src.botMeta, ladderBots) : []; } catch { perf = []; }
        const perfBy = Object.fromEntries(perf.map(p => [p.id, p]));

        const ids = [...new Set([...Object.keys(rec), ...Object.keys(about).filter(id => !/^random-[a-z]$/.test(id) && id !== 'legacy')])];
        const bots = {};
        for (const id of ids) {
            const raw = [...(rawOf[id] || [id])], a = about[id] || about[raw[0]], m = metaBy[id] || metaBy[raw[0]], x = atlasBy[id], q = rec[id] || { games: 0, w: 0, l: 0, d: 0, faults: 0, rounds: 0 };
            const fam0 = a?.family || m?.family || x?.family;
            const fam = FAMILIES.includes(fam0) ? fam0 : guessFamily(id);
            const f = form[id] || [], step = Math.max(1, Math.ceil(f.length / 48));
            // timing is per raw name; a pre-fix twin (legacy, legacy-aggro...) shares its raw name with the fixed bot,
            // so it only gets timing of its own, never the fixed bot's (else Speed lists the same numbers twice)
            const p = perfBy[id] || (/^legacy(-|$)/.test(id) ? null : raw.map(r => perfBy[r]).filter(Boolean).sort((u, v) => (v.decisions || 0) - (u.decisions || 0))[0]);
            bots[id] = {
                id, fam, lang: a?.lang || m?.lang || x?.lang || null, owner: a?.owner || m?.owner || null,
                line: a?.oneLine || m?.notes || null, card: a || null,
                rating: bt[id]?.rating ?? null, se: bt[id]?.se ?? null, ratingFrom: bt[id]?.from || null, atlasRating: x?.rating ?? null,
                form: f.filter((_, i) => i % step === 0 || i === f.length - 1),
                ...q, winRate: q.games ? (q.w + q.d / 2) / q.games : null,
                lastSeen: lastSeen[id] || null, runs: [...(runsOf[id] || [])],
                speed: p ? { mean: p.mean, p50: p.p50 ?? null, p95: p.p95 ?? null, n: p.decisions, src: p.source || null, lang: p.lang } : null,
                panel: a?.panel || panelsByBot[id] || panelsByBot[raw[0]] || null,
                // the Atlas record (spots, style) lives once in research.atlas.byId; the bot keeps a short summary
                atlas: x ? { style: x.summary?.style || null, best: x.summary?.best || null, worst: x.summary?.worst || null, forfeits: x.forfeits, replayGames: x.replayGames, mapped: x.games >= 8 && x.replayGames >= 5 } : null,
            };
        }
        const order = Object.values(bots).filter(b => b.rating != null).sort((a, b) => b.rating - a.rating).map(b => b.id);
        order.forEach((id, i) => { bots[id].rank = i + 1; });
        const lastRun = runInfo.at(-1);
        for (const id of lastRun?.bots || []) if (bots[id]) bots[id].active = true;

        // arena
        const A = extra?.arena || {};
        const T = A.tournament, cur = T?.rounds?.at(-1) || null;
        const phase = !T ? 'idle' : T.state === 'done' ? 'done' : cur?.ladderStart && !cur?.ladderEnd ? 'ladder' : 'work';
        // benched builders (arena withdraw) stay listed, marked, with their versions and panels; rejoin brings them back
        const competitors = [...(A.roster?.agents || []), ...(A.roster?.bench || []).map(a => ({ ...a, benched: true }))].map(a => {
            const vs = A.versions?.[a.name] || [];
            const panel = (src.panels || []).find(p => p.id === `arena-${a.name}`) || null;
            return { name: a.name, title: a.title, harness: a.harness || null, philosophy: a.philosophy || '', start: a.start, registeredAt: a.registeredAt, versions: vs, latest: vs.at(-1)?.name || null, panel, ...(a.benched ? { benched: true } : {}) };
        });
        const arena = {
            phase, tournament: T ? { id: T.id, title: T.title, task: T.task, plannedRounds: T.plannedRounds, roundMinutes: T.roundMinutes, rounds: T.rounds, rules: T.rules ?? A.standings?.tournament?.rules ?? null } : null,
            current: cur, deadline: phase === 'work' ? cur?.workEnd : null,
            competitors, baselines: A.roster?.baselines || [], thinkCapMs: A.roster?.thinkCapMs ?? null,
            standings: A.standings || null, archived: A.archived || null, reports: A.rounds || {}, runs: runInfo.filter(r => r.kind === 'arena').map(r => r.id),
        };

        // research: Lean findings and the Atlas
        const Atlas = root.SWUAtlas;
        const research = { theory: src.theory || null, atlas: Atlas && metaRaw ? Atlas.build(metaRaw) : null };
        research.famSpots = famSpots(metaRaw, bots);
        research.findings = findings(src.theory, bots, research.famSpots);

        // what's new: one feed from timestamps
        const feed = [];
        for (const r of runInfo.slice(-12)) feed.push({ t: r.createdAt, kind: 'run', run: r.id, text: r.kind === 'people' ? `Vs people ${r.id}: ${r.decided} games finished${r.running ? `, ${r.running} playing` : ''}` : `${r.kind === 'arena' ? 'Arena round' : r.kind === 'study' ? 'Study' : r.kind === 'ladder' ? 'Ladder' : 'Test'} ${r.id}: ${r.bots.length} bots, ${r.decided} of ${r.planned || r.n} games rated${r.running ? `, ${r.running} playing` : ''}` });
        for (const e of src.experiments || []) feed.push({ t: e.updatedAt || e.startedAt, kind: 'experiment', id: e.id, text: `${e.title}: ${e.status}${e.conclusion ? `. ${String(e.conclusion).slice(0, 140)}` : ''}` });
        for (const p of src.panels || []) { const th = (p.thoughts || []).at(-1); if (th) feed.push({ t: th.t || p.updatedAt, kind: 'thought', panel: p.id, title: p.title, text: th.text }); }
        for (const a of src.about || []) if (a.updatedAt) feed.push({ t: a.updatedAt, kind: 'card', bot: a.id, text: `${a.id}: bot card ${a.source === 'owner' ? 'updated by its builder' : 'drafted'}` });
        feed.sort((a, b) => String(b.t).localeCompare(String(a.t)));

        return {
            schema: 'swu-app/0', builtAt: opts.builtAt || new Date().toISOString(),
            totals: { games: games.length, rated: results.length, runs: runInfo.filter(r => r.kind !== 'people').length, bots: order.length },
            ratings: extra?.ratings ? { from: 'meta/ratings.json', generatedAt: extra.ratings.generatedAt, rules: extra.ratings.rules } : { from: 'app', generatedAt: null, rules: null },
            bots, order, h2h, botList, games, runs: runInfo, arena, research,
            experiments: src.experiments || [], panels: src.panels || [], evals: (src.evals || []).map(e => ({ gameId: e.gameId, tournament: e.tournament, replay: e.replay, p1: e.p1, p2: e.p2, winner: e.winner, evaluator: e.evaluator, n: (e.points || []).length })),
            threads: src.threads?.threads || [], warnings: src.warnings || [], feed: feed.slice(0, 40),
        };
    }

    // each family group's mean skill in a spot relative to its own level (vsOwn), bots with 5+ games there
    function famSpots(meta, bots) {
        if (!meta?.bots) return null;
        const grp = id => { const f = bots[id]?.fam || meta.bots.find(b => b.id === id)?.family; return f === 'search' ? 'search' : f === 'heuristic' || f === 'rules' ? 'onePly' : f === 'learned' ? 'learned' : null; };
        const out = {};
        for (const s of meta.situations || []) {
            const acc = {};
            for (const b of meta.bots) { const c = b.situations?.[s.id], g = grp(b.id); if (g && c && c.n >= 5 && c.vsOwn != null) (acc[g] ||= []).push(c.vsOwn); }
            out[s.id] = Object.fromEntries(Object.entries(acc).map(([g, v]) => [g, { mean: v.reduce((a, x) => a + x, 0) / v.length, bots: v.length }]));
        }
        return out;
    }

    const EVNAME = { const: 'Constant', old: 'Old heuristic', fixed: 'Fixed heuristic', results: 'Results fit', td: 'TD fit', hybrid: 'Hybrid' };
    const evName = id => EVNAME[id] || id;
    const pct = v => v == null ? '-' : `${Math.round(v * 100)}%`;
    const pts = v => v == null ? '-' : `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v * 100))}`;

    // The console's six findings (dashboard/site/template.html researchFindings), same tests on the same files.
    function findings(T, bots, fam) {
        const F = [], ev = Object.fromEntries((T?.evaluators || []).map(e => [e.id, e]));
        const td = ev.td, fx = ev.fixed;
        if (td?.byLeft?.length > 1) {
            const a = td.byLeft[0], z = td.byLeft.at(-1), grows = z.brier - a.brier > 0.05;
            F.push({ v: grows ? 'partly' : 'open', label: grows ? 'Consistent, indirect' : 'Unclear', src: 'residual_bound · tdLoss_bound',
                claim: 'Evaluator error grows the further a position is from the end',
                proof: 'If each one-step check is off by at most ε, the true error is at most ε × (moves left + 1).',
                data: `TD fit: Brier ${a.brier.toFixed(2)} near the end, ${z.brier.toFixed(2)} far from it${fx?.byLeft?.length ? `; fixed heuristic ${fx.byLeft[0].brier.toFixed(2)} to ${fx.byLeft.at(-1).brier.toFixed(2)}` : ''}. Any evaluator gets easier near the end, so this agrees with the bound but does not test it.`,
                bars: [...td.byLeft].reverse().map(b => ({ t: `${b.lo}${b.hi ? `–${b.hi}` : '+'} left`, v: b.brier })), scale: [0, 0.4], fmt: 'dec' });
        }
        if (fam) {
            const avg = (spots, g) => { const v = spots.map(s => fam[s]?.[g]?.mean).filter(x => x != null); return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null; };
            const sN = avg(['kill_range', 'low_base'], 'search'), oN = avg(['kill_range', 'low_base'], 'onePly'), sA = avg(['board_ahead', 'base_ahead'], 'search'), sB = avg(['board_behind'], 'search');
            if (sN != null && oN != null) {
                const seen = sN - oN >= 0.03;
                F.push({ v: seen ? 'partly' : 'open', label: seen ? 'Lead, small sample' : 'Not seen yet', src: 'search_exact · search_error',
                    claim: 'Search helps most where it can see the end', spots: ['kill_range', 'low_base', 'board_behind'],
                    proof: 'A search that reaches finished games returns the true value whatever the evaluator.',
                    data: `Against their own level, search bots score ${pts(sN)} pts in Lethal range and Near death, ${pts(sA)} when ahead, but ${pts(sB)} in Board behind; 1-ply bots ${pts(oN)} near the end.`,
                    bars: [{ t: 'Search, near the end', v: sN, fam: 'search' }, { t: '1-ply, near the end', v: oN, fam: 'heuristic' }, { t: 'Search, board behind', v: sB, fam: 'search' }], scale: [-0.1, 0.1], fmt: 'pts' });
            }
        }
        if (ev.const && T.evaluators.length > 2) {
            const E = T.evaluators, tdMin = E.reduce((a, e) => e.tdLoss < a.tdLoss ? e : a), acc = E.reduce((a, e) => (e.provenAcc ?? -1) > (a.provenAcc ?? -1) ? e : a);
            const holds = tdMin.id === 'const' && (ev.const.provenAcc ?? 1) < (acc.provenAcc ?? 0);
            F.push({ v: holds ? 'holds' : 'partly', label: holds ? 'Holds' : 'Partly', src: 'tdLoss_needs_closure · outcome_target_bias',
                claim: 'TD loss alone cannot judge an evaluator',
                proof: 'Without every position’s successors in the data, a constant evaluator has zero TD loss.',
                data: `Lowest TD loss: ${evName(tdMin.id)} (${tdMin.tdLoss.toFixed(4)}), right on only ${pct(ev.const.provenAcc)} of ${acc.provenN} solver-proven endgames. ${evName(acc.id)} is right most often there (${pct(acc.provenAcc)}). Judge evaluators by real endings.`,
                bars: [...E].sort((a, b) => b.provenAcc - a.provenAcc).map(e => ({ t: evName(e.id), v: e.provenAcc })), scale: [0.5, 1], fmt: 'pct' });
        }
        const rt = id => bots[id]?.rating;
        if (rt('omni') && rt('omni-blind')) {
            const d = rt('omni') - rt('omni-blind');
            F.push({ v: d > 0 ? 'partly' : 'open', label: d > 0 ? 'Consistent, indirect' : 'Not seen', src: 'omniscience_bias',
                claim: 'Seeing the hidden cards is worth something',
                proof: 'Choosing after seeing hidden cards is worth at least as much as choosing blind.',
                data: `The same search with and without hidden cards: omni ${rt('omni')}, omni-blind ${rt('omni-blind')} (${d > 0 ? '+' : ''}${d} for seeing).`,
                botsShown: ['omni', 'omni-blind', 'omni-d1-blind'].filter(rt) });
        }
        const top = g => Object.values(bots).filter(b => b.rating != null && b.games >= 20 && (g === 'search' ? b.fam === 'search' : b.fam === 'heuristic' || b.fam === 'rules')).sort((a, b) => b.rating - a.rating)[0];
        const o = top('onePly'), s = top('search');
        if (o && s) {
            const ok = o.rating >= s.rating - 50;
            F.push({ v: ok ? 'partly' : 'open', label: ok ? 'Consistent, indirect' : 'Not seen', src: 'greedy_regret · search_value',
                claim: 'One move of lookahead is enough with a good score',
                proof: 'Greedy 1-ply play with an ε-accurate evaluator loses at most 2ε per remaining move.',
                data: `Best 1-ply bot: ${o.id} at ${o.rating}. Best search bot: ${s.id} at ${s.rating}.`, botsShown: [o.id, s.id] });
        }
        F.push({ v: 'open', label: 'Not tested yet', src: 'rescore_flips_lottery · maximin_le_minimax',
            claim: 'Calibration at shuffles, and the second responder',
            proof: 'With shuffles a score must be calibrated (a straight line in win chance); answering a simultaneous prompt second is worth at least as much as answering first.',
            data: 'Needs positions where two scores with the same ranking pick different moves before a shuffle, and resource-prompt games with the answer order swapped.' });
        return F;
    }

    /** A replay step's board, cut to what a small live board needs: round, initiative, and per side base [hp, damage],
     *  hand size, resources [ready, total], leader deployed, ground and space units as [power, hp, damage]. */
    function slimState(st) {
        if (!st?.players) return null;
        const side = p => ({ b: [p?.base?.hp ?? 0, p?.base?.d ?? 0], h: Array.isArray(p?.hand) ? p.hand.length : (p?.hand || 0), r: [p?.res?.ready ?? 0, p?.res?.total ?? 0], l: p?.leader?.dep ? 1 : 0,
            g: (p?.ground || []).map(u => [u.p || 0, u.h || 0, u.d || 0]), s: (p?.space || []).map(u => [u.p || 0, u.h || 0, u.d || 0]) });
        return { r: st.round ?? 0, i: st.initiative || null, p1: side(st.players.p1), p2: side(st.players.p2) };
    }
    /** Back to the replay shape the Atlas spot rules read (base hp and d, unit power, hand size). */
    function fullState(f) {
        const side = x => ({ base: { hp: x.b[0], d: x.b[1] }, hand: x.h, ground: x.g.map(u => ({ p: u[0], h: u[1], d: u[2] })), space: x.s.map(u => ({ p: u[0], h: u[1], d: u[2] })) });
        return { round: f.r, players: { p1: side(f.p1), p2: side(f.p2) } };
    }

    // ---------- the public build (Eric's pick 6): everything except Lab and which thread built what ----------
    function publicPanel(p) { if (!p) return p; const { thread, ...rest } = p; return rest; }
    function publicModel(M) {
        const bots = Object.fromEntries(Object.entries(M.bots).map(([id, b]) => [id, { ...b, owner: null, card: b.card ? { ...b.card, owner: null } : null }]));
        return {
            ...M, bots, threads: [], warnings: [], panels: M.panels.map(publicPanel), experiments: M.experiments.map(({ owner, ...e }) => e),
            arena: { ...M.arena, competitors: M.arena.competitors.map(c => ({ ...c, panel: publicPanel(c.panel) })) },
        };
    }

    const api = { loadExtra, buildModel, bradleyTerry, guessFamily, canonical, FAMILIES, evName, slimState, fullState, publicModel, publicPanel };
    if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SWUApp = api;
})(typeof window !== 'undefined' ? window : globalThis);
