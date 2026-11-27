/**
 * Waveform Viewer Pro - Cross-File / Cross-Channel Waveform Comparison Engine
 * - Binary-search linear interpolation for arbitrary sampling rates & non-uniform timestamps
 * - Auto time-alignment: Rising Edge, Global Peak, and Normalized Cross-Correlation
 * - Quantitative error metrics: RMSE, MAE, Max |Δ| + timestamp, Pearson correlation r
 */

import { WaveformChannel } from '../types/models';
import { computeChannelMean, getChannelDisplayValue } from './oscilloscopeScale';
import { previewCsv, parseFullCsv } from '../parsers/csvParser';
import { parseWfmBuffer } from '../parsers/wfmParser';
import {
  parseLtspiceRawBuffer,
  isLtspiceExportText,
  parseLtspiceText,
} from '../parsers/ltspiceParser';
import { computeTemporalCoverage } from './temporalCompare';
import {
  DEFAULT_SAMPLING_GAP_FACTOR,
  resolveUnitPairCompatibility,
  sampleSeriesAtTimeStrict,
  validateChannelIntegrity,
} from './timeSync';

export interface CompareGroupTheme {
  id: string;
  label: string;
  badgeColor: string;
  familyShades: string[];
}

export const COMPARE_GROUP_THEMES: CompareGroupTheme[] = [
  {
    id: 'emerald',
    label: 'Emerald',
    badgeColor: '#34d399',
    familyShades: ['#34d399', '#10b981', '#6ee7b7', '#2dd4bf', '#059669', '#a7f3d0', '#14b8a6', '#4ade80'],
  },
  {
    id: 'cyan',
    label: 'Cyan',
    badgeColor: '#22d3ee',
    familyShades: ['#22d3ee', '#38bdf8', '#67e8f9', '#06b6d4', '#7dd3fc', '#0ea5e9', '#a5f3fc', '#0284c7'],
  },
  {
    id: 'amber',
    label: 'Amber',
    badgeColor: '#fbbf24',
    familyShades: ['#fbbf24', '#f59e0b', '#fcd34d', '#fb923c', '#f97316', '#fde68a', '#fdba74', '#eab308'],
  },
  {
    id: 'violet',
    label: 'Violet',
    badgeColor: '#a78bfa',
    familyShades: ['#a78bfa', '#c084fc', '#818cf8', '#c4b5fd', '#8b5cf6', '#e879f9', '#d8b4fe', '#6366f1'],
  },
  {
    id: 'rose',
    label: 'Rose',
    badgeColor: '#fb7185',
    familyShades: ['#fb7185', '#f43f5e', '#fda4af', '#f472b6', '#ec4899', '#fecdd3', '#f9a8d4', '#e11d48'],
  },
  {
    id: 'blue',
    label: 'Blue',
    badgeColor: '#60a5fa',
    familyShades: ['#60a5fa', '#3b82f6', '#93c5fd', '#818cf8', '#2563eb', '#bfdbfe', '#a5b4fc', '#1d4ed8'],
  },
];

export const DISTINCT_COMPARE_PALETTE = [
  '#22d3ee',
  '#fb923c',
  '#a78bfa',
  '#4ade80',
  '#f472b6',
  '#38bdf8',
  '#facc15',
  '#fb7185',
];

export function getCompareGroupTraceColor(
  themeId: string,
  indexInGroup: number,
  paletteMode: 'family' | 'distinct'
): string {
  if (paletteMode === 'distinct') {
    return DISTINCT_COMPARE_PALETTE[indexInGroup % DISTINCT_COMPARE_PALETTE.length];
  }
  const theme = COMPARE_GROUP_THEMES.find((t) => t.id === themeId) || COMPARE_GROUP_THEMES[0];
  return theme.familyShades[indexInGroup % theme.familyShades.length];
}

export type CompareStatus = 'OK' | 'INVALID' | 'INSUFFICIENT_DATA';

export interface AlignedCompareResult {
  valid: boolean;
  status: CompareStatus;
  invalidReason?: string | null;
  alignedRefV: Float32Array;
  diffV: Float32Array;
  overlapCount: number;
  totalTargetSamples: number;
  invalidCount: number;
  gapSkippedCount: number;
  coveragePct: number;
  coveredDurationSec: number;
  targetDurationSec: number;
  unitScaleApplied: number;
  targetMeanApplied: number;
  refMeanApplied: number;
  /** Union of both source time grids in target seconds; preserves fast reference edges between target samples. */
  metricT?: Float64Array;
  metricTargetV?: Float64Array;
  metricRefV?: Float64Array;
  metricIntervalValid?: Uint8Array;
  metricGridWarning?: string;
}

export interface WaveformCompareMetrics {
  valid: boolean;
  status: CompareStatus;
  invalidReason?: string | null;
  comparedSamples: number;
  totalSamples: number;
  invalidCount: number;
  coveragePct: number;
  coveredDurationSec: number;
  targetDurationSec: number;
  rmse: number | null;
  mae: number | null;
  maxAbsDiff: number | null;
  maxAbsDiffTime: number | null;
  maxAbsDiffIndex: number | null;
  correlation: number | null;
  similarityPct: number | null;
  targetVpp: number | null;
  refVpp: number | null;
}

function sampleRefAtTime(
  refT: Float64Array,
  refCh: WaveformChannel,
  refMean: number,
  qTime: number,
  gapThresholdSec = Infinity
): { value: number; isGap: boolean } {
  const res = sampleSeriesAtTimeStrict(refT, refCh, qTime, refMean, gapThresholdSec);
  return { value: res.value, isGap: res.reason === 'gap' };
}

/**
 * Fast deterministic content fingerprint (fileName + byte length + dual 32-bit FNV-1a/djb2 hash)
 * to prevent loading identical filename + identical content multiple times.
 */
export function computeBufferFingerprint(fileName: string, buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  const len = bytes.length;
  // Full pass up to 8 MB; fast strided + head/tail beyond that for instant responsiveness
  if (len <= 8 * 1024 * 1024) {
    for (let i = 0; i < len; i++) {
      const b = bytes[i];
      h1 ^= b;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 = ((h2 << 5) + h2 + b) >>> 0;
    }
  } else {
    const step = Math.max(1, Math.floor(len / 500000));
    for (let i = 0; i < len; i += step) {
      const b = bytes[i];
      h1 ^= b;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 = ((h2 << 5) + h2 + b) >>> 0;
    }
  }
  return `${fileName}::${len}::${h1.toString(16)}_${h2.toString(16)}`;
}

export function computeTextFingerprint(fileName: string, text: string): string {
  const encoded = new TextEncoder().encode(text);
  return computeBufferFingerprint(fileName, encoded.buffer);
}

export async function computeFileFingerprint(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  return computeBufferFingerprint(file.name, buf);
}

/**
 * Detects whether two channels have a large time-span / step mismatch (e.g. ms vs s, 1000x).
 * Returns recommended timeScale (e.g. 0.001 or durT/durR) when ratio >= 10x or <= 0.1x; otherwise 1.
 */
export function detectRecommendedTimeScale(
  targetCh: WaveformChannel,
  refCh: WaveformChannel
): { timeScale: number; ratio: number; isLargeMismatch: boolean } {
  const nT = targetCh.t.length;
  const nR = refCh.t.length;
  if (nT < 2 || nR < 2) return { timeScale: 1, ratio: 1, isLargeMismatch: false };

  const durT = Math.abs(targetCh.t[nT - 1] - targetCh.t[0]);
  const durR = Math.abs(refCh.t[nR - 1] - refCh.t[0]);
  if (durT <= 1e-18 || durR <= 1e-18) return { timeScale: 1, ratio: 1, isLargeMismatch: false };

  const ratio = durR / durT;
  const isLargeMismatch = ratio >= 10 || ratio <= 0.1;
  if (!isLargeMismatch) {
    return { timeScale: 1, ratio, isLargeMismatch: false };
  }

  // Snap to clean metric decade if within 8% (handles ms vs s, us vs ms, us vs s cleanly)
  const decades = [1e-9, 1e-6, 1e-3, 1e3, 1e6, 1e9];
  const exactScale = durT / durR;
  for (const d of decades) {
    if (Math.abs(exactScale - d) / d <= 0.08) {
      return { timeScale: d, ratio, isLargeMismatch: true };
    }
  }
  return { timeScale: exactScale, ratio, isLargeMismatch: true };
}

interface CompareMetricGrid {
  metricT: Float64Array;
  metricTargetV: Float64Array;
  metricRefV: Float64Array;
  metricIntervalValid: Uint8Array;
}

/**
 * Builds the union of the target and transformed reference breakpoints. Sampling only on
 * the target grid can completely miss a short pulse/edge in a faster reference recording.
 * This grid keeps every piecewise-linear knot from both captures, while rejecting intervals
 * whose midpoint falls inside a NaN or acquisition gap in either source.
 */
function buildCompareMetricGrid(
  targetCh: WaveformChannel,
  refCh: WaveformChannel,
  timeShiftSec: number,
  timeScale: number,
  refScaleToTarget: number,
  targetGapSec: number,
  refGapSec: number
): CompareMetricGrid | null {
  const targetT = targetCh.t;
  const refT = refCh.t;
  const refT0 = refT[0];
  const targetStart = targetT[0];
  const targetEnd = targetT[targetT.length - 1];
  const refStart = refT0 + timeShiftSec;
  const refEnd = refT0 + (refT[refT.length - 1] - refT0) * timeScale + timeShiftSec;
  const commonStart = Math.max(targetStart, refStart);
  const commonEnd = Math.min(targetEnd, refEnd);
  if (!(commonEnd > commonStart)) return null;

  const maxCount = targetT.length + refT.length + 2;
  // Avoid an unbounded second copy for very large imported files. The caller retains the
  // target-grid result and surfaces the fact that full union-knot evaluation was skipped.
  if (maxCount > 2_500_000) return null;
  const merged = new Float64Array(maxCount);
  let count = 0;
  const append = (value: number) => {
    if (!Number.isFinite(value) || value < commonStart || value > commonEnd) return;
    if (count === 0) {
      merged[count++] = value;
      return;
    }
    const last = merged[count - 1];
    const tol = Math.max(1e-14, 4 * Number.EPSILON * Math.max(Math.abs(value), Math.abs(last)));
    if (value - last > tol) merged[count++] = value;
  };
  append(commonStart);

  const lowerBound = (arr: Float64Array, value: number): number => {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  let i = lowerBound(targetT, commonStart);
  const queryStart = refT0 + (commonStart - timeShiftSec - refT0) / timeScale;
  let j = lowerBound(refT, queryStart);
  while (i < targetT.length || j < refT.length) {
    const nextTarget = i < targetT.length ? targetT[i] : Infinity;
    const nextRef = j < refT.length
      ? refT0 + (refT[j] - refT0) * timeScale + timeShiftSec
      : Infinity;
    const next = Math.min(nextTarget, nextRef);
    if (!(next < commonEnd)) break;
    append(next);
    const tol = Math.max(1e-14, 4 * Number.EPSILON * Math.max(Math.abs(next), 1));
    if (Number.isFinite(nextTarget) && Math.abs(nextTarget - next) <= tol) i++;
    if (Number.isFinite(nextRef) && Math.abs(nextRef - next) <= tol) j++;
  }
  append(commonEnd);
  const metricT = merged.slice(0, count);
  if (metricT.length < 2) return null;

  const targetMean = targetCh.coupling === 'AC' ? computeChannelMean(targetCh) : 0;
  const refMean = refCh.coupling === 'AC' ? computeChannelMean(refCh) : 0;
  const metricTargetV = new Float64Array(metricT.length);
  const metricRefV = new Float64Array(metricT.length);
  metricTargetV.fill(Number.NaN);
  metricRefV.fill(Number.NaN);

  // The union grid is sorted, so monotonic cursors keep interpolation O(N), rather than
  // performing a binary search for every knot in both channels and again at every midpoint.
  const makeSequentialSampler = (
    times: Float64Array,
    ch: WaveformChannel,
    mean: number,
    gapThresholdSec: number
  ) => {
    let cursor = 0;
    return (qTime: number): { value: number; reason: 'ok' | 'out-of-range' | 'gap' | 'nan' | 'invalid' } => {
      const n = times.length;
      if (!Number.isFinite(qTime) || n === 0) return { value: Number.NaN, reason: 'invalid' };
      if (qTime < times[0] || qTime > times[n - 1]) return { value: Number.NaN, reason: 'out-of-range' };
      if (n === 1) {
        const value = getChannelDisplayValue(ch, 0, mean);
        return Number.isFinite(value) ? { value, reason: 'ok' } : { value: Number.NaN, reason: 'nan' };
      }
      while (cursor < n - 2 && times[cursor + 1] < qTime) cursor++;
      const t0 = times[cursor], t1 = times[cursor + 1];
      const tol = 1e-15 * Math.max(1, Math.abs(qTime));
      if (Math.abs(qTime - t0) <= tol) {
        const value = getChannelDisplayValue(ch, cursor, mean);
        return Number.isFinite(value) ? { value, reason: 'ok' } : { value: Number.NaN, reason: 'nan' };
      }
      if (Math.abs(qTime - t1) <= tol) {
        const value = getChannelDisplayValue(ch, cursor + 1, mean);
        return Number.isFinite(value) ? { value, reason: 'ok' } : { value: Number.NaN, reason: 'nan' };
      }
      const dt = t1 - t0;
      if (!(dt > 0) || !Number.isFinite(dt)) return { value: Number.NaN, reason: 'invalid' };
      if (dt > gapThresholdSec) return { value: Number.NaN, reason: 'gap' };
      const v0 = getChannelDisplayValue(ch, cursor, mean);
      const v1 = getChannelDisplayValue(ch, cursor + 1, mean);
      if (!Number.isFinite(v0) || !Number.isFinite(v1)) return { value: Number.NaN, reason: 'nan' };
      const frac = (qTime - t0) / dt;
      return { value: v0 + frac * (v1 - v0), reason: 'ok' };
    };
  };
  const sampleTarget = makeSequentialSampler(targetT, targetCh, targetMean, targetGapSec);
  const sampleRef = makeSequentialSampler(refT, refCh, refMean, refGapSec);
  const sampleBoth = (time: number) => {
    const targetSample = sampleTarget(time);
    const refQuery = refT0 + (time - timeShiftSec - refT0) / timeScale;
    const refSample = sampleRef(refQuery);
    return {
      target: targetSample.value,
      reference: Number.isFinite(refSample.value) ? refSample.value * refScaleToTarget : Number.NaN,
      valid: targetSample.reason === 'ok' && refSample.reason === 'ok' &&
        Number.isFinite(targetSample.value) && Number.isFinite(refSample.value),
    };
  };

  for (let k = 0; k < metricT.length; k++) {
    const sampled = sampleBoth(metricT[k]);
    if (sampled.valid) {
      metricTargetV[k] = sampled.target;
      metricRefV[k] = sampled.reference;
    }
  }

  const metricIntervalValid = new Uint8Array(metricT.length - 1);
  const sampleTargetMid = makeSequentialSampler(targetT, targetCh, targetMean, targetGapSec);
  const sampleRefMid = makeSequentialSampler(refT, refCh, refMean, refGapSec);
  for (let k = 0; k < metricIntervalValid.length; k++) {
    const dt = metricT[k + 1] - metricT[k];
    if (!(dt > 0) || !Number.isFinite(dt) ||
        !Number.isFinite(metricTargetV[k]) || !Number.isFinite(metricTargetV[k + 1]) ||
        !Number.isFinite(metricRefV[k]) || !Number.isFinite(metricRefV[k + 1])) continue;
    // Midpoint validation is deliberate: finite endpoints do not prove that the segment
    // between them is valid if the original capture contains a dropped-sample gap.
    const mid = (metricT[k] + metricT[k + 1]) / 2;
    const targetMid = sampleTargetMid(mid);
    const refQuery = refT0 + (mid - timeShiftSec - refT0) / timeScale;
    const refMid = sampleRefMid(refQuery);
    if (targetMid.reason === 'ok' && refMid.reason === 'ok') metricIntervalValid[k] = 1;
  }

  return { metricT, metricTargetV, metricRefV, metricIntervalValid };
}

/**
 * Aligns refCh onto targetCh.t grid with optional timeShiftSec (ref shifted forward by +timeShiftSec),
 * optional timeScale (scales ref relative to refCh.t[0], e.g. 0.001 for ms->s), SI unit normalization,
 * and optional DC offset removal. Strictly rejects mismatched/non-monotonic/cross-dimension inputs.
 */
export function alignAndInterpolateReference(
  targetCh: WaveformChannel,
  refCh: WaveformChannel,
  timeShiftSec: number = 0,
  removeDcOffset: boolean = false,
  timeScale: number = 1
): AlignedCompareResult {
  const tgtIntegrity = validateChannelIntegrity(targetCh, 1, DEFAULT_SAMPLING_GAP_FACTOR);
  const refIntegrity = validateChannelIntegrity(refCh, 1, DEFAULT_SAMPLING_GAP_FACTOR);
  const nT = targetCh?.t?.length || 0;
  const alignedRefV = new Float32Array(tgtIntegrity.valid ? nT : 0);
  const diffV = new Float32Array(tgtIntegrity.valid ? nT : 0);
  alignedRefV.fill(NaN);
  diffV.fill(NaN);

  if (!tgtIntegrity.valid || !refIntegrity.valid) {
    return {
      valid: false,
      status: 'INVALID',
      invalidReason: tgtIntegrity.invalidReason || refIntegrity.invalidReason || 'Invalid channel integrity.',
      alignedRefV,
      diffV,
      overlapCount: 0,
      totalTargetSamples: tgtIntegrity.valid ? nT : 0,
      invalidCount: tgtIntegrity.valid ? nT : 0,
      gapSkippedCount: 0,
      coveragePct: 0,
      coveredDurationSec: 0,
      targetDurationSec: nT >= 2 ? Math.max(0, targetCh.t[nT - 1] - targetCh.t[0]) : 0,
      unitScaleApplied: 1,
      targetMeanApplied: 0,
      refMeanApplied: 0,
    };
  }

  const unitCheck = resolveUnitPairCompatibility(targetCh.unit, refCh.unit);
  if (!unitCheck.compatible) {
    return {
      valid: false,
      status: 'INVALID',
      invalidReason: unitCheck.reason || `Incompatible units: ${targetCh.unit} vs ${refCh.unit}`,
      alignedRefV,
      diffV,
      overlapCount: 0,
      totalTargetSamples: nT,
      invalidCount: nT,
      gapSkippedCount: 0,
      coveragePct: 0,
      coveredDurationSec: 0,
      targetDurationSec: nT >= 2 ? Math.max(0, targetCh.t[nT - 1] - targetCh.t[0]) : 0,
      unitScaleApplied: 1,
      targetMeanApplied: 0,
      refMeanApplied: 0,
    };
  }

  const refScaleToTarget = unitCheck.scaleBToA;
  const safeScale = isFinite(timeScale) && timeScale > 0 ? timeScale : 1;
  const refT0 = refCh.t[0];
  const refGapLimit = refIntegrity.timebase.gapThresholdSec;
  const targetAcMean = targetCh.coupling === 'AC' ? computeChannelMean(targetCh) : 0;
  const refAcMean = refCh.coupling === 'AC' ? computeChannelMean(refCh) : 0;

  let overlapCount = 0;
  let invalidCount = 0;
  let gapSkippedCount = 0;

  for (let i = 0; i < nT; i++) {
    const tv = getChannelDisplayValue(targetCh, i, targetAcMean);
    const qRefTime = refT0 + (targetCh.t[i] - timeShiftSec - refT0) / safeScale;
    const sampled = sampleRefAtTime(refCh.t, refCh, refAcMean, qRefTime, refGapLimit);
    const rv = isFinite(sampled.value) ? sampled.value * refScaleToTarget : NaN;
    if (sampled.isGap) gapSkippedCount++;
    if (isFinite(tv) && isFinite(rv)) {
      alignedRefV[i] = rv;
      overlapCount++;
    } else {
      invalidCount++;
    }
  }

  const validMask = new Uint8Array(nT);
  for (let i = 0; i < nT; i++) {
    const tv = getChannelDisplayValue(targetCh, i, targetAcMean);
    validMask[i] = Number.isFinite(tv) && Number.isFinite(alignedRefV[i]) ? 1 : 0;
  }
  const temporalCoverage = computeTemporalCoverage(
    targetCh.t,
    validMask,
    tgtIntegrity.timebase.gapThresholdSec
  );

  let targetShift = 0;
  let refShift = 0;
  if (removeDcOffset && temporalCoverage.coveredDurationSec > 0) {
    let targetIntegral = 0;
    let refIntegral = 0;
    for (const i of temporalCoverage.intervalIndices) {
      const dt = targetCh.t[i + 1] - targetCh.t[i];
      const tv0 = getChannelDisplayValue(targetCh, i, targetAcMean);
      const tv1 = getChannelDisplayValue(targetCh, i + 1, targetAcMean);
      const rv0 = alignedRefV[i];
      const rv1 = alignedRefV[i + 1];
      targetIntegral += dt * (tv0 + tv1) / 2;
      refIntegral += dt * (rv0 + rv1) / 2;
    }
    targetShift = targetIntegral / temporalCoverage.coveredDurationSec;
    refShift = refIntegral / temporalCoverage.coveredDurationSec;
  }

  for (let i = 0; i < nT; i++) {
    const rv = alignedRefV[i];
    if (!isFinite(rv)) continue;
    const tv = getChannelDisplayValue(targetCh, i, targetAcMean) - targetShift;
    const adjR = rv - refShift;
    if (removeDcOffset) alignedRefV[i] = adjR + targetShift;
    diffV[i] = tv - adjR;
  }
  const metricGridLimitExceeded = targetCh.t.length + refCh.t.length + 2 > 2_500_000;
  const metricGrid = metricGridLimitExceeded ? null : buildCompareMetricGrid(
    targetCh, refCh, timeShiftSec, safeScale, refScaleToTarget,
    tgtIntegrity.timebase.gapThresholdSec, refIntegrity.timebase.gapThresholdSec
  );
  let coveredDurationSec = temporalCoverage.coveredDurationSec;
  let coveragePct = temporalCoverage.coveragePct;
  let hasEnough = coveredDurationSec > 0 && overlapCount >= 2;
  if (metricGrid) {
    coveredDurationSec = 0;
    let validMetricIntervals = 0;
    for (let i = 0; i < metricGrid.metricIntervalValid.length; i++) {
      if (!metricGrid.metricIntervalValid[i]) continue;
      const dt = metricGrid.metricT[i + 1] - metricGrid.metricT[i];
      if (dt > 0 && Number.isFinite(dt)) {
        coveredDurationSec += dt;
        validMetricIntervals++;
      }
    }
    const targetDuration = Math.max(0, targetCh.t[nT - 1] - targetCh.t[0]);
    coveragePct = targetDuration > 0 ? Math.max(0, Math.min(100, coveredDurationSec / targetDuration * 100)) : 0;
    // A shorter, faster reference may overlap between two coarse target samples. The
    // union-grid interval is still a legitimate comparison interval even when no target
    // sample lands inside it; acceptance is separately controlled by Golden minCoverage.
    hasEnough = coveredDurationSec > 0 && validMetricIntervals > 0;
  }
  if (metricGridLimitExceeded) hasEnough = false;

  return {
    valid: hasEnough,
    status: hasEnough ? 'OK' : 'INSUFFICIENT_DATA',
    invalidReason: hasEnough ? null : metricGridLimitExceeded
      ? '目标与参考数据合计超过 250 万联合时间节点上限。为避免高采样率参考中的窄脉冲被漏检，已阻止本次 Compare/Golden 判定；请缩小分析时间窗后重试。'
      : '没有足够的连续、共同有效时间区间可进行比较（孤立点或采样缺口不计入有效覆盖）。',
    alignedRefV,
    diffV,
    overlapCount,
    totalTargetSamples: nT,
    invalidCount,
    gapSkippedCount,
    coveragePct,
    coveredDurationSec,
    targetDurationSec: temporalCoverage.totalDurationSec,
    unitScaleApplied: refScaleToTarget,
    targetMeanApplied: targetShift,
    refMeanApplied: refShift,
    ...(metricGrid || {}),
    ...(!metricGrid && targetCh.t.length + refCh.t.length > 2_500_000
      ? { metricGridWarning: '目标与参考数据合计超过 250 万联合时间节点上限；本次 Compare/Golden 定量判定已阻止，请缩小分析时间窗后重试。' }
      : {}),
  };
}

export interface MappedReferenceTrace {
  t: Float64Array;
  v: Float32Array;
}

/**
 * Maps all samples of refCh into targetCh's time coordinate frame (applying timeScale,
 * timeShiftSec, SI unit normalization, AC/inverted display conditioning, and optional DC offset alignment)
 * WITHOUT truncating refCh to targetCh's duration, allowing the time axis to extend
 * to the longest imported Compare waveform.
 */
export function buildMappedReferenceTrace(
  targetCh: WaveformChannel,
  refCh: WaveformChannel,
  timeShiftSec: number = 0,
  removeDcOffset: boolean = false,
  timeScale: number = 1,
  targetMeanApplied?: number,
  refMeanApplied?: number
): MappedReferenceTrace {
  const refIntegrity = validateChannelIntegrity(refCh, 1, DEFAULT_SAMPLING_GAP_FACTOR);
  if (!refIntegrity.valid) {
    return { t: new Float64Array(0), v: new Float32Array(0) };
  }
  const unitCheck = resolveUnitPairCompatibility(targetCh.unit, refCh.unit);
  if (!unitCheck.compatible) {
    return { t: new Float64Array(0), v: new Float32Array(0) };
  }
  const refScaleToTarget = unitCheck.scaleBToA;

  const nR = refCh.t.length;
  const mappedT = new Float64Array(nR);
  const mappedV = new Float32Array(nR);

  const safeScale = isFinite(timeScale) && timeScale > 0 ? timeScale : 1;
  const refT0 = refCh.t[0];
  const refAcMean = refCh.coupling === 'AC' ? computeChannelMean(refCh) : 0;

  let targetShift = 0;
  let refShift = 0;
  if (removeDcOffset) {
    if (targetMeanApplied !== undefined && refMeanApplied !== undefined) {
      targetShift = targetMeanApplied;
      refShift = refMeanApplied;
    } else {
      const targetAcMean = targetCh.coupling === 'AC' ? computeChannelMean(targetCh) : 0;
      const nT = Math.min(targetCh.t.length, targetCh.v.length);
      let sT = 0;
      let cT = 0;
      for (let i = 0; i < nT; i++) {
        const tv = getChannelDisplayValue(targetCh, i, targetAcMean);
        if (isFinite(tv)) {
          sT += tv;
          cT++;
        }
      }
      targetShift = cT > 0 ? sT / cT : 0;

      let sR = 0;
      let cR = 0;
      for (let i = 0; i < nR; i++) {
        const rv = getChannelDisplayValue(refCh, i, refAcMean) * refScaleToTarget;
        if (isFinite(rv)) {
          sR += rv;
          cR++;
        }
      }
      refShift = cR > 0 ? sR / cR : 0;
    }
  }

  for (let i = 0; i < nR; i++) {
    mappedT[i] = refT0 + (refCh.t[i] - refT0) * safeScale + timeShiftSec;
    const raw = getChannelDisplayValue(refCh, i, refAcMean) * refScaleToTarget;
    if (!isFinite(raw)) {
      mappedV[i] = NaN;
    } else {
      mappedV[i] = removeDcOffset ? raw - refShift + targetShift : raw;
    }
  }

  return { t: mappedT, v: mappedV };
}

function findFirstRisingCrossingTime(ch: WaveformChannel): number | null {
  const integrity = validateChannelIntegrity(ch, 4, DEFAULT_SAMPLING_GAP_FACTOR);
  if (!integrity.valid) return null;
  const n = ch.t.length;
  const gapThreshold = integrity.timebase.gapThresholdSec;
  const mean = ch.coupling === 'AC' ? computeChannelMean(ch) : 0;
  let mn = Infinity;
  let mx = -Infinity;
  const step = n > 60000 ? Math.floor(n / 30000) : 1;
  for (let i = 0; i < n; i += step) {
    const val = getChannelDisplayValue(ch, i, mean);
    if (isFinite(val)) {
      if (val < mn) mn = val;
      if (val > mx) mx = val;
    }
  }
  const span = mx - mn;
  if (!isFinite(span) || span <= 1e-12) return null;
  const mid = (mx + mn) / 2;
  const hyst = span * 0.06;
  let armed = false;

  for (let i = 1; i < n; i++) {
    const prev = getChannelDisplayValue(ch, i - 1, mean);
    const curr = getChannelDisplayValue(ch, i, mean);
    const dt = ch.t[i] - ch.t[i - 1];
    if (!isFinite(prev) || !isFinite(curr) || (Number.isFinite(gapThreshold) && dt > gapThreshold)) {
      armed = false;
      continue;
    }
    if (prev <= mid - hyst) armed = true;
    if (armed && prev < mid && curr >= mid) {
      const denom = curr - prev;
      const frac = denom > 1e-15 ? (mid - prev) / denom : 0;
      return ch.t[i - 1] + frac * dt;
    }
  }
  return null;
}

function findPeakTime(ch: WaveformChannel): number | null {
  const integrity = validateChannelIntegrity(ch, 1, DEFAULT_SAMPLING_GAP_FACTOR);
  if (!integrity.valid) return null;
  const n = ch.t.length;
  const mean = ch.coupling === 'AC' ? computeChannelMean(ch) : 0;
  let bestIdx = -1;
  let bestVal = -Infinity;
  for (let i = 0; i < n; i++) {
    const val = getChannelDisplayValue(ch, i, mean);
    if (isFinite(val) && val > bestVal) {
      bestVal = val;
      bestIdx = i;
    }
  }
  return bestIdx >= 0 ? ch.t[bestIdx] : null;
}

/**
 * Estimates optimal time shift Δt (in seconds) to align refCh (after optional timeScale) to targetCh.
 */
export function computeAutoTimeAlignShift(
  targetCh: WaveformChannel,
  refCh: WaveformChannel,
  mode: 'start' | 'rising-edge' | 'first-peak' | 'xcorr',
  timeScale: number = 1
): number {
  const tgtInt = validateChannelIntegrity(targetCh, 1, DEFAULT_SAMPLING_GAP_FACTOR);
  const refInt = validateChannelIntegrity(refCh, 1, DEFAULT_SAMPLING_GAP_FACTOR);
  if (!tgtInt.valid || !refInt.valid) return 0;

  const safeScale = isFinite(timeScale) && timeScale > 0 ? timeScale : 1;
  const refT0 = refCh.t[0];

  if (mode === 'start') {
    return targetCh.t[0] - refT0;
  }

  if (mode === 'rising-edge') {
    const tT = findFirstRisingCrossingTime(targetCh);
    const tR = findFirstRisingCrossingTime(refCh);
    if (tT !== null && tR !== null) {
      const mappedTR = refT0 + (tR - refT0) * safeScale;
      return tT - mappedTR;
    }
    return targetCh.t[0] - refT0;
  }

  if (mode === 'first-peak') {
    const tT = findPeakTime(targetCh);
    const tR = findPeakTime(refCh);
    if (tT !== null && tR !== null) {
      const mappedTR = refT0 + (tR - refT0) * safeScale;
      return tT - mappedTR;
    }
    return targetCh.t[0] - refT0;
  }

  // Coarse normalized cross-correlation over scaled duration
  const nT = targetCh.t.length;
  const nR = refCh.t.length;
  if (nT < 8 || nR < 8) return targetCh.t[0] - refT0;

  const t0T = targetCh.t[0];
  const durT = targetCh.t[nT - 1] - t0T;
  const durR = (refCh.t[nR - 1] - refT0) * safeScale;
  if (durT <= 0 || durR <= 0) return t0T - refT0;

  const bins = 512;
  const minDur = Math.min(durT, durR);
  const dtGrid = minDur / bins;
  const meanT = targetCh.coupling === 'AC' ? computeChannelMean(targetCh) : 0;
  const meanR = refCh.coupling === 'AC' ? computeChannelMean(refCh) : 0;
  const tgtGapLimit = tgtInt.timebase.gapThresholdSec;
  const refGapLimit = refInt.timebase.gapThresholdSec;

  const sigT = new Float64Array(bins);
  const sigR = new Float64Array(bins);
  const validT = new Uint8Array(bins);
  const validR = new Uint8Array(bins);
  let avgT = 0;
  let cntT = 0;
  let avgR = 0;
  let cntR = 0;
  for (let i = 0; i < bins; i++) {
    const tv = sampleRefAtTime(targetCh.t, targetCh, meanT, t0T + i * dtGrid, tgtGapLimit).value;
    const rv = sampleRefAtTime(refCh.t, refCh, meanR, refT0 + (i * dtGrid) / safeScale, refGapLimit).value;
    if (isFinite(tv)) {
      sigT[i] = tv;
      validT[i] = 1;
      avgT += tv;
      cntT++;
    }
    if (isFinite(rv)) {
      sigR[i] = rv;
      validR[i] = 1;
      avgR += rv;
      cntR++;
    }
  }
  if (cntT < 4 || cntR < 4) return t0T - refT0;
  avgT /= cntT;
  avgR /= cntR;
  for (let i = 0; i < bins; i++) {
    sigT[i] = validT[i] ? sigT[i] - avgT : 0;
    sigR[i] = validR[i] ? sigR[i] - avgR : 0;
  }

  const maxLag = Math.floor(bins * 0.45);
  let bestLag = 0;
  let bestCorr = -Infinity;

  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let num = 0;
    let dT = 0;
    let dR = 0;
    let pairCnt = 0;
    for (let i = 0; i < bins; i++) {
      const j = i - lag;
      if (j < 0 || j >= bins || !validT[i] || !validR[j]) continue;
      num += sigT[i] * sigR[j];
      dT += sigT[i] * sigT[i];
      dR += sigR[j] * sigR[j];
      pairCnt++;
    }
    const denom = Math.sqrt(dT * dR);
    if (pairCnt >= 8 && denom > 1e-18) {
      const c = num / denom;
      if (c > bestCorr) {
        bestCorr = c;
        bestLag = lag;
      }
    }
  }

  return t0T - refT0 + bestLag * dtGrid;
}

/**
 * Computes RMSE, MAE, Max |Delta|, timestamp of Max |Delta|, and Pearson correlation r.
 */
export function computeWaveformCompareMetrics(
  targetCh: WaveformChannel,
  alignedRefV: Float32Array,
  removeDcOffset: boolean = false,
  alignedContext?: Pick<AlignedCompareResult, 'valid' | 'status' | 'invalidReason' | 'metricT' | 'metricTargetV' | 'metricRefV' | 'metricIntervalValid'>
): WaveformCompareMetrics {
  const mkEmpty = (status: CompareStatus, invalidReason?: string | null, total = 0, invalidCnt = total): WaveformCompareMetrics => ({
    valid: false,
    status,
    invalidReason: invalidReason || null,
    comparedSamples: 0,
    totalSamples: total,
    invalidCount: invalidCnt,
    coveragePct: 0,
    coveredDurationSec: 0,
    targetDurationSec: total >= 2 && targetCh?.t?.length === total ? Math.max(0, targetCh.t[total - 1] - targetCh.t[0]) : 0,
    rmse: null,
    mae: null,
    maxAbsDiff: null,
    maxAbsDiffTime: null,
    maxAbsDiffIndex: null,
    correlation: null,
    similarityPct: null,
    targetVpp: null,
    refVpp: null,
  });

  const metricT = alignedContext?.metricT;
  const metricTargetV = alignedContext?.metricTargetV;
  const metricRefV = alignedContext?.metricRefV;
  const metricIntervalValid = alignedContext?.metricIntervalValid;
  if (metricT && metricTargetV && metricRefV && metricIntervalValid &&
      metricT.length >= 2 && metricTargetV.length === metricT.length &&
      metricRefV.length === metricT.length && metricIntervalValid.length === metricT.length - 1) {
    const targetDurationSec = targetCh?.t?.length >= 2
      ? Math.max(0, targetCh.t[targetCh.t.length - 1] - targetCh.t[0])
      : 0;
    const usedMask = new Uint8Array(metricT.length);
    const validIntervals: number[] = [];
    let duration = 0;
    for (let i = 0; i < metricIntervalValid.length; i++) {
      const dt = metricT[i + 1] - metricT[i];
      if (!metricIntervalValid[i] || !(dt > 0) ||
          !Number.isFinite(metricTargetV[i]) || !Number.isFinite(metricTargetV[i + 1]) ||
          !Number.isFinite(metricRefV[i]) || !Number.isFinite(metricRefV[i + 1])) continue;
      validIntervals.push(i);
      duration += dt;
      usedMask[i] = 1;
      usedMask[i + 1] = 1;
    }
    if (!(duration > 0) || validIntervals.length === 0) {
      return {
        ...mkEmpty('INSUFFICIENT_DATA', '两份记录没有连续、共同有效的时间区间；孤立点和采样缺口不参与比较。', metricT.length, metricT.length),
        targetDurationSec,
      };
    }

    let intT = 0, intR = 0, intT2 = 0, intR2 = 0, intTR = 0;
    let minT = Infinity, maxT = -Infinity, minR = Infinity, maxR = -Infinity;
    let comparedSamples = 0;
    for (let i = 0; i < metricT.length; i++) {
      if (!usedMask[i]) continue;
      comparedSamples++;
      minT = Math.min(minT, metricTargetV[i]); maxT = Math.max(maxT, metricTargetV[i]);
      minR = Math.min(minR, metricRefV[i]); maxR = Math.max(maxR, metricRefV[i]);
    }
    for (const i of validIntervals) {
      const dt = metricT[i + 1] - metricT[i];
      const x0 = metricTargetV[i], x1 = metricTargetV[i + 1];
      const y0 = metricRefV[i], y1 = metricRefV[i + 1];
      intT += dt * (x0 + x1) / 2;
      intR += dt * (y0 + y1) / 2;
      intT2 += dt * (x0 * x0 + x0 * x1 + x1 * x1) / 3;
      intR2 += dt * (y0 * y0 + y0 * y1 + y1 * y1) / 3;
      intTR += dt * (2 * x0 * y0 + x0 * y1 + x1 * y0 + 2 * x1 * y1) / 6;
    }
    const meanT = intT / duration;
    const meanR = intR / duration;
    const dcShift = removeDcOffset ? meanT - meanR : 0;
    let errorSqIntegral = 0, absErrorIntegral = 0, maxAbs = -1, maxAbsTime: number | null = null;
    let maxAbsIndex: number | null = null;
    const nearestTargetIndex = (time: number): number => {
      let lo = 0, hi = targetCh.t.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (targetCh.t[mid] < time) lo = mid + 1;
        else hi = mid;
      }
      if (lo <= 0) return 0;
      if (lo >= targetCh.t.length) return targetCh.t.length - 1;
      return Math.abs(targetCh.t[lo] - time) < Math.abs(targetCh.t[lo - 1] - time) ? lo : lo - 1;
    };
    for (const i of validIntervals) {
      const dt = metricT[i + 1] - metricT[i];
      const x0 = metricTargetV[i], x1 = metricTargetV[i + 1];
      const y0 = metricRefV[i] + dcShift, y1 = metricRefV[i + 1] + dcShift;
      const d0 = x0 - y0, d1 = x1 - y1;
      errorSqIntegral += dt * (d0 * d0 + d0 * d1 + d1 * d1) / 3;
      const a0 = Math.abs(d0), a1 = Math.abs(d1);
      absErrorIntegral += d0 * d1 < 0
        ? dt * (d0 * d0 + d1 * d1) / (2 * (a0 + a1))
        : dt * (a0 + a1) / 2;
      if (a0 > maxAbs) {
        maxAbs = a0; maxAbsTime = metricT[i]; maxAbsIndex = nearestTargetIndex(metricT[i]);
      }
      if (a1 > maxAbs) {
        maxAbs = a1; maxAbsTime = metricT[i + 1]; maxAbsIndex = nearestTargetIndex(metricT[i + 1]);
      }
    }
    const cov = intTR - intT * intR / duration;
    const varT = Math.max(0, intT2 - intT * intT / duration);
    const varR = Math.max(0, intR2 - intR * intR / duration);
    const corrDenom = Math.sqrt(varT * varR);
    const targetVpp = Number.isFinite(maxT - minT) ? maxT - minT : null;
    const refVpp = Number.isFinite(maxR - minR) ? maxR - minR : null;
    const refScale = Math.max(targetVpp || 0, refVpp || 0, 1e-12);
    const rmse = Math.sqrt(Math.max(0, errorSqIntegral / duration));
    const mae = absErrorIntegral / duration;
    return {
      valid: true,
      status: 'OK',
      invalidReason: null,
      comparedSamples,
      totalSamples: metricT.length,
      invalidCount: metricT.length - comparedSamples,
      coveragePct: targetDurationSec > 0 ? Math.max(0, Math.min(100, duration / targetDurationSec * 100)) : 0,
      coveredDurationSec: duration,
      targetDurationSec,
      rmse,
      mae,
      maxAbsDiff: maxAbs >= 0 ? maxAbs : null,
      maxAbsDiffTime: maxAbsTime,
      maxAbsDiffIndex: maxAbsIndex,
      correlation: corrDenom > 1e-18 ? Math.max(-1, Math.min(1, cov / corrDenom)) : null,
      similarityPct: targetVpp !== null && refScale > 1e-12 ? Math.max(0, Math.min(100, (1 - rmse / refScale) * 100)) : null,
      targetVpp,
      refVpp,
    };
  }

  if (alignedContext && !alignedContext.valid && alignedContext.status === 'INVALID') {
    return mkEmpty('INVALID', alignedContext.invalidReason, targetCh?.t?.length || 0);
  }
  const tgtInt = validateChannelIntegrity(targetCh, 1, DEFAULT_SAMPLING_GAP_FACTOR);
  if (!tgtInt.valid) return mkEmpty('INVALID', tgtInt.invalidReason);

  const n = targetCh.t.length;
  if (alignedRefV.length !== n) {
    return mkEmpty('INVALID', `Aligned reference length (${alignedRefV.length}) does not match target length (${n}).`, n);
  }

  const targetAcMean = targetCh.coupling === 'AC' ? computeChannelMean(targetCh) : 0;
  const targetValues = new Float64Array(n);
  const refValues = new Float64Array(n);
  const validMask = new Uint8Array(n);
  let finitePointCount = 0;
  for (let i = 0; i < n; i++) {
    const tv = getChannelDisplayValue(targetCh, i, targetAcMean);
    const rv = alignedRefV[i];
    targetValues[i] = tv;
    refValues[i] = rv;
    if (Number.isFinite(tv) && Number.isFinite(rv)) {
      validMask[i] = 1;
      finitePointCount++;
    }
  }

  const temporal = computeTemporalCoverage(targetCh.t, validMask, tgtInt.timebase.gapThresholdSec);
  const duration = temporal.coveredDurationSec;
  if (!(duration > 0) || temporal.intervalIndices.length === 0) {
    return {
      ...mkEmpty('INSUFFICIENT_DATA', '没有连续有效时间区间；仅有孤立重叠点不能计算有工程意义的 RMSE/MAE。', n, n - finitePointCount),
      coveragePct: temporal.coveragePct,
      coveredDurationSec: 0,
      targetDurationSec: temporal.totalDurationSec,
    };
  }

  // Integrate piecewise-linear signals over time. This prevents densely sampled
  // regions from dominating metrics merely because they contain more samples.
  let intT = 0, intR = 0, intT2 = 0, intR2 = 0, intTR = 0;
  let minT = Infinity, maxT = -Infinity, minR = Infinity, maxR = -Infinity;
  const usedMask = temporal.coveredSampleMask;
  let comparedSamples = 0;
  for (let i = 0; i < n; i++) {
    if (!usedMask[i]) continue;
    comparedSamples++;
    minT = Math.min(minT, targetValues[i]); maxT = Math.max(maxT, targetValues[i]);
    minR = Math.min(minR, refValues[i]); maxR = Math.max(maxR, refValues[i]);
  }
  for (const i of temporal.intervalIndices) {
    const dt = targetCh.t[i + 1] - targetCh.t[i];
    const x0 = targetValues[i], x1 = targetValues[i + 1];
    const y0 = refValues[i], y1 = refValues[i + 1];
    intT += dt * (x0 + x1) / 2;
    intR += dt * (y0 + y1) / 2;
    intT2 += dt * (x0 * x0 + x0 * x1 + x1 * x1) / 3;
    intR2 += dt * (y0 * y0 + y0 * y1 + y1 * y1) / 3;
    intTR += dt * (2 * x0 * y0 + x0 * y1 + x1 * y0 + 2 * x1 * y1) / 6;
  }
  const meanT = intT / duration;
  const meanR = intR / duration;
  const dcShift = removeDcOffset ? meanT - meanR : 0;
  let errorSqIntegral = 0;
  let absErrorIntegral = 0;
  let maxAbs = -1;
  let maxIdx = 0;
  for (const i of temporal.intervalIndices) {
    const dt = targetCh.t[i + 1] - targetCh.t[i];
    const x0 = targetValues[i], x1 = targetValues[i + 1];
    const y0 = refValues[i] + dcShift, y1 = refValues[i + 1] + dcShift;
    const d0 = x0 - y0, d1 = x1 - y1;
    errorSqIntegral += dt * (d0 * d0 + d0 * d1 + d1 * d1) / 3;
    const a0 = Math.abs(d0), a1 = Math.abs(d1);
    absErrorIntegral += d0 * d1 < 0
      ? dt * (d0 * d0 + d1 * d1) / (2 * (a0 + a1))
      : dt * (a0 + a1) / 2;
    if (a0 > maxAbs) { maxAbs = a0; maxIdx = i; }
    if (a1 > maxAbs) { maxAbs = a1; maxIdx = i + 1; }
  }

  const rmse = Math.sqrt(Math.max(0, errorSqIntegral / duration));
  const mae = absErrorIntegral / duration;
  const cov = intTR - (intT * intR / duration);
  const varT = Math.max(0, intT2 - (intT * intT / duration));
  const varR = Math.max(0, intR2 - (intR * intR / duration));
  const denomCorr = Math.sqrt(varT * varR);
  const correlation = denomCorr > 1e-18 ? Math.max(-1, Math.min(1, cov / denomCorr)) : null;
  const targetVpp = Number.isFinite(maxT - minT) ? maxT - minT : null;
  const refVpp = Number.isFinite(maxR - minR) ? maxR - minR : null;
  const refScale = Math.max(targetVpp || 0, refVpp || 0, 1e-12);
  const similarityPct = targetVpp !== null && refScale > 1e-12
    ? Math.max(0, Math.min(100, (1 - rmse / refScale) * 100))
    : null;

  return {
    valid: true,
    status: 'OK',
    invalidReason: null,
    comparedSamples,
    totalSamples: n,
    invalidCount: n - comparedSamples,
    coveragePct: temporal.coveragePct,
    coveredDurationSec: duration,
    targetDurationSec: temporal.totalDurationSec,
    rmse,
    mae,
    maxAbsDiff: maxAbs >= 0 ? maxAbs : null,
    maxAbsDiffTime: maxAbs >= 0 ? targetCh.t[maxIdx] : null,
    maxAbsDiffIndex: maxAbs >= 0 ? maxIdx : null,
    correlation,
    similarityPct,
    targetVpp,
    refVpp,
  };
}

/**
 * Parses a local CSV/TXT/WFM file directly into channels for one-click Reference comparison.
 */
export async function parseReferenceFileToChannels(
  file: File,
  colors: string[]
): Promise<{ fileName: string; fingerprint: string; channels: WaveformChannel[] }> {
  const buf = await file.arrayBuffer();
  const fingerprint = computeBufferFingerprint(file.name, buf);
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.wfm')) {
    const res = parseWfmBuffer(buf, file.name, colors);
    return {
      fileName: file.name,
      fingerprint,
      channels: res.drawOrder.map((id) => res.channels[id]).filter(Boolean),
    };
  }
  if (lower.endsWith('.raw')) {
    const res = parseLtspiceRawBuffer(buf, colors);
    return {
      fileName: file.name,
      fingerprint,
      channels: res.drawOrder.map((id) => res.channels[id]).filter(Boolean),
    };
  }

  const text = new TextDecoder().decode(buf);
  if (lower.endsWith('.txt') && isLtspiceExportText(text)) {
    const res = parseLtspiceText(text, colors);
    return {
      fileName: file.name,
      fingerprint,
      channels: res.drawOrder.map((id) => res.channels[id]).filter(Boolean),
    };
  }
  const prev = previewCsv(text);
  const shouldResample = !!(prev.quality && !prev.quality.isUniformSampling);
  const parsed = parseFullCsv(text, {
    delimiter: prev.delimiter,
    hasHeader: prev.hasHeader,
    skipLines: prev.skipLines,
    timeColIndex: prev.timeColIndex,
    timeUnit: prev.timeUnit,
    sampleRateOverrideHz: prev.sampleRateOverrideHz ?? null,
    columnMappings: prev.columnMappings,
    resample: shouldResample,
    colors,
  });

  return {
    fileName: file.name,
    fingerprint,
    channels: parsed.drawOrder.map((id) => parsed.channels[id]).filter(Boolean),
  };
}
