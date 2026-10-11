// Fills studio/static-replays/, which `npm run build:static` bakes into the single-file build.
//   STATIC_REPLAYS=dirA:dirB  copy every tournament (a folder with index.json) found in those replays folders
//   STATIC_EVALS=dir          also bundle position evaluations (<gameId>.json, dashboard evals contract) from dir
//   STATIC_LENS=dir           also bundle the omni bot's card values (<gameId>.json, swu-lens/1) from dir
//   (unset)                   generate the fixture tournaments (fixtures/generate.mjs) and use those
//   STATIC_DATA=files         don't bake the data into the page: stage it in studio/static-data/data/ with a manifest.json,
//                             to publish beside the page (the page fetches data/<path>); more games fit than in one file
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const baked = path.join(here, '..', 'static-replays');
const asFiles = process.env.STATIC_DATA === 'files';
const out = asFiles ? path.join(here, '..', 'static-data', 'data') : baked;
fs.rmSync(baked, { recursive: true, force: true });
fs.rmSync(path.join(here, '..', 'static-data'), { recursive: true, force: true });
if (asFiles) {
    fs.mkdirSync(baked, { recursive: true });
}
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
if (process.env.STATIC_LENS) {
    fs.mkdirSync(path.join(out, '_lens'), { recursive: true });
    for (const f of fs.readdirSync(process.env.STATIC_LENS).filter((f) => f.endsWith('.json'))) {
        fs.copyFileSync(path.join(process.env.STATIC_LENS, f), path.join(out, '_lens', f));
    }
    console.log(`staged lens files from ${process.env.STATIC_LENS}`);
}
if (asFiles) {
    const tournaments = fs.readdirSync(out, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(out, d.name, 'index.json'))).map((d) => d.name);
    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ tournaments }));
    console.log(`staged ${tournaments.length} tournaments as files in ${out}`);
}
