import {randomUUID} from 'node:crypto';
import {writeFileSync,existsSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {PublicBooks,BookArchive} from './orderbook.mjs';
import {acquireLock,workerRunning} from '../operations.mjs';
import {cleanError} from './engine.mjs';

// Public data only: no environment/key loading, account client or order endpoint.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const dir=join(root,'runtime','coinbase-books');
const args=process.argv.slice(2),command=args.shift()??'status';
let seconds=Infinity;
if(args.length){if(args.shift()!=='--seconds'||args.length!==1)throw new Error('INVALID_RECORDER_ARGUMENT');seconds=Number(args[0]);if(!Number.isInteger(seconds)||seconds<5||seconds>86400)throw new Error('INVALID_RECORDER_DURATION');}
if(!['run','status','stop','resume'].includes(command))throw new Error('INVALID_RECORDER_COMMAND');
if(command!=='run'&&!existsSync(join(dir,'books.sqlite')))throw new Error('NO_BOOK_ARCHIVE');
const products=['BTC-USD','ETH-USD','SOL-USD'],aliases=products.map(p=>p.replace(/-USD$/,'-USDC'));
let db,lock,ws,stopping=false,timer,epoch='',lastError=null,reconnects=0,messages=0,sampleCount=0;
let feed=new PublicBooks(products);
const status=async()=>{
  if(command==='run')db.setState({messages,sampleCount,reconnects,lastError,connected:ws?.readyState===1,receivedAt:feed.receivedAt,updatedAt:Date.now()});
  const meta=db.state(),rows=db.stats(),running=await workerRunning(dir);
  const text=['# Coinbase Public Order-Book Recorder','', '**Public market data only — cannot place trades.**','',
    `Process: ${running?'running':'stopped'}. Feed: ${running&&meta.connected&&Date.now()-meta.receivedAt<15000?'connected and fresh':'disconnected, stopped or stale'}.`,
    `Updated: ${new Date().toISOString()}. Last recorder error: ${meta.lastError??'none'}.`,
    `Messages this worker: ${meta.messages??0}. Samples this worker: ${meta.sampleCount??0}. Reconnects: ${meta.reconnects??0}.`,'',
    '| Product alias | Samples in last hour | Mean spread (bps) | Last observed UTC |','| --- | ---: | ---: | --- |',
    ...rows.map(r=>`| ${r.product} | ${r.samples} | ${r.meanSpreadBps.toFixed(4)} | ${new Date(r.last).toISOString()} |`),'',
    'Source: Coinbase Advanced public level2 and heartbeats. USD market data aliases are recorded explicitly for USDC research.',
    'Top 20 levels are sampled every five seconds. This is sampled depth, not a complete tick archive or guaranteed fill model.',
    'Sequence gaps, disconnects and stale data invalidate the feed. Replay lookup never uses future samples or a prior connection epoch.',
    'Retention: up to seven days; oldest samples are trimmed earlier near the approximately 512-MiB SQLite cap. The computer must stay awake and online.',''].join('\n');
  writeFileSync(join(dir,'STATUS.md'),text);return text;
};
try{
  if(command==='run')lock=await acquireLock(dir);
  db=new BookArchive(dir);
  if(command==='status')console.log(await status());
  else if(command==='stop'||command==='resume'){db.stop(command==='stop');console.log('Recorder control: '+command);}
  else if(!db.stopped()){
    const end=Date.now()+seconds*1000;
    const stop=()=>{stopping=true;db.stop();ws?.close();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
    let backoff=1000,lastPrune=0;
    while(!stopping&&!db.stopped()&&Date.now()<end){
      feed.reset();epoch=randomUUID();const openedAt=Date.now();let sampledAt=0;
      ws=new WebSocket('wss://advanced-trade-ws.coinbase.com');
      await new Promise(resolveClose=>{
        let finished=false;
        const finish=()=>{if(finished)return;finished=true;clearInterval(timer);feed.reset();db.event(Date.now(),'disconnected',epoch);resolveClose();};
        ws.onopen=()=>{db.event(Date.now(),'connected',epoch);for(const channel of ['heartbeats','level2'])ws.send(JSON.stringify({type:'subscribe',channel,product_ids:products}));};
        ws.onmessage=e=>{
          try{if(typeof e.data!=='string'||e.data.length>20000000)throw new Error('FEED_MESSAGE_TOO_LARGE');feed.ingest(JSON.parse(e.data));messages++;}
          catch(error){lastError=cleanError(error);db.event(Date.now(),'fault',epoch);feed.reset();ws.close();}
        };
        ws.onerror=()=>{lastError='PUBLIC_WS_ERROR';ws.close();};ws.onclose=finish;
        timer=setInterval(()=>{
          try{
            const now=Date.now();
            if(stopping||db.stopped()||now>=end){ws.close();return;}
            if(now-(feed.receivedAt||openedAt)>15000){lastError='PUBLIC_FEED_STALLED';db.event(now,'fault',epoch);feed.reset();ws.close();return;}
            if(now-sampledAt>=5000&&ws.readyState===1){
              const books=[];for(const id of aliases){try{books.push(feed.snapshot(id,now));}catch{}}
              if(books.length){db.record(books,now,epoch,feed.sequence);sampleCount+=books.length;lastError=null;}sampledAt=now;
              if(now-lastPrune>3600000){db.prune(now);lastPrune=now;}
              status().catch(()=>{});
            }
          }catch(error){lastError=cleanError(error);stopping=true;ws.close();}
        },500);
      });
      if(!stopping&&!db.stopped()&&Date.now()<end){reconnects++;await sleep(Math.min(backoff,Math.max(0,end-Date.now())));backoff=Date.now()-openedAt>30000?1000:Math.min(30000,backoff*2);}
    }
    console.log(JSON.stringify({messages,samples:sampleCount,reconnects,error:lastError}));
  }
}catch(e){console.error(cleanError(e));process.exitCode=1;}
finally{clearInterval(timer);if(lock)await new Promise(r=>lock.close(r));if(db){await status();db.close();}}
