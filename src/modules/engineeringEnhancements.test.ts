import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WaveformChannel } from '../types/models';
import { analyzeSamplingQuality } from './qualityCheck';
import { computeMeasurements, evaluateCustomMeasurementDetailed, summarizeCycleDistribution } from './measurements';
import { analyzePwmSwitchingAndDeadTime } from './bldcAnalysis';
import { evaluateMathExpression, previewMathExpression } from './mathParser';
import {
  buildMappedReferenceTrace,
  canApplyCompareOverlay,
  computeAutoTimeAlignDetailed,
  exportCompareSummaryCsv,
} from './waveformCompare';
import { alignAndInterpolateReference } from './waveformCompare';
import { isLtspiceExportText, isLtspiceSteppedExportText } from '../parsers/ltspiceParser';
import { previewCsv, parseFullCsv } from '../parsers/csvParser';
import {
  DEFAULT_FOC_MODEL,
  FocControlParams,
  FocMosParams,
  createAutomotive12VMissionProfilePreset,
  simulateFoc6MosSteadyState,
  simulateFocMissionProfile,
  computeFocThermalDeratingCurve,
} from './focThermal';

function makeChannel(id: string, name: string, unit: string, t: number[], v: number[]): WaveformChannel {
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const x of v) {
    if (x < vMin) vMin = x;
    if (x > vMax) vMax = x;
  }
  const tArr = new Float64Array(t);
  const vArr = new Float32Array(v);
  const metadata = analyzeSamplingQuality(tArr);
  const dt = metadata.nominalDt || (tArr.length >= 2 ? (tArr[tArr.length - 1] - tArr[0]) / (tArr.length - 1) : 1e-4);
  const fs = dt > 0 ? 1 / dt : 10000;
  return {
    id,
    name,
    unit,
    color: '#22d3ee',
    visible: true,
    t: tArr,
    v: vArr,
    fs,
    dt,
    vMin,
    vMax,
    voltsPerDiv: 1,
    vOffset: 0,
    coupling: 'DC',
    inverted: false,
    isMath: false,
    sourceChannelIds: [],
    metadata,
  };
}

describe('Measure: Multi-cycle statistics, undershoot & 10-90% dv/dt slew rates', () => {
  it('measures +dv/dt, -dv/dt, undershoot, and SlewSym accurately on trapezoidal pulses', () => {
    // 5 periods of 20 us (50 kHz):
    // 0..1 us: linear rise 0 -> 10 V (+10 V/us = 1e7 V/s)
    // 1..8 us: flat high 10 V
    // 8..10 us: linear fall 10 -> 0 V (-5 V/us = 5e6 V/s)
    // 10..11 us: undershoot dip down to -1.0 V (10% of 10 V swing)
    // 11..20 us: flat low 0 V
    const dt = 25e-9; // 25 ns step -> 40 samples on 1 us rise edge
    const period = 20e-6;
    const total = 5 * period;
    const t: number[] = [];
    const v: number[] = [];
    for (let ti = 0; ti <= total; ti += dt) {
      const ph = ti % period;
      let val = 0;
      if (ph < 1e-6) {
        val = 10 * (ph / 1e-6);
      } else if (ph < 8e-6) {
        val = 10;
      } else if (ph < 10e-6) {
        val = 10 * (1 - (ph - 8e-6) / 2e-6);
      } else if (ph < 11e-6) {
        const u = (ph - 10e-6) / 1e-6;
        val = -1.0 * Math.sin(Math.PI * u);
      } else {
        val = 0;
      }
      t.push(ti);
      v.push(val);
    }

    const ch = makeChannel('ch_sw', 'Vds', 'V', t, v);
    const m = computeMeasurements(
      ch,
      'entire',
      { startIndex: 0, endIndex: ch.t.length },
      { enabled: false, mode: 'off', x1: null, x2: null, y1: null, y2: null, trackingChannel: null }
    );

    assert.equal(m.valid, true);
    assert.ok(typeof m.slewRateRise === 'number' && Math.abs(m.slewRateRise - 1e7) / 1e7 < 0.03, `expected +dv/dt ~ 1e7, got ${m.slewRateRise}`);
    assert.ok(typeof m.slewRateFall === 'number' && Math.abs(m.slewRateFall - 5e6) / 5e6 < 0.03, `expected -dv/dt ~ 5e6, got ${m.slewRateFall}`);
    assert.ok(m.undershoot !== null && Math.abs(m.undershoot - 10) < 1.5, `expected undershoot ~ 10%, got ${m.undershoot}`);
    assert.ok(m.cycleStats?.slewRateRise && m.cycleStats.slewRateRise.count >= 4);

    const sym = evaluateCustomMeasurementDetailed(
      { id: 'sym', label: 'SlewSym', shortLabel: 'SlewSym', expression: 'dvdt_rise / dvdt_fall', unitType: 'ratio' },
      ch,
      m,
      'entire',
      { startIndex: 0, endIndex: ch.t.length },
      { enabled: false, mode: 'off', x1: null, x2: null, y1: null, y2: null, trackingChannel: null }
    );
    assert.equal(sym.valid, true);
    assert.ok(sym.value !== null && Math.abs(sym.value - 2.0) < 0.08, `expected SlewSym ~ 2.0, got ${sym.value}`);
  });

  it('computes Welford multi-cycle statistics (mean, min, max, stdDev, count) and respects sampling gaps', () => {
    const stat = summarizeCycleDistribution([10, 12, 14, 16, 18]);
    assert.ok(stat);
    assert.equal(stat.count, 5);
    assert.equal(stat.min, 10);
    assert.equal(stat.max, 18);
    assert.ok(Math.abs(stat.mean - 14) < 1e-12);
    assert.ok(stat.stdDev !== null && Math.abs(stat.stdDev - Math.sqrt(10)) < 1e-10);

    // 8 cycles of a 1 kHz sine with amplitude ramping from 4 V to 7.5 V + a big time gap in the middle
    const t: number[] = [];
    const v: number[] = [];
    const dt = 20e-6;
    for (let cyc = 0; cyc < 8; cyc++) {
      const gapOffset = cyc >= 4 ? 0.05 : 0; // 50 ms gap between cycle 3 and 4
      const amp = 4 + cyc * 0.5;
      for (let k = 0; k < 50; k++) {
        const ti = cyc * 1e-3 + k * dt + gapOffset;
        t.push(ti);
        v.push(amp * Math.sin(2 * Math.PI * 1000 * (k * dt)));
      }
    }
    const ch = makeChannel('ch_sine', 'Ia', 'A', t, v);
    const m = computeMeasurements(
      ch,
      'entire',
      { startIndex: 0, endIndex: ch.t.length },
      { enabled: false, mode: 'off', x1: null, x2: null, y1: null, y2: null, trackingChannel: null }
    );
    assert.ok(m.cycleStats?.period && m.cycleStats.period.count >= 5);
    // Period must NOT be corrupted by the 50 ms gap
    assert.ok(Math.abs(m.cycleStats!.period!.mean - 1e-3) < 5e-5, `gap corrupted period mean: ${m.cycleStats!.period!.mean}`);
    assert.ok(m.cycleStats?.vpp && m.cycleStats.vpp.stdDev !== null && m.cycleStats.vpp.stdDev > 0.5, 'expected non-zero Vpp spread across ramping cycles');
  });
});

describe('Math: Multi-argument movrms/movavg/integ/hypot/atan2 and live preview', () => {
  it('computes movrms accurately on a non-uniform jittered sine grid and preserves unit', () => {
    const f = 100; // 100 Hz -> T = 10 ms
    const amp = 10;
    const t: number[] = [];
    const v: number[] = [];
    let cur = 0;
    for (let i = 0; i < 600; i++) {
      // Deterministic non-uniform step between 60 us and 140 us
      const step = 100e-6 * (1 + 0.35 * Math.sin(i * 0.73));
      if (i > 0) cur += step;
      t.push(cur);
      v.push(amp * Math.sin(2 * Math.PI * f * cur));
    }
    const ch1 = makeChannel('c1', 'Ia', 'A', t, v);
    const res = evaluateMathExpression('movrms(CH1, 0.02)', { c1: ch1 }, ['c1']);
    assert.equal(res.unit, 'A');

    const expected = amp / Math.sqrt(2);
    // Check steady region after 20 ms window fills
    let checked = 0;
    for (let i = 0; i < res.t.length; i++) {
      if (res.t[i] >= 0.025 && res.t[i] <= cur - 0.002) {
        assert.ok(Math.abs(res.v[i] - expected) / expected < 0.015, `movrms at t=${res.t[i]}: got ${res.v[i]}, exp ${expected}`);
        checked++;
      }
    }
    assert.ok(checked > 100);
  });

  it('computes gap-safe integ(CH1 * CH2) with W->J dimensional inference, hypot SI scaling, and atan2', () => {
    const t: number[] = [];
    const v1: number[] = [];
    const i1: number[] = [];
    // First segment 0..0.01 s (10 V * 5 A = 50 W -> 0.5 J), then a 1.0 s gap, then 1.01..1.02 s (another 0.5 J)
    for (let k = 0; k <= 100; k++) {
      t.push(k * 1e-4);
      v1.push(10);
      i1.push(5);
    }
    for (let k = 0; k <= 100; k++) {
      t.push(1.01 + k * 1e-4);
      v1.push(10);
      i1.push(5);
    }
    const chV = makeChannel('v', 'Vbus', 'V', t, v1);
    const chI = makeChannel('i', 'Ibus', 'A', t, i1);

    const energy = evaluateMathExpression('integ(CH1 * CH2)', { v: chV, i: chI }, ['v', 'i']);
    assert.equal(energy.unit, 'J');
    const finalJ = energy.v[energy.v.length - 1];
    assert.ok(Math.abs(finalJ - 1.0) < 0.02, `expected 1.0 J across two 10ms segments ignoring 1s gap, got ${finalJ}`);

    const chMa = makeChannel('ma', 'Id', 'mA', [0, 0.001, 0.002], [3000, 3000, 3000]);
    const chA = makeChannel('a', 'Iq', 'A', [0, 0.001, 0.002], [4, 4, 4]);
    const mag = evaluateMathExpression('hypot(CH1, CH2)', { ma: chMa, a: chA }, ['ma', 'a']);
    assert.equal(mag.unit, 'A');
    assert.ok(Math.abs(mag.v[1] - 5.0) < 1e-4);

    const ang = evaluateMathExpression('atan2(CH2, CH1)', { ma: chMa, a: chA }, ['ma', 'a']);
    assert.equal(ang.unit, 'rad');
    // Both arguments are same-dimension current (A and mA), SI-aligned before atan2 -> atan2(4 A, 3 A)
    assert.ok(Math.abs(ang.v[1] - Math.atan2(4, 3)) < 1e-4);

    // Arity validation & live preview
    const bad = previewMathExpression('movrms(CH1)', { v: chV }, ['v']);
    assert.equal(bad.valid, false);
    const good = previewMathExpression('integ(CH1 * CH2)', { v: chV, i: chI }, ['v', 'i']);
    assert.equal(good.valid, true);
    assert.equal(good.inferredUnit, 'J');
  });
});

describe('Compare: Falling-edge, threshold %, viewport scope, sub-bin xcorr & CSV export', () => {
  it('aligns falling edge with custom threshold %, viewport window, sub-bin xcorr, and flags periodic ambiguity', () => {
    const dt = 1e-5;
    const tTgt: number[] = [];
    const vTgt: number[] = [];
    const tRef: number[] = [];
    const vRef: number[] = [];
    // Two pulses: first falling edge at 2 ms, second falling edge at 6 ms. Reference is delayed by +0.35 ms.
    const trueShift = 0.35e-3;
    const pulseAt = (x: number) => {
      const p1 = x >= 1e-3 && x <= 2e-3 ? 10 : x > 2e-3 && x < 2.2e-3 ? 10 * (1 - (x - 2e-3) / 0.2e-3) : 0;
      const p2 = x >= 5e-3 && x <= 6e-3 ? 10 : x > 6e-3 && x < 6.2e-3 ? 10 * (1 - (x - 6e-3) / 0.2e-3) : 0;
      return p1 + p2;
    };
    for (let i = 0; i <= 1000; i++) {
      const ti = i * dt;
      tTgt.push(ti);
      vTgt.push(pulseAt(ti));
      tRef.push(ti);
      vRef.push(pulseAt(ti - trueShift));
    }
    const chTgt = makeChannel('tgt', 'Target', 'V', tTgt, vTgt);
    const chRef = makeChannel('ref', 'Ref', 'V', tRef, vRef);

    // Falling-edge 50%: ref falls at 2.45 ms, tgt falls at 2.10 ms => shift = tgt - ref = -0.35 ms
    const fall50 = computeAutoTimeAlignDetailed(chTgt, chRef, 'falling-edge', 1, { thresholdPct: 50 });
    assert.equal(fall50.matched, true);
    assert.ok(Math.abs(fall50.shiftSec - (-trueShift)) < 1.5e-5, `expected -0.35ms, got ${fall50.shiftSec}`);

    // Viewport-scoped falling-edge inside [4ms, 8ms] should anchor on pulse 2 (around 6 ms)
    const fallView = computeAutoTimeAlignDetailed(chTgt, chRef, 'falling-edge', 1, {
      thresholdPct: 90,
      targetTimeWindow: { tStart: 4e-3, tEnd: 8e-3 },
    });
    assert.equal(fallView.matched, true);
    assert.ok(fallView.targetAnchorTime !== null && fallView.targetAnchorTime > 5.5e-3);

    // Sub-bin xcorr on non-periodic pulse train
    const xc = computeAutoTimeAlignDetailed(chTgt, chRef, 'xcorr', 1);
    assert.equal(xc.matched, true);
    assert.ok(typeof xc.confidenceR === 'number' && xc.confidenceR > 0.95);
    assert.ok(Math.abs(xc.shiftSec - (-trueShift)) < 3e-5, `xcorr shift mismatch: ${xc.shiftSec}`);

    // Periodic multi-cycle sine should trigger periodic ambiguity warning
    const tPer: number[] = [];
    const s1: number[] = [];
    const s2: number[] = [];
    for (let i = 0; i < 600; i++) {
      const ti = i * 1e-4;
      tPer.push(ti);
      s1.push(Math.sin(2 * Math.PI * 100 * ti));
      s2.push(Math.sin(2 * Math.PI * 100 * (ti - 0.002)));
    }
    const perXc = computeAutoTimeAlignDetailed(
      makeChannel('p1', 'S1', 'V', tPer, s1),
      makeChannel('p2', 'S2', 'V', tPer, s2),
      'xcorr',
      1
    );
    assert.equal(perXc.ambiguousPeriodic, true);
    assert.ok(perXc.warning && perXc.warning.length > 0);

    // CSV export
    const csv = exportCompareSummaryCsv('Vds (V)', [
      {
        refLabel: 'Run1',
        sourceName: 'Ref',
        unit: 'V',
        timeScale: 1,
        timeShiftSec: -0.00035,
        toleranceStatus: 'PASS',
        metrics: {
          valid: true,
          status: 'OK',
          comparedSamples: 1000,
          totalSamples: 1000,
          invalidCount: 0,
          coveragePct: 100,
          coveredDurationSec: 0.01,
          targetDurationSec: 0.01,
          rmse: 0.01,
          mae: 0.008,
          maxAbsDiff: 0.05,
          maxAbsDiffTime: 0.002,
          maxAbsDiffIndex: 200,
          correlation: 0.9999,
          similarityPct: 99.8,
          targetVpp: 10,
          refVpp: 10,
        },
      },
    ]);
    assert.ok(csv.includes('Target,Reference,Source,Unit'));
    assert.ok(csv.includes('Run1'));
  });
});

describe('MOS Thermal: Mission Profile cycling & Ambient×Voltage Derating Curve', () => {
  const baseMos: FocMosParams = {
    rdsOn25Mohm: 6.0,
    rdsDataConfirmed: true,
    tempCoeffAlphaPerC: 0.0045,
    vsdV: 0.9,
    eonPlusEoffUj: 8,
    eossUj: 1.5,
    qrrNc: 25,
    vRefV: 13.5,
    iRefA: 30,
  };
  const baseCtrl: FocControlParams = {
    modulation: 'SVPWM',
    fswHz: 20_000,
    tDeadNs: 500,
    modDepthM: 0.75,
    pfAngleDeg: 0,
    tAmbC: 25,
    vBusConstV: 13.5,
  };

  it('converges single long-duration Mission Profile stage to simulateFoc6MosSteadyState (< 0.5°C)', () => {
    const steady = simulateFoc6MosSteadyState({
      model: DEFAULT_FOC_MODEL,
      mos: baseMos,
      ctrl: baseCtrl,
      operatingPoint: {
        mode: 'rotating',
        iqPeakA: 35,
        electricalFrequencyHz: 150,
      },
      integrationSamples: 720,
    });
    assert.equal(steady.steadyConverged, true);

    const mp = simulateFocMissionProfile({
      model: DEFAULT_FOC_MODEL,
      mos: baseMos,
      baseCtrl,
      stages: [
        {
          label: 'Long Steady',
          mode: 'rotating',
          durationSec: 120,
          iqPeakA: 35,
          electricalFrequencyHz: 150,
          vBusV: 13.5,
          modDepthM: 0.75,
          pfAngleDeg: 0,
          tAmbC: 25,
        },
      ],
      repeatCycles: 1,
      tjLimitC: 150,
      maxTimelinePoints: 600,
    });

    const endTj = mp.stageSummaries[0].tjEndC;
    assert.ok(
      Math.abs(endTj - steady.tjMaxSteadyC) < 0.5,
      `Mission Profile 120s end Tj (${endTj.toFixed(3)}°C) diverged from steady-state (${steady.tjMaxSteadyC.toFixed(3)}°C)`
    );
  });

  it('tracks multi-cycle thermal ratchet and rejects overmodulation in Mission Profile', () => {
    const preset = createAutomotive12VMissionProfilePreset(baseCtrl);
    const mp = simulateFocMissionProfile({
      model: DEFAULT_FOC_MODEL,
      mos: baseMos,
      baseCtrl,
      stages: preset,
      repeatCycles: 3,
      tjLimitC: 150,
      maxTimelinePoints: 800,
    });
    assert.equal(mp.cyclePeakTjC.length, 3);
    assert.ok(mp.cyclePeakTjC[2] > mp.cyclePeakTjC[0], `expected positive thermal ratchet across 3 cycles: ${mp.cyclePeakTjC}`);
    assert.ok(mp.ratchetDeltaTjC !== null && mp.ratchetDeltaTjC >= 0);

    // Overmodulation > 2/sqrt(3) must throw
    assert.throws(() => {
      simulateFocMissionProfile({
        model: DEFAULT_FOC_MODEL,
        mos: baseMos,
        baseCtrl,
        stages: [{ ...preset[0], modDepthM: 1.35 }],
        repeatCycles: 1,
      });
    });
  });

  it('computes monotone Derating Curve with honest ZERO_MARGIN and VOLTAGE_LIMITED guards', () => {
    // At ref 13.5V with m = 0.85, 9V requires m = 0.85 * 13.5 / 9 = 1.275 > 1.1547 -> VOLTAGE_LIMITED!
    const derateCtrl: FocControlParams = { ...baseCtrl, modDepthM: 0.85 };
    const dr = computeFocThermalDeratingCurve({
      model: DEFAULT_FOC_MODEL,
      mos: baseMos,
      ctrl: derateCtrl,
      operatingPointTemplate: { mode: 'rotating', electricalFrequencyHz: 150 },
      tjLimitC: 150,
      tAmbPointsC: [25, 65, 105, 155],
      vBusPointsV: [9, 13.5, 16],
      referenceVoltageV: 13.5,
      iMaxSearchA: 250,
    });

    // 1. All 9V points must be VOLTAGE_LIMITED with null current (never fabricated)
    const pts9 = dr.points.filter((p) => p.vBusV === 9);
    assert.equal(pts9.length, 4);
    for (const p of pts9) {
      assert.equal(p.limitReason, 'VOLTAGE_LIMITED');
      assert.equal(p.iRmsMaxA, null);
    }

    // 2. 13.5V points: monotone decreasing with Tamb, tjAtMaxC <= tjLimitC, and 155°C -> ZERO_MARGIN
    const pts135 = dr.points.filter((p) => p.vBusV === 13.5).sort((a, b) => a.tAmbC - b.tAmbC);
    assert.equal(pts135.length, 4);
    assert.ok(pts135[0].iRmsMaxA !== null && pts135[1].iRmsMaxA !== null && pts135[2].iRmsMaxA !== null);
    assert.ok(pts135[0].iRmsMaxA! > pts135[1].iRmsMaxA!, 'expected I_rms,max(25°C) > I_rms,max(65°C)');
    assert.ok(pts135[1].iRmsMaxA! > pts135[2].iRmsMaxA!, 'expected I_rms,max(65°C) > I_rms,max(105°C)');
    for (const p of pts135.slice(0, 3)) {
      assert.ok(p.tjAtMaxC !== null && p.tjAtMaxC <= 150.25, `Tj exceeded limit: ${p.tjAtMaxC}`);
    }
    assert.equal(pts135[3].limitReason, 'ZERO_MARGIN');
    assert.equal(pts135[3].iRmsMaxA, 0);

    // 3. CSV serialization check
    assert.ok(dr.csvContent.includes('Vbus_V,Tamb_C,Required_m,Ipeak_max_A,Irms_max_A'));
    assert.ok(dr.csvContent.includes('VOLTAGE_LIMITED'));
  });

  it('prevents 2x PWM frequency doubling under >100% overshoot, turn-on dips, turn-off spikes, and low duty cycles', () => {
    const fs = 2_000_000; // 0.5 us per sample
    const n = 400; // 200 us = 4 cycles of 20 kHz (50 us period)
    const t: number[] = [];
    const vRinging: number[] = [];
    const vLowDuty: number[] = [];
    for (let i = 0; i < n; i++) {
      const ti = i / fs;
      t.push(ti);
      const phaseUs = ((ti * 1e6) % 50 + 50) % 50;
      // 12V steady plateau with 36V (>100%) turn-on overshoot, a deep 1.5V bounce dip at 1.5 us,
      // and a 10V turn-off spike at 26.5 us during the low phase.
      let val = phaseUs < 25 ? 12 : 0;
      if (phaseUs >= 0 && phaseUs < 1.0) val = 36;
      else if (phaseUs >= 1.0 && phaseUs < 2.0) val = 1.5;
      else if (phaseUs >= 26.5 && phaseUs < 27.5) val = 10;
      vRinging.push(val);

      // 4% low-duty (2 us high / 50 us period) with 30V turn-on spike
      let lowD = phaseUs < 2 ? 12 : 0;
      if (phaseUs >= 0 && phaseUs < 0.5) lowD = 30;
      vLowDuty.push(lowD);
    }

    const cursors = { enabled: false, mode: 'off' as const, x1: null, x2: null, y1: null, y2: null, trackingChannel: null };
    const chRing = makeChannel('pwm_ring', 'V_sw', 'V', t, vRinging);
    const mRing = computeMeasurements(chRing, 'entire', { startIndex: 0, endIndex: n }, cursors);
    assert.ok(mRing.frequency !== null && Math.abs(mRing.frequency - 20000) < 500, `Expected ~20kHz, got ${mRing.frequency}`);

    const bldcRing = analyzePwmSwitchingAndDeadTime(chRing, null, t[0], t[n - 1]);
    assert.ok(bldcRing.pwmFreqHz !== null && Math.abs(bldcRing.pwmFreqHz - 20000) < 500, `Expected BLDC ~20kHz, got ${bldcRing.pwmFreqHz}`);

    const chLow = makeChannel('pwm_low', 'V_low_duty', 'V', t, vLowDuty);
    const mLow = computeMeasurements(chLow, 'entire', { startIndex: 0, endIndex: n }, cursors);
    assert.ok(mLow.frequency !== null && Math.abs(mLow.frequency - 20000) < 600, `Expected low-duty ~20kHz, got ${mLow.frequency}`);
    assert.ok(mLow.dutyCycle !== null && mLow.dutyCycle > 2 && mLow.dutyCycle < 8, `Expected ~4% duty, got ${mLow.dutyCycle}`);
  });

  it('routes single-run 2-column TXT files to the import wizard and parses space-padded columns cleanly', () => {
    const singleRunTxt = 'time\tV(sw)\n0.0\t0\n0.0001\t12\n0.0002\t12\n';
    assert.equal(isLtspiceExportText(singleRunTxt), true);
    assert.equal(isLtspiceSteppedExportText(singleRunTxt), false);

    const steppedTxt = 'time\tV(sw)\nStep Information: R=1 (Run: 1/2)\n0.0\t0\n0.0001\t12\n';
    assert.equal(isLtspiceSteppedExportText(steppedTxt), true);

    const spacePaddedTxt = '  time    Vsw\n  0.000   0.0\n  0.001   12.0\n  0.002   0.0\n';
    const prev = previewCsv(spacePaddedTxt);
    assert.equal(prev.headers.length, 2);
    const parsed = parseFullCsv(spacePaddedTxt, {
      delimiter: prev.delimiter,
      hasHeader: prev.hasHeader,
      skipLines: prev.skipLines,
      timeColIndex: prev.timeColIndex,
      timeUnit: prev.timeUnit,
      columnMappings: prev.columnMappings,
      resample: false,
      colors: ['#22d3ee'],
    });
    assert.equal(parsed.drawOrder.length, 1);
    assert.deepEqual(Array.from(parsed.channels[parsed.drawOrder[0]].v), [0, 12, 0]);
  });

  it('allows Compare overlay when target and reference have non-overlapping time axes', () => {
    const target = makeChannel('tgt', 'Target', 'V', [0, 0.001, 0.002, 0.003], [0, 5, 0, 5]);
    const ref = makeChannel('ref', 'Ref', 'V', [10.0, 10.001, 10.002, 10.003], [0, 4.8, 0.1, 4.9]);
    const aligned = alignAndInterpolateReference(target, ref, 0, false, 1);
    assert.equal(aligned.valid, false);
    assert.equal(aligned.status, 'INSUFFICIENT_DATA');

    const mapped = buildMappedReferenceTrace(target, ref, 0, false, 1);
    assert.equal(mapped.t.length, 4);
    assert.equal(canApplyCompareOverlay(aligned.status, mapped.t, true, aligned.valid), true);
    assert.equal(canApplyCompareOverlay(aligned.status, mapped.t, false, aligned.valid), false);
  });
});
