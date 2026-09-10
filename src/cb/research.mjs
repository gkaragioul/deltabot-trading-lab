import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,existsSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {settings} from './config.mjs';
import {Markets,closedCandles,buildIntent} from './market.mjs';
import {initialLedger,paperFill} from './execution.mjs';
import {CoinbaseEngine,equity} from './engine.mjs';
import {d,f} from './decimal.mjs';

const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const decimal=n=>n.toFixed(18).replace(/0+$/,'').replace(/\.$/,'');
const read=path=>JSON.parse(readFileSync(path,'utf8'));
export function readJsonCache(path){try{return read(path);}catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)return null;throw e;}}
export function atomicJson(path,value){writeFileSync(path+'.tmp',JSON.stringify(value));renameSync(path+'.tmp',path);}
const save=atomicJson;
export function assertDatasetOptions(data,opts){
  if((opts.days!==undefined&&Number(opts.days)!==(data.end-data.start)/86400)||(opts.end!==undefined&&Number(opts.end)!==data.end)||(opts.products!==undefined&&Number(opts.products)!==(data.requestedCount??data.products.length)))throw new Error('DATASET_OPTIONS_MISMATCH_RUN_COLLECT');
}

export async function collectDataset(api,c,{days=14,count=8,end=Math.floor((Date.now()/1000-172800)/86400)*86400,cacheDir,onProgress=()=>{}}={}){
  if(!Number.isInteger(days)||days<2||days>30||!Number.isInteger(count)||count<1||count>20||!Number.isSafeInteger(end)||end%60||end>Date.now()/1000||!cacheDir)throw new Error('INVALID_DATASET_OPTIONS');
  mkdirSync(cacheDir,{recursive:true});
  const start=end-days*86400;
  const manifestPath=join(cacheDir,`manifest-${start}-${end}-${count}-${hash(c).slice(0,12)}.json`);
  let manifest=readJsonCache(manifestPath);
  if(!manifest){
    const market=new Markets(api,c),products=(await market.discover()).slice(0,count);
    if(!products.length)throw new Error('NO_RESEARCH_PRODUCTS');
    manifest={version:1,start,end,requestedCount:count,products,feeRate:await market.fee(),capturedAt:new Date().toISOString()};save(manifestPath,manifest);
  }
  const bars={},coverage=[];
  for(const p of manifest.products){
    const rows=[];
    for(let t=start-3600;t<end;t+=18000){
      const until=Math.min(end,t+18000),path=join(cacheDir,`${p.product_id}-${t}-${until}.json`);
      let chunk=readJsonCache(path);
      if(!chunk){chunk=closedCandles((await api.candles(p.product_id,t,until)).candles,end*1000).filter(b=>b.start>=t&&b.start<until);save(path,chunk);}
      rows.push(...chunk);
    }
    bars[p.product_id]=closedCandles(rows,end*1000).filter(b=>b.start>=start-3600&&b.start<end);
    const n=bars[p.product_id].filter(b=>b.start>=start).length;
    coverage.push({product:p.product_id,expected:(end-start)/60,observed:n,fraction:n/((end-start)/60)});
    onProgress({product:p.product_id,complete:coverage.length,total:manifest.products.length,coverage:coverage.at(-1).fraction});
  }
  const dataset={...manifest,bars,coverage};dataset.fingerprint=hash(dataset);return dataset;
}

// Binary search ensures a decision can only inspect fully closed candles.
function before(rows,seconds){let lo=0,hi=rows.length;while(lo<hi){const mid=(lo+hi)>>>1;if(rows[mid].start+60<=seconds)lo=mid+1;else hi=mid;}return lo;}

export async function replayDataset(data,c,{start=data.start,end=data.end,decisionFn,spreadBps=10,latencyBars=0,onTick,keepEvents=true,bookSource,capitalUsd=c.activeUsd,positionUsd=c.positionUsd*(capitalUsd/c.activeUsd)}={}){
  settings(c);
  if(!Number.isFinite(capitalUsd)||capitalUsd<=0||capitalUsd>10000||!Number.isFinite(positionUsd)||positionUsd<=0||positionUsd>capitalUsd)throw new Error('INVALID_REPLAY_CAPITAL');
  // Virtual balances only: this function constructs its own in-memory paper
  // ledger and never accepts a live execution adapter. Validate the original
  // config first; real-money settings retain their existing trial limits.
  const capitalScale=capitalUsd/c.activeUsd;
  c={...c,activeUsd:capitalUsd,positionUsd,maxDailyLossUsd:c.maxDailyLossUsd*capitalScale,maxDrawdownUsd:c.maxDrawdownUsd*capitalScale};
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<data.start||end>data.end||start>=end||start%60||end%60||!Number.isInteger(latencyBars)||latencyBars<0||latencyBars>5||!Number.isFinite(spreadBps)||spreadBps<=0)throw new Error('INVALID_REPLAY_WINDOW');
  const indexes=new Map(data.products.map(p=>[p.product_id,new Map(data.bars[p.product_id].map(b=>[b.start,b]))]));
  let clock=start*1000,s=initialLedger(c,'backtest',clock),command=null;
  const events=[],curve=[],positionCosts=new Map(),tradeReturns=[];
  const db={read:()=>structuredClone(s),save:(state,ev=[])=>{s=structuredClone(state);events.push(...ev);},getCommand:()=>command};
  const market={fee:async()=>data.feeRate,discover:async()=>data.products,product:async id=>data.products.find(p=>p.product_id===id),
    candles:async id=>{const rows=data.bars[id],i=before(rows,clock/1000-latencyBars*60);const tail=rows.slice(Math.max(0,i-60),i);if(!tail.length||clock/1000-tail.at(-1).start-60>120+latencyBars*60)throw new Error('REPLAY_STALE_CANDLES');return tail;},
    book:async id=>{
      if(bookSource){const book=await bookSource.at(id,clock,c.maxBookAgeSeconds*1000);if(book.id!==id||book.at>clock||clock-book.at>c.maxBookAgeSeconds*1000)throw new Error('INVALID_RECORDED_BOOK_TIME');return book;}
      const bar=indexes.get(id).get(clock/1000),previous=indexes.get(id).get(clock/1000-60);
      if(!bar||!previous||previous.volume<=0)throw new Error('REPLAY_CANDLE_GAP');
      // A liquidity proxy using only prior volume, not future intrabar volume.
      const size=decimal(previous.volume*0.01),half=spreadBps/20000;
      return {id,at:clock,spreadBps,bids:[{price:decimal(bar.open*(1-half)),size}],asks:[{price:decimal(bar.open*(1+half)),size}]};
    }};
  const engine=new CoinbaseEngine(db,c,market,{now:()=>clock,...(decisionFn?{decisionFn}:{})});
  let peak=c.activeUsd,maxDrawdown=0;
  const mark=async()=>{
    for(const p of Object.values(s.positions)){
      try{const fill=paperFill(buildIntent(await market.product(p.product),await market.book(p.product),'SELL',p.quantity,data.feeRate,c));p.value=f(d(fill.value)-d(fill.fee));p.valuedAt=clock;}catch{p.value=null;}
    }
    const value=Number(equity(s));peak=Math.max(peak,value);maxDrawdown=Math.max(maxDrawdown,peak-value);
    curve.push({at:clock,equity:value});onTick?.({at:clock,equity:value});
  };
  for(;clock<end*1000;clock+=60000){await engine.tick();await mark();}
  clock-=60000;command='flatten';await engine.tick();await mark();
  for(const e of events.filter(e=>e.type==='paper_fill')){
    if(e.side==='BUY')positionCosts.set(e.product,Number(e.value)+Number(e.fee));
    else{const cost=positionCosts.get(e.product);if(cost!==undefined){tradeReturns.push(Number(e.value)-Number(e.fee)-cost);positionCosts.delete(e.product);}}
  }
  const wins=tradeReturns.filter(x=>x>0),losses=tradeReturns.filter(x=>x<0),grossWins=wins.reduce((a,b)=>a+b,0),grossLosses=-losses.reduce((a,b)=>a+b,0);
  return {start,end,bookModel:bookSource?'recorded':'modeled',hours:(end-start)/3600,simulationBudget:{capitalUsd:c.activeUsd,positionUsd:c.positionUsd,maxDailyLossUsd:c.maxDailyLossUsd,maxDrawdownUsd:c.maxDrawdownUsd},startEquity:String(c.activeUsd),endEquity:equity(s),netChange:Number(equity(s))-c.activeUsd,returnPct:(Number(equity(s))/c.activeUsd-1)*100,
    fees:s.fees,orders:s.orders,buys:s.buys,sells:s.sells,closedTrades:tradeReturns.length,winRate:tradeReturns.length?wins.length/tradeReturns.length:0,
    profitFactor:grossLosses>0?grossWins/grossLosses:null,maxDrawdown,maxDrawdownPct:maxDrawdown/c.activeUsd*100,
    ordersPerDay:s.orders/((end-start)/86400),openPositions:Object.keys(s.positions).length,halt:s.paused,
    errors:events.filter(e=>e.type==='candidate_error'||e.type==='exit_unavailable').length,
    curve:curve.filter((_,i)=>i%60===0||i===curve.length-1),...(keepEvents?{events}:{})};
}

export function splitPeriods(start,end){
  const days=(end-start)/86400;if(!Number.isInteger(days)||days<7)throw new Error('INSUFFICIENT_RESEARCH_DAYS');
  const a=start+Math.floor(days*0.5)*86400,b=start+Math.floor(days*0.8)*86400;
  return {train:{start,end:a},validation:{start:a,end:b},test:{start:b,end}};
}

export function chooseCandidate(rows){
  // Test results are deliberately excluded from both eligibility and ranking.
  const eligible=rows.filter(r=>r.train.netChange>0&&r.validation.netChange>0&&r.train.closedTrades>=10&&r.validation.closedTrades>=5&&r.train.openPositions===0&&r.validation.openPositions===0&&r.train.maxDrawdownPct<=10&&r.validation.maxDrawdownPct<=10);
  eligible.sort((a,b)=>(b.validation.netChange-b.validation.maxDrawdown)-(a.validation.netChange-a.validation.maxDrawdown)||a.id.localeCompare(b.id));
  return eligible[0]?.id??null;
}

export function qualifyCandidate(train,validation,test,stress=test){
  const reasons=[];
  if(train.netChange<=0||validation.netChange<=0||test.netChange<=0||stress.netChange<=0)reasons.push('Not profitable after costs in every evaluation period and stress run');
  if(train.closedTrades<10||validation.closedTrades<5||test.closedTrades<10||stress.closedTrades<5)reasons.push('Insufficient independent closed trades');
  if([train,validation,test,stress].some(r=>r.maxDrawdownPct>10||r.openPositions>0))reasons.push('Excessive drawdown or unresolved holdings');
  return {passed:reasons.length===0,reasons,next:reasons.length?'Keep research-only':'Eligible for fresh forward paper validation, not live activation'};
}
