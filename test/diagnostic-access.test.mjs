import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { DiagnosticAccess } from '../src/diagnostic-access.mjs';
import { hash, HttpError, secret } from '../src/security.mjs';

const NOW = Date.parse('2026-11-10T15:00:00+08:00');
const KEY = Buffer.alloc(32, 7);
function fixture(t) {
  const store = new Store({ key: KEY, now: () => NOW });
  t.after(() => store.close());
  return { store, access: new DiagnosticAccess({ store, now: () => NOW }) };
}

test('diagnostic credentials expose a token once and persist only its hash', t => {
  const { store, access } = fixture(t);
  const { token, credential } = access.create({ name: '  自动诊断  ' });
  assert.match(token, /^pcdiag_[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(token.slice(7), 'base64url').length, 32);
  assert.deepEqual(credential, { id: credential.id, name: '自动诊断', createdAt: NOW, revokedAt: null });
  assert.deepEqual(access.list(), [credential]);
  assert.deepEqual(access.authenticate(token), credential);
  const saved = store.db.prepare('SELECT * FROM diagnostic_credentials').get();
  assert.equal(saved.token_hash, hash(token));
  assert.equal(JSON.stringify(saved).includes(token), false);
  assert.deepEqual(Object.keys(access.authenticate(token)).sort(), ['createdAt', 'id', 'name', 'revokedAt']);
  assert.equal(access.list().some(row => 'token' in row || 'token_hash' in row), false);
});

test('diagnostic access survives restart without an expiry and revocation survives restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'diagnostic-access-'));
  const filename = join(directory, 'cache.sqlite');
  let store = new Store({ filename, key: KEY, now: () => NOW });
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); });
  let access = new DiagnosticAccess({ store, now: () => NOW });
  const { token, credential } = access.create({ name: '持久诊断' });
  store.close(); store = null;
  assert.equal(readFileSync(filename).includes(Buffer.from(token)), false);
  const later = NOW + 365 * 86400000;
  store = new Store({ filename, key: KEY, now: () => later });
  access = new DiagnosticAccess({ store, now: () => later });
  assert.deepEqual(access.authenticate(token), credential);
  assert.deepEqual(access.revoke(credential.id), { revoked: true });
  assert.equal(access.authenticate(token), null);
  const revoked = access.list()[0];
  assert.equal(revoked.revokedAt, later);
  access.now = () => later + 1000;
  assert.deepEqual(access.revoke(credential.id), { revoked: true });
  assert.deepEqual(access.revoke('unknown-id'), { revoked: true });
  assert.deepEqual(access.list(), [revoked]);
  store.close(); store = new Store({ filename, key: KEY });
  access = new DiagnosticAccess({ store });
  assert.equal(access.authenticate(token), null);
  assert.deepEqual(access.list(), [revoked]);
});

test('diagnostic authentication rejects malformed, foreign and unknown tokens without database writes', t => {
  const { store, access } = fixture(t);
  const { token, credential } = access.create({ name: '只读验证' });
  const before = store.db.prepare('SELECT total_changes() AS count').get().count;
  for (const invalid of [undefined, null, 1, {}, [], '', 'x'.repeat(100000), token + '\n', token.slice(1),
    `pcdiag_${secret()}`, `pca_${token.slice(7)}`, `pcd_${token.slice(7)}`, `Bearer ${token}`]) {
    assert.equal(access.authenticate(invalid), null);
  }
  assert.deepEqual(access.authenticate(token), credential);
  assert.equal(store.db.prepare('SELECT total_changes() AS count').get().count, before);
});

test('diagnostic inputs are bounded and validation errors do not reflect supplied credentials', t => {
  const { access } = fixture(t);
  const suppliedToken = `pcdiag_${secret()}`;
  for (const body of [undefined, null, [], {}, { name: '' }, { name: '   ' }, { name: 1 },
    { name: 'x'.repeat(81) }, { name: 'a\u0000b' }, { name: 'a\nb' }, { name: '诊断', token: suppliedToken }]) {
    assert.throws(() => access.create(body), error => error instanceof HttpError && error.status === 400
      && error.code === 'INVALID_INPUT' && !String(error.stack).includes(suppliedToken));
  }
  for (const id of [undefined, null, 1, {}, '', 'x'.repeat(81)])
    assert.throws(() => access.revoke(id), { status: 400, code: 'INVALID_INPUT' });
  assert.deepEqual(access.list(), []);
  assert.equal(access.create({ name: 'x'.repeat(80) }).credential.name.length, 80);
});

test('ten active diagnostic credentials are allowed across instances and revocation releases a slot', t => {
  const { store, access } = fixture(t);
  const created = Array.from({ length: 10 }, (_, i) => access.create({ name: `诊断${i}` }));
  assert.equal(new Set(created.map(item => item.token)).size, 10);
  const other = new DiagnosticAccess({ store, now: () => NOW });
  assert.throws(() => other.create({ name: '超限' }), { status: 409, code: 'DIAGNOSTIC_TOKEN_LIMIT' });
  assert.equal(access.list().length, 10);
  other.revoke(created[0].credential.id);
  const replacement = access.create({ name: '替换' });
  assert.equal(other.authenticate(created[0].token), null);
  assert.deepEqual(other.authenticate(replacement.token), replacement.credential);
  assert.equal(other.list().filter(row => row.revokedAt === null).length, 10);
});
