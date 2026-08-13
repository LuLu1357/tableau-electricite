const assert = require('assert');
const fs = require('fs');
const path = require('path');
const TEST_DATA_FILE = path.join(__dirname, '..', 'data', 'tableau-dictation-test.json');
process.env.TABLEAU_DATA_FILE = TEST_DATA_FILE;
try { fs.unlinkSync(TEST_DATA_FILE); } catch {}
const { deterministicInterpret } = require('../server/scientific-interpreter.js');
const { CanvasStore } = require('../server/store.js');

const cases = [
  ['VS est égal à VR plus VC', 'V_s = V_R + V_C'],
  ['VR est égal à R fois i', 'V_R = Ri'],
  ['i est égal à C fois dérivée de VC par rapport au temps', 'i = C\\frac{dV_C}{dt}'],
  ['delta est égal à b au carré moins quatre a c', '\\Delta = b^2 - 4ac'],
  ['VC est égal à dQ sur dt', 'V_C = \\frac{dQ}{dt}'],
];

for (const [speech, expected] of cases) {
  const result = deterministicInterpret(speech);
  assert.strictEqual(result.items.length, 1, speech);
  assert.strictEqual(result.items[0].type, 'equation', speech);
  assert.strictEqual(result.items[0].latex, expected, speech);
  assert.strictEqual(result.items[0].spoken, speech, 'la dictée brute doit être conservée');
  console.log(`[ok] ${speech} -> ${expected}`);
}

const ambiguous = deterministicInterpret('x au carré plus deux fois x exposant trois plus cinq').items[0];
assert.strictEqual(ambiguous.type, 'equation');
assert.strictEqual(ambiguous.latex, 'x^2 + 2x^{3} + 5');
assert.ok(ambiguous.ambiguity && ambiguous.ambiguity.alternatives.length >= 2);
console.log('[ok] la portée ambiguë de l’exposant est signalée et conserve des alternatives');

const heading = deterministicInterpret('équation de maille').items[0];
assert.deepStrictEqual({ type: heading.type, text: heading.text }, { type: 'text', text: 'Équation de maille' });
console.log('[ok] une phrase non mathématique reste un texte');

// Le store doit conserver la provenance élève et les métadonnées de dictée,
// y compris dans sa vue compacte utilisée par le professeur/Codex.
const store = new CanvasStore();
const element = store.add({
  type: 'equation', latex: 'V_C = \\frac{dQ}{dt}', x: 50, y: 50, source: 'eleve',
  dictation: { rawTranscript: 'VC est égal à dQ sur dt', ambiguity: null },
});
const compact = store.compactList();
assert.strictEqual(element.source, 'eleve');
assert.strictEqual(compact.elements[compact.elements.length - 1].data.dictation.rawTranscript, 'VC est égal à dQ sur dt');
// Ne pas flusher : ce test unitaire n'a pas vocation à toucher au disque.
if (store._saveTimer) clearTimeout(store._saveTimer);
try { fs.unlinkSync(TEST_DATA_FILE); } catch {}
console.log('[ok] le store compact conserve source=eleve et la transcription brute');
