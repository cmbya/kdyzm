import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXTENSION_NAME = '取件助手 · 登录同步';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowed = new Set(['.json', '.mjs', '.js', '.html', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.txt', '.md', '.woff', '.woff2']);
const sha256 = data => createHash('sha256').update(data).digest('hex');
export function safePackagePath(path) {
  return typeof path === 'string' && path.length <= 180 && path.split('/').every(part =>
    /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..' && !/[. ]$/.test(part) &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)) && allowed.has(extname(path).toLowerCase());
}

// Small stored ZIP writer: packages need no platform archiver or npm dependency.
// The updater validates paths independently before opening any entry for writing.
export function createStoredZip(entries) {
  const records = [], directory = [];
  let offset = 0;
  for (const { path, data, externalAttributes = 0 } of entries) {
    const name = Buffer.from(path), bytes = Buffer.from(data);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(externalAttributes >>> 0, 38); central.writeUInt32LE(offset, 42);
    records.push(local, name, bytes); directory.push(central, name);
    offset += local.length + name.length + bytes.length;
  }
  assert.ok(entries.length <= 65535 && offset <= 0xffffffff, 'Package exceeds ZIP limits');
  const end = Buffer.alloc(22), centralBytes = Buffer.concat(directory);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, centralBytes, end]);
}

export function packageCookieExtension({ sourceDirectory = join(root, 'cookie-extension'), outputDirectory } = {}) {
  assert.ok(outputDirectory, 'An explicit --out-dir is required');
  const source = resolve(sourceDirectory), target = resolve(outputDirectory);
  assert.ok(!lstatSync(source).isSymbolicLink(), 'Package source cannot be a link');
  const normalizedSource = source.toLowerCase(), normalizedTarget = target.toLowerCase();
  assert.ok(normalizedTarget !== normalizedSource && !normalizedTarget.startsWith(normalizedSource + '/') && !normalizedTarget.startsWith(normalizedSource + '\\'), 'Output must be outside extension source');
  const entries = [], seen = new Set();
  function collect(directory, prefix = '') {
    for (const name of readdirSync(directory).sort()) {
      const full = join(directory, name), relative = prefix + name, stat = lstatSync(full);
      assert.ok(!stat.isSymbolicLink(), 'Package source cannot contain links');
      if (stat.isDirectory()) { collect(full, relative + '/'); continue; }
      assert.ok(stat.isFile() && safePackagePath(relative), `Unsupported package file: ${relative}`);
      assert.ok(!seen.has(relative.toLowerCase()), 'Case-insensitive duplicate package path');
      seen.add(relative.toLowerCase());
      entries.push({ path: relative, data: readFileSync(full) });
    }
  }
  collect(source);
  assert.ok(entries.length > 0 && entries.length <= 256, 'Package must contain 1-256 files');
  assert.ok(entries.reduce((total, file) => total + file.data.length, 0) <= 16 * 1024 * 1024, 'Package exceeds 16 MiB');
  const manifest = JSON.parse(entries.find(file => file.path === 'manifest.json')?.data.toString('utf8'));
  assert.equal(manifest.name, EXTENSION_NAME); assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/);
  assert.ok(manifest.version.split('.').every(n => Number(n) <= 65535), 'Invalid Chrome extension version');
  for (const required of ['background.mjs', 'options.html', 'core.mjs']) assert.ok(seen.has(required), `Missing ${required}`);
  const version = manifest.version, archiveName = `cookie-extension-${version}.zip`, zip = createStoredZip(entries);
  const update = { schemaVersion: 1, product: 'pickcode-cookie-extension', name: EXTENSION_NAME, version,
    tag: `cookie-extension-v${version}`, archive: { name: archiveName, size: zip.length, sha256: sha256(zip) },
    files: entries.map(({ path, data }) => ({ path, size: data.length, sha256: sha256(data) })) };
  const updateBytes = Buffer.from(JSON.stringify(update, null, 2) + '\n');
  const updaterEntries = ['Update-CookieExtension.ps1', 'Update-CookieExtension.cmd', 'README.md'].map(path => {
    let data = readFileSync(join(root, 'cookie-extension-update', path));
    if (path.endsWith('.cmd')) data = Buffer.from(data.toString('utf8').replace(/\r?\n/g, '\r\n'));
    return { path, data };
  });
  updaterEntries.push({ path: 'cookie-extension-update.json', data: updateBytes }, { path: archiveName, data: zip });
  // Refuse an existing destination: no release or unrelated output can be replaced accidentally.
  mkdirSync(target, { recursive: false });
  const outputs = [...updaterEntries, { path: `cookie-extension-updater-${version}.zip`, data: createStoredZip(updaterEntries) }];
  for (const { path, data } of outputs) writeFileSync(join(target, path), data, { flag: 'wx' });
  writeFileSync(join(target, 'COOKIE-EXTENSION-SHA256SUMS'), outputs.map(file => `${sha256(file.data)}  ${file.path}\n`).join(''), { flag: 'wx' });
  return { version, directory: target, files: outputs.map(file => file.path) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      assert.ok(['--out-dir', '--source-dir'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--'),
        'Usage: node scripts/package-cookie-extension.mjs --out-dir NEW_DIRECTORY [--source-dir DIRECTORY]');
      const key = args[i] === '--out-dir' ? 'outputDirectory' : 'sourceDirectory';
      assert.ok(!Object.hasOwn(options, key), 'Duplicate option'); options[key] = args[i + 1];
    }
    console.log(JSON.stringify(packageCookieExtension(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
