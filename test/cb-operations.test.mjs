import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {execFileSync} from 'node:child_process';
import {Store} from '../src/store.mjs';import {settings} from '../src/cb/config.mjs';import {initialLedger} from '../src/cb/execution.mjs';
import {acquireLock} from '../src/operations.mjs';import {liveLockPath,requestStop} from '../src/cb/operations.mjs';
const cli=resolve('src/cb/cli.mjs');
test('Coinbase controls survive CLI restarts and an inactive live run cannot create a ledger',()=>{
 const dir=mkdtempSync(join(tmpdir(),'cb-cli-')),c=settings();
 const run=(...args)=>execFileSync(process.execPath,[cli,...args,'--runtime',dir],{encoding:'utf8',env:{...process.env,COINBASE_LIVE_TRADING:''},stdio:'pipe'});
 try{
  assert.throws(()=>run('run','--mode','live'),e=>e.status===1&&String(e.stderr).includes('LIVE_REQUIRES_EXPLICIT_OPERATOR_ACTIVATION'));
  assert.equal(existsSync(join(dir,'ledger.sqlite')),false);
  let db=new Store(dir,c);db.save(initialLedger(c,'paper'),[]);db.close();
  run('pause');assert.match(run('status'),/OPERATOR_PAUSE/);
  run('resume');assert.match(run('status'),/enabled when a signal qualifies/);
  run('stop');assert.match(run('run','--cycles','1'),/Stopped by operator/);
  db=new Store(dir,c);assert.equal(db.read().scans,0);assert.equal(db.getCommand(),'stop');db.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('one shared live lock excludes a second worker independent of runtime selection',async()=>{
 const lock=await acquireLock(liveLockPath);
 try{await assert.rejects(acquireLock(liveLockPath),/WORKER_ALREADY_RUNNING/);}finally{await new Promise(r=>lock.close(r));}
 const next=await acquireLock(liveLockPath);await new Promise(r=>next.close(r));
});
test('shutdown publishes a durable stop visible to final execution guards',()=>{
 let command=null;const abort=new AbortController();requestStop({command:c=>{command=c;}},abort);
 assert.equal(command,'stop');assert.equal(abort.signal.aborted,true);
});
