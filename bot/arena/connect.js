'use strict';
/**
 * Connects an agent with no browser to the arena window, for one competitor name (oauth.js, the device grant):
 *
 *   node bot/arena/connect.js --name <competitor> [--label "what this agent is"] [--out ~/.swu-arena-token]
 *                             [--window https://swu-arena.fly.dev]
 *
 * Prints a link and a code; the person opens the link, signs in with GitHub, checks the code and presses Allow. The
 * token is then written to --out (mode 600) and never printed. It submits bots only as <competitor> and reads what its
 * person can read; connecting the same name again ends the old token. WINDOW.md "An agent with no browser".
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function form(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
    return { status: r.status, body: await r.json().catch(() => ({})) };
}

/** Runs the device grant; resolves the token response once the person allows it, or throws why not. */
async function connect({ window: base, name, label, say = console.log }) {
    const start = await form(`${base}/oauth/device_authorization`, { name, label });
    if (start.status !== 200) {
        throw new Error(start.body.error_description ?? `the window answered ${start.status}`);
    }
    const d = start.body;
    say(`Open ${d.verification_uri_complete}\nand check that it shows the code ${d.user_code}. It lets "${label}" submit bots as ${name}.`);
    let interval = d.interval ?? 5;
    const end = Date.now() + (d.expires_in ?? 600) * 1000;
    while (Date.now() < end) {
        await sleep(interval * 1000);
        const r = await form(`${base}/oauth/token`, { grant_type: GRANT, device_code: d.device_code });
        if (r.status === 200 && r.body.access_token) {
            return r.body;
        }
        if (r.body.error === 'slow_down') {
            interval += 5;
        } else if (r.body.error !== 'authorization_pending') {
            throw new Error(r.body.error_description ?? r.body.error ?? `the window answered ${r.status}`);
        }
    }
    throw new Error('the link expired before anyone allowed it; run this again');
}

async function main() {
    const name = arg('name', null);
    if (!name) {
        throw new Error('usage: node bot/arena/connect.js --name <competitor> [--label "..."] [--out ~/.swu-arena-token] [--window URL]');
    }
    const out = path.resolve(arg('out', path.join(os.homedir(), '.swu-arena-token')));
    const label = arg('label', `${os.userInfo().username}@${os.hostname()}`);
    const tok = await connect({ window: arg('window', 'https://swu-arena.fly.dev').replace(/\/+$/, ''), name, label });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, tok.access_token, { mode: 0o600 });
    fs.chmodSync(out, 0o600);
    console.log(`Connected as ${name}; the token is in ${out} (${Math.round(tok.expires_in / 86400)} days).`);
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e.message || e);
        process.exit(1);
    });
}

module.exports = { connect };
