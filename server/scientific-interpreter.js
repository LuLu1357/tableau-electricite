// Interprète une transcription scientifique française sans la corriger.
// Les règles ne sont choisies que lorsqu'un parse AST complet est démontré.

const { parseSpokenMath } = require('./spoken-math-parser.js');
const katex = require('../web/vendor/katex/katex.min.js');

const DEFAULT_MODEL = process.env.TABLEAU_LOCAL_MODEL || 'qwen3:1.7b';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

const SYSTEM_PROMPT = `Tu convertis une dictée scientifique française en JSON, sans résoudre ni corriger.
Retourne {"items":[{"type":"equation","latex":"...","spoken":"...","ambiguity":null}]} ou type "text" avec "text".
Découpe les phrases successives. Respecte même une formule physiquement fausse. VS, VR, VC deviennent V_s, V_R, V_C. N'invente jamais d'ambiguïté : null sauf si deux portées syntaxiques sont réellement possibles. Exemples: "VS est égal à VR plus VC" -> V_s = V_R + V_C; "i est égal à C fois dérivée de VC par rapport au temps" -> i = C\\frac{dV_C}{dt}. Aucun commentaire.`;

function normalizeSpeech(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function stripKnownAsrBoilerplate(text) {
  // whisper.cpp peut halluciner cette signature de sous-titrage dans le
  // silence de fin. Elle ne provient jamais d'une dictée scientifique.
  return normalizeSpeech(text).replace(
    /\s*[.!?;:]?\s*sous[- ]titres\s+r[ée]alis[ée]s\s+par\s+la\s+communaut[ée]\s+d['’]amara(?:\.org)?\b.*$/i,
    '',
  ).trim();
}

function extractLatestSelfCorrection(text) {
  const speech = normalizeSpeech(text);
  const marker = /\b(?:attends?(?:\s+non)?|non|en\s+fait|je\s+me\s+reprends|pardon(?:\s*,?\s*je\s+(?:me\s+)?reprends)?)(?:\s*,?\s*(?:je\s+voulais\s+dire\s+)?)?/gi;
  let match;
  let latest = null;
  while ((match = marker.exec(speech))) {
    const remainder = speech.slice(marker.lastIndex).replace(/^[\s,;:.!?-]+/, '').trim();
    if (hasMathIntent(remainder)) latest = { start: match.index, end: marker.lastIndex, remainder };
  }
  if (!latest) return speech;

  const before = speech.slice(0, latest.start);
  // Dans un raisonnement, un connecteur marque le début de l'étape en cours :
  // la reprise ne doit pas effacer les étapes précédentes.
  const cues = [...before.matchAll(/\b(?:d['’]?\s*abord|ensuite|donc|enfin)\b/gi)];
  let scopeStart = cues.length ? cues[cues.length - 1].index : 0;
  if (!cues.length) {
    const boundaries = [...before.matchAll(/[.!?;]+\s*/g)];
    if (boundaries.length) {
      const last = boundaries[boundaries.length - 1];
      const markerStartsNewStatement = before.slice(last.index + last[0].length).trim() === '';
      const chosen = markerStartsNewStatement ? boundaries[boundaries.length - 2] : last;
      scopeStart = chosen ? chosen.index + chosen[0].length : 0;
    }
  }
  return normalizeSpeech(`${speech.slice(0, scopeStart)} ${latest.remainder}`);
}

function splitStatements(text, options = {}) {
  // Apple Speech ponctue parfois une variable épelée comme « X. Au carré »
  // ou « Z. C. égal ». Cette ponctuation n'est pas une frontière de phrase.
  let normalized = normalizeSpeech(text);
  if (options.source === 'apple') {
    normalized = normalized
      .replace(/\b([A-Za-z])\.\s*([A-Za-z])\.\s*(?=(?:est\s+)?égal)/gi, '$1 $2 ')
      .replace(/\b([A-Za-z])\.\s*(?=(?:au\s+carr[ée]|prime\b|(?:est\s+)?égal))/gi, '$1 ');
  }

  // Whisper insère parfois une fin de phrase après « est égal » quand le
  // locuteur marque une courte pause. Une égalité sans membre droit n'est pas
  // une vraie frontière : on rattache donc la suite avant de découper.
  const joinedEquality = normalized
    .replace(/\b(est\s+égal(?:e|er)?|égal(?:e|er)?)\s*[.!?;:]+\s*/gi, '$1 ')
    .replace(/=\s*[.!?;:]+\s*/g, '= ')
    // Dans une liste d'équations, « virgule puis P est égal... » commence une
    // nouvelle formule. Un « puis » interne à une formule reste un plus oral.
    .replace(/,\s*puis\s+(?=(?:[A-Z](?:\s+[A-Z])?|[a-zA-Z]+)\s+est\s+égal(?:e|er)?\b)/g, '. ')
    // Sur une réflexion longue, Whisper omet parfois la ponctuation entre
    // une conclusion et l'équation suivante. Ces connecteurs indiquent une
    // vraie nouvelle ligne sans modifier le contenu scientifique.
    .replace(/\s+donc\s+(?=(?:Z|zède)\b)/gi, '. donc ')
    .replace(/\s+enfin\s+(?=(?:(?:le\s+courant\s+)?I|(?:Z|zède)(?:\s+majuscule)?)\b)/gi, '. enfin ');
  return joinedEquality.split(/(?:[.!?;]+|\n+)/).map((part) => part.trim()).filter(Boolean);
}

function hasMathIntent(text) {
  return /(?:\b(?:egal|egale|egaler|plus|moins|fois|sur|exposant|carre|cube|racine|derivee|integrale|cosinus|parenthese)\b|=)/i
    .test(text.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
}

function plainTextItem(spoken, ambiguity = null) {
  return { type: 'text', text: spoken.charAt(0).toUpperCase() + spoken.slice(1), spoken, ambiguity };
}

function sanitizeModelLatex(value) {
  const latex = String(value || '')
    // Un modèle peut renvoyer du JSON avec « \frac » au lieu de « \\frac » :
    // JSON.parse transforme alors \f, \b et \t en caractères de contrôle.
    .replace(/\u0008/g, '\\b')
    .replace(/\u000c/g, '\\f')
    .replace(/\t/g, '\\t')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\bigint\b/g, '\\int')
    .replace(/∫/g, '\\int ').replace(/Δ/g, '\\Delta ').replace(/²/g, '^2').replace(/³/g, '^3')
    .trim();
  if (!latex || /[\u0000-\u001f\u007f]/.test(latex)) throw new Error('LaTeX local corrompu');
  katex.renderToString(latex, { throwOnError: true, displayMode: false });
  return latex;
}

function deterministicInterpret(text, options = {}) {
  const parses = [];
  const statements = splitStatements(text, options);
  const items = statements.map((spoken) => {
    if (!hasMathIntent(spoken)) {
      parses.push({ spoken, complete: true, kind: 'text', reason: 'no_math_intent' });
      return plainTextItem(spoken);
    }
    const parsed = parseSpokenMath(spoken, options);
    parses.push({ spoken, ...parsed });
    if (!parsed.complete) {
      return plainTextItem(spoken, {
        alternatives: [], reason: parsed.reason || 'unparsed_tokens',
        unparsedTokens: parsed.unparsedTokens || [],
      });
    }
    return { type: 'equation', latex: parsed.latex, spoken, ambiguity: parsed.ambiguity || null };
  });
  if (items.length === 1) items[0].spoken = normalizeSpeech(text);
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
    const comparable = (input) => normalizeSpeech(input).normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const rawComparable = comparable(rawText);
    const spokenComparable = comparable(spoken);
    // Le contexte du tableau sert de vocabulaire, jamais de contenu à recopier.
    // Écarter toute ligne dont la provenance orale n'existe pas dans la dictée.
    if (spokenComparable && !rawComparable.includes(spokenComparable) && !spokenComparable.includes(rawComparable)) return null;
    if (item.type === 'equation' && typeof item.latex === 'string' && item.latex.trim()) {
      const latex = sanitizeModelLatex(item.latex);
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
        // Les anciennes équations du tableau ne doivent jamais devenir une
        // source de contenu. Le modèle reçoit uniquement la dictée courante.
        prompt: `Dictée: ${normalizeSpeech(text)}\nN'utilise et ne recopie aucune autre ligne du tableau.`,
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
  const cleanedText = extractLatestSelfCorrection(stripKnownAsrBoilerplate(text));
  if (!cleanedText) return { items: [], engine: 'none', complete: true, reason: 'empty' };
  const deterministic = addTimingEvidence(deterministicInterpret(cleanedText, { source: options.source }), context && context.segments);
  if (options.forceRules || (!options.forceModel && deterministic.complete)) return deterministic;
  // Une longue prise peut être arrêtée au milieu de sa dernière formule.
  // Conserver les étapes déjà comprises évite que le modèle invente la fin.
  const failedParses = (deterministic.structuredParse || []).filter((parse) => !parse.complete);
  const onlyFailure = failedParses.length === 1 ? failedParses[0] : null;
  const trailingToken = onlyFailure?.unparsedTokens?.at(-1) || onlyFailure?.tokens?.at(-1);
  const consumedToEnd = onlyFailure && onlyFailure.consumed === onlyFailure.total;
  if (!options.forceModel && onlyFailure && consumedToEnd && ['=', 'plus', 'moins', 'fois', 'sur', '('].includes(trailingToken)) {
    return { ...deterministic, engine: 'rules_partial', reason: 'truncated_final_expression' };
  }
  if (!options.forceRules) {
    try {
      const modeled = await interpretWithOllama(cleanedText, context, options);
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
  interpretScientific, normalizeSpeech, rulesCanHandle, sanitizeResult, stripKnownAsrBoilerplate,
  extractLatestSelfCorrection, sanitizeModelLatex,
};
