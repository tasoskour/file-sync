import { execFile, type ExecFileOptions } from 'node:child_process';

// util.promisify(execFile) loses its {stdout, stderr} result inside the packaged exe, so wrap it by hand.
export function run(file: string, args: string[], options: ExecFileOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(error); else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
