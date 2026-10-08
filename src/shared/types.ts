export type SyncMode =
  | { kind: 'immediate' }
  | { kind: 'manual' }
  | { kind: 'scheduled'; schedule: { kind: 'interval'; minutes: number } | { kind: 'weekly'; days: number[]; time: string } };

export interface FolderRoot {
  displayPath: string;
  volumeId: string;
  volumeSerial: string;
  relativePath: string;
}

export interface SyncPair {
  id: string;
  name: string;
  source: FolderRoot;
  backup: FolderRoot;
  mode: SyncMode;
  /** Archive replaced or removed backup files for seven days. Defaults to true when absent. */
  keepHistory?: boolean;
}

export interface AppConfig {
  version: 2;
  ownerSid: string;
  ownerLocalAppData: string;
  pairs: SyncPair[];
}

/** Single-pair configuration written by earlier builds; upgraded on read. */
export interface LegacyConfigV1 {
  version: 1;
  pairId: string;
  ownerSid: string;
  ownerLocalAppData: string;
  source: FolderRoot;
  backup: FolderRoot;
  mode: SyncMode;
}

export type FileKind = 'file' | 'dir';
export interface FileEntry {
  path: string;
  kind: FileKind;
  size: number;
  mtimeMs: number;
  readonly: boolean;
  hash?: string;
  ino?: string;
}

export type ChangeKind = 'copy' | 'replace' | 'remove' | 'metadata' | 'mkdir' | 'rmdir';
export interface PlannedChange {
  kind: ChangeKind;
  path: string;
  source?: FileEntry;
  backup?: FileEntry;
  reason?: string;
}

export interface Preview {
  pairId: string;
  fingerprint: string;
  createdAt: string;
  verdict: 'already-synced' | 'metadata-only' | 'different' | 'incomplete' | 'unavailable';
  changes: PlannedChange[];
  renames: Array<{ from: string; to: string }>;
  conflicts: string[];
  warnings: string[];
  bytesToCopy: number;
  bytesToArchive: number;
  sourceFiles: number;
  backupFiles: number;
}

export type WorkerPhase = 'unconfigured' | 'checking' | 'in-sync' | 'pending' | 'syncing' | 'needs-review' | 'drive-unavailable' | 'verification-incomplete' | 'error';
export interface WorkerStatus {
  phase: WorkerPhase;
  message: string;
  updatedAt: string;
  lastVerifiedAt?: string;
  lastFullVerifiedAt?: string;
  lastSyncedAt?: string;
  nextRunAt?: string;
  preview?: Omit<Preview, 'changes'>;
  progress?: { done: number; total: number; current?: string };
}

export interface ServiceStatus {
  error?: string;
  /** Build of the running service, compared with the manager's build to spot an outdated service. */
  buildId?: string;
  updatedAt: string;
  pairs: Record<string, WorkerStatus>;
  memory?: { rss: number; heapUsed: number; capturedAt: string };
}
