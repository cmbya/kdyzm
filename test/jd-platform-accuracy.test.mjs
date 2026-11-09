import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector, jdParcels } from '../src/collectors.mjs';

// Shapes already covered by jd-collector.test.mjs and the verified PC buyer APIs.
const NOW = Date.parse('2026-11-01T12:00:00+08:00');
const step = (CreationTime, Content, StatusName = '') => ({ CreationTime, Content, StatusName });
const arrival = step('2026-10-31 10:00:00', '包裹已到达【合成菜鸟驿站】，取件码8-2-1234', '待取件');
const reminder = step('2026-11-01 10:00:00', '催取提醒，请及时取件');
const signed = step('2026-11-01 10:00:00', '已签收', '已签收');
const parcel = (carriageId, orderTrackShowList, checkCode = null) => ({
  carriageInfo: { carriageId, carrier: '京东快递' }, trackGroupInfo: { checkCode, orderTrackShowList },
});
const tracking = (...parcels) => ({ multiPackageTrackInfoList: parcels });
const parse = (...steps) => jdParcels(tracking(parcel('SYNTHETIC-JD-A', steps)), 'synthetic-order', NOW)[0];
const network = detail => async url => new Response(JSON.stringify(
  new URL(url).searchParams.get('functionId') === 'pcdetail_traceMultiPackage' ? detail
    : { success: true, data: { orderList: [], totalNum: 0 } },
));

test('JD a signed returned subset cannot mark an order signed while another active parcel is missing', async () => {
  const known = { platformOrderId: 'synthetic-order', shipments: [
    { waybillNo: 'SYNTHETIC-JD-A', status: 'transit' }, { waybillNo: 'SYNTHETIC-JD-B', status: 'arrived' },
  ] };
  for (const options of [{ knownOrders: [known] }, { targetOrder: known }]) {
    const result = await createCollector({ now: () => NOW, fetchImpl: network(tracking(parcel('SYNTHETIC-JD-A', [signed]))) })(
      { platform: 'jd' }, 'thor=SYNTHETIC', options);
    assert.equal(result.shipments[0].status, 'signed');
    assert.deepEqual(result.logisticsFailures.map(failure => [failure.waybillNo, failure.state]), [['SYNTHETIC-JD-B', 'unavailable']]);
    assert.notEqual(result.orderUpdates[0].orderStatus, '已签收', 'an omitted active split shipment still has unknown current delivery status');
  }
});

test('JD complete signed responses can still mark the order signed', async () => {
  const result = await createCollector({ now: () => NOW,
    fetchImpl: network(tracking(parcel('SYNTHETIC-JD-A', [signed]), parcel('SYNTHETIC-JD-B', [signed]))),
  })({ platform: 'jd' }, 'thor=SYNTHETIC', { targetOrder: { platformOrderId: 'synthetic-order', shipments: [
    { waybillNo: 'SYNTHETIC-JD-A' }, { waybillNo: 'SYNTHETIC-JD-B' },
  ] } });
  assert.equal(result.orderUpdates[0].orderStatus, '已签收');
  assert.deepEqual(result.logisticsFailures, []);
});

test('JD a later pickup reminder retains the earlier code from the same pickup cycle on first import', () => {
  for (const steps of [[arrival, reminder], [reminder, arrival]]) {
    const result = parse(...steps);
    assert.equal(result.status, 'arrived');
    assert.equal(result.arrivalAt, Date.parse('2026-10-31T10:00:00+08:00'));
    assert.equal(result.pickupCode, '8-2-1234');
  }
});

test('JD current structured or newer textual codes take precedence over older pickup codes', () => {
  const newer = step('2026-11-01 10:00:00', '请及时取件，取件码8-2-5678');
  assert.equal(parse(arrival, newer).pickupCode, '8-2-5678');
  assert.equal(jdParcels(tracking(parcel('SYNTHETIC-JD-A', [arrival, newer], '8-2-9012')), 'synthetic-order', NOW)[0].pickupCode, '8-2-9012');
});

test('JD reminders after a return or reroute cannot recover a code from the previous pickup cycle', () => {
  for (const boundary of ['快件已退回，等待退件', '已改投合成新站菜鸟驿站', '重新派送中']) {
    const result = parse(arrival, step('2026-11-01 09:00:00', boundary), reminder);
    assert.equal(result.pickupCode, '', boundary);
    assert.equal(result.arrivalAt, 0, boundary);
  }
  const newArrival = step('2026-11-01 09:30:00', '包裹已到达【合成新站菜鸟驿站】，取件码9-3-4567', '待取件');
  assert.equal(parse(arrival, step('2026-11-01 09:00:00', '重新派送中'), newArrival, reminder).pickupCode, '9-3-4567');
});

test('JD a later signature does not revive an older pickup code', () => {
  const result = parse(arrival, signed);
  assert.equal(result.status, 'signed');
  assert.equal(result.pickupCode, '');
  assert.equal(result.arrivalAt, 0);
});

test('JD a future signature stays in the timeline without overriding a trusted current pickup', () => {
  const future = step('2026-11-02 10:00:00', '已签收', '已签收');
  for (const steps of [[arrival, future], [future, arrival]]) {
    const result = parse(...steps);
    assert.equal(result.status, 'arrived');
    assert.equal(result.pickupCode, '8-2-1234');
    assert.equal(result.arrivalAt, Date.parse('2026-10-31T10:00:00+08:00'));
    assert.equal(result.logisticsEvents.length, 2);
    assert.ok(result.logisticsEvents.some(event => event.time > NOW && event.description === '已签收：已签收'));
  }
});

test('JD a null track row does not discard the valid parcel and remaining events in the same response', async () => {
  const result = await createCollector({ now: () => NOW,
    fetchImpl: network(tracking(parcel('SYNTHETIC-JD-A', [arrival, null, reminder]))),
  })({ platform: 'jd' }, 'thor=SYNTHETIC', { targetOrder: { platformOrderId: 'synthetic-order', shipments: [{ waybillNo: 'SYNTHETIC-JD-A' }] } });
  assert.deepEqual(result.logisticsFailures, []);
  assert.equal(result.shipments.length, 1);
  assert.equal(result.shipments[0].status, 'arrived');
  assert.equal(result.shipments[0].pickupCode, '8-2-1234');
  assert.equal(result.shipments[0].logisticsEvents.length, 2);
  assert.ok(result.shipments[0].logisticsEvents.some(event => event.description.includes('催取提醒')));
  assert.ok(result.shipments[0].logisticsEvents.some(event => event.description.includes('取件码8-2-1234')));
});

test('JD code recovery stays inside its own split shipment', () => {
  const rows = jdParcels({ ...tracking(parcel('SYNTHETIC-JD-A', [arrival, reminder]),
    parcel('SYNTHETIC-JD-B', [step('2026-11-01 10:00:00', '运输中')])), checkCode: 'PARENT-CODE' }, 'synthetic-order', NOW);
  assert.equal(rows[0].pickupCode, '8-2-1234');
  assert.equal(rows[1].pickupCode, '');
});
