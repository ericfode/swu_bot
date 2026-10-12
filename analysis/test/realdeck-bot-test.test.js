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
    const g = (id, createdAt, config, status = 'done') => ({ id, dir: `/x/${id}`, createdAt, status, config: { format: 'gauntlet', vs: ['c-clock'], firstSeed: 1, decks: { sha256: sha }, ...config } });
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
        'old-runner': 'its key is not known (a run from before ladder.js named it)'
    });
    const none = bt.standardGauntlets([g('only-running', null, { keyId: 'abc' }, 'running')], { sha256: sha });
    assert.deepStrictEqual([none.key, none.use.length, none.ignored[0].reason], [null, 0, 'no finished gauntlet has set the deals yet']);
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
}

// 4. colour steps, the aggro lean and the panel
{
    assert.deepStrictEqual([0.5, 0.52, 0.53, 0.6, 0.85, 0.47, 0.1].map(bt.edgeStep), [0, 0, 1, 2, 5, -1, -5]);
    const row = { hyperaggro: { decided: 10, score: 6 }, softaggro: { decided: 10, score: 4 }, midrange: { decided: 4, score: 2 }, hardcontrol: { decided: 20, score: 5 } };
    assert.strictEqual(bt.aggroMinusControl(row), 0.25);
    assert.strictEqual(bt.aggroMinusControl({ midrange: { decided: 4, score: 2 } }), null);

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
    const p = bt.panelOf(result, { existing, now: new Date('2026-10-12T03:00:00.123Z'), latest: 'heuristic', thought: 'heuristic tested', running: true, decks: 27 });
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
        const write = (id, createdAt, config, status = 'done') => {
            fs.mkdirSync(path.join(dir, id));
            fs.writeFileSync(path.join(dir, id, 'index.json'), JSON.stringify({ id, bots: config.bots, games: config.bots.includes('heuristic') ? games : [] }));
            fs.writeFileSync(path.join(dir, id, 'ladder.json'), JSON.stringify({ id, status, createdAt, config }));
        };
        write('g1', '2026-10-11T10:00:00.000Z', { bots: ['heuristic', 'c-clock'], format: 'gauntlet', vs: ['c-clock'], firstSeed: 1, key: 'secret', decks: { sha256, names } });
        write('g-other', '2026-10-11T11:00:00.000Z', { bots: ['random', 'c-clock'], format: 'gauntlet', vs: ['c-clock'], firstSeed: 1, key: 'other', decks: { sha256, names } });
        fs.mkdirSync(path.join(dir, 'test-rust-search-1'));
        const panel = path.join(dir, 'panel.json');
        const dry = execFileSync(process.execPath, [SCRIPT, '--bot', 'rust-search', '--mirror', '--dir', dir, '--dry-run'], { encoding: 'utf8' });
        assert.match(dry, /\$ node bot\/ladder\.js --decks bot\/decks\/ash-meta-2026-09\.json --bots rust-search --vs c-clock --games 702 --seed 1 --key secret --id test-rust-search-2 --out /);
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
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

console.log('ok: realdeck bot test arguments, standard gauntlets, newest run per bot, panel, cli');
