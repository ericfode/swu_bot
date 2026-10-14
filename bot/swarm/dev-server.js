#!/usr/bin/env node
'use strict';
/**
 * A local check of the swarm's browser side (bot/swarm/README.md): serves the built workers (build.js), a pack
 * (pack.js) and a page that plays one game in a browser tab and prints its result and the replay's sha256, to compare
 * with the same game played natively. It sends the headers that make the page cross-origin isolated (COOP, COEP),
 * which SharedArrayBuffer needs.
 *
 *   node bot/swarm/build.js && node bot/swarm/dev-server.js --pack <dir with engine.json> [--port 5190]
 *   open http://localhost:5190/?p1=rust-greedy2-wasm&p2=heuristic&seed=3250146062&key=bbb...
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const PORT = Number(arg('--port', process.env.PORT || 5190));
const BUILD = path.resolve(arg('--build', path.join(__dirname, '..', '..', 'build', 'swarm')));
const PACK = path.resolve(arg('--pack', BUILD));

const PAGE = `<!doctype html><meta charset="utf-8"><title>Swarm check</title>
<style>body{font:14px/1.5 ui-monospace,Menlo,monospace;margin:16px;background:#0d1220;color:#d6dbe8}b{color:#79a8ff}</style>
<h3>Swarm check</h3><div id="log"></div>
<script>
const log = (s) => { const d = document.createElement('div'); d.textContent = s; document.getElementById('log').append(d); };
const q = new URLSearchParams(location.search);
const job = { id: 'check', seed: Number(q.get('seed') || 3250146062), p1: q.get('p1') || 'rust-greedy2-wasm', p2: q.get('p2') || 'heuristic', key: q.get('key') || 'b'.repeat(64) };
log('crossOriginIsolated: ' + self.crossOriginIsolated + ', cores: ' + navigator.hardwareConcurrency);
const w = new Worker('/referee-worker.js');
let t0 = performance.now(), steps = 0;
w.onmessage = async (e) => {
  const m = e.data;
  if (m.t === 'ready') { log('engine ready in ' + m.ms + ' ms (build ' + m.build.slice(0, 7) + ')'); t0 = performance.now(); w.postMessage({ t: 'play', job, maxSteps: 3000, capMs: 60000 }); }
  else if (m.t === 'step') { steps++; if (steps % 25 === 0) log('step ' + m.step.n + ', round ' + m.step.state?.round); }
  else if (m.t === 'result') {
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m.replay || '')))].map((x) => x.toString(16).padStart(2, '0')).join('');
    log('RESULT ' + JSON.stringify({ outcome: m.result.outcome, winner: m.result.winner, steps: m.result.steps, error: m.result.error, ms: Math.round(performance.now() - t0), lines: (m.replay || '').split('\\n').length, sha: sha.slice(0, 16) }));
    window.swarmResult = { result: m.result, sha };
  } else if (m.t === 'error') { log('ERROR ' + m.message); window.swarmResult = { error: m.message }; }
};
w.onerror = (e) => { log('worker error: ' + e.message); window.swarmResult = { error: e.message }; };
w.postMessage({ t: 'init', pack: '/pack/engine.json', botWorker: '/bot-worker.js' });
</script>`;

http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const headers = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'same-origin', 'cache-control': 'no-store' };
    const send = (code, type, body) => {
        res.writeHead(code, { ...headers, 'content-type': type });
        res.end(body);
    };
    if (url.pathname === '/') {
        return send(200, 'text/html; charset=utf-8', PAGE);
    }
    const file = url.pathname.startsWith('/pack/') ? path.join(PACK, path.basename(url.pathname)) : path.join(BUILD, path.basename(url.pathname));
    if (!fs.existsSync(file)) {
        return send(404, 'text/plain', 'not found');
    }
    send(200, file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : 'application/octet-stream', fs.readFileSync(file));
}).listen(PORT, () => console.log(`swarm check on http://localhost:${PORT}/ (build ${BUILD}, pack ${PACK})`));
