import fsp from 'node:fs/promises';
import path from 'node:path';
import { logsDir } from '../shared/locations';

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** Local date and time with the UTC offset, for example 2026-10-08T18:51:31.296+03:00. */
function localStamp(now: Date): { day: string; stamp: string } {
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
  return { day, stamp: `${day}T${time}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}` };
}

export async function log(level: 'INFO' | 'WARN' | 'ERROR', text: string): Promise<void> {
  await fsp.mkdir(logsDir, { recursive: true });
  const { day, stamp } = localStamp(new Date());
  await fsp.appendFile(path.join(logsDir, `service-${day}.txt`), `${stamp} [${level}] ${text.replace(/[\r\n]+/g, ' ')}\n`);
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
