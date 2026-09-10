import test from 'node:test';
import assert from 'node:assert/strict';
import {exportSignals} from '../src/cb/external-export.mjs';

function fixture(){return {start:3600,end:10800,feeRate:'0.012',products:[{product_id:'TEST-USDC',base_increment:'0.001'}],bars:{'TEST-USDC':Array.from({length:180},(_,i)=>{const close=10+i*.02;return {start:i*60,open:close,high:close*1.002,low:close*.999,close,volume:100};})}};}
test('external signal export hides future candles from the actual strategy',()=>{
 const a=fixture(),b=structuredClone(a);for(const r of b.bars['TEST-USDC'])if(r.start>=7200){r.open=20;r.high=21;r.low=19;r.close=20;}
 const x=exportSignals(a,{candidateIds:['baseline'],products:['TEST-USDC']}),y=exportSignals(b,{candidateIds:['baseline'],products:['TEST-USDC']});
 assert.deepEqual(x.markets[0].rows.filter(r=>r.start<7200),y.markets[0].rows.filter(r=>r.start<7200));
 assert.ok(x.markets[0].rows.every(r=>r.decisionAt===r.start+60));
 assert.ok(x.markets[0].rows.filter(r=>r.decisionAt<3600).every(r=>r.entries.baseline===false));
 assert.ok(x.markets[0].rows.some(r=>r.start<7200&&r.entries.baseline));
 assert.notEqual(x.inputSha256,y.inputSha256);
});
test('external export refuses missing bars and unknown strategies instead of filling gaps',()=>{
 const a=fixture();a.bars['TEST-USDC'].splice(80,1);
 assert.throws(()=>exportSignals(a,{candidateIds:['baseline'],products:['TEST-USDC']}),/INCOMPLETE_EXTERNAL_CANDLES/);
 assert.throws(()=>exportSignals(fixture(),{candidateIds:['bogus'],products:['TEST-USDC']}),/UNKNOWN_EXTERNAL_STRATEGY/);
});
