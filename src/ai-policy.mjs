export const AI_INTERVAL_MINUTES = 360;
export const AI_DAILY_MAX = 100;
export const AI_EVENT_COOLDOWN = 60000;

export const aiDailyLimit = value => Number.isSafeInteger(value) && value > 0 ? Math.min(value, AI_DAILY_MAX) : 20;
export const nextAiDay = now => Math.floor((now + 8 * 3600000) / 86400000) * 86400000 + 86400000 - 8 * 3600000;
export const aiCandidateDueAt = (candidate, periodicAt, eventAt) => Math.max(candidate.retryAt || 0,
  candidate.status === 'pending' && candidate.eventPending ? Math.min(periodicAt, eventAt) : periodicAt);
