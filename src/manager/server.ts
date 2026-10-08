import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { AppConfig, ServiceStatus, SyncMode, SyncPair } from '../shared/types';
import { localData, logsDir, ownerRequestsDir, pairDbFile, pairIdPattern, pairPreviewFile, processDbFile, stateDir, statusFile } from '../shared/locations';
import { readConfig } from '../core/config';
import { BUILD_ID } from '../shared/buildinfo';
import { StateDb } from '../core/database';
import { readJson, writeJsonAtomic } from '../core/files';
import { captureFolderRoot, pickFolder, resolveFolder, validatePairs } from '../windows/volume';
import { currentSid, requestElevation, serviceInfo, type ElevatedAction } from '../windows/service';

const uiDir = path.resolve(__dirname, '../../ui');
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

export async function runManager(): Promise<void> {
  const sid = await currentSid();
  const token = randomBytes(32).toString('base64url');
  let lastRequest = Date.now();
  let closedAt = 0; // set when the page reports it was closed; a reload cancels it
  const server = http.createServer(async (req, res) => {
    lastRequest = Date.now();
    try {
      if (req.method === 'POST' && req.url === '/api/closed') {
        // sendBeacon cannot set headers, so the token travels in the body.
        const input = await body<{token?:string}>(req).catch(() => ({} as {token?:string}));
        if (input.token === token) closedAt = Date.now();
        res.writeHead(204); res.end(); return;
      }
      closedAt = 0;
      if (req.url?.startsWith('/api/')) {
        if (req.headers['x-filesync-token'] !== token) return reply(res, 403, { error: 'Invalid manager session' });
        const origin = req.headers.origin;
        if (req.method !== 'GET' && origin && origin !== `http://127.0.0.1:${(server.address() as {port:number}).port}`) return reply(res, 403, { error: 'Invalid origin' });
        await api(req, res, sid);
      } else await staticFile(req, res);
    } catch (error) { reply(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as {port:number}).port;
  const url = `http://127.0.0.1:${port}/#token=${token}`;
  if (process.env.FILESYNC_MANAGER_PORT_FILE) await writeJsonAtomic(process.env.FILESYNC_MANAGER_PORT_FILE, { port, token });
  if (process.env.FILESYNC_NO_BROWSER !== '1') execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, () => undefined);
  const existing = await readConfig();
  if (existing?.ownerSid === sid) for (const pair of existing.pairs) await enqueue(existing, { action: 'verify', pairId: pair.id });
  // Exit shortly after the browser page closes. The idle limit is a fallback for browsers that skip the close notice.
  setInterval(() => {
    if ((closedAt && Date.now() - closedAt > 8_000) || Date.now() - lastRequest > 3 * 60_000) process.exit(0);
  }, 2_000);
}

async function api(req: IncomingMessage, res: ServerResponse, sid: string): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const config = await readConfig();
  if (config && config.ownerSid !== sid) return reply(res, 403, { error: 'This FileSync installation belongs to another Windows account' });
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const [service, status] = await Promise.all([serviceInfo(), readJson<ServiceStatus>(statusFile)]);
    return reply(res, 200, { config, service, status, managerBuildId: BUILD_ID });
  }
  if (req.method === 'GET' && url.pathname === '/api/preview') {
    const pairId = pairParam(url.searchParams.get('pairId'));
    return reply(res, 200, await readJson(pairPreviewFile(pairId)) || null);
  }
  if (req.method === 'POST' && url.pathname === '/api/pick-folder') return reply(res, 200, { path: await pickFolder() });
  if (req.method === 'POST' && url.pathname === '/api/inspect-folder') {
    const input = await body<{path:string}>(req);
    const folder = await captureFolderRoot(input.path);
    const stats = await fsp.statfs(folder.displayPath);
    return reply(res, 200, { ...folder, freeBytes: stats.bavail * stats.bsize });
  }
  if (req.method === 'POST' && url.pathname === '/api/config') {
    const input = await body<{pairs:Array<{id?:string;name:string;sourcePath:string;backupPath:string;mode:SyncMode;keepHistory?:boolean}>}>(req);
    if (!Array.isArray(input.pairs)) throw new Error('Invalid configuration');
    const pairs: SyncPair[] = [];
    for (const item of input.pairs) {
      validateMode(item.mode);
      const [source, backup] = await Promise.all([captureFolderRoot(item.sourcePath), captureFolderRoot(item.backupPath)]);
      const previous = config?.pairs.find(x => x.id === item.id);
      const same = previous && JSON.stringify(previous.source) === JSON.stringify(source) && JSON.stringify(previous.backup) === JSON.stringify(backup);
      pairs.push({ id: same ? previous.id : randomUUID(), name: String(item.name || '').trim(), source, backup, mode: item.mode, keepHistory: item.keepHistory !== false });
    }
    validatePairs(pairs);
    const next: AppConfig = { version: 2, ownerSid: sid, ownerLocalAppData: process.env.LOCALAPPDATA || path.dirname(localData), pairs };
    if (process.env.FILESYNC_PROGRAM_DATA) await writeJsonAtomic(path.join(process.env.FILESYNC_PROGRAM_DATA, 'config.json'), next);
    else await requestElevation({ action: 'save-config', config: next });
    return reply(res, 200, { ok: true, config: next });
  }
  if (req.method === 'POST' && url.pathname === '/api/service') {
    const input = await body<{action:ElevatedAction['action']}>(req);
    if (!['install', 'uninstall', 'start', 'stop', 'restart', 'enable', 'disable', 'repair'].includes(input.action)) throw new Error('Unknown service action');
    await requestElevation((input.action === 'install' || input.action === 'repair' ? { action: input.action, ownerSid: sid } : { action: input.action }) as ElevatedAction);
    return reply(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/request') {
    if (!config) throw new Error('Configure folders first');
    const input = await body<{action:string;pairId?:string;fingerprint?:string;path?:string}>(req);
    if (!config.pairs.some(x => x.id === input.pairId)) throw new Error('Unknown folder pair');
    if (!['verify', 'sync-now', 'approve', 'approve-bulk', 'resolve-conflict'].includes(input.action)) throw new Error('Unknown request');
    if (['approve', 'approve-bulk'].includes(input.action) && !/^[a-f0-9]{64}$/.test(input.fingerprint || '')) throw new Error('Invalid preview fingerprint');
    if (input.action === 'resolve-conflict' && (!input.path || input.path.includes('..') || path.isAbsolute(input.path))) throw new Error('Invalid path');
    await enqueue(config, input);
    return reply(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/history') {
    const rows: Array<Record<string, unknown>> = [];
    for (const name of await fsp.readdir(stateDir).catch(() => [] as string[])) {
      const pairId = name.replace(/.sqlite$/, '');
      if (!pairIdPattern.test(pairId) || !name.endsWith('.sqlite')) continue;
      try { const db = new StateDb(pairDbFile(pairId), true); for (const item of db.history(200)) rows.push({ ...item, pairId }); db.close(); }
      catch { /* a pair that has not written state yet has no history */ }
    }
    rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return reply(res, 200, rows.slice(0, 500));
  }
  if (req.method === 'GET' && url.pathname === '/api/memory') {
    try { const db = new StateDb(processDbFile, true); const data = db.memorySamples(); db.close(); return reply(res, 200, data); }
    catch { return reply(res, 200, []); }
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/history/') && url.pathname.endsWith('/content')) {
    const id = url.pathname.split('/')[3];
    const db = new StateDb(pairDbFile(pairParam(url.searchParams.get('pairId'))), true); const item = db.historyItem(id); db.close();
    if (!item?.archivePath || !config || !path.resolve(item.archivePath).startsWith(path.resolve(config.ownerLocalAppData, 'FileSync', 'history') + path.sep)) return reply(res, 404, { error: 'Version unavailable' });
    const bytes = await fsp.readFile(item.archivePath);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(item.path).replace(/["\r\n]/g, '')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(bytes); return;
  }
  if (req.method === 'POST' && url.pathname === '/api/open') {
    if (!config) throw new Error('Configure folders first');
    const input = await body<{pairId:string;which:'source'|'backup';path?:string}>(req);
    const pair = config.pairs.find(x => x.id === input.pairId);
    if (!pair || !['source', 'backup'].includes(input.which)) throw new Error('Unknown folder');
    const folder = input.which === 'source' ? pair.source : pair.backup;
    await resolveFolder(folder); // confirms the right drive is connected
    // Explorer cannot open the internal volume-GUID form of the path, so use the drive-letter path.
    const root = folder.displayPath;
    let target = root;
    if (input.path) {
      const parts = input.path.split('/');
      if (parts.some(x => !x || x === '.' || x === '..' || x.includes('\\') || x.includes(':'))) throw new Error('Invalid path');
      target = path.join(root, ...parts);
    }
    const exists = await fsp.lstat(target).then(() => true, () => false);
    // Explorer reports exit code 1 even on success, so errors from it are ignored.
    if (exists && target !== root) execFile('explorer.exe', [`/select,"${target}"`], { windowsHide: false, windowsVerbatimArguments: true }, () => undefined);
    else execFile('explorer.exe', [exists ? target : path.dirname(target)], { windowsHide: false }, () => undefined);
    return reply(res, 200, { ok: true, exists });
  }
  if (req.method === 'POST' && url.pathname === '/api/history/delete') {
    if (!config) throw new Error('Configure folders first');
    const input = await body<{items:Array<{id:string;pairId:string}>}>(req);
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 5000) throw new Error('Choose between 1 and 5000 versions to delete');
    const byPair = new Map<string, string[]>();
    for (const item of input.items) {
      if (!pairIdPattern.test(item.id) || !config.pairs.some(p => p.id === item.pairId)) throw new Error('Invalid history selection');
      byPair.set(item.pairId, [...(byPair.get(item.pairId) || []), item.id]);
    }
    for (const [pairId, ids] of byPair) for (let i = 0; i < ids.length; i += 500) await enqueue(config, { action: 'delete-history', pairId, ids: ids.slice(i, i + 500) });
    return reply(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/restore') {
    if (!config) throw new Error('Configure folders first');
    const input = await body<{id:string;pairId:string}>(req);
    if (!pairIdPattern.test(input.id)) throw new Error('Invalid history ID');
    pairParam(input.pairId);
    await requestElevation({ action: 'restore', id: input.id, pairId: input.pairId });
    await enqueue(config, { action: 'sync-now', pairId: input.pairId });
    return reply(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    const files = (await fsp.readdir(logsDir).catch(() => [])).filter(x => /^service-\d{4}-\d\d-\d\d\.txt$/.test(x)).sort().reverse().slice(0, 7);
    const chunks = await Promise.all(files.map(async name => (await fsp.readFile(path.join(logsDir, name), 'utf8')).slice(-200_000)));
    return reply(res, 200, chunks.join('\n').split('\n').filter(Boolean).slice(-2000).reverse());
  }
  reply(res, 404, { error: 'Not found' });
}

function pairParam(value: string | null | undefined): string {
  if (!value || !pairIdPattern.test(value)) throw new Error('Invalid folder pair');
  return value;
}
function validateMode(mode: SyncMode): void {
  if (!mode || !['immediate', 'manual', 'scheduled'].includes(mode.kind)) throw new Error('Invalid sync mode');
  if (mode.kind === 'scheduled') {
    if (mode.schedule.kind === 'interval' && (!Number.isInteger(mode.schedule.minutes) || mode.schedule.minutes < 15 || mode.schedule.minutes > 1440)) throw new Error('Interval must be 15–1440 minutes');
    if (mode.schedule.kind === 'weekly' && (!mode.schedule.days.length || mode.schedule.days.some(d => d < 0 || d > 6) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(mode.schedule.time))) throw new Error('Invalid weekly schedule');
    if (!['interval', 'weekly'].includes(mode.schedule.kind)) throw new Error('Invalid schedule type');
  }
}
async function enqueue(config: AppConfig, request: object): Promise<void> {
  const dir = ownerRequestsDir(config.ownerLocalAppData);
  await writeJsonAtomic(path.join(dir, `${randomUUID()}.json`), request);
}
async function body<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 128_000) throw new Error('Request too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}
function reply(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(payload));
}
async function staticFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  const target = path.resolve(uiDir, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!target.startsWith(uiDir + path.sep)) return reply(res, 404, { error: 'Not found' });
  try {
    const data = await fsp.readFile(target);
    res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch { reply(res, 404, { error: 'Not found' }); }
}
