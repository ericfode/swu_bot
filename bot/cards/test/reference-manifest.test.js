'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const lib = require('../reference/library');
const { sha256 } = require('../inventory');
const doc = rows => ({schema:'swu-reference-corpus/v1',recordings:rows});
const row = id => ({caseId:id,caseDefinition:{z:1,a:2},provenance:{path:'/historical',optional:null},witness:{states:[{z:3,a:4}]}});
function temporary(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'swu-manifest-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir; }
function moduleWith(file, overrides, suffix='') {
    const filename=path.resolve(__dirname,'../reference',file), ordinary=createRequire(filename), module={exports:{}};
    vm.runInNewContext(fs.readFileSync(filename,'utf8')+suffix,{require:name=>Object.hasOwn(overrides,name)?overrides[name]:ordinary(name),module,exports:module.exports,__dirname:path.dirname(filename),process,Buffer,console});
    return module.exports;
}
for (const format of ['manifest.json','manifest.json.gz']) test(format+' reader preserves raw bytes, keys, row order and absent properties',t=>{
    const dir=temporary(t), raw=Buffer.from(JSON.stringify(doc([row('z'),row('a'),{caseId:'b'}]),null,2)+'\n');
    const bytes=format.endsWith('.gz')?zlib.gzipSync(raw):raw;fs.writeFileSync(path.join(dir,format),bytes);
    const artifact=lib.manifestArtifact(dir);assert.equal(artifact.path,path.join(dir,format));assert.deepEqual(artifact.bytes,bytes);assert.deepEqual(artifact.decodedBytes,raw);assert.deepEqual(lib.corpus(dir),JSON.parse(raw));
    assert.deepEqual(Object.keys(lib.corpus(dir).recordings[0].caseDefinition),['z','a']);assert.equal(Object.hasOwn(lib.corpus(dir).recordings[2],'witness'),false);
    lib.writeManifest(dir,doc([row('z'),row('a')]));assert.deepEqual(fs.readdirSync(dir),[format]);assert.deepEqual(lib.corpus(dir).recordings.map(r=>r.caseId),['z','a']);
});
test('fresh writes gzip; refuses missing, ambiguous, corrupt, truncated and invalid documents',t=>{
    const dir=temporary(t);assert.throws(()=>lib.corpus(dir),/exactly one/);lib.writeManifest(dir,doc([row('a')]));assert.deepEqual(fs.readdirSync(dir),['manifest.json.gz']);
    const file=path.join(dir,'manifest.json.gz'), bytes=fs.readFileSync(file);fs.writeFileSync(path.join(dir,'manifest.json'),'{}');assert.throws(()=>lib.corpus(dir),/exactly one/);assert.throws(()=>lib.writeManifest(dir,doc([row('a')])),/Ambiguous/);fs.unlinkSync(path.join(dir,'manifest.json'));
    for(const invalid of [bytes.subarray(0,bytes.length-4),Buffer.from('garbage'),zlib.gzipSync('{'),zlib.gzipSync(JSON.stringify({schema:'wrong',recordings:[{}]})),zlib.gzipSync(JSON.stringify(doc([])))]) {fs.writeFileSync(file,invalid);assert.throws(()=>lib.corpus(dir));}
});
test('failed atomic rename preserves previous bytes and removes temporary output',t=>{
    const dir=temporary(t);lib.writeManifest(dir,doc([row('old')]));const before=fs.readFileSync(path.join(dir,'manifest.json.gz')),rename=fs.renameSync;
    fs.renameSync=()=>{throw Error('injected rename failure');};try{assert.throws(()=>lib.writeManifest(dir,doc([row('new')])),/injected/);}finally{fs.renameSync=rename;}
    assert.deepEqual(fs.readFileSync(path.join(dir,'manifest.json.gz')),before);assert.deepEqual(fs.readdirSync(dir),['manifest.json.gz']);
});
function fixture(dir,id) {
    for(const sub of ['pools','traces'])fs.mkdirSync(path.join(dir,sub),{recursive:true});
    const definition={id:'auto/TST_001/'+id,kind:'probe',focusCardIds:['TST_001'],behaviorIds:['test'],setupCardIds:[],source:{module:'../pipeline/probe-fixture.js',scenario:'test'}};
    const pool=Buffer.from('{}'),poolSha256=sha256(pool);fs.writeFileSync(lib.artifact(dir,'pool',poolSha256),pool);
    const trace=zlib.gzipSync([{type:'meta',schema:'omni-rs-trace-v1',pool:{sha256:poolSha256},seed:1,scenario:'test',referenceCase:{id:definition.id,definitionSha256:sha256(JSON.stringify(definition))}},{type:'state'},{type:'decision'},{type:'result'}].map(JSON.stringify).join('\n'));
    const traceSha256=sha256(trace);fs.writeFileSync(lib.artifact(dir,'trace',traceSha256),trace);
    return {...row(definition.id),caseDefinition:definition,poolSha256,traceSha256,seed:1,windows:1,decisions:1};
}
for(const format of ['manifest.json','manifest.json.gz']) test(format+' verify and CLI list/verify reject metadata tampering',t=>{
    const dir=temporary(t),recording=fixture(dir,'test'),raw=Buffer.from(JSON.stringify(doc([recording])));fs.writeFileSync(path.join(dir,format),format.endsWith('.gz')?zlib.gzipSync(raw):raw);
    assert.equal(lib.verify(dir).recordings,1);
    const cli=path.resolve(__dirname,'../reference/cli.js');for(const command of ['list','verify'])assert.ok(JSON.parse(execFileSync(process.execPath,[cli,command,'--corpus',dir],{encoding:'utf8'})));
    recording.seed=2;lib.writeManifest(dir,doc([recording]));assert.throws(()=>lib.verify(dir),/seed differs/);
});
for(const format of ['manifest.json','manifest.json.gz']) test(format+' adoption preserves destination and appends unique incoming order after runtime checks',async t=>{
    const root=temporary(t),destination=path.join(root,'accepted'),incoming=path.join(root,'incoming');
    const old=fixture(destination,'z'),a=fixture(incoming,'a'),b=fixture(incoming,'b');fs.writeFileSync(lib.artifact(incoming,'trace',old.traceSha256),fs.readFileSync(lib.artifact(destination,'trace',old.traceSha256)));
    const raw=Buffer.from(JSON.stringify(doc([old])));fs.writeFileSync(path.join(destination,format),format.endsWith('.gz')?zlib.gzipSync(raw):raw);lib.writeManifest(incoming,doc([b,old,a,b]));
    // Duplicate incoming records are normally rejected by verification; remove the repeated b.
    lib.writeManifest(incoming,doc([b,old,a]));
    const catalogue=path.join(root,'catalog.json'),native=path.join(root,'native');fs.writeFileSync(catalogue,'{}');fs.writeFileSync(native,'fake native for orchestration test');let comparisons=0;
    const wrapped={...lib,defaultCorpus:destination,corpus:d=>lib.corpus(d??destination),verify:d=>lib.verify(d??destination)};
    const check=moduleWith('check.js',{'./library':wrapped,'node:child_process':{spawnSync:(_binary,args)=>{comparisons++;return {status:0,stdout:args.filter(a=>a.endsWith('.jsonl.gz')).map(()=>JSON.stringify({matched:true,decisions:1,windows:1})).join('\n')};}},'../../omni/wasm/node':{createSimulator:async()=>({free(){}})},'../../omni/wasm/check':{records:()=>[],checkRecords:()=>({matched:true,runtime:'wasm',decisions:1,windows:1})}},'\n// Isolate orchestration from runtime files in this storage test.\n');
    // check() defaults resolve its catalogue/package relative to repo; intercept only those reads.
    const originalRead=fs.readFileSync,originalList=fs.readdirSync;
    fs.readFileSync=function(file,...args){if(String(file).endsWith('/bot/card-compiler/generated/catalog.json'))return originalRead(catalogue,...args);return originalRead(file,...args);};
    fs.readdirSync=function(file,...args){if(String(file).endsWith('/bot/omni-wasm/pkg/node'))return [];return originalList(file,...args);};
    try{await check.adopt({corpus:incoming,native});}finally{fs.readFileSync=originalRead;fs.readdirSync=originalList;}
    assert.ok(comparisons);assert.deepEqual(lib.corpus(destination).recordings,[old,b,a]);assert.equal(path.basename(lib.manifestArtifact(destination).path),format);
});
test('generation orchestration writes a fresh gzip corpus without changing witness or provenance',async t=>{
    const root=temporary(t),out=path.join(root,'generated'),catalogue=path.join(root,'catalog.json'),pool=path.join(root,'pool.json');fs.writeFileSync(catalogue,'{"cards":[]}');fs.writeFileSync(pool,'{}');
    const entry={id:'auto/TST_001/generated',kind:'probe',focusCardIds:['TST_001'],setupCardIds:[],source:{module:'../pipeline/probe-fixture.js',scenario:'generated'}};
    const witness={optional:null,states:[{z:1,a:2}]};
    const generate=moduleWith('generate.js',{'../../env':{Env:class{}},'../../omni/rs/pool':{loadPool:()=>({})},[path.resolve(__dirname,'../pipeline/probe-fixture.js')]:{fixture:async()=>({witness,records:[{type:'meta',schema:'omni-rs-trace-v1',pool:{sha256:sha256('{}')},seed:1,scenario:'generated'},{type:'decision'},{type:'state'},{type:'result'}]})}},'\nsourceIdentity = () => ({}); prepareEngine = () => ({storageTest:true});');
    await generate.generate({out,entries:[entry],catalogue,pool,seed:1});
    const artifact=lib.manifestArtifact(out);assert.equal(path.basename(artifact.path),'manifest.json.gz');assert.deepEqual(artifact.document.recordings[0].witness,witness);assert.equal(artifact.document.recordings[0].provenance.sourceCatalogueSha256,sha256(fs.readFileSync(catalogue)));assert.deepEqual(artifact.document.recordings[0].caseDefinition,entry);
});
