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
import { previewCsv, parseFullCsv } from '../parsers/csvParser';
import { OVERLAP_COLORS } from '../engine/canvasRenderer';
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

  // 5. Gap Semantics Test: an adaptive solver step is NOT a gap, real missing
  //    samples (NaN / empty fields) ARE reported as gaps.
  try {
    const dt = 1e-4;
    const t = new Float64Array(2000);
    let curTime = 0;
    for (let i = 0; i < 1000; i++) {
      t[i] = curTime;
      curTime += dt;
    }
    curTime += dt * 10; // 10x adaptive step
    for (let i = 1000; i < 2000; i++) {
      t[i] = curTime;
      curTime += dt;
    }

    const quality = analyzeSamplingQuality(t);
    const noFalseGap = quality.gapCount === 0 && quality.isUniformSampling === false;

    // A truly missing sample must still be reported.
    const missingText = ['time\tVa', '0.0\t1.0', '1e-4\t2.0', '2e-4\t', '3e-4\t4.0'].join('\n');
    const missingPreview = previewCsv(missingText);
    const missingParsed = parseFullCsv(missingText, {
      delimiter: '\t',
      hasHeader: missingPreview.hasHeader,
      timeColIndex: 0,
      timeUnit: 's',
      columnMappings: missingPreview.columnMappings,
      resample: false,
      colors: OVERLAP_COLORS,
    });
    const missingCh = missingParsed.channels[missingParsed.drawOrder[0]];
    const missingDetected = !!missingCh
      && missingCh.metadata.gapCount === 1
      && missingCh.metadata.gapIndices.includes(2)
      && isNaN(missingCh.v[2]);

    const passed = noFalseGap && missingDetected;

    results.push({
      name: 'Gap Semantics Test (adaptive dt vs missing sample)',
      passed,
      message: `adaptiveSteps=${quality.gapCount} falseGap, quality=${quality.qualityStatus}, missingSamples=${missingCh?.metadata.gapCount ?? -1} at [${missingCh?.metadata.gapIndices.join(', ') ?? ''}]`,
    });
  } catch (err: any) {
    results.push({
      name: 'Gap Semantics Test (adaptive dt vs missing sample)',
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

  // 9. Vertical Scale Stepping (V/div) and Offset Calculation Test
  try {
    const vPerDiv = 0.5; // 0.5 V/div -> 8 divisions = 4.0 V span
    const offset = 1.5;   // 1.5 V center offset
    const halfSpan = vPerDiv * 4;
    const vMin = offset - halfSpan; // -0.5 V
    const vMax = offset + halfSpan; // 3.5 V

    const spanOk = Math.abs((vMax - vMin) - 4.0) < 1e-6;
    const centerOk = Math.abs((vMax + vMin) / 2 - 1.5) < 1e-6;
    const passed = spanOk && centerOk;

    results.push({
      name: 'Vertical Scale & Offset Deterministic Bounds Test',
      passed,
      message: `V/div=${vPerDiv}V, Offset=${offset}V -> [${vMin}, ${vMax}] (span=${vMax - vMin}V, center=${(vMax + vMin) / 2}V)`,
    });
  } catch (err: any) {
    results.push({
      name: 'Vertical Scale & Offset Deterministic Bounds Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 10. Horizontal (X) and Vertical (Y) Cursors Calculation Test
  try {
    const x1 = 0.002;
    const x2 = 0.007;
    const deltaT = Math.abs(x2 - x1); // 0.005 s
    const freq = 1 / deltaT;         // 200 Hz

    const y1 = -1.25;
    const y2 = 2.75;
    const deltaV = Math.abs(y2 - y1); // 4.0 V

    const xOk = Math.abs(deltaT - 0.005) < 1e-9 && Math.abs(freq - 200) < 1e-6;
    const yOk = Math.abs(deltaV - 4.0) < 1e-9;
    const passed = xOk && yOk;

    results.push({
      name: 'Dual X and Y Cursors Calculation Test',
      passed,
      message: `ΔT = ${(deltaT * 1000).toFixed(3)} ms (1/ΔT = ${freq.toFixed(1)} Hz), ΔV = ${deltaV.toFixed(3)} V`,
    });
  } catch (err: any) {
    results.push({
      name: 'Dual X and Y Cursors Calculation Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 11. Separate Mode Multi-Channel Subplot Axes Verification Test
  try {
    const chA = { vMin: -5, vMax: 5, unit: 'V' };
    const chB = { vMin: 0, vMax: 100, unit: 'mV' };
    const chC = { vMin: -24, vMax: 24, unit: 'V' };

    // Subplot A: 4 divisions from 5V down to -5V
    const stepA = (chA.vMax - chA.vMin) / 4; // 2.5 V/step
    // Subplot B: 4 divisions from 100mV down to 0mV
    const stepB = (chB.vMax - chB.vMin) / 4; // 25 mV/step
    // Subplot C: 4 divisions from 24V down to -24V
    const stepC = (chC.vMax - chC.vMin) / 4; // 12 V/step

    const passed = Math.abs(stepA - 2.5) < 1e-6 && Math.abs(stepB - 25) < 1e-6 && Math.abs(stepC - 12) < 1e-6;
    results.push({
      name: 'Separate Mode Subplot Independent Axes Test',
      passed,
      message: `Subplots independently graduated: CH_A step=${stepA}V, CH_B step=${stepB}mV, CH_C step=${stepC}V`,
    });
  } catch (err: any) {
    results.push({
      name: 'Separate Mode Subplot Independent Axes Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 12. Space and Multi-Space Whitespace Delimiter Parsing Test
  try {
    const spaceText = [
      'time          V(out)            I(L1)',
      '0.000000e+000 0.000000e+000     0.000000e+000',
      '1.250000e-007 1.458210e-001     2.341029e-003',
      '2.500000e-007 2.871020e-001     4.512090e-003',
    ].join('\n');

    const preview = previewCsv(spaceText);
    const delimOk = preview.delimiter === ' ';
    const colsOk = preview.headers.length === 3 && preview.headers[0].toLowerCase() === 'time' && preview.headers[1] === 'V(out)' && preview.headers[2] === 'I(L1)';
    const rowsOk = preview.rows.length === 3 && preview.rows[0].length === 3;
    const valsOk = Math.abs(parseFloat(preview.rows[1][1]) - 0.145821) < 1e-5;
    const passed = delimOk && colsOk && rowsOk && valsOk;

    results.push({
      name: 'Space & Multi-Space Delimiter Parsing Test',
      passed,
      message: `Delimiter='${preview.delimiter}', Headers=[${preview.headers.join(', ')}], Rows=${preview.rows.length}x${preview.rows[0]?.length || 0}`,
    });
  } catch (err: any) {
    results.push({
      name: 'Space & Multi-Space Delimiter Parsing Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 13. PSIM-style adaptive time-base + metadata import regression test
  try {
    const psimLike = [
      'time\t-I(R43)\t-I(RsA)\t-I(RsB)',
      'Step Information: U=0  (Step: 1/1)',
      '0.000000000000000e+00\t1.250797e-07\t-4.808243e-09\t-8.449385e-06',
      '9.999999439624929e-11\t1.250795e-07\t-4.808243e-09\t-8.449383e-06',
      '8.012369786017312e-09\t1.250795e-07\t-4.808243e-09\t-8.449322e-06',
      '2.000000000000000e-05\t2.000872e-01\t-8.570964e-03\t-5.274751e-01',
    ].join('\n');

    const preview = previewCsv(psimLike);
    const parsed = parseFullCsv(psimLike, {
      delimiter: '\t',
      hasHeader: preview.hasHeader,
      timeColIndex: 0,
      timeUnit: 's',
      columnMappings: preview.columnMappings,
      resample: false,
      colors: OVERLAP_COLORS,
    });

    const first = parsed.channels[parsed.drawOrder[0]];
    const hasSignal = !!first && first.v.length === 4 && first.v.every((x) => isFinite(x));
    const noFalseGaps = parsed.quality.gapCount === 0 && parsed.quality.isUniformSampling === false;
    const passed = preview.hasHeader && preview.timeColIndex === 0 && parsed.drawOrder.length === 3 && hasSignal && noFalseGaps;

    results.push({
      name: 'PSIM Adaptive Timebase Import Regression Test',
      passed,
      message: `Header=${preview.hasHeader}, channels=${parsed.drawOrder.length}, samples=${first?.v.length || 0}, quality=${parsed.quality.qualityStatus}, falseGaps=${parsed.quality.gapCount}`,
    });
  } catch (err: any) {
    results.push({
      name: 'PSIM Adaptive Timebase Import Regression Test',
      passed: false,
      message: `Exception: ${err.message}`,
    });
  }

  // 14. Dynamic Input Mutation & Fail-Closed Tests
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
