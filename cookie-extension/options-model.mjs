import { PLATFORMS } from './core.mjs';

export const platformOrder = ['taobao', 'jd', 'pdd'];
export const platformName = id => PLATFORMS[id]?.name || '平台';
export const formatDate = value => value ? new Date(value).toLocaleString('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '尚未同步';
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const entryKey = entry => `${entry.family ? 'family' : 'legacy'}/${entry.id}/${entry.accountId || ''}`;
export const entryArgs = entry => ({ id:entry.id, ...(entry.family ? {accountId:entry.accountId} : {}) });
export const entryAction = (entry, action) => `${entry.family ? 'family:' : ''}${action}`;

export function rolesFrom(legacy, groups, baseUrl) {
  const roles=groups.filter(group=>group.baseUrl === baseUrl).map(group=>({
    key:`family/${group.id}`, id:group.id, family:true, name:group.family.name, baseUrl, error:group.error,
    errorCode:group.errorCode, expiresAt:group.connection.expiresAt,
    entries:group.accounts.map(record=>({...record, family:true, id:group.id, accountId:record.account.id, baseUrl}))
  }));
  const byFamily=new Map();
  for (const item of legacy.filter(item=>item.baseUrl === baseUrl)) {
    const key=item.account.familyId || item.id;
    if (!byFamily.has(key)) { const role={key:`legacy/${key}`,family:false,name:item.account.familyName || '平台账号',baseUrl,entries:[]}; byFamily.set(key,role); roles.push(role); }
    byFamily.get(key).entries.push({...item,family:false,selected:item.selected !== false});
  }
  for (const role of roles) role.entries.sort((a,b)=>platformOrder.indexOf(a.account.platform)-platformOrder.indexOf(b.account.platform));
  return roles;
}

export function duplicatePlatforms(entries) {
  return platformOrder.filter(platform=>entries.filter(entry=>entry.selected && entry.account.platform === platform).length > 1);
}
export function errorKind(error = {}) {
  const code=error.code || error.errorCode || '';
  if (['LOGIN_REQUIRED','IDENTITY_MISSING','COOKIE_LOGIN_REQUIRED','COOKIE_IDENTITY_REQUIRED','INVALID_COOKIE'].includes(code)) return 'login';
  if (code === 'PERMISSION_REQUIRED') return 'permission';
  if (['COOKIE_IDENTITY_MISMATCH','IDENTITY_CONFLICT','IDENTITY_INVALID','COOKIE_IDENTITY_AMBIGUOUS','COOKIE_BACKEND_IDENTITY_INVALID'].includes(code)) return 'conflict';
  if (['HTTP_401','COOKIE_SYNC_UNAUTHORIZED','CONNECTION_MISSING','SERVICE_CHANGED'].includes(code) || error.status === 401 || error.errorStatus === 401) return 'authorization';
  if (['NETWORK_ERROR','HTTP_502','HTTP_503','HTTP_504'].includes(code)) return 'network';
  if (['PREVIEW_EXPIRED','COOKIE_CHANGED','NOT_CONFIRMED','COOKIE_CONFIRMATION_REQUIRED','COOKIE_CREDENTIAL_CONFLICT','HTTP_409'].includes(code)) return 'check';
  // Older installations stored only localized safe messages. Keep the next action useful during migration.
  const text=error.error || error.message || '';
  if (/未读到|缺少稳定|登录已失效/.test(text)) return 'login';
  if (/尚未授权|未授权访问/.test(text)) return 'permission';
  if (/账号.*不一致|互相冲突/.test(text)) return 'conflict';
  if (/授权已失效|配对已移除/.test(text)) return 'authorization';
  if (/无法连接后台/.test(text)) return 'network';
  return 'error';
}
export function entryStatus(entry) {
  if (entry.connection?.expiresAt && entry.connection.expiresAt <= Date.now()) return {kind:'authorization',label:'授权已失效',detail:'请重新授权',action:'重新授权'};
  if (entry.error) {
    const kind=errorKind(entry);
    const states={login:['需要登录','去登录'],permission:['需要授权','授予权限'],conflict:['账号不匹配','查看账号'],authorization:['授权已失效','重新授权'],network:['连接失败','重试'],check:['需要重新核对','重新检查'],error:['同步未完成','查看详情']};
    return {kind,label:states[kind][0],detail:entry.error.split('\n')[0],action:states[kind][1]};
  }
  if (entry.account.status === 'expired') return {kind:'login',label:'登录已失效',detail:'后台验证未通过',action:'去登录'};
  if (entry.unconfigured || !entry.connection?.identityBound) return {kind:'new',label:'等待首次核对',detail:'同步时确认账号归属'};
  if (entry.connection.lastSyncAt) {
    if (entry.account.status === 'ok') return {kind:'verified',label:'已同步',detail:'后台最近采集成功'};
    if (entry.account.status === 'error') return {kind:'error',label:'已同步，采集未完成',detail:'请查看后台采集详情',action:'查看详情'};
    return {kind:'pending',label:'已同步',detail:entry.account.status === 'syncing' ? '后台正在采集验证' : '等待后台采集验证'};
  }
  return {kind:'new',label:'尚未同步',detail:'点击同步检查登录状态'};
}

export function selectionChanges(entries, selected, automatic) {
  const chosen=new Set(selected), autos=new Set(automatic);
  const candidate=entries.map(entry=>({...entry,selected:chosen.has(entryKey(entry))}));
  const duplicates=duplicatePlatforms(candidate);
  if (duplicates.length) throw new Error(`同一浏览器每个平台只能选择一个账号，请选择${duplicates.map(platformName).join('、')}的同步目标。`);
  return candidate.map((entry,index)=>({entry:entries[index],selected:entry.selected,auto:entry.selected && autos.has(entryKey(entry))}));
}
