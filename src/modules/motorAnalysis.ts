/**
 * Waveform Viewer Pro - Motor Control, Phase Difference & Power Analysis
 * - Electrical angle extraction atan2(beta, alpha) for Park dq0 when no encoder channel is present
 * - Speed (RPM) estimation from Hall / Back-EMF zero-crossings
 * - Precision two-channel phase difference (ΔΦ° & Δt)
 * - Active power & energy integration ∫P(t)dt
 */

import { WaveformChannel } from '../types/models';
import { computeChannelMean, getChannelDisplayValue } from './oscilloscopeScale';

/**
 * Extracts electrical rotor angle theta(t) in radians from Clarke alpha/beta signals.
 */
export function estimateElectricalAngleFromAlphaBeta(
  alpha: Float32Array,
  beta: Float32Array,
  offsetRad: number = 0
): Float32Array {
  const n = Math.min(alpha.length, beta.length);
  const theta = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = alpha[i];
    const b = beta[i];
    if (isFinite(a) && isFinite(b)) {
      theta[i] = Math.atan2(b, a) + offsetRad;
    } else {
      theta[i] = i > 0 ? theta[i - 1] : 0;
    }
  }
  return theta;
}

export interface SpeedEstimateResult {
  freqHz: number | null;
  rpm: number | null;
  zeroCrossings: number;
  avgPeriodSec: number | null;
}

/**
 * Estimates electrical frequency and mechanical RPM from a Hall or Back-EMF signal
 * using hysteresis-guarded rising threshold crossings with linear interpolation.
 */
export function estimateSpeedFromSignal(
  t: Float64Array,
  v: Float32Array,
  polePairs: number,
  tStart?: number,
  tEnd?: number
): SpeedEstimateResult {
  const n = Math.min(t.length, v.length);
  if (n < 4 || !isFinite(polePairs) || polePairs <= 0) {
    return { freqHz: null, rpm: null, zeroCrossings: 0, avgPeriodSec: null };
  }

  let i0 = 0;
  let i1 = n - 1;
  if (tStart !== undefined) {
    while (i0 < n && t[i0] < tStart) i0++;
  }
  if (tEnd !== undefined) {
    while (i1 > i0 && t[i1] > tEnd) i1--;
  }
  if (i1 - i0 < 4) {
    return { freqHz: null, rpm: null, zeroCrossings: 0, avgPeriodSec: null };
  }

  let min = Infinity;
  let max = -Infinity;
  for (let i = i0; i <= i1; i++) {
    const val = v[i];
    if (isFinite(val)) {
      if (val < min) min = val;
      if (val > max) max = val;
    }
  }
  const span = max - min;
  if (!isFinite(span) || span <= 1e-12) {
    return { freqHz: null, rpm: null, zeroCrossings: 0, avgPeriodSec: null };
  }

  const mid = (max + min) / 2;
  const hyst = span * 0.08;
  let armed = false;
  const crossings: number[] = [];

  for (let i = i0 + 1; i <= i1; i++) {
    const prev = v[i - 1];
    const curr = v[i];
    if (!isFinite(prev) || !isFinite(curr)) continue;
    if (prev <= mid - hyst) armed = true;
    if (armed && prev < mid && curr >= mid) {
      const denom = curr - prev;
      const frac = denom > 1e-15 ? (mid - prev) / denom : 0;
      const tc = t[i - 1] + frac * (t[i] - t[i - 1]);
      crossings.push(tc);
      armed = false;
    }
  }

  if (crossings.length < 2) {
    return {
      freqHz: null,
      rpm: null,
      zeroCrossings: crossings.length,
      avgPeriodSec: null,
    };
  }

  const totalSpan = crossings[crossings.length - 1] - crossings[0];
  const avgPeriodSec = totalSpan / (crossings.length - 1);
  if (!isFinite(avgPeriodSec) || avgPeriodSec <= 0) {
    return { freqHz: null, rpm: null, zeroCrossings: crossings.length, avgPeriodSec: null };
  }

  const freqHz = 1 / avgPeriodSec;
  const rpm = (60 * freqHz) / polePairs;
  return { freqHz, rpm, zeroCrossings: crossings.length, avgPeriodSec };
}

export interface PhaseDiffResult {
  phaseDeg: number | null; // [-180, 180]
  phaseDeg360: number | null; // [0, 360)
  deltaTimeSec: number | null;
  frequencyHz: number | null;
  matchedCycles: number;
  status: string;
}

function findRisingMidCrossings(
  ch: WaveformChannel,
  tStart: number,
  tEnd: number
): { crossings: number[]; span: number } {
  const n = Math.min(ch.t.length, ch.v.length);
  if (n < 4) return { crossings: [], span: 0 };

  let i0 = 0;
  while (i0 < n && ch.t[i0] < tStart) i0++;
  let i1 = n - 1;
  while (i1 > i0 && ch.t[i1] > tEnd) i1--;
  if (i1 - i0 < 4) return { crossings: [], span: 0 };

  const mean = ch.coupling === 'AC' ? computeChannelMean(ch) : 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = i0; i <= i1; i++) {
    const val = getChannelDisplayValue(ch, i, mean);
    if (isFinite(val)) {
      if (val < min) min = val;
      if (val > max) max = val;
    }
  }
  const span = max - min;
  if (!isFinite(span) || span <= 1e-12) return { crossings: [], span: 0 };

  const mid = (max + min) / 2;
  const hyst = span * 0.06;
  let armed = false;
  const crossings: number[] = [];

  for (let i = i0 + 1; i <= i1; i++) {
    const prev = getChannelDisplayValue(ch, i - 1, mean);
    const curr = getChannelDisplayValue(ch, i, mean);
    if (!isFinite(prev) || !isFinite(curr)) continue;
    if (prev <= mid - hyst) armed = true;
    if (armed && prev < mid && curr >= mid) {
      const denom = curr - prev;
      const frac = denom > 1e-15 ? (mid - prev) / denom : 0;
      crossings.push(ch.t[i - 1] + frac * (ch.t[i] - ch.t[i - 1]));
      armed = false;
    }
  }

  return { crossings, span };
}

/**
 * Computes fundamental phase difference (Target relative to Reference: positive means Target lags or leads cleanly wrapped).
 * Convention: Δt = t_target_crossing - t_ref_crossing wrapped into [-T/2, +T/2], ΔΦ = -360 * Δt / T (positive = target leads ref).
 */
export function computeTwoChannelPhaseDiff(
  chRef: WaveformChannel,
  chTarget: WaveformChannel,
  tStart?: number,
  tEnd?: number
): PhaseDiffResult {
  if (!chRef || !chTarget || chRef.t.length < 4 || chTarget.t.length < 4) {
    return {
      phaseDeg: null,
      phaseDeg360: null,
      deltaTimeSec: null,
      frequencyHz: null,
      matchedCycles: 0,
      status: 'Insufficient samples',
    };
  }

  const start =
    tStart !== undefined
      ? tStart
      : Math.max(chRef.t[0], chTarget.t[0]);
  const end =
    tEnd !== undefined
      ? tEnd
      : Math.min(chRef.t[chRef.t.length - 1], chTarget.t[chTarget.t.length - 1]);

  if (end <= start) {
    return {
      phaseDeg: null,
      phaseDeg360: null,
      deltaTimeSec: null,
      frequencyHz: null,
      matchedCycles: 0,
      status: 'No overlapping time window',
    };
  }

  const refRes = findRisingMidCrossings(chRef, start, end);
  const tgtRes = findRisingMidCrossings(chTarget, start, end);

  if (refRes.crossings.length < 2 || tgtRes.crossings.length < 1) {
    return {
      phaseDeg: null,
      phaseDeg360: null,
      deltaTimeSec: null,
      frequencyHz: null,
      matchedCycles: 0,
      status: 'Need >= 2 rising edges on Ref and >= 1 on Target',
    };
  }

  const period =
    (refRes.crossings[refRes.crossings.length - 1] - refRes.crossings[0]) /
    (refRes.crossings.length - 1);
  if (!isFinite(period) || period <= 0) {
    return {
      phaseDeg: null,
      phaseDeg360: null,
      deltaTimeSec: null,
      frequencyHz: null,
      matchedCycles: 0,
      status: 'Invalid fundamental period',
    };
  }

  // Compute circular mean of phase differences across all reference crossings
  let sumSin = 0;
  let sumCos = 0;
  let matched = 0;

  let j = 0;
  for (const tRef of refRes.crossings) {
    while (j + 1 < tgtRes.crossings.length && tgtRes.crossings[j + 1] < tRef) {
      j++;
    }
    let bestDt = Infinity;
    for (let k = Math.max(0, j - 1); k <= Math.min(tgtRes.crossings.length - 1, j + 1); k++) {
      const rawDt = tgtRes.crossings[k] - tRef;
      if (Math.abs(rawDt) < Math.abs(bestDt)) {
        bestDt = rawDt;
      }
    }
    if (isFinite(bestDt) && Math.abs(bestDt) <= period) {
      // Phase of target relative to ref: if target crosses BEFORE ref (bestDt < 0), target LEADS (+)
      const angleRad = (-2 * Math.PI * bestDt) / period;
      sumSin += Math.sin(angleRad);
      sumCos += Math.cos(angleRad);
      matched++;
    }
  }

  if (matched === 0) {
    return {
      phaseDeg: null,
      phaseDeg360: null,
      deltaTimeSec: null,
      frequencyHz: 1 / period,
      matchedCycles: 0,
      status: 'Could not pair edges',
    };
  }

  const meanRad = Math.atan2(sumSin / matched, sumCos / matched);
  const phaseDeg = (meanRad * 180) / Math.PI;
  const phaseDeg360 = ((phaseDeg % 360) + 360) % 360;
  const deltaTimeSec = (-phaseDeg / 360) * period;

  return {
    phaseDeg,
    phaseDeg360,
    deltaTimeSec,
    frequencyHz: 1 / period,
    matchedCycles: matched,
    status: 'OK',
  };
}

export interface PowerSummary {
  avgPowerW: number;
  avgDissipationW: number;
  peakPowerW: number;
  energyJ: number;
  durationSec: number;
}

/**
 * Computes signed active average power, non-negative dissipation mean ∫|P(t)|dt/T, peak power, and trapezoidal energy integral ∫ P(t) dt.
 */
export function computePowerSummary(
  t: Float64Array,
  p: Float32Array,
  tStart?: number,
  tEnd?: number
): PowerSummary {
  const n = Math.min(t.length, p.length);
  if (n < 2) return { avgPowerW: 0, avgDissipationW: 0, peakPowerW: 0, energyJ: 0, durationSec: 0 };

  let i0 = 0;
  let i1 = n - 1;
  if (tStart !== undefined) while (i0 < n && t[i0] < tStart) i0++;
  if (tEnd !== undefined) while (i1 > i0 && t[i1] > tEnd) i1--;
  if (i1 <= i0) return { avgPowerW: 0, avgDissipationW: 0, peakPowerW: 0, energyJ: 0, durationSec: 0 };

  let energy = 0;
  let dissipationEnergy = 0;
  let peak = 0;
  let dur = 0;

  for (let i = i0 + 1; i <= i1; i++) {
    const p0 = p[i - 1];
    const p1 = p[i];
    const dt = t[i] - t[i - 1];
    if (isFinite(p0) && isFinite(p1) && isFinite(dt) && dt > 0) {
      energy += 0.5 * (p0 + p1) * dt;
      if ((p0 >= 0 && p1 >= 0) || (p0 <= 0 && p1 <= 0)) {
        dissipationEnergy += 0.5 * (Math.abs(p0) + Math.abs(p1)) * dt;
      } else {
        const a0 = Math.abs(p0);
        const a1 = Math.abs(p1);
        const denom = a0 + a1;
        const frac = denom > 1e-18 ? a0 / denom : 0.5;
        dissipationEnergy += 0.5 * a0 * (dt * frac) + 0.5 * a1 * (dt * (1 - frac));
      }
      dur += dt;
      if (Math.abs(p0) > Math.abs(peak)) peak = p0;
      if (Math.abs(p1) > Math.abs(peak)) peak = p1;
    }
  }

  return {
    avgPowerW: dur > 0 ? energy / dur : 0,
    avgDissipationW: dur > 0 ? dissipationEnergy / dur : 0,
    peakPowerW: peak,
    energyJ: energy,
    durationSec: dur,
  };
}
