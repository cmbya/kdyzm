import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cookieHeader, errorText } from '../cookie-extension/core.mjs';

const fixture = () => `fixture-${randomUUID()}`;
const cookie = (name, value, domain, extra = {}) => ({ name, value, domain, storeId: '0', ...extra });

function failure(platform, cookies, now = Date.now()) {
  try {
    cookieHeader(platform, cookies, '0', now);
    assert.fail('expected cookie validation failure');
  } catch (error) {
    return error;
  }
}

function assertRedacted(error, values, forbiddenFragments = []) {
  const text = errorText(error);
  for (const value of values) assert.doesNotMatch(text, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const fragment of forbiddenFragments) assert.ok(!text.includes(fragment), `diagnostic contains ${fragment}`);
  assert.match(text, /本机读取诊断/);
  return text;
}

test('JD missing thor remains login-required and diagnostics contain no cookie values', () => {
  const pin = fixture(), ptPin = fixture();
  const error = failure('jd', [cookie('pin', pin, '.jd.com'), cookie('pt_pin', ptPin, '.jd.com')]);
  assert.equal(error.code, 'LOGIN_REQUIRED');
  const text = assertRedacted(error, [pin, ptPin], ['.jd.com/path-secret']);
  assert.match(text, /thor：未读取到/);
  const unknownScope = failure('jd', [cookie('pin', pin, '.private-subdomain.jd.com', { path: '/private-token-path' })]);
  assertRedacted(unknownScope, [pin], ['private-subdomain', '/private-token-path']);
});

test('PDD token without identity is missing identity, distinct from a true conflict', () => {
  const token = fixture();
  const missing = failure('pdd', [cookie('PDDAccessToken', token, '.yangkeduo.com')]);
  assert.equal(missing.code, 'IDENTITY_MISSING');
  assertRedacted(missing, [token]);

  const first = fixture(), second = fixture();
  const conflict = failure('pdd', [
    cookie('pdd_user_id', first, '.yangkeduo.com'),
    cookie('pdduid', second, '.yangkeduo.com'),
    cookie('PDDAccessToken', token, '.yangkeduo.com'),
  ]);
  assert.equal(conflict.code, 'IDENTITY_CONFLICT');
  assertRedacted(conflict, [first, second, token]);
});

test('same-name identity cookies across platform scopes still fail closed without values', () => {
  const first = fixture(), second = fixture(), token = fixture();
  const error = failure('pdd', [
    cookie('pdd_user_id', first, '.yangkeduo.com', { path: '/' }),
    cookie('pdd_user_id', second, '.mobile.yangkeduo.com', { path: '/orders.html' }),
    cookie('PDDAccessToken', token, '.yangkeduo.com'),
  ]);
  assert.equal(error.code, 'IDENTITY_CONFLICT');
  const text = assertRedacted(error, [first, second, token]);
  assert.match(text, /pdd_user_id：2种不同值/);
  assert.ok(!text.includes('mobile.yangkeduo.com/orders.html'));
});

test('expired, partitioned and wrong-store cookies do not enter diagnostics', () => {
  const now = 2_000_000;
  const expired = fixture(), partitioned = fixture(), wrongStore = fixture();
  const error = failure('jd', [
    cookie('thor', expired, '.jd.com', { expirationDate: (now - 1) / 1000 }),
    cookie('pin', partitioned, '.jd.com', { partitionKey: { topLevelSite: 'https://jd.com' } }),
    cookie('pt_pin', wrongStore, '.jd.com', { storeId: 'other' }),
    cookie('noise', fixture(), '.unknown.example', { path: '/private-token-path' }),
  ], now);
  assert.equal(error.code, 'LOGIN_REQUIRED');
  const text = assertRedacted(error, [expired, partitioned, wrongStore], ['.unknown.example', '/private-token-path']);
  assert.match(text, /pin：未读取到/);
  assert.match(text, /pt_pin：未读取到/);
  assert.match(text, /thor：未读取到/);
});
