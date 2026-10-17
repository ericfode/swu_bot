'use strict';
/** Read-only view of the preserved original window namespace. Never used by active ratings or submission intake. */
function read(store, parts, query = {}) {
    const json = (ns, id) => {
        const text = store.getDoc(ns, id);
        return text === null ? null : JSON.parse(text);
    };
    const [method, name, game] = parts;
    if (parts.length === 1 && ['status', 'standings', 'roster'].includes(method)) return json('arena', method);
    if (parts.length === 2 && ['versions', 'panel'].includes(method) && /^[a-z][a-z0-9_]{0,31}$/.test(name)) {
        return json('arena', `${method}-${name}`);
    }
    if (parts.length === 1 && method === 'report') {
        const rounds = store.listDocs('arena').map((d) => /^report-(\d+)$/.exec(d.id)).filter(Boolean).map((m) => Number(m[1]));
        const k = query.round === undefined ? Math.max(-1, ...rounds) : Number(query.round);
        return Number.isSafeInteger(k) && rounds.includes(k) ? json('arena', `report-${k}`) : null;
    }
    if (method === 'runs' && parts.length === 1) return store.listDocs('runs');
    if (method === 'runs' && parts.length === 2) return json('runs', name);
    if (method === 'replays' && parts.length === 2) return store.listReplays(name);
    if (method === 'replays' && parts.length === 3) return store.readReplay(name, game);
    return null;
}
module.exports = { read };
