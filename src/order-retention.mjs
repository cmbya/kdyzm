import { pickupCycleReset } from './collector-enrichment.mjs';

const DAY = 86400000;
const CHINA_OFFSET = 8 * 3600000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

const validDate = value => typeof value === 'string' && DATE_RE.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validTime = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000 ? value : 0;
const chinaDate = value => {
  const time = validTime(value);
  return time ? new Date(time + CHINA_OFFSET).toISOString().slice(0, 10) : '';
};
const dateTime = value => validDate(value) ? Date.parse(`${value}T00:00:00+08:00`) : 0;

export function retentionAnchor(order) {
  if (validDate(order?.dateOverride)) return { anchorDate: order.dateOverride, anchorSource: 'order_date' };
  if (validTime(order?.orderDate) && ['platform', 'manual'].includes(order?.orderDateSource)) {
    return { anchorDate: chinaDate(order.orderDate), anchorSource: 'order_date' };
  }
  return { anchorDate: chinaDate(order?.firstSeenAt), anchorSource: 'first_seen' };
}

export function orderRetention(order, now = Date.now()) {
  const { anchorDate, anchorSource } = retentionAnchor(order);
  const anchorAt = dateTime(anchorDate);
  const archivedAt = anchorAt ? anchorAt + 31 * DAY : 0;
  const ageDays = anchorAt ? Math.floor((Date.parse(chinaDate(now) + 'T00:00:00+08:00') - anchorAt) / DAY) : 0;
  const restored = !!anchorDate && order?.archiveRestoredAnchor === anchorDate && validTime(order?.archiveRestoredAt) > 0;
  return { version: 1, archived: !!anchorAt && ageDays > 30 && !restored, anchorDate, anchorSource, archivedAt,
    restoredAt: restored ? validTime(order?.archiveRestoredAt) : 0 };
}

export function retainedSignedShipment(shipment, archived, now = Date.now()) {
  const latestEvent = Array.isArray(shipment?.logisticsEvents) ? shipment.logisticsEvents[0] : null;
  const returned = ['returning', 'returned'].includes(shipment?.status) || ['returning', 'returned'].includes(shipment?.logisticsState)
    || validTime(latestEvent?.time) > 0 && latestEvent.time <= now && pickupCycleReset(latestEvent?.description || '');
  if (!archived || shipment?.status !== 'signed' || returned) return null;
  const pickupPicked = !!shipment.picked;
  return pickupPicked ? { picked: true, pickupPicked: true, receiptState: 'picked' }
    : { picked: true, pickupPicked: false, receiptState: 'expired_signed', receiptLabel: '超期自动确认收到' };
}

export function normalizeRetentionFields(order, now = Date.now()) {
  const retention = orderRetention(order, now);
  const restoredAt = validTime(order.archiveRestoredAt);
  const restoredAnchor = order.archiveRestoredAnchor === retention.anchorDate && restoredAt > 0 ? order.archiveRestoredAnchor : '';
  return { ...order, archived: retention.archived, archiveAnchorDate: retention.anchorDate, archiveAnchorSource: retention.anchorSource,
    archivedAt: retention.archivedAt, archiveRestoredAnchor: restoredAnchor, archiveRestoredAt: restoredAnchor ? restoredAt : 0 };
}

export function validRetentionDate(value) { return validDate(value); }
