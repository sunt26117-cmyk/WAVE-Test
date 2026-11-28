/**
 * Waveform Viewer Pro - Math Expression Parser & Evaluator
 * Safe tokenizer and AST/RPN evaluator (zero eval() usage)
 * Supports vector/scalar operations, functions, time-axis alignment, NaN semantics, and unit inference.
 */

import { WaveformChannel } from '../types/models';
import {
  areTimebasesSynchronized,
  inspectTimebase,
  parsePhysicalUnit,
  sampleSeriesAtTimeStrict,
  validateChannelIntegrity,
  DEFAULT_SAMPLING_GAP_FACTOR,
} from './timeSync';
import { analyzeSamplingQuality } from './qualityCheck';

export interface Token {
  type: 'number' | 'identifier' | 'operator' | 'function' | 'lparen' | 'rparen' | 'comma';
  value: string;
  numValue?: number;
  argCount?: number;
}

const OPERATOR_PRECEDENCE: Record<string, number> = {
  '+': 1,
  '-': 1,
  '*': 2,
  '/': 2,
  'unary-': 2.5,
  'unary+': 2.5,
  '^': 3,
};

const RIGHT_ASSOCIATIVE: Record<string, boolean> = {
  '^': true,
  'unary-': true,
  'unary+': true,
};

const FUNCTION_ARITY: Record<string, { min: number; max: number }> = {
  abs: { min: 1, max: 1 },
  sqrt: { min: 1, max: 1 },
  sin: { min: 1, max: 1 },
  cos: { min: 1, max: 1 },
  tan: { min: 1, max: 1 },
  mean: { min: 1, max: 1 },
  rms: { min: 1, max: 1 },
  min: { min: 1, max: 1 },
  max: { min: 1, max: 1 },
  diff: { min: 1, max: 1 },
  deriv: { min: 1, max: 1 },
  integ: { min: 1, max: 1 },
  movrms: { min: 2, max: 2 },
  movavg: { min: 2, max: 2 },
  hypot: { min: 2, max: 2 },
  atan2: { min: 2, max: 2 },
};

const MATH_FUNCTIONS = new Set(Object.keys(FUNCTION_ARITY));

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

    // Strict numeric literal parsing: integer/decimal mantissa + optional valid scientific exponent [eE][+-]?\d+
    if (/[0-9]/.test(ch) || (ch === '.' && i + 1 < len && /[0-9]/.test(expr[i + 1]))) {
      const start = i;
      let hasDot = false;
      while (i < len) {
        const c = expr[i];
        if (/[0-9]/.test(c)) {
          i++;
        } else if (c === '.' && !hasDot) {
          hasDot = true;
          i++;
        } else {
          break;
        }
      }
      if (i < len && /[eE]/.test(expr[i])) {
        const expMatch = /^[eE][+-]?\d+/.exec(expr.slice(i));
        if (expMatch) {
          i += expMatch[0].length;
        }
      }
      const numStr = expr.slice(start, i);
      const numVal = Number(numStr);
      if (!isFinite(numVal)) {
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
      const prev = tokens[tokens.length - 1];
      const isUnaryPrefix =
        (ch === '-' || ch === '+') &&
        (!prev || prev.type === 'operator' || prev.type === 'lparen' || prev.type === 'comma');

      tokens.push({
        type: 'operator',
        value: isUnaryPrefix ? (ch === '-' ? 'unary-' : 'unary+') : ch,
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
  const fnArgCountStack: number[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.type === 'number' || token.type === 'identifier') {
      output.push(token);
    } else if (token.type === 'function') {
      const next = tokens[i + 1];
      if (!next || next.type !== 'lparen') {
        throw new Error(`函数 "${token.value}" 后必须紧跟左括号 "("`);
      }
      operatorStack.push({ ...token });
    } else if (token.type === 'comma') {
      while (
        operatorStack.length > 0 &&
        operatorStack[operatorStack.length - 1].type !== 'lparen'
      ) {
        output.push(operatorStack.pop()!);
      }
      if (operatorStack.length === 0 || fnArgCountStack.length === 0) {
        throw new Error('Misplaced comma in function arguments');
      }
      fnArgCountStack[fnArgCountStack.length - 1] += 1;
    } else if (token.type === 'operator') {
      const o1 = token.value;
      const p1 = OPERATOR_PRECEDENCE[o1] || 0;
      const isRightAssoc = !!RIGHT_ASSOCIATIVE[o1];
      const isPrefixUnary = o1 === 'unary-' || o1 === 'unary+';

      // Prefix unary operators bind to the right operand and never pop preceding operators (e.g. 2^-2).
      if (!isPrefixUnary) {
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
      }
      operatorStack.push(token);
    } else if (token.type === 'lparen') {
      const prev = tokens[i - 1];
      if (prev && prev.type === 'function') {
        const next = tokens[i + 1];
        fnArgCountStack.push(next && next.type === 'rparen' ? 0 : 1);
      }
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
        const fnToken = operatorStack.pop()!;
        const argCount = fnArgCountStack.pop() ?? 1;
        const spec = FUNCTION_ARITY[fnToken.value];
        if (spec && (argCount < spec.min || argCount > spec.max)) {
          const expected = spec.min === spec.max ? `${spec.min}` : `${spec.min}~${spec.max}`;
          throw new Error(`函数 "${fnToken.value}" 需要 ${expected} 个参数，当前提供了 ${argCount} 个。`);
        }
        fnToken.argCount = argCount;
        output.push(fnToken);
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

type OperandValue =
  | { isScalar: true; val: number; unit: string }
  | { isScalar: false; val: Float32Array; unit: string };

/**
 * Resamples a channel onto masterT via strict binary-search linear interpolation whenever timebases differ.
 * Rejects mismatched t/v arrays and non-monotonic timestamps; never bridges NaNs or sampling gaps.
 */
function sampleChannelOntoTimebase(
  ch: WaveformChannel,
  masterT: Float64Array | undefined,
  sampleCount: number
): Float32Array {
  const integrity = validateChannelIntegrity(ch, 1, DEFAULT_SAMPLING_GAP_FACTOR);
  if (!integrity.valid) {
    throw new Error(integrity.invalidReason || `Channel "${ch.name}" failed time-series integrity check.`);
  }

  const srcT = ch.t;
  const srcV = ch.v;
  if (!masterT || masterT.length === 0) return srcV;

  // Fast path ONLY when identical reference OR full element-wise synchronized timebase
  if (srcT === masterT && srcV.length === sampleCount) {
    return srcV;
  }
  if (srcT.length === sampleCount && masterT.length === sampleCount && areTimebasesSynchronized(srcT, masterT)) {
    return srcV;
  }

  // Evaluate raw channel values without coupling/inversion side-effects unless already baked in
  const rawViewCh: WaveformChannel =
    ch.coupling === 'AC' || ch.inverted
      ? { ...ch, coupling: 'DC', inverted: false }
      : ch;

  const gapLimit = integrity.timebase.gapThresholdSec;
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const qt = masterT[i];
    out[i] = sampleSeriesAtTimeStrict(srcT, rawViewCh, qt, 0, gapLimit).value;
  }
  return out;
}

function resolveChannelByIdentifier(
  rawName: string,
  channels: Record<string, WaveformChannel>,
  channelAliases: Record<string, string>
): WaveformChannel | undefined {
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

  return targetChannel;
}

function safeDiv(a: number, b: number): number {
  if (!isFinite(a) || !isFinite(b) || b === 0) return NaN;
  const r = a / b;
  return isFinite(r) ? r : NaN;
}

function safePow(a: number, b: number): number {
  const r = Math.pow(a, b);
  return isFinite(r) ? r : NaN;
}

function safeSqrt(v: number): number {
  if (!isFinite(v) || v < 0) return NaN;
  return Math.sqrt(v);
}

function formatExponentUnit(baseUnit: string, exp: number): string {
  if (!baseUnit) return '';
  if (Math.abs(exp) <= 1e-12) return '';
  if (Math.abs(exp - 1) <= 1e-12) return baseUnit;
  if (Math.abs(exp - 2) <= 1e-12) return `${baseUnit}²`;
  const rounded = Number(exp.toPrecision(4));
  return `${baseUnit}^${rounded}`;
}

function parseUnitExponent(u: string): { base: string; power: number } {
  const clean = (u || '').trim();
  if (!clean) return { base: '', power: 1 };
  if (clean.endsWith('²')) {
    return { base: clean.slice(0, -1), power: 2 };
  }
  const match = clean.match(/^(.+?)\^(-?\d+(?:\.\d+)?)$/);
  if (match) {
    const p = Number(match[2]);
    if (Number.isFinite(p)) {
      return { base: match[1], power: p };
    }
  }
  return { base: clean, power: 1 };
}

function resolveSqrtUnit(u: string): string {
  const clean = (u || '').trim();
  if (!clean) return '';
  const parsed = parseUnitExponent(clean);
  if (parsed.base) {
    return formatExponentUnit(parsed.base, parsed.power * 0.5);
  }
  return '';
}

function resolveTrigArgument(u: string, fnName: string): { scale: number; outUnit: string } {
  const clean = (u || '').trim();
  if (!clean || clean === '1' || clean.toLowerCase() === 'pu') {
    return { scale: 1, outUnit: '' };
  }
  const lower = clean.toLowerCase();
  const parsed = parsePhysicalUnit(clean);
  if (lower === 'rad' || parsed?.domain === 'angle_rad') {
    return { scale: 1, outUnit: '' };
  }
  if (lower === 'deg' || clean === '°' || parsed?.domain === 'angle_deg') {
    return { scale: Math.PI / 180, outUnit: '' };
  }
  throw new Error(
    `三角函数 ${fnName}(...) 仅支持无量纲或角度单位 (rad/deg)，禁止对 "${clean}" 执行计算。`
  );
}

function resolveBinaryUnitOperation(
  uA: string,
  uB: string,
  op: '+' | '-' | '*' | '/' | '^',
  scalarExpHint?: number
): { scaleA: number; scaleB: number; outUnit: string } {
  const cleanA = (uA || '').trim();
  const cleanB = (uB || '').trim();
  const pA = parsePhysicalUnit(cleanA);
  const pB = parsePhysicalUnit(cleanB);

  if (op === '+' || op === '-') {
    if (cleanA && cleanB) {
      if (pA && pB) {
        if (pA.domain !== pB.domain) {
          throw new Error(
            `跨量纲运算禁止执行："${cleanA}" (${pA.domain}) ${op} "${cleanB}" (${pB.domain}) 物理量纲不兼容。`
          );
        }
        if (cleanA === cleanB || Math.abs(pA.scale - pB.scale) <= 1e-12) {
          return { scaleA: 1, scaleB: 1, outUnit: cleanA };
        }
        return { scaleA: pA.scale, scaleB: pB.scale, outUnit: pA.baseUnit };
      }
      if (cleanA.toLowerCase() !== cleanB.toLowerCase()) {
        throw new Error(`跨量纲运算禁止执行："${cleanA}" ${op} "${cleanB}" 单位不兼容。`);
      }
      return { scaleA: 1, scaleB: 1, outUnit: cleanA };
    }
    return { scaleA: 1, scaleB: 1, outUnit: cleanA || cleanB };
  }

  if (op === '*') {
    if (!cleanA) return { scaleA: 1, scaleB: 1, outUnit: cleanB };
    if (!cleanB) return { scaleA: 1, scaleB: 1, outUnit: cleanA };
    if (pA && pB) {
      if (
        (pA.domain === 'voltage' && pB.domain === 'current') ||
        (pA.domain === 'current' && pB.domain === 'voltage')
      ) {
        return { scaleA: pA.scale, scaleB: pB.scale, outUnit: 'W' };
      }
      if (
        (pA.domain === 'power' && pB.domain === 'time') ||
        (pA.domain === 'time' && pB.domain === 'power')
      ) {
        return { scaleA: pA.scale, scaleB: pB.scale, outUnit: 'J' };
      }
      if (pA.domain === pB.domain) {
        if (cleanA === cleanB) return { scaleA: 1, scaleB: 1, outUnit: `${cleanA}²` };
        return { scaleA: pA.scale, scaleB: pB.scale, outUnit: `${pA.baseUnit}²` };
      }
    }
    return { scaleA: 1, scaleB: 1, outUnit: `${cleanA}·${cleanB}` };
  }

  if (op === '/') {
    if (!cleanB) return { scaleA: 1, scaleB: 1, outUnit: cleanA };
    if (!cleanA) return { scaleA: 1, scaleB: 1, outUnit: `1/${cleanB}` };
    if (pA && pB) {
      if (pA.domain === pB.domain) {
        return { scaleA: pA.scale, scaleB: pB.scale, outUnit: '' };
      }
      if (pA.domain === 'voltage' && pB.domain === 'current') {
        return { scaleA: pA.scale, scaleB: pB.scale, outUnit: 'Ω' };
      }
      if (pA.domain === 'power' && pB.domain === 'voltage') {
        return { scaleA: pA.scale, scaleB: pB.scale, outUnit: 'A' };
      }
      if (pA.domain === 'power' && pB.domain === 'current') {
        return { scaleA: pA.scale, scaleB: pB.scale, outUnit: 'V' };
      }
    }
    if (cleanA === cleanB) return { scaleA: 1, scaleB: 1, outUnit: '' };
    return { scaleA: 1, scaleB: 1, outUnit: `${cleanA}/${cleanB}` };
  }

  if (op === '^') {
    if (cleanB && cleanB !== '1' && cleanB.toLowerCase() !== 'pu') {
      throw new Error(`幂运算指数必须无量纲，禁止使用物理单位 "${cleanB}" 作为指数。`);
    }
    if (!cleanA) {
      return { scaleA: 1, scaleB: 1, outUnit: '' };
    }
    if (scalarExpHint !== undefined && Number.isFinite(scalarExpHint)) {
      const parsed = parseUnitExponent(cleanA);
      return {
        scaleA: 1,
        scaleB: 1,
        outUnit: formatExponentUnit(parsed.base, parsed.power * scalarExpHint),
      };
    }
    return { scaleA: 1, scaleB: 1, outUnit: `${cleanA}^n` };
  }

  return { scaleA: 1, scaleB: 1, outUnit: '' };
}

/**
 * Evaluates RPN tokens with channel data (and optional scalar variable overrides).
 */
export function evaluateRPN(
  rpn: Token[],
  channels: Record<string, WaveformChannel>,
  channelAliases: Record<string, string>, // e.g. "CH1" -> channelId
  sampleCount: number,
  dt: number,
  baseTimeArray?: Float64Array,
  scalarVariables?: Record<string, number>
): Float32Array {
  const baseTb =
    baseTimeArray && baseTimeArray.length > 0
      ? inspectTimebase(baseTimeArray, 0, baseTimeArray.length - 1, DEFAULT_SAMPLING_GAP_FACTOR)
      : null;
  if (baseTb && !baseTb.monotonic) {
    throw new Error(
      `基准时间轴在索引 ${baseTb.nonMonotonicIndex ?? '?'} 处存在非单调、重复或 NaN/Inf 时间戳，已阻止 Math 运算。`
    );
  }
  const baseGapLimit = baseTb ? baseTb.gapThresholdSec : Infinity;

  const stack: OperandValue[] = [];

  for (const token of rpn) {
    if (token.type === 'number') {
      stack.push({ isScalar: true, val: token.numValue!, unit: '' });
      continue;
    }

    if (token.type === 'identifier') {
      const rawName = token.value;
      if (scalarVariables && Object.prototype.hasOwnProperty.call(scalarVariables, rawName.toLowerCase())) {
        stack.push({ isScalar: true, val: scalarVariables[rawName.toLowerCase()], unit: '' });
        continue;
      }

      const targetChannel = resolveChannelByIdentifier(rawName, channels, channelAliases);
      if (!targetChannel) {
        const available = Object.keys(channelAliases)
          .concat(Object.values(channels).map((c) => c.name))
          .join(', ');
        throw new Error(
          `Channel "${rawName}" not found. Available channels: ${available}`
        );
      }

      const alignedV = sampleChannelOntoTimebase(targetChannel, baseTimeArray, sampleCount);
      stack.push({ isScalar: false, val: alignedV, unit: (targetChannel.unit || '').trim() });
      continue;
    }

    if (token.type === 'operator') {
      if (token.value === 'unary-' || token.value === 'unary+') {
        const a = stack.pop();
        if (!a) throw new Error(`Invalid syntax: missing operand for "${token.value}"`);
        const sign = token.value === 'unary-' ? -1 : 1;
        if (a.isScalar) {
          stack.push({ isScalar: true, val: sign * a.val, unit: a.unit });
        } else if (sign === 1) {
          stack.push(a);
        } else {
          const res = new Float32Array(sampleCount);
          for (let i = 0; i < sampleCount; i++) res[i] = -a.val[i];
          stack.push({ isScalar: false, val: res, unit: a.unit });
        }
        continue;
      }

      const b = stack.pop();
      const a = stack.pop();
      if (!a || !b) {
        throw new Error(`Invalid syntax: missing operand for operator "${token.value}"`);
      }

      const op = token.value as '+' | '-' | '*' | '/' | '^';
      const scalarExpHint = op === '^' && b.isScalar ? b.val : undefined;
      const { scaleA, scaleB, outUnit } = resolveBinaryUnitOperation(a.unit, b.unit, op, scalarExpHint);

      if (a.isScalar && b.isScalar) {
        const sA = a.val * scaleA;
        const sB = b.val * scaleB;
        let r = NaN;
        if (op === '+') r = sA + sB;
        else if (op === '-') r = sA - sB;
        else if (op === '*') r = sA * sB;
        else if (op === '/') r = safeDiv(sA, sB);
        else if (op === '^') r = safePow(sA, sB);
        stack.push({ isScalar: true, val: r, unit: outUnit });
      } else if (a.isScalar && !b.isScalar) {
        const s = a.val * scaleA;
        const arr = b.val;
        const res = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
          const v = arr[i] * scaleB;
          if (op === '+') res[i] = s + v;
          else if (op === '-') res[i] = s - v;
          else if (op === '*') res[i] = s * v;
          else if (op === '/') res[i] = safeDiv(s, v);
          else if (op === '^') res[i] = safePow(s, v);
        }
        stack.push({ isScalar: false, val: res, unit: outUnit });
      } else if (!a.isScalar && b.isScalar) {
        const arr = a.val;
        const s = b.val * scaleB;
        const res = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
          const v = arr[i] * scaleA;
          if (op === '+') res[i] = v + s;
          else if (op === '-') res[i] = v - s;
          else if (op === '*') res[i] = v * s;
          else if (op === '/') res[i] = safeDiv(v, s);
          else if (op === '^') res[i] = safePow(v, s);
        }
        stack.push({ isScalar: false, val: res, unit: outUnit });
      } else if (!a.isScalar && !b.isScalar) {
        const arrA = a.val as Float32Array;
        const arrB = b.val as Float32Array;
        const res = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
          const vA = arrA[i] * scaleA;
          const vB = arrB[i] * scaleB;
          if (op === '+') res[i] = vA + vB;
          else if (op === '-') res[i] = vA - vB;
          else if (op === '*') res[i] = vA * vB;
          else if (op === '/') res[i] = safeDiv(vA, vB);
          else if (op === '^') res[i] = safePow(vA, vB);
        }
        stack.push({ isScalar: false, val: res, unit: outUnit });
      }
      continue;
    }

    if (token.type === 'function') {
      const fn = token.value;
      const arity = token.argCount ?? (FUNCTION_ARITY[fn]?.min ?? 1);

      // 2-argument functions
      if (fn === 'movrms' || fn === 'movavg' || fn === 'hypot' || fn === 'atan2') {
        if (arity !== 2) {
          throw new Error(`函数 "${fn}" 需要 2 个参数，当前提供了 ${arity} 个。`);
        }
        const arg2 = stack.pop();
        const arg1 = stack.pop();
        if (!arg1 || !arg2) throw new Error(`Missing arguments for function "${fn}"`);

        if (fn === 'hypot' || fn === 'atan2') {
          const { scaleA, scaleB, outUnit } = resolveBinaryUnitOperation(arg1.unit, arg2.unit, '+');
          const resUnit = fn === 'atan2' ? 'rad' : outUnit;
          if (arg1.isScalar && arg2.isScalar) {
            const vA = arg1.val * scaleA;
            const vB = arg2.val * scaleB;
            const r = fn === 'hypot' ? Math.hypot(vA, vB) : Math.atan2(vA, vB);
            stack.push({ isScalar: true, val: Number.isFinite(r) ? r : NaN, unit: resUnit });
          } else {
            const res = new Float32Array(sampleCount);
            for (let i = 0; i < sampleCount; i++) {
              const vA = (arg1.isScalar ? arg1.val : arg1.val[i]) * scaleA;
              const vB = (arg2.isScalar ? arg2.val : arg2.val[i]) * scaleB;
              if (!isFinite(vA) || !isFinite(vB)) {
                res[i] = NaN;
              } else {
                res[i] = fn === 'hypot' ? Math.hypot(vA, vB) : Math.atan2(vA, vB);
              }
            }
            stack.push({ isScalar: false, val: res, unit: resUnit });
          }
          continue;
        }

        // movrms(x, winSec) / movavg(x, winSec) — O(N) non-uniform, gap-safe, drift-free prefix integral
        if (!arg2.isScalar) {
          throw new Error(`函数 ${fn}(x, winSec) 的第 2 个参数窗口时长必须为正标量（单位：秒）。`);
        }
        let winSec = arg2.val;
        const winUnitParsed = parsePhysicalUnit(arg2.unit);
        if (arg2.unit && winUnitParsed?.domain === 'time') {
          winSec *= winUnitParsed.scale;
        } else if (arg2.unit && arg2.unit !== '1' && arg2.unit.toLowerCase() !== 'pu') {
          throw new Error(`函数 ${fn}(x, winSec) 的窗口参数单位 "${arg2.unit}" 不是无量纲秒数或时间单位。`);
        }
        if (!Number.isFinite(winSec) || winSec <= 0) {
          throw new Error(`函数 ${fn}(x, winSec) 的窗口时长必须为大于 0 的有限值（当前=${arg2.val}）。`);
        }

        if (arg1.isScalar) {
          const v = fn === 'movrms' ? Math.abs(arg1.val) : arg1.val;
          stack.push({ isScalar: true, val: isFinite(v) ? v : NaN, unit: arg1.unit });
          continue;
        }

        const src = arg1.val;
        const res = new Float32Array(sampleCount);
        res.fill(NaN);
        const hasTime = !!baseTimeArray && baseTimeArray.length === sampleCount;
        const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 1e-4;
        const timeAt = (idx: number): number => (hasTime ? baseTimeArray![idx] : idx * safeDt);

        // Precompute exact piecewise-linear segment integrals (0 across NaNs or sampling gaps)
        const prefInt = new Float64Array(sampleCount);
        const prefDt = new Float64Array(sampleCount);
        const segValid = new Uint8Array(Math.max(0, sampleCount - 1));
        for (let i = 0; i < sampleCount - 1; i++) {
          const v0 = src[i];
          const v1 = src[i + 1];
          const segDt = timeAt(i + 1) - timeAt(i);
          if (
            isFinite(v0) &&
            isFinite(v1) &&
            segDt > 0 &&
            (!Number.isFinite(baseGapLimit) || segDt <= baseGapLimit)
          ) {
            segValid[i] = 1;
            const segI =
              fn === 'movrms'
                ? ((v0 * v0 + v0 * v1 + v1 * v1) / 3) * segDt
                : 0.5 * (v0 + v1) * segDt;
            prefInt[i + 1] = prefInt[i] + segI;
            prefDt[i + 1] = prefDt[i] + segDt;
          } else {
            prefInt[i + 1] = prefInt[i];
            prefDt[i + 1] = prefDt[i];
          }
        }

        // Monotonic left-pointer scan over [t[i] - winSec, t[i]]
        let leftIdx = 0;
        for (let i = 0; i < sampleCount; i++) {
          const vi = src[i];
          if (!isFinite(vi)) {
            res[i] = NaN;
            continue;
          }
          const ti = timeAt(i);
          const tWinStart = ti - winSec;
          while (leftIdx < i && timeAt(leftIdx + 1) < tWinStart) {
            leftIdx++;
          }
          if (i === 0) {
            res[i] = fn === 'movrms' ? Math.abs(vi) : vi;
            continue;
          }

          let totalInt = 0;
          let totalDt = 0;
          if (leftIdx < i) {
            const tL0 = timeAt(leftIdx);
            const tL1 = timeAt(leftIdx + 1);
            if (tL0 >= tWinStart) {
              // Full segments [leftIdx .. i]
              totalInt = prefInt[i] - prefInt[leftIdx];
              totalDt = prefDt[i] - prefDt[leftIdx];
            } else {
              // Full interior segments [leftIdx+1 .. i] + partial straddling segment [tWinStart .. tL1]
              totalInt = prefInt[i] - prefInt[leftIdx + 1];
              totalDt = prefDt[i] - prefDt[leftIdx + 1];
              if (segValid[leftIdx] && tL1 > tL0) {
                const frac = Math.max(0, Math.min(1, (tWinStart - tL0) / (tL1 - tL0)));
                const vStart = src[leftIdx] + frac * (src[leftIdx + 1] - src[leftIdx]);
                const vEnd = src[leftIdx + 1];
                const partDt = tL1 - tWinStart;
                if (partDt > 0) {
                  totalInt +=
                    fn === 'movrms'
                      ? ((vStart * vStart + vStart * vEnd + vEnd * vEnd) / 3) * partDt
                      : 0.5 * (vStart + vEnd) * partDt;
                  totalDt += partDt;
                }
              }
            }
          }

          if (totalDt > 1e-18) {
            res[i] = fn === 'movrms' ? Math.sqrt(Math.max(0, totalInt / totalDt)) : totalInt / totalDt;
          } else {
            res[i] = fn === 'movrms' ? Math.abs(vi) : vi;
          }
        }
        stack.push({ isScalar: false, val: res, unit: arg1.unit });
        continue;
      }

      const arg = stack.pop();
      if (!arg) throw new Error(`Missing argument for function "${fn}"`);

      if (fn === 'abs' || fn === 'sqrt' || fn === 'sin' || fn === 'cos' || fn === 'tan') {
        let argScale = 1;
        let outUnit = arg.unit;
        if (fn === 'sin' || fn === 'cos' || fn === 'tan') {
          const trig = resolveTrigArgument(arg.unit, fn);
          argScale = trig.scale;
          outUnit = trig.outUnit;
        } else if (fn === 'sqrt') {
          outUnit = resolveSqrtUnit(arg.unit);
        }
        if (arg.isScalar) {
          let r = NaN;
          const v = arg.val * argScale;
          if (fn === 'abs') r = Math.abs(v);
          else if (fn === 'sqrt') r = safeSqrt(v);
          else if (fn === 'sin') r = Math.sin(v);
          else if (fn === 'cos') r = Math.cos(v);
          else if (fn === 'tan') r = Math.tan(v);
          stack.push({ isScalar: true, val: r, unit: outUnit });
        } else {
          const res = new Float32Array(sampleCount);
          const src = arg.val;
          for (let i = 0; i < sampleCount; i++) {
            const v = src[i] * argScale;
            if (fn === 'abs') res[i] = Math.abs(v);
            else if (fn === 'sqrt') res[i] = safeSqrt(v);
            else if (fn === 'sin') res[i] = Math.sin(v);
            else if (fn === 'cos') res[i] = Math.cos(v);
            else if (fn === 'tan') res[i] = Math.tan(v);
          }
          stack.push({ isScalar: false, val: res, unit: outUnit });
        }
      } else if (fn === 'mean' || fn === 'rms' || fn === 'min' || fn === 'max') {
        let scalar = NaN;
        if (arg.isScalar) {
          scalar = arg.val;
        } else {
          const src = arg.val;
          if (fn === 'mean' || fn === 'rms') {
            let sum = 0;
            let sumSq = 0;
            let count = 0;
            let invalidCount = 0;
            let gapCount = 0;
            let trapSum = 0;
            let trapSqSum = 0;
            let totalDtWeight = 0;
            let minDtObserved = Infinity;
            let maxDtObserved = 0;
            let prevVal: number | null = null;
            let prevTime: number | null = null;
            const hasTime = !!baseTimeArray && baseTimeArray.length === sampleCount;

            for (let i = 0; i < sampleCount; i++) {
              const val = src[i];
              const ti = hasTime ? baseTimeArray[i] : NaN;
              if (isFinite(val) && (!hasTime || isFinite(ti))) {
                sum += val;
                sumSq += val * val;
                count++;
                if (hasTime && prevVal !== null && prevTime !== null) {
                  const stepDt = ti - prevTime;
                  if (stepDt > 0) {
                    if (Number.isFinite(baseGapLimit) && stepDt > baseGapLimit) {
                      gapCount++;
                    } else {
                      if (stepDt < minDtObserved) minDtObserved = stepDt;
                      if (stepDt > maxDtObserved) maxDtObserved = stepDt;
                      trapSum += 0.5 * (prevVal + val) * stepDt;
                      trapSqSum += ((prevVal * prevVal + prevVal * val + val * val) / 3) * stepDt;
                      totalDtWeight += stepDt;
                    }
                  }
                }
                prevVal = val;
                prevTime = ti;
              } else {
                invalidCount++;
                prevVal = null;
                prevTime = null;
              }
            }

            const hasVaryingDt =
              isFinite(minDtObserved) && maxDtObserved > 0 && minDtObserved < maxDtObserved * 0.98;
            const useTimeWeighted =
              hasTime &&
              totalDtWeight > 0 &&
              (baseTb?.isUniform === false || hasVaryingDt || gapCount > 0 || invalidCount > 0);

            if (fn === 'mean') {
              scalar = useTimeWeighted
                ? trapSum / totalDtWeight
                : count > 0
                ? sum / count
                : NaN;
            } else {
              scalar = useTimeWeighted
                ? Math.sqrt(Math.max(0, trapSqSum / totalDtWeight))
                : count > 0
                ? Math.sqrt(sumSq / count)
                : NaN;
            }
          } else if (fn === 'min') {
            let m = Infinity;
            for (let i = 0; i < sampleCount; i++) {
              if (isFinite(src[i]) && src[i] < m) m = src[i];
            }
            scalar = isFinite(m) ? m : NaN;
          } else if (fn === 'max') {
            let m = -Infinity;
            for (let i = 0; i < sampleCount; i++) {
              if (isFinite(src[i]) && src[i] > m) m = src[i];
            }
            scalar = isFinite(m) ? m : NaN;
          }
        }
        stack.push({ isScalar: true, val: scalar, unit: arg.unit });
      } else if (fn === 'integ') {
        const parsedU = parsePhysicalUnit(arg.unit);
        let unitScale = 1;
        let outUnit = arg.unit ? `${arg.unit}·s` : 's';
        if (parsedU) {
          if (parsedU.domain === 'power') {
            unitScale = parsedU.scale;
            outUnit = 'J';
          } else if (parsedU.domain === 'current') {
            unitScale = parsedU.scale;
            outUnit = 'C';
          } else if (parsedU.domain === 'voltage') {
            unitScale = parsedU.scale;
            outUnit = 'V·s';
          }
        }

        const res = new Float32Array(sampleCount);
        res.fill(NaN);
        const hasTime = !!baseTimeArray && baseTimeArray.length === sampleCount;
        const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 1e-4;
        const timeAt = (idx: number): number => (hasTime ? baseTimeArray![idx] : idx * safeDt);

        let acc = 0;
        let prevFiniteIdx = -1;
        for (let i = 0; i < sampleCount; i++) {
          const val = (arg.isScalar ? arg.val : arg.val[i]) * unitScale;
          if (!isFinite(val)) {
            res[i] = NaN;
            prevFiniteIdx = -1;
            continue;
          }
          if (prevFiniteIdx === i - 1) {
            const stepDt = timeAt(i) - timeAt(i - 1);
            if (isFinite(stepDt) && stepDt > 0 && (!Number.isFinite(baseGapLimit) || stepDt <= baseGapLimit)) {
              const prevVal = (arg.isScalar ? arg.val : arg.val[i - 1]) * unitScale;
              acc += 0.5 * (prevVal + val) * stepDt;
              res[i] = acc;
            } else {
              // Do not fabricate area across a sampling gap; mark gap boundary NaN and hold acc for next continuous segment
              res[i] = NaN;
              prevFiniteIdx = i;
              continue;
            }
          } else {
            res[i] = acc;
          }
          prevFiniteIdx = i;
        }
        stack.push({ isScalar: false, val: res, unit: outUnit });
      } else if (fn === 'diff' || fn === 'deriv') {
        const outUnit = fn === 'deriv' ? (arg.unit ? `${arg.unit}/s` : '1/s') : arg.unit;
        const res = new Float32Array(sampleCount);
        res.fill(NaN);
        if (!arg.isScalar) {
          const src = arg.val;
          res[0] = NaN;
          for (let i = 1; i < sampleCount; i++) {
            const hasTime = !!baseTimeArray && i < baseTimeArray.length;
            if (fn === 'deriv') {
              if (!hasTime) {
                res[i] = NaN;
                continue;
              }
              const rawStepDt = baseTimeArray![i] - baseTimeArray![i - 1];
              if (!isFinite(rawStepDt) || rawStepDt <= 1e-18) {
                res[i] = NaN;
                continue;
              }
              if (Number.isFinite(baseGapLimit) && rawStepDt > baseGapLimit) {
                res[i] = NaN;
                continue;
              }
              res[i] = isFinite(src[i]) && isFinite(src[i - 1]) ? (src[i] - src[i - 1]) / rawStepDt : NaN;
            } else {
              if (hasTime && Number.isFinite(baseGapLimit) && baseTimeArray![i] - baseTimeArray![i - 1] > baseGapLimit) {
                res[i] = NaN;
                continue;
              }
              res[i] = isFinite(src[i]) && isFinite(src[i - 1]) ? src[i] - src[i - 1] : NaN;
            }
          }
        }
        stack.push({ isScalar: false, val: res, unit: outUnit });
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
  return finalResult.val as Float32Array;
}

/**
 * Infers physical output unit from RPN AST and channel units.
 */
export function inferUnitFromRpn(
  rpn: Token[],
  channels: Record<string, WaveformChannel>,
  channelAliases: Record<string, string>
): string {
  const unitStack: Array<{ unit: string; scalarVal?: number }> = [];

  for (const token of rpn) {
    if (token.type === 'number') {
      unitStack.push({ unit: '', scalarVal: token.numValue });
      continue;
    }
    if (token.type === 'identifier') {
      const ch = resolveChannelByIdentifier(token.value, channels, channelAliases);
      unitStack.push({ unit: (ch?.unit || '').trim() });
      continue;
    }
    if (token.type === 'operator') {
      if (token.value === 'unary-' || token.value === 'unary+') {
        const a = unitStack.pop() ?? { unit: '' };
        const sign = token.value === 'unary-' ? -1 : 1;
        unitStack.push({
          unit: a.unit,
          scalarVal: a.scalarVal !== undefined ? sign * a.scalarVal : undefined,
        });
        continue;
      }
      const b = unitStack.pop() ?? { unit: '' };
      const a = unitStack.pop() ?? { unit: '' };
      const op = token.value as '+' | '-' | '*' | '/' | '^';
      const { outUnit } = resolveBinaryUnitOperation(a.unit, b.unit, op, b.scalarVal);
      let scalarVal: number | undefined;
      if (a.scalarVal !== undefined && b.scalarVal !== undefined) {
        if (op === '+') scalarVal = a.scalarVal + b.scalarVal;
        else if (op === '-') scalarVal = a.scalarVal - b.scalarVal;
        else if (op === '*') scalarVal = a.scalarVal * b.scalarVal;
        else if (op === '/') scalarVal = b.scalarVal !== 0 ? a.scalarVal / b.scalarVal : undefined;
        else if (op === '^') scalarVal = Math.pow(a.scalarVal, b.scalarVal);
      }
      unitStack.push({ unit: outUnit, scalarVal });
      continue;
    }
    if (token.type === 'function') {
      const fn = token.value;
      if (fn === 'movrms' || fn === 'movavg' || fn === 'hypot' || fn === 'atan2') {
        const b = unitStack.pop() ?? { unit: '' };
        const a = unitStack.pop() ?? { unit: '' };
        if (fn === 'hypot') {
          const { outUnit } = resolveBinaryUnitOperation(a.unit, b.unit, '+');
          unitStack.push({ unit: outUnit });
        } else if (fn === 'atan2') {
          resolveBinaryUnitOperation(a.unit, b.unit, '+');
          unitStack.push({ unit: 'rad' });
        } else {
          // movrms / movavg: validate positive scalar window hint when statically known
          if (b.scalarVal !== undefined && (!Number.isFinite(b.scalarVal) || b.scalarVal <= 0)) {
            throw new Error(`函数 ${fn}(x, winSec) 的窗口时长必须为大于 0 的有限值。`);
          }
          const winU = parsePhysicalUnit(b.unit);
          if (b.unit && winU?.domain !== 'time' && b.unit !== '1' && b.unit.toLowerCase() !== 'pu') {
            throw new Error(`函数 ${fn}(x, winSec) 的窗口参数单位 "${b.unit}" 不是无量纲秒数或时间单位。`);
          }
          unitStack.push({ unit: a.unit });
        }
        continue;
      }
      const a = unitStack.pop() ?? { unit: '' };
      if (fn === 'sin' || fn === 'cos' || fn === 'tan') {
        const trig = resolveTrigArgument(a.unit, fn);
        unitStack.push({ unit: trig.outUnit });
      } else if (fn === 'sqrt') {
        unitStack.push({ unit: resolveSqrtUnit(a.unit) });
      } else if (fn === 'deriv') {
        unitStack.push({ unit: a.unit ? `${a.unit}/s` : '1/s' });
      } else if (fn === 'integ') {
        const parsedU = parsePhysicalUnit(a.unit);
        if (parsedU?.domain === 'power') unitStack.push({ unit: 'J' });
        else if (parsedU?.domain === 'current') unitStack.push({ unit: 'C' });
        else if (parsedU?.domain === 'voltage') unitStack.push({ unit: 'V·s' });
        else unitStack.push({ unit: a.unit ? `${a.unit}·s` : 's' });
      } else {
        unitStack.push({ unit: a.unit });
      }
    }
  }

  return unitStack.length === 1 ? unitStack[0].unit : '';
}

export interface MathExpressionPreviewResult {
  valid: boolean;
  inferredUnit: string;
  referencedChannels: string[];
  error?: string;
}

/**
 * Lightweight syntax, channel-reference, arity, and dimensional preview for live Math modal validation.
 */
export function previewMathExpression(
  expression: string,
  channels: Record<string, WaveformChannel>,
  drawOrder: string[]
): MathExpressionPreviewResult {
  const trimmed = expression.trim();
  if (!trimmed) {
    return { valid: false, inferredUnit: '', referencedChannels: [], error: '请输入数学表达式。' };
  }
  const channelAliases: Record<string, string> = {};
  drawOrder.forEach((id, idx) => {
    channelAliases[`CH${idx + 1}`] = id;
  });

  try {
    const tokens = tokenizeMath(trimmed, channelAliases, channels);
    if (tokens.length === 0) {
      return { valid: false, inferredUnit: '', referencedChannels: [], error: '表达式为空。' };
    }
    const rpn = toRPN(tokens);
    const referencedChannels: string[] = [];
    for (const tok of tokens) {
      if (tok.type === 'identifier') {
        const resolved = resolveChannelByIdentifier(tok.value, channels, channelAliases);
        if (!resolved) {
          throw new Error(`未找到通道 "${tok.value}"`);
        }
        if (!referencedChannels.includes(resolved.name)) {
          referencedChannels.push(resolved.name);
        }
      }
    }
    // Check RPN stack balance using a dry-run stack depth counter
    let depth = 0;
    for (const tok of rpn) {
      if (tok.type === 'number' || tok.type === 'identifier') {
        depth += 1;
      } else if (tok.type === 'operator') {
        if (tok.value === 'unary-' || tok.value === 'unary+') {
          if (depth < 1) throw new Error(`运算符 "${tok.value}" 缺少操作数`);
        } else {
          if (depth < 2) throw new Error(`运算符 "${tok.value}" 缺少操作数`);
          depth -= 1;
        }
      } else if (tok.type === 'function') {
        const need = tok.argCount ?? (FUNCTION_ARITY[tok.value]?.min ?? 1);
        if (depth < need) throw new Error(`函数 "${tok.value}" 参数不足`);
        depth = depth - need + 1;
      }
    }
    if (depth !== 1) {
      throw new Error('表达式括号或操作数不平衡');
    }
    const inferredUnit = inferUnitFromRpn(rpn, channels, channelAliases);
    return { valid: true, inferredUnit, referencedChannels };
  } catch (err: any) {
    return {
      valid: false,
      inferredUnit: '',
      referencedChannels: [],
      error: err?.message || '表达式语法错误',
    };
  }
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

  // Map CH1, CH2... aliases based on drawOrder
  const channelAliases: Record<string, string> = {};
  drawOrder.forEach((id, idx) => {
    channelAliases[`CH${idx + 1}`] = id;
  });

  const tokens = tokenizeMath(expression, channelAliases, channels);
  const rpn = toRPN(tokens);

  // Collect source channel IDs referenced
  const referencedIds: string[] = [];
  tokens.forEach((t) => {
    if (t.type === 'identifier') {
      const resolved = resolveChannelByIdentifier(t.value, channels, channelAliases);
      if (resolved && !referencedIds.includes(resolved.id)) {
        referencedIds.push(resolved.id);
      }
    }
  });

  // Use the first referenced source channel as master timebase (falls back to first channel)
  const baseCh = (referencedIds[0] && channels[referencedIds[0]]) || visibleChList[0];
  const baseIntegrity = validateChannelIntegrity(baseCh, 1, DEFAULT_SAMPLING_GAP_FACTOR);
  if (!baseIntegrity.valid) {
    throw new Error(baseIntegrity.invalidReason || `Channel "${baseCh.name}" has invalid time/value arrays.`);
  }

  const sampleCount = baseCh.v.length;
  const dt = baseCh.dt || (baseCh.t.length > 1 ? baseCh.t[1] - baseCh.t[0] : 1e-4);

  const v = evaluateRPN(rpn, channels, channelAliases, sampleCount, dt, baseCh.t);
  const inferredUnit = inferUnitFromRpn(rpn, channels, channelAliases);

  // Compute min/max and count NaNs for scaling & audit
  let min = Infinity;
  let max = -Infinity;
  let nanCount = 0;
  for (let i = 0; i < sampleCount; i++) {
    const val = v[i];
    if (isFinite(val)) {
      if (val < min) min = val;
      if (val > max) max = val;
    } else {
      nanCount++;
    }
  }
  if (!isFinite(min)) min = -1;
  if (!isFinite(max)) max = 1;
  const margin = (max - min) * 0.1 || 0.1;

  const freshTbMeta = analyzeSamplingQuality(baseCh.t);

  return {
    id: channelId,
    name: channelName,
    unit: inferredUnit,
    color: '#ff007f', // distinctive magenta/pink for math
    visible: true,
    t: baseCh.t,
    v,
    fs: freshTbMeta.sampleRate,
    dt: freshTbMeta.nominalDt ?? freshTbMeta.medianDt,
    isMath: true,
    channelKind: 'computed',
    derivedKind: 'math',
    derivedBadge: 'fx',
    mathExpression: expression,
    sourceChannelIds: referencedIds,
    metadata: {
      ...freshTbMeta,
      dataProvenance: 'derived_estimate',
      sourceModel: 'math_expression',
      invalidSamples: nanCount,
      signalNanCount: nanCount,
    },
    vMin: min - margin,
    vMax: max + margin,
  };
}
