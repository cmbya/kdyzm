import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverPddSplit, fetchPddSplitTrack } from '../src/pdd-split.mjs';

const ORDER = 'synthetic-order';
const url = params => `https://mobile.yangkeduo.com/goods_express.html?${new URLSearchParams(params)}`;
const source = (params = {}, patch = {}) => ({ tracking_number: 'A', order_sn: ORDER,
  package_info_jump_url: url({ order_sn: ORDER, tracking_number: 'A', shipping_id: 'carrier-a', jump_type: '7', ...params }), ...patch });
const item = (tracking_number = 'A', patch = {}) => ({ tracking_number, shipping_id: `carrier-${tracking_number}`, shipping_name: '合成承运商',
  jump_url: url({ order_sn: ORDER, tracking_number, shipping_id: `carrier-${tracking_number}`, external: '1', entry_source: '2' }), ...patch });
const response = value => ({ text: JSON.stringify(value) });
function options(data, calls = []) {
  return { expectedOrderId: ORDER, pddCheck: value => value, platformRequest: async target => { calls.push(new URL(target)); return response(data); } };
}

test('no platform split URL means no discovery request or invented selector', async () => {
  const calls = [];
  assert.deepEqual(await discoverPddSplit({ tracking_number: 'A' }, options({}, calls)), { parcels: [], failures: [] });
  assert.equal(calls.length, 0);
});

test('discovers independent parcels through the fixed endpoint and retains only business selectors', async () => {
  const calls = [];
  const first = item('A', { jump_url: url({ order_sn: ORDER, tracking_number: ' Ａ ', shipping_id: 'carrier-A', external: '1',
    source_type: '4', refer_scene: '5', after_sales_id: 'after-synthetic', anti_content: 'DO-NOT-PERSIST', token: 'fixture' }) });
  const found = await discoverPddSplit(source({ partial_shipment_period: '2', anti_content: 'DO-NOT-SEND' }), options({ result: { list: [first, item('B')] } }, calls));
  assert.equal(calls[0].pathname, '/proxy/api/api/express/split/pack');
  assert.equal(calls[0].origin, 'https://mobile.yangkeduo.com');
  assert.equal(calls[0].searchParams.get('partial_shipment_period'), '2');
  assert.equal(calls[0].searchParams.has('anti_content'), false);
  assert.deepEqual(found.parcels.map(p => p.waybillNo), ['A', 'B']);
  assert.deepEqual(found.failures, []);
  assert.deepEqual(found.parcels[0].query, { order_sn: ORDER, shipping_id: 'carrier-A', tracking_number: 'A', refer_scene: '5', source_type: '4', after_sales_id: 'after-synthetic' });
  assert.ok(found.parcels.every(p => !Object.hasOwn(p, 'platformPackageKey')));
});

test('each requested waybill receives only its matching full original shipping payload', async () => {
  const found = await discoverPddSplit(source(), options({ result: { list: [item('A'), item('B')] } }));
  const calls = [], results = [];
  for (const parcel of found.parcels) {
    const shipping = { order_sn: ORDER, tracking_number: parcel.waybillNo, shipping_name: parcel.carrier,
      traces: [{ info: `轨迹-${parcel.waybillNo}`, status: 'DELIVERED', status_tag: '本人签收', nested: { retained: true } }], extra: { retained: true } };
    results.push(await fetchPddSplitTrack(parcel, options({ shipping }, calls)));
    assert.deepEqual(results.at(-1).shipping, shipping);
  }
  assert.deepEqual(calls.map(call => call.pathname), ['/proxy/api/api/express/shipping/track', '/proxy/api/api/express/shipping/track']);
  assert.deepEqual(calls.map(call => call.searchParams.get('tracking_number')), ['A', 'B']);
  assert.ok(calls.every(call => call.searchParams.get('support_multi_package') === '1' && call.searchParams.get('query_type') === '1'));
  assert.notDeepEqual(results[0].shipping.traces, results[1].shipping.traces);
});

test('rejects unsafe, mismatched and duplicated discovery query fields before requesting', async () => {
  for (const shipping of [
    source({ order_sn: 'other' }), source({ tracking_number: 'B' }), source({}, { order_sn: 'other' }),
    source({}, { package_info_jump_url: 'https://example.invalid/?order_sn=synthetic-order&tracking_number=A' }),
    source({}, { package_info_jump_url: 'http://mobile.yangkeduo.com/?order_sn=synthetic-order&tracking_number=A' }),
    source({}, { package_info_jump_url: 'https://user:secret@mobile.yangkeduo.com/?order_sn=synthetic-order&tracking_number=A' }),
    source({}, { package_info_jump_url: `${url({ order_sn: ORDER, tracking_number: 'A' })}&order_sn=other` }),
    source({ tracking_number: '待发货' }),
  ]) {
    const calls = [], result = await discoverPddSplit(shipping, options({}, calls));
    assert.equal(calls.length, 0);
    assert.equal(result.parcels.length, 0);
    assert.equal(result.failures.length, 1);
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
});

test('invalid or cross-order list records do not contaminate independent valid parcels', async () => {
  const found = await discoverPddSplit(source(), options({ result: { list: [
    item('A'), item('B', { order_sn: 'other' }), item('C', { jump_url: url({ order_sn: 'other', tracking_number: 'C' }) }),
    item('D', { jump_url: url({ order_sn: ORDER, tracking_number: 'OTHER', shipping_id: 'carrier-D' }) }),
    item('E', { jump_url: url({ order_sn: ORDER, tracking_number: 'E', shipping_id: 'OTHER' }) }),
    item('F', { jump_url: 'https://example.invalid/?tracking_number=F' }),
    item('G', { jump_url: '', shipping_id: '' }), item('待发货'), item('H', { jump_url: url({ external: '0' }) }), null,
  ] } }));
  assert.deepEqual(found.parcels.map(p => p.waybillNo), ['A']);
  assert.equal(found.failures.length, 9);
});

test('same waybill and different shipping IDs never manufacture multiple package identities', async () => {
  const found = await discoverPddSplit(source(), options({ result: { list: [item('A'), item('A'),
    item('A', { shipping_id: 'different', jump_url: url({ order_sn: ORDER, tracking_number: 'A', shipping_id: 'different' }) }), item('B'), item('B')] } }));
  assert.deepEqual(found.parcels.map(p => p.waybillNo), ['B']);
  assert.equal(found.failures.length, 1);
  assert.equal(found.failures[0].waybillNo, 'A');
});

test('wrong or missing response identity never returns another parcels track', async () => {
  const { parcels: [parcel] } = await discoverPddSplit(source(), options({ result: { list: [item('A')] } }));
  for (const payload of [
    { shipping: { tracking_number: 'B', traces: [{ info: '其他包已签收' }] } },
    { shipping: { traces: [{ info: '缺少运单' }] } },
    { order_sn: 'other', shipping: { tracking_number: 'A', traces: [] } },
    { shipping: { order_sn: 'other', tracking_number: 'A', traces: [] } },
    { shipping: { tracking_number: 'A', trackingNumber: 'B', traces: [] } },
    { shipping: { tracking_number: 'A', traces: {} } },
  ]) {
    const result = await fetchPddSplitTrack(parcel, options(payload));
    assert.equal(result.shipping, undefined);
    assert.equal(result.failure.waybillNo, 'A');
    assert.equal(result.failure.state, 'unavailable');
  }
  const failed = await fetchPddSplitTrack({ ...parcel, waybillNo: 'B' }, { ...options({}), platformRequest: () => assert.fail('must not request') });
  assert.equal(failed.failure.waybillNo, 'B');
});

test('explicit refresh performs one request and revalidates persisted query selectors', async () => {
  const { parcels: [parcel] } = await discoverPddSplit(source(), options({ result: { list: [item('A')] } }));
  const calls = [];
  const result = await fetchPddSplitTrack({ ...parcel, query: { ...parcel.query, antiContent: 'DO-NOT-SEND', unknown: 'DO-NOT-SEND' } }, {
    ...options({ shipping: { tracking_number: 'Ａ', orderSn: ORDER, traces: [], query_again: true } }, calls), queryType: 2,
  });
  assert.equal(result.shipping.query_again, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].searchParams.get('query_type'), '2');
  assert.equal(calls[0].searchParams.has('antiContent'), false);
  assert.equal(calls[0].searchParams.has('unknown'), false);
  for (const patch of [{ order_sn: 'other' }, { shipping_id: {} }, { tracking_number: 'B' }]) {
    const failed = await fetchPddSplitTrack({ ...parcel, query: { ...parcel.query, ...patch } }, {
      ...options({}), platformRequest: () => assert.fail('must not request'),
    });
    assert.equal(failed.failure.waybillNo, 'A');
  }
});

test('response format failures preserve history while transport and account errors reach the queue', async () => {
  const { parcels: [parcel] } = await discoverPddSplit(source(), options({ result: { list: [item('A')] } }));
  for (const run of [opts => discoverPddSplit(source(), opts), opts => fetchPddSplitTrack(parcel, opts)]) {
    for (const value of [null, [], {}, { result: { list: {} } }]) {
      const result = await run(options(value));
      assert.ok(result.failure || result.failures?.length);
    }
    const malformed = await run({ ...options({}), platformRequest: async () => ({ text: 'invalid-json' }) });
    assert.ok(malformed.failure || malformed.failures?.length);
    const incompatible = await run({ ...options({}), pddCheck: () => { throw Object.assign(new Error(), { code: 'UPSTREAM_FORMAT' }); } });
    assert.ok(incompatible.failure || incompatible.failures?.length);
    for (const code of ['ACCOUNT_EXPIRED', 'UPSTREAM_BLOCKED', 'RATE_LIMITED', 'UPSTREAM_ERROR', 'TimeoutError', 'AbortError']) {
      const error = Object.assign(new Error('private upstream diagnostic'), { code });
      await assert.rejects(run({ ...options({}), platformRequest: async () => { throw error; } }), e => e === error);
      await assert.rejects(run({ ...options({}), pddCheck: () => { throw error; } }), e => e === error);
    }
  }
});
