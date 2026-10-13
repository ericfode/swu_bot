'use strict';
const assert=require('node:assert/strict');
const {constructProbeFixture}=require('./probe-fixture');
const {fullState,canonicalAction,expandActions}=require('../../omni/rs/state');
async function fixture(env,pool,scenario,seed){
    const p=scenario.probe;assert.equal(p.family,'arena-keyword-set');
    const reverse=p.sourceSeat===2;
    const construction=reverse?{...scenario,probe:{...p,initiative:'opponent',targets:[...p.targets.map(t=>({...t,owner:t.owner==='self'?'opponent':'self'})),{code:p.cardId,owner:'opponent',zone:'hand',arena:p.sourceArena},...(p.activationCode?[{code:p.activationCode,owner:'opponent',zone:'hand'}]:[])]}}:scenario;
    const setup=await constructProbeFixture(env,pool,construction,seed),{eg,rng,bot,deck}=setup;
    const own=reverse?setup.enemy:setup.own,enemy=reverse?setup.own:setup.enemy,targets=setup.targets.slice(),activation=reverse&&p.activationCode?targets.pop():setup.activation,source=reverse?targets.pop():setup.source;
    const prerequisite=p.hpDependency?targets[p.prerequisiteIndex]:null;
    own.base.damage=p.ownBaseDamage;eg.game.resolveGameState(true);eg.game.continue();
    const id=c=>eg.cardId(c.uuid),live=c=>c.isUnit?.()&&c.isInPlay();
    const numeric=k=>['raid','restore'].includes(k);
    const keyword=(c,k)=>numeric(k)?c.getNumericKeywordTotal(k):Number(c.hasSomeKeyword(k));
    const stats=c=>({id:id(c),zone:c.zoneName,damage:c.damage,hp:c.getHp?.()??c.cardData.hp,power:c.getPower?.()??c.cardData.power,
        keywords:Object.fromEntries(['raid','restore','sentinel','saboteur'].map(k=>[k,keyword(c,k)]))});
    const ready=()=>own.getCardsInZone('resource').filter(c=>!c.exhausted).length;
    const cost=()=>{const aspects=[...own.getAspectsForCosts()];let n=source.cardData.cost;for(const a of source.cardData.aspects){const i=aspects.indexOf(a);if(i<0)n+=2;else aspects.splice(i,1);}return n;};
    const witness={coverageObligationIds:[],observations:[]},records=[{type:'meta',schema:'omni-rs-trace-v1',pool:pool.provenance,seed,bots:['arena-keyword-set-probe','arena-keyword-set-probe'],decks:[deck,deck],scenario:scenario.name,constructionParameters:p,
        fixtureConstruction:'Disclosed actual metadata-selected recipients; normally play focus at exact printed/aspect cost; natural readiness/declaration for unit source; fixed-recipient phase keyword application and natural expiry; full terminal recording.'}];
    let combatStarted=false,combatPicked=false,combatEnded=false,combatChecked=false,combatAttacker=null,combatDefender=null,combatBaseline=null;
    let prerequisiteStarted=false,prerequisitePlayed=false,damageStarted=false,damageDone=false;
    let step=0,started=false,played=false,playChecked=false,attacking=false,picked=false,ended=false,settled=false,checked=false,cancelled=false,initialReady=0,phase=null,baseline=null,initialUnits=[],baseBefore=null;
    const effects=[],heals=[],shieldDeaths=[];
    eg.game.on('onCardDefeated',e=>{if(combatStarted&&!settled&&!e.isCancelledOrReplaced&&e.card.isShield?.())shieldDeaths.push(e.card);});
    eg.game.on('onCardPlayed',e=>{if(prerequisiteStarted&&!prerequisitePlayed&&e.card===prerequisite&&!e.isCancelledOrReplaced)prerequisitePlayed=true;});
    eg.game.on('onDamageDealt',e=>{if(damageStarted&&!settled&&!e.isCancelledOrReplaced&&e.damageSource?.card===activation){assert.equal(e.card,targets[0]);assert.equal(e.damageDealt,p.damageAmount);damageDone=true;}});
    eg.game.on('onCardPlayed',e=>{if(started&&!settled&&!e.isCancelledOrReplaced&&e.card===source)played=true;});
    eg.game.on('onEffectApplied',e=>{if(started&&!settled&&!e.isCancelledOrReplaced&&e.context?.source===source)effects.push({card:e.card,factories:e.effectFactories.length});});
    eg.game.on('onDamageHealed',e=>{if(started&&!settled&&!e.isCancelledOrReplaced&&e.card===own.base)heals.push(e.damageHealed);});
    eg.game.on('onAttackEnd',()=>{if(attacking&&!settled)ended=true;if(combatStarted&&!settled)combatEnded=true;});
    function observe(stage,pid,actions){witness.observations.push({stage,actor:pid?eg.seatOf(pid):null,actions:actions?.map(a=>canonicalAction(eg,a)),state:fullState(eg,pid)});}
    function capture(){initialUnits=eg.game.getArenaUnits().slice();baseline=new Map(initialUnits.map(c=>[c,stats(c)]));phase=eg.round;baseBefore=own.base.damage;}
    function applies(leaf,c){return (leaf.receiver==='game'||c.controller===own)&&(!leaf.trait||c.hasSomeTrait(leaf.trait))&&(!leaf.excludeSource||c!==source);}
    function assertApplied(){
        if(cancelled){assert.equal(source.zoneName,'hand');assert.equal(ready(),initialReady);assert.equal(effects.length,0);for(const [c,b]of baseline){assert.ok(live(c));assert.deepEqual(stats(c),b);}observe('cancelled-without-payment');checked=true;settled=true;return;}
        assert.ok(played&&playChecked,'Actual normal source play and exact payment');
        const expected=p.mode==='phaseModifiers'?initialUnits.filter(c=>applies(p.leaves[0],c)).map(c=>({id:id(c),factories:p.leaves.length})):p.leaves.flatMap(l=>initialUnits.filter(c=>applies(l,c)).map(c=>({id:id(c),factories:1})));
        assert.deepEqual(effects.map(e=>({id:id(e.card),factories:e.factories})),expected,'One multi-factory event differs from independent child events in captured global order');
        for(const [c,b]of baseline){
            assert.ok(live(c),'Every untouched/modifier recipient remains in play');
            assert.equal(c.damage,b.damage);const hpDelta=p.hpDependency&&c.controller===own&&c.cardData.arena==='ground'&&b.keywords.sentinel===0&&p.leaves.some(l=>l.keyword==='sentinel'&&applies(l,c))?p.hpBonus:0;assert.equal(c.getHp(),b.hp+hpDelta);assert.equal(c.getPower(),b.power,'Raid does not increase idle recipients');
            for(const [k,original]of Object.entries(b.keywords)){
                let value=original;
                for(const l of p.leaves)if(applies(l,c)&&l.keyword===k)value=l.kind==='loseKeyword'?0:numeric(k)?value+l.amount:1;
                assert.equal(keyword(c,k),value,'Exact keyword gain/loss, scope and numeric amount');
            }
        }
        if(p.trigger==='onAttack'){
            assert.ok(picked&&ended,'Actual declaration retains combat and AttackEnd');
            assert.equal(keyword(source,'restore'),p.intrinsic.restore,'Source excluded from grant');
            assert.deepEqual(heals,baseBefore>0?[Math.min(baseBefore,p.intrinsic.restore)]:[],'Only captured printed Restore heals during this declaration');
            assert.equal(own.base.damage,Math.max(0,baseBefore-p.intrinsic.restore));
            assert.equal(enemy.base.damage,source.cardData.power,'Original attack completes against enemy base');
        }
        checked=true;observe('keyword-events-resolved');if(!p.waitForExpiry&&!p.hpDependency&&!p.combat&&!p.laterRestore)settled=true;
    }
    function assertCombat(){
        assert.ok(combatPicked&&combatEnded,'Actual keyword recipient attack completes');
        const b=combatBaseline,attacker=combatAttacker,defender=combatDefender;
        const raid=keyword(attacker,'raid');
        const power=attacker.cardData.power+raid;
        const activeSaboteur=keyword(attacker,'saboteur')>0;
        if(defender===enemy.base){assert.equal(enemy.base.damage,b.defenderDamage+power,'Actual Raid adds only while attacking');}
        else {
            const consumes=activeSaboteur?b.shields.length:Math.min(1,b.shields.length);
            assert.deepEqual(shieldDeaths.map(id),b.shields.slice(0,consumes).map(id),'Saboteur versus damage replacement exact original Shield identities');
            for(const token of shieldDeaths){assert.equal(token.zoneName,'outsideTheGame');assert.equal(token.isAttached(),false);}
            const damage=b.defenderDamage+(activeSaboteur||!b.shields.length?power:0);
            if(damage>=b.defenderHp)assert.equal(defender.zoneName,'discard');else{assert.ok(live(defender));assert.equal(defender.damage,damage);assert.deepEqual(defender.upgrades.filter(t=>t.isShield?.()).map(id),b.shields.slice(consumes).map(id));}
            assert.ok(live(attacker),'Bounded recipient survives quiet defender retaliation');assert.equal(attacker.damage,b.attackerDamage+b.defenderPower);
        }
        assert.equal(attacker.getPower(),attacker.cardData.power,'Raid power ends with attack');
        if(p.laterRestore){const total=keyword(attacker,'restore');assert.deepEqual(heals.slice(b.healCount),b.baseDamage>0?[Math.min(b.baseDamage,total)]:[],'Later actual recipient Restore heals exact amount/cap; no ineffective full-health event');assert.equal(own.base.damage,Math.max(0,b.baseDamage-total));}
        observe('actual-keyword-recipient-combat');combatChecked=true;settled=true;
    }
    function assertHpExpiry(){
        const target=targets[0],b=baseline.get(target);
        assert.ok(damageDone);assert.equal(target.zoneName,'discard','Loss of phase Sentinel removes actual aura HP and defeats previously legal damaged unit');
        assert.ok(prerequisite.isInPlay());assert.equal(keyword(prerequisite,'sentinel'),0);
        for(const [c,original]of baseline)if(c!==target){assert.ok(live(c));assert.equal(c.damage,original.damage);for(const [k,value]of Object.entries(original.keywords))assert.equal(keyword(c,k),value);}
        observe('actual-sentinel-hp-expiry-death');settled=true;
    }
    function assertExpiry(){
        assert.ok(eg.round>phase,'Natural phase expiry reached');
        for(const [c,b]of baseline){assert.ok(live(c));for(const [k,value]of Object.entries(b.keywords))assert.equal(keyword(c,k),value,'Underlying keyword state restored at expiry');assert.equal(c.getHp(),b.hp);assert.equal(c.getPower(),b.power);}
        observe('natural-phase-expiry');settled=true;
    }
    try{
        while(!eg.over&&step<4000){
            const pid=eg.ids.find(id=>eg.legalActions(id).length);assert.ok(pid);
            const actions=expandActions(eg,eg.legalActions(pid)),prompt=eg.player(pid).currentPrompt(),window=eg.isActionWindow(pid);let chosen;
            if(window){
                records.push({type:'state',step,state:fullState(eg,pid)});
                if(!settled&&played&&!playChecked){assert.equal(ready(),initialReady-cost(),'Exact source printed/aspect cost');assert.equal(source.zoneName,p.trigger==='event'?'discard':p.sourceArena+'Arena');playChecked=true;observe('normally-played');}
                if(!settled&&!checked&&(cancelled||(p.trigger==='onAttack'?ended:played)))assertApplied();
                if(!settled&&combatEnded&&!combatChecked)assertCombat();
                if(!settled&&checked&&p.hpDependency&&damageDone&&eg.round>phase)assertHpExpiry();
                else if(!settled&&checked&&p.waitForExpiry&&eg.round>phase)assertExpiry();
                if(!settled&&p.hpDependency&&!prerequisiteStarted&&pid===own.id){chosen=actions.find(a=>a.cardUuid===prerequisite.uuid);assert.ok(chosen,'Normally play actual persistent Sentinel HP source');prerequisiteStarted=true;}
                else if(!settled&&!started&&pid===own.id&&(!p.hpDependency||prerequisitePlayed)){chosen=actions.find(a=>a.cardUuid===source.uuid);assert.ok(chosen,'Normally play actual focus');started=true;initialReady=ready();capture();}
                else if(!settled&&checked&&(p.combat||p.laterRestore)&&!combatStarted){
                    const index=p.combat?.attackerIndex??p.restoreAttackerIndex,attacker=targets[index];
                    if(pid===attacker.controller.id){assert.ok(live(attacker));assert.equal(attacker.exhausted,false);chosen=actions.find(a=>a.cardUuid===attacker.uuid);assert.ok(chosen,'Ready actual keyword recipient declares attack');combatAttacker=attacker;combatStarted=true;}
                    else chosen=actions.find(a=>a.arg==='pass');
                }
                else if(!settled&&checked&&p.hpDependency&&!damageStarted&&pid===own.id){assert.ok(live(targets[0]));assert.equal(targets[0].getHp(),baseline.get(targets[0]).hp+p.hpBonus);chosen=actions.find(a=>a.cardUuid===activation.uuid);assert.ok(chosen,'Normally play actual damage donor while bonus is active');damageStarted=true;}
                else if(!settled&&checked&&p.hpDependency&&damageDone&&eg.round===phase){assert.ok(live(targets[0]),'Actually damaged recipient remains alive under active bonus');assert.equal(targets[0].damage,baseline.get(targets[0]).damage+p.damageAmount);chosen=actions.find(a=>a.arg==='pass');}
                else if(!settled&&played&&p.trigger==='onAttack'&&!attacking&&pid===own.id&&!source.exhausted){chosen=actions.find(a=>a.cardUuid===source.uuid);assert.ok(chosen,'Naturally readied source declares attack');attacking=true;}
                else if(!settled)chosen=actions.find(a=>a.arg==='pass');
            }else if(!settled&&(started||prerequisiteStarted)){
                if(damageStarted&&!damageDone&&actions.some(a=>a.cardUuid===targets[0].uuid)){chosen=actions.find(a=>a.cardUuid===targets[0].uuid);assert.ok(chosen);observe('actual-hp-bonus-damage-selector',pid,actions);}
                else if(actions.some(a=>a.label==='Play anyway')){assert.equal(p.trigger,'event');assert.equal(source.zoneName,'hand');assert.equal(ready(),initialReady);assert.deepEqual(actions.map(a=>a.label),['Play anyway','Cancel']);chosen=actions.find(a=>a.label===(p.cancel?'Cancel':'Play anyway'));cancelled=!!p.cancel;observe('empty-confirmation',pid,actions);}
                else if(combatStarted&&/target for attack/i.test(prompt.menuTitle??'')){
                    const arena=combatAttacker.cardData.arena,opponent=combatAttacker.controller===own?enemy:own;
                    const defenders=eg.game.getArenaUnits().filter(c=>c.controller===opponent&&c.cardData.arena===arena),sentinels=defenders.filter(c=>c.hasSomeKeyword('sentinel'));
                    const expected=keyword(combatAttacker,'saboteur')?defenders.concat(opponent.base):sentinels.length?sentinels:defenders.concat(opponent.base);
                    assert.deepEqual(actions.filter(a=>a.kind==='card').map(a=>a.cardUuid).sort(),expected.map(c=>c.uuid).sort(),'Exact gained/lost Sentinel and Saboteur legal attack domain');
                    observe('actual-keyword-attack-domain',pid,actions);
                    if(p.combat?.kind==='sentinel-menu'){chosen=actions.find(a=>a.arg==='cancel');assert.ok(chosen);combatChecked=true;settled=true;}
                    else {combatDefender=Number.isInteger(p.combat?.defenderIndex)?targets[p.combat.defenderIndex]:enemy.base;chosen=actions.find(a=>a.cardUuid===combatDefender.uuid);assert.ok(chosen);combatPicked=true;combatBaseline={attackerDamage:combatAttacker.damage,defenderDamage:combatDefender.damage,defenderHp:combatDefender.getHp?.()??combatDefender.cardData.hp,defenderPower:combatDefender.isUnit?.()?combatDefender.getPower():0,shields:combatDefender.upgrades?.filter(t=>t.isShield?.()).slice()??[],baseDamage:own.base.damage,healCount:heals.length};}
                }
                else if(attacking&&/target for attack/i.test(prompt.menuTitle??'')){chosen=actions.find(a=>a.cardUuid===enemy.base.uuid);assert.ok(chosen);picked=true;capture();}
                else if(actions.some(a=>a.label==='You')&&actions.some(a=>a.label==='Opponent')){assert.equal(pid,own.id);chosen=actions.find(a=>a.label==='You');observe('declaration-owner-order',pid,actions);}
                chosen??=actions.find(a=>a.kind==='button'&&/trigger|resolve|play|yes/i.test(a.label??''));chosen??=actions.find(a=>a.arg==='done');
            }
            chosen??=bot.choose({game:eg,pid,actions,rng});assert.ok(chosen);
            records.push({type:'decision',step,actor:eg.seatOf(pid),prompt:{type:prompt.promptType??null,title:prompt.menuTitle??null,selected:(eg.player(pid).promptState.selectedCards??[]).map(id),actionWindow:window},actions:actions.map(a=>canonicalAction(eg,a)),chosen:canonicalAction(eg,chosen).key,events:[]});eg.apply(pid,chosen,rng);step++;
        }
        assert.ok(settled,'Actual source keyword construction settled');assert.ok(eg.over,'Full terminal source trace');records.push({type:'result',step,winner:eg.winner,state:fullState(eg)});witness.coverageObligationIds=[...scenario.coverageObligationIds];return {records,witness};
    }catch(error){error.diagnostic={records,witness};throw error;}finally{bot.close?.();}
}
module.exports={fixture,dependencies:['bot/omni/rs/make-pool.js','bot/cards/pipeline/arena-damage-probes.js','bot/cards/pipeline/arena-keyword-set-probes.js','bot/cards/pipeline/arena-keyword-set-probe-fixture.js','bot/cards/pipeline/probe-fixture.js','bot/env.js','bot/omni/rs/state.js','bot/players/index.js']};
