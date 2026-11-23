/**
 * FOC DynoLab V2 - Core BLDC/FOC Physics Engine (SI Units, Amplitude-Invariant Clarke/Park)
 *
 * Conventions (strictly verified against Waveform Viewer Pro's 6-MOS focThermal engine):
 * - Phase resistance at coil temperature: Rs(T_coil) = (R_LL_25 / 2) * (1 + 0.00393 * (T_coil - 25))
 * - Phase inductance: Lq = (L_LL_mH * 1e-3) / 2 [H]
 * - Amplitude-invariant Clarke/Park:
 *     Kt(Iq) = 1.5 * Ke' * K_sat(Iq), K_sat(Iq) = 1 / (1 + beta * Iq^2)
 *     P_elec = 1.5 * (Eq * Iq + Rs * Iq^2), Eq = Ke' * omega_m
 *     I_ph_RMS = |Iq| / sqrt(2), P_cu = 1.5 * Rs * Iq^2 = 3 * Rs * I_ph_RMS^2
 * - SVPWM Linear Modulation Limit: 2 / sqrt(3) ≈ 1.154700538
 *     m = V_ph_peak / (V_bus_cap / 2), m_norm = m / (2 / sqrt(3)) = sqrt(3) * V_ph_peak / V_bus_cap
 * - 4-Quadrant Power Factor Angle phi_deg = wrap(-180..+180](theta_V - theta_I)
 *     Matches focThermal reconstructSensorlessDutySample(theta_V = theta_I + pfAngleDeg).
 */

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

export interface RuntimeLogRow {
  timeS: number;
  vMeasV: number;
  iBusRawA: number;
  iBusFilteredA: number;
  nRpm: number;
  result: SinglePointResult;
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

  const vBusCapRaw = vMeasV - iBusA * params.rLineOhm;
  const invalidBus = !Number.isFinite(vBusCapRaw) || vBusCapRaw <= 0.1;
  const vBusCapV = invalidBus ? Number.NaN : vBusCapRaw;

  const eqV = params.kePrime * omegaM;
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

  const delta = invalidBus ? Number.NaN : eqV * eqV + (8 / 3) * rsOhm * pElecW;

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
    tEstNm = Math.abs(nRpm) > 1e-6 && Math.abs(omegaM) > 1e-6 ? -p0W / omegaM : 0;
    pOutW = Math.abs(nRpm) > 1e-6 ? -p0W : 0;
    etaEst = 0;
    vqMotorV = eqV;
    vqCmdV = eqV;
    vdV = 0;
    vPhPeakMotorV = Math.abs(eqV);
    vPhPeakCmdV = Math.abs(eqV);
    mMotor = vPhPeakMotorV / (vBusCapV / 2);
    mNormMotor = (Math.sqrt(3) * vPhPeakMotorV) / vBusCapV;
    mCmd = mMotor;
    mNormCmd = mNormMotor;
    phiDeg = 0;
    phiCmdDeg = 0;
  } else if (delta < 0) {
    mode = 'regen_limit';
  } else {
    if (Math.abs(eqV) < 1e-12) {
      iqA = pElecW >= 0 ? Math.sqrt((2 * pElecW) / (3 * rsOhm)) : -Math.sqrt((-2 * pElecW) / (3 * rsOhm));
    } else {
      const signEq = eqV >= 0 ? 1 : -1;
      iqA = (-eqV + signEq * Math.sqrt(delta)) / (2 * rsOhm);
    }

    iphRmsA = Math.abs(iqA) / Math.SQRT2;
    kSat = calcKsat(iqA, params.betaSat);
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
    } else if (pInW < -1e-6 && pOutW < 0) {
      etaEst = pInW / pOutW;
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

  const alerts: EngineeringAlerts = {
    lowSpeed: Math.abs(nRpm) < 0.08 * params.n0Rpm,
    cmdSat: Number.isFinite(mCmd) && mCmd > SVPWM_LINEAR_LIMIT,
    motorSat: Number.isFinite(mMotor) && mMotor > SVPWM_LINEAR_LIMIT,
    lowFreqThermal: feHz < 3.0,
    regenLimit: mode === 'regen_limit',
    zeroDrift: mode === 'zero_drift',
    invalidBus: mode === 'invalid_bus',
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

  const eqV = params.kePrime * omegaM;
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

  const kSat = calcKsat(iqA, params.betaSat);
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
      : pInW < -1e-6 && pOutW < 0
      ? pInW / pOutW
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

export function movingAverageFilter(
  values: number[],
  timesS: number[],
  windowMs: number
): number[] {
  if (values.length === 0 || windowMs <= 0) return [...values];
  let avgDt = 0.001;
  if (timesS.length >= 2) {
    const span = timesS[timesS.length - 1] - timesS[0];
    if (span > 0) {
      avgDt = span / (timesS.length - 1);
    }
  }
  const winSamples = Math.max(1, Math.round((windowMs * 1e-3) / avgDt));
  if (winSamples <= 1) return [...values];

  const half = Math.floor(winSamples / 2);
  const out = new Array<number>(values.length);
  const prefix = new Float64Array(values.length + 1);
  const validPrefix = new Int32Array(values.length + 1);

  for (let i = 0; i < values.length; i++) {
    const finite = Number.isFinite(values[i]);
    prefix[i + 1] = prefix[i] + (finite ? values[i] : 0);
    validPrefix[i + 1] = validPrefix[i] + (finite ? 1 : 0);
  }

  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - half);
    const end = Math.min(values.length - 1, i + half);
    const cnt = validPrefix[end + 1] - validPrefix[start];
    out[i] = cnt > 0 ? (prefix[end + 1] - prefix[start]) / cnt : Number.NaN;
  }
  return out;
}

export function processRuntimeLog(
  rawRows: Array<{ timeS: number; vMeasV: number; iBusA: number; nRpm: number }>,
  filterWindowMs: number,
  params: MotorParams
): RuntimeLogRow[] {
  if (rawRows.length === 0) return [];
  const times = rawRows.map((r) => r.timeS);
  const rawIbus = rawRows.map((r) => r.iBusA);
  const filteredIbus = movingAverageFilter(rawIbus, times, filterWindowMs);

  return rawRows.map((row, idx) => {
    const iBusFilteredA = filteredIbus[idx];
    const result = solveSinglePoint(row.vMeasV, iBusFilteredA, row.nRpm, params);
    return {
      timeS: row.timeS,
      vMeasV: row.vMeasV,
      iBusRawA: row.iBusA,
      iBusFilteredA,
      nRpm: row.nRpm,
      result,
    };
  });
}
