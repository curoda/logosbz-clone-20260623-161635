#!/usr/bin/env node
/*
 * Reusable capture engine for website cloning.
 *
 * Usage:
 *   node capture.js <url> <outDir> [--slug=name]
 *
 * Guarantees:
 *  - deviceScaleFactor = 1 (saved pixels == CSS px)
 *  - fixed viewports: 1440x900 desktop, 390x844 mobile
 *  - long pages captured in vertical segments, each <= 1500px tall
 *  - every saved screenshot downscaled so its longest side <= 1500px
 *  - prints final pixel dimensions of every saved screenshot
 *
 * Produces in <outDir>:
 *   screenshot-desktop.png, screenshot-mobile.png (+ segment files if tall)
 *   page.html, styles.json, assets.txt, fonts.txt, embeds.txt, meta.txt, links.txt
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SEGMENT_MAX = 1500;      // max CSS px height per scroll segment
const DOWNSCALE_MAX = 1500;    // longest side cap for any saved screenshot
const STATE = path.join(__dirname, '.auth', 'state.json'); // persisted SiteGround clearance cookie

// Realistic UA + automation flag off so we pass Vercel's bot "Security Checkpoint".
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36';
const LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled'];

function ctxBase() {
  const o = { ignoreHTTPSErrors: true, deviceScaleFactor: 1, locale: 'en-US' };
  if (fs.existsSync(STATE)) o.storageState = STATE;
  return o;
}

function sh(cmd) {
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
  catch (e) { return (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : ''); }
}

function haveMagick() {
  try { execSync('which mogrify', { stdio: 'ignore' }); return true; }
  catch (e) { return false; }
}

// Downscale longest side to <= DOWNSCALE_MAX and report dimensions.
function downscaleAndReport(file) {
  if (haveMagick()) {
    sh(`mogrify -resize ${DOWNSCALE_MAX}x${DOWNSCALE_MAX}\\> "${file}"`);
    const out = sh(`identify -format "%wx%h" "${file}"`).trim();
    console.log(`   [img] ${path.basename(file)} -> ${out}`);
    const m = out.match(/(\d+)x(\d+)/);
    if (m && (parseInt(m[1]) > 2000 || parseInt(m[2]) > 2000)) {
      console.error(`   !!! OVERSIZED ${file} ${out}`);
    }
  } else {
    console.log(`   [img] ${path.basename(file)} (magick missing, not downscaled)`);
  }
}

async function waitForCaptcha(page) {
  // SiteGround PoW challenge AND Vercel "Security Checkpoint" both resolve via JS.
  for (let i = 0; i < 45; i++) {
    const t = await page.title().catch(() => '');
    if (t !== '' && !/Robot Challenge|Loading https|Security Checkpoint/i.test(t)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

async function gotoResolved(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(e => console.log('   nav warn:', e.message));
  await waitForCaptcha(page);
  // After challenge clears, wait for network to settle for the real page.
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

async function autoScroll(page) {
  // Scroll through the page to trigger lazy-loading, then back to top.
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const step = 400;
      const timer = setInterval(() => {
        const sh = document.body.scrollHeight;
        window.scrollBy(0, step);
        total += step;
        if (total >= sh + 1000) { clearInterval(timer); resolve(); }
      }, 100);
    });
  });
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
}

async function segmentedCapture(page, viewportW, viewportH, prefix, outDir) {
  // Full document height after lazy loads.
  const totalHeight = await page.evaluate(() => document.body.scrollHeight);
  const files = [];

  // Each segment = one viewport height (<= 900 desktop / 844 mobile), well under SEGMENT_MAX.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  if (totalHeight <= viewportH + 20) {
    const f = path.join(outDir, `${prefix}.png`);
    await page.screenshot({ path: f }); // viewport screenshot
    files.push(f);
  } else {
    let y = 0;
    let idx = 0;
    while (y < totalHeight) {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await page.waitForTimeout(350);
      const f = path.join(outDir, `${prefix}-seg${String(idx).padStart(2, '0')}.png`);
      await page.screenshot({ path: f }); // current viewport, exactly viewportH tall
      files.push(f);
      y += viewportH;
      idx++;
      if (idx > 60) break; // safety
    }
    // Representative top shot named ${prefix}.png (first segment copy).
    const main = path.join(outDir, `${prefix}.png`);
    fs.copyFileSync(files[0], main);
    files.push(main);
  }
  return files;
}

async function extractData(page) {
  return await page.evaluate(() => {
    const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch (e) { return u; } };

    // ---- styles.json ----
    const styleProps = ['font-family','font-size','font-weight','line-height','letter-spacing',
      'color','background-color','background-image','text-align','margin','padding','display',
      'flex-direction','justify-content','align-items','flex-wrap','gap',
      'grid-template-columns','grid-template-rows','max-width','width','height',
      'border-radius','box-shadow','position','text-transform','border','opacity','z-index'];
    const styles = [];
    const all = document.querySelectorAll('body *');
    let count = 0;
    all.forEach((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0;
      if (!visible) return;
      if (count > 4000) return; // safety cap
      const rec = { tag: el.tagName.toLowerCase() };
      if (el.id) rec.id = el.id;
      if (el.className && typeof el.className === 'string') rec.class = el.className;
      const txt = (el.childNodes && [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').trim()) || '';
      if (txt) rec.text = txt.slice(0, 120);
      rec.rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      const s = {};
      styleProps.forEach(p => { s[p] = cs.getPropertyValue(p); });
      rec.styles = s;
      styles.push(rec);
      count++;
    });

    // ---- assets ----
    const assets = new Set();
    document.querySelectorAll('img[src]').forEach(i => assets.add(abs(i.getAttribute('src'))));
    document.querySelectorAll('img[srcset], source[srcset]').forEach(i => {
      (i.getAttribute('srcset') || '').split(',').forEach(part => {
        const u = part.trim().split(/\s+/)[0];
        if (u) assets.add(abs(u));
      });
    });
    document.querySelectorAll('source[src]').forEach(s => assets.add(abs(s.getAttribute('src'))));
    document.querySelectorAll('video[src], audio[src], video source, audio source').forEach(v => {
      const u = v.getAttribute('src'); if (u) assets.add(abs(u));
      const p = v.getAttribute('poster'); if (p) assets.add(abs(p));
    });
    document.querySelectorAll('video[poster]').forEach(v => assets.add(abs(v.getAttribute('poster'))));
    // background images from computed styles on every element
    document.querySelectorAll('*').forEach(el => {
      const bg = getComputedStyle(el).getPropertyValue('background-image');
      if (bg && bg !== 'none') {
        const matches = bg.matchAll(/url\((['"]?)(.*?)\1\)/g);
        for (const m of matches) { if (m[2] && !m[2].startsWith('data:')) assets.add(abs(m[2])); }
      }
    });
    // favicons / app icons
    document.querySelectorAll('link[rel*="icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"], link[rel="manifest"]').forEach(l => {
      const u = l.getAttribute('href'); if (u) assets.add(abs(u));
    });
    // preload images
    document.querySelectorAll('link[rel="preload"][as="image"]').forEach(l => {
      const u = l.getAttribute('href'); if (u) assets.add(abs(u));
    });

    // ---- fonts ----
    const fonts = new Set();
    const fontFaces = [];
    try {
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch (e) { continue; }
        if (!rules) continue;
        for (const rule of rules) {
          if (rule.constructor && rule.constructor.name === 'CSSFontFaceRule') {
            const fam = rule.style.getPropertyValue('font-family');
            const src = rule.style.getPropertyValue('src');
            fontFaces.push(`${fam} | ${src}`);
          }
        }
      }
    } catch (e) {}
    document.querySelectorAll('body *').forEach(el => {
      const ff = getComputedStyle(el).getPropertyValue('font-family');
      if (ff) fonts.add(ff);
    });
    // font links
    document.querySelectorAll('link[href*="fonts"], link[rel="stylesheet"][href*="font"]').forEach(l => {
      fontFaces.push(`LINK | ${abs(l.getAttribute('href'))}`);
    });

    // ---- embeds ----
    const embeds = [];
    document.querySelectorAll('iframe, embed, object').forEach(e => {
      const src = e.getAttribute('src') || e.getAttribute('data') || '';
      embeds.push(`${e.tagName.toLowerCase()} | ${src ? abs(src) : '(no src)'}`);
    });

    // ---- meta ----
    const meta = {};
    meta.title = document.title || '';
    const gm = (sel, attr) => { const el = document.querySelector(sel); return el ? el.getAttribute(attr) : null; };
    meta.description = gm('meta[name="description"]', 'content');
    meta.canonical = gm('link[rel="canonical"]', 'href');
    meta.robots = gm('meta[name="robots"]', 'content');
    meta.viewport = gm('meta[name="viewport"]', 'content');
    meta.og = {};
    document.querySelectorAll('meta[property^="og:"]').forEach(m => { meta.og[m.getAttribute('property')] = m.getAttribute('content'); });
    meta.twitter = {};
    document.querySelectorAll('meta[name^="twitter:"]').forEach(m => { meta.twitter[m.getAttribute('name')] = m.getAttribute('content'); });
    // analytics / tag ids
    const analytics = new Set();
    document.querySelectorAll('script[src]').forEach(s => {
      const src = s.getAttribute('src');
      if (/gtag|googletagmanager|analytics|gtm\.js|fbevents|hotjar|clarity|segment|mixpanel|plausible|matomo/i.test(src)) analytics.add(abs(src));
    });
    const html = document.documentElement.innerHTML;
    const idmatches = html.match(/(UA-\d{4,}-\d+|G-[A-Z0-9]{6,}|GTM-[A-Z0-9]{4,}|AW-\d{6,})/g);
    if (idmatches) idmatches.forEach(x => analytics.add(x));
    meta.analytics = [...analytics];

    // ---- links ----
    const links = [];
    const host = location.hostname;
    document.querySelectorAll('a[href]').forEach(a => {
      const raw = a.getAttribute('href');
      if (!raw) return;
      let internal = false;
      let absu = raw;
      if (/^(mailto:|tel:|sms:|javascript:|#)/i.test(raw)) {
        internal = false;
      } else {
        try { const u = new URL(raw, document.baseURI); absu = u.href; internal = (u.hostname === host); }
        catch (e) {}
      }
      links.push({ href: raw, abs: absu, internal, text: (a.textContent || '').trim().slice(0, 60) });
    });

    return { styles, assets: [...assets], fonts: [...fonts], fontFaces, embeds, meta, links,
             docHeight: document.body.scrollHeight };
  });
}

async function run() {
  const url = process.argv[2];
  const outDir = process.argv[3];
  if (!url || !outDir) { console.error('Usage: node capture.js <url> <outDir>'); process.exit(1); }
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ args: LAUNCH_ARGS });

  // ---------- DESKTOP ----------
  const ctxD = await browser.newContext({ ...ctxBase(), viewport: { width: 1440, height: 900 }, userAgent: UA_DESKTOP });
  const pageD = await ctxD.newPage();
  console.log(`[capture] DESKTOP ${url}`);
  await gotoResolved(pageD, url);
  await autoScroll(pageD);

  // Data extraction (desktop is canonical for HTML/styles/assets)
  const data = await extractData(pageD);

  // Save HTML (fully rendered)
  const html = await pageD.content();
  fs.writeFileSync(path.join(outDir, 'page.html'), html);

  // Save the text outputs
  fs.writeFileSync(path.join(outDir, 'styles.json'), JSON.stringify(data.styles, null, 2));
  fs.writeFileSync(path.join(outDir, 'assets.txt'), data.assets.join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'fonts.txt'),
    'COMPUTED FONT-FAMILIES:\n' + data.fonts.join('\n') + '\n\n@font-face / FONT LINKS:\n' + data.fontFaces.join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'embeds.txt'), data.embeds.join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'meta.txt'), JSON.stringify(data.meta, null, 2));
  const linkLines = data.links.map(l => `${l.internal ? 'INTERNAL' : 'EXTERNAL'}\t${l.href}\t=> ${l.abs}\t| ${l.text}`);
  fs.writeFileSync(path.join(outDir, 'links.txt'), linkLines.join('\n') + '\n');

  // Desktop screenshots (segmented, bounded)
  const dFiles = await segmentedCapture(pageD, 1440, 900, 'screenshot-desktop', outDir);
  console.log('[capture] desktop screenshot files:');
  dFiles.forEach(downscaleAndReport);
  await ctxD.close();

  // ---------- MOBILE ----------
  const ctxM = await browser.newContext({ ...ctxBase(), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: UA_MOBILE });
  const pageM = await ctxM.newPage();
  console.log(`[capture] MOBILE ${url}`);
  await gotoResolved(pageM, url);
  await autoScroll(pageM);
  const mFiles = await segmentedCapture(pageM, 390, 844, 'screenshot-mobile', outDir);
  console.log('[capture] mobile screenshot files:');
  mFiles.forEach(downscaleAndReport);
  await ctxM.close();

  await browser.close();

  console.log(`[capture] DONE -> ${outDir}`);
  console.log(`   assets:${data.assets.length} links:${data.links.length} embeds:${data.embeds.length} styledEls:${data.styles.length} docHeight:${data.docHeight}`);
}

run().catch(e => { console.error('FATAL', e); process.exit(1); });
