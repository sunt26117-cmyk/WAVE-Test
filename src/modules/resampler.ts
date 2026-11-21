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

  const tStart = t[0];
  const tEnd = t[N - 1];
  const totalDuration = Math.max(1e-12, tEnd - tStart);
  const avgDt = totalDuration / Math.max(1, N - 1);

  // Determine nominal dt from positive intervals
  let dt = options.nominalDt;
  if (!dt || dt <= 0) {
    const posDts: number[] = [];
    for (let i = 1; i < N; i++) {
      const d = t[i] - t[i - 1];
      if (d > 0 && isFinite(d)) posDts.push(d);
    }
    posDts.sort((a, b) => a - b);
    const mid = Math.floor(posDts.length / 2);
    dt =
      posDts.length === 0
        ? 0
        : posDts.length % 2 === 0
        ? (posDts[mid - 1] + posDts[mid]) / 2
        : posDts[mid];
    if (dt <= 0) dt = avgDt;
    if (dt <= 0) dt = 1e-3;

    // Variable-step solver protection (e.g. PSIM/PLECS/SPICE fine switching steps pulling medianDt tiny):
    // Keep uniform resampled density proportional (<= 262,144 pts) instead of bloating to 1M-2M pts.
    if (avgDt / dt > 2.5) {
      const targetCap = Math.min(262144, Math.max(N * 2, 65536));
      dt = Math.max(dt, totalDuration / (targetCap - 1));
    }
  }

  const MAX_RESAMPLE_POINTS = 2000000;
  let numUniformPoints = Math.max(2, Math.round(totalDuration / dt) + 1);
  if (numUniformPoints > MAX_RESAMPLE_POINTS) {
    numUniformPoints = MAX_RESAMPLE_POINTS;
    dt = totalDuration / (numUniformPoints - 1);
  }

  const resampledT = new Float64Array(numUniformPoints);
  const resampledV = new Float32Array(numUniformPoints);
  const gapIndices: number[] = [];
  const gapThreshold = dt * 8.0;

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

    // Check if we are inside a true missing-data gap (or NaN sample)
    if (isNaN(v0) || isNaN(v1)) {
      resampledV[k] = NaN;
    } else if (span > gapThreshold && !options.allowGapInterpolation) {
      resampledV[k] = NaN;
      gapIndices.push(k);
    } else if (span <= 1e-16) {
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
