'use strict';
const path = require('node:path');
const { snapshot } = require('./inventory');
const ref = require('./reference/library');
const { planCardProbes } = require('./pipeline/probes');
const generated = path.resolve(__dirname, '../card-compiler/generated');
function load() {
    const inventory = snapshot(generated);
    const compiled = ref.read(path.join(generated, 'catalog.json'));
    const cases = ref.registry(), corpus = ref.corpus();
    return { inventory, compiled, cases, corpus };
}
function card(setCode, data = load()) {
    const source = data.compiled.cards.find(c => c.setCode === setCode);
    if (!source) throw new Error('Unknown card: ' + setCode);
    const support = data.inventory.cards.find(c => c.setCode === setCode);
    const testIds = new Set([...data.cases.cases.filter(c => c.focusCardIds.includes(setCode) || c.setupCardIds.includes(setCode)).map(c => c.id),
        ...data.corpus.recordings.filter(r => r.caseId === 'card-play/' + setCode || r.caseDefinition?.focusCardIds.includes(setCode)).map(r => r.caseId)]);
    const tests = [...testIds].sort().map(id => {
        const c = ref.definition(id, data.cases);
        return { id, kind: c.kind, relationship: c.focusCardIds.includes(setCode) ? 'focus' : 'setup', behaviorIds: c.behaviorIds,
            assertionStages: c.assertionStages, recordings: data.corpus.recordings.filter(r => r.caseId === id).map(r => ({ traceSha256: r.traceSha256, poolSha256: r.poolSha256, seed: r.seed, imported: !!r.provenance?.imported, assertionSourceIdentity: r.provenance?.scenarioLibrarySha256 ?? null })) };
    });
    const automatic = planCardProbes(source, { catalogue: data.compiled });
    return { setCode, ...source.card, source: { path: source.sourcePath, sha256: source.sourceHash, dataSha256: source.dataHash },
        conversion: { status: source.status, converted: support.converted, diagnostics: source.diagnostics },
        runtime: { admitted: support.admitted, reason: support.reason ?? null },
        behaviors: source.requiredCapabilities ?? [], abilities: source.abilities, tests,
        automatic: { plannedCases: automatic.cases.map(c=>({id:c.id,obligationIds:c.coverageObligationIds})), obligations: automatic.obligations,
            uncovered: automatic.uncovered, note: 'Plans do not establish execution. Run cards:pipeline for source-bound oracle, runtime, mutation and semantic review receipts.' },
        coverage: { targetedCases: tests.filter(t => t.kind === 'behavior' && t.relationship === 'focus').length,
            targetedCasesWithRecordings: tests.filter(t => t.kind === 'behavior' && t.relationship === 'focus' && t.recordings.length).length,
            playRecorded: tests.some(t => t.kind === 'play' && t.recordings.length),
            note: 'Imported recordings preserve historical engine evidence and may predate the current scenario assertions. Current runtime agreement is established by running reference check; a shared behavior test is not a per-card assertion.' } };
}
function behaviors(data = load()) {
    const ids = new Set(data.compiled.cards.flatMap(c => c.requiredCapabilities ?? []));
    const groups = ref.read(path.join(__dirname, 'behaviors.json'));
    return { capabilities: [...ids].sort().map(id => ({ id, cards: data.compiled.cards.filter(c => c.requiredCapabilities?.includes(id)).map(c => c.setCode) })),
        testFamilies: groups.behaviors.map(b => ({ ...b, cases: data.cases.cases.filter(c => c.behaviorIds.includes(b.id)).map(c => c.id) })) };
}
module.exports = { load, card, behaviors };
