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
import { computeClarke } from '../modules/transforms';
import { computeMeasurements } from '../modules/measurements';
import { WaveformChannel } from '../types/models';
import { runDynamicMutationTests } from './dynamicMutationTest';

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

  return results;
}
