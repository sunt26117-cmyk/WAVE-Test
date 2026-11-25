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
  unitScaleApplied: number;
  targetMeanApplied: number;
  refMeanApplied: number;
}

export interface WaveformCompareMetrics {
  valid: boolean;
  status: CompareStatus;
  invalidReason?: string | null;
  comparedSamples: number;
  totalSamples: number;
  invalidCount: number;
  coveragePct: number;
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
  let sumT = 0;
  let sumR = 0;

  for (let i = 0; i < nT; i++) {
    const tv = getChannelDisplayValue(targetCh, i, targetAcMean);
    const qRefTime = refT0 + (targetCh.t[i] - timeShiftSec - refT0) / safeScale;
    const sampled = sampleRefAtTime(refCh.t, refCh, refAcMean, qRefTime, refGapLimit);
    const rv = isFinite(sampled.value) ? sampled.value * refScaleToTarget : NaN;
    if (sampled.isGap) gapSkippedCount++;
    if (isFinite(tv) && isFinite(rv)) {
      alignedRefV[i] = rv;
      sumT += tv;
      sumR += rv;
      overlapCount++;
    } else {
      invalidCount++;
    }
  }

  let targetShift = 0;
  let refShift = 0;
  if (removeDcOffset && overlapCount > 0) {
    targetShift = sumT / overlapCount;
    refShift = sumR / overlapCount;
  }

  for (let i = 0; i < nT; i++) {
    const rv = alignedRefV[i];
    if (!isFinite(rv)) continue;
    const tv = getChannelDisplayValue(targetCh, i, targetAcMean) - targetShift;
    const adjR = rv - refShift;
    if (removeDcOffset) {
      alignedRefV[i] = adjR + targetShift;
    }
    diffV[i] = tv - adjR;
  }

  const coveragePct = nT > 0 ? (overlapCount / nT) * 100 : 0;
  const hasEnough = overlapCount >= 2 || (nT === 1 && overlapCount === 1);

  return {
    valid: hasEnough,
    status: hasEnough ? 'OK' : 'INSUFFICIENT_DATA',
    invalidReason: hasEnough ? null : 'No sufficient finite overlapping points between target and reference.',
    alignedRefV,
    diffV,
    overlapCount,
    totalTargetSamples: nT,
    invalidCount,
    gapSkippedCount,
    coveragePct,
    unitScaleApplied: refScaleToTarget,
    targetMeanApplied: targetShift,
    refMeanApplied: refShift,
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
  alignedContext?: Pick<AlignedCompareResult, 'valid' | 'status' | 'invalidReason'>
): WaveformCompareMetrics {
  const mkEmpty = (status: CompareStatus, invalidReason?: string | null, total = 0, invalidCnt = total): WaveformCompareMetrics => ({
    valid: false,
    status,
    invalidReason: invalidReason || null,
    comparedSamples: 0,
    totalSamples: total,
    invalidCount: invalidCnt,
    coveragePct: 0,
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

  if (alignedContext && !alignedContext.valid && alignedContext.status === 'INVALID') {
    return mkEmpty('INVALID', alignedContext.invalidReason, targetCh?.t?.length || 0);
  }

  const tgtInt = validateChannelIntegrity(targetCh, 1, DEFAULT_SAMPLING_GAP_FACTOR);
  if (!tgtInt.valid) {
    return mkEmpty('INVALID', tgtInt.invalidReason);
  }

  const n = targetCh.t.length;
  if (alignedRefV.length !== n) {
    return mkEmpty(
      'INVALID',
      `Aligned reference length (${alignedRefV.length}) does not match target length (${n}).`,
      n
    );
  }

  const targetAcMean = targetCh.coupling === 'AC' ? computeChannelMean(targetCh) : 0;
  let count = 0;
  let invalidCount = 0;
  let sumT = 0;
  let sumR = 0;
  let minT = Infinity;
  let maxT = -Infinity;
  let minR = Infinity;
  let maxR = -Infinity;

  for (let i = 0; i < n; i++) {
    const tv = getChannelDisplayValue(targetCh, i, targetAcMean);
    const rv = alignedRefV[i];
    if (!isFinite(tv) || !isFinite(rv)) {
      invalidCount++;
      continue;
    }
    sumT += tv;
    sumR += rv;
    if (tv < minT) minT = tv;
    if (tv > maxT) maxT = tv;
    if (rv < minR) minR = rv;
    if (rv > maxR) maxR = rv;
    count++;
  }

  if (count === 0) {
    return mkEmpty('INSUFFICIENT_DATA', 'No finite overlapping samples to compare.', n, invalidCount);
  }

  const meanT = sumT / count;
  const meanR = sumR / count;
  const dcShift = removeDcOffset ? meanT - meanR : 0;

  let sumSqErr = 0;
  let sumAbsErr = 0;
  let maxAbs = -1;
  let maxIdx = 0;
  let cov = 0;
  let varT = 0;
  let varR = 0;

  for (let i = 0; i < n; i++) {
    const tv = getChannelDisplayValue(targetCh, i, targetAcMean);
    const rv = alignedRefV[i];
    if (!isFinite(tv) || !isFinite(rv)) continue;

    const adjR = rv + dcShift;
    const err = tv - adjR;
    const absErr = Math.abs(err);
    sumSqErr += err * err;
    sumAbsErr += absErr;
    if (absErr > maxAbs) {
      maxAbs = absErr;
      maxIdx = i;
    }

    const dtVal = tv - meanT;
    const drVal = rv - meanR;
    cov += dtVal * drVal;
    varT += dtVal * dtVal;
    varR += drVal * drVal;
  }

  const rmse = Math.sqrt(sumSqErr / count);
  const mae = sumAbsErr / count;
  const denomCorr = Math.sqrt(varT * varR);
  const correlation = denomCorr > 1e-18 ? Math.max(-1, Math.min(1, cov / denomCorr)) : null;
  const targetVpp = isFinite(maxT - minT) ? maxT - minT : null;
  const refVpp = isFinite(maxR - minR) ? maxR - minR : null;
  const refScale = Math.max(targetVpp || 0, refVpp || 0, 1e-12);
  const similarityPct =
    targetVpp !== null && refScale > 1e-12
      ? Math.max(0, Math.min(100, (1 - rmse / refScale) * 100))
      : null;

  return {
    valid: true,
    status: 'OK',
    invalidReason: null,
    comparedSamples: count,
    totalSamples: n,
    invalidCount,
    coveragePct: n > 0 ? (count / n) * 100 : 0,
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
