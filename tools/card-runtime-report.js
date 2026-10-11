'use strict';

// Keep source conversion and runtime admission independently reproducible.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'bot/card-compiler/generated');
const check = process.argv.includes('--check');
if (process.argv.slice(2).some((arg) => arg !== '--check')) throw new Error('Usage: node tools/card-runtime-report.js [--check]');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'swu-card-admission-'));
try {
    const pool = path.join(temporary, 'pool.json');
    const run = spawnSync('cargo', ['run', '--locked', '--quiet', '--release', '-p', 'omni-rs', '--',
        'catalogue', path.join(output, 'catalog.json'), '--out-pool', pool], {
        cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    if (run.stderr) process.stderr.write(run.stderr);
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`Runtime admission failed (${run.status})`);
    const report = JSON.parse(run.stdout);
    const outputs = {
        'runtime-admission.json': JSON.stringify(report, null, 2) + '\n',
        'runtime-pool.json': fs.readFileSync(pool, 'utf8'),
    };
    for (const [name, content] of Object.entries(outputs)) {
        const file = path.join(output, name);
        if (check) {
            if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) {
                throw new Error(`Stale runtime artifact: ${file}; run npm run cards:compile`);
            }
        } else fs.writeFileSync(file, content);
    }
    console.log(JSON.stringify({ runtimeAdmitted: report.runtimeAdmittedCount,
        runtimeRejected: report.runtimeRejectedCount, checked: check }));
} finally {
    fs.rmSync(temporary, { recursive: true, force: true });
}
