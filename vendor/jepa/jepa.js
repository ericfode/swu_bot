'use strict';
/**
 * The JEPA bot in JavaScript: jepa_bot.py's player (the imagined score, the planner with its gate, c-clock's resource
 * rule), features.py, the transformer JEPA's forward pass (tx_model.py) and resource_policy.py's choices, ported line
 * by line so it plays the moves the Python bot plays. It needs no Node built-ins, so a browser runs it as is (the
 * arena's play page runs it next to the referee, in the person's browser). `main.js` is its command line.
 *
 *   const bot = new JepaBot({ model, windowModel, planModel, cards });   // models: loadModel(bytes); cards: cardTables(...)
 *   bot.hello(msg); await bot.decide(msg, sim); bot.over(msg);         // an in-process protocol v2 client (stdio.js answer)
 *
 * `parity.js` checks it against the Python bot, decision by decision (bots/jepa/README.md, "jepa-tx-gate in JavaScript").
 *
 * Numbers: the weights are float32 as in the Python, the arithmetic is float64 (numpy runs float32), so scores agree to
 * about 1e-6; a pick can differ only between moves whose scores tie that closely (two copies of one card in hand).
 * Not ported: round tiers, the sim-v and sim-eval oracle scores, --log, --temp above 0, --plan reply=1, several
 * --plan-model models, thoughts for the dashboard.
 */

// ---------------------------------------------------------------- features.py

const SIDE = 20;
const PROMPT_TYPES = ['actionWindow', 'resource', 'initiative', 'triggerWindow', 'optionalTrigger', 'distributeAmongTargets', 'displayCards', 'number', 'mulligan', 'other'];
const STATE_DIM = 73;
const KINDS = ['button', 'card', 'option', 'displayCard', 'perCardButton', 'distribute'];
const BUTTONS = ['pass', 'cancel', 'done', 'keep', 'mulligan', '0', '1', 'yes', 'no', 'claim', 'skip', 'other'];
const ZONES = ['hand', 'groundArena', 'spaceArena', 'base', 'discard', 'resource', 'leader', 'other'];
const KEYWORDS = ['sentinel', 'overwhelm', 'raid', 'restore', 'saboteur', 'shielded', 'ambush', 'grit', 'bounty', 'smuggle'];
const CARD = 11 + KEYWORDS.length;
const BOARD = 7;
const ACTION_DIM = KINDS.length + BUTTONS.length + ZONES.length + 2 + CARD + BOARD + 4 + 2; // 62
const ID_BUCKETS = 2048;
const TOKEN_SLOTS = ['myHand', 'myGround', 'mySpace', 'oppGround', 'oppSpace', 'myLeader', 'oppLeader', 'myBase', 'oppBase'];
const TOKEN_DIM = TOKEN_SLOTS.length + 12; // 21
const MAX_TOKENS = 32;

const isDict = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** features.f: a number field (booleans are not numbers here, as in the Python), else 0. */
const f = (v, k) => (isDict(v) && typeof v[k] === 'number' ? v[k] : 0);
const arr = (v, k) => (isDict(v) && Array.isArray(v[k]) ? v[k] : []);
const str = (v) => (typeof v === 'string' ? v : null);
/** Python's `x or {}`: a falsy value (missing, null, '', 0, false) becomes {}. */
const or = (x) => (x ? x : {});
const pad3 = (n) => String(n).padStart(3, '0');

/**
 * Printed stats by set code ("SOR_042") from the engine's card data (forceteki/test/json/Card/*.json, parsed), as
 * features.load_cards (`db`) and resource_policy.load_card_meta (`meta`) build them.
 */
function cardTables(cards) {
    const db = new Map();
    const meta = new Map();
    for (const v of cards) {
        if (!isDict(v)) {
            continue;
        }
        const num = (k) => (typeof v[k] === 'number' ? v[k] : 0);
        const strs = (k) => (Array.isArray(v[k]) ? v[k].filter((s) => typeof s === 'string').map((s) => s.toLowerCase()) : []);
        const types = strs('types');
        const kws = strs('keywords');
        const has = (t) => types.some((x) => x.includes(t));
        const i = { cost: num('cost'), power: num('power'), hp: num('hp'), unit: has('unit'), event: has('event'), upgrade: has('upgrade'),
            leader: has('leader'), base: has('base'), token: has('token'), space: v.arena === 'space', keywords: 0 };
        KEYWORDS.forEach((k, bit) => {
            if (kws.includes(k)) {
                i.keywords |= 1 << bit;
            }
        });
        if (i.upgrade && i.power === 0) {
            i.power = num('upgradePower');
            i.hp = num('upgradeHp');
        }
        const m = { cost: num('cost'), types, aspects: strs('aspects'), space: v.arena === 'space', power: num('power'), hp: num('hp') };
        const codes = [...(Array.isArray(v.setCodes) ? v.setCodes : []), ...(v.setId ? [v.setId] : [])];
        for (const c of codes) {
            if (isDict(c) && typeof c.set === 'string' && Number.isInteger(c.number)) {
                db.set(`${c.set}_${pad3(c.number)}`, i);
                meta.set(`${c.set}_${pad3(c.number)}`, m);
            }
        }
    }
    return { db, meta };
}

const UTF8 = new TextEncoder();

/** FNV-1a mod 2048, as features.hash_id: the low 11 bits of the 64-bit hash only need its low 32 bits. */
function hashId(s) {
    let h = 0x84222325;
    for (const b of UTF8.encode(s)) {
        h = Math.imul((h ^ b) >>> 0, 0x1b3) >>> 0;
    }
    return h % ID_BUCKETS;
}

function sideFeatures(side, out) {
    const base = or(side.base);
    const baseHp = Math.max(f(base, 'hp'), 1);
    const baseLeft = Math.max(f(base, 'hp') - f(base, 'd'), 0);
    const res = or(side.res);
    const leader = or(side.leader);
    const units = [...arr(side, 'ground'), ...arr(side, 'space')];
    const powG = arr(side, 'ground').reduce((s, u) => s + f(u, 'p'), 0);
    const powS = arr(side, 'space').reduce((s, u) => s + f(u, 'p'), 0);
    let hpLeft = 0;
    let exhausted = 0;
    let readyPow = 0;
    let sentinels = 0;
    let shields = 0;
    let ups = 0;
    for (const u of units) {
        hpLeft += Math.max(f(u, 'h') - f(u, 'd'), 0);
        if (f(u, 'x') > 0) {
            exhausted += 1;
        } else {
            readyPow += f(u, 'p');
        }
        sentinels += f(u, 'sn');
        for (const up of arr(u, 'u')) {
            if (isDict(up) && up.n === 'Shield') {
                shields += 1;
            } else {
                ups += 1;
            }
        }
    }
    out.push(baseLeft / 30, baseLeft / baseHp, baseLeft <= 10 ? 1 : 0, f(res, 'ready') / 10, f(res, 'total') / 10,
        f(side, 'handCount') / 10, f(side, 'deck') / 50, arr(side, 'discard').length / 30,
        arr(side, 'ground').length / 6, arr(side, 'space').length / 6, powG / 20, powS / 20, hpLeft / 30,
        exhausted / 6, readyPow / 20, sentinels / 3, shields / 3, ups / 3, f(leader, 'dep'), f(leader, 'x'));
}

function promptType(prompt) {
    const t = str(prompt.type) ?? '';
    const title = str(prompt.title) ?? '';
    if (title.toLowerCase().includes('mulligan')) {
        return 8;
    }
    const k = PROMPT_TYPES.indexOf(t);
    return k >= 0 ? k : PROMPT_TYPES.length - 1;
}

const seats = (msg) => {
    const you = msg.you || 'p1';
    return [you, you === 'p1' ? 'p2' : 'p1'];
};

function sides(msg) {
    const [you, opp] = seats(msg);
    const players = or(or(msg.state).players);
    return { you, opp, me: or(players[you]), them: or(players[opp]) };
}

function encodeState(msg, db) {
    const { you, opp, me, them } = sides(msg);
    const state = or(msg.state);
    const prompt = or(msg.prompt);
    const s = [];
    sideFeatures(me, s);
    sideFeatures(them, s);
    const ready = f(or(me.res), 'ready');
    let cost = 0;
    let unitsH = 0;
    let events = 0;
    let upgrades = 0;
    let playable = 0;
    let power = 0;
    let minCost = 99;
    const hand = arr(me, 'hand');
    for (const c of hand) {
        const i = isDict(c) ? db.get(c.s) : undefined;
        if (i) {
            cost += i.cost;
            unitsH += i.unit;
            events += i.event;
            upgrades += i.upgrade;
            playable += i.cost <= ready ? 1 : 0;
            minCost = Math.min(minCost, i.cost);
            power += i.power;
        }
    }
    const nh = hand.length;
    s.push(cost / 30, unitsH / 5, events / 5, upgrades / 5, playable / 5, nh > 0 ? Math.min(minCost, 10) / 10 : 1, power / 20, nh / 10);
    s.push(f(state, 'round') / 20);
    const phase = state.phase || '';
    for (const p of ['setup', 'action', 'regroup']) {
        s.push(phase === p ? 1 : 0);
    }
    const init = state.initiative;
    s.push(init === you ? 1 : 0, init === opp ? 1 : 0, init === undefined || init === null ? 1 : 0);
    const pt = promptType(prompt);
    PROMPT_TYPES.forEach((_, k) => s.push(k === pt ? 1 : 0));
    s.push(prompt.actionWindow === true ? 1 : 0);
    const mode = prompt.selectCardMode;
    s.push(mode === 'single' ? 1 : 0, mode === 'multiple' ? 1 : 0, mode === undefined || mode === null ? 1 : 0);
    s.push(arr(prompt, 'selected').length / 5);
    s.push(Math.min(arr(msg, 'actions').length, 30) / 30);
    s.push(s[0] - s[SIDE]);
    s.push(s[12] - s[SIDE + 12] + s[10] + s[11] - s[SIDE + 10] - s[SIDE + 11]);
    if (s.length !== STATE_DIM) {
        throw new Error(`state vector has ${s.length} numbers`);
    }
    return Float32Array.from(s);
}

/** Python's repr of a float that is not whole (JS writes most the same way). */
const floatText = (x) => (Number.isFinite(x) ? String(x) : Number.isNaN(x) ? 'nan' : x > 0 ? 'inf' : '-inf');

/** Python's float(text), or null where it raises. */
function pyFloat(t) {
    const s = t.trim().replace(/(\d)_(?=\d)/g, '$1');
    if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) {
        return Number(s);
    }
    if (/^[+-]?(inf|infinity)$/i.test(s)) {
        return s.startsWith('-') ? -Infinity : Infinity;
    }
    return /^[+-]?nan$/i.test(s) ? NaN : null;
}

function argText(av) {
    if (typeof av === 'string') {
        return av.toLowerCase();
    }
    if (typeof av === 'number') {
        return Number.isInteger(av) ? String(av) : floatText(av);
    }
    return '';
}

function encodeActions(msg, db) {
    const { you, opp, me, them } = sides(msg);
    const prompt = or(msg.prompt);
    const ready = f(or(me.res), 'ready');
    const mode = prompt.selectCardMode;
    const board = new Map();
    for (const [side, mine] of [[me, true], [them, false]]) {
        for (const u of [...arr(side, 'ground'), ...arr(side, 'space')]) {
            if (isDict(u) && typeof u.id === 'string') {
                board.set(u.id, [u, mine]);
            }
        }
    }
    const baseThem = or(them.base).id;
    const baseMe = or(me.base).id;
    const acts = arr(msg, 'actions');
    const rows = new Float32Array(acts.length * ACTION_DIM);
    const ids = new Int32Array(acts.length);
    acts.forEach((a, n) => {
        const r = new Array(ACTION_DIM).fill(0);
        let o = 0;
        const kind = str(a.kind) ?? '';
        if (KINDS.includes(kind)) {
            r[o + KINDS.indexOf(kind)] = 1;
        }
        o += KINDS.length;
        const label = (str(a.label) ?? '').toLowerCase();
        const arg = argText(a.arg);
        if (kind === 'button' || kind === 'perCardButton') {
            let b = BUTTONS.findIndex((bt) => arg === bt || label === bt || (bt.length > 2 && label.startsWith(bt)));
            if (b < 0) {
                b = BUTTONS.length - 1;
            }
            r[o + b] = 1;
        }
        o += BUTTONS.length;
        const card = isDict(a.card) ? a.card : null;
        let code = null;
        if (card !== null) {
            const zone = str(card.zone) ?? 'other';
            const z = ZONES.indexOf(zone);
            r[o + (z >= 0 ? z : ZONES.length - 1)] = 1;
            code = str(card.s);
        }
        o += ZONES.length;
        if (card !== null) {
            r[o] = card.ctl === you ? 1 : 0;
            r[o + 1] = card.ctl === opp ? 1 : 0;
        }
        o += 2;
        const i = card !== null ? db.get(card.s) : undefined;
        if (i) {
            const v = [i.cost / 10, i.power / 10, i.hp / 10, +i.unit, +i.event, +i.upgrade, +i.leader, +i.base, +i.token, +i.space, i.cost <= ready ? 1 : 0];
            v.forEach((x, k) => {
                r[o + k] = x;
            });
            for (let b = 0; b < KEYWORDS.length; b++) {
                r[o + 11 + b] = (i.keywords >> b) & 1;
            }
        }
        o += CARD;
        let cid = card !== null ? str(card.id) : null;
        if (cid === null && typeof a.cardUuid === 'string') {
            cid = a.cardUuid;
        }
        if (cid !== null && board.has(cid)) {
            const [u, mine] = board.get(cid);
            [1, mine ? 1 : 0, f(u, 'p') / 10, Math.max(f(u, 'h') - f(u, 'd'), 0) / 10, f(u, 'x'), f(u, 'sn'), arr(u, 'u').length / 3].forEach((x, k) => {
                r[o + k] = x;
            });
        }
        o += BOARD;
        const d = a.distribute;
        if (isDict(d)) {
            r[o] = f(d, 'amount') / 10;
            r[o + 1] = arr(d, 'targets').length / 10;
        }
        if (kind === 'option') {
            const x = pyFloat(arg);
            if (x !== null) {
                r[o + 2] = x / 10;
            }
        }
        r[o + 3] = mode === 'multiple' && kind === 'card' ? 1 : 0;
        o += 4;
        r[o] = cid !== null && cid === baseThem ? 1 : 0;
        r[o + 1] = cid !== null && cid === baseMe ? 1 : 0;
        o += 2;
        if (o !== ACTION_DIM) {
            throw new Error(`action row has ${o} numbers`);
        }
        rows.set(r, n * ACTION_DIM);
        ids[n] = hashId(code !== null ? `card:${code}` : `${kind}:${arg || label}`);
    });
    return { rows, ids, n: acts.length };
}

function encodeTokens(msg, db) {
    const { me, them } = sides(msg);
    const ready = f(or(me.res), 'ready');
    const items = [];
    for (const [slot, cards] of [['myLeader', [me.leader]], ['oppLeader', [them.leader]], ['myBase', [me.base]], ['oppBase', [them.base]],
        ['myGround', arr(me, 'ground')], ['mySpace', arr(me, 'space')], ['oppGround', arr(them, 'ground')], ['oppSpace', arr(them, 'space')],
        ['myHand', arr(me, 'hand')]]) {
        for (const c of cards) {
            if (isDict(c)) {
                items.push([slot, c]);
            }
        }
    }
    const used = items.slice(0, MAX_TOKENS);
    const ids = new Int32Array(used.length);
    const feats = new Float32Array(used.length * TOKEN_DIM);
    used.forEach(([slot, c], k) => {
        const code = str(c.s) ?? '';
        const i = db.get(code);
        ids[k] = hashId(`card:${code}`);
        const row = new Array(TOKEN_DIM).fill(0);
        row[TOKEN_SLOTS.indexOf(slot)] = 1;
        const hp = Object.prototype.hasOwnProperty.call(c, 'h') ? f(c, 'h') : f(c, 'hp');
        [f(c, 'p') / 10, Math.max(hp - f(c, 'd'), 0) / 10, f(c, 'x'), f(c, 'sn'), arr(c, 'u').length / 3, f(c, 'dep'),
            i ? i.cost / 10 : 0, i ? +i.unit : 0, i ? +i.event : 0, i ? +i.upgrade : 0, i ? (i.cost <= ready ? 1 : 0) : 0, i ? +i.space : 0]
            .forEach((x, j) => {
                row[TOKEN_SLOTS.length + j] = x;
            });
        feats.set(row, k * TOKEN_DIM);
    });
    return { ids, feats, n: used.length };
}

/** Everything the model reads for one decision (features.encode); the card tokens are the valid ones only. */
function encode(msg, db) {
    return { state: encodeState(msg, db), actions: encodeActions(msg, db), tokens: encodeTokens(msg, db) };
}

// ---------------------------------------------------------------- model.py, tx_model.py

/** A safetensors file (bytes) -> { w: name -> Float32Array, shapes, meta }. Every dtype becomes float32, as model.py does. */
function loadModel(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const n = Number(dv.getBigUint64(0, true));
    const header = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + n)));
    const meta = header.__metadata__ ?? {};
    delete header.__metadata__;
    const data = 8 + n;
    const w = {};
    const shapes = {};
    for (const [name, t] of Object.entries(header)) {
        const [a, b] = t.data_offsets;
        const view = new DataView(u8.buffer, u8.byteOffset + data + a, b - a);
        const size = t.shape.reduce((x, y) => x * y, 1);
        const out = new Float32Array(size);
        const read = { F32: (k) => view.getFloat32(4 * k, true), I32: (k) => view.getInt32(4 * k, true), I64: (k) => Number(view.getBigInt64(8 * k, true)),
            F16: (k) => half(view.getUint16(2 * k, true)) }[t.dtype];
        if (!read) {
            throw new Error(`${name}: dtype ${t.dtype}`);
        }
        for (let k = 0; k < size; k++) {
            out[k] = read(k);
        }
        w[name] = out;
        shapes[name] = t.shape;
    }
    return { w, shapes, meta };
}

function half(h) {
    const e = (h >> 10) & 31;
    const m = h & 1023;
    const s = h & 32768 ? -1 : 1;
    if (e === 0) {
        return s * m * 2 ** -24;
    }
    return e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
}

const D = 96;
const EMB = 16;
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/** y[n x out] = x[n x in] @ W[in x out] + b. */
function linear(x, n, W, b, din, dout) {
    const y = new Float64Array(n * dout);
    for (let i = 0; i < n; i++) {
        const yo = i * dout;
        for (let o = 0; o < dout; o++) {
            y[yo + o] = b[o];
        }
        const xo = i * din;
        for (let k = 0; k < din; k++) {
            const xv = x[xo + k];
            if (xv === 0) {
                continue;
            }
            const wo = k * dout;
            for (let o = 0; o < dout; o++) {
                y[yo + o] += xv * W[wo + o];
            }
        }
    }
    return y;
}

function relu(x) {
    for (let i = 0; i < x.length; i++) {
        if (x[i] < 0) {
            x[i] = 0;
        }
    }
    return x;
}

function layerNorm(x, n, d, g, b) {
    const y = new Float64Array(n * d);
    for (let i = 0; i < n; i++) {
        const o = i * d;
        let mu = 0;
        for (let k = 0; k < d; k++) {
            mu += x[o + k];
        }
        mu /= d;
        let v = 0;
        for (let k = 0; k < d; k++) {
            v += (x[o + k] - mu) ** 2;
        }
        const inv = 1 / Math.sqrt(v / d + 1e-5);
        for (let k = 0; k < d; k++) {
            y[o + k] = (x[o + k] - mu) * inv * g[k] + b[k];
        }
    }
    return y;
}

/** The transformer JEPA (swu-jepa-tx/1) at play time: one position, its context once, then any moves against it. */
class TxModel {
    constructor({ w, meta }) {
        if (meta.format !== 'swu-jepa-tx/1') {
            throw new Error(`not a transformer JEPA (format ${meta.format})`);
        }
        this.w = w;
        this.L = Number(meta.layers);
        this.H = Number(meta.heads);
        this.T = Number(meta.tmax);
        this.dm = Number(meta.dm);
        const names = (v) => String(v ?? '').split(',').filter(Boolean);
        this.horizons = [1, 4, ...(['1', 'True'].includes(String(meta.settle ?? '0')) ? ['s'] : []),
            ...names(meta.tiers).flatMap((t) => names(meta.macros).map((c) => `${t}:${c}`))];
    }

    lin(name, x, n, din, dout) {
        return linear(x, n, this.w[`${name}.w`], this.w[`${name}.b`], din, dout);
    }

    /** Card identity embedding (model.embed) of bucket `id`, added into `out` at `at`. */
    embed(id, out, at) {
        const { emb_a: a, emb_b: b, emb_c: c } = this.w;
        const ia = (id % 64) * EMB;
        const ib = Math.floor(id / 64) * EMB;
        const ic = ((id * 7 + 3) % 61) * EMB;
        for (let k = 0; k < EMB; k++) {
            out[at + k] = a[ia + k] + b[ib + k] + c[ic + k];
        }
    }

    ffn(i, x, n) {
        const dm = this.dm;
        const h = relu(this.lin(`b${i}.f1`, layerNorm(x, n, dm, this.w[`b${i}.ln2.g`], this.w[`b${i}.ln2.b`]), n, dm, 2 * dm));
        return this.lin(`b${i}.f2`, h, n, 2 * dm, dm);
    }

    /**
     * The position's context: z, and per layer the keys and values its move tokens attend to. Padded card slots are
     * never attended to and left out of the mean, so only the valid ones are run.
     */
    context(e) {
        const { dm, H, w } = this;
        const t = Math.min(e.tokens.n, this.T);
        const c = 1 + t;
        let x = new Float64Array(c * dm);
        x.set(this.lin('sin', e.state, 1, STATE_DIM, dm), 0);
        if (t) {
            const tin = new Float64Array(t * (TOKEN_DIM + EMB));
            for (let k = 0; k < t; k++) {
                const o = k * (TOKEN_DIM + EMB);
                for (let j = 0; j < TOKEN_DIM; j++) {
                    tin[o + j] = e.tokens.feats[k * TOKEN_DIM + j];
                }
                this.embed(e.tokens.ids[k], tin, o + TOKEN_DIM);
            }
            x.set(this.lin('tin', tin, t, TOKEN_DIM + EMB, dm), dm);
        }
        const hd = dm / H;
        const sc = 1 / Math.sqrt(hd);
        const layers = [];
        for (let i = 0; i < this.L; i++) {
            const y = layerNorm(x, c, dm, w[`b${i}.ln1.g`], w[`b${i}.ln1.b`]);
            const q = this.lin(`b${i}.q`, y, c, dm, dm);
            const kk = this.lin(`b${i}.k`, y, c, dm, dm);
            const v = this.lin(`b${i}.v`, y, c, dm, dm);
            layers.push({ k: kk, v });
            const out = new Float64Array(c * dm);
            const att = new Float64Array(c);
            for (let h = 0; h < H; h++) {
                const ho = h * hd;
                for (let a = 0; a < c; a++) {
                    let mx = -Infinity;
                    for (let b = 0; b < c; b++) {
                        let s = 0;
                        for (let d = 0; d < hd; d++) {
                            s += q[a * dm + ho + d] * kk[b * dm + ho + d];
                        }
                        att[b] = s * sc;
                        mx = Math.max(mx, att[b]);
                    }
                    let sum = 0;
                    for (let b = 0; b < c; b++) {
                        att[b] = Math.exp(att[b] - mx);
                        sum += att[b];
                    }
                    for (let b = 0; b < c; b++) {
                        const p = att[b] / sum;
                        for (let d = 0; d < hd; d++) {
                            out[a * dm + ho + d] += p * v[b * dm + ho + d];
                        }
                    }
                }
            }
            const o = this.lin(`b${i}.o`, out, c, dm, dm);
            for (let k = 0; k < x.length; k++) {
                x[k] += o[k];
            }
            const ff = this.ffn(i, x, c);
            for (let k = 0; k < x.length; k++) {
                x[k] += ff[k];
            }
        }
        x = layerNorm(x, c, dm, w['lnf.g'], w['lnf.b']);
        const zin = new Float64Array(2 * dm + STATE_DIM);
        for (let k = 0; k < dm; k++) {
            zin[k] = x[k];
            let s = 0;
            for (let a = 0; a < c; a++) {
                s += x[a * dm + k];
            }
            zin[dm + k] = s / c;
        }
        zin.set(e.state, 2 * dm);
        const z = this.lin('zo2', relu(this.lin('zo1', zin, 1, 2 * dm + STATE_DIM, 256)), 1, 256, D);
        return { z, layers, c };
    }

    /** ẑ_h (rows of D) for every move of `e` against the context `ctx`: z + P(z, move token at horizon h). */
    predict(ctx, e, h) {
        const { dm, H, w } = this;
        const hi = this.horizons.indexOf(h);
        if (hi < 0) {
            throw new Error(`this model has no horizon ${h}`);
        }
        const n = e.actions.n;
        const ain = new Float64Array(n * (ACTION_DIM + EMB));
        for (let k = 0; k < n; k++) {
            const o = k * (ACTION_DIM + EMB);
            for (let j = 0; j < ACTION_DIM; j++) {
                ain[o + j] = e.actions.rows[k * ACTION_DIM + j];
            }
            this.embed(e.actions.ids[k], ain, o + ACTION_DIM);
        }
        const xm = this.lin('ain', ain, n, ACTION_DIM + EMB, dm);
        for (let k = 0; k < n; k++) {
            for (let j = 0; j < dm; j++) {
                xm[k * dm + j] += w.hor[hi * dm + j];
            }
        }
        const { c } = ctx;
        const hd = dm / H;
        const sc = 1 / Math.sqrt(hd);
        const att = new Float64Array(c + 1);
        for (let i = 0; i < this.L; i++) {
            const { k: kk, v } = ctx.layers[i];
            const ym = layerNorm(xm, n, dm, w[`b${i}.ln1.g`], w[`b${i}.ln1.b`]);
            const qm = this.lin(`b${i}.q`, ym, n, dm, dm);
            const km = this.lin(`b${i}.k`, ym, n, dm, dm);
            const vm = this.lin(`b${i}.v`, ym, n, dm, dm);
            const om = new Float64Array(n * dm);
            for (let a = 0; a < n; a++) {
                for (let h = 0; h < H; h++) {
                    const ho = h * hd;
                    let mx = -Infinity;
                    for (let b = 0; b <= c; b++) {
                        let s = 0;
                        for (let d = 0; d < hd; d++) {
                            s += qm[a * dm + ho + d] * (b < c ? kk[b * dm + ho + d] : km[a * dm + ho + d]);
                        }
                        att[b] = s * sc;
                        mx = Math.max(mx, att[b]);
                    }
                    let sum = 0;
                    for (let b = 0; b <= c; b++) {
                        att[b] = Math.exp(att[b] - mx);
                        sum += att[b];
                    }
                    for (let b = 0; b <= c; b++) {
                        const p = att[b] / sum;
                        for (let d = 0; d < hd; d++) {
                            om[a * dm + ho + d] += p * (b < c ? v[b * dm + ho + d] : vm[a * dm + ho + d]);
                        }
                    }
                }
            }
            const o = this.lin(`b${i}.o`, om, n, dm, dm);
            for (let k = 0; k < xm.length; k++) {
                xm[k] += o[k];
            }
            const ff = this.ffn(i, xm, n);
            for (let k = 0; k < xm.length; k++) {
                xm[k] += ff[k];
            }
        }
        const ao = layerNorm(xm, n, dm, w['lnf.g'], w['lnf.b']);
        const pin = new Float64Array(n * (D + dm));
        for (let k = 0; k < n; k++) {
            pin.set(ctx.z, k * (D + dm));
            pin.set(ao.subarray(k * dm, (k + 1) * dm), k * (D + dm) + D);
        }
        const p = this.lin('p2', relu(this.lin('p1', pin, n, D + dm, 256)), n, 256, D);
        for (let k = 0; k < n; k++) {
            for (let j = 0; j < D; j++) {
                p[k * D + j] += ctx.z[j];
            }
        }
        return p;
    }

    /** Value logits of `n` latents (rows of D). */
    value(z, n) {
        return this.lin('v2', relu(this.lin('v1', z, n, D, 64)), n, 64, 1);
    }
}

// ---------------------------------------------------------------- resource_policy.py

const FEATS = 10;

function myAspects(msg, meta) {
    const me = or(or(or(msg.state).players)[msg.you]);
    const out = [];
    for (const k of ['leader', 'base']) {
        const s = or(me[k]).s;
        out.push(...(or(meta.get(s)).aspects ?? []));
    }
    return out;
}

function offAspect(s, meta, aspects) {
    const have = [...aspects];
    let off = 0;
    for (const a of or(meta.get(s)).aspects ?? []) {
        const k = have.indexOf(a);
        if (k >= 0) {
            have.splice(k, 1);
        } else {
            off += 1;
        }
    }
    return off;
}

function cardFeatures(s, meta, aspects, handCodes) {
    const m = or(meta.get(s));
    const cost = m.cost ?? 0;
    const t = m.types ?? [];
    return [cost / 8, cost <= 2 ? 1 : 0, cost >= 3 && cost <= 4 ? 1 : 0, cost >= 5 ? 1 : 0, t.includes('unit') ? 1 : 0, t.includes('event') ? 1 : 0,
        t.includes('upgrade') ? 1 : 0, offAspect(s, meta, aspects), handCodes.filter((x) => x === s).length > 1 ? 1 : 0, m.space ? 1 : 0];
}

function maxSelect(prompt) {
    const nums = String(prompt.title || '').match(/\d+/g);
    return nums ? Number(nums[nums.length - 1]) : 1;
}

function offered(msg) {
    const cards = [];
    let done = null;
    for (const a of msg.actions || []) {
        const c = or(a.card);
        if (a.kind === 'card' && c.zone === 'hand' && c.ctl === msg.you && c.s) {
            cards.push([a.i, c.s]);
        } else if (a.kind === 'button') {
            done = a.i;
        }
    }
    return [cards, done];
}

function clockKeep(s, meta, aspects, total) {
    const m = meta.get(s);
    if (!m) {
        return 1;
    }
    const pen = 2 * offAspect(s, meta, aspects);
    let v = 3 - 0.6 * Math.max(0, m.cost + pen - (total + 2)) - (0.8 * pen) / 2;
    if (m.types.includes('unit')) {
        v += 1 + 0.05 * ((m.power ?? 0) + (m.hp ?? 0));
    }
    if (m.types.includes('upgrade')) {
        v -= 0.3;
    }
    return v;
}

/** The first of the smallest, as Python's min(key=...). */
const minBy = (xs, key) => xs.reduce((best, x) => (key(x) < key(best) ? x : best));

class ResourcePolicy {
    /** `spec`: "c-clock" (c-clock's rule), "rule" (heuristic.js), or a fitted swu-resource/1 model (parsed JSON). */
    constructor(spec, meta) {
        if (spec === 'c-clock') {
            this.m = { w: new Array(FEATS).fill(0), card: {}, stop: [0, 0, 0, 0], clock: true };
        } else if (spec === 'rule') {
            this.m = { w: new Array(FEATS).fill(0), card: {}, stop: [-10, 0, 0, 0], rule: true };
        } else {
            this.m = spec;
        }
        this.meta = meta;
    }

    score(msg, cards) {
        const aspects = myAspects(msg, this.meta);
        const me = or(or(or(msg.state).players)[msg.you]);
        const hand = (me.hand || []).map((c) => c.s);
        const xs = cards.map(([, s]) => cardFeatures(s, this.meta, aspects, hand));
        if (this.m.rule) {
            return xs.map((x) => x[7] * 3 - x[4] * 1.5 - (x[0] * 8 <= 3 ? 1 : 0) + x[0] * 8 * 0.3);
        }
        return xs.map((x, k) => x.reduce((s, v, j) => s + v * this.m.w[j], 0) + (this.m.card[cards[k][1]] ?? 0));
    }

    chooseClock(msg, prompt, cards, done) {
        const st = or(msg.state);
        const me = or(or(st.players)[msg.you]);
        const total = or(me.res).total || 0;
        const handN = me.handCount || 0;
        const aspects = myAspects(msg, this.meta);
        let want = maxSelect(prompt);
        if (st.phase === 'regroup') {
            const eff = (s) => (this.meta.has(s) ? this.meta.get(s).cost + 2 * offAspect(s, this.meta, aspects) : 3);
            const big = (me.hand || []).some((c) => c.s && eff(c.s) > total);
            want = total < 6 || (total < 9 && handN >= 3) || (big && handN >= 2) ? want : 0;
        }
        if ((prompt.selected || []).length >= want && done !== null) {
            return done;
        }
        if (!cards.length) {
            return done;
        }
        return minBy(cards, (c) => clockKeep(c[1], this.meta, aspects, total))[0];
    }

    /** The answer to a resource prompt, or null (another prompt, or nothing to say). */
    choose(msg) {
        const prompt = or(msg.prompt);
        if (prompt.type !== 'resource') {
            return null;
        }
        const [cards, done] = offered(msg);
        if (this.m.clock) {
            return this.chooseClock(msg, prompt, cards, done);
        }
        const picked = (prompt.selected || []).length;
        if (done !== null && (picked >= maxSelect(prompt) || !cards.length)) {
            return done;
        }
        if (!cards.length) {
            return null;
        }
        if (done !== null && picked === 0 && or(msg.state).phase === 'regroup') {
            const st = or(msg.state);
            const me = or(or(st.players)[msg.you]);
            const x = [1, (st.round || 0) / 10, (or(me.res).total || 0) / 10, (me.handCount || 0) / 10];
            const p = 1 / (1 + Math.exp(-x.reduce((s, v, j) => s + v * this.m.stop[j], 0)));
            if (p > 0.5) {
                return done;
            }
        }
        const sc = this.score(msg, cards);
        return cards[sc.indexOf(Math.max(...sc))][0];
    }
}

// ---------------------------------------------------------------- Python's random.Random (MT19937), for the same picks

class PyRandom {
    constructor(seed = 0) {
        this.mt = new Uint32Array(624);
        this.mti = 625;
        this.seed(seed);
    }

    initGenrand(s) {
        const mt = this.mt;
        mt[0] = s >>> 0;
        for (let i = 1; i < 624; i++) {
            const p = mt[i - 1] ^ (mt[i - 1] >>> 30);
            mt[i] = (Math.imul(1812433253, p) + i) >>> 0;
        }
        this.mti = 624;
    }

    /** random.seed(n) for a whole number: init_by_array over its 32-bit words, low first. */
    seed(n) {
        let a = BigInt(Math.abs(Math.trunc(Number(n) || 0)));
        const key = [];
        do {
            key.push(Number(a & 0xffffffffn));
            a >>= 32n;
        } while (a > 0n);
        const mt = this.mt;
        this.initGenrand(19650218);
        let i = 1;
        let j = 0;
        for (let k = Math.max(624, key.length); k; k--) {
            const p = mt[i - 1] ^ (mt[i - 1] >>> 30);
            mt[i] = ((mt[i] ^ Math.imul(p, 1664525)) + key[j] + j) >>> 0;
            i++;
            j++;
            if (i >= 624) {
                mt[0] = mt[623];
                i = 1;
            }
            if (j >= key.length) {
                j = 0;
            }
        }
        for (let k = 623; k; k--) {
            const p = mt[i - 1] ^ (mt[i - 1] >>> 30);
            mt[i] = ((mt[i] ^ Math.imul(p, 1566083941)) - i) >>> 0;
            i++;
            if (i >= 624) {
                mt[0] = mt[623];
                i = 1;
            }
        }
        mt[0] = 0x80000000;
    }

    uint32() {
        const mt = this.mt;
        if (this.mti >= 624) {
            for (let k = 0; k < 624; k++) {
                const y = (mt[k] & 0x80000000) | (mt[(k + 1) % 624] & 0x7fffffff);
                mt[k] = mt[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
            }
            this.mti = 0;
        }
        let y = mt[this.mti++];
        y ^= y >>> 11;
        y ^= (y << 7) & 0x9d2c5680;
        y ^= (y << 15) & 0xefc60000;
        y ^= y >>> 18;
        return y >>> 0;
    }

    /** randrange(n) (and the index choice() takes), for 0 < n <= 2**32. */
    below(n) {
        if (!(n > 0)) {
            throw new Error('empty range for randrange()');
        }
        const k = Math.floor(Math.log2(n)) + 1;
        const shift = 32 - k;
        let r;
        do {
            r = shift > 0 ? this.uint32() >>> shift : this.uint32();
        } while (r >= n);
        return r;
    }

    choice(xs) {
        return xs[this.below(xs.length)];
    }
}

// ---------------------------------------------------------------- jepa_bot.py

const isButton = (a, label) => a.kind === 'button' && String(a.label ?? '').toLowerCase() === label;
/** Python's truth of a value (an empty object or list is false there). */
const truthy = (v) => (Array.isArray(v) ? v.length > 0 : isDict(v) ? Object.keys(v).length > 0 : Boolean(v));
const nul = (x) => (x === undefined ? null : x);

/** An action's identity across the referee's copy and the real game (card ids can differ there). */
function actionKey(a) {
    const c = or(a.card);
    return JSON.stringify([nul(a.kind), nul(a.label), nul(c.n), nul(c.zone), nul(c.ctl), typeof a.arg === 'number' || typeof a.arg === 'boolean' ? a.arg : null]);
}

const labelsKey = (acts) => JSON.stringify(acts.map(actionKey));

/** JSON with sorted keys: the same text for equal values (Python json.dumps(sort_keys=True) and dict ==). */
function canon(v) {
    if (Array.isArray(v)) {
        return `[${v.map(canon).join(',')}]`;
    }
    if (isDict(v)) {
        return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
    }
    return v === undefined ? 'null' : JSON.stringify(v);
}

/** Indexes by score, best first; ties keep their order (numpy's argsort of a short array does too). */
const argsortDesc = (score) => Array.from(score.keys()).sort((a, b) => score[b] - score[a] || a - b);

const WAIT_PROMPT = { type: 'actionWindow', actionWindow: true, selectCardMode: null, selected: [] };
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

class JepaBot {
    /**
     * model, windowModel, planModel: loadModel() results (windowModel and planModel default to model); cards:
     * cardTables(). The defaults are jepa-tx-gate's settings (holocron bots/external-bots.json).
     */
    constructor({ name = 'jepa-tx-gate', model, windowModel = null, planModel = null, cards, score = 'plan', mix = 0, temp = 0,
        windowHorizon = 's', followHorizon = 's', resource = 'c-clock', plan = { gate: 0.04 } }) {
        if (temp > 0) {
            throw new Error('temp above 0 is not ported');
        }
        if (!['imagined', 'plan'].includes(score)) {
            throw new Error(`score ${score} is not ported (imagined or plan)`);
        }
        if (plan?.reply) {
            throw new Error('plan reply is not ported');
        }
        this.name = name;
        this.net = new TxModel(model);
        this.windowNet = windowModel ? new TxModel(windowModel) : null;
        this.planNet = planModel ? new TxModel(planModel) : this.net;
        this.db = cards.db;
        this.mix = mix;
        this.score = score;
        this.windowHorizon = windowHorizon;
        this.followHorizon = followHorizon;
        this.resource = resource ? new ResourcePolicy(resource, cards.meta) : null;
        this.cfg = { roots: 16, follow: 6, follow2: 3, depth: 2, lines: 150, secs: 5, floor: 2500, ...plan };
        this.newGame(0);
    }

    get needsSim() {
        return this.score !== 'imagined';
    }

    newGame(seed) {
        this.rng = new PyRandom(seed);
        this.seen = new Map();
        this.plan = [];
        this.fail = null;
        this.stats = { windows: 0, planned: 0, gated: 0, lines: 0, leaves: 0, failed: 0, followed: 0, unplanned: 0, dropped: 0 };
    }

    /** Each move's imagined score (jepa_bot.think): where it settles at action windows and their follow-ups, else the next decision. */
    think(msg) {
        const window = Boolean(or(msg.prompt).actionWindow);
        const follow = this.followHorizon === 's' && !window && or(msg.state).phase === 'action';
        const net = this.windowNet !== null && (window || follow) ? this.windowNet : this.net;
        const e = encode(msg, this.db);
        const ctx = net.context(e);
        const n = e.actions.n;
        const v = (h) => Array.from(net.value(net.predict(ctx, e, h), n), sigmoid);
        let score;
        if (net.horizons.includes('s') && ((this.windowHorizon === 's' && window) || follow)) {
            score = v('s');
        } else {
            const v1 = v(1);
            const v4 = this.mix ? v(4) : null;
            score = v1.map((x, k) => (1 - this.mix) * x + (v4 ? this.mix * v4[k] : 0));
        }
        return { score };
    }

    rushMove(r, target, seen) {
        const acts = r.actions;
        const st = or(r.state);
        const players = or(st.players);
        const opp = or(players[r.actor]);
        const mine = or(players[target]);
        const prompt = or(r.prompt);
        if (prompt.actionWindow) {
            const units = new Map();
            for (const z of ['ground', 'space']) {
                for (const u of opp[z] || []) {
                    units.set(nul(u.id), u);
                }
            }
            const key = JSON.stringify([nul(st.round), nul(opp.handCount), nul(or(opp.res).ready), nul(or(mine.base).d), [...units.values()].filter((u) => !u.x).length]);
            seen.set(key, (seen.get(key) ?? 0) + 1);
            const passes = acts.filter((a) => isButton(a, 'pass')).map((a) => a.i);
            if (seen.get(key) > 2 && passes.length) {
                return passes[0];
            }
            const leader = or(opp.leader).id;
            let best = null;
            let bestP = 0;
            for (const a of acts) {
                const c = a.card;
                if (a.kind !== 'card' || !truthy(c) || c.ctl !== r.actor) {
                    continue;
                }
                let p;
                if (c.zone === 'hand') {
                    const info = this.db.get(c.s || '');
                    p = 300 + (info ? info.cost : 0);
                } else if (units.has(nul(c.id))) {
                    p = 200 + Number(units.get(nul(c.id)).p || 0);
                } else if (c.id === leader) {
                    p = 100;
                } else {
                    p = 0;
                }
                if (p > bestP) {
                    best = a.i;
                    bestP = p;
                }
            }
            return best !== null ? best : passes.length ? passes[0] : 0;
        }
        const title = `${prompt.title || ''} ${prompt.promptTitle || ''}`.toLowerCase();
        if (title.includes('attack')) {
            const base = or(mine.base).id;
            const cards = acts.filter((a) => a.kind === 'card' && truthy(a.card));
            const hit = cards.filter((a) => a.card.id === base).map((a) => a.i);
            if (hit.length) {
                return hit[0];
            }
            const hp = new Map();
            for (const z of ['ground', 'space']) {
                for (const u of mine[z] || []) {
                    hp.set(nul(u.id), Number(u.h || 0) - Number(u.d || 0));
                }
            }
            const mineUnits = cards.filter((a) => hp.has(nul(a.card.id)));
            if (mineUnits.length) {
                return minBy(mineUnits, (a) => hp.get(nul(a.card.id))).i;
            }
        }
        // a Cancel would undo the move being judged (it then looks like a no-op), so pick among the other answers
        const keep = acts.filter((a) => !isButton(a, 'cancel')).map((a) => a.i);
        return keep.length ? this.rng.choice(keep) : this.rng.below(acts.length);
    }

    static settled(r) {
        return Boolean(r.over || or(r.prompt).actionWindow || or(r.state).phase !== 'action');
    }

    /** jepa_bot.plan_line: one line of the planner. [taken, mine, position], null when it failed, or 'abort'. */
    async planLine(msg, sim, path, queue, depthCap) {
        const me = msg.you;
        const cfg = this.cfg;
        let r = await sim({ t: 'sim', op: 'begin', deal: 0 });
        if (r.error || (r.actions || []).length !== msg.actions.length) {
            this.fail = `begin: ${r.error || 'actions differ'}`;
            return 'abort';
        }
        const taken = [];
        const mine = [];
        const guard = new Map();
        const seen = new Map();
        let depth = 0;
        for (let step = 0; step < 80; step++) {
            if (r.error) {
                this.fail = `act: ${r.error}`;
                return null;
            }
            if (r.ms !== undefined && r.ms !== null && r.ms < cfg.floor) {
                this.fail = 'time';
                return 'abort';
            }
            if (step > 0 && JepaBot.settled(r)) {
                return [taken, mine, r];
            }
            const acts = r.actions || [];
            if (!acts.length) {
                this.fail = 'no actions';
                return null;
            }
            const actor = r.actor;
            const key = actor === me && acts.length > 1 ? canon([nul(r.prompt), nul(r.state), acts.map((x) => nul(x.label))]) : null;
            let j;
            if (step < path.length) {
                j = path[step];
                if (key !== null && step > 0) {
                    if (!guard.has(key)) {
                        guard.set(key, []);
                    }
                    guard.get(key).push(j);
                    depth += 1;
                }
            } else if (actor !== me) {
                j = this.rushMove(r, me, seen);
            } else if (acts.length === 1) {
                j = 0;
            } else {
                const pos = { you: me, prompt: r.prompt, state: r.state, actions: acts };
                let order = argsortDesc(this.think(pos).score);
                const cancel = new Set(acts.map((x, k) => (isButton(x, 'cancel') ? k : -1)).filter((k) => k >= 0));
                order = [...order.filter((k) => !cancel.has(k)), ...order.filter((k) => cancel.has(k))];
                if (!guard.has(key)) {
                    guard.set(key, []);
                }
                const tried = guard.get(key);
                if (!tried.length && depth < depthCap) {
                    // a new follow-up prompt: this line takes the best option, the next ones become lines of their own
                    const width = depth === 0 ? cfg.follow : cfg.follow2;
                    let opts = order.filter((k) => !cancel.has(k)).slice(0, width);
                    if (!opts.length) {
                        opts = order.slice(0, 1);
                    }
                    for (const alt of opts.slice(1)) {
                        queue.push([...taken, alt]);
                    }
                    j = opts[0];
                } else {
                    // the same prompt again in this line (a multi-select prompt toggles cards), or past the depth cap
                    j = order[0];
                    if (tried.length >= 2 && tried.includes(j)) {
                        const fresh = order.filter((k) => !tried.includes(k));
                        j = fresh.length ? fresh[0] : this.rng.below(acts.length);
                    }
                }
                tried.push(j);
                depth += 1;
            }
            if (actor === me && step > 0 && acts.length > 1) {
                mine.push([labelsKey(acts), actionKey(acts[j])]);
            }
            taken.push(j);
            r = await sim({ t: 'sim', op: 'act', i: j });
        }
        this.fail = 'step cap';
        return null;
    }

    /** jepa_bot.plan_moves: every root move's best simulated line's value, and that line's follow-up choices. */
    async planMoves(msg, sim, imagined) {
        const me = msg.you;
        const acts = msg.actions;
        const n = acts.length;
        const cfg = this.cfg;
        const order = argsortDesc(imagined);
        const top = order.slice(0, cfg.roots);
        const roots = [...top, ...acts.map((a, k) => k).filter((k) => isButton(acts[k], 'pass') && !top.includes(k))];
        const queue = roots.map((i) => [i]);
        const t0 = now();
        const leaves = [];
        let lines = 0;
        while (queue.length && lines < cfg.lines && now() - t0 < cfg.secs * 1000) {
            const path = queue.shift();
            const res = await this.planLine(msg, sim, path, queue, cfg.depth);
            lines += 1;
            if (res === 'abort') {
                break;
            }
            if (res === null) {
                this.stats.failed += 1;
            } else {
                leaves.push(res);
            }
        }
        await sim({ t: 'sim', op: 'end' });
        this.stats.lines += lines;
        this.stats.leaves += leaves.length;
        if (!leaves.length) {
            return null;
        }
        const vals = new Array(leaves.length).fill(NaN);
        const sameState = canon(nul(msg.state));
        leaves.forEach(([, , r], k) => {
            if (r.over) {
                const w = r.over.winner;
                vals[k] = w === me ? 1 : w === 'draw' || w === null || w === undefined ? 0.5 : 0;
            } else if (r.actor === me && or(r.prompt).actionWindow && canon(nul(r.state)) === sameState) {
                vals[k] = 0; // back in my window with nothing changed: the move does nothing
            } else {
                const pos = r.actor === me ? { you: me, prompt: r.prompt, state: r.state, actions: r.actions } : { you: me, prompt: WAIT_PROMPT, state: r.state, actions: acts };
                const { z } = this.planNet.context(encode(pos, this.db));
                vals[k] = sigmoid(this.planNet.value(z, 1)[0]);
            }
        });
        const score = new Array(n).fill(-1);
        const best = new Map();
        leaves.forEach(([taken, mine], k) => {
            const i = taken[0];
            if (vals[k] > score[i]) {
                score[i] = vals[k];
                best.set(i, mine);
            }
        });
        return [score, best];
    }

    followPlan(msg) {
        if (!this.plan.length) {
            return null;
        }
        const sig = labelsKey(msg.actions);
        for (let k = 0; k < this.plan.length; k++) {
            const [want, choice] = this.plan[k];
            if (want === sig) {
                this.plan = this.plan.slice(k + 1);
                const i = msg.actions.findIndex((a) => actionKey(a) === choice);
                return i >= 0 ? i : null;
            }
        }
        this.plan = [];
        this.stats.dropped += 1;
        return null;
    }

    /**
     * jepa_bot.choose: the index of the move to play. (Not named choose: the referee takes an object with choose() for
     * a native bot with engine access.)
     */
    async pick(msg, sim) {
        this.last = null;
        const n = (msg.actions || []).length;
        if (n <= 1) {
            return 0;
        }
        const t = this.think(msg);
        if (this.resource !== null) {
            const j = this.resource.choose(msg);
            if (j !== null && j !== undefined) {
                return j;
            }
        }
        let score = t.score;
        this.fail = null;
        const window = Boolean(or(msg.prompt).actionWindow);
        let best = null;
        if (this.score === 'plan') {
            if (window) {
                this.plan = [];
                this.stats.windows += 1;
                // gate: plan only where the imagined moves are far apart (a high-stakes window), else trust the imagination
                const gated = Math.max(...score) - Math.min(...score) < (this.cfg.gate ?? 0);
                if (gated) {
                    this.stats.gated += 1;
                } else if (sim && msg.sim) {
                    const planned = await this.planMoves(msg, sim, score);
                    if (planned !== null) {
                        [score, best] = planned;
                        this.stats.planned += 1;
                    }
                }
            } else {
                const j = this.followPlan(msg);
                if (j !== null) {
                    this.stats.followed += 1;
                    return j;
                }
                this.stats.unplanned += 1;
            }
        }
        // loop guard: if this exact observation keeps coming back, stop repeating the same pick
        const key = canon([nul(msg.prompt), nul(msg.state), msg.actions.map((x) => nul(x.label))]);
        if (!this.seen.has(key)) {
            this.seen.set(key, []);
        }
        const tried = this.seen.get(key);
        const order = argsortDesc(score);
        let pick = order[0];
        if (tried.length >= 2 && tried.includes(pick)) {
            const fresh = order.filter((i) => !tried.includes(i));
            pick = fresh.length ? fresh[0] : this.rng.below(n);
        }
        tried.push(pick);
        if (best !== null) {
            this.plan = [...(best.get(pick) || [])];
        }
        this.last = { score, tried, best };
        return pick;
    }

    /**
     * Play `i` instead of the last pick (a checker following another player's moves, parity.js): the loop guard and
     * the plan become what they would have been had this bot picked `i`.
     */
    adopt(i) {
        const { tried, best } = this.last ?? {};
        if (tried?.length) {
            tried[tried.length - 1] = i;
        }
        if (best) {
            this.plan = [...(best.get(i) || [])];
        }
    }

    // the protocol (an in-process client: stdio.js answer, or main.js over stdio)

    hello(msg) {
        this.newGame(msg.seed ?? 0);
        return this.needsSim && (msg.versions || []).includes(2) ? { t: 'ready', v: 2, name: this.name, sim: true } : { t: 'ready', v: 1, name: this.name };
    }

    async decide(msg, sim) {
        return { t: 'act', i: await this.pick(msg, sim) };
    }

    over() {
        return { t: 'ok' };
    }
}

module.exports = { JepaBot, TxModel, ResourcePolicy, PyRandom, loadModel, cardTables, encode, hashId, canon, actionKey, STATE_DIM, ACTION_DIM, TOKEN_DIM };
