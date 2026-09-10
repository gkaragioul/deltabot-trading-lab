import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PublicBooks,BookArchive} from '../src/cb/orderbook.mjs';

const at=Date.parse('2026-09-10T12:00:00Z');
const message=(sequence,events,channel='l2_data')=>({channel,sequence_num:sequence,timestamp:new Date(at).toISOString(),events});
const snapshot={type:'snapshot',product_id:'BTC-USD',updates:[{side:'bid',price_level:'100.00',new_quantity:'2'},{side:'offer',price_level:'101',new_quantity:'3'}]};

test('book updates replace quantities, canonicalize prices, and remove zero levels',()=>{
 const feed=new PublicBooks(['BTC-USD']);feed.ingest(message(0,[],'subscriptions'),at);feed.ingest(message(1,[snapshot]),at);
 feed.ingest(message(2,[{type:'update',product_id:'BTC-USD',updates:[{side:'bid',price_level:'100',new_quantity:'1'}]}]),at);
 const book=feed.snapshot('BTC-USDC',at);assert.deepEqual(book.bids,[{price:'100',size:'1'}]);assert.equal(book.sourceProduct,'BTC-USD');assert.equal(book.id,'BTC-USDC');
 feed.ingest(message(3,[{type:'update',product_id:'BTC-USD',updates:[{side:'offer',price_level:'101',new_quantity:'0'},{side:'offer',price_level:'102',new_quantity:'4'}]}]),at);
 assert.equal(feed.snapshot('BTC-USDC',at).asks[0].price,'102');
});

test('heartbeats participate in sequencing; gaps and old updates invalidate all books',()=>{
 const feed=new PublicBooks(['BTC-USD']);feed.ingest(message(0,[snapshot]),at);feed.ingest(message(1,[],'heartbeats'),at);
 feed.ingest(message(2,[]),at);assert.equal(feed.snapshot('BTC-USDC',at).bids[0].price,'100');
 assert.throws(()=>feed.ingest(message(4,[]),at),/SEQUENCE_GAP/);assert.throws(()=>feed.snapshot('BTC-USDC',at),/BOOK_UNAVAILABLE/);
 feed.reset();assert.throws(()=>feed.ingest(message(0,[{type:'update',product_id:'BTC-USD',updates:[]}]),at),/UPDATE_BEFORE_SNAPSHOT/);
});

test('stale, crossed and malformed books never become usable quotes',()=>{
 const feed=new PublicBooks(['BTC-USD']);feed.ingest(message(0,[snapshot]),at);
 assert.throws(()=>feed.snapshot('BTC-USDC',at+11000),/STALE/);
 assert.throws(()=>feed.ingest(message(1,[{...snapshot,updates:[{side:'bid',price_level:'-1',new_quantity:'2'}]}]),at),/INVALID/);
 assert.throws(()=>feed.snapshot('BTC-USDC',at),/BOOK_UNAVAILABLE/);
 const bad=new PublicBooks(['BTC-USD']);bad.ingest(message(0,[{...snapshot,updates:[{side:'bid',price_level:'102',new_quantity:'2'},{side:'offer',price_level:'101',new_quantity:'2'}]}]),at);
 assert.throws(()=>bad.snapshot('BTC-USDC',at),/CROSSED/);
});

test('archive lookup never uses a future sample or a book across a disconnect',()=>{
 const dir=mkdtempSync(join(tmpdir(),'cb-books-'));const db=new BookArchive(dir);
 try{const feed=new PublicBooks(['BTC-USD']);feed.ingest(message(0,[snapshot]),at);const book=feed.snapshot('BTC-USDC',at);
  db.event(at,'connected','epoch');db.record([book],at,'epoch',0);
  assert.throws(()=>db.at('BTC-USDC',at-1),/NO_RECORDED_BOOK/);assert.equal(db.at('BTC-USDC',at+1).bids[0].price,'100');
  db.event(at+100,'disconnected','epoch');assert.throws(()=>db.at('BTC-USDC',at+101),/NO_RECORDED_BOOK/);
  db.event(at+200,'connected','next');assert.throws(()=>db.at('BTC-USDC',at+201),/NO_RECORDED_BOOK/);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('archive checks original exchange freshness and trims samples before reaching its size cap',()=>{
 const dir=mkdtempSync(join(tmpdir(),'cb-book-cap-'));const db=new BookArchive(dir,{maxPages:64});
 try{const feed=new PublicBooks(['BTC-USD']);feed.ingest(message(0,[snapshot]),at);const book=feed.snapshot('BTC-USDC',at);db.event(at,'connected','epoch');
  db.record([{...book,exchangeAt:at-9500}],at,'epoch',0);assert.throws(()=>db.at('BTC-USDC',at+1000),/NO_RECORDED_BOOK/);
  for(let i=1;i<500;i++)db.record([{...book,padding:'x'.repeat(3000)}],at+i,'epoch',i);
  assert.ok(db.stats(at+500)[0].samples<500);assert.equal(db.at('BTC-USDC',at+500).bids[0].price,'100');
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
