import packageInfo from '../package.json' with { type: 'json' };

export const serverVersion = packageInfo.version;
export const capabilities = ['syncJobs', 'orderRefresh', 'orderDateOverride', 'station_aliases_v1', 'pickup_completion_v1', 'pickup_cycles_v1', 'matching_feedback_v1'];
