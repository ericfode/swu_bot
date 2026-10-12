#!/usr/bin/env node
'use strict';
const lib = require('./library');
async function main(args) {
    const command = args.shift(), options = {};
    const names = { '--case': 'case', '--card': 'card', '--behavior': 'behavior', '--out': 'out', '--pool': 'pool', '--seed': 'seed', '--corpus': 'corpus', '--runtime': 'runtime', '--native': 'native', '--catalogue': 'catalogue', '--receipt': 'receipt' };
    const flags = { '--engine-only': 'engineOnly', '--include-setup': 'includeSetup', '--diagnostics': 'diagnostics', '--play': 'play' };
    while (args.length) { const arg = args.shift(); if (flags[arg]) options[flags[arg]] = true; else if (names[arg]) { const value = args.shift(); if (!value || value.startsWith('--')) throw Error(arg + ' needs a value'); options[names[arg]] = value; } else throw Error('Unknown option ' + arg); }
    let result;
    if (command === 'index') result = require('./index').build();
    else if (command === 'verify') result = lib.verify(options.corpus);
    else if (command === 'list') result = lib.selectCases(options, lib.registry(), lib.corpus(options.corpus).recordings);
    else if (command === 'generate') result = await require('./generate').generate(options);
    else if (command === 'check') result = await require('./check').check(options);
    else if (command === 'import') result = await require('./check').adopt(options);
    else throw Error('Usage: cards:reference index|verify|list|generate|check|import [--case ID | --card SET_NNN | --behavior ID] [--out NEW_DIR | --corpus DIR] [--runtime native|wasm|both]');
    console.log(JSON.stringify(result, null, 2));
}
if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(e.stack); process.exitCode = 1; });
module.exports = { main };
