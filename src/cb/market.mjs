import {d,f,mul,div,floorStep,ceilStep,UNIT} from './decimal.mjs';
export function eligible(p,c){
  return p?.product_type==='SPOT' && p.quote_currency_id===c.quote && /^[A-Z0-9]+-USDC$/.test(p.product_id) &&
    p.status==='online' && !['is_disabled','trading_disabled','cancel_only','limit_only','post_only','auction_mode','view_only'].some(k=>p[k]) &&
    Number(p.approximate_quote_24h_volume)>=c.minVolumeUsd;
}
export function normalizeBook(raw,id,now,c){
  const b=raw?.pricebook;const at=Date.parse(b?.time);
  if(!Number.isFinite(at)||now-at>c.maxBookAgeSeconds*1000||at>now+2000)throw new Error('STALE_BOOK');
  if(b.product_id!==id)throw new Error('BOOK_PRODUCT_MISMATCH');
  for(const side of ['bids','asks']){
    if(!Array.isArray(b[side])||!b[side].length)throw new Error('EMPTY_BOOK');
    let previous;
    for(const row of b[side]){
      const price=d(row.price);if(price<=0n||d(row.size)<=0n)throw new Error('INVALID_BOOK');
      if(previous!==undefined && (side==='bids'?price>previous:price<previous))throw new Error('UNSORTED_BOOK');previous=price;
    }
  }
  if(d(b.bids[0].price)>=d(b.asks[0].price))throw new Error('CROSSED_BOOK');
  return {id,at,bids:b.bids,asks:b.asks,spreadBps:Number(div(d(b.asks[0].price)-d(b.bids[0].price),d(b.asks[0].price)))*10000/Number(UNIT)};
}
export function closedCandles(rows,now){
  if(!Array.isArray(rows))throw new Error('INVALID_CANDLES');
  const unique=new Map();
  for(const r of rows){
    const start=Number(r.start);const values=['open','high','low','close','volume'].map(k=>Number(r[k]));
    if(!Number.isSafeInteger(start)||values.some(x=>!Number.isFinite(x))||values.slice(0,4).some(x=>x<=0)||values[4]<0||Number(r.low)>Math.min(Number(r.open),Number(r.close))||Number(r.high)<Math.max(Number(r.open),Number(r.close)))throw new Error('INVALID_CANDLE');
    if((start+60)*1000<=now)unique.set(start,{start,...Object.fromEntries(['open','high','low','close','volume'].map(k=>[k,Number(r[k])]))});
  }
  return [...unique.values()].sort((a,b)=>a.start-b.start);
}
function ema(rows,n){let x=rows[0].close;for(const row of rows.slice(1))x=row.close*2/(n+1)+x*(1-2/(n+1));return x;}
export function signal(rows,c){
  if(rows.length<30)return {enter:false,reason:'warming_up'};
  const tail=rows.slice(-30);if(tail.some((x,i)=>i>0&&x.start-tail[i-1].start!==60))return {enter:false,reason:'candle_gap'};
  const last=tail.at(-1), momentum=(last.close/tail.at(-6).close-1)*100;
  const high=Math.max(...tail.slice(-6).map(x=>x.high));const pullback=(1-last.close/high)*100;
  const fast=ema(tail,5),slow=ema(tail,20);
  if(fast<=slow||momentum<c.minMomentumPct||momentum>c.maxMomentumPct)return {enter:false,reason:'no_momentum',momentum,pullback};
  if(pullback<c.minPullbackPct||pullback>c.maxPullbackPct)return {enter:false,reason:'no_pullback',momentum,pullback};
  if(last.volume<=0)return {enter:false,reason:'no_volume'};
  return {enter:true,reason:'momentum_pullback',momentum,pullback};
}
export function buildIntent(product,book,side,amount,feeRate,c){
  if(!['BUY','SELL'].includes(side)||product.product_id!==book.id)throw new Error('INVALID_INTENT');
  const fee=d(feeRate);if(fee<0n||fee>d('0.05'))throw new Error('INVALID_FEE_RATE');
  const step=d(product.base_increment),priceStep=d(product.price_increment??product.quote_increment);
  const top=d((side==='BUY'?book.asks:book.bids)[0].price);
  const multiplier=UNIT+(side==='BUY'?1n:-1n)*d(String(c.slippageBps/10000));
  const limit=side==='BUY'?ceilStep(mul(top,multiplier),priceStep):floorStep(mul(top,multiplier),priceStep);
  if(limit<=0n)throw new Error('INVALID_LIMIT_PRICE');
  const quantity=floorStep(side==='BUY'?div(d(amount),mul(limit,UNIT+fee)):d(amount),step);
  const notional=mul(quantity,limit);const commission=ceilStep(mul(notional,fee),d('0.00000001'));
  if(quantity<d(product.base_min_size)||quantity>d(product.base_max_size)||notional<d(product.quote_min_size)||notional>d(product.quote_max_size)||quantity<=0n)throw new Error('BELOW_OR_ABOVE_PRODUCT_LIMIT');
  if(side==='BUY'&&notional+commission>d(amount))throw new Error('ORDER_BUDGET_EXCEEDED');
  let left=quantity,total=0n;
  for(const level of side==='BUY'?book.asks:book.bids){
    const price=d(level.price);if(side==='BUY'?price>limit:price<limit)break;
    const take=d(level.size)<left?d(level.size):left;total+=mul(take,price);left-=take;if(left===0n)break;
  }
  if(left>0n)throw new Error('INSUFFICIENT_DEPTH');
  const average=div(total,quantity);const adverse=UNIT+(side==='BUY'?1n:-1n)*d(String(c.paperAdverseBps/10000));
  const paperPrice=side==='BUY'?ceilStep(mul(average,adverse),priceStep):floorStep(mul(average,adverse),priceStep);
  if(side==='BUY'?paperPrice>limit:paperPrice<limit)throw new Error('PAPER_PRICE_OUTSIDE_LIMIT');
  return {product:product.product_id,base:product.base_currency_id,side,quantity:f(quantity),limit:f(limit),maxCost:f(notional+commission),feeRate,paperPrice:f(paperPrice),createdAt:book.at,
    body:{product_id:product.product_id,side,order_configuration:{sor_limit_ioc:{base_size:f(quantity),limit_price:f(limit)}}}};
}
export class Markets {
  constructor(api,c){this.api=api;this.c=c;this.catalog=new Map();this.catalogAt=0;this.bars=new Map();this.feeRate=null;this.feeAt=0;}
  async fee(now=Date.now()){
    if(!this.feeRate||now-this.feeAt>300000){const raw=await this.api.fees();const rate=raw?.fee_tier?.taker_fee_rate;if(d(rate)<0n||d(rate)>d('0.05'))throw new Error('INVALID_FEE_RATE');this.feeRate=rate;this.feeAt=now;}return this.feeRate;
  }
  async discover(now=Date.now()){
    if(!this.catalogAt||now-this.catalogAt>300000){const all=await this.api.products();this.catalog=new Map(all.map(p=>[p.product_id,p]));this.catalogAt=now;}
    return [...this.catalog.values()].filter(p=>eligible(p,this.c)).sort((a,b)=>Number(b.approximate_quote_24h_volume)-Number(a.approximate_quote_24h_volume)).slice(0,this.c.maxCandidates);
  }
  async product(id){return this.catalog.get(id)??await this.api.product(id);}
  async book(id,now=Date.now()){const raw=await this.api.book(id);return normalizeBook(raw,id,Math.max(now,Date.now()),this.c);}
  async candles(id,now=Date.now()){
    const end=Math.floor(now/60000)*60;let cache=this.bars.get(id);
    if(!cache||cache.end!==end){const raw=await this.api.candles(id,end-3600,end);cache={end,rows:closedCandles(raw.candles,now)};this.bars.set(id,cache);}
    if(!cache.rows.length||now-(cache.rows.at(-1).start+60)*1000>120000)throw new Error('STALE_CANDLES');return cache.rows;
  }
}
