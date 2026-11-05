import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
const serviceSource = [new URL('../server/src/service.mjs', import.meta.url), new URL('../src/service.mjs', import.meta.url)].find(existsSync);
if (!serviceSource) throw new Error('No fixture backend service source found');
const { createService } = await import(serviceSource.href);

// gstack cannot open chrome-extension://; use the real extension in a disposable
// Playwright browser profile. Product JS/CSS are copied without modification.
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to the installed playwright/index.mjs');
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)));
const root = resolve(import.meta.dirname, '..'), source = join(root, 'cookie-extension');
const temporary = mkdtempSync(join(tmpdir(), 'pickcode-options-e2e-'));
const extension = join(temporary, 'extension'), profile = join(temporary, 'profile');
function copyExtension(from, to) {
  mkdirSync(to);
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyExtension(join(from, entry.name), join(to, entry.name));
    else copyFileSync(join(from, entry.name), join(to, entry.name));
  }
}
copyExtension(source, extension); mkdirSync(profile);
const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'));
// Only this temporary manifest grants test hosts. Native permission bubbles
// remain a manual acceptance item; neither user profiles nor shipped files change.
manifest.host_permissions = ['http://127.0.0.1/*', 'https://*.taobao.com/*', 'https://*.yangkeduo.com/*',
  'http://*.yangkeduo.com/*', 'https://*.jd.com/*'];
writeFileSync(join(extension, 'manifest.json'), JSON.stringify(manifest));
const artifacts = join(root, 'artifacts', 'cookie-options-browser-' + manifest.version);
mkdirSync(artifacts, { recursive: true });
const adminToken = randomBytes(32).toString('hex');
const service = createService({ encryptionKey: randomBytes(32).toString('hex'), adminToken, baseUrl: 'https://fixture.invalid',
  scheduler: false, fixture: true, collector: async () => ({ orders: [], shipments: [], warnings: [] }) });
const credentialRequests = [];
service.server.on('request', request => {
  if (request.method === 'POST' && /\/(?:preview|cookie)$/.test(request.url)) credentialRequests.push(request.url);
});
const identities = {
  taobao: { unb: '74100010001', cookie2: 'synthetic-options-taobao-session' },
  pdd: { pdd_user_id: '74200020002', PDDAccessToken: randomBytes(20).toString('hex') },
  jd: { pin: 'synthetic-options-jd-user', light_key: 'synthetic-options-jd-light-session' }
};
const domains = { taobao: '.taobao.com', pdd: 'mobile.yangkeduo.com', jd: '.jd.com' };
const checks = [], screenshots = [], pageErrors = [];
const check = name => { checks.push({ name }); console.log('PASS ' + name); };
const waitUntil = async (predicate, label, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
};
const header = values => Object.entries(values).map(([name, value]) => `${name}=${value}`).join('; ');
let context, page;
try {
  await new Promise((resolve, reject) => { service.server.once('error', reject); service.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const admin = async (path, body) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'X-Admin-Token': adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok(response.ok, `fixture administrator API returned ${response.status}`); return response.json();
  };
  context = await chromium.launchPersistentContext(profile, { headless: true,
    ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : { channel: 'chromium' }),
    viewport: { width: 1120, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  context.setDefaultTimeout(15000);
  await context.route(/^https?:\/\//, route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  context.on('page', opened => opened.on('pageerror', error => pageErrors.push(error.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionUrl = `chrome-extension://${new URL(worker.url()).host}/options.html`;
  page = await context.newPage(); await page.goto(extensionUrl);
  await page.locator('#main').waitFor();
  const message = (action, args = {}) => page.evaluate(({ action, args }) => chrome.runtime.sendMessage({ action, ...args }), { action, args });
  const data = async (action, args) => { const response = await message(action, args); assert.equal(response.ok, true, response.message); return response.data; };
  const groups = () => data('family:list');
  const role = async id => (await groups()).find(group => group.id === id);
  const setCookies = (platform, values) => context.addCookies(Object.entries(values).map(([name, value]) => ({ name, value,
    domain: domains[platform], path: '/', secure: name !== 'pdd_user_id', httpOnly: name !== 'pdd_user_id', sameSite: 'Lax' })));
  const screenshot = async name => {
    // Finite dialog entrance animations should reach their final state before
    // capture; viewport captures also keep native dialog backdrops consistent.
    await page.screenshot({ path: join(artifacts, name), animations: 'disabled', fullPage: !await page.locator('#flow-dialog').isVisible() });
    screenshots.push(name);
  };
  const closeFlow = async () => {
    if (await page.locator('#flow-dialog').isVisible()) await page.locator('#flow-dialog [data-action="close"]').first().click();
    await page.locator('#flow-dialog').waitFor({ state: 'hidden' });
  };
  const add = async kind => {
    await closeFlow(); await page.locator('[data-action="add"]').first().click();
    await page.locator(`#flow-dialog [data-action="${kind}"]`).click();
  };
  const choose = value => page.locator(`#flow-dialog input[name="choose"][value="${value}"]`);
  const noOverflow = async () => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (await page.locator('#flow-dialog').isVisible()) assert.equal(await page.locator('#flow-dialog').evaluate(dialog => {
      const rect = dialog.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth + 1 && dialog.scrollWidth <= dialog.clientWidth;
    }), true);
  };

  await page.locator('[data-action="add"]').first().click();
  await page.locator('#backend-address').fill(base);
  await page.locator('[data-action="save-address"]').click();
  assert.equal((await data('settings:get')).baseUrl, base);
  await page.reload(); await page.locator('#main').waitFor();
  assert.equal((await data('settings:get')).baseUrl, base);
  assert.equal((await data('settings:get')).name, '我的 Chrome');
  check('shared backend preference persists before any authorization');
  await page.locator('[data-action="settings"]').click();
  await page.locator('[data-action="name"]').click();
  await page.locator('#browser-name').fill('合成验收 Chrome');
  await page.locator('[data-action="save-name"]').click();
  await waitUntil(async () => (await data('settings:get')).name === '合成验收 Chrome', 'shared browser name');
  assert.equal((await data('settings:get')).baseUrl, base);
  await closeFlow();
  check('browser name changes independently while retaining the saved backend');

  await setCookies('taobao', identities.taobao); await setCookies('jd', identities.jd);
  await add('reverse');
  for (const platform of ['taobao', 'pdd', 'jd']) {
    const input = choose(platform); assert.equal(await input.isChecked(), false); await input.check();
  }
  await page.locator('#flow-dialog [data-action="request"]').click();
  await waitUntil(async () => !!await data('family:pendingRequest'), 'reverse request metadata');
  const pending = await data('family:pendingRequest');
  assert.equal(pending.name, '合成验收 Chrome');
  assert.deepEqual([...pending.platforms].sort(), ['jd', 'pdd', 'taobao']);
  assert.ok(!('pollToken' in pending)); assert.equal(service.store.accounts().length, 0);
  await waitUntil(() => context.pages().some(opened => opened.url().startsWith(base)), 'automatically opened administrator page');
  check('reverse request with missing PDD login opens backend and creates no accounts');
  await page.reload();
  await page.locator('#flow-dialog [data-action="open-request"]').waitFor();
  assert.equal((await data('family:pendingRequest')).requestId, pending.requestId);
  assert.equal(service.store.accounts().length, 0);
  check('pending authorization resumes after reopening without repeating input');

  const family = service.store.saveFamily({ name: '合成同步家人' });
  await admin('/v1/admin/cookie-sync/families/requests/' + pending.code + '/approve', { familyId: family.id });
  await page.bringToFront();
  await page.locator('#confirm-accounts').filter({ hasText: '淘宝' }).waitFor();
  const masked = await page.locator('#confirm-accounts').innerText();
  assert.match(masked, /淘宝/); assert.match(masked, /京东/); assert.doesNotMatch(masked, /拼多多/);
  for (const value of Object.values(identities).flatMap(fields => Object.values(fields))) assert.ok(!masked.includes(value));
  assert.equal(service.store.accounts().length, 0);
  await screenshot('first-confirmation.png');
  await page.locator('#flow-dialog [data-action="confirm-sync"]').click();
  await waitUntil(() => service.store.accounts().length === 2, 'two confirmed accounts');
  await page.locator('#results').filter({ hasText: '拼多多' }).waitFor();
  assert.match(await page.locator('#results').innerText(), /登录|读取|检查/);
  assert.deepEqual(service.store.accounts().map(account => account.platform).sort(), ['jd', 'taobao']);
  const initialGroup = (await groups())[0], groupId = initialGroup.id;
  assert.equal(initialGroup.family.id, family.id); assert.ok(initialGroup.accounts.every(record => record.selected && !record.auto));
  await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(); await screenshot('partial-result-mobile.png');
  check('first identity confirmation synchronizes TB and JD while missing PDD stays actionable');

  await page.locator('#results [data-action="result-remedy"][data-entry="family/' + groupId + '/platform-pdd"]').click();
  await page.locator('[data-action="open-login"]').waitFor();
  await setCookies('pdd', identities.pdd);
  await page.bringToFront(); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.locator('#confirm-accounts').filter({ hasText: '拼多多' }).waitFor();
  assert.equal(service.store.accounts().length, 2);
  await page.locator('#flow-dialog [data-action="confirm-sync"]').click();
  await waitUntil(() => service.store.accounts().length === 3, 'PDD login return confirmation');
  const accounts = Object.fromEntries(service.store.accounts().map(account => [account.platform, account]));
  for (const [platform, values] of Object.entries(identities)) {
    assert.equal(accounts[platform].familyId, family.id);
    for (const value of Object.values(values)) assert.ok(service.store.cookie(accounts[platform].id).includes(value));
  }
  assert.ok((await role(groupId)).accounts.every(record => record.connection?.identityBound && record.selected && !record.auto));
  await noOverflow(); await screenshot('login-return-mobile.png');
  check('cookie change and returning to options resume only pending PDD with first identity confirmation');
  await closeFlow(); await page.setViewportSize({ width: 1120, height: 900 });

  const roleKey = await page.locator('.role-card').filter({ hasText: family.name }).locator('[data-action="sync"]').getAttribute('data-role');
  await context.clearCookies({ name: 'pdd_user_id', domain: domains.pdd });
  await page.locator(`[data-action="sync"][data-role="${roleKey}"]`).click();
  await page.locator(`#results [data-action="result-remedy"][data-entry="family/${groupId}/${accounts.pdd.id}"]`).click();
  await page.locator('[data-action="retry-entry"]').waitFor();
  await page.evaluate(() => {
    window.fixturePermissionRequest = chrome.permissions.request.bind(chrome.permissions);
    window.fixturePermissionPending = false;
    chrome.permissions.request = () => new Promise(resolve => { window.fixturePermissionPending = true; window.fixturePermissionResolve = resolve; });
  });
  const beforeDelayedPermission = credentialRequests.length;
  await page.locator('[data-action="retry-entry"]').click();
  await page.waitForFunction(() => window.fixturePermissionPending);
  await closeFlow();
  await page.evaluate(() => { chrome.permissions.request = window.fixturePermissionRequest; window.fixturePermissionResolve(true); });
  await page.waitForFunction(() => !document.querySelector('[data-previous-disabled]'));
  await setCookies('pdd', identities.pdd);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  // Outlast the product's 650ms login debounce to prove a canceled permission
  // completion and subsequent Cookie event do not reopen or resume the old flow.
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(await page.locator('#flow-dialog').isVisible(), false);
  assert.equal(credentialRequests.length, beforeDelayedPermission);
  check('closing a login retry before permission resolves prevents reopening and credential requests');
  await page.locator(`[data-action="sync"][data-role="${roleKey}"]`).click();
  await page.locator('#results').filter({ hasText: '拼多多' }).waitFor();
  await waitUntil(async () => !(await role(groupId)).accounts.find(record => record.account.id === accounts.pdd.id).error, 'explicit retry after canceled flow');
  await closeFlow();
  const manage = async () => page.locator(`[data-action="manage"][data-role="${roleKey}"]`).click();
  const entry = platform => `family/${groupId}/${accounts[platform].id}`;
  await manage();
  for (const platform of ['taobao', 'pdd', 'jd']) {
    assert.equal(await page.locator(`input[name="selected"][value="${entry(platform)}"]`).isChecked(), true);
    assert.equal(await page.locator(`input[name="auto"][value="${entry(platform)}"]`).isChecked(), false);
  }
  await page.locator(`input[name="auto"][value="${entry('taobao')}"]`).check();
  await page.locator('[data-action="save-platforms"]').click();
  await waitUntil(async () => (await role(groupId)).accounts.find(record => record.account.platform === 'taobao')?.auto, 'mixed automatic settings');
  assert.equal((await role(groupId)).accounts.filter(record => record.auto).length, 1);
  await closeFlow(); await page.reload(); await page.locator('.role-card').first().waitFor();
  assert.equal((await data('settings:get')).baseUrl, base);
  assert.equal((await role(groupId)).accounts.filter(record => record.auto).length, 1);
  check('role, saved address and independent automatic choices persist after reload');

  const rotated = 'synthetic-options-taobao-rotated';
  await setCookies('taobao', { cookie2: rotated });
  await page.evaluate(() => chrome.alarms.create('cookie-sync-change-taobao', { when: Date.now() + 150 }));
  await waitUntil(() => service.store.cookie(accounts.taobao.id).includes(rotated), 'real automatic alarm');
  check('actual extension alarm synchronizes the enabled platform without another first confirmation');

  const later = service.store.saveAccount({ platform: 'taobao', familyId: family.id, label: '后来新增淘宝账号',
    cookie: 'unb=74900090009; cookie2=synthetic-options-later-account', enabled: false }, undefined, true);
  await page.reload(); await page.locator('.role-card').first().waitFor();
  await waitUntil(async () => (await role(groupId)).accounts.some(record => record.account.id === later.id), 'new account status refresh');
  const laterState = (await role(groupId)).accounts.find(record => record.account.id === later.id);
  assert.equal(laterState.selected, false); assert.equal(laterState.auto, false); assert.equal(laterState.connection, null);
  await manage();
  assert.equal(await page.locator(`input[name="selected"][value="family/${groupId}/${later.id}"]`).isChecked(), false);
  assert.equal(await page.locator(`input[name="auto"][value="family/${groupId}/${later.id}"]`).isDisabled(), true);
  await page.locator(`input[name="selected"][value="${entry('pdd')}"]`).uncheck();
  await page.locator('[data-action="save-platforms"]').click();
  await waitUntil(async () => !(await role(groupId)).accounts.find(record => record.account.id === accounts.pdd.id)?.selected, 'PDD deselection');
  const denied = await message('family:sync', { id: groupId, accountId: accounts.pdd.id });
  assert.equal(denied.ok, false); assert.equal(denied.code, 'PLATFORM_NOT_SELECTED');
  assert.equal((await role(groupId)).accounts.find(record => record.account.id === accounts.pdd.id).auto, false);
  check('later duplicate account defaults off and deselecting a platform prevents manual synchronization');
  await closeFlow();

  let legacyFamily, legacyAccount;
  for (const scope of ['family', 'legacy']) {
    const otherFamily = service.store.saveFamily({ name: scope === 'family' ? '正向配对家人' : '旧版配对家人' });
    const platform = 'taobao';
    const account = service.store.saveAccount({ platform, familyId: otherFamily.id, label: '合成配对账号', cookie: header(identities[platform]), enabled: false }, undefined, true);
    if (scope === 'legacy') { legacyFamily = otherFamily; legacyAccount = account; }
    const pairing = await admin(scope === 'family' ? '/v1/admin/cookie-sync/families/pairing' : '/v1/admin/cookie-sync/pairing',
      scope === 'family' ? { familyId: otherFamily.id } : { accountId: account.id });
    await add('bind');
    await page.locator('#pair-info').fill(JSON.stringify({ schemaVersion: 1, kind: scope === 'family' ? 'cookie-sync-family' : 'cookie-sync', baseUrl: base, code: pairing.code }));
    await page.locator('[data-action="preview-pair"]').click();
    await choose(account.id).waitFor();
    for (const input of await page.locator('#flow-dialog input[name="choose"]').all()) assert.equal(await input.isChecked(), false);
    if (scope === 'legacy') assert.equal(await page.locator('#flow-dialog input[name="choose"]').count(), 1);
    await choose(account.id).check();
    await page.locator('[data-action="bind-selected"]').click();
    await page.locator('#confirm-accounts').waitFor();
    assert.match(await page.locator('#dialog-content').innerText(), new RegExp(otherFamily.name));
    await page.locator('[data-action="confirm-sync"]').click();
    await waitUntil(async () => scope === 'family'
      ? (await groups()).some(group => group.family.id === otherFamily.id && group.accounts.some(record => record.connection?.identityBound))
      : (await data('list')).some(item => item.account.id === account.id && item.connection.identityBound), scope + ' forward pairing');
    await closeFlow();
    assert.ok(await role(groupId));
    check(scope === 'family' ? 'backend family pairing uses the same selection and first confirmation flow' : 'legacy pairing shares the flow while retaining its single authorized platform');
  }

  const addedJD = service.store.saveAccount({ platform: 'jd', familyId: legacyFamily.id, label: '新增京东单账号', cookie: header(identities.jd), enabled: false }, undefined, true);
  const jdPairing = await admin('/v1/admin/cookie-sync/pairing', { accountId: addedJD.id });
  const legacyCookie = service.store.cookie(legacyAccount.id), uploadsBeforeJD = credentialRequests.filter(path => path.endsWith('/cookie')).length;
  await worker.evaluate(() => {
    self.fixtureReadQueries = [];
    const getAll = chrome.cookies.getAll.bind(chrome.cookies);
    chrome.cookies.getAll = query => { self.fixtureReadQueries.push({ url: query.url, domain: query.domain }); return getAll(query); };
  });
  await add('bind');
  await page.locator('#pair-info').fill(JSON.stringify({ schemaVersion: 1, kind: 'cookie-sync', baseUrl: base, code: jdPairing.code }));
  await page.locator('[data-action="preview-pair"]').click();
  await choose(addedJD.id).check(); await page.locator('[data-action="bind-selected"]').click();
  await page.locator('#confirm-accounts').filter({ hasText: '京东' }).waitFor();
  assert.doesNotMatch(await page.locator('#confirm-accounts').innerText(), /淘宝/);
  await page.locator('[data-action="confirm-sync"]').click();
  await waitUntil(async () => (await data('list')).some(item => item.account.id === addedJD.id && item.connection.identityBound), 'new legacy JD first confirmation');
  const queriedHosts = await worker.evaluate(() => self.fixtureReadQueries);
  assert.ok(queriedHosts.length); assert.ok(queriedHosts.every(query => !JSON.stringify(query).includes('taobao.com')));
  assert.equal(credentialRequests.filter(path => path.endsWith('/cookie')).length, uploadsBeforeJD + 1);
  assert.equal(service.store.cookie(legacyAccount.id), legacyCookie);
  assert.equal((await data('list')).find(item => item.account.id === legacyAccount.id).selected, true);
  await closeFlow();
  check('pairing a new legacy JD account checks only that selection while an existing same-role Taobao stays untouched');

  await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(); await screenshot('home-mobile.png');
  await manage(); await noOverflow(); await screenshot('manage-platforms-mobile.png');
  await closeFlow(); await page.reload(); await page.locator('.role-card').first().waitFor(); await noOverflow();
  check('390px homepage and platform dialog fit without horizontal overflow after reload');
  const stored = await worker.evaluate(async () => ({ local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null) }));
  const serialized = JSON.stringify(stored);
  for (const value of [...Object.values(identities).flatMap(fields => Object.values(fields)), rotated, adminToken, 'synthetic-options-later-account']) assert.ok(!serialized.includes(value));
  check('actual worker storage contains no raw platform cookie values or administrator credential');
  assert.deepEqual(pageErrors, []);
  writeFileSync(join(artifacts, 'results.json'), JSON.stringify({ result: 'pass',
    runtime: 'Actual extension source in isolated Chromium with temporary host grants and synthetic backend accounts',
    nativePermissionPromptVerified: false, actualPlatformLoginVerified: false, checks, screenshots, pageErrors }, null, 2));
  console.log(`PASS ${checks.length} options browser scenarios, 0 page errors`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  writeFileSync(join(artifacts, 'results.json'), JSON.stringify({ result: 'fail', error: error.message, checks, screenshots, pageErrors }, null, 2));
  throw error;
} finally {
  await context?.close(); await service.close();
  // temporary is the exact mkdtemp directory created above, never a user profile.
  rmSync(temporary, { recursive: true, force: true });
}
