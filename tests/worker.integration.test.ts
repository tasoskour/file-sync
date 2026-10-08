import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureFolderRoot } from '../src/windows/volume';
import { readJson, writeJsonAtomic } from '../src/core/files';
import { StateDb } from '../src/core/database';
import type { AppConfig, Preview, ServiceStatus } from '../src/shared/types';

async function waitFor<T>(file:string, check:(value:T)=>boolean, timeout=40_000):Promise<T> {
  const start=Date.now();
  while(Date.now()-start<timeout){
    const value=await readJson<T>(file).catch(()=>undefined);
    if(value&&check(value))return value;
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

test('manual worker requires initial approval, syncs on request, and protects backup edits',{timeout:90_000},async()=>{
  if(process.platform!=='win32')return;
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'filesync-worker-test-'));
  const source=path.join(root,'source'),backup=path.join(root,'backup'),data=path.join(root,'data'),owner=path.join(root,'owner');
  await Promise.all([source,backup,data,owner].map(x=>fsp.mkdir(x)));
  let child:ReturnType<typeof spawn>|undefined;
  try{
    await fsp.writeFile(path.join(source,'a.txt'),'first');
    const [sourceRoot,backupRoot]=await Promise.all([captureFolderRoot(source),captureFolderRoot(backup)]);
    const pairId=randomUUID();
    const config:AppConfig={version:2,ownerSid:'S-1-5-21-test',ownerLocalAppData:owner,pairs:[{id:pairId,name:'Test',source:sourceRoot,backup:backupRoot,mode:{kind:'manual'}}]};
    const phase=(want:(x:{phase:string;message:string})=>boolean)=>(s:ServiceStatus)=>!!s.pairs[pairId]&&want(s.pairs[pairId]);
    await writeJsonAtomic(path.join(data,'config.json'),config);
    child=spawn(process.execPath,[path.resolve('build/server/main.js'),'--service'],{env:{...process.env,FILESYNC_PROGRAM_DATA:data,FILESYNC_LOCAL_DATA:path.join(root,'manager')},windowsHide:true,stdio:'pipe'});
    const stderr:string[]=[];child.stderr?.on('data',x=>stderr.push(String(x)));
    await waitFor<ServiceStatus>(path.join(data,'status.json'),phase(x=>x.phase==='needs-review'));
    await assert.rejects(fsp.access(path.join(backup,'a.txt')));
    const preview=await readJson<Preview>(path.join(data,'previews',`${pairId}.json`));
    assert.ok(preview?.fingerprint);
    await writeJsonAtomic(path.join(owner,'FileSync','requests',`${randomUUID()}.json`),{action:'approve',pairId,fingerprint:preview.fingerprint});
    await waitFor<ServiceStatus>(path.join(data,'status.json'),phase(x=>x.phase==='in-sync'));
    assert.equal(await fsp.readFile(path.join(backup,'a.txt'),'utf8'),'first');
    await fsp.writeFile(path.join(backup,'a.txt'),'edited backup');
    await fsp.writeFile(path.join(source,'a.txt'),'new working version');
    await writeJsonAtomic(path.join(owner,'FileSync','requests',`${randomUUID()}.json`),{action:'sync-now',pairId});
    await waitFor<ServiceStatus>(path.join(data,'status.json'),phase(x=>x.phase==='needs-review'&&x.message.includes('review')));
    assert.equal(await fsp.readFile(path.join(backup,'a.txt'),'utf8'),'edited backup');
    assert.deepEqual(stderr,[]);
  }finally{
    if(child&&!child.killed){child.kill();await new Promise(resolve=>child!.once('exit',resolve));}
    const resolved=path.resolve(root),intended=path.resolve(os.tmpdir(),'filesync-worker-test-');
    assert.ok(resolved.startsWith(intended));
    await fsp.rm(root,{recursive:true,force:true});
  }
});

test('two pairs are independent: approving one leaves the other waiting',{timeout:90_000},async()=>{
  if(process.platform!=='win32')return;
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'filesync-worker-test-'));
  const data=path.join(root,'data'),owner=path.join(root,'owner');
  const dirs=['s1','b1','s2','b2'].map(x=>path.join(root,x));
  await Promise.all([data,owner,...dirs].map(x=>fsp.mkdir(x)));
  let child:ReturnType<typeof spawn>|undefined;
  try{
    await fsp.writeFile(path.join(dirs[0],'one.txt'),'one');
    await fsp.writeFile(path.join(dirs[2],'two.txt'),'two');
    const roots=await Promise.all(dirs.map(x=>captureFolderRoot(x)));
    const ids=[randomUUID(),randomUUID()];
    const config:AppConfig={version:2,ownerSid:'S-1-5-21-test',ownerLocalAppData:owner,pairs:[
      {id:ids[0],name:'One',source:roots[0],backup:roots[1],mode:{kind:'manual'}},
      {id:ids[1],name:'Two',source:roots[2],backup:roots[3],mode:{kind:'manual'}}]};
    await writeJsonAtomic(path.join(data,'config.json'),config);
    child=spawn(process.execPath,[path.resolve('build/server/main.js'),'--service'],{env:{...process.env,FILESYNC_PROGRAM_DATA:data,FILESYNC_LOCAL_DATA:path.join(root,'manager')},windowsHide:true,stdio:'pipe'});
    const statusPath=path.join(data,'status.json');
    await waitFor<ServiceStatus>(statusPath,s=>ids.every(id=>s.pairs[id]?.phase==='needs-review'));
    const preview=await readJson<Preview>(path.join(data,'previews',`${ids[0]}.json`));
    await writeJsonAtomic(path.join(owner,'FileSync','requests',`${randomUUID()}.json`),{action:'approve',pairId:ids[0],fingerprint:preview!.fingerprint});
    await waitFor<ServiceStatus>(statusPath,s=>s.pairs[ids[0]]?.phase==='in-sync');
    assert.equal(await fsp.readFile(path.join(dirs[1],'one.txt'),'utf8'),'one');
    await assert.rejects(fsp.access(path.join(dirs[3],'two.txt')));
    assert.equal((await readJson<ServiceStatus>(statusPath))!.pairs[ids[1]].phase,'needs-review');
  }finally{
    if(child&&!child.killed){child.kill();await new Promise(resolve=>child!.once('exit',resolve));}
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir(),'filesync-worker-test-')));
    await fsp.rm(root,{recursive:true,force:true});
  }
});

test('delete-history request removes the saved version and its archive file',{timeout:90_000},async()=>{
  if(process.platform!=='win32')return;
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'filesync-worker-test-'));
  const source=path.join(root,'source'),backup=path.join(root,'backup'),data=path.join(root,'data'),owner=path.join(root,'owner');
  await Promise.all([source,backup,data,owner].map(x=>fsp.mkdir(x)));
  let child:ReturnType<typeof spawn>|undefined;
  try{
    await fsp.writeFile(path.join(source,'a.txt'),'v1');
    const [sourceRoot,backupRoot]=await Promise.all([captureFolderRoot(source),captureFolderRoot(backup)]);
    const pairId=randomUUID();
    const config:AppConfig={version:2,ownerSid:'S-1-5-21-test',ownerLocalAppData:owner,pairs:[{id:pairId,name:'Test',source:sourceRoot,backup:backupRoot,mode:{kind:'manual'}}]};
    await writeJsonAtomic(path.join(data,'config.json'),config);
    child=spawn(process.execPath,[path.resolve('build/server/main.js'),'--service'],{env:{...process.env,FILESYNC_PROGRAM_DATA:data,FILESYNC_LOCAL_DATA:path.join(root,'manager')},windowsHide:true,stdio:'pipe'});
    const statusPath=path.join(data,'status.json');
    const requests=path.join(owner,'FileSync','requests');
    await waitFor<ServiceStatus>(statusPath,s=>s.pairs[pairId]?.phase==='needs-review');
    const preview=await readJson<Preview>(path.join(data,'previews',`${pairId}.json`));
    await writeJsonAtomic(path.join(requests,`${randomUUID()}.json`),{action:'approve',pairId,fingerprint:preview!.fingerprint});
    await waitFor<ServiceStatus>(statusPath,s=>s.pairs[pairId]?.phase==='in-sync');
    await fsp.writeFile(path.join(source,'a.txt'),'version two');
    await writeJsonAtomic(path.join(requests,`${randomUUID()}.json`),{action:'sync-now',pairId});
    const dbPath=path.join(data,'state',`${pairId}.sqlite`);
    const readHistory=()=>{const db=new StateDb(dbPath,true);try{return db.history();}finally{db.close();}};
    const start=Date.now();
    while(Date.now()-start<30_000&&!readHistory().length)await new Promise(r=>setTimeout(r,300));
    const [item]=readHistory();
    assert.ok(item?.archivePath);
    await fsp.access(item.archivePath);
    await writeJsonAtomic(path.join(requests,`${randomUUID()}.json`),{action:'delete-history',pairId,ids:[item.id]});
    const wait=Date.now();
    while(Date.now()-wait<30_000&&readHistory().length)await new Promise(r=>setTimeout(r,300));
    assert.equal(readHistory().length,0);
    await assert.rejects(fsp.access(item.archivePath));
  }finally{
    if(child&&!child.killed){child.kill();await new Promise(resolve=>child!.once('exit',resolve));}
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir(),'filesync-worker-test-')));
    await fsp.rm(root,{recursive:true,force:true});
  }
});
