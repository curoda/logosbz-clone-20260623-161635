# logosbz.com clone

Pixel-faithful clone of https://logosbz.com/ (Lógos BZ — healthcare facility design firm).

## Structure
- `capture.js` — reusable Playwright capture engine (screenshots capped at 1500px longest side, computed styles, assets, metadata).
- `discover.js` — internal URL crawler.
- `urls.txt` / `links.txt` — discovered URL inventory.
- `capture/` — raw captured spec per page (screenshots, page.html, styles.json, assets, meta, etc.).
- `site/` — the rebuilt static site (deployed to Vercel).

## Notes
- Original site is behind a SiteGround proof-of-work CAPTCHA; the capture engine solves it automatically by running JS in real Chromium.
