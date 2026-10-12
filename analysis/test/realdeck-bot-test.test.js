'use strict';
// The standard bot test: which gauntlets count (reference, deck file, seed, key), the newest run per challenger, the
// dashboard panel, and the command line on run folders written like ladder.js writes them.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const bt = require('../realdeck/bot-test');
const { readDeckFile, deckMeta } = require('../realdeck/compare');
const { skillVsAgreement } = require('../realdeck/skill');

const DECKS = path.join(__dirname, '..', '..', 'bot', 'decks', 'ash-meta-2026-09.json');
const SCRIPT = path.join(__dirname, '..', 'realdeck', 'bot-test.js');

// 1. arguments
{
    assert.deepStrictEqual([bt.parseArgs(['--bot', 'rust-search', '--mirror', '--record']).bot, bt.parseArgs(['--report']).report], ['rust-search', true]);
    assert.throws(() => bt.parseArgs([]), /give --bot/);
    assert.throws(() => bt.parseArgs(['--bot', 'heuristic#a']), /without a #tag/);
    assert.throws(() => bt.parseArgs(['--bot', 'a,b']), /one bot name/);
    assert.throws(() => bt.parseArgs(['--bot', 'c-clock']), /reference/);
    assert.throws(() => bt.parseArgs(['--bot']), /needs a value/);
    assert.throws(() => bt.parseArgs(['--bot', '--mirror']), /needs a value/);
    assert.throws(() => bt.parseArgs(['--report', '--resume', 'x']), /goes with --bot/);
    assert.throws(() => bt.parseArgs(['--report', '--what']), /unknown option/);
    assert.strictEqual(bt.slug('h@linear-deck-g4'), 'h-linear-deck-g4');
    assert.strictEqual(bt.keyId('abc'), 'ba7816bf8f01', 'the 12-hex-digit id ladder.js writes as config.keyId');
}

// 2. which gauntlets are the standard test
{
    const sha = 'f'.repeat(64);
    const g = (id, createdAt, config, status = 'done', updatedAt = createdAt) => ({ id, dir: `/x/${id}`, createdAt, updatedAt, status, config: { format: 'gauntlet', vs: ['c-clock'], firstSeed: 1, decks: { sha256: sha }, ...config } });
    const runs = [
        { id: 'mirror', createdAt: '2026-10-11T00:00:00Z', status: 'done', config: { bots: ['x#a', 'x#b'] } },
        g('running-first', '2026-10-11T00:30:00Z', { keyId: bt.keyId('K') }, 'running'),
        g('first', '2026-10-11T01:00:00Z', { key: 'K' }),
        g('other-ref', '2026-10-11T02:00:00Z', { vs: ['heuristic'], key: 'K' }),
        g('other-file', '2026-10-11T03:00:00Z', { decks: { sha256: 'e'.repeat(64) }, key: 'K' }),
        g('other-seed', '2026-10-11T04:00:00Z', { firstSeed: 7, key: 'K' }),
        g('other-key', '2026-10-11T05:00:00Z', { key: 'L' }),
        g('old-runner', '2026-10-11T06:00:00Z', {}),
        g('running', '2026-10-11T07:00:00Z', { keyId: bt.keyId('K') }, 'running')
    ];
    const s = bt.standardGauntlets(runs, { sha256: sha });
    assert.strictEqual(s.key, 'K', 'the first finished gauntlet sets the deals');
    assert.deepStrictEqual(s.use.map((r) => r.id), ['running-first', 'first', 'running']);
    assert.deepStrictEqual(Object.fromEntries(s.ignored.map((x) => [x.id, x.reason])), {
        'other-ref': 'plays against ["heuristic"], the test is against c-clock', 'other-file': 'another deck file',
        'other-seed': 'first seed 7, the test uses 1', 'other-key': 'another key, so other deals',
        'old-runner': 'its key is not known (a run from before ladder.js named it, or --key none)'
    });
    assert.deepStrictEqual([s.waiting, s.pinnedMissing], [[], false]);
    // the deals of the last report stay, even when another finished gauntlet would come first
    const pin = bt.standardGauntlets(runs, { sha256: sha, pinned: bt.keyId('L') });
    assert.deepStrictEqual([pin.key, pin.use.map((r) => r.id), pin.pinnedMissing], ['L', ['other-key'], false]);
    const lost = bt.standardGauntlets(runs, { sha256: sha, pinned: 'nothing-here' });
    assert.deepStrictEqual([lost.key, lost.pinnedMissing], ['K', true], 'a pin with no finished run: the first to finish');
    // the first to finish sets the deals, whatever started first
    const race = bt.standardGauntlets([g('slow', '2026-10-11T01:00:00Z', { key: 'K' }, 'done', '2026-10-11T05:00:00Z'),
        g('fast', '2026-10-11T02:00:00Z', { key: 'L' }, 'done', '2026-10-11T03:00:00Z')], { sha256: sha });
    assert.deepStrictEqual([race.key, race.use.map((r) => r.id)], ['L', ['fast']]);
    const none = bt.standardGauntlets([g('only-running', null, { keyId: 'abc' }, 'running')], { sha256: sha });
    assert.deepStrictEqual([none.key, none.use.length, none.ignored[0].reason, none.waiting], [null, 0, 'no finished gauntlet has set the deals yet', ['only-running']]);

    const now = new Date('2026-10-12T03:00:00Z');
    assert.deepStrictEqual([
        bt.runState({ status: 'done', updatedAt: '2026-10-01T00:00:00Z' }, now),
        bt.runState({ status: 'running', updatedAt: '2026-10-12T02:50:00Z' }, now),
        bt.runState({ status: 'running', updatedAt: '2026-10-12T01:30:00Z' }, now),
        bt.runState({ status: 'running' }, now)
    ], ['done', 'running', 'stopped', 'stopped']);
}

// 3. the newest run of each challenger replaces its games in older runs
{
    const game = (p1, p2, seed) => ({ id: `${p1}-${p2}-${seed}`, seed, p1, p2, winnerSeat: 'p1', outcome: 'won' });
    const old = { id: 'old', createdAt: '2026-10-11T01:00:00Z', vs: ['c-clock'], challengers: ['heuristic', 'rust-search'],
        games: [game('heuristic', 'c-clock', 1), game('c-clock', 'heuristic', 1), game('rust-search', 'c-clock', 1), game('c-clock', 'rust-search', 1)] };
    const again = { id: 'again', createdAt: '2026-10-12T01:00:00Z', vs: ['c-clock'], challengers: ['heuristic'], games: [game('heuristic', 'c-clock', 1)] };
    const solo = { id: 'solo', createdAt: '2026-10-11T02:00:00Z', vs: ['c-clock'], challengers: ['rust-search'], games: [game('rust-search', 'c-clock', 1)] };
    const r = bt.newestPerChallenger([old, again]);
    assert.deepStrictEqual(r.superseded, [{ bot: 'heuristic', run: 'old', by: 'again' }]);
    assert.deepStrictEqual(r.runs.map((x) => [x.id, x.challengers, x.games.length]), [['old', ['rust-search'], 2], ['again', ['heuristic'], 1]]);
    assert(r.runs[0].games.every((x) => x.p1 !== 'heuristic' && x.p2 !== 'heuristic'));
    const r2 = bt.newestPerChallenger([old, again, solo]);
    assert.deepStrictEqual(r2.runs.map((x) => x.id), ['again', 'solo'], 'a run left with no challenger is dropped');
    assert.strictEqual(bt.newestPerChallenger([old]).runs[0], old, 'nothing to replace: the run as it is');
    // a finished run beats a newer one still going; a bot with only an unfinished run keeps it
    const going = { ...again, id: 'going', status: 'running' };
    const r3 = bt.newestPerChallenger([{ ...old, status: 'done' }, going]);
    assert.deepStrictEqual(r3.superseded, [{ bot: 'heuristic', run: 'going', by: 'old' }]);
    assert.deepStrictEqual(r3.runs.map((x) => x.id), ['old']);
    assert.deepStrictEqual(bt.newestPerChallenger([going]).runs.map((x) => x.id), ['going']);
}

// 4. colour steps, the aggro lean and the panel
{
    assert.deepStrictEqual([0, 0.02, 0.03, 0.1, 0.35, -0.03, -0.4].map(bt.edgeStep), [0, 0, 1, 2, 5, -1, -5]);
    assert.deepStrictEqual([bt.cellEdge({ winRate: 0.6, edge: -0.1 }), bt.cellEdge({ winRate: 0.6, edge: null }), bt.cellEdge(null)].map((x) => x && Math.round(x * 100)), [-10, 10, null]);
    // on the edges, weighted by the games with an expectation
    const row = { hyperaggro: { edge: 0.1, expectedGames: 10 }, softaggro: { edge: -0.1, expectedGames: 30 }, midrange: { edge: 0.5, expectedGames: 4 }, hardcontrol: { edge: -0.2, expectedGames: 20 } };
    assert.strictEqual(Math.round(1000 * bt.aggroMinusControl(row)), 150);
    assert.strictEqual(bt.aggroMinusControl({ hyperaggro: { decided: 4, score: 2, edge: null, expectedGames: 0 }, hardcontrol: { edge: 0, expectedGames: 3 } }), null, 'no edge on one side: no lean');

    // the table and the latest bot's face-offs against the reference's own score with the same decks
    const modelled = {
        reference: 'c-clock', bots: [{ bot: 'x', skill: { winRate: 0.55, decided: 20, ci: [0.33, 0.75], incomplete: 2, byStyle: {
            hyperaggro: { decided: 10, score: 6, winRate: 0.6, expected: 0.7, edge: -0.1, expectedGames: 10 },
            hardcontrol: { decided: 10, score: 5, winRate: 0.5, expected: 0.3, edge: 0.2, expectedGames: 10 } } } }]
    };
    const mh = bt.styleTableHtml(modelled.bots, 'c-clock');
    assert.match(mh, /<td class="b">c-clock itself<\/td><td>70%<small>same decks<\/small><\/td><td>30%<small>same decks<\/small><\/td><td class="o">50%<\/td>/);
    assert.match(mh, /<td class="n2" title="[^"]*c-clock with the same decks: 70%">60%<small>−10<\/small><\/td><td class="p3"[^>]*>50%<small>\+20<\/small><\/td><td class="o">55%<\/td><td class="o">−30<\/td>/);
    assert.match(mh, /better than c-clock/);
    const mp = bt.panelOf(modelled, { now: new Date('2026-10-12T03:00:00Z'), latest: 'x', states: new Map([['x', { state: 'running', finished: 22, run: 'test-x-1' }]]), gamesPerBot: 702 });
    assert.strictEqual(mp.status, 'running');
    assert.strictEqual(mp.widgets[0].items[0].note, '95% CI 33-75%; 2 games without a result left out; running, 22 of 702 games');
    assert.deepStrictEqual(mp.widgets[2].items.map((x) => x.note), ['Hyper-aggro decks; c-clock itself 70% with the same decks (−10)', 'Hard control decks; c-clock itself 30% with the same decks (+20)']);
    assert.match(mp.now, /^x scored 55% against c-clock .* over 20 games so far \(running\)$/);
    assert.match(mp.mentalModel.summary, /compared with what c-clock itself scores with the same decks/);
    const stopped = bt.panelOf(modelled, { now: new Date('2026-10-12T03:00:00Z'), states: new Map([['x', { state: 'stopped', finished: 22, run: 'test-x-1' }]]), gamesPerBot: 702 });
    assert.deepStrictEqual([stopped.status, stopped.widgets[0].items[0].note.split('; ').at(-1)], ['done', 'stopped at 22 of 702 games (--resume test-x-1)']);

    const { raw } = readDeckFile(DECKS);
    const decks = deckMeta(raw);
    const seedGames = (bot, seed, [y1, y2]) => {
        const d = { p1: decks[seed % 27].name, p2: decks[(seed + 5) % 27].name };
        return [
            { id: `${bot}-a-${seed}`, seed, p1: bot, p2: 'c-clock', winnerSeat: y1 ? 'p1' : 'p2', outcome: 'won', decks: d, key: `k${seed}` },
            { id: `${bot}-b-${seed}`, seed, p1: 'c-clock', p2: bot, winnerSeat: y2 ? 'p2' : 'p1', outcome: 'won', decks: { p1: d.p2, p2: d.p1 }, key: `k${seed}` }
        ];
    };
    const games = [];
    for (let s = 1; s <= 20; s++) {
        games.push(...seedGames('heuristic', s, [s % 3 === 0, s % 4 === 0]), ...seedGames('rust-search', s, [s % 2 === 0, true]));
    }
    const styles = new Map(decks.map((d) => [d.name, d.style]));
    const result = skillVsAgreement([{ id: 'g', vs: ['c-clock'], challengers: ['heuristic', 'rust-search'], games, decks: 27 }], null, { styles });
    const rs = result.bots.find((b) => b.bot === 'rust-search');
    assert.strictEqual(Object.values(rs.skill.byStyle).reduce((a, x) => a + x.decided, 0), 40, 'every decided game in one deck type');
    const existing = { title: 'Kept title', goal: 'kept goal', mentalModel: { summary: 'kept' }, plan: [{ text: 'p', state: 'doing' }],
        thoughts: Array.from({ length: 12 }, (_, i) => ({ t: '2026-10-11T00:00:00Z', text: `t${i}` })) };
    const p = bt.panelOf(result, { existing, now: new Date('2026-10-12T03:00:00.123Z'), latest: 'heuristic', thought: 'heuristic tested', decks: 27,
        states: new Map([['heuristic', { state: 'running', finished: 40, run: 'g' }], ['rust-search', { state: 'done', finished: 702, run: 'g' }]]) });
    assert.deepStrictEqual([p.schema, p.id, p.title, p.goal, p.status, p.updatedAt], [1, 'realdeck-test', 'Kept title', 'kept goal', 'running', '2026-10-12T03:00:00Z']);
    assert.deepStrictEqual(p.bots, ['rust-search', 'heuristic', 'c-clock']);
    assert.strictEqual(p.thoughts.length, 12, 'the last 12 thoughts');
    assert.deepStrictEqual(p.thoughts.at(-1), { t: '2026-10-12T03:00:00Z', text: 'heuristic tested' });
    assert.deepStrictEqual(p.widgets.map((w) => w.type), ['faceoff', 'html', 'faceoff']);
    const [all, table, latest] = p.widgets;
    assert.deepStrictEqual(all.items.map((x) => [x.a, x.b, x.n]), [['rust-search', 'c-clock', 40], ['heuristic', 'c-clock', 40]]);
    assert(all.items.every((x) => x.share >= 0 && x.share <= 1), 'fractions');
    assert.strictEqual(all.items[0].share, rs.skill.winRate);
    assert.match(all.items[0].note, /^95% CI \d+-\d+%$/);
    assert.match(all.items[1].note, /; running, 40 games$/);
    assert.match(table.html, /<th>Hyper-aggro<\/th>/);
    assert.match(table.html, /prefers-color-scheme:dark/);
    assert.match(table.html, /<td class="b">rust-search<\/td>/);
    assert(latest.items.every((x) => x.a === 'heuristic' && x.b === 'c-clock'));
    assert.match(p.now, /^heuristic scored \d+% against c-clock/);
    const fresh = bt.panelOf(result, { now: new Date('2026-10-12T03:00:00Z') });
    assert.strictEqual(fresh.thread, 'Analyze real human games');
    assert.strictEqual(fresh.status, 'done');
    assert.deepStrictEqual(fresh.thoughts, []);
    assert.deepStrictEqual(fresh.widgets.map((w) => w.type), ['faceoff', 'html'], 'no latest bot: no deck-type face-offs');
    assert.match(bt.styleTableHtml([{ bot: '<b>', skill: { winRate: 0.5, byStyle: { midrange: { decided: 2, score: 1, winRate: 0.5 } } } }], 'c-clock'), /&lt;b&gt;/);
    assert.match(table.html, /coloured against 50%/, 'no mirror model: cells against 50%, and the note says so');
    assert(!table.html.includes('itself'), 'no reference row without a model');
    assert.match(bt.styleTableHtml([{ bot: 'z', skill: { winRate: 0.5, byStyle: { midrange: { decided: 2, score: 1, winRate: 0.5, expected: 0.504, edge: -0.004, expectedGames: 2 } } } }], 'c-clock'), /50%<small>\+0<\/small>/, 'no −0');
    assert.strictEqual(bt.shownCommand(['bot/ladder.js', '--key', 'K', '--id', 'x y']), `node bot/ladder.js --key K --id "x y"`);
    assert.strictEqual(bt.shownCommand(['bot/ladder.js', '--key', 'K'], 'K'), `node bot/ladder.js --key <key id ${bt.keyId('K')}>`);
}

// 5. the command line on run folders like ladder.js writes them
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'realdeck-bot-test-'));
    try {
        const { sha256, raw } = readDeckFile(DECKS);
        const names = deckMeta(raw).map((d) => d.name);
        const games = [];
        for (let s = 1; s <= 4; s++) {
            const d = { p1: names[s], p2: names[s + 1] };
            games.push({ id: `h-${s}a`, seed: s, p1: 'heuristic', p2: 'c-clock', winnerSeat: 'p2', outcome: 'won', decks: d, key: `k${s}` },
                { id: `h-${s}b`, seed: s, p1: 'c-clock', p2: 'heuristic', winnerSeat: 'p1', outcome: 'won', decks: { p1: d.p2, p2: d.p1 }, key: `k${s}` });
        }
        const write = (id, createdAt, config, status = 'done', updatedAt = createdAt) => {
            fs.mkdirSync(path.join(dir, id));
            fs.writeFileSync(path.join(dir, id, 'index.json'), JSON.stringify({ id, bots: config.bots, games: config.bots.includes('heuristic') ? games : [] }));
            fs.writeFileSync(path.join(dir, id, 'ladder.json'), JSON.stringify({ id, status, createdAt, updatedAt, config }));
        };
        const cli = (...args) => {
            try {
                return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args, '--dir', dir], { encoding: 'utf8', stdio: 'pipe' }) };
            } catch (e) {
                return { code: e.status, out: `${e.stdout}${e.stderr}` };
            }
        };
        write('g1', '2026-10-11T10:00:00.000Z', { bots: ['heuristic', 'c-clock'], format: 'gauntlet', vs: ['c-clock'], firstSeed: 1, key: 'secret', decks: { sha256, names } });
        write('g-other', '2026-10-11T11:00:00.000Z', { bots: ['random', 'c-clock'], format: 'gauntlet', vs: ['c-clock'], firstSeed: 1, key: 'other', decks: { sha256, names } });
        fs.mkdirSync(path.join(dir, 'test-rust-search-1'));
        const panel = path.join(dir, 'panel.json');
        const dry = execFileSync(process.execPath, [SCRIPT, '--bot', 'rust-search', '--mirror', '--dir', dir, '--dry-run'], { encoding: 'utf8' });
        assert.match(dry, new RegExp(`\\$ node bot/ladder\\.js --decks bot/decks/ash-meta-2026-09\\.json --bots rust-search --vs c-clock --games 702 --seed 1 --key <key id ${bt.keyId('secret')}> --id test-rust-search-2 --out `));
        assert(!dry.includes('secret'), 'the key itself is never printed');
        assert.match(dry, /--bots rust-search#a,rust-search#b --games 702 --seed 1 --id mirror-rust-search-1/);
        assert.match(dry, /analysis\/realdeck\/compare\.js --runs .*mirror-rust-search-1 --decks bot\/decks\/ash-meta-2026-09\.json --human bot\/decks\/ash-meta-2026-09\.human\.json/);
        assert(!fs.existsSync(path.join(dir, 'skill.json')), 'a dry run writes nothing');
        const out = execFileSync(process.execPath, [SCRIPT, '--report', '--dir', dir, '--panel', panel], { encoding: 'utf8' });
        assert.match(out, /left out: g-other \(another key, so other deals\)/);
        assert.match(out, /heuristic\s+8\s+0\.0/);
        const skill = JSON.parse(fs.readFileSync(path.join(dir, 'skill.json'), 'utf8'));
        assert.deepStrictEqual([skill.standard.keyId, skill.standard.gamesPerBot, skill.standard.deckFile.decks], [bt.keyId('secret'), 702, 27]);
        assert(fs.readFileSync(path.join(dir, 'skill.txt'), 'utf8').includes('by deck type'));
        const p = JSON.parse(fs.readFileSync(panel, 'utf8'));
        assert.strictEqual(p.widgets[0].items[0].share, 0);
        assert.match(p.now, /^heuristic scored 0% against c-clock/, 'the newest one-bot run is the latest bot');
        assert.throws(() => execFileSync(process.execPath, [SCRIPT], { stdio: 'pipe' }), /usage/);

        // --resume: only the same bot's gauntlet on the standard deck file, seed and key
        write('test-heuristic-9', '2026-10-11T12:00:00.000Z', { bots: ['heuristic', 'c-clock'], format: 'gauntlet', vs: ['c-clock'], firstSeed: 1, keyId: bt.keyId('secret'), decks: { sha256, names } }, 'running');
        write('test-heuristic-8', '2026-10-11T12:00:00.000Z', { bots: ['heuristic', 'c-clock'], format: 'gauntlet', vs: ['c-clock'], firstSeed: 1, keyId: bt.keyId('nope'), decks: { sha256, names } }, 'running');
        const ok = cli('--bot', 'heuristic', '--resume', 'test-heuristic-9', '--dry-run');
        assert.strictEqual(ok.code, 0, ok.out);
        assert.match(ok.out, /--id test-heuristic-9 --out .* --resume/);
        assert.match(cli('--bot', 'rust-search', '--resume', 'test-heuristic-9', '--dry-run').out, /is not a gauntlet of rust-search against c-clock/);
        assert.match(cli('--bot', 'heuristic', '--resume', 'test-heuristic-8', '--dry-run').out, /was dealt from key id [0-9a-f]{12}, the standard deals are key id/);
        assert.match(cli('--bot', 'heuristic', '--resume', 'nothing', '--dry-run').out, /no ladder\.json, so there is no run nothing to resume/);
        assert.strictEqual(cli('--bot', 'heuristic', '--resume', 'nothing', '--dry-run').code, 1);
        assert.match(bt.resumeProblem(dir, 'test-heuristic-9', { bot: 'heuristic', sha256, std: { key: null, keyId: null } }), /would deal its remaining games from a new key/);

        // the deals of the last report stay: a gauntlet that finished earlier on another key is left out
        write('g0', '2026-10-11T08:00:00.000Z', { bots: ['random', 'c-clock'], format: 'gauntlet', vs: ['c-clock'], firstSeed: 1, key: 'early', decks: { sha256, names } }, 'done', '2026-10-11T09:00:00.000Z');
        assert.match(cli('--report').out, /left out: g0 \(another key, so other deals\)/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

console.log('ok: realdeck bot test arguments, standard gauntlets, newest run per bot, panel, cli');
