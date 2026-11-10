import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { normalizeProductImageUrl } from '../src/product-image.mjs';

test('product image URLs accept only public platform image origins and upgrade to HTTPS', () => {
  for (const host of ['img.alicdn.com', 'img10.360buyimg.com', 'img.pddpic.com', 'img.yangkeduo.com']) {
    assert.equal(normalizeProductImageUrl(`http://${host}/item.jpg?width=120`), `https://${host}/item.jpg?width=120`);
    assert.equal(normalizeProductImageUrl(`//${host}/item.jpg`), `https://${host}/item.jpg`);
  }
  assert.equal(normalizeProductImageUrl('https://IMG.ALICDN.COM:443/item.jpg#preview'), 'https://img.alicdn.com/item.jpg');
  for (const url of [null, {}, 'data:image/png;base64,AAAA', 'javascript:alert(1)', '/local.jpg',
    'https://127.0.0.1/item.jpg', 'https://img.alicdn.com.evil.test/item.jpg', 'https://evil-alicdn.com/item.jpg',
    'https://user:pass@img.alicdn.com/item.jpg', 'https://img.alicdn.com:444/item.jpg',
    'https://img.alicdn.com\\@evil.test/item.jpg', 'https://img.alicdn.com/\nitem.jpg',
    'https://www.yangkeduo.com/item.jpg', 'https://www.jd.com/item.jpg', 'https://img.alicdn.com/' + 'a'.repeat(2048)]) {
    assert.equal(normalizeProductImageUrl(url), '', String(url));
  }
});

test('store snapshots retain order-specific images through partial collection and authorization', () => {
  const store = new Store({ filename: ':memory:', key: Buffer.alloc(32, 7), now: () => 1794282000000 });
  try {
    store.saveAccount({ platform: 'taobao', label: '图片测试', cookie: 'FIXTURE' }, 'a', true);
    store.saveAccount({ platform: 'taobao', label: '其他账号', cookie: 'FIXTURE' }, 'b', true);
    const image = 'https://img.alicdn.com/item-a.jpg';
    store.importResult('a', { orders: [{ platformOrderId: 'same-id', title: '商品A', imageUrl: image }], shipments: [] });
    store.importResult('b', { orders: [{ platformOrderId: 'same-id', title: '商品B', imageUrl: 'https://img.alicdn.com/item-b.jpg' }], shipments: [] });
    const scoped = () => store.snapshot(['a']).orders;
    assert.equal(scoped().length, 1);
    assert.equal(scoped()[0].imageUrl, image);
    for (const patch of [{}, { imageUrl: '' }, { imageUrl: 'http://localhost/private.jpg' }]) {
      store.importResult('a', { orders: [], orderUpdates: [{ platformOrderId: 'same-id', ...patch }], shipments: [] }, { partial: true });
      assert.equal(scoped()[0].imageUrl, image);
    }
    store.importResult('a', { orders: [{ platformOrderId: 'same-id', imageUrl: '//img.alicdn.com/new.jpg' }], shipments: [] });
    assert.equal(scoped()[0].imageUrl, 'https://img.alicdn.com/new.jpg');
    store.importResult('a', { orders: [], orderUpdates: [{ platformOrderId: 'filtered-out', imageUrl: image }], shipments: [] });
    assert.equal(scoped().length, 1);
    assert.equal(store.order(scoped()[0].id).imageUrl, scoped()[0].imageUrl);
  } finally { store.close(); }
});
