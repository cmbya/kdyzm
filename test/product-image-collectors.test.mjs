import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector } from '../src/collectors.mjs';

const NOW = Date.parse('2026-11-10T10:00:00+08:00');
const response = value => new Response(JSON.stringify(value));
const sources = {
  jd: { host: 'img10.360buyimg.com', fields: ['imageUrl', 'imgUrl'], cookie: 'thor=SYNTHETIC',
    order: (id, items, done) => ({ orderId: id, dateSubmit: NOW, wareList: items.map(item => ({ name: item.title, ...item })),
      statusInfo: { orderStateName: done ? '已完成' : '待发货' } }) },
  pdd: { host: 'img.pddpic.com', fields: ['thumb_url', 'thumbUrl'], cookie: 'pdd_user_id=SYNTHETIC',
    order: (id, items, done) => ({ order_sn: id, order_time: NOW, order_goods: items.map(item => ({ goods_name: item.title, ...item })),
      order_status_text: done ? '交易完成' : '待发货' }) },
  taobao: { host: 'img.alicdn.com', fields: ['pic', 'picUrl', 'imageUrl'], cookie: '_m_h5_tk=SYNTHETIC_1794300000',
    order: (id, items, done) => ({ id, createTime: NOW, subOrders: items.map(item => ({ itemInfo: item })),
      extra: { tradeStatus: done ? 'TRADE_FINISHED' : 'WAIT_SELLER_SEND_GOODS' } }) },
};

async function collect(platform, orders) {
  const calls = [];
  const result = await createCollector({ now: () => NOW, maxPages: 1, fetchImpl: async (url, options) => {
    const target = new URL(url); calls.push(target);
    if (platform === 'jd') {
      assert.equal(target.hostname, 'api.m.jd.com');
      if (target.searchParams.get('functionId') === 'pcdetail_traceMultiPackage') {
        return response({ multiPackageTrackInfoList: [], imageUrl: 'https://img10.360buyimg.com/logistics-only.jpg' });
      }
      assert.equal(target.searchParams.get('functionId'), 'pcorder_center_list');
      return response({ success: true, data: { orderList: orders, totalNum: orders.length } });
    }
    if (platform === 'pdd') {
      assert.equal(target.hostname, 'mobile.yangkeduo.com');
      assert.ok(target.pathname.includes('order_list_v4'));
      return response({ orders: target.searchParams.get('type') === 'unshipping' ? orders : [], has_more: false });
    }
    assert.equal(target.hostname, 'h5api.m.taobao.com');
    return response({ ret: ['SUCCESS::调用成功'], data: options.method === 'POST' ? { data: {} } : { result: JSON.stringify({ mainOrders: orders }) } });
  } })({ platform }, sources[platform].cookie);
  assert.ok(calls.length > 0);
  return result;
}

for (const [platform, source] of Object.entries(sources)) {
  test(`${platform} selects the first valid image from its own goods while retaining the aggregate title`, async () => {
    const field = source.fields[0], image = `https://${source.host}/second.jpg`;
    const result = await collect(platform, [source.order('one', [
      { title: 'Synthetic first', [field]: 'https://untrusted.example/first.jpg' },
      { title: 'Synthetic second', [field]: `http://${source.host}/second.jpg` },
      { title: 'Synthetic third', [field]: `https://${source.host}/third.jpg` },
    ])]);
    assert.equal(result.orders[0].imageUrl, image);
    assert.equal(result.orders[0].title, 'Synthetic first / Synthetic second / Synthetic third');
    assert.ok(result.shipments.every(parcel => !Object.hasOwn(parcel, 'imageUrl')));
  });

  for (const field of source.fields) test(`${platform} accepts only the bounded goods image field ${field}`, async () => {
    const image = `https://${source.host}/field.jpg`;
    const result = await collect(platform, [source.order('one', [{ title: 'Synthetic item', [field]: `//${source.host}/field.jpg` }])]);
    assert.equal(result.orders[0].imageUrl, image);
  });

  test(`${platform} does not borrow root, nested, logistics or another order's image`, async () => {
    const field = source.fields[0], image = `https://${source.host}/other.jpg`;
    const one = source.order('one', [{ title: 'Synthetic without image', [field]: { url: image }, recommendation: { [field]: image } }]);
    Object.assign(one, { imageUrl: image, thumb_url: image, pic: image, recommendations: [{ [field]: image }] });
    const result = await collect(platform, [one, source.order('other', [{ title: 'Synthetic other', [field]: image }])]);
    assert.equal(result.orders.find(order => order.platformOrderId === 'one').imageUrl, '');
    assert.equal(result.orders.find(order => order.platformOrderId === 'other').imageUrl, image);
  });

  test(`${platform} ignores an unknown ended order including its product image`, async () => {
    const image = `https://${source.host}/ended.jpg`;
    const result = await collect(platform, [source.order('ended', [{ title: 'Synthetic ended', [source.fields[0]]: image }], true)]);
    assert.equal(result.orders.length, 0);
    assert.deepEqual(result.orderUpdates, []);
  });
}
