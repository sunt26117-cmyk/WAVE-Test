/**
 * Time-domain support helpers for waveform comparison.
 * Coverage is a duration ratio, not a count of samples. This matters when
 * acquisition timebases are non-uniform or contain dropped-sample gaps.
 */
export interface TemporalCoverageResult {
  coveragePct: number;
  coveredDurationSec: number;
  totalDurationSec: number;
  coveredSampleMask: Uint8Array;
  intervalIndices: number[];
}

export function computeTemporalCoverage(
  t: Float64Array,
  validSampleMask: Uint8Array,
  gapThresholdSec = Number.POSITIVE_INFINITY
): TemporalCoverageResult {
  const n = t.length;
  const coveredSampleMask = new Uint8Array(n);
  const intervalIndices: number[] = [];
  if (validSampleMask.length !== n || n < 2) {
    return { coveragePct: 0, coveredDurationSec: 0, totalDurationSec: 0, coveredSampleMask, intervalIndices };
  }

  const totalDurationSec = Math.max(0, t[n - 1] - t[0]);
  if (!(totalDurationSec > 0) || !Number.isFinite(totalDurationSec)) {
    return { coveragePct: 0, coveredDurationSec: 0, totalDurationSec: 0, coveredSampleMask, intervalIndices };
  }

  let coveredDurationSec = 0;
  for (let i = 0; i < n - 1; i++) {
    const dt = t[i + 1] - t[i];
    if (!(dt > 0) || !Number.isFinite(dt) || dt > gapThresholdSec) continue;
    if (!validSampleMask[i] || !validSampleMask[i + 1]) continue;
    coveredDurationSec += dt;
    intervalIndices.push(i);
    coveredSampleMask[i] = 1;
    coveredSampleMask[i + 1] = 1;
  }

  return {
    coveragePct: Math.max(0, Math.min(100, coveredDurationSec / totalDurationSec * 100)),
    coveredDurationSec,
    totalDurationSec,
    coveredSampleMask,
    intervalIndices,
  };
}
