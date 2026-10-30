import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createService } from '../src/service.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/demo.json', import.meta.url), 'utf8'));
const port = Number(process.env.PORT || 8787);
const adminToken = process.env.ADMIN_TOKEN || randomBytes(32).toString('base64url');
const service = createService({ encryptionKey: randomBytes(32).toString('hex'), adminToken,
  baseUrl: `http://127.0.0.1:${port}`, fixture: true, scheduler: false,
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173').split(','),
  collector: async () => fixture });
const account = service.store.saveAccount({ platform: 'taobao', label: '本机测试账号（演示数据）', cookie: 'fixture-only' }, 'fixture-account', true);
service.store.importResult(account.id, fixture);
const pairing = service.store.createPairing([account.id]);
service.server.listen(port, '127.0.0.1', () => console.log(`FIXTURE ONLY — ephemeral simulated data, no platform requests\nAdmin: http://127.0.0.1:${port}\nAdmin token: ${adminToken}\nOne-use pairing code (10 minutes): ${pairing.code}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); process.exit(0); });
