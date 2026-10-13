#!/usr/bin/env node
'use strict';

/** Inventory is a work queue, never a claim of reviewed animation coverage. Engine files are read-only. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const repository = path.resolve(__dirname, '../..');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const read = (relative) => fs.readFileSync(path.join(repository, relative), 'utf8');
const json = (relative) => JSON.parse(read(relative));
const printCode = (set) => set?.number == null ? null : `${set.set}_${String(set.number).padStart(3, '0')}`;
const kindOf = (card) => card.types.includes('token') ? card.types.join('-') : card.types[0];
const countBy = (items, key) => items.reduce((counts, item) => {
    const value = key(item);
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
}, {});

function options(args) {
    const result = { scope: 'bot', out: path.join(repository, 'results/card-animation-catalogue') };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--help') return { help: true };
        if (!['--scope', '--out'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) {
            throw new Error(`Unknown or incomplete argument: ${args[i]}. Use --help.`);
        }
        result[args[i].slice(2)] = args[++i];
    }
    assert.ok(['bot', 'imported'].includes(result.scope), '--scope must be bot or imported');
    result.out = path.resolve(result.out);
    return result;
}

/** Parse literal declarations without executing renderer code or guessing identities from titles. */
function authoredCatalogue(cataloguePath) {
    let ts;
    for (const location of ['studio/node_modules/typescript', 'viewer/node_modules/typescript', 'node_modules/typescript']) {
        try { ts = require(path.join(repository, location)); break; } catch (error) {
            if (error.code !== 'MODULE_NOT_FOUND') throw error;
        }
    }
    assert.ok(ts, 'Install repository dependencies with npm run setup (the catalogue parser uses TypeScript).');
    const modules = new Map();
    const parse = (relative) => {
        if (modules.has(relative)) return modules.get(relative);
        const file = ts.createSourceFile(relative, read(relative), ts.ScriptTarget.Latest, true);
        assert.equal(file.parseDiagnostics.length, 0, `${relative} must parse before inventory generation`);
        const module = { declarations: new Map(), imports: new Map(), relative };
        modules.set(relative, module);
        for (const statement of file.statements) {
            if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
                && statement.moduleSpecifier.text.startsWith('.') && statement.importClause?.namedBindings
                && ts.isNamedImports(statement.importClause.namedBindings)) {
                for (const element of statement.importClause.namedBindings.elements) {
                    module.imports.set(element.name.text, { relative: path.join(path.dirname(relative), `${statement.moduleSpecifier.text}.ts`),
                        name: element.propertyName?.text ?? element.name.text });
                }
            }
            if (!ts.isVariableStatement(statement)) continue;
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) module.declarations.set(declaration.name.text, declaration.initializer);
            }
        }
        return module;
    };
    const literalObject = (node) => {
        assert.ok(node && ts.isObjectLiteralExpression(node), 'Catalogue records and aliases must be literal objects');
        const fields = {};
        for (const property of node.properties) {
            assert.ok(ts.isPropertyAssignment(property), 'Unsupported computed catalogue record');
            const name = property.name;
            assert.ok(ts.isIdentifier(name) || ts.isStringLiteral(name), 'Catalogue field names must be literal');
            if (ts.isStringLiteral(property.initializer)) fields[name.text] = property.initializer.text;
        }
        return fields;
    };
    const literalArray = (module, name, trail = new Set()) => {
        const key = `${module.relative}:${name}`;
        assert.ok(!trail.has(key), `Cyclic catalogue array: ${key}`);
        const visited = new Set([...trail, key]);
        const imported = module.imports.get(name);
        if (imported) return literalArray(parse(imported.relative), imported.name, visited);
        const array = module.declarations.get(name);
        assert.ok(array && ts.isArrayLiteralExpression(array), `${key} must be a literal array`);
        return array.elements.flatMap(element => {
            if (!ts.isSpreadElement(element)) return [literalObject(element)];
            assert.ok(ts.isIdentifier(element.expression), 'Catalogue spreads must name a declared or imported literal array');
            return literalArray(module, element.expression.text, visited);
        });
    };
    const root = parse(cataloguePath);
    const effects = literalArray(root, 'CARD_EFFECTS');
    assert.equal(new Set(effects.map((effect) => effect.id)).size, effects.length, 'Duplicate authored animation IDs');
    for (const effect of effects) assert.ok(effect.id && effect.setCode, 'Authored effects need an ID and print code');
    const aliases = root.declarations.has('reprints') ? literalObject(root.declarations.get('reprints')) : {};
    return { effects, aliases, sourceFiles: [...modules.keys()] };
}

function main() {
    const args = options(process.argv.slice(2));
    if (args.help) {
        console.log('Usage: node studio/scripts/card-animation-inventory.cjs [--scope bot|imported] [--out DIRECTORY]\n\nDefault scope: bot. Default output: results/card-animation-catalogue.\nWrites inventory.json and batches.json. Existing scenes remain authored but reviewed:false; all batches are pending.\nImported reads installed JSON; bot also instantiates Env once to use its authoritative index. No games, downloads, or engine edits.');
        return;
    }
    const dataRoot = 'forceteki/test/json';
    const cardMap = json(`${dataRoot}/_cardMap.json`);
    const setCodeMap = json(`${dataRoot}/_setCodeMap.json`);
    const mockNames = new Set(json(`${dataRoot}/_mockCardNames.json`));
    const cataloguePath = 'studio/src/effects/catalogue.ts';
    const { effects, aliases, sourceFiles } = authoredCatalogue(cataloguePath);
    const dataHash = createHash('sha256');
    const records = cardMap.map((entry) => {
        const source = `${dataRoot}/Card/${entry.internalName}.json`;
        const contents = read(source);
        dataHash.update(source).update('\0').update(contents).update('\0');
        const card = JSON.parse(contents);
        assert.equal(card.id, entry.id, `Card identity mismatch in ${source}`);
        assert.equal(card.internalName, entry.internalName, `Internal name mismatch in ${source}`);
        return { ...card, source };
    });
    const byId = new Map(records.map((card) => [card.id, card]));
    assert.equal(byId.size, records.length, 'Duplicate card identities');
    assert.equal(new Set(records.map((card) => card.internalName)).size, records.length, 'Duplicate internal names');
    const prints = new Map(records.map((card) => [card.id, []]));
    for (const [print, id] of Object.entries(setCodeMap)) {
        assert.ok(byId.has(id), `Unknown identity ${id} for print ${print}`);
        prints.get(id).push(print);
    }
    for (const card of records) {
        const declared = (card.setCodes ?? (printCode(card.setId) ? [card.setId] : [])).map(printCode).sort();
        const verified = prints.get(card.id).sort();
        assert.deepEqual(verified, declared, `Print aliases disagree for ${card.internalName}`);
    }
    const authored = new Map();
    for (const effect of effects) {
        const id = setCodeMap[effect.setCode];
        assert.ok(id && byId.has(id), `Unknown authored print ${effect.setCode}`);
        assert.equal(byId.get(id).internalName, effect.id, `Authored identity mismatch for ${effect.setCode}`);
        assert.ok(!authored.has(id), `Multiple animations for identity ${id}`);
        authored.set(id, { catalogueId: effect.id, recognizedPrints: [effect.setCode] });
    }
    for (const [print, effectId] of Object.entries(aliases)) {
        const effect = effects.find((entry) => entry.id === effectId);
        assert.ok(effect, `Unknown reprint animation ${effectId}`);
        assert.equal(setCodeMap[print], setCodeMap[effect.setCode], `Reprint identity mismatch for ${print}`);
        authored.get(setCodeMap[print]).recognizedPrints.push(print);
    }
    let eligibleIds = null;
    if (args.scope === 'bot') {
        const { Env } = require(path.join(repository, 'bot/env.js'));
        eligibleIds = new Set(Object.values(new Env().index()).flat().map((card) => card.id));
        for (const id of eligibleIds) assert.ok(byId.has(id), `Bot index references unknown identity ${id}`);
    }
    const kinds = ['event', 'unit', 'upgrade', 'leader', 'base', 'token-upgrade', 'token-unit', 'token'];
    const sets = ['SOR', 'SHD', 'TWI', 'JTL', 'LOF', 'IBH', 'SEC', 'LAW', 'TS26', 'ASH', 'HMW'];
    const rank = (values, value) => values.includes(value) ? values.indexOf(value) : values.length;
    const cards = records.filter((card) => !mockNames.has(card.internalName) && (!eligibleIds || eligibleIds.has(card.id)))
        .map((card) => ({
            id: card.id, internalName: card.internalName, canonicalSet: card.setId.set,
            canonicalPrint: printCode(card.setId), printAliases: prints.get(card.id),
            title: card.title, subtitle: card.subtitle ?? null, kind: kindOf(card), types: card.types,
            cost: card.cost ?? null, power: card.power ?? null, hp: card.hp ?? null,
            upgradePower: card.upgradePower ?? null, upgradeHp: card.upgradeHp ?? null,
            text: card.text ?? null, deployBox: card.deployBox ?? null, epicAction: card.epicAction ?? null,
            rules: card.rules ?? null, unique: !!card.unique, keywords: card.keywords ?? [],
            traits: card.traits ?? [], aspects: card.aspects ?? [], source: card.source,
            animation: {
                authored: authored.has(card.id), ...(authored.get(card.id) ?? { catalogueId: null, recognizedPrints: [] }),
                reviewed: false, reviewStatus: 'not-assessed-by-inventory'
            }
        })).sort((a, b) => rank(kinds, a.kind) - rank(kinds, b.kind)
            || rank(sets, a.canonicalSet) - rank(sets, b.canonicalSet)
            || a.canonicalSet.localeCompare(b.canonicalSet)
            || (a.canonicalPrint ?? '').localeCompare(b.canonicalPrint ?? '')
            || a.internalName.localeCompare(b.internalName));
    const fingerprints = [
        `${dataRoot}/_cardMap.json`, `${dataRoot}/_setCodeMap.json`, `${dataRoot}/_mockCardNames.json`,
        ...sourceFiles, 'skills/swu-card-animation/SKILL.md', 'bot/env.js',
        'forceteki/build/server/game/cards/Index.js', 'studio/scripts/card-animation-inventory.cjs'
    ].map((source) => ({ path: source, sha256: fs.existsSync(path.join(repository, source)) ? sha256(read(source)) : null }));
    let engineHead = null;
    try { engineHead = execFileSync('git', ['-C', path.join(repository, 'forceteki'), 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Source archives need no Git history. */ }
    const provenance = { engineHead, cardDataSha256: dataHash.digest('hex'), files: fingerprints };
    const sourceFingerprint = sha256(JSON.stringify(provenance));
    const metadata = { schemaVersion: 1, generatedAt: new Date().toISOString(), scope: args.scope, sourceFingerprint };
    const counts = {
        identities: cards.length, printAliases: cards.reduce((sum, card) => sum + card.printAliases.length, 0),
        authored: cards.filter((card) => card.animation.authored).length, reviewed: 0,
        byKind: countBy(cards, (card) => card.kind), byCanonicalSet: countBy(cards, (card) => card.canonicalSet),
        importedNonMockIdentities: records.filter((card) => !mockNames.has(card.internalName)).length,
        excludedMocks: records.filter((card) => mockNames.has(card.internalName)).length
    };
    const inventory = { ...metadata, provenance, counts, cards };
    const regression = effects.map((effect) => cards.find((card) => card.animation.catalogueId === effect.id)).filter(Boolean);
    const pending = cards.filter((card) => !card.animation.authored);
    const batches = [];
    const enqueue = (queue, purpose, prefix) => {
        for (let offset = 0; offset < queue.length; offset += 10) {
            const members = queue.slice(offset, offset + 10);
            batches.push({
                id: `${prefix}${String(offset / 10 + 1).padStart(3, '0')}`, purpose, status: 'pending', reviewed: false,
                kinds: [...new Set(members.map((card) => card.kind))], count: members.length,
                cards: members.map((card) => ({ id: card.id, internalName: card.internalName, title: card.title,
                    subtitle: card.subtitle, canonicalPrint: card.canonicalPrint, kind: card.kind, authored: card.animation.authored, reviewed: false }))
            });
        }
    };
    enqueue(regression, 'existing-scene-regression', 'R');
    enqueue(pending, 'new-animation-authoring', 'A');
    const queuedIds = batches.flatMap((batch) => batch.cards.map((card) => card.id));
    assert.equal(queuedIds.length, cards.length, 'Every scoped identity must have exactly one batch');
    assert.equal(new Set(queuedIds).size, cards.length, 'Duplicate queued identities');
    const manifest = {
        ...metadata, batchSize: 10,
        notice: 'Planned inventory only. Authored scenes are not reviewed coverage. No batch has been dispatched or accepted by this script.',
        ordering: { existing: 'catalogue order', new: 'kind, canonical set, print number, internal name', kinds, canonicalSets: sets },
        counts: { identities: cards.length, regression: regression.length, newAuthoring: pending.length, batches: batches.length, reviewed: 0 },
        batches
    };
    fs.mkdirSync(args.out, { recursive: true });
    for (const [name, value] of [['inventory.json', inventory], ['batches.json', manifest]]) {
        fs.writeFileSync(path.join(args.out, name), `${JSON.stringify(value, null, 2)}\n`);
    }
    console.log(`${args.scope}: ${cards.length} identities, ${counts.printAliases} verified prints; ${counts.authored} authored, 0 assessed reviews; ${batches.length} pending batches.\n${args.out}`);
}

try { main(); } catch (error) {
    console.error(`Card animation inventory: ${error.message}`);
    process.exitCode = 1;
}
