/**
 * Production build for dwsoares.com
 *
 * Implements cache strategy per MDN / web.dev best practices:
 * - Content-hashed CSS/JS filenames (immutable long-term cache)
 * - version.json for client-side stale detection (works even with cached HTML)
 * - Service worker: network-first HTML, cache-first fingerprinted assets
 * - Query-string versioning on images
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = ROOT;
const OUT = path.join(ROOT, 'dist');

const HTML_PAGES = ['index.html', 'impressum.html', 'datenschutz.html'];
const STATIC_COPY = ['robots.txt', 'sitemap.xml'];

function getBuildId() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12);
  try {
    return execSync('git rev-parse --short=12 HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return Date.now().toString(36);
  }
}

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 10);
}

function extractBlocks(html, tag) {
  const regex = new RegExp(`<${tag}([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const blocks = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    blocks.push({ full: match[0], attrs: match[1], content: match[2], index: match.index });
  }
  return blocks;
}

function shouldExtractScript(attrs) {
  if (/type\s*=\s*["']application\/ld\+json["']/i.test(attrs)) return false;
  if (/src\s*=/.test(attrs)) return false;
  return true;
}

function bustLocalAssets(html, buildId) {
  const addV = (url) => {
    if (!url || url.startsWith('data:')) return url;
    const isOwn = (u) => /^https?:\/\/(www\.)?dwsoares\.com/i.test(u) || !/^https?:\/\//i.test(u);
    if (!isOwn(url)) return url;
    if (url.startsWith('/assets/')) return url;
    const sep = url.includes('?') ? '&' : '?';
    if (url.includes(`v=${buildId}`)) return url;
    return `${url}${sep}v=${buildId}`;
  };

  return html
    .replace(/(<img\b[^>]*\ssrc=["'])([^"']+)(["'])/gi, (m, pre, url, post) => `${pre}${addV(url)}${post}`)
    .replace(/(<link\b[^>]*\shref=["'])([^"']+)(["'])/gi, (m, pre, url, post) => {
      if (/fonts\.googleapis|fonts\.gstatic|\/assets\//.test(url)) return m;
      return `${pre}${addV(url)}${post}`;
    })
    .replace(/(<meta\b[^>]*(?:property=["']og:image["']|name=["']twitter:image["'])[^>]*content=["'])([^"']+)(["'])/gi,
      (m, pre, url, post) => `${pre}${addV(url)}${post}`);
}

const CACHE_META = `
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<meta name="build-id" content="{{BUILD_ID}}">`;

const VERSION_CHECK = `
<script>
(function(){
  var cur="{{BUILD_ID}}";
  fetch("/version.json?_="+Date.now(),{cache:"no-store",headers:{"Cache-Control":"no-cache"}})
    .then(function(r){return r.json()})
    .then(function(d){
      var k="dwsoares-build",s=localStorage.getItem(k);
      if(s&&s!==d.id){
        localStorage.setItem(k,d.id);
        var tasks=[];
        if("caches" in window) tasks.push(caches.keys().then(function(n){return Promise.all(n.map(function(c){return caches.delete(c)}))}));
        if("serviceWorker" in navigator) tasks.push(navigator.serviceWorker.getRegistrations().then(function(r){return Promise.all(r.map(function(x){return x.unregister()}))}));
        Promise.all(tasks).finally(function(){
          var u=new URL(location.href);
          u.searchParams.set("_",d.id);
          location.replace(u.toString());
        });
      } else {
        localStorage.setItem(k,d.id);
      }
    }).catch(function(){});
})();
</script>`;

const SW_REGISTER = `
<script>
if("serviceWorker" in navigator){
  window.addEventListener("load",function(){
    navigator.serviceWorker.register("/sw.js?v={{BUILD_ID}}",{updateViaCache:"none"})
      .then(function(reg){ reg.update(); })
      .catch(function(){});
  });
}
</script>`;

function processHtml(filename, buildId) {
  const pageKey = path.basename(filename, '.html') || 'index';
  let html = fs.readFileSync(path.join(SRC, filename), 'utf8');

  const styles = extractBlocks(html, 'style');
  if (styles.length) {
    const css = styles.map(s => s.content.trim()).join('\n\n');
    const cssHash = hashContent(css);
    const cssName = `${pageKey}.${cssHash}.css`;
    fs.mkdirSync(path.join(OUT, 'assets', 'css'), { recursive: true });
    fs.writeFileSync(path.join(OUT, 'assets', 'css', cssName), css);
    const linkTag = `<link rel="stylesheet" href="/assets/css/${cssName}">`;
    html = html.replace(/<style[^>]*>[\s\S]*?<\/style>\s*/gi, '');
    html = html.replace('</head>', `${linkTag}\n</head>`);
  }

  const scripts = extractBlocks(html, 'script').filter(s => shouldExtractScript(s.attrs));
  if (scripts.length) {
    const js = scripts.map(s => s.content.trim()).join('\n\n');
    const jsHash = hashContent(js);
    const jsName = `${pageKey}.${jsHash}.js`;
    fs.mkdirSync(path.join(OUT, 'assets', 'js'), { recursive: true });
    fs.writeFileSync(path.join(OUT, 'assets', 'js', jsName), js);
    const scriptTag = `<script src="/assets/js/${jsName}" defer></script>`;
    for (const s of scripts) {
      html = html.replace(s.full, '');
    }
    html = html.replace('</body>', `${scriptTag}\n</body>`);
  }

  if (!html.includes('http-equiv="Cache-Control"')) {
    html = html.replace(
      /(<meta charset="UTF-8">)/i,
      `$1${CACHE_META.replace(/\{\{BUILD_ID\}\}/g, buildId)}`
    );
  }

  if (!html.includes('dwsoares-build')) {
    html = html.replace('</head>', `${VERSION_CHECK.replace(/\{\{BUILD_ID\}\}/g, buildId)}\n</head>`);
  }

  if (!html.includes('serviceWorker.register')) {
    html = html.replace('</body>', `${SW_REGISTER.replace(/\{\{BUILD_ID\}\}/g, buildId)}\n</body>`);
  }

  html = bustLocalAssets(html, buildId);

  const outName = filename === 'index.html' ? 'index.html' : filename;
  fs.writeFileSync(path.join(OUT, outName), html);
  console.log(`  ✓ ${filename}`);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function generateServiceWorker(buildId) {
  const sw = `/* dwsoares.com service worker — build ${buildId} */
const BUILD_ID = '${buildId}';
const CACHE = 'dwsoares-' + BUILD_ID;

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('dwsoares-') && k !== CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === '/version.json') {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }

  if (url.pathname === '/sw.js') {
    event.respondWith(networkFirst(request));
    return;
  }

  const isHtml =
    request.mode === 'navigate' ||
    (request.headers.get('accept') || '').includes('text/html');

  if (isHtml) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (url.pathname.startsWith('/img/')) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  return cached || network;
}
`;
  fs.writeFileSync(path.join(OUT, 'sw.js'), sw);
}

function main() {
  const buildId = getBuildId();
  const builtAt = new Date().toISOString();

  if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  console.log(`Building dwsoares.com — ${buildId}`);

  for (const page of HTML_PAGES) {
    processHtml(page, buildId);
  }

  if (fs.existsSync(path.join(SRC, 'img'))) {
    copyDir(path.join(SRC, 'img'), path.join(OUT, 'img'));
    console.log('  ✓ img/');
  }

  for (const file of STATIC_COPY) {
    const src = path.join(SRC, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(OUT, file));
      console.log(`  ✓ ${file}`);
    }
  }

  fs.writeFileSync(
    path.join(OUT, 'version.json'),
    JSON.stringify({ id: buildId, built: builtAt }, null, 2)
  );
  console.log('  ✓ version.json');

  generateServiceWorker(buildId);
  console.log('  ✓ sw.js');

  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
  console.log('  ✓ .nojekyll');
  console.log(`Done → dist/ (${buildId})`);
}

main();
