#!/usr/bin/env node
/* Bootstrap a SiteGround-cleared session and persist cookies to .auth/state.json.
 * Reused by capture.js / download_assets.js so the PoW challenge is solved ONCE
 * (repeated fresh solves escalate to a visual captcha).
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const STATE = path.join(__dirname, '.auth', 'state.json');

async function isChallenge(page) {
  const t = await page.title().catch(() => '');
  if (/Robot Challenge|Loading https/i.test(t)) return 'pow';
  const body = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
  if (/Our system thinks you might be a robot|complete the captcha below/i.test(body)) return 'visual';
  if (/Internal Server Error|50[0-9]\b/i.test(t)) return 'error';
  return null;
}

async function solve(page) {
  // Wait up to 50s for PoW to auto-solve and redirect to the REAL page.
  for (let i = 0; i < 50; i++) {
    const c = await isChallenge(page);
    if (c === 'visual') return 'visual';
    if (c === null) {
      const t = await page.title().catch(() => '');
      // Require the genuine site (not blank, not an error page).
      if (/L[óo]gos|Designing Your Future/i.test(t)) return true;
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

async function ensureSession({ force = false } = {}) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const browser = await chromium.launch();
  // Reuse existing state if present and not forced
  const ctxOpts = { ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
  if (!force && fs.existsSync(STATE)) ctxOpts.storageState = STATE;
  let ctx = await browser.newContext(ctxOpts);
  let page = await ctx.newPage();
  await page.goto('https://logosbz.com/', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  let res = await solve(page);
  if (res === true) {
    await ctx.storageState({ path: STATE });
    console.log('[session] OK (existing/quick). title:', await page.title());
    await browser.close();
    return true;
  }
  // Visual captcha or failure: back off and retry with a clean context several times.
  for (let attempt = 1; attempt <= 6; attempt++) {
    await ctx.close();
    const wait = 8000 * attempt;
    console.log(`[session] challenge=${res}; backing off ${wait}ms then clean retry ${attempt}`);
    await new Promise(r => setTimeout(r, wait));
    ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    page = await ctx.newPage();
    await page.goto('https://logosbz.com/', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    res = await solve(page);
    if (res === true) {
      await ctx.storageState({ path: STATE });
      console.log('[session] OK after retry', attempt, 'title:', await page.title());
      await browser.close();
      return true;
    }
  }
  console.error('[session] FAILED to clear captcha');
  await browser.close();
  return false;
}

module.exports = { ensureSession, STATE, isChallenge, solve };

if (require.main === module) {
  ensureSession({ force: process.argv.includes('--force') }).then(ok => process.exit(ok ? 0 : 1));
}
