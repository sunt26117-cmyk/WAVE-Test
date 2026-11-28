/**
 * Waveform Viewer Pro - Oscilloscope Automated Measurements Engine
 * Computes 18 built-in engineering parameters plus extensible custom user metrics:
 *   Voltage: Max, Min, Vpp, Mean, |V| Mean (Abs Mean), RMS, Vtop, Vbase, Overshoot (%)
 *   Timing:  Frequency, Period, Rise Time (10-90%), Fall Time (90-10%), +Width, -Width, Duty Cycle, Max Duty, Min Duty (%)
 * Uses time-weighted trapezoidal integrals for non-uniform / variable-step captures.
 */

import {
  ChannelMeasurements,
  CustomMeasurementDefinition,
  CycleStatSummary,
  MeasurementGate,
  MeasurementMetricKey,
  WaveformChannel,
  CursorsState,
} from '../types/models';
import { computeChannelMean, getChannelDisplayValue } from './oscilloscopeScale';
import { evaluateRPN, tokenizeMath, toRPN } from './mathParser';
import { DEFAULT_SAMPLING_GAP_FACTOR, validateChannelIntegrity } from './timeSync';

export interface MeasurementDefinition {
  key: MeasurementMetricKey;
  group: 'voltage' | 'timing';
  label: string;
  shortLabel: string;
  unitType: 'signal' | 'freq' | 'time' | 'percent' | 'slew';
}

export const MEASUREMENT_DEFINITIONS: MeasurementDefinition[] = [
  // Voltage / Amplitude
  { key: 'max', group: 'voltage', label: 'Max (Vmax)', shortLabel: 'Vmax', unitType: 'signal' },
  { key: 'min', group: 'voltage', label: 'Min (Vmin)', shortLabel: 'Vmin', unitType: 'signal' },
  { key: 'vpp', group: 'voltage', label: 'Peak-to-Peak (Vpp)', shortLabel: 'Vpp', unitType: 'signal' },
  { key: 'average', group: 'voltage', label: 'Mean (Vmean)', shortLabel: 'Vmean', unitType: 'signal' },
  { key: 'absAverage', group: 'voltage', label: 'Abs Mean (|V|avg)', shortLabel: '|V|avg', unitType: 'signal' },
  { key: 'rms', group: 'voltage', label: 'RMS (Vrms)', shortLabel: 'Vrms', unitType: 'signal' },
  { key: 'vtop', group: 'voltage', label: 'Top (Vtop)', shortLabel: 'Vtop', unitType: 'signal' },
  { key: 'vbase', group: 'voltage', label: 'Base (Vbase)', shortLabel: 'Vbase', unitType: 'signal' },
  { key: 'overshoot', group: 'voltage', label: 'Overshoot (%)', shortLabel: 'Ovsh', unitType: 'percent' },
  { key: 'undershoot', group: 'voltage', label: 'Undershoot (%)', shortLabel: 'Unsh', unitType: 'percent' },
  // Timing / Frequency / Slew
  { key: 'frequency', group: 'timing', label: 'Frequency', shortLabel: 'Freq', unitType: 'freq' },
  { key: 'period', group: 'timing', label: 'Period', shortLabel: 'Period', unitType: 'time' },
  { key: 'riseTime', group: 'timing', label: 'Rise Time (10-90%)', shortLabel: 'Rise', unitType: 'time' },
  { key: 'fallTime', group: 'timing', label: 'Fall Time (90-10%)', shortLabel: 'Fall', unitType: 'time' },
  { key: 'slewRateRise', group: 'timing', label: '+Slew Rate (10-90% dv/dt)', shortLabel: '+dv/dt', unitType: 'slew' },
  { key: 'slewRateFall', group: 'timing', label: '-Slew Rate (90-10% dv/dt)', shortLabel: '-dv/dt', unitType: 'slew' },
  { key: 'posWidth', group: 'timing', label: '+Width (50%)', shortLabel: '+Width', unitType: 'time' },
  { key: 'negWidth', group: 'timing', label: '-Width (50%)', shortLabel: '-Width', unitType: 'time' },
  { key: 'dutyCycle', group: 'timing', label: 'Duty Cycle (%)', shortLabel: 'Duty', unitType: 'percent' },
  { key: 'maxDutyCycle', group: 'timing', label: 'Max Duty Cycle (%)', shortLabel: 'DutyMax', unitType: 'percent' },
  { key: 'minDutyCycle', group: 'timing', label: 'Min Duty Cycle (%)', shortLabel: 'DutyMin', unitType: 'percent' },
];

export const CUSTOM_MEASUREMENT_PRESETS: Array<Omit<CustomMeasurementDefinition, 'id'>> = [
  { label: 'Crest Factor (Peak/RMS)', shortLabel: 'CF', expression: 'peak / vrms', unitType: 'ratio' },
  { label: 'AC Ripple RMS', shortLabel: 'Vac_rms', expression: 'sqrt(vrms^2 - vmean^2)', unitType: 'signal' },
  { label: 'Form Factor (RMS/|Avg|)', shortLabel: 'FF', expression: 'vrms / absmean', unitType: 'ratio' },
  { label: 'Duty Spread (Max-Min)', shortLabel: 'ΔDuty', expression: 'maxduty - minduty', unitType: 'percent' },
  { label: 'Slew Symmetry (+dv/dt ÷ -dv/dt)', shortLabel: 'SlewSym', expression: 'dvdt_rise / dvdt_fall', unitType: 'ratio' },
];

export type MeasurementStatus = 'OK' | 'INVALID' | 'INSUFFICIENT_DATA' | 'NO_OVERLAP';

/**
 * Computes Welford numerically-stable mean, min, max, and unbiased sample standard deviation.
 */
export function summarizeCycleDistribution(values: number[]): CycleStatSummary | undefined {
  let count = 0;
  let mean = 0;
  let m2 = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    count++;
    if (v < min) min = v;
    if (v > max) max = v;
    const delta = v - mean;
    mean += delta / count;
    const delta2 = v - mean;
    m2 += delta * delta2;
  }
  if (count === 0) return undefined;
  return {
    count,
    mean,
    min,
    max,
    stdDev: count >= 2 ? Math.sqrt(Math.max(0, m2 / (count - 1))) : null,
  };
}

export interface CustomMeasurementDetailedResult {
  value: number | null;
  valid: boolean;
  status: MeasurementStatus | 'EVAL_ERROR';
  reason?: string;
}

interface GatedSampleSlice {
  hasOverlap: boolean;
  status: MeasurementStatus;
  t: Float64Array;
  v: Float32Array;
  reason?: string;
}

function interpolateWindowEndpoint(
  t: Float64Array,
  valAt: (idx: number) => number,
  leftIdx: number,
  rightIdx: number,
  qTime: number,
  gapThreshold: number
): number | null {
  if (leftIdx < 0 || rightIdx >= t.length || leftIdx >= rightIdx) return null;
  const t0 = t[leftIdx];
  const t1 = t[rightIdx];
  const dt = t1 - t0;
  if (!Number.isFinite(dt) || dt <= 0) return null;
  if (Number.isFinite(gapThreshold) && dt > gapThreshold) return null;
  const v0 = valAt(leftIdx);
  const v1 = valAt(rightIdx);
  if (!Number.isFinite(v0) || !Number.isFinite(v1)) return null;
  const frac = Math.max(0, Math.min(1, (qTime - t0) / dt));
  return v0 + (v1 - v0) * frac;
}

function extractGatedSamples(
  t: Float64Array,
  valAt: (idx: number) => number,
  totalN: number,
  gate: MeasurementGate,
  viewIndices: { startIndex: number; endIndex: number },
  cursors: CursorsState,
  gapThreshold: number,
  viewTimeBounds?: { tStart: number; tEnd: number }
): GatedSampleSlice {
  const mkFail = (status: MeasurementStatus, reason: string): GatedSampleSlice => ({
    hasOverlap: false,
    status,
    t: new Float64Array(0),
    v: new Float32Array(0),
    reason,
  });

  if (totalN === 0) {
    return mkFail('INSUFFICIENT_DATA', 'Empty channel data.');
  }

  let wStart: number | null = null;
  let wEnd: number | null = null;

  if (gate === 'view') {
    if (viewTimeBounds) {
      wStart = viewTimeBounds.tStart;
      wEnd = viewTimeBounds.tEnd;
    } else {
      if (
        viewIndices.endIndex < 0 ||
        viewIndices.startIndex >= totalN ||
        viewIndices.endIndex < viewIndices.startIndex
      ) {
        return mkFail('NO_OVERLAP', 'Selected view index window has no overlap with waveform.');
      }
      const s = Math.max(0, viewIndices.startIndex);
      const e = Math.min(totalN - 1, viewIndices.endIndex);
      if (e < s) return mkFail('NO_OVERLAP', 'Empty view window.');
      const outT = new Float64Array(e - s + 1);
      const outV = new Float32Array(e - s + 1);
      for (let i = s; i <= e; i++) {
        outT[i - s] = t[i];
        outV[i - s] = valAt(i);
      }
      return { hasOverlap: true, status: 'OK', t: outT, v: outV };
    }
  } else if (gate === 'cursors') {
    if (!cursors.enabled || cursors.x1 === null || cursors.x2 === null) {
      return mkFail('NO_OVERLAP', 'Cursors gate active, but X cursors are disabled or unset.');
    }
    wStart = Math.min(cursors.x1, cursors.x2);
    wEnd = Math.max(cursors.x1, cursors.x2);
  } else {
    const outT = new Float64Array(totalN);
    const outV = new Float32Array(totalN);
    for (let i = 0; i < totalN; i++) {
      outT[i] = t[i];
      outV[i] = valAt(i);
    }
    return { hasOverlap: true, status: 'OK', t: outT, v: outV };
  }

  if (wStart === null || wEnd === null || !Number.isFinite(wStart) || !Number.isFinite(wEnd) || wEnd < wStart) {
    return mkFail('INVALID', 'Invalid gate window bounds.');
  }
  const tFirst = t[0];
  const tLast = t[totalN - 1];
  if (wEnd < tFirst || wStart > tLast) {
    return mkFail('NO_OVERLAP', 'Selected gate window has no overlap with waveform time range.');
  }

  let lo = 0;
  let hi = totalN;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < wStart) lo = mid + 1;
    else hi = mid;
  }
  const firstIn = lo;

  lo = firstIn;
  hi = totalN;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= wEnd) lo = mid + 1;
    else hi = mid;
  }
  const lastIn = lo - 1;

  const tList: number[] = [];
  const vList: number[] = [];

  if (wEnd > wStart && firstIn > lastIn) {
    // Sub-sample window strictly inside interval [firstIn - 1, firstIn]
    const kLeft = firstIn - 1;
    const kRight = firstIn;
    if (kLeft >= 0 && kRight < totalN) {
      const vS = interpolateWindowEndpoint(t, valAt, kLeft, kRight, wStart, gapThreshold);
      const vE = interpolateWindowEndpoint(t, valAt, kLeft, kRight, wEnd, gapThreshold);
      if (vS !== null && vE !== null) {
        tList.push(wStart, wEnd);
        vList.push(vS, vE);
      }
    }
  } else {
    if (firstIn > 0 && (firstIn >= totalN || wStart < t[firstIn] - 1e-15)) {
      const vS = interpolateWindowEndpoint(t, valAt, firstIn - 1, firstIn, wStart, gapThreshold);
      if (vS !== null) {
        tList.push(wStart);
        vList.push(vS);
      }
    }
    for (let i = firstIn; i <= lastIn; i++) {
      tList.push(t[i]);
      vList.push(valAt(i));
    }
    if (lastIn >= 0 && lastIn + 1 < totalN && wEnd > t[lastIn] + 1e-15) {
      const vE = interpolateWindowEndpoint(t, valAt, lastIn, lastIn + 1, wEnd, gapThreshold);
      if (vE !== null) {
        tList.push(wEnd);
        vList.push(vE);
      }
    }
  }

  if (tList.length === 0) {
    return mkFail('NO_OVERLAP', 'No valid contiguous samples overlap the selected gate window.');
  }
  return {
    hasOverlap: true,
    status: 'OK',
    t: Float64Array.from(tList),
    v: Float32Array.from(vList),
  };
}

/**
 * Estimates steady-state Vtop and Vbase via 64-bin amplitude histogram modal clustering.
 * Falls back gracefully to min/max for purely continuous/linear ramps or sinusoids.
 */
function estimateHistogramTopBase(
  valAt: (idx: number) => number,
  startIdx: number,
  endIdx: number,
  min: number,
  max: number
): { vtop: number; vbase: number } {
  const span = max - min;
  if (!isFinite(span) || span <= 1e-12) {
    return { vtop: max, vbase: min };
  }

  const bins = 128;
  const counts = new Uint32Array(bins);
  const sums = new Float64Array(bins);
  const step = Math.max(1, Math.floor((endIdx - startIdx + 1) / 20000));
  let totalSampled = 0;

  for (let i = startIdx; i <= endIdx; i += step) {
    const val = valAt(i);
    if (isNaN(val) || !isFinite(val)) continue;
    let b = Math.floor(((val - min) / span) * (bins - 1));
    b = Math.max(0, Math.min(bins - 1, b));
    counts[b]++;
    sums[b] += val;
    totalSampled++;
  }

  if (totalSampled < 4) {
    return { vtop: max, vbase: min };
  }

  const minSep = Math.max(6, Math.floor(bins * 0.08));

  // First find strongest amplitude plateau mode across the entire span
  let mode1Bin = 0;
  let mode1Count = 0;
  for (let b = 0; b < bins; b++) {
    if (counts[b] > mode1Count) {
      mode1Count = counts[b];
      mode1Bin = b;
    }
  }

  const clusterMean = (centerBin: number): number | null => {
    let s = 0;
    let c = 0;
    for (let b = Math.max(0, centerBin - 1); b <= Math.min(bins - 1, centerBin + 1); b++) {
      s += sums[b];
      c += counts[b];
    }
    return c > 0 ? s / c : null;
  };

  const clusterCount = (centerBin: number): number => {
    let c = 0;
    for (let b = Math.max(0, centerBin - 1); b <= Math.min(bins - 1, centerBin + 1); b++) {
      c += counts[b];
    }
    return c;
  };

  // Find strongest secondary plateau mode well-separated from mode1Bin using 3-bin cluster energy
  // (immune to >100% overshoot spikes pulling max high and handles low-duty PWM down to ~1-2%)
  let mode2Bin = -1;
  let mode2ClusterScore = 0;
  for (let b = 0; b < bins; b++) {
    if (Math.abs(b - mode1Bin) < minSep) continue;
    const sc = clusterCount(b);
    if (sc > mode2ClusterScore || (sc === mode2ClusterScore && counts[b] > (mode2Bin >= 0 ? counts[mode2Bin] : -1))) {
      mode2ClusterScore = sc;
      mode2Bin = b;
    }
  }

  const avgPerBin = totalSampled / bins;
  const minPrimaryCluster = Math.max(3, totalSampled * 0.012);
  const minSecondaryCluster = Math.max(2, totalSampled * 0.008);

  // If mode2Bin landed on an intermediate shelf (e.g. Miller plateau, dead-time Vbus/2 shelf, or ripple peak),
  // check if there is a further-out genuine plateau rail on the same side with substantial steady-state dwell.
  if (mode2Bin >= 0) {
    const dir = mode2Bin > mode1Bin ? 1 : -1;
    const minOuterRailCluster = Math.max(3, totalSampled * 0.02);
    let outerBin = -1;
    let outerScore = 0;
    for (let b = mode2Bin + dir * Math.max(4, Math.floor(minSep * 0.6)); b >= 0 && b < bins; b += dir) {
      const sc = clusterCount(b);
      if (sc >= minOuterRailCluster && sc > avgPerBin * 1.6 && sc >= mode2ClusterScore * 0.25) {
        if (sc > outerScore) {
          outerScore = sc;
          outerBin = b;
        }
      }
    }
    if (outerBin >= 0) {
      mode2Bin = outerBin;
      mode2ClusterScore = outerScore;
    }
  }

  if (
    mode2Bin >= 0 &&
    clusterCount(mode1Bin) >= minPrimaryCluster &&
    mode2ClusterScore >= minSecondaryCluster &&
    mode2ClusterScore > avgPerBin * 1.35
  ) {
    const baseBin = Math.min(mode1Bin, mode2Bin);
    const topBin = Math.max(mode1Bin, mode2Bin);
    const estBase = clusterMean(baseBin) ?? min;
    const estTop = clusterMean(topBin) ?? max;
    if (estTop > estBase) {
      return { vtop: estTop, vbase: estBase };
    }
  }

  const midBin = Math.floor(bins / 2);

  // Upper half modal peak (Vtop) fallback
  let topPeakBin = bins - 1;
  let topMaxCount = 0;
  for (let b = midBin; b < bins; b++) {
    if (counts[b] > topMaxCount) {
      topMaxCount = counts[b];
      topPeakBin = b;
    }
  }

  // Lower half modal peak (Vbase) fallback
  let basePeakBin = 0;
  let baseMaxCount = 0;
  for (let b = 0; b < midBin; b++) {
    if (counts[b] > baseMaxCount) {
      baseMaxCount = counts[b];
      basePeakBin = b;
    }
  }

  const vtop =
    topMaxCount > avgPerBin * 2.5 ? (clusterMean(topPeakBin) ?? max) : max;
  const vbase =
    baseMaxCount > avgPerBin * 2.5 ? (clusterMean(basePeakBin) ?? min) : min;

  return vtop > vbase ? { vtop, vbase } : { vtop: max, vbase: min };
}

function emptyMeasurements(
  channel: WaveformChannel | undefined,
  gate: MeasurementGate,
  statusMessage: string,
  valid = false,
  timeStart = 0,
  timeEnd = 0,
  sampleCount = 0,
  status: MeasurementStatus = valid ? 'OK' : 'INSUFFICIENT_DATA'
): ChannelMeasurements {
  return {
    channelId: channel?.id || '',
    channelName: channel?.name || '',
    unit: channel?.unit || 'V',
    gate,
    sampleCount,
    timeStart,
    timeEnd,
    max: null,
    min: null,
    average: null,
    absAverage: null,
    rms: null,
    vpp: null,
    peak: null,
    vtop: null,
    vbase: null,
    overshoot: null,
    undershoot: null,
    period: null,
    frequency: null,
    dutyCycle: null,
    maxDutyCycle: null,
    minDutyCycle: null,
    riseTime: null,
    fallTime: null,
    slewRateRise: null,
    slewRateFall: null,
    posWidth: null,
    negWidth: null,
    cycleCount: 0,
    cycleStats: {},
    valid,
    status,
    coveragePct: 0,
    gapCount: 0,
    invalidSampleCount: 0,
    statusMessage,
  };
}

/**
 * Computes comprehensive oscilloscope measurements for a channel within the gated range.
 */
export function computeMeasurements(
  channel: WaveformChannel,
  gate: MeasurementGate,
  viewIndices: { startIndex: number; endIndex: number },
  cursors: CursorsState,
  viewTimeBounds?: { tStart: number; tEnd: number }
): ChannelMeasurements {
  const integrity = validateChannelIntegrity(channel, 1, DEFAULT_SAMPLING_GAP_FACTOR);
  if (!integrity.valid) {
    return emptyMeasurements(
      channel,
      gate,
      integrity.invalidReason || 'Invalid channel data.',
      false,
      0,
      0,
      0,
      'INVALID'
    );
  }

  const tRaw = channel.t;
  const vRaw = channel.v;
  const totalN = tRaw.length;
  const gapThreshold = integrity.timebase.gapThresholdSec;

  const isConditioned = channel.coupling === 'AC' || !!channel.inverted;
  const cachedMean = channel.coupling === 'AC' ? computeChannelMean(channel) : 0;
  const valAtRaw = (idx: number) => (isConditioned ? getChannelDisplayValue(channel, idx, cachedMean) : vRaw[idx]);

  const gated = extractGatedSamples(
    tRaw,
    valAtRaw,
    totalN,
    gate,
    viewIndices,
    cursors,
    gapThreshold,
    viewTimeBounds
  );
  if (!gated.hasOverlap) {
    return emptyMeasurements(
      channel,
      gate,
      gated.reason || 'Gate window has no overlap with waveform.',
      false,
      0,
      0,
      0,
      gated.status
    );
  }

  const t = gated.t;
  const sliceV = gated.v;
  const valAt = (idx: number) => sliceV[idx];
  const sampleCount = t.length;
  const startIdx = 0;
  const endIdx = sampleCount - 1;
  const timeStart = t[0];
  const timeEnd = t[endIdx];

  if (sampleCount < 2) {
    const singleInvalid = sampleCount === 1 && !isFinite(valAt(0)) ? 1 : 0;
    return {
      ...emptyMeasurements(
        channel,
        gate,
        'Insufficient points (<2) in selected gate range.',
        false,
        timeStart,
        timeEnd,
        sampleCount,
        'INSUFFICIENT_DATA'
      ),
      coveragePct: singleInvalid === 0 && sampleCount === 1 ? 100 : 0,
      invalidSampleCount: singleInvalid,
    };
  }

  // Pass 1: Segmented statistics + time-weighted trapezoidal integrals (never integrate across gaps or NaNs)
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumAbs = 0;
  let sumSq = 0;
  let validCount = 0;
  let invalidSampleCount = 0;
  let gapCount = 0;

  let trapSum = 0;
  let trapAbsSum = 0;
  let trapSqSum = 0;
  let totalDtWeight = 0;
  let minDtObserved = Infinity;
  let maxDtObserved = 0;
  let prevValidVal: number | null = null;
  let prevValidTime: number | null = null;

  for (let i = startIdx; i <= endIdx; i++) {
    const val = valAt(i);
    const ti = t[i];
    if (isFinite(val) && isFinite(ti)) {
      if (val < min) min = val;
      if (val > max) max = val;
      sum += val;
      sumAbs += Math.abs(val);
      sumSq += val * val;
      validCount++;

      if (prevValidVal !== null && prevValidTime !== null) {
        const dt = ti - prevValidTime;
        if (dt > 0) {
          if (Number.isFinite(gapThreshold) && dt > gapThreshold) {
            // Sampling gap: break segment continuity, do not integrate across missing region
            gapCount++;
          } else {
            if (dt < minDtObserved) minDtObserved = dt;
            if (dt > maxDtObserved) maxDtObserved = dt;
            trapSum += 0.5 * (prevValidVal + val) * dt;
            // Exact integral of |linear(t)| across segment
            if ((prevValidVal >= 0 && val >= 0) || (prevValidVal <= 0 && val <= 0)) {
              trapAbsSum += 0.5 * (Math.abs(prevValidVal) + Math.abs(val)) * dt;
            } else {
              const abs0 = Math.abs(prevValidVal);
              const abs1 = Math.abs(val);
              const denom = abs0 + abs1;
              const tZeroFrac = denom > 1e-18 ? abs0 / denom : 0.5;
              trapAbsSum += 0.5 * abs0 * (dt * tZeroFrac) + 0.5 * abs1 * (dt * (1 - tZeroFrac));
            }
            // Exact integral of linear^2(t) over [a, b]: (a^2 + a*b + b^2) / 3 * dt
            trapSqSum += ((prevValidVal * prevValidVal + prevValidVal * val + val * val) / 3) * dt;
            totalDtWeight += dt;
          }
        }
      }
      prevValidVal = val;
      prevValidTime = ti;
    } else {
      invalidSampleCount++;
      prevValidVal = null;
      prevValidTime = null;
    }
  }

  if (validCount < 2 || !isFinite(min) || !isFinite(max)) {
    return {
      ...emptyMeasurements(
        channel,
        gate,
        validCount === 0 ? 'No valid numeric samples in range.' : 'Insufficient finite samples (<2) in range.',
        false,
        timeStart,
        timeEnd,
        validCount,
        'INSUFFICIENT_DATA'
      ),
      invalidSampleCount,
      gapCount,
    };
  }

  const coveragePct = sampleCount > 0 ? (validCount / sampleCount) * 100 : 0;
  const hasVaryingDt =
    isFinite(minDtObserved) && maxDtObserved > 0 && minDtObserved < maxDtObserved * 0.98;
  const useTimeWeighted =
    totalDtWeight > 0 &&
    (channel.metadata?.isUniformSampling === false || hasVaryingDt || gapCount > 0 || invalidSampleCount > 0);

  const average = useTimeWeighted ? trapSum / totalDtWeight : sum / validCount;
  const absAverage = useTimeWeighted ? trapAbsSum / totalDtWeight : sumAbs / validCount;
  const rms = useTimeWeighted ? Math.sqrt(Math.max(0, trapSqSum / totalDtWeight)) : Math.sqrt(sumSq / validCount);
  const vpp = max - min;
  const peak = Math.max(Math.abs(max), Math.abs(min));
  const { vtop, vbase } = estimateHistogramTopBase(valAt, startIdx, endIdx, min, max);

  const baseAmp = vtop - vbase;
  let overshoot: number | null = null;
  let undershoot: number | null = null;
  if (baseAmp > 1e-12) {
    overshoot = Math.max(0, ((max - vtop) / baseAmp) * 100);
    undershoot = Math.max(0, ((vbase - min) / baseAmp) * 100);
  }

  // Segmented Timing analysis: Frequency, Period, +Width, -Width, Duty, Max Duty, Min Duty, Rise/Fall Time, ±dv/dt & Multi-cycle stats
  let period: number | null = null;
  let frequency: number | null = null;
  let dutyCycle: number | null = null;
  let maxDutyCycle: number | null = null;
  let minDutyCycle: number | null = null;
  let riseTime: number | null = null;
  let fallTime: number | null = null;
  let slewRateRise: number | null = null;
  let slewRateFall: number | null = null;
  let posWidth: number | null = null;
  let negWidth: number | null = null;
  let cycleCount = 0;
  const cycleStats: Partial<Record<MeasurementMetricKey, CycleStatSummary>> = {};
  const statusNotes: string[] = [];

  if (gapCount > 0) {
    statusNotes.push(`Detected ${gapCount} sampling gap(s); segmented integration & edge detection applied.`);
  }
  if (invalidSampleCount > 0) {
    statusNotes.push(`Excluded ${invalidSampleCount} NaN/Inf sample(s).`);
  }

  if (vpp > 1e-12) {
    const effBase = baseAmp > 1e-12 ? vbase : min;
    const effTop = baseAmp > 1e-12 ? vtop : max;
    const effAmp = effTop - effBase > 1e-12 ? effTop - effBase : vpp;
    const midLevel = (effTop + effBase) / 2;
    // Wide plateau-anchored Schmitt band (25%..75% of plateau) rejects Miller shelves,
    // dead-time steps, and ringing spikes without disturbing sub-sample 50% backtracking.
    const hysteresis = 0.25 * effAmp;
    const midHigh = midLevel + hysteresis;
    const midLow = midLevel - hysteresis;

    let events: Array<{ type: 'rise' | 'fall'; time: number; segmentId: number; sampleIdx: number }> = [];
    let risingEdges: Array<{ time: number; segmentId: number; sampleIdx: number }> = [];
    let fallingEdges: Array<{ time: number; segmentId: number }> = [];

    let segmentId = 0;
    let firstValidIdx = startIdx;
    while (firstValidIdx <= endIdx && !isFinite(valAt(firstValidIdx))) firstValidIdx++;
    let state: 'low' | 'high' = firstValidIdx <= endIdx && valAt(firstValidIdx) >= midLevel ? 'high' : 'low';
    let needReseed = false;

    let segStartIdx = firstValidIdx;
    for (let i = firstValidIdx + 1; i <= endIdx; i++) {
      const vPrev = valAt(i - 1);
      const vCurr = valAt(i);
      const tPrev = t[i - 1];
      const tCurr = t[i];
      const dtStep = tCurr - tPrev;

      if (!isFinite(vCurr)) {
        segmentId++;
        needReseed = true;
        segStartIdx = i + 1;
        continue;
      }
      if (!isFinite(vPrev) || (Number.isFinite(gapThreshold) && dtStep > gapThreshold)) {
        if (isFinite(vPrev)) segmentId++;
        state = vCurr >= midLevel ? 'high' : 'low';
        needReseed = false;
        segStartIdx = i;
        continue;
      }
      if (needReseed) {
        state = vCurr >= midLevel ? 'high' : 'low';
        needReseed = false;
        segStartIdx = i;
        continue;
      }

      if (state === 'low' && vCurr >= midHigh) {
        // Backtrack within the current continuous segment to the true midLevel crossing bracket
        let j = i;
        while (j > segStartIdx && valAt(j - 1) > midLevel) {
          j--;
        }
        const vjPrev = j > segStartIdx ? valAt(j - 1) : vPrev;
        const vjCurr = j > segStartIdx ? valAt(j) : vCurr;
        const tjPrev = j > segStartIdx ? t[j - 1] : tPrev;
        const tjCurr = j > segStartIdx ? t[j] : tCurr;
        const dvj = vjCurr - vjPrev;
        const frac = Math.abs(dvj) > 1e-15 ? Math.max(0, Math.min(1, (midLevel - vjPrev) / dvj)) : 0.5;
        const cTime = tjPrev + frac * (tjCurr - tjPrev);
        risingEdges.push({ time: cTime, segmentId, sampleIdx: j });
        events.push({ type: 'rise', time: cTime, segmentId, sampleIdx: j });
        state = 'high';
        segStartIdx = i;
      } else if (state === 'high' && vCurr <= midLow) {
        let j = i;
        while (j > segStartIdx && valAt(j - 1) < midLevel) {
          j--;
        }
        const vjPrev = j > segStartIdx ? valAt(j - 1) : vPrev;
        const vjCurr = j > segStartIdx ? valAt(j) : vCurr;
        const tjPrev = j > segStartIdx ? t[j - 1] : tPrev;
        const tjCurr = j > segStartIdx ? t[j] : tCurr;
        const dvj = vjCurr - vjPrev;
        const frac = Math.abs(dvj) > 1e-15 ? Math.max(0, Math.min(1, (midLevel - vjPrev) / dvj)) : 0.5;
        const cTime = tjPrev + frac * (tjCurr - tjPrev);
        fallingEdges.push({ time: cTime, segmentId });
        events.push({ type: 'fall', time: cTime, segmentId, sampleIdx: j });
        state = 'low';
        segStartIdx = i;
      }
    }

    // Prune narrow ringing bounces/glitches (turn-on dips, turn-off spikes, or intermediate Miller/dead-time shelves)
    // from alternating events before pairing rising edges, preventing 2x PWM frequency doubling while keeping low-duty PWM intact.
    if (events.length >= 4) {
      const upperQuantile = (arr: number[], q: number) => {
        if (arr.length === 0) return 0;
        const s = arr.slice().sort((a, b) => a - b);
        return s[Math.min(s.length - 1, Math.ceil((s.length - 1) * q))];
      };
      const highRailTarget = effBase + 0.65 * effAmp;
      const lowRailTarget = effBase + 0.35 * effAmp;

      let changed = true;
      let pass = 0;
      while (changed && pass < 6 && events.length >= 4) {
        changed = false;
        pass++;
        const highDurs: number[] = [];
        const lowDurs: number[] = [];
        const allDurs: number[] = [];
        for (let k = 0; k + 1 < events.length; k++) {
          if (events[k].segmentId !== events[k + 1].segmentId) continue;
          const d = events[k + 1].time - events[k].time;
          if (!(d > 0)) continue;
          allDurs.push(d);
          if (events[k].type === 'rise' && events[k + 1].type === 'fall') highDurs.push(d);
          else if (events[k].type === 'fall' && events[k + 1].type === 'rise') lowDurs.push(d);
        }
        const refHigh = upperQuantile(highDurs, 0.85);
        const refLow = upperQuantile(lowDurs, 0.85);
        const refPhase = upperQuantile(allDurs, 0.85);
        if (!(refPhase > 0)) break;

        const nextEvents: typeof events = [];
        let k = 0;
        while (k < events.length) {
          if (k + 1 < events.length && events[k].segmentId === events[k + 1].segmentId) {
            const dur = events[k + 1].time - events[k].time;
            const isHigh = events[k].type === 'rise' && events[k + 1].type === 'fall';
            const samePolarityRef = isHigh ? refHigh : refLow;
            const prevDur =
              k > 0 && events[k - 1].segmentId === events[k].segmentId
                ? events[k].time - events[k - 1].time
                : Infinity;
            const nextDur =
              k + 2 < events.length && events[k + 1].segmentId === events[k + 2].segmentId
                ? events[k + 2].time - events[k + 1].time
                : Infinity;

            // Check whether this interior half-cycle fails to reach the opposite steady-state rail region
            let failsRailExcursion = false;
            if (k > 0 && k + 1 < events.length - 1) {
              const s0 = Math.max(startIdx, Math.min(events[k].sampleIdx, events[k + 1].sampleIdx) - 1);
              const s1 = Math.min(endIdx, Math.max(events[k].sampleIdx, events[k + 1].sampleIdx) + 1);
              if (isHigh) {
                let pMax = -Infinity;
                for (let m = s0; m <= s1; m++) {
                  const vm = valAt(m);
                  if (isFinite(vm) && vm > pMax) pMax = vm;
                }
                if (isFinite(pMax) && pMax < highRailTarget) failsRailExcursion = true;
              } else {
                let pMin = Infinity;
                for (let m = s0; m <= s1; m++) {
                  const vm = valAt(m);
                  if (isFinite(vm) && vm < pMin) pMin = vm;
                }
                if (isFinite(pMin) && pMin > lowRailTarget) failsRailExcursion = true;
              }
            }

            const isShortPair =
              failsRailExcursion ||
              (samePolarityRef > 0 && dur < samePolarityRef * 0.22 && (prevDur > dur * 2.2 || nextDur > dur * 2.2)) ||
              (dur < refPhase * 0.14 && prevDur < refPhase * 0.14 && prevDur <= nextDur) ||
              (dur < refPhase * 0.14 && nextDur < refPhase * 0.14 && nextDur <= prevDur);
            if (isShortPair) {
              k += 2;
              changed = true;
              continue;
            }
          }
          nextEvents.push(events[k]);
          k++;
        }
        if (changed && nextEvents.length >= 2) {
          events = nextEvents;
        } else {
          break;
        }
      }
      risingEdges = events
        .filter((ev) => ev.type === 'rise')
        .map((ev) => ({ time: ev.time, segmentId: ev.segmentId, sampleIdx: ev.sampleIdx }));
      fallingEdges = events
        .filter((ev) => ev.type === 'fall')
        .map((ev) => ({ time: ev.time, segmentId: ev.segmentId }));
    }

    // Collapse systematic alternating sub-cycle period-doubling [d_a, d_b, d_a, d_b] where every cycle
    // was split into a main pulse and a secondary bounce/shelf pulse (so d_a + d_b = T_true).
    if (risingEdges.length >= 4) {
      const pulseWidthForRise = (rIdx: number): number => {
        const r0 = risingEdges[rIdx];
        const r1 = risingEdges[rIdx + 1];
        if (!r0 || !r1 || r0.segmentId !== r1.segmentId) return 0;
        const fe = fallingEdges.find((f) => f.segmentId === r0.segmentId && f.time > r0.time && f.time < r1.time);
        return fe ? fe.time - r0.time : (r1.time - r0.time) * 0.5;
      };
      const intervals: Array<{ idx: number; dt: number; width: number; seg: number }> = [];
      for (let k = 0; k + 1 < risingEdges.length; k++) {
        if (risingEdges[k].segmentId === risingEdges[k + 1].segmentId) {
          const dt = risingEdges[k + 1].time - risingEdges[k].time;
          if (dt > 0) intervals.push({ idx: k, dt, width: pulseWidthForRise(k), seg: risingEdges[k].segmentId });
        }
      }
      if (intervals.length >= 3) {
        const sampleDt =
          integrity.timebase.dtMedian && integrity.timebase.dtMedian > 0
            ? integrity.timebase.dtMedian
            : endIdx > startIdx
            ? Math.abs(t[endIdx] - t[startIdx]) / Math.max(1, endIdx - startIdx)
            : 0;
        let altTriples = 0;
        let validTriples = 0;
        for (let k = 0; k + 2 < intervals.length; k++) {
          const a = intervals[k];
          const b = intervals[k + 1];
          const c = intervals[k + 2];
          if (a.seg !== b.seg || b.seg !== c.seg) continue;
          validTriples++;
          const pair1 = a.dt + b.dt;
          const pair2 = b.dt + c.dt;
          const pairConsistent = Math.abs(pair1 - pair2) / Math.max(pair1, pair2) <= 0.16;
          const maxW = Math.max(a.width, b.width);
          const minW = Math.min(a.width, b.width);
          const maxDt = Math.max(a.dt, b.dt);
          const minDt = Math.min(a.dt, b.dt);
          const dtSeverelyAlternates =
            (a.dt - b.dt) * (b.dt - c.dt) < 0 &&
            Math.abs(a.dt - b.dt) > 2.2 * sampleDt &&
            minDt < maxDt * 0.40 &&
            minW < maxW * 0.65;
          const widthAlternates =
            (a.width - b.width) * (b.width - c.width) < 0 &&
            maxW > 2.2 * sampleDt &&
            minW < maxW * 0.30;
          if (pairConsistent && (dtSeverelyAlternates || widthAlternates)) {
            altTriples++;
          }
        }
        if (validTriples >= 1 && altTriples / validTriples >= 0.65) {
          // Determine whether odd-indexed or even-indexed intervals carry the smaller secondary pulse
          let evenScore = 0;
          let oddScore = 0;
          for (let k = 0; k < intervals.length; k++) {
            const score = intervals[k].width > 0 ? intervals[k].width : intervals[k].dt;
            if (k % 2 === 0) evenScore += score;
            else oddScore += score;
          }
          const dropOddRise = evenScore >= oddScore;
          const filteredRising: typeof risingEdges = [];
          const suppressedRanges: Array<{ t0: number; t1: number; seg: number }> = [];
          for (let k = 0; k < risingEdges.length; k++) {
            const shouldDrop = dropOddRise ? k % 2 === 1 : k > 0 && k % 2 === 0;
            if (shouldDrop && filteredRising.length > 0 && filteredRising[filteredRising.length - 1].segmentId === risingEdges[k].segmentId) {
              const prevKept = filteredRising[filteredRising.length - 1];
              suppressedRanges.push({ t0: prevKept.time, t1: risingEdges[k].time, seg: risingEdges[k].segmentId });
              continue;
            }
            filteredRising.push(risingEdges[k]);
          }
          if (filteredRising.length >= 2 && suppressedRanges.length > 0) {
            risingEdges = filteredRising;
            const isGlitch = (seg: number, tm: number) =>
              suppressedRanges.some((g) => g.seg === seg && tm > g.t0 && tm <= g.t1);
            fallingEdges = fallingEdges.filter((fe) => !isGlitch(fe.segmentId, fe.time));
            events = events.filter((ev) => !isGlitch(ev.segmentId, ev.time));
          }
        }
      }
    }

    // Secondary period check: suppress remaining sub-cycle glitches using ceiling quantile (safe on >= 2 periods)
    if (risingEdges.length >= 3) {
      const rawPeriods: number[] = [];
      for (let k = 0; k + 1 < risingEdges.length; k++) {
        if (risingEdges[k].segmentId === risingEdges[k + 1].segmentId) {
          const p = risingEdges[k + 1].time - risingEdges[k].time;
          if (p > 0) rawPeriods.push(p);
        }
      }
      if (rawPeriods.length >= 2) {
        const sortedP = rawPeriods.slice().sort((a, b) => a - b);
        const upperRefPeriod = sortedP[Math.min(sortedP.length - 1, Math.ceil((sortedP.length - 1) * 0.80))];
        const minValidPeriod = upperRefPeriod * 0.35;
        const filteredRising: typeof risingEdges = [risingEdges[0]];
        const suppressedRiseTimes: Array<{ t0: number; t1: number; seg: number }> = [];
        for (let k = 1; k < risingEdges.length; k++) {
          const prevKept = filteredRising[filteredRising.length - 1];
          const curr = risingEdges[k];
          if (curr.segmentId === prevKept.segmentId && curr.time - prevKept.time < minValidPeriod) {
            const next = risingEdges[k + 1];
            const mergedMatchesUpper =
              next &&
              next.segmentId === prevKept.segmentId &&
              next.time - prevKept.time <= upperRefPeriod * 1.45;
            if (mergedMatchesUpper || (k === risingEdges.length - 1 && curr.time - prevKept.time < upperRefPeriod * 0.25)) {
              suppressedRiseTimes.push({ t0: prevKept.time, t1: curr.time, seg: curr.segmentId });
              continue;
            }
          }
          filteredRising.push(curr);
        }
        if (suppressedRiseTimes.length > 0 && filteredRising.length >= 2) {
          risingEdges = filteredRising;
          const isGlitchEvent = (seg: number, tm: number) =>
            suppressedRiseTimes.some((g) => g.seg === seg && tm > g.t0 && tm <= g.t1);
          fallingEdges = fallingEdges.filter((fe) => !isGlitchEvent(fe.segmentId, fe.time));
          events = events.filter((ev) => !isGlitchEvent(ev.segmentId, ev.time));
        }
      }
    }

    // Period & per-cycle amplitude stats across consecutive rising edges within the SAME continuous segment
    const segmentPeriods: number[] = [];
    const segmentFreqs: number[] = [];
    const cycMaxArr: number[] = [];
    const cycMinArr: number[] = [];
    const cycVppArr: number[] = [];
    const cycRmsArr: number[] = [];
    const cycOvshArr: number[] = [];
    const cycUnshArr: number[] = [];

    for (let k = 0; k + 1 < risingEdges.length; k++) {
      const r0 = risingEdges[k];
      const r1 = risingEdges[k + 1];
      if (r0.segmentId === r1.segmentId && r1.time > r0.time) {
        const pSec = r1.time - r0.time;
        segmentPeriods.push(pSec);
        segmentFreqs.push(1 / pSec);

        // O(N) non-overlapping per-cycle amplitude scan
        const idxA = Math.max(startIdx, r0.sampleIdx);
        const idxB = Math.min(endIdx, r1.sampleIdx);
        if (idxB > idxA) {
          let cMin = Infinity;
          let cMax = -Infinity;
          let cSqInt = 0;
          let cDtTot = 0;
          let cSumSq = 0;
          let cCnt = 0;
          for (let idx = idxA; idx <= idxB; idx++) {
            const vCur = valAt(idx);
            if (!isFinite(vCur)) continue;
            if (vCur < cMin) cMin = vCur;
            if (vCur > cMax) cMax = vCur;
            cSumSq += vCur * vCur;
            cCnt++;
            if (idx > idxA) {
              const vPrv = valAt(idx - 1);
              const dtC = t[idx] - t[idx - 1];
              if (isFinite(vPrv) && dtC > 0 && (!Number.isFinite(gapThreshold) || dtC <= gapThreshold)) {
                cSqInt += ((vPrv * vPrv + vPrv * vCur + vCur * vCur) / 3) * dtC;
                cDtTot += dtC;
              }
            }
          }
          if (cCnt >= 2 && isFinite(cMin) && isFinite(cMax)) {
            cycMaxArr.push(cMax);
            cycMinArr.push(cMin);
            cycVppArr.push(cMax - cMin);
            cycRmsArr.push(cDtTot > 0 ? Math.sqrt(Math.max(0, cSqInt / cDtTot)) : Math.sqrt(cSumSq / cCnt));
            if (baseAmp > 1e-12) {
              cycOvshArr.push(Math.max(0, ((cMax - vtop) / baseAmp) * 100));
              cycUnshArr.push(Math.max(0, ((vbase - cMin) / baseAmp) * 100));
            }
          }
        }
      }
    }

    cycleCount = segmentPeriods.length;
    if (segmentPeriods.length >= 1) {
      period = segmentPeriods.reduce((a, b) => a + b, 0) / segmentPeriods.length;
      if (period > 0) {
        frequency = 1 / period;
      }
      const pStat = summarizeCycleDistribution(segmentPeriods);
      const fStat = summarizeCycleDistribution(segmentFreqs);
      if (pStat) cycleStats.period = pStat;
      if (fStat) cycleStats.frequency = fStat;
    } else {
      statusNotes.push('Insufficient continuous cycles in range for period/frequency detection');
    }

    const maxStat = summarizeCycleDistribution(cycMaxArr);
    const minStat = summarizeCycleDistribution(cycMinArr);
    const vppStat = summarizeCycleDistribution(cycVppArr);
    const rmsStat = summarizeCycleDistribution(cycRmsArr);
    const ovshStat = summarizeCycleDistribution(cycOvshArr);
    const unshStat = summarizeCycleDistribution(cycUnshArr);
    if (maxStat) cycleStats.max = maxStat;
    if (minStat) cycleStats.min = minStat;
    if (vppStat) cycleStats.vpp = vppStat;
    if (rmsStat) cycleStats.rms = rmsStat;
    if (ovshStat) cycleStats.overshoot = ovshStat;
    if (unshStat) cycleStats.undershoot = unshStat;

    // +Width & -Width across consecutive alternating edges within the SAME continuous segment
    const posWidths: number[] = [];
    const negWidths: number[] = [];
    for (let k = 0; k + 1 < events.length; k++) {
      const e1 = events[k];
      const e2 = events[k + 1];
      if (e1.segmentId !== e2.segmentId) continue;
      const dur = e2.time - e1.time;
      if (dur > 0) {
        if (e1.type === 'rise' && e2.type === 'fall') posWidths.push(dur);
        else if (e1.type === 'fall' && e2.type === 'rise') negWidths.push(dur);
      }
    }
    if (posWidths.length > 0) {
      posWidth = posWidths.reduce((a, b) => a + b, 0) / posWidths.length;
      const pwStat = summarizeCycleDistribution(posWidths);
      if (pwStat) cycleStats.posWidth = pwStat;
    }
    if (negWidths.length > 0) {
      negWidth = negWidths.reduce((a, b) => a + b, 0) / negWidths.length;
      const nwStat = summarizeCycleDistribution(negWidths);
      if (nwStat) cycleStats.negWidth = nwStat;
    }

    // Cycle-by-cycle duty cycle array across consecutive rising edges in the SAME continuous segment
    const cycleDuties: number[] = [];
    let fallCursor = 0;
    for (let k = 0; k + 1 < risingEdges.length; k++) {
      const rStart = risingEdges[k];
      const rEnd = risingEdges[k + 1];
      if (rStart.segmentId !== rEnd.segmentId) continue;
      const cycPeriod = rEnd.time - rStart.time;
      if (cycPeriod <= 0) continue;
      while (
        fallCursor < fallingEdges.length &&
        (fallingEdges[fallCursor].segmentId < rStart.segmentId ||
          (fallingEdges[fallCursor].segmentId === rStart.segmentId && fallingEdges[fallCursor].time <= rStart.time))
      ) {
        fallCursor++;
      }
      if (
        fallCursor < fallingEdges.length &&
        fallingEdges[fallCursor].segmentId === rStart.segmentId &&
        fallingEdges[fallCursor].time < rEnd.time
      ) {
        const highDur = fallingEdges[fallCursor].time - rStart.time;
        cycleDuties.push(Math.max(0, Math.min(100, (highDur / cycPeriod) * 100)));
      }
    }

    if (cycleDuties.length > 0) {
      maxDutyCycle = Math.max(...cycleDuties);
      minDutyCycle = Math.min(...cycleDuties);
      dutyCycle = cycleDuties.reduce((a, b) => a + b, 0) / cycleDuties.length;
      const dStat = summarizeCycleDistribution(cycleDuties);
      if (dStat) cycleStats.dutyCycle = dStat;
    } else if (posWidth !== null && period !== null && period > 0) {
      dutyCycle = Math.max(0, Math.min(100, (posWidth / period) * 100));
    }

    // Rise Time (10% to 90%), Fall Time (90% to 10%), and ±Slew Rate (10-90% dv/dt or di/dt) strictly within continuous segments
    const refLow = baseAmp > 1e-12 ? vbase : min;
    const refSpan = baseAmp > 1e-12 ? baseAmp : vpp;
    const v10 = refLow + 0.1 * refSpan;
    const v90 = refLow + 0.9 * refSpan;
    const dv1090 = v90 - v10;

    const riseTimes: number[] = [];
    const fallTimes: number[] = [];
    const riseSlews: number[] = [];
    const fallSlews: number[] = [];

    let riseStartT: number | null = null;
    let fallStartT: number | null = null;

    for (let i = firstValidIdx + 1; i <= endIdx; i++) {
      const vp = valAt(i - 1);
      const vc = valAt(i);
      const tp = t[i - 1];
      const tc = t[i];
      const dtSpan = tc - tp;
      if (!isFinite(vp) || !isFinite(vc) || (Number.isFinite(gapThreshold) && dtSpan > gapThreshold)) {
        riseStartT = null;
        fallStartT = null;
        continue;
      }

      if (vp <= v10 && vc > v10) {
        riseStartT = tp + ((v10 - vp) / (vc - vp)) * dtSpan;
      }
      if (riseStartT !== null && vp < v90 && vc >= v90) {
        const t90 = tp + ((v90 - vp) / (vc - vp)) * dtSpan;
        const dtRise = t90 - riseStartT;
        if (dtRise > 1e-15) {
          riseTimes.push(dtRise);
          riseSlews.push(dv1090 / dtRise);
        }
        riseStartT = null;
      } else if (vc < vp) {
        riseStartT = null;
      }

      if (vp >= v90 && vc < v90) {
        fallStartT = tp + ((vp - v90) / (vp - vc)) * dtSpan;
      }
      if (fallStartT !== null && vp > v10 && vc <= v10) {
        const t10 = tp + ((vp - v10) / (vp - vc)) * dtSpan;
        const dtFall = t10 - fallStartT;
        if (dtFall > 1e-15) {
          fallTimes.push(dtFall);
          fallSlews.push(dv1090 / dtFall);
        }
        fallStartT = null;
      } else if (vc > vp) {
        fallStartT = null;
      }
    }

    if (riseTimes.length > 0) {
      riseTime = riseTimes.reduce((a, b) => a + b, 0) / riseTimes.length;
      slewRateRise = riseSlews.reduce((a, b) => a + b, 0) / riseSlews.length;
      const rtStat = summarizeCycleDistribution(riseTimes);
      const rsStat = summarizeCycleDistribution(riseSlews);
      if (rtStat) cycleStats.riseTime = rtStat;
      if (rsStat) cycleStats.slewRateRise = rsStat;
    }
    if (fallTimes.length > 0) {
      fallTime = fallTimes.reduce((a, b) => a + b, 0) / fallTimes.length;
      slewRateFall = fallSlews.reduce((a, b) => a + b, 0) / fallSlews.length;
      const ftStat = summarizeCycleDistribution(fallTimes);
      const fsStat = summarizeCycleDistribution(fallSlews);
      if (ftStat) cycleStats.fallTime = ftStat;
      if (fsStat) cycleStats.slewRateFall = fsStat;
    }
  }

  return {
    channelId: channel.id,
    channelName: channel.name,
    unit: channel.unit,
    gate,
    sampleCount: validCount,
    timeStart,
    timeEnd,
    max,
    min,
    average,
    absAverage,
    rms,
    vpp,
    peak,
    vtop,
    vbase,
    overshoot,
    undershoot,
    period,
    frequency,
    dutyCycle,
    maxDutyCycle,
    minDutyCycle,
    riseTime,
    fallTime,
    slewRateRise,
    slewRateFall,
    posWidth,
    negWidth,
    cycleCount,
    cycleStats,
    valid: validCount >= 2,
    status: validCount >= 2 ? 'OK' : 'INSUFFICIENT_DATA',
    coveragePct,
    gapCount,
    invalidSampleCount,
    statusMessage: statusNotes.length > 0 ? statusNotes.join(' ') : undefined,
  };
}

function aggregateTimeWeightedMean(
  t: Float64Array,
  v: Float32Array,
  gapThreshold: number,
  isUniformMetadata?: boolean
): number | null {
  const n = Math.min(t.length, v.length);
  let sum = 0;
  let cnt = 0;
  let invalidCount = 0;
  let gapCount = 0;
  let trapSum = 0;
  let totalDt = 0;
  let minDt = Infinity;
  let maxDt = 0;
  let prevVal: number | null = null;
  let prevTime: number | null = null;

  for (let i = 0; i < n; i++) {
    const val = v[i];
    const ti = t[i];
    if (isFinite(val) && isFinite(ti)) {
      sum += val;
      cnt++;
      if (prevVal !== null && prevTime !== null) {
        const dt = ti - prevTime;
        if (dt > 0) {
          if (Number.isFinite(gapThreshold) && dt > gapThreshold) {
            gapCount++;
          } else {
            if (dt < minDt) minDt = dt;
            if (dt > maxDt) maxDt = dt;
            trapSum += 0.5 * (prevVal + val) * dt;
            totalDt += dt;
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
  if (cnt === 0) return null;
  const hasVaryingDt = isFinite(minDt) && maxDt > 0 && minDt < maxDt * 0.98;
  const useTimeWeighted =
    totalDt > 0 && (isUniformMetadata === false || hasVaryingDt || gapCount > 0 || invalidCount > 0);
  return useTimeWeighted ? trapSum / totalDt : sum / cnt;
}

/**
 * Evaluates a user-defined extensible custom metric safely using mathParser AST,
 * returning structured status and failure reason for UI diagnostics.
 */
export function evaluateCustomMeasurementDetailed(
  def: CustomMeasurementDefinition,
  channel: WaveformChannel,
  meas: ChannelMeasurements,
  gate: MeasurementGate,
  viewIndices: { startIndex: number; endIndex: number },
  cursors: CursorsState,
  viewTimeBounds?: { tStart: number; tEnd: number }
): CustomMeasurementDetailedResult {
  try {
    const integrity = validateChannelIntegrity(channel, 1, DEFAULT_SAMPLING_GAP_FACTOR);
    if (!integrity.valid) {
      return {
        value: null,
        valid: false,
        status: 'INVALID',
        reason: integrity.invalidReason || 'Channel failed integrity validation.',
      };
    }

    const totalN = channel.t.length;
    const gapThreshold = integrity.timebase.gapThresholdSec;
    const isConditioned = channel.coupling === 'AC' || !!channel.inverted;
    const cachedMean = channel.coupling === 'AC' ? computeChannelMean(channel) : 0;
    const valAtRaw = (idx: number) =>
      isConditioned ? getChannelDisplayValue(channel, idx, cachedMean) : channel.v[idx];

    const gated = extractGatedSamples(
      channel.t,
      valAtRaw,
      totalN,
      gate,
      viewIndices,
      cursors,
      gapThreshold,
      viewTimeBounds
    );
    if (!gated.hasOverlap) {
      return {
        value: null,
        valid: false,
        status: gated.status,
        reason: gated.reason || 'No overlap with gated window.',
      };
    }

    const sliceT = gated.t;
    const sliceV = gated.v;
    const sliceLen = sliceT.length;

    const sliceChannel: WaveformChannel = {
      ...channel,
      id: '__x__',
      name: 'x',
      coupling: 'DC',
      inverted: false,
      t: sliceT,
      v: sliceV,
    };

    const scalarVars: Record<string, number> = {
      vmax: meas.max ?? NaN,
      vmin: meas.min ?? NaN,
      vpp: meas.vpp ?? NaN,
      vmean: meas.average ?? NaN,
      absmean: meas.absAverage ?? NaN,
      vrms: meas.rms ?? NaN,
      vtop: meas.vtop ?? NaN,
      vbase: meas.vbase ?? NaN,
      overshoot: meas.overshoot ?? NaN,
      undershoot: meas.undershoot ?? NaN,
      freq: meas.frequency ?? NaN,
      period: meas.period ?? NaN,
      rise: meas.riseTime ?? NaN,
      fall: meas.fallTime ?? NaN,
      dvdt_rise: meas.slewRateRise ?? NaN,
      dvdt_fall: meas.slewRateFall ?? NaN,
      poswidth: meas.posWidth ?? NaN,
      negwidth: meas.negWidth ?? NaN,
      duty: meas.dutyCycle ?? NaN,
      maxduty: meas.maxDutyCycle ?? NaN,
      minduty: meas.minDutyCycle ?? NaN,
      peak: meas.peak ?? NaN,
    };

    const channelsMap: Record<string, WaveformChannel> = {
      __x__: sliceChannel,
    };
    const aliases = { X: '__x__', V: '__x__' };
    const tokens = tokenizeMath(def.expression, aliases, channelsMap);
    const rpn = toRPN(tokens);
    const dt = channel.dt || (sliceLen > 1 ? (sliceT[sliceLen - 1] - sliceT[0]) / (sliceLen - 1) : 1e-4);
    const outArr = evaluateRPN(rpn, channelsMap, aliases, sliceLen, dt, sliceT, scalarVars);

    const meanVal = aggregateTimeWeightedMean(
      sliceT,
      outArr,
      gapThreshold,
      channel.metadata?.isUniformSampling
    );
    if (meanVal === null || !Number.isFinite(meanVal)) {
      return {
        value: null,
        valid: false,
        status: 'INSUFFICIENT_DATA',
        reason: 'Custom expression produced no finite output samples (NaN/Inf or division by zero).',
      };
    }
    return { value: meanVal, valid: true, status: 'OK' };
  } catch (err: any) {
    return {
      value: null,
      valid: false,
      status: 'EVAL_ERROR',
      reason: err?.message || 'Custom measurement expression failed.',
    };
  }
}

/**
 * Evaluates a user-defined extensible custom metric safely using mathParser AST.
 * Supports built-in metric variables (vmax, vmin, vpp, vmean, absmean, vrms, vtop, vbase,
 * overshoot, freq, period, rise, fall, poswidth, negwidth, duty, maxduty, minduty, peak)
 * as well as gated signal vectors x / v (e.g. "mean(abs(x)^2)", "peak/vrms").
 */
export function evaluateCustomMeasurement(
  def: CustomMeasurementDefinition,
  channel: WaveformChannel,
  meas: ChannelMeasurements,
  gate: MeasurementGate,
  viewIndices: { startIndex: number; endIndex: number },
  cursors: CursorsState,
  viewTimeBounds?: { tStart: number; tEnd: number }
): number | null {
  return evaluateCustomMeasurementDetailed(
    def,
    channel,
    meas,
    gate,
    viewIndices,
    cursors,
    viewTimeBounds
  ).value;
}
