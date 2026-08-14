// Petit parseur de notation mathématique orale française.
// Important : un résultat n'est accepté que si tous les tokens significatifs
// ont été consommés. Il ne résout ni ne corrige jamais l'expression dictée.

const NUMBER_WORDS = new Map(Object.entries({
  zero: '0', un: '1', une: '1', deux: '2', trois: '3', quatre: '4', cinq: '5',
  six: '6', sept: '7', huit: '8', neuf: '9', dix: '10', onze: '11', douze: '12',
}));

const DISCOURSE_PREFIXES = [
  /^d(?:['’]\s*|\s+)abord\s+/i,
  // Variante réellement produite par Whisper pour « donc » dans une dictée
  // longue. On ne la retire que devant un Z explicitement dicté.
  /^d[eè]wer\s+(?=(?:Z|zède)\b)/i,
  /^ensuite\s+(?:(?:[aà]\s+la\s+r[ée]sonance|pour\s+le\s+condensateur|pour\s+la\s+bobine)\s+)?/i,
  /^pour\s+le\s+condensateur\s+/i,
  /^pour\s+la\s+bobine\s+/i,
  /^enfin\s+/i,
  /^(?:et\s+)?finalement\s+/i,
  /^puis\s+(?:le\s+r[ée]gime\s+sinuso[iï]dal\s+)?/i,
  /^(?:donc\s+)?l[aà]\s+je\s+mets\s+/i,
  /^(?:et\s+)?donc\s+(?:je\s+disais\s+)?/i,
  /^je\s+disais\s+/i,
  /^ok\s+maintenant\s+/i,
  /^attends?\s+non(?:\s*,\s*|\s+)je\s+voulais\s+dire\s+/i,
];

function fold(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function prepareSpeech(raw) {
  let text = String(raw || '').trim().replace(/\s+/g, ' ')
    .replace(/[\s,;:-]+pardon[.!?]*$/i, '');
  let prefix = null;
  for (const pattern of DISCOURSE_PREFIXES) {
    const match = pattern.exec(text);
    if (match) {
      prefix = match[0].trim();
      text = text.slice(match[0].length);
      break;
    }
  }
  return { text, prefix };
}

function tokenize(raw, options = {}) {
  // Whisper conserve souvent la casse des symboles explicitement épelés.
  // On garde C distinct de la variable polynomiale c.
  const isAppleSource = options.source === 'apple';
  let source = String(raw);

  if (isAppleSource) {
    source = source
      // Apple sépare parfois l'indice : « C 2 ».
      .replace(/\bC\s+(\d+)\b/g, 'C$1')
      // Apple peut fournir directement le signe de multiplication.
      .replace(/[×·]/g, ' fois ')
      // « -5X » / « -4AC » doivent redevenir l'opérateur oral moins.
      .replace(/[−–—-]\s*(?=\d)/g, ' moins ')
      // Apple colle parfois le coefficient et deux symboles : 4AC.
      .replace(/\b(\d+)([A-Z])([A-Z])\b/g, '$1 $2 $3')
      // Ou un coefficient et un symbole : 5X.
      .replace(/\b(\d+)([A-Za-z])\b/g, '$1 $2');
  }

  const joinedVoltageSymbols = source.replace(/\b([VZ])\s+([RSCL])(?:\s+(\d+))?\b/g, (_, base, symbol, index) => `${base}${symbol}${index || ''}`);
  let text = fold(joinedVoltageSymbols
    .replace(/\bC\b/g, ' capc ')
    .replace(/\bL\b/g, ' capl ')
    .replace(/\bP\b/g, ' capp ')
    .replace(/\bU\b/g, ' capu ')
    .replace(/\bI\b/g, ' capi ')
    .replace(/\bE\b/g, ' cape ')
    .replace(/\bZ\b/g, ' capz '))
    .replace(/[’']/g, ' ')
    .replace(/\bla\s+puissance\s+capp\b/g, ' capp ')
    .replace(/\bla\s+tension\s+capu\b/g, ' capu ')
    .replace(/\b(?:la\s+)?resistance\s+r\b/g, ' r ')
    .replace(/\ble\s+courant\s+capi\b/g, ' capi ')
    .replace(/\b(?:z|capz)\s+majuscule\b/g, ' capz ')
    .replace(/\bzede\b/g, ' capz ')
    // Variantes lexicales Apple : aucune information scientifique n'est inventée.
    .replace(/\bjomega\b/g, ' j omega ')
    .replace(/\bomegal\b/g, ' omega capl ')
    .replace(/\bomegac\b/g, ' omega capc ')
    .replace(/\bintegral\b/g, ' integrale ')
    .replace(/\br\s+equivalent(?:e)?\b/g, ' req ')
    .replace(/\bd\s+erivee?\s+de\b/g, ' derivee de ')
    .replace(/\bderive\b/g, ' derivee ')
    .replace(/\bcosineus\b/g, ' cosinus ')
    .replace(/\bcocinus\b/g, ' cosinus ')
    .replace(/\bcapu\s+de\s+t\b/g, ' uoft ')
    .replace(/\bcapu\s+max\b/g, ' umax ')
    .replace(/\b(?:un|1)\s+sur\s+(capc|c\d+|[a-z])\s+fois\s+integrale\b/g, ' reciprocal $1 fois integrale ')
    .replace(/\bun\s+demi\b/g, ' half ')
    // Whisper-specific soft corrections are applied by default except when the
    // source is explicitly the Apple transcription pipeline. These corrections
    // were introduced to mitigate typical whisper.cpp errors ("puis"→"plus",
    // phonetic miswrites, etc.). Do not apply them for high-quality native
    // transcriptions unless explicitly allowed.
    .replace(/\best\s+egal(?:e|er)?\s+a\b/g, ' = ')
    .replace(/\best\s+egal(?:e|er)?\b/g, ' = ')
    .replace(/\begal(?:e|er)?\s+a\b/g, ' = ')
    .replace(/\begal(?:e|er)?\b/g, ' = ')
    .replace(/\bau\s+carre\b/g, ' squared ')
    .replace(/\bau\s+cube\b/g, ' cubed ')
    .replace(/\bouvre(?:z)?\s+(?:la\s+)?parenthese\b/g, ' ( ')
    .replace(/\bouvrir\s+(?:la\s+)?parenthese\b/g, ' ( ')
    .replace(/\bferme(?:z|r)?\s+(?:la\s+)?parenthese\b/g, ' ) ')
    .replace(/\+/g, ' plus ')
    .replace(/\//g, ' sur ')
    .replace(/([()=])/g, ' $1 ')
    .replace(/[,.!?;:]+/g, ' ');

  if (!isAppleSource) {
    // Whisper-specific corrections
    text = text.replace(/\bpuis\b/g, ' plus ')
  }

  return text.split(/\s+/).filter(Boolean).map((token) => NUMBER_WORDS.get(token) || token);
}

function node(type, fields = {}) { return { type, ...fields }; }

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
    this.errors = [];
  }

  peek(offset = 0) { return this.tokens[this.pos + offset]; }
  take(value) {
    if (value != null && this.peek() !== value) return null;
    return this.tokens[this.pos++];
  }

  parse() {
    const ast = this.parseEquality();
    if (!ast) return this.failure(this.pos < this.tokens.length ? 'unparsed_tokens' : 'expected_expression');
    if (this.pos !== this.tokens.length) return this.failure('unparsed_tokens', ast);
    return { complete: true, confidence: 1, ast, consumed: this.pos, total: this.tokens.length };
  }

  failure(reason, partialAst = null) {
    return {
      complete: false, confidence: 0, reason, partialAst,
      consumed: this.pos, total: this.tokens.length,
      unparsedTokens: this.tokens.slice(this.pos),
    };
  }

  parseEquality() {
    const left = this.parseDivision();
    if (!left) return null;
    if (this.peek() !== '=') return left;
    this.take('=');
    const right = this.parseDivision();
    if (!right) { this.errors.push('missing_right_operand'); return null; }
    if (this.peek() === '=') { this.errors.push('multiple_equalities'); return null; }
    return node('Equality', { left, right });
  }

  // "A plus B sur C" est entendu comme la fraction (A+B)/C. C'est la
  // portée orale la plus utile et elle reste visible dans l'AST/diagnostic.
  parseDivision() {
    let left = this.parseAddSub();
    if (!left) return null;
    while (this.peek() === 'sur') {
      this.take('sur');
      const right = this.parseAddSub();
      if (!right) return null;
      left = node('Divide', { left, right });
    }
    return left;
  }

  parseAddSub() {
    let left = this.parseMultiply();
    if (!left) return null;
    while (this.peek() === 'plus' || this.peek() === 'moins') {
      const operator = this.take();
      let right;
      // Dans « omega L moins un sur omega C », « un sur ... » est un
      // terme réciproque. Cela ne change pas la convention générale
      // « A plus B sur C » = (A+B)/C lorsque le numérateur n'est pas 1.
      if (this.peek() === '1' && this.peek(1) === 'sur') {
        this.take('1');
        this.take('sur');
        const denominator = this.parseMultiply();
        right = denominator && node('Divide', { left: node('Number', { value: '1' }), right: denominator });
      } else {
        right = this.parseMultiply();
      }
      if (!right) return null;
      left = node(operator === 'plus' ? 'Add' : 'Subtract', { left, right });
    }
    return left;
  }

  parseMultiply() {
    let left = this.parseUnary();
    if (!left) return null;
    while (true) {
      if (this.peek() === 'fois') {
        this.take('fois');
        const right = this.parseUnary();
        if (!right) return null;
        left = node('Multiply', { left, right, spokenOperator: true });
        continue;
      }
      if (this.startsPrimary(this.peek())) {
        const right = this.parseUnary();
        if (!right) return null;
        left = node('Multiply', { left, right, spokenOperator: false });
        continue;
      }
      break;
    }
    return left;
  }

  parseUnary() {
    if (this.peek() === 'moins') {
      this.take('moins');
      const value = this.parseUnary();
      return value && node('Negate', { value });
    }
    return this.parsePower();
  }

  parsePower() {
    let base = this.parsePrimary();
    if (!base) return null;
    while (['squared', 'cubed', 'exposant'].includes(this.peek())) {
      const kind = this.take();
      let exponent;
      if (kind === 'squared') exponent = node('Number', { value: '2' });
      else if (kind === 'cubed') exponent = node('Number', { value: '3' });
      else exponent = this.parseUnary();
      if (!exponent) return null;
      base = node('Power', { base, exponent, spokenForm: kind });
    }
    return base;
  }

  startsPrimary(token) {
    if (!token || ['=', ')', 'plus', 'moins', 'fois', 'sur', 'par'].includes(token)) return false;
    return token === '(' || token === 'racine' || token === 'derivee' || token === 'integrale' || token === 'cosinus' || token === 'reciprocal' || token === 'half' || /^\d+(?:[.,]\d+)?$/.test(token) || this.isSymbolStart(token);
  }

  parsePrimary() {
    if (this.take('(')) {
      const value = this.parseDivision();
      if (!value || !this.take(')')) return null;
      return node('Group', { value });
    }
    if (this.peek() === 'racine') {
      this.take('racine');
      if (this.peek() === 'de') this.take('de');
      const value = this.parsePower();
      return value && node('Root', { value });
    }
    if (this.peek() === 'derivee') return this.parseDerivative();
    if (this.peek() === 'integrale') return this.parseIntegral();
    if (this.peek() === 'cosinus') {
      this.take('cosinus');
      if (this.peek() === 'de') this.take('de');
      const value = this.parseAddSub();
      return value && node('Function', { name: 'cos', value });
    }
    if (this.take('reciprocal')) {
      const denominator = this.parseSymbol();
      return denominator && node('Divide', { left: node('Number', { value: '1' }), right: denominator });
    }
    if (this.take('half')) return node('Divide', { left: node('Number', { value: '1' }), right: node('Number', { value: '2' }) });
    if (/^\d+(?:[.,]\d+)?$/.test(this.peek() || '')) return node('Number', { value: this.take().replace(',', '.') });
    return this.parseSymbol();
  }

  parseDerivative() {
    this.take('derivee');
    if (!this.take('de')) return null;
    const value = this.parseSymbol();
    if (!value || !this.take('par') || !this.take('rapport')) return null;
    if (!['au', 'aux'].includes(this.peek())) return null;
    this.take();
    if (!this.take('temps')) return null;
    return node('Derivative', { value, variable: node('Symbol', { name: 't' }) });
  }

  parseIntegral() {
    this.take('integrale');
    if (this.peek() === 'de') this.take('de');
    const value = this.parseAddSub();
    if (!value || !this.take('par') || !this.take('rapport')) return null;
    if (!['au', 'aux'].includes(this.peek())) return null;
    this.take();
    if (!this.take('temps')) return null;
    return node('Integral', { value, variable: node('Symbol', { name: 't' }) });
  }

  isSymbolStart(token) {
    return ['delta', 'omega', 'phi', 'uoft', 'umax'].includes(token) || ['capc', 'capl', 'capp', 'capu', 'capi', 'cape', 'capz', 'req'].includes(token) || /^[a-z]$/.test(token || '') || /^(?:v[rscl]|z[cl]|r\d+|c\d+|v[rcsl]\d*|d[a-z])$/.test(token || '');
  }

  parseSymbol() {
    const token = this.peek();
    if (!this.isSymbolStart(token)) return null;
    this.take();
    if (token === 'delta') return node('Symbol', { name: 'Delta' });
    if (token === 'omega') {
      const subscript = /^\d+$/.test(this.peek() || '') ? this.take() : undefined;
      return node('Symbol', { name: 'omega', subscript });
    }
    if (token === 'phi') return node('Symbol', { name: 'phi' });
    if (token === 'uoft') return node('AppliedSymbol', { name: 'U', variable: node('Symbol', { name: 't' }) });
    if (token === 'umax') return node('Symbol', { name: 'U', subscript: 'max' });
    if (token === 'capc') return node('Symbol', { name: 'C' });
    if (token === 'capl') return node('Symbol', { name: 'L' });
    if (token === 'capp') return node('Symbol', { name: 'P' });
    if (token === 'capu') return node('Symbol', { name: 'U' });
    if (token === 'capi') return node('Symbol', { name: 'I' });
    if (token === 'cape') return node('Symbol', { name: 'E' });
    if (token === 'capz') return node('Symbol', { name: 'Z' });
    if (token === 'req') return node('Symbol', { name: 'R', subscript: 'eq' });
    if (token === 'zc') return node('Symbol', { name: 'Z', subscript: 'C' });
    if (token === 'zl') return node('Symbol', { name: 'Z', subscript: 'L' });
    if (/^v[rscl]$/.test(token)) {
      let subscript = token.slice(1) === 's' ? 's' : token.slice(1).toUpperCase();
      if (/^\d+$/.test(this.peek() || '')) subscript += this.take();
      return node('Symbol', { name: 'V', subscript });
    }
    if (/^v[rcs]\d+$/.test(token)) return node('Symbol', { name: 'V', subscript: token.slice(1).toUpperCase() });
    if (/^r\d+$/.test(token)) return node('Symbol', { name: 'R', subscript: token.slice(1) });
    if (/^c\d+$/.test(token)) return node('Symbol', { name: 'C', subscript: token.slice(1) });
    if (/^d[a-z]$/.test(token)) return node('DifferentialSymbol', { name: token[1].toUpperCase() === 'T' ? 't' : token[1].toUpperCase() });

    const upper = token.toUpperCase();
    if (token === 'v' && /^[rsc]$/.test(this.peek() || '')) {
      let index = this.take().toUpperCase();
      if (/^\d+$/.test(this.peek() || '')) index += this.take();
      if (index === 'S') index = 's';
      return node('Symbol', { name: 'V', subscript: index });
    }
    if (token === 'r' && /^\d+$/.test(this.peek() || '')) return node('Symbol', { name: 'R', subscript: this.take() });
    return node('Symbol', { name: ['v', 'r'].includes(token) ? upper : token });
  }
}

function precedence(ast) {
  return { Equality: 1, Divide: 2, Add: 3, Subtract: 3, Multiply: 4, Negate: 5, Power: 6 }[ast.type] || 7;
}

function renderAst(ast, parentPrecedence = 0) {
  const own = precedence(ast);
  let value;
  switch (ast.type) {
    case 'Number': value = ast.value; break;
    case 'Symbol': {
      const index = ast.subscript ? (ast.subscript.length === 1 ? `_${ast.subscript}` : `_{${ast.subscript}}`) : '';
      value = ast.name === 'Delta' ? '\\Delta' : ast.name === 'omega' ? `\\omega${index}` : ast.name === 'phi' ? '\\phi' : `${ast.name}${index}`;
      break;
    }
    case 'AppliedSymbol': value = `${ast.name}\\left(${renderAst(ast.variable)}\\right)`; break;
    case 'DifferentialSymbol': value = `d${ast.name}`; break;
    case 'Equality': value = `${renderAst(ast.left, own)} = ${renderAst(ast.right, own)}`; break;
    case 'Add': value = `${renderAst(ast.left, ast.left.type === 'Divide' ? 0 : own)} + ${renderAst(ast.right, ast.right.type === 'Divide' ? 0 : own)}`; break;
    case 'Subtract': value = `${renderAst(ast.left, ast.left.type === 'Divide' ? 0 : own)} - ${renderAst(ast.right, ast.right.type === 'Divide' ? 0 : own + 1)}`; break;
    case 'Multiply': {
      const left = renderAst(ast.left, ast.left.type === 'Divide' ? 0 : own);
      const right = renderAst(ast.right, ast.right.type === 'Divide' ? 0 : own);
      const separator = ast.left.type === 'Number' && ast.right.type === 'Number'
        ? ' \\cdot '
        : (/\\[A-Za-z]+$/.test(left) ? ' ' : '');
      value = `${left}${separator}${right}`;
      break;
    }
    case 'Divide': value = `\\frac{${renderAst(ast.left)}}{${renderAst(ast.right)}}`; break;
    case 'Power': {
      const exponent = renderAst(ast.exponent);
      value = `${renderAst(ast.base, own)}${/^\d$/.test(exponent) && ast.spokenForm !== 'exposant' ? `^${exponent}` : `^{${exponent}}`}`;
      break;
    }
    case 'Negate': value = `-${renderAst(ast.value, own)}`; break;
    case 'Root': value = `\\sqrt{${renderAst(ast.value.type === 'Group' ? ast.value.value : ast.value)}}`; break;
    case 'Derivative': value = `\\frac{d${renderAst(ast.value)}}{d${renderAst(ast.variable)}}`; break;
    case 'Integral': value = `\\int ${renderAst(ast.value)}\\,d${renderAst(ast.variable)}`; break;
    case 'Function': value = `\\${ast.name}\\left(${renderAst(ast.value)}\\right)`; break;
    case 'Group': value = `\\left(${renderAst(ast.value)}\\right)`; break;
    default: throw new Error(`Nœud AST inconnu: ${ast.type}`);
  }
  return own < parentPrecedence ? `\\left(${value}\\right)` : value;
}

function exponentAmbiguity(ast) {
  // Ambiguïté générique : sans pause fine, « X exposant N plus Y » peut
  // signifier (X^N)+Y ou X^(N+Y). On dérive l'alternative depuis l'AST.
  function visit(current) {
    function widenRightmostExponent(value) {
      if (!value || typeof value !== 'object') return null;
      for (const key of ['right', 'value', 'exponent', 'base', 'left']) {
        const changed = widenRightmostExponent(value[key]);
        if (changed) return { ...value, [key]: changed };
      }
      if (value.type === 'Power' && value.spokenForm === 'exposant') {
        return node('Power', {
          base: value.base,
          exponent: node(current.type, { left: value.exponent, right: current.right }),
          spokenForm: 'exposant',
        });
      }
      return null;
    }
    if (current.type === 'Add' || current.type === 'Subtract') {
      const widenedLeft = widenRightmostExponent(current.left);
      const alternative = widenedLeft;
      if (alternative) {
      return { alternatives: [renderAst(ast), renderAst(alternative)], reason: 'exponent_scope' };
      }
    }
    for (const key of ['left', 'right', 'value', 'base', 'exponent']) {
      if (current[key] && typeof current[key] === 'object') {
        const found = visit(current[key]);
        if (found) return found;
      }
    }
    return null;
  }
  return visit(ast);
}

function parseSpokenMath(raw, options = {}) {
  const prepared = prepareSpeech(raw);
  const tokens = tokenize(prepared.text, options);
  const parsed = new Parser(tokens).parse();
  const result = { ...parsed, tokens, discardedPrefix: prepared.prefix };
  if (parsed.complete) {
    result.latex = renderAst(parsed.ast);
    result.ambiguity = exponentAmbiguity(parsed.ast);
  }
  return result;
}

module.exports = { parseSpokenMath, renderAst, tokenize };
