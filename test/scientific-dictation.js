const assert = require('assert');
const fs = require('fs');
const path = require('path');
const TEST_DATA_FILE = path.join(__dirname, '..', 'data', 'tableau-dictation-test.json');
process.env.TABLEAU_DATA_FILE = TEST_DATA_FILE;
try { fs.unlinkSync(TEST_DATA_FILE); } catch {}
const { deterministicInterpret, rulesCanHandle } = require('../server/scientific-interpreter.js');
const { parseSpokenMath } = require('../server/spoken-math-parser.js');
const { CanvasStore } = require('../server/store.js');

const cases = [
  ['a au carré plus b au carré égale c au carré', 'a^2 + b^2 = c^2'],
  ['x au carré moins cinq x plus six égale zéro', 'x^2 - 5x + 6 = 0'],
  ['deux x plus trois égale sept', '2x + 3 = 7'],
  ['ouvrir parenthèse x plus deux fermer parenthèse fois R', '\\left(x + 2\\right)R'],
  ['y égale racine de x au carré plus un', 'y = \\sqrt{x^2} + 1'],
  ['x égale moins b plus racine de delta sur deux a', 'x = \\frac{-b + \\sqrt{\\Delta}}{2a}'],
  ['VS est égal à VR plus VC', 'V_s = V_R + V_C'],
  ['VR est égal à R fois i', 'V_R = Ri'],
  ['i est égal à C fois dérivée de VC par rapport au temps', 'i = C\\frac{dV_C}{dt}'],
  ['delta est égal à b au carré moins quatre a c', '\\Delta = b^2 - 4ac'],
  ['VC est égal à dQ sur dt', 'V_C = \\frac{dQ}{dt}'],
  ['VS égale R C fois dérivée de VC par rapport au temps plus VC', 'V_s = RC\\frac{dV_C}{dt} + V_C'],
  ['V R un égale R un fois i', 'V_{R1} = R_1i'],
  ['donc là je mets VS égal VR plus VC', 'V_s = V_R + V_C'],
  ['attends non je voulais dire VR plus VC', 'V_R + V_C'],
  ['ok maintenant R fois i', 'Ri'],
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

const pythagoras = parseSpokenMath('a au carré plus b au carré égale c au carré');
assert.strictEqual(pythagoras.complete, true);
assert.strictEqual(pythagoras.ast.type, 'Equality');
assert.strictEqual(pythagoras.ast.left.type, 'Add');
assert.strictEqual(pythagoras.ast.right.type, 'Power');
console.log('[ok] les deux côtés de l’égalité sont des expressions AST complètes');

const incomplete = deterministicInterpret('a au carré plus banane égale c');
assert.strictEqual(incomplete.complete, false);
assert.strictEqual(incomplete.engine, 'fallback');
assert.strictEqual(incomplete.items[0].type, 'text');
assert.deepStrictEqual(incomplete.structuredParse[0].unparsedTokens, ['banane', '=', 'c']);
assert.strictEqual(rulesCanHandle('a au carré plus banane égale c'), false);
console.log('[ok] un parse incomplet est routé en fallback et conserve les tokens non analysés');

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
