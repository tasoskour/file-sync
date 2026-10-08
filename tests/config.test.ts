import test from 'node:test';
import assert from 'node:assert/strict';
import { upgradeConfig } from '../src/core/config';
import { validatePairs } from '../src/windows/volume';
import type { FolderRoot, LegacyConfigV1, SyncPair } from '../src/shared/types';

const root = (volume: string, relativePath: string): FolderRoot => ({ displayPath: `X:\\${relativePath}`, volumeId: `\\\\?\\Volume{${volume}}\\`, volumeSerial: '', relativePath });
const pair = (id: string, name: string, source: FolderRoot, backup: FolderRoot): SyncPair => ({ id, name, source, backup, mode: { kind: 'manual' } });
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';

test('single-pair v1 configuration upgrades to one named pair', () => {
  const legacy: LegacyConfigV1 = { version: 1, pairId: A, ownerSid: 'S-1-5-21-1', ownerLocalAppData: 'C:/u', source: root('a', 'work'), backup: root('b', 'bak'), mode: { kind: 'immediate' } };
  const upgraded = upgradeConfig(legacy);
  assert.equal(upgraded.version, 2);
  assert.equal(upgraded.pairs.length, 1);
  assert.equal(upgraded.pairs[0].id, A);
  assert.deepEqual(upgraded.pairs[0].mode, { kind: 'immediate' });
});

test('independent pairs validate; overlapping folders across pairs are rejected', () => {
  validatePairs([pair(A, 'Docs', root('a', 'docs'), root('b', 'docs-bak')), pair(B, 'Photos', root('a', 'photos'), root('b', 'photos-bak'))]);
  assert.throws(() => validatePairs([pair(A, 'Docs', root('a', 'docs'), root('b', 'bak')), pair(B, 'Photos', root('a', 'photos'), root('b', 'bak/photos'))]), /overlapping/);
  assert.throws(() => validatePairs([pair(A, 'Docs', root('a', 'docs'), root('b', 'x')), pair(B, 'docs', root('a', 'p'), root('b', 'y'))]), /named/);
});
