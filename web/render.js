/*
 * Moteur de rendu du tableau, partagé entre le navigateur et le serveur
 * (pour générer les aperçus PNG/SVG envoyés à Codex).
 * Convention symboles électriques : norme IEC / manuels français-belges.
 *
 * Ce fichier reste volontairement sans dépendance (pas de fs/require actif),
 * pour pouvoir être chargé aussi bien via <script> dans le navigateur que
 * via require() côté serveur (Node).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TableauRender = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escAttr(s) {
    return esc(s).replace(/"/g, '&quot;');
  }

  // ---------------------------------------------------------------------
  // Thèmes persistants : "nuit" (défaut), "papier" (ambré), "clair".
  // Chaque thème donne les couleurs de fond/grille/encre par défaut ET les
  // couleurs par défaut des annotations pédagogiques (contraste garanti).
  // ---------------------------------------------------------------------
  const THEME_COLORS = {
    nuit: {
      bg: '#1b1f24', grid: '#2a2f37', ink: '#e5e7eb', panel: '#20252b', border: '#323942',
      muted: '#9aa4af', accent: '#60a5fa', codex: '#a78bfa',
      erreur: '#f87171', erreurBg: '#7f1d1d', indice: '#fbbf24', indiceInk: '#1c1917',
      zone: '#38bdf8', formule: '#2dd4bf', application: '#4ade80',
    },
    papier: {
      bg: '#f6ecd2', grid: '#e6d6a8', ink: '#3b2f1e', panel: '#fbf3dc', border: '#e2d2a4',
      muted: '#8a7550', accent: '#b45309', codex: '#7c2d92',
      erreur: '#b91c1c', erreurBg: '#b91c1c', indice: '#a16207', indiceInk: '#fffbea',
      zone: '#1d6fa5', formule: '#0f766e', application: '#166534',
    },
    clair: {
      bg: '#fbfbf9', grid: '#e6e6e0', ink: '#1f2933', panel: '#ffffff', border: '#e5e7eb',
      muted: '#6b7280', accent: '#2563eb', codex: '#7c3aed',
      erreur: '#dc2626', erreurBg: '#dc2626', indice: '#d97706', indiceInk: '#1c1917',
      zone: '#0284c7', formule: '#0d9488', application: '#16a34a',
    },
  };
  const DEFAULT_THEME = 'nuit';
  function themeOf(name) {
    return THEME_COLORS[name] || THEME_COLORS[DEFAULT_THEME];
  }

  // ---- Bibliothèque de symboles de composants électriques (norme IEC) ----
  // Chaque symbole est dessiné centré sur (0,0), largeur ~80, hauteur ~40.
  const COMPONENTS = {
    resistor: (c) => `
      <line x1="-40" y1="0" x2="-16" y2="0" stroke="${c}" stroke-width="2.5"/>
      <rect x="-16" y="-9" width="32" height="18" fill="none" stroke="${c}" stroke-width="2.5"/>
      <line x1="16" y1="0" x2="40" y2="0" stroke="${c}" stroke-width="2.5"/>`,
    battery: (c) => `
      <line x1="-40" y1="0" x2="-8" y2="0" stroke="${c}" stroke-width="2.5"/>
      <line x1="-8" y1="-14" x2="-8" y2="14" stroke="${c}" stroke-width="2.5"/>
      <line x1="2" y1="-7" x2="2" y2="7" stroke="${c}" stroke-width="5"/>
      <line x1="2" y1="0" x2="40" y2="0" stroke="${c}" stroke-width="2.5"/>
      <text x="-8" y="-20" font-size="12" text-anchor="middle" fill="${c}">+</text>`,
    capacitor: (c) => `
      <line x1="-40" y1="0" x2="-6" y2="0" stroke="${c}" stroke-width="2.5"/>
      <line x1="-6" y1="-16" x2="-6" y2="16" stroke="${c}" stroke-width="2.5"/>
      <line x1="6" y1="-16" x2="6" y2="16" stroke="${c}" stroke-width="2.5"/>
      <line x1="6" y1="0" x2="40" y2="0" stroke="${c}" stroke-width="2.5"/>`,
    switch: (c) => `
      <line x1="-40" y1="0" x2="-14" y2="0" stroke="${c}" stroke-width="2.5"/>
      <circle cx="-14" cy="0" r="2.5" fill="${c}"/>
      <line x1="-12" y1="-2" x2="14" y2="-16" stroke="${c}" stroke-width="2.5"/>
      <circle cx="14" cy="0" r="2.5" fill="${c}"/>
      <line x1="14" y1="0" x2="40" y2="0" stroke="${c}" stroke-width="2.5"/>`,
    ground: (c) => `
      <line x1="0" y1="-20" x2="0" y2="0" stroke="${c}" stroke-width="2.5"/>
      <line x1="-16" y1="0" x2="16" y2="0" stroke="${c}" stroke-width="2.5"/>
      <line x1="-10" y1="7" x2="10" y2="7" stroke="${c}" stroke-width="2.5"/>
      <line x1="-4" y1="14" x2="4" y2="14" stroke="${c}" stroke-width="2.5"/>`,
    led: (c) => `
      <line x1="-40" y1="0" x2="-10" y2="0" stroke="${c}" stroke-width="2.5"/>
      <polygon points="-10,-12 -10,12 14,0" fill="none" stroke="${c}" stroke-width="2.5"/>
      <line x1="14" y1="-12" x2="14" y2="12" stroke="${c}" stroke-width="2.5"/>
      <line x1="14" y1="0" x2="40" y2="0" stroke="${c}" stroke-width="2.5"/>
      <line x1="0" y1="-14" x2="8" y2="-24" stroke="${c}" stroke-width="1.8"/>
      <line x1="6" y1="-26" x2="8" y2="-24" stroke="${c}" stroke-width="1.8"/>
      <line x1="6" y1="-22" x2="8" y2="-24" stroke="${c}" stroke-width="1.8"/>
      <line x1="8" y1="-10" x2="16" y2="-20" stroke="${c}" stroke-width="1.8"/>
      <line x1="14" y1="-22" x2="16" y2="-20" stroke="${c}" stroke-width="1.8"/>
      <line x1="14" y1="-18" x2="16" y2="-20" stroke="${c}" stroke-width="1.8"/>`,
    inductor: (c) => `
      <line x1="-40" y1="0" x2="-24" y2="0" stroke="${c}" stroke-width="2.5"/>
      <path d="M -24 0 A 4 8 0 0 1 -16 0 A 4 8 0 0 1 -8 0 A 4 8 0 0 1 0 0 A 4 8 0 0 1 8 0 A 4 8 0 0 1 16 0 A 4 8 0 0 1 24 0"
            fill="none" stroke="${c}" stroke-width="2.5"/>
      <line x1="24" y1="0" x2="40" y2="0" stroke="${c}" stroke-width="2.5"/>`,
    ammeter: (c) => `
      <line x1="-40" y1="0" x2="-16" y2="0" stroke="${c}" stroke-width="2.5"/>
      <circle cx="0" cy="0" r="16" fill="none" stroke="${c}" stroke-width="2.5"/>
      <text x="0" y="5" font-size="15" text-anchor="middle" font-family="Georgia,serif" fill="${c}">A</text>
      <line x1="16" y1="0" x2="40" y2="0" stroke="${c}" stroke-width="2.5"/>`,
    voltmeter: (c) => `
      <line x1="-40" y1="0" x2="-16" y2="0" stroke="${c}" stroke-width="2.5"/>
      <circle cx="0" cy="0" r="16" fill="none" stroke="${c}" stroke-width="2.5"/>
      <text x="0" y="5" font-size="15" text-anchor="middle" font-family="Georgia,serif" fill="${c}">V</text>
      <line x1="16" y1="0" x2="40" y2="0" stroke="${c}" stroke-width="2.5"/>`,
    lamp: (c) => `
      <line x1="-40" y1="0" x2="-16" y2="0" stroke="${c}" stroke-width="2.5"/>
      <circle cx="0" cy="0" r="16" fill="none" stroke="${c}" stroke-width="2.5"/>
      <line x1="-11.3" y1="-11.3" x2="11.3" y2="11.3" stroke="${c}" stroke-width="2"/>
      <line x1="-11.3" y1="11.3" x2="11.3" y2="-11.3" stroke="${c}" stroke-width="2"/>
      <line x1="16" y1="0" x2="40" y2="0" stroke="${c}" stroke-width="2.5"/>`,
    diode: (c) => `
      <line x1="-40" y1="0" x2="-10" y2="0" stroke="${c}" stroke-width="2.5"/>
      <polygon points="-10,-12 -10,12 14,0" fill="${c}" stroke="${c}" stroke-width="2.5"/>
      <line x1="14" y1="-12" x2="14" y2="12" stroke="${c}" stroke-width="2.5"/>
      <line x1="14" y1="0" x2="40" y2="0" stroke="${c}" stroke-width="2.5"/>`,
  };

  const COMPONENT_LABELS = {
    resistor: 'Résistor', battery: 'Pile / générateur', capacitor: 'Condensateur',
    switch: 'Interrupteur', ground: 'Masse', led: 'LED', inductor: 'Bobine',
    ammeter: 'Ampèremètre', voltmeter: 'Voltmètre', lamp: 'Lampe', diode: 'Diode',
  };

  function componentSVG(kind, color) {
    const fn = COMPONENTS[kind] || COMPONENTS.resistor;
    return fn(color || '#1f2933');
  }

  // Convertit quelques commandes LaTeX courantes en texte lisible : c'est le
  // filet de sécurité utilisé pour l'aperçu PNG quand la rasterisation KaTeX
  // (via navigateur headless, voir server/snapshot.js) n'est pas disponible.
  // Le rendu "officiel" affiché à l'écran, lui, utilise toujours vraiment KaTeX.
  const SUP_MAP = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', n: 'ⁿ', i: 'ⁱ' };
  const SUB_MAP = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋' };
  function mapChars(str, map) {
    return String(str).split('').map((c) => map[c] || c).join('');
  }
  function humanizeLatex(src) {
    let s = String(src || '');
    s = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)');
    s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)');
    s = s.replace(/\^\{([^{}]+)\}/g, (m, g) => mapChars(g, SUP_MAP));
    s = s.replace(/_\{([^{}]+)\}/g, (m, g) => mapChars(g, SUB_MAP));
    s = s.replace(/\^(\S)/g, (m, g) => mapChars(g, SUP_MAP));
    s = s.replace(/_(\S)/g, (m, g) => mapChars(g, SUB_MAP));
    const GREEK = {
      alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', Delta: 'Δ', epsilon: 'ε', theta: 'θ',
      lambda: 'λ', mu: 'μ', pi: 'π', rho: 'ρ', sigma: 'σ', Sigma: 'Σ', phi: 'φ', omega: 'ω', Omega: 'Ω', tau: 'τ',
    };
    s = s.replace(/\\([a-zA-Z]+)/g, (m, name) => {
      if (GREEK[name]) return GREEK[name];
      if (name === 'cdot') return '·';
      if (name === 'times') return '×';
      if (name === 'pm') return '±';
      if (name === 'approx') return '≈';
      if (name === 'neq') return '≠';
      if (name === 'leq') return '≤';
      if (name === 'geq') return '≥';
      if (name === 'infty') return '∞';
      if (name === 'left' || name === 'right') return '';
      if (name === 'quad' || name === 'qquad') return '  ';
      return name; // dernier recours : on retire juste le backslash
    });
    s = s.replace(/[{}]/g, '').replace(/\\,|\\;|\\!/g, ' ');
    return s;
  }

  function pointsToPath(points) {
    if (!points || points.length === 0) return '';
    const [first, ...rest] = points;
    let d = `M ${first[0]} ${first[1]}`;
    for (const p of rest) d += ` L ${p[0]} ${p[1]}`;
    return d;
  }

  // ---------------------------------------------------------------------
  // Boîte englobante ("bbox") — utilisée pour la sélection/déplacement
  // dans le navigateur, pour lire_tableau_compact() (zone englobante par
  // élément) et pour placer les annotations. Source unique : ni le client
  // ni le serveur ne recalculent leur propre version divergente.
  // ---------------------------------------------------------------------
  function boundsOf(el) {
    switch (el.type) {
      case 'text':
        return { x: el.x - 4, y: el.y - (el.fontSize || 18), w: (String(el.text || '').length * (el.fontSize || 18) * 0.6) + 8, h: (el.fontSize || 18) * 1.4 };
      case 'equation':
        return { x: el.x - 4, y: el.y - 24, w: (el.width || 320), h: (el.height || 60) };
      case 'component':
        return { x: el.x - 44, y: el.y - 34, w: 88, h: 68 };
      case 'shape':
        return { x: Math.min(el.x1, el.x2) - 4, y: Math.min(el.y1, el.y2) - 4, w: Math.abs(el.x2 - el.x1) + 8, h: Math.abs(el.y2 - el.y1) + 8 };
      case 'wire':
      case 'freehand': {
        const xs = el.points.map((p) => p[0]), ys = el.points.map((p) => p[1]);
        return { x: Math.min(...xs) - 6, y: Math.min(...ys) - 6, w: Math.max(...xs) - Math.min(...xs) + 12, h: Math.max(...ys) - Math.min(...ys) + 12 };
      }
      case 'image':
        return { x: el.x - 2, y: el.y - 2, w: (el.width || 420) + 4, h: (el.height || 300) + (el.caption ? 24 : 4) };
      case 'annotation': {
        const sub = el.subtype;
        if (sub === 'zone') {
          const z = el.zone || { x: 0, y: 0, w: 100, h: 60 };
          return { x: z.x - 10, y: z.y - 24, w: z.w + 20, h: z.h + 30 };
        }
        if (sub === 'erreur') {
          return { x: el.x - 4, y: el.y - 60, w: Math.max(60, (String(el.texte || '').length * 7) + 60), h: 66 };
        }
        if (sub === 'indice') {
          return { x: el.x - 4, y: el.y - 26, w: Math.max(30, (String(el.texte || '').length * 7) + 30), h: 32 };
        }
        // formule_aide / application
        return { x: el.x - 8, y: el.y - 40, w: (el.width || 300) + 12, h: (el.height || 58) + 12 };
      }
      default:
        return { x: 0, y: 0, w: 0, h: 0 };
    }
  }

  // Rend un élément en fragment SVG (string). N'inclut pas KaTeX en direct
  // (géré séparément côté navigateur) ; côté serveur, voir server/snapshot.js
  // qui rasterise les équations pour un rendu fidèle.
  function renderElement(el, opts) {
    opts = opts || {};
    const forSnapshot = !!opts.forSnapshot;
    const theme = themeOf(opts.theme);
    switch (el.type) {
      case 'freehand': {
        return `<path d="${pointsToPath(el.points)}" fill="none" stroke="${esc(el.color || theme.ink)}" stroke-width="${el.strokeWidth || 3}" stroke-linecap="round" stroke-linejoin="round" data-id="${el.id}"/>`;
      }
      case 'wire': {
        return `<path d="${pointsToPath(el.points)}" fill="none" stroke="${esc(el.color || theme.accent)}" stroke-width="${el.strokeWidth || 2.5}" stroke-linecap="round" stroke-linejoin="round" data-id="${el.id}"/>`;
      }
      case 'shape': {
        const c = esc(el.color || theme.ink);
        if (el.shape === 'rect') {
          const x = Math.min(el.x1, el.x2), y = Math.min(el.y1, el.y2);
          const w = Math.abs(el.x2 - el.x1), h = Math.abs(el.y2 - el.y1);
          return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${c}" stroke-width="2.5" data-id="${el.id}"/>`;
        }
        if (el.shape === 'ellipse') {
          const cx = (el.x1 + el.x2) / 2, cy = (el.y1 + el.y2) / 2;
          const rx = Math.abs(el.x2 - el.x1) / 2, ry = Math.abs(el.y2 - el.y1) / 2;
          return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="${c}" stroke-width="2.5" data-id="${el.id}"/>`;
        }
        if (el.shape === 'arrow') {
          const angle = Math.atan2(el.y2 - el.y1, el.x2 - el.x1);
          const ah = 10;
          const p1x = el.x2 - ah * Math.cos(angle - Math.PI / 7);
          const p1y = el.y2 - ah * Math.sin(angle - Math.PI / 7);
          const p2x = el.x2 - ah * Math.cos(angle + Math.PI / 7);
          const p2y = el.y2 - ah * Math.sin(angle + Math.PI / 7);
          return `<g data-id="${el.id}"><line x1="${el.x1}" y1="${el.y1}" x2="${el.x2}" y2="${el.y2}" stroke="${c}" stroke-width="2.5"/><polygon points="${el.x2},${el.y2} ${p1x},${p1y} ${p2x},${p2y}" fill="${c}"/></g>`;
        }
        return `<line x1="${el.x1}" y1="${el.y1}" x2="${el.x2}" y2="${el.y2}" stroke="${c}" stroke-width="2.5" data-id="${el.id}"/>`;
      }
      case 'text': {
        return `<text x="${el.x}" y="${el.y}" font-size="${el.fontSize || 18}" font-family="'Segoe UI',Helvetica,Arial,sans-serif" fill="${esc(el.color || theme.ink)}" data-id="${el.id}">${esc(el.text)}</text>`;
      }
      case 'equation': {
        const c = esc(el.color || theme.codex);
        if (forSnapshot) {
          // Marqueur repéré par server/snapshot.js : s'il rasterise ce LaTeX
          // avec succès via KaTeX headless, ce <text> est remplacé par une
          // image fidèle. Sinon, ce texte "humanisé" reste affiché (filet
          // de sécurité, jamais de plantage).
          return `<!--EQ:${el.id}--><text x="${el.x}" y="${el.y}" font-size="${el.fontSize || 20}" font-family="'Cambria Math',Georgia,serif" font-style="italic" fill="${c}" data-id="${el.id}">${esc(humanizeLatex(el.latex))}</text>`;
        }
        return `<foreignObject x="${el.x}" y="${el.y - 20}" width="${el.width || 320}" height="${el.height || 60}" data-id="${el.id}" data-latex-host="1">
          <div xmlns="http://www.w3.org/1999/xhtml" class="eq-box" style="font-size:${el.fontSize || 20}px;color:${c}"></div>
        </foreignObject>`;
      }
      case 'component': {
        const rot = el.rotation || 0;
        const inner = componentSVG(el.kind, el.color || theme.ink);
        const label = el.label ? `<text x="0" y="30" font-size="12" text-anchor="middle" fill="${theme.muted}" font-family="sans-serif">${esc(el.label)}</text>` : '';
        return `<g transform="translate(${el.x},${el.y}) rotate(${rot})" data-id="${el.id}" data-kind="${el.kind}">${inner}${label}</g>`;
      }
      case 'image': {
        const w = el.width || 420, h = el.height || 300;
        const openLink = (!forSnapshot && el.pdfPath)
          ? `<a href="/api/pdf?path=${encodeURIComponent(el.pdfPath)}${el.pdfPage ? ('%23page=' + el.pdfPage) : ''}" target="_blank" rel="noopener"><text x="${el.x}" y="${el.y - 8}" font-size="11.5" fill="${theme.accent}" font-family="sans-serif" text-decoration="underline">Ouvrir le PDF${el.pdfPage ? (' (p.' + el.pdfPage + ')') : ''}</text></a>`
          : '';
        const caption = el.caption ? `<text x="${el.x}" y="${el.y + h + 16}" font-size="13" font-family="sans-serif" fill="${theme.muted}">${esc(el.caption)}</text>` : '';
        return `<g data-id="${el.id}">${openLink}<image x="${el.x}" y="${el.y}" width="${w}" height="${h}" href="${escAttr(el.src)}" preserveAspectRatio="xMidYMid meet"/>${caption}</g>`;
      }
      case 'annotation': {
        return renderAnnotation(el, theme, forSnapshot);
      }
      default:
        return '';
    }
  }

  // ---------------------------------------------------------------------
  // Annotations pédagogiques : erreur (flèche rouge + message court),
  // indice (bulle courte), zone (encadré + légende), formule_aide /
  // application (équation LaTeX teintée, placée à droite / en dessous).
  // ---------------------------------------------------------------------
  function renderAnnotation(el, theme, forSnapshot) {
    const sub = el.subtype;
    const texte = el.texte || '';

    if (sub === 'zone') {
      const z = el.zone || { x: 0, y: 0, w: 100, h: 60 };
      const c = esc(el.color || theme.zone);
      const label = texte
        ? `<rect x="${z.x - 2}" y="${z.y - 24}" width="${Math.max(20, texte.length * 6.5 + 14)}" height="20" rx="5" fill="${c}"/><text x="${z.x + 5}" y="${z.y - 9}" font-size="12" font-family="sans-serif" fill="#fff">${esc(texte)}</text>`
        : '';
      return `<g data-id="${el.id}"><rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" fill="none" stroke="${c}" stroke-width="2.5" stroke-dasharray="7,5" rx="6"/>${label}</g>`;
    }

    if (sub === 'erreur') {
      const c = esc(el.color || theme.erreurBg);
      const ax = el.x + 30, ay = el.y - 34;
      const bw = Math.max(24, texte.length * 6.6 + 18);
      return `<g data-id="${el.id}">
        <line x1="${ax}" y1="${ay + 2}" x2="${el.x + 6}" y2="${el.y - 6}" stroke="${c}" stroke-width="3"/>
        <polygon points="${el.x},${el.y} ${el.x + 15},${el.y - 3} ${el.x + 3},${el.y - 17}" fill="${c}"/>
        <rect x="${ax - 4}" y="${ay - 22}" width="${bw}" height="24" rx="7" fill="${c}"/>
        <text x="${ax + 6}" y="${ay - 6}" font-size="12.5" font-family="sans-serif" fill="#fff">${esc(texte)}</text>
      </g>`;
    }

    if (sub === 'indice') {
      const c = esc(el.color || theme.indice);
      const ic = esc(theme.indiceInk);
      const bw = Math.max(30, texte.length * 6.6 + 30);
      return `<g data-id="${el.id}">
        <rect x="${el.x - 4}" y="${el.y - 23}" width="${bw}" height="25" rx="8" fill="${c}" opacity="0.95"/>
        <text x="${el.x + 8}" y="${el.y - 6}" font-size="12.5" font-family="sans-serif" fill="${ic}">💡 ${esc(texte)}</text>
      </g>`;
    }

    // formule_aide / application : latex teinté, avec petite étiquette au-dessus.
    const isApplication = sub === 'application';
    const c = esc(el.color || (isApplication ? theme.application : theme.formule));
    const tag = isApplication ? 'APPLICATION' : 'FORMULE';
    const w = el.width || 300, h = el.height || 58;
    const tagText = `<text x="${el.x - 6}" y="${el.y - 34}" font-size="10" letter-spacing="1" font-family="sans-serif" fill="${c}">${tag}</text>`;
    if (forSnapshot) {
      return `<g data-id="${el.id}">${tagText}<!--EQ:${el.id}--><text x="${el.x}" y="${el.y}" font-size="${el.fontSize || 20}" font-family="'Cambria Math',Georgia,serif" font-style="italic" fill="${c}" data-id="${el.id}">${esc(humanizeLatex(el.latex || ''))}</text></g>`;
    }
    return `<g data-id="${el.id}">${tagText}<foreignObject x="${el.x}" y="${el.y - 20}" width="${w}" height="${h - 8}" data-latex-host="1"><div xmlns="http://www.w3.org/1999/xhtml" class="eq-box" style="font-size:${el.fontSize || 20}px;color:${c}"></div></foreignObject></g>`;
  }

  function renderBoardSVG(elements, opts) {
    opts = opts || {};
    const width = opts.width || 1600;
    const height = opts.height || 1000;
    const theme = themeOf(opts.theme);
    const bg = opts.background || theme.bg;
    const grid = opts.grid !== false;
    let gridDefs = '';
    let gridRect = '';
    if (grid) {
      gridDefs = `<pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
        <path d="M 24 0 L 0 0 0 24" fill="none" stroke="${theme.grid}" stroke-width="1"/>
      </pattern>`;
      gridRect = `<rect width="${width}" height="${height}" fill="url(#grid)"/>`;
    }
    const body = elements.map((el) => renderElement(el, opts)).join('\n');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>${gridDefs}</defs>
      <rect width="${width}" height="${height}" fill="${bg}"/>
      ${gridRect}
      ${body}
    </svg>`;
  }

  // Éléments qui portent du LaTeX (utile pour la rasterisation KaTeX côté
  // serveur et pour savoir quels champs afficher dans le rendu navigateur).
  function latexOf(el) {
    if (el.type === 'equation') return el.latex;
    if (el.type === 'annotation' && (el.subtype === 'formule_aide' || el.subtype === 'application')) return el.latex;
    return null;
  }

  return {
    renderElement, renderBoardSVG, componentSVG, COMPONENTS, COMPONENT_LABELS,
    pointsToPath, esc, escAttr, humanizeLatex, boundsOf, latexOf,
    THEME_COLORS, DEFAULT_THEME, themeOf,
  };
});
