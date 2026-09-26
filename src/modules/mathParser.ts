/**
 * Waveform Viewer Pro - Math Expression Parser & Evaluator
 * Safe tokenizer and AST/RPN evaluator (zero eval() usage)
 * Supports vector/scalar operations, functions, and engineering presets.
 */

import { WaveformChannel } from '../types/models';

export interface Token {
  type: 'number' | 'identifier' | 'operator' | 'function' | 'lparen' | 'rparen' | 'comma';
  value: string;
  numValue?: number;
}

const OPERATOR_PRECEDENCE: Record<string, number> = {
  '+': 1,
  '-': 1,
  '*': 2,
  '/': 2,
  '^': 3,
  'unary-': 4,
};

const RIGHT_ASSOCIATIVE: Record<string, boolean> = {
  '^': true,
  'unary-': true,
};

const MATH_FUNCTIONS = new Set([
  'abs',
  'sqrt',
  'sin',
  'cos',
  'tan',
  'mean',
  'rms',
  'min',
  'max',
  'diff',
  'deriv',
]);

/**
 * Tokenizes mathematical expression string into tokens.
 * Intelligently recognizes channel aliases (CH1, CH2), channel IDs, and full channel names
 * even if they contain spaces or parentheses (e.g. "Ua (Phase A)"), without requiring quotes or brackets.
 */
export function tokenizeMath(
  expr: string,
  channelAliases: Record<string, string> = {},
  channels: Record<string, WaveformChannel> = {}
): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = expr.length;

  // Build candidate channel identifiers sorted by length descending so longer names match first
  const knownIdents: string[] = [];
  Object.keys(channelAliases).forEach((k) => knownIdents.push(k));
  Object.values(channels).forEach((ch) => {
    if (ch.name && !knownIdents.includes(ch.name)) knownIdents.push(ch.name);
    if (ch.id && !knownIdents.includes(ch.id)) knownIdents.push(ch.id);
  });
  knownIdents.sort((a, b) => b.length - a.length);

  while (i < len) {
    const ch = expr[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Bracketed or quoted channel identifiers: e.g. [Ua (Phase A)] or "Ua" or 'Ua'
    if (ch === '[' || ch === '"' || ch === '\'') {
      const closeChar = ch === '[' ? ']' : ch;
      i++;
      let ident = '';
      while (i < len && expr[i] !== closeChar) {
        ident += expr[i++];
      }
      if (i < len && expr[i] === closeChar) {
        i++;
      }
      if (ident.trim().length > 0) {
        tokens.push({ type: 'identifier', value: ident.trim() });
      }
      continue;
    }

    // Try to match known full channel names or aliases at current position (case-insensitive)
    let matchedIdent: string | null = null;
    const remaining = expr.slice(i);
    for (const cand of knownIdents) {
      if (cand.length > 0 && remaining.toLowerCase().startsWith(cand.toLowerCase())) {
        // Ensure not matching prefix of a longer alphanumeric word unless bracketed
        const nextChar = remaining[cand.length];
        if (!nextChar || !/[a-zA-Z0-9_]/.test(nextChar)) {
          matchedIdent = cand;
          break;
        }
      }
    }

    if (matchedIdent) {
      tokens.push({ type: 'identifier', value: matchedIdent });
      i += matchedIdent.length;
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === '.' && i + 1 < len && /[0-9]/.test(expr[i + 1]))) {
      let numStr = '';
      while (i < len && /[0-9.eE+-]/.test(expr[i])) {
        // Handle scientific notation e.g. 1e-3
        if (/[eE]/.test(expr[i])) {
          numStr += expr[i++];
          if (i < len && /[+-]/.test(expr[i])) {
            numStr += expr[i++];
          }
        } else {
          numStr += expr[i++];
        }
      }
      const numVal = parseFloat(numStr);
      if (isNaN(numVal)) {
        throw new Error(`Invalid numeric literal in expression: "${numStr}"`);
      }
      tokens.push({ type: 'number', value: numStr, numValue: numVal });
      continue;
    }

    if (/[a-zA-Z_]/.test(ch)) {
      let ident = '';
      while (i < len && /[a-zA-Z0-9_]/.test(expr[i])) {
        ident += expr[i++];
      }
      const lower = ident.toLowerCase();
      if (MATH_FUNCTIONS.has(lower)) {
        tokens.push({ type: 'function', value: lower });
      } else {
        tokens.push({ type: 'identifier', value: ident });
      }
      continue;
    }

    if (ch === '(') {
      tokens.push({ type: 'lparen', value: '(' });
      i++;
      continue;
    }

    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ')' });
      i++;
      continue;
    }

    if (ch === ',') {
      tokens.push({ type: 'comma', value: ',' });
      i++;
      continue;
    }

    if ('+-*/^'.includes(ch)) {
      // Check for unary minus
      const prev = tokens[tokens.length - 1];
      const isUnary =
        ch === '-' &&
        (!prev || prev.type === 'operator' || prev.type === 'lparen' || prev.type === 'comma');

      tokens.push({
        type: 'operator',
        value: isUnary ? 'unary-' : ch,
      });
      i++;
      continue;
    }

    throw new Error(`Unexpected character in math expression: "${ch}"`);
  }

  return tokens;
}

/**
 * Converts infix tokens into Reverse Polish Notation (RPN) using Dijkstra's Shunting-yard.
 */
export function toRPN(tokens: Token[]): Token[] {
  const output: Token[] = [];
  const operatorStack: Token[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.type === 'number' || token.type === 'identifier') {
      output.push(token);
    } else if (token.type === 'function') {
      operatorStack.push(token);
    } else if (token.type === 'comma') {
      while (
        operatorStack.length > 0 &&
        operatorStack[operatorStack.length - 1].type !== 'lparen'
      ) {
        output.push(operatorStack.pop()!);
      }
      if (operatorStack.length === 0) {
        throw new Error('Misplaced comma in function arguments');
      }
    } else if (token.type === 'operator') {
      const o1 = token.value;
      const p1 = OPERATOR_PRECEDENCE[o1] || 0;
      const isRightAssoc = !!RIGHT_ASSOCIATIVE[o1];

      while (operatorStack.length > 0) {
        const top = operatorStack[operatorStack.length - 1];
        if (top.type === 'operator') {
          const o2 = top.value;
          const p2 = OPERATOR_PRECEDENCE[o2] || 0;
          if ((!isRightAssoc && p1 <= p2) || (isRightAssoc && p1 < p2)) {
            output.push(operatorStack.pop()!);
            continue;
          }
        }
        break;
      }
      operatorStack.push(token);
    } else if (token.type === 'lparen') {
      operatorStack.push(token);
    } else if (token.type === 'rparen') {
      while (
        operatorStack.length > 0 &&
        operatorStack[operatorStack.length - 1].type !== 'lparen'
      ) {
        output.push(operatorStack.pop()!);
      }
      if (operatorStack.length === 0) {
        throw new Error('Mismatched parentheses: missing opening "("');
      }
      operatorStack.pop(); // pop '('

      if (
        operatorStack.length > 0 &&
        operatorStack[operatorStack.length - 1].type === 'function'
      ) {
        output.push(operatorStack.pop()!);
      }
    }
  }

  while (operatorStack.length > 0) {
    const op = operatorStack.pop()!;
    if (op.type === 'lparen' || op.type === 'rparen') {
      throw new Error('Mismatched parentheses in expression');
    }
    output.push(op);
  }

  return output;
}

type OperandValue = { isScalar: true; val: number } | { isScalar: false; val: Float32Array };

/**
 * Evaluates RPN tokens with channel data.
 */
export function evaluateRPN(
  rpn: Token[],
  channels: Record<string, WaveformChannel>,
  channelAliases: Record<string, string>, // e.g. "CH1" -> channelId
  sampleCount: number,
  dt: number
): Float32Array {
  const stack: OperandValue[] = [];

  for (const token of rpn) {
    if (token.type === 'number') {
      stack.push({ isScalar: true, val: token.numValue! });
      continue;
    }

    if (token.type === 'identifier') {
      const rawName = token.value;
      const upperName = rawName.toUpperCase();

      let targetChannel: WaveformChannel | undefined;

      // 1. Check alias (e.g. CH1, CH2)
      if (channelAliases[upperName] && channels[channelAliases[upperName]]) {
        targetChannel = channels[channelAliases[upperName]];
      }

      // 2. Check by channel ID directly
      if (!targetChannel) {
        if (channels[rawName]) targetChannel = channels[rawName];
        else {
          targetChannel = Object.values(channels).find(
            (c) => c.id.toLowerCase() === rawName.toLowerCase()
          );
        }
      }

      // 3. Check by channel Name (exact, case-insensitive)
      if (!targetChannel) {
        targetChannel = Object.values(channels).find(
          (c) => c.name.toLowerCase() === rawName.toLowerCase()
        );
      }

      // 4. Check prefix before parentheses e.g. "Ua (Phase A)" -> "Ua"
      if (!targetChannel) {
        targetChannel = Object.values(channels).find((c) => {
          const prefix = c.name.split(/[\(\[\{]/)[0].trim().toLowerCase();
          return prefix && prefix === rawName.toLowerCase();
        });
      }

      // 5. Check inside parentheses e.g. "Ua (Phase A)" -> "Phase A" or "PhaseA"
      if (!targetChannel) {
        targetChannel = Object.values(channels).find((c) => {
          const m = c.name.match(/[\(\[]\s*([^()\[\]]+)\s*[\)\]]/);
          if (!m) return false;
          const inside = m[1].trim().toLowerCase();
          return (
            inside === rawName.toLowerCase() ||
            inside.replace(/[^a-z0-9]/g, '') === rawName.toLowerCase().replace(/[^a-z0-9]/g, '')
          );
        });
      }

      // 6. Normalized match
      if (!targetChannel) {
        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        const targetNorm = norm(rawName);
        if (targetNorm) {
          targetChannel = Object.values(channels).find(
            (c) => norm(c.name) === targetNorm || norm(c.id) === targetNorm
          );
        }
      }

      if (!targetChannel) {
        const available = Object.keys(channelAliases)
          .concat(Object.values(channels).map((c) => c.name))
          .join(', ');
        throw new Error(
          `Channel "${rawName}" not found. Available channels: ${available}`
        );
      }

      stack.push({ isScalar: false, val: targetChannel.v });
      continue;
    }

    if (token.type === 'operator') {
      if (token.value === 'unary-') {
        const a = stack.pop();
        if (!a) throw new Error('Invalid syntax: missing operand for unary minus');
        if (a.isScalar) {
          stack.push({ isScalar: true, val: -a.val });
        } else {
          const res = new Float32Array(sampleCount);
          for (let i = 0; i < sampleCount; i++) res[i] = -a.val[i];
          stack.push({ isScalar: false, val: res });
        }
        continue;
      }

      const b = stack.pop();
      const a = stack.pop();
      if (!a || !b) {
        throw new Error(`Invalid syntax: missing operand for operator "${token.value}"`);
      }

      const op = token.value;
      if (a.isScalar && b.isScalar) {
        let r = 0;
        if (op === '+') r = a.val + b.val;
        else if (op === '-') r = a.val - b.val;
        else if (op === '*') r = a.val * b.val;
        else if (op === '/') r = b.val !== 0 ? a.val / b.val : 0;
        else if (op === '^') r = Math.pow(a.val, b.val);
        stack.push({ isScalar: true, val: r });
      } else if (a.isScalar && !b.isScalar) {
        const s = a.val;
        const arr = b.val;
        const res = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
          const v = arr[i];
          if (op === '+') res[i] = s + v;
          else if (op === '-') res[i] = s - v;
          else if (op === '*') res[i] = s * v;
          else if (op === '/') res[i] = v !== 0 ? s / v : 0;
          else if (op === '^') res[i] = Math.pow(s, v);
        }
        stack.push({ isScalar: false, val: res });
      } else if (!a.isScalar && b.isScalar) {
        const arr = a.val;
        const s = b.val;
        const res = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
          const v = arr[i];
          if (op === '+') res[i] = v + s;
          else if (op === '-') res[i] = v - s;
          else if (op === '*') res[i] = v * s;
          else if (op === '/') res[i] = s !== 0 ? v / s : 0;
          else if (op === '^') res[i] = Math.pow(v, s);
        }
        stack.push({ isScalar: false, val: res });
      } else if (!a.isScalar && !b.isScalar) {
        const arrA: Float32Array = a.val;
        const arrB: Float32Array = b.val;
        const res = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
          const vA = arrA[i];
          const vB = arrB[i];
          if (op === '+') res[i] = vA + vB;
          else if (op === '-') res[i] = vA - vB;
          else if (op === '*') res[i] = vA * vB;
          else if (op === '/') res[i] = vB !== 0 ? vA / vB : 0;
          else if (op === '^') res[i] = Math.pow(vA, vB);
        }
        stack.push({ isScalar: false, val: res });
      }
      continue;
    }

    if (token.type === 'function') {
      const fn = token.value;
      const arg = stack.pop();
      if (!arg) throw new Error(`Missing argument for function "${fn}"`);

      if (fn === 'abs' || fn === 'sqrt' || fn === 'sin' || fn === 'cos' || fn === 'tan') {
        if (arg.isScalar) {
          let r = 0;
          if (fn === 'abs') r = Math.abs(arg.val);
          else if (fn === 'sqrt') r = Math.sqrt(Math.max(0, arg.val));
          else if (fn === 'sin') r = Math.sin(arg.val);
          else if (fn === 'cos') r = Math.cos(arg.val);
          else if (fn === 'tan') r = Math.tan(arg.val);
          stack.push({ isScalar: true, val: r });
        } else {
          const res = new Float32Array(sampleCount);
          const src = arg.val;
          for (let i = 0; i < sampleCount; i++) {
            const v = src[i];
            if (fn === 'abs') res[i] = Math.abs(v);
            else if (fn === 'sqrt') res[i] = Math.sqrt(Math.max(0, v));
            else if (fn === 'sin') res[i] = Math.sin(v);
            else if (fn === 'cos') res[i] = Math.cos(v);
            else if (fn === 'tan') res[i] = Math.tan(v);
          }
          stack.push({ isScalar: false, val: res });
        }
      } else if (fn === 'mean' || fn === 'rms' || fn === 'min' || fn === 'max') {
        let scalar = 0;
        if (arg.isScalar) {
          scalar = arg.val;
        } else {
          const src = arg.val;
          if (fn === 'mean') {
            let sum = 0;
            for (let i = 0; i < sampleCount; i++) sum += src[i];
            scalar = sum / sampleCount;
          } else if (fn === 'rms') {
            let sumSq = 0;
            for (let i = 0; i < sampleCount; i++) sumSq += src[i] * src[i];
            scalar = Math.sqrt(sumSq / sampleCount);
          } else if (fn === 'min') {
            let m = Infinity;
            for (let i = 0; i < sampleCount; i++) if (src[i] < m) m = src[i];
            scalar = m;
          } else if (fn === 'max') {
            let m = -Infinity;
            for (let i = 0; i < sampleCount; i++) if (src[i] > m) m = src[i];
            scalar = m;
          }
        }
        stack.push({ isScalar: true, val: scalar });
      } else if (fn === 'diff' || fn === 'deriv') {
        const res = new Float32Array(sampleCount);
        if (arg.isScalar) {
          // Derivative/diff of a constant is 0
          stack.push({ isScalar: false, val: res });
        } else {
          const src = arg.val;
          const denom = fn === 'deriv' ? (dt > 0 ? dt : 1) : 1;
          res[0] = 0;
          for (let i = 1; i < sampleCount; i++) {
            res[i] = (src[i] - src[i - 1]) / denom;
          }
          stack.push({ isScalar: false, val: res });
        }
      }
      continue;
    }
  }

  if (stack.length !== 1) {
    throw new Error('Invalid math expression syntax: extra operands or unbalanced expression');
  }

  const finalResult = stack[0];
  if (finalResult.isScalar) {
    const arr = new Float32Array(sampleCount);
    arr.fill(finalResult.val);
    return arr;
  }
  return finalResult.val;
}

/**
 * Evaluates math expression string against dataset and creates or updates a WaveformChannel.
 */
export function evaluateMathExpression(
  expression: string,
  channels: Record<string, WaveformChannel>,
  drawOrder: string[],
  channelId: string = 'math_1',
  channelName: string = 'Math 1'
): WaveformChannel {
  const visibleChList = drawOrder
    .map((id) => channels[id])
    .filter((c) => c && c.id !== channelId);

  if (visibleChList.length === 0) {
    throw new Error('No source channels available to evaluate Math expression.');
  }

  const baseCh = visibleChList[0];
  const sampleCount = baseCh.v.length;
  const dt = baseCh.dt || (baseCh.t.length > 1 ? baseCh.t[1] - baseCh.t[0] : 1e-4);

  // Map CH1, CH2... aliases based on drawOrder
  const channelAliases: Record<string, string> = {};
  drawOrder.forEach((id, idx) => {
    channelAliases[`CH${idx + 1}`] = id;
  });

  const tokens = tokenizeMath(expression, channelAliases, channels);
  const rpn = toRPN(tokens);
  const v = evaluateRPN(rpn, channels, channelAliases, sampleCount, dt);

  // Compute min/max for scaling
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < sampleCount; i++) {
    const val = v[i];
    if (!isNaN(val)) {
      if (val < min) min = val;
      if (val > max) max = val;
    }
  }
  if (!isFinite(min)) min = -1;
  if (!isFinite(max)) max = 1;
  const margin = (max - min) * 0.1 || 0.1;

  // Collect source channel IDs referenced
  const referencedIds: string[] = [];
  tokens.forEach((t) => {
    if (t.type === 'identifier') {
      const upper = t.value.toUpperCase();
      if (channelAliases[upper] && !referencedIds.includes(channelAliases[upper])) {
        referencedIds.push(channelAliases[upper]);
      } else if (channels[t.value] && !referencedIds.includes(t.value)) {
        referencedIds.push(t.value);
      } else {
        const found = Object.values(channels).find(
          (c) => c.name.toLowerCase() === t.value.toLowerCase() || c.id.toLowerCase() === t.value.toLowerCase()
        );
        if (found && !referencedIds.includes(found.id)) {
          referencedIds.push(found.id);
        }
      }
    }
  });

  return {
    id: channelId,
    name: channelName,
    unit: 'V',
    color: '#ff007f', // distinctive magenta/pink for math
    visible: true,
    t: baseCh.t,
    v,
    fs: baseCh.fs,
    dt: baseCh.dt,
    isMath: true,
    mathExpression: expression,
    sourceChannelIds: referencedIds,
    metadata: {
      ...baseCh.metadata,
      invalidSamples: 0,
      gapCount: baseCh.metadata?.gapCount || 0,
      gapIndices: [...(baseCh.metadata?.gapIndices || [])],
    },
    vMin: min - margin,
    vMax: max + margin,
  };
}
