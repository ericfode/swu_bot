import init, * as bindings from '../../omni-wasm/pkg/web/omni_wasm.js';
import { WasmSimulator } from './adapter.mjs';

/** poolJson is raw JSON text fetched by the caller; no filesystem or Node APIs are used. */
export async function createSimulator({ poolJson, wasm } = {}) {
    await init(wasm);
    return new WasmSimulator(bindings, poolJson);
}
