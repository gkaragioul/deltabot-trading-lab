import {equity,entryBlock} from './engine.mjs';
const safe=x=>String(x??'').replace(/[\r\n|<>\[\]`]/g,' ').slice(0,120);
export function report(state,c,events,running,command,now=Date.now()){
  const s=structuredClone(state);for(const p of Object.values(s.positions))if(now-p.valuedAt>Math.max(60000,c.pollSeconds*3000))p.value=null;
  const fresh=s.lastTick&&now-s.lastTick<Math.max(90000,c.pollSeconds*5000);
  const fmt=n=>Number(n).toFixed(4);
  const lines=['# Coinbase Trading Lab','',`**${s.mode==='live'?'LIVE ACCOUNT':'PAPER — SIMULATED MONEY'}**`,'',
    `Service: **${!running?'Stopped':!fresh?'Starting or stale':s.lastError?'Running with provider errors':'Running'}** · Updated ${new Date(now).toISOString()}`,'',
    `New entries: ${safe(entryBlock(s,c,command,now)??'enabled when a signal qualifies')}.`,'',
    '| Measure | USDC |','| --- | ---: |',`| Strategy budget | ${c.activeUsd} |`,`| Available strategy cash | ${fmt(s.cash)} |`,
    `| Conservative strategy equity | ${fmt(equity(s))} |`,`| Closed-trade P&L | ${fmt(s.realized)} |`,`| Total commissions | ${fmt(s.fees)} |`,
    `| Change from starting strategy budget | ${fmt(Number(equity(s))-c.activeUsd)} |`,'',
    `Scans: ${s.scans}. Buy fills: ${s.buys}. Sell fills: ${s.sells}. Orders today: ${s.daily.orders}. Total orders: ${s.orders}.`,'',
    `Taker fee used: ${s.feeRate===undefined?'not loaded':(Number(s.feeRate)*100).toFixed(2)+'%'}. Pending order: ${s.pending?safe(s.pending.id):'none'}.`,'',
    `Last error: ${safe(s.lastError??'none')}. Last cycle: ${s.lastTick?new Date(s.lastTick).toISOString():'none'}.`,'',
    '## Bot positions','', '| Product | Quantity | Cost | Estimated net exit |','| --- | ---: | ---: | ---: |'];
  for(const p of Object.values(s.positions))lines.push(`| ${safe(p.product)} | ${safe(p.quantity)} | ${fmt(p.cost)} | ${p.value===null?'Unavailable (valued at zero)':fmt(p.value)} |`);
  if(!Object.keys(s.positions).length)lines.push('| None | — | — | — |');
  lines.push('','## Screening','', '| Product | Decision |','| --- | --- |');for(const row of s.decisions)lines.push(`| ${safe(row.product)} | ${safe(row.reason)} |`);
  lines.push('','## Recent events','');for(const e of events.slice(0,15))lines.push(`- ${new Date(e.at).toISOString()} · ${safe(e.type)} · ${safe(e.product??e.error??e.reason??'')}`);
  lines.push('','## How to read this','',
    'The strategy budget is separate from the rest of your Coinbase balance. Preexisting holdings are not bot positions.',
    'Paper results and candle replay use modeled fills and fees. Neither is evidence of actual earnings or a profitable strategy.',
    'The 200-order daily entry gate is a ceiling, not a target. Necessary exits can exceed it. Up to two 5-USDC positions are allowed.',
    'Loss limits and stale prices block new entries. Exits require available liquidity and a working API; a stop condition cannot guarantee a sale.',
    'The local service needs this computer awake and online. This report is a snapshot; use the status command to check the process.', '');
  return lines.join('\n');
}
