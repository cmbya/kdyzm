// Official protocol evidence and live-account limits: docs/continuous-logistics-3.1.32.md.
const ORIGIN = 'https://mobile.yangkeduo.com';
const SPLIT_FIELDS = ['order_sn', 'shipping_id', 'tracking_number', 'jump_type', 'partial_shipment_period'];
const TRACK_FIELDS = ['order_sn', 'shipping_id', 'tracking_number', 'entry_source', 'refer_scene', 'source_type', 'after_sales_id'];
const text = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const waybill = value => text(value).normalize('NFKC').trim();
const validWaybill = value => !!value && !/^(?:待发货|暂无|无|0|WAITING_FOR_CARRIER)$/i.test(value);
const unavailable = (waybillNo, message) => ({ ...(waybillNo ? { waybillNo } : {}), state: 'unavailable', message });
const orderMatches = (value, id) => ['order_sn', 'orderSn'].every(key => value?.[key] === undefined || text(value[key]) === id);
const waybillMatches = (value, expected) => ['tracking_number', 'trackingNumber'].every(key => value?.[key] === undefined || waybill(value[key]) === expected);
export { orderMatches as pddOrderMatches, waybillMatches as pddWaybillMatches };

function pickQuery(input, fields) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const query = {};
  for (const key of fields) {
    if (input[key] === undefined || input[key] === null || input[key] === '') continue;
    const value = text(input[key]);
    if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) return null;
    query[key] = value;
  }
  if (query.tracking_number) query.tracking_number = waybill(query.tracking_number);
  return query;
}

function queryFromUrl(value, fields) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) return null;
  try {
    const url = new URL(value, `${ORIGIN}/`);
    if (url.origin !== ORIGIN || url.username || url.password || url.hash) return null;
    for (const key of fields) if (url.searchParams.getAll(key).length > 1) return null;
    return pickQuery(Object.fromEntries(url.searchParams), fields);
  } catch { return null; }
}

async function read(path, query, { platformRequest, pddCheck }) {
  const response = await platformRequest(`${ORIGIN}/proxy/api/${path}?${new URLSearchParams(query)}`);
  let data;
  try { data = JSON.parse(response.text); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  try { return pddCheck(data); }
  catch (error) { if (error.code === 'UPSTREAM_FORMAT') return null; throw error; }
}

function parcelFrom(item, expectedOrderId) {
  const waybillNo = waybill(item?.tracking_number);
  if (!validWaybill(waybillNo)) return { failure: unavailable('', '平台分包缺少有效运单号') };
  if (!orderMatches(item, expectedOrderId)) return { failure: unavailable(waybillNo, '平台分包订单不匹配') };
  const query = item.jump_url ? queryFromUrl(item.jump_url, [...TRACK_FIELDS, 'external']) : {};
  if (!query || query.external && query.external !== '1') return { failure: unavailable(waybillNo, '平台分包查询信息不可用') };
  const external = query.external;
  delete query.external;
  const shippingId = text(item.shipping_id);
  if (query.order_sn && query.order_sn !== expectedOrderId
    || query.tracking_number && query.tracking_number !== waybillNo
    || shippingId && query.shipping_id && query.shipping_id !== shippingId) {
    return { failure: unavailable(waybillNo, '平台分包查询标识不匹配') };
  }
  Object.assign(query, { order_sn: expectedOrderId, tracking_number: waybillNo, shipping_id: shippingId || query.shipping_id });
  const checked = pickQuery(query, TRACK_FIELDS);
  if (!checked?.shipping_id) return { failure: unavailable(waybillNo, '平台分包缺少运单查询标识') };
  // shipping_id is a query selector, not a verified unique platform package identity.
  return { parcel: { waybillNo, carrier: text(item.shipping_name), query: checked, ...(external === '1' ? { external } : {}) } };
}

export async function discoverPddSplit(shipping, options) {
  const { expectedOrderId } = options;
  const jumpUrl = shipping?.package_info_jump_url ?? shipping?.packageInfoJumpUrl;
  if (!jumpUrl) return { parcels: [], failures: [] };
  const sourceWaybill = waybill(shipping?.tracking_number ?? shipping?.trackingNumber);
  const query = queryFromUrl(jumpUrl, SPLIT_FIELDS);
  if (!text(expectedOrderId) || !orderMatches(shipping, expectedOrderId) || !query
    || query.order_sn !== expectedOrderId || !validWaybill(query.tracking_number)
    || sourceWaybill && !waybillMatches(shipping, query.tracking_number)) {
    return { parcels: [], failures: [unavailable(sourceWaybill, '平台拆包查询标识不匹配')] };
  }
  const data = await read('api/express/split/pack', query, options);
  if (!data || !orderMatches(data, expectedOrderId) || !orderMatches(data.result, expectedOrderId) || !Array.isArray(data.result?.list)) {
    return { parcels: [], failures: [unavailable(sourceWaybill, '平台拆包列表格式或订单标识不匹配')] };
  }
  const parcels = new Map(), failures = [], ambiguous = new Set();
  for (const item of data.result.list) {
    const result = parcelFrom(item, expectedOrderId);
    if (result.failure) { failures.push(result.failure); continue; }
    const parcel = result.parcel, previous = parcels.get(parcel.waybillNo);
    if (previous && previous.query.shipping_id !== parcel.query.shipping_id) {
      ambiguous.add(parcel.waybillNo);
      failures.push(unavailable(parcel.waybillNo, '同一运单存在不同查询标识，未猜测分包'));
    }
    if (!previous) parcels.set(parcel.waybillNo, parcel);
  }
  return { parcels: [...parcels.values()].filter(parcel => !ambiguous.has(parcel.waybillNo)), failures };
}

export async function fetchPddSplitTrack(parcel, options) {
  const { expectedOrderId, queryType = 1 } = options;
  const waybillNo = waybill(parcel?.waybillNo), query = pickQuery(parcel?.query, TRACK_FIELDS);
  if (![1, 2].includes(queryType) || !validWaybill(waybillNo) || !query?.shipping_id || query.order_sn !== expectedOrderId || query.tracking_number !== waybillNo) {
    return { failure: unavailable(waybillNo, '平台分包缺少匹配的查询标识') };
  }
  const data = await read('api/express/shipping/track', { ...query, query_type: String(queryType), support_multi_package: '1' }, options);
  const shipping = data?.shipping;
  if (!shipping || !Array.isArray(shipping.traces) || !orderMatches(data, expectedOrderId) || !orderMatches(shipping, expectedOrderId)
    || waybill(shipping.tracking_number ?? shipping.trackingNumber) !== waybillNo || !waybillMatches(shipping, waybillNo)) {
    return { failure: unavailable(waybillNo, '平台分包物流格式或运单标识不匹配') };
  }
  return { shipping };
}

export async function fetchPddSplitCabinet(parcel, options) {
  const { expectedOrderId } = options;
  const waybillNo = waybill(parcel?.waybillNo), query = pickQuery(parcel?.query, TRACK_FIELDS);
  if (parcel?.external !== '1' || !text(expectedOrderId) || !validWaybill(waybillNo) || !query?.shipping_id
    || query.order_sn !== expectedOrderId || query.tracking_number !== waybillNo) {
    return { failure: unavailable(waybillNo, '平台分包缺少匹配的柜码查询标识') };
  }
  const data = await read(`api/express/cabinet/${encodeURIComponent(expectedOrderId)}`, {
    ...(query.entry_source ? { entry_source: query.entry_source } : {}),
    shipping_id: query.shipping_id, tracking_number: waybillNo, external: '1',
  }, options);
  const cabinet = data?.result;
  if (!cabinet || typeof cabinet !== 'object' || Array.isArray(cabinet)
    || !orderMatches(data, expectedOrderId) || !orderMatches(cabinet, expectedOrderId)
    || !waybillMatches(data, waybillNo) || !waybillMatches(cabinet, waybillNo)) {
    return { failure: unavailable(waybillNo, '平台分包柜码格式或运单标识不匹配') };
  }
  return { cabinet };
}
