export const PLATFORMS = {
  taobao: { name: '淘宝', origins: ['https://*.taobao.com/*'], domains: ['taobao.com'],
    urls: ['https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm', 'https://h5api.m.taobao.com/h5/'],
    login: 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm', identity: ['unb'], required: ['unb', 'cookie2'] },
  pdd: { name: '拼多多', origins: ['https://*.yangkeduo.com/*'], domains: ['yangkeduo.com'],
    urls: ['https://mobile.yangkeduo.com/proxy/api/api/aristotle/order_list_v4'],
    login: 'https://mobile.yangkeduo.com/orders.html', identity: ['pdd_user_id', 'pdduid'], required: ['PDDAccessToken'] },
  jd: { name: '京东', origins: ['https://*.jd.com/*'], domains: ['jd.com'],
    urls: ['https://api.m.jd.com/api', 'https://order.jd.com/center/list.action'],
    login: 'https://order.jd.com/center/list.action', identity: ['pin', 'pt_pin'], required: [], loginAny: ['thor', 'light_key'] }
};

export function problem(code) { return Object.assign(new Error(code), { code }); }
export function baseOrigin(input) {
  if (typeof input !== 'string' || !input.trim() || /[\\\s]/u.test(input.trim())) throw problem('INVALID_BASE_URL');
  let url;
  try { url = new URL(input.trim()); } catch { throw problem('INVALID_BASE_URL'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.port === '0'
    || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) throw problem('INVALID_BASE_URL');
  return url.origin;
}
export function pairingInput(input, address = '') {
  let code = input.trim(), baseUrl = address, kind;
  if (code.startsWith('{')) {
    let parsed;
    try { parsed = JSON.parse(code); } catch { throw problem('INVALID_PAIRING'); }
    if (!['cookie-sync', 'cookie-sync-family'].includes(parsed.kind) || parsed.schemaVersion !== 1) throw problem('INVALID_PAIRING');
    baseUrl = parsed.baseUrl; code = parsed.code; kind = parsed.kind;
  }
  if (typeof code !== 'string' || !/^C[SF]-[A-Za-z0-9_-]{43}$/.test(code)) throw problem('INVALID_PAIRING');
  const family = code.startsWith('CF-');
  if (kind && kind !== (family ? 'cookie-sync-family' : 'cookie-sync')) throw problem('INVALID_PAIRING');
  return { baseUrl: baseOrigin(baseUrl), code, ...(family ? { scope: 'family' } : {}) };
}
export function platformForDomain(domain) {
  const host = domain.replace(/^\./, '').toLowerCase();
  return Object.keys(PLATFORMS).filter(key => PLATFORMS[key].domains.some(d => host === d || host.endsWith('.' + d)));
}
export function cookieHeader(platform, cookies, storeId = '0', now = Date.now()) {
  try { return validatedCookieHeader(platform, cookies, storeId, now); }
  catch (error) {
    if (PLATFORMS[platform]) error.cookieDiagnostic = cookieDiagnostic(platform, cookies, storeId, now);
    throw error;
  }
}
function matchesRequest(cookie, address) {
  const url = new URL(address), domain = cookie.domain.replace(/^\./, '').toLowerCase();
  const path = cookie.path || '/';
  return (url.hostname === domain || (!cookie.hostOnly && url.hostname.endsWith('.' + domain)))
    && (url.pathname === path || (url.pathname.startsWith(path) && (path.endsWith('/') || url.pathname[path.length] === '/')));
}
export async function readCookieHeader(platform, cookieApi, storeId = '0', beforeFallback) {
  const profile = PLATFORMS[platform];
  if (!profile) throw problem('INVALID_PLATFORM');
  const cookies = (await Promise.all(profile.urls.map(url => cookieApi.getAll({ url, storeId })))).flat();
  try { return cookieHeader(platform, cookies, storeId); }
  catch (error) {
    if (!['LOGIN_REQUIRED', 'IDENTITY_MISSING'].includes(error.code)) throw error;
    await beforeFallback?.();
    // Recheck only authorized platform domains; keep the original request host/path boundary.
    const fallback = (await Promise.all(profile.domains.map(domain => cookieApi.getAll({ domain, storeId })))).flat();
    try { return cookieHeader(platform, [...cookies, ...fallback.filter(cookie => profile.urls.some(url => matchesRequest(cookie, url)))], storeId); }
    catch (error) {
      error.cookieDiagnostic = cookieDiagnostic(platform, [...cookies, ...fallback], storeId, Date.now(), true);
      throw error;
    }
  }
}
function cookieDiagnostic(platform, cookies, storeId, now, checkScope = false) {
  const profile = PLATFORMS[platform];
  const hosts = new Set([...profile.domains, ...profile.urls.map(url => new URL(url).hostname)]);
  const paths = new Set(['/', ...profile.urls.map(url => new URL(url).pathname)]);
  return [...new Set([...profile.required, ...(profile.loginAny || []), ...profile.identity])].map(name => {
    const found = cookies.filter(cookie => cookie.name === name && cookie.storeId === storeId
      && !cookie.partitionKey && !(cookie.expirationDate && cookie.expirationDate * 1000 <= now)
      && platformForDomain(cookie.domain).includes(platform) && cookie.value
      && (!checkScope || profile.urls.some(url => matchesRequest(cookie, url))));
    if (!found.length) {
      const returned = cookies.filter(cookie => cookie.name === name && platformForDomain(cookie.domain).includes(platform));
      const reasons = new Set(returned.flatMap(cookie => [
        cookie.storeId !== storeId && '其他Cookie存储区', cookie.partitionKey && '分区Cookie',
        cookie.expirationDate && cookie.expirationDate * 1000 <= now && '已过期', !cookie.value && '空值',
        checkScope && !profile.urls.some(url => matchesRequest(cookie, url)) && '请求域名或路径不匹配'
      ].filter(Boolean)));
      return `${name}：未读取到（${reasons.size ? '已过滤：' + [...reasons].join('、') : '浏览器未返回该字段'}）`;
    }
    const scopes = [...new Set(found.map(cookie => {
      const domain = hosts.has(cookie.domain.replace(/^\./, '')) ? cookie.domain : '[平台子域]';
      const path = paths.has(cookie.path || '/') ? cookie.path || '/' : '[其他路径]';
      return domain + path;
    }))];
    const variants = new Set(found.map(cookie => cookie.value)).size;
    return `${name}：${variants > 1 ? `${variants}种不同值` : '已读取'}（${scopes.slice(0, 4).join('、')}${scopes.length > 4 ? '等' : ''}）`;
  }).join('；');
}
function validatedCookieHeader(platform, cookies, storeId, now) {
  const profile = PLATFORMS[platform];
  if (!profile) throw problem('INVALID_PLATFORM');
  const values = new Map();
  const guarded = new Set([...profile.identity, ...profile.required, ...(profile.loginAny || [])]);
  // Input comes from getAll(url), so Chrome has already applied domain/path rules.
  for (const cookie of cookies) {
    if (cookie.storeId !== storeId || cookie.partitionKey || (cookie.expirationDate && cookie.expirationDate * 1000 <= now)) continue;
    if (!platformForDomain(cookie.domain).includes(platform)) continue;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name) || /[;\r\n\x00-\x1f\x7f]/.test(cookie.value)) throw problem('INVALID_COOKIE');
    if (!cookie.value) continue;
    if (values.has(cookie.name) && values.get(cookie.name) !== cookie.value && guarded.has(cookie.name)) throw problem('IDENTITY_CONFLICT');
    if (!values.has(cookie.name)) values.set(cookie.name, cookie.value);
  }
  for (const name of profile.required) if (!values.get(name)) throw problem('LOGIN_REQUIRED');
  if (profile.loginAny && !profile.loginAny.some(name => values.get(name) && !/\s/.test(values.get(name)))) throw problem('LOGIN_REQUIRED');
  const identities = profile.identity.map(name => values.get(name)).filter(Boolean).map(value => {
    try { return platform === 'jd' ? decodeURIComponent(value) : value; } catch { throw problem('IDENTITY_INVALID'); }
  });
  if (!identities.length) throw problem('IDENTITY_MISSING');
  if (identities.some(value => !value || value.length > 256 || /[\s\x00-\x1f\x7f;=]/u.test(value))) throw problem('IDENTITY_INVALID');
  if (identities.some(value => value !== identities[0])) throw problem('IDENTITY_CONFLICT');
  const header = [...values].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, value]) => `${key}=${value}`).join('; ');
  if (header.length > 16384) throw problem('COOKIE_TOO_LARGE');
  return header;
}
export async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('');
}
const errors = {
  INVALID_BASE_URL: '请输入完整 HTTPS 后台地址，不要包含路径、账号或密码。', INVALID_PAIRING: '请复制后台生成的插件配对信息或有效配对码。',
  INVALID_PLATFORM: '此平台暂不支持。', PERMISSION_REQUIRED: '尚未授权访问后台或平台，请点击授权后重试。',
  LOGIN_REQUIRED: '未读到当前采集方式要求的登录字段。网页已登录时，请查看下方诊断。',
  IDENTITY_MISSING: '未读到平台账号标识；这不表示混用了账号。网页已登录时，当前登录形式可能尚未适配。',
  IDENTITY_INVALID: '平台账号标识格式异常，已停止同步。',
  IDENTITY_CONFLICT: '读取到互相冲突的账号或登录字段，已停止同步，请查看下方诊断。',
  INVALID_COOKIE: '网页登录信息格式异常，请重新登录。', COOKIE_TOO_LARGE: '网页登录信息超过后台大小限制。',
  COOKIE_CHANGED: '登录信息在核对期间已变化，请重新读取后确认。', PREVIEW_EXPIRED: '核对已过期，请重新读取登录信息。',
  CONNECTION_MISSING: '此配对已移除，请重新配对。', SERVICE_CHANGED: '后台身份或目标账号已变化，请检查地址并重新配对。',
  NETWORK_ERROR: '无法连接后台，请检查网络、地址和 HTTPS 证书后重试。', INVALID_RESPONSE: '后台响应不兼容，请先更新配套后台。',
  HTTP_404: '后台尚未支持插件同步，请先更新配套后台。', HTTP_401: '授权已失效，请在后台重新生成插件配对码。',
  HTTP_403: '此同步操作未获授权，请检查配对和账号归属。', HTTP_409: '账号或登录信息已变化，请刷新状态后重新核对。',
  HTTP_429: '同步过于频繁，稍后会自动重试。', NOT_CONFIRMED: '请先读取登录信息并确认首次同步。',
  AUTO_PAUSED: '自动同步已暂停。', PLATFORM_NOT_SELECTED: '此平台未选择同步，请先勾选并授权。', REQUEST_CANCELED: '本次授权已取消，请重新发起。', BAD_MESSAGE: '不支持的插件操作。'
};
Object.assign(errors, {
  COOKIE_PAIRING_INVALID: '配对码无效、已使用或已过期，请在后台重新生成。',
  COOKIE_REQUEST_INVALID: '授权请求已过期或已使用，请从插件重新发起。',
  COOKIE_REQUEST_APPROVED: '此请求已经授权，请返回插件继续同步。',
  COOKIE_PLATFORM_EXISTS: '后台已存在此平台账号，请刷新角色后选择对应账号同步。',
  COOKIE_SYNC_UNAUTHORIZED: errors.HTTP_401,
  COOKIE_IDENTITY_REQUIRED: '缺少稳定的平台账号标识，请打开网页版订单页重新登录。',
  COOKIE_IDENTITY_AMBIGUOUS: errors.IDENTITY_CONFLICT, COOKIE_LOGIN_REQUIRED: errors.LOGIN_REQUIRED,
  COOKIE_IDENTITY_MISMATCH: '浏览器登录的账号与后台授权账号不一致，已停止上传。请切回对应账号。',
  COOKIE_BACKEND_IDENTITY_INVALID: '后台原登录信息的账号标识异常，请管理员核对后重新配对。',
  COOKIE_CONFIRMATION_REQUIRED: '首次核对已过期或登录信息变化，请重新读取后确认。',
  COOKIE_CREDENTIAL_CONFLICT: '后台登录信息已被更新，本次未覆盖，请重新同步。'
});
export function errorText(error) {
  return (PLATFORMS[error?.platform] ? PLATFORMS[error.platform].name + '：' : '')
    + (errors[error?.code] || errors[`HTTP_${error?.status}`] || '操作未完成，请刷新状态后重试。')
    + (error?.cookieDiagnostic ? `\n本机读取诊断（不含Cookie值）：${error.cookieDiagnostic}` : '');
}

export async function apiRequest(baseUrl, path, { token, body, method = body === undefined ? 'GET' : 'POST', fetchImpl = fetch } = {}) {
  if (!/^\/v1\/cookie-sync\/(?:pairing\/preview|connections|current(?:\/preview|\/cookie)?|families\/(?:pairing\/preview|connections|requests(?:\/poll)?|current(?:\/accounts\/[A-Za-z0-9_-]{1,128}(?:\/preview|\/cookie)?|\/platforms\/(?:taobao|pdd|jd)\/(?:preview|cookie))?))$/.test(path)) throw problem('BAD_MESSAGE');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetchImpl(baseOrigin(baseUrl) + path, { method, signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    let length = 0, raw = '';
    const reader = response.body?.getReader(), decoder = new TextDecoder();
    if (!reader) throw problem('INVALID_RESPONSE');
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.length; if (length > 65536) throw problem('INVALID_RESPONSE');
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
    let data;
    try { data = JSON.parse(raw); } catch { throw problem('INVALID_RESPONSE'); }
    if (!response.ok) throw Object.assign(problem(Object.hasOwn(errors, data?.error?.code) ? data.error.code : `HTTP_${response.status}`), { status: response.status });
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw problem('INVALID_RESPONSE');
    return data;
  } catch (error) { if (error.code) throw error; throw problem('NETWORK_ERROR'); }
  finally { clearTimeout(timer); }
}
