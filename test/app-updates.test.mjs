import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/service.mjs';

const APK_NAME = 'PickCode-private-3.1.17.apk';
const MANIFEST_PATH = '/app-updates/app-update.json';
const APK_PATH = `/app-updates/${APK_NAME}`;
const ADMIN = 'app-update-test-admin-with-at-least-32-characters';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function writeBundle(directory, { bytes = Buffer.from('PK synthetic release artifact\n'), change = {} } = {}) {
  const manifest = { schemaVersion: 1, packageName: 'local.pickcode.assistant', versionName: '3.1.17', versionCode: 317,
    minSdk: 23, tag: 'app-v3.1.17', apkUrl: `https://github.com/zsdd2/kdyzm/releases/download/app-v3.1.17/${APK_NAME}`,
    sha256: digest(bytes), size: bytes.length, notes: '内置更新测试', publishedAt: '2026-11-02T18:00:00.000Z', ...change };
  const raw = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(directory, 'app-update.json'), raw);
  writeFileSync(join(directory, APK_NAME), bytes);
  writeFileSync(join(directory, 'SHA256SUMS'), `${manifest.sha256}  ${APK_NAME}\n${digest(raw)}  app-update.json\n`);
  return { manifest, raw, bytes };
}

async function harness(t, { bundle = true, legacy = false, ...options } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pickcode-app-updates-'));
  const updates = join(directory, 'app-updates');
  mkdirSync(updates);
  const release = bundle ? writeBundle(updates, options) : undefined;
  const service = createService({ filename: join(directory, 'data', 'pickcode.db'), scheduler: false,
    appUpdateDirectory: updates, log: () => {}, ...(legacy ? { encryptionKey: 'ab'.repeat(32), adminToken: ADMIN } : {}) });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const port = service.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const request = (path, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
  return { directory, updates, release, service, base, port, request };
}

test('uninitialized service exposes only the exact release artifacts without credentials and preserves the raw official manifest', async t => {
  const h = await harness(t);
  const manifest = await h.request(MANIFEST_PATH, { headers: { Host: 'attacker.invalid' } });
  assert.equal(manifest.status, 200);
  assert.deepEqual(manifest.body, h.release.raw);
  assert.match(manifest.headers['content-type'], /^application\/json/);
  assert.equal(manifest.headers['content-length'], String(h.release.raw.length));
  assert.equal(manifest.headers['cache-control'], 'no-store');
  assert.equal(manifest.headers.etag, `"${digest(h.release.raw)}"`);
  assert.equal(manifest.headers.location, undefined);
  const apk = await h.request(APK_PATH);
  assert.equal(apk.status, 200);
  assert.deepEqual(apk.body, h.release.bytes);
  assert.equal(apk.headers['content-type'], 'application/vnd.android.package-archive');
  assert.equal(apk.headers['content-length'], String(h.release.bytes.length));
  assert.equal(apk.headers.etag, `"${h.release.manifest.sha256}"`);
  assert.equal(apk.headers['cache-control'], 'public, max-age=31536000, immutable');
  for (const [path, get] of [[MANIFEST_PATH, manifest], [APK_PATH, apk]]) {
    const head = await h.request(path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    for (const name of ['content-type', 'content-length', 'etag', 'cache-control']) assert.equal(head.headers[name], get.headers[name]);
  }
  assert.equal((await h.request('/health')).status, 200);
  const setup = await h.request('/v1/setup');
  assert.equal(JSON.parse(setup.body).initialized, false);
  assert.equal((await h.request('/v1/snapshot')).status, 409);
});

test('release routes reject traversal, non-whitelisted files, other versions and write methods without leaking local data', async t => {
  const h = await harness(t);
  const secret = readFileSync(join(h.directory, 'data', 'service-config.json'));
  writeFileSync(join(h.updates, 'secret.txt'), secret);
  const paths = ['/app-updates', '/app-updates/', '/app-updates/SHA256SUMS', '/app-updates/secret.txt',
    '/app-updates/service-config.json', '/app-updates/PickCode-private-9.9.9.apk', '/app-updates/app-update.json/extra',
    '/app-updates/%61pp-update.json', '/app-updates/../data/service-config.json',
    '/app-updates/%2e%2e/data/service-config.json', '/app-updates/%2e%2e/app-updates/app-update.json',
    '/app-updates/..%2fdata/service-config.json', '/data/pickcode.db', '/service-config.json'];
  for (const path of paths) {
    const response = await h.request(path);
    assert.equal(response.status, 404, path);
    assert.ok(!response.body.includes(secret), path);
    assert.ok(!response.body.toString().includes(h.directory), path);
  }
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await h.request(MANIFEST_PATH, { method })).status, 404);
});

test('missing and incomplete bundles leave health and initialization available for GitHub fallback', async t => {
  const h = await harness(t, { bundle: false });
  for (const path of [MANIFEST_PATH, APK_PATH]) assert.equal((await h.request(path)).status, 404);
  assert.deepEqual(JSON.parse((await h.request('/health')).body), { ok: true });
  assert.equal((await h.request('/v1/setup')).status, 200);
  writeBundle(h.updates);
  rmSync(join(h.updates, APK_NAME));
  const incomplete = await h.request(MANIFEST_PATH);
  assert.ok([404, 503].includes(incomplete.status));
  assert.equal(incomplete.headers.location, undefined);
  assert.equal((await h.request('/health')).status, 200);
});

test('schema and official URL validation match the prepared release contract', async t => {
  const cases = [
    { schemaVersion: 2 }, { packageName: 'different.package' }, { versionName: '../data' }, { tag: 'app-v9.9.9' },
    { versionCode: 0 }, { versionCode: 2100000001 }, { minSdk: 22 }, { size: 80 * 1024 * 1024 + 1 },
    { sha256: 'A'.repeat(64) }, { notes: ' ' }, { publishedAt: '2026-02-30T00:00:00.000Z' },
    { apkUrl: `https://attacker.invalid/${APK_NAME}` },
    { apkUrl: `https://github.com/zsdd2/kdyzm/releases/download/app-v3.1.17/${APK_NAME}?redirect=1` }
  ];
  for (const change of cases) await t.test(Object.keys(change)[0] + ': ' + Object.values(change)[0], async child => {
    const h = await harness(child, { change });
    assert.equal((await h.request(MANIFEST_PATH)).status, 503);
    assert.equal((await h.request(APK_PATH)).status, 503);
    assert.equal((await h.request('/health')).status, 200);
  });
});

test('hash, size, checksum-list and JSON failures invalidate cached release artifacts and can recover', async t => {
  const h = await harness(t);
  assert.equal((await h.request(MANIFEST_PATH)).status, 200);
  const corrupt = Buffer.from(h.release.bytes);
  corrupt[0] ^= 1;
  writeFileSync(join(h.updates, APK_NAME), corrupt);
  assert.equal((await h.request(MANIFEST_PATH)).status, 503);
  assert.equal((await h.request(APK_PATH)).status, 503);
  writeBundle(h.updates, { bytes: Buffer.from('a different valid release payload') });
  assert.equal((await h.request(MANIFEST_PATH)).status, 200);
  writeFileSync(join(h.updates, APK_NAME), Buffer.from('short'));
  assert.equal((await h.request(MANIFEST_PATH)).status, 503);
  writeBundle(h.updates);
  writeFileSync(join(h.updates, 'SHA256SUMS'), 'wrong checksum list');
  assert.equal((await h.request(MANIFEST_PATH)).status, 503);
  writeFileSync(join(h.updates, 'app-update.json'), '{broken json');
  assert.equal((await h.request(MANIFEST_PATH)).status, 503);
  writeBundle(h.updates);
  assert.equal((await h.request(APK_PATH)).status, 200);
});

test('public release downloads preserve existing admin and device authentication', async t => {
  const h = await harness(t, { legacy: true });
  const response = await fetch(h.base + '/v1/admin/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN },
    body: JSON.stringify({ platform: 'taobao', label: 'private account', cookie: '_m_h5_tk=do-not-distribute; secret-cookie=private-data' }) });
  assert.equal(response.status, 201);
  for (const path of ['/v1/admin/accounts', '/v1/admin/devices', '/v1/accounts', '/v1/snapshot']) {
    const privateResponse = await h.request(path);
    assert.equal(privateResponse.status, 401);
    assert.ok(!privateResponse.body.toString().includes('private-data'));
  }
  assert.equal((await h.request(MANIFEST_PATH)).status, 200);
  assert.equal((await h.request(APK_PATH)).status, 200);
});

test('aborting a streamed APK download does not produce an unhandled error or interrupt health', async t => {
  const h = await harness(t, { bytes: Buffer.alloc(4 * 1024 * 1024, 42) });
  await new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: h.port, path: APK_PATH }, res => {
      assert.equal(res.statusCode, 200);
      res.on('error', () => {});
      res.once('data', () => { res.destroy(); req.destroy(); resolve(); });
    });
    req.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    req.end();
  });
  assert.equal((await h.request('/health')).status, 200);
  assert.equal((await h.request(APK_PATH, { method: 'HEAD' })).status, 200);
});
