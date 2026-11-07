import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pddShippingEvents, normalizeLogisticsEvents } from '../src/collector-enrichment.mjs';
import { timestamp } from '../src/collectors.mjs';
import { Store } from '../src/store.mjs';

const NOW = 1794100000000;
const raw = { timestamp: 1794068093, info: '包裹已放到示例驿站，请及时取件', status: 'OUT_CABINET', status_tag: '已取件', sub_status: 'OUT_CABINET_501', trace_status_tip: '已签收' };
const metadata = { provider: 'pdd', providerStatus: 'OUT_CABINET', providerStatusTag: '已取件', providerSubStatus: 'OUT_CABINET_501', providerStatusText: '已签收' };
const inspect = event => Object.fromEntries(Object.keys(metadata).map(key => [key, event[key]]));

test('same-time same-description events in different locations retain separate histories and metadata', () => {
  const first = { time: NOW - 1000, description: '到达转运中心', location: '甲市' }, second = { ...first, location: '乙市' };
  const enriched = { ...first, ...metadata };
  const events = normalizeLogisticsEvents([first, second, enriched], timestamp).events;
  assert.equal(events.length, 2); assert.deepEqual(inspect(events[0]), metadata);
  assert.equal(events[1].location, '乙市'); assert.equal(events[1].provider, undefined);
  const store = new Store({ key: Buffer.alloc(32, 6), now: () => NOW });
  try {
    store.saveAccount({ platform: 'pdd', label: '合成账号', cookie: 'fixture' }, 'account', true);
    const sync = logisticsEvents => store.importResult('account', { orders: [{ platformOrderId: 'synthetic-order' }], shipments: [{ platformOrderId: 'synthetic-order', waybillNo: 'SYNTHETIC-ONLY', status: 'transit', logisticsState: 'ok', logisticsCheckedAt: NOW, logisticsEvents }] });
    sync([first, second]); sync([enriched]);
    const rows = store.snapshot(['account']).shipments[0].logisticsEvents;
    assert.equal(rows.length, 2); assert.deepEqual(inspect(rows.find(row => row.location === '甲市')), metadata);
    assert.equal(rows.find(row => row.location === '乙市').provider, undefined);
  } finally { store.close(); }
});

test('PDD snake/camel structured status survives normalization without rewriting the raw description', () => {
  for (const trace of [raw, { timestamp: raw.timestamp, info: raw.info, status: raw.status, statusTag: raw.status_tag, subStatus: raw.sub_status, traceStatusTip: raw.trace_status_tip }]) {
    const event = pddShippingEvents({ traces: [trace] }, timestamp).events[0];
    assert.deepEqual(inspect(event), metadata); assert.equal(event.description, raw.info); assert.equal(event.time, raw.timestamp * 1000);
    const legacy = { time: event.time, timeText: '旧显示', description: raw.info };
    for (const pair of [[legacy, event], [event, legacy]]) {
      const merged = normalizeLogisticsEvents(pair, timestamp).events;
      assert.equal(merged.length, 1); assert.deepEqual(inspect(merged[0]), metadata);
    }
  }
});

test('structured status fields reject other providers and nonstrings, bound lengths, and never mix conflicting event evidence', () => {
  const event = { time: NOW, description: '合成原文', ...metadata };
  const conflict = { ...event, providerStatus: 'IN_CABINET', providerStatusTag: '待取件', providerSubStatus: 'IN_CABINET_401' };
  assert.deepEqual(inspect(normalizeLogisticsEvents([event, conflict], timestamp).events[0]), metadata);
  const rows = normalizeLogisticsEvents([{ ...event, provider: 'other' }, { ...event, time: NOW - 1, providerStatus: 123, providerStatusTag: {}, providerSubStatus: 'X'.repeat(200), providerStatusText: '文'.repeat(300), credential: 'never-export' }], timestamp).events;
  assert.equal(rows[0].provider, undefined); assert.equal(rows[0].providerStatus, undefined);
  assert.equal(rows[1].providerStatus, undefined); assert.equal(rows[1].providerStatusTag, undefined);
  assert.equal(rows[1].providerSubStatus.length, 64); assert.equal(rows[1].providerStatusText.length, 120);
  assert.equal(JSON.stringify(rows).includes('never-export'), false);
});

test('metadata upgrades old timeline rows, survives SQLite reopen and snapshot, and is retained after legacy refresh', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pdd-event-metadata-')), filename = join(directory, 'fixture.sqlite'), key = Buffer.alloc(32, 7);
  let clock = NOW, store = new Store({ filename, key, now: () => clock });
  try {
    store.saveAccount({ platform: 'pdd', label: '合成账号', cookie: 'fixture' }, 'account', true);
    const event = pddShippingEvents({ traces: [raw] }, timestamp).events[0], legacy = { time: event.time, description: raw.info };
    const sync = events => store.importResult('account', { orders: [{ platformOrderId: 'synthetic-order' }], shipments: [{ platformOrderId: 'synthetic-order', waybillNo: 'SYNTHETIC-ONLY', status: 'transit', logisticsState: 'ok', logisticsCheckedAt: clock++, logisticsEvents: events }] });
    sync([legacy]); sync([event]); sync([legacy]);
    store.close(); store = new Store({ filename, key, now: () => clock });
    const snapshot = store.snapshot(['account']), events = snapshot.shipments[0].logisticsEvents;
    assert.equal(events.length, 1); assert.equal(events[0].description, raw.info); assert.deepEqual(inspect(events[0]), metadata);
    assert.equal(snapshot.schemaVersion, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
