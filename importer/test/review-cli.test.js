'use strict';

// Review fixes for the importer command lines (import.js, capture.js): ids never come from file names, which often
// hold usernames; directories pick up .karareplay files; a reversed --seeds range is rejected.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { importFile, importPair } = require('../import');
const { toKaraBuddy } = require('./formats');

// The tiny game of importer.test.js, in Karabast's gamestate shape (Game.getState as player "u1" sees it).
const card = (uuid, name, set, number, extra = {}) => ({ id: `id-${uuid}`, setId: { set, number }, uuid, name, controllerId: extra.controllerId ?? 'u1', ownerId: extra.controllerId ?? 'u1', ...extra });
const hidden = (owner) => ({ controllerId: owner, ownerId: owner, zone: 'hand' });
const P = (id) => ({ type: 'player', id, name: id === 'u1' ? 'alice' : 'bob', uuid: `Player_${id}` });
const C = (c) => ({ type: 'card', name: c.name, uuid: c.uuid, setId: c.setId, controllerId: c.controllerId });
const msg = (date, message) => ({ date, message });

function player(id, o = {}) {
    return {
        id, name: id === 'u1' ? 'alice' : 'bob', user: { id, username: id === 'u1' ? 'alice' : 'bob' },
        hasInitiative: false, availableResources: 0, numCardsInDeck: 40, isActionPhaseActivePlayer: false,
        leaders: [card(`L${id}`, id === 'u1' ? 'Luke Skywalker' : 'Darth Vader', 'SOR', id === 'u1' ? 5 : 10, { type: 'leader', zone: 'base', controllerId: id, exhausted: false })],
        base: card(`B${id}`, id === 'u1' ? 'Echo Base' : 'Capital City', 'SOR', id === 'u1' ? 23 : 28, { type: 'base', hp: 30, damage: 0, controllerId: id }),
        cardPiles: { hand: [], resources: [], groundArena: [], spaceArena: [], discard: [], outsideTheGame: [], capturedZone: [], credits: [] },
        ...o
    };
}

function game() {
    const wampa = card('C1', 'Wampa', 'SOR', 42, { type: 'basicUnit', zone: 'hand' });
    const pilot = card('C2', 'Battlefield Marine', 'SOR', 95, { type: 'basicUnit', zone: 'hand' });
    const trooper = card('C9', 'Death Star Stormtrooper', 'SOR', 129, { controllerId: 'u2', type: 'basicUnit', zone: 'groundArena', power: 3, hp: 1, damage: 0, exhausted: false });
    const s0 = {
        id: 'g1', phase: 'setup', winners: [], players: {
            u2: player('u2', { cardPiles: { ...player('u2').cardPiles, hand: [hidden('u2'), hidden('u2')] } }),
            u1: player('u1', { hasInitiative: true, cardPiles: { ...player('u1').cardPiles, hand: [wampa, pilot] } })
        },
        newMessages: [msg('2026-10-01T12:00:00.100Z', [P('u1'), ' is shuffling their deck'])]
    };
    const s1 = structuredClone(s0);
    s1.phase = 'action';
    s1.players.u1.isActionPhaseActivePlayer = true;
    s1.players.u1.availableResources = 2;
    s1.players.u1.cardPiles.resources = [card('R1', 'Takedown', 'SOR', 77, { zone: 'resource' }), card('R2', 'Repair', 'SOR', 90, { zone: 'resource' })];
    s1.players.u2.cardPiles.resources = [{ controllerId: 'u2', zone: 'resource' }, { controllerId: 'u2', zone: 'resource' }];
    s1.players.u2.cardPiles.groundArena = [trooper];
    s1.newMessages = [msg('2026-10-01T12:00:00.900Z', { alert: { type: 'notification', message: ['Round: 1 - Action Phase'] } })];
    const s2 = structuredClone(s1);
    s2.players.u1.cardPiles.hand = [pilot];
    s2.players.u1.cardPiles.groundArena = [{ ...wampa, zone: 'groundArena', power: 4, hp: 5, damage: 0, exhausted: true }];
    s2.players.u1.availableResources = 0;
    s2.players.u1.isActionPhaseActivePlayer = false;
    s2.players.u2.isActionPhaseActivePlayer = true;
    s2.newMessages = [msg('2026-10-01T12:00:01.900Z', [P('u1'), ' plays ', C(wampa)])];
    const s3 = structuredClone(s2);
    s3.players.u2.cardPiles.groundArena[0].exhausted = true;
    s3.players.u1.cardPiles.groundArena[0].damage = 3;
    s3.players.u2.cardPiles.groundArena.push(card('T1', 'Shield', 'SOR', null, { controllerId: 'u2', type: 'tokenUpgrade', zone: 'groundArena', parentCardId: 'C9' }));
    s3.newMessages = [msg('2026-10-01T12:00:02.900Z', [P('u2'), ' attacks ', C(wampa), ' with ', C(trooper)])];
    const s4 = structuredClone(s3);
    s4.players.u2.base.damage = 4;
    s4.players.u2.isActionPhaseActivePlayer = false;
    s4.newMessages = [msg('2026-10-01T12:00:03.900Z', [P('u1'), ' attacks ', P('u2'), "'s base with ", C(wampa)])];
    const s5 = structuredClone(s4);
    s5.winners = ['alice'];
    s5.newMessages = [msg('2026-10-01T12:00:04.900Z', [P('u1'), ' has won the game'])];
    return [s0, s1, s2, s3, s4, s5];
}

// What bob (u2) sees of the same game: his own hand, alice's hand and resources as stubs.
function bobView(states) {
    return states.map((s) => {
        const v = structuredClone(s);
        const u1 = v.players.u1.cardPiles;
        u1.hand = u1.hand.map(() => hidden('u1'));
        u1.resources = u1.resources.map(() => ({ controllerId: 'u1', zone: 'resource' }));
        v.players.u2.cardPiles.hand = v.players.u2.cardPiles.hand.map((c, i) => card(`H${i}`, 'Wampa', 'SOR', 42, { controllerId: 'u2', type: 'basicUnit', zone: 'hand' }));
        return v;
    });
}

// KaraBuddy names manual downloads <time>_<leader>-<base>_<username>_vs_<leader>-<base>_<username>.karareplay
const KB_NAME = '261001-1200_Luke-Skywalker-Echo-Base_alice_vs_Darth-Vader-Capital-City_bob.karareplay';
const ROOT = path.join(__dirname, '..', '..');
const sha = (...bufs) => bufs.reduce((h, b) => h.update(b), crypto.createHash('sha1')).digest('hex').slice(0, 10);

function tmpDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-cli-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function write(dir, name, value) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
}

/** Every file name and file body under dir, as one string. */
function everything(dir) {
    return fs.readdirSync(dir, { recursive: true }).map((f) => {
        const p = path.join(dir, f);
        return fs.statSync(p).isFile() ? `${f}\n${fs.readFileSync(p, 'utf8')}` : f;
    }).join('\n');
}

test('import: the id is a hash of the file bytes, and the file name (usernames) is not written', (t) => {
    const dir = tmpDir(t);
    const file = write(dir, KB_NAME, toKaraBuddy(game()));
    const r = importFile(file, {});
    assert.strictEqual(r.id, `g-${sha(fs.readFileSync(file))}`);
    assert.match(r.id, /^g-[0-9a-f]{10}$/);
    assert.strictEqual(r.events[0].source.file, undefined);
    assert.ok(!/alice|bob/.test(JSON.stringify(r.events)), 'usernames leaked');

    // stable: the same bytes under another name give the same id; other bytes give another
    assert.strictEqual(importFile(write(dir, 'copy.json', fs.readFileSync(file, 'utf8')), {}).id, r.id);
    const g = game();
    g[4].players.u2.base.damage = 5;
    assert.notStrictEqual(importFile(write(dir, 'other.json', toKaraBuddy(g)), {}).id, r.id);
});

test('import --pair: the id is <hash>.both and neither file name is written', (t) => {
    const dir = tmpDir(t);
    const a = write(dir, 'alice.karareplay', toKaraBuddy(game()));
    const b = write(dir, 'bob.karareplay', toKaraBuddy(bobView(game())));
    const r = importPair(a, b, {});
    assert.strictEqual(r.report.merge.unmatched, 0);
    assert.strictEqual(r.id, `${sha(fs.readFileSync(a), fs.readFileSync(b))}.both`);
    assert.strictEqual(r.events[0].source.file, undefined);
    assert.strictEqual(r.events[0].source.pairedWith, undefined);
    assert.ok(!/alice|bob/.test(JSON.stringify(r.events)), 'usernames leaked');
});

test('import --keep-file-names: ids from the file name without its last extension', (t) => {
    const dir = tmpDir(t);
    const one = importFile(write(dir, 'rush-vs-random-1.p1.karareplay', toKaraBuddy(game())), { keepFileNames: true });
    assert.strictEqual(one.id, 'rush-vs-random-1.p1');
    assert.strictEqual(one.events[0].source.file, 'rush-vs-random-1.p1.karareplay');
    assert.strictEqual(importFile(write(dir, 'game 2.jsonl', toKaraBuddy(game())), { keepFileNames: true }).id, 'game-2');

    const a = write(dir, 'game.p1.karareplay', toKaraBuddy(game()));
    const b = write(dir, 'game.p2.karareplay', toKaraBuddy(bobView(game())));
    const pair = importPair(a, b, { keepFileNames: true });
    assert.strictEqual(pair.id, 'game.both');
    assert.strictEqual(pair.events[0].source.file, 'game.p1.karareplay');
    assert.strictEqual(pair.events[0].source.pairedWith, 'game.p2.karareplay');
});

const importCli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'importer', 'import.js'), ...args], { cwd: ROOT, encoding: 'utf8' });

test('import CLI: a directory picks up .karareplay files; no file name reaches the output', (t) => {
    const dir = tmpDir(t);
    const inDir = path.join(dir, 'in');
    const out = path.join(dir, 'out');
    fs.mkdirSync(inDir);
    const kb = write(inDir, KB_NAME, toKaraBuddy(game()));
    write(inDir, 'x.truth.jsonl', '{}');
    write(inDir, 'notes.md', 'not a capture');
    const res = importCli(inDir, '--out', out);
    assert.strictEqual(res.status, 0, res.stderr);
    const id = `g-${sha(fs.readFileSync(kb))}`;
    assert.deepStrictEqual(fs.readdirSync(path.join(out, 'games')), [`${id}.jsonl`]);
    const index = JSON.parse(fs.readFileSync(path.join(out, 'index.json'), 'utf8'));
    assert.deepStrictEqual(index.games.map((g) => g.id), [id]);
    assert.ok(!/alice|bob|karareplay/.test(everything(out)), 'file name leaked into the output');
    assert.ok(!/alice|bob/.test(res.stdout));

    // the same file again replaces its entry instead of adding one
    const again = importCli(kb, '--out', out);
    assert.strictEqual(again.status, 0, again.stderr);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(out, 'index.json'), 'utf8')).games.length, 1);
});

const engineReady = fs.existsSync(path.join(ROOT, 'forceteki', 'build', 'server')) &&
    fs.existsSync(path.join(ROOT, 'forceteki', 'test', 'json', '_cardMap.json'));

test('capture CLI: a reversed --seeds range is rejected with the usage message', { skip: !engineReady && 'needs forceteki/build and card data' }, (t) => {
    const out = path.join(tmpDir(t), 'cap');
    const res = spawnSync(process.execPath, [path.join(ROOT, 'importer', 'capture.js'), '--bots', 'rush,random', '--seeds', '5-3', '--out', out], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(res.status, 2);
    assert.match(res.stderr, /^usage: node importer\/capture\.js/);
    assert.ok(!fs.existsSync(out), 'nothing is created');
});
