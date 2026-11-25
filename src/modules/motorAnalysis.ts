/**
 * Waveform Viewer Pro - Motor Control, Phase Difference & Power Analysis
 * - Electrical angle extraction atan2(beta, alpha) for Park dq0 when no encoder channel is present
 * - Speed (RPM) estimation from Hall / Back-EMF zero-crossings
 * - Precision two-channel phase difference (ΔΦ° & Δt)
 * - Active power & energy integration ∫P(t)dt
 */

import { WaveformChannel } from '../types/models';
import { computeChannelMean, getChannelDisplayValue } from './oscilloscopeScale';
import { DEFAULT_SAMPLING_GAP_FACTOR, inspectTimebase, validateChannelIntegrity } from './timeSync';

/**
 * Extracts electrical rotor angle theta(t) in radians from Clarke alpha/beta signals.
 * Rejects mismatched lengths and outputs NaN on invalid samples instead of holding stale angles.
 */
export function estimateElectricalAngleFromAlphaBeta(
  alpha: Float32Array,
  beta: Float32Array,
  offsetRad: number = 0
): Float32Array {
  if (alpha.length !== beta.length) {
    throw new Error(
      `Clarke α (${alpha.length}) 与 β (${beta.length}) 数组长度不一致，已拒绝静默截断。`
    );
  }
  const n = alpha.length;
  const theta = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = alpha[i];
    const b = beta[i];
    if (Number.isFinite(a) && Number.isFinite(b) && (a !== 0 || b !== 0)) {
      theta[i] = Math.atan2(b, a) + offsetRad;
    } else if (Number.isFinite(a) && Number.isFinite(b)) {
      theta[i] = 0 + offsetRad;
    } else {
      theta[i] = Number.NaN;
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
  if (t.length !== v.length || t.length < 4 || !Number.isFinite(polePairs) || polePairs <= 0) {
    return { freqHz: null, rpm: null, zeroCrossings: 0, avgPeriodSec: null };
  }
  const n = t.length;
  const tb = inspectTimebase(t, 0, n - 1, DEFAULT_SAMPLING_GAP_FACTOR);
  if (!tb.monotonic) {
    return { freqHz: null, rpm: null, zeroCrossings: 0, avgPeriodSec: null };
  }

  let i0 = 0;
  let i1 = n - 1;
  if (tStart !== undefined && Number.isFinite(tStart)) {
    while (i0 < n && t[i0] < tStart) i0++;
  }
  if (tEnd !== undefined && Number.isFinite(tEnd)) {
    while (i1 > i0 && t[i1] > tEnd) i1--;
  }
  if (i1 - i0 < 4) {
    return { freqHz: null, rpm: null, zeroCrossings: 0, avgPeriodSec: null };
  }

  let min = Infinity;
  let max = -Infinity;
  for (let i = i0; i <= i1; i++) {
    const val = v[i];
    if (Number.isFinite(val)) {
      if (val < min) min = val;
      if (val > max) max = val;
    }
  }
  const span = max - min;
  if (!Number.isFinite(span) || span <= 1e-12) {
    return { freqHz: null, rpm: null, zeroCrossings: 0, avgPeriodSec: null };
  }

  const mid = (max + min) / 2;
  const hyst = span * 0.08;
  let armed = false;
  const crossings: number[] = [];

  for (let i = i0 + 1; i <= i1; i++) {
    const prev = v[i - 1];
    const curr = v[i];
    const dt = t[i] - t[i - 1];
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || dt <= 0 || dt > tb.gapThresholdSec) {
      armed = false;
      continue;
    }
    if (prev <= mid - hyst) armed = true;
    if (armed && prev < mid && curr >= mid) {
      const denom = curr - prev;
      const frac = denom > 1e-15 ? (mid - prev) / denom : 0;
      const tc = t[i - 1] + frac * dt;
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
  if (!Number.isFinite(avgPeriodSec) || avgPeriodSec <= 0) {
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
  tEnd: number,
  gapThresholdSec: number
): { crossings: number[]; span: number } {
  const n = ch.t.length;
  if (n < 4 || ch.v.length !== n) return { crossings: [], span: 0 };

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
    if (Number.isFinite(val)) {
      if (val < min) min = val;
      if (val > max) max = val;
    }
  }
  const span = max - min;
  if (!Number.isFinite(span) || span <= 1e-12) return { crossings: [], span: 0 };

  const mid = (max + min) / 2;
  const hyst = span * 0.06;
  let armed = false;
  const crossings: number[] = [];

  for (let i = i0 + 1; i <= i1; i++) {
    const prev = getChannelDisplayValue(ch, i - 1, mean);
    const curr = getChannelDisplayValue(ch, i, mean);
    const dt = ch.t[i] - ch.t[i - 1];
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || dt <= 0 || dt > gapThresholdSec) {
      armed = false;
      continue;
    }
    if (prev <= mid - hyst) armed = true;
    if (armed && prev < mid && curr >= mid) {
      const denom = curr - prev;
      const frac = denom > 1e-15 ? (mid - prev) / denom : 0;
      crossings.push(ch.t[i - 1] + frac * dt);
      armed = false;
    }
  }

  return { crossings, span };
}

/**
 * Computes fundamental phase difference (Target relative to Reference: positive means Target leads Ref).
 * Convention: Δt = t_target_crossing - t_ref_crossing wrapped into [-T/2, +T/2], ΔΦ = -360 * Δt / T (positive = target leads ref).
 */
export function computeTwoChannelPhaseDiff(
  chRef: WaveformChannel,
  chTarget: WaveformChannel,
  tStart?: number,
  tEnd?: number
): PhaseDiffResult {
  const refCheck = validateChannelIntegrity(chRef, 4, DEFAULT_SAMPLING_GAP_FACTOR);
  if (!refCheck.valid) {
    return {
      phaseDeg: null,
      phaseDeg360: null,
      deltaTimeSec: null,
      frequencyHz: null,
      matchedCycles: 0,
      status: refCheck.invalidReason || 'Invalid reference channel',
    };
  }
  const tgtCheck = validateChannelIntegrity(chTarget, 4, DEFAULT_SAMPLING_GAP_FACTOR);
  if (!tgtCheck.valid) {
    return {
      phaseDeg: null,
      phaseDeg360: null,
      deltaTimeSec: null,
      frequencyHz: null,
      matchedCycles: 0,
      status: tgtCheck.invalidReason || 'Invalid target channel',
    };
  }

  const start =
    tStart !== undefined && Number.isFinite(tStart)
      ? Math.max(tStart, chRef.t[0], chTarget.t[0])
      : Math.max(chRef.t[0], chTarget.t[0]);
  const end =
    tEnd !== undefined && Number.isFinite(tEnd)
      ? Math.min(tEnd, chRef.t[chRef.t.length - 1], chTarget.t[chTarget.t.length - 1])
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

  const refRes = findRisingMidCrossings(chRef, start, end, refCheck.timebase.gapThresholdSec);
  const tgtRes = findRisingMidCrossings(chTarget, start, end, tgtCheck.timebase.gapThresholdSec);

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
  if (!Number.isFinite(period) || period <= 0) {
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
    if (Number.isFinite(bestDt) && Math.abs(bestDt) <= period) {
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
  valid: boolean;
  status: 'OK' | 'INVALID' | 'INSUFFICIENT_DATA';
  invalidReason: string | null;
  avgPowerW: number;
  /** Time-averaged magnitude ∫|P(t)|dt / T (non-directional power amplitude, NOT semiconductor heat dissipation). */
  avgAbsPowerW: number;
  /** @deprecated Alias for avgAbsPowerW kept for backward compatibility; does NOT represent device heat dissipation. */
  avgDissipationW: number;
  peakPowerW: number;
  peakPosPowerW: number;
  peakNegPowerW: number;
  peakAbsPowerW: number;
  energyJ: number;
  inputEnergyJ: number;
  regenEnergyJ: number;
  durationSec: number;
  validSegmentCount: number;
  skippedGapCount: number;
  coveragePct: number;
}

function makeInvalidPowerSummary(
  status: 'INVALID' | 'INSUFFICIENT_DATA',
  invalidReason: string,
  skippedGapCount = 0
): PowerSummary {
  return {
    valid: false,
    status,
    invalidReason,
    avgPowerW: Number.NaN,
    avgAbsPowerW: Number.NaN,
    avgDissipationW: Number.NaN,
    peakPowerW: Number.NaN,
    peakPosPowerW: Number.NaN,
    peakNegPowerW: Number.NaN,
    peakAbsPowerW: Number.NaN,
    energyJ: Number.NaN,
    inputEnergyJ: Number.NaN,
    regenEnergyJ: Number.NaN,
    durationSec: 0,
    validSegmentCount: 0,
    skippedGapCount,
    coveragePct: 0,
  };
}

/**
 * Computes signed active average power, time-averaged magnitude ∫|P(t)|dt/T, signed peak power,
 * and trapezoidal positive/regenerative/net energy integrals ∫ P(t) dt.
 * Enforces t/p length equality, strict monotonicity, and gap/NaN segmentation without fabricating 0 W / 0 J on invalid input.
 */
export function computePowerSummary(
  t: Float64Array,
  p: Float32Array,
  tStart?: number,
  tEnd?: number
): PowerSummary {
  if (!t || !p || t.length !== p.length) {
    return makeInvalidPowerSummary(
      'INVALID',
      `功率时间轴 (${t?.length ?? 0}) 与功率数组 (${p?.length ?? 0}) 长度不一致，已拒绝计算。`
    );
  }
  const n = t.length;
  if (n < 2) {
    return makeInvalidPowerSummary('INSUFFICIENT_DATA', '功率积分至少需要 2 个有效采样点。');
  }

  const tb = inspectTimebase(t, 0, n - 1, DEFAULT_SAMPLING_GAP_FACTOR);
  if (!tb.monotonic) {
    return makeInvalidPowerSummary(
      'INVALID',
      `功率时间轴在索引 ${tb.nonMonotonicIndex ?? '?'} 处存在非单调、重复或 NaN/Inf 时间戳。`
    );
  }

  const startBound = tStart !== undefined && Number.isFinite(tStart) ? tStart : t[0];
  const endBound = tEnd !== undefined && Number.isFinite(tEnd) ? tEnd : t[n - 1];
  if (endBound <= startBound || endBound < t[0] || startBound > t[n - 1]) {
    return makeInvalidPowerSummary('INSUFFICIENT_DATA', '所选功率积分窗口与原始波形无有效时间重叠。');
  }

  let i0 = 0;
  let i1 = n - 1;
  while (i0 < n && t[i0] < startBound) i0++;
  while (i1 > i0 && t[i1] > endBound) i1--;
  if (i1 <= i0) {
    return makeInvalidPowerSummary('INSUFFICIENT_DATA', '所选功率积分窗口内连续样本数不足 (< 2)。');
  }

  let inputEnergyJ = 0;
  let regenEnergyJ = 0;
  let peak = 0;
  let peakPos = -Infinity;
  let peakNeg = Infinity;
  let peakAbs = 0;
  let hasPeak = false;
  let dur = 0;
  let validSegmentCount = 0;
  let skippedGapCount = 0;

  for (let i = i0 + 1; i <= i1; i++) {
    const p0 = p[i - 1];
    const p1 = p[i];
    const dt = t[i] - t[i - 1];
    if (!(dt > 0) || !Number.isFinite(dt)) continue;
    if (Number.isFinite(tb.gapThresholdSec) && dt > tb.gapThresholdSec) {
      skippedGapCount++;
      continue;
    }
    if (Number.isFinite(p0) && Number.isFinite(p1)) {
      if (p0 >= 0 && p1 >= 0) {
        inputEnergyJ += 0.5 * (p0 + p1) * dt;
      } else if (p0 <= 0 && p1 <= 0) {
        regenEnergyJ += 0.5 * (-p0 - p1) * dt;
      } else {
        const a0 = Math.abs(p0);
        const a1 = Math.abs(p1);
        const denom = a0 + a1;
        const frac = denom > 1e-18 ? a0 / denom : 0.5;
        const dt0 = dt * frac;
        const dt1 = dt * (1 - frac);
        if (p0 > 0) {
          inputEnergyJ += 0.5 * a0 * dt0;
          regenEnergyJ += 0.5 * a1 * dt1;
        } else {
          regenEnergyJ += 0.5 * a0 * dt0;
          inputEnergyJ += 0.5 * a1 * dt1;
        }
      }
      dur += dt;
      validSegmentCount++;
      if (!hasPeak || Math.abs(p0) > Math.abs(peak)) {
        peak = p0;
        hasPeak = true;
      }
      if (Math.abs(p1) > Math.abs(peak)) {
        peak = p1;
      }
      if (p0 > peakPos) peakPos = p0;
      if (p1 > peakPos) peakPos = p1;
      if (p0 < peakNeg) peakNeg = p0;
      if (p1 < peakNeg) peakNeg = p1;
      if (Math.abs(p0) > peakAbs) peakAbs = Math.abs(p0);
      if (Math.abs(p1) > peakAbs) peakAbs = Math.abs(p1);
    }
  }

  if (validSegmentCount === 0 || dur <= 0) {
    return makeInvalidPowerSummary(
      'INSUFFICIENT_DATA',
      '指定积分窗内缺少有效的连续有限功率段（全为 NaN 或采样缺口）。',
      skippedGapCount
    );
  }

  const netEnergyJ = inputEnergyJ - regenEnergyJ;
  const absEnergyJ = inputEnergyJ + regenEnergyJ;
  const avgAbsPowerW = absEnergyJ / dur;
  const windowSpan = t[i1] - t[i0];
  const coveragePct = windowSpan > 0 ? Math.min(100, (dur / windowSpan) * 100) : 0;

  return {
    valid: true,
    status: 'OK',
    invalidReason: null,
    avgPowerW: netEnergyJ / dur,
    avgAbsPowerW,
    avgDissipationW: avgAbsPowerW,
    peakPowerW: peak,
    peakPosPowerW: Number.isFinite(peakPos) ? peakPos : 0,
    peakNegPowerW: Number.isFinite(peakNeg) ? peakNeg : 0,
    peakAbsPowerW: peakAbs,
    energyJ: netEnergyJ,
    inputEnergyJ,
    regenEnergyJ,
    durationSec: dur,
    validSegmentCount,
    skippedGapCount,
    coveragePct,
  };
}
