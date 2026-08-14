const assert = require('assert');
const fs = require('fs');
const path = require('path');
const TEST_DATA_FILE = path.join(__dirname, '..', 'data', 'tableau-dictation-test.json');
process.env.TABLEAU_DATA_FILE = TEST_DATA_FILE;
try { fs.unlinkSync(TEST_DATA_FILE); } catch {}
const { deterministicInterpret, extractLatestSelfCorrection, interpretScientific, rulesCanHandle, sanitizeModelLatex, sanitizeResult, stripKnownAsrBoilerplate } = require('../server/scientific-interpreter.js');
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
  ["V S est égal. R C fois d'érivé de V C par rapport au temps plus V C.", 'V_s = RC\\frac{dV_C}{dt} + V_C'],
  ['V S égale R C fois dérivée de V C par rapport aux temps plus V C', 'V_s = RC\\frac{dV_C}{dt} + V_C'],
  ['V R un égale R un fois i', 'V_{R1} = R_1i'],
  ['V R un égal R un fois i', 'V_{R1} = R_1i'],
  ['R équivalent égale R un fois R deux sur ouvre parenthèse R un plus R deux ferme parenthèse', 'R_{eq} = \\frac{R_1R_2}{\\left(R_1 + R_2\\right)}'],
  ['Z C égale un sur j oméga C', 'Z_C = \\frac{1}{j\\omega C}'],
  ['Z L égale j oméga L', 'Z_L = j\\omega L'],
  ['V L égale L fois dérivé de i par rapport au temps', 'V_L = L\\frac{di}{dt}'],
  ['Ensuite pour la bobine V L égale L fois dérivé de I par rapport au temps', 'V_L = L\\frac{dI}{dt}'],
  ['V C égale un sur C fois intégrale de I par rapport au temps', 'V_C = \\frac{1}{C}\\int I\\,dt'],
  ['Ensuite pour le condensateur V C égale à un sur C fois intégrale de I par rapport au temps', 'V_C = \\frac{1}{C}\\int I\\,dt'],
  ['U de t égale U max fois cosinus de oméga t plus phi', 'U\\left(t\\right) = U_{max}\\cos\\left(\\omega t + \\phi\\right)'],
  ['Puis le régime sinusoidal U de T égale U max fois cocinus de oméga T plus phi', 'U\\left(t\\right) = U_{max}\\cos\\left(\\omega t + \\phi\\right)'],
  ['P égale U fois I', 'P = UI'],
  ['U est égaler R', 'U = R'],
  ['La tension U est égale à la résistance R fois le courant I', 'U = RI'],
  ['D abord la tension U est égale à résistance R fois le courant I', 'U = RI'],
  ['La puissance P est égale à la tension U fois le courant I', 'P = UI'],
  ['La puissance P est égale à la résistance R fois le courant I au carré, pardon', 'P = RI^2'],
  ['Donc je disais la puissance P est égale à la résistance R fois le courant I', 'P = RI'],
  ['Et donc E est égale un demi C fois U au carré', 'E = \\frac{1}{2}CU^2'],
  ['E égale un demi C fois U au carré', 'E = \\frac{1}{2}CU^2'],
  ['Z égale R plus j ouvre parenthèse oméga L moins un sur oméga C ferme parenthèse', 'Z = R + j\\left(\\omega L - \\frac{1}{\\omega C}\\right)'],
  ['Z égale R puis j ouvre parenthèse oméga L moins un sur oméga C ferme parenthèse', 'Z = R + j\\left(\\omega L - \\frac{1}{\\omega C}\\right)'],
  ['zède égale R plus j ouvre parenthèse oméga L moins un sur oméga C ferme parenthèse', 'Z = R + j\\left(\\omega L - \\frac{1}{\\omega C}\\right)'],
  ['z majuscule égale R plus j ouvre parenthèse oméga L moins un sur oméga C ferme parenthèse', 'Z = R + j\\left(\\omega L - \\frac{1}{\\omega C}\\right)'],
  ['Z majuscule égale R plus j ouvre parenthèse oméga L moins un sur oméga C ferme parenthèse', 'Z = R + j\\left(\\omega L - \\frac{1}{\\omega C}\\right)'],
  ['Dèwer Z majuscule égale R', 'Z = R'],
  ['a plus b sur c', '\\frac{a + b}{c}'],
  ['donc là je mets VS égal VR plus VC', 'V_s = V_R + V_C'],
  ['attends non je voulais dire VR plus VC', 'V_R + V_C'],
  ['Attends non, je voulais dire V R plus V C.', 'V_R + V_C'],
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

const groundedModelOutput = sanitizeResult({ items: [
  { type: 'equation', latex: 'x^2 - 5x + 6 = 0', spoken: 'ancienne équation' },
  { type: 'equation', latex: 'x = \\frac{-b + \\sqrt{\\Delta}}{2a}', spoken: 'x égale moins b plus racine de delta sur deux a' },
] }, 'x égale moins b plus racine de delta sur deux a');
assert.strictEqual(groundedModelOutput.length, 1);
assert.strictEqual(groundedModelOutput[0].latex, 'x = \\frac{-b + \\sqrt{\\Delta}}{2a}');
console.log('[ok] le modèle ne peut pas recopier une ancienne équation du contexte');

assert.strictEqual(sanitizeModelLatex('U=R\times I'), 'U=R\\times I');
assert.strictEqual(sanitizeModelLatex('V_C=\frac{1}{C}\bigint I dt'), 'V_C=\\frac{1}{C}\\int I dt');
assert.throws(() => sanitizeModelLatex('Z=\\commande_inconnue{x}'));
console.log('[ok] le LaTeX JSON corrompu est réparé et toute commande invalide est refusée');

const boilerplateTranscript = "Z égale R plus j ouvre parenthèse oméga L moins un sur oméga C ferme parenthèse. Sous-titres réalisés par la communauté d'Amara.org";
assert.strictEqual(stripKnownAsrBoilerplate(boilerplateTranscript), 'Z égale R plus j ouvre parenthèse oméga L moins un sur oméga C ferme parenthèse');
assert.strictEqual(extractLatestSelfCorrection('U est égal à, attends, U est égal à R fois I'), 'U est égal à R fois I');
assert.strictEqual(extractLatestSelfCorrection('U égale R, en fait U égale R fois I'), 'U égale R fois I');
assert.strictEqual(
  extractLatestSelfCorrection('Je cherche le circuit. D abord Z égale R. Ensuite oméga zé. Oméga. Attends. Oméga zéro égale un sur racine de L fois C. Enfin I égale U sur R.'),
  'Je cherche le circuit. D abord Z égale R. Oméga zéro égale un sur racine de L fois C. Enfin I égale U sur R.',
);
interpretScientific(boilerplateTranscript, {}, { forceRules: true }).then((filtered) => {
  assert.strictEqual(filtered.items.length, 1);
  assert.strictEqual(filtered.items[0].latex, 'Z = R + j\\left(\\omega L - \\frac{1}{\\omega C}\\right)');
  console.log('[ok] la signature de sous-titrage hallucinée par Whisper est filtrée');
});
interpretScientific('U est égal à, attends, U est égal à R fois I', {}, { forceRules: true }).then((repaired) => {
  assert.strictEqual(repaired.items.length, 1);
  assert.strictEqual(repaired.items[0].latex, 'U = RI');
console.log('[ok] une auto-correction orale remplace le faux départ');
});

const longReflection = deterministicInterpret("Je cherche l'impédance d'un circuit RLC série. D'abord Z majuscule égale R plus j ouvre parenthèse oméga L moins un sur oméga C ferme parenthèse. Ensuite à la résonance oméga zéro égale un sur racine de ouvre parenthèse L fois C ferme parenthèse. La partie imaginaire devient nulle donc Z majuscule égale R enfin le courant I égale U sur R.");
assert.strictEqual(longReflection.complete, true);
assert.deepStrictEqual(longReflection.items.map((item) => item.latex || item.text), [
  "Je cherche l'impédance d'un circuit RLC série",
  'Z = R + j\\left(\\omega L - \\frac{1}{\\omega C}\\right)',
  '\\omega_0 = \\frac{1}{\\sqrt{LC}}',
  'La partie imaginaire devient nulle',
  'Z = R',
  'I = \\frac{U}{R}',
]);
console.log('[ok] une réflexion longue est découpée en texte et équations successives');

const naturalWhisperList = deterministicInterpret('U est égaler R, puis P est égaler R, puis V C est égaler 1 sur C fois intégrale de I par rapport au temps. Ensuite V L est égaler L fois dérivé de I par rapport au temps. Et finalement Z est égaler R plus j fois ouvrir parenthèse oméga L moins un sur oméga C ferme parenthèse.');
assert.strictEqual(naturalWhisperList.complete, true);
assert.deepStrictEqual(naturalWhisperList.items.map((item) => item.latex || item.text), [
  'U = R',
  'P = R',
  'V_C = \\frac{1}{C}\\int I\\,dt',
  'V_L = L\\frac{dI}{dt}',
  'Z = R + j\\left(\\omega L - \\frac{1}{\\omega C}\\right)',
]);
console.log('[ok] la liste naturelle transcrite avec « égaler » reste une suite d’équations');

interpretScientific("Je cherche l'impédance d'un circuit RLC série. D abord Z majuscule égale R plus j ouvre parenthèse oméga L moins un sur oméga C ferme parenthèse. Ensuite à la résonance oméga zé. Oméga. Attends. Oméga zéro égale un sur racine de ouvre parenthèse L fois C ferme parenthèse. La partie imaginaire devient nulle. Donc Z majuscule égale R. Enfin le courant I égale U sur R.", {}, { forceRules: true }).then((longRepair) => {
  assert.strictEqual(longRepair.complete, true);
  assert.deepStrictEqual(longRepair.items.map((item) => item.latex || item.text), [
    "Je cherche l'impédance d'un circuit RLC série",
    'Z = R + j\\left(\\omega L - \\frac{1}{\\omega C}\\right)',
    '\\omega_0 = \\frac{1}{\\sqrt{LC}}',
    'La partie imaginaire devient nulle',
    'Z = R',
    'I = \\frac{U}{R}',
  ]);
  console.log('[ok] une reprise au milieu conserve les étapes précédentes et suivantes');
});

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
