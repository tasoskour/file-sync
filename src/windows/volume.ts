import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FolderRoot, SyncPair } from '../shared/types';
import { localData, programData } from '../shared/locations';

import { run } from '../shared/exec';
const identityCache = new Map<string, number>();

async function powershell(script: string): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

export async function captureFolderRoot(input: string): Promise<FolderRoot> {
  if (process.platform !== 'win32') throw new Error('Folder selection requires Windows');
  const full = path.win32.resolve(input.trim());
  const real = await fsp.realpath(full);
  const stat = await fsp.lstat(real);
  if (!stat.isDirectory()) throw new Error('Select a folder');
  const drive = path.win32.parse(real).root.match(/^([A-Za-z]):\\$/)?.[1];
  if (!drive) throw new Error('Only local or USB drive folders are supported');
  const data = await powershell(`$v=Get-Volume -DriveLetter '${drive}' -ErrorAction Stop; $w=Get-CimInstance Win32_LogicalDisk | Where-Object DeviceID -eq '${drive}:'; @{id=$v.UniqueId; serial=$w.VolumeSerialNumber} | ConvertTo-Json -Compress`);
  const parsed = JSON.parse(data) as {id:string;serial?:string};
  if (!parsed.id?.startsWith('\\\\?\\Volume{')) throw new Error('Unable to identify the volume');
  return { displayPath: real, volumeId: parsed.id, volumeSerial: parsed.serial || '', relativePath: real.slice(3) };
}

export function volumePath(root: FolderRoot): string {
  return path.win32.join(root.volumeId, root.relativePath);
}

export async function resolveFolder(root: FolderRoot): Promise<string> {
  const full = volumePath(root);
  const stat = await fsp.lstat(full);
  if (!stat.isDirectory()) throw new Error(`Folder unavailable: ${root.displayPath}`);
  if (root.volumeSerial && (identityCache.get(`${root.volumeId}:${root.volumeSerial}`) || 0) < Date.now()) {
    const id = root.volumeId.replace(/'/g, "''");
    const output = await powershell(`$v=Get-Volume -UniqueId '${id}' -ErrorAction Stop; $d=$v.DriveLetter; $w=Get-CimInstance Win32_LogicalDisk | Where-Object DeviceID -eq ("$d"+':'); @{serial=$w.VolumeSerialNumber} | ConvertTo-Json -Compress`);
    const current = JSON.parse(output) as {serial?:string};
    if (current.serial && current.serial.toUpperCase() !== root.volumeSerial.toUpperCase()) throw new Error('The selected drive identity has changed');
    identityCache.set(`${root.volumeId}:${root.volumeSerial}`, Date.now() + 60_000);
  }
  return full;
}

export function validatePair(source: FolderRoot, backup: FolderRoot): void {
  const a = volumePath(source).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US');
  const b = volumePath(backup).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US');
  if (a === b || a.startsWith(`${b}\\`) || b.startsWith(`${a}\\`)) throw new Error('Working and backup folders must not overlap');
  for (const protectedPath of [programData, localData]) {
    const p = protectedPath.toLocaleLowerCase('en-US');
    for (const display of [source.displayPath, backup.displayPath]) {
      const d = display.toLocaleLowerCase('en-US').replace(/[\\/]+$/, '');
      if (p === d || p.startsWith(`${d}\\`) || d.startsWith(`${p}\\`)) throw new Error('A selected folder overlaps FileSync application data');
    }
  }
}

export function validatePairs(pairs: SyncPair[]): void {
  if (pairs.length > 20) throw new Error('At most 20 folder pairs are supported');
  const names = new Set<string>();
  for (const pair of pairs) {
    if (!pair.name?.trim() || pair.name.length > 60) throw new Error('Every folder pair needs a name of up to 60 characters');
    const key = pair.name.trim().toLocaleLowerCase('en-US');
    if (names.has(key)) throw new Error(`Two folder pairs are named "${pair.name}"`);
    names.add(key);
    validatePair(pair.source, pair.backup);
  }
  const roots = pairs.flatMap(pair => [{ pair, root: volumePath(pair.source) }, { pair, root: volumePath(pair.backup) }])
    .map(x => ({ ...x, root: x.root.replace(/[\\/]+$/, '').toLocaleLowerCase('en-US') }));
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
    const a = roots[i], b = roots[j];
    if (a.pair.id === b.pair.id) continue;
    if (a.root === b.root || a.root.startsWith(`${b.root}\\`) || b.root.startsWith(`${a.root}\\`)) throw new Error(`"${a.pair.name}" and "${b.pair.name}" use overlapping folders`);
  }
}

export async function pickFolder(): Promise<string | undefined> {
  const script = `Add-Type -AssemblyName System.Windows.Forms; $dialog=New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description='Choose a FileSync folder'; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) }`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded], { windowsHide: true, timeout: 120_000 });
  return stdout.trim() || undefined;
}
