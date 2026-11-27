import test from 'node:test';
import assert from 'node:assert/strict';
import { WaveformChannel } from '../types/models';
import {
  deconvolveThermalImpedance,
  computePowerFromVIWaveforms,
  computePowerFromVISources,
  computeLossWithDeskewAndEoss,
  parseSiUnitScale,
  validateCauerSpiceNetlist,
  simulateCauerZoh,
  simulateCauerZohWithDiagnostics,
  integrateQossToEossCurve,
  integrateCossToEossCurve,
  evaluatePchipMonotone,
  evaluateNonlinearEossUj,
  parseEossCurveCsv,
  parseEossCurveImportJson,
  createEossCurveImportTemplate,
  validateTemperatureChannel,
} from './thermalEngine';
import { evaluateDynamicSoa, interpolateSoaCurveAtVds, SOA_PRESETS } from './dynamicSoa';
import {
  DEFAULT_FOC_MODEL,
  computePhaseMosLosses,
  buildPerSwitchJcChains,
  focModelToSpice,
  getModulationLinearCeiling,
  reconstructSensorlessDutySample,
  resolveSpatialThermalNetwork,
  parsePcbSpatialImportJson,
  createPcbSpatialImportTemplate,
  runFocStallSweep,
  simulateFoc6Mos,
  splitCauerToFocModel,
  validateFocSpiceNetlist,
} from './focThermal';

import { analyzeSamplingQuality } from './qualityCheck';
import { computeChannelMean } from './oscilloscopeScale';
import { inferCsvChannelUnit, previewCsv, parseFullCsv, computeCsvPreviewQuality } from '../parsers/csvParser';
import { inferUnitFromHeader } from '../parsers/excelParser';
import { computeFFT } from './fft';
import { analyzeThreePhaseBalance, analyzePwmSwitchingAndDeadTime, analyzeTorqueAndCurrentRipple } from './bldcAnalysis';
import { analyzeDoublePulseTest, generateDptDemoChannels, interpolateDptSwitchingLoss } from './dptAnalyzer';

function makeChannel(
  id: string,
  name: string,
  unit: string,
  t: Float64Array,
  v: Float32Array
): WaveformChannel {
  const dt = t.length >= 2 ? t[1] - t[0] : 1e-3;
  return {
    id,
    name,
    unit,
    color: '#22d3ee',
    t,
    v,
    visible: true,
    vMin: -100,
    vMax: 100,
    coupling: 'DC',
    inverted: false,
    isMath: false,
    sourceChannelIds: [],
    fs: dt > 0 ? 1 / dt : 1000,
    dt,
    metadata: analyzeSamplingQuality(t),
  };
}

test('MOS conduction exposes an exact 25C reference independent of instantaneous Tj', () => {
  const mos = {
    rdsOn25Mohm: 5,
    tempCoeffAlphaPerC: 0.0045,
    vsdV: 0.8,
    eonPlusEoffUj: 0,
    vRefV: 48,
    iRefA: 20,
    qrrNc: 0,
    eossUj: 0,
  };
  const cold = computePhaseMosLosses(12, 0.37, 48, 25, 25, 'SVPWM', 20000, 0, mos);
  const hot = computePhaseMosLosses(12, 0.37, 48, 125, 125, 'SVPWM', 20000, 0, mos);
  assert.ok(hot.pHighCond > cold.pHighCond);
  assert.ok(hot.pLowCond > cold.pLowCond);
  assert.equal(hot.pHighCond25W, cold.pHighCond25W);
  assert.equal(hot.pLowCond25W, cold.pLowCond25W);
});

test('AC-coupling offset uses time-weighted mean for non-uniform sampling', () => {
  // Dense acquisition around 10 V must not outweigh a long 10 V plateau simply
  // because the logger used fewer samples at the beginning/end of the record.
  const t = new Float64Array([0, 1, 9, 10]);
  const v = new Float32Array([0, 10, 10, 0]);
  const ch = makeChannel('ac_irregular', 'Irregular AC', 'V', t, v);
  ch.coupling = 'AC';
  assert.equal(ch.metadata.isUniformSampling, false);
  // Trapezoidal area = 5 + 80 + 5 = 90 V·s across 10 s.
  assert.ok(Math.abs(computeChannelMean(ch) - 9) < 1e-6);

  const uniform = makeChannel('ac_uniform', 'Uniform AC', 'V', new Float64Array([0, 1, 2]), new Float32Array([0, 10, 0]));
  uniform.coupling = 'AC';
  assert.ok(Math.abs(computeChannelMean(uniform) - 10 / 3) < 1e-6);
});

test('parseSiUnitScale converts V/A/W SI prefixes accurately', () => {
  assert.equal(parseSiUnitScale('V', 'V'), 1);
  assert.equal(parseSiUnitScale('mV', 'V'), 1e-3);
  assert.equal(parseSiUnitScale('µV', 'V'), 1e-6);
  assert.equal(parseSiUnitScale('kV', 'V'), 1e3);
  assert.equal(parseSiUnitScale('mA', 'A'), 1e-3);
  assert.equal(parseSiUnitScale('uA', 'A'), 1e-6);
  assert.equal(parseSiUnitScale('A', 'A'), 1);
  assert.equal(parseSiUnitScale('mW', 'W'), 1e-3);
  assert.equal(parseSiUnitScale('kW', 'W'), 1e3);
  assert.equal(parseSiUnitScale('V', 'A', 'I_mos (mA)'), 1e-3);
  assert.equal(parseSiUnitScale('V', 'W', 'P_dev [mW]'), 1e-3);
});

test('pad_ambient deconvolution generates PAD_THERM PAD TAMB netlist and compensates R_spread', () => {
  // Simulate PCB temperature rise beside a MOS heated by P = 8 W
  // True Rth_pcb-a = 4.5 °C/W across two PCB time constants (0.25s & 6.0s)
  const n = 400;
  const t = new Float64Array(n);
  const temp = new Float64Array(n);
  const P = 8.0;
  const tAmb = 25.0;
  for (let i = 0; i < n; i++) {
    const ti = (i / (n - 1)) * 40.0;
    t[i] = ti;
    if (ti < 2.0) {
      temp[i] = tAmb;
    } else {
      const dt = ti - 2.0;
      const z = 1.1 * (1 - Math.exp(-dt / 0.25)) + 3.4 * (1 - Math.exp(-dt / 6.0));
      temp[i] = tAmb + P * z;
    }
  }

  const baseRes = deconvolveThermalImpedance(t, temp, {
    mode: 'heating',
    powerW: P,
    targetOrder: 3,
    autoT0: true,
    thermalPathMode: 'pad_ambient',
    padSpreadRthCPerW: 0,
  });

  assert.equal(baseRes.thermalPathMode, 'pad_ambient');
  assert.ok(baseRes.rSquared > 0.995, `Expected R^2 > 0.995, got ${baseRes.rSquared}`);
  assert.ok(
    Math.abs(baseRes.totalRthCauer - 4.5) < 0.25,
    `Expected Rth,pad-a ~ 4.5 C/W, got ${baseRes.totalRthCauer}`
  );
  assert.match(baseRes.spiceNetlist, /\.subckt PAD_THERM PAD TAMB/);
  assert.match(baseRes.spiceNetlist, /^C1 PAD 0 /m);
  assert.equal(baseRes.spiceValidation.valid, true);
  assert.equal(baseRes.spiceValidation.heatNodeName, 'PAD');
  assert.equal(baseRes.reducedCauer.some((s) => s.layerLabel.includes('PCB') || s.layerLabel.includes('焊盘')), true);

  // With R_spread = 0.65 °C/W pad-to-sensor spreading resistance
  const compRes = deconvolveThermalImpedance(t, temp, {
    mode: 'heating',
    powerW: P,
    targetOrder: 3,
    autoT0: true,
    thermalPathMode: 'pad_ambient',
    padSpreadRthCPerW: 0.65,
  });

  assert.ok(
    Math.abs(compRes.totalRthCauer - (baseRes.totalRthCauer + 0.65)) < 1e-6,
    'R_spread should add cleanly to totalRthCauer'
  );
  assert.equal(compRes.reducedCauer[0].r, 0.65);
  assert.equal(compRes.spiceValidation.valid, true);
  const recheck = validateCauerSpiceNetlist(compRes.spiceNetlist, compRes.totalRthCauer, 'PAD');
  assert.equal(recheck.valid, true);
});

test('physics audit auto-reduces over-parameterized 6-stage request on true 2-pole curve', () => {
  const n = 500;
  const t = new Float64Array(n);
  const temp = new Float64Array(n);
  const P = 15.0;
  for (let i = 0; i < n; i++) {
    const ti = (i / (n - 1)) * 30.0;
    t[i] = ti;
    const z = 0.8 * (1 - Math.exp(-ti / 0.15)) + 2.2 * (1 - Math.exp(-ti / 3.5));
    temp[i] = 25 + P * z;
  }

  const res = deconvolveThermalImpedance(t, temp, {
    mode: 'heating',
    powerW: P,
    targetOrder: 6,
    autoT0: false,
  });

  assert.equal(res.physicsAudit.passed, true);
  assert.equal(res.physicsAudit.status, 'reduced');
  assert.equal(res.physicsAudit.orderReduced, true);
  assert.ok(res.physicsAudit.effectiveOrder <= 3, `Expected auto-reduced order <= 3, got ${res.physicsAudit.effectiveOrder}`);
  assert.ok(res.physicsAudit.checks.every((c) => c.passed), 'All physics checks should pass after order reduction');
  assert.ok(Math.abs(res.totalRthCauer - 3.0) < 0.25, `Expected credible Rth ~ 3.0 C/W, got ${res.totalRthCauer}`);
});

test('physics audit guards truncated unconverged capture from runaway Rth extrapolation', () => {
  // Capture stops at t_max = 1.0 s while true slow pole is tau = 4.0 s -> truncated transient
  const n = 300;
  const t = new Float64Array(n);
  const temp = new Float64Array(n);
  const P = 20.0;
  for (let i = 0; i < n; i++) {
    const ti = (i / (n - 1)) * 1.0;
    t[i] = ti;
    const z = 0.4 * (1 - Math.exp(-ti / 0.04)) + 2.5 * (1 - Math.exp(-ti / 4.0));
    temp[i] = 25 + P * z;
  }

  const res = deconvolveThermalImpedance(t, temp, {
    mode: 'heating',
    powerW: P,
    targetOrder: 4,
    autoT0: false,
  });

  if (res.physicsAudit.passed) {
    assert.ok(
      res.physicsAudit.extrapolationRatio <= 2.35,
      `Passed fit must keep extrapolationRatio <= 2.35, got ${res.physicsAudit.extrapolationRatio}`
    );
  } else {
    assert.equal(res.physicsAudit.status, 'failed');
  }
});

test('physics audit rejects wrong polarity or flat curve as FIT FAILED', () => {
  const n = 200;
  const t = new Float64Array(n);
  const coolingCurve = new Float64Array(n);
  const flatCurve = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ti = (i / (n - 1)) * 10.0;
    t[i] = ti;
    coolingCurve[i] = 25 + 60 * Math.exp(-ti / 1.5);
    flatCurve[i] = 25 + 0.005 * Math.sin(ti);
  }

  const wrongPolarity = deconvolveThermalImpedance(t, coolingCurve, {
    mode: 'heating',
    powerW: 20,
    targetOrder: 3,
    autoT0: false,
  });
  assert.equal(wrongPolarity.physicsAudit.status, 'failed');
  assert.equal(wrongPolarity.physicsAudit.passed, false);

  const flatFail = deconvolveThermalImpedance(t, flatCurve, {
    mode: 'heating',
    powerW: 20,
    targetOrder: 3,
    autoT0: false,
  });
  assert.equal(flatFail.physicsAudit.status, 'failed');
  assert.equal(flatFail.physicsAudit.passed, false);
});

test('cooling deconvolution keeps true asymptotic tAmbC separate from pre-step hot tBaseC', () => {
  const n = 450;
  const t = new Float64Array(n);
  const temp = new Float64Array(n);
  const P = 25.0;
  const tAmbTrue = 27.5;
  const r1 = 0.6;
  const r2 = 2.2;
  const tHot = tAmbTrue + P * (r1 + r2); // 97.5 °C

  for (let i = 0; i < n; i++) {
    const ti = (i / (n - 1)) * 45.0;
    t[i] = ti;
    if (ti < 2.0) {
      temp[i] = tHot;
    } else {
      const dt = ti - 2.0;
      const z = r1 * (1 - Math.exp(-dt / 0.2)) + r2 * (1 - Math.exp(-dt / 3.5));
      temp[i] = tHot - P * z;
    }
  }

  const res = deconvolveThermalImpedance(t, temp, {
    mode: 'cooling',
    powerW: P,
    targetOrder: 2,
    autoT0: true,
  });

  assert.equal(res.physicsAudit.passed, true);
  assert.ok(Math.abs(res.tBaseC - tHot) < 1.5, `Expected pre-step tBaseC ~ ${tHot}, got ${res.tBaseC}`);
  assert.ok(Math.abs(res.tAmbC - tAmbTrue) < 1.0, `Expected asymptotic tAmbC ~ ${tAmbTrue}, got ${res.tAmbC}`);
  assert.match(res.spiceNetlist, /T_amb=27\.|T_amb=28\./);
});

test('computePowerFromVIWaveforms handles mA scaling, misaligned timebases, and step-active vs gate mean power', () => {
  const nV = 301;
  const tV = new Float64Array(nV);
  const vArr = new Float32Array(nV);
  for (let i = 0; i < nV; i++) {
    tV[i] = i * 0.1;
    vArr[i] = 24.0;
  }

  const nI = 601;
  const tI = new Float64Array(nI);
  const iArr = new Float32Array(nI);
  for (let i = 0; i < nI; i++) {
    const ti = i * 0.05;
    tI[i] = ti;
    iArr[i] = ti >= 5.0 ? 500.0 : 0.0; // 500 mA = 0.5 A -> 12 W
  }

  const vCh = makeChannel('v1', 'Vds', 'V', tV, vArr);
  const iCh = makeChannel('i1', 'Ids', 'mA', tI, iArr);

  const res = computePowerFromVIWaveforms(vCh, iCh);
  assert.equal(res.vUnitScale, 1);
  assert.equal(res.iUnitScale, 1e-3);
  assert.ok(Math.abs(res.pStepActiveW - 12.0) < 0.15, `Expected pStepActiveW ~ 12W, got ${res.pStepActiveW}`);
  assert.ok(Math.abs(res.pGateMeanW - 10.0) < 0.15, `Expected pGateMeanW ~ 10W (25/30 * 12W), got ${res.pGateMeanW}`);
  assert.ok(Math.abs(res.energyJ - 300.0) < 3.0, `Expected E ~ 300J, got ${res.energyJ}`);

  const resOnset = computePowerFromVIWaveforms(vCh, iCh, { stepOnsetTimeSec: 5.0 });
  assert.ok(Math.abs(resOnset.pStepActiveW - 12.0) < 0.05);
});

test('computePowerFromVISources supports manual constant V or constant I alongside waveforms', () => {
  const n = 201;
  const t = new Float64Array(n);
  const iMa = new Float32Array(n);
  const vMv = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ti = i * 0.1;
    t[i] = ti;
    iMa[i] = ti >= 4.0 ? 1500.0 : 0.0; // 1.5 A after t=4s
    vMv[i] = 12000.0; // 12 V
  }
  const chIMa = makeChannel('ima', 'I_load', 'mA', t, iMa);
  const chVMv = makeChannel('vmv', 'V_drain', 'mV', t, vMv);

  // Constant V = 24 V x Waveform I (mA)
  const resConstV = computePowerFromVISources({ constantValue: 24 }, { channel: chIMa });
  assert.ok(Math.abs(resConstV.vMeanV - 24) < 1e-6);
  assert.ok(Math.abs(resConstV.pStepActiveW - 36.0) < 0.3, `Expected 24V*1.5A = 36W, got ${resConstV.pStepActiveW}`);

  // Waveform V (mV -> 12 V) x Constant I = 2.5 A
  const resConstI = computePowerFromVISources({ channel: chVMv }, { constantValue: 2.5 });
  assert.ok(Math.abs(resConstI.vMeanV - 12.0) < 1e-5);
  assert.ok(Math.abs(resConstI.iMeanA - 2.5) < 1e-6);
  assert.ok(Math.abs(resConstI.pStepActiveW - 30.0) < 1e-4);

  // Both constants: 48 V * 0.5 A = 24 W
  const resBothConst = computePowerFromVISources({ constantValue: 48 }, { constantValue: 0.5 }, { tStart: 0, tEnd: 5 });
  assert.equal(resBothConst.pStepActiveW, 24);
  assert.equal(resBothConst.energyJ, 120);
});

test('computeLossWithDeskewAndEoss subtracts exact 1.0x Eoss and scales mA units', () => {
  // Single clean turn-off edge (Vds 0 -> 100V, Ids 10A -> 0A) with Rds=0 so only switching + Eoss exist
  const n = 200;
  const dt = 1e-9; // 1 ns
  const t = new Float64Array(n);
  const vds = new Float32Array(n);
  const idsA = new Float32Array(n);
  const idsMa = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = i * dt;
    if (i < 50) {
      vds[i] = 0;
      idsA[i] = 10;
    } else if (i <= 100) {
      const f = (i - 50) / 50;
      vds[i] = 100 * f;
      idsA[i] = 10 * (1 - f);
    } else {
      vds[i] = 100;
      idsA[i] = 0;
    }
    idsMa[i] = idsA[i] * 1000;
  }

  const chV = makeChannel('vds', 'Vds', 'V', t, vds);
  const chIA = makeChannel('ids_a', 'Ids', 'A', t, idsA);
  const chIMa = makeChannel('ids_ma', 'Ids', 'mA', t, idsMa);
  const stages = [{ r: 1.0, c: 0.01, tauEst: 0.01, layerLabel: 'Die' }];

  const resA = computeLossWithDeskewAndEoss(chV, chIA, stages, {
    deskewNs: 0,
    eossUj: 4.0,
    rdsOn25Mohm: 0,
    tempCoeffAlphaPerC: 0,
    tAmbC: 25,
  });
  const resMa = computeLossWithDeskewAndEoss(chV, chIMa, stages, {
    deskewNs: 0,
    eossUj: 4.0,
    rdsOn25Mohm: 0,
    tempCoeffAlphaPerC: 0,
    tAmbC: 25,
  });

  const deltaMj = resA.energyDeskewedMj - resA.energyStrippedMj;
  assert.equal(resA.switchingEvents, 1);
  assert.ok(Math.abs(deltaMj - 0.004) < 1e-5, `Expected exact 1.0x Eoss subtraction = 0.004 mJ, got ${deltaMj}`);
  assert.ok(Math.abs(resMa.energyStrippedMj - resA.energyStrippedMj) < 1e-6, 'mA channel must match A channel');
});

test('Dynamic SOA and BLDC FOC scale mA currents identically to A currents and guard stall divergence', () => {
  const n = 200;
  const t = new Float64Array(n);
  const vds = new Float32Array(n).fill(24);
  const idsA = new Float32Array(n).fill(10);
  const idsMa = new Float32Array(n).fill(10000);
  for (let i = 0; i < n; i++) t[i] = i * 1e-4;

  const chV = makeChannel('v_soa', 'Vds', 'V', t, vds);
  const chIA = makeChannel('i_soa_a', 'Ids', 'A', t, idsA);
  const chIMa = makeChannel('i_soa_ma', 'Ids', 'mA', t, idsMa);

  const soaA = evaluateDynamicSoa(chV, chIA, SOA_PRESETS[0]);
  const soaMa = evaluateDynamicSoa(chV, chIMa, SOA_PRESETS[0]);
  assert.equal(soaMa.pass, soaA.pass);
  assert.ok(Math.abs(soaMa.maxUtilizationPct - soaA.maxUtilizationPct) < 1e-4);

  // FOC 6-MOS with mA current scaling
  const nFoc = 300;
  const tF = new Float64Array(nFoc);
  const iaA = new Float32Array(nFoc);
  const ibA = new Float32Array(nFoc);
  const iaMa = new Float32Array(nFoc);
  const ibMa = new Float32Array(nFoc);
  for (let k = 0; k < nFoc; k++) {
    const tk = k * 1e-4;
    tF[k] = tk;
    const th = 2 * Math.PI * 50 * tk;
    iaA[k] = 20 * Math.sin(th);
    ibA[k] = 20 * Math.sin(th - (2 * Math.PI) / 3);
    iaMa[k] = iaA[k] * 1000;
    ibMa[k] = ibA[k] * 1000;
  }

  const mos = {
    rdsOn25Mohm: 4.0,
    tempCoeffAlphaPerC: 0.0045,
    vsdV: 0.85,
    eonPlusEoffUj: 50,
    vRefV: 48,
    iRefA: 20,
    qrrNc: 30,
  };
  const ctrl = {
    modulation: 'SVPWM' as const,
    fswHz: 20000,
    tDeadNs: 200,
    modDepthM: 0.9,
    pfAngleDeg: 10,
    tAmbC: 25,
    vBusConstV: 48,
  };
  const focA = simulateFoc6Mos(makeChannel('iaA', 'Ia', 'A', tF, iaA), makeChannel('ibA', 'Ib', 'A', tF, ibA), DEFAULT_FOC_MODEL, mos, ctrl);
  const focMa = simulateFoc6Mos(makeChannel('iaMa', 'Ia', 'mA', tF, iaMa), makeChannel('ibMa', 'Ib', 'mA', tF, ibMa), DEFAULT_FOC_MODEL, mos, ctrl);
  assert.ok(Math.abs(focMa.pInvMeanW - focA.pInvMeanW) < 1e-4);
  assert.ok(Math.abs(focMa.tjMaxGlobalC - focA.tjMaxGlobalC) < 1e-4);

  // Stall runaway extreme alpha/current guard remains finite
  const extremeStall = runFocStallSweep({
    iPeakA: 500,
    tjLimitC: 150,
    tAmbC: 25,
    modulation: 'SVPWM',
    modDepthM: 0.9,
    fswHz: 20000,
    tDeadNs: 200,
    mos: { ...mos, tempCoeffAlphaPerC: 0.02 },
    model: DEFAULT_FOC_MODEL,
    vBusV: 48,
    horizonSec: 30,
  });
  assert.ok(Number.isFinite(extremeStall.worstSteadyTjC));
});

test('FOC 6-MOS: strict alignment, non-uniform time-weighted mean, gate preheat, overmod, Cauer split, SPICE nodal parity & dual I2t', () => {
  const mos = {
    rdsOn25Mohm: 4.5,
    tempCoeffAlphaPerC: 0.0045,
    vsdV: 0.9,
    eonPlusEoffUj: 35,
    vRefV: 48,
    iRefA: 30,
    qrrNc: 60,
  };
  const ctrl = {
    modulation: 'SVPWM' as const,
    fswHz: 20000,
    tDeadNs: 500,
    modDepthM: 0.85,
    pfAngleDeg: 0,
    tAmbC: 25,
    vBusConstV: 48,
  };

  // 1. Strict alignment catches interior timestamp shift (same endpoints/midpoint + same length) & coverage gap
  const nA = 21;
  const tA = Float64Array.from({ length: nA }, (_, i) => i * 0.01); // 0..0.20s
  const tBShift = Float64Array.from({ length: nA }, (_, i) => (i === 0 || i === 10 || i === 20 ? i * 0.01 : i * 0.01 + 0.0045));
  const iaShift = Float32Array.from({ length: nA }, (_, i) => 20 * Math.cos(2 * Math.PI * 5 * tA[i]));
  const ibExactAtTa = Float32Array.from({ length: nA }, (_, i) => 20 * Math.cos(2 * Math.PI * 5 * tA[i] - (2 * Math.PI) / 3));
  const ibAtTbShift = Float32Array.from({ length: nA }, (_, i) => 20 * Math.cos(2 * Math.PI * 5 * tBShift[i] - (2 * Math.PI) / 3));
  const rExact = simulateFoc6Mos(makeChannel('ia0', 'Ia', 'A', tA, iaShift), makeChannel('ib0', 'Ib', 'A', tA, ibExactAtTa), DEFAULT_FOC_MODEL, mos, ctrl);
  assert.equal(rExact.resultQualification, 'INCOMPLETE_LOSS_MODEL');
  assert.ok(rExact.qualificationReasons.some((reason) => reason.includes('Eoss')));
  assert.ok(rExact.qualificationReasons.some((reason) => reason.includes('Rds(on)@25°C')));
  assert.ok(rExact.warnings.some((warning) => warning.includes('损耗模型输入不完整')));
  const scalarCompleteInputs = simulateFoc6Mos(
    makeChannel('ia-scalar-complete', 'Ia', 'A', tA, iaShift),
    makeChannel('ib-scalar-complete', 'Ib', 'A', tA, ibExactAtTa),
    DEFAULT_FOC_MODEL,
    { ...mos, eossUj: 2, rdsDataConfirmed: false },
    ctrl
  );
  assert.equal(scalarCompleteInputs.resultQualification, 'ASSUMPTION_BASED');
  assert.ok(scalarCompleteInputs.qualificationReasons.some((reason) => reason.includes('单点 Eon+Eoff')));
  const rResamp = simulateFoc6Mos(makeChannel('ia1', 'Ia', 'A', tA, iaShift), makeChannel('ib1', 'Ib', 'A', tBShift, ibAtTbShift), DEFAULT_FOC_MODEL, mos, ctrl);
  // Strict time-interpolation keeps power error tiny despite interior shift
  assert.ok(Math.abs(rResamp.pInvMeanW - rExact.pInvMeanW) < 0.08);
  // Coverage gap warning emitted when auxiliary channel spans smaller interval
  const tShort = Float64Array.from({ length: 11 }, (_, i) => 0.05 + i * 0.01);
  const ibShort = Float32Array.from({ length: 11 }, () => -10);
  const rCov = simulateFoc6Mos(makeChannel('ia2', 'Ia', 'A', tA, iaShift), makeChannel('ib2', 'Ib', 'A', tShort, ibShort), DEFAULT_FOC_MODEL, mos, ctrl);
  assert.ok(rCov.alignmentWarnings.some((w) => w.includes('裁剪到共同覆盖区间')));

  // 2. Non-uniform time-weighted mean (100 pts @ 1ms at 5A + 1 final pt at 1.0s at 40A -> step holds ~0.6W over 0.901s tail)
  const tNu = new Float64Array(101);
  const iaNu = new Float32Array(101);
  const ibNu = new Float32Array(101);
  const icNu = new Float32Array(101);
  for (let i = 0; i < 100; i++) {
    tNu[i] = i * 0.001;
    iaNu[i] = 5;
    ibNu[i] = -2.5;
    icNu[i] = -2.5;
  }
  tNu[100] = 0.102; // 3x median interval: irregular, but not a missing acquisition gap
  iaNu[100] = 40;
  ibNu[100] = -20;
  icNu[100] = -20;
  const rNu = simulateFoc6Mos(
    makeChannel('ian', 'Ia', 'A', tNu, iaNu),
    makeChannel('ibn', 'Ib', 'A', tNu, ibNu),
    DEFAULT_FOC_MODEL,
    mos,
    ctrl,
    { icCh: makeChannel('icn', 'Ic', 'A', tNu, icNu) }
  );
  // True step-energy average should stay near 0.60W (not inflated by the final 40A point!)
  assert.ok(Math.abs(rNu.pInvMeanW - rNu.pInvTotal[0]) < 0.05, `Expected ~0.6W, got ${rNu.pInvMeanW}`);

  // A large internal gap must not be silently bridged by linear interpolation.
  const tNuGap = Float64Array.from(tNu, (t, idx) => idx >= 60 ? t + 0.05 : t);
  assert.throws(() => simulateFoc6Mos(
    makeChannel('ia_gap', 'Ia', 'A', tNuGap, iaNu),
    makeChannel('ib_gap', 'Ib', 'A', tNuGap, ibNu),
    DEFAULT_FOC_MODEL, mos, ctrl,
    { icCh: makeChannel('ic_gap', 'Ic', 'A', tNuGap, icNu) }
  ), /内部采样缺口/);

  // 3. Time-gate continuous preheat vs explicit cold reset
  const tGate = Float64Array.from({ length: 2000 }, (_, i) => i * 0.001);
  const iaGate = Float32Array.from({ length: 2000 }, (_, i) => 40 * Math.cos(2 * Math.PI * 50 * tGate[i]));
  const ibGate = Float32Array.from({ length: 2000 }, (_, i) => 40 * Math.cos(2 * Math.PI * 50 * tGate[i] - (2 * Math.PI) / 3));
  const fullGate = simulateFoc6Mos(makeChannel('iag', 'Ia', 'A', tGate, iaGate), makeChannel('ibg', 'Ib', 'A', tGate, ibGate), DEFAULT_FOC_MODEL, mos, ctrl);
  const preheatGate = simulateFoc6Mos(makeChannel('iag2', 'Ia', 'A', tGate, iaGate), makeChannel('ibg2', 'Ib', 'A', tGate, ibGate), DEFAULT_FOC_MODEL, mos, ctrl, {
    tStart: 1.5,
    tEnd: 2.0,
    gateThermalMode: 'preheat',
  });
  const coldGate = simulateFoc6Mos(makeChannel('iag3', 'Ia', 'A', tGate, iaGate), makeChannel('ibg3', 'Ib', 'A', tGate, ibGate), DEFAULT_FOC_MODEL, mos, ctrl, {
    tStart: 1.5,
    tEnd: 2.0,
    gateThermalMode: 'cold',
  });
  assert.ok(Math.abs(preheatGate.tj.AH[0] - fullGate.tj.AH[1500]) < 1e-3);
  assert.ok(Math.abs(coldGate.tj.AH[0] - 25.0) < 1e-4);
  assert.ok(preheatGate.tjMaxGlobalC > coldGate.tjMaxGlobalC + 2.0);
  // Transient convergence & steady-state projection populated
  assert.ok(preheatGate.tjSteadyMaxEstC > preheatGate.tjMaxGlobalC);
  assert.ok(preheatGate.thermalConvergencePct > 0 && preheatGate.thermalConvergencePct < 100);

  // Preheat begins at the first acquired sample, so Vbus must cover the pre-gate history too.
  const tVbusGateOnly = Float64Array.from({ length: 501 }, (_, i) => 1.5 + i * 0.001);
  const vbusGateOnly = makeChannel('vbus_gate_only', 'Vbus', 'V', tVbusGateOnly, new Float32Array(501).fill(48));
  assert.throws(() => simulateFoc6Mos(
    makeChannel('iag_vbus', 'Ia', 'A', tGate, iaGate),
    makeChannel('ibg_vbus', 'Ib', 'A', tGate, ibGate),
    DEFAULT_FOC_MODEL, mos, ctrl,
    { tStart: 1.5, tEnd: 2.0, gateThermalMode: 'preheat', vbusCh: vbusGateOnly }
  ), /Vbus.*未完整覆盖/);

  // Per-switch JC scale values down to 0.05 are valid and must not silently revert to 1.0.
  const scaledJc = buildPerSwitchJcChains({
    ...DEFAULT_FOC_MODEL,
    perSwitchRjcScale: [0.05, 1, 1, 1, 1, 1],
  });
  assert.ok(Math.abs(scaledJc[0][0].r - DEFAULT_FOC_MODEL.zthJC[0].r * 0.05) < 1e-12);

  // 4. Modulation ceiling & overmodulation reporting + m=0 DPWM1 safety
  assert.equal(getModulationLinearCeiling('SPWM'), 1.0);
  assert.ok(Math.abs(getModulationLinearCeiling('SVPWM') - 2 / Math.sqrt(3)) < 1e-12);
  const spwmOver = reconstructSensorlessDutySample(20, -10, -10, 'SPWM', 1.12, 0);
  assert.equal(spwmOver.overmodulated, true);
  const dpwmZeroM = reconstructSensorlessDutySample(20, -10, -10, 'DPWM1', 0, 0);
  assert.deepEqual({ da: dpwmZeroM.da, db: dpwmZeroM.db, dc: dpwmZeroM.dc }, { da: 0.5, db: 0.5, dc: 0.5 });

  // 5. Contiguous Cauer split & SPICE nodal matrix parity check (including 0°C Tamb)
  const unordered = [
    { r: 0.2, c: 0.5, tauEst: 0.1, layerLabel: 'L1' },
    { r: 0.3, c: 0.02, tauEst: 0.006, layerLabel: 'L2' },
    { r: 0.5, c: 2.0, tauEst: 1.0, layerLabel: 'L3' },
  ];
  const sp = splitCauerToFocModel(unordered, 0.05);
  assert.equal(sp.splitFeasible, false);
  assert.match(sp.splitMeta?.warning || '', /缺少器件手册 RθJC/);
  const spAnchored = splitCauerToFocModel(unordered, 0.05, { pathMode: 'junction_ambient', rJcDatasheetOhm: 0.2 });
  assert.equal(spAnchored.splitFeasible, true);
  assert.ok(spAnchored.zthJC.length > 0 && spAnchored.zthBoard.length > 0);

  const spiceZeroAmb = focModelToSpice(DEFAULT_FOC_MODEL, 0);
  assert.match(spiceZeroAmb, /T_amb=0\.00/);
  const nodalVal = validateFocSpiceNetlist(spiceZeroAmb, DEFAULT_FOC_MODEL);
  assert.equal(nodalVal.valid, true);
  assert.equal(nodalVal.nodalMathVerified, true);
  assert.ok(Math.abs(nodalVal.rJcParsed - 0.5) < 1e-5);
  assert.ok(Math.abs(nodalVal.rBrdParsed - 1.1) < 1e-5);

  // 6. Dual I^2*t stall protection & resistive low-speed stall duty (winding Rs + Rds(on))
  const stall = runFocStallSweep({
    iPeakA: 135,
    tjLimitC: 120,
    tAmbC: 25,
    modulation: 'DPWM1',
    modDepthM: 0.85,
    fswHz: 20000,
    tDeadNs: 200,
    mos,
    model: DEFAULT_FOC_MODEL,
    vBusV: 48,
    horizonSec: 120,
    stallDutyMode: 'resistive',
    rPhaseOhm: 0.025,
  });
  assert.equal(stall.effectiveStallModulation, 'SVPWM');
  assert.ok(Math.abs(stall.rPhaseUsedOhm - 0.025) < 1e-9);
  assert.ok(stall.effectiveStallModDepthM > 0.12 && stall.effectiveStallModDepthM < 0.25);
  assert.equal(stall.stallVoltageLimited, false);
  assert.ok(stall.i2tRmsA2s !== null && stall.i2tWorstLegA2s !== null);
  assert.ok(stall.anglesDeg.includes(stall.tSafeAngleDeg), 't_safe angle must be one of the swept electrical angles');
  const tSafeRad = (stall.tSafeAngleDeg * Math.PI) / 180;
  const tSafePhasePeaks = [
    135 * Math.cos(tSafeRad),
    135 * Math.cos(tSafeRad - (2 * Math.PI) / 3),
    135 * Math.cos(tSafeRad + (2 * Math.PI) / 3),
  ];
  const expectedTsafeRatio = Math.max(...tSafePhasePeaks.map((v) => v * v)) / (135 * 135 / 2);
  assert.ok(Math.abs(stall.phaseSquaredRatioAtWorst - expectedTsafeRatio) < 1e-9);
  assert.ok(Math.abs(stall.i2tWorstLegA2s! - stall.phaseSquaredRatioAtWorst * stall.i2tRmsA2s!) < 1e-6);
  assert.ok(stall.warnings.some((warning) => warning.includes('全部 72 个')));
  assert.ok(stall.warnings.some((warning) => warning.includes('星形/三角形接法')));

  // High Rs stall hits SVPWM ceiling and raises stallVoltageLimited without falling back to 2*Rds(on)
  const stallDefaultRs = runFocStallSweep({
    iPeakA: 135,
    tjLimitC: 2000,
    tAmbC: 25,
    modulation: 'SVPWM',
    modDepthM: 0.85,
    fswHz: 20000,
    tDeadNs: 200,
    mos,
    model: DEFAULT_FOC_MODEL,
    vBusV: 48,
    horizonSec: 120,
    stallDutyMode: 'resistive',
  });
  assert.equal(stallDefaultRs.rPhaseUsedOhm, 0.25);
  assert.equal(stallDefaultRs.stallVoltageLimited, true);
  assert.equal(stallDefaultRs.thermalSafeAtRequestedCurrent, true, 'thermal-only result may be safe under the forced-current assumption');
  assert.equal(stallDefaultRs.steadySafe, false, 'an infeasible voltage-limited operating point must never be presented as SAFE');
  assert.ok(Math.abs(stallDefaultRs.effectiveStallModDepthM - getModulationLinearCeiling('SVPWM')) < 1e-6);
});


test('FOC stall sweep honors a requested sub-5-second horizon without extending the result window', () => {
  const short = runFocStallSweep({
    iPeakA: 1,
    tjLimitC: 1000,
    tAmbC: 25,
    modulation: 'SVPWM',
    modDepthM: 0.1,
    fswHz: 20000,
    tDeadNs: 200,
    mos: {
      rdsOn25Mohm: 4.5,
      tempCoeffAlphaPerC: 0.0045,
      vsdV: 0.9,
      eonPlusEoffUj: 35,
      vRefV: 48,
      iRefA: 30,
      qrrNc: 60,
    },
    model: DEFAULT_FOC_MODEL,
    vBusV: 48,
    horizonSec: 0.05,
    stallDutyMode: 'resistive',
    rPhaseOhm: 0.025,
  });
  assert.equal(short.transientTime.length, 280);
  assert.ok(Math.abs(short.transientTime[short.transientTime.length - 1] - 0.05) < 1e-12);
  assert.equal(short.tSafeSec, null);
});

test('FOC stall inherited maximum Tj reads the junction node, not hotter internal Cauer nodes', () => {
  const chains = buildPerSwitchJcChains(DEFAULT_FOC_MODEL);
  const initialThermalState = {
    armT: chains.map((chain, index) => chain.map((_, stage) => stage === 0 ? 80 + index : 160 + index)),
    brdT: DEFAULT_FOC_MODEL.zthBoard.map(() => 70),
    tBoardC: 70,
    tjMaxC: 85,
  };
  const result = runFocStallSweep({
    iPeakA: 10, tjLimitC: 500, tAmbC: 25, modulation: 'SVPWM', modDepthM: 0.5,
    fswHz: 20000, tDeadNs: 100, mos: {
      rdsOn25Mohm: 5, tempCoeffAlphaPerC: 0.0045, vsdV: 0.8,
      eonPlusEoffUj: 30, vRefV: 48, iRefA: 20, qrrNc: 25,
    },
    model: DEFAULT_FOC_MODEL, vBusV: 48, horizonSec: 5,
    stallDutyMode: 'resistive', rPhaseOhm: 0.04, initialThermalState,
  });
  assert.equal(result.inheritedFullThermalState, true);
  assert.equal(result.inheritedMaxTjC, 85, 'Tj max must use first node of each MOS Cauer arm');
  assert.equal(result.inheritedBoardTempC, 70);
});

test('FOC stall scalar Board initialization does not fabricate an initial junction temperature', () => {
  const result = runFocStallSweep({
    iPeakA: 10,
    tjLimitC: 500,
    tAmbC: 25,
    tInitialBoardC: 82,
    modulation: 'SVPWM',
    modDepthM: 0.5,
    fswHz: 20000,
    tDeadNs: 100,
    mos: {
      rdsOn25Mohm: 5, tempCoeffAlphaPerC: 0.0045, vsdV: 0.8,
      eonPlusEoffUj: 30, vRefV: 48, iRefA: 20, qrrNc: 25,
    },
    model: DEFAULT_FOC_MODEL,
    vBusV: 48,
    horizonSec: 0.01,
    stallDutyMode: 'resistive',
    rPhaseOhm: 0.04,
  });
  assert.equal(result.inheritedHotState, true);
  assert.equal(result.inheritedFullThermalState, false);
  assert.equal(result.inheritedBoardTempC, 82);
  assert.equal(result.inheritedMaxTjC, null, 'Board temperature alone cannot identify Tj_max');
});

test('Round-3: External Duty % resolution handles <=1.5% cleanly, NaN/non-monotonic robustness, runaway detection & CSV/Excel Duty unit inference', () => {
  // 1. Parser Duty/% unit inference
  assert.equal(inferCsvChannelUnit('Duty_A (%)'), '%');
  assert.equal(inferCsvChannelUnit('Duty_A'), '');
  assert.equal(inferCsvChannelUnit('PWM_B [pct]'), '%');
  assert.equal(inferUnitFromHeader('Duty_A (%)'), '%');
  assert.equal(inferUnitFromHeader('PWM_C'), '');
  const dutyPreview = previewCsv('Time,Ia,Duty_A (%)\n0,10,0.8\n0.001,10,1.2\n');
  assert.equal(dutyPreview.columnMappings[2].unit, '%');

  // 2. Small percentage Duty (0.8%, 1.2%, 50%, 98%) with '%' vs unitless max > 1.05 must scale consistently by 0.01
  const n = 200;
  const t = Float64Array.from({ length: n }, (_, i) => i * 1e-4);
  const ia = Float32Array.from({ length: n }, () => 15);
  const ib = Float32Array.from({ length: n }, () => -15);
  const ic = Float32Array.from({ length: n }, () => 0);

  // Build channels where Duty_A has values 0.8 -> 1.2 -> 90 (testing <= 1.5% samples!)
  const daPctArr = Float32Array.from({ length: n }, (_, i) => (i < 100 ? 1.2 : 85));
  const dbPctArr = Float32Array.from({ length: n }, () => 0.8);
  const dcPctArr = Float32Array.from({ length: n }, () => 50);
  const daFracArr = Float32Array.from(daPctArr, (v) => v * 0.01);
  const dbFracArr = Float32Array.from(dbPctArr, (v) => v * 0.01);
  const dcFracArr = Float32Array.from(dcPctArr, (v) => v * 0.01);

  const mos = {
    rdsOn25Mohm: 5.0,
    tempCoeffAlphaPerC: 0.0045,
    vsdV: 0.8,
    eonPlusEoffUj: 30,
    vRefV: 48,
    iRefA: 20,
    qrrNc: 25,
  };
  const ctrl = {
    modulation: 'SVPWM' as const,
    fswHz: 20000,
    tDeadNs: 200,
    modDepthM: 0.8,
    pfAngleDeg: 0,
    tAmbC: 25,
    vBusConstV: 48,
  };

  assert.throws(() => runFocStallSweep({
    iPeakA: 35, tjLimitC: 150, tAmbC: 25, modulation: 'SVPWM', modDepthM: 0.8,
    fswHz: 20000, tDeadNs: 200, mos, model: { ...DEFAULT_FOC_MODEL, splitFeasible: false, splitMeta: {
      tauSplitSec: 0, boundaryIndex: -1, boundaryAdjusted: false, nonMonotonicTau: false, shuntCapRatioPct: 0,
      warning: 'Cauer split infeasible test',
    } }, vBusV: 48,
  }), /Cauer split infeasible/);

  const rFrac = simulateFoc6Mos(makeChannel('iaf', 'Ia', 'A', t, ia), makeChannel('ibf', 'Ib', 'A', t, ib), DEFAULT_FOC_MODEL, mos, ctrl, {
    icCh: makeChannel('icf', 'Ic', 'A', t, ic),
    dutyChs: {
      da: makeChannel('daf', 'Duty_A', '', t, daFracArr),
      db: makeChannel('dbf', 'Duty_B', '', t, dbFracArr),
      dc: makeChannel('dcf', 'Duty_C', '', t, dcFracArr),
    },
  });
  const rPctExplicit = simulateFoc6Mos(makeChannel('iap', 'Ia', 'A', t, ia), makeChannel('ibp', 'Ib', 'A', t, ib), DEFAULT_FOC_MODEL, mos, ctrl, {
    icCh: makeChannel('icp', 'Ic', 'A', t, ic),
    dutyChs: {
      da: makeChannel('dap', 'Duty_A', '%', t, daPctArr),
      db: makeChannel('dbp', 'Duty_B', '%', t, dbPctArr),
      dc: makeChannel('dcp', 'Duty_C', '%', t, dcPctArr),
    },
  });
  const rPctUnitless = simulateFoc6Mos(makeChannel('iau', 'Ia', 'A', t, ia), makeChannel('ibu', 'Ib', 'A', t, ib), DEFAULT_FOC_MODEL, mos, ctrl, {
    icCh: makeChannel('icu', 'Ic', 'A', t, ic),
    dutyChs: {
      da: makeChannel('dau', 'Duty_A', '', t, daPctArr),
      db: makeChannel('dbu', 'Duty_B', '', t, dbPctArr),
      dc: makeChannel('dcu', 'Duty_C', '', t, dcPctArr),
    },
  });

  // Previously val > 1.5 treated 1.2% as 100% and 0.8% as 80%! Now all three match cleanly.
  assert.ok(Math.abs(rPctExplicit.duty.a[10] - 0.012) < 1e-6);
  assert.ok(Math.abs(rPctExplicit.duty.b[10] - 0.008) < 1e-6);
  assert.ok(Math.abs(rPctUnitless.pInvMeanW - rFrac.pInvMeanW) < 1e-5);
  assert.ok(Math.abs(rPctExplicit.pInvMeanW - rFrac.pInvMeanW) < 1e-5);
  assert.ok(rPctUnitless.warnings.some((w) => w.includes('按百分比')));

  // Mixed engineering-unit channels must each use their own scale. A global
  // percentage scale would incorrectly shrink the fractional B phase by 100x.
  const rMixedDuty = simulateFoc6Mos(makeChannel('iam', 'Ia', 'A', t, ia), makeChannel('ibm', 'Ib', 'A', t, ib), DEFAULT_FOC_MODEL, mos, ctrl, {
    icCh: makeChannel('icm', 'Ic', 'A', t, ic),
    dutyChs: {
      da: makeChannel('dam', 'Duty_A', '%', t, daPctArr),
      db: makeChannel('dbm', 'Duty_B', 'pu', t, dbFracArr),
      dc: makeChannel('dcm', 'Duty_C', '%', t, dcPctArr),
    },
  });
  assert.ok(Math.abs(rMixedDuty.duty.a[10] - 0.012) < 1e-6);
  assert.ok(Math.abs(rMixedDuty.duty.b[10] - 0.008) < 1e-6);
  assert.ok(Math.abs(rMixedDuty.duty.c[10] - 0.5) < 1e-6);
  assert.ok(Math.abs(rMixedDuty.pInvMeanW - rFrac.pInvMeanW) < 1e-5);
  const badDutyRange = Float32Array.from({ length: n }, () => 120);
  assert.throws(() => simulateFoc6Mos(makeChannel('iad', 'Ia', 'A', t, ia), makeChannel('ibd', 'Ib', 'A', t, ib), DEFAULT_FOC_MODEL, mos, ctrl, {
    dutyChs: {
      da: makeChannel('dad', 'Duty_A', '%', t, badDutyRange),
      db: makeChannel('dbd', 'Duty_B', '%', t, dcPctArr),
      dc: makeChannel('dcd', 'Duty_C', '%', t, dcPctArr),
    },
  }), /超过 100.5%/);

  const unbalancedIc = Float32Array.from({ length: n }, () => 2);
  const kclWarnResult = simulateFoc6Mos(makeChannel('iak', 'Ia', 'A', t, ia), makeChannel('ibk', 'Ib', 'A', t, ib), DEFAULT_FOC_MODEL, mos, ctrl, {
    icCh: makeChannel('ick', 'Ic', 'A', t, unbalancedIc),
  });
  assert.ok((kclWarnResult.phaseCurrentKclRelativePct || 0) > 5);
  assert.ok(kclWarnResult.warnings.some((w) => w.includes('KCL')));
  assert.ok(kclWarnResult.thermalConvergencePct <= kclWarnResult.junctionConvergencePct + 1e-9);

  // 3. Partial Duty selection triggers explicit fallback warning
  const rPartial = simulateFoc6Mos(makeChannel('iaP', 'Ia', 'A', t, ia), makeChannel('ibP', 'Ib', 'A', t, ib), DEFAULT_FOC_MODEL, mos, ctrl, {
    dutyChs: { da: makeChannel('daP', 'Duty_A', '', t, daFracArr), db: null, dc: null },
  });
  assert.equal(rPartial.dutySource, 'reconstructed');
  assert.ok(rPartial.warnings.some((w) => w.includes('部分外部 Duty')));

  // 4. Invalid Vbus samples must block thermal loss output; never interpolate across unknown intervals.
  const vbusGap = Float32Array.from({ length: n }, (_, i) => (i >= 40 && i <= 80 ? Number.NaN : 48.0));
  assert.throws(
    () => simulateFoc6Mos(makeChannel('iaG', 'Ia', 'A', t, ia), makeChannel('ibG', 'Ib', 'A', t, ib), DEFAULT_FOC_MODEL, mos, ctrl, {
      vbusCh: makeChannel('vbG', 'Vbus', 'V', t, vbusGap),
    }),
    /NaN\/Inf/ 
  );

  const tBack = Float64Array.from(t);
  tBack[50] = tBack[48];
  assert.throws(() => simulateFoc6Mos(makeChannel('iaB', 'Ia', 'A', tBack, ia), makeChannel('ibB', 'Ib', 'A', t, ib), DEFAULT_FOC_MODEL, mos, ctrl));

  const tNanMain = Float64Array.from(t);
  tNanMain[12] = Number.NaN;
  assert.throws(() => simulateFoc6Mos(makeChannel('iaN', 'Ia', 'A', tNanMain, ia), makeChannel('ibN', 'Ib', 'A', t, ib), DEFAULT_FOC_MODEL, mos, ctrl));

  // 5. Thermal runaway detection under excessive alpha & current (steadyThermalRunaway = true, finite output)
  const rRunaway = simulateFoc6Mos(
    makeChannel('iaR', 'Ia', 'A', t, Float32Array.from({ length: n }, () => 140)),
    makeChannel('ibR', 'Ib', 'A', t, Float32Array.from({ length: n }, () => -70)),
    DEFAULT_FOC_MODEL,
    { ...mos, rdsOn25Mohm: 20, tempCoeffAlphaPerC: 0.015 },
    ctrl,
    { icCh: makeChannel('icR', 'Ic', 'A', t, Float32Array.from({ length: n }, () => -70)) }
  );
  assert.equal(rRunaway.steadyThermalRunaway, true);
  assert.equal(rRunaway.steadyConverged, false);
  assert.ok(Number.isFinite(rRunaway.tjSteadyMaxEstC));
  assert.ok(rRunaway.warnings.some((w) => w.includes('热失控')));
});

test('Audit items #4, #5, #8, #9, #11, #13, #15, #16: strict units, single-shunt guard, Eoss, cycle resolution, hot-stall vector & substep convergence', () => {
  // #9: strict parseSiUnitScale throws on incompatible physical unit families
  assert.equal(parseSiUnitScale('mA', 'A', 'Ia', { strict: true }), 1e-3);
  assert.throws(() => parseSiUnitScale('°C', 'A', 'Temp', { strict: true }), /不匹配/);
  assert.throws(() => parseSiUnitScale('V', 'A', 'Vbus', { strict: true }), /不匹配/);
  assert.throws(() => parseSiUnitScale('%', 'V', 'Duty_A', { strict: true }), /不匹配/);
  assert.throws(() => parseSiUnitScale('', 'A', 'Motor_RPM', { strict: true }), /疑似非 A/);

  const mosBase = {
    rdsOn25Mohm: 4.5,
    tempCoeffAlphaPerC: 0.0045,
    vsdV: 0.9,
    eonPlusEoffUj: 35,
    vRefV: 48,
    iRefA: 30,
    qrrNc: 60,
    eossUj: 0,
  };
  const ctrlBase = {
    modulation: 'SVPWM' as const,
    fswHz: 20000,
    tDeadNs: 500,
    modDepthM: 0.85,
    pfAngleDeg: 0,
    tAmbC: 25,
    vBusConstV: 48,
  };

  // #8: reject duplicate Ia === Ib with single-shunt guidance
  const t20 = Float64Array.from({ length: 20 }, (_, i) => i * 1e-3);
  const i20 = Float32Array.from({ length: 20 }, (_, i) => 15 * Math.cos(2 * Math.PI * 10 * t20[i]));
  const dupCh = makeChannel('same_ch', 'I_shunt', 'A', t20, i20);
  assert.throws(() => simulateFoc6Mos(dupCh, dupCh, DEFAULT_FOC_MODEL, mosBase, ctrlBase), /单电阻/);

  // #13: active-FET Eoss scales as (Vbus/Vref)^2 once per cycle and is suppressed during clamping
  const mosEoss = { ...mosBase, eonPlusEoffUj: 0, qrrNc: 0, eossUj: 10 };
  const lZero48 = computePhaseMosLosses(0.0, 0.5, 48, 25, 25, 'SVPWM', 20000, 0, mosEoss);
  assert.ok(Math.abs(lZero48.pHighSw - 20000 * 10e-6) < 1e-9);
  assert.equal(lZero48.pLowSw, 0);

  const lPos96 = computePhaseMosLosses(1e-4, 0.5, 96, 25, 25, 'SVPWM', 20000, 0, mosEoss);
  assert.ok(Math.abs(lPos96.pHighSw - 4 * lZero48.pHighSw) < 1e-9);
  assert.equal(lPos96.pLowSw, 0);

  const lNeg48 = computePhaseMosLosses(-1e-4, 0.5, 48, 25, 25, 'SVPWM', 20000, 0, mosEoss);
  assert.equal(lNeg48.pHighSw, 0);
  assert.ok(Math.abs(lNeg48.pLowSw - 20000 * 10e-6) < 1e-9);

  const lClamped = computePhaseMosLosses(10, 1.0, 48, 25, 25, 'DPWM1', 20000, 0, mosEoss);
  assert.equal(lClamped.pHighSw, 0);
  assert.equal(lClamped.pLowSw, 0);

  // #4 & #11: zero-current center duty fallback warning + < 6 pts/elec-cycle resolution warning (NOT PWM Nyquist)
  const nCoarse = 16;
  const tCoarse = Float64Array.from({ length: nCoarse }, (_, i) => i * 0.001);
  // ~4 electrical cycles in 16 samples => ~4 pts/elec-cycle < 6 pts/elec-cycle, plus zero-current middle interval
  const iaCoarse = Float32Array.from({ length: nCoarse }, (_, i) =>
    i >= 10 && i <= 12 ? 0 : 15 * Math.cos(2 * Math.PI * 260 * tCoarse[i])
  );
  const ibCoarse = Float32Array.from({ length: nCoarse }, (_, i) =>
    i >= 10 && i <= 12 ? 0 : 15 * Math.cos(2 * Math.PI * 260 * tCoarse[i] - (2 * Math.PI) / 3)
  );
  const rCoarse = simulateFoc6Mos(
    makeChannel('iac', 'Ia', 'A', tCoarse, iaCoarse),
    makeChannel('ibc', 'Ib', 'A', tCoarse, ibCoarse),
    DEFAULT_FOC_MODEL,
    mosBase,
    ctrlBase
  );
  assert.ok(rCoarse.zeroCurrentFallbackCount >= 3);
  assert.ok(rCoarse.warnings.some((w) => w.includes('零电流') && w.includes('0.50')));
  assert.ok(rCoarse.pointsPerElecCycle !== null && rCoarse.pointsPerElecCycle < 6);
  assert.ok(rCoarse.warnings.some((w) => w.includes('电周期') && w.includes('并非开关载波')));

  // #5 & #16: Hot-stall inherits complete multi-node ThermalNetworkStateSnapshot & routes PF in user_m mode only
  const nPre = 400;
  const tPre = Float64Array.from({ length: nPre }, (_, i) => i * 0.001);
  const iaPre = Float32Array.from({ length: nPre }, (_, i) => 60 * Math.cos(2 * Math.PI * 50 * tPre[i]));
  const ibPre = Float32Array.from({ length: nPre }, (_, i) => 60 * Math.cos(2 * Math.PI * 50 * tPre[i] - (2 * Math.PI) / 3));
  const simHot = simulateFoc6Mos(
    makeChannel('iah', 'Ia', 'A', tPre, iaPre),
    makeChannel('ibh', 'Ib', 'A', tPre, ibPre),
    DEFAULT_FOC_MODEL,
    mosBase,
    ctrlBase
  );
  assert.ok(simHot.finalThermalState.tjMaxC > simHot.finalThermalState.tBoardC + 2.0);

  const coldStall = runFocStallSweep({
    iPeakA: 120,
    tjLimitC: 110,
    tAmbC: 25,
    modulation: 'SVPWM',
    modDepthM: 0.85,
    fswHz: 20000,
    tDeadNs: 200,
    mos: mosBase,
    model: DEFAULT_FOC_MODEL,
    vBusV: 48,
    horizonSec: 60,
    stallDutyMode: 'resistive',
    rPhaseOhm: 0.04,
  });
  const hotStall = runFocStallSweep({
    iPeakA: 120,
    tjLimitC: 110,
    tAmbC: 25,
    tInitialBoardC: simHot.tBoardFinalC,
    initialThermalState: simHot.finalThermalState,
    modulation: 'SVPWM',
    modDepthM: 0.85,
    pfAngleDeg: 45,
    fswHz: 20000,
    tDeadNs: 200,
    mos: mosBase,
    model: DEFAULT_FOC_MODEL,
    vBusV: 48,
    horizonSec: 60,
    stallDutyMode: 'resistive',
    rPhaseOhm: 0.04,
  });
  assert.equal(coldStall.inheritedHotState, false);
  assert.equal(hotStall.inheritedHotState, true);
  assert.equal(hotStall.effectiveStallPfAngleDeg, 0); // resistive ignores PF=45
  assert.ok(hotStall.inheritedMaxTjC !== null && hotStall.inheritedMaxTjC > hotStall.inheritedBoardTempC + 2.0);
  assert.ok(
    hotStall.tSafeSec !== null && coldStall.tSafeSec !== null && hotStall.tSafeSec < coldStall.tSafeSec,
    `Hot stall t_safe (${hotStall.tSafeSec}) must be shorter than cold stall (${coldStall.tSafeSec})`
  );

  // user_m stall forwards pfAngleDeg and shifts worst steady Tj
  const stallPf0 = runFocStallSweep({
    iPeakA: 80,
    tjLimitC: 150,
    tAmbC: 25,
    modulation: 'DPWM1',
    modDepthM: 0.9,
    pfAngleDeg: 0,
    fswHz: 20000,
    tDeadNs: 200,
    mos: mosBase,
    model: DEFAULT_FOC_MODEL,
    vBusV: 48,
    stallDutyMode: 'user_m',
  });
  const stallPf60 = runFocStallSweep({
    iPeakA: 80,
    tjLimitC: 150,
    tAmbC: 25,
    modulation: 'DPWM1',
    modDepthM: 0.9,
    pfAngleDeg: 60,
    fswHz: 20000,
    tDeadNs: 200,
    mos: mosBase,
    model: DEFAULT_FOC_MODEL,
    vBusV: 48,
    stallDutyMode: 'user_m',
  });
  assert.equal(stallPf60.effectiveStallPfAngleDeg, 60);
  assert.ok(Math.abs(stallPf60.worstSteadyTjC - stallPf0.worstSteadyTjC) > 0.1);

  // #15: Step-refinement convergence (coarse dt=10ms vs fine dt=1ms, zero alpha) + Cauer energy conservation
  const mosConstR = { ...mosBase, tempCoeffAlphaPerC: 0 };
  const makeStepConv = (dt: number, dur: number) => {
    const n = Math.round(dur / dt) + 1;
    const tArr = Float64Array.from({ length: n }, (_, i) => i * dt);
    const iaArr = Float32Array.from({ length: n }, () => 40);
    const ibArr = Float32Array.from({ length: n }, () => -20);
    const icArr = Float32Array.from({ length: n }, () => -20);
    return simulateFoc6Mos(makeChannel(`iac_${dt}`, 'Ia', 'A', tArr, iaArr), makeChannel(`ibc_${dt}`, 'Ib', 'A', tArr, ibArr), DEFAULT_FOC_MODEL, mosConstR, ctrlBase, {
      icCh: makeChannel(`icc_${dt}`, 'Ic', 'A', tArr, icArr),
    });
  };
  const coarseSim = makeStepConv(0.01, 0.2); // dt=10ms vs minTau=0.49ms (>20x minTau, resolved cleanly by <=512 substeps!)
  const fineSim = makeStepConv(0.001, 0.2);
  assert.ok(coarseSim.maxSubDtOverTau <= 0.1);
  assert.ok(
    Math.abs(coarseSim.tjMaxGlobalC - fineSim.tjMaxGlobalC) < 0.05,
    `Coarse vs fine step Tj mismatch: ${coarseSim.tjMaxGlobalC} vs ${fineSim.tjMaxGlobalC}`
  );
  // Cauer energy balance over 20s to steady state: at steady state dT/dt -> 0, T_board - T_amb ~= P_inv * R_brd, Tj_avg - T_board ~= P_mos * R_jc
  const steadySim = makeStepConv(0.05, 40.0);
  const rJcTot = DEFAULT_FOC_MODEL.zthJC.reduce((s, c) => s + c.r, 0);
  const rBrdTot = DEFAULT_FOC_MODEL.zthBoard.reduce((s, c) => s + c.r, 0);
  const expectedBrdFinal = 25 + steadySim.pInvMeanW * rBrdTot;
  assert.ok(
    Math.abs(steadySim.tBoardFinalC - expectedBrdFinal) < 0.3,
    `Board thermal balance mismatch: ${steadySim.tBoardFinalC} vs ${expectedBrdFinal}`
  );
  const ahFinal = steadySim.summaries.find((s) => s.key === 'AH')!;
  const expectedAhTj = expectedBrdFinal + ahFinal.pAvgW * rJcTot;
  assert.ok(
    Math.abs(ahFinal.tjFinalC - expectedAhTj) < 0.3,
    `Junction thermal balance mismatch: ${ahFinal.tjFinalC} vs ${expectedAhTj}`
  );
});

test('Audit P0/P1: FFT non-uniform resampling, BLDC async 3-phase & SW-node dead-time rejection', () => {
  // 1. Non-uniform timebase FFT should resample & locate 50 Hz fundamental accurately
  const n = 512;
  const tNonUni = new Float64Array(n);
  const vSine = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // Smooth warped time axis (dt varies ~2x) over 0.2 s
    const u = i / (n - 1);
    const ti = 0.2 * (0.7 * u + 0.3 * u * u);
    tNonUni[i] = ti;
    vSine[i] = Math.sin(2 * Math.PI * 50 * ti);
  }
  const spec = computeFFT(
    tNonUni,
    vSine,
    n / 0.2,
    { window: 'hann', scale: 'magnitude', range: 'entire', removeDC: true, zeroPadding: 1 },
    'ch_nonuni',
    'Sine50'
  );
  assert.ok(spec.nonUniformWarning && spec.nonUniformWarning.includes('Non-uniform sampling'));
  const fund = spec.peaks.find((p) => p.isFundamental) || spec.peaks[0];
  assert.ok(fund && Math.abs(fund.frequency - 50) < 3.0, `Expected ~50 Hz peak, got ${fund?.frequency}`);

  // 2. Unsynchronized 3-phase waveforms (different sample rate + start offset) must interpolate to ~120 deg
  const makePhase = (id: string, name: string, count: number, phaseRad: number, tOff = 0) => {
    const t = Float64Array.from({ length: count }, (_, i) => tOff + (i / (count - 1)) * 0.04);
    const v = Float32Array.from({ length: count }, (_, i) => 10 * Math.sin(2 * Math.PI * 100 * t[i] + phaseRad));
    return makeChannel(id, name, 'V', t, v);
  };
  const bal = analyzeThreePhaseBalance(
    makePhase('pu', 'U', 401, 0, 0),
    makePhase('pv', 'V', 333, -(2 * Math.PI) / 3, 0.0002),
    makePhase('pw', 'W', 275, (2 * Math.PI) / 3, 0.0001)
  );
  assert.equal(bal.resampled, true);
  assert.ok(bal.warnings.length > 0);
  assert.ok(bal.zeroSeqRms < 0.2, `Expected near-zero V0 after time interpolation, got ${bal.zeroSeqRms}`);
  assert.ok(bal.maxPhaseErrorDeg !== null && bal.maxPhaseErrorDeg < 2.5, `Phase err=${bal.maxPhaseErrorDeg}`);

  // 3. SW node selected as high-side input should mark deadTimeReliable = false
  const tPwm = Float64Array.from({ length: 400 }, (_, i) => i * 1e-7);
  const swArr = Float32Array.from({ length: 400 }, (_, i) => ((i % 40) < 20 ? 48 : 0));
  const glArr = Float32Array.from({ length: 400 }, (_, i) => ((i % 40) >= 22 && (i % 40) < 38 ? 12 : 0));
  const pwmRes = analyzePwmSwitchingAndDeadTime(
    makeChannel('sw', 'SW_PhaseA', 'V', tPwm, swArr),
    makeChannel('gl', 'Gate_GL', 'V', tPwm, glArr)
  );
  assert.equal(pwmRes.highSignalRole, 'sw_node');
  assert.equal(pwmRes.deadTimeReliable, false);
  assert.ok(pwmRes.warnings.some((w) => w.includes('SW')));
});

test('Audit P0/P1: Dynamic SOA fail-closed INVALID, temp validation, ZVS Eoss skip, asymmetric FOC Rjc & DPT', () => {
  // 1. Dynamic SOA returns INVALID (never pass: true) on all-NaN or disjoint timebases
  const tA = new Float64Array([0, 1e-4, 2e-4, 3e-4, 4e-4]);
  const nanArr = Float32Array.from({ length: 5 }, () => Number.NaN);
  const resNan = evaluateDynamicSoa(
    makeChannel('vn', 'Vds', 'V', tA, nanArr),
    makeChannel('in', 'Ids', 'A', tA, nanArr),
    SOA_PRESETS[0]
  );
  assert.equal(resNan.status, 'INVALID');
  assert.equal(resNan.pass, false);
  assert.equal(resNan.invalidData, true);

  const tDisjoint = new Float64Array([10, 11, 12, 13, 14]);
  const resDisjoint = evaluateDynamicSoa(
    makeChannel('v1', 'Vds', 'V', tA, new Float32Array([20, 20, 20, 20, 20])),
    makeChannel('i1', 'Ids', 'A', tDisjoint, new Float32Array([5, 5, 5, 5, 5])),
    SOA_PRESETS[0]
  );
  assert.equal(resDisjoint.status, 'INVALID');
  assert.equal(resDisjoint.pass, false);

  // 2. Temperature validation rejects raw NTC voltage / ADC and converts Kelvin
  const tTh = Float64Array.from({ length: 100 }, (_, i) => i * 0.05);
  const vRawNtc = makeChannel('ntc', 'V_NTC', 'V', tTh, Float32Array.from({ length: 100 }, () => 2.5));
  assert.throws(() => validateTemperatureChannel(vRawNtc));
  const kRes = validateTemperatureChannel(
    makeChannel('tk', 'Tj_K', 'K', tTh, Float32Array.from({ length: 100 }, () => 300.15))
  );
  assert.equal(kRes.offsetC, -273.15);
  assert.throws(
    () => validateTemperatureChannel(makeChannel('t-unknown', 'Temperature', '', tTh, new Float32Array(100).fill(25))),
    /未标注温度单位/
  );

  // Non-monotonic timebase rejected by deconvolveThermalImpedance
  const tBad = Float64Array.from({ length: 50 }, (_, i) => (i === 25 ? 0.1 : i * 0.05));
  const tempGood = makeChannel(
    't_good',
    'Tj',
    '°C',
    tBad,
    Float32Array.from({ length: 50 }, (_, i) => 25 + 30 * (1 - Math.exp(-(i * 0.05) / 0.5)))
  );
  assert.throws(() =>
    deconvolveThermalImpedance(tempGood.t, Float64Array.from(tempGood.v), { mode: 'cooling', powerW: 10, targetOrder: 2 })
  );

  // Thermal deconvolution must reject truncated arrays and invalid samples
  // inside the selected gate instead of silently deleting them before fitting.
  const validThermalT = Float64Array.from({ length: 80 }, (_, i) => i * 0.05);
  const validThermalY = Float64Array.from(validThermalT, (t) => 25 + 20 * (1 - Math.exp(-t / 0.6)));
  assert.throws(
    () => deconvolveThermalImpedance(validThermalT, validThermalY.slice(0, -1), { mode: 'heating', powerW: 10, targetOrder: 2 }),
    /长度不一致/
  );
  const invalidThermalY = validThermalY.slice();
  invalidThermalY[30] = Number.NaN;
  assert.throws(
    () => deconvolveThermalImpedance(validThermalT, invalidThermalY, { mode: 'heating', powerW: 10, targetOrder: 2 }),
    /NaN\/Inf/
  );

  // 3. Rds feedback toggle & ZVS Eoss skip check
  const nL = 400;
  const tL = Float64Array.from({ length: nL }, (_, i) => i * 1e-6);
  const vL = Float32Array.from({ length: nL }, () => 40);
  const iL = Float32Array.from({ length: nL }, () => 20);
  const cauerTest = [{ r: 2.0, c: 0.002, tauEst: 0.004, layerLabel: 'Die' }];
  const simFbOn = computeLossWithDeskewAndEoss(
    makeChannel('vl1', 'Vds', 'V', tL, vL),
    makeChannel('il1', 'Ids', 'A', tL, iL),
    cauerTest,
    { deskewNs: 0, eossUj: 0, tAmbC: 25, rdsOn25Mohm: 10, tempCoeffAlphaPerC: 0.0045, rdsFeedbackEnabled: true }
  );
  const simFbOff = computeLossWithDeskewAndEoss(
    makeChannel('vl2', 'Vds', 'V', tL, vL),
    makeChannel('il2', 'Ids', 'A', tL, iL),
    cauerTest,
    { deskewNs: 0, eossUj: 0, tAmbC: 25, rdsOn25Mohm: 10, tempCoeffAlphaPerC: 0.0045, rdsFeedbackEnabled: false }
  );
  assert.ok(simFbOn.warnings.some((w) => w.includes('Rds(on)(Tj)')));
  assert.equal(simFbOff.warnings.some((w) => w.includes('Rds(on)(Tj)')), false);
  assert.ok(simFbOn.tjMaxC > simFbOff.tjMaxC);
  assert.ok(Math.abs(simFbOff.pLossMeanW - 800) < 1);

  // 4. FOC 6-MOS asymmetric perSwitchRjcScale + SPICE nodal validation + datasheet Rjc constraint
  const constrainedModel = splitCauerToFocModel(
    [
      { r: 0.4, c: 0.005, tauEst: 0.002, layerLabel: 'Die' },
      { r: 1.6, c: 0.5, tauEst: 0.8, layerLabel: 'PCB' },
    ],
    0.05,
    { pathMode: 'junction_ambient', rJcDatasheetOhm: 0.4 }
  );
  assert.equal(constrainedModel.modelKind, 'datasheet_constrained');
  const asymModel = { ...constrainedModel, perSwitchRjcScale: [1.0, 1.3, 1.0, 1.0, 1.0, 1.0] };
  const nF = 200;
  const tF = Float64Array.from({ length: nF }, (_, i) => i * 5e-4);
  const iaF = Float32Array.from({ length: nF }, (_, i) => 25 * Math.sin(2 * Math.PI * 50 * tF[i]));
  const ibF = Float32Array.from({ length: nF }, (_, i) => 25 * Math.sin(2 * Math.PI * 50 * tF[i] - (2 * Math.PI) / 3));
  const simAsym = simulateFoc6Mos(
    makeChannel('fia', 'Ia', 'A', tF, iaF),
    makeChannel('fib', 'Ib', 'A', tF, ibF),
    asymModel,
    { rdsOn25Mohm: 5, tempCoeffAlphaPerC: 0.0045, eonPlusEoffUj: 400, eossUj: 10, qrrNc: 30, vRefV: 48, iRefA: 25, vsdV: 0.8 },
    { vBusConstV: 48, tAmbC: 25, modulation: 'SVPWM', modDepthM: 0.85, pfAngleDeg: 0, fswHz: 20000, tDeadNs: 200 }
  );
  assert.ok(simAsym.warnings.some((w) => w.includes('Eoss') && w.includes('Coss')));
  assert.ok(simAsym.warnings.some((w) => w.includes('单颗硬开关 MOS')));
  const ah = simAsym.summaries.find((s) => s.key === 'AH')!;
  const al = simAsym.summaries.find((s) => s.key === 'AL')!;
  assert.ok(al.tjPeakC > ah.tjPeakC, `Expected AL with 1.3x Rjc (${al.tjPeakC}) > AH (${ah.tjPeakC})`);
  const spiceText = focModelToSpice(asymModel);
  const spiceCheck = validateFocSpiceNetlist(spiceText, asymModel);
  assert.equal(spiceCheck.valid, true);

  // 5. P1 Double Pulse Test (DPT) analyzer on synthetic realistic DPT capture
  const demoDpt = generateDptDemoChannels();
  const dptRes = analyzeDoublePulseTest(demoDpt.vgsCh, demoDpt.vdsCh, demoDpt.idsCh);
  assert.equal(dptRes.valid, true);
  assert.equal(dptRes.hasTurnOff, true);
  assert.equal(dptRes.hasTurnOn, true);
  assert.ok(dptRes.eOffUj > 10 && dptRes.eOffUj < 5000);
  assert.ok(dptRes.eOnUj > 10 && dptRes.eOnUj < 5000);
  assert.ok(dptRes.vdsPeakV > dptRes.vBusSteadyV + 5);
  assert.ok(dptRes.vMillerPlateauV !== null && dptRes.vMillerPlateauV > 3.0 && dptRes.vMillerPlateauV < 7.0);
  assert.ok(dptRes.iRrPeakA > 5 && dptRes.qRrNc > 10);
});

test('SOA rejects malformed curves, mismatched arrays, invalid units and out-of-curve extrapolation', () => {
  const t = Float64Array.from({ length: 8 }, (_, i) => i * 1e-4);
  const v = new Float32Array(8).fill(24);
  const i = new Float32Array(8).fill(10);

  const badUnit = evaluateDynamicSoa(
    makeChannel('bad-v', 'Vds', 's', t, v),
    makeChannel('good-i', 'Ids', 'A', t, i),
    SOA_PRESETS[0]
  );
  assert.equal(badUnit.status, 'INVALID');
  assert.equal(badUnit.pass, false);

  const mismatched = makeChannel('short-i', 'Ids', 'A', t, i);
  mismatched.v = new Float32Array(7).fill(10);
  const shapeInvalid = evaluateDynamicSoa(
    makeChannel('good-v', 'Vds', 'V', t, v),
    mismatched,
    SOA_PRESETS[0]
  );
  assert.equal(shapeInvalid.status, 'INVALID');

  const incompleteCurve = {
    ...SOA_PRESETS[0],
    curves: { ...SOA_PRESETS[0].curves, '10ms': [] },
  } as typeof SOA_PRESETS[number];
  const curveInvalid = evaluateDynamicSoa(
    makeChannel('curve-v', 'Vds', 'V', t, v),
    makeChannel('curve-i', 'Ids', 'A', t, i),
    incompleteCurve
  );
  assert.equal(curveInvalid.status, 'INVALID');

  assert.equal(
    Number.isNaN(interpolateSoaCurveAtVds([{ vds: 1, id: 10 }, { vds: 10, id: 1 }], 12)),
    true,
    'SOA interpolation must not flat-extrapolate an undefined high-voltage region'
  );
});

test('FFT rejects mismatched and non-monotonic timebases but resamples valid non-uniform captures', () => {
  const uniformT = Float64Array.from({ length: 128 }, (_, i) => i / 128000);
  const sine = Float32Array.from(uniformT, (t) => Math.sin(2 * Math.PI * 1000 * t));
  assert.throws(
    () => computeFFT(uniformT, sine.slice(0, -1), 128000, { range: 'entire', window: 'hann', scale: 'magnitude', zeroPadding: 1, removeDC: true }, 'fft-bad-len', 'bad length'),
    /长度不一致/
  );

  const nonMonotonicT = uniformT.slice();
  nonMonotonicT[40] = nonMonotonicT[39];
  assert.throws(
    () => computeFFT(nonMonotonicT, sine, 128000, { range: 'entire', window: 'hann', scale: 'magnitude', zeroPadding: 1, removeDC: true }, 'fft-bad-time', 'bad time'),
    /非单调/
  );

  const invalidSpectrum = sine.slice();
  invalidSpectrum[50] = Number.NaN;
  assert.throws(
    () => computeFFT(uniformT, invalidSpectrum, 128000, { range: 'entire', window: 'hann', scale: 'magnitude', zeroPadding: 1, removeDC: true }, 'fft-bad-value', 'bad value'),
    /NaN\/Inf/
  );

  const jitteredT = Float64Array.from(uniformT, (t, i) => t + (i % 2 ? 0.08 / 128000 : 0));
  const jitteredSine = Float32Array.from(jitteredT, (t) => Math.sin(2 * Math.PI * 1000 * t));
  const resampled = computeFFT(jitteredT, jitteredSine, 128000, { range: 'entire', window: 'hann', scale: 'magnitude', zeroPadding: 1, removeDC: true }, 'fft-jittered', 'jittered');
  assert.match(resampled.nonUniformWarning || '', /resampled/);
});

test('common timebase alignment rejects mismatched sample arrays and NaN values in the analysis window', () => {
  const t = Float64Array.from({ length: 12 }, (_, i) => i * 1e-3);
  const a = makeChannel('sync-a', 'Ia', 'A', t, new Float32Array(12).fill(1));
  const short = makeChannel('sync-short', 'Ib', 'A', t, new Float32Array(11).fill(1));
  const lengthFail = alignChannelsToCommonTimebase([a, short]);
  assert.equal(lengthFail.valid, false);
  assert.match(lengthFail.invalidReason || '', /一一对应关系已破坏/);

  const nanValues = new Float32Array(12).fill(1);
  nanValues[5] = Number.NaN;
  const badSignal = makeChannel('sync-nan', 'Ic', 'A', t, nanValues);
  const valueFail = alignChannelsToCommonTimebase([a, badSignal]);
  assert.equal(valueFail.valid, false);
  assert.match(valueFail.invalidReason || '', /NaN\/Inf/);

  const offGridT = Float64Array.from({ length: 12 }, (_, i) => i * 1e-3 + (i % 2 ? 1e-4 : 0));
  const offGridBad = new Float32Array(12).fill(1);
  offGridBad[5] = Number.NaN;
  const offGridFail = alignChannelsToCommonTimebase([a, makeChannel('sync-offgrid-nan', 'Ib', 'A', offGridT, offGridBad)]);
  assert.equal(offGridFail.valid, false, 'resampling must not skip invalid source points that do not land on the target grid');
});

test('FOC thermal simulation rejects duplicate timestamps and incomplete auxiliary coverage', () => {
  const duplicateT = new Float64Array([0, 0.001, 0.001, 0.003, 0.004, 0.005]);
  const goodT = new Float64Array([0, 0.001, 0.002, 0.003, 0.004, 0.005]);
  const ia = makeChannel('ia-dup', 'Ia', 'A', duplicateT, new Float32Array([1, 2, 3, 4, 5, 6]));
  const ib = makeChannel('ib-good', 'Ib', 'A', goodT, new Float32Array([1, 2, 3, 4, 5, 6]));
  const mos = {
    rdsOn25Mohm: 5,
    tempCoeffAlphaPerC: 0.0045,
    eonPlusEoffUj: 100,
    eossUj: 0,
    qrrNc: 0,
    vRefV: 48,
    iRefA: 10,
    vsdV: 0.8,
  };
  const ctrl = {
    vBusConstV: 48,
    tAmbC: 25,
    modulation: 'SVPWM' as const,
    modDepthM: 0.8,
    pfAngleDeg: 0,
    fswHz: 20000,
    tDeadNs: 200,
  };
  assert.throws(() => simulateFoc6Mos(ia, ib, DEFAULT_FOC_MODEL, mos, ctrl), /重复时间戳/);

  const iaGood = makeChannel('ia-good', 'Ia', 'A', goodT, new Float32Array([1, 2, 3, 4, 5, 6]));
  const ibPartialT = new Float64Array([0.001, 0.002, 0.003, 0.004, 0.005]);
  const ibPartial = makeChannel('ib-partial', 'Ib', 'A', ibPartialT, new Float32Array([1, 2, 3, 4, 5]));
  const clippedOverlap = simulateFoc6Mos(iaGood, ibPartial, DEFAULT_FOC_MODEL, mos, ctrl);
  assert.ok(clippedOverlap.alignmentWarnings.some((w) => w.includes('裁剪到共同覆盖区间')));

  // A large gap entirely outside the selected gate must not invalidate the
  // clean measured interval; only gaps intersecting the actual gate are fatal.
  const gatedGapT = Float64Array.from({ length: 12 }, (_, i) => i < 6 ? i * 0.001 : 0.5 + (i - 6) * 0.001);
  const gatedIa = makeChannel('ia-gated-gap', 'Ia', 'A', gatedGapT, new Float32Array(12).fill(4));
  const gatedIb = makeChannel('ib-gated-gap', 'Ib', 'A', gatedGapT, new Float32Array(12).fill(-2));
  const cleanStartGate = simulateFoc6Mos(gatedIa, gatedIb, DEFAULT_FOC_MODEL, mos, ctrl, {
    tStart: 0.5,
    tEnd: 0.505,
    gateThermalMode: 'cold',
  });
  assert.equal(cleanStartGate.time.length, 6);
  const cleanEndGate = simulateFoc6Mos(gatedIa, gatedIb, DEFAULT_FOC_MODEL, mos, ctrl, {
    tStart: 0,
    tEnd: 0.005,
    gateThermalMode: 'cold',
  });
  assert.equal(cleanEndGate.time.length, 6);
});

import { alignChannelsToCommonTimebase, inspectChannelSamplingGaps } from './timeSync';
import { reconstructSingleShuntPhaseCurrents } from './singleShuntRecon';

test('Round-2 P0/P1: timeSync fail-closed, SOA INDETERMINATE, Loss INCOMPLETE/preheat/Tpad, FOC splitFeasible/eonIncludesQrr, DPT LUT & Single-Shunt Recon', () => {
  // 1. timeSync fail-closed on non-monotonic timestamps & gap detection
  const tNonMono = new Float64Array([0, 0.001, 0.0005, 0.002, 0.003]);
  const chGood = makeChannel('ts_g', 'V1', 'V', new Float64Array([0, 0.001, 0.002, 0.003, 0.004]), new Float32Array([1, 2, 3, 4, 5]));
  const chBadT = makeChannel('ts_b', 'V2', 'V', tNonMono, new Float32Array([1, 2, 3, 4, 5]));
  const syncedFail = alignChannelsToCommonTimebase([chGood, chBadT]);
  assert.equal(syncedFail.valid, false);
  assert.ok(syncedFail.invalidReason && syncedFail.invalidReason.length > 0);

  const tGapped = new Float64Array([0, 0.001, 0.002, 0.003, 0.020, 0.021, 0.022]);
  const gapRep = inspectChannelSamplingGaps(tGapped);
  assert.equal(gapRep.gapCount, 1);
  assert.ok(gapRep.maxGapRatio > 10);

  // 2. Dynamic SOA partial NaN & sampling gap -> INDETERMINATE (never PASS)
  const nSoa = 50;
  const tSoa = Float64Array.from({ length: nSoa }, (_, i) => i * 1e-4);
  const vSoa = Float32Array.from({ length: nSoa }, () => 24);
  const iSoaPartialNan = Float32Array.from({ length: nSoa }, (_, i) => (i === 25 ? Number.NaN : 10));
  const soaPartial = evaluateDynamicSoa(
    makeChannel('vs_p', 'Vds', 'V', tSoa, vSoa),
    makeChannel('is_p', 'Ids', 'A', tSoa, iSoaPartialNan),
    SOA_PRESETS[0],
    { forcedPulseKey: '1ms' }
  );
  assert.equal(soaPartial.status, 'INDETERMINATE');
  assert.equal(soaPartial.pass, false);

  const tSoaGap = Float64Array.from({ length: 20 }, (_, i) => (i < 10 ? i * 1e-4 : 0.005 + (i - 10) * 1e-4));
  const soaGap = evaluateDynamicSoa(
    makeChannel('vs_g', 'Vds', 'V', tSoaGap, new Float32Array(20).fill(24)),
    makeChannel('is_g', 'Ids', 'A', tSoaGap, new Float32Array(20).fill(10)),
    SOA_PRESETS[0],
    { forcedPulseKey: '1ms' }
  );
  assert.equal(soaGap.status, 'INDETERMINATE');
  assert.equal(soaGap.pass, false);
  assert.ok(soaGap.gapCount >= 1);

  // 3. computeLossWithDeskewAndEoss: incomplete on NaN, out-of-coverage & gap; preheat initialTjC; pad_ambient; <=5% deskew trim
  const nLoss = 100;
  const tLoss = Float64Array.from({ length: nLoss }, (_, i) => i * 1e-4);
  const vLoss = Float32Array.from({ length: nLoss }, () => 20);
  const iLoss = Float32Array.from({ length: nLoss }, () => 10);
  const stages = [{ r: 1.0, c: 0.01, tauEst: 0.01, layerLabel: 'Die' }];

  const iLossNan = Float32Array.from(iLoss);
  iLossNan[40] = Number.NaN;
  const lossNan = computeLossWithDeskewAndEoss(
    makeChannel('vl_n', 'Vds', 'V', tLoss, vLoss),
    makeChannel('il_n', 'Ids', 'A', tLoss, iLossNan),
    stages,
    { deskewNs: 0, eossUj: 0, rdsOn25Mohm: 0, tempCoeffAlphaPerC: 0, tAmbC: 25 }
  );
  assert.equal(lossNan.incomplete, true);
  assert.ok(Number.isNaN(lossNan.energyRawMj));

  const tIdsShort = Float64Array.from({ length: 40 }, (_, i) => i * 1e-4);
  const lossCov = computeLossWithDeskewAndEoss(
    makeChannel('vl_c', 'Vds', 'V', tLoss, vLoss),
    makeChannel('il_c', 'Ids', 'A', tIdsShort, new Float32Array(40).fill(10)),
    stages,
    { deskewNs: 0, eossUj: 0, rdsOn25Mohm: 0, tempCoeffAlphaPerC: 0, tAmbC: 25 }
  );
  assert.equal(lossCov.incomplete, true);


  // A switching transition represented by only two acquired samples cannot support a credible edge-energy/Tj result.
  const tFastEdge = Float64Array.from({ length: 8 }, (_, i) => i * 1e-6);
  const vFastEdge = Float32Array.from([0, 0, 100, 100, 100, 100, 100, 100]);
  const iFastEdge = Float32Array.from([10, 10, 0, 0, 0, 0, 0, 0]);
  const underResolved = computeLossWithDeskewAndEoss(
    makeChannel('v_fast_edge', 'Vds', 'V', tFastEdge, vFastEdge),
    makeChannel('i_fast_edge', 'Ids', 'A', tFastEdge, iFastEdge),
    stages,
    { deskewNs: 0, eossUj: 0, rdsOn25Mohm: 0, tempCoeffAlphaPerC: 0, tAmbC: 25 }
  );
  assert.equal(underResolved.incomplete, true);
  assert.ok(underResolved.incompleteReasons.some((reason) => reason.includes('少于 4 个采样点')));
  assert.ok(Number.isNaN(underResolved.tjMaxC));

  assert.throws(() => computeLossWithDeskewAndEoss(
    makeChannel('v_bad_initial_tj', 'Vds', 'V', tLoss, vLoss),
    makeChannel('i_bad_initial_tj', 'Ids', 'A', tLoss, iLoss),
    stages,
    { deskewNs: 0, eossUj: 0, rdsOn25Mohm: 0, tempCoeffAlphaPerC: 0, tAmbC: 25, initialTjC: -300 }
  ), /初始结温.*绝对零度/);
  assert.throws(() => computeLossWithDeskewAndEoss(
    makeChannel('v_bad_node_t', 'Vds', 'V', tLoss, vLoss),
    makeChannel('i_bad_node_t', 'Ids', 'A', tLoss, iLoss),
    stages,
    { deskewNs: 0, eossUj: 0, rdsOn25Mohm: 0, tempCoeffAlphaPerC: 0, tAmbC: 25, initialNodeT: [25, -300, 25] }
  ), /initialNodeT.*绝对零度/);

  assert.throws(() => computeLossWithDeskewAndEoss(
    makeChannel('v_no_rc', 'Vds', 'V', tLoss, vLoss),
    makeChannel('i_no_rc', 'Ids', 'A', tLoss, iLoss),
    [],
    { deskewNs: 0, eossUj: 0, rdsOn25Mohm: 0, tempCoeffAlphaPerC: 0, tAmbC: 25 }
  ), /缺少 Cauer 热网络/);


  assert.throws(() => computeLossWithDeskewAndEoss(
    makeChannel('v_rds_required', 'Vds', 'V', tLoss, vLoss),
    makeChannel('i_rds_required', 'Ids', 'A', tLoss, iLoss),
    stages,
    { deskewNs: 0, eossUj: 0, rdsOn25Mohm: 0, tempCoeffAlphaPerC: 0, tAmbC: 25, rdsFeedbackEnabled: true }
  ), /缺少有效的 Rds\(on\)@25°C/);

  const noEossCorrection = computeLossWithDeskewAndEoss(
    makeChannel('v_no_eoss', 'Vds', 'V', tLoss, vLoss),
    makeChannel('i_no_eoss', 'Ids', 'A', tLoss, iLoss),
    stages,
    { deskewNs: 0, eossUj: 0, rdsOn25Mohm: 0, tempCoeffAlphaPerC: 0, tAmbC: 25, rdsFeedbackEnabled: false }
  );
  assert.ok(noEossCorrection.warnings.some((warning) => warning.includes('未提供 Eoss')));

  const tLossGap = Float64Array.from({ length: 30 }, (_, i) => (i < 15 ? i * 1e-4 : 0.005 + (i - 15) * 1e-4));
  const lossGap = computeLossWithDeskewAndEoss(
    makeChannel('vl_g', 'Vds', 'V', tLossGap, new Float32Array(30).fill(20)),
    makeChannel('il_g', 'Ids', 'A', tLossGap, new Float32Array(30).fill(10)),
    stages,
    { deskewNs: 0, eossUj: 0, rdsOn25Mohm: 0, tempCoeffAlphaPerC: 0, tAmbC: 25 }
  );
  assert.equal(lossGap.incomplete, true);

  // Small <=5% deskew shift (0.2ms on 10ms window = 2%) trims edges cleanly without marking incomplete
  const lossDeskewTrim = computeLossWithDeskewAndEoss(
    makeChannel('vl_d', 'Vds', 'V', tLoss, vLoss),
    makeChannel('il_d', 'Ids', 'A', tLoss, iLoss),
    stages,
    { deskewNs: 200_000, eossUj: 0, rdsOn25Mohm: 0, tempCoeffAlphaPerC: 0, tAmbC: 25, initialTjC: 65, pathMode: 'pad_ambient' }
  );
  assert.equal(lossDeskewTrim.incomplete, false);
  assert.equal(lossDeskewTrim.thermalPathMode, 'pad_ambient');
  assert.ok(Math.abs(lossDeskewTrim.tjC[0] - 65) < 1e-4);
  assert.ok(lossDeskewTrim.warnings.some((w) => w.includes('Tpad')));

  // 4. FOC splitFeasible false guard, eonIncludesQrr flag & binary duty rejection
  const infeasibleModel = splitCauerToFocModel(
    [{ r: 0.4, c: 0.05, tauEst: 0.02, layerLabel: 'Single' }],
    0.05,
    { pathMode: 'junction_ambient', rJcDatasheetOhm: 0.5 }
  );
  assert.equal(infeasibleModel.splitFeasible, false);

  const nF = 100;
  const tF = Float64Array.from({ length: nF }, (_, i) => i * 5e-4);
  const iaF = Float32Array.from({ length: nF }, (_, i) => 20 * Math.sin(2 * Math.PI * 50 * tF[i]));
  const ibF = Float32Array.from({ length: nF }, (_, i) => 20 * Math.sin(2 * Math.PI * 50 * tF[i] - (2 * Math.PI) / 3));
  const mosFoc = { rdsOn25Mohm: 5, tempCoeffAlphaPerC: 0.0045, vsdV: 0.9, eonPlusEoffUj: 80, vRefV: 48, iRefA: 20, qrrNc: 120, eossUj: 0 };
  const ctrlFoc = { modulation: 'SVPWM' as const, fswHz: 20000, tDeadNs: 200, modDepthM: 0.85, pfAngleDeg: 0, tAmbC: 25, vBusConstV: 48 };
  assert.throws(() =>
    simulateFoc6Mos(makeChannel('f_ia', 'Ia', 'A', tF, iaF), makeChannel('f_ib', 'Ib', 'A', tF, ibF), infeasibleModel, mosFoc, ctrlFoc)
  );

  const lossNoQrrFlag = computePhaseMosLosses(20, 0.7, 48, 25, 25, 'SVPWM', 20000, 200, { ...mosFoc, eonIncludesQrr: false });
  const lossWithQrrFlag = computePhaseMosLosses(20, 0.7, 48, 25, 25, 'SVPWM', 20000, 200, { ...mosFoc, eonIncludesQrr: true });
  assert.ok(lossWithQrrFlag.pHighSw < lossNoQrrFlag.pHighSw && lossNoQrrFlag.pHighSw - lossWithQrrFlag.pHighSw > 0.05);

  const binGate = Float32Array.from({ length: nF }, (_, i) => (i % 2 === 0 ? 1 : 0));
  assert.throws(() =>
    simulateFoc6Mos(makeChannel('fb_ia', 'Ia', 'A', tF, iaF), makeChannel('fb_ib', 'Ib', 'A', tF, ibF), DEFAULT_FOC_MODEL, mosFoc, ctrlFoc, {
      dutyChs: {
        da: makeChannel('bda', 'Duty_A', '', tF, binGate),
        db: makeChannel('bdb', 'Duty_B', '', tF, binGate),
        dc: makeChannel('bdc', 'Duty_C', '', tF, binGate),
      },
    })
  );

  // 5. DPT eonIncludesQrr & multi-point LUT interpolation
  const demoDpt = generateDptDemoChannels();
  const dptRes = analyzeDoublePulseTest(demoDpt.vgsCh, demoDpt.vdsCh, demoDpt.idsCh);
  assert.equal(dptRes.eonIncludesQrr, true);
  assert.ok(dptRes.eOnSansQrrUj <= dptRes.eOnUj + 1e-6);

  const lutInterp = interpolateDptSwitchingLoss(
    [
      { id: 'p1', vBusV: 40, iLoadA: 20, tjC: 25, rgOhm: 5, eOnUj: 30, eOffUj: 20, qRrNc: 40, eOnSansQrrUj: 25 },
      { id: 'p2', vBusV: 80, iLoadA: 40, tjC: 25, rgOhm: 5, eOnUj: 90, eOffUj: 60, qRrNc: 80, eOnSansQrrUj: 75 },
    ],
    60,
    30
  );
  assert.ok(lutInterp !== null && Math.abs(lutInterp.eOnUj - 60) < 1e-6 && Math.abs(lutInterp.eOffUj - 40) < 1e-6);

  // 6. Single-Shunt SVPWM phase current reconstruction & blind-zone flagging
  const nSs = 200;
  const tSs = Float64Array.from({ length: nSs }, (_, i) => i * 1e-4);
  const daSs = new Float32Array(nSs);
  const dbSs = new Float32Array(nSs);
  const dcSs = new Float32Array(nSs);
  const idcSs = new Float32Array(nSs);
  const iAmp = 20;
  for (let k = 0; k < nSs; k++) {
    const th = 2 * Math.PI * 50 * tSs[k];
    const iaTrue = iAmp * Math.sin(th);
    const ibTrue = iAmp * Math.sin(th - (2 * Math.PI) / 3);
    const icTrue = -(iaTrue + ibTrue);
    const va = 0.4 * Math.sin(th);
    const vb = 0.4 * Math.sin(th - (2 * Math.PI) / 3);
    const vc = -(va + vb);
    const vcm = -0.5 * (Math.max(va, vb, vc) + Math.min(va, vb, vc));
    daSs[k] = 0.5 + va + vcm;
    dbSs[k] = 0.5 + vb + vcm;
    dcSs[k] = 0.5 + vc + vcm;
    idcSs[k] = iaTrue * daSs[k] + ibTrue * dbSs[k] + icTrue * dcSs[k];
  }
  const ssRes = reconstructSingleShuntPhaseCurrents(
    makeChannel('ss_idc', 'Idc', 'A', tSs, idcSs),
    makeChannel('ss_da', 'Duty_A', '', tSs, daSs),
    makeChannel('ss_db', 'Duty_B', '', tSs, dbSs),
    makeChannel('ss_dc', 'Duty_C', '', tSs, dcSs),
    { fswHz: 20000, tMinSec: 3.0e-6 }
  );
  assert.equal(ssRes.valid, true);
  assert.equal(ssRes.mode, 'continuous_duty');
  assert.ok(ssRes.blindCount > 0 && ssRes.blindZoneFractionPct > 0);
  // Check KCL Ia+Ib+Ic ~= 0 & peak recovery near 20A away from blind zones
  let maxIa = 0;
  for (let k = 0; k < ssRes.ia.length; k++) {
    assert.ok(Math.abs(ssRes.ia[k] + ssRes.ib[k] + ssRes.ic[k]) < 1e-4);
    if (!ssRes.blindMask[k] && Math.abs(ssRes.ia[k]) > maxIa) maxIa = Math.abs(ssRes.ia[k]);
  }
  assert.ok(Math.abs(maxIa - iAmp) < 1.5, `Expected reconstructed peak ~${iAmp}A, got ${maxIa}`);

  const ssBadT = reconstructSingleShuntPhaseCurrents(
    makeChannel('ss_bad', 'Idc', 'A', new Float64Array([0, 0.002, 0.001, 0.003]), new Float32Array([1, 2, 3, 4])),
    makeChannel('ss_da2', 'Duty_A', '', new Float64Array([0, 0.001, 0.002, 0.003]), new Float32Array([0.5, 0.6, 0.7, 0.8])),
    makeChannel('ss_db2', 'Duty_B', '', new Float64Array([0, 0.001, 0.002, 0.003]), new Float32Array([0.5, 0.4, 0.3, 0.2])),
    makeChannel('ss_dc2', 'Duty_C', '', new Float64Array([0, 0.001, 0.002, 0.003]), new Float32Array([0.5, 0.5, 0.5, 0.5]))
  );
  assert.equal(ssBadT.valid, false);
});


test('CSV manual sample-rate override thins explicit Time rows and retains original source values', () => {
  const csv = 'Time (ms),Ia\n10,1\n10.5,2\n11.0,3\n';
  const preview = previewCsv(csv);
  assert.equal(preview.timeColIndex, 0);

  const previewMeta = computeCsvPreviewQuality(csv, preview, 'ms', 2000);
  assert.ok(previewMeta);
  assert.ok(Math.abs((previewMeta!.sampleRate || 0) - 2000) < 1e-6);
  assert.equal(previewMeta!.originalTimeStart, 0.01);
  assert.equal(previewMeta!.originalTimeEnd, 0.011);

  const parsed = parseFullCsv(csv, {
    delimiter: ',', hasHeader: true, skipLines: 0, timeColIndex: 0,
    timeUnit: 'ms', sampleRateOverrideHz: 1000,
    columnMappings: preview.columnMappings, resample: false, colors: ['#fff'],
  });
  const ch = parsed.channels[parsed.drawOrder[0]];
  assert.deepEqual(Array.from(ch.t), [0.01, 0.011]);
  assert.deepEqual(Array.from(ch.v), [1, 3]);
  assert.ok(ch.fs !== null && Math.abs(ch.fs - 1000) < 1e-9);
  assert.equal(parsed.quality.decimatedSampleCount, 1);
});

test('CSV manual sample-rate override creates index-based time only when no Time column is selected', () => {
  const csv = 'Ia,Ib\n1,2\n3,4\n5,6\n';
  const preview = previewCsv(csv);
  const mappings = preview.columnMappings.map((m) => ({ ...m, role: 'channel' as const }));
  const parsed = parseFullCsv(csv, {
    delimiter: ',', hasHeader: true, skipLines: 0, timeColIndex: -1,
    timeUnit: 's', sampleRateOverrideHz: 500,
    columnMappings: mappings, resample: false, colors: ['#fff', '#000'],
  });
  const ch = parsed.channels[parsed.drawOrder[0]];
  assert.deepEqual(Array.from(ch.t), [0, 0.002, 0.004]);
  assert.equal(ch.fs, 500);
});

test('Torque ripple requires a valid one-to-one waveform and verified source before claiming measured shaft torque', () => {
  const t = Float64Array.from({ length: 256 }, (_, i) => i / 20000);
  const values = Float32Array.from(t, (x) => 1 + 0.1 * Math.sin(2 * Math.PI * 100 * x));
  const torqueChannel = makeChannel('tq', 'Torque', 'Nm', t, values);
  const unknownSource = analyzeTorqueAndCurrentRipple(torqueChannel, 100);
  assert.equal(unknownSource.valid, true);
  assert.equal(unknownSource.signalKind, 'torque');
  assert.equal(unknownSource.isTrueMechanicalTorque, false);
  assert.match(unknownSource.warning || '', /来源待核实|来源/);

  torqueChannel.metadata = { ...torqueChannel.metadata!, dataProvenance: 'measured' };
  const measuredSource = analyzeTorqueAndCurrentRipple(torqueChannel, 100);
  assert.equal(measuredSource.isTrueMechanicalTorque, true);

  const badT = t.slice();
  badT[80] = badT[79];
  const invalid = analyzeTorqueAndCurrentRipple(makeChannel('tq-bad', 'Torque', 'Nm', badT, values), 100);
  assert.equal(invalid.valid, false);
  assert.match(invalid.invalidReason || '', /重复或倒退/);
});

test('MOS Thermal MT-03..MT-05: DPT LUT extrapolation/0A-rolloff and FOC 6-MOS LUT switching integration', () => {
  const lut = [
    { id: 'd1', vBusV: 40, iLoadA: 20, tjC: 25, rgOhm: 5, eOnUj: 30, eOffUj: 20, qRrNc: 250, eOnSansQrrUj: 25 },
    { id: 'd2', vBusV: 80, iLoadA: 40, tjC: 25, rgOhm: 5, eOnUj: 90, eOffUj: 60, qRrNc: 500, eOnSansQrrUj: 75 },
  ];

  // Below I_min (10 A < 20 A at 40 V) linearly scales down toward 0 A without negative energy, marked extrapolated
  const lowI = interpolateDptSwitchingLoss(lut, 40, 10);
  assert.ok(lowI !== null);
  assert.equal(lowI!.extrapolated, true);
  assert.ok(Math.abs(lowI!.eOnUj - 15) < 1e-6);
  assert.ok(Math.abs(lowI!.eOffUj - 10) < 1e-6);

  // Zero current yields 0 switching loss
  const zeroI = interpolateDptSwitchingLoss(lut, 40, 0);
  assert.ok(zeroI !== null && Math.abs(zeroI!.eOnUj) < 1e-9 && Math.abs(zeroI!.eOffUj) < 1e-9);

  // Above V_max (100 V > 80 V) flags extrapolated=true and reports LUT coverage bounds
  const highV = interpolateDptSwitchingLoss(lut, 100, 40);
  assert.ok(highV !== null);
  assert.equal(highV!.extrapolated, true);
  assert.deepEqual(highV!.vRange, [40, 80]);
  assert.deepEqual(highV!.iRange, [20, 40]);
  assert.ok(Number.isFinite(highV!.eOnUj) && highV!.eOnUj > 60);

  // Inside V/I convex grid is still only a 2D LUT; collapsed Tj/Rg axes make it insufficient for sign-off.
  const inside = interpolateDptSwitchingLoss(lut, 60, 30);
  assert.ok(inside !== null);
  assert.equal(inside!.extrapolated, false);
  assert.equal(inside!.status, 'INSUFFICIENT_LUT');

  // computePhaseMosLosses & simulateFoc6Mos honor dptLut and eonIncludesQrr flag
  const mosBase = {
    rdsOn25Mohm: 4.5,
    tempCoeffAlphaPerC: 0.0045,
    vsdV: 0.9,
    eonPlusEoffUj: 50,
    vRefV: 48,
    iRefA: 25,
    qrrNc: 60,
    eossUj: 0,
    dptLut: lut,
  };
  assert.throws(
    () => computePhaseMosLosses(30, 0.7, 60, 25, 25, 'SVPWM', 20000, 200, {
      ...mosBase,
      eonIncludesQrr: false,
    }),
    /INSUFFICIENT_LUT|OUT_OF_RANGE/
  );
  assert.throws(
    () => computePhaseMosLosses(30, 0.7, 60, 25, 25, 'SVPWM', 20000, 200, {
      ...mosBase,
      eonIncludesQrr: true,
    }),
    /INSUFFICIENT_LUT|OUT_OF_RANGE/
  );

  const n = 100;
  const t = Float64Array.from({ length: n }, (_, i) => i * 5e-4);
  const ia = Float32Array.from(t, (x) => 30 * Math.sin(2 * Math.PI * 50 * x));
  const ib = Float32Array.from(t, (x) => 30 * Math.sin(2 * Math.PI * 50 * x - (2 * Math.PI) / 3));
  assert.throws(
    () => simulateFoc6Mos(
      makeChannel('lut_ia', 'Ia', 'A', t, ia),
      makeChannel('lut_ib', 'Ib', 'A', t, ib),
      DEFAULT_FOC_MODEL,
      { ...mosBase, eonIncludesQrr: true },
      { modulation: 'SVPWM', fswHz: 20000, tDeadNs: 200, modDepthM: 0.85, pfAngleDeg: 0, tAmbC: 25, vBusConstV: 60 }
    ),
    /INSUFFICIENT_LUT|OUT_OF_RANGE/
  );
});

test('MT-06: DPT analyzer trims bounded deskew without clamping, rejects excessive deskew, and fails closed on edge NaNs/gaps', () => {
  const demo = generateDptDemoChannels();

  // 1. Bounded small deskew (10 ns = 5 pts <= 5% of 2000 pts) trims edges with disclosure rather than clamping endpoints
  const smallDeskew = analyzeDoublePulseTest(demo.vgsCh, demo.vdsCh, demo.idsCh, { idsDeskewNs: 10 });
  assert.equal(smallDeskew.valid, true);
  assert.ok(smallDeskew.warnings.some((w) => w.includes('拒绝首尾端点重复钳位')));
  assert.ok(Number.isFinite(smallDeskew.eOffUj) && Number.isFinite(smallDeskew.eOnUj));

  // 2. Excessive deskew (500 ns = 250/2000 pts > 5%) rejects endpoint extrapolation
  assert.throws(
    () => analyzeDoublePulseTest(demo.vgsCh, demo.vdsCh, demo.idsCh, { idsDeskewNs: 500 }),
    /拒绝首尾钳位或伪外推/
  );

  // 3. NaN inside Turn-Off window must fail closed even with non-zero deskew (no fallback to undeskewed samples)
  const baseRes = analyzeDoublePulseTest(demo.vgsCh, demo.vdsCh, demo.idsCh);
  assert.ok(baseRes.offWindow !== null);
  const midOffIdx = Math.floor(0.5 * (baseRes.offWindow!.tStartIdx + baseRes.offWindow!.tEndIdx));
  const idsNanArr = Float32Array.from(demo.idsCh.v);
  idsNanArr[midOffIdx] = Number.NaN;
  const idsNanCh = { ...demo.idsCh, v: idsNanArr };
  assert.throws(
    () => analyzeDoublePulseTest(demo.vgsCh, demo.vdsCh, idsNanCh, { idsDeskewNs: 2 }),
    /NaN\/Inf|缺失值/
  );

  // 4. Sampling gap inside Turn-Off switching window must fail closed instead of integrating across gap
  const nGap = demo.vgsCh.t.length;
  const gappedT = Float64Array.from(demo.vgsCh.t, (tv, idx) => (idx >= midOffIdx ? tv + 2e-6 : tv));
  assert.throws(
    () =>
      analyzeDoublePulseTest(
        { ...demo.vgsCh, t: gappedT },
        { ...demo.vdsCh, t: gappedT },
        { ...demo.idsCh, t: gappedT }
      ),
    /采样缺口/
  );
  assert.equal(nGap, 2000);
});

test('MT-01: True 4D DPT LUT interpolation across (Vbus, Iload, Tj, Rg_on/off) with explicit diagnostics', () => {
  // Exact 2^4 = 16-point multilinear grid:
  // Eon(V,I,T,Rg) = 0.4*V + 0.8*I + 0.1*(T-25) + 3.0*Rg
  // Eoff(V,I,T,Rg) = 0.25*V + 0.5*I + 0.08*(T-25) + 2.0*Rg
  // Qrr(V,I,T,Rg) = 20 + 2*I + 0.5*(T-25) + 1.5*Rg
  const vLvls = [40, 80];
  const iLvls = [0, 30];
  const tLvls = [25, 125];
  const rLvls = [2, 10];
  const lut4d: Parameters<typeof interpolateDptSwitchingLoss>[0] = [];
  for (const v of vLvls) {
    for (const i of iLvls) {
      for (const tj of tLvls) {
        for (const rg of rLvls) {
          lut4d.push({
            id: `p_${v}_${i}_${tj}_${rg}`,
            vBusV: v,
            iLoadA: i,
            tjC: tj,
            rgOhm: rg,
            eOnUj: 0.4 * v + 0.8 * i + 0.1 * (tj - 25) + 3.0 * rg,
            eOffUj: 0.25 * v + 0.5 * i + 0.08 * (tj - 25) + 2.0 * rg,
            qRrNc: 20 + 2 * i + 0.5 * (tj - 25) + 1.5 * rg,
          });
        }
      }
    }
  }

  // Interior query with asymmetric Rg_on=4 Ohm and Rg_off=8 Ohm at (60V, 20A, Tj=75°C)
  const res = interpolateDptSwitchingLoss(lut4d, {
    vBusV: 60,
    iLoadA: 20,
    tjC: 75,
    rgOnOhm: 4,
    rgOffOhm: 8,
    tjProvenance: 'measured',
    rgProvenance: 'measured',
  });
  assert.ok(res !== null);
  assert.equal(res!.status, 'VALID');
  assert.equal(res!.method, '4d_multilinear_grid');
  assert.equal(res!.extrapolated, false);
  assert.deepEqual(res!.activeDimensions, ['Vbus', 'Iload', 'Tj', 'Rg']);
  assert.deepEqual(res!.collapsedDimensions, []);

  const expectedEon = 0.4 * 60 + 0.8 * 20 + 0.1 * (75 - 25) + 3.0 * 4; // 57
  const expectedEoff = 0.25 * 60 + 0.5 * 20 + 0.08 * (75 - 25) + 2.0 * 8; // 45
  const expectedQrr = 20 + 2 * 20 + 0.5 * (75 - 25) + 1.5 * 4; // 91
  assert.ok(Math.abs(res!.eOnUj - expectedEon) < 1e-6);
  assert.ok(Math.abs(res!.eOffUj - expectedEoff) < 1e-6);
  assert.ok(Math.abs(res!.qRrNc - expectedQrr) < 1e-6);

  // A numeric Rg is not automatically a measurement; provenance must be explicit.
  const rgUnproven = interpolateDptSwitchingLoss(lut4d, {
    vBusV: 60, iLoadA: 20, tjC: 75, rgOnOhm: 4, rgOffOhm: 8,
  });
  assert.equal(rgUnproven!.rgProvenance, 'assumed');
  const rgPartialWithForgedMeasuredLabel = interpolateDptSwitchingLoss(lut4d, {
    vBusV: 60, iLoadA: 20, tjC: 75, rgOnOhm: 4, rgProvenance: 'measured',
  });
  assert.equal(rgPartialWithForgedMeasuredLabel!.rgProvenance, 'assumed');

  // Out-of-range query (Tj=150 > 125) must surface OUT_OF_RANGE explicitly
  const oor = interpolateDptSwitchingLoss(lut4d, {
    vBusV: 60,
    iLoadA: 20,
    tjC: 150,
    rgOnOhm: 4,
    rgOffOhm: 4,
  });
  assert.equal(oor!.status, 'OUT_OF_RANGE');
  assert.equal(oor!.extrapolated, true);
  assert.ok(oor!.outOfRangeAxes.includes('Tj'));

  // Single-point LUT returns INSUFFICIENT_LUT
  const single = interpolateDptSwitchingLoss([lut4d[0]], { vBusV: 50, iLoadA: 15 });
  assert.equal(single!.status, 'INSUFFICIENT_LUT');

  assert.throws(
    () => computePhaseMosLosses(15, 0.5, 50, 25, 25, 'SVPWM', 20000, 100, {
      rdsOn25Mohm: 4.5, tempCoeffAlphaPerC: 0.0045, vsdV: 0.9,
      eonPlusEoffUj: 50, vRefV: 48, iRefA: 25, qrrNc: 40, eossUj: 0,
      rgOnOhm: 2, rgOffOhm: 2, dptLut: [lut4d[0]],
    }),
    /INSUFFICIENT_LUT/
  );
  assert.throws(
    () => computePhaseMosLosses(15, 0.5, 200, 25, 25, 'SVPWM', 20000, 100, {
      rdsOn25Mohm: 4.5, tempCoeffAlphaPerC: 0.0045, vsdV: 0.9,
      eonPlusEoffUj: 50, vRefV: 48, iRefA: 25, qrrNc: 40, eossUj: 0,
      rgOnOhm: 2, rgOffOhm: 2, dptLut: lut4d,
    }),
    /OUT_OF_RANGE/
  );

  // Invalid negative Vbus / NaN data returns INVALID_DATA
  const bad = interpolateDptSwitchingLoss([{ ...lut4d[0], eOnUj: -5 }], { vBusV: 40, iLoadA: 10 });
  assert.equal(bad!.status, 'INVALID_DATA');

  // FOC 6-MOS closed-loop thermal coupling with 4D LUT reports diagnostics & Rg sensitivity
  const n = 80;
  const t = Float64Array.from({ length: n }, (_, k) => k * 5e-4);
  const ia = Float32Array.from(t, (x) => 24 * Math.sin(2 * Math.PI * 50 * x));
  const ib = Float32Array.from(t, (x) => 24 * Math.sin(2 * Math.PI * 50 * x - (2 * Math.PI) / 3));
  const mosLoRg = {
    rdsOn25Mohm: 4.5,
    tempCoeffAlphaPerC: 0.0045,
    vsdV: 0.9,
    eonPlusEoffUj: 50,
    vRefV: 48,
    iRefA: 25,
    qrrNc: 60,
    eossUj: 0,
    rgOnOhm: 2,
    rgOffOhm: 2,
    rgProvenance: 'measured' as const,
    dptLut: lut4d,
  };
  const simLoRg = simulateFoc6Mos(
    makeChannel('f4d_ia', 'Ia', 'A', t, ia),
    makeChannel('f4d_ib', 'Ib', 'A', t, ib),
    DEFAULT_FOC_MODEL,
    mosLoRg,
    { modulation: 'SVPWM', fswHz: 20000, tDeadNs: 200, modDepthM: 0.85, pfAngleDeg: 0, tAmbC: 75, vBusConstV: 60 }
  );
  const simHiRg = simulateFoc6Mos(
    makeChannel('f4d_ia', 'Ia', 'A', t, ia),
    makeChannel('f4d_ib', 'Ib', 'A', t, ib),
    DEFAULT_FOC_MODEL,
    { ...mosLoRg, rgOnOhm: 10, rgOffOhm: 10 },
    { modulation: 'SVPWM', fswHz: 20000, tDeadNs: 200, modDepthM: 0.85, pfAngleDeg: 0, tAmbC: 75, vBusConstV: 60 }
  );
  assert.ok(simLoRg.dptLutDiagnostics?.activeDimensions.includes('Rg'));
  assert.ok(simHiRg.pInvMeanW > simLoRg.pInvMeanW + 0.5, 'Higher Rg_on/Rg_off must raise switching loss via 4D LUT');

  // Caller-supplied provenance cannot make missing Rg inputs look measured.
  assert.throws(
    () => simulateFoc6Mos(
      makeChannel('f4d_ia_missing_rg', 'Ia', 'A', t, ia),
      makeChannel('f4d_ib_missing_rg', 'Ib', 'A', t, ib),
      DEFAULT_FOC_MODEL,
      { ...mosLoRg, rgOnOhm: undefined, rgOffOhm: undefined, rgProvenance: 'measured' },
      { modulation: 'SVPWM', fswHz: 20000, tDeadNs: 200, modDepthM: 0.85, pfAngleDeg: 0, tAmbC: 75, vBusConstV: 60 }
    ),
    /Rg_on\/Rg_off 实际输入/
  );
});

test('MT-01b: DPT LUT treats Rg_on and Rg_off as independent axes', () => {
  const lut = [];
  for (const v of [40, 80]) {
    for (const i of [0, 30]) {
      for (const tj of [25, 125]) {
        for (const rgOn of [2, 10]) {
          const rgOff = 6; // Deliberately constant while Rg_on changes.
          const eOn = 0.4 * v + 0.8 * i + 0.1 * (tj - 25) + 3 * rgOn;
          const eOff = 0.25 * v + 0.5 * i + 0.08 * (tj - 25) + 2 * rgOff;
          lut.push({
            id: `asym_${v}_${i}_${tj}_${rgOn}`,
            vBusV: v,
            iLoadA: i,
            tjC: tj,
            rgOhm: 0.5 * (rgOn + rgOff),
            rgOnOhm: rgOn,
            rgOffOhm: rgOff,
            eOnUj: eOn,
            eOffUj: eOff,
            eOnSansQrrUj: eOn - 2,
            qRrNc: 20 + 2 * i + 0.5 * (tj - 25) + 1.5 * rgOn,
          });
        }
      }
    }
  }

  const res = interpolateDptSwitchingLoss(lut, {
    vBusV: 60,
    iLoadA: 20,
    tjC: 75,
    rgOnOhm: 6,
    rgOffOhm: 6,
    tjProvenance: 'measured',
    rgProvenance: 'design_specified',
  });
  assert.ok(res);
  assert.equal(res!.status, 'VALID');
  assert.deepEqual(res!.activeDimensions, ['Vbus', 'Iload', 'Tj', 'Rg']);
  assert.deepEqual(res!.rgOnRange, [2, 10]);
  assert.deepEqual(res!.rgOffRange, [6, 6]);
  assert.ok(res!.warnings.some((warning) => warning.includes('变化维度不对称')));
  assert.ok(Math.abs(res!.eOnUj - (0.4 * 60 + 0.8 * 20 + 0.1 * 50 + 3 * 6)) < 1e-6);
  assert.ok(Math.abs(res!.eOffUj - (0.25 * 60 + 0.5 * 20 + 0.08 * 50 + 2 * 6)) < 1e-6);

  const offOutside = interpolateDptSwitchingLoss(lut, {
    vBusV: 60,
    iLoadA: 20,
    tjC: 75,
    rgOnOhm: 6,
    rgOffOhm: 8,
    tjProvenance: 'measured',
    rgProvenance: 'design_specified',
  });
  assert.equal(offOutside!.status, 'OUT_OF_RANGE');
  assert.ok(offOutside!.outOfRangeAxes.includes('Rg'));

  // Different fixed Rg_on/Rg_off values must not manufacture a varying Rg axis.
  const fixedRg = lut.map((pt) => ({
    ...pt,
    rgOhm: 4,
    rgOnOhm: 2,
    rgOffOhm: 6,
  }));
  const fixedRes = interpolateDptSwitchingLoss(fixedRg, {
    vBusV: 60,
    iLoadA: 20,
    tjC: 75,
    rgOnOhm: 2,
    rgOffOhm: 6,
    tjProvenance: 'measured',
    rgProvenance: 'design_specified',
  });
  assert.equal(fixedRes!.status, 'INSUFFICIENT_LUT');
  assert.ok(fixedRes!.collapsedDimensions.includes('Rg'));
});

test('MT-02: Adaptive step-doubling Cauer solver removes 32/64 cap and converges on stiff dt >> tau_min', () => {
  // Fast stage tau_min = 0.05 * 0.002 = 1e-4 s (100 us), coarse step dt = 50 ms = 500 * tau_min!
  // Old Math.min(64, ...) would use h = 50ms / 64 = 781 us >> tau_min = 100 us.
  const stages = [
    { r: 0.25, c: 0.0004, tauEst: 1e-4, layerLabel: 'Die' },
    { r: 0.45, c: 0.02, tauEst: 0.009, layerLabel: 'Pkg' },
    { r: 0.8, c: 0.5, tauEst: 0.4, layerLabel: 'PCB' },
  ];
  const coarseDt = 0.05;
  const coarseT = Float64Array.from({ length: 11 }, (_, i) => i * coarseDt);
  const coarseP = Float32Array.from({ length: 11 }, () => 40);

  const coarseDiag = simulateCauerZohWithDiagnostics(coarseT, coarseP, stages, 25);
  assert.equal(coarseDiag.solverStatus, 'CONVERGED');
  assert.ok(coarseDiag.maxSubsteps > 64, `Expected >64 substeps on stiff dt=${coarseDt}s, got ${coarseDiag.maxSubsteps}`);
  assert.ok(coarseDiag.minActualStepSec <= 1e-4 * 0.05 + 1e-12);

  // Malformed thermal series must fail closed; never truncate, skip duplicate time, or turn NaN power into zero.
  assert.throws(() => simulateCauerZohWithDiagnostics(new Float64Array([0, 1]), new Float32Array([10]), stages, 25), /长度不一致/);
  assert.throws(() => simulateCauerZohWithDiagnostics(new Float64Array([0, 0]), new Float32Array([10, 10]), stages, 25), /重复或倒退/);
  assert.throws(() => simulateCauerZohWithDiagnostics(new Float64Array([0, 1]), new Float32Array([10, Number.NaN]), stages, 25), /有限非负值/);

  // A pathological fast thermal pole must not leak a partial Tj curve through the convenience API.
  const cappedStages = [{ r: 0.2, c: 5e-11, tauEst: 1e-11, layerLabel: 'Fast die' }];
  const cappedTime = new Float64Array([0, 1]);
  const cappedPower = new Float32Array([10, 10]);
  const cappedDiag = simulateCauerZohWithDiagnostics(cappedTime, cappedPower, cappedStages, 25);
  assert.equal(cappedDiag.solverStatus, 'STEP_CAP_REACHED');
  assert.throws(() => simulateCauerZoh(cappedTime, cappedPower, cappedStages, 25), /未收敛/);

  // Compare at shared timestamps against ultra-dense analytical/fine step simulation (dt_ref = 5 us)
  const fineDt = 5e-6;
  const nFine = Math.round(0.5 / fineDt) + 1;
  const fineT = Float64Array.from({ length: nFine }, (_, i) => i * fineDt);
  const fineP = Float32Array.from({ length: nFine }, () => 40);
  const fineTj = simulateCauerZoh(fineT, fineP, stages, 25);

  let maxDiffC = 0;
  for (let k = 0; k < coarseT.length; k++) {
    const fineIdx = Math.round(coarseT[k] / fineDt);
    const diff = Math.abs(coarseDiag.tj[k] - fineTj[fineIdx]);
    if (diff > maxDiffC) maxDiffC = diff;
  }
  assert.ok(maxDiffC < 0.05, `Adaptive solver vs dense reference max error ${maxDiffC.toFixed(4)}°C >= 0.05°C`);
});

test('MT-03: 6-MOS PCB spatial coupled thermal matrix models lateral heating, validates passivity/symmetry, and passes SPICE nodal check', () => {
  const n = 200;
  const t = Float64Array.from({ length: n }, (_, i) => i * 5e-3); // 1.0 s total
  // Excite ONLY Phase A (Ia != 0, Ib = 0, Ic = -Ia? Wait: to heat only leg A without leg B/C, use Ia=20A, Ib=0, Ic=0 explicit)
  // Actually let's test Ic=0 explicit via a short symmetric test or unbalanced single-phase current Ia=28A, Ib=0, Ic=0!
  const ia = Float32Array.from(t, () => 28);
  const ib = Float32Array.from(t, () => 0);
  const ic = Float32Array.from(t, () => 0);
  const mos = {
    rdsOn25Mohm: 6,
    tempCoeffAlphaPerC: 0.0045,
    vsdV: 0.9,
    eonPlusEoffUj: 40,
    vRefV: 48,
    iRefA: 25,
    qrrNc: 50,
    eossUj: 0,
  };
  const ctrl = {
    modulation: 'SVPWM' as const,
    fswHz: 20000,
    tDeadNs: 200,
    modDepthM: 0.8,
    pfAngleDeg: 0,
    tAmbC: 25,
    vBusConstV: 48,
  };

  // High lateral copper coupling (4 oz, 8 mm pitch) with vertical R_vert > 0
  const spatialModel = {
    zthJC: DEFAULT_FOC_MODEL.zthJC,
    zthBoard: DEFAULT_FOC_MODEL.zthBoard,
    thermalTopologyMode: 'pcb_spatial_coupled' as const,
    spatialMatrix: {
      copperOz: 4.0,
      layoutPitchMm: 10,
      zoneVerticalRthCPerW: [1.8, 1.8, 1.8, 1.8, 1.8, 1.8],
      zoneThermalCapJPerC: [0.08, 0.08, 0.08, 0.08, 0.08, 0.08],
    },
  };
  const indepModel = {
    ...spatialModel,
    thermalTopologyMode: 'independent' as const,
  };

  const simSpatial = simulateFoc6Mos(
    makeChannel('sp_ia', 'Ia', 'A', t, ia),
    makeChannel('sp_ib', 'Ib', 'A', t, ib),
    spatialModel,
    mos,
    ctrl,
    { icCh: makeChannel('sp_ic', 'Ic', 'A', t, ic) }
  );
  const simIndep = simulateFoc6Mos(
    makeChannel('in_ia', 'Ia', 'A', t, ia),
    makeChannel('in_ib', 'Ib', 'A', t, ib),
    indepModel,
    mos,
    ctrl,
    { icCh: makeChannel('in_ic', 'Ic', 'A', t, ic) }
  );

  // Leg B & C have zero current loss; under spatial PCB coupling, B/C zones warm above T_amb and closer B is warmer than distant C
  const pcbB_spatial = simSpatial.tBoardByKey!.BH;
  const pcbC_spatial = simSpatial.tBoardByKey!.CH;
  const pcbB_indep = simIndep.tBoardByKey!.BH;
  assert.ok(pcbB_spatial > 26.0, `Expected spatial lateral heating on unpowered leg B (>26°C), got ${pcbB_spatial.toFixed(2)}°C`);
  assert.ok(pcbB_spatial > pcbC_spatial, `Adjacent leg B (${pcbB_spatial.toFixed(2)}°C) must be warmer than distant leg C (${pcbC_spatial.toFixed(2)}°C)`);
  assert.ok(Math.abs(pcbB_indep - 25) < 1e-6, `Independent mode must have zero cross-heating on unpowered leg B, got ${pcbB_indep}`);

  // Passivity & reciprocity validation rejects negative or asymmetric mutual conductance
  const badAsym = Array.from({ length: 6 }, () => Array(6).fill(0));
  badAsym[0][2] = 0.4;
  badAsym[2][0] = 0.1;
  assert.throws(
    () => resolveSpatialThermalNetwork({ ...spatialModel, spatialMatrix: { mutualConductanceMatrixWPerC: badAsym } }),
    /互易|非对称/
  );
  const badNeg = Array.from({ length: 6 }, () => Array(6).fill(0));
  badNeg[0][2] = -0.2;
  badNeg[2][0] = -0.2;
  assert.throws(
    () => resolveSpatialThermalNetwork({ ...spatialModel, spatialMatrix: { mutualConductanceMatrixWPerC: badNeg } }),
    /非负|无源性/
  );

  // SPICE export & exact DC nodal verification across all 3 topologies
  for (const mode of ['shared_board', 'pcb_spatial_coupled', 'independent'] as const) {
    const m = { ...spatialModel, thermalTopologyMode: mode };
    const netlist = focModelToSpice(m, 25, 'INV_6MOS_THERM');
    const val = validateFocSpiceNetlist(netlist, m);
    assert.equal(val.valid, true, `SPICE validation failed for ${mode}: ${val.errors.join('; ')}`);
    assert.equal(val.nodalMathVerified, true, `DC nodal matrix verification failed for ${mode}`);
  }
});

test('MT-04: Nonlinear Eoss(V)/Qoss(V)/Coss(V) integration, monotone PCHIP accuracy, domain gating & anti-double-count', () => {
  // Known power-law Coss(V) = C0 / sqrt(1 + V/V0): Q(V) = 2*C0*V0*(sqrt(1+V/V0)-1),
  // exact Eoss(V) = integral_0^V v * Coss(v) dv = 2*C0*V0^2 * ((1+V/V0)^(3/2)/3 - sqrt(1+V/V0) + 2/3)
  const c0Pf = 2000;
  const v0 = 10;
  const qossExactNc = (v: number) => 2 * (c0Pf * 1e-3) * v0 * (Math.sqrt(1 + v / v0) - 1);
  const eossExactUj = (v: number) => {
    const u = 1 + v / v0;
    return 2 * (c0Pf * 1e-6) * v0 * v0 * (Math.pow(u, 1.5) / 3 - Math.sqrt(u) + 2 / 3);
  };

  const vSamples = [0, 5, 10, 20, 35, 50, 75, 100];
  const qCurve = integrateQossToEossCurve(
    vSamples.map((v) => ({ vdsV: v, val: qossExactNc(v) })),
    'Analytical Qoss'
  );
  const cCurve = integrateCossToEossCurve(
    vSamples.map((v) => ({ vdsV: v, val: c0Pf / Math.sqrt(1 + v / v0) })),
    'Analytical Coss'
  );

  // Check PCHIP accuracy at non-knot interior voltage V=62V and strict monotonicity
  const evalQ = evaluateNonlinearEossUj(qCurve, 62);
  const evalC = evaluateNonlinearEossUj(cCurve, 62);
  const exact62 = eossExactUj(62);
  assert.equal(evalQ.outOfRange, false);
  assert.ok(Math.abs(evalQ.eossUj - exact62) / exact62 < 0.03, `Qoss curve error too large: ${evalQ.eossUj} vs ${exact62}`);
  assert.ok(Math.abs(evalC.eossUj - exact62) / exact62 < 0.04, `Coss curve error too large: ${evalC.eossUj} vs ${exact62}`);

  // Monotonicity check across dense sweep
  let prevE = -1;
  for (let v = 0; v <= 100; v += 2) {
    const curE = evaluatePchipMonotone(qCurve.points, v).value;
    assert.ok(curE >= prevE - 1e-12, `PCHIP non-monotone at V=${v}`);
    prevE = curE;
  }

  // Constant-C approximation error vs nonlinear Eoss: 0.5 * C(0) * V^2 overestimates > 2x (actual 2.17x for C0/sqrt(1+V/10) at 62V)
  const constC0ApproxUj = 0.5 * (c0Pf * 1e-6) * 62 * 62;
  assert.ok(constC0ApproxUj > 2.0 * exact62);

  // Out-of-range domain gating (150V > 100V max) clamps cleanly and flags outOfRange=true
  const oorEval = evaluateNonlinearEossUj(qCurve, 150);
  assert.equal(oorEval.outOfRange, true);
  assert.ok(Math.abs(oorEval.eossUj - qCurve.points[qCurve.points.length - 1].val) < 1e-6);

  assert.throws(
    () => evaluateNonlinearEossUj(qCurve, 150, { allowOutOfDomainClamp: false }),
    /超出 Eoss\(V\)\/Qoss\(V\) 曲线定义域/
  );
  assert.throws(
    () => computePhaseMosLosses(10, 0.5, 150, 25, 25, 'SVPWM', 20000, 100, {
      rdsOn25Mohm: 4.5, tempCoeffAlphaPerC: 0.0045, vsdV: 0.9,
      eonPlusEoffUj: 0, vRefV: 48, iRefA: 25, qrrNc: 0, eossUj: 0,
      eossCurve: qCurve,
    }),
    /超出 Eoss\(V\)\/Qoss\(V\) 曲线定义域/
  );

  // eossAlreadyIncludedInEsw=true prevents double counting Eoss in computePhaseMosLosses
  const mosWithCurve = {
    rdsOn25Mohm: 4.5,
    tempCoeffAlphaPerC: 0.0045,
    vsdV: 0.9,
    eonPlusEoffUj: 50,
    vRefV: 48,
    iRefA: 25,
    qrrNc: 0,
    eossUj: 0,
    eossCurve: qCurve,
  };
  const lossWithEoss = computePhaseMosLosses(20, 0.7, 62, 25, 25, 'SVPWM', 20000, 200, {
    ...mosWithCurve,
    eossAlreadyIncludedInEsw: false,
  });
  const lossNoDoubleCount = computePhaseMosLosses(20, 0.7, 62, 25, 25, 'SVPWM', 20000, 200, {
    ...mosWithCurve,
    eossAlreadyIncludedInEsw: true,
  });
  const expectedAddedW = 20000 * evalQ.eossUj * 1e-6;
  const actualDiffW = (lossWithEoss.pHighSw + lossWithEoss.pLowSw) - (lossNoDoubleCount.pHighSw + lossNoDoubleCount.pLowSw);
  assert.ok(
    Math.abs(actualDiffW - expectedAddedW) < 1e-5,
    `Expected Eoss delta ${expectedAddedW.toFixed(4)}W, got ${actualDiffW.toFixed(4)}W`
  );
});



test('PCB spatial thermal import template and versioned JSON validation', () => {
  const template = createPcbSpatialImportTemplate();
  const imported = parsePcbSpatialImportJson(JSON.stringify(template));
  assert.equal(imported.schema, 'wave-test-pcb-thermal');
  assert.equal(imported.config?.provenance, 'geometry_estimated');
  const resolved = resolveSpatialThermalNetwork({
    ...DEFAULT_FOC_MODEL,
    thermalTopologyMode: 'pcb_spatial_coupled',
    spatialMatrix: imported.config,
  });
  assert.equal(resolved.cPcb.length, 6);
  assert.equal(resolved.gLat.length, 6);
  assert.ok(resolved.gLat[0][2] > 0, 'Template should include the AH-BH adjacent horizontal copper path');
  assert.ok(resolved.gLat[0][1] > 0, 'Template should include the AH-AL local vertical copper path');
  assert.throws(() => parsePcbSpatialImportJson(JSON.stringify({ ...template, units: 'SI' })), /units=mm/);
  assert.throws(() => parsePcbSpatialImportJson(JSON.stringify({ ...template, config: { ...template.config, provenance: 'guessed_measured' } })), /provenance 非法/);
  assert.throws(() => parsePcbSpatialImportJson('{bad json'), /JSON 解析失败/);
});

test('Eoss CSV/JSON import normalizes units and preserves strict query-domain behavior', () => {
  const qossCurve = parseEossCurveCsv(
    `# device test curve
Vds,Qoss
0,0
20,10
40,18`,
    'qoss_nc', 'V', 'nC', { label: 'CSV test Qoss', partNumber: 'TEST-MOS', provenance: 'user_import' }
  );
  assert.equal(qossCurve.kind, 'eoss_uj');
  assert.equal(qossCurve.partNumber, 'TEST-MOS');
  assert.equal(evaluateNonlinearEossUj(qossCurve, 30).outOfRange, false);
  assert.throws(() => evaluateNonlinearEossUj(qossCurve, 50, { allowOutOfDomainClamp: false }), /超出 Eoss/);

  const jsonTemplate = createEossCurveImportTemplate('eoss_uj');
  const parsedJson = parseEossCurveImportJson(JSON.stringify(jsonTemplate));
  assert.equal(parsedJson.kind, 'eoss_uj');
  assert.throws(() => parseEossCurveImportJson(JSON.stringify({ ...jsonTemplate, provenance: 'guessed_measured' })), /provenance 非法/);
  assert.throws(() => parseEossCurveImportJson(JSON.stringify({ ...jsonTemplate, rgOnOhm: 0 })), /rgOnOhm 必须为正数/);
  assert.throws(() => parseEossCurveCsv(`Vds,Eoss\n0,1\n10,2`, 'eoss_uj', 'V', 'uJ'), /0V, 0uJ/);
  assert.throws(() => parseEossCurveCsv(`Vds,Qoss\n0,0\n10,2`, 'qoss_nc', 'V', 'uJ'), /单位不匹配/);
});
