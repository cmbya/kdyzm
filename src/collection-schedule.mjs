const MINUTE = 60000;
const PLATFORMS = ['jd', 'pdd', 'taobao'];
export const COLLECTION_COOLDOWN = 5 * MINUTE;

export function scheduledPlatform(now) {
  return PLATFORMS[Math.floor(now / COLLECTION_COOLDOWN) % PLATFORMS.length];
}

export function scheduledSyncAt(platform, after, intervalMinutes = 15) {
  const interval = intervalMinutes * MINUTE, offset = PLATFORMS.indexOf(platform) * COLLECTION_COOLDOWN;
  return (Math.floor((after - offset) / interval) + 1) * interval + offset;
}

export function isCollectionStale(account, now) {
  if (!account?.enabled || account.status === 'expired') return false;
  const time = account.lastFullSuccessAt;
  return !Number.isSafeInteger(time) || time <= 0 || time > now || now - time > 30 * MINUTE;
}
