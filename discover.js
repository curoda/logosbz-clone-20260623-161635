#!/usr/bin/env node
/* Discover all internal URLs for logosbz.com.
 * Solves SiteGround PoW captcha once per context (cookie persists),
 * reads sitemap(s), then BFS-crawls internal links.
 */
const { chromium } = require('playwright');
const fs = require('fs');

const ORIGIN = 'https://logosbz.com';
const HOST = 'logosbz.com';

async function waitForCaptcha(page) {
  for (let i = 0; i < 40; i++) {
    const t = await page.title().catch(() => '');
    if (!/Robot Challenge|Loading https/i.test(t) && t !== '') return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

function norm(u) {
  try {
    const x = new URL(u, ORIGIN);
    if (x.hostname !== HOST) return null;
    x.hash = '';
    let s = x.href;
    // skip non-page assets
    if (/\.(jpg|jpeg|png|webp|gif|svg|pdf|zip|css|js|ico|xml|woff2?|ttf|mp4|webm)$/i.test(x.pathname)) return null;
    if (!s.endsWith('/') && !x.search) s += '/';
    return s;
  } catch (e) { return null; }
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();

  // Solve captcha once
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await waitForCaptcha(page);
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  console.log('captcha cleared, title:', await page.title());

  const external = new Set();
  const found = new Set();

  // --- read sitemaps ---
  const sitemaps = ['/sitemap_index.xml', '/sitemap.xml'];
  const subSitemaps = new Set();
  for (const sm of sitemaps) {
    try {
      const resp = await page.goto(ORIGIN + sm, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitForCaptcha(page);
      const body = await page.content();
      const locs = [...body.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1].replace(/&amp;/g, '&'));
      console.log(`sitemap ${sm}: ${locs.length} locs`);
      for (const l of locs) {
        if (/\.xml/i.test(l)) subSitemaps.add(l);
        else { const n = norm(l); if (n) found.add(n); }
      }
    } catch (e) { console.log('sitemap err', sm, e.message); }
  }
  for (const sub of subSitemaps) {
    try {
      await page.goto(sub, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitForCaptcha(page);
      const body = await page.content();
      const locs = [...body.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1].replace(/&amp;/g, '&'));
      console.log(`  sub-sitemap ${sub}: ${locs.length} locs`);
      for (const l of locs) { const n = norm(l); if (n) found.add(n); }
    } catch (e) { console.log('sub-sitemap err', sub, e.message); }
  }

  // --- BFS crawl ---
  const queue = ['/', ...[...found].map(u => u.replace(ORIGIN, ''))];
  const visited = new Set();
  found.add(ORIGIN + '/');
  while (queue.length) {
    const path = queue.shift();
    const url = norm(ORIGIN + path) || (ORIGIN + path);
    if (visited.has(url)) continue;
    visited.add(url);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await waitForCaptcha(page);
      await page.waitForTimeout(800);
      const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')));
      for (const raw of links) {
        if (!raw) continue;
        if (/^(mailto:|tel:|sms:|javascript:)/i.test(raw)) { external.add(raw); continue; }
        if (/^#/.test(raw)) continue;
        let abs;
        try { abs = new URL(raw, url).href; } catch (e) { continue; }
        if (new URL(abs).hostname !== HOST) { external.add(abs); continue; }
        const n = norm(abs);
        if (n && !found.has(n)) {
          found.add(n);
          queue.push(n.replace(ORIGIN, ''));
        }
      }
      console.log(`crawled ${url} (found total: ${found.size}, queue: ${queue.length})`);
    } catch (e) {
      console.log('crawl err', url, e.message);
    }
  }

  const sortedInternal = [...found].sort();
  const sortedExternal = [...external].sort();
  fs.writeFileSync('/work/logosbz-clone/discovered_internal.txt', sortedInternal.join('\n') + '\n');
  fs.writeFileSync('/work/logosbz-clone/discovered_external.txt', sortedExternal.join('\n') + '\n');
  console.log('\n=== INTERNAL ===');
  sortedInternal.forEach(u => console.log(u));
  console.log('\n=== EXTERNAL ===');
  sortedExternal.forEach(u => console.log(u));
  console.log(`\nTOTAL internal: ${sortedInternal.length}, external: ${sortedExternal.length}`);
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
