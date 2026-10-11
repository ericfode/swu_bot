'use strict';
/**
 * Strategy diagrams (schema "swu-strategy/1"): how a competitor shows the essence of its current strategy.
 * Declarative on purpose: a bot sends data, never code. The arena web UI and the research dashboard both draw it
 * with web/strategy-diagram.js (SVG, animated with anime.js when present). It is stored as a dashboard panel widget
 * {type: 'strategy', ...} (dashboard/README.md section 5).
 *
 * {
 *   "type": "strategy", "title": "How tuner-v3 picks a move", "caption": "one line",
 *   "nodes": [ { "id": "base", "label": "Enemy base HP", "kind": "input|feature|decision|action|memory", "value": 0.8, "note": "hover text" } ],
 *   "edges": [ { "from": "base", "to": "score", "weight": 1.5, "label": "x1.5" } ],
 *   "highlight": ["base", "score"],                         nodes (and edges between them) that drive decisions now
 *   "steps": [ { "caption": "...", "highlight": ["..."] } ]  optional storyboard, played in a loop
 * }
 * Limits: 40 nodes, 80 edges, 12 steps, strings 160 chars, numbers finite. Columns follow kind order:
 * input, memory, feature, decision, action.
 */
const KINDS = ['input', 'memory', 'feature', 'decision', 'action'];

function fail(msg) {
    const e = new Error(`diagram: ${msg}`);
    e.code = 'bad_request';
    throw e;
}

const str = (v, max = 160) => (v === undefined || v === null ? undefined : String(v).slice(0, max));
const num = (v) => (v === undefined || v === null ? undefined : Number.isFinite(Number(v)) ? Number(v) : fail('numbers must be finite'));
const ID = /^[A-Za-z0-9_.:-]{1,40}$/;

/** Returns a clean copy (unknown fields dropped) or throws bad_request. */
function validateDiagram(d) {
    if (!d || typeof d !== 'object') {
        fail('expected an object');
    }
    const nodes = Array.isArray(d.nodes) ? d.nodes : fail('nodes must be an array');
    const edges = Array.isArray(d.edges) ? d.edges : [];
    if (!nodes.length || nodes.length > 40) {
        fail('1-40 nodes');
    }
    if (edges.length > 80) {
        fail('at most 80 edges');
    }
    const ids = new Set();
    const outNodes = nodes.map((n) => {
        if (!n || !ID.test(String(n.id))) {
            fail('node id: 1-40 chars of letters, digits, _ . : -');
        }
        if (ids.has(n.id)) {
            fail(`duplicate node id ${n.id}`);
        }
        ids.add(n.id);
        return { id: n.id, label: str(n.label ?? n.id, 60), kind: KINDS.includes(n.kind) ? n.kind : 'feature', value: num(n.value), note: str(n.note) };
    });
    const outEdges = edges.map((e) => {
        if (!ids.has(e?.from) || !ids.has(e?.to)) {
            fail('edges must connect existing node ids');
        }
        return { from: e.from, to: e.to, weight: num(e.weight), label: str(e.label, 40) };
    });
    const hl = (h) => (Array.isArray(h) ? h.filter((x) => ids.has(x)).slice(0, 40) : []);
    const steps = Array.isArray(d.steps) ? d.steps.slice(0, 12).map((s) => ({ caption: str(s?.caption), highlight: hl(s?.highlight) })) : [];
    return { type: 'strategy', schema: 'swu-strategy/1', title: str(d.title, 100) ?? 'Strategy', caption: str(d.caption), nodes: outNodes, edges: outEdges, highlight: hl(d.highlight), steps };
}

module.exports = { validateDiagram, KINDS };
