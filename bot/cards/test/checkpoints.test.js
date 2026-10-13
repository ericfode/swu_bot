'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const { init, status, recordReviewedRun } = require('../pipeline/checkpoints');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const digest = o => sha(JSON.stringify(o));
function fixture(count=200) {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'swu-cadence-')), repo=path.join(dir,'repo'), out=path.join(dir,'ledger');
    fs.mkdirSync(repo);
    const git = args => execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
    git(['init','-q']);git(['config','user.name','test']);git(['config','user.email','test@example.invalid']);
    const admissionPath='admission.json';
    const write = (p,o) => fs.writeFileSync(p,JSON.stringify(o));
    write(path.join(repo,admissionPath),{schema:'omni-rs-catalogue-report-v1',catalogueHash:'engine-pool-hash',runtimeAdmittedCards:[{setCode:'OLD'}]}); fs.writeFileSync(path.join(repo,'impl.js'),'baseline');
    fs.mkdirSync(path.join(repo,'bot/card-compiler/generated'),{recursive:true}); fs.writeFileSync(path.join(repo,'bot/card-compiler/generated/catalog.json'),JSON.stringify({compilerHash:'pinned'})); git(['add','.']);git(['commit','-qm','baseline']);const before=git(['rev-parse','HEAD']);
    const cards=Array.from({length:count},(_,i)=>'TST_'+String(i).padStart(3,'0'));
    write(path.join(repo,admissionPath),{schema:'omni-rs-catalogue-report-v1',catalogueHash:'engine-pool-hash',runtimeAdmittedCards:['OLD','TOKEN_WEAKNESS',...cards].map(setCode=>({setCode}))}); fs.writeFileSync(path.join(repo,'impl.js'),'candidate'); fs.writeFileSync(path.join(repo,'bot/card-compiler/generated/catalog.json'),JSON.stringify({compilerHash:'pinned',cards:cards.map(setCode=>({setCode,card:{},abilities:{},sourceHash:null,sourcePath:null}))}));
    git(['add','.']);git(['commit','-qm','candidate']);const after=git(['rev-parse','HEAD']);
    const pipelineDirectory=path.join(dir,'pipeline');fs.mkdirSync(path.join(pipelineDirectory,'review'),{recursive:true}); fs.copyFileSync(path.join(repo,admissionPath),path.join(pipelineDirectory,'admission.json'));
    const defs=cards.map(cardId=>({id:'auto/'+cardId+'/case',kind:'probe',focusCardIds:[cardId],source:{module:'../pipeline/probe-fixture.js',scenario:'test'}}));
    const corpus=path.join(pipelineDirectory,'reference'); fs.mkdirSync(path.join(corpus,'traces'),{recursive:true});fs.mkdirSync(path.join(corpus,'pools'));
    const pool=Buffer.from('{}'), poolSha=sha(pool); fs.writeFileSync(path.join(corpus,'pools',poolSha+'.json'),pool);
    const catalogHash=sha(fs.readFileSync(path.join(repo,'bot/card-compiler/generated/catalog.json')));
    const recordings=defs.map(def=>{
        const rows=[{type:'meta',schema:'omni-rs-trace-v1',pool:{sha256:poolSha},seed:1,scenario:'test',referenceCase:{id:def.id,definitionSha256:digest(def)}},{type:'state'},{type:'decision'},{type:'result'}];
        const bytes=require('node:zlib').gzipSync(rows.map(JSON.stringify).join('\n')), traceSha=sha(bytes);fs.writeFileSync(path.join(corpus,'traces',traceSha+'.jsonl.gz'),bytes);
        return {caseId:def.id,caseDefinition:def,traceSha256:traceSha,poolSha256:poolSha,seed:1,decisions:1,windows:1,engineOnly:false,provenance:{sourceCatalogueSha256:catalogHash}};
    });write(path.join(corpus,'manifest.json'),{schema:'swu-reference-corpus/v1',recordings});
    const comparisons=cards.flatMap(id=>['native-auto','native-interpreter','wasm-auto'].map(runtime=>({caseId:'auto/'+id+'/case',runtime,matched:true,traceSha256:recordings.find(r=>r.caseId==='auto/'+id+'/case').traceSha256,poolSha256:poolSha,decisions:1,windows:1})));
    const packet={schema:'swu-card-review-packet/v1',catalogueSha256:catalogHash,implementation:[{path:'impl.js',sha256:sha('candidate')}],comparisons,cards:cards.map(cardId=>({cardId,printedCard:{},configuration:{},attachCondition:null,intrinsicKeywordValues:{},sourceHash:null,sourcePath:null,probes:{cases:[defs.find(d=>d.focusCardIds[0]===cardId)],uncovered:[]}}))};
    const review={schema:'swu-card-review/v1',packetSha256:digest(packet),reviewer:{model:'gpt-6.1-sol',effort:'high'},cards:cards.map(cardId=>({cardId,verdict:'no-findings',findings:[],uncoveredReviewed:[]}))};
    const report={schema:'swu-card-pipeline-run/v1',failure:null,catalogueSha256:catalogHash,review:{packetSha256:digest(packet)},comparisons,coverage:cards.map(cardId=>({cardId,obligations:[{status:'matched'}]}))};
    packet.mutations=[];report.mutations=[];packet.cards.forEach(c=>{c.coverage=report.coverage.find(r=>r.cardId===c.cardId);});
    packet.rules={execution:{auto:[],interpreter:[]}};
    report.plansSha256=digest(packet.cards.map(c=>c.probes));
    for(const backend of ['auto','interpreter']) {
        const identities={catalogueSha256:catalogHash,nativeSha256:sha('binary'),wasmPackage:{'omni_wasm.js':sha('js'),'omni_wasm_bg.wasm':sha('wasm')}};
        const rows=comparisons.filter(c=>c.runtime.endsWith('-'+backend));rows.forEach(c=>{c.identities=identities;});
        write(path.join(pipelineDirectory,'check-'+backend+'.json'),{schema:'swu-reference-check/v1',identities,results:rows.map(c=>({caseId:c.caseId,runtime:c.runtime.startsWith('native')?'native':'wasm',traceSha256:c.traceSha256,decisions:c.decisions,windows:c.windows,matched:true}))});
        fs.mkdirSync(path.join(pipelineDirectory,'dispatch-'+backend));
    }
    review.packetSha256=digest(packet);report.review.packetSha256=digest(packet);
    write(path.join(pipelineDirectory,'review/packet.json'),packet);write(path.join(pipelineDirectory,'review/result.json'),review);write(path.join(pipelineDirectory,'report.json'),report);
    const options={pipelineDirectory,beforeCommit:before,integrationCommit:after};
    init(out,{repositoryRoot:repo,baselineCommit:before,admissionPath});
    return {dir,repo,out,before,after,options,review,write,pipelineDirectory};
}
test('counts only newly admitted reviewed identities and enqueues immutable 200 snapshot once',()=>{
    const f=fixture();try {
        const s=recordReviewedRun(f.out,f.options);assert.equal(s.completedCardIds.length,200);assert.equal(s.jobs.length,1);assert.equal(s.jobs[0].snapshotCommit,f.after);
        const job=JSON.parse(fs.readFileSync(s.jobs[0].path));assert.equal(job.boundary,200);assert.equal(job.state,'pending');assert.equal(job.newCardIds.length,200);
        assert.deepEqual(recordReviewedRun(f.out,f.options),s);assert.equal(status(f.out).runs.length,1);
    } finally {fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('199 remains incremental; uncommitted bytes cannot replace integration proof',()=>{
    const f=fixture(199);try {
        assert.equal(recordReviewedRun(f.out,f.options).jobs.length,0);
        assert.throws(()=>recordReviewedRun(f.out,{...f.options,integrationCommit:'HEAD'}),/exact full commit/);
        assert.throws(()=>init(f.out,{repositoryRoot:f.repo,baselineCommit:f.after,admissionPath:'admission.json'}),/baseline changed/);
    } finally {fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('rejects low review, changed packet and integration implementation mismatch',()=>{
    const f=fixture(1);try {
        f.review.reviewer.effort='low';f.write(path.join(f.pipelineDirectory,'review/result.json'),f.review);
        assert.throws(()=>recordReviewedRun(f.out,f.options),/HIGH/);
        f.review.reviewer.effort='high';f.review.packetSha256='bad';f.write(path.join(f.pipelineDirectory,'review/result.json'),f.review);
        assert.throws(()=>recordReviewedRun(f.out,f.options),/bind/);
        assert.equal(status(f.out).completedCardIds.length,0);
    } finally {fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('stale cadence lock is not stolen',()=>{
    const f=fixture(1);try {fs.mkdirSync(path.join(f.out,'.checkpoint-lock'));assert.throws(()=>recordReviewedRun(f.out,f.options),/EEXIST/);assert.equal(status(f.out).runs.length,0);} finally {fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('failed ledger write leaves deterministic job retryable and preserves immutable evidence',()=>{
    const f=fixture();try {
        const original=fs.renameSync;
        fs.renameSync=function(from,to){if(path.basename(to)==='checkpoint.json')throw new Error('injected ledger failure');return original.apply(this,arguments);};
        try {assert.throws(()=>recordReviewedRun(f.out,f.options),/injected/);} finally {fs.renameSync=original;}
        const jobBytes=fs.readFileSync(path.join(f.out,'full-rebuild-200.json'));
        assert.equal(status(f.out).completedCardIds.length,0);
        const state=recordReviewedRun(f.out,f.options);assert.equal(state.jobs.length,1);assert.equal(state.completedCardIds.length,200);
        assert.deepEqual(fs.readFileSync(path.join(f.out,'full-rebuild-200.json')),jobBytes);
        fs.writeFileSync(path.join(f.out,state.runs[0].evidence[0].path),'changed');
        assert.throws(()=>status(f.out),/evidence changed/);
    } finally {fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('multiple crossed boundaries create separate pending exact-snapshot jobs',()=>{
    const f=fixture(400);try {const s=recordReviewedRun(f.out,f.options);assert.deepEqual(s.jobs.map(j=>j.id),['full-rebuild-200','full-rebuild-400']);assert.ok(s.jobs.every(j=>j.snapshotCommit===f.after));} finally {fs.rmSync(f.dir,{recursive:true,force:true});}

});
test('rejects implementation, backend, plan and ledger drift despite unchanged admitted counts',()=>{
    const f=fixture(1);try {
        const packetPath=path.join(f.pipelineDirectory,'review/packet.json'), reportPath=path.join(f.pipelineDirectory,'report.json'), reviewPath=path.join(f.pipelineDirectory,'review/result.json');
        const packet=JSON.parse(fs.readFileSync(packetPath)), report=JSON.parse(fs.readFileSync(reportPath));
        const badPacket=structuredClone(packet);badPacket.implementation[0].sha256=sha('wrong');
        f.review.packetSha256=digest(badPacket);const badReport=structuredClone(report);badReport.review.packetSha256=digest(badPacket);
        f.write(packetPath,badPacket);f.write(reviewPath,f.review);f.write(reportPath,badReport);
        assert.throws(()=>recordReviewedRun(f.out,f.options),/implementation differs/);
        f.write(packetPath,packet);f.review.packetSha256=digest(packet);f.write(reviewPath,f.review);f.write(reportPath,report);
        const receiptPath=path.join(f.pipelineDirectory,'check-auto.json'), receipt=JSON.parse(fs.readFileSync(receiptPath));receipt.identities.nativeSha256=sha('other');f.write(receiptPath,receipt);
        assert.throws(()=>recordReviewedRun(f.out,f.options),/Backend receipt changed/);
        const ledger=status(f.out);ledger.completedCardIds=['TST_999'];f.write(path.join(f.out,'checkpoint.json'),ledger);
        assert.throws(()=>status(f.out),/ledger differs/);
    } finally {fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('mutable ledger cannot replace immutable initial baseline',()=>{
    const f=fixture(1);try {const state=status(f.out);state.baseline.baselineCommit=f.after;f.write(path.join(f.out,'checkpoint.json'),state);assert.throws(()=>status(f.out),/Immutable baseline changed/);} finally {fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('actual admission object is required; fabricated schema or altered admission rejects',()=>{
    const f=fixture(1);try {const file=path.join(f.pipelineDirectory,'admission.json'), admission=JSON.parse(fs.readFileSync(file));admission.runtimeAdmittedCards.push({setCode:'TST_999'});f.write(file,admission);assert.throws(()=>recordReviewedRun(f.out,f.options),/Committed admission differs/);} finally {fs.rmSync(f.dir,{recursive:true,force:true});}
});

for (const format of ['manifest.json','manifest.json.gz']) test('cadence copies actual '+format+' bytes, reads back corpus and detects copied tampering',()=>{
    const f=fixture(1);try {
        const reference=require('../reference/library'),corpus=path.join(f.pipelineDirectory,'reference'),json=path.join(corpus,'manifest.json');
        if(format.endsWith('.gz')){fs.writeFileSync(path.join(corpus,format),require('node:zlib').gzipSync(fs.readFileSync(json)));fs.unlinkSync(json);}
        const source=reference.manifestArtifact(corpus),state=recordReviewedRun(f.out,f.options),evidence=state.runs[0].evidence.find(e=>e.path.endsWith('/reference/'+format));
        assert.ok(evidence);assert.equal(evidence.sha256,sha(source.bytes));assert.deepEqual(fs.readFileSync(path.join(f.out,evidence.path)),source.bytes);
        assert.deepEqual(reference.corpus(path.dirname(path.join(f.out,evidence.path))),source.document);assert.equal(state.jobs.length,0);
        fs.writeFileSync(path.join(f.out,evidence.path),'tampered');assert.throws(()=>status(f.out),/evidence changed/);
    } finally {fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('cadence readback rejects a damaged manifest copy before any admission is counted',()=>{
    const f=fixture(1),original=fs.writeFileSync;try {
        fs.writeFileSync=function(file,bytes,...args){if(String(file).includes('/evidence/')&&String(file).endsWith('/reference/manifest.json'))return original(file,'corrupt',...args);return original(file,bytes,...args);};
        assert.throws(()=>recordReviewedRun(f.out,f.options));assert.equal(status(f.out).completedCardIds.length,0);
    } finally {fs.writeFileSync=original;fs.rmSync(f.dir,{recursive:true,force:true});}
});
