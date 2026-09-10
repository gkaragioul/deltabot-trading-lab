import {createHash} from 'node:crypto';
import {closedCandles} from './market.mjs';
import {candidates,researchVersion,decisionFor} from './research-strategies.mjs';

// The production decision functions see only the most recent 60 closed bars.
// Python consumes these decisions, but runs its own broker/accounting engine.
export function exportSignals(data,{candidateIds=['baseline','momentum-1.5-hold-180'],products=['BTC-USDC','ETH-USDC','SOL-USDC'],start=data.start,end=data.end}={}){
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<data.start||end>data.end||start>=end||start%60||end%60)throw new Error('INVALID_EXTERNAL_WINDOW');
 if(!Array.isArray(candidateIds)||!candidateIds.length||new Set(candidateIds).size!==candidateIds.length)throw new Error('INVALID_EXTERNAL_STRATEGIES');
 if(!Array.isArray(products)||!products.length||new Set(products).size!==products.length)throw new Error('INVALID_EXTERNAL_PRODUCTS');
 const selected=candidateIds.map(id=>{const c=candidates().find(x=>x.id===id);if(!c)throw new Error('UNKNOWN_EXTERNAL_STRATEGY');return c;});
 const decisions=selected.map(c=>decisionFor(c));
 const markets=products.map(id=>{
  const product=data.products.find(p=>p.product_id===id);if(!product||!data.bars[id])throw new Error('UNKNOWN_EXTERNAL_PRODUCT');
  const raw=data.bars[id].filter(r=>r.start>=start-3600&&r.start<end);
  const rows=closedCandles(raw,end*1000);
  if(rows.length!==raw.length||rows.length!==(end-start+3600)/60||rows[0].start!==start-3600||rows.at(-1).start!==end-60||rows.some((r,i)=>i&&r.start-rows[i-1].start!==60))throw new Error('INCOMPLETE_EXTERNAL_CANDLES');
  return {product:id,baseIncrement:product.base_increment,rows:rows.map((r,i)=>({...r,decisionAt:r.start+60,entries:Object.fromEntries(selected.map((c,j)=>[c.id,r.start+60>=start&&Boolean(decisions[j](rows.slice(Math.max(0,i-59),i+1),c.config).enter)]))}))};
 });
 return {version:1,researchVersion,start,end,feeRate:data.feeRate,inputSha256:createHash('sha256').update(JSON.stringify(data)).digest('hex'),candidates:selected,markets};
}
