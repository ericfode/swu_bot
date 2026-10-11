'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { isSwuPgn, parseSwuPgn, fold, convertSwuPgn } = require('../swupgn');
const { readText } = require('../sources');

// The five SWU-PGN/1.0 test vectors (fixtures/swupgn/README.md says where they come from).
const DIR = path.join(__dirname, 'fixtures', 'swupgn');
const NAMES = ['minimal', 'organic', 'upgrades', 'pilot', 'capture'];
const ROOT = path.join(__dirname, '..', '..');
const read = (name) => fs.readFileSync(path.join(DIR, `${name}.swupgn`), 'utf8');
const steps = (events) => events.filter((e) => e.t === 'step');
const isArena = (z) => z === 'ground' || z === 'space';

/** A deliberately separate, minimal reader of the file: header tags, STORY lines and NDJSON sections. */
function rawSections(text) {
    const out = { tags: {}, STORY: [] };
    let sec = null;
    for (const line of text.split('\n')) {
        if (line.startsWith('%%%')) {
            sec = line.slice(3).trim();
            out[sec] ??= [];
            continue;
        }
        if (!sec) {
            for (const m of line.matchAll(/\[(\w+) "([^"]*)"\]/g)) {
                out.tags[m[1]] = m[2];
            }
        } else if (sec === 'STORY') {
            out.STORY.push(line);
        } else if (line.trim()) {
            out[sec].push(JSON.parse(line));
        }
    }
    return out;
}

/** Arena membership from MOVE / CAPTURE / DEFEAT records alone, up to (not including) record `cut`: id -> seat. */
function arenaFromEvents(events, cut) {
    const where = new Map();
    for (const e of events.slice(0, cut)) {
        if (e.t === 'MOVE' && isArena(e.to) && e.kind !== 'upgrade' && !where.has(e.card)) {
            where.set(e.card, e.p);
        } else if (e.t === 'MOVE' && isArena(e.from) && !isArena(e.to)) {
            where.delete(e.card);
        } else if (e.t === 'CAPTURE' || e.t === 'DEFEAT') {
            where.delete(e.card);
        } else if (e.t === 'TAKE_CONTROL' && isArena(e.zone) && where.has(e.card)) {
            where.set(e.card, e.p);
        }
    }
    return where;
}

for (const name of NAMES) {
    test(`swupgn ${name}: our fold equals the reference reader's (${name}.fold.json)`, () => {
        const doc = parseSwuPgn(read(name));
        const want = JSON.parse(fs.readFileSync(path.join(DIR, `${name}.fold.json`), 'utf8'));
        assert.deepStrictEqual(fold(doc.events), want);
    });

    test(`swupgn ${name}: imports; header, steps, winner and keyframes match the file`, () => {
        const text = read(name);
        const raw = rawSections(text);
        const { events, report } = convertSwuPgn(text, { source: { kind: 'test', file: `${name}.swupgn` } });
        const [header, ...rest] = events;
        const end = rest[rest.length - 1];
        const st = steps(events);

        // header: omniscient, deck lists and deck orders carried, no player ids
        assert.strictEqual(header.t, 'header');
        assert.strictEqual(header.source.format, 'swu-pgn');
        assert.strictEqual(header.source.pov, 'both');
        assert.deepStrictEqual(header.source.hiddenHands, []);
        for (const d of raw.DECKS) {
            assert.deepStrictEqual(header.source.decks[`p${d.p}`].deck, d.deck);
        }
        const init = raw.SETUP.find((r) => r.t === 'INIT');
        assert.deepStrictEqual(header.source.deckOrder, { p1: init.p1DeckOrder, p2: init.p2DeckOrder });
        assert.deepStrictEqual(header.players.map((p) => [p.id, p.bot]), [['p1', 'p1'], ['p2', 'p2']]);
        const out = events.map((e) => JSON.stringify(e)).join('\n');
        for (const id of [raw.tags.P1Id, raw.tags.P2Id]) {
            assert.ok(!out.includes(id), `player id ${id} leaked`);
        }
        assert.ok(!out.includes('sha256:'), 'a hashed id leaked');

        // every keyframe the file carries is reproduced by folding the records before it (deck counts included)
        const keyframes = raw.EVENTS.filter((e) => e.keyframe).length;
        assert.strictEqual(report.keyframes, keyframes);
        assert.deepStrictEqual(report.keyframeMismatches, []);
        assert.deepStrictEqual(report.unknownTypes, {});
        assert.deepStrictEqual(report.ignored, []);

        // numbered actions: the reference renderer's %%% STORY numbers exactly the action-window decisions, same seats
        const numbered = raw.STORY.map((l) => /^\s*\d+\. Player ([12]) /.exec(l)).filter(Boolean).map((m) => `p${m[1]}`);
        const top = st.filter((s) => s.prompt === 'actionWindow|-');
        assert.deepStrictEqual(top.map((s) => s.pid), numbered);

        // every other decision is a CHOICE / MODAL_CHOICE, a mulligan or keep, or a setup/regroup resource
        const ev = raw.EVENTS;
        const other = ev.filter((e) => e.t === 'CHOICE' || e.t === 'MODAL_CHOICE' || e.t === 'MULLIGAN' || e.t === 'KEEP_HAND' ||
            (e.t === 'RESOURCE' && /^R\d+\.[SG]\./.test(e.seq))).length;
        assert.strictEqual(st.filter((s) => s.synthetic).length, 0, 'every decision in the vectors is recorded');
        assert.strictEqual(st.length - 1, numbered.length + other);
        assert.deepStrictEqual(st.map((s) => s.n), st.map((_, k) => k));

        // the end
        const result = { P1: 'p1', P2: 'p2', Draw: 'draw', Incomplete: null }[raw.tags.Result];
        assert.strictEqual(end.t, 'end');
        assert.strictEqual(end.winner, result);
        assert.strictEqual(end.steps, st.length - 1);
        assert.strictEqual(end.round, Number(raw.tags.Rounds));
        const gameEnd = ev.find((e) => e.t === 'GAME_END');
        if (gameEnd) {
            assert.strictEqual(end.winner, `p${gameEnd.winner}`);
            assert.strictEqual(end.outcome, 'won');
            assert.strictEqual(end.how, 'concede');
        } else {
            assert.strictEqual(end.outcome, 'STUCK');
        }
    });

    test(`swupgn ${name}: snapshots are consistent at every step`, () => {
        const text = read(name);
        const raw = rawSections(text);
        const { events, report } = convertSwuPgn(text);
        const linked = convertSwuPgn(text).doc.events; // same records, in file order
        const cardName = new Map(raw.CARDS.map((c) => [c.id, c.name]));
        const deckTotal = raw.DECKS.reduce((a, d) => a + d.deck.reduce((b, [, n]) => b + n, 0), 0);
        const leaders = new Set([raw.tags.P1Leader, raw.tags.P2Leader].map((id) => id.replace('#', '_')));
        const firstKf = raw.EVENTS.find((e) => e.keyframe).keyframe;
        let prevRound = 0;
        steps(events).forEach((s, k) => {
            const { state } = s;
            const at = `step ${s.n}`;
            assert.ok(['setup', 'action', 'regroup'].includes(state.phase), at);
            assert.ok(state.round >= prevRound, `${at}: round went back`);
            prevRound = state.round;
            let cards = 0;
            for (const seat of ['p1', 'p2']) {
                const p = state.players[seat];
                assert.ok(p.deck >= 0 && p.res.ready >= 0 && p.res.ready <= p.res.total && p.base.d >= 0, `${at} ${seat}: counts`);
                assert.ok(p.hand.every((c) => !c.hid), `${at} ${seat}: hidden card in an omniscient file`);
                const units = [...p.ground, ...p.space];
                assert.ok(units.every((u) => u.d >= 0 && u.h > 0), `${at} ${seat}: unit stats`);
                // units match the MOVE records up to this step's cut, by name and seat
                const seatNo = Number(seat[1]);
                const fromEvents = [...arenaFromEvents(linked, report.trace[k].cut)].filter(([, p]) => p === seatNo)
                    .map(([id]) => cardName.get(id.replace(/:\d+$/, ''))).sort();
                assert.deepStrictEqual(units.map((u) => u.n).sort(), fromEvents, `${at} ${seat}: units in play`);
                // conservation: every deck card is in exactly one place (hand, deck, discard, resources, play, attached, captive)
                const printed = (r) => r.s !== null && !leaders.has(r.s);
                cards += p.hand.length + p.deck + p.discard.length + p.res.total + units.filter(printed).length +
                    units.flatMap((u) => u.u ?? []).filter((r) => r.t === 0 && printed(r)).length + units.flatMap((u) => u.cap ?? []).length;
            }
            assert.strictEqual(cards, deckTotal, `${at}: cards lost or duplicated`);
        });
        const [s0, s1] = steps(events);
        // the opening board, before any decision: full decks, empty hands, real base HP, leaders in the base zone
        for (const seat of [1, 2]) {
            const p = s0.state.players[`p${seat}`];
            assert.strictEqual(p.deck, raw.SETUP[0][`p${seat}DeckOrder`].length);
            assert.strictEqual(p.hand.length, 0);
            assert.strictEqual(p.base.hp, firstKf.players[seat].baseMaxHp);
            assert.deepStrictEqual([p.leader.s, p.leader.dep], [raw.tags[`P${seat}Leader`].replace('#', '_'), 0]);
        }
        // the first decision picks who starts with the initiative; the first keyframe agrees
        assert.strictEqual(s1.prompt, 'initiative|-');
        assert.strictEqual(s1.state.initiative, `p${firstKf.initiative}`);
    });
}

const stepAfter = (events, re) => steps(events).find((s) => (s.log ?? []).some((l) => re.test(l)));
const unit = (state, seat, n) => [...state.players[seat].ground, ...state.players[seat].space].filter((u) => u.n === n);

test('swupgn: attacks are two clicks, attacker then target; the old board shows after the first', () => {
    const { events } = convertSwuPgn(read('organic'));
    const st = steps(events);
    const k = st.findIndex((s) => s.seq === 'R2.A.1');
    assert.deepStrictEqual([st[k].pid, st[k].prompt, st[k].action], ['p1', 'actionWindow|-', { kind: 'card', label: 'Death Star Stormtrooper' }]);
    assert.deepStrictEqual([st[k + 1].prompt, st[k + 1].title, st[k + 1].action], ['-|single', 'Choose a target for attack', { kind: 'card', label: "Administrator's Tower" }]);
    assert.strictEqual(st[k].state.players.p2.base.d, 0);
    assert.strictEqual(st[k + 1].state.players.p2.base.d, 3);
    assert.strictEqual(unit(st[k + 1].state, 'p1', 'Death Star Stormtrooper')[0].x, 1);
    assert.deepStrictEqual(st[k + 1].log, ["p1 attacks p2's base with Death Star Stormtrooper #3", "3 damage to p2's base - 27 HP left"]);
});

test('swupgn: a captured unit sits under its captor and comes back when rescued', () => {
    const { events } = convertSwuPgn(read('capture'));
    const taken = stepAfter(events, /captures Death Star Stormtrooper/);
    assert.deepStrictEqual(unit(taken.state, 'p1', 'Battlefield Marine')[0].cap, [{ n: 'Death Star Stormtrooper', s: 'SOR_128' }]);
    assert.strictEqual(unit(taken.state, 'p2', 'Death Star Stormtrooper').length, 1);
    const rescued = stepAfter(events, /rescues Death Star Stormtrooper/);
    assert.strictEqual(unit(rescued.state, 'p1', 'Battlefield Marine').length, 0);
    assert.strictEqual(unit(rescued.state, 'p2', 'Death Star Stormtrooper').length, 2);
    assert.ok(rescued.state.players.p1.discard.some((c) => c.n === 'Battlefield Marine'));
});

test('swupgn: a pilot is an upgrade on its vehicle, never a unit of its own', () => {
    const { events } = convertSwuPgn(read('pilot'));
    const flown = stepAfter(events, /plays Academy Graduate on Alliance X-Wing/);
    assert.deepStrictEqual(flown.action, { kind: 'card', label: 'Alliance X-Wing' }); // the CHOICE of vehicle
    assert.deepStrictEqual(unit(flown.state, 'p1', 'Alliance X-Wing')[0].u, [{ n: 'Academy Graduate', s: 'JTL_058', t: 0 }]);
    assert.strictEqual(unit(flown.state, 'p1', 'Academy Graduate').length, 0);
    const mode = steps(events)[steps(events).indexOf(flown) - 1];
    assert.deepStrictEqual([mode.prompt, mode.action, mode.legal], ['-|-', { kind: 'button', label: 'Play Academy Graduate with Piloting' }, 3]);
});

test('swupgn: token upgrades are counted on their host and leave with it', () => {
    const { events } = convertSwuPgn(read('upgrades'));
    const viper = stepAfter(events, /plays Cloaked StarViper/);
    assert.deepStrictEqual(unit(viper.state, 'p1', 'Cloaked StarViper')[0].u, [{ n: 'Shield', s: null, t: 1 }, { n: 'Shield', s: null, t: 1 }]);
    const soldier = unit(viper.state, 'p1', 'Zealous Soldier')[0];
    assert.deepStrictEqual(soldier.u.map((u) => [u.n, u.t]), [['Ascension Cable', 0], ['Experience', 1], ['Advantage', 1]]);
    const shot = stepAfter(events, /Zealous Soldier #2 is defeated/);
    assert.strictEqual(unit(shot.state, 'p1', 'Zealous Soldier').length, 0);
    assert.deepStrictEqual(shot.state.players.p1.discard.map((c) => c.n), ['Ascension Cable', 'Zealous Soldier']);
});

test('swupgn: a file without `for` links gives the same steps (older 1.0 writers)', () => {
    const text = read('organic');
    const stripped = text.split('\n').map((l) => (l.startsWith('{"seq"') ? JSON.stringify((({ for: _, ...e }) => e)(JSON.parse(l))) : l)).join('\n');
    assert.ok(!stripped.includes('"for"'));
    const pick = (events) => steps(events).map((s) => [s.pid, s.prompt, s.action, s.state]);
    assert.deepStrictEqual(pick(convertSwuPgn(stripped).events), pick(convertSwuPgn(text).events));
});

test('swupgn: perspective-scoped files say which hand is hidden and blank its unknown cards', () => {
    const text = read('minimal').replace('[Rounds "2"]', '[Rounds "2"] [Perspective "P1"]')
        .replace(/"2":\{"seat":2,("baseHp":30,"baseMaxHp":30,"handSize":1),"hand":\["SOR#045"\]/, '"2":{"seat":2,$1,"hand":[]');
    const { events, report } = convertSwuPgn(text);
    assert.deepStrictEqual([events[0].source.pov, events[0].source.hiddenHands], ['p1', ['p2']]);
    const first = steps(events).find((s) => s.state.round === 1 && s.state.phase === 'action');
    assert.deepStrictEqual(first.state.players.p2.hand, [{ n: 'Hidden card', s: null, hid: 1 }]);
    assert.ok(report.keyframeMismatches.some((m) => m.path === 'players.2.hand'));
});

test('swupgn: a keyframe missing a count the board needs is damaged, and folding carries on', () => {
    const text = read('minimal').split('\n').map((l) => (l.startsWith('{"seq":"R1.end"') ? l.replace('"seat":1,"baseHp":30,"baseMaxHp":30,', '"seat":1,"baseHp":30,') : l)).join('\n');
    assert.notStrictEqual(text, read('minimal'));
    const { events, report } = convertSwuPgn(text);
    assert.deepStrictEqual(report.damagedKeyframes, ['R1.end']);
    assert.strictEqual(report.keyframes, 2);
    assert.deepStrictEqual(report.keyframeMismatches, []);
    for (const st of steps(events)) {
        for (const seat of ['p1', 'p2']) {
            assert.strictEqual(st.state.players[seat].base.hp, 30);
            assert.ok(Number.isFinite(st.state.players[seat].base.d));
        }
    }
});

test('swupgn: a keyframe without a round, phase or initiative is damaged too', () => {
    const { isCompleteKeyframe } = require('../swupgn');
    const kf = parseSwuPgn(read('minimal')).events.find((e) => e.seq === 'R1.end').keyframe;
    assert.ok(isCompleteKeyframe(kf));
    for (const key of ['round', 'phase', 'initiative']) {
        const { [key]: _, ...rest } = kf;
        assert.ok(!isCompleteKeyframe(rest), `no ${key}`);
    }
    assert.ok(isCompleteKeyframe({ ...kf, initiative: null }), 'null initiative is allowed');
    assert.ok(!isCompleteKeyframe({ ...kf, initiative: 3 }));
});

test('swupgn: reader errors and leniency follow the spec', () => {
    const text = read('minimal');
    assert.ok(isSwuPgn(text));
    assert.ok(!isSwuPgn('{"events": []}'));
    assert.throws(() => parseSwuPgn(text.replace(/\[Result "[^"]*"\]/, '')), /missing required header tag \[Result\]/);
    assert.throws(() => parseSwuPgn(text.replace('SWU-PGN/1.0', 'SWU-PGN/2.0')), /unsupported version/);
    assert.throws(() => parseSwuPgn(text.replace('%%% STORY', '{"t":"PASS"}\n%%% STORY')), /record before any %%% section/);
    assert.throws(() => parseSwuPgn(text.replace('{"seq":"R1.A.2","t":"PASS","p":2}', '{"seq":')), /invalid JSON on line/);
    // a newer minor version: unknown sections, record types and fields are ignored; a malformed MOVE is skipped
    const newer = text.replace('SWU-PGN/1.0', 'SWU-PGN/1.7').replace('%%% ANNOTATIONS', '%%% REPLAYS\n{"x":1}\n%%% ANNOTATIONS')
        .replace('{"seq":"R1.A.2","t":"PASS","p":2}', '{"seq":"R1.A.2","t":"PASS","p":2,"extra":1}\n{"seq":"R1.A.2a","t":"FUTURE_THING","p":2}\n{"seq":"R1.A.2b","t":"MOVE","card":"SOR#045","from":"hand","to":"hand","p":2}');
    const { events, report } = convertSwuPgn(newer);
    assert.deepStrictEqual(report.unknownTypes, { FUTURE_THING: 1 });
    assert.deepStrictEqual(report.ignored, [{ seq: 'R1.A.2b', why: 'bad MOVE' }]);
    assert.deepStrictEqual(steps(events).map((s) => s.state), steps(convertSwuPgn(text).events).map((s) => s.state));
    // a capture reader handed a .swupgn says what to do instead
    assert.throws(() => readText(text), /SWU-PGN game file/);
});

test('swupgn: analysis keeps every view for an omniscient import', () => {
    const { usableViews, ALL_VIEWS } = require('../../analysis/analyze');
    const header = convertSwuPgn(read('organic')).events[0];
    assert.deepStrictEqual(usableViews({ header }, ALL_VIEWS), ALL_VIEWS);
});

test('swupgn: node importer/import.js game.swupgn --out dir --keep-file-names', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'swupgn-'));
    try {
        const log = execFileSync(process.execPath, [path.join(ROOT, 'importer', 'import.js'), path.join(DIR, 'organic.swupgn'), path.join(DIR, 'minimal.swupgn'), '--out', out, '--keep-file-names'], { encoding: 'utf8' });
        assert.match(log, /organic: swu-pgn \(9 keyframes, 0 mismatches\), \d+ records -> 67 steps, pov both, winner p1/);
        const index = JSON.parse(fs.readFileSync(path.join(out, 'index.json'), 'utf8'));
        const organic = index.games.find((g) => g.id === 'organic');
        assert.deepStrictEqual([organic.winnerSeat, organic.steps, organic.rounds, organic.outcome, organic.pov], ['p1', 67, 5, 'won', 'both']);
        assert.deepStrictEqual(index.games.find((g) => g.id === 'minimal').winnerSeat, null);
        const lines = fs.readFileSync(path.join(out, 'games', 'organic.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        assert.deepStrictEqual([lines[0].t, lines[1].label, lines[lines.length - 1].t], ['header', 'Game start', 'end']);
        assert.strictEqual(lines[0].source.file, 'organic.swupgn');
    } finally {
        fs.rmSync(out, { recursive: true, force: true });
    }
});
