/**
 * Waveform Viewer Pro - XY (Lissajous) Trajectory Metrics
 *
 * Implements:
 * - XY-01: Normalized weighted Least-Squares Circle Fit (xc, yc), R_mean, radial RMS error E_r,
 *   CircleFitErrorPct = (E_r / R_mean) * 100, CircleFitQualityPct = 100 * max(0, 1 - E_r / R_mean),
 *   plus angular coverage & closure gates to avoid misclassifying lines, open arcs, ellipses, or figure-8s.
 * - XY-02: Gap-segmented trapezoidal time-weighted sinusoidal LS frequency & phase estimation
 *   x(t) = cx + ax*cos(w*t) + bx*sin(w*t), y(t) = cy + ay*cos(w*t) + by*sin(w*t)
 *   with frequency-mismatch rejection and non-sinusoidal fundamental-equivalent labeling.
 */

import { WaveformChannel } from '../types/models';
import {
  DEFAULT_SAMPLING_GAP_FACTOR,
  alignChannelsToCommonTimebase,
  inspectTimebase,
  validateChannelIntegrity,
} from './timeSync';

export type XYStatus = 'OK' | 'INVALID' | 'INSUFFICIENT_DATA';

export type XYTrajectoryShapeHint =
  | 'circle'
  | 'ellipse'
  | 'figure_8_or_lissajous'
  | 'line'
  | 'open_arc'
  | 'irregular'
  | 'insufficient';

export type XYPhaseKind =
  | 'fundamental_ls_time_weighted'
  | 'fundamental_non_sinusoidal'
  | 'frequency_mismatch'
  | 'insufficient';

export interface XYMetrics {
  valid: boolean;
  status: XYStatus;
  invalidReason: string | null;
  sampleCount: number;
  invalidCount: number;
  coveragePct: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  /** Primary alias for UI compatibility: equals circleFitQualityPct (Least-Squares Circle Fit Quality, NOT bounding-box aspect ratio). */
  circularityPct: number | null;
  circleFitQualityPct: number | null;
  circleFitErrorPct: number | null;
  circleCenter: { x: number; y: number } | null;
  circleRadiusMean: number | null;
  angularCoveragePct: number | null;
  closureRatio: number | null;
  trajectoryShapeHint: XYTrajectoryShapeHint;
  circleFitNote: string | null;
  lissajousPhaseDeg: number | null;
  phaseKind: XYPhaseKind;
  fundamentalFreqXHz: number | null;
  fundamentalFreqYHz: number | null;
  sinusoidalR2X: number | null;
  sinusoidalR2Y: number | null;
  isNonSinusoidal: boolean;
  phaseNote: string | null;
}

export interface XYAlignedResult {
  metrics: XYMetrics;
  time: Float64Array;
  xValues: Float32Array;
  yValues: Float32Array;
}

function makeInvalidXY(
  status: 'INVALID' | 'INSUFFICIENT_DATA',
  invalidReason: string
): XYAlignedResult {
  return {
    metrics: {
      valid: false,
      status,
      invalidReason,
      sampleCount: 0,
      invalidCount: 0,
      coveragePct: 0,
      xMin: -1,
      xMax: 1,
      yMin: -1,
      yMax: 1,
      circularityPct: null,
      circleFitQualityPct: null,
      circleFitErrorPct: null,
      circleCenter: null,
      circleRadiusMean: null,
      angularCoveragePct: null,
      closureRatio: null,
      trajectoryShapeHint: 'insufficient',
      circleFitNote: invalidReason,
      lissajousPhaseDeg: null,
      phaseKind: 'insufficient',
      fundamentalFreqXHz: null,
      fundamentalFreqYHz: null,
      sinusoidalR2X: null,
      sinusoidalR2Y: null,
      isNonSinusoidal: false,
      phaseNote: invalidReason,
    },
    time: new Float64Array(0),
    xValues: new Float32Array(0),
    yValues: new Float32Array(0),
  };
}

function wrapDeg180(deg: number): number {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d <= -180 + 1e-12) d = 180;
  return d;
}

interface ValidSegment {
  indices: number[];
  times: number[];
  xs: number[];
  ys: number[];
  weights: number[];
}

function extractContinuousValidSegments(
  time: Float64Array,
  xValues: Float32Array,
  yValues: Float32Array,
  gapThresholdSec: number
): ValidSegment[] {
  const n = time.length;
  const rawSegs: Array<{ indices: number[]; times: number[]; xs: number[]; ys: number[] }> = [];
  let cur: { indices: number[]; times: number[]; xs: number[]; ys: number[] } | null = null;

  for (let i = 0; i < n; i++) {
    const xv = xValues[i];
    const yv = yValues[i];
    const tv = time[i];
    if (!Number.isFinite(xv) || !Number.isFinite(yv) || !Number.isFinite(tv)) {
      if (cur && cur.indices.length > 0) {
        rawSegs.push(cur);
        cur = null;
      }
      continue;
    }
    if (cur && cur.times.length > 0) {
      const dt = tv - cur.times[cur.times.length - 1];
      if (!(dt > 0) || (Number.isFinite(gapThresholdSec) && dt > gapThresholdSec)) {
        rawSegs.push(cur);
        cur = { indices: [i], times: [tv], xs: [xv], ys: [yv] };
        continue;
      }
    }
    if (!cur) cur = { indices: [], times: [], xs: [], ys: [] };
    cur.indices.push(i);
    cur.times.push(tv);
    cur.xs.push(xv);
    cur.ys.push(yv);
  }
  if (cur && cur.indices.length > 0) rawSegs.push(cur);

  // Assign trapezoidal interval weights strictly inside each continuous segment
  return rawSegs.map((seg) => {
    const m = seg.times.length;
    const weights = new Array<number>(m);
    if (m === 1) {
      weights[0] = 0;
    } else {
      for (let k = 0; k < m; k++) {
        const dtL = k > 0 ? seg.times[k] - seg.times[k - 1] : 0;
        const dtR = k + 1 < m ? seg.times[k + 1] - seg.times[k] : 0;
        weights[k] = 0.5 * (dtL + dtR);
      }
    }
    return { ...seg, weights };
  });
}

function solve3x3(a: number[][], b: number[]): number[] | null {
  const m = [
    [a[0][0], a[0][1], a[0][2], b[0]],
    [a[1][0], a[1][1], a[1][2], b[1]],
    [a[2][0], a[2][1], a[2][2], b[2]],
  ];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    let best = Math.abs(m[col][col]);
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(m[r][col]) > best) {
        best = Math.abs(m[r][col]);
        piv = r;
      }
    }
    if (best < 1e-18) return null;
    if (piv !== col) {
      const tmp = m[col];
      m[col] = m[piv];
      m[piv] = tmp;
    }
    const diag = m[col][col];
    for (let j = col; j < 4; j++) m[col][j] /= diag;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col];
      for (let j = col; j < 4; j++) m[r][j] -= f * m[col][j];
    }
  }
  return [m[0][3], m[1][3], m[2][3]];
}

interface SinusoidFitResult {
  c: number;
  a: number;
  b: number;
  amp: number;
  phiRad: number; // atan2(-b, a), so signal = c + amp * cos(w*t + phiRad)
  r2: number;
}

function fitWeightedSinusoidAtFreq(
  segments: ValidSegment[],
  pickVal: (seg: ValidSegment, idx: number) => number,
  freqHz: number
): SinusoidFitResult | null {
  if (!Number.isFinite(freqHz) || freqHz <= 0) return null;
  const w = 2 * Math.PI * freqHz;

  let s00 = 0;
  let s01 = 0;
  let s02 = 0;
  let s11 = 0;
  let s12 = 0;
  let s22 = 0;
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let sumW = 0;
  let sumWY = 0;
  let sumWY2 = 0;

  for (const seg of segments) {
    for (let k = 0; k < seg.times.length; k++) {
      const wt = seg.weights[k];
      if (!(wt > 0)) continue;
      const t = seg.times[k];
      const y = pickVal(seg, k);
      const cw = Math.cos(w * t);
      const sw = Math.sin(w * t);
      s00 += wt;
      s01 += wt * cw;
      s02 += wt * sw;
      s11 += wt * cw * cw;
      s12 += wt * cw * sw;
      s22 += wt * sw * sw;
      b0 += wt * y;
      b1 += wt * y * cw;
      b2 += wt * y * sw;
      sumW += wt;
      sumWY += wt * y;
      sumWY2 += wt * y * y;
    }
  }
  if (!(sumW > 0)) return null;

  const sol = solve3x3(
    [
      [s00, s01, s02],
      [s01, s11, s12],
      [s02, s12, s22],
    ],
    [b0, b1, b2]
  );
  if (!sol) return null;

  const [c, a, b] = sol;
  const meanY = sumWY / sumW;
  const tss = Math.max(0, sumWY2 - sumW * meanY * meanY);
  if (tss <= 1e-24) return null;

  let rss = 0;
  for (const seg of segments) {
    for (let k = 0; k < seg.times.length; k++) {
      const wt = seg.weights[k];
      if (!(wt > 0)) continue;
      const t = seg.times[k];
      const y = pickVal(seg, k);
      const yHat = c + a * Math.cos(w * t) + b * Math.sin(w * t);
      const err = y - yHat;
      rss += wt * err * err;
    }
  }

  const r2 = Math.max(0, Math.min(1, 1 - rss / tss));
  return {
    c,
    a,
    b,
    amp: Math.hypot(a, b),
    phiRad: Math.atan2(-b, a),
    r2,
  };
}

function estimateZeroCrossingFreq(
  segments: ValidSegment[],
  pickVal: (seg: ValidSegment, idx: number) => number
): number | null {
  let sumW = 0;
  let sumWY = 0;
  for (const seg of segments) {
    for (let k = 0; k < seg.times.length; k++) {
      const wt = seg.weights[k];
      if (wt > 0) {
        sumW += wt;
        sumWY += wt * pickVal(seg, k);
      }
    }
  }
  if (!(sumW > 0)) return null;
  const meanY = sumWY / sumW;

  const periods: number[] = [];
  for (const seg of segments) {
    let lastRisingT: number | null = null;
    for (let k = 1; k < seg.times.length; k++) {
      const y0 = pickVal(seg, k - 1) - meanY;
      const y1 = pickVal(seg, k) - meanY;
      if (y0 <= 0 && y1 > 0) {
        const frac = y1 - y0 > 1e-18 ? -y0 / (y1 - y0) : 0.5;
        const tc = seg.times[k - 1] + frac * (seg.times[k] - seg.times[k - 1]);
        if (lastRisingT !== null && tc - lastRisingT > 1e-12) {
          periods.push(tc - lastRisingT);
        }
        lastRisingT = tc;
      }
    }
  }
  if (periods.length === 0) return null;
  periods.sort((a, b) => a - b);
  const medP = periods[Math.floor(periods.length / 2)];
  return medP > 0 ? 1 / medP : null;
}

function detectFundamentalFreqWeighted(
  segments: ValidSegment[],
  pickVal: (seg: ValidSegment, idx: number) => number,
  activeTimeSpanSec: number,
  medianDtSec: number
): { freqHz: number; fit: SinusoidFitResult } | null {
  if (!(activeTimeSpanSec > 0) || !(medianDtSec > 0)) return null;

  const fMin = Math.max(1e-3, 0.35 / activeTimeSpanSec);
  const fNyq = 0.45 / medianDtSec;
  if (!(fNyq > fMin)) return null;

  const fZc = estimateZeroCrossingFreq(segments, pickVal);
  const candidateFreqs: number[] = [];

  // Coarse log grid over [fMin, min(fNyq, fMin * 250)] to catch true fundamental even under distortion
  const fCap = Math.min(fNyq, Math.max(fMin * 250, fZc ? fZc * 2.5 : fMin * 250));
  const nLog = 70;
  for (let i = 0; i <= nLog; i++) {
    const f = fMin * Math.pow(fCap / fMin, i / nLog);
    candidateFreqs.push(f);
  }
  // Fine local linear sweep around zero-crossing fundamental & half-harmonic
  if (fZc && fZc >= fMin && fZc <= fNyq) {
    for (let mult = 0.45; mult <= 1.65; mult += 0.05) {
      const f = fZc * mult;
      if (f >= fMin && f <= fNyq) candidateFreqs.push(f);
    }
  }

  let bestF = candidateFreqs[0];
  let bestFit: SinusoidFitResult | null = null;
  let bestScore = -1;

  for (const f of candidateFreqs) {
    const fit = fitWeightedSinusoidAtFreq(segments, pickVal, f);
    if (fit && fit.r2 > bestScore) {
      bestScore = fit.r2;
      bestF = f;
      bestFit = fit;
    }
  }
  if (!bestFit) return null;

  // Golden-section refinement around peak (±12%)
  let lo = Math.max(fMin, bestF * 0.88);
  let hi = Math.min(fNyq, bestF * 1.12);
  const phi = 0.6180339887498949;
  let x1 = hi - phi * (hi - lo);
  let x2 = lo + phi * (hi - lo);
  let f1 = fitWeightedSinusoidAtFreq(segments, pickVal, x1)?.r2 ?? -1;
  let f2 = fitWeightedSinusoidAtFreq(segments, pickVal, x2)?.r2 ?? -1;
  for (let iter = 0; iter < 20; iter++) {
    if (f1 > f2) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - phi * (hi - lo);
      f1 = fitWeightedSinusoidAtFreq(segments, pickVal, x1)?.r2 ?? -1;
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + phi * (hi - lo);
      f2 = fitWeightedSinusoidAtFreq(segments, pickVal, x2)?.r2 ?? -1;
    }
  }
  const fOpt = 0.5 * (lo + hi);
  const optFit = fitWeightedSinusoidAtFreq(segments, pickVal, fOpt);
  if (optFit && optFit.r2 >= bestFit.r2) {
    return { freqHz: fOpt, fit: optFit };
  }
  return { freqHz: bestF, fit: bestFit };
}

export function computeXYAlignedTrajectory(
  xCh: WaveformChannel,
  yCh: WaveformChannel,
  tStart?: number,
  tEnd?: number
): XYAlignedResult {
  const xCheck = validateChannelIntegrity(xCh, 2);
  if (!xCheck.valid) {
    return makeInvalidXY('INVALID', xCheck.invalidReason || 'X 通道时间轴或数组无效。');
  }
  const yCheck = validateChannelIntegrity(yCh, 2);
  if (!yCheck.valid) {
    return makeInvalidXY('INVALID', yCheck.invalidReason || 'Y 通道时间轴或数组无效。');
  }

  const synced = alignChannelsToCommonTimebase([xCh, yCh], tStart, tEnd, {
    allowPartialNaNs: true,
  });
  if (!synced.valid || synced.time.length < 2) {
    return makeInvalidXY(
      'INSUFFICIENT_DATA',
      synced.invalidReason || 'XY 通道在所选窗口内无有效公共时间重叠。'
    );
  }

  const xValues = synced.values[0];
  const yValues = synced.values[1];
  const totalPts = synced.time.length;

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let validCount = 0;
  let invalidCount = 0;
  let firstValidIdx = -1;
  let lastValidIdx = -1;

  for (let i = 0; i < totalPts; i++) {
    const xv = xValues[i];
    const yv = yValues[i];
    if (!Number.isFinite(xv) || !Number.isFinite(yv)) {
      invalidCount++;
      continue;
    }
    if (firstValidIdx < 0) firstValidIdx = i;
    lastValidIdx = i;
    if (xv < xMin) xMin = xv;
    if (xv > xMax) xMax = xv;
    if (yv < yMin) yMin = yv;
    if (yv > yMax) yMax = yv;
    validCount++;
  }

  const coveragePct = totalPts > 0 ? (validCount / totalPts) * 100 : 0;
  if (validCount < 2 || !Number.isFinite(xMin) || !Number.isFinite(yMin)) {
    return makeInvalidXY('INSUFFICIENT_DATA', '公共时间轴对齐后有效配对样本数不足 (< 2)。');
  }

  const tb = inspectTimebase(synced.time, 0, totalPts - 1, DEFAULT_SAMPLING_GAP_FACTOR);
  const segments = extractContinuousValidSegments(synced.time, xValues, yValues, tb.gapThresholdSec);

  let totalWeight = 0;
  for (const seg of segments) {
    for (const w of seg.weights) totalWeight += w;
  }
  // Fallback weight = 1 per valid sample only if all segments are isolated singletons
  const useUniformFallbackWeights = !(totalWeight > 0);
  if (useUniformFallbackWeights) {
    for (const seg of segments) {
      for (let k = 0; k < seg.weights.length; k++) seg.weights[k] = 1;
      totalWeight += seg.weights.length;
    }
  }

  const xSpan = xMax - xMin;
  const ySpan = yMax - yMin;
  const maxSpan = Math.max(xSpan, ySpan);

  // ===== XY-01: Time-Weighted Least-Squares Circle Fit =====
  let circleFitQualityPct: number | null = null;
  let circleFitErrorPct: number | null = null;
  let circleCenter: { x: number; y: number } | null = null;
  let circleRadiusMean: number | null = null;
  let angularCoveragePct: number | null = null;
  let closureRatio: number | null = null;
  let trajectoryShapeHint: XYTrajectoryShapeHint = 'insufficient';
  let circleFitNote: string | null = null;

  if (validCount >= 8 && maxSpan > 1e-12) {
    // Weighted mean & covariance eigenvalues to reject degenerate 1D straight lines before circle fit
    let wSum = 0;
    let wx = 0;
    let wy = 0;
    for (const seg of segments) {
      for (let k = 0; k < seg.xs.length; k++) {
        const w = seg.weights[k];
        if (!(w > 0)) continue;
        wSum += w;
        wx += w * seg.xs[k];
        wy += w * seg.ys[k];
      }
    }
    const mx = wx / wSum;
    const my = wy / wSum;

    let cxx = 0;
    let cyy = 0;
    let cxy = 0;
    for (const seg of segments) {
      for (let k = 0; k < seg.xs.length; k++) {
        const w = seg.weights[k];
        if (!(w > 0)) continue;
        const dx = (seg.xs[k] - mx) / maxSpan;
        const dy = (seg.ys[k] - my) / maxSpan;
        cxx += w * dx * dx;
        cyy += w * dy * dy;
        cxy += w * dx * dy;
      }
    }
    cxx /= wSum;
    cyy /= wSum;
    cxy /= wSum;
    const tr = cxx + cyy;
    const detCov = cxx * cyy - cxy * cxy;
    const disc = Math.max(0, 0.25 * tr * tr - detCov);
    const eigMax = 0.5 * tr + Math.sqrt(disc);
    const eigMin = Math.max(0, 0.5 * tr - Math.sqrt(disc));
    const axisRatio = eigMax > 1e-18 ? Math.sqrt(eigMin / eigMax) : 0;

    if (axisRatio < 0.035 || xSpan <= 1e-12 || ySpan <= 1e-12) {
      trajectoryShapeHint = 'line';
      circleFitQualityPct = 0;
      circleFitErrorPct = 100;
      circleFitNote = '轨迹近似退化为一维直线 (短轴/长轴 < 3.5%)，Circle Fit Quality 置为 0%。';
    } else {
      // Normalized Kasa weighted least-squares circle fit in centered coordinates (u, v)
      let suu = 0;
      let svv = 0;
      let suv = 0;
      let su3 = 0;
      let sv3 = 0;
      for (const seg of segments) {
        for (let k = 0; k < seg.xs.length; k++) {
          const w = seg.weights[k];
          if (!(w > 0)) continue;
          const u = (seg.xs[k] - mx) / maxSpan;
          const v = (seg.ys[k] - my) / maxSpan;
          const r2 = u * u + v * v;
          suu += w * u * u;
          svv += w * v * v;
          suv += w * u * v;
          su3 += w * u * r2;
          sv3 += w * v * r2;
        }
      }
      const detLs = suu * svv - suv * suv;
      if (detLs <= 1e-20 * (suu + svv) * (suu + svv)) {
        trajectoryShapeHint = 'line';
        circleFitQualityPct = 0;
        circleFitErrorPct = 100;
        circleFitNote = '最小二乘圆拟合方程奇异，轨迹为直线或点集，无法构成有效圆轨迹。';
      } else {
        const aNorm = (svv * su3 - suv * sv3) / detLs;
        const bNorm = (suu * sv3 - suv * su3) / detLs;
        const uc = 0.5 * aNorm;
        const vc = 0.5 * bNorm;
        const xc = mx + uc * maxSpan;
        const yc = my + vc * maxSpan;
        circleCenter = { x: xc, y: yc };

        let sumWR = 0;
        let minR = Infinity;
        for (const seg of segments) {
          for (let k = 0; k < seg.xs.length; k++) {
            const w = seg.weights[k];
            if (!(w > 0)) continue;
            const r = Math.hypot(seg.xs[k] - xc, seg.ys[k] - yc);
            sumWR += w * r;
            if (r < minR) minR = r;
          }
        }
        const rMean = sumWR / wSum;
        circleRadiusMean = rMean;

        if (rMean <= 1e-12) {
          trajectoryShapeHint = 'insufficient';
          circleFitNote = '拟合平均半径接近零，无法评估圆形拟合度。';
        } else {
          let sumWErr2 = 0;
          const nBins = 36;
          const bins = new Uint8Array(nBins);
          for (const seg of segments) {
            for (let k = 0; k < seg.xs.length; k++) {
              const w = seg.weights[k];
              const dx = seg.xs[k] - xc;
              const dy = seg.ys[k] - yc;
              const r = Math.hypot(dx, dy);
              if (w > 0) {
                const dr = r - rMean;
                sumWErr2 += w * dr * dr;
              }
              if (r > 0.1 * rMean) {
                let ang = Math.atan2(dy, dx);
                if (ang < 0) ang += 2 * Math.PI;
                const bin = Math.min(nBins - 1, Math.floor((ang / (2 * Math.PI)) * nBins));
                bins[bin] = 1;
              }
            }
          }
          const coveredBins = bins.reduce((acc, v) => acc + v, 0);
          angularCoveragePct = (coveredBins / nBins) * 100;

          const errR = Math.sqrt(sumWErr2 / wSum);
          const errPct = (errR / rMean) * 100;
          const qualPct = 100 * Math.max(0, 1 - errR / rMean);

          const endpointGap =
            firstValidIdx >= 0 && lastValidIdx > firstValidIdx
              ? Math.hypot(xValues[lastValidIdx] - xValues[firstValidIdx], yValues[lastValidIdx] - yValues[firstValidIdx])
              : 0;
          closureRatio = Math.max(0, 1 - Math.min(1, endpointGap / (2 * rMean)));

          circleFitErrorPct = errPct;
          if (angularCoveragePct < 70) {
            trajectoryShapeHint = 'open_arc';
            circleFitQualityPct = null;
            circleFitNote = `角度覆盖仅 ${angularCoveragePct.toFixed(0)}% (<70%)，属于未闭合开弧，禁止输出高圆度评分。`;
          } else {
            circleFitQualityPct = qualPct;
            if (minR < 0.25 * rMean && errPct > 18) {
              trajectoryShapeHint = 'figure_8_or_lissajous';
              circleFitNote = `轨迹穿越拟合圆心 (E_r/R=${errPct.toFixed(1)}%)，符合 8 字形/交叉李萨如特征，非圆形轨迹。`;
            } else if (errPct <= 5 && angularCoveragePct >= 85) {
              trajectoryShapeHint = 'circle';
            } else if (errPct <= 25) {
              trajectoryShapeHint = 'ellipse';
            } else {
              trajectoryShapeHint = 'irregular';
            }
          }
        }
      }
    }
  } else {
    circleFitNote = '有效样本不足 (< 8 点) 或通道峰峰值接近零，无法进行最小二乘圆拟合。';
  }

  // ===== XY-02: Time-Weighted Segmented Sinusoidal Phase Estimation =====
  let lissajousPhaseDeg: number | null = null;
  let phaseKind: XYPhaseKind = 'insufficient';
  let fundamentalFreqXHz: number | null = null;
  let fundamentalFreqYHz: number | null = null;
  let sinusoidalR2X: number | null = null;
  let sinusoidalR2Y: number | null = null;
  let isNonSinusoidal = false;
  let phaseNote: string | null = null;

  if (!useUniformFallbackWeights && xSpan > 1e-12 && ySpan > 1e-12 && validCount >= 6) {
    const activeTimeSpanSec = totalWeight;
    const medianDtSec = tb.medianDtSec > 0 ? tb.medianDtSec : activeTimeSpanSec / Math.max(1, validCount - 1);
    const estX = detectFundamentalFreqWeighted(segments, (seg, idx) => seg.xs[idx], activeTimeSpanSec, medianDtSec);
    const estY = detectFundamentalFreqWeighted(segments, (seg, idx) => seg.ys[idx], activeTimeSpanSec, medianDtSec);

    if (estX && estY) {
      fundamentalFreqXHz = estX.freqHz;
      fundamentalFreqYHz = estY.freqHz;
      sinusoidalR2X = estX.fit.r2;
      sinusoidalR2Y = estY.fit.r2;

      const freqDiffRatio = Math.abs(estX.freqHz - estY.freqHz) / Math.max(estX.freqHz, estY.freqHz);
      if (freqDiffRatio > 0.08) {
        phaseKind = 'frequency_mismatch';
        lissajousPhaseDeg = null;
        phaseNote = `X 基频 (${estX.freqHz.toFixed(2)} Hz) 与 Y 基频 (${estY.freqHz.toFixed(2)} Hz) 不一致，无法定义单一固定相位差 ΔΦ。`;
      } else if (estX.fit.r2 < 0.25 || estY.fit.r2 < 0.25) {
        phaseKind = 'insufficient';
        lissajousPhaseDeg = null;
        phaseNote = '信号周期基波分量过弱 (R² < 0.25)，已拒绝输出相位差。';
      } else {
        // Fit both X and Y at the weighted consensus frequency so phase comparison shares exact omega
        const fCommon =
          (estX.freqHz * estX.fit.r2 + estY.freqHz * estY.fit.r2) / (estX.fit.r2 + estY.fit.r2);
        const fitXCommon = fitWeightedSinusoidAtFreq(segments, (seg, idx) => seg.xs[idx], fCommon);
        const fitYCommon = fitWeightedSinusoidAtFreq(segments, (seg, idx) => seg.ys[idx], fCommon);

        if (fitXCommon && fitYCommon && fitXCommon.amp > 1e-12 && fitYCommon.amp > 1e-12) {
          sinusoidalR2X = fitXCommon.r2;
          sinusoidalR2Y = fitYCommon.r2;
          const phiXDeg = (fitXCommon.phiRad * 180) / Math.PI;
          const phiYDeg = (fitYCommon.phiRad * 180) / Math.PI;
          // Y lags X -> CCW -> positive ΔΦ = wrap(phi_X - phi_Y)
          lissajousPhaseDeg = wrapDeg180(phiXDeg - phiYDeg);
          isNonSinusoidal = fitXCommon.r2 < 0.85 || fitYCommon.r2 < 0.85;
          if (isNonSinusoidal) {
            phaseKind = 'fundamental_non_sinusoidal';
            phaseNote = `非正弦波形 (R²_x=${(fitXCommon.r2 * 100).toFixed(0)}%, R²_y=${(fitYCommon.r2 * 100).toFixed(0)}%)：当前 ΔΦ 仅表示时间加权基波等效相位差。`;
          } else {
            phaseKind = 'fundamental_ls_time_weighted';
          }
        }
      }
    }
  } else {
    phaseNote = '有效连续时段或信号幅值不足，无法估算基波相位差。';
  }

  return {
    metrics: {
      valid: true,
      status: 'OK',
      invalidReason: null,
      sampleCount: validCount,
      invalidCount,
      coveragePct,
      xMin,
      xMax,
      yMin,
      yMax,
      circularityPct: circleFitQualityPct,
      circleFitQualityPct,
      circleFitErrorPct,
      circleCenter,
      circleRadiusMean,
      angularCoveragePct,
      closureRatio,
      trajectoryShapeHint,
      circleFitNote,
      lissajousPhaseDeg,
      phaseKind,
      fundamentalFreqXHz,
      fundamentalFreqYHz,
      sinusoidalR2X,
      sinusoidalR2Y,
      isNonSinusoidal,
      phaseNote,
    },
    time: synced.time,
    xValues,
    yValues,
  };
}

export function computeXYMetrics(
  xCh: WaveformChannel,
  yCh: WaveformChannel,
  iStart: number,
  iEnd: number
): XYMetrics {
  const xCheck = validateChannelIntegrity(xCh, 2);
  if (!xCheck.valid) {
    return makeInvalidXY('INVALID', xCheck.invalidReason || 'X 通道时间轴或数组无效。').metrics;
  }
  const yCheck = validateChannelIntegrity(yCh, 2);
  if (!yCheck.valid) {
    return makeInvalidXY('INVALID', yCheck.invalidReason || 'Y 通道时间轴或数组无效。').metrics;
  }

  const nx = xCh.t.length;
  const fullRange = iStart <= 0 && iEnd >= Math.min(xCh.t.length, yCh.t.length);
  let tStart: number | undefined;
  let tEnd: number | undefined;
  if (!fullRange) {
    const s = Math.max(0, Math.min(nx - 1, iStart));
    const e = Math.max(s + 1, Math.min(nx, iEnd));
    tStart = xCh.t[s];
    tEnd = xCh.t[e - 1];
    if (!(tEnd > tStart)) {
      return makeInvalidXY('INSUFFICIENT_DATA', '所选 XY 索引范围没有有效时间跨度。').metrics;
    }
  }

  return computeXYAlignedTrajectory(xCh, yCh, tStart, tEnd).metrics;
}

