export function pickupPendingCount(item) {
  return Number.isFinite(item.pendingCount) ? Math.max(0, item.pendingCount) : item.isPicked ? 0 : 1;
}

export function comparePickupOrder(a, b) {
  return Number(pickupPendingCount(b) > 0) - Number(pickupPendingCount(a) > 0) || b.date - a.date;
}

export function groupCodes(codes) {
  const groups = Object.create(null);
  codes.slice().sort(comparePickupOrder).forEach(item => {
    const d = new Date(item.date);
    const date = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    const address = item.address || '未知地址';
    if (!groups[date]) groups[date] = Object.create(null);
    if (!groups[date][address]) groups[date][address] = [];
    groups[date][address].push(item);
  });
  return groups;
}

export function pendingCount(group) {
  return Object.values(group).flat().reduce((count, item) => count + pickupPendingCount(item), 0);
}

export function visibleAddresses(group, showPicked = false) {
  return Object.fromEntries(Object.entries(group)
    .map(([address, items]) => [address, items.filter(item => showPicked || pickupPendingCount(item) > 0)
      .sort((a, b) => Number(pickupPendingCount(b) > 0) - Number(pickupPendingCount(a) > 0))])
    .filter(([, items]) => items.length));
}

// A newly completed date collapses even if its history was open before the update.
export function reconcileExpandedDates(previous, next, expanded) {
  const before = groupCodes(previous), after = groupCodes(next);
  return Object.fromEntries(Object.entries(expanded).filter(([date, open]) =>
    open && after[date] && !(before[date] && pendingCount(before[date]) > 0 && pendingCount(after[date]) === 0)));
}
