const kindOrder = { waybill: 0, code: 1, time_station: 2, time: 3, station: 4 };

export function linkedShipmentIds(source) {
  return [...new Set([...(source?.linkedShipmentIds || []), source?.linkedShipmentId].filter(Boolean))];
}

export function sourcePackageCount(source) {
  const count = Number(source?.packageCount);
  return Number.isInteger(count) && count > 0 ? count : Math.max(1, linkedShipmentIds(source).length);
}

export function pickupSources(item) {
  if (item?.sources?.length) return item.sources;
  return item?.sourceId && !item.isManual
    ? [{ sourceId: item.sourceId, kind: 'pickup', body: item.sourceBody, date: item.date }]
    : [];
}

export function canMatchSource(source) {
  return Boolean(source?.sourceId && !source.ignored && source.kind === 'pickup');
}

export function pickupMatchSummary(item) {
  const sources = pickupSources(item).filter(canMatchSource).filter(source =>
    source.matchNeedsReview || item?.needsMatchReview || linkedShipmentIds(source).length < sourcePackageCount(source));
  const candidateCount = new Set(sources.flatMap(source => (source.matchCandidates || []).map(candidate => candidate.shipmentId))).size;
  return { available: sources.length > 0, needsReview: Boolean(item?.needsMatchReview || sources.some(source => source.matchNeedsReview)), candidateCount };
}

export function pickupShipmentRows(packages) {
  return (packages || []).flatMap(order => (order.shipments || []).filter(shipment => shipment?.id).map(shipment => ({
    ...shipment, orderId: order.id, title: order.title || '包裹', platform: order.platform || '',
    platformOrderId: order.platformOrderId || '', familyId: shipment.familyId || order.familyId || '',
    familyName: shipment.familyName || order.familyName || '',
  })));
}

export function matchingRows(source, packages, { includeOther = false, query = '', familyId = '', platform = '' } = {}) {
  const linked = linkedShipmentIds(source);
  const evidence = new Map((source?.matchCandidates || []).map(candidate => [candidate.shipmentId, candidate]));
  const conflicts = new Map((source?.matchConflicts || []).map(conflict => [conflict.shipmentId, conflict.reason]));
  const needle = query.trim().toLocaleLowerCase();
  return pickupShipmentRows(packages).filter(shipment => {
    const current = linked.includes(shipment.id);
    if (!current && !evidence.has(shipment.id) && !(includeOther && shipment.canLinkPickup === true)) return false;
    if (familyId && (shipment.familyId || '__unassigned__') !== familyId) return false;
    if (platform && shipment.platform !== platform) return false;
    return !needle || [shipment.title, shipment.platformOrderId, shipment.waybillNo].some(value => String(value || '').toLocaleLowerCase().includes(needle));
  }).map(shipment => ({ ...shipment, current: linked.includes(shipment.id), evidence: evidence.get(shipment.id) || null, conflict: conflicts.get(shipment.id) || '' }))
    .sort((a, b) => Number(b.current) - Number(a.current) ||
      (kindOrder[a.evidence?.kind] ?? 9) - (kindOrder[b.evidence?.kind] ?? 9) ||
      (Math.abs(a.evidence?.deltaMs ?? Infinity) - Math.abs(b.evidence?.deltaMs ?? Infinity)) || a.id.localeCompare(b.id));
}

export function matchSelectionError(source, shipmentIds, packages) {
  if (!canMatchSource(source)) return '这条短信暂不能匹配订单';
  const ids = [...new Set(shipmentIds)];
  if (!ids.length) return '请选择对应包裹';
  if (ids.length > sourcePackageCount(source)) return '所选包裹不能超过短信件数';
  const linked = linkedShipmentIds(source), rows = pickupShipmentRows(packages);
  if (linked.some(id => rows.find(row => row.id === id)?.picked && !ids.includes(id))) return '已取包裹请单独解除关联，领取状态会保留';
  for (const id of ids) {
    const row = rows.find(shipment => shipment.id === id);
    if (!row) return '包裹记录已更新，请重新选择';
    if (!linked.includes(id) && row.canLinkPickup !== true) return row.pickupLinkReason || '此包裹暂不能关联，请刷新后重试';
  }
  return '';
}

export function matchLinkPayload(source, shipmentIds, packages) {
  const error = matchSelectionError(source, shipmentIds, packages);
  if (error) throw new Error(error);
  return { sourceId: source.sourceId, shipmentIds: [...new Set(shipmentIds)], ...(linkedShipmentIds(source).length ? { replace: true } : {}) };
}

export function stationProposalForSelection(source, shipmentIds, packages) {
  const stationName = source?.address?.trim();
  const rows = pickupShipmentRows(packages).filter(row => shipmentIds.includes(row.id));
  if (!stationName || !rows.length || rows.some(row => row.canLinkPickup !== true)) return null;
  const names = [...new Set(rows.map(row => row.station?.trim()).filter(Boolean))];
  if (names.length !== 1 || names[0] === stationName) return null;
  const location = value => {
    const cabinet = /(\d+)号?(?:快递柜|自提柜|柜)/.exec(value), gate = /(东|西|南|北)(?:大)?门/.exec(value);
    return { cabinet: cabinet?.[1], gate: gate?.[1] };
  };
  const a = location(stationName), b = location(names[0]);
  if (a.cabinet && b.cabinet && a.cabinet !== b.cabinet || a.gate && b.gate && a.gate !== b.gate) return null;
  return { stationName, otherStationName: names[0], subLocation: a.cabinet ? a.cabinet + '号柜' : '' };
}

export function timeDifference(deltaMs) {
  if (deltaMs == null || !Number.isFinite(Number(deltaMs))) return '时间差未知';
  const seconds = Math.round(Math.abs(Number(deltaMs)) / 1000);
  if (seconds < 60) return '相差' + seconds + '秒';
  if (seconds < 3600) return '相差' + Math.floor(seconds / 60) + '分' + (seconds % 60 ? seconds % 60 + '秒' : '');
  if (seconds < 86400) return '相差' + Math.floor(seconds / 3600) + '小时' + (Math.floor(seconds % 3600 / 60) ? Math.floor(seconds % 3600 / 60) + '分' : '');
  return '相差' + Math.floor(seconds / 86400) + '天';
}

export function matchReason(row) {
  if (row.conflict) return row.conflict;
  if (row.evidence?.reason) return row.evidence.reason;
  if (row.evidence?.stationMatch === 'different') return '取件站点不同，请核对';
  if (row.evidence?.stationMatch === 'same') return '取件站点一致';
  return row.current ? '当前已关联包裹' : '手动选择，请核对商品与运单';
}
