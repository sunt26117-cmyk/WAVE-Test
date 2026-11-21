/**
 * Waveform Viewer Pro - Electro-Thermal Deconvolution, Model Order Reduction,
 * Cauer Ladder Synthesis, LTspice Subcircuit Validation & Closed-Loop Tj(t) Engine.
 *
 * Key Numerical Safeguards:
 * - Logarithmic binning mean resampling for dense captures (>=300 pts), skipping empty bins
 * - Raw non-uniform timestamps preserved for coarse logger captures (<300 pts)
 * - Dynamic tau bounds: tau_min >= max(1e-4 s, 0.5 * dt_med), tau_max <= 3 * t_max
 * - Column-norm balanced Two-Stage Debiased Relaxed LASSO + L-curve knee lambda selection
 * - Energy-weighted centroid pole merging + unbiased pure NNLS refit
 * - Heating & Cooling (t_blank + sqrt(t) extrapolation for Tj(0)) + Auto t0 detection
 * - Time-scale normalized Float64 Foster -> Cauer conversion (sum-R error < 1e-6)
 * - Strict SPICE Cauer topology: C1@TJ -> 0, Ck@N(k-1) -> 0, Rn -> TAMB (no TAMB short), defensive .ic
 */

import { WaveformChannel } from '../types/models';
import { computeChannelMean, getChannelDisplayValue } from './oscilloscopeScale';

export type ThermalInputMode = 'heating' | 'cooling';

export interface FosterStage {
  r: number; // °C/W
  c: number; // J/°C
  tau: number; // s = r * c
  layerLabel: string;
}

export interface CauerStage {
  r: number; // °C/W
  c: number; // J/°C
  tauEst: number; // s = r * c
  layerLabel: string;
}

export interface StructurePoint {
  rCum: number;
  cCum: number;
  layerLabel: string;
}

export interface ThermalDeconvOptions {
  mode: ThermalInputMode;
  powerW: number;
  tStart?: number;
  tEnd?: number;
  autoT0?: boolean;
  tBlankSec?: number;
  targetOrder?: number; // 2..6
  tAmbOverride?: number;
  lambdaOverride?: number;
}

export interface ThermalSpectrumBin {
  tau: number;
  r: number;
}

export interface ThermalDeconvResult {
  mode: ThermalInputMode;
  powerW: number;
  t0Sec: number;
  tBaseC: number;
  tJ0C: number;
  tauMinSec: number;
  tauMaxSec: number;
  dtMedSec: number;
  usedLogBinning: boolean;
  rawPointCount: number;
  fitPointCount: number;
  selectedLambda: number;
  warnings: string[];

  // Time-series arrays for Tab 1 plots
  fitTimeRel: Float64Array; // t - t0
  fitTempMeasured: Float64Array;
  fitTempPredicted: Float64Array;
  fitZthMeasured: Float64Array;
  fitZthPredicted: Float64Array;
  residualTemp: Float64Array;

  // Dense smooth analytical reconstruction (10x..20x) for oscilloscope overlay
  smoothAbsTime: Float64Array;
  smoothTemp: Float32Array;

  // Sparse spectrum (before targetOrder reduction) & Reduced Foster/Cauer
  sparseSpectrum: ThermalSpectrumBin[];
  mergedPoles: FosterStage[];
  reducedFoster: FosterStage[];
  reducedCauer: CauerStage[];
  structureFunction: StructurePoint[];

  totalRthFoster: number;
  totalRthCauer: number;
  fosterCauerRelErr: number;
  rSquared: number;
  rmseC: number;
  spiceNetlist: string;
  spiceValidation: SpiceValidationResult;
}

export interface SpiceValidationResult {
  valid: boolean;
  errors: string[];
  allCapsGroundedTo0: boolean;
  firstCapAtTJ: boolean;
  noCapOnTamb: boolean;
  finalResToTamb: boolean;
  hasDefensiveIc: boolean;
  totalSpiceR: number;
}

export interface LossSimulationOptions {
  deskewNs: number;
  eossUj: number;
  rdsOn25Mohm: number;
  tempCoeffAlphaPerC: number; // e.g. 0.0045 (/°C)
  tAmbC: number;
  vOnThreshV?: number;
  tStart?: number;
  tEnd?: number;
}

export interface LossSimulationResult {
  time: Float64Array;
  pLossW: Float32Array;
  tjC: Float32Array;
  pLossMeanW: number;
  tjMaxC: number;
  tjMinC: number;
  tjMeanC: number;
  energyRawMj: number;
  energyDeskewedMj: number;
  energyStrippedMj: number;
  switchingEvents: number;
}

export function classifyThermalLayer(tauSec: number): string {
  if (!isFinite(tauSec) || tauSec < 0.01) return '芯片/焊料 (<10ms)';
  if (tauSec <= 1.0) return '封装/基板 (10ms~1s)';
  return 'PCB/散热器 (>1s)';
}

function median(vals: number[]): number {
  if (vals.length === 0) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

/**
 * Detects step onset t0 and baseline temperature T_base cleanly.
 * Works for pre-step flat baselines (e.g. 10s idle then heat step at t=10s) as well as step-at-t=0 captures.
 */
export function detectThermalStepOnset(
  t: Float64Array,
  temp: Float64Array,
  mode: ThermalInputMode
): { t0: number; onsetIdx: number; tBase: number } {
  const n = t.length;
  if (n < 6) {
    return { t0: t[0] ?? 0, onsetIdx: 0, tBase: temp[0] ?? 25 };
  }

  const tailCount = Math.max(4, Math.floor(n * 0.1));
  const tailVals: number[] = [];
  for (let i = Math.max(0, n - tailCount); i < n; i++) {
    if (isFinite(temp[i])) tailVals.push(temp[i]);
  }
  const tTail = median(tailVals);

  // Short initial window (first 4% clamped to [3, 12]) prevents delayed steps at ~5-10% from polluting baseline
  const leadCount = Math.max(3, Math.min(12, Math.floor(n * 0.04)));
  const leadVals: number[] = [];
  for (let i = 0; i < Math.min(n, leadCount); i++) {
    if (isFinite(temp[i])) leadVals.push(temp[i]);
  }
  const tBaseLead = median(leadVals);
  const totalSpan = Math.abs(tTail - tBaseLead);
  if (totalSpan < 1e-6) {
    return { t0: t[0], onsetIdx: 0, tBase: tBaseLead };
  }

  const sign = mode === 'heating' ? 1 : -1;

  // Check if step begins immediately at t[0] using only the very first 2..3 intervals
  const earlyEnd = Math.min(n - 1, 3);
  if (
    sign * (temp[1] - temp[0]) > totalSpan * 0.012 &&
    sign * (temp[earlyEnd] - temp[0]) > totalSpan * 0.03
  ) {
    return { t0: t[0], onsetIdx: 0, tBase: temp[0] };
  }

  // Robust baseline noise via MAD over initial lead window
  const absDevs = leadVals.map((v) => Math.abs(v - tBaseLead));
  const leadMad = median(absDevs) * 1.4826;
  const thresh = Math.max(4 * leadMad, 0.025 * totalSpan);

  for (let i = 1; i < n - 1; i++) {
    const dev = sign * (temp[i] - tBaseLead);
    const devNext = sign * (temp[i + 1] - tBaseLead);
    if (dev > thresh && devNext > thresh) {
      const onsetIdx = Math.max(0, i - 1);
      // Refine tBase as exact mean of pre-onset baseline [0..onsetIdx]
      let sumPre = 0;
      let cntPre = 0;
      for (let k = 0; k <= onsetIdx; k++) {
        if (isFinite(temp[k])) {
          sumPre += temp[k];
          cntPre++;
        }
      }
      const tBase = cntPre > 0 ? sumPre / cntPre : tBaseLead;
      return { t0: t[onsetIdx], onsetIdx, tBase };
    }
  }

  return { t0: t[0], onsetIdx: 0, tBase: tBaseLead };
}

/**
 * Exact non-negative least squares solver (Active-Set Lawson-Hanson) for small/medium M x K systems.
 */
export function solveNNLS(A: Float64Array[], b: Float64Array, maxIter = 500): Float64Array {
  const m = b.length;
  const k = A.length > 0 ? A[0].length : 0;
  const x = new Float64Array(k);
  if (m === 0 || k === 0) return x;

  // Build Gram matrix G = A^T A (k x k) and gVec = A^T b (k)
  const G = new Float64Array(k * k);
  const gVec = new Float64Array(k);
  for (let j = 0; j < k; j++) {
    let gb = 0;
    for (let i = 0; i < m; i++) gb += A[i][j] * b[i];
    gVec[j] = gb;
    for (let l = j; l < k; l++) {
      let sum = 0;
      for (let i = 0; i < m; i++) sum += A[i][j] * A[i][l];
      G[j * k + l] = sum;
      G[l * k + j] = sum;
    }
  }

  const passive = new Uint8Array(k); // 1 = in passive set (x_j > 0)
  const w = new Float64Array(k);

  const solveSubset = (activeIndices: number[]): Float64Array => {
    const p = activeIndices.length;
    const mat = new Float64Array(p * p);
    const rhs = new Float64Array(p);
    for (let r = 0; r < p; r++) {
      const jr = activeIndices[r];
      rhs[r] = gVec[jr];
      for (let c = 0; c < p; c++) {
        mat[r * p + c] = G[jr * k + activeIndices[c]];
      }
      mat[r * p + r] += 1e-14; // tiny ridge guard
    }
    // Gaussian elimination with partial pivoting
    for (let col = 0; col < p; col++) {
      let piv = col;
      let maxAbs = Math.abs(mat[col * p + col]);
      for (let row = col + 1; row < p; row++) {
        const av = Math.abs(mat[row * p + col]);
        if (av > maxAbs) {
          maxAbs = av;
          piv = row;
        }
      }
      if (piv !== col) {
        for (let c = col; c < p; c++) {
          const tmp = mat[col * p + c];
          mat[col * p + c] = mat[piv * p + c];
          mat[piv * p + c] = tmp;
        }
        const tr = rhs[col];
        rhs[col] = rhs[piv];
        rhs[piv] = tr;
      }
      const diag = mat[col * p + col];
      if (Math.abs(diag) < 1e-18) continue;
      for (let row = col + 1; row < p; row++) {
        const factor = mat[row * p + col] / diag;
        rhs[row] -= factor * rhs[col];
        for (let c = col; c < p; c++) {
          mat[row * p + c] -= factor * mat[col * p + c];
        }
      }
    }
    const sol = new Float64Array(p);
    for (let row = p - 1; row >= 0; row--) {
      let s = rhs[row];
      for (let c = row + 1; c < p; c++) s -= mat[row * p + c] * sol[c];
      const diag = mat[row * p + row];
      sol[row] = Math.abs(diag) > 1e-18 ? s / diag : 0;
    }
    return sol;
  };

  for (let outer = 0; outer < maxIter; outer++) {
    // Compute gradient w = A^T (b - A x) = gVec - G x
    let maxW = -Infinity;
    let bestIdx = -1;
    for (let j = 0; j < k; j++) {
      let gx = 0;
      for (let l = 0; l < k; l++) gx += G[j * k + l] * x[l];
      w[j] = gVec[j] - gx;
      if (!passive[j] && w[j] > maxW) {
        maxW = w[j];
        bestIdx = j;
      }
    }
    if (bestIdx === -1 || maxW <= 1e-11) break;
    passive[bestIdx] = 1;

    for (let inner = 0; inner < maxIter; inner++) {
      const pIdx: number[] = [];
      for (let j = 0; j < k; j++) if (passive[j]) pIdx.push(j);
      if (pIdx.length === 0) break;

      const sSub = solveSubset(pIdx);
      const s = new Float64Array(k);
      let allPos = true;
      for (let r = 0; r < pIdx.length; r++) {
        s[pIdx[r]] = sSub[r];
        if (sSub[r] <= 0) allPos = false;
      }
      if (allPos) {
        for (let j = 0; j < k; j++) x[j] = s[j];
        break;
      }
      let alpha = Infinity;
      for (let r = 0; r < pIdx.length; r++) {
        const idx = pIdx[r];
        if (s[idx] <= 0) {
          const denom = x[idx] - s[idx];
          const step = denom > 1e-18 ? x[idx] / denom : 0;
          if (step < alpha) alpha = step;
        }
      }
      if (!isFinite(alpha)) alpha = 0;
      for (let r = 0; r < pIdx.length; r++) {
        const idx = pIdx[r];
        x[idx] += alpha * (s[idx] - x[idx]);
        if (Math.abs(x[idx]) <= 1e-12) {
          x[idx] = 0;
          passive[idx] = 0;
        }
      }
    }
  }

  return x;
}

/**
 * Column-normalized Non-Negative Coordinate Descent LASSO solver:
 * Minimizes 0.5 * ||A_norm * R_norm - z||_2^2 + lambda * sum(R_norm) subject to R_norm >= 0.
 */
function solveNonNegLassoCD(
  ANormCols: Float64Array[], // P cols, each length M
  colNorms: Float64Array,
  z: Float64Array,
  lambda: number,
  maxIter = 2500,
  warmNormW?: Float64Array
): { weights: Float64Array; normW: Float64Array } {
  const P = ANormCols.length;
  const M = z.length;
  const w = warmNormW && warmNormW.length === P ? new Float64Array(warmNormW) : new Float64Array(P);
  const r = new Float64Array(z); // residual = z - A_norm * w
  if (warmNormW && warmNormW.length === P) {
    for (let j = 0; j < P; j++) {
      const wj = w[j];
      if (wj > 0) {
        const col = ANormCols[j];
        for (let i = 0; i < M; i++) r[i] -= wj * col[i];
      }
    }
  }

  for (let iter = 0; iter < maxIter; iter++) {
    let maxChange = 0;
    for (let j = 0; j < P; j++) {
      const col = ANormCols[j];
      const oldW = w[j];
      // dot(col, r) + oldW (since ||col||_2^2 === 1)
      let rho = oldW;
      for (let i = 0; i < M; i++) rho += col[i] * r[i];
      const nextW = rho > lambda ? rho - lambda : 0;
      const dw = nextW - oldW;
      if (dw !== 0) {
        w[j] = nextW;
        for (let i = 0; i < M; i++) r[i] -= dw * col[i];
        const adw = Math.abs(dw);
        if (adw > maxChange) maxChange = adw;
      }
    }
    if (maxChange < 1e-9) break;
  }

  const weights = new Float64Array(P);
  for (let j = 0; j < P; j++) {
    weights[j] = colNorms[j] > 1e-15 ? w[j] / colNorms[j] : 0;
  }
  return { weights, normW: w };
}

/**
 * Compact Double-Double arithmetic helpers for ill-conditioned higher-order Foster->Cauer division.
 */
interface DD {
  hi: number;
  lo: number;
}
function ddFrom(x: number): DD {
  return { hi: x, lo: 0 };
}
function ddQuickTwoSum(a: number, b: number): DD {
  const s = a + b;
  const e = b - (s - a);
  return { hi: s, lo: e };
}
function ddAdd(a: DD, b: DD): DD {
  const s = a.hi + b.hi;
  const v = s - a.hi;
  const e = (a.hi - (s - v)) + (b.hi - v) + a.lo + b.lo;
  return ddQuickTwoSum(s, e);
}
function ddSub(a: DD, b: DD): DD {
  return ddAdd(a, { hi: -b.hi, lo: -b.lo });
}
function ddMul(a: DD, b: DD): DD {
  const SPLIT = 134217729; // 2^27 + 1
  const c1 = SPLIT * a.hi;
  const ah = c1 - (c1 - a.hi);
  const al = a.hi - ah;
  const c2 = SPLIT * b.hi;
  const bh = c2 - (c2 - b.hi);
  const bl = b.hi - bh;
  const p = a.hi * b.hi;
  const err = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
  const lo = err + a.hi * b.lo + a.lo * b.hi;
  return ddQuickTwoSum(p, lo);
}
function ddDiv(a: DD, b: DD): DD {
  const q1 = a.hi / b.hi;
  const r = ddSub(a, ddMul(ddFrom(q1), b));
  const q2 = r.hi / b.hi;
  return ddQuickTwoSum(q1, q2);
}

/**
 * Converts a Foster RC network (parallel pairs in series) to an equivalent Cauer ladder
 * using time-scale normalization + double-double Euclidean continued fraction expansion.
 * Cauer index 0 sits at the heat-source terminal TJ (high-frequency admittance pole),
 * guaranteeing sum(R_cauer) matches sum(R_foster) within < 1e-6 relative error.
 */
export function fosterToCauer(foster: FosterStage[]): {
  cauer: CauerStage[];
  totalRthFoster: number;
  totalRthCauer: number;
  relErr: number;
} {
  const valid = foster.filter((f) => isFinite(f.r) && f.r > 0 && isFinite(f.tau) && f.tau > 0);
  const n = valid.length;
  if (n === 0) {
    return { cauer: [], totalRthFoster: 0, totalRthCauer: 0, relErr: 0 };
  }

  const totalRthFoster = valid.reduce((acc, s) => acc + s.r, 0);

  // Geometric mean time constant normalization keeps polynomial coefficients ~ O(1)
  let logSum = 0;
  for (const s of valid) logSum += Math.log(s.tau);
  const tauGeom = Math.exp(logSum / n);
  const tausNorm = valid.map((s) => s.tau / tauGeom);
  const rNorms = valid.map((s) => s.r);

  // Build rational impedance Z(u) = P(u) / Q(u), where u = s * tauGeom
  // Foster stage i: r_i / (1 + tauNorm_i * u)
  // Ascending power coefficients: index k = power of u^k
  const polyMul = (a: DD[], b: DD[]): DD[] => {
    const out = Array.from({ length: a.length + b.length - 1 }, () => ddFrom(0));
    for (let i = 0; i < a.length; i++) {
      for (let j = 0; j < b.length; j++) {
        out[i + j] = ddAdd(out[i + j], ddMul(a[i], b[j]));
      }
    }
    return out;
  };
  const polyAdd = (a: DD[], b: DD[]): DD[] => {
    const len = Math.max(a.length, b.length);
    const out: DD[] = [];
    for (let i = 0; i < len; i++) {
      out.push(ddAdd(a[i] || ddFrom(0), b[i] || ddFrom(0)));
    }
    return out;
  };

  let Q: DD[] = [ddFrom(1)];
  for (let i = 0; i < n; i++) {
    Q = polyMul(Q, [ddFrom(1), ddFrom(tausNorm[i])]);
  }
  let P: DD[] = [ddFrom(0)];
  for (let i = 0; i < n; i++) {
    let prod: DD[] = [ddFrom(rNorms[i])];
    for (let j = 0; j < n; j++) {
      if (i !== j) {
        prod = polyMul(prod, [ddFrom(1), ddFrom(tausNorm[j])]);
      }
    }
    P = polyAdd(P, prod);
  }

  // Continued fraction from infinity (highest powers of u) -> Cauer ladder starting at TJ
  const trimHigh = (poly: DD[]): DD[] => {
    const out = [...poly];
    while (out.length > 1 && Math.abs(out[out.length - 1].hi) < 1e-26) out.pop();
    return out;
  };

  let num = trimHigh(Q); // Admittance Y(u) = Q(u)/P(u) has degree n over degree n-1
  let den = trimHigh(P);
  const cauer: CauerStage[] = [];

  for (let stage = 0; stage < n; stage++) {
    num = trimHigh(num);
    den = trimHigh(den);
    if (num.length < 2 || den.length < 1) break;

    // Step A: Y(u) = c_k * u + Y_rem(u) -> extract highest u term for C_k
    const cNorm = ddDiv(num[num.length - 1], den[den.length - 1]);
    const remNum: DD[] = [];
    for (let k = 0; k < num.length - 1; k++) {
      const subTerm = k - 1 >= 0 ? ddMul(cNorm, den[k - 1]) : ddFrom(0);
      remNum.push(ddSub(num[k], subTerm));
    }
    const YremNum = trimHigh(remNum);
    // Now Z_rem(u) = den / YremNum -> both degree n-1-stage -> extract high ratio for R_k!
    const dLen = den.length;
    const yLen = YremNum.length;
    if (yLen === 0 || Math.abs(YremNum[yLen - 1].hi) < 1e-28) break;

    const rStage = ddDiv(den[dLen - 1], YremNum[yLen - 1]);
    const remZ: DD[] = [];
    const shift = dLen - yLen;
    for (let k = 0; k < dLen; k++) {
      const subTerm = k - shift >= 0 ? ddMul(rStage, YremNum[k - shift]) : ddFrom(0);
      remZ.push(ddSub(den[k], subTerm));
    }
    const nextP = trimHigh(remZ);

    const rVal = Math.max(1e-12, rStage.hi);
    const cVal = Math.max(1e-15, cNorm.hi * tauGeom);
    const tauEst = rVal * cVal;
    cauer.push({
      r: rVal,
      c: cVal,
      tauEst,
      layerLabel: classifyThermalLayer(tauEst),
    });

    num = YremNum;
    den = nextP;
  }

  const totalRthCauer = cauer.reduce((acc, s) => acc + s.r, 0);
  const relErr = totalRthFoster > 1e-15 ? Math.abs(totalRthCauer - totalRthFoster) / totalRthFoster : 0;
  return { cauer, totalRthFoster, totalRthCauer, relErr };
}

/**
 * Generates LTspice standard Cauer `.subckt MOS_THERM TJ TAMB` netlist.
 * Guarantees:
 * - C1 sits strictly on heat-source node TJ -> 0
 * - C2..Cn sit strictly on internal nodes N1..N(n-1) -> 0
 * - Rn connects N(n-1) (or TJ if 1-stage) -> TAMB with ZERO capacitance directly on TAMB
 * - Defensive .ic initial conditions set all nodes to T_amb
 */
export function cauerToSpice(
  cauer: CauerStage[],
  tAmbC: number = 25,
  subcktName: string = 'MOS_THERM'
): string {
  if (cauer.length === 0) {
    return `* Empty Cauer thermal network`;
  }
  const n = cauer.length;
  const totalR = cauer.reduce((a, b) => a + b.r, 0);
  const lines: string[] = [
    `* Waveform Viewer Pro - Cauer Thermal Ladder (.subckt ${subcktName})`,
    `* Total Steady-State Rth = ${totalR.toFixed(6)} C/W (${n} stages)`,
    `* Units: Voltage = Temp (degC), Current = Power (W)`,
    `.subckt ${subcktName} TJ TAMB params: T_amb=${tAmbC.toFixed(2)}`,
  ];

  const icNodes: string[] = [`V(TJ)={T_amb}`];
  for (let i = 0; i < n; i++) {
    const leftNode = i === 0 ? 'TJ' : `N${i}`;
    const rightNode = i === n - 1 ? 'TAMB' : `N${i + 1}`;
    if (i < n - 1) icNodes.push(`V(N${i + 1})={T_amb}`);
    lines.push(`C${i + 1} ${leftNode} 0 ${cauer[i].c.toExponential(6)} ; ${cauer[i].layerLabel}`);
    lines.push(`R${i + 1} ${leftNode} ${rightNode} ${cauer[i].r.toExponential(6)}`);
  }

  lines.push(`* Defensive initial condition (prevents 0C->Tamb charging when using uic or non-zero t=0 pulse)`);
  lines.push(`.ic ${icNodes.join(' ')}`);
  lines.push(`.ends ${subcktName}`);
  lines.push('');
  lines.push(`* --- Example LTspice Transient Harness (Paste into .asc SPICE Directive) ---`);
  lines.push(`* X_MOS TJ AMB ${subcktName} T_amb=${tAmbC.toFixed(2)}`);
  lines.push(`* V_AMB AMB 0 ${tAmbC.toFixed(2)}`);
  lines.push(`* I_PWR 0 TJ PULSE(0 10 0 1u 1u 10 20) ; Example 10W step into TJ`);
  return lines.join('\n');
}

/**
 * Structural validator checking Cauer grounding, C1@TJ placement, non-shorted TAMB,
 * sum-R conservation, and defensive .ic presence.
 */
export function validateCauerSpiceNetlist(
  spiceText: string,
  expectedTotalR?: number
): SpiceValidationResult {
  const lines = spiceText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('*'));
  const caps: Array<{ name: string; n1: string; n2: string }> = [];
  const ress: Array<{ name: string; n1: string; n2: string; val: number }> = [];
  let icLine = '';

  for (const l of lines) {
    const clean = l.split(';')[0].trim();
    const parts = clean.split(/\s+/);
    if (parts[0]?.toUpperCase().startsWith('C') && parts.length >= 4) {
      caps.push({ name: parts[0], n1: parts[1].toUpperCase(), n2: parts[2].toUpperCase() });
    } else if (parts[0]?.toUpperCase().startsWith('R') && parts.length >= 4) {
      ress.push({
        name: parts[0],
        n1: parts[1].toUpperCase(),
        n2: parts[2].toUpperCase(),
        val: parseFloat(parts[3]),
      });
    } else if (parts[0]?.toLowerCase() === '.ic') {
      icLine += ' ' + clean;
    }
  }

  const errors: string[] = [];
  const allCapsGroundedTo0 = caps.length > 0 && caps.every((c) => c.n2 === '0');
  if (!allCapsGroundedTo0) errors.push('One or more capacitors do not terminate at global node 0.');

  const firstCapAtTJ = caps.length > 0 && caps[0].n1 === 'TJ';
  if (!firstCapAtTJ) errors.push('First capacitor C1 must attach directly to heat-source node TJ.');

  const noCapOnTamb = caps.every((c) => c.n1 !== 'TAMB' && c.n2 !== 'TAMB');
  if (!noCapOnTamb) errors.push('Capacitor attached directly to TAMB would be shorted by ideal ambient source.');

  const finalResToTamb = ress.length > 0 && ress[ress.length - 1].n2 === 'TAMB';
  if (!finalResToTamb) errors.push('Final resistor must terminate at TAMB.');

  const internalNodes = new Set<string>(['TJ']);
  for (const r of ress) {
    if (r.n1 !== 'TAMB') internalNodes.add(r.n1);
    if (r.n2 !== 'TAMB') internalNodes.add(r.n2);
  }
  const hasDefensiveIc = Array.from(internalNodes).every((nd) =>
    new RegExp(`V\\(${nd}\\)\\s*=`, 'i').test(icLine)
  );
  if (!hasDefensiveIc) errors.push('Missing defensive .ic initial condition on one or more thermal nodes.');

  const totalSpiceR = ress.reduce((a, b) => a + (isFinite(b.val) ? b.val : 0), 0);
  if (expectedTotalR !== undefined && expectedTotalR > 1e-12) {
    const rel = Math.abs(totalSpiceR - expectedTotalR) / expectedTotalR;
    if (rel > 1e-5) errors.push(`Resistor sum mismatch (${totalSpiceR.toFixed(6)} vs ${expectedTotalR.toFixed(6)}).`);
  }

  return {
    valid: errors.length === 0,
    errors,
    allCapsGroundedTo0,
    firstCapAtTJ,
    noCapOnTamb,
    finalResToTamb,
    hasDefensiveIc,
    totalSpiceR,
  };
}

/**
 * Impedance-domain reduction to N in [2, 6] compact Foster stages, followed by unbiased NNLS refit.
 */
function reduceFosterOrder(
  mergedPoles: FosterStage[],
  fitDt: Float64Array,
  fitZth: Float64Array,
  targetOrder: number
): FosterStage[] {
  const N = Math.max(2, Math.min(6, Math.round(targetOrder)));
  if (mergedPoles.length <= N) {
    return mergedPoles;
  }

  // Merge closest pairs weighted by reduced-resistance perturbation cost: (r1*r2/(r1+r2)) * |d(ln tau)|
  let clusters = mergedPoles.map((p) => ({ r: p.r, logTau: Math.log(p.tau) }));
  while (clusters.length > N) {
    let bestIdx = 0;
    let bestCost = Infinity;
    for (let i = 0; i < clusters.length - 1; i++) {
      const d = Math.abs(clusters[i + 1].logTau - clusters[i].logTau);
      const r1 = clusters[i].r;
      const r2 = clusters[i + 1].r;
      const reducedR = (r1 * r2) / Math.max(1e-15, r1 + r2);
      const cost = d * reducedR;
      if (cost < bestCost) {
        bestCost = cost;
        bestIdx = i;
      }
    }
    const a = clusters[bestIdx];
    const b = clusters[bestIdx + 1];
    const rSum = a.r + b.r;
    const logTau = rSum > 1e-15 ? (a.r * a.logTau + b.r * b.logTau) / rSum : 0.5 * (a.logTau + b.logTau);
    clusters.splice(bestIdx, 2, { r: rSum, logTau });
  }

  const redTaus = clusters.map((c) => Math.exp(c.logTau));
  const m = fitDt.length;
  const A: Float64Array[] = new Array(m);
  for (let i = 0; i < m; i++) {
    const row = new Float64Array(redTaus.length);
    for (let k = 0; k < redTaus.length; k++) {
      row[k] = 1 - Math.exp(-fitDt[i] / redTaus[k]);
    }
    A[i] = row;
  }
  const rSolved = solveNNLS(A, fitZth);

  const reduced: FosterStage[] = [];
  for (let k = 0; k < redTaus.length; k++) {
    if (rSolved[k] > 1e-9) {
      const r = rSolved[k];
      const tau = redTaus[k];
      reduced.push({
        r,
        c: tau / r,
        tau,
        layerLabel: classifyThermalLayer(tau),
      });
    }
  }
  reduced.sort((a, b) => a.tau - b.tau);
  return reduced;
}

/**
 * Main Phase 1 Entry Point: Two-Stage Debiased LASSO Deconvolution + Reduction + Cauer Synthesis.
 */
export function deconvolveThermalImpedance(
  rawTime: Float64Array,
  rawTemp: Float64Array,
  options: ThermalDeconvOptions
): ThermalDeconvResult {
  const warnings: string[] = [];
  const powerW = isFinite(options.powerW) && options.powerW > 1e-9 ? options.powerW : 1.0;

  // 1. Slice window & sanitize finite points
  const slicedT: number[] = [];
  const slicedY: number[] = [];
  const nRaw = Math.min(rawTime.length, rawTemp.length);
  for (let i = 0; i < nRaw; i++) {
    const ti = rawTime[i];
    const yi = rawTemp[i];
    if (!isFinite(ti) || !isFinite(yi)) continue;
    if (options.tStart !== undefined && ti < options.tStart) continue;
    if (options.tEnd !== undefined && ti > options.tEnd) continue;
    slicedT.push(ti);
    slicedY.push(yi);
  }
  if (slicedT.length < 6) {
    throw new Error('At least 6 finite temperature samples are required inside the analysis gate.');
  }

  const tSlice = Float64Array.from(slicedT);
  const ySlice = Float64Array.from(slicedY);

  // 2. Auto t0 baseline/step detection (or start of slice)
  const onset =
    options.autoT0 !== false
      ? detectThermalStepOnset(tSlice, ySlice, options.mode)
      : { t0: tSlice[0], onsetIdx: 0, tBase: ySlice[0] };

  const t0Sec = onset.t0;
  const tBaseC = options.tAmbOverride !== undefined && isFinite(options.tAmbOverride)
    ? options.tAmbOverride
    : onset.tBase;

  // 3. Extract post-t0 response and handle Cooling sqrt(t) Tj(0) extrapolation
  const tBlank = options.mode === 'cooling' ? Math.max(0, options.tBlankSec || 0) : 0;
  const postDtAll: number[] = [];
  const postTempAll: number[] = [];
  for (let i = onset.onsetIdx + 1; i < tSlice.length; i++) {
    const dt = tSlice[i] - t0Sec;
    if (dt > Math.max(1e-12, tBlank)) {
      postDtAll.push(dt);
      postTempAll.push(ySlice[i]);
    }
  }
  if (postDtAll.length < 5) {
    throw new Error('Insufficient post-step samples after t0/t_blank for thermal deconvolution.');
  }

  // Estimate cooling initial junction temperature Tj(0) by comparing early JEDEC sqrt(t) vs linear-t cooling regression
  let tJ0C = ySlice[onset.onsetIdx];
  if (options.mode === 'cooling') {
    const fitCount = Math.max(4, Math.min(8, Math.floor(postDtAll.length * 0.05)));
    const fitReg = (useSqrt: boolean): { intercept: number; sse: number } => {
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let sxy = 0;
      for (let i = 0; i < fitCount; i++) {
        const x = useSqrt ? Math.sqrt(postDtAll[i]) : postDtAll[i];
        const y = postTempAll[i];
        sx += x;
        sy += y;
        sxx += x * x;
        sxy += x * y;
      }
      const denom = fitCount * sxx - sx * sx;
      if (Math.abs(denom) <= 1e-15) return { intercept: postTempAll[0], sse: Infinity };
      const slope = (fitCount * sxy - sx * sy) / denom;
      const intercept = (sy - slope * sx) / fitCount;
      let sse = 0;
      for (let i = 0; i < fitCount; i++) {
        const x = useSqrt ? Math.sqrt(postDtAll[i]) : postDtAll[i];
        const err = postTempAll[i] - (intercept + slope * x);
        sse += err * err;
      }
      return { intercept, sse };
    };

    const regSqrt = fitReg(true);
    const regLin = fitReg(false);
    const chosen = regLin.sse < regSqrt.sse ? regLin.intercept : regSqrt.intercept;
    if (isFinite(chosen) && chosen >= Math.max(postTempAll[0], tBaseC) - 2) {
      tJ0C = chosen;
    }
    if (tJ0C <= postTempAll[postTempAll.length - 1]) {
      tJ0C = Math.max(...postTempAll);
    }
  }

  const rawZthAll = postTempAll.map((tempVal) =>
    options.mode === 'heating' ? Math.max(0, (tempVal - tBaseC) / powerW) : Math.max(0, (tJ0C - tempVal) / powerW)
  );

  // Median dt guard for tau_min / tau_max
  const stepDiffs: number[] = [];
  for (let i = 1; i < postDtAll.length; i++) {
    const d = postDtAll[i] - postDtAll[i - 1];
    if (d > 1e-15) stepDiffs.push(d);
  }
  const dtMedSec = stepDiffs.length > 0 ? median(stepDiffs) : postDtAll[0];
  const tMax = postDtAll[postDtAll.length - 1];

  // 4. Logarithmic binning for >=300 dense captures (skip empty bins), raw timestamps for <300 sparse captures
  const usedLogBinning = postDtAll.length >= 300;
  let fitDt: Float64Array;
  let fitZth: Float64Array;
  let fitTempMeasured: Float64Array;

  if (usedLogBinning) {
    const logMin = Math.log10(Math.max(1e-7, postDtAll[0]));
    const logMax = Math.log10(Math.max(1e-6, tMax));
    const numBins = Math.max(24, Math.min(240, Math.round((logMax - logMin) * 26)));
    const binSumT = new Float64Array(numBins);
    const binSumZ = new Float64Array(numBins);
    const binSumY = new Float64Array(numBins);
    const binCnt = new Uint32Array(numBins);

    const spanLog = Math.max(1e-9, logMax - logMin);
    for (let i = 0; i < postDtAll.length; i++) {
      const b = Math.min(numBins - 1, Math.max(0, Math.floor(((Math.log10(postDtAll[i]) - logMin) / spanLog) * numBins)));
      binSumT[b] += postDtAll[i];
      binSumZ[b] += rawZthAll[i];
      binSumY[b] += postTempAll[i];
      binCnt[b] += 1;
    }

    const outT: number[] = [];
    const outZ: number[] = [];
    const outY: number[] = [];
    for (let b = 0; b < numBins; b++) {
      // Strictly skip empty bins (never fabricate with linear interpolation)
      if (binCnt[b] > 0) {
        outT.push(binSumT[b] / binCnt[b]);
        outZ.push(binSumZ[b] / binCnt[b]);
        outY.push(binSumY[b] / binCnt[b]);
      }
    }
    fitDt = Float64Array.from(outT);
    fitZth = Float64Array.from(outZ);
    fitTempMeasured = Float64Array.from(outY);
  } else {
    fitDt = Float64Array.from(postDtAll);
    fitZth = Float64Array.from(rawZthAll);
    fitTempMeasured = Float64Array.from(postTempAll);
  }

  // 5. Dynamic tau_min / tau_max guard & non-steady-state warning
  const tauMinSec = Math.max(1e-4, 0.5 * dtMedSec);
  const tauMaxSec = Math.max(tauMinSec * 5, 3.0 * tMax);
  if (fitDt.length >= 8) {
    const tailLen = Math.max(3, Math.floor(fitZth.length * 0.12));
    const tailStartZ = fitZth[fitZth.length - tailLen];
    const tailEndZ = fitZth[fitZth.length - 1];
    const spanZ = Math.max(1e-9, tailEndZ - fitZth[0]);
    if (Math.abs(tailEndZ - tailStartZ) / spanZ > 0.05) {
      warnings.push(
        `Curve has not reached full thermal steady state at end (${((Math.abs(tailEndZ - tailStartZ) / spanZ) * 100).toFixed(1)}% tail drift); τ_max capped at 3·t_max = ${tauMaxSec.toFixed(2)} s.`
      );
    }
  }
  if (dtMedSec >= 0.2) {
    warnings.push(
      `Coarse sampling step Δt_med ≈ ${dtMedSec.toFixed(3)} s: fast poles clamped to τ_min = ${tauMinSec.toFixed(3)} s (fast die transients below sampling resolution are absorbed).`
    );
  }

  // 6. Build tau dictionary (18 points/decade) & column-norm balanced matrix
  const decades = Math.max(0.8, Math.log10(tauMaxSec / tauMinSec));
  const P = Math.max(24, Math.min(120, Math.round(decades * 18)));
  const tauGrid = new Float64Array(P);
  const ANormCols: Float64Array[] = new Array(P);
  const colNorms = new Float64Array(P);
  const M = fitDt.length;

  for (let j = 0; j < P; j++) {
    const tau = tauMinSec * Math.pow(tauMaxSec / tauMinSec, j / Math.max(1, P - 1));
    tauGrid[j] = tau;
    const col = new Float64Array(M);
    let sq = 0;
    for (let i = 0; i < M; i++) {
      const val = 1 - Math.exp(-fitDt[i] / tau);
      col[i] = val;
      sq += val * val;
    }
    const norm = Math.sqrt(sq);
    colNorms[j] = norm;
    if (norm > 1e-15) {
      for (let i = 0; i < M; i++) col[i] /= norm;
    }
    ANormCols[j] = col;
  }

  // Maximum lambda where any feature enters
  let lambdaMax = 0;
  for (let j = 0; j < P; j++) {
    let dot = 0;
    const col = ANormCols[j];
    for (let i = 0; i < M; i++) dot += col[i] * fitZth[i];
    if (dot > lambdaMax) lambdaMax = dot;
  }
  lambdaMax = Math.max(lambdaMax, 1e-9);

  // Automatic lambda selection via pathwise warm-started LASSO + Stage-2 Debiased L-curve
  let selectedLambda = options.lambdaOverride ?? 0;
  let lassoWeights: Float64Array = new Float64Array(P);

  const extractMergedTaus = (weights: Float64Array): number[] => {
    const totalW = weights.reduce((a, b) => a + b, 0);
    const floorW = Math.max(1e-9, totalW * 1e-3);
    const taus: number[] = [];
    let wSum = 0;
    let logSum = 0;
    let active = false;
    for (let j = 0; j < P; j++) {
      if (weights[j] > floorW) {
        wSum += weights[j];
        logSum += weights[j] * Math.log(tauGrid[j]);
        active = true;
      } else if (active) {
        if (wSum > 0) taus.push(Math.exp(logSum / wSum));
        wSum = 0;
        logSum = 0;
        active = false;
      }
    }
    if (active && wSum > 0) taus.push(Math.exp(logSum / wSum));
    return taus;
  };

  const evalDebiasedCandidate = (weights: Float64Array): { rmse: number; k: number } => {
    const taus = extractMergedTaus(weights);
    if (taus.length === 0) return { rmse: Infinity, k: 0 };
    if (taus.length > 24) {
      // Fallback RMSE directly if too many clusters
      let sse = 0;
      for (let i = 0; i < M; i++) {
        let pred = 0;
        for (let j = 0; j < P; j++) if (weights[j] > 0) pred += weights[j] * (1 - Math.exp(-fitDt[i] / tauGrid[j]));
        const d = fitZth[i] - pred;
        sse += d * d;
      }
      return { rmse: Math.sqrt(sse / M), k: taus.length };
    }
    const ACand: Float64Array[] = new Array(M);
    for (let i = 0; i < M; i++) {
      const row = new Float64Array(taus.length);
      for (let k = 0; k < taus.length; k++) row[k] = 1 - Math.exp(-fitDt[i] / taus[k]);
      ACand[i] = row;
    }
    const rDeb = solveNNLS(ACand, fitZth);
    let sse = 0;
    let activeK = 0;
    for (let k = 0; k < taus.length; k++) if (rDeb[k] > 1e-8) activeK++;
    for (let i = 0; i < M; i++) {
      let pred = 0;
      for (let k = 0; k < taus.length; k++) pred += rDeb[k] * ACand[i][k];
      const d = fitZth[i] - pred;
      sse += d * d;
    }
    return { rmse: Math.sqrt(sse / M), k: activeK };
  };

  if (options.lambdaOverride !== undefined && options.lambdaOverride >= 0) {
    lassoWeights = solveNonNegLassoCD(ANormCols, colNorms, fitZth, selectedLambda, 2500).weights;
  } else {
    const numLambdas = 20;
    const candLambdas: number[] = [];
    const candRmses: number[] = [];
    const candK: number[] = [];
    const candWeights: Float64Array[] = [];
    let warmW: Float64Array | undefined = undefined;

    // Sweep pathwise from largest lambda -> smallest lambda with warm starts
    for (let li = 0; li < numLambdas; li++) {
      const exp = -0.5 - (li / (numLambdas - 1)) * 5.0; // 10^-0.5 down to 10^-5.5
      const lam = lambdaMax * Math.pow(10, exp);
      const sol = solveNonNegLassoCD(ANormCols, colNorms, fitZth, lam, 2500, warmW);
      warmW = sol.normW;
      const deb = evalDebiasedCandidate(sol.weights);
      candLambdas.push(lam);
      candRmses.push(deb.rmse);
      candK.push(deb.k);
      candWeights.push(sol.weights);
    }

    const zSpan = Math.max(1e-9, Math.max(...fitZth) - Math.min(...fitZth));
    let bestScore = Infinity;
    let bestIdx = 0;
    for (let li = 0; li < numLambdas; li++) {
      if (candK[li] === 0 || !isFinite(candRmses[li])) continue;
      // Floor relative error at 0.05% full-scale so noiseless overfitting of >6 poles never beats clean sparse model
      const relErr = Math.max(candRmses[li] / zSpan, 5e-4);
      const score = Math.log(relErr * relErr) + 0.32 * candK[li];
      if (score < bestScore) {
        bestScore = score;
        bestIdx = li;
      }
    }
    selectedLambda = candLambdas[bestIdx];
    lassoWeights = candWeights[bestIdx];
  }

  // 7. Cluster adjacent non-zero weights -> energy-weighted log-tau centroid merge
  const sparseSpectrum: ThermalSpectrumBin[] = [];
  const totalL1R = lassoWeights.reduce((a, b) => a + b, 0);
  const rNoiseFloor = Math.max(1e-9, totalL1R * 1e-3);

  interface RawCluster {
    indices: number[];
  }
  const rawClusters: RawCluster[] = [];
  let cur: RawCluster | null = null;
  for (let j = 0; j < P; j++) {
    if (lassoWeights[j] > rNoiseFloor) {
      sparseSpectrum.push({ tau: tauGrid[j], r: lassoWeights[j] });
      if (!cur) {
        cur = { indices: [j] };
        rawClusters.push(cur);
      } else {
        cur.indices.push(j);
      }
    } else {
      cur = null;
    }
  }

  let mergedTaus: number[] = [];
  for (const cl of rawClusters) {
    let wSum = 0;
    let logSum = 0;
    for (const idx of cl.indices) {
      wSum += lassoWeights[idx];
      logSum += lassoWeights[idx] * Math.log(tauGrid[idx]);
    }
    if (wSum > 0) mergedTaus.push(Math.exp(logSum / wSum));
  }
  if (mergedTaus.length === 0) {
    mergedTaus = [Math.sqrt(tauMinSec * tauMaxSec)];
  }

  // 8. Stage 2 Debiased Pure NNLS Refit on centroid-merged poles (zero L1 shrinkage!)
  const AStar: Float64Array[] = new Array(M);
  for (let i = 0; i < M; i++) {
    const row = new Float64Array(mergedTaus.length);
    for (let k = 0; k < mergedTaus.length; k++) {
      row[k] = 1 - Math.exp(-fitDt[i] / mergedTaus[k]);
    }
    AStar[i] = row;
  }
  const rDebiased = solveNNLS(AStar, fitZth);

  const mergedPoles: FosterStage[] = [];
  for (let k = 0; k < mergedTaus.length; k++) {
    if (rDebiased[k] > 1e-8) {
      const r = rDebiased[k];
      const tau = mergedTaus[k];
      mergedPoles.push({
        r,
        c: tau / r,
        tau,
        layerLabel: classifyThermalLayer(tau),
      });
    }
  }
  mergedPoles.sort((a, b) => a.tau - b.tau);

  // 9. Reduce to target order N in [2, 6] & Convert Foster -> Cauer
  const targetOrder = options.targetOrder !== undefined ? Math.max(2, Math.min(6, options.targetOrder)) : 3;
  const reducedFoster = reduceFosterOrder(mergedPoles, fitDt, fitZth, targetOrder);
  const cauerConv = fosterToCauer(reducedFoster);

  // Evaluate model fit metrics on fitDt using reducedFoster
  const fitZthPredicted = new Float64Array(M);
  const fitTempPredicted = new Float64Array(M);
  const residualTemp = new Float64Array(M);

  let ssRes = 0;
  let ssTot = 0;
  let meanMeasT = 0;
  for (let i = 0; i < M; i++) meanMeasT += fitTempMeasured[i];
  meanMeasT /= M;

  for (let i = 0; i < M; i++) {
    let zPred = 0;
    for (const s of reducedFoster) {
      zPred += s.r * (1 - Math.exp(-fitDt[i] / s.tau));
    }
    fitZthPredicted[i] = zPred;
    const tPred = options.mode === 'heating' ? tBaseC + powerW * zPred : tJ0C - powerW * zPred;
    fitTempPredicted[i] = tPred;
    const err = fitTempMeasured[i] - tPred;
    residualTemp[i] = err;
    ssRes += err * err;
    const dtMean = fitTempMeasured[i] - meanMeasT;
    ssTot += dtMean * dtMean;
  }

  const rmseC = Math.sqrt(ssRes / M);
  const rSquared = ssTot > 1e-12 ? Math.max(0, 1 - ssRes / ssTot) : 1.0;

  // 10. Generate 12x smooth analytical trace (zero overshoot, physically monotone)
  const smoothCount = Math.max(200, Math.min(4000, Math.max(postDtAll.length * 12, 400)));
  const smoothAbsTime = new Float64Array(smoothCount);
  const smoothTemp = new Float32Array(smoothCount);
  const tAbsStart = tSlice[0];
  const tAbsEnd = tSlice[tSlice.length - 1];
  for (let i = 0; i < smoothCount; i++) {
    const absT = tAbsStart + (i / (smoothCount - 1)) * (tAbsEnd - tAbsStart);
    smoothAbsTime[i] = absT;
    const rel = absT - t0Sec;
    if (rel <= 0) {
      smoothTemp[i] = options.mode === 'heating' ? tBaseC : tJ0C;
    } else {
      let z = 0;
      for (const s of reducedFoster) z += s.r * (1 - Math.exp(-rel / s.tau));
      smoothTemp[i] = options.mode === 'heating' ? tBaseC + powerW * z : tJ0C - powerW * z;
    }
  }

  // 11. Cumulative structure function & SPICE subckt
  const structureFunction: StructurePoint[] = [];
  let rCum = 0;
  let cCum = 0;
  for (const st of cauerConv.cauer) {
    rCum += st.r;
    cCum += st.c;
    structureFunction.push({ rCum, cCum, layerLabel: st.layerLabel });
  }

  const spiceNetlist = cauerToSpice(cauerConv.cauer, tBaseC, 'MOS_THERM');
  const spiceValidation = validateCauerSpiceNetlist(spiceNetlist, cauerConv.totalRthCauer);

  return {
    mode: options.mode,
    powerW,
    t0Sec,
    tBaseC,
    tJ0C,
    tauMinSec,
    tauMaxSec,
    dtMedSec,
    usedLogBinning,
    rawPointCount: postDtAll.length,
    fitPointCount: M,
    selectedLambda,
    warnings,
    fitTimeRel: fitDt,
    fitTempMeasured,
    fitTempPredicted,
    fitZthMeasured: fitZth,
    fitZthPredicted,
    residualTemp,
    smoothAbsTime,
    smoothTemp,
    sparseSpectrum,
    mergedPoles,
    reducedFoster,
    reducedCauer: cauerConv.cauer,
    structureFunction,
    totalRthFoster: cauerConv.totalRthFoster,
    totalRthCauer: cauerConv.totalRthCauer,
    fosterCauerRelErr: cauerConv.relErr,
    rSquared,
    rmseC,
    spiceNetlist,
    spiceValidation,
  };
}

/**
 * Exact O(N) Zero-Order Hold (ZOH) Foster state-space forward thermal simulator.
 * Supports arbitrary non-uniform step dt_k cleanly.
 */
export function simulateFosterZoh(
  time: Float64Array,
  power: Float32Array | Float64Array,
  stages: FosterStage[],
  tAmbC: number
): Float32Array {
  const n = Math.min(time.length, power.length);
  const tj = new Float32Array(n);
  if (n === 0) return tj;

  const kLen = stages.length;
  const dT = new Float64Array(kLen);
  tj[0] = tAmbC;

  for (let i = 1; i < n; i++) {
    const dt = Math.max(0, time[i] - time[i - 1]);
    const p = isFinite(power[i - 1]) ? power[i - 1] : 0;
    let sumDt = 0;
    for (let m = 0; m < kLen; m++) {
      const { r, tau } = stages[m];
      if (tau > 1e-15 && dt > 0) {
        const e = Math.exp(-dt / tau);
        dT[m] = dT[m] * e + r * (1 - e) * p;
      } else if (dt > 0) {
        dT[m] = r * p;
      }
      sumDt += dT[m];
    }
    tj[i] = tAmbC + sumDt;
  }
  return tj;
}

/**
 * O(N) unconditionally stable Backward-Euler / sub-stepped Cauer ladder simulator.
 * Useful when users supply direct Cauer stages and want physical internal node evolution.
 */
export function simulateCauerZoh(
  time: Float64Array,
  power: Float32Array | Float64Array,
  cauer: CauerStage[],
  tAmbC: number
): Float32Array {
  const n = Math.min(time.length, power.length);
  const tj = new Float32Array(n);
  const m = cauer.length;
  if (n === 0) return tj;
  if (m === 0) {
    tj.fill(tAmbC);
    return tj;
  }

  let minTau = Infinity;
  for (let k = 0; k < m; k++) {
    const tauK = cauer[k].r * cauer[k].c;
    if (isFinite(tauK) && tauK > 1e-12 && tauK < minTau) minTau = tauK;
  }
  if (!isFinite(minTau)) minTau = 1e-4;

  const nodeT = new Float64Array(m).fill(tAmbC);
  tj[0] = tAmbC;

  // Tridiagonal Thomas solver per step: (C/dt + G) T_next = (C/dt) T_prev + rhs
  const aSub = new Float64Array(m);
  const bDiag = new Float64Array(m);
  const cSup = new Float64Array(m);
  const rhs = new Float64Array(m);
  const cPrime = new Float64Array(m);
  const dPrime = new Float64Array(m);
  const ckOverSubDt = new Float64Array(m);

  let prevSubDt = -1;

  for (let i = 1; i < n; i++) {
    const dt = Math.max(0, time[i] - time[i - 1]);
    if (dt <= 0) {
      tj[i] = nodeT[0];
      continue;
    }
    const p = isFinite(power[i - 1]) ? power[i - 1] : 0;
    const subSteps = Math.min(64, Math.max(1, Math.ceil(dt / Math.max(1e-8, 0.04 * minTau))));
    const subDt = dt / subSteps;

    // Pre-factor tridiagonal matrix when subDt changes
    if (Math.abs(subDt - prevSubDt) > 1e-15 * Math.max(1, subDt)) {
      prevSubDt = subDt;
      for (let k = 0; k < m; k++) {
        ckOverSubDt[k] = cauer[k].c / subDt;
        const gLeft = k > 0 ? 1 / cauer[k - 1].r : 0;
        const gRight = 1 / cauer[k].r;
        aSub[k] = k > 0 ? -gLeft : 0;
        bDiag[k] = ckOverSubDt[k] + gLeft + gRight;
        cSup[k] = k < m - 1 ? -gRight : 0;
      }
      cPrime[0] = m > 1 ? cSup[0] / bDiag[0] : 0;
      for (let k = 1; k < m; k++) {
        const denom = bDiag[k] - aSub[k] * cPrime[k - 1];
        cPrime[k] = k < m - 1 ? cSup[k] / denom : 0;
      }
    }

    const gLast = 1 / cauer[m - 1].r;
    const ambTerm = tAmbC * gLast;

    for (let s = 0; s < subSteps; s++) {
      for (let k = 0; k < m; k++) {
        rhs[k] = ckOverSubDt[k] * nodeT[k] + (k === 0 ? p : 0) + (k === m - 1 ? ambTerm : 0);
      }
      dPrime[0] = rhs[0] / bDiag[0];
      for (let k = 1; k < m; k++) {
        const denom = bDiag[k] - aSub[k] * cPrime[k - 1];
        dPrime[k] = (rhs[k] - aSub[k] * dPrime[k - 1]) / denom;
      }
      nodeT[m - 1] = dPrime[m - 1];
      for (let k = m - 2; k >= 0; k--) {
        nodeT[k] = dPrime[k] - cPrime[k] * nodeT[k + 1];
      }
    }

    tj[i] = nodeT[0];
  }

  return tj;
}

/**
 * Tab 2 Loss Stripping & Closed-Loop Tj(t) Simulator:
 * - Linearly interpolates Ids(t - deskew) for sub-sample Deskew (ns) alignment
 * - Strips Coss stored energy Eoss (deducted at turn-off, added back at turn-on)
 * - Runs closed-loop Cauer/Foster thermal advance with Rds(on)(Tj) feedback
 */
export function computeLossWithDeskewAndEoss(
  vdsCh: WaveformChannel,
  idsCh: WaveformChannel,
  cauerStages: CauerStage[],
  opts: LossSimulationOptions
): LossSimulationResult {
  const nFull = Math.min(vdsCh.t.length, vdsCh.v.length, idsCh.v.length);
  let i0 = 0;
  let i1 = nFull - 1;
  if (opts.tStart !== undefined) {
    while (i0 < nFull && vdsCh.t[i0] < opts.tStart) i0++;
  }
  if (opts.tEnd !== undefined) {
    while (i1 > i0 && vdsCh.t[i1] > opts.tEnd) i1--;
  }
  const len = Math.max(0, i1 - i0 + 1);
  if (len < 4) {
    throw new Error('At least 4 samples are required inside gate for loss stripping simulation.');
  }

  const time = new Float64Array(len);
  const pLossW = new Float32Array(len);
  const tjC = new Float32Array(len);

  const mV = vdsCh.coupling === 'AC' ? computeChannelMean(vdsCh) : 0;
  const mI = idsCh.coupling === 'AC' ? computeChannelMean(idsCh) : 0;

  // Determine Vds span for turn-on / turn-off edge detection
  let vMin = Infinity;
  let vMax = -Infinity;
  for (let i = i0; i <= i1; i++) {
    const vv = getChannelDisplayValue(vdsCh, i, mV);
    if (isFinite(vv)) {
      if (vv < vMin) vMin = vv;
      if (vv > vMax) vMax = vv;
    }
  }
  const vSpan = Math.max(1e-6, vMax - vMin);
  const vLowThresh = vMin + vSpan * 0.2;
  const vHighThresh = vMin + vSpan * 0.8;

  const deskewSec = (opts.deskewNs || 0) * 1e-9;
  const eossJ = Math.max(0, opts.eossUj || 0) * 1e-6;
  const r25Ohm = Math.max(0, opts.rdsOn25Mohm || 0) * 1e-3;
  const alpha = opts.tempCoeffAlphaPerC || 0;
  const vOnThresh = opts.vOnThreshV ?? Math.max(0.5, vMin + vSpan * 0.15);

  const sampleIdsAt = (targetT: number): number => {
    const tArr = idsCh.t;
    const nI = Math.min(tArr.length, idsCh.v.length);
    if (nI === 0) return 0;
    if (targetT <= tArr[0]) return getChannelDisplayValue(idsCh, 0, mI);
    if (targetT >= tArr[nI - 1]) return getChannelDisplayValue(idsCh, nI - 1, mI);

    let lo = 0;
    let hi = nI - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (tArr[mid] <= targetT) lo = mid;
      else hi = mid;
    }
    const dt = tArr[hi] - tArr[lo];
    const frac = dt > 1e-18 ? (targetT - tArr[lo]) / dt : 0;
    const v0 = getChannelDisplayValue(idsCh, lo, mI);
    const v1 = getChannelDisplayValue(idsCh, hi, mI);
    return v0 + frac * (v1 - v0);
  };

  let energyRawJ = 0;
  let energyDeskewedJ = 0;
  let energyStrippedJ = 0;
  let switchingEvents = 0;

  // Cauer state variables initialized at tAmbC
  const mStages = cauerStages.length;
  const nodeT = new Float64Array(Math.max(1, mStages)).fill(opts.tAmbC);
  const aSub = new Float64Array(Math.max(1, mStages));
  const bDiag = new Float64Array(Math.max(1, mStages));
  const cSup = new Float64Array(Math.max(1, mStages));
  const rhs = new Float64Array(Math.max(1, mStages));
  const cPrime = new Float64Array(Math.max(1, mStages));
  const dPrime = new Float64Array(Math.max(1, mStages));

  let swState: 'on' | 'off' | 'trans_off' | 'trans_on' =
    getChannelDisplayValue(vdsCh, i0, mV) <= vLowThresh ? 'on' : 'off';
  let transStartIdx = -1;

  const pRawArr = new Float64Array(len);
  const pDeskewArr = new Float64Array(len);

  for (let k = 0; k < len; k++) {
    const idx = i0 + k;
    const tCurr = vdsCh.t[idx];
    time[k] = tCurr;
    const vds = getChannelDisplayValue(vdsCh, idx, mV);
    const idsRaw = getChannelDisplayValue(idsCh, idx, mI);
    const idsAligned = deskewSec !== 0 ? sampleIdsAt(tCurr - deskewSec) : idsRaw;

    pRawArr[k] = vds * idsRaw;
    pDeskewArr[k] = vds * idsAligned;
    pLossW[k] = pDeskewArr[k];
  }

  // Strip Eoss across identified turn-off (Vds rising) and turn-on (Vds falling) intervals
  for (let k = 0; k < len; k++) {
    const idx = i0 + k;
    const vds = getChannelDisplayValue(vdsCh, idx, mV);
    if (swState === 'on' && vds > vLowThresh) {
      swState = 'trans_off';
      transStartIdx = k;
    } else if (swState === 'trans_off') {
      if (vds >= vHighThresh) {
        // Completed turn-off: deduct Eoss across [transStartIdx..k]
        const spanT = Math.max(1e-12, time[k] - time[transStartIdx]);
        if (eossJ > 0) {
          const pAdj = eossJ / spanT;
          for (let j = transStartIdx; j <= k; j++) pLossW[j] -= pAdj;
        }
        switchingEvents++;
        swState = 'off';
      } else if (vds <= vLowThresh) {
        swState = 'on';
      }
    } else if (swState === 'off' && vds < vHighThresh) {
      swState = 'trans_on';
      transStartIdx = k;
    } else if (swState === 'trans_on') {
      if (vds <= vLowThresh) {
        // Completed turn-on: add stored Eoss back across [transStartIdx..k]
        const spanT = Math.max(1e-12, time[k] - time[transStartIdx]);
        if (eossJ > 0) {
          const pAdj = eossJ / spanT;
          for (let j = transStartIdx; j <= k; j++) pLossW[j] += pAdj;
        }
        switchingEvents++;
        swState = 'on';
      } else if (vds >= vHighThresh) {
        swState = 'off';
      }
    }
  }

  // Advance closed-loop Tj(t) with temperature-dependent Rds(on)(Tj) feedback
  let sumLoss = 0;
  let tjMaxC = opts.tAmbC;
  let tjMinC = opts.tAmbC;
  let sumTj = opts.tAmbC;
  tjC[0] = opts.tAmbC;

  for (let k = 0; k < len; k++) {
    if (k > 0) {
      const dt = Math.max(1e-12, time[k] - time[k - 1]);
      energyRawJ += 0.5 * (pRawArr[k - 1] + pRawArr[k]) * dt;
      energyDeskewedJ += 0.5 * (pDeskewArr[k - 1] + pDeskewArr[k]) * dt;

      // Apply Rds(on)(Tj) feedback during on-state conduction if r25Ohm > 0
      const idxPrev = i0 + k - 1;
      const vPrev = getChannelDisplayValue(vdsCh, idxPrev, mV);
      if (r25Ohm > 0 && alpha !== 0 && Math.abs(vPrev) <= vOnThresh) {
        const idsPrev = deskewSec !== 0 ? sampleIdsAt(time[k - 1] - deskewSec) : getChannelDisplayValue(idsCh, idxPrev, mI);
        const rTj = Math.max(1e-6, r25Ohm * (1 + alpha * (nodeT[0] - 25)));
        const deltaCond = idsPrev * idsPrev * (rTj - r25Ohm);
        pLossW[k - 1] += deltaCond;
      }

      const pStep = isFinite(pLossW[k - 1]) ? pLossW[k - 1] : 0;
      energyStrippedJ += 0.5 * (pStep + pLossW[k]) * dt;

      if (mStages > 0) {
        for (let s = 0; s < mStages; s++) {
          const ckOverDt = cauerStages[s].c / dt;
          const gLeft = s > 0 ? 1 / cauerStages[s - 1].r : 0;
          const gRight = 1 / cauerStages[s].r;
          aSub[s] = s > 0 ? -gLeft : 0;
          bDiag[s] = ckOverDt + gLeft + gRight;
          cSup[s] = s < mStages - 1 ? -gRight : 0;
          rhs[s] = ckOverDt * nodeT[s] + (s === 0 ? pStep : 0) + (s === mStages - 1 ? opts.tAmbC * gRight : 0);
        }
        cPrime[0] = mStages > 1 ? cSup[0] / bDiag[0] : 0;
        dPrime[0] = rhs[0] / bDiag[0];
        for (let s = 1; s < mStages; s++) {
          const denom = bDiag[s] - aSub[s] * cPrime[s - 1];
          cPrime[s] = s < mStages - 1 ? cSup[s] / denom : 0;
          dPrime[s] = (rhs[s] - aSub[s] * dPrime[s - 1]) / denom;
        }
        nodeT[mStages - 1] = dPrime[mStages - 1];
        for (let s = mStages - 2; s >= 0; s--) {
          nodeT[s] = dPrime[s] - cPrime[s] * nodeT[s + 1];
        }
        tjC[k] = nodeT[0];
      } else {
        tjC[k] = opts.tAmbC;
      }
      if (tjC[k] > tjMaxC) tjMaxC = tjC[k];
      if (tjC[k] < tjMinC) tjMinC = tjC[k];
      sumTj += tjC[k];
    }
    sumLoss += pLossW[k];
  }

  return {
    time,
    pLossW,
    tjC,
    pLossMeanW: len > 0 ? sumLoss / len : 0,
    tjMaxC,
    tjMinC,
    tjMeanC: len > 0 ? sumTj / len : opts.tAmbC,
    energyRawMj: energyRawJ * 1e3,
    energyDeskewedMj: energyDeskewedJ * 1e3,
    energyStrippedMj: energyStrippedJ * 1e3,
    switchingEvents,
  };
}
