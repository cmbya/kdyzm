import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector, taobaoParcels } from '../src/collectors.mjs';

const NOW = Date.parse('2026-11-10T10:00:00+08:00');
const stage = (code, station = '合成甲驿站') => ({ title: '待取件', status: 'doing', subtitle: '2026-11-10 09:00:00',
  labelDesc: { text: `包裹已到${station}，请及时取件` }, cardDesc: { title: station, custom: { expressCode: { code } } } });
const root = () => ({ mailNo: 'A', logisticCompany: { name: '中通快递', mailNo: 'A' }, multiStage: [stage('1-2-3456')],
  multiPackages: { packages: [{ mailNo: 'A', cpCode: 'ZTO', orderCode: 'P-A' }, { mailNo: 'B', cpCode: 'SF', orderCode: 'P-B' }] } });
const ssr = fields => new Response(`<script>window['__ICE_SUSPENSE_LOADER__']['undefined'] = ${JSON.stringify({ result: { data: { newLogistics: { fields } } } })};</script>`);
const target = { platformOrderId: 'SYNTHETIC-TB-ACCURACY', orderStatus: '待收货', orderDate: NOW - 86400000, orderDateOrigin: 'detail', orderDatePrecision: 'second', shipments: [] };

test('Taobao empty rich content falls back to the visible plain label', () => {
  const fields = root(); fields.multiStage[0].labelDesc.richContent = [];
  const parcel = taobaoParcels(fields, target.platformOrderId, '', undefined, NOW)[0];
  assert.match(parcel.logisticsEvents[0].description, /请及时取件/);
});

test('Taobao keeps the root waybill when an incomplete package list omits it and never attaches it to a sibling', () => {
  const fields = root(); fields.multiPackages.packages = [fields.multiPackages.packages[1]];
  const parcels = taobaoParcels(fields, target.platformOrderId, 'PARENT-CODE', undefined, NOW);
  assert.equal(parcels.length, 2);
  assert.equal(parcels.find(p => p.waybillNo === 'A').pickupCode, '1-2-3456');
  assert.equal(parcels.find(p => p.waybillNo === 'B').pickupCode, '');
  assert.equal(parcels.find(p => p.waybillNo === 'B').logisticsState, 'unavailable');
});

test('Taobao duplicate parcel descriptors do not duplicate a shipment, and malformed rows do not discard good stages', () => {
  const fields = root(); fields.multiPackages.packages.push({ ...fields.multiPackages.packages[0] }, null);
  fields.multiStage.push(null);
  const parcels = taobaoParcels(fields, target.platformOrderId, '', undefined, NOW);
  assert.deepEqual(parcels.map(p => p.waybillNo), ['A', 'B']);
  assert.equal(parcels[0].logisticsEvents.length, 1);
});

test('Taobao rejects detail fields explicitly belonging to a different parcel', () => {
  const fields = root(); fields.multiPackages.packages[1].fields = { mailNo: 'A', multiStage: [stage('WRONG-CODE')] };
  const parcel = taobaoParcels(fields, target.platformOrderId, '', undefined, NOW).find(p => p.waybillNo === 'B');
  assert.equal(parcel.pickupCode, ''); assert.equal(parcel.logisticsEvents.length, 0);
  const conflicting = root(); conflicting.logisticCompany.mailNo = 'B';
  assert.ok(taobaoParcels(conflicting, target.platformOrderId, '', undefined, NOW).every(p => !p.pickupCode && !p.logisticsEvents.length));
});

async function collectSplit(mode = 'ok') {
  const calls = [];
  const result = await createCollector({ now: () => NOW, fetchImpl: async url => {
    const u = new URL(url); calls.push(u);
    if (u.hostname === 'pages-g.m.taobao.com') {
      if (!u.searchParams.has('mailNo')) return ssr(root());
      assert.equal(u.searchParams.get('mailNo'), 'B');
      assert.equal(u.searchParams.get('cpCode'), 'SF');
      assert.equal(u.searchParams.get('orderCode'), 'P-B');
      if (mode === 'failed') return new Response('unavailable', { status: 503 });
      if (mode === 'mismatch') return ssr(root());
      return ssr({ mailNo: 'B', logisticCompany: { mailNo: 'B', name: '顺丰速运' }, multiStage: [stage('8-9-1234', '合成乙驿站')] });
    }
    assert.equal(u.hostname, 'buyertrade.taobao.com');
    return new Response(JSON.stringify({ expressId: 'A', address: [] }));
  } })({ platform: 'taobao' }, '_m_h5_tk=SYNTHETIC_1794240000', { targetOrder: target });
  return { result, calls };
}

test('Taobao queries omitted split detail using the official selector and attaches each code only to its waybill', async () => {
  const { result, calls } = await collectSplit();
  assert.equal(calls.filter(u => u.searchParams.get('mailNo') === 'B').length, 1);
  assert.equal(result.shipments.find(p => p.waybillNo === 'A').pickupCode, '1-2-3456');
  assert.equal(result.shipments.find(p => p.waybillNo === 'B').pickupCode, '8-9-1234');
  assert.match(result.shipments.find(p => p.waybillNo === 'B').station, /合成乙/);
});

test('Taobao failed or mismatched split detail preserves the primary parcel and never borrows its code', async () => {
  for (const mode of ['failed', 'mismatch']) {
    const { result } = await collectSplit(mode);
    assert.equal(result.shipments.find(p => p.waybillNo === 'A').pickupCode, '1-2-3456', mode);
    assert.equal(result.shipments.find(p => p.waybillNo === 'B').pickupCode, '', mode);
    assert.equal(result.shipments.find(p => p.waybillNo === 'B').logisticsEvents.length, 0, mode);
  }
});

test('Taobao future summary and PC signature are retained without overriding a current pickup', async () => {
  const fields = root(); delete fields.multiPackages;
  fields.multiStage.unshift({ title: '已签收', subtitle: '2026-11-11 09:00:00', labelDesc: { text: '本人已签收' } });
  const result = await createCollector({ now: () => NOW, fetchImpl: async url => new URL(url).hostname === 'pages-g.m.taobao.com'
    ? ssr(fields) : new Response(JSON.stringify({ expressId: 'A', address: [null,
      { time: '2026-11-11 09:00:00', place: '\u5df2\u7b7e\u6536' },
      { time: '2026-11-10 08:00:00', place: '\u6d3e\u9001\u4e2d' },
    ] }).replace(/[^\x00-\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`))
  })({ platform: 'taobao' }, '_m_h5_tk=SYNTHETIC_1794240000', { targetOrder: target });
  assert.equal(result.shipments[0].status, 'arrived');
  assert.equal(result.shipments[0].pickupCode, '1-2-3456');
  assert.ok(result.shipments[0].logisticsEvents.some(event => event.time > NOW));
});

test('Taobao interrupted sibling detail checkpoints the verified primary parcel and preserves retry behavior', async () => {
  for (const [status, code] of [[503, 'UPSTREAM_ERROR'], [403, 'UPSTREAM_BLOCKED']]) {
    const checkpoints = [];
    const collect = createCollector({ now: () => NOW, fetchImpl: async url => new URL(url).searchParams.has('mailNo')
      ? new Response('Synthetic sibling failure', { status }) : ssr(root()) });
    await assert.rejects(collect({ platform: 'taobao' }, '_m_h5_tk=SYNTHETIC_1794240000', {
      targetOrder: target, durableLogistics: true, onProgress: delta => checkpoints.push(structuredClone(delta)),
    }), { code });
    const ready = checkpoints.flatMap(delta => delta.shipments || []);
    assert.equal(ready.length, 1); assert.equal(ready[0].waybillNo, 'A');
    assert.equal(ready[0].pickupCode, '1-2-3456'); assert.equal(ready[0].logisticsState, 'ok');
  }
});
