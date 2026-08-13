// Génère un aperçu PNG (et un export SVG) du tableau, fidèle à ce qui est
// réellement affiché à l'écran — y compris les équations KaTeX.
//
// Stratégie :
//  1. On construit le SVG du tableau via TableauRender.renderBoardSVG
//     (mode "forSnapshot"). Les équations y apparaissent d'abord comme du
//     texte "humanisé" lisible (filet de sécurité), précédé d'un marqueur
//     <!--EQ:id-->.
//  2. Pour chaque équation, on tente de la rasteriser fidèlement avec un
//     vrai moteur KaTeX, via un navigateur headless (Playwright/Chromium)
//     lancé à la demande — jamais au repos. Chaque rendu est mis en cache
//     en mémoire (clé = latex+couleur+taille), donc une équation déjà vue
//     ne recoûte rien. Le navigateur se ferme automatiquement après 60s
//     d'inactivité : CPU ~nul dès qu'on arrête de demander des rendus.
//  3. Si Playwright/Chromium est indisponible (pas installé, erreur de
//     lancement…), on désactive silencieusement cette étape et on garde le
//     texte "humanisé" — jamais de plantage, un seul avertissement loggué.
//  4. Le SVG final (avec équations rasterisées si possible) est converti
//     en PNG via `sharp` (déjà utilisé, pas de dépendance supplémentaire).
//
// Important : voir_tableau()/exporter_tableau_svg() ne sont appelés qu'à la
// demande de Codex — ce module ne fait jamais de rendu "en tâche de fond".

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const TableauRender = require(path.join(__dirname, '..', 'web', 'render.js'));

const KATEX_DIR = path.join(__dirname, '..', 'web', 'vendor', 'katex');
const IDLE_CLOSE_MS = 60_000;
const CACHE_MAX = 400;

let browserPromise = null;
let pagePromise = null;
let idleTimer = null;
let browserUnavailable = false;
const rasterCache = new Map(); // key -> { png, width, height }

function cacheKey(latex, color, fontSize) {
  return `${fontSize}::${color}::${latex}`;
}

function cachePut(key, value) {
  rasterCache.set(key, value);
  if (rasterCache.size > CACHE_MAX) {
    const oldest = rasterCache.keys().next().value;
    rasterCache.delete(oldest);
  }
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    idleTimer = null;
    const bp = browserPromise;
    browserPromise = null;
    pagePromise = null;
    try {
      const browser = await bp;
      if (browser) await browser.close();
    } catch (e) { /* déjà fermé, tant pis */ }
  }, IDLE_CLOSE_MS);
  // Ne bloque jamais la fin normale du process s'il devait s'arrêter pendant
  // que ce minuteur patiente (SIGINT/SIGTERM géré ailleurs de toute façon).
  if (idleTimer.unref) idleTimer.unref();
}

async function getPage() {
  if (browserUnavailable) return null;
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = require('playwright');
      return chromium.launch({ headless: true, args: ['--no-sandbox'] });
    })().catch((e) => {
      browserUnavailable = true;
      console.error('[snapshot] Chromium/Playwright indisponible, repli sur le rendu texte:', e.message);
      return null;
    });
  }
  const browser = await browserPromise;
  if (!browser) return null;

  if (!pagePromise) {
    pagePromise = (async () => {
      const page = await browser.newPage({ viewport: { width: 900, height: 300 } });
      const css = fs.readFileSync(path.join(KATEX_DIR, 'katex.min.css'), 'utf-8');
      const js = fs.readFileSync(path.join(KATEX_DIR, 'katex.min.js'), 'utf-8');
      // On sert les polices KaTeX localement (file://) pour rester 100% hors-ligne.
      const fontsHref = 'file://' + KATEX_DIR.replace(/\\/g, '/') + '/';
      const html = `<!doctype html><html><head><meta charset="utf-8"/>
        <base href="${fontsHref}">
        <style>${css}
          html,body{margin:0;background:transparent;}
          #box{display:inline-block;padding:2px;}
        </style>
        <script>${js}</script>
        </head><body><div id="box"></div></body></html>`;
      await page.setContent(html, { waitUntil: 'load' });
      return page;
    })();
  }
  return pagePromise;
}

async function rasterizeLatex(latex, color, fontSize) {
  const key = cacheKey(latex, color, fontSize);
  if (rasterCache.has(key)) {
    scheduleIdleClose();
    return rasterCache.get(key);
  }
  const page = await getPage();
  if (!page) return null;
  try {
    const box = await page.evaluate(({ latex, color, fontSize }) => {
      const el = document.getElementById('box');
      el.style.color = color;
      el.style.fontSize = fontSize + 'px';
      try {
        // eslint-disable-next-line no-undef
        katex.render(latex, el, { throwOnError: false, displayMode: false });
      } catch (e) {
        el.textContent = latex;
      }
      const r = el.getBoundingClientRect();
      return { width: Math.max(1, Math.ceil(r.width)), height: Math.max(1, Math.ceil(r.height)) };
    }, { latex, color, fontSize });

    const clip = { x: 0, y: 0, width: Math.min(box.width + 4, 880), height: Math.min(box.height + 4, 280) };
    const png = await page.screenshot({ clip, omitBackground: true });
    const result = { png, width: clip.width, height: clip.height };
    cachePut(key, result);
    scheduleIdleClose();
    return result;
  } catch (e) {
    console.error('[snapshot] rasterisation KaTeX échouée pour une équation, repli texte:', e.message);
    return null;
  }
}

// Remplace, dans le SVG "forSnapshot", chaque marqueur <!--EQ:id--><text ...>
// par une image rasterisée fidèle, quand la rasterisation a réussi. Le texte
// "humanisé" reste en place si la rasterisation échoue pour cet élément.
async function embedRasterizedEquations(svg, elements) {
  let out = svg;
  for (const el of elements) {
    const latex = TableauRender.latexOf(el);
    if (!latex) continue;
    const color = el.color || (el.type === 'annotation' ? '#2dd4bf' : '#a78bfa');
    const fontSize = el.fontSize || 20;
    const result = await rasterizeLatex(latex, color, fontSize);
    if (!result) continue;
    const marker = `<!--EQ:${el.id}-->`;
    const idx = out.indexOf(marker);
    if (idx === -1) continue;
    // Le <text ...>...</text> qui suit immédiatement le marqueur.
    const afterMarker = idx + marker.length;
    const closeIdx = out.indexOf('</text>', afterMarker);
    if (closeIdx === -1) continue;
    const textTagEnd = closeIdx + '</text>'.length;
    const b64 = result.png.toString('base64');
    // Positionnement approximatif : x inchangé, y remonté pour aligner la
    // ligne de base du texte d'origine avec le bas visuel de l'image
    // (limite connue : léger décalage possible selon la police système).
    const yMatch = /y="([\-0-9.]+)"/.exec(out.slice(afterMarker, closeIdx));
    const xMatch = /x="([\-0-9.]+)"/.exec(out.slice(afterMarker, closeIdx));
    const baseY = yMatch ? parseFloat(yMatch[1]) : el.y;
    const baseX = xMatch ? parseFloat(xMatch[1]) : el.x;
    const imgY = baseY - result.height * 0.78;
    const imgTag = `<image x="${baseX}" y="${imgY}" width="${result.width}" height="${result.height}" href="data:image/png;base64,${b64}"/>`;
    out = out.slice(0, idx) + imgTag + out.slice(textTagEnd);
  }
  return out;
}

// Remplace <image ... data-pdf-abs="1" ... href="/pdf-cache/xxx.png" ...>
// par une version en data-URI (base64), car sharp ne peut pas résoudre une
// URL relative HTTP lors de la rasterisation PNG côté serveur.
function embedPdfImages(svg, elements) {
  let out = svg;
  for (const el of elements) {
    if (el.type !== 'image' || !el.absPath) continue;
    try {
      const buf = fs.readFileSync(el.absPath);
      const b64 = buf.toString('base64');
      const re = new RegExp(`href="${el.src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`);
      out = out.replace(re, `href="data:image/png;base64,${b64}"`);
    } catch (e) { /* fichier introuvable : on laisse le href relatif, tant pis pour ce PNG */ }
  }
  return out;
}

async function renderSnapshotPNG(elements, opts) {
  const svg = TableauRender.renderBoardSVG(elements, Object.assign({ forSnapshot: true }, opts));
  let finalSvg = await embedRasterizedEquations(svg, elements);
  finalSvg = embedPdfImages(finalSvg, elements);
  const buf = await sharp(Buffer.from(finalSvg)).png().toBuffer();
  return buf;
}

async function renderSnapshotSVG(elements, opts) {
  const svg = TableauRender.renderBoardSVG(elements, Object.assign({ forSnapshot: true }, opts));
  let finalSvg = await embedRasterizedEquations(svg, elements);
  finalSvg = embedPdfImages(finalSvg, elements);
  return finalSvg;
}

module.exports = { renderSnapshotPNG, renderSnapshotSVG };
