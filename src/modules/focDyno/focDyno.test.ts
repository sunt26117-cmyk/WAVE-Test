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
  isMonotonicTimestamps,
  movingAverageFilter,
  solveSinglePoint,
} from './motorPhysics';
import {
  autoMapColumns,
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
import { PYTHON_BUNDLE_FILES } from './pythonBundle';
import {
  buildOscilloscopeTabFromSixMos,
  buildThermalHandoffFromSixMos,
  extractRuntimeLogFromScopeChannels,
} from './scopeBridge';

test('SI unit conversions: torque, R_s(T_coil), L_q, and Ke <-> KV roundtrip', () => {
  assert.ok(Math.abs(torqueToNm(250, 'mNm') - 0.25) < 1e-12);
  assert.ok(Math.abs(torqueToNm(1.0, 'kgf_cm') - 0.0980665) < 1e-12);

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

test('Header unit auto-detection, T_coil non-collision, unmapped torque rejection & regen efficiency', () => {
  assert.equal(detectHeaderTorqueUnit('T_mNm (mN·m)'), 'mNm');
  assert.equal(detectHeaderTorqueUnit('Torque [kgf·cm]'), 'kgf_cm');
  assert.equal(detectHeaderTorqueUnit('T_Nm'), 'Nm');

  const mapped = autoMapColumns(['n_rpm', 'T_coil', 'V_bus', 'I_bus']);
  assert.equal(mapped.T_Nm, '');

  const dsNoT = parseCsvText('n_rpm,T_coil,V_bus,I_bus\n1000,45,13.5,2.0\n');
  const resNoT = normalizeDynoDataset(dsNoT, mapped, 'Nm', '0-1', { requireTorque: true });
  assert.equal(resNoT.points.length, 0);
  assert.ok(resNoT.warnings.some((w) => w.includes('未映射扭矩列')));

  // Regen efficiency fallback when eta column is absent
  const regenDs = parseCsvText('n_rpm,T_Nm,V_bus,I_bus\n1200,-0.15,13.5,-0.9\n');
  const regenMap = autoMapColumns(regenDs.headers);
  const regenNorm = normalizeDynoDataset(regenDs, regenMap, 'Nm', '0-1', { requireTorque: true });
  assert.equal(regenNorm.points.length, 1);
  assert.ok(regenNorm.points[0].etaMeas > 0.5 && regenNorm.points[0].etaMeas < 1.0);

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

test('4-Quadrant solveSinglePoint <-> forwardVerifyPoint exact parity, beta energy balance & safety bounds', () => {
  // Motoring point with betaSat > 0
  const mot = solveSinglePoint(13.5, 2.5, 1000, DEMO_MOTOR_PARAMS);
  assert.equal(mot.mode, 'motoring');
  assert.ok(Number.isFinite(mot.iqA) && mot.iqA > 1.0);
  // Energy balance: P_elec == P_out + P_cu + P0
  assert.ok(Math.abs(mot.pElecW - (mot.pOutW + mot.pCuW + mot.p0W)) < 1e-9);

  const fwdMot = forwardVerifyPoint(mot.iqA, 1000, 13.5, DEMO_MOTOR_PARAMS);
  assert.ok(Math.abs(fwdMot.iBusEstA - 2.5) < 1e-8);
  assert.ok(Math.abs(fwdMot.vqCmdV - mot.vqCmdV) < 1e-8);
  assert.ok(Math.abs(fwdMot.phiCmdDeg - mot.phiCmdDeg) < 1e-8);
  assert.ok(Math.abs(fwdMot.tEstNm - mot.tEstNm) < 1e-8);

  // Heavy saturation energy balance check
  const highSatParams = { ...DEMO_MOTOR_PARAMS, betaSat: 0.05 };
  const satPt = solveSinglePoint(13.5, 3.0, 900, highSatParams);
  assert.equal(satPt.mode, 'motoring');
  assert.ok(Math.abs(satPt.pElecW - (satPt.pOutW + satPt.pCuW + satPt.p0W)) < 1e-9);
  const fwdSat = forwardVerifyPoint(satPt.iqA, 900, 13.5, highSatParams);
  assert.ok(Math.abs(fwdSat.iBusEstA - 3.0) < 1e-8);

  // Regen braking point (negative I_net, 4-quadrant phi outside [-90, +90])
  const reg = solveSinglePoint(13.5, -0.8, 1200, DEMO_MOTOR_PARAMS);
  assert.equal(reg.mode, 'regen');
  assert.ok(reg.iqA < 0);
  assert.ok(Math.abs(reg.phiCmdDeg) > 90, `Expected 4-quadrant |phi| > 90 in regen, got ${reg.phiCmdDeg}`);
  assert.ok(Math.abs(reg.pElecW - (reg.pOutW + reg.pCuW + reg.p0W)) < 1e-9);
  const fwdReg = forwardVerifyPoint(reg.iqA, 1200, 13.5, DEMO_MOTOR_PARAMS);
  assert.ok(Math.abs(fwdReg.iBusEstA - -0.8) < 1e-8);
  assert.ok(Math.abs(fwdReg.etaEst - reg.etaEst) < 1e-8);

  // Zero-drift deadband protection: spinning coast-down balances P0 drag (-P0); zero-speed stays 0
  const zd = solveSinglePoint(13.5, 0.055, 1000, DEMO_MOTOR_PARAMS);
  assert.equal(zd.mode, 'zero_drift');
  assert.equal(zd.iqA, 0);
  assert.equal(zd.etaEst, 0);
  assert.ok(Math.abs(zd.pOutW - -zd.p0W) < 1e-12);
  assert.ok(Math.abs(zd.tEstNm - -zd.p0W / zd.omegaM) < 1e-12);
  assert.ok(Math.abs(zd.pElecW - (zd.pOutW + zd.pCuW + zd.p0W)) < 1e-12);
  const zdFwd = forwardVerifyPoint(0, 1000, 13.5, DEMO_MOTOR_PARAMS);
  assert.ok(Math.abs(zdFwd.tEstNm - zd.tEstNm) < 1e-12);
  assert.ok(Math.abs(zdFwd.pOutW - zd.pOutW) < 1e-12);

  const zdRev = solveSinglePoint(13.5, 0.055, -1000, DEMO_MOTOR_PARAMS);
  assert.equal(zdRev.mode, 'zero_drift');
  assert.ok(zdRev.tEstNm > 0, `Reverse coasting drag torque must oppose negative speed, got ${zdRev.tEstNm}`);
  assert.ok(Math.abs(zdRev.pOutW - -zdRev.p0W) < 1e-12);

  const zdStop = solveSinglePoint(13.5, DEMO_MOTOR_PARAMS.iIdleA, 0, DEMO_MOTOR_PARAMS);
  assert.equal(zdStop.mode, 'zero_drift');
  assert.equal(zdStop.tEstNm, 0);
  assert.equal(zdStop.pOutW, 0);

  // Invalid collapsed bus protection
  const badBus = solveSinglePoint(1.0, 30.0, 1000, DEMO_MOTOR_PARAMS);
  assert.equal(badBus.mode, 'invalid_bus');
  assert.ok(Number.isNaN(badBus.iqA));

  // SVPWM linear limit constant
  assert.ok(Math.abs(SVPWM_LINEAR_LIMIT - 2 / Math.sqrt(3)) < 1e-12);
});

test('Stepwise calibration recovers Ke, P0(n), betaSat and masks unreachable 2D map cells', () => {
  const ol = buildDemoOpenLoopDataset();
  const cl = buildDemoClosedLoopDataset();
  const olNorm = normalizeDynoDataset(
    ol,
    { n_rpm: 'n_rpm', T_Nm: 'T_Nm', V_bus: 'V_bus', I_bus: 'I_bus', P_in: 'P_in', P_out: 'P_out', eta: 'eta' },
    'Nm',
    '0-1',
    { requireTorque: false }
  );
  const clNorm = normalizeDynoDataset(
    cl,
    { n_rpm: 'n_rpm', T_Nm: 'T_Nm', V_bus: 'V_bus', I_bus: 'I_bus', P_in: 'P_in', P_out: 'P_out', eta: 'eta' },
    'Nm',
    '0-1',
    { requireTorque: true }
  );

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

  // Over-modulated corners in 2D map should be null, never 0
  const hasZeroPred = report.grid2D.zPredicted.some((row) => row.some((v) => v === 0));
  assert.equal(hasZeroPred, false);
});

test('6-MOS synthesis rejects over-modulation & preserves valid handoff + time-aligned Scope bridge', () => {
  // Over-modulated point (13.5V, 10A, 1000RPM -> m_norm > 1.0) must be rejected
  const overSynth = synthesizeSixMosWaveform(
    { vMeasV: 13.5, iBusA: 10.0, nRpm: 1000, tAmbC: 25, fsHz: 20000, durationS: 0.05 },
    DEMO_MOTOR_PARAMS
  );
  assert.ok(overSynth.error !== null && overSynth.error.includes('超调'));
  assert.equal(overSynth.samples.length, 0);

  const synth = synthesizeSixMosWaveform(
    { vMeasV: 13.5, iBusA: 1.06, nRpm: 1000, tAmbC: 25, fsHz: 20000, durationS: 0.1 },
    DEMO_MOTOR_PARAMS
  );
  assert.equal(synth.error, null);
  assert.equal(synth.samples.length, 2000);
  const s50 = synth.samples[50];
  assert.ok(Math.abs(s50.iaA + s50.ibA + s50.icA) < 1e-6);

  // Optional Duty_A/B/C synthesis & thermal handoff wiring
  const synthWithDuty = synthesizeSixMosWaveform(
    { vMeasV: 13.5, iBusA: 1.06, nRpm: 1000, tAmbC: 25, fsHz: 20000, durationS: 0.05, modulation: 'DPWM1', includeDuty: true },
    DEMO_MOTOR_PARAMS
  );
  assert.equal(synthWithDuty.error, null);
  assert.ok(synthWithDuty.csvContent.startsWith('Time,Ia,Ib,Ic,Vbus,Duty_A,Duty_B,Duty_C'));
  const handoffDuty = buildThermalHandoffFromSixMos(synthWithDuty, DEMO_MOTOR_PARAMS, 1000, 25)!;
  assert.equal(handoffDuty.modulation, 'DPWM1');
  assert.equal(handoffDuty.daChannelId, 'ch_da');
  assert.equal(handoffDuty.dbChannelId, 'ch_db');
  assert.equal(handoffDuty.dcChannelId, 'ch_dc');
  assert.equal(handoffDuty.tab.drawOrder.length, 7);

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

  const demoLog = buildDemoRuntimeLog();
  assert.equal(demoLog.length, 1200);

  // Timestamp-aligned interpolation across asynchronous channels (different sample counts)
  const baseVbus = scopeTab.channels['ch_vbus'];
  const asyncVbus = {
    ...baseVbus,
    t: new Float64Array([0, 0.1]),
    v: new Float32Array([12.0, 14.0]),
  };
  const extracted = extractRuntimeLogFromScopeChannels({
    vbusCh: asyncVbus,
    vbusConstV: 13.5,
    ibusCh: { ...scopeTab.channels['ch_ia'], v: new Float32Array(scopeTab.channels['ch_ia'].v.map(() => 1060)) },
    currentUnit: 'mA',
    speedCh: { ...scopeTab.channels['ch_ia'], v: new Float32Array(scopeTab.channels['ch_ia'].v.map(() => (1000 * 7) / 60)) },
    speedConstRpm: 1000,
    speedUnit: 'elec_hz',
    polePairs: 7,
  });
  assert.ok(extracted.length === 2000);
  assert.ok(Math.abs(extracted[0].iBusA - 1.06) < 1e-4);
  assert.ok(Math.abs(extracted[0].nRpm - 1000) < 1e-3);
  // Halfway point (t = 0.05s) should interpolate Vbus smoothly between 12V and 14V (~13.0V)
  const midPt = extracted[Math.floor(extracted.length / 2)];
  assert.ok(Math.abs(midPt.vMeasV - 13.0) < 0.01);

  // Moving average filter monotonicity check & non-uniform centered windowing
  assert.equal(isMonotonicTimestamps([0, 0.01, 0.03]), true);
  assert.equal(isMonotonicTimestamps([0, 0.02, 0.01]), false);
  const filt = movingAverageFilter([1, 2, 100, 4], [0, 0.001, 0.05, 0.051], 10);
  assert.ok(Math.abs(filt[0] - 1.5) < 1e-9);
  assert.ok(Math.abs(filt[2] - 52) < 1e-9);
});

import { reconstructSensorlessDutySample } from '../focThermal';

test('Python bundle emits verbatim raw regex strings with no control-character escaping corruption', () => {
  const appPy = PYTHON_BUNDLE_FILES.find((f) => f.name === 'app.py')?.content || '';
  const exporterPy = PYTHON_BUNDLE_FILES.find((f) => f.name === 'thermal_exporter.py')?.content || '';
  assert.ok(appPy.length > 1000);
  // Must not contain ASCII BS (\x08) from unescaped \b in JS template literals
  assert.equal(appPy.includes('\x08'), false);
  assert.ok(appPy.includes(String.raw`r"(?:^|[\s_(\[（])(?:ms|msec|毫秒)(?:$|[\s_)\]）])"`));
  assert.ok(appPy.includes(String.raw`\s*[\[(（].*[\])）]`));
  // Python DPWM1 zero-modulation guard & 4-quadrant iq < 0 phase alignment
  assert.ok(exporterPy.includes('if v_amp <= 1e-6:'));
  assert.ok(exporterPy.includes('iq_phase_shift = 0.0 if iq >= 0.0 else math.pi'));
});

test('Round-3: 4-quadrant regen iq < 0 Duty matches sensorless reconstruction & export clamp propagates duration/Rs', () => {
  // Negative-torque regen braking point (iq < 0, phiCmdDeg ~ -175 deg or +175 deg)
  const regenSynth = synthesizeSixMosWaveform(
    {
      vMeasV: 13.5,
      iBusA: -0.8,
      nRpm: 1200,
      tAmbC: 25,
      fsHz: 20000,
      durationS: 0.05,
      modulation: 'SVPWM',
      includeDuty: true,
    },
    DEMO_MOTOR_PARAMS
  );
  assert.equal(regenSynth.error, null);
  assert.ok(regenSynth.pointResult.iqA < 0);

  // Verify every sample matches focThermal.reconstructSensorlessDutySample (regression guard against 180-deg flip)
  for (const idx of [5, 25, 100, 350]) {
    const s = regenSynth.samples[idx];
    const rec = reconstructSensorlessDutySample(
      s.iaA,
      s.ibA,
      s.icA,
      'SVPWM',
      regenSynth.summary.mCmd,
      regenSynth.summary.phiCmdDeg
    );
    assert.ok(Math.abs((s.da ?? 0) - rec.da) < 1e-4, `da mismatch at idx=${idx}: ${s.da} vs ${rec.da}`);
    assert.ok(Math.abs((s.db ?? 0) - rec.db) < 1e-4, `db mismatch at idx=${idx}: ${s.db} vs ${rec.db}`);
    assert.ok(Math.abs((s.dc ?? 0) - rec.dc) < 1e-4, `dc mismatch at idx=${idx}: ${s.dc} vs ${rec.dc}`);
  }

  // Export duration truncation (> 200,000 samples) populates actualDurationS and propagates warning + rsPhaseOhm
  const clampedSynth = synthesizeSixMosWaveform(
    {
      vMeasV: 13.5,
      iBusA: 1.06,
      nRpm: 1000,
      tAmbC: 25,
      fsHz: 100000,
      durationS: 5.0,
      modulation: 'SVPWM',
      includeDuty: true,
    },
    DEMO_MOTOR_PARAMS
  );
  assert.equal(clampedSynth.error, null);
  assert.equal(clampedSynth.clampedByLimit, true);
  assert.equal(clampedSynth.requestedSamples, 500000);
  assert.equal(clampedSynth.exportedSamples, 200000);
  assert.ok(Math.abs(clampedSynth.actualDurationS - 1.99999) < 1e-4);

  const clampedHandoff = buildThermalHandoffFromSixMos(clampedSynth, DEMO_MOTOR_PARAMS, 1000, 25)!;
  assert.ok(clampedHandoff.handoffNote?.includes('时长已截断'));
  assert.ok(Math.abs((clampedHandoff.rsPhaseOhm ?? 0) - clampedSynth.pointResult.rsOhm) < 1e-5);
});

test('Audit items #2, #12, #20, #21: iqSignAmbiguous, trapezoidal filter, Dyno kW/mW power scaling & calibration status gates', () => {
  // #2: iqSignAmbiguous in regen braking & n=0 symmetric stall vs false in normal motoring
  const motClear = solveSinglePoint(13.5, 2.5, 1000, DEMO_MOTOR_PARAMS);
  assert.equal(motClear.alerts.iqSignAmbiguous, false);

  const regenAmb = solveSinglePoint(13.5, -0.8, 1200, DEMO_MOTOR_PARAMS);
  assert.equal(regenAmb.mode, 'regen');
  assert.equal(regenAmb.alerts.iqSignAmbiguous, true);

  const stallAmb = solveSinglePoint(13.5, 1.5, 0, DEMO_MOTOR_PARAMS);
  assert.equal(stallAmb.alerts.iqSignAmbiguous, true);

  // #12: Trapezoidal time-weighted movingAverageFilter resists dense-burst skew
  // Piecewise linear / flat step over [0, 0.05]: dense 10 pts @ 0..0.0009s (val=100), then 0.05s (val=0)
  // Window 100 ms covers whole [0, 0.05] interval; arithmetic mean would be ~91 whereas true time average is ~2.8
  const tsBurst = [0, 0.0001, 0.0002, 0.0003, 0.0004, 0.0005, 0.0006, 0.0007, 0.0008, 0.0009, 0.05];
  const vsBurst = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 0];
  const trapFilt = movingAverageFilter(vsBurst, tsBurst, 100);
  // Exact integral: 100*0.0009 + 0.5*(100+0)*(0.05-0.0009) = 0.09 + 2.455 = 2.545 over 0.05s => 50.9 (not 90.9!)
  assert.ok(Math.abs(trapFilt[5] - 50.9) < 0.05, `Expected trapezoidal mean 50.9, got ${trapFilt[5]}`);

  // #20: Dyno power unit normalization (kW -> W, mW -> W) and non-power warning
  const pwrCsv = parseCsvText(
    'n_rpm,T_Nm,V_bus,I_bus,P_in (kW),P_out (mW),eta\n' +
      '1000,0.2,13.5,2.5,0.03375,20944,0.6206\n'
  );
  const pwrMap = autoMapColumns(pwrCsv.headers);
  const pwrNorm = normalizeDynoDataset(pwrCsv, pwrMap, 'Nm', '0-1', { requireTorque: true });
  assert.equal(pwrNorm.points.length, 1);
  assert.ok(Math.abs(pwrNorm.points[0].pInW - 33.75) < 1e-6);
  assert.ok(Math.abs(pwrNorm.points[0].pOutW - 20.944) < 1e-6);

  const badPwrCsv = parseCsvText('n_rpm,T_Nm,V_bus,I_bus,P_in (rpm)\n1000,0.2,13.5,2.5,30\n');
  const badPwrNorm = normalizeDynoDataset(
    badPwrCsv,
    { n_rpm: 'n_rpm', T_Nm: 'T_Nm', V_bus: 'V_bus', I_bus: 'I_bus', P_in: 'P_in (rpm)', P_out: '', eta: '' },
    'Nm',
    '0-1',
    { requireTorque: true }
  );
  assert.ok(badPwrNorm.warnings.some((w) => w.includes('非标准功率单位')));

  // #21: Calibration status & warnings propagation (ok vs failed)
  const ol = buildDemoOpenLoopDataset();
  const cl = buildDemoClosedLoopDataset();
  const olNorm = normalizeDynoDataset(
    ol,
    { n_rpm: 'n_rpm', T_Nm: 'T_Nm', V_bus: 'V_bus', I_bus: 'I_bus', P_in: 'P_in', P_out: 'P_out', eta: 'eta' },
    'Nm',
    '0-1',
    { requireTorque: false }
  );
  const clNorm = normalizeDynoDataset(
    cl,
    { n_rpm: 'n_rpm', T_Nm: 'T_Nm', V_bus: 'V_bus', I_bus: 'I_bus', P_in: 'P_in', P_out: 'P_out', eta: 'eta' },
    'Nm',
    '0-1',
    { requireTorque: true }
  );
  const okReport = runStepwiseCalibration(olNorm.points, clNorm.points, DEMO_MOTOR_PARAMS, {
    keSource: 'open_loop_auto',
    manualN0Rpm: 1450,
    manualVTestV: 13.5,
    manualKv: 107.4,
    rsFitMode: 'locked',
  });
  assert.equal(okReport.status, 'ok');

  const emptyClReport = runStepwiseCalibration(olNorm.points, [], DEMO_MOTOR_PARAMS, {
    keSource: 'open_loop_auto',
    manualN0Rpm: 1450,
    manualVTestV: 13.5,
    manualKv: 107.4,
    rsFitMode: 'locked',
  });
  assert.equal(emptyClReport.status, 'failed');
  assert.ok(emptyClReport.warnings.length > 0);

  // Corrupted huge torque points should fail physical accuracy gate
  const badCl = clNorm.points.slice(0, 6).map((p) => ({ ...p, tNm: 10.0 }));
  const badFitReport = runStepwiseCalibration(olNorm.points, badCl, DEMO_MOTOR_PARAMS, {
    keSource: 'open_loop_auto',
    manualN0Rpm: 1450,
    manualVTestV: 13.5,
    manualKv: 107.4,
    rsFitMode: 'locked',
  });
  assert.equal(badFitReport.status, 'failed');
  assert.ok(badFitReport.warnings.some((w) => w.includes('误差过大')));
});




