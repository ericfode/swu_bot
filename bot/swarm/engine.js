'use strict';
/**
 * The swarm's runtime set up for the engine (runtime.js, bot/swarm/README.md): the files of a pack (pack.js) under
 * /app, NODE_ENV=test as bot/env.js sets it, and two stand-ins the browser needs:
 *
 *   - forceteki's logger (build/server/logger.js) is a silent one, so winston and its streams never load;
 *   - uuid is crypto.randomUUID (uuid 14 is an ES module; the engine calls only v1 and v4, and replays never hold
 *     their values, which differ from run to run natively too).
 */
const { createRuntime } = require('./runtime');

const silent = new Proxy({}, { get: (_t, k) => (k === 'child' ? () => silent : () => undefined) });

function createEngineRuntime({ files, spawn = null, env = {}, log = console, cpus = 1, hostGlobal = globalThis } = {}) {
    const uuid = () => hostGlobal.crypto.randomUUID();
    const aliases = new Map([
        ['/app/forceteki/build/server/logger.js', { logger: silent, jsonOnlyLogger: silent }],
        ['uuid', { v1: uuid, v4: uuid, v7: uuid, validate: (s) => /^[0-9a-f-]{36}$/i.test(String(s)), NIL: '00000000-0000-0000-0000-000000000000' }]
    ]);
    return createRuntime({ files, cwd: '/app', env: { NODE_ENV: 'test', ...env }, spawn, aliases, log, cpus, hostGlobal });
}

module.exports = { createEngineRuntime };
