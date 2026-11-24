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
} from './thermalEngine';
import { evaluateDynamicSoa, SOA_PRESETS } from './dynamicSoa';
import {
  DEFAULT_FOC_MODEL,
  computePhaseMosLosses,
  focModelToSpice,
  getModulationLinearCeiling,
  reconstructSensorlessDutySample,
  runFocStallSweep,
  simulateFoc6Mos,
  splitCauerToFocModel,
  validateFocSpiceNetlist,
} from './focThermal';

import { analyzeSamplingQuality } from './qualityCheck';
import { inferCsvChannelUnit, previewCsv } from '../parsers/csvParser';
import { inferUnitFromHeader } from '../parsers/excelParser';

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
  const rResamp = simulateFoc6Mos(makeChannel('ia1', 'Ia', 'A', tA, iaShift), makeChannel('ib1', 'Ib', 'A', tBShift, ibAtTbShift), DEFAULT_FOC_MODEL, mos, ctrl);
  // Strict time-interpolation keeps power error tiny despite interior shift
  assert.ok(Math.abs(rResamp.pInvMeanW - rExact.pInvMeanW) < 0.08);
  // Coverage gap warning emitted when auxiliary channel spans smaller interval
  const tShort = Float64Array.from({ length: 11 }, (_, i) => 0.05 + i * 0.01);
  const ibShort = Float32Array.from({ length: 11 }, () => -10);
  const rCov = simulateFoc6Mos(makeChannel('ia2', 'Ia', 'A', tA, iaShift), makeChannel('ib2', 'Ib', 'A', tShort, ibShort), DEFAULT_FOC_MODEL, mos, ctrl);
  assert.ok(rCov.alignmentWarnings.some((w) => w.includes('未完整覆盖仿真区间')));

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
  tNu[100] = 1.0;
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
  assert.deepEqual(sp.zthJC.map((s) => s.layerLabel), ['L1']);
  assert.deepEqual(sp.zthBoard.map((s) => s.layerLabel), ['L2', 'L3']);
  assert.equal(sp.splitMeta?.nonMonotonicTau, true);

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
  assert.ok(Math.abs(stall.i2tWorstLegA2s! - stall.phaseSquaredRatioAtWorst * stall.i2tRmsA2s!) < 1e-6);

  // High Rs stall hits SVPWM ceiling and raises stallVoltageLimited without falling back to 2*Rds(on)
  const stallDefaultRs = runFocStallSweep({
    iPeakA: 135,
    tjLimitC: 120,
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
  assert.ok(Math.abs(stallDefaultRs.effectiveStallModDepthM - getModulationLinearCeiling('SVPWM')) < 1e-6);
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

  // 3. Partial Duty selection triggers explicit fallback warning
  const rPartial = simulateFoc6Mos(makeChannel('iaP', 'Ia', 'A', t, ia), makeChannel('ibP', 'Ib', 'A', t, ib), DEFAULT_FOC_MODEL, mos, ctrl, {
    dutyChs: { da: makeChannel('daP', 'Duty_A', '', t, daFracArr), db: null, dc: null },
  });
  assert.equal(rPartial.dutySource, 'reconstructed');
  assert.ok(rPartial.warnings.some((w) => w.includes('部分外部 Duty')));

  // 4. Consecutive NaNs in aux channel interpolate safely instead of zeroing; backward/NaN Ia timestamps throw
  const vbusGap = Float32Array.from({ length: n }, (_, i) => (i >= 40 && i <= 80 ? Number.NaN : 48.0));
  const rGap = simulateFoc6Mos(makeChannel('iaG', 'Ia', 'A', t, ia), makeChannel('ibG', 'Ib', 'A', t, ib), DEFAULT_FOC_MODEL, mos, ctrl, {
    vbusCh: makeChannel('vbG', 'Vbus', 'V', t, vbusGap),
  });
  assert.ok(Number.isFinite(rGap.pInvMeanW) && rGap.pInvMeanW > 0);
  assert.ok(rGap.warnings.some((w) => w.includes('NaN/Inf 异常值')));

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
  assert.ok(hotStall.inheritedMaxTjC > hotStall.inheritedBoardTempC + 2.0);
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




