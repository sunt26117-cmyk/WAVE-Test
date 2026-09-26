/**
 * Waveform Viewer Pro - CSV Data Quality Inspection Module
 * Analyzes time column sampling characteristics, jitter, gaps, and data validity.
 */

import { SamplingMetadata, TimeQualityStatus } from '../types/models';

/**
 * Inspects a sequence of timestamps and evaluates sampling uniformity and jitter.
 *
 * @param timeArray Float64Array of timestamps (in seconds)
 * @param invalidCount Number of rows with unparsable or NaN values
 * @returns SamplingMetadata
 */
export function analyzeSamplingQuality(
  timeArray: Float64Array,
  invalidCount: number = 0
): SamplingMetadata {
  const N = timeArray.length;

  if (N < 2) {
    return {
      originalSampleCount: N,
      originalTimeStart: N > 0 ? timeArray[0] : 0,
      originalTimeEnd: N > 0 ? timeArray[N - 1] : 0,
      isUniformSampling: false,
      nominalDt: null,
      medianDt: null,
      meanDt: null,
      minDt: null,
      maxDt: null,
      jitterRms: null,
      jitterMax: null,
      droppedSamples: 0,
      invalidSamples: invalidCount,
      sampleRate: null,
      qualityStatus: 'severe-jitter',
      gapCount: 0,
      gapIndices: [],
    };
  }

  const dtArray = new Float64Array(N - 1);
  let minDt = Infinity;
  let maxDt = -Infinity;
  let sumDt = 0;

  for (let i = 1; i < N; i++) {
    const dt = timeArray[i] - timeArray[i - 1];
    dtArray[i - 1] = dt;
    if (dt < minDt) minDt = dt;
    if (dt > maxDt) maxDt = dt;
    sumDt += dt;
  }

  const meanDt = sumDt / (N - 1);

  // Compute robust median(dt) by sorting a copy
  const sortedDt = Float64Array.from(dtArray).sort();
  const mid = Math.floor(sortedDt.length / 2);
  const medianDt = sortedDt.length % 2 === 0
    ? (sortedDt[mid - 1] + sortedDt[mid]) / 2
    : sortedDt[mid];

  // Avoid division by zero
  const safeMedian = medianDt > 0 ? medianDt : (meanDt > 0 ? meanDt : 1e-6);

  // Calculate Jitter and Detect Gaps
  let sumSqJitter = 0;
  let maxJitter = 0;
  let droppedSamples = 0;
  const gapThreshold = safeMedian * 2.5; // Gap identified when dt > 2.5 * medianDt
  const gapIndices: number[] = [];

  for (let i = 0; i < dtArray.length; i++) {
    const dt = dtArray[i];
    const diff = Math.abs(dt - safeMedian);
    sumSqJitter += diff * diff;
    if (diff > maxJitter) {
      maxJitter = diff;
    }

    if (dt > gapThreshold) {
      gapIndices.push(i + 1); // Index in timeArray where gap occurs
      // Estimate dropped points in the gap interval
      const estimatedLost = Math.max(0, Math.round(dt / safeMedian) - 1);
      droppedSamples += estimatedLost;
    }
  }

  const rmsJitter = Math.sqrt(sumSqJitter / dtArray.length);
  const jitterRmsPercent = (rmsJitter / safeMedian) * 100;
  const jitterMaxPercent = (maxJitter / safeMedian) * 100;

  // Classify Quality
  let qualityStatus: TimeQualityStatus = 'uniform';
  let isUniform = true;

  if (gapIndices.length > 0 || jitterMaxPercent >= 25 || invalidCount > 0) {
    qualityStatus = 'severe-jitter';
    isUniform = false;
  } else if (jitterMaxPercent >= 1.0) {
    qualityStatus = 'non-uniform';
    isUniform = false;
  } else {
    qualityStatus = 'uniform';
    isUniform = true;
  }

  const sampleRate = safeMedian > 0 ? 1 / safeMedian : null;

  return {
    originalSampleCount: N,
    originalTimeStart: timeArray[0],
    originalTimeEnd: timeArray[N - 1],
    isUniformSampling: isUniform,
    nominalDt: safeMedian,
    medianDt: safeMedian,
    meanDt,
    minDt,
    maxDt,
    jitterRms: jitterRmsPercent,
    jitterMax: jitterMaxPercent,
    droppedSamples,
    invalidSamples: invalidCount,
    sampleRate,
    qualityStatus,
    gapCount: gapIndices.length,
    gapIndices,
  };
}

/**
 * Parses time units to multiplier for converting to seconds.
 */
export function getTimeUnitMultiplier(unit: string): number {
  const clean = unit.trim().toLowerCase();
  switch (clean) {
    case 'ns':
      return 1e-9;
    case 'us':
    case 'µs':
    case 'microsecond':
    case 'microseconds':
      return 1e-6;
    case 'ms':
    case 'millisecond':
    case 'milliseconds':
      return 1e-3;
    case 's':
    case 'sec':
    case 'second':
    case 'seconds':
    default:
      return 1.0;
  }
}
