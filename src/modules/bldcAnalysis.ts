/**
 * Waveform Viewer Pro - BLDC Motor & Power Electronics Diagnostics Suite
 * 1. Three-Phase Balance & Symmetry Audit (Time-Synchronized Vpp/RMS Unbalance %, 120 deg Phase Error, Zero-Seq V0)
 * 2. 6-Step Hall / Back-EMF Commutation Audit (Time-Synchronized, Configurable Hall Sequence, 60 deg Sector Error, CW/CCW, RPM Ripple)
 * 3. PWM Switching, Dead-Time, Shoot-Through & LC Ringing Frequency Analyzer (Gate vs SW-node role separation)
 * 4. Torque / Phase-Current Ripple & 6x Commutation Harmonic Fingerprint (Physical quantity distinction)
 * 5. Derived BLDC Waveforms (Time-Synchronized Line-to-Line Uuv/Uvw/Uwu, Zero-Seq V0, Space Vector |Vs|)
 */

import { WaveformChannel } from '../types/models';
import { computeChannelMean, getChannelDisplayValue } from './oscilloscopeScale';
import { computeTwoChannelPhaseDiff } from './motorAnalysis';
import { computeFFT } from './fft';
import { computeClarke } from './transforms';
import { alignChannelsToCommonTimebase, DEFAULT_SAMPLING_GAP_FACTOR, inspectTimebase, resolveCompatibleSiGroupScale } from './timeSync';
import { parseSiUnitScale } from './thermalEngine';

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

function computeSegmentedTrapezoidalStats(
  t: Float64Array,
  v: Float32Array,
  i0 = 0,
  i1 = t.length - 1,
  gapThresholdSec = Infinity
): { mean: number; rms: number; acRms: number; vpp: number; min: number; max: number; validCount: number } {
  let area = 0;
  let sqArea = 0;
  let dur = 0;
  let mn = Infinity;
  let mx = -Infinity;
  let validCount = 0;

  for (let i = i0; i <= i1; i++) {
    const val = v[i];
    if (!Number.isFinite(val)) continue;
    if (val < mn) mn = val;
    if (val > mx) mx = val;
    validCount++;
  }

  for (let i = i0 + 1; i <= i1; i++) {
    const a = v[i - 1];
    const b = v[i];
    const dt = t[i] - t[i - 1];
    if (!Number.isFinite(a) || !Number.isFinite(b) || !(dt > 0)) continue;
    if (Number.isFinite(gapThresholdSec) && dt > gapThresholdSec) continue;
    area += 0.5 * (a + b) * dt;
    sqArea += ((a * a + a * b + b * b) / 3) * dt;
    dur += dt;
  }

  if (validCount === 0 || dur <= 0) {
    return { mean: 0, rms: 0, acRms: 0, vpp: 0, min: 0, max: 0, validCount: 0 };
  }

  const mean = area / dur;
  const rms = Math.sqrt(Math.max(0, sqArea / dur));

  let acSqArea = 0;
  for (let i = i0 + 1; i <= i1; i++) {
    const a = v[i - 1];
    const b = v[i];
    const dt = t[i] - t[i - 1];
    if (!Number.isFinite(a) || !Number.isFinite(b) || !(dt > 0)) continue;
    if (Number.isFinite(gapThresholdSec) && dt > gapThresholdSec) continue;
    const da = a - mean;
    const db = b - mean;
    acSqArea += ((da * da + da * db + db * db) / 3) * dt;
  }
  const acRms = Math.sqrt(Math.max(0, acSqArea / dur));

  return { mean, rms, acRms, vpp: mx - mn, min: mn, max: mx, validCount };
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
  valid: boolean;
  unit: string;
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
  time: Float64Array;
  resampled: boolean;
  warnings: string[];
}

export function analyzeThreePhaseBalance(
  chU: WaveformChannel,
  chV: WaveformChannel,
  chW: WaveformChannel,
  tStart?: number,
  tEnd?: number
): ThreePhaseBalanceResult {
  const emptyPh = (name: string): PhaseChannelSummary => ({ name, rms: 0, vpp: 0, mean: 0, min: 0, max: 0 });
  const unitInfo = resolveCompatibleSiGroupScale([chU, chV, chW]);
  if (!unitInfo.valid) {
    return {
      valid: false,
      unit: chU.unit || 'V',
      phases: [emptyPh(chU.name), emptyPh(chV.name), emptyPh(chW.name)],
      vppUnbalancePct: 0,
      rmsUnbalancePct: 0,
      zeroSeqRms: 0,
      zeroSeqVpp: 0,
      angleUVDeg: null,
      angleVWDeg: null,
      angleWUDeg: null,
      maxPhaseErrorDeg: null,
      zeroSeqTrace: new Float32Array(0),
      time: new Float64Array(0),
      resampled: false,
      warnings: [unitInfo.reason || '三相通道单位不兼容。'],
    };
  }

  const synced = alignChannelsToCommonTimebase([chU, chV, chW], tStart, tEnd);
  const warnings = [...synced.warnings];
  if (unitInfo.normalizedNote) warnings.push(unitInfo.normalizedNote);
  const n = synced.time.length;

  if (!synced.valid || n < 2) {
    return {
      valid: false,
      unit: unitInfo.baseUnit,
      phases: [emptyPh(chU.name), emptyPh(chV.name), emptyPh(chW.name)],
      vppUnbalancePct: 0,
      rmsUnbalancePct: 0,
      zeroSeqRms: 0,
      zeroSeqVpp: 0,
      angleUVDeg: null,
      angleVWDeg: null,
      angleWUDeg: null,
      maxPhaseErrorDeg: null,
      zeroSeqTrace: new Float32Array(0),
      time: new Float64Array(0),
      resampled: synced.resampled,
      warnings: warnings.length > 0 ? warnings : ['三相通道无有效重叠采样区间或时间轴非单调递增 (INVALID)。'],
    };
  }

  const [rawU, rawV, rawW] = synced.values;
  const [sU, sV, sW] = unitInfo.scales;
  const scaleArr = (arr: Float32Array, scale: number) => {
    if (Math.abs(scale - 1) <= 1e-12) return arr;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = arr[i] * scale;
    return out;
  };
  const uArr = scaleArr(rawU, sU);
  const vArr = scaleArr(rawV, sV);
  const wArr = scaleArr(rawW, sW);

  const syncTb = inspectTimebase(synced.time, 0, n - 1, DEFAULT_SAMPLING_GAP_FACTOR);
  const summarize = (name: string, arr: Float32Array): PhaseChannelSummary => {
    const st = computeSegmentedTrapezoidalStats(synced.time, arr, 0, n - 1, syncTb.gapThresholdSec);
    return {
      name,
      rms: st.rms,
      vpp: st.vpp,
      mean: st.mean,
      min: st.min,
      max: st.max,
    };
  };

  const pU = summarize(chU.name, uArr);
  const pV = summarize(chV.name, vArr);
  const pW = summarize(chW.name, wArr);

  const avgVpp = (pU.vpp + pV.vpp + pW.vpp) / 3;
  const maxVppDev = Math.max(Math.abs(pU.vpp - avgVpp), Math.abs(pV.vpp - avgVpp), Math.abs(pW.vpp - avgVpp));
  const vppUnbalancePct = avgVpp > 1e-12 ? (maxVppDev / avgVpp) * 100 : 0;

  const avgRms = (pU.rms + pV.rms + pW.rms) / 3;
  const maxRmsDev = Math.max(Math.abs(pU.rms - avgRms), Math.abs(pV.rms - avgRms), Math.abs(pW.rms - avgRms));
  const rmsUnbalancePct = avgRms > 1e-12 ? (maxRmsDev / avgRms) * 100 : 0;

  // Full zero-sequence trace (Ua + Ub + Uc)/3 on synchronized timebase
  const zeroSeqTrace = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    zeroSeqTrace[i] = (uArr[i] + vArr[i] + wArr[i]) / 3;
  }
  const zeroStats = computeSegmentedTrapezoidalStats(synced.time, zeroSeqTrace, 0, n - 1, syncTb.gapThresholdSec);

  const dUV = computeTwoChannelPhaseDiff(chU, chV, synced.overlapStart, synced.overlapEnd);
  const dVW = computeTwoChannelPhaseDiff(chV, chW, synced.overlapStart, synced.overlapEnd);
  const dWU = computeTwoChannelPhaseDiff(chW, chU, synced.overlapStart, synced.overlapEnd);

  const absAngErr = (deg: number | null): number | null => {
    if (deg === null || !isFinite(deg)) return null;
    return Math.abs(Math.abs(deg) - 120);
  };
  const errs = [absAngErr(dUV.phaseDeg), absAngErr(dVW.phaseDeg), absAngErr(dWU.phaseDeg)].filter(
    (e): e is number => e !== null
  );

  return {
    valid: true,
    unit: unitInfo.baseUnit,
    phases: [pU, pV, pW],
    vppUnbalancePct,
    rmsUnbalancePct,
    zeroSeqRms: zeroStats.rms,
    zeroSeqVpp: zeroStats.vpp,
    angleUVDeg: dUV.phaseDeg,
    angleVWDeg: dVW.phaseDeg,
    angleWUDeg: dWU.phaseDeg,
    maxPhaseErrorDeg: errs.length > 0 ? Math.max(...errs) : null,
    zeroSeqTrace,
    time: synced.time,
    resampled: synced.resampled,
    warnings,
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

export interface HallSequencePreset {
  id: string;
  label: string;
  ring: [number, number, number, number, number, number];
}

export const HALL_SEQUENCE_PRESETS: HallSequencePreset[] = [
  { id: 'std_120', label: '标准 120° Hall [5→1→3→2→6→4]', ring: [5, 1, 3, 2, 6, 4] },
  { id: 'alt_120', label: '换相序 120° [5→4→6→2→3→1]', ring: [5, 4, 6, 2, 3, 1] },
  { id: 'gray_60', label: '60° 排布 Hall [1→3→7→6→4→0]', ring: [1, 3, 7, 6, 4, 0] },
];

export interface HallCommutationOptions {
  tStart?: number;
  tEnd?: number;
  customSequence?: number[];
  hallOffsetDeg?: number;
}

export interface HallCommutationResult {
  valid: boolean;
  direction: 'CW (Fwd)' | 'CCW (Rev)' | 'Mixed' | 'Unknown';
  sequence: number[];
  activeRing: number[];
  hallOffsetDeg: number;
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
  warnings: string[];
}

const HALL_CW_RING = [5, 1, 3, 2, 6, 4];

export function parseHallSequenceText(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const nums = raw
    .split(/[\s,;\->→]+/)
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 7);
  if (nums.length !== 6 || new Set(nums).size !== 6) return null;
  return nums;
}

export function analyzeBldcHallCommutation(
  chA: WaveformChannel,
  chB: WaveformChannel,
  chC: WaveformChannel,
  polePairs: number,
  tStartOrOpts?: number | HallCommutationOptions,
  tEndArg?: number
): HallCommutationResult {
  const opts: HallCommutationOptions =
    tStartOrOpts !== null && typeof tStartOrOpts === 'object'
      ? tStartOrOpts
      : { tStart: typeof tStartOrOpts === 'number' ? tStartOrOpts : undefined, tEnd: tEndArg };

  const activeRing =
    opts.customSequence && opts.customSequence.length === 6 && new Set(opts.customSequence).size === 6
      ? opts.customSequence
      : HALL_CW_RING;
  const ringSet = new Set(activeRing);
  const hallOffsetDeg = Number.isFinite(opts.hallOffsetDeg) ? Number(opts.hallOffsetDeg) : 0;

  const synced = alignChannelsToCommonTimebase([chA, chB, chC], opts.tStart, opts.tEnd);
  const warnings = [...synced.warnings];
  const n = synced.time.length;

  const empty: HallCommutationResult = {
    valid: false,
    direction: 'Unknown',
    sequence: [],
    activeRing,
    hallOffsetDeg,
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
    warnings,
  };
  if (!synced.valid || n < 6) return empty;

  const [aArr, bArr, cArr] = synced.values;
  const timeArr = synced.time;

  const statsForArr = (arr: Float32Array) => {
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < n; i++) {
      const val = arr[i];
      if (isFinite(val)) {
        if (val < mn) mn = val;
        if (val > mx) mx = val;
      }
    }
    const span = mx - mn;
    return { mid: (mx + mn) / 2, hyst: span * 0.08, valid: isFinite(span) && span > 1e-9 };
  };

  const sA = statsForArr(aArr);
  const sB = statsForArr(bArr);
  const sC = statsForArr(cArr);
  if (!sA.valid || !sB.valid || !sC.valid) return empty;

  const getBit = (val: number, prevBit: number, mid: number, hyst: number) => {
    if (val >= mid + hyst) return 1;
    if (val <= mid - hyst) return 0;
    return prevBit;
  };

  let bA = aArr[0] >= sA.mid ? 1 : 0;
  let bB = bArr[0] >= sB.mid ? 1 : 0;
  let bC = cArr[0] >= sC.mid ? 1 : 0;
  let prevState = (bA << 2) | (bB << 1) | bC;
  let stateStartTime = timeArr[0];
  let stateStartIdx = 0;

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

  for (let i = 1; i < n; i++) {
    bA = getBit(aArr[i], bA, sA.mid, sA.hyst);
    bB = getBit(bArr[i], bB, sB.mid, sB.hyst);
    bC = getBit(cArr[i], bC, sC.mid, sC.hyst);
    const nextState = (bA << 2) | (bB << 1) | bC;

    if (nextState !== prevState) {
      const tTrans = 0.5 * (timeArr[i - 1] + timeArr[i]);
      const dur = tTrans - stateStartTime;
      if (ringSet.has(prevState)) {
        segments.push({ state: prevState, tStart: stateStartTime, tEnd: tTrans, dur, index: stateStartIdx });
      }
      if (!ringSet.has(nextState)) {
        illegalStateCount++;
        if (events.length < 40) {
          events.push({
            time: tTrans,
            index: i,
            kind: 'illegal-state',
            detail: `Illegal Hall code ${nextState.toString(2).padStart(3, '0')} (${nextState}) not in [${activeRing.join(',')}]`,
          });
        }
      } else if (ringSet.has(prevState)) {
        const idxPrev = activeRing.indexOf(prevState);
        const idxNext = activeRing.indexOf(nextState);
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

  // Drop incomplete leading segment (which begins at tArr[0] with no leading edge)
  const completeSegs = segments.length > 0 ? segments.slice(1) : [];
  if (completeSegs.length === 0) {
    return {
      ...empty,
      valid: true,
      commutationCount: 0,
      illegalStateCount,
      sequenceJumpCount,
      events,
    };
  }

  const totalDur = completeSegs.reduce((acc, s) => acc + s.dur, 0);
  const avgSectorDur = totalDur / completeSegs.length;
  const avgElecPeriod = avgSectorDur * 6;
  const avgElecFreqHz = avgElecPeriod > 1e-15 ? 1 / avgElecPeriod : null;

  const hallTb = inspectTimebase(timeArr, 0, timeArr.length - 1, DEFAULT_SAMPLING_GAP_FACTOR);
  const dtStep = hallTb.dtMedian > 0 ? hallTb.dtMedian : (timeArr[timeArr.length - 1] - timeArr[0]) / Math.max(1, timeArr.length - 1);
  const sectorQuantErrDeg = avgSectorDur > 1e-15 && dtStep > 0 ? (dtStep / avgSectorDur) * 60 : 0;
  if (sectorQuantErrDeg > 1.5) {
    warnings.push(
      `采样步长 Δt≈${dtStep.toExponential(2)}s 对 60° 扇区引入约 ±${sectorQuantErrDeg.toFixed(2)}° 边沿量化误差，扇区误差判断受采样分辨率限制。`
    );
  }

  const validPoles = Number.isFinite(polePairs) && polePairs > 0 && Number.isInteger(polePairs);
  if (!validPoles) {
    warnings.push(
      `极对数设置无效 (${String(polePairs)}，要求正整数 ≥ 1)；已拒绝假定默认极对数，仅保留电频率 f_e 并禁用机械转速 (RPM) 计算。`
    );
  }
  const avgRpm = validPoles && avgElecFreqHz !== null ? (60 * avgElecFreqHz) / polePairs : null;

  const rpmSamples: number[] = [];
  if (validPoles) {
    if (completeSegs.length >= 6) {
      for (let k = 0; k <= completeSegs.length - 6; k++) {
        let cycDur = 0;
        for (let m = 0; m < 6; m++) cycDur += completeSegs[k + m].dur;
        if (cycDur > 1e-15) {
          rpmSamples.push(60 / cycDur / polePairs);
        }
      }
    } else {
      completeSegs.forEach((s) => {
        if (s.dur > 1e-15) rpmSamples.push(60 / (s.dur * 6) / polePairs);
      });
    }
  }

  const rpmMin = validPoles ? (rpmSamples.length > 0 ? Math.min(...rpmSamples) : avgRpm) : null;
  const rpmMax = validPoles ? (rpmSamples.length > 0 ? Math.max(...rpmSamples) : avgRpm) : null;
  const rpmRipplePct =
    validPoles && avgRpm && rpmMin !== null && rpmMax !== null && avgRpm > 1e-9
      ? ((rpmMax - rpmMin) / avgRpm) * 100
      : null;

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

  const sectorStats: HallSectorStat[] = activeRing
    .filter((c) => stateMap.has(c))
    .map((code) => {
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

  const seq: number[] = [];
  for (const s of completeSegs) {
    if (seq.length >= 6) break;
    if (seq.length === 0 || seq[seq.length - 1] !== s.state) seq.push(s.state);
  }

  if (hallOffsetDeg !== 0) {
    warnings.push(`已记录 Hall 安装电角度偏移 ${hallOffsetDeg.toFixed(1)}°；当前 Hall-only 分析没有反电势/编码器相位参考输入，因此该偏移未参与扇区、转速或相位误差计算。`);
  }

  return {
    valid: true,
    direction,
    sequence: seq,
    activeRing,
    hallOffsetDeg,
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
    warnings,
  };
}

export type PwmHighSignalRole = 'gate_h' | 'sw_node';

export interface PwmAnalyzeOptions {
  tStart?: number;
  tEnd?: number;
  highSignalRole?: PwmHighSignalRole;
}

export interface PwmDeadTimeResult {
  valid: boolean;
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
  deadTimeReliable: boolean;
  highSignalRole: PwmHighSignalRole;
  worstEventIndex: number | null;
  worstEventTime: number | null;
  warnings: string[];
}

export function analyzePwmSwitchingAndDeadTime(
  chHigh: WaveformChannel,
  chLow?: WaveformChannel | null,
  tStartOrOpts?: number | PwmAnalyzeOptions,
  tEndArg?: number
): PwmDeadTimeResult {
  const opts: PwmAnalyzeOptions =
    tStartOrOpts !== null && typeof tStartOrOpts === 'object'
      ? tStartOrOpts
      : { tStart: typeof tStartOrOpts === 'number' ? tStartOrOpts : undefined, tEnd: tEndArg };

  const guessedSw =
    /(?:^|[^a-z0-9])(sw|phase|node|vds|[uvw]_?(?:ph|phase)?)(?:$|[^a-z0-9])/i.test(chHigh.name) &&
    !/(pwm|gate|vgs|drv|hin)/i.test(chHigh.name);
  const highSignalRole: PwmHighSignalRole = opts.highSignalRole ?? (guessedSw ? 'sw_node' : 'gate_h');

  const synced = alignChannelsToCommonTimebase(chLow ? [chHigh, chLow] : [chHigh], opts.tStart, opts.tEnd);
  const warnings = [...synced.warnings];
  const n = synced.time.length;
  let deadTimeReliable = Boolean(chLow) && highSignalRole === 'gate_h';

  const empty: PwmDeadTimeResult = {
    valid: false,
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
    deadTimeReliable: false,
    highSignalRole,
    worstEventIndex: null,
    worstEventTime: null,
    warnings,
  };
  if (!synced.valid || n < 6) return empty;

  let vScaleH = 1;
  try {
    vScaleH = parseSiUnitScale(chHigh.unit, 'V', chHigh.name, { strict: true });
  } catch (err: any) {
    deadTimeReliable = false;
    warnings.push(err?.message || `高侧信号 "${chHigh.name}" 单位非电压 (V/mV)，已禁用死区与 dV/dt 判定。`);
  }

  let vScaleL = 1;
  if (chLow) {
    try {
      vScaleL = parseSiUnitScale(chLow.unit, 'V', chLow.name, { strict: true });
    } catch (err: any) {
      deadTimeReliable = false;
      warnings.push(err?.message || `低侧信号 "${chLow.name}" 单位非电压 (V/mV)，已禁用死区/直通判定。`);
    }
    const lowLooksNonGate =
      /(?:^|[^a-z0-9])(sw|phase|node|vds|ids|ibus|ia|ib|ic)(?:$|[^a-z0-9])/i.test(chLow.name) &&
      !/(pwm|gate|vgs|drv|lin|low)/i.test(chLow.name);
    if (lowLooksNonGate) {
      deadTimeReliable = false;
      warnings.push(`第二路 "${chLow.name}" 疑似相节点/功率电流信号而非低侧栅极驱动 (Vgs_L)，已禁用死区与直通判定。`);
    }
  }

  const rawH = synced.values[0];
  const hArr = Math.abs(vScaleH - 1) <= 1e-12 ? rawH : Float32Array.from(rawH, (v) => v * vScaleH);
  const lArr = chLow
    ? Math.abs(vScaleL - 1) <= 1e-12
      ? synced.values[1]
      : Float32Array.from(synced.values[1], (v) => v * vScaleL)
    : null;
  const tArr = synced.time;

  let mn = Infinity;
  let mx = -Infinity;
  let maxDvDt = 0;

  for (let i = 0; i < n; i++) {
    const v = hArr[i];
    if (!isFinite(v)) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    if (i > 0) {
      const vp = hArr[i - 1];
      const dt = tArr[i] - tArr[i - 1];
      if (isFinite(vp) && dt > 1e-15) {
        const dvdt = Math.abs(v - vp) / (dt * 1e6); // V/us
        if (dvdt > maxDvDt) maxDvDt = dvdt;
      }
    }
  }
  const span = mx - mn;
  if (!isFinite(span) || span <= 1e-9) return empty;

  const mid = (mx + mn) / 2;
  const hyst = span * 0.08;
  let highSum = 0;
  let highCnt = 0;
  let lowSum = 0;
  let lowCnt = 0;
  for (let i = 0; i < n; i++) {
    const v = hArr[i];
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

  const pwmTb = inspectTimebase(tArr, 0, n - 1, DEFAULT_SAMPLING_GAP_FACTOR);
  const gapThreshold = pwmTb.gapThresholdSec;
  const risingEvents: Array<{ t: number; idx: number; seg: number }> = [];
  const fallingEvents: Array<{ t: number; seg: number }> = [];
  let segId = 0;
  let armed = false;
  let isHighState = isFinite(hArr[0]) ? hArr[0] >= mid : false;

  for (let i = 1; i < n; i++) {
    const vp = hArr[i - 1];
    const vc = hArr[i];
    const dt = tArr[i] - tArr[i - 1];
    const isBreak =
      !isFinite(vp) ||
      !isFinite(vc) ||
      !(dt > 0) ||
      (Number.isFinite(gapThreshold) && dt > gapThreshold);
    if (isBreak) {
      segId++;
      armed = false;
      if (isFinite(vc)) {
        isHighState = vc >= mid;
      }
      continue;
    }
    if (!isHighState && vp <= mid - hyst) armed = true;
    if (!isHighState && armed && vp < mid && vc >= mid) {
      const f = vc - vp > 1e-15 ? (mid - vp) / (vc - vp) : 0;
      risingEvents.push({ t: tArr[i - 1] + f * dt, idx: i, seg: segId });
      isHighState = true;
      armed = false;
    } else if (isHighState && vc <= mid - hyst) {
      const f = vp - vc > 1e-15 ? (vp - mid) / (vp - vc) : 0;
      fallingEvents.push({ t: tArr[i - 1] + f * dt, seg: segId });
      isHighState = false;
    }
  }

  let pwmFreqHz: number | null = null;
  const duties: number[] = [];
  if (risingEvents.length >= 2) {
    const periods: number[] = [];
    for (let k = 0; k < risingEvents.length - 1; k++) {
      const r0 = risingEvents[k];
      const r1 = risingEvents[k + 1];
      if (r0.seg !== r1.seg) continue; // Do not measure period/duty across NaN or sampling gap breaks
      const per = r1.t - r0.t;
      if (per > 0) periods.push(per);
      const fallAfter = fallingEvents.find((fe) => fe.seg === r0.seg && fe.t > r0.t && fe.t < r1.t);
      if (fallAfter !== undefined && per > 0) {
        duties.push(((fallAfter.t - r0.t) / per) * 100);
      }
    }
    if (periods.length > 0) {
      const avgPer = periods.reduce((a, b) => a + b, 0) / periods.length;
      if (avgPer > 1e-15) pwmFreqHz = 1 / avgPer;
    }
  }

  let ringingFreqHz: number | null = null;
  if (risingEvents.length > 0) {
    const rIdx = risingEvents[0].idx;
    const searchEnd = Math.min(n - 1, rIdx + 80);
    const localExtremaT: number[] = [];
    for (let i = rIdx + 1; i < searchEnd; i++) {
      const vPrev = hArr[i - 1];
      const vCurr = hArr[i];
      const vNext = hArr[i + 1];
      if (vCurr >= mid && ((vCurr > vPrev && vCurr >= vNext) || (vCurr < vPrev && vCurr <= vNext))) {
        if (Math.abs(vCurr - vTop) > amp * 0.015) {
          localExtremaT.push(tArr[i]);
          if (localExtremaT.length >= 3) break;
        }
      }
    }
    if (localExtremaT.length >= 3) {
      const fullCycleDt = localExtremaT[2] - localExtremaT[0];
      if (fullCycleDt > 1e-15) ringingFreqHz = 1 / fullCycleDt;
    }
  }

  let deadTimeMinSec: number | null = null;
  let deadTimeAvgSec: number | null = null;
  let deadTimeMaxSec: number | null = null;
  let deadTimeCount = 0;
  let shootThroughCount = 0;
  let worstEventIndex: number | null = null;
  let worstEventTime: number | null = null;

  if (lArr && highSignalRole === 'sw_node') {
    warnings.push(
      '第一路定义为 SW 相节点而非高侧栅极驱动 (Vgs_H)：死区期间体二极管续流与负载电流方向会改变 SW 电平，无法可靠判定真死区时间与直通 (Shoot-Through)，已禁用死区/直通判定。'
    );
  } else if (lArr && deadTimeReliable) {
    let mnL = Infinity;
    let mxL = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = lArr[i];
      if (isFinite(v)) {
        if (v < mnL) mnL = v;
        if (v > mxL) mxL = v;
      }
    }
    const spanL = mxL - mnL;
    if (!isFinite(spanL) || span < 2.0 || spanL < 2.0 || Math.max(span, spanL) / Math.min(span, spanL) > 5.0) {
      deadTimeReliable = false;
      warnings.push(
        `栅极驱动摆幅门限校验未通过 (Vpp_H=${span.toFixed(2)}V, Vpp_L=${isFinite(spanL) ? spanL.toFixed(2) : '--'}V，要求双路 ≥ 2.0V 且量纲比 ≤ 5×)，已禁用死区/直通判定。`
      );
    } else {
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
      let prevState: 'H' | 'L' | 'DEAD' | 'BOTH' | 'INVALID' =
        isFinite(hArr[0]) && isFinite(lArr[0]) ? getState(hArr[0], lArr[0]) : 'INVALID';
      let segStartT = tArr[0];
      let segStartIdx = 0;
      let prevActiveSide: 'H' | 'L' | null = prevState === 'H' || prevState === 'L' ? prevState : null;

      for (let i = 1; i < n; i++) {
        const dt = tArr[i] - tArr[i - 1];
        const isBreak =
          !isFinite(hArr[i - 1]) ||
          !isFinite(hArr[i]) ||
          !isFinite(lArr[i - 1]) ||
          !isFinite(lArr[i]) ||
          !(dt > 0) ||
          (Number.isFinite(gapThreshold) && dt > gapThreshold);

        if (isBreak) {
          prevActiveSide = null;
          if (isFinite(hArr[i]) && isFinite(lArr[i])) {
            prevState = getState(hArr[i], lArr[i]);
            segStartT = tArr[i];
            segStartIdx = i;
          } else {
            prevState = 'INVALID';
          }
          continue;
        }

        const st = getState(hArr[i], lArr[i]);
        if (st !== prevState) {
          const tEdge = 0.5 * (tArr[i - 1] + tArr[i]);
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
  }

  return {
    valid: true,
    pwmFreqHz,
    pulseCount: risingEvents.length,
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
    deadTimeReliable,
    highSignalRole,
    worstEventIndex,
    worstEventTime,
    warnings,
  };
}

export type RippleSignalKind = 'torque' | 'current' | 'power' | 'other';

export interface TorqueRippleResult {
  valid: boolean;
  invalidReason: string | null;
  signalKind: RippleSignalKind;
  isTrueMechanicalTorque: boolean;
  warning: string | null;
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

export function classifyRippleChannel(ch: WaveformChannel): RippleSignalKind {
  const unit = (ch.unit || '').trim().toLowerCase();
  const name = (ch.name || '').trim().toLowerCase();
  if (/n[·\.\-\s]?m|kgf|oz[\.\-]?in/.test(unit) || /(torque|t_?shaft|t_?mech|扭矩|转矩)/.test(name)) {
    return 'torque';
  }
  if (/^(u|µ|m|k)?a(mp)?$/.test(unit) || /(^i_|curr|ibus|iq|id|ia|ib|ic|电流)/.test(name)) {
    return 'current';
  }
  if (/^(m|k)?w(att)?$/.test(unit) || /(power|p_?bus|p_?in|p_?out|功率)/.test(name)) {
    return 'power';
  }
  return 'other';
}

export function analyzeTorqueAndCurrentRipple(
  ch: WaveformChannel,
  elecFreqOverrideHz?: number | null,
  tStart?: number,
  tEnd?: number
): TorqueRippleResult {
  const signalKind = classifyRippleChannel(ch);
  // A torque label/unit identifies the quantity, not whether it came from a shaft torque sensor.
  const isTrueMechanicalTorque = signalKind === 'torque' && ch.metadata?.dataProvenance === 'measured';
  const warning = signalKind === 'torque'
    ? (isTrueMechanicalTorque
        ? null
        : '已识别为转矩量（单位/通道名），但文件未携带已验证的实测传感器来源标记；请确认来自轴端转矩传感器，而不是模型估算/仿真通道。')
    : signalKind === 'current'
    ? '当前通道为电流信号，本结果仅反映电流脉动及 6× 换相谐波；由于存在磁饱和、齿槽转矩与铁损，电流纹波不能直接等同于机械轴转矩脉动。'
    : signalKind === 'power'
    ? '当前通道为电功率信号，反映瞬时功率脉动，不能直接等同于机械转矩脉动。'
    : '未识别到机械扭矩单位 (N·m/mN·m)，结果仅代表所选通道自身的波形脉动与频谱分量。';

  const invalid = (reason: string): TorqueRippleResult => ({
    valid: false, invalidReason: reason, signalKind, isTrueMechanicalTorque, warning: reason,
    mean: 0, rms: 0, peakToPeakRipple: 0, rippleFactorPct: 0, rmsRipplePct: 0,
    fundamentalElecHz: null, harm1xAmp: null, harm2xAmp: null, harm6xAmp: null, harm12xAmp: null,
    sixthHarmonicPctOfMean: null, dominantRippleFreqHz: null, dominantRippleAmp: null,
  });
  if (ch.t.length !== ch.v.length) return invalid(`通道时间轴与幅值长度不一致 (t=${ch.t.length}, v=${ch.v.length})，拒绝截断后计算纹波。`);
  const n = ch.t.length;
  if (n < 2) return invalid('有效样本不足，无法分析转矩/电流纹波。');
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(ch.t[i]) || !Number.isFinite(ch.v[i])) return invalid(`波形在索引 ${i} 处包含 NaN/Inf 时间戳或幅值，拒绝跳过无效点后输出纹波指标。`);
    if (i > 0 && !(ch.t[i] > ch.t[i - 1])) return invalid(`时间轴在索引 ${i} 处重复或倒退，纹波与谐波频率计算已拒绝。`);
  }
  const { i0, i1 } = sliceIndexRange(ch.t, n, tStart, tEnd);
  if (i1 - i0 < 8) {
    return {
      valid: false,
      invalidReason: '当前门控窗口内有效样本不足 8 点，无法可靠估算纹波及谐波。',
      signalKind,
      isTrueMechanicalTorque,
      warning: '当前门控窗口内有效样本不足 8 点，无法可靠估算纹波及谐波。',
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

  const segT = ch.t.subarray(i0, i1 + 1);
  const segV = new Float32Array(i1 - i0 + 1);
  const acMeanOffset = ch.coupling === 'AC' ? computeChannelMean(ch) : 0;
  for (let i = i0; i <= i1; i++) {
    segV[i - i0] = getChannelDisplayValue(ch, i, acMeanOffset);
  }
  const segTb = inspectTimebase(segT, 0, segT.length - 1, DEFAULT_SAMPLING_GAP_FACTOR);
  const stats = computeSegmentedTrapezoidalStats(segT, segV, 0, segT.length - 1, segTb.gapThresholdSec);
  const mean = stats.mean;
  const rms = stats.rms;
  const peakToPeakRipple = stats.vpp;
  const acRms = stats.acRms;
  const denomMean = Math.abs(mean) > 1e-9 ? Math.abs(mean) : rms > 1e-9 ? rms : 1e-9;
  const rippleFactorPct = (peakToPeakRipple / (2 * denomMean)) * 100;
  const rmsRipplePct = (acRms / denomMean) * 100;

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
    valid: true,
    invalidReason: null,
    signalKind,
    isTrueMechanicalTorque,
    warning,
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
  valid: boolean;
  unit: string;
  time: Float64Array;
  uuv: Float32Array;
  uvw: Float32Array;
  uwu: Float32Array;
  v0: Float32Array;
  svmMag: Float32Array;
  warnings: string[];
} {
  const unitInfo = resolveCompatibleSiGroupScale([chU, chV, chW]);
  if (!unitInfo.valid) {
    return {
      valid: false,
      unit: chU.unit || 'V',
      time: new Float64Array(0),
      uuv: new Float32Array(0),
      uvw: new Float32Array(0),
      uwu: new Float32Array(0),
      v0: new Float32Array(0),
      svmMag: new Float32Array(0),
      warnings: [unitInfo.reason || '三相通道单位不兼容。'],
    };
  }
  const synced = alignChannelsToCommonTimebase([chU, chV, chW]);
  const warnings = [...synced.warnings];
  if (unitInfo.normalizedNote) warnings.push(unitInfo.normalizedNote);
  const n = synced.time.length;
  if (!synced.valid || n < 2) {
    return {
      valid: false,
      unit: unitInfo.baseUnit,
      time: new Float64Array(0),
      uuv: new Float32Array(0),
      uvw: new Float32Array(0),
      uwu: new Float32Array(0),
      v0: new Float32Array(0),
      svmMag: new Float32Array(0),
      warnings,
    };
  }

  const [rawU, rawV, rawW] = synced.values;
  const [sU, sV, sW] = unitInfo.scales;
  const uArr = Math.abs(sU - 1) <= 1e-12 ? rawU : Float32Array.from(rawU, (v) => v * sU);
  const vArr = Math.abs(sV - 1) <= 1e-12 ? rawV : Float32Array.from(rawV, (v) => v * sV);
  const wArr = Math.abs(sW - 1) <= 1e-12 ? rawW : Float32Array.from(rawW, (v) => v * sW);
  const uuv = new Float32Array(n);
  const uvw = new Float32Array(n);
  const uwu = new Float32Array(n);
  const v0 = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const a = uArr[i];
    const b = vArr[i];
    const c = wArr[i];
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

  return { valid: true, unit: unitInfo.baseUnit, time: synced.time, uuv, uvw, uwu, v0, svmMag, warnings };
}
