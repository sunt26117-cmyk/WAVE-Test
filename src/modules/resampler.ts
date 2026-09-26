/**
 * Waveform Viewer Pro - Unified Resampling Module
 * Resamples non-uniform simulator/measurement time bases without treating
 * ordinary adaptive solver steps as missing data.
 */

export interface ResampleOptions {
  nominalDt?: number;
  allowGapInterpolation?: boolean;
  /**
   * Minimum acceptable output sample rate in Hz (e.g. 20e6 for fast MOSFET
   * gate-drive edges). Used only to flag `belowTargetRate` in the result --
   * we never fabricate resolution the source data doesn't have.
   */
  minSampleRate?: number;
  /**
   * If the source timebase is already uniform to within this fractional
   * jitter tolerance (default 0.1%), skip interpolation entirely and return
   * the original samples untouched. Regridding via linear interpolation is
   * only needed to correct real jitter/adaptive time steps; for already-clean
   * high-rate scope captures (hundreds of MHz, fast edges) it should be
   * avoided since it can subtly smooth transition edges for no benefit.
   */
  jitterPassthroughTolerance?: number;
}

export interface ResampledChannel {
  t: Float64Array;
  v: Float32Array;
  fs: number;
  dt: number;
  gapIndices: number[];
  /** True if minSampleRate was requested but the source data can't support it. */
  belowTargetRate?: boolean;
  /** True if the original samples were returned as-is (no interpolation). */
  passthrough?: boolean;
}

export function resampleUniform(
  t: Float64Array,
  v: Float32Array,
  options: ResampleOptions = {}
): ResampledChannel {
  const N = t.length;
  if (N === 0) return { t: new Float64Array(0), v: new Float32Array(0), fs: 0, dt: 0, gapIndices: [] };
  if (N === 1) return { t: new Float64Array([t[0]]), v: new Float32Array([v[0]]), fs: 1, dt: 1, gapIndices: [] };
  if (v.length !== N) throw new Error('Time and value arrays must have identical lengths.');

  let dt = options.nominalDt;
  if (!dt || dt <= 0 || !isFinite(dt)) {
    const dts: number[] = [];
    for (let i = 1; i < N; i++) {
      const d = t[i] - t[i - 1];
      if (d > 0 && isFinite(d)) dts.push(d);
    }
    if (!dts.length) throw new Error('Cannot determine a positive sampling interval.');
    dts.sort((a, b) => a - b);
    const mid = Math.floor(dts.length / 2);
    dt = dts.length % 2 ? dts[mid] : (dts[mid - 1] + dts[mid]) / 2;
  }

  // Check how uniform the source already is relative to `dt`, regardless of
  // whether `dt` was supplied by the caller or just computed above. A native
  // fixed-rate capture (typical scope binary/ASCII export) needs no
  // regridding at all -- interpolating it would only risk smoothing fast
  // edges (e.g. a MOSFET gate-drive transition sampled at hundreds of MHz)
  // for zero benefit.
  const tol = options.jitterPassthroughTolerance ?? 0.001;
  let sourceIsUniform = true;
  for (let i = 1; i < N; i++) {
    const d = t[i] - t[i - 1];
    if (!(d > 0) || !isFinite(d) || Math.abs(d - dt) > dt * tol) {
      sourceIsUniform = false;
      break;
    }
  }

  const belowTargetRate =
    options.minSampleRate && dt > 0 ? 1 / dt < options.minSampleRate : undefined;

  if (sourceIsUniform) {
    // Fast path: no jitter to correct, so don't touch the samples at all --
    // interpolating a already-uniform high-rate signal (e.g. a MOSFET gate
    // drive edge sampled at hundreds of MHz) only risks smoothing it for
    // zero gain.
    return {
      t: t.slice(),
      v: v.slice(),
      fs: 1 / dt,
      dt,
      gapIndices: [],
      belowTargetRate,
      passthrough: true,
    };
  }

  const tStart = t[0];
  const tEnd = t[N - 1];
  const totalDuration = tEnd - tStart;
  if (!(totalDuration > 0)) throw new Error('Time axis must be strictly increasing.');

  // Never round up to a grid point beyond tEnd: clamping the last sample to
  // tEnd would leave a short final interval and make a uniform grid look jittery.
  const numUniformPoints = Math.max(2, Math.floor(totalDuration / dt) + 1);
  const resampledT = new Float64Array(numUniformPoints);
  const resampledV = new Float32Array(numUniformPoints);
  const gapIndices: number[] = [];

  let rawIdx = 0;
  for (let k = 0; k < numUniformPoints; k++) {
    const targetT = Math.min(tEnd, tStart + k * dt);
    resampledT[k] = targetT;

    while (rawIdx < N - 2 && t[rawIdx + 1] < targetT) rawIdx++;

    const t0 = t[rawIdx];
    const t1 = t[Math.min(N - 1, rawIdx + 1)];
    const v0 = v[rawIdx];
    const v1 = v[Math.min(N - 1, rawIdx + 1)];

    if (!isFinite(v0) || !isFinite(v1)) {
      // Real missing samples remain missing. No hidden zero-fill or
      // interpolation across invalid endpoints.
      resampledV[k] = NaN;
      gapIndices.push(k);
      continue;
    }

    const span = t1 - t0;
    if (!(span > 0) || !isFinite(span)) {
      resampledV[k] = v0;
      continue;
    }

    const frac = Math.max(0, Math.min(1, (targetT - t0) / span));
    resampledV[k] = v0 + frac * (v1 - v0);
  }

  return { t: resampledT, v: resampledV, fs: 1 / dt, dt, gapIndices, belowTargetRate, passthrough: false };
}
