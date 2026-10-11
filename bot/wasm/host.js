'use strict';

/**
 * Host for the WebAssembly bot (bot.wat). Speaks the stdio protocol (spec/stdio-protocol.md) and does no thinking:
 * it compiles bot.wat, turns each `decide` message into the flat i32 tables the module reads (header, units, hand,
 * actions, distribute targets, lower-cased strings, printed card stats), calls `decide()`, and sends back the index
 * (and damage split) the module wrote. Memory offsets and field numbers come from the module's own exports.
 *
 *   node bot/wasm/host.js            card data from $SWU_CARD_JSON/Card or forceteki/test/json/Card
 *   SWU_WASM_TRACE=1 node ...        print the module's trace calls on stderr
 *   node bot/wasm/host.js --check    compile and validate bot.wat, then exit
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const WAT = path.join(__dirname, 'bot.wat');
// same convention as the Rust bot: $SWU_CARD_JSON is the folder that holds Card/
const CARD_DIR = path.join(process.env.SWU_CARD_JSON ?? path.join(__dirname, '..', '..', 'forceteki', 'test', 'json'), 'Card');
const TRACE = !!process.env.SWU_WASM_TRACE;

const ASPECTS = { vigilance: 1, command: 2, aggression: 3, cunning: 4, villainy: 5, heroism: 6 };
const KEYWORDS = { sentinel: 1, overwhelm: 2, saboteur: 4, raid: 8, ambush: 16, grit: 32, restore: 64, shielded: 128, hidden: 256, smuggle: 512, bounty: 1024 };
const TYPES = { unit: 1, event: 2, upgrade: 4, leader: 8, base: 16, token: 32 };
const KINDS = { button: 1, card: 2, option: 3, displayCard: 4, perCardButton: 5, distribute: 6 };
const ZONES = { hand: 1, groundArena: 2, spaceArena: 3, base: 4, discard: 5, resource: 6 };
const PTYPES = { actionWindow: 1, resource: 2, initiative: 3, optionalTrigger: 4, triggerWindow: 5, distributeAmongTargets: 6, number: 7, displayCards: 8, passDelay: 9 };
const PHASES = { setup: 1, action: 2, regroup: 3 };

/** Printed stats of every card, by set code ("SOR_095"), internal name and title. */
function loadCards(dir) {
    const db = { bySet: new Map(), byName: new Map(), byTitle: new Map() };
    if (!fs.existsSync(dir)) {
        process.stderr.write(`[wasm] no card data at ${dir}; playing without card stats\n`);
        return db;
    }
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.json')) {
            continue;
        }
        const c = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        const rec = {
            cost: c.cost ?? 0,
            power: c.power ?? 0,
            hp: c.hp ?? 0,
            type: (c.types ?? []).reduce((m, t) => m | (TYPES[t] ?? 0), 0),
            arena: c.arena === 'ground' ? 1 : c.arena === 'space' ? 2 : 0,
            aspects: (c.aspects ?? []).map((a) => ASPECTS[a] ?? 0),
            kw: (c.keywords ?? []).reduce((m, k) => m | (KEYWORDS[k] ?? 0), 0),
            upow: c.upgradePower ?? 0,
            uhp: c.upgradeHp ?? 0,
            text: c.text ?? ''
        };
        for (const sc of c.setCodes ?? (c.setId ? [c.setId] : [])) {
            const key = `${sc.set}_${String(sc.number).padStart(3, '0')}`;
            if (!db.bySet.has(key)) {
                db.bySet.set(key, rec);
            }
        }
        if (c.internalName) {
            db.byName.set(c.internalName, rec);
        }
        if (c.title && !db.byTitle.has(c.title)) {
            db.byTitle.set(c.title, rec);
        }
    }
    return db;
}

function lookup(db, { s, n, label } = {}) {
    return (s && db.bySet.get(s)) || (label && db.byName.get(label)) || (n && db.byTitle.get(n)) || null;
}

/** Card uuid ("Card_293") to a small integer that stays the same for the whole game. */
function uid(id) {
    if (id == null) {
        return -1;
    }
    const digits = String(id).replace(/\D/g, '');
    if (digits) {
        return Number(digits.slice(-9));
    }
    let h = 0;
    for (const ch of String(id)) {
        h = (h * 31 + ch.charCodeAt(0)) | 0;
    }
    return h & 0x3fffffff;
}

async function compile() {
    const wabt = await require('wabt')();
    const mod = wabt.parseWat('bot.wat', fs.readFileSync(WAT, 'utf8'));
    try {
        mod.resolveNames();
        mod.validate();
        return mod.toBinary({}).buffer;
    } finally {
        mod.destroy();
    }
}

class WasmBot {
    constructor(wasmBytes, db) {
        this.db = db;
        const instance = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {
            env: { trace: (a, b) => TRACE && process.stderr.write(`[wasm] trace ${a} ${b}\n`) }
        });
        this.x = instance.exports;
        // every offset and field number the module exports, as plain numbers
        this.L = {};
        for (const [k, v] of Object.entries(this.x)) {
            if (v instanceof WebAssembly.Global) {
                this.L[k] = v.value;
            }
        }
        this.i32 = new Int32Array(this.x.memory.buffer);
        this.u8 = new Uint8Array(this.x.memory.buffer);
        this.enc = new TextEncoder();
    }

    newGame(seed) {
        this.x.new_game(seed | 0);
    }

    set(addr, v) {
        this.i32[addr >> 2] = v | 0;
    }

    hdr(name, v) {
        this.set(this.L[name] * 4, v);
    }

    str(s, max = 400) {
        const bytes = this.enc.encode(String(s ?? '').toLowerCase().slice(0, max));
        if (this.textPtr + bytes.length > this.L.TEXT_END) {
            return [0, 0];
        }
        const off = this.textPtr;
        this.u8.set(bytes, off);
        this.textPtr += bytes.length;
        return [off, bytes.length];
    }

    /** Card record (printed stats) at row + 64. */
    card(row, rec) {
        const L = this.L;
        for (let k = 64; k < 128; k += 4) {
            this.set(row + k, 0);
        }
        if (!rec) {
            return;
        }
        this.set(row + L.C_OK, 1);
        this.set(row + L.C_COST, rec.cost);
        this.set(row + L.C_POW, rec.power);
        this.set(row + L.C_HP, rec.hp);
        this.set(row + L.C_TYPE, rec.type);
        this.set(row + L.C_ARENA, rec.arena);
        rec.aspects.slice(0, 3).forEach((a, k) => this.set(row + L.C_ASP0 + 4 * k, a));
        this.set(row + L.C_KW, rec.kw);
        this.set(row + L.C_UPOW, rec.upow);
        this.set(row + L.C_UHP, rec.uhp);
        const [off, len] = this.str(rec.text, 600);
        this.set(row + L.C_TOFF, off);
        this.set(row + L.C_TLEN, len);
    }

    /** Write one decide message into memory; returns the actions actually written. */
    encode(msg) {
        const L = this.L;
        const db = this.db;
        this.i32.fill(0, 0, L.TEXT >> 2);
        this.textPtr = L.TEXT;
        const me = msg.you;
        const players = msg.state?.players ?? {};
        const opSeat = Object.keys(players).find((k) => k !== me);
        const my = players[me] ?? {};
        const op = players[opSeat] ?? {};
        const prompt = msg.prompt ?? {};

        const [toff, tlen] = this.str(prompt.title ?? '');
        const [poff, plen] = this.str(prompt.promptTitle ?? '');
        this.hdr('H_TOFF', toff);
        this.hdr('H_TLEN', tlen);
        this.hdr('H_POFF', poff);
        this.hdr('H_PLEN', plen);
        this.hdr('H_ROUND', msg.state?.round ?? 0);
        this.hdr('H_PHASE', PHASES[msg.state?.phase] ?? 0);
        this.hdr('H_INIT', msg.state?.initiative === me ? 1 : msg.state?.initiative ? 2 : 0);
        this.hdr('H_AW', prompt.actionWindow ? 1 : 0);
        this.hdr('H_SELMODE', prompt.selectCardMode === 'single' ? 1 : prompt.selectCardMode === 'multiple' ? 2 : 0);
        this.hdr('H_NSEL', (prompt.selected ?? []).length);
        this.hdr('H_PTYPE', prompt.type ? PTYPES[prompt.type] ?? 10 : 0);
        this.hdr('H_SEQ', msg.seq ?? 0);
        this.hdr('H_MYHP', my.base?.hp ?? 30);
        this.hdr('H_MYDMG', my.base?.d ?? 0);
        this.hdr('H_OPHP', op.base?.hp ?? 30);
        this.hdr('H_OPDMG', op.base?.d ?? 0);
        this.hdr('H_MYREADY', my.res?.ready ?? 0);
        this.hdr('H_MYTOTAL', my.res?.total ?? 0);
        this.hdr('H_OPREADY', op.res?.ready ?? 0);
        this.hdr('H_OPTOTAL', op.res?.total ?? 0);
        this.hdr('H_MYHAND', my.handCount ?? (my.hand ?? []).length);
        this.hdr('H_OPHAND', op.handCount ?? 0);
        this.hdr('H_MYDECK', my.deck ?? 0);
        this.hdr('H_OPDECK', op.deck ?? 0);
        this.hdr('H_OPDISC', (op.discard ?? []).length);
        this.hdr('H_MYLDEP', my.leader?.dep ? 1 : 0);
        this.hdr('H_MYLEXH', my.leader?.x ? 1 : 0);
        this.hdr('H_OPLDEP', op.leader?.dep ? 1 : 0);
        this.hdr('H_MYLUID', uid(my.leader?.id));
        const leaderRec = my.leader ? lookup(db, my.leader) : null;
        this.hdr('H_MYLCOST', leaderRec ? leaderRec.cost : 99);
        const aspects = [...(leaderRec?.aspects ?? []), ...((my.base && lookup(db, my.base))?.aspects ?? [])];
        aspects.slice(0, 4).forEach((a, k) => this.set((L.H_ASP0 + k) * 4, a));

        // units, both sides
        const unitRow = new Map();
        const units = [];
        for (const [owner, pv] of [[0, my], [1, op]]) {
            for (const [arena, list] of [[1, pv.ground ?? []], [2, pv.space ?? []]]) {
                for (const u of list) {
                    units.push({ owner, arena, u, leader: pv.leader && pv.leader.id === u.id });
                }
            }
        }
        const nUnits = Math.min(units.length, L.MAX_UNITS);
        for (let i = 0; i < nUnits; i++) {
            const { owner, arena, u, leader } = units[i];
            const row = L.UNITS + i * 128;
            const ups = u.u ?? [];
            this.set(row + L.U_OWNER, owner);
            this.set(row + L.U_ARENA, arena);
            this.set(row + L.U_POW, u.p ?? 0);
            this.set(row + L.U_HP, u.h ?? 0);
            this.set(row + L.U_DMG, u.d ?? 0);
            this.set(row + L.U_EXH, u.x ? 1 : 0);
            this.set(row + L.U_SENT, u.sn ? 1 : 0);
            this.set(row + L.U_SHIELDS, ups.filter((x) => x.n === 'Shield').length);
            this.set(row + L.U_UPGR, ups.length);
            this.set(row + L.U_LEADER, leader ? 1 : 0);
            this.set(row + L.U_UID, uid(u.id));
            this.card(row, lookup(db, u));
            unitRow.set(u.id, i);
        }
        this.hdr('H_NUNITS', nUnits);

        // my hand
        const handRow = new Map();
        const hand = (my.hand ?? []).slice(0, L.MAX_HAND);
        hand.forEach((c, i) => {
            const row = L.HAND + i * 128;
            this.set(row + L.R_UID, uid(c.id));
            this.card(row, lookup(db, c));
            handRow.set(c.id, i);
        });
        this.hdr('H_NHAND', hand.length);

        // the prompt's source card: my unit of that name, and its printed stats
        const srcTitle = prompt.promptTitle ?? '';
        const srcUnit = units.findIndex((x, i) => i < nUnits && x.owner === 0 && x.u.n === srcTitle);
        this.hdr('H_SRCUNIT', srcUnit);
        const seen = [my.leader, my.base, ...hand, ...(my.discard ?? []), ...units.map((x) => x.u), ...(my.resources ?? [])].filter(Boolean);
        const srcRec = srcTitle ? lookup(db, seen.find((c) => c.n === srcTitle) ?? { n: srcTitle }) : null;
        this.card(L.SRC, srcRec);
        this.hdr('H_SRCOK', srcRec ? 1 : 0);

        // actions
        const actions = (msg.actions ?? []).slice(0, L.MAX_ACTS);
        const selected = new Set(prompt.selected ?? []);
        this.hdr('H_DACT', -1);
        actions.forEach((a, i) => {
            const row = L.ACTS + i * 128;
            const c = a.card;
            const id = c?.id ?? a.cardUuid ?? (a.kind === 'displayCard' ? a.arg : null);
            this.set(row + L.A_KIND, KINDS[a.kind] ?? 0);
            this.set(row + L.A_ZONE, c ? ZONES[c.zone] ?? 9 : 0);
            this.set(row + L.A_CTL, c?.ctl === me ? 0 : c?.ctl ? 1 : -1);
            this.set(row + L.A_UNIT, id != null && unitRow.has(id) ? unitRow.get(id) : -1);
            this.set(row + L.A_BASE, id != null && id === my.base?.id ? 1 : id != null && id === op.base?.id ? 2 : 0);
            this.set(row + L.A_LEAD, id != null && id === my.leader?.id ? 1 : id != null && id === op.leader?.id ? 2 : 0);
            const [loff, llen] = this.str(a.label ?? '', 64);
            this.set(row + L.A_LOFF, loff);
            this.set(row + L.A_LLEN, llen);
            const num = typeof a.arg === 'number' ? a.arg : /^#?\d+$/.test(String(a.label ?? '')) ? Number(String(a.label).replace('#', '')) : -1;
            this.set(row + L.A_NUM, num);
            this.set(row + L.A_HAND, id != null && handRow.has(id) ? handRow.get(id) : -1);
            this.set(row + L.A_UID, id != null ? uid(id) : -1);
            this.set(row + L.A_SEL, id != null && selected.has(id) ? 1 : 0);
            const internal = a.kind === 'perCardButton' ? String(a.label ?? '').split(':').pop() : a.label;
            this.card(row, c ? lookup(db, { s: c.s, n: c.n, label: a.label }) : a.kind === 'displayCard' || a.kind === 'perCardButton' ? lookup(db, { label: internal }) : null);
            if (a.kind === 'distribute' && a.distribute && this.i32[L.H_DACT] < 0) {
                this.encodeDistribute(i, a.distribute, unitRow, my, op);
            }
        });
        this.hdr('H_NACTS', actions.length);
        return actions;
    }

    encodeDistribute(i, d, unitRow, my, op) {
        const L = this.L;
        const targets = (d.targets ?? []).slice(0, L.MAX_DIST);
        this.hdr('H_DACT', i);
        this.hdr('H_DTYPE', /heal/i.test(d.type) ? 2 : /damage/i.test(d.type) ? 1 : 3);
        this.hdr('H_DAMT', d.amount ?? 0);
        this.hdr('H_DLESS', d.canDistributeLess ? 1 : 0);
        this.hdr('H_DNONE', d.canChooseNoTargets ? 1 : 0);
        this.hdr('H_DMAX', d.maxTargets ?? -1);
        this.hdr('H_DN', targets.length);
        targets.forEach((t, k) => {
            const row = L.DIST + k * 16;
            this.set(row + L.D_UNIT, unitRow.has(t.id) ? unitRow.get(t.id) : -1);
            this.set(row + L.D_BASE, t.id === my.base?.id ? 1 : t.id === op.base?.id ? 2 : 0);
            this.set(row + L.D_CAP, t.cap == null ? -1 : t.cap);
        });
        this.distTargets = targets;
    }

    /** Reply to one decide message. */
    decide(msg) {
        const actions = this.encode(msg);
        const idx = this.x.decide();
        if (!Number.isInteger(idx) || idx < 0 || idx >= actions.length) {
            throw new Error(`module picked ${idx} of ${actions.length} actions`);
        }
        const action = actions[idx];
        const reply = { t: 'act', i: action.i };
        if (action.kind === 'distribute' && this.i32[(this.L.OUT >> 2) + 1]) {
            const base = (this.L.OUT >> 2) + 2;
            reply.distribution = this.distTargets
                .map((t, k) => ({ id: t.id, amount: this.i32[base + k] }))
                .filter((e) => e.amount > 0);
        }
        return reply;
    }
}

/** Safe answer when the module traps: pass in the action window, else the first action that isn't Cancel. */
function fallback(msg) {
    const acts = msg.actions ?? [];
    const pass = acts.find((a) => a.kind === 'button' && /^pass$/i.test(a.label));
    const pick = (msg.prompt?.actionWindow && pass) || acts.find((a) => !(a.kind === 'button' && /cancel/i.test(a.label))) || acts[0];
    return { t: 'act', i: pick ? pick.i : 0 };
}

async function main() {
    const bot = new WasmBot(await compile(), loadCards(CARD_DIR));
    const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line.trim()) {
            continue;
        }
        let msg;
        try {
            msg = JSON.parse(line);
        } catch (e) {
            out({ t: 'error', error: `bad JSON: ${e.message}` });
            continue;
        }
        if (msg.t === 'hello') {
            bot.newGame(msg.seed ?? 1);
            out({ t: 'ready', v: 1, name: 'wasm' });
        } else if (msg.t === 'decide') {
            let reply;
            try {
                reply = bot.decide(msg);
            } catch (e) {
                process.stderr.write(`[wasm] seq ${msg.seq}: ${e.stack ?? e}\n`);
                reply = fallback(msg);
            }
            out(reply);
        } else {
            out({ t: 'error', error: `unknown message ${msg.t}` });
        }
    }
}

if (require.main === module && process.argv.includes('--check')) {
    // compile and validate bot.wat only
    compile().then((b) => process.stdout.write(`bot.wat ok: ${b.length} bytes of wasm\n`), (e) => {
        process.stderr.write(`${String(e.message ?? e).split('\n').slice(0, 8).join('\n')}\n`);
        process.exit(1);
    });
} else if (require.main === module) {
    main().catch((e) => {
        process.stderr.write(`[wasm] ${e.stack ?? e}\n`);
        process.exit(1);
    });
}

module.exports = { WasmBot, compile, loadCards, uid };
