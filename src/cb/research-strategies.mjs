import {settings} from './config.mjs';
import {signal} from './market.mjs';

function context(rows){
  if(rows.length<60)return null;
  const tail=rows.slice(-60);
  if(tail.some((r,i)=>i>0&&r.start-tail[i-1].start!==60))return null;
  const last=tail.at(-1),prior=tail.slice(0,-1);
  const high=Math.max(...prior.map(r=>r.high)),low=Math.min(...prior.map(r=>r.low));
  return {tail,last,high,low,range:(high/low-1)*100,volume:prior.reduce((n,r)=>n+r.volume,0)/prior.length};
}

export function decisionFor(candidate){
  if(candidate.family==='momentum')return (rows,c)=>{
    const result=signal(rows,c);if(!result.enter||!candidate.minRange)return result;
    const x=context(rows);return x&&x.range>=candidate.minRange?result:{enter:false,reason:'insufficient_range_for_fees'};
  };
  if(candidate.family==='breakout')return rows=>{
    const x=context(rows);if(!x)return {enter:false,reason:'incomplete_history'};
    const enter=x.range>=3&&x.last.close>x.high&&x.last.volume>=x.volume*candidate.volumeMultiple;
    return {enter,reason:enter?'volume_breakout':'no_volume_breakout'};
  };
  if(candidate.family==='trend_dip')return rows=>{
    const x=context(rows);if(!x)return {enter:false,reason:'incomplete_history'};
    const trend=(x.last.close/x.tail[0].close-1)*100;
    const dip=(x.last.close/x.tail.at(-6).close-1)*100;
    const rebound=(x.last.close/x.tail.at(-2).close-1)*100;
    const enter=trend>=candidate.minTrend&&dip<=-0.5&&dip>=-2&&rebound>0.1&&x.range>=3;
    return {enter,reason:enter?'trend_dip_rebound':'no_trend_dip'};
  };
  throw new Error('UNKNOWN_RESEARCH_STRATEGY');
}

// Frozen, small hypothesis set. Changing this set creates a new research version.
export const researchVersion='coinbase-research-v1';
export function candidates(){
  const rows=[{id:'baseline',family:'momentum',config:settings()}];
  for(const momentum of [1.5,3,5])for(const hold of [60,180])rows.push({
    id:`momentum-${momentum}-hold-${hold}`,family:'momentum',minRange:3,
    config:settings({minMomentumPct:momentum,maxHoldMinutes:hold,cooldownMinutes:15,takeProfitPct:10,stopLossPct:5,trailingStopPct:3})});
  for(const volume of [1.5,2.5])for(const target of [8,12])rows.push({
    id:`breakout-volume-${volume}-target-${target}`,family:'breakout',volumeMultiple:volume,
    config:settings({maxHoldMinutes:180,cooldownMinutes:30,takeProfitPct:target,stopLossPct:5,trailingStopPct:3})});
  for(const trend of [2,4])rows.push({
    id:`trend-dip-${trend}`,family:'trend_dip',minTrend:trend,
    config:settings({maxHoldMinutes:180,cooldownMinutes:30,takeProfitPct:10,stopLossPct:5,trailingStopPct:3})});
  return rows;
}
