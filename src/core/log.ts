import fsp from 'node:fs/promises';
import path from 'node:path';
import { logsDir } from '../shared/locations';

export async function log(level: 'INFO' | 'WARN' | 'ERROR', text: string): Promise<void> {
  await fsp.mkdir(logsDir, { recursive: true });
  const now = new Date();
  await fsp.appendFile(path.join(logsDir, `service-${now.toISOString().slice(0, 10)}.txt`), `${now.toISOString()} [${level}] ${text.replace(/[\r\n]+/g, ' ')}\n`);
}

export async function purgeLogs(): Promise<void> {
  try {
    const files = await fsp.readdir(logsDir);
    for (const name of files) {
      const match = name.match(/^service-(\d{4}-\d\d-\d\d)\.txt$/);
      if (match && Date.now() - Date.parse(match[1]) > 30 * 86400_000) await fsp.rm(path.join(logsDir, name), { force: true });
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
