import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {d,f} from './decimal.mjs';
import {normalizeBook} from './market.mjs';

export class PublicBooks {
  constructor(products,{maxLevels=100000,maxAgeMs=10000}={}){
    if(!Array.isArray(products)||!products.length||products.some(p=>!/^[A-Z0-9]+-USD$/.test(p)))throw new Error('INVALID_FEED_PRODUCTS');
    this.products=new Set(products);this.maxLevels=maxLevels;this.maxAgeMs=maxAgeMs;this.reset();
  }
  reset(){this.books=new Map();this.sequence=null;this.receivedAt=0;this.exchangeAt=0;}
  ingest(message,now=Date.now()){
    try{
      if(message.type==='error')throw new Error('WS_SERVER_ERROR');
      const seq=message.sequence_num,at=Date.parse(message.timestamp);
      if(!Number.isSafeInteger(seq)||seq<0||!Number.isFinite(at)||at>now+2000||now-at>this.maxAgeMs)throw new Error('INVALID_OR_STALE_FEED_MESSAGE');
      if(this.sequence!==null&&seq===this.sequence)return;
      if(this.sequence!==null&&seq!==this.sequence+1)throw new Error('WS_SEQUENCE_GAP');
      if(message.channel==='l2_data'){
        if(!Array.isArray(message.events))throw new Error('INVALID_BOOK_EVENTS');
        for(const event of message.events){
          if(!this.products.has(event.product_id))throw new Error('UNEXPECTED_FEED_PRODUCT');
          if(!['snapshot','update'].includes(event.type)||!Array.isArray(event.updates)||event.updates.length>150000)throw new Error('INVALID_BOOK_EVENT');
          let book=this.books.get(event.product_id);
          if(event.type==='snapshot')book={bids:new Map(),asks:new Map(),changedAt:at};
          if(!book)throw new Error('UPDATE_BEFORE_SNAPSHOT');
          for(const update of event.updates){
            if(!['bid','offer'].includes(update.side))throw new Error('INVALID_BOOK_SIDE');
            const price=d(update.price_level),quantity=d(update.new_quantity);
            if(price<=0n||quantity<0n)throw new Error('INVALID_BOOK_LEVEL');
            const key=f(price),side=update.side==='bid'?book.bids:book.asks;
            if(quantity===0n)side.delete(key);else side.set(key,{price:key,size:f(quantity),rawPrice:price});
          }
          if(book.bids.size+book.asks.size>this.maxLevels)throw new Error('BOOK_MEMORY_LIMIT');
          book.changedAt=at;this.books.set(event.product_id,book);
        }
      }
      this.sequence=seq;this.receivedAt=now;this.exchangeAt=at;
    }catch(e){this.reset();throw e;}
  }
  snapshot(product,now=Date.now(),depth=20){
    const source=product.replace(/-USDC$/,'-USD'),book=this.books.get(source);
    if(!book)throw new Error('BOOK_UNAVAILABLE');
    if(now-this.receivedAt>this.maxAgeMs)throw new Error('STALE_PUBLIC_BOOK');
    const rows=(side,descending)=>[...side.values()].sort((a,b)=>a.rawPrice===b.rawPrice?0:(a.rawPrice>b.rawPrice?1:-1)*(descending?-1:1)).slice(0,depth).map(({price,size})=>({price,size}));
    const normalized=normalizeBook({pricebook:{product_id:product,time:new Date(this.exchangeAt).toISOString(),bids:rows(book.bids,true),asks:rows(book.asks,false)}},product,now,{maxBookAgeSeconds:this.maxAgeMs/1000});
    return {...normalized,at:now,exchangeAt:this.exchangeAt,bookChangedAt:book.changedAt,sourceProduct:source,source:'coinbase-public-level2',sequence:this.sequence};
  }
}

export class BookArchive {
  constructor(dir,{readOnly=false,maxPages=131072}={}){
    if(!readOnly)mkdirSync(dir,{recursive:true});
    this.db=new DatabaseSync(join(dir,'books.sqlite'),{readOnly});
    if(!Number.isInteger(maxPages)||maxPages<32||maxPages>131072)throw new Error('INVALID_ARCHIVE_CAPACITY');
    this.maxPages=maxPages;
    if(!readOnly)this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA max_page_count=${maxPages};
      CREATE TABLE IF NOT EXISTS samples(id INTEGER PRIMARY KEY,observed INTEGER NOT NULL,product TEXT NOT NULL,epoch TEXT NOT NULL,sequence INTEGER NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS samples_lookup ON samples(product,observed DESC);
      CREATE INDEX IF NOT EXISTS samples_time ON samples(observed);
      CREATE TABLE IF NOT EXISTS feed_events(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,type TEXT NOT NULL,epoch TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS feed_events_time ON feed_events(at DESC);
      CREATE TABLE IF NOT EXISTS control(id INTEGER PRIMARY KEY CHECK(id=1),stopped INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS recorder_state(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);`);
  }
  event(at,type,epoch){this.db.prepare('INSERT INTO feed_events(at,type,epoch) VALUES(?,?,?)').run(at,type,epoch);}
  record(books,observed,epoch,sequence){
    this.trimCapacity();
    this.db.exec('BEGIN IMMEDIATE');
    try{const put=this.db.prepare('INSERT INTO samples(observed,product,epoch,sequence,json) VALUES(?,?,?,?,?)');for(const book of books)put.run(observed,book.id,epoch,sequence,JSON.stringify(book));this.db.exec('COMMIT');}
    catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  at(product,asOf,maxAgeMs=10000){
    const health=this.db.prepare('SELECT * FROM feed_events WHERE at<=? ORDER BY at DESC,id DESC LIMIT 1').get(asOf);
    if(!health||health.type!=='connected')throw new Error('NO_RECORDED_BOOK');
    const row=this.db.prepare('SELECT * FROM samples WHERE product=? AND epoch=? AND observed<=? AND observed>=? ORDER BY observed DESC,id DESC LIMIT 1').get(product,health.epoch,asOf,asOf-maxAgeMs);
    if(!row)throw new Error('NO_RECORDED_BOOK');const book=JSON.parse(row.json);
    if(!Number.isFinite(book.exchangeAt)||asOf-book.exchangeAt>maxAgeMs)throw new Error('NO_RECORDED_BOOK');return book;
  }
  trimCapacity(){
    const used=this.db.prepare('PRAGMA page_count').get().page_count-this.db.prepare('PRAGMA freelist_count').get().freelist_count;
    if(used>=this.maxPages*0.8)this.db.exec('DELETE FROM samples WHERE id IN (SELECT id FROM samples ORDER BY observed,id LIMIT 5000)');
  }
  setState(state){this.db.prepare('INSERT INTO recorder_state(id,json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify(state));}
  state(){return JSON.parse(this.db.prepare('SELECT json FROM recorder_state WHERE id=1').get()?.json??'{}');}
  prune(now=Date.now()){
    const cutoff=now-7*86400000;this.db.prepare('DELETE FROM samples WHERE observed<?').run(cutoff);
    this.db.prepare('DELETE FROM feed_events WHERE at<? AND id NOT IN (SELECT id FROM feed_events WHERE at<? ORDER BY at DESC,id DESC LIMIT 1)').run(cutoff,cutoff);
  }
  stats(now=Date.now()){
    return this.db.prepare("SELECT product,COUNT(*) samples,MIN(observed) first,MAX(observed) last,AVG(json_extract(json,'$.spreadBps')) meanSpreadBps FROM samples WHERE observed>=? GROUP BY product").all(now-3600000);
  }
  stop(value=true){this.db.prepare('INSERT INTO control(id,stopped) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET stopped=excluded.stopped').run(value?1:0);}
  stopped(){return !!this.db.prepare('SELECT stopped FROM control WHERE id=1').get()?.stopped;}
  close(){this.db.close();}
}
