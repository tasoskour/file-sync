<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import ReviewPanel from './ReviewPanel.vue';
import { lang, locale, setLang, t, tMessage } from './i18n';
import type { AppConfig, Preview, ServiceStatus, SyncMode, WorkerStatus } from '../../src/shared/types';

type ServiceInfo = { installed:boolean; state:string; startMode:string; processId?:number; pathName?:string };
type HistoryItem = {id:string;pairId:string;path:string;operation:string;createdAt:string;expiresAt:string;archivePath?:string;hash?:string};
type MemorySample = {at:string;rss:number;heapUsed:number};
type FolderInfo = {volumeId:string;volumeSerial:string;freeBytes:number};
type Draft = {
  key:string; id?:string; name:string; sourcePath:string; backupPath:string;
  keepHistory:boolean; modeKind:'immediate'|'scheduled'|'manual'; scheduleKind:'interval'|'weekly'; minutes:number; localTime:string; days:number[];
  sourceInfo?:FolderInfo; backupInfo?:FolderInfo;
};
const tabs = [
  { key: 'home', label: 'Overview', icon: 'mdi-view-dashboard-outline' },
  { key: 'folders', label: 'Folders & schedule', icon: 'mdi-folder-sync-outline' },
  { key: 'service', label: 'Service', icon: 'mdi-cog-outline' },
  { key: 'history', label: 'History', icon: 'mdi-history' },
  { key: 'logs', label: 'Logs', icon: 'mdi-text-box-search-outline' },
  { key: 'memory', label: 'Memory', icon: 'mdi-memory' },
] as const;
const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const tab = ref<(typeof tabs)[number]['key']>('home');
const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
const config = ref<AppConfig>();
const status = ref<ServiceStatus>();
const managerBuildId = ref('');
const service = ref<ServiceInfo>({ installed:false, state:'not-installed', startMode:'none' });
const previews = ref<Record<string, Preview>>({});
const selectedId = ref('');
const drafts = ref<Draft[]>([]);
const history = ref<HistoryItem[]>([]);
const logs = ref<string[]>([]);
const memory = ref<MemorySample[]>([]);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const logQuery = ref('');
const logLevel = ref('All');
const previewVisible = ref(false);
const previewText = ref('');
const previewUrl = ref('');
const previewType = ref<'text'|'image'|'other'>('other');
const previewName = ref('');
let timer: number | undefined;
let loadedSignature = '';
let loadingDrafts = false;
let draftsDirty = false;
let draftCounter = 0;

watch(drafts, () => { if (!loadingDrafts) draftsDirty = true; }, { deep: true });

async function api<T>(route:string, method='GET', payload?:unknown):Promise<T> {
  const response = await fetch(`/api/${route}`, { method, headers:{'X-FileSync-Token':token, ...(payload ? {'Content-Type':'application/json'} : {})}, body: payload ? JSON.stringify(payload) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || t('Request failed ({status})',{status:response.status}));
  return data as T;
}
async function action(task:()=>Promise<unknown>, success='Done'):Promise<void> {
  busy.value=true; error.value=''; notice.value='';
  try { await task(); notice.value=t(success); await refresh(); }
  catch (e) { error.value=e instanceof Error ? e.message : String(e); }
  finally { busy.value=false; }
}

function draftFromPair(pair: AppConfig['pairs'][number]): Draft {
  const mode = pair.mode;
  const draft: Draft = { key:pair.id, id:pair.id, name:pair.name, sourcePath:pair.source.displayPath, backupPath:pair.backup.displayPath, keepHistory:pair.keepHistory!==false, modeKind:mode.kind, scheduleKind:'interval', minutes:120, localTime:'02:00', days:[0,1,2,3,4,5,6] };
  if (mode.kind==='scheduled') {
    draft.scheduleKind=mode.schedule.kind;
    if (mode.schedule.kind==='interval') draft.minutes=mode.schedule.minutes;
    else { draft.localTime=mode.schedule.time; draft.days=[...mode.schedule.days]; }
  }
  return draft;
}
function newDraft():Draft {
  draftCounter++;
  const taken = new Set(drafts.value.map(x=>x.name.toLowerCase()));
  let n = drafts.value.length + 1;
  while (taken.has(`${t('Backup')} ${n}`.toLowerCase())) n++;
  return { key:`new-${draftCounter}`, name:`${t('Backup')} ${n}`, sourcePath:'', backupPath:'', keepHistory:true, modeKind:'immediate', scheduleKind:'interval', minutes:120, localTime:'02:00', days:[0,1,2,3,4,5,6] };
}
function addPair() { drafts.value.push(newDraft()); }
function removePair(draft:Draft) {
  if (!confirm(t('Remove "{name}"? Files in both folders are left untouched. Saved history stays available until it expires.',{name:draft.name}))) return;
  drafts.value=drafts.value.filter(x=>x.key!==draft.key);
}
function makeMode(d:Draft):SyncMode {
  if (d.modeKind==='manual') return {kind:'manual'};
  if (d.modeKind==='immediate') return {kind:'immediate'};
  return {kind:'scheduled',schedule:d.scheduleKind==='interval' ? {kind:'interval',minutes:Number(d.minutes)} : {kind:'weekly',days:d.days,time:d.localTime}};
}

async function refresh():Promise<void> {
  try {
    const state=await api<{config?:AppConfig;status?:ServiceStatus;service:ServiceInfo;managerBuildId?:string}>('state');
    managerBuildId.value=state.managerBuildId||'';
    config.value=state.config; status.value=state.status; service.value=state.service;
    const signature = JSON.stringify(state.config?.pairs || []);
    if (signature!==loadedSignature && !draftsDirty) {
      loadedSignature=signature; loadingDrafts=true;
      drafts.value=(state.config?.pairs||[]).map(draftFromPair);
      setTimeout(()=>{ loadingDrafts=false; draftsDirty=false; },0);
      for (const id of Object.keys(previews.value)) if (!state.config?.pairs.some(p=>p.id===id)) delete previews.value[id];
    }
    const pairs=state.config?.pairs||[];
    if (!pairs.some(p=>p.id===selectedId.value)) selectedId.value=pairs[0]?.id||'';
    for (const pair of pairs) {
      const summary=state.status?.pairs?.[pair.id]?.preview;
      if (summary && summary.pairId===pair.id && previews.value[pair.id]?.fingerprint!==summary.fingerprint) {
        const loaded=await api<Preview|null>(`preview?pairId=${pair.id}`);
        if (loaded) previews.value[pair.id]=loaded;
      }
    }
  } catch (e) { error.value=e instanceof Error ? e.message : String(e); }
}
async function refreshTab():Promise<void> {
  if (tab.value==='history') history.value=await api<HistoryItem[]>('history');
  if (tab.value==='logs') logs.value=await api<string[]>('logs');
  if (tab.value==='memory') memory.value=await api<MemorySample[]>('memory');
}
function visit(key:(typeof tabs)[number]['key']) { tab.value=key; void refreshTab().catch(e=>error.value=String(e)); }

function saveConfig() {
  void action(async()=>{
    for (const d of drafts.value) { if (!d.name.trim()) throw new Error(t('Give every folder pair a name')); if (!d.sourcePath||!d.backupPath) throw new Error(t('Choose both folders for "{name}"',{name:d.name})); }
    await api('config','POST',{pairs:drafts.value.map(d=>({id:d.id,name:d.name.trim(),sourcePath:d.sourcePath,backupPath:d.backupPath,mode:makeMode(d),keepHistory:d.keepHistory}))});
    draftsDirty=false; loadedSignature='';
  },'Configuration saved. The service picks it up within a few seconds.');
}
function control(name:string) { void action(()=>api('service','POST',{action:name}),t('Service action completed: {name}.',{name:t(name)})); }
function send(pairId:string, name:string, extra:object={}) { void action(()=>api('request','POST',{action:name,pairId,...extra}),name==='verify'?'Verification requested.':'Request sent to the service.'); }
async function openFolder(pairId:string, which:'source'|'backup', path?:string) {
  try { const r=await api<{exists:boolean}>('open','POST',{pairId,which,path}); if(!r.exists) notice.value=t('That file no longer exists there, so its folder was opened instead.'); }
  catch (e) { error.value=e instanceof Error ? e.message : String(e); }
}
function syncAll() { for (const pair of config.value?.pairs||[]) send(pair.id,'sync-now'); }
async function pick(d:Draft, which:'source'|'backup') {
  await action(async()=>{ const result=await api<{path?:string}>('pick-folder','POST',{}); if(result.path){ if(which==='source') d.sourcePath=result.path; else d.backupPath=result.path; await inspect(d,which); } },'Folder selected.');
}
async function inspect(d:Draft, which:'source'|'backup') {
  const selected=which==='source'?d.sourcePath:d.backupPath;
  if(!selected)return;
  const info=await api<FolderInfo>('inspect-folder','POST',{path:selected});
  if(which==='source')d.sourceInfo=info;else d.backupInfo=info;
}
function pairName(id:string) { return config.value?.pairs.find(p=>p.id===id)?.name||t('Removed pair'); }
function contentUrl(item:HistoryItem) { return `/api/history/${item.id}/content?pairId=${item.pairId}`; }
async function download(item:HistoryItem) {
  await action(async()=>{
    const response=await fetch(contentUrl(item),{headers:{'X-FileSync-Token':token}});
    if(!response.ok) throw new Error(t('Could not open this version'));
    const blob=await response.blob(); const url=URL.createObjectURL(blob); const anchor=document.createElement('a');
    anchor.href=url; anchor.download=item.path.split('/').at(-1)||'file'; anchor.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  },'Version exported.');
}
function restore(item:HistoryItem) {
  if(!confirm(t('Restore {path} to the working folder of "{name}"? The current working file will be saved to history first.',{path:item.path,name:pairName(item.pairId)}))) return;
  void action(()=>api('restore','POST',{id:item.id,pairId:item.pairId}),'Version restored to the working folder.');
}
async function viewItem(item:HistoryItem) {
  await action(async()=>{
    if(previewUrl.value)URL.revokeObjectURL(previewUrl.value);
    const extension=item.path.split('.').at(-1)?.toLowerCase()||'';
    const response=await fetch(contentUrl(item),{headers:{'X-FileSync-Token':token}});
    if(!response.ok)throw new Error(t('Could not open this version'));
    const blob=await response.blob();
    if(blob.size>2_000_000)throw new Error(t('This version is too large for an in-app preview. Use Export.'));
    previewName.value=item.path;
    if(['txt','md','json','csv','xml','log','ts','js','vue','css','html'].includes(extension)){previewType.value='text';previewText.value=(await blob.text()).slice(0,100_000);}
    else if(['png','jpg','jpeg','gif','webp','bmp'].includes(extension)){previewType.value='image';previewUrl.value=URL.createObjectURL(blob);}
    else previewType.value='other';
    previewVisible.value=true;
  },'Version opened.');
}

const selected = ref<string[]>([]);
const historyKey = (item:HistoryItem) => `${item.pairId}:${item.id}`;
const historyGroups = computed(() => {
  const groups = new Map<string, { label:string; items:HistoryItem[] }>();
  for (const item of history.value) {
    const when = new Date(item.createdAt);
    const key = `${when.getFullYear()}-${when.getMonth()}-${when.getDate()}`;
    if (!groups.has(key)) groups.set(key, { label: when.toLocaleDateString(locale.value, { weekday:'long', year:'numeric', month:'long', day:'numeric' }), items: [] });
    groups.get(key)!.items.push(item);
  }
  return [...groups.entries()].map(([key, group]) => ({ key, ...group }));
});
function isSelected(item:HistoryItem) { return selected.value.includes(historyKey(item)); }
function toggleItem(item:HistoryItem, on:boolean|null) {
  const key = historyKey(item);
  selected.value = on ? [...new Set([...selected.value, key])] : selected.value.filter(x => x !== key);
}
function groupState(items:HistoryItem[]) { const n = items.filter(isSelected).length; return { all: n === items.length && n > 0, some: n > 0 && n < items.length }; }
function toggleGroup(items:HistoryItem[], on:boolean|null) {
  const keys = items.map(historyKey);
  selected.value = on ? [...new Set([...selected.value, ...keys])] : selected.value.filter(x => !keys.includes(x));
}
function versions(n:number) { return n===1 ? t('1 version') : t('{n} versions',{n}); }
function deleteHistory(items:HistoryItem[], description:string) {
  if (!items.length) return;
  if (!confirm(t('Permanently delete {description}? These saved versions can no longer be restored.',{description}))) return;
  void action(async () => {
    await api('history/delete', 'POST', { items: items.map(x => ({ id:x.id, pairId:x.pairId })) });
    const gone = new Set(items.map(historyKey));
    history.value = history.value.filter(x => !gone.has(historyKey(x)));
    selected.value = selected.value.filter(x => !gone.has(x));
    window.setTimeout(() => { void refreshTab().catch(() => undefined); }, 4000);
  }, 'Deletion requested. The service removes the files within a few seconds.');
}
const selectedItems = computed(() => history.value.filter(isSelected));
/** Shows a log line's leading timestamp (UTC in older lines, local with offset in newer ones) in the viewer's local time. */
function logLine(line:string) {
  const match=/^(\d{4}-\d\d-\d\dT\S+) (.*)$/.exec(line);
  if(!match||Number.isNaN(Date.parse(match[1]))) return line;
  const when=new Date(match[1]);
  const p=(n:number)=>String(n).padStart(2,'0');
  return `${when.getFullYear()}-${p(when.getMonth()+1)}-${p(when.getDate())} ${p(when.getHours())}:${p(when.getMinutes())}:${p(when.getSeconds())} ${match[2]}`;
}
function exportLogs(){const blob=new Blob([filteredLogs.value.join('\n')],{type:'text/plain'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='FileSync-logs.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

const phaseLabels:Record<string,string>={'unconfigured':'Not configured','checking':'Checking folders','in-sync':'In sync','pending':'Changes pending','syncing':'Syncing','needs-review':'Needs review','drive-unavailable':'Drive unavailable','verification-incomplete':'Check incomplete','error':'Service error'};
const phaseOrder=['error','needs-review','drive-unavailable','verification-incomplete','syncing','checking','pending','in-sync'];
function phaseLabel(phase?:string) { return t(phaseLabels[phase||'']||'Starting'); }
function phaseColor(phase?:string) { return phase==='in-sync'?'success':phase==='needs-review'||phase==='error'||phase==='drive-unavailable'||phase==='verification-incomplete'?'warning':'primary'; }
function pairStatus(id:string):WorkerStatus|undefined { return status.value?.pairs?.[id]; }
const outdatedService=computed(()=>service.value.installed&&service.value.state==='Running'&&!!managerBuildId.value&&!!status.value&&status.value.buildId!==managerBuildId.value);
const pairCount=computed(()=>config.value?.pairs.length||0);
const overallPhase=computed(()=>{
  const phases=(config.value?.pairs||[]).map(p=>pairStatus(p.id)?.phase).filter((x):x is WorkerStatus['phase']=>!!x);
  return phaseOrder.find(x=>phases.includes(x as WorkerStatus['phase']));
});
const stateLabel=computed(()=>{
  if(!service.value.installed) return t('Service not installed');
  if(service.value.startMode==='Disabled') return t('Service disabled');
  if(service.value.state!=='Running') return t('Service stopped');
  if(!pairCount.value) return t('Not configured');
  return phaseLabel(overallPhase.value);
});
const heroMessage=computed(()=>{
  if(!service.value.installed) return t('Install the service on the Service tab so backups can run in the background.');
  if(!pairCount.value) return t('Add a working and backup folder to begin.');
  const total=pairCount.value; const synced=(config.value?.pairs||[]).filter(p=>pairStatus(p.id)?.phase==='in-sync').length;
  return t(total===1?'{synced} of {total} folder pair in sync.':'{synced} of {total} folder pairs in sync.',{synced,total});
});
const needsAttention=(id:string)=>{ const st=pairStatus(id); return !!st&&(['needs-review','error','drive-unavailable','verification-incomplete'].includes(st.phase)||(st.preview?.conflicts?.length||0)>0); };
const needsReview=(id:string)=>{ const st=pairStatus(id); return !!st&&(st.phase==='needs-review'||st.phase==='verification-incomplete'||(st.preview?.conflicts?.length||0)>0); };
const attentionPairs=computed(()=>(config.value?.pairs||[]).filter(p=>needsAttention(p.id)));
const selectedPreview=computed(()=>previews.value[selectedId.value]);
const selectedStatus=computed(()=>pairStatus(selectedId.value));
function counts(p?:Preview){
  const items=p?.changes||[]; return {copy:items.filter(x=>x.kind==='copy').length, replace:items.filter(x=>x.kind==='replace').length, remove:items.filter(x=>x.kind==='remove').length, metadata:items.filter(x=>x.kind==='metadata').length};
}
const filteredLogs=computed(()=>logs.value.filter(x=>(logLevel.value==='All'||x.includes(`[${logLevel.value}]`))&&x.toLowerCase().includes(logQuery.value.toLowerCase())));
const chartPoints=computed(()=>{
  if(memory.value.length<2) return '';
  const max=Math.max(...memory.value.map(x=>x.rss),1); return memory.value.map((x,i)=>`${(i/(memory.value.length-1))*100},${95-(x.rss/max)*85}`).join(' ');
});
function date(value?:string) {return value?new Date(value).toLocaleString(locale.value): '—';}
function size(value?:number) {if(value===undefined)return '—'; const units=['B','KB','MB','GB','TB'];let n=value,i=0;while(n>=1024&&i<units.length-1){n/=1024;i++;}return `${n.toFixed(i?1:0)} ${units[i]}`;}
function modeText(mode:SyncMode) {
  if(mode.kind==='immediate') return t('Immediate');
  if(mode.kind==='manual') return t('Manual');
  return mode.schedule.kind==='interval'?t('Every {n} min',{n:mode.schedule.minutes}):t('{days} at {time}',{days:mode.schedule.days.map(d=>t(dayNames[d])).join(', '),time:mode.schedule.time});
}
const operationLabels:Record<string,string>={version:'Saved version',deleted:'Deleted from working folder',replace:'Replaced in backup',remove:'Removed from backup',rename:'Renamed','pre-restore':'Before restore',metadata:'Attributes changed'};
function operationLabel(op:string) { return t(operationLabels[op]||op); }
onMounted(async()=>{await refresh();timer=window.setInterval(async()=>{await refresh();if(tab.value==='memory')await refreshTab();},5000);});
onUnmounted(()=>{if(timer)clearInterval(timer);});
window.addEventListener('pagehide',()=>{ try { navigator.sendBeacon('/api/closed',new Blob([JSON.stringify({token})],{type:'text/plain'})); } catch { /* the manager also exits when idle */ } });
</script>

<template>
  <v-app><div class="app-shell">
    <aside class="sidebar" :aria-label="t('Main navigation')">
      <div class="brand"><img class="brand-icon" src="/icon.svg" alt=""><span>FileSync</span></div>
      <nav><button v-for="item in tabs" :key="item.key" class="nav-item" :class="{active:tab===item.key}" :aria-current="tab===item.key?'page':undefined" @click="visit(item.key)"><i class="mdi" :class="item.icon" aria-hidden="true"></i><span class="nav-label">{{t(item.label)}}</span><span v-if="item.key==='home'&&attentionPairs.length" class="nav-badge" :title="t('{n} item(s) need attention',{n:attentionPairs.length})">{{attentionPairs.length}}</span></button></nav>
      <div class="lang-switch" role="group" :aria-label="t('Language')"><button :class="{active:lang==='en'}" @click="setLang('en')">EN</button><button :class="{active:lang==='el'}" @click="setLang('el')">ΕΛ</button></div>
      <div class="sidebar-foot">{{t('Each working folder stays the source of truth.')}}<br>{{t('Changes flow to its backup only.')}}</div>
    </aside>
    <main class="content">
      <div v-if="error" class="warning-box mb-4" role="alert">{{error}} <v-btn variant="text" size="small" @click="error=''">{{t('Dismiss')}}</v-btn></div>
      <div v-if="notice" class="success-box mb-4" role="status">{{notice}}</div>

      <template v-if="tab==='home'">
        <div class="eyebrow">{{t('Backup overview')}}</div><h1 class="page-title">{{t('Your folders at a glance')}}</h1><p class="subtle mb-6">{{t('The state of every working folder and its backup.')}}</p>
        <div class="hero mb-5"><div><div class="text-overline">{{t('Current status')}}</div><h2><span class="status-dot"></span>{{stateLabel}}</h2><p>{{heroMessage}}</p></div><v-btn v-if="pairCount>1" color="white" variant="flat" :loading="busy" @click="syncAll">{{t('Sync all now')}}</v-btn><v-btn v-else-if="pairCount===1" color="white" variant="flat" :loading="busy" @click="send(config!.pairs[0].id,'sync-now')">{{t('Sync now')}}</v-btn><v-btn v-else color="white" variant="flat" @click="visit('folders')">{{t('Add folders')}}</v-btn></div>
        <div v-if="outdatedService" class="attention-box mb-5" role="alert"><i class="mdi mdi-alert-circle" aria-hidden="true"></i><div><strong>{{t('The background service is an older version')}}</strong><p class="mt-1 mb-2">{{t('The running service was installed from an earlier build, so newer features such as history may not work yet. Use Repair to update it.')}}</p><v-btn color="warning" variant="flat" size="small" :loading="busy" @click="control('repair')">{{t('Repair')}}</v-btn></div></div>
        <div v-if="attentionPairs.length" class="attention-box mb-5" role="alert"><i class="mdi mdi-alert-circle" aria-hidden="true"></i><div><strong>{{t(attentionPairs.length===1?'Action required: {n} folder pair needs your attention':'Action required: {n} folder pairs need your attention',{n:attentionPairs.length})}}</strong><div v-for="pair in attentionPairs" :key="pair.id" class="mt-1"><strong>{{pair.name}}</strong> — {{tMessage(pairStatus(pair.id)?.message)}}</div><div class="mt-1">{{t('Nothing is changed in a pair until you review it below.')}}</div></div></div>
        <div v-if="!pairCount" class="empty">{{t('No folder pairs yet. Open Folders & schedule to add one.')}}</div>
        <div v-for="pair in config?.pairs" :key="pair.id" class="panel mb-4" :class="{attention:needsAttention(pair.id)}">
          <div class="d-flex justify-space-between align-center flex-wrap ga-2 mb-3">
            <div><h2 class="section-title mb-0">{{pair.name}}</h2><div class="subtle text-caption">{{modeText(pair.mode)}}</div></div>
            <v-chip :color="needsAttention(pair.id)?'warning':phaseColor(pairStatus(pair.id)?.phase)" :variant="needsAttention(pair.id)?'flat':'tonal'" :prepend-icon="needsAttention(pair.id)?'mdi-alert':undefined" size="small">{{phaseLabel(pairStatus(pair.id)?.phase)}}</v-chip>
          </div>
          <div class="grid-2 mb-3"><div class="path-card"><i class="mdi mdi-folder-edit-outline"></i><div><div class="mini-label">{{t('Working folder')}}</div><div class="path-value">{{pair.source.displayPath}}</div></div></div><div class="path-card"><i class="mdi mdi-folder-check-outline"></i><div><div class="mini-label">{{t('Backup folder')}}</div><div class="path-value">{{pair.backup.displayPath}}</div></div></div></div>
          <p class="subtle mb-3">{{tMessage(pairStatus(pair.id)?.message)||t('Waiting for the service…')}}</p>
          <div class="grid-3 mb-3"><div><div class="metric-label">{{t('Last verified')}}</div><div class="font-weight-bold">{{date(pairStatus(pair.id)?.lastVerifiedAt)}}</div></div><div><div class="metric-label">{{t('Last successful sync')}}</div><div class="font-weight-bold">{{date(pairStatus(pair.id)?.lastSyncedAt)}}</div></div><div><div class="metric-label">{{t('Next scheduled run')}}</div><div class="font-weight-bold">{{pair.mode.kind==='scheduled'?date(pairStatus(pair.id)?.nextRunAt):t('Not scheduled')}}</div></div></div>
          <template v-if="pairStatus(pair.id)?.progress"><v-progress-linear :indeterminate="!pairStatus(pair.id)!.progress!.total" :model-value="pairStatus(pair.id)!.progress!.total?pairStatus(pair.id)!.progress!.done/pairStatus(pair.id)!.progress!.total*100:0" color="primary" height="9" rounded></v-progress-linear><div class="subtle mt-2 mb-3">{{pairStatus(pair.id)!.progress!.total?t('{done} of {total} changes',{done:pairStatus(pair.id)!.progress!.done,total:pairStatus(pair.id)!.progress!.total}):t('{done} items checked',{done:pairStatus(pair.id)!.progress!.done})}} · {{pairStatus(pair.id)!.progress!.current}}</div></template>
          <div v-if="previews[pair.id]&&previews[pair.id].verdict==='already-synced'" class="success-box mb-3">{{t('Folders match. No files need to change.')}}</div>
          <div v-else-if="previews[pair.id]" class="subtle mb-3">{{t('{a} to copy or update · {b} to remove from backup · {c} rename(s)',{a:counts(previews[pair.id]).copy+counts(previews[pair.id]).replace,b:counts(previews[pair.id]).remove,c:previews[pair.id].renames?.length||0})}}</div>
          <div class="toolbar"><v-btn color="primary" variant="flat" size="small" :loading="busy" @click="send(pair.id,'sync-now')">{{t('Sync now')}}</v-btn><v-btn variant="tonal" size="small" prepend-icon="mdi-refresh" :loading="busy" @click="send(pair.id,'verify')">{{t('Verify folders')}}</v-btn></div>
          <div v-if="needsReview(pair.id)" class="mt-4"><h3 class="section-title">{{t('Analyze and review')}} <v-chip color="warning" size="x-small" variant="flat" class="ml-2">{{t('Important')}}</v-chip></h3><ReviewPanel :preview="previews[pair.id]" :status="pairStatus(pair.id)" :busy="busy" @send="(name,extra)=>send(pair.id,name,extra)" @open="(which,p)=>openFolder(pair.id,which,p)"></ReviewPanel></div>
        </div>
      </template>

      <template v-if="tab==='folders'">
        <div class="eyebrow">{{t('Setup and timing')}}</div><h1 class="page-title">{{t('Folders & schedule')}}</h1><p class="subtle mb-6">{{t('Each pair mirrors one working folder to one backup folder, in one direction, on its own schedule.')}}</p>
        <div class="stack">
          <div v-if="!drafts.length" class="empty">{{t('No folder pairs yet. Add one to start backing up.')}}</div>
          <div v-for="(d,index) in drafts" :key="d.key" class="panel">
            <div class="d-flex justify-space-between align-center mb-3"><h2 class="section-title mb-0">{{t('Folder pair {n}',{n:index+1})}}</h2><v-btn color="error" variant="text" size="small" prepend-icon="mdi-delete-outline" @click="removePair(d)">{{t('Remove')}}</v-btn></div>
            <v-text-field v-model="d.name" :label="t('Name')" prepend-inner-icon="mdi-tag-outline" hide-details="auto" class="mb-4" style="max-width:360px"></v-text-field>
            <p class="subtle text-caption mb-3">{{t('The working folder is the original you edit. The backup folder becomes an exact copy of it.')}}</p>
            <div class="grid-2"><div><v-text-field v-model="d.sourcePath" :label="t('Working folder')" prepend-inner-icon="mdi-folder-edit-outline" hide-details="auto" @blur="inspect(d,'source').catch(e=>error=String(e))"></v-text-field><v-btn class="mt-2" variant="tonal" size="small" prepend-icon="mdi-folder-search-outline" @click="pick(d,'source')">{{t('Browse for working folder…')}}</v-btn><div v-if="d.sourceInfo" class="subtle text-caption mt-2">{{t('Drive {id} · {free} free',{id:d.sourceInfo.volumeSerial||d.sourceInfo.volumeId,free:size(d.sourceInfo.freeBytes)})}}</div></div><div><v-text-field v-model="d.backupPath" :label="t('Backup folder')" prepend-inner-icon="mdi-folder-check-outline" hide-details="auto" @blur="inspect(d,'backup').catch(e=>error=String(e))"></v-text-field><v-btn class="mt-2" variant="tonal" size="small" prepend-icon="mdi-folder-search-outline" @click="pick(d,'backup')">{{t('Browse for backup folder…')}}</v-btn><div v-if="d.backupInfo" class="subtle text-caption mt-2">{{t('Drive {id} · {free} free',{id:d.backupInfo.volumeSerial||d.backupInfo.volumeId,free:size(d.backupInfo.freeBytes)})}}</div></div></div>
            <div v-if="d.sourceInfo&&d.backupInfo&&d.sourceInfo.volumeId===d.backupInfo.volumeId" class="warning-box mt-3">{{t('Both folders are on the same drive. This backup will not protect against that drive failing.')}}</div>
            <h3 class="section-title mt-5">{{t('History')}}</h3><v-switch v-model="d.keepHistory" color="primary" inset hide-details density="comfortable" :label="d.keepHistory?t('Keep a history of working-folder changes for 7 days'):t('History is off')"></v-switch><p class="subtle text-caption mb-2">{{d.keepHistory?t('Every change to the working folder is saved as a version, even when sync is paused or set to manual.'):t('Changes are NOT recorded and cannot be restored. Existing history stays until it expires.')}}</p>
            <h3 class="section-title mt-5">{{t('When to sync')}}</h3>
            <div class="mode-options"><button class="mode-option" :class="{selected:d.modeKind==='immediate'}" @click="d.modeKind='immediate'"><strong>{{t('Immediate')}}</strong><span>{{t('Back up saved changes as soon as they settle.')}}</span></button><button class="mode-option" :class="{selected:d.modeKind==='scheduled'}" @click="d.modeKind='scheduled'"><strong>{{t('Scheduled')}}</strong><span>{{t('Run at an interval or chosen days and time.')}}</span></button><button class="mode-option" :class="{selected:d.modeKind==='manual'}" @click="d.modeKind='manual'"><strong>{{t('Manual')}}</strong><span>{{t('Only back up when you choose Sync now.')}}</span></button></div>
            <div v-if="d.modeKind==='scheduled'" class="mt-5"><v-btn-toggle v-model="d.scheduleKind" mandatory color="primary" density="comfortable"><v-btn value="interval">{{t('Every interval')}}</v-btn><v-btn value="weekly">{{t('Days & time')}}</v-btn></v-btn-toggle><div v-if="d.scheduleKind==='interval'" class="mt-4" style="max-width:260px"><v-text-field v-model.number="d.minutes" type="number" min="15" max="1440" :label="t('Every N minutes')" :hint="t('120 minutes = every two hours')" persistent-hint></v-text-field></div><div v-else class="mt-4"><v-text-field v-model="d.localTime" type="time" :label="t('Local time')" style="max-width:260px"></v-text-field><div class="toolbar"><v-checkbox v-for="(label,dayIndex) in dayNames" :key="dayIndex" v-model="d.days" :label="t(label)" :value="dayIndex" hide-details density="compact"></v-checkbox></div></div></div>
          </div>
          <div class="panel"><div class="toolbar"><v-btn variant="tonal" prepend-icon="mdi-plus" @click="addPair">{{t('Add folder pair')}}</v-btn><v-btn color="primary" :loading="busy" @click="saveConfig">{{t('Save configuration')}}</v-btn><span class="subtle text-caption">{{t('Windows will ask for administrator approval.')}}</span></div></div>

          <div v-if="config?.pairs.length" class="panel">
            <div class="d-flex justify-space-between align-center flex-wrap ga-2"><h2 class="section-title mb-0">{{t('Analyze and review')}}</h2><v-btn variant="tonal" size="small" :disabled="!selectedId" @click="send(selectedId,'verify')">{{t('Analyze folders')}}</v-btn></div>
            <v-chip-group v-model="selectedId" mandatory class="mt-3"><v-chip v-for="pair in config.pairs" :key="pair.id" :value="pair.id" filter variant="outlined">{{pair.name}}</v-chip></v-chip-group>
            <p class="subtle mt-2 mb-2">{{t('FileSync compares both existing folders before its first backup.')}}</p><ReviewPanel :preview="selectedPreview" :status="selectedStatus" :busy="busy" @send="(name,extra)=>send(selectedId,name,extra)" @open="(which,p)=>openFolder(selectedId,which,p)"></ReviewPanel>
          </div>
        </div>
      </template>

      <template v-if="tab==='service'">
        <div class="eyebrow">{{t('Windows background service')}}</div><h1 class="page-title">{{t('Service')}}</h1><p class="subtle mb-6">{{t('Manage FileSync even when the browser manager is closed. The service can be installed before any folders are configured.')}}</p>
        <div v-if="outdatedService" class="attention-box mb-5" role="alert"><i class="mdi mdi-alert-circle" aria-hidden="true"></i><div><strong>{{t('The background service is an older version')}}</strong><p class="mt-1 mb-2">{{t('The running service was installed from an earlier build, so newer features such as history may not work yet. Use Repair to update it.')}}</p><v-btn color="warning" variant="flat" size="small" :loading="busy" @click="control('repair')">{{t('Repair')}}</v-btn></div></div>
        <div class="grid-2"><div class="panel"><h2 class="section-title">{{t('Service state')}}</h2><div class="list-row"><span>{{t('Installation')}}</span><strong>{{service.installed?t('Installed'):t('Not installed')}}</strong></div><div class="list-row"><span>{{t('Startup')}}</span><strong>{{service.startMode}}</strong></div><div class="list-row"><span>{{t('Windows state')}}</span><strong>{{service.state}}</strong></div><div class="list-row"><span>{{t('Sync health')}}</span><strong>{{stateLabel}}</strong></div><div class="list-row"><span>{{t('Folder pairs')}}</span><strong>{{pairCount}}</strong></div><div class="list-row"><span>{{t('Service process ID')}}</span><strong>{{service.processId||'—'}}</strong></div></div><div class="panel"><h2 class="section-title">{{t('Actions')}}</h2><div class="toolbar"><template v-if="!service.installed"><v-btn color="primary" variant="flat" size="large" prepend-icon="mdi-download" class="action-btn" :loading="busy" @click="control('install')">{{t('Install service')}}</v-btn></template><template v-else><v-btn color="primary" :loading="busy" @click="control('start')">{{t('Start')}}</v-btn><v-btn variant="tonal" :loading="busy" @click="control('stop')">{{t('Stop')}}</v-btn><v-btn variant="tonal" :loading="busy" @click="control('restart')">{{t('Restart')}}</v-btn><v-btn variant="tonal" :loading="busy" @click="control('enable')">{{t('Enable')}}</v-btn><v-btn variant="tonal" :loading="busy" @click="control('disable')">{{t('Disable')}}</v-btn><v-btn variant="tonal" :loading="busy" @click="control('repair')">{{t('Repair')}}</v-btn><v-btn color="error" variant="outlined" :loading="busy" @click="control('uninstall')">{{t('Uninstall service')}}</v-btn></template></div><p class="subtle text-caption mt-4">{{t('These actions request Windows administrator approval. Uninstall preserves your files, settings and seven-day history.')}}</p></div></div>
      </template>

      <template v-if="tab==='history'">
        <div class="eyebrow">{{t('Previous versions')}}</div><h1 class="page-title">{{t('History')}}</h1><p class="subtle mb-6">{{t('Earlier versions of changed or deleted working files stay available for seven days.')}}</p><div class="panel"><div class="d-flex justify-space-between align-center mb-3"><h2 class="section-title mb-0">{{t('Saved changes')}}</h2><v-btn variant="tonal" size="small" @click="refreshTab">{{t('Refresh')}}</v-btn></div><div v-if="!history.length" class="empty">{{t('No older versions have been saved yet.')}}</div><div v-if="history.length" class="toolbar mb-3"><v-checkbox :model-value="selectedItems.length===history.length" :indeterminate="selectedItems.length>0&&selectedItems.length<history.length" :label="t('Select all')" hide-details density="compact" @update:model-value="toggleGroup(history,$event)"></v-checkbox><v-btn color="error" variant="tonal" size="small" prepend-icon="mdi-delete-outline" :disabled="!selectedItems.length" :loading="busy" @click="deleteHistory(selectedItems,t('{n} selected',{n:versions(selectedItems.length)}))">{{t('Delete selected ({n})',{n:selectedItems.length})}}</v-btn></div><div v-for="group in historyGroups" :key="group.key" class="history-group"><div class="history-day d-flex align-center justify-space-between flex-wrap ga-2"><v-checkbox :model-value="groupState(group.items).all" :indeterminate="groupState(group.items).some" hide-details density="compact" :label="group.label+' · '+group.items.length" @update:model-value="toggleGroup(group.items,$event)"></v-checkbox><v-btn color="error" variant="text" size="small" prepend-icon="mdi-delete-sweep-outline" @click="deleteHistory(group.items,t('all {n} from {day}',{n:versions(group.items.length),day:group.label}))">{{t('Delete this day')}}</v-btn></div><div v-for="item in group.items" :key="item.id" class="list-row history-item"><v-checkbox :model-value="isSelected(item)" hide-details density="compact" style="flex:0 0 auto" :aria-label="t('Select {path}',{path:item.path})" @update:model-value="toggleItem(item,$event)"></v-checkbox><div style="flex:1;min-width:0"><strong class="mono">{{item.path}}</strong><div class="subtle text-caption">{{pairName(item.pairId)}} · {{operationLabel(item.operation)}} · {{date(item.createdAt)}} · {{t('Expires {date}',{date:date(item.expiresAt)})}}</div></div><div class="toolbar"><v-btn v-if="item.archivePath" variant="text" size="small" @click="viewItem(item)">{{t('View')}}</v-btn><v-btn v-if="item.archivePath" variant="text" size="small" @click="download(item)">{{t('Export')}}</v-btn><v-btn variant="tonal" size="small" :disabled="!config?.pairs.some(p=>p.id===item.pairId)" @click="restore(item)">{{t('Restore')}}</v-btn><v-btn variant="text" color="error" size="small" icon="mdi-delete-outline" :aria-label="t('Delete {path}',{path:item.path})" @click="deleteHistory([item],t('this version of {path}',{path:item.path}))"></v-btn></div></div></div></div><v-dialog v-model="previewVisible" max-width="750"><v-card><v-card-title class="pa-5">{{previewName}}</v-card-title><v-card-text><pre v-if="previewType==='text'" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:65vh;overflow:auto">{{previewText}}</pre><img v-else-if="previewType==='image'" :src="previewUrl" :alt="t('Archived file preview')" style="max-width:100%;max-height:65vh"><p v-else>{{t('This file type does not have an in-app preview. Use Export to open it in another application.')}}</p></v-card-text><v-card-actions><v-spacer></v-spacer><v-btn @click="previewVisible=false">{{t('Close')}}</v-btn></v-card-actions></v-card></v-dialog>
      </template>

      <template v-if="tab==='logs'">
        <div class="eyebrow">{{t('Activity and errors')}}</div><h1 class="page-title">{{t('Logs')}}</h1><p class="subtle mb-6">{{t('Recent service activity from dated text log files.')}}</p><div class="panel"><div class="grid-2 mb-3"><v-text-field v-model="logQuery" :label="t('Search logs')" prepend-inner-icon="mdi-magnify" hide-details></v-text-field><v-select v-model="logLevel" :items="['All','INFO','WARN','ERROR']" :label="t('Level')" hide-details variant="outlined"></v-select></div><v-btn variant="tonal" size="small" class="mb-3" @click="exportLogs">{{t('Export shown lines')}}</v-btn><div v-if="!filteredLogs.length" class="empty">{{t('No matching log entries.')}}</div><div v-for="(line,index) in filteredLogs" :key="index" class="log-line">{{logLine(line)}}</div></div>
      </template>

      <template v-if="tab==='memory'">
        <div class="eyebrow">{{t('Resource use')}}</div><h1 class="page-title">{{t('Memory')}}</h1><p class="subtle mb-6">{{t('Memory used by the FileSync worker, sampled while the service runs.')}}</p><div v-if="service.state!=='Running'" class="empty">{{t('The service is not running, so live memory use is unavailable.')}}</div><template v-else><div class="grid-2 mb-5"><div class="panel"><div class="metric-label">{{t('Resident memory (RSS)')}}</div><div class="metric">{{size(status?.memory?.rss)}}</div></div><div class="panel"><div class="metric-label">{{t('JavaScript heap used')}}</div><div class="metric">{{size(status?.memory?.heapUsed)}}</div></div></div><div class="panel"><h2 class="section-title">{{t('Past hour')}}</h2><svg class="chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" :aria-label="t('Resident memory history')"><polyline v-if="chartPoints" :points="chartPoints" fill="none" stroke="#0e7c78" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg><div class="subtle text-caption">{{t('{n} samples · Latest {date}',{n:memory.length,date:date(status?.memory?.capturedAt)})}}</div></div></template>
      </template>
    </main>
  </div></v-app>
</template>
