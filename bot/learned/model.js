'use strict';

/**
 * Forward pass of the learned model in plain JS (no dependencies). Weights come from bot/learned/train.py.
 *
 *   z      = enc(state)                          the "world model" latent for a position
 *   value  = tanh(val(z))                        expected result for the deciding seat, -1 loss .. +1 win
 *   logit  = pol([z, prompt, action])            one score per legal action; softmax over the legal set
 *   s'     = state + dyn([z, action])            predicted next state features (learned dynamics)
 *
 * Every layer is dense; hidden layers use ReLU. Weight matrices are stored row-major as [in][out] flattened.
 */
const fs = require('fs');

function dense(x, L, relu) {
    const { W, b, nin, nout } = L;
    const y = new Float32Array(nout);
    y.set(b);
    for (let i = 0; i < nin; i++) {
        const xi = x[i];
        if (xi === 0) {
            continue;
        }
        const row = i * nout;
        for (let j = 0; j < nout; j++) {
            y[j] += xi * W[row + j];
        }
    }
    if (relu) {
        for (let j = 0; j < nout; j++) {
            if (y[j] < 0) {
                y[j] = 0;
            }
        }
    }
    return y;
}

function mlp(x, layers) {
    let h = x;
    layers.forEach((L, k) => {
        h = dense(h, L, k < layers.length - 1);
    });
    return h;
}

const cat = (...xs) => {
    const out = new Float32Array(xs.reduce((s, x) => s + x.length, 0));
    let o = 0;
    for (const x of xs) {
        out.set(x, o);
        o += x.length;
    }
    return out;
};

function decode(b64) {
    const buf = Buffer.from(b64, 'base64');
    const out = new Float32Array(buf.length / 4);
    for (let i = 0; i < out.length; i++) {
        out[i] = buf.readFloatLE(i * 4);
    }
    return out;
}

class Model {
    constructor(json) {
        // W and b are base64 strings of little-endian float32 (train.py), or plain number arrays
        const f32 = (x) => (typeof x === 'string' ? decode(x) : Float32Array.from(x));
        const conv = (layers) => layers.map((L) => ({ W: f32(L.W), b: f32(L.b), nin: L.nin, nout: L.nout }));
        this.meta = json.meta;
        this.enc = conv(json.enc);
        this.val = conv(json.val);
        this.pol = conv(json.pol);
        this.dyn = json.dyn ? conv(json.dyn) : null;
        // inputs are standardised with the training set's mean/std
        this.norm = { s: json.norm.s.map((x) => Float32Array.from(x)), a: json.norm.a.map((x) => Float32Array.from(x)) };
    }

    static load(file) {
        return new Model(JSON.parse(fs.readFileSync(file, 'utf8')));
    }

    _ns(s) {
        const [m, sd] = this.norm.s;
        return Float32Array.from(s, (x, i) => (x - m[i]) / sd[i]);
    }

    _na(a) {
        const [m, sd] = this.norm.a;
        return Float32Array.from(a, (x, i) => (x - m[i]) / sd[i]);
    }

    encode(s) {
        return mlp(this._ns(s), this.enc);
    }

    value(z) {
        return Math.tanh(mlp(z, this.val)[0]);
    }

    /** Logits for each action feature vector. The first layer's state/prompt part is computed once. */
    logits(z, p, acts) {
        const [L1, ...rest] = this.pol;
        const zp = cat(z, Float32Array.from(p));
        const head = { W: L1.W.subarray(0, zp.length * L1.nout), b: L1.b, nin: zp.length, nout: L1.nout };
        const base = dense(zp, head, false);
        const tail = { W: L1.W.subarray(zp.length * L1.nout), b: new Float32Array(L1.nout), nin: L1.nin - zp.length, nout: L1.nout };
        return acts.map((a) => {
            const h = dense(this._na(a), tail, false);
            for (let j = 0; j < h.length; j++) {
                h[j] = Math.max(0, h[j] + base[j]);
            }
            return mlp(h, rest)[0];
        });
    }

    /** Predicted next state features after taking action `a` (raw feature scale). */
    next(s, z, a) {
        if (!this.dyn) {
            return null;
        }
        const d = mlp(cat(z, this._na(a)), this.dyn);
        return Float32Array.from(s, (x, i) => x + d[i]);
    }
}

module.exports = { Model };
