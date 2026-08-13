// Petit parseur de notation mathématique orale française.
// Important : un résultat n'est accepté que si tous les tokens significatifs
// ont été consommés. Il ne résout ni ne corrige jamais l'expression dictée.

const NUMBER_WORDS = new Map(Object.entries({
  zero: '0', un: '1', une: '1', deux: '2', trois: '3', quatre: '4', cinq: '5',
  six: '6', sept: '7', huit: '8', neuf: '9', dix: '10', onze: '11', douze: '12',
}));

const DISCOURSE_PREFIXES = [
  /^(?:donc\s+)?l[aà]\s+je\s+mets\s+/i,
  /^ok\s+maintenant\s+/i,
  /^attends?\s+non\s+je\s+voulais\s+dire\s+/i,
];

function fold(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function prepareSpeech(raw) {
  let text = String(raw || '').trim().replace(/\s+/g, ' ');
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

function tokenize(raw) {
  // Whisper conserve souvent la casse des symboles explicitement épelés.
  // On garde C distinct de la variable polynomiale c.
  let text = fold(String(raw).replace(/\bC\b/g, ' capc '))
    .replace(/[’']/g, ' ')
    .replace(/\best\s+egal(?:e)?\s+a\b/g, ' = ')
    .replace(/\begal(?:e)?\s+a\b/g, ' = ')
    .replace(/\begal(?:e)?\b/g, ' = ')
    .replace(/\bau\s+carre\b/g, ' squared ')
    .replace(/\bau\s+cube\b/g, ' cubed ')
    .replace(/\bouvre(?:z)?\s+(?:la\s+)?parenthese\b/g, ' ( ')
    .replace(/\bouvrir\s+(?:la\s+)?parenthese\b/g, ' ( ')
    .replace(/\bferme(?:z|r)?\s+(?:la\s+)?parenthese\b/g, ' ) ')
    .replace(/\+/g, ' plus ')
    .replace(/\//g, ' sur ')
    .replace(/([()=])/g, ' $1 ')
    .replace(/[,.!?;:]+/g, ' ');
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
      const right = this.parseMultiply();
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
    return token === '(' || token === 'racine' || token === 'derivee' || /^\d+(?:[.,]\d+)?$/.test(token) || this.isSymbolStart(token);
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
    if (/^\d+(?:[.,]\d+)?$/.test(this.peek() || '')) return node('Number', { value: this.take().replace(',', '.') });
    return this.parseSymbol();
  }

  parseDerivative() {
    this.take('derivee');
    if (!this.take('de')) return null;
    const value = this.parseSymbol();
    if (!value || !this.take('par') || !this.take('rapport') || !this.take('au') || !this.take('temps')) return null;
    return node('Derivative', { value, variable: node('Symbol', { name: 't' }) });
  }

  isSymbolStart(token) {
    return token === 'delta' || token === 'capc' || /^[a-z]$/.test(token || '') || /^(?:v[src]|r\d+|v[rcs]\d*|d[a-z])$/.test(token || '');
  }

  parseSymbol() {
    const token = this.peek();
    if (!this.isSymbolStart(token)) return null;
    this.take();
    if (token === 'delta') return node('Symbol', { name: 'Delta' });
    if (token === 'capc') return node('Symbol', { name: 'C' });
    if (/^v[src]$/.test(token)) return node('Symbol', { name: 'V', subscript: token.slice(1) === 's' ? 's' : token.slice(1).toUpperCase() });
    if (/^v[rcs]\d+$/.test(token)) return node('Symbol', { name: 'V', subscript: token.slice(1).toUpperCase() });
    if (/^r\d+$/.test(token)) return node('Symbol', { name: 'R', subscript: token.slice(1) });
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
      value = ast.name === 'Delta' ? '\\Delta' : `${ast.name}${index}`;
      break;
    }
    case 'DifferentialSymbol': value = `d${ast.name}`; break;
    case 'Equality': value = `${renderAst(ast.left, own)} = ${renderAst(ast.right, own)}`; break;
    case 'Add': value = `${renderAst(ast.left, own)} + ${renderAst(ast.right, own)}`; break;
    case 'Subtract': value = `${renderAst(ast.left, own)} - ${renderAst(ast.right, own + 1)}`; break;
    case 'Multiply': {
      const left = renderAst(ast.left, own);
      const right = renderAst(ast.right, own);
      const dot = ast.left.type === 'Number' && ast.right.type === 'Number' ? ' \\cdot ' : '';
      value = `${left}${dot}${right}`;
      break;
    }
    case 'Divide': value = `\\frac{${renderAst(ast.left)}}{${renderAst(ast.right)}}`; break;
    case 'Power': {
      const exponent = renderAst(ast.exponent);
      value = `${renderAst(ast.base, own)}${/^\d$/.test(exponent) && ast.spokenForm !== 'exposant' ? `^${exponent}` : `^{${exponent}}`}`;
      break;
    }
    case 'Negate': value = `-${renderAst(ast.value, own)}`; break;
    case 'Root': value = `\\sqrt{${renderAst(ast.value)}}`; break;
    case 'Derivative': value = `\\frac{d${renderAst(ast.value)}}{d${renderAst(ast.variable)}}`; break;
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

function parseSpokenMath(raw) {
  const prepared = prepareSpeech(raw);
  const tokens = tokenize(prepared.text);
  const parsed = new Parser(tokens).parse();
  const result = { ...parsed, tokens, discardedPrefix: prepared.prefix };
  if (parsed.complete) {
    result.latex = renderAst(parsed.ast);
    result.ambiguity = exponentAmbiguity(parsed.ast);
  }
  return result;
}

module.exports = { parseSpokenMath, renderAst, tokenize };
