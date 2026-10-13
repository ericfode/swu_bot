#!/usr/bin/env node
/** Render the actual Web Audio graph silently, export WAVs, and exercise the showcase sound controls. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.resolve(option('out', path.join(repository, 'results/card-effects-audio')));
const url = option('url', 'http://127.0.0.1:5190/#/effects');
const require = createRequire(import.meta.url);
const playwrightModule = option('playwright', process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const executablePath = option('browser', process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE);
if (args.includes('--help')) {
    console.log('Usage: node studio/scripts/render-effect-audio.mjs [--url URL] [--out DIRECTORY] [--playwright MODULE_PATH] [--browser EXECUTABLE] [--skip-ui]\n\nRequires the local Vite dev server and installed Playwright/Chromium. Never downloads dependencies or plays audio through hardware. Exports 20 stereo 48 kHz WAV files, metrics.json, and an audition page.');
    process.exit(0);
}
let chromium;
try { ({ chromium } = require(playwrightModule)); }
catch { throw new Error('Supply --playwright /path/to/playwright or PLAYWRIGHT_MODULE pointing to an existing installation.'); }
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath, args: ['--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const report = { capturedAt: new Date().toISOString(), url, sampleRate: 48000, volume: 1, hardwarePlayback: false, cards: [], ui: null, errors };
try {
    // Instrument only realtime contexts. Offline exports do not count as live playback.
    await page.addInitScript(() => {
        const Native = window.AudioContext;
        window.__effectAudioAudit = { contexts: 0, resumes: 0, starts: 0, stops: 0 };
        window.AudioContext = class extends Native {
            constructor(...args) { super(...args); window.__effectAudioAudit.contexts++; }
            resume() { window.__effectAudioAudit.resumes++; return super.resume(); }
            createBufferSource() {
                const node = super.createBufferSource();
                const start = node.start.bind(node), stop = node.stop.bind(node);
                node.start = (...args) => { window.__effectAudioAudit.starts++; return start(...args); };
                node.stop = (...args) => { window.__effectAudioAudit.stops++; return stop(...args); };
                return node;
            }
        };
    });
    await page.goto(url);
    await page.getByRole('button', { name: 'Enable sound effects', exact: true }).first().waitFor();
    const catalogue = await page.evaluate(async () => (await import('/src/effects/catalogue.ts')).CARD_EFFECTS.map(({ id, name }) => ({ id, name })));
    assert.equal(catalogue.length, 20);
    for (const definition of catalogue) {
        const result = await page.evaluate(async id => {
            const [{ renderEffectAudio }, { CARD_EFFECTS }, { previewCue }, { showcaseGame }, { scoreEffect }] = await Promise.all([
                import('/src/effects/audio.ts'), import('/src/effects/catalogue.ts'), import('/src/effects/preview.ts'),
                import('/src/effects/showcase.ts'), import('/src/effects/soundScore.ts')
            ]);
            const definition = CARD_EFFECTS.find(card => card.id === id);
            const game = showcaseGame(definition);
            const cue = previewCue({ definition, nonce: 1 }, game.steps[0].state);
            const score = scoreEffect(cue);
            const buffer = await renderEffectAudio(cue, { sampleRate: 48000, volume: 1 });
            const channels = Array.from({ length: buffer.numberOfChannels }, (_, n) => buffer.getChannelData(n));
            let peak = 0, energy = 0, finite = true, first = buffer.length, last = -1;
            for (let i = 0; i < buffer.length; i++) for (const channel of channels) {
                const value = channel[i];
                finite &&= Number.isFinite(value);
                peak = Math.max(peak, Math.abs(value));
                energy += value * value;
                if (Math.abs(value) > 1e-5) { first = Math.min(first, i); last = Math.max(last, i); }
            }
            const rms = Math.sqrt(energy / buffer.length / channels.length);
            const wav = new ArrayBuffer(44 + buffer.length * channels.length * 2);
            const view = new DataView(wav);
            const label = (at, text) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
            label(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true); label(8, 'WAVE'); label(12, 'fmt ');
            view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels.length, true);
            view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * channels.length * 2, true);
            view.setUint16(32, channels.length * 2, true); view.setUint16(34, 16, true); label(36, 'data');
            view.setUint32(40, wav.byteLength - 44, true);
            let byte = 44;
            for (let i = 0; i < buffer.length; i++) for (const channel of channels) {
                view.setInt16(byte, Math.round(Math.max(-1, Math.min(1, channel[i])) * 32767), true); byte += 2;
            }
            const bytes = new Uint8Array(wav);
            let binary = '';
            for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
            return { wav: btoa(binary), metrics: { id, name: definition.name, duration: buffer.duration, finite, peak, rms,
                peakDb: 20 * Math.log10(peak), rmsDb: 20 * Math.log10(rms),
                headSilenceMs: first / buffer.sampleRate * 1000, tailSilenceMs: (buffer.length - 1 - last) / buffer.sampleRate * 1000,
                notes: score.length, voices: [...new Set(score.map(note => note.voice))], outcomes: cue.outcomes.map(outcome => outcome.kind) } };
        }, definition.id);
        const wav = Buffer.from(result.wav, 'base64');
        const metrics = { ...result.metrics, file: `${definition.id}.wav`, sha256: createHash('sha256').update(wav).digest('hex') };
        assert.ok(metrics.finite, `${definition.name}: all samples must be finite`);
        assert.ok(metrics.peak > .002 && metrics.peak < .95, `${definition.name}: peak must be audible and safely below clipping (${metrics.peak})`);
        assert.ok(metrics.rms > .0005, `${definition.name}: score must contain nonzero audio`);
        assert.ok(metrics.tailSilenceMs >= 80, `${definition.name}: export must end silently`);
        await fs.writeFile(path.join(output, metrics.file), wav);
        report.cards.push(metrics);
        console.log(`${report.cards.length}/20 ${definition.name}: peak ${metrics.peakDb.toFixed(1)} dBFS, RMS ${metrics.rmsDb.toFixed(1)} dBFS; ${metrics.notes} notes`);
    }
    assert.equal(new Set(report.cards.map(card => card.sha256)).size, 20, 'every card score must be distinct');
    if (!args.includes('--skip-ui')) {
        const snapshot = () => page.evaluate(() => ({ ...window.__effectAudioAudit }));
        const range = async (name, value) => page.getByRole('slider', { name, exact: true }).evaluate((input, value) => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(value));
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }, value);
        const initial = await snapshot();
        assert.equal(initial.contexts, 0, 'muted initial page creates no live audio context');
        await page.getByRole('button', { name: 'Enable sound effects', exact: true }).first().click();
        await page.waitForFunction(() => window.__effectAudioAudit.starts > 0);
        const enabled = await snapshot();
        assert.equal(enabled.contexts, 1);
        await range('Effect volume', 65);
        await page.waitForTimeout(70);
        assert.equal((await snapshot()).starts, enabled.starts, 'volume change must not replay the score');
        await range('Animation progress', 46);
        await page.waitForTimeout(70);
        const scrubbed = await snapshot();
        assert.equal(scrubbed.starts, enabled.starts, 'held frame must not synthesize');
        assert.ok(scrubbed.stops >= enabled.starts, 'scrubbing cancels every scheduled source');
        await range('Animation progress', 72);
        await page.waitForTimeout(70);
        assert.equal((await snapshot()).starts, scrubbed.starts, 'subsequent scrubbing remains silent');
        await page.getByRole('button', { name: 'Replay effect', exact: true }).click();
        await page.waitForFunction(count => window.__effectAudioAudit.starts > count, scrubbed.starts);
        const replayed = await snapshot();
        await page.getByRole('button', { name: 'Mute sound effects', exact: true }).first().click();
        const muted = await snapshot();
        assert.equal(muted.starts, replayed.starts);
        assert.ok(muted.stops > replayed.stops, 'mute cancels the currently scheduled score');
        await page.getByRole('button', { name: 'Replay effect', exact: true }).click();
        await page.waitForTimeout(70);
        assert.equal((await snapshot()).starts, muted.starts, 'muted replay remains silent');
        report.ui = { passed: true, initial, enabled, scrubbed, replayed, muted,
            checks: ['muted default creates no context', 'enable gesture creates one context and plays', 'volume changes do not restart',
                'scrubbing stops all queued voices and remains silent', 'replay starts a fresh score', 'mute stops sound', 'muted replay remains silent'] };
    }
    assert.deepEqual(errors, [], 'browser page errors');
    await fs.writeFile(path.join(output, 'metrics.json'), JSON.stringify(report, null, 2));
    const cards = report.cards.map(card => `<article><h2>${escape(card.name)}</h2><audio controls preload="none" src="${escape(card.file)}"></audio><p>${card.notes} notes · ${escape(card.voices.join(', '))}<br>Peak ${card.peakDb.toFixed(1)} dBFS · RMS ${card.rmsDb.toFixed(1)} dBFS</p></article>`).join('');
    await fs.writeFile(path.join(output, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Card effects · sound audition</title><style>body{max-width:1100px;margin:36px auto;padding:0 24px;background:#09111b;color:#dfecfc;font:16px/1.6 system-ui}h1{font-size:36px;margin:0}header p{max-width:800px;color:#a8b8ca}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px}article{padding:22px;border:1px solid #34465c;background:#101e2d;border-radius:16px}h2{font-size:20px;margin:0 0 14px}audio{width:100%}article p{color:#a8b8ca;font-size:13px;margin-bottom:0}a{color:#9bd4ff}</style><header><h1>Sound effects</h1><p>Twenty original procedural scores rendered through the same Web Audio graph as the animation showcase. Exports use the maximum UI volume; the app starts muted and defaults to 35% when enabled. These are staged examples, with each audible outcome taken from its preview cue.</p><p><a href="metrics.json">Signal and interaction checks</a> · No hardware playback was used during automated QA.</p></header><main class="grid">${cards}</main></html>`);
    console.log(JSON.stringify({ output, cards: report.cards.length, maxPeak: Math.max(...report.cards.map(card => card.peak)), ui: report.ui?.passed ?? 'skipped', errors }, null, 2));
} finally { await browser.close(); }
