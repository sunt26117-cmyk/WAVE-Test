/**
 * Waveform Viewer Pro - XY (Lissajous) Trajectory Metrics
 */

import { WaveformChannel } from '../types/models';
import { alignChannelsToCommonTimebase, validateChannelIntegrity } from './timeSync';

export type XYStatus = 'OK' | 'INVALID' | 'INSUFFICIENT_DATA';

export interface XYMetrics {
  valid: boolean;
  status: XYStatus;
  invalidReason: string | null;
  sampleCount: number;
  invalidCount: number;
  coveragePct: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  circularityPct: number | null;
  lissajousPhaseDeg: number | null;
}

export interface XYAlignedResult {
  metrics: XYMetrics;
  time: Float64Array;
  xValues: Float32Array;
  yValues: Float32Array;
}

function makeInvalidXY(
  status: 'INVALID' | 'INSUFFICIENT_DATA',
  invalidReason: string
): XYAlignedResult {
  return {
    metrics: {
      valid: false,
      status,
      invalidReason,
      sampleCount: 0,
      invalidCount: 0,
      coveragePct: 0,
      xMin: -1,
      xMax: 1,
      yMin: -1,
      yMax: 1,
      circularityPct: null,
      lissajousPhaseDeg: null,
    },
    time: new Float64Array(0),
    xValues: new Float32Array(0),
    yValues: new Float32Array(0),
  };
}

export function computeXYAlignedTrajectory(
  xCh: WaveformChannel,
  yCh: WaveformChannel,
  tStart?: number,
  tEnd?: number
): XYAlignedResult {
  const xCheck = validateChannelIntegrity(xCh, 2);
  if (!xCheck.valid) {
    return makeInvalidXY('INVALID', xCheck.invalidReason || 'X 通道时间轴或数组无效。');
  }
  const yCheck = validateChannelIntegrity(yCh, 2);
  if (!yCheck.valid) {
    return makeInvalidXY('INVALID', yCheck.invalidReason || 'Y 通道时间轴或数组无效。');
  }

  const synced = alignChannelsToCommonTimebase([xCh, yCh], tStart, tEnd, {
    allowPartialNaNs: true,
  });
  if (!synced.valid || synced.time.length < 2) {
    return makeInvalidXY(
      'INSUFFICIENT_DATA',
      synced.invalidReason || 'XY 通道在所选窗口内无有效公共时间重叠。'
    );
  }

  const xValues = synced.values[0];
  const yValues = synced.values[1];
  const totalPts = synced.time.length;

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let validCount = 0;
  let invalidCount = 0;
  let sumX = 0;
  let sumY = 0;

  for (let i = 0; i < totalPts; i++) {
    const xv = xValues[i];
    const yv = yValues[i];
    if (!Number.isFinite(xv) || !Number.isFinite(yv)) {
      invalidCount++;
      continue;
    }
    if (xv < xMin) xMin = xv;
    if (xv > xMax) xMax = xv;
    if (yv < yMin) yMin = yv;
    if (yv > yMax) yMax = yv;
    sumX += xv;
    sumY += yv;
    validCount++;
  }

  const coveragePct = totalPts > 0 ? (validCount / totalPts) * 100 : 0;
  if (validCount < 2 || !Number.isFinite(xMin) || !Number.isFinite(yMin)) {
    return makeInvalidXY('INSUFFICIENT_DATA', '公共时间轴对齐后有效配对样本数不足 (< 2)。');
  }

  const xSpan = xMax - xMin;
  const ySpan = yMax - yMin;
  const circularityPct =
    xSpan > 1e-12 && ySpan > 1e-12
      ? (Math.min(xSpan, ySpan) / Math.max(xSpan, ySpan)) * 100
      : null;

  // Signed Lissajous phase in [-180, +180] deg:
  // |phase| from Pearson correlation r = cos(phi); sign from oriented Shoelace area (CCW positive)
  let lissajousPhaseDeg: number | null = null;
  if (xSpan > 1e-12 && ySpan > 1e-12 && validCount >= 4) {
    const mx = sumX / validCount;
    const my = sumY / validCount;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    let signedArea2 = 0;
    let prevValid = false;
    let prevCx = 0;
    let prevCy = 0;

    for (let i = 0; i < totalPts; i++) {
      const xv = xValues[i];
      const yv = yValues[i];
      if (!Number.isFinite(xv) || !Number.isFinite(yv)) {
        prevValid = false;
        continue;
      }
      const cx = xv - mx;
      const cy = yv - my;
      sxx += cx * cx;
      syy += cy * cy;
      sxy += cx * cy;
      if (prevValid) {
        signedArea2 += prevCx * cy - cx * prevCy;
      }
      prevCx = cx;
      prevCy = cy;
      prevValid = true;
    }

    const denom = Math.sqrt(sxx * syy);
    if (denom > 1e-18) {
      const r = Math.max(-1, Math.min(1, sxy / denom));
      const magDeg = (Math.acos(r) * 180) / Math.PI;
      if (magDeg < 0.5 || magDeg > 179.5) {
        lissajousPhaseDeg = magDeg;
      } else {
        lissajousPhaseDeg = signedArea2 >= 0 ? magDeg : -magDeg;
      }
    }
  }

  return {
    metrics: {
      valid: true,
      status: 'OK',
      invalidReason: null,
      sampleCount: validCount,
      invalidCount,
      coveragePct,
      xMin,
      xMax,
      yMin,
      yMax,
      circularityPct,
      lissajousPhaseDeg,
    },
    time: synced.time,
    xValues,
    yValues,
  };
}

export function computeXYMetrics(
  xCh: WaveformChannel,
  yCh: WaveformChannel,
  iStart: number,
  iEnd: number
): XYMetrics {
  const xCheck = validateChannelIntegrity(xCh, 2);
  if (!xCheck.valid) {
    return makeInvalidXY('INVALID', xCheck.invalidReason || 'X 通道时间轴或数组无效。').metrics;
  }
  const yCheck = validateChannelIntegrity(yCh, 2);
  if (!yCheck.valid) {
    return makeInvalidXY('INVALID', yCheck.invalidReason || 'Y 通道时间轴或数组无效。').metrics;
  }

  const nx = xCh.t.length;
  const fullRange = iStart <= 0 && iEnd >= Math.min(xCh.t.length, yCh.t.length);
  let tStart: number | undefined;
  let tEnd: number | undefined;
  if (!fullRange) {
    const s = Math.max(0, Math.min(nx - 1, iStart));
    const e = Math.max(s + 1, Math.min(nx, iEnd));
    tStart = xCh.t[s];
    tEnd = xCh.t[e - 1];
    if (!(tEnd > tStart)) {
      return makeInvalidXY('INSUFFICIENT_DATA', '所选 XY 索引范围没有有效时间跨度。').metrics;
    }
  }

  return computeXYAlignedTrajectory(xCh, yCh, tStart, tEnd).metrics;
}
