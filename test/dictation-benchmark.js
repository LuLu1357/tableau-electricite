const fs = require('fs');
const path = require('path');
const { deterministicInterpret, normalizeSpeech } = require('../server/scientific-interpreter.js');

const RESULT_PATH = path.join(__dirname, 'dictation-benchmark-results.json');

const benchmarkCases = [
  {
    expectedPhrase: 'VS est égal à VR plus VC',
    rawTranscript: 'VS est égal à VR plus VC',
    expectedLatex: 'V_s = V_R + V_C',
    errorType: 'autre',
  },
  {
    expectedPhrase: 'la tension U est égale à la résistance R fois le courant I',
    rawTranscript: 'la tension U est égale à la résistance R fois le courant I',
    expectedLatex: 'U = RI',
    errorType: 'autre',
  },
  {
    expectedPhrase: 'i est égal à C fois dérivée de VC par rapport au temps',
    rawTranscript: 'i est égal à C fois dérivée de VC par rapport au temps',
    expectedLatex: 'i = C\\frac{dV_C}{dt}',
    errorType: 'autre',
  },
  {
    expectedPhrase: 'la puissance P est égale à R fois I au carré',
    rawTranscript: 'la puissance P est égale à R fois I au carré',
    expectedLatex: 'P = RI^2',
    errorType: 'autre',
  },
  {
    expectedPhrase: 'Z est égal à R plus j oméga L moins un sur oméga C',
    rawTranscript: 'Z est égal à R plus j omega L moins un sur omega C',
    expectedLatex: 'Z = R + j\\left(\\omega L - \\frac{1}{\\omega C}\\right)',
    errorType: 'symbole scientifique',
  },
  {
    expectedPhrase: 'VR un est égal à R un fois I',
    rawTranscript: 'VR un est égal à R un fois I',
    expectedLatex: 'V_{R1} = R_1I',
    errorType: 'autre',
  },
  {
    expectedPhrase: 'VC deux est égal à un sur C deux fois intégrale de I',
    rawTranscript: 'VC deux est égal à un sur C deux fois intégrale de I',
    expectedLatex: 'V_{C2} = \\frac{1}{C_2}\\int I\\,dt',
    errorType: 'indice',
  },
  {
    expectedPhrase: 'x au carré plus y au carré égale z au carré',
    rawTranscript: 'x au carré plus y au carré égale z au carré',
    expectedLatex: 'x^2 + y^2 = z^2',
    errorType: 'autre',
  },
  {
    expectedPhrase: 'U max au carré',
    rawTranscript: 'U maxi au carré',
    expectedLatex: 'U_{max}^2',
    errorType: 'exposant',
  },
  {
    expectedPhrase: 'I puissance deux',
    rawTranscript: 'I puissance deux',
    expectedLatex: 'I^2',
    errorType: 'autre',
  },
  {
    expectedPhrase: 'delta est égal à b au carré moins quatre a c',
    rawTranscript: 'delta est égal à b au carré moins quatre a c',
    expectedLatex: '\\Delta = b^2 - 4ac',
    errorType: 'autre',
  },
  {
    expectedPhrase: 'oméga égale deux pi fois la fréquence',
    rawTranscript: 'omega égale deux pi fois la fréquence',
    expectedLatex: '\\omega = 2\\pi f',
    errorType: 'symbole scientifique',
  },
  {
    expectedPhrase: 'résistance de dix kilo ohms',
    rawTranscript: 'résistance de dix kilo omes',
    expectedLatex: 'R = 10\\,k\\Omega',
    errorType: 'unité',
  },
  {
    expectedPhrase: 'condensateur de cent micro farads',
    rawTranscript: 'condensateur de cent micro farads',
    expectedLatex: 'C = 100\\,\\mu F',
    errorType: 'unité',
  },
  {
    expectedPhrase: 'bobine de dix milli henrys',
    rawTranscript: 'bobine de dix milli henries',
    expectedLatex: 'L = 10\\,mH',
    errorType: 'unité',
  },
];

function normalizeLatexForCompare(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function detectDifference(expected, actual) {
  const expectedS = normalizeLatexForCompare(expected);
  const actualS = normalizeLatexForCompare(actual);
  if (!expectedS && !actualS) return '';
  return expectedS === actualS ? '' : `attendu: ${expectedS} | obtenu: ${actualS}`;
}

function classifyError(sample, actualLatex) {
  const haystack = `${sample.expectedPhrase} ${sample.rawTranscript} ${actualLatex}`.toLowerCase();
  if (/(omega|oméga|delta|pi|theta|lambda|mu)/.test(haystack) && /(omega|oméga)/.test(haystack)) return 'symbole scientifique';
  if (/(r\s*un|c\s*deux|v\s*r\s*un|v\s*c\s*deux|indice|sous indice|indice perdu)/.test(haystack)) return 'indice';
  if (/(carre|carré|cube|puissance|exposant|au carré|au cube)/.test(haystack)) return 'exposant';
  if (/(kilo|micro|milli|ohm|farad|henry|ohms|farads|henrys|µ|micro)/.test(haystack)) return 'unité';
  if (actualLatex && actualLatex !== sample.expectedLatex) return 'interprétation mathématique';
  return 'reconnaissance vocale';
}

function buildBenchmarkResults() {
  return benchmarkCases.map((sample) => {
    const cleanedTranscript = normalizeSpeech(sample.rawTranscript);
    const interpreted = deterministicInterpret(cleanedTranscript);
    const latexObtained = interpreted.items.map((item) => item.latex || item.text).join(' ');
    const differenceDetected = detectDifference(sample.expectedLatex, latexObtained);
    const errorType = differenceDetected ? classifyError(sample, latexObtained) : sample.errorType;

    return {
      phraseAttendue: sample.expectedPhrase,
      transcriptionAppleSpeechBrute: sample.rawTranscript,
      transcriptionNettoyee: cleanedTranscript,
      resultatLatexObtenu: latexObtained,
      resultatAttendu: sample.expectedLatex,
      differenceDetectee: differenceDetected,
      typeErreur: errorType,
    };
  });
}

function printSummary(results) {
  const total = results.length;
  const success = results.filter((result) => !result.differenceDetectee).length;
  const failures = total - success;
  const counts = {};

  for (const result of results) {
    if (!result.differenceDetectee) continue;
    const key = result.typeErreur || 'autre';
    counts[key] = (counts[key] || 0) + 1;
  }

  console.log('DICTATION BENCHMARK');
  console.log('-------------------');
  console.log(`Tests : ${total}`);
  console.log(`Réussis : ${success}`);
  console.log(`Échecs : ${failures}`);
  console.log('');
  console.log('Erreurs principales :');
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!top.length) {
    console.log('- aucune erreur détectée');
  } else {
    for (const [label, count] of top) {
      console.log(`- ${label}: ${count}`);
    }
  }
  console.log('');
  console.log('Le fichier JSON complet est disponible dans :');
  console.log('test/dictation-benchmark-results.json');
}

function main() {
  const results = buildBenchmarkResults();
  fs.writeFileSync(RESULT_PATH, `${JSON.stringify(results, null, 2)}\n`);
  printSummary(results);
}

if (require.main === module) {
  main();
}

module.exports = {
  benchmarkCases,
  buildBenchmarkResults,
  RESULT_PATH,
};
