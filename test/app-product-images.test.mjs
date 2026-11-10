import test from 'node:test';
import assert from 'node:assert/strict';
import '../app-source/pickcode/core/load-core.mjs';

const account = { id: 'images', platform: '淘宝', label: '商品图测试' };
function fixture() {
  let state = '';
  const dispatch = (action = 'snapshot', payload = {}) => {
    const result = JSON.parse(globalThis.PickCodeCore.dispatch(state, JSON.stringify({ action, payload })));
    state = JSON.stringify(result.state);
    return result.result;
  };
  dispatch('syncMeta', { bound: true, baseUrl: 'https://fixture.example', deviceId: 'device', accounts: [account] });
  return dispatch;
}
function sync(dispatch, orders, revision, importVersion = 326) {
  return dispatch('syncImport', { importVersion, syncedAt: Date.now(), snapshot: {
    schemaVersion: 1, serverRevision: revision, accounts: [account],
    orders: orders.map(order => ({ accountId: account.id, platform: '淘宝', title: order.id, ...order })),
    shipments: [], hiddenIds: [], deletedIds: []
  } });
}

test('online product pictures reach package cards and remain associated with their order', () => {
  const c = fixture();
  const s = sync(c, [
    { id: 'a', imageUrl: '//img.alicdn.com/a.jpg' },
    { id: 'b', imageUrl: 'http://img10.360buyimg.com/b.jpg' },
    { id: 'c' }
  ], 1);
  assert.deepEqual(Object.fromEntries(s.packages.map(p => [p.title, p.imageUrl])), {
    a: 'https://img.alicdn.com/a.jpg', b: 'https://img10.360buyimg.com/b.jpg', c: ''
  });
  const refreshed = sync(c, [{ id: 'a' }, { id: 'b', imageUrl: 'https://evil.example/b.jpg' }], 2);
  assert.equal(refreshed.packages.find(p => p.title === 'a').imageUrl, 'https://img.alicdn.com/a.jpg');
  assert.equal(refreshed.packages.find(p => p.title === 'b').imageUrl, 'https://img10.360buyimg.com/b.jpg');
  assert.equal(sync(c, [{ id: 'a', imageUrl: 'https://img.pddpic.com/replaced.jpg' }], 3).packages.find(p => p.title === 'a').imageUrl, 'https://img.pddpic.com/replaced.jpg');
});

test('core image validation rejects unsafe snapshot URLs before rendering', () => {
  const bad = ['javascript:alert(1)', 'data:image/svg+xml,example', '/local.jpg',
    'https://img.alicdn.com.evil.test/pic.jpg', 'https://user@img.alicdn.com/pic.jpg',
    'https://img.alicdn.com:80/pic.jpg', 'https://img.alicdn.com\\@evil.test/pic.jpg',
    'https://img.alicdn.com/\npic.jpg', 'https://127.0.0.1/pic.jpg', 'https://www.yangkeduo.com/pic.jpg',
    'https://img.alicdn.com/' + 'a'.repeat(2048)];
  const s = sync(fixture(), bad.map((imageUrl, i) => ({ id: String(i), imageUrl })), 1);
  assert.ok(s.packages.every(p => p.imageUrl === ''));
});

test('upgraded importer fills images even when the server revision has not changed', () => {
  const c = fixture();
  sync(c, [{ id: 'a' }], 1, 325);
  const s = sync(c, [{ id: 'a', imageUrl: 'https://img.alicdn.com/a.jpg' }], 1, 326);
  assert.equal(s.packages[0].imageUrl, 'https://img.alicdn.com/a.jpg');
  assert.equal(s.online.importVersion, 326);
});
