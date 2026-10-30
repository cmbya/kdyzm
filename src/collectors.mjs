// Adapted from YUNXI-fi/Pickup-Code-Display, commit 034aad94559e8448644f4670408412ba7222a10d.
// Copyright (c) 2026. Non-commercial license: ../licenses/Pickup-Code-Display-LICENSE.txt.
// This adapter intentionally does not inherit upstream's automatic "picked" transitions.
import { createHash } from 'node:crypto';

const APPKEY = '12574478';
const UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/105.0.0.0 Mobile Safari/537.36';
const HOSTS = new Set(['h5api.m.taobao.com', 'pages-g.m.taobao.com', 'buyertrade.taobao.com', 'mobile.yangkeduo.com']);
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

async function mtop(session, data, pc = false) {
  const api = pc ? 'mtop.taobao.order.queryboughtlistV2' : 'mtop.taobao.order.queryboughtlistv2';
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
  const qs = new URLSearchParams({ jsv: '2.7.2', appKey: APPKEY, t, sign, v: '1.0', api, type: pc ? 'originaljson' : 'jsonp', dataType: pc ? 'json' : 'jsonp' });
  if (pc) {
    Object.entries({ ecode: '1', timeout: '8000', valueType: 'original', ttid: '201200@taobao_iphone_99.99.99', needLogin: 'true', isHttps: '1', needRetry: 'true', preventFallback: 'true' }).forEach(([k, v]) => qs.set(k, v));
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else qs.set('data', raw);
  const response = await platformRequest(`${base}?${qs}`, session.cookie, { fetchImpl: session.fetchImpl, headers, method: pc ? 'POST' : 'GET', body: pc ? `data=${encodeURIComponent(raw)}` : undefined });
  session.cookie = withCookies(session.cookie, response.headers);
  const content = response.text.trim();
  const parsed = json(content.startsWith('{') ? content : content.slice(content.indexOf('(') + 1, content.lastIndexOf(')')));
  const ret = Array.isArray(parsed.ret) ? parsed.ret.join(' ') : asText(parsed.retCode || parsed.ret);
  if (/SESSION_EXPIRED|TOKEN_EXOIRED|TOKEN_EXPIRED|NEED_LOGIN/.test(ret)) expired();
  if (ret && !ret.includes('SUCCESS')) upstream();
  if (!parsed.data || !Object.keys(parsed.data).length) expired();
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
function stationOf(value) { return value.match(/(?:存放至|已到达|存入)([^，,。【]+)/)?.[1]?.trim() || value.match(/由【(.+?)】/)?.[1] || ''; }
function codeOf(value) { return value.match(/(?:取件码|取货码|提货码|自提码)\s*(?:是|为)?\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9-]{3,15})/)?.[1] || ''; }
function arrivalEvidence(value) { return /待取件|等待取件|已存放至|存入.*(?:柜|驿站)|已到达.*(?:驿站|代收点)|(?:驿站|代收点|自提柜|快递柜)代收|请(?:及时)?取件|凭取货码/.test(value); }

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

export function taobaoParcels(fields, platformOrderId, fallbackCode = '') {
  const packages = fields.multiPackages?.packages || [];
  const baseNo = asText(fields.mailNo || fields.logisticCompany?.mailNo);
  const sources = packages.length ? packages.filter(p => p?.mailNo).map(p => ({ ...p, mailNo: asText(p.mailNo) })) : baseNo ? [{ mailNo: baseNo }] : [];
  return sources.map(parcel => {
    // A parent-level code is unsafe to copy onto every split shipment.
    const specific = parcel.fields || (parcel.multiStage ? parcel : null);
    const selected = specific || (sources.length === 1 || parcel.mailNo === baseNo ? fields : {});
    const stages = Array.isArray(selected.multiStage) ? selected.multiStage : [];
    let pickupCode = '', station = '', arrivalAt = 0, arrived = false;
    for (const stage of stages) {
      const content = stageText(stage);
      const card = stage.cardDesc || {};
      const code = asText(card.custom?.expressCode?.code) || codeOf(content);
      pickupCode ||= code;
      station ||= asText(card.title || card.subTitle) || stationOf(content);
      if (arrivalEvidence(`${stage.title || ''} ${content}`)) { arrived = true; arrivalAt ||= timestamp(stage.time || stage.date || stage.occurTime); }
    }
    if (!pickupCode && sources.length === 1) pickupCode = fallbackCode;
    // A current structured collection code is itself evidence that the parcel is at a pickup point.
    arrived ||= !!pickupCode;
    const latest = `${stages[0]?.title || ''} ${stages[0] ? stageText(stages[0]) : ''}`;
    // The first stage is the platform's current event. A current station pickup
    // notice wins over generic "signed" wording; otherwise a current signature
    // supersedes older arrival/code evidence while that evidence is retained.
    const latestCard = stages[0]?.cardDesc || {};
    const latestCardText = `${latestCard.title || ''} ${latestCard.subTitle || ''}`;
    const latestStructuredPickup = !!latestCard.custom?.expressCode?.code || /驿站|代收点|代收|自提柜|快递柜|丰巢/.test(latestCardText);
    const latestAtPickupPoint = latestStructuredPickup || arrivalEvidence(latest);
    const latestTitle = asText(stages[0]?.title).trim();
    const latestBody = stages[0] ? stageText(stages[0]) : '';
    const latestTransitTitle = /运输|发货|揽收|派送|派件中/.test(latestTitle);
    const latestTransit = latestTransitTitle || /运输|发货|揽收|派送|派件中/.test(latestBody);
    const latestBodySigned = /已完成签收|签收成功|已签收/.test(latestBody)
      && !/(?:未|待|拒绝?|请|等待|当面)[^，,。；;！？!?]{0,8}(?:已完成签收|签收成功|已签收)/.test(latestBody);
    const latestSigned = (!latestTransitTitle && /^(?:签收|已签收|签收成功)$/.test(latestTitle)) || (!latestTransitTitle && latestBodySigned);
    const status = latestAtPickupPoint ? 'arrived' : latestSigned ? 'signed' : latestTransit ? 'transit' : arrived ? 'arrived' : 'unknown';
    return { platformOrderId, waybillNo: parcel.mailNo, carrier: asText(parcel.cpName || CARRIERS[parcel.cpCode] || selected.logisticCompany?.name || parcel.cpCode),
      pickupCode, station, arrivalAt, status };
  });
}

async function collectTaobao(cookie, { fetchImpl, now, maxPages, trackedOrderIds = [] }) {
  const session = { cookie, fetchImpl, now };
  const orders = [], shipments = [], orderUpdates = [], warnings = [];
  const seen = new Set();
  const tracked = new Set(trackedOrderIds.map(id => String(id)));
  let pickupCodes = {};
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
      const known = tracked.has(platformOrderId);
      const metadata = { platformOrderId, tradeStatus: info.tradeStatus, orderStatus: info.orderStatus, orderDate: info.orderDate, refundStatus: info.refundStatus };
      // Rejected orders are metadata-only. A previously imported order is
      // allowed through for a detail refresh, even after it reaches a terminal
      // platform status, so an old arrival cannot remain stale forever.
      if (kind === 'skip' && !known) {
        orderUpdates.push(metadata);
        continue;
      }
      if (kind === 'skip') orderUpdates.push(metadata);
      if (kind !== 'skip') {
        orders.push({ platformOrderId, title: info.title, amount: info.amount, orderDate: info.orderDate, tradeStatus: info.tradeStatus, orderStatus: info.orderStatus, refundStatus: info.refundStatus });
      }
      // Waiting for seller shipment has no useful logistics detail yet.
      if (kind === 'to_ship') continue;
      try {
        const result = await platformRequest(`https://pages-g.m.taobao.com/wow/z/app/mtb/logisticsV2/h5-detail?x-ssr=true&bizOrderId=${encodeURIComponent(platformOrderId)}`, session.cookie, { fetchImpl });
        const fields = extractSsrFields(result.text);
        if (fields) {
          const parcels = taobaoParcels(fields, platformOrderId, pickupCodes[platformOrderId]);
          shipments.push(...parcels);
          if (parcels.length > 1 && parcels.some(p => p.status === 'unknown')) warnings.push('部分拆单运单仅返回单号，等待平台提供各运单物流');
        } else warnings.push('部分订单暂无可解析物流，订单仍保留');
      } catch (error) {
        if (error.code === 'ACCOUNT_EXPIRED') throw error;
        warnings.push('部分订单物流读取失败，已保留原运单');
      }
    }
    if (!newCount) { warnings.push('平台分页重复，停止本轮采集并保留已有记录'); break; }
    if (page === maxPages) warnings.push('已达到分页上限；缺席订单不会标记为已取或删除');
  }
  if (orderUpdates.length) warnings.push(`订单筛选：本轮保留${orders.length}笔，跳过${orderUpdates.length}笔已结束或非待收货订单`);
  return { orders, shipments, orderUpdates, warnings: [...new Set(warnings)], refreshedCookie: session.cookie };
}

function pddCheck(value) {
  if (String(value.error_code) === '40001') expired();
  if (value.error_code || value.success === false) upstream();
  return value;
}
export function pddParcels(order, cabinet) {
  const platformOrderId = asText(order.order_sn);
  const listed = order.shipping_list || order.express_list || order.package_list;
  const parcels = Array.isArray(listed) && listed.length ? listed : order.tracking_number ? [order] : [];
  return parcels.filter(p => p.tracking_number || p.mail_no).map(parcel => {
    const waybillNo = asText(parcel.tracking_number || parcel.mail_no);
    const cabinetMatches = parcels.length === 1 || asText(cabinet.tracking_number) === waybillNo;
    const code = cabinetMatches ? asText(cabinet.code).trim() : '';
    const statusText = asText(parcel.shipping_status_text || order.order_status_text || order.status_text);
    const signed = /已签收|交易成功|交易完成/.test(statusText);
    return { platformOrderId, waybillNo, carrier: asText(parcel.shipping_name || parcel.company_name || (cabinetMatches && cabinet.companyName)),
      pickupCode: code, station: cabinetMatches ? asText(cabinet.address) : '',
      status: signed ? 'signed' : code ? 'arrived' : 'transit', arrivalAt: code && !signed ? timestamp(cabinet.arrival_time || cabinet.create_time) : 0 };
  });
}
async function collectPdd(cookie, { fetchImpl, maxPages }) {
  const uid = cookie.match(/(?:^|;\s*)(?:pdd_user_id|pdduid)=([^;]+)/)?.[1];
  if (!uid) expired();
  const headers = { Referer: 'https://mobile.yangkeduo.com/orders.html' };
  const orders = [], shipments = [], warnings = [];
  const seen = new Set();
  let offset = '';
  for (let page = 1; page <= maxPages; page++) {
    const query = new URLSearchParams({ pdduid: uid, page: String(page), type: 'unreceived' });
    if (offset) query.set('offset', offset);
    const response = await platformRequest(`https://mobile.yangkeduo.com/proxy/api/api/aristotle/order_list_v4?${query}`, cookie, { fetchImpl, headers });
    const data = pddCheck(json(response.text));
    if (!Array.isArray(data.orders)) throw new CollectorError('UPSTREAM_FORMAT', '拼多多订单字段已变化，保留上次数据');
    if (!data.orders.length) break;
    let newCount = 0;
    for (const order of data.orders) {
      const platformOrderId = asText(order.order_sn);
      if (!platformOrderId || seen.has(platformOrderId)) continue;
      newCount++; seen.add(platformOrderId);
      orders.push({ platformOrderId, title: (order.order_goods || []).map(g => g.goods_name || g.goods_title || '').filter(Boolean).join(' / '),
        amount: Number.isFinite(order.order_amount) ? order.order_amount / 100 : null, orderDate: timestamp(order.order_time || order.created_time || order.create_time),
        orderStatus: asText(order.order_status_text || order.status_text || order.order_status), refundStatus: asText(order.refund_status) });
      let cabinet = {};
      try {
        const response = await platformRequest(`https://mobile.yangkeduo.com/proxy/api/api/express/cabinet/${encodeURIComponent(platformOrderId)}`, cookie, { fetchImpl, headers });
        cabinet = pddCheck(json(response.text)).result || {};
      } catch (error) {
        if (error.code === 'ACCOUNT_EXPIRED') throw error;
        warnings.push('部分驿站取件码暂不可用，无码运单继续保留');
      }
      shipments.push(...pddParcels(order, cabinet));
    }
    if (!newCount) { warnings.push('平台分页重复，停止本轮采集并保留已有记录'); break; }
    offset = asText(data.orders.at(-1)?.offset);
    if (data.has_more === false || data.hasMore === false) break;
    if (page === maxPages) warnings.push('已达到分页上限；缺席订单不会标记为已取或删除');
  }
  return { orders, shipments, orderUpdates: [], warnings: [...new Set(warnings)] };
}

export function createCollector({ fetchImpl = fetch, now = Date.now, maxPages = 5 } = {}) {
  return async (account, cookie, { trackedOrderIds = [] } = {}) => {
    const options = { fetchImpl, now, maxPages, trackedOrderIds };
    return account.platform === 'taobao' ? collectTaobao(cookie, options) : collectPdd(cookie, options);
  };
}
