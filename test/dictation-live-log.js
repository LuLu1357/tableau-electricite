const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DictationSession } = require('../server/dictation.js');

const LIVE_FILE = path.join(__dirname, 'dictation-live-results.json');

function resetLiveFile() {
  fs.writeFileSync(LIVE_FILE, '[]\n');
}

async function main() {
  resetLiveFile();

  const fakeStore = {
    getAll() { return []; },
    get() { return null; },
    applyBatch(actions) {
      return { revision: actions.length };
    },
  };

  const session = new DictationSession({
    store: fakeStore,
    send: () => {},
    position: { x: 100, y: 120 },
    selectedIds: [],
    engine: 'apple-speech',
  });

  session.addExternalTranscript({
    text: 'VS est égal à VR plus VC',
    segments: [],
    model: 'AppleSpeech',
    firstTextMs: 250,
    transcriptionMs: 800,
    audioMs: 1200,
    peakMemoryBytes: 150000,
    baselineMemoryBytes: 120000,
  });

  let rows = JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8'));
  assert.deepStrictEqual(rows, [], 'une preview ne doit pas créer d’entrée');

  await session.finishExternal();

  rows = JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8'));
  assert.strictEqual(Array.isArray(rows), true, 'le journal doit être un tableau');
  assert.strictEqual(rows.length, 1, 'une dictée finale doit créer exactement une entrée');
  assert.strictEqual(rows[0].source, 'apple', 'la source doit être apple');
  assert.strictEqual(rows[0].transcriptionAppleSpeechBrute, 'VS est égal à VR plus VC');
  assert.strictEqual(rows[0].transcriptionNettoyee, 'VS est égal à VR plus VC');
  assert.ok(rows[0].resultatLatexObtenu, 'le résultat LaTeX obtenu doit être enregistré');
  assert.ok(rows[0].timestamp, 'un timestamp doit être ajouté');
  assert.ok(rows[0].transcriptionMs == null || Number.isFinite(rows[0].transcriptionMs), 'transcriptionMs doit rester nulle ou numérique');
  console.log('[ok] le journal live ajoute exactement une entrée à la fin de la dictée et ignore les previews');

  resetLiveFile();
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
