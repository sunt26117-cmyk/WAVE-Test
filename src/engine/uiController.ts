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
  drawAxisLabels,
  formatEng,
} from './canvasRenderer';
import { computeFFT, computeBLDCHarmonics } from '../modules/fft';
import { computeMeasurements } from '../modules/measurements';
import { performAutoSet } from '../modules/autoSet';
import { findTriggerPoint, alignViewToTrigger } from '../modules/trigger';
import { evaluateMathExpression } from '../modules/mathParser';
import { computeClarke, computePark } from '../modules/transforms';
import { serializeSession, deserializeSession } from './session';
import { previewCsv, parseFullCsv } from '../parsers/csvParser';
import { parseWfmBuffer } from '../parsers/wfmParser';
import { runAllTests } from '../tests/testSuite';

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
  private draggingCursor: 'x1' | 'x2' | null = null;

  // Cached FFT result for current tab
  private cachedSpectrum: SpectrumResult | null = null;
  private cachedSpectrumKey: string = '';

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
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.width / dpr;
    const height = this.canvas.height / dpr;

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
    const visibleChs = tab.drawOrder
      .map((id) => tab.channels[id])
      .filter((c) => c && c.visible);

    if (tab.separateView && visibleChs.length > 1) {
      // Separate diagram subplots
      const totalH = p.height;
      const gap = 10;
      const subH = (totalH - (visibleChs.length - 1) * gap) / visibleChs.length;

      visibleChs.forEach((ch, idx) => {
        const subP: PlotArea = {
          x: p.x,
          y: p.y + idx * (subH + gap),
          width: p.width,
          height: subH,
        };
        drawGrid(this.ctx, subP, this.theme, 10, 4);
        drawChannelWaveform(this.ctx, tab, ch, p, subP);
      });
    } else {
      // Overlapped diagram
      for (const id of tab.drawOrder) {
        const ch = tab.channels[id];
        if (ch && ch.visible) {
          drawChannelWaveform(this.ctx, tab, ch, p);
        }
      }
    }

    // Trigger Line
    drawTriggerLine(this.ctx, tab, p, this.theme);
  }

  private renderFrequencyDomain(tab: TabState, p: PlotArea): void {
    const targetId = tab.selectedFftChannelId || tab.drawOrder[0];
    const primaryCh = tab.channels[targetId] || tab.channels[tab.drawOrder[0]];
    if (!primaryCh || primaryCh.v.length === 0) return;

    // Cache key to avoid redundant FFT calculation
    const key = `${primaryCh.id}_${tab.view.startIndex}_${tab.view.endIndex}_${tab.fftOptions.window}_${tab.fftOptions.scale}_${tab.fftOptions.zeroPadding}_${tab.fftOptions.removeDC}_${tab.fftOptions.range}`;

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
            const ch = tab.channels[tab.drawOrder[0]];
            if (ch) {
              const span = (tab.view.endIndex - tab.view.startIndex) * (ch.dt || 1e-4);
              const start = tab.view.startIndex * (ch.dt || 1e-4);
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

    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;

    this.ctx.resetTransform();
    this.ctx.scale(dpr, dpr);
    this.draw();
  }

  private handleMouseDown(e: MouseEvent): void {
    const tab = this.getActiveTab();
    if (!tab) return;

    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const p = getPlotArea(rect.width, rect.height);

    if (x < p.x || x > p.x + p.width || y < p.y || y > p.y + p.height) return;

    // Check if clicking near cursor X1 or X2
    if (tab.cursors.enabled) {
      const primaryCh = tab.channels[tab.drawOrder[0]];
      const dt = primaryCh?.dt || 1e-4;
      const tStart = tab.view.startIndex * dt;
      const tSpan = (tab.view.endIndex - tab.view.startIndex) * dt;

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

    // Dragging Cursors
    if (this.draggingCursor) {
      const primaryCh = tab.channels[tab.drawOrder[0]];
      const dt = primaryCh?.dt || 1e-4;
      const tStart = tab.view.startIndex * dt;
      const tSpan = (tab.view.endIndex - tab.view.startIndex) * dt;
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

      const primaryCh = tab.channels[tab.drawOrder[0]];
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
      const primaryCh = tab.channels[tab.drawOrder[0]];
      if (primaryCh) {
        const dataPt = screenToData({ x, y }, tab, primaryCh.id, p);
        this.updateHoverInfo(dataPt.time, dataPt.voltage);
      }
    }
  }

  private handleMouseUp(): void {
    const tab = this.getActiveTab();
    if (this.draggingCursor) {
      this.draggingCursor = null;
    }

    if (this.isAreaZooming && this.areaZoomStart && this.areaZoomEnd && tab) {
      const p = getPlotArea(this.canvas.width / (window.devicePixelRatio || 1), this.canvas.height / (window.devicePixelRatio || 1));
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
    if (x < p.x || x > p.x + p.width) return;

    const zoomFactor = e.deltaY < 0 ? 0.8 : 1.25;
    const viewSpan = tab.view.endIndex - tab.view.startIndex;
    const mouseFrac = (x - p.x) / p.width;
    const mouseIdx = tab.view.startIndex + mouseFrac * viewSpan;

    const newSpan = Math.max(10, Math.round(viewSpan * zoomFactor));
    const primaryCh = tab.channels[tab.drawOrder[0]];
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

    const primaryCh = tab.channels[tab.drawOrder[0]];
    if (!primaryCh) return;

    tab.view.startIndex = 0;
    tab.view.endIndex = primaryCh.v.length;

    // Also auto-fit vertical ranges for all visible channels
    for (const id of tab.drawOrder) {
      const ch = tab.channels[id];
      if (ch && ch.visible) {
        let min = Infinity;
        let max = -Infinity;
        for (let i = 0; i < ch.v.length; i++) {
          const val = ch.v[i];
          if (!isNaN(val)) {
            if (val < min) min = val;
            if (val > max) max = val;
          }
        }
        if (isFinite(min) && isFinite(max)) {
          const margin = (max - min) * 0.1 || 1.0;
          ch.vMin = min - margin;
          ch.vMax = max + margin;
        }
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
            p.timeColIndex = colIdx;
            this.renderCsvModalContent();
          } else {
            p.columnMappings[colIdx].role = role;
          }
        });
      });
    }

    const timeUnitSel = document.getElementById('csvTimeUnitSelect') as HTMLSelectElement;
    if (timeUnitSel) timeUnitSel.value = p.timeUnit;

    const rowCountEl = document.getElementById('csvTotalRows');
    if (rowCountEl) rowCountEl.innerText = `${p.totalRows.toLocaleString()} rows`;

    const delimEl = document.getElementById('csvDelimiter');
    if (delimEl) delimEl.innerText = p.delimiter === '\t' ? 'Tab (\\t)' : `"${p.delimiter}"`;
  }

  public confirmCsvImport(resample: boolean): void {
    if (!this.pendingCsvPreview || !this.pendingCsvText) return;

    try {
      const timeUnitSel = document.getElementById('csvTimeUnitSelect') as HTMLSelectElement;
      const timeUnit = (timeUnitSel?.value as 's' | 'ms' | 'us' | 'ns') || this.pendingCsvPreview.timeUnit;

      const parsed = parseFullCsv(this.pendingCsvText, {
        delimiter: this.pendingCsvPreview.delimiter,
        hasHeader: true,
        timeColIndex: this.pendingCsvPreview.timeColIndex,
        timeUnit,
        columnMappings: this.pendingCsvPreview.columnMappings,
        resample,
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

  public applyTrigger(): void {
    const tab = this.getActiveTab();
    if (!tab || !tab.triggerConfig.enabled) return;

    const ch = tab.channels[tab.triggerConfig.channelId];
    if (!ch) return;

    const pt = findTriggerPoint(ch, tab.triggerConfig);
    if (pt) {
      tab.view = alignViewToTrigger(tab.view, ch, pt.triggerIndex, tab.triggerConfig.positionPercent);
      this.draw();
    } else {
      alert(`Trigger condition not found in channel "${ch.name}".`);
    }
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

    if (inputChannelsListEl) {
      inputChannelsListEl.innerHTML = '';
      if (inputChannelIds.length === 0) {
        inputChannelsListEl.innerHTML = '<div class="text-xs text-neutral-500">No channels available</div>';
      } else {
        inputChannelIds.forEach((id) => {
          const ch = tab.channels[id];
          if (!ch) return;

          const row = document.createElement('div');
          row.className = 'channel-item flex items-center justify-between p-2 rounded bg-neutral-800/80 hover:bg-neutral-800 mb-1 text-xs border-l-4';
          row.style.borderLeftColor = ch.color;

          row.innerHTML = `
            <div class="flex items-center gap-2 overflow-hidden">
              <input type="checkbox" class="ch-vis-chk cursor-pointer" ${ch.visible ? 'checked' : ''} />
              <input type="color" class="ch-col-picker w-4 h-4 rounded cursor-pointer border-none bg-transparent" value="${ch.color}" />
              <span class="font-medium truncate text-neutral-200 max-w-[110px]" title="${ch.name}">${ch.name}</span>
            </div>
            <div class="flex items-center gap-1 font-mono text-[11px] text-neutral-400">
              <span>[${ch.vMin.toFixed(1)}, ${ch.vMax.toFixed(1)}] ${ch.unit}</span>
              <button class="ch-fit-btn px-1 py-0.5 bg-neutral-700 hover:bg-neutral-600 text-[10px] text-neutral-200 rounded" title="Fit scale to this channel">Fit</button>
            </div>
          `;

          row.querySelector('.ch-vis-chk')?.addEventListener('change', (e: any) => {
            ch.visible = e.target.checked;
            this.draw();
          });

          row.querySelector('.ch-col-picker')?.addEventListener('input', (e: any) => {
            ch.color = e.target.value;
            row.style.borderLeftColor = ch.color;
            this.draw();
          });

          row.querySelector('.ch-fit-btn')?.addEventListener('click', () => {
            let min = Infinity, max = -Infinity;
            for (let i = 0; i < ch.v.length; i++) {
              const val = ch.v[i];
              if (!isNaN(val)) {
                if (val < min) min = val;
                if (val > max) max = val;
              }
            }
            if (isFinite(min) && isFinite(max)) {
              const margin = (max - min) * 0.1 || 1.0;
              ch.vMin = min - margin;
              ch.vMax = max + margin;
              this.renderSidebar();
              this.draw();
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

          const row = document.createElement('div');
          row.className = 'channel-item flex flex-col p-2 rounded bg-purple-950/40 border border-purple-800/40 hover:bg-purple-950/60 mb-1 text-xs border-l-4';
          row.style.borderLeftColor = ch.color;

          row.innerHTML = `
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-1.5 overflow-hidden">
                <input type="checkbox" class="ch-vis-chk cursor-pointer" ${ch.visible ? 'checked' : ''} />
                <input type="color" class="ch-col-picker w-3.5 h-3.5 rounded cursor-pointer border-none bg-transparent" value="${ch.color}" />
                <span class="font-medium text-purple-200 truncate max-w-[105px]" title="${ch.name}">${ch.name}</span>
              </div>
              <div class="flex items-center gap-1 font-mono text-[10px]">
                <button class="ch-fit-btn px-1.5 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded" title="Auto-scale this channel">Fit</button>
                <button class="ch-fft-btn px-1.5 py-0.5 bg-purple-900/70 hover:bg-purple-800 text-purple-200 rounded font-semibold transition" title="Analyze this Math channel with FFT">FFT</button>
                <button class="ch-del-btn text-red-400 hover:text-red-300 px-1 py-0.5" title="Delete math channel">✕</button>
              </div>
            </div>
            <div class="flex justify-between items-center text-[10px] text-neutral-400 mt-1 font-mono">
              <span class="truncate max-w-[150px] text-purple-300/90 font-mono" title="${ch.mathExpression || ''}">${ch.mathExpression || 'Math'}</span>
              <span>[${ch.vMin.toFixed(1)}, ${ch.vMax.toFixed(1)}] ${ch.unit}</span>
            </div>
          `;

          row.querySelector('.ch-vis-chk')?.addEventListener('change', (e: any) => {
            ch.visible = e.target.checked;
            this.draw();
          });

          row.querySelector('.ch-col-picker')?.addEventListener('input', (e: any) => {
            ch.color = e.target.value;
            row.style.borderLeftColor = ch.color;
            this.draw();
          });

          row.querySelector('.ch-fft-btn')?.addEventListener('click', () => {
            this.analyzeChannelWithFFT(id);
          });

          row.querySelector('.ch-fit-btn')?.addEventListener('click', () => {
            let min = Infinity, max = -Infinity;
            for (let i = 0; i < ch.v.length; i++) {
              const val = ch.v[i];
              if (!isNaN(val)) {
                if (val < min) min = val;
                if (val > max) max = val;
              }
            }
            if (isFinite(min) && isFinite(max)) {
              const margin = (max - min) * 0.1 || 1.0;
              ch.vMin = min - margin;
              ch.vMax = max + margin;
              this.renderSidebar();
              this.draw();
            }
          });

          row.querySelector('.ch-del-btn')?.addEventListener('click', () => {
            delete tab.channels[id];
            tab.drawOrder = tab.drawOrder.filter((chId) => chId !== id);
            if (tab.selectedMeasurementChannelId === id) {
              tab.selectedMeasurementChannelId = tab.drawOrder[0];
            }
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

    // Populate Channel Selectors for Measurements and FFT
    const measChannelSel = document.getElementById('measChannelSelect') as HTMLSelectElement;
    if (measChannelSel) {
      const selectedMeasId = tab.selectedMeasurementChannelId || tab.drawOrder[0];
      measChannelSel.innerHTML = '';
      tab.drawOrder.forEach((id) => {
        const ch = tab.channels[id];
        if (ch) {
          const opt = document.createElement('option');
          opt.value = id;
          opt.innerText = ch.isMath ? `[Math] ${ch.name}` : ch.name;
          if (id === selectedMeasId) opt.selected = true;
          measChannelSel.appendChild(opt);
        }
      });
      measChannelSel.onchange = (e: any) => {
        tab.selectedMeasurementChannelId = e.target.value;
        this.renderLiveMeasurements(tab);
        this.draw();
      };
    }

    const fftChannelSel = document.getElementById('fftChannelSelect') as HTMLSelectElement;
    if (fftChannelSel) {
      const selectedFftId = tab.selectedFftChannelId || tab.drawOrder[0];
      fftChannelSel.innerHTML = '';
      tab.drawOrder.forEach((id) => {
        const ch = tab.channels[id];
        if (ch) {
          const opt = document.createElement('option');
          opt.value = id;
          opt.innerText = ch.isMath ? `[Math] ${ch.name} (${ch.mathExpression || ''})` : ch.name;
          if (id === selectedFftId) opt.selected = true;
          fftChannelSel.appendChild(opt);
        }
      });
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
  }

  private renderLiveMeasurements(tab: TabState): void {
    const measContainer = document.getElementById('measurementsPanel');
    if (!measContainer) return;

    const targetId = tab.selectedMeasurementChannelId || tab.drawOrder[0];
    const targetCh = tab.channels[targetId] || tab.channels[tab.drawOrder[0]];
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
        <select id="measGateSelect" class="text-[11px] bg-neutral-900 border border-neutral-700 rounded px-1 text-white">
          <option value="view" ${tab.measurementGate === 'view' ? 'selected' : ''}>View Window</option>
          <option value="cursors" ${tab.measurementGate === 'cursors' ? 'selected' : ''}>Cursors X1~X2</option>
          <option value="entire" ${tab.measurementGate === 'entire' ? 'selected' : ''}>Entire Data</option>
        </select>
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

    document.getElementById('measGateSelect')?.addEventListener('change', (e: any) => {
      tab.measurementGate = e.target.value as MeasurementGate;
      this.renderSidebar();
    });
  }

  private updateStatusBar(): void {
    const tab = this.getActiveTab();
    const statusEl = document.getElementById('statusBarContent');
    if (!statusEl) return;

    if (!tab) {
      statusEl.innerText = 'Ready';
      return;
    }

    const primaryCh = tab.channels[tab.drawOrder[0]];
    const fsStr = primaryCh?.fs ? formatEng(primaryCh.fs, 'S/s', 2) : 'N/A';
    const pts = primaryCh?.v.length || 0;
    const mode = tab.plotMode.toUpperCase();

    let cursorText = '';
    if (tab.cursors.enabled && tab.cursors.x1 !== null && tab.cursors.x2 !== null) {
      const dt = Math.abs(tab.cursors.x2 - tab.cursors.x1);
      const freq = dt > 0 ? formatEng(1 / dt, 'Hz', 2) : '∞';
      cursorText = ` | ΔT: ${formatEng(dt, 's', 3)} (Freq: ${freq})`;
    }

    statusEl.innerHTML = `
      <span>[${mode}]</span>
      <span>${tab.fileName}</span>
      <span>• ${pts.toLocaleString()} pts</span>
      <span>• Fs: ${fsStr}</span>
      <span class="text-cyan-300 font-mono">${cursorText}</span>
    `;
  }

  private updateHoverInfo(time: number, voltage: number): void {
    const el = document.getElementById('hoverInfoReadout');
    if (el) {
      el.innerText = `T = ${formatEng(time, 's', 4)}, V = ${formatEng(voltage, 'V', 3)}`;
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
