import { randomUUID } from 'node:crypto';
import type { AppConfig, LegacyConfigV1 } from '../shared/types';
import { configFile } from '../shared/locations';
import { readJson } from './files';

export function upgradeConfig(raw: AppConfig | LegacyConfigV1): AppConfig {
  if (raw.version === 2) return raw;
  if (raw.version !== 1) throw new Error('Unsupported configuration version');
  return {
    version: 2, ownerSid: raw.ownerSid, ownerLocalAppData: raw.ownerLocalAppData,
    pairs: [{ id: raw.pairId || randomUUID(), name: 'Backup', source: raw.source, backup: raw.backup, mode: raw.mode }],
  };
}

export async function readConfig(): Promise<AppConfig | undefined> {
  const raw = await readJson<AppConfig | LegacyConfigV1>(configFile);
  return raw ? upgradeConfig(raw) : undefined;
}
