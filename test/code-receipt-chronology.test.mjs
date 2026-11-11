import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { corroborateTaobaoEventTimes, eventStatus } from '../src/collector-enrichment.mjs';
import { detectPickupCompletion } from '../src/pickup-completion.mjs';
import { createCollector } from '../src/collectors.mjs';

const NOW = Date.parse('2026-11-11T17:19:00+08:00');
const TIME = Date.parse('2026-11-02T19:56:00+08:00');
const RECEIPT = '已签收，签收人凭取货码签收。感谢使用DGCY圆通及新港西路214号宿舍大院值班室旁丰巢柜【自提柜】，期待再次为您服务。';
const track = (description = RECEIPT) => ({ time: TIME, timeText: '2026-11-02 19:56', timePrecision: 'minute', description });
const summary = (timeText = '11-02 19:06') => ({ time: 0, timeText, provider: 'taobao', providerStatus: 'done',
  providerStatusTag: '待取件', providerStatusText: '包裹已送达丰巢柜，请及时取件', description: '待取件：包裹已送达丰巢柜，请及时取件' });
const pendingTrack = () => ({ time: TIME - 50 * 60000, timeText: '2026-11-02 19:06', timePrecision: 'minute', description: '待取件：包裹已存放至丰巢柜，请及时取件' });

test('code signature is signed while actual code pickup instructions remain arrived', () => {
  for (const code of ['取货', '取件']) {
    assert.equal(eventStatus(RECEIPT.replace('取货', code), 'unknown'), 'signed');
    for (const description of ['请凭' + code + '码取件', '已签收，驿站代收，请凭' + code + '码领取', '待取件：凭' + code + '码取件']) {
      assert.equal(eventStatus(description, 'unknown'), 'arrived', description);
    }
  }
});

test('explicit code receipt corroborates signed summary with a unique same-waybill full time', () => {
  const event = { ...summary('11-02 19:56'), providerStatusTag: '已签收', description: '已签收：包裹已从代收点取出' };
  const dated = corroborateTaobaoEventTimes([event], [track()], NOW)[0];
  assert.equal(dated.time, TIME);
  assert.equal(dated.timePrecision, 'minute');
  assert.equal(corroborateTaobaoEventTimes([event], [pendingTrack()], NOW)[0].time, 0);
  for (const fullTrack of [
    [{ ...track(), timeText: '2025-11-02 19:56' }],
    [track(), { ...track(), time: Date.parse('2025-11-02T19:56:00+08:00'), timeText: '2025-11-02 19:56' }],
  ]) assert.equal(corroborateTaobaoEventTimes([event], fullTrack, NOW)[0].time, 0);
});

test('dated older summary no longer blocks collection but same-time, newer and unknown pending still do', () => {
  const old = corroborateTaobaoEventTimes([summary()], [track(), pendingTrack()], NOW)[0];
  assert.equal(old.time, TIME - 50 * 60000);
  assert.ok(detectPickupCompletion({ logisticsEvents: [track(), old] }, { now: NOW }));
  for (const time of [0, TIME, TIME + 60000]) {
    assert.equal(detectPickupCompletion({ logisticsEvents: [track(), { ...summary(), time, timeText: '' }] }, { now: NOW }), null);
  }
});

test('refresh repairs stored undated Taobao summary and retains manual pending decision', () => {
  for (const manualPending of [false, true]) {
    const store = new Store({ key: Buffer.alloc(32, 3), now: () => NOW });
    try {
      store.saveAccount({ platform: 'taobao', label: 'fixture', cookie: 'FIXTURE' }, 'a', true);
      const importEvents = events => store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{
        platformOrderId: 'o', waybillNo: 'YT7653693173234', carrier: '圆通速递', status: 'arrived',
        logisticsState: 'ok', logisticsCheckedAt: NOW, logisticsUpdatedAt: NOW, logisticsEvents: events,
      }] });
      importEvents([summary()]);
      store.pickupCompletion.editRule('manual_code_receipt', { kind: 'user_collected', keywords: ['签收人凭取货码签收'], enabled: true, expectedVersion: 0 });
      if (manualPending) {
        const device = store.device(store.redeem(store.createPairing(['a']).code, 'fixture').token);
        store.applyOperations(device, [{ id: 'restore', shipmentId: store.snapshot(['a']).shipments[0].id, action: 'restore', occurredAt: NOW }]);
      }
      importEvents([track(), pendingTrack()]);
      const shipment = store.snapshot(['a']).shipments[0];
      assert.equal(shipment.logisticsEvents.some(event => !event.time), false);
      assert.equal(shipment.pickupCompletion.autoPicked, true);
      assert.equal(shipment.picked, !manualPending);
      assert.equal(shipment.pickupCompletion.manualOverride, manualPending ? 'pending' : '');
      importEvents([track(), pendingTrack()]);
      assert.equal(store.snapshot(['a']).shipments[0].picked, !manualPending);
    } finally { store.close(); }
  }
});

test('Taobao collector, persisted history and snapshot agree on the reported YTO code receipt', async () => {
  const fields = { mailNo: 'YT7653693173234', cpCode: 'YTO', multiStage: [
    { title: '已签收', subtitle: '11-02 19:56', status: 'doing', labelDesc: { text: '包裹已从代收点取出' } },
    { title: '待取件', subtitle: '11-02 19:06', status: 'done', labelDesc: { text: '包裹已送达丰巢柜，请及时取件' } },
  ] };
  const order = { platformOrderId: 'o', orderStatus: '待收货', shipments: [{ waybillNo: fields.mailNo, status: 'arrived', picked: false }] };
  const result = await createCollector({ now: () => NOW, fetchImpl: async url => {
    const host = new URL(url).hostname;
    if (host === 'pages-g.m.taobao.com') return new Response('<script>window[\'__ICE_SUSPENSE_LOADER__\'][\'undefined\'] = ' + JSON.stringify({ result: { data: { newLogistics: { fields } } } }) + ';</script>');
    if (host === 'buyertrade.taobao.com') return new Response(JSON.stringify({ expressId: fields.mailNo, expressName: '圆通速递', address: [
      { time: '2026-11-02 19:56', place: RECEIPT }, { time: '2026-11-02 19:06', place: pendingTrack().description },
    ] }).replace(/[^\x00-\x7f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));
    assert.equal(host, 'h5api.m.taobao.com');
    return new Response(JSON.stringify({ ret: ['SUCCESS'], data: { data: { orderInfo: { fields: { labels: [] } } } } }));
  } })({ platform: 'taobao' }, '_m_h5_tk=SYNTHETIC_1794240000', { targetOrder: order });
  assert.equal(result.shipments.length, 1);
  const parcel = result.shipments[0];
  assert.equal(parcel.status, 'signed');
  assert.ok(parcel.logisticsEvents.every(event => event.time > 0));
  const store = new Store({ key: Buffer.alloc(32, 3), now: () => NOW });
  try {
    store.saveAccount({ platform: 'taobao', label: 'fixture', cookie: 'FIXTURE' }, 'a', true);
    store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', waybillNo: fields.mailNo, carrier: '圆通速递', status: 'arrived', logisticsState: 'ok', logisticsCheckedAt: NOW - 1,
      logisticsEvents: [summary(), { ...summary('11-02 19:56'), providerStatus: 'doing', providerStatusTag: '已签收', providerStatusText: '包裹已从代收点取出', description: '已签收：包裹已从代收点取出' }] }] });
    store.importResult('a', result);
    const shipment = store.snapshot(['a']).shipments[0];
    assert.equal(shipment.status, 'signed');
    assert.equal(shipment.picked, true);
    assert.equal(shipment.pickupCompletion.autoPicked, true);
    assert.ok(shipment.logisticsEvents.every(event => event.time > 0));
  } finally { store.close(); }
});
