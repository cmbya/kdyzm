import { groupCodes, pendingCount, pickupPendingCount, comparePickupOrder } from './pickup-groups.js';

export function stationDisplayName(item, fallback = '未知地址') {
  return [item?.stationDisplayName, item?.stationCanonical, item?.address, item?.station]
    .find(value => typeof value === 'string' && value.trim())?.trim() || fallback;
}

function cabinetNumber(value) {
  if (/^[A-Za-z0-9]+$/.test(value)) return value.toUpperCase();
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value.includes('十')) {
    const [tens, ones] = value.split('十');
    return String((tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0));
  }
  return value.split('').map(char => digits[char]).join('');
}

export function pickupCabinet(item) {
  if (item?.pickupCabinetConflict) return '';
  if (Object.prototype.hasOwnProperty.call(item || {}, 'pickupCabinet')) return typeof item.pickupCabinet === 'string' ? item.pickupCabinet.trim() : '';
  // Old previews can lack projections; only explicit cabinet words supply a fallback.
  const matches = [item?.stationSubLocation, item?.address, item?.station].flatMap(value =>
    typeof value === 'string' ? [...value.matchAll(/(?:([A-Za-z0-9]+)区)?([0-9]+|[A-Za-z]|[零〇一二两三四五六七八九十]+)号?(?:快递柜|自提柜|柜)/g)].map(match => {
      if (/[A-Za-z0-9]/.test(value[match.index - 1] || '') || /^\d{4,}$/.test(match[2])) return '';
      const number = cabinetNumber(match[2]);
      return (match[1] ? match[1].toUpperCase() + '区' : '') + number + (/^[A-Z]$/.test(number) ? '柜' : '号柜');
    }).filter(Boolean) : []);
  const distinct = [...new Set(matches)];
  return distinct.length === 1 ? distinct[0] : '';
}

export function groupCodesByStation(codes) {
  return Object.fromEntries(Object.entries(groupCodes(codes)).map(([date, addresses]) => {
    const stations = Object.create(null);
    Object.values(addresses).flat().sort(comparePickupOrder).forEach(item => {
      const name = stationDisplayName(item);
      (stations[name] ||= []).push(item);
    });
    return [date, stations];
  }));
}

// Keep the original records intact; station mode only changes their presentation.
const locationOrder = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
function pickupLocation(item, cabinet) {
  const location = item.stationSubLocation || '';
  if (!cabinet || pickupCabinet({ stationSubLocation: location }) !== cabinet) return location;
  return location.replace(/(?:[A-Za-z0-9]+区)?(?:[0-9]+|[A-Za-z]|[零〇一二两三四五六七八九十]+)号?(?:快递柜|自提柜|柜)/g, '').trim();
}
function compareStationPickups(a, b) {
  const left = pickupCabinet(a), right = pickupCabinet(b);
  return Number(pickupPendingCount(b) > 0) - Number(pickupPendingCount(a) > 0)
    || Number(!left) - Number(!right)
    || locationOrder.compare(pickupLocation(a, left), pickupLocation(b, right))
    || locationOrder.compare(left, right)
    || b.date - a.date;
}

export function pickupSections(codes, mode = 'station') {
  if (mode === 'time') return Object.entries(groupCodesByStation(codes)).map(([key, addresses]) => ({ key, label: key, addresses }));
  const stations = new Map();
  codes.slice().sort(comparePickupOrder).forEach(item => {
    const name = stationDisplayName(item);
    if (!stations.has(name)) stations.set(name, []);
    stations.get(name).push(item);
  });
  return [...stations].map(([key, items]) => ({ key, label: key, addresses: { [key]: items.sort(compareStationPickups) } }));
}

export function reconcileExpandedStations(previous, next, expanded) {
  const before = new Map(pickupSections(previous).map(section => [section.key, section.addresses]));
  const after = new Map(pickupSections(next).map(section => [section.key, section.addresses]));
  return Object.fromEntries(Object.entries(expanded).filter(([key, open]) => open && after.has(key) &&
    !(before.has(key) && pendingCount(before.get(key)) > 0 && pendingCount(after.get(key)) === 0)));
}
