import packageInfo from '../package.json' with { type: 'json' };

export const serverVersion = packageInfo.version;
export const capabilities = ['syncJobs', 'orderRefresh', 'orderDateOverride'];
