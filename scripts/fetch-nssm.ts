import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';

const expected = '727d1e42275c605e0f04aba98095c38a8e1e46def453cdffce42869428aa6743';
const run = promisify(execFile);

async function main() {
  const output = path.join('vendor', 'nssm.exe');
  try { await fsp.access(output); console.log('NSSM already available.'); return; } catch { /* download */ }
  const response = await fetch('https://nssm.cc/release/nssm-2.24.zip');
  if (!response.ok) throw new Error(`NSSM download failed: ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const hash = createHash('sha256').update(data).digest('hex');
  if (hash !== expected) throw new Error('NSSM archive checksum mismatch');
  await fsp.mkdir('vendor', { recursive: true });
  const zip = path.join('vendor', 'nssm-2.24.zip');
  await fsp.writeFile(zip, data);
  await run('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath vendor/nssm-2.24.zip -DestinationPath vendor/nssm-2.24 -Force'], { windowsHide: true });
  await fsp.copyFile(path.join('vendor', 'nssm-2.24', 'nssm-2.24', 'win64', 'nssm.exe'), output);
  console.log('NSSM 2.24 ready.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
