/**
 * Waveform Viewer Pro - Crop Export (CSV/JSON) & Composite High-DPI PNG Screenshot Engine
 */

import {
  TabState,
  SpectrumResult,
  ChannelMeasurements,
} from '../types/models';
import {
  RenderTheme,
  DEFAULT_THEME,
  getDynamicPlotArea,
  drawGrid,
  drawChannelWaveform,
  drawGndMarkers,
  drawTriggerLine,
  drawCursors,
  drawAnnotations,
  drawAxisLabels,
  drawSpectrum,
  drawXYPlot,
  drawGoldenToleranceBand,
  drawMeasurementStripOnCanvas,
  drawOverlapTraceLegend,
  drawCompareGroupLegend,
  formatEng,
} from '../engine/canvasRenderer';
import { getSubplotRects, getTimebaseInfo } from './oscilloscopeScale';
import { computeBLDCHarmonics } from './fft';
import { computeMeasurements } from './measurements';
import { evaluateGoldenTolerance } from './anomalyScanner';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function buildScreenshotFilename(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const min = pad2(d.getMinutes());
  const sec = pad2(d.getSeconds());
  return `Scope_${yyyy}${mm}${dd}_${hh}${min}${sec}.png`;
}

/**
 * Resolves [iStart, iEnd) index range covering [tStart, tEnd] on base channel timestamps.
 */
function resolveSliceIndices(t: Float64Array, tStart: number, tEnd: number): { iStart: number; iEnd: number } {
  const n = t.length;
  if (n === 0) return { iStart: 0, iEnd: 0 };
  const tMin = Math.min(tStart, tEnd);
  const tMax = Math.max(tStart, tEnd);

  let iStart = 0;
  while (iStart < n && t[iStart] < tMin) iStart++;
  let iEnd = iStart;
  while (iEnd < n && t[iEnd] <= tMax) iEnd++;

  return { iStart, iEnd };
}

/**
 * Exports a time-sliced waveform selection [tStart, tEnd] for chosen channels as CSV.
 */
export function exportCroppedWaveformCSV(
  tab: TabState,
  tStart: number,
  tEnd: number,
  channelIds: string[]
): { rowCount: number } {
  const selected = channelIds.map((id) => tab.channels[id]).filter(Boolean);
  if (selected.length === 0) {
    throw new Error('Select at least one channel to export.');
  }

  const baseCh = selected[0];
  const { iStart, iEnd } = resolveSliceIndices(baseCh.t, tStart, tEnd);
  const rowCount = Math.max(0, iEnd - iStart);
  if (rowCount === 0) {
    throw new Error('No samples found in the selected time range.');
  }

  const headers: string[] = ['Time(s)'];
  for (const ch of selected) {
    headers.push(`"${ch.name} (${ch.unit})"`);
    if (ch.refV && ch.hasEdits) {
      headers.push(`"${ch.name}_Ref (${ch.unit})"`);
    }
  }

  const lines: string[] = [headers.join(',')];
  for (let i = iStart; i < iEnd; i++) {
    const cols: string[] = [baseCh.t[i].toPrecision(12)];
    for (const ch of selected) {
      const val = i < ch.v.length ? ch.v[i] : NaN;
      cols.push(isFinite(val) ? val.toPrecision(7) : 'NaN');
      if (ch.refV && ch.hasEdits) {
        const refVal = i < ch.refV.length ? ch.refV[i] : NaN;
        cols.push(isFinite(refVal) ? refVal.toPrecision(7) : 'NaN');
      }
    }
    lines.push(cols.join(','));
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  const stem = tab.fileName.replace(/\.[^.]+$/, '');
  link.download = `${stem}_crop.csv`;
  link.href = URL.createObjectURL(blob);
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);

  return { rowCount };
}

/**
 * Exports a time-sliced waveform selection [tStart, tEnd] for chosen channels as structured JSON.
 */
export function exportCroppedWaveformJSON(
  tab: TabState,
  tStart: number,
  tEnd: number,
  channelIds: string[]
): { rowCount: number } {
  const selected = channelIds.map((id) => tab.channels[id]).filter(Boolean);
  if (selected.length === 0) {
    throw new Error('Select at least one channel to export.');
  }

  const baseCh = selected[0];
  const { iStart, iEnd } = resolveSliceIndices(baseCh.t, tStart, tEnd);
  const rowCount = Math.max(0, iEnd - iStart);
  if (rowCount === 0) {
    throw new Error('No samples found in the selected time range.');
  }

  const timeSlice = Array.from(baseCh.t.subarray(iStart, iEnd));
  const payload = {
    sourceFile: tab.fileName,
    exportedAt: new Date().toISOString(),
    sampleRate: baseCh.fs,
    dt: baseCh.dt,
    timeStart: timeSlice[0],
    timeEnd: timeSlice[timeSlice.length - 1],
    pointCount: rowCount,
    time: timeSlice,
    channels: selected.map((ch) => {
      const end = Math.min(ch.v.length, iEnd);
      const start = Math.min(end, iStart);
      const entry: Record<string, any> = {
        id: ch.id,
        name: ch.name,
        unit: ch.unit,
        color: ch.color,
        isMath: ch.isMath,
        hasEdits: !!ch.hasEdits,
        samples: Array.from(ch.v.subarray(start, end)),
      };
      if (ch.refV && ch.hasEdits) {
        entry.referenceSamples = Array.from(ch.refV.subarray(start, end));
      }
      return entry;
    }),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  const stem = tab.fileName.replace(/\.[^.]+$/, '');
  link.download = `${stem}_crop.json`;
  link.href = URL.createObjectURL(blob);
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);

  return { rowCount };
}

/**
 * Composes a clean, sidebar-free high-DPI PNG screenshot containing:
 * - Instrument telemetry header bar
 * - Complete 10x8 graticule, waveforms, Ref/Diff overlays, GND/Trigger flags, Cursors + HUD, Annotations
 * - Active user-checked bottom measurement cards (if any)
 */
function buildCompositeScopePngInternal(
  tab: TabState,
  canvasWidth: number,
  canvasHeight: number,
  cachedSpectrum?: SpectrumResult | null,
  theme: RenderTheme = DEFAULT_THEME
): { filename: string; dataUrl: string } {
  const w = Math.max(960, Math.round(canvasWidth));
  const plotH = Math.max(480, Math.round(canvasHeight));
  const headerH = 38;

  // Pre-compute measurements for checked cards
  const selectedItems = tab.selectedMeasurements || [];
  const measByChannel: Record<string, ChannelMeasurements> = {};
  if (selectedItems.length > 0) {
    const seen = new Set<string>();
    for (const item of selectedItems) {
      if (seen.has(item.channelId)) continue;
      seen.add(item.channelId);
      const ch = tab.channels[item.channelId];
      if (ch) {
        measByChannel[item.channelId] = computeMeasurements(ch, tab.measurementGate, tab.view, tab.cursors);
      }
    }
  }

  // Estimate extra bottom strip height needed for measurement cards
  const measStripH = selectedItems.length > 0 ? Math.ceil(selectedItems.length / Math.max(1, Math.floor((w - 32) / 130))) * 46 + 14 : 0;
  const totalH = headerH + plotH + measStripH;
  const scale = 2;

  const offscreen = document.createElement('canvas');
  offscreen.width = w * scale;
  offscreen.height = totalH * scale;
  const ctx = offscreen.getContext('2d');
  if (!ctx) throw new Error('Unable to create offscreen canvas context.');

  ctx.scale(scale, scale);

  // Full theme chassis background
  ctx.fillStyle = theme.chassisBg || '#0c0f13';
  ctx.fillRect(0, 0, w, totalH);

  // Header telemetry bar
  ctx.fillStyle = theme.headerBg || '#12161c';
  ctx.fillRect(0, 0, w, headerH);
  ctx.strokeStyle = theme.hudBorder || '#222933';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, headerH - 0.5);
  ctx.lineTo(w, headerH - 0.5);
  ctx.stroke();

  const tb = getTimebaseInfo(tab);
  const srText = tb.sampleRate ? formatEng(tb.sampleRate, 'Sa/s', 2) : 'Non-uniform';
  const modeStr =
    tab.plotMode === 'frequency'
      ? 'FFT'
      : tab.plotMode === 'xy'
      ? 'XY'
      : tab.separateView
      ? 'SEPARATE'
      : 'OVERLAP';
  const renderStr = (tab.renderMode || 'vector').toUpperCase();

  ctx.font = '600 12px "IBM Plex Sans", sans-serif';
  ctx.fillStyle = theme.text || '#f1f5f9';
  ctx.textAlign = 'left';
  ctx.fillText(`${tab.fileName}`, 14, 23);

  ctx.font = '11px "JetBrains Mono", monospace';
  ctx.fillStyle = theme.axisText || '#94a3b8';
  ctx.textAlign = 'right';
  ctx.fillText(
    `H: ${formatEng(tb.secPerDiv, 's', 2)}/div  |  ${srText}  |  ${modeStr}  |  ${renderStr}`,
    w - 14,
    23
  );

  // Draw Graticule & Waveforms translated below header
  ctx.save();
  ctx.translate(0, headerH);
  const { plotArea: p } = getDynamicPlotArea(tab, w, plotH, {
    cachedSpectrum,
    ctx,
  });

  if (tab.plotMode === 'frequency') {
    drawGrid(ctx, p, theme, 10, 8, false);
    if (cachedSpectrum) {
      const harm = computeBLDCHarmonics(tab.motorConfig);
      drawSpectrum(ctx, cachedSpectrum, p, theme, harm.markers, tab.fftOptions.scale, tab.view);
    }
  } else if (tab.plotMode === 'xy') {
    drawGrid(ctx, p, theme, 10, 8, true);
    drawXYPlot(ctx, tab, p, theme);
  } else {
    const visibleChs = tab.drawOrder.map((id) => tab.channels[id]).filter((c) => c && c.visible);
    const goldenCh =
      tab.goldenBand?.enabled && tab.goldenBand.channelId
        ? tab.channels[tab.goldenBand.channelId]
        : null;
    const goldenEval =
      goldenCh && tab.goldenBand ? evaluateGoldenTolerance(goldenCh, tab.goldenBand) : null;

    if (tab.separateView && visibleChs.length > 1) {
      const rects = getSubplotRects(p, visibleChs, true);
      rects.forEach((rect) => {
        drawGrid(ctx, rect.area, theme, 10, 4, true);
        if (goldenEval && tab.goldenBand?.channelId === rect.channel.id) {
          drawGoldenToleranceBand(ctx, tab, rect.channel, p, goldenEval, rect.area);
        }
        drawChannelWaveform(ctx, tab, rect.channel, p, rect.area, theme);
      });
    } else {
      drawGrid(ctx, p, theme, 10, 8, true);
      if (goldenCh && goldenEval) {
        drawGoldenToleranceBand(ctx, tab, goldenCh, p, goldenEval);
      }
      for (const ch of visibleChs) {
        drawChannelWaveform(ctx, tab, ch, p, undefined, theme);
      }
    }
    drawTriggerLine(ctx, tab, p, theme);
    drawGndMarkers(ctx, p, tab, theme);
    drawCursors(ctx, tab, p, theme);
    drawAnnotations(ctx, tab, p, theme);
    const legendBottom = drawOverlapTraceLegend(ctx, tab, p, theme);
    drawCompareGroupLegend(ctx, tab, p, theme, legendBottom > p.y + 8 ? legendBottom + 6 : undefined);
  }

  drawAxisLabels(ctx, p, tab, theme, 10, 8, cachedSpectrum);
  ctx.restore();

  // Draw active measurement strip at bottom
  if (selectedItems.length > 0) {
    ctx.strokeStyle = theme.hudBorder || '#222933';
    ctx.beginPath();
    ctx.moveTo(0, headerH + plotH + 0.5);
    ctx.lineTo(w, headerH + plotH + 0.5);
    ctx.stroke();
    drawMeasurementStripOnCanvas(ctx, tab, w, headerH + plotH, measByChannel, theme);
  }

  const filename = buildScreenshotFilename();
  const dataUrl = offscreen.toDataURL('image/png');
  return { filename, dataUrl };
}

export function renderCompositeScopeDataUrl(
  tab: TabState,
  canvasWidth: number,
  canvasHeight: number,
  cachedSpectrum?: SpectrumResult | null,
  theme: RenderTheme = DEFAULT_THEME
): { filename: string; dataUrl: string } {
  return buildCompositeScopePngInternal(tab, canvasWidth, canvasHeight, cachedSpectrum, theme);
}

export function captureCompositeScopePNG(
  tab: TabState,
  canvasWidth: number,
  canvasHeight: number,
  cachedSpectrum?: SpectrumResult | null,
  theme: RenderTheme = DEFAULT_THEME
): string {
  const { filename, dataUrl } = buildCompositeScopePngInternal(
    tab,
    canvasWidth,
    canvasHeight,
    cachedSpectrum,
    theme
  );
  const link = document.createElement('a');
  link.download = filename;
  link.href = dataUrl;
  link.click();

  return filename;
}
