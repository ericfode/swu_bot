const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('../../viewer/node_modules/typescript');
const filename = path.join(__dirname, '../src/lib/cardText.ts');
const moduleUnderTest = { exports: {} };
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
new Function('require', 'module', 'exports', code)(() => ({ bumpArtVersion() {} }), moduleUnderTest, moduleUnderTest.exports);
const { isToken, loadCardText } = moduleUnderTest.exports;

test('hidden replay cards and unknown animation draws do not receive token badges', () => {
    assert.equal(isToken({ n: 'Unknown card', s: null }), false);
    assert.equal(isToken({ n: 'hidden card', s: null }), false);
    assert.equal(isToken({ n: 'Repair', s: 'SOR_074' }), false);
    assert.equal(isToken({ n: 'Battle Droid', s: null }), true);
    assert.equal(isToken({ n: 'Shield', s: null, t: 1 }), true);
});

test('loaded token metadata identifies a token with a set number', async () => {
    await loadCardText({ TEST_TOKEN: { t: 'Example token', ty: ['token', 'unit'] } });
    assert.equal(isToken({ n: 'Example token', s: 'TEST_TOKEN' }), true);
});
