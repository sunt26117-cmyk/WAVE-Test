/**
 * Waveform Viewer Pro - Circuit & DSP Filtering Engine
 *
 * Implements:
 * - Analog / Circuit Filters:
 *   1. Passive RC Cascade (Low-Pass / High-Pass) via exact variable-dt exponential integration,
 *      with either direct Cutoff fc (Hz) or physical R (Ω) + C (F) parameters.
 *   2. Butterworth IIR (Orders 1..8, LP / HP / BP / BS) via ZPK-to-SOS Bilinear Transform.
 *   3. Bessel Linear-Phase IIR (Orders 1..6, LP / HP) with exact -3 dB cutoff normalization.
 *   4. Chebyshev Type I IIR (Orders 2..8, LP / HP / BP / BS) with configurable passband ripple (dB).
 *   5. Parametric Biquad Notch (Band-Stop) with Center Frequency f0 & Quality Factor Q.
 * - Digital / Time-Domain Filters:
 *   6. Windowed-Sinc Linear-Phase FIR (Hann / Hamming / Blackman, LP / HP / BP / BS).
 *   7. Savitzky-Golay Polynomial Smoothing (Window 5..101, Poly Order 2..4).
 *   8. Moving Average (Symmetric Boxcar) & Exponential EMA.
 *   9. Median Spike/Glitch Removal Filter (Odd Window 3..51).
 *
 * Features:
 * - Whole waveform, Current Viewport, Cursor [X1, X2], or Custom [tStart, tEnd] partial filtering.
 * - Pre/post context padding + reflected edge extension + optional cosine crossfade at partial boundaries.
 * - Safe automatic uniform resampling for LTspice / SPICE adaptive-step waveforms.
 * - Real-time Bode |H(f)| magnitude response & RMS/Vpp attenuation diagnostics.
 */

import { ChannelFilterSpec } from '../types/models';
import { resampleUniform } from './resampler';

export const FILTER_ORDERS: Array<1 | 2 | 4> = [1, 2, 4];

export type FilterAlgorithm =
  | 'rc_passive'
  | 'butterworth'
  | 'bessel'
  | 'chebyshev1'
  | 'notch'
  | 'fir_sinc'
  | 'savgol'
  | 'moving_avg'
  | 'median';

export type FilterResponseType = 'lowpass' | 'highpass' | 'bandpass' | 'bandstop';
export type FilterRegionMode = 'entire' | 'view' | 'cursors' | 'custom';
export type FilterOutputMode = 'new_channel' | 'in_place';
export type FirWindowType = 'hann' | 'hamming' | 'blackman';

export interface FilterConfig {
  algorithm: FilterAlgorithm;
  response: FilterResponseType;
  regionMode: FilterRegionMode;
  outputMode: FilterOutputMode;

  // Custom / resolved time bounds (seconds)
  tStart?: number;
  tEnd?: number;
  edgeBlendPct: number; // 0..20% crossfade at partial boundaries

  // Frequency & analog parameters
  cutoffHz: number;
  cutoffHighHz: number; // upper cutoff for BP/BS
  centerFreqHz: number; // for notch
  qFactor: number;      // for notch
  order: number;        // 1..8 depending on algorithm
  rippleDb: number;     // Chebyshev I passband ripple in dB
  zeroPhase: boolean;   // Bidirectional filtfilt (doubles effective order & eliminates phase lag)

  // Physical RC circuit parameters
  useRcComponents: boolean;
  rOhm: number;
  cFarad: number;

  // FIR & time-domain parameters
  firTaps: number;      // odd 15..255
  firWindow: FirWindowType;
  windowSamples: number; // Moving avg / Median / SavGol odd window size
  maMode: 'boxcar' | 'ema';
  emaAlpha: number;
  sgPolyOrder: number;  // 2..4
}

export interface BiquadSection {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export interface FilterMetrics {
  sampleCountTotal: number;
  sampleCountFiltered: number;
  effectiveFsHz: number;
  nyquistHz: number;
  resampledAdaptive: boolean;
  tStartApplied: number;
  tEndApplied: number;
  rmsBefore: number;
  rmsAfter: number;
  rmsRemovedDiff: number;
  vppBefore: number;
  vppAfter: number;
  effectiveCutoffHz: number;
  badgeText: string;
  summaryText: string;
}

export interface FilterExecutionResult {
  v: Float32Array;
  t: Float64Array;
  metrics: FilterMetrics;
  warning?: string;
}

export interface BodePoint {
  freqHz: number;
  magDb: number;
  phaseDeg: number;
}

interface Complex {
  re: number;
  im: number;
}

const cAdd = (a: Complex, b: Complex): Complex => ({ re: a.re + b.re, im: a.im + b.im });
const cSub = (a: Complex, b: Complex): Complex => ({ re: a.re - b.re, im: a.im - b.im });
const cMul = (a: Complex, b: Complex): Complex => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
});
const cDiv = (a: Complex, b: Complex): Complex => {
  const d = b.re * b.re + b.im * b.im || 1e-30;
  return {
    re: (a.re * b.re + a.im * b.im) / d,
    im: (a.im * b.re - a.re * b.im) / d,
  };
};
const cAbs = (a: Complex): number => Math.hypot(a.re, a.im);
const cSqrt = (a: Complex): Complex => {
  const r = cAbs(a);
  if (r === 0) return { re: 0, im: 0 };
  const theta = Math.atan2(a.im, a.re) / 2;
  const sr = Math.sqrt(r);
  return { re: sr * Math.cos(theta), im: sr * Math.sin(theta) };
};

export function createDefaultFilterConfig(fsHz: number = 100000): FilterConfig {
  const safeFs = Number.isFinite(fsHz) && fsHz > 0 ? fsHz : 100000;
  const nyq = safeFs / 2;
  const defaultFc = Math.max(1, nyq * 0.08);
  const rOhm = 1000;
  const cFarad = 1 / (2 * Math.PI * rOhm * defaultFc);

  return {
    algorithm: 'butterworth',
    response: 'lowpass',
    regionMode: 'entire',
    outputMode: 'new_channel',
    edgeBlendPct: 5,
    cutoffHz: Number(defaultFc.toPrecision(4)),
    cutoffHighHz: Number(Math.min(nyq * 0.65, defaultFc * 4).toPrecision(4)),
    centerFreqHz: Math.min(nyq * 0.5, 50),
    qFactor: 10,
    order: 2,
    rippleDb: 0.5,
    zeroPhase: true,
    useRcComponents: false,
    rOhm,
    cFarad,
    firTaps: 63,
    firWindow: 'hann',
    windowSamples: 11,
    maMode: 'boxcar',
    emaAlpha: 0.15,
    sgPolyOrder: 2,
  };
}

export function medianDt(t: Float64Array): number {
  const n = t.length;
  if (n < 2) return 0;
  const step = Math.max(1, Math.floor((n - 1) / 2000));
  const dts: number[] = [];
  for (let i = step; i < n; i += step) {
    const d = t[i] - t[i - step];
    if (d > 0 && Number.isFinite(d)) dts.push(d / step);
  }
  if (!dts.length) return 0;
  dts.sort((a, b) => a - b);
  return dts[dts.length >> 1];
}

export function nyquistOf(t: Float64Array): number {
  const dt = medianDt(t);
  return dt > 0 ? 1 / (2 * dt) : 0;
}

export function isNonUniformTimestep(t: Float64Array): boolean {
  const n = t.length;
  if (n < 5) return false;
  const med = medianDt(t);
  if (med <= 0) return false;
  const step = Math.max(1, Math.floor((n - 1) / 500));
  let deviant = 0;
  let checked = 0;
  for (let i = 1; i < n; i += step) {
    const dt = t[i] - t[i - 1];
    if (dt > 0 && Number.isFinite(dt)) {
      checked++;
      if (Math.abs(dt - med) / med > 0.08) deviant++;
    }
  }
  return checked > 0 && deviant / checked > 0.05;
}

export function validateFilterSpec(
  spec: ChannelFilterSpec,
  t: Float64Array
): { ok: boolean; message?: string; warning?: string } {
  if (!Number.isFinite(spec.cutoffHz) || spec.cutoffHz <= 0) {
    return { ok: false, message: 'Cutoff frequency must be greater than 0.' };
  }
  if (t.length < 3) return { ok: false, message: 'Not enough samples to filter.' };
  const nyq = nyquistOf(t);
  if (nyq > 0 && spec.cutoffHz >= nyq) {
    return {
      ok: false,
      message: `Cutoff must be below the Nyquist frequency (${nyq.toPrecision(4)} Hz).`,
    };
  }
  if (nyq > 0 && spec.cutoffHz > nyq * 0.4) {
    return { ok: true, warning: 'Cutoff is close to Nyquist; the real -3 dB point will deviate.' };
  }
  return { ok: true };
}

function sectionCutoff(spec: ChannelFilterSpec): number {
  const effective = spec.zeroPhase ? spec.order * 2 : spec.order;
  return spec.cutoffHz / Math.sqrt(Math.pow(2, 1 / effective) - 1);
}

/**
 * Legacy helper preserved for backward compatibility with existing callers/tests.
 */
export function lowPassFilter(
  t: Float64Array,
  v: Float32Array,
  spec: ChannelFilterSpec
): Float32Array {
  const n = v.length;
  const out = new Float32Array(n);
  if (n === 0) return out;

  const tau = 1 / (2 * Math.PI * sectionCutoff(spec));
  const work = new Float64Array(n);
  const nanMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = v[i];
    if (Number.isFinite(x)) work[i] = x;
    else nanMask[i] = 1;
  }

  let last = 0;
  let seen = false;
  for (let i = 0; i < n; i++) {
    if (nanMask[i]) work[i] = seen ? last : 0;
    else {
      last = work[i];
      seen = true;
    }
  }
  if (!seen) return new Float32Array(v);
  for (let i = 0; i < n && nanMask[i]; i++) work[i] = last;

  const forward = (): void => {
    for (let s = 0; s < spec.order; s++) {
      let y = work[0];
      for (let i = 1; i < n; i++) {
        const dt = t[i] - t[i - 1];
        const a = dt > 0 ? 1 - Math.exp(-dt / tau) : 0;
        y += a * (work[i] - y);
        work[i] = y;
      }
    }
  };
  const backward = (): void => {
    for (let s = 0; s < spec.order; s++) {
      let y = work[n - 1];
      for (let i = n - 2; i >= 0; i--) {
        const dt = t[i + 1] - t[i];
        const a = dt > 0 ? 1 - Math.exp(-dt / tau) : 0;
        y += a * (work[i] - y);
        work[i] = y;
      }
    }
  };

  forward();
  if (spec.zeroPhase) backward();

  for (let i = 0; i < n; i++) out[i] = nanMask[i] ? NaN : work[i];
  return out;
}

export function describeFilter(spec: ChannelFilterSpec): string {
  const f = spec.cutoffHz;
  const txt =
    f >= 1e6 ? `${+(f / 1e6).toPrecision(4)} MHz` : f >= 1e3 ? `${+(f / 1e3).toPrecision(4)} kHz` : `${+f.toPrecision(4)} Hz`;
  return `LPF ${txt} (-3 dB, ${spec.order}-pole${spec.zeroPhase ? ', zero-phase' : ''})`;
}

// =============================================================================
// Analog Prototype Poles & ZPK -> SOS Biquad Synthesis
// =============================================================================

const BESSEL_UNSCALED_POLES: Record<number, Complex[]> = {
  1: [{ re: -1.0, im: 0 }],
  2: [
    { re: -1.5, im: 0.8660254037844386 },
    { re: -1.5, im: -0.8660254037844386 },
  ],
  3: [
    { re: -2.322185354626085, im: 0 },
    { re: -1.838907322686958, im: 1.754380959783725 },
    { re: -1.838907322686958, im: -1.754380959783725 },
  ],
  4: [
    { re: -2.89621060282032, im: 0.867234128934504 },
    { re: -2.89621060282032, im: -0.867234128934504 },
    { re: -2.10378939717968, im: 2.65741804185675 },
    { re: -2.10378939717968, im: -2.65741804185675 },
  ],
  5: [
    { re: -3.6467385953296, im: 0 },
    { re: -3.3519563991537, im: 1.7426614161829 },
    { re: -3.3519563991537, im: -1.7426614161829 },
    { re: -2.3246743031823, im: 3.5710229202379 },
    { re: -2.3246743031823, im: -3.5710229202379 },
  ],
  6: [
    { re: -4.248359396566, im: 0.867509673230 },
    { re: -4.248359396566, im: -0.867509673230 },
    { re: -3.735708356343, im: 2.626272311440 },
    { re: -3.735708356343, im: -2.626272311440 },
    { re: -2.515932247091, im: 4.492672953654 },
    { re: -2.515932247091, im: -4.492672953654 },
  ],
};

function getBesselNormalizedPoles(order: number): Complex[] {
  const clamped = Math.max(1, Math.min(6, Math.round(order)));
  const raw = BESSEL_UNSCALED_POLES[clamped];

  // Evaluate unnormalized |H(j*w)| = prod(|p_i|) / prod(|j*w - p_i|) and solve for -3 dB omega
  const evalMag = (w: number): number => {
    let num = 1;
    let den = 1;
    for (const p of raw) {
      num *= Math.hypot(p.re, p.im);
      den *= Math.hypot(-p.re, w - p.im);
    }
    return num / (den || 1e-30);
  };

  let lo = 0.5;
  let hi = 5.0;
  const target = Math.SQRT1_2;
  for (let iter = 0; iter < 40; iter++) {
    const mid = 0.5 * (lo + hi);
    if (evalMag(mid) > target) lo = mid;
    else hi = mid;
  }
  const w3db = 0.5 * (lo + hi);
  return raw.map((p) => ({ re: p.re / w3db, im: p.im / w3db }));
}

function getButterworthPoles(order: number): Complex[] {
  const n = Math.max(1, Math.min(8, Math.round(order)));
  const poles: Complex[] = [];
  for (let k = 0; k < n; k++) {
    const theta = Math.PI * (0.5 + (2 * k + 1) / (2 * n));
    const re = Math.abs(Math.cos(theta)) < 1e-15 ? 0 : Math.cos(theta);
    const im = Math.abs(Math.sin(theta)) < 1e-15 ? 0 : Math.sin(theta);
    poles.push({ re, im });
  }
  return poles;
}

function getChebyshev1Poles(order: number, rippleDb: number): Complex[] {
  const n = Math.max(2, Math.min(8, Math.round(order)));
  const rp = Math.max(0.05, Math.min(6.0, rippleDb));
  const eps = Math.sqrt(Math.pow(10, rp / 10) - 1);
  const mu = Math.asinh(1 / eps) / n;
  const poles: Complex[] = [];
  for (let k = 0; k < n; k++) {
    const phi = Math.PI * (0.5 + (2 * k + 1) / (2 * n));
    const re = Math.sinh(mu) * Math.cos(phi);
    const im = Math.cosh(mu) * Math.sin(phi);
    poles.push({
      re: Math.abs(re) < 1e-15 ? 0 : re,
      im: Math.abs(im) < 1e-15 ? 0 : im,
    });
  }
  return poles;
}

/**
 * Normalizes a prototype cutoff frequency when zero-phase (filtfilt) doubles effective magnitude^2,
 * ensuring the cascaded -3 dB point matches user-requested cutoffHz.
 */
function adjustZeroPhaseButterworthPrototype(fcHz: number, fsHz: number, order: number, isHighPass: boolean): number {
  const halfNyq = fsHz * 0.495;
  // For Butterworth |H(f)|^2 = 1 / (1 + (f/fc)^(2N)); filtfilt squares |H| -> 1 / (1 + (f/fc)^(2N))^2 = 0.5
  // -> (f_3db / fc)^(2N) = sqrt(2) - 1
  const scale = Math.pow(Math.SQRT2 - 1, 1 / (2 * order));
  const adjusted = isHighPass ? fcHz * scale : fcHz / scale;
  return Math.max(1e-6, Math.min(halfNyq, adjusted));
}

function pairPrototypePoles(poles: Complex[]): Array<{ p1: Complex; p2: Complex | null }> {
  const used = new Array<boolean>(poles.length).fill(false);
  const pairs: Array<{ p1: Complex; p2: Complex | null }> = [];
  for (let i = 0; i < poles.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const p = poles[i];
    if (Math.abs(p.im) < 1e-10) {
      pairs.push({ p1: { re: p.re, im: 0 }, p2: null });
    } else {
      let matchIdx = -1;
      let bestDist = Infinity;
      for (let j = i + 1; j < poles.length; j++) {
        if (used[j]) continue;
        const dist = Math.hypot(poles[j].re - p.re, poles[j].im + p.im);
        if (dist < bestDist) {
          bestDist = dist;
          matchIdx = j;
        }
      }
      if (matchIdx !== -1) {
        used[matchIdx] = true;
        pairs.push({ p1: p, p2: poles[matchIdx] });
      } else {
        pairs.push({ p1: p, p2: { re: p.re, im: -p.im } });
      }
    }
  }
  return pairs;
}

function evalBiquadFreqResponse(sec: BiquadSection, omegaRad: number): Complex {
  const zInv1: Complex = { re: Math.cos(-omegaRad), im: Math.sin(-omegaRad) };
  const zInv2: Complex = { re: Math.cos(-2 * omegaRad), im: Math.sin(-2 * omegaRad) };
  const num = cAdd(
    { re: sec.b0, im: 0 },
    cAdd(cMul({ re: sec.b1, im: 0 }, zInv1), cMul({ re: sec.b2, im: 0 }, zInv2))
  );
  const den = cAdd(
    { re: 1, im: 0 },
    cAdd(cMul({ re: sec.a1, im: 0 }, zInv1), cMul({ re: sec.a2, im: 0 }, zInv2))
  );
  return cDiv(num, den);
}

export function evalSosCascadeResponse(sections: BiquadSection[], freqHz: number, fsHz: number): Complex {
  const omega = (2 * Math.PI * freqHz) / fsHz;
  let total: Complex = { re: 1, im: 0 };
  for (const sec of sections) {
    total = cMul(total, evalBiquadFreqResponse(sec, omega));
  }
  return total;
}

/**
 * Designs exact SOS Biquads for Butterworth / Bessel / Chebyshev Type I across LP/HP/BP/BS,
 * or Parametric Notch.
 */
export function designIirSosSections(cfg: FilterConfig, fsHz: number): BiquadSection[] {
  const nyq = fsHz / 2;
  const clampFreq = (f: number) => Math.max(1e-6 * fsHz, Math.min(nyq * 0.985, f));

  if (cfg.algorithm === 'notch') {
    const f0 = clampFreq(cfg.centerFreqHz);
    const q = Math.max(0.25, Math.min(200, cfg.qFactor));
    const w0 = (2 * Math.PI * f0) / fsHz;
    const alpha = Math.sin(w0) / (2 * q);
    const cosW0 = Math.cos(w0);
    const a0 = 1 + alpha;
    return [
      {
        b0: 1 / a0,
        b1: (-2 * cosW0) / a0,
        b2: 1 / a0,
        a1: (-2 * cosW0) / a0,
        a2: (1 - alpha) / a0,
      },
    ];
  }

  let order = Math.max(1, Math.min(8, Math.round(cfg.order)));
  if (cfg.algorithm === 'bessel') order = Math.min(6, order);
  if (cfg.algorithm === 'chebyshev1') order = Math.max(2, order);

  const protoPoles =
    cfg.algorithm === 'bessel'
      ? getBesselNormalizedPoles(order)
      : cfg.algorithm === 'chebyshev1'
      ? getChebyshev1Poles(order, cfg.rippleDb)
      : getButterworthPoles(order);

  const resp = cfg.response;
  const k = 2 * fsHz;

  const isPassBand = resp === 'bandpass' || resp === 'bandstop';
  let fc1 = clampFreq(cfg.cutoffHz);
  let fc2 = clampFreq(cfg.cutoffHighHz);
  if (isPassBand && fc2 <= fc1) {
    fc2 = clampFreq(Math.min(nyq * 0.97, fc1 * 2.0));
    if (fc2 <= fc1) fc1 = clampFreq(fc2 * 0.5);
  }

  // Zero-phase -3 dB cutoff adjustment for Butterworth LP/HP
  if (cfg.zeroPhase && cfg.algorithm === 'butterworth' && !isPassBand) {
    fc1 = adjustZeroPhaseButterworthPrototype(fc1, fsHz, order, resp === 'highpass');
  }

  const sections: BiquadSection[] = [];

  if (resp === 'lowpass' || resp === 'highpass') {
    const W = Math.tan((Math.PI * fc1) / fsHz);
    const pairs = pairPrototypePoles(protoPoles);

    for (const { p1, p2 } of pairs) {
      if (!p2) {
        // 1st-order s-plane: H(s_n) = |p1| / (s_n - p1)
        const a0 = -p1.re; // positive real
        if (resp === 'lowpass') {
          const den0 = 1 + a0 * W;
          sections.push({
            b0: (a0 * W) / den0,
            b1: (a0 * W) / den0,
            b2: 0,
            a1: (a0 * W - 1) / den0,
            a2: 0,
          });
        } else {
          const den0 = a0 + W;
          sections.push({
            b0: a0 / den0,
            b1: -a0 / den0,
            b2: 0,
            a1: (W - a0) / den0,
            a2: 0,
          });
        }
      } else {
        // 2nd-order s-plane: (s_n - p1)(s_n - p2) = s_n^2 + a1s * s_n + a0s
        const a1s = -(p1.re + p2.re);
        const a0s = p1.re * p2.re - p1.im * p2.im;
        if (resp === 'lowpass') {
          const den0 = 1 + a1s * W + a0s * W * W;
          const gain = (a0s * W * W) / den0;
          sections.push({
            b0: gain,
            b1: 2 * gain,
            b2: gain,
            a1: (2 * a0s * W * W - 2) / den0,
            a2: (1 - a1s * W + a0s * W * W) / den0,
          });
        } else {
          const den0 = a0s + a1s * W + W * W;
          const gain = a0s / den0;
          sections.push({
            b0: gain,
            b1: -2 * gain,
            b2: gain,
            a1: (2 * W * W - 2 * a0s) / den0,
            a2: (a0s - a1s * W + W * W) / den0,
          });
        }
      }
    }

    // Even-order Chebyshev Type I has passband ripple dip at DC / Nyquist;
    // normalize gain of first section by 1 / sqrt(1 + eps^2) so peak passband = 0 dB.
    if (cfg.algorithm === 'chebyshev1' && order % 2 === 0 && sections.length > 0) {
      const eps = Math.sqrt(Math.pow(10, Math.max(0.05, cfg.rippleDb) / 10) - 1);
      const scale = 1 / Math.sqrt(1 + eps * eps);
      sections[0].b0 *= scale;
      sections[0].b1 *= scale;
      sections[0].b2 *= scale;
    }
    return sections;
  }

  // Band-Pass or Band-Stop via exact complex s-plane LP-to-BP / LP-to-BS pole transform
  const omega1 = k * Math.tan((Math.PI * fc1) / fsHz);
  const omega2 = k * Math.tan((Math.PI * fc2) / fsHz);
  const bw = Math.max(1e-6, omega2 - omega1);
  const omega0Sq = omega1 * omega2;
  const omega0 = Math.sqrt(omega0Sq);

  const sPoles: Complex[] = [];
  for (const p of protoPoles) {
    if (resp === 'bandpass') {
      // s^2 - bw*p*s + omega0^2 = 0
      const bp: Complex = { re: bw * p.re, im: bw * p.im };
      const disc = cSub(cMul(bp, bp), { re: 4 * omega0Sq, im: 0 });
      const sq = cSqrt(disc);
      sPoles.push(cDiv(cAdd(bp, sq), { re: 2, im: 0 }));
      sPoles.push(cDiv(cSub(bp, sq), { re: 2, im: 0 }));
    } else {
      // bandstop: s^2 - (bw/p)*s + omega0^2 = 0
      const bp = cDiv({ re: bw, im: 0 }, p);
      const disc = cSub(cMul(bp, bp), { re: 4 * omega0Sq, im: 0 });
      const sq = cSqrt(disc);
      sPoles.push(cDiv(cAdd(bp, sq), { re: 2, im: 0 }));
      sPoles.push(cDiv(cSub(bp, sq), { re: 2, im: 0 }));
    }
  }

  // Convert s-plane poles to z-plane poles: z = (k + s)/(k - s) and pair conjugates
  const zPoles = sPoles.map((sp) => cDiv(cAdd({ re: k, im: 0 }, sp), cSub({ re: k, im: 0 }, sp)));
  const zPairs = pairPrototypePoles(zPoles);

  if (resp === 'bandpass') {
    for (const { p1, p2 } of zPairs) {
      if (!p2) continue;
      // Denominator (1 - p1*z^-1)(1 - p2*z^-1) = 1 - (p1+p2)z^-1 + (p1*p2)z^-2
      const a1 = -(p1.re + p2.re);
      const a2 = p1.re * p2.re - p1.im * p2.im;
      // BPF section zeros at z = +1 and z = -1 -> numerator (1 - z^-2)
      sections.push({
        b0: 1,
        b1: 0,
        b2: -1,
        a1,
        a2,
      });
    }
    // Normalize cascade passband gain at geometric center frequency f_center
    const fCenter = Math.sqrt(fc1 * fc2);
    const respAtCenter = cAbs(evalSosCascadeResponse(sections, fCenter, fsHz));
    let targetGain = 1;
    if (cfg.algorithm === 'chebyshev1' && order % 2 === 0) {
      const eps = Math.sqrt(Math.pow(10, Math.max(0.05, cfg.rippleDb) / 10) - 1);
      targetGain = 1 / Math.sqrt(1 + eps * eps);
    }
    if (respAtCenter > 1e-18 && sections.length > 0) {
      const perSecGain = Math.pow(targetGain / respAtCenter, 1 / sections.length);
      for (const s of sections) {
        s.b0 *= perSecGain;
        s.b1 *= perSecGain;
        s.b2 *= perSecGain;
      }
    }
  } else {
    // Band-Stop: zeros on unit circle at w0 = 2 * atan(omega0 / k) -> 1 - 2*cos(w0)*z^-1 + z^-2
    const w0 = 2 * Math.atan(omega0 / k);
    const b1Zero = -2 * Math.cos(w0);
    for (const { p1, p2 } of zPairs) {
      if (!p2) continue;
      const a1 = -(p1.re + p2.re);
      const a2 = p1.re * p2.re - p1.im * p2.im;
      sections.push({
        b0: 1,
        b1: b1Zero,
        b2: 1,
        a1,
        a2,
      });
    }
    // Normalize DC gain at f = 0 (z = 1)
    const dcGain = cAbs(evalSosCascadeResponse(sections, 0, fsHz));
    let targetDc = 1;
    if (cfg.algorithm === 'chebyshev1' && order % 2 === 0) {
      const eps = Math.sqrt(Math.pow(10, Math.max(0.05, cfg.rippleDb) / 10) - 1);
      targetDc = 1 / Math.sqrt(1 + eps * eps);
    }
    if (dcGain > 1e-18 && sections.length > 0) {
      const perSecGain = Math.pow(targetDc / dcGain, 1 / sections.length);
      for (const s of sections) {
        s.b0 *= perSecGain;
        s.b1 *= perSecGain;
        s.b2 *= perSecGain;
      }
    }
  }

  return sections;
}

/**
 * Applies a single Direct-Form II Transposed biquad section forward in-place on `buf`.
 * Initializes filter state to steady-state DC response for `buf[0]` when DC-preserving,
 * dramatically reducing startup transients on step/offset signals.
 */
function runBiquadForward(buf: Float64Array, sec: BiquadSection): void {
  const n = buf.length;
  if (n === 0) return;
  const { b0, b1, b2, a1, a2 } = sec;

  // Steady-state initial conditions for constant input x0:
  // z1 = x0 * (b1 + b2 - (a1 + a2)*dcGain), z2 = x0 * (b2 - a2*dcGain)
  const denomDc = 1 + a1 + a2;
  const dcGain = Math.abs(denomDc) > 1e-9 ? (b0 + b1 + b2) / denomDc : 0;
  const x0 = buf[0];
  let z1 = x0 * (b1 + b2 - (a1 + a2) * dcGain);
  let z2 = x0 * (b2 - a2 * dcGain);

  if (!Number.isFinite(z1) || !Number.isFinite(z2)) {
    z1 = 0;
    z2 = 0;
  }

  for (let i = 0; i < n; i++) {
    const x = buf[i];
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    buf[i] = y;
  }
}

function applySosCascade(buf: Float64Array, sections: BiquadSection[], zeroPhase: boolean): void {
  const n = buf.length;
  if (n < 2 || sections.length === 0) return;

  // Odd reflection padding at both ends to prevent start/end boundary ringing
  const padLen = Math.min(Math.max(64, Math.floor(n * 0.12)), 512, n - 1);
  const workLen = n + 2 * padLen;
  const work = new Float64Array(workLen);

  for (let i = 0; i < padLen; i++) {
    work[i] = 2 * buf[0] - buf[padLen - i];
  }
  work.set(buf, padLen);
  for (let i = 0; i < padLen; i++) {
    work[padLen + n + i] = 2 * buf[n - 1] - buf[n - 2 - i];
  }

  for (const sec of sections) {
    runBiquadForward(work, sec);
  }

  if (zeroPhase) {
    work.reverse();
    for (const sec of sections) {
      runBiquadForward(work, sec);
    }
    work.reverse();
  }

  for (let i = 0; i < n; i++) {
    buf[i] = work[padLen + i];
  }
}

// =============================================================================
// Passive RC (Variable-Timestep Safe), FIR, Moving Avg, Median & Savitzky-Golay
// =============================================================================

function resolveRcCutoffHz(cfg: FilterConfig): number {
  if (cfg.useRcComponents && cfg.rOhm > 0 && cfg.cFarad > 0) {
    return 1 / (2 * Math.PI * cfg.rOhm * cfg.cFarad);
  }
  return cfg.cutoffHz;
}

function applyRcFilterVariableDt(
  t: Float64Array,
  buf: Float64Array,
  cfg: FilterConfig
): void {
  const n = buf.length;
  if (n < 2) return;
  const order = Math.max(1, Math.min(4, Math.round(cfg.order)));
  const fcRaw = Math.max(1e-6, resolveRcCutoffHz(cfg));
  const effN = cfg.zeroPhase ? order * 2 : order;

  // For RC LP: -3dB scaling fs = fc / sqrt(2^(1/effN) - 1)
  // For RC HP: |H(fc)|^2 = ((fc/fs)^2 / (1 + (fc/fs)^2))^effN = 1/2 -> fs = fc * sqrt(2^(1/effN) - 1)
  const factor = Math.sqrt(Math.pow(2, 1 / effN) - 1);
  const fSection = cfg.response === 'highpass' ? fcRaw * factor : fcRaw / factor;
  const tau = 1 / (2 * Math.PI * fSection);

  const forwardPass = (): void => {
    for (let s = 0; s < order; s++) {
      if (cfg.response === 'highpass') {
        let y = 0;
        let xPrev = buf[0];
        buf[0] = 0;
        for (let i = 1; i < n; i++) {
          const dt = t[i] - t[i - 1];
          const alpha = dt > 0 ? Math.exp(-dt / tau) : 1;
          const x = buf[i];
          y = alpha * (y + x - xPrev);
          xPrev = x;
          buf[i] = y;
        }
      } else {
        let y = buf[0];
        for (let i = 1; i < n; i++) {
          const dt = t[i] - t[i - 1];
          const a = dt > 0 ? 1 - Math.exp(-dt / tau) : 0;
          y += a * (buf[i] - y);
          buf[i] = y;
        }
      }
    }
  };

  const backwardPass = (): void => {
    for (let s = 0; s < order; s++) {
      if (cfg.response === 'highpass') {
        let y = 0;
        let xNext = buf[n - 1];
        buf[n - 1] = 0;
        for (let i = n - 2; i >= 0; i--) {
          const dt = t[i + 1] - t[i];
          const alpha = dt > 0 ? Math.exp(-dt / tau) : 1;
          const x = buf[i];
          y = alpha * (y + x - xNext);
          xNext = x;
          buf[i] = y;
        }
      } else {
        let y = buf[n - 1];
        for (let i = n - 2; i >= 0; i--) {
          const dt = t[i + 1] - t[i];
          const a = dt > 0 ? 1 - Math.exp(-dt / tau) : 0;
          y += a * (buf[i] - y);
          buf[i] = y;
        }
      }
    }
  };

  forwardPass();
  if (cfg.zeroPhase) backwardPass();
}

export function designFirWindowedSincKernel(cfg: FilterConfig, fsHz: number): Float64Array {
  let M = Math.max(5, Math.min(511, Math.round(cfg.firTaps)));
  if (M % 2 === 0) M += 1;
  const half = (M - 1) / 2;
  const nyq = fsHz / 2;
  const clamp = (f: number) => Math.max(1e-6 * fsHz, Math.min(nyq * 0.97, f));

  const fc1 = clamp(cfg.cutoffHz) / fsHz; // normalized cycles/sample (0..0.5)
  let fc2 = clamp(cfg.cutoffHighHz) / fsHz;
  if ((cfg.response === 'bandpass' || cfg.response === 'bandstop') && fc2 <= fc1) {
    fc2 = Math.min(0.485, fc1 * 2);
  }

  const winVal = (i: number): number => {
    const r = (2 * Math.PI * i) / (M - 1);
    if (cfg.firWindow === 'hamming') return 0.54 - 0.46 * Math.cos(r);
    if (cfg.firWindow === 'blackman') return 0.42 - 0.5 * Math.cos(r) + 0.08 * Math.cos(2 * r);
    return 0.5 - 0.5 * Math.cos(r); // hann
  };

  const lpKernel = (fcNorm: number): Float64Array => {
    const h = new Float64Array(M);
    let sum = 0;
    for (let i = 0; i < M; i++) {
      const m = i - half;
      const sinc = m === 0 ? 2 * fcNorm : Math.sin(2 * Math.PI * fcNorm * m) / (Math.PI * m);
      h[i] = sinc * winVal(i);
      sum += h[i];
    }
    if (Math.abs(sum) > 1e-18) {
      for (let i = 0; i < M; i++) h[i] /= sum;
    }
    return h;
  };

  if (cfg.response === 'lowpass') return lpKernel(fc1);

  if (cfg.response === 'highpass') {
    const h = lpKernel(fc1);
    for (let i = 0; i < M; i++) h[i] = -h[i];
    h[half] += 1;
    return h;
  }

  if (cfg.response === 'bandpass') {
    const hLow = lpKernel(fc1);
    const hHigh = lpKernel(fc2);
    const h = new Float64Array(M);
    for (let i = 0; i < M; i++) h[i] = hHigh[i] - hLow[i];
    return h;
  }

  // bandstop = 1 - bandpass
  const hLow = lpKernel(fc1);
  const hHigh = lpKernel(fc2);
  const h = new Float64Array(M);
  for (let i = 0; i < M; i++) h[i] = -(hHigh[i] - hLow[i]);
  h[half] += 1;
  return h;
}

function convolveSymmetric(buf: Float64Array, kernel: Float64Array): void {
  const n = buf.length;
  const M = kernel.length;
  const half = (M - 1) >> 1;
  const src = new Float64Array(buf);

  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < M; k++) {
      let idx = i + k - half;
      if (idx < 0) idx = -idx;
      if (idx >= n) idx = 2 * n - 2 - idx;
      if (idx < 0) idx = 0;
      if (idx >= n) idx = n - 1;
      acc += src[idx] * kernel[k];
    }
    buf[i] = acc;
  }
}

/**
 * Computes exact Savitzky-Golay smoothing coefficients for window size M and poly degree p
 * via normal equations (A^T A) c = e_0 solved with Gaussian elimination.
 */
export function computeSavGolKernel(windowSize: number, polyOrder: number): Float64Array {
  let M = Math.max(5, Math.min(201, Math.round(windowSize)));
  if (M % 2 === 0) M += 1;
  const half = (M - 1) >> 1;
  const p = Math.max(1, Math.min(Math.min(5, M - 2), Math.round(polyOrder)));
  const cols = p + 1;

  // Build Gram matrix G = J^T J (cols x cols)
  const G: number[][] = Array.from({ length: cols }, () => new Array(cols).fill(0));
  for (let r = 0; r < cols; r++) {
    for (let c = 0; c < cols; c++) {
      let s = 0;
      for (let m = -half; m <= half; m++) {
        s += Math.pow(m, r + c);
      }
      G[r][c] = s;
    }
  }

  // Solve G * alpha = [1, 0, 0, ...] for first column of (J^T J)^-1
  const rhs = new Array(cols).fill(0);
  rhs[0] = 1;
  const aug = G.map((row, idx) => [...row, rhs[idx]]);

  for (let col = 0; col < cols; col++) {
    let pivotRow = col;
    for (let r = col + 1; r < cols; r++) {
      if (Math.abs(aug[r][col]) > Math.abs(aug[pivotRow][col])) pivotRow = r;
    }
    const tmp = aug[col];
    aug[col] = aug[pivotRow];
    aug[pivotRow] = tmp;

    const pivot = aug[col][col] || 1e-18;
    for (let c = col; c <= cols; c++) aug[col][c] /= pivot;
    for (let r = 0; r < cols; r++) {
      if (r === col) continue;
      const factor = aug[r][col];
      for (let c = col; c <= cols; c++) {
        aug[r][c] -= factor * aug[col][c];
      }
    }
  }

  const alpha = aug.map((row) => row[cols]);
  const kernel = new Float64Array(M);
  let sum = 0;
  for (let idx = 0; idx < M; idx++) {
    const m = idx - half;
    let w = 0;
    let mp = 1;
    for (let j = 0; j < cols; j++) {
      w += alpha[j] * mp;
      mp *= m;
    }
    kernel[idx] = w;
    sum += w;
  }
  if (Math.abs(sum) > 1e-12) {
    for (let idx = 0; idx < M; idx++) kernel[idx] /= sum;
  }
  return kernel;
}

function applyMovingAverage(buf: Float64Array, cfg: FilterConfig): void {
  const n = buf.length;
  if (n < 2) return;

  if (cfg.maMode === 'ema') {
    const alpha = Math.max(0.001, Math.min(0.999, cfg.emaAlpha));
    let y = buf[0];
    for (let i = 1; i < n; i++) {
      y = alpha * buf[i] + (1 - alpha) * y;
      buf[i] = y;
    }
    if (cfg.zeroPhase) {
      let yb = buf[n - 1];
      for (let i = n - 2; i >= 0; i--) {
        yb = alpha * buf[i] + (1 - alpha) * yb;
        buf[i] = yb;
      }
    }
    return;
  }

  let win = Math.max(3, Math.min(501, Math.round(cfg.windowSamples)));
  if (win % 2 === 0) win += 1;
  const half = (win - 1) >> 1;
  const src = new Float64Array(buf);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + src[i];
  for (let i = 0; i < n; i++) {
    const s = Math.max(0, i - half);
    const e = Math.min(n - 1, i + half);
    buf[i] = (prefix[e + 1] - prefix[s]) / (e - s + 1);
  }
}

function applyMedianFilter(buf: Float64Array, windowSamples: number): void {
  const n = buf.length;
  if (n < 3) return;
  let win = Math.max(3, Math.min(101, Math.round(windowSamples)));
  if (win % 2 === 0) win += 1;
  const half = (win - 1) >> 1;
  const src = new Float64Array(buf);
  const scratch = new Float64Array(win);

  for (let i = 0; i < n; i++) {
    let k = 0;
    for (let j = i - half; j <= i + half; j++) {
      const idx = j < 0 ? 0 : j >= n ? n - 1 : j;
      scratch[k++] = src[idx];
    }
    scratch.subarray(0, k).sort();
    buf[i] = scratch[k >> 1];
  }
}

// =============================================================================
// Unified Channel Filter Execution (Whole or Partial, Uniform or Adaptive Step)
// =============================================================================

function fillGapsLinear(v: Float32Array): { filled: Float64Array; nanMask: Uint8Array; hasValid: boolean } {
  const n = v.length;
  const filled = new Float64Array(n);
  const nanMask = new Uint8Array(n);
  let firstValid = -1;
  let lastValid = -1;

  for (let i = 0; i < n; i++) {
    const x = v[i];
    if (Number.isFinite(x)) {
      filled[i] = x;
      if (firstValid === -1) firstValid = i;
      lastValid = i;
    } else {
      nanMask[i] = 1;
    }
  }

  if (firstValid === -1) return { filled, nanMask, hasValid: false };

  for (let i = 0; i < firstValid; i++) filled[i] = filled[firstValid];
  for (let i = lastValid + 1; i < n; i++) filled[i] = filled[lastValid];

  let prev = firstValid;
  for (let i = firstValid + 1; i <= lastValid; i++) {
    if (!nanMask[i]) {
      const gapLen = i - prev;
      if (gapLen > 1) {
        const v0 = filled[prev];
        const v1 = filled[i];
        for (let g = 1; g < gapLen; g++) {
          filled[prev + g] = v0 + ((v1 - v0) * g) / gapLen;
        }
      }
      prev = i;
    }
  }

  return { filled, nanMask, hasValid: true };
}

function interpolateOnGrid(tSrc: Float64Array, vSrc: Float64Array, tDst: Float64Array): Float64Array {
  const nSrc = tSrc.length;
  const nDst = tDst.length;
  const out = new Float64Array(nDst);
  if (nSrc === 0) return out;
  if (nSrc === 1) {
    out.fill(vSrc[0]);
    return out;
  }

  let idx = 0;
  for (let k = 0; k < nDst; k++) {
    const target = tDst[k];
    if (target <= tSrc[0]) {
      out[k] = vSrc[0];
      continue;
    }
    if (target >= tSrc[nSrc - 1]) {
      out[k] = vSrc[nSrc - 1];
      continue;
    }
    while (idx < nSrc - 2 && tSrc[idx + 1] < target) idx++;
    const span = tSrc[idx + 1] - tSrc[idx];
    const frac = span > 1e-18 ? Math.max(0, Math.min(1, (target - tSrc[idx]) / span)) : 0;
    out[k] = vSrc[idx] + frac * (vSrc[idx + 1] - vSrc[idx]);
  }
  return out;
}

function runCoreFilterOnSlice(
  tSlice: Float64Array,
  bufSlice: Float64Array,
  cfg: FilterConfig,
  fsHz: number
): void {
  switch (cfg.algorithm) {
    case 'rc_passive':
      applyRcFilterVariableDt(tSlice, bufSlice, cfg);
      break;
    case 'butterworth':
    case 'bessel':
    case 'chebyshev1':
    case 'notch': {
      const sos = designIirSosSections(cfg, fsHz);
      applySosCascade(bufSlice, sos, cfg.zeroPhase);
      break;
    }
    case 'fir_sinc': {
      const kernel = designFirWindowedSincKernel(cfg, fsHz);
      convolveSymmetric(bufSlice, kernel);
      break;
    }
    case 'savgol': {
      const kernel = computeSavGolKernel(cfg.windowSamples, cfg.sgPolyOrder);
      convolveSymmetric(bufSlice, kernel);
      break;
    }
    case 'moving_avg':
      applyMovingAverage(bufSlice, cfg);
      break;
    case 'median':
      applyMedianFilter(bufSlice, cfg.windowSamples);
      break;
  }
}

export function getFilterBadgeText(cfg: FilterConfig): string {
  if (cfg.algorithm === 'notch') return 'NOTCH';
  if (cfg.algorithm === 'median') return 'MED';
  if (cfg.algorithm === 'moving_avg') return cfg.maMode === 'ema' ? 'EMA' : 'MA';
  if (cfg.algorithm === 'savgol') return 'SG';
  if (cfg.algorithm === 'fir_sinc') {
    if (cfg.response === 'highpass') return 'FIR-HP';
    if (cfg.response === 'bandpass') return 'FIR-BP';
    if (cfg.response === 'bandstop') return 'FIR-BS';
    return 'FIR-LP';
  }
  if (cfg.response === 'highpass') return 'HPF';
  if (cfg.response === 'bandpass') return 'BPF';
  if (cfg.response === 'bandstop') return 'BSF';
  return 'LPF';
}

export function formatFilterSummary(cfg: FilterConfig): string {
  const fmtF = (f: number) =>
    f >= 1e6
      ? `${(f / 1e6).toPrecision(3)}MHz`
      : f >= 1e3
      ? `${(f / 1e3).toPrecision(3)}kHz`
      : `${f.toPrecision(3)}Hz`;

  switch (cfg.algorithm) {
    case 'rc_passive': {
      const fc = resolveRcCutoffHz(cfg);
      return `RC-${cfg.response === 'highpass' ? 'HP' : 'LP'}${cfg.order} (${fmtF(fc)})`;
    }
    case 'butterworth':
    case 'bessel':
    case 'chebyshev1': {
      const name = cfg.algorithm === 'butterworth' ? 'Butt' : cfg.algorithm === 'bessel' ? 'Bess' : 'Cheb';
      const rangeStr =
        cfg.response === 'bandpass' || cfg.response === 'bandstop'
          ? `${fmtF(cfg.cutoffHz)}~${fmtF(cfg.cutoffHighHz)}`
          : fmtF(cfg.cutoffHz);
      return `${name}-${cfg.order} ${getFilterBadgeText(cfg)} (${rangeStr})`;
    }
    case 'notch':
      return `Notch (${fmtF(cfg.centerFreqHz)}, Q=${cfg.qFactor})`;
    case 'fir_sinc':
      return `FIR-${cfg.firTaps}t ${cfg.firWindow} (${fmtF(cfg.cutoffHz)})`;
    case 'savgol':
      return `SavGol (N=${cfg.windowSamples}, p=${cfg.sgPolyOrder})`;
    case 'moving_avg':
      return cfg.maMode === 'ema' ? `EMA (α=${cfg.emaAlpha.toFixed(2)})` : `MA (N=${cfg.windowSamples})`;
    case 'median':
      return `Median (K=${cfg.windowSamples})`;
  }
}

export function validateFilterConfig(
  cfg: FilterConfig,
  t: Float64Array
): { ok: boolean; message?: string; warning?: string } {
  if (!t || t.length < 3) {
    return { ok: false, message: 'At least 3 waveform samples are required.' };
  }
  const nyq = nyquistOf(t);
  if (nyq <= 0) {
    return { ok: false, message: 'Invalid timebase (non-increasing timestamps).' };
  }

  const effFc = cfg.algorithm === 'rc_passive' ? resolveRcCutoffHz(cfg) : cfg.cutoffHz;
  const usesFc =
    cfg.algorithm === 'rc_passive' ||
    cfg.algorithm === 'butterworth' ||
    cfg.algorithm === 'bessel' ||
    cfg.algorithm === 'chebyshev1' ||
    cfg.algorithm === 'fir_sinc';

  if (usesFc) {
    if (!Number.isFinite(effFc) || effFc <= 0) {
      return { ok: false, message: 'Cutoff frequency / R·C must yield fc > 0 Hz.' };
    }
    if (effFc >= nyq * 0.99) {
      return {
        ok: false,
        message: `Cutoff (${effFc.toPrecision(4)} Hz) must be below Nyquist (${nyq.toPrecision(4)} Hz).`,
      };
    }
    if (cfg.response === 'bandpass' || cfg.response === 'bandstop') {
      if (!Number.isFinite(cfg.cutoffHighHz) || cfg.cutoffHighHz <= effFc) {
        return { ok: false, message: 'Upper cutoff frequency f_high must be greater than f_low.' };
      }
      if (cfg.cutoffHighHz >= nyq * 0.99) {
        return {
          ok: false,
          message: `Upper cutoff must be below Nyquist (${nyq.toPrecision(4)} Hz).`,
        };
      }
    }
  }

  if (cfg.algorithm === 'notch') {
    if (!Number.isFinite(cfg.centerFreqHz) || cfg.centerFreqHz <= 0 || cfg.centerFreqHz >= nyq * 0.99) {
      return {
        ok: false,
        message: `Notch frequency must be between 0 and Nyquist (${nyq.toPrecision(4)} Hz).`,
      };
    }
    if (!Number.isFinite(cfg.qFactor) || cfg.qFactor < 0.25) {
      return { ok: false, message: 'Quality factor Q must be >= 0.25.' };
    }
  }

  if (cfg.regionMode === 'custom') {
    if (cfg.tStart !== undefined && cfg.tEnd !== undefined && cfg.tEnd <= cfg.tStart) {
      return { ok: false, message: 'Custom end time must be greater than start time.' };
    }
  }

  if (usesFc && effFc > nyq * 0.75) {
    return {
      ok: true,
      warning: `Cutoff (${effFc.toPrecision(3)} Hz) is near Nyquist (${nyq.toPrecision(3)} Hz); bilinear warping is steep.`,
    };
  }

  return { ok: true };
}

/**
 * Executes filtering on a waveform (whole or partial [tStart, tEnd]), safely handling
 * NaNs and adaptive-timestep (non-uniform) waveforms.
 */
export function applyWaveformFilter(
  t: Float64Array,
  v: Float32Array,
  cfg: FilterConfig,
  bounds?: { viewStart?: number; viewEnd?: number; cursorX1?: number | null; cursorX2?: number | null }
): FilterExecutionResult {
  const n = Math.min(t.length, v.length);
  const dtMed = medianDt(t);
  const fsHz = dtMed > 0 ? 1 / dtMed : 1;
  const nyq = fsHz / 2;

  if (n < 3) {
    return {
      v: new Float32Array(v),
      t,
      metrics: {
        sampleCountTotal: n,
        sampleCountFiltered: 0,
        effectiveFsHz: fsHz,
        nyquistHz: nyq,
        resampledAdaptive: false,
        tStartApplied: t[0] || 0,
        tEndApplied: t[n - 1] || 0,
        rmsBefore: 0,
        rmsAfter: 0,
        rmsRemovedDiff: 0,
        vppBefore: 0,
        vppAfter: 0,
        effectiveCutoffHz: cfg.algorithm === 'rc_passive' ? resolveRcCutoffHz(cfg) : cfg.cutoffHz,
        badgeText: getFilterBadgeText(cfg),
        summaryText: formatFilterSummary(cfg),
      },
      warning: 'Insufficient samples',
    };
  }

  // Determine active time window [tWinStart, tWinEnd]
  let tWinStart = t[0];
  let tWinEnd = t[n - 1];
  if (cfg.regionMode === 'view' && bounds?.viewStart !== undefined && bounds?.viewEnd !== undefined) {
    tWinStart = Math.max(t[0], Math.min(bounds.viewStart, bounds.viewEnd));
    tWinEnd = Math.min(t[n - 1], Math.max(bounds.viewStart, bounds.viewEnd));
  } else if (
    cfg.regionMode === 'cursors' &&
    bounds?.cursorX1 !== undefined &&
    bounds?.cursorX1 !== null &&
    bounds?.cursorX2 !== undefined &&
    bounds?.cursorX2 !== null
  ) {
    tWinStart = Math.max(t[0], Math.min(bounds.cursorX1, bounds.cursorX2));
    tWinEnd = Math.min(t[n - 1], Math.max(bounds.cursorX1, bounds.cursorX2));
  } else if (cfg.regionMode === 'custom' && cfg.tStart !== undefined && cfg.tEnd !== undefined) {
    tWinStart = Math.max(t[0], Math.min(cfg.tStart, cfg.tEnd));
    tWinEnd = Math.min(t[n - 1], Math.max(cfg.tStart, cfg.tEnd));
  }

  let iStart = 0;
  while (iStart < n - 1 && t[iStart] < tWinStart - 1e-15) iStart++;
  let iEnd = n - 1;
  while (iEnd > iStart && t[iEnd] > tWinEnd + 1e-15) iEnd--;

  if (iEnd - iStart < 2) {
    iStart = 0;
    iEnd = n - 1;
    tWinStart = t[0];
    tWinEnd = t[n - 1];
  }

  const { filled, nanMask, hasValid } = fillGapsLinear(v);
  if (!hasValid) {
    return {
      v: new Float32Array(v),
      t,
      metrics: {
        sampleCountTotal: n,
        sampleCountFiltered: 0,
        effectiveFsHz: fsHz,
        nyquistHz: nyq,
        resampledAdaptive: false,
        tStartApplied: tWinStart,
        tEndApplied: tWinEnd,
        rmsBefore: 0,
        rmsAfter: 0,
        rmsRemovedDiff: 0,
        vppBefore: 0,
        vppAfter: 0,
        effectiveCutoffHz: cfg.algorithm === 'rc_passive' ? resolveRcCutoffHz(cfg) : cfg.cutoffHz,
        badgeText: getFilterBadgeText(cfg),
        summaryText: formatFilterSummary(cfg),
      },
      warning: 'No valid samples',
    };
  }

  // Context margin around [iStart, iEnd] so partial filtering enters steady state smoothly
  const isPartial = iStart > 0 || iEnd < n - 1;
  const ctxPad = isPartial ? Math.min(256, Math.max(32, Math.round((iEnd - iStart + 1) * 0.15))) : 0;
  const ctxStart = Math.max(0, iStart - ctxPad);
  const ctxEnd = Math.min(n - 1, iEnd + ctxPad);
  const ctxLen = ctxEnd - ctxStart + 1;

  const tCtx = t.subarray(ctxStart, ctxEnd + 1);
  const vCtxF32 = new Float32Array(ctxLen);
  for (let i = 0; i < ctxLen; i++) vCtxF32[i] = filled[ctxStart + i];

  const needsUniformGrid = cfg.algorithm !== 'rc_passive';
  const nonUniform = isNonUniformTimestep(tCtx);
  let resampledAdaptive = false;
  let filteredCtx: Float64Array;

  if (needsUniformGrid && nonUniform) {
    resampledAdaptive = true;
    const uniform = resampleUniform(tCtx, vCtxF32, { allowGapInterpolation: true });
    const work = new Float64Array(uniform.v.length);
    for (let i = 0; i < uniform.v.length; i++) {
      work[i] = Number.isFinite(uniform.v[i]) ? uniform.v[i] : 0;
    }
    runCoreFilterOnSlice(uniform.t, work, cfg, uniform.fs);
    filteredCtx = interpolateOnGrid(uniform.t, work, tCtx);
  } else {
    filteredCtx = new Float64Array(ctxLen);
    for (let i = 0; i < ctxLen; i++) filteredCtx[i] = vCtxF32[i];
    const localDt = dtMed > 0 ? dtMed : (tCtx[ctxLen - 1] - tCtx[0]) / Math.max(1, ctxLen - 1);
    const localFs = localDt > 0 ? 1 / localDt : fsHz;
    runCoreFilterOnSlice(tCtx, filteredCtx, cfg, localFs);
  }

  // Reassemble full trace, preserving untouched samples outside [iStart, iEnd]
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = v[i];

  const activeLen = iEnd - iStart + 1;
  const blendPct = isPartial ? Math.max(0, Math.min(25, cfg.edgeBlendPct)) : 0;
  const blendSamples = blendPct > 0 ? Math.min(Math.floor(activeLen / 4), Math.round((activeLen * blendPct) / 100)) : 0;

  let sumSqBefore = 0;
  let sumSqAfter = 0;
  let sumSqDiff = 0;
  let minB = Infinity;
  let maxB = -Infinity;
  let minA = Infinity;
  let maxA = -Infinity;
  let validCount = 0;

  for (let i = iStart; i <= iEnd; i++) {
    if (nanMask[i]) {
      out[i] = NaN;
      continue;
    }
    const rawVal = v[i];
    const filtVal = filteredCtx[i - ctxStart];
    let w = 1;
    if (blendSamples > 0) {
      const dLeft = i - iStart;
      const dRight = iEnd - i;
      if (dLeft < blendSamples) {
        w = 0.5 - 0.5 * Math.cos((Math.PI * (dLeft + 1)) / (blendSamples + 1));
      } else if (dRight < blendSamples) {
        w = 0.5 - 0.5 * Math.cos((Math.PI * (dRight + 1)) / (blendSamples + 1));
      }
    }
    const finalVal = rawVal + w * (filtVal - rawVal);
    out[i] = finalVal;

    sumSqBefore += rawVal * rawVal;
    sumSqAfter += finalVal * finalVal;
    const diff = finalVal - rawVal;
    sumSqDiff += diff * diff;
    if (rawVal < minB) minB = rawVal;
    if (rawVal > maxB) maxB = rawVal;
    if (finalVal < minA) minA = finalVal;
    if (finalVal > maxA) maxA = finalVal;
    validCount++;
  }

  const invN = validCount > 0 ? 1 / validCount : 0;
  return {
    v: out,
    t,
    metrics: {
      sampleCountTotal: n,
      sampleCountFiltered: activeLen,
      effectiveFsHz: fsHz,
      nyquistHz: nyq,
      resampledAdaptive,
      tStartApplied: t[iStart],
      tEndApplied: t[iEnd],
      rmsBefore: Math.sqrt(sumSqBefore * invN),
      rmsAfter: Math.sqrt(sumSqAfter * invN),
      rmsRemovedDiff: Math.sqrt(sumSqDiff * invN),
      vppBefore: Number.isFinite(maxB - minB) ? maxB - minB : 0,
      vppAfter: Number.isFinite(maxA - minA) ? maxA - minA : 0,
      effectiveCutoffHz: cfg.algorithm === 'rc_passive' ? resolveRcCutoffHz(cfg) : cfg.cutoffHz,
      badgeText: getFilterBadgeText(cfg),
      summaryText: formatFilterSummary(cfg),
    },
  };
}

// =============================================================================
// Theoretical Bode Frequency Response |H(f)| for Live UI Preview & Testing
// =============================================================================

export function computeFilterBodeResponse(
  cfg: FilterConfig,
  fsHz: number,
  numPts: number = 180
): BodePoint[] {
  const safeFs = Number.isFinite(fsHz) && fsHz > 0 ? fsHz : 100000;
  const nyq = safeFs / 2;
  const fMin = Math.max(1e-3, nyq / 2500);
  const fMax = nyq * 0.96;

  // Pre-build frequency grid (logarithmic spacing)
  const freqs = new Array<number>(numPts);
  const logMin = Math.log10(fMin);
  const logMax = Math.log10(fMax);
  for (let i = 0; i < numPts; i++) {
    freqs[i] = Math.pow(10, logMin + ((logMax - logMin) * i) / Math.max(1, numPts - 1));
  }

  // Evaluate transfer function H(f) depending on algorithm
  let iirSections: BiquadSection[] | null = null;
  let firKernel: Float64Array | null = null;

  if (
    cfg.algorithm === 'butterworth' ||
    cfg.algorithm === 'bessel' ||
    cfg.algorithm === 'chebyshev1' ||
    cfg.algorithm === 'notch'
  ) {
    iirSections = designIirSosSections(cfg, safeFs);
  } else if (cfg.algorithm === 'fir_sinc') {
    firKernel = designFirWindowedSincKernel(cfg, safeFs);
  } else if (cfg.algorithm === 'savgol') {
    firKernel = computeSavGolKernel(cfg.windowSamples, cfg.sgPolyOrder);
  } else if (cfg.algorithm === 'moving_avg' && cfg.maMode === 'boxcar') {
    let win = Math.max(3, Math.min(501, Math.round(cfg.windowSamples)));
    if (win % 2 === 0) win += 1;
    firKernel = new Float64Array(win).fill(1 / win);
  }

  const pts: BodePoint[] = new Array(freqs.length);

  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i];
    const omega = (2 * Math.PI * f) / safeFs;
    let mag = 1;
    let phaseDeg = 0;

    if (cfg.algorithm === 'rc_passive') {
      const fcRaw = Math.max(1e-6, resolveRcCutoffHz(cfg));
      const ord = Math.max(1, Math.min(4, Math.round(cfg.order)));
      const effN = cfg.zeroPhase ? ord * 2 : ord;
      const factor = Math.sqrt(Math.pow(2, 1 / effN) - 1);
      const fSec = cfg.response === 'highpass' ? fcRaw * factor : fcRaw / factor;
      // Exact analog 1st-order s-plane response cascaded effN times:
      if (cfg.response === 'highpass') {
        const ratio = f / fSec;
        const singleMag = ratio / Math.sqrt(1 + ratio * ratio);
        mag = Math.pow(singleMag, effN);
        phaseDeg = cfg.zeroPhase ? 0 : ord * ((Math.atan2(fSec, f) * 180) / Math.PI);
      } else {
        const ratio = f / fSec;
        const singleMag = 1 / Math.sqrt(1 + ratio * ratio);
        mag = Math.pow(singleMag, effN);
        phaseDeg = cfg.zeroPhase ? 0 : -ord * ((Math.atan2(f, fSec) * 180) / Math.PI);
      }
    } else if (iirSections) {
      const h = evalSosCascadeResponse(iirSections, f, safeFs);
      const rawMag = cAbs(h);
      mag = cfg.zeroPhase ? rawMag * rawMag : rawMag;
      phaseDeg = cfg.zeroPhase ? 0 : (Math.atan2(h.im, h.re) * 180) / Math.PI;
    } else if (firKernel) {
      const M = firKernel.length;
      const half = (M - 1) >> 1;
      let re = 0;
      let im = 0;
      for (let k = 0; k < M; k++) {
        const m = k - half;
        re += firKernel[k] * Math.cos(omega * m);
        im -= firKernel[k] * Math.sin(omega * m);
      }
      mag = Math.hypot(re, im);
      phaseDeg = 0; // symmetric linear phase centered at m=0
    } else if (cfg.algorithm === 'moving_avg' && cfg.maMode === 'ema') {
      const a = Math.max(0.001, Math.min(0.999, cfg.emaAlpha));
      const num: Complex = { re: a, im: 0 };
      const den: Complex = {
        re: 1 - (1 - a) * Math.cos(omega),
        im: (1 - a) * Math.sin(omega),
      };
      const h = cDiv(num, den);
      const rawMag = cAbs(h);
      mag = cfg.zeroPhase ? rawMag * rawMag : rawMag;
      phaseDeg = cfg.zeroPhase ? 0 : (Math.atan2(h.im, h.re) * 180) / Math.PI;
    } else if (cfg.algorithm === 'median') {
      // Empirical equivalent Sinc-like rolloff approximation for Bode curve display
      let win = Math.max(3, Math.min(101, Math.round(cfg.windowSamples)));
      if (win % 2 === 0) win += 1;
      const arg = omega * win * 0.35;
      mag = arg > 1e-6 ? Math.abs(Math.sin(arg) / arg) : 1;
      phaseDeg = 0;
    }

    const magDb = 20 * Math.log10(Math.max(1e-5, mag));
    pts[i] = { freqHz: f, magDb: Math.max(-90, Math.min(6, magDb)), phaseDeg };
  }

  return pts;
}
