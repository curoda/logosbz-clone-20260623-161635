#!/usr/bin/env node
/* Batch-capture a set of pages by invoking capture.js + download_assets.js,
 * with pacing between pages to avoid SiteGround escalation.
 * Reads urls.txt (slug|url). Skips pages whose folder already has page.html
 * unless --force. Optional args: slug filter list.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const force = process.argv.includes('--force');
const only = process.argv.slice(2).filter(a => !a.startsWith('--'));

const env = { ...process.env, NODE_PATH: '/home/claude/.npm-global/lib/node_modules', PLAYWRIGHT_BROWSERS_PATH: '/opt/pw-browsers' };

const lines = fs.readFileSync(path.join(__dirname, 'urls.txt'), 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
const pages = lines.map(l => { const [slug, url] = l.split('|'); return { slug, url }; });

(async () => {
  for (const { slug, url } of pages) {
    if (only.length && !only.includes(slug)) continue;
    const dir = path.join('capture', slug);
    if (!force && fs.existsSync(path.join(dir, 'page.html'))) {
      console.log(`SKIP ${slug} (already captured)`);
      continue;
    }
    console.log(`\n===== CAPTURE ${slug} -> ${url} =====`);
    try {
      execSync(`node capture.js "${url}" "${dir}"`, { stdio: 'inherit', env, timeout: 300000 });
      execSync(`node download_assets.js "${dir}"`, { stdio: 'inherit', env, timeout: 200000 });
    } catch (e) {
      console.error(`ERROR capturing ${slug}: ${e.message}`);
    }
    // pacing delay between pages
    await new Promise(r => setTimeout(r, 4000));
  }
  console.log('\n[batch] done');
})();
