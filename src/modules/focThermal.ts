/**
 * Waveform Viewer Pro - Phase 2: BLDC / PMSM FOC 6-MOS Inverter Thermal Engine
 *
 * Implements:
 * 1. 6-MOS Star-Coupled Thermal Network (6 independent ZthJC arms -> shared T_board -> Zth_board -> TAMB)
 *    solved in exact O(N * (6*Kj + Kb)) via Schur-complement tridiagonal elimination + sub-stepping.
 * 2. 7-port LTspice netlist generator & structural validator (.subckt INV_6MOS_THERM Q1 Q2 Q3 Q4 Q5 Q6 TAMB).
 * 3. Sensorless Clarke alpha-beta SVPWM / DPWM1 / SPWM duty-cycle reconstruction from Ia, Ib, (Ic) + Vbus.
 * 4. Physical synchronous-rectification & 3rd-quadrant dead-time loss attribution with DPWM clamping zeroing.
 * 5. Zero-speed Locked-Rotor Stall Sweep (0..360 deg) with t_safe & firmware I^2*t threshold solver.
 * 6. SVPWM vs DPWM1 & switching-frequency (f_sw) trade-off analysis.
 */

import { WaveformChannel } from '../types/models';
import { CauerStage } from './thermalEngine';
import { computeChannelMean, getChannelDisplayValue } from './oscilloscopeScale';

export type FocModulationMode = 'SVPWM' | 'DPWM1' | 'SPWM';
export type MosSwitchKey = 'AH' | 'AL' | 'BH' | 'BL' | 'CH' | 'CL';

export const MOS_SWITCH_KEYS: MosSwitchKey[] = ['AH', 'AL', 'BH', 'BL', 'CH', 'CL'];

export interface FocThermalModel {
  zthJC: CauerStage[];
  zthBoard: CauerStage[];
}

export interface FocMosParams {
  rdsOn25Mohm: number;
  tempCoeffAlphaPerC: number; // e.g. 0.0045 (/°C)
  vsdV: number; // body diode drop (V)
  eonPlusEoffUj: number; // switching loss ref Eon+Eoff (uJ) at vRefV, iRefA
  vRefV: number;
  iRefA: number;
  qrrNc: number; // reverse recovery charge (nC) at iRefA
}

export interface FocControlParams {
  modulation: FocModulationMode;
  fswHz: number;
  tDeadNs: number;
  modDepthM: number; // [0 .. 1.15]
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
  icCh?: WaveformChannel | null;
  vbusCh?: WaveformChannel | null;
  dutyChs?: { da?: WaveformChannel | null; db?: WaveformChannel | null; dc?: WaveformChannel | null };
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
}

export interface FocSpiceValidationResult {
  valid: boolean;
  errors: string[];
  has7Ports: boolean;
  allCapsGroundedTo0: boolean;
  noCapOnTamb: boolean;
  hasSharedBoardNode: boolean;
  hasDefensiveIc: boolean;
}

export interface FocStallSweepOptions {
  iPeakA: number;
  tjLimitC: number;
  tAmbC: number;
  tInitialBoardC?: number;
  modulation: FocModulationMode;
  modDepthM: number;
  fswHz: number;
  tDeadNs: number;
  mos: FocMosParams;
  model: FocThermalModel;
  vBusV: number;
  horizonSec?: number;
}

export interface FocStallSweepResult {
  anglesDeg: number[];
  steadyMaxTjPerAngle: number[];
  worstAngleDeg: number;
  worstSwitch: MosSwitchKey;
  worstSteadyTjC: number;
  steadySafe: boolean;
  tSafeSec: number | null;
  i2tThresholdA2s: number | null;
  phaseSquaredRatioAtWorst: number; // peak phase I^2 / I_rms^2 (= 2.0 at theta=0)
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
 * Splits a single Cauer thermal ladder into per-MOS ZthJC (fast stages <= tauSplitSec)
 * and shared PCB/heatsink Zth_board (slow stages > tauSplitSec).
 */
export function splitCauerToFocModel(fullCauer: CauerStage[], tauSplitSec = 0.05): FocThermalModel {
  if (!fullCauer || fullCauer.length === 0) {
    return {
      zthJC: DEFAULT_FOC_MODEL.zthJC.map((s) => ({ ...s })),
      zthBoard: DEFAULT_FOC_MODEL.zthBoard.map((s) => ({ ...s })),
    };
  }
  if (fullCauer.length === 1) {
    const s = fullCauer[0];
    return {
      zthJC: [{ r: s.r * 0.4, c: s.c * 0.25, tauEst: s.r * 0.4 * s.c * 0.25, layerLabel: '芯片/封装 (拆分)' }],
      zthBoard: [{ r: s.r * 0.6, c: s.c * 0.75, tauEst: s.r * 0.6 * s.c * 0.75, layerLabel: 'PCB/散热器 (拆分)' }],
    };
  }

  const jc: CauerStage[] = [];
  const brd: CauerStage[] = [];
  for (const st of fullCauer) {
    if (st.tauEst <= tauSplitSec) jc.push({ ...st });
    else brd.push({ ...st });
  }
  if (jc.length === 0) {
    jc.push({ ...fullCauer[0] });
    brd.shift();
  }
  if (brd.length === 0) {
    const last = jc.pop()!;
    brd.push({ ...last });
  }
  return { zthJC: jc, zthBoard: brd };
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

export function validateFocSpiceNetlist(spiceText: string): FocSpiceValidationResult {
  const rawLines = spiceText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('*'));
  const subcktLine = rawLines.find((l) => l.toLowerCase().startsWith('.subckt'));
  const caps: Array<{ n1: string; n2: string }> = [];
  const ress: Array<{ n1: string; n2: string }> = [];
  let icText = '';

  for (const l of rawLines) {
    const clean = l.split(';')[0].trim();
    const parts = clean.split(/\s+/);
    const p0 = parts[0]?.toUpperCase() || '';
    if (p0.startsWith('C') && parts.length >= 4) {
      caps.push({ n1: parts[1].toUpperCase(), n2: parts[2].toUpperCase() });
    } else if (p0.startsWith('R') && parts.length >= 4) {
      ress.push({ n1: parts[1].toUpperCase(), n2: parts[2].toUpperCase() });
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

  return {
    valid: errors.length === 0,
    errors,
    has7Ports,
    allCapsGroundedTo0,
    noCapOnTamb,
    hasSharedBoardNode,
    hasDefensiveIc,
  };
}

/**
 * Computes sensorless high-side duties d_a, d_b, d_c from phase currents Ia, Ib, Ic using Clarke transform.
 */
export function reconstructSensorlessDutySample(
  ia: number,
  ib: number,
  ic: number,
  modulation: FocModulationMode,
  modDepthM: number,
  pfAngleDeg: number
): { da: number; db: number; dc: number } {
  const sqrt3Inv = 1 / Math.sqrt(3);
  const iAlpha = (2 / 3) * (ia - 0.5 * (ib + ic));
  const iBeta = (ib - ic) * sqrt3Inv;
  const mag = Math.hypot(iAlpha, iBeta);

  if (mag < 1e-6) {
    return { da: 0.5, db: 0.5, dc: 0.5 };
  }

  const thetaI = Math.atan2(iBeta, iAlpha);
  const thetaV = thetaI + (pfAngleDeg * Math.PI) / 180;
  const twoPi3 = (2 * Math.PI) / 3;
  const m = Math.max(0, Math.min(1.15, modDepthM));

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

  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  return {
    da: clamp01(0.5 + 0.5 * (ua + u0)),
    db: clamp01(0.5 + 0.5 * (ub + u0)),
    dc: clamp01(0.5 + 0.5 * (uc + u0)),
  };
}

/**
 * Computes instantaneous per-MOS conduction, hard-switching + Qrr, and dead-time body-diode losses
 * for one half-bridge phase (H = upper switch, L = lower switch).
 */
export function computePhaseMosLosses(
  iPhase: number,
  dutyHigh: number,
  vBus: number,
  tjHighC: number,
  tjLowC: number,
  modulation: FocModulationMode,
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

  const iSq = iPhase * iPhase;
  const pHighCond = iSq * ronH * d;
  const pLowCond = iSq * ronL * (1 - d);

  const clamped = modulation === 'DPWM1' && (d >= 1 - 1e-4 || d <= 1e-4);
  let pSw = 0;
  let pDead = 0;

  if (!clamped && fswHz > 0) {
    const iAbs = Math.abs(iPhase);
    const vScale = Math.max(0, vBus) / Math.max(1e-3, mos.vRefV);
    const iScale = iAbs / Math.max(1e-3, mos.iRefA);
    const eSwJ = Math.max(0, mos.eonPlusEoffUj) * 1e-6 * vScale * iScale;
    const eQrrJ = Math.max(0, mos.qrrNc) * 1e-9 * Math.max(0, vBus) * iScale;
    pSw = fswHz * (eSwJ + eQrrJ);
    const tDeadSec = Math.max(0, tDeadNs) * 1e-9;
    pDead = iAbs * Math.max(0, mos.vsdV) * (2 * tDeadSec * fswHz);
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

  constructor(model: FocThermalModel, tAmbC: number, initialBoardTempC?: number) {
    this.jc = model.zthJC.length > 0 ? model.zthJC : DEFAULT_FOC_MODEL.zthJC;
    this.brd = model.zthBoard.length > 0 ? model.zthBoard : DEFAULT_FOC_MODEL.zthBoard;
    this.kj = this.jc.length;
    this.kb = this.brd.length;
    this.tAmbC = tAmbC;

    const initT = initialBoardTempC !== undefined && isFinite(initialBoardTempC) ? initialBoardTempC : tAmbC;
    this.armT = Array.from({ length: 6 }, () => new Float64Array(this.kj).fill(initT));
    this.brdT = new Float64Array(this.kb).fill(initT);

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

  public step(dt: number, powers: number[]): void {
    if (dt <= 0) return;
    const subSteps = Math.min(48, Math.max(1, Math.ceil(dt / Math.max(1e-8, 0.05 * this.minTau))));
    const subDt = dt / subSteps;

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

/**
 * Main Phase 2 Transient Simulator:
 * Evaluates 6-MOS inverter junction temperatures & losses directly from FOC Ia, Ib, (Ic) + Vbus.
 */
export function simulateFoc6Mos(
  iaCh: WaveformChannel,
  ibCh: WaveformChannel,
  model: FocThermalModel,
  mos: FocMosParams,
  ctrl: FocControlParams,
  opts?: FocSimulationOptions
): FocSimulationResult {
  const nFull = Math.min(iaCh.t.length, iaCh.v.length, ibCh.v.length);
  let i0 = 0;
  let i1 = nFull - 1;
  if (opts?.tStart !== undefined) while (i0 < nFull && iaCh.t[i0] < opts.tStart) i0++;
  if (opts?.tEnd !== undefined) while (i1 > i0 && iaCh.t[i1] > opts.tEnd) i1--;
  const len = Math.max(0, i1 - i0 + 1);
  if (len < 4) {
    throw new Error('At least 4 samples inside gate are required for BLDC FOC 6-MOS thermal evaluation.');
  }

  const mIa = iaCh.coupling === 'AC' ? computeChannelMean(iaCh) : 0;
  const mIb = ibCh.coupling === 'AC' ? computeChannelMean(ibCh) : 0;
  const icCh = opts?.icCh || null;
  const mIc = icCh && icCh.coupling === 'AC' ? computeChannelMean(icCh) : 0;
  const vbusCh = opts?.vbusCh || null;
  const mVbus = vbusCh && vbusCh.coupling === 'AC' ? computeChannelMean(vbusCh) : 0;

  const daCh = opts?.dutyChs?.da || null;
  const dbCh = opts?.dutyChs?.db || null;
  const dcCh = opts?.dutyChs?.dc || null;

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

  const solver = new StarCoupled6MosThermalSolver(model, ctrl.tAmbC);

  const sumP = new Float64Array(6);
  const sumCond = new Float64Array(6);
  const sumSw = new Float64Array(6);
  const sumDead = new Float64Array(6);
  const sumTj = new Float64Array(6);
  const peakTj = new Float64Array(6).fill(-Infinity);

  const rippleStart = Math.floor(len * 0.7);
  const ripMin = new Float64Array(6).fill(Infinity);
  const ripMax = new Float64Array(6).fill(-Infinity);

  const normDuty = (val: number): number => {
    const d = val > 1.5 && val <= 100 ? val / 100 : val;
    return d < 0 ? 0 : d > 1 ? 1 : d;
  };

  let pInvSum = 0;

  for (let k = 0; k < len; k++) {
    const idx = i0 + k;
    time[k] = iaCh.t[idx];

    const ia = getChannelDisplayValue(iaCh, idx, mIa);
    const ib = getChannelDisplayValue(ibCh, idx, mIb);
    const ic = icCh && idx < icCh.v.length ? getChannelDisplayValue(icCh, idx, mIc) : -(ia + ib);
    const vbus =
      vbusCh && idx < vbusCh.v.length
        ? Math.max(0, getChannelDisplayValue(vbusCh, idx, mVbus))
        : Math.max(0, ctrl.vBusConstV);

    let da: number;
    let db: number;
    let dc: number;
    if (
      daCh && dbCh && dcCh &&
      idx < daCh.v.length && idx < dbCh.v.length && idx < dcCh.v.length
    ) {
      da = normDuty(getChannelDisplayValue(daCh, idx, 0));
      db = normDuty(getChannelDisplayValue(dbCh, idx, 0));
      dc = normDuty(getChannelDisplayValue(dcCh, idx, 0));
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
    }

    duty.a[k] = da;
    duty.b[k] = db;
    duty.c[k] = dc;

    const curTj = solver.getJunctionTemps();
    const lA = computePhaseMosLosses(ia, da, vbus, curTj[0], curTj[1], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);
    const lB = computePhaseMosLosses(ib, db, vbus, curTj[2], curTj[3], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);
    const lC = computePhaseMosLosses(ic, dc, vbus, curTj[4], curTj[5], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);

    const pStep = [lA.pHighTotal, lA.pLowTotal, lB.pHighTotal, lB.pLowTotal, lC.pHighTotal, lC.pLowTotal];
    const pCondStep = [lA.pHighCond, lA.pLowCond, lB.pHighCond, lB.pLowCond, lC.pHighCond, lC.pLowCond];
    const pSwStep = [lA.pHighSw, lA.pLowSw, lB.pHighSw, lB.pLowSw, lC.pHighSw, lC.pLowSw];
    const pDeadStep = [lA.pHighDead, lA.pLowDead, lB.pHighDead, lB.pLowDead, lC.pHighDead, lC.pLowDead];

    let stepTotal = 0;
    for (let m = 0; m < 6; m++) {
      const key = MOS_SWITCH_KEYS[m];
      pMos[key][k] = pStep[m];
      tj[key][k] = curTj[m];
      stepTotal += pStep[m];

      sumP[m] += pStep[m];
      sumCond[m] += pCondStep[m];
      sumSw[m] += pSwStep[m];
      sumDead[m] += pDeadStep[m];
      sumTj[m] += curTj[m];
      if (curTj[m] > peakTj[m]) peakTj[m] = curTj[m];
      if (k >= rippleStart) {
        if (curTj[m] < ripMin[m]) ripMin[m] = curTj[m];
        if (curTj[m] > ripMax[m]) ripMax[m] = curTj[m];
      }
    }

    pInvTotal[k] = stepTotal;
    pInvSum += stepTotal;
    tBoard[k] = solver.getBoardTemp();

    if (k < len - 1) {
      const dt = Math.max(0, iaCh.t[idx + 1] - iaCh.t[idx]);
      solver.step(dt, pStep);
    }
  }

  const summaries: MosSwitchSummary[] = MOS_SWITCH_KEYS.map((key, m) => ({
    key,
    tjAvgC: sumTj[m] / len,
    tjPeakC: peakTj[m],
    tjFinalC: tj[key][len - 1],
    tjRippleC: ripMax[m] > -Infinity && ripMin[m] < Infinity ? Math.max(0, ripMax[m] - ripMin[m]) : 0,
    pAvgW: sumP[m] / len,
    pCondAvgW: sumCond[m] / len,
    pSwAvgW: sumSw[m] / len,
    pDeadAvgW: sumDead[m] / len,
  }));

  let hottestKey: MosSwitchKey = 'AH';
  let tjMaxGlobalC = -Infinity;
  for (const s of summaries) {
    if (s.tjPeakC > tjMaxGlobalC) {
      tjMaxGlobalC = s.tjPeakC;
      hottestKey = s.key;
    }
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
    pInvMeanW: pInvSum / len,
    tBoardFinalC: tBoard[len - 1],
  };
}

/**
 * Phase 2 Stall Sweep (Zero-Speed Locked-Rotor 0..360 deg Electrical Angle Scan):
 * Finds worst electrical angle and switch, checks steady-state margin vs Tj_limit,
 * solves exact safe stall time t_safe (s) and firmware I^2*t protection threshold.
 */
export function runFocStallSweep(opts: FocStallSweepOptions): FocStallSweepResult {
  const jc = opts.model.zthJC.length > 0 ? opts.model.zthJC : DEFAULT_FOC_MODEL.zthJC;
  const brd = opts.model.zthBoard.length > 0 ? opts.model.zthBoard : DEFAULT_FOC_MODEL.zthBoard;
  const rJc = jc.reduce((s, c) => s + c.r, 0);
  const rBrd = brd.reduce((s, c) => s + c.r, 0);

  const anglesDeg: number[] = [];
  const steadyMaxTjPerAngle: number[] = [];

  let worstAngleDeg = 0;
  let worstSwitch: MosSwitchKey = 'AH';
  let worstSteadyTjC = -Infinity;
  let phaseSquaredRatioAtWorst = 2.0;

  const twoPi3 = (2 * Math.PI) / 3;
  const iRmsPhase = opts.iPeakA / Math.SQRT2;
  const iRmsSq = Math.max(1e-9, iRmsPhase * iRmsPhase);

  for (let deg = 0; deg < 360; deg += 5) {
    const rad = (deg * Math.PI) / 180;
    const ia = opts.iPeakA * Math.cos(rad);
    const ib = opts.iPeakA * Math.cos(rad - twoPi3);
    const ic = opts.iPeakA * Math.cos(rad + twoPi3);

    const rec = reconstructSensorlessDutySample(
      ia,
      ib,
      ic,
      opts.modulation,
      opts.modDepthM,
      0
    );

    // Fixed-point solve for steady-state coupled junction temperatures (Rds(on)(Tj) feedback)
    const tjSteady = new Float64Array(6).fill(opts.tAmbC + 10);
    for (let it = 0; it < 16; it++) {
      const lA = computePhaseMosLosses(ia, rec.da, opts.vBusV, tjSteady[0], tjSteady[1], opts.modulation, opts.fswHz, opts.tDeadNs, opts.mos);
      const lB = computePhaseMosLosses(ib, rec.db, opts.vBusV, tjSteady[2], tjSteady[3], opts.modulation, opts.fswHz, opts.tDeadNs, opts.mos);
      const lC = computePhaseMosLosses(ic, rec.dc, opts.vBusV, tjSteady[4], tjSteady[5], opts.modulation, opts.fswHz, opts.tDeadNs, opts.mos);
      const ps = [lA.pHighTotal, lA.pLowTotal, lB.pHighTotal, lB.pLowTotal, lC.pHighTotal, lC.pLowTotal];
      const pSum = ps.reduce((a, b) => a + b, 0);
      const tBrd = opts.tAmbC + pSum * rBrd;
      for (let m = 0; m < 6; m++) {
        tjSteady[m] = tBrd + ps[m] * rJc;
      }
    }

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
  const recW = reconstructSensorlessDutySample(iaW, ibW, icW, opts.modulation, opts.modDepthM, 0);

  const horizon = Math.max(5, opts.horizonSec ?? 120);
  const nPts = 280;
  const transientTime = new Float64Array(nPts);
  const transientWorstTj = new Float32Array(nPts);

  // Geometric-log spacing from 1ms up to horizon
  for (let i = 0; i < nPts; i++) {
    transientTime[i] = i === 0 ? 0 : 1e-3 * Math.pow(horizon / 1e-3, (i - 1) / (nPts - 2));
  }

  const solver = new StarCoupled6MosThermalSolver(
    opts.model,
    opts.tAmbC,
    opts.tInitialBoardC ?? opts.tAmbC
  );

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
      const lA = computePhaseMosLosses(iaW, recW.da, opts.vBusV, cur[0], cur[1], opts.modulation, opts.fswHz, opts.tDeadNs, opts.mos);
      const lB = computePhaseMosLosses(ibW, recW.db, opts.vBusV, cur[2], cur[3], opts.modulation, opts.fswHz, opts.tDeadNs, opts.mos);
      const lC = computePhaseMosLosses(icW, recW.dc, opts.vBusV, cur[4], cur[5], opts.modulation, opts.fswHz, opts.tDeadNs, opts.mos);
      const ps = [lA.pHighTotal, lA.pLowTotal, lB.pHighTotal, lB.pLowTotal, lC.pHighTotal, lC.pLowTotal];
      solver.step(transientTime[i + 1] - transientTime[i], ps);
    }
  }

  const steadySafe = worstSteadyTjC <= opts.tjLimitC;
  const i2tThresholdA2s = tSafeSec !== null ? iRmsSq * tSafeSec : null;

  return {
    anglesDeg,
    steadyMaxTjPerAngle,
    worstAngleDeg,
    worstSwitch,
    worstSteadyTjC,
    steadySafe,
    tSafeSec,
    i2tThresholdA2s,
    phaseSquaredRatioAtWorst,
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
  const svpwm = simulateFoc6Mos(iaCh, ibCh, model, mos, { ...ctrl, modulation: 'SVPWM' }, opts);
  const dpwm1 = simulateFoc6Mos(iaCh, ibCh, model, mos, { ...ctrl, modulation: 'DPWM1' }, opts);
  const spwm = simulateFoc6Mos(iaCh, ibCh, model, mos, { ...ctrl, modulation: 'SPWM' }, opts);

  const fswListHz = [8000, 12000, 16000, 20000, 30000, 40000, 50000];
  const tjMaxSvpwmByFsw: number[] = [];
  const tjMaxDpwm1ByFsw: number[] = [];
  const pMeanSvpwmByFsw: number[] = [];
  const pMeanDpwm1ByFsw: number[] = [];

  for (const fsw of fswListHz) {
    const rS = simulateFoc6Mos(iaCh, ibCh, model, mos, { ...ctrl, modulation: 'SVPWM', fswHz: fsw }, opts);
    const rD = simulateFoc6Mos(iaCh, ibCh, model, mos, { ...ctrl, modulation: 'DPWM1', fswHz: fsw }, opts);
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
