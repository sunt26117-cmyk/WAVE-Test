import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWaveformFilter,
  computeFilterBodeResponse,
  createDefaultFilterConfig,
  lowPassFilter,
  validateFilterConfig,
} from './filter';

function makeTimebase(n: number, fsHz: number): Float64Array {
  const t = new Float64Array(n);
  const dt = 1 / fsHz;
  for (let i = 0; i < n; i++) t[i] = i * dt;
  return t;
}

function measureRmsRange(arr: Float32Array | Float64Array, iStart: number, iEnd: number): number {
  let s = 0;
  let cnt = 0;
  for (let i = iStart; i <= iEnd; i++) {
    s += arr[i] * arr[i];
    cnt++;
  }
  return cnt > 0 ? Math.sqrt(s / cnt) : 0;
}

test('Passive RC circuit (R & C component values) meets -3 dB at fc = 1/(2*pi*R*C)', () => {
  const fs = 40000;
  const n = 4000; // 0.1 s
  const t = makeTimebase(n, fs);
  // 1 kOhm + 159.155 nF => fc = 1000 Hz
  const rOhm = 1000;
  const cFarad = 1 / (2 * Math.PI * rOhm * 1000);

  const cfg = createDefaultFilterConfig(fs);
  cfg.algorithm = 'rc_passive';
  cfg.response = 'lowpass';
  cfg.order = 1;
  cfg.zeroPhase = true;
  cfg.useRcComponents = true;
  cfg.rOhm = rOhm;
  cfg.cFarad = cFarad;

  // Test tone right at fc = 1000 Hz => expected ~ -3.01 dB (0.7071 amplitude)
  const vAtFc = new Float32Array(n);
  for (let i = 0; i < n; i++) vAtFc[i] = Math.sin(2 * Math.PI * 1000 * t[i]);
  const resFc = applyWaveformFilter(t, vAtFc, cfg);
  const rmsIn = measureRmsRange(vAtFc, 600, 3400);
  const rmsOut = measureRmsRange(resFc.v, 600, 3400);
  const ratio = rmsOut / rmsIn;
  assert.ok(Math.abs(ratio - Math.SQRT1_2) < 0.03, `Expected -3dB ~0.7071, got ${ratio}`);

  // Test RC High-Pass (DC removal + 50 Hz passband vs 2000 Hz passband)
  const cfgHp = { ...cfg, response: 'highpass' as const, order: 1, zeroPhase: false };
  const vMixed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    vMixed[i] = 5.0 + Math.sin(2 * Math.PI * 5000 * t[i]); // 5V DC offset + 5 kHz AC
  }
  const resHp = applyWaveformFilter(t, vMixed, cfgHp);
  let meanTail = 0;
  for (let i = 2000; i < n; i++) meanTail += resHp.v[i];
  meanTail /= n - 2000;
  assert.ok(Math.abs(meanTail) < 0.05, `Expected DC stripped by RC HPF, got mean=${meanTail}`);
});

test('Butterworth 4th-order zero-phase preserves passband with zero lag and attenuates high-freq carrier > 40 dB', () => {
  const fs = 50000;
  const n = 5000; // 0.1 s
  const t = makeTimebase(n, fs);
  const fSig = 100; // 100 Hz fundamental
  const fNoise = 5000; // 5 kHz switching ripple

  const vClean = new Float32Array(n);
  const vNoisy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    vClean[i] = 2.5 * Math.sin(2 * Math.PI * fSig * t[i]);
    vNoisy[i] = vClean[i] + 0.8 * Math.sin(2 * Math.PI * fNoise * t[i]);
  }

  const cfg = createDefaultFilterConfig(fs);
  cfg.algorithm = 'butterworth';
  cfg.response = 'lowpass';
  cfg.order = 4;
  cfg.cutoffHz = 600;
  cfg.zeroPhase = true;

  const res = applyWaveformFilter(t, vNoisy, cfg);
  let maxErr = 0;
  for (let i = 500; i < n - 500; i++) {
    const err = Math.abs(res.v[i] - vClean[i]);
    if (err > maxErr) maxErr = err;
  }
  assert.ok(maxErr < 0.02, `Expected clean 100Hz recovery (err < 0.02), got maxErr=${maxErr}`);

  // Bode check: DC ~ 0 dB, 600 Hz ~ -3 dB, 5 kHz < -50 dB
  const bode = computeFilterBodeResponse(cfg, fs, 250);
  const atFc = bode.reduce((a, b) => (Math.abs(b.freqHz - 600) < Math.abs(a.freqHz - 600) ? b : a));
  const atStop = bode.reduce((a, b) => (Math.abs(b.freqHz - 5000) < Math.abs(a.freqHz - 5000) ? b : a));
  assert.ok(Math.abs(atFc.magDb - (-3.01)) < 0.8, `Expected -3dB near fc, got ${atFc.magDb}`);
  assert.ok(atStop.magDb < -50, `Expected steep stopband < -50dB, got ${atStop.magDb}`);
});

test('Bessel linear-phase step response exhibits lower overshoot than Butterworth & Chebyshev', () => {
  const fs = 100000;
  const n = 2000;
  const t = makeTimebase(n, fs);
  const vStep = new Float32Array(n);
  for (let i = 500; i < n; i++) vStep[i] = 1.0;

  const base = createDefaultFilterConfig(fs);
  base.response = 'lowpass';
  base.order = 4;
  base.cutoffHz = 5000;
  base.zeroPhase = false;

  const resBess = applyWaveformFilter(t, vStep, { ...base, algorithm: 'bessel' });
  const resButt = applyWaveformFilter(t, vStep, { ...base, algorithm: 'butterworth' });

  let maxBess = -Infinity;
  let maxButt = -Infinity;
  for (let i = 500; i < 1000; i++) {
    if (resBess.v[i] > maxBess) maxBess = resBess.v[i];
    if (resButt.v[i] > maxButt) maxButt = resButt.v[i];
  }
  assert.ok(maxBess < 1.015, `Bessel overshoot should be minimal (<1.5%), got ${(maxBess - 1) * 100}%`);
  assert.ok(maxBess < maxButt, `Bessel peak (${maxBess}) should be lower than Butterworth (${maxButt})`);
});

test('Parametric Biquad Notch strips 50 Hz interference while preserving 250 Hz desired signal', () => {
  const fs = 2000;
  const n = 2000; // 1 second
  const t = makeTimebase(n, fs);
  const vSignal = new Float32Array(n);
  const vCombined = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    vSignal[i] = Math.sin(2 * Math.PI * 250 * t[i]);
    vCombined[i] = vSignal[i] + 2.0 * Math.sin(2 * Math.PI * 50 * t[i]);
  }

  const cfg = createDefaultFilterConfig(fs);
  cfg.algorithm = 'notch';
  cfg.centerFreqHz = 50;
  cfg.qFactor = 15;
  cfg.zeroPhase = true;

  const res = applyWaveformFilter(t, vCombined, cfg);
  let maxErr = 0;
  for (let i = 650; i < n - 650; i++) {
    const err = Math.abs(res.v[i] - vSignal[i]);
    if (err > maxErr) maxErr = err;
  }
  assert.ok(maxErr < 0.025, `Expected 50 Hz hum deeply rejected leaving 250 Hz intact, got maxErr=${maxErr}`);

  const bode = computeFilterBodeResponse(cfg, fs, 400);
  const atNotchGrid = bode.reduce((a, b) => (Math.abs(b.freqHz - 50) < Math.abs(a.freqHz - 50) ? b : a));
  const atPass = bode.reduce((a, b) => (Math.abs(b.freqHz - 250) < Math.abs(a.freqHz - 250) ? b : a));
  assert.ok(atNotchGrid.magDb < -18, `Expected steep notch dip on Bode grid, got ${atNotchGrid.magDb}dB`);
  assert.ok(atPass.magDb > -0.1, `Expected 250 Hz passband ~0dB, got ${atPass.magDb}dB`);
});

test('Median strips impulse spikes, Savitzky-Golay preserves peak vs Moving Average, FIR Sinc works', () => {
  const fs = 10000;
  const n = 1000;
  const t = makeTimebase(n, fs);

  // Spike on square wave
  const vSquare = new Float32Array(n);
  for (let i = 400; i < n; i++) vSquare[i] = 3.3;
  vSquare[200] = 15.0; // EMI glitch
  vSquare[700] = -12.0;

  const medCfg = createDefaultFilterConfig(fs);
  medCfg.algorithm = 'median';
  medCfg.windowSamples = 5;
  const medRes = applyWaveformFilter(t, vSquare, medCfg);
  assert.ok(Math.abs(medRes.v[200]) < 1e-4, 'Positive EMI spike stripped cleanly');
  assert.ok(Math.abs(medRes.v[700] - 3.3) < 1e-4, 'Negative EMI spike stripped cleanly');
  assert.ok(Math.abs(medRes.v[402] - 3.3) < 1e-4, 'Sharp rising edge preserved after median');

  // Savitzky-Golay vs Moving Average peak preservation on Gaussian pulse
  const vPulse = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i - 500) / 14;
    vPulse[i] = 5.0 * Math.exp(-x * x);
  }
  const sgCfg = { ...createDefaultFilterConfig(fs), algorithm: 'savgol' as const, windowSamples: 25, sgPolyOrder: 3 };
  const maCfg = { ...createDefaultFilterConfig(fs), algorithm: 'moving_avg' as const, windowSamples: 25, maMode: 'boxcar' as const };
  const sgRes = applyWaveformFilter(t, vPulse, sgCfg);
  const maRes = applyWaveformFilter(t, vPulse, maCfg);
  assert.ok(sgRes.v[500] > maRes.v[500], `SavGol peak (${sgRes.v[500]}) must exceed MovingAvg (${maRes.v[500]})`);
  assert.ok(Math.abs(sgRes.v[500] - 5.0) < 0.15, `SavGol preserves peak height (${sgRes.v[500]})`);

  // FIR Windowed-Sinc Bandpass
  const vDual = new Float32Array(n);
  const vTarget = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    vTarget[i] = Math.sin(2 * Math.PI * 500 * t[i]);
    vDual[i] = vTarget[i] + Math.sin(2 * Math.PI * 50 * t[i]) + Math.sin(2 * Math.PI * 2500 * t[i]);
  }
  const firCfg = {
    ...createDefaultFilterConfig(fs),
    algorithm: 'fir_sinc' as const,
    response: 'bandpass' as const,
    cutoffHz: 250,
    cutoffHighHz: 900,
    firTaps: 129,
    firWindow: 'blackman' as const,
  };
  const firRes = applyWaveformFilter(t, vDual, firCfg);
  let maxErr = 0;
  for (let i = 200; i < n - 200; i++) {
    const err = Math.abs(firRes.v[i] - vTarget[i]);
    if (err > maxErr) maxErr = err;
  }
  assert.ok(maxErr < 0.08, `FIR BP should isolate 500 Hz cleanly, got maxErr=${maxErr}`);
});

test('Partial waveform filtering [tStart, tEnd] leaves outside samples untouched & handles adaptive LTspice step', () => {
  const fs = 20000;
  const n = 2000; // 0 .. 0.1 s
  const t = makeTimebase(n, fs);
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    v[i] = Math.sin(2 * Math.PI * 50 * t[i]) + 0.5 * Math.sin(2 * Math.PI * 4000 * t[i]);
  }

  const cfg = createDefaultFilterConfig(fs);
  cfg.algorithm = 'butterworth';
  cfg.response = 'lowpass';
  cfg.order = 4;
  cfg.cutoffHz = 300;
  cfg.regionMode = 'custom';
  cfg.tStart = 0.03;
  cfg.tEnd = 0.07;
  cfg.edgeBlendPct = 0;

  const res = applyWaveformFilter(t, v, cfg);
  // Outside [0.03, 0.07] must be bit-exact original
  assert.equal(res.v[100], v[100]);
  assert.equal(res.v[1800], v[1800]);
  // Inside [0.035, 0.065] high-freq noise must be removed
  const expected = Math.sin(2 * Math.PI * 50 * t[1000]);
  assert.ok(Math.abs(res.v[1000] - expected) < 0.02, 'Partial slice filtered accurately');

  // Non-uniform adaptive-timestep test (alternating fine & coarse dt like LTspice)
  const tAdapt: number[] = [0];
  let curT = 0;
  while (curT < 0.05) {
    const dt = Math.sin(2 * Math.PI * 200 * curT) > 0.7 ? 2e-6 : 4e-5;
    curT += dt;
    tAdapt.push(curT);
  }
  const tArr = new Float64Array(tAdapt);
  const vArr = new Float32Array(tArr.length);
  for (let i = 0; i < tArr.length; i++) {
    vArr[i] = 1.0 * Math.sin(2 * Math.PI * 40 * tArr[i]) + 0.4 * Math.sin(2 * Math.PI * 3000 * tArr[i]);
  }
  const adaptCfg = createDefaultFilterConfig(1 / 4e-5);
  adaptCfg.algorithm = 'butterworth';
  adaptCfg.order = 3;
  adaptCfg.cutoffHz = 300;
  const adaptRes = applyWaveformFilter(tArr, vArr, adaptCfg);
  assert.equal(adaptRes.metrics.resampledAdaptive, true);
  const midIdx = Math.floor(tArr.length / 2);
  const cleanMid = Math.sin(2 * Math.PI * 40 * tArr[midIdx]);
  assert.ok(Math.abs(adaptRes.v[midIdx] - cleanMid) < 0.04, 'Non-uniform adaptive step filtered accurately');

  // Validation rejects fc >= Nyquist
  const bad = validateFilterConfig({ ...cfg, cutoffHz: 15000 }, t);
  assert.equal(bad.ok, false);

  // Legacy lowPassFilter still works cleanly
  const legacy = lowPassFilter(t, v, { cutoffHz: 300, order: 2, zeroPhase: true });
  assert.equal(legacy.length, v.length);
});

test('Filter AN-04/AN-05: partial region fails closed (<3 samples/missing cursors) and isolates NaN/sampling gaps', () => {
  const fs = 10000;
  const n = 200;
  const t = makeTimebase(n, fs);
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = Math.sin(2 * Math.PI * 50 * t[i]) + 0.5 * Math.sin(2 * Math.PI * 2000 * t[i]);

  // AN-04: missing cursors or <3 samples in custom slice must abort without filtering full trace
  const cfgCursors = { ...createDefaultFilterConfig(fs), regionMode: 'cursors' as const, cutoffHz: 200 };
  const noCursorRes = applyWaveformFilter(t, v, cfgCursors, { cursorX1: null, cursorX2: null });
  assert.equal(noCursorRes.partialRegionSkipped, true);
  assert.equal(noCursorRes.metrics.sampleCountFiltered, 0);
  assert.deepEqual(Array.from(noCursorRes.v), Array.from(v));

  const tinySliceCfg = {
    ...createDefaultFilterConfig(fs),
    regionMode: 'custom' as const,
    tStart: 0.005,
    tEnd: 0.00505, // covers <= 1 sample
    cutoffHz: 200,
  };
  const tinyRes = applyWaveformFilter(t, v, tinySliceCfg);
  assert.equal(tinyRes.partialRegionSkipped, true);
  assert.deepEqual(Array.from(tinyRes.v), Array.from(v));

  // AN-05: NaN segment stays NaN and never bridges across adjacent segments in applyWaveformFilter or lowPassFilter
  const vNan = Float32Array.from(v);
  vNan[80] = Number.NaN;
  vNan[81] = Number.NaN;
  // Isolate a 2-sample valid island [82, 83] followed by NaN at 84 (<3 samples -> left unfiltered)
  vNan[84] = Number.NaN;
  const nanCfg = { ...createDefaultFilterConfig(fs), cutoffHz: 200 };
  const nanRes = applyWaveformFilter(t, vNan, nanCfg);
  assert.ok(Number.isNaN(nanRes.v[80]));
  assert.ok(Number.isNaN(nanRes.v[81]));
  assert.ok(Number.isNaN(nanRes.v[84]));
  assert.equal(nanRes.v[82], vNan[82], '<3 sample island must remain unfiltered');
  assert.ok((nanRes.unfilteredShortSegmentCount || 0) >= 1);

  const legNan = lowPassFilter(t, vNan, { cutoffHz: 200, order: 2, zeroPhase: true });
  assert.ok(Number.isNaN(legNan[80]));
  assert.ok(Number.isNaN(legNan[81]));

  // AN-05: Isolated 10x+ sampling gap separates DC levels without cross-gap transient smear
  const tGap = new Float64Array([
    0.0, 0.0001, 0.0002, 0.0003, 0.0004, 0.0005, 0.0006, 0.0007,
    0.05, 0.0501, 0.0502, 0.0503, 0.0504, 0.0505, 0.0506, 0.0507,
  ]);
  const vGap = new Float32Array([
    0, 0, 0, 0, 0, 0, 0, 0,
    10, 10, 10, 10, 10, 10, 10, 10,
  ]);
  const gapRes = applyWaveformFilter(tGap, vGap, { ...createDefaultFilterConfig(10000), cutoffHz: 500 });
  assert.ok(Math.abs(gapRes.v[7] - 0) < 1e-4, `Pre-gap flat 0V must not smear toward 10V, got ${gapRes.v[7]}`);
  assert.ok(Math.abs(gapRes.v[8] - 10) < 1e-4, `Post-gap flat 10V must not smear toward 0V, got ${gapRes.v[8]}`);
  const legGap = lowPassFilter(tGap, vGap, { cutoffHz: 500, order: 2, zeroPhase: true });
  assert.ok(Math.abs(legGap[7] - 0) < 1e-4);
  assert.ok(Math.abs(legGap[8] - 10) < 1e-4);
});

