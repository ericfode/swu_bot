'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { compileSource, loadEnums } = require('../compiler');
const { compileCatalog, coverage, keywordValues } = require('../build');

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
test('phase stat modifiers preserve signed values, targeting and captured context', () => {
    const c = compile(`registrar.addWhenPlayedAbility({title:'Weaken',targetResolver:{cardTypeFilter:'unit',immediateEffect:AbilityHelper.immediateEffects.forThisPhaseCardEffect({title:'Gets -2/-2',effect:AbilityHelper.ongoingEffects.modifyStats({power:-2,hp:-2})})}});`);
    assert.equal(c.status, 'supported');
    assert.deepEqual(c.abilities.card[0].effect, {kind:'modifyStats',target:'chosen',duration:'phase',power:{kind:'unary',op:'-',value:{kind:'const',value:2}},hp:{kind:'unary',op:'-',value:{kind:'const',value:2}}});
    const captured = compile(action('forThisPhaseCardEffect(ctx=>({target:ctx.source,effect:AbilityHelper.ongoingEffects.modifyStats({power:ctx.player.readyResourceCount,hp:0})}))'));
    assert.equal(captured.status, 'supported');
    assert.equal(captured.abilities.card[0].effect.target, 'self');
    assert.deepEqual(captured.abilities.card[0].effect.power,{kind:'ref',path:['player','readyResourceCount']});
});
test('phase modifier lowering rejects live calculations and unsupported lasting semantics', () => {
    for (const modifier of [
        'effect:AbilityHelper.ongoingEffects.modifyStats((card,ctx)=>({power:ctx.player.readyResourceCount,hp:0}))',
        'effect:AbilityHelper.ongoingEffects.modifyStats({power:1,hp:1}),condition:ctx=>true',
        'effect:AbilityHelper.ongoingEffects.modifyStats({power:1,hp:1}),duration:"round"',
        'effect:AbilityHelper.ongoingEffects.modifyStats({power:1})',
        'effect:AbilityHelper.ongoingEffects.modifyStats({power:1,hp:1,extra:1})',
        'effect:AbilityHelper.ongoingEffects.modifyStats({power:ctx=>ctx.source.damage,hp:0})',
    ]) assert.equal(compile(action(`forThisPhaseCardEffect({${modifier}})`)).status,'unsupported',modifier);
    const local=compile('const modifier=(card,ctx)=>({power:1,hp:1});'+action('forThisPhaseCardEffect({effect:AbilityHelper.ongoingEffects.modifyStats(modifier)})'));
    assert.equal(local.status,'unsupported');
    assert.equal(local.diagnostics[0].pattern,'dynamic-ongoing-stat-modifier');
    const alias=compile('const original=(card,ctx)=>({power:1,hp:1});const modifier=original;'+action('forThisPhaseCardEffect({effect:AbilityHelper.ongoingEffects.modifyStats(modifier)})'));
    assert.equal(alias.status,'unsupported');
    assert.equal(alias.diagnostics[0].pattern,'dynamic-ongoing-stat-modifier');
});
test('constant static modifiers distinguish self defaults from continuous aura filters', () => {
    const self=compile(`registrar.addConstantAbility({title:'Initiative',condition:ctx=>ctx.player.hasInitiative(),ongoingEffect:AbilityHelper.ongoingEffects.modifyStats({power:2,hp:0})});`);
    assert.equal(self.status,'supported');
    assert.equal(self.abilities.card[0].trigger,'constant');
    assert.equal(self.abilities.card[0].effect.duration,'persistent');
    assert.equal(self.abilities.card[0].effect.target,'self');
    assert.equal(self.abilities.card[0].targetResolver,undefined);
    const aura=compile(`registrar.addConstantAbility({title:'Others',matchTarget:(card,ctx)=>card!==ctx.source&&card.hasSomeTrait('rebel'),ongoingEffect:[AbilityHelper.ongoingEffects.modifyStats({power:1,hp:1})]});`);
    assert.equal(aura.status,'supported');
    assert.deepEqual({...aura.abilities.card[0].targetResolver,predicate:undefined},{owner:'self',type:'unit',zone:'arena',predicate:undefined});
    assert.equal(aura.abilities.card[0].effect.target,'chosen');
    const enemy=compile(`registrar.addConstantAbility({title:'Enemies',targetController:'opponent',targetCardTypeFilter:'nonLeaderUnit',targetZoneFilter:'spaceArena',ongoingEffect:AbilityHelper.ongoingEffects.modifyStats({power:-2,hp:-2})});`);
    assert.equal(enemy.status,'supported');
    assert.deepEqual(enemy.abilities.card[0].targetResolver,{owner:'opponent',type:'nonLeaderUnit',zone:'arena',arena:'space'});
});
test('constant modifiers reject live stat dependencies, unsupported amounts and custom zones', () => {
    for(const fields of [
        'condition:ctx=>ctx.source.getPower()>2,',
        'condition:ctx=>ctx.source.hp>2,',
        'matchTarget:card=>card.remainingHp>2,',
        'sourceZoneFilter:"any",',
        'targetZoneFilter:"hand",',
    ]) assert.equal(compile(`registrar.addConstantAbility({${fields}ongoingEffect:AbilityHelper.ongoingEffects.modifyStats({power:1,hp:1})});`).status,'unsupported',fields);
    for(const modifier of [
        'AbilityHelper.ongoingEffects.modifyStats((target)=>({power:target.power,hp:0}))',
        'AbilityHelper.ongoingEffects.modifyStats({power:ctx=>ctx.source.damage,hp:0})',
        'AbilityHelper.ongoingEffects.modifyStats({power:1.5,hp:0})',
        'AbilityHelper.ongoingEffects.modifyStats({power:1,hp:0,extra:1})',
        '[AbilityHelper.ongoingEffects.modifyStats({power:1,hp:0}),AbilityHelper.ongoingEffects.gainKeyword("raid")]',
    ]) assert.equal(compile(`registrar.addConstantAbility({ongoingEffect:${modifier}});`).status,'unsupported',modifier);
});
test('arena existence and count queries preserve bounded intersecting filters', () => {
    const c=compile(action('draw({amount:1})', `condition:ctx=>ctx.player.hasSomeArenaUnit({arena:ctx.target.zoneName,otherThan:ctx.source,trait:['rebel','jedi'],aspect:'heroism',keyword:'sentinel',condition:unit=>unit.damage>0}),`));
    assert.equal(c.status,'supported');
    const q=c.abilities.card[0].condition;
    assert.equal(q.kind,'query'); assert.equal(q.name,'hasSomeArenaUnit');
    assert.deepEqual(q.receiver,{kind:'ref',path:['player']});
    assert.equal(q.args.length,1);
    assert.equal(q.args[0].op,'&&');
    assert.deepEqual(q.args[0].right.left,{kind:'ref',path:['card','damage']});
    const count=compile(action('damage({amount:ctx=>ctx.player.opponent.getArenaUnits({arena:"spaceArena"}).length})'));
    assert.equal(count.status,'supported');
    assert.equal(count.abilities.card[0].effect.amount.name,'arenaUnitCount');
    assert.deepEqual(count.abilities.card[0].effect.amount.receiver,{kind:'ref',path:['opponent']});
    const noFilter=compile(action('draw()',`condition:ctx=>ctx.player.hasSomeArenaUnit(),`));
    assert.deepEqual(noFilter.abilities.card[0].condition.args,[{kind:'const',value:true}]);
});
test('arena queries reject unsupported filters, collections and captured card registers', () => {
    for(const condition of [
        'ctx=>ctx.player.hasSomeArenaUnit({controller:ctx.player.opponent})',
        'ctx=>ctx.player.hasSomeArenaUnit({type:"base"})',
        'ctx=>ctx.game.hasSomeArenaUnit()',
        'ctx=>ctx.player.hasSomeArenaUnit({condition:(unit,context)=>unit===context.source})',
        'ctx=>ctx.player.hasSomeArenaUnit({condition:unit=>{unit.damage++;return true;}})',
        'ctx=>ctx.player.hasSomeArenaUnit({}, {})',
    ]) assert.equal(compile(action('draw()',`condition:${condition},`)).status,'unsupported',condition);
    const captured=compile(`registrar.addWhenPlayedAbility({targetResolver:{cardTypeFilter:'unit',cardCondition:(candidate,ctx)=>ctx.player.hasSomeArenaUnit({condition:unit=>unit!==candidate}),immediateEffect:AbilityHelper.immediateEffects.ready()}});`);
    assert.equal(captured.status,'unsupported');
    assert.equal(captured.diagnostics[0].pattern,'arena-query-card-capture');
    const capturedAlias=compile(`registrar.addWhenPlayedAbility({targetResolver:{cardTypeFilter:'unit',cardCondition:(candidate,ctx)=>{const saved=candidate;return ctx.player.hasSomeArenaUnit({condition:unit=>unit!==saved});},immediateEffect:AbilityHelper.immediateEffects.ready()}});`);
    assert.equal(capturedAlias.status,'unsupported');
    assert.equal(capturedAlias.diagnostics[0].pattern,'arena-query-card-capture');
    const cyclic=compile(`registrar.addConstantAbility({condition:ctx=>ctx.player.hasSomeArenaUnit({condition:unit=>unit.getPower()>2}),ongoingEffect:AbilityHelper.ongoingEffects.modifyStats({power:1,hp:0})});`);
    assert.equal(cyclic.status,'unsupported');
    assert.equal(cyclic.diagnostics[0].pattern,'constant-stat-dependency');
});
test('trait aspect and keyword in-play aliases lower to the same arena unit filters', () => {
    for(const [alias,field] of [['isTraitInPlay','trait'],['isAspectInPlay','aspect'],['isKeywordInPlay','keyword']]) {
        const aliasCard=compile(action('draw()',`condition:ctx=>ctx.player.${alias}(['rebel','jedi'],ctx.source),`));
        const direct=compile(action('draw()',`condition:ctx=>ctx.player.hasSomeArenaUnit({${field}:['rebel','jedi'],otherThan:ctx.source}),`));
        assert.equal(aliasCard.status,'supported');
        assert.deepEqual(aliasCard.abilities.card[0].condition,direct.abilities.card[0].condition);
        assert.equal(compile(action('draw()',`condition:ctx=>ctx.player.${alias}(),`)).status,'unsupported');
        assert.equal(compile(action('draw()',`condition:ctx=>ctx.player.${alias}('rebel',ctx.source,1),`)).status,'unsupported');
    }
    const upgraded=compile(action('draw()',`condition:ctx=>ctx.source.isUpgraded(),`));
    assert.equal(upgraded.status,'supported');
    assert.equal(upgraded.abilities.card[0].condition.name,'isUpgraded');
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

test('keyword modifier lists retain gain loss, live numeric and shared targets', () => {
    const c=compile(`registrar.addConstantAbility({matchTarget:card=>card.isUnit(),ongoingEffect:[AbilityHelper.ongoingEffects.loseKeyword('sentinel'),AbilityHelper.ongoingEffects.gainKeyword('saboteur'),AbilityHelper.ongoingEffects.modifyStats({power:1,hp:0})]});`);
    assert.equal(c.status,'supported');
    assert.deepEqual(c.abilities.card[0].effect.effects.map(e=>[e.kind,e.target]),[['loseKeyword','chosen'],['gainKeyword','chosen'],['modifyStats','chosen']]);
    const live=compile(`registrar.addConstantAbility({ongoingEffect:AbilityHelper.ongoingEffects.gainKeyword((unit)=>({keyword:'raid',amount:unit.damage}))});`);
    assert.equal(live.status,'supported');assert.deepEqual(live.abilities.card[0].effect.amount,{kind:'ref',path:['card','damage']});
    const phase=compile(action(`forThisPhaseCardEffect(ctx=>({target:ctx.source,effect:[AbilityHelper.ongoingEffects.gainKeyword({keyword:'restore',amount:ctx.player.readyResourceCount}),AbilityHelper.ongoingEffects.loseKeyword('sentinel')]}))`));
    assert.equal(phase.status,'supported');assert.equal(phase.abilities.card[0].effect.effects[0].duration,'phase');assert.equal(phase.abilities.card[0].effect.effects[0].amount.path[0],'player');
});
test('keyword lowering rejects unsupported keywords, helper fields, cycles and live phase callbacks', () => {
    for(const modifier of ["gainKeyword('unsupported-keyword')","gainKeyword({keyword:'raid'})","gainKeyword({keyword:'sentinel',amount:2})","gainKeyword({keyword:'raid',amount:1,extra:true})","gainKeyword(unit=>({keyword:'raid',amount:unit.getPower()}))","loseKeyword(['sentinel','unsupported-keyword'])"]) assert.equal(compile(`registrar.addConstantAbility({ongoingEffect:AbilityHelper.ongoingEffects.${modifier}});`).status,'unsupported',modifier);
    assert.equal(compile(`registrar.addConstantAbility({condition:ctx=>ctx.source.hasSomeKeyword('sentinel'),ongoingEffect:AbilityHelper.ongoingEffects.gainKeyword('saboteur')});`).status,'unsupported');
    assert.equal(compile(action(`forThisPhaseCardEffect({effect:AbilityHelper.ongoingEffects.gainKeyword(unit=>({keyword:'raid',amount:unit.damage}))})`)).status,'unsupported');
    assert.equal(compile(`registrar.addConstantAbility({ongoingEffect:[]});`).status,'unsupported');
    assert.equal(compile(`registrar.addConstantAbility({ongoingEffect:[${Array(9).fill("AbilityHelper.ongoingEffects.gainKeyword('sentinel')").join(',')}]});`).status,'unsupported');
});

test('printed core keyword parsing follows engine case, own-line, expected-name and side rules', () => {
    const keywords = ['sentinel', 'raid', 'restore', 'ambush'];
    assert.deepEqual(keywordValues({ types:['unit'], keywords, text:'Sentinel reminder\nRaid 2\nRestore 0\nAmbush', deployBox:'Raid 99' }), {sentinel:1,raid:2,restore:0,ambush:1});
    assert.deepEqual(keywordValues({ types:['unit'], keywords, text:'While attacking, this unit gains Sentinel\n sentinel\nRaid\nraid 4\n Raid 3\nRestore  5' }), {});
    assert.deepEqual(keywordValues({ types:['unit'], keywords:[], text:'Sentinel\nRaid 2' }), {});
    assert.deepEqual(keywordValues({ types:['leader'], keywords, deployBox:'Raid 2\nSentinel', text:'Raid 3\nSentinel' }), {sentinel:1,raid:5});
    assert.throws(() => keywordValues({ types:['unit'], keywords, text:'Raid 2\nRaid 3' }), /Multiple printed raid/);
    // The pinned engine's boolean regex deliberately has no suffix boundary.
    assert.deepEqual(keywordValues({ types:['unit'], keywords:['sentinel'], text:'Sentinel-like text' }), {sentinel:1});
});
test('context menu titles preserve typed live fragments and exact numeric keyword text',()=>{
    const c=compile("registrar.addOnAttackAbility({title:'Deal damage',contextTitle:ctx=>`Deal ${ctx.source.damage} damage to a unit`,immediateEffect:AbilityHelper.immediateEffects.draw()});");
    assert.equal(c.status,'supported');assert.deepEqual(c.abilities.card[0].contextTitle,[{kind:'const',value:'Deal '},{kind:'ref',path:['source','damage']},{kind:'const',value:' damage to a unit'}]);
    const text=compile("registrar.addOnAttackAbility({title:`Give ${TextHelper.Restore(2)}`,contextTitle:ctx=>`Give ${TextHelper.Raid(3)} to ${ctx.source.title}`,immediateEffect:AbilityHelper.immediateEffects.draw()});");
    assert.equal(text.status,'supported');assert.equal(text.abilities.card[0].title,'Give Restore 2');assert.equal(text.abilities.card[0].contextTitle[1].value,'Raid 3');
    const nullable=compile("registrar.addOnAttackAbility({title:'Shield',contextTitle:ctx=>`Shield ${ctx.source.parentUnit?.title ?? 'the attached unit'}`,immediateEffect:AbilityHelper.immediateEffects.draw()});");
    assert.equal(nullable.status,'supported');assert.equal(nullable.abilities.card[0].contextTitle[1].op,'??');
});
test('context menu title callbacks cannot hide side effects or unsupported helpers',()=>{
    for(const title of ['ctx=>{ctx.source.damage++;return "Draw";}','ctx=>ctx.source.damage++','ctx=>`Draw ${ctx.source.destroy()}`','ctx=>`Gain ${TextHelper.Unknown(2)}`','ctx=>`Gain ${TextHelper.Unknown}`','ctx=>`Gain ${TextHelper.Restore(ctx.source.damage)}`'])assert.equal(compile(`registrar.addOnAttackAbility({title:'Draw',contextTitle:${title},immediateEffect:AbilityHelper.immediateEffects.draw()});`).status,'unsupported',title);
});

test('context titles bound fragment and literal byte capacities',()=>{
    assert.equal(compile(`registrar.addOnAttackAbility({title:'Draw',contextTitle:ctx=>'${'x'.repeat(1025)}',immediateEffect:AbilityHelper.immediateEffects.draw()});`).diagnostics[0].pattern,'context-title-bound');
    const fragments=Array(17).fill('${ctx.source.damage}').join('');
    assert.equal(compile("registrar.addOnAttackAbility({title:'Draw',contextTitle:ctx=>`"+fragments+"`,immediateEffect:AbilityHelper.immediateEffects.draw()});").diagnostics[0].pattern,'context-title-bound');
});

test('trait display labels use pinned enum title case in static and live menus',()=>{
    const body="registrar.addOnAttackAbility({title:`Help ${TextHelper.Trait.BountyHunter}`,contextTitle:ctx=>`Help ${TextHelper.Trait.FirstOrder} and ${TextHelper.Trait.BountyHunter}`,immediateEffect:AbilityHelper.immediateEffects.draw()});";
    const c=compileSource(source(body),'trait-title.ts',{'Trait.BountyHunter':'bounty hunter','Trait.FirstOrder':'first order'});
    assert.equal(c.status,'supported');assert.equal(c.abilities.card[0].title,'Help Bounty Hunter');
    assert.deepEqual(c.abilities.card[0].contextTitle.filter(e=>e.value==='First Order'||e.value==='Bounty Hunter').map(e=>e.value),['First Order','Bounty Hunter']);
    for(const title of ['`Help ${TextHelper.Trait.Unknown}`','`Help ${TextHelper.Unknown}`','`Help ${TextHelper.Unknown(2)}`'])assert.equal(compile(`registrar.addOnAttackAbility({title:${title},immediateEffect:AbilityHelper.immediateEffects.draw()});`).status,'unsupported');
});

test('bounded aspect list labels match pinned conjunction rendering',()=>{
    const c=compileSource(source("registrar.addOnAttackAbility({title:`Control ${TextHelper.aspectList([Aspect.Aggression,Aspect.Cunning],Conjunction.Or)}`,immediateEffect:AbilityHelper.immediateEffects.draw()});"),'aspects.ts',{'Aspect.Aggression':'aggression','Aspect.Cunning':'cunning','Conjunction.Or':'or'});
    assert.equal(c.status,'supported');assert.equal(c.abilities.card[0].title,'Control Aggression or Cunning');
});

test('one lasting modifier list retains event identity separately from immediate groups',()=>{
    const list=compile(action("forThisPhaseCardEffect({effect:[AbilityHelper.ongoingEffects.modifyStats({power:1,hp:0}),AbilityHelper.ongoingEffects.gainKeyword('sentinel')]})"));
    assert.equal(list.status,'supported');assert.equal(list.abilities.card[0].effect.kind,'phaseModifiers');
    const separate=compile(action("simultaneous([AbilityHelper.immediateEffects.forThisPhaseCardEffect({effect:AbilityHelper.ongoingEffects.modifyStats({power:1,hp:0})}),AbilityHelper.immediateEffects.forThisPhaseCardEffect({effect:AbilityHelper.ongoingEffects.gainKeyword('sentinel')})])"));
    assert.equal(separate.status,'supported');assert.equal(separate.abilities.card[0].effect.kind,'simultaneous');
    assert.deepEqual(separate.abilities.card[0].effect.effects,list.abilities.card[0].effect.effects);
});
test('UpTo selectors retain engine zero-choice default and explicit override',()=>{
    for(const [fields,optional]of [['',true],['canChooseNoCards:false,',false],['canChooseNoCards:false,optional:true,',true],['canChooseNoCards:true,',true]]){
        const c=compile(`registrar.addWhenPlayedAbility({title:'Damage',targetResolver:{mode:'upTo',numCards:2,${fields}cardTypeFilter:'unit',immediateEffect:AbilityHelper.immediateEffects.damage({amount:1})}});`);
        assert.equal(c.status,'supported');assert.equal(c.abilities.card[0].targetResolver.optional,optional);
        const nested=compile(action(`selectCard({mode:'upTo',numCards:2,${fields}cardTypeFilter:'unit',immediateEffect:AbilityHelper.immediateEffects.damage({amount:1})})`));
        assert.equal(nested.abilities.card[0].effect.targetResolver.optional,optional);
    }
});

test('selection predicates reject lexical outer target captures rather than rebinding them',()=>{
    const captured=compile(action("selectCard(ctx=>({cardTypeFilter:'unit',cardCondition:card=>card!==ctx.target,immediateEffect:AbilityHelper.immediateEffects.heal({amount:1})}))"));
    assert.equal(captured.status,'unsupported');assert.equal(captured.diagnostics[0].pattern,'target-resolver-outer-target-capture');
    const rebound=compile(action("selectCard({cardTypeFilter:'unit',cardCondition:(card,ctx)=>card!==ctx.target,immediateEffect:AbilityHelper.immediateEffects.heal({amount:1})})"));
    assert.equal(rebound.status,'supported');
    const safe=compile(action("selectCard(ctx=>({cardTypeFilter:'unit',cardCondition:card=>card!==ctx.source,immediateEffect:AbilityHelper.immediateEffects.heal({amount:1})}))"));assert.equal(safe.status,'supported');
});


test('standard trigger aliases preserve source and hook order and the complete body', () => {
    const card = compile(`registrar.addWhenPlayedAbility({title:'Before',immediateEffect:AbilityHelper.immediateEffects.draw()});
        registrar.addTriggeredAbility({title:'Shared',contextTitle:'Shared context',optional:true,when:{onAttack:true,whenPlayed:true,whenDefeated:true},targetResolver:{cardTypeFilter:'unit',immediateEffect:AbilityHelper.immediateEffects.heal({amount:2})}});
        registrar.addOnAttackAbility({title:'After',immediateEffect:AbilityHelper.immediateEffects.draw()});`);
    assert.equal(card.status,'supported',JSON.stringify(card.diagnostics));
    assert.deepEqual(card.abilities.card.map(a=>[a.title,a.trigger]), [['Before','whenPlayed'],['Shared','onAttack'],['Shared','whenPlayed'],['Shared','whenDefeated'],['After','onAttack']]);
    const aliases=card.abilities.card.slice(1,4);
    for(const a of aliases) {
        assert.equal(a.optional,true);
        assert.deepEqual(a.contextTitle,[{kind:'const',value:'Shared context'}]);
        assert.equal(a.effect.kind,'heal');
        assert.deepEqual(a.effect.amount,{kind:'const',value:2});
        assert.equal(a.targetResolver.type,'unit');
    }
    assert.deepEqual(aliases.map(({trigger,...body})=>body),[...Array(3)].map(()=>{const {trigger,...body}=aliases[0];return body;}));
});
test('standard aliases reject watcher, shared state, unknown and nonstatic semantics', () => {
    for (const fields of [
        'when:{}', 'when:{onDefense:true}', 'when:{onAttack:false}',
        'when:{onAttack:()=>true}', 'when:{onAttack:true,onAttack:true}',
        'when:{...{onAttack:true}}', 'when:()=>({onAttack:true})',
        'when:{onAttack:true},aggregateWhen:{}', 'when:{onAttack:true},collectiveTrigger:true',
        'when:{onAttack:true},zoneFilter:"anyArena"', 'when:{onAttack:true},limit:1',
        'when:{onAttack:true},cost:AbilityHelper.costs.exhaustSelf()',
        'when:{onAttack:true},unknown:true',
    ]) assert.equal(compile(`registrar.addTriggeredAbility({title:'Alias',${fields},immediateEffect:AbilityHelper.immediateEffects.draw()});`).status,'unsupported',fields);
    assert.equal(compile(`const enabled=true; registrar.addTriggeredAbility({when:{onAttack:enabled},immediateEffect:AbilityHelper.immediateEffects.draw()});`).status,'unsupported');
    assert.equal(compile(`const when={onAttack:true}; registrar.addTriggeredAbility({when,immediateEffect:AbilityHelper.immediateEffects.draw()});`).status,'unsupported');
});


test('exact unit/base union lowers only inside attackable inventories', () => {
    for (const types of ['["unit","base"]','["base","unit"]']) {
        const c=compile(`registrar.addWhenPlayedAbility({targetResolver:{cardTypeFilter:${types},cardCondition:(card,ctx)=>card!==ctx.source,immediateEffect:AbilityHelper.immediateEffects.heal({amount:1})}});`);
        assert.equal(c.status,'supported');
        assert.equal(c.abilities.card[0].targetResolver.type,'any');
        assert.equal(c.abilities.card[0].targetResolver.zone,'anyAttackable');
    }
    for (const fields of ['cardTypeFilter:["unit","base"],zoneFilter:"discard"','cardTypeFilter:["unit","base"],zoneFilter:"hand"','cardTypeFilter:["unit","base"],zoneFilter:"any"','cardTypeFilter:["unit","upgrade"]','cardTypeFilter:["unit","unit"]','cardTypeFilter:["unit"]']) {
        assert.equal(compile(`registrar.addWhenPlayedAbility({targetResolver:{${fields},immediateEffect:AbilityHelper.immediateEffects.heal({amount:1})}});`).status,'unsupported',fields);
    }
});
test('Coordinate preserves live constant gate provenance and captured attack registration', () => {
    const c=compile(`registrar.addCoordinateAbility({type:'constant',title:'Gain',condition:ctx=>ctx.player.hasInitiative(),ongoingEffect:AbilityHelper.ongoingEffects.modifyStats({power:2,hp:1})});`);
    assert.equal(c.status,'supported',JSON.stringify(c.diagnostics));
    assert.equal(c.abilities.card[0].coordinate,true);
    assert.equal(c.abilities.card[0].trigger,'constant');
    assert.equal(c.abilities.card[0].condition.name,'hasInitiative');
    assert.equal(c.abilities.card[0].effect.duration,'persistent');
    const attack=compile(`registrar.addCoordinateAbility({type:'triggered',when:{onAttack:true},optional:true,targetResolver:{cardTypeFilter:'unit',immediateEffect:AbilityHelper.immediateEffects.damage({amount:3})}});`);
    assert.equal(attack.status,'supported',JSON.stringify(attack.diagnostics));
    assert.equal(attack.abilities.card[0].coordinate,true);
    assert.equal(attack.abilities.card[0].trigger,'onAttack');
    assert.equal(attack.abilities.card[0].condition,undefined);
    assert.equal(attack.abilities.card[0].optional,true);
});
test('Coordinate rejects unaudited registration shapes and extra semantics', () => {
    for (const body of [
        `type:'action',immediateEffect:AbilityHelper.immediateEffects.draw()`,
        `type:'triggered',when:{whenPlayed:true},immediateEffect:AbilityHelper.immediateEffects.draw()`,
        `type:'triggered',when:{onAttack:true,whenDefeated:true},immediateEffect:AbilityHelper.immediateEffects.draw()`,
        `type:'triggered',when:{onAttack:()=>true},immediateEffect:AbilityHelper.immediateEffects.draw()`,
        `type:'constant',ongoingEffect:AbilityHelper.ongoingEffects.modifyStats({power:1,hp:1}),unknown:true`,
        `type:'constant',ongoingEffect:AbilityHelper.ongoingEffects.modifyStats({power:1,hp:1}),when:{onAttack:true}`,
    ]) assert.equal(compile(`registrar.addCoordinateAbility({${body}});`).status,'unsupported',body);
    const one=`registrar.addCoordinateAbility({type:'constant',ongoingEffect:AbilityHelper.ongoingEffects.modifyStats({power:1,hp:1})});`;
    assert.equal(compile(one+one).status,'unsupported');
    assert.equal(compile(one,{base:'LeaderUnitCard'}).status,'unsupported');
});


test('token-unit helpers preserve fixed type and engine factory defaults', () => {
    for (const [helper,tokenType] of Object.entries({createBattleDroid:'battleDroid',createCloneTrooper:'cloneTrooper',createXWing:'xwing',createTieFighter:'tieFighter',createSpy:'spy',createBeast:'beast',createMandalorian:'mandalorian'})) {
        const c=compile(action(`${helper}()`));
        assert.equal(c.status,'supported',JSON.stringify(c.diagnostics));
        assert.deepEqual(c.abilities.card[0].effect,{kind:'createTokenUnit',tokenType,amount:{kind:'const',value:1},target:'ownPlayer',entersReady:false});
    }
    for (const amount of [1,2,3,5]) for (const entersReady of [false,true]) for (const [player,target] of [['ctx.player','ownPlayer'],['ctx.player.opponent','enemyPlayer']]) {
        const c=compile(action(`createCloneTrooper(ctx=>({amount:${amount},entersReady:${entersReady},target:${player}}))`));
        assert.equal(c.status,'supported',JSON.stringify(c.diagnostics));
        assert.deepEqual(c.abilities.card[0].effect,{kind:'createTokenUnit',tokenType:'cloneTrooper',amount:{kind:'const',value:amount},target,entersReady});
    }
});
test('token-unit lowering rejects unsafe amounts, entry effects and extra properties', () => {
    for (const fields of ['amount:0','amount:-1','amount:6','amount:1.5','amount:9007199254740992','amount:"2"','amount:ctx=>2','amount:ctx.source.power','entersReady:1','entersReady:ctx=>true','tokenType:"spy"','unknown:true','isCost:true','effect:"hidden mutation"','enterPlayEffect:AbilityHelper.immediateEffects.damage({amount:1})','target:ctx.source','target:[ctx.player,ctx.player.opponent]']) {
        assert.equal(compile(action(`createBattleDroid(ctx=>({${fields}}))`)).status,'unsupported',fields);
    }
    assert.equal(compile(action('createBattleDroid(ctx=>{ctx.source.damage=1;return {};})')).status,'unsupported');
    assert.equal(compile(action('createBattleDroid({}, {})')).status,'unsupported');
    assert.equal(compile(`registrar.addWhenPlayedAbility({immediateEffect:AbilityHelper.immediateEffects.createCloneTrooper(),then:ctx=>({immediateEffect:AbilityHelper.immediateEffects.damage({amount:ctx.events[0].amount,target:ctx.player.base})})});`).status,'unsupported');
});


test('owner-chosen hand discard preserves opponent default and explicit scalar players', () => {
    const defaults=compile(action('discardCardsFromOwnHand({})'));
    assert.equal(defaults.status,'supported',JSON.stringify(defaults.diagnostics));
    assert.deepEqual(defaults.abilities.card[0].effect,{kind:'discardOwnHand',target:'enemyPlayer',amount:{kind:'const',value:1}});
    for(const amount of [1,2]) for(const [player,target] of [['ctx.player','ownPlayer'],['ctx.player.opponent','enemyPlayer']]) {
        const c=compile(action(`discardCardsFromOwnHand(ctx=>({amount:${amount},target:${player},cardTypeFilter:'any'}))`));
        assert.equal(c.status,'supported',JSON.stringify(c.diagnostics));
        assert.deepEqual(c.abilities.card[0].effect,{kind:'discardOwnHand',target,amount:{kind:'const',value:amount}});
    }
    const continuation=compile(`registrar.addOnAttackAbility({optional:true,immediateEffect:AbilityHelper.immediateEffects.discardCardsFromOwnHand(ctx=>({amount:1,target:ctx.player})),ifYouDo:{immediateEffect:AbilityHelper.immediateEffects.createSpy()}});`);
    assert.equal(continuation.status,'supported');
    assert.equal(continuation.abilities.card[0].ifYouDo.effect.kind,'createTokenUnit');
});
test('hand discard rejects unaudited random, filtered, dynamic and player-list semantics', () => {
    for(const fields of ['amount:0','amount:-1','amount:3','amount:1.5','amount:"1"','amount:ctx=>1','amount:ctx.player.hand.length','target:[ctx.player,ctx.player.opponent]','target:ctx.source','target:ctx.game.getPlayers()','cardTypeFilter:"unit"','cardTypeFilter:["any"]','random:true','random:false','cardCondition:card=>true','choosingPlayer:"opponent"','isCost:true','unknown:true','effect:"ignored"']) {
        assert.equal(compile(action(`discardCardsFromOwnHand(ctx=>({${fields}}))`)).status,'unsupported',fields);
    }
    assert.equal(compile(action('discardCardsFromOwnHand(ctx=>{ctx.player.hand.pop();return {};})')).status,'unsupported');
});
test('selected-player resource helpers fail closed instead of targeting resolving player', () => {
    const c=compile(`registrar.addWhenPlayedAbility({immediateEffect:AbilityHelper.immediateEffects.damage({amount:1}),then:{title:'Ready a resource',targetResolver:{mode:'player',immediateEffect:AbilityHelper.immediateEffects.readyResources({amount:1})}}});`);
    assert.equal(c.status,'unsupported');
    assert.equal(c.diagnostics[0].pattern,'unsupported-player-target-resolver');
    assert.equal(compile(`registrar.setEventAbility({targetResolver:{mode:'player',immediateEffect:AbilityHelper.immediateEffects.discardCardsFromOwnHand({amount:2})}});`,{base:'EventCard'}).status,'unsupported');
});

test('hand-discard continuation event identity capture remains explicitly unsupported', () => {
    const c=compile(`registrar.addWhenPlayedAbility({immediateEffect:AbilityHelper.immediateEffects.discardCardsFromOwnHand(ctx=>({target:ctx.player})),ifYouDo:ctx=>({targetResolver:{cardTypeFilter:'unit',cardCondition:card=>card.title===ctx.events[0].card.title,immediateEffect:AbilityHelper.immediateEffects.giveExperience({amount:2})}})});`);
    assert.equal(c.status,'unsupported');
    assert.equal(c.diagnostics[0].pattern,'hand-discard-event-result-capture');
});
