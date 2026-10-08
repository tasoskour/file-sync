import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { PlannedChange, Preview } from '../shared/types';
import { StateDb } from './database';
import { message, sha256 } from './files';
import { fileExists, historyRow, releaseArchive, storeCopy, storePath } from './versions';

export interface ApplyOptions { keepHistory?: boolean; sourceRoot: string; backupRoot: string; historyRoot: string; db: StateDb; onProgress?: (done: number, total: number, path: string) => void }

export async function applyPreview(preview: Preview, options: ApplyOptions): Promise<{completed:number;errors:string[]}> {
  const conflicts = new Set(preview.conflicts);
  const errors: string[] = [];
  let completed = 0;
  const ordered = [...preview.changes].sort((a, b) => rank(a) - rank(b) || (a.kind === 'rmdir' ? b.path.length - a.path.length : a.path.length - b.path.length));
  for (const change of ordered) {
    if (conflicts.has(change.path)) { errors.push(`${change.path}: backup changed outside FileSync`); continue; }
    try { await applyOne(change, options); options.db.recordApplied(change); completed++; }
    catch (error) { errors.push(`${change.path}: ${message(error)}`); }
    options.onProgress?.(completed, ordered.length, change.path);
  }
  return { completed, errors };
}

function rank(change: PlannedChange): number {
  return change.kind === 'remove' ? 0 : change.kind === 'rmdir' ? 1 : change.kind === 'mkdir' ? 2 : change.kind === 'metadata' ? 4 : 3;
}

async function applyOne(change: PlannedChange, options: ApplyOptions): Promise<void> {
  const source = path.join(options.sourceRoot, ...change.path.split('/'));
  const backup = path.join(options.backupRoot, ...change.path.split('/'));
  const id = randomUUID();
  const stage = `${backup}.filesync-stage-${id}`;
  options.db.startJournal(id, change.path, change.kind, stage);
  try {
    if (change.kind === 'mkdir') {
      if (change.backup?.kind === 'file') { await assertBackupUnchanged(backup, change.backup); await archive(backup, change, id, options); await fsp.unlink(backup); }
      await fsp.mkdir(backup, { recursive: true });
    }
    else if (change.kind === 'rmdir') { await fsp.rmdir(backup); }
    else if (change.kind === 'remove') {
      await assertBackupUnchanged(backup, change.backup);
      await archive(backup, change, id, options);
      await fsp.unlink(backup);
    } else if (change.kind === 'metadata') {
      await assertBackupUnchanged(backup, change.backup);
      await setMetadata(backup, change.source!);
      if (options.keepHistory !== false) options.db.addHistory(historyRow(id, change.path, 'metadata', undefined, undefined, JSON.stringify(change.backup)));
    } else {
      if (!change.source || change.source.kind !== 'file') throw new Error('Invalid source file');
      await fsp.mkdir(path.dirname(backup), { recursive: true });
      await assertSourceUnchanged(source, change.source);
      if (change.backup?.kind === 'dir') {
        if ((await fsp.readdir(backup)).length) throw new Error('Backup folder changed while syncing; review required');
      } else if (change.backup) await assertBackupUnchanged(backup, change.backup);
      await pipeline(fs.createReadStream(source), fs.createWriteStream(stage, { flags: 'wx' }));
      if (await sha256(stage) !== change.source.hash) throw new Error('Source changed during copy; retry on next scan');
      await assertSourceUnchanged(source, change.source);
      if (change.backup?.kind === 'dir') {
        if ((await fsp.readdir(backup)).length) throw new Error('Backup folder changed while syncing; review required');
        await fsp.rmdir(backup);
      } else if (change.backup) {
        await assertBackupUnchanged(backup, change.backup);
        await archive(backup, change, id, options);
      } else if (await exists(backup)) throw new Error('Backup changed during copy; review required');
      await fsp.rename(stage, backup);
      await setMetadata(backup, change.source);
    }
    options.db.finishJournal(id);
  } finally { await fsp.rm(stage, { force: true }).catch(() => undefined); }
}

async function assertSourceUnchanged(file: string, expected: NonNullable<PlannedChange['source']>): Promise<void> {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.size !== expected.size || Math.abs(stat.mtimeMs - expected.mtimeMs) > 2) throw new Error('Working file changed during sync; retrying');
}
async function assertBackupUnchanged(file: string, expected?: PlannedChange['backup']): Promise<void> {
  if (!expected) return;
  const stat = await fsp.lstat(file);
  if (expected.kind !== 'file' || !stat.isFile() || await sha256(file) !== expected.hash) throw new Error('Backup changed outside FileSync; review required');
}
/** Saves the backup file that is about to be replaced or removed, unless history already holds that exact content. */
async function archive(file: string, change: PlannedChange, id: string, options: ApplyOptions): Promise<void> {
  if (options.keepHistory === false) return;
  const hash = change.backup?.hash;
  if (!hash) throw new Error('Backup file has no content hash');
  const renamedTo = change.reason?.startsWith('renamed-to:') ? change.reason.slice('renamed-to:'.length) : undefined;
  if (!renamedTo && await fileExists(storePath(options.historyRoot, hash))) return;
  try { await storeCopy(file, hash, options.historyRoot); }
  catch (error) { throw new Error(error instanceof Error && error.message.includes('changed') ? 'Backup changed while archiving' : message(error)); }
  options.db.addHistory(historyRow(id, change.path, renamedTo ? 'rename' : change.kind, storePath(options.historyRoot, hash), hash, renamedTo ? JSON.stringify({ from: change.path, to: renamedTo }) : undefined));
}
async function setMetadata(file: string, entry: NonNullable<PlannedChange['source']>): Promise<void> {
  await fsp.utimes(file, new Date(), new Date(entry.mtimeMs));
  await fsp.chmod(file, entry.readonly ? 0o444 : 0o666);
}
async function exists(file: string): Promise<boolean> { try { await fsp.lstat(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }

export async function recoverJournal(db: StateDb): Promise<void> {
  for (const item of db.unfinished()) {
    if (item.stagePath) await fsp.rm(item.stagePath, { force: true }).catch(() => undefined);
    db.finishJournal(item.id);
  }
}

export async function purgeExpired(db: StateDb): Promise<void> {
  for (const item of db.expired(new Date().toISOString())) {
    db.deleteHistory(item.id);
    await releaseArchive(db, item.archivePath);
  }
}
