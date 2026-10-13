'use strict';
/** Real engine receipts for the compiled runtime pool; no simulator-owned oracle. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Env } = require('../../env');
const { loadPool } = require('./pool');
const { traceGame, seedList } = require('./trace');
const arg = (name, fallback) => { const i=process.argv.indexOf(`--${name}`); return i<0?fallback:process.argv[i+1]; };

function interactionDeck(pool) {
    const codes = ['ASH_259','TWI_107','SOR_241','SHD_040','SOR_073','JTL_051','TWI_056','SHD_196','IBH_013','IBH_059','TS26_068','SOR_077','SEC_204','SOR_059','LAW_165','LOF_239','TWI_140'];
    const allowed=new Set(pool.cards.map(c=>c.setCode));
    for(const code of [...codes,'SOR_014','SOR_023']) if(!allowed.has(code)) throw new Error(`Compiled fixture requires admitted card ${code}`);
    return {metadata:{name:'Compiled effect and continuation interaction fixture',author:'omni-rs fixture'},leader:{id:'SOR_014',count:1},base:{id:'SOR_023',count:1},deck:codes.map((id,i)=>({id,count:i===codes.length-1?2:3})),isPresentInDb:false};
}
function summarize(records) {
    const played=new Set(), effectSources=new Set(), effects={};
    let maxShields=0,maxExperience=0;
    for(const r of records){
        for(const event of r.events??[]){
            if(event.name==='onCardPlayed'&&event.card?.s)played.add(event.card.s);
            if(event.source?.s&&['onDamageDealt','onDamageHealed','onCardsDrawn','onCardReadied','onCardExhausted','onUpgradeAttached','onCardDefeated'].includes(event.name))effectSources.add(event.source.s);
            effects[event.name]=(effects[event.name]??0)+1;
        }
        if(r.state)for(const player of Object.values(r.state.players))for(const unit of [...player.ground,...player.space]){
            maxShields=Math.max(maxShields,unit.upgrades.filter(u=>u.setCode==='TOKEN_SHIELD').length);
            maxExperience=Math.max(maxExperience,unit.upgrades.filter(u=>u.setCode==='TOKEN_EXPERIENCE').length);
        }
    }
    return {decisions:records.filter(r=>r.type==='decision').length,windows:records.filter(r=>r.type==='state').length,winner:records.at(-1).winner,playedCards:[...played].sort(),effectSourceCards:[...effectSources].sort(),events:effects,maxShieldsOnUnit:maxShields,maxExperienceOnUnit:maxExperience};
}
async function main(){
    const sourcePool=path.resolve(arg('pool',path.join(__dirname,'../../card-compiler/generated/runtime-pool.json')));
    const out=path.resolve(arg('out',path.join(__dirname,'../../omni-rs/tests/compiled-fixtures')));
    fs.mkdirSync(out,{recursive:true});
    // A receipt's exact pool remains beside it even after later admission changes.
    const poolFile=path.join(out,'pool.json');
    const bytes=fs.readFileSync(sourcePool);
    if(fs.existsSync(poolFile)&&!fs.readFileSync(poolFile).equals(bytes))throw new Error(`Output directory has another pool; choose a new --out directory: ${out}`);
    fs.writeFileSync(poolFile,bytes);
    const pool=loadPool(poolFile),env=new Env(),games=[];
    const save=(name,records)=>{
        const file=path.join(out,`${name}.jsonl.gz`);
        fs.writeFileSync(file,zlib.gzipSync(records.map(r=>JSON.stringify(r)).join('\n')+'\n'));
        const summary={file:path.basename(file),...summarize(records)};
        games.push(summary);console.log(`${summary.file}: ${summary.decisions} decisions, winner ${summary.winner}`);
    };
    if(!process.argv.includes('--targeted-only'))for(const bots of [['random','random'],['heuristic','heuristic'],['random','heuristic'],['heuristic','random']])for(const seed of seedList(arg('seeds','3001-3003'))){
        save(`${bots.join('-vs-')}-${seed}`,await traceGame(env,pool,seed,bots));
    }
    const deck=interactionDeck(pool);
    env.randomDeck=()=>structuredClone(deck);
    for(const seed of seedList(arg('targeted-seeds','4001-4002'))){
        const records=await traceGame(env,pool,seed,['random','random']);
        records[0].fixtureConstruction='Ordinary seeded game with the listed fifty-card decks. Off-aspect cards pay normal penalties. Targets and continuations are executed by the unmodified engine.';
        save(`effect-interactions-${seed}`,records);
    }
    const summary={schema:'omni-rs-engine-corpus-v1',poolSha256:pool.provenance.sha256,poolCards:pool.cards.length,gameConformance:'Run omni-rs check against these receipts; generation alone does not establish Rust agreement.',games};
    fs.writeFileSync(path.join(out,'observed-coverage.json'),JSON.stringify(summary,null,2)+'\n');
}
if(require.main===module)main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
module.exports={interactionDeck,summarize};
