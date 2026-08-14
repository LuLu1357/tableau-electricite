const assert = require('assert');
const { parseSpokenMath, tokenize } = require('../server/spoken-math-parser.js');

// Ensure that with source='apple' we DO NOT replace 'puis' -> 'plus'
// Use a phrase where 'puis' appears mid-sentence so it is not stripped by discourse-prefix rules.
const sample = 'U de t est egal a U max fois cocinus, puis on ajoute phi';
const appleResult = parseSpokenMath(sample, { source: 'apple' });
const appleTokens = appleResult.tokens;

// For whisper (or default), 'puis' historically replaced by 'plus'
const whisperResult = parseSpokenMath(sample, { source: 'whisper' });
const whisperTokens = whisperResult.tokens;

// Check that Apple did not convert to 'plus' while Whisper did
const appleHasPlus = appleTokens.includes('plus');
const whisperHasPlus = whisperTokens.includes('plus');

assert.strictEqual(appleHasPlus, false, 'Apple source should NOT transform "puis" into "plus"');
assert.strictEqual(whisperHasPlus, true, 'Whisper source should transform "puis" into "plus"');

console.log('[ok] Apple vs Whisper tokenization: "puis" behavior differs as expected');
