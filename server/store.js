// Petit "état central" du tableau : c'est la source de vérité.
// Le navigateur (dessin de l'utilisateur) et Codex (via les outils MCP)
// modifient tous les deux cet état, qui rediffuse ensuite les changements
// à tous les clients connectés (websocket) pour rester synchronisé en direct.
//
// Système de révisions : chaque mutation (add/update/remove/clear/applyBatch)
// incrémente UN compteur global "revision" (une seule fois, même pour un lot
// de plusieurs actions). Chaque élément mémorise la révision de sa dernière
// modification + sa source ('eleve' ou 'codex'). Cela permet à Codex de lire
// uniquement les changements récents via lire_modifications_depuis(revision)
// au lieu de relire tout le tableau à chaque fois.
//
// Performance : les mutations sont appliquées en mémoire de façon synchrone
// (la diffusion websocket est donc instantanée), mais l'écriture sur disque
// est "débouncée" (regroupée) : plusieurs mutations rapprochées ne déclenchent
// qu'une seule écriture fichier, quelques centaines de ms après la dernière.
// Aucun setInterval / polling : le minuteur de sauvegarde est un timer
// "one-shot" qui s'annule tout seul dès qu'il s'est déclenché — au repos,
// il n'existe tout simplement pas.

const { EventEmitter } = require('events');
const { randomUUID, createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

// Fichier de sauvegarde du tableau. Surchargeable via TABLEAU_DATA_FILE
// (utilisé par les tests automatisés pour ne JAMAIS toucher au vrai tableau
// de l'utilisateur, qui reste toujours data/tableau.json par défaut).
const SAVE_FILE = process.env.TABLEAU_DATA_FILE
  ? path.resolve(process.env.TABLEAU_DATA_FILE)
  : path.join(__dirname, '..', 'data', 'tableau.json');
const SAVE_DEBOUNCE_MS = 300;
const MAX_REMOVAL_LOG = 500;

class CanvasStore extends EventEmitter {
  constructor() {
    super();
    this.elements = new Map(); // id -> element
    this.order = []; // ordre d'affichage (z-index implicite)
    this.revision = 0;
    this.removalLog = []; // [{id, type, revision}] borné, pour les deltas
    this.historyFloor = 0; // revision avant laquelle on ne garantit plus les deltas de suppression
    this.meta = { theme: 'nuit' };
    this._saveTimer = null;
    this._dirty = false;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(SAVE_FILE)) {
        const data = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf-8'));
        for (const el of data.elements || []) {
          if (el.source == null) el.source = 'eleve';
          if (el.revision == null) el.revision = 0;
          this.elements.set(el.id, el);
          this.order.push(el.id);
        }
        this.revision = Number.isFinite(data.revision) ? data.revision : 0;
        this.removalLog = Array.isArray(data.removalLog) ? data.removalLog : [];
        this.historyFloor = Number.isFinite(data.historyFloor) ? data.historyFloor : 0;
        if (data.meta && typeof data.meta === 'object') {
          this.meta = Object.assign({ theme: 'nuit' }, data.meta);
        }
      }
    } catch (e) {
      console.error('[store] chargement impossible, on repart d\'un tableau vide:', e.message);
    }
  }

  // Écriture immédiate et synchrone (bypass du debounce). Appelée par le
  // timer de debounce, et explicitement après un lot (applyBatch) ou avant
  // extinction du process pour ne jamais perdre les dernières secondes.
  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (!this._dirty) return;
    try {
      fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
      const payload = {
        revision: this.revision,
        historyFloor: this.historyFloor,
        removalLog: this.removalLog,
        meta: this.meta,
        elements: this.getAll(),
      };
      fs.writeFileSync(SAVE_FILE, JSON.stringify(payload, null, 2));
      this._dirty = false;
    } catch (e) {
      console.error('[store] sauvegarde impossible:', e.message);
    }
  }

  _scheduleSave() {
    this._dirty = true;
    if (this._saveTimer) return; // déjà programmée, on regroupe
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  getAll() {
    return this.order.filter((id) => this.elements.has(id)).map((id) => this.elements.get(id));
  }

  get(id) {
    return this.elements.get(id) || null;
  }

  getTheme() {
    return this.meta.theme || 'nuit';
  }

  setTheme(theme) {
    this.meta.theme = theme;
    this._scheduleSave();
    this.emit('theme', { theme });
    return theme;
  }

  _bumpRevision() {
    this.revision += 1;
    return this.revision;
  }

  _logRemoval(id, type) {
    this.removalLog.push({ id, type, revision: this.revision });
    while (this.removalLog.length > MAX_REMOVAL_LOG) {
      const evicted = this.removalLog.shift();
      this.historyFloor = evicted.revision;
    }
  }

  add(partial) {
    const rev = this._bumpRevision();
    const id = partial.id || randomUUID();
    const element = { createdAt: Date.now(), ...partial, id, source: partial.source || 'eleve', revision: rev };
    this.elements.set(id, element);
    this.order.push(id);
    this._scheduleSave();
    this.emit('change', { type: 'add', element });
    return element;
  }

  update(id, patch) {
    const el = this.elements.get(id);
    if (!el) return null;
    const rev = this._bumpRevision();
    const updated = { ...el, ...patch, id, revision: rev };
    this.elements.set(id, updated);
    this._scheduleSave();
    this.emit('change', { type: 'update', id, patch, element: updated });
    return updated;
  }

  remove(id) {
    const el = this.elements.get(id);
    if (!el) return false;
    const rev = this._bumpRevision();
    this.elements.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this._logRemoval(id, el.type);
    this._scheduleSave();
    this.emit('change', { type: 'remove', id, revision: rev });
    return true;
  }

  clear(onlyType = null) {
    const rev = this._bumpRevision();
    if (!onlyType) {
      for (const [id, el] of this.elements) this._logRemoval(id, el.type);
      this.elements.clear();
      this.order = [];
    } else {
      const toRemove = this.getAll().filter((el) => el.type === onlyType).map((el) => el.id);
      for (const id of toRemove) {
        const el = this.elements.get(id);
        this._logRemoval(id, el.type);
        this.elements.delete(id);
      }
      this.order = this.order.filter((id) => this.elements.has(id));
    }
    this._scheduleSave();
    this.emit('change', { type: 'clear', onlyType, revision: rev });
  }

  // ---------------------------------------------------------------------
  // appliquer_lot : ajoute/modifie/supprime plusieurs éléments d'un coup,
  // avec UNE seule bascule de révision, UNE seule sauvegarde (immédiate,
  // pas debouncée — un lot volontaire mérite d'être persisté tout de suite)
  // et UNE seule diffusion websocket (un évènement 'batch' contenant la
  // liste des sous-évènements, que http.js retransmet tel quel).
  //
  // actions: [{op:'add', element}, {op:'update', id, patch}, {op:'remove', id}]
  // Retourne {revision, events, errors} — les actions invalides (id inconnu)
  // sont ignorées et reportées dans `errors`, sans annuler le reste du lot.
  // ---------------------------------------------------------------------
  applyBatch(actions) {
    const rev = this._bumpRevision();
    const events = [];
    const errors = [];
    for (const action of actions || []) {
      try {
        if (action.op === 'add') {
          const id = action.element.id || randomUUID();
          const element = { createdAt: Date.now(), ...action.element, id, source: action.element.source || 'eleve', revision: rev };
          this.elements.set(id, element);
          this.order.push(id);
          events.push({ type: 'add', element });
        } else if (action.op === 'update') {
          const el = this.elements.get(action.id);
          if (!el) { errors.push({ action, reason: `id inconnu: ${action.id}` }); continue; }
          const updated = { ...el, ...action.patch, id: action.id, revision: rev };
          this.elements.set(action.id, updated);
          events.push({ type: 'update', id: action.id, patch: action.patch, element: updated });
        } else if (action.op === 'remove') {
          const el = this.elements.get(action.id);
          if (!el) { errors.push({ action, reason: `id inconnu: ${action.id}` }); continue; }
          this.elements.delete(action.id);
          this.order = this.order.filter((x) => x !== action.id);
          this._logRemoval(action.id, el.type);
          events.push({ type: 'remove', id: action.id });
        } else {
          errors.push({ action, reason: `opération inconnue: ${action.op}` });
        }
      } catch (e) {
        errors.push({ action, reason: e.message });
      }
    }
    if (events.length > 0) {
      this._dirty = true;
      this.flush(); // sauvegarde immédiate pour un lot explicite
      this.emit('change', { type: 'batch', events, revision: rev });
    }
    return { revision: rev, events, errors };
  }

  // ---------------------------------------------------------------------
  // lire_tableau_compact : révision, hash d'intégrité, et liste minimale
  // (id, source, revision, type, bbox, données utiles) — sans image.
  // ---------------------------------------------------------------------
  compactList(boundsOf) {
    const elements = this.getAll().map((el) => ({
      id: el.id,
      source: el.source || 'eleve',
      revision: el.revision || 0,
      type: el.type,
      subtype: el.subtype,
      bbox: boundsOf ? boundsOf(el) : undefined,
      data: dataOf(el),
    }));
    const hashInput = JSON.stringify(elements.map((e) => [e.id, e.revision]));
    const hash = createHash('sha1').update(hashInput).digest('hex').slice(0, 16);
    return { revision: this.revision, hash, count: elements.length, theme: this.getTheme(), elements };
  }

  // ---------------------------------------------------------------------
  // lire_modifications_depuis(revision) : éléments changés/supprimés
  // depuis une révision donnée. gap=true signifie que l'historique des
  // suppressions ne remonte plus assez loin (log borné) : dans ce cas,
  // Codex doit se replier sur lire_tableau_compact() pour ne rien manquer.
  // ---------------------------------------------------------------------
  deltasSince(sinceRevision, boundsOf) {
    const gap = sinceRevision < this.historyFloor;
    const changed = this.getAll()
      .filter((el) => (el.revision || 0) > sinceRevision)
      .map((el) => ({
        id: el.id,
        source: el.source || 'eleve',
        revision: el.revision || 0,
        type: el.type,
        subtype: el.subtype,
        bbox: boundsOf ? boundsOf(el) : undefined,
        data: dataOf(el),
      }));
    const removed = this.removalLog
      .filter((r) => r.revision > sinceRevision)
      .map((r) => ({ id: r.id, type: r.type, revision: r.revision }));
    return { revision: this.revision, gap, changed, removed };
  }
}

// Champs "utiles" par type d'élément, pour la vue compacte (pas de champs
// techniques redondants comme createdAt).
function dataOf(el) {
  switch (el.type) {
    case 'text': return { x: el.x, y: el.y, text: el.text, color: el.color };
    case 'equation': return { x: el.x, y: el.y, latex: el.latex, color: el.color };
    case 'component': return { x: el.x, y: el.y, kind: el.kind, rotation: el.rotation, label: el.label, color: el.color };
    case 'shape': return { shape: el.shape, x1: el.x1, y1: el.y1, x2: el.x2, y2: el.y2, color: el.color };
    case 'wire': return { points: el.points, color: el.color };
    case 'freehand': return { pointCount: (el.points || []).length, color: el.color };
    case 'image': return { x: el.x, y: el.y, width: el.width, height: el.height, caption: el.caption, pdfPage: el.pdfPage };
    case 'annotation': return { x: el.x, y: el.y, zone: el.zone, texte: el.texte, latex: el.latex, color: el.color };
    default: return {};
  }
}

module.exports = { CanvasStore };
