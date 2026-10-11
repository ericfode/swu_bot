'use strict';
/**
 * Register a new arena competitor and give it a starting bot.
 *
 *   node bot/arena/new-agent.js <agent> --start <rush|heuristic|tempo|control|aggro> --title "<short title>"
 *       --philosophy "<its research prompt>" [--owner "<thread title>"]
 *
 * Creates <ARENA_HOME>/agents/<agent>/ (self-contained copies of the starter code + bot.js + NOTES.md), adds the agent
 * to roster.json and submits the untouched starter as <agent>-v0, so the first ladder measures where it began.
 */
const fs = require('fs');
const path = require('path');
const { AGENTS, ROSTER, writeJson, roster } = require('./home');
const { botSource, STARTS } = require('./starters');
const { submit } = require('./submit');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const agent = process.argv[2];
const start = arg('start');
if (!agent || !/^[a-z][a-z0-9_]*$/.test(agent) || !STARTS.includes(start)) {
    console.error(`usage: node bot/arena/new-agent.js <agent: lowercase letters/digits/_> --start <${STARTS.join('|')}> --title ... --philosophy ... [--owner ...]`);
    process.exit(1);
}
const dir = path.join(AGENTS, agent);
if (fs.existsSync(dir)) {
    console.error(`${dir} already exists`);
    process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });
for (const f of ['heuristic.js', 'rush.js']) {
    fs.copyFileSync(path.join(__dirname, 'starters', f), path.join(dir, f));
}
fs.writeFileSync(path.join(dir, 'bot.js'), botSource(start));
fs.writeFileSync(path.join(dir, 'NOTES.md'), `# ${agent} notes\n\nWhat you tried, what you measured, what you plan next. Read this first when you come back.\n`);
const r = roster();
r.agents = [...r.agents.filter((a) => a.name !== agent), { name: agent, title: arg('title', agent), start, philosophy: arg('philosophy', ''), owner: arg('owner', null) }];
writeJson(ROSTER, r);
const v = submit(agent, `starting strategy: ${start}`, { check: false });
console.log(`created ${dir} (start: ${start}), submitted ${v}`);
