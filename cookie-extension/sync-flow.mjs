import { duplicatePlatforms, entryAction, entryArgs, entryKey, platformName } from './options-model.mjs';

// UI flow state holds only masked previews and single-use confirmation proofs, never Cookie values.
export function createSyncFlow({ call, changed = () => {}, refresh = async () => {} }) {
  let generation=0, state=null, running=false;
  const emit=()=>changed(state);
  const active=version=>version === generation && state;
  const setResult=(entry,patch)=>{
    const key=entryKey(entry), found=state.results.find(result=>entryKey(result.entry) === key);
    if (found) Object.assign(found,patch); else state.results.push({entry,...patch});
  };
  const normalizeError=error=>({code:error.code || '',status:error.status || 0,message:error.message || '操作未完成，请重试。'});
  async function check(entries,version) {
    running=true;
    for (const entry of entries) {
      if (!active(version)) break;
      try {
        const fresh=entry.connection?.identityBound;
        let data;
        try { data=await call(entryAction(entry,fresh ? 'sync' : 'previewSync'),entryArgs(entry)); }
        catch (error) {
          if (!active(version)) break;
          if (!fresh || !['NOT_CONFIRMED','COOKIE_CONFIRMATION_REQUIRED'].includes(error.code)) throw error;
          data=await call(entryAction(entry,'previewSync'),entryArgs(entry));
        }
        if (!active(version)) break;
        if (data?.token) setResult(entry,{status:'confirm',confirmation:data,error:null});
        else if (data?.pending || data?.paused) setResult(entry,{status:'error',error:{code:'BUSY',message:'此平台仍有同步正在处理，请稍后重试。'},confirmation:null});
        else setResult(entry,{status:'synced',confirmation:null,error:null});
      } catch (error) { if (active(version)) setResult(entry,{status:'error',confirmation:null,error:normalizeError(error)}); }
      if (active(version)) emit();
    }
    if (active(version)) { state.phase=state.results.some(result=>result.status === 'confirm') ? 'confirm' : 'result'; running=false; await refresh(); if (active(version)) emit(); }
  }
  async function start(role,entries) {
    if (running) return;
    const duplicates=duplicatePlatforms(entries.map(entry=>({...entry,selected:true})));
    if (duplicates.length) throw new Error(`请先在管理平台中选择${duplicates.map(platformName).join('、')}的唯一账号。`);
    if (!entries.length) throw new Error('请先选择要同步的平台。');
    const canceled=cancel(false),version=generation;
    running=true;
    await canceled;
    if (version !== generation) return;
    state={role,entries:[...entries],results:[],phase:'checking'}; emit();
    await check(entries,version);
  }
  async function confirm() {
    if (!state || running) return;
    const version=generation, pending=state.results.filter(result=>result.status === 'confirm');
    state.phase='syncing'; running=true; emit();
    for (const result of pending) {
      if (!active(version)) break;
      try {
        const data=await call(entryAction(result.entry,'confirmSync'),{...entryArgs(result.entry),confirmation:result.confirmation});
        if (!active(version)) break;
        if (data?.pending) throw Object.assign(new Error('此平台仍在处理中，请稍后重新检查。'),{code:'BUSY'});
        setResult(result.entry,{status:'synced',confirmation:null,error:null});
      } catch (error) { if (active(version)) setResult(result.entry,{status:'error',confirmation:null,error:normalizeError(error)}); }
      if (active(version)) emit();
    }
    if (active(version)) { state.phase='result'; running=false; await refresh(); if (active(version)) emit(); }
  }
  async function retry(entry) {
    if (!state || running || !state.entries.some(item=>entryKey(item) === entryKey(entry))) return;
    state.phase='checking'; emit(); await check([entry],generation);
  }
  async function cancel(notify=true) {
    const old=state; generation++; state=null; running=false;
    if (notify) emit();
    if (old) await Promise.allSettled(old.entries.map(entry=>call(entryAction(entry,'cancelSync'),entryArgs(entry))));
  }
  return {start,confirm,retry,cancel,get state(){return state;},get running(){return running;}};
}
