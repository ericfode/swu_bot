'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { compileSource, loadEnums } = require('../compiler');
const { compileCatalog, coverage } = require('../build');

function source(body, { id = 'new-card', name = 'new-card', extra = '', base = 'NonLeaderUnitCard' } = {}) {
    return `export default class NewCard extends ${base} {
        protected getImplementationId() { return { id: '${id}', internalName: '${name}' }; }
        protected setupCardAbilities(registrar, AbilityHelper) { ${body} }
        ${extra}
    }`;
}
function compile(body, options) { return compileSource(source(body, options), 'new-card.ts'); }
const action = (effect, fields = '') => `registrar.addActionAbility({title:'New action', ${fields} immediateEffect: AbilityHelper.immediateEffects.${effect}});`;

// These tests use new card identities. Compiler behavior must depend on source
// syntax and semantics, never a dispatch table of familiar card names or IDs.
test('new card source compiles costs, condition, dynamic amount and both-base target', () => {
    const card = compile(action('damage((ctx) => ({amount:ctx.source.power + 1,target:[ctx.player.base,ctx.player.opponent.base]}))', `cost:[AbilityHelper.costs.exhaustSelf(),AbilityHelper.costs.abilityActivationResourceCost(2)], condition:ctx=>ctx.player.readyResourceCount >= 2,`));
    assert.equal(card.status, 'supported');
    const a = card.abilities.card[0];
    assert.equal(a.trigger, 'action');
    assert.deepEqual(a.costs, [{kind:'exhaustSelf'},{kind:'resources',amount:{kind:'const',value:2}}]);
    assert.equal(a.effect.target, 'bothBases');
    assert.deepEqual(a.effect.amount.left, {kind:'ref',path:['source','power']});
    assert.equal(a.condition.op, '>=');
});
test('healing continuation keeps its event reference and can-distribute-less semantics', () => {
    const card = compile(`registrar.addActionAbility({ title:'Heal then pay', immediateEffect:AbilityHelper.immediateEffects.distributeHealingAmong({amountToDistribute:2, maxTargets:1, canChooseNoTargets:true}), ifYouDo:ctx=>({title:'Pay',immediateEffect:AbilityHelper.immediateEffects.damage({amount:ctx.events[0].totalDistributed,target:ctx.player.base})})});`);
    assert.equal(card.status, 'supported');
    const a = card.abilities.card[0];
    assert.equal(a.effect.canDistributeLess, true);
    assert.equal(a.effect.targetResolver.zone, 'anyAttackable');
    assert.equal(a.ifYouDo.effect.target, 'ownBase');
    assert.deepEqual(a.ifYouDo.effect.amount, {kind:'ref',path:['event','totalDistributed']});
    assert.equal(compile(action('distributeDamageAmong({amountToDistribute:2,canChooseNoTargets:true})')).abilities.card[0].effect.canDistributeLess, false);
});
test('simultaneous and sequential effects remain distinct instructions', () => {
    const content = '[AbilityHelper.immediateEffects.draw({amount:1}),AbilityHelper.immediateEffects.ready()]';
    assert.equal(compile(action(`simultaneous(${content})`)).abilities.card[0].effect.kind, 'simultaneous');
    assert.equal(compile(action(`sequential(${content})`)).abilities.card[0].effect.kind, 'sequence');
});
test('target filtering preserves basic-unit exclusion of token units', () => {
    const card = compile(`registrar.addWhenPlayedAbility({title:'Ready', targetResolver:{cardTypeFilter:'basicUnit', controller:'self', cardCondition:(card,ctx)=>card.controller===ctx.player, immediateEffect:AbilityHelper.immediateEffects.ready()}});`);
    assert.equal(card.status, 'supported');
    const resolver = card.abilities.card[0].targetResolver;
    assert.equal(resolver.type, 'basicUnit');
    assert.equal(resolver.zone, 'anyAttackable');
    assert.deepEqual(resolver.predicate.right, {kind:'ref',path:['player']});
});
test('selector filters intersect and optional targeting flags combine', () => {
    const c=compile(`registrar.addWhenPlayedAbility({title:'Target',targetResolver:{zoneFilter:'base',cardTypeFilter:'unit',optional:true,canChooseNoCards:false,immediateEffect:AbilityHelper.immediateEffects.damage({amount:1})}});`);
    assert.equal(c.status,'supported');
    assert.deepEqual(c.abilities.card[0].targetResolver,{owner:'any',type:'unit',zone:'base',optional:true});
    const invalid=compile(`registrar.addWhenPlayedAbility({title:'Invalid',targetResolver:{cardTypeFilter:'unit'},immediateEffect:AbilityHelper.immediateEffects.damage({amount:1})});`);
    assert.equal(invalid.status,'unsupported');
    assert.equal(invalid.diagnostics[0].pattern,'both-targeted-and-direct-effects');
});
test('const locals and template titles compile without running display expressions', () => {
    const card = compile('const amount = 3; registrar.addWhenPlayedAbility({title:`Give ${TextHelper.Shielded} to ${arbitrarySideEffect()}`, immediateEffect:AbilityHelper.immediateEffects.damage({amount})});');
    assert.equal(card.status, 'supported');
    assert.equal(card.abilities.card[0].title, 'Give Shielded to [value]');
    assert.deepEqual(card.abilities.card[0].effect.amount, {kind:'const',value:3});
});
test('continuation factories cannot substitute a newly selected target for a captured old target', () => {
    const c=compile(`registrar.addWhenPlayedAbility({title:'Ready then heal',targetResolver:{cardTypeFilter:'unit',immediateEffect:AbilityHelper.immediateEffects.ready()},ifYouDo:previous=>({title:'Heal',targetResolver:{cardTypeFilter:'base',immediateEffect:AbilityHelper.immediateEffects.heal({amount:previous.target.cost})}})});`);
    assert.equal(c.status,'unsupported');
    assert.equal(c.diagnostics[0].pattern,'continuation-factory-target-lifetime');
    const sequence=compile(`registrar.addWhenPlayedAbility({title:'Draw',immediateEffect:AbilityHelper.immediateEffects.draw(),then:previous=>({title:'Capture hand size',immediateEffect:AbilityHelper.immediateEffects.sequential([AbilityHelper.immediateEffects.draw(),AbilityHelper.immediateEffects.damage({amount:previous.player.hand.length,target:previous.player.base})])})});`);
    assert.equal(sequence.status,'unsupported');
    assert.equal(sequence.diagnostics[0].pattern,'continuation-factory-value-lifetime');
});
test('unknown semantics reject the whole card with a source location', () => {
    for (const body of [
        action('damage({amount:1,cannotBePrevented:true})'),
        action('capture()'),
        `const ignored = mutateGame(); ${action('draw({amount:1})')}`,
        action('damage(ctx=>{const ignored=ctx.source.mutate();return {amount:1};})'),
        action('damage(ctx=>{let amount=1;return {amount};})'),
        action('damage({amount:ctx=>ctx.source.unknownMethod()})'),
        action('selectCard({target:ctx=>ctx.source,immediateEffect:AbilityHelper.immediateEffects.ready()})'),
        action('damage({amount:ctx=>ctx.target?.power})'),
        action('damage({amount:ctx=>{return 1;return 2;}})'),
        `registrar.addTriggeredAbility({title:'custom'});`,
    ]) {
        const result = compile(body);
        assert.equal(result.status, 'unsupported', body);
        assert.ok(result.diagnostics.length, body);
        assert.ok(result.diagnostics.every((d)=>d.file==='new-card.ts' && d.line>0 && d.column>0));
    }
});
test('custom class behavior and module execution cannot disappear from conversion', () => {
    for (const extra of ['constructor(){super();}', 'get custom(){return 1;}', 'custom(){return 1;}', 'private state = 1;', 'overrideNotImplemented = true;']) assert.equal(compile('', {extra}).status, 'unsupported', extra);
    assert.equal(compile('', {base:'CustomBase'}).status, 'unsupported');
    assert.equal(compileSource('runSideEffect();'+source(''), 'custom.ts').status, 'unsupported');
    assert.equal(compileSource('export default class X extends NonLeaderUnitCard { @@@ }', 'invalid.ts').status, 'unsupported');
});

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swu-card-compiler-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const sourceRoot = path.join(root,'server');
    const cards = path.join(root,'data');
    fs.mkdirSync(path.join(sourceRoot,'game/cards'),{recursive:true});
    fs.mkdirSync(path.join(sourceRoot,'game/core'),{recursive:true});
    fs.mkdirSync(path.join(cards,'Card'),{recursive:true});
    fs.writeFileSync(path.join(cards,'_mockCardNames.json'),'[]');
    fs.writeFileSync(path.join(sourceRoot,'game/core/Constants.ts'),"export enum WildcardCardType { Unit = 'unit' }");
    const add = (id, n, body) => {
        fs.writeFileSync(path.join(sourceRoot,`game/cards/${id}.ts`),source(body,{id,name:id}));
        fs.writeFileSync(path.join(cards,`Card/${id}.json`),JSON.stringify({id,internalName:id,types:['unit'],keywords:[],aspects:[],traits:[],text:'An ability',setId:{set:'TST',number:n}}));
    };
    add('first',1,action('draw({amount:1})'));
    return {root,source:sourceRoot,cards,add};
}
test('inventory automatically discovers newly added cards and retains blocked cards', (t) => {
    const f=fixture(t);
    let c=compileCatalog(f);
    assert.equal(c.cards.length,1);
    f.add('second',2,action('heal({amount:2})'));
    f.add('blocked',3,action('capture()'));
    const next=compileCatalog(f), report=coverage(next);
    assert.deepEqual(next.cards.map(c=>c.setCode),['TST_001','TST_002','TST_003']);
    assert.equal(report.converted,2);
    assert.equal(report.unconverted,1);
    assert.equal(report.runtimeReady,null);
    assert.notEqual(c.sourceTreeHash,next.sourceTreeHash);
    assert.deepEqual(compileCatalog(f),next,'same inputs must produce byte-stable output');
    fs.appendFileSync(path.join(f.source,'game/core/Constants.ts'),'\n// changed helper semantics');
    assert.notEqual(compileCatalog(f).sourceTreeHash,next.sourceTreeHash,'core engine sources are provenance inputs');
});
test('CLI check detects a newly added card; strict conversion fails on blockers', (t) => {
    const f=fixture(t), out=path.join(f.root,'generated');
    const run=(...args)=>spawnSync(process.execPath,[path.join(__dirname,'../build.js'),'--source',f.source,'--cards',f.cards,'--out',out,...args],{encoding:'utf8'});
    assert.equal(run().status,0);
    assert.equal(run('--check').status,0);
    f.add('new',2,action('draw({amount:2})'));
    const stale=run('--check');
    assert.equal(stale.status,1);
    assert.match(stale.stderr,/Stale generated card compiler artifact/);
    f.add('blocked',3,action('capture()'));
    assert.equal(run('--strict').status,2);
    assert.equal(run('--check').status,0);
});
test('pinned leaders are lowered from source into the same generic IR', () => {
    const engine=path.resolve(__dirname,'../../../forceteki/server');
    const enums=loadEnums(engine);
    const entries=[['01_SOR/leaders/SabineWrenGalvanizedRevolutionary.ts','sabine-wren#galvanized-revolutionary'],['06_IBH/leaders/DarthVaderDontFailMeAgain.ts','darth-vader#dont-fail-me-again'],['06_SEC/leaders/SatineKryzeStandingOnPrinciples.ts','satine-kryze#standing-on-principles']];
    const cards=entries.map(([file,name])=>{
        const c=compileSource(fs.readFileSync(path.join(engine,'game/cards',file),'utf8'),file,enums);
        assert.equal(c.status,'supported',JSON.stringify(c.diagnostics));
        assert.equal(c.internalName,name);
        return c;
    });
    assert.equal(cards[0].abilities.leader[0].effect.target,'bothBases');
    assert.equal(cards[1].abilities.unit[0].effect.amount.value,2);
    assert.equal(cards[2].abilities.leader[0].effect.kind,'distributeHealing');
});
