// Benchmark volontaire, jamais lancé par `npm test` : il exige la vraie voix
// et peut comparer plusieurs modèles sur exactement les mêmes fichiers.
const fs = require('fs');
const path = require('path');
const { transcribePcm, DEFAULT_WHISPER_PROMPT } = require('../server/dictation.js');
const { deterministicInterpret } = require('../server/scientific-interpreter.js');

function wavPcm(file) {
  const wav = fs.readFileSync(file);
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'data') return wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error(`Bloc PCM introuvable: ${file}`);
}

function words(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

function normalizeLatex(value) { return String(value || '').replace(/\s+/g, ''); }

async function main() {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..', 'data', 'dictation-corpus'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const models = [
    ['base', process.env.WHISPER_BASE_MODEL || path.join(__dirname, '..', 'models', 'ggml-base.bin')],
    ['small', process.env.WHISPER_SMALL_MODEL || path.join(__dirname, '..', 'models', 'ggml-small.bin')],
  ].filter(([, file]) => fs.existsSync(file));
  if (!models.length) throw new Error('Aucun modèle Base/Small trouvé. Configure WHISPER_BASE_MODEL ou WHISPER_SMALL_MODEL.');
  const eligible = manifest.samples.filter((sample) => sample.audio && sample.expectedTranscript && sample.expectedOutput);
  if (!eligible.length) throw new Error('Aucun exemple complété (audio + expectedTranscript + expectedOutput).');
  if (eligible.length < 50) console.warn(`[attention] corpus exploratoire : ${eligible.length}/50 exemples réels complétés`);

  const interpretation = eligible.map((sample) => {
    const result = deterministicInterpret(sample.expectedTranscript);
    const output = result.items.map((item) => item.latex || item.text).join('\n');
    return { id: sample.id, expected: sample.expectedOutput, actual: output, exact: normalizeLatex(output) === normalizeLatex(sample.expectedOutput), engine: result.engine, complete: result.complete };
  });

  const asr = [];
  for (const [modelName, model] of models) {
    for (const promptMode of ['without-context', 'scientific-context']) {
      for (const sample of eligible) {
        const result = await transcribePcm(wavPcm(path.join(root, sample.audio)), {
          model, prompt: promptMode === 'scientific-context' ? DEFAULT_WHISPER_PROMPT : false, measureMemory: true,
        });
        const expectedWords = words(sample.expectedTranscript);
        const errors = distance(expectedWords, words(result.text));
        const interpreted = deterministicInterpret(result.text);
        const finalOutput = interpreted.items.map((item) => item.latex || item.text).join('\n');
        asr.push({
          id: sample.id, model: modelName, promptMode, expectedTranscript: sample.expectedTranscript,
          transcript: result.text, wordErrors: errors, referenceWords: expectedWords.length,
          wer: expectedWords.length ? errors / expectedWords.length : null,
          latencyMs: result.latencyMs, peakMemoryBytes: result.peakMemoryBytes,
          finalOutput, finalExact: normalizeLatex(finalOutput) === normalizeLatex(sample.expectedOutput),
        });
      }
    }
  }

  const summary = [];
  for (const [modelName] of models) for (const promptMode of ['without-context', 'scientific-context']) {
    const rows = asr.filter((row) => row.model === modelName && row.promptMode === promptMode);
    summary.push({
      model: modelName, promptMode, samples: rows.length,
      wer: rows.reduce((sum, row) => sum + row.wordErrors, 0) / rows.reduce((sum, row) => sum + row.referenceWords, 0),
      meanLatencyMs: Math.round(rows.reduce((sum, row) => sum + row.latencyMs, 0) / rows.length),
      peakMemoryBytes: Math.max(...rows.map((row) => row.peakMemoryBytes || 0)) || null,
      finalExactRate: rows.filter((row) => row.finalExact).length / rows.length,
    });
  }
  const report = {
    createdAt: new Date().toISOString(), corpusSize: eligible.length, qualifiedCorpus: eligible.length >= 50,
    interpretation: { exactRate: interpretation.filter((row) => row.exact).length / interpretation.length, rows: interpretation },
    asr: { summary, rows: asr },
    note: 'Le temps avant premier aperçu se mesure dans /api/dictation/diagnostics pendant une dictée réelle, pas sur un fichier statique.',
  };
  const reportFile = path.join(root, `report-${Date.now()}.json`);
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ reportFile, corpusSize: eligible.length, interpretationExactRate: report.interpretation.exactRate, asr: summary }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
