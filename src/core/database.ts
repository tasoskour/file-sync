import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { FileEntry, PlannedChange } from '../shared/types';
import type { Baseline } from './compare';

export interface HistoryItem {
  id: string; path: string; operation: string; archivePath?: string; hash?: string;
  createdAt: string; expiresAt: string; metadata?: string;
}

export class StateDb {
  private readonly db: DatabaseSync;
  constructor(filename: string, readonly = false) {
    if (!readonly) fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename, { readOnly: readonly });
    if (readonly) return;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries (path TEXT PRIMARY KEY, sourceHash TEXT, backupHash TEXT, backupKind TEXT NOT NULL, sourceIno TEXT, sourceSize INTEGER, sourceMtime REAL, backupMtime REAL);
      CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, path TEXT NOT NULL, operation TEXT NOT NULL, archivePath TEXT, hash TEXT, createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL, metadata TEXT);
      CREATE TABLE IF NOT EXISTS journal (id TEXT PRIMARY KEY, path TEXT NOT NULL, operation TEXT NOT NULL, stagePath TEXT, startedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tracked (path TEXT PRIMARY KEY, hash TEXT NOT NULL, seenAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_samples (at TEXT PRIMARY KEY, rss INTEGER NOT NULL, heapUsed INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS history_created ON history(createdAt DESC);`);
  }
  close(): void { this.db.close(); }
  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined;
    return row?.value;
  }
  setMeta(key: string, value: string): void { this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  baseline(): Baseline {
    const map: Baseline = new Map();
    for (const row of this.db.prepare('SELECT path,backupHash,backupKind,sourceIno FROM entries').all() as Array<{path:string;backupHash?:string;backupKind:string;sourceIno?:string}>) {
      map.set(row.path, { backupHash: row.backupHash || undefined, backupKind: row.backupKind, sourceIno: row.sourceIno || undefined });
    }
    return map;
  }
  resetPair(pairId: string): void {
    this.db.exec('DELETE FROM entries; DELETE FROM journal; DELETE FROM tracked;');
    this.setMeta('pairId', pairId);
    this.setMeta('initialized', '0');
  }
  replaceEntries(source: Map<string, FileEntry>, backup: Map<string, FileEntry>): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM entries');
      const put = this.db.prepare('INSERT INTO entries(path,sourceHash,backupHash,backupKind,sourceIno,sourceSize,sourceMtime,backupMtime) VALUES(?,?,?,?,?,?,?,?)');
      for (const [relative, left] of source) {
        const right = backup.get(relative);
        if (right) put.run(relative, left.hash || null, right.hash || null, right.kind, left.ino || null, left.size, left.mtimeMs, right.mtimeMs);
      }
      this.setMeta('initialized', '1');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recordApplied(change: PlannedChange): void {
    if (change.kind === 'remove' || change.kind === 'rmdir') {
      this.db.prepare('DELETE FROM entries WHERE path=?').run(change.path);
      return;
    }
    if (!change.source) return;
    this.db.prepare(`INSERT INTO entries(path,sourceHash,backupHash,backupKind,sourceIno,sourceSize,sourceMtime,backupMtime)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET
      sourceHash=excluded.sourceHash,backupHash=excluded.backupHash,backupKind=excluded.backupKind,
      sourceIno=excluded.sourceIno,sourceSize=excluded.sourceSize,sourceMtime=excluded.sourceMtime,backupMtime=excluded.backupMtime`)
      .run(change.path, change.source.hash || null, change.source.hash || null, change.source.kind,
        change.source.ino || null, change.source.size, change.source.mtimeMs, change.source.mtimeMs);
  }
  startJournal(id: string, relative: string, operation: string, stagePath?: string): void {
    this.db.prepare('INSERT OR REPLACE INTO journal VALUES(?,?,?,?,?)').run(id, relative, operation, stagePath || null, new Date().toISOString());
  }
  finishJournal(id: string): void { this.db.prepare('DELETE FROM journal WHERE id=?').run(id); }
  unfinished(): Array<{id:string;stagePath?:string}> { return this.db.prepare('SELECT id,stagePath FROM journal').all() as Array<{id:string;stagePath?:string}>; }
  addHistory(item: HistoryItem): void {
    this.db.prepare('INSERT OR IGNORE INTO history VALUES(?,?,?,?,?,?,?,?)').run(item.id, item.path, item.operation, item.archivePath || null, item.hash || null, item.createdAt, item.expiresAt, item.metadata || null);
  }
  history(limit = 500): HistoryItem[] { return this.db.prepare('SELECT * FROM history ORDER BY createdAt DESC LIMIT ?').all(limit) as unknown as HistoryItem[]; }
  historyItem(id: string): HistoryItem | undefined { return this.db.prepare('SELECT * FROM history WHERE id=?').get(id) as unknown as HistoryItem | undefined; }
  expired(now: string): HistoryItem[] { return this.db.prepare('SELECT * FROM history WHERE expiresAt<=?').all(now) as unknown as HistoryItem[]; }
  tracked(): Map<string, { hash: string; seenAt: string }> {
    const map = new Map<string, { hash: string; seenAt: string }>();
    for (const row of this.db.prepare('SELECT path,hash,seenAt FROM tracked').all() as Array<{path:string;hash:string;seenAt:string}>) map.set(row.path, { hash: row.hash, seenAt: row.seenAt });
    return map;
  }
  setTracked(relative: string, hash: string, seenAt: string): void { this.db.prepare('INSERT INTO tracked(path,hash,seenAt) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, seenAt=excluded.seenAt').run(relative, hash, seenAt); }
  deleteTracked(relative: string): void { this.db.prepare('DELETE FROM tracked WHERE path=?').run(relative); }
  transaction(work: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try { work(); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  archiveReferences(archivePath: string): number { return (this.db.prepare('SELECT COUNT(*) AS n FROM history WHERE archivePath=?').get(archivePath) as { n: number }).n; }
  deleteHistory(id: string): void { this.db.prepare('DELETE FROM history WHERE id=?').run(id); }
  sampleMemory(at: string, rss: number, heapUsed: number): void {
    this.db.prepare('INSERT OR REPLACE INTO memory_samples VALUES(?,?,?)').run(at, rss, heapUsed);
    this.db.prepare('DELETE FROM memory_samples WHERE at<?').run(new Date(Date.now() - 3600_000).toISOString());
  }
  memorySamples(): Array<{at:string;rss:number;heapUsed:number}> {
    return this.db.prepare('SELECT * FROM memory_samples ORDER BY at ASC').all() as Array<{at:string;rss:number;heapUsed:number}>;
  }
}
