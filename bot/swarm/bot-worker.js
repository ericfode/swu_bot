'use strict';
/**
 * A swarm bot worker (bot/swarm/README.md): runs one bot bundle's WebAssembly under the WASI host (wasi.js), in a
 * browser Worker or a Node worker thread. It gets one message,
 *   {t: 'start', module: WebAssembly.Module, args, env, preopens: [{guest, files: [[path, Uint8Array]]}], stdin: SAB}
 * and answers with {t: 'out', data} and {t: 'err', data} (Uint8Array chunks of stdout and stderr) while the bot runs,
 * then {t: 'exit', code, trap?}. The bot blocks on its stdin, which the referee writes into the shared pipe.
 */
(function main() {
    const inNode = typeof self === 'undefined' && typeof process !== 'undefined' && !!process.versions?.node;
    const { WasiHost, StdinReader } = inNode ? require('./wasi') : self.SwarmWasi;
    const port = inNode ? require('worker_threads').parentPort : self;
    const post = (m, transfer) => port.postMessage(m, transfer);
    const onMessage = async (msg) => {
        if (!msg || msg.t !== 'start') {
            return;
        }
        const perf = globalThis.performance;
        const host = new WasiHost({
            args: msg.args,
            env: msg.env,
            preopens: msg.preopens.map((p) => ({ guest: p.guest, files: new Map(p.files) })),
            stdin: new StdinReader(msg.stdin),
            stdout: (data) => post({ t: 'out', data }, [data.buffer]),
            stderr: (data) => post({ t: 'err', data }, [data.buffer]),
            now: () => perf.timeOrigin + perf.now(),
            mono: () => perf.now(),
            random: (a) => globalThis.crypto.getRandomValues(a)
        });
        let r;
        try {
            r = await host.run(msg.module);
        } catch (e) {
            r = { code: 134, trap: String(e?.message ?? e) };
        }
        post({ t: 'exit', code: r.code, trap: r.trap ?? null });
    };
    if (inNode) {
        port.on('message', onMessage);
    } else {
        self.onmessage = (e) => onMessage(e.data);
    }
})();
