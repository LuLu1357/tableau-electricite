// Petit serveur web local : sert la page du tableau (HTML/JS) et tient
// la connexion websocket qui synchronise en direct le navigateur et les
// actions déclenchées par Codex via MCP.
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const { DictationSession, dictationCapabilities, dictationDiagnostics } = require('./dictation.js');

function startHttpServer(store, port) {
  const app = express();
  app.use(express.static(path.join(__dirname, '..', 'web')));

  // Images de pages PDF insérées (rasterisées localement, voir server/pdf.js).
  const pdfCacheDir = path.join(__dirname, '..', 'data', 'pdf-cache');
  fs.mkdirSync(pdfCacheDir, { recursive: true });
  app.use('/pdf-cache', express.static(pdfCacheDir));

  app.get('/api/state', (req, res) => {
    res.json({ elements: store.getAll(), revision: store.revision, theme: store.getTheme() });
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, count: store.getAll().length, revision: store.revision });
  });

  app.get('/api/info', (req, res) => {
    res.json({
      port,
      mcpServerPath: path.join(__dirname, 'mcp-server.js'),
      codexCommand: `codex mcp add tableau-electricite -- node "${path.join(__dirname, 'mcp-server.js')}"`,
    });
  });

  app.get('/api/dictation/status', async (req, res) => {
    res.json(await dictationCapabilities());
  });

  // Diagnostic de développement local uniquement. Aucun panneau n'est ajouté
  // à l'interface normale et les pistes audio ne sont pas conservées ici.
  app.get('/api/dictation/diagnostics', (req, res) => {
    res.json({ dictations: dictationDiagnostics() });
  });

  // Ouverture d'un PDF de cours à une page précise, dans un nouvel onglet
  // (le navigateur gère nativement le fragment #page=N). Local uniquement :
  // le serveur n'écoute que sur 127.0.0.1, jamais exposé au réseau.
  app.get('/api/pdf', (req, res) => {
    const p = req.query.path;
    if (!p || typeof p !== 'string' || !p.toLowerCase().endsWith('.pdf')) {
      return res.status(400).send('Paramètre "path" invalide (doit pointer vers un .pdf).');
    }
    if (!fs.existsSync(p)) return res.status(404).send('PDF introuvable.');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    fs.createReadStream(p).pipe(res);
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  function broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(payload);
    }
  }

  store.on('change', (evt) => broadcast(evt));
  store.on('theme', (evt) => broadcast({ type: 'theme', theme: evt.theme }));

  wss.on('connection', (ws) => {
    let dictation = null;
    ws.send(JSON.stringify({ type: 'state', elements: store.getAll(), revision: store.revision, theme: store.getTheme() }));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        switch (msg.type) {
          case 'add':
            store.add(msg.element);
            break;
          case 'update':
            store.update(msg.id, msg.patch);
            break;
          case 'remove':
            store.remove(msg.id);
            break;
          case 'clear':
            store.clear(msg.onlyType || null);
            break;
          case 'theme':
            store.setTheme(msg.theme);
            break;
          case 'dictation-start':
            dictation = new DictationSession({
              store,
              send: (payload) => { if (ws.readyState === 1) ws.send(JSON.stringify(payload)); },
              position: msg.position,
              selectedIds: msg.selectedIds,
            });
            ws.send(JSON.stringify({ type: 'dictation-status', status: 'listening', label: 'Écoute…' }));
            break;
          case 'dictation-audio':
            if (dictation) dictation.addAudio(msg.pcm);
            break;
          case 'dictation-stop': {
            if (!dictation) break;
            const finishing = dictation;
            dictation = null;
            finishing.finish()
              .then((result) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'dictation-result', ...result })); })
              .catch((error) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'dictation-error', message: error.message })); });
            break;
          }
          default:
            break;
        }
      } catch (e) {
        console.error('[ws] erreur de traitement message:', e.message);
        if (msg && typeof msg.type === 'string' && msg.type.startsWith('dictation-') && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'dictation-error', message: e.message }));
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, wss, broadcast }));
  });
}

module.exports = { startHttpServer };
