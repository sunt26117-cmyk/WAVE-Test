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
import {
  CauerStage,
  ThermalPathMode,
  NonlinearEossCurve,
  evaluateNonlinearEossUj,
  parseSiUnitScale,
  simulateCauerZoh,
} from './thermalEngine';
import { computeChannelMean, getChannelDisplayValue } from './oscilloscopeScale';
import { inspectChannelSamplingGaps } from './timeSync';
import {
  DptAxisName,
  DptLutStatus,
  DptOperatingPoint,
  DptParameterProvenance,
  interpolateDptSwitchingLoss,
} from './dptAnalyzer';

export type FocModulationMode = 'SVPWM' | 'DPWM1' | 'SPWM';
export type MosSwitchKey = 'AH' | 'AL' | 'BH' | 'BL' | 'CH' | 'CL';
export type FocThermalTopologyMode = 'shared_board' | 'pcb_spatial_coupled' | 'independent';
export type FocModelProvenanceKind =
  | 'junction_ambient'
  | 'pad_ambient'
  | 'fallback_default'
  | 'demo_builtin'
  | 'datasheet_constrained';

export const MOS_SWITCH_KEYS: MosSwitchKey[] = ['AH', 'AL', 'BH', 'BL', 'CH', 'CL'];

export interface PcbZoneConfig {
  /** Local PCB thermal-region centroid, relative to the imported board origin. */
  xMm: number;
  yMm: number;
  /** Optional effective region area used to derive a first-order thermal capacitance. */
  areaMm2?: number;
  /** Explicit local thermal capacitance (preferred when extracted from FEA/test). */
  cPcbJPerC?: number;
  /** Vertical thermal resistance from the local zone to the common board/heatsink node. */
  rVertCPerW?: number;
}

export interface PcbMaterialLayerConfig {
  name: string;
  thicknessMm: number;
  /** Legacy isotropic conductivity fallback; prefer directional conductivities for anisotropic PCB layers. */
  conductivityWPerMK: number;
  conductivityInPlaneWPerMK?: number;
  conductivityThroughPlaneWPerMK?: number;
  densityKgPerM3: number;
  specificHeatJPerKgK: number;
  /** 0..1 coverage fraction within each zone. */
  coverageFraction?: number;
}

export interface PcbThermalLinkConfig {
  /** Zone index 0..5 or MOS_SWITCH_KEYS identifier (AH/AL/BH/BL/CH/CL). */
  fromZone: number | MosSwitchKey;
  toZone: number | MosSwitchKey;
  /** Effective in-plane conducting width and path length. */
  widthMm?: number;
  lengthMm?: number;
  /** Number of equivalent parallel copper paths/layers. */
  parallelLayers?: number;
  /** Optional explicit effective conductivity (W/m/K); defaults to copper. */
  conductivityWPerMK?: number;
  /** Optional effective thickness (mm); defaults to configured copper stack thickness. */
  thicknessMm?: number;
  /** Optional directly extracted conductance, takes precedence over geometry. */
  conductanceWPerC?: number;
}

export interface PcbSpatialThermalMatrixConfig {
  zones?: PcbZoneConfig[];
  /** One or more physical layers used to estimate local thermal mass and in-plane conductance. */
  stackup?: PcbMaterialLayerConfig[];
  /** Explicit physical links. When supplied, no all-to-all geometry coupling is generated. */
  links?: PcbThermalLinkConfig[];
  copperOz?: number;
  copperWidthMm?: number;
  layoutPitchMm?: number;
  /** Symmetric pairwise thermal conductance matrix; diagonal must be zero. */
  mutualConductanceMatrixWPerC?: number[][];
  zoneVerticalRthCPerW?: number[];
  zoneThermalCapJPerC?: number[];
  provenance?: 'measured' | 'geometry_estimated' | 'user_matrix' | 'fea_extracted' | 'datasheet_estimated';
  sourceLabel?: string;
  referenceTemperatureC?: number;
}

export interface PcbSpatialImportDocument {
  schema: 'wave-test-pcb-thermal';
  schemaVersion: 1;
  deviceName?: string;
  boardName?: string;
  /** Coordinates and dimensions in millimetres; conductance/capacity retain SI units. */
  units: 'mm';
  config: PcbSpatialThermalMatrixConfig;
}

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
  modelKind?: FocModelProvenanceKind;
  provenanceNote?: string;
  isHeuristicSingleStageSplit?: boolean;
  splitFeasible?: boolean;
  zthValidation?: {
    passed: boolean;
    maxRelErrPct: number;
    rthOrig: number;
    rthSplit: number;
  };
  splitMeta?: FocCauerSplitMeta;
  /** Optional 6-element [AH, AL, BH, BL, CH, CL] multiplier on ZthJC (e.g. solder voiding / spatial tolerance) */
  perSwitchRjcScale?: number[];
  /** Optional 6-element [AH, AL, BH, BL, CH, CL] extra local PCB copper spreading Rth (°C/W) between case and shared TBRD */
  perSwitchPadOffsetCPerW?: number[];
  /** Thermal network topology: shared lumped TBRD (default), 6-zone PCB spatial coupled matrix, or independent paths */
  thermalTopologyMode?: FocThermalTopologyMode;
  /** Spatial 6-zone PCB thermal capacitance & mutual conductance parameters */
  spatialMatrix?: PcbSpatialThermalMatrixConfig;
}

/**
 * One common electrical-device parameter set applied to all six identical MOSFETs.
 * Per-switch differences belong to current/duty and thermal-path/PCB data, not to
 * six separate electrical part-number parameter sets.
 */
export type RdsOnTempCurveProvenance = 'datasheet' | 'measured' | 'user_import' | 'assumed';

export interface RdsOnTempCurvePoint {
  tjC: number;
  /** Rds(on)(Tj) divided by Rds(on) at 25°C, dimensionless. */
  ratioTo25C: number;
}

/**
 * Normalized Rds(on)-Tj curve for the common MOS part used at all six bridge positions.
 * The curve is valid only at its declared gate voltage and must contain a 25°C ratio=1 anchor.
 */
export interface RdsOnTempCurve {
  schema: 'wave-test-rdson-temperature';
  schemaVersion: 1;
  referenceTemperatureC: 25;
  referenceGateVoltageV: number;
  provenance: RdsOnTempCurveProvenance;
  label?: string;
  manufacturer?: string;
  partNumber?: string;
  /** Explicitly records when values were digitized from a datasheet graph rather than tabulated. */
  sourceNote?: string;
  points: RdsOnTempCurvePoint[];
}

export interface RdsOnTempCurveImportDocument extends Omit<RdsOnTempCurve, 'points'> {
  points: RdsOnTempCurvePoint[];
}

export function validateRdsOnTempCurve(curve: RdsOnTempCurve): void {
  if (!curve || curve.schema !== 'wave-test-rdson-temperature' || curve.schemaVersion !== 1 ||
      curve.referenceTemperatureC !== 25 || !Array.isArray(curve.points) || curve.points.length < 3) {
    throw new Error('Rds(on)-Tj 曲线格式无效：需要 wave-test-rdson-temperature v1、25°C 参考点和至少 3 个数据点。');
  }
  if (!Number.isFinite(curve.referenceGateVoltageV) || curve.referenceGateVoltageV <= 0 || curve.referenceGateVoltageV > 30) {
    throw new Error('Rds(on)-Tj 曲线必须填写有效的参考栅极驱动电压 Vgs（0～30V）。');
  }
  if (!['datasheet', 'measured', 'user_import', 'assumed'].includes(curve.provenance)) {
    throw new Error(`Rds(on)-Tj 曲线来源无效：${String(curve.provenance)}。`);
  }
  let previousT = -Infinity;
  let previousRatio = 0;
  for (let i = 0; i < curve.points.length; i++) {
    const point = curve.points[i];
    if (!point || !Number.isFinite(point.tjC) || !Number.isFinite(point.ratioTo25C) ||
        point.tjC < -100 || point.tjC > 250 || point.ratioTo25C < 0.05 || point.ratioTo25C > 10) {
      throw new Error(`Rds(on)-Tj 曲线第 ${i + 1} 点无效：温度需在 -100～250°C，归一化比值需在 0.05～10。`);
    }
    if (point.tjC <= previousT) throw new Error('Rds(on)-Tj 曲线温度轴必须严格递增，不能重复或倒序。');
    if (i > 0 && point.ratioTo25C + 0.02 < previousRatio) {
      throw new Error('当前低压硅 MOS Rds(on)-Tj 曲线出现明显负温度系数段；请检查单位、数据提取和器件工作区。');
    }
    previousT = point.tjC;
    previousRatio = point.ratioTo25C;
  }
  const at25 = interpolateRdsOnTempCurveUnchecked(curve, 25);
  if (Math.abs(at25 - 1) > 0.05) {
    throw new Error(`Rds(on)-Tj 曲线在 25°C 的归一化值应为 1.0，当前插值为 ${at25.toFixed(4)}；请确认归一化基准。`);
  }
}

function interpolateRdsOnTempCurveUnchecked(curve: RdsOnTempCurve, tjC: number): number {
  const points = curve.points;
  if (tjC < points[0].tjC - 1e-9 || tjC > points[points.length - 1].tjC + 1e-9) {
    throw new Error(`MOS 结温 ${tjC.toFixed(2)}°C 超出 Rds(on)-Tj 曲线范围 [${points[0].tjC}°C, ${points[points.length - 1].tjC}°C]；禁止线性外推。`);
  }
  if (tjC <= points[0].tjC) return points[0].ratioTo25C;
  if (tjC >= points[points.length - 1].tjC) return points[points.length - 1].ratioTo25C;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].tjC <= tjC) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const u = (tjC - a.tjC) / (b.tjC - a.tjC);
  return a.ratioTo25C + u * (b.ratioTo25C - a.ratioTo25C);
}

export function evaluateRdsOnTempCurveRatio(curve: RdsOnTempCurve, tjC: number): number {
  validateRdsOnTempCurve(curve);
  if (!Number.isFinite(tjC)) throw new Error('MOS 结温查询值必须为有限数值。');
  return interpolateRdsOnTempCurveUnchecked(curve, tjC);
}

export function parseRdsOnTempCurveImportJson(text: string): RdsOnTempCurve {
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch (err) { throw new Error(`Rds(on)-Tj JSON 解析失败：${err instanceof Error ? err.message : String(err)}`); }
  if (!raw || typeof raw !== 'object') throw new Error('Rds(on)-Tj 导入文件必须是 JSON 对象。');
  const doc = raw as Partial<RdsOnTempCurveImportDocument>;
  const curve = doc as RdsOnTempCurve;
  validateRdsOnTempCurve(curve);
  return {
    ...curve,
    points: curve.points.map((point) => ({ tjC: Number(point.tjC), ratioTo25C: Number(point.ratioTo25C) })),
  };
}

export function createRdsOnTempCurveImportTemplate(): RdsOnTempCurveImportDocument {
  return {
    schema: 'wave-test-rdson-temperature',
    schemaVersion: 1,
    referenceTemperatureC: 25,
    referenceGateVoltageV: 10,
    provenance: 'datasheet',
    label: '请替换为目标 MOS 数据手册 Rds(on)-Tj 归一化曲线',
    manufacturer: '',
    partNumber: '',
    points: [],
  };
}

function validateRdsOnTempCurveForMos(mos: FocMosParams): void {
  const curve = mos.rdsOnTempCurve;
  if (!curve) return;
  validateRdsOnTempCurve(curve);
  const operatingVgs = mos.rdsOperatingVgsV;
  if (!Number.isFinite(operatingVgs) || (operatingVgs as number) <= 0 || (operatingVgs as number) > 30) {
    throw new Error('使用 Rds(on)-Tj 曲线时，必须填写 MOS 实际导通栅源电压 Vgs,on（0～30 V）；不能只填写曲线测试条件。');
  }
  if (Math.abs((operatingVgs as number) - curve.referenceGateVoltageV) > 0.1) {
    throw new Error(`Rds(on)-Tj 曲线测试 Vgs=${curve.referenceGateVoltageV.toFixed(2)} V，与当前实际 Vgs,on=${(operatingVgs as number).toFixed(2)} V 不一致（允许偏差 ±0.10 V）；请导入匹配实际驱动条件的曲线。`);
  }
  const rds25ReferenceVgs = mos.rds25ReferenceVgsV;
  if (!Number.isFinite(rds25ReferenceVgs) || (rds25ReferenceVgs as number) <= 0 || (rds25ReferenceVgs as number) > 30) {
    throw new Error('使用 Rds(on)-Tj 曲线时，必须填写 Rds(on)@25°C 绝对值对应的数据手册/实测 Vgs（0～30 V）。');
  }
  if (Math.abs((rds25ReferenceVgs as number) - curve.referenceGateVoltageV) > 0.1) {
    throw new Error(`Rds(on)@25°C 的参考 Vgs=${(rds25ReferenceVgs as number).toFixed(2)} V，与 Rds(on)-Tj 曲线参考 Vgs=${curve.referenceGateVoltageV.toFixed(2)} V 不一致（允许偏差 ±0.10 V）；归一化比例不能修正不同 Vgs 下的绝对 Rds 差异。`);
  }
}

function getFocMosRdsFactorAtTj(mos: FocMosParams, tjC: number): number {
  if (mos.rdsOnTempCurve) {
    validateRdsOnTempCurveForMos(mos);
    return interpolateRdsOnTempCurveUnchecked(mos.rdsOnTempCurve, tjC);
  }
  // Preserve the legacy alpha model's lower clamp and runaway behavior. The
  // curve path has its own bounded ratios and never extrapolates out of range.
  const factor = Math.max(0.1, 1 + (mos.tempCoeffAlphaPerC || 0) * (tjC - 25));
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error(`Rds(on) 温度修正系数异常：Tj=${tjC.toFixed(2)}°C，factor=${factor}。`);
  }
  return factor;
}

export interface FocMosParams {
  rdsOn25Mohm: number;
  /** True only after Rds(on)@25°C has been checked against the target device at the specified Vgs/test condition. */
  rdsDataConfirmed?: boolean;
  /** Optional measured/datasheet normalized curve; when present it overrides the linear alpha approximation. */
  rdsOnTempCurve?: RdsOnTempCurve;
  /** Actual nominal on-state gate-source voltage; required to match a supplied Rds(Tj) curve. */
  rdsOperatingVgsV?: number;
  /** Vgs at which the absolute Rds(on)@25°C value was specified/measured; must match the normalized curve reference when a curve is used. */
  rds25ReferenceVgsV?: number;
  tempCoeffAlphaPerC: number; // e.g. 0.0045 (/°C), fallback only when no curve is supplied
  vsdV: number; // body diode drop (V)
  eonPlusEoffUj: number; // switching loss ref Eon+Eoff (uJ) at vRefV, iRefA
  vRefV: number;
  iRefA: number;
  qrrNc: number; // recovered charge (nC) at qrrIrefA, or iRefA when omitted
  /** Reference current for the datasheet/DPT Qr or Qrr value; separate from Eon/Eoff Iref. */
  qrrIrefA?: number;
  /** Datasheet/DPT drain-source voltage at which qrrNc was measured; provenance only, not a voltage-scaling law. */
  qrrReferenceVdsV?: number;
  /** Datasheet/DPT commutation di/dt condition in A/us (usually negative); provenance only. */
  qrrReferenceDiDtAperUs?: number;
  /** Datasheet/DPT junction temperature at which qrrNc was measured. */
  qrrReferenceTjC?: number;
  /** Gate-source voltage during the body-diode reverse-recovery test, commonly 0 V. */
  qrrReferenceVgsV?: number;
  eossUj?: number; // optional zero-current Coss discharge energy (uJ) at vRefV (default 0 to avoid double-counting datasheet Eon)
  eossCurve?: NonlinearEossCurve; // optional nonlinear Eoss(V)/Qoss(V)/Coss(V) curve evaluated via monotone PCHIP
  eossAlreadyIncludedInEsw?: boolean; // explicit double-count guard when DPT Eon/Eoff already includes Coss energy
  eonIncludesQrr?: boolean; // true when Eon+Eoff comes from DPT waveform integral (Qrr already captured inside Eon)
  /** True when the datasheet's recovered charge Qr already includes output charge Qoss (Nexperia: Qr = Qs + Qoss). */
  qrrIncludesQoss?: boolean;
  rgOnOhm?: number;
  rgOffOhm?: number;
  rgProvenance?: DptParameterProvenance;
  /** Optional multi-point DPT lookup table; when provided, computePhaseMosLosses interpolates switching loss per (Vbus, |I_phase|, Tj, Rg) */
  dptLut?: DptOperatingPoint[];
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
  pcbT?: number[]; // 6 PCB zone temperatures (°C) in pcb_spatial_coupled mode
  brdT: number[]; // Kb board/heatsink ladder node temperatures (°C)
  brdArmsT?: number[][]; // 6 x Kb independent board arm temperatures (°C) in independent mode
  tBoardC: number;
  tjMaxC: number;
}

export type FocResultQualification = 'DEVICE_PARAMETERIZED' | 'ASSUMPTION_BASED' | 'INCOMPLETE_LOSS_MODEL';

export interface FocSimulationResult {
  /** Evidence class for interpreting all Tj/P_inv outputs; never equates model completion with safety sign-off. */
  resultQualification: FocResultQualification;
  qualificationReasons: string[];
  time: Float64Array;
  tj: Record<MosSwitchKey, Float32Array>;
  pMos: Record<MosSwitchKey, Float32Array>;
  pInvTotal: Float32Array;
  tBoard: Float32Array;
  tBoardByKey?: Record<MosSwitchKey, number>;
  thermalTopologyMode: FocThermalTopologyMode;
  spatialThermalProvenance?: string;
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
  junctionConvergencePct: number;
  phaseCurrentKclRmsA: number | null;
  phaseCurrentKclRelativePct: number | null;
  steadyConverged: boolean;
  steadyThermalRunaway: boolean;
  overmodulatedCount: number;
  zeroCurrentFallbackCount: number;
  maxSubDtOverTau: number;
  pointsPerElecCycle: number | null;
  finalThermalState: ThermalNetworkStateSnapshot;
  dutySource: 'reconstructed' | 'external';
  dptLutDiagnostics?: {
    status: DptLutStatus;
    activeDimensions: DptAxisName[];
    collapsedDimensions: DptAxisName[];
    outOfRangeCount: number;
    tjProvenance: DptParameterProvenance;
    rgProvenance: DptParameterProvenance;
  };
  eossSource: 'included_in_esw' | 'included_in_qrr' | 'nonlinear_curve' | 'vbus_sq_approx' | 'none';
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
  resultQualification: FocResultQualification;
  qualificationReasons: string[];
  anglesDeg: number[];
  steadyMaxTjPerAngle: number[];
  worstAngleDeg: number;
  worstSwitch: MosSwitchKey;
  worstSteadyTjC: number;
  steadySafe: boolean;
  thermalSafeAtRequestedCurrent: boolean;
  warnings: string[];
  i2tReferenceKind: 'balanced_sinusoidal_equivalent';
  tSafeSec: number | null;
  tSafeAngleDeg: number; // Electrical angle producing the earliest transient Tj-limit crossing (or worst horizon-end Tj).
  transientWorstSwitch: MosSwitchKey;
  i2tThresholdA2s: number | null; // Backwards-compatible alias of i2tRmsA2s
  i2tRmsA2s: number | null;
  i2tWorstLegA2s: number | null;
  phaseSquaredRatioAtWorst: number; // At tSafeAngleDeg: peak phase I^2 / I_rms^2 (I_rms = Ipk/sqrt(2))
  effectiveStallModDepthM: number;
  effectiveStallModulation: FocModulationMode;
  effectiveStallPfAngleDeg: number;
  rPhaseUsedOhm: number;
  stallVoltageLimited: boolean;
  stallSteadyConverged: boolean;
  stallThermalRunaway: boolean;
  inheritedHotState: boolean;
  inheritedFullThermalState: boolean;
  inheritedBoardTempC: number;
  inheritedMaxTjC: number | null;
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
  modelKind: 'fallback_default',
  provenanceNote: '内置默认 6-MOS 参考热网络 (RθJC=0.50 °C/W, RθBoard=1.10 °C/W)，非实测器件数据。',
};

export interface ResolvedSpatialNetwork {
  mode: FocThermalTopologyMode;
  cPcb: Float64Array; // 6 zones (J/°C)
  rVert: Float64Array; // 6 vertical Rth to TBRD (or TAMB in independent)
  gLat: Float64Array[]; // 6x6 symmetric off-diagonal mutual conductances (W/°C), zero diagonal
  provenanceLabel: string;
}

export function resolveSpatialThermalNetwork(model: FocThermalModel): ResolvedSpatialNetwork {
  const mode: FocThermalTopologyMode = model.thermalTopologyMode ?? 'shared_board';
  const brd = model.zthBoard.length > 0 ? model.zthBoard : DEFAULT_FOC_MODEL.zthBoard;
  const rBrdFirst = Math.max(0.05, brd[0]?.r ?? 0.45);
  const cBrdFirst = Math.max(0.05, brd[0]?.c ?? 0.85);
  const cfg = model.spatialMatrix;
  if (cfg) {
    const allowedProvenance: NonNullable<PcbSpatialThermalMatrixConfig['provenance']>[] = ['measured', 'geometry_estimated', 'user_matrix', 'fea_extracted', 'datasheet_estimated'];
    if (cfg.provenance !== undefined && !allowedProvenance.includes(cfg.provenance)) throw new Error(`PCB 热网络 provenance 非法：${String(cfg.provenance)}。`);
    if (cfg.stackup !== undefined && !Array.isArray(cfg.stackup)) throw new Error('PCB stackup 必须为数组。');
    if (cfg.links !== undefined && !Array.isArray(cfg.links)) throw new Error('PCB links 必须为数组。');
    if (cfg.zones !== undefined && !Array.isArray(cfg.zones)) throw new Error('PCB zones 必须为数组。');
  }

  const cPcb = new Float64Array(6);
  const rVert = new Float64Array(6);
  const gLat = Array.from({ length: 6 }, () => new Float64Array(6));

  if (mode === 'shared_board') {
    for (let m = 0; m < 6; m++) {
      cPcb[m] = cBrdFirst / 6;
      rVert[m] = 1e-6;
    }
    return {
      mode,
      cPcb,
      rVert,
      gLat,
      provenanceLabel: 'shared_board (单一集总 TBRD 节点)',
    };
  }

  if (mode === 'independent') {
    for (let m = 0; m < 6; m++) {
      const cap = cfg?.zoneThermalCapJPerC?.[m] ?? cfg?.zones?.[m]?.cPcbJPerC ?? cBrdFirst / 6;
      const rv = cfg?.zoneVerticalRthCPerW?.[m] ?? cfg?.zones?.[m]?.rVertCPerW ?? rBrdFirst * 0.4;
      if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(rv) || rv <= 0) {
        throw new Error(`独立热路径第 ${m + 1} 路 PCB 热容/热阻必须为有限正数。`);
      }
      cPcb[m] = cap;
      rVert[m] = rv;
    }
    return {
      mode,
      cPcb,
      rVert,
      gLat,
      provenanceLabel: 'independent (六管完全独立散热臂，G_ij = 0)',
    };
  }

  // pcb_spatial_coupled: physical six-zone network. Prefer an imported conductance
  // matrix or explicit copper links; geometry-only estimation creates a nearest-neighbour
  // graph instead of the previous unrealistic all-to-all coupling.
  const pitch = cfg?.layoutPitchMm ?? 14;
  if (!Number.isFinite(pitch) || pitch <= 0) throw new Error('PCB 布局节距必须为有限正数。');
  const defaultZones: PcbZoneConfig[] = [
    { xMm: 0, yMm: 0 },
    { xMm: 0, yMm: pitch * 0.65 },
    { xMm: pitch, yMm: 0 },
    { xMm: pitch, yMm: pitch * 0.65 },
    { xMm: 2 * pitch, yMm: 0 },
    { xMm: 2 * pitch, yMm: pitch * 0.65 },
  ];
  if (cfg?.zones && cfg.zones.length !== 6) {
    throw new Error(`PCB zones 必须严格包含 6 个区域 (AH/AL/BH/BL/CH/CL)，当前 ${cfg.zones.length} 个；禁止静默回退默认布局。`);
  }
  const zones = cfg?.zones ?? defaultZones;
  zones.forEach((z, i) => {
    if (!Number.isFinite(z.xMm) || !Number.isFinite(z.yMm)) {
      throw new Error(`PCB 区域 ${MOS_SWITCH_KEYS[i]} 的坐标必须为有限数值。`);
    }
    if (z.areaMm2 !== undefined && (!Number.isFinite(z.areaMm2) || z.areaMm2 <= 0)) {
      throw new Error(`PCB 区域 ${MOS_SWITCH_KEYS[i]} 的 areaMm2 必须为有限正数。`);
    }
  });
  for (let i = 0; i < 6; i++) {
    for (let j = i + 1; j < 6; j++) {
      if (Math.hypot(zones[i].xMm - zones[j].xMm, zones[i].yMm - zones[j].yMm) <= 1e-6) {
        throw new Error(`PCB 区域 ${MOS_SWITCH_KEYS[i]} 与 ${MOS_SWITCH_KEYS[j]} 坐标重合，无法建立空间热网络。`);
      }
    }
  }

  const copperOz = cfg?.copperOz ?? 2.0;
  const copperWidthMm = cfg?.copperWidthMm ?? 12.0;
  if (!Number.isFinite(copperOz) || copperOz <= 0 || !Number.isFinite(copperWidthMm) || copperWidthMm <= 0) {
    throw new Error('PCB 空间热网络铜厚 (oz) 与有效导热铜宽 (mm) 必须为有限正数。');
  }
  const copperThicknessMm = copperOz * 0.0348;
  const defaultKCu = 385.0;
  const stackup = cfg?.stackup ?? [];
  stackup.forEach((layer, i) => {
    if (
      !layer.name?.trim() || !Number.isFinite(layer.thicknessMm) || layer.thicknessMm <= 0 ||
      !Number.isFinite(layer.conductivityWPerMK) || layer.conductivityWPerMK <= 0 ||
      (layer.conductivityInPlaneWPerMK !== undefined && (!Number.isFinite(layer.conductivityInPlaneWPerMK) || layer.conductivityInPlaneWPerMK <= 0)) ||
      (layer.conductivityThroughPlaneWPerMK !== undefined && (!Number.isFinite(layer.conductivityThroughPlaneWPerMK) || layer.conductivityThroughPlaneWPerMK <= 0)) ||
      !Number.isFinite(layer.densityKgPerM3) || layer.densityKgPerM3 <= 0 ||
      !Number.isFinite(layer.specificHeatJPerKgK) || layer.specificHeatJPerKgK <= 0 ||
      (layer.coverageFraction !== undefined && (!Number.isFinite(layer.coverageFraction) || layer.coverageFraction < 0 || layer.coverageFraction > 1))
    ) throw new Error(`PCB stackup 第 ${i + 1} 层材料/厚度/热参数非法。`);
  });

  const padOffsets = model.perSwitchPadOffsetCPerW;
  if (padOffsets && padOffsets.length !== 6) throw new Error('perSwitchPadOffsetCPerW 必须为 6 个数值。');
  if (cfg?.zoneThermalCapJPerC && cfg.zoneThermalCapJPerC.length !== 6) throw new Error('zoneThermalCapJPerC 必须为 6 个数值。');
  if (cfg?.zoneVerticalRthCPerW && cfg.zoneVerticalRthCPerW.length !== 6) throw new Error('zoneVerticalRthCPerW 必须为 6 个数值。');

  const deriveZoneCap = (zone: PcbZoneConfig): number | undefined => {
    if (!zone.areaMm2 || stackup.length === 0) return undefined;
    const areaM2 = zone.areaMm2 * 1e-6;
    let cap = 0;
    for (const layer of stackup) {
      const volumeM3 = areaM2 * (layer.thicknessMm * 1e-3) * (layer.coverageFraction ?? 1);
      cap += volumeM3 * layer.densityKgPerM3 * layer.specificHeatJPerKgK;
    }
    return cap > 0 && Number.isFinite(cap) ? cap : undefined;
  };
  const deriveZoneVerticalR = (zone: PcbZoneConfig): number | undefined => {
    if (!zone.areaMm2 || stackup.length === 0) return undefined;
    const areaM2 = zone.areaMm2 * 1e-6;
    let resistance = 0;
    for (const layer of stackup) {
      const coverage = layer.coverageFraction ?? 1;
      if (coverage <= 0) continue;
      const kZ = layer.conductivityThroughPlaneWPerMK ?? layer.conductivityWPerMK;
      resistance += (layer.thicknessMm * 1e-3) / (kZ * areaM2 * coverage);
    }
    return resistance > 0 && Number.isFinite(resistance) ? resistance : undefined;
  };

  for (let m = 0; m < 6; m++) {
    const cap = cfg?.zoneThermalCapJPerC?.[m] ?? zones[m].cPcbJPerC ?? deriveZoneCap(zones[m]) ?? Math.max(0.04, cBrdFirst / 6);
    const baseRv = cfg?.zoneVerticalRthCPerW?.[m] ?? zones[m].rVertCPerW ?? deriveZoneVerticalR(zones[m]) ?? Math.max(0.15, rBrdFirst * 1.4);
    const extraPad = padOffsets ? padOffsets[m] : 0;
    if (extraPad !== undefined && (!Number.isFinite(extraPad) || extraPad < 0)) {
      throw new Error(`PCB 区域 ${MOS_SWITCH_KEYS[m]} 的 Pad 附加热阻必须为有限非负数。`);
    }
    const rv = baseRv + (extraPad ?? 0);
    if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(rv) || rv <= 0) {
      throw new Error(`PCB 空间区域 ${MOS_SWITCH_KEYS[m]} 的热容 C_pcb 或垂直热阻 R_vert 必须为有限正数。`);
    }
    cPcb[m] = cap;
    rVert[m] = rv;
  }

  const hasMatrix = Boolean(cfg?.mutualConductanceMatrixWPerC);
  const hasLinks = Boolean(cfg?.links && cfg.links.length > 0);
  if (hasMatrix && hasLinks) throw new Error('PCB 热网络不能同时提供 mutualConductanceMatrixWPerC 和 links；请选用一种互热定义，避免重复计入。');

  if (hasMatrix) {
    const mat = cfg!.mutualConductanceMatrixWPerC!;
    if (!Array.isArray(mat) || mat.length !== 6 || mat.some((row) => !Array.isArray(row) || row.length !== 6)) {
      throw new Error('PCB 互热导矩阵 mutualConductanceMatrixWPerC 必须为 6×6 矩阵。');
    }
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        const gij = mat[i][j];
        if (!Number.isFinite(gij) || gij < -1e-12) {
          throw new Error(`PCB 互热导矩阵 (${MOS_SWITCH_KEYS[i]}, ${MOS_SWITCH_KEYS[j]}) 必须为有限非负值。`);
        }
        if (i === j && Math.abs(gij) > 1e-9) throw new Error(`PCB 互热导矩阵对角线必须为 0；区域 ${MOS_SWITCH_KEYS[i]} 的对角值被忽略会掩盖输入错误。`);
        if (j > i) {
          const gji = mat[j][i];
          if (!Number.isFinite(gji) || gji < -1e-12) throw new Error(`PCB 互热导矩阵 (${MOS_SWITCH_KEYS[j]}, ${MOS_SWITCH_KEYS[i]}) 必须为有限非负值。`);
          if (Math.abs(gij - gji) > 1e-6 * Math.max(1, Math.abs(gij), Math.abs(gji))) {
            throw new Error(`PCB 互热导矩阵非对称 (${MOS_SWITCH_KEYS[i]}↔${MOS_SWITCH_KEYS[j]}: ${gij} vs ${gji})，违背热传导互易定理。`);
          }
          gLat[i][j] = gLat[j][i] = Math.max(0, 0.5 * (gij + gji));
        }
      }
    }
  } else if (hasLinks) {
    const zoneIndex = (v: number | MosSwitchKey): number => {
      const idx = typeof v === 'number' ? v : MOS_SWITCH_KEYS.indexOf(v);
      if (!Number.isInteger(idx) || idx < 0 || idx >= 6) throw new Error(`PCB thermal link 区域索引无效：${String(v)}。`);
      return idx;
    };
    const copperStackThicknessMm = stackup
      .filter((layer) => /cu|copper|铜/i.test(layer.name))
      .reduce((sum, layer) => sum + layer.thicknessMm * (layer.coverageFraction ?? 1), 0) || copperThicknessMm;
    for (const [linkIdx, link] of cfg!.links!.entries()) {
      const from = zoneIndex(link.fromZone);
      const to = zoneIndex(link.toZone);
      if (from === to) throw new Error(`PCB link #${linkIdx + 1} 不允许连接同一个区域。`);
      let g = link.conductanceWPerC;
      if (g === undefined) {
        const width = link.widthMm ?? copperWidthMm;
        const length = link.lengthMm ?? Math.hypot(zones[from].xMm - zones[to].xMm, zones[from].yMm - zones[to].yMm);
        const layers = link.parallelLayers ?? 1;
        if (![width, length, layers].every(Number.isFinite) || width <= 0 || length <= 0 || layers <= 0) {
          throw new Error(`PCB link #${linkIdx + 1} 的宽度、长度和并联路径数必须为有限正数。`);
        }
        if (link.conductivityWPerMK !== undefined || link.thicknessMm !== undefined || stackup.length === 0) {
          const thickness = link.thicknessMm ?? copperStackThicknessMm;
          const k = link.conductivityWPerMK ?? defaultKCu;
          if (![thickness, k].every(Number.isFinite) || thickness <= 0 || k <= 0) throw new Error(`PCB link #${linkIdx + 1} 的厚度或导热率非法。`);
          g = k * (width * 1e-3) * (thickness * 1e-3) * layers / (length * 1e-3);
        } else {
          // Parallel in-plane conduction through each imported PCB layer; directional kx/ky
          // is used instead of incorrectly applying through-plane FR4 conductivity.
          g = stackup.reduce((sum, layer) => {
            const kXY = layer.conductivityInPlaneWPerMK ?? layer.conductivityWPerMK;
            const aM2 = (width * 1e-3) * (layer.thicknessMm * 1e-3) * (layer.coverageFraction ?? 1);
            return sum + kXY * aM2 / (length * 1e-3);
          }, 0) * layers;
        }
      }
      if (!Number.isFinite(g) || g < 0) throw new Error(`PCB link #${linkIdx + 1} 的导热系数必须为有限非负值。`);
      gLat[from][to] += g;
      gLat[to][from] += g;
    }
  } else {
    // Geometry-only estimate: connect only nearest-neighbour zones. Do not create
    // artificial direct thermal paths between every pair of MOS regions.
    const minDistance = new Float64Array(6).fill(Infinity);
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) if (i !== j) {
        const d = Math.hypot(zones[i].xMm - zones[j].xMm, zones[i].yMm - zones[j].yMm);
        minDistance[i] = Math.min(minDistance[i], d);
      }
    }
    const thicknessM = copperThicknessMm * 1e-3;
    for (let i = 0; i < 6; i++) {
      for (let j = i + 1; j < 6; j++) {
        const distanceMm = Math.hypot(zones[i].xMm - zones[j].xMm, zones[i].yMm - zones[j].yMm);
        const neighbourLimit = 1.35 * Math.max(minDistance[i], minDistance[j]);
        if (distanceMm > neighbourLimit) continue;
        const gPair = defaultKCu * thicknessM * (copperWidthMm * 1e-3) / (distanceMm * 1e-3);
        gLat[i][j] = gPair;
        gLat[j][i] = gPair;
      }
    }
  }

  const prov = cfg?.provenance === 'measured'
    ? '实测热耦合矩阵 (measured)'
    : cfg?.provenance === 'fea_extracted'
    ? 'FEA 提取热网络 (fea_extracted)'
    : cfg?.provenance === 'user_matrix'
    ? '用户导入对称无源互导矩阵'
    : cfg?.provenance === 'datasheet_estimated'
    ? '材料/数据手册估算热网络'
    : `几何近邻估算 (${copperOz.toFixed(1)}oz, pitch=${pitch.toFixed(1)}mm)`;
  const source = cfg?.sourceLabel ? ` · ${cfg.sourceLabel}` : '';
  return {
    mode,
    cPcb,
    rVert,
    gLat,
    provenanceLabel: `pcb_spatial_coupled · ${prov}${source}`,
  };
}


/** Parse a versioned PCB thermal-network JSON document for future CAD/FEA/test imports. */
export function parsePcbSpatialImportJson(text: string): PcbSpatialImportDocument {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (err) {
    throw new Error(`PCB 热网络 JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== 'object') throw new Error('PCB 热网络导入文件必须是 JSON 对象。');
  const doc = raw as Partial<PcbSpatialImportDocument>;
  if (doc.schema !== 'wave-test-pcb-thermal' || doc.schemaVersion !== 1 || doc.units !== 'mm' || !doc.config || typeof doc.config !== 'object') {
    throw new Error('PCB 热网络文件格式不匹配：需要 schema=wave-test-pcb-thermal、schemaVersion=1、units=mm 和 config。');
  }
  const allowedProvenance: NonNullable<PcbSpatialThermalMatrixConfig['provenance']>[] = ['measured', 'geometry_estimated', 'user_matrix', 'fea_extracted', 'datasheet_estimated'];
  const provenance = doc.config.provenance ?? (doc.config.mutualConductanceMatrixWPerC ? 'user_matrix' : 'geometry_estimated');
  if (!allowedProvenance.includes(provenance)) throw new Error(`PCB 热网络 provenance 非法：${String(provenance)}。`);
  const config: PcbSpatialThermalMatrixConfig = {
    ...doc.config,
    provenance,
  };
  const testModel: FocThermalModel = {
    zthJC: DEFAULT_FOC_MODEL.zthJC,
    zthBoard: DEFAULT_FOC_MODEL.zthBoard,
    thermalTopologyMode: 'pcb_spatial_coupled',
    spatialMatrix: config,
  };
  resolveSpatialThermalNetwork(testModel); // Run the same physical/schema validation used by the solver.
  return { ...doc, config } as PcbSpatialImportDocument;
}

export function createPcbSpatialImportTemplate(): PcbSpatialImportDocument {
  return {
    schema: 'wave-test-pcb-thermal',
    schemaVersion: 1,
    deviceName: '请填写逆变器/MOS 型号',
    boardName: '请填写 PCB 版本',
    units: 'mm',
    config: {
      provenance: 'geometry_estimated',
      sourceLabel: 'CAD/FEA/热测试导入模板',
      copperOz: 2,
      copperWidthMm: 8,
      zones: MOS_SWITCH_KEYS.map((key, i) => ({
        xMm: Math.floor(i / 2) * 20,
        yMm: (i % 2) * 12,
        areaMm2: 120,
        rVertCPerW: 1.5,
      })),
      stackup: [
        { name: 'Top copper', thicknessMm: 0.07, conductivityWPerMK: 385, conductivityInPlaneWPerMK: 385, conductivityThroughPlaneWPerMK: 385, densityKgPerM3: 8960, specificHeatJPerKgK: 385, coverageFraction: 0.55 },
        { name: 'FR4 core', thicknessMm: 1.2, conductivityWPerMK: 0.35, conductivityInPlaneWPerMK: 0.35, conductivityThroughPlaneWPerMK: 0.28, densityKgPerM3: 1850, specificHeatJPerKgK: 1100, coverageFraction: 1 },
        { name: 'Bottom copper', thicknessMm: 0.07, conductivityWPerMK: 385, conductivityInPlaneWPerMK: 385, conductivityThroughPlaneWPerMK: 385, densityKgPerM3: 8960, specificHeatJPerKgK: 385, coverageFraction: 0.4 },
      ],
      links: [
        { fromZone: 'AH', toZone: 'BH', widthMm: 8, lengthMm: 20, parallelLayers: 1 },
        { fromZone: 'BH', toZone: 'CH', widthMm: 8, lengthMm: 20, parallelLayers: 1 },
        { fromZone: 'AL', toZone: 'BL', widthMm: 8, lengthMm: 20, parallelLayers: 1 },
        { fromZone: 'BL', toZone: 'CL', widthMm: 8, lengthMm: 20, parallelLayers: 1 },
        { fromZone: 'AH', toZone: 'AL', widthMm: 8, lengthMm: 12, parallelLayers: 1 },
        { fromZone: 'BH', toZone: 'BL', widthMm: 8, lengthMm: 12, parallelLayers: 1 },
        { fromZone: 'CH', toZone: 'CL', widthMm: 8, lengthMm: 12, parallelLayers: 1 },
      ],
    },
  };
}

export function buildPerSwitchJcChains(model: FocThermalModel): CauerStage[][] {
  const baseJc = model.zthJC.length > 0 ? model.zthJC : DEFAULT_FOC_MODEL.zthJC;
  const scales = model.perSwitchRjcScale;
  const padOffsets = model.perSwitchPadOffsetCPerW;
  const spatialMode = (model.thermalTopologyMode ?? 'shared_board') === 'pcb_spatial_coupled';
  return MOS_SWITCH_KEYS.map((_, m) => {
    const sc = scales && scales.length === 6 && Number.isFinite(scales[m]) && scales[m] > 0 ? scales[m] : 1.0;
    const padR = !spatialMode && padOffsets && padOffsets.length === 6 && Number.isFinite(padOffsets[m]) && padOffsets[m] > 0 ? padOffsets[m] : 0;
    const stages = baseJc.map((s) => ({
      r: s.r * sc,
      c: s.c,
      tauEst: s.r * sc * s.c,
      layerLabel: s.layerLabel,
    }));
    if (padR > 0 && stages.length > 0) {
      const last = stages[stages.length - 1];
      last.r += padR;
      last.tauEst = last.r * last.c;
    }
    return stages;
  });
}

function computeCauerSplitValidation(
  origStages: CauerStage[],
  splitChain: CauerStage[]
): { passed: boolean; maxRelErrPct: number; rthOrig: number; rthSplit: number } {
  const rthOrig = origStages.reduce((a, s) => a + Math.max(0, s.r), 0);
  const rthSplit = splitChain.reduce((a, s) => a + Math.max(0, s.r), 0);
  if (origStages.length === 0 || splitChain.length === 0 || rthOrig <= 1e-9) {
    return { passed: true, maxRelErrPct: 0, rthOrig, rthSplit };
  }
  const taus = [...origStages, ...splitChain].map((s) => Math.max(1e-5, s.r * s.c));
  const tMin = Math.max(1e-5, Math.min(...taus) * 0.25);
  const tMax = Math.max(tMin * 20, Math.max(...taus) * 3.5);
  const nPts = 80;
  const tArr = new Float64Array(nPts);
  const pArr = new Float32Array(nPts).fill(1);
  for (let i = 0; i < nPts; i++) {
    tArr[i] = i === 0 ? 0 : tMin * Math.pow(tMax / tMin, (i - 1) / Math.max(1, nPts - 2));
  }
  const zOrig = simulateCauerZoh(tArr, pArr, origStages, 0);
  const zSplit = simulateCauerZoh(tArr, pArr, splitChain, 0);
  let maxRelErr = 0;
  const rRef = Math.max(1e-4, rthOrig);
  for (let i = 1; i < nPts; i++) {
    const err = Math.abs(zSplit[i] - zOrig[i]) / Math.max(0.05 * rRef, Math.abs(zOrig[i]));
    if (err > maxRelErr) maxRelErr = err;
  }
  const maxRelErrPct = maxRelErr * 100;
  const rthRelErr = Math.abs(rthSplit - rthOrig) / rRef;
  return {
    passed: rthRelErr <= 0.02 && maxRelErrPct <= 45,
    maxRelErrPct,
    rthOrig,
    rthSplit,
  };
}

export function splitCauerToFocModel(
  fullCauer: CauerStage[],
  tauSplitSec = 0.05,
  options?: {
    pathMode?: ThermalPathMode;
    rJcDatasheetOhm?: number;
  }
): FocThermalModel {
  const pathMode: ThermalPathMode = options?.pathMode === 'pad_ambient' ? 'pad_ambient' : 'junction_ambient';
  const rJcConstraint =
    options?.rJcDatasheetOhm !== undefined && Number.isFinite(options.rJcDatasheetOhm) && options.rJcDatasheetOhm > 0
      ? options.rJcDatasheetOhm
      : null;

  if (!fullCauer || fullCauer.length === 0) {
    return {
      zthJC: DEFAULT_FOC_MODEL.zthJC.map((s) => ({ ...s })),
      zthBoard: DEFAULT_FOC_MODEL.zthBoard.map((s) => ({ ...s })),
      modelKind: 'fallback_default',
      provenanceNote: DEFAULT_FOC_MODEL.provenanceNote,
      isHeuristicSingleStageSplit: false,
      splitFeasible: true,
    };
  }

  // A measured Tj-to-ambient curve does not identify the physical JC/board
  // boundary by time-constant heuristics. Require a datasheet RθJC anchor and
  // at least two Cauer sections so a physical boundary can be selected.
  if (pathMode === 'pad_ambient') {
    const warning = '当前数据来自 PCB/焊盘测温，只能识别 Pad-to-Ambient 热响应；没有实测 TSEP/ZthJC 瞬态曲线，不能构造真实 Junction-to-Case 网络。已禁止进入六管结温仿真。';
    return {
      zthJC: [],
      zthBoard: fullCauer.map((s) => ({ ...s })),
      modelKind: 'pad_ambient',
      provenanceNote: warning,
      isHeuristicSingleStageSplit: false,
      splitFeasible: false,
      splitMeta: { tauSplitSec, boundaryIndex: 0, boundaryAdjusted: false, nonMonotonicTau: false, shuntCapRatioPct: 0, warning },
    };
  }
  if (rJcConstraint === null) {
    const warning = '缺少器件手册 RθJC 约束。整体 Tj-to-Ambient Cauer 网络无法仅凭 τ_split 唯一拆分为 Junction-to-Case 与 Board-to-Ambient；已拒绝经验时间常数拆分。';
    return {
      zthJC: fullCauer.map((s) => ({ ...s })),
      zthBoard: [],
      modelKind: 'junction_ambient',
      provenanceNote: warning,
      isHeuristicSingleStageSplit: fullCauer.length === 1,
      splitFeasible: false,
      splitMeta: { tauSplitSec, boundaryIndex: 0, boundaryAdjusted: false, nonMonotonicTau: false, shuntCapRatioPct: 0, warning },
    };
  }
  if (fullCauer.length < 2) {
    const warning = '实测 Cauer 仅有一个热段，无法在保持阶梯物理结构的前提下独立识别 JC 与 Board；需要更高时间分辨率的热瞬态数据或独立 ZthJC 曲线。';
    return {
      zthJC: fullCauer.map((s) => ({ ...s })),
      zthBoard: [],
      modelKind: 'junction_ambient',
      provenanceNote: warning,
      isHeuristicSingleStageSplit: true,
      splitFeasible: false,
      splitMeta: { tauSplitSec, boundaryIndex: 0, boundaryAdjusted: false, nonMonotonicTau: false, shuntCapRatioPct: 0, warning },
    };
  }

  // Physical boundary is only estimated from the datasheet RθJC resistance anchor.
  // The measured Tj→Ambient Foster/Cauer response alone cannot uniquely identify JC vs PCB.
  const totalR = fullCauer.reduce((acc, stage) => acc + stage.r, 0);
  const warningBase = '边界由器件手册 RθJC 锚定并通过整体阶跃响应校验；该等效拆分仍不等价于独立实测 ZthJC/ZthBoard，签核前必须由器件/PCB 实测验证。';
  if (!Number.isFinite(totalR) || totalR <= rJcConstraint! * 1.02) {
    const warning = `RθJC 约束 ${rJcConstraint!.toFixed(3)}°C/W 不小于可用实测总热阻 ${totalR.toFixed(3)}°C/W，无法建立正值 Board 热阻。`;
    return {
      zthJC: fullCauer.map((stage) => ({ ...stage })),
      zthBoard: [],
      modelKind: 'junction_ambient',
      provenanceNote: warning,
      isHeuristicSingleStageSplit: false,
      splitFeasible: false,
      splitMeta: { tauSplitSec, boundaryIndex: 0, boundaryAdjusted: false, nonMonotonicTau: false, shuntCapRatioPct: 0, warning },
    };
  }

  let nonMonotonicTau = false;
  for (let i = 1; i < fullCauer.length; i++) {
    if (!Number.isFinite(fullCauer[i].tauEst) || fullCauer[i].tauEst < fullCauer[i - 1].tauEst * 0.99) {
      nonMonotonicTau = true;
      break;
    }
  }

  // Select the RC-stage boundary whose cumulative R is closest to datasheet RθJC.
  let splitIdx = 1;
  let bestDiff = Infinity;
  let cumulativeR = 0;
  for (let i = 0; i < fullCauer.length - 1; i++) {
    cumulativeR += fullCauer[i].r;
    const diff = Math.abs(cumulativeR - rJcConstraint!);
    if (diff < bestDiff) {
      bestDiff = diff;
      splitIdx = i + 1;
    }
  }

  const candJc = fullCauer.slice(0, splitIdx).map((stage) => ({ ...stage }));
  const candBoard = fullCauer.slice(splitIdx).map((stage) => ({ ...stage }));
  const rawJcR = candJc.reduce((acc, stage) => acc + stage.r, 0);
  const deltaR = rawJcR - rJcConstraint!;
  if (candJc.length === 0 || candBoard.length === 0 || !(rawJcR > 0) || !(candBoard[0].r + deltaR > 1e-4)) {
    const warning = `按 RθJC=${rJcConstraint!.toFixed(3)}°C/W 选择的边界无法保持正值 JC/Board 热阻，已拒绝结温仿真。`;
    return {
      zthJC: candJc,
      zthBoard: candBoard,
      modelKind: 'junction_ambient',
      provenanceNote: warning,
      isHeuristicSingleStageSplit: false,
      splitFeasible: false,
      splitMeta: { tauSplitSec, boundaryIndex: splitIdx, boundaryAdjusted: false, nonMonotonicTau, shuntCapRatioPct: 0, warning },
    };
  }

  const scaleJc = rJcConstraint! / rawJcR;
  const jc = candJc.map((stage) => ({
    ...stage,
    r: stage.r * scaleJc,
    tauEst: stage.r * scaleJc * stage.c,
  }));
  const board = candBoard.map((stage) => ({ ...stage }));
  board[0] = {
    ...board[0],
    r: board[0].r + deltaR,
    tauEst: (board[0].r + deltaR) * board[0].c,
  };

  const sumJcCap = jc.reduce((acc, stage) => acc + stage.c, 0);
  const sumBoardCap = board.reduce((acc, stage) => acc + stage.c, 0);
  const shuntCapRatioPct = sumBoardCap > 1e-12 ? ((5 * sumJcCap) / sumBoardCap) * 100 : 0;
  const zthValidation = computeCauerSplitValidation(fullCauer, [...jc, ...board]);
  const splitFeasible = zthValidation.passed && [...jc, ...board].every((stage) =>
    Number.isFinite(stage.r) && stage.r > 0 && Number.isFinite(stage.c) && stage.c > 0
  );
  const warnings: string[] = [warningBase];
  if (nonMonotonicTau) warnings.push('原始 Cauer 阶梯 τ 非单调；边界仍按串联热阻锚定，需复核反演阶梯物理顺序。');
  if (shuntCapRatioPct > 35) warnings.push(`六臂星形网络的并联 JC 热容占比为 ${shuntCapRatioPct.toFixed(0)}%，共享 Board 节点会影响单管瞬态响应。`);
  if (!zthValidation.passed) {
    warnings.push(`拆分后整体阶跃响应校验未通过（最大相对偏差 ${zthValidation.maxRelErrPct.toFixed(1)}%）；已禁止进入 6-MOS 结温仿真。`);
  }

  return {
    zthJC: jc,
    zthBoard: board,
    modelKind: splitFeasible ? 'datasheet_constrained' : 'junction_ambient',
    provenanceNote: `来源：Tj-to-Ambient 热响应反演 + 手册 RθJC=${rJcConstraint!.toFixed(3)}°C/W 电阻锚定；${warningBase}`,
    isHeuristicSingleStageSplit: false,
    splitFeasible,
    zthValidation,
    splitMeta: {
      tauSplitSec,
      boundaryIndex: splitIdx,
      boundaryAdjusted: true,
      nonMonotonicTau,
      shuntCapRatioPct,
      warning: warnings.join('；'),
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
  if (model.splitFeasible === false) {
    throw new Error(model.splitMeta?.warning || 'JC/Board 热路径拆分未通过物理约束校验，拒绝导出 6-MOS LTspice 热网络。');
  }
  const armJcs = buildPerSwitchJcChains(model);
  const brd = model.zthBoard.length > 0 ? model.zthBoard : DEFAULT_FOC_MODEL.zthBoard;
  const spatial = resolveSpatialThermalNetwork(model);
  const lines: string[] = [
    `* Waveform Viewer Pro - 6-MOS BLDC Inverter Thermal Subcircuit (${spatial.mode})`,
    `* Provenance: ${model.provenanceNote || model.modelKind || 'Custom Model'} | Topology: ${spatial.provenanceLabel}`,
    `* Ports: Q1(AH) Q2(AL) Q3(BH) Q4(BL) Q5(CH) Q6(CL) TAMB`,
  ];
  if (spatial.mode === 'shared_board') {
    lines.push(`* Shared Board Node: TBRD`);
  } else if (spatial.mode === 'pcb_spatial_coupled') {
    lines.push(`* Spatial 6-Zone PCB Nodes: PCB_AH..PCB_CL -> Shared Heatsink TBRD -> TAMB`);
  } else {
    lines.push(`* Independent Per-MOS Board Paths: TBRD_AH..TBRD_CL -> TAMB (Zero Mutual Coupling)`);
  }
  lines.push(`.subckt ${subcktName} Q1 Q2 Q3 Q4 Q5 Q6 TAMB params: T_amb=${tAmbC.toFixed(2)}`);

  const icNodes: string[] = [];

  for (let m = 0; m < 6; m++) {
    const port = `Q${m + 1}`;
    const label = MOS_SWITCH_KEYS[m];
    const jc = armJcs[m];
    const endNode =
      spatial.mode === 'shared_board'
        ? 'TBRD'
        : spatial.mode === 'pcb_spatial_coupled'
        ? `PCB_${label}`
        : `TBRD_${label}`;
    icNodes.push(`V(${port})={T_amb}`);
    lines.push(`* --- MOSFET ${port} (${label}) ZthJC ---`);
    for (let k = 0; k < jc.length; k++) {
      const left = k === 0 ? port : `N${m + 1}_${k}`;
      const right = k === jc.length - 1 ? endNode : `N${m + 1}_${k + 1}`;
      if (k < jc.length - 1) icNodes.push(`V(N${m + 1}_${k + 1})={T_amb}`);
      lines.push(`C_${label}_${k + 1} ${left} 0 ${jc[k].c.toExponential(6)}`);
      lines.push(`R_${label}_${k + 1} ${left} ${right} ${jc[k].r.toExponential(6)}`);
    }
  }

  if (spatial.mode === 'pcb_spatial_coupled') {
    lines.push(`* --- 6-MOS PCB Spatial Zones (C_pcb, R_vert, Symmetric Lateral R_lat) ---`);
    for (let m = 0; m < 6; m++) {
      const label = MOS_SWITCH_KEYS[m];
      const pNode = `PCB_${label}`;
      icNodes.push(`V(${pNode})={T_amb}`);
      lines.push(`C_PCB_${label} ${pNode} 0 ${spatial.cPcb[m].toExponential(6)}`);
      lines.push(`R_VERT_${label} ${pNode} TBRD ${spatial.rVert[m].toExponential(6)}`);
    }
    for (let i = 0; i < 6; i++) {
      for (let j = i + 1; j < 6; j++) {
        const g = spatial.gLat[i][j];
        if (g > 1e-12) {
          lines.push(`R_LAT_${MOS_SWITCH_KEYS[i]}_${MOS_SWITCH_KEYS[j]} PCB_${MOS_SWITCH_KEYS[i]} PCB_${MOS_SWITCH_KEYS[j]} ${(1 / g).toExponential(6)}`);
        }
      }
    }
  }

  if (spatial.mode === 'independent') {
    lines.push(`* --- Independent Per-MOS PCB/Heatsink Chains (6x uncoupled) ---`);
    for (let m = 0; m < 6; m++) {
      const label = MOS_SWITCH_KEYS[m];
      const root = `TBRD_${label}`;
      icNodes.push(`V(${root})={T_amb}`);
      for (let k = 0; k < brd.length; k++) {
        const left = k === 0 ? root : `BRD_${label}_${k}`;
        const right = k === brd.length - 1 ? 'TAMB' : `BRD_${label}_${k + 1}`;
        if (k < brd.length - 1) icNodes.push(`V(BRD_${label}_${k + 1})={T_amb}`);
        lines.push(`C_BRD_${label}_${k + 1} ${left} 0 ${(brd[k].c / 6).toExponential(6)}`);
        lines.push(`R_BRD_${label}_${k + 1} ${left} ${right} ${(brd[k].r * 6 + (k === 0 ? spatial.rVert[m] : 0)).toExponential(6)}`);
      }
    }
  } else {
    lines.push(`* --- Shared PCB / Heatsink Thermal Chain Zth_board ---`);
    icNodes.push(`V(TBRD)={T_amb}`);
    for (let k = 0; k < brd.length; k++) {
      const left = k === 0 ? 'TBRD' : `BRD_${k}`;
      const right = k === brd.length - 1 ? 'TAMB' : `BRD_${k + 1}`;
      if (k < brd.length - 1) icNodes.push(`V(BRD_${k + 1})={T_amb}`);
      lines.push(`C_BRD_${k + 1} ${left} 0 ${brd[k].c.toExponential(6)}`);
      lines.push(`R_BRD_${k + 1} ${left} ${right} ${brd[k].r.toExponential(6)}`);
    }
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

  const topoMode: FocThermalTopologyMode = expectedModel?.thermalTopologyMode ?? (
    ress.some((r) => r.n1.startsWith('PCB_') || r.n2.startsWith('PCB_'))
      ? 'pcb_spatial_coupled'
      : ress.some((r) => r.n1.startsWith('TBRD_'))
      ? 'independent'
      : 'shared_board'
  );

  const errors: string[] = [];
  const has7Ports = Boolean(
    subcktLine && /\bQ1\b\s+\bQ2\b\s+\bQ3\b\s+\bQ4\b\s+\bQ5\b\s+\bQ6\b\s+\bTAMB\b/i.test(subcktLine)
  );
  if (!has7Ports) errors.push('Missing required 7 ports (Q1 Q2 Q3 Q4 Q5 Q6 TAMB) on .subckt line.');

  const allCapsGroundedTo0 = caps.length > 0 && caps.every((c) => c.n2 === '0');
  if (!allCapsGroundedTo0) errors.push('All capacitors must connect to global ground node 0.');

  const noCapOnTamb = caps.every((c) => c.n1 !== 'TAMB' && c.n2 !== 'TAMB');
  if (!noCapOnTamb) errors.push('Capacitor attached directly to TAMB would be shorted.');

  const hasSharedBoardNode =
    topoMode === 'independent'
      ? MOS_SWITCH_KEYS.every((k) => ress.some((r) => r.n2 === `TBRD_${k}` || r.n1 === `TBRD_${k}`))
      : ress.some((r) => r.n2 === 'TBRD') && ress.some((r) => r.n1 === 'TBRD');
  if (!hasSharedBoardNode) errors.push('Required board/PCB coupling nodes missing in netlist.');

  const requiredIc =
    topoMode === 'independent'
      ? ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', ...MOS_SWITCH_KEYS.map((k) => `TBRD_${k}`)]
      : topoMode === 'pcb_spatial_coupled'
      ? ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'TBRD', ...MOS_SWITCH_KEYS.map((k) => `PCB_${k}`)]
      : ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'TBRD'];
  const hasDefensiveIc = requiredIc.every((nd) => new RegExp(`V\\(${nd}\\)\\s*=`, 'i').test(icText));
  if (!hasDefensiveIc) errors.push('Missing .ic on one or more MOSFET/board/PCB nodes.');

  const allValsPositive =
    ress.length > 0 &&
    caps.length > 0 &&
    ress.every((r) => Number.isFinite(r.val) && r.val > 0) &&
    caps.every((c) => Number.isFinite(c.val) && c.val > 0);
  if (!allValsPositive) errors.push('One or more netlist R/C values are non-positive or unparseable.');

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

      const rhsCm = new Float64Array(nNodes);
      for (let m = 1; m <= 6; m++) rhsCm[nodeIndex.get(`Q${m}`)!] = 1.0;
      const solCm = solveLinearSystem(G, rhsCm);

      const rhsOne = new Float64Array(nNodes);
      rhsOne[nodeIndex.get('Q1')!] = 1.0;
      const solOne = solveLinearSystem(G, rhsOne);

      if (solCm && solOne) {
        if (topoMode === 'shared_board') {
          const tBrdCm = solCm[nodeIndex.get('TBRD')!];
          const rBrdCm = tBrdCm / 6;
          const rJcArms = [1, 2, 3, 4, 5, 6].map((m) => solCm[nodeIndex.get(`Q${m}`)!] - tBrdCm);
          const rJcMean = rJcArms.reduce((a, b) => a + b, 0) / 6;
          const tQ1One = solOne[nodeIndex.get('Q1')!];
          const tBrdOne = solOne[nodeIndex.get('TBRD')!];
          const oneArmErr = Math.abs(tQ1One - (rJcArms[0] + rBrdCm)) + Math.abs(tBrdOne - rBrdCm);
          rJcParsed = rJcMean;
          rBrdParsed = rBrdCm;
          let expectedErr = 0;
          let armMismatch = 0;
          if (expectedModel) {
            const armExps = buildPerSwitchJcChains(expectedModel).map((chain) => chain.reduce((s, c) => s + c.r, 0));
            for (let m = 0; m < 6; m++) {
              armMismatch = Math.max(armMismatch, Math.abs(rJcArms[m] - armExps[m]) / Math.max(1e-6, armExps[m]));
            }
            const brdExp = (expectedModel.zthBoard.length > 0 ? expectedModel.zthBoard : DEFAULT_FOC_MODEL.zthBoard).reduce((s, c) => s + c.r, 0);
            expectedErr = armMismatch + Math.abs(rBrdParsed - brdExp) / Math.max(1e-6, brdExp);
          } else {
            armMismatch = Math.max(...rJcArms.map((v) => Math.abs(v - rJcMean)));
          }
          dcCommonModeError = armMismatch + oneArmErr;
          if (armMismatch <= 1e-3 && oneArmErr <= 1e-4 && expectedErr <= 1e-3) {
            nodalMathVerified = true;
          } else {
            errors.push(`Nodal DC matrix verification mismatch (err=${dcCommonModeError.toExponential(2)}).`);
          }
        } else if (topoMode === 'pcb_spatial_coupled') {
          const tBrdCm = solCm[nodeIndex.get('TBRD')!];
          const rBrdCm = tBrdCm / 6;
          const rJcArms = MOS_SWITCH_KEYS.map((k, m) => solCm[nodeIndex.get(`Q${m + 1}`)!] - solCm[nodeIndex.get(`PCB_${k}`)!]);
          const rJcMean = rJcArms.reduce((a, b) => a + b, 0) / 6;
          // Verify lateral coupling: heating Q1 must induce nonzero rise at PCB_BH via lateral/board matrix, and DC reciprocity holds
          const tPcbBhOne = solOne[nodeIndex.get('PCB_BH')!];
          const rhsTwo = new Float64Array(nNodes);
          rhsTwo[nodeIndex.get('Q3')!] = 1.0;
          const solTwo = solveLinearSystem(G, rhsTwo);
          const recipErr = solTwo ? Math.abs(solOne[nodeIndex.get('Q3')!] - solTwo[nodeIndex.get('Q1')!]) : 1;
          rJcParsed = rJcMean;
          rBrdParsed = rBrdCm;
          dcCommonModeError = recipErr;
          if (tPcbBhOne > 0 && recipErr <= 1e-6) {
            nodalMathVerified = true;
          } else {
            errors.push(`Spatial PCB netlist failed passivity/reciprocity check (recipErr=${recipErr.toExponential(2)}).`);
          }
        } else {
          // Independent: heating Q1 must cause zero rise at Q3
          const rJcArms = MOS_SWITCH_KEYS.map((k, m) => solCm[nodeIndex.get(`Q${m + 1}`)!] - solCm[nodeIndex.get(`TBRD_${k}`)!]);
          rJcParsed = rJcArms.reduce((a, b) => a + b, 0) / 6;
          rBrdParsed = solCm[nodeIndex.get('TBRD_AH')!] / 6;
          const crossLeak = Math.abs(solOne[nodeIndex.get('Q3')!]);
          dcCommonModeError = crossLeak;
          if (crossLeak <= 1e-9) {
            nodalMathVerified = true;
          } else {
            errors.push(`Independent netlist has unexpected thermal cross-leakage (${crossLeak.toExponential(2)}).`);
          }
        }
      } else {
        errors.push('Parsed SPICE resistance matrix is singular or disconnected.');
      }
    } else {
      errors.push('Parsed netlist is missing required junction/board/PCB nodes.');
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
function computeDutyFromVoltageAngle(
  thetaV: number,
  modulation: FocModulationMode,
  modDepthM: number
): { da: number; db: number; dc: number; overmodulated: boolean; linearCeilingM: number } {
  const linearCeilingM = getModulationLinearCeiling(modulation);
  const reqM = Math.max(0, modDepthM);
  if (reqM <= 1e-6) {
    return { da: 0.5, db: 0.5, dc: 0.5, overmodulated: false, linearCeilingM };
  }
  const m = Math.min(1.2, reqM);
  const twoPi3 = (2 * Math.PI) / 3;
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
  const overmodulated = reqM > linearCeilingM + 1e-6 ||
    rawA < -1e-6 || rawA > 1 + 1e-6 ||
    rawB < -1e-6 || rawB > 1 + 1e-6 ||
    rawC < -1e-6 || rawC > 1 + 1e-6;
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  return { da: clamp01(rawA), db: clamp01(rawB), dc: clamp01(rawC), overmodulated, linearCeilingM };
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
  const sqrt3Inv = 1 / Math.sqrt(3);
  const iAlpha = (2 / 3) * (ia - 0.5 * (ib + ic));
  const iBeta = (ib - ic) * sqrt3Inv;
  const mag = Math.hypot(iAlpha, iBeta);
  if (mag < 1e-6) {
    return { ...computeDutyFromVoltageAngle(0, modulation, modDepthM), zeroCurrentFallback: true };
  }
  const thetaI = Math.atan2(iBeta, iAlpha);
  const thetaV = thetaI + (pfAngleDeg * Math.PI) / 180;
  return { ...computeDutyFromVoltageAngle(thetaV, modulation, modDepthM), zeroCurrentFallback: false };
}

/**
 * Computes instantaneous per-MOS conduction, hard-switching + Qrr, and dead-time body-diode losses
 * for one half-bridge phase (H = upper switch, L = lower switch), conserving high + low + dead-time period.
 */
/** Enforce one consistent energy boundary for datasheet Qr and separate Eoss. */
export function validateMosEnergyAccounting(mos: FocMosParams): void {
  if (mos.qrrReferenceVdsV !== undefined && (!Number.isFinite(mos.qrrReferenceVdsV) || mos.qrrReferenceVdsV <= 0)) {
    throw new Error('Qr/Qrr 参考测试 VDS 必须为有限正数。');
  }
  if (mos.qrrReferenceDiDtAperUs !== undefined && (!Number.isFinite(mos.qrrReferenceDiDtAperUs) || Math.abs(mos.qrrReferenceDiDtAperUs) <= 0 || Math.abs(mos.qrrReferenceDiDtAperUs) > 1e5)) {
    throw new Error('Qr/Qrr 参考 di/dt 必须为有限非零数值，单位 A/µs。');
  }
  if (mos.qrrReferenceTjC !== undefined && (!Number.isFinite(mos.qrrReferenceTjC) || mos.qrrReferenceTjC < -100 || mos.qrrReferenceTjC > 250)) {
    throw new Error('Qr/Qrr 参考结温必须位于 -100～250°C。');
  }
  if (mos.qrrReferenceVgsV !== undefined && (!Number.isFinite(mos.qrrReferenceVgsV) || mos.qrrReferenceVgsV < -20 || mos.qrrReferenceVgsV > 20)) {
    throw new Error('Qr/Qrr 参考测试 VGS 必须位于 -20～20V。');
  }
  const qrrIsActive = !mos.dptLut?.length && mos.qrrNc > 0 && mos.eonIncludesQrr !== true;
  const separateEossIsActive = mos.eossAlreadyIncludedInEsw !== true &&
    (Boolean(mos.eossCurve) || (mos.eossUj ?? 0) > 0);
  if (mos.qrrIncludesQoss === true && qrrIsActive && separateEossIsActive) {
    throw new Error(
      '当前 Qr 数据已包含 Qoss/电容性恢复；不能在同一标量换流能量账本中再独立叠加 Eoss。请清空 Eoss/曲线，或使用明确分离 Qs、Qoss 与互补管 Eoss 的 DPT 事件能量模型。'
    );
  }
}

function qossCoveredByQr(mos: FocMosParams): boolean {
  return !mos.dptLut?.length && mos.qrrIncludesQoss === true && mos.qrrNc > 0 && mos.eonIncludesQrr !== true;
}

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
  pHighCond25W: number;
  pLowCond25W: number;
  pHighSw: number;
  pLowSw: number;
  pHighDead: number;
  pLowDead: number;
  lutStatus?: DptLutStatus;
  lutActiveDims?: DptAxisName[];
  lutCollapsedDims?: DptAxisName[];
  lutExtrapolated?: boolean;
  lutTjProvenance?: DptParameterProvenance;
  lutRgProvenance?: DptParameterProvenance;
  eossOutOfRange?: boolean;
} {
  if (!Number.isFinite(iPhase)) throw new Error('相电流必须为有限数值。');
  if (!Number.isFinite(dutyHigh) || dutyHigh < 0 || dutyHigh > 1) {
    throw new Error(`PWM 高侧占空比必须位于 0～1，当前值=${String(dutyHigh)}。`);
  }
  if (!Number.isFinite(vBus) || vBus < 0) throw new Error('母线电压必须为有限非负数值。');
  if (!Number.isFinite(tjHighC) || !Number.isFinite(tjLowC)) throw new Error('上下管结温必须为有限数值。');
  if (!Number.isFinite(fswHz) || fswHz < 0 || fswHz > 5e6) throw new Error('PWM 频率必须为 0～5 MHz 的有限数值。');
  if (!Number.isFinite(tDeadNs) || tDeadNs < 0 || tDeadNs > 1e6) throw new Error('死区时间必须为 0～1,000,000 ns 的有限数值。');
  if (!Number.isFinite(mos.rdsOn25Mohm) || mos.rdsOn25Mohm <= 0) throw new Error('MOS Rds(on)@25°C 必须为有限正数。');
  if (!Number.isFinite(mos.vsdV) || mos.vsdV < 0 || mos.vsdV > 10) throw new Error('MOS 体二极管压降 Vsd 必须为 0～10 V 的有限数值。');
  if (!mos.rdsOnTempCurve && (!Number.isFinite(mos.tempCoeffAlphaPerC) || mos.tempCoeffAlphaPerC < 0 || mos.tempCoeffAlphaPerC > 0.05)) throw new Error('MOS Rds 温度系数 α 必须为 0～0.05 /°C 的有限数值。');
  if (!Number.isFinite(mos.vRefV) || mos.vRefV <= 0 || !Number.isFinite(mos.iRefA) || mos.iRefA <= 0) {
    throw new Error('Eon/Eoff 参考电压 Vref 和参考电流 Iref 必须为有限正数。');
  }
  if (mos.qrrIrefA !== undefined && (!Number.isFinite(mos.qrrIrefA) || mos.qrrIrefA <= 0)) {
    throw new Error('Qr/Qrr 独立参考电流 qrrIrefA 必须为有限正数。');
  }
  validateMosEnergyAccounting(mos);
  if (!Number.isFinite(mos.eonPlusEoffUj) || mos.eonPlusEoffUj < 0 ||
      !Number.isFinite(mos.qrrNc) || mos.qrrNc < 0 ||
      (mos.eossUj !== undefined && (!Number.isFinite(mos.eossUj) || mos.eossUj < 0))) {
    throw new Error('Eon+Eoff、Qrr 和 Eoss 必须为有限非负数值。');
  }
  const d = dutyHigh;
  const r25 = Math.max(1e-6, mos.rdsOn25Mohm * 1e-3);
  const rdsFactorHigh = getFocMosRdsFactorAtTj(mos, tjHighC);
  const rdsFactorLow = getFocMosRdsFactorAtTj(mos, tjLowC);
  const ronH = Math.max(1e-6, r25 * rdsFactorHigh);
  const ronL = Math.max(1e-6, r25 * rdsFactorLow);

  // PWM command duty is reduced by one dead-time interval at each active edge:
  // D_H,cond = d - t_dead*fsw; D_L,cond = (1-d) - t_dead*fsw.
  // Both dead-time intervals are carried by the same body diode for a given
  // current direction (low-side diode for positive phase current, high-side for
  // negative current). Do not subtract the full 2*t_dead*fsw from only one
  // channel: that preserves total leg loss but biases the individual MOS losses.
  // Only a mathematically clamped leg (0% or 100% within floating-point noise)
  // is treated as having no recurring PWM edges. A small but non-zero pulse is
  // still a real command and must be checked against the dead-time/min-pulse limit.
  const staticDutyClamp = d <= 1e-12 || d >= 1 - 1e-12;
  const tDeadSec = tDeadNs * 1e-9;
  const requestedDeadEdgeDuty = fswHz > 0 ? tDeadSec * fswHz : 0;
  // If a commanded pulse is no wider than one dead-time interval, the actual
  // result depends on MCU pulse deletion / dead-time compensation behavior. Do
  // not guess that behavior in a steady average model: reject this point and
  // require the real PWM/gate timing or a valid minimum-pulse constraint.
  if (!staticDutyClamp && requestedDeadEdgeDuty > 0 &&
      (d <= requestedDeadEdgeDuty || (1 - d) <= requestedDeadEdgeDuty)) {
    throw new Error(
      `PWM 指令脉冲宽度不足：duty=${d.toFixed(6)}，单边死区占空比=${requestedDeadEdgeDuty.toFixed(6)}。` +
      '当前平均损耗模型无法判断 MCU/驱动器的窄脉冲删除与死区补偿行为，拒绝输出单管损耗/结温；请确认实际 PWM 最小脉宽或导入实测 duty/gate 波形。'
    );
  }
  const deadEdgeDuty = staticDutyClamp ? 0 : requestedDeadEdgeDuty;
  const deadDuty = 2 * deadEdgeDuty;

  const highCondDuty = staticDutyClamp ? d : Math.max(0, d - deadEdgeDuty);
  const lowCondDuty = staticDutyClamp ? 1 - d : Math.max(0, 1 - d - deadEdgeDuty);

  const iSq = iPhase * iPhase;
  const pHighCond = iSq * ronH * highCondDuty;
  const pLowCond = iSq * ronL * lowCondDuty;
  const pHighCond25W = iSq * r25 * highCondDuty;
  const pLowCond25W = iSq * r25 * lowCondDuty;

  let pSw = 0;
  let pDead = 0;
  let lutStatus: DptLutStatus | undefined;
  let lutActiveDims: DptAxisName[] | undefined;
  let lutCollapsedDims: DptAxisName[] | undefined;
  let lutExtrapolated: boolean | undefined;
  let lutTjProvenance: DptParameterProvenance | undefined;
  let lutRgProvenance: DptParameterProvenance | undefined;
  let eossOutOfRange = false;

  if (!staticDutyClamp && fswHz > 0) {
    const iAbs = Math.abs(iPhase);
    const vPos = Math.max(0, vBus);
    const vScale = vPos / Math.max(1e-3, mos.vRefV);
    const activeTjC = iPhase >= 0 ? tjHighC : tjLowC;
    const rgOnKnown = mos.rgOnOhm !== undefined && Number.isFinite(mos.rgOnOhm);
    const rgOffKnown = mos.rgOffOhm !== undefined && Number.isFinite(mos.rgOffOhm);
    const lutInterp =
      mos.dptLut && mos.dptLut.length > 0
        ? interpolateDptSwitchingLoss(mos.dptLut, {
            vBusV: vPos,
            iLoadA: iAbs,
            tjC: activeTjC,
            rgOnOhm: mos.rgOnOhm,
            rgOffOhm: mos.rgOffOhm,
            tjProvenance: 'model_estimated',
            // Rg is usable as a measured LUT coordinate only when both switching
            // directions have explicit finite inputs. A caller-supplied provenance
            // label must never turn a missing Rg value (which the interpolator would
            // otherwise replace with a LUT midpoint) into a measured condition.
            rgProvenance: rgOnKnown && rgOffKnown ? (mos.rgProvenance ?? 'assumed') : 'assumed',
          })
        : null;
    let eSwJ: number;
    let eQrrJ: number;
    if (lutInterp) {
      if (lutInterp.status !== 'VALID') {
        const details = lutInterp.warnings.join('；') || `DPT LUT 状态为 ${lutInterp.status}`;
        throw new Error(
          `MOS 热损耗计算已拒绝非有效 DPT 查询 (${lutInterp.status})：${details}。请补齐 Vbus/Iload/Tj/Rg 四维实测范围后重新计算。`
        );
      }
      if (lutInterp.rgProvenance === 'assumed' && lutInterp.activeDimensions.includes('Rg')) {
        throw new Error('DPT LUT 的 Rg 维度有变化，但当前运行没有明确的 Rg_on/Rg_off 实际输入；禁止使用 LUT 中值冒充实际驱动条件。');
      }
      lutStatus = lutInterp.status;
      lutActiveDims = lutInterp.activeDimensions;
      lutCollapsedDims = lutInterp.collapsedDimensions;
      lutExtrapolated = lutInterp.extrapolated;
      lutTjProvenance = lutInterp.tjProvenance;
      lutRgProvenance = lutInterp.rgProvenance;

      if (mos.eonIncludesQrr) {
        eSwJ = Math.max(0, lutInterp.eSwTotalUj) * 1e-6;
        eQrrJ = 0;
      } else {
        eSwJ = Math.max(0, lutInterp.eOnSansQrrUj + lutInterp.eOffUj) * 1e-6;
        eQrrJ = Math.max(0, lutInterp.qRrNc) * 1e-9 * vPos;
      }
    } else {
      const iScale = iAbs / Math.max(1e-3, mos.iRefA);
      eSwJ = Math.max(0, mos.eonPlusEoffUj) * 1e-6 * vScale * iScale;
      const qrrCurrentScale = iAbs / Math.max(1e-3, mos.qrrIrefA ?? mos.iRefA);
      eQrrJ = mos.eonIncludesQrr ? 0 : Math.max(0, mos.qrrNc) * 1e-9 * vPos * qrrCurrentScale;
    }

    let eOssJ = 0;
    if (!mos.eossAlreadyIncludedInEsw) {
      if (mos.eossCurve) {
        const evalRes = evaluateNonlinearEossUj(mos.eossCurve, vPos, { allowOutOfDomainClamp: false });
        eOssJ = Math.max(0, evalRes.eossUj) * 1e-6;
        eossOutOfRange = evalRes.outOfRange;
      } else {
        eOssJ = Math.max(0, mos.eossUj ?? 0) * 1e-6 * vScale * vScale;
      }
    }
    pSw = fswHz * (eSwJ + eQrrJ + eOssJ);
    pDead = iAbs * Math.max(0, mos.vsdV) * deadDuty;
  }

  let pHighSw = 0;
  let pLowSw = 0;
  let pHighDead = 0;
  let pLowDead = 0;

  if (iPhase >= 0) {
    pHighSw = pSw;
    pLowDead = pDead;
  } else {
    pLowSw = pSw;
    pHighDead = pDead;
  }

  return {
    pHighTotal: pHighCond + pHighSw + pHighDead,
    pLowTotal: pLowCond + pLowSw + pLowDead,
    pHighCond,
    pLowCond,
    pHighCond25W,
    pLowCond25W,
    pHighSw,
    pLowSw,
    pHighDead,
    pLowDead,
    lutStatus,
    lutActiveDims,
    lutCollapsedDims,
    lutExtrapolated,
    lutTjProvenance,
    lutRgProvenance,
    eossOutOfRange,
  };
}

/**
 * Exact O(6*Kj + Kb) Implicit Backward-Euler 6-MOS thermal solver supporting:
 * - 'shared_board': 6 ZthJC arms -> shared TBRD -> Zth_board -> TAMB
 * - 'pcb_spatial_coupled': 6 ZthJC arms -> 6 PCB zones (C_pcb, symmetric G_ij, R_vert) -> TBRD -> Zth_board -> TAMB
 * - 'independent': 6 independent ZthJC + Zth_board arms -> TAMB (zero mutual coupling)
 */
class StarCoupled6MosThermalSolver {
  private topoMode: FocThermalTopologyMode;
  private spatial: ResolvedSpatialNetwork;
  private armJcs: CauerStage[][]; // 6 x kj
  private brd: CauerStage[];
  private kj: number;
  private kb: number;
  private armT: Float64Array[]; // 6 x kj
  private pcbT: Float64Array; // 6 PCB zone temperatures
  private brdT: Float64Array; // kb shared board nodes
  private brdArmsT: Float64Array[]; // 6 x kb independent board nodes
  private tAmbC: number;
  private minTau: number;
  private maxSubDtOverTau: number = 0;

  private jcSubAll: Float64Array[];
  private jcDiagAll: Float64Array[];
  private jcSupAll: Float64Array[];
  private jcCPrimeAll: Float64Array[];
  private jcCkDtAll: Float64Array[];
  private jcDPrimesAll: Float64Array[];
  private jcGammaBoard: Float64Array;
  private jcGLast: Float64Array;
  private jcGArmEff: Float64Array;

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
    this.spatial = resolveSpatialThermalNetwork(model);
    this.topoMode = this.spatial.mode;
    this.armJcs = buildPerSwitchJcChains(model);
    this.brd = model.zthBoard.length > 0 ? model.zthBoard : DEFAULT_FOC_MODEL.zthBoard;
    this.kj = this.armJcs[0].length;
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
    this.pcbT = new Float64Array(6);
    for (let m = 0; m < 6; m++) {
      this.pcbT[m] =
        initialState?.pcbT && initialState.pcbT.length === 6 && Number.isFinite(initialState.pcbT[m])
          ? initialState.pcbT[m]
          : fallbackBrdT;
    }
    this.brdT = new Float64Array(this.kb);
    for (let k = 0; k < this.kb; k++) {
      this.brdT[k] =
        initialState?.brdT && initialState.brdT.length === this.kb && Number.isFinite(initialState.brdT[k])
          ? initialState.brdT[k]
          : fallbackBrdT;
    }
    this.brdArmsT = Array.from({ length: 6 }, (_, m) => {
      const arr = new Float64Array(this.kb);
      const src = initialState?.brdArmsT?.[m];
      for (let k = 0; k < this.kb; k++) {
        arr[k] = src && src.length === this.kb && Number.isFinite(src[k]) ? src[k] : this.brdT[k];
      }
      return arr;
    });

    let mt = Infinity;
    for (const s of [...this.armJcs.flat(), ...this.brd]) {
      const t = s.r * s.c;
      if (isFinite(t) && t > 1e-12 && t < mt) mt = t;
    }
    if (this.topoMode === 'pcb_spatial_coupled') {
      for (let m = 0; m < 6; m++) {
        let gSum = 1 / this.spatial.rVert[m];
        for (let j = 0; j < 6; j++) gSum += this.spatial.gLat[m][j];
        const tauPcb = this.spatial.cPcb[m] / Math.max(1e-9, gSum);
        if (isFinite(tauPcb) && tauPcb > 1e-12 && tauPcb < mt) mt = tauPcb;
      }
    }
    this.minTau = isFinite(mt) ? mt : 1e-4;

    this.jcSubAll = Array.from({ length: 6 }, () => new Float64Array(this.kj));
    this.jcDiagAll = Array.from({ length: 6 }, () => new Float64Array(this.kj));
    this.jcSupAll = Array.from({ length: 6 }, () => new Float64Array(this.kj));
    this.jcCPrimeAll = Array.from({ length: 6 }, () => new Float64Array(this.kj));
    this.jcCkDtAll = Array.from({ length: 6 }, () => new Float64Array(this.kj));
    this.jcDPrimesAll = Array.from({ length: 6 }, () => new Float64Array(this.kj));
    this.jcGammaBoard = new Float64Array(6);
    this.jcGLast = new Float64Array(6);
    this.jcGArmEff = new Float64Array(6);

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
    if (this.topoMode === 'pcb_spatial_coupled') {
      let s = 0;
      for (let m = 0; m < 6; m++) s += this.pcbT[m];
      return s / 6;
    }
    if (this.topoMode === 'independent') {
      let s = 0;
      for (let m = 0; m < 6; m++) s += this.brdArmsT[m][0];
      return s / 6;
    }
    return this.brdT[0];
  }

  public getBoardTempsBySwitch(): number[] {
    if (this.topoMode === 'pcb_spatial_coupled') return Array.from(this.pcbT);
    if (this.topoMode === 'independent') return this.brdArmsT.map((a) => a[0]);
    return new Array<number>(6).fill(this.brdT[0]);
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
      pcbT: this.topoMode === 'pcb_spatial_coupled' ? Array.from(this.pcbT) : undefined,
      brdT: Array.from(this.brdT),
      brdArmsT: this.topoMode === 'independent' ? this.brdArmsT.map((a) => Array.from(a)) : undefined,
      tBoardC: this.getBoardTemp(),
      tjMaxC: Math.max(...tj),
    };
  }

  public step(dt: number, powers: number[]): void {
    if (!Number.isFinite(dt) || dt < 0) throw new Error('热网络积分步长 dt 必须为有限非负秒数。');
    if (dt === 0) return;
    if (!Array.isArray(powers) || powers.length !== 6 || powers.some((p) => !Number.isFinite(p) || p < 0)) {
      throw new Error('六管热网络每一步必须提供 6 个有限非负 MOS 损耗功率；拒绝把 NaN/负功率静默替换为 0。');
    }
    const targetSubDt = Math.max(1e-8, 0.05 * this.minTau);
    const subSteps = Math.max(1, Math.min(4096, Math.ceil(dt / targetSubDt)));
    const subDt = dt / subSteps;
    if (this.minTau > 0) {
      const ratio = subDt / this.minTau;
      if (ratio > this.maxSubDtOverTau) this.maxSubDtOverTau = ratio;
    }

    const kj = this.kj;
    const kb = this.kb;

    // Factor each MOSFET JC arm matrix
    let gArms = 0;
    for (let m = 0; m < 6; m++) {
      const jc = this.armJcs[m];
      const sub = this.jcSubAll[m];
      const diag = this.jcDiagAll[m];
      const sup = this.jcSupAll[m];
      const cp = this.jcCPrimeAll[m];
      const ckDt = this.jcCkDtAll[m];

      for (let k = 0; k < kj; k++) {
        ckDt[k] = jc[k].c / subDt;
        const gL = k > 0 ? 1 / jc[k - 1].r : 0;
        const gR = 1 / jc[k].r;
        sub[k] = k > 0 ? -gL : 0;
        diag[k] = ckDt[k] + gL + gR;
        sup[k] = k < kj - 1 ? -gR : 0;
      }
      cp[0] = kj > 1 ? sup[0] / diag[0] : 0;
      let lastDenomJc = diag[0];
      for (let k = 1; k < kj; k++) {
        const denom = diag[k] - sub[k] * cp[k - 1];
        cp[k] = k < kj - 1 ? sup[k] / denom : 0;
        if (k === kj - 1) lastDenomJc = denom;
      }
      const gJcLast = 1 / jc[kj - 1].r;
      const gammaBoard = gJcLast / lastDenomJc;
      this.jcGLast[m] = gJcLast;
      this.jcGammaBoard[m] = gammaBoard;
      this.jcGArmEff[m] = gJcLast * (1 - gammaBoard);
      gArms += this.jcGArmEff[m];
    }

    if (this.topoMode === 'independent') {
      // Solve each of the 6 independent ZthJC + ZthBoard_m arms separately (G_ij = 0)
      const gVert = this.spatial.rVert.map((rv) => 1 / rv);
      for (let m = 0; m < 6; m++) {
        const brdSubM = new Float64Array(kb);
        const brdDiagM = new Float64Array(kb);
        const brdSupM = new Float64Array(kb);
        const brdCpM = new Float64Array(kb);
        const brdDpM = new Float64Array(kb);
        const brdRhsM = new Float64Array(kb);
        const brdCkDtM = new Float64Array(kb);
        for (let k = 0; k < kb; k++) {
          const rk = this.brd[k].r * 6 + (k === 0 ? this.spatial.rVert[m] : 0);
          const ck = k === 0 ? this.spatial.cPcb[m] : this.brd[k].c / 6;
          brdCkDtM[k] = ck / subDt;
          const gL = k > 0 ? 1 / (this.brd[k - 1].r * 6 + (k - 1 === 0 ? this.spatial.rVert[m] : 0)) : 0;
          const gR = 1 / rk;
          brdSubM[k] = k > 0 ? -gL : 0;
          brdDiagM[k] = brdCkDtM[k] + gL + gR + (k === 0 ? this.jcGArmEff[m] : 0);
          brdSupM[k] = k < kb - 1 ? -gR : 0;
        }
        brdCpM[0] = kb > 1 ? brdSupM[0] / brdDiagM[0] : 0;
        for (let k = 1; k < kb; k++) {
          const denom = brdDiagM[k] - brdSubM[k] * brdCpM[k - 1];
          brdCpM[k] = k < kb - 1 ? brdSupM[k] / denom : 0;
        }
        const gLastM = 1 / (this.brd[kb - 1].r * 6 + (kb - 1 === 0 ? this.spatial.rVert[m] : 0));
        const ambRhsM = this.tAmbC * gLastM;
        void gVert;

        const arm = this.armT[m];
        const dp = this.jcDPrimesAll[m];
        const subM = this.jcSubAll[m];
        const diagM = this.jcDiagAll[m];
        const cpM = this.jcCPrimeAll[m];
        const ckDtM = this.jcCkDtAll[m];
        const brdArm = this.brdArmsT[m];

        for (let sub = 0; sub < subSteps; sub++) {
          dp[0] = (ckDtM[0] * arm[0] + (powers[m] || 0)) / diagM[0];
          for (let k = 1; k < kj; k++) {
            const denom = diagM[k] - subM[k] * cpM[k - 1];
            dp[k] = (ckDtM[k] * arm[k] - subM[k] * dp[k - 1]) / denom;
          }
          const pArm = this.jcGLast[m] * dp[kj - 1];
          for (let k = 0; k < kb; k++) {
            brdRhsM[k] = brdCkDtM[k] * brdArm[k] + (k === 0 ? pArm : 0) + (k === kb - 1 ? ambRhsM : 0);
          }
          brdDpM[0] = brdRhsM[0] / brdDiagM[0];
          for (let k = 1; k < kb; k++) {
            const denom = brdDiagM[k] - brdSubM[k] * brdCpM[k - 1];
            brdDpM[k] = (brdRhsM[k] - brdSubM[k] * brdDpM[k - 1]) / denom;
          }
          brdArm[kb - 1] = brdDpM[kb - 1];
          for (let k = kb - 2; k >= 0; k--) {
            brdArm[k] = brdDpM[k] - brdCpM[k] * brdArm[k + 1];
          }
          arm[kj - 1] = dp[kj - 1] + this.jcGammaBoard[m] * brdArm[0];
          for (let k = kj - 2; k >= 0; k--) {
            arm[k] = dp[k] - cpM[k] * arm[k + 1];
          }
        }
      }
      return;
    }

    if (this.topoMode === 'pcb_spatial_coupled') {
      // Backward Schur elimination of board chain T_brd[1..kb-1] into T_brd[0],
      // then exact 6x6 symmetric linear system for PCB zones PCB_0..PCB_5
      const gVert = new Float64Array(6);
      let gVertSum = 0;
      for (let m = 0; m < 6; m++) {
        gVert[m] = 1 / this.spatial.rVert[m];
        gVertSum += gVert[m];
      }
      const brdCkDt = new Float64Array(kb);
      const uBrd = new Float64Array(kb);
      const invDenBrd = new Float64Array(kb);
      for (let k = kb - 1; k >= 0; k--) {
        brdCkDt[k] = this.brd[k].c / subDt;
        const gL = k > 0 ? 1 / this.brd[k - 1].r : 0;
        const gR = 1 / this.brd[k].r;
        const gNextEff = k < kb - 1 ? gR * (1 - uBrd[k + 1]) : gR;
        const diagK = brdCkDt[k] + gL + gNextEff + (k === 0 ? gVertSum : 0);
        invDenBrd[k] = 1 / diagK;
        uBrd[k] = k > 0 ? gL * invDenBrd[k] : 0;
      }

      // Build 6x6 SPD conductance+capacitance matrix M6 for PCB_0..PCB_5
      const M6 = Array.from({ length: 6 }, () => new Float64Array(6));
      for (let i = 0; i < 6; i++) {
        let latRowSum = 0;
        for (let j = 0; j < 6; j++) {
          if (i !== j) latRowSum += this.spatial.gLat[i][j];
        }
        const cOverDt = this.spatial.cPcb[i] / subDt;
        M6[i][i] = cOverDt + gVert[i] + latRowSum + this.jcGArmEff[i] - gVert[i] * gVert[i] * invDenBrd[0];
        for (let j = 0; j < 6; j++) {
          if (i !== j) {
            M6[i][j] = -this.spatial.gLat[i][j] - gVert[i] * gVert[j] * invDenBrd[0];
          }
        }
      }

      const gBrdLast = 1 / this.brd[kb - 1].r;
      const ambTerm = this.tAmbC * gBrdLast;
      const vBrd = new Float64Array(kb);
      const rhs6 = new Float64Array(6);
      const pArmsVec = new Float64Array(6);

      for (let sub = 0; sub < subSteps; sub++) {
        for (let m = 0; m < 6; m++) {
          const arm = this.armT[m];
          const dp = this.jcDPrimesAll[m];
          const subM = this.jcSubAll[m];
          const diagM = this.jcDiagAll[m];
          const cpM = this.jcCPrimeAll[m];
          const ckDtM = this.jcCkDtAll[m];

          dp[0] = (ckDtM[0] * arm[0] + (powers[m] || 0)) / diagM[0];
          for (let k = 1; k < kj; k++) {
            const denom = diagM[k] - subM[k] * cpM[k - 1];
            dp[k] = (ckDtM[k] * arm[k] - subM[k] * dp[k - 1]) / denom;
          }
          pArmsVec[m] = this.jcGLast[m] * dp[kj - 1];
        }

        // Backward sweep for vBrd[kb-1..0]
        for (let k = kb - 1; k >= 0; k--) {
          const gR = 1 / this.brd[k].r;
          const rhsK =
            brdCkDt[k] * this.brdT[k] +
            (k === kb - 1 ? ambTerm : gR * vBrd[k + 1]);
          vBrd[k] = rhsK * invDenBrd[k];
        }
        const offsetBrd0 = vBrd[0];

        for (let i = 0; i < 6; i++) {
          rhs6[i] = (this.spatial.cPcb[i] / subDt) * this.pcbT[i] + pArmsVec[i] + gVert[i] * offsetBrd0;
        }
        const nextPcb = solveLinearSystem(M6, rhs6);
        if (!nextPcb) {
          throw new Error('PCB 空间热耦合矩阵求解奇异，请检查 PCB 热阻/热容设置。');
        }
        let pcbVertFlux = 0;
        for (let m = 0; m < 6; m++) {
          this.pcbT[m] = nextPcb[m];
          pcbVertFlux += gVert[m] * nextPcb[m];
        }
        this.brdT[0] = offsetBrd0 + pcbVertFlux * invDenBrd[0];
        for (let k = 1; k < kb; k++) {
          this.brdT[k] = vBrd[k] + uBrd[k] * this.brdT[k - 1];
        }
        for (let m = 0; m < 6; m++) {
          const arm = this.armT[m];
          const dp = this.jcDPrimesAll[m];
          const cpM = this.jcCPrimeAll[m];
          arm[kj - 1] = dp[kj - 1] + this.jcGammaBoard[m] * this.pcbT[m];
          for (let k = kj - 2; k >= 0; k--) {
            arm[k] = dp[k] - cpM[k] * arm[k + 1];
          }
        }
      }
      return;
    }

    // Default 'shared_board': Factor Zth_board matrix including Schur coupling gArms on node 0 (TBRD)
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
      let pArms = 0;
      for (let m = 0; m < 6; m++) {
        const arm = this.armT[m];
        const dp = this.jcDPrimesAll[m];
        const subM = this.jcSubAll[m];
        const diagM = this.jcDiagAll[m];
        const cpM = this.jcCPrimeAll[m];
        const ckDtM = this.jcCkDtAll[m];

        const r0 = ckDtM[0] * arm[0] + (powers[m] || 0);
        dp[0] = r0 / diagM[0];
        for (let k = 1; k < kj; k++) {
          const rk = ckDtM[k] * arm[k];
          const denom = diagM[k] - subM[k] * cpM[k - 1];
          dp[k] = (rk - subM[k] * dp[k - 1]) / denom;
        }
        pArms += this.jcGLast[m] * dp[kj - 1];
      }

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
        const cpM = this.jcCPrimeAll[m];
        arm[kj - 1] = dp[kj - 1] + this.jcGammaBoard[m] * tBrd0;
        for (let k = kj - 2; k >= 0; k--) {
          arm[k] = dp[k] - cpM[k] * arm[k + 1];
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
  /** Optional nonlinear per-switch Rds(Tj)/Rds25 factor; when supplied, supersedes alphaPerC. */
  evalCondFactorAtTj?: (tjVec: number[]) => number[];
  rJcTotalByArm: number[];
  rBrdTotal: number;
  tAmbC: number;
  tInitSeedC?: number[];
  spatial?: ResolvedSpatialNetwork;
  evalFixedPowerAtTj?: (tjVec: number[]) => number[] | null;
}): {
  tBoardSteadyC: number;
  tBoardSteadyByKey: number[];
  tjSteadyC: number[];
  converged: boolean;
  thermalRunaway: boolean;
} {
  const { pCond25W, pFixedW, alphaPerC, evalCondFactorAtTj, rJcTotalByArm, rBrdTotal, tAmbC, tInitSeedC, spatial, evalFixedPowerAtTj } = params;
  const kArm = pCond25W.map((p25) => alphaPerC * p25);
  const p0Arm = pCond25W.map((p25, m) => pFixedW[m] + p25 * (1 - 25 * alphaPerC));
  const useNonShared = Boolean(spatial && spatial.mode !== 'shared_board');
  const hasTjSwCoupling = Boolean(evalFixedPowerAtTj);

  if (!useNonShared && !hasTjSwCoupling && !evalCondFactorAtTj) {
    const armStable = kArm.every((km, m) => 1 - rJcTotalByArm[m] * km > 1e-6);
    let gLoop = Infinity;
    let analyticOk = false;
    let analyticBrd = tAmbC;
    const analyticTj = new Array<number>(6).fill(tAmbC);

    if (armStable) {
      let sumKOverDen = 0;
      let sumP0OverDen = 0;
      for (let m = 0; m < 6; m++) {
        const den = 1 - rJcTotalByArm[m] * kArm[m];
        sumKOverDen += kArm[m] / den;
        sumP0OverDen += p0Arm[m] / den;
      }
      gLoop = rBrdTotal * sumKOverDen;
      if (gLoop < 1 - 1e-6) {
        analyticBrd = (tAmbC + rBrdTotal * sumP0OverDen) / (1 - gLoop);
        let allInsidePiecewiseLinear = Number.isFinite(analyticBrd) && analyticBrd <= 2000;
        for (let m = 0; m < 6; m++) {
          const den = 1 - rJcTotalByArm[m] * kArm[m];
          const tm = (analyticBrd + rJcTotalByArm[m] * p0Arm[m]) / den;
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
        tBoardSteadyByKey: new Array<number>(6).fill(analyticBrd),
        tjSteadyC: analyticTj,
        converged: true,
        thermalRunaway: false,
      };
    }
  }

  // Build steady-state board/PCB conductance matrix G_steady (7x7 for pcb_spatial_coupled: PCB0..5 + TBRD, or independent diag)
  const gBrdTot = 1 / Math.max(1e-6, rBrdTotal);
  let gSpatialMat: Float64Array[] | null = null;
  if (spatial && spatial.mode === 'pcb_spatial_coupled') {
    gSpatialMat = Array.from({ length: 7 }, () => new Float64Array(7));
    let gVertSum = 0;
    for (let i = 0; i < 6; i++) {
      const gv = 1 / spatial.rVert[i];
      gVertSum += gv;
      let latSum = 0;
      for (let j = 0; j < 6; j++) {
        if (i !== j) {
          const gij = spatial.gLat[i][j];
          latSum += gij;
          gSpatialMat[i][j] = -gij;
        }
      }
      gSpatialMat[i][i] = gv + latSum;
      gSpatialMat[i][6] = -gv;
      gSpatialMat[6][i] = -gv;
    }
    gSpatialMat[6][6] = gVertSum + gBrdTot;
  }

  const tjVec = tInitSeedC ? [...tInitSeedC] : new Array<number>(6).fill(tAmbC + 10);
  let tBrdByKey = new Array<number>(6).fill(tAmbC);
  let tBrd = tAmbC;
  let converged = false;
  let runaway = false;

  for (let it = 0; it < 160; it++) {
    const dynFixed = evalFixedPowerAtTj ? evalFixedPowerAtTj(tjVec) : null;
    const pArm = new Array<number>(6);
    let pSum = 0;
    const condFactors = evalCondFactorAtTj ? evalCondFactorAtTj(tjVec) : null;
    if (condFactors && (condFactors.length !== 6 || condFactors.some((v) => !Number.isFinite(v) || v < 0.05 || v > 10))) {
      throw new Error('Rds(Tj) 曲线反馈必须返回六个 0.05～10 的有限正数系数。');
    }
    for (let m = 0; m < 6; m++) {
      const rFactor = condFactors ? condFactors[m] : Math.max(0.1, 1 + alphaPerC * (tjVec[m] - 25));
      const pF = dynFixed ? dynFixed[m] : pFixedW[m];
      pArm[m] = pF + pCond25W[m] * rFactor;
      pSum += pArm[m];
    }

    let maxDelta = 0;
    if (spatial?.mode === 'pcb_spatial_coupled' && gSpatialMat) {
      const rhs7 = new Float64Array(7);
      for (let m = 0; m < 6; m++) rhs7[m] = pArm[m];
      rhs7[6] = gBrdTot * tAmbC;
      // Add tAmbC * gVert to keep affine ref exact? No: G * (T - tAmbC) = P => G * dT = P with rhs7[6] = 0!
      rhs7[6] = 0;
      const dT7 = solveLinearSystem(gSpatialMat, rhs7);
      if (!dT7) {
        runaway = true;
        break;
      }
      let brdSum = 0;
      const nextPcb: number[] = new Array(6);
      for (let m = 0; m < 6; m++) {
        nextPcb[m] = Math.min(2000, Math.max(-50, tAmbC + dT7[m]));
        maxDelta = Math.max(maxDelta, Math.abs(nextPcb[m] - tBrdByKey[m]));
        tBrdByKey[m] = nextPcb[m];
        brdSum += nextPcb[m];
      }
      tBrd = brdSum / 6;
    } else if (spatial?.mode === 'independent') {
      let brdSum = 0;
      for (let m = 0; m < 6; m++) {
        const nextBm = Math.min(2000, Math.max(-50, tAmbC + pArm[m] * (rBrdTotal * 6 + spatial.rVert[m])));
        maxDelta = Math.max(maxDelta, Math.abs(nextBm - tBrdByKey[m]));
        tBrdByKey[m] = nextBm;
        brdSum += nextBm;
      }
      tBrd = brdSum / 6;
    } else {
      const nextBrd = Math.min(2000, Math.max(-50, tAmbC + pSum * rBrdTotal));
      maxDelta = Math.abs(nextBrd - tBrd);
      tBrd = nextBrd;
      tBrdByKey = new Array<number>(6).fill(tBrd);
    }

    for (let m = 0; m < 6; m++) {
      const candT = tBrdByKey[m] + pArm[m] * rJcTotalByArm[m];
      const nextT = Number.isFinite(candT) ? Math.min(2000, Math.max(-50, candT)) : 2000;
      maxDelta = Math.max(maxDelta, Math.abs(nextT - tjVec[m]));
      tjVec[m] = nextT;
    }
    if (tBrd >= 1999.9 || tjVec.some((v) => v >= 1999.9)) {
      runaway = true;
    }
    if (maxDelta < 1e-3 && !runaway) {
      converged = true;
      break;
    }
  }

  return {
    tBoardSteadyC: tBrd,
    tBoardSteadyByKey: tBrdByKey,
    tjSteadyC: tjVec,
    converged: converged && !runaway,
    thermalRunaway: runaway,
  };
}

/**
 * Fixed operating-point input for average-loss / steady-state thermal analysis.
 *
 * iqPeakA/idPeakA use the amplitude-invariant dq convention used by DynoLab.
 * For a rotating operating point, dq currents, Vbus, PWM and modulation are
 * treated as constant while electrical angle is integrated over one full cycle.
 * For a locked-rotor point, currents are evaluated at one fixed electrical angle.
 */
export interface FocSteadyOperatingPoint {
  iqPeakA: number;
  idPeakA?: number;
  electricalFrequencyHz: number;
  mode?: 'rotating' | 'locked_rotor';
  electricalAngleDeg?: number;
  /** Optional operating-point provenance copied from the DynoLab steady solver. */
  mechanicalSpeedRpm?: number;
  torqueNm?: number;
  mechanicalPowerW?: number;
  busInputPowerW?: number;
  dcLinkPowerW?: number;
  motorElectricalPowerW?: number;
  impliedInverterLossW?: number;
}

export interface FocSteadyMosResult {
  key: MosSwitchKey;
  pCondW: number;
  pSwitchingW: number;
  pDeadTimeW: number;
  pTotalW: number;
  pCondAt25CW: number;
  tjSteadyC: number;
  boardSteadyC: number;
}

export interface FocSteadyStateResult {
  resultQualification: FocResultQualification;
  qualificationReasons: string[];
  mode: 'rotating' | 'locked_rotor';
  iqPeakA: number;
  idPeakA: number;
  electricalFrequencyHz: number;
  pwmCyclesPerElectricalCycle: number | null;
  vBusConstV: number;
  modulation: FocModulationMode;
  modDepthM: number;
  pfAngleDeg: number;
  fswHz: number;
  tDeadNs: number;
  tAmbC: number;
  mechanicalSpeedRpm: number | null;
  torqueNm: number | null;
  mechanicalPowerW: number | null;
  busInputPowerW: number | null;
  dcLinkPowerW: number | null;
  motorElectricalPowerW: number | null;
  impliedInverterLossW: number | null;
  inverterLossBudgetMarginW: number | null;
  powerBalanceStatus: 'WITHIN_BUDGET' | 'EXCEEDS_BUDGET' | 'NOT_AVAILABLE';
  phaseCurrentPeakA: number;
  /** Null for locked-rotor DC phase currents; see phaseCurrentA for per-phase values. */
  phaseCurrentRmsA: number | null;
  phaseCurrentA: { a: number; b: number; c: number } | null;
  electricalAngleDeg: number | null;
  integrationSamples: number;
  integrationErrorPct: number | null;
  /** True when the rotating-cycle quadrature converged to <=0.2% between the last two resolutions. */
  integrationAccuracyMet: boolean;
  perSwitch: FocSteadyMosResult[];
  pCondTotalW: number;
  pSwitchingTotalW: number;
  pDeadTimeTotalW: number;
  pInverterTotalW: number;
  tBoardSteadyC: number;
  tjMaxSteadyC: number;
  hottestKey: MosSwitchKey;
  steadyConverged: boolean;
  thermalRunaway: boolean;
  dutyMin: number;
  dutyMax: number;
  warnings: string[];
}

export interface FocSteadyStateOptions {
  model: FocThermalModel;
  mos: FocMosParams;
  ctrl: FocControlParams;
  operatingPoint: FocSteadyOperatingPoint;
  /** Electrical-angle midpoint samples. Default 720; ignored for locked-rotor points. */
  integrationSamples?: number;
}

export type FocVoltageEnvelopeStatus =
  | 'CALCULATED'
  | 'VOLTAGE_LIMITED'
  | 'MODEL_OUT_OF_RANGE'
  | 'THERMAL_NOT_CONVERGED'
  | 'THERMAL_RUNAWAY'
  | 'INVALID_INPUT';

export interface FocVoltageEnvelopeRow {
  vBusV: number;
  requiredModDepthM: number;
  modulationCeiling: number;
  status: FocVoltageEnvelopeStatus;
  result: FocSteadyStateResult | null;
  note: string;
}

export interface FocVoltageEnvelopeOptions extends FocSteadyStateOptions {
  /** Bus-voltage cases to evaluate. Defaults to the user's 12-V vehicle range: 9 / 13.5 / 16 V. */
  voltagePoints?: number[];
  /** Bus voltage at which ctrl.modDepthM represents the requested motor fundamental voltage. Defaults to ctrl.vBusConstV. */
  referenceVoltageV?: number;
}

interface FocSteadyLossAverage {
  pCond25W: number[];
  pSwitchingW: number[];
  pDeadTimeW: number[];
  dutyMin: number;
  dutyMax: number;
  lutActiveDims: Set<DptAxisName>;
  lutCollapsedDims: Set<DptAxisName>;
  lutOutOfRangeCount: number;
}

function averageFocSteadyLosses(
  point: FocSteadyOperatingPoint,
  modelMode: 'rotating' | 'locked_rotor',
  sampleCount: number,
  electricalAngleDeg: number,
  mos: FocMosParams,
  ctrl: FocControlParams,
  tjBySwitch: number[]
): FocSteadyLossAverage {
  const sums = {
    cond25: new Float64Array(6),
    sw: new Float64Array(6),
    dead: new Float64Array(6),
  };
  const activeDims = new Set<DptAxisName>();
  const collapsedDims = new Set<DptAxisName>();
  let outOfRangeCount = 0;
  let dutyMin = 1;
  let dutyMax = 0;
  const n = modelMode === 'locked_rotor' ? 1 : sampleCount;
  const angle0 = (electricalAngleDeg * Math.PI) / 180;
  const root3 = Math.sqrt(3);
  const vBus = ctrl.vBusConstV;

  for (let k = 0; k < n; k++) {
    // Midpoint integration avoids double-counting the 0/2π boundary.
    const theta = modelMode === 'locked_rotor' ? angle0 : (2 * Math.PI * (k + 0.5)) / n;
    // Inverse amplitude-invariant Park/Clarke convention. At Id=0 and
    // theta=90°, this reproduces the existing DynoLab stall vector:
    // Ia=Iq, Ib=Ic=-Iq/2.
    const id = point.idPeakA ?? 0;
    const iq = point.iqPeakA;
    const iAlpha = id * Math.cos(theta) + iq * Math.sin(theta);
    const iBeta = id * Math.sin(theta) - iq * Math.cos(theta);
    const ia = iAlpha;
    const ib = -0.5 * iAlpha + (root3 / 2) * iBeta;
    const ic = -0.5 * iAlpha - (root3 / 2) * iBeta;

    // The generated three-phase set is balanced by construction; use the
    // stationary-frame current vector directly for the voltage/current angle.
    // A zero-current rotating point still has a commanded voltage vector (e.g. back-EMF
    // cancellation / field weakening). Do not let the generic current-angle fallback
    // silently force 50% duty and suppress Eoss/switching events.
    const thetaI = Math.hypot(iAlpha, iBeta) >= 1e-9
      ? Math.atan2(iBeta, iAlpha)
      : theta - Math.PI / 2;
    const duty = computeDutyFromVoltageAngle(
      thetaI + (ctrl.pfAngleDeg * Math.PI) / 180, ctrl.modulation, ctrl.modDepthM
    );
    if (duty.overmodulated) {
      throw new Error(
        `恒定工况稳态模型目前只接受线性调制区：${ctrl.modulation} 请求 m=${ctrl.modDepthM.toFixed(4)}，上限=${duty.linearCeilingM.toFixed(4)}。请先降低调制度，避免把过调制波形当成线性 SVPWM/DPWM1 计算。`
      );
    }
    dutyMin = Math.min(dutyMin, duty.da, duty.db, duty.dc);
    dutyMax = Math.max(dutyMax, duty.da, duty.db, duty.dc);

    const phaseInputs: Array<[number, number, number, number]> = [
      [ia, duty.da, tjBySwitch[0], tjBySwitch[1]],
      [ib, duty.db, tjBySwitch[2], tjBySwitch[3]],
      [ic, duty.dc, tjBySwitch[4], tjBySwitch[5]],
    ];
    const legs = phaseInputs.map(([current, highDuty, tjHigh, tjLow]) =>
      computePhaseMosLosses(
        current, highDuty, vBus, tjHigh, tjLow,
        ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos
      )
    );
    const p25 = [
      legs[0].pHighCond25W, legs[0].pLowCond25W,
      legs[1].pHighCond25W, legs[1].pLowCond25W,
      legs[2].pHighCond25W, legs[2].pLowCond25W,
    ];
    const pSw = [
      legs[0].pHighSw, legs[0].pLowSw,
      legs[1].pHighSw, legs[1].pLowSw,
      legs[2].pHighSw, legs[2].pLowSw,
    ];
    const pDead = [
      legs[0].pHighDead, legs[0].pLowDead,
      legs[1].pHighDead, legs[1].pLowDead,
      legs[2].pHighDead, legs[2].pLowDead,
    ];
    for (let m = 0; m < 6; m++) {
      sums.cond25[m] += p25[m];
      sums.sw[m] += pSw[m];
      sums.dead[m] += pDead[m];
    }
    for (const leg of legs) {
      leg.lutActiveDims?.forEach((dim) => activeDims.add(dim));
      leg.lutCollapsedDims?.forEach((dim) => collapsedDims.add(dim));
      if (leg.lutExtrapolated || leg.lutStatus === 'OUT_OF_RANGE') outOfRangeCount++;
    }
  }

  const divisor = n;
  return {
    pCond25W: Array.from(sums.cond25, (v) => v / divisor),
    pSwitchingW: Array.from(sums.sw, (v) => v / divisor),
    pDeadTimeW: Array.from(sums.dead, (v) => v / divisor),
    dutyMin,
    dutyMax,
    lutActiveDims: activeDims,
    lutCollapsedDims: collapsedDims,
    lutOutOfRangeCount: outOfRangeCount,
  };
}

function compareSteadyLossIntegration(
  coarse: FocSteadyLossAverage,
  fine: FocSteadyLossAverage
): number {
  const pairs: Array<[number[], number[]]> = [
    [coarse.pCond25W, fine.pCond25W],
    [coarse.pSwitchingW, fine.pSwitchingW],
    [coarse.pDeadTimeW, fine.pDeadTimeW],
  ];
  let maxErrorPct = 0;
  for (const [a, b] of pairs) {
    for (let i = 0; i < b.length; i++) {
      const errorPct = Math.abs(b[i] - a[i]) / Math.max(Math.abs(b[i]), 1e-9) * 100;
      if (!Number.isFinite(errorPct)) return Infinity;
      maxErrorPct = Math.max(maxErrorPct, errorPct);
    }
  }
  return maxErrorPct;
}

/**
 * Direct constant-condition calculation. It averages the PWM-period loss model
 * over one electrical cycle (or one fixed rotor angle at standstill), then solves
 * the six-MOS coupled thermal steady state. It does not synthesize a time trace or
 * run a thermal transient; the existing simulateFoc6Mos() remains the waveform path.
 */
export function simulateFoc6MosSteadyState(options: FocSteadyStateOptions): FocSteadyStateResult {
  const { model, mos, ctrl, operatingPoint } = options;
  if (model.splitFeasible === false) {
    throw new Error(model.splitMeta?.warning || 'ZthJC / Zth_board 热路径拆分不可行，拒绝稳态结温计算。');
  }
  const finite = (v: number) => Number.isFinite(v);
  if (!['SVPWM', 'DPWM1', 'SPWM'].includes(ctrl.modulation)) throw new Error('调制模式无效。');
  if (!finite(ctrl.vBusConstV) || ctrl.vBusConstV <= 0) throw new Error('恒定母线电压必须为有限正数。');
  if (!finite(ctrl.fswHz) || ctrl.fswHz <= 0 || ctrl.fswHz > 5e6) throw new Error('恒定 PWM 频率必须位于 (0, 5 MHz]。');
  if (!finite(ctrl.tDeadNs) || ctrl.tDeadNs < 0 || ctrl.tDeadNs > 1e6) throw new Error('死区时间必须位于 0～1,000,000 ns。');
  if (!finite(ctrl.modDepthM) || ctrl.modDepthM < 0 || ctrl.modDepthM > 2) throw new Error('调制度必须位于 0～2。');
  if (!finite(ctrl.pfAngleDeg) || ctrl.pfAngleDeg < -180 || ctrl.pfAngleDeg > 180) throw new Error('功率因数角必须位于 -180°～180°。');
  if (!finite(ctrl.tAmbC) || ctrl.tAmbC <= -273.15 || ctrl.tAmbC > 1000) throw new Error('环境温度必须高于绝对零度且不超过 1000°C。');
  if (!finite(mos.rdsOn25Mohm) || mos.rdsOn25Mohm <= 0) throw new Error('Rds(on)@25°C 必须为有限正数（mΩ）。');
  if (!mos.rdsOnTempCurve && (!finite(mos.tempCoeffAlphaPerC) || mos.tempCoeffAlphaPerC < 0 || mos.tempCoeffAlphaPerC > 0.05)) throw new Error('Rds 温度系数必须为 0～0.05 /°C；如使用器件曲线，该 α 输入不参与计算。');
  if (mos.rdsOnTempCurve) validateRdsOnTempCurveForMos(mos);
  validateMosEnergyAccounting(mos);
  if (!finite(mos.vsdV) || mos.vsdV < 0 || mos.vsdV > 10) throw new Error('体二极管压降必须为 0～10 V。');
  if (!finite(mos.eonPlusEoffUj) || mos.eonPlusEoffUj < 0 || !finite(mos.qrrNc) || mos.qrrNc < 0) throw new Error('Eon+Eoff 和 Qrr 必须为非负有限数值。');
  if (!finite(mos.vRefV) || mos.vRefV <= 0 || !finite(mos.iRefA) || mos.iRefA <= 0) throw new Error('Eon/Eoff 参考电压和参考电流必须为有限正数。');
  if (mos.qrrIrefA !== undefined && (!finite(mos.qrrIrefA) || mos.qrrIrefA <= 0)) throw new Error('Qr/Qrr 独立参考电流必须为有限正数。');
  if (mos.eossUj !== undefined && (!finite(mos.eossUj) || mos.eossUj < 0)) throw new Error('Eoss 必须为非负有限数值。');
  if (!finite(operatingPoint.iqPeakA) || !finite(operatingPoint.idPeakA ?? 0)) throw new Error('Id/Iq 必须为有限峰值电流。');
  if (!finite(operatingPoint.electricalFrequencyHz) || operatingPoint.electricalFrequencyHz < 0) throw new Error('电频率必须为有限非负数。');

  const inferredMode: 'rotating' | 'locked_rotor' = operatingPoint.mode ??
    (operatingPoint.electricalFrequencyHz > 1e-9 ? 'rotating' : 'locked_rotor');
  if (inferredMode === 'rotating' && operatingPoint.electricalFrequencyHz <= 0) {
    throw new Error('旋转工况必须提供大于 0 的电频率；零速工况请选择 locked_rotor。');
  }
  if (inferredMode === 'locked_rotor' && operatingPoint.electricalFrequencyHz > 1e-9) {
    throw new Error('locked_rotor 固定电角度工况的电频率必须为 0；非零电频率请使用 rotating 模式。');
  }
  if (inferredMode === 'rotating' && operatingPoint.electricalFrequencyHz >= ctrl.fswHz) {
    throw new Error('电频率不得达到或超过 PWM 频率；当前工况不满足平均 PWM 损耗模型的基本采样关系。');
  }
  const pwmCyclesPerElectricalCycle = inferredMode === 'rotating'
    ? ctrl.fswHz / operatingPoint.electricalFrequencyHz
    : null;
  const electricalAngleDeg = operatingPoint.electricalAngleDeg ?? 90;
  if (!finite(electricalAngleDeg) || electricalAngleDeg < 0 || electricalAngleDeg > 360) {
    throw new Error('堵转电角度必须位于 0°～360°。');
  }
  const maxM = getModulationLinearCeiling(ctrl.modulation);
  if (ctrl.modDepthM > maxM + 1e-6) {
    throw new Error(`恒定工况稳态计算暂不支持过调制：${ctrl.modulation} 的线性上限为 ${maxM.toFixed(4)}，当前 m=${ctrl.modDepthM.toFixed(4)}。`);
  }
  if (mos.dptLut && mos.dptLut.length > 0 &&
      (!(mos.rgOnOhm !== undefined && finite(mos.rgOnOhm) && mos.rgOnOhm >= 0) ||
       !(mos.rgOffOhm !== undefined && finite(mos.rgOffOhm) && mos.rgOffOhm >= 0))) {
    throw new Error('启用 DPT LUT 时必须明确输入 Rg_on 和 Rg_off。');
  }

  const jcStages = model.zthJC.length > 0 ? model.zthJC : DEFAULT_FOC_MODEL.zthJC;
  const boardStages = model.zthBoard.length > 0 ? model.zthBoard : DEFAULT_FOC_MODEL.zthBoard;
  const validateStages = (stages: CauerStage[], label: string) => {
    if (!stages.length) throw new Error(`${label} 热网络不能为空。`);
    stages.forEach((stage, index) => {
      if (!finite(stage.r) || stage.r <= 0 || !finite(stage.c) || stage.c <= 0) {
        throw new Error(`${label} 第 ${index + 1} 阶 R/C 必须为有限正数。`);
      }
    });
  };
  validateStages(jcStages, 'ZthJC');
  validateStages(boardStages, 'ZthBoard');
  // The steady-state path must apply the same strict six-position thermal-input
  // validation as the transient path. Silent fallback here can mask bad PCB data.
  if (model.perSwitchRjcScale !== undefined && (
    !Array.isArray(model.perSwitchRjcScale) || model.perSwitchRjcScale.length !== 6 ||
    model.perSwitchRjcScale.some((v) => !Number.isFinite(v) || v < 0.01 || v > 100)
  )) {
    throw new Error('恒定工况 perSwitchRjcScale 必须严格包含 AH/AL/BH/BL/CH/CL 六个有限正数，范围 0.01～100。');
  }
  if (model.perSwitchPadOffsetCPerW !== undefined && (
    !Array.isArray(model.perSwitchPadOffsetCPerW) || model.perSwitchPadOffsetCPerW.length !== 6 ||
    model.perSwitchPadOffsetCPerW.some((v) => !Number.isFinite(v) || v < 0 || v > 1e6)
  )) {
    throw new Error('恒定工况 perSwitchPadOffsetCPerW 必须严格包含 AH/AL/BH/BL/CH/CL 六个有限非负热阻值。');
  }

  const requestedSamples = options.integrationSamples ?? 720;
  if (!Number.isInteger(requestedSamples) || requestedSamples < 72 || requestedSamples > 8192) {
    throw new Error('电周期积分点数必须为 72～8192 的整数。');
  }
  const maxIntegrationSamples = 16384;
  const operatingPointForSweep = { ...operatingPoint, electricalAngleDeg };
  const zeroTj = new Array<number>(6).fill(25);
  let coarseSamples = inferredMode === 'rotating' ? requestedSamples : 1;
  let finalSamples = coarseSamples;
  let integrationErrorPct: number | null = null;
  let integrationAccuracyMet = true;
  let integrationBaseErrorPct: number | null = null;
  let integrationThermalErrorPct: number | null = null;
  let baseLoss!: FocSteadyLossAverage;
  let finalLoss!: FocSteadyLossAverage;
  let steady!: ReturnType<typeof solveCoupledThermalSteadyState>;
  const alpha = mos.tempCoeffAlphaPerC;
  const armChains = buildPerSwitchJcChains({ ...model, zthJC: jcStages, zthBoard: boardStages });
  const rJcTotalByArm = armChains.map((chain) => chain.reduce((sum, stage) => sum + stage.r, 0));
  const rBrdTotal = boardStages.reduce((sum, stage) => sum + stage.r, 0);
  const tolerancePct = 0.2;

  // Check convergence twice: first at the 25°C reference loss, then again at the
  // actual coupled steady-state junction temperatures. A DPT LUT can vary with Tj,
  // so convergence at 25°C alone is not sufficient to qualify the final loss result.
  // If either check fails, rerun the complete electro-thermal solve at twice the
  // angular resolution. The hard cap bounds UI cost; failure at the cap is reported
  // as ASSUMPTION_BASED rather than silently treated as a parameterized result.
  for (;;) {
    const solveSamples = inferredMode === 'rotating'
      ? Math.min(maxIntegrationSamples, coarseSamples * 2)
      : 1;
    const coarseBaseLoss = averageFocSteadyLosses(
      operatingPointForSweep, inferredMode, coarseSamples, electricalAngleDeg, mos, ctrl, zeroTj
    );
    const fineBaseLoss = solveSamples === coarseSamples
      ? coarseBaseLoss
      : averageFocSteadyLosses(
          operatingPointForSweep, inferredMode, solveSamples, electricalAngleDeg, mos, ctrl, zeroTj
        );
    integrationBaseErrorPct = inferredMode === 'rotating'
      ? compareSteadyLossIntegration(coarseBaseLoss, fineBaseLoss)
      : null;

    const activeDims = new Set<DptAxisName>(fineBaseLoss.lutActiveDims);
    const evalFixedPowerAtTj = activeDims.has('Tj')
      ? (tjCandidate: number[]): number[] => {
          const losses = averageFocSteadyLosses(
            operatingPointForSweep, inferredMode, solveSamples, electricalAngleDeg, mos, ctrl, tjCandidate
          );
          return losses.pSwitchingW.map((p, i) => p + losses.pDeadTimeW[i]);
        }
      : undefined;

    steady = solveCoupledThermalSteadyState({
      pCond25W: fineBaseLoss.pCond25W,
      pFixedW: fineBaseLoss.pSwitchingW.map((p, i) => p + fineBaseLoss.pDeadTimeW[i]),
      alphaPerC: alpha,
      evalCondFactorAtTj: mos.rdsOnTempCurve
        ? (tjVec) => tjVec.map((tj) => getFocMosRdsFactorAtTj(mos, tj))
        : undefined,
      rJcTotalByArm,
      rBrdTotal,
      tAmbC: ctrl.tAmbC,
      tInitSeedC: new Array<number>(6).fill(ctrl.tAmbC + 10),
      spatial: resolveSpatialThermalNetwork({ ...model, zthJC: jcStages, zthBoard: boardStages }),
      evalFixedPowerAtTj,
    });

    // A failed thermal solve has no final operating temperature. Do not query a
    // bounded Rds(Tj)/DPT curve with an intermediate or runaway temperature; retain
    // only the 25°C reference loss for diagnostics and let result qualification fail.
    const thermalPointUsable = steady.converged && !steady.thermalRunaway;
    finalLoss = thermalPointUsable
      ? averageFocSteadyLosses(
          operatingPointForSweep, inferredMode, solveSamples, electricalAngleDeg, mos, ctrl, steady.tjSteadyC
        )
      : fineBaseLoss;

    if (inferredMode === 'rotating' && thermalPointUsable) {
      let thermalCoarseLoss: FocSteadyLossAverage;
      let thermalFineLoss: FocSteadyLossAverage;
      if (solveSamples < maxIntegrationSamples) {
        thermalCoarseLoss = finalLoss;
        thermalFineLoss = averageFocSteadyLosses(
          operatingPointForSweep, inferredMode, Math.min(maxIntegrationSamples, solveSamples * 2),
          electricalAngleDeg, mos, ctrl, steady.tjSteadyC
        );
      } else {
        // At the cap compare the final 8192/16384 pair at the solved Tj.
        thermalCoarseLoss = averageFocSteadyLosses(
          operatingPointForSweep, inferredMode, Math.floor(solveSamples / 2),
          electricalAngleDeg, mos, ctrl, steady.tjSteadyC
        );
        thermalFineLoss = finalLoss;
      }
      integrationThermalErrorPct = compareSteadyLossIntegration(thermalCoarseLoss, thermalFineLoss);
    } else {
      integrationThermalErrorPct = null;
    }

    const errors = [integrationBaseErrorPct, integrationThermalErrorPct]
      .filter((value): value is number => value !== null);
    integrationErrorPct = errors.length > 0 ? Math.max(...errors) : null;
    finalSamples = solveSamples;
    baseLoss = fineBaseLoss;

    const needsMoreSamples = integrationErrorPct !== null && integrationErrorPct > tolerancePct;
    if (needsMoreSamples && solveSamples < maxIntegrationSamples) {
      coarseSamples = solveSamples;
      continue;
    }
    integrationAccuracyMet = !needsMoreSamples;
    break;
  }
  const thermalPointUsable = steady.converged && !steady.thermalRunaway;
  const keys = MOS_SWITCH_KEYS;
  const boardByKey = steady.tBoardSteadyByKey;
  const perSwitch: FocSteadyMosResult[] = keys.map((key, i) => {
    // Do not leak a thermal solver's last iterate as if it were an operating point.
    // NaN is intentional: consumers must check steadyConverged/thermalRunaway first.
    if (!thermalPointUsable) {
      return {
        key,
        pCondW: Number.NaN,
        pSwitchingW: Number.NaN,
        pDeadTimeW: Number.NaN,
        pTotalW: Number.NaN,
        pCondAt25CW: baseLoss.pCond25W[i],
        tjSteadyC: Number.NaN,
        boardSteadyC: Number.NaN,
      };
    }
    const factor = getFocMosRdsFactorAtTj(mos, steady.tjSteadyC[i]);
    const pCond = baseLoss.pCond25W[i] * factor;
    const pSw = finalLoss.pSwitchingW[i];
    const pDead = finalLoss.pDeadTimeW[i];
    return {
      key,
      pCondW: pCond,
      pSwitchingW: pSw,
      pDeadTimeW: pDead,
      pTotalW: pCond + pSw + pDead,
      pCondAt25CW: baseLoss.pCond25W[i],
      tjSteadyC: steady.tjSteadyC[i],
      boardSteadyC: boardByKey[i] ?? steady.tBoardSteadyC,
    };
  });
  const sum = (selector: (r: FocSteadyMosResult) => number) => perSwitch.reduce((a, r) => a + selector(r), 0);
  let hottestIndex = 0;
  for (let i = 1; i < perSwitch.length; i++) if (perSwitch[i].tjSteadyC > perSwitch[hottestIndex].tjSteadyC) hottestIndex = i;

  const missingLossInputs: string[] = [];
  const assumptionReasons: string[] = [];
  if (!mos.dptLut?.length && mos.eonPlusEoffUj <= 0) missingLossInputs.push('Eon+Eoff/DPT');
  if (!mos.dptLut?.length && !mos.eonIncludesQrr && mos.qrrNc <= 0) missingLossInputs.push('Qrr');
  if (!mos.eossAlreadyIncludedInEsw && !mos.eossCurve && (mos.eossUj ?? 0) <= 0 && !qossCoveredByQr(mos)) missingLossInputs.push('Eoss');
  if (mos.rdsDataConfirmed !== true) assumptionReasons.push('Rds(on)@25°C 未按目标器件 Vgs/测试条件确认');
  if (mos.rdsOnTempCurve && (mos.rdsOnTempCurve.provenance === 'assumed' || !mos.rdsOnTempCurve.partNumber?.trim())) {
    assumptionReasons.push('Rds(on)-Tj 曲线来源为假设/未绑定具体器件型号');
  }
  if (!mos.dptLut?.length) assumptionReasons.push('开关能量使用单点标量 V/I 缩放，不是多工况 DPT LUT');
  if (!mos.dptLut?.length && !mos.eonIncludesQrr && mos.qrrNc > 0) {
    assumptionReasons.push('Qr/Qrr 只使用单点电荷数据，按 |I| 线性缩放并以 Q×Vbus 一阶估算；未按工作 VDS、Tj、di/dt 和实际换流路径建立非线性模型');
  }
  const scalarLossLimitations: string[] = [];
  if (qossCoveredByQr(mos)) {
    scalarLossLimitations.push('数据口径：当前 Qr 输入已声明包含电容性恢复（Qr=Qs+Qoss）；独立 Eoss 不再叠加。');
  }
  if (!mos.dptLut?.length) {
    if (mos.eonPlusEoffUj > 0) scalarLossLimitations.push('标量 Eon+Eoff 采用 Vbus/Vref 与 |I|/Iref 的线性比例缩放；该近似不包含器件开关能量对结温、Rg、换流电流斜率及非线性 Coss 的完整依赖，不能替代多工况 DPT LUT。');
    if (!mos.eonIncludesQrr && mos.qrrNc > 0 && mos.qrrIncludesQoss) scalarLossLimitations.push(`当前输入为 Qr@${(mos.qrrIrefA ?? mos.iRefA).toFixed(1)}A（已声明包含 Qoss/电容性恢复）；按 Qr@${(mos.qrrIrefA ?? mos.iRefA).toFixed(1)}A × |I|/${(mos.qrrIrefA ?? mos.iRefA).toFixed(1)}A 与 Qr·Vbus 估算总恢复能量，并禁止额外叠加 Eoss。该近似未分别求解 Qs、Qoss 及其实际能量分配，也未建模 Tj、di/dt、Vgs 和换流寄生参数的非线性。`);
    else if (!mos.eonIncludesQrr && mos.qrrNc > 0) scalarLossLimitations.push('标量 Qrr 采用 Qrr@Iref × |I|/Iref，并按 Qrr·Vbus 估算恢复能量；未建模 Qrr 对 Tj、di/dt、Vgs 和换流回路寄生参数的非线性依赖。');
    if (!mos.eossAlreadyIncludedInEsw && !mos.eossCurve && (mos.eossUj ?? 0) > 0) scalarLossLimitations.push('标量 Eoss 采用 Eoss@Vref × (Vbus/Vref)^2；非线性 Coss 区域应优先导入 Eoss(V)/Qoss(V) 曲线。');
  }
  if (model.modelKind !== 'datasheet_constrained' || model.zthValidation?.passed !== true) {
    assumptionReasons.push('热网络未通过目标器件数据手册约束及 JC/Board 拆分验证');
  }
  if (model.modelKind === 'fallback_default' || model.modelKind === 'demo_builtin' || !model.modelKind) {
    assumptionReasons.push('使用默认/演示热网络，不代表目标 MOS 与 PCB 的实测热路径');
  }
  if (pwmCyclesPerElectricalCycle !== null && pwmCyclesPerElectricalCycle < 20) {
    assumptionReasons.push(`每个电周期仅 ${pwmCyclesPerElectricalCycle.toFixed(1)} 个 PWM 周期，平均 PWM 损耗假设偏弱`);
  }
  if (!integrationAccuracyMet) {
    assumptionReasons.push(`电周期积分在 ${finalSamples} 点上限仍未达到 0.2% 收敛门槛（25°C 基准误差=${integrationBaseErrorPct?.toFixed(4) ?? 'N/A'}%，稳态 Tj 误差=${integrationThermalErrorPct?.toFixed(4) ?? 'N/A'}%）；当前功耗/结温不具备参数化结果资格`);
  }
  const inverterLossBudgetW = Number.isFinite(operatingPoint.impliedInverterLossW)
    ? operatingPoint.impliedInverterLossW as number
    : null;
  const inverterLossBudgetMarginW = !thermalPointUsable || inverterLossBudgetW === null
    ? null
    : inverterLossBudgetW - sum((r) => r.pTotalW);
  const powerBalanceStatus: FocSteadyStateResult['powerBalanceStatus'] = !thermalPointUsable || inverterLossBudgetW === null
    ? 'NOT_AVAILABLE'
    : inverterLossBudgetW < -0.1 || (inverterLossBudgetMarginW as number) < -Math.max(0.1, 0.05 * Math.abs(inverterLossBudgetW))
      ? 'EXCEEDS_BUDGET'
      : 'WITHIN_BUDGET';
  if (powerBalanceStatus === 'EXCEEDS_BUDGET') {
    assumptionReasons.push('六管计算损耗超过 DynoLab 输入功率/电机电功率差所隐含的逆变器损耗预算；需核对效率定义、器件损耗参数及功率边界');
  }
  if (steady.thermalRunaway) {
    assumptionReasons.push('热稳态求解检测到热失控，不存在可用于工程判断的有限稳态结温。');
  } else if (!steady.converged) {
    assumptionReasons.push('热稳态求解未收敛，当前结温只能作为迭代中间值，不得用于安全或设计签核。');
  }
  const resultQualification: FocResultQualification = missingLossInputs.length > 0
    ? 'INCOMPLETE_LOSS_MODEL'
    : assumptionReasons.length > 0 ? 'ASSUMPTION_BASED' : 'DEVICE_PARAMETERIZED';
  const qualificationReasons = [...missingLossInputs.map((x) => `缺少 ${x}`), ...assumptionReasons];
  const warnings: string[] = [
    inferredMode === 'rotating'
      ? `恒定旋转工况：Id/Iq 保持恒定，按完整电周期 ${finalSamples} 点做平均损耗积分；fsw/fe=${(pwmCyclesPerElectricalCycle ?? 0).toFixed(1)}；不模拟 PWM 载波边沿与电流纹波。`
      : `恒定堵转工况：按电角度 ${electricalAngleDeg.toFixed(1)}° 固定 Id/Iq 计算；转子角度变化时结果可能不同。`,
    '恒定工况稳态结果不包含栅极驱动器静态/动态功耗、控制器功耗、母线电容 ESR、母排/连接器及 PCB 铜箔电阻损耗，除非这些损耗已另行纳入输入热源。',
    ...scalarLossLimitations,
  ];
  if (integrationErrorPct !== null) {
    warnings.push(integrationAccuracyMet
      ? `电周期积分已自动加密至 ${finalSamples} 点；25°C 基准积分误差=${integrationBaseErrorPct?.toFixed(4) ?? 'N/A'}%，稳态 Tj 积分误差=${integrationThermalErrorPct?.toFixed(4) ?? 'N/A'}%，最大差异 ${integrationErrorPct.toFixed(4)}%（门槛 0.2%）。`
      : `电周期积分已加密至上限 ${finalSamples} 点，但 25°C 基准/稳态 Tj 积分误差仍未全部达到 0.2%（基准=${integrationBaseErrorPct?.toFixed(4) ?? 'N/A'}%，稳态 Tj=${integrationThermalErrorPct?.toFixed(4) ?? 'N/A'}%）；结果已降级为假设估算。`);
  }
  if (missingLossInputs.length) {
    warnings.push(`损耗模型不完整：${missingLossInputs.join('、')} 缺失；对应损耗未计入，P_inv/Tj 是已知损耗下的偏低估算。`);
  }
  if (mos.rdsOnTempCurve) {
    const curve = mos.rdsOnTempCurve;
    warnings.push(`导通电阻温度反馈已使用器件 Rds(on)-Tj 归一化曲线（Vgs=${curve.referenceGateVoltageV.toFixed(2)}V，范围 ${curve.points[0].tjC}～${curve.points[curve.points.length - 1].tjC}°C，来源=${curve.provenance}）；曲线优先于线性 α。${curve.sourceNote ? `数据来源说明：${curve.sourceNote}` : ''}`);
  } else {
    warnings.push('Rds(on)-Tj 当前使用线性 α 近似；高结温外推优先替换为目标 MOS 在实际 Vgs 条件下的归一化曲线。');
  }
  if (mos.eonIncludesQrr) {
    warnings.push('反向恢复计量：Esw/DPT Eon+Eoff 已声明包含 Qrr，模型不再额外叠加 Qr·Vbus。');
  } else if (qossCoveredByQr(mos)) {
    warnings.push(`反向恢复/电容性恢复计量：当前使用 Qr=${mos.qrrNc.toFixed(2)} nC @ ${(mos.qrrIrefA ?? mos.iRefA).toFixed(1)}A，已声明包含电容性恢复（Qr=Qs+Qoss）；按 Qr·Vbus 一阶估算，不再额外叠加 Eoss。`);
    if (mos.qrrReferenceVdsV !== undefined || mos.qrrReferenceDiDtAperUs !== undefined || mos.qrrReferenceTjC !== undefined || mos.qrrReferenceVgsV !== undefined) {
      const refs = [
        mos.qrrReferenceVdsV !== undefined ? `VDS=${mos.qrrReferenceVdsV.toFixed(1)}V` : '',
        mos.qrrReferenceDiDtAperUs !== undefined ? `di/dt=${mos.qrrReferenceDiDtAperUs.toFixed(0)}A/µs` : '',
        mos.qrrReferenceVgsV !== undefined ? `VGS=${mos.qrrReferenceVgsV.toFixed(1)}V` : '',
        mos.qrrReferenceTjC !== undefined ? `Tj=${mos.qrrReferenceTjC.toFixed(0)}°C` : '',
      ].filter(Boolean).join('，');
      const vdsDeltaPct = mos.qrrReferenceVdsV !== undefined && mos.qrrReferenceVdsV > 0
        ? Math.abs(ctrl.vBusConstV - mos.qrrReferenceVdsV) / mos.qrrReferenceVdsV * 100
        : null;
      warnings.push(`Qr 数据手册参考测试条件：${refs}；当前 Vbus=${ctrl.vBusConstV.toFixed(2)}V${vdsDeltaPct === null ? '' : `（相对测试 VDS 差异 ${vdsDeltaPct.toFixed(1)}%）`}。该单点 Qr 没有 VDS/温度/di/dt 特性曲线，未对测试条件差异进行修正；此结果只能作为一阶估算。`);
    }
  } else {
    warnings.push(`反向恢复计量：Esw 未声明包含 Qrr${mos.qrrNc > 0 ? `，额外计入 Qrr·Vbus（Qrr=${mos.qrrNc.toFixed(2)} nC @ ${(mos.qrrIrefA ?? mos.iRefA).toFixed(1)} A）` : '，且 Qrr 输入为 0；未计入额外反向恢复能量'}。`);
  }
  if (mos.eossAlreadyIncludedInEsw) {
    warnings.push('输出电容计量：已启用 Eoss 防重复计量，独立 Eoss 曲线/标量不再叠加。');
  } else if (qossCoveredByQr(mos)) {
    warnings.push('输出电容计量：当前 Qr 已包含 Qoss/电容性恢复，独立 Eoss 曲线/标量被屏蔽，避免重复计量。');
  } else {
    warnings.push(`输出电容计量：独立计算 Eoss${mos.eossCurve ? '（非线性曲线）' : (mos.eossUj ?? 0) > 0 ? `（标量 ${(mos.eossUj ?? 0).toFixed(3)} µJ @ Vref）` : '输入为 0，未计入'}；请确认 Esw/Eon 数据是否已包含同一能量边界。`);
  }
  if (assumptionReasons.length) warnings.push(`结果属于假设估算：${assumptionReasons.join('；')}。`);
  if (powerBalanceStatus === 'EXCEEDS_BUDGET') {
    warnings.push(`功率平衡检查失败：六管损耗 ${sum((r) => r.pTotalW).toFixed(3)} W，FOC 效率模型隐含逆变器损耗预算 ${inverterLossBudgetW!.toFixed(3)} W，超出 ${(-inverterLossBudgetMarginW!).toFixed(3)} W。`);
  }
  if (baseLoss.lutOutOfRangeCount > 0 || finalLoss.lutOutOfRangeCount > 0) {
    throw new Error('恒定工况积分中存在 DPT LUT 越界查询，拒绝输出稳态结温。');
  }
  if (!steady.converged && !steady.thermalRunaway) {
    warnings.push('电热耦合稳态迭代未收敛；当前 Tj 不得用于安全或设计签核。');
  }
  if (steady.thermalRunaway) warnings.push('检测到热反馈导致无有限稳态平衡点（热失控）。');

  return {
    resultQualification,
    qualificationReasons,
    mode: inferredMode,
    iqPeakA: operatingPoint.iqPeakA,
    idPeakA: operatingPoint.idPeakA ?? 0,
    electricalFrequencyHz: operatingPoint.electricalFrequencyHz,
    pwmCyclesPerElectricalCycle,
    vBusConstV: ctrl.vBusConstV,
    modulation: ctrl.modulation,
    modDepthM: ctrl.modDepthM,
    pfAngleDeg: ctrl.pfAngleDeg,
    fswHz: ctrl.fswHz,
    tDeadNs: ctrl.tDeadNs,
    tAmbC: ctrl.tAmbC,
    mechanicalSpeedRpm: Number.isFinite(operatingPoint.mechanicalSpeedRpm) ? operatingPoint.mechanicalSpeedRpm as number : null,
    torqueNm: Number.isFinite(operatingPoint.torqueNm) ? operatingPoint.torqueNm as number : null,
    mechanicalPowerW: Number.isFinite(operatingPoint.mechanicalPowerW) ? operatingPoint.mechanicalPowerW as number : null,
    busInputPowerW: Number.isFinite(operatingPoint.busInputPowerW) ? operatingPoint.busInputPowerW as number : null,
    dcLinkPowerW: Number.isFinite(operatingPoint.dcLinkPowerW) ? operatingPoint.dcLinkPowerW as number : null,
    motorElectricalPowerW: Number.isFinite(operatingPoint.motorElectricalPowerW) ? operatingPoint.motorElectricalPowerW as number : null,
    impliedInverterLossW: inverterLossBudgetW,
    inverterLossBudgetMarginW,
    powerBalanceStatus,
    phaseCurrentPeakA: Math.hypot(operatingPoint.iqPeakA, operatingPoint.idPeakA ?? 0),
    phaseCurrentRmsA: inferredMode === 'rotating'
      ? Math.hypot(operatingPoint.iqPeakA, operatingPoint.idPeakA ?? 0) / Math.sqrt(2)
      : null,
    phaseCurrentA: inferredMode === 'locked_rotor'
      ? (() => {
          const theta = (electricalAngleDeg * Math.PI) / 180;
          const id = operatingPoint.idPeakA ?? 0;
          const iq = operatingPoint.iqPeakA;
          const alpha = id * Math.cos(theta) + iq * Math.sin(theta);
          const beta = id * Math.sin(theta) - iq * Math.cos(theta);
          return { a: alpha, b: -0.5 * alpha + (Math.sqrt(3) / 2) * beta, c: -0.5 * alpha - (Math.sqrt(3) / 2) * beta };
        })()
      : null,
    electricalAngleDeg: inferredMode === 'locked_rotor' ? electricalAngleDeg : null,
    integrationSamples: finalSamples,
    integrationErrorPct,
    integrationAccuracyMet,
    perSwitch,
    pCondTotalW: sum((r) => r.pCondW),
    pSwitchingTotalW: sum((r) => r.pSwitchingW),
    pDeadTimeTotalW: sum((r) => r.pDeadTimeW),
    pInverterTotalW: sum((r) => r.pTotalW),
    tBoardSteadyC: thermalPointUsable ? steady.tBoardSteadyC : Number.NaN,
    tjMaxSteadyC: thermalPointUsable ? perSwitch[hottestIndex].tjSteadyC : Number.NaN,
    hottestKey: perSwitch[hottestIndex].key,
    steadyConverged: steady.converged,
    thermalRunaway: steady.thermalRunaway,
    dutyMin: baseLoss.dutyMin,
    dutyMax: baseLoss.dutyMax,
    warnings,
  };
}

/**
 * Evaluate the 12-V vehicle bus envelope while preserving the requested motor
 * fundamental voltage. Id/Iq, electrical frequency, Fsw, dead time, PF and thermal
 * model remain fixed. Required modulation scales as Vref/Vbus; if it exceeds the
 * linear modulation ceiling, the case is reported as voltage-limited and no Tj is
 * fabricated. This is an operating-point sensitivity check, not a motor/FOC
 * re-solve: a full motor model is still required to recalculate current/torque.
 */
export function simulateFoc6MosVoltageEnvelope(options: FocVoltageEnvelopeOptions): FocVoltageEnvelopeRow[] {
  const referenceVoltageV = options.referenceVoltageV ?? options.ctrl.vBusConstV;
  if (!Number.isFinite(referenceVoltageV) || referenceVoltageV <= 0) {
    throw new Error('电压边界评估的参考母线电压必须为有限正数。');
  }
  const voltagePoints = options.voltagePoints ?? [9, 13.5, 16];
  if (!Array.isArray(voltagePoints) || voltagePoints.length < 2 ||
      voltagePoints.some((v) => !Number.isFinite(v) || v <= 0) ||
      new Set(voltagePoints).size !== voltagePoints.length) {
    throw new Error('电压边界评估至少需要两个互不重复的有限正母线电压点。');
  }
  if (!Number.isFinite(options.ctrl.modDepthM) || options.ctrl.modDepthM < 0) {
    throw new Error('参考调制度必须为有限非负数。');
  }
  const ceiling = getModulationLinearCeiling(options.ctrl.modulation);
  if (options.ctrl.modDepthM > ceiling + 1e-6) {
    throw new Error(`参考工况本身已超过 ${options.ctrl.modulation} 线性调制上限（m=${options.ctrl.modDepthM.toFixed(4)}，上限=${ceiling.toFixed(4)}）；不能以不可实现的参考点开展电压边界评估。`);
  }
  return voltagePoints.map((vBusV): FocVoltageEnvelopeRow => {
    const requiredModDepthM = options.ctrl.modDepthM * referenceVoltageV / vBusV;
    if (requiredModDepthM > ceiling + 1e-6) {
      return {
        vBusV,
        requiredModDepthM,
        modulationCeiling: ceiling,
        status: 'VOLTAGE_LIMITED',
        result: null,
        note: `维持参考基波电压需要 m=${requiredModDepthM.toFixed(4)}，超过 ${options.ctrl.modulation} 线性上限 ${ceiling.toFixed(4)}；不能假定原 Id/Iq 工作点仍可维持。`,
      };
    }
    try {
      const result = simulateFoc6MosSteadyState({
        ...options,
        ctrl: { ...options.ctrl, vBusConstV: vBusV, modDepthM: requiredModDepthM },
      });
      const status: FocVoltageEnvelopeStatus = result.thermalRunaway
        ? 'THERMAL_RUNAWAY'
        : !result.steadyConverged ? 'THERMAL_NOT_CONVERGED' : 'CALCULATED';
      return {
        vBusV,
        requiredModDepthM,
        modulationCeiling: ceiling,
        status,
        result,
        note: status === 'THERMAL_RUNAWAY'
          ? '热反馈迭代检测到热失控；保留损耗诊断信息，但不提供可用稳态结温。'
          : status === 'THERMAL_NOT_CONVERGED'
            ? '热稳态迭代未收敛；当前温度仅为中间迭代值，不得作为稳态结温或设计依据。'
            : '在固定 Id/Iq、fe、Fsw、PF 和参考基波电压假设下完成稳态计算。',
      };
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      const isCoverageFailure = /DPT LUT.*(?:OUT_OF_RANGE|越界|超出)|超出 Eoss(?:\(V\))?\/Qoss|曲线定义域|超出 Rds\(on\)-Tj 曲线范围/.test(note);
      return {
        vBusV,
        requiredModDepthM,
        modulationCeiling: ceiling,
        status: isCoverageFailure ? 'MODEL_OUT_OF_RANGE' : 'INVALID_INPUT',
        result: null,
        note,
      };
    }
  });
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
  if (model.splitFeasible === false) {
    throw new Error(model.splitMeta?.warning || '热模型 ZthJC / Zth_board 手册约束拆分不可行，已拒绝代入 6-MOS 仿真。');
  }

  const finiteInRange = (value: number, min: number, max: number): boolean =>
    Number.isFinite(value) && value >= min && value <= max;
  if (!['SVPWM', 'DPWM1', 'SPWM'].includes(ctrl.modulation)) throw new Error('FOC 调制模式无效。');
  if (!finiteInRange(ctrl.fswHz, 1, 5e6)) throw new Error('开关频率 fswHz 必须为 1 Hz～5 MHz 的有限正数。');
  if (!finiteInRange(ctrl.tDeadNs, 0, 1e6)) throw new Error('死区时间 tDeadNs 必须为 0～1,000,000 ns。');
  if (!finiteInRange(ctrl.modDepthM, 0, 2)) throw new Error('调制深度 modDepthM 必须位于 0～2；线性区外会单独给出过调制告警。');
  if (!finiteInRange(ctrl.pfAngleDeg, -180, 180)) throw new Error('电压/电流相角 pfAngleDeg 必须位于 -180°～180°。');
  if (!Number.isFinite(ctrl.tAmbC) || ctrl.tAmbC <= -273.15 || ctrl.tAmbC > 1000) throw new Error('环境温度必须位于绝对零度以上且不超过 1000°C。');

  if (!finiteInRange(mos.rdsOn25Mohm, Number.EPSILON, 1e6)) throw new Error('MOS Rds(on)@25°C 必须为有限正数（mΩ）。');
  if (!mos.rdsOnTempCurve && !finiteInRange(mos.tempCoeffAlphaPerC, 0, 0.05)) throw new Error('MOS Rds 温度系数必须为 0～0.05 /°C；如使用器件曲线，该 α 输入不参与计算。');
  if (mos.rdsOnTempCurve) validateRdsOnTempCurveForMos(mos);
  if (!finiteInRange(mos.vsdV, 0, 10)) throw new Error('MOS 体二极管压降必须为 0～10 V。');
  if (!finiteInRange(mos.eonPlusEoffUj, 0, 1e9)) throw new Error('MOS Eon+Eoff 必须为非负有限值（µJ）。');
  if (!finiteInRange(mos.vRefV, Number.EPSILON, 1e6) || !finiteInRange(mos.iRefA, Number.EPSILON, 1e6)) {
    throw new Error('MOS 开关能量参考电压 Vref 和参考电流 Iref 必须为有限正数。');
  }
  if (!finiteInRange(mos.qrrNc, 0, 1e9) || (mos.qrrIrefA !== undefined && !finiteInRange(mos.qrrIrefA, Number.EPSILON, 1e6)) || (mos.eossUj !== undefined && !finiteInRange(mos.eossUj, 0, 1e9))) {
    throw new Error('MOS Qrr / Eoss 必须为非负有限值（nC / µJ）。');
  }

  const jcStages = model.zthJC.length > 0 ? model.zthJC : DEFAULT_FOC_MODEL.zthJC;
  const boardStages = model.zthBoard.length > 0 ? model.zthBoard : DEFAULT_FOC_MODEL.zthBoard;
  const validateThermalStages = (stages: CauerStage[], label: string): void => {
    if (stages.length === 0) throw new Error(`${label} 热阻网络不能为空。`);
    stages.forEach((stage, index) => {
      if (!Number.isFinite(stage.r) || stage.r <= 0 || !Number.isFinite(stage.c) || stage.c <= 0) {
        throw new Error(`${label} 第 ${index + 1} 阶 Cauer 阶梯的 R/C 必须为有限正数。`);
      }
    });
  };
  validateThermalStages(jcStages, 'ZthJC');
  validateThermalStages(boardStages, 'ZthBoard');
  if (model.perSwitchRjcScale && (model.perSwitchRjcScale.length !== 6 || model.perSwitchRjcScale.some((v) => !finiteInRange(v, 0.01, 100)))) {
    throw new Error('perSwitchRjcScale 必须是 6 个有限正数，范围 0.01～100。');
  }
  if (model.perSwitchPadOffsetCPerW && (model.perSwitchPadOffsetCPerW.length !== 6 || model.perSwitchPadOffsetCPerW.some((v) => !finiteInRange(v, 0, 1e6)))) {
    throw new Error('perSwitchPadOffsetCPerW 必须是 6 个有限非负热阻值。');
  }

  const validatePhysicalChannel = (ch: WaveformChannel | null | undefined, label: string): void => {
    if (!ch) return;
    if (ch.t.length !== ch.v.length) {
      throw new Error(`${label} 时间戳数量 (${ch.t.length}) 与数据点数量 (${ch.v.length}) 不一致，已阻止热仿真。`);
    }
    if (ch.t.length < 2) {
      throw new Error(`${label} 有效样本不足 (<2 点)，无法执行物理热仿真。`);
    }
    for (let idx = 0; idx < ch.t.length; idx++) {
      const tVal = ch.t[idx];
      if (!Number.isFinite(tVal)) {
        throw new Error(`${label} 时间轴在索引 ${idx} 处存在 NaN/Inf 无效时间戳，请先清洗数据。`);
      }
      if (idx > 0 && !(tVal > ch.t[idx - 1])) {
        const kind = tVal === ch.t[idx - 1] ? '重复时间戳 (dt=0)' : '时间倒退';
        throw new Error(`${label} 时间轴在索引 ${idx} 处存在${kind}，FOC 热积分要求严格递增时间轴，已阻止仿真。`);
      }
    }
  };
  validatePhysicalChannel(iaCh, 'Ia');
  validatePhysicalChannel(ibCh, 'Ib');
  validatePhysicalChannel(opts?.icCh, 'Ic');
  validatePhysicalChannel(opts?.vbusCh, 'Vbus');
  validatePhysicalChannel(opts?.dutyChs?.da, 'Duty_A');
  validatePhysicalChannel(opts?.dutyChs?.db, 'Duty_B');
  validatePhysicalChannel(opts?.dutyChs?.dc, 'Duty_C');

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

  const alignmentWarnings: string[] = [];
  let i0 = 0;
  let i1 = nIa - 1;
  if (opts?.tStart !== undefined) while (i0 < nIa && iaCh.t[i0] < opts.tStart) i0++;
  if (opts?.tEnd !== undefined) while (i1 > i0 && iaCh.t[i1] > opts.tEnd) i1--;

  // Ia and Ib are the two primary measured phase-current signals. If their
  // acquisition windows differ slightly, integrate only their true overlap;
  // never extend either channel by holding endpoint samples. Auxiliary inputs
  // (Ic/Vbus/Duty) must cover this already-clipped analysis interval in full.
  if (i0 < nIa && i1 >= i0) {
    const requestedStart = iaCh.t[i0];
    const requestedEnd = iaCh.t[i1];
    const ibStart = ibCh.t[0];
    const ibEnd = ibCh.t[nIb - 1];
    const overlapStart = Math.max(requestedStart, ibStart);
    const overlapEnd = Math.min(requestedEnd, ibEnd);
    if (!(overlapEnd > overlapStart)) {
      throw new Error('Ia 与 Ib 时间轴没有有效重叠区间，无法进行 6-MOS 热仿真。');
    }
    const eps = Math.max(1e-12, (requestedEnd - requestedStart) * 1e-9);
    while (i0 < i1 && iaCh.t[i0] < overlapStart - eps) i0++;
    while (i1 > i0 && iaCh.t[i1] > overlapEnd + eps) i1--;
    if (iaCh.t[i0] > requestedStart + eps || iaCh.t[i1] < requestedEnd - eps) {
      alignmentWarnings.push(
        `Ia/Ib 原始采集窗口不完全重合，仿真已裁剪到共同覆盖区间 [${iaCh.t[i0].toFixed(6)}s, ${iaCh.t[i1].toFixed(6)}s]；未使用端点保持或区间外推。`
      );
    }
  }
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
  if (!vbusCh && !finiteInRange(ctrl.vBusConstV, 1e-6, 1e6)) {
    throw new Error('未选择 Vbus 波形时，恒定母线电压 vBusConstV 必须为有限正数。');
  }
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

  const checkSameTb = (ch: WaveformChannel | null): boolean => {
    if (!ch) return false;
    // A same-timebase fast path is valid only when both arrays have exactly
    // the same sample count. A longer/shorter channel must use timestamp-based
    // interpolation over the real overlap, never silent prefix truncation.
    if (ch.t.length !== nIa || ch.v.length !== nIa) return false;
    const nc = nIa;
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
    completelyDisjoint: boolean;
    coverageComplete: boolean;
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
    if (ch.t.length !== ch.v.length) {
      throw new Error(`${label} 时间戳数量 (${ch.t.length}) 与幅值数量 (${ch.v.length}) 不一致，已拒绝静默截断。`);
    }
    const nc = ch.t.length;
    if (nc < 2) throw new Error(`${label} 至少需要 2 个有效样本才能插值和进行热积分。`);
    const covSpan = Math.max(1e-9, simEnd - simStart);
    const covEps = Math.max(1e-12, covSpan * 1e-8);

    // Do not bridge large acquisition gaps that intersect the actual simulation
    // window. Samples outside a user-selected gate must not invalidate an otherwise
    // complete window; include the two bracketing source samples so interpolation
    // at a non-grid-aligned gate boundary is still checked.
    let firstAtOrAfterStart = 0;
    while (firstAtOrAfterStart < nc && ch.t[firstAtOrAfterStart] < simStart) firstAtOrAfterStart++;
    let firstAtOrAfterEnd = firstAtOrAfterStart;
    while (firstAtOrAfterEnd < nc && ch.t[firstAtOrAfterEnd] < simEnd) firstAtOrAfterEnd++;
    const startIsExact = firstAtOrAfterStart < nc && Math.abs(ch.t[firstAtOrAfterStart] - simStart) <= covEps;
    const gapStartIdx = startIsExact ? firstAtOrAfterStart : Math.max(0, firstAtOrAfterStart - 1);
    const gapEndIdx = Math.min(nc - 1, firstAtOrAfterEnd);
    // Linear interpolation over a missing switching/current interval can smooth
    // current peaks and understate conduction or switching-related loss.
    const gapReport = inspectChannelSamplingGaps(ch.t, gapStartIdx, gapEndIdx, 3.5);
    if (gapReport.gapCount > 0) {
      throw new Error(`${label} 时间轴检测到 ${gapReport.gapCount} 个内部采样缺口，最大间隔为 ${(gapReport.maxGapSec * 1e3).toFixed(3)} ms（中位采样间隔的 ${gapReport.maxGapRatio.toFixed(1)} 倍）；为避免跨缺口插值低估电流/损耗，FOC 热仿真已拒绝该通道。请缩小时间窗或补充连续采样数据。`);
    }

    // Do not repair invalid acquisition values in an engineering loss/thermal path.
    // Interpolation across an unknown sample can suppress peaks and understate loss.
    for (let i = 0; i < nc; i++) {
      const t = ch.t[i];
      if (!Number.isFinite(t)) {
        throw new Error(`通道 ${label} 时间轴在索引 ${i} 处含 NaN/Inf。`);
      }
      if (i > 0 && !(t > ch.t[i - 1])) {
        throw new Error(`通道 ${label} 时间轴在索引 ${i} 处非严格递增（重复或倒退）。`);
      }
      const value = getChannelDisplayValue(ch, i, meanAc) * scale;
      if (!Number.isFinite(value)) {
        throw new Error(`通道 ${label} 在索引 ${i}、t=${t.toExponential(6)}s 处含 NaN/Inf 幅值；FOC 热损耗计算拒绝插值修补无效采样。`);
      }
    }

    let completelyDisjoint = false;
    let coverageComplete = true;
    if (!isSame) {
      const cStart = ch.t[0];
      const cEnd = ch.t[nc - 1];
      if (cEnd < simStart - covEps || cStart > simEnd + covEps) {
        completelyDisjoint = true;
        coverageComplete = false;
      } else if (cStart > simStart + covEps || cEnd < simEnd - covEps) {
        coverageComplete = false;
        alignmentWarnings.push(
          `通道 ${label} 时间覆盖 [${cStart.toFixed(4)}s, ${cEnd.toFixed(4)}s] 未完整覆盖仿真区间 [${simStart.toFixed(4)}s, ${simEnd.toFixed(4)}s]，禁止使用首/尾边界值外推。`
        );
      }
    }

    const tArr = ch.t;
    const vArr = new Float64Array(nc);
    for (let i = 0; i < nc; i++) vArr[i] = getChannelDisplayValue(ch, i, meanAc) * scale;

    const sample = (targetT: number, idxHint: number): number => {
      if (!Number.isFinite(targetT)) return Number.NaN;
      if (isSame && idxHint >= 0 && idxHint < nc) return vArr[idxHint];
      if (targetT < tArr[0] - covEps || targetT > tArr[nc - 1] + covEps) return Number.NaN;
      if (targetT <= tArr[0]) return targetT >= tArr[0] - covEps ? vArr[0] : Number.NaN;
      if (targetT >= tArr[nc - 1]) return targetT <= tArr[nc - 1] + covEps ? vArr[nc - 1] : Number.NaN;
      let lo = 0;
      let hi = nc - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (tArr[mid] <= targetT) lo = mid;
        else hi = mid;
      }
      const dt = tArr[hi] - tArr[lo];
      if (!(dt > 0)) return Number.NaN;
      const frac = (targetT - tArr[lo]) / dt;
      return vArr[lo] + frac * (vArr[hi] - vArr[lo]);
    };

    return { sample, repairedNanCount: 0, finiteCount: nc, completelyDisjoint, coverageComplete };
  };

  // Preheat runs from the first timestamp jointly covered by Ia and Ib, not
  // blindly from Ia[0]. If the captures have different start times, begin at
  // the first Ia sample at/after the common acquisition start; never extrapolate
  // Ib backwards to the start of Ia.
  let preheatStartIdx = 0;
  if (gateThermalMode === 'preheat') {
    const commonCaptureStart = Math.max(iaCh.t[0], ibCh.t[0]);
    while (preheatStartIdx < i0 && iaCh.t[preheatStartIdx] < commonCaptureStart - 1e-12) {
      preheatStartIdx++;
    }
    if (preheatStartIdx >= i0) {
      preheatStartIdx = i0;
    }
    if (preheatStartIdx > 0 && iaCh.t[preheatStartIdx] > iaCh.t[0] + 1e-12) {
      alignmentWarnings.push(`热预热区间已从 Ia/Ib 首个共同采样时刻 ${iaCh.t[preheatStartIdx].toFixed(6)}s 开始；更早时段缺少完整双相电流数据，不参与预热。`);
    }
  }
  const simTStart = gateThermalMode === 'preheat' ? iaCh.t[preheatStartIdx] : iaCh.t[i0];
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
  if (ibSampler.completelyDisjoint || !ibSampler.coverageComplete) {
    throw new Error(`Ib(${ibCh.name}) 未完整覆盖主通道 Ia 门控区间，已拒绝使用首/尾保持或外推值执行 6-MOS 热仿真。`);
  }
  const icSampler = icCh
    ? buildGapSafeSampler(icCh, icScale, mIc, `Ic(${icCh.name})`, sameIc, simTStart, simTEnd)
    : null;
  if (icSampler && (icSampler.finiteCount === 0 || icSampler.completelyDisjoint || !icSampler.coverageComplete)) {
    throw new Error(`Ic(${icCh!.name}) 全为无效样本或未完整覆盖仿真区间，请检查通道选择或改为 Auto (-Ia-Ib)。`);
  }
  const vbusSampler = vbusCh
    ? buildGapSafeSampler(vbusCh, vbusScale, mVbus, `Vbus(${vbusCh.name})`, sameVbus, simTStart, simTEnd)
    : null;
  if (vbusSampler && (vbusSampler.finiteCount === 0 || vbusSampler.completelyDisjoint || !vbusSampler.coverageComplete)) {
    throw new Error(`Vbus(${vbusCh!.name}) 全为无效样本或未完整覆盖仿真区间，请检查母线电压通道或使用恒定 Vbus。`);
  }

  // Determine each external Duty channel's own engineering scale. Do not apply
  // one global scale: mixed %, pu and fraction exports are common when channels
  // were assembled from different instruments/data sources.
  const useExternalDuty = Boolean(daCh && dbCh && dcCh);
  const dutyScales: [number, number, number] = [1, 1, 1];
  const dutyPctInferredChannels: string[] = [];
  let dutyBinaryPulseSuspected = false;

  if (useExternalDuty && daCh && dbCh && dcCh) {
    const dutyList = [daCh, dbCh, dcCh];
    let totalDutySamples = 0;
    let extremeBoundaryCount = 0;
    let finiteDutySum = 0;
    // Unlabelled channels in a single exported three-phase Duty group normally
    // share one unit convention. Infer percent for all *unlabelled* phases only
    // when at least one unlabelled phase provides >1.05 evidence. Explicit pu
    // channels remain fractional and are never globally rescaled.
    const groupUnitlessPercentEvidence = dutyList.some((ch) => {
      if ((ch.unit || '').trim().toLowerCase().replace(/\s+/g, '') !== '') return false;
      const n = Math.min(ch.t.length, ch.v.length);
      let max = -Infinity;
      for (let i = 0; i < n; i++) {
        const value = getChannelDisplayValue(ch, i, 0);
        if (Number.isFinite(value)) max = Math.max(max, value);
      }
      return max > 1.05 && max <= 100.5;
    });

    dutyList.forEach((ch, channelIndex) => {
      const u = (ch.unit || '').trim().toLowerCase().replace(/\s+/g, '');
      const nD = Math.min(ch.t.length, ch.v.length);
      if (nD < 2) throw new Error(`外部占空比通道 "${ch.name}" 有效样本不足。`);
      let minRaw = Infinity;
      let maxRaw = -Infinity;
      for (let i = 0; i < nD; i++) {
        const val = getChannelDisplayValue(ch, i, 0);
        if (!Number.isFinite(val)) {
          throw new Error(`外部占空比通道 "${ch.name}" 在索引 ${i} 含 NaN/Inf，拒绝用钳位或插值掩盖无效 Duty。`);
        }
        minRaw = Math.min(minRaw, val);
        maxRaw = Math.max(maxRaw, val);
      }

      const isPct = /^(%|pct|percent)$/.test(u);
      const isFraction = u === '' || /^(1|pu|p\.u\.)$/.test(u);
      if (!isPct && !isFraction) {
        throw new Error(`外部占空比通道 "${ch.name}" 的单位 "${ch.unit}" 未知；仅接受 % 或无量纲/pu，拒绝猜测单位。`);
      }

      let scale = isPct ? 0.01 : 1;
      if (!isPct && u === '' && groupUnitlessPercentEvidence) {
        scale = 0.01;
        dutyPctInferredChannels.push(ch.name);
      }
      if (maxRaw > 100.5) {
        throw new Error(`外部占空比通道 "${ch.name}" 最大值 ${maxRaw.toFixed(4)} 超过 100.5%，输入量程无效。`);
      }
      const minScaled = minRaw * scale;
      const maxScaled = maxRaw * scale;
      if (minScaled < -1e-4 || maxScaled > 1.0001) {
        throw new Error(`外部占空比通道 "${ch.name}" 换算后范围为 [${minScaled.toFixed(5)}, ${maxScaled.toFixed(5)}]，超出合法 [0,1]；请核对单位/通道，不再静默钳位。`);
      }
      dutyScales[channelIndex] = scale;

      const stride = nD > 20000 ? Math.floor(nD / 20000) : 1;
      for (let i = 0; i < nD; i += stride) {
        const dScaled = Math.max(0, Math.min(1, getChannelDisplayValue(ch, i, 0) * scale));
        totalDutySamples++;
        finiteDutySum += dScaled;
        if (dScaled <= 1e-4 || dScaled >= 1 - 1e-4) extremeBoundaryCount++;
      }
    });

    if (totalDutySamples >= 20) {
      const fracExtreme = extremeBoundaryCount / totalDutySamples;
      const meanDuty = finiteDutySum / totalDutySamples;
      if (fracExtreme > 0.95 && meanDuty > 0.05 && meanDuty < 0.95) dutyBinaryPulseSuspected = true;
    }
    if (dutyBinaryPulseSuspected) {
      throw new Error(
        '检测到外部 Duty_A/B/C 超过 95% 样本为精确 0 或 1（原始 PWM 二值开关脉冲而非周期平均占空比）；请先提取 PWM 周期平均占空比，或切换为无传感器 SVPWM 重构。'
      );
    }
  }

  const daSampler = daCh
    ? buildGapSafeSampler(daCh, dutyScales[0], 0, `Duty_A(${daCh.name})`, sameDa, simTStart, simTEnd)
    : null;
  const dbSampler = dbCh
    ? buildGapSafeSampler(dbCh, dutyScales[1], 0, `Duty_B(${dbCh.name})`, sameDb, simTStart, simTEnd)
    : null;
  const dcSampler = dcCh
    ? buildGapSafeSampler(dcCh, dutyScales[2], 0, `Duty_C(${dcCh.name})`, sameDc, simTStart, simTEnd)
    : null;
  for (const [lbl, smp] of [
    ['Duty_A', daSampler],
    ['Duty_B', dbSampler],
    ['Duty_C', dcSampler],
  ] as const) {
    if (smp && (smp.finiteCount === 0 || smp.completelyDisjoint || !smp.coverageComplete)) {
      throw new Error(`外部占空比通道 ${lbl} 全为无效样本或未完整覆盖仿真区间，已拒绝执行 6-MOS 仿真。`);
    }
  }

  const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
  let overmodulatedCount = 0;
  let zeroCurrentFallbackCount = 0;

  const hasDptLut = Boolean(mos.dptLut && mos.dptLut.length > 0);
  let lutVMin = Infinity;
  let lutVMax = -Infinity;
  let lutIMin = Infinity;
  let lutIMax = -Infinity;
  if (hasDptLut && mos.dptLut) {
    for (const pt of mos.dptLut) {
      if (pt.vBusV < lutVMin) lutVMin = pt.vBusV;
      if (pt.vBusV > lutVMax) lutVMax = pt.vBusV;
      if (pt.iLoadA < lutIMin) lutIMin = pt.iLoadA;
      if (pt.iLoadA > lutIMax) lutIMax = pt.iLoadA;
    }
  }
  let lutExtrapolatedSamples = 0;
  let scalarWideScaleSamples = 0;
  let opVMin = Infinity;
  let opVMax = -Infinity;
  let opIMax = 0;

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

  let lutOutOfRangeCount = 0;
  let lutStatusLatest: DptLutStatus | undefined;
  let lutActiveDimsLatest: DptAxisName[] = [];
  let lutCollapsedDimsLatest: DptAxisName[] = [];
  let lutTjProvLatest: DptParameterProvenance = 'measured';
  let lutRgProvLatest: DptParameterProvenance = 'assumed';
  let eossCurveOutOfRangeCount = 0;

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
    pCond25Step: number[];
    pSwStep: number[];
    pDeadStep: number[];
    ia: number;
    ib: number;
    ic: number;
  } => {
    const tCurr = iaCh.t[idx];
    const ia = iaSampler.sample(tCurr, idx);
    const ib = ibSampler.sample(tCurr, idx);
    const ic = icSampler ? icSampler.sample(tCurr, idx) : -(ia + ib);
    const vbus = vbusSampler ? vbusSampler.sample(tCurr, idx) : ctrl.vBusConstV;
    if (!Number.isFinite(vbus) || vbus <= 0) {
      throw new Error(`Vbus 在 t=${tCurr.toExponential(6)}s 处为非有限值或非正值；拒绝将无效母线电压钳位为 0V 继续计算。`);
    }

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

    if (countOvermod) {
      if (vbus < opVMin) opVMin = vbus;
      if (vbus > opVMax) opVMax = vbus;
      const stepMaxI = Math.max(Math.abs(ia), Math.abs(ib), Math.abs(ic));
      if (stepMaxI > opIMax) opIMax = stepMaxI;
      if (hasDptLut) {
        if (
          vbus < lutVMin - 1e-6 ||
          vbus > lutVMax + 1e-6 ||
          stepMaxI > lutIMax + 1e-6
        ) {
          lutExtrapolatedSamples++;
        }
      } else {
        const vRatio = vbus / Math.max(1e-3, mos.vRefV);
        const iRatio = stepMaxI / Math.max(1e-3, mos.iRefA);
        if (vRatio < 0.25 || vRatio > 2.0 || iRatio > 2.0) {
          scalarWideScaleSamples++;
        }
      }
    }

    const lA = computePhaseMosLosses(ia, da, vbus, curTj[0], curTj[1], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);
    const lB = computePhaseMosLosses(ib, db, vbus, curTj[2], curTj[3], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);
    const lC = computePhaseMosLosses(ic, dc, vbus, curTj[4], curTj[5], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);

    if (countOvermod) {
      for (const leg of [lA, lB, lC]) {
        if (leg.lutStatus) {
          lutStatusLatest = leg.lutStatus;
          if (leg.lutActiveDims) lutActiveDimsLatest = leg.lutActiveDims;
          if (leg.lutCollapsedDims) lutCollapsedDimsLatest = leg.lutCollapsedDims;
          if (leg.lutTjProvenance) lutTjProvLatest = leg.lutTjProvenance;
          if (leg.lutRgProvenance) lutRgProvLatest = leg.lutRgProvenance;
          if (leg.lutExtrapolated || leg.lutStatus === 'OUT_OF_RANGE') {
            lutOutOfRangeCount++;
          }
        }
        if (leg.eossOutOfRange) eossCurveOutOfRangeCount++;
      }
    }

    return {
      da,
      db,
      dc,
      pStep: [lA.pHighTotal, lA.pLowTotal, lB.pHighTotal, lB.pLowTotal, lC.pHighTotal, lC.pLowTotal],
      pCondStep: [lA.pHighCond, lA.pLowCond, lB.pHighCond, lB.pLowCond, lC.pHighCond, lC.pLowCond],
      pCond25Step: [lA.pHighCond25W, lA.pLowCond25W, lB.pHighCond25W, lB.pLowCond25W, lC.pHighCond25W, lC.pLowCond25W],
      pSwStep: [lA.pHighSw, lA.pLowSw, lB.pHighSw, lB.pLowSw, lC.pHighSw, lC.pLowSw],
      pDeadStep: [lA.pHighDead, lA.pLowDead, lB.pHighDead, lB.pLowDead, lC.pHighDead, lC.pLowDead],
      ia,
      ib,
      ic,
    };
  };

  const resolvedSpatial = resolveSpatialThermalNetwork(model);
  const solver = new StarCoupled6MosThermalSolver(model, ctrl.tAmbC);
  const preheatDurationSec = i0 > preheatStartIdx ? Math.max(0, iaCh.t[i0] - iaCh.t[preheatStartIdx]) : 0;

  if (i0 > preheatStartIdx && gateThermalMode === 'preheat') {
    for (let idx = preheatStartIdx; idx < i0; idx++) {
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
  const sumCond25Energy = new Float64Array(6);
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
  let phaseCurrentKclEnergyA2s = 0;
  let phaseCurrentReferenceEnergyA2s = 0;
  let phaseCurrentKclDurationSec = 0;
  let previousKclSqA2: number | null = null;
  let previousPhaseReferenceSqA2: number | null = null;
  let phaseCurrentKclMaxA = 0;
  let phaseCurrentKclSampleCount = 0;

  for (let k = 0; k < len; k++) {
    const idx = i0 + k;
    const tCurr = iaCh.t[idx];
    time[k] = tCurr;

    const curTj = solver.getJunctionTemps();
    const stepRes = evalStepLossesAt(idx, curTj, true);
    if (icSampler) {
      const kcl = stepRes.ia + stepRes.ib + stepRes.ic;
      const kclSq = kcl * kcl;
      const phaseReferenceSq = (stepRes.ia * stepRes.ia + stepRes.ib * stepRes.ib + stepRes.ic * stepRes.ic) / 3;
      if (k > 0 && previousKclSqA2 !== null && previousPhaseReferenceSqA2 !== null) {
        const dtKcl = tCurr - iaCh.t[idx - 1];
        if (!Number.isFinite(dtKcl) || dtKcl <= 0) {
          throw new Error(`三相电流 KCL 质量审计遇到非正或非有限时间步长：${dtKcl}。`);
        }
        // Time-weighted RMS is required because imported/manual-downsampled
        // source timestamps can be nonuniform. Equal sample weighting would
        // bias the KCL audit toward densely sampled sections.
        phaseCurrentKclEnergyA2s += 0.5 * (previousKclSqA2 + kclSq) * dtKcl;
        phaseCurrentReferenceEnergyA2s += 0.5 * (previousPhaseReferenceSqA2 + phaseReferenceSq) * dtKcl;
        phaseCurrentKclDurationSec += dtKcl;
      }
      previousKclSqA2 = kclSq;
      previousPhaseReferenceSqA2 = phaseReferenceSq;
      phaseCurrentKclMaxA = Math.max(phaseCurrentKclMaxA, Math.abs(kcl));
      phaseCurrentKclSampleCount++;
    }
    if (stepRes.pStep.some((p) => !Number.isFinite(p) || p < 0)) {
      throw new Error(`FOC 热损耗在 t=${tCurr.toExponential(6)}s 出现 NaN/Inf 或负功率；已阻止将非法损耗注入热网络。`);
    }

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
          sumCond25Energy[m] += stepRes.pCond25Step[m] * dt;
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
  const armJcs = buildPerSwitchJcChains(model);
  const jcStagesForTau = armJcs[0];
  const brdStages = model.zthBoard.length > 0 ? model.zthBoard : DEFAULT_FOC_MODEL.zthBoard;
  const rJcTotalByArm = armJcs.map((chain) => chain.reduce((s, c) => s + c.r, 0));
  const rBrdTotal = brdStages.reduce((s, c) => s + c.r, 0);
  const tauMaxBoardSec = computeDominantCauerTauSec(jcStagesForTau, brdStages);

  const alpha = mos.tempCoeffAlphaPerC || 0;
  const evalSwSteadyAtTj =
    hasDptLut && lutActiveDimsLatest.includes('Tj') && mos.dptLut
      ? (tjCand: number[]): number[] => {
          const pSwEnergyCand = [0, 0, 0, 0, 0, 0];
          const evalCount = len > 1 && useTimeAvg ? len - 1 : len;
          const maxSteadySamples = 4096;
          let totalWeight = 0;
          if (useTimeAvg && len > 1) {
            // Use exact piecewise-constant elapsed-time weighting (matching the main energy loop).
            // For very long captures (>4096 samples), select samples by elapsed time so dense
            // low-current segments cannot starve coarse high-current segments.
            const tFirst = iaCh.t[i0];
            const tLast = iaCh.t[i0 + len - 1];
            const minSpanDt = evalCount > maxSteadySamples ? (tLast - tFirst) / maxSteadySamples : 0;
            let k = 0;
            while (k < len - 1) {
              const idx = i0 + k;
              const tCurr = iaCh.t[idx];
              let nextK = k + 1;
              if (minSpanDt > 0) {
                while (nextK < len - 1 && iaCh.t[i0 + nextK] - tCurr < minSpanDt) {
                  nextK++;
                }
              }
              const dtSpan = iaCh.t[i0 + nextK] - tCurr;
              if (Number.isFinite(dtSpan) && dtSpan > 0) {
                const ia = iaSampler.sample(tCurr, idx);
                const ib = ibSampler.sample(tCurr, idx);
                const ic = icSampler ? icSampler.sample(tCurr, idx) : -(ia + ib);
                const vbus = vbusSampler ? vbusSampler.sample(tCurr, idx) : ctrl.vBusConstV;
                const da = duty.a[k];
                const db = duty.b[k];
                const dc = duty.c[k];
                const lA = computePhaseMosLosses(ia, da, vbus, tjCand[0], tjCand[1], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);
                const lB = computePhaseMosLosses(ib, db, vbus, tjCand[2], tjCand[3], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);
                const lC = computePhaseMosLosses(ic, dc, vbus, tjCand[4], tjCand[5], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);
                pSwEnergyCand[0] += (lA.pHighSw + lA.pHighDead) * dtSpan;
                pSwEnergyCand[1] += (lA.pLowSw + lA.pLowDead) * dtSpan;
                pSwEnergyCand[2] += (lB.pHighSw + lB.pHighDead) * dtSpan;
                pSwEnergyCand[3] += (lB.pLowSw + lB.pLowDead) * dtSpan;
                pSwEnergyCand[4] += (lC.pHighSw + lC.pHighDead) * dtSpan;
                pSwEnergyCand[5] += (lC.pLowSw + lC.pLowDead) * dtSpan;
                totalWeight += dtSpan;
              }
              k = nextK;
            }
          } else {
            const strideSteady = Math.max(1, Math.floor(len / 240));
            for (let k = 0; k < len; k += strideSteady) {
              const idx = i0 + k;
              const tCurr = iaCh.t[idx];
              const ia = iaSampler.sample(tCurr, idx);
              const ib = ibSampler.sample(tCurr, idx);
              const ic = icSampler ? icSampler.sample(tCurr, idx) : -(ia + ib);
              const vbus = vbusSampler ? vbusSampler.sample(tCurr, idx) : ctrl.vBusConstV;
              const da = duty.a[k];
              const db = duty.b[k];
              const dc = duty.c[k];
              const lA = computePhaseMosLosses(ia, da, vbus, tjCand[0], tjCand[1], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);
              const lB = computePhaseMosLosses(ib, db, vbus, tjCand[2], tjCand[3], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);
              const lC = computePhaseMosLosses(ic, dc, vbus, tjCand[4], tjCand[5], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);
              pSwEnergyCand[0] += lA.pHighSw + lA.pHighDead;
              pSwEnergyCand[1] += lA.pLowSw + lA.pLowDead;
              pSwEnergyCand[2] += lB.pHighSw + lB.pHighDead;
              pSwEnergyCand[3] += lB.pLowSw + lB.pLowDead;
              pSwEnergyCand[4] += lC.pHighSw + lC.pHighDead;
              pSwEnergyCand[5] += lC.pLowSw + lC.pLowDead;
              totalWeight += 1;
            }
          }
          return pSwEnergyCand.map((v) => v / Math.max(1e-18, totalWeight));
        }
      : undefined;

  const steadySolve = solveCoupledThermalSteadyState({
    pCond25W: useTimeAvg
      ? Array.from(sumCond25Energy, (energy) => energy / accumulatedDt)
      : summaries.map((s) => s.pCondAvgW / Math.max(0.05, getFocMosRdsFactorAtTj(mos, s.tjAvgC))),
    pFixedW: summaries.map((s) => s.pSwAvgW + s.pDeadAvgW),
    alphaPerC: alpha,
    evalCondFactorAtTj: mos.rdsOnTempCurve
      ? (tjVec) => tjVec.map((tj) => getFocMosRdsFactorAtTj(mos, tj))
      : undefined,
    rJcTotalByArm,
    rBrdTotal,
    tAmbC: ctrl.tAmbC,
    tInitSeedC: summaries.map((s) => s.tjAvgC),
    spatial: resolvedSpatial,
    evalFixedPowerAtTj: evalSwSteadyAtTj,
  });

  const tBoardSteadyEstC = steadySolve.tBoardSteadyC;
  const tjSteadyEstByKey = {} as Record<MosSwitchKey, number>;
  let tjSteadyMaxEstC = -Infinity;
  MOS_SWITCH_KEYS.forEach((k, m) => {
    tjSteadyEstByKey[k] = steadySolve.tjSteadyC[m];
    if (steadySolve.tjSteadyC[m] > tjSteadyMaxEstC) tjSteadyMaxEstC = steadySolve.tjSteadyC[m];
  });

  const convergenceForTemperature = (steadyC: number, finalC: number): number => {
    const steadyRise = steadyC - ctrl.tAmbC;
    const finalRise = finalC - ctrl.tAmbC;
    if (steadySolve.thermalRunaway || !Number.isFinite(steadyRise) || !Number.isFinite(finalRise)) return 0;
    if (Math.abs(steadyRise) <= 0.05) return Math.abs(finalRise) <= 0.05 ? 100 : 0;
    return Math.max(0, Math.min(100, (finalRise / steadyRise) * 100));
  };
  const boardConvergencePct = convergenceForTemperature(tBoardSteadyEstC, tBoardFinalC);
  const junctionConvergenceByKey = MOS_SWITCH_KEYS.map((key) =>
    convergenceForTemperature(tjSteadyEstByKey[key], tj[key][len - 1])
  );
  const junctionConvergencePct = Math.min(...junctionConvergenceByKey);
  const thermalConvergencePct = Math.min(boardConvergencePct, junctionConvergencePct);
  const phaseCurrentKclRmsA = icSampler && phaseCurrentKclDurationSec > 0
    ? Math.sqrt(phaseCurrentKclEnergyA2s / phaseCurrentKclDurationSec)
    : null;
  const phaseCurrentReferenceRmsA = icSampler && phaseCurrentKclDurationSec > 0
    ? Math.sqrt(phaseCurrentReferenceEnergyA2s / phaseCurrentKclDurationSec)
    : null;
  const phaseCurrentKclRelativePct = phaseCurrentKclRmsA !== null && phaseCurrentReferenceRmsA !== null
    ? (phaseCurrentKclRmsA / Math.max(phaseCurrentReferenceRmsA, 1e-9)) * 100
    : null;

  const maxSubDtOverTau = solver.getMaxSubDtOverTau();
  const finalThermalState = solver.getStateSnapshot();
  const boardFinalVec = solver.getBoardTempsBySwitch();
  const tBoardByKey = {} as Record<MosSwitchKey, number>;
  MOS_SWITCH_KEYS.forEach((k, m) => {
    tBoardByKey[k] = boardFinalVec[m];
  });

  const eossSource: FocSimulationResult['eossSource'] = mos.eossAlreadyIncludedInEsw
    ? 'included_in_esw'
    : qossCoveredByQr(mos)
    ? 'included_in_qrr'
    : mos.eossCurve
    ? 'nonlinear_curve'
    : (mos.eossUj ?? 0) > 0
    ? 'vbus_sq_approx'
    : 'none';

  const warnings: string[] = [...alignmentWarnings];
  const missingLossInputs: string[] = [];
  const assumptionReasons: string[] = [];
  const hasSwitchingEnergyInput = hasDptLut || mos.eonPlusEoffUj > 0;
  if (!hasSwitchingEnergyInput) missingLossInputs.push('Eon+Eoff/DPT');
  if (!hasDptLut && !mos.eonIncludesQrr && mos.qrrNc <= 0) missingLossInputs.push('Qrr');
  if (!mos.eossAlreadyIncludedInEsw && !mos.eossCurve && (mos.eossUj ?? 0) <= 0 && !qossCoveredByQr(mos)) missingLossInputs.push('Eoss');
  if (mos.rdsDataConfirmed !== true) assumptionReasons.push('Rds(on)@25°C 未按目标器件 Vgs/测试条件确认');
  if (!hasDptLut) assumptionReasons.push('开关损耗采用单点 Eon+Eoff 标量缩放，而非多工况 DPT LUT');
  if (model.modelKind !== 'datasheet_constrained' || model.zthValidation?.passed !== true) {
    assumptionReasons.push('热网络未通过目标器件数据手册约束及拆分一致性验证');
  }
  if (missingLossInputs.length > 0) {
    warnings.push(`损耗模型输入不完整：缺少 ${missingLossInputs.join('、')}；对应损耗按 0 处理，P_inv 与 Tj 是已建模损耗下的偏低估算，不得用于器件热设计签核。`);
  }
  if (mos.rdsDataConfirmed !== true) {
    warnings.push('Rds(on)@25°C 当前按界面起算值参与导通损耗计算，但确认框未勾选；结果必须标为假设估算，不能解释为目标 MOS 实测/数据手册参数结果。');
  }
  const resultQualification: FocSimulationResult['resultQualification'] = missingLossInputs.length > 0
    ? 'INCOMPLETE_LOSS_MODEL'
    : assumptionReasons.length > 0
    ? 'ASSUMPTION_BASED'
    : 'DEVICE_PARAMETERIZED';
  const qualificationReasons = [...missingLossInputs.map((x) => `未提供 ${x} 损耗数据`), ...assumptionReasons];
  if (model.modelKind === 'fallback_default' || model.modelKind === 'demo_builtin' || !model.modelKind) {
    warnings.push(`当前热网络来源为 ${model.modelKind || '未标注模型'}，不是该 MOSFET/PCB 的实测热阻网络；Tj 只可用于方法验证或趋势比较，不得作为器件热设计签核值。`);
  }
  if (model.zthBoard.length === 0 || model.zthJC.length === 0) {
    warnings.push('输入热模型存在空 JC/Board 阶梯，仿真已使用内置默认阶梯补齐；结果不代表实际封装与 PCB 热路径。');
  }
  if (resolvedSpatial.mode === 'shared_board') {
    warnings.push('当前六管热网络采用六个器件支路汇入单一共享 Board 节点的集总模型；未输入 PCB 铜厚/铜箔/过孔/布局和六管互热阻矩阵时，不代表真实 PCB 空间温度场，热点结论仅适用于该集总网络。');
  } else {
    warnings.push(`已启用六管热拓扑模式：${resolvedSpatial.provenanceLabel}。`);
  }
  if (model.modelKind === 'fallback_default') {
    warnings.push('当前使用内置默认参考热网络（非具体 MOS 数据手册/实测 Zth）；结温仅为演示性或初步筛查估算，不得用于器件选型签核或安全裕量结论。');
  } else if (model.modelKind === 'pad_ambient') {
    warnings.push('警告：当前热网络源自 PCB/焊盘测温 (pad_ambient)，缺失真实芯片结-壳 ZthJC，算出的 Tj 仅代表传感器等效点温升！');
  } else if (model.modelKind === 'demo_builtin') {
    warnings.push('当前使用内置 FOC Demo 参考热模型，切换至实测波形时请在 Tab 1 反演或手动设定器件 Zth 参数。');
  }
  if (hasDptLut && mos.dptLut) {
    const activeLbl = lutActiveDimsLatest.length > 0 ? lutActiveDimsLatest.join('×') : '0D';
    const collapsedLbl = lutCollapsedDimsLatest.length > 0 ? `；退化常数维度: [${lutCollapsedDimsLatest.join(', ')}]` : '';
    warnings.push(
      `MOS 开关损耗已启用 ${mos.dptLut.length} 点 DPT 查找表 (${activeLbl} 插值, status=${lutStatusLatest || 'VALID'}, Tj来源=${lutTjProvLatest}, Rg来源=${lutRgProvLatest}${collapsedLbl})。`
    );
    if (lutExtrapolatedSamples > 0 || lutOutOfRangeCount > 0) {
      warnings.push(
        `注意：DPT LUT 共有 ${Math.max(lutExtrapolatedSamples, lutOutOfRangeCount)} 次查询超出实测凸包/边界 (OUT_OF_RANGE，Vbus=[${opVMin.toFixed(1)}~${opVMax.toFixed(1)}]V, I_max=${opIMax.toFixed(1)}A vs LUT [${lutVMin.toFixed(1)}~${lutVMax.toFixed(1)}]V × [${lutIMin.toFixed(1)}~${lutIMax.toFixed(1)}]A)。`
      );
    }
  } else {
    warnings.push('MOS 开关损耗当前采用参考 Eon+Eoff 标量按 V/I 缩放；其口径按“单颗硬开关 MOS、每 PWM 周期的 Eon+Eoff”解释，并按电流方向分配至对应硬开关器件，不代表整桥/半桥六管损耗合计值。若数据手册/DPT 的能量口径是双管或整桥合计，必须先换算。未提供覆盖 Vbus、Id、Tj、Rg 的器件 DPT/LUT 时，不应把该结果作为最坏开关损耗签核值。');
    if (scalarWideScaleSamples > 0) {
      warnings.push(
        `注意：共有 ${scalarWideScaleSamples} 步仿真工况相对单点参考 (Vref=${mos.vRefV.toFixed(1)}V, Iref=${mos.iRefA.toFixed(1)}A) 缩放倍率超过 2× 或低于 0.25×（仿真峰值 I_max=${opIMax.toFixed(1)}A, Vbus=[${opVMin.toFixed(1)}~${opVMax.toFixed(1)}]V），非线性开关损耗偏差可能较大。`
      );
    }
  }
  if (eossSource === 'vbus_sq_approx') {
    warnings.push('当前 Eoss 仅输入 Vref 处的单点能量，并按 Eoss∝Vbus² 低精度 V² 近似缩放（等效假设 Coss 不随电压变化）；真实 MOS Coss 通常强非线性，需用器件 Eoss(V)/Qoss(V) 曲线替代。');
  } else if (eossSource === 'nonlinear_curve') {
    warnings.push(`Eoss 已采用非线性 ${mos.eossCurve!.kind.toUpperCase()} 曲线 PCHIP 插值计算（来源=${mos.eossCurve!.provenance ?? 'unspecified'}）；超出曲线定义域的脉冲会拒绝计算，不使用边界截断值。`);
    if (mos.eossCurve!.referenceTemperatureC !== undefined) {
      const tjCurveDelta = Math.max(...summaries.map((summary) => Math.abs(summary.tjAvgC - mos.eossCurve!.referenceTemperatureC!)));
      if (tjCurveDelta > 10) {
        warnings.push(`Eoss 曲线参考温度为 ${mos.eossCurve!.referenceTemperatureC}°C，当前六管平均结温与参考温度最大偏差 ${tjCurveDelta.toFixed(1)}°C；当前曲线无温度维度，未进行温度修正，Eoss 结果属于参考温度曲线估算。`);
      }
    }
  } else if (eossSource === 'included_in_esw') {
    warnings.push('已启用 Eoss 防重算保护 (eossAlreadyIncludedInEsw=true)：Esw 已涵盖 Coss 充放电损耗，独立 Eoss 项置零。');
  } else if (eossSource === 'included_in_qrr') {
    warnings.push('当前 Qr 按 Nexperia 定义包含 Qoss（Qr=Qs+Qoss），已屏蔽独立 Eoss，避免同一换流电荷重复计量；Qr×Vbus 仍是总恢复能量的一阶近似，不等同于 DPT 波形能量积分。');
  }
  if (partialDutySelected) {
    warnings.push('仅选择了部分外部 Duty 通道，需同时指定 Duty_A / Duty_B / Duty_C 三路才会启用外部占空比，当前已回退为无传感器重构。');
  }
  if (useExternalDuty && dutyPctInferredChannels.length > 0) {
    warnings.push(`外部占空比通道 ${dutyPctInferredChannels.join('、')} 未标注单位，但同组三相数据提示按百分比 (0~100%) 解释；已仅对无单位通道按百分比缩放 0.01，明确标注 pu/% 的通道各自按其单位处理。建议在源文件明确标注单位。`);
  }
  if (useExternalDuty && dutyBinaryPulseSuspected) {
    warnings.push('外部 Duty_A/B/C 超过 95% 样本处于精确 0 或 1（疑似原始 PWM 开关方波脉冲而非周期平均占空比），开关损耗将被按钳位跳过。');
  }
  if (!steadySolve.converged && !steadySolve.thermalRunaway) {
    warnings.push('耦合热稳态求解器未达到收敛条件；稳态结温外推仅供诊断，不得作为稳态安全签核依据。');
  }
  if (junctionConvergencePct < 90) {
    warnings.push(`六颗 MOS 中最慢结温收敛度仅 ${junctionConvergencePct.toFixed(1)}%（Board=${boardConvergencePct.toFixed(1)}%）；当前瞬态时长不足以代表结温稳态，不能只依据 T_board 判断热稳定。`);
  }
  if (phaseCurrentKclRelativePct !== null && phaseCurrentKclRmsA !== null && phaseCurrentKclRelativePct > 5) {
    warnings.push(`三相电流 KCL 残差 RMS=${phaseCurrentKclRmsA.toFixed(3)}A，占三相 RMS 参考值 ${phaseCurrentKclRelativePct.toFixed(1)}%（峰值残差 ${phaseCurrentKclMaxA.toFixed(3)}A）；请检查相序、探头极性、采样同步或三相电流重构，六管损耗分配可能失真。`);
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
      `相电流基波电周期采样点数严重不足（约 ${pointsPerElecCycle.toFixed(1)} 点/电周期 < 6），峰值/RMS 与六管损耗分配可能明显失真；该波形不宜用于热设计签核。注意：该准则针对电流基波包络，并非开关载波采样判据。`
    );
  } else if (pointsPerElecCycle !== null && pointsPerElecCycle < 20) {
    warnings.push(
      `相电流基波采样分辨率偏低（约 ${pointsPerElecCycle.toFixed(1)} 点/电周期 < 20），热结果仅适合趋势估算；建议提高采样密度并确认峰值电流未被降采样丢失。该模型按平均开关损耗计算，不解析 PWM 载波边沿。`
    );
  }
  if (maxSubDtOverTau > 0.25) {
    warnings.push(
      `波形采样步长远大于最快热时间常数 τ_min=${(solver.getMinTau() * 1e3).toFixed(3)}ms，经 4096 级子步细分后仍有 max(subDt/τ_min)=${maxSubDtOverTau.toFixed(2)} > 0.25，快瞬态芯片结温峰值可能被数值平滑。`
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
    resultQualification,
    qualificationReasons,
    time,
    tj,
    pMos,
    pInvTotal,
    tBoard,
    tBoardByKey,
    thermalTopologyMode: resolvedSpatial.mode,
    spatialThermalProvenance: resolvedSpatial.provenanceLabel,
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
    junctionConvergencePct,
    phaseCurrentKclRmsA,
    phaseCurrentKclRelativePct,
    steadyConverged: steadySolve.converged,
    steadyThermalRunaway: steadySolve.thermalRunaway,
    overmodulatedCount,
    zeroCurrentFallbackCount,
    maxSubDtOverTau,
    pointsPerElecCycle,
    finalThermalState,
    dutySource: useExternalDuty ? 'external' : 'reconstructed',
    dptLutDiagnostics: hasDptLut
      ? {
          status: lutStatusLatest || 'VALID',
          activeDimensions: lutActiveDimsLatest,
          collapsedDimensions: lutCollapsedDimsLatest,
          outOfRangeCount: lutOutOfRangeCount,
          tjProvenance: lutTjProvLatest,
          rgProvenance: lutRgProvLatest,
        }
      : undefined,
    eossSource,
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
  const finiteInRange = (value: number, min: number, max: number): boolean =>
    Number.isFinite(value) && value >= min && value <= max;
  if (!opts || !opts.model || !opts.mos) throw new Error('堵转热扫描缺少 MOS 参数或热模型。');
  if (opts.model.splitFeasible === false) {
    throw new Error(opts.model.splitMeta?.warning || '热模型 ZthJC / Zth_board 手册约束拆分不可行，已拒绝堵转热扫描。');
  }
  if (!finiteInRange(opts.iPeakA, 1e-6, 1e6)) throw new Error('堵转峰值电流 I_pk 必须为有限正数。');
  if (!finiteInRange(opts.tjLimitC, -273.14, 2000)) throw new Error('Tj_limit 必须高于绝对零度且不超过 2000°C。');
  if (!finiteInRange(opts.tAmbC, -273.14, 1000)) throw new Error('环境温度必须高于绝对零度且不超过 1000°C。');
  if (!finiteInRange(opts.vBusV, 1e-6, 2000)) throw new Error('堵转母线电压 Vbus 必须为有限正数且不超过 2000V。');
  if (!finiteInRange(opts.fswHz, 1, 5e6)) throw new Error('堵转开关频率 fswHz 必须为 1Hz～5MHz。');
  if (!finiteInRange(opts.tDeadNs, 0, 1e6)) throw new Error('堵转死区时间必须为 0～1,000,000ns。');
  if (!finiteInRange(opts.modDepthM, 0, 2)) throw new Error('堵转调制深度必须位于 0～2。');
  if (opts.pfAngleDeg !== undefined && !finiteInRange(opts.pfAngleDeg, -180, 180)) throw new Error('堵转 PF 相角必须位于 -180°～180°。');
  if (!['SVPWM', 'DPWM1', 'SPWM'].includes(opts.modulation)) throw new Error('堵转调制模式无效。');
  if (opts.horizonSec !== undefined && !finiteInRange(opts.horizonSec, 1e-3, 3600)) throw new Error('堵转热瞬态计算时域必须在 1ms～3600s。');
  if (opts.tInitialBoardC !== undefined && !finiteInRange(opts.tInitialBoardC, -273.14, 2000)) throw new Error('初始 Board 温度无效。');
  if (opts.rPhaseOhm !== undefined && !finiteInRange(opts.rPhaseOhm, 1e-9, 1e6)) throw new Error('相电阻 R_phase 必须为有限正数。');
  if (opts.mos.rdsOnTempCurve) validateRdsOnTempCurveForMos(opts.mos);
  validateMosEnergyAccounting(opts.mos);
  if (!finiteInRange(opts.mos.rdsOn25Mohm, Number.EPSILON, 1e6) ||
      !finiteInRange(opts.mos.tempCoeffAlphaPerC, 0, 0.05) ||
      !finiteInRange(opts.mos.vsdV, 0, 10) ||
      !finiteInRange(opts.mos.eonPlusEoffUj, 0, 1e9) ||
      !finiteInRange(opts.mos.vRefV, Number.EPSILON, 1e6) ||
      !finiteInRange(opts.mos.iRefA, Number.EPSILON, 1e6) ||
      !finiteInRange(opts.mos.qrrNc, 0, 1e9) ||
      (opts.mos.qrrIrefA !== undefined && !finiteInRange(opts.mos.qrrIrefA, Number.EPSILON, 1e6)) ||
      (opts.mos.eossUj !== undefined && !finiteInRange(opts.mos.eossUj, 0, 1e9))) {
    throw new Error('堵转扫描 MOS 损耗参数无效；请检查 Rds(on)、温度系数、Vsd、Eon/Eoff、Vref/Iref、Qrr/Eoss。');
  }
  const jcStages = opts.model.zthJC.length > 0 ? opts.model.zthJC : DEFAULT_FOC_MODEL.zthJC;
  const boardStages = opts.model.zthBoard.length > 0 ? opts.model.zthBoard : DEFAULT_FOC_MODEL.zthBoard;
  for (const [label, stages] of [['ZthJC', jcStages], ['ZthBoard', boardStages]] as const) {
    if (stages.length === 0 || stages.some((stage) => !finiteInRange(stage.r, Number.EPSILON, 1e9) || !finiteInRange(stage.c, Number.EPSILON, 1e12))) {
      throw new Error(`堵转扫描 ${label} Cauer 阶梯必须全部为有限正 R/C。`);
    }
  }
  if (opts.model.perSwitchRjcScale && (opts.model.perSwitchRjcScale.length !== 6 || opts.model.perSwitchRjcScale.some((v) => !finiteInRange(v, 0.01, 100)))) {
    throw new Error('堵转扫描 perSwitchRjcScale 必须是 6 个 0.01～100 的有限正数。');
  }
  if (opts.model.perSwitchPadOffsetCPerW && (opts.model.perSwitchPadOffsetCPerW.length !== 6 || opts.model.perSwitchPadOffsetCPerW.some((v) => !finiteInRange(v, 0, 1e6)))) {
    throw new Error('堵转扫描 perSwitchPadOffsetCPerW 必须是 6 个有限非负值。');
  }
  if (opts.initialThermalState) {
    const st = opts.initialThermalState;
    const armChains = buildPerSwitchJcChains(opts.model);
    if (!Array.isArray(st.armT) || st.armT.length !== 6 ||
        st.armT.some((chain, index) => !Array.isArray(chain) || chain.length !== armChains[index].length || chain.some((v) => !finiteInRange(v, -273.14, 2000))) ||
        !Array.isArray(st.brdT) || st.brdT.length !== boardStages.length || st.brdT.some((v) => !finiteInRange(v, -273.14, 2000)) ||
        !finiteInRange(st.tBoardC, -273.14, 2000)) {
      throw new Error('继承的热网络节点状态与当前 Cauer 模型阶数不匹配或包含非法温度，拒绝将旧状态映射到新热模型。请重新运行 MOS Thermal 或使用冷态初温。');
    }
  }
  const armJcs = buildPerSwitchJcChains(opts.model);
  const brd = opts.model.zthBoard.length > 0 ? opts.model.zthBoard : DEFAULT_FOC_MODEL.zthBoard;
  const rJcByArm = armJcs.map((chain) => chain.reduce((s, c) => s + c.r, 0));
  const rBrd = brd.reduce((s, c) => s + c.r, 0);

  const stallMode = opts.stallDutyMode === 'user_m' ? 'user_m' : 'resistive';
  const rPhaseUsedOhm =
    opts.rPhaseOhm !== undefined && Number.isFinite(opts.rPhaseOhm) && opts.rPhaseOhm > 0
      ? opts.rPhaseOhm
      : 0.25;
  const rTotalPhase = rPhaseUsedOhm + Math.max(0, opts.mos.rdsOn25Mohm * 1e-3);
  const svpwmCeiling = getModulationLinearCeiling('SVPWM');
  const deadEdgeDuty = opts.tDeadNs * 1e-9 * opts.fswHz;
  if (deadEdgeDuty >= 0.45) {
    throw new Error(`堵转死区占空比过大 (${(deadEdgeDuty * 100).toFixed(1)}%)，单边死区已占用 ≥45% 开关周期，无法建立有效 PWM 脉冲。`);
  }
  // True dead-time-safe linear SVPWM ceiling: max duty = 0.5 + (sqrt(3)/4)*m must stay strictly below (1 - deadEdgeDuty)
  // across all 72 swept electrical angles so narrow-pulse deletion is never entered silently.
  const svpwmUsableCeiling =
    deadEdgeDuty > 0
      ? svpwmCeiling * Math.max(0.01, 1 - 2 * deadEdgeDuty - 1e-5)
      : svpwmCeiling;
  const mReqStall = (2 * opts.iPeakA * rTotalPhase) / Math.max(1, opts.vBusV);
  const stallVoltageLimited = stallMode === 'resistive' && mReqStall > svpwmUsableCeiling + 1e-6;
  const effM =
    stallMode === 'resistive'
      ? Math.min(svpwmUsableCeiling, Math.max(0.005, mReqStall))
      : opts.modDepthM;
  const effMod: FocModulationMode = stallMode === 'resistive' ? 'SVPWM' : opts.modulation;
  const effPfAngleDeg = stallMode === 'user_m' ? (opts.pfAngleDeg ?? 0) : 0;

  const anglesDeg: number[] = [];
  const steadyMaxTjPerAngle: number[] = [];

  let worstAngleDeg = 0;
  let worstSwitch: MosSwitchKey = 'AH';
  let worstSteadyTjC = -Infinity;

  const twoPi3 = (2 * Math.PI) / 3;
  const iRmsPhase = opts.iPeakA / Math.SQRT2;
  // Preserve the physical Ipk^2/2 exactly; a fixed 1e-9 A² floor inflated
  // sinusoidal-equivalent I²t for small but valid requested currents.
  const iRmsSq = iRmsPhase * iRmsPhase;

  let stallSteadyConverged = true;
  let stallThermalRunaway = false;

  const stallSpatial = resolveSpatialThermalNetwork(opts.model);
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
      evalCondFactorAtTj: opts.mos.rdsOnTempCurve
        ? (tjVec) => tjVec.map((tj) => getFocMosRdsFactorAtTj(opts.mos, tj))
        : undefined,
      rJcTotalByArm: rJcByArm,
      rBrdTotal: rBrd,
      tAmbC: opts.tAmbC,
      spatial: stallSpatial,
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
    }
  }

  // A nonuniform inherited junction-temperature vector can make the fastest
  // transient Tj-limit crossing occur at a different electrical angle than
  // the maximum steady-state angle. Evaluate the transient for every angle.
  // Honor the caller's requested horizon exactly. The earlier 5 s floor
  // contradicted the public 1 ms..3600 s validation and could report a t_safe
  // result outside the requested observation window. Keep a positive first
  // logarithmic step even for sub-millisecond-scale early dynamics.
  const horizon = opts.horizonSec ?? 120;
  const nPts = 280;
  const tMin = Math.min(1e-3, horizon / 1e3);
  const transientTime = new Float64Array(nPts);
  for (let i = 0; i < nPts; i++) {
    transientTime[i] = i === 0 ? 0 : tMin * Math.pow(horizon / tMin, (i - 1) / (nPts - 2));
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

  let selectedTransient: {
    angleDeg: number;
    tSafeSec: number | null;
    terminalMaxTjC: number;
    worstSwitch: MosSwitchKey;
    phaseSquaredRatio: number;
    worstTj: Float32Array;
  } | null = null;

  for (let angleIndex = 0; angleIndex < anglesDeg.length; angleIndex++) {
    const angleDeg = anglesDeg[angleIndex];
    const angleRad = (angleDeg * Math.PI) / 180;
    const iaAngle = opts.iPeakA * Math.cos(angleRad);
    const ibAngle = opts.iPeakA * Math.cos(angleRad - twoPi3);
    const icAngle = opts.iPeakA * Math.cos(angleRad + twoPi3);
    const recAngle = reconstructSensorlessDutySample(iaAngle, ibAngle, icAngle, effMod, effM, effPfAngleDeg);
    const maxPhaseSq = Math.max(iaAngle * iaAngle, ibAngle * ibAngle, icAngle * icAngle);
    const phaseSquaredRatio = maxPhaseSq / iRmsSq;

    const solver = new StarCoupled6MosThermalSolver(
      opts.model,
      opts.tAmbC,
      opts.tInitialBoardC ?? opts.tAmbC,
      opts.initialThermalState
    );
    const angleTransientWorstTj = new Float32Array(nPts);
    let angleTSafeSec: number | null = null;
    let terminalMaxTjC = -Infinity;
    let angleWorstSwitch: MosSwitchKey = 'AH';
    let crossingWorstSwitch: MosSwitchKey | null = null;

    for (let i = 0; i < nPts; i++) {
      const cur = solver.getJunctionTemps();
      if (cur.some((v) => !Number.isFinite(v))) {
        throw new Error(`堵转热瞬态在 θ=${angleDeg}°、t=${transientTime[i].toExponential(4)}s 出现非有限结温；已阻止返回不可信 t_safe。`);
      }
      let maxNow = -Infinity;
      let maxIdx = 0;
      for (let m = 0; m < cur.length; m++) {
        if (cur[m] > maxNow) { maxNow = cur[m]; maxIdx = m; }
      }
      angleTransientWorstTj[i] = maxNow;
      angleWorstSwitch = MOS_SWITCH_KEYS[maxIdx];
      terminalMaxTjC = maxNow;

      if (i === 0 && maxNow >= opts.tjLimitC) {
        angleTSafeSec = 0;
        crossingWorstSwitch = MOS_SWITCH_KEYS[maxIdx];
      }

      if (i < nPts - 1) {
        const lA = computePhaseMosLosses(iaAngle, recAngle.da, opts.vBusV, cur[0], cur[1], effMod, opts.fswHz, opts.tDeadNs, opts.mos);
        const lB = computePhaseMosLosses(ibAngle, recAngle.db, opts.vBusV, cur[2], cur[3], effMod, opts.fswHz, opts.tDeadNs, opts.mos);
        const lC = computePhaseMosLosses(icAngle, recAngle.dc, opts.vBusV, cur[4], cur[5], effMod, opts.fswHz, opts.tDeadNs, opts.mos);
        const ps = [lA.pHighTotal, lA.pLowTotal, lB.pHighTotal, lB.pLowTotal, lC.pHighTotal, lC.pLowTotal];
        const dtStep = transientTime[i + 1] - transientTime[i];
        const stateBeforeStep = angleTSafeSec === null ? solver.getStateSnapshot() : null;
        solver.step(dtStep, ps);

        if (angleTSafeSec === null && stateBeforeStep) {
          const nextTemps = solver.getJunctionTemps();
          if (nextTemps.some((v) => !Number.isFinite(v))) {
            throw new Error(`堵转热瞬态在 θ=${angleDeg}°、t=${transientTime[i + 1].toExponential(4)}s 出现非有限结温；已阻止返回不可信 t_safe。`);
          }
          const nextMax = Math.max(...nextTemps);
          if (nextMax >= opts.tjLimitC) {
            // Refine the first crossing inside this logarithmic output interval.
            // Power is held constant over the interval, matching the main
            // solver's piecewise-constant loss update, while the implicit RC
            // network is replayed from the exact pre-step state.
            let lo = 0;
            let hi = dtStep;
            let crossingTemps = nextTemps;
            for (let refine = 0; refine < 18; refine++) {
              const mid = 0.5 * (lo + hi);
              const probe = new StarCoupled6MosThermalSolver(
                opts.model,
                opts.tAmbC,
                opts.tInitialBoardC ?? opts.tAmbC,
                stateBeforeStep
              );
              probe.step(mid, ps);
              const probeTemps = probe.getJunctionTemps();
              if (Math.max(...probeTemps) >= opts.tjLimitC) {
                hi = mid;
                crossingTemps = probeTemps;
              } else {
                lo = mid;
              }
            }
            angleTSafeSec = transientTime[i] + hi;
            let crossingIdx = 0;
            for (let m = 1; m < crossingTemps.length; m++) {
              if (crossingTemps[m] > crossingTemps[crossingIdx]) crossingIdx = m;
            }
            crossingWorstSwitch = MOS_SWITCH_KEYS[crossingIdx];
          }
        }
      }
    }

    const candidate = {
      angleDeg,
      tSafeSec: angleTSafeSec,
      terminalMaxTjC,
      worstSwitch: crossingWorstSwitch ?? angleWorstSwitch,
      phaseSquaredRatio,
      worstTj: angleTransientWorstTj,
    };
    if (!selectedTransient) {
      selectedTransient = candidate;
    } else {
      const currentSafe = selectedTransient.tSafeSec;
      const candidateSafe = candidate.tSafeSec;
      const shouldSelect = candidateSafe !== null
        ? currentSafe === null || candidateSafe < currentSafe - 1e-12 ||
          (Math.abs(candidateSafe - currentSafe) <= 1e-12 && candidate.angleDeg === worstAngleDeg)
        : currentSafe === null && candidate.terminalMaxTjC > selectedTransient.terminalMaxTjC;
      if (shouldSelect) selectedTransient = candidate;
    }
  }

  // Angles are always populated by the 5-degree sweep; keep a defensive guard
  // so a future sweep configuration cannot return empty transient results.
  if (!selectedTransient) throw new Error('堵转瞬态扫描未生成任何有效电角度轨迹。');
  const tSafeSec = selectedTransient.tSafeSec;
  const tSafeAngleDeg = selectedTransient.angleDeg;
  const transientWorstSwitch = selectedTransient.worstSwitch;
  const phaseSquaredRatioAtTransientWorst = selectedTransient.phaseSquaredRatio;
  const transientWorstTj = selectedTransient.worstTj;
  const inheritedBoardTempC = opts.initialThermalState?.tBoardC ?? opts.tInitialBoardC ?? opts.tAmbC;
  // A scalar Board temperature does not identify any junction temperature.
  // Keep Tj_max unknown instead of copying T_board into a misleading Tj field.
  const inheritedMaxTjC = hasValidInitialState
    ? Math.max(...opts.initialThermalState!.armT.map((chain) => chain[0]))
    : null;

  const missingLossInputs: string[] = [];
  const assumptionReasons: string[] = [];
  const hasDptLutForStall = Boolean(opts.mos.dptLut && opts.mos.dptLut.length > 0);
  if (!hasDptLutForStall && opts.mos.eonPlusEoffUj <= 0) missingLossInputs.push('Eon+Eoff/DPT');
  if (!hasDptLutForStall && !opts.mos.eonIncludesQrr && opts.mos.qrrNc <= 0) missingLossInputs.push('Qrr');
  if (!opts.mos.eossAlreadyIncludedInEsw && !opts.mos.eossCurve && (opts.mos.eossUj ?? 0) <= 0 && !qossCoveredByQr(opts.mos)) missingLossInputs.push('Eoss');
  if (opts.mos.rdsDataConfirmed !== true) assumptionReasons.push('Rds(on)@25°C 未按目标器件条件确认');
  if (!hasDptLutForStall) assumptionReasons.push('开关能量采用单点标量缩放，未使用多工况 DPT LUT');
  if (opts.model.modelKind !== 'datasheet_constrained' || opts.model.zthValidation?.passed !== true) {
    assumptionReasons.push('热网络未通过目标器件数据手册约束及拆分一致性验证');
  }
  const resultQualification: FocResultQualification = missingLossInputs.length > 0
    ? 'INCOMPLETE_LOSS_MODEL'
    : assumptionReasons.length > 0
    ? 'ASSUMPTION_BASED'
    : 'DEVICE_PARAMETERIZED';
  const qualificationReasons = [...missingLossInputs.map((x) => `未提供 ${x} 损耗数据`), ...assumptionReasons];
  const thermalSafeAtRequestedCurrent = stallSteadyConverged && !stallThermalRunaway &&
    Number.isFinite(worstSteadyTjC) && worstSteadyTjC <= opts.tjLimitC;
  // Keep the raw thermal-only result for diagnosis, but SAFE is fail-closed unless
  // the loss inputs and device thermal network are parameterized with explicit evidence.
  const steadySafe = thermalSafeAtRequestedCurrent && !stallVoltageLimited && resultQualification === 'DEVICE_PARAMETERIZED';
  const stallWarnings: string[] = [];
  if (resultQualification !== 'DEVICE_PARAMETERIZED') {
    stallWarnings.push(`堵转热安全等级=${resultQualification}；当前 t_safe/I²t 仅为模型条件估算，原因：${qualificationReasons.join('；')}。steadySafe 已强制为 false，不允许显示 SAFE。`);
  }
  if (!opts.mos.rdsDataConfirmed) {
    stallWarnings.push('Rds(on)@25°C 未确认时仍按当前起算值计算导通损耗；该结果必须按假设估算解释。');
  }
  if (!stallSteadyConverged) stallWarnings.push('堵转稳态热方程至少一个电角度未收敛；SAFE 判定已强制为 false，不能把稳态温度外推作为安全结论。');
  if (stallThermalRunaway) stallWarnings.push('堵转角度扫描检测到热失控；应按非安全工况处理。');
  if (stallVoltageLimited) {
    const deadNote =
      deadEdgeDuty > 0
        ? `（已计入死区最小脉冲宽度限制：deadEdgeDuty=${(deadEdgeDuty * 100).toFixed(2)}%，可用线性调制上限 m=${svpwmUsableCeiling.toFixed(4)}）`
        : '';
    stallWarnings.push(`目标 I_pk 在当前 Vbus、R_phase 和 SVPWM 线性电压能力${deadNote}下不可实现；本次热结果仍按用户请求电流强制计算，只能作为条件性上界估算，不得据此判定实际可运行工况 SAFE。`);
  }
  stallWarnings.push('堵转 I²t 的 RMS 字段采用平衡正弦电流等效参考 I_pk/√2；锁定转子固定电角度下各相电流是静态相量投影，不是实际随时间的相 RMS。i2tWorstLegA2s 按 t_safe 最不利电角度的单相静态电流平方积分。');
  stallWarnings.push('t_safe 已对 0°～355°、每 5° 的全部 72 个锁定转子电角度分别进行热瞬态扫描，并取最早 Tj_limit 越限时间；采用 280 点对数时间输出网格，并在首次越限区间进行 18 轮热网络重放二分细化；属于模型估计值，不替代实测堵转保护标定。');
  if (opts.rPhaseOhm === undefined) {
    stallWarnings.push('未提供绕组相电阻 R_phase，当前使用 0.25Ω 默认假设；该值可能显著改变堵转调制深度和损耗，请使用热态/冷态实测相电阻替换。');
  } else {
    stallWarnings.push(`堵转模型将 R_phase=${rPhaseUsedOhm.toFixed(4)}Ω 解释为单相等效绕组电阻；请确认已根据电机星形/三角形接法将线间实测值换算为相值，并按堵转时绕组温度修正电阻。若该数值仍是 UI 默认 0.25Ω，占位值不能视为实测输入。`);
  }
  const i2tRmsA2s = tSafeSec !== null ? iRmsSq * tSafeSec : null;
  const i2tWorstLegA2s = tSafeSec !== null ? phaseSquaredRatioAtTransientWorst * iRmsSq * tSafeSec : null;

  return {
    resultQualification,
    qualificationReasons,
    anglesDeg,
    steadyMaxTjPerAngle,
    worstAngleDeg,
    worstSwitch,
    worstSteadyTjC,
    steadySafe,
    thermalSafeAtRequestedCurrent,
    warnings: stallWarnings,
    i2tReferenceKind: 'balanced_sinusoidal_equivalent',
    tSafeSec,
    tSafeAngleDeg,
    transientWorstSwitch,
    i2tThresholdA2s: i2tRmsA2s,
    i2tRmsA2s,
    i2tWorstLegA2s,
    phaseSquaredRatioAtWorst: phaseSquaredRatioAtTransientWorst,
    effectiveStallModDepthM: effM,
    effectiveStallModulation: effMod,
    effectiveStallPfAngleDeg: effPfAngleDeg,
    rPhaseUsedOhm,
    stallVoltageLimited,
    stallSteadyConverged,
    stallThermalRunaway,
    inheritedHotState,
    inheritedFullThermalState: hasValidInitialState,
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
