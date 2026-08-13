// Interprète une transcription scientifique française sans la corriger.
// Les règles ne sont choisies que lorsqu'un parse AST complet est démontré.

const { parseSpokenMath } = require('./spoken-math-parser.js');

const DEFAULT_MODEL = process.env.TABLEAU_LOCAL_MODEL || 'qwen3:1.7b';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

const SYSTEM_PROMPT = `Tu convertis une dictée scientifique française en JSON, sans résoudre ni corriger.
Retourne {"items":[{"type":"equation","latex":"...","spoken":"...","ambiguity":null}]} ou type "text" avec "text".
Découpe les phrases successives. Respecte même une formule physiquement fausse. VS, VR, VC deviennent V_s, V_R, V_C. N'invente jamais d'ambiguïté : null sauf si deux portées syntaxiques sont réellement possibles. Exemples: "VS est égal à VR plus VC" -> V_s = V_R + V_C; "i est égal à C fois dérivée de VC par rapport au temps" -> i = C\\frac{dV_C}{dt}. Aucun commentaire.`;

function normalizeSpeech(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function splitStatements(text) {
  return normalizeSpeech(text).split(/(?:[.!?;]+|\n+)/).map((part) => part.trim()).filter(Boolean);
}

function hasMathIntent(text) {
  return /(?:\b(?:egal|egale|plus|moins|fois|sur|exposant|carre|cube|racine|derivee|parenthese)\b|=)/i
    .test(text.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
}

function plainTextItem(spoken, ambiguity = null) {
  return { type: 'text', text: spoken.charAt(0).toUpperCase() + spoken.slice(1), spoken, ambiguity };
}

function deterministicInterpret(text) {
  const parses = [];
  const items = splitStatements(text).map((spoken) => {
    if (!hasMathIntent(spoken)) {
      parses.push({ spoken, complete: true, kind: 'text', reason: 'no_math_intent' });
      return plainTextItem(spoken);
    }
    const parsed = parseSpokenMath(spoken);
    parses.push({ spoken, ...parsed });
    if (!parsed.complete) {
      return plainTextItem(spoken, {
        alternatives: [], reason: parsed.reason || 'unparsed_tokens',
        unparsedTokens: parsed.unparsedTokens || [],
      });
    }
    return { type: 'equation', latex: parsed.latex, spoken, ambiguity: parsed.ambiguity || null };
  });
  const complete = parses.every((parse) => parse.complete);
  return {
    items,
    engine: complete ? 'rules' : 'fallback',
    confidence: complete ? 1 : 0,
    complete,
    reason: complete ? 'complete_parse' : (parses.find((parse) => !parse.complete)?.reason || 'unparsed_tokens'),
    structuredParse: parses,
  };
}

function addTimingEvidence(result, segments) {
  const timedTokens = (segments || []).flatMap((segment) => segment.tokens || []).map((token) => ({
    text: normalizeSpeech(token.text || token.token || ''),
    from: token.offsets?.from ?? token.t0 ?? token.start,
    to: token.offsets?.to ?? token.t1 ?? token.end,
  })).filter((token) => token.text && Number.isFinite(token.from) && Number.isFinite(token.to));
  if (!timedTokens.length) return result;
  let strongest = null;
  for (let index = 1; index < timedTokens.length; index++) {
    if (!/^(?:plus|moins|\+|-)$/.test(timedTokens[index].text.toLowerCase())) continue;
    const pause = timedTokens[index].from - timedTokens[index - 1].to;
    if (!strongest || pause > strongest.pauseBeforeOperator) strongest = { operator: timedTokens[index].text, pauseBeforeOperator: pause };
  }
  if (!strongest || strongest.pauseBeforeOperator < 250) return result;
  return {
    ...result,
    items: result.items.map((item) => item.ambiguity?.reason === 'exponent_scope'
      ? { ...item, ambiguity: { ...item.ambiguity, timingEvidence: strongest, preferredAlternative: 0 } }
      : item),
  };
}

function rulesCanHandle(text) {
  if (!normalizeSpeech(text)) return false;
  return deterministicInterpret(text).complete;
}

function sanitizeResult(value, rawText) {
  const sourceItems = value && Array.isArray(value.items) ? value.items : [];
  const items = sourceItems.map((item) => {
    const spoken = normalizeSpeech(item.spoken || rawText);
    if (item.type === 'equation' && typeof item.latex === 'string' && item.latex.trim()) {
      const latex = item.latex.trim().replace(/∫/g, '\\int ').replace(/Δ/g, '\\Delta ').replace(/²/g, '^2').replace(/³/g, '^3');
      return { type: 'equation', latex, spoken, ambiguity: item.ambiguity || null };
    }
    if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
      return { type: 'text', text: item.text.trim(), spoken, ambiguity: item.ambiguity || null };
    }
    return null;
  }).filter(Boolean);
  if (!items.length) throw new Error('Réponse locale vide ou invalide');
  return items;
}

async function interpretWithOllama(text, context, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 20_000);
  try {
    const response = await fetch(`${options.baseUrl || OLLAMA_URL}/api/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({
        model: options.model || DEFAULT_MODEL, system: SYSTEM_PROMPT,
        prompt: `Dictée: ${normalizeSpeech(text)}\nContexte structuré: ${JSON.stringify(context || {})}`,
        stream: false, format: 'json', think: false, keep_alive: options.keepAlive == null ? 0 : options.keepAlive,
        options: { temperature: 0, num_predict: 320, num_ctx: 2048 },
      }),
    });
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
    const payload = await response.json();
    return {
      items: sanitizeResult(JSON.parse(payload.response), text), engine: options.model || DEFAULT_MODEL,
      confidence: null, complete: true, reason: 'rules_incomplete_model_fallback', structuredParse: null,
    };
  } finally { clearTimeout(timer); }
}

async function interpretScientific(text, context, options = {}) {
  if (!normalizeSpeech(text)) return { items: [], engine: 'none', complete: true, reason: 'empty' };
  const deterministic = addTimingEvidence(deterministicInterpret(text), context && context.segments);
  if (options.forceRules || (!options.forceModel && deterministic.complete)) return deterministic;
  if (!options.forceRules) {
    try {
      const modeled = await interpretWithOllama(text, context, options);
      return { ...modeled, routing: { rules: deterministic.structuredParse, reason: deterministic.reason } };
    } catch (error) {
      if (options.requireModel) throw error;
      return {
        ...deterministic,
        engine: 'fallback', complete: false,
        reason: `model_unavailable_after_${deterministic.reason}`,
        modelError: error.message,
      };
    }
  }
  return deterministic;
}

module.exports = {
  DEFAULT_MODEL, SYSTEM_PROMPT, deterministicInterpret, hasMathIntent, interpretWithOllama,
  interpretScientific, normalizeSpeech, rulesCanHandle,
};
