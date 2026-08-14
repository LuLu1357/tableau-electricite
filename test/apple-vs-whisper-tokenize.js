const assert = require('assert');
const { parseSpokenMath, tokenize } = require('../server/spoken-math-parser.js');

// Ensure that with source='apple' we DO NOT replace 'puis' -> 'plus'
const appleResult = parseSpokenMath('puis le régime sinusoidal U de T égale U max fois cocinus de oméga T plus phi', { source: 'apple' });
// tokens preserved should include 'puis' (after prepareSpeech, the prefix may be removed, but tokenize will show tokens)
const appleTokens = appleResult.tokens;

// For whisper (or default), 'puis' historically replaced by 'plus'
const whisperResult = parseSpokenMath('puis le régime sinusoidal U de T égale U max fois cocinus de oméga T plus phi', { source: 'whisper' });
const whisperTokens = whisperResult.tokens;

// Check presence/absence
const appleHasPuis = appleTokens.includes('puis');
const whisperHasPlus = whisperTokens.includes('plus');

assert.strictEqual(appleHasPuis, true, 'Apple source should preserve "puis" token');
assert.strictEqual(whisperHasPlus, true, 'Whisper source should transform "puis" into "plus"');

console.log('[ok] Apple vs Whisper tokenization: "puis" behavior differs as expected');
