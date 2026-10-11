'use strict';
// SWU Stats comparison: robots rules, the summary, the fetch with a fake site, and the model recovering known effects.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, summarize, robotsAllows, USER_AGENT } = require('../swustats/fetch');
const { compare, fitModel, weightedCorr } = require('../swustats/compare');

(async () => {
    // robots: no rules allows; a matching Disallow stops; our own group wins over *
    assert(robotsAllows('# only comments\n', '/TCGEngine/APIs/x.php'));
    assert(!robotsAllows('User-agent: *\nDisallow: /TCGEngine/\n', '/TCGEngine/APIs/x.php'));
    assert(robotsAllows('User-agent: *\nDisallow: /TCGEngine/\nAllow: /TCGEngine/APIs/\n', '/TCGEngine/APIs/x.php'));
    assert(robotsAllows('User-agent: *\nDisallow: /\n\nUser-agent: swu_bot-research\nDisallow:\n', '/TCGEngine/APIs/x.php'));

    // summary: plays and wins per leader and base, first-player rate, credit
    const deckMeta = [
        { leaderID: 'L1', leaderTitle: 'Luke', leaderSubtitle: 'Hero', baseID: 'B1', baseTitle: 'Echo Base', numPlays: 100, winRate: '60.00' },
        { leaderID: 'L1', leaderTitle: 'Luke', leaderSubtitle: 'Hero', baseID: 'B2', baseTitle: 'Tarkintown', numPlays: 50, winRate: '40.00' },
        { leaderID: 'L2', leaderTitle: 'Vader', leaderSubtitle: '', baseID: 'B2', baseTitle: 'Tarkintown', numPlays: 10, winRate: '50.00' }
    ];
    const matchups = [
        { leaderID: 'L1', opponentLeaderID: 'L2', numWins: '30', numPlays: '50', playsGoingFirst: '25', winsGoingFirst: '15' },
        { leaderID: 'L2', opponentLeaderID: 'L1', numWins: '20', numPlays: '50', playsGoingFirst: '25', winsGoingFirst: '14' }
    ];
    const s = summarize(deckMeta, matchups, { format: 'premier', fetchedAt: 'x' });
    assert.deepStrictEqual(s.leaders.map((l) => [l.id, l.name, l.wins, l.plays]), [['L1', 'Luke, Hero', 80, 150], ['L2', 'Vader', 5, 10]]);
    assert.deepStrictEqual(s.bases.map((b) => [b.id, b.wins, b.plays]), [['B1', 60, 100], ['B2', 25, 60]]);
    assert.strictEqual(s.totals.firstPlayerWinRate, 29 / 50);
    assert.match(s.credit, /SWU Stats/);

    // fetch: robots first, our User-Agent on every request, raw tables and the summary written
    const calls = [];
    const fake = async (url, opts) => {
        calls.push({ url, ua: opts.headers['user-agent'] });
        const body = url.endsWith('/robots.txt') ? '# no rules\n' : JSON.stringify(url.includes('DeckMeta') ? deckMeta : matchups);
        return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
    };
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'swustats-'));
    try {
        await run({ out, format: 'premier', delay: 0 }, fake, () => {});
        assert.deepStrictEqual(calls.map((c) => new URL(c.url).pathname), ['/robots.txt', '/TCGEngine/Stats/DeckMetaStatsAPI.php', '/TCGEngine/APIs/MetaMatchupStatsAPI.php']);
        assert(calls.every((c) => c.ua === USER_AGENT));
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(out, 'human-summary.json'), 'utf8')).leaders.length, 2);
        const blocked = async (url, opts) => (url.endsWith('/robots.txt') ? { ok: true, text: async () => 'User-agent: *\nDisallow: /TCGEngine\n' } : fake(url, opts));
        await assert.rejects(run({ out, format: 'premier', delay: 0 }, blocked, () => {}), /robots\.txt disallows/);
    } finally {
        fs.rmSync(out, { recursive: true, force: true });
    }

    // model: synthetic games with a strong bot and a strong leader; the fit finds both, with the right signs
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const bots = { strong: 1, weak: -1 };
    const lead = { A: 0.8, B: 0, C: -0.8 };
    const games = [];
    for (let i = 0; i < 3000; i++) {
        const seat = () => ({ bot: rnd() < 0.5 ? 'strong' : 'weak', leader: ['A', 'B', 'C'][Math.floor(rnd() * 3)], base: 'X' });
        const p1 = seat();
        const p2 = seat();
        const z = bots[p1.bot] - bots[p2.bot] + lead[p1.leader] - lead[p2.leader];
        games.push({ run: 'r', p1, p2, first: 'p1', winner: rnd() < 1 / (1 + Math.exp(-z)) ? 'p1' : 'p2', error: null });
    }
    const m = fitModel(games, null);
    const w = (k) => m.fit.w[m.index.get(k)];
    assert(w('bot:strong') - w('bot:weak') > 1.6 && w('bot:strong') - w('bot:weak') < 2.4, 'bot gap near 2');
    assert(w('leader:A') - w('leader:C') > 1.2 && w('leader:A') - w('leader:C') < 1.9, 'leader gap near 1.6');

    // compare: human strength that matches the leaders shows up as a positive κ and full rank agreement
    const summary = { credit: 'SWU Stats (swustats.net)', totals: { firstPlayerWinRate: 0.56 },
        leaders: [{ id: 'A', wins: 700, plays: 1000 }, { id: 'B', wins: 500, plays: 1000 }, { id: 'C', wins: 300, plays: 1000 }],
        bases: [{ id: 'X', wins: 500, plays: 1000 }] };
    const r = compare(games, summary);
    assert(r.kappa.leader.est > 0.5, 'κ picks up the shared leader strength');
    assert.strictEqual(r.leaders.agreement.spearman, 1);
    assert.strictEqual(r.games.decided, 3000);
    const { credit, ...noCredit } = summary;
    assert.strictEqual(compare(games.slice(0, 300), noCredit).credit, credit, 'credit is kept even if the summary lacks it');
    // correlation: null, not NaN, when there is nothing to correlate
    assert.strictEqual(weightedCorr([], []), null);
    assert.strictEqual(weightedCorr([1, 2, 3], [5, 5, 5]), null);
    assert(Math.abs(weightedCorr([1, 2, 3], [2, 4, 7]) - 0.9934) < 1e-3);
    console.log('ok: swustats robots, summary, fetch, model, compare');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
