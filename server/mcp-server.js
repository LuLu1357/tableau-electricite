#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Le Tableau — serveur MCP pour Codex (ChatGPT Plus, pas d'API séparée)
//
// Ce process fait deux choses en même temps :
//  1. Il parle le protocole MCP sur stdio -> c'est ce que Codex CLI utilise
//     comme "outil" (codex mcp add ...).
//  2. Il fait tourner un petit serveur web local (http://127.0.0.1:PORT)
//     qui affiche le tableau dans ton navigateur et se synchronise en
//     direct avec les actions de Codex via une websocket.
//
// Important : tout tourne en local sur ta machine. Aucune clé API,
// aucune facturation à part ton abonnement ChatGPT Plus qui fait déjà
// tourner Codex. Un seul process Node, pas de polling, pas de boucle de
// rendu au repos (voir server/store.js et server/snapshot.js).
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const { CanvasStore } = require('./store.js');
const { startHttpServer } = require('./http.js');
const { renderSnapshotPNG, renderSnapshotSVG } = require('./snapshot.js');
const { insertPdfPage, PDF_TOOL_MISSING } = require('./pdf.js');
const TableauRender = require(path.join(__dirname, '..', 'web', 'render.js'));

const PORT = process.env.TABLEAU_PORT ? Number(process.env.TABLEAU_PORT) : 5858;

const COMPONENT_KINDS = Object.keys(TableauRender.COMPONENTS);
const THEMES = Object.keys(TableauRender.THEME_COLORS);

function log(...args) {
  // IMPORTANT : ne jamais écrire sur stdout ici, c'est réservé aux messages
  // MCP JSON-RPC. On log uniquement sur stderr.
  console.error('[tableau]', ...args);
}

async function main() {
  const store = new CanvasStore();
  const { broadcast } = await startHttpServer(store, PORT);
  log(`Tableau ouvert sur http://127.0.0.1:${PORT} — ouvre cette page dans ton navigateur.`);

  // Sauvegarde finale garantie à l'extinction (rien perdu de la dernière
  // fraction de seconde de dessin, même si le debounce n'a pas encore tiqué).
  for (const sig of ['SIGINT', 'SIGTERM', 'beforeExit']) {
    process.on(sig, () => { try { store.flush(); } catch (e) { /* noop */ } });
  }

  const server = new McpServer({
    name: 'tableau-electricite',
    version: '2.0.0',
    title: 'Tableau — cours d\'électricité',
  });

  const colorSchema = z.string().optional().describe('Couleur CSS (ex: "#2563eb", "red"). Optionnel : par défaut, couleur adaptée au thème actif.');
  const positionSchema = z.object({ x: z.number(), y: z.number() }).describe('Position en pixels sur le tableau (repère 1600x1000).');

  function defaultColor(role) {
    const theme = TableauRender.themeOf(store.getTheme());
    return theme[role] || theme.ink;
  }

  // ============================================================
  // Outils de lecture
  // ============================================================

  server.registerTool(
    'voir_tableau',
    {
      title: 'Voir le tableau',
      description:
        "Renvoie l'état actuel complet du tableau : la liste structurée de tous les éléments " +
        '(dessins à main levée, composants électriques, équations, formes, textes, annotations) ainsi ' +
        "qu'un aperçu visuel (image PNG) fidèle à ce qui est réellement affiché, équations KaTeX comprises. " +
        "Coûteux (génère une image) : préfère lire_tableau_compact() ou lire_modifications_depuis(revision) " +
        "pour un suivi léger, et n'utilise voir_tableau() que quand tu as vraiment besoin de VOIR le dessin " +
        "(ex: interpréter un croquis ambigu, vérifier un schéma de circuit).",
      inputSchema: {},
    },
    async () => {
      const elements = store.getAll();
      const png = await renderSnapshotPNG(elements, { width: 1600, height: 1000, theme: store.getTheme() });
      return {
        content: [
          {
            type: 'text',
            text:
              `Tableau actuel (révision ${store.revision}, ${elements.length} élément(s)) :\n` +
              JSON.stringify(elements, null, 2),
          },
          {
            type: 'image',
            data: png.toString('base64'),
            mimeType: 'image/png',
          },
        ],
      };
    }
  );

  server.registerTool(
    'lister_elements',
    {
      title: 'Lister les éléments',
      description:
        "Renvoie uniquement la liste JSON (sans image) des éléments du tableau avec leur id, type et " +
        'position — pratique pour retrouver l\'id exact d\'un élément à modifier ou supprimer.',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify(store.getAll(), null, 2) }],
    })
  );

  server.registerTool(
    'lire_tableau_compact',
    {
      title: 'Lire le tableau (vue compacte)',
      description:
        "Vue légère et rapide de l'état du tableau : révision courante, hash d'intégrité, thème actif, " +
        'et la liste structurée minimale des éléments (id, source, revision, type, zone englobante, données ' +
        "utiles) — SANS image. À utiliser en priorité au début d'un échange ou pour vérifier l'état général : " +
        "beaucoup plus rapide et léger que voir_tableau(). Compare le hash/la révision reçus la dernière fois " +
        "pour savoir si le tableau a changé sans même relire quoi que ce soit.",
      inputSchema: {},
    },
    async () => {
      const compact = store.compactList(TableauRender.boundsOf);
      return { content: [{ type: 'text', text: JSON.stringify(compact, null, 2) }] };
    }
  );

  server.registerTool(
    'lire_modifications_depuis',
    {
      title: 'Lire les modifications depuis une révision',
      description:
        "Renvoie uniquement ce qui a changé depuis une révision donnée : éléments ajoutés/modifiés " +
        '(nouveaux traits, annotations, déplacements) et ids supprimés. Idéal en cours de session vocale : ' +
        "après ta première lecture (lire_tableau_compact), rappelle cet outil avec la révision reçue pour " +
        "ne relire QUE le delta au lieu de tout le tableau. Si gap=true, l'historique ne remonte plus assez " +
        'loin (trop de temps/changements écoulés) : dans ce cas, rappelle lire_tableau_compact() à la place.',
      inputSchema: {
        revision: z.number().int().min(0).describe('Dernière révision connue par toi (reçue via lire_tableau_compact, appliquer_lot, etc.)'),
      },
    },
    async ({ revision }) => {
      const deltas = store.deltasSince(revision, TableauRender.boundsOf);
      return { content: [{ type: 'text', text: JSON.stringify(deltas, null, 2) }] };
    }
  );

  // ============================================================
  // Outils d'écriture — dessin de base
  // ============================================================

  server.registerTool(
    'ecrire_equation',
    {
      title: 'Écrire une équation (LaTeX)',
      description:
        "Ajoute une équation sur le tableau, rendue proprement (LaTeX via KaTeX) à la position donnée. " +
        'Utilise la syntaxe LaTeX standard, ex: "U = R \\\\cdot I" ou "P = U \\\\cdot I = R \\\\cdot I^2".',
      inputSchema: {
        latex: z.string().describe('Formule en LaTeX, ex: "U = R \\\\cdot I"'),
        x: z.number().default(60).describe('Position horizontale en pixels'),
        y: z.number().default(60).describe('Position verticale en pixels'),
        color: colorSchema,
        fontSize: z.number().optional().describe('Taille de police, par défaut 22'),
      },
    },
    async ({ latex, x, y, color, fontSize }) => {
      const el = store.add({ type: 'equation', latex, x, y, color: color || defaultColor('codex'), fontSize, source: 'codex' });
      return { content: [{ type: 'text', text: `Équation ajoutée (id ${el.id}, révision ${store.revision}) : ${latex}` }] };
    }
  );

  server.registerTool(
    'ecrire_texte',
    {
      title: 'Écrire du texte',
      description: "Ajoute une annotation textuelle libre (explication, légende, remarque) sur le tableau.",
      inputSchema: {
        texte: z.string(),
        x: z.number().default(60),
        y: z.number().default(60),
        color: colorSchema,
        fontSize: z.number().optional(),
      },
    },
    async ({ texte, x, y, color, fontSize }) => {
      const el = store.add({ type: 'text', text: texte, x, y, color: color || defaultColor('ink'), fontSize, source: 'codex' });
      return { content: [{ type: 'text', text: `Texte ajouté (id ${el.id}, révision ${store.revision}).` }] };
    }
  );

  server.registerTool(
    'dessiner_composant',
    {
      title: 'Dessiner un composant électrique',
      description:
        'Place un symbole de composant électrique (norme IEC) sur le tableau, pour construire un schéma ' +
        `de circuit. Composants disponibles : ${COMPONENT_KINDS.join(', ')}.`,
      inputSchema: {
        type_composant: z.enum(COMPONENT_KINDS).describe('Type de composant électrique'),
        x: z.number().describe('Position horizontale du centre du symbole'),
        y: z.number().describe('Position verticale du centre du symbole'),
        rotation: z.number().optional().describe('Rotation en degrés (0, 90, 180, 270...)'),
        label: z.string().optional().describe('Étiquette sous le symbole, ex: "R1 = 220 Ω"'),
        color: colorSchema,
      },
    },
    async ({ type_composant, x, y, rotation, label, color }) => {
      const el = store.add({ type: 'component', kind: type_composant, x, y, rotation, label, color: color || defaultColor('ink'), source: 'codex' });
      return {
        content: [{ type: 'text', text: `Composant "${type_composant}" ajouté (id ${el.id}) en (${x}, ${y}).` }],
      };
    }
  );

  server.registerTool(
    'tracer_fil',
    {
      title: 'Tracer un fil électrique',
      description:
        'Trace un fil (ligne de connexion) entre plusieurs points, pour relier des composants sur un schéma. ' +
        'Donne une liste de points [x, y] formant le chemin du fil.',
      inputSchema: {
        points: z.array(z.tuple([z.number(), z.number()])).min(2).describe('Liste de points [x, y] du chemin'),
        color: colorSchema,
      },
    },
    async ({ points, color }) => {
      const el = store.add({ type: 'wire', points, color: color || defaultColor('accent'), source: 'codex' });
      return { content: [{ type: 'text', text: `Fil tracé (id ${el.id}).` }] };
    }
  );

  server.registerTool(
    'dessiner_forme',
    {
      title: 'Dessiner une forme géométrique',
      description: "Dessine une forme simple : ligne, flèche, rectangle ou ellipse, pour annoter ou schématiser.",
      inputSchema: {
        forme: z.enum(['line', 'arrow', 'rect', 'ellipse']),
        x1: z.number(),
        y1: z.number(),
        x2: z.number(),
        y2: z.number(),
        color: colorSchema,
      },
    },
    async ({ forme, x1, y1, x2, y2, color }) => {
      const el = store.add({ type: 'shape', shape: forme, x1, y1, x2, y2, color: color || defaultColor('ink'), source: 'codex' });
      return { content: [{ type: 'text', text: `Forme "${forme}" ajoutée (id ${el.id}).` }] };
    }
  );

  server.registerTool(
    'modifier_element',
    {
      title: 'Modifier un élément existant',
      description:
        "Modifie un élément déjà présent sur le tableau (déplacer, recolorer, changer le texte/latex/label...). " +
        'Utilise "lister_elements" ou "lire_tableau_compact" pour récupérer l\'id exact.',
      inputSchema: {
        id: z.string(),
        patch: z.record(z.string(), z.any()).describe('Champs à modifier, ex: {"x": 120, "color": "red"}'),
      },
    },
    async ({ id, patch }) => {
      const updated = store.update(id, patch);
      if (!updated) return { content: [{ type: 'text', text: `Aucun élément avec l'id ${id}.` }], isError: true };
      return { content: [{ type: 'text', text: `Élément ${id} mis à jour (révision ${store.revision}).` }] };
    }
  );

  server.registerTool(
    'supprimer_element',
    {
      title: 'Supprimer un élément',
      description: "Supprime un élément précis du tableau via son id (voir 'lister_elements').",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const ok = store.remove(id);
      return { content: [{ type: 'text', text: ok ? `Élément ${id} supprimé.` : `Aucun élément avec l'id ${id}.` }] };
    }
  );

  server.registerTool(
    'effacer_tableau',
    {
      title: 'Effacer le tableau',
      description:
        "Efface le tableau. Par défaut efface tout ; passe 'type_seulement' pour ne retirer qu'un type " +
        "d'éléments (ex: 'equation' pour juste effacer les équations et garder le schéma).",
      inputSchema: {
        type_seulement: z
          .enum(['freehand', 'wire', 'shape', 'text', 'equation', 'component', 'annotation', 'image'])
          .optional(),
      },
    },
    async ({ type_seulement }) => {
      store.clear(type_seulement || null);
      return {
        content: [
          { type: 'text', text: type_seulement ? `Éléments de type "${type_seulement}" effacés.` : 'Tableau effacé.' },
        ],
      };
    }
  );

  // ============================================================
  // appliquer_lot — plusieurs actions, une seule sauvegarde/diffusion
  // ============================================================

  const actionSchema = z.union([
    z.object({ op: z.literal('add'), element: z.record(z.string(), z.any()).describe('Élément à ajouter (mêmes champs que les outils ecrire_*/dessiner_*)') }),
    z.object({ op: z.literal('update'), id: z.string(), patch: z.record(z.string(), z.any()) }),
    z.object({ op: z.literal('remove'), id: z.string() }),
  ]);

  server.registerTool(
    'appliquer_lot',
    {
      title: 'Appliquer un lot de modifications',
      description:
        "Ajoute/modifie/supprime PLUSIEURS éléments en une seule fois : une seule sauvegarde disque et une " +
        "seule diffusion aux navigateurs connectés (au lieu d'un aller-retour par élément). À utiliser dès " +
        "que tu dois poser 2+ éléments d'un coup (ex: une correction avec flèche + indice + formule) : plus " +
        'rapide et plus fluide pour l\'élève qui regarde le tableau se mettre à jour. Chaque action a un ' +
        '"op" (add/update/remove). Les actions invalides (id inconnu) sont ignorées individuellement et ' +
        "reportées dans 'errors', sans annuler le reste du lot.",
      inputSchema: {
        actions: z.array(actionSchema).min(1),
      },
    },
    async ({ actions }) => {
      const prepared = actions.map((a) => (a.op === 'add' ? { ...a, element: { ...a.element, source: a.element.source || 'codex' } } : a));
      const result = store.applyBatch(prepared);
      return {
        content: [{
          type: 'text',
          text: `Lot appliqué (révision ${result.revision}) : ${result.events.length} action(s) réussie(s)` +
            (result.errors.length ? `, ${result.errors.length} échouée(s) : ${JSON.stringify(result.errors)}` : '.'),
        }],
      };
    }
  );

  // ============================================================
  // Annotations pédagogiques ("prof intelligent")
  // ============================================================

  server.registerTool(
    'pointer_erreur',
    {
      title: 'Pointer une erreur précise',
      description:
        "Place une flèche rouge et un court message exactement sur l'endroit où l'élève a fait une erreur " +
        '(ex: signe oublié, unité incorrecte). Ne donne pas la solution : dis quoi vérifier, pas la réponse. ' +
        'Ne recrée jamais tout le tableau pour ça : un seul élément ciblé.',
      inputSchema: {
        position: positionSchema.describe("Position exacte à pointer (proche de l'erreur, pas au hasard)"),
        texte: z.string().describe('Message court, ex: "Vérifie ce signe" (pas la solution complète)'),
      },
    },
    async ({ position, texte }) => {
      const el = store.add({ type: 'annotation', subtype: 'erreur', x: position.x, y: position.y, texte, color: defaultColor('erreurBg'), source: 'codex' });
      return { content: [{ type: 'text', text: `Erreur pointée (id ${el.id}) en (${position.x}, ${position.y}).` }] };
    }
  );

  server.registerTool(
    'ajouter_indice',
    {
      title: 'Ajouter un indice',
      description:
        "Ajoute une petite bulle d'indice à une position précise, pour orienter l'élève sans donner la " +
        'réponse complète (ex: "Pense à la loi d\'Ohm ici").',
      inputSchema: {
        position: positionSchema,
        texte: z.string().describe('Indice court'),
        couleur: colorSchema,
      },
    },
    async ({ position, texte, couleur }) => {
      const el = store.add({ type: 'annotation', subtype: 'indice', x: position.x, y: position.y, texte, color: couleur || defaultColor('indice'), source: 'codex' });
      return { content: [{ type: 'text', text: `Indice ajouté (id ${el.id}).` }] };
    }
  );

  server.registerTool(
    'encadrer_zone',
    {
      title: 'Encadrer une zone',
      description:
        "Dessine un encadré en pointillés autour d'une zone du tableau (ex: autour d'un sous-circuit ou " +
        "d'un groupe de traits) avec une légende courte optionnelle, pour attirer l'attention sans toucher " +
        'aux éléments à l\'intérieur.',
      inputSchema: {
        zone: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).describe('Rectangle englobant à encadrer'),
        couleur: colorSchema,
        texte: z.string().optional().describe('Légende courte affichée au-dessus du cadre'),
      },
    },
    async ({ zone, couleur, texte }) => {
      const el = store.add({ type: 'annotation', subtype: 'zone', zone, texte, color: couleur || defaultColor('zone'), source: 'codex' });
      return { content: [{ type: 'text', text: `Zone encadrée (id ${el.id}).` }] };
    }
  );

  server.registerTool(
    'afficher_formule_aide',
    {
      title: 'Afficher une formule à retenir',
      description:
        "Écrit une formule LaTeX (générale, sans les valeurs du circuit) à une position donnée — typiquement " +
        'à droite ou au-dessus du calcul de l\'élève, pour rappeler la loi utile avant qu\'il/elle applique. ' +
        "Ex: \"U_R = U \\\\cdot \\\\frac{R}{R_1+R_2}\" pour un diviseur de tension. Complète ensuite avec " +
        'afficher_application pour montrer le calcul avec les vraies valeurs.',
      inputSchema: {
        latex: z.string(),
        position: positionSchema,
        couleur: colorSchema,
        fontSize: z.number().optional(),
      },
    },
    async ({ latex, position, couleur, fontSize }) => {
      const el = store.add({ type: 'annotation', subtype: 'formule_aide', latex, x: position.x, y: position.y, color: couleur || defaultColor('formule'), fontSize, source: 'codex' });
      return { content: [{ type: 'text', text: `Formule d'aide affichée (id ${el.id}).` }] };
    }
  );

  server.registerTool(
    'afficher_application',
    {
      title: 'Afficher l\'application numérique',
      description:
        "Écrit l'application concrète d'une formule avec les valeurs réelles du circuit (ex: " +
        '"U_R = 12 \\\\cdot \\\\frac{220}{220+330}"), typiquement juste en dessous de afficher_formule_aide, ' +
        'pour montrer où et comment la formule générale se transforme en calcul concret.',
      inputSchema: {
        latex: z.string(),
        position: positionSchema,
        couleur: colorSchema,
        fontSize: z.number().optional(),
      },
    },
    async ({ latex, position, couleur, fontSize }) => {
      const el = store.add({ type: 'annotation', subtype: 'application', latex, x: position.x, y: position.y, color: couleur || defaultColor('application'), fontSize, source: 'codex' });
      return { content: [{ type: 'text', text: `Application numérique affichée (id ${el.id}).` }] };
    }
  );

  // ============================================================
  // remplacer_croquis — remplacement ciblé avec confirmation
  // ============================================================

  server.registerTool(
    'remplacer_croquis',
    {
      title: 'Remplacer un croquis par un schéma/équation propre',
      description:
        "Supprime UNIQUEMENT les traits manuels explicitement ciblés (ids_traits) et les remplace par des " +
        'éléments propres (schéma de composants, équation…). Ne touche à rien d\'autre sur le tableau. ' +
        "Si le croquis à remplacer est ambigu (plusieurs interprétations possibles), APPELLE CET OUTIL SANS " +
        "'confirmer' d'abord : tu recevras un aperçu (ids trouvés + éléments proposés) sans aucune " +
        "suppression réelle. Rappelle ensuite avec confirmer=true pour appliquer. Si un id de ids_traits " +
        "n'existe pas, l'outil renvoie une erreur (aucune suppression partielle).",
      inputSchema: {
        ids_traits: z.array(z.string()).min(1).describe('Ids exacts des traits/éléments manuels à supprimer'),
        nouveaux_elements: z.array(z.record(z.string(), z.any())).describe('Éléments de remplacement (ex: {"type":"equation","latex":"...","x":.., "y":..})'),
        confirmer: z.boolean().optional().describe('Mettre à true pour appliquer réellement (après avoir vu l\'aperçu)'),
      },
    },
    async ({ ids_traits, nouveaux_elements, confirmer }) => {
      const missing = ids_traits.filter((id) => !store.get(id));
      if (missing.length > 0) {
        return {
          content: [{ type: 'text', text: `Ids introuvables, aucune suppression effectuée : ${missing.join(', ')}` }],
          isError: true,
        };
      }
      if (!confirmer) {
        const aTraiter = ids_traits.map((id) => {
          const el = store.get(id);
          return { id, type: el.type, subtype: el.subtype, bbox: TableauRender.boundsOf(el) };
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              apercu: true,
              message: "Aperçu uniquement (rien n'a été supprimé). Rappelle remplacer_croquis avec confirmer=true pour appliquer.",
              elements_a_supprimer: aTraiter,
              elements_a_ajouter: nouveaux_elements,
            }, null, 2),
          }],
        };
      }
      const actions = [
        ...ids_traits.map((id) => ({ op: 'remove', id })),
        ...nouveaux_elements.map((el) => ({ op: 'add', element: { ...el, source: 'codex' } })),
      ];
      const result = store.applyBatch(actions);
      return {
        content: [{ type: 'text', text: `Croquis remplacé (révision ${result.revision}) : ${ids_traits.length} supprimé(s), ${nouveaux_elements.length} ajouté(s).` }],
      };
    }
  );

  // ============================================================
  // Export visuel (PNG déjà couvert par voir_tableau) — export SVG
  // ============================================================

  server.registerTool(
    'exporter_tableau_svg',
    {
      title: 'Exporter le tableau en SVG',
      description:
        "Génère un fichier SVG autonome (équations et images PDF insérées encodées dedans) du tableau actuel " +
        "et l'enregistre sur disque. Comme pour voir_tableau, ne génère cet export qu'à la demande explicite " +
        "de l'élève (ex: 'exporte le tableau'), jamais automatiquement.",
      inputSchema: {},
    },
    async () => {
      const elements = store.getAll();
      const svg = await renderSnapshotSVG(elements, { width: 1600, height: 1000, theme: store.getTheme() });
      const dir = path.join(__dirname, '..', 'data', 'exports');
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `tableau-${Date.now()}.svg`);
      fs.writeFileSync(filePath, svg, 'utf-8');
      const size = Buffer.byteLength(svg, 'utf-8');
      const content = [{ type: 'text', text: `Export SVG créé : ${filePath} (${size} octets)` }];
      if (size < 50_000) content.push({ type: 'text', text: svg });
      return { content };
    }
  );

  // ============================================================
  // Insertion de page PDF
  // ============================================================

  server.registerTool(
    'inserer_page_pdf',
    {
      title: 'Insérer une page de PDF sur le tableau',
      description:
        "Rasterise une page d'un PDF de cours (chemin local) et l'insère comme image sur le tableau, avec " +
        'une annotation optionnelle (ex: "Relis cette théorie"). Permet aussi d\'ouvrir le PDF à cette page ' +
        "précise dans un nouvel onglet depuis le tableau. Nécessite poppler (pdftoppm) installé localement " +
        "(brew install poppler) — 100% hors-ligne, pas de service cloud.",
      inputSchema: {
        chemin_pdf: z.string().describe('Chemin absolu local vers le fichier PDF'),
        page: z.number().int().min(1).describe('Numéro de page (1 = première page)'),
        position: positionSchema,
        largeur: z.number().optional().describe('Largeur affichée en pixels (défaut 420, hauteur proportionnelle)'),
        annotation: z.string().optional().describe('Texte affiché sous l\'image, ex: "Relis cette théorie"'),
      },
    },
    async ({ chemin_pdf, page, position, largeur, annotation }) => {
      const result = await insertPdfPage({ pdfPath: chemin_pdf, page, width: largeur });
      if (result.error === PDF_TOOL_MISSING) {
        return {
          content: [{ type: 'text', text: "poppler (pdftoppm) n'est pas installé sur cette machine. Installe-le avec : brew install poppler — puis réessaie." }],
          isError: true,
        };
      }
      if (result.error) {
        return { content: [{ type: 'text', text: `Insertion impossible : ${result.error}` }], isError: true };
      }
      const el = store.add({
        type: 'image', x: position.x, y: position.y, width: result.width, height: result.height,
        src: result.src, absPath: result.absPath, caption: annotation, pdfPath: chemin_pdf, pdfPage: page,
        source: 'codex',
      });
      return { content: [{ type: 'text', text: `Page ${page} du PDF insérée (id ${el.id}).` }] };
    }
  );

  // ============================================================
  // Thèmes
  // ============================================================

  server.registerTool(
    'changer_theme',
    {
      title: 'Changer le thème du tableau',
      description: `Change le thème persistant du tableau. Thèmes disponibles : ${THEMES.join(', ')}.`,
      inputSchema: { theme: z.enum(THEMES) },
    },
    async ({ theme }) => {
      store.setTheme(theme);
      return { content: [{ type: 'text', text: `Thème changé : ${theme}.` }] };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('Serveur MCP prêt (stdio) — connecté à Codex.');
}

main().catch((err) => {
  console.error('[tableau] erreur fatale:', err);
  process.exit(1);
});
