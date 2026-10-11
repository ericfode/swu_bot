"""Measure real evaluators against the Lean theory (theory/SwuTheory).

Input: JSONL from `node bot/td-measure.js` (one game per line: every action window with the position's
features `s` and the features of each 1-ply child `kids`), plus the omni solver's proven endgames: either
/mnt/project-files/omni/positions-hh.jsonl (preferred: relabelled by the fixed prover, see omni/POSITIONS.md) or
the raw solve runs in /mnt/project-files/omni/solve-hh/ (the first prover's labels, 4 of which are not proofs).

Evaluators, all turned into player 1 win probabilities:
  legacy   the heuristic score on fork main (base danger term ADDED, the known sign bug), calibrated
  fixed    the same score with the danger term subtracted (the omni bot's leaf score), calibrated
  mc       logistic regression on features, fitted to game results (outcome regression)
  td       the same model, fitted to minimise the TD loss on recorded windows (Fitness.lean `tdLoss`)

Usage: python3 theory/measure/td_residual.py <td dir> <positions.jsonl | solve dir> <out.json> [folds=5]
"""
import json
import math
import os
import sys

import numpy as np

KEYS = ['baseHp', 'danger', 'hand', 'resources', 'initiative', 'units', 'power', 'hp', 'cost', 'shields',
        'upgrades', 'sentinels', 'exhausted']


def heuristic(f, sign):
    """The heuristic evaluation from player 1's side (bot/players/heuristic.js, W and SIDE defaults)."""
    def side(x):
        base = 0.9 * x['baseHp'] + sign * x['danger'] / 6.0
        return 1.5 * base + x['unitValue'] + 1.8 * x['hand'] + 1.4 * x['resources'] + 2.5 * x['initiative']
    return side(f['p1']) - side(f['p2'])


def vec(f):
    """Model features: p1 minus p2 for each count, plus a bias."""
    return np.array([1.0] + [f['p1'][k] - f['p2'][k] for k in KEYS])


def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-np.clip(z, -40, 40)))


def logistic_fit(X, y, l2=1e-3, iters=300):
    """Logistic regression with soft targets y in [0,1], by Newton's method."""
    w = np.zeros(X.shape[1])
    for _ in range(iters):
        p = sigmoid(X @ w)
        g = X.T @ (p - y) / len(y) + l2 * np.r_[0, w[1:]]
        H = (X.T * (p * (1 - p))) @ X / len(y) + l2 * np.diag(np.r_[0, np.ones(len(w) - 1)])
        step = np.linalg.solve(H + 1e-9 * np.eye(len(w)), g)
        w -= step
        if np.max(np.abs(step)) < 1e-9:
            break
    return w


def load(td_dir):
    games = []
    for name in sorted(os.listdir(td_dir)):
        if name.endswith('.jsonl'):
            for line in open(os.path.join(td_dir, name)):
                line = line.strip()
                if line:
                    g = json.loads(line)
                    if g['outcome'] == 'won' and g['winner'] in ('p1', 'p2'):
                        games.append(g)
    seen = {}
    for g in games:
        seen[g['seed']] = g
    return [seen[k] for k in sorted(seen)]


class Evaluator:
    def __init__(self, name, score):
        self.name = name
        self.score = score  # features -> win probability for player 1 (non-terminal positions only)

    def value(self, f):
        if f['over']:
            return f['win']
        return self.score(f)

    def backup(self, w):
        """One step of perfect play over the recorded children (Value.lean `backup`).

        The children are the moves the bot played out. In large windows (over 40 actions, or target prompts with
        over 8 choices) the bot samples a random subset, so this is the backup over that subset, not over every
        legal move; the residual it gives is an estimate of the theorem's residual, not the exact value."""
        vals = [self.value(k) for k in w['kids']]
        if not vals:
            return None
        return max(vals) if w['actor'] == 'p1' else min(vals)


def calibrated(name, raw, games):
    """Turn a raw score into a probability with a 1-D logistic fit to game results (on training games)."""
    X, y = [], []
    for g in games:
        r = 1.0 if g['winner'] == 'p1' else 0.0
        for w in g['windows']:
            X.append([1.0, raw(w['s'])])
            y.append(r)
    a = logistic_fit(np.array(X), np.array(y))
    return Evaluator(name, lambda f: float(sigmoid(a[0] + a[1] * raw(f)))), a.tolist()


def fit_mc(games):
    X, y = [], []
    for g in games:
        r = 1.0 if g['winner'] == 'p1' else 0.0
        for w in g['windows']:
            X.append(vec(w['s']))
            y.append(r)
    X, y = np.array(X), np.array(y)
    mu, sd = X[:, 1:].mean(0), X[:, 1:].std(0) + 1e-9
    Xs = np.c_[np.ones(len(X)), (X[:, 1:] - mu) / sd]
    w = logistic_fit(Xs, y)
    return w, mu, sd


def model(w, mu, sd):
    return lambda f: float(sigmoid(w[0] + ((vec(f)[1:] - mu) / sd) @ w[1:]))


def child_table(games, mu, sd):
    """Stack every recorded child once, so a model's backup is a few vectorised operations."""
    rows, X, kid_x, kid_term, kid_win, owner = [], [], [], [], [], []
    for g in games:
        for ww in g['windows']:
            if not ww['kids']:
                continue
            r = len(rows)
            rows.append(ww)
            X.append(np.r_[1.0, (vec(ww['s'])[1:] - mu) / sd])
            for k in ww['kids']:
                owner.append(r)
                if k['over']:
                    kid_term.append(1)
                    kid_win.append(k['win'])
                    kid_x.append(np.zeros(len(KEYS) + 1))
                else:
                    kid_term.append(0)
                    kid_win.append(0.0)
                    kid_x.append(np.r_[1.0, (vec(k)[1:] - mu) / sd])
    is_max = np.array([ww['actor'] == 'p1' for ww in rows])
    return rows, np.array(X), np.array(kid_x), np.array(kid_term, bool), np.array(kid_win), np.array(owner), is_max


def backup_vec(w, table):
    rows, X, KX, term, win, owner, is_max = table
    v = np.where(term, win, sigmoid(KX @ w))
    mx = np.full(len(rows), -np.inf)
    mn = np.full(len(rows), np.inf)
    np.maximum.at(mx, owner, v)
    np.minimum.at(mn, owner, v)
    return np.where(is_max, mx, mn)


def fit_td(games, init, rounds=40, mix=0.0):
    """Fitted value iteration: targets = backup of the current model over recorded children, then refit.
    Terminal children carry the real result, which anchors the fit (Fitness.lean `tdLoss`).
    mix > 0 blends in the game result as a second anchor (a TD(lambda)-style target)."""
    w, mu, sd = init
    table = child_table(games, mu, sd)
    Xs = table[1]
    results = np.array([1.0 if g['winner'] == 'p1' else 0.0 for g in games for ww in g['windows'] if ww['kids']])
    hist = []
    for _ in range(rounds):
        y = (1 - mix) * backup_vec(w, table) + mix * results
        w_new = logistic_fit(Xs, y, iters=50)
        hist.append(float(np.mean((sigmoid(Xs @ w_new) - y) ** 2)))
        if np.max(np.abs(w_new - w)) < 1e-6:
            w = w_new
            break
        w = 0.5 * w + 0.5 * w_new
    return (w, mu, sd), hist


_POSITIONS = {}


def position_labels(path, g):
    """Proven labels from omni's positions file, keyed by window index; used only if every window lines up."""
    if path not in _POSITIONS:
        games = {}
        for line in open(path):
            r = json.loads(line)
            seq, labels = games.setdefault(r['seed'], [{}, {}])
            seq[r['i']] = (r['toMove'], r['round'])
            if r.get('proven') in ('p1', 'p2'):
                labels[r['i']] = 1.0 if r['proven'] == 'p1' else 0.0
        _POSITIONS[path] = games
    seq, labels = _POSITIONS[path].get(g['seed'], ({}, {}))
    # same game iff every window has the same side to move and round (a different bot can give equal counts)
    mine = {i: (w['actor'], w['round']) for i, w in enumerate(g['windows'])}
    return labels if seq == mine else {}


def solved_labels(solve_dir, g):
    if solve_dir.endswith('.jsonl'):
        return position_labels(solve_dir, g)
    path = os.path.join(solve_dir, f"heuristic-vs-heuristic-{g['seed']}.json")
    if not os.path.exists(path):
        return {}
    s = json.load(open(path))
    wl = s['windowsList']
    # same game iff every window lines up; the solver logs the step count before the move, td-measure after it
    if len(wl) != len(g['windows']) or any(b['step'] - a['step'] != 1 or a['actor'] != b['actor'] for a, b in zip(wl, g['windows'])):
        return {}  # the replay differs from the solver's game; do not use its labels
    return {x['i']: (1.0 if x['result'] == 'p1' else 0.0) for x in s['solves'] if x['result'] in ('p1', 'p2')}


def pct(xs, q):
    return float(np.percentile(xs, q)) if len(xs) else None


def measure(ev, games, solve_dir):
    res = {'brier': [], 'td': [], 'path': [], 'proven': []}
    for g in games:
        r = 1.0 if g['winner'] == 'p1' else 0.0
        ws = g['windows']
        n = len(ws)
        labels = solved_labels(solve_dir, g)
        vals = [ev.value(w['s']) for w in ws]
        resid = []
        for i, w in enumerate(ws):
            left = n - i  # action windows left, this one included
            res['brier'].append((left, (vals[i] - r) ** 2))
            b = ev.backup(w)
            resid.append(None if b is None else vals[i] - b)
            if b is not None:
                res['td'].append((left, vals[i] - b))
            nxt = vals[i + 1] if i + 1 < n else r
            res['path'].append((left, vals[i] - nxt))
        for i, truth in labels.items():
            if i >= n:
                continue
            left = n - i
            # path estimate only: Value.lean's bound needs eps over EVERY reachable position and a height over every
            # continuation, but this uses the residuals on the played path and the played length, so it is a
            # consistency check, not a certificate (an unplayed branch can be longer or have a larger residual)
            tail = [abs(x) for x in resid[i:] if x is not None]
            eps = max(tail) if tail else 0.0
            res['proven'].append({'seed': g['seed'], 'i': i, 'left': left, 'p': vals[i], 'truth': truth,
                                  'err': abs(vals[i] - truth), 'eps_path': eps, 'path_bound': min(1.0, eps * (left + 1)),
                                  'resid': resid[i]})
    return res


def summarize(res):
    out = {}
    br = np.array([x[1] for x in res['brier']])
    out['brier'] = float(br.mean())
    td = np.array([x[1] for x in res['td']])
    out['td_mean_abs'] = float(np.mean(np.abs(td)))
    out['td_mean'] = float(np.mean(td))
    out['td_p95_abs'] = pct(np.abs(td), 95)
    out['td_max_abs'] = float(np.max(np.abs(td)))
    out['td_loss'] = float(np.mean(td ** 2))
    path = np.array([x[1] for x in res['path']])
    out['path_mean_abs'] = float(np.mean(np.abs(path)))
    # residual and Brier by distance to the end of the game
    buckets = [(1, 3), (4, 10), (11, 30), (31, 60), (61, 100), (101, 1000)]
    out['by_left'] = []
    for lo, hi in buckets:
        t = [abs(x[1]) for x in res['td'] if lo <= x[0] <= hi]
        b = [x[1] for x in res['brier'] if lo <= x[0] <= hi]
        out['by_left'].append({'lo': lo, 'hi': hi, 'n': len(t), 'td_mean_abs': float(np.mean(t)) if t else None,
                               'brier': float(np.mean(b)) if b else None})
    pv = res['proven']
    if pv:
        out['proven_n'] = len(pv)
        out['proven_acc'] = float(np.mean([(p['p'] > 0.5) == (p['truth'] > 0.5) for p in pv]))
        out['proven_brier'] = float(np.mean([p['err'] ** 2 for p in pv]))
        out['proven_path_bound_holds'] = float(np.mean([p['err'] <= p['path_bound'] + 1e-12 for p in pv]))
        out['proven_path_bound_median'] = float(np.median([p['path_bound'] for p in pv]))
        out['proven_err_median'] = float(np.median([p['err'] for p in pv]))
        out['proven'] = pv
    return out


def fit_all(train):
    evs, params = {}, {}
    base = float(np.mean([1.0 if g['winner'] == 'p1' else 0.0 for g in train]))
    evs['const'] = Evaluator('const', lambda f: base)
    params['const'] = base
    evs['legacy'], params['legacy'] = calibrated('legacy', lambda f: heuristic(f, +1), train)
    evs['fixed'], params['fixed'] = calibrated('fixed', lambda f: heuristic(f, -1), train)
    mc = fit_mc(train)
    evs['mc'] = Evaluator('mc', model(*mc))
    params['mc'] = dict(zip(['bias'] + KEYS, mc[0].tolist()))
    tdp, _ = fit_td(train, mc)
    evs['td'] = Evaluator('td', model(*tdp))
    params['td'] = dict(zip(['bias'] + KEYS, tdp[0].tolist()))
    hyb, _ = fit_td(train, mc, mix=0.5)
    evs['hybrid'] = Evaluator('hybrid', model(*hyb))
    params['hybrid'] = dict(zip(['bias'] + KEYS, hyb[0].tolist()))
    return evs, params


def merge(parts):
    out = {k: [] for k in ('brier', 'td', 'path', 'proven')}
    for p in parts:
        for k in out:
            out[k] += p[k]
    return out


def main():
    td_dir, solve_dir, out_path = sys.argv[1:4]
    folds = int(sys.argv[4]) if len(sys.argv) > 4 else 5
    games = load(td_dir)
    if folds < 2 or len(games) < folds:
        sys.exit(f'need folds >= 2 and at least one game per fold (got {len(games)} games, {folds} folds)')
    # k-fold by game: every game is scored once by evaluators fitted on the other folds
    per = {}
    params = []
    for k in range(folds):
        test = [g for i, g in enumerate(games) if i % folds == k]
        train = [g for i, g in enumerate(games) if i % folds != k]
        evs, prm = fit_all(train)
        params.append(prm)
        for name, ev in evs.items():
            per.setdefault(name, []).append(measure(ev, test, solve_dir))
    _, full = fit_all(games)
    diffs = [abs(heuristic(w['s'], +1) - w['s']['check']) for g in games for w in g['windows'] if 'check' in w['s']]
    report = {
        'games': {'n': len(games), 'seeds': [g['seed'] for g in games], 'windows': sum(len(g['windows']) for g in games),
                  'p1_wins': sum(1 for g in games if g['winner'] == 'p1'),
                  'kids_per_window': float(np.mean([len(w['kids']) for g in games for w in g['windows']])),
                  'folds': folds},
        'legacy_check_max_diff': max(diffs) if diffs else None,
        'params_full': full,
        'evaluators': {k: summarize(merge(v)) for k, v in per.items()},
    }
    json.dump(report, open(out_path, 'w'), indent=1)
    for k, s in report['evaluators'].items():
        print(f"{k:7s} brier {s['brier']:.3f}  td|r| {s['td_mean_abs']:.3f} (p95 {s['td_p95_abs']:.3f})"
              f"  path|r| {s['path_mean_abs']:.3f}  proven {s.get('proven_n', 0)} acc {s.get('proven_acc', float('nan')):.2f}"
              f" brier {s.get('proven_brier', float('nan')):.3f} path-bound-holds {s.get('proven_path_bound_holds', float('nan')):.2f}"
              f" (median path bound {s.get('proven_path_bound_median', float('nan')):.2f}, err {s.get('proven_err_median', float('nan')):.2f})"
              f"  td-loss {s['td_loss']:.4f}")
    print('legacy check max diff', report['legacy_check_max_diff'])


if __name__ == '__main__':
    main()
