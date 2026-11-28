/**
 * Waveform Viewer Pro - Phase 2: BLDC / PMSM FOC 6-MOS Inverter Thermal Engine
 *
 * Modular facade re-exporting all public types, device loss models, 6-MOS thermal network
 * & SPICE validators, electrical-cycle steady-state solvers, and transient/stall sweeps.
 */

export * from "./focThermal/types";
export {
  validateRdsOnTempCurve,
  evaluateRdsOnTempCurveRatio,
  parseRdsOnTempCurveImportJson,
  createRdsOnTempCurveImportTemplate,
  reconstructSensorlessDutySample,
  validateMosEnergyAccounting,
  computePhaseMosLosses,
} from "./focThermal/lossModel";
export {
  resolveSpatialThermalNetwork,
  parsePcbSpatialImportJson,
  createPcbSpatialImportTemplate,
  summarizePcbSpatialNetwork,
  exportPcbSpatialDocumentFromModel,
  buildPerSwitchJcChains,
  splitCauerToFocModel,
  focModelToSpice,
  validateFocSpiceNetlist,
} from "./focThermal/thermalNetwork";
export type { PcbSpatialValidationSummary } from "./focThermal/thermalNetwork";
export {
  simulateFoc6MosSteadyState,
  simulateFoc6MosVoltageEnvelope,
} from "./focThermal/steadySolver";
export {
  simulateFoc6Mos,
  runFocStallSweep,
  runFocControlSweep,
} from "./focThermal/transientAndSweep";
export {
  createAutomotive12VMissionProfilePreset,
  simulateFocMissionProfile,
  computeFocThermalDeratingCurve,
} from "./focThermal/missionAndDerating";
