import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'zsdd2/kdyzm';
const PACKAGE = 'local.pickcode.assistant';
const MAX_APK = 80 * 1024 * 1024;
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const PINNED_SIGNERS = ['b88d6fac9014fa4e702daabce0d2580046ae9e6d0b1691412d36e0fbed3ce9aa'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function validReleaseDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', shell: false, timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.status, 0, `${basename(program)} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function gh(args) { return command(process.platform === 'win32' ? 'gh.exe' : 'gh', args); }

export function validateDraft(release, { target, title, notes, files }, complete = false) {
  assert.equal(release.isDraft, true, 'Only a draft can be published');
  assert.equal(release.targetCommitish, target, 'Draft target differs from the reviewed commit');
  assert.equal(release.name, title, 'Draft title differs from this release');
  assert.equal(release.body, notes.trimEnd(), 'Draft notes differ from this release');
  const names = release.assets.map(a => a.name);
  assert.equal(new Set(names).size, names.length, 'Duplicate draft asset names');
  assert.ok(names.every(name => files.includes(name)), 'Draft contains unexpected attachments; refusing to publish them');
  if (complete) assert.deepEqual(names.slice().sort(), files.slice().sort(), 'Draft asset set is incomplete');
}
function validateRemoteTag(tag, target) {
  const refs = JSON.parse(gh(['api', `repos/${REPOSITORY}/git/matching-refs/tags/${tag}`]));
  let object = refs.find(ref => ref.ref === `refs/tags/${tag}`)?.object;
  for (let depth = 0; object?.type === 'tag' && depth < 5; depth++)
    object = JSON.parse(gh(['api', `repos/${REPOSITORY}/git/tags/${object.sha}`])).object;
  if (object) { assert.equal(object.type, 'commit', 'Unsupported existing app tag'); assert.equal(object.sha, target, 'Existing app tag points at another commit'); }
}

export function apkMetadata(output) {
  const match = output.match(/^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m);
  const minSdk = output.match(/^sdkVersion:'(\d+)'/m);
  assert.ok(match && minSdk, 'APK package/version/minSdk metadata is missing');
  assert.equal(match[1], PACKAGE, 'Wrong Android package');
  assert.match(match[3], VERSION);
  const data = { packageName: match[1], versionName: match[3], versionCode: Number(match[2]), minSdk: Number(minSdk[1]) };
  assert.ok(Number.isSafeInteger(data.versionCode) && data.versionCode > 0 && data.versionCode <= 2100000000);
  assert.ok(data.minSdk >= 23 && data.minSdk <= 100);
  return data;
}
export function signerDigests(output) {
  const values = [...output.matchAll(/^Signer #\d+ certificate SHA-256 digest:\s*([a-f0-9]{64})\s*$/gm)].map(match => match[1]);
  assert.ok(values.length, 'Verified APK signer certificate is missing');
  return [...new Set(values)].sort();
}
export function buildManifest(current, previous, currentSigners, previousSigners, bytes, notes, publishedAt = new Date().toISOString()) {
  assert.equal(current.packageName, PACKAGE);
  assert.equal(previous.packageName, PACKAGE);
  assert.match(current.versionName, VERSION);
  assert.ok(validReleaseDate(publishedAt), 'Publication time must be a valid canonical UTC timestamp');
  assert.ok(current.versionCode > previous.versionCode, 'App versionCode must increase');
  assert.notEqual(current.versionName, previous.versionName, 'App versionName must change');
  assert.deepEqual(currentSigners, previousSigners, 'APK signer changed; in-place upgrade would fail');
  assert.deepEqual(currentSigners, PINNED_SIGNERS, 'APK does not use the existing private-app signing certificate');
  assert.ok(bytes.length > 0 && bytes.length <= MAX_APK, 'APK must be at most 80 MiB');
  assert.ok(typeof notes === 'string' && notes.trim().length > 0 && notes.length <= 8000, 'Release notes must contain 1–8000 characters');
  const tag = `app-v${current.versionName}`;
  return { schemaVersion: 1, ...current, tag, apkUrl: `https://github.com/${REPOSITORY}/releases/download/${tag}/PickCode-private-${current.versionName}.apk`,
    sha256: sha256(bytes), size: bytes.length, notes: notes.trim(), publishedAt };
}
export function verifyBundle(directory) {
  const raw = readFileSync(join(directory, 'app-update.json'));
  assert.ok(raw.length <= 65536, 'Manifest is too large');
  const m = JSON.parse(raw);
  assert.equal(m.schemaVersion, 1); assert.equal(m.packageName, PACKAGE);
  assert.match(m.versionName, VERSION);
  assert.equal(m.tag, `app-v${m.versionName}`);
  assert.ok(Number.isSafeInteger(m.versionCode) && m.versionCode > 0 && m.versionCode <= 2100000000);
  assert.ok(Number.isInteger(m.minSdk) && m.minSdk >= 23 && m.minSdk <= 100);
  assert.ok(Number.isSafeInteger(m.size) && m.size > 0 && m.size <= MAX_APK);
  assert.match(m.sha256, /^[a-f0-9]{64}$/);
  assert.ok(typeof m.notes === 'string' && m.notes.trim() && m.notes.length <= 8000);
  assert.ok(validReleaseDate(m.publishedAt));
  const apkName = `PickCode-private-${m.versionName}.apk`;
  assert.equal(m.apkUrl, `https://github.com/${REPOSITORY}/releases/download/${m.tag}/${apkName}`);
  const bytes = readFileSync(join(directory, apkName));
  assert.equal(bytes.length, m.size, 'APK size changed after preparation');
  assert.equal(sha256(bytes), m.sha256, 'APK changed after preparation');
  const sums = `${m.sha256}  ${apkName}\n${sha256(raw)}  app-update.json\n`;
  assert.equal(readFileSync(join(directory, 'SHA256SUMS'), 'utf8'), sums, 'Checksum file does not match release assets');
  return { manifest: m, files: [apkName, 'app-update.json', 'SHA256SUMS'] };
}

function inspectApk(apk, buildTools) {
  const aapt = join(buildTools, process.platform === 'win32' ? 'aapt.exe' : 'aapt');
  const signer = join(buildTools, 'lib', 'apksigner.jar');
  const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
  // Windows aapt cannot open an absolute path with Chinese directory names.
  return { metadata: apkMetadata(command(aapt, ['dump', 'badging', basename(apk)], dirname(apk))),
    signers: signerDigests(command(java, ['-jar', signer, 'verify', '--print-certs', apk])) };
}
function prepare(options) {
  for (const name of ['apk', 'previous-apk', 'notes-file', 'out-dir', 'build-tools']) assert.ok(options[name], `Missing --${name}`);
  const apk = resolve(options.apk), previous = resolve(options['previous-apk']);
  const directory = resolve(options['out-dir']), buildTools = resolve(options['build-tools']);
  assert.ok(!existsSync(directory), 'Output directory already exists; use a new directory');
  assert.ok(statSync(apk).size <= MAX_APK);
  const currentInfo = inspectApk(apk, buildTools), previousInfo = inspectApk(previous, buildTools);
  const bytes = readFileSync(apk);
  const manifest = buildManifest(currentInfo.metadata, previousInfo.metadata, currentInfo.signers, previousInfo.signers, bytes, readFileSync(resolve(options['notes-file']), 'utf8'));
  const raw = JSON.stringify(manifest, null, 2) + '\n';
  const apkName = `PickCode-private-${manifest.versionName}.apk`;
  mkdirSync(directory, { recursive: true });
  copyFileSync(apk, join(directory, apkName));
  writeFileSync(join(directory, 'app-update.json'), raw, { flag: 'wx' });
  writeFileSync(join(directory, 'SHA256SUMS'), `${manifest.sha256}  ${apkName}\n${sha256(raw)}  app-update.json\n`, { flag: 'wx' });
  verifyBundle(directory);
  console.log(`Prepared ${manifest.tag}: ${directory}; original signer verified, no upload performed`);
}
function publish(options) {
  for (const name of ['dir', 'target', 'build-tools', 'previous-apk']) assert.ok(options[name], `Missing --${name}`);
  assert.match(options.target, /^[a-f0-9]{40}$/, '--target must be a reviewed commit SHA');
  const directory = resolve(options.dir), { manifest, files } = verifyBundle(directory);
  const currentInfo = inspectApk(join(directory, files[0]), resolve(options['build-tools']));
  const previousInfo = inspectApk(resolve(options['previous-apk']), resolve(options['build-tools']));
  const rebuilt = buildManifest(currentInfo.metadata, previousInfo.metadata, currentInfo.signers, previousInfo.signers,
    readFileSync(join(directory, files[0])), manifest.notes, manifest.publishedAt);
  assert.deepEqual(manifest, rebuilt, 'Published manifest must describe the verified signed APK');
  const commit = JSON.parse(gh(['api', `repos/${REPOSITORY}/commits/${options.target}`]));
  assert.equal(commit.sha, options.target);
  validateRemoteTag(manifest.tag, options.target);
  const releases = JSON.parse(gh(['release', 'list', '--repo', REPOSITORY, '--limit', '100', '--json', 'tagName,isDraft']));
  const existing = releases.find(r => r.tagName === manifest.tag);
  if (existing) assert.equal(existing.isDraft, true, 'This version is already public; never overwrite a released APK');
  const temporary = mkdtempSync(join(tmpdir(), 'pickcode-release-'));
  try {
    const notes = join(temporary, 'release-notes.md');
    const expected = { target: options.target, title: `取件码助手 v${manifest.versionName}`, files,
      notes: `私人取件助手 ${manifest.versionName}（${manifest.versionCode}）\n\n${manifest.notes}\n\n覆盖安装，保留原私人版数据；首次启用在线升级需手动安装此版。` };
    writeFileSync(notes, expected.notes, { flag: 'wx' });
    if (!existing) gh(['release', 'create', manifest.tag, '--repo', REPOSITORY, '--target', options.target, '--draft', '--title', expected.title, '--notes-file', notes]);
    const readDraft = () => JSON.parse(gh(['release', 'view', manifest.tag, '--repo', REPOSITORY, '--json', 'isDraft,assets,targetCommitish,name,body']));
    const release = readDraft();
    validateDraft(release, expected);
    for (const file of files) {
      if (!release.assets.some(a => a.name === file)) gh(['release', 'upload', manifest.tag, join(directory, file), '--repo', REPOSITORY]);
    }
    const downloaded = join(temporary, 'downloaded'); mkdirSync(downloaded);
    for (const file of files) gh(['release', 'download', manifest.tag, '--repo', REPOSITORY, '--pattern', file, '--dir', downloaded]);
    for (const file of files) assert.equal(sha256(readFileSync(join(downloaded, file))), sha256(readFileSync(join(directory, file))), `Uploaded ${file} differs`);
    verifyBundle(downloaded);
    validateDraft(readDraft(), expected, true);
    validateRemoteTag(manifest.tag, options.target);
    gh(['release', 'edit', manifest.tag, '--repo', REPOSITORY, '--draft=false', '--latest']);
    console.log(`Published https://github.com/${REPOSITORY}/releases/tag/${manifest.tag}; all assets downloaded and verified before publication`);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
export function parseArguments(args) {
  const [action, ...rest] = args;
  assert.ok(['prepare', 'publish', 'verify'].includes(action), 'Usage: app-release.mjs prepare|publish|verify --option value');
  const allowed = action === 'prepare' ? ['apk', 'previous-apk', 'notes-file', 'out-dir', 'build-tools'] : action === 'publish' ? ['dir', 'target', 'build-tools', 'previous-apk'] : ['dir'];
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].replace(/^--/, '');
    assert.ok(rest[i].startsWith('--') && allowed.includes(key) && !Object.hasOwn(options, key) && rest[i + 1] && !rest[i + 1].startsWith('--'), 'Unknown, duplicate or incomplete option');
    options[key] = rest[i + 1];
  }
  return { action, options };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { action, options } = parseArguments(process.argv.slice(2));
    if (action === 'prepare') prepare(options);
    else if (action === 'publish') publish(options);
    else { assert.ok(options.dir, 'Missing --dir'); const { manifest } = verifyBundle(resolve(options.dir)); console.log(`Verified local ${manifest.tag}`); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
