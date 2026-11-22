/**
 * Waveform Viewer Pro - High-Performance Oscilloscope Canvas Rendering Engine
 * Handles pixel decimation, gap breaks, 10x8 hardware graticule with center sub-ticks,
 * Overlap & per-subplot Separate Y-axes, GND markers, Trigger handles,
 * X / Y / X+Y / Track cursors, Point/Text/Area annotations, FFT spectrum, and SVG export.
 */

import {
  TabState,
  WaveformChannel,
  SpectrumResult,
  HarmonicMarker,
  CursorMode,
  ChannelMeasurements,
} from '../types/models';
import {
  PlotArea,
  SubplotRect,
  getSubplotRects,
  computeChannelMean,
  getChannelDisplayValue,
  ensureChannelScaleOffset,
  syncChannelBoundsFromScaleOffset,
  HORIZONTAL_DIVISIONS,
  VERTICAL_DIVISIONS,
} from '../modules/oscilloscopeScale';
import {
  buildDecimatedSegments,
  interpolateSmoothSegments,
  DecimatedPoint,
  SampleReader,
} from '../modules/decimator';
import { MEASUREMENT_DEFINITIONS, MeasurementDefinition } from '../modules/measurements';
import { computeXYMetrics } from '../modules/xyAnalysis';
import { GoldenEvaluationResult } from '../modules/anomalyScanner';

export type { PlotArea, SubplotRect };

export interface RenderTheme {
  bg: string;
  grid: string;
  gridSub: string;
  frame: string;
  axisText: string;
  cursor: string;
  cursorY: string;
  cursorFill: string;
  trigger: string;
  harmonic: string;
  peak: string;
  text: string;
  hudBg: string;
  hudBorder: string;
  chassisBg: string;
  headerBg: string;
  isLight?: boolean;
  bwTraces?: string[];
}

export const DEFAULT_THEME: RenderTheme = {
  bg: '#07090e',
  grid: '#1b2330',
  gridSub: '#2b3749',
  frame: '#334155',
  axisText: '#94a3b8',
  cursor: '#38bdf8',
  cursorY: '#a78bfa',
  cursorFill: 'rgba(56, 189, 248, 0.09)',
  trigger: '#fb923c',
  harmonic: '#f87171',
  peak: '#4ade80',
  text: '#f1f5f9',
  hudBg: 'rgba(15, 21, 32, 0.92)',
  hudBorder: '#334155',
  chassisBg: '#0c1016',
  headerBg: '#121822',
  isLight: false,
};

export function isComputedChannel(ch: WaveformChannel): boolean {
  return ch.channelKind === 'computed' || !!ch.isMath;
}

// Authentic phosphor oscilloscope trace palette (CH1 Yellow, CH2 Cyan, CH3 Magenta, CH4 Green, ...)
export const OVERLAP_COLORS = [
  '#facc15', // CH1 Yellow
  '#22d3ee', // CH2 Cyan
  '#f472b6', // CH3 Magenta
  '#4ade80', // CH4 Green
  '#fb923c', // CH5 Orange
  '#a78bfa', // CH6 Violet
  '#38bdf8', // CH7 Sky
  '#f87171', // CH8 Coral
];

/**
 * Formats a value with engineering SI prefixes (s, ms, µs, ns, Hz, kHz, MHz, V, mV, etc.).
 */
export function formatEng(v: number, unit: string = '', precision: number = 3): string {
  if (isNaN(v) || !isFinite(v)) return 'NaN';
  const trimmedUnit = (unit || '').trim();
  const isTemperatureUnit = /^(°C|℃|°F|K|degC|degK)$/i.test(trimmedUnit);
  if (isTemperatureUnit) {
    const cleanVal = Math.abs(v) < 1e-12 ? 0 : v;
    return `${cleanVal.toFixed(precision)} ${trimmedUnit}`.trim();
  }
  if (Math.abs(v) < 1e-15) return `${(0).toFixed(Math.min(precision, 2))} ${unit}`.trim();

  const prefixes = [
    { p: 'G', factor: 1e9 },
    { p: 'M', factor: 1e6 },
    { p: 'k', factor: 1e3 },
    { p: '', factor: 1 },
    { p: 'm', factor: 1e-3 },
    { p: 'µ', factor: 1e-6 },
    { p: 'n', factor: 1e-9 },
    { p: 'p', factor: 1e-12 },
  ];

  const absV = Math.abs(v);
  for (const pref of prefixes) {
    if (absV >= pref.factor * 0.999) {
      const scaled = v / pref.factor;
      return `${scaled.toFixed(precision)} ${pref.p}${unit}`.trim();
    }
  }

  return `${v.toExponential(precision)} ${unit}`.trim();
}

/**
 * Measures rendered axis tick width using Canvas 2D metrics when available,
 * or an accurate JetBrains Mono 10.5px fallback width in headless environments.
 */
function measureAxisTextWidth(text: string, ctx?: CanvasRenderingContext2D | null): number {
  if (!text) return 0;
  if (ctx && typeof ctx.measureText === 'function') {
    return ctx.measureText(text).width;
  }
  return text.length * 6.5;
}

/**
 * Applies 8px step upward quantization and shrink hysteresis to prevent horizontal
 * grid jitter when pan/zoom causes tick strings to fluctuate slightly in width.
 */
export function applyLeftMarginHysteresis(
  rawRequiredPx: number,
  prevMarginPx?: number,
  shrinkThresholdPx: number = 16
): number {
  const safeRaw = isFinite(rawRequiredPx) ? rawRequiredPx : 76;
  const quantized = safeRaw <= 76 ? 76 : Math.ceil(safeRaw / 8) * 8;
  if (prevMarginPx === undefined || !isFinite(prevMarginPx) || prevMarginPx < 76) {
    return quantized;
  }
  if (quantized > prevMarginPx) {
    return quantized;
  }
  if (quantized < prevMarginPx && prevMarginPx - safeRaw >= shrinkThresholdPx) {
    return quantized;
  }
  return prevMarginPx;
}

/**
 * Computes the unquantized minimum left gutter width required so Y-axis ticks,
 * GND flags, and the leftmost X-axis tick never clip on the left canvas boundary.
 * In Time Separate mode, evaluates ALL visible channels to compute a single global maximum.
 */
export function computeRequiredLeftMargin(
  tab: TabState | undefined | null,
  options?: {
    cachedSpectrum?: SpectrumResult | null;
    ctx?: CanvasRenderingContext2D | null;
  }
): number {
  if (!tab || tab.drawOrder.length === 0) return 76;

  const ctx = options?.ctx || null;
  const cachedSpectrum = options?.cachedSpectrum || null;
  let restoredCtx = false;
  if (ctx && typeof ctx.save === 'function') {
    ctx.save();
    ctx.font = '10.5px "JetBrains Mono", monospace';
    restoredCtx = true;
  }

  try {
    const gndFlagWidth = tab.plotMode === 'time' ? 18 : 0;
    const gndPad = 8;
    let maxTickRequired = 76;
    let leftmostXLabel = '';

    if (tab.plotMode === 'frequency') {
      const targetId = tab.selectedFftChannelId || tab.drawOrder[0];
      const targetCh = tab.channels[targetId] || tab.channels[tab.drawOrder[0]];
      const minF = Math.max(0, tab.view.fMin ?? 0);
      leftmostXLabel = formatEng(minF, 'Hz', 2);

      const scaleMode = tab.fftOptions.scale;
      const yMin =
        scaleMode === 'magnitude'
          ? cachedSpectrum?.magYMin ?? 0
          : cachedSpectrum?.dbYMin ?? cachedSpectrum?.yMin ?? -120;
      const yMax =
        scaleMode === 'magnitude'
          ? cachedSpectrum?.magYMax ?? 1
          : cachedSpectrum?.dbYMax ?? cachedSpectrum?.yMax ?? 20;
      const ySpan = Math.max(0.1, yMax - yMin);

      for (let j = 0; j <= VERTICAL_DIVISIONS; j++) {
        const val = yMax - (j / VERTICAL_DIVISIONS) * ySpan;
        const lbl =
          scaleMode === 'magnitude'
            ? formatEng(val, targetCh?.unit || 'V', 2)
            : `${val.toFixed(0)} dB`;
        const w = measureAxisTextWidth(lbl, ctx);
        maxTickRequired = Math.max(maxTickRequired, w + 16);
      }
    } else if (tab.plotMode === 'xy') {
      const xCh = tab.channels[tab.xyConfig?.xChannelId || tab.drawOrder[0]];
      const yCh = tab.channels[tab.xyConfig?.yChannelId || tab.drawOrder[1] || tab.drawOrder[0]];
      if (xCh && yCh) {
        const bounds = getXYPlotBounds(tab, xCh, yCh);
        leftmostXLabel = formatEng(bounds.xMin, xCh.unit, 2);
        const ySpan = Math.max(1e-9, bounds.yMax - bounds.yMin);
        for (let j = 0; j <= VERTICAL_DIVISIONS; j++) {
          const val = bounds.yMax - (j / VERTICAL_DIVISIONS) * ySpan;
          const lbl = formatEng(val, yCh.unit, 2);
          const w = measureAxisTextWidth(lbl, ctx);
          maxTickRequired = Math.max(maxTickRequired, w + 18);
        }
      }
    } else {
      const primaryCh = tab.channels[tab.drawOrder[0]] || Object.values(tab.channels)[0];
      const { tStart } = getTimeBoundsForView(tab, primaryCh);
      leftmostXLabel = formatEng(tStart, 's', 2);

      const visibleChs = tab.drawOrder
        .map((id) => tab.channels[id])
        .filter((c) => c && c.visible);

      if (tab.separateView && visibleChs.length > 1) {
        // Global maximum across ALL visible channels keeps vertical gridlines & cursors aligned
        for (const ch of visibleChs) {
          ensureChannelScaleOffset(ch);
          syncChannelBoundsFromScaleOffset(ch);
          const vMin = ch.vMin;
          const vMax = ch.vMax;
          const vSpan = vMax - vMin || 1;
          const ticks = 4;
          for (let j = 0; j <= ticks; j++) {
            const val = vMax - (j / ticks) * vSpan;
            const lbl = formatEng(val, ch.unit, 1);
            const w = measureAxisTextWidth(lbl, ctx);
            maxTickRequired = Math.max(maxTickRequired, w + 28);
          }
        }
      } else {
        const targetId =
          tab.activeChannelId ||
          tab.selectedMeasurementChannelId ||
          visibleChs[0]?.id ||
          tab.drawOrder[0];
        const activeCh = tab.channels[targetId] || visibleChs[0] || primaryCh;
        if (activeCh) {
          ensureChannelScaleOffset(activeCh);
          syncChannelBoundsFromScaleOffset(activeCh);
          const vMin = activeCh.vMin;
          const vMax = activeCh.vMax;
          const vSpan = vMax - vMin;
          for (let j = 0; j <= VERTICAL_DIVISIONS; j++) {
            const v = vMax - (j / VERTICAL_DIVISIONS) * vSpan;
            const lbl = formatEng(v, activeCh.unit, 2);
            const w = measureAxisTextWidth(lbl, ctx);
            maxTickRequired = Math.max(maxTickRequired, w + 30);
          }
        }
      }
    }

    const leftmostXHalf = Math.ceil(measureAxisTextWidth(leftmostXLabel, ctx) / 2) + 4;
    return Math.max(76, maxTickRequired, gndFlagWidth + gndPad, leftmostXHalf);
  } finally {
    if (restoredCtx && ctx && typeof ctx.restore === 'function') {
      ctx.restore();
    }
  }
}

/**
 * Calculates responsive plot area margins based on visible axes & handle gutters.
 */
export function getPlotArea(width: number, height: number, leftMargin: number = 76): PlotArea {
  const safeLeft = Math.max(76, Math.min(Math.max(76, Math.floor(width * 0.4)), Math.round(leftMargin)));
  const right = 24;
  const top = 24;
  const bottom = 32;

  return {
    x: safeLeft,
    y: top,
    width: Math.max(10, width - safeLeft - right),
    height: Math.max(10, height - top - bottom),
  };
}

/**
 * Computes dynamic, jitter-damped PlotArea for a given TabState and canvas dimensions.
 */
export function getDynamicPlotArea(
  tab: TabState | undefined | null,
  width: number,
  height: number,
  options?: {
    cachedSpectrum?: SpectrumResult | null;
    ctx?: CanvasRenderingContext2D | null;
    prevLeftMargin?: number;
    shrinkThresholdPx?: number;
  }
): { plotArea: PlotArea; leftMargin: number; rawRequiredMargin: number } {
  const rawRequiredMargin = computeRequiredLeftMargin(tab, {
    cachedSpectrum: options?.cachedSpectrum,
    ctx: options?.ctx,
  });
  const stabilized = applyLeftMarginHysteresis(
    rawRequiredMargin,
    options?.prevLeftMargin,
    options?.shrinkThresholdPx ?? 16
  );
  const plotArea = getPlotArea(width, height, stabilized);
  return {
    plotArea,
    leftMargin: plotArea.x,
    rawRequiredMargin,
  };
}

export function findTimeIndexRange(
  t: Float64Array,
  tStart: number,
  tEnd: number
): { startIdx: number; endIdx: number } {
  const n = t.length;
  if (n === 0) return { startIdx: 0, endIdx: 0 };
  if (tEnd < t[0] || tStart > t[n - 1]) return { startIdx: 0, endIdx: 0 };

  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < tStart) lo = mid + 1;
    else hi = mid;
  }
  const startIdx = lo;

  lo = startIdx;
  hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= tEnd) lo = mid + 1;
    else hi = mid;
  }
  const endIdx = Math.max(startIdx + 1, lo);
  return { startIdx, endIdx };
}

/**
 * Computes consistent visible time window bounds for a tab/channel.
 */
export function getTimeBoundsForView(
  tab: TabState,
  ch?: WaveformChannel
): { tStart: number; tEnd: number; tSpan: number; dt: number } {
  const primaryCh = tab.channels[tab.drawOrder[0]] || Object.values(tab.channels)[0];
  const baseCh =
    ch && primaryCh && (ch.t === primaryCh.t || ch.t.length === primaryCh.t.length)
      ? ch
      : primaryCh || ch;
  if (!baseCh || baseCh.t.length === 0) {
    return { tStart: 0, tEnd: 0.01, tSpan: 0.01, dt: 1e-4 };
  }
  const n = baseCh.t.length;
  const dt = baseCh.dt || (n > 1 ? (baseCh.t[n - 1] - baseCh.t[0]) / (n - 1) : 1e-4);
  const sIdx = Math.max(0, Math.min(n - 1, tab.view.startIndex));
  const tStart = baseCh.t[sIdx];
  const eIdx = Math.max(sIdx + 1, tab.view.endIndex);
  let tEnd: number;
  if (eIdx < n) {
    tEnd = baseCh.t[eIdx];
  } else if (eIdx === n && n >= 2) {
    tEnd = baseCh.t[n - 1];
  } else {
    tEnd = baseCh.t[n - 1] + (eIdx - n + 1) * dt;
  }
  const tSpan = Math.max(dt * 1e-3, tEnd - tStart);
  return { tStart, tEnd, tSpan, dt };
}

/**
 * Resolves effective cursor mode cleanly from CursorsState.
 */
export function resolveCursorMode(tab: TabState): CursorMode {
  if (!tab.cursors.enabled) return 'off';
  return tab.cursors.mode && tab.cursors.mode !== 'off' ? tab.cursors.mode : 'x';
}

/**
 * Resolves the target PlotArea for a specific channel (respecting Separate vs Overlap mode).
 */
export function getChannelPlotArea(tab: TabState, channelId: string, p: PlotArea): PlotArea {
  const visibleChs = tab.drawOrder
    .map((id) => tab.channels[id])
    .filter((c) => c && c.visible);
  if (!tab.separateView || visibleChs.length <= 1) return p;

  const rects = getSubplotRects(p, visibleChs, true);
  const found = rects.find((r) => r.channel.id === channelId);
  return found ? found.area : p;
}

/**
 * Transforms screen coordinates to time/voltage data values (supports separate subplot area).
 */
export function screenToData(
  screenPos: { x: number; y: number },
  tab: TabState,
  channelId: string,
  plotArea: PlotArea
): { time: number; voltage: number } {
  const ch = tab.channels[channelId] || Object.values(tab.channels)[0];
  if (!ch) return { time: 0, voltage: 0 };

  const { tStart, tSpan } = getTimeBoundsForView(tab, ch);
  const timeFrac = (screenPos.x - plotArea.x) / plotArea.width;
  const time = tStart + timeFrac * tSpan;

  const vRange = ch.vMax - ch.vMin;
  const voltFrac = (plotArea.y + plotArea.height - screenPos.y) / plotArea.height;
  const voltage = ch.vMin + voltFrac * vRange;

  return { time, voltage };
}

/**
 * Transforms time/voltage data values to screen pixel coordinates.
 */
export function dataToScreen(
  dataPos: { time: number; voltage: number },
  tab: TabState,
  channelId: string,
  plotArea: PlotArea
): { x: number; y: number } {
  const ch = tab.channels[channelId] || Object.values(tab.channels)[0];
  if (!ch) return { x: 0, y: 0 };

  const { tStart, tSpan } = getTimeBoundsForView(tab, ch);
  const timeFrac = tSpan > 0 ? (dataPos.time - tStart) / tSpan : 0;
  const x = plotArea.x + timeFrac * plotArea.width;

  const vRange = ch.vMax - ch.vMin;
  const voltFrac = vRange > 0 ? (dataPos.voltage - ch.vMin) / vRange : 0.5;
  const y = plotArea.y + plotArea.height - voltFrac * plotArea.height;

  return { x, y };
}

/**
 * Samples a channel's display value at arbitrary timestamp t via linear interpolation.
 */
export function sampleChannelValueAtTime(ch: WaveformChannel, targetTime: number): number | null {
  const n = ch.t.length;
  if (n === 0) return null;
  if (targetTime <= ch.t[0]) {
    const val = getChannelDisplayValue(ch, 0);
    return isFinite(val) ? val : null;
  }
  if (targetTime >= ch.t[n - 1]) {
    const val = getChannelDisplayValue(ch, n - 1);
    return isFinite(val) ? val : null;
  }

  // Binary search
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ch.t[mid] <= targetTime) lo = mid;
    else hi = mid;
  }

  const mean = ch.coupling === 'AC' ? computeChannelMean(ch) : 0;
  const vLo = getChannelDisplayValue(ch, lo, mean);
  const vHi = getChannelDisplayValue(ch, hi, mean);
  if (!isFinite(vLo) || !isFinite(vHi)) return isFinite(vLo) ? vLo : isFinite(vHi) ? vHi : null;

  const dt = ch.t[hi] - ch.t[lo];
  const frac = dt > 0 ? (targetTime - ch.t[lo]) / dt : 0;
  return vLo + frac * (vHi - vLo);
}

/**
 * Draws authentic oscilloscope background graticule with center crosshair sub-ticks.
 */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  p: PlotArea,
  theme: RenderTheme,
  xDivs: number = HORIZONTAL_DIVISIONS,
  yDivs: number = VERTICAL_DIVISIONS,
  drawSubTicks: boolean = true
): void {
  ctx.save();
  ctx.fillStyle = theme.bg;
  ctx.fillRect(p.x, p.y, p.width, p.height);

  // Subtle major grid lines
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 1;

  for (let i = 1; i < xDivs; i++) {
    const x = Math.round(p.x + (i * p.width) / xDivs) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, p.y);
    ctx.lineTo(x, p.y + p.height);
    ctx.stroke();
  }

  for (let j = 1; j < yDivs; j++) {
    const y = Math.round(p.y + (j * p.height) / yDivs) + 0.5;
    ctx.beginPath();
    ctx.moveTo(p.x, y);
    ctx.lineTo(p.x + p.width, y);
    ctx.stroke();
  }

  // Center axes & hardware sub-ticks (5 subdivisions per major division)
  if (drawSubTicks && p.height >= 40) {
    const centerX = Math.round(p.x + p.width / 2) + 0.5;
    const centerY = Math.round(p.y + p.height / 2) + 0.5;

    ctx.strokeStyle = theme.gridSub;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(centerX, p.y);
    ctx.lineTo(centerX, p.y + p.height);
    ctx.moveTo(p.x, centerY);
    ctx.lineTo(p.x + p.width, centerY);
    ctx.stroke();

    // Horizontal center axis ticks
    const totalXTicks = xDivs * 5;
    for (let k = 1; k < totalXTicks; k++) {
      if (k % 5 === 0) continue;
      const tx = Math.round(p.x + (k * p.width) / totalXTicks) + 0.5;
      ctx.beginPath();
      ctx.moveTo(tx, centerY - 3);
      ctx.lineTo(tx, centerY + 3);
      ctx.stroke();
    }

    // Vertical center axis ticks
    const totalYTicks = yDivs * 5;
    for (let k = 1; k < totalYTicks; k++) {
      if (k % 5 === 0) continue;
      const ty = Math.round(p.y + (k * p.height) / totalYTicks) + 0.5;
      ctx.beginPath();
      ctx.moveTo(centerX - 3, ty);
      ctx.lineTo(centerX + 3, ty);
      ctx.stroke();
    }
  }

  // Crisp outer graticule frame
  ctx.strokeStyle = theme.frame || '#334155';
  ctx.lineWidth = 1;
  ctx.strokeRect(p.x + 0.5, p.y + 0.5, p.width - 1, p.height - 1);
  ctx.restore();
}

function computeArrayMean(arr: Float32Array): number {
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < arr.length; i++) {
    const val = arr[i];
    if (!isNaN(val) && isFinite(val)) {
      sum += val;
      cnt++;
    }
  }
  return cnt > 0 ? sum / cnt : 0;
}

function drawSegmentsOnCanvas(
  ctx: CanvasRenderingContext2D,
  segments: DecimatedPoint[][],
  area: PlotArea,
  viewStartTime: number,
  viewDuration: number,
  vMin: number,
  vRange: number,
  drawLines: boolean,
  drawMarkers: boolean,
  markerRadius: number = 2.4
): void {
  if (segments.length === 0) return;

  if (drawLines) {
    ctx.beginPath();
    for (const seg of segments) {
      if (seg.length === 0) continue;
      for (let i = 0; i < seg.length; i++) {
        const x = area.x + ((seg[i].time - viewStartTime) / viewDuration) * area.width;
        const y = area.y + area.height - ((seg[i].value - vMin) / vRange) * area.height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Ensure isolated single-sample segments remain visible in line modes
    const savedDash = ctx.getLineDash();
    if (savedDash.length > 0) ctx.setLineDash([]);
    for (const seg of segments) {
      if (seg.length === 1) {
        const x = area.x + ((seg[0].time - viewStartTime) / viewDuration) * area.width;
        const y = area.y + area.height - ((seg[0].value - vMin) / vRange) * area.height;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(2.2, markerRadius), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (savedDash.length > 0) ctx.setLineDash(savedDash);
  }

  if (drawMarkers) {
    const savedDash = ctx.getLineDash();
    if (savedDash.length > 0) ctx.setLineDash([]);
    let totalPts = 0;
    for (const seg of segments) totalPts += seg.length;
    const stride = totalPts > 1400 ? Math.ceil(totalPts / 1400) : 1;

    for (const seg of segments) {
      for (let i = 0; i < seg.length; i += stride) {
        const x = area.x + ((seg[i].time - viewStartTime) / viewDuration) * area.width;
        const y = area.y + area.height - ((seg[i].value - vMin) / vRange) * area.height;
        ctx.beginPath();
        ctx.arc(x, y, markerRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (savedDash.length > 0) ctx.setLineDash(savedDash);
  }
}

/**
 * Draws Waveform with Min-Max / LTTB Decimation, Vector / Dots / Vector+Markers render modes,
 * Gap breaks, AC coupling & Inversion, plus same-screen Ref & Diff (New - Ref) overlays.
 */
export function drawChannelWaveform(
  ctx: CanvasRenderingContext2D,
  tab: TabState,
  ch: WaveformChannel,
  p: PlotArea,
  subPlotArea?: PlotArea,
  theme: RenderTheme = DEFAULT_THEME
): void {
  if (!ch.visible || ch.v.length === 0) return;

  ensureChannelScaleOffset(ch);
  syncChannelBoundsFromScaleOffset(ch);

  const area = subPlotArea || p;
  const v = ch.v;
  const t = ch.t;
  const totalN = v.length;
  const { tStart: viewStartTime, tSpan: viewDuration, dt } = getTimeBoundsForView(tab, ch);

  const vMin = ch.vMin;
  const vMax = ch.vMax;
  const vRange = vMax - vMin || 1.0;

  const isConditioned = ch.coupling === 'AC' || !!ch.inverted;
  const cachedMean = ch.coupling === 'AC' ? computeChannelMean(ch) : 0;

  const primaryCh = tab.channels[tab.drawOrder[0]] || Object.values(tab.channels)[0];
  const usesPrimaryIndex = !primaryCh || ch.t === primaryCh.t || ch.t.length === primaryCh.t.length;
  let startIdx: number;
  let endIdx: number;
  if (usesPrimaryIndex) {
    startIdx = Math.max(0, Math.min(totalN - 1, tab.view.startIndex));
    endIdx = Math.max(startIdx + 1, Math.min(totalN, tab.view.endIndex));
  } else {
    const rng = findTimeIndexRange(t, viewStartTime, viewStartTime + viewDuration);
    startIdx = rng.startIdx;
    endIdx = rng.endIdx;
  }
  const pointsInView = endIdx - startIdx;
  if (pointsInView <= 0) return;

  // Include 1 neighbor sample on each side so lines extend seamlessly to the clip borders
  const drawStartIdx = Math.max(0, startIdx - 1);
  const drawEndIdx = Math.min(totalN, endIdx + 1);

  const renderMode = tab.renderMode || 'vector';
  const decimationMode = tab.decimationMode || 'minmax';
  // Connect all consecutive valid samples continuously; only explicit NaNs break the trace
  const gapThreshold = Infinity;

  ctx.save();
  ctx.beginPath();
  ctx.rect(area.x, area.y, area.width, area.height);
  ctx.clip();

  // Subtle 0V reference baseline inside subplot
  if (0 >= vMin && 0 <= vMax) {
    const zeroY = area.y + area.height - ((0 - vMin) / vRange) * area.height;
    ctx.save();
    ctx.strokeStyle = theme.isLight ? 'rgba(100, 116, 139, 0.28)' : 'rgba(148, 163, 184, 0.16)';
    ctx.setLineDash([2, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(area.x, zeroY);
    ctx.lineTo(area.x + area.width, zeroY);
    ctx.stroke();
    ctx.restore();
  }

  // 1. Same-screen Reference (Ref) trace (dashed, semi-transparent, drawn beneath active trace)
  if (ch.refV && ch.hasEdits && ch.showRef !== false && ch.refV.length === totalN) {
    const refArr = ch.refV;
    const refMean = ch.coupling === 'AC' ? computeArrayMean(refArr) : 0;
    const readRef: SampleReader = (i: number) => {
      const raw = refArr[i];
      if (isNaN(raw)) return NaN;
      const ac = ch.coupling === 'AC' ? raw - refMean : raw;
      return ch.inverted ? -ac : ac;
    };

    let refSegments = buildDecimatedSegments(
      t,
      readRef,
      drawStartIdx,
      drawEndIdx,
      area.width,
      decimationMode,
      gapThreshold
    );
    if (renderMode === 'sinc' && pointsInView <= 600) {
      refSegments = interpolateSmoothSegments(refSegments, 8);
    }

    ctx.save();
    ctx.strokeStyle = ch.color;
    ctx.fillStyle = ch.color;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([6, 4]);
    drawSegmentsOnCanvas(
      ctx,
      refSegments,
      area,
      viewStartTime,
      viewDuration,
      vMin,
      vRange,
      renderMode !== 'dots',
      renderMode === 'dots',
      2.0
    );
    ctx.restore();
  }

  // 2. Primary Active Waveform Trace
  const readActive: SampleReader = (i: number) =>
    isConditioned ? getChannelDisplayValue(ch, i, cachedMean) : v[i];

  const rawActiveSegments = buildDecimatedSegments(
    t,
    readActive,
    drawStartIdx,
    drawEndIdx,
    area.width,
    decimationMode,
    gapThreshold
  );
  const activeSegments =
    renderMode === 'sinc' && pointsInView <= 600
      ? interpolateSmoothSegments(rawActiveSegments, 8)
      : rawActiveSegments;

  const computed = isComputedChannel(ch);
  ctx.strokeStyle = ch.color;
  ctx.fillStyle = ch.color;
  ctx.lineWidth = ch.id === tab.activeChannelId ? 1.9 : computed ? 1.4 : 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (computed) {
    const dash =
      ch.derivedKind === 'diff' || ch.compareRole === 'diff'
        ? [3, 3]
        : ch.derivedKind === 'ref' || ch.compareRole === 'ref'
        ? [6, 4]
        : [7, 4];
    ctx.setLineDash(dash);
    ctx.globalAlpha = ch.id === tab.activeChannelId ? 1.0 : 0.88;
  } else {
    ctx.setLineDash([]);
    ctx.globalAlpha = 1.0;
  }

  const drawLines = renderMode === 'vector' || renderMode === 'sinc' || renderMode === 'vector-markers';
  const drawMarkers = renderMode === 'dots' || renderMode === 'vector-markers';

  drawSegmentsOnCanvas(
    ctx,
    activeSegments,
    area,
    viewStartTime,
    viewDuration,
    vMin,
    vRange,
    drawLines,
    drawMarkers,
    renderMode === 'dots' ? 2.4 : 2.3
  );

  // In Sin(x)/x mode when sparse (< 80 samples on screen), render subtle sample nodes on top
  if (renderMode === 'sinc' && pointsInView <= 80) {
    drawSegmentsOnCanvas(
      ctx,
      rawActiveSegments,
      area,
      viewStartTime,
      viewDuration,
      vMin,
      vRange,
      false,
      true,
      2.0
    );
  }

  ctx.setLineDash([]);
  ctx.globalAlpha = 1.0;

  // 3. Same-screen Diff (New - Ref) curve
  if (ch.refV && ch.hasEdits && ch.showDiff && ch.refV.length === totalN) {
    const refArr = ch.refV;
    const sign = ch.inverted ? -1 : 1;
    const readDiff: SampleReader = (i: number) => (v[i] - refArr[i]) * sign;

    const diffSegments = buildDecimatedSegments(
      t,
      readDiff,
      drawStartIdx,
      drawEndIdx,
      area.width,
      decimationMode,
      gapThreshold
    );

    const diffCol = theme.isLight ? '#e11d48' : '#fb7185';
    ctx.save();
    ctx.strokeStyle = diffCol;
    ctx.fillStyle = diffCol;
    ctx.lineWidth = 1.35;
    ctx.setLineDash([3, 3]);
    drawSegmentsOnCanvas(
      ctx,
      diffSegments,
      area,
      viewStartTime,
      viewDuration,
      vMin,
      vRange,
      renderMode !== 'dots',
      renderMode === 'dots',
      2.0
    );
    ctx.restore();
  }

  ctx.restore();
}

/**
 * Computes positions of interactive GND (0V ground reference) markers along the left edge.
 */
export interface GndHandlePosition {
  channelId: string;
  label: string;
  color: string;
  x: number;
  y: number;
  clamped: boolean;
  area: PlotArea;
}

export function getGndHandlePositions(p: PlotArea, tab: TabState): GndHandlePosition[] {
  if (tab.plotMode !== 'time') return [];
  const visibleChs = tab.drawOrder
    .map((id) => tab.channels[id])
    .filter((c) => c && c.visible);
  if (visibleChs.length === 0) return [];

  const rects = getSubplotRects(p, visibleChs, tab.separateView);
  const handles: GndHandlePosition[] = [];

  rects.forEach((rect) => {
    const ch = rect.channel;
    const area = rect.area;
    const vRange = ch.vMax - ch.vMin || 1;
    const rawY = area.y + area.height - ((0 - ch.vMin) / vRange) * area.height;
    const clampedY = Math.max(area.y + 7, Math.min(area.y + area.height - 7, rawY));
    const idxInOrder = tab.drawOrder.indexOf(ch.id);
    const label = ch.isMath ? 'M' : `${idxInOrder + 1}`;

    handles.push({
      channelId: ch.id,
      label,
      color: ch.color,
      x: area.x - 1,
      y: clampedY,
      clamped: rawY !== clampedY,
      area,
    });
  });

  return handles;
}

/**
 * Draws clickable/draggable hardware GND ground flags on the left border of the graticule.
 */
export function drawGndMarkers(
  ctx: CanvasRenderingContext2D,
  p: PlotArea,
  tab: TabState,
  theme: RenderTheme = DEFAULT_THEME
): void {
  const handles = getGndHandlePositions(p, tab);
  if (handles.length === 0) return;

  ctx.save();
  ctx.font = 'bold 9px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const h of handles) {
    const isActive = h.channelId === tab.activeChannelId;
    const w = 15;
    const halfH = 6.5;

    ctx.beginPath();
    ctx.moveTo(h.x, h.y);
    ctx.lineTo(h.x - 5, h.y - halfH);
    ctx.lineTo(h.x - w - 2, h.y - halfH);
    ctx.lineTo(h.x - w - 2, h.y + halfH);
    ctx.lineTo(h.x - 5, h.y + halfH);
    ctx.closePath();

    ctx.fillStyle = h.clamped ? (theme.isLight ? '#e2e8f0' : '#1e293b') : h.color;
    ctx.fill();
    ctx.strokeStyle = isActive ? theme.text : h.color;
    ctx.lineWidth = isActive ? 1.5 : 1;
    ctx.stroke();

    ctx.fillStyle = h.clamped ? h.color : theme.isLight ? '#ffffff' : '#090d12';
    ctx.fillText(h.label, h.x - 10.5, h.y + 0.5);
  }

  ctx.restore();
}

/**
 * Computes exact pixel coordinates of the Trigger handle for hit-testing & dragging.
 */
export function getTriggerHandlePosition(
  p: PlotArea,
  tab: TabState
): { x: number; y: number; area: PlotArea } | null {
  const trig = tab.triggerConfig;
  if (!trig.enabled || !trig.channelId || tab.plotMode !== 'time') return null;
  const ch = tab.channels[trig.channelId];
  if (!ch) return null;

  const area = getChannelPlotArea(tab, ch.id, p);
  const vRange = ch.vMax - ch.vMin;
  if (vRange <= 0) return null;

  const yFrac = (trig.level - ch.vMin) / vRange;
  const rawY = area.y + area.height - yFrac * area.height;
  const clampedY = Math.max(area.y + 4, Math.min(area.y + area.height - 4, rawY));
  return { x: area.x + area.width, y: clampedY, area };
}

/**
 * Draws Frequency Spectrum Trace, Peaks, and BLDC Harmonic lines.
 */
export function drawSpectrum(
  ctx: CanvasRenderingContext2D,
  spectrum: SpectrumResult,
  p: PlotArea,
  theme: RenderTheme,
  harmonicMarkers: HarmonicMarker[] = [],
  scaleMode: 'db' | 'magnitude' = 'db',
  tabView?: { fMin?: number; fMax?: number }
): void {
  const freqs = spectrum.frequencies;
  const values = scaleMode === 'db' ? spectrum.dbValues : spectrum.magnitudes;
  const n = values.length;
  if (n < 2) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(p.x, p.y, p.width, p.height);
  ctx.clip();

  const nyquist = freqs[n - 1];
  const minFreq = Math.max(0, tabView?.fMin ?? 0);
  const maxFreq = Math.min(nyquist, tabView?.fMax ?? nyquist);
  const freqSpan = Math.max(1.0, maxFreq - minFreq);

  let yMin =
    scaleMode === 'db'
      ? spectrum.dbYMin ?? spectrum.yMin ?? -120
      : spectrum.magYMin ?? 0;
  let yMax =
    scaleMode === 'db'
      ? spectrum.dbYMax ?? spectrum.yMax ?? 20
      : spectrum.magYMax ?? 1;

  if (
    (scaleMode === 'db' && spectrum.dbYMin === undefined && spectrum.yMin === undefined) ||
    (scaleMode === 'magnitude' && spectrum.magYMax === undefined)
  ) {
    if (scaleMode === 'magnitude') {
      let maxMag = 0;
      for (let i = 0; i < n; i++) if (values[i] > maxMag) maxMag = values[i];
      yMax = Math.max(0.1, maxMag * 1.15);
      yMin = 0;
    } else {
      let maxDb = -Infinity;
      for (let i = 0; i < n; i++) if (values[i] > maxDb) maxDb = values[i];
      if (isFinite(maxDb)) {
        yMax = Math.ceil(maxDb / 10) * 10 + 10;
        yMin = yMax - 120;
      }
    }
  }

  const ySpan = Math.max(0.1, yMax - yMin);

  // O(1) visible bin range lookup (uniform bin resolution df)
  const df = freqs[1] - freqs[0];
  const startBin = df > 0 ? Math.max(0, Math.floor(minFreq / df) - 1) : 0;
  const endBin = df > 0 ? Math.min(n - 1, Math.ceil(maxFreq / df) + 1) : n - 1;
  const binsInView = Math.max(0, endBin - startBin + 1);

  ctx.strokeStyle = theme.cursor;
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  let started = false;
  let firstX = p.x;
  let lastX = p.x;
  const numCols = Math.max(120, Math.floor(p.width));

  if (binsInView > numCols * 2) {
    // Peak-Envelope pixel-column decimation: emits at most 2 vertices per pixel while preserving 100% of narrow spectral spikes
    const binsPerCol = binsInView / numCols;
    for (let col = 0; col < numCols; col++) {
      const bStart = startBin + Math.floor(col * binsPerCol);
      const bEnd = Math.min(endBin + 1, startBin + Math.floor((col + 1) * binsPerCol));
      if (bEnd <= bStart) continue;

      let minIdx = bStart;
      let maxIdx = bStart;
      let minVal = values[bStart];
      let maxVal = minVal;
      for (let k = bStart + 1; k < bEnd; k++) {
        const val = values[k];
        if (val < minVal) {
          minVal = val;
          minIdx = k;
        }
        if (val > maxVal) {
          maxVal = val;
          maxIdx = k;
        }
      }

      const emit = (idx: number, val: number) => {
        const x = p.x + ((freqs[idx] - minFreq) / freqSpan) * p.width;
        const y = p.y + p.height - ((val - yMin) / ySpan) * p.height;
        if (!started) {
          ctx.moveTo(x, y);
          firstX = x;
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
        lastX = x;
      };

      if (minIdx === maxIdx) {
        emit(minIdx, minVal);
      } else if (minIdx < maxIdx) {
        emit(minIdx, minVal);
        emit(maxIdx, maxVal);
      } else {
        emit(maxIdx, maxVal);
        emit(minIdx, minVal);
      }
    }
  } else {
    for (let i = startBin; i <= endBin; i++) {
      const f = freqs[i];
      const val = values[i];
      const x = p.x + ((f - minFreq) / freqSpan) * p.width;
      const y = p.y + p.height - ((val - yMin) / ySpan) * p.height;

      if (!started) {
        ctx.moveTo(x, y);
        firstX = x;
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
      lastX = x;
    }
  }
  ctx.stroke();

  if (started) {
    ctx.lineTo(lastX, p.y + p.height);
    ctx.lineTo(firstX, p.y + p.height);
    ctx.closePath();
    ctx.fillStyle = theme.cursorFill;
    ctx.fill();
  }

  // Spectrum telemetry banner
  ctx.font = '600 11px "JetBrains Mono", monospace';
  ctx.fillStyle = theme.cursor;
  const warnSuffix = spectrum.cappedWarning ? `  |  [${spectrum.cappedWarning}]` : '';
  ctx.fillText(
    `FFT: ${spectrum.sourceChannelName}  |  Fs: ${formatEng(spectrum.sampleRate, 'S/s', 1)}  |  Δf: ${spectrum.resolution.toFixed(2)} Hz  |  Span: ${formatEng(minFreq, 'Hz', 1)} - ${formatEng(maxFreq, 'Hz', 1)}${warnSuffix}`,
    p.x + 10,
    p.y + 16
  );

  // BLDC Harmonic Markers
  if (harmonicMarkers.length > 0) {
    ctx.font = '10px "JetBrains Mono", monospace';
    const sortedMarkers = [...harmonicMarkers].sort((a, b) => a.frequency - b.frequency);
    let lastMarkerX = -999;
    let staggerLevel = 0;

    for (const marker of sortedMarkers) {
      if (marker.frequency >= minFreq && marker.frequency <= maxFreq) {
        const x = p.x + ((marker.frequency - minFreq) / freqSpan) * p.width;

        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = theme.harmonic;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x, p.y);
        ctx.lineTo(x, p.y + p.height);
        ctx.stroke();
        ctx.restore();

        if (Math.abs(x - lastMarkerX) < 68) {
          staggerLevel = (staggerLevel + 1) % 3;
        } else {
          staggerLevel = 0;
        }
        lastMarkerX = x;

        const labelY = p.y + 32 + staggerLevel * 17;
        const tw = ctx.measureText(marker.label).width;
        const lx = Math.min(x + 4, p.x + p.width - tw - 6);

        ctx.fillStyle = theme.hudBg;
        ctx.fillRect(lx - 2, labelY - 10, tw + 6, 13);
        ctx.fillStyle = theme.harmonic;
        ctx.fillText(marker.label, lx + 1, labelY);
      }
    }
  }

  // Detected Spectral Peaks
  ctx.font = '10px "JetBrains Mono", monospace';
  const visiblePeaks = spectrum.peaks.filter(
    (peak) => peak.frequency >= minFreq && peak.frequency <= maxFreq
  );
  const fundColor = theme.isLight ? '#b45309' : '#facc15';

  for (let idx = 0; idx < visiblePeaks.length; idx++) {
    const peak = visiblePeaks[idx];
    const x = p.x + ((peak.frequency - minFreq) / freqSpan) * p.width;
    const peakVal = scaleMode === 'db' ? peak.db : peak.magnitude;
    const y = p.y + p.height - ((peakVal - yMin) / ySpan) * p.height;

    ctx.fillStyle = peak.isFundamental ? fundColor : theme.peak;
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x - 4.5, y - 12);
    ctx.lineTo(x + 4.5, y - 12);
    ctx.closePath();
    ctx.fill();

    const magText = scaleMode === 'db' ? `${peak.db.toFixed(1)} dB` : formatEng(peak.magnitude, 'V', 2);
    const label = `${formatEng(peak.frequency, 'Hz', 2)} (${magText})`;
    const tw = ctx.measureText(label).width;

    const labelX = Math.max(p.x + 8, Math.min(p.x + p.width - tw - 8, x - tw / 2));
    const labelY = Math.max(p.y + 28, Math.min(p.y + p.height - 12, y - 16 - (idx % 2) * 14));

    ctx.fillStyle = theme.hudBg;
    ctx.fillRect(labelX - 3, labelY - 10, tw + 6, 13);
    ctx.strokeStyle = peak.isFundamental ? fundColor : theme.peak;
    ctx.lineWidth = 1;
    ctx.strokeRect(labelX - 3, labelY - 10, tw + 6, 13);

    ctx.fillStyle = peak.isFundamental ? fundColor : theme.text;
    ctx.fillText(label, labelX, labelY);
  }

  ctx.restore();
}

/**
 * Draws horizontal trigger line + interactive right-edge T handle inside the trigger source subplot.
 */
export function drawTriggerLine(
  ctx: CanvasRenderingContext2D,
  tab: TabState,
  p: PlotArea,
  theme: RenderTheme
): void {
  const trig = tab.triggerConfig;
  if (!trig.enabled || !trig.channelId) return;

  const ch = tab.channels[trig.channelId];
  if (!ch) return;

  const area = getChannelPlotArea(tab, ch.id, p);
  const vRange = ch.vMax - ch.vMin;
  if (vRange <= 0) return;

  const yFrac = (trig.level - ch.vMin) / vRange;
  const rawY = area.y + area.height - yFrac * area.height;
  const inBounds = yFrac >= 0 && yFrac <= 1;
  const y = Math.max(area.y + 4, Math.min(area.y + area.height - 4, rawY));

  ctx.save();

  // Horizontal dashed trigger level line inside subplot
  if (inBounds) {
    ctx.strokeStyle = theme.trigger;
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(area.x, y);
    ctx.lineTo(area.x + area.width, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Trigger right-edge T handle
  const hx = area.x + area.width;
  ctx.fillStyle = theme.trigger;
  ctx.beginPath();
  ctx.moveTo(hx, y);
  ctx.lineTo(hx + 6, y - 6);
  ctx.lineTo(hx + 20, y - 6);
  ctx.lineTo(hx + 20, y + 6);
  ctx.lineTo(hx + 6, y + 6);
  ctx.closePath();
  ctx.fill();

  ctx.font = 'bold 9px "JetBrains Mono", monospace';
  ctx.fillStyle = theme.isLight ? '#ffffff' : '#090d12';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('T', hx + 12, y + 0.5);

  // Horizontal trigger position marker on top of graticule
  const posX = p.x + ((trig.positionPercent ?? 50) / 100) * p.width;
  ctx.fillStyle = theme.trigger;
  ctx.beginPath();
  ctx.moveTo(posX, p.y + 1);
  ctx.lineTo(posX - 5, p.y - 7);
  ctx.lineTo(posX + 5, p.y - 7);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

/**
 * Draws X, Y, X+Y, and Waveform Tracking cursors + compact live readout HUD.
 */
export function drawCursors(
  ctx: CanvasRenderingContext2D,
  tab: TabState,
  p: PlotArea,
  theme: RenderTheme
): void {
  const mode = resolveCursorMode(tab);
  if (mode === 'off' || tab.plotMode === 'frequency') return;

  const { cursors } = tab;
  const targetId = cursors.trackingChannel || tab.activeChannelId || tab.drawOrder[0];
  const targetCh = tab.channels[targetId] || tab.channels[tab.drawOrder[0]];
  if (!targetCh) return;

  const { tStart, tSpan } = getTimeBoundsForView(tab, targetCh);
  const targetArea = getChannelPlotArea(tab, targetCh.id, p);

  const showX = mode === 'x' || mode === 'xy' || mode === 'track';
  const showY = mode === 'y' || mode === 'xy';
  const showTrack = mode === 'track';

  ctx.save();
  ctx.font = '600 10px "JetBrains Mono", monospace';

  // Vertical X1 / X2 lines across full plot height
  let x1Px: number | null = null;
  let x2Px: number | null = null;

  if (showX && tSpan > 0) {
    if (cursors.x1 !== null) {
      x1Px = p.x + ((cursors.x1 - tStart) / tSpan) * p.width;
      if (x1Px >= p.x && x1Px <= p.x + p.width) {
        ctx.strokeStyle = theme.cursor;
        ctx.lineWidth = 1.25;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(x1Px, p.y);
        ctx.lineTo(x1Px, p.y + p.height);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = theme.cursor;
        ctx.fillRect(x1Px - 10, p.y - 14, 20, 13);
        ctx.fillStyle = theme.isLight ? '#ffffff' : '#080b0f';
        ctx.textAlign = 'center';
        ctx.fillText('X1', x1Px, p.y - 4);
      }
    }

    if (cursors.x2 !== null) {
      x2Px = p.x + ((cursors.x2 - tStart) / tSpan) * p.width;
      if (x2Px >= p.x && x2Px <= p.x + p.width) {
        ctx.strokeStyle = theme.cursor;
        ctx.lineWidth = 1.25;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(x2Px, p.y);
        ctx.lineTo(x2Px, p.y + p.height);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = theme.cursor;
        ctx.fillRect(x2Px - 10, p.y - 14, 20, 13);
        ctx.fillStyle = theme.isLight ? '#ffffff' : '#080b0f';
        ctx.textAlign = 'center';
        ctx.fillText('X2', x2Px, p.y - 4);
      }
    }

    if (x1Px !== null && x2Px !== null) {
      const left = Math.max(p.x, Math.min(x1Px, x2Px));
      const right = Math.min(p.x + p.width, Math.max(x1Px, x2Px));
      if (right > left) {
        ctx.fillStyle = theme.cursorFill;
        ctx.fillRect(left, p.y, right - left, p.height);
      }
    }
  }

  // Horizontal Y1 / Y2 lines inside target channel subplot
  const vRange = targetCh.vMax - targetCh.vMin;
  let y1Val: number | null = cursors.y1;
  let y2Val: number | null = cursors.y2;

  if (showTrack) {
    y1Val = cursors.x1 !== null ? sampleChannelValueAtTime(targetCh, cursors.x1) : null;
    y2Val = cursors.x2 !== null ? sampleChannelValueAtTime(targetCh, cursors.x2) : null;
  }

  if ((showY || showTrack) && vRange > 0) {
    const drawHorizontalCursor = (val: number | null, label: string, pxAtTime: number | null) => {
      if (val === null) return;
      const yFrac = (val - targetCh.vMin) / vRange;
      const yPx = targetArea.y + targetArea.height - yFrac * targetArea.height;
      if (yPx < targetArea.y || yPx > targetArea.y + targetArea.height) return;

      ctx.strokeStyle = theme.cursorY;
      ctx.lineWidth = 1.2;
      ctx.setLineDash(showTrack ? [2, 3] : [5, 3]);
      ctx.beginPath();
      ctx.moveTo(targetArea.x, yPx);
      ctx.lineTo(targetArea.x + targetArea.width, yPx);
      ctx.stroke();
      ctx.setLineDash([]);

      // Y badge inside left margin of targetArea
      ctx.fillStyle = theme.cursorY;
      ctx.fillRect(targetArea.x + 4, yPx - 14, 20, 12);
      ctx.fillStyle = theme.isLight ? '#ffffff' : '#080b0f';
      ctx.textAlign = 'center';
      ctx.fillText(label, targetArea.x + 14, yPx - 4.5);

      if (showTrack && pxAtTime !== null && pxAtTime >= p.x && pxAtTime <= p.x + p.width) {
        ctx.strokeStyle = theme.text;
        ctx.fillStyle = targetCh.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(pxAtTime, yPx, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    };

    drawHorizontalCursor(y1Val, 'Y1', x1Px);
    drawHorizontalCursor(y2Val, 'Y2', x2Px);

    if (showY && y1Val !== null && y2Val !== null) {
      const y1Px = targetArea.y + targetArea.height - ((y1Val - targetCh.vMin) / vRange) * targetArea.height;
      const y2Px = targetArea.y + targetArea.height - ((y2Val - targetCh.vMin) / vRange) * targetArea.height;
      const top = Math.max(targetArea.y, Math.min(y1Px, y2Px));
      const bot = Math.min(targetArea.y + targetArea.height, Math.max(y1Px, y2Px));
      if (bot > top) {
        ctx.fillStyle = theme.isLight ? 'rgba(124, 58, 237, 0.08)' : 'rgba(167, 139, 250, 0.08)';
        ctx.fillRect(targetArea.x, top, targetArea.width, bot - top);
      }
    }
  }

  // Compact On-Screen Cursor Delta HUD (top-right inside graticule)
  const lines: string[] = [];
  if (showX && cursors.x1 !== null && cursors.x2 !== null) {
    const dx = Math.abs(cursors.x2 - cursors.x1);
    const freqStr = dx > 1e-15 ? formatEng(1 / dx, 'Hz', 2) : '∞';
    lines.push(`X1:${formatEng(cursors.x1, 's', 3)}  X2:${formatEng(cursors.x2, 's', 3)}`);
    lines.push(`ΔX:${formatEng(dx, 's', 3)}  1/ΔX:${freqStr}`);
  }
  if ((showY || showTrack) && y1Val !== null && y2Val !== null) {
    const dy = y2Val - y1Val;
    lines.push(`Y1:${formatEng(y1Val, targetCh.unit, 2)}  Y2:${formatEng(y2Val, targetCh.unit, 2)}`);
    lines.push(`ΔY:${formatEng(dy, targetCh.unit, 2)} (${targetCh.name})`);
  }

  if (lines.length > 0) {
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    let maxW = 0;
    for (const ln of lines) {
      const w = ctx.measureText(ln).width;
      if (w > maxW) maxW = w;
    }
    const boxW = maxW + 16;
    const boxH = lines.length * 15 + 10;
    const bx = p.x + p.width - boxW - 8;
    const by = p.y + 8;

    ctx.fillStyle = theme.hudBg;
    ctx.fillRect(bx, by, boxW, boxH);
    ctx.strokeStyle = theme.hudBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, boxW, boxH);

    lines.forEach((ln, idx) => {
      ctx.fillStyle = idx < 2 && showX ? theme.cursor : theme.cursorY;
      ctx.fillText(ln, bx + 8, by + 15 + idx * 15);
    });
  }

  ctx.restore();
}

/**
 * Draws Point, Text, and Area measurement annotations on the canvas.
 */
export function drawAnnotations(
  ctx: CanvasRenderingContext2D,
  tab: TabState,
  p: PlotArea,
  theme: RenderTheme = DEFAULT_THEME
): void {
  if (!tab.annotationsVisible || tab.annotations.length === 0 || tab.plotMode !== 'time') return;

  ctx.save();
  ctx.font = '11px "JetBrains Mono", monospace';

  for (const ann of tab.annotations) {
    const chId = ann.channelId || tab.activeChannelId || tab.drawOrder[0];
    const ch = tab.channels[chId];
    if (!ch) continue;
    const area = getChannelPlotArea(tab, ch.id, p);

    if (ann.type === 'point') {
      const pt = dataToScreen({ time: ann.x, voltage: ann.y }, tab, ch.id, area);
      if (pt.x < area.x || pt.x > area.x + area.width || pt.y < area.y || pt.y > area.y + area.height) {
        continue;
      }
      ctx.fillStyle = ann.color || ch.color;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = theme.text;
      ctx.lineWidth = 1;
      ctx.stroke();

      const label = `${formatEng(ann.x, 's', 3)}, ${formatEng(ann.y, ch.unit, 2)}`;
      const tw = ctx.measureText(label).width;
      const lx = Math.min(pt.x + 8, area.x + area.width - tw - 8);
      const ly = Math.max(area.y + 18, pt.y - 8);
      ctx.fillStyle = theme.hudBg;
      ctx.fillRect(lx - 3, ly - 11, tw + 6, 14);
      ctx.strokeStyle = ann.color || ch.color;
      ctx.strokeRect(lx - 3, ly - 11, tw + 6, 14);
      ctx.fillStyle = theme.text;
      ctx.textAlign = 'left';
      ctx.fillText(label, lx, ly);
    } else if (ann.type === 'text') {
      const pt = dataToScreen({ time: ann.x, voltage: ann.y }, tab, ch.id, area);
      if (pt.x < area.x || pt.x > area.x + area.width || pt.y < area.y || pt.y > area.y + area.height) {
        continue;
      }
      const label = ann.text || 'Note';
      const tw = ctx.measureText(label).width;
      const lx = Math.min(pt.x + 10, area.x + area.width - tw - 10);
      const ly = Math.max(area.y + 20, pt.y - 16);

      ctx.strokeStyle = theme.isLight ? '#d97706' : '#fbbf24';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pt.x, pt.y);
      ctx.lineTo(lx, ly - 3);
      ctx.stroke();

      ctx.fillStyle = theme.hudBg;
      ctx.fillRect(lx - 4, ly - 12, tw + 8, 16);
      ctx.strokeRect(lx - 4, ly - 12, tw + 8, 16);
      ctx.fillStyle = theme.isLight ? '#92400e' : '#fde68a';
      ctx.textAlign = 'left';
      ctx.fillText(label, lx, ly);
    } else if (ann.type === 'area' && ann.x2 !== undefined && ann.y2 !== undefined) {
      const p1 = dataToScreen({ time: ann.x, voltage: ann.y }, tab, ch.id, area);
      const p2 = dataToScreen({ time: ann.x2, voltage: ann.y2 }, tab, ch.id, area);
      const rx = Math.max(area.x, Math.min(p1.x, p2.x));
      const ry = Math.max(area.y, Math.min(p1.y, p2.y));
      const rw = Math.min(area.x + area.width, Math.max(p1.x, p2.x)) - rx;
      const rh = Math.min(area.y + area.height, Math.max(p1.y, p2.y)) - ry;
      if (rw <= 2 || rh <= 2) continue;

      ctx.fillStyle = 'rgba(52, 211, 153, 0.12)';
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = theme.peak;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);

      const dT = Math.abs(ann.x2 - ann.x);
      const dV = Math.abs(ann.y2 - ann.y);
      const lbl = `ΔT:${formatEng(dT, 's', 2)} ΔV:${formatEng(dV, ch.unit, 2)}`;
      const tw = ctx.measureText(lbl).width;
      const lx = Math.min(rx + 4, area.x + area.width - tw - 6);
      const ly = Math.max(area.y + 14, ry + 14);
      ctx.fillStyle = theme.hudBg;
      ctx.fillRect(lx - 2, ly - 10, tw + 6, 13);
      ctx.fillStyle = theme.peak;
      ctx.textAlign = 'left';
      ctx.fillText(lbl, lx + 1, ly);
    }
  }

  ctx.restore();
}

/**
 * Draws Axis numerical graduation labels, per-subplot Y-scales in Separate mode, and engineering units.
 */
export function drawAxisLabels(
  ctx: CanvasRenderingContext2D,
  p: PlotArea,
  tab: TabState,
  theme: RenderTheme,
  xDivs: number = HORIZONTAL_DIVISIONS,
  yDivs: number = VERTICAL_DIVISIONS,
  cachedSpectrum?: SpectrumResult | null
): void {
  ctx.save();
  ctx.fillStyle = theme.axisText;
  ctx.font = '10.5px "JetBrains Mono", monospace';

  if (tab.plotMode === 'frequency') {
    const targetId = tab.selectedFftChannelId || tab.drawOrder[0];
    const targetCh = tab.channels[targetId] || tab.channels[tab.drawOrder[0]];
    const nyquist = (targetCh?.fs || 1e5) / 2;
    const minF = Math.max(0, tab.view.fMin ?? 0);
    const maxF = Math.min(nyquist, tab.view.fMax ?? nyquist);
    const fSpan = Math.max(1, maxF - minFreqSafe(minF, maxF));

    for (let i = 0; i <= xDivs; i++) {
      const f = minF + (i / xDivs) * fSpan;
      const x = p.x + (i * p.width) / xDivs;
      const label = formatEng(f, 'Hz', 2);
      ctx.textAlign = i === 0 ? 'left' : i === xDivs ? 'right' : 'center';
      ctx.fillText(label, x, p.y + p.height + 18);
    }

    const scaleMode = tab.fftOptions.scale;
    const yMin =
      scaleMode === 'magnitude'
        ? cachedSpectrum?.magYMin ?? 0
        : cachedSpectrum?.dbYMin ?? cachedSpectrum?.yMin ?? -120;
    const yMax =
      scaleMode === 'magnitude'
        ? cachedSpectrum?.magYMax ?? 1
        : cachedSpectrum?.dbYMax ?? cachedSpectrum?.yMax ?? 20;
    const ySpan = Math.max(0.1, yMax - yMin);

    for (let j = 0; j <= yDivs; j++) {
      const val = yMax - (j / yDivs) * ySpan;
      const y = p.y + (j * p.height) / yDivs;
      ctx.textAlign = 'right';
      if (scaleMode === 'magnitude') {
        ctx.fillText(formatEng(val, targetCh?.unit || 'V', 2), p.x - 8, y + 3);
      } else {
        ctx.fillText(`${val.toFixed(0)} dB`, p.x - 8, y + 3);
      }
    }
    ctx.restore();
    return;
  }

  if (tab.plotMode === 'xy') {
    const xCh = tab.channels[tab.xyConfig?.xChannelId || tab.drawOrder[0]];
    const yCh = tab.channels[tab.xyConfig?.yChannelId || tab.drawOrder[1] || tab.drawOrder[0]];
    if (xCh && yCh) {
      const bounds = getXYPlotBounds(tab, xCh, yCh);
      const xSpan = Math.max(1e-9, bounds.xMax - bounds.xMin);
      const ySpan = Math.max(1e-9, bounds.yMax - bounds.yMin);

      for (let i = 0; i <= xDivs; i++) {
        const val = bounds.xMin + (i / xDivs) * xSpan;
        const x = p.x + (i * p.width) / xDivs;
        ctx.textAlign = i === 0 ? 'left' : i === xDivs ? 'right' : 'center';
        ctx.fillStyle = xCh.color;
        ctx.fillText(formatEng(val, xCh.unit, 2), x, p.y + p.height + 18);
      }

      for (let j = 0; j <= yDivs; j++) {
        const val = bounds.yMax - (j / yDivs) * ySpan;
        const y = p.y + (j * p.height) / yDivs;
        ctx.textAlign = 'right';
        ctx.fillStyle = yCh.color;
        ctx.fillText(formatEng(val, yCh.unit, 2), p.x - 10, y + 3);
      }
    }
    ctx.restore();
    return;
  }

  // Time Axis Labels on bottom
  const primaryCh = tab.channels[tab.drawOrder[0]];
  const { tStart, tSpan } = getTimeBoundsForView(tab, primaryCh);

  for (let i = 0; i <= xDivs; i++) {
    const t = tStart + (i / xDivs) * tSpan;
    const x = p.x + (i * p.width) / xDivs;
    const label = formatEng(t, 's', 2);
    ctx.textAlign = i === 0 ? 'left' : i === xDivs ? 'right' : 'center';
    ctx.fillStyle = theme.axisText;
    ctx.fillText(label, x, p.y + p.height + 18);
  }

  const visibleChs = tab.drawOrder
    .map((id) => tab.channels[id])
    .filter((c) => c && c.visible);

  if (tab.separateView && visibleChs.length > 1) {
    // Separate mode: Each subplot gets its own exact Y-axis graduation & telemetry header
    const rects = getSubplotRects(p, visibleChs, true);
    rects.forEach((rect) => {
      const ch = rect.channel;
      const area = rect.area;
      ensureChannelScaleOffset(ch);
      syncChannelBoundsFromScaleOffset(ch);

      const vMin = ch.vMin;
      const vMax = ch.vMax;
      const vSpan = vMax - vMin || 1;
      const ticks = area.height >= 120 ? 4 : 2;

      for (let j = 0; j <= ticks; j++) {
        const val = vMax - (j / ticks) * vSpan;
        const y = area.y + (j * area.height) / ticks;
        ctx.textAlign = 'right';
        ctx.fillStyle = ch.color;
        ctx.fillText(formatEng(val, ch.unit, 1), area.x - 20, y + 3);
      }

      // Per-subplot corner channel header
      const chIdx = tab.drawOrder.indexOf(ch.id);
      const computed = isComputedChannel(ch);
      const tag = computed ? `[${ch.derivedBadge || 'fx'}]` : `CH${chIdx + 1}`;
      const grpPrefix = ch.compareGroupName ? `[${ch.compareGroupName}] ` : '';
      const vDivStr = formatEng(ch.voltsPerDiv || vSpan / 8, ch.unit, 1);
      const offStr = formatEng(ch.vOffset || 0, ch.unit, 2);
      const flags = `${ch.coupling || 'DC'}${ch.inverted ? ' · INV' : ''}`;
      const header = `${grpPrefix}${tag} ${ch.name}  |  ${vDivStr}/div  |  Pos:${offStr}  |  ${flags}`;

      ctx.font = '600 10px "JetBrains Mono", monospace';
      const tw = ctx.measureText(header).width;
      const hx = area.x + 6;
      const hy = area.y + 4;
      ctx.fillStyle = theme.hudBg;
      ctx.fillRect(hx, hy, tw + 12, 16);
      ctx.strokeStyle = ch.compareGroupColor || (ch.id === tab.activeChannelId ? ch.color : theme.hudBorder);
      ctx.lineWidth = 1;
      ctx.strokeRect(hx, hy, tw + 12, 16);
      if (ch.compareGroupColor) {
        ctx.fillStyle = ch.compareGroupColor;
        ctx.fillRect(hx, hy, 3, 16);
      } else if (computed) {
        ctx.save();
        ctx.strokeStyle = ch.color;
        ctx.setLineDash([4, 2]);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(hx + 2, hy + 15);
        ctx.lineTo(hx + tw + 10, hy + 15);
        ctx.stroke();
        ctx.restore();
      }

      ctx.textAlign = 'left';
      ctx.fillStyle = ch.color;
      ctx.fillText(header, hx + 6, hy + 11);
    });
  } else {
    // Overlap mode: Y-axis graduation corresponds to active channel
    const targetId =
      tab.activeChannelId ||
      tab.selectedMeasurementChannelId ||
      visibleChs[0]?.id ||
      tab.drawOrder[0];
    const activeCh = tab.channels[targetId] || visibleChs[0] || primaryCh;

    if (activeCh) {
      ensureChannelScaleOffset(activeCh);
      syncChannelBoundsFromScaleOffset(activeCh);
      const vMin = activeCh.vMin;
      const vMax = activeCh.vMax;
      const vSpan = vMax - vMin;

      for (let j = 0; j <= yDivs; j++) {
        const v = vMax - (j / yDivs) * vSpan;
        const y = p.y + (j * p.height) / yDivs;
        ctx.textAlign = 'right';
        ctx.fillStyle = activeCh.color;
        ctx.fillText(formatEng(v, activeCh.unit, 2), p.x - 22, y + 3);
      }
    }
  }

  ctx.restore();
}

/**
 * Draws a compact, scannable top-left trace legend in Overlap time-domain mode,
 * distinguishing Solid Raw Signals from Dashed [fx] Computed/Derived traces.
 * Returns the bottom Y coordinate of the rendered legend box.
 */
export function drawOverlapTraceLegend(
  ctx: CanvasRenderingContext2D,
  tab: TabState,
  p: PlotArea,
  theme: RenderTheme = DEFAULT_THEME
): number {
  if (tab.plotMode !== 'time' || tab.separateView) return p.y + 8;

  const visibleChs = tab.drawOrder
    .map((id) => tab.channels[id])
    .filter((c) => c && c.visible && !c.compareGroupId);
  if (visibleChs.length === 0) return p.y + 8;

  const maxRows = Math.min(visibleChs.length, 8);
  const hiddenMore = Math.max(0, visibleChs.length - maxRows);
  const rows = visibleChs.slice(0, maxRows);

  ctx.save();
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';

  let maxW = 140;
  const entries = rows.map((ch) => {
    const computed = isComputedChannel(ch);
    const badge = computed ? `[${ch.derivedBadge || 'fx'}] ` : '';
    const vDivStr = ch.voltsPerDiv ? ` (${formatEng(ch.voltsPerDiv, ch.unit, 1)}/d)` : '';
    const lbl = `${badge}${ch.name}${vDivStr}`;
    const w = ctx.measureText(lbl).width + 32;
    if (w > maxW) maxW = w;
    return { ch, computed, lbl };
  });

  const boxW = Math.min(280, maxW + 8);
  const lineH = 14;
  const totalLines = entries.length + (hiddenMore > 0 ? 1 : 0);
  const boxH = 8 + totalLines * lineH;
  const bx = p.x + 8;
  const by = p.y + 8;

  if (by + boxH > p.y + p.height - 14) {
    ctx.restore();
    return p.y + 8;
  }

  ctx.fillStyle = theme.hudBg;
  ctx.fillRect(bx, by, boxW, boxH);
  ctx.strokeStyle = theme.hudBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(bx, by, boxW, boxH);

  entries.forEach((item, idx) => {
    const ry = by + 13 + idx * lineH;
    const isAct = item.ch.id === tab.activeChannelId;

    ctx.save();
    ctx.strokeStyle = item.ch.color;
    ctx.lineWidth = isAct ? 2.4 : 1.8;
    if (item.computed) {
      ctx.setLineDash([4, 2]);
    }
    ctx.beginPath();
    ctx.moveTo(bx + 8, ry - 3.5);
    ctx.lineTo(bx + 22, ry - 3.5);
    ctx.stroke();
    ctx.restore();

    ctx.font = isAct ? '700 10px "JetBrains Mono", monospace' : '500 10px "JetBrains Mono", monospace';
    ctx.fillStyle = isAct ? theme.text : theme.axisText;
    let drawText = item.lbl;
    while (drawText.length > 6 && ctx.measureText(drawText).width > boxW - 34) {
      drawText = drawText.slice(0, -2) + '…';
    }
    ctx.fillText(drawText, bx + 26, ry);
  });

  if (hiddenMore > 0) {
    const ry = by + 13 + entries.length * lineH;
    ctx.fillStyle = theme.axisText;
    ctx.fillText(`+${hiddenMore} more traces`, bx + 26, ry);
  }

  ctx.restore();
  return by + boxH;
}

/**
 * Draws a compact Compare Group Legend in Overlap time-domain mode so all traces
 * belonging to the same comparison group can be visually identified at a glance.
 */
export function drawCompareGroupLegend(
  ctx: CanvasRenderingContext2D,
  tab: TabState,
  p: PlotArea,
  theme: RenderTheme = DEFAULT_THEME,
  yStart?: number
): void {
  if (tab.plotMode !== 'time' || tab.separateView) return;

  const grouped = new Map<
    string,
    { groupName: string; groupColor: string; channels: WaveformChannel[] }
  >();

  for (const id of tab.drawOrder) {
    const ch = tab.channels[id];
    if (!ch || !ch.visible || !ch.compareGroupId) continue;
    let entry = grouped.get(ch.compareGroupId);
    if (!entry) {
      entry = {
        groupName: ch.compareGroupName || 'CMP',
        groupColor: ch.compareGroupColor || ch.color,
        channels: [],
      };
      grouped.set(ch.compareGroupId, entry);
    }
    entry.channels.push(ch);
  }

  if (grouped.size === 0) return;

  ctx.save();
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';

  let curY = yStart && yStart > p.y + 8 ? yStart : p.y + 8;
  const maxBoxBottom = p.y + p.height - 16;

  grouped.forEach((grp) => {
    if (curY + 26 > maxBoxBottom) return;
    const rows = grp.channels.slice(0, 8);
    const hiddenMore = Math.max(0, grp.channels.length - rows.length);
    const headerText = `[${grp.groupName}] Compare Group (${grp.channels.length})`;
    let maxW = ctx.measureText(headerText).width + 18;

    const rowLabels = rows.map((ch) => {
      const roleTag =
        ch.compareRole === 'target' ? 'BASE ' : ch.compareRole === 'diff' ? 'DIFF ' : '';
      const cleanName = ch.name.startsWith(`[${grp.groupName}] `)
        ? ch.name.slice(grp.groupName.length + 3)
        : ch.name;
      const lbl = `${roleTag}${cleanName}`;
      const w = ctx.measureText(lbl).width + 26;
      if (w > maxW) maxW = w;
      return { ch, lbl };
    });

    const boxW = Math.min(260, Math.max(150, maxW + 10));
    const lineH = 14;
    const totalLines = 1 + rowLabels.length + (hiddenMore > 0 ? 1 : 0);
    const boxH = 8 + totalLines * lineH;

    const bx = p.x + 8;
    const by = curY;

    ctx.fillStyle = theme.hudBg;
    ctx.fillRect(bx, by, boxW, boxH);
    ctx.strokeStyle = theme.hudBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, boxW, boxH);

    // Group color stripe on left edge
    ctx.fillStyle = grp.groupColor;
    ctx.fillRect(bx, by, 3.5, boxH);

    // Header
    ctx.font = '600 10px "JetBrains Mono", monospace';
    ctx.fillStyle = grp.groupColor;
    ctx.fillText(headerText, bx + 9, by + 13);

    // Member rows
    ctx.font = '10px "JetBrains Mono", monospace';
    rowLabels.forEach((item, idx) => {
      const ry = by + 13 + (idx + 1) * lineH;
      // Line swatch
      ctx.save();
      ctx.strokeStyle = item.ch.color;
      ctx.lineWidth = 2.0;
      if (isComputedChannel(item.ch)) {
        ctx.setLineDash(
          item.ch.compareRole === 'diff' || item.ch.derivedKind === 'diff' ? [2, 2] : [4, 2]
        );
      }
      ctx.beginPath();
      ctx.moveTo(bx + 9, ry - 3);
      ctx.lineTo(bx + 21, ry - 3);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = item.ch.id === tab.activeChannelId ? theme.text : theme.axisText;
      let drawText = item.lbl;
      while (drawText.length > 6 && ctx.measureText(drawText).width > boxW - 30) {
        drawText = drawText.slice(0, -2) + '…';
      }
      ctx.fillText(drawText, bx + 25, ry);
    });

    if (hiddenMore > 0) {
      const ry = by + 13 + (rowLabels.length + 1) * lineH;
      ctx.fillStyle = theme.axisText;
      ctx.fillText(`+${hiddenMore} more in group`, bx + 25, ry);
    }

    curY += boxH + 6;
  });

  ctx.restore();
}

function minFreqSafe(minF: number, maxF: number): number {
  return maxF > minF ? minF : 0;
}

function escapeSvgText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Generates an accurate SVG string of the current oscilloscope waveform/spectrum view.
 */
export function generateWaveformSVG(
  tab: TabState,
  width: number,
  height: number,
  theme: RenderTheme = DEFAULT_THEME,
  cachedSpectrum?: SpectrumResult | null
): string {
  const { plotArea: p } = getDynamicPlotArea(tab, width, height, { cachedSpectrum });
  const fontStack = `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  const textStyle = `font-family:${fontStack};font-size:10.5px;font-variant-numeric:tabular-nums;`;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="background:${theme.bg};font-family:${fontStack};font-variant-numeric:tabular-nums;">`
  );
  parts.push(
    `<rect x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}" fill="${theme.bg}" stroke="${theme.frame || '#334155'}" stroke-width="1"/>`
  );

  // Grid
  for (let i = 1; i < 10; i++) {
    const x = p.x + (i * p.width) / 10;
    parts.push(`<line x1="${x}" y1="${p.y}" x2="${x}" y2="${p.y + p.height}" stroke="${theme.grid}" stroke-width="1"/>`);
  }
  for (let j = 1; j < 8; j++) {
    const y = p.y + (j * p.height) / 8;
    parts.push(`<line x1="${p.x}" y1="${y}" x2="${p.x + p.width}" y2="${y}" stroke="${theme.grid}" stroke-width="1"/>`);
  }

  if (tab.plotMode === 'frequency' && cachedSpectrum) {
    const targetId = tab.selectedFftChannelId || tab.drawOrder[0];
    const targetCh = tab.channels[targetId] || tab.channels[tab.drawOrder[0]];
    const freqs = cachedSpectrum.frequencies;
    const scaleMode = tab.fftOptions.scale;
    const vals = scaleMode === 'db' ? cachedSpectrum.dbValues : cachedSpectrum.magnitudes;
    const nyquist = freqs[freqs.length - 1] || 1;
    const minF = Math.max(0, tab.view.fMin ?? 0);
    const maxF = Math.min(nyquist, tab.view.fMax ?? nyquist);
    const fSpan = Math.max(1, maxF - minF);
    const yMin = scaleMode === 'magnitude' ? cachedSpectrum.magYMin ?? 0 : cachedSpectrum.dbYMin ?? cachedSpectrum.yMin ?? -120;
    const yMax = scaleMode === 'magnitude' ? cachedSpectrum.magYMax ?? 1 : cachedSpectrum.dbYMax ?? cachedSpectrum.yMax ?? 20;
    const ySpan = Math.max(0.1, yMax - yMin);

    const df = freqs[1] - freqs[0];
    const startBin = df > 0 ? Math.max(0, Math.floor(minF / df)) : 0;
    const endBin = df > 0 ? Math.min(freqs.length - 1, Math.ceil(maxF / df)) : freqs.length - 1;
    const spanBins = Math.max(1, endBin - startBin + 1);
    const stride = Math.max(1, Math.floor(spanBins / 2000));

    const pts: string[] = [];
    for (let i = startBin; i <= endBin; i += stride) {
      let pickIdx = i;
      if (stride > 1) {
        let bestVal = -Infinity;
        const lim = Math.min(endBin + 1, i + stride);
        for (let k = i; k < lim; k++) {
          if (vals[k] > bestVal) {
            bestVal = vals[k];
            pickIdx = k;
          }
        }
      }
      const x = p.x + ((freqs[pickIdx] - minF) / fSpan) * p.width;
      const y = p.y + p.height - ((vals[pickIdx] - yMin) / ySpan) * p.height;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    parts.push(`<polyline fill="none" stroke="${theme.cursor}" stroke-width="1.5" points="${pts.join(' ')}"/>`);

    // SVG Frequency X/Y axis ticks
    for (let i = 0; i <= HORIZONTAL_DIVISIONS; i++) {
      const f = minF + (i / HORIZONTAL_DIVISIONS) * fSpan;
      const x = p.x + (i * p.width) / HORIZONTAL_DIVISIONS;
      const anchor = i === 0 ? 'start' : i === HORIZONTAL_DIVISIONS ? 'end' : 'middle';
      parts.push(
        `<text x="${x.toFixed(1)}" y="${(p.y + p.height + 18).toFixed(1)}" fill="${theme.axisText}" text-anchor="${anchor}" style="${textStyle}">${escapeSvgText(formatEng(f, 'Hz', 2))}</text>`
      );
    }
    for (let j = 0; j <= VERTICAL_DIVISIONS; j++) {
      const val = yMax - (j / VERTICAL_DIVISIONS) * ySpan;
      const y = p.y + (j * p.height) / VERTICAL_DIVISIONS;
      const lbl =
        scaleMode === 'magnitude' ? formatEng(val, targetCh?.unit || 'V', 2) : `${val.toFixed(0)} dB`;
      parts.push(
        `<text x="${(p.x - 8).toFixed(1)}" y="${(y + 3).toFixed(1)}" fill="${theme.axisText}" text-anchor="end" style="${textStyle}">${escapeSvgText(lbl)}</text>`
      );
    }
  } else {
    const visibleChs = tab.drawOrder.map((id) => tab.channels[id]).filter((c) => c && c.visible);
    const rects = getSubplotRects(p, visibleChs, tab.separateView);

    const primaryCh = tab.channels[tab.drawOrder[0]] || Object.values(tab.channels)[0];
    rects.forEach((rect) => {
      const ch = rect.channel;
      const area = rect.area;
      if (tab.separateView && visibleChs.length > 1) {
        parts.push(`<rect x="${area.x}" y="${area.y}" width="${area.width}" height="${area.height}" fill="none" stroke="${theme.frame || '#334155'}" stroke-width="1"/>`);
      }
      const { tStart, tSpan } = getTimeBoundsForView(tab, ch);
      const usesPrimaryIndex = !primaryCh || ch.t === primaryCh.t || ch.t.length === primaryCh.t.length;
      const rng = usesPrimaryIndex
        ? {
            startIdx: Math.max(0, tab.view.startIndex),
            endIdx: Math.min(ch.v.length, tab.view.endIndex),
          }
        : findTimeIndexRange(ch.t, tStart, tStart + tSpan);
      const startIdx = rng.startIdx;
      const endIdx = rng.endIdx;
      const step = Math.max(1, Math.floor((endIdx - startIdx) / 2000));
      const vRange = ch.vMax - ch.vMin || 1;
      const mean = ch.coupling === 'AC' ? computeChannelMean(ch) : 0;

      const pts: string[] = [];
      for (let i = startIdx; i < endIdx; i += step) {
        const val = getChannelDisplayValue(ch, i, mean);
        if (!isFinite(val)) continue;
        const x = area.x + ((ch.t[i] - tStart) / tSpan) * area.width;
        const y = area.y + area.height - ((val - ch.vMin) / vRange) * area.height;
        pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      }
      if (ch.refV && ch.hasEdits && ch.showRef !== false && ch.refV.length === ch.v.length) {
        const refPts: string[] = [];
        for (let i = startIdx; i < endIdx; i += step) {
          const raw = ch.refV[i];
          if (!isFinite(raw)) continue;
          const x = area.x + ((ch.t[i] - tStart) / tSpan) * area.width;
          const y = area.y + area.height - ((raw - ch.vMin) / vRange) * area.height;
          refPts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
        }
        parts.push(
          `<polyline fill="none" stroke="${ch.color}" stroke-opacity="0.45" stroke-dasharray="5,4" stroke-width="1.3" points="${refPts.join(' ')}"/>`
        );
      }
      const computed = isComputedChannel(ch);
      const dashAttr = computed
        ? ch.derivedKind === 'diff' || ch.compareRole === 'diff'
          ? ' stroke-dasharray="3,3"'
          : ch.derivedKind === 'ref' || ch.compareRole === 'ref'
          ? ' stroke-dasharray="6,4"'
          : ' stroke-dasharray="7,4"'
        : '';
      const opacityAttr = computed && ch.id !== tab.activeChannelId ? ' stroke-opacity="0.88"' : '';
      parts.push(`<polyline fill="none" stroke="${ch.color}"${dashAttr}${opacityAttr} stroke-width="1.5" points="${pts.join(' ')}"/>`);

      if (tab.separateView && visibleChs.length > 1) {
        const vMin = ch.vMin;
        const vMax = ch.vMax;
        const vSpan = vMax - vMin || 1;
        const ticks = area.height >= 120 ? 4 : 2;
        for (let j = 0; j <= ticks; j++) {
          const val = vMax - (j / ticks) * vSpan;
          const y = area.y + (j * area.height) / ticks;
          parts.push(
            `<text x="${(area.x - 20).toFixed(1)}" y="${(y + 3).toFixed(1)}" fill="${ch.color}" text-anchor="end" style="${textStyle}">${escapeSvgText(formatEng(val, ch.unit, 1))}</text>`
          );
        }
      }
    });

    // SVG Time X-axis labels + Overlap Y-axis labels
    if (primaryCh) {
      const { tStart, tSpan } = getTimeBoundsForView(tab, primaryCh);
      for (let i = 0; i <= HORIZONTAL_DIVISIONS; i++) {
        const t = tStart + (i / HORIZONTAL_DIVISIONS) * tSpan;
        const x = p.x + (i * p.width) / HORIZONTAL_DIVISIONS;
        const anchor = i === 0 ? 'start' : i === HORIZONTAL_DIVISIONS ? 'end' : 'middle';
        parts.push(
          `<text x="${x.toFixed(1)}" y="${(p.y + p.height + 18).toFixed(1)}" fill="${theme.axisText}" text-anchor="${anchor}" style="${textStyle}">${escapeSvgText(formatEng(t, 's', 2))}</text>`
        );
      }
    }

    if (!tab.separateView || visibleChs.length <= 1) {
      const targetId =
        tab.activeChannelId ||
        tab.selectedMeasurementChannelId ||
        visibleChs[0]?.id ||
        tab.drawOrder[0];
      const activeCh = tab.channels[targetId] || visibleChs[0] || primaryCh;
      if (activeCh) {
        ensureChannelScaleOffset(activeCh);
        syncChannelBoundsFromScaleOffset(activeCh);
        const vSpan = activeCh.vMax - activeCh.vMin;
        for (let j = 0; j <= VERTICAL_DIVISIONS; j++) {
          const v = activeCh.vMax - (j / VERTICAL_DIVISIONS) * vSpan;
          const y = p.y + (j * p.height) / VERTICAL_DIVISIONS;
          parts.push(
            `<text x="${(p.x - 22).toFixed(1)}" y="${(y + 3).toFixed(1)}" fill="${activeCh.color}" text-anchor="end" style="${textStyle}">${escapeSvgText(formatEng(v, activeCh.unit, 2))}</text>`
          );
        }
      }
    }
  }

  parts.push('</svg>');
  return parts.join('\n');
}

/**
 * Formats an automated measurement value consistently for both the DOM capsule strip and PNG exports.
 */
export function formatMeasurementMetricValue(
  m: ChannelMeasurements,
  def: MeasurementDefinition,
  signalUnit: string
): string {
  const raw = m[def.key];
  if (raw === null || raw === undefined || !isFinite(raw)) return 'N/A';

  if (def.unitType === 'percent') {
    return `${raw.toFixed(1)}%`;
  }
  if (def.unitType === 'freq') {
    return formatEng(raw, 'Hz', 3);
  }
  if (def.unitType === 'time') {
    return formatEng(raw, 's', 3);
  }
  return formatEng(raw, signalUnit, 3);
}

/**
 * Draws the active user-checked measurement cards strip cleanly onto a target canvas context (used by PNG screenshot export).
 */
export function drawMeasurementStripOnCanvas(
  ctx: CanvasRenderingContext2D,
  tab: TabState,
  width: number,
  yStart: number,
  measByChannel: Record<string, ChannelMeasurements>,
  theme: RenderTheme = DEFAULT_THEME
): number {
  const items = tab.selectedMeasurements || [];
  if (items.length === 0) return 0;

  const padX = 16;
  const cardH = 38;
  const gap = 8;
  let curX = padX;
  let curY = yStart + 6;
  const maxRight = width - padX;

  ctx.save();
  for (const item of items) {
    const ch = tab.channels[item.channelId];
    const def = MEASUREMENT_DEFINITIONS.find((d) => d.key === item.metric);
    const meas = measByChannel[item.channelId];
    if (!ch || !def || !meas) continue;

    const valStr = formatMeasurementMetricValue(meas, def, ch.unit);
    const titleStr = `${ch.name} · ${def.shortLabel}`;

    ctx.font = '10px "IBM Plex Sans", sans-serif';
    const titleW = ctx.measureText(titleStr).width;
    ctx.font = '600 12px "JetBrains Mono", monospace';
    const valW = ctx.measureText(valStr).width;
    const cardW = Math.max(106, Math.ceil(Math.max(titleW, valW) + 22));

    if (curX + cardW > maxRight && curX > padX) {
      curX = padX;
      curY += cardH + 6;
    }

    ctx.fillStyle = theme.headerBg || '#12161c';
    ctx.fillRect(curX, curY, cardW, cardH);
    ctx.strokeStyle = theme.hudBorder || '#222933';
    ctx.lineWidth = 1;
    ctx.strokeRect(curX, curY, cardW, cardH);

    // Top 2px channel color bar
    ctx.fillStyle = ch.color;
    ctx.fillRect(curX, curY, cardW, 2);

    ctx.textAlign = 'left';
    ctx.font = '10px "IBM Plex Sans", sans-serif';
    ctx.fillStyle = theme.axisText || '#94a3b8';
    ctx.fillText(titleStr, curX + 8, curY + 14);

    ctx.font = '600 12px "JetBrains Mono", monospace';
    ctx.fillStyle = theme.text || '#f1f5f9';
    ctx.fillText(valStr, curX + 8, curY + 30);

    curX += cardW + gap;
  }
  ctx.restore();

  return curY + cardH + 8 - yStart;
}

function resolveXYSliceIndices(
  tab: TabState,
  xCh: WaveformChannel,
  yCh: WaveformChannel
): { iStart: number; iEnd: number } {
  const n = Math.min(xCh.v.length, yCh.v.length);
  if (n <= 0) return { iStart: 0, iEnd: 0 };
  const rangeMode = tab.xyConfig?.range || 'view';
  if (rangeMode === 'entire') {
    return { iStart: 0, iEnd: n };
  }
  if (
    rangeMode === 'cursors' &&
    tab.cursors.enabled &&
    tab.cursors.x1 !== null &&
    tab.cursors.x2 !== null
  ) {
    const tMin = Math.min(tab.cursors.x1, tab.cursors.x2);
    const tMax = Math.max(tab.cursors.x1, tab.cursors.x2);
    let s = 0;
    while (s < xCh.t.length && xCh.t[s] < tMin) s++;
    let e = s;
    while (e < xCh.t.length && xCh.t[e] <= tMax) e++;
    return { iStart: Math.min(s, n - 1), iEnd: Math.min(Math.max(s + 1, e), n) };
  }
  const s = Math.max(0, Math.min(n - 1, tab.view.startIndex));
  const e = Math.max(s + 1, Math.min(n, tab.view.endIndex));
  return { iStart: s, iEnd: e };
}

export function getXYPlotBounds(
  tab: TabState,
  xCh: WaveformChannel,
  yCh: WaveformChannel
): { xMin: number; xMax: number; yMin: number; yMax: number; iStart: number; iEnd: number } {
  const { iStart, iEnd } = resolveXYSliceIndices(tab, xCh, yCh);
  const metrics = computeXYMetrics(xCh, yCh, iStart, iEnd);
  const xSpan = Math.max(1e-6, metrics.xMax - metrics.xMin);
  const ySpan = Math.max(1e-6, metrics.yMax - metrics.yMin);
  const xPad = xSpan * 0.12;
  const yPad = ySpan * 0.12;
  return {
    xMin: metrics.xMin - xPad,
    xMax: metrics.xMax + xPad,
    yMin: metrics.yMin - yPad,
    yMax: metrics.yMax + yPad,
    iStart,
    iEnd,
  };
}

/**
 * Renders Lissajous XY Trajectory Plot inside the oscilloscope graticule.
 */
export function drawXYPlot(
  ctx: CanvasRenderingContext2D,
  tab: TabState,
  p: PlotArea,
  theme: RenderTheme
): void {
  const xId = tab.xyConfig?.xChannelId || tab.drawOrder[0];
  const yId = tab.xyConfig?.yChannelId || tab.drawOrder[1] || tab.drawOrder[0];
  const xCh = tab.channels[xId];
  const yCh = tab.channels[yId];
  if (!xCh || !yCh) return;

  const bounds = getXYPlotBounds(tab, xCh, yCh);
  const { xMin, xMax, yMin, yMax, iStart, iEnd } = bounds;
  const xSpan = Math.max(1e-9, xMax - xMin);
  const ySpan = Math.max(1e-9, yMax - yMin);

  ctx.save();
  ctx.beginPath();
  ctx.rect(p.x, p.y, p.width, p.height);
  ctx.clip();

  // Origin 0,0 subtle axis lines if in view
  if (0 >= xMin && 0 <= xMax) {
    const ox = p.x + ((0 - xMin) / xSpan) * p.width;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(ox, p.y);
    ctx.lineTo(ox, p.y + p.height);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (0 >= yMin && 0 <= yMax) {
    const oy = p.y + p.height - ((0 - yMin) / ySpan) * p.height;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(p.x, oy);
    ctx.lineTo(p.x + p.width, oy);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const xMean = xCh.coupling === 'AC' ? computeChannelMean(xCh) : 0;
  const yMean = yCh.coupling === 'AC' ? computeChannelMean(yCh) : 0;
  const totalCount = Math.max(0, iEnd - iStart);
  const stride = totalCount > 24000 ? Math.ceil(totalCount / 24000) : 1;

  ctx.strokeStyle = theme.cursor;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let penDown = false;
  let firstPx: { x: number; y: number } | null = null;
  let lastPx: { x: number; y: number } | null = null;

  for (let i = iStart; i < iEnd; i += stride) {
    const xv = getChannelDisplayValue(xCh, i, xMean);
    const yv = getChannelDisplayValue(yCh, i, yMean);
    if (!isFinite(xv) || !isFinite(yv)) {
      penDown = false;
      continue;
    }
    const px = p.x + ((xv - xMin) / xSpan) * p.width;
    const py = p.y + p.height - ((yv - yMin) / ySpan) * p.height;
    if (!penDown) {
      ctx.moveTo(px, py);
      penDown = true;
    } else {
      ctx.lineTo(px, py);
    }
    if (!firstPx) firstPx = { x: px, y: py };
    lastPx = { x: px, y: py };
  }
  ctx.stroke();

  if (firstPx) {
    ctx.fillStyle = theme.peak;
    ctx.beginPath();
    ctx.arc(firstPx.x, firstPx.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  if (lastPx) {
    ctx.fillStyle = theme.trigger;
    ctx.beginPath();
    ctx.arc(lastPx.x, lastPx.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  const metrics = computeXYMetrics(xCh, yCh, iStart, iEnd);
  const lines = [
    `XY: ${xCh.name} (X) vs ${yCh.name} (Y)`,
    `Pts: ${metrics.sampleCount.toLocaleString()}`,
    `Circularity: ${metrics.circularityPct !== null ? metrics.circularityPct.toFixed(1) + '%' : '--'}`,
    `Lissajous ΔΦ: ${metrics.lissajousPhaseDeg !== null ? metrics.lissajousPhaseDeg.toFixed(1) + '°' : '--'}`,
  ];

  ctx.font = '11px "JetBrains Mono", monospace';
  let maxW = 0;
  for (const ln of lines) {
    const w = ctx.measureText(ln).width;
    if (w > maxW) maxW = w;
  }
  const bx = p.x + p.width - maxW - 24;
  const by = p.y + 8;
  ctx.fillStyle = theme.hudBg;
  ctx.fillRect(bx, by, maxW + 16, lines.length * 15 + 10);
  ctx.strokeStyle = theme.hudBorder;
  ctx.strokeRect(bx, by, maxW + 16, lines.length * 15 + 10);
  ctx.textAlign = 'left';
  lines.forEach((ln, idx) => {
    ctx.fillStyle = idx === 0 ? theme.cursor : theme.text;
    ctx.fillText(ln, bx + 8, by + 15 + idx * 15);
  });

  ctx.restore();
}

/**
 * Draws the Golden Reference tolerance envelope band and highlights out-of-tolerance sample markers.
 */
export function drawGoldenToleranceBand(
  ctx: CanvasRenderingContext2D,
  tab: TabState,
  ch: WaveformChannel,
  p: PlotArea,
  goldenEval: GoldenEvaluationResult,
  subPlotArea?: PlotArea
): void {
  const cfg = tab.goldenBand;
  if (!cfg || !cfg.enabled || cfg.channelId !== ch.id) return;
  const refV = cfg.refV || ch.refV;
  if (!refV || refV.length === 0) return;

  const area = subPlotArea || p;
  ensureChannelScaleOffset(ch);
  syncChannelBoundsFromScaleOffset(ch);

  const vMin = ch.vMin;
  const vMax = ch.vMax;
  const vRange = vMax - vMin || 1;
  const { tStart, tSpan } = getTimeBoundsForView(tab, ch);

  const n = Math.min(ch.t.length, refV.length);
  const startIdx = Math.max(0, Math.min(n - 1, tab.view.startIndex));
  const endIdx = Math.max(startIdx + 1, Math.min(n, tab.view.endIndex));
  const step = Math.max(1, Math.floor((endIdx - startIdx) / Math.max(200, Math.round(area.width))));
  const half = goldenEval.bandHalfWidth;

  ctx.save();
  ctx.beginPath();
  ctx.rect(area.x, area.y, area.width, area.height);
  ctx.clip();

  // Build shaded tolerance envelope polygon
  const upperPts: Array<{ x: number; y: number }> = [];
  const lowerPts: Array<{ x: number; y: number }> = [];

  for (let i = startIdx; i < endIdx; i += step) {
    const rv = refV[i];
    if (!isFinite(rv)) continue;
    const x = area.x + ((ch.t[i] - tStart) / tSpan) * area.width;
    const yUp = area.y + area.height - ((rv + half - vMin) / vRange) * area.height;
    const yLo = area.y + area.height - ((rv - half - vMin) / vRange) * area.height;
    upperPts.push({ x, y: yUp });
    lowerPts.push({ x, y: yLo });
  }

  if (upperPts.length > 1) {
    ctx.fillStyle = 'rgba(16, 185, 129, 0.13)';
    ctx.strokeStyle = 'rgba(52, 211, 153, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(upperPts[0].x, upperPts[0].y);
    for (let i = 1; i < upperPts.length; i++) ctx.lineTo(upperPts[i].x, upperPts[i].y);
    for (let i = lowerPts.length - 1; i >= 0; i--) ctx.lineTo(lowerPts[i].x, lowerPts[i].y);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(upperPts[0].x, upperPts[0].y);
    for (let i = 1; i < upperPts.length; i++) ctx.lineTo(upperPts[i].x, upperPts[i].y);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(lowerPts[0].x, lowerPts[0].y);
    for (let i = 1; i < lowerPts.length; i++) ctx.lineTo(lowerPts[i].x, lowerPts[i].y);
    ctx.stroke();
  }

  // Highlight out-of-tolerance violation samples in crisp red
  if (goldenEval.violationIndices.length > 0) {
    const mean = ch.coupling === 'AC' ? computeChannelMean(ch) : 0;
    ctx.fillStyle = '#ef4444';
    for (const idx of goldenEval.violationIndices) {
      if (idx < startIdx || idx >= endIdx || idx >= ch.v.length) continue;
      const val = getChannelDisplayValue(ch, idx, mean);
      if (!isFinite(val)) continue;
      const vx = area.x + ((ch.t[idx] - tStart) / tSpan) * area.width;
      const vy = area.y + area.height - ((val - vMin) / vRange) * area.height;
      ctx.beginPath();
      ctx.arc(vx, vy, 2.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Pass/Fail badge inside graticule top-left
  const statusText = goldenEval.pass
    ? `GOLDEN PASS (±${formatEng(half, ch.unit, 2)})`
    : `GOLDEN FAIL · ${goldenEval.violationCount} pts out`;
  ctx.font = '600 10.5px "JetBrains Mono", monospace';
  const tw = ctx.measureText(statusText).width;
  const bx = area.x + 8;
  const by = area.y + (tab.separateView ? 24 : 8);
  ctx.fillStyle = goldenEval.pass ? 'rgba(6, 78, 59, 0.88)' : 'rgba(127, 29, 29, 0.9)';
  ctx.fillRect(bx, by, tw + 12, 17);
  ctx.strokeStyle = goldenEval.pass ? '#10b981' : '#ef4444';
  ctx.strokeRect(bx, by, tw + 12, 17);
  ctx.fillStyle = goldenEval.pass ? '#6ee7b7' : '#fecaca';
  ctx.textAlign = 'left';
  ctx.fillText(statusText, bx + 6, by + 12);

  ctx.restore();
}

/**
 * Draws detected anomaly markers within the visible time window and highlights the jumped-to target.
 */
export function drawActiveAnomalyMarkers(
  ctx: CanvasRenderingContext2D,
  tab: TabState,
  p: PlotArea,
  theme: RenderTheme = DEFAULT_THEME
): void {
  const anomalies = tab.activeAnomalies;
  if (!anomalies || anomalies.length === 0 || tab.plotMode !== 'time') return;

  const chId = tab.activeChannelId || tab.drawOrder[0];
  const ch = tab.channels[chId];
  if (!ch) return;

  const area = getChannelPlotArea(tab, ch.id, p);
  const { tStart, tEnd, tSpan } = getTimeBoundsForView(tab, ch);
  ensureChannelScaleOffset(ch);
  syncChannelBoundsFromScaleOffset(ch);
  const vMin = ch.vMin;
  const vRange = ch.vMax - vMin || 1;

  ctx.save();
  ctx.beginPath();
  ctx.rect(area.x, area.y, area.width, area.height);
  ctx.clip();

  for (let idx = 0; idx < anomalies.length; idx++) {
    const ev = anomalies[idx];
    if (ev.time < tStart || ev.time > tEnd) continue;
    const x = area.x + ((ev.time - tStart) / tSpan) * area.width;
    const y = area.y + area.height - ((ev.value - vMin) / vRange) * area.height;
    const isSelected = tab.selectedAnomalyIndex === idx;

    if (isSelected) {
      ctx.strokeStyle = 'rgba(248, 113, 113, 0.7)';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, area.y);
      ctx.lineTo(x, area.y + area.height);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.fillStyle = isSelected ? '#ef4444' : '#f59e0b';
    ctx.strokeStyle = theme.text;
    ctx.lineWidth = isSelected ? 1.5 : 1;
    ctx.beginPath();
    ctx.arc(x, Math.max(area.y + 6, Math.min(area.y + area.height - 6, y)), isSelected ? 5.5 : 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}
