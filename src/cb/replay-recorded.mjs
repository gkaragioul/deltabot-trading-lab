import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadLocalEnvironment} from '../environment.mjs';
import {CoinbaseApi} from './api.mjs';
import {settings} from './config.mjs';
import {closedCandles,Markets} from './market.mjs';
import {BookArchive} from './orderbook.mjs';
import {replayDataset,atomicJson} from './research.mjs';
import {candidates,decisionFor} from './research-strategies.mjs';
import {cleanError} from './engine.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');loadLocalEnvironment(root);
const args=process.argv.slice(2),opts={};
while(args.length){const k=args.shift();if(!['--minutes','--candidate'].includes(k)||!args.length)throw new Error('INVALID_RECORDED_REPLAY_ARGUMENT');opts[k.slice(2)]=args.shift();}
const minutes=Number(opts.minutes??60),hypothesis=opts.candidate?candidates().find(c=>c.id===opts.candidate):null;
if(!Number.isInteger(minutes)||minutes<2||minutes>1440||(opts.candidate&&!hypothesis))throw new Error('INVALID_RECORDED_REPLAY_OPTIONS');
const c=hypothesis?.config??settings(),api=CoinbaseApi.local({allowOrders:false});
const dir=join(root,'runtime','coinbase-books'),archive=new BookArchive(dir,{readOnly:true});
try{
  const end=Math.floor(Date.now()/60000)*60,start=end-minutes*60;
  const ids=['BTC-USDC','ETH-USDC','SOL-USDC'],products=[],bars={};
  for(const id of ids){
    products.push(await api.product(id));const rows=[];
    for(let at=start-3600;at<end;at+=18000)rows.push(...(await api.candles(id,at,Math.min(end,at+18000))).candles);
    bars[id]=closedCandles(rows,end*1000);
  }
  const data={version:1,start,end,products,bars,feeRate:await new Markets(api,c).fee()};
  archive.db.exec('BEGIN');
  const coverage=ids.map(id=>{let observed=0;for(let at=start;at<end;at+=60){try{archive.at(id,at*1000);observed++;}catch{}}return {product:id,minutesAvailable:observed,minutesRequested:minutes};});
  const digest=createHash('sha256');let quoteReads=0;
  const bookSource={at:(id,at,maxAge)=>{const book=archive.at(id,at,maxAge);digest.update(JSON.stringify({id,at,book}));quoteReads++;return book;}};
  const replay=await replayDataset(data,c,{bookSource,...(hypothesis?{decisionFn:decisionFor(hypothesis)}:{})});
  archive.db.exec('COMMIT');
  const result={generatedAt:new Date().toISOString(),hypothesis:hypothesis?.id??'baseline',coverage,quoteReads,bookReadDigest:digest.digest('hex'),feeRate:data.feeRate,
    qualification:'Exploratory only; recorded depth is not evidence of actual execution or profitable strategy',...replay};
  const output=join(dir,'replays');mkdirSync(output,{recursive:true});const name=`${result.hypothesis}-${start}-${end}`;
  atomicJson(join(output,name+'.json'),result);
  const report=['# Replay Using Recorded Order Books','', '**Simulation only. No actual orders.**','',
    `Period: ${new Date(start*1000).toISOString()} to ${new Date(end*1000).toISOString()}. Hypothesis: ${result.hypothesis}.`,'',
    `Net: ${result.netChange.toFixed(4)} USDC. Orders: ${result.orders}. Fees: ${Number(result.fees).toFixed(4)} USDC. Open positions: ${result.openPositions}.`,'',
    '| Product | Minutes with a fresh recorded book | Requested minutes |','| --- | ---: | ---: |',
    ...coverage.map(r=>`| ${r.product} | ${r.minutesAvailable} | ${r.minutesRequested} |`),'',
    'Missing books reject quotes. Zero trades with insufficient data is not a successful strategy. Snapshot depth, adverse-price assumptions, fees and minute sampling cannot guarantee actual fills.',
    `Source: ${name}.json. Book-read digest: ${result.bookReadDigest}.`,''].join('\n');
  writeFileSync(join(dir,'REPLAY.md'),report);
  console.log(JSON.stringify({report:join(dir,'REPLAY.md'),coverage,quoteReads,orders:result.orders,net:result.netChange}));
}catch(e){console.error(cleanError(e));process.exitCode=1;}finally{archive.close();}
