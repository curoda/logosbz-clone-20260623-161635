#!/usr/bin/env python3
"""Build the static site/ pages from captured rendered HTML.
 - Localizes all logosbz.com resource/link URLs to root-relative.
 - Preserves canonical / og / twitter absolute URLs for metadata fidelity.
 - Injects a fallback to reveal Elementor entrance-animation elements.
 - Writes each page to site/<path>/index.html.
"""
import os, re, json

ROOT = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(ROOT, 'site')

# slug|url
pages = []
for line in open(os.path.join(ROOT, 'urls.txt')):
    line = line.strip()
    if not line or '|' not in line:
        continue
    slug, url = line.split('|', 1)
    pages.append((slug, url))

# Fallback script: reveal any Elementor element still hidden after load (in case
# the IntersectionObserver-based reveal does not fire in the static context).
FALLBACK = """
<style id="clone-fallback-style">
/* Safety: never leave entrance-animation content invisible */
.elementor-invisible{visibility:visible !important;}
</style>
<script id="clone-fallback">
(function(){
  function reveal(){
    document.querySelectorAll('.elementor-invisible').forEach(function(el){
      el.classList.remove('elementor-invisible');
      el.style.opacity='';
    });
  }
  // Give Elementor a chance to run its own animations first, then force-reveal.
  window.addEventListener('load', function(){ setTimeout(reveal, 2500); });
  setTimeout(reveal, 5000);
})();
</script>
"""

def localize(html):
    # JSON-escaped first (so we don't leave dangling backslashes)
    html = html.replace('https:\\/\\/logosbz.com', '')
    html = html.replace('https://logosbz.com', '')
    html = html.replace('http://logosbz.com', '')
    return html

def restore_meta(html):
    # Re-absolutize metadata URLs (visual-neutral, valid metadata).
    def fix_attr(pattern):
        return re.sub(pattern, lambda m: m.group(0).replace(m.group(1), 'https://logosbz.com' + m.group(1)), html)
    out = html
    # canonical
    out = re.sub(r'(<link[^>]*rel="canonical"[^>]*href=")(/[^"]*)(")',
                 lambda m: m.group(1) + 'https://logosbz.com' + m.group(2) + m.group(3), out)
    # og:url, og:image, og:image:secure_url, twitter:image, og:image variants
    out = re.sub(r'(<meta[^>]*(?:property|name)="(?:og:url|og:image|og:image:secure_url|twitter:image)"[^>]*content=")(/[^"]*)(")',
                 lambda m: m.group(1) + 'https://logosbz.com' + m.group(2) + m.group(3), out)
    return out

def inject_fallback(html):
    if '</body>' in html:
        return html.replace('</body>', FALLBACK + '\n</body>')
    return html + FALLBACK

count = 0
for slug, url in pages:
    src = os.path.join(ROOT, 'capture', slug, 'page.html')
    if not os.path.exists(src):
        print('MISSING capture for', slug); continue
    html = open(src, encoding='utf-8').read()
    html = localize(html)
    html = restore_meta(html)
    html = inject_fallback(html)
    # output path from url
    path = url.replace('https://logosbz.com/', '')
    if path == '' or path == '/':
        out = os.path.join(SITE, 'index.html')
    else:
        out = os.path.join(SITE, path.rstrip('/'), 'index.html')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, 'w', encoding='utf-8').write(html)
    count += 1
    print(f'built {slug:35s} -> {os.path.relpath(out, SITE)}')

print(f'\n[build] {count} pages written')
