import {spawn} from 'node:child_process';import {mkdirSync,openSync,closeSync,existsSync} from 'node:fs';import {resolve,dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';import {setTimeout as sleep} from 'node:timers/promises';import {DatabaseSync} from 'node:sqlite';import {acquireLock} from '../operations.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),runtime=join(root,'runtime','coinbase-paper');mkdirSync(runtime,{recursive:true});
const lock=await acquireLock(join(runtime,'supervisor'));let stopping=false,child;
for(const name of ['SIGINT','SIGTERM'])process.once(name,()=>{stopping=true;child?.kill();});
try{while(!stopping){
 if(existsSync(join(runtime,'ledger.sqlite'))){const db=new DatabaseSync(join(runtime,'ledger.sqlite'),{readOnly:true});const command=db.prepare('SELECT command FROM control WHERE id=1').get()?.command;db.close();if(command==='stop')break;}
 const fd=openSync(join(runtime,'worker.log'),'a');child=spawn(process.execPath,[join(root,'src','cb','cli.mjs'),'run','--mode','paper'],{cwd:root,windowsHide:true,stdio:['ignore',fd,fd]});closeSync(fd);
 const exit=await new Promise(r=>{child.once('error',()=>r(1));child.once('exit',code=>r(code));});if(exit===0)break;await sleep(10000);
}}finally{await new Promise(r=>lock.close(r));}
