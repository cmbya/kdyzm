import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStoredZip, EXTENSION_NAME, packageCookieExtension, safePackagePath } from '../scripts/package-cookie-extension.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'cookie-extension-update', 'Update-CookieExtension.ps1');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const windows = process.platform === 'win32';
const powershell = windows && spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0;
const psTest = (name, fn) => test(name, { skip: !powershell && 'Windows PowerShell is required for updater integration' }, fn);

function fixture(t, { nextKey, oldKey } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pickcode-updater-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = join(directory, 'loaded-extension'), source = join(directory, 'source'), output = join(directory, 'bundle'), state = join(directory, 'state');
  mkdirSync(source); mkdirSync(target);
  const manifest = (version, key) => JSON.stringify({ manifest_version: 3, name: EXTENSION_NAME, version,
    background: { service_worker: 'background.mjs', type: 'module' }, options_page: 'options.html', ...(key ? { key } : {}) });
  const old = { 'manifest.json': manifest('1.1.3', oldKey), 'background.mjs': '// old background', 'options.html': '<p>Old</p>', 'core.mjs': '// old core' };
  const next = { 'manifest.json': manifest('1.2.0', nextKey), 'background.mjs': '// new background', 'options.html': '<p>New</p>', 'core.mjs': '// new core', 'settings.css': 'body { color: black; }' };
  for (const [name, data] of Object.entries(old)) writeFileSync(join(target, name), data);
  writeFileSync(join(target, 'untouched.txt'), 'Local user file. Not in package.');
  for (const [name, data] of Object.entries(next)) writeFileSync(join(source, name), data);
  const result = packageCookieExtension({ sourceDirectory: source, outputDirectory: output });
  const manifestPath = join(output, 'cookie-extension-update.json');
  const update = JSON.parse(readFileSync(manifestPath));
  return { directory, target, source, output, state, old, next, result, manifestPath, update };
}
function run(f, extra = []) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, '-ExtensionDirectory', f.target,
    '-StateDirectory', f.state, '-PackageManifest', f.manifestPath, '-Apply', ...extra], { encoding: 'utf8', timeout: 30000 });
}
function text(result) { return result.stdout + result.stderr; }
function unchanged(f) {
  for (const [name, data] of Object.entries(f.old)) assert.equal(readFileSync(join(f.target, name), 'utf8'), data);
  assert.equal(readFileSync(join(f.target, 'untouched.txt'), 'utf8'), 'Local user file. Not in package.');
  assert.equal(existsSync(join(f.target, 'settings.css')), false);
}
function saveManifest(f) { writeFileSync(f.manifestPath, JSON.stringify(f.update)); }
function replaceZip(f, entries) {
  const bytes = createStoredZip(entries);
  writeFileSync(join(f.output, f.update.archive.name), bytes);
  f.update.archive.size = bytes.length; f.update.archive.sha256 = sha(bytes); saveManifest(f);
}
function entries(f) { return Object.entries(f.next).map(([path, data]) => ({ path, data })); }

test('packaging produces a self-contained offline updater without touching App release files', t => {
  const f = fixture(t);
  assert.equal(f.result.version, '1.2.0');
  for (const name of ['cookie-extension-1.2.0.zip', 'cookie-extension-updater-1.2.0.zip', 'cookie-extension-update.json',
    'Update-CookieExtension.cmd', 'Update-CookieExtension.ps1', 'README.md', 'COOKIE-EXTENSION-SHA256SUMS']) assert.ok(existsSync(join(f.output, name)), name);
  assert.equal(f.update.archive.sha256, sha(readFileSync(join(f.output, f.update.archive.name))));
  for (const file of f.update.files) assert.equal(file.sha256, sha(readFileSync(join(f.source, file.path))));
  assert.equal(existsSync(join(f.output, 'app-update.json')), false);
  assert.throws(() => packageCookieExtension({ sourceDirectory: f.source, outputDirectory: f.output }), /EEXIST/);
});

test('packager rejects unsafe, unsupported and duplicate Windows file names', t => {
  for (const path of ['../core.mjs', '/core.mjs', 'C:/core.mjs', 'dir\\core.mjs', 'aux.json', 'x./core.mjs', 'file.ps1', 'a//b.js']) assert.equal(safePackagePath(path), false, path);
  assert.equal(safePackagePath('assets/icon.png'), true);
  const f = fixture(t); writeFileSync(join(f.source, 'run.exe'), 'not executable');
  assert.throws(() => packageCookieExtension({ sourceDirectory: f.source, outputDirectory: join(f.directory, 'bad') }), /Unsupported package file/);
});

psTest('preview verifies every file without changing the original directory or saved path', t => {
  const f = fixture(t), result = run(f, ['-CheckOnly']);
  assert.equal(result.status, 0, text(result)); assert.match(text(result), /Current version: 1\.1\.3/); assert.match(text(result), /Target version:  1\.2\.0/);
  unchanged(f); assert.equal(existsSync(join(f.state, 'directory.json')), false);
});

psTest('updates the same directory, retains unrelated files and keeps previous version backup', t => {
  const f = fixture(t), result = run(f);
  assert.equal(result.status, 0, text(result));
  for (const [name, data] of Object.entries(f.next)) assert.equal(readFileSync(join(f.target, name), 'utf8'), data);
  assert.equal(readFileSync(join(f.target, 'untouched.txt'), 'utf8'), 'Local user file. Not in package.');
  assert.equal(JSON.parse(readFileSync(join(f.state, 'directory.json'))).directory, f.target);
  const backups = readdirSync(join(f.state, 'backups')); assert.equal(backups.length, 1);
  for (const [name, data] of Object.entries(f.old)) assert.equal(readFileSync(join(f.state, 'backups', backups[0], name), 'utf8'), data);
  assert.equal(existsSync(join(f.state, 'pending-update.json')), false);
  const again = run(f); assert.equal(again.status, 0, text(again)); assert.match(text(again), /No newer version/);
  assert.equal(readdirSync(join(f.state, 'backups')).length, 1);
});

psTest('can use the remembered directory on later invocations', t => {
  const f = fixture(t); assert.equal(run(f).status, 0);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, '-StateDirectory', f.state,
    '-PackageManifest', f.manifestPath, '-CheckOnly'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, text(result)); assert.match(text(result), /No newer version/);
});

psTest('rejects archive corruption and per-file checksum mismatches before touching installed files', t => {
  const f = fixture(t);
  writeFileSync(join(f.output, f.update.archive.name), 'corrupt');
  let result = run(f); assert.notEqual(result.status, 0); assert.match(text(result), /Archive SHA256 or size mismatch/); unchanged(f);
  replaceZip(f, entries(f)); f.update.files[0].sha256 = '0'.repeat(64); saveManifest(f);
  result = run(f); assert.notEqual(result.status, 0); assert.match(text(result), /File SHA256 mismatch/); unchanged(f);
});

for (const bad of ['../escaped.mjs', '/absolute.mjs', 'C:/escaped.mjs', 'dir\\escaped.mjs', 'aux.json', 'dir./escaped.mjs']) {
  psTest(`rejects unsafe ZIP path ${bad}`, t => {
    const f = fixture(t), list = entries(f); list[1].path = bad;
    replaceZip(f, list); const result = run(f);
    assert.notEqual(result.status, 0); assert.match(text(result), /Unsafe package path/); unchanged(f);
  });
}

psTest('rejects ZIP symlink attributes, unexpected files and case-insensitive duplicates', t => {
  const f = fixture(t), list = entries(f); list[1].externalAttributes = 0xa1ff0000;
  replaceZip(f, list); let result = run(f); assert.notEqual(result.status, 0); assert.match(text(result), /ZIP links/); unchanged(f);
  replaceZip(f, [...entries(f), { path: 'extra.js', data: 'unexpected' }]);
  result = run(f); assert.notEqual(result.status, 0); assert.match(text(result), /missing or unexpected files/); unchanged(f);
  const duplicate = entries(f); duplicate[1].path = 'MANIFEST.json'; replaceZip(f, duplicate);
  result = run(f); assert.notEqual(result.status, 0); assert.match(text(result), /Duplicate or undeclared ZIP entry/); unchanged(f);
});

psTest('rejects duplicate manifest paths and package / extension version disagreement', t => {
  const f = fixture(t); f.update.files.push({ ...f.update.files[0] }); saveManifest(f);
  let result = run(f); assert.notEqual(result.status, 0); assert.match(text(result), /Duplicate manifest path/); unchanged(f);
  f.update.files.pop(); f.next['manifest.json'] = f.next['manifest.json'].replace('1.2.0', '1.2.1');
  f.update.files.find(file => file.path === 'manifest.json').sha256 = sha(f.next['manifest.json']);
  replaceZip(f, entries(f)); result = run(f); assert.notEqual(result.status, 0); assert.match(text(result), /version differs/); unchanged(f);
});

psTest('rejects non-extension targets and extension key changes', t => {
  const f = fixture(t, { nextKey: 'new-key' });
  let result = run(f); assert.notEqual(result.status, 0); assert.match(text(result), /cannot change extension key/); unchanged(f);
  const manifest = JSON.parse(f.old['manifest.json']); manifest.name = 'Unrelated extension';
  writeFileSync(join(f.target, 'manifest.json'), JSON.stringify(manifest));
  result = run(f); assert.notEqual(result.status, 0); assert.match(text(result), /not the PickCode/);
  assert.equal(readFileSync(join(f.target, 'background.mjs'), 'utf8'), f.old['background.mjs']);
});

psTest('rejects target directory junctions without writing through them', t => {
  const f = fixture(t), alias = join(f.directory, 'junction'); symlinkSync(f.target, alias, 'junction');
  const actualTarget = f.target; f.target = alias;
  const result = run(f); assert.notEqual(result.status, 0); assert.match(text(result), /Links\/reparse/);
  f.target = actualTarget; unchanged(f);
});

psTest('rejects nested target junctions and leaves files outside the extension untouched', t => {
  const f = fixture(t), outside = join(f.directory, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'worker.js'), 'outside user data');
  symlinkSync(outside, join(f.target, 'assets'), 'junction');
  f.next['assets/worker.js'] = '// new asset';
  f.update.files.push({ path: 'assets/worker.js', size: Buffer.byteLength(f.next['assets/worker.js']), sha256: sha(f.next['assets/worker.js']) });
  replaceZip(f, entries(f));
  const result = run(f); assert.notEqual(result.status, 0); assert.match(text(result), /Links\/reparse/);
  unchanged(f); assert.equal(readFileSync(join(outside, 'worker.js'), 'utf8'), 'outside user data');
});

psTest('restores files already replaced when a later destination is read-only', t => {
  const f = fixture(t), locked = join(f.target, 'options.html'); chmodSync(locked, 0o444);
  t.after(() => { if (existsSync(locked)) chmodSync(locked, 0o666); });
  const result = run(f);
  assert.notEqual(result.status, 0, text(result)); assert.match(text(result), /previous files were restored/); unchanged(f);
  assert.equal(existsSync(join(f.state, 'pending-update.json')), false);
});

psTest('recovers a persisted interrupted update before attempting another install', t => {
  const f = fixture(t), backup = join(f.state, 'backups', 'interrupted'); mkdirSync(backup, { recursive: true });
  const files = Object.entries(f.old).map(([path, data]) => { writeFileSync(join(backup, path), data); return { path, existed: true, sha256: sha(data) }; });
  files.push({ path: 'settings.css', existed: false, sha256: null });
  writeFileSync(join(f.target, 'background.mjs'), f.next['background.mjs']); writeFileSync(join(f.target, 'settings.css'), f.next['settings.css']);
  writeFileSync(join(f.state, 'pending-update.json'), JSON.stringify({ product: 'pickcode-cookie-extension', directory: f.target, backup, previousVersion: '1.1.3', targetVersion: '1.2.0', files }));
  const result = run(f); assert.equal(result.status, 0, text(result)); assert.match(text(result), /Previous version restored/);
  unchanged(f); assert.equal(existsSync(join(f.state, 'pending-update.json')), false);
});

psTest('does not restore an interrupted update from a corrupted backup', t => {
  const f = fixture(t), backup = join(f.state, 'backups', 'interrupted'); mkdirSync(backup, { recursive: true });
  const files = Object.entries(f.old).map(([path, data]) => { writeFileSync(join(backup, path), data); return { path, existed: true, sha256: sha(data) }; });
  writeFileSync(join(backup, 'core.mjs'), 'damaged backup');
  writeFileSync(join(f.state, 'pending-update.json'), JSON.stringify({ product: 'pickcode-cookie-extension', directory: f.target, backup, previousVersion: '1.1.3', targetVersion: '1.2.0', files }));
  const result = run(f); assert.notEqual(result.status, 0); assert.match(text(result), /Recovery backup checksum mismatch/);
  unchanged(f); assert.equal(existsSync(join(f.state, 'pending-update.json')), true);
});
