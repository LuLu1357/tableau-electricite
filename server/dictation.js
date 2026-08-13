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

function executablePath() {
  const candidates = [
    process.env.WHISPER_CPP_BIN,
    '/opt/homebrew/bin/whisper-cli',
    '/usr/local/bin/whisper-cli',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function modelPath() {
  const candidates = [
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

async function transcribePcm(pcm) {
  const binary = executablePath();
  const model = modelPath();
  if (!binary || !model) throw new Error('Dictée indisponible : installe whisper.cpp et le modèle ggml-base.bin (voir README).');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tableau-dictee-'));
  const wav = path.join(tempDir, 'speech.wav');
  const out = path.join(tempDir, 'result');
  try {
    writeWav(wav, pcm);
    // Le petit modèle Whisper est plus stable sur CPU/Accelerate quand Qwen
    // occupe Metal. Sur M2 la différence isolée est minime, mais cela évite
    // une première transcription à >10 s observée avec les deux sur le GPU.
    await execFileAsync(binary, ['-ng', '-m', model, '-f', wav, '-l', 'fr', '-oj', '-of', out, '-nt'], {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GGML_METAL_PATH_RESOURCES: path.dirname(binary) },
    });
    const parsed = JSON.parse(fs.readFileSync(`${out}.json`, 'utf8'));
    return { text: extractWhisperText(parsed), segments: parsed.transcription || parsed.segments || [] };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
  constructor({ store, send, position, selectedIds }) {
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
  }

  addAudio(base64) {
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
    this.previewPromise = transcribePcm(pcm).then((result) => {
      this.lastPreview = { bytes: previewBytes, result };
      if (result.text) this.send({ type: 'dictation-preview', text: result.text });
    }).catch((error) => {
      this.send({ type: 'dictation-warning', message: error.message });
    }).finally(() => {
      this.previewRunning = false;
      this.previewPromise = null;
      if (this.previewQueued && !this.finishing) { this.previewQueued = false; this.requestPreview(); }
    });
  }

  async finish() {
    if (this.bytes < SAMPLE_RATE) throw new Error('Aucune parole exploitable reçue.');
    this.finishing = true;
    this.previewQueued = false;
    if (this.previewPromise) await this.previewPromise;
    const pcm = Buffer.concat(this.buffers);
    this.send({ type: 'dictation-status', status: 'transcribing', label: 'Transcription…' });
    const transcribeStarted = performance.now();
    const transcript = this.lastPreview && this.lastPreview.bytes === this.bytes
      ? this.lastPreview.result
      : await transcribePcm(pcm);
    if (!transcript.text) throw new Error('Whisper n’a reconnu aucun texte.');
    this.send({ type: 'dictation-preview', text: transcript.text });
    this.send({ type: 'dictation-status', status: 'interpreting', label: 'Mise au propre…' });
    const interpretationStarted = performance.now();
    const context = compactContext(this.store, this.selectedIds, this.position);
    const interpreted = await interpretScientific(transcript.text, { position: this.position, elements: context });
    const actions = interpreted.items.map((item, index) => {
      const y = this.position.y + index * 64;
      const dictation = {
        rawTranscript: transcript.text,
        spoken: item.spoken,
        segments: transcript.segments,
        ambiguity: item.ambiguity || null,
        interpreter: interpreted.engine,
      };
      const element = item.type === 'equation'
        ? { type: 'equation', latex: item.latex, x: this.position.x, y, source: 'eleve', dictation }
        : { type: 'text', text: item.text, x: this.position.x, y, source: 'eleve', dictation };
      return { op: 'add', element };
    });
    const result = this.store.applyBatch(actions);
    const nextPosition = { x: this.position.x, y: this.position.y + Math.max(actions.length, 1) * 64 };
    return {
      transcript: transcript.text,
      items: interpreted.items,
      revision: result.revision,
      nextPosition,
      metrics: {
        audioMs: Math.round((this.bytes / 2 / SAMPLE_RATE) * 1000),
        transcriptionMs: Math.round(interpretationStarted - transcribeStarted),
        interpretationMs: Math.round(performance.now() - interpretationStarted),
        totalAfterStopMs: Math.round(performance.now() - transcribeStarted),
      },
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

module.exports = { DictationSession, dictationCapabilities, transcribePcm, writeWav, SAMPLE_RATE };
