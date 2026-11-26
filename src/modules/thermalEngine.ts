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
import { areTimebasesSynchronized, inspectChannelSamplingGaps, inspectTimebase } from './timeSync';

export type ThermalInputMode = 'heating' | 'cooling';
export type ThermalPathMode = 'junction_ambient' | 'pad_ambient';

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
  targetOrder?: number; // 1..8
  tAmbOverride?: number;
  lambdaOverride?: number;
  thermalPathMode?: ThermalPathMode;
  padSpreadRthCPerW?: number;
}

export interface ThermalSpectrumBin {
  tau: number;
  r: number;
}

export type ThermalFitStatus = 'valid' | 'reduced' | 'failed';

export interface ThermalPhysicsCheck {
  key: 'rc_bounds' | 'stage_effectiveness' | 'tau_separation' | 'rth_credibility' | 'cauer_parity' | 'fit_quality';
  label: string;
  passed: boolean;
  detail: string;
}

export interface ThermalPhysicsAudit {
  status: ThermalFitStatus;
  passed: boolean;
  requestedOrder: number;
  effectiveOrder: number;
  orderReduced: boolean;
  refitCount: number;
  extrapolationRatio: number;
  measuredSpanC: number;
  zMeasuredEnd: number;
  checks: ThermalPhysicsCheck[];
  rejectedReasons: string[];
  summary: string;
}

export interface ThermalDeconvResult {
  mode: ThermalInputMode;
  thermalPathMode: ThermalPathMode;
  padSpreadRthCPerW: number;
  powerW: number;
  t0Sec: number;
  tBaseC: number;
  tAmbC: number;
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
  physicsAudit: ThermalPhysicsAudit;
}

export interface SpiceValidationResult {
  valid: boolean;
  errors: string[];
  heatNodeName: string;
  allCapsGroundedTo0: boolean;
  firstCapAtTJ: boolean;
  noCapOnTamb: boolean;
  finalResToTamb: boolean;
  hasDefensiveIc: boolean;
  totalSpiceR: number;
}

export interface CossCurvePoint {
  vdsV: number;
  val: number; // uJ for eoss_uj, nC for qoss_nc, pF for coss_pf
}

export type EossCurveProvenance = 'datasheet' | 'dpt_measured' | 'user_import' | 'preset' | 'assumed';

export interface NonlinearEossCurve {
  kind: 'eoss_uj' | 'qoss_nc' | 'coss_pf';
  points: CossCurvePoint[];
  label?: string;
  provenance?: EossCurveProvenance;
  manufacturer?: string;
  partNumber?: string;
  referenceTemperatureC?: number;
  testVgsV?: number;
  rgOnOhm?: number;
  rgOffOhm?: number;
  sourceNote?: string;
}

export interface EossCurveImportDocument {
  schema: 'wave-test-eoss-curve';
  schemaVersion: 1;
  kind: 'eoss_uj' | 'qoss_nc' | 'coss_pf';
  voltageUnit: 'V' | 'mV';
  valueUnit: 'uJ' | 'nJ' | 'mJ' | 'nC' | 'uC' | 'pF' | 'nF';
  label?: string;
  provenance?: EossCurveProvenance;
  manufacturer?: string;
  partNumber?: string;
  referenceTemperatureC?: number;
  testVgsV?: number;
  rgOnOhm?: number;
  rgOffOhm?: number;
  points: Array<{ vds: number; value: number }>;
}

export interface EossCurveEvalResult {
  eossUj: number;
  outOfRange: boolean;
  domain: [number, number];
  warnings: string[];
}

export interface CauerZohResult {
  tj: Float32Array;
  maxSubsteps: number;
  minActualStepSec: number;
  peakTempErrorC: number;
  solverStatus: 'CONVERGED' | 'STEP_CAP_REACHED';
  warnings: string[];
}

export interface LossSimulationOptions {
  deskewNs: number;
  eossUj: number;
  eossCurve?: NonlinearEossCurve;
  rdsOn25Mohm: number;
  tempCoeffAlphaPerC: number; // e.g. 0.0045 (/°C)
  tAmbC: number;
  vOnThreshV?: number;
  rdsFeedbackEnabled?: boolean;
  tStart?: number;
  tEnd?: number;
  initialTjC?: number;
  initialNodeT?: number[];
  preheatPowerW?: number;
  preheatDurationSec?: number;
  pathMode?: ThermalPathMode;
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
  zvsTurnOnCount: number;
  incomplete: boolean;
  incompleteReasons: string[];
  nonFiniteMasked: number;
  outOfCoverageCount: number;
  thermalPathMode: ThermalPathMode;
  warnings: string[];
  maxThermalSubsteps?: number;
  minThermalStepSec?: number;
  peakThermalStepErrorC?: number;
  thermalSolverStatus?: 'CONVERGED' | 'STEP_CAP_REACHED';
}

export interface ViPowerOptions {
  tStart?: number;
  tEnd?: number;
  stepOnsetTimeSec?: number;
  useAbsPower?: boolean;
}

export interface ViPowerResult {
  time: Float64Array;
  powerW: Float32Array;
  pGateMeanW: number;
  pStepActiveW: number;
  pPeakW: number;
  energyJ: number;
  activeFraction: number;
  vMeanV: number;
  iMeanA: number;
  vUnitScale: number;
  iUnitScale: number;
  sampleCount: number;
}

export function parseSiUnitScale(
  unit: string | undefined,
  expectedKind: 'V' | 'A' | 'W',
  channelNameFallback?: string,
  options?: { strict?: boolean }
): number {
  const strict = Boolean(options?.strict);
  const checkStr = (rawStr: string | undefined): number | null => {
    const raw = (rawStr || '').trim();
    if (!raw) return null;
    const normalized = raw.replace(/μ/g, 'u').replace(/µ/g, 'u');
    const k = expectedKind.toLowerCase();
    const m = normalized.match(new RegExp(`^(u|n|m|k|meg|m)?\\s*(${k}|volt|volts|amp|amps|watt|watts)$`, 'i'));
    if (!m) {
      if (new RegExp(`^u${k}$`, 'i').test(normalized)) return 1e-6;
      if (new RegExp(`^n${k}$`, 'i').test(normalized)) return 1e-9;
      if (new RegExp(`^m${k}$`, 'i').test(normalized)) return 1e-3;
      if (new RegExp(`^k${k}$`, 'i').test(normalized)) return 1e3;
      return null;
    }
    const pfx = m[1] || '';
    if (pfx === 'u' || pfx === 'U') return 1e-6;
    if (pfx === 'n' || pfx === 'N') return 1e-9;
    if (pfx === 'm') return 1e-3;
    if (pfx === 'M' || pfx.toLowerCase() === 'meg') {
      return pfx.toLowerCase() === 'meg' ? 1e6 : 1e-3;
    }
    if (pfx === 'k' || pfx === 'K') return 1e3;
    return 1;
  };

  // If unit matches expectedKind directly (e.g. 'mA' for 'A'), use it;
  // otherwise if unit is empty or generic default 'V' while expectedKind is 'A'/'W', inspect bracketed unit in channelName!
  const trimmedUnit = (unit || '').trim();
  const direct = checkStr(trimmedUnit);
  if (direct !== null && (direct !== 1 || new RegExp(`^(${expectedKind}|volt|amp|watt)`, 'i').test(trimmedUnit))) {
    return direct;
  }

  let bracketToken: string | null = null;
  if (channelNameFallback) {
    const br = channelNameFallback.match(/[\(\[\{]\s*([µμunmk]?[VAW]|°C|degC|C|K|Hz|kHz|MHz|Ω|Ohm|rpm|%|pct|percent)\s*[\)\]\}]/i);
    if (br) {
      bracketToken = br[1];
      const fromName = checkStr(bracketToken);
      if (fromName !== null) return fromName;
    }
  }

  if (strict) {
    const chLabel = channelNameFallback ? `"${channelNameFallback}" ` : '';
    const badUnit = trimmedUnit || bracketToken || '';
    if (badUnit) {
      throw new Error(
        `通道 ${chLabel}单位 "${badUnit}" 与期望物理量 (${expectedKind}) 不匹配，请确认选择的通道类型及单位。`
      );
    }
    if (
      channelNameFallback &&
      (/^(t_?pcb|t_?pad|t_?j|temp|ntc|t_?case)|°c|degc/i.test(channelNameFallback) ||
        /(?:^|[^a-z0-9])(rpm|freq|duty|pwm|speed|temp|temperature)(?:$|[^a-z0-9])/i.test(channelNameFallback))
    ) {
      throw new Error(
        `通道 ${chLabel}疑似非 ${expectedKind} 物理量通道且缺少有效单位，已拒绝代入仿真。`
      );
    }
  }

  return direct ?? 1;
}

export interface TemperatureValidationResult {
  unitLabel: string;
  scale: number;
  offsetC: number;
  warning: string | null;
}

/**
 * Validates that a channel selected for thermal impedance deconvolution represents
 * calibrated temperature (°C or Kelvin), rejecting raw NTC voltages (V/mV), currents (A),
 * or uncalibrated ADC counts.
 */
export function validateTemperatureChannel(ch: WaveformChannel): TemperatureValidationResult {
  const rawUnit = (ch.unit || '').trim();
  const name = (ch.name || '').trim();
  let token = rawUnit;

  if (!token) {
    const br = name.match(/[\(\[\{]\s*(°C|℃|degC|C|K|Kelvin|[µμunmk]?[VAW]|Ω|Ohm|Hz|rpm|%|ADC|count|counts|raw)\s*[\)\]\}]/i);
    if (br) token = br[1];
  }

  const normalized = token.replace(/μ/g, 'u').replace(/µ/g, 'u').trim();
  if (/^(?:[unmk]?[VAW]|volt|volts|amp|amps|watt|watts|ohm|Ω|hz|khz|mhz|rpm|%|pct|percent|adc|count|counts|raw)$/i.test(normalized)) {
    throw new Error(
      `温度通道 "${ch.name}" 单位为 "${token}"（非温度 °C/K），疑似未标定的 NTC 电压、电流或 ADC 原始码，已禁止直接代入热阻反演！`
    );
  }

  if (/^(?:°C|℃|degC|celsius|c)$/i.test(normalized)) {
    return { unitLabel: '°C', scale: 1, offsetC: 0, warning: null };
  }
  if (/^(?:K|kelvin)$/i.test(normalized)) {
    return {
      unitLabel: 'K -> °C',
      scale: 1,
      offsetC: -273.15,
      warning: `温度通道 "${ch.name}" 单位为开尔文 (${token})，已自动换算为摄氏度 (°C = K - 273.15)。`,
    };
  }
  if (normalized) {
    throw new Error(
      `温度通道 "${ch.name}" 单位 "${token}" 不是受支持的温度单位 (°C / K)，请先完成传感器标定与单位设置。`
    );
  }

  // Empty unit: check channel name heuristics to catch obvious raw voltage/ADC channels
  if (/(?:^|[^a-z0-9])(v_?ntc|ntc_?v|v_?temp|v_?th|adc|raw|counts?|vds|vgs|ids|ibus|vbus|rpm|pwm|duty)(?:$|[^a-z0-9])/i.test(name)) {
    throw new Error(
      `温度通道 "${ch.name}" 缺少单位且名称疑似电压/ADC原始量，已阻止直接作为 °C 代入热阻反演。`
    );
  }

  throw new Error(
    `温度通道 "${ch.name}" 未标注温度单位。热阻反演不允许自动假设为 °C；请先确认传感器已完成温度标定，并将通道单位明确设置为 °C 或 K。`
  );
}

export function classifyThermalLayer(tauSec: number, pathMode: ThermalPathMode = 'junction_ambient'): string {
  if (pathMode === 'pad_ambient') {
    if (!isFinite(tauSec) || tauSec < 0.05) return '焊盘/局部铜箔 (<50ms)';
    if (tauSec <= 2.0) return 'PCB 铺铜扩散 (50ms~2s)';
    return 'PCB 板级对流/环境 (>2s)';
  }
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
      // Backtrack cleanly to the foot of the step so slow steps don't miss early samples
      const footThresh = Math.max(2.5 * leadMad, 0.004 * totalSpan);
      let footIdx = i;
      while (footIdx > 0 && sign * (temp[footIdx] - tBaseLead) > footThresh) {
        footIdx--;
      }
      const onsetIdx = Math.max(0, footIdx);
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
 * 240-digit BigInt fixed-point helpers for unconditionally stable higher-order Foster->Cauer expansion.
 * Monomial polynomial division in IEEE-754 float64/double-double loses precision around order >= 6;
 * 240 decimal digits eliminate catastrophic cancellation for any practical RC network order.
 */
const FP_EXP = 240;
const FP_SCALE = 10n ** BigInt(FP_EXP);
const FP_TRIM_EPS = 10n ** 60n; // |x| < 1e-180 treated as exact cancellation zero

function toFP(x: number): bigint {
  if (!Number.isFinite(x) || x === 0) return 0n;
  const s = x.toExponential(16);
  const [mant, expStr] = s.split('e');
  const exp = parseInt(expStr, 10);
  const neg = mant.startsWith('-');
  const clean = (neg ? mant.slice(1) : mant).replace('.', '');
  const fracDigits = 16;
  const shift = FP_EXP + exp - fracDigits;
  let val = BigInt(clean);
  if (shift >= 0) val *= 10n ** BigInt(shift);
  else val /= 10n ** BigInt(-shift);
  return neg ? -val : val;
}

function fpMul(a: bigint, b: bigint): bigint {
  return (a * b) / FP_SCALE;
}

function fpDiv(a: bigint, b: bigint): bigint {
  return b === 0n ? 0n : (a * FP_SCALE) / b;
}

function fromFP(a: bigint): number {
  if (a === 0n) return 0;
  const neg = a < 0n;
  const abs = neg ? -a : a;
  const str = abs.toString();
  const sig = str.slice(0, 20);
  const exp = str.length - FP_EXP - sig.length;
  const v = Number(sig) * Math.pow(10, exp);
  return neg ? -v : v;
}

/**
 * Converts a Foster RC network (parallel pairs in series) to an equivalent Cauer ladder
 * using time-scale normalization + 240-digit BigInt Euclidean continued fraction expansion.
 * Cauer index 0 sits at the heat-source terminal TJ (high-frequency admittance pole),
 * guaranteeing sum(R_cauer) matches sum(R_foster) within < 1e-12 relative error across orders 1..8+.
 */
export function fosterToCauer(foster: FosterStage[]): {
  cauer: CauerStage[];
  totalRthFoster: number;
  totalRthCauer: number;
  relErr: number;
  hasDegenerateStage: boolean;
} {
  const valid = foster.filter((f) => isFinite(f.r) && f.r > 0 && isFinite(f.tau) && f.tau > 0);
  const n = valid.length;
  if (n === 0) {
    return { cauer: [], totalRthFoster: 0, totalRthCauer: 0, relErr: 0, hasDegenerateStage: true };
  }

  const totalRthFoster = valid.reduce((acc, s) => acc + s.r, 0);

  // Geometric mean time constant normalization keeps polynomial coefficients balanced around O(1)
  let logSum = 0;
  for (const s of valid) logSum += Math.log(s.tau);
  const tauGeom = Math.exp(logSum / n);
  const tausNorm = valid.map((s) => toFP(s.tau / tauGeom));
  const rNorms = valid.map((s) => toFP(s.r));

  // Build rational impedance Z(u) = P(u) / Q(u), where u = s * tauGeom
  // Ascending power coefficients: index k = power of u^k
  const polyMul = (a: bigint[], b: bigint[]): bigint[] => {
    const out = new Array<bigint>(a.length + b.length - 1).fill(0n);
    for (let i = 0; i < a.length; i++) {
      for (let j = 0; j < b.length; j++) {
        out[i + j] += fpMul(a[i], b[j]);
      }
    }
    return out;
  };
  const polyAdd = (a: bigint[], b: bigint[]): bigint[] => {
    const len = Math.max(a.length, b.length);
    const out = new Array<bigint>(len);
    for (let i = 0; i < len; i++) {
      out[i] = (a[i] ?? 0n) + (b[i] ?? 0n);
    }
    return out;
  };

  let Q: bigint[] = [FP_SCALE];
  for (let i = 0; i < n; i++) {
    Q = polyMul(Q, [FP_SCALE, tausNorm[i]]);
  }
  let P: bigint[] = [0n];
  for (let i = 0; i < n; i++) {
    let prod: bigint[] = [rNorms[i]];
    for (let j = 0; j < n; j++) {
      if (i !== j) {
        prod = polyMul(prod, [FP_SCALE, tausNorm[j]]);
      }
    }
    P = polyAdd(P, prod);
  }

  // Continued fraction from infinity (highest powers of u) -> Cauer ladder starting at TJ
  const trimHigh = (poly: bigint[]): bigint[] => {
    const out = [...poly];
    while (out.length > 1) {
      const top = out[out.length - 1];
      const absTop = top < 0n ? -top : top;
      if (absTop < FP_TRIM_EPS) out.pop();
      else break;
    }
    return out;
  };

  let num = trimHigh(Q); // Admittance Y(u) = Q(u)/P(u) has degree n over degree n-1
  let den = trimHigh(P);
  const cauer: CauerStage[] = [];
  let hasDegenerateStage = false;

  for (let stage = 0; stage < n; stage++) {
    num = trimHigh(num);
    den = trimHigh(den);
    if (num.length < 2 || den.length < 1 || den[den.length - 1] === 0n) {
      hasDegenerateStage = true;
      break;
    }

    // Step A: Y(u) = c_k * u + Y_rem(u) -> extract highest u term for C_k
    const cNorm = fpDiv(num[num.length - 1], den[den.length - 1]);
    const remNum: bigint[] = [];
    for (let k = 0; k < num.length - 1; k++) {
      const subTerm = k - 1 >= 0 ? fpMul(cNorm, den[k - 1]) : 0n;
      remNum.push(num[k] - subTerm);
    }
    const YremNum = trimHigh(remNum);
    // Now Z_rem(u) = den / YremNum -> extract high ratio for R_k
    const dLen = den.length;
    const yLen = YremNum.length;
    if (yLen === 0 || YremNum[yLen - 1] === 0n) {
      hasDegenerateStage = true;
      break;
    }

    const rStage = fpDiv(den[dLen - 1], YremNum[yLen - 1]);
    const remZ: bigint[] = [];
    const shift = dLen - yLen;
    for (let k = 0; k < dLen; k++) {
      const subTerm = k - shift >= 0 ? fpMul(rStage, YremNum[k - shift]) : 0n;
      remZ.push(den[k] - subTerm);
    }
    const nextP = trimHigh(remZ);

    const rawR = fromFP(rStage);
    const rawC = fromFP(cNorm) * tauGeom;
    if (!isFinite(rawR) || rawR <= 1e-12 || !isFinite(rawC) || rawC <= 1e-15) {
      hasDegenerateStage = true;
    }
    const rVal = Math.max(1e-12, isFinite(rawR) ? rawR : 1e-12);
    const cVal = Math.max(1e-15, isFinite(rawC) ? rawC : 1e-15);
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

  if (cauer.length < n) {
    hasDegenerateStage = true;
  }

  const totalRthCauer = cauer.reduce((acc, s) => acc + s.r, 0);
  const relErr = totalRthFoster > 1e-15 ? Math.abs(totalRthCauer - totalRthFoster) / totalRthFoster : 0;
  return { cauer, totalRthFoster, totalRthCauer, relErr, hasDegenerateStage };
}

/**
 * Generates LTspice standard Cauer `.subckt <NAME> <HEAT_NODE> TAMB` netlist.
 * Guarantees:
 * - C1 sits strictly on heat-source node (TJ or PAD) -> 0
 * - C2..Cn sit strictly on internal nodes N1..N(n-1) -> 0
 * - Rn connects N(n-1) (or HEAT_NODE if 1-stage) -> TAMB with ZERO capacitance directly on TAMB
 * - Defensive .ic initial conditions set all nodes to T_amb
 */
export function cauerToSpice(
  cauer: CauerStage[],
  tAmbC: number = 25,
  subcktName: string = 'MOS_THERM',
  heatNodeName: string = 'TJ'
): string {
  if (cauer.length === 0) {
    return `* Empty Cauer thermal network`;
  }
  const hNode = (heatNodeName || 'TJ').trim().toUpperCase();
  const n = cauer.length;
  const totalR = cauer.reduce((a, b) => a + b.r, 0);
  const lines: string[] = [
    `* Waveform Viewer Pro - Cauer Thermal Ladder (.subckt ${subcktName})`,
    `* Thermal Path: ${hNode} -> TAMB | Total Steady-State Rth = ${totalR.toFixed(6)} C/W (${n} stages)`,
    `* Units: Voltage = Temp (degC), Current = Power (W)`,
    `.subckt ${subcktName} ${hNode} TAMB params: T_amb=${tAmbC.toFixed(2)}`,
  ];

  const icNodes: string[] = [`V(${hNode})={T_amb}`];
  for (let i = 0; i < n; i++) {
    const leftNode = i === 0 ? hNode : `N${i}`;
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
  lines.push(`* X_DEV ${hNode} AMB ${subcktName} T_amb=${tAmbC.toFixed(2)}`);
  lines.push(`* V_AMB AMB 0 ${tAmbC.toFixed(2)}`);
  lines.push(`* I_PWR 0 ${hNode} PULSE(0 10 0 1u 1u 10 20) ; Example 10W step into ${hNode}`);
  return lines.join('\n');
}

/**
 * Structural validator checking Cauer grounding, C1@heatNode placement, non-shorted TAMB,
 * sum-R conservation, and defensive .ic presence.
 */
export function validateCauerSpiceNetlist(
  spiceText: string,
  expectedTotalR?: number,
  heatNodeName: string = 'TJ'
): SpiceValidationResult {
  const hNode = (heatNodeName || 'TJ').trim().toUpperCase();
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

  const firstCapAtTJ = caps.length > 0 && caps[0].n1 === hNode;
  if (!firstCapAtTJ) errors.push(`First capacitor C1 must attach directly to heat-source node ${hNode}.`);

  const noCapOnTamb = caps.every((c) => c.n1 !== 'TAMB' && c.n2 !== 'TAMB');
  if (!noCapOnTamb) errors.push('Capacitor attached directly to TAMB would be shorted by ideal ambient source.');

  const finalResToTamb = ress.length > 0 && ress[ress.length - 1].n2 === 'TAMB';
  if (!finalResToTamb) errors.push('Final resistor must terminate at TAMB.');

  const internalNodes = new Set<string>([hNode]);
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
    heatNodeName: hNode,
    allCapsGroundedTo0,
    firstCapAtTJ,
    noCapOnTamb,
    finalResToTamb,
    hasDefensiveIc,
    totalSpiceR,
  };
}

/**
 * Impedance-domain reduction to N in [1, 8] compact Foster stages, followed by unbiased NNLS refit.
 * Optional allowWellSeparatedSplit only splits poles when genuine wide logarithmic headroom exists (>= 1.38x spacing)
 * and never generates degenerate collinear pole pairs.
 */
function reduceFosterOrder(
  mergedPoles: FosterStage[],
  fitDt: Float64Array,
  fitZth: Float64Array,
  targetOrder: number,
  allowWellSeparatedSplit: boolean = false
): FosterStage[] {
  const N = Math.max(1, Math.min(8, Math.round(targetOrder)));
  if (mergedPoles.length === 0) return [];

  let reduced: FosterStage[] = [];
  if (mergedPoles.length <= N) {
    // Re-fit via NNLS on exact poles to ensure unbiased residuals
    const sorted = [...mergedPoles].sort((a, b) => a.tau - b.tau);
    const m = fitDt.length;
    const A: Float64Array[] = new Array(m);
    for (let i = 0; i < m; i++) {
      const row = new Float64Array(sorted.length);
      for (let k = 0; k < sorted.length; k++) row[k] = 1 - Math.exp(-fitDt[i] / sorted[k].tau);
      A[i] = row;
    }
    const rSolved = solveNNLS(A, fitZth);
    for (let k = 0; k < sorted.length; k++) {
      if (rSolved[k] > 1e-9) {
        reduced.push({
          r: rSolved[k],
          c: sorted[k].tau / rSolved[k],
          tau: sorted[k].tau,
          layerLabel: classifyThermalLayer(sorted[k].tau),
        });
      }
    }
    if (reduced.length === 0) {
      reduced = sorted.map((p) => ({ ...p }));
    }
    reduced.sort((a, b) => a.tau - b.tau);
  } else {
    // Merge closest pairs weighted by reduced-resistance perturbation cost: (r1*r2/(r1+r2)) * |d(ln tau)|
    const clusters = mergedPoles.map((p) => ({ r: p.r, logTau: Math.log(p.tau) }));
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
  }

  // Only attempt pole expansion if explicitly allowed, current RMSE is materially above zero,
  // and inserting + locally refining a >=1.4x separated pole yields >=10% residual RMSE reduction with >=1.2% Rth share.
  if (allowWellSeparatedSplit && reduced.length < N && reduced.length >= 1) {
    const m = fitDt.length;
    const fitZeroSpan = Math.max(1e-9, Math.max(...fitZth) - Math.min(...fitZth));
    const solveForTaus = (tausIn: number[]): { stages: FosterStage[]; rmse: number } => {
      const sortedTaus = [...tausIn].sort((a, b) => a - b);
      const A: Float64Array[] = new Array(m);
      for (let i = 0; i < m; i++) {
        const row = new Float64Array(sortedTaus.length);
        for (let k = 0; k < sortedTaus.length; k++) row[k] = 1 - Math.exp(-fitDt[i] / sortedTaus[k]);
        A[i] = row;
      }
      const rSolved = solveNNLS(A, fitZth);
      const stages: FosterStage[] = [];
      for (let k = 0; k < sortedTaus.length; k++) {
        if (rSolved[k] > 1e-9) {
          stages.push({
            r: rSolved[k],
            c: sortedTaus[k] / rSolved[k],
            tau: sortedTaus[k],
            layerLabel: classifyThermalLayer(sortedTaus[k]),
          });
        }
      }
      let sse = 0;
      for (let i = 0; i < m; i++) {
        let z = 0;
        for (const s of stages) z += s.r * (1 - Math.exp(-fitDt[i] / s.tau));
        const d = fitZth[i] - z;
        sse += d * d;
      }
      return { stages, rmse: Math.sqrt(sse / Math.max(1, m)) };
    };

    const refineTaus = (initTaus: number[], minB: number, maxB: number): { stages: FosterStage[]; rmse: number } => {
      let curTaus = [...initTaus].sort((a, b) => a - b);
      let best = solveForTaus(curTaus);
      const factors = [1.32, 1.14, 1.05];
      for (const fac of factors) {
        for (let idx = 0; idx < curTaus.length; idx++) {
          for (const dir of [fac, 1 / fac]) {
            const candTau = curTaus[idx] * dir;
            if (candTau < minB || candTau > maxB) continue;
            if (idx > 0 && candTau / curTaus[idx - 1] < 1.38) continue;
            if (idx < curTaus.length - 1 && curTaus[idx + 1] / candTau < 1.38) continue;
            const trial = [...curTaus];
            trial[idx] = candTau;
            const sol = solveForTaus(trial);
            if (sol.stages.length === curTaus.length && sol.rmse < best.rmse * 0.999) {
              best = sol;
              curTaus = sol.stages.map((s) => s.tau);
            }
          }
        }
      }
      return best;
    };

    const dt0 = Math.max(1e-6, fitDt[0]);
    const dtEnd = Math.max(dt0 * 10, fitDt[m - 1]);
    const tauMinBound = Math.max(1e-5, Math.min(dt0 * 0.5, reduced[0].tau * 0.5));
    const tauMaxBound = Math.max(tauMinBound * 4, Math.min(2.5 * dtEnd, Math.max(dtEnd, reduced[reduced.length - 1].tau * 2.0)));

    let curRmse = solveForTaus(reduced.map((s) => s.tau)).rmse;
    let expandGuard = 0;

    while (reduced.length < N && expandGuard < 8) {
      if (curRmse / fitZeroSpan < 5e-5) break; // Already near exact fit; never invent spurious poles
      expandGuard++;

      // Compute current residual vector
      const resVec = new Float64Array(m);
      for (let i = 0; i < m; i++) {
        let z = 0;
        for (const s of reduced) z += s.r * (1 - Math.exp(-fitDt[i] / s.tau));
        resVec[i] = fitZth[i] - z;
      }

      // Build separated candidate insertion taus (all geometric midpoints + boundary probes + active-span log grid)
      const candSet: number[] = [];
      const addIfSeparated = (tau: number) => {
        if (!isFinite(tau) || tau < tauMinBound || tau > tauMaxBound) return;
        if (reduced.every((s) => Math.max(tau / s.tau, s.tau / tau) >= 1.42)) {
          if (candSet.every((existing) => Math.max(tau / existing, existing / tau) >= 1.15)) {
            candSet.push(tau);
          }
        }
      };

      for (let i = 0; i < reduced.length - 1; i++) {
        addIfSeparated(Math.sqrt(reduced[i].tau * reduced[i + 1].tau));
      }
      addIfSeparated(Math.max(tauMinBound, reduced[0].tau / 2.8));
      addIfSeparated(Math.min(tauMaxBound, reduced[reduced.length - 1].tau * 2.8));

      const activeMax = Math.max(tauMinBound * 10, Math.min(tauMaxBound, reduced[reduced.length - 1].tau * 3.0));
      const gridCount = 16;
      for (let g = 0; g < gridCount; g++) {
        const cand = tauMinBound * Math.pow(activeMax / tauMinBound, g / Math.max(1, gridCount - 1));
        addIfSeparated(cand);
      }
      if (candSet.length === 0) break;

      const baseTaus = reduced.map((s) => s.tau);
      let bestExpand: { stages: FosterStage[]; rmse: number } | null = null;
      for (const candTau of candSet) {
        const trial = solveForTaus([...baseTaus, candTau]);
        if (trial.stages.length > reduced.length) {
          if (!bestExpand || trial.rmse < bestExpand.rmse) {
            bestExpand = trial;
          }
        }
      }
      if (!bestExpand) break;

      // Co-optimize log(tau) positions briefly so split pairs settle onto true underlying poles
      const refined = refineTaus(
        bestExpand.stages.map((s) => s.tau),
        tauMinBound,
        tauMaxBound
      );
      if (refined.stages.length <= reduced.length) break;
      if (refined.rmse > curRmse * 0.9) break; // Must meaningfully reduce residual RMSE (>= 10%)

      const totR = refined.stages.reduce((a, b) => a + b.r, 0);
      const minShare = Math.min(...refined.stages.map((s) => s.r / Math.max(1e-12, totR)));
      if (minShare < 0.012) break; // Reject redundant <1.2% Rth poles

      reduced = refined.stages;
      curRmse = refined.rmse;
    }
  }

  return reduced;
}

export function auditThermalPhysics(params: {
  foster: FosterStage[];
  cauer: CauerStage[];
  fosterCauerRelErr: number;
  hasDegenerateCauer: boolean;
  requestedOrder: number;
  zMeasuredEnd: number;
  tMaxSec: number;
  rSquared: number;
  rmseC: number;
  measuredSpanC: number;
  mode: ThermalInputMode;
  refitCount?: number;
  rejectedReasons?: string[];
}): ThermalPhysicsAudit {
  const {
    foster,
    cauer,
    fosterCauerRelErr,
    hasDegenerateCauer,
    requestedOrder,
    zMeasuredEnd,
    tMaxSec,
    rSquared,
    rmseC,
    measuredSpanC,
    refitCount = 0,
    rejectedReasons = [],
  } = params;

  const checks: ThermalPhysicsCheck[] = [];
  const totalRFoster = foster.reduce((a, b) => a + b.r, 0);
  const totalRCauer = cauer.reduce((a, b) => a + b.r, 0);

  // 1. Cauer Conversion Integrity
  const cauerParityOk =
    cauer.length > 0 &&
    cauer.length === foster.length &&
    !hasDegenerateCauer &&
    isFinite(fosterCauerRelErr) &&
    fosterCauerRelErr <= 1e-3;
  checks.push({
    key: 'cauer_parity',
    label: 'Foster→Cauer 拓扑等价性',
    passed: cauerParityOk,
    detail: cauerParityOk
      ? `阶数一致 (${cauer.length} 阶), 误差 ${(fosterCauerRelErr * 100).toExponential(1)}%`
      : `Cauer 转换出现退化/负值或误差过大 (relErr=${fosterCauerRelErr.toExponential(2)}, stages=${cauer.length}/${foster.length})`,
  });

  // 2. Physical RC Parameter Bounds
  let rcBoundsOk = foster.length > 0 && cauer.length > 0;
  let rcBadReason = '';
  for (let i = 0; i < cauer.length; i++) {
    const cs = cauer[i];
    const fs = foster[i];
    if (!isFinite(cs.r) || cs.r < 1e-5 || cs.r > 500 || !isFinite(cs.c) || cs.c < 1e-6 || cs.c > 5000) {
      rcBoundsOk = false;
      rcBadReason = `Cauer 第${i + 1}阶超出物理范围 (R=${cs.r.toExponential(2)} °C/W, C=${cs.c.toExponential(2)} J/°C)`;
      break;
    }
    if (fs && (!isFinite(fs.r) || fs.r < 1e-5 || fs.r > 500 || !isFinite(fs.c) || fs.c < 1e-6 || fs.c > 5000 || fs.tau <= 0)) {
      rcBoundsOk = false;
      rcBadReason = `Foster 第${i + 1}阶超出物理范围 (R=${fs.r.toExponential(2)} °C/W, C=${fs.c.toExponential(2)} J/°C)`;
      break;
    }
  }
  checks.push({
    key: 'rc_bounds',
    label: 'RC 参数物理量级',
    passed: rcBoundsOk,
    detail: rcBoundsOk
      ? `所有 R ∈ [1e-5, 500] °C/W, C ∈ [1e-6, 5000] J/°C`
      : rcBadReason || '缺少有效 RC 阶数',
  });

  // 3. Stage Effectiveness (each stage >= 1% Foster Rth & >= 0.5% Cauer Rth)
  let stageEffOk = foster.length > 0 && totalRFoster > 1e-9;
  let stageBadReason = '';
  if (stageEffOk) {
    for (let i = 0; i < foster.length; i++) {
      const ratio = foster[i].r / totalRFoster;
      if (ratio < 0.01) {
        stageEffOk = false;
        stageBadReason = `Foster 第${i + 1}阶热阻占比仅 ${(ratio * 100).toFixed(2)}% (<1% 为冗余无效阶)`;
        break;
      }
    }
    if (stageEffOk) {
      for (let i = 0; i < cauer.length; i++) {
        const ratio = cauer[i].r / Math.max(1e-9, totalRCauer);
        if (ratio < 0.004) {
          stageEffOk = false;
          stageBadReason = `Cauer 第${i + 1}阶热阻占比仅 ${(ratio * 100).toFixed(2)}% (梯形网络塌缩)`;
          break;
        }
      }
    }
  } else {
    stageBadReason = '无有效热阻阶';
  }
  checks.push({
    key: 'stage_effectiveness',
    label: '各阶热阻有效性',
    passed: stageEffOk,
    detail: stageEffOk ? `全部 ${cauer.length} 阶均贡献显著热阻份额` : stageBadReason,
  });

  // 4. Time Constant Separation (distinct poles, >= 1.35x ratio)
  let tauSepOk = true;
  let tauBadReason = '';
  for (let i = 1; i < foster.length; i++) {
    const ratio = foster[i].tau / Math.max(1e-15, foster[i - 1].tau);
    if (ratio < 1.35) {
      tauSepOk = false;
      tauBadReason = `τ${i}=${foster[i - 1].tau.toExponential(2)}s 与 τ${i + 1}=${foster[i].tau.toExponential(2)}s 比值仅 ${ratio.toFixed(2)}× (<1.35× 极点重合)`;
      break;
    }
  }
  checks.push({
    key: 'tau_separation',
    label: '时间常数可辨识性',
    passed: tauSepOk,
    detail: tauSepOk ? `极点时间常数间隔清晰` : tauBadReason,
  });

  // 5. Total Rth Credibility (bounds + non-excessive steady-state extrapolation)
  const extrapolationRatio = zMeasuredEnd > 1e-9 ? totalRFoster / zMeasuredEnd : Infinity;
  const tailOverDominated =
    foster.length > 0 &&
    foster[foster.length - 1].tau > 1.8 * Math.max(1e-9, tMaxSec) &&
    foster[foster.length - 1].r / Math.max(1e-9, totalRFoster) > 0.65 &&
    extrapolationRatio > 1.7;
  const rthCredible =
    isFinite(totalRFoster) &&
    totalRFoster >= 1e-3 &&
    totalRFoster <= 400 &&
    isFinite(extrapolationRatio) &&
    extrapolationRatio <= 2.35 &&
    !tailOverDominated;
  checks.push({
    key: 'rth_credibility',
    label: '总热阻 Rth 可信度',
    passed: rthCredible,
    detail: rthCredible
      ? `实测末值 Z_end=${zMeasuredEnd.toFixed(3)} °C/W, 外推倍率 ${extrapolationRatio.toFixed(2)}×`
      : `总热阻 ${totalRFoster.toFixed(3)} °C/W 相对实测末值 Z_end=${zMeasuredEnd.toFixed(3)} °C/W 外推过大 (${isFinite(extrapolationRatio) ? extrapolationRatio.toFixed(2) + '×' : '∞'})`,
  });

  // 6. Fit Quality & Thermal Polarity
  const absSpan = Math.max(0, measuredSpanC);
  const fitQualityOk =
    measuredSpanC > 0.05 &&
    isFinite(rSquared) &&
    rSquared >= 0.85 &&
    (absSpan < 1.0 || rmseC <= 0.18 * absSpan);
  checks.push({
    key: 'fit_quality',
    label: '热响应方向与拟合优度',
    passed: fitQualityOk,
    detail: fitQualityOk
      ? `ΔT=${measuredSpanC.toFixed(2)} °C, R²=${rSquared.toFixed(4)}, RMSE=${rmseC.toFixed(3)} °C`
      : measuredSpanC <= 0.05
      ? `有效温升/温降幅度不足或方向相反 (ΔT=${measuredSpanC.toFixed(3)} °C，请检查 Heating/Cooling 模式与电源功率)`
      : `拟合优度不足 (R²=${rSquared.toFixed(4)}, RMSE=${rmseC.toFixed(3)} °C)`,
  });

  const passed = checks.every((c) => c.passed);
  const effectiveOrder = cauer.length;
  const orderReduced = passed && effectiveOrder < requestedOrder;
  const status: ThermalFitStatus = !passed ? 'failed' : orderReduced ? 'reduced' : 'valid';

  let summary = '';
  if (status === 'valid') {
    summary = `${effectiveOrder} 阶模型通过全部物理检查 (外推 ${extrapolationRatio.toFixed(2)}×, R²=${rSquared.toFixed(4)})`;
  } else if (status === 'reduced') {
    summary = `原 ${requestedOrder} 阶存在无效/极端参数，已自动重拟合并降阶至 ${effectiveOrder} 阶有效模型 (${rejectedReasons[0] || '自动降阶'})`;
  } else {
    const failedLabels = checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.detail}`);
    summary = `拟合判定失败: ${failedLabels.join('；')}`;
  }

  return {
    status,
    passed,
    requestedOrder,
    effectiveOrder,
    orderReduced,
    refitCount,
    extrapolationRatio,
    measuredSpanC,
    zMeasuredEnd,
    checks,
    rejectedReasons,
    summary,
  };
}

/**
 * Main Phase 1 Entry Point: Two-Stage Debiased LASSO Deconvolution + Physics-Audited Refit / Reduction + Cauer Synthesis.
 */
export function deconvolveThermalImpedance(
  rawTime: Float64Array,
  rawTemp: Float64Array,
  options: ThermalDeconvOptions
): ThermalDeconvResult {
  const warnings: string[] = [];
  const powerW = isFinite(options.powerW) && options.powerW > 1e-9 ? options.powerW : 1.0;
  const thermalPathMode: ThermalPathMode = options.thermalPathMode === 'pad_ambient' ? 'pad_ambient' : 'junction_ambient';
  const padSpreadRthCPerW =
    thermalPathMode === 'pad_ambient' && options.padSpreadRthCPerW !== undefined && isFinite(options.padSpreadRthCPerW)
      ? Math.max(0, options.padSpreadRthCPerW)
      : 0;

  // 1. Validate the raw acquisition before slicing. Silently deleting NaN samples
  // or truncating mismatched arrays can hide missing thermal transients and
  // produce a deceptively smooth, but physically unsupported, fitted Zth curve.
  if (rawTime.length !== rawTemp.length) {
    throw new Error(
      `热反演输入长度不一致：时间戳 ${rawTime.length} 点、温度 ${rawTemp.length} 点。禁止按较短数组静默截断。`
    );
  }
  for (let i = 0; i < rawTime.length; i++) {
    const ti = rawTime[i];
    if (!Number.isFinite(ti)) {
      throw new Error(`热反演时间轴在索引 ${i} 处存在 NaN/Inf 时间戳，已拒绝删除异常点后继续拟合。`);
    }
    if (i > 0 && !(ti > rawTime[i - 1])) {
      throw new Error(
        `时间轴在样本索引 ${i} 处非严格递增 (${ti.toFixed(6)}s <= ${rawTime[i - 1].toFixed(6)}s)，请先清洗或重采样后再执行热阻反演。`
      );
    }
  }

  // 2. Slice the requested window. Temperature samples outside the gate are
  // irrelevant; any invalid sample inside the gate makes the response incomplete.
  const slicedT: number[] = [];
  const slicedY: number[] = [];
  for (let i = 0; i < rawTime.length; i++) {
    const ti = rawTime[i];
    const yi = rawTemp[i];
    if (options.tStart !== undefined && ti < options.tStart) continue;
    if (options.tEnd !== undefined && ti > options.tEnd) continue;
    if (!Number.isFinite(yi)) {
      throw new Error(`温度通道在索引 ${i}、t=${ti.toFixed(6)}s 处存在 NaN/Inf，不能通过删除样本掩盖热响应缺失。`);
    }
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
  const tPreStepC = onset.tBase;

  // 3. Extract post-t0 response and handle Cooling sqrt(t) Tj(0) extrapolation & true T_amb
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

  const coolTailCount = Math.max(3, Math.floor(postTempAll.length * 0.08));
  const coolTailVals = postTempAll.slice(Math.max(0, postTempAll.length - coolTailCount));
  const tTailMedC = median(coolTailVals);

  const tBaseC =
    options.mode === 'heating'
      ? options.tAmbOverride !== undefined && isFinite(options.tAmbOverride)
        ? options.tAmbOverride
        : tPreStepC
      : tPreStepC;

  const tAmbC =
    options.tAmbOverride !== undefined && isFinite(options.tAmbOverride)
      ? options.tAmbOverride
      : options.mode === 'heating'
      ? tBaseC
      : tTailMedC;

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
    const maxAllowedTj0 = postTempAll[0] + Math.max(15, 0.6 * Math.max(0, postTempAll[0] - tAmbC));
    if (onset.onsetIdx > 0 && tPreStepC >= postTempAll[0]) {
      tJ0C = tPreStepC;
    } else if (isFinite(chosen) && chosen >= postTempAll[0] && chosen <= maxAllowedTj0) {
      tJ0C = chosen;
    } else {
      tJ0C = Math.max(tPreStepC, postTempAll[0]);
    }
    if (tJ0C <= postTempAll[postTempAll.length - 1]) {
      tJ0C = Math.max(postTempAll[0], tPreStepC);
    }
  }

  const measuredSpanC = options.mode === 'heating' ? tTailMedC - tBaseC : tJ0C - tTailMedC;
  const rawZthAll = postTempAll.map((tempVal) =>
    options.mode === 'heating' ? Math.max(0, (tempVal - tBaseC) / powerW) : Math.max(0, (tJ0C - tempVal) / powerW)
  );

  // Sampling step guards: use early-time step resolution for tau_min (supports log-spaced & adaptive captures)
  const stepDiffs: number[] = [];
  for (let i = 1; i < postDtAll.length; i++) {
    const d = postDtAll[i] - postDtAll[i - 1];
    if (d > 1e-15) stepDiffs.push(d);
  }
  const dtMedSec = stepDiffs.length > 0 ? median(stepDiffs) : postDtAll[0];
  let dtEarlySec = dtMedSec;
  if (stepDiffs.length >= 10) {
    const sortedDiffs = [...stepDiffs].sort((a, b) => a - b);
    const p5Step = sortedDiffs[Math.floor(sortedDiffs.length * 0.05)];
    dtEarlySec = Math.min(dtMedSec, Math.max(postDtAll[0], p5Step));
  } else if (postDtAll[0] > 0) {
    dtEarlySec = Math.min(dtMedSec, postDtAll[0]);
  }
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
  const tauMinSec = Math.max(1e-4, 0.5 * dtEarlySec);
  const tauMaxDefaultSec = Math.max(tauMinSec * 5, 3.0 * tMax);
  const M = fitDt.length;
  const tailZCount = Math.max(2, Math.floor(M * 0.08));
  const zMeasuredEnd = Math.max(0, median(Array.from(fitZth.slice(Math.max(0, M - tailZCount)))));

  if (M >= 8) {
    const tailLen = Math.max(3, Math.floor(M * 0.12));
    const tailStartZ = fitZth[M - tailLen];
    const tailEndZ = fitZth[M - 1];
    const spanZ = Math.max(1e-9, tailEndZ - fitZth[0]);
    if (Math.abs(tailEndZ - tailStartZ) / spanZ > 0.05) {
      warnings.push(
        `Curve has not reached full thermal steady state at end (${((Math.abs(tailEndZ - tailStartZ) / spanZ) * 100).toFixed(1)}% tail drift); τ_max initially capped at 3·t_max = ${tauMaxDefaultSec.toFixed(2)} s.`
      );
    }
  }
  if (dtEarlySec >= 0.2) {
    warnings.push(
      `Coarse sampling step Δt_early ≈ ${dtEarlySec.toFixed(3)} s: fast poles clamped to τ_min = ${tauMinSec.toFixed(3)} s (fast die transients below sampling resolution are absorbed).`
    );
  }

  let meanMeasT = 0;
  for (let i = 0; i < M; i++) meanMeasT += fitTempMeasured[i];
  meanMeasT /= M;
  let ssTot = 0;
  for (let i = 0; i < M; i++) {
    const dtMean = fitTempMeasured[i] - meanMeasT;
    ssTot += dtMean * dtMean;
  }

  const requestedOrder = options.targetOrder !== undefined ? Math.max(1, Math.min(8, Math.round(options.targetOrder))) : 3;

  interface CandidateSolveResult {
    tauMaxUsed: number;
    selectedLambda: number;
    sparseSpectrum: ThermalSpectrumBin[];
    mergedPoles: FosterStage[];
    reducedFoster: FosterStage[];
    reducedCauer: CauerStage[];
    cauerConv: ReturnType<typeof fosterToCauer>;
    fitZthPredicted: Float64Array;
    fitTempPredicted: Float64Array;
    residualTemp: Float64Array;
    rSquared: number;
    rmseC: number;
    audit: ThermalPhysicsAudit;
  }

  // Helper that solves LASSO spectrum once for a given tauMaxCapSec & lambda preference, then caches dictionary
  const solveDictionary = (tauMaxCapSec: number, orderHint: number) => {
    const effectiveTauMax = Math.max(tauMinSec * 3.5, tauMaxCapSec);
    const decades = Math.max(0.8, Math.log10(effectiveTauMax / tauMinSec));
    const P = Math.max(24, Math.min(120, Math.round(decades * 18)));
    const tauGrid = new Float64Array(P);
    const ANormCols: Float64Array[] = new Array(P);
    const colNorms = new Float64Array(P);

    for (let j = 0; j < P; j++) {
      const tau = tauMinSec * Math.pow(effectiveTauMax / tauMinSec, j / Math.max(1, P - 1));
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

    let lambdaMax = 0;
    for (let j = 0; j < P; j++) {
      let dot = 0;
      const col = ANormCols[j];
      for (let i = 0; i < M; i++) dot += col[i] * fitZth[i];
      if (dot > lambdaMax) lambdaMax = dot;
    }
    lambdaMax = Math.max(lambdaMax, 1e-9);

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

    let selectedLambda = options.lambdaOverride ?? 0;
    let lassoWeights: Float64Array;
    if (options.lambdaOverride !== undefined && options.lambdaOverride >= 0) {
      lassoWeights = solveNonNegLassoCD(ANormCols, colNorms, fitZth, selectedLambda, 2500).weights;
    } else {
      const numLambdas = 20;
      const candLambdas: number[] = [];
      const candRmses: number[] = [];
      const candK: number[] = [];
      const candWeights: Float64Array[] = [];
      let warmW: Float64Array | undefined = undefined;

      for (let li = 0; li < numLambdas; li++) {
        const exp = -0.5 - (li / (numLambdas - 1)) * 5.0;
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
      const hasEnoughOrderCandidates = candK.some((k, li) => k >= orderHint && isFinite(candRmses[li]));
      let bestScore = Infinity;
      let bestIdx = 0;
      for (let li = 0; li < numLambdas; li++) {
        if (candK[li] === 0 || !isFinite(candRmses[li])) continue;
        if (hasEnoughOrderCandidates && candK[li] < orderHint) continue;
        const relErr = Math.max(candRmses[li] / zSpan, 5e-4);
        const score = hasEnoughOrderCandidates
          ? Math.log(relErr * relErr) + 0.08 * (candK[li] - orderHint)
          : Math.log(relErr * relErr) + 0.32 * candK[li];
        if (score < bestScore) {
          bestScore = score;
          bestIdx = li;
        }
      }
      selectedLambda = candLambdas[bestIdx];
      lassoWeights = candWeights[bestIdx];
    }

    const sparseSpectrum: ThermalSpectrumBin[] = [];
    const totalL1R = lassoWeights.reduce((a, b) => a + b, 0);
    const rNoiseFloor = Math.max(1e-9, totalL1R * 1e-3);
    const rawClusters: Array<{ indices: number[] }> = [];
    let cur: { indices: number[] } | null = null;
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
      mergedTaus = [Math.sqrt(tauMinSec * effectiveTauMax)];
    }

    const AStar: Float64Array[] = new Array(M);
    for (let i = 0; i < M; i++) {
      const row = new Float64Array(mergedTaus.length);
      for (let k = 0; k < mergedTaus.length; k++) row[k] = 1 - Math.exp(-fitDt[i] / mergedTaus[k]);
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
          layerLabel: classifyThermalLayer(tau, thermalPathMode),
        });
      }
    }
    mergedPoles.sort((a, b) => a.tau - b.tau);

    return {
      tauMaxUsed: effectiveTauMax,
      selectedLambda,
      sparseSpectrum,
      mergedPoles,
    };
  };

  const evaluateCandidate = (
    dict: ReturnType<typeof solveDictionary>,
    orderToTry: number,
    allowSplit: boolean,
    refitCount: number,
    rejectedReasons: string[]
  ): CandidateSolveResult => {
    const reducedFoster = reduceFosterOrder(dict.mergedPoles, fitDt, fitZth, orderToTry, allowSplit).map((s) => ({
      ...s,
      layerLabel: classifyThermalLayer(s.tau, thermalPathMode),
    }));
    const cauerConv = fosterToCauer(reducedFoster);
    const reducedCauer = cauerConv.cauer.map((s) => ({
      ...s,
      layerLabel: classifyThermalLayer(s.tauEst, thermalPathMode),
    }));

    const fitZthPredicted = new Float64Array(M);
    const fitTempPredicted = new Float64Array(M);
    const residualTemp = new Float64Array(M);
    let ssRes = 0;
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
    }
    const rmseC = Math.sqrt(ssRes / M);
    const rSquared = ssTot > 1e-12 ? Math.max(0, 1 - ssRes / ssTot) : 1.0;

    const audit = auditThermalPhysics({
      foster: reducedFoster,
      cauer: reducedCauer,
      fosterCauerRelErr: cauerConv.relErr,
      hasDegenerateCauer: cauerConv.hasDegenerateStage,
      requestedOrder,
      zMeasuredEnd,
      tMaxSec: tMax,
      rSquared,
      rmseC,
      measuredSpanC,
      mode: options.mode,
      refitCount,
      rejectedReasons: [...rejectedReasons],
    });

    return {
      tauMaxUsed: dict.tauMaxUsed,
      selectedLambda: dict.selectedLambda,
      sparseSpectrum: dict.sparseSpectrum,
      mergedPoles: dict.mergedPoles,
      reducedFoster,
      reducedCauer,
      cauerConv,
      fitZthPredicted,
      fitTempPredicted,
      residualTemp,
      rSquared,
      rmseC,
      audit,
    };
  };

  // 6-8. Physics-Audited Fit, Refit & Automatic Order Reduction Loop
  const rejectedReasons: string[] = [];
  let refitCount = 0;

  const baseDict = solveDictionary(tauMaxDefaultSec, requestedOrder);
  let chosen = evaluateCandidate(baseDict, requestedOrder, true, 0, rejectedReasons);
  let bestDiagnostic = chosen;

  if (!chosen.audit.passed) {
    const failSummary = (c: CandidateSolveResult) =>
      c.audit.checks
        .filter((ck) => !ck.passed)
        .map((ck) => ck.detail)
        .join('; ');
    rejectedReasons.push(`${requestedOrder}阶初拟合失败: ${failSummary(chosen)}`);

    // Strategy A: Refit at requestedOrder without splitting, and tighten tau_max if over-extrapolated
    const rthCredFailed = !chosen.audit.checks.find((c) => c.key === 'rth_credibility')?.passed;
    const tauCaps = rthCredFailed ? [1.6 * tMax, 1.0 * tMax] : [tauMaxDefaultSec, 1.3 * tMax];
    let foundValid = false;

    for (const cap of tauCaps) {
      refitCount++;
      const d = cap === tauMaxDefaultSec ? baseDict : solveDictionary(cap, requestedOrder);
      const allowSplitCand = d.mergedPoles.length < requestedOrder;
      const cand = evaluateCandidate(d, requestedOrder, allowSplitCand, refitCount, rejectedReasons);
      if (cand.audit.passed && cand.reducedCauer.length === requestedOrder) {
        chosen = cand;
        foundValid = true;
        break;
      }
      if (cand.audit.passed && (!bestDiagnostic.audit.passed || cand.rSquared > bestDiagnostic.rSquared)) {
        bestDiagnostic = cand;
      }
      if (!cand.audit.passed) {
        rejectedReasons.push(`重拟合(N=${requestedOrder}, τmax=${cap.toFixed(2)}s)未通过: ${failSummary(cand)}`);
      }
    }

    // Strategy B: Automatic Order Reduction (降阶: N-1 -> ... -> 1)
    if (!foundValid) {
      for (let ord = requestedOrder - 1; ord >= 1; ord--) {
        const capsToTry = rthCredFailed ? [1.6 * tMax, 1.0 * tMax, tauMaxDefaultSec] : [tauMaxDefaultSec, 1.3 * tMax];
        for (const cap of capsToTry) {
          refitCount++;
          const d = solveDictionary(cap, ord);
          const cand = evaluateCandidate(d, ord, false, refitCount, rejectedReasons);
          if (cand.audit.passed) {
            chosen = cand;
            foundValid = true;
            break;
          }
          if (cand.rSquared > bestDiagnostic.rSquared && !bestDiagnostic.audit.passed) {
            bestDiagnostic = cand;
          }
        }
        if (foundValid) break;
        rejectedReasons.push(`降阶至 ${ord} 阶仍未通过物理检验`);
      }
    }

    if (!foundValid) {
      chosen = bestDiagnostic;
    }
  }

  // Re-finalize physics audit with latest refitCount and rejectedReasons
  const finalAudit = auditThermalPhysics({
    foster: chosen.reducedFoster,
    cauer: chosen.reducedCauer,
    fosterCauerRelErr: chosen.cauerConv.relErr,
    hasDegenerateCauer: chosen.cauerConv.hasDegenerateStage,
    requestedOrder,
    zMeasuredEnd,
    tMaxSec: tMax,
    rSquared: chosen.rSquared,
    rmseC: chosen.rmseC,
    measuredSpanC,
    mode: options.mode,
    refitCount,
    rejectedReasons,
  });

  if (finalAudit.status === 'reduced') {
    warnings.push(finalAudit.summary);
  } else if (finalAudit.status === 'failed') {
    warnings.unshift(finalAudit.summary);
  }

  const reducedFoster = chosen.reducedFoster.map((s) => ({ ...s }));
  const reducedCauer = chosen.reducedCauer.map((s) => ({ ...s }));

  // Optional Pad -> Sensor PCB copper spreading resistance compensation when measuring beside MOS on PCB
  let totalRthFoster = chosen.cauerConv.totalRthFoster;
  let totalRthCauer = chosen.cauerConv.totalRthCauer;
  const tauSpreadSec = Math.max(tauMinSec, Math.min(0.015, tMax * 0.02));
  if (thermalPathMode === 'pad_ambient' && padSpreadRthCPerW > 1e-6) {
    const spreadC = tauSpreadSec / padSpreadRthCPerW;
    reducedCauer.unshift({
      r: padSpreadRthCPerW,
      c: spreadC,
      tauEst: tauSpreadSec,
      layerLabel: '焊盘→测点扩散补偿 (R_spread)',
    });
    reducedFoster.unshift({
      r: padSpreadRthCPerW,
      c: spreadC,
      tau: tauSpreadSec,
      layerLabel: '焊盘→测点扩散补偿 (R_spread)',
    });
    totalRthFoster += padSpreadRthCPerW;
    totalRthCauer += padSpreadRthCPerW;
    warnings.push(
      `已计入芯片焊盘→PCB测点扩展热阻补偿 R_spread = ${padSpreadRthCPerW.toFixed(3)} °C/W：Rth,pad-a = ${totalRthCauer.toFixed(3)} °C/W (实测点 Rth = ${chosen.cauerConv.totalRthCauer.toFixed(3)} °C/W)。`
    );
  }

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
  for (const st of reducedCauer) {
    rCum += st.r;
    cCum += st.c;
    structureFunction.push({ rCum, cCum, layerLabel: st.layerLabel });
  }

  const subcktName = thermalPathMode === 'pad_ambient' ? 'PAD_THERM' : 'MOS_THERM';
  const heatNode = thermalPathMode === 'pad_ambient' ? 'PAD' : 'TJ';
  const spiceNetlist = cauerToSpice(reducedCauer, tAmbC, subcktName, heatNode);
  const spiceValidation = validateCauerSpiceNetlist(spiceNetlist, totalRthCauer, heatNode);

  return {
    mode: options.mode,
    thermalPathMode,
    padSpreadRthCPerW,
    powerW,
    t0Sec,
    tBaseC,
    tAmbC,
    tJ0C,
    tauMinSec,
    tauMaxSec: chosen.tauMaxUsed,
    dtMedSec,
    usedLogBinning,
    rawPointCount: postDtAll.length,
    fitPointCount: M,
    selectedLambda: chosen.selectedLambda,
    warnings,
    fitTimeRel: fitDt,
    fitTempMeasured,
    fitTempPredicted: chosen.fitTempPredicted,
    fitZthMeasured: fitZth,
    fitZthPredicted: chosen.fitZthPredicted,
    residualTemp: chosen.residualTemp,
    smoothAbsTime,
    smoothTemp,
    sparseSpectrum: chosen.sparseSpectrum,
    mergedPoles: chosen.mergedPoles,
    reducedFoster,
    reducedCauer,
    structureFunction,
    totalRthFoster,
    totalRthCauer,
    fosterCauerRelErr: chosen.cauerConv.relErr,
    rSquared: chosen.rSquared,
    rmseC: chosen.rmseC,
    spiceNetlist,
    spiceValidation,
    physicsAudit: finalAudit,
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
    const p = Math.max(0, power[i - 1]);
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
 * Integrates nonlinear Qoss(V) [nC vs V] via E_oss(V) = int_0^V v dQ_oss(v)
 * returning a strictly monotonic E_oss(V) curve in microjoules (µJ).
 */
export function integrateQossToEossCurve(qossPoints: CossCurvePoint[], label?: string): NonlinearEossCurve {
  if (!qossPoints || qossPoints.length < 2) {
    throw new Error('Qoss(V) 曲线至少需要 2 个单调递增的 Vds 数据点。');
  }
  const sorted = [...qossPoints].sort((a, b) => a.vdsV - b.vdsV);
  if (Math.abs(sorted[0]?.vdsV ?? Infinity) > 1e-6 || Math.abs(sorted[0]?.val ?? Infinity) > 1e-6) {
    throw new Error('Qoss(V) 必须包含 (0V, 0nC) 原点；缺少原点时不能凭空假设 0V 到首个数据点之间的电荷积分。');
  }
  for (let i = 0; i < sorted.length; i++) {
    if (!Number.isFinite(sorted[i].vdsV) || sorted[i].vdsV < 0 || !Number.isFinite(sorted[i].val) || sorted[i].val < 0) {
      throw new Error(`Qoss(V) 第 ${i + 1} 点包含负值或非有限值。`);
    }
    if (i > 0) {
      if (sorted[i].vdsV <= sorted[i - 1].vdsV) {
        throw new Error(`Qoss(V) 电压点 ${sorted[i].vdsV}V 存在重复或未严格递增。`);
      }
      if (sorted[i].val < sorted[i - 1].val - 1e-9) {
        throw new Error(`Qoss(V) 在 ${sorted[i].vdsV}V 处电荷量下降，违背物理单调增特性。`);
      }
    }
  }
  const out: CossCurvePoint[] = [];
  let accumUj = 0;
  if (sorted[0].vdsV > 1e-6) {
    out.push({ vdsV: 0, val: 0 });
    accumUj = 0.5 * sorted[0].vdsV * sorted[0].val * 1e-3;
    out.push({ vdsV: sorted[0].vdsV, val: accumUj });
  } else {
    out.push({ vdsV: sorted[0].vdsV, val: 0 });
  }
  for (let i = 1; i < sorted.length; i++) {
    const v0 = sorted[i - 1].vdsV;
    const v1 = sorted[i].vdsV;
    const dQ = Math.max(0, sorted[i].val - sorted[i - 1].val);
    accumUj += 0.5 * (v0 + v1) * dQ * 1e-3;
    out.push({ vdsV: v1, val: accumUj });
  }
  return {
    kind: 'eoss_uj',
    points: out,
    label: label || 'Qoss(V) 积分 Eoss(V)',
  };
}

/**
 * Integrates Coss(V) [pF vs V] via E_oss(V) = int_0^V v C(v) dv
 * returning a strictly monotonic E_oss(V) curve in microjoules (µJ).
 */
export function integrateCossToEossCurve(cossPoints: CossCurvePoint[], label?: string): NonlinearEossCurve {
  if (!cossPoints || cossPoints.length < 2) {
    throw new Error('Coss(V) 曲线至少需要 2 个单调递增的 Vds 数据点。');
  }
  const sorted = [...cossPoints].sort((a, b) => a.vdsV - b.vdsV);
  if (Math.abs(sorted[0]?.vdsV ?? Infinity) > 1e-6) {
    throw new Error('Coss(V) 必须包含 0V 起点；缺少低压曲线时无法可靠积分 Eoss(0→V)。');
  }
  for (let i = 0; i < sorted.length; i++) {
    if (!Number.isFinite(sorted[i].vdsV) || sorted[i].vdsV < 0 || !Number.isFinite(sorted[i].val) || sorted[i].val < 0) {
      throw new Error(`Coss(V) 第 ${i + 1} 点包含负值或非有限值。`);
    }
    if (i > 0 && sorted[i].vdsV <= sorted[i - 1].vdsV) {
      throw new Error(`Coss(V) 电压点 ${sorted[i].vdsV}V 存在重复或未严格递增。`);
    }
  }
  const out: CossCurvePoint[] = [];
  let accumUj = 0;
  if (sorted[0].vdsV > 1e-6) {
    out.push({ vdsV: 0, val: 0 });
    accumUj = 0.5 * sorted[0].vdsV * sorted[0].vdsV * sorted[0].val * 1e-6;
    out.push({ vdsV: sorted[0].vdsV, val: accumUj });
  } else {
    out.push({ vdsV: sorted[0].vdsV, val: 0 });
  }
  for (let i = 1; i < sorted.length; i++) {
    const v0 = sorted[i - 1].vdsV;
    const v1 = sorted[i].vdsV;
    const c0 = sorted[i - 1].val;
    const c1 = sorted[i].val;
    const dV = v1 - v0;
    const slope = (c1 - c0) / dV;
    const intVC =
      c0 * 0.5 * (v1 * v1 - v0 * v0) +
      slope * ((v1 * v1 * v1 - v0 * v0 * v0) / 3 - v0 * 0.5 * (v1 * v1 - v0 * v0));
    accumUj += Math.max(0, intVC) * 1e-6;
    out.push({ vdsV: v1, val: accumUj });
  }
  return {
    kind: 'eoss_uj',
    points: out,
    label: label || 'Coss(V) 积分 Eoss(V)',
  };
}

/**
 * Fritsch-Carlson Monotone Piecewise Cubic Hermite Interpolation (PCHIP).
 */
export function evaluatePchipMonotone(
  points: CossCurvePoint[],
  xQuery: number
): { value: number; outOfRange: boolean; domain: [number, number] } {
  if (!points || points.length < 2) {
    throw new Error('PCHIP 曲线至少需要 2 个采样点。');
  }
  const pts = [...points].sort((a, b) => a.vdsV - b.vdsV);
  const n = pts.length;
  const h = new Array<number>(n - 1);
  const delta = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = pts[i + 1].vdsV - pts[i].vdsV;
    if (!(h[i] > 0)) throw new Error('PCHIP 曲线电压轴必须严格单调递增。');
    delta[i] = (pts[i + 1].val - pts[i].val) / h[i];
  }

  const domain: [number, number] = [pts[0].vdsV, pts[n - 1].vdsV];
  const outOfRange = xQuery < domain[0] - 1e-6 || xQuery > domain[1] + 1e-6;
  const x = Math.max(domain[0], Math.min(domain[1], xQuery));

  if (n === 2) {
    const t = (x - pts[0].vdsV) / h[0];
    return {
      value: Math.max(0, pts[0].val + t * (pts[1].val - pts[0].val)),
      outOfRange,
      domain,
    };
  }

  const d = new Array<number>(n).fill(0);
  for (let k = 1; k < n - 1; k++) {
    if (delta[k - 1] * delta[k] > 0) {
      const w1 = 2 * h[k] + h[k - 1];
      const w2 = h[k] + 2 * h[k - 1];
      d[k] = (w1 + w2) / (w1 / delta[k - 1] + w2 / delta[k]);
    }
  }
  const edgeSlope = (h0: number, h1: number, del0: number, del1: number) => {
    let val = ((2 * h0 + h1) * del0 - h0 * del1) / (h0 + h1);
    if (Math.sign(val) !== Math.sign(del0)) val = 0;
    else if (Math.sign(del0) !== Math.sign(del1) && Math.abs(val) > Math.abs(3 * del0)) {
      val = 3 * del0;
    }
    return val;
  };
  d[0] = edgeSlope(h[0], h[1], delta[0], delta[1]);
  d[n - 1] = edgeSlope(h[n - 2], h[n - 3], delta[n - 2], delta[n - 3]);

  let seg = 0;
  while (seg < n - 2 && x > pts[seg + 1].vdsV) seg++;
  const s = (x - pts[seg].vdsV) / h[seg];
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  const val = h00 * pts[seg].val + h10 * h[seg] * d[seg] + h01 * pts[seg + 1].val + h11 * h[seg] * d[seg + 1];
  return { value: Math.max(0, val), outOfRange, domain };
}

/**
 * Validates and imports a versioned Eoss/Qoss/Coss curve document.
 * All values are normalized to V and the unit implied by `kind` before integration.
 */
export function parseEossCurveImportJson(text: string): NonlinearEossCurve {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (err) {
    throw new Error(`Eoss 曲线 JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== 'object') throw new Error('Eoss 曲线导入文件必须是 JSON 对象。');
  const doc = raw as Partial<EossCurveImportDocument>;
  if (doc.schema !== 'wave-test-eoss-curve' || doc.schemaVersion !== 1 || !doc.kind || !Array.isArray(doc.points) || doc.points.length < 2) {
    throw new Error('Eoss 曲线文件格式不匹配：需要 wave-test-eoss-curve v1、kind 和至少 2 个 points。');
  }
  const voltageScale = doc.voltageUnit === 'mV' ? 1e-3 : doc.voltageUnit === 'V' ? 1 : NaN;
  const valueScale: Record<string, number> = { uJ: 1, nJ: 1e-3, mJ: 1e3, nC: 1, uC: 1e3, pF: 1, nF: 1e3 };
  const valScale = doc.valueUnit ? valueScale[doc.valueUnit] : undefined;
  const allowedUnit = doc.kind === 'eoss_uj' ? ['uJ', 'nJ', 'mJ'] : doc.kind === 'qoss_nc' ? ['nC', 'uC'] : ['pF', 'nF'];
  if (!Number.isFinite(voltageScale) || !doc.valueUnit || !allowedUnit.includes(doc.valueUnit) || !Number.isFinite(valScale)) {
    throw new Error(`Eoss 曲线单位不匹配：${doc.kind} 的电压单位必须为 V/mV，数值单位必须为 ${allowedUnit.join('/') }。`);
  }
  const points = doc.points.map((pt, i) => {
    if (!pt || !Number.isFinite(pt.vds) || !Number.isFinite(pt.value)) throw new Error(`Eoss 曲线第 ${i + 1} 点包含非有限数值。`);
    return { vdsV: pt.vds * voltageScale, val: pt.value * valScale! };
  }).sort((a, b) => a.vdsV - b.vdsV);
  for (let i = 0; i < points.length; i++) {
    if (points[i].vdsV < 0 || points[i].val < 0 || (i > 0 && points[i].vdsV <= points[i - 1].vdsV)) {
      throw new Error(`Eoss 曲线第 ${i + 1} 点存在负值或重复电压点。`);
    }
  }
  const allowedProvenance: EossCurveProvenance[] = ['datasheet', 'dpt_measured', 'user_import', 'preset', 'assumed'];
  const provenance = doc.provenance ?? 'user_import';
  if (!allowedProvenance.includes(provenance)) throw new Error(`Eoss 曲线 provenance 非法：${String(provenance)}。`);
  const meta = {
    label: doc.label || 'Imported nonlinear MOS output-capacitance curve',
    provenance: provenance as EossCurveProvenance,
    manufacturer: doc.manufacturer,
    partNumber: doc.partNumber,
    referenceTemperatureC: doc.referenceTemperatureC,
    testVgsV: doc.testVgsV,
    rgOnOhm: doc.rgOnOhm,
    rgOffOhm: doc.rgOffOhm,
    sourceNote: 'Imported user curve; test conditions are metadata and are not inferred when absent.',
  };
  const curve = doc.kind === 'qoss_nc'
    ? integrateQossToEossCurve(points, meta.label)
    : doc.kind === 'coss_pf'
      ? integrateCossToEossCurve(points, meta.label)
      : { kind: 'eoss_uj' as const, points, label: meta.label };
  const result: NonlinearEossCurve = { ...curve, ...meta };
  validateNonlinearEossCurve(result);
  return result;
}

export function parseEossCurveCsv(
  csvText: string,
  kind: EossCurveImportDocument['kind'],
  voltageUnit: 'V' | 'mV',
  valueUnit: EossCurveImportDocument['valueUnit'],
  metadata: Partial<Omit<EossCurveImportDocument, 'schema' | 'schemaVersion' | 'kind' | 'voltageUnit' | 'valueUnit' | 'points'>> = {}
): NonlinearEossCurve {
  const rows = csvText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const points: Array<{ vds: number; value: number }> = [];
  for (const [idx, row] of rows.entries()) {
    const cols = row.split(/[;,\t]/).map((v) => v.trim());
    if (cols.length < 2) continue;
    const voltage = Number(cols[0]);
    const value = Number(cols[1]);
    if (!Number.isFinite(voltage) || !Number.isFinite(value)) {
      if (idx === 0 && /[a-z]/i.test(row)) continue; // Optional header row.
      throw new Error(`Eoss CSV 第 ${idx + 1} 行不是有效的两列数值。`);
    }
    points.push({ vds: voltage, value });
  }
  return parseEossCurveImportJson(JSON.stringify({
    schema: 'wave-test-eoss-curve', schemaVersion: 1, kind, voltageUnit, valueUnit,
    provenance: metadata.provenance || 'user_import', ...metadata, points,
  }));
}

export function validateNonlinearEossCurve(curve: NonlinearEossCurve): void {
  if (!curve || !Array.isArray(curve.points) || curve.points.length < 2) throw new Error('非线性 Eoss 曲线至少需要 2 个点。');
  const allowedProvenance: EossCurveProvenance[] = ['datasheet', 'dpt_measured', 'user_import', 'preset', 'assumed'];
  if (curve.provenance !== undefined && !allowedProvenance.includes(curve.provenance)) throw new Error(`Eoss 曲线 provenance 非法：${String(curve.provenance)}。`);
  for (let i = 0; i < curve.points.length; i++) {
    const pt = curve.points[i];
    if (!Number.isFinite(pt.vdsV) || !Number.isFinite(pt.val) || pt.vdsV < 0 || pt.val < 0) throw new Error(`Eoss 曲线第 ${i + 1} 点包含负值或 NaN/Inf。`);
    if (i > 0 && pt.vdsV <= curve.points[i - 1].vdsV) throw new Error('Eoss 曲线电压轴必须严格递增，禁止重复/倒序。');
    if (curve.kind === 'eoss_uj' && i > 0 && pt.val < curve.points[i - 1].val - 1e-9) throw new Error('Eoss(V) 必须单调不减。');
  }
  if (curve.kind === 'eoss_uj' && (Math.abs(curve.points[0].vdsV) > 1e-6 || Math.abs(curve.points[0].val) > 1e-6)) {
    throw new Error('Eoss(V) 必须包含 (0V, 0uJ) 原点。');
  }
  for (const [label, value] of [['referenceTemperatureC', curve.referenceTemperatureC], ['testVgsV', curve.testVgsV], ['rgOnOhm', curve.rgOnOhm], ['rgOffOhm', curve.rgOffOhm]] as const) {
    if (value !== undefined && !Number.isFinite(value)) throw new Error(`Eoss 曲线元数据 ${label} 必须为有限数值。`);
  }
  if (curve.referenceTemperatureC !== undefined && (curve.referenceTemperatureC < -100 || curve.referenceTemperatureC > 300)) {
    throw new Error('Eoss 曲线参考温度超出合理元数据范围 [-100,300]°C。');
  }
  for (const [label, value] of [['rgOnOhm', curve.rgOnOhm], ['rgOffOhm', curve.rgOffOhm]] as const) {
    if (value !== undefined && value <= 0) throw new Error(`Eoss 曲线元数据 ${label} 必须为正数。`);
  }
}

export function createEossCurveImportTemplate(kind: EossCurveImportDocument['kind'] = 'eoss_uj'): EossCurveImportDocument {
  const valueUnit: EossCurveImportDocument['valueUnit'] = kind === 'eoss_uj' ? 'uJ' : kind === 'qoss_nc' ? 'nC' : 'pF';
  return {
    schema: 'wave-test-eoss-curve', schemaVersion: 1, kind, voltageUnit: 'V', valueUnit,
    label: '请填写具体 MOS 型号的 Eoss/Qoss/Coss 曲线', provenance: 'datasheet',
    manufacturer: '', partNumber: '', referenceTemperatureC: 25,
    points: kind === 'coss_pf'
      ? [{ vds: 0, value: 1000 }, { vds: 10, value: 500 }]
      : [{ vds: 0, value: 0 }, { vds: 10, value: 10 }],
  };
}

export function evaluateNonlinearEossUj(
  curve: NonlinearEossCurve,
  vBusV: number,
  options?: { allowOutOfDomainClamp?: boolean }
): EossCurveEvalResult {
  validateNonlinearEossCurve(curve);
  if (!Number.isFinite(vBusV) || vBusV < 0) throw new Error('Eoss 曲线查询电压必须为有限非负数值。');
  const eossPts =
    curve.kind === 'qoss_nc'
      ? integrateQossToEossCurve(curve.points).points
      : curve.kind === 'coss_pf'
      ? integrateCossToEossCurve(curve.points).points
      : [...curve.points].sort((a, b) => a.vdsV - b.vdsV);

  for (let i = 0; i < eossPts.length; i++) {
    if (!Number.isFinite(eossPts[i].vdsV) || eossPts[i].vdsV < 0 || !Number.isFinite(eossPts[i].val) || eossPts[i].val < 0) {
      throw new Error(`Eoss(V) 曲线第 ${i + 1} 点含非法负值或 NaN/Inf。`);
    }
    if (i > 0 && eossPts[i].vdsV <= eossPts[i - 1].vdsV) {
      throw new Error(`Eoss(V) 曲线电压点 ${eossPts[i].vdsV}V 存在重复或非单调。`);
    }
  }

  const vSafe = Math.max(0, Number.isFinite(vBusV) ? vBusV : 0);
  const domain: [number, number] = [eossPts[0].vdsV, eossPts[eossPts.length - 1].vdsV];
  const warnings: string[] = [];

  const belowDomain = vSafe < domain[0] - 1e-6;
  const aboveDomain = vSafe > domain[1] + 1e-6;
  if (belowDomain || aboveDomain) {
    if (options?.allowOutOfDomainClamp === false) {
      const side = belowDomain ? '下限' : '上限';
      throw new Error(
        `母线电压 ${vSafe.toFixed(1)}V 超出 Eoss(V)/Qoss(V) 曲线定义域 [${domain[0]}V, ${domain[1]}V]${side}，已拒绝边界截断或无依据外推。`
      );
    }
    warnings.push(
      `母线电压 ${vSafe.toFixed(1)}V 超出 Eoss(V) 曲线定义域 [${domain[0]}V, ${domain[1]}V]，当前仅返回边界/比例预览值，不能用于签核。`
    );
  }
  if (belowDomain && domain[0] > 1e-6) {
    const f = vSafe / domain[0];
    return {
      eossUj: eossPts[0].val * f * f,
      outOfRange: true,
      domain,
      warnings,
    };
  }

  const res = evaluatePchipMonotone(eossPts, vSafe);
  return {
    eossUj: res.value,
    outOfRange: res.outOfRange,
    domain: res.domain,
    warnings,
  };
}

interface CauerScratch {
  aSub: Float64Array;
  bDiag: Float64Array;
  cSup: Float64Array;
  rhs: Float64Array;
  cPrime: Float64Array;
  dPrime: Float64Array;
  ckOverSubDt: Float64Array;
  t1: Float64Array;
  t2: Float64Array;
}

function createCauerScratch(m: number): CauerScratch {
  const len = Math.max(1, m);
  return {
    aSub: new Float64Array(len),
    bDiag: new Float64Array(len),
    cSup: new Float64Array(len),
    rhs: new Float64Array(len),
    cPrime: new Float64Array(len),
    dPrime: new Float64Array(len),
    ckOverSubDt: new Float64Array(len),
    t1: new Float64Array(len),
    t2: new Float64Array(len),
  };
}

function singleCauerBackwardEuler(
  cauer: CauerStage[],
  tIn: Float64Array,
  tOut: Float64Array,
  dt: number,
  pW: number,
  tAmbC: number,
  sc: CauerScratch
): void {
  const m = cauer.length;
  for (let k = 0; k < m; k++) {
    sc.ckOverSubDt[k] = cauer[k].c / dt;
    const gLeft = k > 0 ? 1 / cauer[k - 1].r : 0;
    const gRight = 1 / cauer[k].r;
    sc.aSub[k] = k > 0 ? -gLeft : 0;
    sc.bDiag[k] = sc.ckOverSubDt[k] + gLeft + gRight;
    sc.cSup[k] = k < m - 1 ? -gRight : 0;
  }
  sc.cPrime[0] = m > 1 ? sc.cSup[0] / sc.bDiag[0] : 0;
  for (let k = 1; k < m; k++) {
    const denom = sc.bDiag[k] - sc.aSub[k] * sc.cPrime[k - 1];
    sc.cPrime[k] = k < m - 1 ? sc.cSup[k] / denom : 0;
  }
  const gLast = 1 / cauer[m - 1].r;
  const ambTerm = tAmbC * gLast;
  for (let k = 0; k < m; k++) {
    sc.rhs[k] = sc.ckOverSubDt[k] * tIn[k] + (k === 0 ? pW : 0) + (k === m - 1 ? ambTerm : 0);
  }
  sc.dPrime[0] = sc.rhs[0] / sc.bDiag[0];
  for (let k = 1; k < m; k++) {
    const denom = sc.bDiag[k] - sc.aSub[k] * sc.cPrime[k - 1];
    sc.dPrime[k] = (sc.rhs[k] - sc.aSub[k] * sc.dPrime[k - 1]) / denom;
  }
  tOut[m - 1] = sc.dPrime[m - 1];
  for (let k = m - 2; k >= 0; k--) {
    tOut[k] = sc.dPrime[k] - sc.cPrime[k] * tOut[k + 1];
  }
}

/**
 * Adaptive step-doubling Backward-Euler Cauer ODE integrator across ALL thermal nodes.
 * Enforces initial step h <= 0.05 * tau_min and verifies global node error |T2 - T1| <= tol
 * without artificial 32/64 substep caps.
 */
function advanceCauerAdaptive(
  cauer: CauerStage[],
  nodeT: Float64Array,
  dtTotal: number,
  pW: number,
  tAmbC: number,
  minTau: number,
  maxTau: number,
  sc: CauerScratch
): {
  substepsUsed: number;
  minStepSec: number;
  peakStepErrorC: number;
  hitStepCap: boolean;
} {
  const m = cauer.length;
  if (m === 0 || dtTotal <= 0) {
    return { substepsUsed: 0, minStepSec: dtTotal, peakStepErrorC: 0, hitStepCap: false };
  }
  const MAX_SUBSTEPS = 32768;
  const hInitMax = Math.max(1e-12, 0.05 * minTau);
  // Once fast modes decay (elapsed > 8 * minTau) under constant pW, step-doubling
  // error control may relax h up to 0.05 * maxTau while preserving strict tolerance across all nodes.
  const hSlowMax = Math.max(hInitMax, 0.02 * maxTau);
  let h = Math.min(dtTotal, hInitMax);
  let elapsed = 0;
  let substepsUsed = 0;
  let minStepSec = h;
  let peakStepErrorC = 0;
  let hitStepCap = false;
  const tempMid = new Float64Array(m);

  while (elapsed < dtTotal - 1e-15 * Math.max(1, dtTotal)) {
    if (substepsUsed >= MAX_SUBSTEPS) {
      hitStepCap = true;
      break;
    }
    const rem = dtTotal - elapsed;
    const hMaxNow = elapsed < 8 * minTau ? hInitMax : hSlowMax;
    const hTry = Math.min(rem, h, hMaxNow);

    // Coarse full step (T1) and two fine half steps (T2)
    singleCauerBackwardEuler(cauer, nodeT, sc.t1, hTry, pW, tAmbC, sc);
    singleCauerBackwardEuler(cauer, nodeT, tempMid, 0.5 * hTry, pW, tAmbC, sc);
    singleCauerBackwardEuler(cauer, tempMid, sc.t2, 0.5 * hTry, pW, tAmbC, sc);

    let maxErr = 0;
    let worstRatio = 0;
    for (let k = 0; k < m; k++) {
      const errK = Math.abs(sc.t2[k] - sc.t1[k]);
      const tolK = 0.001 + 1e-4 * Math.max(1, Math.abs(sc.t2[k] - tAmbC));
      if (errK > maxErr) maxErr = errK;
      const ratio = errK / tolK;
      if (ratio > worstRatio) worstRatio = ratio;
    }

    if (worstRatio <= 1 || hTry <= Math.max(1e-15, dtTotal * 1e-11)) {
      for (let k = 0; k < m; k++) nodeT[k] = sc.t2[k];
      elapsed += hTry;
      substepsUsed++;
      if (hTry < minStepSec) minStepSec = hTry;
      if (maxErr > peakStepErrorC) peakStepErrorC = maxErr;

      // Grow step conservatively if error is well within tolerance
      if (worstRatio < 0.15) {
        h = Math.min(hMaxNow, hTry * 1.8);
      } else if (worstRatio < 0.5) {
        h = Math.min(hMaxNow, hTry * 1.25);
      } else {
        h = Math.min(hMaxNow, hTry);
      }
    } else {
      h = Math.max(1e-15, 0.5 * hTry);
      substepsUsed++;
    }
  }

  return { substepsUsed, minStepSec, peakStepErrorC, hitStepCap };
}

/**
 * Exact O(N) adaptive step-doubling Backward-Euler Cauer ladder simulator with diagnostics.
 * Guarantees h <= 0.05 * tau_min initially and full-vector node convergence across every RC node.
 */
export function simulateCauerZohWithDiagnostics(
  time: Float64Array,
  power: Float32Array | Float64Array,
  cauer: CauerStage[],
  tAmbC: number
): CauerZohResult {
  if (time.length !== power.length) {
    throw new Error(`Cauer 热求解时间和值数组长度不一致：time=${time.length}, power=${power.length}。`);
  }
  if (time.length === 0) {
    throw new Error('Cauer 热求解至少需要一个时间/功率样本。');
  }
  if (!Number.isFinite(tAmbC)) throw new Error('Cauer 热求解环境温度必须为有限值。');
  for (let i = 0; i < time.length; i++) {
    if (!Number.isFinite(time[i])) throw new Error(`Cauer 热求解时间戳第 ${i + 1} 点不是有限值。`);
    if (i > 0 && time[i] <= time[i - 1]) throw new Error(`Cauer 热求解时间轴在第 ${i + 1} 点重复或倒退。`);
    if (!Number.isFinite(power[i]) || power[i] < -1e-12) {
      throw new Error(`Cauer 热求解功率第 ${i + 1} 点不是有限非负值，拒绝按零功率替代。`);
    }
  }
  for (let i = 0; i < cauer.length; i++) {
    if (!Number.isFinite(cauer[i].r) || cauer[i].r <= 0 || !Number.isFinite(cauer[i].c) || cauer[i].c <= 0) {
      throw new Error(`Cauer 热网络第 ${i + 1} 阶 R/C 必须为有限正数。`);
    }
  }
  const n = time.length;
  const tj = new Float32Array(n);
  const m = cauer.length;
  if (n === 0) {
    return {
      tj,
      maxSubsteps: 0,
      minActualStepSec: 0,
      peakTempErrorC: 0,
      solverStatus: 'CONVERGED',
      warnings: [],
    };
  }
  if (m === 0) {
    tj.fill(tAmbC);
    return {
      tj,
      maxSubsteps: 0,
      minActualStepSec: 0,
      peakTempErrorC: 0,
      solverStatus: 'CONVERGED',
      warnings: [],
    };
  }

  let minTau = Infinity;
  let maxTau = 0;
  for (let k = 0; k < m; k++) {
    const tauK = cauer[k].r * cauer[k].c;
    if (isFinite(tauK) && tauK > 1e-12) {
      if (tauK < minTau) minTau = tauK;
      if (tauK > maxTau) maxTau = tauK;
    }
  }
  if (!isFinite(minTau)) minTau = 1e-4;
  if (!(maxTau > 0)) maxTau = minTau;

  const nodeT = new Float64Array(m).fill(tAmbC);
  tj[0] = tAmbC;

  const sc = createCauerScratch(m);
  let maxSubsteps = 1;
  let minActualStepSec = Infinity;
  let peakTempErrorC = 0;
  let hitStepCap = false;

  for (let i = 1; i < n; i++) {
    const dt = Math.max(0, time[i] - time[i - 1]);
    if (dt <= 0) {
      tj[i] = nodeT[0];
      continue;
    }
    const p = Math.max(0, power[i - 1]);
    const stepDiag = advanceCauerAdaptive(cauer, nodeT, dt, p, tAmbC, minTau, maxTau, sc);
    if (stepDiag.substepsUsed > maxSubsteps) maxSubsteps = stepDiag.substepsUsed;
    if (stepDiag.minStepSec < minActualStepSec) minActualStepSec = stepDiag.minStepSec;
    if (stepDiag.peakStepErrorC > peakTempErrorC) peakTempErrorC = stepDiag.peakStepErrorC;
    if (stepDiag.hitStepCap) hitStepCap = true;
    tj[i] = nodeT[0];
  }

  const warnings: string[] = [];
  if (hitStepCap) {
    warnings.push(
      `Cauer 热网络求解达到单步最大子步保护上限 (32768)，请检查极短热时间常数或过大采样步长；当前节点最大估计误差 ${peakTempErrorC.toExponential(2)}°C。`
    );
  }

  return {
    tj,
    maxSubsteps,
    minActualStepSec: Number.isFinite(minActualStepSec) ? minActualStepSec : 0,
    peakTempErrorC,
    solverStatus: hitStepCap ? 'STEP_CAP_REACHED' : 'CONVERGED',
    warnings,
  };
}

/**
 * Unconditionally stable adaptive Backward-Euler Cauer ladder simulator returning Tj(t).
 */
export function simulateCauerZoh(
  time: Float64Array,
  power: Float32Array | Float64Array,
  cauer: CauerStage[],
  tAmbC: number
): Float32Array {
  const result = simulateCauerZohWithDiagnostics(time, power, cauer, tAmbC);
  if (result.solverStatus !== 'CONVERGED') {
    throw new Error(
      `Cauer 热求解未收敛 (${result.solverStatus})：${result.warnings.join('；') || '达到自适应步长保护上限'}。拒绝返回部分 Tj 曲线。`
    );
  }
  return result.tj;
}

/**
 * Tab 2 Loss Stripping & Closed-Loop Tj(t) Simulator:
 * - Scales SI prefixes (mV/kV, uA/mA) cleanly to base V and A
 * - Linearly interpolates Ids(t - deskew) for sub-sample Deskew (ns) alignment and mismatched timebases
 * - Strips Coss stored energy Eoss with exact trapezoidal 1x energy weighting per completed edge
 * - Runs sub-stepped closed-loop Cauer thermal advance with Rds(on)(Tj) feedback
 */
export function computeLossWithDeskewAndEoss(
  vdsCh: WaveformChannel,
  idsCh: WaveformChannel,
  cauerStages: CauerStage[],
  opts: LossSimulationOptions
): LossSimulationResult {
  if (vdsCh.t.length !== vdsCh.v.length) {
    throw new Error(`Vds 时间戳数量 (${vdsCh.t.length}) 与幅值数量 (${vdsCh.v.length}) 不一致，已拒绝静默截断。`);
  }
  if (idsCh.t.length !== idsCh.v.length) {
    throw new Error(`Ids 时间戳数量 (${idsCh.t.length}) 与幅值数量 (${idsCh.v.length}) 不一致，已拒绝静默截断。`);
  }
  const nVFull = vdsCh.t.length;
  const nIFull = idsCh.t.length;
  if (nVFull < 4 || nIFull < 2) {
    throw new Error('At least 4 Vds samples and 2 Ids samples are required for loss stripping simulation.');
  }
  if (cauerStages.length === 0) throw new Error('MOS 结温计算缺少 Cauer 热网络；拒绝用 Tamb 伪装成结温曲线。');
  cauerStages.forEach((stage, idx) => {
    if (!Number.isFinite(stage.r) || stage.r <= 0 || !Number.isFinite(stage.c) || stage.c <= 0) {
      throw new Error(`Cauer 第 ${idx + 1} 阶 R/C 必须为有限正数。`);
    }
  });
  const deskewNs = opts.deskewNs ?? 0;
  const eossUj = opts.eossUj ?? 0;
  const rdsOn25Mohm = opts.rdsOn25Mohm ?? 0;
  const tempCoeffAlphaPerC = opts.tempCoeffAlphaPerC ?? 0;
  if (!Number.isFinite(deskewNs)) throw new Error('Deskew 必须为有限数值（ns）。');
  if (!Number.isFinite(eossUj) || eossUj < 0) throw new Error('Eoss 必须为非负有限值（µJ）。');
  if (!Number.isFinite(rdsOn25Mohm) || rdsOn25Mohm < 0) throw new Error('Rds(on)@25°C 必须为非负有限值（mΩ）。');
  if (!Number.isFinite(tempCoeffAlphaPerC) || tempCoeffAlphaPerC < 0 || tempCoeffAlphaPerC > 0.05) {
    throw new Error('Rds(on) 温度系数必须为 0～0.05 /°C 的有限值。');
  }
  if (!Number.isFinite(opts.tAmbC) || opts.tAmbC <= -273.15 || opts.tAmbC > 1000) throw new Error('环境温度必须高于绝对零度且不超过 1000°C。');
  if (opts.tStart !== undefined && !Number.isFinite(opts.tStart)) throw new Error('损耗仿真起始时间必须为有限值。');
  if (opts.tEnd !== undefined && !Number.isFinite(opts.tEnd)) throw new Error('损耗仿真结束时间必须为有限值。');
  if (opts.vOnThreshV !== undefined && (!Number.isFinite(opts.vOnThreshV) || opts.vOnThreshV < 0)) throw new Error('MOS 导通电压阈值必须为非负有限值。');
  if (opts.initialNodeT !== undefined && (opts.initialNodeT.length !== cauerStages.length || !opts.initialNodeT.every(Number.isFinite))) {
    throw new Error('initialNodeT 必须与 Cauer 阶梯数量一致，且所有节点温度均为有限值。');
  }
  if (opts.initialTjC !== undefined && !Number.isFinite(opts.initialTjC)) throw new Error('初始结温 initialTjC 必须为有限值。');

  let i0 = 0;
  let i1 = nVFull - 1;
  if (opts.tStart !== undefined) {
    while (i0 < nVFull && vdsCh.t[i0] < opts.tStart) i0++;
  }
  if (opts.tEnd !== undefined) {
    while (i1 > i0 && vdsCh.t[i1] > opts.tEnd) i1--;
  }
  const len = Math.max(0, i1 - i0 + 1);
  if (len < 4) {
    throw new Error('At least 4 samples are required inside gate for loss stripping simulation.');
  }

  const vScale = parseSiUnitScale(vdsCh.unit, 'V', vdsCh.name, { strict: true });
  const iScale = parseSiUnitScale(idsCh.unit, 'A', idsCh.name, { strict: true });

  const tbV = inspectTimebase(vdsCh.t, 0, nVFull - 1);
  const tbI = inspectTimebase(idsCh.t, 0, nIFull - 1);
  if (!tbV.monotonic) {
    throw new Error(`Vds 通道时间轴在索引 ${tbV.nonMonotonicIndex} 处非严格递增，无法保证损耗积分因果性。`);
  }
  if (!tbI.monotonic) {
    throw new Error(`Ids 通道时间轴在索引 ${tbI.nonMonotonicIndex} 处非严格递增，无法进行时间对齐与 Deskew 插值。`);
  }
  // Non-finite samples inside the evaluated gate are marked invalid by the
  // point-wise mask below. The result is INCOMPLETE with NaN energy/Tj, rather
  // than throwing or silently repairing the waveform. This preserves a useful
  // diagnostic while preventing a partial capture from yielding a valid loss.

  const thermalPathMode: ThermalPathMode = opts.pathMode === 'pad_ambient' ? 'pad_ambient' : 'junction_ambient';
  const deskewSec = deskewNs * 1e-9;
  const sameTimebase = areTimebasesSynchronized(vdsCh.t, idsCh.t);
  const warnings: string[] = [];
  const incompleteReasons: string[] = [];

  if (thermalPathMode === 'pad_ambient') {
    warnings.push('注意：当前损耗温升仿真基于 PCB/焊盘侧网络 (pad_ambient)，输出曲线仅代表等效测点温度 Tpad，不得视为真实芯片结温 Tj。');
  }
  if (!sameTimebase) {
    warnings.push('Vds 与 Ids 采样时刻未逐点同步，已按真实时间戳线性插值对齐（未按数组下标直接相乘）。');
  }

  const idsFirstT = idsCh.t[0];
  const idsLastT = idsCh.t[nIFull - 1];
  const gateSpanSec = Math.max(1e-12, vdsCh.t[i1] - vdsCh.t[i0]);
  const covEps = Math.max(1e-12, gateSpanSec * 1e-6);

  // If unshifted Vds gate exceeds Ids bounds, reject/mark incomplete rather than boundary-clamping Ids
  const unshiftedOutOfCov = vdsCh.t[i0] < idsFirstT - covEps || vdsCh.t[i1] > idsLastT + covEps;
  let deskewTrimmedCount = 0;

  // For small probe deskew shifts (<= 5% of gate), trim edge indices outside [idsFirstT + deskewSec, idsLastT + deskewSec]
  // instead of silently holding boundary samples.
  if (!unshiftedOutOfCov && Math.abs(deskewSec) > 1e-15 && Math.abs(deskewSec) <= gateSpanSec * 0.05) {
    const validTMin = idsFirstT + deskewSec - 1e-15;
    const validTMax = idsLastT + deskewSec + 1e-15;
    const origI0 = i0;
    const origI1 = i1;
    while (i0 < i1 && vdsCh.t[i0] < validTMin) i0++;
    while (i1 > i0 && vdsCh.t[i1] > validTMax) i1--;
    deskewTrimmedCount = (i0 - origI0) + (origI1 - i1);
    if (deskewTrimmedCount > 0 && i1 - i0 + 1 >= 4) {
      warnings.push(
        `已自动裁剪探头 Deskew (${opts.deskewNs.toFixed(1)} ns) 边界越界样本 ${deskewTrimmedCount} 点，避免对 Ids 首尾样本做静态钳位保持。`
      );
    } else {
      i0 = origI0;
      i1 = origI1;
    }
  }

  const evalLen = Math.max(0, i1 - i0 + 1);
  if (evalLen < 4) {
    throw new Error('有效重叠门控区间内样本数不足 4 点，无法执行损耗温升仿真。');
  }

  const time = new Float64Array(evalLen);
  const pLossW = new Float32Array(evalLen);
  const tjC = new Float32Array(evalLen);

  const mV = vdsCh.coupling === 'AC' ? computeChannelMean(vdsCh) : 0;
  const mI = idsCh.coupling === 'AC' ? computeChannelMean(idsCh) : 0;

  let vMin = Infinity;
  let vMax = -Infinity;
  for (let i = i0; i <= i1; i++) {
    const vv = getChannelDisplayValue(vdsCh, i, mV) * vScale;
    if (isFinite(vv)) {
      if (vv < vMin) vMin = vv;
      if (vv > vMax) vMax = vv;
    }
  }
  if (!isFinite(vMin) || !isFinite(vMax)) {
    throw new Error('Vds 门控窗口内不存在有效有限数值样本。');
  }
  const vSpan = Math.max(1e-6, vMax - vMin);
  const vLowThresh = vMin + vSpan * 0.2;
  const vHighThresh = vMin + vSpan * 0.8;

  const eossJ = eossUj * 1e-6;
  const r25Ohm = rdsOn25Mohm * 1e-3;
  const alpha = tempCoeffAlphaPerC;
  const vOnThresh = opts.vOnThreshV ?? Math.max(0.5, vMin + vSpan * 0.15);
  const rdsFeedbackEnabled = opts.rdsFeedbackEnabled !== false;

  const sampleIdsStrict = (targetT: number): { val: number; covered: boolean } => {
    const tArr = idsCh.t;
    if (nIFull === 0 || targetT < tArr[0] - covEps || targetT > tArr[nIFull - 1] + covEps) {
      return { val: Number.NaN, covered: false };
    }
    if (targetT <= tArr[0]) return { val: getChannelDisplayValue(idsCh, 0, mI) * iScale, covered: true };
    if (targetT >= tArr[nIFull - 1]) return { val: getChannelDisplayValue(idsCh, nIFull - 1, mI) * iScale, covered: true };

    let lo = 0;
    let hi = nIFull - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (tArr[mid] <= targetT) lo = mid;
      else hi = mid;
    }
    const dt = tArr[hi] - tArr[lo];
    const frac = dt > 1e-18 ? (targetT - tArr[lo]) / dt : 0;
    const v0 = getChannelDisplayValue(idsCh, lo, mI) * iScale;
    const v1 = getChannelDisplayValue(idsCh, hi, mI) * iScale;
    if (!Number.isFinite(v0) || !Number.isFinite(v1)) {
      return { val: Number.NaN, covered: true };
    }
    return { val: v0 + frac * (v1 - v0), covered: true };
  };

  // Detect interior sampling gaps in both Vds and Ids inside evaluation time span
  let idsI0 = 0;
  let idsI1 = nIFull - 1;
  while (idsI0 < nIFull && idsCh.t[idsI0] < vdsCh.t[i0] - Math.abs(deskewSec)) idsI0++;
  while (idsI1 > idsI0 && idsCh.t[idsI1] > vdsCh.t[i1] + Math.abs(deskewSec)) idsI1--;
  const vdsGapReport = inspectChannelSamplingGaps(vdsCh.t, i0, i1, 3.5);
  const idsGapReport = idsI1 - idsI0 >= 3 ? inspectChannelSamplingGaps(idsCh.t, idsI0, idsI1, 3.5) : { gapCount: 0, maxGapSec: 0, maxGapRatio: 1 };

  const pRawArr = new Float64Array(evalLen);
  const pDeskewArr = new Float64Array(evalLen);
  const vScaledArr = new Float64Array(evalLen);
  const iAlignedArr = new Float64Array(evalLen);
  const pointValidMask = new Uint8Array(evalLen);
  let nonFiniteMasked = 0;
  let outOfCoverageCount = 0;

  for (let k = 0; k < evalLen; k++) {
    const idx = i0 + k;
    const tCurr = vdsCh.t[idx];
    time[k] = tCurr;
    const vdsRaw = getChannelDisplayValue(vdsCh, idx, mV) * vScale;
    const idsRawQuery = sameTimebase
      ? { val: getChannelDisplayValue(idsCh, idx, mI) * iScale, covered: true }
      : sampleIdsStrict(tCurr);
    const idsAlignedQuery =
      deskewSec !== 0 || !sameTimebase
        ? sampleIdsStrict(tCurr - deskewSec)
        : idsRawQuery;

    if (!idsRawQuery.covered || !idsAlignedQuery.covered) {
      outOfCoverageCount++;
      pointValidMask[k] = 0;
      vScaledArr[k] = Number.NaN;
      iAlignedArr[k] = Number.NaN;
      pRawArr[k] = Number.NaN;
      pDeskewArr[k] = Number.NaN;
      pLossW[k] = Number.NaN;
    } else if (!Number.isFinite(vdsRaw) || !Number.isFinite(idsRawQuery.val) || !Number.isFinite(idsAlignedQuery.val)) {
      nonFiniteMasked++;
      pointValidMask[k] = 0;
      vScaledArr[k] = Number.NaN;
      iAlignedArr[k] = Number.NaN;
      pRawArr[k] = Number.NaN;
      pDeskewArr[k] = Number.NaN;
      pLossW[k] = Number.NaN;
    } else {
      pointValidMask[k] = 1;
      vScaledArr[k] = vdsRaw;
      iAlignedArr[k] = idsAlignedQuery.val;
      pRawArr[k] = vdsRaw * idsRawQuery.val;
      pDeskewArr[k] = vdsRaw * idsAlignedQuery.val;
      pLossW[k] = pDeskewArr[k];
    }
  }

  if (unshiftedOutOfCov || outOfCoverageCount > 0) {
    incompleteReasons.push(
      `Ids 通道时间覆盖 [${idsFirstT.toExponential(3)}s, ${idsLastT.toExponential(3)}s] 未覆盖仿真门控区间，共有 ${Math.max(1, outOfCoverageCount)} 点超出覆盖范围（禁止边界钳位假定）。`
    );
  }
  if (nonFiniteMasked > 0) {
    incompleteReasons.push(`门控区间内检测到 ${nonFiniteMasked} 个 NaN/Inf 无效采样点（禁止清零掩盖损耗）。`);
  }
  if (vdsGapReport.gapCount > 0 || idsGapReport.gapCount > 0) {
    incompleteReasons.push(
      `检测到内部采样缺口/掉点（Vds gap=${vdsGapReport.gapCount}, Ids gap=${idsGapReport.gapCount}，最大空窗 ${Math.max(vdsGapReport.maxGapRatio, idsGapReport.maxGapRatio).toFixed(1)}× dt_med），关键边沿能量可能缺失。`
    );
  }

  const incomplete = incompleteReasons.length > 0;
  if (incomplete) {
    warnings.push(...incompleteReasons);
    tjC.fill(Number.NaN);
    return {
      time,
      pLossW,
      tjC,
      pLossMeanW: Number.NaN,
      tjMaxC: Number.NaN,
      tjMinC: Number.NaN,
      tjMeanC: Number.NaN,
      energyRawMj: Number.NaN,
      energyDeskewedMj: Number.NaN,
      energyStrippedMj: Number.NaN,
      switchingEvents: 0,
      zvsTurnOnCount: 0,
      incomplete: true,
      incompleteReasons,
      nonFiniteMasked,
      outOfCoverageCount,
      thermalPathMode,
      warnings,
    };
  }

  let energyRawJ = 0;
  let energyDeskewedJ = 0;
  let energyStrippedJ = 0;
  let switchingEvents = 0;
  let zvsTurnOnCount = 0;
  let underResolvedEdgeCount = 0;

  const mStages = cauerStages.length;
  const nodeT = new Float64Array(Math.max(1, mStages)).fill(opts.tAmbC);
  if (
    mStages > 0 &&
    opts.initialNodeT &&
    opts.initialNodeT.length === mStages &&
    opts.initialNodeT.every((v) => Number.isFinite(v))
  ) {
    for (let s = 0; s < mStages; s++) nodeT[s] = opts.initialNodeT[s];
    warnings.push(`已注入自定义 Cauer 初始节点温度历史（初始 Tj=${nodeT[0].toFixed(2)}°C）。`);
  } else if (
    mStages > 0 &&
    opts.initialTjC !== undefined &&
    Number.isFinite(opts.initialTjC) &&
    Math.abs(opts.initialTjC - opts.tAmbC) > 1e-6
  ) {
    const rTotal = cauerStages.reduce((acc, st) => acc + Math.max(1e-9, st.r), 0);
    let rRemaining = rTotal;
    for (let s = 0; s < mStages; s++) {
      const frac = rTotal > 1e-12 ? rRemaining / rTotal : 0;
      nodeT[s] = opts.tAmbC + (opts.initialTjC - opts.tAmbC) * frac;
      rRemaining -= Math.max(1e-9, cauerStages[s].r);
    }
    warnings.push(`已设定脉冲前热历史初温 Tj(0)=${nodeT[0].toFixed(2)}°C（沿 Cauer 热阻占比分布至内部节点）。`);
  }

  const cauerSc = createCauerScratch(mStages);
  let minTau = Infinity;
  let maxTau = 0;
  for (let s = 0; s < mStages; s++) {
    const tauS = cauerStages[s].r * cauerStages[s].c;
    if (isFinite(tauS) && tauS > 1e-12) {
      if (tauS < minTau) minTau = tauS;
      if (tauS > maxTau) maxTau = tauS;
    }
  }
  if (!isFinite(minTau)) minTau = 1e-4;
  if (!(maxTau > 0)) maxTau = minTau;

  let maxThermalSubsteps = 1;
  let minThermalStepSec = Infinity;
  let peakThermalStepErrorC = 0;
  let thermalSolverStatus: 'CONVERGED' | 'STEP_CAP_REACHED' = 'CONVERGED';

  const advanceCauerNodeT = (dtStep: number, pStepW: number) => {
    if (mStages <= 0 || dtStep <= 0) return;
    const diag = advanceCauerAdaptive(
      cauerStages,
      nodeT,
      dtStep,
      pStepW,
      opts.tAmbC,
      minTau,
      maxTau,
      cauerSc
    );
    if (diag.substepsUsed > maxThermalSubsteps) maxThermalSubsteps = diag.substepsUsed;
    if (diag.minStepSec < minThermalStepSec) minThermalStepSec = diag.minStepSec;
    if (diag.peakStepErrorC > peakThermalStepErrorC) peakThermalStepErrorC = diag.peakStepErrorC;
    if (diag.hitStepCap) thermalSolverStatus = 'STEP_CAP_REACHED';
  };

  if (
    mStages > 0 &&
    opts.preheatPowerW !== undefined &&
    Number.isFinite(opts.preheatPowerW) &&
    opts.preheatPowerW > 0 &&
    opts.preheatDurationSec !== undefined &&
    Number.isFinite(opts.preheatDurationSec) &&
    opts.preheatDurationSec > 0
  ) {
    const preChunks = 24;
    const dtChunk = opts.preheatDurationSec / preChunks;
    for (let c = 0; c < preChunks; c++) advanceCauerNodeT(dtChunk, opts.preheatPowerW);
    warnings.push(
      `已运行脉冲前稳态预热 (${opts.preheatPowerW.toFixed(1)}W × ${opts.preheatDurationSec.toFixed(3)}s)：脉冲起始结温=${nodeT[0].toFixed(2)}°C。`
    );
  }

  let swState: 'on' | 'off' | 'trans_off' | 'trans_on' =
    vScaledArr[0] <= vLowThresh ? 'on' : 'off';
  let transStartIdx = -1;

  // Trapezoidal time-weight helper for exact 1.0x Eoss energy attribution
  const applyExactEdgeEnergy = (startK: number, endK: number, energyDeltaJ: number) => {
    if (energyDeltaJ === 0 || endK < startK) return;
    let totalTrapWeight = 0;
    for (let j = startK; j <= endK; j++) {
      const dtPrev = j > 0 ? Math.max(0, time[j] - time[j - 1]) : 0;
      const dtNext = j < evalLen - 1 ? Math.max(0, time[j + 1] - time[j]) : 0;
      totalTrapWeight += 0.5 * (dtPrev + dtNext);
    }
    if (totalTrapWeight <= 1e-15) return;
    const pAdj = energyDeltaJ / totalTrapWeight;
    for (let j = startK; j <= endK; j++) {
      pLossW[j] += pAdj;
    }
  };

  let edgeEossOutOfRange = false;
  const computeEdgeEossJ = (startK: number, endK: number): number => {
    if (!opts.eossCurve) return eossJ;
    let vLo = Infinity;
    let vHi = -Infinity;
    for (let j = Math.max(0, startK - 1); j <= Math.min(evalLen - 1, endK + 1); j++) {
      const vj = Math.max(0, vScaledArr[j]);
      if (vj < vLo) vLo = vj;
      if (vj > vHi) vHi = vj;
    }
    const rHi = evaluateNonlinearEossUj(opts.eossCurve, vHi, { allowOutOfDomainClamp: false });
    const rLo = evaluateNonlinearEossUj(opts.eossCurve, vLo, { allowOutOfDomainClamp: false });
    if (rHi.outOfRange || rLo.outOfRange) edgeEossOutOfRange = true;
    return Math.max(0, rHi.eossUj - rLo.eossUj) * 1e-6;
  };

  if (opts.eossCurve) {
    warnings.push(
      `Eoss 已启用非线性 ${opts.eossCurve.kind.toUpperCase()} 曲线积分（PCHIP 单调插值：${opts.eossCurve.points.length} 点），按实测脉冲边沿电压区间精确剥离/补偿。`
    );
  } else if (eossUj > 0) {
    warnings.push(
      `当前 Eoss=${eossUj.toFixed(2)}µJ 为恒定标量/低精度 V² 近似；真实 MOSFET Coss(V) 呈强非线性，建议导入器件 Eoss(V)/Qoss(V) 曲线。`
    );
  }

  // Strip Eoss across identified turn-off (Vds rising) and hard-switched turn-on (Vds falling w/ positive Ids)
  for (let k = 0; k < evalLen; k++) {
    const vds = vScaledArr[k];
    if (swState === 'on' && vds > vLowThresh) {
      swState = 'trans_off';
      transStartIdx = k;
    } else if (swState === 'trans_off') {
      if (vds >= vHighThresh) {
        if (k - transStartIdx + 1 < 4) underResolvedEdgeCount++;
        const edgeEossJ = computeEdgeEossJ(transStartIdx, k);
        applyExactEdgeEnergy(transStartIdx, k, -edgeEossJ);
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
        if (k - transStartIdx + 1 < 4) underResolvedEdgeCount++;
        let maxForwardIds = -Infinity;
        for (let j = Math.max(0, transStartIdx); j <= k; j++) {
          if (iAlignedArr[j] > maxForwardIds) maxForwardIds = iAlignedArr[j];
        }
        if (maxForwardIds > 0.05) {
          const edgeEossJ = computeEdgeEossJ(transStartIdx, k);
          applyExactEdgeEnergy(transStartIdx, k, +edgeEossJ);
          switchingEvents++;
        } else {
          // Zero-voltage / reverse-conduction soft turn-on: Coss was already discharged cleanly before channel turn-on
          zvsTurnOnCount++;
        }
        swState = 'on';
      } else if (vds >= vHighThresh) {
        swState = 'off';
      }
    }
  }
  if (edgeEossOutOfRange) {
    const reason = '开关边沿电压超出非线性 Eoss(V)/Qoss(V) 曲线定义域；拒绝使用边界截断值继续计算损耗和结温。';
    warnings.push(reason);
    tjC.fill(Number.NaN);
    pLossW.fill(Number.NaN);
    return {
      time, pLossW, tjC,
      pLossMeanW: Number.NaN, tjMaxC: Number.NaN, tjMinC: Number.NaN, tjMeanC: Number.NaN,
      energyRawMj: Number.NaN, energyDeskewedMj: Number.NaN, energyStrippedMj: Number.NaN,
      switchingEvents, zvsTurnOnCount, incomplete: true, incompleteReasons: [reason],
      nonFiniteMasked: 0, outOfCoverageCount: 0, thermalPathMode, warnings,
    };
  }

  const truncatedEdgeCount = swState === 'trans_off' || swState === 'trans_on' ? 1 : 0;
  if (underResolvedEdgeCount > 0 || truncatedEdgeCount > 0) {
    const reason = `Vds 开关边沿分辨率不足：${underResolvedEdgeCount} 个边沿仅包含少于 4 个采样点，${truncatedEdgeCount} 个边沿在门控结束时未完成；开关瞬态能量无法可靠积分。请提高示波器采样率/缩短时间跨度后重测。`;
    warnings.push(reason);
    tjC.fill(Number.NaN);
    pLossW.fill(Number.NaN);
    return {
      time,
      pLossW,
      tjC,
      pLossMeanW: Number.NaN,
      tjMaxC: Number.NaN,
      tjMinC: Number.NaN,
      tjMeanC: Number.NaN,
      energyRawMj: Number.NaN,
      energyDeskewedMj: Number.NaN,
      energyStrippedMj: Number.NaN,
      switchingEvents,
      zvsTurnOnCount,
      incomplete: true,
      incompleteReasons: [reason],
      nonFiniteMasked: 0,
      outOfCoverageCount: 0,
      thermalPathMode,
      warnings,
    };
  }

  if (zvsTurnOnCount > 0 && eossJ > 0) {
    warnings.push(`检测到 ${zvsTurnOnCount} 次开通边沿处于零/反向电流 (ZVS/体二极管续流) 状态，已跳过 +Eoss 补偿以避免多加损耗。`);
  }
  if (rdsFeedbackEnabled && r25Ohm > 0 && alpha !== 0) {
    warnings.push('已启用 Rds(on)(Tj) 温度修正 (按实测 Vds 处于 25°C 参考态叠加热增阻)；若实测 Vds 本身已在高温稳态下采集，请关闭此开关避免重复计温。');
  }

  // Advance closed-loop Tj(t) with optional temperature-dependent Rds(on)(Tj) feedback and Cauer sub-stepping
  const initialTj = mStages > 0 ? nodeT[0] : opts.tAmbC;
  let sumLoss = 0;
  let tjMaxC = initialTj;
  let tjMinC = initialTj;
  let sumTj = initialTj;
  tjC[0] = initialTj;

  for (let k = 0; k < evalLen; k++) {
    if (k > 0) {
      const dt = Math.max(1e-12, time[k] - time[k - 1]);
      energyRawJ += 0.5 * (pRawArr[k - 1] + pRawArr[k]) * dt;
      energyDeskewedJ += 0.5 * (pDeskewArr[k - 1] + pDeskewArr[k]) * dt;

      const vPrev = vScaledArr[k - 1];
      if (rdsFeedbackEnabled && r25Ohm > 0 && alpha !== 0 && Math.abs(vPrev) <= vOnThresh) {
        const idsPrev = iAlignedArr[k - 1];
        const rTj = Math.max(1e-6, r25Ohm * (1 + alpha * (nodeT[0] - 25)));
        const deltaCond = idsPrev * idsPrev * (rTj - r25Ohm);
        pLossW[k - 1] += deltaCond;
      }

      const pStepSigned = pLossW[k - 1];
      const pThermalStep = Math.max(0, pStepSigned);

      if (mStages > 0) {
        advanceCauerNodeT(dt, pThermalStep);
        tjC[k] = nodeT[0];
      } else {
        tjC[k] = opts.tAmbC;
      }

      if (rdsFeedbackEnabled && r25Ohm > 0 && alpha !== 0 && Math.abs(vScaledArr[k]) <= vOnThresh) {
        const idsCurr = iAlignedArr[k];
        const rTjCurr = Math.max(1e-6, r25Ohm * (1 + alpha * (tjC[k] - 25)));
        const deltaCondCurr = idsCurr * idsCurr * (rTjCurr - r25Ohm);
        const pCurr = pLossW[k] + deltaCondCurr;
        energyStrippedJ += 0.5 * (pStepSigned + pCurr) * dt;
        if (k === evalLen - 1) pLossW[k] = pCurr;
      } else {
        energyStrippedJ += 0.5 * (pStepSigned + pLossW[k]) * dt;
      }

      if (tjC[k] > tjMaxC) tjMaxC = tjC[k];
      if (tjC[k] < tjMinC) tjMinC = tjC[k];
      sumTj += tjC[k];
    }
    sumLoss += pLossW[k];
  }

  const totalDurationSec = evalLen > 1 ? time[evalLen - 1] - time[0] : 0;
  const pLossMeanW =
    totalDurationSec > 1e-15 ? energyStrippedJ / totalDurationSec : evalLen > 0 ? sumLoss / evalLen : 0;

  // thermalSolverStatus is only reassigned inside the advanceCauerNodeT closure,
  // which TypeScript's flow analysis does not track, so it wrongly narrows the
  // variable to its initialiser here. Widen back to the declared union.
  if ((thermalSolverStatus as 'CONVERGED' | 'STEP_CAP_REACHED') === 'STEP_CAP_REACHED') {
    const reason = `闭环 Cauer 热网络在个别步长达到最大自适应子步保护上限 (32768)，最大估计截断误差 ${peakThermalStepErrorC.toExponential(2)}°C；能量积分可供诊断，但 Tj 曲线不具备收敛保证。`;
    warnings.push(reason);
    tjC.fill(Number.NaN);
    return {
      time, pLossW, tjC, pLossMeanW,
      tjMaxC: Number.NaN, tjMinC: Number.NaN, tjMeanC: Number.NaN,
      energyRawMj: energyRawJ * 1e3, energyDeskewedMj: energyDeskewedJ * 1e3, energyStrippedMj: energyStrippedJ * 1e3,
      switchingEvents, zvsTurnOnCount, incomplete: true, incompleteReasons: [reason],
      nonFiniteMasked: 0, outOfCoverageCount: 0, thermalPathMode, warnings,
      maxThermalSubsteps, minThermalStepSec: Number.isFinite(minThermalStepSec) ? minThermalStepSec : 0,
      peakThermalStepErrorC, thermalSolverStatus,
    };
  }

  return {
    time,
    pLossW,
    tjC,
    pLossMeanW,
    tjMaxC,
    tjMinC,
    tjMeanC: evalLen > 0 ? sumTj / evalLen : opts.tAmbC,
    energyRawMj: energyRawJ * 1e3,
    energyDeskewedMj: energyDeskewedJ * 1e3,
    energyStrippedMj: energyStrippedJ * 1e3,
    switchingEvents,
    zvsTurnOnCount,
    incomplete: false,
    incompleteReasons: [],
    nonFiniteMasked: 0,
    outOfCoverageCount: 0,
    thermalPathMode,
    warnings,
    maxThermalSubsteps,
    minThermalStepSec: Number.isFinite(minThermalStepSec) ? minThermalStepSec : 0,
    peakThermalStepErrorC,
    thermalSolverStatus,
  };
}

export interface ViSignalSource {
  channel?: WaveformChannel | null;
  constantValue?: number;
}

/**
 * Flexible V × I instantaneous & step-active power computation supporting:
 * - Waveform V(t) × Waveform I(t)
 * - Constant V × Waveform I(t)
 * - Waveform V(t) × Constant I
 * - Constant V × Constant I
 */
export function computePowerFromVISources(
  vSource: ViSignalSource,
  iSource: ViSignalSource,
  opts: ViPowerOptions = {}
): ViPowerResult {
  const vCh = vSource.channel || null;
  const iCh = iSource.channel || null;
  const useAbs = opts.useAbsPower !== false;

  // Case 1: Both constants
  if (!vCh && !iCh) {
    const vVal = isFinite(vSource.constantValue ?? NaN) ? Number(vSource.constantValue) : 0;
    const iVal = isFinite(iSource.constantValue ?? NaN) ? Number(iSource.constantValue) : 0;
    const pRaw = vVal * iVal;
    const pVal = useAbs ? Math.abs(pRaw) : pRaw;
    const t0 = opts.tStart !== undefined && isFinite(opts.tStart) ? opts.tStart : 0;
    const t1 = opts.tEnd !== undefined && isFinite(opts.tEnd) && opts.tEnd > t0 ? opts.tEnd : t0 + 1;
    const time = Float64Array.from([t0, t1]);
    const powerW = Float32Array.from([pVal, pVal]);
    return {
      time,
      powerW,
      pGateMeanW: pVal,
      pStepActiveW: pVal,
      pPeakW: Math.abs(pVal),
      energyJ: pVal * (t1 - t0),
      activeFraction: 1,
      vMeanV: vVal,
      iMeanA: iVal,
      vUnitScale: 1,
      iUnitScale: 1,
      sampleCount: 2,
    };
  }

  // A waveform channel is a paired acquisition. Never truncate mismatched
  // timestamps/values or sort a corrupted axis: both can manufacture false power.
  const validatePowerChannel = (ch: WaveformChannel | null, label: string): number => {
    if (!ch) return 0;
    if (ch.t.length !== ch.v.length) {
      throw new Error(`${label} 时间戳数量 (${ch.t.length}) 与幅值数量 (${ch.v.length}) 不一致，已拒绝静默截断。`);
    }
    if (ch.t.length < 2) throw new Error(`${label} waveform must have at least 2 samples.`);
    for (let i = 0; i < ch.t.length; i++) {
      if (!Number.isFinite(ch.t[i])) throw new Error(`${label} 时间轴在索引 ${i} 处含 NaN/Inf。`);
      if (i > 0 && !(ch.t[i] > ch.t[i - 1])) throw new Error(`${label} 时间轴在索引 ${i} 处非严格递增。`);
      if (!Number.isFinite(ch.v[i])) throw new Error(`${label} 在索引 ${i} 处含 NaN/Inf 幅值，已拒绝将无效功率样本替换为 0。`);
    }
    return ch.t.length;
  };
  const nV = validatePowerChannel(vCh, 'Voltage');
  const nI = validatePowerChannel(iCh, 'Current');

  const vScale = vCh ? parseSiUnitScale(vCh.unit, 'V', vCh.name) : 1;
  const iScale = iCh ? parseSiUnitScale(iCh.unit, 'A', iCh.name) : 1;
  const mV = vCh && vCh.coupling === 'AC' ? computeChannelMean(vCh) : 0;
  const mI = iCh && iCh.coupling === 'AC' ? computeChannelMean(iCh) : 0;

  const masterIsV = Boolean(vCh && (!iCh || nV >= nI));
  const masterCh = (masterIsV ? vCh : iCh)!;
  const nMaster = masterIsV ? nV : nI;
  const sameTimebase = Boolean(
    vCh && iCh && nV === nI && vCh.t.every((t, idx) => t === iCh.t[idx])
  );

  const sampleChannelAt = (ch: WaveformChannel, nCh: number, scale: number, meanAc: number, targetT: number, fallbackIdx: number): number => {
    if (sameTimebase) return getChannelDisplayValue(ch, fallbackIdx, meanAc) * scale;
    const tArr = ch.t;
    if (targetT < tArr[0] || targetT > tArr[nCh - 1]) {
      throw new Error(`V×I 时间对齐点 ${targetT.toExponential(6)}s 超出 ${ch.name} 时间覆盖范围，禁止端点保持外推。`);
    }
    if (targetT === tArr[0]) return getChannelDisplayValue(ch, 0, meanAc) * scale;
    if (targetT === tArr[nCh - 1]) return getChannelDisplayValue(ch, nCh - 1, meanAc) * scale;
    let lo = 0;
    let hi = nCh - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (tArr[mid] <= targetT) lo = mid;
      else hi = mid;
    }
    const dt = tArr[hi] - tArr[lo];
    const frac = dt > 1e-18 ? (targetT - tArr[lo]) / dt : 0;
    const val0 = getChannelDisplayValue(ch, lo, meanAc) * scale;
    const val1 = getChannelDisplayValue(ch, hi, meanAc) * scale;
    return val0 + frac * (val1 - val0);
  };

  const overlapStart = Math.max(
    vCh ? vCh.t[0] : -Infinity,
    iCh ? iCh.t[0] : -Infinity,
    opts.tStart ?? -Infinity
  );
  const overlapEnd = Math.min(
    vCh ? vCh.t[nV - 1] : Infinity,
    iCh ? iCh.t[nI - 1] : Infinity,
    opts.tEnd ?? Infinity
  );
  if (!(overlapEnd > overlapStart)) {
    throw new Error('V 与 I 通道在所选分析门控内没有正长度的共同时间覆盖，拒绝端点外推计算功率。');
  }
  let iStart = 0;
  let iEnd = nMaster - 1;
  while (iStart < nMaster && masterCh.t[iStart] < overlapStart) iStart++;
  while (iEnd > iStart && masterCh.t[iEnd] > overlapEnd) iEnd--;
  const len = Math.max(0, iEnd - iStart + 1);
  if (len < 2) {
    throw new Error('At least 2 samples are required inside the analysis gate to compute V × I power.');
  }

  const time = new Float64Array(len);
  const powerW = new Float32Array(len);
  let sumV = 0;
  let sumI = 0;
  let pPeakW = 0;
  const absPowers: number[] = new Array(len);
  const vConst = isFinite(vSource.constantValue ?? NaN) ? Number(vSource.constantValue) : 0;
  const iConst = isFinite(iSource.constantValue ?? NaN) ? Number(iSource.constantValue) : 0;

  for (let k = 0; k < len; k++) {
    const idx = iStart + k;
    const ti = masterCh.t[idx];
    const vVal = vCh
      ? masterIsV
        ? getChannelDisplayValue(vCh, idx, mV) * vScale
        : sampleChannelAt(vCh, nV, vScale, mV, ti, idx)
      : vConst;
    const iVal = iCh
      ? !masterIsV
        ? getChannelDisplayValue(iCh, idx, mI) * iScale
        : sampleChannelAt(iCh, nI, iScale, mI, ti, idx)
      : iConst;
    if (!Number.isFinite(ti) || !Number.isFinite(vVal) || !Number.isFinite(iVal)) {
      throw new Error(`V×I 在 t=${ti} 处存在无效时间/电压/电流样本，禁止用 0 替代后继续积分。`);
    }
    const pRaw = vVal * iVal;
    const pVal = useAbs ? Math.abs(pRaw) : pRaw;
    if (!Number.isFinite(pVal)) throw new Error(`V×I 在 t=${ti.toExponential(6)}s 处功率溢出或无效。`);
    time[k] = ti;
    powerW[k] = pVal;
    absPowers[k] = Math.abs(powerW[k]);
    if (isFinite(vVal)) sumV += vVal;
    if (isFinite(iVal)) sumI += iVal;
    if (Math.abs(powerW[k]) > pPeakW) pPeakW = Math.abs(powerW[k]);
  }

  let energyJ = 0;
  for (let k = 1; k < len; k++) {
    const dt = time[k] - time[k - 1];
    if (!(dt > 0)) throw new Error(`V×I 积分时间轴在索引 ${k} 处非严格递增。`);
    energyJ += 0.5 * (powerW[k - 1] + powerW[k]) * dt;
  }
  const totalSpan = Math.max(0, time[len - 1] - time[0]);
  const pGateMeanW =
    totalSpan > 1e-18
      ? energyJ / totalSpan
      : powerW.reduce((acc, v) => acc + v, 0) / len;

  let pStepActiveW = pGateMeanW;
  let activeFraction = 1;

  if (
    opts.stepOnsetTimeSec !== undefined &&
    isFinite(opts.stepOnsetTimeSec) &&
    opts.stepOnsetTimeSec > time[0] &&
    opts.stepOnsetTimeSec < time[len - 1]
  ) {
    let onsetK = 0;
    while (onsetK < len - 1 && time[onsetK] < opts.stepOnsetTimeSec) onsetK++;
    const activeSpan = time[len - 1] - time[onsetK];
    if (activeSpan > 1e-18 && len - onsetK >= 2) {
      let eAct = 0;
      for (let k = onsetK + 1; k < len; k++) {
        const dt = Math.max(0, time[k] - time[k - 1]);
        eAct += 0.5 * (powerW[k - 1] + powerW[k]) * dt;
      }
      pStepActiveW = eAct / activeSpan;
      activeFraction = totalSpan > 1e-18 ? activeSpan / totalSpan : (len - onsetK) / len;
    }
  } else {
    const sortedAbs = [...absPowers].sort((a, b) => a - b);
    const p95 = sortedAbs[Math.min(len - 1, Math.floor(len * 0.95))];
    if (p95 > 1e-9) {
      const thresh = p95 * 0.1;
      let activeCnt = 0;
      let sumActiveTime = 0;
      let energyActive = 0;
      for (let k = 0; k < len; k++) {
        if (absPowers[k] >= thresh) activeCnt++;
        if (k > 0) {
          const dt = Math.max(0, time[k] - time[k - 1]);
          if (0.5 * (absPowers[k - 1] + absPowers[k]) >= thresh) {
            sumActiveTime += dt;
            energyActive += 0.5 * (powerW[k - 1] + powerW[k]) * dt;
          }
        }
      }
      const frac = totalSpan > 1e-18 ? sumActiveTime / totalSpan : activeCnt / len;
      if (frac > 0.02 && frac < 0.97 && sumActiveTime > 1e-18) {
        pStepActiveW = energyActive / sumActiveTime;
        activeFraction = frac;
      }
    }
  }

  return {
    time,
    powerW,
    pGateMeanW,
    pStepActiveW,
    pPeakW,
    energyJ,
    activeFraction,
    vMeanV: sumV / len,
    iMeanA: sumI / len,
    vUnitScale: vScale,
    iUnitScale: iScale,
    sampleCount: len,
  };
}

/**
 * Computes instantaneous power p(t) = v(t) * i(t), trapezoidal energy, gate-mean power,
 * and step-active mean power (excluding pre-step idle baseline if present) from V and I waveforms.
 */
export function computePowerFromVIWaveforms(
  vCh: WaveformChannel,
  iCh: WaveformChannel,
  opts: ViPowerOptions = {}
): ViPowerResult {
  return computePowerFromVISources({ channel: vCh }, { channel: iCh }, opts);
}
