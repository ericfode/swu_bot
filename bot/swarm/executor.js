'use strict';
/**
 * The swarm tab's executor (bot/swarm/README.md, spec/executor.md): a dedicated worker the swarm page starts. It says
 * hello, keeps one claim open per slot, and plays each seed it gets in referee workers (referee-worker.js), one game
 * per worker, then posts the results. Being a worker, its timers are not throttled when the tab is hidden.
 *
 * From the page: {t: 'start', api: '/api/swarm', files: {referee, bot, pack, pythonLib, pythonWasm}, build, cards, slots},
 * {t: 'stop'}, {t: 'hidden', hidden}. To the page: {t: 'state', phase, note}, {t: 'hello', name, slots},
 * {t: 'lease', slot, lease, seed, games}, {t: 'step', lease, game, step}, {t: 'game', lease, game, result},
 * {t: 'done', lease, secs, results} and {t: 'failed', lease, why}, {t: 'log', level, text}.
 *
 * A seed ends in a result only when the browser had nothing to do with how it ended: a bot that ran out of time or
 * hung, a sleep of the computer (the wall clock moved more than the monotonic one), or a game past the lease's gameMs
 * ends the seed as {failed}, and the games machine plays it itself.
 */
(function executor() {
    const post = (m) => self.postMessage(m);
    const log = (text, level = 'info') => post({ t: 'log', level, text: String(text).slice(0, 500) });
    let cfg = null;
    let running = false;
    let timing = null;
    const BACKOFF = [5000, 10000, 20000, 40000, 60000];
    const SLEPT_MS = 20000;

    async function call(method, path, body, { timeoutMs = 60000, raw = false } = {}) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        try {
            const r = await fetch(`${cfg.api}${path}`, {
                method, credentials: 'same-origin', signal: ctl.signal,
                headers: { 'x-swarm-build': cfg.build, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
                body: body === undefined ? undefined : JSON.stringify(body)
            });
            const out = { status: r.status };
            if (raw) {
                out.bytes = r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
            } else {
                const text = await r.text();
                try {
                    out.body = text ? JSON.parse(text) : null;
                } catch {
                    out.body = null;
                }
            }
            return out;
        } catch (e) {
            return { status: 0, error: String(e?.message ?? e) };
        } finally {
            clearTimeout(timer);
        }
    }

    // --- referee workers: each loads the engine once and plays one game at a time

    const idle = [];
    const waiting = [];
    let made = 0;
    let packBytes = null;
    function newReferee() {
        const w = new Worker(cfg.files.referee);
        made++;
        const ref = { w, ready: null, job: null };
        ref.ready = new Promise((resolve, reject) => {
            w.onmessage = (e) => {
                const m = e.data;
                if (m.t === 'ready') {
                    resolve(m);
                } else if (m.t === 'error' && !ref.job) {
                    reject(new Error(m.message));
                } else {
                    ref.job?.(m);
                }
            };
            w.onerror = (e) => {
                const err = new Error(e.message || 'the referee worker failed');
                reject(err);
                ref.job?.({ t: 'error', message: err.message });
            };
        });
        // the pack is fetched once per tab, and each referee gets a copy of its bytes
        packBytes ??= fetch(cfg.files.pack).then((r) => {
            if (!r.ok) {
                throw new Error(`the engine pack did not load (${r.status})`);
            }
            return r.arrayBuffer();
        });
        packBytes.then((bytes) => w.postMessage({ t: 'init', packBytes: bytes, botWorker: cfg.files.bot, pythonLib: cfg.files.pythonLib, pythonWasm: cfg.files.pythonWasm }), (e) => {
            w.onerror?.({ message: e.message });
        });
        return ref;
    }
    function takeReferee() {
        if (idle.length) {
            return Promise.resolve(idle.pop());
        }
        if (made < cfg.slots * 2) {
            return Promise.resolve(newReferee());
        }
        return new Promise((resolve) => waiting.push(resolve));
    }
    // a worker that failed or ran late is stopped, and one that waits for a worker gets a fresh one
    function giveBack(ref, broken) {
        if (broken) {
            ref.w.terminate();
            made--;
        }
        const next = waiting.shift();
        if (next) {
            next(broken ? newReferee() : ref);
        } else if (!broken) {
            idle.push(ref);
        }
    }

    /** Plays one game in a referee worker: {result, replay} or throws. Stops the worker at the deadline. */
    async function playGame(leaseId, job, game, bundles, deadline) {
        const ref = await takeReferee();
        let broken = false;
        try {
            await ref.ready;
            return await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    broken = true;
                    reject(new Error(`the game ran past ${Math.round(job.gameMs / 1000)} s`));
                }, Math.max(1000, deadline - Date.now()));
                ref.job = (m) => {
                    if (m.t === 'step') {
                        post({ t: 'step', lease: leaseId, game: game.id, step: m.step });
                    } else if (m.t === 'result') {
                        clearTimeout(timer);
                        resolve({ result: m.result, replay: m.replay });
                    } else if (m.t === 'error') {
                        clearTimeout(timer);
                        broken = true;
                        reject(new Error(m.message.split('\n')[0]));
                    }
                };
                ref.w.postMessage({ t: 'play', job, game: game.id, bundles });
            });
        } catch (e) {
            broken = true;
            throw e;
        } finally {
            ref.job = null;
            giveBack(ref, broken);
        }
    }

    // --- leases

    const ticks = () => ({ wall: Date.now(), mono: performance.now() });
    const slept = (a, b) => Math.abs(b.wall - a.wall - (b.mono - a.mono)) > SLEPT_MS;

    const active = new Set();

    async function runLease(slot, lease) {
        const t0 = performance.now();
        const { job } = lease;
        active.add(lease.lease);
        post({ t: 'lease', slot, lease: lease.lease, seed: job.seed, games: job.games });
        let gone = false;
        let tick = ticks();
        let sleptOnce = false;
        const beat = async () => {
            const now = ticks();
            if (slept(tick, now)) {
                sleptOnce = true;
            }
            tick = now;
            const r = await call('POST', `/lease/${encodeURIComponent(lease.lease)}/heartbeat`, {}, { timeoutMs: 20000 });
            if (r.status === 410) {
                gone = true;
            }
        };
        await beat();
        const heart = setInterval(beat, timing.heartbeatMs);
        const finish = async (body, summary) => {
            clearInterval(heart);
            if (!active.delete(lease.lease)) {
                return; // the tab left the swarm and handed it back already
            }
            if (gone) {
                post({ t: 'failed', lease: lease.lease, why: 'the games machine took the seed back' });
                return;
            }
            const r = await call('POST', `/lease/${encodeURIComponent(lease.lease)}/result`, body, { timeoutMs: 120000 });
            if (body.failed) {
                post({ t: 'failed', lease: lease.lease, why: body.failed });
            } else if (r.status === 200) {
                post({ t: 'done', lease: lease.lease, secs: Math.round((performance.now() - t0) / 1000), results: summary });
            } else {
                post({ t: 'failed', lease: lease.lease, why: `the result was not taken (${r.status || r.error})` });
            }
        };
        try {
            const bundles = {};
            // the machine lists a lease's bundles as {id, bytes} (coord Remote); a bare id is taken too
            const hexes = (lease.bundles ?? []).map((b) => (typeof b === 'string' ? b : b?.id)).filter((h) => /^[0-9a-f]{64}$/.test(String(h)));
            if (hexes.length !== (lease.bundles ?? []).length) {
                throw new Error('the lease names a bundle this tab cannot read');
            }
            for (const hex of hexes) {
                const r = await call('GET', `/bundle/${hex}`, undefined, { raw: true, timeoutMs: 120000 });
                if (!r.bytes) {
                    throw new Error(`bundle ${hex.slice(0, 12)} did not download (${r.status || r.error})`);
                }
                bundles[hex] = r.bytes;
            }
            const deadline = Date.now() + (job.gameMs || 1800000);
            const played = await Promise.all(job.games.map((g) => playGame(lease.lease, job, g, bundles, deadline).then((x) => {
                post({ t: 'game', lease: lease.lease, game: g.id, result: x.result });
                return { id: g.id, ...x };
            })));
            const late = played.find((x) => x.result?.faultKind === 'time' || x.result?.faultKind === 'hang');
            if (sleptOnce || slept(tick, ticks())) {
                return finish({ failed: 'the computer slept' });
            }
            if (late) {
                return finish({ failed: `${late.id}: a bot ran out of time in a browser tab (${late.result.faultKind}); the games machine plays the seed` });
            }
            const replays = {};
            for (const x of played) {
                if (x.replay) {
                    replays[x.id] = x.replay;
                }
            }
            return finish({ results: played.map((x) => ({ id: x.id, result: x.result })), replays }, played.map((x) => ({ id: x.id, outcome: x.result.outcome, winner: x.result.winner, winnerSeat: x.result.winnerSeat, steps: x.result.steps, round: x.result.round })));
        } catch (e) {
            return finish({ failed: String(e?.message ?? e).slice(0, 300) });
        }
    }

    async function slotLoop(slot) {
        let backoff = 0;
        while (running) {
            const r = await call('POST', '/claim', { slot: String(slot) }, { timeoutMs: (timing.claimMs || 25000) + 15000 });
            if (!running) {
                break;
            }
            if (r.status === 200 && r.body?.lease) {
                backoff = 0;
                await runLease(slot, r.body);
            } else if (r.status === 204) {
                backoff = 0;
            } else if (r.status === 409) {
                running = false;
                post({ t: 'state', phase: 'stale', note: 'the games machine runs a new build: reload the page' });
            } else if (r.status === 401 || r.status === 403) {
                running = false;
                post({ t: 'state', phase: 'stopped', note: 'not signed in, or not invited' });
            } else {
                const ms = BACKOFF[Math.min(backoff++, BACKOFF.length - 1)];
                post({ t: 'state', phase: 'nomachine', note: `no answer from the games machine (${r.status || r.error}); trying again in ${ms / 1000} s` });
                await new Promise((resolve) => setTimeout(resolve, ms));
            }
        }
    }

    async function start(msg) {
        cfg = msg;
        running = true;
        post({ t: 'state', phase: 'connecting', note: 'saying hello to the games machine' });
        for (let k = 0; running; k++) {
            const r = await call('POST', '/hello', { build: cfg.build, cards: cfg.cards, slots: cfg.slots });
            if (r.status === 200 && r.body?.ok) {
                timing = r.body;
                post({ t: 'hello', name: r.body.name, slots: cfg.slots });
                post({ t: 'state', phase: 'connected', note: '' });
                break;
            }
            if (r.status === 409) {
                post({ t: 'state', phase: 'stale', note: 'the games machine runs a new build: reload the page' });
                return;
            }
            const ms = BACKOFF[Math.min(k, BACKOFF.length - 1)];
            post({ t: 'state', phase: 'nomachine', note: `the games machine does not answer (${r.status || r.error}); trying again in ${ms / 1000} s` });
            await new Promise((resolve) => setTimeout(resolve, ms));
        }
        for (let i = 1; i <= cfg.slots; i++) {
            slotLoop(i);
        }
        // the first referee loads the engine while the slots wait for seeds
        takeReferee().then((ref) => giveBack(ref, false));
    }

    self.onmessage = (e) => {
        const m = e.data;
        if (m.t === 'start' && !running) {
            start(m).catch((err) => log(err?.stack ?? err, 'error'));
        } else if (m.t === 'stop') {
            running = false;
            // the seeds in play go back at once, not after a missed heartbeat
            const held = [...active];
            active.clear();
            Promise.all(held.map((id) => call('POST', `/lease/${encodeURIComponent(id)}/result`, { failed: 'the tab left the swarm' }, { timeoutMs: 3000 }))).finally(() => {
                post({ t: 'state', phase: 'stopped', note: 'stopped: seeds in play went back to the games machine' });
            });
        }
    };
})();
