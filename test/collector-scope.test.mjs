import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector } from '../src/collectors.mjs';
import { isActiveKnownOrder } from '../src/collector-enrichment.mjs';

const NOW = Date.parse('2026-11-10T10:00:00+08:00');
const response = value => new Response(JSON.stringify(value));
const ssr = fields => new Response(`<script>window['__ICE_SUSPENSE_LOADER__']['undefined'] = ${JSON.stringify({ result: { data: { newLogistics: { fields } } } })};</script>`);
const sources = {
  jd: { cookie: 'thor=SYNTHETIC', order: (id, done = false) => ({ orderId: id, dateSubmit: NOW,
    statusInfo: { orderStateName: done ? '已完成' : '待收货' },
    wareList: [{ name: 'Synthetic item', imageUrl: 'https://img10.360buyimg.com/synthetic.jpg' }] }) },
  pdd: { cookie: 'pdd_user_id=SYNTHETIC', order: (id, done = false) => ({ order_sn: id, order_time: NOW,
    order_status_text: done ? '交易完成' : '待收货', tracking_number: 'ACTIVE',
    order_goods: [{ goods_name: 'Synthetic item', thumb_url: 'https://img.pddpic.com/synthetic.jpg' }] }) },
  taobao: { cookie: '_m_h5_tk=SYNTHETIC_1794300000', order: (id, done = false) => ({ id, createTime: NOW,
    extra: { tradeStatus: done ? 'TRADE_FINISHED' : 'WAIT_BUYER_CONFIRM_GOODS' },
    subOrders: [{ itemInfo: { title: 'Synthetic item', pic: 'https://img.alicdn.com/synthetic.jpg' } }] }) },
};

function network(platform, list, calls, override) {
  return async (url, options) => {
    const target = new URL(url);
    const detail = platform === 'jd' ? target.searchParams.get('functionId') === 'pcdetail_traceMultiPackage'
      : platform === 'pdd' ? !target.pathname.includes('order_list_v4')
        : target.hostname !== 'h5api.m.taobao.com' || target.pathname.includes('detailv2') && target.searchParams.has('sign');
    calls.push({ target, detail });
    const custom = await override?.(target, options);
    if (custom) return custom;
    if (platform === 'jd') return response(detail ? {
      multiPackageTrackInfoList: [{ carriageInfo: { carriageId: 'ACTIVE', carrier: 'Synthetic carrier' },
        trackGroupInfo: { orderTrackShowList: [{ CreationTime: '2026-11-09 10:00:00', Content: '已签收' }] } }],
    } : { success: true, data: { orderList: list, totalNum: list.length } });
    if (platform === 'pdd') {
      if (!detail) return response({ orders: target.searchParams.get('type') === 'unreceived' ? list : [], has_more: false });
      if (target.pathname.includes('/cabinet/')) return response({ result: {} });
      return response({ shipping: { tracking_number: 'ACTIVE', traces: [{ info: '已签收', time: '2026-11-09 10:00:00' }] } });
    }
    if (target.hostname === 'pages-g.m.taobao.com') return ssr({ mailNo: 'ACTIVE',
      multiStage: [{ title: '已签收', subtitle: '2026-11-09 10:00:00', labelDesc: { text: '已签收' } }] });
    if (target.hostname === 'buyertrade.taobao.com') return response({ expressId: 'ACTIVE', address: [] });
    if (!target.searchParams.has('sign')) return response({ ret: ['FAIL_SYS_TOKEN_EMPTY'] });
    return response({ ret: ['SUCCESS'], data: options.method === 'POST' ? { data: {} } : { result: { mainOrders: list } } });
  };
}

function emptyImport(result) {
  for (const key of ['orders', 'orderUpdates', 'shipments', 'logisticsFailures']) assert.deepEqual(result[key], [], key);
}

test('PDD completion in either active list overrides an unknown order admitted by the other list', async () => {
  for (const endedRange of ['unshipping', 'unreceived']) {
    const result = await createCollector({ now: () => NOW, maxPages: 1, fetchImpl: async url => {
      const target = new URL(url);
      assert.ok(target.pathname.includes('order_list_v4'));
      return response({ orders: [sources.pdd.order('changed', target.searchParams.get('type') === endedRange)], has_more: false });
    } })({ platform: 'pdd' }, sources.pdd.cookie);
    emptyImport(result);
  }
});

const inactiveOrders = [
  ...['archived', 'hidden', 'deleted'].map(flag => ({ [flag]: true, shipments: [{ waybillNo: 'ACTIVE' }] })),
  ...['picked', 'hidden', 'deleted', 'archived'].map(flag => ({ shipments: [{ waybillNo: 'DONE', [flag]: true }] })),
  { shipments: [{ waybillNo: 'PICKED', picked: true }, { waybillNo: 'HIDDEN', hidden: true }] },
];

test('active known order scope follows manual parcel completion and explicit no-waybill states', () => {
  for (const order of [null, undefined, {}, ...inactiveOrders]) assert.equal(isActiveKnownOrder(order), false);
  for (const status of ['transit', 'arrived', 'signed', 'unknown']) {
    assert.equal(isActiveKnownOrder({ orderStatus: '交易完成', shipments: [{ waybillNo: 'ACTIVE', status }] }), true, status);
  }
  assert.equal(isActiveKnownOrder({ shipments: [{ waybillNo: 'DONE', picked: true }, { waybillNo: 'ACTIVE', status: 'signed' }] }), true);
  for (const waybillNo of ['', ' ', '0', '待发货', '暂无', '无', 'WAITING_FOR_CARRIER']) {
    assert.equal(isActiveKnownOrder({ orderStatus: '待发货', shipments: [{ waybillNo }] }), false, waybillNo);
  }
  for (const orderStatus of ['待发货', '等待卖家发货', '待收货', '运输中', '待取件', '等待出库', '正在出库']) {
    assert.equal(isActiveKnownOrder({ orderStatus, shipments: [] }), true, orderStatus);
  }
  for (const tradeStatus of ['WAIT_SELLER_SEND_GOODS', 'WAIT_BUYER_CONFIRM_GOODS']) {
    assert.equal(isActiveKnownOrder({ tradeStatus, shipments: [] }), true, tradeStatus);
  }
  for (const orderStatus of ['', '未知状态', '已完成', '交易完成', '已取消', '待付款', '已签收']) {
    assert.equal(isActiveKnownOrder({ orderStatus, shipments: [] }), false, orderStatus);
  }
});

for (const [platform, source] of Object.entries(sources)) {
  test(`${platform} admits a new station receipt that still explicitly awaits collection`, async () => {
    const order = source.order('station');
    const status = '驿站已签收，请及时取件';
    if (platform === 'jd') order.statusInfo.orderStateName = status;
    else if (platform === 'pdd') order.order_status_text = status;
    else order.statusInfo = { text: status };
    const result = await createCollector({ now: () => NOW, maxPages: 1, fetchImpl: network(platform, [order], []) })({ platform }, source.cookie);
    assert.deepEqual(result.orders.map(item => item.platformOrderId), ['station']);
    assert.ok(result.orders[0].imageUrl);
  });

  test(`${platform} rejects inactive targeted orders before any network or progress output`, async () => {
    for (const inactive of [...inactiveOrders, { shipments: [], orderStatus: '已完成' }]) {
      let requests = 0;
      const progress = [];
      const result = await createCollector({ now: () => NOW, fetchImpl: async () => { requests++; assert.fail('inactive target requested network'); } })(
        { platform }, source.cookie, { targetOrder: { platformOrderId: 'inactive', ...inactive }, onProgress: value => progress.push(value) });
      assert.equal(requests, 0);
      emptyImport(result);
      for (const value of progress) emptyImport(value);
    }
  });

  test(`${platform} omits inactive known list records and unknown ended orders before detail collection`, async () => {
    const listed = inactiveOrders.map((inactive, index) => ({ platformOrderId: `inactive-${index}`, ...inactive }));
    const knownOrders = [...listed, ...inactiveOrders.map((inactive, index) => ({ platformOrderId: `absent-${index}`, ...inactive }))];
    const calls = [];
    const result = await createCollector({ now: () => NOW, maxPages: 1,
      fetchImpl: network(platform, [...listed.map(order => source.order(order.platformOrderId)), source.order('unknown-ended', true)], calls),
    })({ platform }, source.cookie, { knownOrders, trackedOrderIds: knownOrders.map(order => order.platformOrderId) });
    emptyImport(result);
    assert.ok(calls.length > 0);
    assert.equal(calls.filter(call => call.detail).length, 0);
  });

  test(`${platform} refreshes signed unpicked orders after list completion without copying product images`, async () => {
    const calls = [];
    const result = await createCollector({ now: () => NOW, maxPages: 1,
      fetchImpl: network(platform, [source.order('active-ended', true)], calls),
    })({ platform }, source.cookie, { knownOrders: [{ platformOrderId: 'active-ended',
      shipments: [{ waybillNo: 'ACTIVE', status: 'signed', picked: false }] }] });
    assert.deepEqual(result.orders, []);
    assert.ok(result.orderUpdates.some(order => order.platformOrderId === 'active-ended'));
    assert.ok(result.orderUpdates.every(order => !Object.hasOwn(order, 'imageUrl')));
    assert.ok(calls.some(call => call.detail));
    assert.deepEqual(result.shipments.map(parcel => parcel.waybillNo), ['ACTIVE']);
  });

  for (const targeted of [false, true]) test(`${platform} discovers a first waybill for a known pending ${targeted ? 'target' : 'order absent from the list'}`, async () => {
    const calls = [];
    const pending = { platformOrderId: 'pending', orderStatus: '待发货', shipments: [] };
    const result = await createCollector({ now: () => NOW, maxPages: 1, fetchImpl: network(platform, [], calls) })(
      { platform }, source.cookie, targeted ? { targetOrder: pending } : { knownOrders: [pending] });
    assert.deepEqual(result.orders, []);
    assert.ok(calls.some(call => call.detail));
    assert.deepEqual(result.shipments.map(parcel => parcel.waybillNo), ['ACTIVE']);
  });
}

test('Taobao mixed split orders never request completed siblings individually', async () => {
  const calls = [], parcels = [{ waybillNo: 'ACTIVE', status: 'signed' }, { waybillNo: 'PICKED', picked: true }, { waybillNo: 'HIDDEN', hidden: true }];
  const result = await createCollector({ now: () => NOW, maxPages: 1,
    fetchImpl: network('taobao', [], calls, target => {
      if (target.hostname !== 'pages-g.m.taobao.com') return;
      const selected = target.searchParams.get('mailNo');
      if (selected) return ssr({ mailNo: selected, multiStage: [{ title: '运输中', labelDesc: { text: '运输中' } }] });
      return ssr({ multiPackages: { packages: parcels.map(parcel => ({ mailNo: parcel.waybillNo, cpCode: 'ZTO' })) } });
    }),
  })({ platform: 'taobao' }, sources.taobao.cookie, { targetOrder: { platformOrderId: 'split', shipments: parcels } });
  assert.deepEqual(calls.filter(call => call.target.searchParams.has('mailNo')).map(call => call.target.searchParams.get('mailNo')), ['ACTIVE']);
  assert.deepEqual(result.shipments.map(parcel => parcel.waybillNo), ['ACTIVE']);
});

test('PDD split discovery excludes completed sibling tracks while retaining active siblings', async () => {
  const calls = [], parcels = [{ waybillNo: 'ACTIVE', status: 'signed' }, { waybillNo: 'SECOND', status: 'transit' },
    { waybillNo: 'PICKED', picked: true }, { waybillNo: 'HIDDEN', hidden: true }];
  const result = await createCollector({ now: () => NOW, maxPages: 1,
    fetchImpl: network('pdd', [], calls, target => {
      if (target.pathname.endsWith('/order/split/shipping')) return response({ shipping: { order_sn: 'split', tracking_number: 'ACTIVE', traces: [],
        package_info_jump_url: 'https://mobile.yangkeduo.com/goods_express.html?order_sn=split&tracking_number=ACTIVE&shipping_id=main' } });
      if (target.pathname.endsWith('/express/split/pack')) return response({ result: { list: parcels.map(parcel => ({
        order_sn: 'split', tracking_number: parcel.waybillNo, shipping_id: `shipping-${parcel.waybillNo}`,
      })) } });
      if (target.pathname.endsWith('/express/shipping/track')) return response({ shipping: { order_sn: 'split',
        tracking_number: target.searchParams.get('tracking_number'), traces: [{ info: '已发货', time: '2026-11-09 10:00:00' }] } });
    }),
  })({ platform: 'pdd' }, sources.pdd.cookie, { targetOrder: { platformOrderId: 'split', shipments: parcels } });
  assert.ok(calls.some(call => call.target.pathname.endsWith('/express/split/pack')));
  assert.deepEqual(calls.filter(call => call.target.pathname.endsWith('/express/shipping/track'))
    .map(call => call.target.searchParams.get('tracking_number')), ['SECOND']);
  assert.deepEqual(result.shipments.map(parcel => parcel.waybillNo), ['ACTIVE', 'SECOND']);
});

test('JD mixed split detail excludes completed parcels from refreshed output', async () => {
  const calls = [], parcels = [{ waybillNo: 'ACTIVE', status: 'signed' }, { waybillNo: 'PICKED', picked: true }, { waybillNo: 'HIDDEN', hidden: true }];
  const result = await createCollector({ now: () => NOW, fetchImpl: network('jd', [], calls, target => {
    if (target.searchParams.get('functionId') !== 'pcdetail_traceMultiPackage') return;
    return response({ multiPackageTrackInfoList: parcels.map(parcel => ({ carriageInfo: { carriageId: parcel.waybillNo },
      trackGroupInfo: { orderTrackShowList: [{ CreationTime: '2026-11-09 10:00:00', Content: '已签收' }] } })) });
  }) })({ platform: 'jd' }, sources.jd.cookie, { targetOrder: { platformOrderId: 'split', shipments: parcels } });
  assert.equal(calls.length, 1);
  assert.deepEqual(result.shipments.map(parcel => parcel.waybillNo), ['ACTIVE']);
});
