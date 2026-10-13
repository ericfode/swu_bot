#!/usr/bin/env node
/** Check animation handoff against existing recordings; never starts games or reconstructs game truth. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { effectSourceManifest } from './effect-source-manifest.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
if (args.includes('--help')) {
    console.log('Usage: node studio/scripts/verify-effect-replays.mjs --cards canonical-id,canonical-id [--url http://127.0.0.1:5191] [--tournament demo] [--games DIRECTORY] [--out FILE] [--limit-per-card 1] [--playwright MODULE] [--browser EXECUTABLE]\n\nUses existing recordings and installed browser dependencies. Checks before, natural completion, Replay and backward seek against recorded snapshots. Reports requested cards with no recording separately. Requires the served build to match current effect source.');
    process.exit(0);
}
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const requested = option('cards', '').split(',').filter(Boolean);
assert.ok(requested.length, 'Supply --cards with canonical catalogue IDs.');
const url = option('url', 'http://127.0.0.1:5191');
const tournament = option('tournament', 'demo');
const gamesDirectory = path.resolve(option('games', path.join(repository, 'replays', tournament, 'games')));
const output = path.resolve(option('out', path.join(repository, 'results/card-effects-state-check/recorded-replays.json')));
const limit = Number(option('limit-per-card', '1'));
assert.ok(Number.isInteger(limit) && limit > 0, '--limit-per-card must be a positive integer.');
const { chromium } = require(option('playwright', process.env.PLAYWRIGHT_MODULE ?? 'playwright'));
const executablePath = option('browser', process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE);
const ts = require(path.join(repository, 'viewer/node_modules/typescript'));
const modules = new Map();
function loadTS(filename) {
    filename = path.resolve(filename);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const localRequire = createRequire(filename);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    new Function('require', 'module', 'exports', code)(specifier => specifier.startsWith('.')
        ? loadTS(path.resolve(path.dirname(filename), `${specifier}.ts`)) : localRequire(specifier), module, module.exports);
    return module.exports;
}
const { classifyGame } = loadTS(path.join(repository, 'studio/src/data/actions.ts'));
const { detectCardEffects } = loadTS(path.join(repository, 'studio/src/effects/detect.ts'));
const { CARD_EFFECTS } = loadTS(path.join(repository, 'studio/src/effects/catalogue.ts'));
for (const id of requested) assert.ok(CARD_EFFECTS.some(card => card.id === id), `Unknown catalogue ID: ${id}`);
const source = effectSourceManifest();
const cases = [];
const counts = new Map(requested.map(id => [id, 0]));
for (const filename of fs.readdirSync(gamesDirectory).filter(file => file.endsWith('.jsonl')).sort()) {
    const records = fs.readFileSync(path.join(gamesDirectory, filename), 'utf8').trim().split('\n').map(JSON.parse);
    const game = { header: records.find(record => record.t === 'header'), steps: records.filter(record => record.t === 'step'), end: records.find(record => record.t === 'end') };
    for (const [step, cue] of detectCardEffects(game, classifyGame(game))) {
        const id = cue.definition.id;
        if (!counts.has(id) || counts.get(id) >= limit) continue;
        cases.push({ filename, game, step, cue });
        counts.set(id, counts.get(id) + 1);
    }
    if ([...counts.values()].every(count => count >= limit)) break;
}
const expected = state => Object.fromEntries(['p1', 'p2'].map(seat => {
    const player = state.players[seat];
    const units = zone => player[zone].map(card => ({ id: card.id ?? null, name: card.n, power: card.p, hp: card.h - card.d,
        exhausted: !!card.x, tokens: (card.u ?? []).map(upgrade => upgrade.n).sort() }));
    return [seat, { ground: units('ground'), space: units('space'), base: `Base HP ${Math.max(0, player.base.hp - player.base.d)} of ${player.base.hp}`,
        hand: player.handCount ?? player.hand.length, deck: player.deck, discard: player.discard.length, resources: `${player.res.ready} of ${player.res.total} resources ready` }];
}));
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'no-preference' });
const report = { checkedAt: new Date().toISOString(), sourceFingerprint: source.sourceFingerprint, url, tournament, requested,
    missingRecordings: requested.filter(id => !counts.get(id)), tokenVerification: 'Upgrade names and counts; ordinary folded chips expand their visible title labels.', checks: [], errors: [], passed: false };
page.on('pageerror', error => report.errors.push(error.message));
const buildUrl = new URL('effect-source-manifest.json', url).href;
const readBuild = async () => {
    const response = await page.request.get(buildUrl);
    assert.ok(response.ok(), 'Serve a production build with effect-source-manifest.json.');
    return response.json();
};
const actual = () => page.locator('[data-effect-state] [data-effect-seat]').evaluateAll(sides => Object.fromEntries(sides.map(side => {
    // Main nests the damage badge inside HP. The direct text is remaining HP; concatenating both lies.
    const remainingHp = card => {
        const stat = card.querySelector('.stat.hp');
        const text = stat && [...stat.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim();
        return text ? Number(text) : NaN;
    };
    const upgrades = card => [...card.querySelectorAll('.up')].flatMap(upgrade => {
        // Explicit effect boards expose every physical chip. Ordinary boards fold equal names and overflow groups.
        const physical = upgrade.getAttribute('data-effect-upgrade');
        if (physical) return [physical];
        const title = upgrade.getAttribute('title')?.replace(/ · (?:owner|control) .*/, '') ?? '';
        return title.split(/,\s*/).flatMap(label => {
            const group = /^(.*) ×(\d+)$/.exec(label);
            return group ? Array(Number(group[2])).fill(group[1]) : [label];
        });
    }).sort();
    const units = zone => [...side.querySelectorAll(`[data-effect-zone="${zone}"] [data-effect-card]`)].map(card => ({
        id: card.getAttribute('data-effect-id'), name: card.getAttribute('data-effect-card'), power: Number(card.querySelector('.stat.pw')?.textContent),
        hp: remainingHp(card), exhausted: card.classList.contains('exh'), tokens: upgrades(card)
    }));
    return [side.getAttribute('data-effect-seat'), { ground: units('ground'), space: units('space'),
        base: side.querySelector('[aria-label^="Base HP"]')?.getAttribute('aria-label'),
        hand: Number(side.querySelector('[data-effect-zone="hand-count"]')?.textContent), deck: Number(side.querySelector('[title="Cards in deck"]')?.textContent),
        discard: Number(side.querySelector('[title="Cards in discard"]')?.textContent), resources: side.querySelector('[data-effect-zone="resources"]')?.getAttribute('aria-label') }];
})));
try {
    assert.equal((await readBuild()).sourceFingerprint, source.sourceFingerprint, 'Build and expected-state source differ; finish source edits and rebuild before verification.');
    assert.ok(cases.length, 'No requested card has an existing recording; this is not a replay verification pass.');
    for (const { filename, game, step, cue } of cases) {
        const id = cue.definition.id;
        const route = `/#/t/${encodeURIComponent(tournament)}/g/${encodeURIComponent(filename.replace(/\.jsonl$/, ''))}?step=${step - 1}`;
        await page.goto(new URL(route, url).href);
        await page.getByRole('button', { name: 'Next decision', exact: true }).click();
        await page.locator(`.ce-${id}`).waitFor();
        assert.deepEqual(await actual(), expected(cue.transition.before), `${id}: before snapshot during animation`);
        await page.locator('[data-effect-state="settled"]').waitFor({ timeout: cue.definition.durationMs + 3000 });
        await page.waitForTimeout(150);
        assert.deepEqual(await actual(), expected(cue.transition.after), `${id}: recorded ending after natural completion`);
        await page.getByRole('button', { name: 'Replay effect', exact: true }).click();
        await page.locator(`.ce-${id}`).waitFor();
        assert.deepEqual(await actual(), expected(cue.transition.before), `${id}: Replay restores before`);
        await page.getByRole('button', { name: 'Previous decision', exact: true }).click();
        await page.waitForTimeout(400);
        assert.deepEqual(await actual(), expected(game.steps[step - 1].state), `${id}: backward seek restores recorded state`);
        report.checks.push({ card: id, game: filename, step, before: true, after: true, replay: true, seek: true });
    }
    assert.deepEqual(report.errors, []);
    assert.equal((await readBuild()).sourceFingerprint, source.sourceFingerprint, 'Served build changed during verification.');
    report.passed = true;
} catch (error) {
    report.failure = error.stack ?? String(error);
    process.exitCode = 1;
} finally {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    await browser.close();
}
console.log(`${report.passed ? 'PASS' : 'FAIL'}: ${report.checks.length} recorded plays; ${report.missingRecordings.length} requested cards have no recording.\n${output}`);
if (report.failure) console.error(report.failure);
