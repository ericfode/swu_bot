'use strict';

const fs = require('fs');
const path = require('path');

/** Initialize once, then reuse the Rust card catalog across many persistent games. */
async function createSimulator({ poolPath = path.join(__dirname, '../rs/pool.json'), poolJson, packagePath } = {}) {
    const file = packagePath ?? path.join(__dirname, '../../omni-wasm/pkg/node/omni_wasm.js');
    if (!fs.existsSync(file)) throw new Error('Wasm package is not built. Run: node bot/omni-wasm/build.js --target node');
    const bindings = require(file);
    const { WasmSimulator } = await import('./adapter.mjs');
    return new WasmSimulator(bindings, poolJson ?? fs.readFileSync(poolPath, 'utf8'));
}

/** Transfer the position once. Subsequent transitions/checkpoints/search stay in Wasm. */
function fromEnvGame(simulator, game, actor) {
    actor ??= game.ids.find((pid) => game.isActionWindow(pid));
    if (!actor || !game.isActionWindow(actor)) throw new Error('Import from forceteki at an action window; in-progress engine prompts cannot be reconstructed');
    const { fullState } = require('../rs/state');
    return simulator.loadState(fullState(game, actor), { ids: game.ids, names: game.names });
}

module.exports = { createSimulator, fromEnvGame };
