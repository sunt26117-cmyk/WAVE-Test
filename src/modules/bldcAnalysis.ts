/**
 * Waveform Viewer Pro - BLDC Motor & Power Electronics Diagnostics Suite
 * 1. Three-Phase Balance & Symmetry Audit (Vpp/RMS Unbalance %, 120 deg Phase Error, Zero-Seq V0)
 * 2. 6-Step Hall / Back-EMF Commutation Audit (60 deg Sector Error, CW/CCW, Illegal States, RPM Ripple)
 * 3. PWM Switching, Dead-Time, Shoot-Through & LC Ringing Frequency Analyzer
 * 4. Torque / Phase-Current Ripple & 6x Commutation Harmonic Fingerprint
 * 5. Derived BLDC Waveforms (Line-to-Line Uuv/Uvw/Uwu, Zero-Seq V0, Space Vector |Vs|)
 */

import { WaveformChannel } from '../types/models';
import { computeChannelMean, getChannelDisplayValue } from './oscilloscopeScale';
import { computeTwoChannelPhaseDiff } from './motorAnalysis';
import { computeFFT } from './fft';
import { computeClarke } from './transforms';

function sliceIndexRange(t: Float64Array, n: number, tStart?: number, tEnd?: number): { i0: number; i1: number } {
  let i0 = 0;
  let i1 = n - 1;
  if (tStart !== undefined) {
    while (i0 < n && t[i0] < tStart) i0++;
  }
  if (tEnd !== undefined) {
    while (i1 > i0 && t[i1] > tEnd) i1--;
  }
  return { i0, i1 };
}

export interface PhaseChannelSummary {
  name: string;
  rms: number;
  vpp: number;
  mean: number;
  min: number;
  max: number;
}

export interface ThreePhaseBalanceResult {
  phases: [PhaseChannelSummary, PhaseChannelSummary, PhaseChannelSummary];
  vppUnbalancePct: number;
  rmsUnbalancePct: number;
  zeroSeqRms: number;
  zeroSeqVpp: number;
  angleUVDeg: number | null;
  angleVWDeg: number | null;
  angleWUDeg: number | null;
  maxPhaseErrorDeg: number | null;
  zeroSeqTrace: Float32Array;
}

export function analyzeThreePhaseBalance(
  chU: WaveformChannel,
  chV: WaveformChannel,
  chW: WaveformChannel,
  tStart?: number,
  tEnd?: number
): ThreePhaseBalanceResult {
  const n = Math.min(chU.t.length, chU.v.length, chV.v.length, chW.v.length);
  const { i0, i1 } = sliceIndexRange(chU.t, n, tStart, tEnd);

  const summarize = (ch: WaveformChannel): PhaseChannelSummary => {
    const acMean = ch.coupling === 'AC' ? computeChannelMean(ch) : 0;
    let sum = 0;
    let sumSq = 0;
    let mn = Infinity;
    let mx = -Infinity;
    let cnt = 0;
    for (let i = i0; i <= i1; i++) {
      const val = getChannelDisplayValue(ch, i, acMean);
      if (!isFinite(val)) continue;
      sum += val;
      sumSq += val * val;
      if (val < mn) mn = val;
      if (val > mx) mx = val;
      cnt++;
    }
    if (cnt === 0) return { name: ch.name, rms: 0, vpp: 0, mean: 0, min: 0, max: 0 };
    return {
      name: ch.name,
      rms: Math.sqrt(sumSq / cnt),
      vpp: mx - mn,
      mean: sum / cnt,
      min: mn,
      max: mx,
    };
  };

  const pU = summarize(chU);
  const pV = summarize(chV);
  const pW = summarize(chW);

  const avgVpp = (pU.vpp + pV.vpp + pW.vpp) / 3;
  const maxVppDev = Math.max(Math.abs(pU.vpp - avgVpp), Math.abs(pV.vpp - avgVpp), Math.abs(pW.vpp - avgVpp));
  const vppUnbalancePct = avgVpp > 1e-12 ? (maxVppDev / avgVpp) * 100 : 0;

  const avgRms = (pU.rms + pV.rms + pW.rms) / 3;
  const maxRmsDev = Math.max(Math.abs(pU.rms - avgRms), Math.abs(pV.rms - avgRms), Math.abs(pW.rms - avgRms));
  const rmsUnbalancePct = avgRms > 1e-12 ? (maxRmsDev / avgRms) * 100 : 0;

  // Full zero-sequence trace (Ua + Ub + Uc)/3 + RMS/Vpp inside window
  const mU = chU.coupling === 'AC' ? computeChannelMean(chU) : 0;
  const mV = chV.coupling === 'AC' ? computeChannelMean(chV) : 0;
  const mW = chW.coupling === 'AC' ? computeChannelMean(chW) : 0;
  const zeroSeqTrace = new Float32Array(n);
  let zSq = 0;
  let zMin = Infinity;
  let zMax = -Infinity;
  let zCnt = 0;
  for (let i = 0; i < n; i++) {
    const z =
      (getChannelDisplayValue(chU, i, mU) +
        getChannelDisplayValue(chV, i, mV) +
        getChannelDisplayValue(chW, i, mW)) /
      3;
    zeroSeqTrace[i] = z;
    if (i >= i0 && i <= i1 && isFinite(z)) {
      zSq += z * z;
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
      zCnt++;
    }
  }

  const dUV = computeTwoChannelPhaseDiff(chU, chV, tStart, tEnd);
  const dVW = computeTwoChannelPhaseDiff(chV, chW, tStart, tEnd);
  const dWU = computeTwoChannelPhaseDiff(chW, chU, tStart, tEnd);

  const absAngErr = (deg: number | null): number | null => {
    if (deg === null || !isFinite(deg)) return null;
    return Math.abs(Math.abs(deg) - 120);
  };
  const errs = [absAngErr(dUV.phaseDeg), absAngErr(dVW.phaseDeg), absAngErr(dWU.phaseDeg)].filter(
    (e): e is number => e !== null
  );

  return {
    phases: [pU, pV, pW],
    vppUnbalancePct,
    rmsUnbalancePct,
    zeroSeqRms: zCnt > 0 ? Math.sqrt(zSq / zCnt) : 0,
    zeroSeqVpp: zCnt > 0 ? zMax - zMin : 0,
    angleUVDeg: dUV.phaseDeg,
    angleVWDeg: dVW.phaseDeg,
    angleWUDeg: dWU.phaseDeg,
    maxPhaseErrorDeg: errs.length > 0 ? Math.max(...errs) : null,
    zeroSeqTrace,
  };
}

export interface HallSectorStat {
  stateCode: number; // 1..6
  avgDeg: number;
  avgDurationSec: number;
  count: number;
  errorDeg: number; // deviation from 60.0 deg
}

export interface HallCommutationEvent {
  time: number;
  index: number;
  kind: 'illegal-state' | 'sequence-jump' | 'sector-error';
  detail: string;
}

export interface HallCommutationResult {
  direction: 'CW (Fwd)' | 'CCW (Rev)' | 'Mixed' | 'Unknown';
  sequence: number[];
  commutationCount: number;
  illegalStateCount: number;
  sequenceJumpCount: number;
  avgElecFreqHz: number | null;
  avgRpm: number | null;
  rpmMin: number | null;
  rpmMax: number | null;
  rpmRipplePct: number | null;
  maxSectorErrorDeg: number | null;
  sectorStats: HallSectorStat[];
  events: HallCommutationEvent[];
}

const HALL_CW_RING = [5, 1, 3, 2, 6, 4];

export function analyzeBldcHallCommutation(
  chA: WaveformChannel,
  chB: WaveformChannel,
  chC: WaveformChannel,
  polePairs: number,
  tStart?: number,
  tEnd?: number
): HallCommutationResult {
  const n = Math.min(chA.t.length, chA.v.length, chB.v.length, chC.v.length);
  const { i0, i1 } = sliceIndexRange(chA.t, n, tStart, tEnd);

  const empty: HallCommutationResult = {
    direction: 'Unknown',
    sequence: [],
    commutationCount: 0,
    illegalStateCount: 0,
    sequenceJumpCount: 0,
    avgElecFreqHz: null,
    avgRpm: null,
    rpmMin: null,
    rpmMax: null,
    rpmRipplePct: null,
    maxSectorErrorDeg: null,
    sectorStats: [],
    events: [],
  };
  if (i1 - i0 < 6) return empty;

  const statsForCh = (ch: WaveformChannel) => {
    const mean = ch.coupling === 'AC' ? computeChannelMean(ch) : 0;
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = i0; i <= i1; i++) {
      const val = getChannelDisplayValue(ch, i, mean);
      if (isFinite(val)) {
        if (val < mn) mn = val;
        if (val > mx) mx = val;
      }
    }
    const span = mx - mn;
    return { mean, mid: (mx + mn) / 2, hyst: span * 0.08, valid: isFinite(span) && span > 1e-9 };
  };

  const sA = statsForCh(chA);
  const sB = statsForCh(chB);
  const sC = statsForCh(chC);
  if (!sA.valid || !sB.valid || !sC.valid) return empty;

  const getBit = (val: number, prevBit: number, mid: number, hyst: number) => {
    if (val >= mid + hyst) return 1;
    if (val <= mid - hyst) return 0;
    return prevBit;
  };

  let bA = getChannelDisplayValue(chA, i0, sA.mean) >= sA.mid ? 1 : 0;
  let bB = getChannelDisplayValue(chB, i0, sB.mean) >= sB.mid ? 1 : 0;
  let bC = getChannelDisplayValue(chC, i0, sC.mean) >= sC.mid ? 1 : 0;
  let prevState = (bA << 2) | (bB << 1) | bC;
  let stateStartTime = chA.t[i0];
  let stateStartIdx = i0;

  interface SectorSegment {
    state: number;
    tStart: number;
    tEnd: number;
    dur: number;
    index: number;
  }

  const segments: SectorSegment[] = [];
  const events: HallCommutationEvent[] = [];
  let illegalStateCount = 0;
  let sequenceJumpCount = 0;
  let cwSteps = 0;
  let ccwSteps = 0;

  for (let i = i0 + 1; i <= i1; i++) {
    bA = getBit(getChannelDisplayValue(chA, i, sA.mean), bA, sA.mid, sA.hyst);
    bB = getBit(getChannelDisplayValue(chB, i, sB.mean), bB, sB.mid, sB.hyst);
    bC = getBit(getChannelDisplayValue(chC, i, sC.mean), bC, sC.mid, sC.hyst);
    const nextState = (bA << 2) | (bB << 1) | bC;

    if (nextState !== prevState) {
      const tTrans = 0.5 * (chA.t[i - 1] + chA.t[i]);
      const dur = tTrans - stateStartTime;
      if (prevState >= 1 && prevState <= 6) {
        segments.push({ state: prevState, tStart: stateStartTime, tEnd: tTrans, dur, index: stateStartIdx });
      }
      if (nextState === 0 || nextState === 7) {
        illegalStateCount++;
        if (events.length < 40) {
          events.push({
            time: tTrans,
            index: i,
            kind: 'illegal-state',
            detail: `Illegal Hall code ${nextState.toString(2).padStart(3, '0')} (${nextState})`,
          });
        }
      } else if (prevState >= 1 && prevState <= 6) {
        const idxPrev = HALL_CW_RING.indexOf(prevState);
        const idxNext = HALL_CW_RING.indexOf(nextState);
        const delta = (idxNext - idxPrev + 6) % 6;
        if (delta === 1) cwSteps++;
        else if (delta === 5) ccwSteps++;
        else if (delta !== 0) {
          sequenceJumpCount++;
          if (events.length < 40) {
            events.push({
              time: tTrans,
              index: i,
              kind: 'sequence-jump',
              detail: `Skipped step: ${prevState} -> ${nextState}`,
            });
          }
        }
      }
      prevState = nextState;
      stateStartTime = tTrans;
      stateStartIdx = i;
    }
  }

  // Drop incomplete leading/trailing boundary segments so sector durations are true full 60-deg steps
  const completeSegs = segments.length > 2 ? segments.slice(1) : segments;
  if (completeSegs.length === 0) {
    return {
      ...empty,
      illegalStateCount,
      sequenceJumpCount,
      events,
    };
  }

  const totalDur = completeSegs.reduce((acc, s) => acc + s.dur, 0);
  const avgSectorDur = totalDur / completeSegs.length;
  const avgElecPeriod = avgSectorDur * 6;
  const avgElecFreqHz = avgElecPeriod > 1e-15 ? 1 / avgElecPeriod : null;
  const safePoles = isFinite(polePairs) && polePairs > 0 ? polePairs : 4;
  const avgRpm = avgElecFreqHz !== null ? (60 * avgElecFreqHz) / safePoles : null;

  // Instantaneous cycle RPM across sliding 6-sector windows
  const rpmSamples: number[] = [];
  if (completeSegs.length >= 6) {
    for (let k = 0; k <= completeSegs.length - 6; k++) {
      let cycDur = 0;
      for (let m = 0; m < 6; m++) cycDur += completeSegs[k + m].dur;
      if (cycDur > 1e-15) {
        rpmSamples.push((60 / cycDur) / safePoles);
      }
    }
  } else {
    completeSegs.forEach((s) => {
      if (s.dur > 1e-15) rpmSamples.push((60 / (s.dur * 6)) / safePoles);
    });
  }

  const rpmMin = rpmSamples.length > 0 ? Math.min(...rpmSamples) : avgRpm;
  const rpmMax = rpmSamples.length > 0 ? Math.max(...rpmSamples) : avgRpm;
  const rpmRipplePct =
    avgRpm && rpmMin !== null && rpmMax !== null && avgRpm > 1e-9
      ? ((rpmMax - rpmMin) / avgRpm) * 100
      : null;

  // Group stats per Hall state 1..6
  const stateMap = new Map<number, { sumDur: number; cnt: number }>();
  let worstErr = 0;
  let worstSeg: SectorSegment | null = null;
  completeSegs.forEach((seg) => {
    const prev = stateMap.get(seg.state) || { sumDur: 0, cnt: 0 };
    prev.sumDur += seg.dur;
    prev.cnt += 1;
    stateMap.set(seg.state, prev);

    const deg = avgSectorDur > 1e-15 ? (seg.dur / avgSectorDur) * 60 : 60;
    const err = Math.abs(deg - 60);
    if (err > worstErr) {
      worstErr = err;
      worstSeg = seg;
    }
  });

  if (worstSeg && worstErr > 2.5 && events.length < 40) {
    events.push({
      time: (worstSeg as SectorSegment).tStart,
      index: (worstSeg as SectorSegment).index,
      kind: 'sector-error',
      detail: `Sector ${(worstSeg as SectorSegment).state} width error ${worstErr.toFixed(1)}°`,
    });
  }

  const sectorStats: HallSectorStat[] = HALL_CW_RING.filter((c) => stateMap.has(c)).map((code) => {
    const entry = stateMap.get(code)!;
    const avgD = entry.sumDur / entry.cnt;
    const avgDeg = avgSectorDur > 1e-15 ? (avgD / avgSectorDur) * 60 : 60;
    return {
      stateCode: code,
      avgDeg,
      avgDurationSec: avgD,
      count: entry.cnt,
      errorDeg: avgDeg - 60,
    };
  });

  const maxSectorErrorDeg =
    sectorStats.length > 0 ? Math.max(...sectorStats.map((s) => Math.abs(s.errorDeg))) : null;

  let direction: HallCommutationResult['direction'] = 'Unknown';
  if (cwSteps > 0 && ccwSteps === 0) direction = 'CW (Fwd)';
  else if (ccwSteps > 0 && cwSteps === 0) direction = 'CCW (Rev)';
  else if (cwSteps > 0 && ccwSteps > 0) direction = cwSteps >= ccwSteps ? 'CW (Fwd)' : 'CCW (Rev)';

  // Extract first cycle of unique sequence codes
  const seq: number[] = [];
  for (const s of completeSegs) {
    if (seq.length >= 6) break;
    if (seq.length === 0 || seq[seq.length - 1] !== s.state) seq.push(s.state);
  }

  return {
    direction,
    sequence: seq,
    commutationCount: completeSegs.length,
    illegalStateCount,
    sequenceJumpCount,
    avgElecFreqHz,
    avgRpm,
    rpmMin,
    rpmMax,
    rpmRipplePct,
    maxSectorErrorDeg,
    sectorStats,
    events,
  };
}

export interface PwmDeadTimeResult {
  pwmFreqHz: number | null;
  pulseCount: number;
  dutyMinPct: number | null;
  dutyAvgPct: number | null;
  dutyMaxPct: number | null;
  maxDvDtVPerUs: number | null;
  overshootPct: number | null;
  ringingFreqHz: number | null;
  deadTimeMinSec: number | null;
  deadTimeAvgSec: number | null;
  deadTimeMaxSec: number | null;
  deadTimeCount: number;
  shootThroughCount: number;
  worstEventIndex: number | null;
  worstEventTime: number | null;
}

export function analyzePwmSwitchingAndDeadTime(
  chHigh: WaveformChannel,
  chLow?: WaveformChannel | null,
  tStart?: number,
  tEnd?: number
): PwmDeadTimeResult {
  const n = chLow ? Math.min(chHigh.t.length, chHigh.v.length, chLow.v.length) : Math.min(chHigh.t.length, chHigh.v.length);
  const { i0, i1 } = sliceIndexRange(chHigh.t, n, tStart, tEnd);

  const empty: PwmDeadTimeResult = {
    pwmFreqHz: null,
    pulseCount: 0,
    dutyMinPct: null,
    dutyAvgPct: null,
    dutyMaxPct: null,
    maxDvDtVPerUs: null,
    overshootPct: null,
    ringingFreqHz: null,
    deadTimeMinSec: null,
    deadTimeAvgSec: null,
    deadTimeMaxSec: null,
    deadTimeCount: 0,
    shootThroughCount: 0,
    worstEventIndex: null,
    worstEventTime: null,
  };
  if (i1 - i0 < 6) return empty;

  const meanH = chHigh.coupling === 'AC' ? computeChannelMean(chHigh) : 0;
  let mn = Infinity;
  let mx = -Infinity;
  let maxDvDt = 0;

  for (let i = i0; i <= i1; i++) {
    const v = getChannelDisplayValue(chHigh, i, meanH);
    if (!isFinite(v)) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    if (i > i0) {
      const vp = getChannelDisplayValue(chHigh, i - 1, meanH);
      const dt = chHigh.t[i] - chHigh.t[i - 1];
      if (isFinite(vp) && dt > 1e-15) {
        const dvdt = Math.abs(v - vp) / (dt * 1e6); // V/us
        if (dvdt > maxDvDt) maxDvDt = dvdt;
      }
    }
  }
  const span = mx - mn;
  if (!isFinite(span) || span <= 1e-9) return empty;

  // Estimate steady high plateau using 75th-90th percentile high samples or upper quartile
  const mid = (mx + mn) / 2;
  const hyst = span * 0.08;
  let highSum = 0;
  let highCnt = 0;
  let lowSum = 0;
  let lowCnt = 0;
  for (let i = i0; i <= i1; i++) {
    const v = getChannelDisplayValue(chHigh, i, meanH);
    if (!isFinite(v)) continue;
    if (v >= mn + span * 0.72 && v <= mn + span * 0.92) {
      highSum += v;
      highCnt++;
    } else if (v <= mn + span * 0.25 && v >= mn + span * 0.02) {
      lowSum += v;
      lowCnt++;
    }
  }
  const vTop = highCnt >= 4 ? highSum / highCnt : mx;
  const vBase = lowCnt >= 4 ? lowSum / lowCnt : mn;
  const amp = vTop - vBase;
  const overshootPct = amp > 1e-9 && mx > vTop ? ((mx - vTop) / amp) * 100 : 0;

  const risingTimes: number[] = [];
  const risingIndices: number[] = [];
  const fallingTimes: number[] = [];
  let armed = false;
  let isHighState = getChannelDisplayValue(chHigh, i0, meanH) >= mid;

  for (let i = i0 + 1; i <= i1; i++) {
    const vp = getChannelDisplayValue(chHigh, i - 1, meanH);
    const vc = getChannelDisplayValue(chHigh, i, meanH);
    if (!isFinite(vp) || !isFinite(vc)) continue;
    if (!isHighState && vp <= mid - hyst) armed = true;
    if (!isHighState && armed && vp < mid && vc >= mid) {
      const f = vc - vp > 1e-15 ? (mid - vp) / (vc - vp) : 0;
      risingTimes.push(chHigh.t[i - 1] + f * (chHigh.t[i] - chHigh.t[i - 1]));
      risingIndices.push(i);
      isHighState = true;
      armed = false;
    } else if (isHighState && vc <= mid - hyst) {
      const f = vp - vc > 1e-15 ? (vp - mid) / (vp - vc) : 0;
      fallingTimes.push(chHigh.t[i - 1] + f * (chHigh.t[i] - chHigh.t[i - 1]));
      isHighState = false;
    }
  }

  let pwmFreqHz: number | null = null;
  const duties: number[] = [];
  if (risingTimes.length >= 2) {
    const periods: number[] = [];
    for (let k = 0; k < risingTimes.length - 1; k++) {
      const per = risingTimes[k + 1] - risingTimes[k];
      if (per > 0) periods.push(per);
      const fallAfter = fallingTimes.find((ft) => ft > risingTimes[k] && ft < risingTimes[k + 1]);
      if (fallAfter !== undefined && per > 0) {
        duties.push(((fallAfter - risingTimes[k]) / per) * 100);
      }
    }
    if (periods.length > 0) {
      const avgPer = periods.reduce((a, b) => a + b, 0) / periods.length;
      if (avgPer > 1e-15) pwmFreqHz = 1 / avgPer;
    }
  }

  // Ringing frequency estimation immediately after first valid rising edge
  let ringingFreqHz: number | null = null;
  if (risingIndices.length > 0) {
    const rIdx = risingIndices[0];
    const searchEnd = Math.min(i1, rIdx + 80);
    const localExtremaT: number[] = [];
    for (let i = rIdx + 1; i < searchEnd; i++) {
      const vPrev = getChannelDisplayValue(chHigh, i - 1, meanH);
      const vCurr = getChannelDisplayValue(chHigh, i, meanH);
      const vNext = getChannelDisplayValue(chHigh, i + 1, meanH);
      if (vCurr >= mid && ((vCurr > vPrev && vCurr >= vNext) || (vCurr < vPrev && vCurr <= vNext))) {
        if (Math.abs(vCurr - vTop) > amp * 0.015) {
          localExtremaT.push(chHigh.t[i]);
          if (localExtremaT.length >= 3) break;
        }
      }
    }
    if (localExtremaT.length >= 3) {
      const fullCycleDt = localExtremaT[2] - localExtremaT[0];
      if (fullCycleDt > 1e-15) ringingFreqHz = 1 / fullCycleDt;
    }
  }

  // Complementary Dead-Time & Shoot-Through inspection if chLow is provided
  let deadTimeMinSec: number | null = null;
  let deadTimeAvgSec: number | null = null;
  let deadTimeMaxSec: number | null = null;
  let deadTimeCount = 0;
  let shootThroughCount = 0;
  let worstEventIndex: number | null = null;
  let worstEventTime: number | null = null;

  if (chLow) {
    const meanL = chLow.coupling === 'AC' ? computeChannelMean(chLow) : 0;
    let mnL = Infinity;
    let mxL = -Infinity;
    for (let i = i0; i <= i1; i++) {
      const v = getChannelDisplayValue(chLow, i, meanL);
      if (isFinite(v)) {
        if (v < mnL) mnL = v;
        if (v > mxL) mxL = v;
      }
    }
    const midL = (mxL + mnL) / 2;

    const getState = (vh: number, vl: number): 'H' | 'L' | 'DEAD' | 'BOTH' => {
      const hOn = vh >= mid;
      const lOn = vl >= midL;
      if (hOn && lOn) return 'BOTH';
      if (hOn) return 'H';
      if (lOn) return 'L';
      return 'DEAD';
    };

    const deadGaps: number[] = [];
    let prevState = getState(
      getChannelDisplayValue(chHigh, i0, meanH),
      getChannelDisplayValue(chLow, i0, meanL)
    );
    let segStartT = chHigh.t[i0];
    let segStartIdx = i0;
    let prevActiveSide: 'H' | 'L' | null = prevState === 'H' || prevState === 'L' ? prevState : null;

    for (let i = i0 + 1; i <= i1; i++) {
      const vh = getChannelDisplayValue(chHigh, i, meanH);
      const vl = getChannelDisplayValue(chLow, i, meanL);
      const st = getState(vh, vl);
      if (st !== prevState) {
        const tEdge = 0.5 * (chHigh.t[i - 1] + chHigh.t[i]);
        if (prevState === 'BOTH') {
          shootThroughCount++;
          worstEventIndex = segStartIdx;
          worstEventTime = segStartT;
        } else if (prevState === 'DEAD' && prevActiveSide && (st === 'H' || st === 'L') && st !== prevActiveSide) {
          const dtGap = tEdge - segStartT;
          if (dtGap >= 0 && (!pwmFreqHz || dtGap < 0.25 / pwmFreqHz)) {
            deadGaps.push(dtGap);
            if (deadTimeMinSec === null || dtGap < deadTimeMinSec) {
              deadTimeMinSec = dtGap;
              if (shootThroughCount === 0) {
                worstEventIndex = segStartIdx;
                worstEventTime = segStartT;
              }
            }
          }
        }
        if (st === 'H' || st === 'L') prevActiveSide = st;
        prevState = st;
        segStartT = tEdge;
        segStartIdx = i;
      }
    }

    if (deadGaps.length > 0) {
      deadTimeCount = deadGaps.length;
      deadTimeMinSec = Math.min(...deadGaps);
      deadTimeMaxSec = Math.max(...deadGaps);
      deadTimeAvgSec = deadGaps.reduce((a, b) => a + b, 0) / deadGaps.length;
    }
  }

  return {
    pwmFreqHz,
    pulseCount: risingTimes.length,
    dutyMinPct: duties.length > 0 ? Math.min(...duties) : null,
    dutyAvgPct: duties.length > 0 ? duties.reduce((a, b) => a + b, 0) / duties.length : null,
    dutyMaxPct: duties.length > 0 ? Math.max(...duties) : null,
    maxDvDtVPerUs: maxDvDt > 0 ? maxDvDt : null,
    overshootPct,
    ringingFreqHz,
    deadTimeMinSec,
    deadTimeAvgSec,
    deadTimeMaxSec,
    deadTimeCount,
    shootThroughCount,
    worstEventIndex,
    worstEventTime,
  };
}

export interface TorqueRippleResult {
  mean: number;
  rms: number;
  peakToPeakRipple: number;
  rippleFactorPct: number;
  rmsRipplePct: number;
  fundamentalElecHz: number | null;
  harm1xAmp: number | null;
  harm2xAmp: number | null;
  harm6xAmp: number | null;
  harm12xAmp: number | null;
  sixthHarmonicPctOfMean: number | null;
  dominantRippleFreqHz: number | null;
  dominantRippleAmp: number | null;
}

export function analyzeTorqueAndCurrentRipple(
  ch: WaveformChannel,
  elecFreqOverrideHz?: number | null,
  tStart?: number,
  tEnd?: number
): TorqueRippleResult {
  const n = Math.min(ch.t.length, ch.v.length);
  const { i0, i1 } = sliceIndexRange(ch.t, n, tStart, tEnd);
  if (i1 - i0 < 8) {
    return {
      mean: 0,
      rms: 0,
      peakToPeakRipple: 0,
      rippleFactorPct: 0,
      rmsRipplePct: 0,
      fundamentalElecHz: null,
      harm1xAmp: null,
      harm2xAmp: null,
      harm6xAmp: null,
      harm12xAmp: null,
      sixthHarmonicPctOfMean: null,
      dominantRippleFreqHz: null,
      dominantRippleAmp: null,
    };
  }

  const acMeanOffset = ch.coupling === 'AC' ? computeChannelMean(ch) : 0;
  let sum = 0;
  let sumSq = 0;
  let mn = Infinity;
  let mx = -Infinity;
  let cnt = 0;
  for (let i = i0; i <= i1; i++) {
    const val = getChannelDisplayValue(ch, i, acMeanOffset);
    if (!isFinite(val)) continue;
    sum += val;
    sumSq += val * val;
    if (val < mn) mn = val;
    if (val > mx) mx = val;
    cnt++;
  }
  const mean = cnt > 0 ? sum / cnt : 0;
  const rms = cnt > 0 ? Math.sqrt(sumSq / cnt) : 0;
  const peakToPeakRipple = cnt > 0 ? mx - mn : 0;

  let acSq = 0;
  for (let i = i0; i <= i1; i++) {
    const val = getChannelDisplayValue(ch, i, acMeanOffset);
    if (!isFinite(val)) continue;
    const d = val - mean;
    acSq += d * d;
  }
  const acRms = cnt > 0 ? Math.sqrt(acSq / cnt) : 0;
  const denomMean = Math.abs(mean) > 1e-9 ? Math.abs(mean) : rms > 1e-9 ? rms : 1e-9;
  const rippleFactorPct = (peakToPeakRipple / (2 * denomMean)) * 100;
  const rmsRipplePct = (acRms / denomMean) * 100;

  const segT = ch.t.subarray(i0, i1 + 1);
  const segV = new Float32Array(i1 - i0 + 1);
  for (let i = i0; i <= i1; i++) {
    segV[i - i0] = getChannelDisplayValue(ch, i, acMeanOffset);
  }
  const dt = segT.length >= 2 ? (segT[segT.length - 1] - segT[0]) / (segT.length - 1) : ch.dt || 1e-4;
  const fs = dt > 0 ? 1 / dt : ch.fs || 1e4;

  const fft = computeFFT(
    segT,
    segV,
    fs,
    {
      range: 'entire',
      window: 'hann',
      scale: 'magnitude',
      zeroPadding: 2,
      removeDC: true,
    },
    ch.id,
    ch.name
  );

  const lookupPeakNear = (targetFreq: number): number | null => {
    if (!isFinite(targetFreq) || targetFreq <= 0 || fft.frequencies.length < 3) return null;
    const tol = Math.max(targetFreq * 0.06, fft.resolution * 2.5);
    let best = 0;
    for (let k = 1; k < fft.frequencies.length; k++) {
      if (Math.abs(fft.frequencies[k] - targetFreq) <= tol) {
        if (fft.magnitudes[k] > best) best = fft.magnitudes[k];
      }
    }
    return best;
  };

  let dominantFreq: number | null = null;
  let dominantAmp: number | null = null;
  if (fft.peaks.length > 0) {
    const dom = fft.peaks.reduce((best, p) => (p.magnitude > best.magnitude ? p : best), fft.peaks[0]);
    dominantFreq = dom.frequency;
    dominantAmp = dom.magnitude;
  }

  const fe =
    elecFreqOverrideHz && isFinite(elecFreqOverrideHz) && elecFreqOverrideHz > 0
      ? elecFreqOverrideHz
      : dominantFreq;

  const h1 = fe ? lookupPeakNear(fe) : null;
  const h2 = fe ? lookupPeakNear(fe * 2) : null;
  const h6 = fe ? lookupPeakNear(fe * 6) : null;
  const h12 = fe ? lookupPeakNear(fe * 12) : null;
  const sixthHarmonicPctOfMean =
    h6 !== null && denomMean > 1e-9 ? (h6 / denomMean) * 100 : null;

  return {
    mean,
    rms,
    peakToPeakRipple,
    rippleFactorPct,
    rmsRipplePct,
    fundamentalElecHz: fe || null,
    harm1xAmp: h1,
    harm2xAmp: h2,
    harm6xAmp: h6,
    harm12xAmp: h12,
    sixthHarmonicPctOfMean,
    dominantRippleFreqHz: dominantFreq,
    dominantRippleAmp: dominantAmp,
  };
}

export function computeBldcDerivedTraces(
  chU: WaveformChannel,
  chV: WaveformChannel,
  chW: WaveformChannel
): {
  uuv: Float32Array;
  uvw: Float32Array;
  uwu: Float32Array;
  v0: Float32Array;
  svmMag: Float32Array;
} {
  const n = Math.min(chU.v.length, chV.v.length, chW.v.length);
  const mU = chU.coupling === 'AC' ? computeChannelMean(chU) : 0;
  const mV = chV.coupling === 'AC' ? computeChannelMean(chV) : 0;
  const mW = chW.coupling === 'AC' ? computeChannelMean(chW) : 0;

  const uArr = new Float32Array(n);
  const vArr = new Float32Array(n);
  const wArr = new Float32Array(n);
  const uuv = new Float32Array(n);
  const uvw = new Float32Array(n);
  const uwu = new Float32Array(n);
  const v0 = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const a = getChannelDisplayValue(chU, i, mU);
    const b = getChannelDisplayValue(chV, i, mV);
    const c = getChannelDisplayValue(chW, i, mW);
    uArr[i] = a;
    vArr[i] = b;
    wArr[i] = c;
    uuv[i] = a - b;
    uvw[i] = b - c;
    uwu[i] = c - a;
    v0[i] = (a + b + c) / 3;
  }

  const { alpha, beta } = computeClarke(uArr, vArr, wArr);
  const svmMag = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    svmMag[i] = Math.hypot(alpha[i], beta[i]);
  }

  return { uuv, uvw, uwu, v0, svmMag };
}
