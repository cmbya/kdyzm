import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { apkMetadata, signerDigests, buildManifest, verifyBundle, parseArguments, validateDraft } from '../scripts/app-release.mjs';
const signer = ['b88d6fac9014fa4e702daabce0d2580046ae9e6d0b1691412d36e0fbed3ce9aa'];
const current = { packageName: 'local.pickcode.assistant', versionName: '3.1.4', versionCode: 30104, minSdk: 23 };
const previous = { ...current, versionName: '3.1.3', versionCode: 30103 };
const bytes = Buffer.from('synthetic-apk-bytes');
const digest = b => createHash('sha256').update(b).digest('hex');
test('release derives package, version and minimum SDK from aapt output, rejecting different apps', () => {
  const output = "package: name='local.pickcode.assistant' versionCode='30104' versionName='3.1.4' platformBuildVersionName='15'\nsdkVersion:'23'";
  assert.deepEqual(apkMetadata(output), current);
  assert.throws(() => apkMetadata(output.replace('local.pickcode.assistant', 'other.app')));
  assert.throws(() => apkMetadata(output.replace("sdkVersion:'23'", '')));
  assert.throws(() => apkMetadata(output.replace('30104', '999999999999')));
});
test('release requires the existing signing certificate and a strictly increasing version', () => {
  assert.deepEqual(signerDigests(`Signer #1 certificate SHA-256 digest: ${signer[0]}\n`), signer);
  assert.throws(() => signerDigests('apksigner failed'));
  for (const invalid of [previous, { ...current, versionCode: 30102 }, { ...current, versionName: '3.1.3' }])
    assert.throws(() => buildManifest(invalid, previous, signer, signer, bytes, '更新'));
  assert.throws(() => buildManifest(current, previous, ['a'.repeat(64)], signer, bytes, '更新'));
  assert.throws(() => buildManifest(current, previous, ['a'.repeat(64)], ['a'.repeat(64)], bytes, '更新'));
});
test('manifest points at the same immutable app tag and fails on edited assets or a redirected repository', t => {
  const directory = mkdtempSync(join(tmpdir(), 'app-release-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = buildManifest(current, previous, signer, signer, bytes, '检查更新\n保留数据');
  const apkName = 'PickCode-private-3.1.4.apk';
  const writeManifest = m => {
    const raw = JSON.stringify(m, null, 2) + '\n';
    writeFileSync(join(directory, 'app-update.json'), raw);
    writeFileSync(join(directory, 'SHA256SUMS'), `${m.sha256}  ${apkName}\n${digest(raw)}  app-update.json\n`);
  };
  writeFileSync(join(directory, apkName), bytes); writeManifest(manifest);
  assert.equal(verifyBundle(directory).manifest.versionCode, 30104);
  writeFileSync(join(directory, apkName), Buffer.from('modified-apk-bytes!'));
  assert.throws(() => verifyBundle(directory));
  writeFileSync(join(directory, apkName), bytes);
  writeManifest({ ...manifest, apkUrl: manifest.apkUrl.replace('zsdd2', 'attacker') });
  assert.throws(() => verifyBundle(directory));
  writeManifest(manifest);
  writeFileSync(join(directory, 'SHA256SUMS'), readFileSync(join(directory, 'SHA256SUMS'), 'utf8') + 'extra');
  assert.throws(() => verifyBundle(directory));
});
test('publication is an explicit distinct command and unknown or duplicate flags never silently apply', () => {
  assert.equal(parseArguments(['prepare', '--apk', 'file.apk']).action, 'prepare');
  for (const args of [[], ['prepare', '--publish', 'yes'], ['verify', '--dir'], ['publish', '--dir', 'a', '--dir', 'b']]) assert.throws(() => parseArguments(args));
});
test('resume refuses unreviewed draft attachments, notes and target before making a release public', () => {
  const expected = { target: 'a'.repeat(40), title: '取件码助手 v3.1.4', notes: 'reviewed notes', files: ['app.apk', 'app-update.json', 'SHA256SUMS'] };
  const draft = { isDraft: true, targetCommitish: expected.target, name: expected.title, body: expected.notes, assets: expected.files.map(name => ({ name })) };
  validateDraft(draft, expected, true);
  for (const altered of [
    { ...draft, assets: [...draft.assets, { name: 'unexpected-backup.zip' }] },
    { ...draft, targetCommitish: 'b'.repeat(40) }, { ...draft, body: 'unreviewed text' }, { ...draft, name: 'other' }, { ...draft, isDraft: false }
  ]) assert.throws(() => validateDraft(altered, expected));
  validateDraft({ ...draft, assets: [] }, expected);
  assert.throws(() => validateDraft({ ...draft, assets: [] }, expected, true));
});
test('publisher rejects dates and version names that the Android updater cannot parse', () => {
  for (const value of ['2026-10-31', '2026-02-30T12:00:00.000Z', '2026-10-31T25:00:00.000Z', 'invalid'])
    assert.throws(() => buildManifest(current, previous, signer, signer, bytes, '更新', value));
  assert.throws(() => buildManifest({ ...current, versionName: '1000000.1.4' }, previous, signer, signer, bytes, '更新'));
});
