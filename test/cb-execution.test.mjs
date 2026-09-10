import test from 'node:test';import assert from 'node:assert/strict';
import {LiveExecution,applyFill,initialLedger,accountTotals} from '../src/cb/execution.mjs';
import {settings} from '../src/cb/config.mjs';
const c=settings();const intent={product:'TEST-USDC',base:'TEST',side:'BUY',quantity:'0.5',limit:'10',maxCost:'5',feeRate:'0.012',createdAt:Date.now(),body:{product_id:'TEST-USDC',side:'BUY',order_configuration:{sor_limit_ioc:{base_size:'0.5',limit_price:'10'}}}};
function store(){let state=initialLedger(c,'live');return {read:()=>structuredClone(state),save:s=>{state=structuredClone(s);},getCommand:()=>null};}
test('partial fills preserve exact owned quantity, costs and remaining cost basis',()=>{
 const s=initialLedger(c,'paper');applyFill(s,intent,{quantity:'0.3',value:'3',fee:'0.036'},1);
 assert.equal(s.cash,'16.964');assert.equal(s.positions['TEST-USDC'].quantity,'0.3');
 applyFill(s,{...intent,side:'SELL'},{quantity:'0.1',value:'1.2',fee:'0.0144'},2);
 assert.equal(s.positions['TEST-USDC'].quantity,'0.2');assert.equal(s.positions['TEST-USDC'].cost,'2.024');assert.equal(s.realized,'0.1736');
 assert.throws(()=>applyFill(s,{...intent,side:'SELL'},{quantity:'0.3',value:'3',fee:'0'},3),/UNOWNED_QUANTITY/);
});
test('uncertain submission is journaled first and never submitted a second time on restart',async()=>{
 const db=store();let submits=0;
 const api={preview:async()=>({errs:[],preview_id:'p',base_size:'0.5',commission_total:'0.05',order_total:'4.95'}),submit:async()=>{submits++;assert.ok(db.read().pending);throw new Error('COINBASE_NETWORK_UNAVAILABLE');},orders:async()=>[]};
 const broker=new LiveExecution(api,db,c);await broker.trade(intent,async()=>true);
 assert.equal(submits,1);assert.ok(db.read().pending);
 const restarted=new LiveExecution(api,db,c);await restarted.reconcile();
 await assert.rejects(restarted.trade(intent,async()=>true),/PENDING_ORDER/);assert.equal(submits,1);
});
test('operator pause during preview prevents submission',async()=>{
 const db=store();let submits=0;
 const api={preview:async()=>({errs:[],preview_id:'p',base_size:'0.5',commission_total:'0.05',order_total:'4.95'}),submit:async()=>{submits++;}};
 await new LiveExecution(api,db,c).trade(intent,async()=>false);assert.equal(submits,0);assert.equal(db.read().pending,null);
});
test('account totals include holds without treating them as spendable cash',()=>{
 assert.deepEqual(accountTotals([{currency:'USDC',available_balance:{value:'40'},hold:{value:'10'}}]),{USDC:'50'});
});

test('a confirmed fill is recorded once despite an unrelated deposit and preserves an exit position',async()=>{
 const db=store();const s=db.read();s.expected={USDC:'50',TEST:'2',OTHER:'0'};s.baseline={...s.expected};s.pending={id:'client',orderId:'order',intent,createdAt:Date.now()};db.save(s);
 const account=(currency,value)=>({currency,available_balance:{value},hold:{value:'0'}});
 const api={order:async()=>({client_order_id:'client',product_id:intent.product,side:'BUY',status:'FILLED',settled:true,filled_size:'0.3',filled_value:'3',total_fees:'0.036'}),accounts:async()=>[account('USDC','46.964'),account('TEST','2.3'),account('OTHER','1')]};
 const broker=new LiveExecution(api,db,c);await broker.reconcile();await broker.reconcile();
 assert.equal(db.read().buys,1);assert.equal(db.read().pending,null);assert.equal(db.read().positions[intent.product].quantity,'0.3');assert.equal(db.read().paused,'ACCOUNT_RECONCILIATION_REQUIRED');
 await broker.verifyExit({...intent,side:'SELL',quantity:'0.3'});
 api.accounts=async()=>[account('TEST','2.1')];await assert.rejects(broker.verifyExit({...intent,side:'SELL',quantity:'0.3'}),/OWNED_EXIT_BALANCE_UNAVAILABLE/);
});

test('a definitive settled fill survives an unavailable account endpoint',async()=>{
 const db=store(),s=db.read();s.expected={USDC:'50',TEST:'0'};s.baseline={...s.expected};s.pending={id:'client',orderId:'order',intent,createdAt:Date.now()};db.save(s);
 const api={order:async()=>({client_order_id:'client',product_id:intent.product,side:'BUY',status:'FILLED',settled:true,filled_size:'0.3',filled_value:'3',total_fees:'0.036'}),accounts:async()=>{throw new Error('COINBASE_NETWORK_UNAVAILABLE');}};
 await new LiveExecution(api,db,c).reconcile();
 assert.equal(db.read().pending,null);assert.equal(db.read().positions[intent.product].quantity,'0.3');assert.equal(db.read().paused,'ACCOUNT_RECONCILIATION_REQUIRED');
 assert.equal(db.read().lastError,'SETTLEMENT_BALANCE_UNAVAILABLE');
});

test('explicitly rejected exits are throttled without forgetting the owned position',async()=>{
 const db=store(),s=db.read();applyFill(s,intent,{quantity:'0.5',value:'4.9',fee:'0.05'},Date.now());db.save(s);
 const api={preview:async()=>({errs:[],preview_id:'p',base_size:'0.5',commission_total:'0.05',order_total:'4.95'}),submit:async()=>({success:false,error_response:{}})};
 await new LiveExecution(api,db,c).trade({...intent,side:'SELL',createdAt:Date.now()},async()=>true);
 assert.equal(db.read().pending,null);assert.ok(db.read().positions[intent.product].retryAfter>Date.now()+50000);
});

test('a new-day settled sale retains its loss in the daily baseline',async()=>{
 const db=store(),s=db.read(),now=Date.now();s.daily.date=new Date(now-86400000).toISOString().slice(0,10);
 s.cash='15';s.positions[intent.product]={quantity:'1',cost:'5',value:'5',valuedAt:now,highValue:'5'};
 s.expected={USDC:'45',TEST:'1'};s.baseline={USDC:'50',TEST:'0'};
 s.pending={id:'client',orderId:'order',intent:{...intent,side:'SELL',quantity:'1',limit:'3'},createdAt:now};db.save(s);
 const api={order:async()=>({client_order_id:'client',product_id:intent.product,side:'SELL',status:'FILLED',settled:true,filled_size:'1',filled_value:'3',total_fees:'0'}),accounts:async()=>[{currency:'USDC',available_balance:{value:'48'}},{currency:'TEST',available_balance:{value:'0'}}]};
 await new LiveExecution(api,db,c).reconcile();assert.equal(db.read().daily.date,new Date(now).toISOString().slice(0,10));assert.equal(db.read().daily.startEquity,'20');assert.equal(db.read().cash,'18');
});

test('explicit recovery reconciles a stopped ledger without enabling or submitting orders',async()=>{
 const db=store(),s=db.read();s.expected={USDC:'50',TEST:'0'};s.baseline={...s.expected};s.paused='ACCOUNT_RECONCILIATION_REQUIRED';
 s.pending={id:'client',orderId:'order',intent,createdAt:Date.now()};db.save(s);db.getCommand=()=> 'stop';
 const api={order:async()=>({client_order_id:'client',product_id:intent.product,side:'BUY',status:'FILLED',settled:true,filled_size:'0.3',filled_value:'3',total_fees:'0.036'}),accounts:async()=>[{currency:'USDC',available_balance:{value:'46.964'}},{currency:'TEST',available_balance:{value:'0.3'}}],submit:()=>assert.fail('recovery must not submit')};
 await new LiveExecution(api,db,c).recover();assert.equal(db.read().pending,null);assert.equal(db.read().paused,null);assert.equal(db.read().buys,1);assert.equal(db.getCommand(),'stop');
});
