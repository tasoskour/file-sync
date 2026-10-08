async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === '--service') await require('./core/worker').runWorker();
  else if (mode === '--elevated') await require('./windows/service').runElevated(process.argv[3]);
  else if (mode === '--smoke') {
    const fs = require('node:fs');
    const path = require('node:path');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:'); db.exec('SELECT 1'); db.close();
    const report = { sqlite: true, ui: fs.existsSync(path.resolve(__dirname, '../ui/index.html')), nssm: fs.existsSync(path.resolve(__dirname, '../../vendor/nssm.exe')) };
    fs.writeFileSync(process.argv[3], JSON.stringify(report));
  }
  else await require('./manager/server').runManager();
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : error}\n`); process.exitCode = 1; });
