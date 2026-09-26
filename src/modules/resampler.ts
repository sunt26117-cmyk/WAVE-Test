/**
 * Waveform Viewer Pro - Unified Resampling Module
 * Performs robust linear resampling onto a uniform grid while handling and respecting gaps.
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

/**
 * Resamples non-uniform time-domain data onto a uniform grid.
 *
 * @param t Raw time array (Float64Array, monotonically non-decreasing, in seconds)
 * @param v Raw value array (Float32Array)
 * @param options Resampling options
 */
export function resampleUniform(
  t: Float64Array,
  v: Float32Array,
  options: ResampleOptions = {}
): ResampledChannel {
  const N = t.length;
  if (N === 0) {
    return {
      t: new Float64Array(0),
      v: new Float32Array(0),
      fs: 0,
      dt: 0,
      gapIndices: [],
    };
  }

  if (N === 1) {
    return {
      t: new Float64Array([t[0]]),
      v: new Float32Array([v[0]]),
      fs: 1,
      dt: 1,
      gapIndices: [],
    };
  }

  // Determine nominal dt
  let dt = options.nominalDt;
  if (!dt || dt <= 0) {
    const dtArray = new Float64Array(N - 1);
    for (let i = 1; i < N; i++) {
      dtArray[i - 1] = t[i] - t[i - 1];
    }
    const sorted = dtArray.sort();
    const mid = Math.floor(sorted.length / 2);
    dt = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
    if (dt <= 0) dt = (t[N - 1] - t[0]) / (N - 1);
  }

  const tStart = t[0];
  const tEnd = t[N - 1];
  const totalDuration = tEnd - tStart;
  const numUniformPoints = Math.max(2, Math.round(totalDuration / dt) + 1);

  const resampledT = new Float64Array(numUniformPoints);
  const resampledV = new Float32Array(numUniformPoints);
  const gapIndices: number[] = [];
  const gapThreshold = dt * 2.5;

  let rawIdx = 0;

  for (let k = 0; k < numUniformPoints; k++) {
    const targetT = tStart + k * dt;
    resampledT[k] = targetT;

    // Advance rawIdx so that t[rawIdx] <= targetT <= t[rawIdx + 1]
    while (rawIdx < N - 2 && t[rawIdx + 1] < targetT) {
      rawIdx++;
    }

    const t0 = t[rawIdx];
    const t1 = t[rawIdx + 1];
    const v0 = v[rawIdx];
    const v1 = v[rawIdx + 1];

    const span = t1 - t0;

    // Check if we are inside a large gap
    if (span > gapThreshold && !options.allowGapInterpolation) {
      // In a gap: do not linearly interpolate across huge missing window
      resampledV[k] = NaN;
      gapIndices.push(k);
    } else if (span <= 1e-15) {
      resampledV[k] = v0;
    } else {
      const frac = Math.max(0, Math.min(1, (targetT - t0) / span));
      resampledV[k] = v0 + frac * (v1 - v0);
    }
  }

  const fs = 1 / dt;

  return {
    t: resampledT,
    v: resampledV,
    fs,
    dt,
    gapIndices,
  };
}
