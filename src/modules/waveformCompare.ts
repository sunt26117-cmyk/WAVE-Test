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

export interface AlignedCompareResult {
  alignedRefV: Float32Array;
  diffV: Float32Array;
  overlapCount: number;
  targetMeanApplied: number;
  refMeanApplied: number;
}

export interface WaveformCompareMetrics {
  comparedSamples: number;
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
  qTime: number
): number {
  const n = Math.min(refT.length, refCh.v.length);
  if (n === 0 || !isFinite(qTime)) return NaN;
  if (qTime < refT[0] || qTime > refT[n - 1]) return NaN;
  if (n === 1) return getChannelDisplayValue(refCh, 0, refMean);

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (refT[mid] <= qTime) lo = mid;
    else hi = mid;
  }

  const t0 = refT[lo];
  const t1 = refT[hi];
  const v0 = getChannelDisplayValue(refCh, lo, refMean);
  const v1 = getChannelDisplayValue(refCh, hi, refMean);
  if (!isFinite(v0) && !isFinite(v1)) return NaN;
  if (!isFinite(v0)) return v1;
  if (!isFinite(v1)) return v0;

  const dt = t1 - t0;
  if (dt <= 1e-18) return v0;
  const frac = (qTime - t0) / dt;
  return v0 + frac * (v1 - v0);
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
 * optional timeScale (scales ref relative to refCh.t[0], e.g. 0.001 for ms->s), and optional DC offset removal.
 */
export function alignAndInterpolateReference(
  targetCh: WaveformChannel,
  refCh: WaveformChannel,
  timeShiftSec: number = 0,
  removeDcOffset: boolean = false,
  timeScale: number = 1
): AlignedCompareResult {
  const n = Math.min(targetCh.t.length, targetCh.v.length);
  const alignedRefV = new Float32Array(n);
  const diffV = new Float32Array(n);
  alignedRefV.fill(NaN);
  diffV.fill(NaN);

  if (n === 0 || refCh.t.length === 0 || refCh.v.length === 0) {
    return {
      alignedRefV,
      diffV,
      overlapCount: 0,
      targetMeanApplied: 0,
      refMeanApplied: 0,
    };
  }

  const safeScale = isFinite(timeScale) && timeScale > 0 ? timeScale : 1;
  const refT0 = refCh.t[0];
  const targetAcMean = targetCh.coupling === 'AC' ? computeChannelMean(targetCh) : 0;
  const refAcMean = refCh.coupling === 'AC' ? computeChannelMean(refCh) : 0;

  let overlapCount = 0;
  let sumT = 0;
  let sumR = 0;

  for (let i = 0; i < n; i++) {
    const tv = getChannelDisplayValue(targetCh, i, targetAcMean);
    const qRefTime = refT0 + (targetCh.t[i] - timeShiftSec - refT0) / safeScale;
    const rv = sampleRefAtTime(refCh.t, refCh, refAcMean, qRefTime);
    if (isFinite(tv) && isFinite(rv)) {
      alignedRefV[i] = rv;
      sumT += tv;
      sumR += rv;
      overlapCount++;
    }
  }

  let targetShift = 0;
  let refShift = 0;
  if (removeDcOffset && overlapCount > 0) {
    targetShift = sumT / overlapCount;
    refShift = sumR / overlapCount;
  }

  for (let i = 0; i < n; i++) {
    const rv = alignedRefV[i];
    if (!isFinite(rv)) continue;
    const tv = getChannelDisplayValue(targetCh, i, targetAcMean) - targetShift;
    const adjR = rv - refShift;
    if (removeDcOffset) {
      alignedRefV[i] = adjR + targetShift;
    }
    diffV[i] = tv - adjR;
  }

  return {
    alignedRefV,
    diffV,
    overlapCount,
    targetMeanApplied: targetShift,
    refMeanApplied: refShift,
  };
}

function findFirstRisingCrossingTime(ch: WaveformChannel): number | null {
  const n = Math.min(ch.t.length, ch.v.length);
  if (n < 4) return null;
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
    if (!isFinite(prev) || !isFinite(curr)) continue;
    if (prev <= mid - hyst) armed = true;
    if (armed && prev < mid && curr >= mid) {
      const denom = curr - prev;
      const frac = denom > 1e-15 ? (mid - prev) / denom : 0;
      return ch.t[i - 1] + frac * (ch.t[i] - ch.t[i - 1]);
    }
  }
  return null;
}

function findPeakTime(ch: WaveformChannel): number | null {
  const n = Math.min(ch.t.length, ch.v.length);
  if (n === 0) return null;
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
  if (targetCh.t.length === 0 || refCh.t.length === 0) return 0;
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

  const sigT = new Float64Array(bins);
  const sigR = new Float64Array(bins);
  let avgT = 0;
  let avgR = 0;
  for (let i = 0; i < bins; i++) {
    const tv = sampleRefAtTime(targetCh.t, targetCh, meanT, t0T + i * dtGrid);
    const rv = sampleRefAtTime(refCh.t, refCh, meanR, refT0 + (i * dtGrid) / safeScale);
    sigT[i] = isFinite(tv) ? tv : 0;
    sigR[i] = isFinite(rv) ? rv : 0;
    avgT += sigT[i];
    avgR += sigR[i];
  }
  avgT /= bins;
  avgR /= bins;
  for (let i = 0; i < bins; i++) {
    sigT[i] -= avgT;
    sigR[i] -= avgR;
  }

  const maxLag = Math.floor(bins * 0.45);
  let bestLag = 0;
  let bestCorr = -Infinity;

  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let num = 0;
    let dT = 0;
    let dR = 0;
    for (let i = 0; i < bins; i++) {
      const j = i - lag;
      if (j < 0 || j >= bins) continue;
      num += sigT[i] * sigR[j];
      dT += sigT[i] * sigT[i];
      dR += sigR[j] * sigR[j];
    }
    const denom = Math.sqrt(dT * dR);
    if (denom > 1e-18) {
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
  removeDcOffset: boolean = false
): WaveformCompareMetrics {
  const n = Math.min(targetCh.t.length, targetCh.v.length, alignedRefV.length);
  if (n === 0) {
    return {
      comparedSamples: 0,
      rmse: null,
      mae: null,
      maxAbsDiff: null,
      maxAbsDiffTime: null,
      maxAbsDiffIndex: null,
      correlation: null,
      similarityPct: null,
      targetVpp: null,
      refVpp: null,
    };
  }

  const targetAcMean = targetCh.coupling === 'AC' ? computeChannelMean(targetCh) : 0;
  let count = 0;
  let sumT = 0;
  let sumR = 0;
  let minT = Infinity;
  let maxT = -Infinity;
  let minR = Infinity;
  let maxR = -Infinity;

  for (let i = 0; i < n; i++) {
    const tv = getChannelDisplayValue(targetCh, i, targetAcMean);
    const rv = alignedRefV[i];
    if (!isFinite(tv) || !isFinite(rv)) continue;
    sumT += tv;
    sumR += rv;
    if (tv < minT) minT = tv;
    if (tv > maxT) maxT = tv;
    if (rv < minR) minR = rv;
    if (rv > maxR) maxR = rv;
    count++;
  }

  if (count === 0) {
    return {
      comparedSamples: 0,
      rmse: null,
      mae: null,
      maxAbsDiff: null,
      maxAbsDiffTime: null,
      maxAbsDiffIndex: null,
      correlation: null,
      similarityPct: null,
      targetVpp: null,
      refVpp: null,
    };
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
    comparedSamples: count,
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
