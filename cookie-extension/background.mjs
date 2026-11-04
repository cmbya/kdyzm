import { PLATFORMS, baseOrigin, cookieHeader, platformForDomain, digest, apiRequest, problem, errorText } from './core.mjs';
import { createFamilySync } from './family.mjs';

const KEY = 'connections', PERIODIC = 'cookie-sync-periodic';
const locks = new Set();
let writes = Promise.resolve();
const initialized = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const familySync = createFamilySync(initialized);
async function all() { await initialized; return (await chrome.storage.local.get(KEY))[KEY] || []; }
function mutate(fn) {
  const task = writes.then(async () => { const items = await all(); const result = fn(items); await chrome.storage.local.set({ [KEY]: items }); return result; });
  writes = task.catch(() => {}); return task;
}
function visible(item) {
  const { token, lastDigest, ...safe } = item;
  return safe;
}
async function find(id) { const item = (await all()).find(c => c.id === id); if (!item) throw problem('CONNECTION_MISSING'); return item; }
async function update(id, patch) { return mutate(items => { const item = items.find(c => c.id === id); if (item) Object.assign(item, patch); }); }
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
  await checkPermissions(item);
  const data = await apiRequest(item.baseUrl, '/v1/cookie-sync/current', { token: item.token });
  const account = checkAccount(data.account, item.account.platform), connection = checkConnection(data.connection, account);
  if (data.serviceId !== item.serviceId || account.id !== item.account.id || account.familyId !== item.account.familyId || connection.id !== item.id) throw problem('SERVICE_CHANGED');
  await update(item.id, { account, connection });
  return { account, connection };
}
async function readCookie(item) {
  const profile = PLATFORMS[item.account.platform];
  const cookies = (await Promise.all(profile.urls.map(url => chrome.cookies.getAll({ url, storeId: item.storeId })))).flat();
  return cookieHeader(item.account.platform, cookies, item.storeId);
}
async function finish(item, cookie, version, confirmationToken) {
  // Re-check local consent after every await: removing/pausing must stop queued automatic uploads.
  const live = await find(item.id);
  if (item.automatic && !live.auto) throw problem('AUTO_PAUSED');
  const data = await apiRequest(item.baseUrl, '/v1/cookie-sync/current/cookie', { token: item.token,
    body: { cookie, expectedCredentialVersion: version, ...(confirmationToken ? { confirmationToken } : {}) } });
  const account = checkAccount(data.account, item.account.platform), connection = checkConnection(data.connection, account);
  if (connection.id !== item.id || account.id !== item.account.id) throw problem('SERVICE_CHANGED');
  await update(item.id, { account, connection, lastDigest: await digest(cookie), error: '', checkedAt: Date.now() });
  return { changed: data.changed, account, connection };
}
async function sync(id, automatic = false, confirmation) {
  if (locks.has(id)) return { pending: true };
  locks.add(id);
  try {
    const item = await find(id); item.automatic = automatic;
    if (automatic && !item.auto) return { paused: true };
    const state = await current(item);
    if (!state.connection.identityBound && !confirmation) throw problem('NOT_CONFIRMED');
    const cookie = await readCookie(item), hash = await digest(cookie);
    if (confirmation && hash !== confirmation.digest) throw problem('COOKIE_CHANGED');
    if (automatic && hash === item.lastDigest) { await update(id, { error: '', checkedAt: Date.now() }); return { changed: false }; }
    return await finish(item, cookie, confirmation ? confirmation.version : state.account.credentialVersion, confirmation?.token);
  } catch (error) {
    await update(id, { error: errorText(error), ...(error.status === 401 ? { auto: false } : {}) }); throw error;
  } finally { locks.delete(id); }
}
async function previewSync(id) {
  const item = await find(id);
  await current(item);
  const cookie = await readCookie(item);
  const data = await apiRequest(item.baseUrl, '/v1/cookie-sync/current/preview', { token: item.token, body: { cookie } });
  const account = checkAccount(data.account, item.account.platform);
  if (account.id !== item.account.id || typeof data.confirmationToken !== 'string') throw problem('INVALID_RESPONSE');
  return { token: data.confirmationToken, identityHint: String(data.identityHint || '').slice(0, 100), expiresAt: data.expiresAt,
    version: account.credentialVersion, digest: await digest(cookie), account };
}
async function dispatch(message) {
  if (typeof message?.action === 'string' && message.action.startsWith('family:')) return familySync.dispatch(message);
  switch (message?.action) {
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
      await checkPermissions({ baseUrl, account: { platform } });
      const data = await apiRequest(baseUrl, '/v1/cookie-sync/connections', { body: { code: message.code, name: message.name } });
      const account = checkAccount(data.account, platform), connection = checkConnection(data.connection, account);
      if (data.serviceId !== message.serviceId || account.id !== message.accountId || typeof data.token !== 'string' || !/^csg_[A-Za-z0-9_-]{43}$/.test(data.token)) throw problem('SERVICE_CHANGED');
      const item = { id: connection.id, token: data.token, baseUrl, serviceId: data.serviceId, account, connection, storeId: '0', auto: false, error: '', checkedAt: 0 };
      await mutate(items => { for (let i = items.length - 1; i >= 0; i--) if (items[i].baseUrl === baseUrl && items[i].account.id === account.id) items.splice(i, 1); items.push(item); });
      return visible(item);
    }
    case 'status': return current(await find(message.id));
    case 'previewSync': return previewSync(message.id);
    case 'confirmSync': return sync(message.id, false, message.confirmation);
    case 'sync': return sync(message.id);
    case 'auto': {
      const item = await find(message.id);
      const consent = crypto.randomUUID();
      // A later pause supersedes any enable still waiting for the backend.
      await update(message.id, { auto: false, consent });
      if (message.enabled) { const state = await current(item); if (!state.connection.identityBound) throw problem('NOT_CONFIRMED'); }
      const enabled = await mutate(items => {
        const live = items.find(c => c.id === message.id);
        if (!live || live.consent !== consent) return !!live?.auto;
        live.auto = !!message.enabled; return live.auto;
      });
      if (enabled) await chrome.alarms.create('cookie-sync-change-' + item.account.platform, { delayInMinutes: 0.5 });
      return { enabled };
    }
    case 'remove': {
      const item = await find(message.id); await update(item.id, { auto: false, consent: crypto.randomUUID() });
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
  dispatch(message).then(data => respond({ ok: true, data })).catch(error => respond({ ok: false, message: errorText(error) }));
  return true;
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
async function ensureAlarm() { if (!await chrome.alarms.get(PERIODIC)) await chrome.alarms.create(PERIODIC, { periodInMinutes: 5 }); }
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
void ensureAlarm();
chrome.cookies.onChanged.addListener(({ cookie }) => {
  if (cookie.storeId !== '0' || cookie.partitionKey) return;
  void familySync.onCookie(platformForDomain(cookie.domain)).catch(() => {});
  void (async () => {
    for (const platform of platformForDomain(cookie.domain)) {
      if (!(await all()).some(item => item.auto && item.account.platform === platform)) continue;
      const name = 'cookie-sync-change-' + platform;
      if (!await chrome.alarms.get(name)) await chrome.alarms.create(name, { delayInMinutes: 0.5 });
    }
  })().catch(() => {});
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== PERIODIC && !alarm.name.startsWith('cookie-sync-change-')) return;
  void familySync.onAlarm(alarm.name).catch(() => {});
  void (async () => {
    for (const item of await all()) {
      if (!item.auto || (alarm.name !== PERIODIC && alarm.name !== 'cookie-sync-change-' + item.account.platform)) continue;
      await sync(item.id, true).catch(() => {});
    }
  })().catch(() => {});
});
