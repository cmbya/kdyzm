import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { EXTENSION_NAME, packageCookieExtension } from './package-cookie-extension.mjs';

// gstack cannot open chrome-extension://. This regression uses the same real
// extension directory and disposable Chrome profile across a genuine runtime reload.
// No product file, permission declaration, user profile or platform cookie changes.
// Repository consumers must set COOKIE_UPGRADE_OLD_SOURCE to an unpacked official
// 1.1.3 source directory when the retained local artifacts baseline is unavailable.
// Also set PLAYWRIGHT_MODULE and, when needed, CHROME_EXECUTABLE as in the other
// extension browser regression scripts. Never point at a real Chrome profile.
assert.equal(process.platform, 'win32', 'This regression requires the Windows updater');
assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to installed playwright/index.mjs');
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)));
const root = resolve(import.meta.dirname, '..');
const oldSource = resolve(process.env.COOKIE_UPGRADE_OLD_SOURCE || join(root, 'artifacts', 'cookie-extension-1.1.3-upgrade-baseline'));
const newSource = join(root, 'cookie-extension');
const oldManifest = JSON.parse(readFileSync(join(oldSource, 'manifest.json'), 'utf8'));
const newManifest = JSON.parse(readFileSync(join(newSource, 'manifest.json'), 'utf8'));
assert.equal(oldManifest.name, EXTENSION_NAME); assert.equal(newManifest.name, EXTENSION_NAME);
assert.equal(oldManifest.version, '1.1.3'); assert.equal(newManifest.version, '1.2.1');
const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
assert.equal(probe.status, 0, 'Windows PowerShell is required');
const artifacts = join(root, 'artifacts', 'cookie-upgrade-browser-1.2.1');
mkdirSync(artifacts, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), 'pickcode-upgrade-e2e-'));
const extension = join(temporary, 'loaded-extension'), profile = join(temporary, 'profile'), bundle = join(temporary, 'bundle'), state = join(temporary, 'updater-state');
function copyDirectory(source, target) {
  mkdirSync(target);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, 'Fixture source cannot contain links');
    if (entry.isDirectory()) copyDirectory(join(source, entry.name), join(target, entry.name));
    else copyFileSync(join(source, entry.name), join(target, entry.name));
  }
}
copyDirectory(oldSource, extension); mkdirSync(profile);
const expiresAt = Date.now() + 86400000;
const backendA = 'https://upgrade-a.invalid', backendB = 'https://upgrade-b.invalid';
const serviceId = 'a'.repeat(32);
function record(id, platform, selected, auto) {
  return { account: { id, platform, label: '合成' + platform, familyId: 'family-a', familyName: '合成家人甲', credentialVersion: 3, status: 'configured' },
    connection: { id: 'child-' + id, accountId: id, platform, identityBound: true, identityHint: '合成账号', expiresAt, lastSyncAt: 100 },
    selected, auto, consent: 'synthetic-upgrade-consent-' + id, lastDigest: 'synthetic-digest-' + id, checkedAt: 100, error: '' };
}
const seed = {
  connections: [{ id: 'legacy-a', token: 'csg_' + 'x'.repeat(43), baseUrl: backendA, serviceId,
    account: { id: 'legacy-account', platform: 'pdd', label: '合成旧单账号', familyId: 'legacy-family', familyName: '合成旧授权', credentialVersion: 2, status: 'configured' },
    connection: { id: 'legacy-a', name: '旧单账号 Chrome', accountId: 'legacy-account', platform: 'pdd', identityBound: true, identityHint: '合成旧账号', expiresAt, lastSyncAt: 100 },
    storeId: '0', auto: true, consent: 'synthetic-legacy-consent', lastDigest: 'synthetic-legacy-digest', error: '', checkedAt: 100 }],
  familyConnections: [
    { id: 'grant-a', token: 'cfg_' + 'a'.repeat(43), baseUrl: backendA, serviceId, family: { id: 'family-a', name: '合成家人甲' },
      connection: { id: 'grant-a', familyId: 'family-a', name: '升级测试 Chrome', expiresAt },
      accounts: [record('taobao-a', 'taobao', true, true), record('jd-a', 'jd', true, false), record('pdd-a', 'pdd', false, false)], error: '', checkedAt: 100 },
    { id: 'grant-b', token: 'cfg_' + 'b'.repeat(43), baseUrl: backendB, serviceId: 'b'.repeat(32), family: { id: 'family-b', name: '合成家人乙' },
      connection: { id: 'grant-b', familyId: 'family-b', name: '另一台 Chrome', expiresAt }, accounts: [], error: '', checkedAt: 100 }
  ],
  upgradeFixtureSentinel: { note: 'unrelated synthetic preference', retained: true }
};
const checks = [], screenshots = [], pageErrors = [], networkRequests = [];
const check = name => { checks.push(name); console.log('PASS ' + name); };
let context, page, extensionIdBefore, extensionIdAfter, packageMetadata;
const report = { startedAt: new Date().toISOString(), oldVersion: oldManifest.version, newVersion: newManifest.version,
  source: { old: oldSource, current: newSource }, powershellVersion: probe.stdout.trim(), nativePermissionPromptVerified: false,
  actualPlatformLoginVerified: false, checks, screenshots, pageErrors, networkRequests };
const snapshot = worker => worker.evaluate(() => chrome.storage.local.get(null));
const preservation = value => ({
  connections: value.connections.map(({ id, token, baseUrl, serviceId, account, connection, auto, selected, consent, lastDigest, storeId }) =>
    ({ id, token, baseUrl, serviceId, account, connection, auto, selected, consent, lastDigest, storeId })),
  familyConnections: value.familyConnections.map(({ id, token, baseUrl, serviceId, family, connection, accounts }) => ({ id, token, baseUrl, serviceId, family, connection,
    accounts: accounts.map(({ account, connection, selected, auto, consent, lastDigest }) => ({ account, connection, selected, auto, consent, lastDigest })) })),
  upgradeFixtureSentinel: value.upgradeFixtureSentinel
});
async function screenshot(name) { await page.screenshot({ path: join(artifacts, name), fullPage: true }); screenshots.push(name); }
async function installedIds(expectedVersion) {
  const manager = await context.newPage();
  try {
    await manager.goto('chrome://extensions/');
    // Match the documented unpacked-install prerequisite in this disposable
    // profile. Command-line loading alone does not enable Developer mode, and
    // Chrome otherwise disables the extension when runtime.reload is called.
    const developerMode = manager.locator('extensions-toolbar #devMode');
    await developerMode.waitFor();
    if (!await developerMode.evaluate(element => element.checked)) await developerMode.click();
    assert.equal(await developerMode.evaluate(element => element.checked), true);
    const cards = manager.locator('extensions-item').filter({ hasText: EXTENSION_NAME });
    await cards.first().waitFor();
    if (expectedVersion) {
      const deadline = Date.now() + 15000;
      let metadata;
      while ((metadata = await cards.first().evaluate(element => ({ version: element.data?.version, state: element.data?.state,
        errors: element.data?.manifestErrors, disableReasons: element.data?.disableReasons }))).version !== expectedVersion) {
        if (Date.now() > deadline) throw new Error('Extension manager did not report ' + expectedVersion + ': ' + JSON.stringify(metadata));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(metadata.state, 'ENABLED', JSON.stringify(metadata));
    }
    const ids = await cards.evaluateAll(elements => elements.map(element => element.id).sort());
    assert.equal(ids.length, 1, 'Exactly one PickCode extension must be installed');
    return ids;
  } finally { await manager.close(); }
}

try {
  context = await chromium.launchPersistentContext(profile, { headless: true,
    ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : { channel: 'chromium' }),
    viewport: { width: 1120, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--disable-background-networking'] });
  context.setDefaultTimeout(15000);
  await context.route(/^https?:\/\//, route => { networkRequests.push({ method: route.request().method(), origin: new URL(route.request().url()).origin }); return route.abort(); });
  context.on('page', opened => opened.on('pageerror', error => pageErrors.push(error.message)));
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const original = await worker.evaluate(() => ({ id: chrome.runtime.id, version: chrome.runtime.getManifest().version }));
  extensionIdBefore = original.id; assert.equal(original.version, '1.1.3');
  await worker.evaluate(async value => { await chrome.storage.local.clear(); await chrome.storage.local.set(value); }, seed);
  assert.deepEqual(await snapshot(worker), seed);
  const beforeIds = await installedIds('1.1.3'); assert.deepEqual(beforeIds, [extensionIdBefore]);
  page = await context.newPage(); await page.goto(`chrome-extension://${extensionIdBefore}/options.html`);
  await page.getByText('合成家人甲', { exact: false }).first().waitFor();
  await screenshot('before-1.1.3.png');
  const before = await snapshot(worker); assert.deepEqual(before, seed);
  check('Chrome loaded the untouched 1.1.3 manifest and exactly one extension instance with synthetic storage');
  await page.close(); page = null;

  packageCookieExtension({ sourceDirectory: newSource, outputDirectory: bundle });
  packageMetadata = JSON.parse(readFileSync(join(bundle, 'cookie-extension-update.json'), 'utf8'));
  report.packageSha256 = packageMetadata.archive.sha256;
  report.packageFiles = packageMetadata.files;
  const update = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(bundle, 'Update-CookieExtension.ps1'),
    '-ExtensionDirectory', extension, '-PackageManifest', join(bundle, 'cookie-extension-update.json'), '-StateDirectory', state, '-Apply'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(update.status, 0, update.stdout + update.stderr);
  writeFileSync(join(artifacts, 'updater-output.txt'), update.stdout + update.stderr);
  assert.equal(JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8')).version, '1.2.1');
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), '1.1.3', 'Filesystem replacement must not silently replace the running extension');
  assert.deepEqual(await snapshot(worker), before, 'Updater must not modify browser storage');
  assert.equal(JSON.parse(readFileSync(join(state, 'directory.json'), 'utf8')).directory, extension);
  assert.equal(existsSync(join(state, 'pending-update.json')), false);
  check('The shipped PowerShell updater replaced the original loaded directory while Chrome retained its running 1.1.3 instance and all storage');

  const previousWorker = worker;
  const stopped = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Original extension worker did not stop on runtime.reload')), 15000);
    worker.once('close', () => { clearTimeout(timer); resolve(); });
  });
  await worker.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 0); });
  await stopped;
  assert.deepEqual(await installedIds('1.2.1'), beforeIds);
  // Chrome may defer the new worker until an extension page sends a message.
  // A passive manifest document lets us inspect storage before options migration.
  page = await context.newPage(); await page.goto(`chrome-extension://${extensionIdBefore}/manifest.json`);
  const upgraded = await page.evaluate(() => ({ id: chrome.runtime.id, version: chrome.runtime.getManifest().version }));
  extensionIdAfter = upgraded.id; assert.equal(upgraded.version, '1.2.1'); assert.equal(extensionIdAfter, extensionIdBefore);
  assert.deepEqual(await page.evaluate(() => chrome.storage.local.get(null)), before);
  check('runtime.reload loaded 1.2.1 into the same extension ID with exactly one installed instance and byte-equivalent legacy storage');

  const existingWorker = context.serviceWorkers().find(candidate => candidate !== previousWorker && new URL(candidate.url()).host === extensionIdAfter);
  const reloaded = existingWorker ? Promise.resolve(existingWorker) : context.waitForEvent('serviceworker', {
    predicate: candidate => new URL(candidate.url()).host === extensionIdAfter, timeout: 15000 });
  await page.goto(`chrome-extension://${extensionIdAfter}/options.html`);
  worker = await reloaded;
  await page.locator('#main').waitFor(); await page.locator('.role-card').first().waitFor();
  const message = (action, args = {}) => page.evaluate(({ action, args }) => chrome.runtime.sendMessage({ action, ...args }), { action, args });
  const settings = await message('settings:get'); assert.equal(settings.ok, true, settings.message);
  assert.deepEqual(settings.data, { baseUrl: backendA, baseUrls: [backendA, backendB], name: '升级测试 Chrome' });
  const upgradedStorage = await snapshot(worker);
  assert.deepEqual(preservation(upgradedStorage), preservation(before));
  assert.deepEqual(upgradedStorage.syncSettings, settings.data);
  const legacy = await message('list'); assert.equal(legacy.ok, true); assert.equal(legacy.data[0].selected, true); assert.equal(legacy.data[0].auto, true);
  assert.deepEqual(upgradedStorage.familyConnections[0].accounts.map(({ selected, auto }) => ({ selected, auto })),
    [{ selected: true, auto: true }, { selected: true, auto: false }, { selected: false, auto: false }]);
  assert.equal(await page.locator('#backend-select').inputValue(), backendA);
  assert.match(await page.locator('#main').innerText(), /合成家人甲/);
  assert.match(await page.locator('#main').innerText(), /合成旧授权/);
  assert.equal(await page.locator('#main').getByText('合成家人乙', { exact: true }).count(), 0);
  await screenshot('after-1.2.1.png');
  check('New settings migrated the saved backend and browser name, retained both backends, preserved role grants and per-platform selection/auto switches');

  await page.locator('[data-action="settings"]').click();
  await page.locator('[data-action="name"]').click();
  assert.equal(await page.locator('#browser-name').inputValue(), '升级测试 Chrome');
  await screenshot('migrated-browser-name.png');
  await page.reload(); await page.locator('.role-card').first().waitFor();
  assert.deepEqual((await message('settings:get')).data, settings.data);
  assert.deepEqual(preservation(await snapshot(worker)), preservation(before));
  check('Reopening the settings and options page retains migrated preferences and all original authorizations');

  for (const file of packageMetadata.files) {
    const actual = createHash('sha256').update(readFileSync(join(newSource, file.path))).digest('hex');
    assert.equal(actual, file.sha256, `Source changed while the regression ran: ${file.path}; rerun for current-version evidence`);
  }
  assert.deepEqual(pageErrors, []); assert.deepEqual(networkRequests, []);
  report.result = 'pass'; report.finishedAt = new Date().toISOString(); report.extensionIdBefore = extensionIdBefore; report.extensionIdAfter = extensionIdAfter;
  report.storagePreserved = true; report.sameDirectory = true; report.singleInstance = true;
  writeFileSync(join(artifacts, 'results.json'), JSON.stringify(report, null, 2));
  rmSync(join(artifacts, 'failure.png'), { force: true });
  console.log(`PASS ${checks.length} original-directory upgrade browser checks; extension ID ${extensionIdAfter}; 0 page errors / network requests`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  writeFileSync(join(artifacts, 'results.json'), JSON.stringify({ ...report, result: 'fail', error: error.message,
    extensionIdBefore, extensionIdAfter, finishedAt: new Date().toISOString() }, null, 2));
  throw error;
} finally {
  await context?.close();
  // Only remove the exact disposable directory created by this process.
  rmSync(temporary, { recursive: true, force: true });
}
