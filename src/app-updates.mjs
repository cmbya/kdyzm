import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { fail } from './security.mjs';

const DEFAULT_DIRECTORY = new URL('../app-updates/', import.meta.url);
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const APK_PATH = /^\/app-updates\/PickCode-private-(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.apk$/;
const MANIFEST_PATH = '/app-updates/app-update.json';
const MAX_APK = 80 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sameFile = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);

function validateManifest(m) {
  const date = m?.publishedAt;
  const validDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(date)
    && Number.isFinite(Date.parse(date)) && new Date(date).toISOString() === date;
  const apkName = `PickCode-private-${m?.versionName}.apk`;
  if (!m || m.schemaVersion !== 1 || m.packageName !== 'local.pickcode.assistant'
    || typeof m.versionName !== 'string' || !VERSION.test(m.versionName) || m.tag !== `app-v${m.versionName}`
    || !Number.isSafeInteger(m.versionCode) || m.versionCode <= 0 || m.versionCode > 2100000000
    || !Number.isInteger(m.minSdk) || m.minSdk < 23 || m.minSdk > 100
    || !Number.isSafeInteger(m.size) || m.size <= 0 || m.size > MAX_APK
    || typeof m.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.sha256)
    || typeof m.notes !== 'string' || !m.notes.trim() || m.notes.length > 8000 || !validDate
    || m.apkUrl !== `https://github.com/zsdd2/kdyzm/releases/download/${m.tag}/${apkName}`) throw new Error('Invalid app update manifest');
  return apkName;
}

async function fileState(filename, limit) {
  const state = await lstat(filename);
  if (!state.isFile() || state.size > limit) throw new Error('Invalid app update file');
  return state;
}

export function createAppUpdateHandler({ directory = DEFAULT_DIRECTORY } = {}) {
  directory = directory instanceof URL ? fileURLToPath(directory) : directory;
  const manifestFile = join(directory, 'app-update.json');
  const sumsFile = join(directory, 'SHA256SUMS');
  let cached;
  let loading;

  async function verify() {
    const manifestState = await fileState(manifestFile, 65536);
    const raw = await readFile(manifestFile);
    const manifest = JSON.parse(raw);
    const apkName = validateManifest(manifest);
    const apkFile = join(directory, apkName);
    const apkState = await fileState(apkFile, MAX_APK);
    if (apkState.size !== manifest.size) throw new Error('App update size mismatch');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(apkFile)) hash.update(chunk);
    if (hash.digest('hex') !== manifest.sha256) throw new Error('App update checksum mismatch');
    const sumsState = await fileState(sumsFile, 1024);
    const expected = `${manifest.sha256}  ${apkName}\n${digest(raw)}  app-update.json\n`;
    if (await readFile(sumsFile, 'utf8') !== expected) throw new Error('App update checksum list mismatch');
    const files = [[manifestFile, manifestState, 65536], [apkFile, apkState, MAX_APK], [sumsFile, sumsState, 1024]];
    const current = await Promise.all(files.map(([file, , limit]) => fileState(file, limit)));
    if (!files.every(([, state], i) => sameFile(state, current[i]))) throw new Error('App update changed during verification');
    return { raw, apkFile, apkState, apkPath: `/app-updates/${apkName}`, manifest, files, manifestEtag: `"${digest(raw)}"` };
  }

  function load() {
    if (loading) return loading;
    loading = (async () => {
      try {
        if (cached) {
          const current = await Promise.all(cached.files.map(([file, , limit]) => fileState(file, limit)));
          if (cached.files.every(([, state], i) => sameFile(state, current[i]))) return cached;
        }
        cached = await verify();
        return cached;
      } catch (error) {
        cached = undefined;
        throw error;
      }
    })().finally(() => { loading = undefined; });
    return loading;
  }

  // Validate separately from downloads; a missing bundle must never prevent server startup.
  void load().catch(() => {});

  return async function serveAppUpdate(req, res) {
    const path = (req.url || '').split('?')[0];
    if (!path.startsWith('/app-updates')) return false;
    if (!['GET', 'HEAD'].includes(req.method) || (path !== MANIFEST_PATH && !APK_PATH.test(path))) fail(404, 'NOT_FOUND', '接口不存在');
    let bundle;
    try { bundle = await load(); }
    catch (error) { fail(error.code === 'ENOENT' ? 404 : 503, 'APP_UPDATE_UNAVAILABLE', '内置更新暂不可用'); }
    if (path !== MANIFEST_PATH && path !== bundle.apkPath) fail(404, 'NOT_FOUND', '接口不存在');
    const isManifest = path === MANIFEST_PATH;
    const headers = {
      'Content-Type': isManifest ? 'application/json; charset=utf-8' : 'application/vnd.android.package-archive',
      'Content-Length': isManifest ? bundle.raw.length : bundle.manifest.size,
      'ETag': isManifest ? bundle.manifestEtag : `"${bundle.manifest.sha256}"`,
      'Cache-Control': isManifest ? 'no-store' : 'public, max-age=31536000, immutable'
    };
    if (req.method === 'HEAD' || isManifest) {
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : bundle.raw);
      return true;
    }
    let file;
    try {
      file = await open(bundle.apkFile, 'r');
      if (!sameFile(bundle.apkState, await file.stat())) throw new Error('App update changed before download');
    } catch {
      await file?.close().catch(() => {});
      cached = undefined;
      fail(503, 'APP_UPDATE_UNAVAILABLE', '内置更新暂不可用');
    }
    res.writeHead(200, headers);
    try { await pipeline(file.createReadStream(), res); }
    catch { if (!res.destroyed) res.destroy(); }
    finally { await file.close().catch(() => {}); }
    return true;
  };
}
