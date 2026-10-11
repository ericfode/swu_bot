'use strict';
// node bot/learn/selfplay-round.js --model bot/rust-learned/models/learned-v4.safetensors --next learned-v5 \
//      [--games 2400] [--seed 400000] [--workers 4] [--opponent rust-greedy] [--data data/traj/random-v1,...] [--td 0.5]
//
// One round of policy improvement for the Rust learned bot:
//   1. the current model plays (with a little exploration) half its games against --opponent and half against itself,
//      recorded as swu-traj/1 under data/traj/<next>/;
//   2. a new model is trained on all earlier data plus the new games, with labels blended between the game result and
//      the current model's value of the same seat's next turn (--td; 0 = game result only).
// Earlier data defaults to every folder under data/traj/.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const root = path.join(__dirname, '..', '..');
const bin = path.join(root, 'bot/rust-learned/target/release/swu-learned');
const model = arg('model', 'bot/rust-learned/models/learned-v4.safetensors');
const next = arg('next');
if (!next) {
    console.error('--next <name> is required (e.g. learned-v5)');
    process.exit(2);
}
const games = Number(arg('games', 2400));
const seed = Number(arg('seed', 400000));
const workers = arg('workers', '4');
const opponent = arg('opponent', 'rust-greedy');
const trajRoot = path.join(root, 'data/traj');
const earlier = arg('data', null)?.split(',') ?? (fs.existsSync(trajRoot) ? fs.readdirSync(trajRoot).map((d) => path.join('data/traj', d)) : []);
const out = path.join('data/traj', next);

// a private registry: the base one plus the explorer that plays as the current model
const base = JSON.parse(fs.readFileSync(path.join(root, 'bot/external-bots.json'), 'utf8'));
base['learner-explore'] = { cmd: 'bot/rust-learned/target/release/swu-learned', lang: 'rust', args: ['play', '--model', model, '--temp', '0.3', '--epsilon', '0.05', '--name', 'learner-explore'], stderr: 'ignore' };
const reg = path.join(os.tmpdir(), `swu-bots-${process.pid}.json`);
fs.writeFileSync(reg, JSON.stringify(base));
const env = { ...process.env, SWU_EXTERNAL_BOTS: reg };
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, env, stdio: 'inherit' });

const half = Math.floor(games / 2);
run('node', ['bot/learn/collect.js', '--games', String(half), '--seed', String(seed), '--workers', workers, '--bots', `learner-explore,${opponent}`, '--out', out]);
run('node', ['bot/learn/collect.js', '--games', String(games - half), '--seed', String(seed + half), '--workers', workers, '--bots', 'learner-explore,learner-explore', '--out', out]);
run(bin, ['train', '--data', [...earlier.filter((d) => d !== out), out].join(','), '--out', `bot/rust-learned/models/${next}.safetensors`, '--epochs', '2', '--teacher', model, '--td', arg('td', '0.5')]);
fs.unlinkSync(reg);
console.log(`trained bot/rust-learned/models/${next}.safetensors; compare it with: node bot/learn/eval.js --bots <new>,<old> (register both in a registry file)`);
