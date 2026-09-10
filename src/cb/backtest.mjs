import {initialLedger} from './execution.mjs';import {CoinbaseEngine,equity} from './engine.mjs';import {closedCandles,Markets} from './market.mjs';
const decimal=n=>n.toFixed(18).replace(/0+$/,'').replace(/\.$/,'');
export async function backtest(api,c,{hours=24,count=8,now=Date.now()}={}){
  if(!Number.isInteger(hours)||hours<2||hours>48||!Number.isInteger(count)||count<1||count>20)throw new Error('INVALID_REPLAY_OPTIONS');
  const real=new Markets(api,c);const products=(await real.discover(now)).slice(0,count),fee=await real.fee(now);
  const end=Math.floor(now/60000)*60,start=end-hours*3600;const bars=new Map();
  for(const p of products){const all=[];for(let t=start-3600;t<end;t+=300*60){const r=await api.candles(p.product_id,t,Math.min(end,t+300*60));all.push(...r.candles);}bars.set(p.product_id,closedCandles(all,now));}
  let clock=start*1000,s=initialLedger(c,'backtest',clock),command=null;const events=[];
  const db={read:()=>structuredClone(s),save:(state,ev=[])=>{s=structuredClone(state);events.push(...ev);},getCommand:()=>command};
  const market={fee:async()=>fee,discover:async()=>products,product:async id=>products.find(p=>p.product_id===id),
    candles:async id=>bars.get(id).filter(b=>(b.start+60)*1000<=clock).slice(-60),
    book:async id=>{const bar=bars.get(id).find(b=>b.start*1000===clock);if(!bar)throw new Error('REPLAY_CANDLE_GAP');return {id,at:clock,spreadBps:10,bids:[{price:decimal(bar.open*0.9995),size:'1000000000000'}],asks:[{price:decimal(bar.open*1.0005),size:'1000000000000'}]};}};
  const engine=new CoinbaseEngine(db,c,market,{now:()=>clock});
  for(;clock<end*1000;clock+=60000)await engine.tick();
  clock-=60000;command='flatten';await engine.tick();
  return {generatedAt:new Date(now).toISOString(),mode:'historical simulation',hours,products:products.map(p=>p.product_id),takerFeeRate:fee,
    startEquity:String(c.activeUsd),endEquity:equity(s),netChange:Number(equity(s))-c.activeUsd,orders:s.orders,buys:s.buys,sells:s.sells,fees:s.fees,openPositions:Object.keys(s.positions).length,
    limitations:['Current product selection has survivorship bias.','Fills use next candle open with assumed 10-bps spread and adverse price adjustment, not historical order-book liquidity.','Stops are sampled each minute; intraminute losses and queue competition are not reproduced.','This sample was not used to optimize parameters and does not establish future returns.'],events};
}
