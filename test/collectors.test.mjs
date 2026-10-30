import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector, extractSsrFields, pddParcels, platformRequest, taobaoParcels, timestamp } from '../src/collectors.mjs';

const response = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
const ssr = fields => `<script>window['__ICE_SUSPENSE_LOADER__']['undefined'] = ${JSON.stringify({ result: { data: { newLogistics: { fields } } } })};</script>`;

test('Taobao structured SSR retains every split waybill and never fans one parent code out to all parcels', () => {
  const fields = { multiPackages: { packages: [{ mailNo: 'A', cpCode: 'ZTO' }, { mailNo: 'B', cpCode: 'SF' }] } };
  assert.deepEqual(extractSsrFields(ssr(fields)), fields);
  const parcels = taobaoParcels(fields, 'order-1', 'PARENT-CODE');
  assert.equal(parcels.length, 2); assert.ok(parcels.every(p => p.pickupCode === '' && !('picked' in p)));
  assert.deepEqual(parcels.map(p => p.carrier), ['中通快递', '顺丰速运']);
  const signed = taobaoParcels({ mailNo: 'A', logisticCompany: { name: '中通快递' }, multiStage: [{ title: '已签收', labelDesc: { text: '本人签收' } }] }, 'order-1')[0];
  assert.equal(signed.status, 'signed'); assert.ok(!('picked' in signed));
  const arrived = taobaoParcels({ mailNo: 'A', multiStage: [{ title: '待取件', time: '2026-10-30 10:00:00', cardDesc: { title: '驿站', custom: { expressCode: { code: '8-2-1234' } } } }] }, 'o')[0];
  assert.equal(arrived.status, 'arrived'); assert.equal(arrived.pickupCode, '8-2-1234'); assert.equal(arrived.arrivalAt, Date.parse('2026-10-30T10:00:00+08:00'));
});

test('PDD collectors use real H5 paths with injected network, paginate and keep no-code and split shipments', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const target = new URL(url); calls.push({ target, options });
    if (target.pathname.includes('order_list_v4')) {
      if (target.searchParams.get('page') === '1') return response({ orders: [{ order_sn: 'o1', tracking_number: 'TRACK1', order_time: 1793350000, order_goods: [{ goods_name: '无取件码包裹' }], offset: 'next' }] });
      return response({ orders: [{ order_sn: 'o2', shipping_list: [{ tracking_number: 'SPLIT1' }, { tracking_number: 'SPLIT2' }], order_goods: [], order_amount: 1234 }], has_more: false });
    }
    return response({ success: true, result: { code: '', status: 0 } });
  };
  const collect = createCollector({ fetchImpl });
  const result = await collect({ platform: 'pdd' }, 'PDDAccessToken=FAKE;pdd_user_id=123');
  assert.equal(result.orders.length, 2); assert.equal(result.shipments.length, 3); assert.equal(result.orders[1].amount, 12.34);
  assert.ok(result.shipments.every(s => !s.pickupCode && !('picked' in s)));
  assert.equal(calls.find(c => c.target.searchParams.get('page') === '2').target.searchParams.get('offset'), 'next');
  for (const call of calls) {
    assert.equal(call.options.redirect, 'error'); assert.match(call.options.headers.Cookie, /PDDAccessToken=FAKE/);
    if (call.target.pathname.includes('/cabinet/')) assert.equal(call.target.search, '');
  }
});

test('PDD disappearance and bounded pagination have no synthesized pick/delete events', async () => {
  const collect = createCollector({ maxPages: 1, fetchImpl: async url => String(url).includes('order_list_v4') ? response({ orders: [{ order_sn: 'o1', tracking_number: 'A' }] }) : response({ result: { code: '123456', address: '站点' } }) });
  const result = await collect({ platform: 'pdd' }, 'pdd_user_id=1');
  assert.equal(result.shipments[0].status, 'arrived'); assert.ok(result.warnings.some(w => w.includes('分页上限')));
  assert.ok(!('deletedIds' in result)); assert.ok(!('picked' in result.shipments[0]));
  const signed = pddParcels({ order_sn: 'old', tracking_number: 'A', order_status_text: '交易完成' }, { code: 'OLD' })[0];
  assert.equal(signed.status, 'signed'); assert.equal(signed.arrivalAt, 0);
});

test('Taobao MTOP signing and SSR collection preserve order plus all waybills without a live account', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const target = new URL(url); calls.push({ target, options });
    if (target.hostname === 'pages-g.m.taobao.com') return new Response(ssr({ multiPackages: { packages: [{ mailNo: 'A', cpCode: 'ZTO' }, { mailNo: 'B', cpCode: 'SF' }] } }));
    if (!target.searchParams.has('sign')) return response({ ret: ['FAIL_SYS_TOKEN_EMPTY'] });
    assert.match(target.searchParams.get('sign'), /^[a-f0-9]{32}$/);
    if (options.method === 'POST') return response({ ret: ['SUCCESS::调用成功'], data: { data: { comServiceTips_o1: { fields: { singleLineRiceText: [{ richStr: '取件码 123456' }] } } } } });
    const page = JSON.parse(target.searchParams.get('data')).page;
    return response({ ret: ['SUCCESS::调用成功'], data: { result: JSON.stringify({ mainOrders: page === '1' ? [{ id: 'o1', subOrders: [{ itemInfo: { title: '拆单商品' } }], statusInfo: { text: '待收货' } }] : [] }) } });
  };
  const result = await createCollector({ fetchImpl })({ platform: 'taobao' }, '_m_h5_tk=TEST_1793350000');
  assert.equal(result.orders.length, 1); assert.equal(result.shipments.length, 2); assert.ok(result.shipments.every(s => !s.pickupCode));
  assert.ok(calls.some(c => c.target.pathname.endsWith('/h5-detail')));
  assert.ok(calls.some(c => c.options.method === 'POST' && c.options.body.startsWith('data=')));
});

test('upstream expired response is explicit, requests cannot follow redirects or access arbitrary hosts', async () => {
  const collect = createCollector({ fetchImpl: async () => response({ error_code: 40001 }) });
  await assert.rejects(() => collect({ platform: 'pdd' }, 'pdd_user_id=1'), { code: 'ACCOUNT_EXPIRED' });
  await assert.rejects(() => platformRequest('https://evil.example/cookie', 'secret'), { code: 'INVALID_UPSTREAM' });
  await assert.rejects(() => platformRequest('https://mobile.yangkeduo.com/test', 'secret', { fetchImpl: async () => new Response('x', { headers: { 'Content-Length': '99999999' } }) }), { code: 'UPSTREAM_ERROR' });
  assert.equal(timestamp('2026-10-30 10:00:00'), Date.parse('2026-10-30T10:00:00+08:00'));
});
