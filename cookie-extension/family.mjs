import { PLATFORMS, baseOrigin, readCookieHeader, digest, apiRequest, problem, errorText } from './core.mjs';

const KEY = 'familyConnections', PENDING = 'familyRequest', API = '/v1/cookie-sync/families/';
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function accountValue(value, familyId) {
  if (!value || !safeId(value.id) || value.familyId !== familyId || !PLATFORMS[value.platform]
    || !Number.isSafeInteger(value.credentialVersion)) throw problem('INVALID_RESPONSE');
  return { id: value.id, platform: value.platform, label: String(value.label || '').slice(0, 80), familyId,
    familyName: String(value.familyName || '').slice(0, 80), credentialVersion: value.credentialVersion, status: String(value.status || '') };
}
function connectionValue(value, account) {
  if (value === null) return null;
  if (!value || !safeId(value.id) || value.accountId !== account.id || value.platform !== account.platform
    || !Number.isSafeInteger(value.expiresAt) || typeof value.identityBound !== 'boolean') throw problem('INVALID_RESPONSE');
  return { id: value.id, accountId: account.id, platform: account.platform, expiresAt: value.expiresAt,
    identityBound: value.identityBound, identityHint: String(value.identityHint || '').slice(0, 100), lastSyncAt: Number(value.lastSyncAt) || 0 };
}
function familyValue(value) {
  if (!value || !safeId(value.id)) throw problem('INVALID_RESPONSE');
  return { id: value.id, name: String(value.name || '').slice(0, 80) };
}
function recordsValue(values, family) {
  if (!Array.isArray(values) || values.length > 500) throw problem('INVALID_RESPONSE');
  const records = values.map(value => { const account = accountValue(value.account, family.id); return { account, connection: connectionValue(value.connection, account) }; });
  if (new Set(records.map(record => record.account.id)).size !== records.length) throw problem('INVALID_RESPONSE');
  return records;
}
function groupValue(data) {
  const family = familyValue(data.family), source = data.connection;
  if (!source || !safeId(source.id) || source.familyId !== family.id || !Number.isSafeInteger(source.expiresAt)
    || !/^[a-f0-9]{32}$/.test(data.serviceId)) throw problem('INVALID_RESPONSE');
  const accounts = recordsValue(data.accounts, family);
  for (const [platform, profile] of Object.entries(PLATFORMS)) if (!accounts.some(record => record.account.platform === platform)) {
    accounts.push({ account: { id: 'platform-' + platform, platform, label: profile.name, familyId: family.id, familyName: family.name,
      credentialVersion: 0, status: 'not_configured' }, connection: null, unconfigured: true });
  }
  return { id: source.id, family, connection: { id: source.id, familyId: family.id, name: String(source.name || '').slice(0, 80), expiresAt: source.expiresAt },
    accounts, serviceId: data.serviceId };
}
function mergeRecord(record, previous = {}) {
  const same = previous.connection?.id === record.connection?.id;
  return { ...previous, ...record, selected: same && !!previous.selected, auto: same && !!previous.auto,
    lastDigest: same ? previous.lastDigest || '' : '', error: same ? previous.error || '' : '', checkedAt: previous.checkedAt || 0 };
}
function visible(group) {
  const { token, ...safe } = group;
  return { ...safe, accounts: group.accounts.map(({ lastDigest, ...record }) => record) };
}

export function createFamilySync(initialized) {
  const locks = new Set();
  let writes = Promise.resolve(), polling = false;
  const all = async () => { await initialized; return (await chrome.storage.local.get(KEY))[KEY] || []; };
  function serialized(fn) {
    const pending = writes.then(fn);
    writes = pending.catch(() => {}); return pending;
  }
  function mutate(fn) { return serialized(async () => { const groups = await all(); const result = fn(groups); await chrome.storage.local.set({ [KEY]: groups }); return result; }); }
  const pendingRequest = async () => { await initialized; return (await chrome.storage.local.get(PENDING))[PENDING] || null; };
  const pendingVisible = item => { if (!item || !item.requestId) return null; const { pollToken, nonce, ...safe } = item; return safe; };
  async function group(id) { const found = (await all()).find(item => item.id === id); if (!found) throw problem('CONNECTION_MISSING'); return found; }
  function recordIn(groups, ref) { return groups.find(item => item.id === ref.id)?.accounts.find(item => item.account.id === ref.accountId); }
  async function target(ref) {
    const owner = await group(ref.id), record = owner.accounts.find(item => item.account.id === ref.accountId);
    if (!record || !safeId(ref.accountId)) throw problem('CONNECTION_MISSING');
    return { owner, record };
  }
  const update = (ref, patch) => mutate(groups => { const record = recordIn(groups, ref); if (record) Object.assign(record, patch); });
  const endpoint = (ref, suffix = '', record) => {
    if (!safeId(ref.accountId)) throw problem('BAD_MESSAGE');
    if (record?.unconfigured) return API + 'current/platforms/' + record.account.platform + suffix;
    return API + 'current/accounts/' + ref.accountId + suffix;
  };
  async function permissions(owner, platform) {
    if (!await chrome.permissions.contains({ origins: [owner.baseUrl + '/*', ...(platform ? PLATFORMS[platform].origins : [])] })) throw problem('PERMISSION_REQUIRED');
  }
  async function allowed(ref, consent, automatic = false) {
    const found = await target(ref);
    if (!found.record.selected || found.record.consent !== consent) throw problem('PLATFORM_NOT_SELECTED');
    if (automatic && !found.record.auto) throw problem('AUTO_PAUSED');
    return found;
  }
  function validateTarget(data, owner, record, created = false) {
    const account = accountValue(data.account, owner.family.id), connection = connectionValue(data.connection, account);
    if (data.serviceId !== owner.serviceId || (!created && account.id !== record.account.id) || account.platform !== record.account.platform) throw problem('SERVICE_CHANGED');
    return { account, connection };
  }
  async function current(ref) {
    const { owner, record } = await target(ref); await permissions(owner);
    if (record.unconfigured) {
      const data = groupValue(await apiRequest(owner.baseUrl, API + 'current', { token: owner.token }));
      if (data.id !== owner.id || data.family.id !== owner.family.id || data.serviceId !== owner.serviceId) throw problem('SERVICE_CHANGED');
      if (data.accounts.some(item => !item.unconfigured && item.account.platform === record.account.platform)) {
        await refresh(owner.id); throw problem('COOKIE_CREDENTIAL_CONFLICT');
      }
      return { account: record.account, connection: null };
    }
    const data = await apiRequest(owner.baseUrl, endpoint(ref), { token: owner.token });
    const fresh = validateTarget(data, owner, record);
    await mutate(groups => { const live = recordIn(groups, ref); if (live) Object.assign(live, mergeRecord(fresh, live)); });
    return fresh;
  }
  async function refresh(id) {
    const owner = await group(id); await permissions(owner);
    try {
      const fresh = groupValue(await apiRequest(owner.baseUrl, API + 'current', { token: owner.token }));
      if (fresh.id !== owner.id || fresh.family.id !== owner.family.id || fresh.serviceId !== owner.serviceId) throw problem('SERVICE_CHANGED');
      await mutate(groups => {
        const live = groups.find(item => item.id === id); if (!live) return;
        const accounts = fresh.accounts.map(item => mergeRecord(item, live.accounts.find(old => old.account.id === item.account.id)));
        Object.assign(live, fresh, { accounts, error: '', checkedAt: Date.now() });
      });
      return visible(await group(id));
    } catch (error) {
      await mutate(groups => { const live = groups.find(item => item.id === id); if (live) { live.error = errorText(error); if (error.status === 401) for (const item of live.accounts) item.auto = false; } });
      throw error;
    }
  }
  async function read(ref, consent, automatic) {
    const { owner, record } = await allowed(ref, consent, automatic);
    await permissions(owner, record.account.platform);
    await allowed(ref, consent, automatic);
    try { return await readCookieHeader(record.account.platform, chrome.cookies, '0', () => allowed(ref, consent, automatic)); }
    catch (error) { error.platform = record.account.platform; throw error; }
  }
  async function preview(ref) {
    const { record } = await target(ref), consent = record.consent;
    await allowed(ref, consent); await current(ref);
    const cookie = await read(ref, consent), { owner } = await allowed(ref, consent);
    const data = await apiRequest(owner.baseUrl, endpoint(ref, '/preview', record), { token: owner.token, body: { cookie } });
    const fresh = record.unconfigured ? { account: record.account, connection: null } : validateTarget(data, owner, record);
    if (typeof data.confirmationToken !== 'string' || (!record.unconfigured && !fresh.connection)
      || (record.unconfigured && (data.newAccount !== true || data.platform !== record.account.platform || data.serviceId !== owner.serviceId))) throw problem('INVALID_RESPONSE');
    await allowed(ref, consent);
    await mutate(groups => { const live = recordIn(groups, ref); if (live?.selected && live.consent === consent) Object.assign(live, fresh); });
    return { token: data.confirmationToken, identityHint: String(data.identityHint || '').slice(0, 100), expiresAt: data.expiresAt,
      version: fresh.account.credentialVersion, digest: await digest(cookie), account: fresh.account, connectionId: fresh.connection?.id || null,
      ...(record.unconfigured ? { createPlatform: record.account.platform } : {}), consent };
  }
  async function sync(ref, automatic = false, confirmation) {
    const key = ref.id + '/' + ref.accountId;
    if (locks.has(key)) return { pending: true };
    locks.add(key);
    try {
      const initial = await target(ref), consent = confirmation ? confirmation.consent : initial.record.consent;
      await allowed(ref, consent, automatic);
      const fresh = await current(ref);
      const creating = !!initial.record.unconfigured;
      if (creating ? (!confirmation || confirmation.createPlatform !== initial.record.account.platform)
        : (!fresh.connection || (!fresh.connection.identityBound && !confirmation))) throw problem('NOT_CONFIRMED');
      if (confirmation && (fresh.connection?.id || null) !== confirmation.connectionId) throw problem('PREVIEW_EXPIRED');
      const cookie = await read(ref, consent, automatic), cookieDigest = await digest(cookie);
      if (confirmation && cookieDigest !== confirmation.digest) throw problem('COOKIE_CHANGED');
      const { owner, record } = await allowed(ref, consent, automatic);
      if (automatic && cookieDigest === record.lastDigest) { await update(ref, { error: '', checkedAt: Date.now() }); return { changed: false }; }
      const data = await apiRequest(owner.baseUrl, endpoint(ref, '/cookie', record), { token: owner.token, body: {
        cookie, expectedCredentialVersion: confirmation ? confirmation.version : fresh.account.credentialVersion,
        ...(confirmation ? { confirmationToken: confirmation.token } : {}) } });
      const updated = validateTarget(data, owner, record, creating);
      if (!updated.connection?.identityBound || (!creating && updated.connection.id !== fresh.connection.id)) throw problem('SERVICE_CHANGED');
      await update(ref, { ...updated, unconfigured: false, lastDigest: cookieDigest, error: '', checkedAt: Date.now() });
      return { changed: data.changed };
    } catch (error) { await update(ref, { error: errorText(error), ...(error.status === 401 ? { auto: false } : {}) }); throw error; }
    finally { locks.delete(key); }
  }
  async function dispatch(message) {
    const action = message.action.slice('family:'.length);
    if (action === 'pendingRequest') return pendingVisible(await pendingRequest());
    if (action === 'cancelRequest') { await serialized(() => chrome.storage.local.set({ [PENDING]: null })); return { canceled: true }; }
    if (action === 'openRequest') {
      const pending = await pendingRequest();
      if (!pending?.code || pending.expiresAt <= Date.now()) throw problem('PREVIEW_EXPIRED');
      await chrome.tabs.create({ url: pending.baseUrl + '/#cookie-sync-request=' + encodeURIComponent(pending.code) }); return {};
    }
    if (action === 'startRequest') {
      const baseUrl = baseOrigin(message.baseUrl), platforms = message.platforms;
      if (!Array.isArray(platforms) || !platforms.length || platforms.length > 3 || new Set(platforms).size !== platforms.length || platforms.some(platform => !PLATFORMS[platform])) throw problem('INVALID_PLATFORM');
      const nonce = crypto.randomUUID();
      await serialized(() => chrome.storage.local.set({ [PENDING]: { nonce } }));
      try {
        await permissions({ baseUrl });
        for (const platform of platforms) {
          await permissions({ baseUrl }, platform);
          try { await readCookieHeader(platform, chrome.cookies, '0', async () => {
            if ((await pendingRequest())?.nonce !== nonce) throw problem('REQUEST_CANCELED');
          }); } catch (error) { error.platform = platform; throw error; }
        }
        if ((await pendingRequest())?.nonce !== nonce) throw problem('REQUEST_CANCELED');
        const data = await apiRequest(baseUrl, API + 'requests', { body: { name: message.name, platforms } });
        if (!safeId(data.requestId) || !/^CR-[A-Za-z0-9_-]{43}$/.test(data.code) || !/^cpr_[A-Za-z0-9_-]{43}$/.test(data.pollToken)
          || !Number.isSafeInteger(data.expiresAt)) throw problem('INVALID_RESPONSE');
        return await serialized(async () => {
          if ((await pendingRequest())?.nonce !== nonce) throw problem('REQUEST_CANCELED');
          const pending = { requestId: data.requestId, code: data.code, pollToken: data.pollToken, expiresAt: data.expiresAt, baseUrl, platforms, nonce };
          await chrome.storage.local.set({ [PENDING]: pending }); return pendingVisible(pending);
        });
      } catch (error) {
        await serialized(async () => { if ((await pendingRequest())?.nonce === nonce) await chrome.storage.local.set({ [PENDING]: null }); }); throw error;
      }
    }
    if (action === 'pollRequest') {
      if (polling) return { status: 'pending' };
      polling = true;
      try {
        const pending = await pendingRequest();
        if (!pending?.requestId) throw problem('REQUEST_CANCELED');
        if (pending.expiresAt <= Date.now()) {
          await serialized(async () => { if ((await pendingRequest())?.nonce === pending.nonce) await chrome.storage.local.set({ [PENDING]: null }); });
          throw problem('PREVIEW_EXPIRED');
        }
        const data = await apiRequest(pending.baseUrl, API + 'requests/poll', { body: { requestId: pending.requestId, pollToken: pending.pollToken } });
        if (data.status === 'pending') return { status: 'pending', expiresAt: pending.expiresAt };
        if (data.status !== 'approved' || !/^cfg_[A-Za-z0-9_-]{43}$/.test(data.token)) throw problem('INVALID_RESPONSE');
        const fresh = groupValue(data), item = { ...fresh, token: data.token, baseUrl: pending.baseUrl, error: '', checkedAt: 0,
          accounts: fresh.accounts.map(record => ({ ...mergeRecord(record), selected: pending.platforms.includes(record.account.platform), consent: crypto.randomUUID() })) };
        const accepted = await serialized(async () => {
          if ((await pendingRequest())?.nonce !== pending.nonce) return false;
          const groups = (await all()).filter(group => group.baseUrl !== item.baseUrl || group.family.id !== item.family.id);
          groups.push(item); await chrome.storage.local.set({ [KEY]: groups, [PENDING]: null }); return true;
        });
        if (!accepted) { await apiRequest(item.baseUrl, API + 'current', { token: item.token, method: 'DELETE' }).catch(() => {}); throw problem('REQUEST_CANCELED'); }
        return { status: 'approved', group: visible(item) };
      } finally { polling = false; }
    }
    if (action === 'list') return (await all()).map(visible);
    if (action === 'previewPair') {
      const baseUrl = baseOrigin(message.baseUrl); await permissions({ baseUrl });
      const data = await apiRequest(baseUrl, API + 'pairing/preview', { body: { code: message.code } });
      const family = familyValue(data.family);
      if (!/^[a-f0-9]{32}$/.test(data.serviceId)) throw problem('INVALID_RESPONSE');
      return { family, accounts: recordsValue(data.accounts, family), serviceId: data.serviceId, expiresAt: data.expiresAt, scope: 'family' };
    }
    if (action === 'pair') {
      const baseUrl = baseOrigin(message.baseUrl); await permissions({ baseUrl });
      const data = await apiRequest(baseUrl, API + 'connections', { body: { code: message.code, name: message.name } });
      const fresh = groupValue(data);
      if (fresh.family.id !== message.familyId || fresh.serviceId !== message.serviceId || !/^cfg_[A-Za-z0-9_-]{43}$/.test(data.token)) throw problem('SERVICE_CHANGED');
      const item = { ...fresh, token: data.token, baseUrl, accounts: fresh.accounts.map(record => mergeRecord(record)), error: '', checkedAt: 0 };
      await mutate(groups => { for (let i = groups.length - 1; i >= 0; i--) if (groups[i].baseUrl === baseUrl && groups[i].family.id === fresh.family.id) groups.splice(i, 1); groups.push(item); });
      return visible(item);
    }
    if (action === 'status') return refresh(message.id);
    if (action === 'remove') {
      const owner = await group(message.id);
      await mutate(groups => { const live = groups.find(item => item.id === message.id); if (live) for (const record of live.accounts) Object.assign(record, { auto: false, selected: false, consent: crypto.randomUUID() }); });
      try { await apiRequest(owner.baseUrl, API + 'current', { token: owner.token, method: 'DELETE' }); }
      catch (error) { if (error.status !== 401) throw error; }
      await mutate(groups => { const index = groups.findIndex(item => item.id === message.id); if (index !== -1) groups.splice(index, 1); });
      return { removed: true };
    }
    const ref = { id: message.id, accountId: message.accountId };
    if (action === 'select' || action === 'auto') {
      await target(ref);
      const consent = crypto.randomUUID();
      await update(ref, { auto: false, consent, ...(action === 'select' ? { selected: false } : {}) });
      if (message.enabled) {
        await current(ref);
        const live = await target(ref); await permissions(live.owner, live.record.account.platform);
        if (action === 'auto' && !live.record.connection?.identityBound) throw problem('NOT_CONFIRMED');
      }
      const enabled = await mutate(groups => {
        const live = recordIn(groups, ref);
        const key = action === 'select' ? 'selected' : 'auto';
        if (!live || live.consent !== consent) return !!live?.[key];
        live[key] = !!message.enabled && (action === 'select' || live.selected); return live[key];
      });
      if (enabled && action === 'auto') { const { record } = await target(ref); await chrome.alarms.create('cookie-sync-change-' + record.account.platform, { delayInMinutes: 0.5 }); }
      return { enabled };
    }
    if (action === 'previewSync') return preview(ref);
    if (action === 'confirmSync') return sync(ref, false, message.confirmation);
    if (action === 'sync') return sync(ref);
    if (action === 'login') { const { record } = await target(ref); await chrome.tabs.create({ url: PLATFORMS[record.account.platform].login }); return {}; }
    throw problem('BAD_MESSAGE');
  }
  async function onCookie(platforms) {
    for (const platform of platforms) {
      if (!(await all()).some(group => group.accounts.some(record => record.selected && record.auto && record.account.platform === platform))) continue;
      const name = 'cookie-sync-change-' + platform;
      if (!await chrome.alarms.get(name)) await chrome.alarms.create(name, { delayInMinutes: 0.5 });
    }
  }
  async function onAlarm(name) {
    for (const owner of await all()) {
      try {
        const fresh = await refresh(owner.id);
        for (const record of fresh.accounts) {
          if (!record.selected || !record.auto || (name !== 'cookie-sync-periodic' && name !== 'cookie-sync-change-' + record.account.platform)) continue;
          await sync({ id: owner.id, accountId: record.account.id }, true).catch(() => {});
        }
      } catch { /* Keep other family grants available if one backend is offline or revoked. */ }
    }
  }
  return { dispatch, onCookie, onAlarm };
}
