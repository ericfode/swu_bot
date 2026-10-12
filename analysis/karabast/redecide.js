#!/usr/bin/env node
'use strict';
/**
 * Ask bots again at every decision our seat faced in recorded Karabast bot games, from the same frames the seat read
 * (bot/karabast/observe.js builds the same `decide` messages), and report where they disagree.
 *
 *   node analysis/karabast/redecide.js --bots c-clock,c-clock2 --deck <deck name> --out <file.jsonl> <frame file>...
 *
 * --deck names our deck in bot/decks/ash-meta-2026-09.json (the hello's deck list; default luke-skywalker_jtl_data-vault).
 * Each output line is one decision: { game, k, round, prompt, labels, picks: { bot: action index } }. With
 * --stderr <dir>, each bot's stderr goes to <dir>/<bot>.<game>.log, so SWU_C_DEBUG=1 shows c-clock's reasons there.
 * The game itself went the way the recorded bot played it, so after the first disagreement the later decisions are
 * ones the other bot might never have faced: count disagreements by kind, not as a score.
 */
const fs = require('fs');
const path = require('path');
const { answer, StdioClient } = require('../../bot/stdio');
const { Observer } = require('../../bot/karabast/observe');
const { legalActions, decisionKey } = require('../../bot/karabast/frame');

const ROOT = path.join(__dirname, '..', '..');
const noSim = async (req) => ({ t: 'simulated', op: req?.op ?? null, error: 'simulations are off on Karabast' });

function args(argv) {
    const a = { bots: ['c-clock'], deck: 'luke-skywalker_jtl_data-vault', out: null, stderr: null, files: [] };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--bots') a.bots = argv[++i].split(',');
        else if (k === '--deck') a.deck = argv[++i];
        else if (k === '--out') a.out = argv[++i];
        else if (k === '--stderr') a.stderr = argv[++i];
        else a.files.push(k);
    }
    if (!a.out || !a.files.length) {
        throw new Error('usage: redecide.js --bots a,b [--deck name] [--stderr dir] --out <file.jsonl> <frame file>...');
    }
    return a;
}

/** One game's decisions for each bot; writes a line per decision to `sink`. */
/** Our seat's key in a frame file: the server fills promptState for the frame's own viewer only. */
function oursIn(lines) {
    for (const line of lines) {
        try {
            const gs = JSON.parse(line);
            const k = Object.keys(gs?.players ?? {}).find((p) => Object.keys(gs.players[p]?.promptState ?? {}).length);
            if (k) {
                return k;
            }
        } catch {
            // a line cut off by the recorder
        }
    }
    return null;
}

async function redecide(file, { bots, programs, deck, sink, stderr }) {
    const game = path.basename(file, '.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const OURS = oursIn(lines);
    if (!OURS) {
        return;
    }
    const obs = new Observer(OURS);
    const clients = bots.map((b) => {
        const fd = stderr ? fs.openSync(path.join(stderr, `${b}.${game}.log`), 'w') : 'ignore';
        return { name: b, fd, c: new StdioClient(b, { ...programs[b], stderr: fd }) };
    });
    let hello = false;
    let lastKey = null;
    let k = 0;
    try {
        for (const line of lines) {
            let gs;
            try {
                gs = JSON.parse(line);
            } catch {
                continue; // a line cut off by the recorder
            }
            if (!gs?.players?.[OURS]) {
                continue;
            }
            obs.absorb(gs);
            if (gs.winners?.length) {
                break;
            }
            if (!legalActions(gs, OURS).length) {
                continue;
            }
            const key = decisionKey(gs, OURS);
            if (key === lastKey) {
                continue; // the same decision, sent again
            }
            lastKey = key;
            const d = obs.decision(gs);
            if (!d) {
                continue;
            }
            if (!hello) {
                const { deck: own, opponent } = obs.decks(gs, deck);
                for (const x of clients) {
                    await answer(x.c, {
                        t: 'hello', protocol: 'swu-bot-stdio', v: 1, versions: [1, 2], bot: x.name, you: 'p1', seed: 1, ms: 30000,
                        players: [{ id: 'p1', name: 'p1', bot: x.name }, { id: 'p2', name: 'p2', bot: 'karabast-player' }], deck: own, opponent
                    }, noSim);
                }
                hello = true;
            }
            const msg = { t: 'decide', seq: ++k, you: 'p1', sim: false, ms: 10000, prompt: d.prompt, state: d.state, actions: d.actions, revealed: [] };
            const picks = {};
            for (const x of clients) {
                if (typeof x.fd === 'number') {
                    fs.writeSync(x.fd, `@@ decision ${k}\n`);
                }
                const r = await answer(x.c, msg, noSim);
                picks[x.name] = Number.isInteger(r?.i) ? r.i : null;
            }
            const labels = d.actions.map((a) => `${a.kind}:${a.label ?? a.card?.n ?? ''}`);
            sink.write(`${JSON.stringify({ game, k, round: d.state.round, prompt: d.prompt.title ?? d.prompt.promptTitle ?? null, labels, picks })}\n`);
        }
    } finally {
        for (const x of clients) {
            await x.c.close();
            if (typeof x.fd === 'number') {
                fs.closeSync(x.fd);
            }
        }
    }
}

async function main() {
    const a = args(process.argv.slice(2));
    const programs = JSON.parse(fs.readFileSync(path.join(ROOT, 'bot', 'external-bots.json'), 'utf8'));
    for (const b of a.bots) {
        if (!programs[b]) {
            throw new Error(`unknown bot program ${b} (bot/external-bots.json)`);
        }
    }
    const deck = JSON.parse(fs.readFileSync(path.join(ROOT, 'bot', 'decks', 'ash-meta-2026-09.json'), 'utf8')).find((d) => d.metadata.name === a.deck);
    if (!deck) {
        throw new Error(`no deck named ${a.deck}`);
    }
    if (a.stderr) {
        fs.mkdirSync(a.stderr, { recursive: true });
    }
    const sink = fs.createWriteStream(a.out);
    // bot programs do not hold the event loop open between replies
    const keep = setInterval(() => undefined, 1000);
    try {
        for (const file of a.files) {
            await redecide(file, { bots: a.bots, programs, deck, sink, stderr: a.stderr });
        }
    } finally {
        clearInterval(keep);
        await new Promise((resolve) => sink.end(resolve));
    }
    if (a.bots.length === 2) {
        const rows = fs.readFileSync(a.out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const [x, y] = a.bots;
        const diff = rows.filter((r) => r.picks[x] !== r.picks[y]);
        const kinds = new Map();
        for (const r of diff) {
            const k = `${r.prompt} | ${r.labels[r.picks[x]] ?? '-'} -> ${r.labels[r.picks[y]] ?? '-'}`;
            kinds.set(k, (kinds.get(k) ?? 0) + 1);
        }
        console.log(`${rows.length} decisions in ${a.files.length} games; ${x} and ${y} differ at ${diff.length}, in ${new Set(diff.map((r) => r.game)).size} games`);
        for (const [k, n] of [...kinds].sort((p, q) => q[1] - p[1]).slice(0, 15)) {
            console.log(`  ${n}  ${k}`);
        }
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e.message);
        process.exit(1);
    });
}
