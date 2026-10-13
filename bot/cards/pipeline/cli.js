#!/usr/bin/env node
'use strict';
const { compileCatalog } = require('../../card-compiler/build');
const { planCards, run, recordReview } = require('./run');
const { coverage } = require('./coverage');
function options(args) {
    const o = { cards: [] };
    for (let i = 0; i < args.length; i++) {
        const flag = args[i];
        if (flag === '--no-mutations') o.mutations = false;
        else if (['--card', '--cards', '--out', '--run', '--file'].includes(flag)) {
            const value = args[++i];
            if (!value || value.startsWith('--')) throw new Error('Missing ' + flag + ' value');
            if (flag === '--card' || flag === '--cards') o.cards.push(...value.split(','));
            else o[flag.slice(2)] = value;
        } else throw new Error('Unknown option ' + flag);
    }
    return o;
}
async function main(args) {
    const [cmd, ...rest] = args,
        o = options(rest);
    if (cmd === 'plan') {
        const catalogue = compileCatalog(),
            plans = planCards(catalogue, o.cards);
        return { plans, coverage: coverage(plans) };
    }
    if (cmd === 'run') return run(o);
    if (cmd === 'review') return recordReview(o);
    throw new Error(
        'Usage: cards:pipeline plan --cards ID,ID | run --cards ID,ID --out NEW_DIR [--no-mutations] | review --run DIR --file REVIEW_JSON',
    );
}
if (require.main === module)
    main(process.argv.slice(2))
        .then((r) => console.log(JSON.stringify(r, null, 2)))
        .catch((e) => {
            console.error(e.stack ?? e);
            process.exitCode = 1;
        });
module.exports = { options, main };
