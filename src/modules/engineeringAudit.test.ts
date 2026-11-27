import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FOC_MODEL,
  computePhaseMosLosses,
  getModulationLinearCeiling,
  runFocStallSweep,
  simulateFoc6Mos,
} from './focThermal';
import { BUK7Q6R0_40H_PROFILE, createBuk7Q6R0_40HRdsCurve } from './focMosDeviceProfiles';
import { computeMeasurements } from './measurements';
import { applyWaveformFilter, computeFilterBodeResponse, createDefaultFilterConfig } from './filter';
import { computeFFT } from './fft';
import { decimateMinMaxSegment } from './decimator';
import { analyzeSamplingQuality } from './qualityCheck';
import { WaveformChannel } from '../types/models';
import { DptOperatingPoint } from './dptAnalyzer';

function makeChannel(
  id: string,
  t: Float64Array,
  v: Float32Array,
  unit: string = 'V'
): WaveformChannel {
  const dt = t.length > 1 ? (t[t.length - 1] - t[0]) / (t.length - 1) : 1e-3;
  return {
    id,
    name: id,
    unit,
    color: '#22d3ee',
    visible: true,
    t,
    v,
    fs: dt > 0 ? 1 / dt : 1000,
    dt,
    isMath: false,
    sourceChannelIds: [],
    metadata: analyzeSamplingQuality(t, 0),
    vMin: -100,
    vMax: 100,
  };
}

test('Audit P1-Thermal-1: independent thermal mode honors per-zone cPcbJPerC in transient response', () => {
  const n = 200;
  const t = Float64Array.from({ length: n }, (_, i) => i * 0.005); // 1.0 s total
  const ia = new Float32Array(n).fill(30);
  const ib = new Float32Array(n).fill(-15);
  const mos = {
    rdsOn25Mohm: 6.0,
    tempCoeffAlphaPerC: 0.0045,
    vsdV: 0.85,
    eonPlusEoffUj: 40,
    vRefV: 13.5,
    iRefA: 20,
    qrrNc: 13,
    eossUj: 0.2,
  };
  const ctrl = {
    modulation: 'SVPWM' as const,
    fswHz: 20000,
    tDeadNs: 200,
    modDepthM: 0.5,
    pfAngleDeg: 0,
    tAmbC: 25,
    vBusConstV: 13.5,
  };

  const smallCapModel = {
    ...DEFAULT_FOC_MODEL,
    thermalTopologyMode: 'independent' as const,
    spatialMatrix: {
      zoneThermalCapJPerC: [0.02, 0.02, 0.02, 0.02, 0.02, 0.02],
      zoneVerticalRthCPerW: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2],
    },
  };
  const largeCapModel = {
    ...DEFAULT_FOC_MODEL,
    thermalTopologyMode: 'independent' as const,
    spatialMatrix: {
      zoneThermalCapJPerC: [2.0, 2.0, 2.0, 2.0, 2.0, 2.0],
      zoneVerticalRthCPerW: [0.2, 0.2, 0.2, 0.2, 0.2, 2.0],
    },
  };

  const rSmall = simulateFoc6Mos(makeChannel('ia', t, ia, 'A'), makeChannel('ib', t, ib, 'A'), smallCapModel, mos, ctrl);
  const rLarge = simulateFoc6Mos(makeChannel('ia', t, ia, 'A'), makeChannel('ib', t, ib, 'A'), largeCapModel, mos, ctrl);

  // Smaller PCB capacitance must heat up noticeably faster during the 1 s transient
  assert.ok(
    rSmall.tj.AH[n - 1] > rLarge.tj.AH[n - 1] + 2.0,
    `Expected small cPcb Tj (${rSmall.tj.AH[n - 1]}) > large cPcb Tj (${rLarge.tj.AH[n - 1]}) + 2°C`
  );
  // Steady-state AH temperature depends only on Rth (identical for AH), so both must converge identically
  assert.ok(Math.abs(rSmall.tjSteadyEstByKey.AH - rLarge.tjSteadyEstByKey.AH) < 0.05);
});

test('Audit P1-Thermal-2: non-uniform timebase with Tj-dependent 4D DPT LUT produces unbiased steady-state Tj', () => {
  const dptLut: DptOperatingPoint[] = [];
  let idx = 0;
  for (const vBusV of [12, 24]) {
    for (const iLoadA of [0, 40]) {
      for (const tjC of [25, 150]) {
        for (const rgOhm of [5, 20]) {
          const s = (vBusV / 12) * (iLoadA / 40) * (1 + 2 * ((tjC - 25) / 125)) * (rgOhm / 10);
          dptLut.push({
            id: String(++idx),
            vBusV,
            iLoadA,
            tjC,
            rgOhm,
            eOnUj: 120 * s,
            eOffUj: 100 * s,
            qRrNc: 15 * (iLoadA / 40) * (1 + (tjC - 25) / 125),
          });
        }
      }
    }
  }

  // Non-uniform 50%/50% time split: 300 pts @ 0.1ms (30ms at 5A) + 100 pts @ 0.3ms (30ms at 35A)
  const tArr: number[] = [];
  const iaArr: number[] = [];
  const ibArr: number[] = [];
  let curT = 0;
  for (let i = 0; i < 300; i++) {
    tArr.push(curT);
    iaArr.push(5);
    ibArr.push(-2.5);
    curT += 1e-4;
  }
  for (let i = 0; i < 100; i++) {
    tArr.push(curT);
    iaArr.push(35);
    ibArr.push(-17.5);
    curT += 3e-4;
  }
  const tNonU = Float64Array.from(tArr);
  const iaNonU = Float32Array.from(iaArr);
  const ibNonU = Float32Array.from(ibArr);

  // Uniform reference with identical 50%/50% elapsed-time split
  const tUni = Float64Array.from({ length: 600 }, (_, i) => i * 1e-4);
  const iaUni = Float32Array.from({ length: 600 }, (_, i) => (i < 300 ? 5 : 35));
  const ibUni = Float32Array.from({ length: 600 }, (_, i) => (i < 300 ? -2.5 : -17.5));

  const mos = {
    rdsOn25Mohm: 6.0,
    tempCoeffAlphaPerC: 0.0045,
    vsdV: 0.85,
    eonPlusEoffUj: 0,
    vRefV: 13.5,
    iRefA: 20,
    qrrNc: 13,
    eossUj: 0.2,
    dptLut,
    rgOnOhm: 10,
    rgOffOhm: 10,
    rgProvenance: 'measured' as const,
  };
  const ctrl = {
    modulation: 'SVPWM' as const,
    fswHz: 20000,
    tDeadNs: 200,
    modDepthM: 0.5,
    pfAngleDeg: 0,
    tAmbC: 25,
    vBusConstV: 13.5,
  };

  const rNonU = simulateFoc6Mos(makeChannel('ia', tNonU, iaNonU, 'A'), makeChannel('ib', tNonU, ibNonU, 'A'), DEFAULT_FOC_MODEL, mos, ctrl);
  const rUni = simulateFoc6Mos(makeChannel('iaU', tUni, iaUni, 'A'), makeChannel('ibU', tUni, ibUni, 'A'), DEFAULT_FOC_MODEL, mos, ctrl);

  assert.ok(
    Math.abs(rNonU.tjSteadyMaxEstC - rUni.tjSteadyMaxEstC) < 0.2,
    `Non-uniform steady Tj (${rNonU.tjSteadyMaxEstC.toFixed(3)}°C) diverged from uniform (${rUni.tjSteadyMaxEstC.toFixed(3)}°C)`
  );
});

test('Audit P0-Thermal-3: 6-MOS BUK7Q6R0-40H loss attribution, conservation & dead-time stall ceiling integrity', () => {
  // Datasheet honesty: BUK7Q6R0-40H profile explicitly marks numeric Eoss unavailable and Qr includes capacitive recovery
  assert.equal(BUK7Q6R0_40H_PROFILE.partNumber, 'BUK7Q6R0-40H');
  assert.equal(BUK7Q6R0_40H_PROFILE.capacitance.numericEossTableAvailable, false);
  assert.equal(BUK7Q6R0_40H_PROFILE.recoveredCharge.includesCapacitiveRecovery, true);
  assert.equal(BUK7Q6R0_40H_PROFILE.switchingEnergy.eonUj, null);
  assert.equal(BUK7Q6R0_40H_PROFILE.switchingEnergy.eoffUj, null);

  const bukMos = {
    rdsOn25Mohm: BUK7Q6R0_40H_PROFILE.rdsOn.typicalMohm,
    rdsOperatingVgsV: BUK7Q6R0_40H_PROFILE.rdsOn.referenceGateVoltageV,
    rds25ReferenceVgsV: BUK7Q6R0_40H_PROFILE.rdsOn.referenceGateVoltageV,
    rdsOnTempCurve: createBuk7Q6R0_40HRdsCurve(),
    rdsDataConfirmed: true,
    tempCoeffAlphaPerC: 0.0045,
    vsdV: BUK7Q6R0_40H_PROFILE.bodyDiode.vsdTypicalV,
    eonPlusEoffUj: 0,
    vRefV: 13.5,
    iRefA: 25,
    qrrNc: BUK7Q6R0_40H_PROFILE.recoveredCharge.qrNc,
    qrrIrefA: BUK7Q6R0_40H_PROFILE.recoveredCharge.referenceCurrentA,
    qrrIncludesQoss: BUK7Q6R0_40H_PROFILE.recoveredCharge.includesCapacitiveRecovery,
  };

  // Positive phase current (i > 0): dead-time body diode conducts in LOW-side switch; active switching in HIGH-side
  const lPos = computePhaseMosLosses(25, 0.6, 13.5, 80, 75, 'SVPWM', 20000, 300, {
    ...bukMos,
    eonPlusEoffUj: 30,
  });
  assert.equal(lPos.pHighDead, 0);
  assert.ok(lPos.pLowDead > 0);
  assert.ok(lPos.pHighSw > lPos.pLowSw);
  assert.ok(Math.abs(lPos.pHighTotal - (lPos.pHighCond + lPos.pHighSw + lPos.pHighDead)) < 1e-12);
  assert.ok(Math.abs(lPos.pLowTotal - (lPos.pLowCond + lPos.pLowSw + lPos.pLowDead)) < 1e-12);

  // Negative phase current (i < 0): dead-time body diode conducts in HIGH-side switch; active switching in LOW-side
  const lNeg = computePhaseMosLosses(-25, 0.4, 13.5, 75, 80, 'SVPWM', 20000, 300, {
    ...bukMos,
    eonPlusEoffUj: 30,
  });
  assert.equal(lNeg.pLowDead, 0);
  assert.ok(lNeg.pHighDead > 0);
  assert.ok(lNeg.pLowSw > lNeg.pHighSw);

  // Narrow-pulse guard in computePhaseMosLosses must remain strictly enforced
  assert.throws(
    () => computePhaseMosLosses(25, 0.998, 13.5, 60, 60, 'SVPWM', 20000, 200, bukMos),
    /脉冲宽度不足/
  );

  // Resistive voltage-limited stall at 13.5V with BUK7Q6R0-40H within datasheet Tj envelope [-55°C, 175°C]:
  // 30A * 0.35Ω = 10.5V > 13.5V / √3 = 7.79V => voltage-limited and clamped to dead-time-safe SVPWM ceiling
  const stall = runFocStallSweep({
    iPeakA: 30,
    tjLimitC: 175,
    tAmbC: 40,
    modulation: 'SVPWM',
    modDepthM: 0.9,
    fswHz: 20000,
    tDeadNs: 300,
    mos: bukMos,
    model: DEFAULT_FOC_MODEL,
    vBusV: 13.5,
    horizonSec: 30,
    stallDutyMode: 'resistive',
    rPhaseOhm: 0.35,
  });
  const expectedCeiling = getModulationLinearCeiling('SVPWM') * (1 - 2 * 300e-9 * 20000 - 1e-5);
  assert.equal(stall.stallVoltageLimited, true);
  assert.equal(stall.steadySafe, false);
  assert.ok(Math.abs(stall.effectiveStallModDepthM - expectedCeiling) < 1e-6);
  assert.ok(Number.isFinite(stall.worstSteadyTjC) && stall.worstSteadyTjC <= 175);

  // Over-stress stall driving Tj > 175°C must refuse silent linear extrapolation beyond BUK7Q6R0-40H datasheet curve
  assert.throws(
    () =>
      runFocStallSweep({
        iPeakA: 80,
        tjLimitC: 175,
        tAmbC: 85,
        modulation: 'SVPWM',
        modDepthM: 0.9,
        fswHz: 20000,
        tDeadNs: 300,
        mos: bukMos,
        model: DEFAULT_FOC_MODEL,
        vBusV: 13.5,
        horizonSec: 30,
        stallDutyMode: 'resistive',
        rPhaseOhm: 0.15,
      }),
    /禁止线性外推/
  );
});

test('Audit P1-Measure: hysteresis edge backtracking removes duty-cycle & pulse-width bias on slow asymmetric edges', () => {
  const n = 20000;
  const fs = 200000;
  const t = Float64Array.from({ length: n }, (_, i) => i / fs);
  const v = new Float32Array(n);
  const period = 1e-3;
  // Asymmetric trapezoid: 50us rise (crosses 5V at 25us), flat 10V to 450us, 400us fall (crosses 5V at 650us), flat 0V to 1000us
  // Exact +width = 625 us, exact duty = 62.500%, exact tr(10-90%) = 40 us, exact tf(90-10%) = 320 us
  for (let i = 0; i < n; i++) {
    const ph = (t[i] % period) / period;
    if (ph < 0.05) v[i] = 10 * (ph / 0.05);
    else if (ph < 0.45) v[i] = 10;
    else if (ph < 0.85) v[i] = 10 * (1 - (ph - 0.45) / 0.4);
    else v[i] = 0;
  }

  const m = computeMeasurements(
    makeChannel('asym_trap', t, v),
    'entire',
    { startIndex: 0, endIndex: n - 1 },
    { enabled: false, x1: null, x2: null, y1: null, y2: null, trackingChannel: null }
  );
  assert.ok(m.dutyCycle !== null && Math.abs(m.dutyCycle - 62.5) < 0.08, `Expected duty ~62.50%, got ${m.dutyCycle}`);
  assert.ok(m.posWidth !== null && Math.abs(m.posWidth * 1e6 - 625) < 0.8, `Expected +width ~625us, got ${m.posWidth ? m.posWidth * 1e6 : null}`);
  assert.ok(m.riseTime !== null && Math.abs(m.riseTime * 1e6 - 40) < 0.5, `Expected tr ~40us, got ${m.riseTime ? m.riseTime * 1e6 : null}`);
  assert.ok(m.fallTime !== null && Math.abs(m.fallTime * 1e6 - 320) < 1.0, `Expected tf ~320us, got ${m.fallTime ? m.fallTime * 1e6 : null}`);
});

test('Audit P1-Filter: RC passive highpass matches 0 dB passband and -3.01 dB cutoff for causal & zero-phase modes', () => {
  const fs = 10000;
  const fc = 500;
  const n = 4096;
  const t = Float64Array.from({ length: n }, (_, i) => i / fs);

  const measureGainDb = (freqHz: number, zeroPhase: boolean): number => {
    const v = Float32Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * freqHz * t[i]));
    const cfg = {
      ...createDefaultFilterConfig(fs),
      algorithm: 'rc_passive' as const,
      response: 'highpass' as const,
      order: 1,
      cutoffHz: fc,
      zeroPhase,
    };
    const res = applyWaveformFilter(t, v, cfg);
    let sOut = 0;
    let sIn = 0;
    for (let i = 1024; i < 3072; i++) {
      sOut += res.v[i] * res.v[i];
      sIn += v[i] * v[i];
    }
    return 20 * Math.log10(Math.sqrt(sOut / sIn));
  };

  const causalFcDb = measureGainDb(fc, false);
  const causalPassDb = measureGainDb(3500, false);
  const zeroPhaseFcDb = measureGainDb(fc, true);

  assert.ok(Math.abs(causalFcDb - -3.01) < 0.15, `RC HPF causal @ fc expected -3.01 dB, got ${causalFcDb.toFixed(2)} dB`);
  assert.ok(Math.abs(causalPassDb) < 0.15, `RC HPF causal passband expected ~0 dB, got ${causalPassDb.toFixed(2)} dB`);
  assert.ok(Math.abs(zeroPhaseFcDb - -3.01) < 0.2, `RC HPF zero-phase @ fc expected -3.01 dB, got ${zeroPhaseFcDb.toFixed(2)} dB`);

  // Verify consistency with Bode display
  const bode = computeFilterBodeResponse(
    { ...createDefaultFilterConfig(fs), algorithm: 'rc_passive', response: 'highpass', order: 1, cutoffHz: fc, zeroPhase: false },
    fs,
    256
  );
  let nearest = bode[0];
  for (const pt of bode) {
    if (Math.abs(pt.freqHz - fc) < Math.abs(nearest.freqHz - fc)) nearest = pt;
  }
  assert.ok(Math.abs(causalFcDb - nearest.magDb) < 0.2, `Time-domain (${causalFcDb.toFixed(2)} dB) must match Bode (${nearest.magDb.toFixed(2)} dB)`);
});

test('Audit P2-Scope: FFT window gain, non-2^n zero-padding, and MinMax decimator spike preservation', () => {
  const n = 1024;
  const fs = 10240;
  const f0 = 1000;
  const t = Float64Array.from({ length: n }, (_, i) => i / fs);
  const v = Float32Array.from({ length: n }, (_, i) => 2.5 + 3.0 * Math.sin(2 * Math.PI * f0 * t[i]));

  for (const win of ['rectangular', 'hann', 'hamming', 'blackman-harris'] as const) {
    const sp = computeFFT(
      t,
      v,
      fs,
      { range: 'entire', scale: 'magnitude', window: win, zeroPadding: 1, removeDC: true },
      'ch_fft',
      'FFT Test'
    );
    let pk = 1;
    for (let i = 2; i < sp.magnitudes.length; i++) {
      if (sp.magnitudes[i] > sp.magnitudes[pk]) pk = i;
    }
    assert.ok(Math.abs(sp.frequencies[pk] - f0) < 1e-6);
    assert.ok(Math.abs(sp.magnitudes[pk] - 3.0) < 1e-3, `FFT ${win} amplitude error: ${sp.magnitudes[pk]}`);
  }

  // Non-power-of-2 Bluestein + 4x zero padding
  const nOdd = 1000;
  const fsOdd = 10000;
  const tOdd = Float64Array.from({ length: nOdd }, (_, i) => i / fsOdd);
  const vOdd = Float32Array.from({ length: nOdd }, (_, i) => 1.5 + 2.0 * Math.cos(2 * Math.PI * 1000 * tOdd[i]));
  const spOdd = computeFFT(
    tOdd,
    vOdd,
    fsOdd,
    { range: 'entire', scale: 'magnitude', window: 'hann', zeroPadding: 4, removeDC: false },
    'ch_odd',
    'FFT Odd'
  );
  assert.ok(Math.abs(spOdd.magnitudes[0] - 1.5) < 1e-3);
  const bin1000 = Math.round(1000 / spOdd.resolution);
  assert.ok(Math.abs(spOdd.magnitudes[bin1000] - 2.0) < 2e-3);

  // MinMax decimator preserves isolated 1-sample positive/negative transients
  const nDec = 10000;
  const tDec = Float64Array.from({ length: nDec }, (_, i) => i * 1e-4);
  const vDec = Float32Array.from({ length: nDec }, (_, i) => Math.sin(2 * Math.PI * 5 * tDec[i]));
  vDec[4321] = 25.0;
  vDec[7654] = -18.0;
  const decPts = decimateMinMaxSegment(tDec, (i) => vDec[i], 0, nDec - 1, 500);
  let mx = -Infinity;
  let mn = Infinity;
  for (const pt of decPts) {
    if (pt.value > mx) mx = pt.value;
    if (pt.value < mn) mn = pt.value;
  }
  assert.equal(mx, 25.0);
  assert.equal(mn, -18.0);
});
