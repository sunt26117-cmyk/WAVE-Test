/**
 * Waveform Viewer Pro - Multi-Channel Timebase Verification & Synchronization
 * Ensures multi-channel transforms, phase diagnostics, power integrals, and thermal
 * evaluators never blindly multiply/compare mismatched or non-monotonic arrays by index.
 */

import { WaveformChannel } from '../types/models';
import { computeChannelMean, getChannelDisplayValue } from './oscilloscopeScale';
import { resampleUniform } from './resampler';

export interface TimebaseCheckResult {
  monotonic: boolean;
  nonMonotonicIndex: number | null;
  isUniform: boolean;
  dtMin: number;
  dtMax: number;
  dtMedian: number;
}

export function inspectTimebase(t: Float64Array, startIdx = 0, endIdx = t.length - 1): TimebaseCheckResult {
  const i0 = Math.max(0, startIdx);
  const i1 = Math.min(t.length - 1, endIdx);
  if (i1 - i0 < 1) {
    return { monotonic: true, nonMonotonicIndex: null, isUniform: true, dtMin: 0, dtMax: 0, dtMedian: 0 };
  }

  const dts: number[] = [];
  let monotonic = true;
  let nonMonotonicIndex: number | null = null;
  let dtMin = Infinity;
  let dtMax = -Infinity;

  for (let i = i0; i <= i1; i++) {
    if (!Number.isFinite(t[i])) {
      return { monotonic: false, nonMonotonicIndex: i, isUniform: false, dtMin: 0, dtMax: 0, dtMedian: 0 };
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
    return { monotonic: false, nonMonotonicIndex, isUniform: false, dtMin: 0, dtMax: 0, dtMedian: 0 };
  }

  dts.sort((a, b) => a - b);
  const mid = dts.length >> 1;
  const dtMedian = dts.length % 2 === 0 ? 0.5 * (dts[mid - 1] + dts[mid]) : dts[mid];
  const isUniform = dtMedian > 0 && dtMax <= dtMin * 1.05 + 1e-15;

  return { monotonic, nonMonotonicIndex, isUniform, dtMin, dtMax, dtMedian };
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
    if (Math.abs(tA[i] - tB[i]) > absTol) return false;
  }
  return true;
}

export function sampleSeriesAtTime(
  tArr: Float64Array,
  ch: WaveformChannel,
  targetT: number,
  acMean: number
): number {
  if (tArr.length !== ch.v.length) return Number.NaN;
  const n = tArr.length;
  if (n === 0) return Number.NaN;
  if (targetT < tArr[0] || targetT > tArr[n - 1]) return Number.NaN;
  if (targetT === tArr[0]) return getChannelDisplayValue(ch, 0, acMean);
  if (targetT === tArr[n - 1]) return getChannelDisplayValue(ch, n - 1, acMean);

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tArr[mid] <= targetT) lo = mid;
    else hi = mid;
  }
  const dt = tArr[hi] - tArr[lo];
  const v0 = getChannelDisplayValue(ch, lo, acMean);
  const v1 = getChannelDisplayValue(ch, hi, acMean);
  if (!Number.isFinite(v0) || !Number.isFinite(v1)) return Number.NaN;
  const frac = dt > 1e-18 ? (targetT - tArr[lo]) / dt : 0;
  return v0 + frac * (v1 - v0);
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
  gapFactor = 3.5
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

function classifyChannelSiUnit(unitRaw: string | undefined): { domain: string; baseUnit: string; scale: number } | null {
  const u = (unitRaw || '').trim();
  if (!u) return null;
  if (/^([µμu]|m|k)?v(olts?)?$/i.test(u)) {
    const low = u.toLowerCase();
    const scale = low.startsWith('mv') ? 1e-3 : low.startsWith('uv') || low.startsWith('µv') || low.startsWith('μv') ? 1e-6 : low.startsWith('kv') ? 1e3 : 1;
    return { domain: 'voltage', baseUnit: 'V', scale };
  }
  if (/^([µμu]|m|k)?a(mps?)?$/i.test(u)) {
    const low = u.toLowerCase();
    const scale = low.startsWith('ma') ? 1e-3 : low.startsWith('ua') || low.startsWith('µa') || low.startsWith('μa') ? 1e-6 : low.startsWith('ka') ? 1e3 : 1;
    return { domain: 'current', baseUnit: 'A', scale };
  }
  if (/^([µμu]|m|k)?w(atts?)?$/i.test(u)) {
    const low = u.toLowerCase();
    const scale = low.startsWith('mw') ? 1e-3 : low.startsWith('uw') || low.startsWith('µw') || low.startsWith('μw') ? 1e-6 : low.startsWith('kw') ? 1e3 : 1;
    return { domain: 'power', baseUnit: 'W', scale };
  }
  if (/^(°c|degc|c|celsius)$/i.test(u)) {
    return { domain: 'temperature', baseUnit: '°C', scale: 1 };
  }
  if (/^(%|pct|percent)$/i.test(u)) {
    return { domain: 'percent', baseUnit: '%', scale: 1 };
  }
  return { domain: `raw:${u.toLowerCase()}`, baseUnit: u, scale: 1 };
}

export function resolveCompatibleSiGroupScale(channels: WaveformChannel[]): SiGroupScaleResult {
  if (channels.length === 0) {
    return { valid: true, baseUnit: 'V', scales: [], normalizedNote: null, reason: null };
  }
  const parsed = channels.map((ch) => classifyChannelSiUnit(ch.unit));
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

/**
 * Aligns multiple channels onto a single synchronized timebase within their true
 * overlapping time range (with linear interpolation and zero out-of-range extrapolation).
 * Fails closed (valid = false) on ANY non-monotonic, duplicate, or NaN/Inf timestamps.
 */
export function alignChannelsToCommonTimebase(
  channels: WaveformChannel[],
  tStart?: number,
  tEnd?: number
): AlignedChannelsResult {
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
    };
  }

  const warnings: string[] = [];
  let overlapStart = tStart !== undefined && Number.isFinite(tStart) ? tStart : -Infinity;
  let overlapEnd = tEnd !== undefined && Number.isFinite(tEnd) ? tEnd : Infinity;

  for (const ch of channels) {
    if (ch.t.length !== ch.v.length) {
      const msg = `通道 "${ch.name}" 时间戳 ${ch.t.length} 点、幅值 ${ch.v.length} 点，数据一一对应关系已破坏，拒绝静默截断后继续多通道计算。`;
      return {
        valid: false,
        invalidReason: msg,
        time: new Float64Array(0),
        values: channels.map(() => new Float32Array(0)),
        resampled: false,
        overlapStart: 0,
        overlapEnd: 0,
        warnings: [msg],
      };
    }
    const n = ch.t.length;
    if (n < 2) {
      const msg = `通道 "${ch.name}" 有效样本不足 (<2 点)，无法进行多通道物理运算。`;
      return {
        valid: false,
        invalidReason: msg,
        time: new Float64Array(0),
        values: channels.map(() => new Float32Array(0)),
        resampled: false,
        overlapStart: 0,
        overlapEnd: 0,
        warnings: [msg],
      };
    }
    const tb = inspectTimebase(ch.t, 0, n - 1);
    if (!tb.monotonic) {
      const msg = `通道 "${ch.name}" 时间轴在索引 ${tb.nonMonotonicIndex} 处存在非单调递增、重复时间戳 (dt=0) 或 NaN/Inf，已强制 INVALID 拦截（禁止按数组下标或二分插值继续计算）。`;
      return {
        valid: false,
        invalidReason: msg,
        time: new Float64Array(0),
        values: channels.map(() => new Float32Array(0)),
        resampled: false,
        overlapStart: 0,
        overlapEnd: 0,
        warnings: [msg],
      };
    }
    const invalidSampleIndex = ch.v.findIndex((value) => !Number.isFinite(value));
    if (invalidSampleIndex >= 0) {
      const msg = `通道 "${ch.name}" 的原始幅值在索引 ${invalidSampleIndex} 处包含 NaN/Inf；拒绝在重采样时跳过或插值修补无效样本。`;
      return {
        valid: false, invalidReason: msg, time: new Float64Array(0),
        values: channels.map(() => new Float32Array(0)), resampled: false,
        overlapStart: 0, overlapEnd: 0, warnings: [msg],
      };
    }
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
    const invalidChannelIndex = values.findIndex((arr) => arr.some((value) => !Number.isFinite(value)));
    if (invalidChannelIndex >= 0) {
      const msg = `通道 "${channels[invalidChannelIndex].name}" 在同步门控区间内含 NaN/Inf 幅值样本；缺失数据可能包含瞬态峰值，已阻止生成有效多通道分析结果。`;
      return {
        valid: false,
        invalidReason: msg,
        time: new Float64Array(0),
        values: channels.map(() => new Float32Array(0)),
        resampled: false,
        overlapStart,
        overlapEnd,
        warnings: [...warnings, msg],
      };
    }
    return { valid: true, invalidReason: null, time, values, resampled: false, overlapStart, overlapEnd, warnings };
  }

  // Build synchronized reference grid from densest channel median dt inside [overlapStart, overlapEnd]
  const dtList = channels.map((ch) => {
    const n = ch.t.length;
    const tb = inspectTimebase(ch.t, 0, n - 1);
    return tb.dtMedian > 0 ? tb.dtMedian : (ch.t[n - 1] - ch.t[0]) / Math.max(1, n - 1);
  });
  const minDt = Math.max(1e-12, Math.min(...dtList.filter((d) => Number.isFinite(d) && d > 0)));
  const maxDt = Math.max(...dtList.filter((d) => Number.isFinite(d) && d > 0));
  const span = overlapEnd - overlapStart;
  const MAX_SYNC_PTS = 262144;
  let targetLen = Math.max(2, Math.round(span / minDt) + 1);
  if (targetLen > MAX_SYNC_PTS) targetLen = MAX_SYNC_PTS;
  const stepDt = span / (targetLen - 1);

  const time = new Float64Array(targetLen);
  for (let k = 0; k < targetLen; k++) {
    time[k] = k === targetLen - 1 ? overlapEnd : overlapStart + k * stepDt;
  }

  const values = channels.map((ch, cIdx) => {
    const arr = new Float32Array(targetLen);
    const mean = acMeans[cIdx];
    for (let k = 0; k < targetLen; k++) {
      arr[k] = sampleSeriesAtTime(ch.t, ch, time[k], mean);
    }
    return arr;
  });

  const invalidChannelIndex = values.findIndex((arr) => arr.some((value) => !Number.isFinite(value)));
  if (invalidChannelIndex >= 0) {
    const msg = `通道 "${channels[invalidChannelIndex].name}" 在公共时间轴对齐后含 NaN/Inf 样本（可能存在采样缺口或无效测量值），已阻止基于不完整波形输出确定性诊断。`;
    return {
      valid: false,
      invalidReason: msg,
      time: new Float64Array(0),
      values: channels.map(() => new Float32Array(0)),
      resampled: true,
      overlapStart,
      overlapEnd,
      warnings: [...warnings, msg],
    };
  }

  warnings.push(
    `检测到多通道采样率/时间轴不一致，已线性插值对齐至公共时间窗 [${overlapStart.toExponential(3)}s, ${overlapEnd.toExponential(3)}s] (${targetLen} pts)。`
  );
  if (maxDt > minDt * 1.5) {
    warnings.push(
      `注意：低采样率通道（dt≈${maxDt.toExponential(2)}s vs 最密 ${minDt.toExponential(2)}s）仅通过线性插值补点，无法恢复真实高频瞬态与开关边沿带宽。`
    );
  }

  return { valid: true, invalidReason: null, time, values, resampled: true, overlapStart, overlapEnd, warnings };
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
