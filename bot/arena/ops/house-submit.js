#!/usr/bin/env node
'use strict';
/**
 * Enters one of the arena's own bots (a resident) the way a builder enters a bot: as a submission on the window. It is
 * a house submission, owner '@arena' (intake.js HOUSE), written straight to the window's submissions collection, which
 * wakes the games machine. The machine's intake packs it, starts it once in the sandbox and enters it as a resident
 * entry (api.js register resident): rated with everyone, anchoring the ratings, never counted as a builder. A later
 * submission under the same name is that resident's next version.
 *
 *   node bot/arena/ops/house-submit.js <name> <folder> --note "<what this version is>" [--entry <file>] [--dry-run]
 *
 * <folder> is what arena_submit takes: a built bundle (it has an arena.json: kind wasm), or the source of a Python bot
 * (--entry <file>.py: kind python) or a JavaScript bot (--entry <file>.js, default bot.js: kind js). Every file in it
 * goes, binary files in base64, except dot files and folders, __pycache__ and node_modules. --dry-run prints what would
 * go instead of sending it. The dev harness (bot/dev.js) packs a bot folder with houseDoc too.
 *
 * Writing a window document takes the project's token: in the project's cloud sessions the egress proxy adds it (as for
 * push.js; SWU_WINDOW names another window). The window's arena_submit limits (size, rate) do not apply; the intake's
 * checks and the 16 MB limit of a bundle do.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NAME = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_BYTES = 16e6; // api.js WASM_MAX_BYTES, and the window's largest document
const SKIP = new Set(['__pycache__', 'node_modules']);

function filesOf(dir, rel = '') {
    const out = [];
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith('.') || SKIP.has(e.name)) {
            continue;
        }
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
            out.push(...filesOf(dir, r));
        } else if (e.isFile()) {
            out.push(r);
        }
    }
    return out;
}

/** UTF-8 text with no NUL byte goes as it is; anything else in base64. */
const isText = (buf) => !buf.includes(0) && Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);

/** The submission document for `folder`: { id, owner, name, kind, note, files, base64?, entry?, state, submittedAt }. */
function houseDoc(name, folder, { note, entry = null, now = Date.now() } = {}) {
    if (!NAME.test(name ?? '')) {
        throw new Error('name: 1-32 characters, lowercase letters, digits and _, starting with a letter');
    }
    if (typeof note !== 'string' || !note.trim() || note.length > 300) {
        throw new Error('--note: one line (up to 300 characters) saying what this version is');
    }
    const paths = filesOf(folder);
    const bundle = paths.includes('arena.json');
    const kind = bundle ? 'wasm' : /\.py$/.test(entry ?? '') ? 'python' : 'js';
    if (bundle && entry) {
        throw new Error('a bundle says how it runs in its arena.json: no --entry');
    }
    const main = bundle ? null : entry ?? 'bot.js';
    if (main && !paths.includes(main)) {
        throw new Error(`no ${main} in ${folder}`);
    }
    const files = {};
    const base64 = [];
    let bytes = 0;
    for (const p of paths) {
        const buf = fs.readFileSync(path.join(folder, p));
        bytes += buf.length;
        if (isText(buf)) {
            files[p] = buf.toString('utf8');
        } else {
            // as arena_submit takes any kind's binary files (a model's weights, say)
            files[p] = buf.toString('base64');
            base64.push(p);
        }
    }
    if (bytes > MAX_BYTES) {
        throw new Error(`${bytes} bytes: at most ${MAX_BYTES / 1e6} MB`);
    }
    return {
        id: `house.${name}.${now.toString(36)}${crypto.randomBytes(2).toString('hex')}`, owner: '@arena', name, kind, note: note.trim(), files,
        ...(base64.length ? { base64 } : {}), ...(main && main !== 'bot.js' ? { entry: main } : {}), state: 'pending', submittedAt: new Date(now).toISOString()
    };
}

async function main(argv) {
    const rest = [...argv];
    const take = (k) => {
        const i = rest.indexOf(k);
        return i < 0 ? undefined : rest.splice(i, 2)[1];
    };
    const note = take('--note');
    const entry = take('--entry') ?? null;
    const dry = rest.includes('--dry-run');
    const [name, folder] = rest.filter((a) => a !== '--dry-run');
    if (!name || !folder) {
        throw new Error('usage: house-submit.js <name> <folder> --note "..." [--entry <file>] [--dry-run]');
    }
    const doc = houseDoc(name, folder, { note, entry });
    const summary = { id: doc.id, name: doc.name, kind: doc.kind, entry: doc.entry ?? null, files: Object.keys(doc.files).length, base64: doc.base64 ?? [], bytes: JSON.stringify(doc).length };
    if (dry) {
        console.log(JSON.stringify(summary, null, 2));
        return;
    }
    await require('../push').putDoc('submissions', doc.id, doc);
    console.log(`sent ${doc.id}: ${doc.kind}, ${summary.files} files; the games machine enters it as the resident ${name}`);
}

module.exports = { houseDoc };
if (require.main === module) {
    const env = require('../push').proxyEnv(process.env);
    if (env !== process.env) {
        // Node's fetch only uses HTTPS_PROXY when NODE_USE_ENV_PROXY is set at start: run again with it (as push.js does)
        const r = require('child_process').spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env });
        process.exit(r.status ?? 1);
    }
    main(process.argv.slice(2)).catch((e) => {
        console.error(`house-submit: ${e.message}`);
        process.exit(1);
    });
}
