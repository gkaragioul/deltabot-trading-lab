import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';import {resolve,dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';import {setTimeout as sleep} from 'node:timers/promises';
import {loadLocalEnvironment} from '../environment.mjs';import {Store} from '../store.mjs';import {acquireLock,workerRunning} from '../operations.mjs';
import {liveLockPath,requestStop} from './operations.mjs';
import {CoinbaseApi} from './api.mjs';import {settings} from './config.mjs';import {Markets,buildIntent} from './market.mjs';import {initialLedger,LiveExecution} from './execution.mjs';import {CoinbaseEngine,cleanError} from './engine.mjs';import {report} from './report.mjs';import {backtest} from './backtest.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');loadLocalEnvironment(root);
const args=process.argv.slice(2),command=args.shift()??'status',opts={};
while(args.length){const flag=args.shift();if(flag==='--activate-live'){opts.activate=true;continue;}if(!['--mode','--runtime','--config','--cycles','--hours','--products'].includes(flag)||!args.length)throw new Error('INVALID_ARGUMENT');opts[flag.slice(2)]=args.shift();}
const mode=opts.mode??'paper';if(!['paper','live'].includes(mode))throw new Error('INVALID_MODE');
const c=settings(opts.config?JSON.parse(readFileSync(resolve(opts.config),'utf8')):{}),runtime=resolve(opts.runtime??join(root,'runtime','coinbase-'+mode));
let db,lock,liveLock;const write=async()=>{const text=report(db.read(),c,db.events(),await workerRunning(runtime),db.getCommand());writeFileSync(join(runtime,'STATUS.md'),text);return text;};
async function main(){
  if(command==='doctor'){
    const api=CoinbaseApi.local(),markets=new Markets(api,c);const permissions=await api.permissions();if(!permissions.can_view||!permissions.can_trade||permissions.can_transfer)throw new Error('COINBASE_PERMISSIONS_NOT_ALLOWED');
    const accounts=await api.accounts(),fee=await markets.fee(),products=await markets.discover();if(!products.length)throw new Error('NO_ELIGIBLE_PRODUCTS');
    const p=products[0],book=await markets.book(p.product_id),intent=buildIntent(p,book,'BUY',String(c.positionUsd),fee,c),preview=await api.preview(intent.body);
    const result={checkedAt:new Date().toISOString(),connected:true,tradePermission:permissions.can_trade,transferPermission:permissions.can_transfer,
      balances:accounts.filter(a=>Number(a.available_balance.value)>0).map(a=>({currency:a.currency,available:a.available_balance.value})),feeRate:fee,eligibleProducts:products.length,candleCount:(await markets.candles(p.product_id)).length,
      preview:{product:p.product_id,total:preview.order_total,commission:preview.commission_total,errors:preview.errs},liveActivated:false};
    mkdirSync(join(root,'runtime','coinbase'),{recursive:true});writeFileSync(join(root,'runtime','coinbase','doctor.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));if(!Array.isArray(preview.errs)||preview.errs.length)process.exitCode=2;return;
  }
  if(command==='backtest'){
    const result=await backtest(CoinbaseApi.local(),c,{hours:Number(opts.hours??24),count:Number(opts.products??8)});const dir=join(root,'runtime','coinbase');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'backtest.json'),JSON.stringify(result,null,2)+'\n');const {events,...summary}=result;console.log(JSON.stringify(summary,null,2));return;
  }
  if(!['run','status','pause','resume','stop','flatten','export','reconcile'].includes(command))throw new Error('INVALID_COMMAND');
  if(command==='run'){
    if(mode==='live'&&(!opts.activate||process.env.COINBASE_LIVE_TRADING!=='1'))throw new Error('LIVE_REQUIRES_EXPLICIT_OPERATOR_ACTIVATION');
    if(mode==='live')liveLock=await acquireLock(liveLockPath);
    lock=await acquireLock(runtime);mkdirSync(runtime,{recursive:true});
  }else if(!existsSync(join(runtime,'ledger.sqlite')))throw new Error('NO_COINBASE_LEDGER');
  if(command==='reconcile'){
    if(mode!=='live')throw new Error('RECONCILE_REQUIRES_LIVE_LEDGER');
    liveLock=await acquireLock(liveLockPath);lock=await acquireLock(runtime);
  }
  db=new Store(runtime,c,mode);if(!db.read().kind)db.save(initialLedger(c,mode),[]);if(db.read().kind!=='coinbase-v1')throw new Error('WRONG_LEDGER');
  if(command==='status'){console.log(await write());return;}
  if(command==='export'){const path=join(runtime,'events.jsonl');writeFileSync(path,db.events(1000000).reverse().map(e=>JSON.stringify(e)).join('\n')+'\n');console.log(path);return;}
  if(command==='reconcile'){
    await new LiveExecution(CoinbaseApi.local({allowOrders:false}),db,c).recover();await write();console.log(db.read().pending?'Order remains pending; no orders submitted.':'Reconciled; operator control preserved; no orders submitted.');return;
  }
  if(command!=='run'){
    if(command==='resume'&&(db.read().pending||db.read().paused))throw new Error('RECONCILE_PENDING_OR_HALTED_STATE_FIRST');
    db.command(command==='resume'?null:command);await write();console.log('Control: '+command);return;
  }
  if(db.getCommand()==='stop'){console.log('Stopped by operator. Use resume before restarting.');return;}
  const api=CoinbaseApi.local({allowOrders:mode==='live'}),markets=new Markets(api,c),live=mode==='live'?new LiveExecution(api,db,c):null;
  if(live)await live.initialize();const engine=new CoinbaseEngine(db,c,markets,{live});
  const cycles=opts.cycles===undefined?Infinity:Number(opts.cycles);if(cycles!==Infinity&&(!Number.isInteger(cycles)||cycles<1))throw new Error('INVALID_CYCLES');
  let stopping=false;const abort=new AbortController();const stop=()=>{stopping=true;requestStop(db,abort);};process.once('SIGINT',stop);process.once('SIGTERM',stop);
  writeFileSync(join(runtime,'worker.json'),JSON.stringify({pid:process.pid,mode,startedAt:Date.now()}));await write();
  for(let n=0;n<cycles&&!stopping&&db.getCommand()!=='stop';n++){
    const started=Date.now();try{await engine.tick();}catch(e){const s=db.read();s.lastError=cleanError(e);s.lastTick=Date.now();db.save(s,[{type:'cycle_error',at:Date.now(),error:s.lastError}]);}
    await write();const s=db.read();console.log(JSON.stringify({at:new Date().toISOString(),mode,scans:s.scans,buys:s.buys,sells:s.sells,pending:!!s.pending,error:s.lastError}));
    if(n+1<cycles&&!stopping)await sleep(Math.max(1000,c.pollSeconds*1000-(Date.now()-started)),undefined,{signal:abort.signal}).catch(()=>{});
  }
}
try{await main();}catch(e){console.error(cleanError(e));process.exitCode=1;}finally{if(lock){await new Promise(r=>lock.close(r));if(db)await write();}db?.close();if(liveLock)await new Promise(r=>liveLock.close(r));}
