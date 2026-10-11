"""Summarize omni-pimc output: the PIMC (omniscient sampling) gap on real SWU endgames.

    python3 theory/measure/pimc_bias.py <dir-or-jsonl>... [--json out.json]

Input lines come from target/release/omni-pimc (bot/omni-rs/src/bin/omni-pimc.rs): one action window
each, with f(deal, move) in {1, 0, null} from the mover's view. For a complete window

    gap = E_deal[max_move f] - max_move E_deal[f]

is the expected loss of the PIMC move against the omniscient value (Hidden.lean, pimc_choice_loss).
Sums along a game use the windows of one mover along the recorded path; a window that is not complete
is left out, so a sum covers the complete windows only.
"""
import json
import os
import sys
from collections import defaultdict


def load(paths):
    rows = []
    for p in paths:
        files = [os.path.join(p, f) for f in sorted(os.listdir(p)) if f.endswith('.jsonl')] if os.path.isdir(p) else [p]
        for f in files:
            with open(f) as fh:
                rows += [json.loads(line) for line in fh if line.strip()]
    return rows


def bounds(r):
    """Gap bounds with every unproven f in [0, 1]: E[max lo] - max E[hi] <= gap <= E[max hi] - max E[lo]."""
    vals = r['values']
    k = len(vals)
    lo = [[0 if v is None else v for v in row] for row in vals]
    hi = [[1 if v is None else v for v in row] for row in vals]
    def emax(m):
        return sum(max(row) for row in m) / k
    def maxe(m):
        return max(sum(row[a] for row in m) / k for a in range(len(m[0])))
    return max(0.0, emax(lo) - maxe(hi)), emax(hi) - maxe(lo)


def summarize(rows, deals):
    for r in rows:
        r['solvedDeals'] = len(r['values']) == deals
        if r['solvedDeals']:
            r['gapLo'], r['gapHi'] = bounds(r)
            r['determined'] = r['gapHi'] - r['gapLo'] < 1e-12
    settled = [r for r in rows if r.get('determined')]
    known = [r for r in rows if r['solvedDeals']]
    proven = [v for r in known for row in r['values'] for v in row]
    extra = {
        'windowsAllDealsSolved': len(known),
        'provenShare': sum(v is not None for v in proven) / len(proven) if proven else None,
        'determined': len(settled),
        'determinedGapPositive': sum(r['gapLo'] > 1e-12 for r in settled),
        'gapLowerBoundPositive': sum(r['gapLo'] > 1e-12 for r in known),
        'gapLowerBoundMean': sum(r['gapLo'] for r in known) / len(known) if known else None,
        'gapUpperBoundMean': sum(r['gapHi'] for r in known) / len(known) if known else None,
        'moveValueVariesAcrossDeals': sum(1 for r in known if any(
            len({row[a] for row in r['values'] if row[a] is not None}) > 1 for a in range(len(r['moves'])))),
        'distinctDealsMean': sum(r['distinctDeals'] for r in known) / len(known) if known and 'distinctDeals' in known[0] else None,
    }
    base = summarize_complete(rows)
    base.update(extra)
    return base


def summarize_complete(rows):
    complete = [r for r in rows if r['complete']]
    by_end = defaultdict(lambda: [0, 0, 0, 0.0])  # tried, complete, gap>0, sum gap
    for r in rows:
        b = by_end[r['fromEnd']]
        b[0] += 1
        if r['complete']:
            b[1] += 1
            b[2] += r['gap'] > 1e-12
            b[3] += r['gap']
    # does the hidden part change any move's value at all?
    varies = sum(1 for r in complete if any(row != r['values'][0] for row in r['values']))
    choice = [r for r in complete if len(r['moves']) > 1]
    real_wrong = sum(1 for r in complete if r['realPimc'] < r['realBest'])
    games = defaultdict(lambda: {'gap': 0.0, 'windows': 0, 'positive': 0})
    for r in complete:
        g = games[(r['game'], r['mover'])]
        g['gap'] += r['gap']
        g['windows'] += 1
        g['positive'] += r['gap'] > 1e-12
    sums = sorted(g['gap'] for g in games.values())
    gaps = sorted(r['gap'] for r in complete)
    n = len(complete)
    return {
        'games': len({r['game'] for r in rows}),
        'windows': len(rows),
        'complete': n,
        'deals': max((len(r['values']) for r in complete), default=0),
        'withChoice': len(choice),
        'valuesVaryAcrossDeals': varies,
        'gapPositive': sum(g > 1e-12 for g in gaps),
        'gapMean': sum(gaps) / n if n else None,
        'gapMax': gaps[-1] if gaps else None,
        'pimcMoveLosesOnRealDeal': real_wrong,
        'byFromEnd': {k: {'tried': v[0], 'complete': v[1], 'gapPositive': v[2], 'gapMean': v[3] / v[1] if v[1] else None}
                      for k, v in sorted(by_end.items())},
        'gameSums': {'players': len(sums), 'positive': sum(s > 1e-12 for s in sums), 'mean': sum(sums) / len(sums) if sums else None,
                     'max': sums[-1] if sums else None,
                     'windowsPerPlayer': sum(g['windows'] for g in games.values()) / len(games) if games else None},
        'examples': [{k: r[k] for k in ('game', 'fromEnd', 'mover', 'oppHand', 'gap', 'omni', 'pimc', 'pimcMove')}
                     for r in sorted(complete, key=lambda r: -r['gap'])[:5] if r['gap'] > 1e-12],
    }


def main():
    args = sys.argv[1:]
    out = None
    if '--json' in args:
        i = args.index('--json')
        out = args[i + 1]
        args = args[:i] + args[i + 2:]
    rows = load(args)
    s = summarize(rows, max((len(r['values']) for r in rows), default=0))
    text = json.dumps(s, indent=1)
    if out:
        with open(out, 'w') as fh:
            fh.write(text + '\n')
    print(text)


if __name__ == '__main__':
    main()
