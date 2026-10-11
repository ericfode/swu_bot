'use strict';
// `require('crypto')` inside a compiled JS bot (bot/compiled/js/bundle.js): QuickJS has no crypto module, so this
// gives the one piece our bots use, createHash('sha1') for situation keys, in plain JavaScript. Everything else throws
// when called, so a bot that needs more fails at its first use instead of playing differently.

const enc = new TextEncoder();

function sha1(bytes) {
    const n = bytes.length;
    const words = new Uint32Array((((n + 8) >>> 6) + 1) * 16);
    for (let i = 0; i < n; i++) {
        words[i >>> 2] |= bytes[i] << (24 - 8 * (i & 3));
    }
    words[n >>> 2] |= 0x80 << (24 - 8 * (n & 3));
    words[words.length - 1] = n * 8; // the message length in bits, low word (Uint32Array keeps it mod 2^32)
    words[words.length - 2] = Math.floor(n / 0x20000000); // and high word
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    const w = new Uint32Array(80);
    for (let off = 0; off < words.length; off += 16) {
        for (let t = 0; t < 16; t++) {
            w[t] = words[off + t];
        }
        for (let t = 16; t < 80; t++) {
            const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
            w[t] = (x << 1) | (x >>> 31);
        }
        let a = h0, b = h1, c = h2, d = h3, e = h4;
        for (let t = 0; t < 80; t++) {
            const f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
            const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
            const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) >>> 0;
            e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = tmp;
        }
        h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    return [h0, h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, '0')).join('');
}

function createHash(algorithm) {
    if (String(algorithm).toLowerCase() !== 'sha1') {
        throw new Error(`crypto.createHash('${algorithm}') is not available in a compiled bot (only sha1)`);
    }
    const parts = [];
    const hash = {
        update(data) {
            parts.push(typeof data === 'string' ? enc.encode(data) : data);
            return hash;
        },
        digest(encoding) {
            if (encoding !== 'hex') {
                throw new Error(`digest('${encoding}') is not available in a compiled bot (only hex)`);
            }
            const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
            let o = 0;
            for (const p of parts) {
                all.set(p, o);
                o += p.length;
            }
            return sha1(all);
        }
    };
    return hash;
}

const missing = (fn) => () => {
    throw new Error(`crypto.${fn} is not available in a compiled bot`);
};

module.exports = { createHash, createHmac: missing('createHmac'), randomBytes: missing('randomBytes') };
