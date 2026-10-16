'use strict';

const fs = require('fs');

/**
 * Adds a game's key to the end event (the last line) of its finished replay, atomically; nothing when there is none or
 * it has one. The runners (ladder.js, dev.js) add it once every game dealt from that key has ended.
 */
function addReplayKey(file, k) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        return;
    }
    const i = text.lastIndexOf('\n', text.length - 2) + 1;
    let end = null;
    try {
        end = JSON.parse(text.slice(i));
    } catch {
        return;
    }
    if (end?.t === 'end' && !end.key) {
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${text.slice(0, i)}${JSON.stringify({ ...end, key: k })}\n`);
        fs.renameSync(tmp, file);
    }
}

// Replay snapshots moved to view.js (one board view for bots and replays); this name stays for existing callers. Loaded
// when asked for, so a runner that only adds keys does not load the engine.
module.exports = { addReplayKey };
Object.defineProperty(module.exports, 'snapshot', { enumerable: true, get: () => require('./view').snapshot });
