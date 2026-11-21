/**
 * Waveform Viewer Pro - Automated Verification & Test Suite
 * Executes rigorous mathematical and algorithmic tests covering:
 * FFT frequency accuracy, amplitude normalization, window coherent gain,
 * jitter resampling, gap detection, math parser, Clarke transform, and measurements.
 */

import { computeFFT, getWindow } from '../modules/fft';
import { resampleUniform } from '../modules/resampler';
import { analyzeSamplingQuality } from '../modules/qualityCheck';
import { evaluateMathExpression } from '../modules/mathParser';
import { computeClarke, computePark, computeInstantaneousPower } from '../modules/transforms';
import { computeMeasurements } from '../modules/measurements';
import { WaveformChannel, TabState } from '../types/models';
import { runDynamicMutationTests } from './dynamicMutationTest';
import { parseLtspiceRawBuffer, isLtspiceExportText, parseLtspiceText } from '../parsers/ltspiceParser';
import { THEME_PRESETS } from '../modules/themeManager';
import {
  snapScale125,
  stepScale125,
  stepTimebase125,
  syncChannelBoundsFromScaleOffset,
  getSubplotRects,
  getChannelDisplayValue,
  syncSameUnitChannelsScale,
} from '../modules/oscilloscopeScale';
import { buildDecimatedSegments, interpolateSmoothSegments } from '../modules/decimator';
import { clampCursorsToViewport, centerCursorsInViewport } from '../modules/cursorEngine';
import { previewCsv, parseFullCsv } from '../parsers/csvParser';
import {
  applyGlobalEdit,
  applyLocalEdit,
  computeDiffSeries,
  revertChannelToReference,
} from '../modules/waveformEditor';
import {
  estimateElectricalAngleFromAlphaBeta,
  estimateSpeedFromSignal,
  computeTwoChannelPhaseDiff,
  computePowerSummary,
} from '../modules/motorAnalysis';
import { scanChannelAnomalies, evaluateGoldenTolerance } from '../modules/anomalyScanner';
import { computeXYMetrics } from '../modules/xyAnalysis';
import {
  COMPARE_GROUP_THEMES,
  getCompareGroupTraceColor,
  alignAndInterpolateReference,
  computeAutoTimeAlignShift,
  computeWaveformCompareMetrics,
  computeTextFingerprint,
  detectRecommendedTimeScale,
} from '../modules/waveformCompare';
import {
  analyzeThreePhaseBalance,
  analyzeBldcHallCommutation,
  analyzePwmSwitchingAndDeadTime,
  analyzeTorqueAndCurrentRipple,
  computeBldcDerivedTraces,
} from '../modules/bldcAnalysis';

export interface TestResult {
  name: string;
  passed: boolean;
  message: string;
  details?: any;
}

export function runAllTests(): TestResult[] {
  const results: TestResult[] = [];

  // 1. FFT Frequency Test: 1 kHz sine, Fs = 100 kHz, N = 65536 -> Peak ≈ 1000 Hz
  try {
    const fs = 100000;
    const n = 65536;
    const freqTarget = 1000;
    const t = new Float64Array(n);
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = i / fs;
      v[i] = Math.sin(2 * Math.PI * freqTarget * t[i]);
    }

    const spectrum = computeFFT(
      t,
      v,
      fs,
      {
        range: 'entire',
        window: 'hann',
        scale: 'magnitude',
        zeroPadding: 1,
        removeDC: false,
      },
      'test_ch',
      'Test Sine'
    );

    const detectedFundamental = spectrum.peaks.find((p) => p.isFundamental) || spectrum.peaks[0];
    const freqError = Math.abs(detectedFundamental.frequency - freqTarget);
    const passed = freqError < 5.0; // within 5 Hz error on 1 kHz sine

    results.push({
      name: 'FFT Frequency Accuracy Test',
      passed,
      message: `Expected ~${freqTarget} Hz, detected ${detectedFundamental.frequency.toFixed(2)} Hz (error = ${freqError.toFixed(2)} Hz)`,
      details: { detectedFundamental },
    });
  } catch (err: any) {
    results.push({
      name: 'FFT Frequency Accuracy Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 2. FFT Amplitude Test: 1.0 V peak sine -> Amplitude ≈ 1.0 V
  try {
    const fs = 50000;
    const n = 8192;
    const targetAmp = 1.0;
    const t = new Float64Array(n);
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = i / fs;
      v[i] = targetAmp * Math.sin(2 * Math.PI * 500 * t[i]);
    }

    const spectrum = computeFFT(
      t,
      v,
      fs,
      {
        range: 'entire',
        window: 'hann',
        scale: 'magnitude',
        zeroPadding: 1,
        removeDC: false,
      },
      'test_amp',
      'Sine 1V'
    );

    const fundamental = spectrum.peaks.find((p) => p.isFundamental) || spectrum.peaks[0];
    const ampError = Math.abs(fundamental.magnitude - targetAmp);
    const passed = ampError < 0.05; // within 5% error

    results.push({
      name: 'FFT Amplitude Normalization Test',
      passed,
      message: `Expected ${targetAmp} V peak, detected ${fundamental.magnitude.toFixed(3)} V (error = ${ampError.toFixed(3)} V)`,
      details: { fundamental },
    });
  } catch (err: any) {
    results.push({
      name: 'FFT Amplitude Normalization Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 3. FFT Window Tests: Verify Rectangular, Hann, Hamming, Blackman-Harris coherent gains
  try {
    const n = 1024;
    const rectWin = getWindow('rectangular', n);
    const hannWin = getWindow('hann', n);
    const hammWin = getWindow('hamming', n);
    const bmWin = getWindow('blackman-harris', n);

    const rectOk = Math.abs(rectWin.coherentGain - 1.0) < 1e-4;
    const hannOk = Math.abs(hannWin.coherentGain - 0.5) < 1e-3;
    const hammOk = Math.abs(hammWin.coherentGain - 0.54) < 1e-3;
    const bmOk = Math.abs(bmWin.coherentGain - 0.35875) < 1e-3;

    const passed = rectOk && hannOk && hammOk && bmOk;
    results.push({
      name: 'FFT Window Coherent Gain Test',
      passed,
      message: `Rect=${rectWin.coherentGain.toFixed(3)}, Hann=${hannWin.coherentGain.toFixed(3)}, Hamm=${hammWin.coherentGain.toFixed(3)}, BM=${bmWin.coherentGain.toFixed(3)}`,
    });
  } catch (err: any) {
    results.push({
      name: 'FFT Window Coherent Gain Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 4. Resampling Test: 10 kHz sine with random jittered timestamps -> Resampled frequency ≈ 10 kHz
  try {
    const nominalDt = 1e-6; // 1 MS/s
    const n = 10000;
    const freq = 10000;
    const rawT = new Float64Array(n);
    const rawV = new Float32Array(n);

    let curT = 0;
    for (let i = 0; i < n; i++) {
      // Add slight jitter up to 10%
      const jitter = (Math.sin(i * 0.1) * 0.1) * nominalDt;
      curT += nominalDt + jitter;
      rawT[i] = curT;
      rawV[i] = Math.sin(2 * Math.PI * freq * curT);
    }

    const resampled = resampleUniform(rawT, rawV);
    const quality = analyzeSamplingQuality(resampled.t);

    const passed = quality.isUniformSampling && resampled.fs > 900000 && resampled.fs < 1100000;
    results.push({
      name: 'Non-uniform Resampling Test',
      passed,
      message: `Resampled Fs = ${(resampled.fs / 1e3).toFixed(1)} kS/s, Uniform = ${quality.isUniformSampling}`,
    });
  } catch (err: any) {
    results.push({
      name: 'Non-uniform Resampling Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 5. Gap Test: 1000 points, gap of 10*dt, 1000 points -> Gap detected at index 1000
  try {
    const dt = 1e-4;
    const t = new Float64Array(2000);
    let curTime = 0;
    for (let i = 0; i < 1000; i++) {
      t[i] = curTime;
      curTime += dt;
    }
    curTime += dt * 10; // 10x gap
    for (let i = 1000; i < 2000; i++) {
      t[i] = curTime;
      curTime += dt;
    }

    const quality = analyzeSamplingQuality(t);
    const passed = quality.gapCount >= 1 && quality.gapIndices.includes(1000);

    results.push({
      name: 'Gap Detection Test',
      passed,
      message: `Detected ${quality.gapCount} gap(s), Gap index: ${quality.gapIndices.join(', ')}`,
    });
  } catch (err: any) {
    results.push({
      name: 'Gap Detection Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 6. Math Test: CH1 + CH2, CH1 - CH2, abs(CH1), deriv(CH1)
  try {
    const n = 100;
    const dt = 0.01;
    const t = new Float64Array(n);
    const v1 = new Float32Array(n);
    const v2 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = i * dt;
      v1[i] = 10;
      v2[i] = 4;
    }

    const mockCh1: WaveformChannel = {
      id: 'ch1',
      name: 'Ua (Phase A)',
      unit: 'V',
      color: '#ffff00',
      visible: true,
      t,
      v: v1,
      fs: 100,
      dt,
      isMath: false,
      sourceChannelIds: [],
      metadata: {
        originalSampleCount: n,
        originalTimeStart: 0,
        originalTimeEnd: (n - 1) * dt,
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
        sampleRate: 100,
        qualityStatus: 'uniform',
        gapCount: 0,
        gapIndices: [],
      },
      vMin: 0,
      vMax: 20,
    };

    const mockCh2: WaveformChannel = {
      ...mockCh1,
      id: 'ch2',
      name: 'Ub (Phase B)',
      v: v2,
    };

    const channels = { ch1: mockCh1, ch2: mockCh2 };
    const order = ['ch1', 'ch2'];

    const addRes = evaluateMathExpression('CH1 + CH2', channels, order);
    const subRes = evaluateMathExpression('CH1 - CH2', channels, order);
    const complexRes = evaluateMathExpression('Ua (Phase A) - Ub (Phase B)', channels, order);
    const absRes = evaluateMathExpression('abs(-5)', channels, order);

    const addOk = addRes.v[0] === 14;
    const subOk = subRes.v[0] === 6;
    const complexOk = complexRes.v[0] === 6;
    const absOk = absRes.v[0] === 5;

    const passed = addOk && subOk && complexOk && absOk;
    results.push({
      name: 'Math Expression Evaluator Test',
      passed,
      message: `CH1+CH2 = ${addRes.v[0]}, Ua (Phase A) - Ub (Phase B) = ${complexRes.v[0]} (expected 6), abs(-5) = ${absRes.v[0]}`,
    });
  } catch (err: any) {
    results.push({
      name: 'Math Expression Evaluator Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 7. Clarke Transform Test: Balanced 3-phase Ua, Ub, Uc
  try {
    const n = 360;
    const ua = new Float32Array(n);
    const ub = new Float32Array(n);
    const uc = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const rad = (i * Math.PI) / 180;
      ua[i] = Math.cos(rad);
      ub[i] = Math.cos(rad - (2 * Math.PI) / 3);
      uc[i] = Math.cos(rad + (2 * Math.PI) / 3);
    }

    const { alpha, beta, zero } = computeClarke(ua, ub, uc);

    // For balanced sinusoidal 3-phase, alpha^2 + beta^2 = 1.0 at all times, and zero = 0.0
    let maxRadiusError = 0;
    let maxZeroError = 0;
    for (let i = 0; i < n; i++) {
      const radius = Math.sqrt(alpha[i] * alpha[i] + beta[i] * beta[i]);
      const rErr = Math.abs(radius - 1.0);
      if (rErr > maxRadiusError) maxRadiusError = rErr;

      const zErr = Math.abs(zero[i]);
      if (zErr > maxZeroError) maxZeroError = zErr;
    }

    const passed = maxRadiusError < 1e-4 && maxZeroError < 1e-4;
    results.push({
      name: 'Clarke Transform Test',
      passed,
      message: `Alpha/Beta circle radius error = ${maxRadiusError.toExponential(2)}, Zero sequence error = ${maxZeroError.toExponential(2)}`,
    });
  } catch (err: any) {
    results.push({
      name: 'Clarke Transform Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 8. Measurement Test: Square/Sine wave -> Max, Min, RMS, Vpp, Period, Frequency
  try {
    const fs = 10000;
    const n = 5000;
    const targetFreq = 100; // 100 Hz -> Period = 0.01 s
    const t = new Float64Array(n);
    const v = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      t[i] = i / fs;
      // 2V peak-to-peak sine (-1 to +1)
      v[i] = Math.sin(2 * Math.PI * targetFreq * t[i]);
    }

    const mockCh: WaveformChannel = {
      id: 'meas_ch',
      name: 'Meas Test',
      unit: 'V',
      color: '#00e5ff',
      visible: true,
      t,
      v,
      fs,
      dt: 1 / fs,
      isMath: false,
      sourceChannelIds: [],
      metadata: {
        originalSampleCount: n,
        originalTimeStart: 0,
        originalTimeEnd: (n - 1) / fs,
        isUniformSampling: true,
        nominalDt: 1 / fs,
        medianDt: 1 / fs,
        meanDt: 1 / fs,
        minDt: 1 / fs,
        maxDt: 1 / fs,
        jitterRms: 0,
        jitterMax: 0,
        droppedSamples: 0,
        invalidSamples: 0,
        sampleRate: fs,
        qualityStatus: 'uniform',
        gapCount: 0,
        gapIndices: [],
      },
      vMin: -1.2,
      vMax: 1.2,
    };

    const meas = computeMeasurements(
      mockCh,
      'entire',
      { startIndex: 0, endIndex: n - 1 },
      { enabled: false, x1: null, x2: null, y1: null, y2: null, trackingChannel: null }
    );

    const vppOk = meas.vpp !== null && Math.abs(meas.vpp - 2.0) < 0.05;
    const rmsOk = meas.rms !== null && Math.abs(meas.rms - 1 / Math.SQRT2) < 0.05;
    const freqOk = meas.frequency !== null && Math.abs(meas.frequency - targetFreq) < 2.0;

    const passed = vppOk && rmsOk && freqOk;
    results.push({
      name: 'Oscilloscope Measurements Test',
      passed,
      message: `Vpp = ${meas.vpp?.toFixed(3)} V, RMS = ${meas.rms?.toFixed(3)} V, Freq = ${meas.frequency?.toFixed(1)} Hz (expected 100 Hz)`,
    });
  } catch (err: any) {
    results.push({
      name: 'Oscilloscope Measurements Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 9. Dynamic Input Mutation & Fail-Closed Tests
  try {
    const mutationResults = runDynamicMutationTests();
    for (const m of mutationResults) {
      results.push({
        name: m.name,
        passed: m.passed,
        message: m.details,
      });
    }
  } catch (err: any) {
    results.push({
      name: 'Dynamic Input Mutation Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 10. Oscilloscope 1-2-5 Scale & Vertical Offset Bounds Test
  try {
    const s1 = stepScale125(1.0, 1);
    const s2 = stepScale125(2.0, 1);
    const s3 = stepScale125(5.0, 1);
    const sBack = stepScale125(10.0, -1);
    const snapped = snapScale125(3.8);

    const t = new Float64Array([0, 0.001, 0.002]);
    const v = new Float32Array([10, 12, 14]); // mean = 12
    const ch: WaveformChannel = {
      id: 'scale_ch',
      name: 'ScaleTest',
      unit: 'V',
      color: '#facc15',
      visible: true,
      t,
      v,
      fs: 1000,
      dt: 0.001,
      isMath: false,
      sourceChannelIds: [],
      coupling: 'AC',
      inverted: true,
      voltsPerDiv: 2.0,
      vOffset: 4.0,
      vMin: 0,
      vMax: 0,
      metadata: {
        originalSampleCount: 3,
        originalTimeStart: 0,
        originalTimeEnd: 0.002,
        isUniformSampling: true,
        nominalDt: 0.001,
        medianDt: 0.001,
        meanDt: 0.001,
        minDt: 0.001,
        maxDt: 0.001,
        jitterRms: 0,
        jitterMax: 0,
        droppedSamples: 0,
        invalidSamples: 0,
        sampleRate: 1000,
        qualityStatus: 'uniform',
        gapCount: 0,
        gapIndices: [],
      },
    };
    syncChannelBoundsFromScaleOffset(ch);
    // 8 divisions at 2 V/div = 16V span; vOffset = +4V => vMin = -8 - 4 = -12, vMax = +8 - 4 = +4
    const boundsOk = ch.vMin === -12 && ch.vMax === 4;
    // AC removes mean (12), invert flips sign: sample 0 (10) -> -(10 - 12) = +2
    const conditionedVal = getChannelDisplayValue(ch, 0);
    const condOk = Math.abs(conditionedVal - 2) < 1e-5;
    const stepOk = s1 === 2 && s2 === 5 && s3 === 10 && sBack === 5 && snapped === 5;

    const passed = stepOk && boundsOk && condOk;
    results.push({
      name: 'Oscilloscope 1-2-5 Scale, Offset & Conditioning Test',
      passed,
      message: `1-2-5 steps: 1->${s1}->${s2}->${s3}, bounds=[${ch.vMin}, ${ch.vMax}], AC+INV(10)=${conditionedVal}`,
    });
  } catch (err: any) {
    results.push({
      name: 'Oscilloscope 1-2-5 Scale, Offset & Conditioning Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 11. Separate-Mode Subplot Geometry Isolation Test
  try {
    const t = new Float64Array([0, 1]);
    const v = new Float32Array([0, 1]);
    const baseMeta = {
      originalSampleCount: 2,
      originalTimeStart: 0,
      originalTimeEnd: 1,
      isUniformSampling: true,
      nominalDt: 1,
      medianDt: 1,
      meanDt: 1,
      minDt: 1,
      maxDt: 1,
      jitterRms: 0,
      jitterMax: 0,
      droppedSamples: 0,
      invalidSamples: 0,
      sampleRate: 1,
      qualityStatus: 'uniform' as const,
      gapCount: 0,
      gapIndices: [],
    };
    const chA: WaveformChannel = { id: 'a', name: 'A', unit: 'V', color: '#facc15', visible: true, t, v, fs: 1, dt: 1, isMath: false, sourceChannelIds: [], metadata: baseMeta, vMin: -10, vMax: 10 };
    const chB: WaveformChannel = { id: 'b', name: 'B', unit: 'V', color: '#22d3ee', visible: true, t, v, fs: 1, dt: 1, isMath: false, sourceChannelIds: [], metadata: baseMeta, vMin: -5, vMax: 5 };
    const chC: WaveformChannel = { id: 'c', name: 'C', unit: 'A', color: '#f472b6', visible: true, t, v, fs: 1, dt: 1, isMath: false, sourceChannelIds: [], metadata: baseMeta, vMin: -2, vMax: 2 };

    const rects = getSubplotRects({ x: 76, y: 24, width: 900, height: 620 }, [chA, chB, chC], true);
    const nonOverlapping =
      rects.length === 3 &&
      rects[0].area.y + rects[0].area.height < rects[1].area.y &&
      rects[1].area.y + rects[1].area.height < rects[2].area.y &&
      rects[0].channel.vMax === 10 &&
      rects[1].channel.vMax === 5 &&
      rects[2].channel.vMax === 2;

    results.push({
      name: 'Separate-Mode Per-Channel Subplot Geometry Test',
      passed: nonOverlapping,
      message: `3 non-overlapping subplots computed with independent vertical bounds (${rects.map((r) => `${r.channel.name}:[${r.channel.vMin},${r.channel.vMax}]`).join(', ')})`,
    });
  } catch (err: any) {
    results.push({
      name: 'Separate-Mode Per-Channel Subplot Geometry Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 12. High-Density Decimation (>10k samples: MinMax Peak-Hold vs LTTB)
  try {
    const n = 15000;
    const t = new Float64Array(n);
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = i * 1e-6;
      v[i] = Math.sin(2 * Math.PI * 5 * (i / n));
    }
    // Inject single-sample narrow +50V glitch and an intentional NaN gap
    v[4321] = 50;
    v[9000] = NaN;

    const minMaxSegs = buildDecimatedSegments(t, (idx) => v[idx], 0, n, 800, 'minmax', 5e-6);
    const lttbSegs = buildDecimatedSegments(t, (idx) => v[idx], 0, n, 800, 'lttb', 5e-6);

    const minMaxPts = minMaxSegs.flat();
    const maxCaptured = minMaxPts.reduce((acc, p) => Math.max(acc, p.value), -Infinity);
    const passed =
      minMaxSegs.length === 2 &&
      lttbSegs.length === 2 &&
      Math.abs(maxCaptured - 50) < 1e-4 &&
      lttbSegs.flat().length > 100 &&
      lttbSegs.flat().length <= 1800;

    results.push({
      name: 'High-Density Decimation (MinMax Glitch-Hold & LTTB) Test',
      passed,
      message: `MinMax segments=${minMaxSegs.length}, peak=${maxCaptured.toFixed(1)}V (expected 50V); LTTB points=${lttbSegs.flat().length}`,
    });
  } catch (err: any) {
    results.push({
      name: 'High-Density Decimation (MinMax Glitch-Hold & LTTB) Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 13. Smart Cursor Viewport Clamping (2% Margin) & Center Recall (25%/75%)
  try {
    const n = 1001;
    const t = new Float64Array(n);
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = i * 0.001; // 0 .. 1.0 s
      v[i] = Math.sin(i * 0.1) * 4;
    }
    const ch: WaveformChannel = {
      id: 'cur_ch',
      name: 'CursorCh',
      unit: 'V',
      color: '#facc15',
      visible: true,
      t,
      v,
      fs: 1000,
      dt: 0.001,
      isMath: false,
      sourceChannelIds: [],
      voltsPerDiv: 2,
      vOffset: 0,
      vMin: -8,
      vMax: 8,
      metadata: {
        originalSampleCount: n,
        originalTimeStart: 0,
        originalTimeEnd: 1.0,
        isUniformSampling: true,
        nominalDt: 0.001,
        medianDt: 0.001,
        meanDt: 0.001,
        minDt: 0.001,
        maxDt: 0.001,
        jitterRms: 0,
        jitterMax: 0,
        droppedSamples: 0,
        invalidSamples: 0,
        sampleRate: 1000,
        qualityStatus: 'uniform',
        gapCount: 0,
        gapIndices: [],
      },
    };
    const mockTab: TabState = {
      id: 'tab_cur',
      fileName: 'cursor.csv',
      channels: { cur_ch: ch },
      drawOrder: ['cur_ch'],
      view: { startIndex: 200, endIndex: 600 }, // 0.2s .. 0.6s (span = 0.4s)
      cursors: {
        enabled: true,
        mode: 'xy',
        x1: -5,
        x2: 99,
        y1: 500,
        y2: -500,
        trackingChannel: 'cur_ch',
      },
      annotations: [],
      annotationMode: false,
      annotationsVisible: true,
      isOverlap: true,
      plotMode: 'time',
      fftOptions: { range: 'entire', window: 'hann', scale: 'magnitude', zeroPadding: 1, removeDC: false },
      motorConfig: { rpm: null, polePairs: null, enabled: false },
      triggerConfig: { enabled: false, channelId: 'cur_ch', type: 'rising', level: 0, positionPercent: 50 },
      measurementGate: 'view',
      separateView: false,
    };

    clampCursorsToViewport(mockTab);
    // X range: [0.2, 0.6], 2% margin = 0.008 -> [0.208, 0.592]
    // Y range: [-8, 8], 2% margin = 0.32 -> [-7.68, 7.68]
    const clampOk =
      Math.abs((mockTab.cursors.x1 ?? 0) - 0.208) < 1e-6 &&
      Math.abs((mockTab.cursors.x2 ?? 0) - 0.592) < 1e-6 &&
      Math.abs((mockTab.cursors.y1 ?? 0) - 7.68) < 1e-5 &&
      Math.abs((mockTab.cursors.y2 ?? 0) + 7.68) < 1e-5;

    centerCursorsInViewport(mockTab);
    // 25% of [0.2, 0.6] = 0.3, 75% = 0.5
    const centerOk =
      Math.abs((mockTab.cursors.x1 ?? 0) - 0.3) < 1e-6 &&
      Math.abs((mockTab.cursors.x2 ?? 0) - 0.5) < 1e-6;

    const passed = clampOk && centerOk;
    results.push({
      name: 'Smart Cursor Viewport Clamping & Center Recall Test',
      passed,
      message: `Clamped X=[0.208, 0.592], Recalled X=[${mockTab.cursors.x1?.toFixed(3)}, ${mockTab.cursors.x2?.toFixed(3)}]`,
    });
  } catch (err: any) {
    results.push({
      name: 'Smart Cursor Viewport Clamping & Center Recall Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 14. 15-Metric Pulse Measurements (Vtop/Vbase/Overshoot/+Width/-Width/Duty)
  try {
    const fs = 100000; // 100 kHz
    const freq = 1000; // 1 kHz -> 100 samples per period
    const cycles = 5;
    const n = cycles * 100;
    const t = new Float64Array(n);
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = i / fs;
      const phase = i % 100;
      if (phase === 1) {
        v[i] = 5.5; // 10% overshoot above 5V Vtop
      } else {
        v[i] = phase < 30 ? 5.0 : 0.0; // 30% duty cycle, 0..5V
      }
    }
    const pwmCh: WaveformChannel = {
      id: 'pwm',
      name: 'PWM',
      unit: 'V',
      color: '#22d3ee',
      visible: true,
      t,
      v,
      fs,
      dt: 1 / fs,
      isMath: false,
      sourceChannelIds: [],
      vMin: -1,
      vMax: 6,
      metadata: {
        originalSampleCount: n,
        originalTimeStart: 0,
        originalTimeEnd: (n - 1) / fs,
        isUniformSampling: true,
        nominalDt: 1 / fs,
        medianDt: 1 / fs,
        meanDt: 1 / fs,
        minDt: 1 / fs,
        maxDt: 1 / fs,
        jitterRms: 0,
        jitterMax: 0,
        droppedSamples: 0,
        invalidSamples: 0,
        sampleRate: fs,
        qualityStatus: 'uniform',
        gapCount: 0,
        gapIndices: [],
      },
    };

    const m = computeMeasurements(
      pwmCh,
      'entire',
      { startIndex: 0, endIndex: n - 1 },
      { enabled: false, x1: null, x2: null, y1: null, y2: null, trackingChannel: null }
    );

    const topBaseOk = m.vtop !== null && Math.abs(m.vtop - 5.0) < 0.2 && m.vbase !== null && Math.abs(m.vbase - 0.0) < 0.2;
    const ovshOk = m.overshoot !== null && m.overshoot > 5 && m.overshoot < 15;
    const dutyOk = m.dutyCycle !== null && Math.abs(m.dutyCycle - 30) < 2.5;
    const widthOk = m.posWidth !== null && Math.abs(m.posWidth - 0.0003) < 0.00003;
    const freqOk = m.frequency !== null && Math.abs(m.frequency - 1000) < 20;

    const passed = topBaseOk && ovshOk && dutyOk && widthOk && freqOk;
    results.push({
      name: '15-Metric Pulse & Histogram Measurements Test',
      passed,
      message: `Vtop=${m.vtop?.toFixed(2)}V, Ovsh=${m.overshoot?.toFixed(1)}%, +Width=${((m.posWidth ?? 0) * 1e6).toFixed(0)}us, Duty=${m.dutyCycle?.toFixed(1)}%`,
    });
  } catch (err: any) {
    results.push({
      name: '15-Metric Pulse & Histogram Measurements Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 15. Waveform Editing, Auto Reference Lock, Diff Series & Revert
  try {
    const t = new Float64Array([0, 0.1, 0.2, 0.3, 0.4]);
    const v = new Float32Array([1, 2, 100, 4, 5]); // sample[2] = 100 glitch
    const editCh: WaveformChannel = {
      id: 'edit_ch',
      name: 'EditTest',
      unit: 'V',
      color: '#facc15',
      visible: true,
      t,
      v,
      fs: 10,
      dt: 0.1,
      isMath: false,
      sourceChannelIds: [],
      vMin: -10,
      vMax: 110,
      metadata: {
        originalSampleCount: 5,
        originalTimeStart: 0,
        originalTimeEnd: 0.4,
        isUniformSampling: true,
        nominalDt: 0.1,
        medianDt: 0.1,
        meanDt: 0.1,
        minDt: 0.1,
        maxDt: 0.1,
        jitterRms: 0,
        jitterMax: 0,
        droppedSamples: 0,
        invalidSamples: 0,
        sampleRate: 10,
        qualityStatus: 'uniform',
        gapCount: 0,
        gapIndices: [],
      },
    };

    // Bridge over t=[0.18, 0.22] -> sample[2] between sample[1]=2 and sample[3]=4 => 3.0
    const count = applyLocalEdit(editCh, 0.18, 0.22, { type: 'bridge' });
    const refLockedOk = editCh.refV !== undefined && editCh.refV[2] === 100 && editCh.showRef === true;
    const bridgeOk = count === 1 && Math.abs(editCh.v[2] - 3.0) < 1e-5;

    // Apply global +2V offset -> sample[2] becomes 5.0, diff[2] = 5 - 100 = -95
    applyGlobalEdit(editCh, { type: 'offset', value: 2 });
    const diff = computeDiffSeries(editCh);
    const diffOk = diff !== null && Math.abs(diff[2] - (-95)) < 1e-4 && Math.abs(diff[0] - 2) < 1e-4;

    const reverted = revertChannelToReference(editCh);
    const revertOk = reverted && editCh.v[2] === 100 && editCh.v[0] === 1 && editCh.hasEdits === false;

    const passed = refLockedOk && bridgeOk && diffOk && revertOk;
    results.push({
      name: 'Waveform Edit, Reference Lock, Diff & Revert Test',
      passed,
      message: `Bridge(100->3), Global(+2V), Diff[2]=${diff?.[2]}, Reverted[2]=${editCh.v[2]}`,
    });
  } catch (err: any) {
    results.push({
      name: 'Waveform Edit, Reference Lock, Diff & Revert Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 16. Low-Sample-Rate CSV Import (Metadata Preamble, Headerless, Clock Time, Empty Cell Safety)
  try {
    const scopeCsv = [
      '# Tektronix Capture',
      'Record Length,6',
      'Time,CH1,CH2',
      's,V,V',
      '08:00:00.000,0.0,1.0',
      '08:00:00.050,1.5,',
      '08:00:00.100,3.0,2.0',
      '08:00:00.150,1.5,2.5',
    ].join('\n');

    const prev1 = previewCsv(scopeCsv);
    const parsed1 = parseFullCsv(scopeCsv, {
      delimiter: prev1.delimiter,
      hasHeader: prev1.hasHeader,
      skipLines: prev1.skipLines,
      timeColIndex: prev1.timeColIndex,
      timeUnit: prev1.timeUnit,
      columnMappings: prev1.columnMappings,
      resample: false,
      colors: ['#facc15', '#22d3ee'],
    });
    const ch1 = parsed1.channels[parsed1.drawOrder[0]];
    const ch2 = parsed1.channels[parsed1.drawOrder[1]];

    const headerlessCsv = '0.0,1.25\n0.1,2.50\n0.2,3.75';
    const prev2 = previewCsv(headerlessCsv);
    const parsed2 = parseFullCsv(headerlessCsv, {
      delimiter: prev2.delimiter,
      hasHeader: prev2.hasHeader,
      skipLines: prev2.skipLines,
      timeColIndex: prev2.timeColIndex,
      timeUnit: prev2.timeUnit,
      columnMappings: prev2.columnMappings,
      resample: false,
      colors: ['#facc15'],
    });
    const chH = parsed2.channels[parsed2.drawOrder[0]];

    const clockRateOk = prev1.quality !== null && Math.abs((prev1.quality.sampleRate ?? 0) - 20) < 0.5;
    const nanSafeOk = ch1.v.length === 4 && isNaN(ch2.v[1]) && Math.abs(ch1.t[2] - 0.1) < 1e-6;
    const headerlessOk = !prev2.hasHeader && chH.v.length === 3 && Math.abs(chH.v[0] - 1.25) < 1e-5;

    const passed = clockRateOk && nanSafeOk && headerlessOk;
    results.push({
      name: 'Low-Sample-Rate CSV (Preamble, Clock Time, Headerless & NaN) Test',
      passed,
      message: `Clock Rate=${prev1.quality?.sampleRate?.toFixed(1)} S/s, EmptyCell=NaN(${isNaN(ch2.v[1])}), HeaderlessRows=${chH.v.length}`,
    });
  } catch (err: any) {
    results.push({
      name: 'Low-Sample-Rate CSV (Preamble, Clock Time, Headerless & NaN) Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 17. Low-Sample-Rate Sin(x)/x Smooth Reconstruction Test
  try {
    const sparse = Array.from({ length: 16 }, (_, i) => ({
      time: i * 0.01,
      value: Math.sin((2 * Math.PI * i) / 16),
    }));
    const smoothed = interpolateSmoothSegments([sparse], 8);
    const passed = smoothed.length === 1 && smoothed[0].length === 15 * 8 + 1;
    results.push({
      name: 'Low-Sample-Rate Smooth Curve Reconstruction Test',
      passed,
      message: `16 raw points reconstructed into ${smoothed[0]?.length || 0} smooth curve points`,
    });
  } catch (err: any) {
    results.push({
      name: 'Low-Sample-Rate Smooth Curve Reconstruction Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 18. High-Sample-Rate (1 GSa/s) Override, ps Unit, Continuous Resample & 10ns/div Timebase Test
  try {
    // a) Forced 1 GSa/s on index-only CSV (with UTF-8 BOM & unit-suffixed values)
    const highSpeedCsv = '\uFEFFIndex,RF_Out\n0,1.25V\n1,2.50V\n2,1.25V\n3,-1.25V\n4,-2.50V';
    const prev1G = previewCsv(highSpeedCsv);
    const parsed1G = parseFullCsv(highSpeedCsv, {
      delimiter: prev1G.delimiter,
      hasHeader: prev1G.hasHeader,
      skipLines: prev1G.skipLines,
      timeColIndex: prev1G.timeColIndex,
      timeUnit: prev1G.timeUnit,
      sampleRateOverrideHz: 1e9,
      columnMappings: prev1G.columnMappings,
      resample: true,
      colors: ['#facc15'],
    });
    const ch1G = parsed1G.channels[parsed1G.drawOrder[0]];
    const rateOk = ch1G.fs === 1e9 && Math.abs((ch1G.t[4] ?? 0) - 4e-9) < 1e-15;
    const unitValOk = Math.abs(ch1G.v[1] - 2.5) < 1e-5;

    // b) Uneven / jittered ps CSV with Load + Resample -> must have ZERO NaN holes (continuous)
    const psCsv = 'Time (ps),CH1\n0,0\n100,1\n1100,2\n1200,3';
    const prevPs = previewCsv(psCsv);
    const parsedPs = parseFullCsv(psCsv, {
      delimiter: prevPs.delimiter,
      hasHeader: prevPs.hasHeader,
      skipLines: prevPs.skipLines,
      timeColIndex: prevPs.timeColIndex,
      timeUnit: prevPs.timeUnit,
      columnMappings: prevPs.columnMappings,
      resample: true,
      colors: ['#22d3ee'],
    });
    const chPs = parsedPs.channels[parsedPs.drawOrder[0]];
    const noNanHoles = chPs.v.length > 0 && Array.from(chPs.v).every((val) => !isNaN(val) && isFinite(val));

    // c) 1-2-5 Timebase stepping down into 10 ns/div -> 20 ns/div
    const tbTab: TabState = {
      id: 'tb_1g',
      fileName: '1g.csv',
      channels: { [ch1G.id]: ch1G },
      drawOrder: [ch1G.id],
      view: { startIndex: 0, endIndex: ch1G.v.length },
      cursors: { enabled: false, x1: null, x2: null, y1: null, y2: null, trackingChannel: null },
      annotations: [],
      annotationMode: false,
      annotationsVisible: true,
      isOverlap: true,
      plotMode: 'time',
      fftOptions: { range: 'entire', window: 'hann', scale: 'magnitude', zeroPadding: 1, removeDC: false },
      motorConfig: { rpm: null, polePairs: null, enabled: false },
      triggerConfig: { enabled: false, channelId: ch1G.id, type: 'rising', level: 0, positionPercent: 50 },
      measurementGate: 'view',
      separateView: false,
    };
    const nextView = stepTimebase125(tbTab, 1);
    const nextSpanT = (nextView.endIndex - nextView.startIndex) * (ch1G.dt || 1e-9);
    const nsStepOk = prevPs.timeUnit === 'ps' && nextSpanT >= 1e-9;

    const passed = rateOk && unitValOk && noNanHoles && nsStepOk;
    results.push({
      name: '1 GSa/s Sample Rate, ps Unit & Continuous Resample Test',
      passed,
      message: `fs=${ch1G.fs?.toExponential(1)}, unitStrip=${ch1G.v[1]}V, continuousResamplePts=${chPs.v.length} (NaNs=0), psDetected=${prevPs.timeUnit === 'ps'}`,
    });
  } catch (err: any) {
    results.push({
      name: '1 GSa/s Sample Rate, ps Unit & Continuous Resample Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 19. PSIM Variable-Step Bloat Guard & High-Speed Bounded FFT Test
  try {
    // Simulate PSIM variable-step file: dense 12ns sub-steps + 1us main steps over 2ms
    const lines = ['Time,Ia'];
    let curT = 0;
    for (let k = 0; k < 2000; k++) {
      // 70% fine 12ns switching steps, 30% normal 1us steps
      const step = k % 10 < 7 ? 12e-9 : 1e-6;
      curT += step;
      lines.push(`${curT.toExponential(6)},${Math.sin(2 * Math.PI * 1000 * curT).toFixed(4)}`);
    }
    const psimCsv = lines.join('\n');
    const prevPsim = previewCsv(psimCsv);
    const parsedPsim = parseFullCsv(psimCsv, {
      delimiter: prevPsim.delimiter,
      hasHeader: prevPsim.hasHeader,
      skipLines: prevPsim.skipLines,
      timeColIndex: prevPsim.timeColIndex,
      timeUnit: prevPsim.timeUnit,
      columnMappings: prevPsim.columnMappings,
      resample: true,
      colors: ['#facc15'],
    });
    const chPsim = parsedPsim.channels[parsedPsim.drawOrder[0]];
    const notBloatedOk = chPsim.v.length <= 262144;
    const cleanMetaOk = chPsim.metadata.qualityStatus === 'uniform' && chPsim.metadata.gapCount === 0;

    // Test FFT on 300k samples + NaN safety + 8x zero-padding cap
    const bigN = 300000;
    const bigT = new Float64Array(bigN);
    const bigV = new Float32Array(bigN);
    const bigFs = 1e6;
    for (let i = 0; i < bigN; i++) {
      bigT[i] = i / bigFs;
      bigV[i] = Math.sin(2 * Math.PI * 5000 * bigT[i]);
    }
    bigV[1234] = NaN; // Inject NaN to verify FFT does not become NaN

    const t0 = Date.now();
    const spec = computeFFT(
      bigT,
      bigV,
      bigFs,
      { range: 'entire', window: 'hann', scale: 'db', zeroPadding: 8, removeDC: true },
      'big_ch',
      'BigCh'
    );
    const elapsedMs = Date.now() - t0;
    const fftValidOk = spec.fftSize <= 262144 && isFinite(spec.magnitudes[10]) && spec.peaks.length > 0;
    const freqOk = Math.abs((spec.peaks[0]?.frequency ?? 0) - 5000) < 25;

    const passed = notBloatedOk && cleanMetaOk && fftValidOk && freqOk;
    results.push({
      name: 'Variable-Step Bloat Guard & Fast Bounded FFT Test',
      passed,
      message: `PSIM Resampled=${chPsim.v.length} pts (gaps=${chPsim.metadata.gapCount}); 300k FFT capped=${spec.fftSize} ran in ${elapsedMs}ms, peak=${spec.peaks[0]?.frequency?.toFixed(1)}Hz`,
    });
  } catch (err: any) {
    results.push({
      name: 'Variable-Step Bloat Guard & Fast Bounded FFT Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 20. Same-Unit Vertical Scale & Ground Baseline Unification (Driven by Largest Waveform)
  try {
    const n = 200;
    const t = new Float64Array(n);
    const v1 = new Float32Array(n); // CH1: 2 Vpp (±1V)
    const v2 = new Float32Array(n); // CH2: 20 Vpp (±10V) -> largest V channel
    const i3 = new Float32Array(n); // CH3: 10 App (±5A, different unit 'A')
    for (let i = 0; i < n; i++) {
      t[i] = i * 1e-4;
      const ph = (2 * Math.PI * i) / 50;
      v1[i] = 1.0 * Math.sin(ph);
      v2[i] = 10.0 * Math.sin(ph);
      i3[i] = 5.0 * Math.cos(ph);
    }

    const mkMeta = (count: number, fsVal: number): WaveformChannel['metadata'] => ({
      originalSampleCount: count,
      originalTimeStart: 0,
      originalTimeEnd: (count - 1) / fsVal,
      isUniformSampling: true,
      nominalDt: 1 / fsVal,
      medianDt: 1 / fsVal,
      meanDt: 1 / fsVal,
      minDt: 1 / fsVal,
      maxDt: 1 / fsVal,
      jitterRms: 0,
      jitterMax: 0,
      droppedSamples: 0,
      invalidSamples: 0,
      sampleRate: fsVal,
      qualityStatus: 'uniform',
      gapCount: 0,
      gapIndices: [],
    });

    const mkCh = (id: string, name: string, unit: string, v: Float32Array, vpd: number, off: number): WaveformChannel => ({
      id,
      name,
      unit,
      color: '#22d3ee',
      t,
      v,
      visible: true,
      vMin: -4 * vpd,
      vMax: 4 * vpd,
      voltsPerDiv: vpd,
      vOffset: off,
      coupling: 'DC',
      inverted: false,
      isMath: false,
      sourceChannelIds: [],
      fs: 10000,
      dt: 1e-4,
      metadata: mkMeta(n, 10000),
    });

    const ch1 = mkCh('ch1', 'CH1', 'V', v1, 0.5, 1.2);
    const ch2 = mkCh('ch2', 'CH2', 'V', v2, 5, -0.5);
    const ch3 = mkCh('ch3', 'CH3', 'A', i3, 2, 0.7);

    const syncTab: TabState = {
      id: 'sync_test',
      fileName: 'sync.csv',
      channels: { ch1, ch2, ch3 },
      drawOrder: ['ch1', 'ch2', 'ch3'],
      activeChannelId: 'ch1',
      view: { startIndex: 0, endIndex: n },
      cursors: { enabled: false, x1: null, x2: null, y1: null, y2: null, trackingChannel: null },
      annotations: [],
      annotationMode: false,
      annotationsVisible: true,
      isOverlap: true,
      plotMode: 'time',
      fftOptions: { range: 'entire', window: 'hann', scale: 'magnitude', zeroPadding: 1, removeDC: false },
      motorConfig: { rpm: null, polePairs: null, enabled: false },
      triggerConfig: { enabled: false, channelId: 'ch1', type: 'rising', level: 0, positionPercent: 50 },
      measurementGate: 'view',
      separateView: false,
    };

    const res = syncSameUnitChannelsScale(syncTab, 'ch1');
    const sameVpdOk = ch1.voltsPerDiv !== undefined && ch1.voltsPerDiv === ch2.voltsPerDiv && ch1.voltsPerDiv >= 2.5;
    const sameOffOk = ch1.vOffset === ch2.vOffset && ch1.vOffset === 0;
    const otherUnitUntouched = ch3.voltsPerDiv === 2 && Math.abs((ch3.vOffset ?? 0) - 0.7) < 1e-6;
    const driverOk = res?.driverChannelName === 'CH2' && res.syncedCount === 2;

    const passed = sameVpdOk && sameOffOk && otherUnitUntouched && driverOk;
    results.push({
      name: 'Same-Unit Vertical Scale & Baseline Unification Test',
      passed,
      message: `driver=${res?.driverChannelName}, unified=${ch1.voltsPerDiv}V/div offset=${ch1.vOffset}V, CH3(A)=${ch3.voltsPerDiv}A/div offset=${ch3.vOffset}A`,
    });
  } catch (err: any) {
    results.push({
      name: 'Same-Unit Vertical Scale & Baseline Unification Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 21. Park dq0, Two-Channel Phase Diff, RPM Speed Estimator & Power Integral
  try {
    const fs = 20000;
    const n = 2000; // 0.1s -> 5 cycles at 50 Hz
    const f0 = 50;
    const t = new Float64Array(n);
    const ua = new Float32Array(n);
    const ub = new Float32Array(n);
    const uc = new Float32Array(n);
    const ia = new Float32Array(n);
    const ib = new Float32Array(n);
    const ic = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      t[i] = i / fs;
      const w = 2 * Math.PI * f0 * t[i];
      ua[i] = 100 * Math.cos(w);
      ub[i] = 100 * Math.cos(w - (2 * Math.PI) / 3);
      uc[i] = 100 * Math.cos(w + (2 * Math.PI) / 3);
      ia[i] = 10 * Math.cos(w);
      ib[i] = 10 * Math.cos(w - (2 * Math.PI) / 3);
      ic[i] = 10 * Math.cos(w + (2 * Math.PI) / 3);
    }

    const clarke = computeClarke(ua, ub, uc);
    const theta = estimateElectricalAngleFromAlphaBeta(clarke.alpha, clarke.beta);
    const park = computePark(clarke.alpha, clarke.beta, theta);
    const mid = Math.floor(n / 2);
    const parkOk = Math.abs(park.d[mid] - 100) < 0.5 && Math.abs(park.q[mid]) < 0.5;

    const pArr = computeInstantaneousPower(ua, ub, uc, ia, ib, ic);
    const pSum = computePowerSummary(t, pArr);
    // Balanced 3-ph unity PF: P(t) = (3/2)*100*10 = 1500 W constant -> Energy over 0.1s ≈ 150 J
    const powerOk = Math.abs(pSum.avgPowerW - 1500) < 5 && Math.abs(pSum.energyJ - 150) < 1;

    // 2 pole pairs at 50 Hz electrical -> 1500 RPM
    const spd = estimateSpeedFromSignal(t, ua, 2);
    const rpmOk = spd.rpm !== null && Math.abs(spd.rpm - 1500) < 10;

    // Phase diff between Ua and Ub should be -120° (Ub lags Ua by 120°) or 240°
    const mkSimpleCh = (id: string, v: Float32Array): WaveformChannel => ({
      id,
      name: id,
      unit: 'V',
      color: '#fff',
      t,
      v,
      visible: true,
      vMin: -120,
      vMax: 120,
      voltsPerDiv: 30,
      vOffset: 0,
      coupling: 'DC',
      inverted: false,
      isMath: false,
      sourceChannelIds: [],
      fs,
      dt: 1 / fs,
      metadata: {
        originalSampleCount: n,
        originalTimeStart: 0,
        originalTimeEnd: (n - 1) / fs,
        isUniformSampling: true,
        nominalDt: 1 / fs,
        medianDt: 1 / fs,
        meanDt: 1 / fs,
        minDt: 1 / fs,
        maxDt: 1 / fs,
        jitterRms: 0,
        jitterMax: 0,
        droppedSamples: 0,
        invalidSamples: 0,
        sampleRate: fs,
        qualityStatus: 'uniform',
        gapCount: 0,
        gapIndices: [],
      },
    });
    const phaseRes = computeTwoChannelPhaseDiff(mkSimpleCh('ua', ua), mkSimpleCh('ub', ub));
    const phaseOk = phaseRes.phaseDeg !== null && Math.abs(Math.abs(phaseRes.phaseDeg) - 120) < 2;

    const passed = parkOk && powerOk && rpmOk && phaseOk;
    results.push({
      name: 'Park dq0, 3-Phase Power, RPM Speed & Phase Diff Test',
      passed,
      message: `Id=${park.d[mid].toFixed(2)} Iq=${park.q[mid].toFixed(2)}, Pavg=${pSum.avgPowerW.toFixed(1)}W, RPM=${spd.rpm?.toFixed(1)}, dPhi=${phaseRes.phaseDeg?.toFixed(2)}deg`,
    });
  } catch (err: any) {
    results.push({
      name: 'Park dq0, 3-Phase Power, RPM Speed & Phase Diff Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 22. Anomaly Scanner & Golden Reference Tolerance Band Test
  try {
    const n = 500;
    const t = new Float64Array(n);
    const refV = new Float32Array(n);
    const testV = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = i * 1e-4;
      const base = Math.sin((2 * Math.PI * i) / 50);
      refV[i] = base;
      testV[i] = base;
    }
    // Inject overshoot spike & undershoot sag
    testV[100] = 3.5;
    testV[250] = -3.2;

    const chTest: WaveformChannel = {
      id: 'anom_ch',
      name: 'Vout',
      unit: 'V',
      color: '#ef4444',
      t,
      v: testV,
      refV,
      visible: true,
      vMin: -4,
      vMax: 4,
      voltsPerDiv: 1,
      vOffset: 0,
      coupling: 'DC',
      inverted: false,
      isMath: false,
      sourceChannelIds: [],
      fs: 10000,
      dt: 1e-4,
      metadata: {
        originalSampleCount: n,
        originalTimeStart: 0,
        originalTimeEnd: (n - 1) * 1e-4,
        isUniformSampling: true,
        nominalDt: 1e-4,
        medianDt: 1e-4,
        meanDt: 1e-4,
        minDt: 1e-4,
        maxDt: 1e-4,
        jitterRms: 0,
        jitterMax: 0,
        droppedSamples: 0,
        invalidSamples: 0,
        sampleRate: 10000,
        qualityStatus: 'uniform',
        gapCount: 0,
        gapIndices: [],
      },
    };

    const anomalies = scanChannelAnomalies(chTest, {
      highThreshold: 2.0,
      lowThreshold: -2.0,
      minDvDt: 10000,
    });
    const overFound = anomalies.some((a) => a.kind === 'over' && Math.abs(a.value - 3.5) < 0.01);
    const underFound = anomalies.some((a) => a.kind === 'under' && Math.abs(a.value + 3.2) < 0.01);
    const dvdtFound = anomalies.some((a) => a.kind === 'dvdt');

    const failEval = evaluateGoldenTolerance(chTest, {
      enabled: true,
      channelId: chTest.id,
      mode: 'absolute',
      tolerance: 0.25,
      refV,
      refLabel: 'Golden',
    });
    const chClean: WaveformChannel = { ...chTest, v: new Float32Array(refV) };
    const passEval = evaluateGoldenTolerance(chClean, {
      enabled: true,
      channelId: chClean.id,
      mode: 'percent',
      tolerance: 5,
      refV,
      refLabel: 'Golden',
    });

    const passed = overFound && underFound && dvdtFound && !failEval.pass && failEval.violationCount === 2 && passEval.pass;
    results.push({
      name: 'Anomaly Scanner & Golden Tolerance Band Test',
      passed,
      message: `anomalies=${anomalies.length} (over=${overFound}, under=${underFound}, dvdt=${dvdtFound}); GoldenFailViolations=${failEval.violationCount}, CleanPass=${passEval.pass}`,
    });
  } catch (err: any) {
    results.push({
      name: 'Anomaly Scanner & Golden Tolerance Band Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 23. XY Lissajous Circularity & Quadrature Phase Test
  try {
    const n = 1000;
    const t = new Float64Array(n);
    const vx = new Float32Array(n);
    const vy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = i * 1e-4;
      const th = (2 * Math.PI * i) / 100;
      vx[i] = 5 * Math.cos(th);
      vy[i] = 5 * Math.sin(th);
    }
    const mkCh = (id: string, v: Float32Array): WaveformChannel => ({
      id,
      name: id,
      unit: 'V',
      color: '#22d3ee',
      t,
      v,
      visible: true,
      vMin: -8,
      vMax: 8,
      voltsPerDiv: 2,
      vOffset: 0,
      coupling: 'DC',
      inverted: false,
      isMath: false,
      sourceChannelIds: [],
      fs: 10000,
      dt: 1e-4,
      metadata: {
        originalSampleCount: n,
        originalTimeStart: 0,
        originalTimeEnd: (n - 1) * 1e-4,
        isUniformSampling: true,
        nominalDt: 1e-4,
        medianDt: 1e-4,
        meanDt: 1e-4,
        minDt: 1e-4,
        maxDt: 1e-4,
        jitterRms: 0,
        jitterMax: 0,
        droppedSamples: 0,
        invalidSamples: 0,
        sampleRate: 10000,
        qualityStatus: 'uniform',
        gapCount: 0,
        gapIndices: [],
      },
    });
    const xy = computeXYMetrics(mkCh('x', vx), mkCh('y', vy), 0, n);
    const circOk = xy.circularityPct !== null && Math.abs(xy.circularityPct - 100) < 0.5;
    const phaseOk = xy.lissajousPhaseDeg !== null && Math.abs(xy.lissajousPhaseDeg - 90) < 2;

    const passed = circOk && phaseOk;
    results.push({
      name: 'XY Lissajous Circularity & Phase Test',
      passed,
      message: `circularity=${xy.circularityPct?.toFixed(2)}%, lissajousPhase=${xy.lissajousPhaseDeg?.toFixed(2)}deg`,
    });
  } catch (err: any) {
    results.push({
      name: 'XY Lissajous Circularity & Phase Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 24. Cross-Rate Waveform Compare, Auto-Edge Alignment & RMSE/Correlation Test
  try {
    const fsA = 20000;
    const nA = 1000;
    const tA = new Float64Array(nA);
    const vA = new Float32Array(nA);
    for (let i = 0; i < nA; i++) {
      tA[i] = i / fsA;
      vA[i] = 5 * Math.sin(2 * Math.PI * 100 * tA[i]);
    }

    // Reference sampled at different rate (10 kS/s) AND delayed by 2.0 ms + +1.5V DC offset
    const fsB = 10000;
    const nB = 600;
    const tB = new Float64Array(nB);
    const vB = new Float32Array(nB);
    const delaySec = 0.002;
    for (let i = 0; i < nB; i++) {
      tB[i] = i / fsB;
      vB[i] = 1.5 + 5 * Math.sin(2 * Math.PI * 100 * (tB[i] + delaySec));
    }

    const mkCmpCh = (id: string, t: Float64Array, v: Float32Array, fs: number): WaveformChannel => ({
      id,
      name: id,
      unit: 'V',
      color: '#22d3ee',
      t,
      v,
      visible: true,
      vMin: -10,
      vMax: 10,
      voltsPerDiv: 2.5,
      vOffset: 0,
      coupling: 'DC',
      inverted: false,
      isMath: false,
      sourceChannelIds: [],
      fs,
      dt: 1 / fs,
      metadata: {
        originalSampleCount: v.length,
        originalTimeStart: 0,
        originalTimeEnd: (v.length - 1) / fs,
        isUniformSampling: true,
        nominalDt: 1 / fs,
        medianDt: 1 / fs,
        meanDt: 1 / fs,
        minDt: 1 / fs,
        maxDt: 1 / fs,
        jitterRms: 0,
        jitterMax: 0,
        droppedSamples: 0,
        invalidSamples: 0,
        sampleRate: fs,
        qualityStatus: 'uniform',
        gapCount: 0,
        gapIndices: [],
      },
    });

    const chA = mkCmpCh('A', tA, vA, fsA);
    const chB = mkCmpCh('B', tB, vB, fsB);
    const shift = computeAutoTimeAlignShift(chA, chB, 'rising-edge');
    const aligned = alignAndInterpolateReference(chA, chB, shift, true);
    const m = computeWaveformCompareMetrics(chA, aligned.alignedRefV, true);

    const shiftOk = Math.abs(shift - delaySec) < 2e-4;
    const rmseOk = m.rmse !== null && m.rmse < 0.05;
    const corrOk = m.correlation !== null && m.correlation > 0.999;

    // Multi-file group palette uniqueness check
    const c0 = getCompareGroupTraceColor('emerald', 0, 'family');
    const c1 = getCompareGroupTraceColor('emerald', 1, 'family');
    const c2 = getCompareGroupTraceColor('emerald', 2, 'family');
    const d0 = getCompareGroupTraceColor('amber', 0, 'distinct');
    const groupPaletteOk = COMPARE_GROUP_THEMES.length >= 6 && c0 !== c1 && c1 !== c2 && /^#[0-9a-f]{6}$/i.test(d0);

    const passed = shiftOk && rmseOk && corrOk && groupPaletteOk;
    results.push({
      name: 'Cross-Rate Waveform Compare & Group Palette Test',
      passed,
      message: `shift=${(shift * 1000).toFixed(3)}ms (expected 2.000ms), RMSE=${m.rmse?.toFixed(4)}V, r=${m.correlation?.toFixed(5)}, themes=${COMPARE_GROUP_THEMES.length}`,
    });
  } catch (err: any) {
    results.push({
      name: 'Cross-Rate Waveform Compare & Auto-Alignment Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 25. File Fingerprint Deduplication & Cross-Scale (ms vs s) + t0 Alignment Test
  try {
    const fpA1 = computeTextFingerprint('wave_test.csv', 't,v\n0,1.0\n0.001,2.0\n');
    const fpA2 = computeTextFingerprint('wave_test.csv', 't,v\n0,1.0\n0.001,2.0\n');
    const fpDiffContent = computeTextFingerprint('wave_test.csv', 't,v\n0,1.0\n0.001,2.1\n');
    const fpDiffName = computeTextFingerprint('wave_test_copy.csv', 't,v\n0,1.0\n0.001,2.0\n');
    const fpOk = fpA1 === fpA2 && fpA1 !== fpDiffContent && fpA1 !== fpDiffName;

    // Target: 0 .. 20 ms (dt = 0.05 ms -> 401 pts), 100 Hz sine
    const nT = 401;
    const tT = new Float64Array(nT);
    const vT = new Float32Array(nT);
    for (let i = 0; i < nT; i++) {
      tT[i] = i * 5e-5; // 0..0.02s (20ms)
      vT[i] = 3.3 * Math.sin(2 * Math.PI * 100 * tT[i]);
    }

    // Ref: logged in seconds-unit mistake (0..20s instead of 0..20ms) AND shifted to t0 = 100s
    const nR = 401;
    const tR = new Float64Array(nR);
    const vR = new Float32Array(nR);
    for (let i = 0; i < nR; i++) {
      const localMsSec = i * 0.05; // 1000x larger step
      tR[i] = 100 + localMsSec;
      vR[i] = 3.3 * Math.sin(2 * Math.PI * 100 * (localMsSec * 0.001));
    }

    const mkCh = (id: string, t: Float64Array, v: Float32Array): WaveformChannel => ({
      id,
      name: id,
      unit: 'V',
      color: '#22d3ee',
      t,
      v,
      visible: true,
      vMin: -5,
      vMax: 5,
      voltsPerDiv: 1,
      vOffset: 0,
      coupling: 'DC',
      inverted: false,
      isMath: false,
      sourceChannelIds: [],
      fs: 1 / Math.abs(t[1] - t[0]),
      dt: Math.abs(t[1] - t[0]),
      metadata: {
        originalSampleCount: t.length,
        originalTimeStart: t[0],
        originalTimeEnd: t[t.length - 1],
        isUniformSampling: true,
        nominalDt: Math.abs(t[1] - t[0]),
        medianDt: Math.abs(t[1] - t[0]),
        meanDt: Math.abs(t[1] - t[0]),
        minDt: Math.abs(t[1] - t[0]),
        maxDt: Math.abs(t[1] - t[0]),
        jitterRms: 0,
        jitterMax: 0,
        droppedSamples: 0,
        invalidSamples: 0,
        sampleRate: 1 / Math.abs(t[1] - t[0]),
        qualityStatus: 'uniform',
        gapCount: 0,
        gapIndices: [],
      },
    });

    const chT = mkCh('TargetMs', tT, vT);
    const chR = mkCh('RefSecShifted', tR, vR);
    const rec = detectRecommendedTimeScale(chT, chR);
    const shiftStart = computeAutoTimeAlignShift(chT, chR, 'start', rec.timeScale);
    const aligned = alignAndInterpolateReference(chT, chR, shiftStart, false, rec.timeScale);
    const m = computeWaveformCompareMetrics(chT, aligned.alignedRefV, false);

    const scaleOk = rec.isLargeMismatch && Math.abs(rec.timeScale - 0.001) < 1e-9;
    const shiftOk = Math.abs(shiftStart - (-100)) < 1e-9;
    const alignOk = aligned.overlapCount === nT && m.rmse !== null && m.rmse < 1e-4 && m.correlation !== null && m.correlation > 0.9999;

    results.push({
      name: 'Compare Deduplication & Cross-Scale (ms vs s) + t0 Alignment Test',
      passed: fpOk && scaleOk && shiftOk && alignOk,
      message: `fpOk=${fpOk}, scale=${rec.timeScale}, shift=${shiftStart}s, overlap=${aligned.overlapCount}/${nT}, RMSE=${m.rmse?.toExponential(2)}, r=${m.correlation?.toFixed(5)}`,
    });
  } catch (err: any) {
    results.push({
      name: 'Compare Deduplication & Cross-Scale (ms vs s) + t0 Alignment Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 26. BLDC Diagnostics Suite Test (3-Ph Balance, 6-Step Hall, PWM Dead-Time, 6x Ripple, Derived Traces)
  try {
    const mkBldcCh = (id: string, name: string, unit: string, t: Float64Array, v: Float32Array): WaveformChannel => ({
      id,
      name,
      unit,
      color: '#22d3ee',
      t,
      v,
      visible: true,
      vMin: -30,
      vMax: 30,
      voltsPerDiv: 10,
      vOffset: 0,
      coupling: 'DC',
      inverted: false,
      isMath: false,
      sourceChannelIds: [],
      fs: 1 / Math.abs(t[1] - t[0]),
      dt: Math.abs(t[1] - t[0]),
      metadata: {
        originalSampleCount: t.length,
        originalTimeStart: t[0],
        originalTimeEnd: t[t.length - 1],
        isUniformSampling: true,
        nominalDt: Math.abs(t[1] - t[0]),
        medianDt: Math.abs(t[1] - t[0]),
        meanDt: Math.abs(t[1] - t[0]),
        minDt: Math.abs(t[1] - t[0]),
        maxDt: Math.abs(t[1] - t[0]),
        jitterRms: 0,
        jitterMax: 0,
        droppedSamples: 0,
        invalidSamples: 0,
        sampleRate: 1 / Math.abs(t[1] - t[0]),
        qualityStatus: 'uniform',
        gapCount: 0,
        gapIndices: [],
      },
    });

    // 1) 3-Phase Balance & Derived Traces (200 Hz, slightly higher Vpp on Phase U to test unbalance)
    const fs1 = 50000;
    const n1 = 2500; // 50 ms = 10 cycles
    const t1 = new Float64Array(n1);
    const u1 = new Float32Array(n1);
    const v1 = new Float32Array(n1);
    const w1 = new Float32Array(n1);
    const iBus = new Float32Array(n1);
    for (let i = 0; i < n1; i++) {
      t1[i] = i / fs1;
      const th = 2 * Math.PI * 200 * t1[i];
      u1[i] = 24 * Math.sin(th);
      v1[i] = 24 * Math.sin(th - (2 * Math.PI) / 3);
      w1[i] = 24 * Math.sin(th + (2 * Math.PI) / 3);
      // Bus current with 10 A DC + 1.5 A 6x commutation ripple (1200 Hz)
      iBus[i] = 10 + 1.5 * Math.sin(6 * th);
    }
    const chU = mkBldcCh('u', 'Ua', 'V', t1, u1);
    const chV = mkBldcCh('v', 'Ub', 'V', t1, v1);
    const chW = mkBldcCh('w', 'Uc', 'V', t1, w1);
    const chI = mkBldcCh('ib', 'Ibus', 'A', t1, iBus);

    const bal = analyzeThreePhaseBalance(chU, chV, chW);
    const derived = computeBldcDerivedTraces(chU, chV, chW);
    const balOk = bal.vppUnbalancePct < 0.5 && bal.zeroSeqRms < 1e-3 && bal.maxPhaseErrorDeg !== null && bal.maxPhaseErrorDeg < 1.0;
    const derivedOk = Math.abs(derived.uuv[0] - (u1[0] - v1[0])) < 1e-4 && derived.svmMag[0] > 20;

    // 2) 6-Step Hall Commutation: 100 Hz electrical, 4 pole pairs => 1500 RPM, CW sequence 5->1->3->2->6->4
    const fsH = 60000;
    const nH = 3000; // 50 ms = 5 electrical cycles
    const tH = new Float64Array(nH);
    const hA = new Float32Array(nH);
    const hB = new Float32Array(nH);
    const hC = new Float32Array(nH);
    const ring = [5, 1, 3, 2, 6, 4];
    for (let i = 0; i < nH; i++) {
      tH[i] = i / fsH;
      const deg = ((tH[i] * 100 * 360) % 360 + 360) % 360;
      const sector = Math.min(5, Math.floor(deg / 60));
      const code = ring[sector];
      hA[i] = (code & 4) ? 5 : 0;
      hB[i] = (code & 2) ? 5 : 0;
      hC[i] = (code & 1) ? 5 : 0;
    }
    const hallRes = analyzeBldcHallCommutation(
      mkBldcCh('ha', 'HallA', 'V', tH, hA),
      mkBldcCh('hb', 'HallB', 'V', tH, hB),
      mkBldcCh('hc', 'HallC', 'V', tH, hC),
      4
    );
    const hallOk =
      hallRes.direction === 'CW (Fwd)' &&
      hallRes.illegalStateCount === 0 &&
      hallRes.sequenceJumpCount === 0 &&
      hallRes.avgRpm !== null &&
      Math.abs(hallRes.avgRpm - 1500) < 15 &&
      hallRes.maxSectorErrorDeg !== null &&
      hallRes.maxSectorErrorDeg < 2;

    // 3) Complementary PWM Switching + 500 ns Dead-Time (20 kHz, 10 MS/s)
    const fsP = 10_000_000; // 100 ns sample step
    const nP = 2000; // 200 us = 4 PWM periods of 50 us
    const tP = new Float64Array(nP);
    const pwmH = new Float32Array(nP);
    const pwmL = new Float32Array(nP);
    for (let i = 0; i < nP; i++) {
      tP[i] = i / fsP;
      const phaseUs = (tP[i] * 1e6) % 50; // 0..50 us
      // High ON [0.5 .. 24.5], Low ON [25.0 .. 50.0) => 500 ns dead-time around 24.5..25.0 and 0..0.5
      pwmH[i] = phaseUs >= 0.5 && phaseUs < 24.5 ? 12 : 0;
      pwmL[i] = phaseUs >= 25.0 ? 12 : 0;
    }
    const pwmRes = analyzePwmSwitchingAndDeadTime(
      mkBldcCh('ph', 'PWM_H', 'V', tP, pwmH),
      mkBldcCh('pl', 'PWM_L', 'V', tP, pwmL)
    );
    const pwmOk =
      pwmRes.pwmFreqHz !== null &&
      Math.abs(pwmRes.pwmFreqHz - 20000) < 500 &&
      pwmRes.deadTimeAvgSec !== null &&
      Math.abs(pwmRes.deadTimeAvgSec - 500e-9) < 120e-9 &&
      pwmRes.shootThroughCount === 0;

    // 4) Torque / Bus Current 6x Commutation Harmonic
    const ripRes = analyzeTorqueAndCurrentRipple(chI, 200);
    const ripOk =
      Math.abs(ripRes.mean - 10) < 0.1 &&
      ripRes.harm6xAmp !== null &&
      Math.abs(ripRes.harm6xAmp - 1.5) < 0.2;

    const passed = balOk && derivedOk && hallOk && pwmOk && ripOk;
    results.push({
      name: 'BLDC Motor & Inverter Diagnostics Suite Test',
      passed,
      message: `balOk=${balOk}, hallRPM=${hallRes.avgRpm?.toFixed(1)} (${hallRes.direction}), deadTime=${pwmRes.deadTimeAvgSec ? (pwmRes.deadTimeAvgSec * 1e9).toFixed(0) : '--'}ns, 6xHarm=${ripRes.harm6xAmp?.toFixed(2)}A`,
    });
  } catch (err: any) {
    results.push({
      name: 'BLDC Motor & Inverter Diagnostics Suite Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 22. LTspice .raw (ASCII + Binary), Stepped .txt Import & Computed Trace Identification Test
  try {
    const palette = THEME_PRESETS.obsidian.rawPalette;
    // 22a) ASCII .raw
    const asciiRaw = [
      'Title: * Buck_Converter.asc',
      'Date: Fri Nov 21 08:00:00 2026',
      'Plotname: Transient Analysis',
      'Flags: real forward',
      'No. Variables: 3',
      'No. Points: 4',
      'Variables:',
      '\t0\ttime\ttime',
      '\t1\tV(out)\tvoltage',
      '\t2\tI(L1)\tdevice_current',
      'Values:',
      '0\t0.000000e+00',
      '\t5.000000e+00',
      '\t1.000000e+00',
      '1\t1.000000e-06',
      '\t5.100000e+00',
      '\t1.200000e+00',
      '2\t2.000000e-06',
      '\t5.200000e+00',
      '\t1.400000e+00',
      '3\t3.000000e-06',
      '\t5.300000e+00',
      '\t1.600000e+00',
      '',
    ].join('\n');
    const asciiBuf = new TextEncoder().encode(asciiRaw).buffer;
    const parsedAscii = parseLtspiceRawBuffer(asciiBuf, palette);
    const vOutCh = parsedAscii.channels[parsedAscii.drawOrder[0]];
    const iL1Ch = parsedAscii.channels[parsedAscii.drawOrder[1]];
    const asciiOk =
      parsedAscii.drawOrder.length === 2 &&
      vOutCh.name === 'V(out)' &&
      vOutCh.unit === 'V' &&
      iL1Ch.name === 'I(L1)' &&
      iL1Ch.unit === 'A' &&
      Math.abs(vOutCh.v[3] - 5.3) < 1e-4 &&
      Math.abs(iL1Ch.v[2] - 1.4) < 1e-4;

    // 22b) Binary .raw (float64 time + float32 vars)
    const binHeader = [
      'Title: * Binary_Test.asc',
      'Plotname: Transient Analysis',
      'Flags: real forward',
      'No. Variables: 2',
      'No. Points: 3',
      'Variables:',
      '\t0\ttime\ttime',
      '\t1\tV(sw)\tvoltage',
      'Binary:',
      '',
    ].join('\n');
    const hdrBytes = new TextEncoder().encode(binHeader);
    const stride = 8 + 4; // float64 time + float32 V(sw)
    const binBuf = new ArrayBuffer(hdrBytes.length + 3 * stride);
    new Uint8Array(binBuf).set(hdrBytes, 0);
    const dv = new DataView(binBuf, hdrBytes.length);
    for (let p = 0; p < 3; p++) {
      dv.setFloat64(p * stride, p * 1e-6, true);
      dv.setFloat32(p * stride + 8, (p + 1) * 12, true);
    }
    const parsedBin = parseLtspiceRawBuffer(binBuf, palette);
    const swCh = parsedBin.channels[parsedBin.drawOrder[0]];
    const binOk =
      parsedBin.drawOrder.length === 1 &&
      swCh.name === 'V(sw)' &&
      Math.abs(swCh.v[0] - 12) < 1e-3 &&
      Math.abs(swCh.v[2] - 36) < 1e-3;

    // 22c) Stepped .txt export
    const steppedTxt = [
      'time\tV(out)\tI(L1)',
      'Step Information: Rload=10 (Run: 1/2)',
      '0.000e+00\t5.0\t0.5',
      '1.000e-06\t5.0\t0.5',
      '2.000e-06\t5.0\t0.5',
      'Step Information: Rload=5 (Run: 2/2)',
      '0.000e+00\t4.8\t0.96',
      '1.000e-06\t4.8\t0.96',
      '2.000e-06\t4.8\t0.96',
    ].join('\n');
    const detectedTxt = isLtspiceExportText(steppedTxt);
    const parsedTxt = parseLtspiceText(steppedTxt, palette);
    const txtOk =
      detectedTxt &&
      parsedTxt.stepCount === 2 &&
      parsedTxt.drawOrder.length === 4 &&
      parsedTxt.channels[parsedTxt.drawOrder[0]].ltspiceStepLabel === 'Rload=10';

    // 22d) Derived math channel expression using LTspice trace names
    const mathPower = evaluateMathExpression('V(out) * I(L1)', parsedAscii.channels, parsedAscii.drawOrder, 'math_pwr', 'P(L1)');
    const mathOk =
      mathPower.channelKind === 'computed' &&
      mathPower.derivedBadge === 'fx' &&
      Math.abs(mathPower.v[3] - 5.3 * 1.6) < 1e-2;

    results.push({
      name: 'LTspice (.raw Binary/ASCII, Stepped .txt & Math V*I) Test',
      passed: asciiOk && binOk && txtOk && mathOk,
      message: `asciiOk=${asciiOk}, binOk=${binOk}, steppedTxt=${parsedTxt.stepCount} runs/${parsedTxt.drawOrder.length} ch, mathBadge=${mathPower.derivedBadge}`,
    });
  } catch (err: any) {
    results.push({
      name: 'LTspice (.raw Binary/ASCII, Stepped .txt & Math V*I) Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 23. Multi-Theme Preset & Surface Luminance Integrity Test
  try {
    const ids: Array<keyof typeof THEME_PRESETS> = ['obsidian', 'midnight', 'daylight'];
    const allValid = ids.every((id) => {
      const p = THEME_PRESETS[id];
      return (
        p &&
        p.rawPalette.length >= 8 &&
        p.computedPalette.length >= 6 &&
        Boolean(p.cssVars['--bg-chassis']) &&
        Boolean(p.cssVars['--bg-panel']) &&
        Boolean(p.cssVars['--bg-elevated']) &&
        Boolean(p.cssVars['--canvas-stage']) &&
        p.cssVars['--bg-chassis'] !== p.cssVars['--bg-panel'] &&
        p.cssVars['--bg-panel'] !== p.cssVars['--bg-elevated'] &&
        p.canvas.bg !== p.cssVars['--bg-panel']
      );
    });
    const lightFlagOk = !THEME_PRESETS.obsidian.isLight && !THEME_PRESETS.midnight.isLight && THEME_PRESETS.daylight.isLight;
    results.push({
      name: 'Three-Theme Calibration & Surface Contrast Test',
      passed: allValid && lightFlagOk,
      message: `themes=${ids.join('/')}, lightModeDaylight=${THEME_PRESETS.daylight.isLight}, rawCols=${THEME_PRESETS.daylight.rawPalette.length}`,
    });
  } catch (err: any) {
    results.push({
      name: 'Three-Theme Calibration & Surface Contrast Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  return results;
}
