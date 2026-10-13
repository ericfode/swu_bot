#!/usr/bin/env node
/** Capture the visible, deterministic animation-preview UI. No private app APIs. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { effectSourceManifest } from './effect-source-manifest.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.resolve(option('out', path.join(repository, 'results/card-effects-review')));
const url = option('url', 'http://127.0.0.1:5190/#/effects');
const require = createRequire(import.meta.url);
const playwrightModule = option('playwright', process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const executablePath = option('browser', process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE);
const viewportParts = option('viewport', '1440x1100').split('x').map(Number);
if (viewportParts.length !== 2 || viewportParts.some(n => !Number.isInteger(n) || n < 240)) throw new Error('Use --viewport WIDTHxHEIGHT, with dimensions at least 240.');
const viewport = { width: viewportParts[0], height: viewportParts[1] };
const selectedSlugs = option('cards', '').split(',').filter(Boolean);
const stage = option('stage', 'play');
if (!['play', 'regroup-start', 'next-action', 'phase-end'].includes(stage)) throw new Error('Use --stage play, regroup-start, next-action or phase-end.');
if (args.includes('--help')) {
    console.log('Usage: node studio/scripts/capture-effects.mjs [--url URL] [--out DIRECTORY] [--playwright MODULE_PATH] [--browser EXECUTABLE] [--viewport WIDTHxHEIGHT] [--cards comma,separated,slugs] [--stage play|regroup-start|next-action|phase-end]\n\nUses installed Playwright and Chromium; never installs dependencies.\nPLAYWRIGHT_MODULE and PLAYWRIGHT_CHROMIUM_EXECUTABLE are equivalent environment options.\nDefaults: http://127.0.0.1:5190/#/effects, results/card-effects-review, 1440x1100, all catalogue cards, play stage, installed playwright module/browser.');
    process.exit(0);
}
let chromium;
try {
    ({ chromium } = require(playwrightModule));
} catch {
    throw new Error('Playwright is not installed here. Supply --playwright /path/to/playwright or PLAYWRIGHT_MODULE pointing to an existing installation.');
}
const phases = [ ['anticipation', 18], ['impact', 46], ['outcome', 72], ['settle', 90], ['final-board', 100] ];
// The tall mobile board can scroll underneath the external sticky navigation.
// Hide only that navigation in cropped board images; full-page shots remain unmodified.
const boardScreenshotOptions = { animations: 'allow', style: 'nav.sticky { visibility: hidden !important; }' };
const escapeHtml = value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const hash = image => createHash('sha256').update(image).digest('hex');

await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
const logs = [];
page.on('pageerror', error => logs.push({ type: 'pageerror', message: error.message }));
page.on('console', message => { if (['error', 'warning'].includes(message.type())) logs.push({ type: message.type(), message: message.text() }); });
const buildManifestUrl = new URL('effect-source-manifest.json', url).href;
async function readBuildManifest() {
    try {
        const response = await page.request.get(buildManifestUrl);
        if (!response.ok()) return null;
        const result = await response.json();
        if (result.sourceHashes && result.sourceFingerprint === hash(JSON.stringify(result.sourceHashes))) return result;
        return null;
    } catch { return null; }
}
const builtSource = await readBuildManifest();
const manifest = { ...(builtSource ?? effectSourceManifest()), sourceOrigin: builtSource ? 'served-build' : 'working-tree',
    url, capturedAt: new Date().toISOString(), viewport, stage, phases, boardCaptureStyle: boardScreenshotOptions.style, cards: [], logs };
try {
    await page.goto(url);
    await page.locator('.effects-card-pick').first().waitFor();
    await page.getByRole('slider', { name: 'Animation progress', exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.locator('.effects-card-art img').evaluateAll(imgs => Promise.all(imgs.map(img => img.decode().catch(() => {}))));
    const names = await page.locator('.effects-card-pick strong').allTextContents();
    if (!names.length) throw new Error('No cards are available to review.');
    const unknownSlugs = selectedSlugs.filter(slug => !names.some(name => slugify(name) === slug));
    if (unknownSlugs.length) throw new Error(`Unknown card slugs: ${unknownSlugs.join(', ')}`);
    for (const [index, name] of names.entries()) {
        const slug = slugify(name);
        if (selectedSlugs.length && !selectedSlugs.includes(slug)) continue;
        const dir = path.join(output, slug);
        await fs.mkdir(dir, { recursive: true });
        await page.locator('.effects-card-pick').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).click();
        if (stage !== 'play') {
            const boundaryLabel = stage === 'next-action'
                ? (slug === 'give-in-to-your-anger' ? 'Next P2 action' : 'Later action')
                : stage === 'phase-end' ? 'Action phase ends' : 'Regroup begins';
            const boundary = page.getByRole('button', { name: boundaryLabel, exact: true });
            if (await boundary.count() !== 1) throw new Error(`${name}: no authored ${stage} boundary is available`);
            await boundary.click();
        }
        await page.locator('.effects-theatre').scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        await page.waitForTimeout(550);
        const example = await page.locator('.effects-example').textContent();
        const record = { index: index + 1, name, slug, example, frames: [], freezeStable: null, naturalMatchesHeld: null, finalBoard: null };
        const readFreezeState = () => page.locator('.effects-board').evaluate(board => {
            const bounds = board.getBoundingClientRect();
            return {
                title: document.querySelector('.effects-feature h2')?.textContent,
                caption: board.querySelector('.ce-caption strong')?.textContent,
                progress: board.querySelector('[data-effect-progress]')?.getAttribute('data-effect-progress'),
                board: { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height },
                boxes: [...board.querySelectorAll('[data-effect-card],.ce-caption,.ce-card-ghost')].map(element => {
                    const r = element.getBoundingClientRect();
                    return { id: element.getAttribute('data-effect-id'), className: element.getAttribute('class'),
                        x: r.x - bounds.x, y: r.y - bounds.y, w: r.width, h: r.height };
                })
            };
        });
        const readBoard = () => page.locator('.effects-board [data-effect-seat]').evaluateAll(sides => sides.map(side => ({
            seat: side.getAttribute('data-effect-seat'),
            zones: Object.fromEntries(['ground', 'space', 'hand'].map(zone => [zone, [...side.querySelectorAll(`[data-effect-zone="${zone}"] [data-effect-card]`)].map(card => ({ id: card.getAttribute('data-effect-id'), name: card.getAttribute('data-effect-card'), text: card.textContent, exhausted: card.classList.contains('exh') }))])),
            base: side.querySelector('[aria-label^="Base HP"]')?.getAttribute('aria-label'),
            deck: side.querySelector('[data-effect-zone="deck"]')?.textContent,
            discard: side.querySelector('[data-effect-zone="discard"]')?.textContent,
            resources: side.querySelector('[data-effect-zone="resources"]')?.getAttribute('aria-label')
        })));
        for (const [phase, progress] of phases) {
            const slider = page.getByRole('slider', { name: 'Animation progress', exact: true });
            await slider.evaluate((input, value) => {
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                setter.call(input, String(value));
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }, progress);
            if (await slider.inputValue() !== String(progress)) throw new Error(`${name}: scrubber did not hold ${progress}`);
            await page.waitForTimeout(450);
            const identity = await page.locator('.effects-feature h2').textContent();
            const final = progress === 100;
            const caption = final ? identity : await page.locator('.ce-caption strong').textContent();
            const heldProgress = final ? 1 : Number(await page.locator('[data-effect-progress]').getAttribute('data-effect-progress'));
            if (final && await page.locator('.card-effect-overlay').count()) throw new Error(`${name}: final board still has an effect overlay`);
            if (identity !== name || caption !== name || Math.abs(heldProgress - progress / 100) > .0001) {
                throw new Error(`${name}: preview changed during capture (feature=${identity}, caption=${caption}, progress=${heldProgress}); recapture after the app stops reloading.`);
            }
            const freezeBefore = phase === 'settle' ? await readFreezeState() : null;
            const filename = `${phase}-${progress}.png`;
            const bytes = await page.locator('.effects-board').screenshot({ ...boardScreenshotOptions, path: path.join(dir, filename) });
            record.frames.push({ phase, progress, file: `${slug}/${filename}`, sha256: hash(bytes) });
            if (final) record.finalBoard = await readBoard();
            if (phase === 'impact') {
                await page.screenshot({ path: path.join(dir, 'full-page.png'), fullPage: true, animations: 'allow' });
            }
            if (phase === 'settle') {
                await page.waitForTimeout(250);
                const repeatFile = `${slug}/settle-90-repeat.png`;
                const held = await page.locator('.effects-board').screenshot({ ...boardScreenshotOptions, path: path.join(output, repeatFile) });
                const freezeAfter = await readFreezeState();
                record.freezeStable = hash(held) === hash(bytes);
                record.freezeEvidence = { originalSha256: hash(bytes), repeatSha256: hash(held), repeatFile, before: freezeBefore, after: freezeAfter };
                if (freezeAfter.title !== name || freezeAfter.caption !== name || Math.abs(Number(freezeAfter.progress) - .9) > .0001) {
                    throw new Error(`${name}: selection or progress changed during the held repeat`);
                }
            }
        }
        await page.getByRole('button', { name: 'Replay effect', exact: true }).click();
        await page.mouse.move(0, 0);
        await page.locator('.effects-board [data-effect-state="animating"]').waitFor();
        await page.locator('.effects-board [data-effect-state="settled"]').waitFor({ timeout: 8000 });
        await page.mouse.move(0, 0);
        await page.waitForTimeout(550);
        const natural = await readBoard();
        record.naturalMatchesHeld = JSON.stringify(natural) === JSON.stringify(record.finalBoard);
        if (!record.naturalMatchesHeld) throw new Error(`${name}: natural animation completion differs from the held final board`);
        await page.locator('.effects-board').screenshot({ ...boardScreenshotOptions, path: path.join(dir, 'natural-completion.png') });
        const sheet = await browser.newPage({ viewport: { width: Math.min(1840, viewport.width * 2 + 60), height: 1100 }, deviceScaleFactor: 1 });
        const cells = await Promise.all(record.frames.map(async frame => {
            const image = await fs.readFile(path.join(output, frame.file));
            return `<figure><figcaption>${escapeHtml(frame.phase)} <span>${frame.progress}%</span></figcaption><img src="data:image/png;base64,${image.toString('base64')}" /></figure>`;
        }));
        await sheet.setContent(`<style>*{box-sizing:border-box}body{margin:0;padding:24px;background:#080d16;color:#e6edf8;font:16px system-ui}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}h1{margin:0;font-size:28px}small{color:#9aaac2}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}figure{margin:0;border:1px solid #3b4b63;background:#101b2a;border-radius:8px;overflow:hidden}figcaption{padding:9px 12px;text-transform:uppercase;font-size:13px;letter-spacing:.13em}figcaption span{float:right;color:#9aaac2}img{width:100%;height:auto;display:block}</style><header><div><h1>${String(index + 1).padStart(2, '0')} · ${escapeHtml(name)}</h1><small>${escapeHtml(example ?? '')}</small></div><small>Staged board · four animation frames + completed board</small></header><main class="grid">${cells.join('')}</main>`);
        await sheet.locator('img').evaluateAll(imgs => Promise.all(imgs.map(img => img.decode())));
        await sheet.screenshot({ path: path.join(output, `${String(index + 1).padStart(2, '0')}-${slug}-contact.png`), fullPage: true });
        await sheet.close();
        manifest.cards.push(record);
        await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
        console.log(`${index + 1}/${names.length} ${name}: 4 phases + completed board; natural completion ${record.naturalMatchesHeld ? 'matches' : 'DIFFERS'}; held pixels ${record.freezeStable ? 'stable' : 'changed'}`);
    }
    const endSource = builtSource ? await readBuildManifest() : effectSourceManifest();
    if (endSource?.sourceFingerprint !== manifest.sourceFingerprint) throw new Error('The served build or development sources changed during capture; preserve these images as incomplete and recapture.');
    const contacts = manifest.cards.map(card => `<article><h2>${card.index}. ${escapeHtml(card.name)}</h2><a href="${String(card.index).padStart(2,'0')}-${card.slug}-contact.png"><img loading="lazy" src="${String(card.index).padStart(2,'0')}-${card.slug}-contact.png" /></a><p>${card.frames.map(frame => `<a href="${frame.file}">${frame.phase} ${frame.progress}%</a>`).join(' · ')} · <a href="${card.slug}/full-page.png">Full page</a></p></article>`).join('');
    await fs.writeFile(path.join(output, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Card effects · visual review</title><style>body{max-width:1600px;margin:32px auto;padding:0 24px;background:#080d16;color:#e6edf8;font:16px system-ui}article{margin:36px 0}img{width:100%;border-radius:12px}a{color:#9bcaff}p{line-height:1.7}</style><h1>Card effects</h1><p>Four animation frames plus the completed board per card; natural completion checked against the held result. Captured from the staged animation showcase at ${viewport.width}×${viewport.height}.</p>${contacts}`);
    console.log(JSON.stringify({ output, cards: manifest.cards.length, frames: manifest.cards.reduce((n,c)=>n+c.frames.length,0), unstable: manifest.cards.filter(c=>!c.freezeStable).map(c=>c.name), logs }, null, 2));
} finally {
    await browser.close();
}
