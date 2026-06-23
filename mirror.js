#!/usr/bin/env node
/* Mirror all CSS/JS/font/image assets for logosbz.com into site/ (path-preserving),
 * recursively resolving url()/@import inside CSS. Rewrites absolute logosbz URLs
 * inside CSS to root-relative. Uses Playwright ctx.request (carries captcha cookie).
 *
 * Usage: node mirror.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ORIGIN = 'https://logosbz.com';
const SITE = path.join(__dirname, 'site');
const STATE = path.join(__dirname, '.auth', 'state.json');

function urlToLocal(u) {
  // Map https://logosbz.com/<path>?query -> site/<path> (query dropped)
  const x = new URL(u);
  let p = decodeURIComponent(x.pathname);
  if (p.endsWith('/')) p += 'index.html';
  return path.join(SITE, p);
}

const ASSET_RE = /\.(css|js|mjs|woff2?|ttf|otf|eot|png|jpe?g|webp|gif|svg|ico|json|mp4|webm|avif)$/i;

function isAsset(u) {
  try { const x = new URL(u); return ASSET_RE.test(x.pathname); } catch (e) { return false; }
}

async function run() {
  const seedUrls = JSON.parse(fs.readFileSync('/tmp/all_resource_urls.json', 'utf8'))
    .filter(u => u.startsWith(ORIGIN) && isAsset(u));

  const browser = await chromium.launch();
  const ctxOpts = { ignoreHTTPSErrors: true };
  if (fs.existsSync(STATE)) ctxOpts.storageState = STATE;
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  // ensure not on challenge
  for (let i = 0; i < 30; i++) { const t = await page.title().catch(()=> ''); if (/L[óo]gos|Designing/i.test(t)) break; await page.waitForTimeout(1000); }

  const queue = [...new Set(seedUrls)];
  const done = new Set();
  let ok = 0, fail = 0;

  async function fetchSave(u) {
    if (done.has(u)) return null;
    done.add(u);
    const dest = urlToLocal(u);
    try {
      const resp = await ctx.request.get(u, { timeout: 45000 });
      if (!resp.ok()) { console.log(`  FAIL ${resp.status()} ${u}`); fail++; return null; }
      let buf = await resp.body();
      const isCss = /\.css(\?|$)/i.test(u);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (isCss) {
        let css = buf.toString('utf8');
        // find url(...) and @import deps
        const deps = new Set();
        const urlRe = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/g;
        let m;
        while ((m = urlRe.exec(css)) !== null) {
          const raw = m[2].trim();
          if (raw.startsWith('data:')) continue;
          let abs; try { abs = new URL(raw, u).href; } catch (e) { continue; }
          if (abs.startsWith(ORIGIN)) deps.add(abs);
        }
        const importRe = /@import\s+(?:url\()?\s*(['"])([^'"]+)\1/g;
        while ((m = importRe.exec(css)) !== null) {
          let abs; try { abs = new URL(m[2], u).href; } catch (e) { continue; }
          if (abs.startsWith(ORIGIN)) deps.add(abs);
        }
        // rewrite absolute logosbz URLs -> root-relative
        css = css.replace(/https:\/\/logosbz\.com/g, '');
        fs.writeFileSync(dest, css);
        for (const d of deps) if (!done.has(d) && d !== u) queue.push(d);
      } else {
        fs.writeFileSync(dest, buf);
      }
      ok++;
      return dest;
    } catch (e) { console.log(`  ERR ${u} ${e.message}`); fail++; return null; }
  }

  while (queue.length) {
    const u = queue.shift();
    await fetchSave(u);
    if ((ok + fail) % 25 === 0) console.log(`  progress ok=${ok} fail=${fail} queue=${queue.length}`);
  }

  console.log(`[mirror] done ok=${ok} fail=${fail} total=${done.size}`);
  await browser.close();
}
run().catch(e => { console.error('FATAL', e); process.exit(1); });
