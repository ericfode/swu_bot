'use strict';
/**
 * A bot bundle's canonical tar (bot/compiled/bundle.py), read in the browser: unpack(bytes, hex) checks that the tar's
 * sha256 is the bundle id the job names (the machine checked that same tar at intake), then returns its files. Like
 * bundle.py unpack it takes only plain files and folders, with names that stay inside the bundle, at most 64 MB.
 */
const { sha256, toHex } = require('./runtime');

const MAX_BYTES = 64 << 20;
const dec = new TextDecoder();

const field = (b, off, len) => {
    const s = dec.decode(b.subarray(off, off + len));
    const i = s.indexOf('\0');
    return i < 0 ? s : s.slice(0, i);
};

/** [[relative path, Uint8Array]] of the files in the tar; throws when the tar is not the bundle `hex` or is not plain. */
function unpack(bytes, hex) {
    if (bytes.length > MAX_BYTES + (4 << 20)) {
        throw new Error('the bundle is too large');
    }
    if (toHex(sha256(bytes)) !== hex) {
        throw new Error(`the bundle's sha256 is not ${hex}`);
    }
    const files = [];
    let total = 0;
    for (let off = 0; off + 512 <= bytes.length;) {
        const h = bytes.subarray(off, off + 512);
        if (h.every((x) => x === 0)) {
            break;
        }
        const name = field(h, 0, 100);
        const prefix = field(h, 345, 155);
        const size = parseInt(field(h, 124, 12).trim() || '0', 8);
        const type = String.fromCharCode(h[156] || 48);
        const rel = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, '').replace(/\/$/, '');
        if (!rel || rel.startsWith('/') || rel.split('/').includes('..') || !Number.isFinite(size) || size < 0) {
            throw new Error(`the bundle has a bad entry ${JSON.stringify(rel)}`);
        }
        off += 512;
        if (type === '0' || type === '\0') {
            total += size;
            if (total > MAX_BYTES) {
                throw new Error('the bundle unpacks to more than 64 MB');
            }
            files.push([rel, bytes.slice(off, off + size)]);
        } else if (type !== '5') {
            throw new Error(`the bundle has an entry that is not a file or a folder: ${rel}`);
        }
        off += Math.ceil(size / 512) * 512;
    }
    return files;
}

module.exports = { unpack };
