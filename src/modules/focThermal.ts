/**
 * Waveform Viewer Pro - Phase 2: BLDC / PMSM FOC 6-MOS Inverter Thermal Engine
 *
 * Implements:
 * 1. 6-MOS Star-Coupled Thermal Network (6 independent ZthJC arms -> shared T_board -> Zth_board -> TAMB)
 *    solved in exact O(N * (6*Kj + Kb)) via Schur-complement tridiagonal elimination + sub-stepping.
 * 2. 7-port LTspice netlist generator & numerical nodal validator (.subckt INV_6MOS_THERM Q1 Q2 Q3 Q4 Q5 Q6 TAMB).
 * 3. Sensorless Clarke alpha-beta SVPWM / DPWM1 / SPWM duty-cycle reconstruction with linear-limit overmodulation detection.
 * 4. Physical synchronous-rectification & 3rd-quadrant dead-time loss attribution with switching-period conservation.
 * 5. Zero-speed Locked-Rotor Stall Sweep (0..360 deg) with t_safe and dual I^2*t (RMS & worst phase leg) metrics.
 * 6. SVPWM vs DPWM1 vs SPWM & switching-frequency (f_sw) trade-off analysis.
 */

import { WaveformChannel } from '../types/models';
import { CauerStage, parseSiUnitScale } from './thermalEngine';
import { computeChannelMean, getChannelDisplayValue } from './oscilloscopeScale';

export type FocModulationMode = 'SVPWM' | 'DPWM1' | 'SPWM';
export type MosSwitchKey = 'AH' | 'AL' | 'BH' | 'BL' | 'CH' | 'CL';

export const MOS_SWITCH_KEYS: MosSwitchKey[] = ['AH', 'AL', 'BH', 'BL', 'CH', 'CL'];

export function getModulationLinearCeiling(modulation: FocModulationMode): number {
  return modulation === 'SPWM' ? 1.0 : 2 / Math.sqrt(3);
}

export interface FocCauerSplitMeta {
  tauSplitSec: number;
  boundaryIndex: number;
  boundaryAdjusted: boolean;
  nonMonotonicTau: boolean;
  shuntCapRatioPct: number;
  warning: string | null;
}

export interface FocThermalModel {
  zthJC: CauerStage[];
  zthBoard: CauerStage[];
  isHeuristicSingleStageSplit?: boolean;
  splitMeta?: FocCauerSplitMeta;
}

export interface FocMosParams {
  rdsOn25Mohm: number;
  tempCoeffAlphaPerC: number; // e.g. 0.0045 (/°C)
  vsdV: number; // body diode drop (V)
  eonPlusEoffUj: number; // switching loss ref Eon+Eoff (uJ) at vRefV, iRefA
  vRefV: number;
  iRefA: number;
  qrrNc: number; // reverse recovery charge (nC) at iRefA
  eossUj?: number; // optional zero-current Coss discharge energy (uJ) at vRefV (default 0 to avoid double-counting datasheet Eon)
}

export interface FocControlParams {
  modulation: FocModulationMode;
  fswHz: number;
  tDeadNs: number;
  modDepthM: number; // linear ceiling: 1.0 (SPWM) or 2/sqrt(3)=1.1547 (SVPWM/DPWM1)
  pfAngleDeg: number; // electrical phase shift phi (voltage leads current)
  tAmbC: number;
  vBusConstV: number;
}

export interface MosSwitchSummary {
  key: MosSwitchKey;
  tjAvgC: number;
  tjPeakC: number;
  tjFinalC: number;
  tjRippleC: number;
  pAvgW: number;
  pCondAvgW: number;
  pSwAvgW: number;
  pDeadAvgW: number;
}

export interface FocSimulationOptions {
  tStart?: number;
  tEnd?: number;
  gateThermalMode?: 'preheat' | 'cold';
  icCh?: WaveformChannel | null;
  vbusCh?: WaveformChannel | null;
  dutyChs?: { da?: WaveformChannel | null; db?: WaveformChannel | null; dc?: WaveformChannel | null };
}

export interface FocThermalInitInfo {
  gated: boolean;
  mode: 'preheat' | 'cold';
  preheatDurationSec: number;
  tjInitialMaxC: number;
  tBoardInitialC: number;
}

export interface ThermalNetworkStateSnapshot {
  armT: number[][]; // 6 x Kj junction-to-case ladder node temperatures (°C)
  brdT: number[]; // Kb shared board/heatsink ladder node temperatures (°C)
  tBoardC: number;
  tjMaxC: number;
}

export interface FocSimulationResult {
  time: Float64Array;
  tj: Record<MosSwitchKey, Float32Array>;
  pMos: Record<MosSwitchKey, Float32Array>;
  pInvTotal: Float32Array;
  tBoard: Float32Array;
  duty: { a: Float32Array; b: Float32Array; c: Float32Array };
  summaries: MosSwitchSummary[];
  hottestKey: MosSwitchKey;
  tjMaxGlobalC: number;
  pInvMeanW: number;
  tBoardFinalC: number;
  durationSec: number;
  tauMaxBoardSec: number;
  tBoardSteadyEstC: number;
  tjSteadyMaxEstC: number;
  tjSteadyEstByKey: Record<MosSwitchKey, number>;
  thermalConvergencePct: number;
  steadyConverged: boolean;
  steadyThermalRunaway: boolean;
  overmodulatedCount: number;
  zeroCurrentFallbackCount: number;
  maxSubDtOverTau: number;
  pointsPerElecCycle: number | null;
  finalThermalState: ThermalNetworkStateSnapshot;
  dutySource: 'reconstructed' | 'external';
  alignmentWarnings: string[];
  warnings: string[];
  thermalInitInfo: FocThermalInitInfo;
}

export interface FocSpiceValidationResult {
  valid: boolean;
  errors: string[];
  has7Ports: boolean;
  allCapsGroundedTo0: boolean;
  noCapOnTamb: boolean;
  hasSharedBoardNode: boolean;
  hasDefensiveIc: boolean;
  nodalMathVerified: boolean;
  rJcParsed: number;
  rBrdParsed: number;
  dcCommonModeError: number;
}

export interface FocStallSweepOptions {
  iPeakA: number;
  tjLimitC: number;
  tAmbC: number;
  tInitialBoardC?: number;
  initialThermalState?: ThermalNetworkStateSnapshot;
  modulation: FocModulationMode;
  modDepthM: number;
  pfAngleDeg?: number;
  fswHz: number;
  tDeadNs: number;
  mos: FocMosParams;
  model: FocThermalModel;
  vBusV: number;
  horizonSec?: number;
  stallDutyMode?: 'resistive' | 'user_m';
  rPhaseOhm?: number;
}

export interface FocStallSweepResult {
  anglesDeg: number[];
  steadyMaxTjPerAngle: number[];
  worstAngleDeg: number;
  worstSwitch: MosSwitchKey;
  worstSteadyTjC: number;
  steadySafe: boolean;
  tSafeSec: number | null;
  i2tThresholdA2s: number | null; // Backwards-compatible alias of i2tRmsA2s
  i2tRmsA2s: number | null;
  i2tWorstLegA2s: number | null;
  phaseSquaredRatioAtWorst: number; // peak phase I^2 / I_rms^2 (= 2.0 at theta=0)
  effectiveStallModDepthM: number;
  effectiveStallModulation: FocModulationMode;
  effectiveStallPfAngleDeg: number;
  rPhaseUsedOhm: number;
  stallVoltageLimited: boolean;
  stallSteadyConverged: boolean;
  stallThermalRunaway: boolean;
  inheritedHotState: boolean;
  inheritedBoardTempC: number;
  inheritedMaxTjC: number;
  transientTime: Float64Array;
  transientWorstTj: Float32Array;
}

export interface FocControlSweepResult {
  svpwm: FocSimulationResult;
  dpwm1: FocSimulationResult;
  spwm: FocSimulationResult;
  fswListHz: number[];
  tjMaxSvpwmByFsw: number[];
  tjMaxDpwm1ByFsw: number[];
  pMeanSvpwmByFsw: number[];
  pMeanDpwm1ByFsw: number[];
}

export const DEFAULT_FOC_MODEL: FocThermalModel = {
  zthJC: [
    { r: 0.14, c: 0.0035, tauEst: 0.00049, layerLabel: '芯片/焊料 (<10ms)' },
    { r: 0.36, c: 0.045, tauEst: 0.0162, layerLabel: '封装/基板 (10ms~1s)' },
  ],
  zthBoard: [
    { r: 0.45, c: 0.85, tauEst: 0.3825, layerLabel: 'PCB 铜箔共享节点' },
    { r: 0.65, c: 8.5, tauEst: 5.525, layerLabel: '散热器/环境 (>1s)' },
  ],
};

/**
 * Splits a single Cauer thermal ladder contiguously into per-MOS ZthJC (fast inner rungs)
 * and shared PCB/heatsink Zth_board (slow outer rungs), preserving physical ladder order
 * and quantifying capacitive shunting from the 5 unpowered JC arms on TBRD.
 */
export function splitCauerToFocModel(fullCauer: CauerStage[], tauSplitSec = 0.05): FocThermalModel {
  if (!fullCauer || fullCauer.length === 0) {
    return {
      zthJC: DEFAULT_FOC_MODEL.zthJC.map((s) => ({ ...s })),
      zthBoard: DEFAULT_FOC_MODEL.zthBoard.map((s) => ({ ...s })),
      isHeuristicSingleStageSplit: false,
    };
  }
  if (fullCauer.length === 1) {
    const s = fullCauer[0];
    const jcCap = s.c * 0.25;
    const brdCap = s.c * 0.75;
    const shuntCapRatioPct = brdCap > 1e-12 ? ((5 * jcCap) / brdCap) * 100 : 0;
    return {
      zthJC: [{ r: s.r * 0.4, c: jcCap, tauEst: s.r * 0.4 * jcCap, layerLabel: '芯片/封装 (经验拆分)' }],
      zthBoard: [{ r: s.r * 0.6, c: brdCap, tauEst: s.r * 0.6 * brdCap, layerLabel: 'PCB/散热器 (经验拆分)' }],
      isHeuristicSingleStageSplit: true,
      splitMeta: {
        tauSplitSec,
        boundaryIndex: 1,
        boundaryAdjusted: true,
        nonMonotonicTau: false,
        shuntCapRatioPct,
        warning: '单阶 Cauer 无法区分芯片与 PCB，已按经验比例拆分。',
      },
    };
  }

  let nonMonotonicTau = false;
  for (let i = 1; i < fullCauer.length; i++) {
    if (fullCauer[i].tauEst < fullCauer[i - 1].tauEst * 0.99) {
      nonMonotonicTau = true;
      break;
    }
  }

  // Find contiguous boundary split index so ladder node order TJ -> ... -> TBRD -> ... -> TAMB stays intact
  let splitIdx = fullCauer.findIndex((st) => st.tauEst > tauSplitSec);
  if (splitIdx === -1) splitIdx = fullCauer.length;

  let boundaryAdjusted = false;
  if (splitIdx <= 0) {
    splitIdx = 1;
    boundaryAdjusted = true;
  } else if (splitIdx >= fullCauer.length) {
    splitIdx = fullCauer.length - 1;
    boundaryAdjusted = true;
  }

  const jc = fullCauer.slice(0, splitIdx).map((s) => ({ ...s }));
  const brd = fullCauer.slice(splitIdx).map((s) => ({ ...s }));

  const sumJcCap = jc.reduce((s, c) => s + c.c, 0);
  const sumBrdCap = brd.reduce((s, c) => s + c.c, 0);
  const shuntCapRatioPct = sumBrdCap > 1e-12 ? ((5 * sumJcCap) / sumBrdCap) * 100 : 0;

  const noteParts: string[] = [];
  if (nonMonotonicTau) {
    noteParts.push('Cauer 阶梯时间常数 τ 非严格递增，已按物理连接顺序保持连续截断未重排');
  }
  if (boundaryAdjusted) {
    noteParts.push(`τ_split=${(tauSplitSec * 1e3).toFixed(1)}ms 越过全阶梯范围，已保留至少 1 阶 JC 与 1 阶 Board`);
  }
  if (shuntCapRatioPct > 35) {
    noteParts.push(
      `星形拓扑 5 条并联闲置管臂电容 (${(5 * sumJcCap).toFixed(3)} J/K) 占共享节点 Board 热容 (${sumBrdCap.toFixed(3)} J/K) 的 ${shuntCapRatioPct.toFixed(0)}%，单管瞬态将受并联分流影响`
    );
  }

  return {
    zthJC: jc,
    zthBoard: brd,
    isHeuristicSingleStageSplit: false,
    splitMeta: {
      tauSplitSec,
      boundaryIndex: splitIdx,
      boundaryAdjusted,
      nonMonotonicTau,
      shuntCapRatioPct,
      warning: noteParts.length > 0 ? noteParts.join('；') : null,
    },
  };
}

/**
 * Generates 7-port star-coupled LTspice thermal netlist:
 * .subckt INV_6MOS_THERM Q1 Q2 Q3 Q4 Q5 Q6 TAMB
 * Each MOS arm has its own grounded Cauer chain ZthJC meeting at shared TBRD -> Zth_board -> TAMB.
 */
export function focModelToSpice(
  model: FocThermalModel,
  tAmbC = 25,
  subcktName = 'INV_6MOS_THERM'
): string {
  const jc = model.zthJC.length > 0 ? model.zthJC : DEFAULT_FOC_MODEL.zthJC;
  const brd = model.zthBoard.length > 0 ? model.zthBoard : DEFAULT_FOC_MODEL.zthBoard;
  const lines: string[] = [
    `* Waveform Viewer Pro - 6-MOS Star-Coupled BLDC Inverter Thermal Subcircuit`,
    `* Ports: Q1(AH) Q2(AL) Q3(BH) Q4(BL) Q5(CH) Q6(CL) TAMB`,
    `* Shared Board Node: TBRD`,
    `.subckt ${subcktName} Q1 Q2 Q3 Q4 Q5 Q6 TAMB params: T_amb=${tAmbC.toFixed(2)}`,
  ];

  const icNodes: string[] = [];

  for (let m = 0; m < 6; m++) {
    const port = `Q${m + 1}`;
    const label = MOS_SWITCH_KEYS[m];
    icNodes.push(`V(${port})={T_amb}`);
    lines.push(`* --- MOSFET ${port} (${label}) ZthJC ---`);
    for (let k = 0; k < jc.length; k++) {
      const left = k === 0 ? port : `N${m + 1}_${k}`;
      const right = k === jc.length - 1 ? 'TBRD' : `N${m + 1}_${k + 1}`;
      if (k < jc.length - 1) icNodes.push(`V(N${m + 1}_${k + 1})={T_amb}`);
      lines.push(`C_${label}_${k + 1} ${left} 0 ${jc[k].c.toExponential(6)}`);
      lines.push(`R_${label}_${k + 1} ${left} ${right} ${jc[k].r.toExponential(6)}`);
    }
  }

  lines.push(`* --- Shared PCB / Heatsink Thermal Chain Zth_board ---`);
  icNodes.push(`V(TBRD)={T_amb}`);
  for (let k = 0; k < brd.length; k++) {
    const left = k === 0 ? 'TBRD' : `BRD_${k}`;
    const right = k === brd.length - 1 ? 'TAMB' : `BRD_${k + 1}`;
    if (k < brd.length - 1) icNodes.push(`V(BRD_${k + 1})={T_amb}`);
    lines.push(`C_BRD_${k + 1} ${left} 0 ${brd[k].c.toExponential(6)}`);
    lines.push(`R_BRD_${k + 1} ${left} ${right} ${brd[k].r.toExponential(6)}`);
  }

  lines.push(`.ic ${icNodes.join(' ')}`);
  lines.push(`.ends ${subcktName}`);
  lines.push('');
  lines.push(`* --- Example LTspice 6-MOS Harness ---`);
  lines.push(`* X_INV Q1 Q2 Q3 Q4 Q5 Q6 AMB ${subcktName} T_amb=${tAmbC.toFixed(2)}`);
  lines.push(`* V_AMB AMB 0 ${tAmbC.toFixed(2)}`);
  return lines.join('\n');
}

function parseSpiceNumber(raw: string): number {
  const s = raw.trim().toLowerCase();
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(meg|t|g|k|m|u|µ|n|p|f)?/.exec(s);
  if (!m) return Number.NaN;
  const num = Number.parseFloat(m[1]);
  if (!Number.isFinite(num)) return Number.NaN;
  const suf = m[2] || '';
  const mul: Record<string, number> = {
    '': 1,
    f: 1e-15,
    p: 1e-12,
    n: 1e-9,
    u: 1e-6,
    µ: 1e-6,
    m: 1e-3,
    k: 1e3,
    meg: 1e6,
    g: 1e9,
    t: 1e12,
  };
  return num * (mul[suf] ?? 1);
}

function solveLinearSystem(A: Float64Array[], b: Float64Array): Float64Array | null {
  const n = b.length;
  if (n === 0) return null;
  const mat = A.map((row) => Float64Array.from(row));
  const rhs = Float64Array.from(b);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxAbs = Math.abs(mat[col][col]);
    for (let r = col + 1; r < n; r++) {
      const av = Math.abs(mat[r][col]);
      if (av > maxAbs) {
        maxAbs = av;
        pivotRow = r;
      }
    }
    if (!Number.isFinite(maxAbs) || maxAbs < 1e-15) return null;
    if (pivotRow !== col) {
      const tmpR = mat[col];
      mat[col] = mat[pivotRow];
      mat[pivotRow] = tmpR;
      const tmpB = rhs[col];
      rhs[col] = rhs[pivotRow];
      rhs[pivotRow] = tmpB;
    }
    const diag = mat[col][col];
    for (let r = col + 1; r < n; r++) {
      const factor = mat[r][col] / diag;
      if (factor === 0) continue;
      for (let c = col; c < n; c++) {
        mat[r][c] -= factor * mat[col][c];
      }
      rhs[r] -= factor * rhs[col];
    }
  }

  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let sum = rhs[r];
    for (let c = r + 1; c < n; c++) {
      sum -= mat[r][c] * x[c];
    }
    x[r] = sum / mat[r][r];
    if (!Number.isFinite(x[r])) return null;
  }
  return x;
}

export function validateFocSpiceNetlist(
  spiceText: string,
  expectedModel?: FocThermalModel
): FocSpiceValidationResult {
  const rawLines = spiceText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('*'));
  const subcktLine = rawLines.find((l) => l.toLowerCase().startsWith('.subckt'));
  const caps: Array<{ name: string; n1: string; n2: string; val: number }> = [];
  const ress: Array<{ name: string; n1: string; n2: string; val: number }> = [];
  let icText = '';

  for (const l of rawLines) {
    const clean = l.split(';')[0].trim();
    const parts = clean.split(/\s+/);
    const p0 = parts[0]?.toUpperCase() || '';
    if (p0.startsWith('C') && parts.length >= 4) {
      caps.push({
        name: p0,
        n1: parts[1].toUpperCase(),
        n2: parts[2].toUpperCase(),
        val: parseSpiceNumber(parts[3]),
      });
    } else if (p0.startsWith('R') && parts.length >= 4) {
      ress.push({
        name: p0,
        n1: parts[1].toUpperCase(),
        n2: parts[2].toUpperCase(),
        val: parseSpiceNumber(parts[3]),
      });
    } else if (p0 === '.IC') {
      icText += ' ' + clean;
    }
  }

  const errors: string[] = [];
  const has7Ports = Boolean(
    subcktLine && /\bQ1\b\s+\bQ2\b\s+\bQ3\b\s+\bQ4\b\s+\bQ5\b\s+\bQ6\b\s+\bTAMB\b/i.test(subcktLine)
  );
  if (!has7Ports) errors.push('Missing required 7 ports (Q1 Q2 Q3 Q4 Q5 Q6 TAMB) on .subckt line.');

  const allCapsGroundedTo0 = caps.length > 0 && caps.every((c) => c.n2 === '0');
  if (!allCapsGroundedTo0) errors.push('All capacitors must connect to global ground node 0.');

  const noCapOnTamb = caps.every((c) => c.n1 !== 'TAMB' && c.n2 !== 'TAMB');
  if (!noCapOnTamb) errors.push('Capacitor attached directly to TAMB would be shorted.');

  const hasSharedBoardNode = ress.some((r) => r.n2 === 'TBRD') && ress.some((r) => r.n1 === 'TBRD');
  if (!hasSharedBoardNode) errors.push('Shared TBRD coupling node not connected between ZthJC and Zth_board.');

  const requiredIc = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'TBRD'];
  const hasDefensiveIc = requiredIc.every((nd) => new RegExp(`V\\(${nd}\\)\\s*=`, 'i').test(icText));
  if (!hasDefensiveIc) errors.push('Missing .ic on one or more MOSFET/board nodes.');

  const allValsPositive =
    ress.length > 0 &&
    caps.length > 0 &&
    ress.every((r) => Number.isFinite(r.val) && r.val > 0) &&
    caps.every((c) => Number.isFinite(c.val) && c.val > 0);
  if (!allValsPositive) errors.push('One or more netlist R/C values are non-positive or unparseable.');

  // Numerical DC nodal matrix verification directly from parsed resistors (TAMB = 0°C rise ref)
  let nodalMathVerified = false;
  let rJcParsed = Number.NaN;
  let rBrdParsed = Number.NaN;
  let dcCommonModeError = Number.NaN;

  if (allValsPositive) {
    const nodeIndex = new Map<string, number>();
    const addNode = (n: string) => {
      if (n === 'TAMB' || n === '0') return;
      if (!nodeIndex.has(n)) nodeIndex.set(n, nodeIndex.size);
    };
    for (const r of ress) {
      addNode(r.n1);
      addNode(r.n2);
    }

    const nNodes = nodeIndex.size;
    if (nNodes > 0 && requiredIc.every((nd) => nodeIndex.has(nd))) {
      const G = Array.from({ length: nNodes }, () => new Float64Array(nNodes));
      for (const r of ress) {
        const g = 1 / r.val;
        const i1 = nodeIndex.get(r.n1);
        const i2 = nodeIndex.get(r.n2);
        if (i1 !== undefined) G[i1][i1] += g;
        if (i2 !== undefined) G[i2][i2] += g;
        if (i1 !== undefined && i2 !== undefined) {
          G[i1][i2] -= g;
          G[i2][i1] -= g;
        }
      }

      // Common-mode test: 1 W into Q1..Q6 (6 W total)
      const rhsCm = new Float64Array(nNodes);
      for (let m = 1; m <= 6; m++) {
        rhsCm[nodeIndex.get(`Q${m}`)!] = 1.0;
      }
      const solCm = solveLinearSystem(G, rhsCm);

      // Single-arm test: 1 W into Q1 only
      const rhsOne = new Float64Array(nNodes);
      rhsOne[nodeIndex.get('Q1')!] = 1.0;
      const solOne = solveLinearSystem(G, rhsOne);

      if (solCm && solOne) {
        const tBrdCm = solCm[nodeIndex.get('TBRD')!];
        const rBrdCm = tBrdCm / 6;
        const rJcArms = [1, 2, 3, 4, 5, 6].map((m) => solCm[nodeIndex.get(`Q${m}`)!] - tBrdCm);
        const rJcMean = rJcArms.reduce((a, b) => a + b, 0) / 6;
        const armSpread = Math.max(...rJcArms.map((v) => Math.abs(v - rJcMean)));

        const tQ1One = solOne[nodeIndex.get('Q1')!];
        const tBrdOne = solOne[nodeIndex.get('TBRD')!];
        const oneArmErr = Math.abs(tQ1One - (rJcMean + rBrdCm)) + Math.abs(tBrdOne - rBrdCm);

        rJcParsed = rJcMean;
        rBrdParsed = rBrdCm;
        dcCommonModeError = armSpread + oneArmErr;

        let expectedErr = 0;
        if (expectedModel) {
          const jcExp = (expectedModel.zthJC.length > 0 ? expectedModel.zthJC : DEFAULT_FOC_MODEL.zthJC).reduce(
            (s, c) => s + c.r,
            0
          );
          const brdExp = (expectedModel.zthBoard.length > 0 ? expectedModel.zthBoard : DEFAULT_FOC_MODEL.zthBoard).reduce(
            (s, c) => s + c.r,
            0
          );
          expectedErr =
            Math.abs(rJcParsed - jcExp) / Math.max(1e-6, jcExp) +
            Math.abs(rBrdParsed - brdExp) / Math.max(1e-6, brdExp);
        }

        if (armSpread <= 1e-4 && oneArmErr <= 1e-4 && expectedErr <= 1e-3) {
          nodalMathVerified = true;
        } else {
          errors.push(
            `Nodal DC matrix verification mismatch (spread=${armSpread.toExponential(2)}, oneArmErr=${oneArmErr.toExponential(2)}, modelRelErr=${expectedErr.toExponential(2)}).`
          );
        }
      } else {
        errors.push('Parsed SPICE resistance matrix is singular or disconnected.');
      }
    } else {
      errors.push('Parsed netlist is missing required junction/board nodes.');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    has7Ports,
    allCapsGroundedTo0,
    noCapOnTamb,
    hasSharedBoardNode,
    hasDefensiveIc,
    nodalMathVerified,
    rJcParsed,
    rBrdParsed,
    dcCommonModeError,
  };
}

/**
 * Computes sensorless high-side duties d_a, d_b, d_c from phase currents Ia, Ib, Ic using Clarke transform.
 * Reports overmodulation if requested m > linear ceiling of chosen modulation strategy or any phase duty saturates.
 */
export function reconstructSensorlessDutySample(
  ia: number,
  ib: number,
  ic: number,
  modulation: FocModulationMode,
  modDepthM: number,
  pfAngleDeg: number
): { da: number; db: number; dc: number; overmodulated: boolean; linearCeilingM: number; zeroCurrentFallback: boolean } {
  const linearCeilingM = getModulationLinearCeiling(modulation);
  const sqrt3Inv = 1 / Math.sqrt(3);
  const iAlpha = (2 / 3) * (ia - 0.5 * (ib + ic));
  const iBeta = (ib - ic) * sqrt3Inv;
  const mag = Math.hypot(iAlpha, iBeta);

  if (mag < 1e-6) {
    return { da: 0.5, db: 0.5, dc: 0.5, overmodulated: false, linearCeilingM, zeroCurrentFallback: true };
  }

  const reqM = Math.max(0, modDepthM);
  if (reqM <= 1e-6) {
    return { da: 0.5, db: 0.5, dc: 0.5, overmodulated: false, linearCeilingM, zeroCurrentFallback: false };
  }

  const thetaI = Math.atan2(iBeta, iAlpha);
  const thetaV = thetaI + (pfAngleDeg * Math.PI) / 180;
  const twoPi3 = (2 * Math.PI) / 3;
  const m = Math.min(1.2, reqM);

  const ua = m * Math.cos(thetaV);
  const ub = m * Math.cos(thetaV - twoPi3);
  const uc = m * Math.cos(thetaV + twoPi3);

  let u0 = 0;
  if (modulation === 'SVPWM') {
    u0 = -0.5 * (Math.max(ua, ub, uc) + Math.min(ua, ub, uc));
  } else if (modulation === 'DPWM1') {
    const absA = Math.abs(ua);
    const absB = Math.abs(ub);
    const absC = Math.abs(uc);
    let uk = ua;
    if (absB >= absA && absB >= absC) uk = ub;
    else if (absC >= absA && absC >= absB) uk = uc;
    u0 = (uk >= 0 ? 1 : -1) - uk;
  }

  const rawA = 0.5 + 0.5 * (ua + u0);
  const rawB = 0.5 + 0.5 * (ub + u0);
  const rawC = 0.5 + 0.5 * (uc + u0);
  const overmodulated =
    reqM > linearCeilingM + 1e-6 ||
    rawA < -1e-6 ||
    rawA > 1 + 1e-6 ||
    rawB < -1e-6 ||
    rawB > 1 + 1e-6 ||
    rawC < -1e-6 ||
    rawC > 1 + 1e-6;

  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  return {
    da: clamp01(rawA),
    db: clamp01(rawB),
    dc: clamp01(rawC),
    overmodulated,
    linearCeilingM,
    zeroCurrentFallback: false,
  };
}

/**
 * Computes instantaneous per-MOS conduction, hard-switching + Qrr, and dead-time body-diode losses
 * for one half-bridge phase (H = upper switch, L = lower switch), conserving high + low + dead-time period.
 */
export function computePhaseMosLosses(
  iPhase: number,
  dutyHigh: number,
  vBus: number,
  tjHighC: number,
  tjLowC: number,
  _modulation: FocModulationMode,
  fswHz: number,
  tDeadNs: number,
  mos: FocMosParams
): {
  pHighTotal: number;
  pLowTotal: number;
  pHighCond: number;
  pLowCond: number;
  pHighSw: number;
  pLowSw: number;
  pHighDead: number;
  pLowDead: number;
} {
  const d = Math.max(0, Math.min(1, dutyHigh));
  const r25 = Math.max(1e-6, mos.rdsOn25Mohm * 1e-3);
  const alpha = mos.tempCoeffAlphaPerC || 0;
  const ronH = Math.max(1e-6, r25 * (1 + alpha * (tjHighC - 25)));
  const ronL = Math.max(1e-6, r25 * (1 + alpha * (tjLowC - 25)));

  // Whenever a leg duty clamps to 0 or 1 (DPWM1 60° clamp or external/saturated flat-top), PWM switching stops
  const clamped = d >= 1 - 1e-4 || d <= 1e-4;
  const tDeadSec = Math.max(0, tDeadNs) * 1e-9;
  const rawDeadDuty = !clamped && fswHz > 0 ? Math.min(1, 2 * tDeadSec * fswHz) : 0;
  const deadDuty = iPhase >= 0 ? Math.min(1 - d, rawDeadDuty) : Math.min(d, rawDeadDuty);

  const highCondDuty = iPhase >= 0 ? d : Math.max(0, d - deadDuty);
  const lowCondDuty = iPhase >= 0 ? Math.max(0, 1 - d - deadDuty) : 1 - d;

  const iSq = iPhase * iPhase;
  const pHighCond = iSq * ronH * highCondDuty;
  const pLowCond = iSq * ronL * lowCondDuty;

  let pSw = 0;
  let pDead = 0;

  if (!clamped && fswHz > 0) {
    const iAbs = Math.abs(iPhase);
    const vScale = Math.max(0, vBus) / Math.max(1e-3, mos.vRefV);
    const iScale = iAbs / Math.max(1e-3, mos.iRefA);
    const eSwJ = Math.max(0, mos.eonPlusEoffUj) * 1e-6 * vScale * iScale;
    const eQrrJ = Math.max(0, mos.qrrNc) * 1e-9 * Math.max(0, vBus) * iScale;
    // Half-bridge active hard-switching Coss capacitive discharge loss: once per PWM cycle on the active switch
    const eOssJ = Math.max(0, mos.eossUj ?? 0) * 1e-6 * vScale * vScale;
    pSw = fswHz * (eSwJ + eQrrJ + eOssJ);
    pDead = iAbs * Math.max(0, mos.vsdV) * deadDuty;
  }

  let pHighSw = 0;
  let pLowSw = 0;
  let pHighDead = 0;
  let pLowDead = 0;

  if (iPhase >= 0) {
    // Positive current out of half-bridge: High-side is active hard-switching, Low-side is sync rectifier w/ dead-time diode
    pHighSw = pSw;
    pLowDead = pDead;
  } else {
    // Negative current into half-bridge: Low-side is active hard-switching, High-side is sync rectifier w/ dead-time diode
    pLowSw = pSw;
    pHighDead = pDead;
  }

  return {
    pHighTotal: pHighCond + pHighSw + pHighDead,
    pLowTotal: pLowCond + pLowSw + pLowDead,
    pHighCond,
    pLowCond,
    pHighSw,
    pLowSw,
    pHighDead,
    pLowDead,
  };
}

/**
 * Exact O(6*Kj + Kb) star-coupled Implicit Backward-Euler step with Schur-complement elimination
 * across the 6 ZthJC arms into the shared Zth_board ladder.
 */
class StarCoupled6MosThermalSolver {
  private jc: CauerStage[];
  private brd: CauerStage[];
  private kj: number;
  private kb: number;
  private armT: Float64Array[]; // 6 x kj
  private brdT: Float64Array; // kb
  private tAmbC: number;
  private minTau: number;
  private maxSubDtOverTau: number = 0;

  // Scratch buffers
  private jcSub: Float64Array;
  private jcDiag: Float64Array;
  private jcSup: Float64Array;
  private jcCPrime: Float64Array;
  private jcDPrime: Float64Array;
  private jcCkDt: Float64Array;
  private jcDPrimesAll: Float64Array[];

  private brdSub: Float64Array;
  private brdDiag: Float64Array;
  private brdSup: Float64Array;
  private brdCPrime: Float64Array;
  private brdDPrime: Float64Array;
  private brdRhs: Float64Array;
  private brdCkDt: Float64Array;

  constructor(
    model: FocThermalModel,
    tAmbC: number,
    initialBoardTempC?: number,
    initialState?: ThermalNetworkStateSnapshot
  ) {
    this.jc = model.zthJC.length > 0 ? model.zthJC : DEFAULT_FOC_MODEL.zthJC;
    this.brd = model.zthBoard.length > 0 ? model.zthBoard : DEFAULT_FOC_MODEL.zthBoard;
    this.kj = this.jc.length;
    this.kb = this.brd.length;
    this.tAmbC = tAmbC;

    const fallbackBrdT =
      initialState && Number.isFinite(initialState.tBoardC)
        ? initialState.tBoardC
        : initialBoardTempC !== undefined && Number.isFinite(initialBoardTempC)
        ? initialBoardTempC
        : tAmbC;

    this.armT = Array.from({ length: 6 }, (_, m) => {
      const arr = new Float64Array(this.kj);
      const src = initialState?.armT?.[m];
      for (let k = 0; k < this.kj; k++) {
        arr[k] = src && src.length === this.kj && Number.isFinite(src[k]) ? src[k] : fallbackBrdT;
      }
      return arr;
    });
    this.brdT = new Float64Array(this.kb);
    for (let k = 0; k < this.kb; k++) {
      this.brdT[k] =
        initialState?.brdT && initialState.brdT.length === this.kb && Number.isFinite(initialState.brdT[k])
          ? initialState.brdT[k]
          : fallbackBrdT;
    }

    let mt = Infinity;
    for (const s of [...this.jc, ...this.brd]) {
      const t = s.r * s.c;
      if (isFinite(t) && t > 1e-12 && t < mt) mt = t;
    }
    this.minTau = isFinite(mt) ? mt : 1e-4;

    this.jcSub = new Float64Array(this.kj);
    this.jcDiag = new Float64Array(this.kj);
    this.jcSup = new Float64Array(this.kj);
    this.jcCPrime = new Float64Array(this.kj);
    this.jcDPrime = new Float64Array(this.kj);
    this.jcCkDt = new Float64Array(this.kj);
    this.jcDPrimesAll = Array.from({ length: 6 }, () => new Float64Array(this.kj));

    this.brdSub = new Float64Array(this.kb);
    this.brdDiag = new Float64Array(this.kb);
    this.brdSup = new Float64Array(this.kb);
    this.brdCPrime = new Float64Array(this.kb);
    this.brdDPrime = new Float64Array(this.kb);
    this.brdRhs = new Float64Array(this.kb);
    this.brdCkDt = new Float64Array(this.kb);
  }

  public getJunctionTemps(): number[] {
    return this.armT.map((arm) => arm[0]);
  }

  public getBoardTemp(): number {
    return this.brdT[0];
  }

  public getMaxSubDtOverTau(): number {
    return this.maxSubDtOverTau;
  }

  public getMinTau(): number {
    return this.minTau;
  }

  public getStateSnapshot(): ThermalNetworkStateSnapshot {
    const tj = this.getJunctionTemps();
    return {
      armT: this.armT.map((arm) => Array.from(arm)),
      brdT: Array.from(this.brdT),
      tBoardC: this.brdT[0],
      tjMaxC: Math.max(...tj),
    };
  }

  public step(dt: number, powers: number[]): void {
    if (dt <= 0) return;
    const subSteps = Math.min(512, Math.max(1, Math.ceil(dt / Math.max(1e-8, 0.05 * this.minTau))));
    const subDt = dt / subSteps;
    if (this.minTau > 0) {
      const ratio = subDt / this.minTau;
      if (ratio > this.maxSubDtOverTau) this.maxSubDtOverTau = ratio;
    }

    const kj = this.kj;
    const kb = this.kb;

    // Factor identical JC arm matrix for this subDt
    for (let k = 0; k < kj; k++) {
      this.jcCkDt[k] = this.jc[k].c / subDt;
      const gL = k > 0 ? 1 / this.jc[k - 1].r : 0;
      const gR = 1 / this.jc[k].r;
      this.jcSub[k] = k > 0 ? -gL : 0;
      this.jcDiag[k] = this.jcCkDt[k] + gL + gR;
      this.jcSup[k] = k < kj - 1 ? -gR : 0;
    }
    this.jcCPrime[0] = kj > 1 ? this.jcSup[0] / this.jcDiag[0] : 0;
    let lastDenomJc = this.jcDiag[0];
    for (let k = 1; k < kj; k++) {
      const denom = this.jcDiag[k] - this.jcSub[k] * this.jcCPrime[k - 1];
      this.jcCPrime[k] = k < kj - 1 ? this.jcSup[k] / denom : 0;
      if (k === kj - 1) lastDenomJc = denom;
    }
    const gJcLast = 1 / this.jc[kj - 1].r;
    const gammaBoard = gJcLast / lastDenomJc; // T_{m, kj-1} = d'_{m, kj-1} + gammaBoard * T_board
    const gArms = 6 * gJcLast * (1 - gammaBoard);

    // Factor Zth_board matrix including Schur coupling gArms on node 0 (TBRD)
    for (let k = 0; k < kb; k++) {
      this.brdCkDt[k] = this.brd[k].c / subDt;
      const gL = k > 0 ? 1 / this.brd[k - 1].r : 0;
      const gR = 1 / this.brd[k].r;
      this.brdSub[k] = k > 0 ? -gL : 0;
      this.brdDiag[k] = this.brdCkDt[k] + gL + gR + (k === 0 ? gArms : 0);
      this.brdSup[k] = k < kb - 1 ? -gR : 0;
    }
    this.brdCPrime[0] = kb > 1 ? this.brdSup[0] / this.brdDiag[0] : 0;
    for (let k = 1; k < kb; k++) {
      const denom = this.brdDiag[k] - this.brdSub[k] * this.brdCPrime[k - 1];
      this.brdCPrime[k] = k < kb - 1 ? this.brdSup[k] / denom : 0;
    }

    const gBrdLast = 1 / this.brd[kb - 1].r;
    const ambRhs = this.tAmbC * gBrdLast;

    for (let sub = 0; sub < subSteps; sub++) {
      let sumLastDPrime = 0;
      for (let m = 0; m < 6; m++) {
        const arm = this.armT[m];
        const dp = this.jcDPrimesAll[m];
        const r0 = this.jcCkDt[0] * arm[0] + (powers[m] || 0);
        dp[0] = r0 / this.jcDiag[0];
        for (let k = 1; k < kj; k++) {
          const rk = this.jcCkDt[k] * arm[k];
          const denom = this.jcDiag[k] - this.jcSub[k] * this.jcCPrime[k - 1];
          dp[k] = (rk - this.jcSub[k] * dp[k - 1]) / denom;
        }
        sumLastDPrime += dp[kj - 1];
      }

      const pArms = gJcLast * sumLastDPrime;
      for (let k = 0; k < kb; k++) {
        this.brdRhs[k] =
          this.brdCkDt[k] * this.brdT[k] +
          (k === 0 ? pArms : 0) +
          (k === kb - 1 ? ambRhs : 0);
      }

      this.brdDPrime[0] = this.brdRhs[0] / this.brdDiag[0];
      for (let k = 1; k < kb; k++) {
        const denom = this.brdDiag[k] - this.brdSub[k] * this.brdCPrime[k - 1];
        this.brdDPrime[k] = (this.brdRhs[k] - this.brdSub[k] * this.brdDPrime[k - 1]) / denom;
      }

      this.brdT[kb - 1] = this.brdDPrime[kb - 1];
      for (let k = kb - 2; k >= 0; k--) {
        this.brdT[k] = this.brdDPrime[k] - this.brdCPrime[k] * this.brdT[k + 1];
      }

      const tBrd0 = this.brdT[0];
      for (let m = 0; m < 6; m++) {
        const arm = this.armT[m];
        const dp = this.jcDPrimesAll[m];
        arm[kj - 1] = dp[kj - 1] + gammaBoard * tBrd0;
        for (let k = kj - 2; k >= 0; k--) {
          arm[k] = dp[k] - this.jcCPrime[k] * arm[k + 1];
        }
      }
    }
  }
}

function computeDominantCauerTauSec(jcStages: CauerStage[], brdStages: CauerStage[]): number {
  const jc = jcStages.length > 0 ? jcStages : DEFAULT_FOC_MODEL.zthJC;
  const brd = brdStages.length > 0 ? brdStages : DEFAULT_FOC_MODEL.zthBoard;
  const rArr: number[] = [];
  const cArr: number[] = [];
  for (const s of jc) {
    rArr.push(Math.max(1e-9, s.r / 6));
    cArr.push(Math.max(1e-12, s.c * 6));
  }
  for (const s of brd) {
    rArr.push(Math.max(1e-9, s.r));
    cArr.push(Math.max(1e-12, s.c));
  }
  const n = rArr.length;
  if (n === 0) return 0;

  let elmoreSum = 0;
  let cumR = 0;
  for (let k = n - 1; k >= 0; k--) {
    cumR += rArr[k];
    elmoreSum += cArr[k] * cumR;
  }

  const G = Array.from({ length: n }, () => new Float64Array(n));
  for (let k = 0; k < n; k++) {
    const gL = k > 0 ? 1 / rArr[k - 1] : 0;
    const gR = 1 / rArr[k];
    G[k][k] = gL + gR;
    if (k > 0) G[k][k - 1] = -gL;
    if (k < n - 1) G[k][k + 1] = -gR;
  }

  let x = new Float64Array(n).fill(1 / Math.sqrt(n));
  let tauDom = elmoreSum;
  for (let it = 0; it < 28; it++) {
    const rhs = new Float64Array(n);
    for (let k = 0; k < n; k++) rhs[k] = cArr[k] * x[k];
    const y = solveLinearSystem(G, rhs);
    if (!y) return elmoreSum;

    let num = 0;
    let den = 0;
    let yNormSq = 0;
    for (let k = 0; k < n; k++) {
      num += x[k] * cArr[k] * y[k];
      den += x[k] * cArr[k] * x[k];
      yNormSq += y[k] * y[k];
    }
    if (den > 1e-18 && Number.isFinite(num)) {
      tauDom = num / den;
    }
    const yNorm = Math.sqrt(yNormSq);
    if (!Number.isFinite(yNorm) || yNorm <= 1e-18) break;
    const nextX = new Float64Array(n);
    for (let k = 0; k < n; k++) nextX[k] = y[k] / yNorm;
    x = nextX;
  }

  return Number.isFinite(tauDom) && tauDom > 0 ? tauDom : elmoreSum;
}

function solveCoupledThermalSteadyState(params: {
  pCond25W: number[];
  pFixedW: number[];
  alphaPerC: number;
  rJcTotal: number;
  rBrdTotal: number;
  tAmbC: number;
  tInitSeedC?: number[];
}): {
  tBoardSteadyC: number;
  tjSteadyC: number[];
  converged: boolean;
  thermalRunaway: boolean;
} {
  const { pCond25W, pFixedW, alphaPerC, rJcTotal, rBrdTotal, tAmbC, tInitSeedC } = params;
  const kArm = pCond25W.map((p25) => alphaPerC * p25);
  const p0Arm = pCond25W.map((p25, m) => pFixedW[m] + p25 * (1 - 25 * alphaPerC));

  const armStable = kArm.every((km) => 1 - rJcTotal * km > 1e-6);
  let gLoop = Infinity;
  let analyticOk = false;
  let analyticBrd = tAmbC;
  const analyticTj = new Array<number>(6).fill(tAmbC);

  if (armStable) {
    let sumKOverDen = 0;
    let sumP0OverDen = 0;
    for (let m = 0; m < 6; m++) {
      const den = 1 - rJcTotal * kArm[m];
      sumKOverDen += kArm[m] / den;
      sumP0OverDen += p0Arm[m] / den;
    }
    gLoop = rBrdTotal * sumKOverDen;
    if (gLoop < 1 - 1e-6) {
      analyticBrd = (tAmbC + rBrdTotal * sumP0OverDen) / (1 - gLoop);
      let allInsidePiecewiseLinear = Number.isFinite(analyticBrd) && analyticBrd <= 2000;
      for (let m = 0; m < 6; m++) {
        const den = 1 - rJcTotal * kArm[m];
        const tm = (analyticBrd + rJcTotal * p0Arm[m]) / den;
        analyticTj[m] = tm;
        if (!Number.isFinite(tm) || tm > 2000 || 1 + alphaPerC * (tm - 25) < 0.1) {
          allInsidePiecewiseLinear = false;
        }
      }
      if (allInsidePiecewiseLinear) {
        analyticOk = true;
      }
    }
  }

  if (analyticOk) {
    return {
      tBoardSteadyC: analyticBrd,
      tjSteadyC: analyticTj,
      converged: true,
      thermalRunaway: false,
    };
  }

  // Iterative fallback with convergence check & thermal runaway detection
  const tjVec = tInitSeedC ? [...tInitSeedC] : new Array<number>(6).fill(tAmbC + 10);
  let tBrd = tAmbC;
  let converged = false;
  let runaway = !armStable || gLoop >= 1 - 1e-6;

  for (let it = 0; it < 120; it++) {
    const pArm = new Array<number>(6);
    let pSum = 0;
    for (let m = 0; m < 6; m++) {
      const rFactor = Math.max(0.1, 1 + alphaPerC * (tjVec[m] - 25));
      pArm[m] = pFixedW[m] + pCond25W[m] * rFactor;
      pSum += pArm[m];
    }
    const nextBrd = Math.min(2000, Math.max(-50, tAmbC + pSum * rBrdTotal));
    let maxDelta = Math.abs(nextBrd - tBrd);
    tBrd = nextBrd;
    for (let m = 0; m < 6; m++) {
      const candT = tBrd + pArm[m] * rJcTotal;
      const nextT = Number.isFinite(candT) ? Math.min(2000, Math.max(-50, candT)) : 2000;
      maxDelta = Math.max(maxDelta, Math.abs(nextT - tjVec[m]));
      tjVec[m] = nextT;
    }
    if (tBrd >= 1999.9 || tjVec.some((v) => v >= 1999.9)) {
      runaway = true;
    }
    if (maxDelta < 1e-4 && !runaway) {
      converged = true;
      break;
    }
  }

  return {
    tBoardSteadyC: tBrd,
    tjSteadyC: tjVec,
    converged: converged && !runaway,
    thermalRunaway: runaway,
  };
}

/**
 * Main Phase 2 Transient Simulator:
 * Evaluates 6-MOS inverter junction temperatures & losses directly from FOC Ia, Ib, (Ic) + Vbus (+ optional Duty_A/B/C).
 */
export function simulateFoc6Mos(
  iaCh: WaveformChannel,
  ibCh: WaveformChannel,
  model: FocThermalModel,
  mos: FocMosParams,
  ctrl: FocControlParams,
  opts?: FocSimulationOptions
): FocSimulationResult {
  const nIa = Math.min(iaCh.t.length, iaCh.v.length);
  const nIb = Math.min(ibCh.t.length, ibCh.v.length);
  if (nIa < 4 || nIb < 2) {
    throw new Error('At least 4 Ia samples and 2 Ib samples are required for BLDC FOC 6-MOS thermal evaluation.');
  }
  if (iaCh.id && ibCh.id && iaCh.id === ibCh.id) {
    throw new Error(
      'Ia 与 Ib 不能选择同一通道：单电阻 (Single-Shunt) 母线采样系统需先在示波器或控制器端重构三相相电流 Ia/Ib/Ic 后，再进行 6-MOS 热仿真。'
    );
  }

  // Validate primary timebase monotonicity & finiteness across [0..nIa-1] up front
  // so neither gate lookup nor preheat/main step integration ever sees NaN/Inf/backward dt.
  let duplicateMainTimestamps = 0;
  for (let idx = 0; idx < nIa; idx++) {
    const tVal = iaCh.t[idx];
    if (!Number.isFinite(tVal)) {
      throw new Error(`主通道 Ia 时间轴在索引 ${idx} 处存在 NaN/Inf 无效时间戳，请先清洗或重采样后再仿真。`);
    }
    if (idx > 0) {
      const dt = tVal - iaCh.t[idx - 1];
      if (dt < -1e-15) {
        throw new Error(
          `主通道 Ia 时间轴在索引 ${idx} 处发生时间倒退 (${tVal.toFixed(6)}s < ${iaCh.t[idx - 1].toFixed(6)}s)，无法保证热网络因果积分。`
        );
      }
      if (dt === 0) duplicateMainTimestamps++;
    }
  }

  let i0 = 0;
  let i1 = nIa - 1;
  if (opts?.tStart !== undefined) while (i0 < nIa && iaCh.t[i0] < opts.tStart) i0++;
  if (opts?.tEnd !== undefined) while (i1 > i0 && iaCh.t[i1] > opts.tEnd) i1--;
  const len = Math.max(0, i1 - i0 + 1);
  if (len < 4) {
    throw new Error('At least 4 samples inside gate are required for BLDC FOC 6-MOS thermal evaluation.');
  }
  if (iaCh.t[i1] - iaCh.t[i0] <= 1e-15) {
    throw new Error('选定时间门控内有效时间跨度为 0 s（全部为重复时间戳），无法积分热功耗与温升。');
  }

  const gateThermalMode: 'preheat' | 'cold' = opts?.gateThermalMode === 'cold' ? 'cold' : 'preheat';

  const mIa = iaCh.coupling === 'AC' ? computeChannelMean(iaCh) : 0;
  const mIb = ibCh.coupling === 'AC' ? computeChannelMean(ibCh) : 0;
  const icCh = opts?.icCh || null;
  if (icCh && icCh.id && (icCh.id === iaCh.id || icCh.id === ibCh.id)) {
    throw new Error('Ic 不能与 Ia 或 Ib 选择同一通道；若仅有两相电流采样，请将 Ic 设为 Auto: Ic = -(Ia + Ib)。');
  }
  const mIc = icCh && icCh.coupling === 'AC' ? computeChannelMean(icCh) : 0;
  const vbusCh = opts?.vbusCh || null;
  const mVbus = vbusCh && vbusCh.coupling === 'AC' ? computeChannelMean(vbusCh) : 0;

  const iaScale = parseSiUnitScale(iaCh.unit, 'A', iaCh.name, { strict: true });
  const ibScale = parseSiUnitScale(ibCh.unit, 'A', ibCh.name, { strict: true });
  const icScale = icCh ? parseSiUnitScale(icCh.unit, 'A', icCh.name, { strict: true }) : 1;
  const vbusScale = vbusCh ? parseSiUnitScale(vbusCh.unit, 'V', vbusCh.name, { strict: true }) : 1;

  const rawDa = opts?.dutyChs?.da || null;
  const rawDb = opts?.dutyChs?.db || null;
  const rawDc = opts?.dutyChs?.dc || null;
  const partialDutySelected =
    (rawDa || rawDb || rawDc) !== null && !(rawDa && rawDb && rawDc);
  const daCh = rawDa && rawDb && rawDc ? rawDa : null;
  const dbCh = rawDa && rawDb && rawDc ? rawDb : null;
  const dcCh = rawDa && rawDb && rawDc ? rawDc : null;

  const alignmentWarnings: string[] = [];
  if (duplicateMainTimestamps > 0) {
    alignmentWarnings.push(`主通道 Ia 存在 ${duplicateMainTimestamps} 处重复时间戳 (dt=0 s)，该点热积分已安全跳过零步长。`);
  }

  const checkSameTb = (ch: WaveformChannel | null): boolean => {
    if (!ch) return false;
    const nc = Math.min(ch.t.length, ch.v.length);
    if (nc !== nIa) return false;
    if (ch.t === iaCh.t) return true;
    for (let i = 0; i < nc; i++) {
      if (!Number.isFinite(ch.t[i]) || Math.abs(ch.t[i] - iaCh.t[i]) > 1e-12) return false;
    }
    return true;
  };

  interface GapSafeSampler {
    sample: (targetT: number, idxHint: number) => number;
    repairedNanCount: number;
    finiteCount: number;
  }

  const buildGapSafeSampler = (
    ch: WaveformChannel,
    scale: number,
    meanAc: number,
    label: string,
    isSame: boolean,
    simStart: number,
    simEnd: number
  ): GapSafeSampler => {
    const nc = Math.min(ch.t.length, ch.v.length);
    const covSpan = Math.max(1e-9, simEnd - simStart);
    const covEps = Math.max(1e-9, covSpan * 1e-5);

    // Filter finite timestamps & build sorted order if aux timebase is non-monotonic or has NaN/Inf timestamps
    let badTCount = 0;
    let nonMono = false;
    const validIndices: number[] = [];
    let prevT = -Infinity;
    for (let i = 0; i < nc; i++) {
      const t = ch.t[i];
      if (!Number.isFinite(t)) {
        badTCount++;
        continue;
      }
      if (validIndices.length > 0 && t < prevT - 1e-15) {
        nonMono = true;
      }
      prevT = t;
      validIndices.push(i);
    }

    if (!isSame) {
      if (badTCount > 0) {
        alignmentWarnings.push(`通道 ${label} 时间轴存在 ${badTCount} 个 NaN/Inf 无效时间戳，已自动剔除后按有效时刻插值。`);
      }
      if (nonMono) {
        validIndices.sort((a, b) => ch.t[a] - ch.t[b]);
        alignmentWarnings.push(`通道 ${label} 时间轴非单调递增，已按时间重排后执行对齐插值。`);
      }
      if (validIndices.length > 0) {
        const cStart = ch.t[validIndices[0]];
        const cEnd = ch.t[validIndices[validIndices.length - 1]];
        if (cStart > simStart + covEps || cEnd < simEnd - covEps) {
          alignmentWarnings.push(
            `通道 ${label} 时间覆盖 [${cStart.toFixed(4)}s, ${cEnd.toFixed(4)}s] 未完整覆盖仿真区间 [${simStart.toFixed(4)}s, ${simEnd.toFixed(4)}s]，越界点将保持首/尾边界值。`
          );
        }
      }
    }

    const m = validIndices.length;
    const tArr = new Float64Array(m);
    const vRaw = new Float64Array(m);
    const vRepaired = new Float64Array(m);
    let finiteCount = 0;
    let rawNanCount = 0;
    for (let k = 0; k < m; k++) {
      const orig = validIndices[k];
      tArr[k] = ch.t[orig];
      const val = getChannelDisplayValue(ch, orig, meanAc) * scale;
      if (Number.isFinite(val)) {
        vRaw[k] = val;
        finiteCount++;
      } else {
        vRaw[k] = Number.NaN;
        rawNanCount++;
      }
    }

    if (finiteCount > 0 && rawNanCount > 0) {
      // Precompute O(M) gap-filled signal array via linear interpolation across NaN runs
      const prevValid = new Int32Array(m).fill(-1);
      const nextValid = new Int32Array(m).fill(-1);
      let lastV = -1;
      for (let k = 0; k < m; k++) {
        if (Number.isFinite(vRaw[k])) lastV = k;
        prevValid[k] = lastV;
      }
      let nextV = -1;
      for (let k = m - 1; k >= 0; k--) {
        if (Number.isFinite(vRaw[k])) nextV = k;
        nextValid[k] = nextV;
      }
      for (let k = 0; k < m; k++) {
        if (Number.isFinite(vRaw[k])) {
          vRepaired[k] = vRaw[k];
        } else {
          const p = prevValid[k];
          const q = nextValid[k];
          if (p >= 0 && q >= 0) {
            const span = tArr[q] - tArr[p];
            vRepaired[k] =
              span > 1e-15 ? vRaw[p] + ((tArr[k] - tArr[p]) / span) * (vRaw[q] - vRaw[p]) : vRaw[p];
          } else if (p >= 0) {
            vRepaired[k] = vRaw[p];
          } else if (q >= 0) {
            vRepaired[k] = vRaw[q];
          } else {
            vRepaired[k] = 0;
          }
        }
      }
      alignmentWarnings.push(`通道 ${label} 含 ${rawNanCount} 个 NaN/Inf 异常值，已按邻近有效点线性插值/保持修复（未清零）。`);
    } else {
      for (let k = 0; k < m; k++) {
        vRepaired[k] = finiteCount > 0 ? vRaw[k] : 0;
      }
    }

    if (finiteCount === 0) {
      alignmentWarnings.push(`通道 ${label} 全部样本均无效 (NaN/Inf)。`);
    }

    const sample = (targetT: number, idxHint: number): number => {
      if (m === 0 || finiteCount === 0) return 0;
      if (isSame && idxHint >= 0 && idxHint < m && badTCount === 0 && !nonMono) {
        return vRepaired[idxHint];
      }
      if (targetT <= tArr[0]) return vRepaired[0];
      if (targetT >= tArr[m - 1]) return vRepaired[m - 1];
      let lo = 0;
      let hi = m - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (tArr[mid] <= targetT) lo = mid;
        else hi = mid;
      }
      const dt = tArr[hi] - tArr[lo];
      const frac = dt > 1e-18 ? (targetT - tArr[lo]) / dt : 0;
      return vRepaired[lo] + frac * (vRepaired[hi] - vRepaired[lo]);
    };

    return { sample, repairedNanCount: rawNanCount, finiteCount };
  };

  const simTStart = iaCh.t[i0];
  const simTEnd = iaCh.t[i1];

  const sameIb = checkSameTb(ibCh);
  const sameIc = checkSameTb(icCh);
  const sameVbus = checkSameTb(vbusCh);
  const sameDa = checkSameTb(daCh);
  const sameDb = checkSameTb(dbCh);
  const sameDc = checkSameTb(dcCh);

  const iaSampler = buildGapSafeSampler(iaCh, iaScale, mIa, `Ia(${iaCh.name})`, true, simTStart, simTEnd);
  const ibSampler = buildGapSafeSampler(ibCh, ibScale, mIb, `Ib(${ibCh.name})`, sameIb, simTStart, simTEnd);
  if (iaSampler.finiteCount === 0 || ibSampler.finiteCount === 0) {
    throw new Error('Ia 或 Ib 通道缺少有效数值样本 (全为 NaN/Inf)，无法执行 6-MOS 热仿真。');
  }
  const icSampler = icCh
    ? buildGapSafeSampler(icCh, icScale, mIc, `Ic(${icCh.name})`, sameIc, simTStart, simTEnd)
    : null;
  const vbusSampler = vbusCh
    ? buildGapSafeSampler(vbusCh, vbusScale, mVbus, `Vbus(${vbusCh.name})`, sameVbus, simTStart, simTEnd)
    : null;

  // Determine channel-level external Duty format (explicit '%' unit vs scanned max > 1.05 across all 3 duty channels)
  const useExternalDuty = Boolean(daCh && dbCh && dcCh);
  let dutyScale = 1;
  let dutyPctInferredWithoutUnit = false;
  let dutyBinaryPulseSuspected = false;

  if (useExternalDuty && daCh && dbCh && dcCh) {
    const dutyList = [daCh, dbCh, dcCh];
    for (const ch of dutyList) {
      const u = (ch.unit || '').trim();
      if (u && /^(?:[µμunmk]?(?:V|A|W|Hz|Ω)|°C|degC|rpm|volt|volts|amp|amps|watt|watts|ohm)$/i.test(u)) {
        throw new Error(`外部占空比通道 "${ch.name}" 单位 "${u}" 与占空比无量纲 / % 不匹配，请确认通道选择。`);
      }
    }
    const hasPctUnit = dutyList.some((ch) => /^(%|pct|percent)$/i.test((ch.unit || '').trim()));
    let maxFiniteDuty = -Infinity;
    let totalDutySamples = 0;
    let extremeBoundaryCount = 0;
    let finiteDutySum = 0;

    for (const ch of dutyList) {
      const nD = Math.min(ch.t.length, ch.v.length);
      for (let i = 0; i < nD; i++) {
        const val = getChannelDisplayValue(ch, i, 0);
        if (!Number.isFinite(val)) continue;
        if (val > maxFiniteDuty) maxFiniteDuty = val;
      }
    }

    if (hasPctUnit) {
      dutyScale = 0.01;
    } else if (maxFiniteDuty > 1.05 && maxFiniteDuty <= 100.5) {
      dutyScale = 0.01;
      dutyPctInferredWithoutUnit = true;
    }

    for (const ch of dutyList) {
      const nD = Math.min(ch.t.length, ch.v.length);
      const stride = nD > 20000 ? Math.floor(nD / 20000) : 1;
      for (let i = 0; i < nD; i += stride) {
        const rawVal = getChannelDisplayValue(ch, i, 0);
        if (!Number.isFinite(rawVal)) continue;
        const dScaled = rawVal * dutyScale;
        totalDutySamples++;
        finiteDutySum += Math.max(0, Math.min(1, dScaled));
        if (dScaled <= 1e-4 || dScaled >= 1 - 1e-4) extremeBoundaryCount++;
      }
    }
    if (totalDutySamples >= 20) {
      const fracExtreme = extremeBoundaryCount / totalDutySamples;
      const meanDuty = finiteDutySum / totalDutySamples;
      if (fracExtreme > 0.95 && meanDuty > 0.05 && meanDuty < 0.95) {
        dutyBinaryPulseSuspected = true;
      }
    }
  }

  const daSampler = daCh
    ? buildGapSafeSampler(daCh, dutyScale, 0, `Duty_A(${daCh.name})`, sameDa, simTStart, simTEnd)
    : null;
  const dbSampler = dbCh
    ? buildGapSafeSampler(dbCh, dutyScale, 0, `Duty_B(${dbCh.name})`, sameDb, simTStart, simTEnd)
    : null;
  const dcSampler = dcCh
    ? buildGapSafeSampler(dcCh, dutyScale, 0, `Duty_C(${dcCh.name})`, sameDc, simTStart, simTEnd)
    : null;

  const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
  let overmodulatedCount = 0;
  let zeroCurrentFallbackCount = 0;

  // Estimate electrical fundamental samples-per-cycle from raw Ia zero-crossings (DC stall keeps zeroCrossings < 3 -> null)
  let zeroCrossings = 0;
  let prevSign = 0;
  let maxAbsIa = 0;
  for (let idx = i0; idx <= i1; idx++) {
    const v = Math.abs(iaSampler.sample(iaCh.t[idx], idx));
    if (v > maxAbsIa) maxAbsIa = v;
  }
  const zEps = Math.max(1e-6, maxAbsIa * 0.02);
  for (let idx = i0; idx <= i1; idx++) {
    const v = iaSampler.sample(iaCh.t[idx], idx);
    const s = v > zEps ? 1 : v < -zEps ? -1 : 0;
    if (s !== 0) {
      if (prevSign !== 0 && s !== prevSign) zeroCrossings++;
      prevSign = s;
    }
  }
  const elecCycles = zeroCrossings >= 3 ? zeroCrossings / 2 : 0;
  const pointsPerElecCycle = elecCycles >= 1.5 ? len / elecCycles : null;

  const evalStepLossesAt = (
    idx: number,
    curTj: number[],
    countOvermod: boolean
  ): {
    da: number;
    db: number;
    dc: number;
    pStep: number[];
    pCondStep: number[];
    pSwStep: number[];
    pDeadStep: number[];
  } => {
    const tCurr = iaCh.t[idx];
    const ia = iaSampler.sample(tCurr, idx);
    const ib = ibSampler.sample(tCurr, idx);
    const ic = icSampler ? icSampler.sample(tCurr, idx) : -(ia + ib);
    const vbus = vbusSampler ? Math.max(0, vbusSampler.sample(tCurr, idx)) : Math.max(0, ctrl.vBusConstV);

    let da: number;
    let db: number;
    let dc: number;
    if (useExternalDuty && daSampler && dbSampler && dcSampler) {
      da = clamp01(daSampler.sample(tCurr, idx));
      db = clamp01(dbSampler.sample(tCurr, idx));
      dc = clamp01(dcSampler.sample(tCurr, idx));
    } else {
      const rec = reconstructSensorlessDutySample(
        ia,
        ib,
        ic,
        ctrl.modulation,
        ctrl.modDepthM,
        ctrl.pfAngleDeg
      );
      da = rec.da;
      db = rec.db;
      dc = rec.dc;
      if (countOvermod && rec.overmodulated) {
        overmodulatedCount++;
      }
      if (countOvermod && rec.zeroCurrentFallback) {
        zeroCurrentFallbackCount++;
      }
    }

    const lA = computePhaseMosLosses(ia, da, vbus, curTj[0], curTj[1], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);
    const lB = computePhaseMosLosses(ib, db, vbus, curTj[2], curTj[3], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);
    const lC = computePhaseMosLosses(ic, dc, vbus, curTj[4], curTj[5], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);

    return {
      da,
      db,
      dc,
      pStep: [lA.pHighTotal, lA.pLowTotal, lB.pHighTotal, lB.pLowTotal, lC.pHighTotal, lC.pLowTotal],
      pCondStep: [lA.pHighCond, lA.pLowCond, lB.pHighCond, lB.pLowCond, lC.pHighCond, lC.pLowCond],
      pSwStep: [lA.pHighSw, lA.pLowSw, lB.pHighSw, lB.pLowSw, lC.pHighSw, lC.pLowSw],
      pDeadStep: [lA.pHighDead, lA.pLowDead, lB.pHighDead, lB.pLowDead, lC.pHighDead, lC.pLowDead],
    };
  };

  const solver = new StarCoupled6MosThermalSolver(model, ctrl.tAmbC);
  const preheatDurationSec = i0 > 0 ? Math.max(0, iaCh.t[i0] - iaCh.t[0]) : 0;

  if (i0 > 0 && gateThermalMode === 'preheat') {
    for (let idx = 0; idx < i0; idx++) {
      const dtPre = Math.max(0, iaCh.t[idx + 1] - iaCh.t[idx]);
      if (dtPre <= 0) continue;
      const curTj = solver.getJunctionTemps();
      const { pStep } = evalStepLossesAt(idx, curTj, false);
      solver.step(dtPre, pStep);
    }
  }

  const tjInitial = solver.getJunctionTemps();
  const thermalInitInfo: FocThermalInitInfo = {
    gated: i0 > 0,
    mode: gateThermalMode,
    preheatDurationSec,
    tjInitialMaxC: Math.max(...tjInitial),
    tBoardInitialC: solver.getBoardTemp(),
  };

  const time = new Float64Array(len);
  const tj: Record<MosSwitchKey, Float32Array> = {
    AH: new Float32Array(len),
    AL: new Float32Array(len),
    BH: new Float32Array(len),
    BL: new Float32Array(len),
    CH: new Float32Array(len),
    CL: new Float32Array(len),
  };
  const pMos: Record<MosSwitchKey, Float32Array> = {
    AH: new Float32Array(len),
    AL: new Float32Array(len),
    BH: new Float32Array(len),
    BL: new Float32Array(len),
    CH: new Float32Array(len),
    CL: new Float32Array(len),
  };
  const pInvTotal = new Float32Array(len);
  const tBoard = new Float32Array(len);
  const duty = {
    a: new Float32Array(len),
    b: new Float32Array(len),
    c: new Float32Array(len),
  };

  const sumPEnergy = new Float64Array(6);
  const sumCondEnergy = new Float64Array(6);
  const sumSwEnergy = new Float64Array(6);
  const sumDeadEnergy = new Float64Array(6);
  const sumTjDt = new Float64Array(6);
  const peakTj = new Float64Array(6).fill(-Infinity);

  // Fallback arithmetic accumulators only if total duration is zero
  const arithP = new Float64Array(6);
  const arithCond = new Float64Array(6);
  const arithSw = new Float64Array(6);
  const arithDead = new Float64Array(6);
  const arithTj = new Float64Array(6);
  let arithPInvSum = 0;

  const totalDt = Math.max(0, iaCh.t[i1] - iaCh.t[i0]);
  const rippleStartTime = iaCh.t[i0] + 0.7 * totalDt;
  const ripMin = new Float64Array(6).fill(Infinity);
  const ripMax = new Float64Array(6).fill(-Infinity);

  let pInvEnergy = 0;
  let accumulatedDt = 0;

  for (let k = 0; k < len; k++) {
    const idx = i0 + k;
    const tCurr = iaCh.t[idx];
    time[k] = tCurr;

    const curTj = solver.getJunctionTemps();
    const stepRes = evalStepLossesAt(idx, curTj, true);

    duty.a[k] = stepRes.da;
    duty.b[k] = stepRes.db;
    duty.c[k] = stepRes.dc;

    let stepTotal = 0;
    for (let m = 0; m < 6; m++) {
      const key = MOS_SWITCH_KEYS[m];
      pMos[key][k] = stepRes.pStep[m];
      tj[key][k] = curTj[m];
      stepTotal += stepRes.pStep[m];

      arithP[m] += stepRes.pStep[m];
      arithCond[m] += stepRes.pCondStep[m];
      arithSw[m] += stepRes.pSwStep[m];
      arithDead[m] += stepRes.pDeadStep[m];
      arithTj[m] += curTj[m];

      if (curTj[m] > peakTj[m]) peakTj[m] = curTj[m];
      if (tCurr >= rippleStartTime - 1e-15) {
        if (curTj[m] < ripMin[m]) ripMin[m] = curTj[m];
        if (curTj[m] > ripMax[m]) ripMax[m] = curTj[m];
      }
    }

    pInvTotal[k] = stepTotal;
    arithPInvSum += stepTotal;
    tBoard[k] = solver.getBoardTemp();

    if (k < len - 1) {
      const dt = Math.max(0, iaCh.t[idx + 1] - iaCh.t[idx]);
      solver.step(dt, stepRes.pStep);
      const nextTj = solver.getJunctionTemps();
      if (dt > 0) {
        accumulatedDt += dt;
        pInvEnergy += stepTotal * dt;
        for (let m = 0; m < 6; m++) {
          sumPEnergy[m] += stepRes.pStep[m] * dt;
          sumCondEnergy[m] += stepRes.pCondStep[m] * dt;
          sumSwEnergy[m] += stepRes.pSwStep[m] * dt;
          sumDeadEnergy[m] += stepRes.pDeadStep[m] * dt;
          sumTjDt[m] += 0.5 * (curTj[m] + nextTj[m]) * dt;
        }
      }
    }
  }

  const useTimeAvg = accumulatedDt > 1e-15;
  const summaries: MosSwitchSummary[] = MOS_SWITCH_KEYS.map((key, m) => ({
    key,
    tjAvgC: useTimeAvg ? sumTjDt[m] / accumulatedDt : arithTj[m] / len,
    tjPeakC: peakTj[m],
    tjFinalC: tj[key][len - 1],
    tjRippleC: ripMax[m] > -Infinity && ripMin[m] < Infinity ? Math.max(0, ripMax[m] - ripMin[m]) : 0,
    pAvgW: useTimeAvg ? sumPEnergy[m] / accumulatedDt : arithP[m] / len,
    pCondAvgW: useTimeAvg ? sumCondEnergy[m] / accumulatedDt : arithCond[m] / len,
    pSwAvgW: useTimeAvg ? sumSwEnergy[m] / accumulatedDt : arithSw[m] / len,
    pDeadAvgW: useTimeAvg ? sumDeadEnergy[m] / accumulatedDt : arithDead[m] / len,
  }));

  let hottestKey: MosSwitchKey = 'AH';
  let tjMaxGlobalC = -Infinity;
  for (const s of summaries) {
    if (s.tjPeakC > tjMaxGlobalC) {
      tjMaxGlobalC = s.tjPeakC;
      hottestKey = s.key;
    }
  }

  const pInvMeanW = useTimeAvg ? pInvEnergy / accumulatedDt : arithPInvSum / len;
  const tBoardFinalC = tBoard[len - 1];

  // Coupled steady-state extrapolation (exact coupled thermal/Rds(on)(Tj) solve + runaway check)
  const jcStages = model.zthJC.length > 0 ? model.zthJC : DEFAULT_FOC_MODEL.zthJC;
  const brdStages = model.zthBoard.length > 0 ? model.zthBoard : DEFAULT_FOC_MODEL.zthBoard;
  const rJcTotal = jcStages.reduce((s, c) => s + c.r, 0);
  const rBrdTotal = brdStages.reduce((s, c) => s + c.r, 0);
  const tauMaxBoardSec = computeDominantCauerTauSec(jcStages, brdStages);

  const alpha = mos.tempCoeffAlphaPerC || 0;
  const steadySolve = solveCoupledThermalSteadyState({
    pCond25W: summaries.map((s) => s.pCondAvgW / Math.max(0.1, 1 + alpha * (s.tjAvgC - 25))),
    pFixedW: summaries.map((s) => s.pSwAvgW + s.pDeadAvgW),
    alphaPerC: alpha,
    rJcTotal,
    rBrdTotal,
    tAmbC: ctrl.tAmbC,
    tInitSeedC: summaries.map((s) => s.tjAvgC),
  });

  const tBoardSteadyEstC = steadySolve.tBoardSteadyC;
  const tjSteadyEstByKey = {} as Record<MosSwitchKey, number>;
  let tjSteadyMaxEstC = -Infinity;
  MOS_SWITCH_KEYS.forEach((k, m) => {
    tjSteadyEstByKey[k] = steadySolve.tjSteadyC[m];
    if (steadySolve.tjSteadyC[m] > tjSteadyMaxEstC) tjSteadyMaxEstC = steadySolve.tjSteadyC[m];
  });

  const deltaBoardSteady = tBoardSteadyEstC - ctrl.tAmbC;
  const deltaBoardFinal = tBoardFinalC - ctrl.tAmbC;
  const thermalConvergencePct = steadySolve.thermalRunaway
    ? 0
    : deltaBoardSteady > 0.05
    ? Math.max(0, Math.min(100, (deltaBoardFinal / deltaBoardSteady) * 100))
    : 100;

  const maxSubDtOverTau = solver.getMaxSubDtOverTau();
  const finalThermalState = solver.getStateSnapshot();

  const warnings: string[] = [...alignmentWarnings];
  if (partialDutySelected) {
    warnings.push('仅选择了部分外部 Duty 通道，需同时指定 Duty_A / Duty_B / Duty_C 三路才会启用外部占空比，当前已回退为无传感器重构。');
  }
  if (useExternalDuty && dutyPctInferredWithoutUnit) {
    warnings.push('外部 Duty_A/B/C 未显式标注 "%" 单位，但检测到数值 > 1.05，已按百分比 (0~100%) 统一换算为 [0, 1]（含 < 1.5% 小占空比）。');
  }
  if (useExternalDuty && dutyBinaryPulseSuspected) {
    warnings.push('外部 Duty_A/B/C 超过 95% 样本处于精确 0 或 1（疑似原始 PWM 开关方波脉冲而非周期平均占空比），开关损耗将被按钳位跳过。');
  }
  if (!useExternalDuty && overmodulatedCount > 0) {
    const ceiling = getModulationLinearCeiling(ctrl.modulation);
    warnings.push(
      `调制深度 m=${ctrl.modDepthM.toFixed(3)} 超出 ${ctrl.modulation} 线性区上限 (${ceiling.toFixed(4)})，共 ${overmodulatedCount} 采样点进入过调制削波区 [0, 1]，损耗未包含过调制谐波增幅。`
    );
  }
  if (!useExternalDuty && zeroCurrentFallbackCount > 0) {
    warnings.push(
      `共 ${zeroCurrentFallbackCount} 个采样点相电流矢量幅值 |I_αβ| < 1e-6 A（零电流/停机区间），无传感器占空比重构无法观测转子电角度，已安全回退为中点占空比 0.50（若需精确零电流 PWM 损耗请接入外部 Duty_A/B/C 或位置传感器）。`
    );
  }
  if (pointsPerElecCycle !== null && pointsPerElecCycle < 6) {
    warnings.push(
      `相电流基波电周期采样点数偏低（约 ${pointsPerElecCycle.toFixed(1)} 点/电周期 < 6 点/电周期），基波包络与 RMS 热耗散统计可能失真（注意：本准则是电基波包络采样率限制，并非开关载波 PWM 奈奎斯特判据）。`
    );
  }
  if (maxSubDtOverTau > 0.25) {
    warnings.push(
      `波形采样步长远大于最快热时间常数 τ_min=${(solver.getMinTau() * 1e3).toFixed(3)}ms，即使经 512 级子步细分后仍有 max(subDt/τ_min)=${maxSubDtOverTau.toFixed(2)} > 0.25，快瞬态芯片结温峰值可能被数值平滑。`
    );
  }
  if (i0 > 0) {
    if (gateThermalMode === 'cold') {
      warnings.push(
        `时间门控从 t=${iaCh.t[i0].toFixed(4)}s 启动并选择了「冷启动重置至 T_amb=${ctrl.tAmbC.toFixed(1)}°C」，门控前 ${preheatDurationSec.toFixed(4)}s 的温升未计入。`
      );
    } else {
      warnings.push(
        `已继承门控前 ${preheatDurationSec.toFixed(4)}s 热历史：初值 Tj_max=${thermalInitInfo.tjInitialMaxC.toFixed(2)}°C, T_board=${thermalInitInfo.tBoardInitialC.toFixed(2)}°C。`
      );
    }
  }
  if (steadySolve.thermalRunaway) {
    warnings.push(
      `检测到正温度系数 α=${(alpha * 100).toFixed(2)}%/°C 与高热阻耦合引发热失控（稳态反馈环路增益 ≥ 1），结温不存在有限稳态平衡点（预览已钳位至 ${tjSteadyMaxEstC.toFixed(0)}°C）。`
    );
  } else if (tauMaxBoardSec > 0 && accumulatedDt < 2.5 * tauMaxBoardSec && thermalConvergencePct < 90) {
    warnings.push(
      `当前仿真时长 ${accumulatedDt.toFixed(3)}s 仅覆盖系统主导时间常数 τ_dom=${tauMaxBoardSec.toFixed(2)}s 的 ${(accumulatedDt / tauMaxBoardSec).toFixed(2)}×（T_board 收敛 ${thermalConvergencePct.toFixed(1)}%），稳态预测约为 T_board=${tBoardSteadyEstC.toFixed(1)}°C, Tj_max=${tjSteadyMaxEstC.toFixed(1)}°C。`
    );
  }

  return {
    time,
    tj,
    pMos,
    pInvTotal,
    tBoard,
    duty,
    summaries,
    hottestKey,
    tjMaxGlobalC,
    pInvMeanW,
    tBoardFinalC,
    durationSec: accumulatedDt,
    tauMaxBoardSec,
    tBoardSteadyEstC,
    tjSteadyMaxEstC,
    tjSteadyEstByKey,
    thermalConvergencePct,
    steadyConverged: steadySolve.converged,
    steadyThermalRunaway: steadySolve.thermalRunaway,
    overmodulatedCount,
    zeroCurrentFallbackCount,
    maxSubDtOverTau,
    pointsPerElecCycle,
    finalThermalState,
    dutySource: useExternalDuty ? 'external' : 'reconstructed',
    alignmentWarnings,
    warnings,
    thermalInitInfo,
  };
}

/**
 * Phase 2 Stall Sweep (Zero-Speed Locked-Rotor 0..360 deg Electrical Angle Scan):
 * Finds worst electrical angle and switch, checks steady-state margin vs Tj_limit,
 * solves exact safe stall time t_safe (s) and dual I^2*t thresholds (phase RMS and worst phase leg).
 */
export function runFocStallSweep(opts: FocStallSweepOptions): FocStallSweepResult {
  const jc = opts.model.zthJC.length > 0 ? opts.model.zthJC : DEFAULT_FOC_MODEL.zthJC;
  const brd = opts.model.zthBoard.length > 0 ? opts.model.zthBoard : DEFAULT_FOC_MODEL.zthBoard;
  const rJc = jc.reduce((s, c) => s + c.r, 0);
  const rBrd = brd.reduce((s, c) => s + c.r, 0);

  const stallMode = opts.stallDutyMode === 'user_m' ? 'user_m' : 'resistive';
  const rPhaseUsedOhm =
    opts.rPhaseOhm !== undefined && Number.isFinite(opts.rPhaseOhm) && opts.rPhaseOhm > 0
      ? opts.rPhaseOhm
      : 0.25;
  const rTotalPhase = rPhaseUsedOhm + Math.max(0, opts.mos.rdsOn25Mohm * 1e-3);
  const svpwmCeiling = getModulationLinearCeiling('SVPWM');
  const mReqStall = (2 * opts.iPeakA * rTotalPhase) / Math.max(1, opts.vBusV);
  const stallVoltageLimited = stallMode === 'resistive' && mReqStall > svpwmCeiling + 1e-6;
  const effM =
    stallMode === 'resistive'
      ? Math.min(svpwmCeiling, Math.max(0.005, mReqStall))
      : opts.modDepthM;
  const effMod: FocModulationMode = stallMode === 'resistive' ? 'SVPWM' : opts.modulation;
  const effPfAngleDeg = stallMode === 'user_m' ? (opts.pfAngleDeg ?? 0) : 0;

  const anglesDeg: number[] = [];
  const steadyMaxTjPerAngle: number[] = [];

  let worstAngleDeg = 0;
  let worstSwitch: MosSwitchKey = 'AH';
  let worstSteadyTjC = -Infinity;
  let phaseSquaredRatioAtWorst = 2.0;

  const twoPi3 = (2 * Math.PI) / 3;
  const iRmsPhase = opts.iPeakA / Math.SQRT2;
  const iRmsSq = Math.max(1e-9, iRmsPhase * iRmsPhase);

  let stallSteadyConverged = true;
  let stallThermalRunaway = false;

  for (let deg = 0; deg < 360; deg += 5) {
    const rad = (deg * Math.PI) / 180;
    const ia = opts.iPeakA * Math.cos(rad);
    const ib = opts.iPeakA * Math.cos(rad - twoPi3);
    const ic = opts.iPeakA * Math.cos(rad + twoPi3);

    const rec = reconstructSensorlessDutySample(ia, ib, ic, effMod, effM, effPfAngleDeg);

    const lBaseA = computePhaseMosLosses(ia, rec.da, opts.vBusV, 25, 25, effMod, opts.fswHz, opts.tDeadNs, opts.mos);
    const lBaseB = computePhaseMosLosses(ib, rec.db, opts.vBusV, 25, 25, effMod, opts.fswHz, opts.tDeadNs, opts.mos);
    const lBaseC = computePhaseMosLosses(ic, rec.dc, opts.vBusV, 25, 25, effMod, opts.fswHz, opts.tDeadNs, opts.mos);
    const stallSteady = solveCoupledThermalSteadyState({
      pCond25W: [
        lBaseA.pHighCond,
        lBaseA.pLowCond,
        lBaseB.pHighCond,
        lBaseB.pLowCond,
        lBaseC.pHighCond,
        lBaseC.pLowCond,
      ],
      pFixedW: [
        lBaseA.pHighSw + lBaseA.pHighDead,
        lBaseA.pLowSw + lBaseA.pLowDead,
        lBaseB.pHighSw + lBaseB.pHighDead,
        lBaseB.pLowSw + lBaseB.pLowDead,
        lBaseC.pHighSw + lBaseC.pHighDead,
        lBaseC.pLowSw + lBaseC.pLowDead,
      ],
      alphaPerC: opts.mos.tempCoeffAlphaPerC || 0,
      rJcTotal: rJc,
      rBrdTotal: rBrd,
      tAmbC: opts.tAmbC,
    });
    const tjSteady = stallSteady.tjSteadyC;
    if (!stallSteady.converged) stallSteadyConverged = false;
    if (stallSteady.thermalRunaway) stallThermalRunaway = true;

    let maxAngTj = -Infinity;
    let maxAngIdx = 0;
    for (let m = 0; m < 6; m++) {
      if (tjSteady[m] > maxAngTj) {
        maxAngTj = tjSteady[m];
        maxAngIdx = m;
      }
    }

    anglesDeg.push(deg);
    steadyMaxTjPerAngle.push(maxAngTj);

    if (maxAngTj > worstSteadyTjC) {
      worstSteadyTjC = maxAngTj;
      worstAngleDeg = deg;
      worstSwitch = MOS_SWITCH_KEYS[maxAngIdx];
      const maxPhaseSq = Math.max(ia * ia, ib * ib, ic * ic);
      phaseSquaredRatioAtWorst = maxPhaseSq / iRmsSq;
    }
  }

  // Run transient trajectory at worstAngleDeg to find exact t_safe to reach tjLimitC
  const wRad = (worstAngleDeg * Math.PI) / 180;
  const iaW = opts.iPeakA * Math.cos(wRad);
  const ibW = opts.iPeakA * Math.cos(wRad - twoPi3);
  const icW = opts.iPeakA * Math.cos(wRad + twoPi3);
  const recW = reconstructSensorlessDutySample(iaW, ibW, icW, effMod, effM, effPfAngleDeg);

  const horizon = Math.max(5, opts.horizonSec ?? 120);
  const nPts = 280;
  const transientTime = new Float64Array(nPts);
  const transientWorstTj = new Float32Array(nPts);

  // Geometric-log spacing from 1ms up to horizon
  for (let i = 0; i < nPts; i++) {
    transientTime[i] = i === 0 ? 0 : 1e-3 * Math.pow(horizon / 1e-3, (i - 1) / (nPts - 2));
  }

  const hasValidInitialState = Boolean(
    opts.initialThermalState &&
    Array.isArray(opts.initialThermalState.armT) &&
    opts.initialThermalState.armT.length === 6 &&
    Array.isArray(opts.initialThermalState.brdT) &&
    opts.initialThermalState.brdT.length > 0
  );
  const hasScalarBoardInit = opts.tInitialBoardC !== undefined && Number.isFinite(opts.tInitialBoardC);
  const inheritedHotState = hasValidInitialState || hasScalarBoardInit;

  const solver = new StarCoupled6MosThermalSolver(
    opts.model,
    opts.tAmbC,
    opts.tInitialBoardC ?? opts.tAmbC,
    opts.initialThermalState
  );
  const inheritedBoardTempC = solver.getBoardTemp();
  const inheritedMaxTjC = Math.max(...solver.getJunctionTemps());

  let tSafeSec: number | null = null;
  for (let i = 0; i < nPts; i++) {
    const cur = solver.getJunctionTemps();
    const maxNow = Math.max(...cur);
    transientWorstTj[i] = maxNow;

    if (tSafeSec === null && maxNow >= opts.tjLimitC) {
      if (i > 0 && transientWorstTj[i - 1] < opts.tjLimitC) {
        const denom = maxNow - transientWorstTj[i - 1];
        const frac = denom > 1e-9 ? (opts.tjLimitC - transientWorstTj[i - 1]) / denom : 0;
        tSafeSec = transientTime[i - 1] + frac * (transientTime[i] - transientTime[i - 1]);
      } else {
        tSafeSec = transientTime[i];
      }
    }

    if (i < nPts - 1) {
      const lA = computePhaseMosLosses(iaW, recW.da, opts.vBusV, cur[0], cur[1], effMod, opts.fswHz, opts.tDeadNs, opts.mos);
      const lB = computePhaseMosLosses(ibW, recW.db, opts.vBusV, cur[2], cur[3], effMod, opts.fswHz, opts.tDeadNs, opts.mos);
      const lC = computePhaseMosLosses(icW, recW.dc, opts.vBusV, cur[4], cur[5], effMod, opts.fswHz, opts.tDeadNs, opts.mos);
      const ps = [lA.pHighTotal, lA.pLowTotal, lB.pHighTotal, lB.pLowTotal, lC.pHighTotal, lC.pLowTotal];
      solver.step(transientTime[i + 1] - transientTime[i], ps);
    }
  }

  const steadySafe = !stallThermalRunaway && worstSteadyTjC <= opts.tjLimitC;
  const i2tRmsA2s = tSafeSec !== null ? iRmsSq * tSafeSec : null;
  const i2tWorstLegA2s = tSafeSec !== null ? phaseSquaredRatioAtWorst * iRmsSq * tSafeSec : null;

  return {
    anglesDeg,
    steadyMaxTjPerAngle,
    worstAngleDeg,
    worstSwitch,
    worstSteadyTjC,
    steadySafe,
    tSafeSec,
    i2tThresholdA2s: i2tRmsA2s,
    i2tRmsA2s,
    i2tWorstLegA2s,
    phaseSquaredRatioAtWorst,
    effectiveStallModDepthM: effM,
    effectiveStallModulation: effMod,
    effectiveStallPfAngleDeg: effPfAngleDeg,
    rPhaseUsedOhm,
    stallVoltageLimited,
    stallSteadyConverged,
    stallThermalRunaway,
    inheritedHotState,
    inheritedBoardTempC,
    inheritedMaxTjC,
    transientTime,
    transientWorstTj,
  };
}

/**
 * Compares SVPWM vs DPWM1 vs SPWM and runs an f_sw carrier-frequency trade-off sweep.
 */
export function runFocControlSweep(
  iaCh: WaveformChannel,
  ibCh: WaveformChannel,
  model: FocThermalModel,
  mos: FocMosParams,
  ctrl: FocControlParams,
  opts?: FocSimulationOptions
): FocControlSweepResult {
  const sweepOpts: FocSimulationOptions | undefined = opts ? { ...opts, dutyChs: undefined } : undefined;
  const svpwm = simulateFoc6Mos(iaCh, ibCh, model, mos, { ...ctrl, modulation: 'SVPWM' }, sweepOpts);
  const dpwm1 = simulateFoc6Mos(iaCh, ibCh, model, mos, { ...ctrl, modulation: 'DPWM1' }, sweepOpts);
  const spwm = simulateFoc6Mos(iaCh, ibCh, model, mos, { ...ctrl, modulation: 'SPWM' }, sweepOpts);

  const fswListHz = [8000, 12000, 16000, 20000, 30000, 40000, 50000];
  const tjMaxSvpwmByFsw: number[] = [];
  const tjMaxDpwm1ByFsw: number[] = [];
  const pMeanSvpwmByFsw: number[] = [];
  const pMeanDpwm1ByFsw: number[] = [];

  for (const fsw of fswListHz) {
    const rS = simulateFoc6Mos(iaCh, ibCh, model, mos, { ...ctrl, modulation: 'SVPWM', fswHz: fsw }, sweepOpts);
    const rD = simulateFoc6Mos(iaCh, ibCh, model, mos, { ...ctrl, modulation: 'DPWM1', fswHz: fsw }, sweepOpts);
    tjMaxSvpwmByFsw.push(rS.tjMaxGlobalC);
    tjMaxDpwm1ByFsw.push(rD.tjMaxGlobalC);
    pMeanSvpwmByFsw.push(rS.pInvMeanW);
    pMeanDpwm1ByFsw.push(rD.pInvMeanW);
  }

  return {
    svpwm,
    dpwm1,
    spwm,
    fswListHz,
    tjMaxSvpwmByFsw,
    tjMaxDpwm1ByFsw,
    pMeanSvpwmByFsw,
    pMeanDpwm1ByFsw,
  };
}
