import { resolve } from 'node:path';
import { createService } from './service.mjs';
import { serverVersion } from './version.mjs';

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const legacyConfiguration = [process.env.COOKIE_ENCRYPTION_KEY, process.env.ADMIN_TOKEN, process.env.PUBLIC_BASE_URL];
if (legacyConfiguration.some(Boolean) && !legacyConfiguration.every(Boolean)) throw new Error('Legacy environment mode requires PUBLIC_BASE_URL, ADMIN_TOKEN and COOKIE_ENCRYPTION_KEY together; leave all three empty for first-access setup');
const service = createService({ filename: resolve(process.env.DATA_DIR || 'data', 'pickcode.db'),
  encryptionKey: process.env.COOKIE_ENCRYPTION_KEY, adminToken: process.env.ADMIN_TOKEN,
  baseUrl: process.env.PUBLIC_BASE_URL,
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean) });
service.server.listen(port, host, () => console.log(`PickCode online service ${serverVersion} listening on ${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); process.exit(0); });
