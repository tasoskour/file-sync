import { createHash } from 'node:crypto';
import type { FileEntry, PlannedChange, Preview } from '../shared/types';
import type { ScanResult } from './files';

export type Baseline = Map<string, { backupHash?: string; backupKind: string; sourceIno?: string }>;

export function compareTrees(pairId: string, source: ScanResult, backup: ScanResult, baseline?: Baseline): Preview {
  const paths = new Set([...source.entries.keys(), ...backup.entries.keys()]);
  const changes: PlannedChange[] = [];
  const conflicts: string[] = [];
  for (const path of [...paths].sort()) {
    const left = source.entries.get(path);
    const right = backup.entries.get(path);
    const previous = baseline?.get(path);
    if (baseline && !previous && right && (!left || left.kind !== right.kind || left.hash !== right.hash)) conflicts.push(path);
    else if (previous && right && (right.kind !== previous.backupKind || (right.kind === 'file' && right.hash !== previous.backupHash))) {
      if (!left || left.kind !== right.kind || left.hash !== right.hash) conflicts.push(path);
    } else if (previous && !right && left) conflicts.push(path);
    if (!left && right) changes.push({ kind: right.kind === 'dir' ? 'rmdir' : 'remove', path, backup: right });
    else if (left && !right) changes.push({ kind: left.kind === 'dir' ? 'mkdir' : 'copy', path, source: left });
    else if (left && right && left.kind !== right.kind) changes.push({ kind: left.kind === 'dir' ? 'mkdir' : 'replace', path, source: left, backup: right, reason: 'type changed' });
    else if (left?.kind === 'file' && right?.kind === 'file') {
      if (left.hash !== right.hash) changes.push({ kind: 'replace', path, source: left, backup: right });
      else if (!metadataEqual(left, right)) changes.push({ kind: 'metadata', path, source: left, backup: right });
    }
  }
  const renames: Preview['renames'] = [];
  const removed = changes.filter(c => c.kind === 'remove' && c.backup?.kind === 'file');
  const added = changes.filter(c => c.kind === 'copy' && c.source?.kind === 'file');
  const used = new Set<string>();
  for (const old of removed) {
    const fileId = baseline?.get(old.path)?.sourceIno;
    const candidates = added.filter(f => !used.has(f.path) && (
      (fileId && fileId !== '0' && f.source?.ino === fileId) || (f.source?.hash && f.source.hash === old.backup?.hash)
    ));
    if (candidates.length === 1) {
      const to = candidates[0].path;
      used.add(to);
      old.reason = `renamed-to:${to}`;
      candidates[0].reason = `renamed-from:${old.path}`;
      renames.push({ from: old.path, to });
    }
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({
    source: [...source.entries.values()].map(compact), backup: [...backup.entries.values()].map(compact),
  })).digest('hex');
  const incomplete = [...source.incomplete.map(x => `Working folder: ${x}`), ...backup.incomplete.map(x => `Backup folder: ${x}`)];
  return {
    pairId, fingerprint, createdAt: new Date().toISOString(),
    verdict: incomplete.length ? 'incomplete' : changes.length === 0 ? 'already-synced' : changes.every(c => c.kind === 'metadata') ? 'metadata-only' : 'different',
    changes, renames, conflicts, warnings: [...source.warnings, ...backup.warnings, ...incomplete],
    bytesToCopy: changes.reduce((n, c) => n + (c.kind === 'copy' || c.kind === 'replace' ? c.source?.size || 0 : 0), 0),
    bytesToArchive: changes.reduce((n, c) => n + (c.kind === 'remove' || c.kind === 'replace' ? c.backup?.size || 0 : 0), 0),
    sourceFiles: countFiles(source.entries), backupFiles: countFiles(backup.entries),
  };
}

function metadataEqual(a: FileEntry, b: FileEntry): boolean {
  // FAT/exFAT timestamps have coarse precision; avoid endless metadata-only rewrites.
  return Math.abs(a.mtimeMs - b.mtimeMs) < 2000 && a.readonly === b.readonly;
}
function compact(entry: FileEntry): unknown { return [entry.path, entry.kind, entry.size, entry.mtimeMs, entry.readonly, entry.hash]; }
function countFiles(entries: Map<string, FileEntry>): number { return [...entries.values()].filter(x => x.kind === 'file').length; }

export function isMassChange(preview: Preview, previousCount: number): boolean {
  if (previousCount <= 0) return false;
  if (preview.sourceFiles === 0) return true;
  const renamed = new Set(preview.renames.map(x => x.from));
  const newHashes = new Map<string, number>();
  for (const change of preview.changes) if (change.kind === 'copy' && change.source?.hash) newHashes.set(change.source.hash, (newHashes.get(change.source.hash) || 0) + 1);
  let destructive = 0;
  for (const change of preview.changes) {
    if (change.kind === 'replace') destructive++;
    if (change.kind === 'remove') {
      if (renamed.has(change.path)) continue;
      const hash = change.backup?.hash;
      const count = hash ? newHashes.get(hash) || 0 : 0;
      if (hash && count) newHashes.set(hash, count - 1);
      else destructive++;
    }
  }
  return destructive >= 100 && destructive / previousCount >= 0.2;
}
