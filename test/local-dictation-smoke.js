// Test local optionnel : génère une vraie piste audio française avec la voix
// macOS, la passe par la même session Whisper que le navigateur, puis vérifie
// l'insertion finale. Il nécessite whisper.cpp + models/ggml-base.bin.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tableau-smoke-'));
process.env.TABLEAU_DATA_FILE = path.join(tempDir, 'tableau.json');
const { CanvasStore } = require('../server/store.js');
const { DictationSession } = require('../server/dictation.js');

function wavPcm(file) {
  const wav = fs.readFileSync(file);
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'data') return wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error('Bloc PCM introuvable dans le WAV');
}

async function main() {
  const aiff = path.join(tempDir, 'phrase.aiff');
  const wav = path.join(tempDir, 'phrase.wav');
  execFileSync('/usr/bin/say', ['-v', 'Thomas', '-r', '185', '-o', aiff, 'V S est égal à V R plus V C']);
  execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', aiff, '-o', wav]);

  const messages = [];
  let previewResolve;
  let previewReject;
  const preview = new Promise((resolve, reject) => { previewResolve = resolve; previewReject = reject; });
  const store = new CanvasStore();
  const session = new DictationSession({
    store,
    position: { x: 120, y: 160 },
    selectedIds: [],
    send(message) {
      messages.push(message);
      if (message.type === 'dictation-preview') previewResolve(message);
      if (message.type === 'dictation-warning') previewReject(new Error(message.message));
    },
  });

  const started = performance.now();
  const pcm = wavPcm(wav);
  assert.ok(pcm.length >= 32_000, `piste de test trop courte (${pcm.length} octets)`);
  session.addAudio(pcm.toString('base64'));
  let previewTimer;
  const first = await Promise.race([
    preview,
    new Promise((_, reject) => { previewTimer = setTimeout(() => reject(new Error('Aucun aperçu en 15 s')), 15_000); }),
  ]);
  clearTimeout(previewTimer);
  const firstPreviewMs = Math.round(performance.now() - started);
  const result = await session.finish();
  const element = store.getAll()[0];

  assert.match(first.text, /VS est égal à VR (?:plus|\+) VC/i);
  assert.strictEqual(element.latex, 'V_s = V_R + V_C');
  assert.strictEqual(element.source, 'eleve');
  assert.match(element.dictation.rawTranscript, /VS est égal à VR (?:plus|\+) VC/i);
  assert.strictEqual(result.revision, 1);
  assert.strictEqual(result.diagnostic.interpreter.selected, 'rules');
  assert.strictEqual(result.diagnostic.interpreter.reason, 'complete_parse');
  assert.strictEqual(result.diagnostic.structuredParse[0].ast.type, 'Equality');
  assert.ok(Array.isArray(result.diagnostic.whisper.segments));
  console.log(JSON.stringify({ firstPreviewMs, ...result.metrics, transcript: result.transcript, latex: element.latex }, null, 2));
  console.log('[ok] audio -> aperçu -> transcription -> interprétation -> lot store source=eleve');
  if (store._saveTimer) clearTimeout(store._saveTimer);
  fs.rmSync(tempDir, { recursive: true, force: true });
}

main().catch((error) => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  console.error(error);
  process.exit(1);
});
