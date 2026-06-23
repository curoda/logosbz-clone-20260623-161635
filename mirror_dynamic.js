#!/usr/bin/env node
/* mirror_dynamic.js — download Elementor/Blocksy JS chunks that are loaded
 * DYNAMICALLY at runtime by webpack (their hashed filenames are computed in JS,
 * so the static mirror.js scan of <script src>/<link>/CSS never sees them).
 *
 * Without these (e.g. shared-frontend-handlers.*.bundle.min.js), Elementor's
 * frontend handlers throw "elementorModules is not defined" and never initialize
 * the background-slideshow Swiper or nested-tabs — leaving a frozen hero.
 *
 * Strategy: load representative ORIGINAL pages in a real browser, record every
 * https://logosbz.com/*.js request (including dynamic imports), and download any
 * file not already present in site/.
 *
 * Usage: node mirror_dynamic.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ORIGIN = 'https://logosbz.com';
const SITE = path.join(__dirname, 'site');
const STATE = path.join(__dirname, '.auth', 'state.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

// Pages that exercise the widgets whose handlers load as dynamic chunks.
const PAGES = ['/', '/about/areas-of-expertise/', '/services/', '/news/', '/careers/', '/contact/', '/our-people/'];

(async () => {
  const browser = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'] });
  const o = { ignoreHTTPSErrors: true, userAgent: UA, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
  if (fs.existsSync(STATE)) o.storageState = STATE;
  const ctx = await browser.newContext(o);
  const page = await ctx.newPage();

  const jsUrls = new Set();
  page.on('request', r => {
    const u = r.url();
    if (u.startsWith(ORIGIN + '/') && /\.js(\?|$)/.test(u)) jsUrls.add(u.split('?')[0]);
  });

  for (const pg of PAGES) {
    await page.goto(ORIGIN + pg, { waitUntil: 'networkidle', timeout: 60000 }).catch(e => console.log('nav', pg, e.message));
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  }

  const all = [...jsUrls];
  const missing = all.filter(u => !fs.existsSync(path.join(SITE, new URL(u).pathname)));
  console.log(`captured ${all.length} runtime JS urls; ${missing.length} missing from mirror`);

  let ok = 0, fail = 0;
  for (const u of missing) {
    const dest = path.join(SITE, new URL(u).pathname);
    try {
      const r = await ctx.request.get(u, { timeout: 40000 });
      if (!r.ok()) { console.log('FAIL', r.status(), u); fail++; continue; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, await r.body());
      console.log('OK', new URL(u).pathname);
      ok++;
    } catch (e) { console.log('ERR', u, e.message); fail++; }
  }
  console.log(`[mirror_dynamic] downloaded ${ok}, failed ${fail}`);
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
