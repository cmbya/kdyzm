// Protocol evidence (public sources, inspected 2026-10-31):
// Taobao SSR stages render title/subtitle/labelDesc; the final "送至" stage is a recipient block.
// https://g.alicdn.com/code/npm/@ali/mtb-logistics-v2/1.0.46/js/p_h5-detail-index.js
// Taobao transit_step.do returns expressId, expressName, address:[{place,time}] (GBK).
// https://raw.githubusercontent.com/YUNXI-fi/Pickup-Code-Display/034aad94559e8448644f4670408412ba7222a10d/app/server/taobao.js
// PDD order page getExpressData uses GET order/{sn}/shipping, query_type=2, entry_source=2, ts.
// Its shipping.traces expose info, displayTime/time, timestamp/timeStamp after snake_case conversion.
// https://static.pddpic.com/assets/js/react_order_96cc80d6b098f9c948e4.js
// HTTP base URL is location.origin + '/proxy/api/' (not '/proxy/api/api/' for order/... paths).
// https://static.pddpic.com/assets/js/react_pdd_1f39d1dc7c9162e89c34.js
// Taobao detailv2 POST and order-info fields.labels[{name,value}] renderer:
// https://g.alicdn.com/code/npm/@ali/tb-trade-odetail/0.0.330/js/p_h5-home.js
// The label text is server-provided. Only an explicit creation/order label is accepted;
// payment/shipping/receipt labels and unlabeled dates never qualify as the order date.

import './logistics-rules.js';
const logistics = globalThis.PickCodeLogistics;
const text = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
export const shortText = (value, limit) => text(value).slice(0, limit);

export function taobaoDetailDate(data, timestamp) {
  const cells = data?.data;
  if (!cells || typeof cells !== 'object') return 0;
  for (const cell of Object.values(cells)) {
    for (const label of Array.isArray(cell?.fields?.labels) ? cell.fields.labels : []) {
      if (!/^(?:创建时间|下单时间)[:：]?$/.test(text(label?.name))) continue;
      const value = text(label.value);
      if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(value)) continue;
      const date = timestamp(value);
      if (date) return date;
    }
  }
  return 0;
}

export function logisticsTimestamp(value, timestamp) {
  const raw = text(value);
  // Never assign a fabricated year to platform labels such as "10-30 12:45" or "今天".
  if (/^\d{10,13}$/.test(raw)) return timestamp(value);
  const normalized = raw.replace(/年|月|\//g, '-').replace('日', '').replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(normalized)) return 0;
  return timestamp(/Z$|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}${normalized.length === 10 ? 'T00:00:00' : ''}+08:00`);
}

export function logisticsTimePrecision(value) {
  const raw = text(value);
  if (/^\d{10,13}$/.test(raw)) return 'second';
  if (/^\d{4}[-年/]\d{2}[-月/]\d{2}日?[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?$/.test(raw)) return 'second';
  if (/^\d{4}[-年/]\d{2}[-月/]\d{2}日?[ T]\d{2}:\d{2}(?:Z|[+-]\d{2}:?\d{2})?$/.test(raw)) return 'minute';
  return 'unknown';
}

export function providerEventFields(event) {
  if (event?.provider !== 'pdd') return {};
  const fields = { provider: 'pdd' };
  for (const [key, limit] of [['providerStatus', 64], ['providerStatusTag', 120], ['providerSubStatus', 64], ['providerStatusText', 120]]) {
    if (typeof event[key] === 'string' && event[key].trim()) fields[key] = event[key].trim().slice(0, limit);
  }
  return fields;
}

export function mergeProviderEventFields(target, source) {
  const fields = providerEventFields(source);
  // Incoming records come first; never splice conflicting historical status fields into their evidence.
  if (Object.keys(fields).some(key => target[key] && target[key] !== fields[key])) return;
  Object.assign(target, fields);
}

export function normalizeLogisticsEvents(events, timestamp) {
  const seen = new Map(), output = [];
  for (const event of events.slice(0, 2000)) {
    const normalized = {
      time: logisticsTimestamp(event.time, timestamp),
      timeText: shortText(event.timeText ?? event.time, 100),
      description: shortText(event.description, 600),
      location: shortText(event.location, 120),
      timePrecision: ['second', 'minute', 'unknown'].includes(event.timePrecision) ? event.timePrecision : logisticsTimePrecision(event.time),
      ...providerEventFields(event),
    };
    if (!normalized.description) continue;
    const key = JSON.stringify([normalized.time, normalized.time ? '' : normalized.timeText, normalized.description, normalized.location]);
    if (seen.has(key)) { mergeProviderEventFields(seen.get(key), normalized); continue; }
    seen.set(key, normalized); output.push(normalized);
  }
  // Stable sorting keeps unknown timestamps in their original relative order.
  output.sort((a, b) => b.time - a.time);
  return { events: output.slice(0, 100), truncated: events.length > 2000 || output.length > 100 };
}

export function taobaoStageEvents(stages, timestamp, stageText) {
  const result = normalizeLogisticsEvents(stages.slice(0, 2001).filter(stage => stage && !/^送至/.test(text(stage.title))).map(stage => ({
    time: stage.time || stage.date || stage.occurTime || stage.subtitle,
    timeText: stage.time || stage.date || stage.occurTime || stage.subtitle,
    description: [text(stage.title), stageText(stage)].filter(Boolean).join('：'),
  })), timestamp);
  result.truncated ||= stages.length > 2000;
  return result;
}

export function taobaoTransitEvents(data, timestamp) {
  return normalizeLogisticsEvents(data.address.slice(0, 2001).map(step => ({ time: step.time, description: step.place })), timestamp);
}

export function pddShippingEvents(shipping, timestamp) {
  return normalizeLogisticsEvents(shipping.traces.slice(0, 2001).map(trace => ({
    time: trace.timestamp || trace.time_stamp || trace.timeStamp || trace.time,
    timeText: trace.display_time || trace.displayTime || trace.time || trace.timestamp || trace.time_stamp || trace.timeStamp,
    description: trace.info,
    provider: 'pdd',
    providerStatus: trace.status,
    providerStatusTag: trace.status_tag ?? trace.statusTag,
    providerSubStatus: trace.sub_status ?? trace.subStatus,
    providerStatusText: trace.trace_status_tip ?? trace.traceStatusTip,
  })), timestamp);
}

export const homeDeliveryCompleted = logistics.homeDeliveryCompleted;
export const genericPickupStation = logistics.genericPickupStation;
export const pickupCycleReset = logistics.pickupCycleReset;
export const pickupStation = logistics.pickupStation;
export const pickupArrivalEvent = logistics.pickupArrivalEvent;
export const pickupEvidence = logistics.pickupEvidence;
export const eventStatus = logistics.eventStatus;

export function activeKnownParcels(order) {
  if (order?.archived || order?.hidden || order?.deleted) return [];
  return (Array.isArray(order?.shipments) ? order.shipments : []).filter(parcel => text(parcel?.waybillNo) && !parcel.picked && !parcel.hidden && !parcel.deleted && !parcel.archived);
}

export function activeKnownOrders(orders, seen, limit = 20) {
  return orders.filter(order => !seen.has(String(order.platformOrderId)) && activeKnownParcels(order).length)
    .sort((a, b) => Math.min(...activeKnownParcels(a).map(parcel => parcel.logisticsCheckedAt || 0)) - Math.min(...activeKnownParcels(b).map(parcel => parcel.logisticsCheckedAt || 0)))
    .slice(0, limit);
}
