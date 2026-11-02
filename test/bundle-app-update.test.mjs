import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleAppUpdate, parseArguments } from '../scripts/bundle-app-update.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const api = 'https://api.github.com/repos/zsdd2/kdyzm/releases/';
const tag = 'app-v3.1.4';
const apkName = 'PickCode-private-3.1.4.apk';
const base = `https://github.com/zsdd2/kdyzm/releases/download/${tag}/`;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'app-bundle-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('synthetic-apk-bytes');
  const manifest = { schemaVersion: 1, packageName: 'local.pickcode.assistant', versionName: '3.1.4',
    versionCode: 30104, minSdk: 23, tag, apkUrl: base + apkName, sha256: digest(bytes), size: bytes.length,
    notes: '保留数据', publishedAt: '2026-11-03T01:00:00.000Z' };
  const raw = Buffer.from(JSON.stringify(manifest, null, 4) + '\n');
  const files = new Map([['app-update.json', raw], [apkName, bytes],
    ['SHA256SUMS', Buffer.from(`${manifest.sha256}  ${apkName}\n${digest(raw)}  app-update.json\n`)]]);
  const release = { draft: false, prerelease: false, tag_name: tag,
    assets: [...files].map(([name, content]) => ({ name, size: content.length, browser_download_url: base + name })) };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if ([api + 'latest', api + `tags/${tag}`].includes(url)) return Response.json(release);
    const content = files.get(url.slice(base.length));
    assert.ok(url.startsWith(base) && content, `Unexpected fixture request ${url}`);
    return new Response(content);
  };
  return { directory, outputDirectory: join(directory, 'app-updates'), bytes, manifest, raw, files, release, calls, fetchImpl };
}
test('Latest is resolved once, downloads are pinned, and original release bytes survive bundling', async t => {
  const f = fixture(t);
  const result = await bundleAppUpdate(f);
  assert.deepEqual(result.manifest, f.manifest);
  assert.deepEqual(readdirSync(f.outputDirectory).sort(), [...f.files.keys()].sort());
  for (const [name, bytes] of f.files) assert.deepEqual(readFileSync(join(f.outputDirectory, name)), bytes);
  if (process.platform !== 'win32') {
    assert.equal(statSync(f.outputDirectory).mode & 0o777, 0o755);
    for (const name of f.files.keys()) assert.equal(statSync(join(f.outputDirectory, name)).mode & 0o777, 0o644);
  }
  assert.equal(f.calls[0].url, api + 'latest');
  assert.equal(f.calls.filter(call => call.url.startsWith(api)).length, 1);
  assert.ok(f.calls.slice(1).every(call => call.url.startsWith(base)));
});
test('explicit tag replaces a complete prior bundle only after validation', async t => {
  const f = fixture(t);
  await bundleAppUpdate({ ...f, tag });
  writeFileSync(join(f.outputDirectory, 'old.apk'), 'old version');
  await bundleAppUpdate({ ...f, tag });
  assert.equal(f.calls[0].url, api + `tags/${tag}`);
  assert.ok(!existsSync(join(f.outputDirectory, 'old.apk')));
  assert.deepEqual(readdirSync(f.directory), ['app-updates']);
});
test('drafts, prereleases, non-App tags and invalid asset locations are rejected', async t => {
  for (const change of [
    f => { f.release.draft = true; }, f => { f.release.prerelease = true; },
    f => { f.release.tag_name = 'v3.1.14'; }, f => { f.release.tag_name = 'app-v3.1.5'; },
    f => { f.release.assets[0].browser_download_url = 'https://attacker.example/app-update.json'; },
    f => { f.release.assets.push(f.release.assets[0]); }, f => { f.release.assets.pop(); }
  ]) {
    const f = fixture(t); change(f);
    await assert.rejects(bundleAppUpdate({ ...f, tag }));
    assert.ok(!existsSync(f.outputDirectory));
  }
});
test('size, SHA-256 and the complete SHA256SUMS are required before replacing an existing bundle', async t => {
  for (const change of [
    f => { f.files.set(apkName, Buffer.from('modified-apk-bytes!')); },
    f => { f.files.set(apkName, f.bytes.subarray(1)); },
    f => { f.files.set('SHA256SUMS', Buffer.from('0'.repeat(f.files.get('SHA256SUMS').length))); },
    f => { f.files.set('app-update.json', Buffer.from(f.raw.toString().replace('30104', '30105'))); }
  ]) {
    const f = fixture(t); await bundleAppUpdate(f);
    change(f);
    await assert.rejects(bundleAppUpdate(f));
    assert.deepEqual(readFileSync(join(f.outputDirectory, apkName)), f.bytes);
    assert.deepEqual(readFileSync(join(f.outputDirectory, 'app-update.json')), f.raw);
    assert.deepEqual(readdirSync(f.directory), ['app-updates']);
  }
});
test('asset and API limits apply to advertised sizes and streamed bodies', async t => {
  for (const [name, maximum] of [['app-update.json', 65536], ['SHA256SUMS', 1024], [apkName, 80 * 1024 * 1024]]) {
    const f = fixture(t);
    f.release.assets.find(asset => asset.name === name).size = maximum + 1;
    await assert.rejects(bundleAppUpdate(f), /size limit/);
    assert.equal(f.calls.length, 1);
  }
  for (const modify of [
    (url, f) => url === api + 'latest' ? new Response('x'.repeat(1024 * 1024 + 1)) : undefined,
    (url, f) => url === base + apkName ? new Response(Buffer.concat([f.bytes, Buffer.from('extra')])) : undefined,
    (url, f) => url === base + 'app-update.json' ? new Response(f.raw, { headers: { 'content-length': '65537' } }) : undefined,
    (url, f) => url === base + apkName ? new Response(f.bytes, { headers: { 'content-length': 'invalid' } }) : undefined
  ]) {
    const f = fixture(t);
    await assert.rejects(bundleAppUpdate({ ...f, fetchImpl: async (url, options) => modify(url, f) || f.fetchImpl(url, options) }));
    assert.ok(!existsSync(f.outputDirectory));
    assert.deepEqual(readdirSync(f.directory), []);
  }
});
test('only HTTPS GitHub asset redirects are followed and API credentials stay off asset requests', async t => {
  const f = fixture(t);
  const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/fixture?signature=synthetic';
  await bundleAppUpdate({ ...f, token: 'synthetic-token', fetchImpl: async (url, options) => {
    if (url === base + apkName) return new Response(null, { status: 302, headers: { location: cdn } });
    if (url === cdn) { assert.deepEqual(options.headers, {}); return new Response(f.bytes); }
    return f.fetchImpl(url, options);
  } });
  assert.equal(f.calls[0].options.headers.authorization, 'Bearer synthetic-token');
  assert.ok(f.calls.slice(1).every(call => !call.options.headers.authorization));
  for (const location of ['http://github.com/file.apk', 'https://attacker.example/file.apk',
    'https://github.com:444/file.apk', 'https://user:pass@github.com/file.apk', 'https://github.com/file.apk#fragment']) {
    await assert.rejects(bundleAppUpdate({ ...f, fetchImpl: async (url, options) =>
      url === base + apkName ? new Response(null, { status: 302, headers: { location } }) : f.fetchImpl(url, options) }));
  }
});
test('failed, partial, looping and timed out requests never produce a bundle', async t => {
  for (const status of [404, 500, 206]) {
    const f = fixture(t);
    await assert.rejects(bundleAppUpdate({ ...f, fetchImpl: async () => new Response('failure', { status }) }));
    assert.ok(!existsSync(f.outputDirectory));
  }
  const looping = fixture(t);
  await assert.rejects(bundleAppUpdate({ ...looping, fetchImpl: async () =>
    new Response(null, { status: 302, headers: { location: api + 'latest' } }) }), /redirects/);
  const timed = fixture(t);
  await assert.rejects(bundleAppUpdate({ ...timed, timeoutMs: 5, fetchImpl: async (url, { signal }) =>
    new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      setTimeout(resolve, 50); }) }), /timeout/i);
  const stalled = fixture(t);
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(bundleAppUpdate({ ...stalled, timeoutMs: 30, fetchImpl: async (url, options) =>
      url === base + apkName ? new Response(new ReadableStream({ start() {} })) : stalled.fetchImpl(url, options) }),
    { name: 'AbortError' });
    assert.deepEqual(readdirSync(stalled.directory), []);
  } finally { clearTimeout(keepAlive); }
});
test('CLI accepts only an optional tag and output directory and rejects arbitrary URL input', async t => {
  assert.deepEqual(parseArguments(['--tag', tag, '--out-dir', 'app-updates']), { tag, outputDirectory: 'app-updates' });
  for (const args of [['--url', base], ['--tag'], ['--tag', tag, '--tag', tag], ['--out-dir', '--tag']])
    assert.throws(() => parseArguments(args));
  const f = fixture(t);
  for (const invalid of ['latest', 'app-v3.1', 'app-v03.1.4', 'https://github.com/app-v3.1.4'])
    await assert.rejects(bundleAppUpdate({ ...f, tag: invalid }));
  assert.equal(f.calls.length, 0);
});
