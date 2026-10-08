<script setup lang="ts">
import { computed } from 'vue';
import type { Preview, WorkerStatus } from '../../src/shared/types';

const props = defineProps<{ preview?: Preview; status?: WorkerStatus; busy: boolean }>();
const emit = defineEmits<{ (e: 'send', name: string, extra?: object): void; (e: 'open', which: 'source' | 'backup', path?: string): void }>();

const counts = computed(() => {
  const items = props.preview?.changes || [];
  return { copy: items.filter(x => x.kind === 'copy').length, replace: items.filter(x => x.kind === 'replace').length, remove: items.filter(x => x.kind === 'remove').length, metadata: items.filter(x => x.kind === 'metadata').length };
});
/** Describes what happened to each protected backup file, using the planned change for that path. */
function conflictDetail(path: string): string {
  const change = props.preview?.changes.find(x => x.path === path);
  if (change?.kind === 'remove' || change?.kind === 'rmdir') return 'Exists only in the backup. It was added there directly and is not in your working folder.';
  if (change?.kind === 'copy' || change?.kind === 'mkdir') return 'Was deleted from the backup directly, but it still exists in your working folder.';
  return 'Was edited in the backup directly, so it no longer matches what FileSync last copied.';
}
function size(value?: number) { if (value === undefined) return '—'; const units = ['B','KB','MB','GB','TB']; let n = value, i = 0; while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; } return `${n.toFixed(i ? 1 : 0)} ${units[i]}`; }
</script>

<template>
  <div v-if="preview?.verdict==='already-synced'" class="success-box">Already synced. No copies or deletions are needed.</div>
  <template v-else-if="preview">
    <div class="grid-3 my-4"><div><div class="metric">{{counts.copy}}</div><div class="metric-label">New files</div></div><div><div class="metric">{{counts.replace}}</div><div class="metric-label">Replacements</div></div><div><div class="metric">{{counts.remove}}</div><div class="metric-label">Removals</div></div></div>
    <div class="subtle mb-3">Copy {{size(preview.bytesToCopy)}} · Archive {{size(preview.bytesToArchive)}} · {{counts.metadata}} metadata updates</div>
    <div v-if="preview.warnings.length" class="warning-box mb-3"><strong>Warnings</strong><div v-for="warning in preview.warnings.slice(0,10)" :key="warning">{{warning}}</div></div>
    <div v-if="preview.conflicts.length" class="warning-box mb-3"><strong>Backup-side changes need review</strong><p class="mt-1 mb-2">Someone changed these files <em>inside the backup folder</em> instead of the working folder. FileSync only copies from working to backup, so it has paused these files to avoid overwriting your edit. Other files keep syncing normally.</p><p class="mb-2">Open the folders to compare, then decide: <strong>keep your backup edit</strong> by copying it into the working folder yourself (it will then sync normally), or choose <strong>Replace from working</strong> to overwrite the backup file with the working version. The edited backup file is saved to history first when History is on.</p><div v-for="conflict in preview.conflicts.slice(0,20)" :key="conflict" class="list-row"><div style="min-width:0"><span class="mono">{{conflict}}</span><div class="subtle text-caption">{{conflictDetail(conflict)}}</div></div><div class="toolbar"><v-btn size="small" variant="tonal" prepend-icon="mdi-folder-open-outline" @click="emit('open','source',conflict)">Show in working folder</v-btn><v-btn size="small" variant="tonal" prepend-icon="mdi-folder-open-outline" @click="emit('open','backup',conflict)">Show in backup folder</v-btn><v-btn size="small" variant="text" @click="emit('send','resolve-conflict',{path:conflict})">Replace from working</v-btn></div></div></div>
    <div class="toolbar mb-2"><v-btn size="small" variant="tonal" prepend-icon="mdi-folder-open-outline" @click="emit('open','source')">Open working folder</v-btn><v-btn size="small" variant="tonal" prepend-icon="mdi-folder-open-outline" @click="emit('open','backup')">Open backup folder</v-btn></div><div class="table-wrap" style="max-height:350px;overflow:auto"><table><thead><tr><th>Action</th><th>Relative path</th><th>Size</th></tr></thead><tbody><tr v-for="change in preview.changes.slice(0,500)" :key="change.path"><td>{{change.kind}}</td><td class="mono">{{change.path}}</td><td>{{size(change.source?.size||change.backup?.size)}}</td></tr></tbody></table></div>
    <div v-if="preview.changes.length>500" class="subtle mt-2">Showing the first 500 of {{preview.changes.length}} changes.</div>
    <div class="toolbar mt-5">
      <v-btn v-if="status?.phase==='needs-review'&&status.message.includes('first sync')" color="primary" :loading="busy" @click="emit('send','approve',{fingerprint:preview.fingerprint})">Approve first sync</v-btn>
      <v-btn v-if="status?.phase==='needs-review'&&status.message.includes('large number')" color="warning" :loading="busy" @click="emit('send','approve-bulk',{fingerprint:preview.fingerprint})">Approve bulk changes</v-btn>
    </div>
  </template>
  <div v-else class="empty">Analyze the folders to see what would change.</div>
</template>
