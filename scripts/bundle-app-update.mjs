import assert from 'node:assert/strict';
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { REPOSITORY, verifyBundle } from './app-release.mjs';

const TAG = /^app-v(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const MAX_APK = 80 * 1024 * 1024;
const API = `https://api.github.com/repos/${REPOSITORY}/releases/`;
const DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

function validateUrl(value, api) {
  const url = new URL(value);
  assert.ok(url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash,
    'App update downloads require an ordinary HTTPS URL');
  assert.ok(api ? url.hostname === 'api.github.com' && url.href.startsWith(API) : DOWNLOAD_HOSTS.has(url.hostname),
    'App update download redirected outside GitHub');
  return url.href;
}
async function responseFor(url, { fetchImpl, signal, api = false, token }) {
  for (let redirects = 0; redirects <= 5; redirects++) {
    url = validateUrl(url, api);
    const response = await fetchImpl(url, { redirect: 'manual', signal,
      headers: api ? { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
        ...(token ? { authorization: `Bearer ${token}` } : {}) } : {} });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      assert.ok(redirects < 5, 'Too many App update download redirects');
      const location = response.headers.get('location');
      assert.ok(location, 'App update download redirect has no location');
      url = new URL(location, url).href;
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`App update request failed with HTTP ${response.status}`);
    }
    assert.ok(response.body, 'App update response has no body');
    return response;
  }
}
async function contentLength(response, maximum) {
  const value = response.headers.get('content-length');
  if (value !== null && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum)) {
    await response.body.cancel();
    throw new Error('App update response exceeds its size limit');
  }
}
async function releaseMetadata(url, options) {
  const signal = AbortSignal.timeout(options.timeoutMs);
  const response = await responseFor(url, { ...options, signal, api: true });
  await contentLength(response, 1024 * 1024);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert.ok(size <= 1024 * 1024, 'GitHub release metadata is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function download(url, filename, expectedSize, maximum, options) {
  assert.ok(Number.isSafeInteger(expectedSize) && expectedSize > 0 && expectedSize <= maximum,
    'GitHub release asset has an invalid size');
  const signal = AbortSignal.timeout(options.timeoutMs);
  const response = await responseFor(url, { ...options, signal });
  await contentLength(response, maximum);
  let size = 0;
  const limit = new Transform({ transform(chunk, encoding, callback) {
    size += chunk.length;
    callback(size <= expectedSize && size <= maximum ? null : new Error('App update response exceeds its size limit'), chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(filename, { flags: 'wx' }), { signal });
  assert.equal(size, expectedSize, 'GitHub release asset download is incomplete');
}

export async function bundleAppUpdate({ tag, outputDirectory = resolve('app-updates'), fetchImpl = fetch,
  timeoutMs = 180000, token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN } = {}) {
  if (tag !== undefined) assert.match(tag, TAG, 'Expected an app-vX.Y.Z release tag');
  const options = { fetchImpl, timeoutMs, token };
  const release = await releaseMetadata(API + (tag ? `tags/${tag}` : 'latest'), options);
  assert.equal(release.draft, false, 'Cannot bundle a draft App release');
  assert.equal(release.prerelease, false, 'Cannot bundle an App prerelease');
  assert.match(release.tag_name, TAG, 'Latest must be a stable App release');
  if (tag) assert.equal(release.tag_name, tag, 'GitHub returned a different App release');
  tag = release.tag_name;
  const version = tag.slice(5), apkName = `PickCode-private-${version}.apk`;
  const baseUrl = `https://github.com/${REPOSITORY}/releases/download/${tag}/`;
  const files = [['app-update.json', 65536], ['SHA256SUMS', 1024], [apkName, MAX_APK]];
  assert.ok(Array.isArray(release.assets), 'GitHub release has no assets');
  const assets = files.map(([name, maximum]) => {
    const matches = release.assets.filter(asset => asset.name === name);
    assert.equal(matches.length, 1, `App release must contain exactly one ${name}`);
    assert.equal(matches[0].browser_download_url, baseUrl + name, 'App release asset URL is not canonical');
    assert.ok(Number.isSafeInteger(matches[0].size) && matches[0].size > 0 && matches[0].size <= maximum,
      `App release asset ${name} exceeds its size limit`);
    return matches[0];
  });
  const target = resolve(outputDirectory);
  mkdirSync(dirname(target), { recursive: true });
  const staging = mkdtempSync(join(dirname(target), '.app-updates-'));
  const backup = staging + '-previous';
  let movedPrevious = false;
  try {
    for (let i = 0; i < files.length; i++) {
      const [name, maximum] = files[i], asset = assets[i];
      await download(asset.browser_download_url, join(staging, name), asset.size, maximum, options);
      chmodSync(join(staging, name), 0o644);
      if (i === 0) {
        const manifest = JSON.parse(readFileSync(join(staging, name), 'utf8'));
        assert.equal(manifest.tag, tag, 'Manifest does not describe the selected App release');
        assert.equal(manifest.versionName, version);
        assert.equal(manifest.apkUrl, baseUrl + apkName, 'Manifest APK URL is not canonical');
        assert.equal(manifest.size, assets[2].size, 'Manifest and GitHub APK sizes differ');
      }
    }
    const result = verifyBundle(staging);
    chmodSync(staging, 0o755);
    if (existsSync(target)) { renameSync(target, backup); movedPrevious = true; }
    try { renameSync(staging, target); }
    catch (error) { if (movedPrevious) renameSync(backup, target); throw error; }
    if (movedPrevious) rmSync(backup, { recursive: true, force: true });
    return result;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export function parseArguments(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(['--tag', '--out-dir'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--'),
      'Usage: bundle-app-update.mjs [--tag app-vX.Y.Z] [--out-dir directory]');
    const key = args[i] === '--tag' ? 'tag' : 'outputDirectory';
    assert.ok(!Object.hasOwn(options, key), 'Duplicate App bundle option');
    options[key] = args[i + 1];
  }
  return options;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { manifest } = await bundleAppUpdate(parseArguments(process.argv.slice(2)));
    console.log(`Bundled verified ${manifest.tag} (${manifest.size} bytes) for offline container updates`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
