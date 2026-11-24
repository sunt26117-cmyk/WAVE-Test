/**
 * Waveform Viewer Pro - P1 MOSFET Double Pulse Test (DPT) Synchronized Analyzer
 * Evaluates synchronized (Vgs, Vds, Ids) channels to extract:
 * - Turn-Off: E_off (uJ), dv/dt_off, di/dt_off, V_ds_peak, Overshoot (V & %), f_ring_off (MHz)
 * - Turn-On: E_on (uJ), dv/dt_on, di/dt_on, Miller plateau (V_gp, t_miller ns),
 *            Reverse recovery (I_rr_peak A, Q_rr nC, E_rec uJ), f_ring_on (MHz)
 */

import { WaveformChannel } from '../types/models';
import { parseSiUnitScale } from './thermalEngine';
import { alignChannelsToCommonTimebase, inspectTimebase, sampleSeriesAtTime } from './timeSync';
import { computeChannelMean } from './oscilloscopeScale';
import { analyzeSamplingQuality } from './qualityCheck';

export interface DptEdgeWindow {
  startTime: number;
  endTime: number;
  tStartIdx: number;
  tEndIdx: number;
}

export interface DptAnalysisOptions {
  idsDeskewNs?: number;
  vBusOverrideV?: number;
  tStart?: number;
  tEnd?: number;
}

export interface DptAnalysisResult {
  valid: boolean;
  warnings: string[];
  time: Float64Array;
  vgs: Float32Array;
  vds: Float32Array;
  ids: Float32Array;

  vBusSteadyV: number;
  iLoadA: number;
  vgsHighV: number;
  vgsLowV: number;

  // Turn-off metrics
  hasTurnOff: boolean;
  offWindow: DptEdgeWindow | null;
  eOffUj: number;
  dvDtOffVPerUs: number;
  diDtOffAPerUs: number;
  vdsPeakV: number;
  overshootV: number;
  overshootPct: number;
  fRingOffMHz: number | null;

  // Turn-on + Reverse recovery + Miller plateau metrics
  hasTurnOn: boolean;
  onWindow: DptEdgeWindow | null;
  eOnUj: number;
  eOnSansQrrUj: number;
  eRecChannelInEonUj: number;
  dvDtOnVPerUs: number;
  diDtOnAPerUs: number;
  vMillerPlateauV: number | null;
  tMillerNs: number | null;
  iRrPeakA: number;
  qRrNc: number;
  eRecUj: number;
  fRingOnMHz: number | null;

  eSwTotalUj: number;
  eSwTotalSansQrrUj: number;
  eonIncludesQrr: boolean;
}

export interface DptOperatingPoint {
  id: string;
  vBusV: number;
  iLoadA: number;
  tjC: number;
  rgOhm: number;
  eOnUj: number;
  eOffUj: number;
  qRrNc: number;
  eOnSansQrrUj?: number;
}

/**
 * Bilinear / inverse-distance-weighted multi-point DPT operating matrix interpolation
 * across (Vbus, Iload) with nearest fallback when only 1 point is recorded.
 */
export function interpolateDptSwitchingLoss(
  lut: DptOperatingPoint[],
  vBusTargetV: number,
  iLoadTargetA: number
): { eOnUj: number; eOffUj: number; eSwTotalUj: number; qRrNc: number; eOnSansQrrUj: number } | null {
  if (!lut || lut.length === 0) return null;
  if (lut.length === 1) {
    const p = lut[0];
    const vRatio = Math.max(0, vBusTargetV) / Math.max(1e-3, p.vBusV);
    const iRatio = Math.max(0, iLoadTargetA) / Math.max(1e-3, p.iLoadA);
    const eOnUj = p.eOnUj * vRatio * iRatio;
    const eOffUj = p.eOffUj * vRatio * iRatio;
    const eOnSansQrrUj = (p.eOnSansQrrUj ?? p.eOnUj) * vRatio * iRatio;
    return {
      eOnUj,
      eOffUj,
      eSwTotalUj: eOnUj + eOffUj,
      qRrNc: p.qRrNc * iRatio,
      eOnSansQrrUj,
    };
  }
  const vNorm = Math.max(1, vBusTargetV);
  const iNorm = Math.max(1, iLoadTargetA);
  let wSum = 0;
  let eOnAcc = 0;
  let eOffAcc = 0;
  let qRrAcc = 0;
  let eOnSansAcc = 0;
  for (const pt of lut) {
    const dv = (pt.vBusV - vBusTargetV) / vNorm;
    const di = (pt.iLoadA - iLoadTargetA) / iNorm;
    const d2 = dv * dv + di * di;
    if (d2 < 1e-10) {
      const eOnSans = pt.eOnSansQrrUj ?? pt.eOnUj;
      return {
        eOnUj: pt.eOnUj,
        eOffUj: pt.eOffUj,
        eSwTotalUj: pt.eOnUj + pt.eOffUj,
        qRrNc: pt.qRrNc,
        eOnSansQrrUj: eOnSans,
      };
    }
    const w = 1 / (d2 + 1e-6);
    wSum += w;
    eOnAcc += w * pt.eOnUj;
    eOffAcc += w * pt.eOffUj;
    qRrAcc += w * pt.qRrNc;
    eOnSansAcc += w * (pt.eOnSansQrrUj ?? pt.eOnUj);
  }
  const eOnUj = eOnAcc / wSum;
  const eOffUj = eOffAcc / wSum;
  return {
    eOnUj,
    eOffUj,
    eSwTotalUj: eOnUj + eOffUj,
    qRrNc: qRrAcc / wSum,
    eOnSansQrrUj: eOnSansAcc / wSum,
  };
}

function estimateRingingFreqMHz(time: Float64Array, sig: Float32Array, idx0: number, idx1: number): number | null {
  const n = idx1 - idx0 + 1;
  if (n < 10) return null;
  let sum = 0;
  for (let i = idx0; i <= idx1; i++) sum += sig[i];
  const mean = sum / n;
  let maxAmp = 0;
  for (let i = idx0; i <= idx1; i++) {
    const a = Math.abs(sig[i] - mean);
    if (a > maxAmp) maxAmp = a;
  }
  if (maxAmp < 1e-3) return null;

  const crossings: number[] = [];
  const hyst = maxAmp * 0.08;
  let state = sig[idx0] - mean >= 0 ? 1 : -1;
  for (let i = idx0 + 1; i <= idx1; i++) {
    const dPrev = sig[i - 1] - mean;
    const dCurr = sig[i] - mean;
    if (state === -1 && dCurr > hyst) {
      const den = dCurr - dPrev;
      const frac = Math.abs(den) > 1e-12 ? (0 - dPrev) / den : 0.5;
      crossings.push(time[i - 1] + Math.max(0, Math.min(1, frac)) * (time[i] - time[i - 1]));
      state = 1;
    } else if (state === 1 && dCurr < -hyst) {
      state = -1;
    }
  }
  if (crossings.length < 2) return null;
  const periods: number[] = [];
  for (let k = 1; k < crossings.length; k++) {
    const p = crossings[k] - crossings[k - 1];
    if (p > 1e-11) periods.push(p);
  }
  if (periods.length === 0) return null;
  periods.sort((a, b) => a - b);
  const medP = periods[periods.length >> 1];
  const fMHz = 1 / (medP * 1e6);
  return Number.isFinite(fMHz) && fMHz > 0.05 && fMHz < 2000 ? fMHz : null;
}

function linearCrossingTime(
  time: Float64Array,
  arr: Float32Array,
  i0: number,
  i1: number,
  level: number,
  rising: boolean
): number | null {
  for (let i = Math.max(1, i0); i <= i1; i++) {
    const a = arr[i - 1];
    const b = arr[i];
    if (rising ? a <= level && b >= level : a >= level && b <= level) {
      const den = b - a;
      const frac = Math.abs(den) > 1e-12 ? (level - a) / den : 0;
      return time[i - 1] + Math.max(0, Math.min(1, frac)) * (time[i] - time[i - 1]);
    }
  }
  return null;
}

export function analyzeDoublePulseTest(
  vgsCh: WaveformChannel,
  vdsCh: WaveformChannel,
  idsCh: WaveformChannel,
  opts: DptAnalysisOptions = {}
): DptAnalysisResult {
  if (vgsCh.id === vdsCh.id || vdsCh.id === idsCh.id || vgsCh.id === idsCh.id) {
    throw new Error('DPT 分析需要分别选择独立的 Vgs、Vds 和 Ids 三个通道。');
  }

  const vgsScale = parseSiUnitScale(vgsCh.unit, 'V', vgsCh.name, { strict: true });
  const vdsScale = parseSiUnitScale(vdsCh.unit, 'V', vdsCh.name, { strict: true });
  const idsScale = parseSiUnitScale(idsCh.unit, 'A', idsCh.name, { strict: true });

  const aligned = alignChannelsToCommonTimebase([vgsCh, vdsCh, idsCh], opts.tStart, opts.tEnd);
  if (!aligned.valid) {
    throw new Error(aligned.invalidReason || aligned.warnings[0] || 'DPT 通道时间轴无效或无重叠区间，已拒绝分析。');
  }
  const warnings: string[] = [...aligned.warnings];
  const time = aligned.time;
  const len = time.length;
  if (len < 20) {
    throw new Error('DPT 分析需要重叠时间窗内至少 20 个有效同步采样点。');
  }

  const vgs = new Float32Array(len);
  const vds = new Float32Array(len);
  const ids = new Float32Array(len);

  const deskewSec = (opts.idsDeskewNs || 0) * 1e-9;
  const mIds = idsCh.coupling === 'AC' ? computeChannelMean(idsCh) : 0;
  const tbIds = inspectTimebase(idsCh.t);
  if (!tbIds.monotonic) {
    throw new Error(`Ids 通道时间轴非严格递增，无法应用 Deskew 插值。`);
  }

  for (let k = 0; k < len; k++) {
    vgs[k] = aligned.values[0][k] * vgsScale;
    vds[k] = aligned.values[1][k] * vdsScale;
    if (Math.abs(deskewSec) > 1e-15) {
      const tQ = Math.max(idsCh.t[0], Math.min(idsCh.t[idsCh.t.length - 1], time[k] - deskewSec));
      const iv = sampleSeriesAtTime(idsCh.t, idsCh, tQ, mIds) * idsScale;
      ids[k] = Number.isFinite(iv) ? iv : aligned.values[2][k] * idsScale;
    } else {
      ids[k] = aligned.values[2][k] * idsScale;
    }
  }

  // Estimate Vgs low/high & Vds steady high using percentiles/histograms
  const sortedVgs = Array.from(vgs).filter(Number.isFinite).sort((a, b) => a - b);
  const sortedVds = Array.from(vds).filter(Number.isFinite).sort((a, b) => a - b);
  if (sortedVgs.length < 10 || sortedVds.length < 10) {
    throw new Error('Vgs 或 Vds 有效数值点过少，无法定位双脉冲开关边沿。');
  }

  const vgsLowV = sortedVgs[Math.floor(sortedVgs.length * 0.05)];
  const vgsHighV = sortedVgs[Math.floor(sortedVgs.length * 0.95)];
  const vgsMid = 0.5 * (vgsLowV + vgsHighV);
  if (vgsHighV - vgsLowV < 1.5) {
    throw new Error(`Vgs 门极摆幅仅 ${(vgsHighV - vgsLowV).toFixed(2)}V，未能识别到有效开关脉冲。`);
  }

  // Estimate off-state steady Vbus from median of upper 40% Vds values (robust against turn-off overshoot spike)
  const highVdsSamples = sortedVds.filter((v) => v > sortedVds[0] + 0.5 * (sortedVds[sortedVds.length - 1] - sortedVds[0]));
  const vBusAutoV = highVdsSamples.length > 0 ? highVdsSamples[Math.floor(highVdsSamples.length * 0.5)] : sortedVds[sortedVds.length - 1];
  const vBusSteadyV = opts.vBusOverrideV && opts.vBusOverrideV > 0 ? opts.vBusOverrideV : vBusAutoV;
  if (vBusSteadyV < 1.0) {
    throw new Error(`Vds 关断平台电压 (${vBusSteadyV.toFixed(2)}V) 过低，无法执行双脉冲开关评估。`);
  }

  // Find Vgs falling and rising gate transitions
  const fallingEdges: number[] = [];
  const risingEdges: number[] = [];
  const minEdgeSpacingPts = Math.max(4, Math.floor(len * 0.01));
  for (let i = 1; i < len; i++) {
    if (vgs[i - 1] >= vgsMid && vgs[i] < vgsMid) {
      if (fallingEdges.length === 0 || i - fallingEdges[fallingEdges.length - 1] > minEdgeSpacingPts) {
        fallingEdges.push(i);
      }
    } else if (vgs[i - 1] <= vgsMid && vgs[i] > vgsMid) {
      if (risingEdges.length === 0 || i - risingEdges[risingEdges.length - 1] > minEdgeSpacingPts) {
        risingEdges.push(i);
      }
    }
  }

  // Pick Turn-Off edge with largest pre-edge drain current, and subsequent Turn-On edge (Pulse 2 turn-on)
  let turnOffGateIdx = -1;
  let bestTurnOffCurrent = -Infinity;
  for (const idx of fallingEdges) {
    const pre0 = Math.max(0, idx - Math.max(3, Math.floor(len * 0.02)));
    let meanPreI = 0;
    for (let j = pre0; j < idx; j++) meanPreI += ids[j];
    meanPreI /= Math.max(1, idx - pre0);
    if (meanPreI > bestTurnOffCurrent) {
      bestTurnOffCurrent = meanPreI;
      turnOffGateIdx = idx;
    }
  }

  // Pick Turn-On edge: prefer rising edge after turnOffGateIdx (Pulse 2 turn-on), fallback to strongest rising edge
  let turnOnGateIdx = -1;
  if (turnOffGateIdx >= 0) {
    const afterRising = risingEdges.filter((idx) => idx > turnOffGateIdx + minEdgeSpacingPts);
    if (afterRising.length > 0) {
      turnOnGateIdx = afterRising[0];
    }
  }
  if (turnOnGateIdx < 0 && risingEdges.length > 0) {
    // Fallback: pick rising edge that actually has post-edge drain current > 10% max Ids
    const maxI = Math.max(...Array.from(ids));
    for (const idx of risingEdges) {
      const post1 = Math.min(len - 1, idx + Math.max(6, Math.floor(len * 0.04)));
      let peakPost = 0;
      for (let j = idx; j <= post1; j++) if (ids[j] > peakPost) peakPost = ids[j];
      if (peakPost > maxI * 0.15) {
        turnOnGateIdx = idx;
        break;
      }
    }
  }

  const totalSpanSec = time[len - 1] - time[0];
  const winHalfPts = Math.max(8, Math.min(Math.floor(len * 0.18), Math.round((totalSpanSec * 0.12) / Math.max(1e-12, totalSpanSec / len))));

  let iLoadA = Math.max(0, bestTurnOffCurrent);

  // --- Evaluate Turn-Off ---
  let hasTurnOff = false;
  let offWindow: DptEdgeWindow | null = null;
  let eOffUj = 0;
  let dvDtOffVPerUs = 0;
  let diDtOffAPerUs = 0;
  let vdsPeakV = vBusSteadyV;
  let overshootV = 0;
  let overshootPct = 0;
  let fRingOffMHz: number | null = null;

  if (turnOffGateIdx >= 0) {
    const w0 = Math.max(0, turnOffGateIdx - winHalfPts);
    const w1 = Math.min(len - 1, turnOffGateIdx + winHalfPts);

    // Pre-turn-off load current (immediately before Vds starts rising)
    let iSumPre = 0;
    let iCntPre = 0;
    for (let j = Math.max(0, turnOffGateIdx - Math.max(3, Math.floor(winHalfPts * 0.35))); j < turnOffGateIdx; j++) {
      if (vds[j] < vBusSteadyV * 0.1) {
        iSumPre += ids[j];
        iCntPre++;
      }
    }
    if (iCntPre >= 2) iLoadA = Math.max(iLoadA, iSumPre / iCntPre);
    const iRefOff = Math.max(0.1, iLoadA);

    const tV10 = linearCrossingTime(time, vds, w0, w1, 0.1 * vBusSteadyV, true);
    const tV90 = linearCrossingTime(time, vds, w0, w1, 0.9 * vBusSteadyV, true);
    if (tV10 !== null && tV90 !== null && tV90 > tV10) {
      dvDtOffVPerUs = (0.8 * vBusSteadyV) / ((tV90 - tV10) * 1e6);
    }

    const tI90 = linearCrossingTime(time, ids, w0, w1, 0.9 * iRefOff, false);
    const tI10 = linearCrossingTime(time, ids, w0, w1, 0.1 * iRefOff, false);
    if (tI90 !== null && tI10 !== null && tI10 > tI90) {
      diDtOffAPerUs = (0.8 * iRefOff) / ((tI10 - tI90) * 1e6);
    }

    // Eoff integration bounds: Vds >= 10% Vbus -> Ids <= 2% Iload (first zero/2% crossing after Vds reaches 90%)
    let eStart = w0;
    while (eStart < w1 && vds[eStart] < 0.1 * vBusSteadyV) eStart++;
    eStart = Math.max(w0, eStart - 1);

    let v90Idx = eStart;
    while (v90Idx < w1 && vds[v90Idx] < 0.9 * vBusSteadyV) v90Idx++;
    let eEnd = v90Idx;
    while (eEnd < w1 && ids[eEnd] > 0.02 * iRefOff) eEnd++;
    eEnd = Math.min(w1, Math.max(eStart + 2, eEnd + 1));

    let eJ = 0;
    for (let j = eStart + 1; j <= eEnd; j++) {
      const dt = Math.max(0, time[j] - time[j - 1]);
      const p0 = vds[j - 1] * ids[j - 1];
      const p1 = vds[j] * ids[j];
      eJ += 0.5 * (p0 + p1) * dt;
    }
    eOffUj = Math.max(0, eJ * 1e6);

    let pkIdx = eStart;
    vdsPeakV = vds[eStart];
    for (let j = eStart; j <= w1; j++) {
      if (vds[j] > vdsPeakV) {
        vdsPeakV = vds[j];
        pkIdx = j;
      }
    }
    overshootV = Math.max(0, vdsPeakV - vBusSteadyV);
    overshootPct = (overshootV / Math.max(1e-3, vBusSteadyV)) * 100;

    const ringEnd = Math.min(w1, pkIdx + Math.max(15, Math.floor(winHalfPts * 0.8)));
    fRingOffMHz = estimateRingingFreqMHz(time, vds, pkIdx, ringEnd);

    hasTurnOff = true;
    offWindow = {
      startTime: time[eStart],
      endTime: time[eEnd],
      tStartIdx: eStart,
      tEndIdx: eEnd,
    };
  } else {
    warnings.push('未能识别清晰的关断边沿（Vgs 高→低且伴随大负载电流），请调整门控区间。');
  }

  // --- Evaluate Turn-On (Miller Plateau + Reverse Recovery) ---
  let hasTurnOn = false;
  let onWindow: DptEdgeWindow | null = null;
  let eOnUj = 0;
  let eRecChannelInEonUj = 0;
  let dvDtOnVPerUs = 0;
  let diDtOnAPerUs = 0;
  let vMillerPlateauV: number | null = null;
  let tMillerNs: number | null = null;
  let iRrPeakA = 0;
  let qRrNc = 0;
  let eRecUj = 0;
  let fRingOnMHz: number | null = null;

  if (turnOnGateIdx >= 0) {
    const w0 = Math.max(0, turnOnGateIdx - winHalfPts);
    const w1 = Math.min(len - 1, turnOnGateIdx + winHalfPts);

    // Estimate settled post-turn-on load current on tail of w1 (after recovery ringing decays)
    const tail0 = Math.max(turnOnGateIdx, w1 - Math.max(4, Math.floor(winHalfPts * 0.25)));
    const tailIds: number[] = [];
    for (let j = tail0; j <= w1; j++) {
      if (vds[j] < 0.15 * vBusSteadyV && Number.isFinite(ids[j])) tailIds.push(ids[j]);
    }
    if (tailIds.length >= 3) {
      tailIds.sort((a, b) => a - b);
      const medLoad = tailIds[tailIds.length >> 1];
      if (medLoad > 0.1) iLoadA = iLoadA > 0 ? 0.5 * (iLoadA + medLoad) : medLoad;
    }
    const iRefOn = Math.max(0.1, iLoadA);

    const tI10 = linearCrossingTime(time, ids, w0, w1, 0.1 * iRefOn, true);
    const tI90 = linearCrossingTime(time, ids, w0, w1, 0.9 * iRefOn, true);
    if (tI10 !== null && tI90 !== null && tI90 > tI10) {
      diDtOnAPerUs = (0.8 * iRefOn) / ((tI90 - tI10) * 1e6);
    }

    const tV90 = linearCrossingTime(time, vds, w0, w1, 0.9 * vBusSteadyV, false);
    const tV10 = linearCrossingTime(time, vds, w0, w1, 0.1 * vBusSteadyV, false);
    if (tV90 !== null && tV10 !== null && tV10 > tV90) {
      dvDtOnVPerUs = (0.8 * vBusSteadyV) / ((tV10 - tV90) * 1e6);
    }

    // Eon window: Ids rises past 10% Iload -> Vds falls below 2% Vbus
    let eStart = w0;
    while (eStart < w1 && ids[eStart] < 0.1 * iRefOn) eStart++;
    eStart = Math.max(w0, eStart - 1);

    let eEnd = eStart;
    while (eEnd < w1 && vds[eEnd] > 0.02 * vBusSteadyV) eEnd++;
    eEnd = Math.min(w1, Math.max(eStart + 2, eEnd + 1));

    let eJ = 0;
    for (let j = eStart + 1; j <= eEnd; j++) {
      const dt = Math.max(0, time[j] - time[j - 1]);
      const p0 = vds[j - 1] * ids[j - 1];
      const p1 = vds[j] * ids[j];
      eJ += 0.5 * (p0 + p1) * dt;
    }
    eOnUj = Math.max(0, eJ * 1e6);

    // Reverse recovery detection: region where Ids > iRefOn around turn-on peak
    let peakIdx = eStart;
    let iPeakOn = ids[eStart];
    for (let j = eStart; j <= w1; j++) {
      if (ids[j] > iPeakOn) {
        iPeakOn = ids[j];
        peakIdx = j;
      }
    }
    if (iPeakOn > iRefOn * 1.05) {
      iRrPeakA = iPeakOn - iRefOn;
      let rrStart = peakIdx;
      while (rrStart > eStart && ids[rrStart] > iRefOn) rrStart--;
      let rrEnd = peakIdx;
      while (rrEnd < w1 && ids[rrEnd] > iRefOn) rrEnd++;

      let qC = 0;
      let eRecJ = 0;
      let eRecInEonJ = 0;
      for (let j = rrStart + 1; j <= rrEnd; j++) {
        const dt = Math.max(0, time[j] - time[j - 1]);
        const ex0 = Math.max(0, ids[j - 1] - iRefOn);
        const ex1 = Math.max(0, ids[j] - iRefOn);
        qC += 0.5 * (ex0 + ex1) * dt;
        // Reverse recovery diode stress correlates with instantaneous V_diode ≈ Vbus - Vds
        eRecJ += 0.5 * (ex0 * Math.max(0, vBusSteadyV - vds[j - 1]) + ex1 * Math.max(0, vBusSteadyV - vds[j])) * dt;
        // Excess reverse-recovery energy dissipated inside the MOSFET channel during Turn-On Eon integration window
        if (j > eStart && j <= eEnd) {
          eRecInEonJ += 0.5 * (ex0 * Math.max(0, vds[j - 1]) + ex1 * Math.max(0, vds[j])) * dt;
        }
      }
      qRrNc = qC * 1e9;
      eRecUj = eRecJ * 1e6;
      eRecChannelInEonUj = Math.min(eOnUj, Math.max(0, eRecInEonJ * 1e6));
      const ringEndOn = Math.min(w1, peakIdx + Math.max(15, Math.floor(winHalfPts * 0.8)));
      fRingOnMHz = estimateRingingFreqMHz(time, ids, peakIdx, ringEndOn);
    }

    // Miller plateau detection: look inside rising Vgs window (between 25% and 88% VgsHigh, overlapping Vds fall)
    const vMinPlat = vgsLowV + 0.22 * (vgsHighV - vgsLowV);
    const vMaxPlat = vgsLowV + 0.86 * (vgsHighV - vgsLowV);
    const candIdx: number[] = [];
    for (let j = w0 + 1; j <= w1 - 1; j++) {
      if (vgs[j] >= vMinPlat && vgs[j] <= vMaxPlat && time[j] >= (tI10 ?? time[w0]) - 20e-9) {
        candIdx.push(j);
      }
    }
    if (candIdx.length >= 4) {
      // Find contiguous sub-interval with minimal |dVgs/dt| near Vds transition
      const slopes = candIdx.map((j) => {
        const dt = Math.max(1e-12, time[j + 1] - time[j - 1]);
        return Math.abs(vgs[j + 1] - vgs[j - 1]) / dt;
      });
      const minSlope = Math.min(...slopes);
      const avgSlope = (vgsHighV - vgsLowV) / Math.max(1e-9, (tI90 ?? time[w1]) - (tI10 ?? time[w0]) + 1e-8);
      const flatThresh = Math.max(minSlope * 2.8, avgSlope * 0.35);

      let bestStart = -1;
      let bestEnd = -1;
      let curStart = -1;
      for (let k = 0; k < candIdx.length; k++) {
        const contiguous = k > 0 && candIdx[k] === candIdx[k - 1] + 1;
        if (slopes[k] <= flatThresh) {
          if (curStart === -1 || !contiguous) curStart = k;
          if (bestStart === -1 || k - curStart > bestEnd - bestStart) {
            bestStart = curStart;
            bestEnd = k;
          }
        } else {
          curStart = -1;
        }
      }
      if (bestStart >= 0 && bestEnd - bestStart >= 2) {
        let sumGp = 0;
        for (let k = bestStart; k <= bestEnd; k++) sumGp += vgs[candIdx[k]];
        vMillerPlateauV = sumGp / (bestEnd - bestStart + 1);
        tMillerNs = (time[candIdx[bestEnd]] - time[candIdx[bestStart]]) * 1e9;
      }
    }

    hasTurnOn = true;
    onWindow = {
      startTime: time[eStart],
      endTime: time[eEnd],
      tStartIdx: eStart,
      tEndIdx: eEnd,
    };
  } else {
    warnings.push('未能识别清晰的第二次脉冲开通边沿（Vgs 低→高），仅展示关断分析或检查双脉冲门控。');
  }

  const eOnSansQrrUj = Math.max(0, eOnUj - eRecChannelInEonUj);
  return {
    valid: hasTurnOff || hasTurnOn,
    warnings,
    time,
    vgs,
    vds,
    ids,
    vBusSteadyV,
    iLoadA,
    vgsHighV,
    vgsLowV,
    hasTurnOff,
    offWindow,
    eOffUj,
    dvDtOffVPerUs,
    diDtOffAPerUs,
    vdsPeakV,
    overshootV,
    overshootPct,
    fRingOffMHz,
    hasTurnOn,
    onWindow,
    eOnUj,
    eOnSansQrrUj,
    eRecChannelInEonUj,
    dvDtOnVPerUs,
    diDtOnAPerUs,
    vMillerPlateauV,
    tMillerNs,
    iRrPeakA,
    qRrNc,
    eRecUj,
    fRingOnMHz,
    eSwTotalUj: eOnUj + eOffUj,
    eSwTotalSansQrrUj: eOnSansQrrUj + eOffUj,
    eonIncludesQrr: true,
  };
}

/**
 * Generates realistic physical Double Pulse Test (DPT) demonstration waveforms
 * (Vgs with Miller plateau, Vds with turn-off inductive overshoot + ringing, Ids with diode reverse recovery).
 */
export function generateDptDemoChannels(): {
  vgsCh: WaveformChannel;
  vdsCh: WaveformChannel;
  idsCh: WaveformChannel;
} {
  const n = 2000;
  const dt = 2e-9; // 2 ns -> 4 us capture (500 MSa/s)
  const t = new Float64Array(n);
  const vgs = new Float32Array(n);
  const vds = new Float32Array(n);
  const ids = new Float32Array(n);

  const vBus = 48.0;
  const iLoad = 45.0;
  const vGp = 4.6;
  const vHigh = 12.0;

  // Timeline:
  // 0.00 - 1.50 us: Pulse 1 charging inductor (Vgs=12V, Vds~0.2V, Ids ramps 0 -> 45A)
  // 1.50 - 1.62 us: Turn-Off (Vgs 12->0, Vds rises to 48V + 16V overshoot ringing @ 38MHz, Ids drops 45->0)
  // 1.62 - 2.60 us: Freewheeling off-time (Vgs=0, Vds=48V, Ids=0)
  // 2.60 - 2.75 us: Turn-On (Vgs rises 0 -> Miller plateau 4.6V (50ns) -> 12V, Ids rises + Irr 24A recovery @ 42MHz, Vds drops 48->0.2V)
  // 2.75 - 4.00 us: Pulse 2 conduction

  for (let i = 0; i < n; i++) {
    const ti = i * dt;
    t[i] = ti;
    const us = ti * 1e6;

    if (us < 1.48) {
      vgs[i] = vHigh;
      const il = Math.min(iLoad, (us / 1.48) * iLoad);
      ids[i] = il;
      vds[i] = 0.0045 * il;
    } else if (us < 1.54) {
      // Turn-off Miller plateau & Vds rise
      const f = (us - 1.48) / 0.06;
      vgs[i] = f < 0.3 ? vHigh - (f / 0.3) * (vHigh - vGp) : f < 0.7 ? vGp : vGp * (1 - (f - 0.7) / 0.3);
      vds[i] = f < 0.25 ? 0.2 : Math.min(vBus, 0.2 + ((f - 0.25) / 0.65) * (vBus - 0.2));
      ids[i] = f < 0.65 ? iLoad : Math.max(0, iLoad * (1 - (f - 0.65) / 0.35));
    } else if (us < 2.58) {
      // Turn-off overshoot + damped ringing at 36 MHz
      const tr = ti - 1.525e-6;
      vgs[i] = 0;
      const ring = tr > 0 ? 15.5 * Math.exp(-tr / 65e-9) * Math.sin(2 * Math.PI * 36e6 * tr) : 0;
      vds[i] = vBus + ring;
      ids[i] = tr > 0 ? -1.2 * Math.exp(-tr / 40e-9) * Math.sin(2 * Math.PI * 36e6 * tr) : 0;
    } else if (us < 2.74) {
      // Turn-on with clear Miller plateau (2.625 .. 2.675 us) + reverse recovery spike (2.635 .. 2.695 us)
      const f = (us - 2.58) / 0.16;
      if (f < 0.28) {
        vgs[i] = (f / 0.28) * vGp;
      } else if (f < 0.62) {
        vgs[i] = vGp + 0.08 * Math.sin((f - 0.28) * 18);
      } else {
        vgs[i] = vGp + ((f - 0.62) / 0.38) * (vHigh - vGp);
      }

      // Ids rises from 0 -> iLoad + Irr peak 24A then rings down
      if (f < 0.22) {
        ids[i] = 0;
        vds[i] = vBus;
      } else if (f < 0.36) {
        const rf = (f - 0.22) / 0.14;
        ids[i] = rf * iLoad;
        vds[i] = vBus - rf * 4.5; // L_loop * di/dt drop
      } else if (f < 0.72) {
        const rrPhase = (f - 0.36) / 0.36;
        const rrPulse = 24.0 * Math.sin(Math.PI * rrPhase) * Math.exp(-rrPhase * 1.1);
        ids[i] = iLoad + Math.max(0, rrPulse);
        const fallFrac = Math.min(1, Math.max(0, (f - 0.40) / 0.28));
        vds[i] = (vBus - 4.5) * (1 - fallFrac) + 0.2 * fallFrac;
      } else {
        const tAfter = (f - 0.72) * 0.16e-6;
        ids[i] = iLoad + 5.5 * Math.exp(-tAfter / 35e-9) * Math.sin(2 * Math.PI * 42e6 * tAfter);
        vds[i] = 0.2 + 1.8 * Math.exp(-tAfter / 25e-9) * Math.sin(2 * Math.PI * 42e6 * tAfter);
      }
    } else {
      vgs[i] = vHigh;
      const il = iLoad + (us - 2.74) * 3.5;
      ids[i] = il;
      vds[i] = 0.0045 * il;
    }
  }

  const make = (id: string, name: string, unit: string, color: string, arr: Float32Array): WaveformChannel => ({
    id,
    name,
    unit,
    color,
    t,
    v: arr,
    visible: true,
    vMin: -10,
    vMax: 100,
    coupling: 'DC',
    inverted: false,
    isMath: false,
    sourceChannelIds: [],
    fs: 1 / dt,
    dt,
    metadata: analyzeSamplingQuality(t),
  });

  return {
    vgsCh: make('dpt_demo_vgs', 'Vgs_Demo', 'V', '#f59e0b', vgs),
    vdsCh: make('dpt_demo_vds', 'Vds_Demo', 'V', '#22d3ee', vds),
    idsCh: make('dpt_demo_ids', 'Ids_Demo', 'A', '#fb7185', ids),
  };
}
