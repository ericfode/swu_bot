"""Train the learned bot's model with tinygrad from bot/learned/gen.js data.

    python3 bot/learned/train.py --data data/learned/run1 [--data more/dirs ...] --out models/learned/v1.json

One small network with three heads, trained together:
  enc : state features -> latent z ("world model" encoding of the position)
  val : z -> expected result for the deciding seat (tanh, -1..+1), trained on final game results
  pol : [z, prompt, action] -> logit, softmax over the legal actions, trained to copy the teacher's choice
  dyn : [z, action] -> change in state features after the action (learned dynamics), trained on recorded transitions

The JSON it writes is read by bot/learned/model.js. Games are split train/validation by game, not by decision.
"""
import argparse, base64, glob, json, os, time
import numpy as np
from tinygrad import Context, Tensor, TinyJit, nn

K = 24  # max legal actions per decision kept for policy training (larger prompts are skipped)


def load(dirs):
    parts = []
    versions = set()
    for d in dirs:
        for w in sorted(glob.glob(os.path.join(d, 'w*'))) or [d]:
            if not os.path.exists(os.path.join(w, 'meta.i32')):
                continue
            f = json.load(open(os.path.join(w, 'features.json')))
            S, P, A = f['S'], f['P'], f['A']
            meta = np.fromfile(os.path.join(w, 'meta.i32'), dtype=np.int32).reshape(-1, 8)
            n = len(meta)
            m = int(meta[:, 4].sum())
            acts = np.fromfile(os.path.join(w, 'A.f32'), dtype=np.float32)
            # a worker still writing (or killed mid-write) can leave a partial game at the end: keep complete rows only.
            # gen.js cuts such a tail when it restarts, so extra rows can only be at the end, never in the middle.
            s = np.fromfile(os.path.join(w, 'S.f32'), dtype=np.float32)[: n * S].reshape(n, S)
            sn = np.fromfile(os.path.join(w, 'Sn.f32'), dtype=np.float32)[: n * S].reshape(n, S)
            p = np.fromfile(os.path.join(w, 'P.f32'), dtype=np.float32)[: n * P].reshape(n, P)
            acts = acts[: m * A].reshape(m, A)
            # gen.js before the resume fix replayed its first seeds after a restart: drop a game that repeats an earlier one
            # (same seed, length, winner and rounds; games from other sources can share a seed but not all of these)
            seen = {}
            for line in open(os.path.join(w, 'games.jsonl')):
                g = json.loads(line)
                seen.setdefault((g.get('seed'), g.get('decisions'), g.get('winner'), g.get('round')), g['game'])
            first = set(seen.values())
            keep = np.array([g in first for g in meta[:, 0]], dtype=bool)
            if not keep.all():
                print(f'{w}: dropping {len(set(meta[~keep, 0]))} games that repeat an earlier game')
                s, sn, p, meta, acts = s[keep], sn[keep], p[keep], meta[keep], acts[np.repeat(keep, meta[:, 4])]
            gid = meta[:, 0].astype(np.int64) + 1_000_000 * len(parts)  # unique game id across worker dirs
            parts.append(dict(S=s, Sn=sn, P=p, A=acts, meta=meta, gid=gid, dims=(S, P, A)))
            versions.add(f.get('version'))
    assert parts, 'no data found'
    # the model records one feature version (bots encode its inputs that way), so the data must agree
    assert len(versions) == 1, f'data mixes feature versions {sorted(versions, key=str)}: train on one version'
    dims = parts[0]['dims']
    off = 0
    out = {k: [] for k in ['S', 'Sn', 'P', 'A', 'meta', 'gid', 'aoff']}
    for q in parts:
        assert q['dims'] == dims, 'feature sizes differ between data dirs'
        offs = np.concatenate([[0], np.cumsum(q['meta'][:, 4])[:-1]]) + off
        off += len(q['A'])
        for k in ['S', 'Sn', 'P', 'A', 'meta', 'gid']:
            out[k].append(q[k])
        out['aoff'].append(offs)
    return {k: np.concatenate(v) for k, v in out.items()}, dims, versions.pop()


class MLP:
    """Dense layers, ReLU between them, linear output. Weights are [in][out], the layout model.js reads."""

    def __init__(self, sizes):
        self.layers = [(Tensor.randn(a, b) * np.sqrt(2.0 / a), Tensor.zeros(b)) for a, b in zip(sizes[:-1], sizes[1:])]
        for W, b in self.layers:
            W.requires_grad = True
            b.requires_grad = True

    def __call__(self, x):
        for i, (W, b) in enumerate(self.layers):
            x = x @ W + b
            if i < len(self.layers) - 1:
                x = x.relu()
        return x

    def params(self):
        return [t for L in self.layers for t in L]


class Net:
    def __init__(self, S, P, A, H=128):
        Tensor.manual_seed(0)
        self.enc = MLP([S, H, H])
        self.val = MLP([H, 64, 1])
        self.pol = MLP([H + P + A, 128, 64, 1])
        self.dyn = MLP([H + A, 128, S])
        # start the dynamics head at "nothing changes"
        W, b = self.dyn.layers[-1]
        W.assign(W * 0.01).realize()
        self.heads = {'enc': self.enc, 'val': self.val, 'pol': self.pol, 'dyn': self.dyn}

    def params(self):
        return [t for h in self.heads.values() for t in h.params()]

    def value(self, s):
        return self.val(self.enc(s))[:, 0].tanh()

    def logits(self, s, p, a, mask):
        z = self.enc(s)
        B, Kk, _ = a.shape
        x = z.unsqueeze(1).expand(B, Kk, z.shape[1]).cat(p.unsqueeze(1).expand(B, Kk, p.shape[1]), a, dim=-1)
        return mask.where(self.pol(x)[..., 0], -1e9)

    def dynamics(self, s, a):
        return self.dyn(self.enc(s).cat(a, dim=-1))


def losses(net, pb, vb, db):
    s, p, a, mask, y1h, w = pb
    logp = net.logits(s, p, a, mask).log_softmax(-1)
    lp = -((logp * y1h).sum(-1) * w).sum() / w.sum()
    vs, vz = vb
    lv = ((net.value(vs) - vz) ** 2).mean()
    ds, da, dd = db
    ld = ((net.dynamics(ds, da) - dd) ** 2).mean() * 10.0
    return lp, lv, ld


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', action='append', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--steps', type=int, default=6000)
    ap.add_argument('--lr', type=float, default=1e-3)
    ap.add_argument('--wd', type=float, default=0.01, help='AdamW weight decay')
    ap.add_argument('--window-weight', type=float, default=3.0, help='policy loss weight of searched action-window labels vs rule-based labels')
    args = ap.parse_args()

    D, (S, P, A), fversion = load(args.data)
    meta = D['meta']
    N = len(meta)
    games = np.unique(D['gid'])
    rs = np.random.RandomState(0)
    val_games = set(rs.choice(games, max(1, len(games) // 10), replace=False).tolist())
    is_val = np.array([g in val_games for g in D['gid']])
    print(f'{N} decisions, {len(games)} games ({len(val_games)} validation), dims S={S} P={P} A={A}')

    s_mean, s_std = D['S'][~is_val].mean(0), np.maximum(D['S'][~is_val].std(0), 0.05)
    # action rows of training decisions only, so held-out games do not shape the preprocessing
    tr_rows = np.concatenate([np.arange(o, o + k) for o, k in zip(D['aoff'][~is_val], meta[~is_val, 4])])
    a_mean, a_std = D['A'][tr_rows].mean(0), np.maximum(D['A'][tr_rows].std(0), 0.05)
    ns = lambda x: (x - s_mean) / s_std
    na = lambda x: (x - a_mean) / a_std
    Sn_all, An_all = ns(D['S']).astype(np.float32), na(D['A']).astype(np.float32)

    label, nact, iswin, outcome = meta[:, 2], meta[:, 4], meta[:, 5], meta[:, 6]
    pol_ok = (label >= 0) & (nact >= 2) & (nact <= K)
    val_ok = outcome != -9

    def pol_batch(idx):
        B = len(idx)
        a = np.zeros((B, K, A), np.float32)
        mask = np.zeros((B, K), bool)
        for r, i in enumerate(idx):
            k = nact[i]
            a[r, :k] = An_all[D['aoff'][i]: D['aoff'][i] + k]
            mask[r, :k] = True
        w = np.where(iswin[idx] == 1, args.window_weight, 1.0).astype(np.float32)
        return Sn_all[idx], D['P'][idx], a, mask, label[idx].astype(np.int32), w

    def played_actions(idx):
        return np.stack([An_all[D['aoff'][i] + meta[i, 3]] for i in idx])

    tr_pol, va_pol = np.where(pol_ok & ~is_val)[0], np.where(pol_ok & is_val)[0]
    tr_val, va_val = np.where(val_ok & ~is_val)[0], np.where(val_ok & is_val)[0]
    has_next = meta[:, 7] >= 0  # from-traj.js rows have no recorded next state
    tr_all, va_all = np.where(~is_val & has_next)[0], np.where(is_val & has_next)[0]
    print(f'policy samples {len(tr_pol)}/{len(va_pol)} (windows {int(iswin[tr_pol].sum())}), value samples {len(tr_val)}/{len(va_val)}')

    net = Net(S, P, A)
    opt = nn.optim.AdamW(net.params(), lr=args.lr, weight_decay=args.wd)

    @TinyJit
    def train_step(s, p, a, mask, y1h, w, vs, vz, ds, da, dd, lr):
        with Context(TRAINING=1):
            opt.zero_grad()
            lp, lv, ld = losses(net, (s, p, a, mask, y1h, w), (vs, vz), (ds, da, dd))
            (lp + lv + ld).backward()
            opt.lr.assign(lr)
            opt.step()
            return lp.realize(), lv.realize(), ld.realize()

    t0 = time.time()
    rs_eval = np.random.RandomState(1)
    for it in range(args.steps + 1):
        lr = args.lr * (0.1 ** (it / args.steps))
        pi = rs.choice(tr_pol, 256)
        vi = rs.choice(tr_val, 512)
        di = rs.choice(tr_all, 512)
        s_, p_, a_, m_, y_, w_ = pol_batch(pi)
        y1h = np.zeros((len(pi), K), np.float32)
        y1h[np.arange(len(pi)), y_] = 1
        T = Tensor
        parts = train_step(T(s_), T(p_), T(a_), T(m_), T(y1h), T(w_), T(Sn_all[vi]), T(outcome[vi].astype(np.float32)),
                           T(Sn_all[di]), T(played_actions(di)), T((D['Sn'][di] - D['S'][di]).astype(np.float32)), T([lr], dtype='float32'))
        if it % 1000 == 0:
            lp, lv, ld = (float(x.item()) for x in parts)
            # held-out losses on fixed samples, to see overfitting while it trains
            vp = rs_eval.choice(va_pol, 256)
            s_, p_, a_, m_, y_, w_ = pol_batch(vp)
            vlp = float(-(net.logits(Tensor(s_), Tensor(p_), Tensor(a_), Tensor(m_)).log_softmax(-1).numpy()[np.arange(256), y_]).mean())
            vv = rs_eval.choice(va_val, 512)
            vlv = float(((net.value(Tensor(Sn_all[vv])).numpy() - outcome[vv]) ** 2).mean())
            print(f'step {it} train pol {lp:.3f} val {lv:.3f} dyn {ld:.4f} | held-out pol {vlp:.3f} val {vlv:.3f} ({time.time() - t0:.0f}s)', flush=True)

    # ---- evaluation on held-out games ----
    report = {}

    def pol_acc(idx):
        hit = {0: [0, 0], 1: [0, 0]}
        for c in range(0, len(idx), 1024):
            b = idx[c: c + 1024]
            s, p, a, mask, y, _ = pol_batch(b)
            pred = net.logits(Tensor(s), Tensor(p), Tensor(a), Tensor(mask)).argmax(-1).numpy()
            for w, ok in zip(iswin[b], pred == y):
                hit[int(w)][0] += int(ok)
                hit[int(w)][1] += 1
        # chance level: picking uniformly among the legal actions
        return {('window' if w else 'other'): round(h[0] / max(1, h[1]), 4) for w, h in hit.items()} | {
            'chance_window': round(float(np.mean(1 / nact[idx][iswin[idx] == 1])) if (iswin[idx] == 1).any() else 0, 4),
            'chance_other': round(float(np.mean(1 / nact[idx][iswin[idx] == 0])) if (iswin[idx] == 0).any() else 0, 4)}

    report['policy_acc_train'] = pol_acc(tr_pol[:20000])
    report['policy_acc_val'] = pol_acc(va_pol)
    v = net.value(Tensor(Sn_all[va_val])).numpy()
    z = outcome[va_val]
    report['value_mse_val'] = round(float(np.mean((v - z) ** 2)), 4)
    report['value_mse_const'] = round(float(np.mean(z ** 2)), 4)
    report['value_sign_acc_val'] = round(float(np.mean(np.sign(v) == np.sign(z))), 4)
    rnd = np.round(D['S'][va_val][:, 0] * 15).astype(int)
    report['value_sign_acc_by_round'] = {int(r): [round(float(np.mean(np.sign(v[rnd == r]) == np.sign(z[rnd == r]))), 3), int((rnd == r).sum())] for r in np.unique(rnd) if (rnd == r).sum() >= 50}
    dp = net.dynamics(Tensor(Sn_all[va_all[:20000]]), Tensor(played_actions(va_all[:20000]))).numpy()
    dt = D['Sn'][va_all[:20000]] - D['S'][va_all[:20000]]
    report['dyn_mse_val'] = float(np.mean((dp - dt) ** 2))
    report['dyn_mse_nochange'] = float(np.mean(dt ** 2))
    # value-head sensitivity: d value / d feature, times the feature's spread, averaged over validation positions
    x = Tensor(Sn_all[va_val[:5000]])
    x.requires_grad = True
    net.value(x).sum().backward()
    report['value_sensitivity'] = (x.grad.numpy().mean(0)).round(4).tolist()
    report['data'] = {'decisions': int(N), 'games': int(len(games)), 'policy_samples': int(len(tr_pol)), 'value_samples': int(len(tr_val))}
    print(json.dumps({k: v for k, v in report.items() if k != 'value_sensitivity'}, indent=1))

    def export(layers):
        # weights as base64 of little-endian float32, row-major [in][out]
        b64 = lambda x: base64.b64encode(np.asarray(x, '<f4').reshape(-1).tobytes()).decode()
        return [{'nin': int(W.shape[0]), 'nout': int(W.shape[1]), 'W': b64(W.numpy()), 'b': b64(b.numpy())} for W, b in layers.layers]

    # parity check for model.js: raw inputs and this network's outputs on a few held-out decisions
    ci = va_pol[:4]
    cs, cp, ca, cm, _, _ = pol_batch(ci)
    check = [{'s': D['S'][i].tolist(), 'p': D['P'][i].tolist(), 'A': D['A'][D['aoff'][i]: D['aoff'][i] + nact[i]].tolist(),
              'value': float(net.value(Tensor(Sn_all[i:i + 1])).numpy()[0]),
              'logits': net.logits(Tensor(cs[r:r + 1]), Tensor(cp[r:r + 1]), Tensor(ca[r:r + 1]), Tensor(cm[r:r + 1])).numpy()[0, :nact[i]].tolist()} for r, i in enumerate(ci)]
    out = {'check': check, 'meta': {'features': {'version': fversion, 'S': S, 'P': P, 'A': A}, 'created': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'data': args.data, 'steps': args.steps, 'report': report},
           'norm': {'s': [s_mean.round(6).tolist(), s_std.round(6).tolist()], 'a': [a_mean.round(6).tolist(), a_std.round(6).tolist()]},
           **{k: export(v) for k, v in net.heads.items()}}
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    json.dump(out, open(args.out, 'w'))
    print('wrote', args.out, os.path.getsize(args.out) // 1024, 'KB')


if __name__ == '__main__':
    main()
