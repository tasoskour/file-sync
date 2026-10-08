import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { AppConfig } from '../shared/types';
import { configFile, localData, pairDbFile, pairIdPattern, programData, SERVICE_NAME } from '../shared/locations';
import { readJson, sha256, writeJsonAtomic } from '../core/files';
import { readConfig } from '../core/config';
import { StateDb } from '../core/database';
import { ownerHistoryDir } from '../shared/locations';
import { resolveFolder, validatePairs } from './volume';

import { run } from '../shared/exec';
const installDir = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'FileSync');
const installedExe = path.join(installDir, 'FileSync.exe');
const installedNssm = path.join(installDir, 'nssm.exe');

export interface ServiceInfo { installed: boolean; state: string; startMode: string; processId?: number; pathName?: string }

async function powershell(script: string): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 120_000 });
  return stdout.trim();
}

export async function currentSid(): Promise<string> {
  return powershell('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
}

export async function serviceInfo(): Promise<ServiceInfo> {
  const output = await powershell(`$s=Get-CimInstance Win32_Service -Filter "Name='${SERVICE_NAME}'"; if($s){@{installed=$true;state=$s.State;startMode=$s.StartMode;processId=$s.ProcessId;pathName=$s.PathName}|ConvertTo-Json -Compress}else{'{"installed":false,"state":"not-installed","startMode":"none"}'}`);
  return JSON.parse(output) as ServiceInfo;
}

export type ElevatedAction =
  | { action: 'save-config'; config: AppConfig }
  | { action: 'restore'; id: string; pairId: string }
  | { action: 'install' | 'repair'; ownerSid: string }
  | { action: 'uninstall' | 'start' | 'stop' | 'restart' | 'enable' | 'disable' };

export async function requestElevation(action: ElevatedAction): Promise<void> {
  const resultFile = path.join(localData, `elevated-${randomUUID()}.json`);
  await fsp.mkdir(localData, { recursive: true });
  const argument = Buffer.from(JSON.stringify({ ...action, resultFile }), 'utf8').toString('base64url');
  const exe = process.execPath.replace(/'/g, "''");
  const script = `$ProgressPreference='SilentlyContinue';$p=Start-Process -FilePath '${exe}' -ArgumentList '--elevated ${argument}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`;
  try {
    let launchError: unknown;
    try { await powershell(script); } catch (error) { launchError = error; }
    const result = await readJson<{ok:boolean;error?:string}>(resultFile).catch(() => undefined);
    if (result?.ok) return;
    if (result?.error) throw new Error(result.error);
    if (launchError) throw new Error('The administrator helper did not run. Approval was declined in the Windows prompt, or Windows (for example Smart App Control) blocked FileSync.exe from starting elevated.');
    throw new Error('Elevated action did not complete');
  } finally { await fsp.rm(resultFile, { force: true }).catch(() => undefined); }
}

export async function runElevated(encoded: string): Promise<void> {
  const input = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as ElevatedAction & {resultFile:string};
  let result: {ok:boolean;error?:string} = { ok: true };
  try { await performElevated(input); }
  catch (error) { result = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  await writeJsonAtomic(input.resultFile, result);
  if (!result.ok) process.exitCode = 1;
}

async function performElevated(input: ElevatedAction): Promise<void> {
  if (input.action === 'restore') { await restoreVersion(input.id, input.pairId); return; }
  if (input.action === 'save-config') {
    const config = input.config;
    if (config.version !== 2 || !Array.isArray(config.pairs) || !/^S-1-/.test(config.ownerSid)) throw new Error('Invalid configuration');
    if (config.pairs.some(pair => !pairIdPattern.test(pair.id))) throw new Error('Invalid folder pair ID');
    validatePairs(config.pairs);
    await fsp.mkdir(programData, { recursive: true });
    await grantOwnerRead(config.ownerSid);
    await writeJsonAtomic(configFile, config);
    return;
  }
  if (input.action === 'install' || input.action === 'repair') {
    if (!(process as NodeJS.Process & { pkg?: unknown }).pkg) throw new Error('Package FileSync.exe before installing the service');
    if (!/^S-1-/.test(input.ownerSid)) throw new Error('Invalid owner');
    await fsp.mkdir(programData, { recursive: true });
    await grantOwnerRead(input.ownerSid);
    const existing = await serviceInfo();
    if (existing.installed && input.action === 'install') throw new Error('Service already installed');
    if (existing.installed) {
      await run('sc.exe', ['stop', SERVICE_NAME], { windowsHide: true }).catch(() => undefined);
      await waitStopped();
    }
    await fsp.mkdir(installDir, { recursive: true });
    if (path.resolve(process.execPath).toLowerCase() !== installedExe.toLowerCase()) await fsp.copyFile(process.execPath, installedExe);
    const asset = path.resolve(__dirname, '../../../vendor/nssm.exe');
    await fsp.writeFile(installedNssm, await fsp.readFile(asset)); // copyFile cannot read from the packaged snapshot
    if (!existing.installed) await run(installedNssm, ['install', SERVICE_NAME, installedExe, '--service'], { windowsHide: true });
    else {
      await run(installedNssm, ['set', SERVICE_NAME, 'Application', installedExe], { windowsHide: true });
      await run(installedNssm, ['set', SERVICE_NAME, 'AppParameters', '--service'], { windowsHide: true });
    }
    await run(installedNssm, ['set', SERVICE_NAME, 'DisplayName', 'FileSync Backup Service'], { windowsHide: true });
    await run(installedNssm, ['set', SERVICE_NAME, 'Description', 'Keeps a working folder mirrored to a backup folder'], { windowsHide: true });
    await run(installedNssm, ['set', SERVICE_NAME, 'AppExit', 'Default', 'Restart'], { windowsHide: true });
    await run('sc.exe', ['config', SERVICE_NAME, 'start=', 'delayed-auto'], { windowsHide: true });
    await run('sc.exe', ['start', SERVICE_NAME], { windowsHide: true }).catch(() => undefined);
    return;
  }
  if (input.action === 'uninstall') {
    await run('sc.exe', ['stop', SERVICE_NAME], { windowsHide: true }).catch(() => undefined);
    await waitStopped();
    await run(installedNssm, ['remove', SERVICE_NAME, 'confirm'], { windowsHide: true });
    scheduleInstalledFileCleanup();
    return;
  }
  if (input.action === 'enable') { await run('sc.exe', ['config', SERVICE_NAME, 'start=', 'delayed-auto'], { windowsHide: true }); return; }
  if (input.action === 'disable') { await run('sc.exe', ['config', SERVICE_NAME, 'start=', 'disabled'], { windowsHide: true }); return; }
  if (input.action === 'start' || input.action === 'stop') { await run('sc.exe', [input.action, SERVICE_NAME], { windowsHide: true }); return; }
  if (input.action === 'restart') {
    await run('sc.exe', ['stop', SERVICE_NAME], { windowsHide: true }).catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 1500));
    await run('sc.exe', ['start', SERVICE_NAME], { windowsHide: true });
  }
}

async function waitStopped(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const info = await serviceInfo();
    if (!info.installed || info.state === 'Stopped') return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Service did not stop within 30 seconds');
}

function scheduleInstalledFileCleanup(): void {
  const exe = installedExe.replace(/'/g, "''");
  const nssm = installedNssm.replace(/'/g, "''");
  const dir = installDir.replace(/'/g, "''");
  const script = `$exe='${exe}';$nssm='${nssm}';$dir='${dir}';for($i=0;$i -lt 150;$i++){Start-Sleep -Seconds 2;Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue;Remove-Item -LiteralPath $nssm -Force -ErrorAction SilentlyContinue;if(!(Test-Path -LiteralPath $exe) -and !(Test-Path -LiteralPath $nssm)){Remove-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue;break}}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, detached: true, stdio: 'ignore' });
  child.unref();
}

async function grantOwnerRead(sid: string): Promise<void> {
  await run('icacls.exe', [programData, '/inheritance:r', '/grant:r', 'SYSTEM:(OI)(CI)F', 'Administrators:(OI)(CI)F', `*${sid}:(OI)(CI)RX`], { windowsHide: true });
}

async function restoreVersion(id: string, pairId: string): Promise<void> {
  if (!pairIdPattern.test(id) || !pairIdPattern.test(pairId)) throw new Error('Invalid history ID');
  const config = await readConfig();
  const pair = config?.pairs.find(x => x.id === pairId);
  if (!config || !pair) throw new Error('This folder pair is no longer configured');
  const db = new StateDb(pairDbFile(pairId));
  try {
    const item = db.historyItem(id);
    if (!item || Date.parse(item.expiresAt) <= Date.now()) throw new Error('History version has expired');
    const parts = item.path.split('/');
    if (parts.some(x => !x || x === '.' || x === '..' || x.includes('\\'))) throw new Error('Invalid history path');
    const root = await resolveFolder(pair.source);
    const destination = path.join(root, ...parts);
    if (item.operation === 'metadata' && item.metadata) {
      const old = JSON.parse(item.metadata) as {mtimeMs:number;readonly:boolean};
      await fsp.utimes(destination, new Date(), new Date(old.mtimeMs));
      await fsp.chmod(destination, old.readonly ? 0o444 : 0o666);
      return;
    }
    const historyRoot = ownerHistoryDir(config.ownerLocalAppData);
    if (!item.archivePath || !path.resolve(item.archivePath).startsWith(path.resolve(historyRoot) + path.sep)) throw new Error('Archive unavailable');
    if (await sha256(item.archivePath) !== item.hash) throw new Error('Archive checksum does not match');
    let currentPath = destination;
    if (item.operation === 'rename') {
      const rename = JSON.parse(item.metadata || '{}') as {to?:string};
      const toParts = rename.to?.split('/') || [];
      if (!toParts.length || toParts.some(x => !x || x === '.' || x === '..' || x.includes('\\'))) throw new Error('Invalid rename record');
      currentPath = path.join(root, ...toParts);
      try { await fsp.lstat(destination); throw new Error('Original path is occupied; move it before restoring this rename'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    const undoId = randomUUID();
    const undoPath = path.join(historyRoot, `${undoId}.bin`);
    const previous = await fsp.stat(currentPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (previous?.isFile()) {
      await pipeline(fs.createReadStream(currentPath), fs.createWriteStream(undoPath, { flags: 'wx' }));
      const now = Date.now();
      db.addHistory({ id: undoId, path: item.operation === 'rename' ? path.relative(root, currentPath).replace(/\\/g, '/') : item.path, operation: 'pre-restore', archivePath: undoPath, hash: await sha256(undoPath), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 168 * 3600_000).toISOString() });
    }
    if (item.operation === 'rename' && previous) await fsp.rename(currentPath, destination);
    const stage = `${destination}.filesync-stage-${randomUUID()}`;
    try {
      await pipeline(fs.createReadStream(item.archivePath), fs.createWriteStream(stage, { flags: 'wx' }));
      if (await sha256(stage) !== item.hash) throw new Error('Archive changed during restore');
      await fsp.rename(stage, destination);
    } finally { await fsp.rm(stage, { force: true }).catch(() => undefined); }
  } finally { db.close(); }
}
