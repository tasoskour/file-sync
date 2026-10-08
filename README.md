# FileSync

FileSync mirrors one **working folder** to one **backup folder** on Windows. Changes in the backup never flow back automatically. `FileSync.exe` opens a local Vue 3 and Vuetify manager in your default browser; the same executable runs headlessly as a Windows service through NSSM.

## Get started

1. Build `dist/FileSync.exe` with `npm.cmd install` and `npm.cmd run package:win` on Windows 10/11 x64 with Node.js 24. The build downloads and checks NSSM 2.24, compiles TypeScript, builds the UI, generates the icon, and packages one executable.
2. Double-click `FileSync.exe`. Choose an existing **working folder** and **backup folder**, then select **Immediate**, **Scheduled**, or **Manual**.
3. Save the configuration and accept the Windows administrator prompt. Install the service from the **Service** tab.
4. FileSync compares both existing folders. If they already match, it reports **Already synced** and performs no file operations. Otherwise, review the change list and approve the first mirror.

The service runs when the browser is closed or the owner is signed out. It waits safely when a selected USB drive is absent. The manager can be opened again by running `FileSync.exe`.

## Modes

| Mode | Behavior |
| --- | --- |
| Immediate | Watches for changes, waits for saves to settle, then syncs. A periodic reconciliation catches missed notifications. |
| Scheduled | Runs at a configurable interval or on selected days at a local time. A missed run is made up once when both folders return. |
| Manual | The service stays available. Only **Sync now** changes backup files; **Verify folders** is read-only. |

All modes use the same seven-day history and conflict protections. A directly changed backup file is flagged for review before FileSync replaces it.

## Where to read more

- [Sync rules and recovery](docs/sync.md)
- [Windows service and security](docs/windows-service.md)
- [Architecture and storage](docs/architecture.md)
- [Building and testing](docs/development.md)
- [Troubleshooting](docs/troubleshooting.md)

The source is TypeScript throughout the Node.js and Vue application. The custom icon source is [icon.svg](ui/public/icon.svg), and the generated Windows icon is `assets/FileSync.ico`.
