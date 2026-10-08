import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as ResEdit from 'resedit';

const run = promisify(execFile);

async function main() {
  try { await fsp.access(path.join('vendor', 'nssm.exe')); }
  catch { throw new Error('vendor/nssm.exe is missing. Run npm run fetch:nssm first.'); }
  const pkgBin = path.resolve('node_modules', '@yao-pkg', 'pkg', 'lib-es5', 'bin.js');
  const result = await run(process.execPath, [pkgBin, '.', '--sea', '--target', 'node24-win-x64', '--output', path.join('dist', 'FileSync.exe')], { timeout: 300_000, maxBuffer: 10_000_000 });
  if (result.stdout) console.log(result.stdout);
  const file = path.join('dist', 'FileSync.exe');
  const exe = ResEdit.NtExecutable.from(await fsp.readFile(file), { ignoreCert: true });
  const resources = ResEdit.NtExecutableResource.from(exe);
  const icon = ResEdit.Data.IconFile.from(await fsp.readFile(path.join('assets', 'FileSync.ico')));
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, 1033, icon.icons.map(item => item.data));
  const version = ResEdit.Resource.VersionInfo.fromEntries(resources.entries)[0];
  if (version) {
    version.setFileVersion(0, 1, 0, 0, 1033);
    version.setProductVersion(0, 1, 0, 0, 1033);
    version.setStringValues({ lang: 1033, codepage: 1200 }, { ProductName: 'FileSync', FileDescription: 'FileSync backup manager', OriginalFilename: 'FileSync.exe', FileVersion: '0.1.0', ProductVersion: '0.1.0' });
    version.outputToResourceEntries(resources.entries);
  }
  exe.newHeader.optionalHeader.subsystem = 2;
  resources.outputResource(exe);
  await fsp.writeFile(file, Buffer.from(exe.generate()));
  console.log(`Created ${file}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
