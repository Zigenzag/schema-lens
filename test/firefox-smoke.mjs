// End-to-end smoke test in a real, headless Firefox, driven over WebDriver BiDi
// (built into Firefox, so there is no driver to download). It installs the
// add-on into a throwaway profile and then uses it the way a person would:
// clicks the toolbar button, reads the popup, moves it to the sidebar, grants
// site access and switches tabs.
//
//   npm run test:firefox
//   FIREFOX=/path/to/firefox  SMOKE_SHOTS=some/dir  npm run test:firefox
//   SMOKE_SCHEME=light|dark   force the colour scheme (default: the system's)
//   SMOKE_CLIPBOARD=1         also test copying; on by default in CI only,
//                             so a local run never touches your clipboard
//
// Reaching the browser's own UI needs Firefox's "system access" mode, which
// this script switches on for its own Firefox process only.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedFormats } from './fixtures/formats.expected.mjs';

const ADDON_ID = 'schema-lens@zigenzag.co.uk';
const WIDGET = 'schema-lens_zigenzag_co_uk'; // how Firefox spells the id in its own element ids
const root = fileURLToPath(new URL('..', import.meta.url));
const firefox = process.env.FIREFOX || (process.platform === 'win32' ? 'C:\\Program Files\\Mozilla Firefox\\firefox.exe' : 'firefox');
const httpPort = 8766;
const bidiPort = 9333;
const fixtures = `http://localhost:${httpPort}/test/fixtures`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const profile = await mkdtemp(join(process.env.SMOKE_TMP || tmpdir(), 'schema-lens-profile-'));
const downloads = join(profile, 'downloads');
await mkdir(downloads);
const prefs = {
  'browser.download.dir': downloads, // keep the test's download out of the real Downloads folder
  'browser.download.folderList': 2,
  'browser.download.useDownloadDir': true,
  'browser.download.alwaysOpenPanel': false,
  'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: randomUUID() }),
  'extensions.webextOptionalPermissionPrompts': false, // grant optional permissions without the doorhanger
  'browser.shell.checkDefaultBrowser': false,
  'browser.aboutwelcome.enabled': false,
  'datareporting.policy.dataSubmissionEnabled': false,
  'app.update.enabled': false,
};
const scheme = { dark: 0, light: 1 }[process.env.SMOKE_SCHEME];
if (scheme !== undefined) {
  Object.assign(prefs, {
    'ui.systemUsesDarkTheme': 1 - scheme,
    'layout.css.prefers-color-scheme.content-override': scheme,
    'browser.theme.toolbar-theme': scheme,
    'browser.theme.content-theme': scheme,
  });
}
await writeFile(join(profile, 'user.js'), Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n'));

const server = spawn(process.execPath, [join(root, 'test', 'serve.mjs'), String(httpPort)], { stdio: 'ignore' });
const browser = spawn(firefox, ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', String(bidiPort)], {
  stdio: 'ignore',
  env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
});

let socket;
let failed = false;
try {
  // -------------------------------------------------------- BiDi plumbing
  for (let attempt = 0; !socket; attempt++) {
    try {
      socket = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${bidiPort}/session`);
        ws.addEventListener('open', () => resolve(ws), { once: true });
        ws.addEventListener('error', () => reject(new Error('Firefox did not open its BiDi port')), { once: true });
      });
    } catch (err) {
      if (attempt > 60) throw err;
      await sleep(500);
    }
  }
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.type === 'error') waiter.reject(new Error(`${msg.error}: ${msg.message}`));
    else waiter.resolve(msg.result);
  });
  let nextId = 0;
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send('session.new', { capabilities: {} });
  await send('webExtension.install', { extensionData: { type: 'path', path: join(root, 'extension') } });
  const [page] = (await send('browsingContext.getTree')).contexts;
  const [chromeWindow] = (await send('browsingContext.getTree', { 'moz:scope': 'chrome' })).contexts;

  /** Runs an expression in the browser's own window and returns its JSON-serialisable result. */
  const chrome = async (expression) => {
    const res = await send('script.evaluate', {
      expression: `(async () => JSON.stringify(await (${expression})))()`,
      target: { context: chromeWindow.context },
      awaitPromise: true,
    });
    if (res.type !== 'success') throw new Error(`In browser window: ${res.exceptionDetails.text}`);
    return res.result.value === undefined ? undefined : JSON.parse(res.result.value);
  };

  // Helpers living in the browser window. The popup and the sidebar are
  // out-of-process <browser>s, so their DOM is reached with a frame script.
  await chrome(`(() => {
    window.smoke = {
      popup: () => [...document.querySelectorAll('.webextension-popup-browser')].find((b) => b.closest('panel')?.state === 'open'),
      sidebar: () => document.getElementById('sidebar').contentDocument?.getElementById('webext-panels-browser'),
      inPage(target, body) {
        if (!target) return Promise.resolve(null);
        return new Promise((resolve) => {
          const mm = target.messageManager;
          const name = 'smoke:' + Math.random();
          mm.addMessageListener(name, function once(msg) {
            mm.removeMessageListener(name, once);
            resolve(msg.data);
          });
          const script = 'try { const document = content.document; sendAsyncMessage(' + JSON.stringify(name) +
            ', (function () { ' + body + ' })()); } catch (e) { sendAsyncMessage(' + JSON.stringify(name) + ', { threw: String(e) }); }';
          mm.loadFrameScript('data:application/javascript;charset=utf-8,' + encodeURIComponent(script), false);
        });
      },
      async shot(target) {
        const bitmap = await target.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, 'white');
        const canvas = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        return canvas.toDataURL('image/png').split(',')[1];
      },
    };
  })()`);

  const inPage = (which, body) => chrome(`smoke.inPage(smoke.${which}(), ${JSON.stringify(body)})`);
  const until = async (what, check) => {
    let last;
    for (let i = 0; i < 40; i++) {
      last = await check().catch((err) => err.message);
      if (last && typeof last === 'object' && !last.threw) return last;
      await sleep(250);
    }
    throw new Error(`Timed out waiting for ${what} (last saw ${JSON.stringify(last)})`);
  };
  /**
   * A trusted click, so Firefox treats it as user input. The page may go away
   * as a result (the popup closes itself), so don't wait long for an answer.
   */
  const click = (which, selector) => {
    const body = `const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2, utils = content.windowUtils;
      for (const type of ['mousedown', 'mouseup']) {
        if (content.synthesizeMouseEvent) content.synthesizeMouseEvent(type, x, y, { button: 0, clickCount: 1 });
        else utils.sendMouseEvent(type, x, y, 0, 1, 0); // Firefox before the API was renamed
      }
      return { clicked: true };`;
    return chrome(`Promise.race([smoke.inPage(smoke.${which}(), ${JSON.stringify(body)}), new Promise((r) => setTimeout(() => r({ gone: true }), 1500))])`);
  };
  const saveShot = async (which, name) => {
    if (!process.env.SMOKE_SHOTS) return;
    await writeFile(join(process.env.SMOKE_SHOTS, name), Buffer.from(await chrome(`smoke.shot(smoke.${which}())`), 'base64'));
  };

  // What the panel shows, in a form that is easy to compare.
  const READ = `
    const all = (sel) => Array.from(document.querySelectorAll(sel));
    if (document.getElementById('list').hasAttribute('aria-busy')) return null;
    return {
      view: document.documentElement.dataset.view,
      state: document.querySelector('.state h2')?.textContent ?? '',
      summary: document.getElementById('summary').hidden ? '' : document.getElementById('summary').textContent,
      objects: all('.obj:not(.error) > summary').map((s) => s.querySelector('.type').textContent + ' | ' + s.querySelector('.label').textContent),
      origins: all('.origin:not([hidden])').map((o) => o.textContent),
      error: document.querySelector('.obj.error .label')?.textContent ?? '',
      errorWhere: document.querySelector('.err-where')?.textContent ?? '',
    };`;
  const OBJECTS = [
    'Product | Classic Leather Wallet',
    'Organization | Northfold Goods',
    'WebSite | Northfold',
    'WebPage, ItemPage | https://example.com/wallet#page',
    'BreadcrumbList | https://example.com/wallet#crumbs',
    'FAQPage | ',
    'No @type | An object with no type',
    'Article | How we tan our leather',
    'Review | ',
    'Place | Northfold Workshop',
  ];
  const ORIGINS = ['In page source', 'In page source', 'In page source', 'In page source', 'Added by JavaScript'];
  const SUMMARY = '10 objects8 JSON-LD1 Microdata1 RDFa1 error';

  // ----------------------------------------------- 1. toolbar button → popup
  await send('browsingContext.navigate', { context: page.context, url: `${fixtures}/sample.html`, wait: 'complete' });
  await chrome(`(() => {
    CustomizableUI.addWidgetToArea('${WIDGET}-browser-action', CustomizableUI.AREA_NAVBAR);
    document.querySelector('#${WIDGET}-browser-action .unified-extensions-item-action-button').click();
  })()`);
  const popup = await until('the popup to finish reading the page', async () => {
    const seen = await inPage('popup', READ);
    return seen && seen.origins.length === 5 ? seen : null;
  });
  assert.equal(popup.view, 'popup');
  assert.equal(popup.summary, SUMMARY);
  assert.deepEqual(popup.objects, OBJECTS);
  assert.deepEqual(popup.origins, ORIGINS);
  assert.equal(popup.errorWhere, 'Line 7, column 3 of this block');
  assert.ok(popup.error && !/JSON\.parse|line \d/.test(popup.error), `a clean error message, got "${popup.error}"`);
  const size = await chrome(`(() => { const r = smoke.popup().getBoundingClientRect(); return { width: r.width, height: r.height }; })()`);
  assert.deepEqual(size, { width: 520, height: 600 });
  console.log(`ok  toolbar button opens a 520×600 popup listing 10 objects in three formats; parse error reads "${popup.error}"`);

  // Accordions fill in when opened; search filters, opens and highlights.
  const tree = await inPage('popup', `
    const product = document.querySelector('.obj');
    product.open = true;
    product.dispatchEvent(new content.Event('toggle'));
    const rows = product.querySelectorAll('.body > *').length;
    const width = (text) => { const s = document.createElement('span'); s.textContent = text; product.querySelector('.body').append(s); const w = s.getBoundingClientRect().width; s.remove(); return w; };
    const monospace = width('iiiiiiii') === width('MMMMMMMM');
    const q = document.getElementById('q');
    q.value = 'north';
    q.dispatchEvent(new content.Event('input'));
    q.dispatchEvent(new content.KeyboardEvent('keydown', { key: 'Enter' }));
    return { rows, monospace, hits: document.getElementById('hits').textContent, marks: document.querySelectorAll('mark').length,
      shown: Array.from(document.querySelectorAll('.obj:not(.error)')).filter((o) => !o.hidden).length };`);
  assert.deepEqual(tree, { rows: 11, monospace: true, hits: '1 of 7', marks: 7, shown: 4 });
  console.log('ok  accordion shows the object tree in a monospace font; search finds 7 matches in 4 objects');
  await saveShot('popup', 'firefox-popup.png');

  await click('popup', '#btn-download');
  const saved = await until('the download to be saved', async () =>
    JSON.parse(await readFile(join(downloads, 'localhost-test-fixtures-sample.html-schema.json'), 'utf8')),
  );
  assert.equal(saved.length, 6, 'one entry per JSON-LD block that parsed, then each Microdata and RDFa item');
  assert.equal(saved[0]['@type'], 'Product');
  assert.equal(saved[3].headline, 'How we tan our leather');
  assert.deepEqual([saved[4]['@type'], saved[5]['@type']], ['Review', 'Place']);
  assert.equal(await chrome(`!!smoke.popup()`), true, 'the popup stays open after a download');
  console.log('ok  download saves the 4 valid JSON-LD blocks plus the Microdata and RDFa items as one .json file');

  if (process.env.CI || process.env.SMOKE_CLIPBOARD) {
    await click('popup', '#btn-copy');
    const toast = await until('the copy confirmation', async () => {
      const seen = await inPage('popup', `return { text: document.getElementById('toast').textContent };`);
      return seen && seen.text ? seen : null;
    });
    assert.equal(toast.text, 'All structured data copied');
    const copied = JSON.parse(await chrome(`navigator.clipboard.readText()`));
    assert.equal(copied.length, 6, 'the clipboard holds the same six entries as the download');
    console.log('ok  copy puts all structured data on the clipboard');
  }

  // --------------------------------------- 2. "Keep open in the sidebar" button
  await click('popup', '#btn-sidebar');
  const pinned = await until('the sidebar to open on the same page', async () => {
    const seen = await inPage('sidebar', READ);
    return seen && seen.origins.length === 5 ? seen : null;
  });
  assert.equal(pinned.view, 'sidebar');
  assert.deepEqual(pinned.objects, OBJECTS);
  assert.equal(await chrome(`SidebarController.currentID`), `${WIDGET}-sidebar-action`);
  assert.equal(await chrome(`!!smoke.popup()`), false, 'the popup closes');
  console.log('ok  sidebar button moves the inspector into the sidebar');

  // ---------------------------- 3. another tab: asks for site access, then follows
  await chrome(`(() => { gBrowser.selectedTab = gBrowser.addTrustedTab('${fixtures}/empty.html'); })()`);
  const ask = await until('the sidebar to ask for site access', async () => {
    const seen = await inPage('sidebar', READ);
    return seen && seen.state === 'Follow along as you browse' ? seen : null;
  });
  assert.deepEqual(ask.objects, []);
  await saveShot('sidebar', 'firefox-sidebar-permission.png');
  await click('sidebar', '.state .btn');
  await until('the sidebar to read the new tab', async () => {
    const seen = await inPage('sidebar', READ);
    return seen && seen.state === 'No structured data on this page' && seen.summary === '' ? seen : null;
  });
  console.log('ok  on a new tab the sidebar asks for site access, then reports a page without structured data');

  await chrome(`(() => { gBrowser.selectedTab = gBrowser.tabs[0]; })()`);
  const back = await until('the sidebar to follow the tab switch', async () => {
    const seen = await inPage('sidebar', READ);
    return seen && seen.origins.length === 5 ? seen : null;
  });
  assert.equal(back.summary, SUMMARY);
  assert.deepEqual(back.objects, OBJECTS);
  assert.deepEqual(back.origins, ORIGINS);
  console.log('ok  sidebar follows the switch back to the first tab');
  await saveShot('sidebar', 'firefox-sidebar.png');

  // ------------------------------------ 4. a page with only Microdata and RDFa
  await chrome(`(() => { gBrowser.selectedTab = gBrowser.addTrustedTab('${fixtures}/formats.html'); })()`);
  const formats = await until('the sidebar to show Microdata and RDFa items', async () => {
    const seen = await inPage('sidebar', READ);
    return seen && seen.objects.length === 4 ? seen : null;
  });
  assert.equal(formats.summary, '4 objects2 Microdata2 RDFa');
  assert.deepEqual(formats.objects, [
    'BreadcrumbList | ',
    'Product | Classic Wallet',
    'Person | Sam Field',
    'Event, http://example.com/ns#Gig | Launch night',
  ]);
  assert.deepEqual(formats.origins, [], 'no source label on Microdata or RDFa');
  await click('sidebar', '#btn-download');
  const converted = await until('the converted download', async () =>
    JSON.parse(await readFile(join(downloads, 'localhost-test-fixtures-formats.html-schema.json'), 'utf8')),
  );
  const expected = expectedFormats(`http://localhost:${httpPort}`);
  assert.deepEqual(converted, [...expected.microdata, ...expected.rdfa]);
  console.log('ok  Microdata and RDFa items are parsed into the expected objects and shown as accordions');
  await saveShot('sidebar', 'firefox-sidebar-formats.png');

  // ---------------------------------------------- 5. pages that can't be read
  await chrome(`(() => { gBrowser.selectedTab = gBrowser.addTrustedTab('about:preferences'); })()`);
  await until('the sidebar to explain a restricted page', async () => {
    const seen = await inPage('sidebar', READ);
    return seen && seen.state === 'This page can’t be inspected' ? seen : null;
  });
  console.log('ok  browser-internal pages get a clear "can’t be inspected" message');

  await send('browser.close').catch(() => {});
} catch (err) {
  failed = true;
  console.error(`FAILED  ${err.message}`);
} finally {
  socket?.close();
  server.kill();
  browser.kill();
  await sleep(1500); // let Firefox release the profile before removing it
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
}
process.exit(failed ? 1 : 0);
