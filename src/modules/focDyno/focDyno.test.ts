import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function resolvePythonExecutable(): string | null {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }
  return null;
}

const PYTHON_EXECUTABLE = resolvePythonExecutable();
import {
  SVPWM_LINEAR_LIMIT,
  calcKeFromKv,
  calcKeFromNoLoad,
  calcKvFromKe,
  calcLqH,
  calcPhiDeg,
  calcRsAnchorOhm,
  calcVqCmd,
  forwardVerifyPoint,
  isMonotonicTimestamps,
  movingAverageFilter,
  movingAverageFilterWithDiagnostics,
  partitionContinuousTimeSegments,
  processRuntimeLog,
  processRuntimeLogWithAudit,
  solveSinglePoint,
  validateMotorParams,
} from './motorPhysics';
import {
  analyzeDynamicIdentifiability,
  autoMapColumns,
  detectHeaderEngineeringScale,
  detectHeaderEtaFormat,
  detectHeaderPowerScaleW,
  detectHeaderTorqueUnit,
  normalizeDynoDataset,
  buildEfficiencyGrid2D,
  fitNonNegLinearP0,
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
  buildDynamicPmsmCsv,
  buildDynamicPmsmScopeTab,
  buildDynamicPresetScenario,
  calcDynamicPmsmTorque,
  kePrimeToPsiF,
  simulateDynamicPmsm,
  createPmsmFluxMapImportTemplate,
  parsePmsmFluxMapJson,
  evaluatePmsmFluxMap,
} from './dynamicPmsm';
import {
  buildOscilloscopeTabFromSixMos,
  buildOscilloscopeTabFromBatchLog,
  buildThermalHandoffFromSixMos,
  extractRuntimeLogFromScopeChannels,
  extractRuntimeLogWithAudit,
} from './scopeBridge';

import type { SamplingMetadata } from '../../types/models';

/**
 * Minimal SamplingMetadata for synthetic test channels.
 * WaveformChannel.metadata is required, so every mock channel needs one.
 */
const testSamplingMetadata = (count: number, dt: number): SamplingMetadata => ({
  dataProvenance: 'synthetic_steady_state',
  originalSampleCount: count,
  originalTimeStart: 0,
  originalTimeEnd: count > 0 ? (count - 1) * dt : 0,
  isUniformSampling: true,
  nominalDt: dt,
  medianDt: dt,
  meanDt: dt,
  minDt: dt,
  maxDt: dt,
  jitterRms: null,
  jitterMax: null,
  droppedSamples: 0,
  invalidSamples: 0,
  sampleRate: dt > 0 ? 1 / dt : null,
  qualityStatus: 'uniform',
  gapCount: 0,
  gapIndices: [],
});


test('Round-3: Scope batch bridge preserves robust timebase and per-channel invalid counts', () => {
  const point = solveSinglePoint(13.5, 1.06, 1000, DEMO_MOTOR_PARAMS);
  const rows = [0, 1, 2, 3].map((i) => ({
    timeS: [0, 0.001, 0.0025, 0.0035][i],
    vMeasV: 13.5,
    iBusRawA: 1.06,
    iBusFilteredA: (i === 1 || i === 2) ? Number.NaN : 1.06,
    nRpm: 1000,
    result: { ...point, iqA: i === 2 ? Number.NaN : point.iqA, vqMotorV: point.vqMotorV },
  }));

  const tab = buildOscilloscopeTabFromBatchLog(rows, 'irregular.csv');
  assert.ok(tab);
  const iq = tab.channels['ch_iq'];
  const ibus = tab.channels['ch_ibus'];
  // Median interval is 1 ms; average interval would incorrectly advertise 1.167 ms.
  assert.ok(Math.abs((iq.dt ?? 0) - 0.001) < 1e-12);
  assert.ok(Math.abs((iq.fs ?? 0) - 1000) < 1e-8);
  assert.equal(iq.metadata?.medianDt, 0.001);
  assert.equal(iq.metadata?.signalNanCount, 1);
  assert.equal(ibus.metadata?.signalNanCount, 2);
  assert.equal(iq.metadata?.dataProvenance, 'derived_estimate');
  assert.equal(iq.metadata?.sourceModel, 'foc_inverse_steady_state_model');
  assert.equal(ibus.metadata?.dataProvenance, 'measured');
  assert.notEqual(iq.metadata, ibus.metadata);

  const invalidRows = [
    { ...rows[0], timeS: 0 },
    { ...rows[1], timeS: 0.001 },
    { ...rows[2], timeS: 0.001 }, // duplicate timestamp is ambiguous for Scope timebase
  ];
  assert.equal(buildOscilloscopeTabFromBatchLog(invalidRows, 'duplicate.csv'), null);
  assert.equal(buildOscilloscopeTabFromBatchLog([
    { ...rows[0], timeS: 0 },
    { ...rows[1], timeS: Number.NaN },
  ], 'nan-time.csv'), null);
});

test('Round-3: Six-MOS Scope bridge refuses incomplete duty arrays instead of inventing 50% duty', () => {
  const synth = synthesizeSixMosWaveform(
    { vMeasV: 13.5, iBusA: 1.06, nRpm: 1000, tAmbC: 25, fsHz: 20000, durationS: 0.01, includeDuty: true },
    DEMO_MOTOR_PARAMS
  );
  assert.equal(synth.error, null);
  const broken = {
    ...synth,
    samples: synth.samples.map((sample, index) => index === 3 ? { ...sample, db: undefined } : sample),
  };
  assert.equal(buildOscilloscopeTabFromSixMos(broken, 1000), null);

  const duplicateTime = {
    ...synth,
    samples: synth.samples.map((sample, index) => index === 3 ? { ...sample, timeS: synth.samples[2].timeS } : sample),
  };
  assert.equal(buildOscilloscopeTabFromSixMos(duplicateTime, 1000), null);
});


test('DynoLab engineering-unit headers are normalized to V/A/mechanical RPM without silent Hz reinterpretation', () => {
  const ds = parseCsvText(
    'n_rpm [krpm],T_Nm,V_bus (mV),I_bus [mA]\n1,0.2,13500,1060\n'
  );
  const mapped = {
    n_rpm: 'n_rpm [krpm]',
    T_Nm: 'T_Nm',
    V_bus: 'V_bus (mV)',
    I_bus: 'I_bus [mA]',
    P_in: '',
    P_out: '',
    eta: '',
  };
  const normalized = normalizeDynoDataset(ds, mapped, 'Nm', '0-1', { requireTorque: true });
  assert.equal(normalized.points.length, 1);
  assert.equal(normalized.points[0].nRpm, 1000);
  assert.equal(normalized.points[0].vBusV, 13.5);
  assert.ok(Math.abs(normalized.points[0].iBusA - 1.06) < 1e-9);
  assert.deepEqual(detectHeaderEngineeringScale('speed (Hz)', 'speed').invalidToken, 'Hz');

  const badDs = parseCsvText('speed (Hz),T_Nm,V_bus,I_bus\n100,0.2,13.5,1\n');
  const badMap = {
    n_rpm: 'speed (Hz)', T_Nm: 'T_Nm', V_bus: 'V_bus', I_bus: 'I_bus',
    P_in: '', P_out: '', eta: '',
  };
  const rejected = normalizeDynoDataset(badDs, badMap, 'Nm', '0-1', { requireTorque: true });
  assert.equal(rejected.points.length, 0);
  assert.ok(rejected.warnings.some((warning) => warning.includes('Hz')));

  const badPowerDs = parseCsvText('n_rpm,T_Nm,V_bus,I_bus,P_in (hp)\n1000,0.2,13.5,1,0.02\n');
  const badPowerMap = {
    n_rpm: 'n_rpm', T_Nm: 'T_Nm', V_bus: 'V_bus', I_bus: 'I_bus',
    P_in: 'P_in (hp)', P_out: '', eta: '',
  };
  const rejectedPower = normalizeDynoDataset(badPowerDs, badPowerMap, 'Nm', '0-1', { requireTorque: true });
  assert.equal(rejectedPower.points.length, 0);
  assert.ok(rejectedPower.warnings.some((warning) => warning.includes('hp')));
});


test('FOC scope bridge rejects invalid pole-pair configuration and channel length mismatch instead of emitting a partial runtime log', () => {
  const t = new Float64Array([0, 0.001, 0.002]);
  const validChannel = {
    id: 'scope_i', name: 'Ibus', unit: 'A', color: '#fff', visible: true,
    t, v: new Float32Array([1, 1, 1]), fs: 1000, dt: 0.001,
    vMin: 0, vMax: 2, coupling: 'DC' as const, inverted: false,
    isMath: false, sourceChannelIds: [],
    metadata: testSamplingMetadata(t.length, 0.001),
  };
  const baseOptions = {
    vbusCh: null, vbusConstV: 13.5, ibusCh: validChannel, currentUnit: 'A' as const,
    speedCh: null, speedConstRpm: 1000, speedUnit: 'rpm' as const, polePairs: 7,
  };
  const fractionalPolePairs = extractRuntimeLogWithAudit({
    ...baseOptions,
    speedCh: validChannel,
    speedUnit: 'elec_hz',
    polePairs: 7.5,
  });
  assert.equal(fractionalPolePairs.rows.length, 0);
  assert.ok(fractionalPolePairs.warnings.some((warning) => warning.includes('正整数')));

  const fractionalPointLimit = extractRuntimeLogWithAudit({
    ...baseOptions,
    maxPoints: 2.5,
  });
  assert.equal(fractionalPointLimit.rows.length, 0);
  assert.ok(fractionalPointLimit.warnings.some((warning) => warning.includes('整数')));

  const mismatch = extractRuntimeLogWithAudit({
    ...baseOptions,
    ibusCh: { ...validChannel, v: new Float32Array([1, 1]) },
  });
  assert.equal(mismatch.rows.length, 0);
  assert.ok(mismatch.warnings.some((warning) => warning.includes('长度不一致')));

  const gappedChannel = {
    ...validChannel,
    t: new Float64Array([0, 0.001, 0.002, 0.02, 0.021, 0.022]),
    v: new Float32Array([1, 1, 1, 1, 1, 1]),
  };
  const gapped = extractRuntimeLogWithAudit({ ...baseOptions, ibusCh: gappedChannel });
  assert.equal(gapped.rows.length, 0);
  assert.ok(gapped.warnings.some((warning) => warning.includes('内部采样缺口')));
});



test('FOC scope bridge preserves extrema from Ibus, Vbus and Speed when runtime log is capped', () => {
  const n = 100;
  const t = Float64Array.from({ length: n }, (_, i) => i * 0.001);
  const mk = (id: string, name: string, sampleTimes: Float64Array, values: Float32Array) => ({
    id, name, unit: name === 'Vbus' ? 'V' : name === 'Speed' ? 'rpm' : 'A',
    color: '#fff', visible: true, t: sampleTimes, v: values,
    fs: sampleTimes.length > 1 ? 1 / (sampleTimes[1] - sampleTimes[0]) : 1000,
    dt: sampleTimes.length > 1 ? sampleTimes[1] - sampleTimes[0] : 0.001,
    vMin: Math.min(...values), vMax: Math.max(...values), coupling: 'DC' as const,
    inverted: false, isMath: false, sourceChannelIds: [],
    metadata: testSamplingMetadata(
      sampleTimes.length,
      sampleTimes.length > 1 ? sampleTimes[1] - sampleTimes[0] : 0.001
    ),
  });
  const ibus = mk('ibus-flat', 'Ibus', t, Float32Array.from({ length: n }, () => 2));
  // Vbus and Speed use different point counts and sampling periods. Their
  // critical extrema still coincide with actual Ibus timestamps in this test.
  const tVbus = Float64Array.from({ length: 199 }, (_, i) => i * 0.0005);
  const vbusValues = Float32Array.from({ length: tVbus.length }, (_, i) => i === 102 ? 8 : 48);
  const tSpeed = Float64Array.from({ length: 51 }, (_, i) => i * 0.002);
  const speedValues = Float32Array.from({ length: tSpeed.length }, (_, i) => i === 39 ? 100 : 2000);
  const vbus = mk('vbus-sag', 'Vbus', tVbus, vbusValues);
  const speed = mk('speed-dip', 'Speed', tSpeed, speedValues);
  const result = extractRuntimeLogWithAudit({
    vbusCh: vbus, vbusConstV: 48, ibusCh: ibus, currentUnit: 'A',
    speedCh: speed, speedConstRpm: 2000, speedUnit: 'rpm', polePairs: 7, maxPoints: 8,
  });
  assert.ok(result.rows.length <= 8);
  assert.ok(result.rows.some((row) => Math.abs(row.timeS - 0.051) < 1e-9 && row.vMeasV === 8), 'Vbus sag sample must survive');
  assert.ok(result.rows.some((row) => Math.abs(row.timeS - 0.078) < 1e-9 && row.nRpm === 100), 'Speed dip sample must survive');
  assert.ok(result.warnings.some((warning) => warning.includes('各通道峰/谷联合降采样')));
});

test('DynoLab: efficiency envelope rejects collinear measurements; P0 loss fit is direction-symmetric', () => {
  const basePoint = {
    tNm: 0, vBusV: 48, iBusA: 2, pInW: 96, pOutW: 10, etaMeas: 0.8,
    iqEstA: 1, tEstNm: 0, pOutEstW: 10, etaEst: 0.8, pInvLossW: 1,
    pCuLossW: 2, pIronWindLossW: 3, errTorqueNm: 0, errEta: 0,
  };
  const collinear = [
    { ...basePoint, nRpm: 0, tNm: 0 },
    { ...basePoint, nRpm: 50, tNm: 0.5 },
    { ...basePoint, nRpm: 100, tNm: 1.0 },
    { ...basePoint, nRpm: 100, tNm: 1.0 },
  ];
  const grid = buildEfficiencyGrid2D(collinear, DEMO_MOTOR_PARAMS);
  assert.ok(grid.zMeasured.flat().every((v) => v === null), 'collinear points must not create a 2D interpolation envelope');
  assert.ok(grid.zPredicted.flat().every((v) => v === null), 'degenerate hull must not be extrapolated across the map');

  const mixedBus = [
    { ...basePoint, nRpm: 100, tNm: 0.1, vBusV: 12 },
    { ...basePoint, nRpm: 1000, tNm: 0.1, vBusV: 48 },
    { ...basePoint, nRpm: 100, tNm: 1.0, vBusV: 12 },
    { ...basePoint, nRpm: 1000, tNm: 1.0, vBusV: 48 },
  ];
  const mixedBusGrid = buildEfficiencyGrid2D(mixedBus, DEMO_MOTOR_PARAMS);
  assert.ok(mixedBusGrid.warning?.includes('不能混合不同母线电压平面'));
  assert.equal(mixedBusGrid.speeds.length, 0, 'different Vbus planes must not be blended into one 2D map');

  const incompleteEta = [
    { ...basePoint, nRpm: 100, tNm: 0.1, etaMeas: 0.80 },
    { ...basePoint, nRpm: 1000, tNm: 0.1, etaMeas: 0.81 },
    { ...basePoint, nRpm: 100, tNm: 1.0, etaMeas: 0.82 },
    { ...basePoint, nRpm: 1000, tNm: 1.0, etaMeas: Number.NaN },
  ];
  const incompleteEtaGrid = buildEfficiencyGrid2D(incompleteEta, DEMO_MOTOR_PARAMS);
  assert.equal(incompleteEtaGrid.zMeasured[21][27], null, 'a point without measured efficiency must not enlarge the measured map hull');
  assert.ok(incompleteEtaGrid.warning === undefined || incompleteEtaGrid.warning.includes('有效测量效率点'));

  const fit = fitNonNegLinearP0([
    { n: 100, p0: 20 }, { n: 200, p0: 60 },
    { n: -100, p0: 20 }, { n: -200, p0: 60 },
  ]);
  assert.ok(Math.abs(fit.a - 0.1) < 1e-9, `expected symmetric linear coefficient 0.1, got ${fit.a}`);
  assert.ok(Math.abs(fit.b - 0.001) < 1e-9, `expected quadratic coefficient 0.001, got ${fit.b}`);
});

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

test('Dyno power suffix units distinguish MW/mW, accept kW/GW/TW and reject hp/energy without W fallback', () => {
  assert.equal(detectHeaderPowerScaleW('P_in_kw').scaleW, 1e3);
  assert.equal(detectHeaderPowerScaleW('P_in_mw').scaleW, 1e-3);
  assert.equal(detectHeaderPowerScaleW('P_in_MW').scaleW, 1e6);
  assert.equal(detectHeaderPowerScaleW('P_in_GW').scaleW, 1e9);
  assert.equal(detectHeaderPowerScaleW('P_in_TW').scaleW, 1e12);
  assert.equal(detectHeaderPowerScaleW('P_in_hp').invalidToken, 'hp');
  assert.equal(detectHeaderPowerScaleW('P_in_horsepower').invalidToken, 'horsepower');
  assert.equal(detectHeaderPowerScaleW('P_in_kWh').invalidToken, 'kWh');
  const gwDs = parseCsvText('n_rpm,T_Nm,V_bus,I_bus,P_in_GW\n1000,0.1,13.5,1.0,0.000000002\n');
  const gwNorm = normalizeDynoDataset(gwDs, autoMapColumns(gwDs.headers), 'Nm', '0-1', { requireTorque: true });
  assert.equal(gwNorm.points.length, 1);
  assert.ok(Math.abs(gwNorm.points[0].pInW - 2) < 1e-9);
  const hpDs = parseCsvText('n_rpm,T_Nm,V_bus,I_bus,P_in_hp\n1000,0.1,13.5,1.0,0.2\n');
  const energyDs = parseCsvText('n_rpm,T_Nm,V_bus,I_bus,P_in_kWh\n1000,0.1,13.5,1.0,0.2\n');
  const energyNorm = normalizeDynoDataset(energyDs, autoMapColumns(energyDs.headers), 'Nm', '0-1', { requireTorque: true });
  assert.equal(energyNorm.points.length, 0);
  assert.ok(energyNorm.warnings.some((w) => w.includes('kWh')));
  const hpNorm = normalizeDynoDataset(hpDs, autoMapColumns(hpDs.headers), 'Nm', '0-1', { requireTorque: true });
  assert.equal(hpNorm.points.length, 0);
  assert.ok(hpNorm.warnings.some((w) => w.includes('非标准功率单位') && w.includes('hp')));
});

test('Ke auto-calibration refuses to substitute loaded points when no-load evidence is insufficient', () => {
  const baseKe = DEMO_MOTOR_PARAMS.kePrime;
  const baseN0 = DEMO_MOTOR_PARAMS.n0Rpm;
  const sparseOpenLoop = [
    { nRpm: 500, tNm: 0, vBusV: 5.0, iBusA: 0.08, pInW: 0.4, pOutW: 0, etaMeas: Number.NaN },
    { nRpm: 900, tNm: 0.40, vBusV: 9.0, iBusA: 2.1, pInW: 18.9, pOutW: 37.7, etaMeas: 0.7 },
    { nRpm: 1200, tNm: 0.55, vBusV: 12.0, iBusA: 3.2, pInW: 38.4, pOutW: 69.1, etaMeas: 0.72 },
  ];
  const report = runStepwiseCalibration(sparseOpenLoop, [], DEMO_MOTOR_PARAMS, {
    keSource: 'open_loop_auto',
    manualN0Rpm: 1450,
    manualVTestV: 13.5,
    manualKv: 107.4,
    rsFitMode: 'locked',
  });
  assert.equal(report.kePrime, baseKe, 'loaded voltage includes Rs/Lq drops and must not be treated as back-EMF');
  assert.equal(report.n0Rpm, baseN0, 'highest loaded speed is not a measured no-load speed');
  assert.ok(report.warnings.some((w) => w.includes('没有使用带载点替代空载反电势')));
  assert.ok(report.fitNotes.some((n) => n.includes('拒绝用带载 Vbus/RPM 伪估 Ke')));
});

test('P0(n) fit requires multiple distinct speed levels and warns instead of accepting an underdetermined fit', () => {
  const sparseOpenLoop = [
    { nRpm: 1000, tNm: 0, vBusV: 9.2, iBusA: 0.20, pInW: 1.84, pOutW: 0, etaMeas: Number.NaN },
    { nRpm: 1010, tNm: 0, vBusV: 9.3, iBusA: 0.21, pInW: 1.953, pOutW: 0, etaMeas: Number.NaN },
  ];
  const report = runStepwiseCalibration(sparseOpenLoop, [], DEMO_MOTOR_PARAMS, {
    keSource: 'manual_kv',
    manualN0Rpm: 1450,
    manualVTestV: 13.5,
    manualKv: 107.4,
    rsFitMode: 'locked',
  });
  assert.equal(report.p0A, DEMO_MOTOR_PARAMS.p0A);
  assert.equal(report.p0B, DEMO_MOTOR_PARAMS.p0B);
  assert.ok(report.warnings.some((w) => w.includes('P0(n)') && w.includes('参数不可充分辨识')));
  assert.ok(report.fitNotes.some((n) => n.includes('Step 2 参数不可辨识')));
});

test('P0(n) fit rejects narrow, ill-conditioned speed bands even with three distinct RPM levels', () => {
  const narrowBand = [
    { nRpm: 1000, tNm: 0, vBusV: 13.5, iBusA: 0.08, pInW: 1.08, pOutW: 0, etaMeas: Number.NaN },
    { nRpm: 1045, tNm: 0, vBusV: 13.5, iBusA: 0.085, pInW: 1.1475, pOutW: 0, etaMeas: Number.NaN },
    { nRpm: 1090, tNm: 0, vBusV: 13.5, iBusA: 0.09, pInW: 1.215, pOutW: 0, etaMeas: Number.NaN },
  ];
  const report = runStepwiseCalibration(narrowBand, [], DEMO_MOTOR_PARAMS, {
    keSource: 'manual_kv', manualN0Rpm: 1450, manualVTestV: 13.5, manualKv: 107.4, rsFitMode: 'locked',
  });
  assert.equal(report.p0A, DEMO_MOTOR_PARAMS.p0A);
  assert.equal(report.p0B, DEMO_MOTOR_PARAMS.p0B);
  const identWarning = report.warnings.find((w) => w.includes('参数不可充分辨识')) || '';
  assert.ok(identWarning.includes('条件数') && identWarning.includes('≤40'));
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

test('FOC solver: stable low-power roots, eta=1.0 neutral mode and strict physical parameter contract', () => {
  const idealParams = {
    ...DEMO_MOTOR_PARAMS,
    etaInv: 1,
    iIdleA: 0,
    iDeadbandA: 0,
    rLineOhm: 0,
  };
  validateMotorParams(idealParams);

  // At this power level, adding the discriminant increment to Eq^2 is below
  // or near one floating-point ULP. The rationalized root must still preserve
  // the small non-zero Iq instead of rounding it to zero.
  const tiny = solveSinglePoint(13.5, 1e-16, 1000, idealParams);
  assert.equal(tiny.mode, 'motoring');
  assert.ok(tiny.iqA > 0, `near-zero load current was lost: ${tiny.iqA}`);
  const tinyFwd = forwardVerifyPoint(tiny.iqA, 1000, 13.5, idealParams);
  assert.ok(Math.abs(tinyFwd.iBusEstA - 1e-16) < 1e-29, `stable bus root mismatch: ${tinyFwd.iBusEstA}`);

  const ordinary = solveSinglePoint(13.5, 1.25, 800, idealParams);
  assert.equal(ordinary.mode, 'motoring');
  const ordinaryFwd = forwardVerifyPoint(ordinary.iqA, 800, 13.5, idealParams);
  assert.ok(Math.abs(ordinaryFwd.iBusEstA - 1.25) < 1e-10);

  assert.throws(
    () => solveSinglePoint(13.5, 1, 1000, { ...DEMO_MOTOR_PARAMS, etaInv: 1.01 }),
    /η_inv.*0 < η_inv ≤ 1/
  );
  // Efficiency is physically bounded above by 1, but 10% was an arbitrary software floor.
  validateMotorParams({ ...DEMO_MOTOR_PARAMS, etaInv: 0.05 });
  assert.throws(() => validateMotorParams({ ...DEMO_MOTOR_PARAMS, etaInv: 0 }), /0 < η_inv ≤ 1/);
  // Switching frequency is only required when a non-zero deadtime correction is active.
  validateMotorParams({ ...DEMO_MOTOR_PARAMS, tDeadNs: 0, fSwKhz: 0 });
  assert.throws(
    () => validateMotorParams({ ...DEMO_MOTOR_PARAMS, tDeadNs: 500, fSwKhz: 0 }),
    /t_dead > 0.*f_sw.*大于 0/
  );
  assert.throws(
    () => solveSinglePoint(13.5, 1, 1000, { ...DEMO_MOTOR_PARAMS, rLineOhm: -0.01 }),
    /不能为负数/
  );
  assert.equal(solveSinglePoint(13.5, Number.NaN, 1000, DEMO_MOTOR_PARAMS).mode, 'invalid_bus');
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
  assert.ok(synthWithDuty.csvContent.includes('WAVEFORM_PROVENANCE=MODEL_SYNTHETIC_STEADY_STATE'));
  assert.ok(synthWithDuty.csvContent.includes('Time,Ia,Ib,Ic,Vbus,Duty_A,Duty_B,Duty_C'));
  assert.equal(synthWithDuty.summary.dataProvenance, 'synthetic_steady_state');
  assert.equal(synthWithDuty.summary.waveformModel, 'ideal_sinusoidal_current_average_duty');
  const reimportSynth = parseCsvText(synthWithDuty.csvContent);
  assert.ok(reimportSynth.headers.includes('Time'));
  assert.ok(reimportSynth.headers.includes('Duty_A'));
  // The parser should skip provenance comments instead of mistaking them for header rows.
  assert.ok(reimportSynth.fileName !== '');
  const handoffDuty = buildThermalHandoffFromSixMos(synthWithDuty, DEMO_MOTOR_PARAMS, 1000, 25)!;
  assert.equal(handoffDuty.modulation, 'DPWM1');
  assert.equal(handoffDuty.steadyOperatingPoint.mode, 'rotating');
  assert.ok(Math.abs(handoffDuty.steadyOperatingPoint.iqPeakA - synthWithDuty.summary.iqPeakA) < 1e-9);
  assert.equal(handoffDuty.steadyOperatingPoint.idPeakA, 0);
  assert.ok(Math.abs(handoffDuty.steadyOperatingPoint.electricalFrequencyHz - synthWithDuty.summary.feHz) < 1e-9);
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
  const stallHandoff = buildThermalHandoffFromSixMos(stallSynth, DEMO_MOTOR_PARAMS, 0, 25)!;
  assert.equal(stallHandoff.steadyOperatingPoint.mode, 'locked_rotor');
  assert.equal(stallHandoff.steadyOperatingPoint.electricalFrequencyHz, 0);
  assert.equal(stallHandoff.steadyOperatingPoint.electricalAngleDeg, 90);

  const scopeTab = buildOscilloscopeTabFromSixMos(synth, 1000)!;
  assert.ok(scopeTab);
  assert.equal(scopeTab.drawOrder.length, 4);
  assert.equal(scopeTab.channels['ch_ia'].unit, 'A');
  assert.equal(scopeTab.channels['ch_vbus'].unit, 'V');
  assert.equal(scopeTab.channels['ch_ia'].metadata?.dataProvenance, 'synthetic_steady_state');

  const handoff = buildThermalHandoffFromSixMos(synth, DEMO_MOTOR_PARAMS, 1000, 25)!;
  assert.ok(handoff);
  assert.ok(Math.abs(handoff.modDepthM - synth.summary.mCmd) < 1e-3);
  assert.ok(Math.abs(handoff.pfAngleDeg - synth.summary.phiCmdDeg) < 0.05);
  assert.equal(handoff.steadyOperatingPoint.mode, 'rotating');
  assert.equal(handoff.steadyOperatingPoint.idPeakA, 0);
  assert.ok(Math.abs(handoff.steadyOperatingPoint.iqPeakA - synth.pointResult.iqA) < 1e-9);

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
  assert.equal(isMonotonicTimestamps([0, 0.01, 0.01]), false);
  assert.throws(() => movingAverageFilter([1, 2, 3], [0, 0.01, 0.01], 10), /严格递增/);
  assert.throws(() => processRuntimeLog([
    { timeS: 0, vMeasV: 13.5, iBusA: 1, nRpm: 1000 },
    { timeS: 0.001, vMeasV: 13.5, iBusA: 1, nRpm: 1000 },
    { timeS: 0.001, vMeasV: 13.5, iBusA: 1, nRpm: 1000 },
  ], 10, DEMO_MOTOR_PARAMS), /重复或倒退/);
  assert.throws(() => processRuntimeLog([
    { timeS: 0, vMeasV: 13.5, iBusA: 1, nRpm: 1000 },
    { timeS: 0.001, vMeasV: 13.5, iBusA: Number.NaN, nRpm: 1000 },
  ], 10, DEMO_MOTOR_PARAMS), /NaN\/Inf/);
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

  // #12 / FD-01: Non-uniform trapezoidal filter without gap vs gap isolation (no cross-gap bridging!)
  // A: Continuous non-uniform sampling without gap (max dt = 0.0003 <= 3.5 * 0.0001): trapezoidal resists burst skew
  const tsContJitter = [0, 0.0001, 0.0002, 0.0003, 0.0004, 0.0005, 0.0006, 0.0007, 0.0008, 0.0009, 0.0012];
  const vsContJitter = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 0];
  const trapCont = movingAverageFilter(vsContJitter, tsContJitter, 100);
  // Exact integral: 100*0.0009 + 0.5*(100+0)*(0.0012-0.0009) = 0.09 + 0.015 = 0.105 over 0.0012s => 87.5 (not arithmetic 90.9)
  assert.ok(Math.abs(trapCont[5] - 87.5) < 0.05, `Expected continuous trapezoidal mean 87.5, got ${trapCont[5]}`);

  // B: True 491x gap at [0.0009 -> 0.05] cuts window at gap boundary; pre-gap side stays 100 and isolated post-gap point becomes NaN
  const tsBurstGap = [0, 0.0001, 0.0002, 0.0003, 0.0004, 0.0005, 0.0006, 0.0007, 0.0008, 0.0009, 0.05];
  const vsBurstGap = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 0];
  const trapGap = movingAverageFilterWithDiagnostics(vsBurstGap, tsBurstGap, 100);
  assert.equal(trapGap.gapCount, 1);
  assert.ok(Math.abs(trapGap.values[5] - 100) < 1e-9, `Expected pre-gap mean 100 without bridging, got ${trapGap.values[5]}`);
  assert.ok(Number.isNaN(trapGap.values[10]), `Expected gap-isolated singleton to be NaN, got ${trapGap.values[10]}`);

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
  assert.equal(okReport.status, 'warn');
  assert.ok(okReport.warnings.some((w) => w.includes('m_norm') && w.includes('估计')));

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

test('FOC DynoLab audit: out-of-range eta quarantine, holdout CV, openLoopModDepth, SI Vbus & hot Rds25 handoff', () => {
  // 1. Out-of-range eta=73.2 in 0-1 mode is quarantined to NaN rather than clamped to 1.0
  const badEtaDs = parseCsvText('n_rpm,T_Nm,V_bus,I_bus,eta\n1000,0.1,13.5,1.06,73.2\n');
  const badEtaRes = normalizeDynoDataset(badEtaDs, autoMapColumns(badEtaDs.headers), 'Nm', '0-1', { requireTorque: true });
  assert.equal(badEtaRes.points.length, 1);
  assert.ok(Number.isNaN(badEtaRes.points[0].etaMeas));
  assert.ok(badEtaRes.warnings.some((w) => w.includes('隔离标记为 NaN')));
  const borderlineEta = parseCsvText('n_rpm,T_Nm,V_bus,I_bus,eta\n1000,0.1,13.5,1.06,1.02\n');
  const borderlineEtaRes = normalizeDynoDataset(borderlineEta, autoMapColumns(borderlineEta.headers), 'Nm', '0-1', { requireTorque: true });
  assert.ok(Number.isNaN(borderlineEtaRes.points[0].etaMeas), 'efficiency >100% must be quarantined, never clamped to 100%');

  // 2. Stepwise calibration produces independent train-only holdout metrics.
  const ol = buildDemoOpenLoopDataset();
  const cl = buildDemoClosedLoopDataset();
  const olPts = normalizeDynoDataset(ol, autoMapColumns(ol.headers), 'Nm', '0-1', { requireTorque: false }).points;
  const clPts = normalizeDynoDataset(cl, autoMapColumns(cl.headers), 'Nm', '0-1', { requireTorque: true }).points;
  const fullReport = runStepwiseCalibration(olPts, clPts, DEMO_MOTOR_PARAMS, {
    keSource: 'open_loop_auto',
    manualN0Rpm: 1450,
    manualVTestV: 13.5,
    manualKv: 107.4,
    rsFitMode: 'locked',
    openLoopModDepth: 1.0,
  });
  assert.ok(fullReport.validationMetrics && fullReport.validationMetrics.holdoutCount >= 2);
  assert.equal(fullReport.validationMetrics?.fitSource, 'train_only');
  assert.ok((fullReport.validationMetrics?.trainCount || 0) > (fullReport.validationMetrics?.holdoutCount || 0));
  assert.ok(fullReport.operatingEnvelope && fullReport.operatingEnvelope.maxRpm >= 1000);
  assert.ok(fullReport.paramSensitivity && Number.isFinite(fullReport.paramSensitivity.rsPlus10PctDeltaMaeNm));

  const halfModReport = runStepwiseCalibration(olPts, clPts, DEMO_MOTOR_PARAMS, {
    keSource: 'open_loop_auto',
    manualN0Rpm: 1450,
    manualVTestV: 13.5,
    manualKv: 107.4,
    rsFitMode: 'locked',
    openLoopModDepth: 0.8,
  });
  assert.ok(Math.abs(halfModReport.kePrime - fullReport.kePrime * 0.8) < 1e-6);
  const overModReport = runStepwiseCalibration(olPts, clPts, DEMO_MOTOR_PARAMS, {
    keSource: 'open_loop_auto', manualN0Rpm: 1450, manualVTestV: 13.5, manualKv: 107.4,
    rsFitMode: 'locked', openLoopModDepth: 1.1547,
  });
  assert.ok(Math.abs(overModReport.kePrime - fullReport.kePrime) < 1e-9, 'm_norm above 1.0 must not inflate Ke by using the m ceiling');
  assert.ok(overModReport.warnings.some((w) => w.includes('m 与归一化 m_norm')));

  // 3. extractRuntimeLogWithAudit converts mV Vbus to V and emits timebase warning when out-of-sync
  const synth = synthesizeSixMosWaveform(
    { vMeasV: 13.5, iBusA: 1.06, nRpm: 1000, tAmbC: 25, fsHz: 10000, durationS: 0.05 },
    DEMO_MOTOR_PARAMS
  );
  const tab = buildOscilloscopeTabFromSixMos(synth, 1000)!;
  const vbusMv = {
    ...tab.channels['ch_vbus'],
    unit: 'mV',
    t: new Float64Array([0, 0.05]),
    v: new Float32Array([13500, 13500]),
  };
  const audit = extractRuntimeLogWithAudit({
    vbusCh: vbusMv,
    vbusConstV: 13.5,
    ibusCh: tab.channels['ch_ia'],
    currentUnit: 'A',
    speedCh: null,
    speedConstRpm: 1000,
    speedUnit: 'rpm',
    polePairs: 7,
  });
  assert.equal(audit.vbusScaleV, 1e-3);
  assert.ok(Math.abs(audit.rows[0].vMeasV - 13.5) < 1e-3);
  assert.ok(audit.warnings.some((w) => w.includes('时间轴不完全一致')));

  // 4. buildThermalHandoffFromSixMos converts hot Rds(100°C) back to Rds25 accurately
  const handoffHot = buildThermalHandoffFromSixMos(synth, DEMO_MOTOR_PARAMS, 1000, 25, { rdsRefTempC: 100 })!;
  const expectedRds25 = DEMO_MOTOR_PARAMS.rdsOnMOhm / (1 + 0.0045 * (100 - 25));
  assert.ok(Math.abs(handoffHot.rdsOnMOhm - expectedRds25) < 0.02);
  assert.ok(handoffHot.handoffNote?.includes('折算为 Rds25'));

  // 5. Python bundle parity includes Round-2 dyno calibrator & exporter hardening
  const dynoCalPy = PYTHON_BUNDLE_FILES.find((f) => f.name === 'dyno_calibrator.py')?.content || '';
  const exporterPy = PYTHON_BUNDLE_FILES.find((f) => f.name === 'thermal_exporter.py')?.content || '';
  const appPy = PYTHON_BUNDLE_FILES.find((f) => f.name === 'app.py')?.content || '';
  assert.ok(dynoCalPy.includes('quarantine_mask'));
  assert.ok(dynoCalPy.includes('validation_metrics'));
  assert.ok(dynoCalPy.includes('def _fit_nonnegative_linear_p0('));
  assert.ok(dynoCalPy.includes('\"fit_source\": \"train_only\"'));
  assert.ok(dynoCalPy.includes('\"rs_eff_override\": best_rs'), 'Python final Rs override must match browser even in locked mode');
  assert.ok(dynoCalPy.includes('\"MAE_T\": float(\"nan\")'), 'empty Python calibration must not present zero-error metrics');
  assert.ok(dynoCalPy.includes('\"status\": \"failed\"'), 'empty Python closed-loop data must fail closed like browser calibration');
  assert.ok(!dynoCalPy.includes('least_squares'), 'Python P0/beta/Rs fitting must use the same deterministic solver as the browser');
  assert.ok(dynoCalPy.includes('valid_holdout_count'));
  assert.ok(dynoCalPy.includes('P0 is sourced only from independent open-loop data'));
  assert.ok(dynoCalPy.includes('if pin_bad or pout_bad:'));
  assert.ok(dynoCalPy.includes('不能默认按 W 解释'));
  assert.ok(dynoCalPy.includes('never hide it by falling back to V_bus * I_bus'));
  assert.ok(dynoCalPy.includes('if abs(float(row["n_rpm"])) <= 10:'));
  assert.ok(dynoCalPy.includes('p0_n.append(abs(float(row["n_rpm"])))'));
  assert.ok(dynoCalPy.includes('p0_pairs = [(abs(float(n)), float(p0))'));
  assert.ok(dynoCalPy.includes('operating_envelope'));
  assert.ok(dynoCalPy.includes('param_sensitivity'));
  assert.ok(dynoCalPy.includes('open_loop_mod_depth'));
  assert.ok(dynoCalPy.includes('mod_scale = min(1.0, max(0.1, requested_mod_scale))'));
  assert.ok(dynoCalPy.includes('no_load_pts = valid_ol['));
  assert.ok(dynoCalPy.includes('if len(ke_candidates) >= 2:'));
  assert.ok(dynoCalPy.includes('没有使用带载点替代空载反电势'));
  assert.ok(dynoCalPy.includes('p0_speed_levels = sorted({int(round(n)) for n, _ in p0_pairs})'));
  assert.ok(dynoCalPy.includes('p0_identifiable = (len(p0_pairs) >= 3 and len(p0_speed_levels) >= 3'));
  assert.ok(dynoCalPy.includes('p0_design_condition_number <= 40.0'));
  assert.ok(dynoCalPy.includes('归一化设计矩阵条件数'));
  assert.ok(dynoCalPy.includes('explicit_power_suffixes'));
  assert.ok(dynoCalPy.includes('P_in_hp must not'));
  assert.ok(dynoCalPy.includes('horsepower'));
  assert.ok(dynoCalPy.includes('至少需要 3 个不同转速、跨度达到最高转速的 8%'));
  assert.ok(exporterPy.includes('Synthetic Waveform Notice'));
  assert.ok(exporterPy.includes('Rds(on) Note'));
  assert.ok(appPy.includes('ol_mod'));
  assert.ok(appPy.includes('线性 SVPWM 上限 1.0'));
  assert.ok(appPy.includes('20% 留出交叉验证'));
});

test('FOC DynoLab live python3 parity: motor_physics.py numerically matches TS solver across operating modes', (t) => {
  if (!PYTHON_EXECUTABLE) {
    t.skip('No python3/python interpreter available in PATH');
    return;
  }
  const motorPhysicsPy = PYTHON_BUNDLE_FILES.find((f) => f.name === 'motor_physics.py')?.content || '';
  assert.ok(motorPhysicsPy.length > 1000);

  const cases = [
    { vMeas: 13.5, iBus: 2.5, nRpm: 1000 },
    { vMeas: 13.5, iBus: -0.8, nRpm: 1200 },
    { vMeas: 13.5, iBus: 1.5, nRpm: 0 },
    { vMeas: 13.5, iBus: 0.065, nRpm: 800 },
    { vMeas: 13.5, iBus: -50.0, nRpm: 1000 },
    { vMeas: 0.05, iBus: 1.0, nRpm: 500 },
  ];

  const pyScript = `
import json, math, sys, types
# Minimal stubs so stdlib python3 executes pure motor_physics core without requiring numpy/pandas install
np_stub = types.ModuleType("numpy")
np_stub.ndarray = list
pd_stub = types.ModuleType("pandas")
pd_stub.DataFrame = dict
sys.modules["numpy"] = np_stub
sys.modules["pandas"] = pd_stub

ns = {}
exec(sys.stdin.read(), ns)
MP = ns["MotorParams"]
p = MP(
    pole_pairs=${DEMO_MOTOR_PARAMS.polePairs},
    ke_prime=${DEMO_MOTOR_PARAMS.kePrime},
    r_ll_25=${DEMO_MOTOR_PARAMS.rLL25Ohm},
    t_coil=${DEMO_MOTOR_PARAMS.tCoilC},
    l_ll_mh=${DEMO_MOTOR_PARAMS.lLLmH},
    n0_rpm=${DEMO_MOTOR_PARAMS.n0Rpm},
    beta_sat=${DEMO_MOTOR_PARAMS.betaSat},
    p0_a=${DEMO_MOTOR_PARAMS.p0A},
    p0_b=${DEMO_MOTOR_PARAMS.p0B},
    rs_eff_override=None,
    i_idle=${DEMO_MOTOR_PARAMS.iIdleA},
    eta_inv=${DEMO_MOTOR_PARAMS.etaInv},
    i_deadband=${DEMO_MOTOR_PARAMS.iDeadbandA},
    r_line=${DEMO_MOTOR_PARAMS.rLineOhm},
    rds_on_mohm=${DEMO_MOTOR_PARAMS.rdsOnMOhm},
    t_dead_ns=${DEMO_MOTOR_PARAMS.tDeadNs},
    f_sw_khz=${DEMO_MOTOR_PARAMS.fSwKhz},
    v_sd=${DEMO_MOTOR_PARAMS.vSdV},
)
cases = ${JSON.stringify(cases)}
out = []
for c in cases:
    r = ns["solve_single_point"](c["vMeas"], c["iBus"], c["nRpm"], p)
    fwd = ns["forward_verify_point"](r["iq"], c["nRpm"], c["vMeas"], p) if (r["iq"] == r["iq"]) else None
    out.append({"point": r, "fwd": fwd})
p_tiny = MP(**{**p.__dict__, "i_idle": 0.0, "eta_inv": 1.0, "i_deadband": 0.0, "r_line": 0.0})
tiny = ns["solve_single_point"](13.5, 1e-16, 1000.0, p_tiny)
tiny_fwd = ns["forward_verify_point"](tiny["iq"], 1000.0, 13.5, p_tiny)
def sanitize(obj):
    if isinstance(obj, float):
        return None if not math.isfinite(obj) else obj
    if isinstance(obj, dict):
        return {k: sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sanitize(v) for v in obj]
    return obj
print(json.dumps(sanitize({
    "ke_kv": ns["calc_ke_from_kv"](107.4),
    "ke_n0": ns["calc_ke_from_no_load"](13.5, 1450.0),
    "vq_cmd": ns["calc_vq_cmd"](5.0, 10.0, 13.4, p),
    "phi_deg": ns["calc_phi_deg"](5.0, -0.5, 10.0),
    "results": out,
    "tiny_iq": tiny["iq"],
    "tiny_i_bus_est": tiny_fwd["i_bus_est"],
}), allow_nan=False))
`;

  const proc = spawnSync(PYTHON_EXECUTABLE, ['-c', pyScript], {
    input: motorPhysicsPy,
    encoding: 'utf8',
  });
  assert.equal(proc.status, 0, `${PYTHON_EXECUTABLE} execution failed: ${proc.stderr}`);
  const pyData = JSON.parse(proc.stdout);
  const tinyParams = { ...DEMO_MOTOR_PARAMS, iIdleA: 0, etaInv: 1, iDeadbandA: 0, rLineOhm: 0 };
  const tinyTs = solveSinglePoint(13.5, 1e-16, 1000, tinyParams);
  const tinyTsFwd = forwardVerifyPoint(tinyTs.iqA, 1000, 13.5, tinyParams);
  assert.ok(tinyTs.iqA > 0);
  assert.ok(Math.abs(pyData.tiny_iq - tinyTs.iqA) < 1e-29, `tiny Iq parity: Python=${pyData.tiny_iq}, TS=${tinyTs.iqA}`);
  assert.ok(Math.abs(pyData.tiny_i_bus_est - tinyTsFwd.iBusEstA) < 1e-29, `tiny bus current parity: Python=${pyData.tiny_i_bus_est}, TS=${tinyTsFwd.iBusEstA}`);

  assert.ok(Math.abs(pyData.ke_kv - calcKeFromKv(107.4)) < 1e-12);
  assert.ok(Math.abs(pyData.ke_n0 - calcKeFromNoLoad(13.5, 1450)) < 1e-12);
  assert.ok(Math.abs(pyData.vq_cmd - calcVqCmd(5.0, 10.0, 13.4, DEMO_MOTOR_PARAMS)) < 1e-12);
  assert.ok(Math.abs(pyData.phi_deg - calcPhiDeg(5.0, -0.5, 10.0)) < 1e-12);

  for (let idx = 0; idx < cases.length; idx++) {
    const c = cases[idx];
    const ts = solveSinglePoint(c.vMeas, c.iBus, c.nRpm, DEMO_MOTOR_PARAMS);
    const py = pyData.results[idx].point;
    assert.equal(py.mode, ts.mode, `Mode mismatch on case ${idx}`);
    assert.equal(py.alert_iq_sign_ambiguous, ts.alerts.iqSignAmbiguous);
    assert.equal(py.alert_invalid_bus, ts.alerts.invalidBus);
    assert.equal(py.alert_regen_limit, ts.alerts.regenLimit);
    if (Number.isFinite(ts.iqA)) {
      assert.ok(Math.abs(py.iq - ts.iqA) < 1e-9, `iq mismatch on case ${idx}: ${py.iq} vs ${ts.iqA}`);
      assert.ok(Math.abs(py.t_est - ts.tEstNm) < 1e-9);
      assert.ok(Math.abs(py.m_norm_cmd - ts.mNormCmd) < 1e-9);
      assert.ok(Math.abs(py.phi_deg - ts.phiDeg) < 1e-9);
      const tsFwd = forwardVerifyPoint(ts.iqA, c.nRpm, c.vMeas, DEMO_MOTOR_PARAMS);
      const pyFwd = pyData.results[idx].fwd;
      assert.ok(Math.abs(pyFwd.i_bus_est - tsFwd.iBusEstA) < 1e-9);
      assert.ok(Math.abs(pyFwd.t_est - tsFwd.tEstNm) < 1e-9);
    }
  }
});

test('FD-01 & Python bundle P1..P4: segmented gap filter, valid Python AST, width="stretch", exp_v key-only, P3/P4 markers', () => {
  // 1. Uniform sampling: exact smoothing
  const tUnif = Array.from({ length: 21 }, (_, i) => i * 0.001);
  const vUnif = tUnif.map((_, i) => (i < 10 ? 2 : 2));
  const diagUnif = movingAverageFilterWithDiagnostics(vUnif, tUnif, 5);
  assert.equal(diagUnif.gapCount, 0);
  assert.equal(diagUnif.segmentCount, 1);
  assert.ok(diagUnif.values.every((x) => Math.abs(x - 2) < 1e-12));

  // 2. 10x and 50x gaps with sharp step across gap: never blurs pre-gap (1A) with post-gap (10A)
  const timesGap = [
    0.0, 0.001, 0.002, 0.003, 0.004,
    0.024, 0.025, 0.026, 0.027, 0.028, // 20x gap (0.020s vs 0.001s)
    0.088, 0.089, 0.090, 0.091,        // 60x gap (0.060s vs 0.001s)
    0.150,                             // isolated singleton after 59x gap
  ];
  const valsGap = [
    1, 1, 1, 1, 1,
    10, 10, 10, 10, 10,
    20, 20, 20, 20,
    99,
  ];
  const segDiag = partitionContinuousTimeSegments(timesGap);
  assert.equal(segDiag.gapIndices.length, 3);
  assert.equal(segDiag.segments.length, 4);

  const fGap = movingAverageFilterWithDiagnostics(valsGap, timesGap, 20);
  assert.equal(fGap.gapCount, 3);
  assert.equal(fGap.segmentCount, 4);
  for (let i = 0; i <= 4; i++) assert.ok(Math.abs(fGap.values[i] - 1) < 1e-12, `seg0 idx=${i}`);
  for (let i = 5; i <= 9; i++) assert.ok(Math.abs(fGap.values[i] - 10) < 1e-12, `seg1 idx=${i}`);
  for (let i = 10; i <= 13; i++) assert.ok(Math.abs(fGap.values[i] - 20) < 1e-12, `seg2 idx=${i}`);
  assert.ok(Number.isNaN(fGap.values[14]), 'Isolated point separated by gap must return NaN');
  assert.deepEqual(fGap.isolatedIndices, [14]);

  const logAudit = processRuntimeLogWithAudit(
    timesGap.map((t, i) => ({ timeS: t, vMeasV: 13.5, iBusA: valsGap[i], nRpm: 1000 })),
    20,
    DEMO_MOTOR_PARAMS
  );
  assert.equal(logAudit.filterDiagnostics.gapCount, 3);
  assert.equal(logAudit.rows[14].filterValid, false);
  assert.equal(logAudit.rows[14].result.alerts.invalidBus, true);


  // A centered filter window needs at least half-window temporal support at a clipped segment edge.
  const shortTimes = [0, 0.001, 0.002, 0.003];
  const shortCoverage = processRuntimeLogWithAudit(
    shortTimes.map((timeS) => ({ timeS, vMeasV: 13.5, iBusA: 4, nRpm: 800 })),
    100,
    DEMO_MOTOR_PARAMS
  );
  assert.deepEqual(shortCoverage.filterDiagnostics.lowCoverageIndices, [0, 1, 2, 3]);
  assert.ok(shortCoverage.rows.every((row) => row.filterValid === false));
  assert.ok(shortCoverage.rows.every((row) => row.filterQuality === 'LOW_COVERAGE'));
  assert.ok(shortCoverage.rows.every((row) => Number.isNaN(row.iBusFilteredA)));

  // A segment that supplies at least half of the centered filter window remains usable.
  const adequateTimes = Array.from({ length: 71 }, (_, i) => i * 0.001);
  const adequateCoverage = processRuntimeLogWithAudit(
    adequateTimes.map((timeS) => ({ timeS, vMeasV: 13.5, iBusA: 4, nRpm: 800 })),
    100,
    DEMO_MOTOR_PARAMS
  );
  assert.equal(adequateCoverage.filterDiagnostics.lowCoverageIndices.length, 0);
  assert.ok(adequateCoverage.rows.every((row) => row.filterValid));

  // A filter window narrower than the sample interval has no temporal support;
  // JS must match Python and mark these singleton window means LOW_COVERAGE.
  const subSampleWindow = movingAverageFilterWithDiagnostics([1, 2, 3], [0, 0.001, 0.002], 0.1);
  assert.deepEqual(subSampleWindow.lowCoverageIndices, [0, 1, 2]);

  // 3. Python bundle static AST compile + P1..P4 & FD-01 parity verification
  const appPy = PYTHON_BUNDLE_FILES.find((f) => f.name === 'app.py')?.content || '';
  const motorPy = PYTHON_BUNDLE_FILES.find((f) => f.name === 'motor_physics.py')?.content || '';
  const dynoPy = PYTHON_BUNDLE_FILES.find((f) => f.name === 'dyno_calibrator.py')?.content || '';
  const thermPy = PYTHON_BUNDLE_FILES.find((f) => f.name === 'thermal_exporter.py')?.content || '';
  const dynPy = PYTHON_BUNDLE_FILES.find((f) => f.name === 'dynamic_pmsm.py')?.content || '';
  assert.ok(dynPy.length > 500, 'dynamic_pmsm.py must be present in PYTHON_BUNDLE_FILES');

  // P1: Zero use_container_width remaining; >= 4 width="stretch" calls (Tab1 + Tab2 + Tab3 + Tab4)
  assert.equal(appPy.includes('use_container_width'), false);
  assert.ok((appPy.match(/width="stretch"/g) || []).length >= 4);
  // P2: exp_v, exp_i, exp_n must NOT pass positional default when key= is bound to session_state
  assert.equal(appPy.includes('st.session_state["exp_v"]), format'), false);
  assert.ok(appPy.includes('min_value=-20.0, max_value=200.0, format="%.2f", key="exp_v"'));
  // P3: plot columns & explicit red marker warning in app.py
  assert.ok(motorPy.includes('res["solution_valid"] = sol_valid'));
  assert.ok(motorPy.includes('res["is_held_prev_iq"]'));
  assert.ok(motorPy.includes('low_coverage_indices'));
  assert.ok(motorPy.includes('low_coverage_indices.append(i)'));
  assert.ok(motorPy.includes('res["filter_quality"] = filter_quality'));
  assert.ok(motorPy.includes('low_coverage_count'));
  assert.ok(appPy.includes('该时刻无实数解（已标红点，数值未虚构）'));
  // P4: nearest exterior fill + z_extrap_mask + explicit warning in app.py
  assert.ok(dynoPy.includes('method="nearest"'));
  assert.ok(dynoPy.includes('"z_extrap_mask": z_extrap_mask'));
  assert.ok(appPy.includes('外推区不可信'));

  // Compile all 5 Python files & verify Python partition_continuous_time_segments parity via python3
  const pyCheck = `
import json, math, sys, types
np_stub = types.ModuleType("numpy")
np_stub.ndarray = list
def _diff(a):
    return [a[i] - a[i - 1] for i in range(1, len(a))]
def _isfinite(a):
    return [math.isfinite(x) for x in a]
class _FakeArr(list):
    def __and__(self, other):
        return _FakeArr([x and y for x, y in zip(self, other)])
    def __gt__(self, val):
        return _FakeArr([x > val for x in self])
class _DiffArr(_FakeArr):
    def __getitem__(self, item):
        if isinstance(item, list):
            return [x for x, keep in zip(self, item) if keep]
        return super().__getitem__(item)
np_stub.diff = lambda a: _DiffArr(_diff(a))
np_stub.isfinite = lambda a: _FakeArr(_isfinite(a))
def _median(a):
    s = sorted(a)
    m = len(s) // 2
    return s[m] if len(s) % 2 == 1 else 0.5 * (s[m - 1] + s[m])
np_stub.median = _median
pd_stub = types.ModuleType("pandas")
pd_stub.DataFrame = dict
sys.modules["numpy"] = np_stub
sys.modules["pandas"] = pd_stub

files = json.loads(sys.stdin.read())
for fname, code in files.items():
    compile(code, fname, "exec")

ns = {}
exec(files["motor_physics.py"], ns)
segs, gaps, med_dt, thresh = ns["partition_continuous_time_segments"](${JSON.stringify(timesGap)})
print(json.dumps({"segs": [list(s) for s in segs], "gaps": gaps, "med_dt": med_dt}))
`;
  if (PYTHON_EXECUTABLE) {
    const proc = spawnSync(PYTHON_EXECUTABLE, ['-c', pyCheck], {
      input: JSON.stringify({
        'motor_physics.py': motorPy,
        'dyno_calibrator.py': dynoPy,
        'thermal_exporter.py': thermPy,
        'dynamic_pmsm.py': dynPy,
        'app.py': appPy,
      }),
      encoding: 'utf8',
    });
    assert.equal(proc.status, 0, `Python AST/parity check failed: ${proc.stderr}`);
    const pyRes = JSON.parse(proc.stdout);
    assert.deepEqual(pyRes.gaps, segDiag.gapIndices);
    assert.deepEqual(
      pyRes.segs,
      segDiag.segments.map((s) => [s.startIdx, s.endIdx])
    );
  }
});

test('FD-02: normalized Jacobian SVD, 95% CI, correlation matrix, and rank-deficient fallback retain baseline', () => {
  const olDs = buildDemoOpenLoopDataset();
  const clDs = buildDemoClosedLoopDataset();
  const olMap = autoMapColumns(olDs.headers);
  const clMap = autoMapColumns(clDs.headers);
  const olPts = normalizeDynoDataset(olDs, olMap, 'Nm', '0-1', { requireTorque: false }).points;
  const clPts = normalizeDynoDataset(clDs, clMap, 'Nm', '0-1', { requireTorque: true }).points;

  // 1a) Rich multi-speed / multi-torque dataset in locked mode -> IDENTIFIABLE with finite 95% CIs on betaSat & P0
  const lockedReport = runStepwiseCalibration(olPts, clPts, DEMO_MOTOR_PARAMS, {
    keSource: 'open_loop_auto',
    manualN0Rpm: 1450,
    manualVTestV: 13.5,
    manualKv: 107.4,
    rsFitMode: 'locked',
  });
  const lockedId = lockedReport.identifiabilityReport;
  assert.ok(lockedId, 'identifiabilityReport must be attached');
  assert.equal(lockedId.overallStatus, 'IDENTIFIABLE');
  const lqStatus = lockedId.parameters.find((entry) => entry.symbol === 'Lq');
  assert.ok(lqStatus, 'Lq must be visible in calibration provenance report');
  assert.equal(lqStatus.status, 'FIXED');
  assert.match(lqStatus.reason, /未独立辨识/);
  assert.equal(lockedId.baselineRetained, false);
  assert.equal(lockedId.numericalRank, 1);
  assert.equal(lockedId.fullRank, 1);
  for (const sym of ['p0A', 'p0B', 'betaSat']) {
    const entry = lockedId.parameters.find((p) => p.symbol === sym);
    assert.ok(entry, `Missing ${sym}`);
    assert.ok(Number.isFinite(entry.stdError) && entry.stdError > 0, `${sym} SE must be finite > 0`);
    assert.ok(entry.ci95Low < entry.value && entry.value < entry.ci95High, `${sym} value must sit inside 95% CI`);
  }

  // 1b) In bounded_15pct mode on single-Vbus demo data, SVD captures true physical (betaSat, rsEff) collinearity (|r| >= 0.90)
  const boundedReport = runStepwiseCalibration(olPts, clPts, DEMO_MOTOR_PARAMS, {
    keSource: 'open_loop_auto',
    manualN0Rpm: 1450,
    manualVTestV: 13.5,
    manualKv: 107.4,
    rsFitMode: 'bounded_15pct',
  });
  const idRep = boundedReport.identifiabilityReport;
  assert.ok(idRep, 'identifiabilityReport must be attached');
  assert.equal(idRep.overallStatus, 'WEAKLY_IDENTIFIABLE');
  assert.equal(idRep.baselineRetained, false);
  assert.equal(idRep.numericalRank, 2);
  assert.equal(idRep.fullRank, 2);
  assert.ok(Number.isFinite(idRep.conditionNumber) && idRep.conditionNumber < 40, `kappa=${idRep.conditionNumber}`);
  assert.ok(idRep.dof > 5);
  assert.equal(idRep.correlationMatrix.matrix.length, 2);
  assert.ok(Math.abs(idRep.correlationMatrix.matrix[0][0] - 1) < 1e-9);
  assert.ok(Math.abs(idRep.correlationMatrix.matrix[0][1] - idRep.correlationMatrix.matrix[1][0]) < 1e-9);
  assert.equal(idRep.highCollinearityPairs.length, 1);
  assert.ok(Math.abs(idRep.highCollinearityPairs[0].correlation) >= 0.9);
  for (const sym of ['p0A', 'p0B', 'betaSat', 'rsEff']) {
    const p = idRep.parameters.find((item) => item.symbol === sym);
    assert.ok(p, `Missing ${sym}`);
    assert.ok(Number.isFinite(p.stdError) && p.stdError > 0, `${sym} SE must be finite > 0`);
    assert.ok(p.ci95Low < p.value && p.value < p.ci95High, `${sym} value must sit inside 95% CI`);
  }

  // 2) Rank-deficient constant operating point dataset -> NOT_IDENTIFIABLE & retains baseline params
  const baselineInit = { ...DEMO_MOTOR_PARAMS, betaSat: 0.0088 };
  const expectedRsAnchor = calcRsAnchorOhm(baselineInit.rLL25Ohm, baselineInit.tCoilC);
  const degenCl = Array.from({ length: 8 }, () => ({
    nRpm: 1000,
    tNm: 0.12,
    vBusV: 13.5,
    iBusA: 1.5,
    pInW: 20.25,
    pOutW: 12.56637,
    etaMeas: 12.56637 / 20.25,
  }));
  const degenReport = runStepwiseCalibration(olPts, degenCl, baselineInit, {
    keSource: 'open_loop_auto',
    manualN0Rpm: 1450,
    manualVTestV: 13.5,
    manualKv: 107.4,
    rsFitMode: 'bounded_15pct',
  });
  assert.ok(degenReport.identifiabilityReport);
  assert.equal(degenReport.identifiabilityReport.overallStatus, 'NOT_IDENTIFIABLE');
  assert.equal(degenReport.identifiabilityReport.baselineRetained, true);
  assert.equal(degenReport.status, 'warn');
  assert.ok(Math.abs(degenReport.betaSat - baselineInit.betaSat) < 1e-12);
  assert.ok(Math.abs(degenReport.rsEffOhm - expectedRsAnchor) < 1e-12);

  // 3) Dynamic rotordynamics (J, B, Kt) identifiability: rich excitation vs constant speed (dOmega/dt = 0)
  const jTrue = 1.8e-4;
  const bTrue = 2.4e-4;
  const ktTrue = 0.085;
  const richDynSamples = Array.from({ length: 40 }, (_, k) => {
    const omegaM = 300 + 240 * Math.sin(k * 0.31) + 90 * Math.cos(k * 0.77);
    const dOmegaDt = 1400 * Math.cos(k * 0.43) - 600 * Math.sin(k * 0.91);
    const iqA = 0.8 + 2.5 * Math.sin(k * 0.25) + 0.9 * Math.cos(k * 0.63);
    const tLoadNm = ktTrue * iqA - jTrue * dOmegaDt - bTrue * omegaM + (k % 2 === 0 ? 1e-5 : -1e-5);
    return { omegaM, dOmegaDt, iqA, tLoadNm };
  });
  const dynRichRes = analyzeDynamicIdentifiability(richDynSamples, {
    jKgM2: 1e-4,
    bNmSPerRad: 1e-4,
    ktNmPerA: 0.05,
  });
  assert.equal(dynRichRes.overallStatus, 'IDENTIFIABLE');
  assert.equal(dynRichRes.baselineRetained, false);
  assert.equal(dynRichRes.numericalRank, 3);
  assert.ok(Math.abs(dynRichRes.jKgM2 - jTrue) < 1e-6);
  assert.ok(Math.abs(dynRichRes.bNmSPerRad - bTrue) < 1e-6);
  assert.ok(Math.abs(dynRichRes.ktNmPerA - ktTrue) < 1e-5);

  const constSpeedSamples = Array.from({ length: 20 }, (_, k) => {
    const omegaM = 100 + 20 * (k % 3);
    const dOmegaDt = 0; // zero angular acceleration -> J column strictly unobservable
    const iqA = 0.5 + 0.3 * k;
    return { omegaM, dOmegaDt, iqA, tLoadNm: ktTrue * iqA - bTrue * omegaM };
  });
  const dynZeroAccRes = analyzeDynamicIdentifiability(constSpeedSamples, {
    jKgM2: 1.5e-4,
    bNmSPerRad: 2.0e-4,
    ktNmPerA: 0.075,
  });
  assert.equal(dynZeroAccRes.overallStatus, 'NOT_IDENTIFIABLE');
  assert.equal(dynZeroAccRes.baselineRetained, true);
  assert.ok(dynZeroAccRes.numericalRank < 3);
  assert.equal(dynZeroAccRes.parameters[0].symbol, 'J');
  assert.equal(dynZeroAccRes.parameters[0].status, 'NOT_IDENTIFIABLE');
  assert.ok(Math.abs(dynZeroAccRes.jKgM2 - 1.5e-4) < 1e-12);

  // Collinear omegaM == 10 * iqA -> rank drop / baseline retention
  const collinearSamples = Array.from({ length: 20 }, (_, k) => {
    const iqA = 0.5 + 0.2 * k;
    const omegaM = 10 * iqA;
    const dOmegaDt = 50 * Math.sin(k * 0.5);
    return { omegaM, dOmegaDt, iqA, tLoadNm: ktTrue * iqA - jTrue * dOmegaDt - bTrue * omegaM };
  });
  const dynCollinearRes = analyzeDynamicIdentifiability(collinearSamples, {
    jKgM2: 1.5e-4,
    bNmSPerRad: 2.0e-4,
    ktNmPerA: 0.075,
  });
  assert.equal(dynCollinearRes.overallStatus, 'NOT_IDENTIFIABLE');
  assert.equal(dynCollinearRes.baselineRetained, true);

  // Verify Python mirror exposes normalized Jacobian SVD & identifiability_report
  const dynoPy = PYTHON_BUNDLE_FILES.find((f) => f.name === 'dyno_calibrator.py')?.content || '';
  assert.ok(dynoPy.includes('_analyze_normalized_jacobian_svd'));
  assert.ok(dynoPy.includes('analyze_dynamic_identifiability'));
  assert.ok(dynoPy.includes('"identifiability_report": identifiability_report'));
});

test('FD-03: standalone dynamic PMSM dq ODE solver (MTPA, FW, 4-quadrant, steady parity, Python match)', () => {
  // 1) IPM MTPA + high-speed field weakening + SVPWM voltage circle clamp + provenance isolation
  const { paramsPatch, config } = buildDynamicPresetScenario('ipm_mtpa_fw');
  const ipmParams = {
    polePairs: paramsPatch.polePairs ?? 4,
    rsOhm: paramsPatch.rsOhm ?? 0.045,
    ldH: paramsPatch.ldH ?? 0.18e-3,
    lqH: paramsPatch.lqH ?? 0.42e-3,
    psiFVs: paramsPatch.psiFVs ?? 0.015,
    jKgM2: paramsPatch.jKgM2 ?? 6.5e-5,
    bNmSPerRad: paramsPatch.bNmSPerRad ?? 8e-5,
    tCoulombNm: paramsPatch.tCoulombNm ?? 0.005,
    vBusV: paramsPatch.vBusV ?? 24,
    iMaxA: paramsPatch.iMaxA ?? 18,
    controlMode: 'mtpa_current_loop' as const,
  };
  const ipmRes = simulateDynamicPmsm(ipmParams, config);
  assert.equal(ipmRes.provenance, 'synthetic_assumed_uncalibrated');
  assert.ok(ipmRes.time.length > 500);
  // Negative d-axis current during motoring & field weakening for salient IPM (Ld < Lq)
  const minId = Math.min(...ipmRes.idA);
  assert.ok(minId < -0.5, `Expected MTPA/FW negative id < -0.5 A, got ${minId}`);
  const teWithId = calcDynamicPmsmTorque(-4, 10, ipmParams.polePairs, ipmParams.psiFVs, ipmParams.ldH, ipmParams.lqH);
  const teIdZero = calcDynamicPmsmTorque(0, 10, ipmParams.polePairs, ipmParams.psiFVs, ipmParams.ldH, ipmParams.lqH);
  assert.ok(teWithId > teIdZero, 'Salient IPM negative id must increase positive reluctance torque');
  // SVPWM voltage circle clamp & current clamp
  const vCircle = ipmParams.vBusV / Math.sqrt(3);
  for (let i = 0; i < ipmRes.time.length; i++) {
    assert.ok(Math.hypot(ipmRes.vdV[i], ipmRes.vqV[i]) <= vCircle + 1e-6);
    assert.ok(Math.hypot(ipmRes.idA[i], ipmRes.iqA[i]) <= ipmParams.iMaxA + 0.15);
  }
  assert.ok(ipmRes.voltageLimitHits > 0, 'High-speed 4800 RPM step must engage SVPWM voltage circle limit');

  // 2) 4-quadrant reversal preset must show positive & negative speeds plus motoring & regen modes
  const quadPreset = buildDynamicPresetScenario('four_quadrant_regen');
  const quadParams = {
    polePairs: 7,
    rsOhm: 0.395,
    ldH: 0.22e-3,
    lqH: 0.22e-3,
    psiFVs: kePrimeToPsiF(DEMO_MOTOR_PARAMS.kePrime, 7),
    jKgM2: 1.2e-4,
    bNmSPerRad: 1.5e-4,
    tCoulombNm: 0.005,
    vBusV: quadPreset.paramsPatch.vBusV ?? 24,
    iMaxA: quadPreset.paramsPatch.iMaxA ?? 15,
    controlMode: 'mtpa_current_loop' as const,
  };
  const quadRes = simulateDynamicPmsm(quadParams, quadPreset.config);
  assert.ok(quadRes.peakSpeedRpm > 800);
  assert.ok(quadRes.minSpeedRpm < -400);
  assert.ok(quadRes.quadrantMode.includes('motoring'));
  assert.ok(quadRes.quadrantMode.includes('regen'));

  // 3) Steady-state convergence check on constant command run
  const steadyRes = simulateDynamicPmsm(
    {
      ...quadParams,
      jKgM2: 5e-5,
      controlMode: 'id_zero',
    },
    {
      durationSec: 0.4,
      dtOutSec: 5e-4,
      initialSpeedRpm: 0,
      scenario: [{ tStartSec: 0, tEndSec: 0.4, tLoadNm: 0.06, speedRefRpm: 1100 }],
    }
  );
  assert.ok(steadyRes.steadyCheck.torqueDiffNm < 1e-3);
  assert.ok(steadyRes.steadyCheck.voltageDiffV < 0.05, `voltageDiffV=${steadyRes.steadyCheck.voltageDiffV}`);

  // 4) Strict provenance tags on CSV & Scope handoff
  const csvTxt = buildDynamicPmsmCsv(steadyRes);
  assert.ok(csvTxt.includes('# WAVEFORM_PROVENANCE=MODEL_SYNTHETIC_DYNAMIC_ASSUMED_UNCALIBRATED'));
  const scopeTab = buildDynamicPmsmScopeTab(steadyRes);
  assert.ok(scopeTab);
  assert.equal(scopeTab.channels.ch_iq.metadata.dataProvenance, 'synthetic_assumed_uncalibrated');

  // 5) Full Python RK4 execution parity against TS simulateDynamicPmsm
  const dynPy = PYTHON_BUNDLE_FILES.find((f) => f.name === 'dynamic_pmsm.py')?.content || '';
  const pyParityScript = `
import json, sys
code = sys.stdin.read()
ns = {}
exec(code, ns)
patch, cfg = ns["build_dynamic_preset_scenario"]("ipm_mtpa_fw")
p = ns["DynamicPmsmParams"](**patch)
res = ns["simulate_dynamic_pmsm"](p, cfg)
print(json.dumps({
    "provenance": res["provenance"],
    "last_rpm": res["n_rpm"][-1],
    "last_id": res["id_a"][-1],
    "last_iq": res["iq_a"][-1],
    "last_te": res["te_nm"][-1],
    "volt_hits": res["voltage_limit_hits"],
    "volt_diff": res["steady_check"]["voltage_diff_v"],
}))
`;
  if (PYTHON_EXECUTABLE) {
    const pyProc = spawnSync(PYTHON_EXECUTABLE, ['-c', pyParityScript], { input: dynPy, encoding: 'utf8' });
    assert.equal(pyProc.status, 0, `Python dynamic_pmsm execution failed: ${pyProc.stderr}`);
    const pyOut = JSON.parse(pyProc.stdout);
    assert.equal(pyOut.provenance, 'synthetic_assumed_uncalibrated');
    const lastIdx = ipmRes.time.length - 1;
    assert.ok(Math.abs(pyOut.last_rpm - ipmRes.nRpm[lastIdx]) < 1e-6);
    assert.ok(Math.abs(pyOut.last_id - ipmRes.idA[lastIdx]) < 1e-6);
    assert.ok(Math.abs(pyOut.last_iq - ipmRes.iqA[lastIdx]) < 1e-6);
    assert.ok(Math.abs(pyOut.last_te - ipmRes.teNm[lastIdx]) < 1e-7);
    assert.equal(pyOut.volt_hits, ipmRes.voltageLimitHits);
  }
});




test('FD-03 software completion: nonlinear flux-map import drives RK4 and reports power-balance diagnostics in TS/Python', () => {
  const template = createPmsmFluxMapImportTemplate();
  const imported = parsePmsmFluxMapJson(JSON.stringify(template));
  assert.equal(imported.referenceTemperatureC, 25);
  const evalAt = evaluatePmsmFluxMap(imported, 5, 4);
  assert.ok(evalAt.lddH > 0 && evalAt.lqqH > 0);
  assert.ok(evalAt.psiDVs > 0);
  assert.throws(() => evaluatePmsmFluxMap(imported, 25, 0), /超出磁链 Map 范围/);

  const params = {
    polePairs: 4, rsOhm: 0.08, ldH: 0.2e-3, lqH: 0.5e-3, psiFVs: 0.01,
    jKgM2: 8e-5, bNmSPerRad: 1e-4, tCoulombNm: 0.002, vBusV: 48, iMaxA: 15,
    controlMode: 'open_loop_vdq' as const, fluxMap: imported,
    referenceTempC: 25, windingTempC: 70, magnetTempC: 25, // omitted coefficient must use copper default 0.00393 in TS and Python
  };
  const result = simulateDynamicPmsm(params, {
    durationSec: 0.01, dtOutSec: 1e-4, initialSpeedRpm: 300,
    scenario: [{ tStartSec: 0, tEndSec: 0.01, tLoadNm: 0.01, vdRefV: 1.0, vqRefV: 2.0 }],
  });
  assert.equal(result.sourceModel, 'dynamic_pmsm_dq_rk4_flux_map');
  assert.equal(result.fluxMapProvenance, 'fea_extracted');
  assert.ok(result.pMagneticStoredRateW.every(Number.isFinite));
  assert.ok(result.pElectricalBalanceResidualW.every((v) => Math.abs(v) < 1e-7));
  assert.ok(result.pMechanicalBalanceResidualW.every((v) => Math.abs(v) < 1e-7));
  assert.equal(buildDynamicPmsmScopeTab(result)?.channels.ch_psid.metadata.sourceModel, 'dynamic_pmsm_dq_rk4_flux_map');
  assert.ok(buildDynamicPmsmCsv(result).includes('ElectricalBalanceResidual_W'));

  assert.throws(() => simulateDynamicPmsm({ ...params, iMaxA: 25 }, {
    durationSec: 0.01, dtOutSec: 1e-4, scenario: [{ tStartSec: 0, tEndSec: 0.01, tLoadNm: 0 }],
  }), /必须至少覆盖 ±Imax/);
  assert.throws(() => simulateDynamicPmsm({ ...params, magnetTempC: 45 }, {
    durationSec: 0.01, dtOutSec: 1e-4, scenario: [{ tStartSec: 0, tEndSec: 0.01, tLoadNm: 0 }],
  }), /与磁链 Map 参考温度/);

  const dynPy = PYTHON_BUNDLE_FILES.find((f) => f.name === 'dynamic_pmsm.py')?.content || '';
  const pyScript = `
import json, sys
ns = {}
exec(sys.stdin.read(), ns)
doc = json.loads(${JSON.stringify(JSON.stringify(template))})
flux = ns['parse_pmsm_flux_map_json'](json.dumps(doc))
p = ns['DynamicPmsmParams'](pole_pairs=4,rs_ohm=0.08,ld_h=0.2e-3,lq_h=0.5e-3,psi_f_vs=0.01,j_kg_m2=8e-5,b_nm_s_per_rad=1e-4,t_coulomb_nm=0.002,v_bus_v=48,i_max_a=15,control_mode='open_loop_vdq',flux_map=flux,reference_temp_c=25,winding_temp_c=70,magnet_temp_c=25,rs_temp_coeff_per_c=0.00393)
cfg = ns['DynamicPmsmConfig'](duration_sec=0.01,dt_out_sec=1e-4,initial_speed_rpm=300,scenario=[ns['DynamicScenarioStep'](0,0.01,t_load_nm=0.01,vd_ref_v=1.0,vq_ref_v=2.0)])
r = ns['simulate_dynamic_pmsm'](p,cfg)
print(json.dumps({'source_model':r['source_model'],'last_id':r['id_a'][-1],'last_iq':r['iq_a'][-1],'last_te':r['te_nm'][-1],'max_e_res':max(abs(x) for x in r['p_electrical_balance_residual_w']),'max_m_res':max(abs(x) for x in r['p_mechanical_balance_residual_w'])}))
`;
  if (PYTHON_EXECUTABLE) {
    const pyProc = spawnSync(PYTHON_EXECUTABLE, ['-c', pyScript], { input: dynPy, encoding: 'utf8' });
    assert.equal(pyProc.status, 0, `Python flux-map parity failed: ${pyProc.stderr}`);
    const pyOut = JSON.parse(pyProc.stdout);
    assert.equal(pyOut.source_model, result.sourceModel);
    assert.ok(Math.abs(pyOut.last_id - result.idA[result.idA.length - 1]) < 1e-8);
    assert.ok(Math.abs(pyOut.last_iq - result.iqA[result.iqA.length - 1]) < 1e-8);
    assert.ok(Math.abs(pyOut.last_te - result.teNm[result.teNm.length - 1]) < 1e-8);
    assert.ok(pyOut.max_e_res < 1e-7);
    assert.ok(pyOut.max_m_res < 1e-7);
  }
});
