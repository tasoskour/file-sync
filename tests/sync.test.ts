import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compareTrees, isMassChange } from '../src/core/compare';
import { StateDb } from '../src/core/database';
import { scanTree } from '../src/core/files';
import { applyPreview } from '../src/core/sync';
import { captureVersions } from '../src/core/versions';
import { nextRun } from '../src/core/schedule';

async function fixture(run: (source:string, backup:string, history:string, db:StateDb)=>Promise<void>) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'filesync-test-'));
  const source=path.join(root,'source'), backup=path.join(root,'backup'), history=path.join(root,'history');
  await Promise.all([fsp.mkdir(source),fsp.mkdir(backup)]);
  const db=new StateDb(path.join(root,'state.sqlite'));
  try { await run(source,backup,history,db); }
  finally {
    db.close();
    const resolved=path.resolve(root), intended=path.resolve(os.tmpdir(),'filesync-test-');
    assert.ok(resolved.startsWith(intended));
    await fsp.rm(root,{recursive:true,force:true});
  }
}

test('existing matching folders report already synced with no operations', async()=>fixture(async(source,backup,_history,db)=>{
  await Promise.all([fsp.writeFile(path.join(source,'a.txt'),'same'),fsp.writeFile(path.join(backup,'a.txt'),'same')]);
  const a=await scanTree(source), b=await scanTree(backup);
  const preview=compareTrees('pair',a,b);
  assert.equal(preview.verdict,'already-synced'); assert.equal(preview.changes.length,0);
  db.replaceEntries(a.entries,b.entries);
  assert.equal(db.baseline().size,1);
}));

test('same size and timestamps still detect different bytes',async()=>fixture(async(source,backup)=>{
  const left=path.join(source,'a.txt'),right=path.join(backup,'a.txt');
  await fsp.writeFile(left,'ABCD');await fsp.writeFile(right,'WXYZ');
  const date=new Date('2024-01-01T00:00:00Z');await Promise.all([fsp.utimes(left,date,date),fsp.utimes(right,date,date)]);
  const preview=compareTrees('pair',await scanTree(source),await scanTree(backup));
  assert.equal(preview.verdict,'different');assert.equal(preview.changes[0].kind,'replace');
}));

test('copies, renames, and deletions converge without duplicate backup files',async()=>fixture(async(source,backup,history,db)=>{
  await fsp.writeFile(path.join(source,'old.txt'),'v1');
  let left=await scanTree(source),right=await scanTree(backup);
  let plan=compareTrees('pair',left,right);
  assert.deepEqual((await applyPreview(plan,{sourceRoot:source,backupRoot:backup,historyRoot:history,db})).errors,[]);
  db.replaceEntries(left.entries,(await scanTree(backup)).entries);
  await fsp.rename(path.join(source,'old.txt'),path.join(source,'new.txt'));
  left=await scanTree(source);right=await scanTree(backup);
  plan=compareTrees('pair',left,right,db.baseline());
  assert.deepEqual(plan.renames,[{from:'old.txt',to:'new.txt'}]);
  assert.deepEqual((await applyPreview(plan,{sourceRoot:source,backupRoot:backup,historyRoot:history,db})).errors,[]);
  assert.deepEqual((await fsp.readdir(backup)).sort(),['new.txt']);
  assert.equal(db.history().length,1);
  assert.equal(db.history()[0].operation,'rename');
  assert.equal(await fsp.readFile(db.history()[0].archivePath!,'utf8'),'v1');
}));

test('backup-side edit pauses that file and keeps its content',async()=>fixture(async(source,backup,history,db)=>{
  await Promise.all([fsp.writeFile(path.join(source,'a.txt'),'source'),fsp.writeFile(path.join(backup,'a.txt'),'source')]);
  db.replaceEntries((await scanTree(source)).entries,(await scanTree(backup)).entries);
  await fsp.writeFile(path.join(backup,'a.txt'),'manual edit');
  const plan=compareTrees('pair',await scanTree(source),await scanTree(backup),db.baseline());
  assert.deepEqual(plan.conflicts,['a.txt']);
  const result=await applyPreview(plan,{sourceRoot:source,backupRoot:backup,historyRoot:history,db});
  assert.equal(result.completed,0);assert.equal(await fsp.readFile(path.join(backup,'a.txt'),'utf8'),'manual edit');
}));

test('new backup-only files after initialization are treated as external changes',async()=>fixture(async(source,backup,_history,db)=>{
  db.replaceEntries((await scanTree(source)).entries,(await scanTree(backup)).entries);
  await fsp.writeFile(path.join(backup,'outside.txt'),'not from working');
  const plan=compareTrees('pair',await scanTree(source),await scanTree(backup),db.baseline());
  assert.deepEqual(plan.conflicts,['outside.txt']);
}));

test('bulk-change guard ignores exact-content moves but catches mass deletion',()=>{
  const changes=Array.from({length:120},(_,i)=>({kind:'remove' as const,path:`old/${i}`,backup:{path:`old/${i}`,kind:'file' as const,size:1,mtimeMs:0,readonly:false,hash:String(i)}}));
  const moved=changes.map((x,i)=>({kind:'copy' as const,path:`new/${i}`,source:{...x.backup,path:`new/${i}`}}));
  const base={pairId:'p',fingerprint:'f',createdAt:'',verdict:'different' as const,renames:[],conflicts:[],warnings:[],bytesToCopy:0,bytesToArchive:0,sourceFiles:120,backupFiles:120};
  assert.equal(isMassChange({...base,changes:[...changes,...moved]},120),false);
  assert.equal(isMassChange({...base,sourceFiles:0,changes},120),true);
});

test('interval schedule is anchored to previous run',()=>{
  const last=new Date('2026-10-08T10:00:00Z');
  assert.equal(nextRun({kind:'scheduled',schedule:{kind:'interval',minutes:120}},new Date('2026-10-08T10:30:00Z'),last)?.toISOString(),'2026-10-08T12:00:00.000Z');
});

test('history off replaces and removes backup files without archiving', async()=>fixture(async(source,backup,history,db)=>{
  await Promise.all([fsp.writeFile(path.join(source,'a.txt'),'new'),fsp.writeFile(path.join(backup,'a.txt'),'old'),fsp.writeFile(path.join(backup,'gone.txt'),'bye')]);
  const preview=compareTrees('pair',await scanTree(source),await scanTree(backup));
  const result=await applyPreview(preview,{keepHistory:false,sourceRoot:source,backupRoot:backup,historyRoot:history,db});
  assert.deepEqual(result.errors,[]);
  assert.equal(await fsp.readFile(path.join(backup,'a.txt'),'utf8'),'new');
  await assert.rejects(fsp.access(path.join(backup,'gone.txt')));
  assert.equal(db.history().length,0);
  await assert.rejects(fsp.access(history));
}));

test('history records working-folder changes and deletions without any sync', async()=>fixture(async(source,backup,history,db)=>{
  const file=path.join(source,'a.txt');
  await Promise.all([fsp.writeFile(file,'v1'),fsp.writeFile(path.join(backup,'a.txt'),'v1')]);
  const capture=async()=>captureVersions({sourceRoot:source,backupRoot:backup,historyRoot:history,db,entries:(await scanTree(source)).entries,complete:true});
  assert.equal((await capture()).saved,0);               // first sight records nothing
  await fsp.writeFile(file,'v2 edited');
  assert.equal((await capture()).saved,2);               // previous version (from backup) and the new one
  await fsp.writeFile(file,'v3 edited again');
  assert.equal((await capture()).saved,1);               // each further edit is saved even with no sync in between
  await fsp.rm(file);
  assert.equal((await capture()).saved,1);               // the deleted file's last version
  const rows=db.history();
  assert.deepEqual(rows.map(x=>x.operation).sort(),['deleted','version','version','version']);
  const contents=await Promise.all(rows.map(async x=>fsp.readFile(x.archivePath!,'utf8')));
  assert.deepEqual(contents.sort(),['v1','v2 edited','v3 edited again','v3 edited again']);
  assert.equal(await fsp.readFile(path.join(backup,'a.txt'),'utf8'),'v1'); // the backup was never touched
}));
