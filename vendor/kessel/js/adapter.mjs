// The live position, checkpoints, and all search nodes belong to Rust/Wasm.
// Objects returned by snapshot() are detached observations, never mutable game state.
export class WasmSimulator {
    constructor(bindings, poolJson, { catalogueJson, backend, instrumentation } = {}) {
        if (catalogueJson !== undefined && typeof catalogueJson !== 'string') throw new TypeError('Pass the compiled catalogue as JSON text');
        if ((catalogueJson === undefined || poolJson !== undefined) && typeof poolJson !== 'string') throw new TypeError('Pass the original pool JSON text to preserve its SHA-256');
        this.bindings = bindings;
        this.handle = catalogueJson === undefined
            ? new bindings.WasmEngine(poolJson)
            : bindings.WasmEngine.fromCatalogue(catalogueJson, poolJson);
        this.disposed = false;
        try {
            if (backend !== undefined) this.handle.setRulesBackend(backend);
            if (instrumentation) this.handle.setRulesInstrumentation(true);
        } catch (error) { this.handle.free(); this.disposed = true; throw error; }
    }

    rulesBackendReport() {
        this.assertAlive();
        return JSON.parse(this.handle.rulesBackendReport());
    }

    assertAlive() {
        if (this.disposed) throw new Error('Wasm simulator has been freed');
    }

    get poolHash() {
        this.assertAlive();
        return this.handle.poolHash();
    }

    loadState(position, options = {}) {
        this.assertAlive();
        const row = typeof position === 'string' ? JSON.parse(position) : position;
        if (row?.pool?.sha256 && row.pool.sha256 !== this.poolHash) throw new Error('Position pool hash differs from the Wasm pool');
        const state = row?.fullState ?? row;
        return new WasmGame(this.handle.loadState(JSON.stringify(state)), options);
    }

    free() {
        if (this.disposed) return;
        this.handle.free();
        this.disposed = true;
    }
}

export class WasmGame {
    constructor(handle, options = {}) {
        let ids, names;
        try {
            ({ ids = ['p1', 'p2'], names = ids } = options);
            if (!Array.isArray(ids) || !Array.isArray(names) || ids.length !== 2 || ids[0] === ids[1] || names.length !== 2) throw new Error('Exactly two distinct player IDs and two names are required');
        } catch (error) {
            // The constructor takes ownership even if wrapper options are bad.
            handle.free();
            throw error;
        }
        this.handle = handle;
        this.ids = [...ids];
        this.names = [...names];
        this.marks = new Map();
        this.nextMark = 1;
        this.disposed = false;
    }

    assertAlive() {
        if (this.disposed) throw new Error('Wasm game has been freed');
    }

    seatOf(pid) {
        const i = this.ids.indexOf(pid);
        if (i >= 0) return i === 0 ? 'p1' : 'p2';
        if (pid === 'p1' || pid === 'p2') return pid;
        throw new Error(`Unknown player ${String(pid)}`);
    }

    get actor() {
        this.assertAlive();
        const seat = this.handle.actor();
        return seat ? this.ids[seat === 'p1' ? 0 : 1] : null;
    }

    get round() { this.assertAlive(); return this.handle.round(); }
    get over() { this.assertAlive(); return this.handle.over(); }
    get winner() { this.assertAlive(); return this.handle.winner() ?? null; }
    get winners() {
        const winner = this.winner;
        // Same shape as EnvGame.winners: a draw lists both players.
        if (winner === 'draw') return [...this.names];
        return winner === 'p1' || winner === 'p2' ? [this.names[winner === 'p1' ? 0 : 1]] : [];
    }

    isActionWindow(pid = this.actor) {
        this.assertAlive();
        return this.handle.isActionWindow() && pid !== null && this.seatOf(pid) === this.handle.actor();
    }

    snapshot() {
        this.assertAlive();
        return JSON.parse(this.handle.snapshot());
    }

    legalActions(pid = this.actor) {
        this.assertAlive();
        return pid === null ? [] : JSON.parse(this.handle.legalActions(this.seatOf(pid)));
    }

    // Accept EnvGame's apply(pid, action) or the shorter apply(action).
    apply(pid, action) {
        this.assertAlive();
        if (arguments.length === 1) { action = pid; pid = this.actor; }
        const key = typeof action === 'string' ? action : action?.key;
        if (typeof key !== 'string') throw new TypeError('Choose an action returned by legalActions(), or its canonical key');
        this.handle.apply(key, this.seatOf(pid));
        return this;
    }

    clone() {
        this.assertAlive();
        return new WasmGame(this.handle.clone(), { ids: this.ids, names: this.names });
    }

    mark(pid = this.actor) {
        this.assertAlive();
        if (pid !== null) this.seatOf(pid);
        const id = this.nextMark++;
        this.marks.set(id, this.handle.clone());
        return id;
    }

    restore(pid, id) {
        this.assertAlive();
        if (arguments.length === 1) { id = pid; pid = this.actor; }
        if (pid !== null) this.seatOf(pid);
        const checkpoint = this.marks.get(id);
        if (!checkpoint) throw new Error(`Unknown Wasm checkpoint ${id}`);
        const restored = checkpoint.clone();
        this.handle.free();
        this.handle = restored;
        for (const newer of this.marks.keys()) if (newer > id) this.releaseMark(newer);
        return this;
    }

    releaseMark(id) {
        const checkpoint = this.marks.get(id);
        if (!checkpoint) return false;
        checkpoint.free();
        this.marks.delete(id);
        return true;
    }

    prove(limits = {}) {
        this.assertAlive();
        return JSON.parse(this.handle.prove(JSON.stringify(limits)));
    }

    solve(depth = 12, limits = {}) { return this.prove({ ...limits, depth }); }

    bench(nodes = 100000) {
        this.assertAlive();
        if (!Number.isSafeInteger(nodes) || nodes <= 0) throw new Error('Benchmark nodes must be a positive safe integer');
        return JSON.parse(this.handle.bench(nodes));
    }

    free() {
        if (this.disposed) return;
        for (const id of this.marks.keys()) this.releaseMark(id);
        this.handle.free();
        this.disposed = true;
    }
}
