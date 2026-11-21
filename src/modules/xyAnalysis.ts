/**
 * Waveform Viewer Pro - XY (Lissajous) Trajectory Metrics
 */

import { WaveformChannel } from '../types/models';
import { computeChannelMean, getChannelDisplayValue } from './oscilloscopeScale';

export interface XYMetrics {
  sampleCount: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  circularityPct: number | null;
  lissajousPhaseDeg: number | null;
}

export function computeXYMetrics(
  xCh: WaveformChannel,
  yCh: WaveformChannel,
  iStart: number,
  iEnd: number
): XYMetrics {
  const n = Math.min(xCh.v.length, yCh.v.length);
  const s = Math.max(0, Math.min(n - 1, iStart));
  const e = Math.max(s + 1, Math.min(n, iEnd));

  if (n < 2 || e <= s) {
    return {
      sampleCount: 0,
      xMin: -1,
      xMax: 1,
      yMin: -1,
      yMax: 1,
      circularityPct: null,
      lissajousPhaseDeg: null,
    };
  }

  const xMean = xCh.coupling === 'AC' ? computeChannelMean(xCh) : 0;
  const yMean = yCh.coupling === 'AC' ? computeChannelMean(yCh) : 0;

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let cnt = 0;

  const stride = e - s > 60000 ? Math.ceil((e - s) / 60000) : 1;
  for (let i = s; i < e; i += stride) {
    const xv = getChannelDisplayValue(xCh, i, xMean);
    const yv = getChannelDisplayValue(yCh, i, yMean);
    if (!isFinite(xv) || !isFinite(yv)) continue;
    if (xv < xMin) xMin = xv;
    if (xv > xMax) xMax = xv;
    if (yv < yMin) yMin = yv;
    if (yv > yMax) yMax = yv;
    cnt++;
  }

  if (cnt < 2 || !isFinite(xMin) || !isFinite(yMin)) {
    return {
      sampleCount: 0,
      xMin: -1,
      xMax: 1,
      yMin: -1,
      yMax: 1,
      circularityPct: null,
      lissajousPhaseDeg: null,
    };
  }

  const xSpan = xMax - xMin;
  const ySpan = yMax - yMin;
  const xCenter = (xMax + xMin) / 2;
  const yCenter = (yMax + yMin) / 2;

  const circularityPct =
    xSpan > 1e-12 && ySpan > 1e-12
      ? (Math.min(xSpan, ySpan) / Math.max(xSpan, ySpan)) * 100
      : null;

  // Classic Lissajous intercept phase estimate: sin(phi) = y_intercept / (ySpan / 2) when x crosses xCenter
  let lissajousPhaseDeg: number | null = null;
  if (xSpan > 1e-12 && ySpan > 1e-12) {
    let interceptSum = 0;
    let interceptCnt = 0;
    let prevX = getChannelDisplayValue(xCh, s, xMean) - xCenter;
    let prevY = getChannelDisplayValue(yCh, s, yMean) - yCenter;
    for (let i = s + stride; i < e; i += stride) {
      const cx = getChannelDisplayValue(xCh, i, xMean) - xCenter;
      const cy = getChannelDisplayValue(yCh, i, yMean) - yCenter;
      if (isFinite(prevX) && isFinite(prevY) && isFinite(cx) && isFinite(cy)) {
        if ((prevX < 0 && cx >= 0) || (prevX > 0 && cx <= 0)) {
          const denom = cx - prevX;
          const frac = Math.abs(denom) > 1e-15 ? -prevX / denom : 0;
          const yCross = prevY + frac * (cy - prevY);
          interceptSum += Math.abs(yCross);
          interceptCnt++;
        }
      }
      prevX = cx;
      prevY = cy;
    }
    if (interceptCnt > 0) {
      const yIntercept = interceptSum / interceptCnt;
      const ratio = Math.max(0, Math.min(1, yIntercept / (ySpan / 2)));
      lissajousPhaseDeg = (Math.asin(ratio) * 180) / Math.PI;
    }
  }

  return {
    sampleCount: e - s,
    xMin,
    xMax,
    yMin,
    yMax,
    circularityPct,
    lissajousPhaseDeg,
  };
}
