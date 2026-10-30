import { resolve } from 'node:path';
import { createService } from './service.mjs';

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const service = createService({ filename: resolve(process.env.DATA_DIR || 'data', 'pickcode.db'),
  encryptionKey: process.env.COOKIE_ENCRYPTION_KEY, adminToken: process.env.ADMIN_TOKEN,
  baseUrl: process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${port}`,
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean) });
service.server.listen(port, host, () => console.log(`PickCode online service 3.1.0 listening on ${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); process.exit(0); });
