import {readFileSync,mkdirSync,existsSync,writeFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {exportSignals} from './external-export.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const python=join(root,'.venv-research',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const args=process.argv.slice(2),command=args.shift()??'run';
if(!['run','backtest','sdk-check','export'].includes(command))throw new Error('INVALID_EXTERNAL_COMMAND');
const options={};
while(args.length){const flag=args.shift(),value=args.shift();if(!['--dataset','--products','--candidates','--start','--end'].includes(flag)||!value||options[flag]!==undefined)throw new Error('INVALID_EXTERNAL_OPTION');options[flag]=value;}
if(command!=='export'&&!existsSync(python))throw new Error('RUN_SETUP_RESEARCH_TOOLS_FIRST');
const dataset=JSON.parse(readFileSync(resolve(root,options['--dataset']??'runtime/coinbase-research/dataset.json'),'utf8'));
const bundle=exportSignals(dataset,{
 ...(options['--products']?{products:options['--products'].split(',')}:{}),
 ...(options['--candidates']?{candidateIds:options['--candidates'].split(',')}:{}),
 ...(options['--start']?{start:Number(options['--start'])}:{}),
 ...(options['--end']?{end:Number(options['--end'])}:{}),
});
const directory=join(root,'runtime/coinbase-external',new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
mkdirSync(directory,{recursive:true});
const input=join(directory,'input.json');writeFileSync(input,JSON.stringify(bundle));
const manifest={createdAt:new Date().toISOString(),command,input,sourceHash:createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).update(readFileSync(join(root,'src/cb/external-export.mjs'))).update(readFileSync(join(root,'src/cb/research-strategies.mjs'))).update(readFileSync(join(root,'src/cb/market.mjs'))).digest('hex'),stages:[]};
// Python gets no Coinbase environment variables, key paths or .env loading.
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^COINBASE_|^CDP_|^PYTHONPATH$|^PYTHONHOME$/i.test(k)));
let failure=false;
for(const stage of command==='run'?['sdk-check','backtest']:command==='export'?[]:[command]){
 const output=join(directory,stage+'.json');
 const result=spawnSync(python,[join(root,'integrations/python/run.py'),stage,'--input',input,'--output',output],{cwd:root,env,encoding:'utf8',timeout:300000,maxBuffer:2*1024*1024,windowsHide:true});
 writeFileSync(join(directory,stage+'.log'),(result.stdout??'')+(result.stderr??''));
 const okay=result.status===0;
 manifest.stages.push({stage,okay,exitCode:result.status,output:existsSync(output)?output:null});
 console.log(JSON.stringify({stage,okay,output}));
 if(!okay){failure=true;break;}
}
const report=['# External repository integration run','',`Created: ${manifest.createdAt}`,`Input dataset SHA256: ${bundle.inputSha256}`,`Window: ${new Date(bundle.start*1000).toISOString()} to ${new Date(bundle.end*1000).toISOString()}`,'',
 'Diagnostic research using installed packages. No live orders. Previously exposed historical data is not a new holdout.',''];
for(const stage of manifest.stages){
 report.push(`## ${stage.stage}: ${stage.okay?'completed':'failed'}`,'');
 if(!stage.output)continue;
 const result=JSON.parse(readFileSync(stage.output,'utf8'));
 if(stage.stage==='sdk-check')report.push(`SDK ${result.engineVersion}: ${result.checks.filter(c=>c.passed).length}/${result.checks.length} sampled windows match exactly.`,...result.limitations.map(x=>'- '+x),'');
 else for(const scenario of result.scenarios){
  report.push(`### Spread ${scenario.spreadBps} bps, adverse cost ${scenario.adverseBps} bps per side`,'','Each row is a separate 20-USDC virtual account, maximum 5 USDC per entry. Returns cannot be added together as a portfolio.','',
   '| Market | Signal | Closed trades | Net USDC | Commission USDC | Total modeled costs USDC |','| --- | --- | ---: | ---: | ---: | ---: |',
   ...scenario.runs.map(r=>`| ${r.product} | ${r.candidate} | ${r.closedTrades} | ${r.netChange.toFixed(4)} | ${r.commissions.toFixed(4)} | ${r.executionCosts.toFixed(4)} |`),'',...scenario.limitations.map(x=>'- '+x),'');
 }
}
writeFileSync(join(directory,'manifest.json'),JSON.stringify(manifest,null,2));
writeFileSync(join(directory,'REPORT.md'),report.join('\n'));
writeFileSync(join(root,'runtime/coinbase-external/latest.json'),JSON.stringify({directory,okay:!failure}));
console.log(join(directory,'REPORT.md'));
if(failure)process.exitCode=1;
