// Interprète une transcription scientifique française sans la corriger.
// Le chemin normal utilise un très petit modèle local via Ollama. Le parseur
// déterministe reste volontairement limité : il sert de filet de sécurité et
// rend les constructions élémentaires testables sans modèle téléchargé.

const DEFAULT_MODEL = process.env.TABLEAU_LOCAL_MODEL || 'qwen3:1.7b';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

const SYSTEM_PROMPT = `Tu convertis une dictée scientifique française en JSON, sans résoudre ni corriger.
Retourne {"items":[{"type":"equation","latex":"...","spoken":"...","ambiguity":null}]} ou type "text" avec "text".
Découpe les phrases successives. Respecte même une formule physiquement fausse. VS, VR, VC deviennent V_s, V_R, V_C. N'invente jamais d'ambiguïté : null sauf si deux portées syntaxiques sont réellement possibles. Exemples: "VS est égal à VR plus VC" -> V_s = V_R + V_C; "i est égal à C fois dérivée de VC par rapport au temps" -> i = C\\frac{dV_C}{dt}. Aucun commentaire.`;

function normalizeSpeech(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function splitStatements(text) {
  return normalizeSpeech(text)
    .split(/(?:[.!?;]+|\n+)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function symbol(raw) {
  const compact = raw.trim().replace(/\s+/g, '');
  if (/^delta$/i.test(compact)) return '\\Delta';
  if (/^[Vv][SsRrCc]$/.test(compact)) {
    const index = compact[1].toUpperCase() === 'S' ? 's' : compact[1].toUpperCase();
    return `V_${index}`;
  }
  if (/^[A-Za-z]$/.test(compact)) return compact;
  return compact.replace(/[^A-Za-z0-9_\\]/g, '');
}

function parseSide(raw) {
  let side = raw.trim();
  const derivative = /^([A-Za-z][A-Za-z0-9]*)\s+fois\s+d[ée]riv[ée]e?\s+de\s+([A-Za-z][A-Za-z0-9]*)\s+par\s+rapport\s+au\s+temps$/i.exec(side);
  if (derivative) return `${symbol(derivative[1])}\\frac{d${symbol(derivative[2])}}{dt}`;

  const numberWords = { un: '1', une: '1', deux: '2', trois: '3', quatre: '4', cinq: '5', six: '6', sept: '7', huit: '8', neuf: '9', dix: '10' };
  side = side.replace(/\b(un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\b/gi, (word) => numberWords[word.toLowerCase()]);
  side = side.replace(/\b([A-Za-z][A-Za-z0-9]*)\s+au\s+carr(?:é|e)/gi, (_, name) => `${symbol(name)}^2`);
  side = side.replace(/\b([A-Za-z][A-Za-z0-9]*)\s+exposant\s+(-?\d+)\b/gi, (_, name, exponent) => `${symbol(name)}^{${exponent}}`);
  side = side.replace(/\bmoins\b/gi, ' - ').replace(/\bplus\b/gi, ' + ');
  side = side.replace(/\b(\d+)\s+fois\s+([A-Za-z][A-Za-z0-9]*(?:\^\{?\d+\}?)?)/gi, '$1$2');
  side = side.replace(/\b([A-Za-z][A-Za-z0-9]*)\s+fois\s+([A-Za-z][A-Za-z0-9]*)\b/gi, (_, a, b) => `${symbol(a)}${symbol(b)}`);
  side = side.replace(/\b4\s+a\s+c\b/gi, '4ac');
  side = side.replace(/\bd\s*([A-Za-z][A-Za-z0-9]*)\s+sur\s+d\s*t\b/gi, (_, name) => `\\frac{d${symbol(name)}}{dt}`);
  side = side.replace(/\bd\s*([A-Za-z][A-Za-z0-9]*)\s+sur\s+dt\b/gi, (_, name) => `\\frac{d${symbol(name)}}{dt}`);
  side = side.replace(/\s+/g, ' ').trim();
  return side.split(' ').map((token) => {
    if (/^[A-Za-z][A-Za-z0-9]*$/.test(token)) return symbol(token);
    return token;
  }).join(' ').replace(/\s*([+\-=])\s*/g, ' $1 ').trim();
}

function deterministicInterpret(text) {
  const items = splitStatements(text).map((spoken) => {
    const equality = /^(.*?)\s+(?:est\s+)?(?:[ée]gal(?:e)?\s+[àa]|[ée]gale?)\s+(.*)$/i.exec(spoken);
    if (!equality) {
      if (/(?:au carr(?:é|e)|\bexposant\b|\bplus\b|\bmoins\b|\bfois\b)/i.test(spoken)) {
        const latex = parseSide(spoken);
        const item = { type: 'equation', latex, spoken, ambiguity: null };
        if (/\bexposant\b/i.test(spoken) && /\bplus\b/i.test(spoken)) {
          item.ambiguity = {
            alternatives: [latex, 'x^2 + 2x^{3+5}'],
            reason: "La portée orale de l'exposant n'est pas explicite.",
          };
        }
        return item;
      }
      return { type: 'text', text: spoken.charAt(0).toUpperCase() + spoken.slice(1), spoken, ambiguity: null };
    }
    const left = symbol(equality[1]);
    const right = parseSide(equality[2]);
    const item = { type: 'equation', latex: `${left} = ${right}`, spoken, ambiguity: null };
    return item;
  });
  return { items, engine: 'rules' };
}

function rulesCanHandle(text) {
  return splitStatements(text).every((spoken) => {
    if (!/(?:[ée]gal|[ée]gale)/i.test(spoken)) {
      return !/(?:\bint[ée]grale?\b|\bracine\b|\blimite\b|\bsomme\b|\bmatrice\b)/i.test(spoken);
    }
    return /(?:\bplus\b|\bmoins\b|\bfois\b|\bsur\b|\bd[ée]riv|\bau carr(?:é|e)\b|\bexposant\b)/i.test(spoken);
  });
}

function sanitizeResult(value, rawText) {
  const sourceItems = value && Array.isArray(value.items) ? value.items : [];
  const items = sourceItems.map((item) => {
    const spoken = normalizeSpeech(item.spoken || rawText);
    if (item.type === 'equation' && typeof item.latex === 'string' && item.latex.trim()) {
      const latex = item.latex.trim()
        .replace(/∫/g, '\\int ')
        .replace(/Δ/g, '\\Delta ')
        .replace(/²/g, '^2')
        .replace(/³/g, '^3');
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
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: options.model || DEFAULT_MODEL,
        system: SYSTEM_PROMPT,
        prompt: `Dictée: ${normalizeSpeech(text)}\nContexte structuré: ${JSON.stringify(context || {})}`,
        stream: false,
        format: 'json',
        think: false,
        keep_alive: 0,
        options: { temperature: 0, num_predict: 320, num_ctx: 2048 },
      }),
    });
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
    const payload = await response.json();
    return { items: sanitizeResult(JSON.parse(payload.response), text), engine: options.model || DEFAULT_MODEL };
  } finally {
    clearTimeout(timer);
  }
}

async function interpretScientific(text, context, options = {}) {
  if (!normalizeSpeech(text)) return { items: [], engine: 'none' };
  if (options.forceRules || (!options.forceModel && rulesCanHandle(text))) return deterministicInterpret(text);
  if (!options.forceRules) {
    try {
      return await interpretWithOllama(text, context, options);
    } catch (error) {
      if (options.requireModel) throw error;
    }
  }
  return deterministicInterpret(text);
}

module.exports = {
  DEFAULT_MODEL,
  SYSTEM_PROMPT,
  deterministicInterpret,
  interpretWithOllama,
  interpretScientific,
  normalizeSpeech,
  rulesCanHandle,
};
