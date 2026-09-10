import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectDataset,replayDataset,splitPeriods,chooseCandidate,qualifyCandidate,atomicJson,readJsonCache,assertDatasetOptions} from '../src/cb/research.mjs';
import {settings} from '../src/cb/config.mjs';

const product={product_id:'TEST-USDC',base_currency_id:'TEST',quote_currency_id:'USDC',product_type:'SPOT',status:'online',base_increment:'0.001',price_increment:'0.001',base_min_size:'0.001',base_max_size:'1000000',quote_min_size:'1',quote_max_size:'1000000',approximate_quote_24h_volume:'10000000'};
function dataset(){const start=172800,end=start+7200;return {version:1,start,end,feeRate:'0.012',products:[product],bars:{'TEST-USDC':Array.from({length:180},(_,i)=>({start:start-3600+i*60,open:10,high:10.1,low:9.9,close:10,volume:100}))}};}

test('research periods are disjoint and candidate selection never reads test results',()=>{
 const p=splitPeriods(0,14*86400);assert.equal(p.train.end,p.validation.start);assert.equal(p.validation.end,p.test.start);assert.equal(p.test.end,14*86400);
 const base={orders:30,closedTrades:15,netChange:1,maxDrawdownPct:2,openPositions:0};
 const rows=[{id:'a',train:{...base,netChange:2},validation:base},{id:'b',train:{...base,netChange:100},validation:{...base,netChange:-1}}];
 Object.defineProperty(rows[0],'test',{get(){throw new Error('holdout leak');}});
 assert.equal(chooseCandidate(rows),'a');
 assert.equal(qualifyCandidate(base,{...base,netChange:-1},base).passed,false);
 assert.equal(qualifyCandidate(base,base,{...base,closedTrades:1}).passed,false);
});

test('replay hides current/future candle information and charges commissions on flat prices',async()=>{
 const data=dataset();let latest=-1;
 const decisionFn=rows=>{latest=rows.at(-1).start;return {enter:true,reason:'fixture'};};
 const r=await replayDataset(data,settings(),{start:data.start,end:data.end,decisionFn,onTick:({at})=>assert.ok(latest<at/1000)});
 assert.ok(r.orders>0);assert.ok(Number(r.fees)>0);assert.ok(r.netChange<0);assert.equal(r.openPositions,0);
 assert.ok(r.maxDrawdownPct>0);assert.equal(r.closedTrades,r.sells);
 const altered=structuredClone(data);for(const row of altered.bars['TEST-USDC'])if(row.start>=data.end-600)row.close=1000;
 const early={start:data.start,end:data.end-600,decisionFn};
 const a=await replayDataset(data,settings(),early),b=await replayDataset(altered,settings(),early);
 assert.ok(a.orders>0);assert.equal(a.endEquity,b.endEquity);assert.deepEqual(a.events,b.events);
});

test('incomplete cache is ignored and explicit dataset changes cannot silently reuse old data',()=>{
 const dir=mkdtempSync(join(tmpdir(),'cb-cache-'));
 try{const path=join(dir,'result.json');atomicJson(path,{okay:true});assert.deepEqual(readJsonCache(path),{okay:true});writeFileSync(path,'{"partial":');assert.equal(readJsonCache(path),null);atomicJson(path,{recovered:true});assert.deepEqual(readJsonCache(path),{recovered:true});assert.equal(readJsonCache(join(dir,'absent')),null);
  const data=dataset();assert.throws(()=>assertDatasetOptions(data,{end:String(data.end+60)}),/DATASET_OPTIONS_MISMATCH/);assert.throws(()=>assertDatasetOptions(data,{days:'14'}),/DATASET_OPTIONS_MISMATCH/);assertDatasetOptions(data,{end:String(data.end),products:'1'});
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('collector resumes cached chunks without repeated API calls and records missing bars',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cb-research-'));let calls=0;
 const api={products:async()=>[product],fees:async()=>({fee_tier:{taker_fee_rate:'0.012'}}),candles:async(id,start,end)=>{calls++;return {candles:[{start:String(start),open:'10',high:'10',low:'10',close:'10',volume:'1'}]};}};
 try{const opts={days:2,count:1,end:10*86400,cacheDir:dir};const a=await collectDataset(api,settings(),opts);const before=calls;const b=await collectDataset(api,settings(),opts);assert.equal(calls,before);assert.equal(a.fingerprint,b.fingerprint);assert.ok(a.coverage[0].fraction<0.01);}finally{rmSync(dir,{recursive:true,force:true});}
});
