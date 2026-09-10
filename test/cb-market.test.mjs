import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeBook,closedCandles,eligible,signal,buildIntent} from '../src/cb/market.mjs';
import {settings} from '../src/cb/config.mjs';
export const product={product_id:'TEST-USDC',base_currency_id:'TEST',quote_currency_id:'USDC',product_type:'SPOT',status:'online',base_increment:'0.001',price_increment:'0.01',quote_increment:'0.01',base_min_size:'0.001',base_max_size:'1000000',quote_min_size:'1',quote_max_size:'1000000',approximate_quote_24h_volume:'10000000'};
test('books must be fresh, ordered and deep enough for bounded orders',()=>{
 const c=settings();const now=Date.now();const raw={pricebook:{product_id:product.product_id,time:new Date(now).toISOString(),bids:[{price:'9.99',size:'100'}],asks:[{price:'10',size:'100'}]}};
 const b=normalizeBook(raw,product.product_id,now,c);const buy=buildIntent(product,b,'BUY','5','0.012',c);
 assert.ok(Number(buy.maxCost)<=5);assert.ok(Number(buy.quantity)>0);assert.equal(buy.body.order_configuration.sor_limit_ioc.limit_price,'10.03');
 assert.throws(()=>normalizeBook({...raw,pricebook:{...raw.pricebook,time:new Date(now-60000).toISOString()}},product.product_id,now,c),/STALE_BOOK/);
 assert.throws(()=>buildIntent(product,{...b,asks:[{price:'10',size:'0.01'}]},'BUY','5','0.012',c),/INSUFFICIENT_DEPTH/);
});
test('closed candles exclude future information, duplicates and incomplete bars',()=>{
 const rows=Array.from({length:40},(_,i)=>({start:String(1000+i*60),open:'10',high:'11',low:'9',close:'10',volume:'100'}));
 const result=closedCandles([...rows,rows[0]],(1000+35*60)*1000);assert.equal(result.length,35);assert.equal(result.at(-1).start,3040);
 assert.equal(signal(result,settings()).enter,false);
 assert.equal(eligible({...product,trading_disabled:true},settings()),false);
 assert.equal(eligible({...product,product_type:'FUTURE'},settings()),false);
});
