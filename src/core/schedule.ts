import type { SyncMode } from '../shared/types';

export function nextRun(mode: SyncMode, now: Date, lastRun?: Date): Date | undefined {
  if (mode.kind !== 'scheduled') return undefined;
  if (mode.schedule.kind === 'interval') {
    const minutes = mode.schedule.minutes;
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 1440) throw new Error('Interval must be 15–1440 minutes');
    return new Date((lastRun || now).getTime() + minutes * 60_000);
  }
  const { days, time } = mode.schedule;
  if (!days.length || days.some(d => !Number.isInteger(d) || d < 0 || d > 6) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Invalid weekly schedule');
  const [hour, minute] = time.split(':').map(Number);
  for (let offset = 0; offset < 8; offset++) {
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour, minute);
    if (!days.includes(candidate.getDay())) continue;
    if (candidate <= now || (lastRun && candidate <= lastRun)) continue;
    return candidate;
  }
  throw new Error('No next scheduled run');
}
