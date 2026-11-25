/**
 * Waveform Viewer Pro - P1 MOSFET Double Pulse Test (DPT) Synchronized Analyzer
 * Evaluates synchronized (Vgs, Vds, Ids) channels to extract:
 * - Turn-Off: E_off (uJ), dv/dt_off, di/dt_off, V_ds_peak, Overshoot (V & %), f_ring_off (MHz)
 * - Turn-On: E_on (uJ), dv/dt_on, di/dt_on, Miller plateau (V_gp, t_miller ns),
 *            Reverse recovery (I_rr_peak A, Q_rr nC, E_rec uJ), f_ring_on (MHz)
 */

import { WaveformChannel } from '../types/models';
import {
  parseSiUnitScale,
  type CossCurvePoint,
  type NonlinearEossCurve,
  type EossCurveEvalResult,
  integrateQossToEossCurve,
  integrateCossToEossCurve,
  evaluatePchipMonotone,
  evaluateNonlinearEossUj,
} from './thermalEngine';

export type { CossCurvePoint, NonlinearEossCurve, EossCurveEvalResult };
export {
  integrateQossToEossCurve,
  integrateCossToEossCurve,
  evaluatePchipMonotone,
  evaluateNonlinearEossUj,
};
import {
  alignChannelsToCommonTimebase,
  DEFAULT_SAMPLING_GAP_FACTOR,
  inspectTimebase,
  sampleSeriesAtTime,
} from './timeSync';
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
  rgOnOhm?: number;
  rgOffOhm?: number;
  eOnUj: number;
  eOffUj: number;
  qRrNc: number;
  eOnSansQrrUj?: number;
}

export type DptLutStatus =
  | 'VALID'
  | 'INSUFFICIENT_LUT'
  | 'OUT_OF_RANGE'
  | 'INVALID_DATA'
  | 'NON_CONVERGED';

export type DptParameterProvenance = 'measured' | 'assumed';

export type DptAxisName = 'Vbus' | 'Iload' | 'Tj' | 'Rg';

export interface DptOperatingCondition {
  vBusV: number;
  iLoadA: number;
  tjC?: number;
  rgOhm?: number;
  rgOnOhm?: number;
  rgOffOhm?: number;
  tjProvenance?: DptParameterProvenance;
  rgProvenance?: DptParameterProvenance;
}

export interface DptLutInterpolationResult {
  status: DptLutStatus;
  method:
    | '4d_multilinear_grid'
    | '4d_simplex_barycentric'
    | 'reduced_dim_interpolated'
    | 'single_point_scaled'
    | 'invalid';
  eOnUj: number;
  eOffUj: number;
  eSwTotalUj: number;
  qRrNc: number;
  eOnSansQrrUj: number;
  extrapolated: boolean;
  vRange: [number, number];
  iRange: [number, number];
  tjRange: [number, number];
  rgRange: [number, number];
  activeDimensions: DptAxisName[];
  collapsedDimensions: DptAxisName[];
  outOfRangeAxes: DptAxisName[];
  tjProvenance: DptParameterProvenance;
  rgProvenance: DptParameterProvenance;
  warnings: string[];
}

function solveSmallLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  if (n === 0) return [];
  const mat = A.map((row) => [...row]);
  const rhs = [...b];
  for (let col = 0; col < n; col++) {
    let piv = col;
    let maxAbs = Math.abs(mat[col][col]);
    for (let r = col + 1; r < n; r++) {
      const av = Math.abs(mat[r][col]);
      if (av > maxAbs) {
        maxAbs = av;
        piv = r;
      }
    }
    if (!Number.isFinite(maxAbs) || maxAbs < 1e-12) return null;
    if (piv !== col) {
      const tmp = mat[col];
      mat[col] = mat[piv];
      mat[piv] = tmp;
      const tb = rhs[col];
      rhs[col] = rhs[piv];
      rhs[piv] = tb;
    }
    const diag = mat[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = mat[r][col] / diag;
      if (f === 0) continue;
      for (let c = col; c < n; c++) mat[r][c] -= f * mat[col][c];
      rhs[r] -= f * rhs[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = rhs[r];
    for (let c = r + 1; c < n; c++) s -= mat[r][c] * x[c];
    x[r] = s / mat[r][r];
    if (!Number.isFinite(x[r])) return null;
  }
  return x;
}

interface Clean4DPoint {
  coords: [number, number, number, number]; // [vBusV, iLoadA, tjC, rgVal]
  eOnUj: number;
  eOffUj: number;
  qRrNc: number;
  eOnSansQrrUj: number;
}

function uniqueSortedLevels(vals: number[], eps: number): number[] {
  const sorted = [...vals].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length === 0 || Math.abs(v - out[out.length - 1]) > eps) {
      out.push(v);
    }
  }
  return out;
}

function evaluate4DScalarChannel(
  pts: Clean4DPoint[],
  target: [number, number, number, number],
  activeIdx: number[],
  axisRanges: Array<[number, number]>,
  valueGetter: (p: Clean4DPoint) => number
): { value: number; method: 'grid' | 'simplex' | 'idw_fallback'; enclosed: boolean } {
  const d = activeIdx.length;
  if (d === 0) {
    let sum = 0;
    for (const p of pts) sum += valueGetter(p);
    return { value: sum / Math.max(1, pts.length), method: 'grid', enclosed: true };
  }

  // Normalize active coordinates to [0, 1] over LUT bounding box
  const scaleCoord = (val: number, ax: number) => {
    const [mn, mx] = axisRanges[ax];
    const span = Math.max(1e-9, mx - mn);
    return (val - mn) / span;
  };
  const qNorm = activeIdx.map((ax) => scaleCoord(target[ax], ax));
  const ptsNorm = pts.map((p) => activeIdx.map((ax) => scaleCoord(p.coords[ax], ax)));

  // 1) Try exact d-dimensional multilinear hypercube grid interpolation
  const levelsPerAxis = activeIdx.map((ax) => {
    const [mn, mx] = axisRanges[ax];
    const eps = Math.max(1e-6, (mx - mn) * 1e-4);
    return uniqueSortedLevels(
      pts.map((p) => p.coords[ax]),
      eps
    );
  });

  const bracketPerAxis = levelsPerAxis.map((lvls, k) => {
    const q = target[activeIdx[k]];
    const clampedQ = Math.max(lvls[0], Math.min(lvls[lvls.length - 1], q));
    let hi = 1;
    while (hi < lvls.length - 1 && lvls[hi] < clampedQ) hi++;
    const lo = Math.max(0, hi - 1);
    const v0 = lvls[lo];
    const v1 = lvls[hi];
    const frac = Math.abs(v1 - v0) > 1e-12 ? (clampedQ - v0) / (v1 - v0) : 0;
    return { v0, v1, frac: Math.max(0, Math.min(1, frac)), tol: Math.max(1e-6, (axisRanges[activeIdx[k]][1] - axisRanges[activeIdx[k]][0]) * 1e-3) };
  });

  const cornerCount = 1 << d;
  const cornerVals: number[] = [];
  let gridComplete = true;
  for (let mask = 0; mask < cornerCount; mask++) {
    let foundSum = 0;
    let foundCnt = 0;
    for (const p of pts) {
      let match = true;
      for (let k = 0; k < d; k++) {
        const b = bracketPerAxis[k];
        const expected = (mask & (1 << k)) !== 0 ? b.v1 : b.v0;
        if (Math.abs(p.coords[activeIdx[k]] - expected) > b.tol) {
          match = false;
          break;
        }
      }
      if (match) {
        foundSum += valueGetter(p);
        foundCnt++;
      }
    }
    if (foundCnt === 0) {
      gridComplete = false;
      break;
    }
    cornerVals.push(foundSum / foundCnt);
  }

  if (gridComplete) {
    let val = 0;
    for (let mask = 0; mask < cornerCount; mask++) {
      let w = 1;
      for (let k = 0; k < d; k++) {
        const f = bracketPerAxis[k].frac;
        w *= (mask & (1 << k)) !== 0 ? f : 1 - f;
      }
      val += w * cornerVals[mask];
    }
    return { value: Math.max(0, val), method: 'grid', enclosed: true };
  }

  // Check exact / near-exact point hit
  const distSqList = pts.map((p, idx) => {
    let d2 = 0;
    for (let k = 0; k < d; k++) {
      const diff = ptsNorm[idx][k] - qNorm[k];
      d2 += diff * diff;
    }
    return { idx, d2, val: valueGetter(p) };
  });
  distSqList.sort((a, b) => a.d2 - b.d2);
  if (distSqList[0].d2 < 1e-12) {
    return { value: Math.max(0, distSqList[0].val), method: 'simplex', enclosed: true };
  }

  // 2) Try simplex barycentric interpolation over enclosing non-degenerate (m+1)-simplex
  // Also handles lower-dimensional affine subspaces (e.g. 2 points in 2D Vbus-Iload diagonal)
  const poolSize = Math.min(pts.length, Math.max(8, 2 * d + 4));
  const pool = distSqList.slice(0, poolSize).map((item) => item.idx);

  const trySimplexDim = (subDim: number): { value: number; enclosed: boolean } | null => {
    const need = subDim + 1;
    if (pool.length < need) return null;
    const picked: number[] = [];
    const maxSearch = Math.min(pool.length, 10);

    const searchCombos = (start: number): { value: number; enclosed: boolean } | null => {
      if (picked.length === need) {
        if (subDim === d) {
          const mat: number[][] = Array.from({ length: need }, (_, r) =>
            picked.map((pIdx) => (r === 0 ? 1 : ptsNorm[pIdx][r - 1]))
          );
          const rhs = [1, ...qNorm];
          const lambdas = solveSmallLinearSystem(mat, rhs);
          if (lambdas && lambdas.every((l) => l >= -1e-5 && l <= 1 + 1e-5)) {
            let v = 0;
            for (let j = 0; j < need; j++) v += lambdas[j] * valueGetter(pts[picked[j]]);
            return { value: Math.max(0, v), enclosed: true };
          }
        } else if (subDim === 1 && need === 2) {
          // 1D line segment projection between two nearest distinct points
          const a = ptsNorm[picked[0]];
          const b = ptsNorm[picked[1]];
          let ab2 = 0;
          let aqAb = 0;
          for (let k = 0; k < d; k++) {
            const abk = b[k] - a[k];
            ab2 += abk * abk;
            aqAb += (qNorm[k] - a[k]) * abk;
          }
          if (ab2 > 1e-10) {
            const t = aqAb / ab2;
            let perp2 = 0;
            for (let k = 0; k < d; k++) {
              const proj = a[k] + t * (b[k] - a[k]);
              const diff = qNorm[k] - proj;
              perp2 += diff * diff;
            }
            if (perp2 < 1e-6 && t >= -1e-5 && t <= 1 + 1e-5) {
              const tc = Math.max(0, Math.min(1, t));
              const v = (1 - tc) * valueGetter(pts[picked[0]]) + tc * valueGetter(pts[picked[1]]);
              return { value: Math.max(0, v), enclosed: true };
            }
          }
        }
        return null;
      }
      for (let i = start; i <= maxSearch - (need - picked.length); i++) {
        picked.push(pool[i]);
        const hit = searchCombos(i + 1);
        if (hit) return hit;
        picked.pop();
      }
      return null;
    };

    return searchCombos(0);
  };

  const fullSimplex = trySimplexDim(d);
  if (fullSimplex) {
    return { value: fullSimplex.value, method: 'simplex', enclosed: true };
  }
  if (d >= 2) {
    const colinearSeg = trySimplexDim(1);
    if (colinearSeg) {
      return { value: colinearSeg.value, method: 'simplex', enclosed: true };
    }
  }

  // 3) Bounded IDW fallback across k nearest neighbors for out-of-hull / sparse query
  const kUse = Math.min(distSqList.length, Math.max(2, d + 2));
  let wSum = 0;
  let acc = 0;
  for (let i = 0; i < kUse; i++) {
    const w = 1 / (distSqList[i].d2 + 1e-6);
    wSum += w;
    acc += w * distSqList[i].val;
  }
  return {
    value: Math.max(0, acc / Math.max(1e-12, wSum)),
    method: 'idw_fallback',
    enclosed: false,
  };
}

/**
 * True 4D DPT switching loss interpolation across (Vbus, Iload, Tj, Rg).
 * - Uses exact d-dimensional multilinear interpolation when enclosing tensor-grid hypercube exists.
 * - Uses affine/simplex barycentric interpolation for scattered irregular LUT points.
 * - Evaluates Turn-On (Eon, Qrr) with rgOnOhm and Turn-Off (Eoff) with rgOffOhm separately.
 * - Reports missing/collapsed dimensions, out-of-range extrapolation, and parameter provenance explicitly.
 */
export function interpolateDptSwitchingLoss(
  lut: DptOperatingPoint[],
  vBusOrCond: number | DptOperatingCondition,
  iLoadTargetA?: number
): DptLutInterpolationResult | null {
  if (!lut || lut.length === 0) return null;

  const cond: DptOperatingCondition =
    typeof vBusOrCond === 'object' && vBusOrCond !== null
      ? vBusOrCond
      : {
          vBusV: vBusOrCond,
          iLoadA: iLoadTargetA ?? 0,
          tjProvenance: 'assumed',
          rgProvenance: 'assumed',
        };

  const vSafe = Math.max(0, Number.isFinite(cond.vBusV) ? cond.vBusV : 0);
  const iSafe = Math.max(0, Number.isFinite(cond.iLoadA) ? cond.iLoadA : 0);
  const tjKnown = cond.tjC !== undefined && Number.isFinite(cond.tjC);
  const rgOnKnown = (cond.rgOnOhm ?? cond.rgOhm) !== undefined && Number.isFinite(cond.rgOnOhm ?? cond.rgOhm);
  const rgOffKnown = (cond.rgOffOhm ?? cond.rgOhm) !== undefined && Number.isFinite(cond.rgOffOhm ?? cond.rgOhm);
  const tjProvenance: DptParameterProvenance = cond.tjProvenance ?? (tjKnown ? 'measured' : 'assumed');
  const rgProvenance: DptParameterProvenance = cond.rgProvenance ?? (rgOnKnown || rgOffKnown ? 'measured' : 'assumed');

  for (const pt of lut) {
    if (
      !Number.isFinite(pt.vBusV) ||
      pt.vBusV <= 0 ||
      !Number.isFinite(pt.iLoadA) ||
      pt.iLoadA < 0 ||
      !Number.isFinite(pt.tjC) ||
      !Number.isFinite(pt.rgOhm) ||
      pt.rgOhm < 0 ||
      !Number.isFinite(pt.eOnUj) ||
      pt.eOnUj < 0 ||
      !Number.isFinite(pt.eOffUj) ||
      pt.eOffUj < 0 ||
      !Number.isFinite(pt.qRrNc) ||
      pt.qRrNc < 0
    ) {
      return {
        status: 'INVALID_DATA',
        method: 'invalid',
        eOnUj: Number.NaN,
        eOffUj: Number.NaN,
        eSwTotalUj: Number.NaN,
        qRrNc: Number.NaN,
        eOnSansQrrUj: Number.NaN,
        extrapolated: true,
        vRange: [0, 0],
        iRange: [0, 0],
        tjRange: [0, 0],
        rgRange: [0, 0],
        activeDimensions: [],
        collapsedDimensions: ['Vbus', 'Iload', 'Tj', 'Rg'],
        outOfRangeAxes: [],
        tjProvenance,
        rgProvenance,
        warnings: ['DPT LUT 包含非法负值、非正 Vbus 或 NaN/Inf 字段，已拒绝插值。'],
      };
    }
  }

  let vMin = Infinity;
  let vMax = -Infinity;
  let iMin = Infinity;
  let iMax = -Infinity;
  let tjMin = Infinity;
  let tjMax = -Infinity;
  let rgMin = Infinity;
  let rgMax = -Infinity;
  for (const pt of lut) {
    const rgEff = pt.rgOnOhm ?? pt.rgOffOhm ?? pt.rgOhm;
    if (pt.vBusV < vMin) vMin = pt.vBusV;
    if (pt.vBusV > vMax) vMax = pt.vBusV;
    if (pt.iLoadA < iMin) iMin = pt.iLoadA;
    if (pt.iLoadA > iMax) iMax = pt.iLoadA;
    if (pt.tjC < tjMin) tjMin = pt.tjC;
    if (pt.tjC > tjMax) tjMax = pt.tjC;
    if (rgEff < rgMin) rgMin = rgEff;
    if (rgEff > rgMax) rgMax = rgEff;
  }

  const tjTarget = tjKnown ? cond.tjC! : 0.5 * (tjMin + tjMax);
  const rgDefaultMid = 0.5 * (rgMin + rgMax);
  const rgOnTarget = rgOnKnown ? Math.max(0, (cond.rgOnOhm ?? cond.rgOhm)!) : rgDefaultMid;
  const rgOffTarget = rgOffKnown ? Math.max(0, (cond.rgOffOhm ?? cond.rgOhm)!) : rgDefaultMid;

  const axisNames: DptAxisName[] = ['Vbus', 'Iload', 'Tj', 'Rg'];
  const axisRanges: Array<[number, number]> = [
    [vMin, vMax],
    [iMin, iMax],
    [tjMin, tjMax],
    [rgMin, rgMax],
  ];
  const activeIdx: number[] = [];
  const collapsedDimensions: DptAxisName[] = [];
  axisRanges.forEach(([mn, mx], idx) => {
    const tol = idx === 2 ? 0.5 : idx === 3 ? 0.05 : 1e-4;
    if (mx - mn > tol) activeIdx.push(idx);
    else collapsedDimensions.push(axisNames[idx]);
  });
  const activeDimensions = activeIdx.map((idx) => axisNames[idx]);

  const outOfRangeAxes: DptAxisName[] = [];
  if (vSafe < vMin - 1e-6 || vSafe > vMax + 1e-6) outOfRangeAxes.push('Vbus');
  if (iSafe < iMin - 1e-6 || iSafe > iMax + 1e-6) outOfRangeAxes.push('Iload');
  if (tjTarget < tjMin - 0.1 || tjTarget > tjMax + 0.1) outOfRangeAxes.push('Tj');
  if (
    rgOnTarget < rgMin - 1e-4 ||
    rgOnTarget > rgMax + 1e-4 ||
    rgOffTarget < rgMin - 1e-4 ||
    rgOffTarget > rgMax + 1e-4
  ) {
    outOfRangeAxes.push('Rg');
  }

  const warnings: string[] = [];
  if (collapsedDimensions.length > 0) {
    warnings.push(
      `DPT LUT 缺少 ${collapsedDimensions.join(' / ')} 维度的多点变化（已退化为常数轴），无法反映这些维度变化引起的开关损耗漂移。`
    );
  }
  if (tjProvenance === 'assumed' && activeDimensions.includes('Tj')) {
    warnings.push('DPT LUT 查询中的结温 Tj 未由闭环求解器或传感器实测提供，当前按默认假设中值代入。');
  }
  if (rgProvenance === 'assumed' && activeDimensions.includes('Rg')) {
    warnings.push('DPT LUT 查询中的门极电阻 Rg 未显式输入，当前按 LUT 范围默认假设中值代入。');
  }

  if (lut.length === 1) {
    const p = lut[0];
    const vRatio = vSafe / Math.max(1e-3, p.vBusV);
    const iRatio = iSafe / Math.max(1e-3, p.iLoadA);
    const eOnUj = p.eOnUj * vRatio * iRatio;
    const eOffUj = p.eOffUj * vRatio * iRatio;
    const eOnSansQrrUj = (p.eOnSansQrrUj ?? p.eOnUj) * vRatio * iRatio;
    const extrapolated =
      Math.abs(vSafe - p.vBusV) > 0.05 * Math.max(1, p.vBusV) ||
      Math.abs(iSafe - p.iLoadA) > 0.05 * Math.max(1, p.iLoadA);
    warnings.push('DPT LUT 仅含 1 个工作点 (INSUFFICIENT_LUT)，结果仅为按 Vbus·Iload 线性缩放的近似值。');
    return {
      status: 'INSUFFICIENT_LUT',
      method: 'single_point_scaled',
      eOnUj,
      eOffUj,
      eSwTotalUj: eOnUj + eOffUj,
      qRrNc: p.qRrNc * iRatio,
      eOnSansQrrUj,
      extrapolated,
      vRange: [p.vBusV, p.vBusV],
      iRange: [p.iLoadA, p.iLoadA],
      tjRange: [p.tjC, p.tjC],
      rgRange: [p.rgOnOhm ?? p.rgOhm, p.rgOffOhm ?? p.rgOhm],
      activeDimensions,
      collapsedDimensions,
      outOfRangeAxes,
      tjProvenance,
      rgProvenance,
      warnings,
    };
  }

  const iEval = iSafe < iMin && iMin > 1e-6 ? iMin : iSafe;
  const lowCurrentScale = iSafe < iMin && iMin > 1e-6 ? iSafe / iMin : 1;

  // Build separate 4D point clouds for Turn-On (Rg_on) and Turn-Off (Rg_off)
  const ptsOn: Clean4DPoint[] = lut.map((pt) => ({
    coords: [pt.vBusV, pt.iLoadA, pt.tjC, pt.rgOnOhm ?? pt.rgOhm],
    eOnUj: pt.eOnUj,
    eOffUj: pt.eOffUj,
    qRrNc: pt.qRrNc,
    eOnSansQrrUj: pt.eOnSansQrrUj ?? pt.eOnUj,
  }));
  const ptsOff: Clean4DPoint[] = lut.map((pt) => ({
    coords: [pt.vBusV, pt.iLoadA, pt.tjC, pt.rgOffOhm ?? pt.rgOhm],
    eOnUj: pt.eOnUj,
    eOffUj: pt.eOffUj,
    qRrNc: pt.qRrNc,
    eOnSansQrrUj: pt.eOnSansQrrUj ?? pt.eOnUj,
  }));

  // Evaluate channels cleanly
  const vClamped = Math.max(vMin, Math.min(vMax, vSafe));
  const iClamped = Math.max(iMin, Math.min(iMax, iEval));
  const tjClamped = Math.max(tjMin, Math.min(tjMax, tjTarget));
  const rgOnClamped = Math.max(rgMin, Math.min(rgMax, rgOnTarget));
  const rgOffClamped = Math.max(rgMin, Math.min(rgMax, rgOffTarget));

  const qOn: [number, number, number, number] = [vClamped, iClamped, tjClamped, rgOnClamped];
  const qOff: [number, number, number, number] = [vClamped, iClamped, tjClamped, rgOffClamped];

  const onRes = evaluate4DScalarChannel(ptsOn, qOn, activeIdx, axisRanges, (p) => p.eOnUj);
  const onSansRes = evaluate4DScalarChannel(ptsOn, qOn, activeIdx, axisRanges, (p) => p.eOnSansQrrUj);
  const qrrRes = evaluate4DScalarChannel(ptsOn, qOn, activeIdx, axisRanges, (p) => p.qRrNc);
  const offRes = evaluate4DScalarChannel(ptsOff, qOff, activeIdx, axisRanges, (p) => p.eOffUj);

  // If strictly above Vmax or Imax (non-zero side out-of-range), gently scale beyond boundary by V/I ratio vs boundary evaluation
  const vHiScale = vSafe > vMax && vMax > 1e-6 ? vSafe / vMax : 1;
  const iHiScale = iSafe > iMax && iMax > 1e-6 ? iSafe / iMax : 1;
  const vLoScale = vSafe < vMin && vMin > 1e-6 ? vSafe / vMin : 1;
  const scaleOut = vLoScale * vHiScale * lowCurrentScale * iHiScale;

  const eOnUj = onRes.value * scaleOut;
  const eOffUj = offRes.value * scaleOut;
  const eOnSansQrrUj = onSansRes.value * scaleOut;
  const qRrNc = qrrRes.value * lowCurrentScale * iHiScale;

  const outsideConvex = outOfRangeAxes.length > 0 || !onRes.enclosed || !offRes.enclosed;
  if (outsideConvex) {
    warnings.push(
      outOfRangeAxes.length > 0
        ? `查询工况在 [${outOfRangeAxes.join(', ')}] 维度超出 DPT LUT 实测范围 (OUT_OF_RANGE)，当前采用边界约束与比例外推。`
        : '查询工况位于 DPT LUT 实测散点凸包外 (OUT_OF_RANGE)，采用最近邻凸权重近似。'
    );
  }

  let method: DptLutInterpolationResult['method'] = '4d_simplex_barycentric';
  if (activeIdx.length < 4 && (onRes.method === 'grid' || onRes.method === 'simplex')) {
    method = activeIdx.length <= 2 ? 'reduced_dim_interpolated' : onRes.method === 'grid' ? '4d_multilinear_grid' : '4d_simplex_barycentric';
  } else if (onRes.method === 'grid' && offRes.method === 'grid') {
    method = '4d_multilinear_grid';
  }

  const status: DptLutStatus = outsideConvex ? 'OUT_OF_RANGE' : 'VALID';

  return {
    status,
    method,
    eOnUj,
    eOffUj,
    eSwTotalUj: eOnUj + eOffUj,
    qRrNc,
    eOnSansQrrUj,
    extrapolated: outsideConvex,
    vRange: [vMin, vMax],
    iRange: [iMin, iMax],
    tjRange: [tjMin, tjMax],
    rgRange: [rgMin, rgMax],
    activeDimensions,
    collapsedDimensions,
    outOfRangeAxes,
    tjProvenance,
    rgProvenance,
    warnings,
  };
}

// MT-04 Nonlinear Eoss(V)/Qoss(V)/Coss(V) helpers are defined in thermalEngine.ts and re-exported above.

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
  let time = aligned.time;
  let len = time.length;
  if (len < 20) {
    throw new Error('DPT 分析需要重叠时间窗内至少 20 个有效同步采样点。');
  }

  let vgs = new Float32Array(len);
  let vds = new Float32Array(len);
  let ids = new Float32Array(len);

  const deskewSec = (opts.idsDeskewNs || 0) * 1e-9;
  const mIds = idsCh.coupling === 'AC' ? computeChannelMean(idsCh) : 0;
  const tbIds = inspectTimebase(idsCh.t);
  if (!tbIds.monotonic) {
    throw new Error(`Ids 通道时间轴非严格递增，无法应用 Deskew 插值。`);
  }

  if (Math.abs(deskewSec) > 1e-15) {
    const idsMinT = idsCh.t[0];
    const idsMaxT = idsCh.t[idsCh.t.length - 1];
    let kFirst = 0;
    while (kFirst < len && time[kFirst] - deskewSec < idsMinT - 1e-15) kFirst++;
    let kLast = len - 1;
    while (kLast >= kFirst && time[kLast] - deskewSec > idsMaxT + 1e-15) kLast--;

    const validCount = kLast >= kFirst ? kLast - kFirst + 1 : 0;
    const trimmedPts = len - validCount;
    const maxTrimPts = Math.max(4, Math.ceil(len * 0.05));
    if (validCount < 20 || trimmedPts > maxTrimPts) {
      throw new Error(
        `Ids Deskew 偏移 (${(deskewSec * 1e9).toFixed(1)} ns) 超出 Ids 通道有效时间覆盖范围 (${trimmedPts}/${len} 点越界)，已拒绝首尾钳位或伪外推。`
      );
    }

    if (trimmedPts > 0) {
      warnings.push(
        `Ids Deskew (${(deskewSec * 1e9).toFixed(1)} ns) 已裁去越界边缘 ${trimmedPts} 个采样点，拒绝首尾端点重复钳位。`
      );
      time = time.slice(kFirst, kLast + 1);
      vgs = new Float32Array(validCount);
      vds = new Float32Array(validCount);
      ids = new Float32Array(validCount);
    }

    for (let k = 0; k < validCount; k++) {
      const srcIdx = kFirst + k;
      vgs[k] = aligned.values[0][srcIdx] * vgsScale;
      vds[k] = aligned.values[1][srcIdx] * vdsScale;
      const tQ = time[k] - deskewSec;
      const iv = sampleSeriesAtTime(idsCh.t, idsCh, tQ, mIds) * idsScale;
      ids[k] = Number.isFinite(iv) ? iv : Number.NaN;
    }
    len = validCount;
  } else {
    for (let k = 0; k < len; k++) {
      vgs[k] = aligned.values[0][k] * vgsScale;
      vds[k] = aligned.values[1][k] * vdsScale;
      ids[k] = aligned.values[2][k] * idsScale;
    }
  }

  const syncTb = inspectTimebase(time, 0, len - 1, DEFAULT_SAMPLING_GAP_FACTOR);
  const gapThresholdSec = syncTb.gapThresholdSec;
  const assertCleanWindow = (i0: number, i1: number, label: string) => {
    for (let j = i0; j <= i1; j++) {
      if (!Number.isFinite(vgs[j]) || !Number.isFinite(vds[j]) || !Number.isFinite(ids[j])) {
        throw new Error(`${label}窗口内存在缺失值 (NaN/Inf)，已拒绝输出失真 DPT 开关能量与峰谷指标。`);
      }
      if (j > i0 && Number.isFinite(gapThresholdSec) && time[j] - time[j - 1] > gapThresholdSec) {
        throw new Error(`${label}窗口内存在采样缺口 (Δt > ${gapThresholdSec.toExponential(2)} s)，已拒绝跨缺口积分开关能量。`);
      }
    }
  };

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
    if (!Number.isFinite(vgs[i - 1]) || !Number.isFinite(vgs[i])) continue;
    if (Number.isFinite(gapThresholdSec) && time[i] - time[i - 1] > gapThresholdSec) continue;
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
    let sumPre = 0;
    let cntPre = 0;
    for (let j = pre0; j < idx; j++) {
      if (Number.isFinite(ids[j])) {
        sumPre += ids[j];
        cntPre++;
      }
    }
    if (cntPre === 0) continue;
    const meanPreI = sumPre / cntPre;
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
    // Fallback: pick rising edge that actually has post-edge drain current > 15% max finite Ids
    let maxI = -Infinity;
    for (let j = 0; j < len; j++) {
      if (Number.isFinite(ids[j]) && ids[j] > maxI) maxI = ids[j];
    }
    for (const idx of risingEdges) {
      const post1 = Math.min(len - 1, idx + Math.max(6, Math.floor(len * 0.04)));
      let peakPost = -Infinity;
      for (let j = idx; j <= post1; j++) {
        if (Number.isFinite(ids[j]) && ids[j] > peakPost) peakPost = ids[j];
      }
      if (Number.isFinite(maxI) && peakPost > maxI * 0.15) {
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
    assertCleanWindow(eStart, eEnd, '关断瞬态 (Turn-Off)');

    let eJ = 0;
    for (let j = eStart + 1; j <= eEnd; j++) {
      const dt = Math.max(0, time[j] - time[j - 1]);
      const p0 = vds[j - 1] * ids[j - 1];
      const p1 = vds[j] * ids[j];
      eJ += 0.5 * (p0 + p1) * dt;
    }
    eOffUj = Math.max(0, eJ * 1e6);
    if (!Number.isFinite(eOffUj)) {
      throw new Error('关断瞬态积分结果非有限值，已拒绝输出 E_off。');
    }

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
    assertCleanWindow(eStart, eEnd, '开通瞬态 (Turn-On)');

    let eJ = 0;
    for (let j = eStart + 1; j <= eEnd; j++) {
      const dt = Math.max(0, time[j] - time[j - 1]);
      const p0 = vds[j - 1] * ids[j - 1];
      const p1 = vds[j] * ids[j];
      eJ += 0.5 * (p0 + p1) * dt;
    }
    eOnUj = Math.max(0, eJ * 1e6);
    if (!Number.isFinite(eOnUj)) {
      throw new Error('开通瞬态积分结果非有限值，已拒绝输出 E_on。');
    }

    // Reverse recovery detection: region where Ids > iRefOn around turn-on peak
    let peakIdx = eStart;
    let iPeakOn = ids[eStart];
    for (let j = eStart; j <= w1; j++) {
      if (Number.isFinite(ids[j]) && ids[j] > iPeakOn) {
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
      assertCleanWindow(rrStart, rrEnd, '反向恢复 (Reverse Recovery)');

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
