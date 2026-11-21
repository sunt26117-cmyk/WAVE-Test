/**
 * Waveform Viewer Pro - Automated Anomaly Scanner & Golden Reference Tolerance Evaluator
 */

import { AnomalyEvent, GoldenBandConfig, WaveformChannel } from '../types/models';
import { computeChannelMean, getChannelDisplayValue } from './oscilloscopeScale';

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
 */
export function scanChannelAnomalies(
  ch: WaveformChannel,
  opts: AnomalyScanOptions
): AnomalyEvent[] {
  const n = Math.min(ch.t.length, ch.v.length);
  if (n < 2) return [];

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
  let lastEdgeTime = ch.t[0];
  let prevAboveMid = getChannelDisplayValue(ch, 0, mean) >= midLevel;
  let gapReportedForSpan = false;

  for (let i = 0; i < n; i++) {
    const val = getChannelDisplayValue(ch, i, mean);
    const tVal = ch.t[i];
    if (!isFinite(val) || !isFinite(tVal)) continue;

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

    // 3. Fast dv/dt Glitch
    if (hasDvDt && i > 0) {
      const prevVal = getChannelDisplayValue(ch, i - 1, mean);
      const dt = tVal - ch.t[i - 1];
      if (isFinite(prevVal) && dt > 0) {
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

    // 4. Edge Dropout / Stall
    if (hasGap) {
      const above = val >= midLevel;
      if (above !== prevAboveMid) {
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
  }

  // Flush trailing active regions
  if (inHigh && events.length < maxResults) {
    events.push({
      index: highPeakIdx,
      time: ch.t[highPeakIdx],
      value: highPeakVal,
      kind: 'over',
      detail: `>${opts.highThreshold!.toPrecision(4)} ${ch.unit} (Peak ${highPeakVal.toPrecision(4)})`,
    });
  }
  if (inLow && events.length < maxResults) {
    events.push({
      index: lowPeakIdx,
      time: ch.t[lowPeakIdx],
      value: lowPeakVal,
      kind: 'under',
      detail: `<${opts.lowThreshold!.toPrecision(4)} ${ch.unit} (Min ${lowPeakVal.toPrecision(4)})`,
    });
  }

  events.sort((a, b) => a.time - b.time);
  return events.slice(0, maxResults);
}

export interface GoldenEvaluationResult {
  pass: boolean;
  violationCount: number;
  totalCompared: number;
  maxDeviation: number;
  bandHalfWidth: number;
  violationIndices: number[]; // Sample indices (capped for fast rendering)
}

/**
 * Evaluates a target channel against a Golden Reference tolerance envelope.
 * Supports percent of reference Vpp (e.g. 5%) or absolute voltage band (e.g. 0.5V).
 */
export function evaluateGoldenTolerance(
  ch: WaveformChannel,
  cfg: GoldenBandConfig
): GoldenEvaluationResult {
  const refV = cfg.refV || ch.refV || ch.v;
  const n = Math.min(ch.v.length, refV.length);
  if (n === 0) {
    return {
      pass: true,
      violationCount: 0,
      totalCompared: 0,
      maxDeviation: 0,
      bandHalfWidth: 0,
      violationIndices: [],
    };
  }

  let refMin = Infinity;
  let refMax = -Infinity;
  const step = n > 100000 ? Math.floor(n / 40000) : 1;
  for (let i = 0; i < n; i += step) {
    const rv = refV[i];
    if (isFinite(rv)) {
      if (rv < refMin) refMin = rv;
      if (rv > refMax) refMax = rv;
    }
  }
  const refSpan = isFinite(refMax - refMin) && refMax - refMin > 1e-9 ? refMax - refMin : 1.0;

  const halfWidth =
    cfg.mode === 'percent'
      ? (Math.max(0.01, cfg.tolerance) / 100) * refSpan
      : Math.max(1e-9, cfg.tolerance);

  const mean = ch.coupling === 'AC' ? computeChannelMean(ch) : 0;
  let violationCount = 0;
  let maxDeviation = 0;
  const violationIndices: number[] = [];

  for (let i = 0; i < n; i++) {
    const val = getChannelDisplayValue(ch, i, mean);
    const rVal = refV[i];
    if (!isFinite(val) || !isFinite(rVal)) continue;

    const dev = Math.abs(val - rVal);
    if (dev > maxDeviation) maxDeviation = dev;

    if (dev > halfWidth) {
      violationCount++;
      if (violationIndices.length < 2500) {
        violationIndices.push(i);
      }
    }
  }

  return {
    pass: violationCount === 0,
    violationCount,
    totalCompared: n,
    maxDeviation,
    bandHalfWidth: halfWidth,
    violationIndices,
  };
}
