#!/usr/bin/env node
/* Download every asset listed in a page's assets.txt into <pageDir>/assets/.
 * Solves SiteGround captcha once, then uses the context request API (carries cookie).
 * Usage: node download_assets.js <pageDir>
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function waitForCaptcha(page) {
  for (let i = 0; i < 40; i++) {
    const t = await page.title().catch(() => '');
    if (!/Robot Challenge|Loading https/i.test(t) && t !== '') return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

(async () => {
  const pageDir = process.argv[2];
  if (!pageDir) { console.error('Usage: node download_assets.js <pageDir>'); process.exit(1); }
  const assetsFile = path.join(pageDir, 'assets.txt');
  if (!fs.existsSync(assetsFile)) { console.error('no assets.txt in', pageDir); process.exit(1); }
  const urls = fs.readFileSync(assetsFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  const outDir = path.join(pageDir, 'assets');
  fs.mkdirSync(outDir, { recursive: true });

  const STATE = path.join(__dirname, '.auth', 'state.json');
  const browser = await chromium.launch();
  const ctxOpts = { ignoreHTTPSErrors: true };
  if (fs.existsSync(STATE)) ctxOpts.storageState = STATE;
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  await page.goto('https://logosbz.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await waitForCaptcha(page);
  await page.waitForTimeout(800);

  let ok = 0, fail = 0;
  const seen = new Set();
  for (const u of urls) {
    let fname;
    try { fname = decodeURIComponent(new URL(u).pathname.split('/').pop()) || 'index'; }
    catch (e) { continue; }
    // de-dup filenames by prefixing a counter if collision with different url
    let dest = path.join(outDir, fname);
    if (seen.has(fname) && fs.existsSync(dest)) { continue; }
    seen.add(fname);
    try {
      const resp = await ctx.request.get(u, { timeout: 30000 });
      if (!resp.ok()) { console.log(`  FAIL ${resp.status()} ${u}`); fail++; continue; }
      const buf = await resp.body();
      fs.writeFileSync(dest, buf);
      ok++;
    } catch (e) { console.log(`  ERR ${u} ${e.message}`); fail++; }
  }
  console.log(`[assets] ${pageDir}: downloaded ${ok}, failed ${fail}`);
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
