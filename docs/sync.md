# Sync rules and recovery

## First comparison

The working folder is authoritative. Before the first mirror, FileSync reads both folders without changing either one. It compares directory paths and hashes file bytes, including files with identical sizes and timestamps. Supported metadata is file modification time and the read-only flag. FAT and exFAT have coarse timestamp precision, so differences smaller than two seconds are treated as equal.

If the existing folders match, FileSync initializes its manifest without copying or deleting files. Otherwise, the manager lists planned copies, replacements, removals, metadata updates, estimated copy bytes, and estimated history bytes. The user must approve the exact comparison fingerprint. If either folder changes, the preview is invalidated and a new one is required.

Any number of folder pairs can be configured, each with its own sync mode and schedule. Changing either root of a pair creates a new pairing for that pair only and requires a fresh comparison. The previous history remains available until its normal expiry.

## Applying changes

FileSync copies additions, replaces changed files, mirrors source deletions, and handles moves or renames without leaving the old backup path behind. It detects many renames from file identity or matching hashes. When a rename is uncertain, it still reaches the correct mirror state through a removal and addition. Folder moves may involve copying their contents again.

Before a backup file is overwritten or removed, its old bytes are copied to `%LOCALAPPDATA%\FileSync\history` for the installing user. Files are staged on the backup volume and checked before replacement. Operations are journaled so leftover staging files can be removed after an interrupted run. A failed archive, full disk, changed source, or changed backup stops the affected operation while leaving its previous backup file in place.

FileSync uses short-lived streams with Windows delete sharing. It does not keep file handles open between operations. Other applications can still block a particular operation; FileSync reports the error and retries during a later run. An actively written file is deferred until a stable version can be read. FileSync does not capture every intermediate save made between checks.

## Review states

- A direct backup-side edit or deletion pauses that path. The user can export the edited backup file or choose **Replace from working**. Other unrelated files can continue.
- If a previously populated working folder suddenly becomes empty, FileSync pauses for approval. It also pauses a run that would replace or remove at least 100 files and at least 20% of tracked files. Detected exact-content moves are excluded from this threshold.
- If a selected root or volume disappears, FileSync pauses. It never treats a missing USB drive as a mass deletion. A replacement or reformatted volume must be selected again.
- Unreadable files, case-insensitive name collisions, links, and unsupported file types are reported. An incomplete verification cannot produce **Already synced**.

## Seven-day history

History entries expire 168 hours after creation. The worker removes expired entries hourly and at startup. It never deletes newer versions merely because disk space is low; sync operations pause instead. The **History** tab can view text or images, export any archived file, and restore a version to the working folder. A restore preserves the current working file first when one exists. Restoring a detected rename removes the current renamed path when possible. A conflicting occupied path requires manual review.

History is a short recovery window, not a permanent backup of every past save. Keep another backup for long-term retention or protection from failure of the disk containing AppData.

## Scheduled runs

Intervals are measured from the last run attempt. A local-time schedule runs once per selected day at the chosen time. If a scheduled time is skipped by a daylight-saving jump, the run occurs at the next valid local time; a repeated hour is run once. A missed run caused by shutdown or an absent drive is made up once after both folders become available. Manual mode never makes a catch-up run automatically.
