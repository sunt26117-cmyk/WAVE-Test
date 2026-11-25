/**
 * Waveform Viewer Pro - Multi-Channel Timebase Verification & Synchronization
 * Ensures multi-channel transforms, phase diagnostics, power integrals, and thermal
 * evaluators never blindly multiply/compare mismatched or non-monotonic arrays by index.
 */

import { WaveformChannel } from '../types/models';
import { computeChannelMean, getChannelDisplayValue } from './oscilloscopeScale';
import { resampleUniform } from './resampler';

export const DEFAULT_SAMPLING_GAP_FACTOR = 3.5;

export interface TimebaseCheckResult {
  monotonic: boolean;
  nonMonotonicIndex: number | null;
  isUniform: boolean;
  dtMin: number;
  dtMax: number;
  dtMedian: number;
  gapThresholdSec: number;
  positiveDtCount: number;
}

export function inspectTimebase(
  t: Float64Array,
  startIdx = 0,
  endIdx = t.length - 1,
  gapFactor = DEFAULT_SAMPLING_GAP_FACTOR
): TimebaseCheckResult {
  const i0 = Math.max(0, startIdx);
  const i1 = Math.min(t.length - 1, endIdx);
  if (i1 - i0 < 1) {
    const singleValid = t.length === 0 || (i0 < t.length && Number.isFinite(t[i0]));
    return {
      monotonic: singleValid,
      nonMonotonicIndex: singleValid ? null : i0,
      isUniform: true,
      dtMin: 0,
      dtMax: 0,
      dtMedian: 0,
      gapThresholdSec: Infinity,
      positiveDtCount: 0,
    };
  }

  const dts: number[] = [];
  let monotonic = true;
  let nonMonotonicIndex: number | null = null;
  let dtMin = Infinity;
  let dtMax = -Infinity;

  for (let i = i0; i <= i1; i++) {
    if (!Number.isFinite(t[i])) {
      return {
        monotonic: false,
        nonMonotonicIndex: i,
        isUniform: false,
        dtMin: 0,
        dtMax: 0,
        dtMedian: 0,
        gapThresholdSec: Infinity,
        positiveDtCount: 0,
      };
    }
    if (i > i0) {
      const dt = t[i] - t[i - 1];
      if (!(dt > 0)) {
        if (monotonic) {
          monotonic = false;
          nonMonotonicIndex = i;
        }
      } else {
        dts.push(dt);
        if (dt < dtMin) dtMin = dt;
        if (dt > dtMax) dtMax = dt;
      }
    }
  }

  if (dts.length === 0) {
    return {
      monotonic: false,
      nonMonotonicIndex,
      isUniform: false,
      dtMin: 0,
      dtMax: 0,
      dtMedian: 0,
      gapThresholdSec: Infinity,
      positiveDtCount: 0,
    };
  }

  dts.sort((a, b) => a - b);
  const mid = dts.length >> 1;
  const dtMedian = dts.length % 2 === 0 ? 0.5 * (dts[mid - 1] + dts[mid]) : dts[mid];
  const isUniform = dtMedian > 0 && dtMax <= dtMin * 1.05 + 1e-15;
  const gapThresholdSec =
    dts.length >= 3 && dtMedian > 0 && Number.isFinite(gapFactor) && gapFactor > 1
      ? dtMedian * gapFactor
      : Infinity;

  return {
    monotonic,
    nonMonotonicIndex,
    isUniform,
    dtMin,
    dtMax,
    dtMedian,
    gapThresholdSec,
    positiveDtCount: dts.length,
  };
}

/**
 * Full element-wise timebase synchronization check (never endpoint-only).
 */
export function areTimebasesSynchronized(
  tA: Float64Array,
  tB: Float64Array,
  relTol = 1e-7
): boolean {
  if (tA === tB) return true;
  if (tA.length !== tB.length) return false;
  const n = tA.length;
  if (n === 0) return true;
  const span = Math.max(1e-12, Math.abs(tA[n - 1] - tA[0]));
  const dtEst = n > 1 ? span / (n - 1) : span;
  const absTol = Math.max(1e-15, dtEst * 1e-4, span * relTol);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(tA[i]) || !Number.isFinite(tB[i])) return false;
    if (Math.abs(tA[i] - tB[i]) > absTol) return false;
  }
  return true;
}

export interface ChannelIntegrityResult {
  valid: boolean;
  invalidReason: string | null;
  sampleCount: number;
  timebase: TimebaseCheckResult;
}

export function validateChannelIntegrity(
  ch: WaveformChannel | null | undefined,
  minSamples = 2,
  gapFactor = DEFAULT_SAMPLING_GAP_FACTOR
): ChannelIntegrityResult {
  const emptyTb: TimebaseCheckResult = {
    monotonic: false,
    nonMonotonicIndex: 0,
    isUniform: false,
    dtMin: 0,
    dtMax: 0,
    dtMedian: 0,
    gapThresholdSec: Infinity,
    positiveDtCount: 0,
  };
  if (!ch || !ch.t || !ch.v) {
    return { valid: false, invalidReason: '通道对象或时间/幅值数组缺失。', sampleCount: 0, timebase: emptyTb };
  }
  if (ch.t.length !== ch.v.length) {
    return {
      valid: false,
      invalidReason: `通道 "${ch.name}" 时间戳 (${ch.t.length}) 与幅值 (${ch.v.length}) 长度不一致（一一对应关系已破坏），已拒绝静默截断。`,
      sampleCount: 0,
      timebase: emptyTb,
    };
  }
  const n = ch.t.length;
  if (n < minSamples) {
    return {
      valid: false,
      invalidReason: `通道 "${ch.name}" 有效样本数 (${n}) 不足 (< ${minSamples})。`,
      sampleCount: n,
      timebase: emptyTb,
    };
  }
  const tb = inspectTimebase(ch.t, 0, n - 1, gapFactor);
  if (!tb.monotonic) {
    return {
      valid: false,
      invalidReason: `通道 "${ch.name}" 时间轴在索引 ${tb.nonMonotonicIndex ?? '?'} 处存在非单调、重复或 NaN/Inf 时间戳。`,
      sampleCount: n,
      timebase: tb,
    };
  }
  return { valid: true, invalidReason: null, sampleCount: n, timebase: tb };
}

export interface SampleAtTimeResult {
  value: number;
  reason: 'ok' | 'out-of-range' | 'gap' | 'nan' | 'invalid';
}

/**
 * Strict binary-search linear interpolation on a verified strictly-monotonic channel.
 * Never extrapolates out of bounds, never bridges NaN/Inf, and never interpolates across sampling gaps.
 */
export function sampleSeriesAtTimeStrict(
  tArr: Float64Array,
  ch: WaveformChannel,
  targetT: number,
  acMean: number,
  gapThresholdSec = Infinity
): SampleAtTimeResult {
  if (!tArr || !ch.v || tArr.length !== ch.v.length) {
    return { value: Number.NaN, reason: 'invalid' };
  }
  const n = tArr.length;
  if (n === 0 || !Number.isFinite(targetT)) {
    return { value: Number.NaN, reason: 'invalid' };
  }
  if (targetT < tArr[0] || targetT > tArr[n - 1]) {
    return { value: Number.NaN, reason: 'out-of-range' };
  }
  if (n === 1 || targetT === tArr[0]) {
    const v0 = getChannelDisplayValue(ch, 0, acMean);
    return Number.isFinite(v0) ? { value: v0, reason: 'ok' } : { value: Number.NaN, reason: 'nan' };
  }
  if (targetT === tArr[n - 1]) {
    const vn = getChannelDisplayValue(ch, n - 1, acMean);
    return Number.isFinite(vn) ? { value: vn, reason: 'ok' } : { value: Number.NaN, reason: 'nan' };
  }

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tArr[mid] <= targetT) lo = mid;
    else hi = mid;
  }

  const t0 = tArr[lo];
  const t1 = tArr[hi];
  const exactTol = 1e-15 * Math.max(1, Math.abs(targetT));
  if (Math.abs(targetT - t0) <= exactTol) {
    const v0 = getChannelDisplayValue(ch, lo, acMean);
    return Number.isFinite(v0) ? { value: v0, reason: 'ok' } : { value: Number.NaN, reason: 'nan' };
  }
  if (Math.abs(targetT - t1) <= exactTol) {
    const v1 = getChannelDisplayValue(ch, hi, acMean);
    return Number.isFinite(v1) ? { value: v1, reason: 'ok' } : { value: Number.NaN, reason: 'nan' };
  }

  const dt = t1 - t0;
  if (!(dt > 0) || !Number.isFinite(dt)) {
    return { value: Number.NaN, reason: 'invalid' };
  }
  if (Number.isFinite(gapThresholdSec) && dt > gapThresholdSec) {
    return { value: Number.NaN, reason: 'gap' };
  }

  const v0 = getChannelDisplayValue(ch, lo, acMean);
  const v1 = getChannelDisplayValue(ch, hi, acMean);
  if (!Number.isFinite(v0) || !Number.isFinite(v1)) {
    return { value: Number.NaN, reason: 'nan' };
  }
  const frac = (targetT - t0) / dt;
  return { value: v0 + frac * (v1 - v0), reason: 'ok' };
}

export function sampleSeriesAtTime(
  tArr: Float64Array,
  ch: WaveformChannel,
  targetT: number,
  acMean: number,
  gapThresholdSec = Infinity
): number {
  return sampleSeriesAtTimeStrict(tArr, ch, targetT, acMean, gapThresholdSec).value;
}

export interface AlignedChannelsResult {
  valid: boolean;
  invalidReason: string | null;
  time: Float64Array;
  values: Float32Array[];
  resampled: boolean;
  overlapStart: number;
  overlapEnd: number;
  warnings: string[];
  validPairCount?: number;
  invalidSampleCount?: number;
  gapSkippedCount?: number;
  coveragePct?: number;
  downsampledBySyncCap?: boolean;
  sourceMinDtSec?: number;
  effectiveDtSec?: number;
}

export interface SamplingGapReport {
  gapCount: number;
  maxGapSec: number;
  maxGapRatio: number;
}

export function inspectChannelSamplingGaps(
  t: Float64Array,
  startIdx = 0,
  endIdx = t.length - 1,
  gapFactor = DEFAULT_SAMPLING_GAP_FACTOR
): SamplingGapReport {
  const i0 = Math.max(0, startIdx);
  const i1 = Math.min(t.length - 1, endIdx);
  if (i1 - i0 < 3) {
    return { gapCount: 0, maxGapSec: 0, maxGapRatio: 1 };
  }
  const dts: number[] = [];
  for (let i = i0 + 1; i <= i1; i++) {
    const dt = t[i] - t[i - 1];
    if (Number.isFinite(dt) && dt > 0) dts.push(dt);
  }
  if (dts.length < 3) return { gapCount: 0, maxGapSec: 0, maxGapRatio: 1 };
  dts.sort((a, b) => a - b);
  const dtMed = dts[dts.length >> 1];
  if (!(dtMed > 0)) return { gapCount: 0, maxGapSec: 0, maxGapRatio: 1 };

  let gapCount = 0;
  let maxGapSec = 0;
  let maxGapRatio = 1;
  for (let i = i0 + 1; i <= i1; i++) {
    const dt = t[i] - t[i - 1];
    if (dt > dtMed * gapFactor) {
      gapCount++;
      if (dt > maxGapSec) maxGapSec = dt;
      const ratio = dt / dtMed;
      if (ratio > maxGapRatio) maxGapRatio = ratio;
    }
  }
  return { gapCount, maxGapSec, maxGapRatio };
}

export interface SiGroupScaleResult {
  valid: boolean;
  baseUnit: string;
  scales: number[];
  normalizedNote: string | null;
  reason: string | null;
}

export interface PhysicalUnitInfo {
  domain: string;
  baseUnit: string;
  scale: number;
  rawUnit: string;
}

const SI_PREFIX_SCALE: Record<string, number> = {
  '': 1,
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  µ: 1e-6,
  μ: 1e-6,
  m: 1e-3,
  k: 1e3,
  M: 1e6,
  G: 1e9,
};

export function parsePhysicalUnit(unitRaw: string | undefined): PhysicalUnitInfo | null {
  const u = (unitRaw || '').trim();
  if (!u) return null;

  // Voltage
  const vMatch = /^([pnuµμmkMG])?v(olts?)?$/i.exec(u);
  if (vMatch && (u.length <= 2 || /^([pnuµμmkMG])?volts?$/i.test(u))) {
    const p = vMatch[1] || '';
    const scale = p === 'M' ? 1e6 : p === 'm' ? 1e-3 : SI_PREFIX_SCALE[p] ?? SI_PREFIX_SCALE[p.toLowerCase()] ?? 1;
    return { domain: 'voltage', baseUnit: 'V', scale, rawUnit: u };
  }
  // Current
  const aMatch = /^([pnuµμmkMG])?a(mps?|mperes?)?$/i.exec(u);
  if (aMatch && (u.length <= 2 || /^([pnuµμmkMG])?(amps?|amperes?)$/i.test(u))) {
    const p = aMatch[1] || '';
    const scale = p === 'M' ? 1e6 : p === 'm' ? 1e-3 : SI_PREFIX_SCALE[p] ?? SI_PREFIX_SCALE[p.toLowerCase()] ?? 1;
    return { domain: 'current', baseUnit: 'A', scale, rawUnit: u };
  }
  // Power
  const wMatch = /^([pnuµμmkMG])?w(atts?)?$/i.exec(u);
  if (wMatch && (u.length <= 2 || /^([pnuµμmkMG])?watts?$/i.test(u))) {
    const p = wMatch[1] || '';
    const scale = p === 'M' ? 1e6 : p === 'm' ? 1e-3 : SI_PREFIX_SCALE[p] ?? SI_PREFIX_SCALE[p.toLowerCase()] ?? 1;
    return { domain: 'power', baseUnit: 'W', scale, rawUnit: u };
  }
  // Resistance
  const rMatch = /^([pnuµμmkMG])?(Ω|ohm|ohms)$/i.exec(u);
  if (rMatch) {
    const p = rMatch[1] || '';
    const scale = p === 'M' ? 1e6 : p === 'm' ? 1e-3 : SI_PREFIX_SCALE[p] ?? SI_PREFIX_SCALE[p.toLowerCase()] ?? 1;
    return { domain: 'resistance', baseUnit: 'Ω', scale, rawUnit: u };
  }
  // Frequency
  const fMatch = /^([pnuµμmkMG])?hz$/i.exec(u);
  if (fMatch) {
    const p = fMatch[1] || '';
    const scale = p === 'M' ? 1e6 : p === 'm' ? 1e-3 : SI_PREFIX_SCALE[p] ?? SI_PREFIX_SCALE[p.toLowerCase()] ?? 1;
    return { domain: 'frequency', baseUnit: 'Hz', scale, rawUnit: u };
  }
  // Time (whitelist to avoid ambiguity with meters)
  const tMatch = /^(ps|ns|us|µs|μs|ms|s|sec|secs|seconds?)$/i.exec(u);
  if (tMatch) {
    const low = u.toLowerCase();
    const scale =
      low === 'ps' ? 1e-12 : low === 'ns' ? 1e-9 : low === 'us' || low === 'µs' || low === 'μs' ? 1e-6 : low === 'ms' ? 1e-3 : 1;
    return { domain: 'time', baseUnit: 's', scale, rawUnit: u };
  }
  // Energy
  const jMatch = /^([pnuµμmkMG])?j(oules?)?$/i.exec(u);
  if (jMatch && (u.length <= 2 || /^([pnuµμmkMG])?joules?$/i.test(u))) {
    const p = jMatch[1] || '';
    const scale = p === 'M' ? 1e6 : p === 'm' ? 1e-3 : SI_PREFIX_SCALE[p] ?? SI_PREFIX_SCALE[p.toLowerCase()] ?? 1;
    return { domain: 'energy', baseUnit: 'J', scale, rawUnit: u };
  }
  // Torque
  const tqMatch = /^(m|k)?(N·?m)$/i.exec(u);
  if (tqMatch) {
    const p = tqMatch[1] || '';
    const scale = p.toLowerCase() === 'm' ? 1e-3 : p.toLowerCase() === 'k' ? 1e3 : 1;
    return { domain: 'torque', baseUnit: 'Nm', scale, rawUnit: u };
  }
  // Temperature
  if (/^(°c|℃|degc|c|celsius)$/i.test(u)) {
    return { domain: 'temperature', baseUnit: '°C', scale: 1, rawUnit: u };
  }
  if (/^(k|kelvin|degk)$/i.test(u)) {
    return { domain: 'kelvin', baseUnit: 'K', scale: 1, rawUnit: u };
  }
  // Percent
  if (/^(%|pct|percent)$/i.test(u)) {
    return { domain: 'percent', baseUnit: '%', scale: 1, rawUnit: u };
  }
  // Angle
  if (/^(rad|radians?)$/i.test(u)) {
    return { domain: 'angle_rad', baseUnit: 'rad', scale: 1, rawUnit: u };
  }
  if (/^(deg|°|degrees?)$/i.test(u)) {
    return { domain: 'angle_deg', baseUnit: 'deg', scale: 1, rawUnit: u };
  }
  return { domain: `raw:${u.toLowerCase()}`, baseUnit: u, scale: 1, rawUnit: u };
}

export interface UnitPairCompatibility {
  compatible: boolean;
  baseUnit: string;
  scaleA: number;
  scaleB: number;
  scaleBToA: number;
  reason: string | null;
}

export function resolveUnitPairCompatibility(
  unitA?: string,
  unitB?: string
): UnitPairCompatibility {
  const pA = parsePhysicalUnit(unitA);
  const pB = parsePhysicalUnit(unitB);
  if (!pA || !pB) {
    const base = pA?.rawUnit || pB?.rawUnit || '';
    return { compatible: true, baseUnit: base, scaleA: 1, scaleB: 1, scaleBToA: 1, reason: null };
  }
  if (pA.domain !== pB.domain) {
    return {
      compatible: false,
      baseUnit: pA.baseUnit,
      scaleA: 1,
      scaleB: 1,
      scaleBToA: 1,
      reason: `单位量纲冲突："${pA.rawUnit}" (${pA.domain}) 与 "${pB.rawUnit}" (${pB.domain}) 不可混算/直接比较。`,
    };
  }
  return {
    compatible: true,
    baseUnit: pA.baseUnit,
    scaleA: pA.scale,
    scaleB: pB.scale,
    scaleBToA: pB.scale / pA.scale,
    reason: null,
  };
}

export function resolveCompatibleSiGroupScale(channels: WaveformChannel[]): SiGroupScaleResult {
  if (channels.length === 0) {
    return { valid: true, baseUnit: 'V', scales: [], normalizedNote: null, reason: null };
  }
  const parsed = channels.map((ch) => parsePhysicalUnit(ch.unit));
  const nonEmpty = parsed.filter((p): p is NonNullable<typeof p> => p !== null);
  if (nonEmpty.length === 0) {
    return {
      valid: true,
      baseUnit: channels[0].unit || 'V',
      scales: channels.map(() => 1),
      normalizedNote: null,
      reason: null,
    };
  }
  const first = nonEmpty[0];
  for (let i = 0; i < channels.length; i++) {
    const p = parsed[i];
    if (p && p.domain !== first.domain) {
      return {
        valid: false,
        baseUnit: first.baseUnit,
        scales: [],
        normalizedNote: null,
        reason: `通道物理单位量纲冲突："${channels[i].name}" (${channels[i].unit}) 与基准 "${first.baseUnit}" 不兼容，已拒绝跨量纲混算。`,
      };
    }
  }
  const scales = parsed.map((p) => (p ? p.scale : 1));
  const scaledDifferently = scales.some((s) => Math.abs(s - 1) > 1e-12);
  const missingSomeUnit = nonEmpty.length < channels.length;
  const normalizedNote = scaledDifferently
    ? `检测到混合 SI 数量级单位（如 mV/V 或 mA/A），已自动统一折算为标准国际单位 "${first.baseUnit}" 后计算。`
    : missingSomeUnit
    ? `部分通道未显式标注单位，已按基准单位 "${first.baseUnit}" 对齐处理。`
    : null;
  return { valid: true, baseUnit: first.baseUnit, scales, normalizedNote, reason: null };
}

export interface AlignChannelsOptions {
  /** If true, keeps NaN/gap masks as NaN instead of failing closed on any NaN sample. Defaults to false. */
  allowPartialNaNs?: boolean;
  /** Gap multiplier threshold relative to median dt (default 3.5). */
  gapFactor?: number;
}

/**
 * Aligns multiple channels onto a single synchronized timebase within their true
 * overlapping time range (with linear interpolation, gap protection, and zero out-of-range extrapolation).
 * Fails closed (valid = false) on ANY non-monotonic, duplicate, mismatched t/v, or NaN/Inf timestamps.
 */
export function alignChannelsToCommonTimebase(
  channels: WaveformChannel[],
  tStart?: number,
  tEnd?: number,
  options: AlignChannelsOptions = {}
): AlignedChannelsResult {
  const allowPartialNaNs = Boolean(options.allowPartialNaNs);
  const gapFactor = options.gapFactor ?? DEFAULT_SAMPLING_GAP_FACTOR;

  if (channels.length === 0) {
    return {
      valid: false,
      invalidReason: '未选择有效通道。',
      time: new Float64Array(0),
      values: [],
      resampled: false,
      overlapStart: 0,
      overlapEnd: 0,
      warnings: ['未选择有效通道。'],
      validPairCount: 0,
      invalidSampleCount: 0,
      gapSkippedCount: 0,
      coveragePct: 0,
    };
  }

  const warnings: string[] = [];
  let overlapStart = tStart !== undefined && Number.isFinite(tStart) ? tStart : -Infinity;
  let overlapEnd = tEnd !== undefined && Number.isFinite(tEnd) ? tEnd : Infinity;
  const chTimebases: TimebaseCheckResult[] = [];

  for (const ch of channels) {
    const integrity = validateChannelIntegrity(ch, 2, gapFactor);
    if (!integrity.valid) {
      const msg = integrity.invalidReason || `通道 "${ch?.name || ''}" 数据不完整。`;
      return {
        valid: false,
        invalidReason: msg,
        time: new Float64Array(0),
        values: channels.map(() => new Float32Array(0)),
        resampled: false,
        overlapStart: 0,
        overlapEnd: 0,
        warnings: [msg],
        validPairCount: 0,
        invalidSampleCount: 0,
        gapSkippedCount: 0,
        coveragePct: 0,
      };
    }
    chTimebases.push(integrity.timebase);

    if (!allowPartialNaNs) {
      const invalidSampleIndex = ch.v.findIndex((value) => !Number.isFinite(value));
      if (invalidSampleIndex >= 0) {
        const msg = `通道 "${ch.name}" 的原始幅值在索引 ${invalidSampleIndex} 处包含 NaN/Inf；拒绝在重采样时跳过或插值修补无效样本。`;
        return {
          valid: false,
          invalidReason: msg,
          time: new Float64Array(0),
          values: channels.map(() => new Float32Array(0)),
          resampled: false,
          overlapStart: 0,
          overlapEnd: 0,
          warnings: [msg],
          validPairCount: 0,
          invalidSampleCount: 0,
          gapSkippedCount: 0,
          coveragePct: 0,
        };
      }
    }

    const n = ch.t.length;
    if (ch.t[0] > overlapStart) overlapStart = ch.t[0];
    if (ch.t[n - 1] < overlapEnd) overlapEnd = ch.t[n - 1];
  }

  if (!Number.isFinite(overlapStart) || !Number.isFinite(overlapEnd) || overlapEnd <= overlapStart) {
    const msg = '所选多路通道在当前门控窗口内没有有效时间重叠区间，已阻止错位运算。';
    return {
      valid: false,
      invalidReason: msg,
      time: new Float64Array(0),
      values: channels.map(() => new Float32Array(0)),
      resampled: false,
      overlapStart: 0,
      overlapEnd: 0,
      warnings: [msg],
      validPairCount: 0,
      invalidSampleCount: 0,
      gapSkippedCount: 0,
      coveragePct: 0,
    };
  }

  const ref = channels[0];
  let allSynced = true;
  for (let c = 1; c < channels.length; c++) {
    if (!areTimebasesSynchronized(ref.t, channels[c].t)) {
      allSynced = false;
      break;
    }
  }

  const acMeans = channels.map((ch) => (ch.coupling === 'AC' ? computeChannelMean(ch) : 0));

  if (allSynced) {
    const nRef = ref.t.length;
    let i0 = 0;
    let i1 = nRef - 1;
    while (i0 < nRef && ref.t[i0] < overlapStart) i0++;
    while (i1 > i0 && ref.t[i1] > overlapEnd) i1--;
    const len = Math.max(0, i1 - i0 + 1);
    if (len < 2) {
      const msg = '重叠门控区间内同步样本数不足 (<2 点)。';
      return {
        valid: false,
        invalidReason: msg,
        time: new Float64Array(0),
        values: channels.map(() => new Float32Array(0)),
        resampled: false,
        overlapStart: 0,
        overlapEnd: 0,
        warnings: [msg],
        validPairCount: 0,
        invalidSampleCount: 0,
        gapSkippedCount: 0,
        coveragePct: 0,
      };
    }
    const time = new Float64Array(len);
    for (let k = 0; k < len; k++) time[k] = ref.t[i0 + k];
    const values = channels.map((ch, cIdx) => {
      const arr = new Float32Array(len);
      const mean = acMeans[cIdx];
      for (let k = 0; k < len; k++) arr[k] = getChannelDisplayValue(ch, i0 + k, mean);
      return arr;
    });

    let validPairCount = 0;
    let invalidSampleCount = 0;
    for (let k = 0; k < len; k++) {
      let rowValid = true;
      for (let c = 0; c < values.length; c++) {
        if (!Number.isFinite(values[c][k])) {
          rowValid = false;
          break;
        }
      }
      if (rowValid) validPairCount++;
      else invalidSampleCount++;
    }

    if (!allowPartialNaNs && invalidSampleCount > 0) {
      const invalidChannelIndex = values.findIndex((arr) => arr.some((value) => !Number.isFinite(value)));
      const msg = `通道 "${channels[Math.max(0, invalidChannelIndex)].name}" 在同步门控区间内含 NaN/Inf 幅值样本；缺失数据可能包含瞬态峰值，已阻止生成有效多通道分析结果。`;
      return {
        valid: false,
        invalidReason: msg,
        time: new Float64Array(0),
        values: channels.map(() => new Float32Array(0)),
        resampled: false,
        overlapStart,
        overlapEnd,
        warnings: [...warnings, msg],
        validPairCount: 0,
        invalidSampleCount,
        gapSkippedCount: 0,
        coveragePct: 0,
      };
    }
    return {
      valid: true,
      invalidReason: null,
      time,
      values,
      resampled: false,
      overlapStart,
      overlapEnd,
      warnings,
      validPairCount,
      invalidSampleCount,
      gapSkippedCount: 0,
      coveragePct: len > 0 ? (validPairCount / len) * 100 : 0,
      downsampledBySyncCap: false,
    };
  }

  // Build synchronized reference grid from densest channel median dt inside [overlapStart, overlapEnd]
  const dtList = chTimebases.map((tb, idx) => {
    const ch = channels[idx];
    const n = ch.t.length;
    return tb.dtMedian > 0 ? tb.dtMedian : (ch.t[n - 1] - ch.t[0]) / Math.max(1, n - 1);
  });
  const minDt = Math.max(1e-12, Math.min(...dtList.filter((d) => Number.isFinite(d) && d > 0)));
  const maxDt = Math.max(...dtList.filter((d) => Number.isFinite(d) && d > 0));
  const span = overlapEnd - overlapStart;
  const MAX_SYNC_PTS = 262144;
  const rawTargetLen = Math.max(2, Math.round(span / minDt) + 1);
  const downsampledBySyncCap = rawTargetLen > MAX_SYNC_PTS;
  const targetLen = downsampledBySyncCap ? MAX_SYNC_PTS : rawTargetLen;
  const stepDt = span / (targetLen - 1);

  const time = new Float64Array(targetLen);
  for (let k = 0; k < targetLen; k++) {
    time[k] = k === targetLen - 1 ? overlapEnd : overlapStart + k * stepDt;
  }

  let gapSkippedCount = 0;
  const values = channels.map((ch, cIdx) => {
    const arr = new Float32Array(targetLen);
    const mean = acMeans[cIdx];
    const gapLimit = chTimebases[cIdx].gapThresholdSec;
    for (let k = 0; k < targetLen; k++) {
      const res = sampleSeriesAtTimeStrict(ch.t, ch, time[k], mean, gapLimit);
      arr[k] = res.value;
      if (res.reason === 'gap') gapSkippedCount++;
    }
    return arr;
  });

  let validPairCount = 0;
  let invalidSampleCount = 0;
  for (let k = 0; k < targetLen; k++) {
    let rowValid = true;
    for (let c = 0; c < values.length; c++) {
      if (!Number.isFinite(values[c][k])) {
        rowValid = false;
        break;
      }
    }
    if (rowValid) validPairCount++;
    else invalidSampleCount++;
  }

  if (!allowPartialNaNs && invalidSampleCount > 0) {
    const invalidChannelIndex = values.findIndex((arr) => arr.some((value) => !Number.isFinite(value)));
    const msg = `通道 "${channels[Math.max(0, invalidChannelIndex)].name}" 在公共时间轴对齐后含 NaN/Inf 样本（可能存在采样缺口或无效测量值），已阻止基于不完整波形输出确定性诊断。`;
    return {
      valid: false,
      invalidReason: msg,
      time: new Float64Array(0),
      values: channels.map(() => new Float32Array(0)),
      resampled: true,
      overlapStart,
      overlapEnd,
      warnings: [...warnings, msg],
      validPairCount: 0,
      invalidSampleCount,
      gapSkippedCount,
      coveragePct: 0,
      downsampledBySyncCap,
      sourceMinDtSec: minDt,
      effectiveDtSec: stepDt,
    };
  }

  warnings.push(
    `检测到多通道采样率/时间轴不一致，已线性插值对齐至公共时间窗 [${overlapStart.toExponential(3)}s, ${overlapEnd.toExponential(3)}s] (${targetLen} pts)。`
  );
  if (downsampledBySyncCap) {
    warnings.push(
      `注意：对齐网格需求点数 (${rawTargetLen.toLocaleString()}) 超过单次同步上限 (${MAX_SYNC_PTS.toLocaleString()})，步长已由 ${minDt.toExponential(2)}s 降采样至 ${stepDt.toExponential(2)}s（未作抗混叠预滤波，高频边沿/谐波可能发生混叠或削波）。`
    );
  }
  if (maxDt > minDt * 1.5) {
    warnings.push(
      `注意：低采样率通道（dt≈${maxDt.toExponential(2)}s vs 最密 ${minDt.toExponential(2)}s）仅通过线性插值补点，无法恢复真实高频瞬态与开关边沿带宽。`
    );
  }
  if (gapSkippedCount > 0) {
    warnings.push(`检测到 ${gapSkippedCount} 处采样缺口插值点，已置为 NaN（禁止跨缺口虚构连续信号）。`);
  }

  return {
    valid: true,
    invalidReason: null,
    time,
    values,
    resampled: true,
    overlapStart,
    overlapEnd,
    warnings,
    validPairCount,
    invalidSampleCount,
    gapSkippedCount,
    coveragePct: targetLen > 0 ? (validPairCount / targetLen) * 100 : 0,
    downsampledBySyncCap,
    sourceMinDtSec: minDt,
    effectiveDtSec: stepDt,
  };
}

/**
 * Checks if time array is uniform within tolerance, and resamples uniformly if non-uniform.
 */
export function ensureUniformForSpectral(
  t: Float64Array,
  v: Float32Array,
  fallbackFs: number
): { t: Float64Array; v: Float32Array; sampleRate: number; wasResampled: boolean; gapCount: number } {
  if (t.length !== v.length) {
    throw new Error(`FFT 时间轴与幅值数组长度不一致：t=${t.length}, v=${v.length}。禁止静默截断后继续计算频谱。`);
  }
  if (t.length < 4) {
    throw new Error('FFT 至少需要 4 组一一对应的时间戳和幅值样本。');
  }
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i])) {
      throw new Error(`FFT 幅值在索引 ${i} 处包含 NaN/Inf；频谱分析不得插值修补或将无效样本替换为零。`);
    }
  }
  const tb = inspectTimebase(t, 0, t.length - 1);
  if (!tb.monotonic) {
    throw new Error(
      `FFT 时间轴在索引 ${tb.nonMonotonicIndex ?? '未知'} 处存在 NaN/Inf、重复或倒退时间戳；非单调数据不能直接重采样或计算频谱。`
    );
  }
  if (tb.monotonic && tb.isUniform && tb.dtMedian > 0) {
    return { t, v, sampleRate: 1 / tb.dtMedian, wasResampled: false, gapCount: 0 };
  }
  const resampled = resampleUniform(t, v, { allowGapInterpolation: false });
  return {
    t: resampled.t,
    v: resampled.v,
    sampleRate: resampled.fs > 0 ? resampled.fs : fallbackFs,
    wasResampled: true,
    gapCount: resampled.gapIndices.length,
  };
}
