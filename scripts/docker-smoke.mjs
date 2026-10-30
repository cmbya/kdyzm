import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const image = process.argv[2] || 'kdyzm:smoke';
const suffix = randomBytes(6).toString('hex');
const container = `kdyzm-smoke-${suffix}`, volume = `${container}-data`;
const adminToken = randomBytes(32).toString('hex');
const env = { ...process.env, ADMIN_TOKEN: adminToken,
  COOKIE_ENCRYPTION_KEY: randomBytes(32).toString('hex'), PUBLIC_BASE_URL: 'http://127.0.0.1:8787' };
function docker(args, required = true) {
  const result = spawnSync('docker', args, { env, encoding: 'utf8', timeout: 120_000 });
  if (required && (result.error || result.status !== 0)) throw new Error(`docker ${args[0]} failed: ${result.error?.message || result.stderr}`);
  return result.stdout?.trim() || '';
}
let baseUrl;
async function healthy() {
  const mapped = docker(['port', container, '8787/tcp']).split('\n')[0];
  baseUrl = `http://${mapped}`;
  for (let attempt = 0; attempt < 45; attempt++) {
    try { if ((await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) })).ok) return; } catch {}
    await setTimeout(1000);
  }
  throw new Error('Container did not become healthy');
}
try {
  docker(['volume', 'create', volume]);
  docker(['run', '-d', '--name', container, '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--init',
    '-e', 'ADMIN_TOKEN', '-e', 'COOKIE_ENCRYPTION_KEY', '-e', 'PUBLIC_BASE_URL',
    '-p', '127.0.0.1::8787', '-v', `${volume}:/data`, image]);
  await healthy();
  assert.notEqual(docker(['exec', container, 'id', '-u']), '0');
  assert.equal((await fetch(`${baseUrl}/v1/snapshot`)).status, 401);
  const headers = { 'x-admin-token': adminToken, 'content-type': 'application/json' };
  const created = await fetch(`${baseUrl}/v1/admin/accounts`, { method: 'POST', headers,
    body: JSON.stringify({ platform: 'taobao', label: 'Disposable container test', cookie: `test=${suffix}`, enabled: false }) });
  assert.equal(created.status, 201);
  const { account } = await created.json();
  assert.equal(account.enabled, false); // This fixture must never contact the upstream platform.
  docker(['restart', container]);
  await healthy();
  const response = await fetch(`${baseUrl}/v1/admin/accounts`, { headers });
  assert.equal(response.status, 200);
  const persisted = await response.json();
  assert.equal(persisted.accounts.length, 1);
  assert.equal(persisted.accounts[0].id, account.id);
  assert.equal(persisted.accounts[0].enabled, false);
  console.log('PASS container: non-root, read-only root, authenticated API, writable SQLite and restart persistence');
} finally {
  docker(['rm', '-f', container], false);
  docker(['volume', 'rm', volume], false);
}
