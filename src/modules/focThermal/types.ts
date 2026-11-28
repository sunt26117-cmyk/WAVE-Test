/**
 * FOC 6-MOS Electro-Thermal Types, Constants & Defaults
 */
import type { WaveformChannel } from "../../types/models";
import type { CauerStage, ThermalPathMode, NonlinearEossCurve } from "../thermalEngine";
import type {
  DptAxisName,
  DptLutStatus,
  DptOperatingPoint,
  DptParameterProvenance,
} from "../dptAnalyzer";

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

export interface FocMissionStage {
  id?: string;
  label: string;
  mode: 'rotating' | 'locked_rotor';
  durationSec: number;
  iqPeakA: number;
  idPeakA?: number;
  electricalFrequencyHz: number;
  electricalAngleDeg?: number;
  vBusV: number;
  modDepthM: number;
  pfAngleDeg?: number;
  fswHz?: number;
  tAmbC?: number;
}

export interface FocMissionProfileOptions {
  model: FocThermalModel;
  mos: FocMosParams;
  baseCtrl: FocControlParams;
  stages: FocMissionStage[];
  /** Number of consecutive repetitions of the stage sequence (1..20, default 1). */
  repeatCycles?: number;
  /** Target junction temperature limit (°C) used for margin and exceedance checks (default 150). */
  tjLimitC?: number;
  /** Optional hot initial thermal state carried over from a prior simulation. */
  initialThermalState?: ThermalNetworkStateSnapshot;
  /** Electrical-angle quadrature samples per rotating stage (default 360). */
  integrationSamplesPerCycle?: number;
  /** Maximum timeline output samples across the whole profile (default 1600). */
  maxTimelinePoints?: number;
}

export interface FocMissionStageSummary {
  cycleIndex: number;
  stageIndex: number;
  label: string;
  mode: 'rotating' | 'locked_rotor';
  tStartSec: number;
  tEndSec: number;
  durationSec: number;
  vBusV: number;
  iqPeakA: number;
  tAmbC: number;
  pInvAvgW: number;
  tjPeakC: number;
  tjEndC: number;
  tBoardEndC: number;
  hottestKey: MosSwitchKey;
  marginToLimitC: number;
  exceededLimit: boolean;
}

export interface FocMissionProfileResult {
  resultQualification: FocResultQualification;
  qualificationReasons: string[];
  warnings: string[];
  repeatCycles: number;
  tjLimitC: number;
  totalDurationSec: number;
  time: Float64Array;
  tj: Record<MosSwitchKey, Float32Array>;
  tBoard: Float32Array;
  pInvTotal: Float32Array;
  stageIdxAtSample: Int16Array;
  stageSummaries: FocMissionStageSummary[];
  cyclePeakTjC: number[];
  /** Peak Tj delta between last cycle and previous cycle (null when repeatCycles < 2). */
  ratchetDeltaTjC: number | null;
  tjPeakGlobalC: number;
  hottestKeyGlobal: MosSwitchKey;
  tBoardPeakC: number;
  exceededLimit: boolean;
  firstExceedTimeSec: number | null;
  finalThermalState: ThermalNetworkStateSnapshot;
}

export type FocDeratingLimitReason =
  | 'THERMAL_LIMIT'
  | 'THERMAL_RUNAWAY_BOUNDARY'
  | 'VOLTAGE_LIMITED'
  | 'DPT_LUT_BOUND'
  | 'RDS_CURVE_BOUND'
  | 'ZERO_MARGIN'
  | 'SEARCH_CEILING_REACHED'
  | 'INVALID_INPUT';

export interface FocDeratingPoint {
  vBusV: number;
  tAmbC: number;
  requiredModDepthM: number;
  iPeakMaxA: number | null;
  iRmsMaxA: number | null;
  tjAtMaxC: number | null;
  tBoardAtMaxC: number | null;
  pInverterAtMaxW: number | null;
  hottestKey: MosSwitchKey | null;
  limitReason: FocDeratingLimitReason;
  note: string;
}

export interface FocDeratingCurveOptions {
  model: FocThermalModel;
  mos: FocMosParams;
  ctrl: FocControlParams;
  operatingPointTemplate: Omit<FocSteadyOperatingPoint, 'iqPeakA'> & { iqPeakA?: number };
  tjLimitC: number;
  tAmbPointsC?: number[];
  vBusPointsV?: number[];
  referenceVoltageV?: number;
  iMaxSearchA?: number;
  toleranceA?: number;
}

export interface FocDeratingCurveResult {
  resultQualification: FocResultQualification;
  qualificationReasons: string[];
  warnings: string[];
  tjLimitC: number;
  mode: 'rotating' | 'locked_rotor';
  tAmbPointsC: number[];
  vBusPointsV: number[];
  points: FocDeratingPoint[];
  csvContent: string;
}
