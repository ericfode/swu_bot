'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {parseKeywords}=require('../../omni/rs/make-pool');
const {compileCatalog}=require('../build');
const card=(text,extra={})=>({text,keywords:['hidden'],types:['unit'],...extra});
test('Hidden data-only parser consumes complete keyword text and rejects numeric boolean tokens',()=>{
 for(const text of ['Hidden','Hidden.','Hidden (This unit cannot be attacked this phase.)','Hidden\nSaboteur','Hidden, Restore 2'])assert.equal(parseKeywords(card(text)).hidden,1);
 for(const text of ['Hidden 1','Hidden 2','Hidden -1','Hidden extra','Hidden\nDraw a card.','This unit gains Hidden.','Hidden (unclosed','Hidden)'])assert.equal(parseKeywords(card(text)),null,text);
 assert.equal(parseKeywords(card('Hidden',{pilotText:'Hidden'})),null);
 assert.equal(parseKeywords(card('Hidden',{keywords:['hidden','plot']})),null);
});
test('thirty-three actual no-source ordinary units convert with complete printed Hidden',()=>{
 const c=compileCatalog();const cards=c.cards.filter(c=>c.status==='supported'&&c.sourcePath===null&&c.keywordValues.hidden===1);
 assert.equal(cards.length,33);for(const c of cards){assert(c.card.types.includes('unit'));assert(!c.card.types.includes('leader'));assert(!c.card.pilotText);assert.notEqual(parseKeywords(c.card),null,c.setCode);assert.deepEqual(c.abilities,{leader:[],unit:[],card:[]});}
 const oldPool=JSON.parse(fs.readFileSync(require('node:path').resolve(__dirname,'../../omni/rs/pool.json')));for(const c of oldPool.cards.filter(c=>c.types.includes('unit')&&!c.types.includes('leader')))assert.notEqual(parseKeywords(c),null,c.setCode);
});

test('shared fail-closed keyword grammar matrix',()=>{
 for(const {text,expected} of require('../../omni/rs/keyword-parser-cases.json'))assert.deepEqual(parseKeywords({text,keywords:[],types:['unit']}),expected,text);
});

test('legacy CLI regenerates the exact immutable strict hundred-card pool',()=>{
 const os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'swu-legacy-keyword-pool-'));
 try {const output=path.join(dir,'pool.json');const result=spawnSync(process.execPath,[require.resolve('../../omni/rs/make-pool'),output],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.deepEqual(fs.readFileSync(output),fs.readFileSync(path.resolve(__dirname,'../../omni/rs/pool.json')));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
