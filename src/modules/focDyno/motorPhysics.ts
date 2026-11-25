/**
 * FOC DynoLab V2 - Core BLDC/FOC Physics Engine (SI Units, Amplitude-Invariant Clarke/Park)
 *
 * Conventions (strictly verified against Waveform Viewer Pro's 6-MOS focThermal engine):
 * - Phase resistance at coil temperature: Rs(T_coil) = (R_LL_25 / 2) * (1 + 0.00393 * (T_coil - 25))
 * - Phase inductance: Lq = (L_LL_mH * 1e-3) / 2 [H]
 * - Amplitude-invariant Clarke/Park:
 *     Kt(Iq) = 1.5 * Ke' * K_sat(Iq), K_sat(Iq) = 1 / (1 + beta * Iq^2)
 *     Eq(Iq) = Ke' * omega_m * K_sat(Iq), P_elec = 1.5 * (Eq(Iq) * Iq + Rs * Iq^2)
 *     I_ph_RMS = |Iq| / sqrt(2), P_cu = 1.5 * Rs * Iq^2 = 3 * Rs * I_ph_RMS^2
 * - SVPWM Linear Modulation Limit: 2 / sqrt(3) ≈ 1.154700538
 *     m = V_ph_peak / (V_bus_cap / 2), m_norm = m / (2 / sqrt(3)) = sqrt(3) * V_ph_peak / V_bus_cap
 * - 4-Quadrant Power Factor Angle phi_deg = wrap(-180..+180](theta_V - theta_I)
 *     Matches focThermal reconstructSensorlessDutySample(theta_V = theta_I + pfAngleDeg).
 */

import { DEFAULT_SAMPLING_GAP_FACTOR } from '../timeSync';

export type OperatingMode = 'motoring' | 'regen' | 'zero_drift' | 'regen_limit' | 'invalid_bus';

export interface MotorParams {
  polePairs: number;               // p (pole pairs)
  kePrime: number;                 // Ke' [V_peak / (rad/s_mech)]
  rLL25Ohm: number;                // Line-to-line resistance at 25°C [Ω]
  tCoilC: number;                  // Copper winding temperature [°C]
  lLLmH: number;                   // Line-to-line inductance [mH]
  n0Rpm: number;                   // Reference no-load speed [RPM]
  betaSat: number;                 // Magnetic saturation coeff beta [1/A²]
  p0A: number;                     // Core + windage loss linear coeff a [W/RPM]
  p0B: number;                     // Core + windage loss quadratic coeff b [W/RPM²]
  rsEffOverrideOhm: number | null; // Optional bounded calibrated Rs_eff [Ω]

  // Inverter & harness stage parameters
  iIdleA: number;                  // No-load inverter quiescent current [A]
  etaInv: number;                  // Inverter stage efficiency (0..1)
  iDeadbandA: number;              // Zero-drift deadband for |I_net| [A]
  rLineOhm: number;                // Battery + harness line resistance [Ω]

  // Voltage-drop & switching parameters for Vq_cmd estimation & 6-MOS handoff
  rdsOnMOhm: number;               // Effective MOSFET Rds(on) at operating Tj [mΩ]
  tDeadNs: number;                 // Dead time [ns]
  fSwKhz: number;                  // Switching frequency [kHz]
  vSdV: number;                    // Body diode forward drop [V]
}

export interface EngineeringAlerts {
  lowSpeed: boolean;               // |n| < 0.08 * n0
  cmdSat: boolean;                 // m_cmd > 1.1547
  motorSat: boolean;               // m_motor > 1.1547
  lowFreqThermal: boolean;         // f_e < 3 Hz
  regenLimit: boolean;             // Delta < 0
  zeroDrift: boolean;              // |I_net| < iDeadbandA
  invalidBus: boolean;             // V_meas - I_bus * R_line <= 0.1 V
  iqSignAmbiguous: boolean;        // Multiple quadratic roots (regen) or symmetric ±Iq at stall (Eq=0)
}

export interface SinglePointResult {
  vMeasV: number;
  iBusA: number;
  nRpm: number;
  omegaM: number;
  omegaE: number;
  feHz: number;
  vBusCapV: number;
  rsOhm: number;
  lqH: number;
  eqV: number;
  iNetA: number;
  pElecW: number;
  p0W: number;
  pCuW: number;
  pInW: number;
  pOutW: number;
  etaEst: number;
  delta: number;
  iqA: number;
  iphRmsA: number;
  kSat: number;
  ktNmPerA: number;
  tEstNm: number;
  vqMotorV: number;
  vqCmdV: number;
  vdV: number;
  vPhPeakMotorV: number;
  vPhPeakCmdV: number;
  mMotor: number;
  mNormMotor: number;
  mCmd: number;
  mNormCmd: number;
  phiDeg: number;
  phiCmdDeg: number;
  mode: OperatingMode;
  alerts: EngineeringAlerts;
}

export interface ForwardVerifyResult {
  iqA: number;
  nRpm: number;
  vMeasV: number;
  iBusEstA: number;
  vBusCapV: number;
  pElecW: number;
  pInW: number;
  pOutW: number;
  tEstNm: number;
  etaEst: number;
  vqMotorV: number;
  vqCmdV: number;
  vdV: number;
  mMotor: number;
  mNormMotor: number;
  mCmd: number;
  mNormCmd: number;
  phiDeg: number;
  phiCmdDeg: number;
  alerts: EngineeringAlerts;
}

// A centered moving-average window clipped at a recording/segment edge has at
// most half of the requested width available. Less than 50% support is not a
// defensible time-window mean and is excluded from electrical estimation.
const MIN_RUNTIME_LOG_FILTER_COVERAGE_RATIO = 0.5;

export interface RuntimeLogRow {
  timeS: number;
  vMeasV: number;
  iBusRawA: number;
  iBusFilteredA: number;
  nRpm: number;
  result: SinglePointResult;
  /** True when time-domain filter output at this row is valid (false for gap-isolated singletons). */
  filterValid?: boolean;
  filterQuality?: 'VALID' | 'LOW_COVERAGE' | 'ISOLATED' | 'INVALID';
  /** True when a sampling gap precedes, isolates, or invalidates this sample. */
  gapBoundary?: boolean;
}

export interface MovingAverageFilterDiagnostics {
  values: number[];
  gapCount: number;
  gapIndices: number[];
  segmentCount: number;
  segments: Array<{ startIdx: number; endIdx: number }>;
  medianDtSec: number;
  gapThresholdSec: number;
  isolatedIndices: number[];
  lowCoverageIndices: number[];
}

export interface RuntimeLogProcessAudit {
  rows: RuntimeLogRow[];
  filterDiagnostics: MovingAverageFilterDiagnostics;
}

export const SVPWM_LINEAR_LIMIT = 2 / Math.sqrt(3); // 1.1547005383792517

export function calcOmegaM(nRpm: number): number {
  return (2 * Math.PI * nRpm) / 60;
}

export function calcOmegaE(nRpm: number, polePairs: number): number {
  return polePairs * calcOmegaM(nRpm);
}

export function calcFeHz(nRpm: number, polePairs: number): number {
  return (polePairs * Math.abs(nRpm)) / 60;
}

export function calcRsAnchorOhm(rLL25Ohm: number, tCoilC: number): number {
  return (rLL25Ohm / 2) * (1 + 0.00393 * (tCoilC - 25));
}

export function getEffectiveRsOhm(params: MotorParams): number {
  if (params.rsEffOverrideOhm !== null && Number.isFinite(params.rsEffOverrideOhm) && params.rsEffOverrideOhm > 0) {
    return params.rsEffOverrideOhm;
  }
  return calcRsAnchorOhm(params.rLL25Ohm, params.tCoilC);
}

export function calcLqH(lLLmH: number): number {
  return (lLLmH * 1e-3) / 2;
}

export function calcKeFromNoLoad(vTestV: number, n0Rpm: number): number {
  if (n0Rpm <= 0) return 0;
  const omegaM0 = calcOmegaM(n0Rpm);
  return (vTestV / Math.sqrt(3)) / omegaM0;
}

export function calcKeFromKv(kvRpmPerV: number): number {
  if (kvRpmPerV <= 0) return 0;
  return 60 / (2 * Math.PI * Math.sqrt(3) * kvRpmPerV);
}

export function calcKvFromKe(kePrime: number): number {
  if (kePrime <= 0) return 0;
  return 60 / (2 * Math.PI * Math.sqrt(3) * kePrime);
}

export function calcKsat(iqA: number, betaSat: number): number {
  if (!Number.isFinite(iqA)) return 1;
  return 1 / (1 + Math.max(0, betaSat) * iqA * iqA);
}

export function calcP0LossW(nRpm: number, p0A: number, p0B: number): number {
  const nAbs = Math.abs(nRpm);
  if (nAbs <= 0) return 0;
  return Math.max(0, p0A * nAbs + p0B * nAbs * nAbs);
}

export function calcVqCmd(
  vqMotorV: number,
  iqA: number,
  vBusCapV: number,
  params: MotorParams
): number {
  if (!Number.isFinite(iqA)) return Number.NaN;
  const rdsOhm = Math.max(0, params.rdsOnMOhm) * 1e-3;
  const tDeadS = Math.max(0, params.tDeadNs) * 1e-9;
  const fSwHz = Math.max(0, params.fSwKhz) * 1e3;
  const signIq = Math.abs(iqA) < 1e-9 ? 0 : iqA > 0 ? 1 : -1;
  const deadDrop = signIq * (4 / Math.PI) * tDeadS * fSwHz * Math.max(0, vBusCapV + params.vSdV);
  return vqMotorV + rdsOhm * iqA + deadDrop;
}

export function calcPhiDeg(vqV: number, vdV: number, iqA: number): number {
  if (!Number.isFinite(vqV) || !Number.isFinite(vdV) || !Number.isFinite(iqA)) {
    return Number.NaN;
  }
  const thetaV = Math.atan2(vqV, vdV);
  const thetaI = iqA >= 0 ? Math.PI / 2 : -Math.PI / 2;
  let diff = (thetaV - thetaI + Math.PI) % (2 * Math.PI);
  if (diff < 0) diff += 2 * Math.PI;
  diff -= Math.PI;
  if (diff <= -Math.PI + 1e-12) diff = Math.PI;
  return (diff * 180) / Math.PI;
}

export function solveSinglePoint(
  vMeasV: number,
  iBusA: number,
  nRpm: number,
  params: MotorParams
): SinglePointResult {
  const omegaM = calcOmegaM(nRpm);
  const omegaE = calcOmegaE(nRpm, params.polePairs);
  const feHz = calcFeHz(nRpm, params.polePairs);
  const rsOhm = getEffectiveRsOhm(params);
  const lqH = calcLqH(params.lLLmH);

  const rLineOhm = Math.max(0, params.rLineOhm);
  const vBusCapRaw = vMeasV - iBusA * rLineOhm;
  const invalidBus = !Number.isFinite(vBusCapRaw) || vBusCapRaw <= 0.1;
  const vBusCapV = invalidBus ? Number.NaN : vBusCapRaw;

  const eq0 = params.kePrime * omegaM;
  let eqV = eq0;
  const p0W = calcP0LossW(nRpm, params.p0A, params.p0B);
  const pInW = vMeasV * iBusA;
  const iNetA = iBusA - params.iIdleA;
  const etaInv = Math.min(0.999, Math.max(0.1, params.etaInv));
  const deadband = Math.max(0, params.iDeadbandA);

  let mode: OperatingMode = 'motoring';
  let pElecW = 0;

  if (invalidBus) {
    mode = 'invalid_bus';
    pElecW = Number.NaN;
  } else if (Math.abs(iNetA) < deadband) {
    mode = 'zero_drift';
    pElecW = 0;
  } else if (iNetA >= 0) {
    mode = 'motoring';
    pElecW = etaInv * vBusCapV * iNetA;
  } else {
    mode = 'regen';
    pElecW = (vBusCapV * iNetA) / etaInv;
  }

  let delta = invalidBus ? Number.NaN : eq0 * eq0 + (8 / 3) * rsOhm * pElecW;

  let iqA = Number.NaN;
  let iphRmsA = Number.NaN;
  let kSat = 1;
  let ktNmPerA = 1.5 * params.kePrime;
  let tEstNm = Number.NaN;
  let pCuW = Number.NaN;
  let pOutW = Number.NaN;
  let etaEst = Number.NaN;
  let vqMotorV = Number.NaN;
  let vqCmdV = Number.NaN;
  let vdV = Number.NaN;
  let vPhPeakMotorV = Number.NaN;
  let vPhPeakCmdV = Number.NaN;
  let mMotor = Number.NaN;
  let mNormMotor = Number.NaN;
  let mCmd = Number.NaN;
  let mNormCmd = Number.NaN;
  let phiDeg = Number.NaN;
  let phiCmdDeg = Number.NaN;

  if (mode === 'invalid_bus') {
    // Keep outputs NaN so collapsed bus is never masked
  } else if (mode === 'zero_drift') {
    iqA = 0;
    iphRmsA = 0;
    kSat = 1;
    ktNmPerA = 1.5 * params.kePrime;
    pCuW = 0;
    if (Math.abs(nRpm) > 1e-6 && Math.abs(omegaM) > 1e-6) {
      // Spinning coast-down at Iq = 0: shaft absorbs speed-dependent iron+windage loss -P0
      // maintaining exact power balance P_elec = 0 = P_cu(0) + P0 + P_out and parity with forwardVerifyPoint(0, n)
      tEstNm = -p0W / omegaM;
      pOutW = -p0W;
    } else {
      tEstNm = 0;
      pOutW = 0;
    }
    etaEst = 0;
    vqMotorV = eq0;
    vqCmdV = eq0;
    vdV = 0;
    vPhPeakMotorV = Math.abs(eq0);
    vPhPeakCmdV = Math.abs(eq0);
    mMotor = vPhPeakMotorV / (vBusCapV / 2);
    mNormMotor = (Math.sqrt(3) * vPhPeakMotorV) / vBusCapV;
    mCmd = mMotor;
    mNormCmd = mNormMotor;
    phiDeg = 0;
    phiCmdDeg = 0;
  } else if (delta < 0) {
    mode = 'regen_limit';
  } else {
    if (Math.abs(eq0) < 1e-12) {
      iqA = pElecW >= 0 ? Math.sqrt((2 * pElecW) / (3 * rsOhm)) : -Math.sqrt((-2 * pElecW) / (3 * rsOhm));
      kSat = calcKsat(iqA, params.betaSat);
      eqV = 0;
    } else {
      const signEq = eq0 >= 0 ? 1 : -1;
      const beta = Math.max(0, params.betaSat);
      iqA = (-eq0 + signEq * Math.sqrt(delta)) / (2 * rsOhm);

      if (beta > 0 && Number.isFinite(iqA)) {
        let hitRegenLimit = false;
        for (let iter = 0; iter < 30; iter++) {
          const iqSq = iqA * iqA;
          const denom = 1 + beta * iqSq;
          const ks = 1 / denom;
          const eqCur = eq0 * ks;
          const residual = 1.5 * (eqCur * iqA + rsOhm * iqSq) - pElecW;
          if (Math.abs(residual) <= 1e-11 * (1 + Math.abs(pElecW))) {
            eqV = eqCur;
            delta = Math.max(0, eqCur * eqCur + (8 / 3) * rsOhm * pElecW);
            break;
          }

          const dEqTerm = (eq0 * (1 - beta * iqSq)) / (denom * denom);
          const df = 1.5 * (dEqTerm + 2 * rsOhm * iqA);
          const dIter = eqCur * eqCur + (8 / 3) * rsOhm * pElecW;

          let nextIq = Number.NaN;
          if (Math.abs(df) > 1e-9 && Number.isFinite(df)) {
            const cand = iqA - residual / df;
            const candSq = cand * cand;
            const candRes = 1.5 * ((eq0 / (1 + beta * candSq)) * cand + rsOhm * candSq) - pElecW;
            if (Number.isFinite(candRes) && Math.abs(candRes) < Math.abs(residual)) {
              nextIq = cand;
            }
          }
          if (!Number.isFinite(nextIq)) {
            if (dIter < 0) {
              delta = dIter;
              hitRegenLimit = true;
              break;
            }
            const fp = (-eqCur + signEq * Math.sqrt(dIter)) / (2 * rsOhm);
            nextIq = 0.5 * iqA + 0.5 * fp;
          }
          iqA = nextIq;
        }

        const ksFinal = calcKsat(iqA, beta);
        eqV = eq0 * ksFinal;
        const dFinal = eqV * eqV + (8 / 3) * rsOhm * pElecW;
        const finalRes = 1.5 * (eqV * iqA + rsOhm * iqA * iqA) - pElecW;
        if (hitRegenLimit || dFinal < -1e-9 || !Number.isFinite(iqA) || Math.abs(finalRes) > 1e-3 * (1 + Math.abs(pElecW))) {
          mode = 'regen_limit';
          iqA = Number.NaN;
          if (dFinal < delta) delta = dFinal;
        } else {
          delta = Math.max(0, dFinal);
        }
      }
    }

    if (mode !== 'regen_limit' && Number.isFinite(iqA)) {
      iphRmsA = Math.abs(iqA) / Math.SQRT2;
      kSat = calcKsat(iqA, params.betaSat);
      eqV = eq0 * kSat;
      ktNmPerA = 1.5 * params.kePrime * kSat;
      pCuW = 1.5 * rsOhm * iqA * iqA;

      if (Math.abs(nRpm) > 1e-6 && Math.abs(omegaM) > 1e-6) {
        tEstNm = ktNmPerA * iqA - p0W / omegaM;
        pOutW = tEstNm * omegaM;
      } else {
        tEstNm = ktNmPerA * iqA;
        pOutW = 0;
      }

      if (pInW > 1e-6 && pOutW >= 0) {
        etaEst = pOutW / pInW;
      } else if (pInW < -1e-6 && pOutW < -1e-6) {
        etaEst = Math.abs(pInW / pOutW);
      } else {
        etaEst = 0;
      }

      vqMotorV = eqV + rsOhm * iqA;
      vqCmdV = calcVqCmd(vqMotorV, iqA, vBusCapV, params);
      vdV = -omegaE * lqH * iqA;

      vPhPeakMotorV = Math.hypot(vdV, vqMotorV);
      vPhPeakCmdV = Math.hypot(vdV, vqCmdV);

      mMotor = vPhPeakMotorV / (vBusCapV / 2);
      mNormMotor = (Math.sqrt(3) * vPhPeakMotorV) / vBusCapV;
      mCmd = vPhPeakCmdV / (vBusCapV / 2);
      mNormCmd = (Math.sqrt(3) * vPhPeakCmdV) / vBusCapV;

      phiDeg = calcPhiDeg(vqMotorV, vdV, iqA);
      phiCmdDeg = calcPhiDeg(vqCmdV, vdV, iqA);
    }
  }

  const iqSignAmbiguous =
    mode !== 'invalid_bus' &&
    mode !== 'regen_limit' &&
    mode !== 'zero_drift' &&
    Number.isFinite(iqA) &&
    ((mode === 'regen' && pElecW < -1e-12 && delta > 1e-12) ||
      (Math.abs(eq0) < 1e-12 && Math.abs(iqA) > 1e-9));

  const alerts: EngineeringAlerts = {
    lowSpeed: Math.abs(nRpm) < 0.08 * params.n0Rpm,
    cmdSat: Number.isFinite(mCmd) && mCmd > SVPWM_LINEAR_LIMIT,
    motorSat: Number.isFinite(mMotor) && mMotor > SVPWM_LINEAR_LIMIT,
    lowFreqThermal: feHz < 3.0,
    regenLimit: mode === 'regen_limit',
    zeroDrift: mode === 'zero_drift',
    invalidBus: mode === 'invalid_bus',
    iqSignAmbiguous,
  };

  return {
    vMeasV,
    iBusA,
    nRpm,
    omegaM,
    omegaE,
    feHz,
    vBusCapV,
    rsOhm,
    lqH,
    eqV,
    iNetA,
    pElecW,
    p0W,
    pCuW,
    pInW,
    pOutW,
    etaEst,
    delta,
    iqA,
    iphRmsA,
    kSat,
    ktNmPerA,
    tEstNm,
    vqMotorV,
    vqCmdV,
    vdV,
    vPhPeakMotorV,
    vPhPeakCmdV,
    mMotor,
    mNormMotor,
    mCmd,
    mNormCmd,
    phiDeg,
    phiCmdDeg,
    mode,
    alerts,
  };
}

export function forwardVerifyPoint(
  iqA: number,
  nRpm: number,
  vMeasV: number,
  params: MotorParams
): ForwardVerifyResult {
  const omegaM = calcOmegaM(nRpm);
  const omegaE = calcOmegaE(nRpm, params.polePairs);
  const feHz = calcFeHz(nRpm, params.polePairs);
  const rsOhm = getEffectiveRsOhm(params);
  const lqH = calcLqH(params.lLLmH);

  const kSat = calcKsat(iqA, params.betaSat);
  const eqV = params.kePrime * omegaM * kSat;
  const pElecW = 1.5 * (eqV * iqA + rsOhm * iqA * iqA);
  const etaInv = Math.min(0.999, Math.max(0.1, params.etaInv));

  const pDcBus = pElecW >= 0 ? pElecW / etaInv : pElecW * etaInv;
  const rLine = Math.max(0, params.rLineOhm);

  let iBusEstA = Number.NaN;
  let lineCollapse = false;

  if (rLine < 1e-9) {
    if (vMeasV <= 0.1) {
      lineCollapse = true;
    } else {
      iBusEstA = params.iIdleA + pDcBus / vMeasV;
    }
  } else {
    const bCoef = -(vMeasV + rLine * params.iIdleA);
    const cCoef = vMeasV * params.iIdleA + pDcBus;
    const disc = bCoef * bCoef - 4 * rLine * cCoef;
    if (disc < 0 || !Number.isFinite(disc)) {
      lineCollapse = true;
    } else {
      iBusEstA = (-bCoef - Math.sqrt(disc)) / (2 * rLine);
    }
  }

  const vBusCapRaw = lineCollapse ? Number.NaN : vMeasV - iBusEstA * rLine;
  const invalidBus = lineCollapse || !Number.isFinite(vBusCapRaw) || vBusCapRaw <= 0.1;
  const vBusCapV = invalidBus ? Number.NaN : vBusCapRaw;

  const p0W = calcP0LossW(nRpm, params.p0A, params.p0B);
  const tEstNm =
    Math.abs(nRpm) > 1e-6 && Math.abs(omegaM) > 1e-6
      ? 1.5 * params.kePrime * kSat * iqA - p0W / omegaM
      : 1.5 * params.kePrime * kSat * iqA;

  const pInW = invalidBus ? Number.NaN : vMeasV * iBusEstA;
  const pOutW = Math.abs(nRpm) > 1e-6 ? tEstNm * omegaM : 0;
  const etaEst =
    !Number.isFinite(pInW)
      ? Number.NaN
      : pInW > 1e-6 && pOutW >= 0
      ? pOutW / pInW
      : pInW < -1e-6 && pOutW < -1e-6
      ? Math.abs(pInW / pOutW)
      : 0;

  const vqMotorV = eqV + rsOhm * iqA;
  const vqCmdV = invalidBus ? Number.NaN : calcVqCmd(vqMotorV, iqA, vBusCapV, params);
  const vdV = -omegaE * lqH * iqA;

  const vPhPeakMotorV = Math.hypot(vdV, vqMotorV);
  const vPhPeakCmdV = invalidBus ? Number.NaN : Math.hypot(vdV, vqCmdV);

  const mMotor = invalidBus ? Number.NaN : vPhPeakMotorV / (vBusCapV / 2);
  const mNormMotor = invalidBus ? Number.NaN : (Math.sqrt(3) * vPhPeakMotorV) / vBusCapV;
  const mCmd = invalidBus ? Number.NaN : vPhPeakCmdV / (vBusCapV / 2);
  const mNormCmd = invalidBus ? Number.NaN : (Math.sqrt(3) * vPhPeakCmdV) / vBusCapV;

  const phiDeg = calcPhiDeg(vqMotorV, vdV, iqA);
  const phiCmdDeg = invalidBus ? Number.NaN : calcPhiDeg(vqCmdV, vdV, iqA);
  const iNet = iBusEstA - params.iIdleA;

  const alerts: EngineeringAlerts = {
    lowSpeed: Math.abs(nRpm) < 0.08 * params.n0Rpm,
    cmdSat: Number.isFinite(mCmd) && mCmd > SVPWM_LINEAR_LIMIT,
    motorSat: Number.isFinite(mMotor) && mMotor > SVPWM_LINEAR_LIMIT,
    lowFreqThermal: feHz < 3.0,
    regenLimit: false,
    zeroDrift: Math.abs(iNet) < params.iDeadbandA,
    invalidBus,
    iqSignAmbiguous: false,
  };

  return {
    iqA,
    nRpm,
    vMeasV,
    iBusEstA,
    vBusCapV,
    pElecW,
    pInW,
    pOutW,
    tEstNm,
    etaEst,
    vqMotorV,
    vqCmdV,
    vdV,
    mMotor,
    mNormMotor,
    mCmd,
    mNormCmd,
    phiDeg,
    phiCmdDeg,
    alerts,
  };
}

export function isMonotonicTimestamps(timesS: number[]): boolean {
  if (timesS.length < 2) return true;
  for (let i = 1; i < timesS.length; i++) {
    if (!Number.isFinite(timesS[i]) || !Number.isFinite(timesS[i - 1]) || timesS[i] <= timesS[i - 1]) {
      return false;
    }
  }
  return timesS[timesS.length - 1] > timesS[0];
}

export function partitionContinuousTimeSegments(
  timesS: number[],
  gapFactor: number = DEFAULT_SAMPLING_GAP_FACTOR
): {
  segments: Array<{ startIdx: number; endIdx: number }>;
  gapIndices: number[];
  medianDtSec: number;
  gapThresholdSec: number;
} {
  const n = timesS.length;
  if (n === 0) {
    return { segments: [], gapIndices: [], medianDtSec: 0, gapThresholdSec: Infinity };
  }
  if (n === 1) {
    return { segments: [{ startIdx: 0, endIdx: 0 }], gapIndices: [], medianDtSec: 0, gapThresholdSec: Infinity };
  }
  const posDts: number[] = [];
  for (let i = 1; i < n; i++) {
    const dt = timesS[i] - timesS[i - 1];
    if (Number.isFinite(dt) && dt > 0) posDts.push(dt);
  }
  posDts.sort((a, b) => a - b);
  const medianDtSec =
    posDts.length > 0
      ? posDts.length % 2 === 1
        ? posDts[Math.floor(posDts.length / 2)]
        : 0.5 * (posDts[posDts.length / 2 - 1] + posDts[posDts.length / 2])
      : 0;
  const gapThresholdSec = medianDtSec > 0 ? Math.max(1e-12, gapFactor * medianDtSec) : Infinity;

  const segments: Array<{ startIdx: number; endIdx: number }> = [];
  const gapIndices: number[] = [];
  let segStart = 0;
  for (let i = 1; i < n; i++) {
    const dt = timesS[i] - timesS[i - 1];
    if (dt > gapThresholdSec) {
      segments.push({ startIdx: segStart, endIdx: i - 1 });
      gapIndices.push(i);
      segStart = i;
    }
  }
  segments.push({ startIdx: segStart, endIdx: n - 1 });

  return { segments, gapIndices, medianDtSec, gapThresholdSec };
}

export function movingAverageFilterWithDiagnostics(
  values: number[],
  timesS: number[],
  windowMs: number,
  options?: { gapFactor?: number }
): MovingAverageFilterDiagnostics {
  const n = values.length;
  if (timesS.length > 0 && timesS.length !== n) {
    throw new Error(`Runtime Log 时间轴与电流数组长度不一致：t=${timesS.length}, values=${n}。`);
  }
  if (timesS.length > 0 && !isMonotonicTimestamps(timesS)) {
    throw new Error('Runtime Log 时间戳必须有限且严格递增；拒绝退回按样本序号滤波。');
  }
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error('Runtime Log 电流数据包含 NaN/Inf；拒绝通过滤波忽略无效样本。');
  }

  if (n === 0 || windowMs <= 0) {
    const segInfo =
      timesS.length === n
        ? partitionContinuousTimeSegments(timesS, options?.gapFactor ?? DEFAULT_SAMPLING_GAP_FACTOR)
        : { segments: n > 0 ? [{ startIdx: 0, endIdx: n - 1 }] : [], gapIndices: [], medianDtSec: 0, gapThresholdSec: Infinity };
    return {
      values: [...values],
      gapCount: segInfo.gapIndices.length,
      gapIndices: segInfo.gapIndices,
      segmentCount: segInfo.segments.length,
      segments: segInfo.segments,
      medianDtSec: segInfo.medianDtSec,
      gapThresholdSec: segInfo.gapThresholdSec,
      isolatedIndices: [],
      lowCoverageIndices: [],
    };
  }

  const gapFactor = options?.gapFactor ?? DEFAULT_SAMPLING_GAP_FACTOR;
  const windowS = windowMs * 1e-3;
  const halfWinS = windowS * 0.5;
  const out = new Array<number>(n);

  if (timesS.length === n) {
    // Segmented centered time-window [t - W/2, t + W/2] clipped to continuous segments (reset across sampling gaps).
    const { segments, gapIndices, medianDtSec, gapThresholdSec } = partitionContinuousTimeSegments(timesS, gapFactor);
    const isolatedIndices: number[] = [];
    const lowCoverageIndices: number[] = [];

    for (const seg of segments) {
      const s0 = seg.startIdx;
      const s1 = seg.endIdx;
      if (s0 === s1) {
        // Singleton point: if isolated by a sampling gap within a multi-sample capture (n >= 2),
        // there is zero continuous neighbor span across the filter window -> mark NaN (invalid).
        if (n >= 2) {
          out[s0] = Number.NaN;
          isolatedIndices.push(s0);
        } else {
          out[s0] = values[s0];
        }
        continue;
      }

      const segLen = s1 - s0 + 1;
      const trapPrefix = new Float64Array(segLen);
      for (let k = 1; k < segLen; k++) {
        const dt = timesS[s0 + k] - timesS[s0 + k - 1];
        trapPrefix[k] = trapPrefix[k - 1] + 0.5 * (values[s0 + k - 1] + values[s0 + k]) * dt;
      }

      // Reset sliding window pointers cleanly at each segment boundary
      let left = s0;
      let right = s0;
      for (let i = s0; i <= s1; i++) {
        const ti = timesS[i];
        while (left < i && ti - timesS[left] > halfWinS + 1e-12) {
          left++;
        }
        if (right < i) right = i;
        while (right + 1 <= s1 && timesS[right + 1] - ti <= halfWinS + 1e-12) {
          right++;
        }

        const span = timesS[right] - timesS[left];
        if (span > 1e-12) {
          out[i] = (trapPrefix[right - s0] - trapPrefix[left - s0]) / span;
          if (span + 1e-12 < MIN_RUNTIME_LOG_FILTER_COVERAGE_RATIO * windowS && (left === s0 || right === s1)) {
            lowCoverageIndices.push(i);
          }
        } else {
          // There is no measurable time support inside the requested window.
          // Keep the point only for diagnostics, but mark it LOW_COVERAGE so
          // downstream estimation cannot treat a raw singleton as a valid mean.
          out[i] = values[i];
          lowCoverageIndices.push(i);
        }
      }
    }

    return {
      values: out,
      gapCount: gapIndices.length,
      gapIndices,
      segmentCount: segments.length,
      segments,
      medianDtSec,
      gapThresholdSec,
      isolatedIndices,
      lowCoverageIndices,
    };
  }

  // Missing timestamps array (timesS.length === 0): fixed step count window fallback
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + values[i];
  const medianDt = 0.002;
  const winSamples = Math.max(1, Math.round(windowS / medianDt));
  if (winSamples <= 1) {
    return {
      values: [...values],
      gapCount: 0,
      gapIndices: [],
      segmentCount: 1,
      segments: [{ startIdx: 0, endIdx: n - 1 }],
      medianDtSec: medianDt,
      gapThresholdSec: Infinity,
      isolatedIndices: [],
      lowCoverageIndices: [],
    };
  }
  const half = Math.floor(winSamples / 2);
  for (let i = 0; i < n; i++) {
    const start = Math.max(0, i - half);
    const end = Math.min(n - 1, i + half);
    out[i] = (prefix[end + 1] - prefix[start]) / (end - start + 1);
  }
  return {
    values: out,
    gapCount: 0,
    gapIndices: [],
    segmentCount: 1,
    segments: [{ startIdx: 0, endIdx: n - 1 }],
    medianDtSec: medianDt,
    gapThresholdSec: Infinity,
    isolatedIndices: [],
    lowCoverageIndices: [],
  };
}

export function movingAverageFilter(
  values: number[],
  timesS: number[],
  windowMs: number
): number[] {
  return movingAverageFilterWithDiagnostics(values, timesS, windowMs).values;
}

export function processRuntimeLogWithAudit(
  rawRows: Array<{ timeS: number; vMeasV: number; iBusA: number; nRpm: number }>,
  filterWindowMs: number,
  params: MotorParams
): RuntimeLogProcessAudit {
  if (rawRows.length === 0) {
    return {
      rows: [],
      filterDiagnostics: {
        values: [],
        gapCount: 0,
        gapIndices: [],
        segmentCount: 0,
        segments: [],
        medianDtSec: 0,
        gapThresholdSec: Infinity,
        isolatedIndices: [],
        lowCoverageIndices: [],
      },
    };
  }
  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (![row.timeS, row.vMeasV, row.iBusA, row.nRpm].every(Number.isFinite)) {
      throw new Error(`Runtime Log 第 ${i + 1} 行包含 NaN/Inf，拒绝生成动态估算结果。`);
    }
    if (i > 0 && row.timeS <= rawRows[i - 1].timeS) {
      throw new Error(`Runtime Log 时间戳在第 ${i + 1} 行重复或倒退；拒绝按样本序号回退滤波。`);
    }
  }
  const times = rawRows.map((r) => r.timeS);
  const rawIbus = rawRows.map((r) => r.iBusA);
  const filterDiagnostics = movingAverageFilterWithDiagnostics(rawIbus, times, filterWindowMs);
  const gapSet = new Set(filterDiagnostics.gapIndices);
  const isoSet = new Set(filterDiagnostics.isolatedIndices);
  const lowCoverageSet = new Set(filterDiagnostics.lowCoverageIndices);

  const rows: RuntimeLogRow[] = rawRows.map((row, idx) => {
    const iBusFilteredA = filterDiagnostics.values[idx];
    const isIsolated = isoSet.has(idx);
    const isLowCoverage = lowCoverageSet.has(idx);
    const filterValid = Number.isFinite(iBusFilteredA) && !isIsolated && !isLowCoverage;
    const filterQuality: RuntimeLogRow['filterQuality'] = !Number.isFinite(iBusFilteredA)
      ? 'INVALID'
      : isIsolated
        ? 'ISOLATED'
        : isLowCoverage
          ? 'LOW_COVERAGE'
          : 'VALID';
    const result = solveSinglePoint(row.vMeasV, filterValid ? iBusFilteredA : Number.NaN, row.nRpm, params);
    return {
      timeS: row.timeS,
      vMeasV: row.vMeasV,
      iBusRawA: row.iBusA,
      iBusFilteredA: filterValid ? iBusFilteredA : Number.NaN,
      nRpm: row.nRpm,
      result,
      filterValid,
      filterQuality,
      gapBoundary: gapSet.has(idx) || isIsolated || isLowCoverage,
    };
  });

  return { rows, filterDiagnostics };
}

export function processRuntimeLog(
  rawRows: Array<{ timeS: number; vMeasV: number; iBusA: number; nRpm: number }>,
  filterWindowMs: number,
  params: MotorParams
): RuntimeLogRow[] {
  return processRuntimeLogWithAudit(rawRows, filterWindowMs, params).rows;
}
