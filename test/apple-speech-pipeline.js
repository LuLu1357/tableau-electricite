const assert = require('assert');
const { DictationSession } = require('../server/dictation.js');

const added = [];
const messages = [];
const store = {
  revision: 0,
  get: () => null,
  getAll: () => [],
  applyBatch(actions) {
    added.push(...actions.map((action) => action.element));
    this.revision += 1;
    return { revision: this.revision };
  },
};

(async () => {
  const session = new DictationSession({
    store,
    send: (message) => messages.push(message),
    position: { x: 120, y: 240 },
    selectedIds: [],
    engine: 'apple-speech',
  });

  session.addExternalTranscript({
    text: 'VS est égal à VR plus VC',
    isFinal: false,
    model: 'SpeechAnalyzer/SpeechTranscriber fr-FR (on-device)',
    firstTextMs: 310,
    audioMs: 1800,
    peakMemoryBytes: 42_000_000,
    baselineMemoryBytes: 38_000_000,
    contextualStrings: ['Kirchhoff', 'Thévenin', 'VC', 'VR'],
    segments: [{ text: 'VS est égal à VR plus VC', startMs: 0, durationMs: 1800 }],
  });
  session.addExternalTranscript({
    text: 'VS est égal à VR plus VC',
    isFinal: true,
    model: 'SpeechAnalyzer/SpeechTranscriber fr-FR (on-device)',
    firstTextMs: 310,
    transcriptionMs: 190,
    audioMs: 1800,
    peakMemoryBytes: 42_000_000,
    baselineMemoryBytes: 38_000_000,
    contextualStrings: ['Kirchhoff', 'Thévenin', 'VC', 'VR'],
    segments: [{ text: 'VS est égal à VR plus VC', startMs: 0, durationMs: 1800 }],
  });

  const result = await session.finish();
  assert.strictEqual(added.length, 1);
  assert.strictEqual(added[0].source, 'eleve');
  assert.strictEqual(added[0].latex, 'V_s = V_R + V_C');
  assert.strictEqual(added[0].dictation.engine, 'apple-speech');
  assert.strictEqual(added[0].dictation.rawTranscript, 'VS est égal à VR plus VC');
  assert.strictEqual(result.diagnostic.engine, 'apple-speech');
  // Prefer the memory delta (peak - baseline) as a diagnostic metric for Apple Speech
  assert.strictEqual(result.diagnostic.transcription.memoryDeltaBytes, 4_000_000);
  assert.strictEqual(result.diagnostic.transcription.peakMemoryBytes, 42_000_000);
  assert.strictEqual(result.diagnostic.transcription.baselineMemoryBytes, 38_000_000);
  assert.strictEqual(result.metrics.firstPreviewMs, 310);
  assert.strictEqual(result.metrics.transcriptionMs, 190);
  assert(messages.some((message) => message.type === 'dictation-preview'));
  console.log('[ok] Apple Speech rejoint le pipeline scientifique sans changer le parseur ni les métadonnées');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
