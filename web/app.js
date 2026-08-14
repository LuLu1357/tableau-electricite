(function () {
  'use strict';

  const svg = document.getElementById('board');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const colorPicker = document.getElementById('colorPicker');
  const componentSelect = document.getElementById('componentSelect');
  const rotationSelect = document.getElementById('rotationSelect');

  const state = { elements: new Map(), order: [] };
  let currentTool = 'select';
  let selectedIds = new Set();
  let ws = null;
  let drawing = null; // état en cours de dessin (freehand/shape)
  let pendingWire = null; // liste de points en cours pour un fil multi-segments
  let dragState = null; // déplacement d'un ou plusieurs éléments sélectionnés
  let selectionRect = null; // cadre temporaire créé lors d'un cliquer-glisser dans le vide
  let activePointerId = null; // garde le glissé actif même si le pointeur quitte le SVG
  let currentTheme = TableauRender.DEFAULT_THEME;
  let insertionPosition = { x: 80, y: 100 };
  let audioContext = null;
  let microphoneStream = null;
  let microphoneSource = null;
  let audioProcessor = null;
  let dictating = false;

  const CANVAS_W = 2200, CANVAS_H = 1400;

  // ---------------------------------------------------------------------
  // Connexion websocket (synchro en direct avec le serveur + Codex)
  // ---------------------------------------------------------------------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => setStatus(true);
    ws.onclose = () => { setStatus(false); setTimeout(connect, 1500); };
    ws.onerror = () => setStatus(false);

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (handleDictationEvent(msg)) return;
      applyServerEvent(msg);
      render();
    };
  }

  function applyServerEvent(msg) {
    if (msg.type === 'state') {
      state.elements.clear();
      state.order = [];
      for (const el of msg.elements) {
        state.elements.set(el.id, el);
        state.order.push(el.id);
      }
      if (msg.theme) applyTheme(msg.theme, false);
    } else if (msg.type === 'add') {
      state.elements.set(msg.element.id, msg.element);
      state.order.push(msg.element.id);
    } else if (msg.type === 'update') {
      const el = state.elements.get(msg.id);
      if (el) state.elements.set(msg.id, Object.assign({}, el, msg.patch));
    } else if (msg.type === 'remove') {
      state.elements.delete(msg.id);
      state.order = state.order.filter((id) => id !== msg.id);
      selectedIds.delete(msg.id);
    } else if (msg.type === 'clear') {
      if (!msg.onlyType) {
        state.elements.clear();
        state.order = [];
        selectedIds.clear();
      } else {
        for (const id of [...state.order]) {
          const el = state.elements.get(id);
          if (el && el.type === msg.onlyType) {
            state.elements.delete(id);
            state.order = state.order.filter((x) => x !== id);
            selectedIds.delete(id);
          }
        }
      }
    } else if (msg.type === 'batch') {
      // Un lot (appliquer_lot / remplacer_croquis) : plusieurs sous-évènements
      // appliqués d'un coup, un seul re-rendu ensuite (fait par l'appelant).
      for (const sub of msg.events) applyServerEvent(sub);
    } else if (msg.type === 'theme') {
      applyTheme(msg.theme, false);
    }
  }

  function setStatus(ok) {
    statusDot.className = 'dot ' + (ok ? 'ok' : 'bad');
    statusText.textContent = ok ? 'Connecté' : 'Reconnexion…';
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  // ---------------------------------------------------------------------
  // Thèmes
  // ---------------------------------------------------------------------
  function applyTheme(theme, propagate) {
    if (!TableauRender.THEME_COLORS[theme]) return;
    currentTheme = theme;
    document.body.dataset.theme = theme;
    document.querySelectorAll('.theme-btn[data-theme]').forEach((b) => b.classList.toggle('active', b.dataset.theme === theme));
    if (propagate) send({ type: 'theme', theme });
    render();
  }

  document.querySelectorAll('.theme-btn[data-theme]').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme, true));
  });

  // ---------------------------------------------------------------------
  // Rendu
  // ---------------------------------------------------------------------
  function elementsInOrder() {
    return state.order.filter((id) => state.elements.has(id)).map((id) => state.elements.get(id));
  }

  function render() {
    const elements = elementsInOrder();
    const theme = TableauRender.themeOf(currentTheme);
    const gridDefs = `<pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M 24 0 L 0 0 0 24" fill="none" stroke="${theme.grid}" stroke-width="1"/></pattern>`;
    let body = '';
    for (const el of elements) {
      const frag = TableauRender.renderElement(el, { forSnapshot: false, theme: currentTheme });
      const sourceTag = el.source === 'codex' ? ' data-source="codex"' : ' data-source="eleve"';
      const b = TableauRender.boundsOf(el);
      const hit = `<rect x="${b.x}" y="${b.y}" width="${Math.max(b.w, 1)}" height="${Math.max(b.h, 1)}" fill="transparent" data-id="${el.id}" data-hit="1"/>`;
      body += hit + frag.replace(/^(<[a-zA-Z]+)/, `$1${sourceTag}`);
    }
    const selectionOverlay = selectionOverlaySVG(theme);
    svg.setAttribute('viewBox', `0 0 ${CANVAS_W} ${CANVAS_H}`);
    svg.innerHTML = `<defs>${gridDefs}</defs>
      <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="${theme.bg}"/>
      <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="url(#grid)"/>
      <g id="elements-layer">${body}</g>
      <g id="overlay-layer">${selectionOverlay}</g>`;

    // Rendu KaTeX dans les foreignObject (équations ET annotations formule_aide/application).
    // On exclut le rect de hit-test transparent (même data-id, pas de contenu KaTeX).
    for (const el of elements) {
      const latex = TableauRender.latexOf(el);
      if (latex == null) continue;
      const host = svg.querySelector(`[data-id="${cssEscape(el.id)}"]:not([data-hit="1"])`);
      const box = host ? host.querySelector('.eq-box') : null;
      if (box) {
        try {
          katex.render(latex, box, { throwOnError: false, displayMode: false });
        } catch (e) {
          box.textContent = latex;
        }
      }
    }
  }

  function cssEscape(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
  }

  function selectionOverlaySVG(theme) {
    let overlay = '';
    for (const id of selectedIds) {
      const el = state.elements.get(id);
      if (!el) continue;
      const b = TableauRender.boundsOf(el);
      const color = el.source === 'codex' ? theme.codex : theme.accent;
      overlay += `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="none" stroke="${color}" stroke-width="1.5" stroke-dasharray="5,4" rx="4" pointer-events="none"/>`;
    }
    if (selectionRect) {
      const r = normalizedRect(selectionRect.startX, selectionRect.startY, selectionRect.x, selectionRect.y);
      overlay += `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${theme.accent}" fill-opacity="0.10" stroke="${theme.accent}" stroke-width="1.5" stroke-dasharray="5,4" pointer-events="none"/>`;
    }
    if (insertionPosition) {
      const p = insertionPosition;
      overlay += `<g pointer-events="none" opacity="0.9"><line x1="${p.x - 9}" y1="${p.y}" x2="${p.x + 9}" y2="${p.y}" stroke="${theme.accent}" stroke-width="2"/><line x1="${p.x}" y1="${p.y - 9}" x2="${p.x}" y2="${p.y + 9}" stroke="${theme.accent}" stroke-width="2"/><circle cx="${p.x}" cy="${p.y}" r="13" fill="none" stroke="${theme.accent}" stroke-width="1" stroke-dasharray="3,3"/></g>`;
    }
    return overlay;
  }

  function normalizedRect(x1, y1, x2, y2) {
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }

  function elementsInsideRect(rect) {
    const right = rect.x + rect.w, bottom = rect.y + rect.h;
    return elementsInOrder()
      .filter((el) => {
        const b = TableauRender.boundsOf(el);
        const elementRight = b.x + b.w, elementBottom = b.y + b.h;
        // Une sélection par cadre retient aussi les éléments seulement
        // traversés/touchés par le cadre, pas uniquement ceux entièrement
        // contenus. Les comparaisons inclusives gardent les contacts de bord.
        return b.x <= right && elementRight >= rect.x && b.y <= bottom && elementBottom >= rect.y;
      })
      .map((el) => el.id);
  }

  // ---------------------------------------------------------------------
  // Outils / palette de composants
  // ---------------------------------------------------------------------
  const COMPONENT_KEYS = Object.keys(TableauRender.COMPONENT_LABELS);
  for (const key of COMPONENT_KEYS) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = TableauRender.COMPONENT_LABELS[key];
    componentSelect.appendChild(opt);
  }

  document.querySelectorAll('.tool[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });

  function setTool(tool) {
    currentTool = tool;
    document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    selectedIds.clear();
    selectionRect = null;
    pendingWire = null;
    render();
  }
  setTool('select');

  document.getElementById('clearBtn').addEventListener('click', () => {
    if (confirm('Effacer tout le tableau (dessins de toi ET de Codex) ?')) {
      send({ type: 'clear' });
    }
  });

  // ---------------------------------------------------------------------
  // Interaction sur le canevas
  // ---------------------------------------------------------------------
  function svgPoint(evt) {
    const rect = svg.getBoundingClientRect();
    const x = ((evt.clientX - rect.left) / rect.width) * CANVAS_W;
    const y = ((evt.clientY - rect.top) / rect.height) * CANVAS_H;
    return [Math.round(x), Math.round(y)];
  }

  svg.addEventListener('pointerdown', (evt) => {
    const [x, y] = svgPoint(evt);
    const targetId = evt.target.getAttribute && evt.target.getAttribute('data-id');

    if (activePointerId != null) return;
    activePointerId = evt.pointerId;
    svg.setPointerCapture(evt.pointerId);

    if (currentTool === 'select') {
      if (targetId) {
        if (!selectedIds.has(targetId)) selectedIds = new Set([targetId]);
        const originals = new Map();
        for (const id of selectedIds) {
          const el = state.elements.get(id);
          if (el) originals.set(id, JSON.parse(JSON.stringify(el)));
        }
        dragState = { ids: [...originals.keys()], startX: x, startY: y, originals };
      } else {
        selectedIds.clear();
        selectionRect = { startX: x, startY: y, x, y };
      }
      render();
      return;
    }

    if (currentTool === 'eraser') {
      if (targetId) send({ type: 'remove', id: targetId });
      return;
    }

    if (currentTool === 'pen') {
      drawing = { type: 'freehand', points: [[x, y]], color: colorPicker.value, strokeWidth: 3 };
      return;
    }

    if (currentTool.startsWith('shape-')) {
      drawing = { type: 'shape', shape: currentTool.replace('shape-', ''), x1: x, y1: y, x2: x, y2: y, color: colorPicker.value };
      return;
    }

    if (currentTool === 'wire') {
      if (!pendingWire) pendingWire = { points: [[x, y]] };
      else pendingWire.points.push([x, y]);
      previewWire();
      return;
    }

    if (currentTool === 'text') {
      openTextEditor(x, y);
      return;
    }

    if (currentTool === 'equation') {
      openEquationEditor(x, y);
      return;
    }

    if (currentTool === 'component') {
      const kind = componentSelect.value;
      const rotation = Number(rotationSelect.value || 0);
      send({ type: 'add', element: { type: 'component', kind, x, y, rotation, color: colorPicker.value, source: 'eleve' } });
      return;
    }
  });

  svg.addEventListener('pointermove', (evt) => {
    if (activePointerId != null && evt.pointerId !== activePointerId) return;
    if (drawing) {
      const [x, y] = svgPoint(evt);
      if (drawing.type === 'freehand') {
        const last = drawing.points[drawing.points.length - 1];
        if (Math.hypot(x - last[0], y - last[1]) > 2) drawing.points.push([x, y]);
      } else if (drawing.type === 'shape') {
        drawing.x2 = x; drawing.y2 = y;
      }
      previewDrawing();
      return;
    }
    if (dragState) {
      const [x, y] = svgPoint(evt);
      const dx = x - dragState.startX, dy = y - dragState.startY;
      applyTranslations(dragState.ids, dragState.originals, dx, dy);
      return;
    }
    if (selectionRect) {
      const [x, y] = svgPoint(evt);
      selectionRect.x = x;
      selectionRect.y = y;
      selectedIds = new Set(elementsInsideRect(normalizedRect(selectionRect.startX, selectionRect.startY, x, y)));
      render();
    }
  });

  // Note performance : pendant le dessin/déplacement, tout se passe en LOCAL
  // (aucun message envoyé au serveur). Un seul message 'add' ou 'update' est
  // envoyé à la fin du trait/déplacement (pointerup) — c'est ce qui permet
  // au store serveur de n'avoir qu'une seule sauvegarde à faire par trait.
  function finishPointer(evt, cancelled) {
    if (activePointerId == null || (evt && evt.pointerId !== activePointerId)) return;
    const pointerId = activePointerId;
    activePointerId = null;

    if (cancelled) {
      if (dragState) {
        for (const [id, original] of dragState.originals) state.elements.set(id, original);
      }
      dragState = null;
      selectionRect = null;
      drawing = null;
      render();
      if (svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId);
      return;
    }

    if (drawing) {
      if (drawing.type === 'freehand' && drawing.points.length > 1) {
        send({ type: 'add', element: Object.assign({ source: 'eleve' }, drawing) });
      } else if (drawing.type === 'shape' && (drawing.x1 !== drawing.x2 || drawing.y1 !== drawing.y2)) {
        send({ type: 'add', element: Object.assign({ source: 'eleve' }, drawing) });
      }
      drawing = null;
      render();
    }
    if (dragState) {
      for (const id of dragState.ids) {
        const el = state.elements.get(id);
        if (el) send({ type: 'update', id, patch: extractGeometry(el) });
      }
      dragState = null;
    }
    if (selectionRect) {
      const clickRect = normalizedRect(selectionRect.startX, selectionRect.startY, selectionRect.x, selectionRect.y);
      if (clickRect.w < 8 && clickRect.h < 8) insertionPosition = { x: selectionRect.startX, y: selectionRect.startY };
      selectionRect = null;
      render();
    }
    if (svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId);
  }

  svg.addEventListener('pointerup', (evt) => finishPointer(evt, false));
  svg.addEventListener('pointercancel', (evt) => finishPointer(evt, true));

  window.addEventListener('keydown', (evt) => {
    if (evt.key === 'Delete' || evt.key === 'Backspace') {
      if (selectedIds.size && document.activeElement.tagName !== 'INPUT') {
        for (const id of selectedIds) send({ type: 'remove', id });
        selectedIds.clear();
        evt.preventDefault();
      }
    }
    if (evt.key === 'Enter' && currentTool === 'wire' && pendingWire && pendingWire.points.length > 1) {
      send({ type: 'add', element: { type: 'wire', points: pendingWire.points, color: colorPicker.value, source: 'eleve' } });
      pendingWire = null;
      render();
    }
    if (evt.key === 'Escape') {
      pendingWire = null;
      closeTextEditor();
      closeEquationEditor();
      render();
    }
  });

  function extractGeometry(el) {
    switch (el.type) {
      case 'text': case 'equation': case 'component': case 'image':
        return { x: el.x, y: el.y };
      case 'shape':
        return { x1: el.x1, y1: el.y1, x2: el.x2, y2: el.y2 };
      case 'wire': case 'freehand':
        return { points: el.points };
      case 'annotation':
        return el.subtype === 'zone' ? { zone: el.zone } : { x: el.x, y: el.y };
      default:
        return {};
    }
  }

  function applyTranslations(ids, originals, dx, dy) {
    for (const id of ids) {
      const original = originals.get(id);
      if (original) applyTranslation(id, original, dx, dy);
    }
    render();
  }

  function applyTranslation(id, original, dx, dy) {
    const el = JSON.parse(JSON.stringify(original));
    switch (el.type) {
      case 'text': case 'equation': case 'component': case 'image':
        el.x = original.x + dx; el.y = original.y + dy; break;
      case 'shape':
        el.x1 = original.x1 + dx; el.y1 = original.y1 + dy;
        el.x2 = original.x2 + dx; el.y2 = original.y2 + dy; break;
      case 'wire': case 'freehand':
        el.points = original.points.map((p) => [p[0] + dx, p[1] + dy]); break;
      case 'annotation':
        if (el.subtype === 'zone' && el.zone) { el.zone = { ...el.zone, x: original.zone.x + dx, y: original.zone.y + dy }; }
        else { el.x = original.x + dx; el.y = original.y + dy; }
        break;
    }
    state.elements.set(id, el);
  }

  // Aperçu en direct pendant le tracé (avant envoi au serveur)
  function previewDrawing() {
    const layer = document.getElementById('elements-layer');
    let ghost = document.getElementById('ghost-el');
    if (!ghost) {
      const wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      wrapper.id = 'ghost-el';
      layer.appendChild(wrapper);
      ghost = wrapper;
    }
    ghost.innerHTML = TableauRender.renderElement(Object.assign({ id: 'ghost' }, drawing), { theme: currentTheme });
  }

  function previewWire() {
    const layer = document.getElementById('elements-layer');
    let ghost = document.getElementById('ghost-wire');
    if (!ghost) {
      const wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      wrapper.id = 'ghost-wire';
      layer.appendChild(wrapper);
      ghost = wrapper;
    }
    ghost.innerHTML = TableauRender.renderElement({ id: 'ghostwire', type: 'wire', points: pendingWire.points, color: colorPicker.value }, { theme: currentTheme });
  }

  // ---------------------------------------------------------------------
  // Éditeurs flottants (texte / équation)
  // ---------------------------------------------------------------------
  const equationEditor = document.getElementById('equationEditor');
  const equationInput = document.getElementById('equationInput');
  const equationPreview = document.getElementById('equationPreview');
  let equationPos = null;

  function openEquationEditor(x, y) {
    equationPos = [x, y];
    equationEditor.classList.remove('hidden');
    equationInput.value = '';
    equationPreview.innerHTML = '';
    equationInput.focus();
  }
  function closeEquationEditor() {
    equationEditor.classList.add('hidden');
    equationPos = null;
  }
  equationInput.addEventListener('input', () => {
    try {
      katex.render(equationInput.value || ' ', equationPreview, { throwOnError: false });
    } catch (e) { /* ignore pendant la frappe */ }
  });
  equationInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('equationConfirm').click();
    if (e.key === 'Escape') closeEquationEditor();
  });
  document.getElementById('equationCancel').addEventListener('click', closeEquationEditor);
  document.getElementById('equationConfirm').addEventListener('click', () => {
    if (equationInput.value.trim() && equationPos) {
      send({ type: 'add', element: { type: 'equation', latex: equationInput.value.trim(), x: equationPos[0], y: equationPos[1], color: colorPicker.value, source: 'eleve' } });
    }
    closeEquationEditor();
  });

  const textEditor = document.getElementById('textEditor');
  const textInput = document.getElementById('textInput');
  let textPos = null;
  function openTextEditor(x, y) {
    textPos = [x, y];
    textEditor.classList.remove('hidden');
    textInput.value = '';
    textInput.focus();
  }
  function closeTextEditor() {
    textEditor.classList.add('hidden');
    textPos = null;
  }
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('textConfirm').click();
    if (e.key === 'Escape') closeTextEditor();
  });
  document.getElementById('textCancel').addEventListener('click', closeTextEditor);
  document.getElementById('textConfirm').addEventListener('click', () => {
    if (textInput.value.trim() && textPos) {
      send({ type: 'add', element: { type: 'text', text: textInput.value.trim(), x: textPos[0], y: textPos[1], color: colorPicker.value, source: 'eleve' } });
    }
    closeTextEditor();
  });

  // ---------------------------------------------------------------------
  // Dictée locale : audio PCM 16 kHz transitoire, envoyé au serveur local.
  // Les aperçus ne sont jamais ajoutés au store ; seul le lot final l'est.
  // ---------------------------------------------------------------------
  const dictationBtn = document.getElementById('dictationBtn');
  const dictationEngine = document.getElementById('dictationEngine');
  const dictationHint = document.getElementById('dictationHint');
  const dictationOverlay = document.getElementById('dictationOverlay');
  const dictationLabel = document.getElementById('dictationLabel');
  const dictationPreview = document.getElementById('dictationPreview');
  const dictationPulse = document.getElementById('dictationPulse');
  const appleSpeechBridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.appleSpeech;
  const appleSpeechAvailable = !!appleSpeechBridge && window.tableauAppleSpeechAvailable !== false;
  const scientificVocabulary = [
    'Pythagore', 'Kirchhoff', 'Thévenin', 'Norton', 'Ohm', 'Faraday',
    'résistance', 'condensateur', 'capacité', 'impédance', 'tension', 'courant',
    'VC', 'VR', 'VS', 'VL', 'R1', 'R2', 'delta', 'oméga', 'phi', 'LaTeX'
  ];
  let dictationStatus = { whisper: false };

  const savedEngine = localStorage.getItem('tableau-dictation-engine');
  dictationEngine.value = savedEngine === 'apple-speech' && !appleSpeechAvailable
    ? 'whisper'
    : (savedEngine || (appleSpeechAvailable ? 'apple-speech' : 'whisper'));

  function pcmToBase64(samples) {
    const bytes = new Uint8Array(samples.buffer);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 8192));
    }
    return btoa(binary);
  }

  function downsampleTo16k(input, inputRate) {
    if (inputRate === 16000) {
      const direct = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) direct[i] = Math.max(-32768, Math.min(32767, input[i] * 32767));
      return direct;
    }
    const ratio = inputRate / 16000;
    const length = Math.floor(input.length / ratio);
    const result = new Int16Array(length);
    for (let i = 0; i < length; i++) {
      const start = Math.floor(i * ratio), end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      const value = sum / Math.max(1, end - start);
      result[i] = Math.max(-32768, Math.min(32767, value * 32767));
    }
    return result;
  }

  function showDictation(status, label, preview) {
    dictationOverlay.classList.remove('hidden');
    dictationLabel.textContent = label;
    dictationPulse.classList.toggle('active', status === 'listening');
    if (preview != null) dictationPreview.textContent = preview;
  }

  async function startDictation() {
    if (dictating || !ws || ws.readyState !== 1) return;
    try {
      microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      microphoneSource = audioContext.createMediaStreamSource(microphoneStream);
      audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
      audioProcessor.onaudioprocess = (event) => {
        if (!dictating) return;
        const pcm = downsampleTo16k(event.inputBuffer.getChannelData(0), audioContext.sampleRate);
        const encoded = pcmToBase64(pcm);
        if (dictationEngine.value === 'apple-speech') {
          appleSpeechBridge.postMessage({ action: 'audio', pcm: encoded });
        } else {
          send({ type: 'dictation-audio', pcm: encoded });
        }
      };
      microphoneSource.connect(audioProcessor);
      audioProcessor.connect(audioContext.destination);
      dictating = true;
      dictationBtn.classList.add('listening');
      dictationBtn.setAttribute('aria-pressed', 'true');
      dictationBtn.textContent = '⏹ Arrêter';
      dictationPreview.textContent = '';
      const engine = dictationEngine.value;
      showDictation('listening', engine === 'apple-speech' ? 'Apple Speech écoute…' : 'Whisper écoute…', 'Parle naturellement.');
      send({ type: 'dictation-start', engine, position: insertionPosition, selectedIds: [...selectedIds] });
      if (engine === 'apple-speech') appleSpeechBridge.postMessage({ action: 'start', contextualStrings: scientificVocabulary });
    } catch (error) {
      showDictation('error', 'Microphone indisponible', error.message);
    }
  }

  function releaseMicrophone() {
    if (audioProcessor) audioProcessor.disconnect();
    if (microphoneSource) microphoneSource.disconnect();
    if (microphoneStream) microphoneStream.getTracks().forEach((track) => track.stop());
    if (audioContext) audioContext.close();
    audioProcessor = microphoneSource = microphoneStream = audioContext = null;
  }

  function stopDictation() {
    if (!dictating) return;
    dictating = false;
    releaseMicrophone();
    dictationBtn.classList.remove('listening');
    dictationBtn.setAttribute('aria-pressed', 'false');
    dictationBtn.textContent = '🎙️ Dicter';
    showDictation('transcribing', 'Transcription…');
    if (dictationEngine.value === 'apple-speech') appleSpeechBridge.postMessage({ action: 'stop' });
    else send({ type: 'dictation-stop' });
  }

  window.tableauAppleSpeechEvent = (event) => {
    if (event.type === 'transcript') {
      send({ ...event, type: 'dictation-transcript' });
    } else if (event.type === 'error') {
      send({ type: 'dictation-cancel' });
      releaseMicrophone(); dictating = false;
      dictationBtn.classList.remove('listening'); dictationBtn.textContent = '🎙️ Dicter';
      showDictation('error', 'Dictée interrompue', event.message || 'Erreur Apple Speech');
    }
  };

  function handleDictationEvent(msg) {
    if (!msg.type || !msg.type.startsWith('dictation-')) return false;
    if (msg.type === 'dictation-preview') showDictation('listening', dictating ? 'Écoute…' : 'Transcription…', msg.text);
    if (msg.type === 'dictation-status') showDictation(msg.status, msg.label || msg.status);
    if (msg.type === 'dictation-warning') dictationHint.textContent = msg.message;
    if (msg.type === 'dictation-error') {
      releaseMicrophone(); dictating = false;
      dictationBtn.classList.remove('listening'); dictationBtn.textContent = '🎙️ Dicter';
      showDictation('error', 'Dictée interrompue', msg.message);
    }
    if (msg.type === 'dictation-result') {
      insertionPosition = msg.nextPosition || insertionPosition;
      showDictation('done', 'Ajouté au tableau', msg.transcript);
      const memory = msg.diagnostic && msg.diagnostic.transcription && msg.diagnostic.transcription.peakMemoryBytes;
      const measures = [
        msg.metrics.firstPreviewMs == null ? null : `premier texte ${msg.metrics.firstPreviewMs} ms`,
        msg.metrics.transcriptionMs == null ? null : `final ${msg.metrics.transcriptionMs} ms`,
        memory == null ? null : `mémoire ${(memory / 1048576).toFixed(0)} Mo`
      ].filter(Boolean).join(' · ');
      dictationHint.textContent = measures || `Prêt · ${msg.metrics.totalAfterStopMs} ms après l’arrêt`;
      setTimeout(() => { if (!dictating) dictationOverlay.classList.add('hidden'); }, 2800);
      render();
    }
    return true;
  }

  dictationBtn.addEventListener('click', () => dictating ? stopDictation() : startDictation());
  dictationEngine.addEventListener('change', () => {
    localStorage.setItem('tableau-dictation-engine', dictationEngine.value);
    updateDictationAvailability();
  });
  window.addEventListener('keydown', (event) => {
    if (event.altKey && event.code === 'Space' && document.activeElement.tagName !== 'INPUT') {
      event.preventDefault();
      dictating ? stopDictation() : startDictation();
    }
  });

  function updateDictationAvailability() {
    const appleSelected = dictationEngine.value === 'apple-speech';
    const available = appleSelected ? appleSpeechAvailable : !!dictationStatus.whisper;
    dictationBtn.disabled = !available;
    dictationHint.textContent = available
      ? `${appleSelected ? 'Apple Speech local' : 'Whisper local'} · interprétation ${dictationStatus.interpreter === 'rules-fallback' ? 'locale légère' : 'par modèle local'}`
      : (appleSelected ? 'Apple Speech est disponible dans l’app macOS.' : 'Whisper local à installer (voir README).');
  }

  if (!appleSpeechAvailable) dictationEngine.querySelector('option[value="apple-speech"]').disabled = true;
  fetch('/api/dictation/status').then((response) => response.json()).then((status) => {
    dictationStatus = status;
    updateDictationAvailability();
  }).catch(() => {});

  // ---------------------------------------------------------------------
  // Modale d'info / commande Codex
  // ---------------------------------------------------------------------
  const infoModal = document.getElementById('infoModal');
  document.getElementById('infoBtn').addEventListener('click', async () => {
    try {
      const info = await fetch('/api/info').then((r) => r.json());
      document.getElementById('codexCommand').textContent = info.codexCommand;
    } catch (e) { /* ignore */ }
    infoModal.classList.remove('hidden');
  });
  document.getElementById('closeModal').addEventListener('click', () => infoModal.classList.add('hidden'));

  // État initial : on récupère aussi le thème persisté avant la première
  // synchro websocket, pour éviter un flash visuel dans le mauvais thème.
  fetch('/api/state').then((r) => r.json()).then((s) => { if (s.theme) applyTheme(s.theme, false); }).catch(() => {});

  connect();
  render();
})();
