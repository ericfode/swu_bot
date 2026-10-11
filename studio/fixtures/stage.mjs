// Fills studio/static-replays/, which `npm run build:static` bakes into the single-file build.
//   STATIC_REPLAYS=dirA:dirB  copy every tournament (a folder with index.json) found in those replays folders
//   STATIC_EVALS=dir          also bundle position evaluations (<gameId>.json, dashboard evals contract) from dir
//   (unset)                   generate the fixture tournaments (fixtures/generate.mjs) and use those
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'static-replays');
fs.rmSync(out, { recursive: true, force: true });
const dirs = (process.env.STATIC_REPLAYS ?? '').split(':').filter(Boolean);
if (!dirs.length) {
    execFileSync(process.execPath, [path.join(here, 'generate.mjs'), out], { stdio: 'inherit' });
} else {
    fs.mkdirSync(out, { recursive: true });
    for (const dir of dirs) {
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
            if (d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'index.json'))) {
                fs.cpSync(path.join(dir, d.name), path.join(out, d.name), { recursive: true, filter: (f) => fs.statSync(f).isDirectory() || /\.(json|jsonl)$/.test(f) });
                console.log(`staged ${d.name} from ${dir}`);
            }
        }
    }
}
if (process.env.STATIC_EVALS) {
    fs.mkdirSync(path.join(out, '_evals'), { recursive: true });
    for (const f of fs.readdirSync(process.env.STATIC_EVALS).filter((f) => f.endsWith('.json'))) {
        fs.copyFileSync(path.join(process.env.STATIC_EVALS, f), path.join(out, '_evals', f));
    }
    console.log(`staged evals from ${process.env.STATIC_EVALS}`);
}
