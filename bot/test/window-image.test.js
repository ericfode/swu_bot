'use strict';
// The arena image (Dockerfile) is built only when main deploys, from a build context that .dockerignore cuts down to
// what the window needs. A file the Dockerfile copies but .dockerignore leaves out fails that deploy (the open tables'
// deck lists did, 2026-10-16), so check it here, where pull requests run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/** Whether .dockerignore's rules let `rel` into the build context: the last matching rule wins ("*" then "!keep"). */
function letIn(rules, rel) {
    let inside = true;
    for (const r of rules) {
        const keep = r.startsWith('!');
        const pat = keep ? r.slice(1) : r;
        const hit = pat === '*' || rel === pat || rel.startsWith(`${pat}/`);
        if (hit) {
            inside = keep;
        }
    }
    return inside;
}

test("every file the arena image copies from the repo is in its build context", () => {
    const rules = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    // made in the build stage, not copied from the repo
    const built = (rel) => rel.startsWith('app/dist/');
    const sources = [...docker.matchAll(/^COPY --from=build (.+)$/gm)].flatMap((m) => m[1].trim().split(/\s+/).slice(0, -1)).map((s) => s.replace(/^\/src\//, ''));
    assert.ok(sources.length >= 8, `the Dockerfile's copies: ${sources.join(', ')}`);
    const missing = sources.filter((rel) => !built(rel) && !(fs.existsSync(path.join(ROOT, rel)) && letIn(rules, rel)));
    assert.deepStrictEqual(missing, [], 'copied by the Dockerfile but missing from the repo or left out by .dockerignore');
    assert.strictEqual(letIn(rules, 'bot/players/rush.js'), false, 'the rest stays out');
});
