import test from 'node:test';import assert from 'node:assert/strict';
import {CoinbaseEngine,entryBlock,equity} from '../src/cb/engine.mjs';
import {initialLedger} from '../src/cb/execution.mjs';import {settings} from '../src/cb/config.mjs';
const c=settings();
function fixture(){
 let s=initialLedger(c,'paper',1000000),command=null,now=1000000,price=10;const events=[];
 const db={read:()=>structuredClone(s),save:(state,e=[])=>{s=structuredClone(state);events.push(...e);},getCommand:()=>command};
 const p={product_id:'TEST-USDC',base_currency_id:'TEST',quote_currency_id:'USDC',product_type:'SPOT',status:'online',base_increment:'0.001',price_increment:'0.001',base_min_size:'0.001',base_max_size:'1000000',quote_min_size:'1',quote_max_size:'1000000',approximate_quote_24h_volume:'10000000'};
 const market={fee:async()=> '0.012',discover:async()=>[p],product:async()=>p,candles:async()=>[],book:async()=>({id:p.product_id,at:now,spreadBps:10,bids:[{price:String(price-0.001),size:'1000'}],asks:[{price:String(price),size:'1000'}]})};
 const engine=new CoinbaseEngine(db,c,market,{now:()=>now,decisionFn:()=>({enter:true,reason:'fixture'})});
 return {db,market,engine,events,setPrice:x=>{price=x;},setCommand:x=>{command=x;},advance:()=>{now+=60000;}};
}
test('paper lifecycle charges fees, manages exits before discovery and never calls live submission',async()=>{
 const x=fixture();await x.engine.tick();assert.equal(x.db.read().buys,1);assert.ok(Number(x.db.read().cash)>=15);
 x.advance();x.setPrice(12);x.market.discover=async()=>{throw new Error('DISCOVERY_DOWN');};await x.engine.tick();
 const s=x.db.read();assert.equal(s.sells,1);assert.equal(Object.keys(s.positions).length,0);assert.ok(Number(s.realized)>0);assert.ok(Number(s.fees)>0);
});
test('pause prevents entries while flatten sells owned positions',async()=>{
 const x=fixture();x.setCommand('pause');await x.engine.tick();assert.equal(x.db.read().buys,0);
 x.setCommand(null);await x.engine.tick();x.advance();x.setCommand('flatten');await x.engine.tick();assert.equal(x.db.read().sells,1);assert.equal(x.db.read().buys,1);
});
test('daily and account limits stop entries and unknown valuations never count as profit',()=>{
 const s=initialLedger(c,'paper');s.daily.orders=200;assert.equal(entryBlock(s,c,null,Date.now()),'DAILY_ORDER_LIMIT');
 s.daily.orders=0;s.cash='17';assert.equal(entryBlock(s,c,null,Date.now()),'DAILY_LOSS_LIMIT');
 s.cash='20';s.positions.x={quantity:'1',cost:'5',value:null};assert.equal(entryBlock(s,c,null,Date.now()),'UNPRICED_POSITION');assert.equal(equity(s),'20');
});
test('unavailable exit leaves a real open position and blocks subsequent purchases',async()=>{
 const x=fixture();await x.engine.tick();x.advance();x.market.book=async()=>{throw new Error('BOOK_DOWN');};await x.engine.tick();
 assert.equal(x.db.read().buys,1);assert.equal(x.db.read().positions['TEST-USDC'].value,null);assert.equal(x.db.read().sells,0);
});

test('fee refresh failure still manages a requested flatten exit',async()=>{
 const x=fixture();await x.engine.tick();x.advance();x.setCommand('flatten');x.market.fee=async()=>{throw new Error('FEE_DOWN');};await x.engine.tick();
 assert.equal(x.db.read().sells,1);assert.equal(x.db.read().lastError,'FEE_DOWN');
});

test('intent freshness is checked after asynchronous account validation',async()=>{
 const x=fixture();const intent={product:'TEST-USDC',side:'BUY',maxCost:'5',createdAt:1000000};
 x.engine.live={verify:async()=>x.advance()};assert.equal(await x.engine.guard(intent),false);
});

test('unrelated account reconciliation halt permits an owned protective exit',async()=>{
 const x=fixture();await x.engine.tick();const s=x.db.read();s.paused='ACCOUNT_RECONCILIATION_REQUIRED';x.db.save(s);
 let checked=false;x.engine.live={verify:async()=>{throw new Error('MISMATCH');},verifyExit:async()=>{checked=true;}};
 assert.equal(await x.engine.guard({product:'TEST-USDC',side:'SELL',quantity:s.positions['TEST-USDC'].quantity,createdAt:1000000}),true);assert.equal(checked,true);
});

test('midnight does not omit an unpriced filled position from the daily baseline',async()=>{
 const x=fixture();await x.engine.tick();const s=x.db.read();s.daily.date='1969-12-31';s.daily.orders=200;x.db.save(s);
 x.setCommand('flatten');await x.engine.tick();const after=x.db.read();
 assert.equal(after.daily.startEquity,'20');assert.equal(after.daily.orders,1);
});
