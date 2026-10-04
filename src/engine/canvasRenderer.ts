/**
 * Waveform Viewer Pro - High-Performance Canvas Rendering Engine
 * Handles pixel decimation, gap breaks, time/frequency modes, cursors,
 * annotations, trigger indicators, and BLDC harmonic markers.
 */

import {
  TabState,
  WaveformChannel,
  SpectrumResult,
  HarmonicMarker,
  ViewState,
} from '../types/models';
import type { EdgeMarks } from '../modules/measurements';

export interface PlotArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderTheme {
  bg: string;
  grid: string;
  gridSub: string;
  axisText: string;
  cursor: string;
  cursorFill: string;
  trigger: string;
  harmonic: string;
  peak: string;
  text: string;
  bwTraces?: string[];
}

export const DEFAULT_THEME: RenderTheme = {
  bg: '#1e1e1e',
  grid: '#333333',
  gridSub: '#252525',
  axisText: '#a0a0a0',
  cursor: '#00e5ff',
  cursorFill: 'rgba(0, 229, 255, 0.15)',
  trigger: '#ff9100',
  harmonic: '#ff3d00',
  peak: '#76ff03',
  text: '#ffffff',
};

export const OVERLAP_COLORS = [
  '#00e5ff', // Cyan
  '#ffff00', // Yellow
  '#ff007f', // Magenta/Pink
  '#00e676', // Green
  '#ff9100', // Orange
  '#d500f9', // Purple
  '#2979ff', // Blue
  '#ffd600', // Amber
];

/**
 * Formats a value with engineering SI prefixes (s, ms, us, ns, Hz, kHz, MHz, V, mV, etc.).
 */
export function formatEng(v: number, unit: string = '', precision: number = 3): string {
  if (isNaN(v) || !isFinite(v)) return 'NaN';
  if (Math.abs(v) < 1e-15) return `0.000 ${unit}`.trim();

  const prefixes = [
    { p: 'G', factor: 1e9 },
    { p: 'M', factor: 1e6 },
    { p: 'k', factor: 1e3 },
    { p: '',  factor: 1 },
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
 * Calculates responsive plot area margins based on visible axes.
 */
export function getPlotArea(width: number, height: number): PlotArea {
  const left = 68;
  const right = 20;
  const top = 20;
  const bottom = 32;

  return {
    x: left,
    y: top,
    width: Math.max(10, width - left - right),
    height: Math.max(10, height - top - bottom),
  };
}

/** Channels that are currently drawn, in draw order. */
export function getVisibleChannels(tab: TabState): WaveformChannel[] {
  return tab.drawOrder.map((id) => tab.channels[id]).filter((c): c is WaveformChannel => !!c && c.visible);
}

/**
 * The channel the vertical axis, hover readout and measurements refer to.
 * The selected channel wins only while it is visible; otherwise the first visible one
 * is used, so hiding CH1 never leaves CH2 plotted against CH1's axis.
 */
export function getActiveChannel(tab: TabState): WaveformChannel | undefined {
  const sel = tab.selectedMeasurementChannelId ? tab.channels[tab.selectedMeasurementChannelId] : undefined;
  if (sel && sel.visible) return sel;
  const vis = getVisibleChannels(tab);
  if (vis.length) return vis[0];
  return sel || tab.channels[tab.drawOrder[0]];
}

/** Channel that provides the time axis: first visible channel, else the first channel. */
export function getTimeBaseChannel(tab: TabState): WaveformChannel | undefined {
  const vis = getVisibleChannels(tab);
  return vis[0] || tab.channels[tab.drawOrder[0]];
}

/**
 * Channel the Y cursors measure. An explicit choice is honoured while that channel is
 * visible; "Auto" (trackingChannel null / '') follows the active channel.
 */
export function getCursorChannel(tab: TabState): WaveformChannel | undefined {
  const id = tab.cursors.trackingChannel;
  const explicit = id ? tab.channels[id] : undefined;
  if (explicit && explicit.visible) return explicit;
  return getActiveChannel(tab);
}

/** Subplot rectangles when "Separate" mode is active, otherwise null. */
export function computeSubplotAreas(tab: TabState, p: PlotArea): Map<string, PlotArea> | null {
  const vis = getVisibleChannels(tab);
  if (!tab.separateView || vis.length <= 1) return null;
  const gap = 12;
  const subH = (p.height - (vis.length - 1) * gap) / vis.length;
  const map = new Map<string, PlotArea>();
  vis.forEach((ch, idx) => {
    map.set(ch.id, { x: p.x, y: p.y + idx * (subH + gap), width: p.width, height: subH });
  });
  return map;
}

/** Plot rectangle in which a channel's own vertical scale applies. */
export function getChannelArea(tab: TabState, p: PlotArea, ch: WaveformChannel): PlotArea {
  const areas = computeSubplotAreas(tab, p);
  return (areas && areas.get(ch.id)) || p;
}

/** Linear interpolation of a channel at a given time. Null when outside the record. */
export function sampleAt(ch: WaveformChannel, time: number): number | null {
  const n = ch.t.length;
  if (n === 0 || time < ch.t[0] || time > ch.t[n - 1]) return null;
  const i = timeToIndex(ch, time);
  const j = ch.t[i] > time ? i - 1 : i + 1;
  if (j < 0 || j >= n) return Number.isFinite(ch.v[i]) ? ch.v[i] : null;
  const t0 = ch.t[i], t1 = ch.t[j];
  const v0 = ch.v[i], v1 = ch.v[j];
  if (!Number.isFinite(v0)) return null;
  if (!Number.isFinite(v1) || t1 === t0) return v0;
  return v0 + ((v1 - v0) * (time - t0)) / (t1 - t0);
}

/**
 * Transforms screen coordinates to time/voltage data values.
 */
export function screenToData(
  screenPos: { x: number; y: number },
  tab: TabState,
  channelId: string,
  plotArea: PlotArea
): { time: number; voltage: number } {
  const ch = tab.channels[channelId] || Object.values(tab.channels)[0];
  if (!ch || !ch.t.length) return { time: 0, voltage: 0 };

  const startIdx = Math.max(0, Math.min(ch.t.length - 1, tab.view.startIndex));
  const endIdx = Math.max(startIdx, Math.min(ch.t.length - 1, tab.view.endIndex - 1));
  const timeStart = indexToTime(ch, startIdx);
  const timeSpan = Math.max(0, indexToTime(ch, endIdx) - timeStart);

  const timeFrac = (screenPos.x - plotArea.x) / plotArea.width;
  const time = timeStart + timeFrac * timeSpan;

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
  if (!ch || !ch.t.length) return { x: 0, y: 0 };

  const startIdx = Math.max(0, Math.min(ch.t.length - 1, tab.view.startIndex));
  const endIdx = Math.max(startIdx, Math.min(ch.t.length - 1, tab.view.endIndex - 1));
  const timeStart = indexToTime(ch, startIdx);
  const timeSpan = Math.max(0, indexToTime(ch, endIdx) - timeStart);

  const timeFrac = timeSpan > 0 ? (dataPos.time - timeStart) / timeSpan : 0;
  const x = plotArea.x + timeFrac * plotArea.width;

  const vRange = ch.vMax - ch.vMin;
  const voltFrac = vRange > 0 ? (dataPos.voltage - ch.vMin) / vRange : 0.5;
  const y = plotArea.y + plotArea.height - voltFrac * plotArea.height;

  return { x, y };
}

/**
 * True time (seconds) of a sample index, taken from the channel's real t[] array.
 *
 * Adaptive-timebase sources (PSIM / LTspice / SPICE) do not have a constant dt,
 * so time must never be reconstructed as index * dt.
 */
export function indexToTime(ch: WaveformChannel, index: number): number {
  if (!ch.t.length) return 0;
  const i = Math.max(0, Math.min(ch.t.length - 1, Math.round(index)));
  return ch.t[i];
}

/** Binary search for the sample index closest to a given time (seconds). */
export function timeToIndex(ch: WaveformChannel, time: number): number {
  const t = ch.t;
  if (!t.length) return 0;
  if (time <= t[0]) return 0;
  if (time >= t[t.length - 1]) return t.length - 1;
  let lo = 0;
  let hi = t.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < time) lo = mid + 1;
    else if (t[mid] > time) hi = mid - 1;
    else return mid;
  }
  return Math.max(0, Math.min(t.length - 1, lo));
}

/**
 * Draws standard oscilloscope background grid and division subdivisions.
 */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  p: PlotArea,
  theme: RenderTheme,
  xDivs: number = 10,
  yDivs: number = 8
): void {
  ctx.save();
  ctx.fillStyle = theme.bg;
  ctx.fillRect(p.x, p.y, p.width, p.height);

  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 1;

  // Major vertical lines
  for (let i = 0; i <= xDivs; i++) {
    const x = p.x + (i * p.width) / xDivs;
    ctx.beginPath();
    ctx.moveTo(x, p.y);
    ctx.lineTo(x, p.y + p.height);
    ctx.stroke();
  }

  // Major horizontal lines
  for (let j = 0; j <= yDivs; j++) {
    const y = p.y + (j * p.height) / yDivs;
    ctx.beginPath();
    ctx.moveTo(p.x, y);
    ctx.lineTo(p.x + p.width, y);
    ctx.stroke();
  }

  // Border outline
  ctx.strokeStyle = '#555555';
  ctx.strokeRect(p.x, p.y, p.width, p.height);
  ctx.restore();
}

/**
 * Draws Waveform with Decimation and explicit Gap handling.
 * Gaps (dt > 2.5 * medianDt or NaN) break the continuous line!
 */
export function drawChannelWaveform(
  ctx: CanvasRenderingContext2D,
  tab: TabState,
  ch: WaveformChannel,
  p: PlotArea,
  subPlotArea?: PlotArea
): void {
  if (!ch.visible || ch.v.length === 0) return;

  const area = subPlotArea || p;
  const v = ch.v;
  const t = ch.t;
  const totalN = v.length;

  const vMin = ch.vMin;
  const vMax = ch.vMax;
  const vRange = vMax - vMin || 1.0;

  const startIdx = Math.max(0, Math.min(totalN - 1, tab.view.startIndex));
  const endIdx = Math.max(startIdx + 1, Math.min(totalN, tab.view.endIndex));
  const pointsInView = endIdx - startIdx;

  if (pointsInView <= 0) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(area.x, area.y, area.width, area.height);
  ctx.clip();

  ctx.strokeStyle = ch.color;
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Real timestamps of the visible window (adaptive timebases have no constant dt).
  const viewStartTime = indexToTime(ch, startIdx);
  const viewEndTime = indexToTime(ch, Math.max(startIdx, endIdx - 1));
  const viewDuration = viewEndTime - viewStartTime || 1e-6;

  if (pointsInView > area.width * 2) {
    // Pixel-level min/max decimation
    const samplesPerPixel = pointsInView / area.width;

    ctx.beginPath();
    let wasInGap = true;

    for (let px = 0; px < area.width; px++) {
      const sStart = Math.floor(startIdx + px * samplesPerPixel);
      const sEnd = Math.min(totalN, Math.floor(startIdx + (px + 1) * samplesPerPixel));

      let colMin = Infinity;
      let colMax = -Infinity;
      let hasValid = false;
      let hasGap = false;

      for (let s = sStart; s < sEnd; s++) {
        const val = v[s];
        if (isNaN(val)) {
          // Only real missing samples (NaN) break the trace. A large solver
          // time step is NOT a gap.
          hasGap = true;
        } else {
          if (val < colMin) colMin = val;
          if (val > colMax) colMax = val;
          hasValid = true;
        }
      }

      if (!hasValid || hasGap) {
        wasInGap = true;
        continue;
      }

      const x = area.x + px;
      const yMin = area.y + area.height - ((colMin - vMin) / vRange) * area.height;
      const yMax = area.y + area.height - ((colMax - vMin) / vRange) * area.height;

      if (wasInGap) {
        ctx.moveTo(x, yMin);
        wasInGap = false;
      }

      ctx.lineTo(x, yMin);
      ctx.lineTo(x, yMax);
    }
    ctx.stroke();
  } else {
    // High-resolution sample-by-sample trace
    ctx.beginPath();
    let isDrawing = false;

    for (let i = startIdx; i < endIdx; i++) {
      const val = v[i];

      if (isNaN(val)) {
        isDrawing = false;
        continue;
      }

      const fracX = (t[i] - viewStartTime) / viewDuration;
      const x = area.x + fracX * area.width;
      const fracY = (val - vMin) / vRange;
      const y = area.y + area.height - fracY * area.height;

      if (!isDrawing) {
        ctx.moveTo(x, y);
        isDrawing = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Render sample points if highly zoomed in
    if (pointsInView < 80) {
      ctx.fillStyle = ch.color;
      for (let i = startIdx; i < endIdx; i++) {
        const val = v[i];
        if (!isNaN(val)) {
          const fracX = (t[i] - viewStartTime) / viewDuration;
          const x = area.x + fracX * area.width;
          const fracY = (val - vMin) / vRange;
          const y = area.y + area.height - fracY * area.height;
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  ctx.restore();
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
  tabView?: ViewState
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

  // Determine Y range
  let yMin = spectrum.yMin ?? (scaleMode === 'db' ? -120 : 0);
  let yMax = spectrum.yMax ?? (scaleMode === 'db' ? 20 : 1);

  if (spectrum.yMin === undefined || spectrum.yMax === undefined) {
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

  // Draw spectrum trace
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  let started = false;
  for (let i = 0; i < n; i++) {
    const f = freqs[i];
    if (f < minFreq || f > maxFreq) continue;
    const val = values[i];
    const x = p.x + ((f - minFreq) / freqSpan) * p.width;
    const y = p.y + p.height - ((val - yMin) / ySpan) * p.height;

    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();

  // Draw Spectrum title / channel banner
  ctx.font = 'bold 12px Consolas, monospace';
  ctx.fillStyle = '#00e5ff';
  ctx.fillText(
    `Spectrum FFT: ${spectrum.sourceChannelName} | Fs: ${formatEng(spectrum.sampleRate, 'S/s', 1)} | Res: ${spectrum.resolution.toFixed(2)} Hz | Span: ${formatEng(minFreq, 'Hz', 1)} ~ ${formatEng(maxFreq, 'Hz', 1)}`,
    p.x + 12,
    p.y + 18
  );

  // Draw BLDC Harmonic Markers with staggered collision-free label positioning
  if (harmonicMarkers.length > 0) {
    ctx.font = '11px Consolas, monospace';
    const sortedMarkers = [...harmonicMarkers].sort((a, b) => a.frequency - b.frequency);
    let lastMarkerX = -999;
    let staggerLevel = 0;

    for (const marker of sortedMarkers) {
      if (marker.frequency >= minFreq && marker.frequency <= maxFreq) {
        const x = p.x + ((marker.frequency - minFreq) / freqSpan) * p.width;

        // Draw vertical dashed line
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = theme.harmonic;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x, p.y);
        ctx.lineTo(x, p.y + p.height);
        ctx.stroke();
        ctx.restore();

        // Stagger labels if markers are within 65px horizontally
        if (Math.abs(x - lastMarkerX) < 65) {
          staggerLevel = (staggerLevel + 1) % 3;
        } else {
          staggerLevel = 0;
        }
        lastMarkerX = x;

        const labelY = p.y + 16 + staggerLevel * 18;
        const tw = ctx.measureText(marker.label).width;
        const lx = Math.min(x + 4, p.x + p.width - tw - 6);

        // Draw background pill to prevent text clash with grid lines
        ctx.fillStyle = 'rgba(25, 25, 25, 0.85)';
        ctx.fillRect(lx - 2, labelY - 11, tw + 6, 14);

        ctx.fillStyle = theme.harmonic;
        ctx.fillText(marker.label, lx + 1, labelY);
      }
    }
  }

  // Draw Detected Spectral Peaks with collision-free badges
  ctx.font = '11px Consolas, monospace';
  const visiblePeaks = spectrum.peaks.filter(
    (peak) => peak.frequency >= minFreq && peak.frequency <= maxFreq
  );

  for (let idx = 0; idx < visiblePeaks.length; idx++) {
    const peak = visiblePeaks[idx];
    const x = p.x + ((peak.frequency - minFreq) / freqSpan) * p.width;
    const peakVal = scaleMode === 'db' ? peak.db : peak.magnitude;
    const y = p.y + p.height - ((peakVal - yMin) / ySpan) * p.height;

    // Peak triangle pointer
    ctx.fillStyle = peak.isFundamental ? '#ffea00' : theme.peak;
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x - 5, y - 13);
    ctx.lineTo(x + 5, y - 13);
    ctx.closePath();
    ctx.fill();

    // Peak label formatting
    const magText = scaleMode === 'db' ? `${peak.db.toFixed(1)} dB` : formatEng(peak.magnitude, 'V', 2);
    const label = `${formatEng(peak.frequency, 'Hz', 2)} (${magText})`;
    const tw = ctx.measureText(label).width;

    // Clamp label to stay fully inside plot area
    const labelX = Math.max(p.x + 8, Math.min(p.x + p.width - tw - 8, x - tw / 2));
    const labelY = Math.max(p.y + 26, Math.min(p.y + p.height - 12, y - 16 - (idx % 2) * 14));

    // Clean background badge
    ctx.fillStyle = 'rgba(20, 20, 20, 0.88)';
    ctx.fillRect(labelX - 3, labelY - 11, tw + 6, 14);
    ctx.strokeStyle = peak.isFundamental ? '#ffea00' : theme.peak;
    ctx.lineWidth = 1;
    ctx.strokeRect(labelX - 3, labelY - 11, tw + 6, 14);

    ctx.fillStyle = peak.isFundamental ? '#ffea00' : '#ffffff';
    ctx.fillText(label, labelX, labelY);
  }

  ctx.restore();
}

/**
 * Draws the horizontal trigger level line and, when the trigger event was located,
 * a vertical marker at the trigger time with a dot on the crossing.
 */
export function drawTriggerLine(
  ctx: CanvasRenderingContext2D,
  tab: TabState,
  p: PlotArea,
  theme: RenderTheme,
  trigTime: number | null = null
): void {
  const trig = tab.triggerConfig;
  if (!trig.enabled || !trig.channelId) return;

  const ch = tab.channels[trig.channelId];
  if (!ch || !ch.visible) return;
  const area = getChannelArea(tab, p, ch);

  const vRange = ch.vMax - ch.vMin;
  if (vRange <= 0) return;

  const yFrac = (trig.level - ch.vMin) / vRange;
  if (yFrac < 0 || yFrac > 1) return;

  const y = area.y + area.height - yFrac * area.height;
  const rising = trig.type === 'rising';

  ctx.save();
  ctx.strokeStyle = theme.trigger;
  ctx.setLineDash([5, 5]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(area.x, y);
  ctx.lineTo(area.x + area.width, y);
  ctx.stroke();

  // Trigger Arrow on left axis
  ctx.setLineDash([]);
  ctx.fillStyle = theme.trigger;
  ctx.beginPath();
  ctx.moveTo(area.x - 2, y);
  ctx.lineTo(area.x - 10, y - 6);
  ctx.lineTo(area.x - 10, y + 6);
  ctx.closePath();
  ctx.fill();

  ctx.font = '10px Consolas, monospace';
  ctx.fillStyle = theme.trigger;
  ctx.textAlign = 'left';
  ctx.fillText(`T${rising ? '↑' : '↓'} ${formatEng(trig.level, ch.unit, 3)} [${ch.name}]`, area.x + 8, y - 4);

  // Trigger event marker
  if (trigTime !== null && ch.t.length > 1) {
    const startIdx = Math.max(0, Math.min(ch.t.length - 1, tab.view.startIndex));
    const endIdx = Math.max(startIdx, Math.min(ch.t.length - 1, tab.view.endIndex - 1));
    const t0 = indexToTime(ch, startIdx);
    const dur = indexToTime(ch, endIdx) - t0;
    if (dur > 0 && trigTime >= t0 && trigTime <= t0 + dur) {
      const x = area.x + ((trigTime - t0) / dur) * area.width;
      ctx.beginPath();
      ctx.rect(area.x, area.y, area.width, area.height);
      ctx.clip();
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = theme.trigger;
      ctx.beginPath();
      ctx.moveTo(x, area.y);
      ctx.lineTo(x, area.y + area.height);
      ctx.stroke();
      ctx.setLineDash([]);
      // flag at the top
      ctx.beginPath();
      ctx.moveTo(x - 6, area.y);
      ctx.lineTo(x + 6, area.y);
      ctx.lineTo(x, area.y + 9);
      ctx.closePath();
      ctx.fill();
      // dot on the crossing
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.stroke();
      const label = `Trig ${formatEng(trigTime, 's', 4)}`;
      ctx.font = 'bold 10px Consolas, monospace';
      const tw = ctx.measureText(label).width;
      const lx = Math.min(x + 8, area.x + area.width - tw - 6);
      ctx.fillStyle = 'rgba(20,20,20,0.85)';
      ctx.fillRect(lx - 3, area.y + 12, tw + 6, 13);
      ctx.fillStyle = theme.trigger;
      ctx.fillText(label, lx, area.y + 22);
    }
  }
  ctx.restore();
}

/**
 * Draws X (Time) and Y (Voltage) cursors and readout banner.
 * X cursors read every visible channel; Y cursors belong to one channel (see getCursorChannel).
 */
export function drawCursors(
  ctx: CanvasRenderingContext2D,
  tab: TabState,
  p: PlotArea,
  theme: RenderTheme
): void {
  const { cursors } = tab;
  if (!cursors.enabled) return;
  // In frequency spectrum mode, do not draw time-domain cursor lines
  if (tab.plotMode === 'frequency') return;

  const cursorType = cursors.type || 'x';
  const showX = cursorType === 'x' || cursorType === 'xy';
  const showY = cursorType === 'y' || cursorType === 'xy';

  const timeBase = getTimeBaseChannel(tab);
  if (!timeBase) return;

  const timeStart = indexToTime(timeBase, tab.view.startIndex);
  const timeSpan = Math.max(0, indexToTime(timeBase, Math.max(tab.view.startIndex, tab.view.endIndex - 1)) - timeStart);

  const targetCh = getCursorChannel(tab);
  const yArea = targetCh ? getChannelArea(tab, p, targetCh) : p;

  ctx.save();

  // X Cursors (Time domain)
  if (showX && timeSpan > 0) {
    let x1Px: number | null = null;
    let x2Px: number | null = null;

    const drawX = (value: number, label: string, labelY: number): number => {
      const px = p.x + ((value - timeStart) / timeSpan) * p.width;
      if (px >= p.x && px <= p.x + p.width) {
        ctx.strokeStyle = theme.cursor;
        ctx.setLineDash([6, 3]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(px, p.y);
        ctx.lineTo(px, p.y + p.height);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = theme.cursor;
        ctx.font = 'bold 11px Consolas, monospace';
        ctx.fillText(`${label}: ${formatEng(value, 's', 3)}`, px + 4, labelY);
      }
      return px;
    };

    if (cursors.x1 !== null) x1Px = drawX(cursors.x1, 'X1', p.y + 14);
    if (cursors.x2 !== null) x2Px = drawX(cursors.x2, 'X2', p.y + 28);

    // Shaded region between X1 and X2
    if (x1Px !== null && x2Px !== null) {
      const left = Math.max(p.x, Math.min(x1Px, x2Px));
      const right = Math.min(p.x + p.width, Math.max(x1Px, x2Px));
      if (right > left) {
        ctx.fillStyle = theme.cursorFill;
        ctx.fillRect(left, p.y, right - left, p.height);
      }
    }

    // Intersection dots: every visible channel at X1 / X2
    for (const ch of getVisibleChannels(tab)) {
      const area = getChannelArea(tab, p, ch);
      const vRange = ch.vMax - ch.vMin;
      if (vRange <= 0) continue;
      for (const cx of [cursors.x1, cursors.x2]) {
        if (cx === null) continue;
        const val = sampleAt(ch, cx);
        if (val === null) continue;
        const px = p.x + ((cx - timeStart) / timeSpan) * p.width;
        const py = area.y + area.height - ((val - ch.vMin) / vRange) * area.height;
        if (px < p.x || px > p.x + p.width || py < area.y || py > area.y + area.height) continue;
        ctx.fillStyle = ch.color;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  // Y Cursors (Voltage / Amplitude domain) on the tracked channel
  if (showY && targetCh) {
    const vRange = targetCh.vMax - targetCh.vMin;
    if (vRange > 0) {
      let y1Px: number | null = null;
      let y2Px: number | null = null;

      const drawY = (value: number, label: string, tagBelow: boolean): number => {
        const py = yArea.y + yArea.height - ((value - targetCh.vMin) / vRange) * yArea.height;
        if (py >= yArea.y && py <= yArea.y + yArea.height) {
          ctx.strokeStyle = '#00e676';
          ctx.setLineDash([6, 3]);
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(yArea.x, py);
          ctx.lineTo(yArea.x + yArea.width, py);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.font = 'bold 11px Consolas, monospace';
          const text = `${label}: ${formatEng(value, targetCh.unit, 3)}`;
          const tw = ctx.measureText(text).width;
          const ty = tagBelow ? py + 2 : py - 14;
          ctx.fillStyle = '#00e676';
          ctx.fillRect(yArea.x + yArea.width - tw - 12, ty, tw + 8, 14);
          ctx.fillStyle = '#000000';
          ctx.fillText(text, yArea.x + yArea.width - tw - 8, ty + 11);
        }
        return py;
      };

      if (cursors.y1 !== null) y1Px = drawY(cursors.y1, 'Y1', false);
      if (cursors.y2 !== null) y2Px = drawY(cursors.y2, 'Y2', true);

      // Shaded region between Y1 and Y2
      if (y1Px !== null && y2Px !== null) {
        const top = Math.max(yArea.y, Math.min(y1Px, y2Px));
        const bottom = Math.min(yArea.y + yArea.height, Math.max(y1Px, y2Px));
        if (bottom > top) {
          ctx.fillStyle = 'rgba(0, 230, 118, 0.12)';
          ctx.fillRect(yArea.x, top, yArea.width, bottom - top);
        }
      }
    }
  }

  // Floating On-Canvas Readout Badge
  renderCursorReadoutOverlay(ctx, tab, p, targetCh, showX, showY);

  ctx.restore();
}

function renderCursorReadoutOverlay(
  ctx: CanvasRenderingContext2D,
  tab: TabState,
  p: PlotArea,
  targetCh: WaveformChannel | undefined,
  showX: boolean,
  showY: boolean
): void {
  const { cursors } = tab;
  const lines: Array<{ text: string; color: string }> = [];

  if (showX && cursors.x1 !== null && cursors.x2 !== null) {
    const dt = Math.abs(cursors.x2 - cursors.x1);
    const freq = dt > 0 ? formatEng(1 / dt, 'Hz', 2) : '∞';
    lines.push({ text: `X1: ${formatEng(cursors.x1, 's', 4)}  X2: ${formatEng(cursors.x2, 's', 4)}`, color: '#00e5ff' });
    lines.push({ text: `ΔT: ${formatEng(dt, 's', 4)}  (1/ΔT: ${freq})`, color: '#00e5ff' });

    // Value of every visible channel at X1 / X2
    for (const ch of getVisibleChannels(tab).slice(0, 8)) {
      const a = sampleAt(ch, cursors.x1);
      const b = sampleAt(ch, cursors.x2);
      if (a === null || b === null) continue;
      lines.push({
        text: `${ch.name}: ${formatEng(a, ch.unit, 3)} → ${formatEng(b, ch.unit, 3)}  Δ${formatEng(b - a, ch.unit, 3)}`,
        color: ch.color,
      });
    }
  }

  if (showY && cursors.y1 !== null && cursors.y2 !== null && targetCh) {
    const dv = Math.abs(cursors.y2 - cursors.y1);
    lines.push({
      text: `[${targetCh.name}] Y1: ${formatEng(cursors.y1, targetCh.unit, 3)}  Y2: ${formatEng(cursors.y2, targetCh.unit, 3)}`,
      color: '#00e676',
    });
    lines.push({ text: `ΔY (ΔV): ${formatEng(dv, targetCh.unit, 3)}`, color: '#00e676' });
  }

  if (lines.length === 0) return;

  ctx.font = '11px Consolas, monospace';
  const boxW = Math.max(...lines.map((l) => ctx.measureText(l.text).width)) + 16;
  const boxH = lines.length * 16 + 10;
  const boxX = p.x + p.width - boxW - 8;
  const boxY = p.y + p.height - boxH - 8;

  ctx.fillStyle = 'rgba(15, 15, 15, 0.90)';
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth = 1;
  ctx.strokeRect(boxX, boxY, boxW, boxH);

  lines.forEach((l, i) => {
    ctx.fillStyle = l.color;
    ctx.textAlign = 'left';
    ctx.fillText(l.text, boxX + 8, boxY + 16 + i * 16);
  });
}

/**
 * Oscilloscope-style edge annotation for one channel: dashed 10% / 90% levels, a dot at every
 * level crossing with a dashed drop line to the time axis, and a tr / tf bracket with its value.
 */
export function drawEdgeMarkers(
  ctx: CanvasRenderingContext2D,
  tab: TabState,
  ch: WaveformChannel,
  p: PlotArea,
  marks: EdgeMarks | null
): void {
  if (!ch.visible || ch.t.length < 2) return;
  const area = getChannelArea(tab, p, ch);
  const vRange = ch.vMax - ch.vMin;
  if (vRange <= 0) return;

  const startIdx = Math.max(0, Math.min(ch.t.length - 1, tab.view.startIndex));
  const endIdx = Math.max(startIdx + 1, Math.min(ch.t.length, tab.view.endIndex));
  const viewStart = indexToTime(ch, startIdx);
  const viewDur = indexToTime(ch, Math.max(startIdx, endIdx - 1)) - viewStart;
  if (!(viewDur > 0)) return;

  const X = (t: number) => area.x + ((t - viewStart) / viewDur) * area.width;
  const Y = (v: number) => area.y + area.height - ((v - ch.vMin) / vRange) * area.height;
  const RISE = '#69f0ae';
  const FALL = '#ff80ab';

  ctx.save();
  ctx.beginPath();
  ctx.rect(area.x, area.y, area.width, area.height);
  ctx.clip();
  ctx.font = 'bold 10px Consolas, monospace';
  ctx.textAlign = 'left';

  const tagY = area.y + 36;
  const drawTag = (text: string) => {
    ctx.font = 'bold 10px Consolas, monospace';
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(20,20,20,0.85)';
    ctx.fillRect(area.x + 4, tagY - 11, tw + 8, 14);
    ctx.strokeStyle = ch.color;
    ctx.lineWidth = 1;
    ctx.strokeRect(area.x + 4, tagY - 11, tw + 8, 14);
    ctx.fillStyle = ch.color;
    ctx.fillText(text, area.x + 8, tagY);
  };

  const inView = marks ? marks.edges.filter((e) => e.tEnd >= viewStart && e.tStart <= viewStart + viewDur) : [];
  if (!marks || inView.length === 0) {
    drawTag(`Edges [${ch.name}]: no complete 10%-90% edge in view`);
    ctx.restore();
    return;
  }

  // 10% / 90% levels
  const levelLine = (value: number, label: string) => {
    const y = Y(value);
    if (y < area.y || y > area.y + area.height) return;
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.40)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(area.x, y);
    ctx.lineTo(area.x + area.width, y);
    ctx.stroke();
    ctx.setLineDash([]);
    const text = `${label} ${formatEng(value, ch.unit, 3)}`;
    ctx.font = '10px Consolas, monospace';
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(20,20,20,0.8)';
    ctx.fillRect(area.x + area.width - tw - 10, y - 12, tw + 6, 12);
    ctx.fillStyle = '#d0d0d0';
    ctx.fillText(text, area.x + area.width - tw - 7, y - 3);
  };
  levelLine(marks.v90, '90%');
  levelLine(marks.v10, '10%');

  // Which edges to mark: all when few, otherwise only the first of each kind
  const firstRise = inView.find((e) => e.type === 'rise');
  const firstFall = inView.find((e) => e.type === 'fall');
  const list = inView.length <= 12 ? inView : ([firstRise, firstFall].filter(Boolean) as typeof inView);

  for (const e of list) {
    const c = e.type === 'rise' ? RISE : FALL;
    const lvl1 = e.type === 'rise' ? marks.v10 : marks.v90;
    const lvl2 = e.type === 'rise' ? marks.v90 : marks.v10;
    const pts: Array<[number, number]> = [
      [X(e.tStart), Y(lvl1)],
      [X(e.tEnd), Y(lvl2)],
    ];
    ctx.strokeStyle = c;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    for (const [px, py] of pts) {
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px, area.y + area.height);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const [px, py] of pts) {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.stroke();
    }
  }

  // tr / tf brackets (first of each kind), stacked above the time axis
  const bracket = (e: typeof inView[number] | undefined, row: number) => {
    if (!e) return;
    const c = e.type === 'rise' ? RISE : FALL;
    const x1 = X(e.tStart);
    const x2 = X(e.tEnd);
    const y = area.y + area.height - 12 - row * 18;
    if (y < area.y + 40) return;
    ctx.strokeStyle = c;
    ctx.fillStyle = c;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.lineTo(x2, y);
    ctx.stroke();
    // arrow heads pointing inward (or ticks when the edge is only a few pixels wide)
    const head = Math.min(5, Math.max(0, (x2 - x1) / 3));
    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.lineTo(x1 + head, y - 3);
    ctx.lineTo(x1 + head, y + 3);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x2, y);
    ctx.lineTo(x2 - head, y - 3);
    ctx.lineTo(x2 - head, y + 3);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x1, y - 4);
    ctx.lineTo(x1, y + 4);
    ctx.moveTo(x2, y - 4);
    ctx.lineTo(x2, y + 4);
    ctx.stroke();

    const text = `${e.type === 'rise' ? 'tr' : 'tf'} ${formatEng(e.duration, 's', 3)}`;
    ctx.font = 'bold 11px Consolas, monospace';
    const tw = ctx.measureText(text).width;
    let tx = (x1 + x2) / 2 - tw / 2;
    tx = Math.max(area.x + 4, Math.min(area.x + area.width - tw - 8, tx));
    ctx.fillStyle = 'rgba(20,20,20,0.88)';
    ctx.fillRect(tx - 3, y - 20, tw + 6, 14);
    ctx.strokeStyle = c;
    ctx.strokeRect(tx - 3, y - 20, tw + 6, 14);
    ctx.fillStyle = c;
    ctx.fillText(text, tx, y - 9);
  };
  bracket(firstRise, 1);
  bracket(firstFall, 0);

  const avg = (type: 'rise' | 'fall') => {
    const xs = inView.filter((e) => e.type === type);
    return xs.length ? xs.reduce((a, b) => a + b.duration, 0) / xs.length : null;
  };
  const ar = avg('rise');
  const af = avg('fall');
  const parts = [`Edges [${ch.name}]`, `${marks.riseCount}↑ ${marks.fallCount}↓`];
  if (ar !== null) parts.push(`avg tr ${formatEng(ar, 's', 3)}`);
  if (af !== null) parts.push(`avg tf ${formatEng(af, 's', 3)}`);
  if (inView.length > list.length) parts.push(`(first of each marked)`);
  drawTag(parts.join('  '));

  ctx.restore();
}

/**
 * Draws Ground (0V) reference indicators on the left axis for each visible channel.
 */
export function drawGroundMarkers(
  ctx: CanvasRenderingContext2D,
  tab: TabState,
  p: PlotArea
): void {
  if (tab.plotMode === 'frequency' || tab.separateView) return;
  const visibleChs = tab.drawOrder
    .map((id) => tab.channels[id])
    .filter((c) => c && c.visible);

  ctx.save();
  visibleChs.forEach((ch, idx) => {
    const vRange = ch.vMax - ch.vMin;
    if (vRange <= 0) return;
    const frac = (0 - ch.vMin) / vRange;
    const clampedFrac = Math.max(0, Math.min(1, frac));
    const y = p.y + p.height - clampedFrac * p.height;

    // Draw Ground pointer: ▶ with channel index/name
    ctx.fillStyle = ch.color;
    ctx.beginPath();
    ctx.moveTo(p.x - 2, y);
    ctx.lineTo(p.x - 14, y - 6);
    ctx.lineTo(p.x - 14, y + 6);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#000000';
    ctx.font = 'bold 9px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${idx + 1}`, p.x - 8, y + 3);
  });
  ctx.restore();
}

/**
 * Draws Subplot-specific Vertical Axis labels and channel banner in Separate mode.
 */
export function drawSubplotAxisLabels(
  ctx: CanvasRenderingContext2D,
  subP: PlotArea,
  ch: WaveformChannel,
  theme: RenderTheme,
  yDivs: number = 4
): void {
  ctx.save();
  ctx.font = '10px Consolas, monospace';

  const vMin = ch.vMin;
  const vMax = ch.vMax;
  const vSpan = vMax - vMin || 1.0;
  const vPerDiv = (vMax - vMin) / 8; // 8 divisions standard
  const vOffset = (vMax + vMin) / 2;

  // Subplot voltage labels on left
  for (let j = 0; j <= yDivs; j++) {
    const v = vMax - (j / yDivs) * vSpan;
    const y = subP.y + (j * subP.height) / yDivs;
    ctx.textAlign = 'right';
    ctx.fillStyle = ch.color;
    ctx.fillText(formatEng(v, ch.unit, 2), subP.x - 8, y + 3);
  }

  // Subplot channel title & scale banner (inside top-left of subplot)
  ctx.textAlign = 'left';
  const bannerText = `${ch.name}: ${formatEng(vPerDiv, ch.unit + '/div', 2)} | Offset: ${formatEng(vOffset, ch.unit, 2)}`;
  ctx.font = 'bold 11px Consolas, monospace';
  const bannerW = ctx.measureText(bannerText).width + 12;

  ctx.fillStyle = 'rgba(20, 20, 20, 0.85)';
  ctx.fillRect(subP.x + 4, subP.y + 4, bannerW, 16);
  ctx.strokeStyle = ch.color;
  ctx.lineWidth = 1;
  ctx.strokeRect(subP.x + 4, subP.y + 4, bannerW, 16);

  ctx.fillStyle = ch.color;
  ctx.fillText(bannerText, subP.x + 8, subP.y + 16);

  // Subplot ground pointer at 0V
  const gndFrac = (0 - vMin) / vSpan;
  if (gndFrac >= 0 && gndFrac <= 1) {
    const gndY = subP.y + subP.height - gndFrac * subP.height;
    ctx.fillStyle = ch.color;
    ctx.beginPath();
    ctx.moveTo(subP.x - 2, gndY);
    ctx.lineTo(subP.x - 12, gndY - 5);
    ctx.lineTo(subP.x - 12, gndY + 5);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#000000';
    ctx.font = 'bold 8px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('G', subP.x - 7, gndY + 3);
  }

  ctx.restore();
}

/**
 * Draws Axis numerical graduation labels and engineering units.
 */
export function drawAxisLabels(
  ctx: CanvasRenderingContext2D,
  p: PlotArea,
  tab: TabState,
  theme: RenderTheme,
  xDivs: number = 10,
  yDivs: number = 8,
  cachedSpectrum?: SpectrumResult | null
): void {
  ctx.save();
  ctx.fillStyle = theme.axisText;
  ctx.font = '11px Consolas, monospace';

  if (tab.plotMode === 'frequency') {
    // Frequency labels on bottom (respecting frequency zoom / span)
    const targetId = tab.selectedFftChannelId || tab.drawOrder[0];
    const targetCh = tab.channels[targetId] || tab.channels[tab.drawOrder[0]];
    const nyquist = (targetCh?.fs || 1e5) / 2;
    const minF = Math.max(0, tab.view.fMin ?? 0);
    const maxF = Math.min(nyquist, tab.view.fMax ?? nyquist);
    const fSpan = Math.max(1, maxF - minF);

    for (let i = 0; i <= xDivs; i++) {
      const f = minF + (i / xDivs) * fSpan;
      const x = p.x + (i * p.width) / xDivs;
      const label = formatEng(f, 'Hz', 2);
      ctx.textAlign = i === 0 ? 'left' : i === xDivs ? 'right' : 'center';
      ctx.fillText(label, x, p.y + p.height + 16);
    }

    // Y-axis labels on left (dB or magnitude, strictly synchronized with spectrum)
    const scaleMode = tab.fftOptions.scale;
    const yMin = cachedSpectrum?.yMin ?? (scaleMode === 'magnitude' ? 0 : -120);
    const yMax = cachedSpectrum?.yMax ?? (scaleMode === 'magnitude' ? 1 : 20);
    const ySpan = Math.max(0.1, yMax - yMin);

    for (let j = 0; j <= yDivs; j++) {
      const val = yMax - (j / yDivs) * ySpan;
      const y = p.y + (j * p.height) / yDivs;
      ctx.textAlign = 'right';
      if (scaleMode === 'magnitude') {
        ctx.fillText(formatEng(val, targetCh?.unit || 'V', 2), p.x - 8, y + 4);
      } else {
        ctx.fillText(`${val.toFixed(0)} dB`, p.x - 8, y + 4);
      }
    }
  } else {
    // Time labels on bottom
    const activeCh = getActiveChannel(tab);
    const primaryCh = getTimeBaseChannel(tab);
    const tStart = primaryCh ? indexToTime(primaryCh, tab.view.startIndex) : 0;
    const tEnd = primaryCh ? indexToTime(primaryCh, Math.max(tab.view.startIndex, tab.view.endIndex - 1)) : tStart;
    const tSpan = Math.max(0, tEnd - tStart);

    for (let i = 0; i <= xDivs; i++) {
      const t = tStart + (i / xDivs) * tSpan;
      const x = p.x + (i * p.width) / xDivs;
      const label = formatEng(t, 's', 3);
      ctx.textAlign = i === 0 ? 'left' : i === xDivs ? 'right' : 'center';
      ctx.fillText(label, x, p.y + p.height + 16);
    }

    // Voltage labels on left for active selected channel (ONLY in non-separate mode)
    // In separate mode, each subplot draws its own aligned vertical axis labels via drawSubplotAxisLabels!
    if (!tab.separateView && activeCh) {
      const vMin = activeCh.vMin;
      const vMax = activeCh.vMax;
      const vSpan = vMax - vMin;

      for (let j = 0; j <= yDivs; j++) {
        const v = vMax - (j / yDivs) * vSpan;
        const y = p.y + (j * p.height) / yDivs;
        ctx.textAlign = 'right';
        ctx.fillStyle = activeCh.color;
        ctx.fillText(formatEng(v, activeCh.unit, 2), p.x - 8, y + 4);
      }

      // Say whose axis this is (only matters when several channels are drawn)
      ctx.textAlign = 'left';
      ctx.font = 'bold 11px Consolas, monospace';
      ctx.fillStyle = activeCh.color;
      ctx.fillText(activeCh.name, p.x - 60, p.y - 6);
    }
  }

  ctx.restore();
}
