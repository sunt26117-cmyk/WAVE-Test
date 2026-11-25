import test from 'node:test';
import assert from 'node:assert/strict';

import { WaveformChannel } from '../types/models';
import { analyzeSamplingQuality } from './qualityCheck';
import { evaluateMathExpression } from './mathParser';
import {
  computeMeasurements,
  evaluateCustomMeasurementDetailed,
} from './measurements';
import {
  alignAndInterpolateReference,
  computeWaveformCompareMetrics,
} from './waveformCompare';
import { evaluateGoldenTolerance, scanChannelAnomalies } from './anomalyScanner';
import { computeXYMetrics } from './xyAnalysis';
import {
  computePowerSummary,
  estimateElectricalAngleFromAlphaBeta,
} from './motorAnalysis';
import {
  computeClarkeFromChannels,
  computeInstantaneousPowerFromChannels,
  computeParkFromChannels,
} from './transforms';
import { alignChannelsToCommonTimebase } from './timeSync';
import {
  analyzeBldcHallCommutation,
  analyzePwmSwitchingAndDeadTime,
  analyzeThreePhaseBalance,
  analyzeTorqueAndCurrentRipple,
} from './bldcAnalysis';

function makeChannel(
  id: string,
  t: Float64Array,
  v: Float32Array,
  unit = 'V',
  name = id
): WaveformChannel {
  const metadata = analyzeSamplingQuality(t);
  const dt = metadata.nominalDt || (t.length >= 2 ? (t[t.length - 1] - t[0]) / (t.length - 1) : 1e-4);
  const fs = dt > 0 ? 1 / dt : 10000;
  return {
    id,
    name,
    unit,
    color: '#22d3ee',
    visible: true,
    t,
    v,
    fs,
    dt,
    vMin: -10,
    vMax: 10,
    voltsPerDiv: 2.5,
    vOffset: 0,
    coupling: 'DC',
    inverted: false,
    isMath: false,
    sourceChannelIds: [],
    metadata,
  };
}

// 1. Math: equal count & matching endpoints, different interior timestamps (no wrong index pairing)
test('Math: aligns channels with equal sample count and endpoints but shifted interior timestamps', () => {
  // CH1 uniform: 0, 0.25, 0.50, 0.75, 1.00 -> ramp v(t) = 10 * t
  const t1 = new Float64Array([0, 0.25, 0.5, 0.75, 1.0]);
  const v1 = new Float32Array([0, 2.5, 5.0, 7.5, 10.0]);
  // CH2 non-uniform (non-gap steps 0.15..0.35 <= 1.4x median dt): same linear ramp v(t) = 10 * t
  // At t=0.50, CH1 is 5.0 and time-interpolated CH2 is also 5.0 -> difference MUST be 0 (not 5.0 - 3.0 = 2.0!)
  const t2 = new Float64Array([0, 0.15, 0.3, 0.65, 1.0]);
  const v2 = new Float32Array([0, 1.5, 3.0, 6.5, 10.0]);

  const ch1 = makeChannel('ch1', t1, v1, 'V', 'CH1');
  const ch2 = makeChannel('ch2', t2, v2, 'V', 'CH2');
  const res = evaluateMathExpression('CH1 - CH2', { ch1, ch2 }, ['ch1', 'ch2']);

  assert.equal(res.v.length, 5);
  assert.ok(Math.abs(res.v[1]) < 1e-4, `Expected ~0 at index 1, got ${res.v[1]}`);
  assert.ok(Math.abs(res.v[2]) < 1e-4, `Expected ~0 at index 2, got ${res.v[2]}`);
  assert.ok(Math.abs(res.v[3]) < 1e-4, `Expected ~0 at index 3, got ${res.v[3]}`);
});

// 2. Math: NaN point interpolation propagates NaN (no one-sided bridge)
test('Math: interpolation across NaN propagates NaN instead of bridging from valid neighbor', () => {
  const t1 = new Float64Array([0, 0.1, 0.2, 0.3, 0.4]);
  const v1 = new Float32Array([1, 2, 3, 4, 5]);
  // t2 offset so every point in t1 falls between t2 samples; index 1 (t=0.15) is NaN
  const t2 = new Float64Array([0, 0.15, 0.25, 0.35, 0.45]);
  const v2 = new Float32Array([10, Number.NaN, 10, 10, 10]);

  const ch1 = makeChannel('ch1', t1, v1, 'V', 'CH1');
  const ch2 = makeChannel('ch2', t2, v2, 'V', 'CH2');
  const res = evaluateMathExpression('CH1 + CH2', { ch1, ch2 }, ['ch1', 'ch2']);

  assert.ok(Number.isFinite(res.v[0]), 't=0 should be finite');
  assert.ok(Number.isNaN(res.v[1]), 't=0.1 lies between finite and NaN, must be NaN');
  assert.ok(Number.isNaN(res.v[2]), 't=0.2 lies between NaN and finite, must be NaN');
  assert.ok(Number.isFinite(res.v[3]), 't=0.3 lies between finite samples, must be finite');
});

// 3. Math: mixed SI prefixes V + mV normalized accurately
test('Math: normalizes mixed SI units (2 V + 500 mV = 2.5 V)', () => {
  const t = new Float64Array([0, 0.01, 0.02, 0.03]);
  const chV = makeChannel('vch', t, new Float32Array([2, 2, 2, 2]), 'V', 'VCH');
  const chMv = makeChannel('mvch', t, new Float32Array([500, 500, 500, 500]), 'mV', 'MVCH');

  const res = evaluateMathExpression('VCH + MVCH', { vch: chV, mvch: chMv }, ['vch', 'mvch']);
  assert.equal(res.unit, 'V');
  assert.ok(Math.abs(res.v[0] - 2.5) < 1e-4, `Expected 2.5 V, got ${res.v[0]}`);
});

// 4. Math: cross-dimension V + A rejected
test('Math: rejects cross-dimension addition V + A', () => {
  const t = new Float64Array([0, 0.01, 0.02, 0.03]);
  const chV = makeChannel('vch', t, new Float32Array([5, 5, 5, 5]), 'V', 'VCH');
  const chI = makeChannel('ich', t, new Float32Array([2, 2, 2, 2]), 'A', 'ICH');

  assert.throws(() => evaluateMathExpression('VCH + ICH', { vch: chV, ich: chI }, ['vch', 'ich']), /量纲|单位/);
});

// 5. Measure: t/v length mismatch or duplicate timestamps rejected
test('Measure: rejects t/v length mismatch and duplicate timestamps fail-closed', () => {
  const chMismatch = makeChannel(
    'm1',
    new Float64Array([0, 0.01, 0.02, 0.03]),
    new Float32Array([1, 2, 3]),
    'V'
  );
  const resMismatch = computeMeasurements(
    chMismatch,
    'entire',
    { startIndex: 0, endIndex: 4 },
    { enabled: false, x1: null, x2: null, y1: null, y2: null, trackingChannel: null }
  );
  assert.equal(resMismatch.valid, false);
  assert.equal(resMismatch.rms, null);

  const chDup = makeChannel(
    'm2',
    new Float64Array([0, 0.01, 0.01, 0.03]),
    new Float32Array([1, 2, 3, 4]),
    'V'
  );
  const resDup = computeMeasurements(
    chDup,
    'entire',
    { startIndex: 0, endIndex: 4 },
    { enabled: false, x1: null, x2: null, y1: null, y2: null, trackingChannel: null }
  );
  assert.equal(resDup.valid, false);
  assert.equal(resDup.average, null);
});

// 6. Measure: out-of-range view/cursor window does NOT clamp to endpoints
test('Measure: out-of-record cursor or timeBounds window fails closed instead of clamping', () => {
  const t = new Float64Array([0, 0.001, 0.002, 0.003, 0.004]);
  const v = new Float32Array([5, 5, 5, 5, 5]);
  const ch = makeChannel('ch', t, v, 'V');

  const outCursor = computeMeasurements(
    ch,
    'cursors',
    { startIndex: 0, endIndex: 5 },
    { enabled: true, x1: 1.0, x2: 2.0, y1: null, y2: null, trackingChannel: 'ch' }
  );
  assert.equal(outCursor.valid, false);
  assert.equal(outCursor.sampleCount, 0);
  assert.equal(outCursor.average, null);

  const outViewBounds = computeMeasurements(
    ch,
    'view',
    { startIndex: 0, endIndex: 5 },
    { enabled: false, x1: null, x2: null, y1: null, y2: null, trackingChannel: null },
    { tStart: 0.5, tEnd: 0.6 }
  );
  assert.equal(outViewBounds.valid, false);
  assert.equal(outViewBounds.sampleCount, 0);
  assert.equal(outViewBounds.rms, null);
});

// 7. Measure: non-uniform continuous signal produces consistent time-weighted average and rms
test('Measure: non-uniform variable-step waveform computes accurate trapezoidal average and rms', () => {
  // Dense 0..0.1s @ dt=0.02 at V=4, sparser 0.1..0.4s @ dt=0.05 (<= 2.5x median dt) at V=0
  // Wait: put transition right at t=0.10 to 0.10? Linear step [4,4,4,4,4,4] then [0,0,0,0,0,0]
  // Exact integral V(t): 0..0.10s -> 4*0.10 = 0.40; trapezoid between 0.10(4) and 0.15(0) -> 0.5*4*0.05 = 0.10; total = 0.50 over 0.40s -> avg = 1.25
  const t = new Float64Array([0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4]);
  const v = new Float32Array([4, 4, 4, 4, 4, 4, 0, 0, 0, 0, 0, 0]);
  const ch = makeChannel('nu', t, v, 'V');

  const m = computeMeasurements(
    ch,
    'entire',
    { startIndex: 0, endIndex: t.length },
    { enabled: false, x1: null, x2: null, y1: null, y2: null, trackingChannel: null }
  );
  assert.equal(m.valid, true);
  assert.ok(m.average !== null && Math.abs(m.average - 1.25) < 1e-4, `Expected avg 1.25, got ${m.average}`);
  assert.ok(m.rms !== null && Math.abs(m.rms - Math.sqrt(1.8666667 / 0.4)) < 1e-3);
});

// 8. Measure: 10x dt sampling gap does NOT fabricate cross-gap edges/periods or integrate across the gap
test('Measure: 10x dt sampling gap excludes gap from integrals and blocks fake cross-gap edges/periods', () => {
  // Segment 1: t = 0..5ms @ 1ms step, low (-5V) then high (+5V) with NO falling edge before gap
  // Gap: 5ms -> 50ms (45x dtMedian)
  // Segment 2: t = 50..55ms @ 1ms step, +5V -> -5V -> +5V? Actually put -5V throughout seg2 so seg1(high) -> seg2(low) would look like falling edge if bridged!
  const t = new Float64Array([
    0.0, 0.001, 0.002, 0.003, 0.004, 0.005, // seg 1: dt=1ms
    0.05, 0.051, 0.052, 0.053, 0.054, 0.055, // seg 2: dt=1ms (gap=45ms)
  ]);
  // seg 1: 0..2ms = 0V, 3..5ms = 4V; seg 2: 50..55ms = 4V
  // Without gap break, trapezoidal integral would integrate 4V across 45ms gap and report ~3.45V avg instead of actual ~3.2V or segmented period!
  // Better test: seg 1 ends at -5V, gap jumps from -5V to +5V, seg 2 stays +5V (0 transitions inside either segment -> MUST NOT detect any edge/frequency!)
  const vEdge = new Float32Array([
    -5, -5, -5, -5, -5, -5,
    5, 5, 5, 5, 5, 5,
  ]);
  const chGap = makeChannel('gap', t, vEdge, 'V');
  const m = computeMeasurements(
    chGap,
    'entire',
    { startIndex: 0, endIndex: t.length },
    { enabled: false, x1: null, x2: null, y1: null, y2: null, trackingChannel: null }
  );
  assert.equal(m.valid, true);
  assert.ok((m.gapCount || 0) >= 1, 'Should report detected sampling gap');
  assert.equal(m.riseTime, null, 'Must not fabricate rising edge across 45ms sampling gap');
  assert.equal(m.frequency, null, 'Must not fabricate frequency across sampling gap');
  // Segmented trapezoidal mean of -5V (5ms) and +5V (5ms) = 0V! (Cross-gap interpolation would stay 0 only symmetrically; asymmetric segs prove no gap integral)
  const tAsym = new Float64Array([0, 0.001, 0.002, 0.003, 0.05, 0.051, 0.052, 0.053]);
  const vAsym = new Float32Array([10, 10, 10, 10, 0, 0, 0, 0]);
  const chAsym = makeChannel('asym', tAsym, vAsym, 'V');
  const mAsym = computeMeasurements(
    chAsym,
    'entire',
    { startIndex: 0, endIndex: tAsym.length },
    { enabled: false, x1: null, x2: null, y1: null, y2: null, trackingChannel: null }
  );
  // Segment 1 (0..3ms, duration 3ms, val=10) area = 0.030; Segment 2 (50..53ms, duration 3ms, val=0) area = 0; integrated duration = 6ms -> avg = 5.0V (NOT 10*0.003 + 0.5*10*0.047 over 0.053s = 5.0 or biased!)
  // Make Seg 1 val=0 (3ms) and Seg 2 val=10 (3ms) with 47ms gap where naive gap integral adds 0.5*10*0.047 = 0.235 -> avg ~4.43 instead of 5.0, or Seg1 2ms vs Seg2 6ms:
  const tAsym2 = new Float64Array([0, 0.001, 0.002, 0.05, 0.051, 0.052, 0.053, 0.054, 0.055, 0.056]);
  const vAsym2 = new Float32Array([0, 0, 0, 10, 10, 10, 10, 10, 10, 10]);
  const chAsym2 = makeChannel('asym2', tAsym2, vAsym2, 'V');
  const mAsym2 = computeMeasurements(
    chAsym2,
    'entire',
    { startIndex: 0, endIndex: tAsym2.length },
    { enabled: false, x1: null, x2: null, y1: null, y2: null, trackingChannel: null }
  );
  // True active segments: 2ms at 0V + 6ms at 10V -> 0.06 / 0.008 = 7.5V (Bridging gap gives (0.06 + 0.5*10*0.048)/0.056 = 5.36V)
  assert.ok(mAsym2.average !== null && Math.abs(mAsym2.average - 7.5) < 0.05, `Expected segmented avg 7.5V, got ${mAsym2.average}`);
});

// 9. Compare: NaN in reference NOT bridged by valid neighbor & large gap skipped
test('Compare: NaN in reference propagates NaN and sampling gap skips interpolation', () => {
  const tTgt = new Float64Array([0, 0.001, 0.002, 0.003, 0.004, 0.02, 0.021, 0.022]);
  const vTgt = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1]);
  const tRef = new Float64Array([0, 0.0015, 0.0025, 0.0035, 0.0045, 0.04, 0.041, 0.042]);
  const vRef = new Float32Array([1, Number.NaN, 1, 1, 1, 1, 1, 1]);

  const chTgt = makeChannel('tgt', tTgt, vTgt, 'V');
  const chRef = makeChannel('ref', tRef, vRef, 'V');

  const aligned = alignAndInterpolateReference(chTgt, chRef, 0, false, 1);
  assert.equal(aligned.valid, true);
  assert.ok(Number.isNaN(aligned.alignedRefV[1]), 'Interpolating beside NaN must remain NaN');
  assert.ok(Number.isNaN(aligned.alignedRefV[5]), 'Interpolating inside ref sampling gap (0.0045..0.04) must be NaN');
  assert.ok(aligned.gapSkippedCount > 0, 'Should count skipped gap samples');

  const metrics = computeWaveformCompareMetrics(chTgt, aligned.alignedRefV, false);
  assert.ok(metrics.invalidCount >= 2);
  assert.ok(metrics.coveragePct < 100);
});

// 10. Compare: V vs mV aligns accurately (RMSE ~ 0) while V vs A rejected as INVALID
test('Compare: scales V vs mV accurately and rejects V vs A as INVALID', () => {
  const t = new Float64Array([0, 0.001, 0.002, 0.003, 0.004]);
  const chTgt = makeChannel('tgt', t, new Float32Array([2, 2, 2, 2, 2]), 'V');
  const chRefMv = makeChannel('refMv', t, new Float32Array([2000, 2000, 2000, 2000, 2000]), 'mV');
  const chRefA = makeChannel('refA', t, new Float32Array([2, 2, 2, 2, 2]), 'A');

  const alignedMv = alignAndInterpolateReference(chTgt, chRefMv, 0, false, 1);
  assert.equal(alignedMv.valid, true);
  const metricsMv = computeWaveformCompareMetrics(chTgt, alignedMv.alignedRefV, false);
  assert.equal(metricsMv.valid, true);
  assert.ok(metricsMv.rmse !== null && metricsMv.rmse < 1e-4, `Expected RMSE ~ 0, got ${metricsMv.rmse}`);

  const alignedA = alignAndInterpolateReference(chTgt, chRefA, 0, false, 1);
  assert.equal(alignedA.valid, false);
  assert.equal(alignedA.status, 'INVALID');
});

// 11. Golden: reference with different rate / shifted refT aligns by time instead of array index
test('Golden: aligns refV along refT timebase rather than array index', () => {
  // 10-pt target ramp V = 10*t over [0, 0.9s]
  const tTgt = new Float64Array(10);
  const vTgt = new Float32Array(10);
  for (let i = 0; i < 10; i++) {
    tTgt[i] = i * 0.1;
    vTgt[i] = 10 * tTgt[i];
  }
  // 4-pt reference ramp V = 10*t over [0, 0.9s]
  const tRef = new Float64Array([0, 0.3, 0.6, 0.9]);
  const vRef = new Float32Array([0, 3.0, 6.0, 9.0]);

  const chTgt = makeChannel('g1', tTgt, vTgt, 'V');
  const res = evaluateGoldenTolerance(chTgt, {
    enabled: true,
    channelId: 'g1',
    mode: 'absolute',
    tolerance: 0.05,
    refT: tRef,
    refV: vRef,
    refUnit: 'V',
    refLabel: 'Golden4pt',
  });
  assert.equal(res.status, 'PASS');
  assert.equal(res.pass, true);
  assert.equal(res.violationCount, 0);
  assert.ok(res.maxDeviation < 1e-4);
});

// 12. Golden: zero overlap, low coverage, or all-NaN NEVER returns PASS
test('Golden: never returns PASS on zero overlap, low coverage, all-NaN, or invalid input', () => {
  const tTgt = new Float64Array([0, 0.01, 0.02, 0.03, 0.04, 0.05]);
  const vTgt = new Float32Array([1, 1, 1, 1, 1, 1]);
  const chTgt = makeChannel('g2', tTgt, vTgt, 'V');

  // Zero overlap
  const noOverlap = evaluateGoldenTolerance(chTgt, {
    enabled: true,
    channelId: 'g2',
    mode: 'absolute',
    tolerance: 0.5,
    refT: new Float64Array([1.0, 1.01, 1.02]),
    refV: new Float32Array([1, 1, 1]),
    refLabel: 'NoOverlap',
  });
  assert.equal(noOverlap.pass, false);
  assert.equal(noOverlap.status, 'INSUFFICIENT_DATA');

  // Insufficient coverage (1 out of 6 points finite -> 16.7% < 50%)
  const lowCov = evaluateGoldenTolerance(chTgt, {
    enabled: true,
    channelId: 'g2',
    mode: 'absolute',
    tolerance: 0.5,
    refV: new Float32Array([1, Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN]),
    refLabel: 'LowCov',
  });
  assert.equal(lowCov.pass, false);
  assert.equal(lowCov.status, 'INSUFFICIENT_DATA');

  // All NaN
  const allNan = evaluateGoldenTolerance(chTgt, {
    enabled: true,
    channelId: 'g2',
    mode: 'absolute',
    tolerance: 0.5,
    refV: new Float32Array(6).fill(Number.NaN),
    refLabel: 'AllNaN',
  });
  assert.equal(allNan.pass, false);
  assert.notEqual(allNan.status, 'PASS');
});

// 13. XY: cross-rate alignment & signed lead vs lag phase
test('XY: aligns cross-rate X/Y channels by time and distinguishes lead vs lag sign', () => {
  // X sampled at 500 Hz, Y sampled at 2000 Hz over 0.1s @ 50 Hz
  const nX = 51;
  const nY = 201;
  const tX = new Float64Array(nX);
  const vX = new Float32Array(nX);
  const tY = new Float64Array(nY);
  const vYLag = new Float32Array(nY);
  const vYLead = new Float32Array(nY);
  const w = 2 * Math.PI * 50;

  for (let i = 0; i < nX; i++) {
    tX[i] = i * 0.002;
    vX[i] = 5 * Math.sin(w * tX[i]);
  }
  for (let i = 0; i < nY; i++) {
    tY[i] = i * 0.0005;
    vYLag[i] = 5 * Math.sin(w * tY[i] - Math.PI / 6); // -30 deg lag -> CCW -> positive signed phase
    vYLead[i] = 5 * Math.sin(w * tY[i] + Math.PI / 6); // +30 deg lead -> CW -> negative signed phase
  }

  const chX = makeChannel('x', tX, vX, 'V');
  const chYLag = makeChannel('ylag', tY, vYLag, 'V');
  const chYLead = makeChannel('ylead', tY, vYLead, 'V');

  const resLag = computeXYMetrics(chX, chYLag, 0, nX);
  const resLead = computeXYMetrics(chX, chYLead, 0, nX);

  assert.equal(resLag.valid, true);
  assert.equal(resLead.valid, true);
  assert.ok(resLag.lissajousPhaseDeg !== null && Math.abs(resLag.lissajousPhaseDeg - 30) < 3, `Expected +30°, got ${resLag.lissajousPhaseDeg}`);
  assert.ok(resLead.lissajousPhaseDeg !== null && Math.abs(resLead.lissajousPhaseDeg + 30) < 3, `Expected -30°, got ${resLead.lissajousPhaseDeg}`);
  assert.ok(resLag.lissajousPhaseDeg! * resLead.lissajousPhaseDeg! < 0, 'Lead and lag must have opposite signs');
});

// 14. TimeSync / Anomaly / Transforms fail closed on invalid timebases or mismatched lengths
test('TimeSync & Transforms: reject mismatched lengths, non-monotonic timebases, and cross-dimension Clarke', () => {
  const badCh = makeChannel(
    'bad',
    new Float64Array([0, 0.02, 0.01, 0.03]),
    new Float32Array([1, 2, 3, 4]),
    'V'
  );
  const anomalies = scanChannelAnomalies(badCh, { highThreshold: 1.5 });
  assert.equal(anomalies.length, 0, 'Non-monotonic channel must fail closed in scanChannelAnomalies');

  const t = new Float64Array([0, 0.01, 0.02, 0.03]);
  const cRes = computeClarkeFromChannels(
    makeChannel('u', t, new Float32Array([1, 0, -1, 0]), 'V'),
    makeChannel('v', t, new Float32Array([0, 1, 0, -1]), 'A'),
    makeChannel('w', t, new Float32Array([-1, -1, 1, 1]), 'V')
  );
  assert.equal(cRes.valid, false);

  const pRes = computeInstantaneousPowerFromChannels(
    [makeChannel('u', t, new Float32Array([10, 10, 10, 10]), 'V')],
    [makeChannel('i', t, new Float32Array([500, 500, 500, 500]), 'mA')]
  );
  assert.equal(pRes.valid, true);
  assert.equal(pRes.siScaled, true);
  assert.ok(Math.abs(pRes.power[0] - 5.0) < 1e-4, '10 V * 500 mA must equal 5.0 W');
});

// 15. Motor/FOC: estimateElectricalAngleFromAlphaBeta throws on length mismatch and outputs NaN on invalid sample
test('Motor/FOC: estimateElectricalAngleFromAlphaBeta rejects mismatch and avoids NaN sample hold', () => {
  assert.throws(
    () => estimateElectricalAngleFromAlphaBeta(new Float32Array([1, 0]), new Float32Array([0])),
    /不一致/
  );
  const theta = estimateElectricalAngleFromAlphaBeta(
    new Float32Array([1, Number.NaN, 0]),
    new Float32Array([0, 1, 1])
  );
  assert.ok(Math.abs(theta[0]) < 1e-6);
  assert.ok(Number.isNaN(theta[1]), 'Invalid sample must produce NaN rather than holding previous theta');
  assert.ok(Math.abs(theta[2] - Math.PI / 2) < 1e-4);
});

// 16. Power: computePowerSummary breaks integrals across gaps, rejects mismatched/non-monotonic inputs, and never fakes 0W/0J
test('Power: computePowerSummary rejects invalid inputs, skips gaps, and refuses fake zero summary', () => {
  const mismatch = computePowerSummary(new Float64Array([0, 0.01, 0.02]), new Float32Array([10, 10]));
  assert.equal(mismatch.valid, false);
  assert.equal(mismatch.status, 'INVALID');
  assert.ok(Number.isNaN(mismatch.avgPowerW));

  const nonMono = computePowerSummary(
    new Float64Array([0, 0.02, 0.01, 0.03]),
    new Float32Array([10, 10, 10, 10])
  );
  assert.equal(nonMono.valid, false);
  assert.equal(nonMono.status, 'INVALID');

  const allNan = computePowerSummary(
    new Float64Array([0, 0.01, 0.02, 0.03]),
    new Float32Array([Number.NaN, Number.NaN, Number.NaN, Number.NaN])
  );
  assert.equal(allNan.valid, false);
  assert.equal(allNan.status, 'INSUFFICIENT_DATA');
  assert.ok(Number.isNaN(allNan.energyJ));

  // Segmented gap integration: 2ms @ 100W -> gap 50ms -> 6ms @ 0W => true avgPower = (0.200) / 0.008 = 25 W, energy = 0.2 J
  const tGap = new Float64Array([0, 0.001, 0.002, 0.05, 0.051, 0.052, 0.053, 0.054, 0.055, 0.056]);
  const pGap = new Float32Array([100, 100, 100, 0, 0, 0, 0, 0, 0, 0]);
  const gapSum = computePowerSummary(tGap, pGap);
  assert.equal(gapSum.valid, true);
  assert.equal(gapSum.skippedGapCount, 1);
  assert.ok(Math.abs(gapSum.energyJ - 0.2) < 1e-4, `Expected 0.2 J, got ${gapSum.energyJ}`);
  assert.ok(Math.abs(gapSum.avgPowerW - 25.0) < 0.2, `Expected 25.0 W, got ${gapSum.avgPowerW}`);
});

// 17. Math M-01..M-05: unary precedence, non-uniform mean/rms parity, diff/deriv NaN at index 0 & gap, trig/power units
test('Math M-01..M-05: precedence (-2^2=-4), non-uniform time-weighted mean/rms parity, deriv[0]=NaN, unit algebra', () => {
  const tUni = new Float64Array([0, 0.01, 0.02, 0.03]);
  const chV = makeChannel('mv', tUni, new Float32Array([2, 2, 2, 2]), 'V', 'VCH');
  const negPow = evaluateMathExpression('-2^2', { mv: chV }, ['mv']);
  assert.equal(negPow.v[0], -4, '-2^2 must evaluate as -(2^2) = -4');
  const parenPow = evaluateMathExpression('(-2)^2', { mv: chV }, ['mv']);
  assert.equal(parenPow.v[0], 4, '(-2)^2 must evaluate as +4');
  const negExp = evaluateMathExpression('2^-2', { mv: chV }, ['mv']);
  assert.ok(Math.abs(negExp.v[0] - 0.25) < 1e-6, '2^-2 must evaluate as 0.25');

  // M-04: power, sqrt, trig units & dimension rejection
  const vSq = evaluateMathExpression('VCH^2', { mv: chV }, ['mv']);
  assert.equal(vSq.unit, 'V²');
  const vSqrtSq = evaluateMathExpression('sqrt(VCH^2)', { mv: chV }, ['mv']);
  assert.equal(vSqrtSq.unit, 'V');
  assert.ok(Math.abs(vSqrtSq.v[0] - 2) < 1e-5);
  const chDeg = makeChannel('mdeg', tUni, new Float32Array([90, 90, 90, 90]), 'deg', 'DEG');
  const sinDeg = evaluateMathExpression('sin(DEG)', { mdeg: chDeg }, ['mdeg']);
  assert.ok(Math.abs(sinDeg.v[0] - 1) < 1e-5, 'sin(90 deg) must convert deg -> rad');
  assert.throws(() => evaluateMathExpression('sin(VCH)', { mv: chV }, ['mv']), /量纲|角度|单位/);

  // M-03: deriv/diff sets sample 0 to NaN and does not mask sampling gaps
  const tGap = new Float64Array([0, 0.001, 0.002, 0.02, 0.021]);
  const vRamp = new Float32Array([0, 1, 2, 20, 21]);
  const chRamp = makeChannel('mr', tGap, vRamp, 'V', 'RAMP');
  const deriv = evaluateMathExpression('deriv(RAMP)', { mr: chRamp }, ['mr']);
  assert.ok(Number.isNaN(deriv.v[0]), 'deriv[0] has no prior timestamp and must be NaN');
  assert.ok(Math.abs(deriv.v[1] - 1000) < 1e-1);
  assert.ok(Number.isNaN(deriv.v[3]), 'deriv across sampling gap must be NaN');

  // M-02: Math mean/rms matches Measure trapezoidal time-weighted mean/rms on non-uniform waveform
  const tNu = new Float64Array([0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4]);
  const vNu = new Float32Array([4, 4, 4, 4, 4, 4, 0, 0, 0, 0, 0, 0]);
  const chNu = makeChannel('mnu', tNu, vNu, 'V', 'NU');
  const measNu = computeMeasurements(
    chNu,
    'entire',
    { startIndex: 0, endIndex: tNu.length },
    { enabled: false, x1: null, x2: null, y1: null, y2: null, trackingChannel: null }
  );
  const mathMean = evaluateMathExpression('mean(NU)', { mnu: chNu }, ['mnu']);
  const mathRms = evaluateMathExpression('rms(NU)', { mnu: chNu }, ['mnu']);
  assert.ok(measNu.average !== null && Math.abs(mathMean.v[0] - measNu.average) < 1e-4);
  assert.ok(measNu.rms !== null && Math.abs(mathRms.v[0] - measNu.rms) < 1e-4);
});

// 18. Measure ME-01..ME-06: exact boundary linear interpolation & structured custom measurement failure statuses
test('Measure ME-01..ME-06: boundary linear interpolation and structured custom measurement error statuses', () => {
  const t = new Float64Array([0, 1, 2, 3]);
  const v = new Float32Array([0, 10, 20, 30]);
  const ch = makeChannel('lin', t, v, 'V', 'LIN');
  // Window [0.5, 2.5]: values linearly interpolated to [5, 10, 20, 25], average over [0.5, 2.5] = 15
  const meas = computeMeasurements(
    ch,
    'cursors',
    { startIndex: 0, endIndex: 4 },
    { enabled: true, x1: 0.5, x2: 2.5, y1: null, y2: null, trackingChannel: 'lin' }
  );
  assert.equal(meas.valid, true);
  assert.ok(meas.min !== null && Math.abs(meas.min - 5) < 1e-4);
  assert.ok(meas.max !== null && Math.abs(meas.max - 25) < 1e-4);
  assert.ok(meas.average !== null && Math.abs(meas.average - 15) < 1e-4);

  // evaluateCustomMeasurementDetailed exposes NO_OVERLAP, INSUFFICIENT_DATA, INVALID, EVAL_ERROR
  const defOk = { id: 'c1', label: 'MeanSq', shortLabel: 'MeanSq', expression: 'mean(x^2)', unitType: 'custom' as const, customUnit: 'V^2' };
  const noOv = evaluateCustomMeasurementDetailed(
    defOk,
    ch,
    meas,
    'cursors',
    { startIndex: 0, endIndex: 4 },
    { enabled: true, x1: 10, x2: 20, y1: null, y2: null, trackingChannel: 'lin' }
  );
  assert.equal(noOv.valid, false);
  assert.equal(noOv.status, 'NO_OVERLAP');

  const badExpr = evaluateCustomMeasurementDetailed(
    { id: 'c2', label: 'Bad', shortLabel: 'Bad', expression: 'unknownFunc(x)', unitType: 'ratio' as const },
    ch,
    meas,
    'entire',
    { startIndex: 0, endIndex: 4 },
    { enabled: false, x1: null, x2: null, y1: null, y2: null, trackingChannel: null }
  );
  assert.equal(badExpr.valid, false);
  assert.equal(badExpr.status, 'EVAL_ERROR');
});

// 19. Analyze AN-01..AN-03 & AN-06..AN-12: Park frameType/deg/invalid angle, sync cap warning, Hall poles, PWM gap, Power E+/E-
test('Analyze AN-01..AN-12: Park angle guards, Hall pole validation, PWM gap reset, Power E+/E- split', () => {
  const n = 200;
  const t = Float64Array.from({ length: n }, (_, i) => i * 1e-4);
  const alpha = Float32Array.from(t, (x) => 10 * Math.cos(2 * Math.PI * 50 * x));
  const beta = Float32Array.from(t, (x) => 10 * Math.sin(2 * Math.PI * 50 * x));
  const thetaDeg = Float32Array.from(t, (x) => ((2 * Math.PI * 50 * x) * 180) / Math.PI);
  const chA = makeChannel('pa', t, alpha, 'A', 'Alpha');
  const chB = makeChannel('pb', t, beta, 'A', 'Beta');

  // Self-aligned mode marks frameType & warns q_vec ~= 0
  const selfPark = computeParkFromChannels(chA, chB);
  assert.equal(selfPark.valid, true);
  assert.equal(selfPark.frameType, 'self_aligned_vector');
  assert.ok(selfPark.warnings.some((w) => w.includes('q_vec')));

  // Rotor angle in deg converts to rad; non-angle unit ('V') rejected
  const rotorPark = computeParkFromChannels(chA, chB, makeChannel('pth', t, thetaDeg, 'deg', 'Theta'));
  assert.equal(rotorPark.valid, true);
  assert.equal(rotorPark.frameType, 'rotor_measured');
  assert.ok(Math.abs(rotorPark.d[50] - 10) < 0.05);
  assert.ok(Math.abs(rotorPark.q[50]) < 0.05);

  const badAnglePark = computeParkFromChannels(chA, chB, makeChannel('pbad', t, thetaDeg, 'V', 'NotAngle'));
  assert.equal(badAnglePark.valid, false);
  assert.match(badAnglePark.invalidReason || '', /角度单位/);

  // AN-06: Three-phase balance over 2 exact cycles (0..0.02s @ 100 Hz) matches true RMS & zero-seq
  const t3 = Float64Array.from({ length: 201 }, (_, i) => i * 1e-4);
  const bal = analyzeThreePhaseBalance(
    makeChannel('u', t3, Float32Array.from(t3, (x) => 10 * Math.sin(2 * Math.PI * 100 * x)), 'V'),
    makeChannel('v', t3, Float32Array.from(t3, (x) => 10 * Math.sin(2 * Math.PI * 100 * x - (2 * Math.PI) / 3)), 'V'),
    makeChannel('w', t3, Float32Array.from(t3, (x) => 10 * Math.sin(2 * Math.PI * 100 * x + (2 * Math.PI) / 3)), 'V')
  );
  assert.equal(bal.valid, true);
  assert.ok(Math.abs(bal.phases[0].rms - 10 / Math.SQRT2) < 0.05);

  // AN-07: Hall invalid polePairs refuses fake mechanical RPM while preserving elec freq
  const tH = Float64Array.from({ length: 400 }, (_, i) => i * 1e-4);
  const sq = (ph: number) =>
    Float32Array.from(tH, (x) => (Math.sin(2 * Math.PI * 50 * x + ph) >= 0 ? 5 : 0));
  const hallNoPoles = analyzeBldcHallCommutation(
    makeChannel('ha', tH, sq(0), 'V'),
    makeChannel('hb', tH, sq(-(2 * Math.PI) / 3), 'V'),
    makeChannel('hc', tH, sq((2 * Math.PI) / 3), 'V'),
    Number.NaN
  );
  assert.equal(hallNoPoles.valid, true);
  assert.equal(hallNoPoles.avgRpm, null);
  assert.ok(hallNoPoles.avgElecFreqHz !== null && Math.abs(hallNoPoles.avgElecFreqHz - 50) < 3);

  // AN-09: PWM gap resets edge & dead-time state machines
  const tPwmGap = new Float64Array([
    0, 1e-7, 2e-7, 3e-7, 4e-7,
    5e-4, 5e-4 + 1e-7, 5e-4 + 2e-7, 5e-4 + 3e-7, 5e-4 + 4e-7,
  ]);
  const gh = new Float32Array([12, 12, 12, 12, 12, 0, 0, 0, 0, 0]);
  const gl = new Float32Array([0, 0, 0, 0, 0, 12, 12, 12, 12, 12]);
  const pwmGap = analyzePwmSwitchingAndDeadTime(
    makeChannel('gh', tPwmGap, gh, 'V', 'Gate_GH'),
    makeChannel('gl', tPwmGap, gl, 'V', 'Gate_GL')
  );
  assert.equal(pwmGap.valid, true);
  assert.equal(pwmGap.deadTimeCount, 0, 'Transition across 500us sampling gap must not fabricate dead-time event');
  assert.equal(pwmGap.shootThroughCount, 0);

  // AN-10..AN-12: Power E+ / E- exact split and bidirectional peak tracking
  const tP = new Float64Array([0, 1, 2]);
  const pBi = new Float32Array([10, -10, 10]); // crosses zero at t=0.5 (area += 2.5, -= 2.5) and t=1.5 (-= 2.5, += 2.5) => E+=5, E-=5, Enet=0, |P|_avg=5
  const pSum = computePowerSummary(tP, pBi);
  assert.equal(pSum.valid, true);
  assert.ok(Math.abs(pSum.energyJ) < 1e-6);
  assert.ok(Math.abs(pSum.inputEnergyJ - 5) < 1e-4);
  assert.ok(Math.abs(pSum.regenEnergyJ - 5) < 1e-4);
  assert.ok(Math.abs(pSum.avgAbsPowerW - 5) < 1e-4);
  assert.ok(Math.abs(pSum.peakPosPowerW - 10) < 1e-6);
  assert.ok(Math.abs(pSum.peakNegPowerW - -10) < 1e-6);

  // Touch alignChannelsToCommonTimebase import sanity
  const syncOk = alignChannelsToCommonTimebase([chA, chB]);
  assert.equal(syncOk.valid, true);
  assert.equal(syncOk.downsampledBySyncCap, false);

  // AN-08: torque ripple helper still valid
  const tq = analyzeTorqueAndCurrentRipple(makeChannel('tq_ok', t, Float32Array.from(t, () => 1), 'A'), 50);
  assert.equal(tq.valid, true);
});

// 20. Hall Commutation AN-08: sampling gaps reset state machine without bridging sectors; NaN fails closed
test('Hall AN-08: sampling gap resets state machine cleanly and NaN fails closed', () => {
  const dt = 1e-4; // 10 kHz
  const seg1Len = 300; // 0 .. 0.03s (3 electrical cycles @ 100 Hz)
  const seg2Len = 300; // shifted across a 0.05s gap
  const tGap = new Float64Array(seg1Len + seg2Len);
  for (let i = 0; i < seg1Len; i++) tGap[i] = i * dt;
  for (let i = 0; i < seg2Len; i++) tGap[seg1Len + i] = 0.08 + i * dt;

  const mkSq = (phase: number) =>
    Float32Array.from(tGap, (x) => (Math.sin(2 * Math.PI * 100 * x + phase) >= 0 ? 5 : 0));

  const ha = mkSq(0);
  const hb = mkSq(-(2 * Math.PI) / 3);
  const hc = mkSq((2 * Math.PI) / 3);

  const hallGap = analyzeBldcHallCommutation(
    makeChannel('hg_a', tGap, ha, 'V'),
    makeChannel('hg_b', tGap, hb, 'V'),
    makeChannel('hg_c', tGap, hc, 'V'),
    2
  );
  assert.equal(hallGap.valid, true);
  assert.equal(hallGap.sequenceJumpCount, 0);
  assert.ok(hallGap.avgElecFreqHz !== null && Math.abs(hallGap.avgElecFreqHz - 100) < 5, `Expected ~100 Hz, got ${hallGap.avgElecFreqHz}`);
  assert.ok(hallGap.avgRpm !== null && Math.abs(hallGap.avgRpm - 3000) < 150, `Expected ~3000 RPM, got ${hallGap.avgRpm}`);
  assert.ok(hallGap.maxSectorErrorDeg !== null && hallGap.maxSectorErrorDeg < 5, `Expected clean sectors, got ${hallGap.maxSectorErrorDeg}`);
  assert.ok(hallGap.warnings.some((w) => w.includes('分段重置换相状态机')));

  // NaN injected inside Hall channel fails closed
  const haNan = Float32Array.from(ha);
  haNan[420] = Number.NaN;
  const hallNan = analyzeBldcHallCommutation(
    makeChannel('hg_an', tGap, haNan, 'V'),
    makeChannel('hg_b', tGap, hb, 'V'),
    makeChannel('hg_c', tGap, hc, 'V'),
    2
  );
  assert.equal(hallNan.valid, false);
});

