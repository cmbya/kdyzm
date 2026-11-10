import test from 'node:test';
import assert from 'node:assert/strict';
import { eventStatus } from '../src/collector-enrichment.mjs';
import { createCollector, jdParcels, pddParcels, taobaoParcels } from '../src/collectors.mjs';

const NOW = Date.parse('2026-11-01T12:00:00+08:00');
const response = data => new Response(JSON.stringify(data));
const jdData = description => ({ multiPackageTrackInfoList: [{ carriageInfo: { carriageId: 'SYNTHETIC-A' },
  trackGroupInfo: { orderTrackShowList: [{ CreationTime: '2026-11-01 10:00:00', Content: description }] } }] });
const parse = description => [
  taobaoParcels({ mailNo: 'SYNTHETIC-A', multiStage: [{ title: '物流更新', labelDesc: { text: description } }] }, 'o')[0],
  pddParcels({ order_sn: 'o', tracking_number: 'SYNTHETIC-A', shipping_status_text: description }, {})[0],
  jdParcels(jdData(description), 'o', NOW)[0],
];

test('completed home deliveries without pickup codes use signed status on all platforms without confirming pickup', () => {
  for (const description of ['您的快件已送达', '已妥投', '妥投成功', '您的包裹已放门口，请及时查收',
    '您的快递已送到家门口', '包裹已经放在家门口', '您的快件已投递到门口', '已放门口，请及时取件',
    '已派送到家门口', '已派送至门口', '送达', '妥投']) {
    assert.equal(eventStatus(description), 'signed', description);
    for (const parcel of parse(description)) {
      assert.equal(parcel.status, 'signed', description);
      assert.equal(parcel.pickupCode, '');
      assert.equal(Object.hasOwn(parcel, 'picked'), false);
    }
  }
});

test('plans, failed deliveries and doorstep instructions never count as completed home deliveries', () => {
  for (const description of ['正在派送，预计今日送达', '未送达，等待再次派送', '预计送达家门口',
    '派送失败，未能送达', '请快递员送到门口', '送货上门', '等待妥投', '尚未妥投',
    '未送到家门口', '预计您的快件已送达', '等待包裹已放到门口', '妥投失败',
    '正在派送至家门口', '预计派送到门口']) {
    assert.notEqual(eventStatus(description), 'signed', description);
    for (const parcel of parse(description)) assert.notEqual(parcel.status, 'signed', description);
  }
});

test('delivery to a pickup point without a code remains arrived on all platforms', () => {
  for (const description of ['您的快件已送达菜鸟驿站', '您的快件已到驿站', '您的快件已到快递柜',
    '您的快件已妥投至丰巢快递柜', '已投递到智能柜', '已放到驿站门口', '驿站已签收，请及时取件']) {
    assert.equal(eventStatus(description), 'arrived', description);
    for (const parcel of parse(description)) {
      assert.equal(parcel.status, 'arrived', description);
      assert.equal(parcel.pickupCode, '');
      assert.equal(Object.hasOwn(parcel, 'picked'), false);
    }
  }
});

test('pickup point destinations keep priority when delivery wording includes a doorstep', () => {
  for (const action of ['已送到', '已送至', '已经送到', '已经送至', '已成功送达', '已经成功送达',
    '已经投递到', '已经放在', '已派送到', '已派送至']) {
    for (const destination of ['菜鸟驿站门口', '代收点门口', '丰巢快递柜门口']) {
      const description = `您的快件${action}${destination}`;
      assert.equal(eventStatus(description), 'arrived', description);
      for (const parcel of parse(description)) {
        assert.equal(parcel.status, 'arrived', description);
        assert.equal(parcel.pickupCode, '');
        assert.equal(Object.hasOwn(parcel, 'picked'), false);
      }
    }
  }
});

test('Taobao current home delivery supersedes old pickup evidence and a generic delivery title', () => {
  const parcel = taobaoParcels({ mailNo: 'SYNTHETIC-A', multiStage: [
    { title: '派送中', labelDesc: { text: '您的快件已放在家门口' } },
    { title: '待取件', labelDesc: { text: '已存放至驿站' }, cardDesc: { custom: { expressCode: { code: 'OLD-CODE' } } } },
  ] }, 'o')[0];
  assert.equal(parcel.status, 'signed');
  assert.equal(parcel.pickupCode, 'OLD-CODE');
  assert.equal(Object.hasOwn(parcel, 'picked'), false);
});

test('Taobao full track and PDD shipping events recognize the latest completed home delivery', async () => {
  for (const platform of ['taobao', 'pdd']) {
    const result = await createCollector({ now: () => NOW, fetchImpl: async url => {
      const target = new URL(url);
      if (platform === 'pdd') return response({ shipping: { tracking_number: 'SYNTHETIC-A', traces: [
        { info: '正在派送', time: '2026-10-31 09:00:00' }, { info: '已送到门口', time: '2026-11-01 10:00:00' },
      ] } });
      if (target.hostname === 'pages-g.m.taobao.com') return new Response(`<script>window['__ICE_SUSPENSE_LOADER__']['undefined'] = ${JSON.stringify({ result: { data: { newLogistics: { fields: {} } } } })};</script>`);
      if (target.hostname === 'buyertrade.taobao.com') return new Response(JSON.stringify({ expressId: 'SYNTHETIC-A', address: [
        { place: '正在派送', time: '2026-10-31 09:00:00' }, { place: '已送到门口', time: '2026-11-01 10:00:00' },
      ] }).replace(/[^\x00-\x7f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`));
      return response({ ret: ['SUCCESS'], data: { data: {} } });
    } })({ platform }, platform === 'pdd' ? 'pdd_user_id=SYNTHETIC' : '_m_h5_tk=SYNTHETIC_1793350000', {
      targetOrder: { platformOrderId: 'o', orderStatus: '待收货', orderDate: NOW - 100000,
        orderDateSource: 'platform', shipments: [{ waybillNo: 'SYNTHETIC-A', status: 'transit' }] },
    });
    assert.equal(result.shipments[0].status, 'signed', platform);
    assert.equal(result.shipments[0].logisticsEvents[0].description, '已送到门口', platform);
    assert.equal(Object.hasOwn(result.shipments[0], 'picked'), false);
  }
});

test('JD waybill alone is pending while current arrival and delivery keep priority', () => {
  for (const [description, status] of [['仓库处理中：订单已经打印完成', 'unknown'], ['待取件', 'arrived'], ['已送达', 'signed']]) {
    assert.equal(jdParcels(jdData(description), 'o', NOW)[0].status, status, description);
  }
  const empty = jdData(''); empty.multiPackageTrackInfoList[0].trackGroupInfo.orderTrackShowList = [];
  assert.equal(jdParcels(empty, 'o', NOW)[0].status, 'unknown');
  const missing = jdData('仓库处理中'); missing.multiPackageTrackInfoList[0].carriageInfo.carriageId = '';
  assert.deepEqual(jdParcels(missing, 'o', NOW), []);
});
