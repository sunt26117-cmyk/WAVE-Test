/**
 * Standalone Dynamic PMSM dq-Axis Transient ODE Simulator (FD-03)
 *
 * Strictly decoupled from the steady-state SPMSM dyno calibrator (dynoCalibrator.ts / solveSinglePoint).
 * Models transient electrical & mechanical dynamics in amplitude-invariant Clarke/Park coordinates:
 *   di_d/dt = (v_d - Rs * i_d + omega_e * Lq * i_q) / Ld
 *   di_q/dt = (v_q - Rs * i_q - omega_e * (Ld * i_d + psi_f)) / Lq
 *   Te      = 1.5 * p * (psi_f * i_q + (Ld - Lq) * i_d * i_q)
 *   domega_m/dt = (Te - B * omega_m - T_load - T_coulomb * tanh(omega_m / 0.5)) / J
 *   dtheta_e/dt = p * omega_m
 *
 * Provenance: EVERY output is explicitly labeled 'synthetic_assumed_uncalibrated' and must never be
 * mixed into steady-state calibration metrics or presented as measured oscilloscope waveforms.
 */

import { TabState, WaveformChannel } from '../../types/models';
import { analyzeSamplingQuality } from '../qualityCheck';

export type PmsmFluxMapProvenance = 'fea_extracted' | 'measured' | 'user_import' | 'assumed';

/** Rectangular nonlinear flux-linkage map. Matrices are indexed [idAxisIndex][iqAxisIndex]. */
export interface PmsmFluxMap {
  idAxisA: number[];
  iqAxisA: number[];
  psiDVs: number[][];
  psiQVs: number[][];
  provenance: PmsmFluxMapProvenance;
  manufacturer?: string;
  partNumber?: string;
  referenceTemperatureC?: number;
  sourceNote?: string;
}

export interface PmsmFluxMapImportDocument {
  schema: 'wave-test-pmsm-flux-map';
  schemaVersion: 1;
  units: { current: 'A'; fluxLinkage: 'Vs' };
  provenance: PmsmFluxMapProvenance;
  manufacturer?: string;
  partNumber?: string;
  referenceTemperatureC?: number;
  sourceNote?: string;
  idAxisA: number[];
  iqAxisA: number[];
  psiDVs: number[][];
  psiQVs: number[][];
}

export interface PmsmFluxEvaluation {
  psiDVs: number;
  psiQVs: number;
  lddH: number;
  ldqH: number;
  lqdH: number;
  lqqH: number;
}

function validateStrictAxis(axis: number[], label: string): void {
  if (!Array.isArray(axis) || axis.length < 2 || axis.some((v) => !Number.isFinite(v))) {
    throw new Error(`${label} 至少需要 2 个有限数值。`);
  }
  for (let i = 1; i < axis.length; i++) if (!(axis[i] > axis[i - 1])) {
    throw new Error(`${label} 必须严格递增且不能重复。`);
  }
}

export function validatePmsmFluxMap(map: PmsmFluxMap): void {
  validateStrictAxis(map.idAxisA, 'PMSM flux-map Id 轴');
  validateStrictAxis(map.iqAxisA, 'PMSM flux-map Iq 轴');
  if (map.idAxisA[0] > 0 || map.idAxisA[map.idAxisA.length - 1] < 0 || map.iqAxisA[0] > 0 || map.iqAxisA[map.iqAxisA.length - 1] < 0) throw new Error('PMSM 磁链 Map 的 Id/Iq 轴都必须包含 0A 工作点。');
  const ni = map.idAxisA.length;
  const nq = map.iqAxisA.length;
  for (const [name, matrix] of [['psiDVs', map.psiDVs], ['psiQVs', map.psiQVs]] as const) {
    if (!Array.isArray(matrix) || matrix.length !== ni || matrix.some((row) => !Array.isArray(row) || row.length !== nq || row.some((v) => !Number.isFinite(v)))) {
      throw new Error(`${name} 必须为 ${ni}×${nq} 的有限数值矩阵，行索引对应 Id，列索引对应 Iq。`);
    }
  }
  // Check the local differential-inductance matrix at every cell center. A passive
  // reciprocal magnetic map must have positive incremental energy curvature.
  for (let i = 0; i < ni - 1; i++) {
    for (let j = 0; j < nq - 1; j++) {
      const did = map.idAxisA[i + 1] - map.idAxisA[i];
      const diq = map.iqAxisA[j + 1] - map.iqAxisA[j];
      const ldd = 0.5 * ((map.psiDVs[i + 1][j] - map.psiDVs[i][j]) + (map.psiDVs[i + 1][j + 1] - map.psiDVs[i][j + 1])) / did;
      const ldq = 0.5 * ((map.psiDVs[i][j + 1] - map.psiDVs[i][j]) + (map.psiDVs[i + 1][j + 1] - map.psiDVs[i + 1][j])) / diq;
      const lqd = 0.5 * ((map.psiQVs[i + 1][j] - map.psiQVs[i][j]) + (map.psiQVs[i + 1][j + 1] - map.psiQVs[i][j + 1])) / did;
      const lqq = 0.5 * ((map.psiQVs[i][j + 1] - map.psiQVs[i][j]) + (map.psiQVs[i + 1][j + 1] - map.psiQVs[i + 1][j])) / diq;
      const scale = Math.max(1e-9, Math.abs(ldd), Math.abs(ldq), Math.abs(lqd), Math.abs(lqq));
      if (!(ldd > 1e-9 * scale) || !(lqq > 1e-9 * scale) || !(ldd * lqq - ldq * lqd > 1e-12 * scale * scale)) {
        throw new Error(`PMSM flux-map 在 Id=${map.idAxisA[i]}~${map.idAxisA[i + 1]}A、Iq=${map.iqAxisA[j]}~${map.iqAxisA[j + 1]}A 区域的增量电感矩阵不是正定矩阵。`);
      }
      if (Math.abs(ldq - lqd) > 0.35 * scale) {
        throw new Error(`PMSM flux-map 在局部网格的交叉微分电感不互易 (L_dq=${ldq.toExponential(2)}, L_qd=${lqd.toExponential(2)})；请检查单位、网格方向或数据噪声。`);
      }
    }
  }
  if (map.referenceTemperatureC === undefined || !Number.isFinite(map.referenceTemperatureC)) {
    throw new Error('PMSM flux-map 必须提供有限 referenceTemperatureC，禁止对未知温度数据进行无依据应用。');
  }
  if (!['fea_extracted', 'measured', 'user_import', 'assumed'].includes(map.provenance)) {
    throw new Error('PMSM flux-map provenance 必须为 fea_extracted/measured/user_import/assumed。');
  }
}

export function parsePmsmFluxMapJson(text: string): PmsmFluxMap {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (err) {
    throw new Error(`PMSM 磁链 Map JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== 'object') throw new Error('PMSM 磁链 Map 必须为 JSON 对象。');
  const doc = raw as Partial<PmsmFluxMapImportDocument>;
  if (doc.schema !== 'wave-test-pmsm-flux-map' || doc.schemaVersion !== 1 || doc.units?.current !== 'A' || doc.units?.fluxLinkage !== 'Vs') {
    throw new Error('PMSM 磁链 Map 文件格式不匹配：需要 wave-test-pmsm-flux-map v1，电流单位 A、磁链单位 Vs。');
  }
  const map: PmsmFluxMap = {
    idAxisA: doc.idAxisA || [], iqAxisA: doc.iqAxisA || [],
    psiDVs: doc.psiDVs || [], psiQVs: doc.psiQVs || [],
    provenance: doc.provenance || 'user_import',
    manufacturer: doc.manufacturer, partNumber: doc.partNumber,
    referenceTemperatureC: doc.referenceTemperatureC, sourceNote: doc.sourceNote,
  };
  validatePmsmFluxMap(map);
  return map;
}

export function createPmsmFluxMapImportTemplate(): PmsmFluxMapImportDocument {
  return {
    schema: 'wave-test-pmsm-flux-map', schemaVersion: 1,
    units: { current: 'A', fluxLinkage: 'Vs' }, provenance: 'fea_extracted',
    manufacturer: '', partNumber: '', referenceTemperatureC: 25,
    idAxisA: [-20, 0, 20], iqAxisA: [-20, 0, 20],
    psiDVs: [[0.006, 0.006, 0.006], [0.010, 0.010, 0.010], [0.014, 0.014, 0.014]],
    psiQVs: [[-0.020, 0, 0.020], [-0.020, 0, 0.020], [-0.020, 0, 0.020]],
    sourceNote: 'Replace template values with measured or FEA-extracted flux linkage data. Template values are illustrative only.',
  };
}

function findAxisBracket(axis: number[], value: number, label: string): { lo: number; hi: number; f: number } {
  if (value < axis[0] - 1e-9 || value > axis[axis.length - 1] + 1e-9) {
    throw new Error(`${label}=${value.toFixed(4)}A 超出磁链 Map 范围 [${axis[0]}, ${axis[axis.length - 1]}]A；禁止边界保持或无依据外推。`);
  }
  const x = Math.max(axis[0], Math.min(axis[axis.length - 1], value));
  let hi = 1;
  while (hi < axis.length - 1 && axis[hi] < x) hi++;
  const lo = hi - 1;
  return { lo, hi, f: (x - axis[lo]) / (axis[hi] - axis[lo]) };
}

export function evaluatePmsmFluxMap(map: PmsmFluxMap, idA: number, iqA: number): PmsmFluxEvaluation {
  if (!Number.isFinite(idA) || !Number.isFinite(iqA)) throw new Error('PMSM flux-map 查询电流必须为有限值。');
  const bi = findAxisBracket(map.idAxisA, idA, 'Id');
  const bq = findAxisBracket(map.iqAxisA, iqA, 'Iq');
  const dx = map.idAxisA[bi.hi] - map.idAxisA[bi.lo];
  const dy = map.iqAxisA[bq.hi] - map.iqAxisA[bq.lo];
  const interp = (m: number[][]) => {
    const v00 = m[bi.lo][bq.lo], v10 = m[bi.hi][bq.lo];
    const v01 = m[bi.lo][bq.hi], v11 = m[bi.hi][bq.hi];
    const f = (1 - bi.f) * (1 - bq.f) * v00 + bi.f * (1 - bq.f) * v10 + (1 - bi.f) * bq.f * v01 + bi.f * bq.f * v11;
    const dId = ((1 - bq.f) * (v10 - v00) + bq.f * (v11 - v01)) / dx;
    const dIq = ((1 - bi.f) * (v01 - v00) + bi.f * (v11 - v10)) / dy;
    return { value: f, dId, dIq };
  };
  const d = interp(map.psiDVs);
  const q = interp(map.psiQVs);
  const det = d.dId * q.dIq - d.dIq * q.dId;
  if (!(d.dId > 0) || !(q.dIq > 0) || !(det > 0) || ![d.value, q.value, d.dId, d.dIq, q.dId, q.dIq].every(Number.isFinite)) {
    throw new Error('PMSM flux-map 查询位置的增量电感矩阵非正定或含非法值，已阻止动态积分。');
  }
  return { psiDVs: d.value, psiQVs: q.value, lddH: d.dId, ldqH: d.dIq, lqdH: q.dId, lqqH: q.dIq };
}

export type DynamicControlMode = 'mtpa_current_loop' | 'id_zero' | 'open_loop_vdq';
export type DynamicQuadrantMode = 'motoring' | 'regen' | 'standstill';

export interface DynamicPmsmParams {
  polePairs: number;
  rsOhm: number;
  ldH: number;
  lqH: number;
  /** Permanent magnet flux linkage psi_f [V·s] (= Ke' / p in amplitude-invariant convention). */
  psiFVs: number;
  jKgM2: number;
  bNmSPerRad: number;
  tCoulombNm: number;
  vBusV: number;
  iMaxA: number;
  controlMode: DynamicControlMode;
  /** Optional current-loop bandwidth [rad/s] (default 2*pi*250). */
  currentBandwidthRadS?: number;
  /** Optional speed-loop PI gains (used when step specifies speedRefRpm). */
  kpSpeed?: number;
  kiSpeed?: number;
  /** Optional nonlinear flux-linkage map ψd(Id,Iq), ψq(Id,Iq), in V·s. */
  fluxMap?: PmsmFluxMap;
  /** Static operating temperatures; no transient thermal feedback is implied. */
  windingTempC?: number;
  magnetTempC?: number;
  referenceTempC?: number;
  rsTempCoeffPerC?: number;
  psiTempCoeffPerC?: number;
}

export interface DynamicScenarioStep {
  tStartSec: number;
  tEndSec: number;
  tLoadNm: number;
  /** Closed-loop speed target [RPM] (used in mtpa_current_loop / id_zero if iqRefA is omitted). */
  speedRefRpm?: number;
  /** Direct current magnitude/torque-producing reference [A] (overrides speed loop if finite). */
  iqRefA?: number;
  /** Open-loop dq voltage command [V] (used when controlMode === 'open_loop_vdq'). */
  vdRefV?: number;
  vqRefV?: number;
  /** Optional step override for bus voltage [V]. */
  vBusV?: number;
}

export interface DynamicPmsmConfig {
  durationSec: number;
  /** Output sampling interval [s] (internal RK4 micro-step auto-refines below L/R). */
  dtOutSec: number;
  initialSpeedRpm?: number;
  initialIdA?: number;
  initialIqA?: number;
  initialThetaERad?: number;
  scenario: DynamicScenarioStep[];
}

export interface DynamicSteadyCheck {
  finalSpeedRpm: number;
  finalIdA: number;
  finalIqA: number;
  analyticalTeNm: number;
  analyticalVdV: number;
  analyticalVqV: number;
  simTeNm: number;
  simVdV: number;
  simVqV: number;
  torqueDiffNm: number;
  voltageDiffV: number;
  diDtNormAps: number;
  dOmegaDtNormRadS2: number;
}

export interface DynamicPmsmResult {
  provenance: 'synthetic_assumed_uncalibrated';
  sourceModel: 'dynamic_pmsm_dq_rk4' | 'dynamic_pmsm_dq_rk4_flux_map';
  warnings: string[];
  dtInternalSec: number;
  substepsPerOutput: number;
  time: Float64Array;
  thetaE: Float64Array;
  omegaM: Float64Array;
  nRpm: Float64Array;
  idA: Float64Array;
  iqA: Float64Array;
  vdV: Float64Array;
  vqV: Float64Array;
  psiDVs: Float64Array;
  psiQVs: Float64Array;
  pElecW: Float64Array;
  pCopperW: Float64Array;
  pMechW: Float64Array;
  pLoadW: Float64Array;
  pFrictionW: Float64Array;
  /** Rate of stored magnetic energy change derived from incremental flux-linkage dynamics. */
  pMagneticStoredRateW: Float64Array;
  /** Rate of stored rotor kinetic energy change J·ω·dω/dt. */
  pMechanicalStoredRateW: Float64Array;
  /** P_elec - P_copper - P_mech - dW_magnetic/dt; should approach numerical zero. */
  pElectricalBalanceResidualW: Float64Array;
  /** P_mech - P_load - P_friction - dW_kinetic/dt; should approach numerical zero. */
  pMechanicalBalanceResidualW: Float64Array;
  iaA: Float64Array;
  ibA: Float64Array;
  icA: Float64Array;
  teNm: Float64Array;
  tLoadNm: Float64Array;
  vBusV: Float64Array;
  mNorm: Float64Array;
  voltageLimited: Uint8Array;
  currentLimited: Uint8Array;
  quadrantMode: DynamicQuadrantMode[];
  peakAbsCurrentA: number;
  peakAbsTorqueNm: number;
  peakSpeedRpm: number;
  minSpeedRpm: number;
  voltageLimitHits: number;
  currentLimitHits: number;
  steadyCheck: DynamicSteadyCheck;
  fluxMapProvenance: PmsmFluxMapProvenance | 'linear_parameter_model';
  fluxMapOutOfRangeCount: number;
}

export interface DynamicCommandTarget {
  tLoadNm: number;
  vBusV: number;
  speedRefRpm?: number;
  iqRefA?: number;
  vdRefV: number;
  vqRefV: number;
}

/** Convert amplitude-invariant Ke' [Vp/(rad/s_mech)] to magnet flux linkage psi_f [V·s]. */
export function kePrimeToPsiF(kePrime: number, polePairs: number): number {
  return kePrime / Math.max(1, polePairs);
}

/** Evaluate linear or imported nonlinear dq flux linkage in the amplitude-invariant convention. */
export function evaluateDynamicPmsmFlux(
  idA: number,
  iqA: number,
  psiFVs: number,
  ldH: number,
  lqH: number,
  fluxMap?: PmsmFluxMap,
  psiScale = 1
): PmsmFluxEvaluation {
  if (fluxMap) {
    const mapped = evaluatePmsmFluxMap(fluxMap, idA, iqA);
    return {
      ...mapped,
      psiDVs: mapped.psiDVs * psiScale,
      psiQVs: mapped.psiQVs * psiScale,
      lddH: mapped.lddH * psiScale,
      ldqH: mapped.ldqH * psiScale,
      lqdH: mapped.lqdH * psiScale,
      lqqH: mapped.lqqH * psiScale,
    };
  }
  return {
    psiDVs: psiFVs + ldH * idA,
    psiQVs: lqH * iqA,
    lddH: ldH, ldqH: 0, lqdH: 0, lqqH: lqH,
  };
}

/** Electromagnetic torque from co-energy: Te = 1.5*p*(psi_d*iq - psi_q*id). */
export function calcDynamicPmsmTorque(
  idA: number,
  iqA: number,
  polePairs: number,
  psiFVs: number,
  ldH: number,
  lqH: number,
  fluxMap?: PmsmFluxMap
): number {
  const flux = evaluateDynamicPmsmFlux(idA, iqA, psiFVs, ldH, lqH, fluxMap);
  return 1.5 * polePairs * (flux.psiDVs * iqA - flux.psiQVs * idA);
}

/**
 * Map-aware MTPA/field-weakening target search. The incoming command is an Iq-equivalent
 * torque-producing current request for backward compatibility; its torque is preserved
 * while the solver searches Id/Iq inside the current circle and voltage ellipse.
 */
function computeFluxMapCurrentTarget(
  iTorqueCmdA: number,
  omegaERadS: number,
  vBusV: number,
  params: DynamicPmsmParams
): { idRefA: number; iqRefA: number; currentLimited: boolean; fieldWeakeningActive: boolean } {
  const iMax = Math.max(0.05, params.iMaxA);
  const sign = iTorqueCmdA >= 0 ? 1 : -1;
  const requestedIq = Math.min(Math.abs(iTorqueCmdA), iMax) * sign;
  if (params.controlMode === 'id_zero') {
    return {
      idRefA: 0,
      iqRefA: requestedIq,
      currentLimited: Math.abs(iTorqueCmdA) > iMax + 1e-9,
      fieldWeakeningActive: false,
    };
  }
  const psiScale = 1; // Flux-map temperature compensation requires a temperature-indexed map; do not scale Ld/Lq derivatives as if they were PM flux only.
  const targetTorque = calcDynamicPmsmTorque(0, requestedIq, params.polePairs, params.psiFVs, params.ldH, params.lqH, params.fluxMap);
  const rs = params.rsOhm * (1 + (params.rsTempCoeffPerC ?? 0.00393) * ((params.windingTempC ?? params.referenceTempC ?? 25) - (params.referenceTempC ?? 25)));
  const vMax = Math.max(0.5, vBusV) / Math.sqrt(3) * 0.96;
  const absTarget = Math.abs(targetTorque);
  let best: { id: number; iq: number; current2: number; torqueError: number; voltage: number } | null = null;
  // Spell the type out: `typeof best` captures the *narrowed* type (null) right
  // after the initialiser, which makes the assignment below a type error.
  let closest: { id: number; iq: number; current2: number; torqueError: number; voltage: number } | null = null;
  const idSamples = 48;
  for (let k = 0; k <= idSamples; k++) {
    const id = -iMax + (2 * iMax * k) / idSamples;
    const iqMax = Math.sqrt(Math.max(0, iMax * iMax - id * id));
    if (iqMax < 1e-10) continue;
    let lo = 0;
    let hi = iqMax;
    let iq = sign * iqMax;
    const torqueAtMax = calcDynamicPmsmTorque(id, iq, params.polePairs, params.psiFVs, params.ldH, params.lqH, params.fluxMap);
    if (Math.abs(torqueAtMax) >= absTarget) {
      for (let it = 0; it < 34; it++) {
        const mid = 0.5 * (lo + hi);
        const tq = calcDynamicPmsmTorque(id, sign * mid, params.polePairs, params.psiFVs, params.ldH, params.lqH, params.fluxMap);
        if (Math.abs(tq) < absTarget) lo = mid; else hi = mid;
      }
      iq = sign * 0.5 * (lo + hi);
    }
    const torque = calcDynamicPmsmTorque(id, iq, params.polePairs, params.psiFVs, params.ldH, params.lqH, params.fluxMap);
    const flux = evaluateDynamicPmsmFlux(id, iq, params.psiFVs, params.ldH, params.lqH, params.fluxMap, psiScale);
    const vd = rs * id - omegaERadS * flux.psiQVs;
    const vq = rs * iq + omegaERadS * flux.psiDVs;
    const vMag = Math.hypot(vd, vq);
    const candidate = { id, iq, current2: id * id + iq * iq, torqueError: Math.abs(torque - targetTorque), voltage: vMag };
    if (!closest || candidate.torqueError + Math.max(0, candidate.voltage - vMax) * 0.1 < closest.torqueError + Math.max(0, closest.voltage - vMax) * 0.1) closest = candidate;
    if (vMag <= vMax && (!best || candidate.torqueError < best.torqueError - 1e-6 || (Math.abs(candidate.torqueError - best.torqueError) <= 1e-6 && candidate.current2 < best.current2))) best = candidate;
  }
  const chosen = best || closest;
  if (!chosen) return { idRefA: 0, iqRefA: 0, currentLimited: true, fieldWeakeningActive: true };
  return {
    idRefA: chosen.id,
    iqRefA: chosen.iq,
    currentLimited: Math.abs(iTorqueCmdA) > iMax + 1e-9 || chosen.torqueError > Math.max(1e-3, absTarget * 0.02),
    fieldWeakeningActive: Math.abs(omegaERadS) > 1 && chosen.id < -0.05,
  };
}

/**
 * Compute analytical MTPA (id*, iq*) for IPM (Ld != Lq) or SPMSM (Ld == Lq -> id*=0),
 * plus current-circle clamp (<= Imax) and high-speed field-weakening inside Vmax = Vbus/sqrt(3).
 */
export function computeMtpaAndFieldWeakeningTarget(
  iTorqueCmdA: number,
  omegaERadS: number,
  vBusV: number,
  params: DynamicPmsmParams
): { idRefA: number; iqRefA: number; currentLimited: boolean; fieldWeakeningActive: boolean } {
  if (params.fluxMap) return computeFluxMapCurrentTarget(iTorqueCmdA, omegaERadS, vBusV, params);
  const iMax = Math.max(0.05, params.iMaxA);
  const absCmd = Math.abs(iTorqueCmdA);
  const currentLimited = absCmd > iMax + 1e-9;
  const iMag = Math.min(absCmd, iMax);
  const signQ = iTorqueCmdA >= 0 ? 1 : -1;

  let idRef = 0;
  let iqRef = signQ * iMag;

  if (params.controlMode === 'mtpa_current_loop') {
    const dL = params.ldH - params.lqH;
    if (Math.abs(dL) > 1e-9 && iMag > 1e-9) {
      // Exact rationalized MTPA root minimizing |I| for given Te (negative id when Ld < Lq)
      const psi = Math.max(1e-6, params.psiFVs);
      const disc = psi * psi + 8 * dL * dL * iMag * iMag;
      idRef = (2 * dL * iMag * iMag) / (psi + Math.sqrt(disc));
      // Clamp |idRef| <= 0.95*iMag safety
      const idBound = iMag * 0.95;
      if (Math.abs(idRef) > idBound) idRef = Math.sign(idRef) * idBound;
      iqRef = signQ * Math.sqrt(Math.max(0, iMag * iMag - idRef * idRef));
    }
  }

  // Voltage-ellipse check for field weakening (SVPWM linear limit Vmax = Vbus / sqrt(3)),
  // including stator resistive drop Rs*(id, iq) and signed electrical speed omegaE.
  const vMaxEff = (Math.max(0.5, vBusV) / Math.sqrt(3)) * 0.96;
  const rsEff = Math.max(
    0,
    params.rsOhm *
      (1 +
        (params.rsTempCoeffPerC ?? 0.00393) *
          ((params.windingTempC ?? params.referenceTempC ?? 25) - (params.referenceTempC ?? 25)))
  );
  const absWe = Math.abs(omegaERadS);
  let fieldWeakeningActive = false;
  if (absWe > 1.0 && params.controlMode === 'mtpa_current_loop') {
    const vdReq = rsEff * idRef - omegaERadS * params.lqH * iqRef;
    const vqReq = rsEff * iqRef + omegaERadS * (params.ldH * idRef + params.psiFVs);
    const vReq = Math.hypot(vdReq, vqReq);
    if (vReq > vMaxEff) {
      fieldWeakeningActive = true;
      // Solve exact resistive voltage ellipse A*x^2 + 2*Bs*x + C <= 0 for x = |iq| >= 0
      // with iq = signQ * x along id in [-iMax, idRef].
      const loInit = -iMax;
      const hiInit = idRef;
      const absIqTarget = Math.abs(iqRef);
      const aQuad = rsEff * rsEff + omegaERadS * omegaERadS * params.lqH * params.lqH;
      let exactId: number | null = null;
      let exactI2 = Infinity;
      let bestId = loInit;
      let bestIqAbs = 0;
      const samples = 40;
      for (let k = 0; k <= samples; k++) {
        const idCand = loInit + ((hiInit - loInit) * k) / samples;
        const iqCapCur = Math.sqrt(Math.max(0, iMax * iMax - idCand * idCand));
        const a0 = rsEff * idCand;
        const b0 = omegaERadS * (params.ldH * idCand + params.psiFVs);
        const bQuad = signQ * rsEff * omegaERadS * ((params.ldH - params.lqH) * idCand + params.psiFVs);
        const cQuad = a0 * a0 + b0 * b0 - vMaxEff * vMaxEff;
        const disc = bQuad * bQuad - aQuad * cQuad;
        if (disc < 0) continue;
        const sqrtDisc = Math.sqrt(disc);
        const xLo = Math.max(0, (-bQuad - sqrtDisc) / aQuad);
        const xHi = Math.min(iqCapCur, (-bQuad + sqrtDisc) / aQuad);
        if (xHi < xLo - 1e-12) continue;
        if (absIqTarget >= xLo - 1e-12 && absIqTarget <= xHi + 1e-12) {
          const candI2 = idCand * idCand + absIqTarget * absIqTarget;
          if (candI2 < exactI2) {
            exactI2 = candI2;
            exactId = idCand;
          }
        }
        const iqFeas = Math.min(absIqTarget, xHi);
        if (iqFeas >= xLo - 1e-12 && xHi > bestIqAbs) {
          bestIqAbs = xHi;
          bestId = idCand;
        }
      }
      if (exactId !== null) {
        idRef = exactId;
        iqRef = signQ * absIqTarget;
      } else {
        idRef = bestId;
        iqRef = signQ * Math.min(absIqTarget, bestIqAbs);
      }
    }
  }

  return { idRefA: idRef, iqRefA: iqRef, currentLimited, fieldWeakeningActive };
}

function sampleScenarioAt(tSec: number, params: DynamicPmsmParams, scenario: DynamicScenarioStep[]): DynamicCommandTarget {
  if (scenario.length === 0) {
    return { tLoadNm: 0, vBusV: params.vBusV, iqRefA: 0, vdRefV: 0, vqRefV: 0 };
  }
  // In a gap, hold the preceding command. Before the first segment, use the first command.
  let chosen = scenario[0];
  for (const step of scenario) {
    if (tSec >= step.tStartSec - 1e-12) chosen = step;
    if (tSec >= step.tStartSec - 1e-12 && tSec <= step.tEndSec + 1e-12) break;
  }
  return {
    tLoadNm: Number.isFinite(chosen.tLoadNm) ? chosen.tLoadNm : 0,
    vBusV: chosen.vBusV !== undefined && Number.isFinite(chosen.vBusV) && chosen.vBusV > 0.5 ? chosen.vBusV : params.vBusV,
    speedRefRpm: chosen.speedRefRpm,
    iqRefA: chosen.iqRefA,
    vdRefV: Number.isFinite(chosen.vdRefV) ? (chosen.vdRefV as number) : 0,
    vqRefV: Number.isFinite(chosen.vqRefV) ? (chosen.vqRefV as number) : 0,
  };
}

/**
 * Build standard presets demonstrating 4-quadrant dynamics, load steps, and IPM MTPA + field weakening.
 */
export function buildDynamicPresetScenario(
  preset: 'startup_load_step' | 'four_quadrant_regen' | 'ipm_mtpa_fw'
): { paramsPatch: Partial<DynamicPmsmParams>; config: DynamicPmsmConfig } {
  if (preset === 'four_quadrant_regen') {
    return {
      paramsPatch: { controlMode: 'mtpa_current_loop', iMaxA: 15, vBusV: 24 },
      config: {
        durationSec: 0.35,
        dtOutSec: 2e-4,
        initialSpeedRpm: 0,
        scenario: [
          { tStartSec: 0, tEndSec: 0.12, tLoadNm: 0.05, speedRefRpm: 1400 },
          { tStartSec: 0.12, tEndSec: 0.24, tLoadNm: 0.05, speedRefRpm: -900 },
          { tStartSec: 0.24, tEndSec: 0.35, tLoadNm: -0.08, speedRefRpm: -900 },
        ],
      },
    };
  }
  if (preset === 'ipm_mtpa_fw') {
    return {
      paramsPatch: {
        polePairs: 4,
        rsOhm: 0.045,
        ldH: 0.18e-3,
        lqH: 0.42e-3, // salient IPM: Lq > Ld -> MTPA yields id < 0
        psiFVs: 0.015,
        jKgM2: 6.5e-5,
        bNmSPerRad: 8e-5,
        tCoulombNm: 0.005,
        vBusV: 24,
        iMaxA: 18,
        controlMode: 'mtpa_current_loop',
      },
      config: {
        durationSec: 0.25,
        dtOutSec: 2e-4,
        initialSpeedRpm: 0,
        scenario: [
          { tStartSec: 0, tEndSec: 0.08, tLoadNm: 0.25, speedRefRpm: 1500 },
          { tStartSec: 0.08, tEndSec: 0.25, tLoadNm: 0.15, speedRefRpm: 4800 },
        ],
      },
    };
  }
  return {
    paramsPatch: { controlMode: 'mtpa_current_loop' },
    config: {
      durationSec: 0.3,
      dtOutSec: 2e-4,
      initialSpeedRpm: 0,
      scenario: [
        { tStartSec: 0, tEndSec: 0.12, tLoadNm: 0.02, speedRefRpm: 1000 },
        { tStartSec: 0.12, tEndSec: 0.22, tLoadNm: 0.16, speedRefRpm: 1000 },
        { tStartSec: 0.22, tEndSec: 0.3, tLoadNm: 0.05, speedRefRpm: 1300 },
      ],
    },
  };
}

export function simulateDynamicPmsm(
  rawParams: DynamicPmsmParams,
  rawConfig: DynamicPmsmConfig
): DynamicPmsmResult {
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const requirePositive = (name: string, value: unknown): number => {
    if (!finite(value) || value <= 0) throw new Error(`${name} 必须为有限正数。`);
    return value;
  };
  const requireNonNegative = (name: string, value: unknown): number => {
    if (!finite(value) || value < 0) throw new Error(`${name} 必须为有限非负数。`);
    return value;
  };

  if (!Number.isInteger(rawParams.polePairs) || rawParams.polePairs < 1) throw new Error('极对数 polePairs 必须为正整数。');
  const p = rawParams.polePairs;
  const rsBase = requirePositive('Rs', rawParams.rsOhm);
  const ld = requirePositive('Ld', rawParams.ldH);
  const lq = requirePositive('Lq', rawParams.lqH);
  const psiFBase = requirePositive('永磁体磁链 ψf', rawParams.psiFVs);
  const jRot = requirePositive('转动惯量 J', rawParams.jKgM2);
  const bVisc = requireNonNegative('粘性阻尼 B', rawParams.bNmSPerRad);
  const tCoul = requireNonNegative('库仑摩擦 T_coulomb', rawParams.tCoulombNm);
  const vBusDefault = requirePositive('母线电压 Vbus', rawParams.vBusV);
  const iMax = requirePositive('电流上限 Imax', rawParams.iMaxA);
  if (!['mtpa_current_loop', 'id_zero', 'open_loop_vdq'].includes(rawParams.controlMode)) throw new Error('未知 PMSM 控制模式。');

  const referenceTempC = rawParams.referenceTempC ?? 25;
  const windingTempC = rawParams.windingTempC ?? referenceTempC;
  const magnetTempC = rawParams.magnetTempC ?? (rawParams.fluxMap?.referenceTemperatureC ?? referenceTempC);
  if (![referenceTempC, windingTempC, magnetTempC].every(finite)) throw new Error('绕组、磁体及参考温度必须为有限值。');
  const rsAlpha = rawParams.rsTempCoeffPerC ?? 0.00393; // Copper winding default; keep parity with Python/UI defaults.
  const psiAlpha = rawParams.psiTempCoeffPerC ?? 0;
  requireNonNegative('Rs 温度系数', rsAlpha);
  if (!finite(psiAlpha)) throw new Error('磁链温度系数必须为有限值。');
  const rs = rsBase * (1 + rsAlpha * (windingTempC - referenceTempC));
  if (!(rs > 0) || !Number.isFinite(rs)) throw new Error('温度修正后的 Rs 非法或非正。');
  const psiF = psiFBase * (1 + psiAlpha * (magnetTempC - referenceTempC));
  if (!(psiF > 0) || !Number.isFinite(psiF)) throw new Error('温度修正后的永磁体磁链 ψf 非法或非正。');
  if (rawParams.fluxMap) {
    validatePmsmFluxMap(rawParams.fluxMap);
    const mapReferenceTemp = rawParams.fluxMap.referenceTemperatureC;
    if (mapReferenceTemp === undefined || !Number.isFinite(mapReferenceTemp)) throw new Error('非线性 PMSM 磁链 Map 必须提供 referenceTemperatureC，禁止将未知温度数据当作当前温度使用。');
    if (Math.abs(magnetTempC - mapReferenceTemp) > 1e-6) throw new Error(`当前磁体温度 ${magnetTempC}°C 与磁链 Map 参考温度 ${mapReferenceTemp}°C 不一致。当前 Map 未提供温度维度，禁止对非线性磁链曲线整体套用 ψf 温度系数。`);
    if (rawParams.fluxMap.idAxisA[0] > -iMax || rawParams.fluxMap.idAxisA[rawParams.fluxMap.idAxisA.length - 1] < iMax || rawParams.fluxMap.iqAxisA[0] > -iMax || rawParams.fluxMap.iqAxisA[rawParams.fluxMap.iqAxisA.length - 1] < iMax) throw new Error(`PMSM 磁链 Map 电流覆盖范围必须至少覆盖 ±Imax（当前 Imax=${iMax}A）；禁止控制器搜索到 Map 外部。`);
    if (rawParams.psiTempCoeffPerC !== undefined && rawParams.psiTempCoeffPerC !== 0) {
      throw new Error('使用非线性磁链 Map 时，不允许对整个 ψd/ψq Map 乘永磁体温度系数；请导入对应温度的磁链 Map。');
    }
  }

  const duration = requirePositive('仿真总时长', rawConfig.durationSec);
  const dtOut = requirePositive('输出采样间隔', rawConfig.dtOutSec);
  if (duration < 1e-3 || duration > 10) throw new Error('仿真总时长必须在 1 ms～10 s 范围内。');
  if (dtOut < 1e-5 || dtOut > 0.02) throw new Error('输出采样间隔必须在 10 µs～20 ms 范围内。');
  if (!Array.isArray(rawConfig.scenario)) throw new Error('动态工况 scenario 必须为数组。');
  const nOut = Math.floor(duration / dtOut) + 1;
  if (nOut < 2 || nOut > 4000) throw new Error(`输出采样点数 ${nOut} 超出允许范围 2～4000；请调整总时长或输出采样间隔。`);
  const effDtOut = duration / (nOut - 1);

  let previousEnd = -Infinity;
  for (let i = 0; i < rawConfig.scenario.length; i++) {
    const step = rawConfig.scenario[i];
    if (![step.tStartSec, step.tEndSec, step.tLoadNm].every(finite) || step.tStartSec < 0 || step.tEndSec <= step.tStartSec || step.tEndSec > duration + 1e-9) {
      throw new Error(`工况段 #${i + 1} 的起止时间或负载扭矩无效。`);
    }
    if (step.tStartSec < previousEnd - 1e-9) throw new Error(`工况段 #${i + 1} 与前一段重叠或顺序错误。`);
    for (const [name, value] of Object.entries({ speedRefRpm: step.speedRefRpm, iqRefA: step.iqRefA, vdRefV: step.vdRefV, vqRefV: step.vqRefV, vBusV: step.vBusV })) {
      if (value !== undefined && !finite(value)) throw new Error(`工况段 #${i + 1} 的 ${name} 不是有限数值。`);
    }
    if (step.vBusV !== undefined && step.vBusV <= 0) throw new Error(`工况段 #${i + 1} 的 Vbus 必须大于零。`);
    previousEnd = step.tEndSec;
  }
  const initialId = rawConfig.initialIdA ?? 0;
  const initialIq = rawConfig.initialIqA ?? 0;
  const initialSpeed = rawConfig.initialSpeedRpm ?? 0;
  const initialTheta = rawConfig.initialThetaERad ?? 0;
  if (![initialId, initialIq, initialSpeed, initialTheta].every(finite)) throw new Error('初始电流、转速和电角度必须为有限值。');

  const params: DynamicPmsmParams = {
    ...rawParams, polePairs: p, rsOhm: rs, ldH: ld, lqH: lq, psiFVs: psiF,
    jKgM2: jRot, bNmSPerRad: bVisc, tCoulombNm: tCoul,
    vBusV: vBusDefault, iMaxA: iMax,
    windingTempC, magnetTempC, referenceTempC,
    rsTempCoeffPerC: 0, // rsOhm is already temperature-corrected to windingTempC; prevent double scaling in sub-helpers.
    psiTempCoeffPerC: 0,
  };

  const tauElecMin = Math.min(ld, lq) / rs;
  const maxStepH = Math.min(2e-5, 0.05 * tauElecMin, effDtOut);
  const substeps = Math.max(1, Math.ceil(effDtOut / maxStepH));
  if (!Number.isSafeInteger(substeps) || substeps > 20000 || substeps * (nOut - 1) > 20_000_000) {
    throw new Error(`RK4 内部步数过大 (${substeps}/输出步)，超出 2,000 万总积分步预算；请降低仿真时长或放宽输出采样间隔。`);
  }
  const h = effDtOut / substeps;

  const bwI = rawParams.currentBandwidthRadS === undefined ? 2 * Math.PI * 300 : requirePositive('电流环带宽', rawParams.currentBandwidthRadS);
  const kpD = ld * bwI;
  const kiD = rs * bwI;
  const kpQ = lq * bwI;
  const kiQ = rs * bwI;
  const kt0 = 1.5 * p * psiF;
  const bwW = Math.min(bwI * 0.15, 120);
  const kpW = rawParams.kpSpeed === undefined ? (jRot * bwW) / Math.max(1e-4, kt0) : requireNonNegative('速度环 Kp', rawParams.kpSpeed);
  const kiW = rawParams.kiSpeed === undefined ? kpW * bwW * 0.25 : requireNonNegative('速度环 Ki', rawParams.kiSpeed);

  const warnings: string[] = [
    '此模块为合成假设动态模型 (synthetic_assumed_uncalibrated)，使用独立 dq 动态方程与 RK4 求解，不等同于实测示波器波形或已标定电机模型。',
  ];
  if (rawParams.fluxMap) warnings.push(`已启用非线性磁链 Map：${rawParams.fluxMap.provenance}${rawParams.fluxMap.partNumber ? ` / ${rawParams.fluxMap.partNumber}` : ''}；Map 参考温度 ${rawParams.fluxMap.referenceTemperatureC ?? '未指定'}°C。`);
  else warnings.push('当前使用线性参数磁链模型 ψd=ψf+Ld·Id、ψq=Lq·Iq。');
  if (windingTempC !== referenceTempC) warnings.push(`Rs 已按绕组温度 ${windingTempC}°C 和参考温度 ${referenceTempC}°C 进行静态温度修正；未模拟动态热反馈。`);

  const time = new Float64Array(nOut);
  const thetaEArr = new Float64Array(nOut);
  const omegaMArr = new Float64Array(nOut);
  const nRpmArr = new Float64Array(nOut);
  const idArr = new Float64Array(nOut);
  const iqArr = new Float64Array(nOut);
  const vdArr = new Float64Array(nOut);
  const vqArr = new Float64Array(nOut);
  const psiDArr = new Float64Array(nOut);
  const psiQArr = new Float64Array(nOut);
  const pElecArr = new Float64Array(nOut);
  const pCopperArr = new Float64Array(nOut);
  const pMechArr = new Float64Array(nOut);
  const pLoadArr = new Float64Array(nOut);
  const pFrictionArr = new Float64Array(nOut);
  const pMagneticStoredRateArr = new Float64Array(nOut);
  const pMechanicalStoredRateArr = new Float64Array(nOut);
  const pElectricalBalanceResidualArr = new Float64Array(nOut);
  const pMechanicalBalanceResidualArr = new Float64Array(nOut);
  const iaArr = new Float64Array(nOut);
  const ibArr = new Float64Array(nOut);
  const icArr = new Float64Array(nOut);
  const teArr = new Float64Array(nOut);
  const tLoadArr = new Float64Array(nOut);
  const vBusArr = new Float64Array(nOut);
  const mNormArr = new Float64Array(nOut);
  const voltLimArr = new Uint8Array(nOut);
  const currLimArr = new Uint8Array(nOut);
  const quadrantMode: DynamicQuadrantMode[] = [];

  let id = initialId;
  let iq = initialIq;
  let omegaM = (initialSpeed * 2 * Math.PI) / 60;
  let thetaE = initialTheta;
  let intId = 0;
  let intIq = 0;
  let intW = 0;

  const fluxAt = (idA: number, iqA: number) => evaluateDynamicPmsmFlux(idA, iqA, psiF, ld, lq, params.fluxMap);
  const torqueAt = (idA: number, iqA: number) => {
    const f = fluxAt(idA, iqA);
    return 1.5 * p * (f.psiDVs * iqA - f.psiQVs * idA);
  };

  const evalControl = (tSec: number, curId: number, curIq: number, curOmegaM: number) => {
    const cmd = sampleScenarioAt(tSec, params, rawConfig.scenario);
    const vMax = cmd.vBusV / Math.sqrt(3);
    const we = p * curOmegaM;
    const flux = fluxAt(curId, curIq);
    const kpDLocal = flux.lddH * bwI;
    const kpQLocal = flux.lqqH * bwI;
    const kpICurrent = rs * bwI;
    let vdCmd = cmd.vdRefV;
    let vqCmd = cmd.vqRefV;
    let iCurrLimited = false;
    if (params.controlMode !== 'open_loop_vdq') {
      let iTorqCmd = 0;
      if (cmd.iqRefA !== undefined) iTorqCmd = cmd.iqRefA;
      else {
        const wRef = ((cmd.speedRefRpm ?? 0) * 2 * Math.PI) / 60;
        const errW = wRef - curOmegaM;
        iTorqCmd = kpW * errW + intW;
      }
      const target = computeMtpaAndFieldWeakeningTarget(iTorqCmd, we, cmd.vBusV, params);
      iCurrLimited = target.currentLimited;
      const errD = target.idRefA - curId;
      const errQ = target.iqRefA - curIq;
      vdCmd = kpDLocal * errD + intId - we * flux.psiQVs;
      vqCmd = kpQLocal * errQ + intIq + we * flux.psiDVs;
    }
    const vMag = Math.hypot(vdCmd, vqCmd);
    const vLimited = vMag > vMax;
    const scale = vLimited && vMag > 1e-12 ? vMax / vMag : 1;
    return { cmd, vd: vdCmd * scale, vq: vqCmd * scale, vdCmd, vqCmd, vMax, vLimited, iCurrLimited };
  };

  const rhs = (curId: number, curIq: number, curOmegaM: number, vd: number, vq: number, tLoadNm: number) => {
    const we = p * curOmegaM;
    const flux = fluxAt(curId, curIq);
    const fD = vd - rs * curId + we * flux.psiQVs;
    const fQ = vq - rs * curIq - we * flux.psiDVs;
    const det = flux.lddH * flux.lqqH - flux.ldqH * flux.lqdH;
    if (!(det > 0) || !Number.isFinite(det)) throw new Error('PMSM 增量电感矩阵失去正定性，已终止 RK4 积分。');
    const dId = (fD * flux.lqqH - flux.ldqH * fQ) / det;
    const dIq = (flux.lddH * fQ - flux.lqdH * fD) / det;
    const te = 1.5 * p * (flux.psiDVs * curIq - flux.psiQVs * curId);
    const fricTorque = bVisc * curOmegaM + tCoul * Math.tanh(curOmegaM / 0.5);
    const dOmegaM = (te - fricTorque - tLoadNm) / jRot;
    return { dId, dIq, dOmegaM, dThetaE: we, te };
  };

  let peakAbsCurrentA = 0;
  let peakAbsTorqueNm = 0;
  let peakSpeedRpm = -Infinity;
  let minSpeedRpm = Infinity;
  let voltageLimitHits = 0;
  let currentLimitHits = 0;
  let lastVd = 0;
  let lastVq = 0;
  let lastTload = 0;

  for (let k = 0; k < nOut; k++) {
    const tCur = k * effDtOut;
    const ctrl = evalControl(tCur, id, iq, omegaM);
    const fluxNow = fluxAt(id, iq);
    const teNow = 1.5 * p * (fluxNow.psiDVs * iq - fluxNow.psiQVs * id);
    const nRpmNow = (omegaM * 60) / (2 * Math.PI);
    const cosT = Math.cos(thetaE), sinT = Math.sin(thetaE);
    const cosTm = Math.cos(thetaE - (2 * Math.PI) / 3), sinTm = Math.sin(thetaE - (2 * Math.PI) / 3);
    const ia = id * cosT - iq * sinT;
    const ib = id * cosTm - iq * sinTm;
    const ic = -(ia + ib);
    const vMag = Math.hypot(ctrl.vd, ctrl.vq);
    const mNorm = ctrl.vMax > 0 ? vMag / ctrl.vMax : 0;
    const pElec = 1.5 * (ctrl.vd * id + ctrl.vq * iq);
    const pCopper = 1.5 * rs * (id * id + iq * iq);
    const pMech = teNow * omegaM;
    const pLoad = ctrl.cmd.tLoadNm * omegaM;
    const pFriction = (bVisc * omegaM + tCoul * Math.tanh(omegaM / 0.5)) * omegaM;
    const rhsNow = rhs(id, iq, omegaM, ctrl.vd, ctrl.vq, ctrl.cmd.tLoadNm);
    const dPsiDdt = fluxNow.lddH * rhsNow.dId + fluxNow.ldqH * rhsNow.dIq;
    const dPsiQdt = fluxNow.lqdH * rhsNow.dId + fluxNow.lqqH * rhsNow.dIq;
    const pMagneticStoredRate = 1.5 * (id * dPsiDdt + iq * dPsiQdt);
    const pMechanicalStoredRate = jRot * omegaM * rhsNow.dOmegaM;
    const pElectricalBalanceResidual = pElec - pCopper - pMech - pMagneticStoredRate;
    const pMechanicalBalanceResidual = pMech - pLoad - pFriction - pMechanicalStoredRate;
    [pElec, pCopper, pMech, pLoad, pFriction, pMagneticStoredRate, pMechanicalStoredRate, pElectricalBalanceResidual, pMechanicalBalanceResidual, fluxNow.psiDVs, fluxNow.psiQVs].forEach((x) => {
      if (!Number.isFinite(x)) throw new Error(`动态 PMSM 在 t=${tCur.toFixed(6)}s 产生非有限物理结果，已终止计算。`);
    });

    time[k] = tCur; thetaEArr[k] = thetaE; omegaMArr[k] = omegaM; nRpmArr[k] = nRpmNow;
    idArr[k] = id; iqArr[k] = iq; vdArr[k] = ctrl.vd; vqArr[k] = ctrl.vq;
    psiDArr[k] = fluxNow.psiDVs; psiQArr[k] = fluxNow.psiQVs;
    pElecArr[k] = pElec; pCopperArr[k] = pCopper; pMechArr[k] = pMech; pLoadArr[k] = pLoad; pFrictionArr[k] = pFriction;
    pMagneticStoredRateArr[k] = pMagneticStoredRate; pMechanicalStoredRateArr[k] = pMechanicalStoredRate;
    pElectricalBalanceResidualArr[k] = pElectricalBalanceResidual; pMechanicalBalanceResidualArr[k] = pMechanicalBalanceResidual;
    iaArr[k] = ia; ibArr[k] = ib; icArr[k] = ic; teArr[k] = teNow;
    tLoadArr[k] = ctrl.cmd.tLoadNm; vBusArr[k] = ctrl.cmd.vBusV; mNormArr[k] = mNorm;
    voltLimArr[k] = ctrl.vLimited ? 1 : 0;
    const actualCurrentLimited = Math.hypot(id, iq) > iMax + 1e-6;
    currLimArr[k] = (ctrl.iCurrLimited || actualCurrentLimited) ? 1 : 0;

    const qMode: DynamicQuadrantMode = Math.abs(omegaM) < 0.05 && Math.abs(teNow) < 1e-3 ? 'standstill' : pMech < -1e-3 ? 'regen' : 'motoring';
    quadrantMode.push(qMode);
    peakAbsCurrentA = Math.max(peakAbsCurrentA, Math.hypot(id, iq));
    peakAbsTorqueNm = Math.max(peakAbsTorqueNm, Math.abs(teNow));
    peakSpeedRpm = Math.max(peakSpeedRpm, nRpmNow);
    minSpeedRpm = Math.min(minSpeedRpm, nRpmNow);
    if (ctrl.vLimited) voltageLimitHits++;
    if (ctrl.iCurrLimited || actualCurrentLimited) currentLimitHits++;
    lastVd = ctrl.vd; lastVq = ctrl.vq; lastTload = ctrl.cmd.tLoadNm;
    if (k === nOut - 1) break;

    for (let step = 0; step < substeps; step++) {
      const ts = tCur + step * h;
      const cStep = evalControl(ts, id, iq, omegaM);
      const k1 = rhs(id, iq, omegaM, cStep.vd, cStep.vq, cStep.cmd.tLoadNm);
      const k2 = rhs(id + 0.5 * h * k1.dId, iq + 0.5 * h * k1.dIq, omegaM + 0.5 * h * k1.dOmegaM, cStep.vd, cStep.vq, cStep.cmd.tLoadNm);
      const k3 = rhs(id + 0.5 * h * k2.dId, iq + 0.5 * h * k2.dIq, omegaM + 0.5 * h * k2.dOmegaM, cStep.vd, cStep.vq, cStep.cmd.tLoadNm);
      const k4 = rhs(id + h * k3.dId, iq + h * k3.dIq, omegaM + h * k3.dOmegaM, cStep.vd, cStep.vq, cStep.cmd.tLoadNm);
      id += (h / 6) * (k1.dId + 2 * k2.dId + 2 * k3.dId + k4.dId);
      iq += (h / 6) * (k1.dIq + 2 * k2.dIq + 2 * k3.dIq + k4.dIq);
      omegaM += (h / 6) * (k1.dOmegaM + 2 * k2.dOmegaM + 2 * k3.dOmegaM + k4.dOmegaM);
      thetaE += (h / 6) * (k1.dThetaE + 2 * k2.dThetaE + 2 * k3.dThetaE + k4.dThetaE);
      if (![id, iq, omegaM, thetaE].every(Number.isFinite)) throw new Error(`动态 PMSM 在 t=${ts.toFixed(6)}s 数值发散，已终止计算。`);
      if (params.controlMode !== 'open_loop_vdq') {
        let iTorqCmd = 0;
        if (cStep.cmd.iqRefA !== undefined) iTorqCmd = cStep.cmd.iqRefA;
        else {
          const wRef = ((cStep.cmd.speedRefRpm ?? 0) * 2 * Math.PI) / 60;
          const errW = wRef - omegaM;
          const unsatI = kpW * errW + intW;
          const satI = Math.max(-iMax, Math.min(iMax, unsatI));
          intW += h * (kiW * errW + 0.25 * bwW * (satI - unsatI));
          iTorqCmd = satI;
        }
        const tgt = computeMtpaAndFieldWeakeningTarget(iTorqCmd, p * omegaM, cStep.cmd.vBusV, params);
        const errD = tgt.idRefA - id;
        const errQ = tgt.iqRefA - iq;
        const awD = cStep.vLimited ? (cStep.vd - cStep.vdCmd) * 0.5 : 0;
        const awQ = cStep.vLimited ? (cStep.vq - cStep.vqCmd) * 0.5 : 0;
        intId += h * (kiD * errD + bwI * awD);
        intIq += h * (kiQ * errQ + bwI * awQ);
      }
    }
  }

  const weEnd = p * omegaM;
  const fluxEnd = fluxAt(id, iq);
  const analyticalVdV = rs * id - weEnd * fluxEnd.psiQVs;
  const analyticalVqV = rs * iq + weEnd * fluxEnd.psiDVs;
  const analyticalTeNm = 1.5 * p * (fluxEnd.psiDVs * iq - fluxEnd.psiQVs * id);
  const endRhs = rhs(id, iq, omegaM, lastVd, lastVq, lastTload);
  if (voltageLimitHits > 0) warnings.push(`仿真中有 ${voltageLimitHits} 个采样点触发 SVPWM 电压圆限幅 (|Vdq| ≥ Vbus/√3)。`);
  if (currentLimitHits > 0) warnings.push(`仿真中有 ${currentLimitHits} 个采样点触发相电流上限或参考限幅 (Imax=${iMax.toFixed(1)} A)。`);

  return {
    provenance: 'synthetic_assumed_uncalibrated', sourceModel: rawParams.fluxMap ? 'dynamic_pmsm_dq_rk4_flux_map' : 'dynamic_pmsm_dq_rk4',
    warnings, dtInternalSec: h, substepsPerOutput: substeps,
    time, thetaE: thetaEArr, omegaM: omegaMArr, nRpm: nRpmArr, idA: idArr, iqA: iqArr, vdV: vdArr, vqV: vqArr,
    psiDVs: psiDArr, psiQVs: psiQArr, pElecW: pElecArr, pCopperW: pCopperArr, pMechW: pMechArr, pLoadW: pLoadArr, pFrictionW: pFrictionArr,
    pMagneticStoredRateW: pMagneticStoredRateArr, pMechanicalStoredRateW: pMechanicalStoredRateArr,
    pElectricalBalanceResidualW: pElectricalBalanceResidualArr, pMechanicalBalanceResidualW: pMechanicalBalanceResidualArr,
    iaA: iaArr, ibA: ibArr, icA: icArr, teNm: teArr, tLoadNm: tLoadArr, vBusV: vBusArr, mNorm: mNormArr,
    voltageLimited: voltLimArr, currentLimited: currLimArr, quadrantMode,
    peakAbsCurrentA, peakAbsTorqueNm, peakSpeedRpm, minSpeedRpm, voltageLimitHits, currentLimitHits,
    fluxMapProvenance: rawParams.fluxMap?.provenance ?? 'linear_parameter_model', fluxMapOutOfRangeCount: 0,
    steadyCheck: {
      finalSpeedRpm: (omegaM * 60) / (2 * Math.PI), finalIdA: id, finalIqA: iq,
      analyticalTeNm, analyticalVdV, analyticalVqV, simTeNm: teArr[nOut - 1], simVdV: lastVd, simVqV: lastVq,
      torqueDiffNm: Math.abs(teArr[nOut - 1] - analyticalTeNm),
      voltageDiffV: Math.hypot(lastVd - analyticalVdV, lastVq - analyticalVqV),
      diDtNormAps: Math.hypot(endRhs.dId, endRhs.dIq), dOmegaDtNormRadS2: Math.abs(endRhs.dOmegaM),
    },
  };
}

function makeDynChannel(
  id: string,
  name: string,
  unit: string,
  color: string,
  t: Float64Array,
  vSrc: Float64Array,
  fs: number,
  dt: number,
  meta: ReturnType<typeof analyzeSamplingQuality>
): WaveformChannel {
  const v = new Float32Array(vSrc.length);
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < vSrc.length; i++) {
    const val = vSrc[i];
    v[i] = val;
    if (Number.isFinite(val)) {
      if (val < mn) mn = val;
      if (val > mx) mx = val;
    }
  }
  if (!Number.isFinite(mn) || !Number.isFinite(mx)) {
    mn = -1;
    mx = 1;
  } else if (Math.abs(mx - mn) < 1e-6) {
    mn -= 0.5;
    mx += 0.5;
  } else {
    const pad = (mx - mn) * 0.1;
    mn -= pad;
    mx += pad;
  }
  return {
    id,
    name,
    unit,
    color,
    t,
    v,
    visible: true,
    vMin: mn,
    vMax: mx,
    coupling: 'DC',
    inverted: false,
    isMath: false,
    channelKind: 'computed',
    derivedBadge: 'SIM dq',
    sourceChannelIds: [],
    fs,
    dt,
    metadata: {
      ...meta,
      gapIndices: [...meta.gapIndices],
      signalNanCount: 0,
      dataProvenance: 'synthetic_assumed_uncalibrated',
      sourceModel: meta.sourceModel ?? 'dynamic_pmsm_dq_rk4',
    },
  };
}

export function buildDynamicPmsmScopeTab(result: DynamicPmsmResult, label = 'Dynamic_PMSM_dq'): TabState | null {
  const n = result.time.length;
  if (n < 2) return null;
  const meta = analyzeSamplingQuality(result.time);
  const dt = meta.medianDt ?? meta.nominalDt ?? (result.time[n - 1] - result.time[0]) / (n - 1);
  const fs = dt > 0 ? 1 / dt : 1000;
  meta.dataProvenance = 'synthetic_assumed_uncalibrated';
  meta.sourceModel = result.sourceModel;

  const channels: Record<string, WaveformChannel> = {
    ch_ia: makeDynChannel('ch_ia', 'Ia (sim dq)', 'A', '#facc15', result.time, result.iaA, fs, dt, meta),
    ch_ib: makeDynChannel('ch_ib', 'Ib (sim dq)', 'A', '#22d3ee', result.time, result.ibA, fs, dt, meta),
    ch_ic: makeDynChannel('ch_ic', 'Ic (sim dq)', 'A', '#4ade80', result.time, result.icA, fs, dt, meta),
    ch_id: makeDynChannel('ch_id', 'Id (sim dq)', 'A', '#60a5fa', result.time, result.idA, fs, dt, meta),
    ch_iq: makeDynChannel('ch_iq', 'Iq (sim dq)', 'A', '#f472b6', result.time, result.iqA, fs, dt, meta),
    ch_n: makeDynChannel('ch_n', 'Speed (sim)', 'RPM', '#a78bfa', result.time, result.nRpm, fs, dt, meta),
    ch_te: makeDynChannel('ch_te', 'Te (sim)', 'Nm', '#fb923c', result.time, result.teNm, fs, dt, meta),
    ch_tload: makeDynChannel('ch_tload', 'T_load', 'Nm', '#94a3b8', result.time, result.tLoadNm, fs, dt, meta),
    ch_pelec: makeDynChannel('ch_pelec', 'P_elec (sim)', 'W', '#f97316', result.time, result.pElecW, fs, dt, meta),
    ch_pcu: makeDynChannel('ch_pcu', 'P_copper (sim)', 'W', '#eab308', result.time, result.pCopperW, fs, dt, meta),
    ch_pmech: makeDynChannel('ch_pmech', 'P_mech (sim)', 'W', '#22c55e', result.time, result.pMechW, fs, dt, meta),
    ch_pmag: makeDynChannel('ch_pmag', 'dW_magnetic/dt (sim)', 'W', '#c084fc', result.time, result.pMagneticStoredRateW, fs, dt, meta),
    ch_pbal: makeDynChannel('ch_pbal', 'Electrical power balance residual', 'W', '#f87171', result.time, result.pElectricalBalanceResidualW, fs, dt, meta),
    ch_pmecbal: makeDynChannel('ch_pmecbal', 'Mechanical power balance residual', 'W', '#fb7185', result.time, result.pMechanicalBalanceResidualW, fs, dt, meta),
    ch_psid: makeDynChannel('ch_psid', 'Psi_d (sim)', 'Vs', '#a78bfa', result.time, result.psiDVs, fs, dt, meta),
    ch_psiq: makeDynChannel('ch_psiq', 'Psi_q (sim)', 'Vs', '#38bdf8', result.time, result.psiQVs, fs, dt, meta),
  };

  return {
    id: `dyno_dyn_pmsm_${Date.now()}`,
    fileName: `${label}_SYNTHETIC_UNCALIBRATED.csv`,
    channels,
    drawOrder: ['ch_ia', 'ch_ib', 'ch_ic', 'ch_id', 'ch_iq', 'ch_n', 'ch_te', 'ch_tload', 'ch_pelec', 'ch_pcu', 'ch_pmech', 'ch_pmag', 'ch_pbal', 'ch_pmecbal', 'ch_psid', 'ch_psiq'],
    activeChannelId: 'ch_iq',
    separateView: true,
    plotMode: 'time',
    view: { startIndex: 0, endIndex: n },
    cursors: { enabled: false, mode: 'off', x1: null, x2: null, y1: null, y2: null, trackingChannel: 'ch_iq' },
    measurementGate: 'view',
    selectedMeasurements: [],
    triggerConfig: { enabled: false, channelId: 'ch_iq', type: 'rising', level: 0, positionPercent: 10 },
    fftOptions: { window: 'hann', scale: 'db', range: 'view', removeDC: true, zeroPadding: 1 },
    motorConfig: { enabled: false, rpm: null, polePairs: null },
    annotations: [],
    annotationMode: false,
    annotationsVisible: true,
    isOverlap: false,
  };
}

export function buildDynamicPmsmCsv(result: DynamicPmsmResult): string {
  const lines = [
    '# WAVEFORM_PROVENANCE=MODEL_SYNTHETIC_DYNAMIC_ASSUMED_UNCALIBRATED',
    `# SOURCE_MODEL=${result.sourceModel}`,
    'Time_s,n_rpm,Id_A,Iq_A,Vd_V,Vq_V,PsiD_Vs,PsiQ_Vs,Ia_A,Ib_A,Ic_A,Te_Nm,T_load_Nm,Vbus_V,Pelec_W,Pcu_W,Pmech_W,Pload_W,Pfriction_W,PmagneticStoredRate_W,PmechanicalStoredRate_W,ElectricalBalanceResidual_W,MechanicalBalanceResidual_W,m_norm,voltage_limited,current_limited,quadrant',
  ];
  for (let i = 0; i < result.time.length; i++) {
    lines.push(
      [
        result.time[i].toFixed(6),
        result.nRpm[i].toFixed(2),
        result.idA[i].toFixed(4),
        result.iqA[i].toFixed(4),
        result.vdV[i].toFixed(4),
        result.vqV[i].toFixed(4),
        result.psiDVs[i].toFixed(7),
        result.psiQVs[i].toFixed(7),
        result.iaA[i].toFixed(4),
        result.ibA[i].toFixed(4),
        result.icA[i].toFixed(4),
        result.teNm[i].toFixed(5),
        result.tLoadNm[i].toFixed(5),
        result.vBusV[i].toFixed(3),
        result.pElecW[i].toFixed(4),
        result.pCopperW[i].toFixed(4),
        result.pMechW[i].toFixed(4),
        result.pLoadW[i].toFixed(4),
        result.pFrictionW[i].toFixed(4),
        result.pMagneticStoredRateW[i].toFixed(4),
        result.pMechanicalStoredRateW[i].toFixed(4),
        result.pElectricalBalanceResidualW[i].toFixed(8),
        result.pMechanicalBalanceResidualW[i].toFixed(8),
        result.mNorm[i].toFixed(4),
        result.voltageLimited[i],
        result.currentLimited[i],
        result.quadrantMode[i],
      ].join(',')
    );
  }
  return lines.join('\n');
}
