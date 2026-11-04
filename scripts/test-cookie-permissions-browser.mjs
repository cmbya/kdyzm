import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { PLATFORMS } from '../cookie-extension/core.mjs';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const root = resolve(import.meta.dirname, '..'), source = join(root, 'cookie-extension');
const temporary = mkdtempSync(join(tmpdir(), 'pickcode-cookie-permissions-'));
const results = [];
try {
  for (const [name, origins, expected] of [
    ['https-only', ['https://*.yangkeduo.com/*'], 'IDENTITY_MISSING'],
    ['product-permissions', PLATFORMS.pdd.origins, 'ok']
  ]) {
    const extension = join(temporary, name); mkdirSync(extension);
    for (const file of readdirSync(source)) copyFileSync(join(source, file), join(extension, file));
    const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json')));
    manifest.host_permissions = origins;
    writeFileSync(join(extension, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(extension, 'background.mjs'), readFileSync(join(source, 'background.mjs'), 'utf8')
      + '\nself.fixtureReadCookie = () => readCookieHeader("pdd", chrome.cookies);\n');
    const context = await chromium.launchPersistentContext(join(temporary, name + '-profile'), {
      headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : { channel: 'chromium' }),
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    try {
      await context.route(/^https?:\/\//, route => route.abort());
      const page = await context.newPage(), cdp = await context.newCDPSession(page);
      const cookies = [
        { name: 'PDDAccessToken', value: 'synthetic-token', secure: true, httpOnly: true },
        { name: 'pdd_user_id', value: '73200020002', secure: false, httpOnly: false }
      ];
      // Set via CDP: Playwright's url form silently overwrites secure:false on HTTPS.
      for (const cookie of cookies) assert.equal((await cdp.send('Network.setCookie', {
        ...cookie, domain: 'mobile.yangkeduo.com', path: '/', sourceScheme: 'Secure'
      })).success, true);
      const stored = (await cdp.send('Network.getCookies', { urls: PLATFORMS.pdd.urls })).cookies;
      for (const cookie of cookies) {
        const actual = stored.find(item => item.name === cookie.name);
        assert.equal(actual?.secure, cookie.secure); assert.equal(actual?.httpOnly, cookie.httpOnly);
        assert.equal(actual?.sourceScheme, 'Secure'); assert.equal(actual?.value, cookie.value);
      }
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      const read = () => worker.evaluate(async () => {
        try { const header = await self.fixtureReadCookie();
          return { result: 'ok', hasUid: header.includes('pdd_user_id=73200020002'), hasToken: header.includes('PDDAccessToken=synthetic-token') };
        } catch (error) { return { result: error.code }; }
      });
      const desktop = await read(); assert.equal(desktop.result, expected);
      if (expected === 'ok') assert.deepEqual(desktop, { result: 'ok', hasUid: true, hasToken: true });
      await cdp.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', platform: 'iPad' });
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 2, mobile: true });
      const tablet = await read(); assert.deepEqual(tablet, desktop);
      results.push({ name, browser: context.browser().version(), desktop, tablet,
        cookieAttributesVerified: true, platformNetworkBlocked: true });
    } finally { await context.close(); }
  }
  const output = join(root, 'artifacts', 'cookie-permissions-browser'); mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'results.json'), JSON.stringify({ result: 'pass', checks: results }, null, 2));
  console.log('PASS ' + JSON.stringify(results));
} finally { rmSync(temporary, { recursive: true, force: true }); }
