/**
 * Waveform Viewer Pro - Oscilloscope Automated Measurements Engine
 * Computes 15 engineering parameters:
 *   Voltage: Max, Min, Vpp, Mean, RMS, Vtop (histogram high plateau), Vbase (histogram low plateau), Overshoot (%)
 *   Timing:  Frequency, Period, Rise Time (10-90%), Fall Time (90-10%), +Width, -Width, Duty Cycle (%)
 * Strictly guarded against empty arrays, NaNs, flat signals, and division by zero.
 */

import {
  ChannelMeasurements,
  MeasurementGate,
  MeasurementMetricKey,
  WaveformChannel,
  CursorsState,
} from '../types/models';
import { computeChannelMean, getChannelDisplayValue } from './oscilloscopeScale';

export interface MeasurementDefinition {
  key: MeasurementMetricKey;
  group: 'voltage' | 'timing';
  label: string;
  shortLabel: string;
  unitType: 'signal' | 'freq' | 'time' | 'percent';
}

export const MEASUREMENT_DEFINITIONS: MeasurementDefinition[] = [
  // Voltage / Amplitude
  { key: 'max', group: 'voltage', label: 'Max (Vmax)', shortLabel: 'Vmax', unitType: 'signal' },
  { key: 'min', group: 'voltage', label: 'Min (Vmin)', shortLabel: 'Vmin', unitType: 'signal' },
  { key: 'vpp', group: 'voltage', label: 'Peak-to-Peak (Vpp)', shortLabel: 'Vpp', unitType: 'signal' },
  { key: 'average', group: 'voltage', label: 'Mean (Vmean)', shortLabel: 'Vmean', unitType: 'signal' },
  { key: 'rms', group: 'voltage', label: 'RMS (Vrms)', shortLabel: 'Vrms', unitType: 'signal' },
  { key: 'vtop', group: 'voltage', label: 'Top (Vtop)', shortLabel: 'Vtop', unitType: 'signal' },
  { key: 'vbase', group: 'voltage', label: 'Base (Vbase)', shortLabel: 'Vbase', unitType: 'signal' },
  { key: 'overshoot', group: 'voltage', label: 'Overshoot (%)', shortLabel: 'Ovsh', unitType: 'percent' },
  // Timing / Frequency
  { key: 'frequency', group: 'timing', label: 'Frequency', shortLabel: 'Freq', unitType: 'freq' },
  { key: 'period', group: 'timing', label: 'Period', shortLabel: 'Period', unitType: 'time' },
  { key: 'riseTime', group: 'timing', label: 'Rise Time (10-90%)', shortLabel: 'Rise', unitType: 'time' },
  { key: 'fallTime', group: 'timing', label: 'Fall Time (90-10%)', shortLabel: 'Fall', unitType: 'time' },
  { key: 'posWidth', group: 'timing', label: '+Width (50%)', shortLabel: '+Width', unitType: 'time' },
  { key: 'negWidth', group: 'timing', label: '-Width (50%)', shortLabel: '-Width', unitType: 'time' },
  { key: 'dutyCycle', group: 'timing', label: 'Duty Cycle (%)', shortLabel: 'Duty', unitType: 'percent' },
];

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

  const bins = 64;
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

  const midBin = Math.floor(bins / 2);

  // Upper half modal peak (Vtop)
  let topPeakBin = bins - 1;
  let topMaxCount = 0;
  for (let b = midBin; b < bins; b++) {
    if (counts[b] > topMaxCount) {
      topMaxCount = counts[b];
      topPeakBin = b;
    }
  }

  // Lower half modal peak (Vbase)
  let basePeakBin = 0;
  let baseMaxCount = 0;
  for (let b = 0; b < midBin; b++) {
    if (counts[b] > baseMaxCount) {
      baseMaxCount = counts[b];
      basePeakBin = b;
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

  // Only treat histogram mode as bimodal plateau if peak density >= 3x uniform average
  const avgPerBin = totalSampled / bins;
  const vtop =
    topMaxCount > avgPerBin * 2.0 ? (clusterMean(topPeakBin) ?? max) : max;
  const vbase =
    baseMaxCount > avgPerBin * 2.0 ? (clusterMean(basePeakBin) ?? min) : min;

  return vtop > vbase ? { vtop, vbase } : { vtop: max, vbase: min };
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
  const t = channel.t;
  const v = channel.v;
  const totalN = Math.min(t ? t.length : 0, v ? v.length : 0);

  if (!channel || totalN === 0) {
    return {
      channelId: channel?.id || '',
      channelName: channel?.name || '',
      unit: channel?.unit || 'V',
      gate,
      sampleCount: 0,
      timeStart: 0,
      timeEnd: 0,
      max: null,
      min: null,
      average: null,
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
      riseTime: null,
      fallTime: null,
      posWidth: null,
      negWidth: null,
      statusMessage: 'Empty channel data.',
    };
  }

  const isConditioned = channel.coupling === 'AC' || !!channel.inverted;
  const cachedMean = channel.coupling === 'AC' ? computeChannelMean(channel) : 0;
  const valAt = (idx: number) => (isConditioned ? getChannelDisplayValue(channel, idx, cachedMean) : v[idx]);

  let startIdx = 0;
  let endIdx = totalN - 1;

  if (gate === 'view') {
    if (viewTimeBounds) {
      let lo = 0;
      let hi = totalN - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (t[mid] < viewTimeBounds.tStart) lo = mid + 1;
        else hi = mid;
      }
      startIdx = lo;
      lo = startIdx;
      hi = totalN;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (t[mid] <= viewTimeBounds.tEnd) lo = mid + 1;
        else hi = mid;
      }
      endIdx = Math.max(startIdx, Math.min(totalN - 1, lo - 1));
    } else {
      startIdx = Math.max(0, Math.min(totalN - 1, viewIndices.startIndex));
      endIdx = Math.max(startIdx, Math.min(totalN - 1, viewIndices.endIndex));
    }
  } else if (gate === 'cursors' && cursors.enabled && cursors.x1 !== null && cursors.x2 !== null) {
    const xMin = Math.min(cursors.x1, cursors.x2);
    const xMax = Math.max(cursors.x1, cursors.x2);
    let s = 0;
    while (s < totalN && t[s] < xMin) s++;
    let e = s;
    while (e < totalN && t[e] <= xMax) e++;
    startIdx = Math.max(0, Math.min(totalN - 1, s));
    endIdx = Math.max(startIdx, Math.min(totalN - 1, e - 1));
  }

  const sampleCount = endIdx - startIdx + 1;
  const timeStart = t[startIdx];
  const timeEnd = t[endIdx];

  if (sampleCount < 2) {
    const singleRaw = valAt(startIdx);
    const singleVal = isFinite(singleRaw) ? singleRaw : null;
    return {
      channelId: channel.id,
      channelName: channel.name,
      unit: channel.unit,
      gate,
      sampleCount,
      timeStart,
      timeEnd,
      max: singleVal,
      min: singleVal,
      average: singleVal,
      rms: singleVal !== null ? Math.abs(singleVal) : null,
      vpp: singleVal !== null ? 0 : null,
      peak: singleVal !== null ? Math.abs(singleVal) : null,
      vtop: singleVal,
      vbase: singleVal,
      overshoot: null,
      undershoot: null,
      period: null,
      frequency: null,
      dutyCycle: null,
      riseTime: null,
      fallTime: null,
      posWidth: null,
      negWidth: null,
      statusMessage: 'Insufficient points in selected gate range.',
    };
  }

  // Pass 1: Basic statistics (Min, Max, Sum, SumSq)
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSq = 0;
  let validCount = 0;

  for (let i = startIdx; i <= endIdx; i++) {
    const val = valAt(i);
    if (!isNaN(val) && isFinite(val)) {
      if (val < min) min = val;
      if (val > max) max = val;
      sum += val;
      sumSq += val * val;
      validCount++;
    }
  }

  if (validCount === 0 || !isFinite(min) || !isFinite(max)) {
    return {
      channelId: channel.id,
      channelName: channel.name,
      unit: channel.unit,
      gate,
      sampleCount: 0,
      timeStart,
      timeEnd,
      max: null,
      min: null,
      average: null,
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
      riseTime: null,
      fallTime: null,
      posWidth: null,
      negWidth: null,
      statusMessage: 'No valid numeric samples in range.',
    };
  }

  const average = sum / validCount;
  const rms = Math.sqrt(sumSq / validCount);
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

  // Timing analysis: Frequency, Period, +Width, -Width, Duty, Rise/Fall Time
  let period: number | null = null;
  let frequency: number | null = null;
  let dutyCycle: number | null = null;
  let riseTime: number | null = null;
  let fallTime: number | null = null;
  let posWidth: number | null = null;
  let negWidth: number | null = null;
  let statusMessage: string | undefined;

  if (vpp > 1e-12) {
    const midLevel = baseAmp > 1e-12 ? (vtop + vbase) / 2 : (max + min) / 2;
    const hysteresis = 0.05 * vpp;
    const midHigh = midLevel + hysteresis;
    const midLow = midLevel - hysteresis;

    const events: Array<{ type: 'rise' | 'fall'; time: number }> = [];
    const risingEdgeTimes: number[] = [];
    const fallingEdgeTimes: number[] = [];

    let firstValidIdx = startIdx;
    while (firstValidIdx <= endIdx && !isFinite(valAt(firstValidIdx))) firstValidIdx++;
    let state: 'low' | 'high' = firstValidIdx <= endIdx && valAt(firstValidIdx) >= midLevel ? 'high' : 'low';

    for (let i = firstValidIdx + 1; i <= endIdx; i++) {
      const vPrev = valAt(i - 1);
      const vCurr = valAt(i);
      if (!isFinite(vPrev) || !isFinite(vCurr)) continue;

      const tPrev = t[i - 1];
      const tCurr = t[i];
      const dv = vCurr - vPrev;

      if (state === 'low' && vCurr >= midHigh) {
        const frac = Math.abs(dv) > 1e-15 ? Math.max(0, Math.min(1, (midLevel - vPrev) / dv)) : 0.5;
        const cTime = tPrev + frac * (tCurr - tPrev);
        risingEdgeTimes.push(cTime);
        events.push({ type: 'rise', time: cTime });
        state = 'high';
      } else if (state === 'high' && vCurr <= midLow) {
        const frac = Math.abs(dv) > 1e-15 ? Math.max(0, Math.min(1, (midLevel - vPrev) / dv)) : 0.5;
        const cTime = tPrev + frac * (tCurr - tPrev);
        fallingEdgeTimes.push(cTime);
        events.push({ type: 'fall', time: cTime });
        state = 'low';
      }
    }

    if (risingEdgeTimes.length >= 2) {
      let totalPeriod = 0;
      const count = risingEdgeTimes.length - 1;
      for (let k = 0; k < count; k++) {
        totalPeriod += risingEdgeTimes[k + 1] - risingEdgeTimes[k];
      }
      period = totalPeriod / count;
      if (period > 0) {
        frequency = 1 / period;
      }
    } else {
      statusMessage = 'Insufficient cycles in range for period/frequency detection';
    }

    // +Width & -Width across consecutive alternating edges
    const posWidths: number[] = [];
    const negWidths: number[] = [];
    for (let k = 0; k + 1 < events.length; k++) {
      const e1 = events[k];
      const e2 = events[k + 1];
      const dur = e2.time - e1.time;
      if (dur > 0) {
        if (e1.type === 'rise' && e2.type === 'fall') posWidths.push(dur);
        else if (e1.type === 'fall' && e2.type === 'rise') negWidths.push(dur);
      }
    }
    if (posWidths.length > 0) {
      posWidth = posWidths.reduce((a, b) => a + b, 0) / posWidths.length;
    }
    if (negWidths.length > 0) {
      negWidth = negWidths.reduce((a, b) => a + b, 0) / negWidths.length;
    }

    if (posWidth !== null && period !== null && period > 0) {
      dutyCycle = Math.max(0, Math.min(100, (posWidth / period) * 100));
    }

    // Rise Time (10% to 90%) and Fall Time (90% to 10%)
    const refLow = baseAmp > 1e-12 ? vbase : min;
    const refSpan = baseAmp > 1e-12 ? baseAmp : vpp;
    const v10 = refLow + 0.1 * refSpan;
    const v90 = refLow + 0.9 * refSpan;

    const riseTimes: number[] = [];
    const fallTimes: number[] = [];

    // Track threshold crossings robustly even across multi-sample edges
    let riseStartT: number | null = null;
    let fallStartT: number | null = null;

    for (let i = firstValidIdx + 1; i <= endIdx; i++) {
      const vp = valAt(i - 1);
      const vc = valAt(i);
      if (!isFinite(vp) || !isFinite(vc)) {
        riseStartT = null;
        fallStartT = null;
        continue;
      }
      const tp = t[i - 1];
      const tc = t[i];
      const dtSpan = tc - tp;

      // Single-step or multi-step rising edge
      if (vp <= v10 && vc > v10) {
        riseStartT = tp + ((v10 - vp) / (vc - vp)) * dtSpan;
      }
      if (riseStartT !== null && vp < v90 && vc >= v90) {
        const t90 = tp + ((v90 - vp) / (vc - vp)) * dtSpan;
        if (t90 > riseStartT) riseTimes.push(t90 - riseStartT);
        riseStartT = null;
      } else if (vc < vp) {
        riseStartT = null;
      }

      // Single-step or multi-step falling edge
      if (vp >= v90 && vc < v90) {
        fallStartT = tp + ((vp - v90) / (vp - vc)) * dtSpan;
      }
      if (fallStartT !== null && vp > v10 && vc <= v10) {
        const t10 = tp + ((vp - v10) / (vp - vc)) * dtSpan;
        if (t10 > fallStartT) fallTimes.push(t10 - fallStartT);
        fallStartT = null;
      } else if (vc > vp) {
        fallStartT = null;
      }
    }

    if (riseTimes.length > 0) {
      riseTime = riseTimes.reduce((a, b) => a + b, 0) / riseTimes.length;
    }
    if (fallTimes.length > 0) {
      fallTime = fallTimes.reduce((a, b) => a + b, 0) / fallTimes.length;
    }
  }

  return {
    channelId: channel.id,
    channelName: channel.name,
    unit: channel.unit,
    gate,
    sampleCount,
    timeStart,
    timeEnd,
    max,
    min,
    average,
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
    riseTime,
    fallTime,
    posWidth,
    negWidth,
    statusMessage,
  };
}
