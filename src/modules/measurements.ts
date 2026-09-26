/**
 * Waveform Viewer Pro - Oscilloscope Automated Measurements
 * Computes statistical and pulse parameters (Max, Min, RMS, Vpp, Freq, Period, Duty, Rise/Fall time, Overshoot)
 * Supports gated ranges (Current View, Cursors X1-X2, Entire Data).
 */

import { ChannelMeasurements, MeasurementGate, WaveformChannel, CursorsState } from '../types/models';

/**
 * Computes comprehensive oscilloscope measurements for a channel within the gated range.
 */
export function computeMeasurements(
  channel: WaveformChannel,
  gate: MeasurementGate,
  viewIndices: { startIndex: number; endIndex: number },
  cursors: CursorsState
): ChannelMeasurements {
  const t = channel.t;
  const v = channel.v;
  const totalN = v.length;

  let startIdx = 0;
  let endIdx = totalN - 1;

  if (gate === 'view') {
    startIdx = Math.max(0, Math.min(totalN - 1, viewIndices.startIndex));
    endIdx = Math.max(startIdx, Math.min(totalN - 1, viewIndices.endIndex));
  } else if (gate === 'cursors' && cursors.enabled && cursors.x1 !== null && cursors.x2 !== null) {
    const xMin = Math.min(cursors.x1, cursors.x2);
    const xMax = Math.max(cursors.x1, cursors.x2);

    // Binary search or scan for indices
    let s = 0;
    while (s < totalN && t[s] < xMin) s++;
    let e = s;
    while (e < totalN && t[e] <= xMax) e++;
    startIdx = Math.max(0, Math.min(totalN - 1, s));
    endIdx = Math.max(startIdx, Math.min(totalN - 1, e - 1));
  }

  const sampleCount = endIdx - startIdx + 1;
  const timeStart = totalN > 0 ? t[startIdx] : 0;
  const timeEnd = totalN > 0 ? t[endIdx] : 0;

  if (sampleCount < 2) {
    return {
      channelId: channel.id,
      channelName: channel.name,
      unit: channel.unit,
      gate,
      sampleCount,
      timeStart,
      timeEnd,
      max: sampleCount === 1 ? v[startIdx] : null,
      min: sampleCount === 1 ? v[startIdx] : null,
      average: sampleCount === 1 ? v[startIdx] : null,
      rms: sampleCount === 1 ? Math.abs(v[startIdx]) : null,
      vpp: 0,
      peak: sampleCount === 1 ? Math.abs(v[startIdx]) : null,
      period: null,
      frequency: null,
      dutyCycle: null,
      riseTime: null,
      fallTime: null,
      overshoot: null,
      undershoot: null,
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
    const val = v[i];
    if (!isNaN(val)) {
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
      period: null,
      frequency: null,
      dutyCycle: null,
      riseTime: null,
      fallTime: null,
      overshoot: null,
      undershoot: null,
      statusMessage: 'No valid numeric samples in range.',
    };
  }

  const average = sum / validCount;
  const rms = Math.sqrt(sumSq / validCount);
  const vpp = max - min;
  const peak = Math.max(Math.abs(max), Math.abs(min));

  // Timing analysis: Frequency, Period, Duty, Rise/Fall Time
  let period: number | null = null;
  let frequency: number | null = null;
  let dutyCycle: number | null = null;
  let riseTime: number | null = null;
  let fallTime: number | null = null;
  let overshoot: number | null = null;
  let undershoot: number | null = null;
  let statusMessage: string | undefined;

  if (vpp > 1e-9) {
    const midLevel = (max + min) / 2;
    const hysteresis = 0.05 * vpp;
    const midHigh = midLevel + hysteresis;
    const midLow = midLevel - hysteresis;

    // Detect rising edge crossings
    const risingEdgeTimes: number[] = [];
    const fallingEdgeTimes: number[] = [];
    let state: 'low' | 'high' = v[startIdx] >= midLevel ? 'high' : 'low';

    for (let i = startIdx + 1; i <= endIdx; i++) {
      const vPrev = v[i - 1];
      const vCurr = v[i];
      const tPrev = t[i - 1];
      const tCurr = t[i];

      if (state === 'low' && vCurr >= midHigh) {
        // Interpolate exact mid crossing time
        const frac = (midLevel - vPrev) / (vCurr - vPrev || 1e-12);
        risingEdgeTimes.push(tPrev + frac * (tCurr - tPrev));
        state = 'high';
      } else if (state === 'high' && vCurr <= midLow) {
        const frac = (midLevel - vPrev) / (vCurr - vPrev || 1e-12);
        fallingEdgeTimes.push(tPrev + frac * (tCurr - tPrev));
        state = 'low';
      }
    }

    if (risingEdgeTimes.length >= 2) {
      // Average periods between consecutive rising edges
      let totalPeriod = 0;
      const count = risingEdgeTimes.length - 1;
      for (let k = 0; k < count; k++) {
        totalPeriod += risingEdgeTimes[k + 1] - risingEdgeTimes[k];
      }
      period = totalPeriod / count;
      if (period > 0) {
        frequency = 1 / period;
      }

      // Duty Cycle if both rising and falling edges exist
      if (fallingEdgeTimes.length > 0) {
        // Measure high time inside first full cycle
        const r1 = risingEdgeTimes[0];
        const r2 = risingEdgeTimes[1];
        const fBetween = fallingEdgeTimes.find((f) => f > r1 && f < r2);
        if (fBetween) {
          const highTime = fBetween - r1;
          const cyclePeriod = r2 - r1;
          dutyCycle = (highTime / cyclePeriod) * 100;
        }
      }
    } else {
      statusMessage = 'Insufficient cycles in range for period/frequency detection';
    }

    // Rise Time (10% to 90%) and Fall Time (90% to 10%)
    const v10 = min + 0.1 * vpp;
    const v90 = min + 0.9 * vpp;

    const riseTimes: number[] = [];
    const fallTimes: number[] = [];

    for (let i = startIdx + 1; i <= endIdx; i++) {
      // Check rising transition
      if (v[i - 1] <= v10 && v[i] >= v90) {
        const dtSpan = t[i] - t[i - 1];
        const dvSpan = v[i] - v[i - 1];
        if (dvSpan > 0) {
          const t10 = t[i - 1] + ((v10 - v[i - 1]) / dvSpan) * dtSpan;
          const t90 = t[i - 1] + ((v90 - v[i - 1]) / dvSpan) * dtSpan;
          if (t90 > t10) riseTimes.push(t90 - t10);
        }
      } else if (v[i - 1] >= v90 && v[i] <= v10) {
        const dtSpan = t[i] - t[i - 1];
        const dvSpan = v[i - 1] - v[i];
        if (dvSpan > 0) {
          const t90 = t[i - 1] + ((v[i - 1] - v90) / dvSpan) * dtSpan;
          const t10 = t[i - 1] + ((v[i - 1] - v10) / dvSpan) * dtSpan;
          if (t10 > t90) fallTimes.push(t10 - t90);
        }
      }
    }

    if (riseTimes.length > 0) {
      riseTime = riseTimes.reduce((a, b) => a + b, 0) / riseTimes.length;
    }
    if (fallTimes.length > 0) {
      fallTime = fallTimes.reduce((a, b) => a + b, 0) / fallTimes.length;
    }

    // Overshoot and Undershoot relative to pulse top/base
    if (dutyCycle !== null) {
      const topLevel = max;
      const baseLevel = min;
      const nominalStep = vpp;
      if (nominalStep > 0) {
        overshoot = Math.max(0, ((topLevel - (midLevel + 0.4 * vpp)) / nominalStep) * 100);
        undershoot = Math.max(0, (((midLevel - 0.4 * vpp) - baseLevel) / nominalStep) * 100);
      }
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
    period,
    frequency,
    dutyCycle,
    riseTime,
    fallTime,
    overshoot,
    undershoot,
    statusMessage,
  };
}
