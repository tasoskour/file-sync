# Troubleshooting

| What you see | What to do |
| --- | --- |
| **Drive unavailable** | Reconnect the original USB drive. FileSync checks its volume identity and waits; it will not delete backup data because a drive is missing. |
| **Needs review: backup changed** | Open **Folders & schedule**, inspect or export the backup edit, then choose **Replace from working** if appropriate. |
| **Review the existing folders** | Check the first-sync preview. Backup-only and replaced files will be archived for seven days before removal. Approve the preview to start. |
| **Large number of files would change** | Inspect the preview and confirm the bulk-change action. An empty working root is always guarded after a prior sync. |
| **Verification incomplete** | Check warnings for unreadable or actively changing files. Close the editing application if needed, then select **Verify folders**. |
| **History space unavailable** | Free space on the drive containing the owner's Local AppData. FileSync will keep the live backup file rather than overwrite it without a saved old version. |
| **Service stopped or disabled** | Use the **Service** tab to enable and start it. Windows may ask for administrator approval. |
| **Folder moved to a new USB drive** | Select the replacement folder in **Folders & schedule**. FileSync treats it as a new pair and shows a fresh first-sync preview. |

Detailed logs are under `%ProgramData%\FileSync\logs` and can be searched in the **Logs** tab. If the browser manager cannot open, the service continues running independently. Reopen `FileSync.exe` or check `FileSyncService` in Windows Services.
