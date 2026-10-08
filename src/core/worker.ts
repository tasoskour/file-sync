import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, ServiceStatus, SyncPair, WorkerStatus } from '../shared/types';
import { ownerHistoryDir, ownerRequestsDir, pairDbFile, pairIdPattern, pairPreviewFile, processDbFile, stateDir, statusFile } from '../shared/locations';
import { compareTrees, isMassChange } from './compare';
import { readConfig } from './config';
import { StateDb } from './database';
import { message, readJson, scanTree, writeJsonAtomic, type ScanResult } from './files';
import { log, purgeLogs } from './log';
import { nextRun } from './schedule';
import { applyPreview, purgeExpired, recoverJournal } from './sync';
import { resolveFolder, validatePairs } from '../windows/volume';

type RequestAction = 'verify' | 'sync-now' | 'approve' | 'approve-bulk' | 'resolve-conflict' | 'delete-history';
const requestActions: RequestAction[] = ['verify', 'sync-now', 'approve', 'approve-bulk', 'resolve-conflict', 'delete-history'];
type Request = { action: RequestAction; pairId?: string; fingerprint?: string; path?: string; ids?: string[] };

/** Syncs one working/backup pair. The supervisor below owns one runner per configured pair. */
class PairRunner {
  readonly db: StateDb;
  private pair: SyncPair;
  private owner: string;
  private status: WorkerStatus = { phase: 'checking', message: 'Starting…', updatedAt: new Date().toISOString() };
  private watchers: fs.FSWatcher[] = [];
  private dirtyAt = 0;
  private lastCheck = 0;
  private stopped = false;
  private sourceSnapshot?: ScanResult;
  private backupSnapshot?: ScanResult;
  private sourceDirty = new Set<string>();
  private backupDirty = new Set<string>();
  private forceFull = true;
  private lastFullHash = 0;
  private configured = false;

  constructor(pair: SyncPair, owner: string, private publish: () => Promise<void>) {
    this.pair = pair; this.owner = owner;
    this.db = new StateDb(pairDbFile(pair.id));
  }

  get current(): WorkerStatus { return this.status; }

  async recover(): Promise<void> { await recoverJournal(this.db); }

  close(): void { this.stopped = true; this.closeWatchers(); this.db.close(); }

  /** Removes saved versions the user chose to delete, along with their archived files. */
  async deleteHistory(ids: string[]): Promise<number> {
    const root = path.resolve(ownerHistoryDir(this.owner));
    let removed = 0;
    for (const id of ids.slice(0, 1000)) {
      if (!pairIdPattern.test(id)) continue;
      const item = this.db.historyItem(id);
      if (!item) continue;
      if (item.archivePath && path.resolve(item.archivePath).startsWith(root + path.sep)) await fsp.rm(item.archivePath, { force: true });
      this.db.deleteHistory(id); removed++;
    }
    if (removed) await log('INFO', `[${this.pair.name}] Deleted ${removed} saved version(s) at the user's request`);
    return removed;
  }

  fail(text: string): void { this.status = { ...this.status, phase: 'error', message: text, updatedAt: new Date().toISOString() }; }

  configure(pair: SyncPair, owner: string): void {
    if (this.configured && JSON.stringify(pair) === JSON.stringify(this.pair) && owner === this.owner) return;
    this.pair = pair; this.owner = owner; this.configured = true;
    if (this.db.getMeta('pairId') !== pair.id) this.db.resetPair(pair.id);
    this.closeWatchers();
    this.sourceSnapshot = undefined; this.backupSnapshot = undefined;
    this.forceFull = true; this.sourceDirty.clear(); this.backupDirty.clear();
    this.dirtyAt = Date.now() - 3000;
    this.lastCheck = 0;
    void log('INFO', `[${pair.name}] Configuration loaded: ${pair.mode.kind}`);
  }

  async tick(requests: Request[]): Promise<void> {
    const config = this.pair;
    const force = requests.length > 0;
    const scheduledDue = this.isScheduledDue(config);
    const unavailableRetry = this.status.phase === 'drive-unavailable' && Date.now() - this.lastCheck >= 10_000;
    const automaticDue = config.mode.kind === 'immediate' && ((this.dirtyAt > 0 && Date.now() - this.dirtyAt >= 2000) || Date.now() - this.lastCheck >= 300_000);
    if (this.lastCheck === 0 || force || scheduledDue || automaticDue || unavailableRetry) await this.runCheck(requests, scheduledDue || !!automaticDue);
    if (config.mode.kind === 'immediate' && this.watchers.length === 0) await this.watch(config);
    await this.update({});
  }

  private isScheduledDue(config: SyncPair): boolean {
    if (config.mode.kind !== 'scheduled') return false;
    const last = this.db.getMeta('lastRunAt');
    const due = nextRun(config.mode, last ? new Date(last) : new Date(), last ? new Date(last) : undefined);
    if (due) this.status.nextRunAt = due.toISOString();
    return !!last && !!due && due.getTime() <= Date.now();
  }

  private async runCheck(requests: Request[], automaticDue: boolean): Promise<void> {
    if (this.stopped) return;
    const config = this.pair;
    const pairId = config.id;
    this.lastCheck = Date.now();
    this.dirtyAt = 0;
    await this.update({ phase: 'checking', message: 'Comparing working and backup folders…', progress: undefined });
    let sourceRoot: string, backupRoot: string;
    try { sourceRoot = await resolveFolder(config.source); backupRoot = await resolveFolder(config.backup); }
    catch (error) { this.closeWatchers(); this.sourceSnapshot = undefined; this.backupSnapshot = undefined; this.forceFull = true; await this.update({ phase: 'drive-unavailable', message: `Waiting for the selected folders: ${message(error)}` }); return; }
    const full = this.forceFull || config.mode.kind !== 'immediate' || requests.some(x => x.action === 'verify') || Date.now() - this.lastFullHash > 24 * 3600_000;
    const sourceDirty = this.sourceDirty; const backupDirty = this.backupDirty;
    this.sourceDirty = new Set(); this.backupDirty = new Set();
    let lastProgress = 0;
    const progress = (count: number, relative: string) => {
      if (Date.now() - lastProgress > 300) {
        lastProgress = Date.now(); this.status.progress = { done: count, total: 0, current: relative };
        void this.publish();
      }
    };
    const source = await scanTree(sourceRoot, { previous: full ? undefined : this.sourceSnapshot?.entries, forcePaths: sourceDirty, onEntry: progress });
    const backup = await scanTree(backupRoot, { previous: full ? undefined : this.backupSnapshot?.entries, forcePaths: backupDirty, onEntry: progress });
    if (config.mode.kind === 'scheduled' && automaticDue) this.db.setMeta('lastRunAt', new Date().toISOString());
    if (!source.incomplete.length && !backup.incomplete.length) {
      this.sourceSnapshot = source; this.backupSnapshot = backup;
      if (full) { this.lastFullHash = Date.now(); this.forceFull = false; this.status.lastFullVerifiedAt = new Date().toISOString(); }
    }
    const initialized = this.db.getMeta('initialized') === '1';
    const preview = compareTrees(pairId, source, backup, initialized ? this.db.baseline() : undefined);
    await writeJsonAtomic(pairPreviewFile(pairId), preview);
    if (preview.verdict !== 'incomplete') this.status.lastVerifiedAt = new Date().toISOString();
    const { changes: _changes, ...summary } = preview;
    this.status.preview = summary;
    if (preview.verdict === 'incomplete') { await this.update({ phase: 'verification-incomplete', message: 'Some files could not be verified. Review the warnings.', progress: undefined }); return; }
    if (preview.verdict === 'already-synced') {
      this.db.replaceEntries(source.entries, backup.entries);
      if (!this.db.getMeta('lastRunAt')) this.db.setMeta('lastRunAt', new Date().toISOString());
      await this.update({ phase: 'in-sync', message: initialized ? 'Working and backup folders match.' : 'Existing folders are already synced.', progress: undefined });
      return;
    }
    const approval = requests.find(x => x.action === 'approve' && x.fingerprint === preview.fingerprint);
    const approvedPair = this.db.getMeta('approvedPairId') === pairId;
    if (!initialized && !approvedPair && !approval) {
      await this.update({ phase: 'needs-review', message: 'Review the existing folders before the first sync.', progress: undefined });
      return;
    }
    if (approval) this.db.setMeta('approvedPairId', pairId);
    const manualRun = requests.some(x => x.action === 'sync-now' || x.action === 'resolve-conflict' || x.action === 'approve-bulk');
    if (preview.conflicts.length) {
      for (const request of requests.filter(x => x.action === 'resolve-conflict' && x.path)) {
        preview.conflicts = preview.conflicts.filter(p => p !== request.path);
      }
    }
    const mass = initialized && isMassChange(preview, this.db.baseline().size);
    const bulkApproval = requests.some(x => x.action === 'approve-bulk' && x.fingerprint === preview.fingerprint);
    if (mass && !bulkApproval) { await this.update({ phase: 'needs-review', message: 'A large number of files would be replaced or removed. Review and approve this run.', progress: undefined }); return; }
    if (config.mode.kind === 'manual' && !manualRun && !approval) { await this.update({ phase: 'pending', message: 'Changes are waiting for Sync now.', progress: undefined }); return; }
    if (config.mode.kind === 'scheduled' && !automaticDue && !manualRun && !approval) { await this.update({ phase: 'pending', message: 'Changes are waiting for the next scheduled run.', progress: undefined }); return; }
    if (config.mode.kind === 'immediate' && !automaticDue && !manualRun && !approval && initialized) { await this.update({ phase: 'pending', message: 'Changes are pending.', progress: undefined }); return; }
    await this.update({ phase: 'syncing', message: 'Updating backup…', progress: { done: 0, total: preview.changes.length } });
    const result = await applyPreview(preview, {
      keepHistory: config.keepHistory !== false, sourceRoot, backupRoot, historyRoot: ownerHistoryDir(this.owner), db: this.db,
      onProgress: (done, total, current) => { this.status.progress = { done, total, current }; void this.publish(); },
    });
    if (result.errors.length) {
      for (const change of preview.changes) { this.sourceDirty.add(change.path); this.backupDirty.add(change.path); }
      await log('WARN', `[${config.name}] Sync finished with ${result.errors.length} issue(s): ${result.errors.slice(0, 5).join('; ')}`);
      await this.update({ phase: 'needs-review', message: `${result.errors.length} item(s) need review. See logs.`, progress: undefined });
    } else {
      const changedPaths = new Set(preview.changes.map(x => x.path));
      const afterSource = await scanTree(sourceRoot, { previous: source.entries, forcePaths: changedPaths });
      const afterBackup = await scanTree(backupRoot, { previous: backup.entries, forcePaths: changedPaths });
      this.sourceSnapshot = afterSource; this.backupSnapshot = afterBackup;
      const after = compareTrees(pairId, afterSource, afterBackup);
      await writeJsonAtomic(pairPreviewFile(pairId), after);
      const { changes: _afterChanges, ...afterSummary } = after;
      this.status.preview = afterSummary;
      this.status.lastVerifiedAt = new Date().toISOString();
      if (after.verdict === 'already-synced') {
        this.db.replaceEntries(afterSource.entries, afterBackup.entries);
        const now = new Date().toISOString();
        this.db.setMeta('lastRunAt', now);
        this.status.lastSyncedAt = now;
        await log('INFO', `[${config.name}] Sync completed: ${result.completed} change(s)`);
        await this.update({ phase: 'in-sync', message: 'Backup is up to date.', progress: undefined });
      } else await this.update({ phase: 'pending', message: 'Files changed during sync; another pass is needed.', progress: undefined });
    }
  }

  private async watch(config: SyncPair): Promise<void> {
    try {
      for (const root of [await resolveFolder(config.source), await resolveFolder(config.backup)]) {
        const dirty = this.watchers.length === 0 ? this.sourceDirty : this.backupDirty;
        const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
          if (filename) dirty.add(String(filename).replace(/\\/g, '/'));
          else this.forceFull = true;
          this.dirtyAt = Date.now();
        });
        watcher.on('error', error => { void log('WARN', `[${config.name}] Watcher error: ${message(error)}`); this.closeWatchers(); this.dirtyAt = Date.now() - 3000; });
        this.watchers.push(watcher);
      }
    } catch (error) { await log('WARN', `[${config.name}] Watching unavailable; periodic scans continue: ${message(error)}`); this.closeWatchers(); }
  }
  private closeWatchers(): void { for (const watcher of this.watchers) watcher.close(); this.watchers = []; }
  private async update(patch: Partial<WorkerStatus>): Promise<void> {
    this.status = { ...this.status, ...patch, updatedAt: new Date().toISOString() };
    await this.publish();
  }
}

/** Reads the configuration, keeps one PairRunner per pair, and publishes combined status. */
class Supervisor {
  private runners = new Map<string, PairRunner>();
  private processDb = new StateDb(processDbFile);
  private stopping = false;
  private lastMaintenance = 0;
  private lastMemorySample = 0;

  async start(): Promise<void> {
    await log('INFO', 'Worker started');
    process.on('SIGINT', () => { this.stopping = true; });
    process.on('SIGTERM', () => { this.stopping = true; });
    while (!this.stopping) {
      try { await this.tick(); }
      catch (error) { await log('ERROR', message(error)); await this.publish(message(error)); }
      await new Promise(resolve => setTimeout(resolve, 2500));
    }
    for (const runner of this.runners.values()) runner.close();
    this.processDb.close();
  }

  private async tick(): Promise<void> {
    const config = await readConfig();
    if (!config) { this.dropRunners([]); await this.publish(); return; }
    validatePairs(config.pairs);
    this.dropRunners(config.pairs.map(x => x.id));
    for (const pair of config.pairs) {
      let runner = this.runners.get(pair.id);
      if (!runner) {
        runner = new PairRunner(pair, config.ownerLocalAppData, () => this.publish());
        this.runners.set(pair.id, runner);
        await runner.recover();
      }
      runner.configure(pair, config.ownerLocalAppData);
    }
    const requests = await this.takeRequests(config);
    for (const pair of config.pairs) {
      const runner = this.runners.get(pair.id)!;
      try {
        for (const request of requests.filter(x => x.pairId === pair.id && x.action === 'delete-history')) await runner.deleteHistory(request.ids || []);
        await runner.tick(requests.filter(x => x.pairId === pair.id && x.action !== 'delete-history'));
      }
      catch (error) { await log('ERROR', `[${pair.name}] ${message(error)}`); runner.fail(message(error)); }
    }
    await this.maintenance();
    await this.publish();
  }

  private dropRunners(keep: string[]): void {
    for (const [id, runner] of this.runners) if (!keep.includes(id)) { runner.close(); this.runners.delete(id); }
  }

  private async takeRequests(config: AppConfig): Promise<Request[]> {
    const directory = ownerRequestsDir(config.ownerLocalAppData);
    await fsp.mkdir(directory, { recursive: true });
    const requests: Request[] = [];
    for (const name of (await fsp.readdir(directory)).filter(x => x.endsWith('.json')).slice(0, 100)) {
      const file = path.join(directory, name);
      try {
        const request = await readJson<Request>(file);
        if (request && requestActions.includes(request.action) && request.pairId && this.runners.has(request.pairId)) requests.push(request);
      } catch (error) { await log('WARN', `Invalid request ${name}: ${message(error)}`); }
      finally { await fsp.rm(file, { force: true }).catch(() => undefined); }
    }
    return requests;
  }

  private async maintenance(): Promise<void> {
    if (Date.now() - this.lastMaintenance > 3600_000) {
      this.lastMaintenance = Date.now();
      for (const runner of this.runners.values()) await purgeExpired(runner.db);
      await this.purgeOrphans();
      await purgeLogs();
    }
    if (Date.now() - this.lastMemorySample > 5000) {
      this.lastMemorySample = Date.now();
      const m = process.memoryUsage();
      this.processDb.sampleMemory(new Date().toISOString(), m.rss, m.heapUsed);
    }
  }

  /** Removed pairs keep their history until it expires; then the state file is deleted. */
  private async purgeOrphans(): Promise<void> {
    for (const name of await fsp.readdir(stateDir).catch(() => [] as string[])) {
      const id = name.replace(/\.sqlite$/, '');
      if (name === 'process.sqlite' || !name.endsWith('.sqlite') || this.runners.has(id)) continue;
      const file = path.join(stateDir, name);
      const db = new StateDb(file);
      await purgeExpired(db);
      const empty = db.history(1).length === 0;
      db.close();
      if (empty) await Promise.all(['', '-wal', '-shm'].map(x => fsp.rm(file + x, { force: true }).catch(() => undefined)));
    }
  }

  private async publish(error?: string): Promise<void> {
    const m = process.memoryUsage();
    const pairs: Record<string, WorkerStatus> = {};
    for (const [id, runner] of this.runners) pairs[id] = runner.current;
    const status: ServiceStatus = { updatedAt: new Date().toISOString(), pairs, memory: { rss: m.rss, heapUsed: m.heapUsed, capturedAt: new Date().toISOString() } };
    if (error) status.error = error;
    await writeJsonAtomic(statusFile, status);
  }
}

export async function runWorker(): Promise<void> { await new Supervisor().start(); }
