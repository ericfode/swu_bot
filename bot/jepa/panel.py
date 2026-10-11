#!/usr/bin/env python3
"""Writes the JEPA strategy panel for the research dashboard (dashboard/README.md section 5).

    python3 bot/jepa/panel.py --state bot/jepa/panel-state.json --train bot/jepa/models/jepa-v1.train.json \
        [--thoughts /tmp/jepa-thoughts.json] [--out /mnt/project-files/dashboard/panels/jepa.json]

panel-state.json holds the hand-written parts (status, now, plan, thoughts, results table); the train.json
gives curves, probe quality and the 2-D latent map; the thoughts file is the bot's latest decision.
The file is written to a temp name and moved into place.
"""
import argparse
import html
import json
import os
import time


def latent_svg(train, thought):
    """Scatter of held-out positions in the latent PCA plane, plus the latest decision's imagined futures."""
    pts = train.get("map", {}).get("points", [])
    if not pts:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    extra = []
    if thought and thought.get("map"):
        extra.append(thought["map"]["now"])
        for a in thought["map"]["actions"]:
            extra += [a["xy1"], a["xy4"]]
    allx = xs + [p[0] for p in extra]
    ally = ys + [p[1] for p in extra]
    x0, x1, y0, y1 = min(allx), max(allx), min(ally), max(ally)
    W, H, pad = 560, 300, 16
    sx = lambda x: pad + (x - x0) / max(x1 - x0, 1e-6) * (W - 2 * pad)
    sy = lambda y: H - pad - (y - y0) / max(y1 - y0, 1e-6) * (H - 2 * pad)

    def col(v):  # value 0..1: red (losing) -> grey -> blue (winning)
        r = int(220 - 160 * v)
        b = int(60 + 160 * v)
        return f"rgb({r},90,{b})"

    out = [f'<svg viewBox="0 0 {W} {H}" width="100%" xmlns="http://www.w3.org/2000/svg" style="font:11px sans-serif">',
           '<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="#e0a020"/></marker></defs>']
    for p in pts:
        out.append(f'<circle cx="{sx(p[0]):.1f}" cy="{sy(p[1]):.1f}" r="2.2" fill="{col(p[3])}" opacity="0.55"/>')
    if thought and thought.get("map"):
        nx, ny = thought["map"]["now"]
        for k, a in enumerate(thought["map"]["actions"][:5]):
            chosen = a["i"] == thought.get("chosen")
            stroke = "#e0a020" if chosen else "#999"
            out.append(f'<line x1="{sx(nx):.1f}" y1="{sy(ny):.1f}" x2="{sx(a["xy1"][0]):.1f}" y2="{sy(a["xy1"][1]):.1f}" stroke="{stroke}" stroke-width="{2 if chosen else 1}" marker-end="url(#ar)"/>')
            out.append(f'<line x1="{sx(a["xy1"][0]):.1f}" y1="{sy(a["xy1"][1]):.1f}" x2="{sx(a["xy4"][0]):.1f}" y2="{sy(a["xy4"][1]):.1f}" stroke="{stroke}" stroke-dasharray="3,3"/>')
            if chosen or k < 3:
                out.append(f'<text x="{sx(a["xy4"][0]) + 4:.1f}" y="{sy(a["xy4"][1]):.1f}" fill="currentColor">{html.escape(str(a["label"])[:24])} {a["score"]:.2f}</text>')
        out.append(f'<circle cx="{sx(nx):.1f}" cy="{sy(ny):.1f}" r="5" fill="none" stroke="#e0a020" stroke-width="2"/>')
    out.append(f'<text x="{pad}" y="{H - 3}" fill="currentColor" opacity="0.7">dots: held-out positions, red = model thinks losing, blue = winning. ring: now; arrows: imagined next decision, dashed: 4 decisions on</text>')
    out.append("</svg>")
    return "".join(out)


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--state", default=os.path.join(here, "panel-state.json"))
    ap.add_argument("--train", default=os.path.join(here, "models", "jepa-v1.train.json"))
    ap.add_argument("--thoughts", default=os.environ.get("SWU_JEPA_THOUGHTS"))
    ap.add_argument("--out", default="/mnt/project-files/dashboard/panels/jepa.json")
    a = ap.parse_args()
    st = json.load(open(a.state))
    train = json.load(open(a.train)) if a.train and os.path.exists(a.train) else {}
    thought = json.load(open(a.thoughts)) if a.thoughts and os.path.exists(a.thoughts) else None

    widgets = list(st.get("widgets_before", []))
    ev = train.get("evals", [])
    if ev:
        last = ev[-1]
        widgets.append({"type": "stats", "items": [
            {"label": "latent size", "value": train.get("D")},
            {"label": "next-latent retrieval top-1 (of 512)", "value": f"{last['retrieval_top1']:.0%}"},
            {"label": "same, copy-z baseline", "value": f"{last['retrieval_top1_copy']:.0%}"},
            {"label": "value accuracy (held-out)", "value": f"{last['value_acc']:.0%}"},
            {"label": "training decisions", "value": train.get("train_rows")},
            {"label": "trainer / player", "value": "tinygrad / Python numpy"}]})
        widgets.append({"type": "line", "title": "Held-out prediction error in latent space (lower is better)", "x": "training step",
                        "series": [{"name": "JEPA predictor, +1 decision", "points": [[e["step"], round(e["pred1"], 5)] for e in ev]},
                                   {"name": "JEPA predictor, +4 decisions", "points": [[e["step"], round(e["pred4"], 5)] for e in ev]},
                                   {"name": "copy z (no predictor), +1", "points": [[e["step"], round(e["copy1"], 5)] for e in ev]}]})
    svg = latent_svg(train, thought)
    if svg:
        widgets.append({"type": "html", "title": "Latent space map (PCA of z) and the last decision's imagined futures", "height": 330,
                        "html": f'<div style="color:#888">{svg}</div>'})
    if thought:
        widgets.append({"type": "bars", "title": f"Last decision (round {thought.get('round')}, {thought.get('prompt') or ''}): predicted win chance per move",
                        "items": [{"label": f"{t['label']}" + (" (chosen)" if t["i"] == thought["chosen"] else ""), "value": round(t["score"], 3)} for t in thought["top"]]})
        if thought.get("probes"):
            widgets.append({"type": "table", "title": "What it imagines for the chosen move (read out of the latent by linear probes)",
                            "columns": ["board number", "now", "next decision", "4 decisions on"],
                            "rows": [[p["name"], f"{p['now']:.1f}", f"{p['next']:.1f}", f"{p['later']:.1f}"] for p in thought["probes"]]})
    if train.get("probes"):
        widgets.append({"type": "bars", "title": "How much of the board the latent holds (probe R² on held-out positions)",
                        "items": [{"label": p["name"], "value": round(p["r2"], 3)} for p in train["probes"]]})
    widgets += st.get("widgets_after", [])

    panel = {"schema": 1, "id": "jepa", "title": "JEPA latent planner (tinygrad)", "thread": "JEPA bot",
             "bots": st.get("bots", ["jepa"]), "status": st.get("status", "running"),
             "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
             "now": st.get("now", ""), "goal": st.get("goal", ""), "mentalModel": st.get("mentalModel", {}),
             "plan": st.get("plan", []), "thoughts": st.get("thoughts", [])[-12:], "widgets": widgets,
             "lang": "Python (numpy inference, tinygrad training)"}
    tmp = a.out + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(panel, fh)
    os.replace(tmp, a.out)
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
