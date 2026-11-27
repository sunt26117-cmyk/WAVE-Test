/**
 * Waveform Viewer Pro - Automated Anomaly Scanner & Golden Reference Tolerance Evaluator
 */

import { AnomalyEvent, GoldenBandConfig, WaveformChannel } from '../types/models';
import { computeChannelMean, getChannelDisplayValue } from './oscilloscopeScale';
import { computeTemporalCoverage } from './temporalCompare';
import {
  areTimebasesSynchronized,
  DEFAULT_SAMPLING_GAP_FACTOR,
  inspectTimebase,
  resolveUnitPairCompatibility,
  sampleSeriesAtTimeStrict,
  validateChannelIntegrity,
} from './timeSync';

export interface AnomalyScanOptions {
  highThreshold?: number | null;
  lowThreshold?: number | null;
  minDvDt?: number | null; // V/s threshold
  maxEdgeGapSec?: number | null; // missing transition timeout
  maxResults?: number;
}

/**
 * Scans a waveform channel for threshold violations (overshoot, sag/undervoltage),
 * steep dv/dt glitches, and edge-dropout timeouts. Clusters adjacent samples into discrete events.
 * Fails closed (returns []) when channel t/v lengths mismatch or timebase is non-monotonic.
 */
export function scanChannelAnomalies(
  ch: WaveformChannel,
  opts: AnomalyScanOptions
): AnomalyEvent[] {
  const integrity = validateChannelIntegrity(ch, 2, DEFAULT_SAMPLING_GAP_FACTOR);
  if (!integrity.valid) return [];

  const n = ch.t.length;
  const gapThreshold = integrity.timebase.gapThresholdSec;
  const maxResults = opts.maxResults ?? 250;
  const events: AnomalyEvent[] = [];
  const mean = ch.coupling === 'AC' ? computeChannelMean(ch) : 0;

  const hasHigh = opts.highThreshold !== null && opts.highThreshold !== undefined && isFinite(opts.highThreshold);
  const hasLow = opts.lowThreshold !== null && opts.lowThreshold !== undefined && isFinite(opts.lowThreshold);
  const hasDvDt = opts.minDvDt !== null && opts.minDvDt !== undefined && isFinite(opts.minDvDt) && opts.minDvDt > 0;
  const hasGap =
    opts.maxEdgeGapSec !== null &&
    opts.maxEdgeGapSec !== undefined &&
    isFinite(opts.maxEdgeGapSec) &&
    opts.maxEdgeGapSec > 0;

  // Estimate midpoint for edge-gap detection if requested
  let midLevel = 0;
  if (hasGap) {
    let mn = Infinity;
    let mx = -Infinity;
    const step = Math.max(1, Math.floor(n / 10000));
    for (let i = 0; i < n; i += step) {
      const val = getChannelDisplayValue(ch, i, mean);
      if (isFinite(val)) {
        if (val < mn) mn = val;
        if (val > mx) mx = val;
      }
    }
    midLevel = isFinite(mn) && isFinite(mx) ? (mn + mx) / 2 : 0;
  }

  let inHigh = false;
  let highPeakIdx = -1;
  let highPeakVal = -Infinity;

  let inLow = false;
  let lowPeakIdx = -1;
  let lowPeakVal = Infinity;

  let lastDvDtIdx = -100;
  let hasPrevValid = false;
  let prevIdx = -1;
  let prevVal = Number.NaN;
  let lastEdgeTime = ch.t[0];
  let prevAboveMid = false;
  let gapReportedForSpan = false;

  const flushActiveClusters = () => {
    if (inHigh && events.length < maxResults) {
      events.push({
        index: highPeakIdx,
        time: ch.t[highPeakIdx],
        value: highPeakVal,
        kind: 'over',
        detail: `>${opts.highThreshold!.toPrecision(4)} ${ch.unit} (Peak ${highPeakVal.toPrecision(4)})`,
      });
    }
    inHigh = false;
    if (inLow && events.length < maxResults) {
      events.push({
        index: lowPeakIdx,
        time: ch.t[lowPeakIdx],
        value: lowPeakVal,
        kind: 'under',
        detail: `<${opts.lowThreshold!.toPrecision(4)} ${ch.unit} (Min ${lowPeakVal.toPrecision(4)})`,
      });
    }
    inLow = false;
  };

  for (let i = 0; i < n; i++) {
    const val = getChannelDisplayValue(ch, i, mean);
    const tVal = ch.t[i];
    if (!isFinite(val) || !isFinite(tVal)) {
      flushActiveClusters();
      hasPrevValid = false;
      if (events.length >= maxResults) break;
      continue;
    }

    const crossedGap =
      hasPrevValid &&
      Number.isFinite(gapThreshold) &&
      tVal - ch.t[prevIdx] > gapThreshold;

    if (crossedGap) {
      flushActiveClusters();
      if (events.length >= maxResults) break;
      // Reset continuity across sampling gap so dv/dt and edge-gap do not bridge missing time
      hasPrevValid = false;
    }

    // 1. High Threshold Clustering
    if (hasHigh) {
      const hi = opts.highThreshold!;
      if (val > hi) {
        if (!inHigh) {
          inHigh = true;
          highPeakIdx = i;
          highPeakVal = val;
        } else if (val > highPeakVal) {
          highPeakVal = val;
          highPeakIdx = i;
        }
      } else if (inHigh) {
        events.push({
          index: highPeakIdx,
          time: ch.t[highPeakIdx],
          value: highPeakVal,
          kind: 'over',
          detail: `>${hi.toPrecision(4)} ${ch.unit} (Peak ${highPeakVal.toPrecision(4)})`,
        });
        inHigh = false;
        if (events.length >= maxResults) break;
      }
    }

    // 2. Low Threshold Clustering
    if (hasLow) {
      const lo = opts.lowThreshold!;
      if (val < lo) {
        if (!inLow) {
          inLow = true;
          lowPeakIdx = i;
          lowPeakVal = val;
        } else if (val < lowPeakVal) {
          lowPeakVal = val;
          lowPeakIdx = i;
        }
      } else if (inLow) {
        events.push({
          index: lowPeakIdx,
          time: ch.t[lowPeakIdx],
          value: lowPeakVal,
          kind: 'under',
          detail: `<${lo.toPrecision(4)} ${ch.unit} (Min ${lowPeakVal.toPrecision(4)})`,
        });
        inLow = false;
        if (events.length >= maxResults) break;
      }
    }

    // 3. Fast dv/dt Glitch (only on contiguous finite samples without sampling gaps)
    if (hasDvDt && hasPrevValid && prevIdx === i - 1) {
      const dt = tVal - ch.t[prevIdx];
      if (dt > 0) {
        const slope = Math.abs((val - prevVal) / dt);
        if (slope >= opts.minDvDt! && i - lastDvDtIdx > 8) {
          events.push({
            index: i,
            time: tVal,
            value: val,
            kind: 'dvdt',
            detail: `|dv/dt|=${slope.toExponential(2)} ${ch.unit}/s`,
          });
          lastDvDtIdx = i;
          if (events.length >= maxResults) break;
        }
      }
    }

    // 4. Edge Dropout / Stall (segmented across NaNs and sampling gaps)
    if (hasGap) {
      const above = val >= midLevel;
      if (!hasPrevValid) {
        lastEdgeTime = tVal;
        prevAboveMid = above;
        gapReportedForSpan = false;
      } else if (above !== prevAboveMid) {
        lastEdgeTime = tVal;
        prevAboveMid = above;
        gapReportedForSpan = false;
      } else if (!gapReportedForSpan && tVal - lastEdgeTime > opts.maxEdgeGapSec!) {
        events.push({
          index: i,
          time: tVal,
          value: val,
          kind: 'edge-gap',
          detail: `No edge for >${opts.maxEdgeGapSec!.toExponential(2)} s`,
        });
        gapReportedForSpan = true;
        if (events.length >= maxResults) break;
      }
    }

    hasPrevValid = true;
    prevIdx = i;
    prevVal = val;
  }

  flushActiveClusters();

  events.sort((a, b) => a.time - b.time);
  return events.slice(0, maxResults);
}

export type GoldenStatus = 'PASS' | 'FAIL' | 'INVALID' | 'INSUFFICIENT_DATA';

export interface GoldenEvaluationResult {
  pass: boolean;
  status: GoldenStatus;
  invalidReason: string | null;
  violationCount: number;
  totalCompared: number;
  totalTargetSamples: number;
  invalidCount: number;
  coveragePct: number;
  maxDeviation: number;
  bandHalfWidth: number;
  violationIndices: number[]; // Sample indices (capped for fast rendering)
  alignedRefV?: Float32Array;
}

/**
 * Evaluates a target channel against a Golden Reference tolerance envelope.
 * Supports percent of reference Vpp (e.g. 5%) or absolute voltage band (e.g. 0.5V),
 * refT time-axis alignment, SI prefix scaling, and strict fail-closed status reporting.
 */
export function evaluateGoldenTolerance(
  ch: WaveformChannel,
  cfg: GoldenBandConfig
): GoldenEvaluationResult {
  const chCheck = validateChannelIntegrity(ch, 1, DEFAULT_SAMPLING_GAP_FACTOR);
  if (!chCheck.valid) {
    const nRaw = ch?.v?.length || 0;
    return {
      pass: false,
      status: 'INVALID',
      invalidReason: chCheck.invalidReason || '目标通道时间轴或数组无效。',
      violationCount: 0,
      totalCompared: 0,
      totalTargetSamples: nRaw,
      invalidCount: nRaw,
      coveragePct: 0,
      maxDeviation: Number.NaN,
      bandHalfWidth: Number.NaN,
      violationIndices: [],
    };
  }

  const n = ch.t.length;
  const rawRefV = cfg.refV || ch.refV || ch.v;
  const rawRefT = cfg.refT;

  if (!rawRefV || rawRefV.length === 0) {
    return {
      pass: false,
      status: 'INSUFFICIENT_DATA',
      invalidReason: 'Golden 参考波形为空，无法完成容差判定。',
      violationCount: 0,
      totalCompared: 0,
      totalTargetSamples: n,
      invalidCount: n,
      coveragePct: 0,
      maxDeviation: Number.NaN,
      bandHalfWidth: Number.NaN,
      violationIndices: [],
    };
  }

  const unitCompat = resolveUnitPairCompatibility(ch.unit, cfg.refUnit);
  if (!unitCompat.compatible) {
    return {
      pass: false,
      status: 'INVALID',
      invalidReason: unitCompat.reason,
      violationCount: 0,
      totalCompared: 0,
      totalTargetSamples: n,
      invalidCount: n,
      coveragePct: 0,
      maxDeviation: Number.NaN,
      bandHalfWidth: Number.NaN,
      violationIndices: [],
    };
  }
  const unitScale = unitCompat.scaleBToA;

  const alignedRefV = new Float32Array(n);
  alignedRefV.fill(Number.NaN);

  if (rawRefT) {
    if (rawRefT.length !== rawRefV.length) {
      return {
        pass: false,
        status: 'INVALID',
        invalidReason: `Golden 参考时间轴 (${rawRefT.length}) 与参考幅值 (${rawRefV.length}) 长度不一致。`,
        violationCount: 0,
        totalCompared: 0,
        totalTargetSamples: n,
        invalidCount: n,
        coveragePct: 0,
        maxDeviation: Number.NaN,
        bandHalfWidth: Number.NaN,
        violationIndices: [],
      };
    }
    const refTb = inspectTimebase(rawRefT, 0, rawRefT.length - 1, DEFAULT_SAMPLING_GAP_FACTOR);
    if (!refTb.monotonic) {
      return {
        pass: false,
        status: 'INVALID',
        invalidReason: `Golden 参考时间轴在索引 ${refTb.nonMonotonicIndex ?? '?'} 处存在非单调、重复或 NaN/Inf 时间戳。`,
        violationCount: 0,
        totalCompared: 0,
        totalTargetSamples: n,
        invalidCount: n,
        coveragePct: 0,
        maxDeviation: Number.NaN,
        bandHalfWidth: Number.NaN,
        violationIndices: [],
      };
    }

    if (areTimebasesSynchronized(ch.t, rawRefT)) {
      for (let i = 0; i < n; i++) {
        const rv = rawRefV[i];
        alignedRefV[i] = Number.isFinite(rv) ? rv * unitScale : Number.NaN;
      }
    } else {
      const refProxyCh: WaveformChannel = {
        ...ch,
        t: rawRefT,
        v: rawRefV,
        coupling: 'DC',
        inverted: false,
      };
      for (let i = 0; i < n; i++) {
        const res = sampleSeriesAtTimeStrict(rawRefT, refProxyCh, ch.t[i], 0, refTb.gapThresholdSec);
        alignedRefV[i] = Number.isFinite(res.value) ? res.value * unitScale : Number.NaN;
      }
    }
  } else {
    if (rawRefV.length !== n) {
      return {
        pass: false,
        status: 'INVALID',
        invalidReason: `Golden 参考长度 (${rawRefV.length}) 与目标通道 (${n}) 不一致且未提供参考时间轴 refT，已拒绝按索引错位截断。`,
        violationCount: 0,
        totalCompared: 0,
        totalTargetSamples: n,
        invalidCount: n,
        coveragePct: 0,
        maxDeviation: Number.NaN,
        bandHalfWidth: Number.NaN,
        violationIndices: [],
      };
    }
    for (let i = 0; i < n; i++) {
      const rv = rawRefV[i];
      alignedRefV[i] = Number.isFinite(rv) ? rv * unitScale : Number.NaN;
    }
  }

  const rangeReference = cfg.metricRefV && cfg.metricRefV.length >= 2 ? cfg.metricRefV : alignedRefV;
  let refMin = Infinity;
  let refMax = -Infinity;
  // Vpp defines the percent band; scan every knot so a narrow peak cannot be skipped.
  for (let i = 0; i < rangeReference.length; i++) {
    const rv = rangeReference[i];
    if (Number.isFinite(rv)) {
      if (rv < refMin) refMin = rv;
      if (rv > refMax) refMax = rv;
    }
  }
  if (!Number.isFinite(refMin) || !Number.isFinite(refMax)) {
    for (let i = 0; i < rangeReference.length; i++) {
      const rv = rangeReference[i];
      if (Number.isFinite(rv)) {
        if (rv < refMin) refMin = rv;
        if (rv > refMax) refMax = rv;
      }
    }
  }
  const refSpan = Number.isFinite(refMax - refMin) && refMax - refMin > 1e-9 ? refMax - refMin : 1.0;

  const halfWidth =
    cfg.mode === 'percent'
      ? (Math.max(0.01, cfg.tolerance) / 100) * refSpan
      : Math.max(1e-9, cfg.tolerance);

  const minCoveragePct =
    cfg.minCoveragePct !== undefined && Number.isFinite(cfg.minCoveragePct)
      ? Math.max(0, Math.min(100, cfg.minCoveragePct))
      : 80;
  const metricT = cfg.metricT;
  const metricTargetV = cfg.metricTargetV;
  const metricRefV = cfg.metricRefV;
  const metricIntervalValid = cfg.metricIntervalValid;
  if (metricT && metricTargetV && metricRefV && metricIntervalValid &&
      metricT.length >= 2 && metricTargetV.length === metricT.length &&
      metricRefV.length === metricT.length && metricIntervalValid.length === metricT.length - 1) {
    const metricUsed = new Uint8Array(metricT.length);
    const validIntervals: number[] = [];
    let coveredDurationSec = 0;
    for (let i = 0; i < metricIntervalValid.length; i++) {
      const dt = metricT[i + 1] - metricT[i];
      if (!metricIntervalValid[i] || !(dt > 0) ||
          !Number.isFinite(metricTargetV[i]) || !Number.isFinite(metricTargetV[i + 1]) ||
          !Number.isFinite(metricRefV[i]) || !Number.isFinite(metricRefV[i + 1])) continue;
      validIntervals.push(i);
      coveredDurationSec += dt;
      metricUsed[i] = 1;
      metricUsed[i + 1] = 1;
    }
    const targetDurationSec = ch.t.length >= 2 ? Math.max(0, ch.t[ch.t.length - 1] - ch.t[0]) : 0;
    const coveragePct = targetDurationSec > 0 ? Math.max(0, Math.min(100, coveredDurationSec / targetDurationSec * 100)) : 0;
    let meanTarget = 0, meanReference = 0;
    if (cfg.removeDcOffset && coveredDurationSec > 0) {
      let targetIntegral = 0, referenceIntegral = 0;
      for (const i of validIntervals) {
        const dt = metricT[i + 1] - metricT[i];
        targetIntegral += dt * (metricTargetV[i] + metricTargetV[i + 1]) / 2;
        referenceIntegral += dt * (metricRefV[i] + metricRefV[i + 1]) / 2;
      }
      meanTarget = targetIntegral / coveredDurationSec;
      meanReference = referenceIntegral / coveredDurationSec;
    }
    const goldenRefShift = cfg.removeDcOffset ? meanTarget - meanReference : 0;
    let totalCompared = 0, violationCount = 0, maxDeviation = 0;
    const violationIndices: number[] = [];
    const violationTargetIndices = new Set<number>();
    const nearestTargetIndex = (time: number): number => {
      let lo = 0, hi = ch.t.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (ch.t[mid] < time) lo = mid + 1;
        else hi = mid;
      }
      if (lo <= 0) return 0;
      if (lo >= ch.t.length) return ch.t.length - 1;
      return Math.abs(ch.t[lo] - time) < Math.abs(ch.t[lo - 1] - time) ? lo : lo - 1;
    };
    for (let i = 0; i < metricT.length; i++) {
      if (!metricUsed[i]) continue;
      totalCompared++;
      const deviation = Math.abs(metricTargetV[i] - (metricRefV[i] + goldenRefShift));
      if (deviation > maxDeviation) maxDeviation = deviation;
      if (deviation > halfWidth) {
        violationCount++;
        if (violationTargetIndices.size < 2500) violationTargetIndices.add(nearestTargetIndex(metricT[i]));
      }
    }
    violationIndices.push(...violationTargetIndices);
    if (coveredDurationSec <= 0 || totalCompared < 2) {
      return {
        pass: false, status: 'INSUFFICIENT_DATA',
        invalidReason: '无连续有效可比时间区间（仅孤立点或区间跨越采样缺口）。',
        violationCount: 0, totalCompared: 0, totalTargetSamples: n,
        invalidCount: metricT.length, coveragePct: 0, maxDeviation: Number.NaN,
        bandHalfWidth: halfWidth, violationIndices: [], alignedRefV,
      };
    }
    if (coveragePct < minCoveragePct) {
      return {
        pass: false, status: 'INSUFFICIENT_DATA',
        invalidReason: `按有效时间区间计算的覆盖率为 ${coveragePct.toFixed(1)}%，低于最低要求 ${minCoveragePct.toFixed(0)}%，禁止判定 PASS。`,
        violationCount, totalCompared, totalTargetSamples: n,
        invalidCount: metricT.length - totalCompared, coveragePct, maxDeviation,
        bandHalfWidth: halfWidth, violationIndices, alignedRefV,
      };
    }
    const status: GoldenStatus = violationCount === 0 ? 'PASS' : 'FAIL';
    return {
      pass: status === 'PASS', status, invalidReason: null,
      violationCount, totalCompared, totalTargetSamples: n,
      invalidCount: metricT.length - totalCompared, coveragePct, maxDeviation,
      bandHalfWidth: halfWidth, violationIndices, alignedRefV,
    };
  }

  const mean = ch.coupling === 'AC' ? computeChannelMean(ch) : 0;
  const validMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const val = getChannelDisplayValue(ch, i, mean);
    validMask[i] = Number.isFinite(val) && Number.isFinite(alignedRefV[i]) ? 1 : 0;
  }
  const temporalCoverage = computeTemporalCoverage(
    ch.t,
    validMask,
    chCheck.timebase.gapThresholdSec
  );
  let violationCount = 0;
  let totalCompared = 0;
  let invalidCount = 0;
  let maxDeviation = 0;
  const violationIndices: number[] = [];

  for (let i = 0; i < n; i++) {
    if (!temporalCoverage.coveredSampleMask[i]) continue;
    const val = getChannelDisplayValue(ch, i, mean);
    const rVal = alignedRefV[i];
    if (!Number.isFinite(val) || !Number.isFinite(rVal)) {
      invalidCount++;
      continue;
    }

    totalCompared++;
    const dev = Math.abs(val - rVal);
    if (dev > maxDeviation) maxDeviation = dev;
    if (dev > halfWidth) {
      violationCount++;
      if (violationIndices.length < 2500) violationIndices.push(i);
    }
  }
  invalidCount = n - totalCompared;
  const coveragePct = temporalCoverage.coveragePct;
  if (temporalCoverage.coveredDurationSec <= 0 || totalCompared < 2) {
    return {
      pass: false,
      status: 'INSUFFICIENT_DATA',
      invalidReason: '无连续有效可比时间区间（仅孤立采样点、全为 NaN/Inf 或区间跨越采样缺口）。',
      violationCount: 0,
      totalCompared: 0,
      totalTargetSamples: n,
      invalidCount,
      coveragePct: 0,
      maxDeviation: Number.NaN,
      bandHalfWidth: halfWidth,
      violationIndices: [],
      alignedRefV,
    };
  }

  if (coveragePct < minCoveragePct) {
    return {
      pass: false,
      status: 'INSUFFICIENT_DATA',
      invalidReason: `按时间跨度计算的有效覆盖率仅 ${coveragePct.toFixed(1)}%，低于最低要求 ${minCoveragePct.toFixed(0)}%，禁止直接判定 PASS。`,
      violationCount,
      totalCompared,
      totalTargetSamples: n,
      invalidCount,
      coveragePct,
      maxDeviation,
      bandHalfWidth: halfWidth,
      violationIndices,
      alignedRefV,
    };
  }

  const status: GoldenStatus = violationCount === 0 ? 'PASS' : 'FAIL';
  return {
    pass: status === 'PASS',
    status,
    invalidReason: null,
    violationCount,
    totalCompared,
    totalTargetSamples: n,
    invalidCount,
    coveragePct,
    maxDeviation,
    bandHalfWidth: halfWidth,
    violationIndices,
    alignedRefV,
  };
}
