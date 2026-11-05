import { PLATFORMS, baseOrigin, readCookieHeader, platformForDomain, digest, apiRequest, problem, errorText } from './core.mjs';
import { createFamilySync } from './family.mjs';
import { createSettings } from './settings.mjs';

const KEY = 'connections', PERIODIC = 'cookie-sync-periodic';
const locks = new Set();
let writes = Promise.resolve();
let activeOperations = 0, reloading = false;
function operation(work) {
  if (reloading) return Promise.reject(problem('RELOAD_IN_PROGRESS'));
  // Register before the first await so another options page cannot reload while
  // permissions, cookie reads, or an upload are still pending in this worker.
  activeOperations++;
  return Promise.resolve().then(work).finally(() => { activeOperations--; });
}
const initialized = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const familySync = createFamilySync(initialized);
const settings = createSettings(initialized);
async function all() { await initialized; return (await chrome.storage.local.get(KEY))[KEY] || []; }
function mutate(fn) {
  const task = writes.then(async () => { const items = await all(); const result = fn(items); await chrome.storage.local.set({ [KEY]: items }); return result; });
  writes = task.catch(() => {}); return task;
}
function visible(item) {
  const { token, lastDigest, ...safe } = item;
  return { ...safe, selected: item.selected !== false };
}
async function find(id) { const item = (await all()).find(c => c.id === id); if (!item) throw problem('CONNECTION_MISSING'); return item; }
async function update(id, patch) { return mutate(items => { const item = items.find(c => c.id === id); if (item) Object.assign(item, patch); }); }
function errorState(error) {
  return { error: errorText(error), errorCode: /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || '') ? error.code : 'UNKNOWN_ERROR',
    errorStatus: Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : null, errorSource: 'sync' };
}
function sameTarget(live, item) {
  return live && live.token === item.token && live.baseUrl === item.baseUrl && live.serviceId === item.serviceId
    && live.account.id === item.account.id && live.account.platform === item.account.platform && live.account.familyId === item.account.familyId;
}
function updateCurrent(item, patch) {
  return mutate(items => {
    const live = items.find(c => c.id === item.id);
    if (!sameTarget(live, item) || live.consent !== item.consent) return false;
    Object.assign(live, patch); return true;
  });
}
async function allowed(item) {
  const live = await find(item.id);
  if (!sameTarget(live, item)) throw problem('SERVICE_CHANGED');
  if (live.selected === false) throw problem('PLATFORM_NOT_SELECTED');
  if (live.consent !== item.consent) throw problem('REQUEST_CANCELED');
  if (item.automatic && !live.auto) throw problem('AUTO_PAUSED');
  return live;
}
function checkAccount(account, platform) {
  if (!account || typeof account.id !== 'string' || !PLATFORMS[account.platform] || (platform && account.platform !== platform)
    || !Number.isSafeInteger(account.credentialVersion)) throw problem('INVALID_RESPONSE');
  return { id: account.id, platform: account.platform, label: String(account.label || '').slice(0, 80), familyId: String(account.familyId || ''),
    familyName: String(account.familyName || '').slice(0, 80), credentialVersion: account.credentialVersion, status: String(account.status || '') };
}
function checkConnection(connection, account) {
  if (!connection || typeof connection.id !== 'string' || connection.accountId !== account.id || connection.platform !== account.platform
    || !Number.isSafeInteger(connection.expiresAt) || typeof connection.identityBound !== 'boolean') throw problem('INVALID_RESPONSE');
  return { id: connection.id, name: String(connection.name || '').slice(0, 80), expiresAt: connection.expiresAt, identityBound: connection.identityBound,
    identityHint: String(connection.identityHint || '').slice(0, 100), lastSyncAt: Number(connection.lastSyncAt) || 0 };
}
async function checkPermissions(item) {
  if (!await chrome.permissions.contains({ origins: [item.baseUrl + '/*', ...PLATFORMS[item.account.platform].origins] })) throw problem('PERMISSION_REQUIRED');
}
async function current(item) {
  if (!await chrome.permissions.contains({ origins: [item.baseUrl + '/*'] })) throw problem('PERMISSION_REQUIRED');
  const data = await apiRequest(item.baseUrl, '/v1/cookie-sync/current', { token: item.token });
  const account = checkAccount(data.account, item.account.platform), connection = checkConnection(data.connection, account);
  if (data.serviceId !== item.serviceId || account.id !== item.account.id || account.familyId !== item.account.familyId || connection.id !== item.id) throw problem('SERVICE_CHANGED');
  await mutate(items => { const live = items.find(c => c.id === item.id);
    if (sameTarget(live, item)) Object.assign(live, { account, connection },
      live.errorSource === 'status' ? { error: '', errorCode: '', errorStatus: null, errorSource: '' } : {}); });
  return { account, connection };
}
async function readCookie(item) {
  await allowed(item); await checkPermissions(item); await allowed(item);
  try { return await readCookieHeader(item.account.platform, chrome.cookies, item.storeId, () => allowed(item)); }
  catch (error) { error.platform = item.account.platform; throw error; }
}
async function finish(item, cookie, version, confirmationToken) {
  const hash = await digest(cookie);
  await allowed(item);
  const data = await apiRequest(item.baseUrl, '/v1/cookie-sync/current/cookie', { token: item.token,
    body: { cookie, expectedCredentialVersion: version, ...(confirmationToken ? { confirmationToken } : {}) } });
  const account = checkAccount(data.account, item.account.platform), connection = checkConnection(data.connection, account);
  if (data.serviceId !== item.serviceId || connection.id !== item.id || account.id !== item.account.id
    || account.familyId !== item.account.familyId || !connection.identityBound) throw problem('SERVICE_CHANGED');
  await allowed(item);
  await mutate(items => { const live = items.find(c => c.id === item.id);
    if (!sameTarget(live, item) || live.consent !== item.consent || live.selected === false) throw problem('REQUEST_CANCELED');
    Object.assign(live, { account, connection, lastDigest: hash, error: '', errorCode: '', errorStatus: null, checkedAt: Date.now() }); });
  return { changed: data.changed, account, connection };
}
async function sync(id, automatic = false, confirmation) {
  if (locks.has(id)) return { pending: true };
  locks.add(id);
  let item;
  try {
    item = await find(id); item.automatic = automatic;
    if (automatic && !item.auto) return { paused: true };
    if (confirmation && (confirmation.consent !== item.consent || confirmation.connectionId !== item.id)) throw problem('PREVIEW_EXPIRED');
    await allowed(item);
    const state = await current(item);
    await allowed(item);
    if (!state.connection.identityBound && !confirmation) throw problem('NOT_CONFIRMED');
    const cookie = await readCookie(item), hash = await digest(cookie);
    await allowed(item);
    if (confirmation && hash !== confirmation.digest) throw problem('COOKIE_CHANGED');
    if (automatic && hash === item.lastDigest) {
      if (!await updateCurrent(item, { error: '', errorCode: '', errorStatus: null, checkedAt: Date.now() })) throw problem('REQUEST_CANCELED');
      return { changed: false };
    }
    return await finish(item, cookie, confirmation ? confirmation.version : state.account.credentialVersion, confirmation?.token);
  } catch (error) {
    if (item) await updateCurrent(item, { ...errorState(error), ...(error.status === 401 ? { auto: false } : {}) }); throw error;
  } finally { locks.delete(id); }
}
async function previewSync(id) {
  const item = await find(id);
  try {
    await allowed(item);
    await current(item);
    const cookie = await readCookie(item);
    await allowed(item);
    const data = await apiRequest(item.baseUrl, '/v1/cookie-sync/current/preview', { token: item.token, body: { cookie } });
    const account = checkAccount(data.account, item.account.platform);
    if (account.id !== item.account.id || account.familyId !== item.account.familyId
      || typeof data.confirmationToken !== 'string') throw problem('INVALID_RESPONSE');
    const hash = await digest(cookie); await allowed(item);
    if (!await updateCurrent(item, { error: '', errorCode: '', errorStatus: null, checkedAt: Date.now() })) throw problem('REQUEST_CANCELED');
    return { token: data.confirmationToken, identityHint: String(data.identityHint || '').slice(0, 100), expiresAt: data.expiresAt,
      version: account.credentialVersion, digest: hash, account, consent: item.consent, connectionId: item.id };
  } catch (error) {
    await updateCurrent(item, { ...errorState(error), ...(error.status === 401 ? { auto: false } : {}) }); throw error;
  }
}
async function dispatch(message) {
  if (typeof message?.action === 'string' && message.action.startsWith('family:')) return familySync.dispatch(message);
  switch (message?.action) {
    case 'settings:get': return settings.get();
    case 'settings:save': return settings.save(message);
    case 'list': return (await all()).map(visible);
    case 'previewPair': {
      const baseUrl = baseOrigin(message.baseUrl);
      if (!await chrome.permissions.contains({ origins: [baseUrl + '/*'] })) throw problem('PERMISSION_REQUIRED');
      const data = await apiRequest(baseUrl, '/v1/cookie-sync/pairing/preview', { body: { code: message.code } });
      if (!/^[a-f0-9]{32}$/.test(data.serviceId)) throw problem('INVALID_RESPONSE');
      return { account: checkAccount(data.account), serviceId: data.serviceId, expiresAt: data.expiresAt };
    }
    case 'pair': {
      const baseUrl = baseOrigin(message.baseUrl), platform = message.platform;
      if (!PLATFORMS[platform]) throw problem('INVALID_PLATFORM');
      if (!await chrome.permissions.contains({ origins: [baseUrl + '/*'] })) throw problem('PERMISSION_REQUIRED');
      const data = await apiRequest(baseUrl, '/v1/cookie-sync/connections', { body: { code: message.code, name: message.name } });
      const account = checkAccount(data.account, platform), connection = checkConnection(data.connection, account);
      if (data.serviceId !== message.serviceId || account.id !== message.accountId || typeof data.token !== 'string' || !/^csg_[A-Za-z0-9_-]{43}$/.test(data.token)) throw problem('SERVICE_CHANGED');
      const item = { id: connection.id, token: data.token, baseUrl, serviceId: data.serviceId, account, connection, storeId: '0', selected: false,
        consent: crypto.randomUUID(), auto: false, error: '', checkedAt: 0 };
      await mutate(items => { for (let i = items.length - 1; i >= 0; i--) if (items[i].baseUrl === baseUrl && items[i].account.id === account.id) items.splice(i, 1); items.push(item); });
      return visible(item);
    }
    case 'status': {
      const item = await find(message.id);
      try { return await current(item); }
      catch (error) {
        await updateCurrent(item, { ...errorState(error), errorSource: 'status', ...(error.status === 401 ? { auto: false } : {}) }); throw error;
      }
    }
    case 'previewSync': return previewSync(message.id);
    case 'confirmSync': return sync(message.id, false, message.confirmation);
    case 'sync': return sync(message.id);
    case 'cancelSync': {
      await find(message.id); await update(message.id, { consent: crypto.randomUUID() }); return { canceled: true };
    }
    case 'select':
    case 'auto': {
      const item = await find(message.id);
      const selecting = message.action === 'select', key = selecting ? 'selected' : 'auto';
      const consent = crypto.randomUUID();
      // A later pause supersedes any enable still waiting for the backend.
      await update(message.id, { auto: false, consent, ...(selecting ? { selected: false } : {}) });
      if (message.enabled) {
        if (!selecting && item.selected === false) throw problem('PLATFORM_NOT_SELECTED');
        const state = await current(item); await checkPermissions(item);
        if (!selecting && !state.connection.identityBound) throw problem('NOT_CONFIRMED');
      }
      const enabled = await mutate(items => {
        const live = items.find(c => c.id === message.id);
        if (!sameTarget(live, item) || live.consent !== consent) return selecting ? live?.selected !== false && !!live : !!live?.auto;
        live[key] = !!message.enabled && (selecting || live.selected !== false); return live[key];
      });
      if (enabled && !selecting) await chrome.alarms.create('cookie-sync-change-' + item.account.platform, { delayInMinutes: 0.5 });
      return { enabled };
    }
    case 'remove': {
      const item = await find(message.id); await update(item.id, { auto: false, selected: false, consent: crypto.randomUUID() });
      try { await apiRequest(item.baseUrl, '/v1/cookie-sync/current', { token: item.token, method: 'DELETE' }); }
      catch (error) { if (error.status !== 401) throw error; }
      await mutate(items => { const i = items.findIndex(c => c.id === item.id); if (i >= 0) items.splice(i, 1); });
      return { removed: true };
    }
    case 'login': { const item = await find(message.id); await chrome.tabs.create({ url: PLATFORMS[item.account.platform].login }); return {}; }
    default: throw problem('BAD_MESSAGE');
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('options.html')) return false;
  const failed = error => respond({ ok: false, message: errorText(error),
    code: /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || '') ? error.code : 'UNKNOWN_ERROR',
    status: Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : null,
    ...(PLATFORMS[error?.platform] ? { platform: error.platform } : {}) });
  if (message?.action === 'runtime:reload') {
    if (reloading || activeOperations) failed(problem(reloading ? 'RELOAD_IN_PROGRESS' : 'SYNC_IN_PROGRESS'));
    else {
      reloading = true;
      respond({ ok: true, data: { reloading: true } });
      chrome.runtime.reload();
    }
    return false;
  }
  operation(() => dispatch(message)).then(data => respond({ ok: true, data })).catch(failed);
  return true;
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
async function ensureAlarm() { if (!await chrome.alarms.get(PERIODIC)) await chrome.alarms.create(PERIODIC, { periodInMinutes: 5 }); }
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
void ensureAlarm();
chrome.cookies.onChanged.addListener(({ cookie }) => {
  if (cookie.storeId !== '0' || cookie.partitionKey) return;
  void operation(async () => {
    await familySync.onCookie(platformForDomain(cookie.domain));
    for (const platform of platformForDomain(cookie.domain)) {
      if (!(await all()).some(item => item.selected !== false && item.auto && item.account.platform === platform)) continue;
      const name = 'cookie-sync-change-' + platform;
      if (!await chrome.alarms.get(name)) await chrome.alarms.create(name, { delayInMinutes: 0.5 });
    }
  }).catch(() => {});
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== PERIODIC && !alarm.name.startsWith('cookie-sync-change-')) return;
  void operation(async () => {
    await familySync.onAlarm(alarm.name);
    for (const item of await all()) {
      if (item.selected === false || !item.auto || (alarm.name !== PERIODIC && alarm.name !== 'cookie-sync-change-' + item.account.platform)) continue;
      await sync(item.id, true).catch(() => {});
    }
  }).catch(() => {});
});
