import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const image = process.argv[2] || 'kdyzm:smoke';
const suffix = randomBytes(6).toString('hex');
const adminToken = randomBytes(32).toString('hex');
const env = { ...process.env, ADMIN_TOKEN: adminToken,
  COOKIE_ENCRYPTION_KEY: randomBytes(32).toString('hex'), PUBLIC_BASE_URL: 'http://127.0.0.1:8787' };
function docker(args, required = true) {
  const result = spawnSync('docker', args, { env, encoding: 'utf8', timeout: 120_000 });
  if (required && (result.error || result.status !== 0)) throw new Error(`docker ${args[0]} failed: ${result.error?.message || result.stderr}`);
  return result.stdout?.trim() || '';
}
function start(container, volume, legacy = false) {
  docker(['run', '-d', '--name', container, '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--init',
    ...(legacy ? ['-e', 'ADMIN_TOKEN', '-e', 'COOKIE_ENCRYPTION_KEY', '-e', 'PUBLIC_BASE_URL'] :
      ['-e', 'ADMIN_TOKEN=', '-e', 'COOKIE_ENCRYPTION_KEY=', '-e', 'PUBLIC_BASE_URL=']),
    '-p', '127.0.0.1::8787', '-v', `${volume}:/data`, image]);
}
async function healthy(container) {
  const mapped = docker(['port', container, '8787/tcp']).split('\n')[0];
  const baseUrl = `http://${mapped}`;
  for (let attempt = 0; attempt < 45; attempt++) {
    try { if ((await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) })).ok) return baseUrl; } catch {}
    await setTimeout(1000);
  }
  throw new Error('Container did not become healthy');
}
async function request(base, path, expectedStatus, { method = 'GET', body, token } = {}) {
  const response = await fetch(base + path, { method, signal: AbortSignal.timeout(10000),
    headers: { 'content-type': 'application/json', ...(token ? { 'x-admin-token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal(response.status, expectedStatus, `${method} ${path}`);
  return response.json();
}
const testAccount = { platform: 'taobao', label: 'Disposable container test', cookie: `test=${suffix}`, enabled: false };
function savedState(container, accountId, password) {
  // Inspect only disposable data. Never print an encryption key, password or Cookie.
  return JSON.parse(docker(['exec', container, 'node', '--input-type=module', '-e', `
    import { readFileSync, statSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    import { Store } from './src/store.mjs';
    const raw = readFileSync('/data/service-config.json', 'utf8');
    const config = JSON.parse(raw);
    const store = new Store({filename:'/data/pickcode.db', key:Buffer.from(config.encryptionKey, 'hex')});
    const cookieMatches = store.cookie(${JSON.stringify(accountId)}) === ${JSON.stringify(testAccount.cookie)};
    store.close();
    console.log(JSON.stringify({ keyHash:createHash('sha256').update(config.encryptionKey).digest('hex'),
      permissions:statSync('/data/service-config.json').mode & 0o777, cookieMatches,
      setupConsumed:config.setupCode === null, passwordHashed:!!config.password?.hash && !raw.includes(${JSON.stringify(password)}) }));
  `]));
}
async function bundledAppUpdate(base) {
  const manifestResponse = await fetch(`${base}/app-updates/app-update.json`, { signal: AbortSignal.timeout(10000) });
  assert.equal(manifestResponse.status, 200, 'Bundled App manifest must be public before setup');
  const raw = await manifestResponse.text();
  assert.ok(Buffer.byteLength(raw) <= 65536, 'Bundled App manifest is too large');
  const manifest = JSON.parse(raw);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.packageName, 'local.pickcode.assistant');
  assert.match(manifest.versionName, /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/);
  assert.equal(manifest.tag, `app-v${manifest.versionName}`);
  const apkName = `PickCode-private-${manifest.versionName}.apk`;
  assert.equal(manifest.apkUrl, `https://github.com/zsdd2/kdyzm/releases/download/${manifest.tag}/${apkName}`);
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(manifest.size) && manifest.size > 0 && manifest.size <= 80 * 1024 * 1024);
  const url = `${base}/app-updates/${apkName}`;
  const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
  assert.equal(head.status, 200, 'Bundled APK HEAD must be public');
  assert.equal(head.headers.get('content-length'), String(manifest.size));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const apk = await fetch(url, { signal: AbortSignal.timeout(180000) });
  assert.equal(apk.status, 200, 'Bundled APK GET must be public');
  assert.equal(apk.headers.get('content-length'), String(manifest.size));
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of apk.body) {
    size += chunk.length;
    assert.ok(size <= manifest.size, 'Bundled APK response exceeds manifest size');
    hash.update(chunk);
  }
  assert.equal(size, manifest.size, 'Bundled APK response is incomplete');
  assert.equal(hash.digest('hex'), manifest.sha256, 'Bundled APK response differs from release manifest');
  console.log(`PASS bundled App update: public manifest, HEAD, ${manifest.tag} APK size and SHA-256 before setup`);
}
async function managed(container, volume) {
  start(container, volume);
  let base = await healthy(container);
  assert.notEqual(docker(['exec', container, 'id', '-u']), '0');
  await bundledAppUpdate(base);
  assert.equal((await request(base, '/v1/setup', 200)).initialized, false);
  await request(base, '/v1/snapshot', 409);
  const code = docker(['logs', container]).match(/^KDYZM_SETUP_CODE=([\w-]+)$/m)?.[1];
  assert.ok(code, 'Missing first-access setup code');
  const password = randomBytes(24).toString('hex');
  const nextPassword = randomBytes(24).toString('hex');
  await request(base, '/v1/setup', 401, { method: 'POST', body: { setupCode: 'incorrect', password } });
  await request(base, '/v1/setup', 200, { method: 'POST', body: { setupCode: code, password, baseUrl: '' } });
  await request(base, '/v1/setup', 409, { method: 'POST', body: { setupCode: code, password } });
  await request(base, '/v1/admin/status', 401);
  let { token } = await request(base, '/v1/admin/login', 200, { method: 'POST', body: { password } });
  const { account } = await request(base, '/v1/admin/accounts', 201, { method: 'POST', token, body: testAccount });
  assert.equal(account.enabled, false); // Never contact an upstream platform during acceptance.
  const pairBody = { accountIds: [account.id] };
  assert.equal((await request(base, '/v1/pairing-codes', 409, { method: 'POST', token, body: pairBody })).error.code, 'BASE_URL_REQUIRED');
  await request(base, '/v1/admin/settings', 200, { method: 'PATCH', token, body: { baseUrl: 'https://pickup.example' } });
  const pair = await request(base, '/v1/pairing-codes', 201, { method: 'POST', token, body: pairBody });
  assert.equal(JSON.parse(pair.qrPayload).baseUrl, 'https://pickup.example');
  const saved = savedState(container, account.id, password);
  assert.equal(saved.permissions, 0o600);
  assert.equal(saved.cookieMatches && saved.setupConsumed && saved.passwordHashed, true);
  docker(['restart', container]);
  base = await healthy(container);
  assert.equal((await request(base, '/v1/setup', 200)).initialized, true);
  await request(base, '/v1/admin/status', 401, { token });
  ({ token } = await request(base, '/v1/admin/login', 200, { method: 'POST', body: { password } }));
  const persisted = await request(base, '/v1/admin/accounts', 200, { token });
  assert.equal(persisted.accounts.length, 1);
  assert.equal(persisted.accounts[0].id, account.id);
  assert.equal(persisted.accounts[0].enabled, false);
  assert.equal((await request(base, '/v1/admin/status', 200, { token })).baseUrl, 'https://pickup.example');
  assert.deepEqual(savedState(container, account.id, password), saved);
  const changed = await request(base, '/v1/admin/password', 200, { method: 'POST', token,
    body: { currentPassword: password, password: nextPassword } });
  await request(base, '/v1/admin/status', 401, { token });
  await request(base, '/v1/admin/status', 200, { token: changed.token });
  await request(base, '/v1/admin/login', 401, { method: 'POST', body: { password } });
  docker(['rm', '-f', container]);
  start(container, volume);
  base = await healthy(container);
  await request(base, '/v1/admin/status', 401, { token: changed.token });
  await request(base, '/v1/admin/login', 200, { method: 'POST', body: { password: nextPassword } });
  assert.deepEqual(savedState(container, account.id, nextPassword), saved);
  assert.ok(!docker(['logs', container]).includes('KDYZM_SETUP_CODE='));
  console.log('PASS managed container: no preset secrets, first-access setup, login, settings, password change, mode 0600, Cookie decryption, restart and recreation persistence');
}
async function legacy(container, volume) {
  start(container, volume, true);
  let base = await healthy(container);
  assert.equal((await request(base, '/v1/setup', 200)).mode, 'environment');
  await request(base, '/v1/snapshot', 401);
  const { token } = await request(base, '/v1/admin/login', 200, { method: 'POST', body: { password: adminToken } });
  const { account } = await request(base, '/v1/admin/accounts', 201, { method: 'POST', token, body: testAccount });
  assert.equal(account.enabled, false);
  await request(base, '/v1/admin/settings', 409, { method: 'PATCH', token, body: { baseUrl: 'https://pickup.example' } });
  docker(['restart', container]);
  base = await healthy(container);
  const { accounts } = await request(base, '/v1/admin/accounts', 200, { token: adminToken });
  assert.equal(accounts[0].id, account.id);
  assert.equal(accounts[0].enabled, false);
  console.log('PASS legacy container: original environment values, direct token, login, read-only settings and database persistence');
}
for (const [mode, verify] of [['managed', managed], ['legacy', legacy]]) {
  const container = `kdyzm-smoke-${mode}-${suffix}`, volume = `${container}-data`;
  try {
    docker(['volume', 'create', volume]);
    await verify(container, volume);
  } finally {
    docker(['rm', '-f', container], false);
    docker(['volume', 'rm', volume], false);
  }
}
