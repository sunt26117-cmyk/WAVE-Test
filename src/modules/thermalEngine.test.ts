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
import { DEFAULT_FOC_MODEL, runFocStallSweep, simulateFoc6Mos } from './focThermal';

import { analyzeSamplingQuality } from './qualityCheck';

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

