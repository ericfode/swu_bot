"""Fit an anchored linear evaluator in the position-eval bench's feature space and write it as a bench model.

Input:
  frames   JSONL from `node bot/eval/td-frames.js` (one game per line; every action window with the actor's frame `s`
           and the frames of the children its one-ply search scored, all from the actor's subjective view)
  proven   JSONL from `node bot/eval/proven-frames.js` (the omni solver's proven positions, side to move's view)

Model: the bench's `linear` kind (bot/eval/evaluators.js linearLogit), logit = sum_i w_i * d_i / std_i + wToAct * toAct,
where d = me - opp side features. It has no intercept, so the two players' views agree (antisymmetric).

Loss (theory/SwuTheory/Fitness.lean): fitted value iteration on soft targets
  target(s) = (1 - mix) * backup(s) + mix * result(s)       backup = max over the actor's children (terminal = 0/1)
plus every proven position as an exact anchor with total weight `alpha` x the windows' total weight.
mix = 1, alpha = 0 is plain outcome regression; mix = 0, alpha = 0 is pure TD (which a constant can satisfy on a
finite sample); the anchors pin the fixed point to known true values.

Usage: python3 theory/measure/anchored_fit.py <frames dir> <proven.jsonl> <report.json> [--write name:mix:alpha:l2 ...]
  Cross-validates every configuration in CONFIGS (5 folds; frames games and proven games are both split by game),
  then fits each --write configuration on all data and writes bot/eval/models/<name>.json.
"""
import glob
import json
import os
import sys
import zlib

import numpy as np

N_SIDE = 30  # len(SIDE_KEYS) in bot/eval/features.js
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# name, mix, alpha, l2. l2 pulls the weights toward the `base` evaluator (base HP difference only), not toward zero:
# outcomes are per game, so a few hundred games overfit 31 weights unless they are held near a sound prior.
CONFIGS = [
    ('mc', 1.0, 0.0, 1e-3), ('mc-reg', 1.0, 0.0, 0.1), ('mc+anchor', 1.0, 0.2, 0.1),
    ('td', 0.0, 0.0, 1e-3), ('td+anchor', 0.0, 0.2, 0.1),
    ('hybrid', 0.5, 0.0, 1e-3), ('hybrid-reg', 0.5, 0.0, 0.1),
    ('hybrid+anchor', 0.5, 0.2, 1e-3), ('hybrid+anchor-reg.03', 0.5, 0.2, 0.03), ('hybrid+anchor-reg', 0.5, 0.2, 0.1),
    ('hybrid+anchor-reg.3', 0.5, 0.2, 0.3), ('hybrid+anchor.5-reg', 0.5, 0.5, 0.1),
]


def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))


def load_frames(d):
    games = []
    for f in sorted(glob.glob(os.path.join(d, '*.jsonl'))):
        for line in open(f):
            line = line.strip()
            if not line:
                continue
            try:
                g = json.loads(line)
            except json.JSONDecodeError:
                continue  # a game still being written
            if g.get('winner') in ('p1', 'p2') and g['windows']:
                games.append(g)
    games.sort(key=lambda g: g['seed'])
    return games


def load_proven(path):
    return [json.loads(l) for l in open(path) if l.strip()]


class Table:
    """All windows of some games, flattened for vectorized backups."""

    def __init__(self, games):
        S, R, kid_x, kid_t, kid_win, owner, left = [], [], [], [], [], [], []
        self.game = []
        for gi, g in enumerate(games):
            n = len(g['windows'])
            for j, w in enumerate(g['windows']):
                wi = len(S)
                left.append(n - j)  # action windows left, this one included
                S.append(w['s'])
                R.append(1.0 if g['winner'] == w['a'] else 0.0)
                self.game.append(gi)
                for k in w['kids']:
                    owner.append(wi)
                    if isinstance(k, dict):
                        kid_t.append(len(kid_x))
                        kid_win.append(float(k['t']))
                        kid_x.append([0.0] * len(w['s']))
                    else:
                        kid_x.append(k)
        self.S = np.array(S, dtype=float)
        self.R = np.array(R)
        self.game = np.array(self.game)
        self.K = np.array(kid_x, dtype=float) if kid_x else np.zeros((0, self.S.shape[1]))
        self.owner = np.array(owner, dtype=int)
        self.term = np.array(kid_t, dtype=int)
        self.term_val = np.array(kid_win)
        self.has_kids = np.bincount(self.owner, minlength=len(S)) > 0
        self.round = self.S[:, N_SIDE + 1]
        self.left = np.array(left)


def design(X, std):
    return np.hstack([X[:, :N_SIDE] / std, X[:, N_SIDE:N_SIDE + 1]])


def values(w, X, std):
    return sigmoid(design(X, std) @ w)


def backup(w, t, std):
    v = values(w, t.K, std)
    v[t.term] = t.term_val
    out = np.full(len(t.S), -np.inf)
    np.maximum.at(out, t.owner, v)
    return out


def logistic(X, y, wt, l2=1e-3, iters=30, w=None, w0=None):
    """Weighted logistic regression on soft targets y in [0,1], no intercept (Newton), ridge toward w0."""
    n = X.shape[1]
    w0 = np.zeros(n) if w0 is None else w0
    w = w0.copy() if w is None else w.copy()
    W = wt / wt.sum()
    for _ in range(iters):
        p = sigmoid(X @ w)
        g = X.T @ (W * (p - y)) + l2 * (w - w0)
        H = (X * (W * p * (1 - p))[:, None]).T @ X + l2 * np.eye(n)
        step = np.linalg.solve(H, g)
        w -= step
        if np.max(np.abs(step)) < 1e-8:
            break
    return w


def base_prior(t, std):
    """Weights of the `base` evaluator in design space: c * baseHp difference, c fitted on results."""
    w0 = np.zeros(N_SIDE + 1)
    w0[0] = base_scale(t) * std[0]
    return w0


def fit(t, proven, std, mix, alpha, l2=1e-3, rounds=40):
    Xs = design(t.S, std)
    ws = np.ones(len(t.S))
    Xa = design(np.array([p['x'] for p in proven]), std) if proven and alpha > 0 else np.zeros((0, Xs.shape[1]))
    ya = np.array([p['y'] for p in proven], dtype=float) if len(Xa) else np.zeros(0)
    wa = np.full(len(Xa), alpha * len(Xs) / max(1, len(Xa)))
    X = np.vstack([Xs, Xa])
    wt = np.concatenate([ws, wa])
    # start from outcome regression; with mix = 1 that is also the answer
    w0 = base_prior(t, std)
    w = logistic(X, np.concatenate([t.R, ya]), wt, l2=l2, w0=w0)
    if mix >= 1.0:
        return w
    for _ in range(rounds):
        b = backup(w, t, std)
        tgt = np.where(t.has_kids, (1 - mix) * b + mix * t.R, t.R)
        w_new = logistic(X, np.concatenate([tgt, ya]), wt, l2=l2, w=w, w0=w0, iters=15)
        done = np.max(np.abs(w_new - w)) < 1e-5
        w = 0.5 * w + 0.5 * w_new
        if done:
            break
    return w


def stds(t):
    return np.maximum(1e-3, t.S[:, :N_SIDE].std(axis=0))


def score(w, t, proven, std):
    """Per-row results for one test fold; merge() pools folds row by row."""
    p = values(w, t.S, std)
    b = backup(w, t, std)
    out = {'sq': (p - t.R) ** 2, 'left': t.left, 'late': t.round >= np.percentile(t.round, 75),
           'resid': np.where(t.has_kids, p - b, np.nan)}
    if proven:
        pa = values(w, np.array([q['x'] for q in proven]), std)
        ya = np.array([q['y'] for q in proven], dtype=float)
        out['p_hit'] = (pa > 0.5) == (ya == 1)
        out['p_sq'] = (pa - ya) ** 2
    return out


BUCKETS = [(1, 3), (4, 10), (11, 30), (31, 60), (61, 100), (101, 1000)]  # as in td_residual.py


def merge_scores(parts):
    cat = {k: np.concatenate([p[k] for p in parts if k in p]) for k in parts[0]}
    for k in ('p_hit', 'p_sq'):
        if any(k in p for p in parts):
            cat[k] = np.concatenate([p[k] for p in parts if k in p])
    r = cat['resid'][~np.isnan(cat['resid'])]
    out = {'brier': float(cat['sq'].mean()), 'brier_late': float(cat['sq'][cat['late']].mean()),
           'td_mean_abs': float(np.abs(r).mean()), 'td_loss': float((r ** 2).mean()), 'by_left': []}
    for lo, hi in BUCKETS:
        m = (cat['left'] >= lo) & (cat['left'] <= hi)
        rm = m & ~np.isnan(cat['resid'])
        out['by_left'].append({'lo': lo, 'hi': hi, 'n': int(m.sum()),
                               'td_mean_abs': float(np.abs(cat['resid'][rm]).mean()) if rm.any() else None,
                               'brier': float(cat['sq'][m].mean()) if m.any() else None})
    if 'p_hit' in cat:
        out['proven_n'] = int(len(cat['p_hit']))
        out['proven_hits'] = int(cat['p_hit'].sum())
        out['proven_acc'] = float(cat['p_hit'].mean())
        out['proven_brier'] = float(cat['p_sq'].mean())
    return out


def fold_of_game(name, k):
    return zlib.crc32(name.encode()) % k


def base_scale(t):
    """The bench's `base` evaluator: logit = c * baseHp difference, c fitted on results."""
    x = t.S[:, :1]
    c = logistic(x, t.R, np.ones(len(x)), l2=0)
    return c[0]


def model_json(name, w, std, mix, alpha, l2, n_games, n_proven):
    return {
        'name': name, 'kind': 'linear', 'decks': False,
        'w': [float(v) for v in w[:N_SIDE]], 'std': [float(v) for v in std], 'wToAct': float(w[N_SIDE]),
        'fit': {'by': 'theory/measure/anchored_fit.py', 'mix': mix, 'alpha': alpha, 'l2_to_base': l2, 'games': n_games, 'proven': n_proven,
                'loss': 'fitted value iteration on (1-mix)*backup + mix*result, proven positions as exact anchors'},
    }


def main():
    frames_dir, proven_path, out_path = sys.argv[1:4]
    writes = [a.split(':') for a in sys.argv[4:] if a != '--write']
    games = load_frames(frames_dir)
    proven = load_proven(proven_path)
    k = 5
    report = {'games': len(games), 'windows': sum(len(g['windows']) for g in games), 'proven': len(proven),
              'proven_to_move_wins': int(sum(p['y'] for p in proven)), 'configs': {}}
    parts = {c[0]: [] for c in CONFIGS}
    parts['base'] = []
    for f in range(k):
        tr_g = [g for i, g in enumerate(games) if i % k != f]
        te_g = [g for i, g in enumerate(games) if i % k == f]
        tr_p = [p for p in proven if fold_of_game(p['game'], k) != f]
        te_p = [p for p in proven if fold_of_game(p['game'], k) == f]
        tr, te = Table(tr_g), Table(te_g)
        std = stds(tr)
        for name, mix, alpha, l2 in CONFIGS:
            w = fit(tr, tr_p, std, mix, alpha, l2)
            parts[name].append(score(w, te, te_p, std))
        parts['base'].append(score(base_prior(tr, std), te, te_p, std))
        print(f'fold {f} done', flush=True)
    for name, ps in parts.items():
        report['configs'][name] = merge_scores(ps)
    full = Table(games)
    std = stds(full)
    for name, mix, alpha, l2 in writes:
        w = fit(full, proven, std, float(mix), float(alpha), float(l2))
        path = os.path.join(ROOT, 'bot', 'eval', 'models', f'{name}.json')
        json.dump(model_json(name, w, std, float(mix), float(alpha), float(l2), len(games), len(proven)), open(path, 'w'), indent=1)
        report.setdefault('written', {})[name] = {'mix': float(mix), 'alpha': float(alpha), 'l2': float(l2), 'w': [float(v) for v in w]}
        print(f'wrote {path}')
    json.dump(report, open(out_path, 'w'), indent=1)
    print(f"{report['games']} games, {report['windows']} windows, {report['proven']} proven "
          f"(side to move wins {report['proven_to_move_wins']})")
    for name, s in report['configs'].items():
        print(f"{name:18s} brier {s['brier']:.4f} late {s['brier_late']:.4f} td|r| {s['td_mean_abs']:.4f} "
              f"proven {s.get('proven_hits', 0)}/{s.get('proven_n', 0)} brier {s.get('proven_brier', float('nan')):.3f}")


if __name__ == '__main__':
    main()
