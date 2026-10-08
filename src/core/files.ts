import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FileEntry } from '../shared/types';

export interface ScanResult { entries: Map<string, FileEntry>; warnings: string[]; incomplete: string[] }
export interface ScanOptions { previous?: Map<string, FileEntry>; forcePaths?: Set<string>; onEntry?: (count:number, path:string)=>void }

export async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(file);
  try {
    for await (const chunk of stream) hash.update(chunk);
  } finally {
    stream.destroy();
  }
  return hash.digest('hex');
}

async function stableFile(file: string, relative: string): Promise<FileEntry> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await fsp.lstat(file, { bigint: true });
    if (!before.isFile()) throw new Error('File type changed during scan');
    const hash = await sha256(file);
    const after = await fsp.lstat(file, { bigint: true });
    if (before.size === after.size && before.mtimeNs === after.mtimeNs && before.ino === after.ino) {
      return {
        path: relative, kind: 'file', size: Number(after.size),
        mtimeMs: Number(after.mtimeNs) / 1e6, readonly: !(Number(after.mode) & 0o200),
        hash, ino: after.ino.toString(),
      };
    }
  }
  throw new Error('File changed during verification');
}

export async function scanTree(root: string, options: ScanOptions = {}): Promise<ScanResult> {
  const entries = new Map<string, FileEntry>();
  const warnings: string[] = [];
  const incomplete: string[] = [];
  const folded = new Map<string, string>();
  let count = 0;
  const visit = async (relative: string): Promise<void> => {
    const absolute = path.join(root, relative);
    let listing: string[];
    let before;
    try { before = await fsp.lstat(absolute, { bigint: true }); }
    catch (error) { incomplete.push(`${relative || '.'}: ${message(error)}`); return; }
    try { listing = await fsp.readdir(absolute); }
    catch (error) { incomplete.push(`${relative || '.'}: ${message(error)}`); return; }
    listing.sort((a, b) => a.localeCompare(b));
    for (const name of listing) {
      if (name.includes('.filesync-stage-')) continue;
      const rel = relative ? `${relative}/${name}` : name;
      options.onEntry?.(++count, rel);
      const key = rel.toLocaleLowerCase('en-US');
      const prior = folded.get(key);
      if (prior && prior !== rel) { incomplete.push(`Case-insensitive name collision: ${prior} and ${rel}`); continue; }
      folded.set(key, rel);
      const full = path.join(root, ...rel.split('/'));
      try {
        const stat = await fsp.lstat(full, { bigint: true });
        if (stat.isSymbolicLink()) { warnings.push(`Skipped link or junction: ${rel}`); continue; }
        if (stat.isDirectory()) {
          entries.set(rel, { path: rel, kind: 'dir', size: 0, mtimeMs: Number(stat.mtimeNs) / 1e6, readonly: false, ino: stat.ino.toString() });
          await visit(rel);
        } else if (stat.isFile()) {
          const previous = options.previous?.get(rel);
          const unchanged = previous?.kind === 'file' && previous.size === Number(stat.size)
            && Math.abs(previous.mtimeMs - Number(stat.mtimeNs) / 1e6) < 1
            && previous.ino === stat.ino.toString() && previous.readonly === !(Number(stat.mode) & 0o200)
            && !options.forcePaths?.has(rel);
          entries.set(rel, unchanged ? { ...previous, path: rel } : await stableFile(full, rel));
        } else warnings.push(`Skipped unsupported item: ${rel}`);
      } catch (error) { incomplete.push(`${rel}: ${message(error)}`); }
    }
    try {
      const after = await fsp.lstat(absolute, { bigint: true });
      const later = (await fsp.readdir(absolute)).sort((a, b) => a.localeCompare(b));
      if (before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || listing.join('\0') !== later.join('\0')) incomplete.push(`${relative || '.'}: folder changed during verification`);
    } catch (error) { incomplete.push(`${relative || '.'}: ${message(error)}`); }
  };
  await visit('');
  return { entries, warnings, incomplete };
}

export function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fsp.writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
    await fsp.rename(temporary, file);
  } finally { await fsp.rm(temporary, { force: true }).catch(() => undefined); }
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
