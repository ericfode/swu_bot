'use strict';

/**
 * Screenshots a built page for visual review: node meta/shoot.js <page.html> <outDir>
 * Writes desktop-light.png, desktop-dark.png, phone-light.png (full page) and hero.png (first screen).
 */
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

(async () => {
    const [page, outDir] = process.argv.slice(2);
    const url = 'file://' + path.resolve(page);
    const browser = await chromium.launch();
    const shots = [
        { name: 'desktop-light', width: 1280, height: 900, scheme: 'light', full: true },
        { name: 'desktop-dark', width: 1280, height: 900, scheme: 'dark', full: true },
        { name: 'phone-light', width: 400, height: 860, scheme: 'light', full: true },
        { name: 'hero', width: 1280, height: 900, scheme: 'light', full: false },
    ];
    const errors = [];
    for (const s of shots) {
        const ctx = await browser.newContext({ viewport: { width: s.width, height: s.height }, colorScheme: s.scheme, deviceScaleFactor: 1 });
        const p = await ctx.newPage();
        p.on('pageerror', (e) => errors.push(`${s.name}: ${e.message}`));
        p.on('console', (m) => { if (m.type() === 'error') errors.push(`${s.name}: ${m.text()}`); });
        await p.goto(url, { waitUntil: 'load' });
        await p.waitForTimeout(600);
        const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) errors.push(`${s.name}: page scrolls sideways by ${overflow}px`);
        await p.screenshot({ path: path.join(outDir, `${s.name}.png`), fullPage: s.full });
        if (s.name === 'desktop-light' || s.name === 'phone-light') {
            // Readable tiles for reviewers: full pages get shrunk too far to read when viewed whole.
            const total = await p.evaluate(() => document.documentElement.scrollHeight);
            const tileH = s.name === 'phone-light' ? 1100 : 1000;
            for (let y = 0, i = 1; y < total; y += tileH, i++) {
                await p.screenshot({ path: path.join(outDir, `${s.name}-tile${i}.png`), fullPage: true, clip: { x: 0, y, width: s.width, height: Math.min(tileH, total - y) } });
            }
        }
        await ctx.close();
    }
    await browser.close();
    console.log(errors.length ? errors.join('\n') : 'no console errors, no sideways scroll');
})();
