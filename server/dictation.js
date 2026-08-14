const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { interpretScientific, DEFAULT_MODEL } = require('./scientific-interpreter.js');

const execFileAsync = promisify(execFile);
const SAMPLE_RATE = 16_000;
const MAX_SECONDS = 90;
const PREVIEW_INTERVAL_MS = Number(process.env.TABLEAU_DICTATION_PREVIEW_MS || 1400);
const DEFAULT_WHISPER_PROMPT = 'Mathématiques, électricité, électronique, Pythagore, Kirchhoff, Thévenin, Norton, résistance, condensateur, capacité, impédance, tension, courant, dérivée, intégrale, exposant, vecteur, VS, VR, VC.';
const DIAGNOSTIC_LIMIT = 50;
const recentDiagnostics = [];

function executablePath() {
  const candidates = [
    process.env.WHISPER_CPP_BIN,
    '/opt/homebrew/bin/whisper-cli',
    '/usr/local/bin/whisper-cli',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function modelPath(explicitModel) {
  const candidates = [
    explicitModel,
    process.env.WHISPER_MODEL,
    path.join(__dirname, '..', 'models', 'ggml-base.bin'),
    path.join(__dirname, '..', 'models', 'ggml-small.bin'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function writeWav(file, pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, pcm]));
}

function extractWhisperText(json) {
  if (typeof json.text === 'string') return json.text.trim();
  const chunks = json.transcription || json.segments || [];
  return chunks.map((entry) => entry.text || (entry.offsets && entry.offsets.text) || '').join(' ').replace(/\s+/g, ' ').trim();
}

async function transcribePcm(pcm, options = {}) {
  const binary = executablePath();
  const model = modelPath(options.model);
  if (!binary || !model) throw new Error('Dictée indisponible : installe whisper.cpp et le modèle ggml-base.bin (voir README).');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tableau-dictee-'));
  const wav = path.join(tempDir, 'speech.wav');
  const out = path.join(tempDir, 'result');
  try {
    writeWav(wav, pcm);
    // Le petit modèle Whisper est plus stable sur CPU/Accelerate quand Qwen
    // occupe Metal. Sur M2 la différence isolée est minime, mais cela évite
    // une première transcription à >10 s observée avec les deux sur le GPU.
    const args = ['-ng', '-m', model, '-f', wav, '-l', 'fr', '-ojf', '-of', out, '-nt'];
    const prompt = options.prompt === false ? '' : (options.prompt || process.env.TABLEAU_WHISPER_PROMPT || '');
    if (prompt) args.push('--prompt', prompt);
    const measured = options.measureMemory && process.platform === 'darwin' && fs.existsSync('/usr/bin/time');
    const command = measured ? '/usr/bin/time' : binary;
    const commandArgs = measured ? ['-l', binary, ...args] : args;
    const started = performance.now();
    const execution = await execFileAsync(command, commandArgs, {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GGML_METAL_PATH_RESOURCES: path.dirname(binary) },
    });
    const parsed = JSON.parse(fs.readFileSync(`${out}.json`, 'utf8'));
    const memoryMatch = measured && /(\d+)\s+maximum resident set size/i.exec(execution.stderr || '');
    return {
      text: extractWhisperText(parsed), segments: parsed.transcription || parsed.segments || [],
      model, prompt: prompt || null, latencyMs: Math.round(performance.now() - started),
      peakMemoryBytes: memoryMatch ? Number(memoryMatch[1]) : null,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function rememberDiagnostic(entry) {
  recentDiagnostics.push(entry);
  if (recentDiagnostics.length > DIAGNOSTIC_LIMIT) recentDiagnostics.splice(0, recentDiagnostics.length - DIAGNOSTIC_LIMIT);
}

function dictationDiagnostics() {
  return recentDiagnostics.slice().reverse();
}

function captureCorpusSample(pcm, diagnostic) {
  if (process.env.TABLEAU_DICTATION_CAPTURE !== '1') return null;
  const directory = path.join(__dirname, '..', 'data', 'dictation-corpus');
  fs.mkdirSync(directory, { recursive: true });
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const audioFile = `${id}.wav`;
  writeWav(path.join(directory, audioFile), pcm);
  const manifestFile = path.join(directory, 'manifest.json');
  let manifest = { version: 1, samples: [] };
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch {}
  manifest.samples.push({
    id, audio: audioFile,
    expectedTranscript: '', expectedOutput: '',
    whisperTranscript: diagnostic.whisper.transcript,
    finalOutput: diagnostic.output.map((item) => item.latex || item.text).join('\n'),
    correctedOutput: '', createdAt: diagnostic.at,
  });
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return { id, manifestFile };
}

function scientificPrompt(elements) {
  const dynamic = (elements || []).flatMap((element) => [element.label, element.text, element.latex])
    .filter(Boolean).join(' ').match(/\b(?:V[A-Za-z0-9]*|R\d*|C\d*|i)\b/g) || [];
  const additions = [...new Set(dynamic)].slice(0, 12);
  const configured = process.env.TABLEAU_WHISPER_PROMPT
    || (process.env.TABLEAU_WHISPER_USE_CONTEXT === '1' ? DEFAULT_WHISPER_PROMPT : '');
  if (!configured) return false;
  return `${configured}${additions.length ? ` Symboles du tableau : ${additions.join(', ')}.` : ''}`;
}

async function ollamaAvailable() {
  try {
    const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return false;
    const body = await response.json();
    return (body.models || []).some((model) => model.name === DEFAULT_MODEL || model.name.startsWith(`${DEFAULT_MODEL}:`));
  } catch {
    return false;
  }
}

function compactContext(store, selectedIds, position) {
  const selected = (selectedIds || []).map((id) => store.get(id)).filter(Boolean);
  const nearby = store.getAll().filter((el) => {
    if (el.x == null || el.y == null) return false;
    return Math.hypot(el.x - position.x, el.y - position.y) < 420;
  }).slice(-12);
  return [...new Map([...selected, ...nearby].map((el) => [el.id, el])).values()].map((el) => ({
    type: el.type, kind: el.kind, label: el.label, text: el.text, latex: el.latex,
  }));
}

class DictationSession {
  constructor({ store, send, position, selectedIds, engine = 'whisper' }) {
    this.store = store;
    this.send = send;
    this.position = position || { x: 80, y: 100 };
    this.selectedIds = selectedIds || [];
    this.buffers = [];
    this.bytes = 0;
    this.startedAt = performance.now();
    this.lastPreviewAt = -Infinity;
    this.previewRunning = false;
    this.previewQueued = false;
    this.previewPromise = null;
    this.lastPreview = null;
    this.finishing = false;
    this.firstPreviewMs = null;
    this.context = compactContext(this.store, this.selectedIds, this.position);
    this.whisperPrompt = scientificPrompt(this.context);
    this.engine = engine === 'apple-speech' ? 'apple-speech' : 'whisper';
    this.externalTranscript = null;
  }

  addAudio(base64) {
    if (this.engine !== 'whisper') return;
    const chunk = Buffer.from(base64 || '', 'base64');
    if (!chunk.length) return;
    if (this.bytes + chunk.length > SAMPLE_RATE * 2 * MAX_SECONDS) throw new Error(`La dictée est limitée à ${MAX_SECONDS} secondes.`);
    this.buffers.push(chunk);
    this.bytes += chunk.length;
    const now = performance.now();
    if (this.bytes >= SAMPLE_RATE * 2 && now - this.lastPreviewAt >= PREVIEW_INTERVAL_MS) this.requestPreview();
  }

  requestPreview() {
    if (this.finishing) return;
    if (this.previewRunning) { this.previewQueued = true; return; }
    this.previewRunning = true;
    this.lastPreviewAt = performance.now();
    const pcm = Buffer.concat(this.buffers);
    const previewBytes = this.bytes;
    this.previewPromise = transcribePcm(pcm, { prompt: this.whisperPrompt }).then((result) => {
      this.lastPreview = { bytes: previewBytes, result };
      if (this.firstPreviewMs == null) this.firstPreviewMs = Math.round(performance.now() - this.startedAt);
      if (result.text) this.send({ type: 'dictation-preview', text: result.text });
    }).catch((error) => {
      this.send({ type: 'dictation-warning', message: error.message });
    }).finally(() => {
      this.previewRunning = false;
      this.previewPromise = null;
      if (this.previewQueued && !this.finishing) { this.previewQueued = false; this.requestPreview(); }
    });
  }

  addExternalTranscript(transcript) {
    if (this.engine !== 'apple-speech') return;
    const text = typeof transcript.text === 'string' ? transcript.text.trim() : '';
    if (!text) return;
    this.externalTranscript = {
      text,
      segments: Array.isArray(transcript.segments) ? transcript.segments : [],
      model: transcript.model || 'SpeechTranscriber',
      prompt: Array.isArray(transcript.contextualStrings) ? transcript.contextualStrings.join(', ') : null,
      latencyMs: Number.isFinite(transcript.transcriptionMs) ? transcript.transcriptionMs : null,
      peakMemoryBytes: Number.isFinite(transcript.peakMemoryBytes) ? transcript.peakMemoryBytes : null,
      baselineMemoryBytes: Number.isFinite(transcript.baselineMemoryBytes) ? transcript.baselineMemoryBytes : null,
      audioMs: Number.isFinite(transcript.audioMs) ? transcript.audioMs : null,
    };
    if (this.firstPreviewMs == null && Number.isFinite(transcript.firstTextMs)) this.firstPreviewMs = transcript.firstTextMs;
    this.send({ type: 'dictation-preview', text });
  }

  async finish() {
    if (this.engine !== 'whisper') return this.finishExternal();
    if (this.bytes < SAMPLE_RATE) throw new Error('Aucune parole exploitable reçue.');
    this.finishing = true;
    this.previewQueued = false;
    if (this.previewPromise) await this.previewPromise;
    const pcm = Buffer.concat(this.buffers);
    this.send({ type: 'dictation-status', status: 'transcribing', label: 'Transcription…' });
    const transcribeStarted = performance.now();
    const transcript = this.lastPreview && this.lastPreview.bytes === this.bytes
      ? this.lastPreview.result
      : await transcribePcm(pcm, { prompt: this.whisperPrompt });
    if (!transcript.text) throw new Error('Whisper n’a reconnu aucun texte.');
    return this.interpretAndInsert(transcript, {
      audioMs: Math.round((this.bytes / 2 / SAMPLE_RATE) * 1000),
      transcribeStarted,
      transcriptionMs: Math.round(performance.now() - transcribeStarted),
      audioPipeline: { sampleRate: SAMPLE_RATE, format: 'pcm_s16le_mono', browserResampling: 'window-average', browserEchoCancellation: true, browserNoiseSuppression: true },
      pcm,
    });
  }

  async finishExternal() {
    if (!this.externalTranscript || !this.externalTranscript.text) throw new Error('Apple Speech n’a reconnu aucun texte.');
    this.finishing = true;
    this.send({ type: 'dictation-status', status: 'interpreting', label: 'Mise au propre…' });
    return this.interpretAndInsert(this.externalTranscript, {
      audioMs: this.externalTranscript.audioMs,
      transcriptionMs: this.externalTranscript.latencyMs,
      audioPipeline: { sampleRate: SAMPLE_RATE, format: 'pcm_s16le_mono', browserResampling: 'window-average', browserEchoCancellation: true, browserNoiseSuppression: true, nativeBridge: 'WKScriptMessageHandler' },
    });
  }

  async interpretAndInsert(transcript, options) {
    this.send({ type: 'dictation-preview', text: transcript.text });
    this.send({ type: 'dictation-status', status: 'interpreting', label: 'Mise au propre…' });
    const interpretationStarted = performance.now();
    const interpreted = await interpretScientific(transcript.text, {
      position: this.position, elements: this.context, segments: transcript.segments,
    });
    const actions = interpreted.items.map((item, index) => {
      const y = this.position.y + index * 64;
      const dictation = {
        rawTranscript: transcript.text,
        spoken: item.spoken,
        segments: transcript.segments,
        ambiguity: item.ambiguity || null,
        interpreter: interpreted.engine,
        interpreterReason: interpreted.reason,
        structuredParse: interpreted.structuredParse || interpreted.routing || null,
        engine: this.engine,
      };
      const element = item.type === 'equation'
        ? { type: 'equation', latex: item.latex, x: this.position.x, y, source: 'eleve', dictation }
        : { type: 'text', text: item.text, x: this.position.x, y, source: 'eleve', dictation };
      return { op: 'add', element };
    });
    const result = this.store.applyBatch(actions);
    const nextPosition = { x: this.position.x, y: this.position.y + Math.max(actions.length, 1) * 64 };
    const metrics = {
      audioMs: options.audioMs,
      firstPreviewMs: this.firstPreviewMs,
      transcriptionMs: options.transcriptionMs == null ? null : Math.round(options.transcriptionMs),
      interpretationMs: Math.round(performance.now() - interpretationStarted),
      totalAfterStopMs: options.transcribeStarted == null ? Math.round(performance.now() - interpretationStarted) : Math.round(performance.now() - options.transcribeStarted),
    };
    const diagnostic = {
      at: new Date().toISOString(), audioDurationMs: metrics.audioMs,
      engine: this.engine,
      audioPipeline: options.audioPipeline,
      transcription: {
        engine: this.engine, transcript: transcript.text, segments: transcript.segments, model: transcript.model,
        contextualVocabulary: transcript.prompt, passLatencyMs: transcript.latencyMs,
        peakMemoryBytes: transcript.peakMemoryBytes, baselineMemoryBytes: transcript.baselineMemoryBytes || null,
      },
      interpreter: { selected: interpreted.engine, reason: interpreted.reason, confidence: interpreted.confidence, complete: interpreted.complete },
      structuredParse: interpreted.structuredParse || interpreted.routing || null,
      output: interpreted.items,
      latencies: metrics,
    };
    if (this.engine === 'whisper') diagnostic.whisper = {
      transcript: transcript.text, segments: transcript.segments, model: transcript.model,
      prompt: transcript.prompt, passLatencyMs: transcript.latencyMs, peakMemoryBytes: transcript.peakMemoryBytes,
    };
    rememberDiagnostic(diagnostic);
    if (options.pcm) diagnostic.corpusCapture = captureCorpusSample(options.pcm, diagnostic);
    return {
      transcript: transcript.text,
      items: interpreted.items,
      revision: result.revision,
      nextPosition,
      metrics,
      diagnostic,
    };
  }
}

function dictationCapabilities() {
  return Promise.resolve({
    whisper: !!executablePath() && !!modelPath(),
    whisperBinary: executablePath(),
    whisperModel: modelPath(),
    localModel: DEFAULT_MODEL,
  }).then(async (result) => ({ ...result, interpreter: (await ollamaAvailable()) ? DEFAULT_MODEL : 'rules-fallback' }));
}

module.exports = {
  DictationSession, dictationCapabilities, dictationDiagnostics, modelPath,
  transcribePcm, writeWav, SAMPLE_RATE, DEFAULT_WHISPER_PROMPT,
};
