import os from 'node:os';
import path from 'node:path';

export const SERVICE_NAME = 'FileSyncService';
export const programData = process.env.FILESYNC_PROGRAM_DATA || path.join(process.env.ProgramData || 'C:\\ProgramData', 'FileSync');
export const localData = process.env.FILESYNC_LOCAL_DATA || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'FileSync');
export const configFile = path.join(programData, 'config.json');
export const statusFile = path.join(programData, 'status.json');
export const previewsDir = path.join(programData, 'previews');
export const stateDir = path.join(programData, 'state');
export const processDbFile = path.join(stateDir, 'process.sqlite');
export const pairIdPattern = /^[a-f0-9-]{36}$/;
export const pairDbFile = (pairId: string): string => path.join(stateDir, `${pairId}.sqlite`);
export const pairPreviewFile = (pairId: string): string => path.join(previewsDir, `${pairId}.json`);
export const logsDir = path.join(programData, 'logs');

export function ownerHistoryDir(ownerLocalAppData: string): string {
  return path.join(ownerLocalAppData, 'FileSync', 'history');
}
export function ownerRequestsDir(ownerLocalAppData: string): string {
  return path.join(ownerLocalAppData, 'FileSync', 'requests');
}
