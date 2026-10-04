/**
 * Waveform Viewer Pro - Low-pass filter
 *
 * N cascaded first-order (RC) sections, discretised exactly for the *actual* time step
 * of every sample, so it is valid for non-uniform (adaptive-step SPICE / PSIM) data too.
 *
 * The per-section cutoff is scaled so that the whole cascade is -3 dB at the requested
 * cutoff:   |H(fc)|^2 = (1 + (fc/fs)^2)^-N = 1/2   ->   fs = fc / sqrt(2^(1/N) - 1)
 *
 * Zero-phase mode runs the cascade forward and then backward. That squares the magnitude
 * response, so the section cutoff is scaled for 2N sections to keep -3 dB at fc.
 * The response is monotonic: no overshoot and no ringing, unlike a high-order Butterworth.
 */

import { ChannelFilterSpec } from '../types/models';

export const FILTER_ORDERS: Array<1 | 2 | 4> = [1, 2, 4];

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
  // Fill gaps so they do not poison the recursion; they are restored as NaN afterwards.
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
  for (let i = 0; i < n && nanMask[i]; i++) work[i] = last; // leading gap

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
