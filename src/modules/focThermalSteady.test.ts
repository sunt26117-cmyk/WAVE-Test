import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FOC_MODEL,
  computePhaseMosLosses,
  simulateFoc6MosSteadyState,
  simulateFoc6MosVoltageEnvelope,
  parseRdsOnTempCurveImportJson,
  evaluateRdsOnTempCurveRatio,
  type FocControlParams,
  type FocMosParams,
  type FocThermalModel,
} from './focThermal';

const baseCtrl: FocControlParams = {
  modulation: 'SVPWM',
  fswHz: 20_000,
  tDeadNs: 0,
  modDepthM: 0,
  pfAngleDeg: 0,
  tAmbC: 25,
  vBusConstV: 48,
};

const baseMos: FocMosParams = {
  rdsOn25Mohm: 5,
  rdsDataConfirmed: true,
  tempCoeffAlphaPerC: 0,
  vsdV: 0,
  eonPlusEoffUj: 0,
  vRefV: 48,
  iRefA: 10,
  qrrNc: 0,
  eossAlreadyIncludedInEsw: true,
  eonIncludesQrr: true,
};

const simpleThermalModel: FocThermalModel = {
  zthJC: [{ r: 0.5, c: 1, tauEst: 0.5, layerLabel: 'JC test' }],
  zthBoard: [{ r: 1.1, c: 2, tauEst: 2.2, layerLabel: 'Board test' }],
  modelKind: 'datasheet_constrained',
  zthValidation: { passed: true, maxRelErrPct: 0, rthOrig: 0.5, rthSplit: 0.5 },
};

const spinningPoint = {
  iqPeakA: 10,
  idPeakA: 0,
  electricalFrequencyHz: 100,
  mode: 'rotating' as const,
};

test('steady 6-MOS: constant sinusoidal current conduction integrates to Ipk^2*R/4 per switch at 50% duty', () => {
  const result = simulateFoc6MosSteadyState({
    model: simpleThermalModel,
    mos: baseMos,
    ctrl: baseCtrl,
    operatingPoint: spinningPoint,
    integrationSamples: 720,
  });

  // For each leg: mean(i_phase^2)=Ipk^2/2; each switch conducts for 50% duty.
  // Pcond per MOS = (Ipk^2/2) * Rds * 0.5 = Ipk^2*Rds/4.
  const expectedPerMosW = (10 ** 2) * 0.005 / 4;
  for (const row of result.perSwitch) {
    assert.ok(Math.abs(row.pCondAt25CW - expectedPerMosW) < 1e-9, `${row.key}: ${row.pCondAt25CW}`);
    assert.ok(Math.abs(row.pCondW - expectedPerMosW) < 1e-9);
    assert.equal(row.pSwitchingW, 0);
    assert.equal(row.pDeadTimeW, 0);
  }
  assert.ok(Math.abs(result.pCondTotalW - 6 * expectedPerMosW) < 1e-9);
  const expectedBoardC = 25 + 6 * expectedPerMosW * 1.1;
  assert.ok(Math.abs(result.tBoardSteadyC - expectedBoardC) < 1e-9);
  assert.ok(Math.abs(result.tjMaxSteadyC - (expectedBoardC + expectedPerMosW * 0.5)) < 1e-8);
  assert.equal(result.mode, 'rotating');
  assert.equal(result.steadyConverged, true);
  assert.equal(result.integrationAccuracyMet, true);
  assert.ok((result.integrationErrorPct ?? Infinity) <= 0.2);
  assert.ok(result.warnings.some((warning) => warning.includes('稳态 Tj 积分误差')),
    '积分精度说明必须覆盖最终热平衡温度，而不只是 25°C 初始损耗');
});

test('steady 6-MOS: total conduction loss is invariant to linear SVPWM/DPWM1/SPWM common-mode strategy', () => {
  const values = (['SVPWM', 'DPWM1', 'SPWM'] as const).map((modulation) =>
    simulateFoc6MosSteadyState({
      model: simpleThermalModel,
      mos: baseMos,
      ctrl: { ...baseCtrl, modulation, modDepthM: modulation === 'SPWM' ? 0.8 : 1.0 },
      operatingPoint: spinningPoint,
      integrationSamples: 720,
    }).pCondTotalW
  );
  assert.ok(Math.max(...values) - Math.min(...values) < 1e-8, values.join(', '));
});

test('steady 6-MOS: scalar Eon+Eoff energy is converted to average switching power over electrical cycle', () => {
  const fsw = 20_000;
  const esw = 50e-6;
  const result = simulateFoc6MosSteadyState({
    model: simpleThermalModel,
    mos: { ...baseMos, eonPlusEoffUj: 50 },
    ctrl: { ...baseCtrl, fswHz: fsw },
    operatingPoint: spinningPoint,
    integrationSamples: 1440,
  });
  // The current-scaled scalar E_sw model is linear in |I|. The average of
  // |sin(theta)| over an electrical cycle is 2/pi. Exactly one hard-switch
  // device per phase is charged by the current-direction model at each angle.
  const expected = 3 * fsw * esw * (2 / Math.PI);
  assert.ok(Math.abs(result.pSwitchingTotalW - expected) / expected < 0.002,
    `expected=${expected}, actual=${result.pSwitchingTotalW}`);
});

test('steady 6-MOS: dead-time loss uses constant PWM and the electrical-cycle mean absolute phase current', () => {
  const fsw = 20_000;
  const tDeadNs = 500;
  const vsd = 0.9;
  const result = simulateFoc6MosSteadyState({
    model: simpleThermalModel,
    mos: { ...baseMos, vsdV: vsd },
    ctrl: { ...baseCtrl, fswHz: fsw, tDeadNs },
    operatingPoint: spinningPoint,
    integrationSamples: 1440,
  });
  const deadFraction = 2 * tDeadNs * 1e-9 * fsw;
  const expected = 3 * (2 / Math.PI * 10) * vsd * deadFraction;
  assert.ok(Math.abs(result.pDeadTimeTotalW - expected) / expected < 0.002,
    `expected=${expected}, actual=${result.pDeadTimeTotalW}`);
});

test('steady 6-MOS: locked-rotor condition uses a fixed electrical angle and reports DC phase currents, not sinusoidal RMS', () => {
  const result = simulateFoc6MosSteadyState({
    model: simpleThermalModel,
    mos: baseMos,
    ctrl: baseCtrl,
    operatingPoint: {
      iqPeakA: 10,
      idPeakA: 0,
      electricalFrequencyHz: 0,
      mode: 'locked_rotor',
      electricalAngleDeg: 90,
    },
  });
  assert.equal(result.mode, 'locked_rotor');
  assert.equal(result.integrationSamples, 1);
  assert.equal(result.phaseCurrentRmsA, null);
  assert.ok(result.phaseCurrentA);
  assert.ok(Math.abs(result.phaseCurrentA!.a - 10) < 1e-10);
  assert.ok(Math.abs(result.phaseCurrentA!.b + 5) < 1e-10);
  assert.ok(Math.abs(result.phaseCurrentA!.c + 5) < 1e-10);
});

test('steady 6-MOS: locked-rotor electrical angle changes the stationary three-phase DC current vector', () => {
  const result = simulateFoc6MosSteadyState({
    model: simpleThermalModel,
    mos: baseMos,
    ctrl: baseCtrl,
    operatingPoint: {
      iqPeakA: 10,
      idPeakA: 0,
      electricalFrequencyHz: 0,
      mode: 'locked_rotor',
      electricalAngleDeg: 0,
    },
  });
  assert.equal(result.phaseCurrentRmsA, null);
  assert.ok(result.phaseCurrentA);
  assert.ok(Math.abs(result.phaseCurrentA!.a) < 1e-10);
  assert.ok(Math.abs(result.phaseCurrentA!.b + Math.sqrt(3) * 5) < 1e-10);
  assert.ok(Math.abs(result.phaseCurrentA!.c - Math.sqrt(3) * 5) < 1e-10);
});

test('steady 6-MOS: locked-rotor mode rejects a non-zero electrical frequency', () => {
  assert.throws(() => simulateFoc6MosSteadyState({
    model: simpleThermalModel,
    mos: baseMos,
    ctrl: baseCtrl,
    operatingPoint: {
      iqPeakA: 10,
      electricalFrequencyHz: 10,
      mode: 'locked_rotor',
      electricalAngleDeg: 90,
    },
  }), /locked_rotor 固定电角度工况的电频率必须为 0/);
});

test('steady 6-MOS: zero-current rotating point still follows the commanded PWM vector for DPWM1', () => {
  const result = simulateFoc6MosSteadyState({
    model: simpleThermalModel,
    mos: { ...baseMos, eonPlusEoffUj: 0, eossAlreadyIncludedInEsw: false, eossUj: 10 },
    ctrl: { ...baseCtrl, modulation: 'DPWM1', modDepthM: 0.9 },
    operatingPoint: { iqPeakA: 0, idPeakA: 0, electricalFrequencyHz: 50, mode: 'rotating' },
    integrationSamples: 720,
  });
  assert.ok(result.dutyMax - result.dutyMin > 0.5, `duty span=${result.dutyMax - result.dutyMin}`);
  assert.ok(result.pSwitchingTotalW > 0);
});


test('steady 6-MOS: Rds(Tj) feedback increases conduction loss and matches shared-board closed-form heat balance', () => {
  const alpha = 0.004;
  const mos = { ...baseMos, tempCoeffAlphaPerC: alpha };
  const result = simulateFoc6MosSteadyState({
    model: simpleThermalModel,
    mos,
    ctrl: baseCtrl,
    operatingPoint: spinningPoint,
    integrationSamples: 720,
  });
  const p25 = (10 ** 2) * 0.005 / 4;
  const loopA = p25 * (6 * 1.1 + 0.5);
  const expectedRise = loopA / (1 - alpha * loopA);
  const expectedTj = 25 + expectedRise;
  const expectedP = p25 * (1 + alpha * expectedRise);
  assert.ok(Math.abs(result.tjMaxSteadyC - expectedTj) < 1e-7,
    `expected Tj=${expectedTj}, actual=${result.tjMaxSteadyC}`);
  assert.ok(Math.abs(result.perSwitch[0].pCondW - expectedP) < 1e-8);
  assert.ok(result.pCondTotalW > 6 * p25);
});

test('steady 6-MOS: electrical-cycle average distributes equal balanced phase conduction across all six identical MOS', () => {
  const result = simulateFoc6MosSteadyState({
    model: simpleThermalModel,
    mos: baseMos,
    ctrl: { ...baseCtrl, modDepthM: 0.85, pfAngleDeg: 31 },
    operatingPoint: spinningPoint,
    integrationSamples: 1440,
  });
  const pValues = result.perSwitch.map((item) => item.pCondW);
  assert.ok(Math.max(...pValues) - Math.min(...pValues) < 1e-8, pValues.join(', '));
  assert.ok(result.perSwitch.every((item) => Number.isFinite(item.tjSteadyC)));
});

test('steady 6-MOS: rejects overmodulation and invalid fixed-condition inputs', () => {
  assert.throws(() => simulateFoc6MosSteadyState({
    model: DEFAULT_FOC_MODEL,
    mos: baseMos,
    ctrl: { ...baseCtrl, modulation: 'SPWM', modDepthM: 1.05 },
    operatingPoint: spinningPoint,
  }), /不支持过调制/);
  assert.throws(() => simulateFoc6MosSteadyState({
    model: DEFAULT_FOC_MODEL,
    mos: baseMos,
    ctrl: { ...baseCtrl, vBusConstV: 0 },
    operatingPoint: spinningPoint,
  }), /母线电压/);
  assert.throws(() => simulateFoc6MosSteadyState({
    model: DEFAULT_FOC_MODEL,
    mos: baseMos,
    ctrl: baseCtrl,
    operatingPoint: { ...spinningPoint, electricalFrequencyHz: Number.NaN },
  }), /电频率/);
});


test('steady 6-MOS: rejects an inverter loss estimate that exceeds the fixed FOC efficiency loss budget', () => {
  const result = simulateFoc6MosSteadyState({
    model: simpleThermalModel,
    mos: { ...baseMos, eonPlusEoffUj: 500 },
    ctrl: { ...baseCtrl, modDepthM: 0.8 },
    operatingPoint: {
      ...spinningPoint,
      dcLinkPowerW: 100,
      motorElectricalPowerW: 95,
      impliedInverterLossW: 5,
    },
    integrationSamples: 720,
  });
  assert.ok(result.pInverterTotalW > 5, `Pmos=${result.pInverterTotalW}`);
  assert.equal(result.powerBalanceStatus, 'EXCEEDS_BUDGET');
  assert.ok(result.inverterLossBudgetMarginW !== null && result.inverterLossBudgetMarginW < 0);
  assert.ok(result.qualificationReasons.some((reason) => reason.includes('六管计算损耗超过')));
  assert.ok(result.warnings.some((warning) => warning.includes('功率平衡检查失败')));
});


test('steady 6-MOS: fixed PWM frequency scales average switching loss while leaving conduction loss unchanged', () => {
  const mos = { ...baseMos, eonPlusEoffUj: 20 };
  const lowFsw = simulateFoc6MosSteadyState({
    model: simpleThermalModel,
    mos,
    ctrl: { ...baseCtrl, fswHz: 10_000, tDeadNs: 0 },
    operatingPoint: spinningPoint,
    integrationSamples: 720,
  });
  const highFsw = simulateFoc6MosSteadyState({
    model: simpleThermalModel,
    mos,
    ctrl: { ...baseCtrl, fswHz: 20_000, tDeadNs: 0 },
    operatingPoint: spinningPoint,
    integrationSamples: 720,
  });
  assert.ok(Math.abs(highFsw.pSwitchingTotalW / lowFsw.pSwitchingTotalW - 2) < 1e-9);
  assert.ok(Math.abs(highFsw.pCondTotalW - lowFsw.pCondTotalW) < 1e-9);
  assert.equal(highFsw.fswHz, 20_000);
});


test('steady 6-MOS: rejects malformed six-position thermal spread inputs instead of silently falling back', () => {
  assert.throws(() => simulateFoc6MosSteadyState({
    model: { ...simpleThermalModel, perSwitchRjcScale: [1, 1] },
    mos: baseMos,
    ctrl: baseCtrl,
    operatingPoint: spinningPoint,
  }), /perSwitchRjcScale 必须严格包含/);
  assert.throws(() => simulateFoc6MosSteadyState({
    model: { ...simpleThermalModel, perSwitchRjcScale: [1, 1, 1, 1, 1, Number.NaN] },
    mos: baseMos,
    ctrl: baseCtrl,
    operatingPoint: spinningPoint,
  }), /perSwitchRjcScale 必须严格包含/);
  assert.throws(() => simulateFoc6MosSteadyState({
    model: { ...simpleThermalModel, perSwitchPadOffsetCPerW: [0, 0, 0, 0, 0, -0.1] },
    mos: baseMos,
    ctrl: baseCtrl,
    operatingPoint: spinningPoint,
  }), /perSwitchPadOffsetCPerW 必须严格包含/);
});

test('steady 6-MOS: thermal runaway downgrades result qualification even when electrical inputs are complete', () => {
  const result = simulateFoc6MosSteadyState({
    model: simpleThermalModel,
    mos: {
      ...baseMos,
      rdsOn25Mohm: 300,
      tempCoeffAlphaPerC: 0.05,
      eonPlusEoffUj: 1,
    },
    ctrl: baseCtrl,
    operatingPoint: spinningPoint,
  });
  assert.equal(result.thermalRunaway, true);
  assert.equal(result.steadyConverged, false);
  assert.equal(result.resultQualification, 'ASSUMPTION_BASED');
  assert.ok(result.qualificationReasons.some((reason) => reason.includes('热失控')));
  assert.ok(Number.isNaN(result.tjMaxSteadyC), '热失控时不能返回迭代中间结温冒充稳态 Tj');
  assert.ok(Number.isNaN(result.pInverterTotalW), '热失控时不能返回由无效温度决定的最终损耗');
  assert.ok(result.perSwitch.every((row) => Number.isNaN(row.tjSteadyC) && Number.isNaN(row.pTotalW)));
  assert.equal(result.powerBalanceStatus, 'NOT_AVAILABLE');
  assert.equal(result.inverterLossBudgetMarginW, null);
});

test('12-V vehicle bus envelope: never labels a thermal runaway case as CALCULATED', () => {
  const rows = simulateFoc6MosVoltageEnvelope({
    model: simpleThermalModel,
    mos: { ...baseMos, rdsOn25Mohm: 300, tempCoeffAlphaPerC: 0.05, eonPlusEoffUj: 1 },
    ctrl: { ...baseCtrl, vBusConstV: 13.5, modDepthM: 0.2 },
    operatingPoint: spinningPoint,
  });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.status === 'THERMAL_RUNAWAY'));
  assert.ok(rows.every((row) => row.result?.thermalRunaway === true));
});

test('12-V vehicle bus envelope: checks 9/13.5/16 V and flags low-voltage modulation saturation', () => {
  const rows = simulateFoc6MosVoltageEnvelope({
    model: simpleThermalModel,
    mos: baseMos,
    ctrl: { ...baseCtrl, vBusConstV: 13.5, modDepthM: 0.8 },
    operatingPoint: spinningPoint,
  });
  assert.deepEqual(rows.map((row) => row.vBusV), [9, 13.5, 16]);
  assert.equal(rows[0].status, 'VOLTAGE_LIMITED');
  assert.equal(rows[0].result, null);
  assert.equal(rows[1].status, 'CALCULATED');
  assert.equal(rows[2].status, 'CALCULATED');
  for (const row of rows) {
    assert.ok(Math.abs(row.requiredModDepthM * row.vBusV - 0.8 * 13.5) < 1e-10);
  }
  assert.ok(rows[1].result!.steadyConverged);
  assert.ok(rows[2].result!.steadyConverged);
});

test('12-V vehicle bus envelope: rejects an overmodulated reference point even if a higher bus point could fit', () => {
  assert.throws(() => simulateFoc6MosVoltageEnvelope({
    model: simpleThermalModel,
    mos: baseMos,
    ctrl: { ...baseCtrl, vBusConstV: 13.5, modDepthM: 1.2 },
    operatingPoint: spinningPoint,
    voltagePoints: [9, 13.5, 16],
    referenceVoltageV: 13.5,
  }), /参考工况本身已超过.*线性调制上限/);
});

test('12-V vehicle bus envelope: rejects Eoss curve queries below the measured voltage domain', () => {
  const rows = simulateFoc6MosVoltageEnvelope({
    model: simpleThermalModel,
    mos: {
      ...baseMos,
      eonPlusEoffUj: 1,
      eossAlreadyIncludedInEsw: false,
      eossCurve: {
        kind: 'eoss_uj',
        label: '0-13.5V test curve',
        points: [{ vdsV: 0, val: 0 }, { vdsV: 9, val: 0.6 }, { vdsV: 13.5, val: 1.1 }],
      },
    },
    ctrl: { ...baseCtrl, vBusConstV: 13.5, modDepthM: 0.6 },
    operatingPoint: spinningPoint,
  });
  assert.equal(rows[0].status, 'CALCULATED');
  assert.equal(rows[1].status, 'CALCULATED');
  assert.equal(rows[2].status, 'MODEL_OUT_OF_RANGE');
  assert.ok(rows[2].result === null && rows[2].note.includes('曲线定义域'));
  assert.ok(rows[0].result !== null && rows[1].result !== null);
});


test('12-V vehicle bus envelope: Rds(Tj) curve temperature coverage is reported as MODEL_OUT_OF_RANGE', () => {
  const curve = parseRdsOnTempCurveImportJson(JSON.stringify({
    schema: 'wave-test-rdson-temperature',
    schemaVersion: 1,
    referenceTemperatureC: 25,
    referenceGateVoltageV: 10,
    provenance: 'datasheet',
    partNumber: 'MOS-12V-TEST',
    points: [
      { tjC: 25, ratioTo25C: 1.0 },
      { tjC: 50, ratioTo25C: 1.2 },
      { tjC: 75, ratioTo25C: 1.4 },
    ],
  }));
  const rows = simulateFoc6MosVoltageEnvelope({
    model: { ...simpleThermalModel, zthJC: [{ r: 10, c: 1, tauEst: 10, layerLabel: 'JC high R' }] },
    mos: { ...baseMos, rdsOperatingVgsV: 10, rds25ReferenceVgsV: 10, rdsOnTempCurve: curve },
    ctrl: { ...baseCtrl, vBusConstV: 13.5, modDepthM: 0.2 },
    operatingPoint: { ...spinningPoint, iqPeakA: 60 },
    voltagePoints: [13.5, 16],
    referenceVoltageV: 13.5,
  });
  assert.ok(rows.some((row) => row.status === 'MODEL_OUT_OF_RANGE' && row.note.includes('Rds(on)-Tj 曲线范围')));
});

test('phase leg: dead-time is removed from both MOS channel intervals and attributed to the current-direction diode', () => {
  const mos: FocMosParams = {
    ...baseMos,
    rdsOn25Mohm: 5,
    vsdV: 0.9,
    eonPlusEoffUj: 50,
    vRefV: 13.5,
    iRefA: 10,
    eossAlreadyIncludedInEsw: true,
    eonIncludesQrr: true,
  };
  const positive = computePhaseMosLosses(
    10, 0.4, 13.5, 25, 25, 'SVPWM', 20_000, 500, mos,
  );
  const negative = computePhaseMosLosses(
    -10, 0.4, 13.5, 25, 25, 'SVPWM', 20_000, 500, mos,
  );

  // One dead-time interval per edge: 500 ns * 20 kHz = 1% each;
  // H channel=39%, L channel=59%, diode conduction=2% of the PWM period.
  assert.ok(Math.abs(positive.pHighCond - 100 * 0.005 * 0.39) < 1e-12);
  assert.ok(Math.abs(positive.pLowCond - 100 * 0.005 * 0.59) < 1e-12);
  assert.ok(Math.abs(negative.pHighCond - positive.pHighCond) < 1e-12);
  assert.ok(Math.abs(negative.pLowCond - positive.pLowCond) < 1e-12);
  assert.ok(Math.abs(positive.pLowDead - 10 * 0.9 * 0.02) < 1e-12);
  assert.equal(positive.pHighDead, 0);
  assert.ok(Math.abs(negative.pHighDead - 10 * 0.9 * 0.02) < 1e-12);
  assert.equal(negative.pLowDead, 0);

  // Exactly one hard-switching device receives the per-cycle Eon+Eoff energy;
  // the sum of H+L losses must conserve conduction + switching + diode loss.
  const expectedSwitchingW = 20_000 * 50e-6;
  assert.ok(Math.abs(positive.pHighSw - expectedSwitchingW) < 1e-12);
  assert.equal(positive.pLowSw, 0);
  assert.equal(negative.pHighSw, 0);
  assert.ok(Math.abs(negative.pLowSw - expectedSwitchingW) < 1e-12);
  const expectedLegLossW = 100 * 0.005 * (1 - 0.02) + expectedSwitchingW + 10 * 0.9 * 0.02;
  assert.ok(Math.abs(positive.pHighTotal + positive.pLowTotal - expectedLegLossW) < 1e-12);
  assert.ok(Math.abs(negative.pHighTotal + negative.pLowTotal - expectedLegLossW) < 1e-12);
});


test('phase leg: Qrr and Eoss accounting flags prevent duplicate energy addition', () => {
  const fsw = 20_000;
  const eonPlusEoffUj = 50;
  const qrrNc = 100;
  const eossUj = 10;
  const qrrEnergyUj = qrrNc * 1e-3 * 13.5; // nC * V = nJ; convert to µJ
  for (const qrrIncluded of [false, true]) {
    for (const eossIncluded of [false, true]) {
      const leg = computePhaseMosLosses(
        10,
        0.5,
        13.5,
        25,
        25,
        'SVPWM',
        fsw,
        0,
        {
          ...baseMos,
          eonPlusEoffUj,
          qrrNc,
          eossUj,
          vRefV: 13.5,
          iRefA: 10,
          eonIncludesQrr: qrrIncluded,
          eossAlreadyIncludedInEsw: eossIncluded,
        },
      );
      const expectedEnergyUj = eonPlusEoffUj + (qrrIncluded ? 0 : qrrEnergyUj) + (eossIncluded ? 0 : eossUj);
      assert.ok(Math.abs(leg.pHighSw - fsw * expectedEnergyUj * 1e-6) < 1e-12,
        `Qrr included=${qrrIncluded}, Eoss included=${eossIncluded}, actual=${leg.pHighSw}`);
      assert.equal(leg.pLowSw, 0);
    }
  }
});

test('phase leg: Nexperia Qr includes Qoss and cannot be added with a separate Eoss scalar', () => {
  const qrMos: FocMosParams = {
    ...baseMos,
    eonPlusEoffUj: 0,
    qrrNc: 13,
    iRefA: 16,
    vRefV: 20,
    qrrIncludesQoss: true,
    eonIncludesQrr: false,
    eossAlreadyIncludedInEsw: false,
    eossUj: 0,
  };
  const leg = computePhaseMosLosses(
    16, 0.5, 13.5, 25, 25, 'SVPWM', 20_000, 0, qrMos,
  );
  const expectedQrPowerW = 20_000 * 13e-9 * 13.5;
  assert.ok(Math.abs(leg.pHighSw - expectedQrPowerW) < 1e-12);
  assert.equal(leg.pLowSw, 0);

  // The datasheet Qr test current is independent of the Eon/Eoff Iref.
  // At 8 A, Qr=13 nC @ 16 A must be scaled by 0.5 even though Esw Iref=10 A.
  const independentlyReferencedQr = computePhaseMosLosses(
    8, 0.5, 13.5, 25, 25, 'SVPWM', 20_000, 0,
    { ...qrMos, iRefA: 10, qrrIrefA: 16 },
  );
  const expectedIndependentQrPowerW = 20_000 * 13e-9 * 13.5 * (8 / 16);
  assert.ok(Math.abs(independentlyReferencedQr.pHighSw - expectedIndependentQrPowerW) < 1e-12);
  assert.throws(() => computePhaseMosLosses(
    8, 0.5, 13.5, 25, 25, 'SVPWM', 20_000, 0,
    { ...qrMos, qrrIrefA: 0 },
  ), /Qr\/Qrr 独立参考电流/);

  assert.throws(() => computePhaseMosLosses(
    16,
    0.5,
    13.5,
    25,
    25,
    'SVPWM',
    20_000,
    0,
    { ...qrMos, eossUj: 0.2 },
  ), /Qr 数据已包含 Qoss/);
});

test('steady 6-MOS: Qr including Qoss satisfies the capacitive-recovery accounting input but does not invent Eon/Eoff', () => {
  const result = simulateFoc6MosSteadyState({
    model: simpleThermalModel,
    mos: {
      ...baseMos,
      rdsOn25Mohm: 5,
      eonPlusEoffUj: 0,
      qrrNc: 13,
      iRefA: 10,
      qrrIrefA: 16,
      qrrReferenceVdsV: 20,
      qrrReferenceDiDtAperUs: -100,
      qrrReferenceTjC: 25,
      qrrReferenceVgsV: 0,
      vRefV: 13.5,
      qrrIncludesQoss: true,
      eonIncludesQrr: false,
      eossAlreadyIncludedInEsw: false,
      eossUj: 0,
    },
    ctrl: { ...baseCtrl, vBusConstV: 13.5 },
    operatingPoint: spinningPoint,
    integrationSamples: 720,
  });
  assert.ok(result.qualificationReasons.some((note) => note.includes('Eon+Eoff/DPT')));
  assert.ok(!result.qualificationReasons.some((note) => note.includes('Eoss')));
  assert.equal(result.resultQualification, 'INCOMPLETE_LOSS_MODEL');
  assert.ok(result.warnings.some((note) => note.includes('Qr=Qs+Qoss')));
  assert.ok(result.warnings.some((note) => note.includes('Qr=13.00 nC @ 16.0A')));
  assert.ok(result.warnings.some((note) => note.includes('独立 Eoss 不再叠加')));
  assert.ok(result.warnings.some((note) => note.includes('VDS=20.0V') && note.includes('di/dt=-100A/µs') && note.includes('VGS=0.0V') && note.includes('Tj=25°C')));
  assert.ok(result.warnings.some((note) => note.includes('当前 Vbus=13.50V') && note.includes('相对测试 VDS 差异 32.5%')));
  assert.ok(result.qualificationReasons.some((note) => note.includes('Qr/Qrr 只使用单点电荷数据')));
});

test('phase leg: invalid Qr reference test conditions are rejected rather than silently accepted', () => {
  const qrMos: FocMosParams = {
    ...baseMos,
    qrrNc: 13,
    qrrIrefA: 16,
    qrrReferenceVdsV: 0,
    qrrIncludesQoss: true,
    eonIncludesQrr: false,
  };
  assert.throws(() => computePhaseMosLosses(
    8, 0.5, 13.5, 25, 25, 'SVPWM', 20_000, 0, qrMos,
  ), /Qr\/Qrr 参考测试 VDS/);
});

test('phase leg: rejects a commanded pulse narrower than dead-time instead of guessing MCU pulse-deletion behavior', () => {
  const mos = { ...baseMos, eonPlusEoffUj: 50, eossAlreadyIncludedInEsw: true, eonIncludesQrr: true };
  assert.throws(() => computePhaseMosLosses(
    10, 0.005, 13.5, 25, 25, 'SVPWM', 20_000, 500, mos,
  ), /PWM 指令脉冲宽度不足/);
  assert.throws(() => computePhaseMosLosses(
    -10, 0.995, 13.5, 25, 25, 'SVPWM', 20_000, 500, mos,
  ), /PWM 指令脉冲宽度不足/);
  // A tiny but non-zero duty is not a static clamp: the commanded pulse is
  // much shorter than the 500 ns dead-time and must not bypass the guard.
  assert.throws(() => computePhaseMosLosses(
    10, 0.00005, 13.5, 25, 25, 'SVPWM', 20_000, 500, mos,
  ), /PWM 指令脉冲宽度不足/);
  assert.throws(() => computePhaseMosLosses(
    10, Number.NaN, 13.5, 25, 25, 'SVPWM', 20_000, 500, mos,
  ), /PWM 高侧占空比必须位于 0～1/);
  assert.throws(() => computePhaseMosLosses(
    10, 0.5, 13.5, 25, 25, 'SVPWM', 20_000, 500, { ...mos, vsdV: Number.NaN },
  ), /Vsd 必须为 0～10 V/);
  assert.throws(() => computePhaseMosLosses(
    10, 0.5, 13.5, 25, 25, 'SVPWM', 20_000, 500, { ...mos, tempCoeffAlphaPerC: Number.NaN },
  ), /温度系数 α 必须为 0～0.05/);
});


test('phase leg: dead-time duty conservation holds across the normal modulation duty range and both current polarities', () => {
  const mos: FocMosParams = {
    ...baseMos,
    rdsOn25Mohm: 5,
    vRefV: 13.5,
    iRefA: 10,
    vsdV: 0.9,
    eonPlusEoffUj: 0,
    eossAlreadyIncludedInEsw: true,
    eonIncludesQrr: true,
  };
  const edgeDuty = 500e-9 * 20_000;
  for (let step = 1; step <= 19; step++) {
    const duty = step * 0.05;
    for (const current of [10, -10]) {
      const leg = computePhaseMosLosses(
        current, duty, 13.5, 25, 25, 'SVPWM', 20_000, 500, mos,
      );
      const expectedHighCond = 100 * 0.005 * (duty - edgeDuty);
      const expectedLowCond = 100 * 0.005 * (1 - duty - edgeDuty);
      const expectedDead = 10 * 0.9 * 2 * edgeDuty;
      assert.ok(Math.abs(leg.pHighCond - expectedHighCond) < 1e-12, `d=${duty}, I=${current}, pH=${leg.pHighCond}`);
      assert.ok(Math.abs(leg.pLowCond - expectedLowCond) < 1e-12, `d=${duty}, I=${current}, pL=${leg.pLowCond}`);
      assert.ok(Math.abs(leg.pHighDead + leg.pLowDead - expectedDead) < 1e-12, `d=${duty}, I=${current}`);
      const expectedTotal = 100 * 0.005 * (1 - 2 * edgeDuty) + expectedDead;
      assert.ok(Math.abs(leg.pHighTotal + leg.pLowTotal - expectedTotal) < 1e-12, `d=${duty}, I=${current}`);
    }
  }
});


test('Rds(on)-Tj curve: JSON import validates 25C normalization, Vgs metadata and monotonic temperature axis', () => {
  const curve = parseRdsOnTempCurveImportJson(JSON.stringify({
    schema: 'wave-test-rdson-temperature',
    schemaVersion: 1,
    referenceTemperatureC: 25,
    referenceGateVoltageV: 10,
    provenance: 'datasheet',
    manufacturer: 'Example',
    partNumber: 'MOS-12V-TEST',
    points: [
      { tjC: -40, ratioTo25C: 0.72 },
      { tjC: 25, ratioTo25C: 1.0 },
      { tjC: 100, ratioTo25C: 1.55 },
      { tjC: 150, ratioTo25C: 1.9 },
    ],
  }));
  assert.ok(Math.abs(evaluateRdsOnTempCurveRatio(curve, 62.5) - 1.275) < 1e-12);
  assert.throws(() => evaluateRdsOnTempCurveRatio(curve, 175), /禁止线性外推/);
  assert.throws(() => parseRdsOnTempCurveImportJson(JSON.stringify({
    ...curve,
    points: [
      { tjC: -40, ratioTo25C: 0.72 },
      { tjC: 25, ratioTo25C: 1.2 },
      { tjC: 100, ratioTo25C: 1.55 },
    ],
  })), /25°C 的归一化值应为 1.0/);
  assert.throws(() => parseRdsOnTempCurveImportJson(JSON.stringify({
    ...curve,
    points: [
      { tjC: -40, ratioTo25C: 0.72 },
      { tjC: 25, ratioTo25C: 1.0 },
      { tjC: 25, ratioTo25C: 1.4 },
    ],
  })), /温度轴必须严格递增/);
});

test('steady 6-MOS: normalized Rds(on)-Tj curve overrides alpha and participates in closed-loop thermal equilibrium', () => {
  const curve = parseRdsOnTempCurveImportJson(JSON.stringify({
    schema: 'wave-test-rdson-temperature',
    schemaVersion: 1,
    referenceTemperatureC: 25,
    referenceGateVoltageV: 10,
    provenance: 'datasheet',
    manufacturer: 'Example',
    partNumber: 'MOS-12V-TEST',
    points: [
      { tjC: -40, ratioTo25C: 0.72 },
      { tjC: 25, ratioTo25C: 1.0 },
      { tjC: 100, ratioTo25C: 1.55 },
      { tjC: 150, ratioTo25C: 1.9 },
      { tjC: 200, ratioTo25C: 2.3 },
    ],
  }));
  const withAlphaZero = simulateFoc6MosSteadyState({
    model: simpleThermalModel,
    mos: { ...baseMos, tempCoeffAlphaPerC: Number.NaN, rdsOperatingVgsV: 10, rds25ReferenceVgsV: 10, rdsOnTempCurve: curve },
    ctrl: baseCtrl,
    operatingPoint: { ...spinningPoint, iqPeakA: 60 },
    integrationSamples: 720,
  });
  const withAlphaNonzero = simulateFoc6MosSteadyState({
    model: simpleThermalModel,
    mos: { ...baseMos, tempCoeffAlphaPerC: 0.05, rdsOperatingVgsV: 10, rds25ReferenceVgsV: 10, rdsOnTempCurve: curve },
    ctrl: baseCtrl,
    operatingPoint: { ...spinningPoint, iqPeakA: 60 },
    integrationSamples: 720,
  });
  assert.equal(withAlphaZero.steadyConverged, true);
  assert.equal(withAlphaNonzero.steadyConverged, true);
  assert.ok(Math.abs(withAlphaZero.tjMaxSteadyC - withAlphaNonzero.tjMaxSteadyC) < 1e-8,
    'when curve exists the legacy alpha input must not affect the result');
  for (const row of withAlphaZero.perSwitch) {
    const factor = evaluateRdsOnTempCurveRatio(curve, row.tjSteadyC);
    assert.ok(Math.abs(row.pCondW - row.pCondAt25CW * factor) < 1e-8,
      `${row.key}: Pcond ${row.pCondW}, expected ${row.pCondAt25CW * factor}`);
  }
  assert.ok(withAlphaZero.tjMaxSteadyC > 25);
  assert.ok(withAlphaZero.warnings.some((warning) => warning.includes('Rds(on)-Tj 归一化曲线')));
});


test('steady 6-MOS: Rds(on)-Tj curve must match the actual on-state Vgs', () => {
  const curve = parseRdsOnTempCurveImportJson(JSON.stringify({
    schema: 'wave-test-rdson-temperature',
    schemaVersion: 1,
    referenceTemperatureC: 25,
    referenceGateVoltageV: 10,
    provenance: 'datasheet',
    partNumber: 'MOS-12V-TEST',
    points: [
      { tjC: -40, ratioTo25C: 0.72 },
      { tjC: 25, ratioTo25C: 1.0 },
      { tjC: 100, ratioTo25C: 1.55 },
    ],
  }));
  const common = {
    model: simpleThermalModel,
    ctrl: baseCtrl,
    operatingPoint: spinningPoint,
    integrationSamples: 720,
  };
  assert.throws(() => simulateFoc6MosSteadyState({
    ...common,
    mos: { ...baseMos, rdsOnTempCurve: curve },
  }), /必须填写 MOS 实际导通栅源电压/);
  assert.throws(() => simulateFoc6MosSteadyState({
    ...common,
    mos: { ...baseMos, rdsOperatingVgsV: 12, rds25ReferenceVgsV: 10, rdsOnTempCurve: curve },
  }), /不一致.*允许偏差/);
  const result = simulateFoc6MosSteadyState({
    ...common,
    mos: { ...baseMos, rdsOperatingVgsV: 10, rds25ReferenceVgsV: 10, rdsOnTempCurve: curve },
  });
  assert.equal(result.steadyConverged, true);
});


test('steady 6-MOS: absolute Rds25 test Vgs must match the normalized Rds(Tj) curve reference', () => {
  const curve = parseRdsOnTempCurveImportJson(JSON.stringify({
    schema: 'wave-test-rdson-temperature',
    schemaVersion: 1,
    referenceTemperatureC: 25,
    referenceGateVoltageV: 10,
    provenance: 'datasheet',
    partNumber: 'MOS-12V-TEST',
    points: [
      { tjC: -40, ratioTo25C: 0.72 },
      { tjC: 25, ratioTo25C: 1.0 },
      { tjC: 100, ratioTo25C: 1.55 },
    ],
  }));
  const common = {
    model: simpleThermalModel,
    ctrl: baseCtrl,
    operatingPoint: spinningPoint,
    integrationSamples: 720,
  };
  assert.throws(() => simulateFoc6MosSteadyState({
    ...common,
    mos: { ...baseMos, rdsOperatingVgsV: 10, rdsOnTempCurve: curve },
  }), /必须填写 Rds\(on\)@25°C 绝对值对应/);
  assert.throws(() => simulateFoc6MosSteadyState({
    ...common,
    mos: { ...baseMos, rdsOperatingVgsV: 10, rds25ReferenceVgsV: 4.5, rdsOnTempCurve: curve },
  }), /归一化比例不能修正不同 Vgs 下的绝对 Rds 差异/);
  const valid = simulateFoc6MosSteadyState({
    ...common,
    mos: { ...baseMos, rdsOperatingVgsV: 10, rds25ReferenceVgsV: 10, rdsOnTempCurve: curve },
  });
  assert.equal(valid.steadyConverged, true);
});

test('steady 6-MOS: Rds(on)-Tj curve domain must cover the solved junction temperature', () => {
  const curve = parseRdsOnTempCurveImportJson(JSON.stringify({
    schema: 'wave-test-rdson-temperature',
    schemaVersion: 1,
    referenceTemperatureC: 25,
    referenceGateVoltageV: 10,
    provenance: 'datasheet',
    partNumber: 'MOS-12V-TEST',
    points: [
      { tjC: 25, ratioTo25C: 1.0 },
      { tjC: 50, ratioTo25C: 1.2 },
      { tjC: 75, ratioTo25C: 1.4 },
    ],
  }));
  assert.throws(() => simulateFoc6MosSteadyState({
    model: { ...simpleThermalModel, zthJC: [{ r: 10, c: 1, tauEst: 10, layerLabel: 'JC test' }] },
    mos: { ...baseMos, rdsOperatingVgsV: 10, rds25ReferenceVgsV: 10, rdsOnTempCurve: curve },
    ctrl: baseCtrl,
    operatingPoint: { ...spinningPoint, iqPeakA: 60 },
    integrationSamples: 720,
  }), /超出 Rds\(on\)-Tj 曲线范围/);
});
