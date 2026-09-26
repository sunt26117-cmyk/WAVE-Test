/**
 * Waveform Viewer Pro - Dynamic Mutation & Audit Tests
 * Verifies that modifying input parameters strictly mutates all corresponding outputs,
 * and that missing inputs cause proper Fail-Closed behavior (zero fake fallbacks).
 */

import { computeFFT, computeBLDCHarmonics } from '../modules/fft';
import { evaluateMathExpression } from '../modules/mathParser';
import { computeMeasurements } from '../modules/measurements';
import { WaveformChannel } from '../types/models';

export function runDynamicMutationTests(): { name: string; passed: boolean; details: string }[] {
  const tests: { name: string; passed: boolean; details: string }[] = [];

  // Mutation 1: FFT Frequency tracks input frequency change (1 kHz -> 5 kHz)
  {
    const fs = 100000;
    const n = 16384;
    const t = new Float64Array(n);
    const v1 = new Float32Array(n);
    const v5 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = i / fs;
      v1[i] = Math.sin(2 * Math.PI * 1000 * t[i]);
      v5[i] = Math.sin(2 * Math.PI * 5000 * t[i]);
    }

    const s1 = computeFFT(t, v1, fs, { range: 'entire', window: 'hann', scale: 'magnitude', zeroPadding: 1, removeDC: false }, 'ch1', '1k');
    const s5 = computeFFT(t, v5, fs, { range: 'entire', window: 'hann', scale: 'magnitude', zeroPadding: 1, removeDC: false }, 'ch1', '5k');

    const p1 = s1.peaks.find((p) => p.isFundamental)?.frequency || s1.peaks[0].frequency;
    const p5 = s5.peaks.find((p) => p.isFundamental)?.frequency || s5.peaks[0].frequency;

    const diff = Math.abs(p5 - p1);
    const passed = Math.abs(p1 - 1000) < 10 && Math.abs(p5 - 5000) < 10 && diff > 3900;
    tests.push({
      name: 'Dynamic FFT Frequency Mutation (1kHz vs 5kHz)',
      passed,
      details: `Input 1kHz gave ${p1.toFixed(1)} Hz, Input 5kHz gave ${p5.toFixed(1)} Hz`,
    });
  }

  // Mutation 2: Amplitude mutation (1V vs 2V -> peak magnitude & RMS doubles)
  {
    const fs = 50000;
    const n = 8192;
    const t = new Float64Array(n);
    const v1 = new Float32Array(n);
    const v2 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = i / fs;
      v1[i] = 1.0 * Math.sin(2 * Math.PI * 200 * t[i]);
      v2[i] = 2.0 * Math.sin(2 * Math.PI * 200 * t[i]);
    }

    const s1 = computeFFT(t, v1, fs, { range: 'entire', window: 'hann', scale: 'magnitude', zeroPadding: 1, removeDC: false }, 'ch1', '1V');
    const s2 = computeFFT(t, v2, fs, { range: 'entire', window: 'hann', scale: 'magnitude', zeroPadding: 1, removeDC: false }, 'ch1', '2V');

    const m1 = s1.peaks[0].magnitude;
    const m2 = s2.peaks[0].magnitude;
    const ratio = m2 / m1;

    const passed = Math.abs(ratio - 2.0) < 0.05;
    tests.push({
      name: 'Dynamic Amplitude Mutation (1V vs 2V)',
      passed,
      details: `Mag 1V: ${m1.toFixed(3)} V, Mag 2V: ${m2.toFixed(3)} V (Ratio: ${ratio.toFixed(2)})`,
    });
  }

  // Mutation 3: BLDC Motor RPM & Pole Pairs changes fe proportionally; Fail-closed if missing
  {
    // Test valid calculation
    const res1 = computeBLDCHarmonics({ enabled: true, rpm: 3000, polePairs: 4 });
    const res2 = computeBLDCHarmonics({ enabled: true, rpm: 6000, polePairs: 4 });
    const res3 = computeBLDCHarmonics({ enabled: true, rpm: 3000, polePairs: 8 });

    // fe = p * RPM / 60
    // res1: 4 * 3000 / 60 = 200 Hz
    // res2: 4 * 6000 / 60 = 400 Hz
    // res3: 8 * 3000 / 60 = 400 Hz
    const okCalc = res1.fe === 200 && res2.fe === 400 && res3.fe === 400;

    // Test fail-closed when RPM is null
    const resFailRPM = computeBLDCHarmonics({ enabled: true, rpm: null, polePairs: 4 });
    const okFailClosed = resFailRPM.fe === null && resFailRPM.markers.length === 0 && resFailRPM.statusMessage.includes('RPM is required');

    const passed = okCalc && okFailClosed;
    tests.push({
      name: 'Motor Harmonics Mutation & Fail-Closed Test',
      passed,
      details: `RPM 3000->200Hz, 6000->400Hz, Missing RPM properly returned null with warning: "${resFailRPM.statusMessage}"`,
    });
  }

  // Mutation 4: Math Channel expression change updates output strictly
  {
    const n = 50;
    const t = new Float64Array(n);
    const v1 = new Float32Array(n).fill(5);
    const v2 = new Float32Array(n).fill(3);

    const ch1: WaveformChannel = {
      id: 'c1',
      name: 'CH1',
      unit: 'V',
      color: '#fff',
      visible: true,
      t,
      v: v1,
      fs: 100,
      dt: 0.01,
      isMath: false,
      sourceChannelIds: [],
      metadata: {} as any,
      vMin: 0,
      vMax: 10,
    };
    const ch2: WaveformChannel = { ...ch1, id: 'c2', name: 'CH2', v: v2 };

    const channels = { c1: ch1, c2: ch2 };
    const order = ['c1', 'c2'];

    const outPlus = evaluateMathExpression('CH1 + CH2', channels, order);
    const outTimes = evaluateMathExpression('CH1 * CH2', channels, order);

    const passed = outPlus.v[0] === 8 && outTimes.v[0] === 15;
    tests.push({
      name: 'Math Expression Mutation Test',
      passed,
      details: `CH1+CH2 = ${outPlus.v[0]} (8), CH1*CH2 = ${outTimes.v[0]} (15)`,
    });
  }

  return tests;
}
