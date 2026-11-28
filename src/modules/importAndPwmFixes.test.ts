import test from 'node:test';
import assert from 'node:assert/strict';
import type { TabState, WaveformChannel } from '../types/models';
import { computeMeasurements } from './measurements';
import { analyzePwmSwitchingAndDeadTime } from './bldcAnalysis';
import { mergeExcelChannelsByTime, resolveExcelMergedViewport } from './excelTimeAlignment';
import { getTabGlobalIndexBounds } from './oscilloscopeScale';
import { applyChannelTimeShift, resetChannelTimeShift } from './waveformEditor';
import {
  alignAndInterpolateReference,
  buildMappedReferenceTrace,
  canApplyCompareOverlay,
  computeAutoTimeAlignDetailed,
  detectRecommendedTimeScale,
} from './waveformCompare';
import { previewCsv, parseFullCsv } from '../parsers/csvParser';

function makeChannel(
  id: string,
  t: Float64Array,
  v: Float32Array,
  unit = 'V',
  syntheticClockUsed = false
): WaveformChannel {
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < v.length; i++) {
    if (v[i] < mn) mn = v[i];
    if (v[i] > mx) mx = v[i];
  }
  const dt = t.length > 1 ? (t[t.length - 1] - t[0]) / (t.length - 1) : 1e-6;
  return {
    id,
    name: id,
    unit,
    color: '#22d3ee',
    visible: true,
    t,
    v,
    rawT: new Float64Array(t),
    rawV: new Float32Array(v),
    fs: dt > 0 ? 1 / dt : null,
    dt: dt > 0 ? dt : null,
    isMath: false,
    sourceChannelIds: [],
    metadata: {
      originalSampleCount: t.length,
      originalTimeStart: t[0] ?? 0,
      originalTimeEnd: t[t.length - 1] ?? 0,
      isUniformSampling: true,
      nominalDt: dt,
      medianDt: dt,
      meanDt: dt,
      minDt: dt,
      maxDt: dt,
      jitterRms: 0,
      jitterMax: 0,
      droppedSamples: 0,
      invalidSamples: 0,
      sampleRate: dt > 0 ? 1 / dt : null,
      qualityStatus: 'uniform',
      gapCount: 0,
      gapIndices: [],
      syntheticClockUsed,
    },
    vMin: mn,
    vMax: mx,
  };
}

test('PWM frequency measurement does not double under high overshoot spikes, Miller plateau, and ringing glitches', () => {
  const fPwm = 20_000; // 20 kHz -> T = 50 us
  const period = 1 / fPwm;
  const fs = 10_000_000; // 10 MSa/s -> 500 samples/cycle
  const cycles = 12;
  const n = Math.round(cycles * period * fs);
  const t = new Float64Array(n);
  const vHigh = new Float32Array(n);
  const vLow = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const ti = i / fs;
    t[i] = ti;
    const phase = (ti % period) / period; // 0..1

    // High-side gate/Vds with huge turn-on overshoot (up to 38V over 12V plateau),
    // Miller plateau hovering around 5.8V, and brief dead-time switching glitch near phase=0.52
    let vh = 0;
    if (phase < 0.02) {
      // Turn-on ringing overshoot spike
      vh = 12 + 26 * Math.exp(-phase / 0.005) * Math.cos(2 * Math.PI * phase / 0.006);
    } else if (phase >= 0.02 && phase < 0.05) {
      // Miller plateau / damped ring
      vh = 12 + 1.5 * Math.sin(2 * Math.PI * (phase - 0.02) / 0.01);
    } else if (phase < 0.48) {
      vh = 12;
    } else if (phase >= 0.48 && phase < 0.51) {
      // Turn-off fall + Miller step + ringing glitch crossing ~6V once
      const u = (phase - 0.48) / 0.03;
      vh = 12 * (1 - u) + 5.5 * Math.exp(-u * 2) * Math.sin(2 * Math.PI * u * 1.5);
    } else if (phase >= 0.52 && phase < 0.53) {
      // False ringing bounce crossing mid-level briefly
      vh = 7.2 * Math.sin(Math.PI * (phase - 0.52) / 0.01);
    } else {
      vh = 0;
    }
    vHigh[i] = vh;

    // Complementary low-side gate with dead-time and ringing
    const vl = phase >= 0.54 && phase < 0.96 ? 12 + (phase < 0.555 ? 8 * Math.sin(2 * Math.PI * (phase - 0.54) / 0.005) : 0) : 0;
    vLow[i] = vl;
  }

  const chHigh = makeChannel('pwm_hi', t, vHigh);
  const chLow = makeChannel('pwm_lo', t, vLow);

  const meas = computeMeasurements(
    chHigh,
    'entire',
    { startIndex: 0, endIndex: n },
    { enabled: false, mode: 'off', x1: null, x2: null, y1: null, y2: null, trackingChannel: null }
  );
  assert.ok(meas.frequency !== null, 'frequency should be measured');
  assert.ok(
    Math.abs(meas.frequency! - fPwm) / fPwm < 0.02,
    `Expected ~20 kHz, got ${meas.frequency} Hz (must not double to 40 kHz)`
  );

  const bldcPwm = analyzePwmSwitchingAndDeadTime(chHigh, chLow, {
    tStart: t[0],
    tEnd: t[n - 1],
    highSignalRole: 'gate_h',
  });
  assert.ok(bldcPwm.pwmFreqHz !== null, 'BLDC PWM frequency should be measured');
  assert.ok(
    Math.abs(bldcPwm.pwmFreqHz! - fPwm) / fPwm < 0.02,
    `Expected BLDC PWM ~20 kHz, got ${bldcPwm.pwmFreqHz} Hz`
  );
});

test('2-column single-run TXT export parses cleanly via CSV pipeline for intermediate options modal', () => {
  const txt = [
    'time\tV(out)',
    '0.000000e+00\t0.0',
    '1.000000e-05\t5.0',
    '2.000000e-05\t12.0',
    '3.000000e-05\t12.0',
    '4.000000e-05\t0.0',
  ].join('\n');

  const prev = previewCsv(txt);
  assert.equal(prev.timeColIndex, 0);
  assert.equal(prev.columnMappings.filter((m) => m.role === 'channel').length, 1);

  const parsed = parseFullCsv(txt, {
    delimiter: prev.delimiter,
    hasHeader: prev.hasHeader,
    skipLines: prev.skipLines,
    timeColIndex: prev.timeColIndex,
    timeUnit: prev.timeUnit,
    sampleRateOverrideHz: null,
    columnMappings: prev.columnMappings,
    resample: false,
    colors: ['#22d3ee'],
  });
  assert.equal(parsed.drawOrder.length, 1);
  assert.equal(parsed.channels[parsed.drawOrder[0]].v.length, 5);
});

test('Multi-file merge with auto-best anchors longest time axis, preserves overlapping correspondence, shifts disjoint clocks, and supports live Δt', () => {
  // File 1: longest (0 .. 0.010 s)
  const tLong = Float64Array.from({ length: 101 }, (_, i) => i * 0.0001);
  const vLong = Float32Array.from({ length: 101 }, (_, i) => Math.sin(i * 0.2));
  // File 2: overlapping subset (0.002 .. 0.006 s) -> should preserve exact correspondence (shift = 0)
  const tOverlap = Float64Array.from({ length: 41 }, (_, i) => 0.002 + i * 0.0001);
  const vOverlap = Float32Array.from({ length: 41 }, (_, i) => Math.cos(i * 0.2));
  // File 3: disjoint clock (0.500 .. 0.504 s) -> should auto-align start to anchor 0.000 s
  const tDisjoint = Float64Array.from({ length: 41 }, (_, i) => 0.500 + i * 0.0001);
  const vDisjoint = Float32Array.from({ length: 41 }, () => 3.3);

  const chA = makeChannel('a', tLong, vLong);
  const chB = makeChannel('b', tOverlap, vOverlap);
  const chC = makeChannel('c', tDisjoint, vDisjoint);

  const merged = mergeExcelChannelsByTime(
    [
      { fileName: 'short_overlap.csv', sheetName: 'CSV', channels: { b: chB }, drawOrder: ['b'], timeOriginKind: 'numeric' },
      { fileName: 'disjoint.csv', sheetName: 'CSV', channels: { c: chC }, drawOrder: ['c'], timeOriginKind: 'numeric' },
      { fileName: 'longest.csv', sheetName: 'CSV', channels: { a: chA }, drawOrder: ['a'], timeOriginKind: 'numeric' },
    ],
    ['#facc15', '#22d3ee', '#f472b6'],
    'auto-best'
  );

  assert.equal(merged.canMergePreservingTime, true);
  assert.equal(merged.drawOrder.length, 3);

  const idOverlap = merged.drawOrder[0];
  const idDisjoint = merged.drawOrder[1];
  const idLongest = merged.drawOrder[2];

  // Overlapping file keeps original 2 ms .. 6 ms timestamps
  assert.ok(Math.abs(merged.channels[idOverlap].t[0] - 0.002) < 1e-12);
  assert.equal(merged.channels[idOverlap].timeShiftSec || 0, 0);

  // Disjoint file aligns to longest anchor start (0.000 s) with Δt = -0.5 s recorded
  assert.ok(Math.abs(merged.channels[idDisjoint].t[0] - 0) < 1e-12);
  assert.ok(Math.abs((merged.channels[idDisjoint].timeShiftSec || 0) - (-0.5)) < 1e-12);

  // Viewport spans longest 10 ms time axis
  const viewport = resolveExcelMergedViewport(merged);
  assert.ok(viewport);
  assert.ok(Math.abs(viewport!.unionEndSec - viewport!.unionStartSec - 0.01) < 1e-12);

  // Manual Δt tweak & reset work cleanly on the merged channel and extend tab view bounds
  const tab: TabState = {
    id: 'tab_test',
    fileName: 'merged',
    channels: merged.channels,
    drawOrder: [idLongest, idOverlap, idDisjoint],
    view: { startIndex: 0, endIndex: merged.channels[idLongest].t.length },
    cursors: { enabled: false, mode: 'off', x1: null, x2: null, y1: null, y2: null, trackingChannel: idLongest },
    annotations: [],
    annotationMode: false,
    annotationsVisible: true,
    isOverlap: false,
    plotMode: 'time',
    fftOptions: { range: 'view', window: 'hann', scale: 'db', zeroPadding: 1, removeDC: true },
    motorConfig: { rpm: null, polePairs: null, enabled: false },
    triggerConfig: { enabled: false, channelId: idLongest, type: 'rising', level: 0, positionPercent: 50 },
    measurementGate: 'view',
    separateView: false,
    activeChannelId: idDisjoint,
    activeTool: 'pan',
  };

  applyChannelTimeShift(merged.channels[idDisjoint], -0.49); // moves to 0.010..0.014 s
  assert.ok(Math.abs(merged.channels[idDisjoint].t[0] - 0.01) < 1e-12);
  const extendedBounds = getTabGlobalIndexBounds(tab);
  assert.ok(extendedBounds.tMax >= 0.0139);

  resetChannelTimeShift(merged.channels[idDisjoint]);
  assert.ok(Math.abs(merged.channels[idDisjoint].t[0] - 0.5) < 1e-12);
});

test('Compare allows importing & overlaying reference waveforms with differing/disjoint time axes onto Scope', () => {
  const tTarget = Float64Array.from({ length: 101 }, (_, i) => i * 0.0001); // 0 .. 10 ms
  const vTarget = Float32Array.from({ length: 101 }, (_, i) => 5 * Math.sin(i * 0.1));
  // Reference captured at completely different clock offset (50 .. 60 ms)
  const tRef = Float64Array.from({ length: 101 }, (_, i) => 0.05 + i * 0.0001);
  const vRef = Float32Array.from({ length: 101 }, (_, i) => 5 * Math.sin(i * 0.1));

  const chTgt = makeChannel('tgt', tTarget, vTarget, 'V');
  const chRef = makeChannel('ref', tRef, vRef, 'V');
  const chBadUnit = makeChannel('bad_unit', tRef, vRef, 'A');

  // With Δt=0 (differing time axes), aligned.valid is false (INSUFFICIENT_DATA), but fullRefTrace succeeds
  const alignedDisjoint = alignAndInterpolateReference(chTgt, chRef, 0, false, 1);
  const mappedDisjoint = buildMappedReferenceTrace(chTgt, chRef, 0, false, 1);
  assert.equal(alignedDisjoint.valid, false);
  assert.equal(alignedDisjoint.status, 'INSUFFICIENT_DATA');
  assert.equal(mappedDisjoint.t.length, 101);
  assert.equal(
    canApplyCompareOverlay(alignedDisjoint.status, mappedDisjoint.t, true, alignedDisjoint.valid),
    true,
    'Overlay to Scope must be allowed even when time axes do not overlap yet'
  );

  // Incompatible units (V vs A) must still be blocked
  const alignedBadUnit = alignAndInterpolateReference(chTgt, chBadUnit, 0, false, 1);
  const mappedBadUnit = buildMappedReferenceTrace(chTgt, chBadUnit, 0, false, 1);
  assert.equal(alignedBadUnit.status, 'INVALID');
  assert.equal(
    canApplyCompareOverlay(alignedBadUnit.status, mappedBadUnit.t, true, alignedBadUnit.valid),
    false
  );

  // Auto-align t0 bridges differing time axes cleanly
  const alignDetail = computeAutoTimeAlignDetailed(chTgt, chRef, 'start', 1);
  assert.ok(Math.abs(alignDetail.shiftSec - (-0.05)) < 1e-12);
  const alignedAfterShift = alignAndInterpolateReference(chTgt, chRef, alignDetail.shiftSec, false, 1);
  assert.equal(alignedAfterShift.valid, true);
  assert.ok(alignedAfterShift.coveragePct > 99);

  // Also test ms vs s scale detection
  const tRefMs = Float64Array.from({ length: 101 }, (_, i) => i * 0.1); // 0 .. 10 (ms numeric)
  const chRefMs = makeChannel('ref_ms', tRefMs, vRef, 'V');
  const scaleRec = detectRecommendedTimeScale(chTgt, chRefMs);
  assert.equal(scaleRec.isLargeMismatch, true);
  assert.ok(Math.abs(scaleRec.timeScale - 0.001) < 1e-12);
});

test('Coarse-sampled 2.5-samples/cycle square PWM does not falsely halve frequency due to 1-sample interval alternation', () => {
  const fPwm = 40_000; // T = 25 us
  const period = 1 / fPwm;
  const fs = 100_000; // dt = 10 us -> 2.5 samples per cycle (alternating 20us / 30us edge intervals)
  const n = 50; // 20 cycles
  const t = new Float64Array(n);
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ti = i / fs;
    t[i] = ti;
    const phase = (ti % period) / period;
    v[i] = phase < 0.5 ? 12 : 0;
  }
  const ch = makeChannel('pwm_coarse', t, v);
  const meas = computeMeasurements(
    ch,
    'entire',
    { startIndex: 0, endIndex: n },
    { enabled: false, mode: 'off', x1: null, x2: null, y1: null, y2: null, trackingChannel: null }
  );
  assert.ok(meas.frequency !== null, 'coarse PWM frequency should be measured');
  assert.ok(
    Math.abs(meas.frequency! - fPwm) / fPwm < 0.05,
    `Expected ~40 kHz on coarse 2.5-pt/cycle PWM, got ${meas.frequency} Hz`
  );

  const bldc = analyzePwmSwitchingAndDeadTime(ch, null, { tStart: t[0], tEnd: t[n - 1], highSignalRole: 'gate_h' });
  assert.ok(bldc.pwmFreqHz !== null, 'coarse BLDC PWM frequency should be measured');
  assert.ok(
    Math.abs(bldc.pwmFreqHz! - fPwm) / fPwm < 0.05,
    `Expected ~40 kHz in BLDC analysis, got ${bldc.pwmFreqHz} Hz`
  );
});

test('Comma/tab delimiters take precedence over spaces inside ISO datetimes or unit-spaced CSV values', () => {
  const isoCsv = [
    'Timestamp,Voltage',
    '2026-01-01 12:00:00.001, 3.31 V',
    '2026-01-01 12:00:00.002, 3.35 V',
    '2026-01-01 12:00:00.003, 3.32 V',
    '2026-01-01 12:00:00.004, 3.30 V',
  ].join('\n');

  const prev = previewCsv(isoCsv);
  assert.equal(prev.delimiter, ',');
  assert.equal(prev.headers.length, 2);
  assert.equal(prev.timeColIndex, 0);

  const parsed = parseFullCsv(isoCsv, {
    delimiter: prev.delimiter,
    hasHeader: prev.hasHeader,
    skipLines: prev.skipLines,
    timeColIndex: prev.timeColIndex,
    timeUnit: prev.timeUnit,
    sampleRateOverrideHz: null,
    columnMappings: prev.columnMappings,
    resample: false,
    colors: ['#22d3ee'],
  });
  assert.equal(parsed.drawOrder.length, 1);
  assert.equal(parsed.channels[parsed.drawOrder[0]].v.length, 4);
  assert.ok(Math.abs(parsed.channels[parsed.drawOrder[0]].v[1] - 3.35) < 1e-4);
});

