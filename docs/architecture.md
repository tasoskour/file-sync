# Architecture

The repository contains a TypeScript Node.js backend, a Vue 3 and Vuetify manager, and a small Windows packaging pipeline.

1. `src/main.ts` selects manager, worker, elevated-helper, or smoke-test mode. The manager and worker modules are loaded only when needed.
2. The manager serves built UI assets and authenticated local API routes. It reads status and history and submits fixed requests to the worker. Windows service actions use a separate elevated process.
3. The worker is a supervisor with one runner per configured folder pair. Each pair has its own mode, schedule, status, preview, and SQLite state file. For each pair the runner scans both folders, compares them with the SQLite baseline, and either reports differences or applies an approved run. Immediate mode uses Windows file notifications plus a five-minute reconciliation; explicit verification and service startup perform a full hash scan. Immediate-mode routine scans reuse hashes for unchanged metadata and run a full hash audit at least daily.
4. Each file operation stages content, checks preconditions, archives the old backup when applicable, then replaces or removes the backup entry. The SQLite journal records in-progress operations. On restart, stale stage files are discarded and the folders are compared again.

Configuration is version 2: an owner plus a list of pairs (`id`, `name`, working and backup volume identities, and sync mode). A version 1 file with a single pair is upgraded in memory on read. Pairs may not overlap one another or FileSync's own storage.

The user interface reads `status.json` and `previews/<pairId>.json` through the manager. `status.json` holds a status object per pair plus process memory. Each pair's status separates **Checking**, **In sync**, **Pending**, **Syncing**, **Needs review**, **Drive unavailable**, and error states. It includes last verification, progress, and worker RSS and heap usage. The Memory tab reads one hour of process samples from `state/process.sqlite`.

Each pair's database (`state/<pairId>.sqlite`) uses WAL mode. Removing a pair keeps its database until its history expires, then deletes it. The service is its only normal writer; the manager opens it read-only for history and memory views. Elevated restore actions write a history record before changing the working file.

The custom icon is maintained as an SVG under `ui/public`. The build renders seven icon sizes into a Windows `.ico` and embeds it, FileSync version metadata, and a GUI subsystem setting into the packaged executable.

## Supported data

Ordinary files and directories, including hidden items, are in scope. The service preserves file bytes, modification time, and read-only state where the destination filesystem supports them. Symlinks, junctions, network shares, NTFS ACLs, and alternate data streams are outside this version. Filename collisions on a case-insensitive backup are reported rather than overwritten.
