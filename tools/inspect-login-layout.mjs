import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium, webkit } from 'playwright';

// Isolated local QA: the preview replaces Firebase with its in-memory adapter.
// Optional --baseline-prefix=/path/qa-baseline loads PREFIX-index.html and
// PREFIX-styles.css, allowing the same checks against the previous CSS/HTML.
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const output = path.resolve(option('out') || '../qa-login-layout');
const baseline = option('baseline-prefix');
const strict = !process.argv.includes('--record-only');
const engines = (option('engines') || 'chromium,webkit').split(',');
fs.mkdirSync(output, { recursive: true });
const stateDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'explora-login-layout-'));
const statePath=path.join(stateDirectory,'state.json');
process.env.PREVIEW_ROLE='driver';
process.env.PREVIEW_STATE_PATH=statePath;
const {server}=await import('./preview.mjs');
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const results = [], errors = [], blocked = [];
const viewports = [
  { width: 320, height: 568 }, { width: 390, height: 844 },
  { width: 768, height: 1024 }, { width: 1440, height: 900 },
  { width: 844, height: 390 }, { width: 390, height: 300 }
];
try {
  for (const engine of engines) {
    const browser = await (engine === 'webkit' ? webkit : chromium).launch(engine === 'chromium' ? { channel: 'msedge' } : {});
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      let profileGate = null, failProfile = false;
      await context.addInitScript(() => {
        if (!sessionStorage.getItem('layout-qa-initialized')) {
          sessionStorage.setItem('layout-qa-initialized', '1');
          sessionStorage.setItem('explora-preview-signed-out', '1');
        }
      });
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) { blocked.push(url.origin); await route.abort(); return; }
        if (url.pathname === '/__preview__/api' && (profileGate || failProfile)) {
          const body = route.request().postDataJSON();
          if (/^(usuarios|choferes)(\/|$)/.test(body.target?.path || '')) {
            if (failProfile) { await route.fulfill({ status:503, contentType:'application/json', body:JSON.stringify({error:'Profile network failure for local QA',code:'unavailable'}) }); return; }
            await profileGate;
          }
        }
        if (baseline && ['/', '/styles.css'].includes(url.pathname)) {
          let body = fs.readFileSync(`${baseline}-${url.pathname === '/' ? 'index.html' : 'styles.css'}`, 'utf8');
          body = body.replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[^"']+\.js/g, '/__preview__/firebase.js').replace(/<link[^>]+rel="preconnect"[^>]*>/g, '');
          await route.fulfill({ contentType: url.pathname === '/' ? 'text/html' : 'text/css', body }); return;
        }
        if (url.pathname === '/') {
          const response = await route.fetch();
          // The local-only banner is not part of the production layout.
          const body = (await response.text()).replace(/<div[^>]+role="note">VISTA LOCAL[\s\S]*?<\/div>/, '');
          await route.fulfill({ response, body }); return;
        }
        if (url.pathname === '/app.js') {
          const response = await route.fetch();
          await route.fulfill({ response, body: `${await response.text()}\nwindow.__layoutQA={startSplash,finishSplash};` }); return;
        }
        await route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(`${engine}: ${error.message}`));
      await page.goto(origin);
      await page.waitForFunction(() => window.__layoutQA && !document.getElementById('loginScreen').classList.contains('hidden'));
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        for (const state of ['splash', 'login', 'login-error']) {
          await page.evaluate(state => {
            if (state === 'splash') window.__layoutQA.startSplash('Cargando tu cuenta…');
            else {
              window.__layoutQA.finishSplash('loginScreen');
              document.getElementById('loginStatus').textContent = state === 'login-error' ? 'No se pudo iniciar sesión. Revisá el usuario y la clave e intentá de nuevo.' : '';
            }
            document.getElementById('loginScreen').scrollTop = 0;
            scrollTo(0, 0);
          }, state);
          const dimensions = await page.evaluate(state => {
            const container = document.getElementById(state === 'splash' ? 'splashScreen' : 'loginScreen');
            const content = document.getElementById(state === 'splash' ? 'splashMessage' : 'loginForm');
            const box = element => { const r = element.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
            const initial = box(content), shell = box(container);
            container.scrollTop = container.scrollHeight;
            const last = box(content);
            container.scrollTop = 0;
            return { shell, initial, last, viewport: { width: innerWidth, height: innerHeight }, clientHeight: container.clientHeight, scrollHeight: container.scrollHeight,
              documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight,
              position: getComputedStyle(container).position, overflowY: getComputedStyle(container).overflowY,
              topReachable: initial.top >= -1, bottomReachable: last.bottom <= innerHeight + 1,
              fillsViewport: Math.abs(shell.top) < 1 && Math.abs(shell.bottom - innerHeight) < 1 };
          }, state);
          const name = `${engine}-${viewport.width}x${viewport.height}-${state}`;
          const valid = dimensions.topReachable && dimensions.bottomReachable && dimensions.fillsViewport && dimensions.documentWidth <= viewport.width;
          results.push({ name, valid, ...dimensions });
          await page.screenshot({ path: path.join(output, `${name}.png`) });
          if (dimensions.scrollHeight > dimensions.clientHeight) {
            await page.locator(state === 'splash' ? '#splashScreen' : '#loginScreen').evaluate(element => { element.scrollTop = element.scrollHeight; });
            await page.screenshot({ path: path.join(output, `${name}-bottom.png`) });
          }
          console.log(`${valid ? 'PASS' : 'FAIL'} ${name}: shell=${dimensions.shell.top}..${dimensions.shell.bottom}, content=${dimensions.initial.top}..${dimensions.initial.bottom}, scrolled-bottom=${dimensions.last.bottom}`);
        }
      }
      // Return from interrupted loading and repeated opens must leave one shell visible.
      for (let index = 0; index < 3; index++) await page.evaluate(() => { window.__layoutQA.startSplash('Cargando tu cuenta…'); window.__layoutQA.finishSplash('loginScreen'); });
      assert.equal(await page.locator('#splashScreen').isVisible(), false);
      assert.equal(await page.locator('#loginScreen').isVisible(), true);
      assert.equal(await page.locator('#app').isVisible(), false);
      // Simulate a keyboard reducing the layout viewport while the field is focused.
      // CSS inset variables model reserved safe-area space; this is not a real device keyboard.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('#pass').focus();
      await page.setViewportSize({ width: 390, height: 300 });
      await page.evaluate(() => {
        document.documentElement.style.setProperty('--app-safe-top', '44px');
        document.documentElement.style.setProperty('--app-safe-bottom', '34px');
        document.getElementById('loginScreen').scrollTop = 0;
      });
      const safeArea = await page.locator('#loginScreen').evaluate(element => {
        void element.offsetHeight;
        element.scrollTop = 0;
        const initial = document.getElementById('loginForm').getBoundingClientRect().top;
        element.scrollTop = element.scrollHeight;
        return { initial, bottom: document.getElementById('loginForm').getBoundingClientRect().bottom,
          paddingBottom: parseFloat(getComputedStyle(element).paddingBottom), focused: document.activeElement.id };
      });
      console.log(`${engine} focused safe-area: ${JSON.stringify(safeArea)}`);
      assert.ok(safeArea.initial >= 44 && safeArea.bottom <= 300 - 34 + 1, JSON.stringify(safeArea));
      assert.equal(safeArea.focused, 'pass');
      await page.screenshot({ path: path.join(output, `${engine}-focused-keyboard-safe-area-bottom.png`) });
      await page.evaluate(() => { document.documentElement.style.removeProperty('--app-safe-top'); document.documentElement.style.removeProperty('--app-safe-bottom'); });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('#user').fill('prueba');
      await page.locator('#pass').fill('wrong-password');
      await page.locator('#loginBtn').click();
      await page.waitForFunction(() => document.getElementById('loginStatus').textContent && !document.getElementById('loginBtn').disabled);
      assert.equal(await page.locator('#loginScreen').isVisible(), true);
      assert.equal(await page.locator('#splashScreen').isVisible(), false);
      await page.screenshot({ path: path.join(output, `${engine}-real-login-error.png`) });
      let releaseProfile;
      profileGate = new Promise(resolve => { releaseProfile = resolve; });
      await page.locator('#pass').fill('explora-prueba');
      await page.locator('#loginBtn').click();
      await page.waitForFunction(() => !document.getElementById('splashScreen').hidden && document.getElementById('splashMessage').textContent.includes('cuenta'));
      await page.screenshot({ path: path.join(output, `${engine}-real-profile-loading.png`) });
      await page.setViewportSize({ width: 844, height: 390 });
      const loading = await page.locator('#splashScreen').boundingBox();
      assert.ok(Math.abs(loading.y) < 1 && Math.abs(loading.height - 390) < 1, 'Loading covers the rotated viewport');
      await page.screenshot({ path: path.join(output, `${engine}-real-profile-loading-landscape.png`) });
      profileGate = null;
      releaseProfile();
      await page.locator('#app').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#splashScreen').isVisible(), false);
      failProfile = true;
      await page.reload();
      await page.locator('#app').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#splashScreen').isVisible(), false);
      assert.equal(await page.locator('#loginScreen').isVisible(), false);
      await page.screenshot({ path: path.join(output, `${engine}-profile-network-failure.png`) });
      failProfile = false;
      await page.reload();
      await page.locator('#app').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#splashScreen').isVisible(), false);
      assert.equal(await page.locator('#loginScreen').isVisible(), false);
      console.log(`${engine}: profile failure followed by reload recovery PASS`);
      await context.close();
    } finally { await browser.close(); }
  }
} finally {
  await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(output, 'dimensions.json'), JSON.stringify({ results, errors, blocked }, null, 2));
  assert.equal(path.dirname(stateDirectory),path.resolve(os.tmpdir()));
  fs.rmSync(statePath,{force:true});
  fs.rmdirSync(stateDirectory);
}
assert.deepEqual(errors, [], 'Unexpected JavaScript errors');
assert.deepEqual(blocked, [], 'Unexpected external network attempts');
if (strict) assert.ok(results.every(result => result.valid), 'Some shells clipped content; inspect dimensions.json and screenshots.');
console.log(`Saved ${results.length} cases to ${output}`);
