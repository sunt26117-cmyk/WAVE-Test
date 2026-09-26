/**
 * Waveform Viewer Pro - Unified Resampling Module
 * Resamples non-uniform simulator/measurement time bases without treating
 * ordinary adaptive solver steps as missing data.
 */

export interface ResampleOptions {
  nominalDt?: number;
  allowGapInterpolation?: boolean;
}

export interface ResampledChannel {
  t: Float64Array;
  v: Float32Array;
  fs: number;
  dt: number;
  gapIndices: number[];
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

  return { t: resampledT, v: resampledV, fs: 1 / dt, dt, gapIndices };
}
