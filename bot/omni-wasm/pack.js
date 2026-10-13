'use strict';
// Package existing bindings only. Building and registry publication are separate.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function main() {
    const root = path.resolve(__dirname, '../..');
    const pkg = path.join(__dirname, 'pkg');
    const destination = path.join(pkg, 'distribution');
    const staging = path.join(destination, 'package');
    const sourceBindings = ['node', 'web'].map((target) => ({target, dir:path.join(pkg,target)}));
    for (const {target,dir} of sourceBindings) for (const file of ['omni_wasm.js','omni_wasm_bg.wasm','omni_wasm.d.ts','package.json']) {
        if (!fs.existsSync(path.join(dir,file))) throw new Error(`Missing ${target}/${file}; build both targets with npm run wasm:build first`);
    }
    const cargo = fs.readFileSync(path.join(__dirname,'Cargo.toml'),'utf8');
    const version = /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
    if (!version) throw new Error('Missing Wasm crate version');
    fs.mkdirSync(destination,{recursive:true});
    fs.rmSync(staging,{recursive:true,force:true});
    fs.mkdirSync(staging,{recursive:true});
    for (const {target,dir} of sourceBindings) {
        const out = path.join(staging,'bindings',target);
        fs.mkdirSync(out,{recursive:true});
        for (const file of fs.readdirSync(dir)) if (/\.(?:js|wasm|ts)$/.test(file)||file==='package.json') fs.copyFileSync(path.join(dir,file),path.join(out,file));
    }
    fs.copyFileSync(path.join(root,'bot/omni/wasm/adapter.mjs'),path.join(staging,'adapter.mjs'));
    fs.copyFileSync(path.join(root,'bot/omni/rs/pool.json'),path.join(staging,'pool.json'));
    fs.copyFileSync(path.join(__dirname,'PACKAGING.md'),path.join(staging,'README.md'));
    fs.writeFileSync(path.join(staging,'node.cjs'),`'use strict';
const fs = require('node:fs');
const path = require('node:path');
const bindings = require('./bindings/node/omni_wasm.js');
async function createSimulator({poolPath,poolJson,cataloguePath,catalogueJson}={}) {
    const {WasmSimulator}=await import('./adapter.mjs');
    const catalogue=catalogueJson??(cataloguePath===undefined?undefined:fs.readFileSync(cataloguePath,'utf8'));
    const sourcePool=poolPath??(catalogue===undefined?path.join(__dirname,'pool.json'):undefined);
    const pool=poolJson??(sourcePool===undefined?undefined:fs.readFileSync(sourcePool,'utf8'));
    return new WasmSimulator(bindings,pool,{catalogueJson:catalogue});
}
module.exports={createSimulator};
`);
    fs.writeFileSync(path.join(staging,'browser.mjs'),`import init, * as bindings from './bindings/web/omni_wasm.js';
import {WasmSimulator} from './adapter.mjs';
export async function createSimulator({poolJson,catalogueJson,wasm}={}) {
    await init(wasm);
    return new WasmSimulator(bindings,poolJson,{catalogueJson});
}
`);
    const manifest = {
        name:'@swu-bot/omni-wasm',version,private:true,description:'Portable persistent SWU subset simulator and bounded prover; shared Rust core',
        type:'module',main:'./node.cjs',module:'./browser.mjs',browser:'./browser.mjs',
        exports:{'.':{browser:'./browser.mjs',node:'./node.cjs',default:'./browser.mjs'},'./node':'./node.cjs','./browser':'./browser.mjs','./adapter':'./adapter.mjs','./pool.json':'./pool.json','./bindings/node':{types:'./bindings/node/omni_wasm.d.ts',default:'./bindings/node/omni_wasm.js'},'./bindings/web':{types:'./bindings/web/omni_wasm.d.ts',default:'./bindings/web/omni_wasm.js'},'./wasm':'./bindings/web/omni_wasm_bg.wasm','./package.json':'./package.json'},
        files:['node.cjs','browser.mjs','adapter.mjs','pool.json','bindings','README.md'],engines:{node:'>=22'},sideEffects:['./bindings/**']
    };
    fs.writeFileSync(path.join(staging,'package.json'),JSON.stringify(manifest,null,2)+'\n');
    const packed=spawnSync(process.platform==='win32'?'npm.cmd':'npm',['pack','--json','--ignore-scripts','--pack-destination',destination],{cwd:staging,encoding:'utf8'});
    if(packed.status!==0)throw new Error(packed.stderr||packed.stdout||'npm pack failed');
    const info=JSON.parse(packed.stdout)[0];
    const tarball=path.join(destination,info.filename);
    const sha256=crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
    const receipt={name:manifest.name,version,tarball,sha256,bytes:fs.statSync(tarball).size,unpackedBytes:info.unpackedSize,files:info.files.map(f=>f.path),dependencies:[],builtBindingsReused:true};
    fs.writeFileSync(path.join(destination,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
    console.log(JSON.stringify(receipt,null,2));
}
if(require.main===module){try{main();}catch(e){console.error(e.stack||e);process.exitCode=1;}}
module.exports={main};
