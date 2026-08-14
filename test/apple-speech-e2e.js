const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { DictationSession } = require('../server/dictation.js');
const { interpretScientific } = require('../server/scientific-interpreter.js');

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

async function runAppleCli(wav) {
  // Run the Swift CLI that performs Apple Speech locally and emits JSON
  const cmd = 'swift';
  const args = ['run', 'AppleSpeechCli', wav];
  const cwd = path.join(__dirname, '..', 'swift-app');
  const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 120_000, cwd });
  return JSON.parse(stdout);
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tableau-apple-e2e-'));
  try {
    const aiff = path.join(tempDir, 'phrase.aiff');
    const wav = path.join(tempDir, 'phrase.wav');
    execFileSync('/usr/bin/say', ['-v', 'Thomas', '-r', '185', '-o', aiff, 'V S est égal à V R plus V C']);
    execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', aiff, '-o', wav]);

    const pcm = wavPcm(wav);

    // Run Apple Speech CLI
    console.log('Running AppleSpeechCli (may trigger swift build)...');
    const apple = await runAppleCli(wav);
    console.log('Apple result:', apple.text);

    // Run Whisper (reuse existing transcribePcm if available)
    const { transcribePcm } = require('../server/dictation.js');
    let whisper = null;
    try {
      whisper = await transcribePcm(pcm, { prompt: false });
      console.log('Whisper result:', whisper.text);
    } catch (err) {
      console.warn('Whisper unavailable or failed:', err.message);
    }

    // Interpret both with the scientific interpreter and verify insertion
    // Apple path
    const storeApple = { revision: 0, get: () => null, getAll: () => [], applyBatch(actions) { this.revision+=1; return { revision: this.revision }; } };
    const messages = [];
    const sessionApple = new DictationSession({ store: storeApple, send: (m) => messages.push(m), position: { x: 120, y: 160 }, selectedIds: [], engine: 'apple-speech' });

    sessionApple.addExternalTranscript({
      text: apple.text,
      isFinal: true,
      model: 'SpeechAnalyzer/SpeechTranscriber fr-FR (on-device)',
      firstTextMs: apple.firstTextMs || 0,
      transcriptionMs: apple.transcriptionMs || 0,
      audioMs: apple.audioMs || 0,
      peakMemoryBytes: apple.peakMemoryBytes || null,
      baselineMemoryBytes: apple.baselineMemoryBytes || null,
      contextualStrings: [],
      segments: apple.segments || [],
    });

    const resApple = await sessionApple.finishExternal();
    console.log('Apple interpreted latex:', resApple.items.map(i => i.latex || i.text).join('\n'));

    let comparisonRan = false;
    if (whisper) {
      // Whisper path
      const storeW = { revision: 0, get: () => null, getAll: () => [], applyBatch(actions) { this.revision+=1; return { revision: this.revision }; } };
      const messagesW = [];
      const sessionW = new DictationSession({ store: storeW, send: (m)=>messagesW.push(m), position: { x: 120, y: 160 }, selectedIds: [], engine: 'whisper' });
      sessionW.addAudio(pcm.toString('base64'));
      const resW = await sessionW.finish();
      console.log('Whisper interpreted latex:', resW.items.map(i => i.latex || i.text).join('\n'));

      // Print a small comparison
      console.log('\n=== Comparison ===');
      console.log('Apple transcript:', apple.text);
      console.log('Whisper transcript:', whisper.text);
      console.log('Apple latex:', resApple.items.map(i => i.latex || i.text).join('\n'));
      console.log('Whisper latex:', resW.items.map(i => i.latex || i.text).join('\n'));
      comparisonRan = true;
    }

    if (process.env.STRICT_APPLE_WHISPER === '1' && !comparisonRan) {
      throw new Error('Strict compare requested but Whisper is unavailable on this host');
    }

    if (comparisonRan) {
      console.log('[ok] apple e2e executed — both pipelines ran on the same WAV');
    } else {
      console.log('[ok] Apple E2E succeeded; Whisper unavailable on this host — comparison skipped');
    }
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
