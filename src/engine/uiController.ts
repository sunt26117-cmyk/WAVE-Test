/**
 * Waveform Viewer Pro - UI Controller & Oscilloscope Workspace
 * Manages tabs, toolbars, sidebar panels, modals, event handlers,
 * canvas interactions, and state orchestration.
 */

import {
  TabState,
  WaveformChannel,
  SpectrumResult,
  PlotMode,
  MeasurementGate,
  CsvPreviewInfo,
  ChannelFilterSpec,
} from '../types/models';
import {
  PlotArea,
  RenderTheme,
  DEFAULT_THEME,
  OVERLAP_COLORS,
  getPlotArea,
  screenToData,
  drawGrid,
  drawChannelWaveform,
  drawSpectrum,
  drawTriggerLine,
  drawCursors,
  drawEdgeMarkers,
  getActiveChannel,
  getTimeBaseChannel,
  getCursorChannel,
  getChannelArea,
  computeSubplotAreas,
  getVisibleChannels,
  drawAxisLabels,
  drawSubplotAxisLabels,
  drawGroundMarkers,
  formatEng,
  indexToTime,
  timeToIndex,
} from './canvasRenderer';
import { computeFFT, computeBLDCHarmonics } from '../modules/fft';
import { computeMeasurements, computeEdgeMarks, EdgeMarks } from '../modules/measurements';
import { lowPassFilter, validateFilterSpec, describeFilter } from '../modules/filter';
import { performAutoSet } from '../modules/autoSet';
import { findTriggerPoint, alignViewToTrigger } from '../modules/trigger';
import { evaluateMathExpression } from '../modules/mathParser';
import { computeClarke, computePark } from '../modules/transforms';
import { serializeSession, deserializeSession } from './session';
import { previewCsv, parseFullCsv } from '../parsers/csvParser';
import { parseWfmBuffer } from '../parsers/wfmParser';
import { runAllTests } from '../tests/testSuite';

// Standard 1-2-5 scale step sequence for oscilloscope vertical steps
const SCALE_STEPS = [
  1e-6, 2e-6, 5e-6,
  1e-5, 2e-5, 5e-5,
  1e-4, 2e-4, 5e-4,
  1e-3, 2e-3, 5e-3,
  1e-2, 2e-2, 5e-2,
  0.1, 0.2, 0.5,
  1, 2, 5,
  10, 20, 50,
  100, 200, 500,
  1000, 2000, 5000,
];

function getNextScale(current: number, direction: 'up' | 'down'): number {
  if (direction === 'up') {
    for (const step of SCALE_STEPS) {
      if (step > current * 1.05) return step;
    }
    return current * 2;
  } else {
    for (let i = SCALE_STEPS.length - 1; i >= 0; i--) {
      if (SCALE_STEPS[i] < current * 0.95) return SCALE_STEPS[i];
    }
    return current / 2;
  }
}

export type FilterScope = 'active' | 'visible' | 'all';

export class OscilloscopeApp {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private theme: RenderTheme = DEFAULT_THEME;

  private tabs: TabState[] = [];
  private activeTabIndex: number = -1;

  // Interaction state
  private isDragging: boolean = false;
  private dragStartX: number = 0;
  private dragStartY: number = 0;
  private initialViewStart: number = 0;
  private initialViewEnd: number = 0;
  private isAreaZooming: boolean = false;
  private areaZoomStart: { x: number; y: number } | null = null;
  private areaZoomEnd: { x: number; y: number } | null = null;
  private draggingCursor:
    | 'x1'
    | 'x2'
    | 'y1'
    | 'y2'
    | { groundChId: string; startY: number; initialOffset: number }
    | null = null;

  // Cached FFT result for current tab
  private cachedSpectrum: SpectrumResult | null = null;
  private cachedSpectrumKey: string = '';

  // Canvas size in CSS pixels (kept in sync with the backing store in handleResize)
  private cssW: number = 0;
  private cssH: number = 0;

  // Bumped whenever sample data changes (filter on/off) so caches can be invalidated
  private filterRev: number = 0;
  private edgeCache: { key: string; marks: EdgeMarks | null } | null = null;
  private trigCache: { key: string; time: number | null } | null = null;
  private statusFlash: string = '';
  private statusFlashTimer: number | undefined;
  /** Last filter used, so the toolbar toggle can re-apply it with one click. */
  private lastFilter: { spec: ChannelFilterSpec; scope: FilterScope } | null = null;

  // CSV import modal state
  private pendingCsvText: string = '';
  private pendingCsvPreview: CsvPreviewInfo | null = null;
  private pendingFileName: string = '';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D canvas context.');
    this.ctx = ctx;

    this.initEvents();
    this.handleResize();
  }

  public getActiveTab(): TabState | null {
    if (this.activeTabIndex >= 0 && this.activeTabIndex < this.tabs.length) {
      return this.tabs[this.activeTabIndex];
    }
    return null;
  }

  public addTab(tab: TabState): void {
    this.tabs.push(tab);
    this.activeTabIndex = this.tabs.length - 1;
    this.renderTabsBar();
    this.renderSidebar();
    this.draw();
  }

  public closeTab(index: number): void {
    if (index < 0 || index >= this.tabs.length) return;
    this.tabs.splice(index, 1);
    if (this.activeTabIndex >= this.tabs.length) {
      this.activeTabIndex = this.tabs.length - 1;
    }
    this.renderTabsBar();
    this.renderSidebar();
    this.draw();
  }

  public setActiveTab(index: number): void {
    if (index >= 0 && index < this.tabs.length) {
      this.activeTabIndex = index;
      this.renderTabsBar();
      this.renderSidebar();
      this.draw();
    }
  }

  // --- Rendering Pipeline ---
  public draw(): void {
    const width = this.cssW || this.canvas.clientWidth;
    const height = this.cssH || this.canvas.clientHeight;

    this.ctx.clearRect(0, 0, width, height);

    const tab = this.getActiveTab();
    const p = getPlotArea(width, height);

    // Always draw professional oscilloscope background grid
    drawGrid(this.ctx, p, this.theme);

    if (!tab || tab.drawOrder.length === 0) {
      // Empty state prompt
      this.ctx.save();
      this.ctx.fillStyle = '#888888';
      this.ctx.font = '16px "Segoe UI", sans-serif';
      this.ctx.textAlign = 'center';
      this.ctx.fillText(
        'Drop a CSV or WFM file here, or click "Load File" to start waveform analysis',
        width / 2,
        height / 2
      );
      this.ctx.restore();
      this.updateStatusBar();
      return;
    }

    if (tab.plotMode === 'frequency') {
      this.renderFrequencyDomain(tab, p);
    } else {
      this.renderTimeDomain(tab, p);
    }

    // Draw Cursors
    drawCursors(this.ctx, tab, p, this.theme);

    // Draw Axis Labels
    drawAxisLabels(this.ctx, p, tab, this.theme, 10, 8, this.cachedSpectrum);

    // Area Zoom rect if active
    if (this.isAreaZooming && this.areaZoomStart && this.areaZoomEnd) {
      this.ctx.save();
      this.ctx.fillStyle = 'rgba(0, 120, 215, 0.3)';
      this.ctx.strokeStyle = '#0078d7';
      this.ctx.lineWidth = 1;
      const rx = Math.min(this.areaZoomStart.x, this.areaZoomEnd.x);
      const ry = Math.min(this.areaZoomStart.y, this.areaZoomEnd.y);
      const rw = Math.abs(this.areaZoomEnd.x - this.areaZoomStart.x);
      const rh = Math.abs(this.areaZoomEnd.y - this.areaZoomStart.y);
      this.ctx.fillRect(rx, ry, rw, rh);
      this.ctx.strokeRect(rx, ry, rw, rh);
      this.ctx.restore();
    }

    this.updateStatusBar();
  }

  private renderTimeDomain(tab: TabState, p: PlotArea): void {
    const visibleChs = getVisibleChannels(tab);
    const subAreas = computeSubplotAreas(tab, p);

    if (subAreas) {
      // Separate diagram subplots
      visibleChs.forEach((ch) => {
        const subP = subAreas.get(ch.id)!;
        drawGrid(this.ctx, subP, this.theme, 10, 4);
        drawChannelWaveform(this.ctx, tab, ch, p, subP);
        drawSubplotAxisLabels(this.ctx, subP, ch, this.theme, 4);
      });
    } else {
      // Overlapped diagram
      for (const id of tab.drawOrder) {
        const ch = tab.channels[id];
        if (ch && ch.visible) {
          drawChannelWaveform(this.ctx, tab, ch, p);
        }
      }
      drawGroundMarkers(this.ctx, tab, p);
    }

    // 10% / 90% edge annotations for the active channel
    if (tab.showEdgeMarks) {
      const ch = getActiveChannel(tab);
      if (ch && ch.visible) {
        drawEdgeMarkers(this.ctx, tab, ch, p, this.getEdgeMarks(tab, ch));
      }
    }

    // Trigger level line + trigger event marker
    drawTriggerLine(this.ctx, tab, p, this.theme, this.getTriggerTime(tab));
  }

  /** Edge detection for the visible window, cached so panning stays smooth. */
  private getEdgeMarks(tab: TabState, ch: WaveformChannel): EdgeMarks | null {
    const key = `${tab.id}|${ch.id}|${ch.v.length}|${tab.view.startIndex}|${tab.view.endIndex}|${this.filterRev}`;
    if (this.edgeCache && this.edgeCache.key === key) return this.edgeCache.marks;
    const marks = computeEdgeMarks(ch, tab.view.startIndex, tab.view.endIndex);
    this.edgeCache = { key, marks };
    return marks;
  }

  /** Time of the first trigger event in the trigger channel (cached). */
  private getTriggerTime(tab: TabState): number | null {
    const cfg = tab.triggerConfig;
    if (!cfg.enabled) return null;
    const ch = tab.channels[cfg.channelId];
    if (!ch) return null;
    const key = `${tab.id}|${ch.id}|${ch.v.length}|${cfg.type}|${cfg.level}|${this.filterRev}`;
    if (this.trigCache && this.trigCache.key === key) return this.trigCache.time;
    const pt = findTriggerPoint(ch, cfg);
    const time = pt ? pt.triggerTime : null;
    this.trigCache = { key, time };
    return time;
  }

  private renderFrequencyDomain(tab: TabState, p: PlotArea): void {
    const targetId = tab.selectedFftChannelId || tab.drawOrder[0];
    const primaryCh = tab.channels[targetId] || tab.channels[tab.drawOrder[0]];
    if (!primaryCh || primaryCh.v.length === 0) return;

    // Cache key to avoid redundant FFT calculation
    const key = `${primaryCh.id}_${tab.view.startIndex}_${tab.view.endIndex}_${tab.fftOptions.window}_${tab.fftOptions.scale}_${tab.fftOptions.zeroPadding}_${tab.fftOptions.removeDC}_${tab.fftOptions.range}_${this.filterRev}`;

    if (this.cachedSpectrumKey !== key || !this.cachedSpectrum) {
      try {
        let tSlice = primaryCh.t;
        let vSlice = primaryCh.v;

        if (tab.fftOptions.range === 'view') {
          const s = Math.max(0, tab.view.startIndex);
          const e = Math.min(primaryCh.v.length, tab.view.endIndex);
          tSlice = primaryCh.t.subarray(s, e);
          vSlice = primaryCh.v.subarray(s, e);
        } else if (
          tab.fftOptions.range === 'cursors' &&
          tab.cursors.enabled &&
          tab.cursors.x1 !== null &&
          tab.cursors.x2 !== null
        ) {
          const xMin = Math.min(tab.cursors.x1, tab.cursors.x2);
          const xMax = Math.max(tab.cursors.x1, tab.cursors.x2);
          let s = 0;
          while (s < primaryCh.t.length && primaryCh.t[s] < xMin) s++;
          let e = s;
          while (e < primaryCh.t.length && primaryCh.t[e] <= xMax) e++;
          tSlice = primaryCh.t.subarray(s, e);
          vSlice = primaryCh.v.subarray(s, e);
        }

        const fs = primaryCh.fs || (primaryCh.dt ? 1 / primaryCh.dt : 100000);
        this.cachedSpectrum = computeFFT(
          tSlice,
          vSlice,
          fs,
          tab.fftOptions,
          primaryCh.id,
          primaryCh.name
        );
        this.cachedSpectrumKey = key;
      } catch (e) {
        console.error('FFT calculation error:', e);
        this.cachedSpectrum = null;
      }
    }

    if (this.cachedSpectrum) {
      // Harmonic markers
      const harmonicRes = computeBLDCHarmonics(tab.motorConfig);
      drawSpectrum(
        this.ctx,
        this.cachedSpectrum,
        p,
        this.theme,
        harmonicRes.markers,
        tab.fftOptions.scale,
        tab.view
      );

      // Render Detected Peaks in the sidebar
      const peaksEl = document.getElementById('fftPeaksList');
      if (peaksEl) {
        if (this.cachedSpectrum.peaks.length === 0) {
          peaksEl.innerHTML = '<div class="text-neutral-500 italic">No peaks detected above threshold</div>';
        } else {
          let html = '';
          this.cachedSpectrum.peaks.forEach((peak, i) => {
            const isFund = peak.isFundamental;
            const magStr = tab.fftOptions.scale === 'db' ? `${peak.db.toFixed(1)} dB` : formatEng(peak.magnitude, primaryCh.unit, 2);
            html += `
              <div class="flex justify-between items-center py-0.5 ${isFund ? 'text-amber-300 font-bold' : 'text-neutral-300'}">
                <span>${isFund ? '★ ' : ''}P${i + 1}: ${formatEng(peak.frequency, 'Hz', 2)}</span>
                <span>${magStr}</span>
              </div>
            `;
          });
          peaksEl.innerHTML = html;
        }
      }
    }
  }

  // --- Interaction & Controls ---
  private initEvents(): void {
    window.addEventListener('resize', () => this.handleResize());

    // Canvas Mouse Events
    this.canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
    this.canvas.addEventListener('mouseup', () => this.handleMouseUp());
    this.canvas.addEventListener('wheel', (e) => this.handleWheel(e), { passive: false });

    // Drag and drop files onto whole window
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      const overlay = document.getElementById('drag-overlay');
      if (overlay) overlay.style.display = 'flex';
    });

    window.addEventListener('dragleave', (e) => {
      if (e.clientX === 0 || e.clientY === 0) {
        const overlay = document.getElementById('drag-overlay');
        if (overlay) overlay.style.display = 'none';
      }
    });

    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const overlay = document.getElementById('drag-overlay');
      if (overlay) overlay.style.display = 'none';
      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        this.handleFiles(Array.from(e.dataTransfer.files));
      }
    });

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'SELECT')) {
        return;
      }

      const key = e.key.toUpperCase();
      if (key === 'F') {
        this.fitView();
      } else if (key === 'Z') {
        this.isAreaZooming = !this.isAreaZooming;
        this.draw();
      } else if (key === 'T') {
        const tab = this.getActiveTab();
        if (tab) {
          tab.cursors.enabled = !tab.cursors.enabled;
          if (tab.cursors.enabled && tab.cursors.x1 === null) {
            const ch = getTimeBaseChannel(tab);
            if (ch) {
              const span = Math.max(0, indexToTime(ch, Math.max(tab.view.startIndex, tab.view.endIndex - 1)) - indexToTime(ch, tab.view.startIndex));
              const start = indexToTime(ch, tab.view.startIndex);
              tab.cursors.x1 = start + span * 0.25;
              tab.cursors.x2 = start + span * 0.75;
            }
          }
          this.renderSidebar();
          this.draw();
        }
      }
    });
  }

  private handleResize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;

    // Round the backing store to whole device pixels and scale by the *actual* ratio.
    // A fractional size (125% / 150% Windows scaling) makes the browser resample the canvas,
    // which is what made lines and text look soft or jagged.
    const pxW = Math.max(1, Math.round(rect.width * dpr));
    const pxH = Math.max(1, Math.round(rect.height * dpr));
    this.cssW = rect.width;
    this.cssH = rect.height;

    this.canvas.width = pxW;
    this.canvas.height = pxH;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;

    this.ctx.setTransform(pxW / rect.width, 0, 0, pxH / rect.height, 0, 0);
    this.draw();
  }

  public ensureCursorPositions(tab: TabState): void {
    const primaryCh = getTimeBaseChannel(tab);
    if (!primaryCh) return;
    const start = indexToTime(primaryCh, tab.view.startIndex);
    const span = Math.max(0, indexToTime(primaryCh, Math.max(tab.view.startIndex, tab.view.endIndex - 1)) - start);

    if (tab.cursors.x1 === null || tab.cursors.x2 === null) {
      tab.cursors.x1 = start + span * 0.25;
      tab.cursors.x2 = start + span * 0.75;
    }

    const targetCh = getCursorChannel(tab) || primaryCh;
    if (targetCh && (tab.cursors.y1 === null || tab.cursors.y2 === null)) {
      // Place them inside what is currently on screen for that channel
      const lo = targetCh.vMin;
      const vSpan = targetCh.vMax - targetCh.vMin;
      tab.cursors.y1 = lo + vSpan * 0.3;
      tab.cursors.y2 = lo + vSpan * 0.7;
    }
  }

  /**
   * Keeps the Y cursors at the same *screen* position when the channel they measure changes,
   * instead of leaving them at the old channel's volts (which is usually off-screen on the
   * new channel's scale and made the cursor look stuck on channel 1).
   */
  private remapYCursors(tab: TabState, from: WaveformChannel | undefined, to: WaveformChannel | undefined): void {
    if (!from || !to || from.id === to.id) return;
    const fr = from.vMax - from.vMin;
    const tr = to.vMax - to.vMin;
    if (!(fr > 0) || !(tr > 0)) return;
    for (const key of ['y1', 'y2'] as const) {
      const val = tab.cursors[key];
      if (val === null) continue;
      tab.cursors[key] = to.vMin + ((val - from.vMin) / fr) * tr;
    }
  }

  /** Change which channel the vertical axis / measurements / auto cursor follow. */
  public setActiveChannel(tab: TabState, id: string): void {
    const before = getCursorChannel(tab);
    tab.selectedMeasurementChannelId = id;
    this.remapYCursors(tab, before, getCursorChannel(tab));
    this.renderSidebar();
    this.draw();
  }

  /** Select the channel the Y cursors measure; '' means Auto (follow active channel). */
  public setCursorChannel(tab: TabState, id: string): void {
    const before = getCursorChannel(tab);
    tab.cursors.trackingChannel = id || null;
    this.remapYCursors(tab, before, getCursorChannel(tab));
    this.renderSidebar();
    this.draw();
  }

  /**
   * Called after a channel is shown or hidden. If the active channel just disappeared the
   * axis and measurements move to the first visible channel automatically.
   */
  private onVisibilityChanged(tab: TabState, before: WaveformChannel | undefined): void {
    const selected = tab.channels[tab.selectedMeasurementChannelId || ''];
    if (!selected || !selected.visible) {
      const active = getActiveChannel(tab);
      if (active) tab.selectedMeasurementChannelId = active.id;
    }
    this.remapYCursors(tab, before, getCursorChannel(tab));
    this.renderSidebar();
    this.draw();
  }

  public setChannelScale(channelId: string, newVPerDiv: number): void {
    const tab = this.getActiveTab();
    if (!tab || !tab.channels[channelId]) return;
    const ch = tab.channels[channelId];
    if (newVPerDiv <= 0 || !isFinite(newVPerDiv)) return;

    const currentOffset = ch.vOffset !== undefined ? ch.vOffset : (ch.vMax + ch.vMin) / 2;
    const halfSpan = newVPerDiv * 4; // 8 divisions
    ch.vPerDiv = newVPerDiv;
    ch.vOffset = currentOffset;
    ch.vMin = currentOffset - halfSpan;
    ch.vMax = currentOffset + halfSpan;
    this.renderSidebar();
    this.draw();
  }

  public setChannelOffset(channelId: string, newOffset: number): void {
    const tab = this.getActiveTab();
    if (!tab || !tab.channels[channelId]) return;
    const ch = tab.channels[channelId];
    if (!isFinite(newOffset)) return;

    const vPerDiv = ch.vPerDiv || (ch.vMax - ch.vMin) / 8;
    const halfSpan = vPerDiv * 4;
    ch.vOffset = newOffset;
    ch.vPerDiv = vPerDiv;
    ch.vMin = newOffset - halfSpan;
    ch.vMax = newOffset + halfSpan;
    this.renderSidebar();
    this.draw();
  }

  public nudgeChannelOffset(channelId: string, direction: 'up' | 'down'): void {
    const tab = this.getActiveTab();
    if (!tab || !tab.channels[channelId]) return;
    const ch = tab.channels[channelId];
    const vPerDiv = ch.vPerDiv || (ch.vMax - ch.vMin) / 8;
    const currentOffset = ch.vOffset !== undefined ? ch.vOffset : (ch.vMax + ch.vMin) / 2;
    const delta = direction === 'up' ? vPerDiv : -vPerDiv;
    this.setChannelOffset(channelId, currentOffset + delta);
  }

  public zeroChannelOffset(channelId: string): void {
    this.setChannelOffset(channelId, 0);
  }

  public stepChannelScale(channelId: string, direction: 'up' | 'down'): void {
    const tab = this.getActiveTab();
    if (!tab || !tab.channels[channelId]) return;
    const ch = tab.channels[channelId];
    const currentScale = ch.vPerDiv || (ch.vMax - ch.vMin) / 8;
    const newScale = getNextScale(currentScale, direction);
    this.setChannelScale(channelId, newScale);
  }

  public autoScaleChannel(channelId: string): void {
    const tab = this.getActiveTab();
    if (!tab || !tab.channels[channelId]) return;
    const ch = tab.channels[channelId];
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < ch.v.length; i++) {
      const val = ch.v[i];
      if (!isNaN(val)) {
        if (val < min) min = val;
        if (val > max) max = val;
      }
    }
    if (!isFinite(min) || !isFinite(max)) return;
    const span = max - min || 1.0;
    const center = (max + min) / 2;
    const vPerDivRaw = span / 6; // Leave 1 division headroom
    let snapped = 1.0;
    for (const step of SCALE_STEPS) {
      if (step >= vPerDivRaw) {
        snapped = step;
        break;
      }
    }
    ch.vPerDiv = snapped;
    ch.vOffset = center;
    ch.vMin = center - snapped * 4;
    ch.vMax = center + snapped * 4;
    this.renderSidebar();
    this.draw();
  }

  private handleMouseDown(e: MouseEvent): void {
    const tab = this.getActiveTab();
    if (!tab) return;

    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const p = getPlotArea(rect.width, rect.height);

    // Check Ground Reference markers on left margin (x in [p.x - 22, p.x])
    if (!tab.separateView && x >= p.x - 22 && x <= p.x && y >= p.y && y <= p.y + p.height) {
      const visibleChs = tab.drawOrder
        .map((id) => tab.channels[id])
        .filter((c) => c && c.visible);

      for (const ch of visibleChs) {
        const vRange = ch.vMax - ch.vMin;
        if (vRange > 0) {
          const frac = (0 - ch.vMin) / vRange;
          const clampedFrac = Math.max(0, Math.min(1, frac));
          const gndY = p.y + p.height - clampedFrac * p.height;
          if (Math.abs(y - gndY) < 12) {
            this.draggingCursor = {
              groundChId: ch.id,
              startY: y,
              initialOffset: ch.vOffset !== undefined ? ch.vOffset : (ch.vMax + ch.vMin) / 2,
            };
            return;
          }
        }
      }
    }

    if (x < p.x || x > p.x + p.width || y < p.y || y > p.y + p.height) return;

    // Check Cursors (X and Y)
    if (tab.cursors.enabled) {
      const cursorType = tab.cursors.type || 'x';
      const showX = cursorType === 'x' || cursorType === 'xy';
      const showY = cursorType === 'y' || cursorType === 'xy';

      // Check X Cursors (Time)
      if (showX) {
        const primaryCh = getTimeBaseChannel(tab);
        const tStart = primaryCh ? indexToTime(primaryCh, tab.view.startIndex) : 0;
        const tSpan = primaryCh ? Math.max(0, indexToTime(primaryCh, Math.max(tab.view.startIndex, tab.view.endIndex - 1)) - tStart) : 0;

        if (tSpan > 0 && tab.cursors.x1 !== null && tab.cursors.x2 !== null) {
          const x1Px = p.x + ((tab.cursors.x1 - tStart) / tSpan) * p.width;
          const x2Px = p.x + ((tab.cursors.x2 - tStart) / tSpan) * p.width;

          if (Math.abs(x - x1Px) < 10) {
            this.draggingCursor = 'x1';
            return;
          } else if (Math.abs(x - x2Px) < 10) {
            this.draggingCursor = 'x2';
            return;
          }
        }
      }

      // Check Y Cursors (Voltage) - measured on the tracked channel, inside its own subplot
      if (showY) {
        const targetCh = getCursorChannel(tab);
        if (targetCh) {
          const area = getChannelArea(tab, p, targetCh);
          const vRange = targetCh.vMax - targetCh.vMin;
          if (vRange > 0) {
            if (tab.cursors.y1 !== null) {
              const y1Px = area.y + area.height - ((tab.cursors.y1 - targetCh.vMin) / vRange) * area.height;
              if (Math.abs(y - y1Px) < 10) {
                this.draggingCursor = 'y1';
                return;
              }
            }
            if (tab.cursors.y2 !== null) {
              const y2Px = area.y + area.height - ((tab.cursors.y2 - targetCh.vMin) / vRange) * area.height;
              if (Math.abs(y - y2Px) < 10) {
                this.draggingCursor = 'y2';
                return;
              }
            }
          }
        }
      }
    }

    if (e.shiftKey || this.isAreaZooming) {
      this.isAreaZooming = true;
      this.areaZoomStart = { x, y };
      this.areaZoomEnd = { x, y };
    } else {
      this.isDragging = true;
      this.dragStartX = x;
      this.dragStartY = y;
      this.initialViewStart = tab.view.startIndex;
      this.initialViewEnd = tab.view.endIndex;
    }
  }

  private handleMouseMove(e: MouseEvent): void {
    const tab = this.getActiveTab();
    if (!tab) return;

    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const p = getPlotArea(rect.width, rect.height);

    // Dragging Cursors or Ground Marker
    if (this.draggingCursor) {
      if (typeof this.draggingCursor === 'object' && 'groundChId' in this.draggingCursor) {
        const ch = tab.channels[this.draggingCursor.groundChId];
        if (ch) {
          const dy = this.draggingCursor.startY - y; // dragging up increases offset
          const vPerPixel = (ch.vMax - ch.vMin) / p.height;
          const newOffset = this.draggingCursor.initialOffset + dy * vPerPixel;
          this.setChannelOffset(ch.id, newOffset);
        }
        return;
      }

      if (this.draggingCursor === 'x1' || this.draggingCursor === 'x2') {
        const primaryCh = getTimeBaseChannel(tab);
        const tStart = primaryCh ? indexToTime(primaryCh, tab.view.startIndex) : 0;
        const tSpan = primaryCh ? Math.max(0, indexToTime(primaryCh, Math.max(tab.view.startIndex, tab.view.endIndex - 1)) - tStart) : 0;
        const tCur = tStart + ((x - p.x) / p.width) * tSpan;

        if (this.draggingCursor === 'x1') {
          tab.cursors.x1 = tCur;
        } else {
          tab.cursors.x2 = tCur;
        }
        this.draw();
        this.renderSidebar();
        return;
      }

      if (this.draggingCursor === 'y1' || this.draggingCursor === 'y2') {
        const targetCh = getCursorChannel(tab);
        if (targetCh) {
          const area = getChannelArea(tab, p, targetCh);
          const vRange = targetCh.vMax - targetCh.vMin;
          const voltFrac = (area.y + area.height - y) / area.height;
          const vCur = targetCh.vMin + voltFrac * vRange;

          if (this.draggingCursor === 'y1') {
            tab.cursors.y1 = vCur;
          } else {
            tab.cursors.y2 = vCur;
          }
          this.draw();
          this.renderSidebar();
        }
        return;
      }
    }

    // Dynamic mouse cursor pointer style
    if (!this.isDragging && !this.isAreaZooming) {
      let isNearCursor = false;
      if (tab.cursors.enabled) {
        const cursorType = tab.cursors.type || 'x';
        if (cursorType === 'x' || cursorType === 'xy') {
          const primaryCh = getTimeBaseChannel(tab);
          const tStart = primaryCh ? indexToTime(primaryCh, tab.view.startIndex) : 0;
          const tSpan = primaryCh ? Math.max(0, indexToTime(primaryCh, Math.max(tab.view.startIndex, tab.view.endIndex - 1)) - tStart) : 0;
          if (tSpan > 0 && tab.cursors.x1 !== null && tab.cursors.x2 !== null) {
            const x1Px = p.x + ((tab.cursors.x1 - tStart) / tSpan) * p.width;
            const x2Px = p.x + ((tab.cursors.x2 - tStart) / tSpan) * p.width;
            if (Math.abs(x - x1Px) < 10 || Math.abs(x - x2Px) < 10) {
              this.canvas.style.cursor = 'ew-resize';
              isNearCursor = true;
            }
          }
        }
        if (!isNearCursor && (cursorType === 'y' || cursorType === 'xy')) {
          const targetCh = getCursorChannel(tab);
          if (targetCh) {
            const area = getChannelArea(tab, p, targetCh);
            const vRange = targetCh.vMax - targetCh.vMin;
            if (vRange > 0) {
              if (tab.cursors.y1 !== null) {
                const y1Px = area.y + area.height - ((tab.cursors.y1 - targetCh.vMin) / vRange) * area.height;
                if (Math.abs(y - y1Px) < 10) {
                  this.canvas.style.cursor = 'ns-resize';
                  isNearCursor = true;
                }
              }
              if (!isNearCursor && tab.cursors.y2 !== null) {
                const y2Px = area.y + area.height - ((tab.cursors.y2 - targetCh.vMin) / vRange) * area.height;
                if (Math.abs(y - y2Px) < 10) {
                  this.canvas.style.cursor = 'ns-resize';
                  isNearCursor = true;
                }
              }
            }
          }
        }
      }
      if (!isNearCursor && !tab.separateView && x >= p.x - 22 && x <= p.x) {
        this.canvas.style.cursor = 'ns-resize';
        isNearCursor = true;
      }
      if (!isNearCursor) {
        this.canvas.style.cursor = 'crosshair';
      }
    }

    // Area Zoom drag
    if (this.isAreaZooming && this.areaZoomStart) {
      this.areaZoomEnd = { x, y };
      this.draw();
      return;
    }

    // Panning View
    if (this.isDragging) {
      const dx = x - this.dragStartX;
      const viewSpan = this.initialViewEnd - this.initialViewStart;
      const shiftPoints = Math.round((dx / p.width) * viewSpan);

      const primaryCh = getTimeBaseChannel(tab);
      const totalN = primaryCh?.v.length || 1000;

      let newStart = this.initialViewStart - shiftPoints;
      let newEnd = this.initialViewEnd - shiftPoints;

      if (newStart < 0) {
        newStart = 0;
        newEnd = viewSpan;
      } else if (newEnd > totalN) {
        newEnd = totalN;
        newStart = totalN - viewSpan;
      }

      tab.view.startIndex = Math.max(0, newStart);
      tab.view.endIndex = Math.min(totalN, newEnd);
      this.draw();
      this.renderSidebar();
      return;
    }

    // Hover readout
    if (x >= p.x && x <= p.x + p.width && y >= p.y && y <= p.y + p.height) {
      // Voltage follows the channel whose axis is shown (in Separate mode: the subplot under the mouse)
      let hoverCh = getActiveChannel(tab);
      const areas = computeSubplotAreas(tab, p);
      let area = p;
      if (areas) {
        for (const [id, a] of areas) {
          if (y >= a.y && y <= a.y + a.height) {
            hoverCh = tab.channels[id];
            area = a;
            break;
          }
        }
      }
      if (hoverCh) {
        const dataPt = screenToData({ x, y }, tab, hoverCh.id, area);
        this.updateHoverInfo(dataPt.time, dataPt.voltage, hoverCh);
      }
    }
  }

  private handleMouseUp(): void {
    const tab = this.getActiveTab();
    if (this.draggingCursor) {
      this.draggingCursor = null;
    }

    if (this.isAreaZooming && this.areaZoomStart && this.areaZoomEnd && tab) {
      const p = getPlotArea(this.cssW || this.canvas.clientWidth, this.cssH || this.canvas.clientHeight);
      const x1 = Math.min(this.areaZoomStart.x, this.areaZoomEnd.x);
      const x2 = Math.max(this.areaZoomStart.x, this.areaZoomEnd.x);

      if (x2 - x1 > 5) {
        const viewSpan = tab.view.endIndex - tab.view.startIndex;
        const fracStart = Math.max(0, (x1 - p.x) / p.width);
        const fracEnd = Math.min(1, (x2 - p.x) / p.width);

        const newStart = Math.floor(tab.view.startIndex + fracStart * viewSpan);
        const newEnd = Math.ceil(tab.view.startIndex + fracEnd * viewSpan);

        if (newEnd - newStart >= 10) {
          tab.view.startIndex = newStart;
          tab.view.endIndex = newEnd;
        }
      }
      this.isAreaZooming = false;
      this.areaZoomStart = null;
      this.areaZoomEnd = null;
      this.draw();
      this.renderSidebar();
      return;
    }

    this.isDragging = false;
  }

  private handleWheel(e: WheelEvent): void {
    e.preventDefault();
    const tab = this.getActiveTab();
    if (!tab) return;

    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const p = getPlotArea(rect.width, rect.height);

    // If mouse is on left voltage axis: Zoom vertical scale (V/div) with wheel!
    if (x < p.x && x >= p.x - 70) {
      const ch = getActiveChannel(tab);
      if (ch) {
        this.stepChannelScale(ch.id, e.deltaY < 0 ? 'down' : 'up');
      }
      return;
    }

    if (x < p.x || x > p.x + p.width) return;

    const zoomFactor = e.deltaY < 0 ? 0.8 : 1.25;
    const viewSpan = tab.view.endIndex - tab.view.startIndex;
    const mouseFrac = (x - p.x) / p.width;
    const mouseIdx = tab.view.startIndex + mouseFrac * viewSpan;

    const newSpan = Math.max(10, Math.round(viewSpan * zoomFactor));
    const primaryCh = getTimeBaseChannel(tab);
    const totalN = primaryCh?.v.length || 1000;

    let newStart = Math.round(mouseIdx - mouseFrac * newSpan);
    let newEnd = newStart + newSpan;

    if (newStart < 0) {
      newStart = 0;
      newEnd = Math.min(totalN, newSpan);
    }
    if (newEnd > totalN) {
      newEnd = totalN;
      newStart = Math.max(0, totalN - newSpan);
    }

    tab.view.startIndex = newStart;
    tab.view.endIndex = newEnd;
    this.draw();
    this.renderSidebar();
  }

  public fitView(): void {
    const tab = this.getActiveTab();
    if (!tab) return;

    const primaryCh = getTimeBaseChannel(tab);
    if (!primaryCh) return;

    tab.view.startIndex = 0;
    tab.view.endIndex = primaryCh.v.length;

    // Auto-fit 1-2-5 vertical scale and center offset for all visible channels
    for (const id of tab.drawOrder) {
      const ch = tab.channels[id];
      if (ch && ch.visible) {
        this.autoScaleChannel(id);
      }
    }

    this.draw();
    this.renderSidebar();
  }

  // --- File Handling (CSV, WFM, .graphx Session) ---
  public handleFiles(files: File[]): void {
    for (const file of files) {
      const ext = file.name.split('.').pop()?.toLowerCase();
      if (ext === 'graphx') {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const json = e.target?.result as string;
            const restored = deserializeSession(json);
            this.tabs = restored.tabs;
            this.activeTabIndex = restored.activeTabIndex;
            this.renderTabsBar();
            this.renderSidebar();
            this.draw();
          } catch (err: any) {
            alert(`Failed to load session: ${err.message}`);
          }
        };
        reader.readAsText(file);
      } else if (ext === 'wfm') {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const buf = e.target?.result as ArrayBuffer;
            const parsed = parseWfmBuffer(buf, file.name, OVERLAP_COLORS);
            const totalPoints = Object.values(parsed.channels)[0]?.v.length || 1000;
            const tab: TabState = {
              id: `tab_${Date.now()}_${Math.random()}`,
              fileName: file.name,
              channels: parsed.channels,
              drawOrder: parsed.drawOrder,
              view: { startIndex: 0, endIndex: totalPoints },
              cursors: { enabled: false, x1: null, x2: null, y1: null, y2: null, trackingChannel: null },
              annotations: [],
              annotationMode: false,
              annotationsVisible: true,
              isOverlap: false,
              plotMode: 'time',
              fftOptions: {
                range: 'view',
                window: 'hann',
                scale: 'db',
                zeroPadding: 1,
                removeDC: true,
              },
              motorConfig: { rpm: null, polePairs: null, enabled: false },
              triggerConfig: {
                enabled: false,
                channelId: parsed.drawOrder[0],
                type: 'rising',
                level: 0,
                positionPercent: 50,
              },
              measurementGate: 'view',
              separateView: false,
            };
            this.addTab(tab);
          } catch (err: any) {
            alert(`Failed to parse WFM: ${err.message}`);
          }
        };
        reader.readAsArrayBuffer(file);
      } else {
        // CSV or text file -> open CSV Quality & Mapping Modal
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const text = e.target?.result as string;
            this.showCsvImportModal(text, file.name);
          } catch (err: any) {
            alert(`Failed to inspect CSV: ${err.message}`);
          }
        };
        reader.readAsText(file);
      }
    }
  }

  public showCsvImportModal(text: string, fileName: string): void {
    this.pendingCsvText = text;
    this.pendingFileName = fileName;
    this.pendingCsvPreview = previewCsv(text);

    const modal = document.getElementById('csvQualityModal');
    if (!modal) return;

    modal.style.display = 'flex';
    this.renderCsvModalContent();
  }

  private renderCsvModalContent(): void {
    if (!this.pendingCsvPreview) return;
    const p = this.pendingCsvPreview;

    const previewContainer = document.getElementById('csvPreviewContainer');
    if (previewContainer) {
      let tableHtml = '<table class="min-w-full text-xs font-mono border-collapse">';
      tableHtml += '<thead class="bg-neutral-800 text-neutral-300"><tr>';
      p.headers.forEach((h: string, idx: number) => {
        const isTime = idx === p.timeColIndex;
        tableHtml += `<th class="p-2 border border-neutral-700 text-left ${isTime ? 'text-amber-400 font-bold' : ''}">
          <div class="flex flex-col gap-1">
            <span>${h}</span>
            <select class="col-role-select text-xs bg-neutral-900 border border-neutral-600 rounded px-1 text-white" data-col="${idx}">
              <option value="time" ${isTime ? 'selected' : ''}>Time</option>
              <option value="channel" ${!isTime ? 'selected' : ''}>Channel</option>
              <option value="ignore">Ignore</option>
            </select>
          </div>
        </th>`;
      });
      tableHtml += '</tr></thead><tbody>';

      p.rows.slice(0, 8).forEach((r: string[]) => {
        tableHtml += '<tr class="border-b border-neutral-700 hover:bg-neutral-800">';
        r.forEach((c: string) => {
          tableHtml += `<td class="p-2 border-r border-neutral-700 whitespace-nowrap">${c}</td>`;
        });
        tableHtml += '</tr>';
      });
      tableHtml += '</tbody></table>';
      previewContainer.innerHTML = tableHtml;

      // Bind select changes
      previewContainer.querySelectorAll('.col-role-select').forEach((sel) => {
        sel.addEventListener('change', (e: any) => {
          const colIdx = parseInt(e.target.dataset.col);
          const role = e.target.value;
          if (role === 'time') {
            // Only one time column may exist at a time.
            p.columnMappings.forEach((m) => {
              m.role = m.index === colIdx ? 'time' : (m.role === 'time' ? 'channel' : m.role);
            });
            p.timeColIndex = colIdx;
            this.renderCsvModalContent();
          } else {
            p.columnMappings[colIdx].role = role;
            if (colIdx === p.timeColIndex) p.timeColIndex = -1;
            this.renderCsvModalContent();
          }
        });
      });
    }

    const timeUnitSel = document.getElementById('csvTimeUnitSelect') as HTMLSelectElement;
    if (timeUnitSel) timeUnitSel.value = p.timeUnit;

    // Sample rate is only required when no time column exists.
    const sampleRateWrap = document.getElementById('csvSampleRateWrap');
    const sampleRateInput = document.getElementById('csvSampleRateInput') as HTMLInputElement | null;
    if (sampleRateWrap) sampleRateWrap.style.display = p.timeColIndex < 0 ? 'flex' : 'none';
    if (sampleRateInput && p.timeColIndex >= 0) sampleRateInput.value = '';

    const rowCountEl = document.getElementById('csvTotalRows');
    if (rowCountEl) rowCountEl.innerText = `${p.totalRows.toLocaleString()} rows`;

    const delimSel = document.getElementById('csvDelimiterSelect') as HTMLSelectElement;
    if (delimSel) {
      if (p.delimiter === ' ') delimSel.value = ' ';
      else if (p.delimiter === '\t') delimSel.value = '\t';
      else if (p.delimiter === ',') delimSel.value = ',';
      else if (p.delimiter === ';') delimSel.value = ';';
      else delimSel.value = 'auto';

      delimSel.onchange = (e: any) => {
        const selected = e.target.value;
        const chosenDelim = selected === 'auto' ? undefined : selected;
        try {
          this.pendingCsvPreview = previewCsv(this.pendingCsvText, chosenDelim);
          this.renderCsvModalContent();
        } catch (err: any) {
          console.error('Error re-parsing CSV preview with selected delimiter:', err);
        }
      };
    }
  }

  public confirmCsvImport(resample: boolean): void {
    if (!this.pendingCsvPreview || !this.pendingCsvText) return;

    try {
      const timeUnitSel = document.getElementById('csvTimeUnitSelect') as HTMLSelectElement;
      const timeUnit = (timeUnitSel?.value as 's' | 'ms' | 'us' | 'ns') || this.pendingCsvPreview.timeUnit;

      const sampleRateInput = document.getElementById('csvSampleRateInput') as HTMLInputElement | null;
      const sampleRate = sampleRateInput ? Number(sampleRateInput.value) : undefined;

      const parsed = parseFullCsv(this.pendingCsvText, {
        delimiter: this.pendingCsvPreview.delimiter,
        hasHeader: this.pendingCsvPreview.hasHeader,
        timeColIndex: this.pendingCsvPreview.timeColIndex,
        timeUnit,
        columnMappings: this.pendingCsvPreview.columnMappings,
        resample,
        sampleRate,
        colors: OVERLAP_COLORS,
      });

      const totalPoints = Object.values(parsed.channels)[0]?.v.length || 1000;
      const tab: TabState = {
        id: `tab_${Date.now()}_${Math.random()}`,
        fileName: this.pendingFileName,
        channels: parsed.channels,
        drawOrder: parsed.drawOrder,
        view: { startIndex: 0, endIndex: totalPoints },
        cursors: { enabled: false, x1: null, x2: null, y1: null, y2: null, trackingChannel: null },
        annotations: [],
        annotationMode: false,
        annotationsVisible: true,
        isOverlap: false,
        plotMode: 'time',
        fftOptions: {
          range: 'view',
          window: 'hann',
          scale: 'db',
          zeroPadding: 1,
          removeDC: true,
        },
        motorConfig: { rpm: null, polePairs: null, enabled: false },
        triggerConfig: {
          enabled: false,
          channelId: parsed.drawOrder[0],
          type: 'rising',
          level: 0,
          positionPercent: 50,
        },
        measurementGate: 'view',
        separateView: false,
      };

      this.addTab(tab);

      const modal = document.getElementById('csvQualityModal');
      if (modal) modal.style.display = 'none';
    } catch (err: any) {
      alert(`CSV Import Failed: ${err.message}`);
    }
  }

  // --- AutoSet & Trigger & Math UI Triggers ---
  public executeAutoSet(): void {
    const tab = this.getActiveTab();
    if (!tab) return;

    const res = performAutoSet(tab.channels, tab.drawOrder, tab.view);
    for (const [id, bounds] of Object.entries(res.updatedChannels)) {
      if (tab.channels[id]) {
        tab.channels[id].vMin = bounds.vMin;
        tab.channels[id].vMax = bounds.vMax;
      }
    }
    tab.view = res.view;
    tab.triggerConfig = res.triggerConfig;

    this.renderSidebar();
    this.draw();
  }

  /** Moves the view so the first trigger event sits at the configured screen position. */
  public applyTrigger(silent: boolean = false): void {
    const tab = this.getActiveTab();
    if (!tab || !tab.triggerConfig.enabled) return;

    const ch = tab.channels[tab.triggerConfig.channelId];
    if (!ch) return;

    const pt = findTriggerPoint(ch, tab.triggerConfig);
    if (pt) {
      tab.view = alignViewToTrigger(tab.view, ch, pt.triggerIndex, tab.triggerConfig.positionPercent);
      this.renderSidebar();
      this.draw();
    } else {
      const msg = `Trigger condition not found in channel "${ch.name}".`;
      if (silent) {
        this.flashStatus(msg);
        this.draw();
      } else {
        alert(msg);
      }
    }
  }

  /** Trigger ON/OFF button. Turning it on aligns the view to the first event. */
  public toggleTrigger(): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    const cfg = tab.triggerConfig;
    cfg.enabled = !cfg.enabled;
    if (cfg.enabled) {
      if (!cfg.channelId || !tab.channels[cfg.channelId]) {
        cfg.channelId = getActiveChannel(tab)?.id || tab.drawOrder[0] || '';
      }
      this.applyTrigger(true);
    }
    this.renderSidebar();
    this.draw();
  }

  /** Rising <-> falling edge trigger. */
  public toggleTriggerSlope(): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    tab.triggerConfig.type = tab.triggerConfig.type === 'rising' ? 'falling' : 'rising';
    if (tab.triggerConfig.enabled) this.applyTrigger(true);
    this.renderSidebar();
    this.draw();
  }

  /** Edge annotation (10% / 90% levels, tr / tf) ON/OFF. */
  public toggleEdgeMarks(): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    tab.showEdgeMarks = !tab.showEdgeMarks;
    this.updateToolbarState();
    this.draw();
  }

  // --- Low-pass filter ---
  private filterTargets(tab: TabState, scope: FilterScope): WaveformChannel[] {
    if (scope === 'active') {
      const a = getActiveChannel(tab);
      return a ? [a] : [];
    }
    if (scope === 'visible') return getVisibleChannels(tab).filter((c) => !c.isMath);
    return tab.drawOrder.map((id) => tab.channels[id]).filter((c): c is WaveformChannel => !!c && !c.isMath);
  }

  /**
   * Re-evaluates Math / Clarke channels from their (possibly just filtered) sources, keeping
   * their colour, scale and visibility.
   */
  private recomputeDerivedChannels(tab: TabState): void {
    for (const id of tab.drawOrder) {
      const ch = tab.channels[id];
      if (!ch || !ch.isMath) continue;
      try {
        if (id.startsWith('clarke_alpha_') || id.startsWith('clarke_beta_')) {
          const [ua, ub, uc] = ch.sourceChannelIds.map((sid) => tab.channels[sid]?.v);
          if (ua && ub && uc) {
            const { alpha, beta } = computeClarke(ua, ub, uc);
            tab.channels[id] = { ...ch, v: id.startsWith('clarke_alpha_') ? alpha : beta };
          }
        } else if (ch.mathExpression) {
          const fresh = evaluateMathExpression(ch.mathExpression, tab.channels, tab.drawOrder, id, ch.name);
          tab.channels[id] = { ...ch, t: fresh.t, v: fresh.v, fs: fresh.fs, dt: fresh.dt, metadata: fresh.metadata };
        }
      } catch (err) {
        console.warn(`Could not refresh derived channel ${id}:`, err);
      }
    }
  }

  private afterSampleDataChanged(tab: TabState): void {
    this.filterRev++;
    this.edgeCache = null;
    this.trigCache = null;
    this.cachedSpectrum = null;
    this.cachedSpectrumKey = '';
    this.recomputeDerivedChannels(tab);
    this.renderSidebar();
    this.draw();
  }

  /** Applies a -3 dB low-pass filter. Always filters from the original samples (no compounding). */
  public applyFilter(spec: ChannelFilterSpec, scope: FilterScope): { ok: boolean; message?: string; warning?: string } {
    const tab = this.getActiveTab();
    if (!tab) return { ok: false, message: 'No data loaded.' };

    const targets = this.filterTargets(tab, scope);
    if (targets.length === 0) return { ok: false, message: 'No channel to filter.' };
    if (targets.some((c) => c.isMath)) {
      return {
        ok: false,
        message: 'Math channels follow their source channels. Select an input channel, or choose "All input channels".',
      };
    }

    let warning: string | undefined;
    for (const ch of targets) {
      const check = validateFilterSpec(spec, ch.t);
      if (!check.ok) return { ok: false, message: `${ch.name}: ${check.message}` };
      if (check.warning) warning = check.warning;
    }

    for (const ch of targets) {
      if (!ch.vOriginal) ch.vOriginal = ch.v;
      ch.v = lowPassFilter(ch.t, ch.vOriginal, spec);
      ch.filter = { ...spec };
    }
    this.lastFilter = { spec: { ...spec }, scope };
    this.afterSampleDataChanged(tab);
    return { ok: true, warning };
  }

  public removeFilter(scope: FilterScope): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    let changed = false;
    for (const ch of this.filterTargets(tab, scope)) {
      if (ch.vOriginal) {
        ch.v = ch.vOriginal;
        ch.vOriginal = undefined;
        changed = true;
      }
      ch.filter = undefined;
    }
    if (changed) this.afterSampleDataChanged(tab);
    else this.updateToolbarState();
  }

  public getLastFilter(): { spec: ChannelFilterSpec; scope: FilterScope } | null {
    return this.lastFilter;
  }

  /** Toolbar LPF ON/OFF. Returns false when there is nothing to re-apply (caller opens the dialog). */
  public toggleFilter(): boolean {
    const tab = this.getActiveTab();
    if (!tab) return true;
    const active = getActiveChannel(tab);
    if (!active) return true;
    if (active.filter) {
      this.removeFilter(this.lastFilter?.scope === 'active' || !this.lastFilter ? 'active' : this.lastFilter.scope);
      return true;
    }
    if (!this.lastFilter) return false;
    const res = this.applyFilter(this.lastFilter.spec, this.lastFilter.scope);
    if (!res.ok) this.flashStatus(res.message || 'Filter failed.');
    return true;
  }

  public addMathChannel(expr: string, name: string): { success: boolean; error?: string } {
    const tab = this.getActiveTab();
    if (!tab) return { success: false, error: 'No active dataset or tab found.' };

    try {
      const mathId = `math_${Date.now()}`;
      const mathCh = evaluateMathExpression(expr, tab.channels, tab.drawOrder, mathId, name);
      tab.channels[mathId] = mathCh;
      tab.drawOrder.push(mathId);

      // Auto-select newly created math channel for measurements & FFT
      tab.selectedMeasurementChannelId = mathId;
      tab.selectedFftChannelId = mathId;
      this.cachedSpectrum = null;
      this.cachedSpectrumKey = '';

      this.renderSidebar();
      this.draw();

      // Smoothly scroll to the math channels section so the user sees it immediately
      setTimeout(() => {
        const mathEl = document.getElementById('mathChannelsListPanel');
        mathEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);

      return { success: true };
    } catch (err: any) {
      console.error('Math evaluation error:', err);
      return { success: false, error: err.message };
    }
  }

  public analyzeChannelWithFFT(channelId: string): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    tab.plotMode = 'frequency';
    tab.selectedFftChannelId = channelId;
    this.cachedSpectrum = null;
    this.cachedSpectrumKey = '';

    const timeBtn = document.getElementById('timeModeBtn');
    const freqBtn = document.getElementById('freqModeBtn');
    freqBtn?.classList.add('bg-[#0078d7]', 'text-white');
    freqBtn?.classList.remove('bg-neutral-800', 'text-neutral-300');
    timeBtn?.classList.remove('bg-[#0078d7]', 'text-white');
    timeBtn?.classList.add('bg-neutral-800', 'text-neutral-300');

    this.renderSidebar();
    this.draw();
  }

  public applyFrequencySpan(tab: TabState, spanMode: string): void {
    const targetId = tab.selectedFftChannelId || tab.drawOrder[0];
    const targetCh = tab.channels[targetId] || tab.channels[tab.drawOrder[0]];
    const nyquist = (targetCh?.fs || 1e5) / 2;

    if (spanMode === 'auto') {
      if (this.cachedSpectrum && this.cachedSpectrum.peaks.length > 0) {
        const fund = this.cachedSpectrum.peaks[0];
        const span = Math.min(nyquist, Math.max(1000, Math.ceil((fund.frequency * 8) / 1000) * 1000));
        tab.view.fMin = 0;
        tab.view.fMax = span;
      } else {
        tab.view.fMin = 0;
        tab.view.fMax = Math.min(nyquist, 5000);
      }
    } else if (spanMode === '1k') {
      tab.view.fMin = 0;
      tab.view.fMax = Math.min(nyquist, 1000);
    } else if (spanMode === '5k') {
      tab.view.fMin = 0;
      tab.view.fMax = Math.min(nyquist, 5000);
    } else if (spanMode === '20k') {
      tab.view.fMin = 0;
      tab.view.fMax = Math.min(nyquist, 20000);
    } else if (spanMode === 'full') {
      tab.view.fMin = 0;
      tab.view.fMax = nyquist;
    }
    this.draw();
  }

  public executeClarkeTransform(uaId: string, ubId: string, ucId: string): void {
    const tab = this.getActiveTab();
    if (!tab) return;

    const ua = tab.channels[uaId]?.v;
    const ub = tab.channels[ubId]?.v;
    const uc = tab.channels[ucId]?.v;

    if (!ua || !ub || !uc) {
      alert('Selected phase channels are invalid.');
      return;
    }

    try {
      const { alpha, beta } = computeClarke(ua, ub, uc);
      const baseCh = tab.channels[uaId];

      const alphaId = `clarke_alpha_${Date.now()}`;
      const betaId = `clarke_beta_${Date.now()}`;

      // Calculate exact min/max bounds for Alpha
      let minA = Infinity, maxA = -Infinity;
      for (let i = 0; i < alpha.length; i++) {
        const val = alpha[i];
        if (!isNaN(val)) {
          if (val < minA) minA = val;
          if (val > maxA) maxA = val;
        }
      }
      if (!isFinite(minA)) minA = -1;
      if (!isFinite(maxA)) maxA = 1;
      const marginA = (maxA - minA) * 0.1 || 1.0;

      // Calculate exact min/max bounds for Beta
      let minB = Infinity, maxB = -Infinity;
      for (let i = 0; i < beta.length; i++) {
        const val = beta[i];
        if (!isNaN(val)) {
          if (val < minB) minB = val;
          if (val > maxB) maxB = val;
        }
      }
      if (!isFinite(minB)) minB = -1;
      if (!isFinite(maxB)) maxB = 1;
      const marginB = (maxB - minB) * 0.1 || 1.0;

      tab.channels[alphaId] = {
        ...baseCh,
        id: alphaId,
        name: 'Clarke Alpha (α)',
        unit: baseCh.unit || 'V',
        color: '#ff007f',
        visible: true,
        v: alpha,
        vOriginal: undefined,
        filter: undefined,
        isMath: true,
        mathExpression: `Clarke α(${tab.channels[uaId].name}, ${tab.channels[ubId].name}, ${tab.channels[ucId].name})`,
        sourceChannelIds: [uaId, ubId, ucId],
        vMin: minA - marginA,
        vMax: maxA + marginA,
      };

      tab.channels[betaId] = {
        ...baseCh,
        id: betaId,
        name: 'Clarke Beta (β)',
        unit: baseCh.unit || 'V',
        color: '#00e676',
        visible: true,
        v: beta,
        vOriginal: undefined,
        filter: undefined,
        isMath: true,
        mathExpression: `Clarke β(${tab.channels[uaId].name}, ${tab.channels[ubId].name}, ${tab.channels[ucId].name})`,
        sourceChannelIds: [uaId, ubId, ucId],
        vMin: minB - marginB,
        vMax: maxB + marginB,
      };

      tab.drawOrder.push(alphaId, betaId);

      // Auto-select Clarke Alpha for measurements and FFT
      tab.selectedMeasurementChannelId = alphaId;
      tab.selectedFftChannelId = alphaId;
      this.cachedSpectrum = null;
      this.cachedSpectrumKey = '';

      this.renderSidebar();
      this.draw();
    } catch (err: any) {
      alert(`Clarke Transform Failed: ${err.message}`);
    }
  }

  // --- DOM Rendering Helpers ---
  public renderTabsBar(): void {
    const container = document.getElementById('tabsContainer');
    if (!container) return;

    container.innerHTML = '';
    this.tabs.forEach((tab, idx) => {
      const isActive = idx === this.activeTabIndex;
      const tabEl = document.createElement('div');
      tabEl.className = `tab-item flex items-center gap-2 px-3 py-1.5 cursor-pointer rounded-t text-sm border-r border-neutral-700 ${
        isActive ? 'bg-[#0078d7] text-white font-medium' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
      }`;
      tabEl.innerHTML = `
        <span class="truncate max-w-[140px]">${tab.fileName}</span>
        <button class="tab-close ml-1 hover:bg-black/30 rounded px-1" title="Close Tab">×</button>
      `;

      tabEl.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('tab-close')) {
          e.stopPropagation();
          this.closeTab(idx);
        } else {
          this.setActiveTab(idx);
        }
      });

      container.appendChild(tabEl);
    });
  }

  public renderSidebar(): void {
    const tab = this.getActiveTab();
    if (!tab) return;

    // Toggle Sidebar Panels based on Plot Mode (prevents duplicates and cluttered controls)
    const measSection = document.getElementById('measurementsSidebarSection');
    const fftPanel = document.getElementById('fftSidebarPanel');
    if (tab.plotMode === 'frequency') {
      if (measSection) measSection.style.display = 'none';
      if (fftPanel) fftPanel.style.display = 'block';
    } else {
      if (measSection) measSection.style.display = 'block';
      if (fftPanel) fftPanel.style.display = 'none';
    }

    // File summary
    const fileSummaryEl = document.getElementById('fileSummaryPanel');
    if (fileSummaryEl) {
      const primaryCh = tab.channels[tab.drawOrder[0]];
      const meta = primaryCh?.metadata;
      const sampleRateStr = primaryCh?.fs ? formatEng(primaryCh.fs, 'S/s', 3) : 'Non-uniform';
      const durationStr = primaryCh ? formatEng(primaryCh.t[primaryCh.t.length - 1] - primaryCh.t[0], 's', 3) : '0 s';
      const qualityBadge = meta
        ? meta.qualityStatus === 'uniform'
          ? '<span class="text-green-400 font-bold">Uniform</span>'
          : meta.qualityStatus === 'non-uniform'
          ? '<span class="text-yellow-400 font-bold">Non-uniform</span>'
          : '<span class="text-red-400 font-bold">Severe Jitter</span>'
        : 'N/A';

      fileSummaryEl.innerHTML = `
        <div class="flex justify-between text-xs py-0.5"><span>File:</span><span class="font-mono truncate max-w-[150px]">${tab.fileName}</span></div>
        <div class="flex justify-between text-xs py-0.5"><span>Points:</span><span class="font-mono">${primaryCh?.v.length.toLocaleString() || 0}</span></div>
        <div class="flex justify-between text-xs py-0.5"><span>Sample Rate:</span><span class="font-mono">${sampleRateStr}</span></div>
        <div class="flex justify-between text-xs py-0.5"><span>Duration:</span><span class="font-mono">${durationStr}</span></div>
        <div class="flex justify-between text-xs py-0.5"><span>Quality:</span><span>${qualityBadge}</span></div>
        ${meta && meta.jitterRms !== null ? `<div class="flex justify-between text-xs py-0.5"><span>Jitter RMS:</span><span class="font-mono">${meta.jitterRms.toFixed(2)}%</span></div>` : ''}
        ${meta && meta.gapCount > 0 ? `<div class="flex justify-between text-xs py-0.5 text-amber-400"><span>Gaps Detected:</span><span class="font-mono font-bold">${meta.gapCount}</span></div>` : ''}
        ${meta && meta.belowTargetRate ? `<div class="text-xs py-0.5 text-red-400 font-bold">⚠ Below 20MHz target -- source lacks bandwidth for fast edges (re-export at full rate)</div>` : ''}
      `;
    }

    // Input channels list
    const inputChannelsListEl = document.getElementById('inputChannelsListPanel');
    const mathChannelsListEl = document.getElementById('mathChannelsListPanel');
    const mathCountBadge = document.getElementById('mathCountBadge');

    const inputChannelIds = tab.drawOrder.filter((id) => !tab.channels[id]?.isMath);
    const mathChannelIds = tab.drawOrder.filter((id) => tab.channels[id]?.isMath);

    if (mathCountBadge) {
      mathCountBadge.innerText = mathChannelIds.length.toString();
    }

    const activeId = getActiveChannel(tab)?.id;

    if (inputChannelsListEl) {
      inputChannelsListEl.innerHTML = '';
      if (inputChannelIds.length === 0) {
        inputChannelsListEl.innerHTML = '<div class="text-xs text-neutral-500">No channels available</div>';
      } else {
        inputChannelIds.forEach((id) => {
          const ch = tab.channels[id];
          if (!ch) return;

          const isActive = id === activeId;
          const vPerDiv = ch.vPerDiv || (ch.vMax - ch.vMin) / 8;
          const vOffset = ch.vOffset !== undefined ? ch.vOffset : (ch.vMax + ch.vMin) / 2;

          const row = document.createElement('div');
          row.className = `channel-item flex flex-col p-2.5 rounded mb-2 text-xs border-l-4 transition ${
            isActive ? 'bg-neutral-800 border border-cyan-800/80' : 'bg-neutral-800/80 hover:bg-neutral-800 border border-neutral-700/50'
          }`;
          row.style.borderLeftColor = ch.color;

          row.innerHTML = `
            <div class="flex items-center justify-between mb-1.5">
              <div class="flex items-center gap-1.5 overflow-hidden">
                <input type="checkbox" class="ch-vis-chk cursor-pointer" ${ch.visible ? 'checked' : ''} />
                <input type="color" class="ch-col-picker w-4 h-4 rounded cursor-pointer border-none bg-transparent" value="${ch.color}" />
                <span class="font-bold truncate text-neutral-100 max-w-[110px] cursor-pointer ch-select-name hover:text-cyan-300" title="Click to make Active Channel">${ch.name}</span>
              </div>
              <div class="flex items-center gap-1 font-mono text-[10px]">
                ${isActive ? '<span class="bg-cyan-950 text-cyan-300 px-1.5 py-0.5 rounded border border-cyan-700/60 font-semibold">ACTIVE</span>' : ''}
                <button class="ch-fit-btn px-1.5 py-0.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded font-medium transition" title="Auto-scale 1-2-5 & center">AutoFit</button>
              </div>
            </div>

            <!-- Scale (步进 V/div) -->
            <div class="flex items-center justify-between text-[11px] py-1 border-t border-neutral-700/40">
              <span class="text-neutral-400 font-medium">Scale (步进):</span>
              <div class="flex items-center gap-1">
                <button class="ch-scale-down px-1.5 py-0.5 bg-neutral-700 hover:bg-neutral-600 rounded text-neutral-200 font-bold" title="Decrease V/div (Zoom In)">−</button>
                <input type="number" step="any" class="ch-scale-input w-16 bg-neutral-900 border border-neutral-600 rounded px-1 py-0.5 text-right font-mono text-white text-[11px]" value="${vPerDiv.toPrecision(3)}" title="Volts per division" />
                <span class="text-neutral-400 text-[10px]">${ch.unit}/div</span>
                <button class="ch-scale-up px-1.5 py-0.5 bg-neutral-700 hover:bg-neutral-600 rounded text-neutral-200 font-bold" title="Increase V/div (Zoom Out)">+</button>
              </div>
            </div>

            <!-- Offset (上下偏移) -->
            <div class="flex items-center justify-between text-[11px] py-1 border-t border-neutral-700/40">
              <span class="text-neutral-400 font-medium">Offset (偏移):</span>
              <div class="flex items-center gap-1">
                <button class="ch-offset-zero px-1.5 py-0.5 bg-neutral-700 hover:bg-neutral-600 rounded text-amber-300 font-mono text-[10px] font-bold" title="Reset Offset to 0">0</button>
                <button class="ch-offset-down px-1.5 py-0.5 bg-neutral-700 hover:bg-neutral-600 rounded text-neutral-200 text-[10px]" title="Shift Down (▼)">▼</button>
                <input type="number" step="any" class="ch-offset-input w-16 bg-neutral-900 border border-neutral-600 rounded px-1 py-0.5 text-right font-mono text-white text-[11px]" value="${vOffset.toFixed(3)}" title="Vertical offset in ${ch.unit}" />
                <span class="text-neutral-400 text-[10px]">${ch.unit}</span>
                <button class="ch-offset-up px-1.5 py-0.5 bg-neutral-700 hover:bg-neutral-600 rounded text-neutral-200 text-[10px]" title="Shift Up (▲)">▲</button>
              </div>
            </div>

            <!-- Bounds Readout -->
            <div class="flex justify-between items-center text-[10px] text-neutral-400 pt-0.5 font-mono">
              <span>Span: [${ch.vMin.toFixed(2)}, ${ch.vMax.toFixed(2)}] ${ch.unit}</span>
            </div>
          `;

          row.querySelector('.ch-vis-chk')?.addEventListener('change', (e: any) => {
            const before = getCursorChannel(tab);
            ch.visible = e.target.checked;
            this.onVisibilityChanged(tab, before);
          });

          row.querySelector('.ch-col-picker')?.addEventListener('input', (e: any) => {
            ch.color = e.target.value;
            row.style.borderLeftColor = ch.color;
            this.draw();
          });

          row.querySelector('.ch-select-name')?.addEventListener('click', () => {
            this.setActiveChannel(tab, id);
          });

          row.querySelector('.ch-fit-btn')?.addEventListener('click', () => {
            this.autoScaleChannel(id);
          });

          row.querySelector('.ch-scale-down')?.addEventListener('click', () => {
            this.stepChannelScale(id, 'down');
          });

          row.querySelector('.ch-scale-up')?.addEventListener('click', () => {
            this.stepChannelScale(id, 'up');
          });

          row.querySelector('.ch-scale-input')?.addEventListener('change', (e: any) => {
            const val = parseFloat(e.target.value);
            if (!isNaN(val) && val > 0) {
              this.setChannelScale(id, val);
            }
          });

          row.querySelector('.ch-offset-zero')?.addEventListener('click', () => {
            this.zeroChannelOffset(id);
          });

          row.querySelector('.ch-offset-down')?.addEventListener('click', () => {
            this.nudgeChannelOffset(id, 'down');
          });

          row.querySelector('.ch-offset-up')?.addEventListener('click', () => {
            this.nudgeChannelOffset(id, 'up');
          });

          row.querySelector('.ch-offset-input')?.addEventListener('change', (e: any) => {
            const val = parseFloat(e.target.value);
            if (!isNaN(val)) {
              this.setChannelOffset(id, val);
            }
          });

          inputChannelsListEl.appendChild(row);
        });
      }
    }

    // Math channels list
    if (mathChannelsListEl) {
      mathChannelsListEl.innerHTML = '';
      if (mathChannelIds.length === 0) {
        mathChannelsListEl.innerHTML = '<div class="text-xs text-neutral-500 italic">No math channels yet. Click "+ Math" or "αβ" above.</div>';
      } else {
        mathChannelIds.forEach((id) => {
          const ch = tab.channels[id];
          if (!ch) return;

          const isActive = id === activeId;
          const vPerDiv = ch.vPerDiv || (ch.vMax - ch.vMin) / 8;
          const vOffset = ch.vOffset !== undefined ? ch.vOffset : (ch.vMax + ch.vMin) / 2;

          const row = document.createElement('div');
          row.className = `channel-item flex flex-col p-2.5 rounded mb-2 text-xs border-l-4 transition ${
            isActive ? 'bg-purple-950/70 border border-purple-600' : 'bg-purple-950/40 border border-purple-800/40 hover:bg-purple-950/60'
          }`;
          row.style.borderLeftColor = ch.color;

          row.innerHTML = `
            <div class="flex items-center justify-between mb-1.5">
              <div class="flex items-center gap-1.5 overflow-hidden">
                <input type="checkbox" class="ch-vis-chk cursor-pointer" ${ch.visible ? 'checked' : ''} />
                <input type="color" class="ch-col-picker w-4 h-4 rounded cursor-pointer border-none bg-transparent" value="${ch.color}" />
                <span class="font-bold text-purple-200 truncate max-w-[105px] cursor-pointer ch-select-name hover:text-white" title="Click to make Active Channel">${ch.name}</span>
              </div>
              <div class="flex items-center gap-1 font-mono text-[10px]">
                <button class="ch-fit-btn px-1.5 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded font-medium transition" title="Auto-scale 1-2-5 & center">AutoFit</button>
                <button class="ch-fft-btn px-1.5 py-0.5 bg-purple-900/70 hover:bg-purple-800 text-purple-200 rounded font-semibold transition" title="Analyze with FFT">FFT</button>
                <button class="ch-del-btn text-red-400 hover:text-red-300 px-1 py-0.5" title="Delete math channel">✕</button>
              </div>
            </div>

            <!-- Scale (步进 V/div) -->
            <div class="flex items-center justify-between text-[11px] py-1 border-t border-purple-800/40">
              <span class="text-neutral-400 font-medium">Scale (步进):</span>
              <div class="flex items-center gap-1">
                <button class="ch-scale-down px-1.5 py-0.5 bg-neutral-800 hover:bg-neutral-700 rounded text-neutral-200 font-bold" title="Decrease V/div (Zoom In)">−</button>
                <input type="number" step="any" class="ch-scale-input w-16 bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5 text-right font-mono text-white text-[11px]" value="${vPerDiv.toPrecision(3)}" title="Volts per division" />
                <span class="text-neutral-400 text-[10px]">${ch.unit}/div</span>
                <button class="ch-scale-up px-1.5 py-0.5 bg-neutral-800 hover:bg-neutral-700 rounded text-neutral-200 font-bold" title="Increase V/div (Zoom Out)">+</button>
              </div>
            </div>

            <!-- Offset (上下偏移) -->
            <div class="flex items-center justify-between text-[11px] py-1 border-t border-purple-800/40">
              <span class="text-neutral-400 font-medium">Offset (偏移):</span>
              <div class="flex items-center gap-1">
                <button class="ch-offset-zero px-1.5 py-0.5 bg-neutral-800 hover:bg-neutral-700 rounded text-amber-300 font-mono text-[10px] font-bold" title="Reset Offset to 0">0</button>
                <button class="ch-offset-down px-1.5 py-0.5 bg-neutral-800 hover:bg-neutral-700 rounded text-neutral-200 text-[10px]" title="Shift Down (▼)">▼</button>
                <input type="number" step="any" class="ch-offset-input w-16 bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5 text-right font-mono text-white text-[11px]" value="${vOffset.toFixed(3)}" title="Vertical offset in ${ch.unit}" />
                <span class="text-neutral-400 text-[10px]">${ch.unit}</span>
                <button class="ch-offset-up px-1.5 py-0.5 bg-neutral-800 hover:bg-neutral-700 rounded text-neutral-200 text-[10px]" title="Shift Up (▲)">▲</button>
              </div>
            </div>

            <div class="flex justify-between items-center text-[10px] text-neutral-400 mt-1 font-mono">
              <span class="truncate max-w-[140px] text-purple-300/90 font-mono" title="${ch.mathExpression || ''}">${ch.mathExpression || 'Math'}</span>
              <span>[${ch.vMin.toFixed(2)}, ${ch.vMax.toFixed(2)}] ${ch.unit}</span>
            </div>
          `;

          row.querySelector('.ch-vis-chk')?.addEventListener('change', (e: any) => {
            const before = getCursorChannel(tab);
            ch.visible = e.target.checked;
            this.onVisibilityChanged(tab, before);
          });

          row.querySelector('.ch-col-picker')?.addEventListener('input', (e: any) => {
            ch.color = e.target.value;
            row.style.borderLeftColor = ch.color;
            this.draw();
          });

          row.querySelector('.ch-select-name')?.addEventListener('click', () => {
            this.setActiveChannel(tab, id);
          });

          row.querySelector('.ch-fft-btn')?.addEventListener('click', () => {
            this.analyzeChannelWithFFT(id);
          });

          row.querySelector('.ch-fit-btn')?.addEventListener('click', () => {
            this.autoScaleChannel(id);
          });

          row.querySelector('.ch-scale-down')?.addEventListener('click', () => {
            this.stepChannelScale(id, 'down');
          });

          row.querySelector('.ch-scale-up')?.addEventListener('click', () => {
            this.stepChannelScale(id, 'up');
          });

          row.querySelector('.ch-scale-input')?.addEventListener('change', (e: any) => {
            const val = parseFloat(e.target.value);
            if (!isNaN(val) && val > 0) {
              this.setChannelScale(id, val);
            }
          });

          row.querySelector('.ch-offset-zero')?.addEventListener('click', () => {
            this.zeroChannelOffset(id);
          });

          row.querySelector('.ch-offset-down')?.addEventListener('click', () => {
            this.nudgeChannelOffset(id, 'down');
          });

          row.querySelector('.ch-offset-up')?.addEventListener('click', () => {
            this.nudgeChannelOffset(id, 'up');
          });

          row.querySelector('.ch-offset-input')?.addEventListener('change', (e: any) => {
            const val = parseFloat(e.target.value);
            if (!isNaN(val)) {
              this.setChannelOffset(id, val);
            }
          });

          row.querySelector('.ch-del-btn')?.addEventListener('click', () => {
            delete tab.channels[id];
            tab.drawOrder = tab.drawOrder.filter((chId) => chId !== id);
            if (tab.selectedMeasurementChannelId === id) {
              tab.selectedMeasurementChannelId = tab.drawOrder[0];
            }
            if (tab.cursors.trackingChannel === id) tab.cursors.trackingChannel = null;
            if (tab.triggerConfig.channelId === id) tab.triggerConfig.channelId = tab.drawOrder[0] || '';
            if (tab.selectedFftChannelId === id) {
              tab.selectedFftChannelId = tab.drawOrder[0];
              this.cachedSpectrum = null;
              this.cachedSpectrumKey = '';
            }
            this.renderSidebar();
            this.draw();
          });

          mathChannelsListEl.appendChild(row);
        });
      }
    }

    // Sync Cursor Selectors in Toolbar
    const cursorChannelSel = document.getElementById('cursorChannelSelect') as HTMLSelectElement;
    if (cursorChannelSel) {
      const items: Array<{ value: string; label: string }> = [{ value: '', label: 'Auto (active)' }];
      tab.drawOrder.forEach((id) => {
        const ch = tab.channels[id];
        if (ch) items.push({ value: id, label: ch.visible ? ch.name : `${ch.name} (hidden)` });
      });
      this.syncSelect(cursorChannelSel, items, tab.cursors.trackingChannel || '');
      cursorChannelSel.onchange = (e: any) => {
        this.setCursorChannel(tab, e.target.value);
      };
      const cType = tab.cursors.type || 'x';
      if (tab.cursors.enabled && (cType === 'y' || cType === 'xy')) {
        cursorChannelSel.classList.remove('hidden');
        const eff = getCursorChannel(tab);
        cursorChannelSel.title = eff ? `Y cursors measure: ${eff.name}` : 'Select Y-cursor channel';
      } else {
        cursorChannelSel.classList.add('hidden');
      }
    }

    const cursorTypeSel = document.getElementById('cursorTypeSelect') as HTMLSelectElement;
    if (cursorTypeSel) {
      cursorTypeSel.value = tab.cursors.enabled ? (tab.cursors.type || 'x') : 'off';
    }

    // Populate Channel Selectors for Measurements and FFT
    const measChannelSel = document.getElementById('measChannelSelect') as HTMLSelectElement;
    if (measChannelSel) {
      const items = tab.drawOrder
        .filter((id) => tab.channels[id])
        .map((id) => ({ value: id, label: tab.channels[id].isMath ? `[Math] ${tab.channels[id].name}` : tab.channels[id].name }));
      this.syncSelect(measChannelSel, items, getActiveChannel(tab)?.id || '');
      measChannelSel.onchange = (e: any) => {
        this.setActiveChannel(tab, e.target.value);
      };
    }

    const fftChannelSel = document.getElementById('fftChannelSelect') as HTMLSelectElement;
    if (fftChannelSel) {
      const items = tab.drawOrder
        .filter((id) => tab.channels[id])
        .map((id) => {
          const ch = tab.channels[id];
          return { value: id, label: ch.isMath ? `[Math] ${ch.name} (${ch.mathExpression || ''})` : ch.name };
        });
      this.syncSelect(fftChannelSel, items, tab.selectedFftChannelId || tab.drawOrder[0] || '');
      fftChannelSel.onchange = (e: any) => {
        tab.selectedFftChannelId = e.target.value;
        this.cachedSpectrum = null;
        this.cachedSpectrumKey = '';
        this.draw();
      };
    }

    // Sync FFT controls values
    const spanSel = document.getElementById('fftSpanSelect') as HTMLSelectElement;
    if (spanSel) {
      if (!tab.view.fMin && !tab.view.fMax) {
        spanSel.value = 'auto';
      }
    }

    const rangeSel = document.getElementById('fftRangeSelect') as HTMLSelectElement;
    if (rangeSel) rangeSel.value = tab.fftOptions.range;

    const winSel = document.getElementById('fftWindowSelect') as HTMLSelectElement;
    if (winSel) winSel.value = tab.fftOptions.window;

    const scaleSel = document.getElementById('fftScaleSelect') as HTMLSelectElement;
    if (scaleSel) scaleSel.value = tab.fftOptions.scale;

    const padSel = document.getElementById('fftPaddingSelect') as HTMLSelectElement;
    if (padSel) padSel.value = tab.fftOptions.zeroPadding.toString();

    const dcChk = document.getElementById('fftRemoveDcChk') as HTMLInputElement;
    if (dcChk) dcChk.checked = tab.fftOptions.removeDC;

    // Live Measurements
    this.renderLiveMeasurements(tab);
    this.updateToolbarState();
  }

  /**
   * Updates a <select> without tearing it down when nothing changed. Rebuilding the options of
   * a select while its popup is open makes the browser repaint the popup with its default
   * (white) palette, so only touch the DOM when the option list really differs.
   */
  private syncSelect(sel: HTMLSelectElement, items: Array<{ value: string; label: string }>, value: string): void {
    const sig = items.map((i) => `${i.value}\u0000${i.label}`).join('\u0001');
    if (sel.dataset.sig !== sig) {
      sel.innerHTML = '';
      for (const it of items) {
        const opt = document.createElement('option');
        opt.value = it.value;
        opt.textContent = it.label;
        sel.appendChild(opt);
      }
      sel.dataset.sig = sig;
    }
    if (sel.value !== value) sel.value = value;
  }

  /** Reflects trigger / filter / edge-mark state on the toolbar buttons. */
  public updateToolbarState(): void {
    const tab = this.getActiveTab();
    const setCls = (el: HTMLElement | null, on: string[], off: string[], active: boolean) => {
      if (!el) return;
      el.classList.remove(...(active ? off : on));
      el.classList.add(...(active ? on : off));
    };

    const trigToggle = document.getElementById('triggerToggleBtn');
    const trigSlope = document.getElementById('triggerSlopeBtn');
    const trigOn = !!tab && tab.triggerConfig.enabled;
    if (trigToggle) {
      trigToggle.textContent = trigOn ? 'Trig ON' : 'Trig OFF';
      setCls(trigToggle, ['bg-amber-600', 'text-black', 'border-amber-400'], ['bg-neutral-800', 'text-neutral-400', 'border-neutral-600'], trigOn);
    }
    if (trigSlope && tab) {
      trigSlope.textContent = tab.triggerConfig.type === 'rising' ? '↑ Rising' : '↓ Falling';
      trigSlope.title = 'Click to switch trigger slope (rising / falling)';
      setCls(trigSlope, ['text-amber-300'], ['text-neutral-400'], trigOn);
    }

    const edgeBtn = document.getElementById('edgeMarksBtn');
    if (edgeBtn) {
      const on = !!tab && !!tab.showEdgeMarks;
      setCls(edgeBtn, ['bg-emerald-700', 'text-white', 'border-emerald-400'], ['bg-neutral-700', 'text-neutral-200', 'border-transparent'], on);
    }

    const filterBtn = document.getElementById('filterBtn');
    const filterToggle = document.getElementById('filterToggleBtn');
    const act = tab ? getActiveChannel(tab) : undefined;
    const fOn = !!act && !!act.filter;
    if (filterBtn) {
      filterBtn.textContent = fOn ? `Filter · ${describeFilter(act!.filter!).replace(/ \(.*$/, '')}` : 'Filter';
      filterBtn.title = fOn ? describeFilter(act!.filter!) : 'Low-pass filter (-3 dB cutoff)';
    }
    if (filterToggle) {
      filterToggle.textContent = fOn ? 'LPF ON' : 'LPF OFF';
      setCls(filterToggle, ['bg-cyan-700', 'text-white', 'border-cyan-400'], ['bg-neutral-800', 'text-neutral-400', 'border-neutral-600'], fOn);
    }
  }

  private flashStatus(msg: string): void {
    this.statusFlash = msg;
    if (this.statusFlashTimer) window.clearTimeout(this.statusFlashTimer);
    this.statusFlashTimer = window.setTimeout(() => {
      this.statusFlash = '';
      this.updateStatusBar();
    }, 4000);
    this.updateStatusBar();
  }

  private renderLiveMeasurements(tab: TabState): void {
    const measContainer = document.getElementById('measurementsPanel');
    if (!measContainer) return;

    const targetCh = getActiveChannel(tab);
    if (!targetCh) {
      measContainer.innerHTML = '<div class="text-xs text-neutral-400">No active channel for measurement</div>';
      return;
    }

    const m = computeMeasurements(targetCh, tab.measurementGate, tab.view, tab.cursors);

    const fmtVal = (v: number | null, unit: string) =>
      v !== null ? formatEng(v, unit, 3) : '<span class="text-neutral-500">N/A</span>';

    measContainer.innerHTML = `
      <div class="flex justify-between items-center mb-2 pb-1 border-b border-neutral-700">
        <span class="text-xs font-semibold ${targetCh.isMath ? 'text-purple-300' : 'text-neutral-200'} truncate max-w-[150px]">${targetCh.name} (${targetCh.unit})</span>
        ${targetCh.filter ? `<span class="text-[10px] text-cyan-300 font-mono" title="${describeFilter(targetCh.filter)}">LPF</span>` : ''}
      </div>
      <div class="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] font-mono">
        <div class="flex justify-between"><span>Vpp:</span><span class="font-bold text-neutral-100">${fmtVal(m.vpp, targetCh.unit)}</span></div>
        <div class="flex justify-between"><span>RMS:</span><span>${fmtVal(m.rms, targetCh.unit)}</span></div>
        <div class="flex justify-between"><span>Max:</span><span>${fmtVal(m.max, targetCh.unit)}</span></div>
        <div class="flex justify-between"><span>Min:</span><span>${fmtVal(m.min, targetCh.unit)}</span></div>
        <div class="flex justify-between"><span>Average:</span><span>${fmtVal(m.average, targetCh.unit)}</span></div>
        <div class="flex justify-between"><span>Freq:</span><span class="text-cyan-400 font-bold">${fmtVal(m.frequency, 'Hz')}</span></div>
        <div class="flex justify-between"><span>Period:</span><span>${fmtVal(m.period, 's')}</span></div>
        <div class="flex justify-between"><span>Duty:</span><span>${m.dutyCycle !== null ? m.dutyCycle.toFixed(1) + '%' : 'N/A'}</span></div>
        <div class="flex justify-between"><span>RiseTime:</span><span>${fmtVal(m.riseTime, 's')}</span></div>
        <div class="flex justify-between"><span>FallTime:</span><span>${fmtVal(m.fallTime, 's')}</span></div>
      </div>
      ${m.statusMessage ? `<div class="text-[10px] text-amber-400 mt-2">${m.statusMessage}</div>` : ''}
    `;

    // The gate selector is static markup (rebuilding it while open repaints its popup white)
    const gateSel = document.getElementById('measGateSelect') as HTMLSelectElement | null;
    if (gateSel) {
      if (gateSel.value !== tab.measurementGate) gateSel.value = tab.measurementGate;
      gateSel.onchange = (e: any) => {
        tab.measurementGate = e.target.value as MeasurementGate;
        this.renderSidebar();
      };
    }
  }

  private updateStatusBar(): void {
    const tab = this.getActiveTab();
    const statusEl = document.getElementById('statusBarContent');
    if (!statusEl) return;

    if (!tab) {
      statusEl.innerText = 'Ready';
      return;
    }

    const primaryCh = getTimeBaseChannel(tab);
    const fsStr = primaryCh?.fs ? formatEng(primaryCh.fs, 'S/s', 2) : 'N/A';
    const pts = primaryCh?.v.length || 0;
    const mode = tab.plotMode.toUpperCase();

    let cursorText = '';
    if (tab.cursors.enabled) {
      const cType = tab.cursors.type || 'x';
      const parts: string[] = [];

      if ((cType === 'x' || cType === 'xy') && tab.cursors.x1 !== null && tab.cursors.x2 !== null) {
        const dt = Math.abs(tab.cursors.x2 - tab.cursors.x1);
        const freq = dt > 0 ? formatEng(1 / dt, 'Hz', 2) : '∞';
        parts.push(`ΔT: ${formatEng(dt, 's', 3)} (${freq})`);
      }

      if ((cType === 'y' || cType === 'xy') && tab.cursors.y1 !== null && tab.cursors.y2 !== null) {
        const targetCh = getCursorChannel(tab) || primaryCh;
        if (targetCh) {
          const dv = Math.abs(tab.cursors.y2 - tab.cursors.y1);
          parts.push(`ΔV [${targetCh.name}]: ${formatEng(dv, targetCh.unit, 3)}`);
        }
      }

      if (parts.length > 0) {
        cursorText = ' | ' + parts.join(' • ');
      }
    }

    const filtered = getVisibleChannels(tab).filter((c) => c.filter);
    const filterText = filtered.length
      ? `<span class="text-cyan-300">• ${filtered.length === 1 ? filtered[0].name + ': ' + describeFilter(filtered[0].filter!) : filtered.length + ' channels low-pass filtered'}</span>`
      : '';
    statusEl.innerHTML = `
      <span>[${mode}]</span>
      <span>${tab.fileName}</span>
      <span>• ${pts.toLocaleString()} pts</span>
      <span>• Fs: ${fsStr}</span>
      ${filterText}
      <span class="text-cyan-300 font-mono">${cursorText}</span>
      ${this.statusFlash ? `<span class="text-amber-300">• ${this.statusFlash}</span>` : ''}
    `;
  }

  private updateHoverInfo(time: number, voltage: number, ch?: WaveformChannel): void {
    const el = document.getElementById('hoverInfoReadout');
    if (el) {
      const name = ch && getVisibleChannels(this.getActiveTab() as TabState).length > 1 ? `${ch.name}: ` : '';
      el.innerText = `T = ${formatEng(time, 's', 4)}, ${name}V = ${formatEng(voltage, ch?.unit || 'V', 3)}`;
    }
  }

  // --- Export Operations ---
  public exportPNG(): void {
    const link = document.createElement('a');
    link.download = `waveform_${Date.now()}.png`;
    link.href = this.canvas.toDataURL('image/png');
    link.click();
  }

  public exportWaveformCSV(): void {
    const tab = this.getActiveTab();
    if (!tab) return;

    const visibleChs = tab.drawOrder
      .map((id) => tab.channels[id])
      .filter((c) => c && c.visible);

    if (visibleChs.length === 0) return;

    const baseCh = visibleChs[0];
    const n = baseCh.v.length;

    let csv = 'Time(s),' + visibleChs.map((c) => `"${c.name} (${c.unit})"`).join(',') + '\n';
    for (let i = 0; i < n; i++) {
      const row = [baseCh.t[i].toExponential(6)];
      for (const ch of visibleChs) {
        row.push(ch.v[i]?.toFixed(5) || '0');
      }
      csv += row.join(',') + '\n';
    }

    const blob = new Blob([csv], { type: 'text/csv' });
    const link = document.createElement('a');
    link.download = `${tab.fileName}_waveform.csv`;
    link.href = URL.createObjectURL(blob);
    link.click();
  }

  public exportSpectrumCSV(): void {
    if (!this.cachedSpectrum) {
      alert('No active FFT spectrum computed. Switch to Spectrum mode first.');
      return;
    }

    const s = this.cachedSpectrum;
    let csv = 'Frequency(Hz),Magnitude(V),Magnitude(dB)\n';
    for (let i = 0; i < s.frequencies.length; i++) {
      csv += `${s.frequencies[i].toFixed(2)},${s.magnitudes[i].toExponential(5)},${s.dbValues[i].toFixed(2)}\n`;
    }

    const blob = new Blob([csv], { type: 'text/csv' });
    const link = document.createElement('a');
    link.download = `${s.sourceChannelName}_spectrum.csv`;
    link.href = URL.createObjectURL(blob);
    link.click();
  }

  public saveSessionFile(): void {
    const json = serializeSession(this.tabs, this.activeTabIndex);
    const blob = new Blob([json], { type: 'application/json' });
    const link = document.createElement('a');
    link.download = `waveform_session_${Date.now()}.graphx`;
    link.href = URL.createObjectURL(blob);
    link.click();
  }
}
