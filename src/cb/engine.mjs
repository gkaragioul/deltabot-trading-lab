import {d,f,mul,UNIT,min} from './decimal.mjs';
import {buildIntent,signal,eligible} from './market.mjs';
import {applyFill,paperFill,rolloverDay} from './execution.mjs';
export const cleanError=e=>/^[A-Z0-9_]+$/.test(String(e?.message))?e.message:'PROVIDER_ERROR';
export function equity(s){return f(d(s.cash)+Object.values(s.positions).reduce((sum,p)=>sum+d(p.value??'0'),0n));}
export function entryBlock(s,c,command,now){
  if(command)return 'OPERATOR_'+command.toUpperCase();if(s.pending)return 'PENDING_ORDER';if(s.paused)return s.paused;
  if(Object.values(s.positions).some(p=>p.value===null||!Number.isFinite(p.valuedAt)||now-p.valuedAt>Math.max(60000,c.pollSeconds*3000)))return 'UNPRICED_POSITION';
  const value=d(equity(s));if(d(s.peak)-value>=d(String(c.maxDrawdownUsd)))return 'DRAWDOWN_LIMIT';
  if(s.daily.halted||d(s.daily.startEquity)-value>=d(String(c.maxDailyLossUsd)))return 'DAILY_LOSS_LIMIT';
  if(s.daily.orders>=c.maxOrdersPerDay)return 'DAILY_ORDER_LIMIT';
  if(Object.keys(s.positions).length>=c.maxPositions)return 'POSITION_LIMIT';
  if(d(s.cash)<d(String(c.positionUsd)))return 'CASH_LIMIT';
  if(Object.values(s.positions).reduce((sum,p)=>sum+d(p.cost),0n)+d(String(c.positionUsd))>d(String(c.activeUsd)))return 'EXPOSURE_LIMIT';
  return null;
}
function exitReason(p,value,c,now){
  const cost=d(p.cost),v=d(value);
  if(v<=mul(cost,UNIT-d(String(c.stopLossPct/100))))return 'STOP_LOSS';
  if(v>=mul(cost,UNIT+d(String(c.takeProfitPct/100))))return 'TAKE_PROFIT';
  if(d(p.highValue)>cost&&v<=mul(d(p.highValue),UNIT-d(String(c.trailingStopPct/100))))return 'TRAILING_STOP';
  if(now-p.openedAt>=c.maxHoldMinutes*60000)return 'TIME_EXIT';return null;
}
export class CoinbaseEngine {
  constructor(db,c,markets,{live=null,now=Date.now,decisionFn=signal}={}){this.db=db;this.c=c;this.markets=markets;this.live=live;this.now=now;this.decisionFn=decisionFn;}
  saveDecision(product,reason){const s=this.db.read();s.decisions.push({product,reason});this.db.save(s,[]);}
  async guard(intent){
    let s=this.db.read();const command=this.db.getCommand();
    if(command==='stop'||s.pending||this.now()-intent.createdAt>this.c.maxBookAgeSeconds*1000)return false;
    if(intent.side==='BUY'&&(entryBlock(s,this.c,command,this.now())||s.positions[intent.product]||d(intent.maxCost)>min(d(s.cash),d(String(this.c.positionUsd)))))return false;
    if(intent.side==='SELL'&&(!s.positions[intent.product]||d(intent.quantity)>d(s.positions[intent.product].quantity)))return false;
    if(this.live){if(intent.side==='SELL')await this.live.verifyExit(intent);else await this.live.verify();}
    // Operator input can arrive during the account read.
    s=this.db.read();return this.now()-intent.createdAt<=this.c.maxBookAgeSeconds*1000&&this.db.getCommand()!=='stop'&&!s.pending&&(intent.side==='SELL'||!entryBlock(s,this.c,this.db.getCommand(),this.now()));
  }
  async trade(intent,reason){
    if(this.live){await this.live.trade(intent,()=>this.guard(intent));return;}
    if(!await this.guard(intent))return;
    const s=this.db.read(),fill=paperFill(intent);
    rolloverDay(s,this.c,this.now());applyFill(s,intent,fill,this.now());s.orders++;s.daily.orders++;s.cooldown[intent.product]=this.now()+this.c.cooldownMinutes*60000;
    this.db.save(s,[{type:'paper_fill',at:this.now(),product:intent.product,side:intent.side,reason,...fill}]);
  }
  async tick(){
    let s=this.db.read();rolloverDay(s,this.c,this.now());s.decisions=[];s.lastError=null;s.scans++;s.lastTick=this.now();this.db.save(s,[]);
    if(this.live){await this.live.reconcile();s=this.db.read();if(s.pending)return s;}
    let fee,feeError;try{fee=await this.markets.fee(this.now());s=this.db.read();s.feeRate=fee;this.db.save(s,[]);}catch(e){fee='0.05';feeError=cleanError(e);}
    s=this.db.read();rolloverDay(s,this.c,this.now());this.db.save(s,[]);
    // Exits are processed independently of discovery and entry eligibility.
    for(const id of Object.keys(this.db.read().positions)){
      try{
        const product=await this.markets.product(id);const book=await this.markets.book(id,this.now());s=this.db.read();const p=s.positions[id];if(!p)continue;
        const intent=buildIntent(product,book,'SELL',p.quantity,fee,this.c);const fill=paperFill(intent);const value=f(d(fill.value)-d(fill.fee));
        p.value=value;p.valuedAt=this.now();if(d(value)>d(p.highValue))p.highValue=value;this.db.save(s,[]);
        const why=this.db.getCommand()==='flatten'?'FLATTEN':exitReason(p,value,this.c,this.now());
        if(why&&(p.retryAfter??0)<=this.now()){await this.trade(intent,why);if(this.db.read().pending)return this.db.read();}
      }catch(e){s=this.db.read();if(s.positions[id])s.positions[id].value=null;s.lastError=cleanError(e);this.db.save(s,[{type:'exit_unavailable',at:this.now(),product:id,error:s.lastError}]);}
    }
    s=this.db.read();const now=this.now(),date=new Date(now).toISOString().slice(0,10),valued=Object.values(s.positions).every(p=>p.value!==null);
    if(valued){
      const value=equity(s);if(d(value)>d(s.peak))s.peak=value;
      rolloverDay(s,this.c,now);
      if(d(s.peak)-d(value)>=d(String(this.c.maxDrawdownUsd)))s.paused='DRAWDOWN_LIMIT';
      if(d(s.daily.startEquity)-d(value)>=d(String(this.c.maxDailyLossUsd)))s.daily.halted=true;
    }
    this.db.save(s,[]);
    if(feeError){s=this.db.read();s.lastError=feeError;this.db.save(s,[{type:'fee_data_unavailable',at:this.now(),error:feeError}]);return s;}
    if(this.live){try{await this.live.verify();}catch(e){s=this.db.read();s.paused='ACCOUNT_RECONCILIATION_REQUIRED';s.lastError=cleanError(e);this.db.save(s,[]);return s;}}
    const blocked=entryBlock(this.db.read(),this.c,this.db.getCommand(),now);
    if(blocked){this.saveDecision('ALL',blocked);return this.db.read();}
    let products;
    try{products=await this.markets.discover(now);}catch(e){s=this.db.read();s.lastError=cleanError(e);this.db.save(s,[{type:'discovery_error',at:now,error:s.lastError}]);return s;}
    for(const product of products){
      const id=product.product_id;s=this.db.read();if(entryBlock(s,this.c,this.db.getCommand(),this.now()))break;
      if(!eligible(product,this.c)){this.saveDecision(id,'PRODUCT_INELIGIBLE');continue;}
      if(s.positions[id]||(s.cooldown[id]??0)>this.now()){this.saveDecision(id,'OWNED_OR_COOLDOWN');continue;}
      try{
        const decision=this.decisionFn(await this.markets.candles(id,this.now()),this.c);if(!decision.enter){this.saveDecision(id,decision.reason);continue;}
        const book=await this.markets.book(id,this.now());if(book.spreadBps>this.c.maxSpreadBps){this.saveDecision(id,'SPREAD_TOO_WIDE');continue;}
        const intent=buildIntent(product,book,'BUY',String(this.c.positionUsd),fee,this.c);
        const buy=paperFill(intent),sell=paperFill(buildIntent(product,book,'SELL',intent.quantity,fee,this.c));
        const cost=d(buy.value)+d(buy.fee),net=d(sell.value)-d(sell.fee);
        const roundTrip=Number(cost-net)/Number(cost)*100;
        if(roundTrip>this.c.maxRoundTripCostPct){this.saveDecision(id,'ROUND_TRIP_COST_TOO_HIGH');continue;}
        this.saveDecision(id,decision.reason);await this.trade(intent,decision.reason);
        if(this.db.read().pending)break;
      }catch(e){s=this.db.read();s.lastError=cleanError(e);this.db.save(s,[{type:'candidate_error',at:this.now(),product:id,error:s.lastError}]);this.saveDecision(id,cleanError(e));}
    }
    return this.db.read();
  }
}
