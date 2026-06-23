#!/usr/bin/env node
/* Capture the LIVE clone (Vercel) for all pages into verify/<slug>/, using the
 * same capture engine. Maps each original URL to the clone base URL.
 * Usage: node verify_capture.js <cloneBaseUrl> [slug ...]
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const base = (process.argv[2] || 'https://logosbz-clone.vercel.app').replace(/\/$/, '');
const only = process.argv.slice(3);
const env = { ...process.env, NODE_PATH: '/home/claude/.npm-global/lib/node_modules', PLAYWRIGHT_BROWSERS_PATH: '/opt/pw-browsers' };

const lines = fs.readFileSync(path.join(__dirname, 'urls.txt'), 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
(async () => {
  for (const line of lines) {
    const [slug, url] = line.split('|');
    if (only.length && !only.includes(slug)) continue;
    const clonePath = url.replace('https://logosbz.com', '');
    const cloneUrl = base + clonePath;
    const dir = path.join('verify', slug);
    console.log(`\n=== VERIFY ${slug} -> ${cloneUrl} ===`);
    try {
      execSync(`node capture.js "${cloneUrl}" "${dir}"`, { stdio: 'inherit', env, timeout: 180000 });
    } catch (e) { console.error('ERR', slug, e.message); }
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log('\n[verify] done');
})();
