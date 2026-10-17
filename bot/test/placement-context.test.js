'use strict';
// Portable metadata-only contract tests. Copy into bot/test or set SWU_BOUNDARY_REPO to the integrated checkout.
// Canonical tar hashing runs the repository's trusted Python utility; no checker, bot, engine or game runner runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(process.env.SWU_BOUNDARY_REPO ?? path.join(__dirname, '..', '..'));

function fixtureCase(which) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swu-v2-placement-context-'));
    const write = (file, data) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
    };
    Object.assign(process.env, { ARENA_ID: 'v2', ARENA_HOME: path.join(dir, 'arena'), ARENA_RESULTS: path.join(dir, 'results'),
        ARENA_DASH: path.join(dir, 'dash'), GAMES_DATA: path.join(dir, 'games'), GAMES_PLACEMENT_MODE: 'immediate' });
    delete process.env.SWU_WINDOW;
    try {
        const required = (name) => {
            const file = path.join(REPO, 'bot', 'arena', name);
            assert.ok(fs.existsSync(file), `missing integrated API: ${file}`);
            return require(file);
        };
        const identity = required('identity.js');
        for (const name of ['comparisonContext', 'contextMatches', 'contextProblem', 'contextFor']) {
            assert.equal(typeof identity[name], 'function', `missing identity.${name} API`);
        }
        let current = { schema: 1, arenaId: 'v2', protocol: 2, engineRevision: 'e'.repeat(64), runnerRevision: 'swu-arena-v2/1' };
        // Image revision files may be absent in a source checkout. Only their trusted identity reader is substituted.
        identity.comparisonContext = () => current === null ? null : structuredClone(current);
        const compatibility = required('compatibility.js');
        for (const name of ['bundleDigest', 'currentCheckerBuild']) assert.equal(typeof compatibility[name], 'function', `missing compatibility.${name} API`);
        assert.equal(typeof compatibility.SCHEMA, 'string', 'missing compatibility.SCHEMA API');
        const home = required('home.js');
        const placement = which === 'identity' || which.startsWith('global-') ? null : required('placement.js');
        if (placement) for (const name of ['enqueue', 'reserve', 'statuses']) assert.equal(typeof placement[name], 'function', `missing placement.${name} API`);
        const checkerBuild = compatibility.currentCheckerBuild();
        assert.match(checkerBuild ?? '', /^[0-9a-f]{40}$/, 'the fixture needs a real checkout/image checker build');
        const refOf = (v) => `window:boundary-${v}`;
        const metaFile = (v) => path.join(home.VERSIONS, v, 'SUBMISSION.json');
        const metaOf = (v) => JSON.parse(fs.readFileSync(metaFile(v), 'utf8'));
        const putMeta = (v, change) => write(metaFile(v), change(metaOf(v)));
        const digests = {};
        write(home.ROSTER, { arenaId: 'v2', arena: 'v2', requiredProtocol: 2, thinkCapMs: 60000, baselines: [], agents: [
            { name: 'alice', owner: 'github:boundary-alice' }, { name: 'house', owner: 'arena', resident: true }
        ] });

        function version(agent, n = 1) {
            const v = `${agent}-v${n}`;
            const bundle = path.join(home.VERSIONS, v, 'bundle');
            write(path.join(bundle, 'arena.json'), { schema: 'swu-arena-bot/1', protocol: 2, kind: 'wasm',
                platform: 'wasm32-wasip1', runtime: 'wasi-p1', run: { cmd: './bot.wasm' }, network: 'none' });
            // Inert bytes, only hashed. An attempted load of the adjacent sentinel also fails visibly.
            write(path.join(bundle, 'bot.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, n]));
            write(path.join(bundle, 'fixture-identity.txt'), `${agent}:${n}\n`);
            write(path.join(home.VERSIONS, v, 'bot.js'), 'throw new Error("boundary fixture bot must never execute");\n');
            const digest = compatibility.bundleDigest(bundle);
            digests[v] = digest;
            write(metaFile(v), { name: v, agent, version: n, arenaId: 'v2', checked: true, bot: { kind: 'wasm' },
                ref: refOf(v), submittedAt: '2026-10-17T00:00:00.000Z', bundleSha256: digest,
                compatibility: { schema: compatibility.SCHEMA, negotiatedProtocol: 2, bundleSha256: digest,
                    checkerBuild, checkedAt: '2026-10-17T00:00:00.000Z', context: structuredClone(current) } });
            return v;
        }
        const target = version('alice');
        const house = version('house');
        const enqueue = (v = target) => placement.enqueue({ version: v, ref: refOf(v) });
        let prepared = 0;
        const makeSpec = (round, job) => {
            prepared++;
            return { round, arena: 'v2', requiredProtocol: 2, context: structuredClone(current),
                bots: [job.version, ...job.opponents], gamesPerPair: 2, capMs: 60000, decks: null,
                bundles: Object.fromEntries([job.version, ...job.opponents].map((v) => [v, digests[v]])),
                botInfo: Object.fromEntries([job.version, ...job.opponents].map((v) => [v, { kind: 'arena', lang: 'wasm' }])) };
        };
        const reserve = (round = 100) => placement.reserve(round, (job) => makeSpec(round, job));
        const rows = (count = 30) => Array.from({ length: count }, (_, seed) => [[target, house], [house, target]].map(([p1, p2], seat) => ({
            id: `${seed}-${seat}`, p1, p2, seed, outcome: 'won', winnerSeat: 'draw', requiredProtocol: 2, protocols: { p1: 2, p2: 2 },
            context: structuredClone(current), bundles: { [target]: digests[target], [house]: digests[house] }
        }))).flat();
        function history(games, transform = (x) => x, round = 0, prior = []) {
            const ladderId = identity.ladderId(round);
            const ladder = transform({ id: ladderId, arena: 'v2', status: 'done', config: { arena: 'v2', requiredProtocol: 2,
                context: structuredClone(current), bots: [target, house], bundles: { ...digests }, gamesPerPair: games.length,
                firstSeed: 0, capMs: 60000 }, games, progress: { scheduled: games.length, finished: games.length } });
            write(path.join(home.RESULTS, ladderId, 'ladder.json'), ladder);
            const rd = { round, ladderId, arena: 'v2', arenaId: 'v2', requiredProtocol: 2, context: ladder.config.context,
                status: 'done', games: games.length, rated: games.length, scheduled: games.length,
                bots: [target, house].map((name) => ({ name })), anchors: [house] };
            write(path.join(home.HOME, 'standings.json'), { arenaId: 'v2', arena: 'v2', requiredProtocol: 2,
                rounds: [...prior, rd] });
            return rd;
        }
        const noComplete = (usableMaximum = 0) => {
            const status = placement.statuses().find((r) => r.version === target);
            assert.ok(status, 'an accepted request remains inspectable');
            assert.notEqual(status.state, 'complete', 'incompatible history cannot satisfy the information criterion');
            assert.ok((status.criterion?.observations ?? 0) <= usableMaximum,
                `incompatible games cannot add usable observations (maximum ${usableMaximum})`);
            return status;
        };
        const refused = (action, label) => {
            let result;
            try { result = action(); } catch (e) {
                assert.match(String(e?.message ?? e), /context|compatib|protocol|bundle|digest|version|admi|frozen|identity|changed|conflict/i, label);
                return;
            }
            assert.equal(result, null, label);
        };
        const currentSpecOrRefusal = () => {
            let spec;
            try { spec = reserve(); } catch (e) {
                assert.match(String(e?.message ?? e), /context|compatib|protocol|bundle|digest|version|admi|history|identity|conflict/i);
                return;
            }
            if (spec !== null) {
                assert.deepEqual(spec.context, current, 'a dispatch may only use the trusted current context');
                assert.equal(spec.requiredProtocol, 2);
                assert.deepEqual(spec.bundles, { [target]: digests[target], [house]: digests[house] });
            }
        };

        if (which === 'identity') {
            assert.equal(identity.contextMatches(current, current), true);
            assert.equal(identity.contextProblem(current, current), null);
            for (const changed of [null, { ...current, arenaId: 'open' }, { ...current, protocol: 1 },
                { ...current, engineRevision: 'old-engine' }, { ...current, runnerRevision: 'old-runner' }]) {
                assert.equal(identity.contextMatches(changed, current), false);
                assert.equal(typeof identity.contextProblem(changed, current), 'string');
            }
            const built = identity.contextFor({ arenaId: 'v2', build: 'a'.repeat(40), cards: 'b'.repeat(64) });
            assert.equal(built.runnerRevision, 'swu-arena-v2/1');
            assert.equal(built.engineRevision, require('node:crypto').createHash('sha256').update(`${'a'.repeat(40)}:${'b'.repeat(64)}`).digest('hex'));
        } else if (which === 'valid-reuse') {
            history(rows());
            const row = enqueue();
            assert.equal(row?.state, 'complete', 'valid v2 history is reusable without playing another game');
            assert.equal(row.criterion.observations, 60);
            assert.equal(row.scheduled, 0);
            assert.equal(reserve(), null);
            assert.equal(prepared, 0);
        } else if (which.startsWith('global-')) {
            const { globalElo } = required('referee.js');
            assert.equal(typeof globalElo, 'function', 'missing referee.globalElo API');
            const rd = { round: 0, arenaId: 'v2', arena: 'v2', requiredProtocol: 2, context: structuredClone(current),
                bundles: { ...digests }, bots: [{ name: target, agent: 'alice' }, { name: house, resident: 'house' }],
                anchors: [house], results: [{ a: target, b: house, score: 1 }] };
            const baseline = globalElo([rd]);
            assert.ok(Number.isFinite(baseline[target]) && Number.isFinite(baseline[house]), 'current verified results produce a real fit');
            const contrary = Array.from({ length: 60 }, () => ({ a: target, b: house, score: 0 }));
            if (which === 'global-current-and-stale') {
                const oldEngine = { ...rd, round: 1, context: { ...current, engineRevision: 'd'.repeat(64) }, results: contrary };
                const oldProtocol = { ...rd, round: 2, requiredProtocol: 1, results: contrary };
                assert.deepEqual(globalElo([rd, oldEngine, oldProtocol]), baseline,
                    'displayed global ratings must not borrow old engine/card context or protocol v1 results');
            } else if (which === 'global-conflicting-version') {
                const conflict = { ...rd, round: 1, bundles: { ...digests, [target]: 'd'.repeat(64) }, results: contrary };
                let result;
                try { result = globalElo([rd, conflict]); } catch (e) {
                    assert.match(String(e?.message ?? e), /identity|bundle|digest|conflict|immutable|version/i,
                        'a conflicting immutable version needs a clear identity rejection');
                }
                if (result !== undefined && Object.hasOwn(result, target)) assert.deepEqual(result, baseline,
                    'a different digest under the same immutable version cannot contaminate displayed ratings');
                else if (result !== undefined) assert.equal(target in result, false,
                    'quarantining a conflicting immutable version is a valid fail-closed result');
            } else assert.fail(`unknown global boundary case ${which}`);
            assert.equal(prepared, 0);
        } else if (which.startsWith('history-') && which !== 'history-conflicting-version') {
            const kind = which.slice(8);
            history(rows(), (ladder) => {
                if (kind === 'v1') ladder.games = ladder.games.map((g) => ({ ...g, requiredProtocol: 1, protocols: { p1: 1, p2: 1 } }));
                if (kind === 'missing-required') ladder.games.forEach((g) => { delete g.requiredProtocol; });
                if (kind === 'missing-seat') ladder.games.forEach((g) => { g.protocols = { p1: 2 }; });
                if (kind === 'mixed-seat') ladder.games.forEach((g) => { g.protocols = { p1: 2, p2: 1 }; });
                if (kind === 'foreign-arena') { ladder.config.arena = 'open'; ladder.config.context.arenaId = 'open'; }
                if (kind === 'old-engine') ladder.config.context.engineRevision = 'd'.repeat(64);
                if (kind === 'old-runner') ladder.config.context.runnerRevision = 'swu-arena-v2/old';
                if (kind === 'missing-context') delete ladder.config.context;
                if (kind === 'game-context') ladder.games.forEach((g) => { g.context.engineRevision = 'd'.repeat(64); });
                if (kind === 'game-digest') ladder.games.forEach((g) => { g.bundles[target] = 'd'.repeat(64); });
                if (kind === 'changed-digest') ladder.config.bundles[target] = 'd'.repeat(64);
                if (kind === 'missing-digest') delete ladder.config.bundles[target];
                return ladder;
            });
            assert.ok(enqueue());
            noComplete();
            currentSpecOrRefusal();
        } else if (which === 'history-conflicting-version') {
            const valid = history(rows(1));
            history(rows(), (ladder) => { ladder.config.bundles[target] = 'd'.repeat(64); return ladder; }, 1, [valid]);
            assert.ok(enqueue());
            noComplete(2);
            currentSpecOrRefusal();
        } else if (['unrated-attempt-seeds', 'stuck-attempt-seeds', 'running-attempt-seeds', 'unknown-seed-running-attempt'].includes(which)) {
            const attempt = which === 'unrated-attempt-seeds' ? { ...rows(1)[0], outcome: 'ERROR', protocols: {} } :
                which === 'stuck-attempt-seeds' ? { ...rows(1)[0], outcome: 'STUCK' } :
                { id: 'pending-attempt', p1: target, p2: house, outcome: 'running',
                    ...(which === 'running-attempt-seeds' ? { seed: 0 } : {}) };
            history([attempt]);
            assert.ok(enqueue());
            const status = noComplete();
            if (status.criterion?.connected !== undefined) assert.equal(status.criterion.connected, false,
                'unrated or unnegotiated attempts cannot create real ranking connectivity');
            if (which === 'unknown-seed-running-attempt') {
                assert.equal(status.state, 'waiting', 'an unidentified running attempt must block this exact pair');
                assert.match(`${status.reason ?? ''} ${status.error ?? ''}`, /unknown.?seed/i,
                    'unknown-seed refusal must explain why repeating the pair is unsafe');
                assert.equal(reserve(), null);
                assert.equal(prepared, 0);
            } else {
            let spec;
            try { spec = reserve(); } catch (e) {
                assert.match(String(e?.message ?? e), /context|compatib|protocol|history|identity|bundle|seed|attempt/i,
                    'a safe refusal must explicitly identify the unavailable attempt evidence');
            }
            if (spec != null) {
                assert.deepEqual(spec.context, current);
                assert.deepEqual(spec.bundles, { [target]: digests[target], [house]: digests[house] });
                assert.ok(spec.placement.excludedSeeds.includes(0),
                    'trusted same-context attempt identities reserve their seed even when the games are unrated');
            } else {
                const after = placement.statuses().find((r) => r.version === target);
                assert.ok(['waiting', 'blocked', 'cancelled', 'failed'].includes(after.state), 'no unexplained silent refusal');
                assert.match(`${after.reason ?? ''} ${after.error ?? ''}`, /context|compatib|protocol|history|identity|bundle|seed|attempt/i,
                    'a safe refusal must expose an inspectable reason');
                assert.equal(prepared, 0);
            }
            }
        } else if (which.startsWith('admission-')) {
            const kind = which.slice(10);
            putMeta(target, (meta) => {
                if (kind === 'v1') meta.compatibility.negotiatedProtocol = 1;
                if (kind === 'missing-context') delete meta.compatibility.context;
                if (kind === 'foreign-arena') meta.compatibility.context.arenaId = 'open';
                if (kind === 'old-engine') meta.compatibility.context.engineRevision = 'd'.repeat(64);
                if (kind === 'changed-digest') meta.compatibility.bundleSha256 = 'd'.repeat(64);
                return meta;
            });
            refused(enqueue, 'unverified or stale immutable admission must not enqueue placement');
            assert.equal(prepared, 0);
        } else if (which === 'queued-bundle-changed') {
            assert.ok(enqueue());
            fs.appendFileSync(path.join(home.VERSIONS, target, 'bundle', 'bot.wasm'), Buffer.from([255]));
            refused(reserve, 'queued admission cannot execute bytes different from its verified bundle');
            assert.equal(prepared, 0, 'refusal must precede spec preparation');
        } else if (which === 'frozen-context-changed') {
            assert.ok(enqueue());
            const frozen = reserve(0);
            assert.deepEqual(frozen.context, current);
            current = { ...current, engineRevision: 'd'.repeat(64) };
            refused(() => reserve(0), 'a changed trusted context cannot resume a stale frozen round');
            assert.equal(prepared, 1, 'stale resume never prepares a replacement workload');
            assert.notEqual(placement.statuses()[0].state, 'complete');
        } else if (which === 'frozen-version-conflict') {
            assert.ok(enqueue());
            const frozen = reserve(0);
            fs.appendFileSync(path.join(home.VERSIONS, target, 'bundle', 'bot.wasm'), Buffer.from([255]));
            const digest = compatibility.bundleDigest(path.join(home.VERSIONS, target, 'bundle'));
            putMeta(target, (meta) => ({ ...meta, bundleSha256: digest,
                compatibility: { ...meta.compatibility, bundleSha256: digest } }));
            assert.notEqual(frozen.bundles[target], digest);
            refused(() => reserve(0), 'one version name cannot be rebound to another digest after a round freezes');
            assert.equal(prepared, 1);
        } else if (which === 'new-version') {
            history(rows());
            const next = version('alice', 2);
            const row = enqueue(next);
            assert.ok(row);
            assert.notEqual(row.state, 'complete', 'v1 games are never v2 observations for a new immutable version');
            const spec = reserve();
            assert.equal(spec.placement.version, next);
            assert.equal(spec.bundles[next], digests[next]);
            assert.deepEqual(spec.context, current);
        } else if (which === 'unknown-current-context') {
            current = null;
            let row;
            try { row = enqueue(); } catch (e) { assert.match(String(e?.message ?? e), /context|identity/i); }
            if (row != null) assert.ok(['waiting', 'blocked', 'cancelled', 'failed'].includes(row.state), 'missing context remains inspectable without runnable work');
            refused(reserve, 'an unavailable trusted comparison context cannot dispatch placement work');
            assert.equal(prepared, 0);
        } else {
            assert.fail(`unknown fixture case ${which}`);
        }
        process.stdout.write(JSON.stringify({ case: which, ok: true }));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const selected = process.argv.indexOf('--fixture-case');
if (selected >= 0) {
    fixtureCase(process.argv[selected + 1]);
} else {
    const test = require('node:test');
    const cases = ['identity', 'valid-reuse', 'global-current-and-stale', 'global-conflicting-version', 'history-v1', 'history-missing-required', 'history-missing-seat', 'history-mixed-seat',
        'history-foreign-arena', 'history-old-engine', 'history-old-runner', 'history-missing-context', 'history-changed-digest',
        'history-missing-digest', 'history-game-context', 'history-game-digest', 'history-conflicting-version', 'unrated-attempt-seeds',
        'stuck-attempt-seeds', 'running-attempt-seeds', 'unknown-seed-running-attempt', 'admission-v1', 'admission-missing-context', 'admission-foreign-arena',
        'admission-old-engine', 'admission-changed-digest', 'queued-bundle-changed', 'frozen-context-changed', 'frozen-version-conflict',
        'new-version', 'unknown-current-context'];
    for (const which of cases) test(`v2 placement comparison boundary: ${which}`, () => {
        const result = spawnSync(process.execPath, [__filename, '--fixture-case', which], { encoding: 'utf8', timeout: 20000,
            maxBuffer: 1 << 20, env: { PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC', SWU_BOUNDARY_REPO: REPO } });
        assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
        assert.deepEqual(JSON.parse(result.stdout), { case: which, ok: true });
    });
}
