# Building and testing

## Requirements

- Windows 10 or 11, x64
- Node.js 24 and npm
- Internet access during the first package build for npm packages, the official NSSM archive, and the Node binary used by `@yao-pkg/pkg`

PowerShell installations that block `npm.ps1` can use `npm.cmd` as shown below.

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test
npm.cmd run package:win
```

The final output is `dist/FileSync.exe`. `npm run package:win` downloads [NSSM 2.24](https://nssm.cc/download) from the official site and checks the archive SHA-256 against `727d1e42275c605e0f04aba98095c38a8e1e46def453cdffce42869428aa6743`. The binary is embedded as a `pkg` asset. The package uses `@yao-pkg/pkg` enhanced SEA mode, which works with Node 24 and the bundled UI assets. `resedit` then injects the icon, version information, and Windows GUI subsystem.

For a packaged runtime smoke check, run `FileSync.exe --smoke <output-json-path>`. A successful result reports `sqlite`, `ui`, and `nssm` as `true`. This does not install a service.

Tests use temporary folders and an isolated worker process. They check existing-folder equality, same-size/same-time content changes, rename convergence, history, backup-side edit protection, schedule calculation, and first-sync approval. The worker integration test changes only temporary test folders.

For local UI development, run `npm.cmd run dev:ui`; for a local manager, first run `npm.cmd run build` and then `npm.cmd run dev:manager`. Service installation is only available from the packaged executable. Environment variables `FILESYNC_PROGRAM_DATA` and `FILESYNC_LOCAL_DATA` allow isolated development storage; `FILESYNC_NO_BROWSER=1` suppresses browser opening for automation.

## Release checklist

Run typecheck, tests, package, and the packaged smoke check on Windows. Inspect the icon at 16 and 256 pixels. Test service installation, start, stop, disable, enable, repair, and uninstall on a disposable Windows machine with a removable drive. Sign the final executable if it will be distributed to other users.
