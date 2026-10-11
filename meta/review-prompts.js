'use strict';

/**
 * Writes one reviewer prompt per persona for a screenshot folder: node meta/review-prompts.js <shotsDir>
 * Output: <shotsDir>/prompt-<persona>.txt. Each is handed to a fresh reviewer agent that sees only the images.
 */
const fs = require('fs');
const path = require('path');

const dir = path.resolve(process.argv[2]);
const tpl = fs.readFileSync(path.join(__dirname, 'review-prompt.md'), 'utf8');
const quiz = JSON.parse(fs.readFileSync(path.join(dir, 'quiz.json'), 'utf8'));
const files = fs.readdirSync(dir);
const imgs = (re) => files.filter((f) => re.test(f)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((f) => path.join(dir, f));
const PERSONAS = {
    glance: ['Eric, the project owner, checking between meetings. You give the first screen about 45 seconds. Only what jumps out counts.', imgs(/^hero\.png$/)],
    analyst: ['A careful bot builder who reads the whole page on a laptop, wanting to know what to fix in their own bot.', imgs(/^desktop-light-tile\d+\.png$/)],
    phone: ['Someone opening the link on a phone, scrolling with a thumb.', imgs(/^phone-light-tile\d+\.png$/)],
};
for (const [name, [persona, images]] of Object.entries(PERSONAS)) {
    const text = tpl
        .replace('{{PERSONA}}', persona)
        .replace('{{IMAGES}}', images.join(', '))
        .replace('{{QUESTIONS}}', quiz.questions.map((q) => `- ${q.id}: ${q.q}`).join('\n'));
    fs.writeFileSync(path.join(dir, `prompt-${name}.txt`), text);
}
console.log(Object.keys(PERSONAS).map((n) => path.join(dir, `prompt-${n}.txt`)).join('\n'));
