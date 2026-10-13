'use strict';

const fs = require('fs');
const path = require('path');

/** Initialize once, then reuse the Rust card catalog across many persistent games. */
async function createSimulator({ poolPath, poolJson, cataloguePath, catalogueJson, packagePath } = {}) {
    const file = packagePath ?? path.join(__dirname, '../../omni-wasm/pkg/node/omni_wasm.js');
    if (!fs.existsSync(file)) throw new Error('Wasm package is not built. Run: node bot/omni-wasm/build.js --target node');
    const bindings = require(file);
    const { WasmSimulator } = await import('./adapter.mjs');
    const catalogue = catalogueJson ?? (cataloguePath === undefined ? undefined : fs.readFileSync(cataloguePath, 'utf8'));
    const defaultPool = catalogue === undefined ? path.join(__dirname, '../rs/pool.json') : undefined;
    const sourcePool = poolPath ?? defaultPool;
    const pool = poolJson ?? (sourcePool === undefined ? undefined : fs.readFileSync(sourcePool, 'utf8'));
    return new WasmSimulator(bindings, pool, { catalogueJson: catalogue });
}

/** Transfer the position once. Subsequent transitions/checkpoints/search stay in Wasm. */
function fromEnvGame(simulator, game, actor) {
    actor ??= game.ids.find((pid) => game.isActionWindow(pid));
    if (!actor || !game.isActionWindow(actor)) throw new Error('Import from forceteki at an action window; in-progress engine prompts cannot be reconstructed');
    const { fullState } = require('../rs/state');
    return simulator.loadState(fullState(game, actor), { ids: game.ids, names: game.names });
}

module.exports = { createSimulator, fromEnvGame };
