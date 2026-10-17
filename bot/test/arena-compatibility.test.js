'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { compatibilityStatus, verification } = require('../arena/compatibility');

const digest = 'a'.repeat(64);
const build = 'b'.repeat(40);

test('protocol compatibility requires observed v2, an exact bundle digest and a known checker build', () => {
    const evidence = verification({ negotiatedProtocol: 2 }, digest, build);
    assert.equal(compatibilityStatus(evidence, { bundleSha256: digest }).compatible, true);
    assert.equal(compatibilityStatus(evidence, { bundleSha256: digest, checkerBuild: build }).compatible, true);
    for (const absent of [undefined, { checked: true }, { protocol: 2 }]) {
        assert.match(compatibilityStatus(absent, { bundleSha256: digest }).reason, /no verified/);
    }
    assert.equal(compatibilityStatus(evidence).compatible, false, 'no expected bundle digest means no verification');
    assert.match(compatibilityStatus(evidence, { bundleSha256: 'c'.repeat(64) }).reason, /bundle differs/);
    assert.match(compatibilityStatus(evidence, { bundleSha256: digest, checkerBuild: 'c'.repeat(40) }).reason, /another checker build/);
    assert.match(compatibilityStatus({ ...evidence, checkerBuild: 'unknown' }, { bundleSha256: digest }).reason, /build identity/);
    assert.match(compatibilityStatus({ ...evidence, checkedAt: null }, { bundleSha256: digest }).reason, /completion time/);
    for (const negotiatedProtocol of [undefined, 1, '2', true]) {
        assert.throws(() => verification({ negotiatedProtocol }, digest, build), /explicit ready.v of 2/);
    }
});

test('v2 evidence is bound to the exact trusted arena, protocol, engine/card and runner context', () => {
    const { contextFor } = require('../arena/identity');
    const context = contextFor({ arenaId: 'v2', build, cards: 'c'.repeat(64) });
    const evidence = verification({ negotiatedProtocol: 2 }, digest, build, context);
    assert.deepEqual(evidence.context, context);
    assert.notEqual(evidence.context, context, 'caller mutations cannot change recorded context');
    assert.equal(compatibilityStatus(evidence, { bundleSha256: digest, context }).compatible, true);
    assert.equal(compatibilityStatus(evidence, { bundleSha256: digest, context: null }).compatible, false);
    assert.match(compatibilityStatus(verification({ negotiatedProtocol: 2 }, digest, build), { bundleSha256: digest, context }).reason, /no verified v2 arena comparison context/);
    for (const changed of [{ schema: 2 }, { arenaId: 'open' }, { protocol: 1 }, { engineRevision: 'd'.repeat(64) }, { runnerRevision: 'different-runner' }]) {
        const status = compatibilityStatus({ ...evidence, context: { ...context, ...changed } }, { bundleSha256: digest, context });
        assert.equal(status.compatible, false, JSON.stringify(changed));
    }
    for (const oldContext of [
        contextFor({ arenaId: 'v2', build: 'd'.repeat(40), cards: 'c'.repeat(64) }),
        contextFor({ arenaId: 'v2', build, cards: 'd'.repeat(64) })
    ]) {
        assert.match(compatibilityStatus(evidence, { bundleSha256: digest, context: oldContext }).reason, /differs at engineRevision/);
    }
    assert.throws(() => verification({ negotiatedProtocol: 2 }, digest, build, null), /current arena comparison context is unavailable/);
});

test('the exact admission checker keeps the v1 envelope, offers only v2 and requires an explicit v2 ready', () => {
    // Repository-owned trusted Node fixtures only. Stub card data isolates the
    // checker negotiation from the engine installation; no submitted code runs.
    const source = fs.readFileSync(path.join(__dirname, '..', 'arena', 'api.js'), 'utf8');
    const literal = /const START_CHECK = (`[\s\S]*?`);/.exec(source)?.[1];
    assert.ok(literal);
    const checker = vm.runInNewContext(literal);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-checker-v2-'));
    const env = { PATH: process.env.PATH, LANG: 'C', TZ: 'UTC' };
    try {
        const cards = path.join(dir, 'cards.cjs');
        const decks = path.join(dir, 'decks.json');
        const bot = path.join(dir, 'bot.cjs');
        fs.writeFileSync(cards, 'exports.cardGetter=()=>null;exports.gameCards=()=>[{setId:"fixture"}];\n');
        fs.writeFileSync(decks, '[{"fixture":true},{"fixture":true}]\n');
        for (const [ready, accepted] of [[{ t: 'ready', v: 2 }, true], [{ t: 'ready' }, false], [{ t: 'ready', v: 1 }, false], [{ t: 'ready', v: '2' }, false], [{ t: 'ready', v: 3 }, false]]) {
            fs.writeFileSync(bot, `require('readline').createInterface({input:process.stdin}).once('line',line=>{const m=JSON.parse(line);if(m.v!==1||JSON.stringify(m.versions)!=='[2]'||!Array.isArray(m.cards))process.exit(2);console.log(${JSON.stringify(JSON.stringify(ready))});});\n`);
            const r = spawnSync(process.execPath, ['-e', checker, path.join(__dirname, '..', 'stdio.js'), cards, decks, dir, 'trusted-fixture', JSON.stringify({ cmd: 'node', args: [bot] }), '1500'], { env, encoding: 'utf8', timeout: 2500 });
            assert.equal(r.status, accepted ? 0 : 1, r.stderr);
            if (accepted) assert.deepEqual(JSON.parse(r.stdout), { negotiatedProtocol: 2 });
            else assert.match(r.stderr, /protocol v2 required: expected explicit/);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('migration cannot fall back to running a bot without isolation', async () => {
    const before = process.env.ARENA_INTAKE_NO_ISOLATE;
    process.env.ARENA_INTAKE_NO_ISOLATE = '1';
    try {
        const { checkIsolated } = require('../arena/intake');
        const result = await checkIsolated({ files: { 'bot.js': 'throw new Error("must never run")' } }, { requireIsolation: true });
        assert.equal(result.ok, false);
        assert.match(result.error, /isolated protocol v2 check unavailable.*no bot was run/);
    } finally {
        if (before === undefined) delete process.env.ARENA_INTAKE_NO_ISOLATE;
        else process.env.ARENA_INTAKE_NO_ISOLATE = before;
    }
});

test('regular v2 admission cannot opt out of Linux root checker isolation', () => {
    // Trusted process fixture only: every case must stop before even looking up the
    // checker build, admitting a job, writing files, or starting any subprocess.
    const script = `
const assert=require('assert/strict'),path=require('path'),cp=require('child_process');
cp.spawn=()=>{throw new Error('must not start a checker');};
cp.spawnSync=()=>{throw new Error('must not look up a checker build');};
const intake=require(path.join(process.argv[1],'bot/arena/intake'));
(async()=>{
for(const mode of ['nonroot','missinguser','disabled','nonlinux']){
 Object.defineProperty(process,'platform',{value:mode==='nonlinux'?'darwin':'linux',configurable:true});
 process.getuid=()=>mode==='nonroot'?1000:0;
 if(mode==='missinguser')delete process.env.ARENA_USER;else process.env.ARENA_USER='arena-fixture';
 if(mode==='disabled')process.env.ARENA_INTAKE_NO_ISOLATE='1';else delete process.env.ARENA_INTAKE_NO_ISOLATE;
 for(const options of [undefined,{requireIsolation:false},{requireIsolation:true}]){
  const result=await intake.checkIsolated({},options);
  assert.equal(result.ok,false,mode);
  assert.match(result.error,/isolated protocol v2 check unavailable.*no bot was run/,mode);
 }
}
})().catch(e=>{console.error(e);process.exitCode=1;});`;
    const r = spawnSync(process.execPath, ['-e', script, path.join(__dirname, '..', '..')], {
        env: { PATH: process.env.PATH, LANG: 'C', TZ: 'UTC', ARENA_ID: 'v2' }, encoding: 'utf8', timeout: 5000
    });
    assert.equal(r.status, 0, r.stderr || r.error?.message);
});

test('a checker that exits successfully without handshake output supplies no compatibility proof', () => {
    const script = `const cp=require('child_process');cp.spawnSync=()=>({status:0,stdout:'',stderr:''});const assert=require('assert/strict');const {startCheck}=require(process.argv[1]);assert.throws(()=>startCheck(process.argv[2],'trusted-fixture',{cmd:'never-executed'},'fixture'),/no verified protocol v2 handshake/);`;
    const r = spawnSync(process.execPath, ['-e', script, path.join(__dirname, '..', 'arena', 'api.js'), os.tmpdir()], {
        env: { PATH: process.env.PATH, LANG: 'C', TZ: 'UTC' }, encoding: 'utf8', timeout: 5000
    });
    assert.equal(r.status, 0, r.stderr || r.error?.message);
});

test('isolated-checker transport binds evidence to root-selected build and tar before admission', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-checker-transport-'));
    const script = `
const fs=require('fs'),path=require('path'),cp=require('child_process'),assert=require('assert/strict');
const {EventEmitter}=require('events');
const root=process.argv[1],base=process.argv[2];
const identity=require(path.join(root,'bot/arena/identity'));
const expected=identity.contextFor({arenaId:identity.id,build:'b'.repeat(40),cards:'c'.repeat(64)});
let currentContext=expected;identity.comparisonContext=()=>currentContext;
const fixture=path.join(base,'fixture');fs.mkdirSync(fixture);
fs.writeFileSync(path.join(fixture,'bot.wasm'),'trusted nonexecuted fixture');
fs.writeFileSync(path.join(fixture,'arena.json'),JSON.stringify({schema:'swu-arena-bot/1',protocol:2,kind:'wasm',platform:'wasm32-wasip1',runtime:'wasi-p1',run:{cmd:'./bot.wasm'}}));
// Simulate the root transport without changing ownership, creating namespaces or
// starting a checker/bot. Only canonical-tar validation subprocesses are real.
Object.defineProperty(process,'platform',{value:'linux',configurable:true});
process.getuid=()=>0;process.kill=()=>{};fs.chownSync=()=>{};fs.lchownSync=()=>{};
const execFileSync=cp.execFileSync;cp.execFileSync=(cmd,args,opts)=>cmd==='id'?'1':execFileSync(cmd,args,opts);
let mode;const calls=[];
cp.spawn=(cmd,args,opts)=>{
 assert.equal(cmd,'bash');assert(args[0].endsWith('isolate.sh'));assert(args.includes('--user'));assert(args.includes('arena-fixture'));
 assert.equal(opts.env.FIXTURE_SECRET,undefined);
 const file=args[args.indexOf('--check')+1],job=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.notEqual(job.checkerBuild,'forged');assert.equal(opts.env.ARENA_ID,identity.id);
 assert.deepEqual(job.context,identity.id==='v2'?expected:undefined);calls.push(mode);
 const child=new EventEmitter();child.pid=2147483000;child.stdout=new EventEmitter();child.stderr=new EventEmitter();
 setImmediate(()=>{const c=require(path.join(root,'bot/arena/compatibility'));const tar=cp.spawnSync('python3',['-I',path.join(root,'bot/compiled/bundle.py'),'tar',fixture]);assert.equal(tar.status,0);
 fs.writeFileSync(path.join(path.dirname(file),'bundle.tar'),tar.stdout);
 const sha256=require('crypto').createHash('sha256').update(tar.stdout).digest('hex');
 const compatibility=c.verification({negotiatedProtocol:2},sha256,job.checkerBuild,job.context);
 if(mode==='digest')compatibility.bundleSha256='0'.repeat(64);if(mode==='build')compatibility.checkerBuild='0'.repeat(40);
 if(mode==='context_missing')delete compatibility.context;if(mode==='context_mismatch')compatibility.context.runnerRevision='another-runner';
 child.stdout.emit('data',JSON.stringify({ok:true,sha256,...(mode==='missing'?{}:{compatibility})})+'\\n');child.emit('close',0);});
 return child;
};
const intake=require(path.join(root,'bot/arena/intake'));
(async()=>{if(identity.id==='v2'){assert.throws(()=>intake.packAndCheck({context:null},{work:'never-used'}),/comparison context is unavailable/);currentContext=null;const unavailable=await intake.checkIsolated({}, {requireIsolation:true});assert.match(unavailable.error,/comparison context is unavailable/);assert.equal(calls.length,0);currentContext=expected;}
for(const invalid of [null,'0'.repeat(63),'A'.repeat(64),42]){const refused=await intake.checkIsolated({}, {requireIsolation:true,expectedBundleSha256:invalid});assert.match(refused.error,/must be 64 lowercase hexadecimal characters/);assert.equal(calls.length,0);}
const sourceDigest=require(path.join(root,'bot/arena/compatibility')).bundleDigest(fixture);
const modes=['ok','missing','digest','build',...(identity.id==='v2'?['context_missing','context_mismatch']:[])];
const results=[];for(mode of modes)results.push(await intake.checkIsolated({id:'fixture.'+mode,owner:'fixture',name:'fixture_'+mode,kind:'wasm',note:'trusted transport fixture',files:{},checkerBuild:'forged',context:{forged:true}},{requireIsolation:true,...(mode==='ok'?{expectedBundleSha256:sourceDigest}:{})}));
assert.equal(results[0].ok,true);assert.equal(results[0].compatibility.negotiatedProtocol,2);
assert.match(results[1].error,/no verified protocol v2 handshake/);assert.match(results[2].error,/bundle differs/);assert.match(results[3].error,/another checker build/);
if(identity.id==='v2'){assert.match(results[4].error,/no verified v2 arena comparison context/);assert.match(results[5].error,/differs at runnerRevision/);}
const meta=JSON.parse(fs.readFileSync(path.join(process.env.ARENA_HOME,'versions','fixture_ok-v1','SUBMISSION.json'),'utf8'));
assert.equal(meta.bundleSha256,meta.compatibility.bundleSha256);assert.equal(calls.length,modes.length);
mode='source_mismatch';const mismatch=await intake.checkIsolated({id:'fixture.source_mismatch',owner:'fixture',name:'fixture_source_mismatch',kind:'wasm',note:'trusted source digest fixture',files:{}},{requireIsolation:true,expectedBundleSha256:'0'.repeat(64)});
assert.match(mismatch.error,/does not match the expected source bundle SHA-256/);
const home=require(path.join(root,'bot/arena/home'));assert.deepEqual(home.versionsOf('fixture_source_mismatch'),[]);assert(!home.roster().agents.some(a=>a.name==='fixture_source_mismatch'));
assert.equal(calls.length,modes.length+1);
const retry=await intake.checkIsolated({id:'fixture.ok',owner:'fixture',name:'fixture_ok',kind:'wasm',note:'retry',files:{}},{requireIsolation:true,expectedBundleSha256:'0'.repeat(64)});
assert.match(retry.error,/does not match the expected source bundle SHA-256/);assert.equal(calls.length,modes.length+1,'retry compares existing digest without starting another checker');
const api=require(path.join(root,'bot/arena/api')).api;
assert.deepEqual(api.status().context,expected);assert.equal(api.status().competitors.find(c=>c.name==='fixture_ok').compatibility.compatible,true);
if(identity.id==='v2'){assert.deepEqual(meta.compatibility.context,expected);currentContext={...expected,engineRevision:'d'.repeat(64)};
 assert.equal(api.status().competitors.find(c=>c.name==='fixture_ok').compatibility.compatible,false);
 assert.match(api.versions({name:'fixture_ok'}).at(-1).compatibilityStatus.reason,/differs at engineRevision/);}
console.log(JSON.stringify({ok:true,cases:results.map(r=>r.ok)}));})().catch(e=>{console.error(e);process.exitCode=1;});
`;
    try {
        for (const selected of ['open', 'v2']) {
            const base = path.join(dir, selected);
            fs.mkdirSync(base);
            const env = { PATH: process.env.PATH, LANG: 'C', TZ: 'UTC', ARENA_ID: selected, ARENA_USER: 'arena-fixture', FIXTURE_SECRET: 'synthetic-test-value',
                ARENA_HOME: path.join(base, 'arena'), ARENA_RESULTS: path.join(base, 'results'), ARENA_DASH: path.join(base, 'dash'), ARENA_INTAKE_WORK: path.join(base, 'work') };
            const r = spawnSync(process.execPath, ['-e', script, path.join(__dirname, '..', '..'), base], { env, encoding: 'utf8', timeout: 15000 });
            assert.equal(r.status, 0, r.stderr || r.error?.message);
            assert.deepEqual(JSON.parse(r.stdout), { ok: true, cases: [true, false, false, false, ...(selected === 'v2' ? [false, false] : [])] });
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
