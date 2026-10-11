'use strict';
/**
 * Where the arena's shared state lives. Code is in the repo (bot/arena/*.js); data is in ARENA_HOME so every project
 * thread (each in its own container) sees the same bots and standings:
 *   roster.json                 competitors and baselines
 *   agents/<agent>/             each competitor's live, editable bot (bot.js + anything it requires from its own folder)
 *   versions/<agent>-v<N>/      frozen submissions; the referee only rates these
 *   standings.json, rounds/     referee output
 * Default: /mnt/project-files/arena when the project folder exists, else arena-home/ in the repo (gitignored).
 */
const fs = require('fs');
const path = require('path');

const HOME = path.resolve(process.env.ARENA_HOME ?? (fs.existsSync('/mnt/project-files') ? '/mnt/project-files/arena' : path.join(__dirname, '..', '..', 'arena-home')));
const AGENTS = path.join(HOME, 'agents');
const VERSIONS = path.join(HOME, 'versions');
const ROSTER = path.join(HOME, 'roster.json');
const RESULTS = path.resolve(process.env.ARENA_RESULTS ?? (fs.existsSync('/mnt/project-files') ? '/mnt/project-files/results' : path.join(__dirname, '..', '..', 'results')));

function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file);
}

function readJson(file, dflt) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return dflt;
    }
}

function roster() {
    return readJson(ROSTER, { thinkCapMs: 60000, baselines: ['rush', 'heuristic'], agents: [] });
}

/** Submitted version numbers of an agent, ascending. */
function versionsOf(agent) {
    if (!fs.existsSync(VERSIONS)) {
        return [];
    }
    return fs.readdirSync(VERSIONS)
        .map((d) => new RegExp(`^${agent}-v(\\d+)$`).exec(d))
        .filter(Boolean)
        .map((m) => Number(m[1]))
        .sort((a, b) => a - b);
}

module.exports = { HOME, AGENTS, VERSIONS, ROSTER, RESULTS, writeJson, readJson, roster, versionsOf };
