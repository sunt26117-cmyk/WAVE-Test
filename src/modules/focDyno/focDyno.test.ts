import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SVPWM_LINEAR_LIMIT,
  calcKeFromKv,
  calcKeFromNoLoad,
  calcKvFromKe,
  calcLqH,
  calcRsAnchorOhm,
  forwardVerifyPoint,
  solveSinglePoint,
} from './motorPhysics';
import {
  detectHeaderEtaFormat,
  detectHeaderTorqueUnit,
  normalizeDynoDataset,
  parseCsvText,
  runStepwiseCalibration,
  torqueToNm,
} from './dynoCalibrator';
import {
  DEMO_MOTOR_PARAMS,
  buildDemoClosedLoopDataset,
  buildDemoOpenLoopDataset,
  buildDemoRuntimeLog,
} from './demoData';
import { synthesizeSixMosWaveform } from './thermalExporter';
import {
  buildOscilloscopeTabFromSixMos,
  buildThermalHandoffFromSixMos,
  extractRuntimeLogFromScopeChannels,
} from './scopeBridge';

test('SI unit conversions: torque, R_s(T_coil), L_q, and Ke <-> KV roundtrip', () => {
  assert.ok(Math.abs(torqueToNm(250, 'mNm') - 0.25) < 1e-12);
  assert.ok(Math.abs(torqueToNm(1.0, 'kgf_cm') - 0.0980665) < 1e-12);

  // Rs(25C) = R_LL_25 / 2; Rs(45C) = 0.36 * (1 + 0.00393 * 20)
  const rs25 = calcRsAnchorOhm(0.72, 25);
  assert.ok(Math.abs(rs25 - 0.36) < 1e-12);
  const rs45 = calcRsAnchorOhm(0.72, 45);
  assert.ok(Math.abs(rs45 - 0.36 * (1 + 0.00393 * 20)) < 1e-12);

  assert.ok(Math.abs(calcLqH(0.44) - 0.00022) < 1e-12);

  const keFromNL = calcKeFromNoLoad(13.5, 1450);
  const kv = calcKvFromKe(keFromNL);
  assert.ok(Math.abs(kv - 1450 / 13.5) < 1e-6);
  assert.ok(Math.abs(calcKeFromKv(kv) - keFromNL) < 1e-9);
});

test('Header unit auto-detection & cross-check warnings catch mNm / percent formats', () => {
  assert.equal(detectHeaderTorqueUnit('T_mNm (mN·m)'), 'mNm');
  assert.equal(detectHeaderTorqueUnit('Torque [kgf·cm]'), 'kgf_cm');
  assert.equal(detectHeaderTorqueUnit('T_Nm'), 'Nm');

  const ds = parseCsvText('n_rpm,T_mNm,V_bus,I_bus,eta\n1000,100,13.5,1.06,73.2\n');
  assert.equal(detectHeaderEtaFormat('eta', ds.rows), 'percent');

  const resWrongEta = normalizeDynoDataset(
    ds,
    { n_rpm: 'n_rpm', T_Nm: 'T_mNm', V_bus: 'V_bus', I_bus: 'I_bus', P_in: '', P_out: '', eta: 'eta' },
    'mNm',
    '0-1',
    { requireTorque: true }
  );
  assert.ok(resWrongEta.warnings.some((w) => w.includes('百分比')));
  assert.ok(Math.abs(resWrongEta.points[0].tNm - 0.1) < 1e-9);
});

test('4-Quadrant solveSinglePoint <-> forwardVerifyPoint exact consistency & safety boundaries', () => {
  // Motoring point
  const mot = solveSinglePoint(13.5, 1.06, 1000, DEMO_MOTOR_PARAMS);
  assert.equal(mot.mode, 'motoring');
  assert.ok(Number.isFinite(mot.iqA) && mot.iqA > 1.0);
  const fwdMot = forwardVerifyPoint(mot.iqA, 1000, 13.5, DEMO_MOTOR_PARAMS);
  assert.ok(Math.abs(fwdMot.iBusEstA - 1.06) < 1e-5);
  assert.ok(Math.abs(fwdMot.vqCmdV - mot.vqCmdV) < 1e-5);
  assert.ok(Math.abs(fwdMot.phiCmdDeg - mot.phiCmdDeg) < 1e-5);

  // Regen braking point (negative I_net, 4-quadrant phi outside [-90, +90])
  const reg = solveSinglePoint(13.5, -0.8, 1200, DEMO_MOTOR_PARAMS);
  assert.equal(reg.mode, 'regen');
  assert.ok(reg.iqA < 0);
  assert.ok(Math.abs(reg.phiCmdDeg) > 90, `Expected 4-quadrant |phi| > 90 in regen, got ${reg.phiCmdDeg}`);
  const fwdReg = forwardVerifyPoint(reg.iqA, 1200, 13.5, DEMO_MOTOR_PARAMS);
  assert.ok(Math.abs(fwdReg.iBusEstA - -0.8) < 1e-5);

  // Zero-drift deadband protection
  const zd = solveSinglePoint(13.5, 0.055, 1000, DEMO_MOTOR_PARAMS);
  assert.equal(zd.mode, 'zero_drift');
  assert.equal(zd.iqA, 0);

  // Invalid collapsed bus protection
  const badBus = solveSinglePoint(1.0, 30.0, 1000, DEMO_MOTOR_PARAMS); // 1.0 - 30*0.04 = -0.2V <= 0.1V
  assert.equal(badBus.mode, 'invalid_bus');
  assert.ok(Number.isNaN(badBus.iqA));

  // SVPWM linear limit constant
  assert.ok(Math.abs(SVPWM_LINEAR_LIMIT - 2 / Math.sqrt(3)) < 1e-12);
});

test('Stepwise calibration recovers Ke, P0(n), betaSat and builds 2D efficiency map', () => {
  const ol = buildDemoOpenLoopDataset();
  const cl = buildDemoClosedLoopDataset();
  const olNorm = normalizeDynoDataset(ol, { n_rpm: 'n_rpm', T_Nm: 'T_Nm', V_bus: 'V_bus', I_bus: 'I_bus', P_in: 'P_in', P_out: 'P_out', eta: 'eta' }, 'Nm', '0-1', { requireTorque: false });
  const clNorm = normalizeDynoDataset(cl, { n_rpm: 'n_rpm', T_Nm: 'T_Nm', V_bus: 'V_bus', I_bus: 'I_bus', P_in: 'P_in', P_out: 'P_out', eta: 'eta' }, 'Nm', '0-1', { requireTorque: true });

  const report = runStepwiseCalibration(olNorm.points, clNorm.points, DEMO_MOTOR_PARAMS, {
    keSource: 'open_loop_auto',
    manualN0Rpm: 1450,
    manualVTestV: 13.5,
    manualKv: 107.4,
    rsFitMode: 'locked',
  });

  assert.ok(Math.abs(report.kePrime - DEMO_MOTOR_PARAMS.kePrime) / DEMO_MOTOR_PARAMS.kePrime < 0.01);
  assert.ok(report.metrics.maeTorqueNm < 0.01, `Torque MAE too high: ${report.metrics.maeTorqueNm}`);
  assert.ok(report.metrics.maeEtaPct < 2.5, `Eta MAE too high: ${report.metrics.maeEtaPct}`);
  assert.ok(report.grid2D.speeds.length > 0 && report.grid2D.torques.length > 0);
});

test('6-MOS synthesis -> Oscilloscope tab & 6-MOS Thermal handoff + Scope channel unit import', () => {
  const synth = synthesizeSixMosWaveform(
    { vMeasV: 13.5, iBusA: 1.06, nRpm: 1000, tAmbC: 25, fsHz: 20000, durationS: 0.1 },
    DEMO_MOTOR_PARAMS
  );
  assert.equal(synth.error, null);
  assert.equal(synth.samples.length, 2000);
  // Balanced 3-phase currents sum to zero
  const s50 = synth.samples[50];
  assert.ok(Math.abs(s50.iaA + s50.ibA + s50.icA) < 1e-6);

  // Stall DC phase bias (n = 0)
  const stallSynth = synthesizeSixMosWaveform(
    { vMeasV: 13.5, iBusA: 0.65, nRpm: 0, tAmbC: 25, fsHz: 10000, durationS: 0.05 },
    DEMO_MOTOR_PARAMS
  );
  assert.equal(stallSynth.summary.isStall, true);
  assert.ok(Math.abs(stallSynth.samples[10].iaA + 2 * stallSynth.samples[10].ibA) < 1e-6);

  const scopeTab = buildOscilloscopeTabFromSixMos(synth, 1000)!;
  assert.ok(scopeTab);
  assert.equal(scopeTab.drawOrder.length, 4);
  assert.equal(scopeTab.channels['ch_ia'].unit, 'A');
  assert.equal(scopeTab.channels['ch_vbus'].unit, 'V');

  const handoff = buildThermalHandoffFromSixMos(synth, DEMO_MOTOR_PARAMS, 1000, 25)!;
  assert.ok(handoff);
  assert.ok(Math.abs(handoff.modDepthM - synth.summary.mCmd) < 1e-3);
  assert.ok(Math.abs(handoff.pfAngleDeg - synth.summary.phiCmdDeg) < 0.05);

  // Extract runtime log from scope channels with unit conversions (mA -> A, elec_hz -> RPM)
  const demoLog = buildDemoRuntimeLog();
  assert.equal(demoLog.length, 1200);
  const extracted = extractRuntimeLogFromScopeChannels({
    vbusCh: scopeTab.channels['ch_vbus'],
    vbusConstV: 13.5,
    ibusCh: { ...scopeTab.channels['ch_ia'], v: new Float32Array(scopeTab.channels['ch_ia'].v.map(() => 1060)) }, // 1060 mA
    currentUnit: 'mA',
    speedCh: { ...scopeTab.channels['ch_ia'], v: new Float32Array(scopeTab.channels['ch_ia'].v.map(() => (1000 * 7) / 60)) }, // elec Hz for 1000 RPM @ p=7
    speedConstRpm: 1000,
    speedUnit: 'elec_hz',
    polePairs: 7,
  });
  assert.ok(extracted.length > 0);
  assert.ok(Math.abs(extracted[0].iBusA - 1.06) < 1e-4);
  assert.ok(Math.abs(extracted[0].nRpm - 1000) < 1e-3);
});
