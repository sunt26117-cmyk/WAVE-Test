/**
 * Waveform Viewer Pro - High-Density Waveform Decimation Engine
 * Implements Peak-Preserving Min-Max decimation and Largest-Triangle-Three-Buckets (LTTB)
 * while strictly respecting NaN and time-gap discontinuities (dt > 2.5 * medianDt).
 */

import { DecimationMode } from '../types/models';

export interface DecimatedPoint {
  time: number;
  value: number;
}

export type SampleReader = (index: number) => number;

/**
 * Splits [startIdx, endIdx) into contiguous valid segments separated by NaNs or large time gaps.
 */
function splitContiguousSegments(
  t: Float64Array,
  readVal: SampleReader,
  startIdx: number,
  endIdx: number,
  gapThreshold: number
): Array<{ start: number; end: number }> {
  const segments: Array<{ start: number; end: number }> = [];
  let segStart = -1;

  for (let i = startIdx; i < endIdx; i++) {
    const val = readVal(i);
    const invalid = isNaN(val) || !isFinite(val);
    const hasGap = i > startIdx && t[i] - t[i - 1] > gapThreshold;

    if (invalid) {
      if (segStart !== -1) {
        segments.push({ start: segStart, end: i });
        segStart = -1;
      }
      continue;
    }

    if (hasGap && segStart !== -1) {
      segments.push({ start: segStart, end: i });
      segStart = i;
      continue;
    }

    if (segStart === -1) {
      segStart = i;
    }
  }

  if (segStart !== -1) {
    segments.push({ start: segStart, end: endIdx });
  }

  return segments;
}

/**
 * Peak-preserving Min-Max decimation: emits (min, max) extrema in chronological order per bucket
 * so narrow pulses, spikes, and ringing glitches are never dropped.
 */
export function decimateMinMaxSegment(
  t: Float64Array,
  readVal: SampleReader,
  segStart: number,
  segEnd: number,
  bucketCount: number
): DecimatedPoint[] {
  const len = segEnd - segStart;
  if (len <= 0) return [];
  if (len <= bucketCount * 2 || bucketCount < 2) {
    const out: DecimatedPoint[] = [];
    for (let i = segStart; i < segEnd; i++) {
      out.push({ time: t[i], value: readVal(i) });
    }
    return out;
  }

  const out: DecimatedPoint[] = [];
  const step = len / bucketCount;

  // Always include exact first sample
  out.push({ time: t[segStart], value: readVal(segStart) });

  for (let b = 0; b < bucketCount; b++) {
    const bStart = Math.floor(segStart + b * step);
    const bEnd = Math.min(segEnd, Math.floor(segStart + (b + 1) * step));
    if (bEnd <= bStart) continue;

    let minIdx = bStart;
    let maxIdx = bStart;
    let minVal = readVal(bStart);
    let maxVal = minVal;

    for (let i = bStart + 1; i < bEnd; i++) {
      const val = readVal(i);
      if (val < minVal) {
        minVal = val;
        minIdx = i;
      }
      if (val > maxVal) {
        maxVal = val;
        maxIdx = i;
      }
    }

    if (minIdx === maxIdx) {
      out.push({ time: t[minIdx], value: minVal });
    } else if (minIdx < maxIdx) {
      out.push({ time: t[minIdx], value: minVal });
      out.push({ time: t[maxIdx], value: maxVal });
    } else {
      out.push({ time: t[maxIdx], value: maxVal });
      out.push({ time: t[minIdx], value: minVal });
    }
  }

  // Always include exact last sample
  const lastIdx = segEnd - 1;
  if (out[out.length - 1].time !== t[lastIdx]) {
    out.push({ time: t[lastIdx], value: readVal(lastIdx) });
  }

  return out;
}

/**
 * Largest-Triangle-Three-Buckets (LTTB) decimation preserving visual curve geometry.
 */
export function decimateLttbSegment(
  t: Float64Array,
  readVal: SampleReader,
  segStart: number,
  segEnd: number,
  threshold: number
): DecimatedPoint[] {
  const len = segEnd - segStart;
  if (len <= 0) return [];
  if (threshold >= len || threshold <= 2) {
    const out: DecimatedPoint[] = [];
    for (let i = segStart; i < segEnd; i++) {
      out.push({ time: t[i], value: readVal(i) });
    }
    return out;
  }

  const sampled: DecimatedPoint[] = new Array(threshold);
  const every = (len - 2) / (threshold - 2);
  let a = segStart;
  sampled[0] = { time: t[a], value: readVal(a) };

  for (let i = 0; i < threshold - 2; i++) {
    // Average point in next bucket
    const avgStart = segStart + Math.floor((i + 1) * every) + 1;
    const avgEnd = Math.min(segEnd, segStart + Math.floor((i + 2) * every) + 1);

    let avgTime = 0;
    let avgVal = 0;
    const avgCount = Math.max(1, avgEnd - avgStart);
    for (let j = avgStart; j < avgEnd; j++) {
      avgTime += t[j];
      avgVal += readVal(j);
    }
    avgTime /= avgCount;
    avgVal /= avgCount;

    // Current bucket range
    const rangeStart = segStart + Math.floor(i * every) + 1;
    const rangeEnd = Math.min(segEnd - 1, segStart + Math.floor((i + 1) * every) + 1);

    const pointATime = t[a];
    const pointAVal = readVal(a);

    let maxArea = -1;
    let nextA = rangeStart;
    for (let j = rangeStart; j < rangeEnd; j++) {
      const area = Math.abs(
        (pointATime - avgTime) * (readVal(j) - pointAVal) -
          (pointATime - t[j]) * (avgVal - pointAVal)
      );
      if (area > maxArea) {
        maxArea = area;
        nextA = j;
      }
    }

    sampled[i + 1] = { time: t[nextA], value: readVal(nextA) };
    a = nextA;
  }

  sampled[threshold - 1] = { time: t[segEnd - 1], value: readVal(segEnd - 1) };
  return sampled;
}

/**
 * Produces gap-aware decimated polyline segments for rendering large datasets cleanly.
 */
export function buildDecimatedSegments(
  t: Float64Array,
  readVal: SampleReader,
  startIdx: number,
  endIdx: number,
  pixelWidth: number,
  mode: DecimationMode = 'minmax',
  gapThreshold: number = Infinity
): DecimatedPoint[][] {
  if (!t || t.length === 0 || endIdx <= startIdx) return [];
  const s = Math.max(0, startIdx);
  const e = Math.min(t.length, endIdx);
  const pointsInView = e - s;
  if (pointsInView <= 0) return [];

  const segments = splitContiguousSegments(t, readVal, s, e, gapThreshold);
  const targetWidth = Math.max(100, Math.round(pixelWidth));

  return segments.map((seg) => {
    const segLen = seg.end - seg.start;
    const segBudget = Math.max(8, Math.round((segLen / pointsInView) * targetWidth));

    if (pointsInView <= targetWidth * 2 && pointsInView <= 10000) {
      const pts: DecimatedPoint[] = [];
      for (let i = seg.start; i < seg.end; i++) {
        pts.push({ time: t[i], value: readVal(i) });
      }
      return pts;
    }

    if (mode === 'lttb') {
      return decimateLttbSegment(t, readVal, seg.start, seg.end, Math.min(segLen, segBudget * 2));
    }
    return decimateMinMaxSegment(t, readVal, seg.start, seg.end, segBudget);
  });
}

/**
 * Reconstructs smooth oscilloscope analog curve from sparse low-sample-rate points
 * using Centripetal Catmull-Rom / Lanczos-weighted spline (safe for both uniform and irregular dt).
 */
export function interpolateSmoothSegments(
  segments: DecimatedPoint[][],
  subStepsPerSpan: number = 8
): DecimatedPoint[][] {
  return segments.map((seg) => {
    const n = seg.length;
    if (n <= 2 || n > 600) return seg;

    const out: DecimatedPoint[] = [];
    for (let i = 0; i < n - 1; i++) {
      const p0 = seg[Math.max(0, i - 1)];
      const p1 = seg[i];
      const p2 = seg[i + 1];
      const p3 = seg[Math.min(n - 1, i + 2)];

      const dt1 = p2.time - p1.time;
      if (!(dt1 > 0) || !isFinite(dt1)) {
        out.push(p1);
        continue;
      }

      // Estimate derivatives at p1 and p2 via finite difference slopes (handles non-uniform spacing cleanly)
      const dt0 = i > 0 ? p1.time - p0.time : dt1;
      const dt2 = i + 2 < n ? p3.time - p2.time : dt1;

      const s1 = (p2.value - p1.value) / dt1;
      const m1 =
        i === 0
          ? s1
          : dt0 > 0
          ? ((p1.value - p0.value) / dt0 + s1) * 0.5
          : s1;
      const m2 =
        i + 1 === n - 1
          ? s1
          : dt2 > 0
          ? (s1 + (p3.value - p2.value) / dt2) * 0.5
          : s1;

      out.push(p1);
      for (let s = 1; s < subStepsPerSpan; s++) {
        const u = s / subStepsPerSpan;
        const u2 = u * u;
        const u3 = u2 * u;
        const h00 = 2 * u3 - 3 * u2 + 1;
        const h10 = u3 - 2 * u2 + u;
        const h01 = -2 * u3 + 3 * u2;
        const h11 = u3 - u2;
        const val = h00 * p1.value + h10 * dt1 * m1 + h01 * p2.value + h11 * dt1 * m2;
        out.push({
          time: p1.time + u * dt1,
          value: val,
        });
      }
    }
    out.push(seg[n - 1]);
    return out;
  });
}

// ---------------------------------------------------------------------------
// Viewport Decimation LRU Cache
// ---------------------------------------------------------------------------

export interface DecimationCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  maxEntries: number;
}

export interface CachedDecimationParams {
  channelId: string;
  traceKind: 'active' | 'ref' | 'diff';
  t: Float64Array;
  vPrimary: Float32Array;
  vSecondary?: Float32Array | null;
  dataVersion?: number;
  startIdx: number;
  endIdx: number;
  pixelWidth: number;
  mode: DecimationMode;
  gapThreshold: number;
  coupling?: string;
  inverted?: boolean;
  readVal: SampleReader;
}

const MAX_DECIMATION_CACHE_ENTRIES = 128;
const bufferIdentityMap = new WeakMap<ArrayBufferView, number>();
let nextBufferIdentityId = 1;

function getBufferIdentity(buf: ArrayBufferView | null | undefined): number {
  if (!buf) return 0;
  let id = bufferIdentityMap.get(buf);
  if (id === undefined) {
    id = nextBufferIdentityId++;
    bufferIdentityMap.set(buf, id);
  }
  return id;
}

function sampleSentinel(arr: Float32Array, startIdx: number, endIdx: number): string {
  const n = arr.length;
  if (n === 0) return '0';
  const i0 = Math.max(0, Math.min(n - 1, startIdx));
  const i2 = Math.max(0, Math.min(n - 1, endIdx - 1));
  const i1 = (i0 + i2) >> 1;
  const a = arr[i0];
  const b = arr[i1];
  const c = arr[i2];
  return `${Number.isNaN(a) ? 'N' : a}|${Number.isNaN(b) ? 'N' : b}|${Number.isNaN(c) ? 'N' : c}`;
}

const decimationLruCache = new Map<string, DecimatedPoint[][]>();
let decimationCacheHits = 0;
let decimationCacheMisses = 0;
let decimationCacheEvictions = 0;

/**
 * Computes or retrieves cached gap-aware decimated polyline segments.
 * Keyed by buffer object identities (WeakMap), explicit channel dataVersion,
 * O(1) boundary sentinel samples, viewport slice [startIdx, endIdx), pixel width,
 * decimation mode, gap threshold, and conditioning flags (coupling/inverted).
 */
export function getCachedDecimatedSegments(params: CachedDecimationParams): DecimatedPoint[][] {
  const {
    channelId,
    traceKind,
    t,
    vPrimary,
    vSecondary,
    dataVersion = 0,
    startIdx,
    endIdx,
    pixelWidth,
    mode,
    gapThreshold,
    coupling = 'DC',
    inverted = false,
    readVal,
  } = params;

  const targetWidth = Math.max(100, Math.round(pixelWidth));
  const gapKey = Number.isFinite(gapThreshold) ? gapThreshold.toPrecision(6) : 'inf';
  const cacheKey = [
    channelId,
    traceKind,
    getBufferIdentity(t),
    getBufferIdentity(vPrimary),
    getBufferIdentity(vSecondary),
    t.length,
    vPrimary.length,
    dataVersion,
    startIdx,
    endIdx,
    targetWidth,
    mode,
    gapKey,
    coupling,
    inverted ? 1 : 0,
    sampleSentinel(vPrimary, startIdx, endIdx),
  ].join('|');

  const cached = decimationLruCache.get(cacheKey);
  if (cached !== undefined) {
    // Refresh LRU recency
    decimationLruCache.delete(cacheKey);
    decimationLruCache.set(cacheKey, cached);
    decimationCacheHits++;
    return cached;
  }

  decimationCacheMisses++;
  const segments = buildDecimatedSegments(
    t,
    readVal,
    startIdx,
    endIdx,
    targetWidth,
    mode,
    gapThreshold
  );

  if (decimationLruCache.size >= MAX_DECIMATION_CACHE_ENTRIES) {
    const oldestKey = decimationLruCache.keys().next().value;
    if (oldestKey !== undefined) {
      decimationLruCache.delete(oldestKey);
      decimationCacheEvictions++;
    }
  }
  decimationLruCache.set(cacheKey, segments);
  return segments;
}

export function getDecimationCacheStats(): DecimationCacheStats {
  return {
    hits: decimationCacheHits,
    misses: decimationCacheMisses,
    evictions: decimationCacheEvictions,
    size: decimationLruCache.size,
    maxEntries: MAX_DECIMATION_CACHE_ENTRIES,
  };
}

export function resetDecimationCache(): void {
  decimationLruCache.clear();
  decimationCacheHits = 0;
  decimationCacheMisses = 0;
  decimationCacheEvictions = 0;
}


