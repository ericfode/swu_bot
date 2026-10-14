'use strict';

const fs = require('fs');
const path = require('path');

/** Initialize once, then reuse the Rust card catalog across many persistent games. */
async function createSimulator({ poolPath, poolJson, cataloguePath, catalogueJson, packagePath, backend, instrumentation } = {}) {
    const file = packagePath ?? path.join(__dirname, '../pkg/node/kessel_wasm.js');
    if (!fs.existsSync(file)) throw new Error('Wasm package is not built. Run: node crates/kessel-wasm/build.js --target node');
    const bindings = require(file);
    const { WasmSimulator } = await import('./adapter.mjs');
    const catalogue = catalogueJson ?? (cataloguePath === undefined ? undefined : fs.readFileSync(cataloguePath, 'utf8'));
    const defaultPool = catalogue === undefined ? path.join(__dirname, '../../kessel/data/pool.json') : undefined;
    const sourcePool = poolPath ?? defaultPool;
    const pool = poolJson ?? (sourcePool === undefined ? undefined : fs.readFileSync(sourcePool, 'utf8'));
    return new WasmSimulator(bindings, pool, { catalogueJson: catalogue, backend, instrumentation });
}

/** Transfer the position once. Subsequent transitions/checkpoints/search stay in Wasm.
 *  `fullState(game, actor)` exports a forceteki game in the simulator's state format; the exporter
 *  belongs to the forceteki harness (swu_bot's bot/omni/rs/state.js), so the caller passes it in. */
function fromEnvGame(simulator, game, actor, fullState) {
    if (typeof fullState !== 'function') throw new Error('fromEnvGame needs the forceteki state exporter: fromEnvGame(simulator, game, actor, fullState)');
    actor ??= game.ids.find((pid) => game.isActionWindow(pid));
    if (!actor || !game.isActionWindow(actor)) throw new Error('Import from forceteki at an action window; in-progress engine prompts cannot be reconstructed');
    return simulator.loadState(fullState(game, actor), { ids: game.ids, names: game.names });
}

module.exports = { createSimulator, fromEnvGame };
