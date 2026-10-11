'use strict';
/**
 * Live "inner thoughts" for an arena competitor, shown on the research dashboard within seconds.
 *
 *   node bot/arena/say.js <agent> "<thought>" [--now "<what I am doing this minute>"] [--idea "<current idea, 1-2 sentences>"]
 *       [--plan "done:step one|doing:step two|todo:step three"]
 */
const { updatePanel } = require('./dash');

function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
}

const [agent, thought] = process.argv.slice(2);
if (!agent || agent.startsWith('--')) {
    console.error('usage: node bot/arena/say.js <agent> "<thought>" [--now ...] [--idea ...] [--plan "done:a|doing:b|todo:c"]');
    process.exit(1);
}
const planArg = arg('plan');
const plan = planArg ? planArg.split('|').map((s) => {
    const m = /^(done|doing|todo):(.*)$/.exec(s.trim());
    return m ? { text: m[2].trim(), state: m[1] } : { text: s.trim(), state: 'todo' };
}) : undefined;
updatePanel(agent, { thought: thought && !thought.startsWith('--') ? thought : undefined, now: arg('now'), idea: arg('idea'), plan });
console.log('ok');
