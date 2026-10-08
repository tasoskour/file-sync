# Windows service and security

`FileSync.exe` has a manager mode and a `--service` mode. The manager binds to `127.0.0.1` on a random port and opens the default browser. Every manager API request carries a random session token. The service itself does not expose HTTP. Browser UI files are packaged inside the executable.

The service is named `FileSyncService`. FileSync extracts the included NSSM 2.24 executable to `%ProgramFiles%\FileSync\nssm.exe`, copies itself beside it, and registers `FileSync.exe --service`. Startup defaults to **Automatic (Delayed Start)**. The service runs as LocalSystem so it can access local and USB folders while the owner is signed out. Settings changes and service controls request administrator approval through a fixed-action helper. The manager is limited to the Windows account that originally configured FileSync.

| Location | Contents |
| --- | --- |
| `%ProgramFiles%\FileSync` | Installed FileSync and NSSM executables |
| `%ProgramData%\FileSync\config.json` | Versioned folder and schedule configuration |
| `%ProgramData%\FileSync\state\<pairId>.sqlite` | Per-pair sync manifest, operation journal, history index |
| `%ProgramData%\FileSync\state\process.sqlite` | Worker RAM samples |
| `%ProgramData%\FileSync\previews` | Latest comparison for each pair |
| `%ProgramData%\FileSync\logs` | Dated `.txt` logs, retained for 30 days |
| `%LOCALAPPDATA%\FileSync\history` | Archived file versions, retained for seven days |
| `%LOCALAPPDATA%\FileSync\requests` | Restricted manager-to-worker requests |

Configuration and the database are writable by administrators and SYSTEM. The owner can read status, logs, and history. The service accepts only fixed request actions such as Verify and Sync now. Source and backup roots are recorded with Windows volume GUID paths and serials, rather than relying on drive letters that may change.

The **Service** tab distinguishes installation, Windows startup mode, Windows running state, and sync health. Disabling startup does not stop an already running service; use **Stop** separately. Uninstall removes the service and schedules installed-binary cleanup after the manager closes. Configuration, logs, and unexpired history remain unless removed separately by the owner.

The executable is not code-signed. Windows may show an unknown-publisher prompt on first launch or elevation. For distribution beyond a trusted environment, sign the final `.exe` after the resource and icon step.
