import test from 'node:test';
import assert from 'node:assert/strict';
import { parcelJourney, parcelJourneySegments, parcelJourneyProgress, shipmentCollectedAt, packageCollectedAt, packageCollectedDateKey, comparePackagesByCollectedAt } from '../app-source/pickcode/services/parcel-journey.js';

const at = value => Date.parse(`2026-${value}+08:00`);
const order = { orderDate: at('11-04T23:38:00'), orderDateSource: 'platform', orderDatePrecision: 'second' };
const shipment = { status: 'arrived', picked: false, shippedAt: at('11-05T10:20:00'), shippedAtSource: 'platform_event', shippedAtPrecision: 'minute',
  arrivalAt: at('11-08T17:57:00'), arrivalAtSource: 'platform_event', arrivalAtPrecision: 'minute' };
const confirmed = value => ({ picked: true, pickedAt: value, pickedAtSource: 'user_confirmed', pickedAtPrecision: 'second' });

test('四时间用中国时区，等待为已耗时而非未知取货时间', () => {
  const original = Date.now; Date.now = () => at('11-09T02:28:00');
  try {
    const view = parcelJourney(shipment, order);
    assert.deepEqual(view.points.map(row => row.text), ['11/04 23:38', '11/05 10:20', '11/08 17:57', '待取件']);
    assert.deepEqual(view.segments.map(row => row.text), ['10时42分', '3天7时37分', '8时31分']);
    assert.deepEqual(view.points.map(row => row.label), ['下单', '发货', '到货', '取件']);
    assert.equal(view.points[3].at, null); assert.equal(view.currentIndex, 2); assert.equal(view.completed, false);
  } finally { Date.now = original; }
});
test('日期精度、短信代理和逆序不冒充分钟级真实耗时', () => {
  const day = parcelJourney(shipment, { orderDate: '2026-11-04', orderDateSource: 'manual' });
  assert.equal(day.points[0].text, '11/04'); assert.equal(day.points[0].precision, 'day'); assert.equal(day.segments[0].text, '—');
  const sms = parcelJourney({ ...shipment, arrivalAtSource: 'sms_received', arrivalAtPrecision: 'unknown' }, order);
  assert.equal(sms.segments[1].text, '—'); assert.equal(sms.points[2].at, null); assert.equal(sms.points[2].text, '待获取');
  assert.ok(parcelJourney({ ...shipment, arrivalAt: at('11-03T10:00:00') }, order).segments.every(row => row.text === '—'));
  const unknown = parcelJourney({ status: 'arrived', picked: true }, { firstSeenAt: order.orderDate, orderDate: order.orderDate, orderDateSource: 'legacy' });
  assert.deepEqual(unknown.points.map(row => row.at), [null, null, null, null]);
  assert.equal(unknown.points[3].text, '待获取');
  const empty = parcelJourney(); assert.equal(empty.currentIndex, -1); assert.ok(empty.points.every(row => row.state === 'pending'));
  assert.equal(parcelJourney({ ...shipment, status: 'returned' }, order).currentIndex, -1);
});
test('本人签收与驿站领取区分，普通签收和超期完成不制造取货时间', () => {
  const evidence = { kind: 'recipient_signed', eventTime: at('11-08T19:00:00'), timePrecision: 'minute' };
  const signed = { picked: true, pickupCompletion: { autoPicked: true, manualOverride: '', completedAt: evidence.eventTime, evidence } };
  assert.equal(parcelJourney(signed).points[3].label, '签收');
  assert.equal(shipmentCollectedAt(signed), evidence.eventTime);
  assert.equal(shipmentCollectedAt({ ...signed, pickupCompletion: { ...signed.pickupCompletion, evidence: { ...evidence, kind: 'signed' } } }), null);
  assert.equal(shipmentCollectedAt({ ...signed, receiptState: 'expired_signed' }), null);
  assert.equal(shipmentCollectedAt({ ...signed, pickupCompletion: { ...signed.pickupCompletion, manualOverride: 'pending' } }), null);
});
test('操作时间与真实确认时间分离，0不回退为本次关联时间', () => {
  const remote = { picked: true, pickupManualAt: at('11-09T02:28:00'), pickupManualAction: 'pick', pickupCompletion: { manualOverride: 'picked' } };
  assert.equal(shipmentCollectedAt(remote), remote.pickupManualAt);
  assert.equal(shipmentCollectedAt({ ...remote, pickupConfirmedAt: 0 }), null);
  assert.equal(shipmentCollectedAt({ ...remote, pickupConfirmedAt: at('11-08T20:00:00') }), at('11-08T20:00:00'));
  assert.equal(shipmentCollectedAt({ ...confirmed(remote.pickupManualAt), pickedAtCycleId: 'old', pickupCycle: { id: 'new' } }), null);
});
test('历史多运单取最后真实时间，未知成员和旧签收留在未知组', () => {
  const earlier = { shipments: [confirmed(at('11-08T23:50:00'))] };
  const later = { shipments: [confirmed(at('11-08T23:50:00')), confirmed(at('11-09T00:10:00'))] };
  const unknown = { shipments: [confirmed(at('11-09T00:10:00')), { picked: true }] };
  assert.equal(packageCollectedAt(later), at('11-09T00:10:00'));
  assert.equal(packageCollectedDateKey(later), '2026-11-09');
  assert.equal(packageCollectedDateKey(unknown), 'unknown');
  assert.equal(packageCollectedDateKey({ checked: true, source: 'manual', orderDate: order.orderDate }), 'unknown');
  assert.deepEqual([unknown, earlier, later].sort(comparePackagesByCollectedAt), [later, earlier, unknown]);
});

const stages = [
  { label: '待发货', days: 2, shipment: {}, order: { ...order, id: 'order-1' }, time: 'orderDate', source: 'orderDateSource', precision: 'orderDatePrecision' },
  { label: '运输', days: 3, shipment: { status: 'transit', shippedAt: shipment.shippedAt, shippedAtSource: 'platform_event', shippedAtPrecision: 'minute' }, order, time: 'shippedAt', source: 'shippedAtSource', precision: 'shippedAtPrecision' },
  { label: '待取', days: 1, shipment, order, time: 'arrivalAt', source: 'arrivalAtSource', precision: 'arrivalAtPrecision' },
];
for (const [index, stage] of stages.entries()) {
  test(`${stage.label}进行中耗时随时钟推进，历史耗时和输入不变`, () => {
    const view = parcelJourney(stage.shipment, stage.order), original = structuredClone(view);
    const start = view.points[index].at;
    const first = parcelJourneySegments(view, start + 60000), later = parcelJourneySegments(view, start + 120000);
    assert.equal(first[index].text, '1分');
    assert.equal(later[index].text, '2分');
    assert.deepEqual(later.map(row => row.ongoing), [0, 1, 2].map(position => position === index));
    assert.deepEqual(later.filter((_, position) => position !== index), first.filter((_, position) => position !== index));
    for (const now of [start - 1, NaN, Infinity, null, '2026-11-09']) assert.equal(parcelJourneySegments(view, now)[index].text, '—');
    parcelJourneySegments(view, start + 30 * 86400000);
    assert.ok(view.points.slice(index + 1).every(point => point.state === 'pending'));
    assert.deepEqual(view, original);
  });
  test(`${stage.label}小车按${stage.days}天推进且不改变节点、状态和实际时长`, () => {
    const view = parcelJourney(stage.shipment, stage.order), original = structuredClone(view);
    const start = view.points[index].at, span = stage.days * 86400000;
    assert.equal(view.currentIndex, index);
    assert.equal(parcelJourneyProgress(view, start), index);
    assert.equal(parcelJourneyProgress(view, start + span / 2), index + 0.5);
    assert.equal(parcelJourneyProgress(view, start + span), index + 1);
    assert.equal(parcelJourneyProgress(view, start + span * 10), index + 1);
    assert.equal(parcelJourneyProgress(view, start - 1), index);
    for (const now of [NaN, Infinity, null, '2026-11-09']) assert.equal(parcelJourneyProgress(view, now), index);
    assert.deepEqual(view, original);
  });
  test(`${stage.label}小车缺失、不可信、日期精度或全局逆序时停在当前节点`, () => {
    const make = patch => parcelJourney(index === 0 ? stage.shipment : { ...stage.shipment, ...patch }, index === 0 ? { ...stage.order, ...patch } : stage.order);
    const now = at('11-20T12:00:00');
    for (const value of [null, 0, NaN, '2026-11-04']) assert.equal(parcelJourneyProgress(make({ [stage.time]: value }), now), index);
    for (const source of ['unknown', 'legacy', 'sms_received', 'sms_sent', 'locker_created', 'unverified']) assert.equal(parcelJourneyProgress(make({ [stage.source]: source }), now), index);
    for (const precision of ['day', 'unknown', undefined]) assert.equal(parcelJourneyProgress(make({ [stage.precision]: precision }), now), index);
    const reversed = parcelJourney(stage.shipment, stage.order);
    const current = reversed.points[index].at;
    reversed.points[index === 0 ? 1 : index - 1].at = current + (index === 0 ? -1 : 1);
    assert.equal(parcelJourneyProgress(reversed, now), index);
  });
}
test('动态耗时保留日精度、短信代理与逆序的未知边界', () => {
  const now = at('11-09T12:00:00');
  const day = parcelJourney({}, { ...order, orderDate: '2026-11-04', orderDateSource: 'manual' });
  assert.equal(parcelJourneySegments(day, now)[0].text, '—');
  for (const source of ['sms_received', 'sms_sent', 'locker_created', 'legacy', 'unknown']) {
    const view = parcelJourney({ ...shipment, arrivalAtSource: source }, order);
    assert.equal(view.points[2].at, null);
    assert.equal(parcelJourneySegments(view, now)[1].text, '—');
    assert.equal(parcelJourneySegments(view, now)[2].text, '—');
  }
  const reversed = parcelJourney({ ...shipment, arrivalAt: at('11-03T10:00:00') }, order);
  assert.ok(parcelJourneySegments(reversed, now).every(row => row.text === '—'));
  for (const value of [undefined, null, {}, { points: [] }]) {
    assert.deepEqual(parcelJourneySegments(value, now).map(row => [row.text, row.ongoing]), [['—', false], ['—', false], ['—', false]]);
  }
});
test('动态耗时默认用当前时钟，已完成耗时不会随时钟增长', () => {
  const now = at('11-09T02:28:00'), original = Date.now;
  Date.now = () => now;
  try {
    const view = parcelJourney(shipment, order);
    assert.deepEqual(parcelJourneySegments(view), view.segments);
    assert.equal(parcelJourneySegments(view)[2].text, '8时31分');
    const complete = parcelJourney({ ...shipment, ...confirmed(now) }, order);
    assert.ok(complete.segments.every(row => row.ongoing === false));
    assert.deepEqual(parcelJourneySegments(complete, now + 86400000), complete.segments);
  } finally { Date.now = original; }
});
test('已实际经过的节点点亮但缺失历史日期仍待获取，退回只亮有真实时间的节点', () => {
  const transit = parcelJourney({ status: 'transit' }, { id: 'order-1' });
  assert.deepEqual(transit.points.map(point => point.state), ['done', 'current', 'pending', 'pending']);
  const arrived = parcelJourney({ status: 'arrived' });
  assert.deepEqual(arrived.points.map(point => point.state), ['done', 'done', 'current', 'pending']);
  assert.deepEqual(arrived.points.map(point => point.at), [null, null, null, null]);
  assert.deepEqual(arrived.points.map(point => point.text), ['待获取', '待获取', '待获取', '待取件']);
  assert.ok(parcelJourneySegments(arrived, at('11-30T12:00:00')).every(row => row.text === '—'));
  const completed = parcelJourney({ picked: true });
  assert.ok(completed.points.every(point => point.state === 'done' && point.at === null && point.text === '待获取'));
  for (const status of ['returning', 'returned']) {
    const returned = parcelJourney({ status, shippedAt: shipment.shippedAt, shippedAtSource: 'platform_event', shippedAtPrecision: 'minute' });
    assert.equal(returned.currentIndex, -1);
    assert.deepEqual(returned.points.map(point => point.state), ['pending', 'done', 'pending', 'pending']);
    assert.ok(parcelJourneySegments(returned).every(row => row.text === '—' && row.ongoing === false));
  }
});
test('小车未知与退回隐藏，完成固定终点，默认时钟只计算展示进度', () => {
  const now = at('11-09T12:00:00'), original = Date.now;
  Date.now = () => now;
  try {
    const view = parcelJourney({ status: 'arrived', arrivalAt: now - 12 * 3600000, arrivalAtSource: 'locker_arrival', arrivalAtPrecision: 'minute' });
    assert.equal(parcelJourneyProgress(view), 2.5);
    assert.equal(parcelJourneyProgress(parcelJourney({}, { orderDate: now - 86400000, orderDateSource: 'manual', orderDatePrecision: 'second' })), 0.5);
    for (const value of [undefined, null, {}, { currentIndex: '1' }, { currentIndex: 0.5 }, { currentIndex: 4 }, { currentIndex: -2 }]) assert.equal(parcelJourneyProgress(value), -1);
    assert.equal(parcelJourneyProgress(parcelJourney()), -1);
    for (const status of ['returning', 'returned']) assert.equal(parcelJourneyProgress(parcelJourney({ ...shipment, status }, order)), -1);
    assert.equal(parcelJourneyProgress(parcelJourney({ picked: true })), 3);
    assert.equal(parcelJourneyProgress({ completed: true, currentIndex: -1 }), 3);
    assert.equal(parcelJourneyProgress(parcelJourney({ ...shipment, ...confirmed(now), arrivalAt: now + 1 }, order)), 3);
    for (const index of [0, 1, 2, 3]) assert.equal(parcelJourneyProgress({ currentIndex: index }), index);
  } finally { Date.now = original; }
});
test('快递公司只来自当前运单，不把未知占位或电商平台当品牌', () => {
  const input = { ...shipment, carrier: '  顺丰速运  ' }, original = structuredClone(input);
  assert.equal(parcelJourney(input, { ...order, platform: 'jd', carrier: '京东物流' }).carrier, '顺丰速运');
  assert.deepEqual(input, original);
  assert.equal(parcelJourney({ carrier: 'DHL Express' }).carrier, 'DHL Express');
  for (const carrier of [undefined, null, 37, {}, '', '  ', 'Unknown', '未知快递', '未知物流', '快递公司未知', '其他', '线上包裹', '—']) {
    assert.equal(parcelJourney({ carrier }, { ...order, platform: 'jd', carrier: '京东物流' }).carrier, '');
  }
});
