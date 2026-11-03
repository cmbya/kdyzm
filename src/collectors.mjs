// Adapted from YUNXI-fi/Pickup-Code-Display, commit 034aad94559e8448644f4670408412ba7222a10d.
// Copyright (c) 2026. Non-commercial license: ../licenses/Pickup-Code-Display-LICENSE.txt.
// This adapter intentionally does not inherit upstream's automatic "picked" transitions.
import { createHash } from 'node:crypto';
import { activeKnownOrders, activeKnownParcels, eventStatus, homeDeliveryCompleted, logisticsTimestamp, logisticsTimePrecision, normalizeLogisticsEvents, pddShippingEvents, pickupCycleReset, pickupEvidence, taobaoDetailDate, taobaoStageEvents, taobaoTransitEvents } from './collector-enrichment.mjs';

const APPKEY = '12574478';
const UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/105.0.0.0 Mobile Safari/537.36';
const HOSTS = new Set(['h5api.m.taobao.com', 'pages-g.m.taobao.com', 'buyertrade.taobao.com', 'mobile.yangkeduo.com', 'api.m.jd.com']);
const CARRIERS = { YTO: '圆通速递', ZTO: '中通快递', STO: '申通快递', YUNDA: '韵达速递', SF: '顺丰速运', EMS: 'EMS', JD: '京东物流', JTSD: '极兔速递', HTKY: '百世快递', YZPY: '邮政快递包裹' };

export class CollectorError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const expired = () => { throw new CollectorError('ACCOUNT_EXPIRED', '平台登录态已失效，请在后台更新 Cookie'); };
const upstream = () => { throw new CollectorError('UPSTREAM_ERROR', '平台接口暂不可用，请稍后重试'); };
const asText = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';

export function timestamp(value) {
  if (!value) return 0;
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const n = Number(value);
    return n < 100000000000 ? n * 1000 : n;
  }
  // Platform timestamps without an offset are China local time, regardless of the server TZ.
  const normalized = String(value).replace(/年|月/g, '-').replace('日', '').trim();
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(normalized) ? `${normalized.replace(' ', 'T')}+08:00` : normalized;
  return Date.parse(iso) || 0;
}

export async function platformRequest(url, cookie, { fetchImpl = fetch, method = 'GET', body, headers = {}, encoding = 'utf-8' } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !HOSTS.has(target.hostname)) throw new CollectorError('INVALID_UPSTREAM', '不支持的平台接口');
  const response = await fetchImpl(url, { method, body, redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'zh-CN,zh;q=0.9', Cookie: cookie, ...headers } });
  if ([401, 403].includes(response.status)) {
    if (response.status === 401) expired();
    throw new CollectorError('UPSTREAM_BLOCKED', '平台拒绝访问或触发风控，请稍后重试');
  }
  if (!response.ok) upstream();
  const limit = 5 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) upstream();
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) { size += chunk.length; if (size > limit) { upstream(); } chunks.push(chunk); }
  return { text: new TextDecoder(encoding).decode(Buffer.concat(chunks)), headers: response.headers };
}
function json(text) {
  try { return JSON.parse(text); } catch { throw new CollectorError('UPSTREAM_FORMAT', '平台返回结构已变化，保留上次成功数据'); }
}
function withCookies(cookie, headers) {
  const values = new Map(cookie.split(';').map(v => { const i = v.indexOf('='); return [v.slice(0, i).trim(), v.slice(i + 1).trim()]; }));
  for (const raw of headers.getSetCookie?.() || []) {
    const pair = raw.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) values.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return [...values].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function mtop(session, data, pc = false, detail = false) {
  const api = detail ? 'mtop.taobao.order.query.detailv2' : pc ? 'mtop.taobao.order.queryboughtlistV2' : 'mtop.taobao.order.queryboughtlistv2';
  const base = `https://h5api.m.taobao.com/h5/${api}/1.0/`;
  const headers = { Origin: 'https://h5.m.taobao.com', Referer: 'https://h5.m.taobao.com/' };
  if (!session.refreshed) {
    const response = await platformRequest(`${base}?appKey=${APPKEY}`, session.cookie, { fetchImpl: session.fetchImpl, headers });
    session.cookie = withCookies(session.cookie, response.headers);
    session.refreshed = true;
  }
  const token = session.cookie.match(/(?:^|;\s*)_m_h5_tk=([^;]+)/)?.[1].split('_')[0];
  if (!token) expired();
  const t = String(session.now());
  const raw = JSON.stringify(data);
  const sign = createHash('md5').update(`${token}&${t}&${APPKEY}&${raw}`).digest('hex');
  const post = pc || detail;
  const qs = new URLSearchParams({ jsv: '2.7.2', appKey: APPKEY, t, sign, v: '1.0', api, type: post ? 'originaljson' : 'jsonp', dataType: post ? 'json' : 'jsonp' });
  if (post) {
    Object.entries({ ecode: '1', timeout: '8000', valueType: 'original', ttid: detail ? '201200@taobao_h5_9.18.0' : '201200@taobao_iphone_99.99.99', needLogin: 'true', isHttps: '1', needRetry: 'true', preventFallback: 'true' }).forEach(([k, v]) => qs.set(k, v));
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else qs.set('data', raw);
  const response = await platformRequest(`${base}?${qs}`, session.cookie, { fetchImpl: session.fetchImpl, headers, method: post ? 'POST' : 'GET', body: post ? `data=${encodeURIComponent(raw)}` : undefined });
  session.cookie = withCookies(session.cookie, response.headers);
  const content = response.text.trim();
  const parsed = json(content.startsWith('{') ? content : content.slice(content.indexOf('(') + 1, content.lastIndexOf(')')));
  const ret = Array.isArray(parsed.ret) ? parsed.ret.join(' ') : asText(parsed.retCode || parsed.ret);
  if (/SESSION_EXPIRED|TOKEN_EXOIRED|TOKEN_EXPIRED|NEED_LOGIN/.test(ret)) expired();
  if (ret && !ret.includes('SUCCESS')) upstream();
  if (!parsed.data || !Object.keys(parsed.data).length) {
    if (detail) throw new CollectorError('UPSTREAM_FORMAT', '平台未返回可解析订单详情');
    expired();
  }
  return parsed.data;
}

export function extractSsrFields(html) {
  const marker = "__ICE_SUSPENSE_LOADER__']['undefined'] = ";
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf('{', at + marker.length);
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      const data = json(html.slice(start, i + 1)).result?.data;
      return (data?.newLogistics || data?.logisticsDetailH5)?.fields || null;
    }
  }
  return null;
}
function stageText(stage) {
  const label = stage.labelDesc;
  return Array.isArray(label?.richContent) ? label.richContent.map(r => r.text || '').join('') : typeof label === 'string' ? label : label?.text || stage.text || '';
}
function codeOf(value) { return value.match(/(?:取件码|取货码|提货码|自提码)\s*(?:是|为)?\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9-]{3,15})/)?.[1] || ''; }
function arrivalEvidence(value, rules) { return eventStatus(value, 'unknown', rules) === 'arrived'; }
function applyTrackEvidence(parcel, events, rules) {
  const evidence = pickupEvidence(events, rules);
  const reset = events.some(event => pickupCycleReset(event.description) && (!event.time || !parcel.arrivalAt || event.time >= parcel.arrivalAt));
  const stationConflict = evidence.station && parcel.station
    && evidence.station.replace(/[\s\p{P}]/gu, '') !== parcel.station.replace(/[\s\p{P}]/gu, '');
  if (evidence.arrivalAt || reset || stationConflict || !parcel.arrivalAt) Object.assign(parcel, evidence);
  else if (!parcel.station && evidence.station) Object.assign(parcel, { station: evidence.station, stationSource: evidence.stationSource });
  if (reset) parcel.pickupCode = '';
}

const TO_SHIP_TRADE_STATUS = 'WAIT_SELLER_SEND_GOODS';
const IN_TRANSIT_TRADE_STATUS = 'WAIT_BUYER_CONFIRM_GOODS';
const DONE_STATUS_TEXT = /(?<!待|未|拒)签收|拒签|交易成功|交易完成|交易关闭|已完成|已取消|失败|待付款|未付款|退款|退货/;
const TO_SHIP_STATUS_TEXT = /待发货|等待卖家发货|待卖家发货/;
const IN_TRANSIT_STATUS_TEXT = /待收货|已发货|运输中|派送中|派件中|物流派件中|待取件|物流中|已到达/;

function taobaoOrderInfo(order) {
  const platformOrderId = asText(order.id || order.orderId);
  const tradeStatus = asText(order.tradeStatus || order.extra?.tradeStatus || order.statusInfo?.tradeStatus);
  const orderStatus = asText(order.statusText || order.statusInfo?.text || order.extra?.statusText || order.extra?.tradeStatus);
  const orderDate = timestamp(order.createTime || order.orderTime || order.extra?.createTime);
  const rawAmount = order.payInfo?.actualFee ?? order.payInfo?.actualPay;
  const amount = rawAmount != null && /^\d+(?:\.\d+)?$/.test(String(rawAmount)) ? Number(rawAmount) : null;
  const title = (order.subOrders || []).map(s => s.itemInfo?.title || '').filter(Boolean).join(' / ');
  return { platformOrderId, tradeStatus, orderStatus, orderDate, amount, title, refundStatus: asText(order.refundStatus) };
}

function taobaoOrderKind({ tradeStatus, orderStatus }) {
  if (DONE_STATUS_TEXT.test(orderStatus)) return 'skip';
  if (tradeStatus === TO_SHIP_TRADE_STATUS) return 'to_ship';
  if (tradeStatus === IN_TRANSIT_TRADE_STATUS) return 'in_transit';
  if (tradeStatus) return 'skip';
  if (TO_SHIP_STATUS_TEXT.test(orderStatus)) return 'to_ship';
  if (IN_TRANSIT_STATUS_TEXT.test(orderStatus)) return 'in_transit';
  return 'skip';
}

export function taobaoParcels(fields, platformOrderId, fallbackCode = '', rules) {
  const packages = fields.multiPackages?.packages || [];
  const baseNo = asText(fields.mailNo || fields.logisticCompany?.mailNo);
  const sources = packages.length ? packages.filter(p => p?.mailNo).map(p => ({ ...p, mailNo: asText(p.mailNo) })) : baseNo ? [{ mailNo: baseNo }] : [];
  return sources.map(parcel => {
    // A parent-level code is unsafe to copy onto every split shipment.
    const specific = parcel.fields || (parcel.multiStage ? parcel : null);
    const selected = specific || (sources.length === 1 || parcel.mailNo === baseNo ? fields : {});
    const stages = Array.isArray(selected.multiStage) ? selected.multiStage : [];
    let pickupCode = '', arrived = false;
    for (const stage of stages) {
      const content = stageText(stage);
      if (pickupCycleReset(`${stage.title || ''} ${content}`)) break;
      const card = stage.cardDesc || {};
      const code = asText(card.custom?.expressCode?.code) || codeOf(content);
      pickupCode ||= code;
      if (arrivalEvidence(`${stage.title || ''} ${content}`, rules)) arrived = true;
    }
    if (!pickupCode && sources.length === 1 && !stages.some(stage => pickupCycleReset(`${stage.title || ''} ${stageText(stage)}`))) pickupCode = fallbackCode;
    // A current structured collection code is itself evidence that the parcel is at a pickup point.
    arrived ||= !!pickupCode;
    const latest = `${stages[0]?.title || ''} ${stages[0] ? stageText(stages[0]) : ''}`;
    // The first stage is the platform's current event. A current station pickup
    // notice wins over generic "signed" wording; otherwise a current signature
    // supersedes older arrival/code evidence while that evidence is retained.
    const latestCard = stages[0]?.cardDesc || {};
    const latestCardText = `${latestCard.title || ''} ${latestCard.subTitle || ''}`;
    const latestStructuredPickup = !!latestCard.custom?.expressCode?.code || /驿站|代收点|代收|自提柜|快递柜|丰巢/.test(latestCardText);
    const latestAtPickupPoint = latestStructuredPickup || arrivalEvidence(latest, rules);
    const latestTitle = asText(stages[0]?.title).trim();
    const latestBody = stages[0] ? stageText(stages[0]) : '';
    const latestTransitTitle = /运输|发货|揽收|派送|派件中/.test(latestTitle);
    const latestTransit = latestTransitTitle || /运输|发货|揽收|派送|派件中/.test(latestBody);
    const latestBodySigned = /已完成签收|签收成功|已签收/.test(latestBody)
      && !/(?:未|待|拒绝?|请|等待|当面)[^，,。；;！？!?]{0,8}(?:已完成签收|签收成功|已签收)/.test(latestBody);
    const latestSigned = homeDeliveryCompleted(latest) || (!latestTransitTitle && /^(?:签收|已签收|签收成功)$/.test(latestTitle)) || (!latestTransitTitle && latestBodySigned);
    const status = latestAtPickupPoint ? 'arrived' : latestSigned ? 'signed' : latestTransit ? 'transit' : arrived ? 'arrived' : 'unknown';
    const { events: logisticsEvents, truncated: logisticsTruncated } = taobaoStageEvents(stages, timestamp, stageText);
    const evidence = pickupEvidence(stages.filter(stage => stage && !/^送至/.test(asText(stage.title))).map(stage => {
      const rawTime = stage.time || stage.date || stage.occurTime || stage.subtitle;
      const description = `${stage.title || ''}：${stageText(stage)}`;
      return { time: logisticsTimestamp(rawTime, timestamp), timePrecision: logisticsTimePrecision(rawTime), description,
        station: arrivalEvidence(description, rules) ? [stage.cardDesc?.title, stage.cardDesc?.subTitle].filter(Boolean).join(' ') : '' };
    }), rules);
    return { platformOrderId, waybillNo: parcel.mailNo, carrier: asText(parcel.cpName || CARRIERS[parcel.cpCode] || selected.logisticCompany?.name || parcel.cpCode),
      pickupCode, ...evidence, status, logisticsEvents, logisticsTruncated,
      logisticsState: logisticsEvents.length ? 'ok' : specific || selected === fields ? 'empty' : 'unavailable' };
  });
}

async function collectTaobao(cookie, { fetchImpl, now, maxPages, trackedOrderIds = [], knownOrders = [], targetOrder, rules }) {
  const session = { cookie, fetchImpl, now };
  const orders = [], shipments = [], orderUpdates = [], warnings = [], logisticsFailures = [];
  const seen = new Set();
  const tracked = new Set([...trackedOrderIds, ...knownOrders.map(order => order.platformOrderId)].map(String));
  const logisticsTracked = new Set([...trackedOrderIds, ...activeKnownOrders(knownOrders, new Set(), knownOrders.length).map(order => order.platformOrderId)].map(String));
  const known = new Map(knownOrders.map(order => [asText(order.platformOrderId), order]));
  const knownParcels = id => targetOrder ? (known.get(id)?.shipments || []).filter(parcel => asText(parcel.waybillNo)) : activeKnownParcels(known.get(id));
  const supplements = [];
  let dateBudget = 10;
  let skippedCount = 0;
  const dateAttempted = new Set();
  let pickupCodes = {};
  async function enrichDate(metadata) {
    const previous = known.get(metadata.platformOrderId);
    if (dateBudget <= 0 || dateAttempted.has(metadata.platformOrderId) || (!targetOrder && (previous?.orderDateOrigin === 'detail' || (!previous && metadata.orderDate)))) return;
    const checkedAt = now();
    if (!targetOrder && previous?.dateCheckedAt && checkedAt - previous.dateCheckedAt < 24 * 60 * 60 * 1000) return;
    dateBudget--; dateAttempted.add(metadata.platformOrderId);
    metadata.dateCheckedAt = checkedAt;
    try {
      const data = await mtop(session, { appVersion: '3.0', appName: 'tborder', archive: false, from: 'OrderListActivity', useV2: 'true',
        bizOrderId: metadata.platformOrderId, extParams: JSON.stringify({ weexPage: 'neworderdetail4', isTBH5: 'true', useNewDetail: true, appChannel: '' }),
        ttid: '201200@taobao_h5_9.18.0', requestIdentity: '#t#ip#h5', condition: JSON.stringify({ version: '1.0.0' }) }, false, true);
      const orderDate = taobaoDetailDate(data, timestamp);
      Object.assign(metadata, { dateState: orderDate ? 'ok' : 'empty', dateError: orderDate ? '' : '平台详情未返回有效下单日期' });
      if (orderDate) Object.assign(metadata, { orderDate, orderDateOrigin: 'detail' });
    } catch (error) {
      if (error.code === 'ACCOUNT_EXPIRED') throw error;
      Object.assign(metadata, { dateState: 'error', dateError: error.code === 'UPSTREAM_BLOCKED' ? '平台拒绝日期查询或触发风控，请稍后重试' : '日期查询未完成，已保留原日期' });
      warnings.push('部分下单日期补查暂不可用，未用同步时间替代');
    }
  }
  async function collectLogistics(platformOrderId) {
    const checkedAt = now();
    try {
      const result = await platformRequest(`https://pages-g.m.taobao.com/wow/z/app/mtb/logisticsV2/h5-detail?x-ssr=true&bizOrderId=${encodeURIComponent(platformOrderId)}`, session.cookie, { fetchImpl });
      const fields = extractSsrFields(result.text);
      if (!fields) warnings.push('部分订单暂无可解析物流，订单仍保留');
      const parcels = taobaoParcels(fields || {}, platformOrderId, pickupCodes[platformOrderId], rules);
      // A partial split response must also record the attempt for known active
      // waybills it omits, without copying another parcel's events or pickup code.
      for (const parcel of knownParcels(platformOrderId)) {
        if (parcels.some(item => item.waybillNo === asText(parcel.waybillNo))) continue;
        parcels.push({ platformOrderId, waybillNo: asText(parcel.waybillNo), carrier: asText(parcel.carrier), status: parcel.status,
          logisticsEvents: [], logisticsState: 'unavailable', logisticsError: '平台未返回该运单轨迹' });
      }
      for (const parcel of parcels) {
        parcel.logisticsCheckedAt = checkedAt;
        if (parcel.logisticsState !== 'unavailable') parcel.logisticsUpdatedAt = checkedAt;
      }
      supplements.push({ platformOrderId, parcels });
      shipments.push(...parcels);
      if (!parcels.length) logisticsFailures.push({ platformOrderId, state: 'unavailable', logisticsCheckedAt: checkedAt });
      if (parcels.length > 1 && parcels.some(p => p.logisticsState === 'unavailable')) warnings.push('部分拆单运单仅返回单号，等待平台提供各运单物流');
    } catch (error) {
      if (error.code === 'ACCOUNT_EXPIRED') throw error;
      // Full PC tracking is independent of SSR availability, including known completed parcels on manual refresh.
      const parcels = knownParcels(platformOrderId).map(parcel => ({ platformOrderId, waybillNo: asText(parcel.waybillNo), carrier: asText(parcel.carrier), status: parcel.status,
        logisticsEvents: [], logisticsState: 'error', logisticsError: '物流摘要查询失败，已保留原轨迹', logisticsCheckedAt: checkedAt }));
      shipments.push(...parcels); supplements.push({ platformOrderId, parcels });
      if (!parcels.length) logisticsFailures.push({ platformOrderId, state: 'error', logisticsCheckedAt: checkedAt });
      warnings.push('部分订单物流读取失败，已保留原运单');
    }
  }
  if (targetOrder) {
    const platformOrderId = asText(targetOrder.platformOrderId), metadata = { platformOrderId };
    await enrichDate(metadata); orderUpdates.push(metadata);
    await collectLogistics(platformOrderId);
  } else {
    try {
      const data = await mtop(session, { tabCode: 'waitConfirm', appVersion: '3.0', OrderType: 'OrderList', condition: { inner: 1, deviceLevel: 'high', version: '1.0.0', reqFrom: 'tbpc' }, appName: 'tborder', templateConfigVersion: 0, forceBoughtlist4: 4, page: '1' }, true);
      for (const [key, cell] of Object.entries(data.data || {})) {
        if (key.startsWith('comServiceTips_')) {
          const code = codeOf((cell.fields?.singleLineRiceText || []).map(x => x.richStr || '').join(' '));
          if (code) pickupCodes[cell.id || key.slice('comServiceTips_'.length)] = code;
        }
      }
    } catch (error) {
      if (error.code === 'ACCOUNT_EXPIRED') throw error;
      warnings.push('订单列表取件码暂不可用，仍保留物流和无码运单');
    }
    for (let page = 1; page <= maxPages; page++) {
      const data = await mtop(session, { tabCode: 'all', page: String(page), orderType: 'OrderList', templateConfigVersion: '0', appName: 'tborder', appVersion: '3.0', condition: '{"version":"1.0.0","appChannel":""}', ttid: '201200@taobao_h5_9.18.0', requestIdentity: '#t#ip#h5' });
      const inner = typeof data.result === 'string' ? json(data.result) : data.result || data.data;
      if (!Array.isArray(inner?.mainOrders)) throw new CollectorError('UPSTREAM_FORMAT', '淘宝订单字段已变化，保留上次数据');
      if (!inner.mainOrders.length) break;
      let newCount = 0;
      for (const order of inner.mainOrders) {
        const info = taobaoOrderInfo(order);
        const platformOrderId = info.platformOrderId;
        if (!platformOrderId || seen.has(platformOrderId)) continue;
        newCount++; seen.add(platformOrderId);
        const kind = taobaoOrderKind(info);
        if (kind === 'skip') skippedCount++;
        const isKnown = tracked.has(platformOrderId);
        const metadata = { platformOrderId, tradeStatus: info.tradeStatus, orderStatus: info.orderStatus, orderDate: info.orderDate, ...(info.orderDate ? { orderDateOrigin: 'list' } : {}), refundStatus: info.refundStatus };
        // Rejected orders are metadata-only. A previously imported order is
        // allowed through for a detail refresh, even after it reaches a terminal
        // platform status, so an old arrival cannot remain stale forever.
        if (kind === 'skip' && !isKnown) {
          orderUpdates.push(metadata);
          continue;
        }
        await enrichDate(metadata);
        if (kind === 'skip') orderUpdates.push(metadata);
        if (kind !== 'skip') {
          orders.push({ ...metadata, title: info.title, amount: info.amount });
        }
        // Waiting for seller shipment has no useful logistics detail yet.
        if (kind === 'to_ship') continue;
        if (kind === 'skip' && !logisticsTracked.has(platformOrderId)) continue;
        await collectLogistics(platformOrderId);
      }
      if (!newCount) { warnings.push('平台分页重复，停止本轮采集并保留已有记录'); break; }
      if (page === maxPages) warnings.push('已达到分页上限；缺席订单不会标记为已取或删除');
    }
    for (const order of activeKnownOrders(knownOrders, seen)) await collectLogistics(asText(order.platformOrderId));
  }
  const lastLogisticsCheck = id => {
    const parcels = knownParcels(id);
    return parcels.length ? Math.min(...parcels.map(parcel => parcel.logisticsDetailCheckedAt || 0)) : 0;
  };
  supplements.sort((a, b) => lastLogisticsCheck(a.platformOrderId) - lastLogisticsCheck(b.platformOrderId));
  // SSR can contain only summaries. Query the full PC track even for nonempty SSR,
  // giving the oldest known attempts priority within a separate 20-order budget.
  for (const { platformOrderId, parcels } of supplements.slice(0, 20)) {
    const checkedAt = now();
    for (const parcel of parcels) Object.assign(parcel, { logisticsCheckedAt: checkedAt, logisticsDetailCheckedAt: checkedAt });
    try {
      const response = await platformRequest(`https://buyertrade.taobao.com/trade/json/transit_step.do?bizOrderId=${encodeURIComponent(platformOrderId)}`, session.cookie,
        { fetchImpl, encoding: 'gbk', headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://buyertrade.taobao.com/' } });
      const data = json(response.text);
      if (!Array.isArray(data.address)) throw new CollectorError('UPSTREAM_FORMAT', '淘宝物流轨迹字段已变化');
      // The fallback returns one expressId. Never fan its track out across a split order.
      let parcel = parcels.find(item => item.waybillNo === asText(data.expressId));
      if (!parcels.length && asText(data.expressId)) {
        parcel = { platformOrderId, waybillNo: asText(data.expressId), carrier: asText(data.expressName), status: 'unknown', logisticsEvents: [],
          logisticsState: 'empty', logisticsCheckedAt: checkedAt, logisticsDetailCheckedAt: checkedAt };
        parcels.push(parcel); shipments.push(parcel);
      }
      if (parcel) {
        const transit = taobaoTransitEvents(data, timestamp);
        const canUpdateStatus = parcel.status === 'unknown' || !parcel.logisticsEvents.length
          || (parcel.logisticsEvents.every(event => event.time > 0) && transit.events[0]?.time >= parcel.logisticsEvents[0].time);
        const combined = normalizeLogisticsEvents([...transit.events, ...parcel.logisticsEvents], timestamp);
        const events = combined.events;
        if (events.length) {
          parcel.logisticsEvents = events;
          parcel.logisticsTruncated = !!(transit.truncated || parcel.logisticsTruncated || combined.truncated);
          parcel.logisticsState = 'ok';
          parcel.logisticsError = '';
          // An undated SSR pickup notice can be newer than a dated PC event.
          // Only replace its current state when the two sources can be ordered.
          if (canUpdateStatus) parcel.status = eventStatus(events[0].description, parcel.status, rules);
          parcel.carrier ||= asText(data.expressName);
          if (canUpdateStatus) applyTrackEvidence(parcel, events, rules);
        }
        parcel.logisticsUpdatedAt = checkedAt;
        if (!events.length) { parcel.logisticsState = 'empty'; parcel.logisticsError = '平台本次未返回物流轨迹'; }
        for (let i = logisticsFailures.length - 1; i >= 0; i--) if (logisticsFailures[i].platformOrderId === platformOrderId) logisticsFailures.splice(i, 1);
      }
    } catch (error) {
      if (error.code === 'ACCOUNT_EXPIRED') throw error;
      for (const parcel of parcels) parcel.logisticsError = '完整物流查询失败，当前仅保留已有节点';
      for (const parcel of parcels.filter(item => !item.logisticsEvents.length)) {
        parcel.logisticsState = 'error';
        parcel.logisticsError = '完整物流查询失败，已保留上次轨迹';
        delete parcel.logisticsUpdatedAt;
      }
      warnings.push('部分物流轨迹补查失败，已保留上次轨迹');
    }
  }
  for (const order of (targetOrder ? [] : knownOrders).filter(item => !seen.has(asText(item.platformOrderId))).sort((a, b) => (a.dateCheckedAt || 0) - (b.dateCheckedAt || 0))) {
    if (dateBudget <= 0) break;
    const metadata = { platformOrderId: asText(order.platformOrderId) };
    await enrichDate(metadata);
    if (metadata.dateCheckedAt) orderUpdates.push(metadata);
  }
  if (skippedCount) warnings.push(`订单筛选：本轮保留${orders.length}笔，跳过${skippedCount}笔已结束或非待收货订单`);
  return { orders, shipments, orderUpdates, logisticsFailures, warnings: [...new Set(warnings)], refreshedCookie: session.cookie };
}

function pddCheck(value) {
  if (String(value.error_code) === '40001') expired();
  if (value.error_code || value.success === false) upstream();
  return value;
}
// Official orders.html bundle (2026-10-31): UI tab 2/3 -> PATH_TYPE unshipping/unreceived;
// getOrdersList uses PATH_TYPE and a separate offset per tab. Keep the existing GET transport.
// https://static.pddpic.com/assets/js/react_orders_7c4eb98c8a268eacd674.js
function pddStatusText(order) {
  return asText(order.order_status_text || order.status_text || order.order_status_prompt)
    || (/\D/.test(asText(order.order_status)) ? asText(order.order_status) : '');
}
function pddOrderKind(order, type) {
  const status = pddStatusText(order);
  const combined = asText(order.combined_order_status);
  // Official combined states: 0=Unpayed, 5=Cancelled, 10=Expired, 15=Deleted.
  // Received/refund enums do not prove pickup or a full refund; keep records returned by these active tabs.
  if (/交易成功|交易完成|交易关闭|订单已完成|订单已结束|已取消|待付款|未付款|待支付|未支付/.test(status)
    || /全额退款(?:已)?(?:成功|完成)|已全额退款/.test(`${status} ${asText(order.refund_status)}`)
    || ['0', '5', '10', '15'].includes(combined)
    || asText(order.order_status) === '2' || asText(order.pay_status) === '0') return 'skip';
  if (combined === '3' || asText(order.shipping_status) === '1' || IN_TRANSIT_STATUS_TEXT.test(status)) return 'in_transit';
  if (combined === '2' || TO_SHIP_STATUS_TEXT.test(status)) return 'to_ship';
  return type === 'unshipping' ? 'to_ship' : 'in_transit';
}
export function pddParcels(order, cabinet, rules) {
  const platformOrderId = asText(order.order_sn);
  const listed = order.shipping_list || order.express_list || order.package_list;
  const parcels = Array.isArray(listed) && listed.length ? listed : order.tracking_number ? [order] : [];
  return parcels.filter(p => p.tracking_number || p.mail_no).map(parcel => {
    const waybillNo = asText(parcel.tracking_number || parcel.mail_no);
    const cabinetMatches = parcels.length === 1 || asText(cabinet.tracking_number) === waybillNo;
    const code = cabinetMatches ? asText(cabinet.code).trim() : '';
    const statusText = asText(parcel.shipping_status_text || order.order_status_text || order.status_text);
    const status = eventStatus(statusText, /交易成功|交易完成/.test(statusText) ? 'signed' : code || (cabinetMatches && cabinet.arrival_time) ? 'arrived' : 'transit', rules);
    const arrivalTime = cabinetMatches && status === 'arrived' ? cabinet.arrival_time || cabinet.create_time : 0;
    const arrivalAt = logisticsTimestamp(arrivalTime, timestamp);
    const station = cabinetMatches && status === 'arrived' ? asText(cabinet.address) : '';
    return { platformOrderId, waybillNo, carrier: asText(parcel.shipping_name || parcel.company_name || (cabinetMatches && cabinet.companyName)),
      pickupCode: code, station, stationSource: station ? 'locker' : 'unknown', status, arrivalAt,
      arrivalAtSource: arrivalAt ? cabinet.arrival_time ? 'locker_arrival' : 'locker_created' : 'unknown',
      arrivalAtPrecision: arrivalAt ? logisticsTimePrecision(arrivalTime) : 'unknown' };
  });
}
async function collectPdd(cookie, { fetchImpl, maxPages, now, knownOrders = [], targetOrder, rules }) {
  const uid = cookie.match(/(?:^|;\s*)(?:pdd_user_id|pdduid)=([^;]+)/)?.[1];
  if (!uid) expired();
  const headers = { Referer: 'https://mobile.yangkeduo.com/orders.html' };
  const orders = [], shipments = [], orderUpdates = [], warnings = [], logisticsFailures = [];
  const seen = new Set();
  let logisticsBudget = 20;
  async function collectLogistics(platformOrderId, parcels) {
    if ((!parcels.length && !targetOrder) || logisticsBudget <= 0) return;
    logisticsBudget--;
    const checkedAt = now();
    try {
      const query = new URLSearchParams({ query_type: '2', entry_source: '2', ts: String(checkedAt) });
      const response = await platformRequest(`https://mobile.yangkeduo.com/proxy/api/order/${encodeURIComponent(platformOrderId)}/shipping?${query}`, cookie, { fetchImpl, headers });
      const shipping = pddCheck(json(response.text)).shipping;
      if (!shipping || !Array.isArray(shipping.traces)) throw new CollectorError('UPSTREAM_FORMAT', '拼多多物流轨迹字段已变化');
      const waybillNo = asText(shipping.tracking_number || shipping.trackingNumber);
      if (targetOrder && !parcels.length && waybillNo) parcels.push({ platformOrderId, waybillNo, carrier: '', status: 'unknown' });
      const target = waybillNo ? parcels.find(parcel => parcel.waybillNo === waybillNo) : parcels.length === 1 ? parcels[0] : null;
      if (!parcels.length) logisticsFailures.push({ platformOrderId, state: 'unavailable', logisticsCheckedAt: checkedAt });
      for (const parcel of parcels) {
        if (parcel !== target) {
          logisticsFailures.push({ platformOrderId, waybillNo: parcel.waybillNo, state: 'unavailable', logisticsCheckedAt: checkedAt });
          continue;
        }
        const { events, truncated } = pddShippingEvents(shipping, timestamp);
        parcel.logisticsEvents = events;
        parcel.logisticsTruncated = truncated;
        parcel.logisticsState = events.length ? 'ok' : 'empty';
        parcel.logisticsError = events.length ? '' : '平台本次未返回物流轨迹';
        parcel.logisticsCheckedAt = checkedAt;
        parcel.logisticsUpdatedAt = checkedAt;
        if (events.length) {
          parcel.status = eventStatus(events[0].description, parcel.status, rules);
          applyTrackEvidence(parcel, events, rules);
        }
      }
    } catch (error) {
      if (error.code === 'ACCOUNT_EXPIRED') throw error;
      if (!parcels.length) logisticsFailures.push({ platformOrderId, state: 'error', logisticsCheckedAt: checkedAt });
      for (const parcel of parcels) logisticsFailures.push({ platformOrderId, waybillNo: parcel.waybillNo, state: 'error', logisticsCheckedAt: checkedAt });
      warnings.push('部分物流轨迹读取失败，已保留上次轨迹');
    }
  }
  if (targetOrder) {
    const platformOrderId = asText(targetOrder.platformOrderId);
    const parcels = (targetOrder.shipments || []).filter(parcel => asText(parcel.waybillNo)).map(parcel => ({
      platformOrderId, waybillNo: asText(parcel.waybillNo), carrier: asText(parcel.carrier), status: parcel.status,
    }));
    if (parcels.length || !TO_SHIP_STATUS_TEXT.test(asText(targetOrder.orderStatus))) await collectLogistics(platformOrderId, parcels);
    const hasDate = targetOrder.orderDateSource === 'platform' && targetOrder.orderDate > 0;
    const metadata = { platformOrderId, dateCheckedAt: now(), dateState: 'unavailable',
      dateError: hasDate ? '拼多多暂不支持单单日期详情查询，已保留平台列表日期' : '拼多多暂未提供可验证的单单日期查询，日期仍待确认' };
    return { orders: [], orderUpdates: [metadata], shipments: parcels, logisticsFailures, warnings };
  }
  const listedOrders = new Map();
  for (const type of ['unshipping', 'unreceived']) {
    let offset = '';
    const rangeSeen = new Set();
    for (let page = 1; page <= maxPages; page++) {
      const query = new URLSearchParams({ pdduid: uid, page: String(page), type });
      if (offset) query.set('offset', offset);
      // A failure in either range aborts this batch; callers keep the previous successful snapshot.
      const response = await platformRequest(`https://mobile.yangkeduo.com/proxy/api/api/aristotle/order_list_v4?${query}`, cookie, { fetchImpl, headers });
      const data = pddCheck(json(response.text));
      if (!Array.isArray(data.orders)) throw new CollectorError('UPSTREAM_FORMAT', '拼多多订单字段已变化，保留上次数据');
      if (!data.orders.length) break;
      let newCount = 0;
      for (const order of data.orders) {
        const platformOrderId = asText(order.order_sn);
        if (!platformOrderId || rangeSeen.has(platformOrderId)) continue;
        newCount++; rangeSeen.add(platformOrderId); seen.add(platformOrderId);
        const previous = listedOrders.get(platformOrderId);
        const kind = pddOrderKind(order, type);
        const ranks = { to_ship: 0, in_transit: 1, skip: 2 };
        const useIncoming = !previous || ranks[kind] >= ranks[previous.kind];
        const merged = useIncoming ? { ...previous?.order, ...order } : { ...order, ...previous.order };
        const parcels = new Map((previous?.parcels || []).map(parcel => [parcel.waybillNo, parcel]));
        for (const parcel of pddParcels(order, {}, rules)) {
          const prior = parcels.get(parcel.waybillNo);
          parcels.set(parcel.waybillNo, { ...parcel, carrier: parcel.carrier || prior?.carrier || '',
            status: parcel.status === 'signed' || prior?.status === 'signed' ? 'signed' : parcel.status });
        }
        const orderStatus = pddStatusText(order) || (kind === 'to_ship' ? '待发货' : kind === 'in_transit' ? '待收货' : asText(order.order_status));
        listedOrders.set(platformOrderId, { order: merged, kind: useIncoming ? kind : previous.kind,
          orderStatus: useIncoming ? orderStatus : previous.orderStatus, parcels: [...parcels.values()] });
      }
      if (!newCount) { warnings.push(`平台${type === 'unshipping' ? '待发货' : '待收货'}分页重复，停止该范围采集并保留已有记录`); break; }
      offset = asText(data.orders.at(-1)?.offset);
      if (data.has_more === false || data.hasMore === false) break;
      if (page === maxPages) warnings.push(`已达到${type === 'unshipping' ? '待发货' : '待收货'}分页上限；缺席订单不会标记为已取或删除`);
    }
  }
  let skippedCount = 0;
  for (const [platformOrderId, { order, kind, orderStatus, parcels }] of listedOrders) {
    const metadata = { platformOrderId, title: (order.order_goods || []).map(g => g.goods_name || g.goods_title || '').filter(Boolean).join(' / '),
      amount: Number.isFinite(order.order_amount) ? order.order_amount / 100 : null, orderDate: timestamp(order.order_time || order.created_time || order.create_time),
      ...(timestamp(order.order_time || order.created_time || order.create_time) ? { orderDateOrigin: 'list' } : {}),
      orderStatus, refundStatus: asText(order.refund_status) };
    if (kind === 'skip') {
      skippedCount++; orderUpdates.push(metadata); seen.delete(platformOrderId);
      continue;
    }
    orders.push(metadata);
    if (parcels.length) {
      try {
        const response = await platformRequest(`https://mobile.yangkeduo.com/proxy/api/api/express/cabinet/${encodeURIComponent(platformOrderId)}`, cookie, { fetchImpl, headers });
        const cabinet = pddCheck(json(response.text)).result || {};
        const enriched = pddParcels({ order_sn: platformOrderId, order_status_text: orderStatus,
          shipping_list: parcels.map(parcel => ({ tracking_number: parcel.waybillNo, shipping_name: parcel.carrier,
            shipping_status_text: parcel.status === 'signed' ? '已签收' : parcel.status === 'arrived' ? '待取件' : '' })) }, cabinet, rules);
        for (let i = 0; i < parcels.length; i++) Object.assign(parcels[i], enriched[i]);
      } catch (error) {
        if (error.code === 'ACCOUNT_EXPIRED') throw error;
        warnings.push('部分驿站取件码暂不可用，无码运单继续保留');
      }
    }
    for (const parcel of activeKnownParcels(knownOrders.find(item => asText(item.platformOrderId) === platformOrderId))) {
      if (parcels.some(item => item.waybillNo === asText(parcel.waybillNo))) continue;
      parcels.push({ platformOrderId, waybillNo: asText(parcel.waybillNo), carrier: asText(parcel.carrier), status: parcel.status });
    }
    shipments.push(...parcels);
  }
  const candidates = orders.map(order => ({ platformOrderId: order.platformOrderId, parcels: shipments.filter(parcel => parcel.platformOrderId === order.platformOrderId) }));
  for (const order of activeKnownOrders(knownOrders, seen, logisticsBudget)) {
    const platformOrderId = asText(order.platformOrderId);
    const parcels = activeKnownParcels(order).map(parcel => ({
      platformOrderId, waybillNo: asText(parcel.waybillNo), carrier: asText(parcel.carrier), status: parcel.status,
    }));
    candidates.push({ platformOrderId, parcels, missingFromList: true });
  }
  const lastChecked = id => {
    const parcels = activeKnownParcels(knownOrders.find(order => asText(order.platformOrderId) === id));
    return parcels.length ? Math.min(...parcels.map(parcel => parcel.logisticsCheckedAt || 0)) : 0;
  };
  candidates.sort((a, b) => lastChecked(a.platformOrderId) - lastChecked(b.platformOrderId));
  for (const candidate of candidates) {
    if (logisticsBudget <= 0) break;
    await collectLogistics(candidate.platformOrderId, candidate.parcels);
    if (candidate.missingFromList) shipments.push(...candidate.parcels.filter(parcel => parcel.logisticsState));
  }
  if (skippedCount) warnings.push(`订单筛选：本轮保留${orders.length}笔，跳过${skippedCount}笔已结束或非待发货/待收货订单`);
  return { orders, shipments, orderUpdates, logisticsFailures, warnings: [...new Set(warnings)] };
}

function jdCheck(data) {
  // Verified PC buyer APIs return HTTP 200 with { code: 3 } after logout.
  if (String(data?.code) === '3') expired();
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CollectorError('UPSTREAM_FORMAT', '京东返回结构已变化，已保留原记录');
  if (data.success === false || (data.code != null && String(data.code) !== '0')) upstream();
  return data;
}

function jdOrderKind(order) {
  const status = asText(order.statusInfo?.orderStateName);
  // PC samples: type 4 is local services, type 69 / wareType 1 is virtual goods.
  if ([4, 69].includes(Number(order.orderType)) || order.wareList?.length && order.wareList.every(ware => Number(ware.wareType) === 1)) return 'skip';
  if (Number(order.statusInfo?.orderState) === 18 || /已完成|已签收|已取消|已关闭|交易关闭|待付款|待支付|未付款|全额退款|退款完成|已退款/.test(status)) return 'skip';
  if (/待发货|等待发货|等待卖家发货|等待出库|正在出库/.test(status)) return 'to_ship';
  if (/待收货|等待收货|已发货|等待揽收|运输中|派送中|派件中|待签收|待取件|待自提/.test(status)) return 'in_transit';
  return 'skip';
}

export function jdParcels(data, platformOrderId, checkedAt, rules) {
  if (!Array.isArray(data.multiPackageTrackInfoList)) throw new CollectorError('UPSTREAM_FORMAT', '京东物流字段已变化，已保留原轨迹');
  return data.multiPackageTrackInfoList.flatMap(item => {
    const group = item?.trackGroupInfo || {};
    const carriage = item?.carriageInfo || group.orderCarriageInfo || {};
    const waybillNo = asText(carriage.carriageId);
    if (!waybillNo) return [];
    if (!Array.isArray(group.orderTrackShowList)) throw new CollectorError('UPSTREAM_FORMAT', '京东物流节点字段已变化，已保留原轨迹');
    const { events, truncated } = normalizeLogisticsEvents(group.orderTrackShowList.map(step => ({
      time: step.CreationTime, description: [asText(step.StatusName), asText(step.Content)].filter(Boolean).join('：'),
    })), timestamp);
    const latest = events[0];
    const pickupCode = pickupCycleReset(latest?.description || '') ? '' : asText(group.checkCode).trim() || codeOf(latest?.description || '');
    const status = eventStatus(latest?.description || '', pickupCode ? 'arrived' : 'transit', rules);
    const evidence = status === 'signed' ? pickupEvidence([], rules) : pickupEvidence(events, rules);
    return [{ platformOrderId, waybillNo, carrier: asText(carriage.carrier), status, pickupCode,
      ...evidence,
      logisticsEvents: events, logisticsTruncated: truncated, logisticsState: events.length ? 'ok' : 'empty',
      logisticsCheckedAt: checkedAt, logisticsDetailCheckedAt: checkedAt, ...(events.length ? { logisticsUpdatedAt: checkedAt } : {}) }];
  });
}

async function collectJd(cookie, { fetchImpl, now, maxPages, knownOrders = [], trackedOrderIds = [], targetOrder, rules }) {
  const orders = [], shipments = [], orderUpdates = [], logisticsFailures = [], warnings = [];
  const session = { cookie };
  const request = async (functionId, input, detail = false) => {
    // Verified 2026-11-01 with fresh Node requests: PC Cookie is sufficient;
    // no captured h5st, device token, UUID, detail PassKey or browser is required.
    const query = new URLSearchParams({ appid: detail ? 'details-jd-com' : 'order-jd-com', client: 'pc', clientVersion: '1.0.0',
      loginType: '3', t: String(now()), functionId });
    if (detail) query.set('body', JSON.stringify(input));
    const response = await platformRequest(`https://api.m.jd.com/api?${query}`, session.cookie, { fetchImpl, method: 'POST',
      body: detail ? undefined : new URLSearchParams({ body: JSON.stringify(input) }).toString(),
      headers: { Origin: detail ? 'https://details.jd.com' : 'https://order.jd.com',
        Referer: detail ? 'https://details.jd.com/' : 'https://order.jd.com/center/list.action', 'Content-Type': 'application/x-www-form-urlencoded' } });
    session.cookie = withCookies(session.cookie, response.headers);
    return jdCheck(json(response.text));
  };
  let detailBudget = 20;
  async function detail(platformOrderId) {
    if (detailBudget-- <= 0) return;
    const checkedAt = now();
    try {
      const data = await request('pcdetail_traceMultiPackage', { orderId: platformOrderId }, true);
      const returnedParcels = jdParcels(data, platformOrderId, checkedAt, rules);
      const known = knownOrders.find(order => asText(order.platformOrderId) === platformOrderId);
      const parcels = returnedParcels.filter(parcel => {
        if (!parcel.logisticsEvents.length && !parcel.pickupCode && known?.shipments?.some(old => asText(old.waybillNo) === parcel.waybillNo)) {
          logisticsFailures.push({ platformOrderId, waybillNo: parcel.waybillNo, state: 'empty', logisticsCheckedAt: checkedAt });
          return false;
        }
        return true;
      });
      // The PC API formats its submit time with a literal HTML line break.
      const submitDate = asText(data.processTimeInfo?.submitDate).replace(/\s*<br\s*\/?>\s*/gi, ' ');
      const orderDate = logisticsTimestamp(submitDate, timestamp);
      const terminal = returnedParcels.length && returnedParcels.every(parcel => parcel.status === 'signed');
      const update = { platformOrderId, ...(orderDate ? { orderDate, orderDateOrigin: 'detail' } : {}), dateCheckedAt: checkedAt,
        dateState: orderDate ? 'ok' : 'empty', ...(terminal ? { orderStatus: '已签收' } : {}) };
      const listed = orders.find(order => order.platformOrderId === platformOrderId);
      if (listed) Object.assign(listed, update); else orderUpdates.push(update);
      shipments.push(...parcels);
      const returned = new Set(returnedParcels.map(parcel => parcel.waybillNo));
      const missing = activeKnownParcels(known).filter(parcel => !returned.has(asText(parcel.waybillNo)));
      for (const parcel of missing) logisticsFailures.push({ platformOrderId, waybillNo: asText(parcel.waybillNo), state: 'unavailable', logisticsCheckedAt: checkedAt });
      if (!returnedParcels.length && !missing.length) logisticsFailures.push({ platformOrderId, state: 'unavailable', logisticsCheckedAt: checkedAt });
    } catch (error) {
      if (error.code === 'ACCOUNT_EXPIRED') throw error;
      logisticsFailures.push({ platformOrderId, state: 'error', logisticsCheckedAt: checkedAt });
      orderUpdates.push({ platformOrderId, dateCheckedAt: checkedAt, dateState: 'error', dateError: '京东订单日期补查失败，已保留原日期' });
      warnings.push('部分京东订单详情读取失败，已保留原记录');
    }
  }
  if (targetOrder) {
    await detail(asText(targetOrder.platformOrderId));
    return { orders, shipments, orderUpdates, logisticsFailures, warnings, refreshedCookie: session.cookie };
  }
  const seen = new Set(), candidates = new Set();
  let skipped = 0;
  for (let page = 1; page <= maxPages; page++) {
    const data = await request('pcorder_center_list', { page, d: 1, s: 4096 });
    if (data.success !== true || !Array.isArray(data.data?.orderList)) throw new CollectorError('UPSTREAM_FORMAT', '京东订单字段已变化，已保留原记录');
    const list = data.data.orderList;
    if (!list.length) break;
    let added = 0;
    for (const order of list) {
      const platformOrderId = asText(order.orderId);
      if (!platformOrderId || seen.has(platformOrderId)) continue;
      seen.add(platformOrderId); added++;
      const kind = jdOrderKind(order);
      const rawAmount = order.itemPayInfo?.shouldPay;
      const metadata = { platformOrderId, title: (order.wareList || []).map(ware => asText(ware.name)).filter(Boolean).join(' / '),
        amount: rawAmount != null && /^\d+(?:\.\d+)?$/.test(String(rawAmount)) ? Number(rawAmount) : null,
        orderDate: timestamp(order.dateSubmit), orderDateOrigin: 'list', tradeStatus: asText(order.statusInfo?.orderState),
        orderStatus: asText(order.statusInfo?.orderStateName) };
      if (kind === 'skip') { skipped++; orderUpdates.push(metadata); }
      else orders.push(metadata);
      const known = knownOrders.find(item => asText(item.platformOrderId) === platformOrderId);
      const activeParcels = activeKnownParcels(known);
      // JD can assign a waybill and publish warehouse events before the order leaves the warehouse.
      if ((kind === 'to_ship' || kind === 'in_transit') && (!known?.shipments?.length || activeParcels.length) || trackedOrderIds.includes(platformOrderId) || activeParcels.length) candidates.add(platformOrderId);
    }
    if (!added) { warnings.push('京东分页重复，已停止采集；缺席订单不会删除或标记已取'); break; }
    if (Number.isInteger(data.data.totalNum) && seen.size >= data.data.totalNum) break;
    if (page === maxPages) warnings.push('已达到京东分页上限；缺席订单不会删除或标记已取');
  }
  for (const order of activeKnownOrders(knownOrders, new Set(candidates), 20)) candidates.add(asText(order.platformOrderId));
  const lastChecked = id => {
    const known = knownOrders.find(order => asText(order.platformOrderId) === id);
    const parcels = activeKnownParcels(known);
    return parcels.length ? Math.min(...parcels.map(parcel => parcel.logisticsCheckedAt || 0)) : known?.dateCheckedAt || 0;
  };
  for (const id of [...candidates].sort((a, b) => lastChecked(a) - lastChecked(b))) {
    if (detailBudget <= 0) { warnings.push('京东本轮详情补查已达上限，其余订单下轮继续'); break; }
    await detail(id);
  }
  if (skipped) warnings.push(`京东订单筛选：保留${orders.length}笔待发货/待收货订单，跳过${skipped}笔已结束或非快递订单`);
  return { orders, shipments, orderUpdates, logisticsFailures, warnings: [...new Set(warnings)], refreshedCookie: session.cookie };
}

export function createCollector({ fetchImpl = fetch, now = Date.now, maxPages = 5, getLogisticsRules } = {}) {
  return async (account, cookie, { trackedOrderIds = [], knownOrders = [], targetOrder } = {}) => {
    const rules = getLogisticsRules ? JSON.parse(JSON.stringify(getLogisticsRules())) : undefined;
    const options = { fetchImpl, now, maxPages, trackedOrderIds, knownOrders: targetOrder ? [targetOrder] : knownOrders, targetOrder, rules };
    const collect = { taobao: collectTaobao, pdd: collectPdd, jd: collectJd }[account.platform];
    if (!collect) throw new CollectorError('INVALID_PLATFORM', '不支持的授权平台');
    const result = await collect(cookie, options);
    // Keep the parser snapshot with this import, even if an administrator edits rules mid-request.
    if (rules) result.logisticsRules = rules;
    return result;
  };
}
