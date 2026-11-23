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
  MeasurementGate,
  MeasurementMetricKey,
  WaveformChannel,
  CursorsState,
} from '../types/models';
import { computeChannelMean, getChannelDisplayValue } from './oscilloscopeScale';
import { evaluateRPN, tokenizeMath, toRPN } from './mathParser';

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
  { key: 'absAverage', group: 'voltage', label: 'Abs Mean (|V|avg)', shortLabel: '|V|avg', unitType: 'signal' },
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
  { key: 'maxDutyCycle', group: 'timing', label: 'Max Duty Cycle (%)', shortLabel: 'DutyMax', unitType: 'percent' },
  { key: 'minDutyCycle', group: 'timing', label: 'Min Duty Cycle (%)', shortLabel: 'DutyMin', unitType: 'percent' },
];

export const CUSTOM_MEASUREMENT_PRESETS: Array<Omit<CustomMeasurementDefinition, 'id'>> = [
  { label: 'Crest Factor (Peak/RMS)', shortLabel: 'CF', expression: 'peak / vrms', unitType: 'ratio' },
  { label: 'AC Ripple RMS', shortLabel: 'Vac_rms', expression: 'sqrt(vrms^2 - vmean^2)', unitType: 'signal' },
  { label: 'Form Factor (RMS/|Avg|)', shortLabel: 'FF', expression: 'vrms / absmean', unitType: 'ratio' },
  { label: 'Duty Spread (Max-Min)', shortLabel: 'ΔDuty', expression: 'maxduty - minduty', unitType: 'percent' },
];

function resolveGateIndexRange(
  t: Float64Array,
  totalN: number,
  gate: MeasurementGate,
  viewIndices: { startIndex: number; endIndex: number },
  cursors: CursorsState,
  viewTimeBounds?: { tStart: number; tEnd: number }
): { startIdx: number; endIdx: number } {
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

  return { startIdx, endIdx };
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
      posWidth: null,
      negWidth: null,
      statusMessage: 'Empty channel data.',
    };
  }

  const isConditioned = channel.coupling === 'AC' || !!channel.inverted;
  const cachedMean = channel.coupling === 'AC' ? computeChannelMean(channel) : 0;
  const valAt = (idx: number) => (isConditioned ? getChannelDisplayValue(channel, idx, cachedMean) : v[idx]);

  const { startIdx, endIdx } = resolveGateIndexRange(t, totalN, gate, viewIndices, cursors, viewTimeBounds);

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
      absAverage: singleVal !== null ? Math.abs(singleVal) : null,
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
      maxDutyCycle: null,
      minDutyCycle: null,
      riseTime: null,
      fallTime: null,
      posWidth: null,
      negWidth: null,
      statusMessage: 'Insufficient points in selected gate range.',
    };
  }

  // Pass 1: Basic statistics + time-weighted trapezoidal integrals for non-uniform / variable-step captures
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumAbs = 0;
  let sumSq = 0;
  let validCount = 0;

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
      prevValidVal = val;
      prevValidTime = ti;
    } else {
      prevValidVal = null;
      prevValidTime = null;
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
      posWidth: null,
      negWidth: null,
      statusMessage: 'No valid numeric samples in range.',
    };
  }

  const hasVaryingDt =
    isFinite(minDtObserved) && maxDtObserved > 0 && minDtObserved < maxDtObserved * 0.98;
  const useTimeWeighted =
    totalDtWeight > 0 && (channel.metadata?.isUniformSampling === false || hasVaryingDt);

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

  // Timing analysis: Frequency, Period, +Width, -Width, Duty, Max Duty, Min Duty, Rise/Fall Time
  let period: number | null = null;
  let frequency: number | null = null;
  let dutyCycle: number | null = null;
  let maxDutyCycle: number | null = null;
  let minDutyCycle: number | null = null;
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

    // Cycle-by-cycle duty cycle array across consecutive rising edges
    const cycleDuties: number[] = [];
    let fallCursor = 0;
    for (let k = 0; k + 1 < risingEdgeTimes.length; k++) {
      const rStart = risingEdgeTimes[k];
      const rEnd = risingEdgeTimes[k + 1];
      const cycPeriod = rEnd - rStart;
      if (cycPeriod <= 0) continue;
      while (fallCursor < fallingEdgeTimes.length && fallingEdgeTimes[fallCursor] <= rStart) {
        fallCursor++;
      }
      if (fallCursor < fallingEdgeTimes.length && fallingEdgeTimes[fallCursor] < rEnd) {
        const highDur = fallingEdgeTimes[fallCursor] - rStart;
        cycleDuties.push(Math.max(0, Math.min(100, (highDur / cycPeriod) * 100)));
      }
    }

    if (cycleDuties.length > 0) {
      maxDutyCycle = Math.max(...cycleDuties);
      minDutyCycle = Math.min(...cycleDuties);
      dutyCycle = cycleDuties.reduce((a, b) => a + b, 0) / cycleDuties.length;
    } else if (posWidth !== null && period !== null && period > 0) {
      dutyCycle = Math.max(0, Math.min(100, (posWidth / period) * 100));
    }

    // Rise Time (10% to 90%) and Fall Time (90% to 10%)
    const refLow = baseAmp > 1e-12 ? vbase : min;
    const refSpan = baseAmp > 1e-12 ? baseAmp : vpp;
    const v10 = refLow + 0.1 * refSpan;
    const v90 = refLow + 0.9 * refSpan;

    const riseTimes: number[] = [];
    const fallTimes: number[] = [];

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
    posWidth,
    negWidth,
    statusMessage,
  };
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
  try {
    const totalN = Math.min(channel.t.length, channel.v.length);
    if (totalN === 0) return null;

    const { startIdx, endIdx } = resolveGateIndexRange(
      channel.t,
      totalN,
      gate,
      viewIndices,
      cursors,
      viewTimeBounds
    );
    const sliceLen = Math.max(1, endIdx - startIdx + 1);
    const sliceT = channel.t.subarray(startIdx, endIdx + 1);
    const isConditioned = channel.coupling === 'AC' || !!channel.inverted;
    const cachedMean = channel.coupling === 'AC' ? computeChannelMean(channel) : 0;
    const sliceV = new Float32Array(sliceLen);
    for (let i = 0; i < sliceLen; i++) {
      const idx = startIdx + i;
      sliceV[i] = isConditioned ? getChannelDisplayValue(channel, idx, cachedMean) : channel.v[idx];
    }

    const sliceChannel: WaveformChannel = {
      ...channel,
      id: '__x__',
      name: 'x',
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
      freq: meas.frequency ?? NaN,
      period: meas.period ?? NaN,
      rise: meas.riseTime ?? NaN,
      fall: meas.fallTime ?? NaN,
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

    let sum = 0;
    let cnt = 0;
    for (let i = 0; i < outArr.length; i++) {
      if (isFinite(outArr[i])) {
        sum += outArr[i];
        cnt++;
      }
    }
    return cnt > 0 ? sum / cnt : null;
  } catch {
    return null;
  }
}
