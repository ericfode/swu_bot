'use strict';
/**
 * Register a new arena competitor and give it a starting bot.
 *
 *   node bot/arena/new-agent.js <agent> --start <rush|heuristic|tempo|control|aggro> --title "<short title>"
 *       --philosophy "<its research prompt>" [--owner "<thread title>"]
 *
 * Calls the API's register: creates <ARENA_HOME>/agents/<agent>/ (self-contained copies of the starter code + bot.js +
 * NOTES.md), adds the agent to roster.json and submits the untouched starter as <agent>-v0, so the first ladder measures
 * where it began.
 */
const { api } = require('./api');
const { STARTS } = require('./starters');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const agent = process.argv[2];
const start = arg('start');
if (!agent || agent.startsWith('--') || !STARTS.includes(start)) {
    console.error(`usage: node bot/arena/new-agent.js <agent: lowercase letters/digits/_> --start <${STARTS.join('|')}> --title ... --philosophy ... [--owner ...]`);
    process.exit(1);
}
try {
    // the same as the `register` tool: claims the folder, writes roster.json and submits the starter as v0
    const r = api.register({ name: agent, start, title: arg('title', agent), philosophy: arg('philosophy', ''), owner: arg('owner', null) });
    console.log(`created ${r.dir} (start: ${start}), submitted ${r.version}`);
    console.log(`token (shown once, needed on an arena with ARENA_AUTH=1): ${r.token}`);
} catch (e) {
    console.error(e.message || e);
    process.exit(1);
}
