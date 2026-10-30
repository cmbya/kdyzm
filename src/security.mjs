import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new HttpError(status, code, message); };
export const hash = value => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export const equal = (a, b) => timingSafeEqual(Buffer.from(hash(String(a))), Buffer.from(hash(String(b))));

export function readKey(value) {
  if (!/^[a-f0-9]{64}$/i.test(value || '')) throw new Error('COOKIE_ENCRYPTION_KEY must be 64 hexadecimal characters (32 random bytes)');
  return Buffer.from(value, 'hex');
}
export function encryptCookie(cookie, key, accountId) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(accountId));
  const encrypted = Buffer.concat([cipher.update(cookie, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}
export function decryptCookie(value, key, accountId) {
  const [version, iv, tag, data] = value.split('.');
  if (version !== 'v1') throw new Error('Unsupported credential format');
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  cipher.setAAD(Buffer.from(accountId));
  cipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([cipher.update(Buffer.from(data, 'base64')), cipher.final()]).toString('utf8');
}
export function text(value, name, max = 200, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(400, 'INVALID_INPUT', `${name} 格式不正确`);
  return value.trim();
}
export function onlyKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) fail(400, 'INVALID_INPUT', '请求包含不支持的字段');
}
export function publicUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('PUBLIC_BASE_URL must be an absolute HTTPS URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw new Error('PUBLIC_BASE_URL requires HTTPS (HTTP is allowed only on loopback) and no path or credentials');
  return url.origin;
}

export class RateLimiter {
  constructor(now) { this.now = now; this.entries = new Map(); }
  check(key, limit = 10, window = 60_000) {
    const now = this.now();
    for (const [k, entry] of this.entries) if (entry.until <= now) this.entries.delete(k);
    const entry = this.entries.get(key) || { count: 0, until: now + window };
    if (++entry.count > limit || this.entries.size > 10000) fail(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试');
    this.entries.set(key, entry);
  }
}
