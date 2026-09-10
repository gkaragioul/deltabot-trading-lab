import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {loadLocalEnvironment} from '../environment.mjs';
import {acquireLock} from '../operations.mjs';
import {CoinbaseApi} from './api.mjs';
import {settings} from './config.mjs';
import {collectDataset,replayDataset,splitPeriods,chooseCandidate,qualifyCandidate,atomicJson,readJsonCache,assertDatasetOptions} from './research.mjs';
import {candidates,decisionFor,researchVersion} from './research-strategies.mjs';
import {cleanError} from './engine.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');loadLocalEnvironment(root);
const args=process.argv.slice(2),command=args.shift()??'run';
if(!['collect','run','status'].includes(command))throw new Error('INVALID_RESEARCH_COMMAND');
const opts={};while(args.length){const k=args.shift();if(!['--days','--products','--end','--dataset'].includes(k)||!args.length)throw new Error('INVALID_RESEARCH_ARGUMENT');opts[k.slice(2)]=args.shift();}
const dir=join(root,'runtime','coinbase-research'),datasetPath=resolve(opts.dataset??join(dir,'dataset.json'));
mkdirSync(dir,{recursive:true});let lock;
const write=atomicJson;
const slim=({events,curve,...r})=>r;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');

function report(result){
  const n=x=>Number(x).toFixed(3);
  const lines=['# Coinbase Strategy Research','',`Updated: ${result.generatedAt}`,'',
    '**Historical simulation only. No live orders, no guaranteed returns.**','',
    `Dataset: ${result.fingerprint}. Account taker fee: ${Number(result.feeRate)*100}% per side.`,'',
    `Frozen hypotheses: ${result.rows.length}. Cash benchmark: 0% return, 0 trades.`,'',
    '| Candidate | Training net USDC | Validation net USDC | Validation orders/day | Validation drawdown |',
    '| --- | ---: | ---: | ---: | ---: |'];
  for(const r of result.rows)lines.push(`| ${r.id} | ${n(r.train.netChange)} | ${n(r.validation.netChange)} | ${n(r.validation.ordersPerDay)} | ${n(r.validation.maxDrawdownPct)}% |`);
  lines.push('',`Selected before final test: **${result.selected??'none qualified'}**. Diagnostic final test: ${result.diagnostic}.`,'',
    '| Final test | Net USDC | Return | Orders | Fees USDC | Drawdown |','| --- | ---: | ---: | ---: | ---: | ---: |');
  for(const [label,r] of [['Baseline',result.baselineTest],['Selected/diagnostic',result.test],['Higher-cost and delayed-entry stress',result.stress]])lines.push(`| ${label} | ${n(r.netChange)} | ${n(r.returnPct)}% | ${r.orders} | ${n(r.fees)} | ${n(r.maxDrawdownPct)}% |`);
  lines.push('',`Forward-paper qualification: **${result.qualification.passed?'PASS — fresh validation still required':'FAIL'}**.`,'');
  for(const reason of result.qualification.reasons)lines.push('- '+reason);
  lines.push('',`10× target reached in final test: ${result.test.returnPct>=900?'yes in this simulation only':'no'}. 100×: ${result.test.returnPct>=9900?'yes in this simulation only':'no'}.`,'',
    'No historical result establishes constant returns. A passing candidate would still require fresh forward paper evidence.','',
    '## Assumptions and limits','',
    '- Currently listed products and current volume ranking introduce selection/survivorship bias; this is not a point-in-time universe.',
    '- Data are split chronologically before ranking. Each window starts with a fresh 20-USDC simulated account; balances are not compounded between windows.',
    '- Decisions use closed candles; fills use a later candle open with 10-bps assumed spread, 10-bps adverse execution per side, current taker fees and a prior-minute-volume liquidity proxy.',
    '- Stress uses 20-bps spread, 15-bps adverse execution and a one-minute decision delay. It can reject trades the base model accepts.',
    '- Minute candles cannot recreate book queues, true fill probability, outages or intraminute stop behavior. Fees are the captured current tier, not historical per-order tiers.',
    '- Missing candles are rejected and coverage is reported. The test window is evaluated only for the locked selection and baseline; it is not used to rank alternatives.',
    '- Drawdown is conservative: unpriceable open holdings are valued at zero until a valid modeled exit returns. Data gaps can therefore inflate drawdown; this is not a realized cash loss.',
    '- A final test becomes exposed after this report. Do not tune against it and then describe it as unseen. Subsequent confirmation needs new data.','',
    '## Data coverage','', '| Product | Observed minutes | Expected | Coverage |','| --- | ---: | ---: | ---: |');
  for(const r of result.coverage)lines.push(`| ${r.product} | ${r.observed} | ${r.expected} | ${(r.fraction*100).toFixed(2)}% |`);
  return lines.join('\n')+'\n';
}

try{
  if(command==='status'){console.log(readFileSync(join(dir,'RESEARCH.md'),'utf8'));}
  else{
    lock=await acquireLock(dir);
    if(command==='collect'||!existsSync(datasetPath)){
      const data=await collectDataset(CoinbaseApi.local({allowOrders:false}),settings(),{days:Number(opts.days??14),count:Number(opts.products??8),...(opts.end?{end:Number(opts.end)}:{}),cacheDir:join(dir,'cache'),onProgress:x=>console.log(JSON.stringify(x))});
      write(datasetPath,data);console.log(JSON.stringify({dataset:datasetPath,fingerprint:data.fingerprint}));
    }
    if(command==='run'){
      const data=JSON.parse(readFileSync(datasetPath,'utf8')),{fingerprint,...unsigned}=data;assertDatasetOptions(data,opts);
      if(digest(unsigned)!==fingerprint)throw new Error('DATASET_FINGERPRINT_MISMATCH');
      const variants=candidates(),periods=splitPeriods(data.start,data.end);
      const implementation=digest(['research.mjs','research-strategies.mjs','research-cli.mjs','engine.mjs','execution.mjs','market.mjs','decimal.mjs','config.mjs'].map(name=>readFileSync(join(root,'src','cb',name),'utf8')));
      const id=digest({fingerprint,researchVersion,implementation,variants,periods}).slice(0,20),runDir=join(dir,id);mkdirSync(runDir,{recursive:true});
      const resultPath=join(runDir,'results.json');
      const cached=readJsonCache(resultPath);
      if(cached){writeFileSync(join(dir,'RESEARCH.md'),report(cached));write(join(dir,'latest.json'),{id,resultPath});console.log(JSON.stringify({cached:true,report:join(dir,'RESEARCH.md'),qualification:cached.qualification}));}
      else{
        write(join(runDir,'protocol.json'),{fingerprint,researchVersion,implementation,variants,periods,createdAt:new Date().toISOString()});
        const rows=[];
        for(const v of variants){
          const path=join(runDir,v.id+'.json');let row=readJsonCache(path);
          if(!row){const train=await replayDataset(data,v.config,{...periods.train,decisionFn:decisionFor(v),keepEvents:false});const validation=await replayDataset(data,v.config,{...periods.validation,decisionFn:decisionFor(v),keepEvents:false});row={id:v.id,train:slim(train),validation:slim(validation)};write(path,row);}
          rows.push(row);console.log(JSON.stringify({candidate:v.id,trainNet:row.train.netChange,validationNet:row.validation.netChange,validationOrders:row.validation.orders}));
        }
        const selected=chooseCandidate(rows);
        const diagnostic=selected??[...rows].filter(r=>r.validation.closedTrades>0).sort((a,b)=>b.validation.netChange-a.validation.netChange||a.id.localeCompare(b.id))[0]?.id??'baseline';
        const locked={selected,diagnostic,lockedAt:new Date().toISOString()};write(join(runDir,'selection-before-test.json'),locked);
        const v=variants.find(v=>v.id===diagnostic),chosen=rows.find(r=>r.id===diagnostic);
        const test=await replayDataset(data,v.config,{...periods.test,decisionFn:decisionFor(v)});
        const stress=await replayDataset(data,settings({...v.config,paperAdverseBps:15}),{...periods.test,decisionFn:decisionFor(v),spreadBps:20,latencyBars:1});
        const baselineTest=diagnostic==='baseline'?test:await replayDataset(data,variants[0].config,{...periods.test,decisionFn:decisionFor(variants[0])});
        const qualification=qualifyCandidate(chosen.train,chosen.validation,test,stress);
        if(!selected){qualification.passed=false;qualification.reasons.unshift('No candidate passed training and validation selection');}
        if(data.coverage.some(r=>r.fraction<0.95)){qualification.passed=false;qualification.reasons.push('At least one selected market has less than 95% candle coverage');}
        const result={generatedAt:new Date().toISOString(),fingerprint,researchVersion,implementation,periods,coverage:data.coverage,feeRate:data.feeRate,rows,...locked,test,stress,baselineTest,qualification};
        write(resultPath,result);writeFileSync(join(dir,'RESEARCH.md'),report(result));write(join(dir,'latest.json'),{id,resultPath});
        console.log(JSON.stringify({report:join(dir,'RESEARCH.md'),selected,diagnostic,test:slim(test),qualification}));
      }
    }
  }
}catch(e){console.error(cleanError(e));process.exitCode=1;}finally{if(lock)await new Promise(r=>lock.close(r));}
