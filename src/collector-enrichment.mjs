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

export function normalizeLogisticsEvents(events, timestamp) {
  const seen = new Set(), output = [];
  for (const event of events.slice(0, 2000)) {
    const normalized = {
      time: logisticsTimestamp(event.time, timestamp),
      timeText: shortText(event.timeText ?? event.time, 100),
      description: shortText(event.description, 600),
      location: shortText(event.location, 120),
      timePrecision: ['second', 'minute', 'unknown'].includes(event.timePrecision) ? event.timePrecision : logisticsTimePrecision(event.time),
    };
    if (!normalized.description) continue;
    const key = JSON.stringify(normalized);
    if (seen.has(key)) continue;
    seen.add(key); output.push(normalized);
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
  })), timestamp);
}

export function homeDeliveryCompleted(description) {
  return /已(?:经)?(?:成功)?(?:送达|妥投)|妥投成功|已(?:经)?(?:送(?:到|至)|派送(?:到|至)|投递(?:到|至)|放(?:在|到|至)?)[^，,。；;！？!?]{0,12}门口|(?:^|[：:\s])(?:送达|妥投)(?:$|[：:\s])/.test(description)
    && !/(?:未|待|等待|预计|预定|计划|将|请|要求|希望|安排|同意|约定)[^，,。；;！？!?]{0,12}(?:送达|妥投|送到|送至|投递|放)/.test(description)
    && !/(?:送达|妥投|派送|投递)[^，,。；;！？!?]{0,8}(?:失败|未成功)/.test(description);
}

const PICKUP_POINT = /驿站|代收点|自提点|自提站|自提柜|快递柜|智能柜|丰巢|菜鸟|门店|便利店/;
export const genericPickupStation = value => /^(?:菜鸟驿站|驿站|代收点|自提点|自提站|自提柜|快递柜|智能柜|丰巢|丰巢快递柜|快递代收点|代收站|快递站)$/.test(text(value).replace(/[\s\p{P}]/gu, ''));
const ARRIVAL_ACTION = /存入|存放(?:至|到|在)|已(?:经)?(?:成功)?到达?|到达|送(?:达|到|至)|派送(?:到|至)|妥投(?:至|到)|投递(?:至|到)|放(?:在|到|至)/;
const FUTURE_STATION = /下一站|发往|运往|开往|前往|将(?:到|达|至)|目的(?:地|站)|即将/;
const UNREALIZED = /预计|预定|计划|将(?:于|在|送|到|存)|尚未|未(?:能|曾)?(?:到|送|投|存|放)|失败|未成功|无法|未能|(?:请|要求|希望|安排|同意|约定|等待)[^，,。；;！？!?]{0,12}(?:存放|存入|到达|送达|送到|送至|投递|放)/;
export const pickupCycleReset = description => /退回|退件|退货|退签|拒签|拒绝?签收|改投|改派|转投|重新(?:派送|投递|揽收)|取出(?:了)?(?:快递柜|自提柜)|离开[^，,。；;！？!?]*(?:驿站|代收点|快递柜)/.test(description);

export function pickupStation(description) {
  const value = text(description);
  if (UNREALIZED.test(value) || pickupCycleReset(value)) return '';
  const clean = candidate => {
    const raw = text(candidate);
    const bracket = raw.match(/^[【「“]([^】」”]+)[】」”](\s*[A-Za-z0-9一二三四五六七八九十]+号柜)?/);
    const station = (bracket ? bracket[1] + (bracket[2] || '') : raw).replace(/^[【「“\s]+|[】」”\s]+$/g, '')
      .split(/(?:[，,。；;！？!?]|请|取件码|取货码|提货码|凭码|等待取件|待取件|已签收|已代收|联系电话|电话)/)[0].trim();
    return station && !/分拣|转运|分拨|物流中心|营业部|家门口|家中|收件人|本人/.test(station)
      && (PICKUP_POINT.test(station) || /店$/.test(station)) ? station : '';
  };
  for (const fragment of value.split(/[，,。；;！？!?\n]/)) {
    // A destination belongs to its own action; later route destinations are not arrivals.
    const current = fragment.split(FUTURE_STATION)[0];
    const destination = current.match(/(?:存放(?:至|到|在)|存入|已(?:经)?(?:成功)?到达?|到达|送达|送到|送至|派送到|派送至|投递至|投递到|放在|放到|放至|妥投至|妥投到)[：:\s]*(.+)/)?.[1];
    const location = current.match(/(?:仍在|暂存于|存放于|位于|已在|在|请(?:您)?(?:及时|尽快)?(?:到|至))[：:\s]*(.+)/)?.[1];
    const receipt = current.match(/由(.+?)(?:已(?:签收|代收)|代收)/)?.[1]
      || current.match(/(?:^|[：:])([^：:]+?)(?:已(?:签收|代收)|代收|等待取件|待取件)/)?.[1];
    const station = clean(destination) || clean(location) || clean(receipt);
    if (station) return station;
  }
  return '';
}

export function pickupArrivalEvent(description, stationHint = '') {
  const value = text(description);
  if (!value || UNREALIZED.test(value) || pickupCycleReset(value) || /催取|提醒|再次通知|尽快|逾期|滞留|超时/.test(value)) return false;
  const atStation = value.split(/[，,。；;！？!?\n]/).some(fragment => {
    const current = fragment.split(FUTURE_STATION)[0];
    const station = pickupStation(current);
    return !!station && (PICKUP_POINT.test(station) || /取件|取货|自提|代收/.test(current))
      && (ARRIVAL_ACTION.test(current) || /代收|已签收/.test(current));
  });
  const terminalStatus = !FUTURE_STATION.test(value) && !/转运|分拣|分拨|物流中心/.test(value)
    && ((!!stationHint && PICKUP_POINT.test(stationHint) && /^(?:签收|已签收|签收成功)(?:[:：\s]|$)/.test(value))
      || /^(?:待取件|已到站|到站|已入柜|入柜|待自提)(?:[:：\s]|$)/.test(value));
  return atStation || terminalStatus;
}

export function pickupEvidence(events) {
  const empty = { arrivalAt: 0, arrivalAtSource: 'unknown', arrivalAtPrecision: 'unknown', station: '', stationSource: 'unknown' };
  // An undated redirect cannot be ordered against dated history, so old arrivals are unsafe.
  if (events.some(event => !event.time && pickupCycleReset(text(event.description)))) return empty;
  let station = '';
  for (const event of events) {
    const description = text(event.description);
    if (pickupCycleReset(description)) break;
    const describedStation = pickupStation(description);
    const cardStation = event.station ? pickupStation(`已存放至${event.station}`) : '';
    const candidate = !describedStation || genericPickupStation(describedStation)
      ? cardStation || describedStation : describedStation;
    const arrival = pickupArrivalEvent(description, candidate);
    if (candidate && (arrival || /取件|取货|自提|代收/.test(description))) station ||= candidate;
    if (!arrival) continue;
    if (station && candidate && station.replace(/[\s\p{P}]/gu, '') !== candidate.replace(/[\s\p{P}]/gu, '')) break;
    station ||= candidate;
    if (!event.time) continue;
    return { arrivalAt: event.time, arrivalAtSource: 'platform_event',
      arrivalAtPrecision: ['second', 'minute', 'unknown'].includes(event.timePrecision) ? event.timePrecision : logisticsTimePrecision(event.timeText),
      station, stationSource: station ? 'platform_event' : 'unknown' };
  }
  return { ...empty, station, stationSource: station ? 'platform_event' : 'unknown' };
}

export function eventStatus(description, fallback = 'unknown') {
  if (!UNREALIZED.test(description) && !pickupCycleReset(description) && /(?:存入|已(?:经)?(?:成功)?(?:存放至|到达?|送(?:达|到|至)|派送(?:到|至)|妥投(?:至|到)?|投递(?:至|到)|放(?:在|到|至)?))[^，,。；;！？!?]*(?:驿站|代收点|柜|丰巢)|(?:驿站|代收点|自提柜|快递柜)代收/.test(description)) return 'arrived';
  if (homeDeliveryCompleted(description)) return 'signed';
  if (!UNREALIZED.test(description) && !pickupCycleReset(description) && /待取件|等待取件|待自提|已存放至|存入.*(?:柜|驿站)|请(?:您)?(?:及时|尽快)?(?:取件|领取)|催取|取件提醒|凭取货码/.test(description)) return 'arrived';
  if (/已完成签收|签收成功|已签收/.test(description) && !/签收失败|拒绝?签收|拒签/.test(description)
    && !/(?:未|待|拒绝?|请|等待|当面)[^，,。；;！？!?]{0,8}(?:已完成签收|签收成功|已签收)/.test(description)) return 'signed';
  if (/运输|发货|揽收|派送|派件中/.test(description)) return 'transit';
  return fallback;
}

export function activeKnownParcels(order) {
  return (Array.isArray(order?.shipments) ? order.shipments : []).filter(parcel => text(parcel?.waybillNo) && !parcel.picked && !parcel.hidden && parcel.status !== 'signed');
}

export function activeKnownOrders(orders, seen, limit = 20) {
  return orders.filter(order => !seen.has(String(order.platformOrderId)) && activeKnownParcels(order).length)
    .sort((a, b) => Math.min(...activeKnownParcels(a).map(parcel => parcel.logisticsCheckedAt || 0)) - Math.min(...activeKnownParcels(b).map(parcel => parcel.logisticsCheckedAt || 0)))
    .slice(0, limit);
}
