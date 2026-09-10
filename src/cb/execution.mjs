import {randomUUID} from 'node:crypto';
import {d,f,mul,div,ceilStep,abs} from './decimal.mjs';
import {configHash} from '../config.mjs';
export function initialLedger(c,mode,now=Date.now()){
  return {kind:'coinbase-v1',mode,configHash:configHash(c),startedAt:now,cash:String(c.activeUsd),peak:String(c.activeUsd),realized:'0',fees:'0',positions:{},cooldown:{},pending:null,paused:null,expected:null,accountIds:null,scans:0,buys:0,sells:0,orders:0,daily:{date:new Date(now).toISOString().slice(0,10),startEquity:String(c.activeUsd),orders:0},lastTick:null,lastError:null,decisions:[]};
}
export function rolloverDay(s,c,now){
  const date=new Date(now).toISOString().slice(0,10);if(s.daily.date===date)return;
  // Missing/stale marks cannot erase a holding from the new day's loss baseline.
  const baseline=d(s.cash)+Object.values(s.positions).reduce((sum,p)=>{
    const mark=p.value===null?null:d(p.value),cost=d(p.cost);
    const fresh=mark!==null&&Number.isFinite(p.valuedAt)&&now-p.valuedAt<=Math.max(60000,c.pollSeconds*3000);
    return sum+(fresh?mark:mark!==null&&mark>cost?mark:cost);
  },0n);
  s.daily={date,startEquity:f(baseline),orders:0};
}
export function accountTotals(rows){
  if(!Array.isArray(rows))throw new Error('INVALID_ACCOUNTS');const totals={};
  for(const row of rows){const total=d(row.available_balance?.value)+d(row.hold?.value??'0');if(total<0n||!/^[A-Z0-9]+$/.test(row.currency))throw new Error('INVALID_BALANCE');totals[row.currency]=f(d(totals[row.currency]??'0')+total);}
  return totals;
}
export function sameBalances(expected,actual){
  return [...new Set([...Object.keys(expected),...Object.keys(actual)])].every(k=>abs(d(expected[k]??'0')-d(actual[k]??'0'))<=d('0.00000001'));
}
export function applyFill(s,intent,fill,now){
  const q=d(fill.quantity),v=d(fill.value),fee=d(fill.fee);if(q<0n||v<0n||fee<0n||(q===0n&&v!==0n)||(q>0n&&v===0n))throw new Error('INVALID_FILL');
  if(q===0n){if(fee>0n){s.cash=f(d(s.cash)-fee);s.realized=f(d(s.realized)-fee);s.fees=f(d(s.fees)+fee);}return;}
  if(intent.side==='BUY'){
    const old=s.positions[intent.product];if(old)throw new Error('DUPLICATE_POSITION');
    const cost=v+fee;s.cash=f(d(s.cash)-cost);s.buys++;
    s.positions[intent.product]={product:intent.product,base:intent.base,quantity:f(q),cost:f(cost),openedAt:now,highValue:'0',value:null,valuedAt:0};
  }else{
    const p=s.positions[intent.product];if(!p||q>d(p.quantity))throw new Error('UNOWNED_QUANTITY');
    const allocated=d(p.cost)*q/d(p.quantity),net=v-fee;
    s.cash=f(d(s.cash)+net);s.realized=f(d(s.realized)+net-allocated);s.sells++;
    if(q===d(p.quantity))delete s.positions[intent.product];
    else{p.quantity=f(d(p.quantity)-q);p.cost=f(d(p.cost)-allocated);p.value=null;p.valuedAt=0;p.highValue='0';}
  }
  s.fees=f(d(s.fees)+fee);
}
export function paperFill(intent){
  const value=mul(d(intent.quantity),d(intent.paperPrice));const fee=ceilStep(mul(value,d(intent.feeRate)),d('0.00000001'));
  return {quantity:intent.quantity,value:f(value),fee:f(fee)};
}
export class LiveExecution {
  constructor(api,db,c){this.api=api;this.db=db;this.c=c;}
  async initialize(){
    const permissions=await this.api.permissions();if(!permissions.can_view||!permissions.can_trade||permissions.can_transfer)throw new Error('COINBASE_PERMISSIONS_NOT_ALLOWED');
    let s=this.db.read();if(s.pending){await this.reconcile();s=this.db.read();if(s.pending)return;}
    const rows=await this.api.accounts(),totals=accountTotals(rows);
    const ids=rows.map(a=>a.uuid).sort();
    if(s.expected){if(!sameBalances(s.expected,totals)){s.paused='ACCOUNT_RECONCILIATION_REQUIRED';this.db.save(s,[]);}}
    else{
      if(rows.some(a=>d(a.hold?.value??'0')>0n))throw new Error('EXISTING_ACCOUNT_HOLDS');
      if(d(totals[this.c.quote]??'0')<d(String(this.c.activeUsd)))throw new Error('INSUFFICIENT_USDC');
      const orders=await this.api.orders({order_status:'OPEN'});if(orders.length)throw new Error('EXISTING_OPEN_ORDERS');
      s.expected=totals;s.baseline=totals;s.accountIds=ids;this.db.save(s,[{type:'coinbase_account_initialized',at:Date.now()}]);
    }
  }
  async verify(){
    const s=this.db.read();if(!s.expected||s.pending)throw new Error('ACCOUNT_NOT_READY');
    const rows=await this.api.accounts();if(!sameBalances(s.expected,accountTotals(rows))||rows.some(a=>d(a.hold?.value??'0')>0n))throw new Error('ACCOUNT_BALANCE_MISMATCH');
    return rows;
  }
  async verifyExit(intent){
    const s=this.db.read();if(!s.baseline||s.pending)throw new Error('ACCOUNT_NOT_READY');
    const rows=await this.api.accounts();const available=rows.filter(a=>a.currency===intent.base).reduce((n,a)=>n+d(a.available_balance.value),0n);
    if(available<d(s.baseline[intent.base]??'0')+d(intent.quantity))throw new Error('OWNED_EXIT_BALANCE_UNAVAILABLE');
  }
  async trade(intent,guard){
    if(this.db.read().pending)throw new Error('PENDING_ORDER');
    const preview=await this.api.preview(intent.body);
    if(!Array.isArray(preview.errs)||preview.errs.length||!preview.preview_id||d(String(preview.base_size))!==d(intent.quantity)||d(preview.commission_total)<0n)throw new Error('ORDER_PREVIEW_REJECTED');
    if(intent.side==='BUY'&&(d(preview.order_total)>d(intent.maxCost)||d(preview.order_total)>d(String(this.c.positionUsd))))throw new Error('PREVIEW_EXCEEDS_BUDGET');
    if(Date.now()-intent.createdAt>this.c.maxBookAgeSeconds*1000)throw new Error('STALE_ORDER_INTENT');
    if(!await guard())return;
    const s=this.db.read();if(s.pending)throw new Error('PENDING_ORDER');
    rolloverDay(s,this.c,Date.now());const id=randomUUID();s.pending={id,orderId:null,intent,createdAt:Date.now(),submitted:true};s.orders++;s.daily.orders++;
    this.db.save(s,[{type:'order_intent',at:Date.now(),id,product:intent.product,side:intent.side,quantity:intent.quantity}]);
    try{
      const r=await this.api.submit({...intent.body,client_order_id:id,preview_id:preview.preview_id});
      const current=this.db.read();
      if(r.success===true&&typeof r.success_response?.order_id==='string')current.pending.orderId=r.success_response.order_id;
      else if(r.success===false&&r.error_response){current.pending=null;current.lastError='ORDER_REJECTED';current.cooldown[intent.product]=Date.now()+this.c.cooldownMinutes*60000;if(intent.side==='SELL'&&current.positions[intent.product])current.positions[intent.product].retryAfter=Date.now()+60000;}
      else throw new Error('AMBIGUOUS_SUBMISSION');
      this.db.save(current,[{type:current.pending?'order_submitted':'order_rejected',at:Date.now(),id}]);
    }catch{const current=this.db.read();current.lastError='ORDER_SUBMISSION_UNCERTAIN';this.db.save(current,[{type:'order_uncertain',at:Date.now(),id}]);}
  }
  async reconcile(){
    const s=this.db.read(),pending=s.pending;if(!pending)return;
    if(!pending.orderId){
      const orders=await this.api.orders({start_date:new Date(pending.createdAt-60000).toISOString()});
      const found=orders.filter(o=>o.client_order_id===pending.id);if(found.length>1)throw new Error('DUPLICATE_CLIENT_ORDER');
      if(found.length===1){pending.orderId=found[0].order_id;this.db.save(s,[]);}else{if(Date.now()-pending.createdAt>this.c.maxPendingSeconds*1000){s.lastError='UNRESOLVED_ORDER_REVIEW_REQUIRED';this.db.save(s,[]);}return;}
    }
    const order=await this.api.order(pending.orderId),intent=pending.intent;
    if(!order||order.client_order_id!==pending.id||order.product_id!==intent.product||order.side!==intent.side)throw new Error('ORDER_IDENTITY_MISMATCH');
    if(!['FILLED','CANCELLED','EXPIRED','FAILED'].includes(order.status)||order.settled!==true)return;
    const fill={quantity:order.filled_size,value:order.filled_value,fee:order.total_fees};
    if(d(fill.quantity)>d(intent.quantity)||d(fill.quantity)<0n||d(fill.fee)<0n||d(fill.value)<0n)throw new Error('INVALID_SETTLED_FILL');
    if(d(fill.quantity)>0n){const avg=div(d(fill.value),d(fill.quantity));if(intent.side==='BUY'?avg>d(intent.limit)+d('0.00000001'):avg<d(intent.limit)-d('0.00000001'))throw new Error('FILL_OUTSIDE_LIMIT');}
    const expected={...s.expected};const debit=d(fill.value)+d(fill.fee),credit=d(fill.value)-d(fill.fee);
    expected[this.c.quote]=f(d(expected[this.c.quote]??'0')+(intent.side==='BUY'?-debit:credit));
    expected[intent.base]=f(d(expected[intent.base]??'0')+(intent.side==='BUY'?d(fill.quantity):-d(fill.quantity)));
    let matched=false,balanceError='SETTLEMENT_BALANCE_MISMATCH';
    try{matched=sameBalances(expected,accountTotals(await this.api.accounts()));}catch{balanceError='SETTLEMENT_BALANCE_UNAVAILABLE';}
    rolloverDay(s,this.c,Date.now());
    applyFill(s,intent,fill,Number.isFinite(Date.parse(order.last_fill_time))?Date.parse(order.last_fill_time):pending.createdAt);
    if(intent.side==='SELL'&&d(fill.quantity)===0n&&s.positions[intent.product])s.positions[intent.product].retryAfter=Date.now()+60000;
    s.expected=expected;s.pending=null;s.lastError=matched?null:balanceError;s.cooldown[intent.product]=Date.now()+this.c.cooldownMinutes*60000;
    if(!matched)s.paused='ACCOUNT_RECONCILIATION_REQUIRED';
    if(intent.side==='BUY'&&(debit>d(intent.maxCost)||d(s.cash)<0n))s.paused='ORDER_COST_LIMIT_BREACH';
    this.db.save(s,[{type:'order_settled',at:Date.now(),id:pending.id,orderId:pending.orderId,product:intent.product,side:intent.side,...fill}]);
  }
  async recover(){
    // Explicit read-only recovery works even when the durable operator control is stop.
    await this.reconcile();const s=this.db.read();if(s.pending)return;
    await this.verify();
    if(s.paused==='ACCOUNT_RECONCILIATION_REQUIRED'){s.paused=null;s.lastError=null;this.db.save(s,[{type:'account_reconciled',at:Date.now()}]);}
  }
}
