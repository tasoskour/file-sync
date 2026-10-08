import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FileEntry } from '../shared/types';
import { StateDb, type HistoryItem } from './database';
import { message, sha256 } from './files';

export const HISTORY_HOURS = 168;

/** Archived content is stored once per SHA-256, so identical versions share one file. */
export function storePath(historyRoot: string, hash: string): string { return path.join(historyRoot, `${hash}.bin`); }

export async function fileExists(file: string): Promise<boolean> {
  try { await fsp.lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Copies a file into the store and verifies its hash. Returns false when that content was already stored. */
export async function storeCopy(file: string, expectedHash: string, historyRoot: string): Promise<boolean> {
  const destination = storePath(historyRoot, expectedHash);
  if (await fileExists(destination)) return false;
  await fsp.mkdir(historyRoot, { recursive: true });
  const temporary = `${destination}.tmp-${randomUUID()}`;
  try {
    await pipeline(fs.createReadStream(file), fs.createWriteStream(temporary, { flags: 'wx' }));
    if (await sha256(temporary) !== expectedHash) throw new Error('File changed while it was being saved to history');
    await fsp.rename(temporary, destination);
    return true;
  } finally { await fsp.rm(temporary, { force: true }).catch(() => undefined); }
}

export function historyRow(id: string, relative: string, operation: string, archivePath?: string, hash?: string, metadata?: string): HistoryItem {
  const now = Date.now();
  return { id, path: relative, operation, archivePath, hash, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + HISTORY_HOURS * 3600_000).toISOString(), metadata };
}

/** Removes an archive file once no history entry refers to it any more. */
export async function releaseArchive(db: StateDb, archivePath?: string): Promise<void> {
  if (archivePath && db.archiveReferences(archivePath) === 0) await fsp.rm(archivePath, { force: true }).catch(() => undefined);
}

export interface CaptureOptions {
  sourceRoot: string;
  backupRoot: string;
  historyRoot: string;
  db: StateDb;
  entries: Map<string, FileEntry>;
  /** False when the scan could not read everything, so a missing file may not really be deleted. */
  complete: boolean;
}

/**
 * Records changes made in the working folder. Every new version of a changed working file is saved,
 * and so is the last version of a deleted one, whether or not any sync is running.
 */
export async function captureVersions(options: CaptureOptions): Promise<{ saved: number; errors: string[] }> {
  const { db, entries, historyRoot } = options;
  const tracked = db.tracked();
  const errors: string[] = [];
  let saved = 0;
  const now = new Date().toISOString();

  const save = async (relative: string, hash: string, operation: string, from: string): Promise<boolean> => {
    await storeCopy(from, hash, historyRoot);
    db.addHistory(historyRow(randomUUID(), relative, operation, storePath(historyRoot, hash), hash));
    saved++;
    return true;
  };
  /** Makes sure a previous version's content is stored, taking it from the backup copy when that still matches. */
  const preserveFromBackup = async (relative: string, hash: string, withRow: boolean): Promise<void> => {
    if (await fileExists(storePath(historyRoot, hash))) return;
    const backupFile = path.join(options.backupRoot, ...relative.split('/'));
    if (!(await fileExists(backupFile)) || await sha256(backupFile) !== hash) return;
    if (!withRow) { await storeCopy(backupFile, hash, historyRoot); return; }
    await storeCopy(backupFile, hash, historyRoot);
    // Dated a millisecond earlier so it lists just below the edit that replaced it.
    db.addHistory({ ...historyRow(randomUUID(), relative, 'original', storePath(historyRoot, hash), hash), createdAt: new Date(Date.now() - 1).toISOString() });
    saved++;
  };

  const track: Array<[string, string]> = [];
  const untrack: string[] = [];
  for (const [relative, entry] of entries) {
    if (entry.kind !== 'file' || !entry.hash) continue;
    const known = tracked.get(relative);
    if (!known) { track.push([relative, entry.hash]); continue; }
    if (known.hash === entry.hash) continue;
    try {
      await preserveFromBackup(relative, known.hash, true);
      if (!(await fileExists(storePath(historyRoot, entry.hash)))) await save(relative, entry.hash, 'version', path.join(options.sourceRoot, ...relative.split('/')));
      else { db.addHistory(historyRow(randomUUID(), relative, 'version', storePath(historyRoot, entry.hash), entry.hash)); saved++; }
      track.push([relative, entry.hash]);
    } catch (error) { errors.push(`${relative}: ${message(error)}`); }
  }
  if (options.complete) {
    for (const [relative, known] of tracked) {
      if (entries.has(relative)) continue;
      try {
        await preserveFromBackup(relative, known.hash, false);
        if (await fileExists(storePath(historyRoot, known.hash))) { db.addHistory(historyRow(randomUUID(), relative, 'deleted', storePath(historyRoot, known.hash), known.hash)); saved++; }
        untrack.push(relative);
      } catch (error) { errors.push(`${relative}: ${message(error)}`); }
    }
  }
  // Applied together at the end so a large first scan is one transaction.
  db.transaction(() => { for (const [relative, hash] of track) db.setTracked(relative, hash, now); for (const relative of untrack) db.deleteTracked(relative); });
  return { saved, errors };
}
