import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { signCoinbaseRequest } from '../coinbase.mjs';
const base='/api/v3/brokerage';
const reads=/^\/api\/v3\/brokerage\/(accounts|key_permissions|transaction_summary|products|product_book|best_bid_ask|products\/[A-Z0-9-]+(\/candles)?|orders\/historical\/(batch|fills|[a-zA-Z0-9-]+))$/;
const writes=new Set([`${base}/orders`,`${base}/orders/preview`]);
export class CoinbaseApi {
  constructor(credentials,{fetchFn=fetch,allowOrders=false,paceMs=180}={}) {
    this.credentials=credentials;this.fetch=fetchFn;this.allowOrders=allowOrders;this.paceMs=paceMs;this.queue=Promise.resolve();this.nextAt=0;
  }
  static local(options={}) {
    try { return new CoinbaseApi(JSON.parse(readFileSync(process.env.COINBASE_KEY_FILE,'utf8')),options); }
    catch {throw new Error('COINBASE_KEY_FILE_UNREADABLE');}
  }
  async request(method,path,params={}) {
    if (!((method==='GET' && reads.test(path)) || (method==='POST' && writes.has(path)))) throw new Error('ENDPOINT_NOT_ALLOWED');
    if (path===`${base}/orders` && !this.allowOrders) throw new Error('LIVE_SUBMISSION_DISABLED');
    const task=this.queue.then(async()=>{
      const delay=Math.max(0,this.nextAt-Date.now());if(delay)await sleep(delay);this.nextAt=Date.now()+this.paceMs;
      const qs=method==='GET'?new URLSearchParams(params).toString():'';
      const token=signCoinbaseRequest(this.credentials,method,path);
      let r;
      try {r=await this.fetch(`https://api.coinbase.com${path}${qs?'?'+qs:''}`,{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(params)}:{})});}
      catch {throw new Error('COINBASE_NETWORK_UNAVAILABLE');}
      if(!r.ok)throw new Error(`COINBASE_HTTP_${r.status}`);
      const body=await r.text();if(body.length>8000000)throw new Error('COINBASE_RESPONSE_TOO_LARGE');
      try{return JSON.parse(body);}catch{throw new Error('COINBASE_INVALID_JSON');}
    });
    this.queue=task.then(()=>{},()=>{});return task;
  }
  get(path,params={}) {return this.request('GET',base+path,params);}
  async paged(path,key,params={}) {
    const all=[];const seen=new Set();let cursor;
    for(let n=0;n<100;n++){
      const r=await this.get(path,{limit:'250',...params,...(cursor?{cursor}:{})});
      if(!Array.isArray(r[key]) || typeof r.has_next!=='boolean')throw new Error('INVALID_PAGINATED_RESPONSE');
      all.push(...r[key]);if(!r.has_next)return all;
      if(!r.cursor || seen.has(r.cursor))throw new Error('INVALID_PAGINATION');cursor=r.cursor;seen.add(cursor);
    }throw new Error('PAGINATION_LIMIT');
  }
  accounts(){return this.paged('/accounts','accounts');}
  orders(params={}){return this.paged('/orders/historical/batch','orders',params);}
  permissions(){return this.get('/key_permissions');}
  fees(){return this.get('/transaction_summary');}
  async products(){
    const rows=[];for(let offset=0;offset<10000;offset+=250){
      const r=await this.get('/products',{product_type:'SPOT',limit:'250',offset:String(offset)});
      if(!Array.isArray(r.products))throw new Error('INVALID_PRODUCTS');rows.push(...r.products);
      if(r.products.length<250)return rows;
    }throw new Error('PRODUCT_PAGINATION_LIMIT');
  }
  product(id){return this.get('/products/'+id);}
  book(id){return this.get('/product_book',{product_id:id,limit:'20'});}
  candles(id,start,end){return this.get(`/products/${id}/candles`,{start:String(start),end:String(end),granularity:'ONE_MINUTE',limit:'350'});}
  preview(body){return this.request('POST',base+'/orders/preview',body);}
  submit(body){return this.request('POST',base+'/orders',body);}
  async order(id){return (await this.get('/orders/historical/'+id)).order;}
}
