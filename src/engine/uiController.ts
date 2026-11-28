/**
 * Waveform Viewer Pro - Oscilloscope UI Controller & Workspace Orchestrator
 * Manages multi-tab datasets, hardware-style vertical/horizontal/trigger/cursor controls,
 * interactive canvas dragging (pan, box zoom, X/Y cursors, GND handles, Trigger level),
 * CSV quality audit, clipboard paste, FFT spectrum, Math & Clarke channels, annotations, and exports.
 */

import {
  TabState,
  WaveformChannel,
  SpectrumResult,
  MeasurementGate,
  MeasurementMetricKey,
  CustomMeasurementDefinition,
  CsvPreviewInfo,
  CursorMode,
  ActiveTool,
  RenderMode,
  DecimationMode,
  ChannelMeasurements,
  PlotMode,
  AnomalyEvent,
  ChannelCoupling,
  AnnotationItem,
  ThemeId,
} from '../types/models';
import {
  PlotArea,
  RenderTheme,
  DEFAULT_THEME,
  isComputedChannel,
  getPlotArea,
  getDynamicPlotArea,
  getTimeBoundsForView,
  resolveCursorMode,
  getChannelPlotArea,
  screenToData,
  sampleChannelValueAtTime,
  drawGrid,
  drawChannelWaveform,
  drawSpectrum,
  drawTriggerLine,
  drawCursors,
  drawGndMarkers,
  drawAnnotations,
  drawAxisLabels,
  drawOverlapTraceLegend,
  drawCompareGroupLegend,
  drawXYPlot,
  drawGoldenToleranceBand,
  drawActiveAnomalyMarkers,
  getGndHandlePositions,
  getTriggerHandlePosition,
  generateWaveformSVG,
  formatEng,
  formatMeasurementMetricValue,
  formatMetricScalarValue,
  formatCustomMeasurementValue,
} from './canvasRenderer';
import {
  ThemePreset,
  THEME_PRESETS,
  applyThemeToDocument,
  getComputedPaletteColor,
  getRawPaletteColor,
  resolveChannelTextColor,
} from '../modules/themeManager';
import {
  STANDARD_125_VALUES,
  stepScale125,
  ensureChannelScaleOffset,
  syncChannelBoundsFromScaleOffset,
  fitChannelTo125,
  getTimebaseInfo,
  getTabGlobalIndexBounds,
  extendTabViewToLongestChannel,
  stepTimebase125,
  panHorizontalDivs,
  getSubplotRects,
  syncSameUnitChannelsScale,
} from '../modules/oscilloscopeScale';
import { computeFFT, computeBLDCHarmonics } from '../modules/fft';
import {
  computeMeasurements,
  evaluateCustomMeasurement,
  evaluateCustomMeasurementDetailed,
  CustomMeasurementDetailedResult,
  MEASUREMENT_DEFINITIONS,
} from '../modules/measurements';
import { clampCursorsToViewport, centerCursorsInViewport } from '../modules/cursorEngine';
import {
  applyGlobalEdit,
  applyLocalEdit,
  ensureReferenceLocked,
  revertChannelToReference,
  applyChannelTimeShift,
  resetChannelTimeShift,
  GlobalEditOp,
  LocalEditOp,
} from '../modules/waveformEditor';
import {
  FilterConfig,
  FilterExecutionResult,
  applyWaveformFilter,
  validateFilterConfig,
} from '../modules/filter';
import {
  captureCompositeScopePNG,
  exportCroppedWaveformCSV,
  exportCroppedWaveformJSON,
} from '../modules/exporter';
import { buildEngineeringReportHTML, downloadEngineeringReportHTML } from '../modules/reportExporter';
import { performAutoSet } from '../modules/autoSet';
import { findTriggerPoint, alignViewToTrigger } from '../modules/trigger';
import { evaluateMathExpression } from '../modules/mathParser';
import { computeClarke, computePark, computeParkFromChannels, computeInstantaneousPower } from '../modules/transforms';
import { estimateElectricalAngleFromAlphaBeta, computePowerSummary } from '../modules/motorAnalysis';
import { alignChannelsToCommonTimebase, resolveCompatibleSiGroupScale } from '../modules/timeSync';
import { parseSiUnitScale } from '../modules/thermalEngine';
import {
  scanChannelAnomalies,
  evaluateGoldenTolerance,
  AnomalyScanOptions,
  GoldenEvaluationResult,
} from '../modules/anomalyScanner';
import { computeXYAlignedTrajectory, computeXYMetrics } from '../modules/xyAnalysis';
import { serializeSession, deserializeSession } from './session';
import { previewCsv, parseFullCsv, computeCsvPreviewQuality } from '../parsers/csvParser';
import { parseWfmBuffer } from '../parsers/wfmParser';
import {
  parseLtspiceRawBuffer,
  isLtspiceExportText,
  isLtspiceSteppedExportText,
  parseLtspiceText,
} from '../parsers/ltspiceParser';
import { computeBufferFingerprint, computeTextFingerprint } from '../modules/waveformCompare';
import { closeActiveToolDrawerItem } from '../modules/toolDrawer';
import { analyzeSamplingQuality } from '../modules/qualityCheck';
import {
  isExcelFileName,
  openExcelWorkbookSession,
  parseExcelSheetToChannels,
  releaseExcelWorkbookSession,
} from '../parsers/excelParser';
import { excelImportModal, ExcelImportedSheetPayload } from '../modules/excelImportModal';
import {
  mergeExcelChannelsByTime,
  resolveExcelMergedViewport,
  type ExcelMergeTimeMode,
  type ExcelMergeSource,
} from '../modules/excelTimeAlignment';
import { escapeHtml, escapeCsvCell } from '../utils/html';

type DragMode =
  | null
  | {
      type: 'pan';
      startX: number;
      startY: number;
      initialStartIdx: number;
      initialEndIdx: number;
      initialFMin: number;
      initialFMax: number;
      targetChannelId?: string;
      initialVOffset?: number;
      voltsPerDiv?: number;
      area?: PlotArea;
      undoPushed?: boolean;
    }
  | {
      type: 'yAxisOffset';
      channelId: string;
      startY: number;
      initialVOffset: number;
      voltsPerDiv: number;
      area: PlotArea;
      undoPushed?: boolean;
    }
  | {
      type: 'timeShift';
      channelId: string;
      startX: number;
      initialTimeShiftSec: number;
      tSpan: number;
      undoPushed?: boolean;
    }
  | { type: 'cursorX'; which: 'x1' | 'x2' }
  | { type: 'cursorY'; which: 'y1' | 'y2'; channelId: string; area: PlotArea }
  | { type: 'gnd'; channelId: string; area: PlotArea; startY: number; undoPushed?: boolean }
  | { type: 'trigger'; channelId: string; area: PlotArea }
  | {
      type: 'areaZoom';
      start: { x: number; y: number };
      end: { x: number; y: number };
      isRightButton?: boolean;
      clientX?: number;
      clientY?: number;
    }
  | { type: 'areaAnnotate'; channelId: string; area: PlotArea; start: { x: number; y: number }; end: { x: number; y: number } };

export class OscilloscopeApp {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private themeId: ThemeId = 'daylight';
  private theme: RenderTheme = THEME_PRESETS.daylight.canvas;

  private tabs: TabState[] = [];
  private activeTabIndex: number = -1;

  private dragState: DragMode = null;

  // Cached FFT result
  private cachedSpectrum: SpectrumResult | null = null;
  private cachedSpectrumKey: string = '';

  // Cached measurements by channel key for fast 60fps strip updates
  private measCache: Record<string, { key: string; value: ChannelMeasurements }> = {};
  private customMeasCache: Record<string, { key: string; values: Record<string, CustomMeasurementDetailedResult> }> = {};
  private pendingDrawRaf: number | null = null;
  private editVersion: number = 0;
  private lastHudSyncAt: number = 0;
  private hudSettleTimer: number | null = null;
  private readonly hudThrottleMs: number = 100;
  private readonly hudSettleDelayMs: number = 120;

  // CSV / TXT multi-file import modal queue state
  private pendingCsvQueue: Array<{ fileName: string; text: string; preview: CsvPreviewInfo }> = [];
  private pendingCsvActiveIndex: number = 0;
  private pendingCsvDisposition: 'separate' | 'merge' | 'append' = 'separate';
  private pendingCsvTimeAlignment: ExcelMergeTimeMode = 'auto-best';

  // Per-tab anti-jitter dynamic Y-axis margin cache
  private tabLeftMarginCache: Map<string, { margin: number; layoutKey: string }> = new Map();

  // Pending text annotation coordinate
  private pendingAnnotationCoord: { time: number; voltage: number; channelId: string } | null = null;
  private toastTimer: number | null = null;
  private contextMenuPoint: { x: number; y: number } | null = null;
  private soloPrevVisibility: Record<string, boolean> | null = null;
  private soloChannelId: string | null = null;

  // Hook for opening/editing a Compare Group from softkey pill or sidebar
  public onEditCompareGroup?: (groupId: string) => void;

  // Undo / Redo History
  private undoStack: Array<{
    tabId: string;
    label: string;
    view: { startIndex: number; endIndex: number; fMin?: number; fMax?: number };
    separateView: boolean;
    plotMode: PlotMode;
    activeChannelId?: string;
    drawOrder: string[];
    annotations: AnnotationItem[];
    channelStates: Record<
      string,
      {
        visible: boolean;
        color: string;
        voltsPerDiv?: number;
        vOffset?: number;
        vMin: number;
        vMax: number;
        inverted?: boolean;
        coupling?: ChannelCoupling;
        hasEdits?: boolean;
        showRef?: boolean;
        showDiff?: boolean;
        v?: Float32Array;
        refV?: Float32Array;
        t?: Float64Array;
        timeShiftSec?: number;
        timeShiftBaseT?: Float64Array;
      }
    >;
  }> = [];
  private redoStack: typeof this.undoStack = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D canvas context.');
    this.ctx = ctx;

    this.populateScaleDropdown();
    this.initEvents();
    this.handleResize();
  }

  public getThemeId(): ThemeId {
    return this.themeId;
  }

  public getThemePreset(): ThemePreset {
    return THEME_PRESETS[this.themeId] || THEME_PRESETS.obsidian;
  }

  public getRawColors(): string[] {
    return this.getThemePreset().rawPalette;
  }

  public getNextComputedColor(offset: number = 0): string {
    const tab = this.getActiveTab();
    const existingCount = tab
      ? tab.drawOrder.filter((id) => {
          const ch = tab.channels[id];
          return ch && isComputedChannel(ch);
        }).length
      : 0;
    return getComputedPaletteColor(this.themeId, existingCount + offset);
  }

  public setTheme(themeId: ThemeId, remapTraceColors: boolean = true): void {
    const prevPreset = THEME_PRESETS[this.themeId] || THEME_PRESETS.obsidian;
    const preset = applyThemeToDocument(themeId);
    this.themeId = preset.id;
    this.theme = preset.canvas;

    if (remapTraceColors) {
      for (const tab of this.tabs) {
        let rawIdx = 0;
        let compIdx = 0;
        for (const id of tab.drawOrder) {
          const ch = tab.channels[id];
          if (!ch) continue;
          if (ch.compareGroupId && ch.compareRole === 'ref') continue;
          const lowerColor = (ch.color || '').toLowerCase();
          if (isComputedChannel(ch)) {
            if (ch.derivedKind === 'diff' || ch.compareRole === 'diff') {
              ch.color = preset.isLight ? '#e11d48' : '#fb7185';
            } else if (ch.derivedKind === 'ref') {
              ch.color = preset.isLight ? '#475569' : '#94a3b8';
            } else {
              const prevIdx = prevPreset.computedPalette.findIndex((c) => c.toLowerCase() === lowerColor);
              const legacy = ['#ff007f', '#f472b6', '#4ade80', '#38bdf8', '#fb923c', '#a78bfa'];
              if (prevIdx >= 0 || legacy.includes(lowerColor)) {
                ch.color = preset.computedPalette[(prevIdx >= 0 ? prevIdx : compIdx) % preset.computedPalette.length];
              }
            }
            compIdx++;
          } else {
            const prevIdx = prevPreset.rawPalette.findIndex((c) => c.toLowerCase() === lowerColor);
            if (prevIdx >= 0) {
              ch.color = preset.rawPalette[prevIdx % preset.rawPalette.length];
            } else if (!ch.compareGroupId) {
              const defaultMatch = Object.values(THEME_PRESETS).some((tp) =>
                tp.rawPalette.some((c) => c.toLowerCase() === lowerColor)
              );
              if (defaultMatch) {
                ch.color = getRawPaletteColor(preset.id, rawIdx);
              }
            }
            rawIdx++;
          }
        }
      }
    }

    this.lastMeasStripKey = '';
    this.renderTabsBar();
    this.renderSidebar();
    this.draw();
    window.dispatchEvent(new CustomEvent('wvp-theme-changed', { detail: { themeId: preset.id } }));
  }

  public showToast(
    message: string,
    level: 'info' | 'warn' | 'error' | 'success' = 'info',
    options?: { undoable?: boolean }
  ): void {
    const el = document.getElementById('scopeToast');
    if (!el) return;
    const msgEl = document.getElementById('scopeToastMsg');
    const undoBtn = document.getElementById('scopeToastUndoBtn');
    if (msgEl) {
      msgEl.innerText = message;
    } else {
      el.innerText = message;
    }
    el.classList.remove(
      'hidden',
      'wvp-alert-info',
      'wvp-alert-ok',
      'wvp-alert-warn',
      'wvp-alert-danger'
    );
    el.classList.add('bg-elevated');
    if (level === 'error') {
      el.classList.add('wvp-alert-danger');
    } else if (level === 'warn') {
      el.classList.add('wvp-alert-warn');
    } else if (level === 'success') {
      el.classList.add('wvp-alert-ok');
    } else {
      el.classList.add('wvp-alert-info');
    }
    const showUndo = Boolean(options?.undoable && this.undoStack.length > 0);
    if (undoBtn) {
      undoBtn.classList.toggle('hidden', !showUndo);
    }
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      el.classList.add('hidden');
    }, showUndo ? 4500 : 3400);
  }

  private populateScaleDropdown(): void {
    const sel = document.getElementById('vDivSelect') as HTMLSelectElement;
    if (!sel) return;
    sel.innerHTML = '';
    STANDARD_125_VALUES.forEach((val) => {
      const opt = document.createElement('option');
      opt.value = val.toString();
      opt.text = `${formatEng(val, '', 0)}/div`;
      sel.appendChild(opt);
    });
  }

  public getActiveTab(): TabState | null {
    if (this.activeTabIndex >= 0 && this.activeTabIndex < this.tabs.length) {
      return this.tabs[this.activeTabIndex];
    }
    return null;
  }

  private ensureTabDefaults(tab: TabState): void {
    for (const id of tab.drawOrder) {
      const ch = tab.channels[id];
      if (ch) {
        if (!ch.coupling) ch.coupling = 'DC';
        if (ch.inverted === undefined) ch.inverted = false;
        if (ch.showRef === undefined) ch.showRef = true;
        ensureChannelScaleOffset(ch);
        syncChannelBoundsFromScaleOffset(ch);
      }
    }
    if (!tab.activeChannelId || !tab.channels[tab.activeChannelId]) {
      tab.activeChannelId = tab.drawOrder[0];
    }
    if (!tab.selectedMeasurementChannelId || !tab.channels[tab.selectedMeasurementChannelId]) {
      tab.selectedMeasurementChannelId = tab.activeChannelId;
    }
    if (!tab.selectedFftChannelId || !tab.channels[tab.selectedFftChannelId]) {
      tab.selectedFftChannelId = tab.activeChannelId;
    }
    if (!tab.cursors.trackingChannel || !tab.channels[tab.cursors.trackingChannel]) {
      tab.cursors.trackingChannel = tab.activeChannelId || null;
    }
    if (!tab.cursors.mode) {
      tab.cursors.mode = tab.cursors.enabled ? 'x' : 'off';
    }
    if (!tab.activeTool) {
      tab.activeTool = 'pan';
    }
    if (!tab.renderMode) {
      tab.renderMode = 'vector';
    }
    if (!tab.decimationMode) {
      tab.decimationMode = 'minmax';
    }
    if (!tab.selectedMeasurements) {
      tab.selectedMeasurements = [];
    }
    if (!tab.xyConfig) {
      tab.xyConfig = {
        xChannelId: tab.drawOrder[0] || '',
        yChannelId: tab.drawOrder[1] || tab.drawOrder[0] || '',
        range: 'view',
      };
    } else {
      if (!tab.channels[tab.xyConfig.xChannelId]) tab.xyConfig.xChannelId = tab.drawOrder[0] || '';
      if (!tab.channels[tab.xyConfig.yChannelId]) {
        tab.xyConfig.yChannelId = tab.drawOrder[1] || tab.drawOrder[0] || '';
      }
    }
    if (!tab.goldenBand) {
      tab.goldenBand = {
        enabled: false,
        channelId: tab.drawOrder[0] || '',
        mode: 'percent',
        tolerance: 5,
      };
    }
  }

  private captureTabSnapshot(tab: TabState, label: string, includeData: boolean) {
    const channelStates: (typeof this.undoStack)[number]['channelStates'] = {};
    for (const id of tab.drawOrder) {
      const ch = tab.channels[id];
      if (!ch) continue;
      channelStates[id] = {
        visible: ch.visible,
        color: ch.color,
        voltsPerDiv: ch.voltsPerDiv,
        vOffset: ch.vOffset,
        vMin: ch.vMin,
        vMax: ch.vMax,
        inverted: ch.inverted,
        coupling: ch.coupling,
        hasEdits: ch.hasEdits,
        showRef: ch.showRef,
        showDiff: ch.showDiff,
        v: includeData ? new Float32Array(ch.v) : undefined,
        refV: includeData && ch.refV ? new Float32Array(ch.refV) : undefined,
        t: includeData ? new Float64Array(ch.t) : undefined,
        timeShiftSec: ch.timeShiftSec,
        timeShiftBaseT: includeData && ch.timeShiftBaseT ? new Float64Array(ch.timeShiftBaseT) : undefined,
      };
    }
    return {
      tabId: tab.id,
      label,
      view: { ...tab.view },
      separateView: tab.separateView,
      plotMode: tab.plotMode,
      activeChannelId: tab.activeChannelId,
      drawOrder: [...tab.drawOrder],
      annotations: tab.annotations.map((a) => ({ ...a })),
      channelStates,
    };
  }

  private restoreSnapshot(snap: (typeof this.undoStack)[number]): void {
    const tab = this.tabs.find((t) => t.id === snap.tabId);
    if (!tab) return;
    tab.view = { ...snap.view };
    tab.separateView = snap.separateView;
    tab.plotMode = snap.plotMode;
    tab.activeChannelId = snap.activeChannelId;
    tab.annotations = snap.annotations.map((a) => ({ ...a }));

    for (const [id, st] of Object.entries(snap.channelStates)) {
      const ch = tab.channels[id];
      if (!ch) continue;
      ch.visible = st.visible;
      ch.color = st.color;
      ch.voltsPerDiv = st.voltsPerDiv;
      ch.vOffset = st.vOffset;
      ch.vMin = st.vMin;
      ch.vMax = st.vMax;
      ch.inverted = st.inverted;
      ch.coupling = st.coupling;
      ch.hasEdits = st.hasEdits;
      ch.showRef = st.showRef;
      ch.showDiff = st.showDiff;
      if (st.v) ch.v = new Float32Array(st.v);
      if (st.refV) ch.refV = new Float32Array(st.refV);
      if (st.t) ch.t = new Float64Array(st.t);
      ch.timeShiftSec = st.timeShiftSec;
      ch.timeShiftBaseT = st.timeShiftBaseT ? new Float64Array(st.timeShiftBaseT) : undefined;
    }

    this.editVersion++;
    this.cachedSpectrum = null;
    this.cachedSpectrumKey = '';
    clampCursorsToViewport(tab);
    this.renderSidebar();
    this.draw();
  }

  public pushUndoSnapshot(label: string, includeData: boolean = false): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    this.undoStack.push(this.captureTabSnapshot(tab, label, includeData));
    if (this.undoStack.length > 30) this.undoStack.shift();
    this.redoStack = [];
    this.updateUndoRedoButtons();
  }

  public undo(): void {
    const snap = this.undoStack.pop();
    if (!snap) {
      this.showToast('当前没有可撤销的操作。', 'warn');
      return;
    }
    const tab = this.tabs.find((t) => t.id === snap.tabId);
    if (tab) {
      const hasData = Object.values(snap.channelStates).some((s) => !!s.v);
      this.redoStack.push(this.captureTabSnapshot(tab, snap.label, hasData));
    }
    this.restoreSnapshot(snap);
    this.updateUndoRedoButtons();
    this.showToast(`已撤销：${snap.label}`, 'info');
  }

  public redo(): void {
    const snap = this.redoStack.pop();
    if (!snap) {
      this.showToast('当前没有可重做的操作。', 'warn');
      return;
    }
    const tab = this.tabs.find((t) => t.id === snap.tabId);
    if (tab) {
      const hasData = Object.values(snap.channelStates).some((s) => !!s.v);
      this.undoStack.push(this.captureTabSnapshot(tab, snap.label, hasData));
    }
    this.restoreSnapshot(snap);
    this.updateUndoRedoButtons();
    this.showToast(`已重做：${snap.label}`, 'info');
  }

  private updateUndoRedoButtons(): void {
    const uBtn = document.getElementById('undoBtn') as HTMLButtonElement | null;
    const rBtn = document.getElementById('redoBtn') as HTMLButtonElement | null;
    if (uBtn) uBtn.disabled = this.undoStack.length === 0;
    if (rBtn) rBtn.disabled = this.redoStack.length === 0;
  }

  public addTab(tab: TabState): void {
    this.ensureTabDefaults(tab);
    this.tabs.push(tab);
    this.activeTabIndex = this.tabs.length - 1;
    this.cachedSpectrum = null;
    this.cachedSpectrumKey = '';
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
    this.cachedSpectrum = null;
    this.cachedSpectrumKey = '';
    this.renderTabsBar();
    this.renderSidebar();
    this.draw();
  }

  public setActiveTab(index: number): void {
    if (index >= 0 && index < this.tabs.length) {
      this.activeTabIndex = index;
      this.cachedSpectrum = null;
      this.cachedSpectrumKey = '';
      this.renderTabsBar();
      this.renderSidebar();
      this.draw();
    }
  }

  // --- Oscilloscope Channel & Horizontal Controls ---
  public selectActiveChannel(chId: string): void {
    const tab = this.getActiveTab();
    if (!tab || !tab.channels[chId]) return;
    tab.activeChannelId = chId;
    tab.selectedMeasurementChannelId = chId;
    tab.cursors.trackingChannel = chId;
    this.renderSidebar();
    this.draw();
  }

  public stepChannelScale(chId: string, direction: 1 | -1): void {
    const tab = this.getActiveTab();
    if (!tab || !tab.channels[chId]) return;
    this.pushUndoSnapshot('Scale V/div');
    const ch = tab.channels[chId];
    const { voltsPerDiv } = ensureChannelScaleOffset(ch);
    ch.voltsPerDiv = stepScale125(voltsPerDiv, direction);
    syncChannelBoundsFromScaleOffset(ch);
    clampCursorsToViewport(tab);
    this.renderSidebar();
    this.draw();
  }

  public setChannelScale(chId: string, vPerDiv: number): void {
    const tab = this.getActiveTab();
    if (!tab || !tab.channels[chId] || !isFinite(vPerDiv) || vPerDiv <= 0) return;
    this.pushUndoSnapshot('Set V/div');
    const ch = tab.channels[chId];
    ch.voltsPerDiv = vPerDiv;
    syncChannelBoundsFromScaleOffset(ch);
    clampCursorsToViewport(tab);
    this.renderSidebar();
    this.draw();
  }

  public setChannelOffset(chId: string, offset: number): void {
    const tab = this.getActiveTab();
    if (!tab || !tab.channels[chId] || !isFinite(offset)) return;
    const ch = tab.channels[chId];
    ensureChannelScaleOffset(ch);
    ch.vOffset = offset;
    syncChannelBoundsFromScaleOffset(ch);
    clampCursorsToViewport(tab);
    this.renderSidebar();
    this.draw();
  }

  public nudgeChannelOffsetDivs(chId: string, divs: number): void {
    const tab = this.getActiveTab();
    if (!tab || !tab.channels[chId]) return;
    this.pushUndoSnapshot('Vertical Offset');
    const ch = tab.channels[chId];
    const { voltsPerDiv, vOffset } = ensureChannelScaleOffset(ch);
    ch.vOffset = vOffset + divs * voltsPerDiv;
    syncChannelBoundsFromScaleOffset(ch);
    clampCursorsToViewport(tab);
    this.renderSidebar();
    this.draw();
  }

  public zeroChannelOffset(chId: string): void {
    this.pushUndoSnapshot('归零垂直偏移');
    this.setChannelOffset(chId, 0);
  }

  public fitSingleChannel(chId: string): void {
    const tab = this.getActiveTab();
    if (!tab || !tab.channels[chId]) return;
    this.pushUndoSnapshot('单通道自适应刻度');
    fitChannelTo125(tab.channels[chId]);
    clampCursorsToViewport(tab);
    this.renderSidebar();
    this.draw();
  }

  public syncSameUnitScales(): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    this.pushUndoSnapshot('同步同单位通道刻度');
    const res = syncSameUnitChannelsScale(tab, tab.activeChannelId);
    if (!res) {
      this.undoStack.pop();
      this.updateUndoRedoButtons();
      this.showToast('未找到可同步的可见通道。', 'warn');
      return;
    }
    clampCursorsToViewport(tab);
    this.renderSidebar();
    this.draw();
    this.showToast(
      `已将 ${res.syncedCount} 条 [${res.unit}] 通道统一为 ${formatEng(res.targetVoltsPerDiv, res.unit, 1)}/div（基准：${res.driverChannelName}）`,
      'info',
      { undoable: true }
    );
  }

  public toggleChannelVisible(chId: string): void {
    const tab = this.getActiveTab();
    if (!tab || !tab.channels[chId]) return;
    this.pushUndoSnapshot('切换通道显示');
    tab.channels[chId].visible = !tab.channels[chId].visible;
    this.soloPrevVisibility = null;
    this.soloChannelId = null;
    this.renderSidebar();
    this.draw();
  }

  public toggleSoloChannel(chId: string): void {
    const tab = this.getActiveTab();
    if (!tab || !tab.channels[chId]) return;
    const ch = tab.channels[chId];
    const nonRefIds = tab.drawOrder.filter((id) => tab.channels[id] && tab.channels[id].compareRole !== 'ref');
    if (nonRefIds.length <= 1) {
      this.selectActiveChannel(chId);
      return;
    }
    this.pushUndoSnapshot(`独奏通道 ${ch.name}`);
    if (this.soloChannelId === chId && this.soloPrevVisibility) {
      for (const id of nonRefIds) {
        const target = tab.channels[id];
        if (target && this.soloPrevVisibility[id] !== undefined) {
          target.visible = this.soloPrevVisibility[id];
        }
      }
      this.soloPrevVisibility = null;
      this.soloChannelId = null;
      this.renderSidebar();
      this.draw();
      this.showToast(`已退出独奏，恢复各通道显示状态。`, 'info', { undoable: true });
      return;
    }
    const prev: Record<string, boolean> = {};
    for (const id of nonRefIds) {
      prev[id] = tab.channels[id].visible;
      tab.channels[id].visible = id === chId;
    }
    this.soloPrevVisibility = prev;
    this.soloChannelId = chId;
    tab.activeChannelId = chId;
    tab.selectedMeasurementChannelId = chId;
    tab.cursors.trackingChannel = chId;
    this.renderSidebar();
    this.draw();
    this.showToast(`已独奏通道 ${ch.name}（再次双击恢复）`, 'info', { undoable: true });
  }

  public toggleChannelCoupling(chId: string): void {
    const tab = this.getActiveTab();
    if (!tab || !tab.channels[chId]) return;
    this.pushUndoSnapshot('Toggle AC/DC Coupling');
    const ch = tab.channels[chId];
    ch.coupling = ch.coupling === 'AC' ? 'DC' : 'AC';
    fitChannelTo125(ch);
    clampCursorsToViewport(tab);
    this.renderSidebar();
    this.draw();
  }

  public toggleChannelInvert(chId: string): void {
    const tab = this.getActiveTab();
    if (!tab || !tab.channels[chId]) return;
    this.pushUndoSnapshot('Toggle Invert');
    const ch = tab.channels[chId];
    ch.inverted = !ch.inverted;
    this.renderSidebar();
    this.draw();
  }

  public stepTimebase(direction: 1 | -1): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    tab.view = stepTimebase125(tab, direction);
    clampCursorsToViewport(tab);
    this.renderSidebar();
    this.draw();
  }

  public panTimebase(divs: number): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    tab.view = panHorizontalDivs(tab, divs);
    clampCursorsToViewport(tab);
    this.renderSidebar();
    this.draw();
  }

  public setPlotMode(mode: PlotMode): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    tab.plotMode = mode;
    this.renderSidebar();
    this.draw();
  }

  public setSeparateView(separate: boolean): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    this.pushUndoSnapshot('Layout Mode');
    tab.separateView = separate;
    this.renderSidebar();
    this.draw();
  }

  public setRenderMode(mode: RenderMode): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    tab.renderMode = mode;
    this.updateScreenTelemetry();
    this.draw();
  }

  public setDecimationMode(mode: DecimationMode): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    tab.decimationMode = mode;
    this.updateScreenTelemetry();
    this.draw();
  }

  public toggleRightPanel(): void {
    const panel = document.getElementById('rightControlPanel');
    const btn = document.getElementById('togglePanelBtn');
    if (!panel) return;
    const isNowHidden = panel.classList.toggle('hidden');
    if (btn) btn.innerText = isNowHidden ? '展开右侧控制面板' : '收起右侧控制面板';
    try {
      localStorage.setItem('wvp_panel_collapsed_v1', isNowHidden ? '1' : '0');
    } catch {
      // ignore storage error
    }
    this.handleResize();
  }

  public setActiveTool(tool: ActiveTool): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    tab.activeTool = tab.activeTool === tool && tool !== 'pan' ? 'pan' : tool;
    this.renderSidebar();
    this.draw();
  }

  public clearAnnotations(): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    if (tab.annotations.length === 0) {
      this.showToast('当前没有可清除的波形标注。', 'warn');
      return;
    }
    this.pushUndoSnapshot('清除波形标注');
    tab.annotations = [];
    this.draw();
    this.showToast('已清除所有波形标注。', 'info', { undoable: true });
  }

  public setCursorMode(mode: CursorMode): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    tab.cursors.mode = mode;
    tab.cursors.enabled = mode !== 'off';

    const targetId = tab.cursors.trackingChannel || tab.activeChannelId || tab.drawOrder[0];
    const targetCh = tab.channels[targetId] || tab.channels[tab.drawOrder[0]];
    if (targetCh && tab.cursors.enabled) {
      tab.cursors.trackingChannel = targetCh.id;
      const { tStart, tSpan } = getTimeBoundsForView(tab, targetCh);
      if (tab.cursors.x1 === null || tab.cursors.x2 === null) {
        tab.cursors.x1 = tStart + tSpan * 0.25;
        tab.cursors.x2 = tStart + tSpan * 0.75;
      }
      if (tab.cursors.y1 === null || tab.cursors.y2 === null) {
        ensureChannelScaleOffset(targetCh);
        syncChannelBoundsFromScaleOffset(targetCh);
        const vSpan = targetCh.vMax - targetCh.vMin;
        tab.cursors.y1 = targetCh.vMin + vSpan * 0.72;
        tab.cursors.y2 = targetCh.vMin + vSpan * 0.28;
      }
      clampCursorsToViewport(tab);
    }

    this.renderSidebar();
    this.draw();
  }

  public centerCursors(): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    centerCursorsInViewport(tab);
    this.renderSidebar();
    this.draw();
    this.showToast('游标已居中至当前视窗 25% 与 75% 位置。', 'info');
  }

  public setCursorTargetChannel(chId: string): void {
    const tab = this.getActiveTab();
    if (!tab || !tab.channels[chId]) return;
    tab.cursors.trackingChannel = chId;
    const ch = tab.channels[chId];
    ensureChannelScaleOffset(ch);
    syncChannelBoundsFromScaleOffset(ch);
    const vSpan = ch.vMax - ch.vMin;
    tab.cursors.y1 = ch.vMin + vSpan * 0.72;
    tab.cursors.y2 = ch.vMin + vSpan * 0.28;
    clampCursorsToViewport(tab);
    this.renderSidebar();
    this.draw();
  }

  // --- On-Demand Measurements Management ---
  public toggleMeasurementSelection(channelId: string, metric: MeasurementMetricKey | string, enabled?: boolean): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    if (!tab.selectedMeasurements) tab.selectedMeasurements = [];
    const itemId = `${channelId}::${metric}`;
    const existsIdx = tab.selectedMeasurements.findIndex((m) => m.id === itemId);
    const shouldAdd = enabled !== undefined ? enabled : existsIdx === -1;

    if (shouldAdd && existsIdx === -1) {
      tab.selectedMeasurements.push({ id: itemId, channelId, metric });
    } else if (!shouldAdd && existsIdx !== -1) {
      tab.selectedMeasurements.splice(existsIdx, 1);
    }
    this.renderMeasurementStrip(tab);
    this.updateScreenTelemetry();
    this.handleResize();
  }

  public addCustomMeasurement(
    def: Omit<CustomMeasurementDefinition, 'id'>,
    autoEnableChannelId?: string
  ): CustomMeasurementDefinition {
    const tab = this.getActiveTab();
    if (!tab) {
      throw new Error('No active waveform tab.');
    }
    const label = (def.label || '').trim();
    const expression = (def.expression || '').trim();
    if (!label || !expression) {
      throw new Error('Metric label and expression are required.');
    }
    if (!tab.customMeasurements) tab.customMeasurements = [];
    const id = `cm_${Date.now().toString(36)}_${Math.floor(Math.random() * 1000)}`;
    const item: CustomMeasurementDefinition = {
      id,
      label,
      shortLabel: (def.shortLabel || label).trim().slice(0, 12),
      expression,
      unitType: def.unitType || 'signal',
      customUnit: def.customUnit?.trim() || undefined,
    };
    tab.customMeasurements.push(item);
    this.customMeasCache = {};
    if (autoEnableChannelId && tab.channels[autoEnableChannelId]) {
      this.toggleMeasurementSelection(autoEnableChannelId, `custom:${id}`, true);
    } else {
      this.renderMeasurementStrip(tab);
    }
    return item;
  }

  public removeCustomMeasurement(customId: string): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    if (tab.customMeasurements) {
      tab.customMeasurements = tab.customMeasurements.filter((cm) => cm.id !== customId);
    }
    const targetMetric = `custom:${customId}`;
    if (tab.selectedMeasurements) {
      tab.selectedMeasurements = tab.selectedMeasurements.filter((sm) => sm.metric !== targetMetric);
    }
    this.customMeasCache = {};
    this.renderMeasurementStrip(tab);
    this.updateScreenTelemetry();
    this.handleResize();
  }

  public removeMeasurementSelection(itemId: string): void {
    const tab = this.getActiveTab();
    if (!tab || !tab.selectedMeasurements) return;
    tab.selectedMeasurements = tab.selectedMeasurements.filter((m) => m.id !== itemId);
    this.renderMeasurementStrip(tab);
    this.updateScreenTelemetry();
    this.handleResize();
  }

  public selectAllMeasurementsForChannel(channelId: string): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    if (!tab.selectedMeasurements) tab.selectedMeasurements = [];
    for (const def of MEASUREMENT_DEFINITIONS) {
      const id = `${channelId}::${def.key}`;
      if (!tab.selectedMeasurements.some((m) => m.id === id)) {
        tab.selectedMeasurements.push({ id, channelId, metric: def.key });
      }
    }
    for (const customDef of tab.customMeasurements || []) {
      const metricKey = `custom:${customDef.id}`;
      const id = `${channelId}::${metricKey}`;
      if (!tab.selectedMeasurements.some((m) => m.id === id)) {
        tab.selectedMeasurements.push({ id, channelId, metric: metricKey });
      }
    }
    this.renderMeasurementStrip(tab);
    this.updateScreenTelemetry();
    this.handleResize();
  }

  public clearAllMeasurements(): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    tab.selectedMeasurements = [];
    this.renderMeasurementStrip(tab);
    this.updateScreenTelemetry();
    this.handleResize();
  }

  // --- Waveform Editing & Same-Screen Reference (Ref / Diff) ---
  public applyChannelGlobalEdit(channelId: string, op: GlobalEditOp): void {
    const tab = this.getActiveTab();
    const ch = tab?.channels[channelId];
    if (!tab || !ch) return;

    this.pushUndoSnapshot(`Global Edit (${op.type})`, true);
    applyGlobalEdit(ch, op);
    this.editVersion++;
    this.cachedSpectrum = null;
    this.cachedSpectrumKey = '';
    this.renderSidebar();
    this.draw();
    this.showToast(`已对 ${ch.name} 应用 ${op.type}（原始参考波形已锁定）。`, 'info', { undoable: true });
  }

  public applyChannelLocalEdit(channelId: string, op: LocalEditOp): number {
    const tab = this.getActiveTab();
    const ch = tab?.channels[channelId];
    if (!tab || !ch) return 0;

    let tStart: number;
    let tEnd: number;
    if (tab.cursors.enabled && tab.cursors.x1 !== null && tab.cursors.x2 !== null) {
      tStart = Math.min(tab.cursors.x1, tab.cursors.x2);
      tEnd = Math.max(tab.cursors.x1, tab.cursors.x2);
    } else {
      const bounds = getTimeBoundsForView(tab, ch);
      tStart = bounds.tStart;
      tEnd = bounds.tEnd;
    }

    this.pushUndoSnapshot(`局部编辑 (${op.type})`, true);
    const modified = applyLocalEdit(ch, tStart, tEnd, op);
    if (modified > 0) {
      this.editVersion++;
      this.cachedSpectrum = null;
      this.cachedSpectrumKey = '';
      this.renderSidebar();
      this.draw();
      this.showToast(`已修改 ${ch.name} 共 ${modified.toLocaleString()} 个采样点（原始参考波形已锁定）。`, 'info', { undoable: true });
    } else {
      this.undoStack.pop();
      this.updateUndoRedoButtons();
      this.showToast('所选 [X1, X2] 区间内无采样点。', 'warn');
    }
    return modified;
  }

  public revertChannelEdits(channelId: string): void {
    const tab = this.getActiveTab();
    const ch = tab?.channels[channelId];
    if (!tab || !ch) return;
    this.pushUndoSnapshot('还原原始参考波形', true);
    if (revertChannelToReference(ch)) {
      this.editVersion++;
      this.cachedSpectrum = null;
      this.cachedSpectrumKey = '';
      this.renderSidebar();
      this.draw();
      this.showToast(`已将 ${ch.name} 还原为原始参考波形。`, 'info', { undoable: true });
    } else {
      this.undoStack.pop();
      this.updateUndoRedoButtons();
      this.showToast(`${ch.name} 当前无待还原的编辑修改。`, 'warn');
    }
  }

  public applyFilterToChannel(
    sourceChannelId: string,
    config: FilterConfig
  ): { ok: boolean; targetChannelId?: string; result?: FilterExecutionResult; error?: string } {
    const tab = this.getActiveTab();
    const srcCh = tab?.channels[sourceChannelId];
    if (!tab || !srcCh) {
      return { ok: false, error: 'No active waveform channel selected.' };
    }

    const check = validateFilterConfig(config, srcCh.t);
    if (!check.ok) {
      const msg = check.message || 'Invalid filter parameters.';
      this.showToast(msg, 'error');
      return { ok: false, error: msg };
    }

    const viewBounds = getTimeBoundsForView(tab, srcCh);
    // In-place filtering must remain idempotent by recomputing from original refV
    const filterInputV =
      config.outputMode === 'in_place' && srcCh.hasEdits && srcCh.refV && srcCh.refV.length === srcCh.v.length
        ? srcCh.refV
        : srcCh.v;
    const res = applyWaveformFilter(srcCh.t, filterInputV, config, {
      viewStart: viewBounds.tStart,
      viewEnd: viewBounds.tEnd,
      cursorX1: tab.cursors.enabled ? tab.cursors.x1 : null,
      cursorX2: tab.cursors.enabled ? tab.cursors.x2 : null,
    });

    if (res.partialRegionSkipped) {
      const msg = res.warning || 'Selected filter slice has insufficient overlap with the waveform.';
      this.showToast(msg, 'error');
      return { ok: false, error: msg, result: res };
    }

    if (config.outputMode === 'in_place') {
      this.pushUndoSnapshot(`Filter ${srcCh.name} (${res.metrics.badgeText})`, true);
      ensureReferenceLocked(srcCh);
      srcCh.v = new Float32Array(res.v);
      srcCh.hasEdits = true;
      this.editVersion++;
      this.cachedSpectrum = null;
      this.cachedSpectrumKey = '';
      this.renderSidebar();
      this.draw();
      this.showToast(
        `已就地滤波 ${srcCh.name}（${res.metrics.summaryText}，基于原始参考重算）。${res.warning ? `提示：${res.warning}` : ''}`,
        check.warning || res.warning ? 'warn' : 'info',
        { undoable: true }
      );
      return { ok: true, targetChannelId: srcCh.id, result: res };
    }

    this.pushUndoSnapshot(`新建滤波通道 (${res.metrics.badgeText})`, true);
    const filterCount = tab.drawOrder.filter((id) => tab.channels[id]?.derivedKind === 'filter').length;
    const newId = `filt_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const newCh: WaveformChannel = {
      ...srcCh,
      id: newId,
      name: `${srcCh.name}_${res.metrics.badgeText}`,
      unit: srcCh.unit,
      color: this.getNextComputedColor(filterCount),
      visible: true,
      t: srcCh.t,
      v: new Float32Array(res.v),
      isMath: true,
      channelKind: 'computed',
      derivedKind: 'filter',
      derivedBadge: res.metrics.badgeText,
      mathExpression: res.metrics.summaryText,
      sourceChannelIds: [srcCh.id],
      coupling: 'DC',
      inverted: false,
      hasEdits: false,
      refV: undefined,
      showRef: false,
      showDiff: false,
      voltsPerDiv: undefined,
      vOffset: undefined,
      vMin: -1,
      vMax: 1,
    };
    fitChannelTo125(newCh);

    tab.channels[newId] = newCh;
    tab.drawOrder.push(newId);
    tab.activeChannelId = newId;
    tab.selectedMeasurementChannelId = newId;
    tab.selectedFftChannelId = newId;
    tab.cursors.trackingChannel = newId;
    this.editVersion++;
    this.cachedSpectrum = null;
    this.cachedSpectrumKey = '';
    this.renderSidebar();
    this.draw();
    this.showToast(
      `已创建滤波通道 [${res.metrics.badgeText}] ${newCh.name}（${res.metrics.sampleCountFiltered.toLocaleString()} 点）。${res.warning ? `提示：${res.warning}` : ''}`,
      check.warning || res.warning ? 'warn' : 'info'
    );
    return { ok: true, targetChannelId: newId, result: res };
  }

  public setChannelsTimeShift(
    channelIds: string[],
    shiftSec: number,
    pushUndo: boolean = false
  ): void {
    const tab = this.getActiveTab();
    if (!tab || channelIds.length === 0) return;
    if (pushUndo) {
      this.pushUndoSnapshot('时间平移 Δt', true);
    }
    let changed = false;
    for (const id of channelIds) {
      const ch = tab.channels[id];
      if (!ch) continue;
      applyChannelTimeShift(ch, shiftSec);
      changed = true;
    }
    if (!changed) return;
    extendTabViewToLongestChannel(tab);
    clampCursorsToViewport(tab);
    this.editVersion++;
    this.cachedSpectrum = null;
    this.cachedSpectrumKey = '';
    this.renderSidebar();
    this.draw();
  }

  public snapChannelStartToPrimary(channelId: string): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    const ch = tab.channels[channelId];
    if (!ch || !ch.t || ch.t.length === 0) return;

    // Pick longest other visible channel (or drawOrder[0]) as reference anchor
    let anchor: WaveformChannel | null = null;
    let bestSpan = -1;
    for (const id of tab.drawOrder) {
      if (id === channelId) continue;
      const cand = tab.channels[id];
      if (!cand || !cand.t || cand.t.length < 2) continue;
      const span = cand.t[cand.t.length - 1] - cand.t[0];
      if (span > bestSpan) {
        bestSpan = span;
        anchor = cand;
      }
    }
    if (!anchor) return;
    const baseStart =
      ch.timeShiftBaseT && ch.timeShiftBaseT.length === ch.t.length
        ? ch.timeShiftBaseT[0]
        : ch.t[0];
    const targetStart = anchor.t[0];
    if (!Number.isFinite(baseStart) || !Number.isFinite(targetStart)) return;
    this.setChannelsTimeShift([channelId], targetStart - baseStart, true);
    this.showToast(`已将 ${ch.name} 起点对齐到主波形 (${formatEng(targetStart, 's', 3)})。`, 'info', { undoable: true });
  }

  public resetChannelsTimeShift(channelIds: string[], pushUndo: boolean = true): void {
    const tab = this.getActiveTab();
    if (!tab || channelIds.length === 0) return;
    if (pushUndo) {
      this.pushUndoSnapshot('归零时间平移 Δt', true);
    }
    let anyReset = false;
    for (const id of channelIds) {
      const ch = tab.channels[id];
      if (!ch) continue;
      if (resetChannelTimeShift(ch)) anyReset = true;
    }
    if (!anyReset) {
      if (pushUndo) {
        this.undoStack.pop();
        this.updateUndoRedoButtons();
      }
      return;
    }
    extendTabViewToLongestChannel(tab);
    clampCursorsToViewport(tab);
    this.editVersion++;
    this.cachedSpectrum = null;
    this.cachedSpectrumKey = '';
    this.renderSidebar();
    this.draw();
    this.showToast(`已将 ${channelIds.length} 条通道的 Δt 归零。`, 'info', { undoable: true });
  }

  public getGoldenEvaluation(tab: TabState): GoldenEvaluationResult | null {
    const gb = tab.goldenBand;
    if (!gb || !gb.enabled) return null;
    const ch = tab.channels[gb.channelId];
    if (!ch) return null;
    return evaluateGoldenTolerance(ch, gb);
  }

  public scanAnomalies(chId: string, opts: AnomalyScanOptions): AnomalyEvent[] {
    const tab = this.getActiveTab();
    const ch = tab?.channels[chId];
    if (!tab || !ch) return [];
    const events = scanChannelAnomalies(ch, opts);
    tab.activeChannelId = chId;
    tab.activeAnomalies = events;
    tab.selectedAnomalyIndex = events.length > 0 ? 0 : null;
    this.draw();
    this.showToast(
      events.length > 0
        ? `在 ${ch.name} 上检测到 ${events.length} 个异常事件。`
        : `${ch.name} 未检测到符合条件的异常事件。`,
      events.length > 0 ? 'warn' : 'info'
    );
    return events;
  }

  public clearAnomalies(): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    tab.activeAnomalies = [];
    tab.selectedAnomalyIndex = null;
    this.draw();
  }

  public jumpToAnomaly(idx: number): void {
    const tab = this.getActiveTab();
    if (!tab || !tab.activeAnomalies || !tab.activeAnomalies[idx]) return;
    const ev = tab.activeAnomalies[idx];
    const ch = tab.channels[tab.activeChannelId || tab.drawOrder[0]];
    if (!ch || ch.v.length < 2) return;

    tab.plotMode = 'time';
    tab.selectedAnomalyIndex = idx;
    const halfSpan = Math.max(40, Math.min(Math.floor(ch.v.length * 0.05), 1000));
    let newStart = ev.index - halfSpan;
    let newEnd = ev.index + halfSpan;
    if (newStart < 0) {
      newStart = 0;
      newEnd = Math.min(ch.v.length, halfSpan * 2);
    }
    if (newEnd > ch.v.length) {
      newEnd = ch.v.length;
      newStart = Math.max(0, ch.v.length - halfSpan * 2);
    }
    tab.view.startIndex = newStart;
    tab.view.endIndex = newEnd;
    clampCursorsToViewport(tab);
    this.renderSidebar();
    this.draw();
  }

  public jumpToSampleIndex(channelId: string, index: number): void {
    const tab = this.getActiveTab();
    const ch = tab?.channels[channelId];
    if (!tab || !ch || ch.v.length < 2) return;

    tab.plotMode = 'time';
    tab.activeChannelId = channelId;
    const clampedIdx = Math.max(0, Math.min(ch.v.length - 1, index));
    const halfSpan = Math.max(40, Math.min(Math.floor(ch.v.length * 0.05), 1000));
    let newStart = clampedIdx - halfSpan;
    let newEnd = clampedIdx + halfSpan;
    if (newStart < 0) {
      newStart = 0;
      newEnd = Math.min(ch.v.length, halfSpan * 2);
    }
    if (newEnd > ch.v.length) {
      newEnd = ch.v.length;
      newStart = Math.max(0, ch.v.length - halfSpan * 2);
    }
    tab.view.startIndex = newStart;
    tab.view.endIndex = newEnd;
    clampCursorsToViewport(tab);
    this.renderSidebar();
    this.draw();
  }

  public getAllTabChannelOptions(): Array<{
    tabId: string;
    tabName: string;
    channelId: string;
    channelName: string;
    unit: string;
    isCurrentTab: boolean;
    channel: WaveformChannel;
  }> {
    const activeTab = this.getActiveTab();
    const out: Array<{
      tabId: string;
      tabName: string;
      channelId: string;
      channelName: string;
      unit: string;
      isCurrentTab: boolean;
      channel: WaveformChannel;
    }> = [];

    const orderedTabs = activeTab
      ? [activeTab, ...this.tabs.filter((t) => t.id !== activeTab.id)]
      : this.tabs;

    for (const t of orderedTabs) {
      for (const chId of t.drawOrder) {
        const ch = t.channels[chId];
        if (!ch) continue;
        out.push({
          tabId: t.id,
          tabName: t.fileName,
          channelId: ch.id,
          channelName: ch.name,
          unit: ch.unit || 'V',
          isCurrentTab: activeTab ? t.id === activeTab.id : false,
          channel: ch,
        });
      }
    }
    return out;
  }

  public applyCompareOverlay(
    targetChannelId: string,
    refLabel: string,
    alignedRefV: Float32Array,
    diffV: Float32Array,
    options: {
      overlayRefTrace: boolean;
      enableGoldenBand: boolean;
      goldenMode: 'percent' | 'absolute';
      goldenTolerance: number;
      addDiffChannel: boolean;
      fullRefTrace?: { t: Float64Array; v: Float32Array };
    }
  ): void {
    const tab = this.getActiveTab();
    const targetCh = tab?.channels[targetChannelId];
    if (!tab || !targetCh) return;

    this.pushUndoSnapshot('Waveform Compare', true);
    tab.plotMode = 'time';
    tab.activeChannelId = targetChannelId;

    if (options.overlayRefTrace) {
      const refChId = `cmp_ref_${targetChannelId}`;
      const existing = tab.channels[refChId];
      const fullT = options.fullRefTrace?.t && options.fullRefTrace.t.length > 0 ? options.fullRefTrace.t : targetCh.t;
      const fullV = options.fullRefTrace?.v && options.fullRefTrace.v.length === fullT.length ? options.fullRefTrace.v : alignedRefV;
      const refTrace: WaveformChannel = {
        ...targetCh,
        id: refChId,
        name: `REF: ${refLabel}`,
        unit: targetCh.unit || 'V',
        color: this.theme.isLight ? '#475569' : '#94a3b8',
        visible: true,
        t: new Float64Array(fullT),
        v: new Float32Array(fullV),
        timeShiftSec: 0,
        timeShiftBaseT: undefined,
        isMath: true,
        channelKind: 'computed',
        derivedKind: 'ref',
        derivedBadge: 'REF',
        mathExpression: `Compare Reference (${refLabel})`,
        sourceChannelIds: [targetChannelId],
        coupling: 'DC',
        inverted: false,
        hasEdits: false,
        refV: undefined,
        voltsPerDiv: targetCh.voltsPerDiv,
        vOffset: targetCh.vOffset,
        vMin: targetCh.vMin,
        vMax: targetCh.vMax,
      };
      tab.channels[refChId] = refTrace;
      if (!existing && !tab.drawOrder.includes(refChId)) {
        tab.drawOrder.push(refChId);
      }
      // Align same-unit scale so Target and Reference sit identically on grid
      syncSameUnitChannelsScale(tab, targetChannelId);
    }

    if (options.enableGoldenBand) {
      tab.goldenBand = {
        enabled: true,
        channelId: targetChannelId,
        mode: options.goldenMode,
        tolerance: Math.max(0.01, options.goldenTolerance || 5),
        refT: new Float64Array(targetCh.t),
        refV: new Float32Array(alignedRefV),
        refUnit: targetCh.unit,
        refLabel,
      };
    }

    if (options.addDiffChannel) {
      const diffChId = `cmp_diff_${targetChannelId}`;
      const existingDiff = tab.channels[diffChId];
      const diffTrace: WaveformChannel = {
        ...targetCh,
        id: diffChId,
        name: `Δ(${targetCh.name} − ${refLabel})`,
        unit: targetCh.unit || 'V',
        color: this.theme.isLight ? '#e11d48' : '#fb7185',
        visible: true,
        t: new Float64Array(targetCh.t),
        v: new Float32Array(diffV),
        timeShiftSec: 0,
        timeShiftBaseT: undefined,
        isMath: true,
        channelKind: 'computed',
        derivedKind: 'diff',
        derivedBadge: 'DIFF',
        mathExpression: `${targetCh.name} - ${refLabel}`,
        sourceChannelIds: [targetChannelId],
        coupling: 'DC',
        inverted: false,
        hasEdits: false,
        refV: undefined,
        voltsPerDiv: undefined,
        vOffset: undefined,
        vMin: -1,
        vMax: 1,
      };
      fitChannelTo125(diffTrace);
      tab.channels[diffChId] = diffTrace;
      if (!existingDiff && !tab.drawOrder.includes(diffChId)) {
        tab.drawOrder.push(diffChId);
      }
    }

    extendTabViewToLongestChannel(tab);
    clampCursorsToViewport(tab);
    this.cachedSpectrum = null;
    this.cachedSpectrumKey = '';
    this.renderSidebar();
    this.draw();
  }

  public findTabByFingerprint(fingerprint: string): { tab: TabState; index: number } | null {
    if (!fingerprint) return null;
    for (let i = 0; i < this.tabs.length; i++) {
      if (this.tabs[i].fileFingerprint === fingerprint) {
        return { tab: this.tabs[i], index: i };
      }
    }
    return null;
  }

  public applyMultiCompareGroup(
    targetChannelId: string,
    groupConfig: {
      groupId: string;
      replaceGroupId?: string;
      groupName: string;
      groupColor: string;
      targetColor?: string;
      tagTargetChannel: boolean;
      overlayRefTraces: boolean;
      enableGoldenBand: boolean;
      goldenMode: 'percent' | 'absolute';
      goldenTolerance: number;
      minCoveragePct?: number;
      addDiffChannels: boolean;
    },
    items: Array<{
      id: string;
      refLabel: string;
      color: string;
      alignedRefV: Float32Array;
      diffV: Float32Array;
      fullRefT?: Float64Array;
      fullRefV?: Float32Array;
    }>
  ): void {
    const tab = this.getActiveTab();
    const targetCh = tab?.channels[targetChannelId];
    if (!tab || !targetCh || items.length === 0) return;

    this.pushUndoSnapshot(`Compare Group [${groupConfig.groupName}]`, true);
    tab.plotMode = 'time';
    tab.activeChannelId = targetChannelId;

    // If replacing an existing group (or re-applying same groupId), clean up old synthetic ref/diff traces first
    const oldGroupId = groupConfig.replaceGroupId || groupConfig.groupId;
    if (oldGroupId) {
      const staleIds = new Set<string>();
      for (const id of tab.drawOrder) {
        const ch = tab.channels[id];
        if (!ch || ch.compareGroupId !== oldGroupId) continue;
        if (ch.compareRole === 'target' || !id.startsWith('cmp_')) {
          if (id !== targetChannelId || !groupConfig.tagTargetChannel) {
            delete ch.compareGroupId;
            delete ch.compareGroupName;
            delete ch.compareGroupColor;
            delete ch.compareRole;
          }
        } else {
          const isOldRef = groupConfig.overlayRefTraces && ch.compareRole === 'ref';
          const isOldDiff = groupConfig.addDiffChannels && ch.compareRole === 'diff';
          if (isOldRef || isOldDiff) {
            staleIds.add(id);
            delete tab.channels[id];
          } else {
            ch.compareGroupId = groupConfig.groupId;
            ch.compareGroupName = groupConfig.groupName;
            ch.compareGroupColor = groupConfig.groupColor;
          }
        }
      }
      if (staleIds.size > 0) {
        tab.drawOrder = tab.drawOrder.filter((id) => !staleIds.has(id));
      }
    }

    if (groupConfig.tagTargetChannel) {
      targetCh.compareGroupId = groupConfig.groupId;
      targetCh.compareGroupName = groupConfig.groupName;
      targetCh.compareGroupColor = groupConfig.groupColor;
      targetCh.compareRole = 'target';
      if (groupConfig.targetColor) {
        targetCh.color = groupConfig.targetColor;
      }
    }

    if (groupConfig.overlayRefTraces) {
      items.forEach((item, idx) => {
        const refChId = `cmp_ref_${groupConfig.groupId}_${idx}_${item.id}`;
        const existing = tab.channels[refChId];
        const fullT = item.fullRefT && item.fullRefT.length > 0 ? item.fullRefT : targetCh.t;
        const fullV = item.fullRefV && item.fullRefV.length === fullT.length ? item.fullRefV : item.alignedRefV;
        const refTrace: WaveformChannel = {
          ...targetCh,
          id: refChId,
          name: `[${groupConfig.groupName}] ${item.refLabel}`,
          unit: targetCh.unit || 'V',
          color: item.color,
          visible: true,
          t: new Float64Array(fullT),
          v: new Float32Array(fullV),
          timeShiftSec: 0,
          timeShiftBaseT: undefined,
          isMath: true,
          channelKind: 'computed',
          derivedKind: 'ref',
          derivedBadge: 'REF',
          mathExpression: `Compare [${groupConfig.groupName}]: ${item.refLabel}`,
          sourceChannelIds: [targetChannelId],
          coupling: 'DC',
          inverted: false,
          hasEdits: false,
          refV: undefined,
          voltsPerDiv: targetCh.voltsPerDiv,
          vOffset: targetCh.vOffset,
          vMin: targetCh.vMin,
          vMax: targetCh.vMax,
          compareGroupId: groupConfig.groupId,
          compareGroupName: groupConfig.groupName,
          compareGroupColor: groupConfig.groupColor,
          compareRole: 'ref',
        };
        tab.channels[refChId] = refTrace;
        if (!existing && !tab.drawOrder.includes(refChId)) {
          tab.drawOrder.push(refChId);
        }
      });
      syncSameUnitChannelsScale(tab, targetChannelId);
    }

    if (groupConfig.enableGoldenBand && items[0]) {
      tab.goldenBand = {
        enabled: true,
        channelId: targetChannelId,
        mode: groupConfig.goldenMode,
        tolerance: Math.max(0.01, groupConfig.goldenTolerance || 5),
        minCoveragePct: Math.max(0, Math.min(100, groupConfig.minCoveragePct ?? 80)),
        refT: new Float64Array(targetCh.t),
        refV: new Float32Array(items[0].alignedRefV),
        refUnit: targetCh.unit,
        refLabel: `[${groupConfig.groupName}] ${items[0].refLabel}`,
      };
    }

    if (groupConfig.addDiffChannels) {
      items.forEach((item, idx) => {
        const diffChId = `cmp_diff_${groupConfig.groupId}_${idx}_${item.id}`;
        const existingDiff = tab.channels[diffChId];
        const diffTrace: WaveformChannel = {
          ...targetCh,
          id: diffChId,
          name: `[${groupConfig.groupName}] Δ(${targetCh.name} − ${item.refLabel})`,
          unit: targetCh.unit || 'V',
          color: item.color,
          visible: true,
          t: new Float64Array(targetCh.t),
          v: new Float32Array(item.diffV),
          timeShiftSec: 0,
          timeShiftBaseT: undefined,
          isMath: true,
          channelKind: 'computed',
          derivedKind: 'diff',
          derivedBadge: 'DIFF',
          mathExpression: `${targetCh.name} - ${item.refLabel}`,
          sourceChannelIds: [targetChannelId],
          coupling: 'DC',
          inverted: false,
          hasEdits: false,
          refV: undefined,
          voltsPerDiv: undefined,
          vOffset: undefined,
          vMin: -1,
          vMax: 1,
          compareGroupId: groupConfig.groupId,
          compareGroupName: groupConfig.groupName,
          compareGroupColor: groupConfig.groupColor,
          compareRole: 'diff',
        };
        fitChannelTo125(diffTrace);
        tab.channels[diffChId] = diffTrace;
        if (!existingDiff && !tab.drawOrder.includes(diffChId)) {
          tab.drawOrder.push(diffChId);
        }
      });
    }

    extendTabViewToLongestChannel(tab);
    clampCursorsToViewport(tab);
    this.cachedSpectrum = null;
    this.cachedSpectrumKey = '';
    this.renderSidebar();
    this.draw();
  }

  public toggleCompareGroupVisibility(groupId: string): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    const members = tab.drawOrder
      .map((id) => tab.channels[id])
      .filter((c) => c && c.compareGroupId === groupId && c.compareRole !== 'target');
    const pool =
      members.length > 0
        ? members
        : tab.drawOrder.map((id) => tab.channels[id]).filter((c) => c && c.compareGroupId === groupId);
    if (pool.length === 0) return;
    const anyHidden = pool.some((c) => !c.visible);
    const targetVis = anyHidden ? true : false;
    pool.forEach((c) => {
      c.visible = targetVis;
    });
    this.renderSidebar();
    this.draw();
  }

  public removeCompareGroup(groupId: string): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    this.pushUndoSnapshot('Remove Compare Group', true);
    const toDelete = new Set<string>();
    let grpName = '';
    for (const id of tab.drawOrder) {
      const ch = tab.channels[id];
      if (!ch || ch.compareGroupId !== groupId) continue;
      grpName = ch.compareGroupName || grpName;
      if (ch.compareRole === 'target' || !id.startsWith('cmp_')) {
        delete ch.compareGroupId;
        delete ch.compareGroupName;
        delete ch.compareGroupColor;
        delete ch.compareRole;
      } else {
        toDelete.add(id);
        delete tab.channels[id];
      }
    }
    tab.drawOrder = tab.drawOrder.filter((id) => !toDelete.has(id));
    if (tab.activeChannelId && toDelete.has(tab.activeChannelId)) {
      tab.activeChannelId = tab.drawOrder[0];
    }
    if (tab.goldenBand && tab.goldenBand.refLabel?.startsWith(`[${grpName}]`)) {
      tab.goldenBand.enabled = false;
    }
    this.cachedSpectrum = null;
    this.cachedSpectrumKey = '';
    this.renderSidebar();
    this.draw();
    this.showToast(`已移除对比组${grpName ? ` [${grpName}]` : ''}。`, 'info');
  }

  public exportCroppedSlice(format: 'csv' | 'json', rangeMode: 'view' | 'cursors', channelIds: string[]): void {
    const tab = this.getActiveTab();
    if (!tab) return;

    const baseCh = tab.channels[channelIds[0] || tab.drawOrder[0]];
    if (!baseCh) return;

    let tStart: number;
    let tEnd: number;
    if (rangeMode === 'cursors' && tab.cursors.enabled && tab.cursors.x1 !== null && tab.cursors.x2 !== null) {
      tStart = Math.min(tab.cursors.x1, tab.cursors.x2);
      tEnd = Math.max(tab.cursors.x1, tab.cursors.x2);
    } else {
      const b = getTimeBoundsForView(tab, baseCh);
      tStart = b.tStart;
      tEnd = b.tEnd;
    }

    try {
      const res =
        format === 'json'
          ? exportCroppedWaveformJSON(tab, tStart, tEnd, channelIds)
          : exportCroppedWaveformCSV(tab, tStart, tEnd, channelIds);
      this.showToast(`已导出 ${res.rowCount.toLocaleString()} 个截取采样点（${format.toUpperCase()}）。`, 'info');
    } catch (err: any) {
      this.showToast(`截取导出失败：${err.message}`, 'error');
    }
  }

  public submitPendingTextAnnotation(text: string): void {
    const tab = this.getActiveTab();
    if (!tab || !this.pendingAnnotationCoord) return;
    const trimmed = text.trim();
    if (trimmed) {
      tab.annotations.push({
        id: `ann_${Date.now()}`,
        type: 'text',
        x: this.pendingAnnotationCoord.time,
        y: this.pendingAnnotationCoord.voltage,
        channelId: this.pendingAnnotationCoord.channelId,
        text: trimmed,
      });
      tab.annotationsVisible = true;
    }
    this.pendingAnnotationCoord = null;
    tab.activeTool = 'pan';
    this.renderSidebar();
    this.draw();
  }

  private getTabPlotArea(
    tab: TabState | undefined | null,
    width: number,
    height: number,
    updateCache: boolean = true
  ): PlotArea {
    if (!tab || tab.drawOrder.length === 0) {
      return getPlotArea(width, height);
    }
    const visCount = tab.drawOrder.filter((id) => tab.channels[id]?.visible).length;
    const layoutKey = `${tab.plotMode}|${tab.separateView ? 'sep' : 'ov'}|${tab.activeChannelId || ''}|${tab.selectedFftChannelId || ''}|${visCount}`;
    const prevEntry = this.tabLeftMarginCache.get(tab.id);
    const prevLeftMargin = prevEntry && prevEntry.layoutKey === layoutKey ? prevEntry.margin : undefined;
    const { plotArea, leftMargin } = getDynamicPlotArea(tab, width, height, {
      cachedSpectrum: this.cachedSpectrum,
      ctx: this.ctx,
      prevLeftMargin,
    });
    if (updateCache || !prevEntry || prevEntry.layoutKey !== layoutKey) {
      this.tabLeftMarginCache.set(tab.id, { margin: leftMargin, layoutKey });
    }
    return plotArea;
  }

  // --- Rendering Pipeline ---
  public scheduleDraw(): void {
    if (this.pendingDrawRaf !== null) return;
    this.pendingDrawRaf = requestAnimationFrame(() => {
      this.pendingDrawRaf = null;
      this.draw(false);
    });
  }

  private syncHud(tab: TabState | null, immediate: boolean): void {
    const runSync = (): void => {
      this.lastHudSyncAt = performance.now();
      this.updateStatusBar();
      this.updateScreenTelemetry();
      if (tab) {
        this.renderMeasurementStrip(tab);
      }
    };

    if (immediate) {
      if (this.hudSettleTimer !== null) {
        window.clearTimeout(this.hudSettleTimer);
        this.hudSettleTimer = null;
      }
      runSync();
      return;
    }

    const now = performance.now();
    if (now - this.lastHudSyncAt >= this.hudThrottleMs) {
      runSync();
    }
    if (this.hudSettleTimer !== null) {
      window.clearTimeout(this.hudSettleTimer);
    }
    this.hudSettleTimer = window.setTimeout(() => {
      this.hudSettleTimer = null;
      const latestTab = this.getActiveTab();
      this.lastHudSyncAt = performance.now();
      this.updateStatusBar();
      this.updateScreenTelemetry();
      if (latestTab && latestTab.drawOrder.length > 0) {
        this.renderMeasurementStrip(latestTab);
      }
    }, this.hudSettleDelayMs);
  }

  public draw(immediateHud: boolean = true): void {
    if (this.pendingDrawRaf !== null) {
      cancelAnimationFrame(this.pendingDrawRaf);
      this.pendingDrawRaf = null;
    }
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.width / dpr;
    const height = this.canvas.height / dpr;

    this.ctx.clearRect(0, 0, width, height);

    const tab = this.getActiveTab();
    if (!tab || tab.drawOrder.length === 0) {
      const p = getPlotArea(width, height);
      drawGrid(this.ctx, p, this.theme);
      const emptyOverlay = document.getElementById('emptyScopeOverlay');
      if (emptyOverlay) emptyOverlay.style.display = 'flex';
      this.syncHud(null, true);
      return;
    }

    const emptyOverlay = document.getElementById('emptyScopeOverlay');
    if (emptyOverlay) emptyOverlay.style.display = 'none';
    this.ensureTabDefaults(tab);
    const p = this.getTabPlotArea(tab, width, height, true);

    if (tab.plotMode === 'frequency') {
      drawGrid(this.ctx, p, this.theme, 10, 8, false);
      this.renderFrequencyDomain(tab, p);
    } else if (tab.plotMode === 'xy') {
      drawGrid(this.ctx, p, this.theme, 10, 8, true);
      drawXYPlot(this.ctx, tab, p, this.theme);
    } else {
      const visibleChs = tab.drawOrder.map((id) => tab.channels[id]).filter((c) => c && c.visible);
      if (!tab.separateView || visibleChs.length <= 1) {
        drawGrid(this.ctx, p, this.theme, 10, 8, true);
      }
      this.renderTimeDomain(tab, p);
      drawGndMarkers(this.ctx, p, tab, this.theme);
      drawCursors(this.ctx, tab, p, this.theme);
      drawActiveAnomalyMarkers(this.ctx, tab, p, this.theme);
      drawAnnotations(this.ctx, tab, p, this.theme);
    }

    drawAxisLabels(this.ctx, p, tab, this.theme, 10, 8, this.cachedSpectrum);
    if (tab.plotMode === 'time') {
      const legendBottom = drawOverlapTraceLegend(this.ctx, tab, p, this.theme);
      drawCompareGroupLegend(
        this.ctx,
        tab,
        p,
        this.theme,
        legendBottom > p.y + 8 ? legendBottom + 6 : undefined
      );
    }

    // Interactive box drag overlay (Area Zoom or Area Annotation)
    if (this.dragState && (this.dragState.type === 'areaZoom' || this.dragState.type === 'areaAnnotate')) {
      const { start, end, type } = this.dragState;
      this.ctx.save();
      this.ctx.fillStyle = type === 'areaZoom' ? 'rgba(56, 189, 248, 0.18)' : 'rgba(52, 211, 153, 0.18)';
      this.ctx.strokeStyle = this.theme.isLight
        ? (type === 'areaZoom' ? '#0284c7' : '#059669')
        : (type === 'areaZoom' ? '#38bdf8' : '#34d399');
      this.ctx.lineWidth = 1.2;
      const rx = Math.min(start.x, end.x);
      const ry = Math.min(start.y, end.y);
      const rw = Math.abs(end.x - start.x);
      const rh = Math.abs(end.y - start.y);
      this.ctx.fillRect(rx, ry, rw, rh);
      this.ctx.strokeRect(rx, ry, rw, rh);
      this.ctx.restore();
    }

    this.syncHud(tab, immediateHud);
  }

  private renderTimeDomain(tab: TabState, p: PlotArea): void {
    const visibleChs = tab.drawOrder
      .map((id) => tab.channels[id])
      .filter((c) => c && c.visible);

    const goldenEval = this.getGoldenEvaluation(tab);

    if (tab.separateView && visibleChs.length > 1) {
      const rects = getSubplotRects(p, visibleChs, true);
      rects.forEach((rect) => {
        drawGrid(this.ctx, rect.area, this.theme, 10, 4, true);
        drawChannelWaveform(this.ctx, tab, rect.channel, p, rect.area, this.theme);
        if (goldenEval && tab.goldenBand?.channelId === rect.channel.id) {
          drawGoldenToleranceBand(this.ctx, tab, rect.channel, p, goldenEval, rect.area);
        }
      });
    } else {
      for (const ch of visibleChs) {
        drawChannelWaveform(this.ctx, tab, ch, p, undefined, this.theme);
        if (goldenEval && tab.goldenBand?.channelId === ch.id) {
          drawGoldenToleranceBand(this.ctx, tab, ch, p, goldenEval);
        }
      }
    }

    drawTriggerLine(this.ctx, tab, p, this.theme);
  }

  private lastRenderedPeaksKey: string = '';

  private renderFrequencyDomain(tab: TabState, p: PlotArea): void {
    const targetId = tab.selectedFftChannelId || tab.drawOrder[0];
    const primaryCh = tab.channels[targetId] || tab.channels[tab.drawOrder[0]];
    if (!primaryCh || primaryCh.v.length === 0) return;

    const rangeSuffix =
      tab.fftOptions.range === 'view'
        ? `${tab.view.startIndex}_${tab.view.endIndex}`
        : tab.fftOptions.range === 'cursors'
        ? `${tab.cursors.x1}_${tab.cursors.x2}`
        : 'entire';
    const key = `${primaryCh.id}_${rangeSuffix}_${tab.fftOptions.window}_${tab.fftOptions.zeroPadding}_${tab.fftOptions.removeDC}_${tab.fftOptions.range}_${this.editVersion}`;

    if (this.cachedSpectrumKey !== key || !this.cachedSpectrum) {
      try {
        let tSlice = primaryCh.t;
        let vSlice = primaryCh.v;

        if (tab.fftOptions.range === 'view') {
          const primaryRef = tab.channels[tab.drawOrder[0]];
          if (primaryRef && primaryCh.id === primaryRef.id && tab.view.startIndex >= 0 && tab.view.endIndex <= primaryCh.v.length) {
            const s = Math.max(0, tab.view.startIndex);
            const e = Math.min(primaryCh.v.length, tab.view.endIndex);
            tSlice = primaryCh.t.subarray(s, e);
            vSlice = primaryCh.v.subarray(s, e);
          } else {
            const vb = getTimeBoundsForView(tab, primaryRef || primaryCh);
            let s = 0;
            while (s < primaryCh.t.length && primaryCh.t[s] < vb.tStart) s++;
            let e = s;
            while (e < primaryCh.t.length && primaryCh.t[e] <= vb.tEnd) e++;
            tSlice = primaryCh.t.subarray(s, e);
            vSlice = primaryCh.v.subarray(s, e);
          }
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
          primaryCh.name,
          {
            sourceUnit: primaryCh.unit || 'V',
            isUniformSampling: primaryCh.metadata?.isUniformSampling,
          }
        );
        this.cachedSpectrumKey = key;
      } catch (e) {
        console.error('FFT calculation error:', e);
        this.cachedSpectrum = null;
      }
    }

    if (this.cachedSpectrum) {
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

      const peaksRenderKey = `${this.cachedSpectrumKey}_${tab.fftOptions.scale}`;
      if (this.lastRenderedPeaksKey !== peaksRenderKey) {
        this.lastRenderedPeaksKey = peaksRenderKey;
        const peaksEl = document.getElementById('fftPeaksList');
        if (peaksEl) {
          const warnHtml = this.cachedSpectrum.cappedWarning
            ? `<div class="mb-1.5 px-1.5 py-1 bg-amber-950/50 border border-amber-500/50 text-amber-200 rounded-xs text-[10px] font-mono">⚠ ${escapeHtml(this.cachedSpectrum.cappedWarning)}</div>`
            : '';
          if (this.cachedSpectrum.peaks.length === 0) {
            peaksEl.innerHTML = `${warnHtml}<div class="text-slate-500">No peaks detected above threshold</div>`;
          } else {
            let html = warnHtml;
            this.cachedSpectrum.peaks.forEach((peak, i) => {
              const isFund = peak.isFundamental;
              const magStr =
                tab.fftOptions.scale === 'db'
                  ? `${peak.db.toFixed(1)} dB`
                  : formatEng(peak.magnitude, primaryCh.unit, 2);
              html += `
                <div class="flex justify-between items-center py-0.5 ${isFund ? 'text-amber-300 font-semibold' : 'text-slate-300'}">
                  <span>${isFund ? '* ' : ''}P${i + 1}: ${formatEng(peak.frequency, 'Hz', 2)}</span>
                  <span>${escapeHtml(magStr)}</span>
                </div>
              `;
            });
            peaksEl.innerHTML = html;
          }
        }
      }
    }
  }

  // --- Interaction & Events ---
  private hideScopeContextMenu(): void {
    const menu = document.getElementById('scopeContextMenu');
    if (menu) menu.classList.add('hidden');
    this.contextMenuPoint = null;
  }

  private openScopeContextMenu(clientX: number, clientY: number, canvasX: number, canvasY: number): void {
    const menu = document.getElementById('scopeContextMenu');
    const stage = this.canvas.parentElement;
    if (!menu || !stage) return;
    this.contextMenuPoint = { x: canvasX, y: canvasY };
    menu.classList.remove('hidden');
    const stageRect = stage.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const left = Math.max(4, Math.min(stageRect.width - menuRect.width - 6, clientX - stageRect.left));
    const top = Math.max(4, Math.min(stageRect.height - menuRect.height - 6, clientY - stageRect.top));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  private setYAxisGestureHintVisible(show: boolean): void {
    const el = document.getElementById('yAxisGestureHint');
    if (!el) return;
    if (show) {
      try {
        if (localStorage.getItem('wvp_hide_yaxis_hint_v1') === '1') return;
      } catch {
        // ignore storage error
      }
      el.classList.remove('hidden');
      el.classList.add('flex');
    } else {
      el.classList.add('hidden');
      el.classList.remove('flex');
    }
  }

  private initEvents(): void {
    // Restore right panel collapsed state from localStorage
    try {
      if (localStorage.getItem('wvp_panel_collapsed_v1') === '1') {
        const panel = document.getElementById('rightControlPanel');
        const btn = document.getElementById('togglePanelBtn');
        panel?.classList.add('hidden');
        if (btn) btn.innerText = '展开右侧控制面板';
      }
    } catch {
      // ignore
    }

    // Inline Toast Undo button
    document.getElementById('scopeToastUndoBtn')?.addEventListener('click', () => {
      document.getElementById('scopeToast')?.classList.add('hidden');
      this.undo();
    });

    // Y-axis gesture hint dismiss
    document.getElementById('yAxisGestureHintCloseBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      try {
        localStorage.setItem('wvp_hide_yaxis_hint_v1', '1');
      } catch {
        // ignore
      }
      this.setYAxisGestureHintVisible(false);
    });

    // Canvas right-click context menu actions
    document.getElementById('scopeContextMenu')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement)?.closest('[data-ctx-action]') as HTMLElement | null;
      if (!btn) return;
      const action = btn.dataset.ctxAction;
      const pt = this.contextMenuPoint;
      this.hideScopeContextMenu();
      const tab = this.getActiveTab();
      if (!tab) return;

      const dpr = window.devicePixelRatio || 1;
      const p = this.getTabPlotArea(tab, this.canvas.width / dpr, this.canvas.height / dpr, false);
      const hit = pt ? this.findSubplotAtPoint(tab, p, pt.y) : null;
      const activeCh = tab.channels[tab.activeChannelId || ''] || hit?.channel || tab.channels[tab.drawOrder[0]];

      if (action === 'fit') {
        this.fitView();
      } else if (action === 'autoset') {
        this.executeAutoSet();
      } else if (action === 'zeroOffset') {
        if (activeCh) {
          this.zeroChannelOffset(activeCh.id);
          this.showToast(`已归零垂直偏移（${activeCh.name} = 0 ${activeCh.unit}）`, 'info', { undoable: true });
        }
      } else if (action === 'placeCursor' && pt && activeCh) {
        const dataPt = screenToData(pt, tab, activeCh.id, hit?.area || p);
        if (resolveCursorMode(tab) === 'off') {
          this.setCursorMode('x');
        }
        tab.cursors.x1 = dataPt.time;
        clampCursorsToViewport(tab);
        this.renderCursorReadoutOnly(tab);
        this.draw();
        this.showToast(`已将 X1 游标放置于 T = ${formatEng(dataPt.time, 's', 4)}`, 'info');
      } else if (action === 'addPoint' && pt && activeCh) {
        const targetCh = hit?.channel || activeCh;
        const dataPt = screenToData(pt, tab, targetCh.id, hit?.area || p);
        const sampledV = sampleChannelValueAtTime(targetCh, dataPt.time);
        this.pushUndoSnapshot('添加单点标注');
        tab.annotations.push({
          id: `ann_${Date.now()}`,
          type: 'point',
          x: dataPt.time,
          y: sampledV !== null ? sampledV : dataPt.voltage,
          channelId: targetCh.id,
          color: targetCh.color,
        });
        tab.annotationsVisible = true;
        this.draw();
        this.showToast(`已在 ${targetCh.name} 添加单点标注。`, 'info', { undoable: true });
      } else if (action === 'copyReadout' && pt && activeCh) {
        const targetCh = hit?.channel || activeCh;
        const dataPt = screenToData(pt, tab, targetCh.id, hit?.area || p);
        const sampledV = sampleChannelValueAtTime(targetCh, dataPt.time);
        const val = sampledV !== null ? sampledV : dataPt.voltage;
        const txt = `${targetCh.name}: T=${formatEng(dataPt.time, 's', 5)}, V=${formatEng(val, targetCh.unit, 4)}`;
        navigator.clipboard?.writeText(txt).then(
          () => this.showToast(`已复制读数：${txt}`, 'info'),
          () => this.showToast(`读数：${txt}`, 'info')
        );
      }
    });

    document.addEventListener('mousedown', (e) => {
      const menu = document.getElementById('scopeContextMenu');
      if (menu && !menu.classList.contains('hidden') && !(e.target as HTMLElement)?.closest('#scopeContextMenu')) {
        this.hideScopeContextMenu();
      }
    });

    window.addEventListener('resize', () => this.handleResize());

    this.canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
    this.canvas.addEventListener('mouseleave', () => this.setYAxisGestureHintVisible(false));
    this.canvas.addEventListener('dblclick', (e) => {
      const tab = this.getActiveTab();
      if (tab && tab.plotMode === 'time') {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const p = this.getTabPlotArea(tab, rect.width, rect.height, false);
        if (x >= 0 && x < p.x && y >= p.y && y <= p.y + p.height) {
          const hit = this.findSubplotAtPoint(tab, p, y);
          const targetCh = tab.separateView && hit ? hit.channel : tab.channels[tab.activeChannelId || ''] || hit?.channel;
          if (targetCh) {
            this.zeroChannelOffset(targetCh.id);
            this.showToast(`已归零垂直偏移（${targetCh.name} = 0 ${targetCh.unit}）`, 'info', { undoable: true });
            return;
          }
        }
      }
      this.fitView();
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => this.handleMouseMove(e));
    window.addEventListener('mouseup', () => this.handleMouseUp());
    this.canvas.addEventListener('wheel', (e) => this.handleWheel(e), { passive: false });

    // Clipboard CSV Paste (Scope workspace only)
    window.addEventListener('paste', (e: ClipboardEvent) => {
      if ((document.body.dataset.workspace || 'scope') !== 'scope') return;
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) {
        return;
      }
      const text = e.clipboardData?.getData('text/plain');
      if (text && text.trim().length > 0 && (text.includes(',') || text.includes('\t') || text.includes(';'))) {
        e.preventDefault();
        this.showCsvImportModal(text, `clipboard_${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.csv`);
      }
    });

    // Drag and Drop files (Workspace isolated)
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      if ((document.body.dataset.workspace || 'scope') !== 'scope') return;
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
      if ((document.body.dataset.workspace || 'scope') !== 'scope') {
        if (e.dataTransfer && e.dataTransfer.files.length > 0) {
          this.showToast('当前位于 FOC 测功台，请使用页内导入按钮，或切换到「示波器」后拖入波形文件。', 'warn');
        }
        return;
      }
      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        this.handleFiles(Array.from(e.dataTransfer.files));
      }
    });

    // Keyboard Shortcuts (Workspace isolated + Deterministic Esc Priority)
    window.addEventListener('keydown', (e) => {
      if ((document.body.dataset.workspace || 'scope') !== 'scope') return;

      const key = e.key.toUpperCase();
      const activeEl = document.activeElement;
      const isTypingInInput = Boolean(
        activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'SELECT' || activeEl.tagName === 'TEXTAREA')
      );

      // Screenshot hotkey (Ctrl+S / Cmd+S / F12)
      if (((e.ctrlKey || e.metaKey) && key === 'S') || e.key === 'F12') {
        e.preventDefault();
        this.exportPNG();
        return;
      }

      // Undo / Redo hotkeys (do not hijack text editing inside inputs)
      if (!isTypingInInput && (e.ctrlKey || e.metaKey) && !e.shiftKey && key === 'Z') {
        e.preventDefault();
        this.undo();
        return;
      }
      if (!isTypingInInput && (e.ctrlKey || e.metaKey) && (key === 'Y' || (e.shiftKey && key === 'Z'))) {
        e.preventDefault();
        this.redo();
        return;
      }

      // Deterministic Esc Priority Chain:
      // 1. Canvas context menu -> 2. Import modals -> 3. Active drawing/zoom tool -> 4. Docked drawer -> 5. Topmost visible modal -> 6. Fit view
      if (key === 'ESCAPE') {
        const ctxMenu = document.getElementById('scopeContextMenu');
        if (ctxMenu && !ctxMenu.classList.contains('hidden')) {
          this.hideScopeContextMenu();
          return;
        }
        if (excelImportModal.isOpen()) {
          excelImportModal.closeAndRelease(true);
          return;
        }
        const csvModal = document.getElementById('csvQualityModal');
        if (csvModal && csvModal.style.display === 'flex') {
          this.clearPendingCsvImport();
          csvModal.style.display = 'none';
          return;
        }
        const curTab = this.getActiveTab();
        if (curTab?.activeTool && curTab.activeTool !== 'pan') {
          this.setActiveTool('pan');
          return;
        }
        if (closeActiveToolDrawerItem()) return;

        // Close topmost visible non-docked floating modal by z-index
        const visibleModals = Array.from(document.querySelectorAll('.modal-overlay')).filter((node) => {
          const el = node as HTMLElement;
          if (el.closest('#toolDrawerBody')) return false;
          return el.style.display === 'flex';
        }) as HTMLElement[];
        if (visibleModals.length > 0) {
          visibleModals.sort((a, b) => {
            const za = parseInt(getComputedStyle(a).zIndex || '0', 10) || 0;
            const zb = parseInt(getComputedStyle(b).zIndex || '0', 10) || 0;
            return zb - za;
          });
          visibleModals[0].style.display = 'none';
          return;
        }

        if (!isTypingInInput && curTab) {
          this.fitView();
        }
        return;
      }

      if (isTypingInInput) return;

      // '?' opens shortcuts cheat-sheet even without a loaded tab
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        const modal = document.getElementById('shortcutsModal');
        if (modal) modal.style.display = 'flex';
        return;
      }

      const tab = this.getActiveTab();
      if (!tab) return;

      // 1-8 numeric quick channel switch
      if (/^[1-8]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const chIdx = parseInt(e.key, 10) - 1;
        if (tab.drawOrder[chIdx]) {
          this.selectActiveChannel(tab.drawOrder[chIdx]);
        }
        return;
      }

      if (e.key === '[' || e.key === ']') {
        const selectable = tab.drawOrder.filter((id) => tab.channels[id] && tab.channels[id].compareRole !== 'ref');
        if (selectable.length > 1) {
          const curIdx = Math.max(0, selectable.indexOf(tab.activeChannelId || selectable[0]));
          const delta = e.key === ']' ? 1 : -1;
          const nextIdx = (curIdx + delta + selectable.length) % selectable.length;
          this.selectActiveChannel(selectable[nextIdx]);
        }
        return;
      }

      if (key === 'U') {
        this.syncSameUnitScales();
      } else if (key === 'A') {
        this.executeAutoSet();
      } else if (key === 'F') {
        this.fitView();
      } else if (key === 'Z') {
        this.setActiveTool('areaZoom');
      } else if (key === 'T') {
        const cur = resolveCursorMode(tab);
        this.setCursorMode(cur === 'off' ? 'xy' : 'off');
      } else if (key === 'C' && !e.ctrlKey && !e.metaKey) {
        const modes: CursorMode[] = ['off', 'x', 'y', 'xy', 'track'];
        const cur = resolveCursorMode(tab);
        const nextMode = modes[(modes.indexOf(cur) + 1) % modes.length];
        this.setCursorMode(nextMode);
      } else if (key === 'M' && !e.ctrlKey && !e.metaKey) {
        document.getElementById('openMeasureModalBtn')?.click();
      } else if (key === 'H' && !e.ctrlKey && !e.metaKey) {
        const chId = tab.activeChannelId || tab.drawOrder[0];
        if (chId) this.toggleChannelVisible(chId);
      } else if (key === 'O') {
        this.setSeparateView(false);
      } else if (key === 'S' && !e.ctrlKey && !e.metaKey) {
        this.setSeparateView(true);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.panTimebase(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.panTimebase(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const chId = tab.activeChannelId || tab.drawOrder[0];
        if (chId) {
          if (e.shiftKey) this.nudgeChannelOffsetDivs(chId, 0.5);
          else this.stepChannelScale(chId, -1);
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const chId = tab.activeChannelId || tab.drawOrder[0];
        if (chId) {
          if (e.shiftKey) this.nudgeChannelOffsetDivs(chId, -0.5);
          else this.stepChannelScale(chId, 1);
        }
      } else if (e.key === '+' || e.key === '=') {
        this.stepTimebase(-1);
      } else if (e.key === '-' || e.key === '_') {
        this.stepTimebase(1);
      }
    });
  }

  public handleResize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;

    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;

    this.ctx.resetTransform();
    this.ctx.scale(dpr, dpr);
    this.draw();
  }

  private findSubplotAtPoint(tab: TabState, p: PlotArea, y: number): { channel: WaveformChannel; area: PlotArea } | null {
    const visibleChs = tab.drawOrder.map((id) => tab.channels[id]).filter((c) => c && c.visible);
    if (visibleChs.length === 0) return null;
    if (!tab.separateView || visibleChs.length === 1) {
      const activeCh = tab.channels[tab.activeChannelId || ''] || visibleChs[0];
      return { channel: activeCh, area: p };
    }
    const rects = getSubplotRects(p, visibleChs, true);
    for (const r of rects) {
      if (y >= r.area.y && y <= r.area.y + r.area.height) {
        return { channel: r.channel, area: r.area };
      }
    }
    return { channel: rects[0].channel, area: rects[0].area };
  }

  private handleMouseDown(e: MouseEvent): void {
    this.hideScopeContextMenu();
    const tab = this.getActiveTab();
    if (!tab) return;

    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const p = this.getTabPlotArea(tab, rect.width, rect.height, false);

    // 1. Check Left GND Handles (interactive vertical offset drag — push undo only after >2px movement)
    const gndHandles = getGndHandlePositions(p, tab);
    for (let i = gndHandles.length - 1; i >= 0; i--) {
      const h = gndHandles[i];
      if (x >= h.x - 20 && x <= h.x + 6 && Math.abs(y - h.y) <= 9) {
        this.selectActiveChannel(h.channelId);
        this.dragState = { type: 'gnd', channelId: h.channelId, area: h.area, startY: y, undoPushed: false };
        return;
      }
    }

    // 2b. Check Left Y-Axis Gutter for direct Vertical Offset dragging (push undo only after >2px movement)
    if (e.button === 0 && tab.plotMode === 'time' && x >= 0 && x < p.x && y >= p.y && y <= p.y + p.height) {
      const hit = this.findSubplotAtPoint(tab, p, y);
      const targetCh = tab.separateView && hit ? hit.channel : tab.channels[tab.activeChannelId || ''] || hit?.channel;
      if (targetCh) {
        const area = hit ? hit.area : p;
        const { voltsPerDiv, vOffset } = ensureChannelScaleOffset(targetCh);
        if (tab.separateView && targetCh.id !== tab.activeChannelId) {
          this.selectActiveChannel(targetCh.id);
        }
        this.dragState = {
          type: 'yAxisOffset',
          channelId: targetCh.id,
          startY: y,
          initialVOffset: vOffset,
          voltsPerDiv,
          area,
          undoPushed: false,
        };
        return;
      }
    }

    if (x < p.x || x > p.x + p.width || y < p.y || y > p.y + p.height) return;

    // Right-click (<4px) opens context menu; Right-drag (>=4px) triggers Box Zoom
    if (e.button === 2) {
      this.dragState = {
        type: 'areaZoom',
        start: { x, y },
        end: { x, y },
        isRightButton: true,
        clientX: e.clientX,
        clientY: e.clientY,
      };
      return;
    }

    if (e.button !== 0) return;

    // 3. Check Cursors X & Y
    const curMode = resolveCursorMode(tab);
    if (curMode !== 'off' && tab.plotMode === 'time') {
      const targetId = tab.cursors.trackingChannel || tab.activeChannelId || tab.drawOrder[0];
      const targetCh = tab.channels[targetId] || tab.channels[tab.drawOrder[0]];
      const targetArea = targetCh ? getChannelPlotArea(tab, targetCh.id, p) : p;

      if ((curMode === 'x' || curMode === 'xy' || curMode === 'track') && targetCh) {
        const { tStart, tSpan } = getTimeBoundsForView(tab, targetCh);
        if (tSpan > 0 && tab.cursors.x1 !== null && tab.cursors.x2 !== null) {
          const x1Px = p.x + ((tab.cursors.x1 - tStart) / tSpan) * p.width;
          const x2Px = p.x + ((tab.cursors.x2 - tStart) / tSpan) * p.width;
          if (Math.abs(x - x1Px) < 9) {
            this.dragState = { type: 'cursorX', which: 'x1' };
            return;
          }
          if (Math.abs(x - x2Px) < 9) {
            this.dragState = { type: 'cursorX', which: 'x2' };
            return;
          }
        }
      }

      if ((curMode === 'y' || curMode === 'xy') && targetCh) {
        const vSpan = targetCh.vMax - targetCh.vMin;
        if (vSpan > 0 && tab.cursors.y1 !== null && tab.cursors.y2 !== null && y >= targetArea.y && y <= targetArea.y + targetArea.height) {
          const y1Px = targetArea.y + targetArea.height - ((tab.cursors.y1 - targetCh.vMin) / vSpan) * targetArea.height;
          const y2Px = targetArea.y + targetArea.height - ((tab.cursors.y2 - targetCh.vMin) / vSpan) * targetArea.height;
          if (Math.abs(y - y1Px) < 9) {
            this.dragState = { type: 'cursorY', which: 'y1', channelId: targetCh.id, area: targetArea };
            return;
          }
          if (Math.abs(y - y2Px) < 9) {
            this.dragState = { type: 'cursorY', which: 'y2', channelId: targetCh.id, area: targetArea };
            return;
          }
        }
      }
    }

    // 4. Annotation Tools
    const subHit = this.findSubplotAtPoint(tab, p, y);
    if (tab.plotMode === 'time' && subHit) {
      if (tab.activeTool === 'pointAnnotate') {
        const dataPt = screenToData({ x, y }, tab, subHit.channel.id, subHit.area);
        const sampledV = sampleChannelValueAtTime(subHit.channel, dataPt.time);
        tab.annotations.push({
          id: `ann_${Date.now()}`,
          type: 'point',
          x: dataPt.time,
          y: sampledV !== null ? sampledV : dataPt.voltage,
          channelId: subHit.channel.id,
          color: subHit.channel.color,
        });
        tab.annotationsVisible = true;
        this.draw();
        return;
      }

      if (tab.activeTool === 'textAnnotate') {
        const dataPt = screenToData({ x, y }, tab, subHit.channel.id, subHit.area);
        const sampledV = sampleChannelValueAtTime(subHit.channel, dataPt.time);
        this.pendingAnnotationCoord = {
          time: dataPt.time,
          voltage: sampledV !== null ? sampledV : dataPt.voltage,
          channelId: subHit.channel.id,
        };
        const modal = document.getElementById('textAnnotationModal');
        const input = document.getElementById('textAnnInput') as HTMLInputElement;
        if (modal && input) {
          input.value = '';
          modal.style.display = 'flex';
          setTimeout(() => input.focus(), 30);
        }
        return;
      }

      if (tab.activeTool === 'areaAnnotate') {
        this.dragState = {
          type: 'areaAnnotate',
          channelId: subHit.channel.id,
          area: subHit.area,
          start: { x, y },
          end: { x, y },
        };
        return;
      }
    }

    // 5. In Separate Mode, clicking inside a subplot activates that channel
    if (tab.separateView && subHit && subHit.channel.id !== tab.activeChannelId) {
      this.selectActiveChannel(subHit.channel.id);
    }

    // 5b. Alt + Drag inside time-domain plot shifts active channel's Δt directly
    if (e.altKey && tab.plotMode === 'time') {
      const shiftTargetCh =
        tab.separateView && subHit
          ? subHit.channel
          : tab.channels[tab.activeChannelId || ''] || subHit?.channel;
      if (shiftTargetCh) {
        const { tSpan } = getTimeBoundsForView(tab, shiftTargetCh);
        if (tSpan > 0) {
          this.dragState = {
            type: 'timeShift',
            channelId: shiftTargetCh.id,
            startX: x,
            initialTimeShiftSec: shiftTargetCh.timeShiftSec || 0,
            tSpan,
            undoPushed: false,
          };
          return;
        }
      }
    }

    // 6. Area Zoom or Pan
    if (e.shiftKey || tab.activeTool === 'areaZoom') {
      this.dragState = {
        type: 'areaZoom',
        start: { x, y },
        end: { x, y },
      };
    } else {
      const targetFftCh = tab.channels[tab.selectedFftChannelId || tab.drawOrder[0]];
      const nyquist = (targetFftCh?.fs || 1e5) / 2;
      const panTargetCh =
        tab.separateView && subHit
          ? subHit.channel
          : tab.channels[tab.activeChannelId || ''] || subHit?.channel;
      const panScale = panTargetCh ? ensureChannelScaleOffset(panTargetCh) : null;
      this.dragState = {
        type: 'pan',
        startX: x,
        startY: y,
        initialStartIdx: tab.view.startIndex,
        initialEndIdx: tab.view.endIndex,
        initialFMin: tab.view.fMin ?? 0,
        initialFMax: tab.view.fMax ?? nyquist,
        targetChannelId: panTargetCh?.id,
        initialVOffset: panScale?.vOffset ?? 0,
        voltsPerDiv: panScale?.voltsPerDiv ?? 1,
        area: subHit?.area || p,
        undoPushed: false,
      };
    }
  }

  private handleMouseMove(e: MouseEvent): void {
    const tab = this.getActiveTab();
    if (!tab) return;

    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const p = this.getTabPlotArea(tab, rect.width, rect.height, false);

    if (this.dragState) {
      this.setYAxisGestureHintVisible(false);

      if (this.dragState.type === 'gnd') {
        const ch = tab.channels[this.dragState.channelId];
        if (ch && (this.dragState.undoPushed || Math.abs(y - this.dragState.startY) > 2)) {
          if (!this.dragState.undoPushed) {
            this.pushUndoSnapshot(`拖动 GND 偏移 (${ch.name})`);
            this.dragState.undoPushed = true;
          }
          const { voltsPerDiv } = ensureChannelScaleOffset(ch);
          const { area } = this.dragState;
          const fracFromBottom = Math.max(-0.25, Math.min(1.25, (area.y + area.height - y) / area.height));
          ch.vOffset = (fracFromBottom - 0.5) * (8 * voltsPerDiv);
          syncChannelBoundsFromScaleOffset(ch);
          clampCursorsToViewport(tab);
          this.syncVerticalPanelOnly(ch);
          this.renderSoftkeysOnly(tab);
          this.renderCursorReadoutOnly(tab);
          this.scheduleDraw();
        }
        return;
      }

      if (this.dragState.type === 'yAxisOffset') {
        const ch = tab.channels[this.dragState.channelId];
        if (ch && (this.dragState.undoPushed || Math.abs(y - this.dragState.startY) > 2)) {
          if (!this.dragState.undoPushed) {
            this.pushUndoSnapshot(`拖动 Y 轴偏移 (${ch.name})`);
            this.dragState.undoPushed = true;
          }
          const { area, startY, initialVOffset, voltsPerDiv } = this.dragState;
          const deltaV = ((startY - y) / Math.max(1, area.height)) * (8 * voltsPerDiv);
          ch.vOffset = initialVOffset + deltaV;
          syncChannelBoundsFromScaleOffset(ch);
          clampCursorsToViewport(tab);
          this.syncVerticalPanelOnly(ch);
          this.renderSoftkeysOnly(tab);
          this.renderCursorReadoutOnly(tab);
          this.scheduleDraw();
        }
        return;
      }

      if (this.dragState.type === 'timeShift') {
        const ch = tab.channels[this.dragState.channelId];
        const dx = x - this.dragState.startX;
        if (ch && (this.dragState.undoPushed || Math.abs(dx) > 2)) {
          if (!this.dragState.undoPushed) {
            this.pushUndoSnapshot(`Alt+拖动 Δt 平移 (${ch.name})`, true);
            this.dragState.undoPushed = true;
          }
          const dt = (dx / Math.max(1, p.width)) * this.dragState.tSpan;
          const nextShift = this.dragState.initialTimeShiftSec + dt;
          applyChannelTimeShift(ch, nextShift);
          extendTabViewToLongestChannel(tab);
          clampCursorsToViewport(tab);
          this.editVersion++;
          this.cachedSpectrum = null;
          this.cachedSpectrumKey = '';
          this.syncVerticalPanelOnly(ch);
          this.renderSoftkeysOnly(tab);
          this.renderCursorReadoutOnly(tab);
          this.scheduleDraw();
        }
        return;
      }

      if (this.dragState.type === 'cursorX') {
        const primaryCh = tab.channels[tab.drawOrder[0]];
        const { tStart, tSpan } = getTimeBoundsForView(tab, primaryCh);
        const clampedX = Math.max(p.x, Math.min(p.x + p.width, x));
        const tCur = tStart + ((clampedX - p.x) / p.width) * tSpan;
        if (this.dragState.which === 'x1') tab.cursors.x1 = tCur;
        else tab.cursors.x2 = tCur;
        clampCursorsToViewport(tab);
        this.renderCursorReadoutOnly(tab);
        this.scheduleDraw();
        return;
      }

      if (this.dragState.type === 'cursorY') {
        const ch = tab.channels[this.dragState.channelId];
        if (ch) {
          const { area, which } = this.dragState;
          const clampedY = Math.max(area.y, Math.min(area.y + area.height, y));
          const frac = (area.y + area.height - clampedY) / area.height;
          const val = ch.vMin + frac * (ch.vMax - ch.vMin);
          if (which === 'y1') tab.cursors.y1 = val;
          else tab.cursors.y2 = val;
          clampCursorsToViewport(tab);
          this.renderCursorReadoutOnly(tab);
          this.scheduleDraw();
        }
        return;
      }

      if (this.dragState.type === 'areaZoom' || this.dragState.type === 'areaAnnotate') {
        this.dragState.end = { x, y };
        this.scheduleDraw();
        return;
      }

      if (this.dragState.type === 'pan') {
        const dx = x - this.dragState.startX;
        if (tab.plotMode === 'frequency') {
          const targetCh = tab.channels[tab.selectedFftChannelId || tab.drawOrder[0]];
          const nyquist = (targetCh?.fs || 1e5) / 2;
          const fSpan = this.dragState.initialFMax - this.dragState.initialFMin;
          const df = -(dx / p.width) * fSpan;
          let newFMin = this.dragState.initialFMin + df;
          let newFMax = this.dragState.initialFMax + df;
          if (newFMin < 0) {
            newFMin = 0;
            newFMax = fSpan;
          } else if (newFMax > nyquist) {
            newFMax = nyquist;
            newFMin = Math.max(0, nyquist - fSpan);
          }
          tab.view.fMin = newFMin;
          tab.view.fMax = newFMax;
          this.scheduleDraw();
          return;
        }

        const viewSpan = this.dragState.initialEndIdx - this.dragState.initialStartIdx;
        const shiftPoints = Math.round((dx / p.width) * viewSpan);
        const bounds = getTabGlobalIndexBounds(tab);

        let newStart = this.dragState.initialStartIdx - shiftPoints;
        let newEnd = this.dragState.initialEndIdx - shiftPoints;

        if (newStart < bounds.minIdx) {
          newStart = bounds.minIdx;
          newEnd = bounds.minIdx + viewSpan;
        } else if (newEnd > bounds.maxIdx) {
          newEnd = bounds.maxIdx;
          newStart = Math.max(bounds.minIdx, bounds.maxIdx - viewSpan);
        }

        tab.view.startIndex = Math.max(bounds.minIdx, newStart);
        tab.view.endIndex = Math.min(bounds.maxIdx, newEnd);

        if (tab.plotMode === 'time' && this.dragState.targetChannelId && Math.abs(y - this.dragState.startY) > 1.5) {
          const ch = tab.channels[this.dragState.targetChannelId];
          if (ch) {
            if (!this.dragState.undoPushed) {
              this.pushUndoSnapshot('画布平移');
              this.dragState.undoPushed = true;
            }
            const area = this.dragState.area || p;
            const vPerDiv = this.dragState.voltsPerDiv || 1;
            const deltaV = ((this.dragState.startY - y) / Math.max(1, area.height)) * (8 * vPerDiv);
            ch.vOffset = (this.dragState.initialVOffset ?? 0) + deltaV;
            syncChannelBoundsFromScaleOffset(ch);
            this.syncVerticalPanelOnly(ch);
            this.renderSoftkeysOnly(tab);
          }
        }

        clampCursorsToViewport(tab);
        this.renderCursorReadoutOnly(tab);
        this.scheduleDraw();
        return;
      }
    }

    // Dynamic hover cursor icon & readout (when mouse is inside canvas)
    if (x >= 0 && x <= rect.width && y >= 0 && y <= rect.height) {
      let nextCursor = 'crosshair';
      const inYAxisGutter = tab.plotMode === 'time' && x >= 0 && x < p.x && y >= p.y && y <= p.y + p.height;
      this.setYAxisGestureHintVisible(inYAxisGutter);

      const gndHandles = getGndHandlePositions(p, tab);
      for (const h of gndHandles) {
        if (x >= h.x - 20 && x <= h.x + 6 && Math.abs(y - h.y) <= 9) {
          nextCursor = 'ns-resize';
          break;
        }
      }

      if (nextCursor === 'crosshair' && inYAxisGutter) {
        nextCursor = 'ns-resize';
      }

      if (nextCursor === 'crosshair' && tab.plotMode === 'time') {
        const curMode = resolveCursorMode(tab);
        if (curMode !== 'off') {
          const targetId = tab.cursors.trackingChannel || tab.activeChannelId || tab.drawOrder[0];
          const targetCh = tab.channels[targetId] || tab.channels[tab.drawOrder[0]];
          if (targetCh) {
            const { tStart, tSpan } = getTimeBoundsForView(tab, targetCh);
            if ((curMode === 'x' || curMode === 'xy' || curMode === 'track') && tSpan > 0 && tab.cursors.x1 !== null && tab.cursors.x2 !== null) {
              const x1Px = p.x + ((tab.cursors.x1 - tStart) / tSpan) * p.width;
              const x2Px = p.x + ((tab.cursors.x2 - tStart) / tSpan) * p.width;
              if (Math.abs(x - x1Px) < 9 || Math.abs(x - x2Px) < 9) nextCursor = 'ew-resize';
            }
            if (nextCursor === 'crosshair' && (curMode === 'y' || curMode === 'xy')) {
              const targetArea = getChannelPlotArea(tab, targetCh.id, p);
              const vSpan = targetCh.vMax - targetCh.vMin;
              if (vSpan > 0 && tab.cursors.y1 !== null && tab.cursors.y2 !== null && y >= targetArea.y && y <= targetArea.y + targetArea.height) {
                const y1Px = targetArea.y + targetArea.height - ((tab.cursors.y1 - targetCh.vMin) / vSpan) * targetArea.height;
                const y2Px = targetArea.y + targetArea.height - ((tab.cursors.y2 - targetCh.vMin) / vSpan) * targetArea.height;
                if (Math.abs(y - y1Px) < 9 || Math.abs(y - y2Px) < 9) nextCursor = 'ns-resize';
              }
            }
          }
        }
      }

      if (nextCursor === 'crosshair' && e.altKey && tab.plotMode === 'time') {
        nextCursor = 'ew-resize';
      }

      this.canvas.style.cursor = nextCursor;

      // Update Hover Readout (matching hovered subplot in Separate mode, or frequency in FFT mode)
      if (x >= p.x && x <= p.x + p.width && y >= p.y && y <= p.y + p.height) {
        if (tab.plotMode === 'frequency') {
          const targetCh = tab.channels[tab.selectedFftChannelId || tab.drawOrder[0]];
          const nyquist = (targetCh?.fs || 1e5) / 2;
          const minF = Math.max(0, tab.view.fMin ?? 0);
          const maxF = Math.min(nyquist, tab.view.fMax ?? nyquist);
          const f = minF + ((x - p.x) / p.width) * (maxF - minF);
          const yMin =
            tab.fftOptions.scale === 'magnitude'
              ? this.cachedSpectrum?.magYMin ?? 0
              : this.cachedSpectrum?.dbYMin ?? this.cachedSpectrum?.yMin ?? -120;
          const yMax =
            tab.fftOptions.scale === 'magnitude'
              ? this.cachedSpectrum?.magYMax ?? 1
              : this.cachedSpectrum?.dbYMax ?? this.cachedSpectrum?.yMax ?? 20;
          const amp = yMin + ((p.y + p.height - y) / p.height) * (yMax - yMin);
          const el = document.getElementById('hoverInfoReadout');
          if (el) {
            el.innerText =
              tab.fftOptions.scale === 'db'
                ? `f = ${formatEng(f, 'Hz', 2)}   Amp = ${amp.toFixed(1)} dB`
                : `f = ${formatEng(f, 'Hz', 2)}   Mag = ${formatEng(amp, targetCh?.unit || 'V', 3)}`;
          }
        } else {
          const hit = this.findSubplotAtPoint(tab, p, y);
          if (hit) {
            const dataPt = screenToData({ x, y }, tab, hit.channel.id, hit.area);
            const el = document.getElementById('hoverInfoReadout');
            if (el) {
              const chColor = resolveChannelTextColor(hit.channel.color, Boolean(this.theme.isLight));
              el.innerHTML = `<span style="color:${chColor};font-weight:600">${escapeHtml(hit.channel.name)}</span> · T = ${escapeHtml(formatEng(dataPt.time, 's', 4))} · <span style="color:${chColor};font-weight:600">V = ${escapeHtml(formatEng(dataPt.voltage, hit.channel.unit, 3))}</span>`;
            }
          }
        }
      }
    } else {
      this.setYAxisGestureHintVisible(false);
    }
  }

  private handleMouseUp(): void {
    const tab = this.getActiveTab();
    if (!this.dragState) return;

    const currentDrag = this.dragState;
    this.dragState = null;

    if (!tab) return;

    const dpr = window.devicePixelRatio || 1;
    const p = this.getTabPlotArea(tab, this.canvas.width / dpr, this.canvas.height / dpr, false);

    if (currentDrag.type === 'areaZoom') {
      const dist = Math.hypot(currentDrag.end.x - currentDrag.start.x, currentDrag.end.y - currentDrag.start.y);
      if (currentDrag.isRightButton && dist < 4 && currentDrag.clientX !== undefined && currentDrag.clientY !== undefined) {
        this.openScopeContextMenu(currentDrag.clientX, currentDrag.clientY, currentDrag.start.x, currentDrag.start.y);
        this.draw();
        return;
      }

      const x1 = Math.min(currentDrag.start.x, currentDrag.end.x);
      const x2 = Math.max(currentDrag.start.x, currentDrag.end.x);
      if (x2 - x1 > 6) {
        if (tab.plotMode === 'frequency') {
          const targetCh = tab.channels[tab.selectedFftChannelId || tab.drawOrder[0]];
          const nyquist = (targetCh?.fs || 1e5) / 2;
          const minF = Math.max(0, tab.view.fMin ?? 0);
          const maxF = Math.min(nyquist, tab.view.fMax ?? nyquist);
          const span = maxF - minF;
          const frac1 = Math.max(0, (x1 - p.x) / p.width);
          const frac2 = Math.min(1, (x2 - p.x) / p.width);
          tab.view.fMin = minF + frac1 * span;
          tab.view.fMax = minF + frac2 * span;
        } else {
          const viewSpan = tab.view.endIndex - tab.view.startIndex;
          const fracStart = Math.max(0, (x1 - p.x) / p.width);
          const fracEnd = Math.min(1, (x2 - p.x) / p.width);
          const newStart = Math.floor(tab.view.startIndex + fracStart * viewSpan);
          const newEnd = Math.ceil(tab.view.startIndex + fracEnd * viewSpan);
          if (newEnd - newStart >= 2) {
            tab.view.startIndex = newStart;
            tab.view.endIndex = newEnd;
            clampCursorsToViewport(tab);
          }
        }
      }
      tab.activeTool = 'pan';
      this.renderSidebar();
      this.draw();
      return;
    }

    if (currentDrag.type === 'areaAnnotate') {
      const { start, end, channelId, area } = currentDrag;
      if (Math.abs(end.x - start.x) > 8 && Math.abs(end.y - start.y) > 8) {
        const d1 = screenToData(start, tab, channelId, area);
        const d2 = screenToData(end, tab, channelId, area);
        tab.annotations.push({
          id: `ann_${Date.now()}`,
          type: 'area',
          x: d1.time,
          y: d1.voltage,
          x2: d2.time,
          y2: d2.voltage,
          channelId,
        });
        tab.annotationsVisible = true;
      }
      tab.activeTool = 'pan';
      this.renderSidebar();
      this.draw();
      return;
    }

    this.renderSidebar();
  }

  private handleWheel(e: WheelEvent): void {
    e.preventDefault();
    const tab = this.getActiveTab();
    if (!tab) return;

    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const p = this.getTabPlotArea(tab, rect.width, rect.height, false);

    // Wheel on Left Y-Axis gutter OR Shift+Wheel OR Alt+Wheel -> 1-2-5 Vertical V/div step
    if (tab.plotMode === 'time' && (x < p.x || e.shiftKey || e.altKey)) {
      const hit = this.findSubplotAtPoint(tab, p, y);
      const targetId = tab.separateView && hit ? hit.channel.id : tab.activeChannelId || tab.drawOrder[0];
      if (targetId && tab.channels[targetId]) {
        const dir: 1 | -1 = e.deltaY < 0 ? -1 : 1; // Scroll up = finer V/div (zoom in vertically)
        this.stepChannelScale(targetId, dir);
      }
      return;
    }

    if (x < p.x || x > p.x + p.width) return;

    // Frequency domain horizontal zoom
    if (tab.plotMode === 'frequency') {
      const targetCh = tab.channels[tab.selectedFftChannelId || tab.drawOrder[0]];
      const nyquist = (targetCh?.fs || 1e5) / 2;
      const minF = Math.max(0, tab.view.fMin ?? 0);
      const maxF = Math.min(nyquist, tab.view.fMax ?? nyquist);
      const fSpan = Math.max(10, maxF - minF);
      const mouseFrac = (x - p.x) / p.width;
      const mouseFreq = minF + mouseFrac * fSpan;
      const factor = e.deltaY < 0 ? 0.78 : 1.28;
      const nextSpan = Math.min(nyquist, Math.max(20, fSpan * factor));
      let nMin = mouseFreq - mouseFrac * nextSpan;
      let nMax = nMin + nextSpan;
      if (nMin < 0) {
        nMin = 0;
        nMax = Math.min(nyquist, nextSpan);
      }
      if (nMax > nyquist) {
        nMax = nyquist;
        nMin = Math.max(0, nyquist - nextSpan);
      }
      tab.view.fMin = nMin;
      tab.view.fMax = nMax;
      this.draw();
      return;
    }

    // Time domain horizontal zoom anchored at mouse
    const zoomFactor = e.deltaY < 0 ? 0.8 : 1.25;
    const viewSpan = tab.view.endIndex - tab.view.startIndex;
    const mouseFrac = (x - p.x) / p.width;
    const mouseIdx = tab.view.startIndex + mouseFrac * viewSpan;

    const bounds = getTabGlobalIndexBounds(tab);
    const totalSpanBounds = Math.max(2, bounds.maxIdx - bounds.minIdx);
    const minSpan = Math.min(totalSpanBounds, 2);
    const newSpan = Math.max(minSpan, Math.min(totalSpanBounds, Math.round(viewSpan * zoomFactor)));

    let newStart = Math.round(mouseIdx - mouseFrac * newSpan);
    let newEnd = newStart + newSpan;

    if (newStart < bounds.minIdx) {
      newStart = bounds.minIdx;
      newEnd = Math.min(bounds.maxIdx, bounds.minIdx + newSpan);
    }
    if (newEnd > bounds.maxIdx) {
      newEnd = bounds.maxIdx;
      newStart = Math.max(bounds.minIdx, bounds.maxIdx - newSpan);
    }

    tab.view.startIndex = newStart;
    tab.view.endIndex = newEnd;
    clampCursorsToViewport(tab);
    this.draw();
    this.renderSidebar();
  }

  public fitView(): void {
    const tab = this.getActiveTab();
    if (!tab) return;

    if (tab.plotMode === 'frequency') {
      const targetCh = tab.channels[tab.selectedFftChannelId || tab.drawOrder[0]];
      const nyquist = (targetCh?.fs || 1e5) / 2;
      tab.view.fMin = 0;
      tab.view.fMax = nyquist;
      this.draw();
      return;
    }

    const primaryCh = tab.channels[tab.drawOrder[0]];
    if (!primaryCh) return;

    this.pushUndoSnapshot('Fit View');
    const bounds = getTabGlobalIndexBounds(tab);
    tab.view.startIndex = bounds.minIdx;
    tab.view.endIndex = bounds.maxIdx;

    for (const id of tab.drawOrder) {
      const ch = tab.channels[id];
      if (ch && ch.visible) {
        fitChannelTo125(ch);
      }
    }

    clampCursorsToViewport(tab);
    this.renderSidebar();
    this.draw();
  }

  private markRawChannelsAndFit(channels: Record<string, WaveformChannel>): void {
    for (const ch of Object.values(channels)) {
      ch.channelKind = 'raw';
      fitChannelTo125(ch);
    }
  }

  public async openFileDirectInTab(file: File): Promise<string | null> {
    const ext = file.name.split('.').pop()?.toLowerCase();
    const colors = this.getRawColors();

    if (isExcelFileName(file.name)) {
      let session: Awaited<ReturnType<typeof openExcelWorkbookSession>> | null = null;
      try {
        session = await openExcelWorkbookSession(file);
        const sel = session.sheets.filter((s) => s.selected);
        if (sel.length === 0) return null;
        const parsed = parseExcelSheetToChannels(session, sel[0].sheetIndex, {
          resample: !!(sel[0].quality && !sel[0].quality.isUniformSampling),
          colors,
        });
        this.markRawChannelsAndFit(parsed.channels);
        const totalPoints = Object.values(parsed.channels)[0]?.v.length || 1000;
        const tabId = `tab_${Date.now()}_${Math.random()}`;
        this.addTab({
          id: tabId,
          fileName: sel.length > 1 || session.sheets.length > 1 ? `${file.name} [${parsed.sheetName}]` : file.name,
          fileFingerprint: `${session.fingerprint}::${parsed.sheetName}`,
          channels: parsed.channels,
          drawOrder: parsed.drawOrder,
          view: { startIndex: 0, endIndex: totalPoints },
          cursors: { enabled: false, mode: 'off', x1: null, x2: null, y1: null, y2: null, trackingChannel: parsed.drawOrder[0] || null },
          annotations: [],
          annotationMode: false,
          annotationsVisible: true,
          isOverlap: false,
          plotMode: 'time',
          fftOptions: { range: 'view', window: 'hann', scale: 'db', zeroPadding: 1, removeDC: true },
          motorConfig: { rpm: null, polePairs: null, enabled: false },
          triggerConfig: { enabled: false, channelId: parsed.drawOrder[0], type: 'rising', level: 0, positionPercent: 50 },
          measurementGate: 'view',
          separateView: false,
          activeChannelId: parsed.drawOrder[0],
          activeTool: 'pan',
        });
        return tabId;
      } finally {
        releaseExcelWorkbookSession(session);
      }
    }

    if (ext === 'wfm' || ext === 'raw') {
      const buf = await file.arrayBuffer();
      const fileFingerprint = computeBufferFingerprint(file.name, buf);
      const parsed =
        ext === 'raw'
          ? parseLtspiceRawBuffer(buf, colors)
          : parseWfmBuffer(buf, file.name, colors);
      this.markRawChannelsAndFit(parsed.channels);
      const totalPoints = Object.values(parsed.channels)[0]?.v.length || 1000;
      const tabId = `tab_${Date.now()}_${Math.random()}`;
      this.addTab({
        id: tabId,
        fileName: file.name,
        fileFingerprint,
        channels: parsed.channels,
        drawOrder: parsed.drawOrder,
        view: { startIndex: 0, endIndex: totalPoints },
        cursors: { enabled: false, mode: 'off', x1: null, x2: null, y1: null, y2: null, trackingChannel: parsed.drawOrder[0] || null },
        annotations: [],
        annotationMode: false,
        annotationsVisible: true,
        isOverlap: false,
        plotMode: 'time',
        fftOptions: { range: 'view', window: 'hann', scale: 'db', zeroPadding: 1, removeDC: true },
        motorConfig: { rpm: null, polePairs: null, enabled: false },
        triggerConfig: { enabled: false, channelId: parsed.drawOrder[0], type: 'rising', level: 0, positionPercent: 50 },
        measurementGate: 'view',
        separateView: false,
        activeChannelId: parsed.drawOrder[0],
        activeTool: 'pan',
      });
      return tabId;
    }

    const text = await file.text();
    const fileFingerprint = computeTextFingerprint(file.name, text);
    let parsed: { channels: Record<string, WaveformChannel>; drawOrder: string[] };

    if (ext === 'txt' && isLtspiceExportText(text)) {
      parsed = parseLtspiceText(text, colors);
    } else {
      const p = previewCsv(text);
      const shouldResample = !!(p.quality && !p.quality.isUniformSampling);
      parsed = parseFullCsv(text, {
        delimiter: p.delimiter,
        hasHeader: p.hasHeader,
        skipLines: p.skipLines,
        timeColIndex: p.timeColIndex,
        timeUnit: p.timeUnit,
        sampleRateOverrideHz: p.sampleRateOverrideHz ?? null,
        columnMappings: p.columnMappings,
        resample: shouldResample,
        colors,
      });
    }

    this.markRawChannelsAndFit(parsed.channels);
    const totalPoints = Object.values(parsed.channels)[0]?.v.length || 1000;
    const tabId = `tab_${Date.now()}_${Math.random()}`;
    this.addTab({
      id: tabId,
      fileName: file.name,
      fileFingerprint,
      channels: parsed.channels,
      drawOrder: parsed.drawOrder,
      view: { startIndex: 0, endIndex: totalPoints },
      cursors: { enabled: false, mode: 'off', x1: null, x2: null, y1: null, y2: null, trackingChannel: parsed.drawOrder[0] || null },
      annotations: [],
      annotationMode: false,
      annotationsVisible: true,
      isOverlap: false,
      plotMode: 'time',
      fftOptions: { range: 'view', window: 'hann', scale: 'db', zeroPadding: 1, removeDC: true },
      motorConfig: { rpm: null, polePairs: null, enabled: false },
      triggerConfig: { enabled: false, channelId: parsed.drawOrder[0], type: 'rising', level: 0, positionPercent: 50 },
      measurementGate: 'view',
      separateView: false,
      activeChannelId: parsed.drawOrder[0],
      activeTool: 'pan',
    });
    return tabId;
  }

  public async reloadTabFromFile(tabId: string, file: File): Promise<boolean> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return false;

    try {
      const ext = file.name.split('.').pop()?.toLowerCase();
      const colors = this.getRawColors();
      let parsed: { channels: Record<string, WaveformChannel>; drawOrder: string[] };
      let fileFingerprint: string;

      if (ext === 'raw' || ext === 'wfm') {
        const buf = await file.arrayBuffer();
        fileFingerprint = computeBufferFingerprint(file.name, buf);
        parsed =
          ext === 'raw'
            ? parseLtspiceRawBuffer(buf, colors)
            : parseWfmBuffer(buf, file.name, colors);
      } else {
        const text = await file.text();
        fileFingerprint = computeTextFingerprint(file.name, text);
        if (ext === 'txt' && isLtspiceExportText(text)) {
          parsed = parseLtspiceText(text, colors);
        } else {
          const p = previewCsv(text);
          const shouldResample = !!(p.quality && !p.quality.isUniformSampling);
          parsed = parseFullCsv(text, {
            delimiter: p.delimiter,
            hasHeader: p.hasHeader,
            skipLines: p.skipLines,
            timeColIndex: p.timeColIndex,
            timeUnit: p.timeUnit,
            sampleRateOverrideHz: p.sampleRateOverrideHz ?? null,
            columnMappings: p.columnMappings,
            resample: shouldResample,
            colors,
          });
        }
      }

      if (parsed.drawOrder.length === 0) return false;

      // Match existing raw channels by name first, then positional fallback
      const existingRawIds = tab.drawOrder.filter((id) => {
        const c = tab.channels[id];
        return c && !isComputedChannel(c);
      });

      const oldLength = Object.values(tab.channels)[0]?.v.length || 0;
      const newLength = parsed.channels[parsed.drawOrder[0]]?.v.length || 0;

      parsed.drawOrder.forEach((newId, idx) => {
        const nextCh = parsed.channels[newId];
        if (!nextCh) return;
        nextCh.channelKind = 'raw';

        const matchedOldId =
          existingRawIds.find((oid) => tab.channels[oid]?.name === nextCh.name) ||
          existingRawIds[idx];
        const prevCh = matchedOldId ? tab.channels[matchedOldId] : undefined;

        if (prevCh) {
          prevCh.t = nextCh.t;
          prevCh.v = nextCh.v;
          prevCh.fs = nextCh.fs;
          prevCh.dt = nextCh.dt;
          prevCh.metadata = nextCh.metadata;
          prevCh.rawT = nextCh.rawT;
          prevCh.rawV = nextCh.rawV;
          prevCh.ltspiceStepLabel = nextCh.ltspiceStepLabel;
          prevCh.channelKind = 'raw';
          syncChannelBoundsFromScaleOffset(prevCh);
        } else {
          fitChannelTo125(nextCh);
          tab.channels[newId] = nextCh;
          tab.drawOrder.push(newId);
        }
      });

      // Recalculate any computed Math channels whose expression still applies
      for (const id of tab.drawOrder) {
        const ch = tab.channels[id];
        if (!ch || !ch.isMath || !ch.mathExpression || ch.compareGroupId) continue;
        if (ch.derivedKind === 'math') {
          try {
            const recalc = evaluateMathExpression(
              ch.mathExpression,
              tab.channels,
              tab.drawOrder,
              ch.id,
              ch.name
            );
            ch.t = recalc.t;
            ch.v = recalc.v;
            ch.fs = recalc.fs;
            ch.dt = recalc.dt;
            ch.metadata = recalc.metadata;
            syncChannelBoundsFromScaleOffset(ch);
          } catch {
            // Keep prior buffer if formula variables changed
          }
        }
      }

      if (newLength > 0) {
        const ratio = oldLength > 0 ? newLength / oldLength : 0;
        if (ratio < 0.5 || ratio > 2 || tab.view.endIndex > newLength) {
          tab.view.startIndex = 0;
          tab.view.endIndex = newLength;
        }
      }

      tab.fileName = file.name;
      tab.fileFingerprint = fileFingerprint;
      this.editVersion++;
      this.cachedSpectrum = null;
      this.cachedSpectrumKey = '';
      clampCursorsToViewport(tab);
      this.renderTabsBar();
      this.renderSidebar();
      this.draw();
      this.showToast(`已重载 LTspice 波形：${file.name}`, 'info');
      return true;
    } catch (err: any) {
      this.showToast(`重载失败（${file.name}）：${err.message}`, 'error');
      return false;
    }
  }

  private createTabFromExcelPayloads(
    items: ExcelImportedSheetPayload[],
    disposition: 'separate' | 'merge',
    timeAlignment: ExcelMergeTimeMode = 'auto-best'
  ): void {
    const colors = this.getRawColors();
    if (disposition === 'merge') {
      const merged = mergeExcelChannelsByTime(items, colors, timeAlignment);
      let mergedDrawOrder = merged.drawOrder;
      const mergedChannels = merged.channels;
      if (mergedDrawOrder.length === 0) return;
      if (timeAlignment === 'preserve' && !merged.canMergePreservingTime) {
        const reason = merged.warnings.join(' ');
        this.showToast(
          `未创建混合时间坐标的合并视图。请切换为「自动对应时间」或「首样本对齐」，否则请分别打开。${reason}`,
          'error'
        );
        return;
      }
      const viewport = resolveExcelMergedViewport(merged);
      if (!viewport) {
        this.showToast('无法为合并波形建立有效时间视窗：请检查各通道是否至少有两个严格递增的有效时间点。', 'error');
        return;
      }
      // Put the longest valid channel first when in auto-best / align-start, or viewport anchor otherwise
      const longestAudit = [...merged.audit]
        .filter((r) => r.sampleCount >= 2 && r.monotonic && r.durationSec > 0)
        .sort((a, b) => b.durationSec - a.durationSec)[0];
      const anchorId =
        timeAlignment === 'auto-best' && longestAudit ? longestAudit.id : viewport.primaryChannelId;
      mergedDrawOrder = [anchorId, ...mergedDrawOrder.filter((id) => id !== anchorId)];
      this.markRawChannelsAndFit(mergedChannels);
      const uniqueFiles = Array.from(new Set(items.map((it) => it.fileName)));
      const tabTitle =
        uniqueFiles.length === 1
          ? `${uniqueFiles[0]} (${items.length} sheets, 合并)`
          : `${uniqueFiles[0]} +${uniqueFiles.length - 1} (${items.length} sheets, 合并)`;

      const newTab: TabState = {
        id: `tab_${Date.now()}_${Math.random()}`,
        fileName: tabTitle,
        fileFingerprint: items.map((it) => `${it.fingerprint}::${it.sheetName}`).join('|'),
        channels: mergedChannels,
        drawOrder: mergedDrawOrder,
        view: { startIndex: viewport.startIndex, endIndex: viewport.endIndex },
        cursors: {
          enabled: false,
          mode: 'off',
          x1: null,
          x2: null,
          y1: null,
          y2: null,
          trackingChannel: mergedDrawOrder[0] || null,
        },
        annotations: [],
        annotationMode: false,
        annotationsVisible: true,
        isOverlap: false,
        plotMode: 'time',
        fftOptions: { range: 'view', window: 'hann', scale: 'db', zeroPadding: 1, removeDC: true },
        motorConfig: { rpm: null, polePairs: null, enabled: false },
        triggerConfig: {
          enabled: false,
          channelId: mergedDrawOrder[0],
          type: 'rising',
          level: 0,
          positionPercent: 50,
        },
        measurementGate: 'view',
        separateView: false,
        activeChannelId: mergedDrawOrder[0],
        activeTool: 'pan',
      };
      const globalBounds = getTabGlobalIndexBounds(newTab);
      newTab.view.startIndex = globalBounds.minIdx;
      newTab.view.endIndex = globalBounds.maxIdx;
      this.addTab(newTab);
      const overlapText = merged.hasCommonOverlap
        ? `公共时间窗 ${formatEng(merged.commonOverlapSec, 's', 3)} · 最小覆盖 ${merged.minimumOverlapPct.toFixed(1)}%`
        : '无公共时间重叠区间';
      const modeText =
        timeAlignment === 'align-start'
          ? '首样本平移至 t=0'
          : timeAlignment === 'auto-best'
          ? '最长轴 + 自动时间对应'
          : '保留源时间坐标';
      this.showToast(
        `已合并 ${items.length} 个 Sheet / ${mergedDrawOrder.length} 条通道 · ${modeText} · ${overlapText}`,
        merged.warnings.length ? 'warn' : 'info'
      );
      merged.warnings.forEach((warning) => this.showToast(warning, 'warn'));
      return;
    }

    for (const item of items) {
      this.markRawChannelsAndFit(item.channels);
      const totalPoints = Object.values(item.channels)[0]?.v.length || 1000;
      const tabName = `${item.fileName} [${item.sheetName}]`;
      this.addTab({
        id: `tab_${Date.now()}_${Math.random()}`,
        fileName: tabName,
        fileFingerprint: `${item.fingerprint}::${item.sheetName}`,
        channels: item.channels,
        drawOrder: item.drawOrder,
        view: { startIndex: 0, endIndex: totalPoints },
        cursors: {
          enabled: false,
          mode: 'off',
          x1: null,
          x2: null,
          y1: null,
          y2: null,
          trackingChannel: item.drawOrder[0] || null,
        },
        annotations: [],
        annotationMode: false,
        annotationsVisible: true,
        isOverlap: false,
        plotMode: 'time',
        fftOptions: { range: 'view', window: 'hann', scale: 'db', zeroPadding: 1, removeDC: true },
        motorConfig: { rpm: null, polePairs: null, enabled: false },
        triggerConfig: {
          enabled: false,
          channelId: item.drawOrder[0],
          type: 'rising',
          level: 0,
          positionPercent: 50,
        },
        measurementGate: 'view',
        separateView: false,
        activeChannelId: item.drawOrder[0],
        activeTool: 'pan',
      });
    }
    this.showToast(`已打开 ${items.length} 个 Excel 工作表标签页`, 'info');
  }

  // --- File Handling (CSV, Excel, WFM, LTspice .raw / .txt, .graphx Session) ---
  public handleFiles(files: File[]): void {
    const colors = this.getRawColors();
    const excelFiles = files.filter((f) => isExcelFileName(f.name));
    const standardFiles = files.filter((f) => !isExcelFileName(f.name));
    const tabularFiles: File[] = [];

    for (const file of standardFiles) {
      const ext = file.name.split('.').pop()?.toLowerCase();
      if (ext === 'graphx') {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const json = e.target?.result as string;
            const restored = deserializeSession(json);
            this.tabs = restored.tabs;
            this.activeTabIndex = restored.activeTabIndex;
            this.tabs.forEach((t) => this.ensureTabDefaults(t));
            this.renderTabsBar();
            this.renderSidebar();
            this.draw();
          } catch (err: any) {
            this.showToast(`加载工程文件失败：${err.message}`, 'error');
          }
        };
        reader.readAsText(file);
      } else if (ext === 'wfm' || ext === 'raw') {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const buf = e.target?.result as ArrayBuffer;
            const fileFingerprint = computeBufferFingerprint(file.name, buf);
            const parsed =
              ext === 'raw'
                ? parseLtspiceRawBuffer(buf, colors)
                : parseWfmBuffer(buf, file.name, colors);
            this.markRawChannelsAndFit(parsed.channels);
            const totalPoints = Object.values(parsed.channels)[0]?.v.length || 1000;
            const tab: TabState = {
              id: `tab_${Date.now()}_${Math.random()}`,
              fileName: file.name,
              fileFingerprint,
              channels: parsed.channels,
              drawOrder: parsed.drawOrder,
              view: { startIndex: 0, endIndex: totalPoints },
              cursors: { enabled: false, mode: 'off', x1: null, x2: null, y1: null, y2: null, trackingChannel: parsed.drawOrder[0] || null },
              annotations: [],
              annotationMode: false,
              annotationsVisible: true,
              isOverlap: false,
              plotMode: 'time',
              fftOptions: { range: 'view', window: 'hann', scale: 'db', zeroPadding: 1, removeDC: true },
              motorConfig: { rpm: null, polePairs: null, enabled: false },
              triggerConfig: { enabled: false, channelId: parsed.drawOrder[0], type: 'rising', level: 0, positionPercent: 50 },
              measurementGate: 'view',
              separateView: false,
              activeChannelId: parsed.drawOrder[0],
              activeTool: 'pan',
            };
            this.addTab(tab);
            if (ext === 'raw') {
              const stepInfo = (parsed as any).stepCount > 1 ? ` · ${(parsed as any).stepCount} 步` : '';
              this.showToast(`已载入 LTspice .raw（${parsed.drawOrder.length} 条波形${stepInfo}）`, 'info');
            }
          } catch (err: any) {
            this.showToast(`解析 ${ext?.toUpperCase()} 失败：${err.message}`, 'error');
          }
        };
        reader.readAsArrayBuffer(file);
      } else {
        tabularFiles.push(file);
      }
    }

    const openTabularBatch = async () => {
      if (tabularFiles.length === 0) return;
      try {
        const loaded = await Promise.all(
          tabularFiles.map(async (file) => ({
            fileName: file.name,
            ext: file.name.split('.').pop()?.toLowerCase() || '',
            text: await file.text(),
          }))
        );

        const csvQueueItems: Array<{ text: string; fileName: string }> = [];
        for (const entry of loaded) {
          // Only bypass the acquisition options screen when the .txt is an explicit multi-step LTspice file.
          // Single-run 2-col or multi-col .txt/.csv files MUST open the acquisition options modal.
          const isSteppedLtspice =
            entry.ext === 'txt' && isLtspiceSteppedExportText(entry.text) && isLtspiceExportText(entry.text);
          if (isSteppedLtspice) {
            const fileFingerprint = computeTextFingerprint(entry.fileName, entry.text);
            const parsed = parseLtspiceText(entry.text, colors);
            this.markRawChannelsAndFit(parsed.channels);
            const totalPoints = Object.values(parsed.channels)[0]?.v.length || 1000;
            this.addTab({
              id: `tab_${Date.now()}_${Math.random()}`,
              fileName: entry.fileName,
              fileFingerprint,
              channels: parsed.channels,
              drawOrder: parsed.drawOrder,
              view: { startIndex: 0, endIndex: totalPoints },
              cursors: { enabled: false, mode: 'off', x1: null, x2: null, y1: null, y2: null, trackingChannel: parsed.drawOrder[0] || null },
              annotations: [],
              annotationMode: false,
              annotationsVisible: true,
              isOverlap: false,
              plotMode: 'time',
              fftOptions: { range: 'view', window: 'hann', scale: 'db', zeroPadding: 1, removeDC: true },
              motorConfig: { rpm: null, polePairs: null, enabled: false },
              triggerConfig: { enabled: false, channelId: parsed.drawOrder[0], type: 'rising', level: 0, positionPercent: 50 },
              measurementGate: 'view',
              separateView: false,
              activeChannelId: parsed.drawOrder[0],
              activeTool: 'pan',
            });
            const stepInfo = parsed.stepCount > 1 ? ` · ${parsed.stepCount} 步` : '';
            this.showToast(`已载入 LTspice 导出数据（${parsed.drawOrder.length} 条波形${stepInfo}）`, 'info');
          } else {
            csvQueueItems.push({ text: entry.text, fileName: entry.fileName });
          }
        }

        if (csvQueueItems.length > 0) {
          this.showCsvImportModalBatch(csvQueueItems);
        }
      } catch (err: any) {
        this.showToast(`文件预检失败：${err?.message || err}`, 'error');
      }
    };

    if (excelFiles.length > 0) {
      void excelImportModal.open({
        mode: 'main',
        files: excelFiles,
        colors,
        onConfirm: (res) => {
          this.createTabFromExcelPayloads(res.items, res.tabDisposition, res.timeAlignment);
          if (tabularFiles.length > 0) {
            void openTabularBatch();
          }
        },
        onCancel: () => {
          if (tabularFiles.length > 0) {
            void openTabularBatch();
          }
        },
        onNotify: (msg, level) => this.showToast(msg, level),
      });
    } else if (tabularFiles.length > 0) {
      void openTabularBatch();
    }
  }

  public showCsvImportModal(text: string, fileName: string): void {
    this.showCsvImportModalBatch([{ text, fileName }]);
  }

  public showCsvImportModalBatch(items: Array<{ text: string; fileName: string }>): void {
    if (!items || items.length === 0) return;
    this.pendingCsvQueue = items.map((item) => ({
      fileName: item.fileName,
      text: item.text,
      preview: previewCsv(item.text),
    }));
    this.pendingCsvActiveIndex = 0;
    this.pendingCsvDisposition = items.length > 1 ? 'merge' : 'separate';
    this.pendingCsvTimeAlignment = 'auto-best';

    const modal = document.getElementById('csvQualityModal');
    if (!modal) return;

    modal.style.display = 'flex';
    this.renderCsvModalContent();
  }

  public applyCsvRulesToAllQueued(): void {
    if (this.pendingCsvQueue.length <= 1) return;
    const src = this.pendingCsvQueue[this.pendingCsvActiveIndex];
    if (!src) return;
    const srcP = src.preview;
    let updated = 0;

    for (let i = 0; i < this.pendingCsvQueue.length; i++) {
      if (i === this.pendingCsvActiveIndex) continue;
      const tgt = this.pendingCsvQueue[i];
      const tp = tgt.preview;
      tp.timeUnit = srcP.timeUnit;
      tp.sampleRateOverrideHz = srcP.sampleRateOverrideHz ?? null;

      // Sync matching column roles by index if count matches, or by header name
      if (tp.columnMappings.length === srcP.columnMappings.length) {
        tp.columnMappings.forEach((m, idx) => {
          m.role = srcP.columnMappings[idx].role;
        });
        tp.timeColIndex = srcP.timeColIndex;
      } else {
        let nextTimeCol = -1;
        tp.columnMappings.forEach((m, idx) => {
          const matchByName = srcP.columnMappings.find(
            (sm) => sm.header.trim().toLowerCase() === m.header.trim().toLowerCase()
          );
          if (matchByName) {
            m.role = matchByName.role;
            if (m.role === 'time' && nextTimeCol === -1) nextTimeCol = idx;
          }
        });
        if (nextTimeCol >= 0) tp.timeColIndex = nextTimeCol;
      }
      tp.quality = computeCsvPreviewQuality(tgt.text, tp, tp.timeUnit, tp.sampleRateOverrideHz);
      updated++;
    }
    this.renderCsvModalContent();
    this.showToast(`已将当前时间单位、采样率与列规则同步到其余 ${updated} 个文件。`, 'info');
  }

  private renderCsvModalContent(): void {
    const activeItem = this.pendingCsvQueue[this.pendingCsvActiveIndex];
    if (!activeItem) return;
    const p = activeItem.preview;

    const subEl = document.getElementById('csvModalSubtitle');
    if (subEl) {
      subEl.innerText =
        this.pendingCsvQueue.length > 1
          ? `${activeItem.fileName} · 第 ${this.pendingCsvActiveIndex + 1} / ${this.pendingCsvQueue.length} 个文件`
          : activeItem.fileName;
    }

    const multiBar = document.getElementById('csvMultiFileBar');
    const pillsWrap = document.getElementById('csvFilePillsWrap');
    if (multiBar && pillsWrap) {
      if (this.pendingCsvQueue.length > 1) {
        multiBar.classList.remove('hidden');
        multiBar.classList.add('flex');
        pillsWrap.innerHTML = '';
        this.pendingCsvQueue.forEach((item, idx) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          const chCount = item.preview.columnMappings.filter((m) => m.role === 'channel').length;
          btn.className =
            idx === this.pendingCsvActiveIndex
              ? 'px-2 py-1 bg-cyan-600 text-slate-950 font-semibold rounded-xs text-[11px] font-mono cursor-pointer whitespace-nowrap'
              : 'px-2 py-1 bg-[#161b22] hover:bg-[#1e2530] border border-[#222933] text-slate-300 rounded-xs text-[11px] font-mono cursor-pointer whitespace-nowrap';
          btn.innerText = `${item.fileName} (${chCount}ch)`;
          btn.addEventListener('click', () => {
            this.pendingCsvActiveIndex = idx;
            this.renderCsvModalContent();
          });
          pillsWrap.appendChild(btn);
        });
      } else {
        multiBar.classList.add('hidden');
        multiBar.classList.remove('flex');
      }
    }

    const dispSel = document.getElementById('csvDispositionSelect') as HTMLSelectElement | null;
    const mergeTimeWrap = document.getElementById('csvMergeTimeModeWrap');
    const mergeTimeSel = document.getElementById('csvMergeTimeModeSelect') as HTMLSelectElement | null;
    if (dispSel) {
      const appendOpt = dispSel.querySelector('option[value="append"]') as HTMLOptionElement | null;
      if (appendOpt) appendOpt.disabled = this.tabs.length === 0;
      if (this.pendingCsvDisposition === 'append' && this.tabs.length === 0) {
        this.pendingCsvDisposition = this.pendingCsvQueue.length > 1 ? 'merge' : 'separate';
      }
      dispSel.value = this.pendingCsvDisposition;
      dispSel.onchange = () => {
        const val = dispSel.value;
        this.pendingCsvDisposition =
          val === 'merge' ? 'merge' : val === 'append' ? 'append' : 'separate';
        this.renderCsvModalContent();
      };
    }
    if (mergeTimeWrap && mergeTimeSel) {
      const showAlign = this.pendingCsvDisposition === 'merge' || this.pendingCsvDisposition === 'append';
      mergeTimeWrap.classList.toggle('hidden', !showAlign);
      mergeTimeWrap.classList.toggle('flex', showAlign);
      mergeTimeSel.value = this.pendingCsvTimeAlignment;
      mergeTimeSel.onchange = () => {
        const val = mergeTimeSel.value;
        this.pendingCsvTimeAlignment =
          val === 'align-start' ? 'align-start' : val === 'preserve' ? 'preserve' : 'auto-best';
      };
    }

    const previewContainer = document.getElementById('csvPreviewContainer');
    if (previewContainer) {
      let tableHtml = '<table class="min-w-full text-xs font-mono border-collapse">';
      tableHtml += '<thead class="bg-[#161b22] text-slate-300"><tr>';
      p.headers.forEach((h: string, idx: number) => {
        const isTime = idx === p.timeColIndex;
        const role = p.columnMappings[idx]?.role || (isTime ? 'time' : 'channel');
        tableHtml += `<th class="p-2 border border-[#222933] text-left ${isTime ? 'text-amber-300 font-semibold' : ''}">
          <div class="flex flex-col gap-1">
            <span>${escapeHtml(h)}</span>
            <select class="col-role-select text-xs bg-[#0c0f13] border border-[#2c3543] rounded-sm px-1 text-white" data-col="${idx}">
              <option value="time" ${role === 'time' ? 'selected' : ''}>Time</option>
              <option value="channel" ${role === 'channel' ? 'selected' : ''}>Channel</option>
              <option value="ignore" ${role === 'ignore' ? 'selected' : ''}>Ignore</option>
            </select>
          </div>
        </th>`;
      });
      tableHtml += '</tr></thead><tbody>';

      p.rows.slice(0, 8).forEach((r: string[]) => {
        tableHtml += '<tr class="border-b border-[#222933] hover:bg-[#161b22]">';
        r.forEach((c: string) => {
          tableHtml += `<td class="p-2 border-r border-[#222933] whitespace-nowrap">${escapeHtml(c)}</td>`;
        });
        tableHtml += '</tr>';
      });
      tableHtml += '</tbody></table>';
      previewContainer.innerHTML = tableHtml;

      previewContainer.querySelectorAll('.col-role-select').forEach((sel) => {
        sel.addEventListener('change', (e: any) => {
          const colIdx = parseInt(e.target.dataset.col, 10);
          const role = e.target.value;
          if (role === 'time') {
            p.timeColIndex = colIdx;
            p.columnMappings.forEach((m, i) => {
              if (i === colIdx) m.role = 'time';
              else if (m.role === 'time') m.role = 'channel';
            });
          } else {
            p.columnMappings[colIdx].role = role;
            if (colIdx === p.timeColIndex) p.timeColIndex = -1;
          }
          p.quality = computeCsvPreviewQuality(activeItem.text, p, p.timeUnit, p.sampleRateOverrideHz);
          this.renderCsvModalContent();
        });
      });
    }

    const timeUnitSel = document.getElementById('csvTimeUnitSelect') as HTMLSelectElement;
    if (timeUnitSel) {
      timeUnitSel.value = p.timeUnit;
      timeUnitSel.onchange = () => {
        p.timeUnit = (timeUnitSel.value as 's' | 'ms' | 'us' | 'ns' | 'ps') || 's';
        p.quality = computeCsvPreviewQuality(activeItem.text, p, p.timeUnit, p.sampleRateOverrideHz);
        this.renderCsvModalContent();
      };
    }

    const ratePresetSel = document.getElementById('csvSampleRatePresetSelect') as HTMLSelectElement;
    const customRateInput = document.getElementById('csvCustomRateInput') as HTMLInputElement;
    if (ratePresetSel && customRateInput) {
      const explicitTimeSelected = p.timeColIndex >= 0;
      ratePresetSel.disabled = false;
      customRateInput.disabled = false;
      ratePresetSel.title = explicitTimeSelected
        ? '已选择原始 Time 列：按目标采样间隔抽取真实存在的时间行，时间戳和通道数值同步保留；不插值、不重建时间轴。'
        : '未选择 Time 列时，使用采样率和样本序号重建时间轴。';
      if (!p.sampleRateOverrideHz) {
        ratePresetSel.value = 'auto';
        customRateInput.classList.add('hidden');
      } else {
        const presetMatch = Array.from(ratePresetSel.options).find(
          (opt) => opt.value !== 'auto' && opt.value !== 'custom' && Math.abs(Number(opt.value) - p.sampleRateOverrideHz!) < 1e-3
        );
        if (presetMatch) {
          ratePresetSel.value = presetMatch.value;
          customRateInput.classList.add('hidden');
        } else {
          ratePresetSel.value = 'custom';
          customRateInput.classList.remove('hidden');
          if (document.activeElement !== customRateInput) {
            customRateInput.value = String(p.sampleRateOverrideHz);
          }
        }
      }

      ratePresetSel.onchange = () => {
        const val = ratePresetSel.value;
        if (val === 'auto') {
          p.sampleRateOverrideHz = null;
          customRateInput.classList.add('hidden');
        } else if (val === 'custom') {
          customRateInput.classList.remove('hidden');
          const cur = parseFloat(customRateInput.value);
          p.sampleRateOverrideHz = isFinite(cur) && cur > 0 ? cur : 1e9;
          customRateInput.value = String(p.sampleRateOverrideHz);
          customRateInput.focus();
        } else {
          p.sampleRateOverrideHz = Number(val);
          customRateInput.classList.add('hidden');
        }
        p.quality = computeCsvPreviewQuality(activeItem.text, p, p.timeUnit, p.sampleRateOverrideHz);
        this.renderCsvModalContent();
      };

      customRateInput.onchange = () => {
        const parsedVal = parseFloat(customRateInput.value);
        p.sampleRateOverrideHz = isFinite(parsedVal) && parsedVal > 0 ? parsedVal : null;
        p.quality = computeCsvPreviewQuality(activeItem.text, p, p.timeUnit, p.sampleRateOverrideHz);
        this.renderCsvModalContent();
      };
    }

    const rowCountEl = document.getElementById('csvTotalRows');
    if (rowCountEl) rowCountEl.innerText = `${p.totalRows.toLocaleString()} rows`;

    const delimEl = document.getElementById('csvDelimiter');
    if (delimEl) delimEl.innerText = p.delimiter === '\t' ? 'Tab (\\t)' : `"${p.delimiter}"`;

    const auditEl = document.getElementById('csvAuditSummaryRow');
    if (auditEl && p.quality) {
      const q = p.quality;
      const dur = q.originalTimeEnd - q.originalTimeStart;
      const statusCls =
        q.qualityStatus === 'uniform'
          ? 'text-emerald-400'
          : q.qualityStatus === 'non-uniform'
          ? 'text-amber-300'
          : 'text-red-400';
      const overrideBadge = p.timeColIndex >= 0
        ? p.sampleRateOverrideHz
          ? `<span class="text-cyan-300 font-semibold">[按原始 Time 抽取；目标间隔 ${formatEng(1 / p.sampleRateOverrideHz, 's', 3)}；不插值]</span>`
          : `<span class="text-emerald-300 font-semibold">[原始 Time 列；全量保留]</span>`
        : p.sampleRateOverrideHz
        ? `<span class="text-cyan-300 font-semibold">[INDEX-BASED ${formatEng(p.sampleRateOverrideHz, 'Sa/s', 2)}]</span>`
        : '';
      auditEl.innerHTML = `
        <span>Sampling: <strong class="${statusCls}">${q.qualityStatus.toUpperCase()}</strong> ${overrideBadge}</span>
        <span>Samples: <strong class="text-slate-100">${Math.max(0, q.originalSampleCount - (q.decimatedSampleCount || 0)).toLocaleString()}</strong> kept / ${q.originalSampleCount.toLocaleString()} source${q.decimationCountEstimated ? ' (preview estimate)' : ''}</span>
        <span>Rate: <strong class="text-slate-100">${q.sampleRate ? formatEng(q.sampleRate, 'Sa/s', 2) : 'N/A'}</strong></span>
        <span>Duration: <strong class="text-slate-100">${formatEng(dur, 's', 3)}</strong></span>
        <span>Jitter RMS: <strong class="text-slate-100">${q.jitterRms !== null ? q.jitterRms.toFixed(2) + '%' : 'N/A'}</strong></span>
        <span>Gaps: <strong class="${q.gapCount > 0 ? 'text-amber-300' : 'text-slate-100'}">${q.gapCount}</strong></span>
      `;
    } else if (auditEl) {
      auditEl.innerHTML = '<span class="text-slate-400">未选择 Time 列：默认 10 kSa/s；可设置 Rate 按样本序号重建时间轴。选择 Time 列后，Rate 将改为按原始时间戳抽取已有数据行。</span>';
    }
  }

  public confirmCsvImport(resample: boolean): void {
    if (this.pendingCsvQueue.length === 0) return;

    try {
      const colors = this.getRawColors();
      const parsedEntries = this.pendingCsvQueue.map((item, idx) => {
        const p = item.preview;
        const parsed = parseFullCsv(item.text, {
          delimiter: p.delimiter,
          hasHeader: p.hasHeader,
          skipLines: p.skipLines,
          timeColIndex: p.timeColIndex,
          timeUnit: p.timeUnit,
          sampleRateOverrideHz: p.sampleRateOverrideHz ?? null,
          columnMappings: p.columnMappings,
          resample,
          colors,
        });
        // Re-key channels uniquely per queued file so multi-file merge never collides
        const remappedChannels: Record<string, WaveformChannel> = {};
        const remappedDrawOrder: string[] = [];
        parsed.drawOrder.forEach((cid, cIdx) => {
          const ch = parsed.channels[cid];
          if (!ch) return;
          const uniqueId = `csv_f${idx}_${cIdx}_${cid}`;
          remappedChannels[uniqueId] = { ...ch, id: uniqueId };
          remappedDrawOrder.push(uniqueId);
        });
        return {
          item,
          parsed: {
            channels: remappedChannels,
            drawOrder: remappedDrawOrder,
            quality: parsed.quality,
            timeOriginSec: parsed.timeOriginSec,
            timeOriginKind: parsed.timeOriginKind,
          },
          isSynthetic: Boolean(parsed.quality?.syntheticClockUsed),
        };
      });

      const disposition = this.pendingCsvDisposition;
      const activeTab = this.getActiveTab();

      if (disposition === 'append' && activeTab) {
        this.pushUndoSnapshot('Append Table Files', true);
        // Pick longest existing channel on activeTab as anchor
        let anchorCh = activeTab.channels[activeTab.drawOrder[0]];
        let bestAnchorSpan = anchorCh && anchorCh.t.length >= 2 ? anchorCh.t[anchorCh.t.length - 1] - anchorCh.t[0] : -1;
        for (const id of activeTab.drawOrder) {
          const cand = activeTab.channels[id];
          if (!cand || !cand.t || cand.t.length < 2) continue;
          const sp = cand.t[cand.t.length - 1] - cand.t[0];
          if (sp > bestAnchorSpan) {
            bestAnchorSpan = sp;
            anchorCh = cand;
          }
        }
        const anchorStart = anchorCh && anchorCh.t.length ? anchorCh.t[0] : 0;
        const anchorEnd = anchorCh && anchorCh.t.length ? anchorCh.t[anchorCh.t.length - 1] : 0;
        const anchorIsSynthetic = Boolean(anchorCh?.metadata?.syntheticClockUsed);

        const newChannelIds: string[] = [];
        parsedEntries.forEach(({ item, parsed, isSynthetic }) => {
          const shortName = item.fileName.replace(/\.[^.]+$/, '');
          parsed.drawOrder.forEach((cid) => {
            const ch = parsed.channels[cid];
            if (!ch) return;
            const colorIdx = activeTab.drawOrder.length + newChannelIds.length;
            const newId = `app_${Date.now().toString(36)}_${newChannelIds.length}_${cid}`;
            const nextCh: WaveformChannel = {
              ...ch,
              id: newId,
              name: `[${shortName}] ${ch.name}`,
              color: colors[colorIdx % colors.length] || ch.color,
              channelKind: 'raw',
            };
            const srcStart = nextCh.t[0] || 0;
            const srcEnd = nextCh.t[nextCh.t.length - 1] || srcStart;
            let shiftSec = 0;
            if (this.pendingCsvTimeAlignment === 'align-start') {
              shiftSec = anchorStart - srcStart;
            } else if (this.pendingCsvTimeAlignment === 'auto-best') {
              const overlap =
                !isSynthetic &&
                !anchorIsSynthetic &&
                Math.min(srcEnd, anchorEnd) > Math.max(srcStart, anchorStart);
              if (!overlap) {
                shiftSec = anchorStart - srcStart;
              }
            }
            if (Math.abs(shiftSec) > 1e-15) {
              applyChannelTimeShift(nextCh, shiftSec);
            }
            fitChannelTo125(nextCh);
            activeTab.channels[newId] = nextCh;
            activeTab.drawOrder.push(newId);
            newChannelIds.push(newId);
          });
        });

        // Ensure longest channel sits at drawOrder[0] so X axis grid covers longest span naturally
        let longestId = activeTab.drawOrder[0];
        let maxSpan = -1;
        for (const id of activeTab.drawOrder) {
          const ch = activeTab.channels[id];
          if (!ch || !ch.t || ch.t.length < 2) continue;
          const sp = ch.t[ch.t.length - 1] - ch.t[0];
          if (sp > maxSpan) {
            maxSpan = sp;
            longestId = id;
          }
        }
        if (longestId && activeTab.drawOrder[0] !== longestId) {
          activeTab.drawOrder = [longestId, ...activeTab.drawOrder.filter((id) => id !== longestId)];
        }
        extendTabViewToLongestChannel(activeTab);
        clampCursorsToViewport(activeTab);
        this.cachedSpectrum = null;
        this.cachedSpectrumKey = '';
        this.renderTabsBar();
        this.renderSidebar();
        this.draw();
        this.showToast(`已将 ${newChannelIds.length} 条新通道追加到当前波形屏（最长轴自动展开，支持右侧 Δt 微调）。`, 'info');
      } else if (disposition === 'merge' && parsedEntries.length >= 1) {
        const sources: ExcelMergeSource[] = parsedEntries.map(({ item, parsed, isSynthetic }) => ({
          fileName: item.fileName,
          sheetName: 'CSV',
          channels: parsed.channels,
          drawOrder: parsed.drawOrder,
          timeOriginSec: parsed.timeOriginSec,
          timeOriginKind: isSynthetic ? 'synthetic' : parsed.timeOriginKind,
        }));

        const mergeMode = this.pendingCsvTimeAlignment;
        const merged = mergeExcelChannelsByTime(sources, colors, mergeMode);
        if (merged.drawOrder.length === 0) {
          throw new Error('没有可导入的数值通道。');
        }
        if (mergeMode === 'preserve' && !merged.canMergePreservingTime) {
          this.showToast(
            `多文件包含合成采样时间或不同坐标系，无法仅按原始时间戳合并；请切换为「自动对应时间」或「首样本对齐」。`,
            'warn'
          );
          return;
        }
        const viewport = resolveExcelMergedViewport(merged);
        if (!viewport) {
          throw new Error('合并波形缺少至少两个严格递增的有效时间点。');
        }
        const longestAudit = [...merged.audit]
          .filter((r) => r.sampleCount >= 2 && r.monotonic && r.durationSec > 0)
          .sort((a, b) => b.durationSec - a.durationSec)[0];
        const anchorId =
          mergeMode === 'auto-best' && longestAudit ? longestAudit.id : viewport.primaryChannelId;
        const mergedDrawOrder = [anchorId, ...merged.drawOrder.filter((id) => id !== anchorId)];
        this.markRawChannelsAndFit(merged.channels);

        const tabTitle =
          parsedEntries.length === 1
            ? parsedEntries[0].item.fileName
            : `${parsedEntries[0].item.fileName} +${parsedEntries.length - 1} (${mergedDrawOrder.length}ch 合并)`;

        const tab: TabState = {
          id: `tab_${Date.now()}_${Math.random()}`,
          fileName: tabTitle,
          fileFingerprint: parsedEntries
            .map((e) => computeTextFingerprint(e.item.fileName, e.item.text))
            .join('|'),
          channels: merged.channels,
          drawOrder: mergedDrawOrder,
          view: { startIndex: viewport.startIndex, endIndex: viewport.endIndex },
          cursors: {
            enabled: false,
            mode: 'off',
            x1: null,
            x2: null,
            y1: null,
            y2: null,
            trackingChannel: mergedDrawOrder[0] || null,
          },
          annotations: [],
          annotationMode: false,
          annotationsVisible: true,
          isOverlap: false,
          plotMode: 'time',
          fftOptions: { range: 'view', window: 'hann', scale: 'db', zeroPadding: 1, removeDC: true },
          motorConfig: { rpm: null, polePairs: null, enabled: false },
          triggerConfig: {
            enabled: false,
            channelId: mergedDrawOrder[0],
            type: 'rising',
            level: 0,
            positionPercent: 50,
          },
          measurementGate: 'view',
          separateView: false,
          activeChannelId: mergedDrawOrder[0],
          activeTool: 'pan',
        };
        const globalBounds = getTabGlobalIndexBounds(tab);
        tab.view.startIndex = globalBounds.minIdx;
        tab.view.endIndex = globalBounds.maxIdx;
        this.addTab(tab);
        this.showToast(
          `已将 ${parsedEntries.length} 个文件合并到同屏 ${mergedDrawOrder.length} 条通道（时间轴按最长波形展开，支持右侧面板调节 Δt）。`,
          merged.warnings.length ? 'warn' : 'info'
        );
        merged.warnings.forEach((w) => this.showToast(w, 'warn'));
      } else {
        for (const { item, parsed } of parsedEntries) {
          this.markRawChannelsAndFit(parsed.channels);
          const totalPoints = Object.values(parsed.channels)[0]?.v.length || 1000;
          const tab: TabState = {
            id: `tab_${Date.now()}_${Math.random()}`,
            fileName: item.fileName,
            fileFingerprint: computeTextFingerprint(item.fileName, item.text),
            channels: parsed.channels,
            drawOrder: parsed.drawOrder,
            view: { startIndex: 0, endIndex: totalPoints },
            cursors: {
              enabled: false,
              mode: 'off',
              x1: null,
              x2: null,
              y1: null,
              y2: null,
              trackingChannel: parsed.drawOrder[0] || null,
            },
            annotations: [],
            annotationMode: false,
            annotationsVisible: true,
            isOverlap: false,
            plotMode: 'time',
            fftOptions: { range: 'view', window: 'hann', scale: 'db', zeroPadding: 1, removeDC: true },
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
            activeChannelId: parsed.drawOrder[0],
            activeTool: 'pan',
          };
          this.addTab(tab);
        }
        if (parsedEntries.length > 1) {
          this.showToast(`已分别打开 ${parsedEntries.length} 个波形标签页。`, 'info');
        }
      }

      this.pendingCsvQueue = [];
      this.pendingCsvActiveIndex = 0;
      const modal = document.getElementById('csvQualityModal');
      if (modal) modal.style.display = 'none';
    } catch (err: any) {
      this.showToast(`CSV 导入失败：${err.message}`, 'error');
    }
  }

  public clearPendingCsvImport(): void {
    this.pendingCsvQueue = [];
    this.pendingCsvActiveIndex = 0;
  }

  // --- AutoSet, Trigger, Math, Clarke, Park, Power ---
  public executeAutoSet(): void {
    const tab = this.getActiveTab();
    if (!tab) return;

    this.pushUndoSnapshot('自动设置刻度');
    const res = performAutoSet(tab.channels, tab.drawOrder, tab.view);
    for (const [id, bounds] of Object.entries(res.updatedChannels)) {
      const ch = tab.channels[id];
      if (ch) {
        ch.voltsPerDiv = bounds.voltsPerDiv;
        ch.vOffset = bounds.vOffset;
        ch.vMin = bounds.vMin;
        ch.vMax = bounds.vMax;
      }
    }
    tab.view = res.view;
    tab.triggerConfig = { ...res.triggerConfig, enabled: false };
    clampCursorsToViewport(tab);

    this.renderSidebar();
    this.draw();
    this.showToast(res.statusMessage, 'info', { undoable: true });
  }

  public applyTrigger(): void {
    const tab = this.getActiveTab();
    if (!tab || !tab.triggerConfig.enabled) return;

    const ch = tab.channels[tab.triggerConfig.channelId];
    if (!ch) return;

    const pt = findTriggerPoint(ch, tab.triggerConfig);
    if (pt) {
      tab.view = alignViewToTrigger(tab.view, ch, pt.triggerIndex, tab.triggerConfig.positionPercent);
      clampCursorsToViewport(tab);
      this.renderSidebar();
      this.draw();
    } else {
      this.showToast(`通道「${ch.name}」未检测到触发电平穿越。`, 'warn');
    }
  }

  public addMathChannel(expr: string, name: string): { success: boolean; error?: string } {
    const tab = this.getActiveTab();
    if (!tab) return { success: false, error: '当前没有打开的波形标签页。' };

    try {
      const mathId = `math_${Date.now()}`;
      const mathCh = evaluateMathExpression(expr, tab.channels, tab.drawOrder, mathId, name);
      mathCh.color = this.getNextComputedColor(0);
      mathCh.channelKind = 'computed';
      mathCh.derivedKind = 'math';
      mathCh.derivedBadge = 'fx';
      mathCh.coupling = 'DC';
      mathCh.inverted = false;
      fitChannelTo125(mathCh);

      tab.channels[mathId] = mathCh;
      tab.drawOrder.push(mathId);
      tab.activeChannelId = mathId;
      tab.selectedMeasurementChannelId = mathId;
      tab.selectedFftChannelId = mathId;
      tab.cursors.trackingChannel = mathId;
      this.cachedSpectrum = null;
      this.cachedSpectrumKey = '';

      this.renderSidebar();
      this.draw();
      this.showToast(`已创建数学通道：${name}`, 'info');
      return { success: true };
    } catch (err: any) {
      console.error('Math evaluation error:', err);
      return { success: false, error: err.message };
    }
  }

  public createDerivedMathTraces(
    specs: Array<{
      name: string;
      unit?: string;
      baseChannelId: string;
      time?: Float64Array;
      values: Float32Array;
      expr: string;
      color: string;
      sourceIds: string[];
    }>
  ): void {
    const tab = this.getActiveTab();
    if (!tab || specs.length === 0) return;

    this.pushUndoSnapshot('Add BLDC Derived Trace(s)', true);
    let lastId = '';
    specs.forEach((sp, idx) => {
      const baseCh = tab.channels[sp.baseChannelId] || tab.channels[tab.drawOrder[0]];
      if (!baseCh) return;
      const traceId = `bldc_${Date.now()}_${idx}`;
      const chTime = sp.time && sp.time.length === sp.values.length ? sp.time : baseCh.t;
      const ch: WaveformChannel = {
        ...baseCh,
        id: traceId,
        name: sp.name,
        unit: sp.unit || baseCh.unit || 'V',
        color: sp.color || this.getNextComputedColor(idx),
        visible: true,
        t: chTime,
        v: new Float32Array(sp.values),
        isMath: true,
        channelKind: 'computed',
        derivedKind: 'math',
        derivedBadge: 'fx',
        mathExpression: sp.expr,
        sourceChannelIds: sp.sourceIds,
        coupling: 'DC',
        inverted: false,
        hasEdits: false,
        refV: undefined,
        voltsPerDiv: undefined,
        vOffset: undefined,
        vMin: -1,
        vMax: 1,
      };
      fitChannelTo125(ch);
      tab.channels[traceId] = ch;
      tab.drawOrder.push(traceId);
      lastId = traceId;
    });

    if (lastId) {
      tab.plotMode = 'time';
      tab.activeChannelId = lastId;
      this.cachedSpectrum = null;
      this.cachedSpectrumKey = '';
      this.renderSidebar();
      this.draw();
    }
  }

  public injectThermalTraces(
    specs: Array<{
      replaceKey?: string;
      name: string;
      unit: string;
      t?: Float64Array;
      values: Float32Array;
      color?: string;
      badge?: string;
      expr?: string;
      sourceIds?: string[];
      baseChannelId?: string;
      pinMetrics?: MeasurementMetricKey[];
    }>,
    options?: {
      separateView?: boolean;
      toastMessage?: string;
    }
  ): string[] {
    const tab = this.getActiveTab();
    if (!tab || specs.length === 0) return [];

    this.pushUndoSnapshot('Inject Thermal Trace(s)', true);
    const createdIds: string[] = [];

    specs.forEach((sp, idx) => {
      const baseCh =
        (sp.baseChannelId && tab.channels[sp.baseChannelId]) ||
        tab.channels[tab.drawOrder[0]] ||
        Object.values(tab.channels)[0];
      if (!baseCh) return;

      const traceId = sp.replaceKey ? `therm_${sp.replaceKey}` : `therm_${Date.now()}_${idx}`;
      const existing = tab.channels[traceId];
      const tArr = sp.t && sp.t.length === sp.values.length ? new Float64Array(sp.t) : baseCh.t;
      const customMeta =
        tArr !== baseCh.t ? analyzeSamplingQuality(tArr) : baseCh.metadata;
      const dtVal =
        tArr !== baseCh.t
          ? customMeta.medianDt || customMeta.nominalDt || (tArr.length > 1 ? (tArr[tArr.length - 1] - tArr[0]) / (tArr.length - 1) : baseCh.dt)
          : baseCh.dt;
      const fsVal = dtVal !== null && dtVal > 0 ? 1 / dtVal : baseCh.fs;

      const ch: WaveformChannel = {
        ...baseCh,
        id: traceId,
        name: sp.name,
        unit: sp.unit || '°C',
        color: sp.color || existing?.color || this.getNextComputedColor(idx),
        visible: true,
        t: tArr,
        v: new Float32Array(sp.values),
        isMath: true,
        channelKind: 'computed',
        derivedKind: 'math',
        derivedBadge: sp.badge || 'THM',
        mathExpression: sp.expr || sp.name,
        sourceChannelIds: sp.sourceIds || [],
        coupling: 'DC',
        inverted: false,
        hasEdits: false,
        refV: undefined,
        fs: fsVal,
        dt: dtVal,
        metadata: customMeta,
        voltsPerDiv: undefined,
        vOffset: undefined,
        vMin: -1,
        vMax: 1,
      };
      fitChannelTo125(ch);
      tab.channels[traceId] = ch;
      if (!tab.drawOrder.includes(traceId)) {
        tab.drawOrder.push(traceId);
      }
      createdIds.push(traceId);

      if (sp.pinMetrics && sp.pinMetrics.length > 0) {
        for (const metric of sp.pinMetrics) {
          this.toggleMeasurementSelection(traceId, metric, true);
        }
      }
    });

    if (createdIds.length > 0) {
      tab.plotMode = 'time';
      if (options?.separateView) {
        tab.separateView = true;
      }
      tab.activeChannelId = createdIds[createdIds.length - 1];
      this.editVersion++;
      this.cachedSpectrum = null;
      this.cachedSpectrumKey = '';
      this.renderSidebar();
      this.draw();
      if (options?.toastMessage) {
        this.showToast(options.toastMessage, 'info');
      }
    }
    return createdIds;
  }

  public analyzeChannelWithFFT(channelId: string): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    tab.plotMode = 'frequency';
    tab.selectedFftChannelId = channelId;
    this.cachedSpectrum = null;
    this.cachedSpectrumKey = '';

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

    const chA = tab.channels[uaId];
    const chB = tab.channels[ubId];
    const chC = tab.channels[ucId];

    if (!chA || !chB || !chC) {
      this.showToast('所选三相通道无效。', 'error');
      return;
    }

    try {
      const unitInfo = resolveCompatibleSiGroupScale([chA, chB, chC]);
      if (!unitInfo.valid) {
        this.showToast(unitInfo.reason || '三相通道单位不兼容。', 'error');
        return;
      }
      const synced = alignChannelsToCommonTimebase([chA, chB, chC]);
      if (!synced.valid || synced.time.length < 2) {
        this.showToast(synced.invalidReason || synced.warnings[0] || '三相通道缺少有效的同步时间基准。', 'error');
        return;
      }
      const scaleArr = (arr: Float32Array, scale: number): Float32Array => {
        if (Math.abs(scale - 1) <= 1e-12) return arr;
        const out = new Float32Array(arr.length);
        for (let i = 0; i < arr.length; i++) out[i] = arr[i] * scale;
        return out;
      };
      const ua = scaleArr(synced.values[0], unitInfo.scales[0]);
      const ub = scaleArr(synced.values[1], unitInfo.scales[1]);
      const uc = scaleArr(synced.values[2], unitInfo.scales[2]);
      const { alpha, beta } = computeClarke(ua, ub, uc);
      const baseCh = chA;
      const outUnit = unitInfo.baseUnit || baseCh.unit || 'V';
      const syncDt = synced.time.length >= 2 ? (synced.time[synced.time.length - 1] - synced.time[0]) / (synced.time.length - 1) : (baseCh.dt ?? 1e-6);

      const alphaId = `clarke_alpha_${Date.now()}`;
      const betaId = `clarke_beta_${Date.now()}`;

      const alphaCh: WaveformChannel = {
        ...baseCh,
        id: alphaId,
        name: 'Clarke α',
        unit: outUnit,
        color: this.getNextComputedColor(0),
        visible: true,
        t: synced.time,
        v: alpha,
        dt: syncDt,
        fs: syncDt > 0 ? 1 / syncDt : baseCh.fs,
        isMath: true,
        channelKind: 'computed',
        derivedKind: 'transform',
        derivedBadge: 'fx',
        coupling: 'DC',
        inverted: false,
        mathExpression: `Clarke α(${chA.name}, ${chB.name}, ${chC.name})`,
        sourceChannelIds: [uaId, ubId, ucId],
        vMin: -1,
        vMax: 1,
        voltsPerDiv: undefined,
        vOffset: undefined,
      };
      fitChannelTo125(alphaCh);

      const betaCh: WaveformChannel = {
        ...baseCh,
        id: betaId,
        name: 'Clarke β',
        unit: outUnit,
        color: this.getNextComputedColor(1),
        visible: true,
        t: synced.time,
        v: beta,
        dt: syncDt,
        fs: syncDt > 0 ? 1 / syncDt : baseCh.fs,
        isMath: true,
        channelKind: 'computed',
        derivedKind: 'transform',
        derivedBadge: 'fx',
        coupling: 'DC',
        inverted: false,
        mathExpression: `Clarke β(${chA.name}, ${chB.name}, ${chC.name})`,
        sourceChannelIds: [uaId, ubId, ucId],
        vMin: -1,
        vMax: 1,
        voltsPerDiv: undefined,
        vOffset: undefined,
      };
      fitChannelTo125(betaCh);

      tab.channels[alphaId] = alphaCh;
      tab.channels[betaId] = betaCh;
      tab.drawOrder.push(alphaId, betaId);

      tab.activeChannelId = alphaId;
      tab.selectedMeasurementChannelId = alphaId;
      tab.selectedFftChannelId = alphaId;
      tab.cursors.trackingChannel = alphaId;
      this.cachedSpectrum = null;
      this.cachedSpectrumKey = '';

      this.renderSidebar();
      this.draw();
      const extraWarn = Array.from(new Set([unitInfo.normalizedNote, ...synced.warnings].filter(Boolean))).join(' | ');
      this.showToast(
        extraWarn
          ? `已生成 Clarke α/β 通道（${extraWarn}）`
          : '已生成 Clarke α 与 β 通道。',
        synced.resampled || unitInfo.normalizedNote || synced.warnings.length > 0 ? 'warn' : 'info'
      );
    } catch (err: any) {
      this.showToast(`Clarke 变换失败：${err.message}`, 'error');
    }
  }

  public executeParkTransform(
    alphaId: string,
    betaId: string,
    angleMode: 'auto' | 'channel',
    angleChannelId: string,
    offsetDeg: number
  ): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    const alphaCh = tab.channels[alphaId];
    const betaCh = tab.channels[betaId];
    if (!alphaCh || !betaCh) {
      this.showToast('请选择有效的 α 与 β 通道。', 'error');
      return;
    }

    try {
      const offsetRad = ((isFinite(offsetDeg) ? offsetDeg : 0) * Math.PI) / 180;
      const angleCh = angleMode === 'channel' ? tab.channels[angleChannelId] : undefined;
      if (angleMode === 'channel' && !angleCh) {
        this.showToast('请选择有效的电角度 θ(t) 通道，或切换为自动模式。', 'error');
        return;
      }
      const parkRes = computeParkFromChannels(alphaCh, betaCh, angleCh, offsetRad);
      if (!parkRes.valid || parkRes.time.length < 2) {
        this.showToast(parkRes.invalidReason || parkRes.warnings[0] || 'Park 变换失败。', 'error');
        return;
      }

      const isSelfAligned = parkRes.frameType === 'self_aligned_vector';
      const syncDt =
        parkRes.time.length >= 2
          ? (parkRes.time[parkRes.time.length - 1] - parkRes.time[0]) / (parkRes.time.length - 1)
          : (alphaCh.dt ?? 1e-6);
      const dId = `park_d_${Date.now()}`;
      const qId = `park_q_${Date.now() + 1}`;
      const srcIds = angleCh ? [alphaId, betaId, angleCh.id] : [alphaId, betaId];

      const dCh: WaveformChannel = {
        ...alphaCh,
        id: dId,
        name: isSelfAligned ? 'Park d_vec (自对齐)' : 'Park Id/Ud',
        unit: parkRes.unit,
        color: this.getNextComputedColor(0),
        visible: true,
        t: parkRes.time,
        v: parkRes.d,
        dt: syncDt,
        fs: syncDt > 0 ? 1 / syncDt : alphaCh.fs,
        isMath: true,
        channelKind: 'computed',
        derivedKind: 'transform',
        derivedBadge: isSelfAligned ? 'vec' : 'fx',
        coupling: 'DC',
        inverted: false,
        mathExpression: `Park_d(${alphaCh.name}, ${betaCh.name}${angleCh ? `, ${angleCh.name}` : ', auto'})`,
        sourceChannelIds: srcIds,
        voltsPerDiv: undefined,
        vOffset: undefined,
      };
      fitChannelTo125(dCh);

      const qCh: WaveformChannel = {
        ...alphaCh,
        id: qId,
        name: isSelfAligned ? 'Park q_vec (自对齐)' : 'Park Iq/Uq',
        unit: parkRes.unit,
        color: this.getNextComputedColor(1),
        visible: true,
        t: parkRes.time,
        v: parkRes.q,
        dt: syncDt,
        fs: syncDt > 0 ? 1 / syncDt : alphaCh.fs,
        isMath: true,
        channelKind: 'computed',
        derivedKind: 'transform',
        derivedBadge: isSelfAligned ? 'vec' : 'fx',
        coupling: 'DC',
        inverted: false,
        mathExpression: `Park_q(${alphaCh.name}, ${betaCh.name}${angleCh ? `, ${angleCh.name}` : ', auto'})`,
        sourceChannelIds: srcIds,
        voltsPerDiv: undefined,
        vOffset: undefined,
      };
      fitChannelTo125(qCh);

      tab.channels[dId] = dCh;
      tab.channels[qId] = qCh;
      tab.drawOrder.push(dId, qId);
      tab.activeChannelId = dId;
      this.cachedSpectrum = null;
      this.cachedSpectrumKey = '';
      this.renderSidebar();
      this.draw();
      const topWarn = Array.from(new Set(parkRes.warnings.filter(Boolean))).join(' | ');
      this.showToast(
        topWarn ? `已生成 Park d/q 通道（${topWarn}）` : '已生成 Park d 与 q 通道。',
        parkRes.warnings.length > 0 || parkRes.resampled ? 'warn' : 'info'
      );
    } catch (err: any) {
      this.showToast(`Park 变换失败：${err.message}`, 'error');
    }
  }

  public executePowerCalculation(
    mode: '3ph' | '1ph',
    uaId: string,
    ubId: string,
    ucId: string,
    iaId: string,
    ibId: string,
    icId: string
  ): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    const uaCh = tab.channels[uaId];
    const iaCh = tab.channels[iaId];
    if (!uaCh || !iaCh) {
      this.showToast('请选择有效的电压与电流通道。', 'error');
      return;
    }

    try {
      let power: Float32Array;
      let syncTime: Float64Array;
      let wasResampled = false;
      let siScaled = false;
      let expr: string;
      let srcIds: string[];

      if (mode === '1ph') {
        const vScale = parseSiUnitScale(uaCh.unit, 'V', uaCh.name, { strict: true });
        const iScale = parseSiUnitScale(iaCh.unit, 'A', iaCh.name, { strict: true });
        siScaled = Math.abs(vScale - 1) > 1e-12 || Math.abs(iScale - 1) > 1e-12;
        const synced = alignChannelsToCommonTimebase([uaCh, iaCh]);
        if (!synced.valid || synced.time.length < 2) {
          this.showToast(synced.invalidReason || synced.warnings[0] || '电压与电流通道缺少有效的同步时间基准。', 'error');
          return;
        }
        syncTime = synced.time;
        wasResampled = synced.resampled;
        const [vArr, iArr] = synced.values;
        power = new Float32Array(syncTime.length);
        for (let i = 0; i < syncTime.length; i++) power[i] = vArr[i] * vScale * (iArr[i] * iScale);
        expr = `${uaCh.name}*${iaCh.name}`;
        srcIds = [uaId, iaId];
      } else {
        const ubCh = tab.channels[ubId];
        const ucCh = tab.channels[ucId];
        const ibCh = tab.channels[ibId];
        const icCh = tab.channels[icId];
        if (!ubCh || !ucCh || !ibCh || !icCh) {
          this.showToast('三相功率计算需要同时选择全部 3 路电压与 3 路电流通道。', 'error');
          return;
        }
        const vScaleA = parseSiUnitScale(uaCh.unit, 'V', uaCh.name, { strict: true });
        const vScaleB = parseSiUnitScale(ubCh.unit, 'V', ubCh.name, { strict: true });
        const vScaleC = parseSiUnitScale(ucCh.unit, 'V', ucCh.name, { strict: true });
        const iScaleA = parseSiUnitScale(iaCh.unit, 'A', iaCh.name, { strict: true });
        const iScaleB = parseSiUnitScale(ibCh.unit, 'A', ibCh.name, { strict: true });
        const iScaleC = parseSiUnitScale(icCh.unit, 'A', icCh.name, { strict: true });
        siScaled = [vScaleA, vScaleB, vScaleC, iScaleA, iScaleB, iScaleC].some((s) => Math.abs(s - 1) > 1e-12);
        const synced = alignChannelsToCommonTimebase([uaCh, ubCh, ucCh, iaCh, ibCh, icCh]);
        if (!synced.valid || synced.time.length < 2) {
          this.showToast(synced.invalidReason || synced.warnings[0] || '三相 6 通道功率缺少有效的同步时间基准。', 'error');
          return;
        }
        syncTime = synced.time;
        wasResampled = synced.resampled;
        const scaleArr = (arr: Float32Array, scale: number): Float32Array => {
          if (Math.abs(scale - 1) <= 1e-12) return arr;
          const out = new Float32Array(arr.length);
          for (let i = 0; i < arr.length; i++) out[i] = arr[i] * scale;
          return out;
        };
        const ua = scaleArr(synced.values[0], vScaleA);
        const ub = scaleArr(synced.values[1], vScaleB);
        const uc = scaleArr(synced.values[2], vScaleC);
        const ia = scaleArr(synced.values[3], iScaleA);
        const ib = scaleArr(synced.values[4], iScaleB);
        const ic = scaleArr(synced.values[5], iScaleC);
        power = computeInstantaneousPower(ua, ub, uc, ia, ib, ic);
        expr = `P3ph(${uaCh.name},${ubCh.name},${ucCh.name})`;
        srcIds = [uaId, ubId, ucId, iaId, ibId, icId];
      }

      const syncDt = syncTime.length >= 2 ? (syncTime[syncTime.length - 1] - syncTime[0]) / (syncTime.length - 1) : (uaCh.dt ?? 1e-6);
      const pId = `power_${Date.now()}`;
      const pCh: WaveformChannel = {
        ...uaCh,
        id: pId,
        name: mode === '3ph' ? 'Power P3ph' : 'Power P(t)',
        unit: 'W',
        color: this.getNextComputedColor(0),
        visible: true,
        t: syncTime,
        v: power,
        dt: syncDt,
        fs: syncDt > 0 ? 1 / syncDt : uaCh.fs,
        isMath: true,
        channelKind: 'computed',
        derivedKind: 'power',
        derivedBadge: 'P(t)',
        coupling: 'DC',
        inverted: false,
        mathExpression: expr,
        sourceChannelIds: srcIds,
        voltsPerDiv: undefined,
        vOffset: undefined,
      };
      fitChannelTo125(pCh);
      tab.channels[pId] = pCh;
      tab.drawOrder.push(pId);
      tab.activeChannelId = pId;
      this.cachedSpectrum = null;
      this.cachedSpectrumKey = '';
      this.renderSidebar();
      this.draw();

      const summary = computePowerSummary(pCh.t, pCh.v);
      const flags = [wasResampled ? '时基已同步' : '', siScaled ? 'SI 已缩放' : ''].filter(Boolean).join(' · ');
      if (!summary.valid) {
        this.showToast(
          `${flags ? `[${flags}] ` : ''}已创建 P(t)，积分无效 (${summary.status})：${summary.invalidReason || '数据不足'}`,
          'warn'
        );
      } else {
        this.showToast(
          `${flags ? `[${flags}] ` : ''}已创建 P(t) · P_avg=${formatEng(summary.avgPowerW, 'W', 3)}, |P|_avg=${formatEng(summary.avgAbsPowerW, 'W', 3)} (非热损耗), E_net=${formatEng(summary.energyJ, 'J', 3)} (E+=${formatEng(summary.inputEnergyJ, 'J', 3)}, E-=${formatEng(summary.regenEnergyJ, 'J', 3)})`,
          wasResampled || siScaled || summary.skippedGapCount > 0 ? 'warn' : 'info'
        );
      }
    } catch (err: any) {
      this.showToast(`功率计算失败：${err.message}`, 'error');
    }
  }

  // --- DOM Synchronization & Rendering ---
  public renderTabsBar(): void {
    const container = document.getElementById('tabsContainer');
    if (!container) return;

    container.innerHTML = '';
    this.tabs.forEach((tab, idx) => {
      const isActive = idx === this.activeTabIndex;
      const tabEl = document.createElement('div');
      tabEl.className = `tab-item flex items-center gap-2 px-2.5 py-1 cursor-pointer rounded-sm text-xs border transition ${
        isActive
          ? 'bg-[#161b22] border-cyan-500/70 text-cyan-200 font-medium'
          : 'bg-[#0c0f13] border-[#222933] text-slate-400 hover:text-slate-200 hover:border-[#2c3543]'
      }`;
      tabEl.innerHTML = `
        <span class="truncate max-w-[145px]" title="${escapeHtml(tab.fileName)}">${escapeHtml(tab.fileName)}</span>
        <button class="tab-close text-slate-400 hover:text-white px-0.5 cursor-pointer" title="Close Tab">×</button>
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

  private updateScreenTelemetry(): void {
    const tab = this.getActiveTab();
    const tbEl = document.getElementById('timebaseReadout');
    const srEl = document.getElementById('acqSampleRateReadout');
    const depthEl = document.getElementById('acqDepthReadout');
    const timeBtn = document.getElementById('timeModeBtn');
    const freqBtn = document.getElementById('freqModeBtn');
    const xyBtn = document.getElementById('xyModeBtn');
    const overlapBtn = document.getElementById('overlapViewBtn');
    const sepBtn = document.getElementById('separateViewBtn');
    const zoomBtn = document.getElementById('toolZoomBtn');
    const ptBtn = document.getElementById('toolPointBtn');
    const txtBtn = document.getElementById('toolTextBtn');
    const areaBtn = document.getElementById('toolAreaBtn');
    this.updateUndoRedoButtons();

    if (!tab) {
      if (tbEl) tbEl.innerText = '-- /div';
      if (srEl) srEl.innerText = '-- Sa/s';
      if (depthEl) depthEl.innerText = '0 pts';
      return;
    }

    const tb = getTimebaseInfo(tab);
    if (tbEl) tbEl.innerText = `${formatEng(tb.secPerDiv, 's', 2)}/div`;
    if (srEl) srEl.innerText = tb.sampleRate ? formatEng(tb.sampleRate, 'Sa/s', 2) : 'Non-uniform';
    if (depthEl) depthEl.innerText = `${tb.visiblePoints.toLocaleString()} / ${tb.totalPoints.toLocaleString()} pts`;

    // Mode toggles (Time | FFT | XY) via aria-pressed
    timeBtn?.setAttribute('aria-pressed', tab.plotMode === 'time' ? 'true' : 'false');
    freqBtn?.setAttribute('aria-pressed', tab.plotMode === 'frequency' ? 'true' : 'false');
    xyBtn?.setAttribute('aria-pressed', tab.plotMode === 'xy' ? 'true' : 'false');

    // Layout toggles (Overlap | Separate) via aria-pressed
    overlapBtn?.setAttribute('aria-pressed', !tab.separateView ? 'true' : 'false');
    sepBtn?.setAttribute('aria-pressed', tab.separateView ? 'true' : 'false');

    // Render Mode 4-way switch via aria-pressed
    const rm = tab.renderMode || 'vector';
    document.getElementById('renderModeVectorBtn')?.setAttribute('aria-pressed', rm === 'vector' ? 'true' : 'false');
    document.getElementById('renderModeSincBtn')?.setAttribute('aria-pressed', rm === 'sinc' ? 'true' : 'false');
    document.getElementById('renderModeDotsBtn')?.setAttribute('aria-pressed', rm === 'dots' ? 'true' : 'false');
    document.getElementById('renderModeMarkersBtn')?.setAttribute('aria-pressed', rm === 'vector-markers' ? 'true' : 'false');

    // Decimation Mode 2-way switch via aria-pressed
    const dm = tab.decimationMode || 'minmax';
    document.getElementById('decimMinMaxBtn')?.setAttribute('aria-pressed', dm === 'minmax' ? 'true' : 'false');
    document.getElementById('decimLttbBtn')?.setAttribute('aria-pressed', dm === 'lttb' ? 'true' : 'false');

    // Update compact Display popover summary badge
    const displaySummaryEl = document.getElementById('displayMenuSummary');
    if (displaySummaryEl) {
      const rmLabel =
        rm === 'sinc' ? '插值' : rm === 'dots' ? '散点' : rm === 'vector-markers' ? '连线+点' : '连线';
      const dmLabel = dm === 'lttb' ? 'LTTB' : '峰谷';
      displaySummaryEl.innerText = `${rmLabel} · ${dmLabel}`;
    }

    const measCount = `${(tab.selectedMeasurements || []).length}`;
    const measCountEl = document.getElementById('measureCountLabel');
    if (measCountEl) measCountEl.innerText = measCount;

    // Active Tool button highlights via aria-pressed
    const tool = tab.activeTool || 'pan';
    zoomBtn?.setAttribute('aria-pressed', tool === 'areaZoom' ? 'true' : 'false');
    ptBtn?.setAttribute('aria-pressed', tool === 'pointAnnotate' ? 'true' : 'false');
    txtBtn?.setAttribute('aria-pressed', tool === 'textAnnotate' ? 'true' : 'false');
    areaBtn?.setAttribute('aria-pressed', tool === 'areaAnnotate' ? 'true' : 'false');
  }

  private renderSoftkeysOnly(tab: TabState): void {
    const dock = document.getElementById('channelSoftkeysBar');
    if (!dock) return;

    dock.innerHTML = '';
    if (tab.drawOrder.length === 0) {
      dock.innerHTML = '<div class="text-[11px] text-fg-muted font-mono px-2 py-1">暂无活动通道</div>';
      return;
    }

    const isLight = Boolean(this.theme.isLight);
    let inputIdx = 0;
    tab.drawOrder.forEach((id) => {
      const ch = tab.channels[id];
      if (!ch) return;
      // Keep Compare reference overlay traces tucked inside the compact Compare Group Pill + sidebar Compare Groups list
      if (ch.compareRole === 'ref') return;

      const computed = isComputedChannel(ch);
      const tag = computed ? `[${ch.derivedBadge || 'fx'}]` : `CH${++inputIdx}`;
      const isSelected = tab.activeChannelId === id;
      const { voltsPerDiv, vOffset } = ensureChannelScaleOffset(ch);
      const chTextColor = resolveChannelTextColor(ch.color, isLight);

      const keyEl = document.createElement('div');
      keyEl.className = `flex items-center gap-2 px-2.5 py-1 rounded-sm border cursor-pointer transition shrink-0 ${
        isSelected
          ? 'bg-elevated border-line-strong text-fg'
          : 'bg-well border-line text-fg-secondary hover:border-line-strong'
      } ${!ch.visible ? 'opacity-50' : ''}`;
      keyEl.title = '点击设为当前通道 · 双击独奏/恢复 · Alt+点击单通道自适应刻度';
      keyEl.style.borderTopWidth = '2px';
      keyEl.style.borderTopStyle = computed ? 'dashed' : 'solid';
      keyEl.style.borderTopColor = ch.color;
      if (isSelected) {
        keyEl.style.boxShadow = `inset 0 0 0 1px ${chTextColor}`;
      }
      if (ch.compareGroupColor) {
        keyEl.style.borderLeftWidth = '3px';
        keyEl.style.borderLeftColor = ch.compareGroupColor;
      }

      const refTag = ch.hasEdits ? '<span class="text-[10px] font-mono wvp-alert-danger border px-1 ml-0.5 rounded-xs">参考</span>' : '';
      const safeGrpName = escapeHtml(ch.compareGroupName || '');
      const safeChName = escapeHtml(ch.name);
      const grpColor = resolveChannelTextColor(ch.compareGroupColor || ch.color, isLight);
      const grpBadge = ch.compareGroupName
        ? `<span class="text-[10px] font-mono font-bold px-1 rounded-xs border shrink-0" style="color:${grpColor};border-color:${grpColor}">${safeGrpName}</span>`
        : '';
      const swatchEl = computed
        ? `<button class="sk-vis-btn w-4 h-3 flex items-center justify-center shrink-0 cursor-pointer" title="显示/隐藏计算通道"><span class="w-4 h-0 border-t-2 border-dashed block" style="border-color:${ch.color};opacity:${ch.visible ? 1 : 0.3}"></span></button>`
        : `<button class="sk-vis-btn w-2.5 h-2.5 rounded-xs border border-line-strong shrink-0 cursor-pointer" style="background:${ch.visible ? ch.color : 'transparent'}" title="显示/隐藏通道"></button>`;

      keyEl.innerHTML = `
        ${swatchEl}
        <div class="flex flex-col leading-tight min-w-0">
          <div class="flex items-center gap-1 font-mono text-[11px]">
            ${grpBadge}
            <span class="font-bold" style="color:${chTextColor}">${escapeHtml(tag)}</span>
            <span class="truncate max-w-[88px] text-fg font-sans text-[11px]" title="${safeChName}">${safeChName}</span>${refTag}
          </div>
          <div class="font-mono text-[10px] text-fg-muted tabular-nums">
            <span style="color:${chTextColor};font-weight:600">${escapeHtml(formatEng(voltsPerDiv, ch.unit, 1))}/div</span> · ${ch.coupling || 'DC'}${ch.inverted ? ' · 反相' : ''} · ${vOffset >= 0 ? '+' : ''}${vOffset.toFixed(1)}${escapeHtml(ch.unit)}${Math.abs(ch.timeShiftSec || 0) > 1e-15 ? ` · <span class="text-accent">Δt=${escapeHtml(formatEng(ch.timeShiftSec!, 's', 2))}</span>` : ''}
          </div>
        </div>
      `;

      keyEl.querySelector('.sk-vis-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleChannelVisible(id);
      });

      keyEl.addEventListener('click', (e) => {
        if (e.altKey) {
          e.preventDefault();
          this.selectActiveChannel(id);
          this.fitSingleChannel(id);
          this.showToast(`已自适应通道 ${ch.name} 垂直刻度。`, 'info', { undoable: true });
          return;
        }
        this.selectActiveChannel(id);
      });

      keyEl.addEventListener('dblclick', (e) => {
        e.preventDefault();
        this.toggleSoloChannel(id);
      });

      dock.appendChild(keyEl);
    });

    // Render one tidy Group Pill per Compare Group at the right end of the softkeys bar
    const groupsMap = new Map<string, { name: string; color: string; refCount: number; diffCount: number; allRefVisible: boolean }>();
    tab.drawOrder.forEach((id) => {
      const ch = tab.channels[id];
      if (!ch || !ch.compareGroupId) return;
      let g = groupsMap.get(ch.compareGroupId);
      if (!g) {
        g = {
          name: ch.compareGroupName || 'CMP',
          color: ch.compareGroupColor || ch.color,
          refCount: 0,
          diffCount: 0,
          allRefVisible: true,
        };
        groupsMap.set(ch.compareGroupId, g);
      }
      if (ch.compareRole === 'ref') {
        g.refCount++;
        if (!ch.visible) g.allRefVisible = false;
      } else if (ch.compareRole === 'diff') {
        g.diffCount++;
        if (!ch.visible) g.allRefVisible = false;
      }
    });

    groupsMap.forEach((grp, groupId) => {
      if (grp.refCount === 0 && grp.diffCount === 0) return;
      const totalOverlays = grp.refCount + grp.diffCount;
      const grpChip = document.createElement('div');
      grpChip.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-sm border bg-[#0c1118] text-[10px] font-mono shrink-0';
      grpChip.style.borderColor = grp.color;
      const safeGroupName = escapeHtml(grp.name);
      const grpTextColor = resolveChannelTextColor(grp.color, Boolean(this.theme.isLight));
      grpChip.innerHTML = `
        <span class="w-2 h-2 rounded-full shrink-0" style="background:${grp.color}"></span>
        <button type="button" class="grp-edit-btn font-bold hover:underline cursor-pointer" style="color:${grpTextColor}" title="编辑比较组">[${safeGroupName}]</button>
        <span class="text-slate-400">· ${totalOverlays} 参考</span>
        <button type="button" class="grp-vis-btn px-1.5 py-0.5 rounded-xs bg-[#161b22] hover:bg-[#1e2530] border border-[#2c3543] text-slate-200 cursor-pointer" title="显示或隐藏比较参考线">${grp.allRefVisible ? '隐藏' : '显示'}</button>
        <button type="button" class="grp-edit-icon-btn px-1.5 py-0.5 rounded-xs bg-[#161b22] hover:bg-[#1e2530] border border-[#2c3543] text-cyan-300 cursor-pointer" title="编辑或重新对齐比较组">编辑</button>
        <button type="button" class="grp-del-btn px-1 py-0.5 rounded-xs hover:bg-red-950/60 text-red-300 cursor-pointer" title="移除比较组">✕</button>
      `;
      grpChip.querySelector('.grp-vis-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleCompareGroupVisibility(groupId);
      });
      grpChip.querySelector('.grp-edit-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onEditCompareGroup?.(groupId);
      });
      grpChip.querySelector('.grp-edit-icon-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onEditCompareGroup?.(groupId);
      });
      grpChip.querySelector('.grp-del-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeCompareGroup(groupId);
      });
      dock.appendChild(grpChip);
    });
  }

  private syncVerticalPanelOnly(ch: WaveformChannel): void {
    const { voltsPerDiv, vOffset } = ensureChannelScaleOffset(ch);
    const chTextColor = resolveChannelTextColor(ch.color, Boolean(this.theme.isLight));

    const activeChSel = document.getElementById('activeChannelSelect') as HTMLSelectElement | null;
    if (activeChSel) {
      activeChSel.style.borderLeftWidth = '3px';
      activeChSel.style.borderLeftColor = ch.color;
      activeChSel.style.color = chTextColor;
    }

    const vDivSel = document.getElementById('vDivSelect') as HTMLSelectElement;
    if (vDivSel) {
      let bestOpt = vDivSel.options[0]?.value || '1';
      let bestRatio = Infinity;
      for (let i = 0; i < vDivSel.options.length; i++) {
        const v = parseFloat(vDivSel.options[i].value);
        const r = Math.max(v / voltsPerDiv, voltsPerDiv / v);
        if (r < bestRatio) {
          bestRatio = r;
          bestOpt = vDivSel.options[i].value;
        }
      }
      vDivSel.value = bestOpt;
      vDivSel.style.color = chTextColor;
    }

    const offsetInput = document.getElementById('vOffsetInput') as HTMLInputElement;
    if (offsetInput) {
      if (document.activeElement !== offsetInput) {
        offsetInput.value = vOffset.toFixed(2);
      }
      offsetInput.style.color = chTextColor;
    }

    const offsetSlider = document.getElementById('vOffsetSlider') as HTMLInputElement;
    if (offsetSlider && document.activeElement !== offsetSlider) {
      const divs = Math.max(-4, Math.min(4, vOffset / voltsPerDiv));
      offsetSlider.value = divs.toFixed(2);
    }

    const timeShiftInput = document.getElementById('chTimeShiftInput') as HTMLInputElement | null;
    if (timeShiftInput) {
      if (document.activeElement !== timeShiftInput) {
        const shift = ch.timeShiftSec || 0;
        timeShiftInput.value = Math.abs(shift) > 1e-15 ? String(Number(shift.toPrecision(7))) : '0';
      }
      timeShiftInput.style.color = chTextColor;
    }
  }

  private renderCursorReadoutOnly(tab: TabState): void {
    const grid = document.getElementById('cursorReadoutGrid');
    if (!grid) return;

    const mode = resolveCursorMode(tab);
    document.querySelectorAll('.cur-mode-btn').forEach((btn) => {
      const m = btn.getAttribute('data-curmode');
      btn.setAttribute('aria-pressed', m === mode ? 'true' : 'false');
    });

    if (mode === 'off') {
      grid.innerHTML = '<div class="text-slate-500">游标已关闭，请选择 X、Y、X+Y 或追踪模式。</div>';
      return;
    }

    const targetId = tab.cursors.trackingChannel || tab.activeChannelId || tab.drawOrder[0];
    const targetCh = tab.channels[targetId] || tab.channels[tab.drawOrder[0]];
    const unit = targetCh?.unit || 'V';
    const isLight = Boolean(this.theme.isLight);
    const targetColor = targetCh ? resolveChannelTextColor(targetCh.color, isLight) : (isLight ? '#0369a1' : '#38bdf8');
    const curChSel = document.getElementById('cursorChannelSelect') as HTMLSelectElement | null;
    if (curChSel && targetCh) {
      curChSel.style.borderLeftWidth = '3px';
      curChSel.style.borderLeftColor = targetCh.color;
      curChSel.style.color = targetColor;
    }

    const { x1, x2 } = tab.cursors;
    let { y1, y2 } = tab.cursors;

    if (mode === 'track' && targetCh) {
      y1 = x1 !== null ? sampleChannelValueAtTime(targetCh, x1) : null;
      y2 = x2 !== null ? sampleChannelValueAtTime(targetCh, x2) : null;
    }

    const dx = x1 !== null && x2 !== null ? Math.abs(x2 - x1) : null;
    const freq = dx !== null && dx > 1e-15 ? formatEng(1 / dx, 'Hz', 2) : '--';
    const dy = y1 !== null && y2 !== null ? y2 - y1 : null;
    const slope = dx && dy !== null && dx > 1e-15 ? formatEng(dy / dx, `${unit}/s`, 2) : '--';

    let html = '<div class="grid grid-cols-2 gap-x-3 gap-y-1 bg-[#0c0f13] border border-[#222933] p-2 rounded-sm">';
    if (mode === 'x' || mode === 'xy' || mode === 'track') {
      html += `
        <div class="flex justify-between"><span class="text-sky-400">X1:</span><span class="text-slate-200">${x1 !== null ? formatEng(x1, 's', 3) : '--'}</span></div>
        <div class="flex justify-between"><span class="text-sky-400">X2:</span><span class="text-slate-200">${x2 !== null ? formatEng(x2, 's', 3) : '--'}</span></div>
        <div class="flex justify-between"><span class="text-slate-400">ΔX:</span><span class="text-slate-100 font-semibold">${dx !== null ? formatEng(dx, 's', 3) : '--'}</span></div>
        <div class="flex justify-between"><span class="text-slate-400">1/ΔX:</span><span class="text-cyan-300 font-semibold">${freq}</span></div>
      `;
    }
    if (mode === 'y' || mode === 'xy' || mode === 'track') {
      html += `
        <div class="col-span-2 flex items-center gap-1.5 pt-1 mt-0.5 border-t border-[#222933] text-[10px]">
          <span class="w-2 h-2 rounded-xs shrink-0" style="background:${targetCh?.color || targetColor}"></span>
          <span class="font-semibold truncate" style="color:${targetColor}">${escapeHtml(targetCh?.name || '目标通道')}</span>
        </div>
        <div class="flex justify-between"><span style="color:${targetColor}">Y1:</span><span class="font-semibold" style="color:${targetColor}">${escapeHtml(y1 !== null ? formatEng(y1, unit, 2) : '--')}</span></div>
        <div class="flex justify-between"><span style="color:${targetColor}">Y2:</span><span class="font-semibold" style="color:${targetColor}">${escapeHtml(y2 !== null ? formatEng(y2, unit, 2) : '--')}</span></div>
        <div class="flex justify-between"><span class="text-slate-400">ΔY:</span><span class="font-bold" style="color:${targetColor}">${escapeHtml(dy !== null ? formatEng(dy, unit, 2) : '--')}</span></div>
        <div class="flex justify-between"><span class="text-slate-400">ΔY/ΔX:</span><span class="font-semibold" style="color:${targetColor}">${escapeHtml(slope)}</span></div>
      `;
    }
    html += '</div>';
    grid.innerHTML = html;
  }

  public renderSidebar(): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    this.ensureTabDefaults(tab);

    // Toggle FFT & XY sidebar panels
    const fftPanel = document.getElementById('fftSidebarPanel');
    if (fftPanel) {
      fftPanel.style.display = tab.plotMode === 'frequency' ? 'block' : 'none';
    }
    const xyPanel = document.getElementById('xySidebarPanel');
    if (xyPanel) {
      xyPanel.style.display = tab.plotMode === 'xy' ? 'block' : 'none';
      if (tab.plotMode === 'xy') {
        const xSel = document.getElementById('xyXChannelSelect') as HTMLSelectElement | null;
        const ySel = document.getElementById('xyYChannelSelect') as HTMLSelectElement | null;
        const rSel = document.getElementById('xyRangeSelect') as HTMLSelectElement | null;
        [xSel, ySel].forEach((sel, selIdx) => {
          if (!sel) return;
          const targetId =
            selIdx === 0
              ? tab.xyConfig?.xChannelId || tab.drawOrder[0]
              : tab.xyConfig?.yChannelId || tab.drawOrder[1] || tab.drawOrder[0];
          sel.innerHTML = '';
          tab.drawOrder.forEach((id, idx) => {
            const ch = tab.channels[id];
            if (!ch) return;
            const opt = document.createElement('option');
            opt.value = id;
            opt.text = ch.isMath ? `[M] ${ch.name}` : `CH${idx + 1}: ${ch.name}`;
            if (id === targetId) opt.selected = true;
            sel.appendChild(opt);
          });
        });
        if (rSel && tab.xyConfig) rSel.value = tab.xyConfig.range;

        const xyReadout = document.getElementById('xyMetricsReadout');
        const xCh = tab.channels[tab.xyConfig?.xChannelId || tab.drawOrder[0]];
        const yCh = tab.channels[tab.xyConfig?.yChannelId || tab.drawOrder[1] || tab.drawOrder[0]];
        if (xyReadout && xCh && yCh) {
          const rangeMode = tab.xyConfig?.range || 'view';
          if (rangeMode === 'cursors' && (!tab.cursors.enabled || tab.cursors.x1 === null || tab.cursors.x2 === null)) {
            xyReadout.innerHTML = `
              <div class="flex justify-between"><span>Status / Cov:</span><span class="text-amber-300">NO CURSOR</span></div>
              <div class="flex justify-between"><span>X Span:</span><span>--</span></div>
              <div class="flex justify-between"><span>Y Span:</span><span>--</span></div>
              <div class="flex justify-between"><span>Circle Fit Qual:</span><span class="text-slate-400">--</span></div>
              <div class="flex justify-between"><span>Lissajous ΔΦ:</span><span class="text-slate-400">--</span></div>
              <div class="text-[10px] text-amber-300 leading-snug pt-0.5">当前 XY 范围设为 Cursors，但 X1/X2 光标未启用；已阻断回退到整段轨迹。</div>
            `;
          } else {
            let xyT0: number | undefined;
            let xyT1: number | undefined;
            if (rangeMode === 'cursors' && tab.cursors.enabled && tab.cursors.x1 !== null && tab.cursors.x2 !== null) {
              xyT0 = Math.min(tab.cursors.x1, tab.cursors.x2);
              xyT1 = Math.max(tab.cursors.x1, tab.cursors.x2);
            } else if (rangeMode === 'view') {
              const baseCh = tab.channels[tab.drawOrder[0]] || xCh;
              if (baseCh.t.length >= 2) {
                const s = Math.max(0, Math.min(baseCh.t.length - 1, tab.view.startIndex));
                const e = Math.max(s + 1, Math.min(baseCh.t.length, tab.view.endIndex));
                xyT0 = baseCh.t[s];
                xyT1 = baseCh.t[e - 1];
              }
            }
            const m = computeXYAlignedTrajectory(xCh, yCh, xyT0, xyT1).metrics;
            const phaseTxt =
              m.lissajousPhaseDeg !== null
                ? `${m.lissajousPhaseDeg > 0 ? '+' : ''}${m.lissajousPhaseDeg.toFixed(1)}°${m.isNonSinusoidal ? ' (基波)' : ''}`
                : '--';
            const fitQualTxt =
              m.circleFitQualityPct !== null
                ? `${m.circleFitQualityPct.toFixed(1)}% (Err ${m.circleFitErrorPct !== null ? m.circleFitErrorPct.toFixed(1) : '--'}%)`
                : m.trajectoryShapeHint === 'open_arc'
                ? '开弧 (未闭合)'
                : '--';
            const notes = [m.invalidReason, m.circleFitNote, m.phaseNote].filter((v): v is string => Boolean(v));
            xyReadout.innerHTML = `
              <div class="flex justify-between"><span>Status / Cov:</span><span class="${m.valid ? 'text-emerald-300' : 'text-amber-300'}">${escapeHtml(m.valid ? `OK (${m.coveragePct.toFixed(0)}%)` : m.status)}</span></div>
              <div class="flex justify-between"><span>X Span:</span><span>${escapeHtml(m.valid ? formatEng(m.xMax - m.xMin, xCh.unit, 2) : '--')}</span></div>
              <div class="flex justify-between"><span>Y Span:</span><span>${escapeHtml(m.valid ? formatEng(m.yMax - m.yMin, yCh.unit, 2) : '--')}</span></div>
              <div class="flex justify-between"><span>Circle Fit Qual:</span><span class="text-cyan-300">${escapeHtml(fitQualTxt)}</span></div>
              <div class="flex justify-between"><span>Lissajous ΔΦ:</span><span class="text-amber-300">${escapeHtml(phaseTxt)}</span></div>
              ${notes.length > 0 ? `<div class="text-[10px] text-amber-300 leading-snug pt-0.5">${notes.map((n) => escapeHtml(n)).join('<br/>')}</div>` : ''}
            `;
          }
        }
      }
    }

    // Bottom Channel Softkeys
    this.renderSoftkeysOnly(tab);

    // 1. Vertical Control Panel
    const activeChSel = document.getElementById('activeChannelSelect') as HTMLSelectElement;
    const activeCh = tab.channels[tab.activeChannelId || tab.drawOrder[0]];
    if (activeChSel) {
      activeChSel.innerHTML = '';
      tab.drawOrder.forEach((id, idx) => {
        const ch = tab.channels[id];
        if (!ch) return;
        const opt = document.createElement('option');
        opt.value = id;
        opt.text = ch.isMath ? `[M] ${ch.name}` : `CH${idx + 1}: ${ch.name}`;
        if (id === activeCh?.id) opt.selected = true;
        activeChSel.appendChild(opt);
      });
    }

    if (activeCh) {
      const colorInp = document.getElementById('activeChannelColor') as HTMLInputElement;
      if (colorInp) colorInp.value = activeCh.color;

      const visBtn = document.getElementById('activeChVisibleBtn');
      if (visBtn) {
        visBtn.innerText = activeCh.visible ? '开启' : '关闭';
        visBtn.className = `py-1 border rounded-sm cursor-pointer ${
          activeCh.visible
            ? 'bg-emerald-950/50 border-emerald-600/60 text-emerald-300 font-semibold'
            : 'bg-[#0c0f13] border-[#222933] text-slate-500'
        }`;
      }

      const coupBtn = document.getElementById('activeChCouplingBtn');
      if (coupBtn) {
        coupBtn.innerText = activeCh.coupling || 'DC';
        coupBtn.className = `py-1 border rounded-sm cursor-pointer ${
          activeCh.coupling === 'AC'
            ? 'bg-amber-950/50 border-amber-500/60 text-amber-300 font-semibold'
            : 'bg-[#0c0f13] border-[#222933] text-slate-200'
        }`;
      }

      const invBtn = document.getElementById('activeChInvertBtn');
      if (invBtn) {
        invBtn.className = `py-1 border rounded-sm cursor-pointer ${
          activeCh.inverted
            ? 'bg-purple-950/60 border-purple-500/70 text-purple-200 font-semibold'
            : 'bg-[#0c0f13] border-[#222933] text-slate-400'
        }`;
      }

      this.syncVerticalPanelOnly(activeCh);
    }

    // 2. Cursors Panel
    const curChSel = document.getElementById('cursorChannelSelect') as HTMLSelectElement;
    if (curChSel) {
      const targetCurId = tab.cursors.trackingChannel || tab.activeChannelId || tab.drawOrder[0];
      curChSel.innerHTML = '';
      tab.drawOrder.forEach((id, idx) => {
        const ch = tab.channels[id];
        if (!ch) return;
        const opt = document.createElement('option');
        opt.value = id;
        opt.text = ch.isMath ? `[M] ${ch.name}` : `CH${idx + 1}: ${ch.name}`;
        if (id === targetCurId) opt.selected = true;
        curChSel.appendChild(opt);
      });
    }
    this.renderCursorReadoutOnly(tab);

    // 4. File / Sampling Quality Summary
    const fileSummaryEl = document.getElementById('fileSummaryPanel');
    if (fileSummaryEl) {
      const primaryCh = tab.channels[tab.drawOrder[0]];
      const meta = primaryCh?.metadata;
      const sampleRateStr = primaryCh?.fs ? formatEng(primaryCh.fs, 'S/s', 3) : 'Non-uniform';
      const durationStr = primaryCh ? formatEng(primaryCh.t[primaryCh.t.length - 1] - primaryCh.t[0], 's', 3) : '0 s';
      const qualityBadge = meta
        ? meta.qualityStatus === 'uniform'
          ? '<span class="text-emerald-400 font-semibold">Uniform</span>'
          : meta.qualityStatus === 'non-uniform'
          ? '<span class="text-amber-300 font-semibold">Non-uniform</span>'
          : '<span class="text-red-400 font-semibold">Severe Jitter</span>'
        : 'N/A';
      const provenanceLabels: Record<string, string> = {
        measured: 'Measured input',
        derived_estimate: 'Model-derived estimate',
        synthetic_steady_state: 'Synthetic steady-state',
        simulated_switching: 'Simulated switching',
      };
      const provenanceLabel = meta?.dataProvenance
        ? provenanceLabels[meta.dataProvenance] || 'Unverified source'
        : 'Unverified / unspecified';
      const provenanceClass = meta?.dataProvenance === 'measured'
        ? 'text-emerald-300'
        : meta?.dataProvenance === 'derived_estimate' || meta?.dataProvenance === 'synthetic_steady_state'
        ? 'text-amber-300'
        : 'text-slate-400';

      fileSummaryEl.innerHTML = `
        <div class="flex justify-between py-0.5"><span class="text-slate-400">File</span><span class="font-mono text-slate-200 truncate max-w-[175px]" title="${escapeHtml(tab.fileName)}">${escapeHtml(tab.fileName)}</span></div>
        <div class="flex justify-between py-0.5"><span class="text-slate-400">Samples</span><span class="font-mono text-slate-200">${primaryCh?.v.length.toLocaleString() || 0}</span></div>
        <div class="flex justify-between py-0.5"><span class="text-slate-400">Rate</span><span class="font-mono text-slate-200">${escapeHtml(sampleRateStr)}${meta?.syntheticClockUsed ? ' (10k默认)' : ''}</span></div>
        <div class="flex justify-between py-0.5"><span class="text-slate-400">Duration</span><span class="font-mono text-slate-200">${escapeHtml(durationStr)}</span></div>
        <div class="flex justify-between py-0.5"><span class="text-slate-400">Timing</span><span>${qualityBadge}${meta?.resampledFromNonUniform ? ' <span class="text-cyan-300 text-[10px]">(Resampled)</span>' : ''}</span></div>
        <div class="flex justify-between py-0.5 gap-2"><span class="text-slate-400">Primary source</span><span class="font-semibold text-right ${provenanceClass}">${escapeHtml(provenanceLabel)}</span></div>
        ${meta?.sourceModel ? `<div class="flex justify-between py-0.5 gap-2"><span class="text-slate-400">Model</span><span class="font-mono text-slate-300 text-right truncate max-w-[175px]" title="${escapeHtml(meta.sourceModel)}">${escapeHtml(meta.sourceModel)}</span></div>` : ''}
        ${meta && meta.jitterRms !== null ? `<div class="flex justify-between py-0.5"><span class="text-slate-400">Jitter RMS</span><span class="font-mono text-slate-200">${meta.jitterRms.toFixed(2)}%</span></div>` : ''}
        ${meta && ((meta.rawGapCount ?? meta.gapCount) > 0 || meta.gapCount > 0) ? `<div class="flex justify-between py-0.5 text-amber-300"><span>Gaps${meta.resampledFromNonUniform ? ' (raw)' : ''}</span><span class="font-mono font-semibold">${meta.rawGapCount ?? meta.gapCount}</span></div>` : ''}
        ${meta && (meta.signalNanCount || 0) > 0 ? `<div class="flex justify-between py-0.5 text-amber-300"><span>Missing/NaN</span><span class="font-mono font-semibold">${meta.signalNanCount}</span></div>` : ''}
        ${meta && (meta.nonMonotonicCount || 0) > 0 ? `<div class="flex justify-between py-0.5 text-amber-300"><span>Non-Monotonic (sorted)</span><span class="font-mono font-semibold">${meta.nonMonotonicCount}</span></div>` : ''}
      `;
    }

    // 4c. Compare Groups List (dedicated sidebar manager so overlaid refs don't clutter bottom dock or Math list)
    const cmpSection = document.getElementById('compareGroupsSidebarSection');
    const cmpBadge = document.getElementById('compareGroupsCountBadge');
    const cmpPanel = document.getElementById('compareGroupsListPanel');
    if (cmpSection && cmpPanel) {
      const cmpGroups = new Map<
        string,
        {
          name: string;
          color: string;
          targetName: string;
          members: Array<{ id: string; ch: WaveformChannel }>;
          allVisible: boolean;
        }
      >();
      tab.drawOrder.forEach((id) => {
        const ch = tab.channels[id];
        if (!ch || !ch.compareGroupId) return;
        let g = cmpGroups.get(ch.compareGroupId);
        if (!g) {
          g = {
            name: ch.compareGroupName || 'CMP',
            color: ch.compareGroupColor || ch.color,
            targetName: '',
            members: [],
            allVisible: true,
          };
          cmpGroups.set(ch.compareGroupId, g);
        }
        if (ch.compareRole === 'target') {
          g.targetName = ch.name;
        } else {
          g.members.push({ id, ch });
          if (!ch.visible) g.allVisible = false;
        }
      });

      const activeGroups = Array.from(cmpGroups.entries()).filter(([, g]) => g.members.length > 0);
      if (cmpBadge) cmpBadge.innerText = activeGroups.length.toString();

      if (activeGroups.length === 0) {
        cmpSection.classList.add('hidden');
        cmpPanel.innerHTML = '';
      } else {
        cmpSection.classList.remove('hidden');
        cmpPanel.innerHTML = '';
        activeGroups.forEach(([groupId, grp]) => {
          const card = document.createElement('div');
          card.className = 'p-2 rounded-sm bg-[#0c0f13] border border-[#222933] text-xs space-y-1.5';
          card.style.borderLeftWidth = '3px';
          card.style.borderLeftColor = grp.color;

          const grpTextColor = resolveChannelTextColor(grp.color, Boolean(this.theme.isLight));
          const headerHtml = `
            <div class="flex items-center justify-between gap-1">
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="w-2 h-2 rounded-full shrink-0" style="background:${grp.color}"></span>
                <span class="font-mono font-bold truncate" style="color:${grpTextColor}">[${escapeHtml(grp.name)}]</span>
                <span class="text-[10px] font-mono text-slate-400">×${grp.members.length}</span>
              </div>
              <div class="flex items-center gap-1 font-mono text-[10px] shrink-0">
                <button type="button" class="cmp-sb-vis px-1.5 py-0.5 bg-[#161b22] hover:bg-[#1e2530] border border-[#222933] text-slate-200 rounded-sm cursor-pointer">${grp.allVisible ? '隐藏' : '显示'}</button>
                <button type="button" class="cmp-sb-edit px-1.5 py-0.5 bg-[#161b22] hover:bg-[#1e2530] border border-[#222933] text-cyan-300 rounded-sm cursor-pointer">编辑</button>
                <button type="button" class="cmp-sb-del text-red-400 hover:text-red-300 px-1 py-0.5 cursor-pointer" title="移除比较组">✕</button>
              </div>
            </div>
            ${grp.targetName ? `<div class="text-[10px] font-mono text-slate-400 truncate">基准: <span class="text-slate-200">${escapeHtml(grp.targetName)}</span></div>` : ''}
          `;
          card.innerHTML = headerHtml;

          const membersWrap = document.createElement('div');
          membersWrap.className = 'space-y-1 pt-1 border-t border-[#1b222c] max-h-36 overflow-y-auto';
          const prefix = `[${grp.name}] `;
          grp.members.forEach(({ id, ch }) => {
            const shortName = ch.name.startsWith(prefix) ? ch.name.slice(prefix.length) : ch.name;
            const row = document.createElement('div');
            row.className = 'flex items-center justify-between gap-1 text-[11px] font-mono';
            row.innerHTML = `
              <label class="flex items-center gap-1.5 min-w-0 cursor-pointer flex-1">
                <input type="checkbox" class="cmp-m-vis cursor-pointer accent-emerald-400" ${ch.visible ? 'checked' : ''} />
                <span class="w-2 h-2 rounded-xs shrink-0" style="background:${ch.color}"></span>
                <span class="truncate text-slate-200" title="${escapeHtml(ch.name)}">${escapeHtml(shortName)}</span>
              </label>
              <button type="button" class="cmp-m-del text-slate-500 hover:text-red-400 px-1 cursor-pointer" title="Remove trace">✕</button>
            `;
            row.querySelector('.cmp-m-vis')?.addEventListener('change', (e: any) => {
              ch.visible = !!e.target.checked;
              this.renderSoftkeysOnly(tab);
              this.draw();
            });
            row.querySelector('.cmp-m-del')?.addEventListener('click', () => {
              delete tab.channels[id];
              tab.drawOrder = tab.drawOrder.filter((cid) => cid !== id);
              if (tab.activeChannelId === id) tab.activeChannelId = tab.drawOrder[0];
              this.renderSidebar();
              this.draw();
            });
            membersWrap.appendChild(row);
          });
          card.appendChild(membersWrap);

          card.querySelector('.cmp-sb-vis')?.addEventListener('click', () => this.toggleCompareGroupVisibility(groupId));
          card.querySelector('.cmp-sb-edit')?.addEventListener('click', () => this.onEditCompareGroup?.(groupId));
          card.querySelector('.cmp-sb-del')?.addEventListener('click', () => this.removeCompareGroup(groupId));
          cmpPanel.appendChild(card);
        });
      }
    }

    // 5. Math Channels List (exclude Compare Reference overlays which are managed above; hide section when empty)
    const mathSectionEl = document.getElementById('mathChannelsSidebarSection');
    const mathChannelsListEl = document.getElementById('mathChannelsListPanel');
    const mathCountBadge = document.getElementById('mathCountBadge');
    const mathChannelIds = tab.drawOrder.filter((id) => {
      const ch = tab.channels[id];
      return ch?.isMath && ch.compareRole !== 'ref';
    });

    if (mathCountBadge) mathCountBadge.innerText = mathChannelIds.length.toString();

    if (mathSectionEl && mathChannelsListEl) {
      mathChannelsListEl.innerHTML = '';
      if (mathChannelIds.length === 0) {
        mathSectionEl.classList.add('hidden');
      } else {
        mathSectionEl.classList.remove('hidden');
        mathChannelIds.forEach((id) => {
          const ch = tab.channels[id];
          if (!ch) return;
          const { voltsPerDiv } = ensureChannelScaleOffset(ch);

          const row = document.createElement('div');
          row.className = 'flex flex-col p-2 rounded-sm bg-[#0c0f13] border border-[#222933] hover:border-purple-500/50 text-xs';
          if (ch.compareGroupColor) {
            row.style.borderLeftWidth = '3px';
            row.style.borderLeftColor = ch.compareGroupColor;
          }
          const grpBadgeHtml = ch.compareGroupName
            ? `<span class="text-[9px] font-mono font-bold px-1 rounded-xs border shrink-0" style="color:${ch.compareGroupColor || ch.color};border-color:${ch.compareGroupColor || ch.color}">${escapeHtml(ch.compareGroupName)}</span>`
            : '';
          const badgeTxt = escapeHtml(ch.derivedBadge || 'fx');
          const safeMathChName = escapeHtml(ch.name);
          const safeMathExpr = escapeHtml(ch.mathExpression || '');
          row.innerHTML = `
            <div class="flex items-center justify-between gap-1">
              <div class="flex items-center gap-1.5 overflow-hidden">
                <input type="checkbox" class="ch-vis-chk cursor-pointer accent-purple-400" ${ch.visible ? 'checked' : ''} />
                <span class="w-4 h-0 border-t-2 border-dashed shrink-0" style="border-color:${ch.color}"></span>
                <span class="text-[9px] font-mono px-1 rounded-xs border border-purple-500/40 text-purple-300 shrink-0">[${badgeTxt}]</span>
                ${grpBadgeHtml}
                <span class="font-medium text-purple-200 truncate max-w-[92px]" title="${safeMathChName}">${safeMathChName}</span>
              </div>
              <div class="flex items-center gap-1 font-mono text-[10px] shrink-0">
                <button class="ch-fit-btn px-1.5 py-0.5 bg-[#161b22] hover:bg-[#1e2530] border border-[#222933] text-slate-300 rounded-sm cursor-pointer">适配</button>
                <button class="ch-fft-btn px-1.5 py-0.5 bg-[#1d1729] hover:bg-[#2b2040] border border-purple-700/60 text-purple-200 rounded-sm cursor-pointer">FFT</button>
                <button class="ch-del-btn text-red-400 hover:text-red-300 px-1 py-0.5 cursor-pointer" title="Delete math channel">✕</button>
              </div>
            </div>
            <div class="flex justify-between items-center text-[10px] text-slate-400 mt-1 font-mono tabular-nums">
              <span class="truncate max-w-[165px] text-purple-300/80" title="${safeMathExpr}">${safeMathExpr || 'Math'}</span>
              <span>${escapeHtml(formatEng(voltsPerDiv, ch.unit, 1))}/div</span>
            </div>
          `;

          row.querySelector('.ch-vis-chk')?.addEventListener('change', (e: any) => {
            ch.visible = e.target.checked;
            this.renderSoftkeysOnly(tab);
            this.draw();
          });

          row.querySelector('.ch-fft-btn')?.addEventListener('click', () => {
            this.analyzeChannelWithFFT(id);
          });

          row.querySelector('.ch-fit-btn')?.addEventListener('click', () => {
            fitChannelTo125(ch);
            this.renderSidebar();
            this.draw();
          });

          row.querySelector('.ch-del-btn')?.addEventListener('click', () => {
            delete tab.channels[id];
            tab.drawOrder = tab.drawOrder.filter((chId) => chId !== id);
            if (tab.activeChannelId === id) tab.activeChannelId = tab.drawOrder[0];
            if (tab.selectedMeasurementChannelId === id) tab.selectedMeasurementChannelId = tab.drawOrder[0];
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

    // 6. FFT channel selector
    const fftChannelSel = document.getElementById('fftChannelSelect') as HTMLSelectElement;
    if (fftChannelSel) {
      const selectedFftId = tab.selectedFftChannelId || tab.drawOrder[0];
      fftChannelSel.innerHTML = '';
      tab.drawOrder.forEach((id, idx) => {
        const ch = tab.channels[id];
        if (ch) {
          const opt = document.createElement('option');
          opt.value = id;
          opt.text = ch.isMath ? `[M] ${ch.name}` : `CH${idx + 1}: ${ch.name}`;
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

    this.renderMeasurementStrip(tab);
    this.updateScreenTelemetry();
  }

  private getCachedMeasurements(tab: TabState, ch: WaveformChannel): ChannelMeasurements {
    const curKey = tab.measurementGate === 'cursors' ? `${tab.cursors.x1}_${tab.cursors.x2}` : '';
    const key = `${tab.id}_${ch.id}_${tab.measurementGate}_${tab.view.startIndex}_${tab.view.endIndex}_${curKey}_${ch.coupling}_${ch.inverted}_${ch.timeShiftSec || 0}_${this.editVersion}`;
    const existing = this.measCache[ch.id];
    if (existing && existing.key === key) {
      return existing.value;
    }
    const primaryCh = tab.channels[tab.drawOrder[0]] || Object.values(tab.channels)[0];
    const hasCustomTime = Boolean(
      primaryCh &&
        ch !== primaryCh &&
        (ch.t !== primaryCh.t || ch.t.length !== primaryCh.t.length || (ch.timeShiftSec || 0) !== 0)
    );
    const viewBounds = hasCustomTime && primaryCh ? getTimeBoundsForView(tab, primaryCh) : undefined;
    const computed = computeMeasurements(
      ch,
      tab.measurementGate,
      tab.view,
      tab.cursors,
      viewBounds ? { tStart: viewBounds.tStart, tEnd: viewBounds.tEnd } : undefined
    );
    this.measCache[ch.id] = { key, value: computed };
    return computed;
  }

  private getCachedCustomMeasurementValue(
    tab: TabState,
    ch: WaveformChannel,
    customDef: CustomMeasurementDefinition,
    meas: ChannelMeasurements
  ): CustomMeasurementDetailedResult {
    const curKey = tab.measurementGate === 'cursors' ? `${tab.cursors.x1}_${tab.cursors.x2}` : '';
    const cacheKey = `${tab.id}_${ch.id}_${tab.measurementGate}_${tab.view.startIndex}_${tab.view.endIndex}_${curKey}_${ch.coupling}_${ch.inverted}_${ch.timeShiftSec || 0}_${this.editVersion}`;
    let entry = this.customMeasCache[ch.id];
    if (!entry || entry.key !== cacheKey) {
      entry = { key: cacheKey, values: {} };
      this.customMeasCache[ch.id] = entry;
    }
    const exprKey = `${customDef.id}:${customDef.expression}`;
    if (Object.prototype.hasOwnProperty.call(entry.values, exprKey)) {
      return entry.values[exprKey];
    }
    const primaryCh = tab.channels[tab.drawOrder[0]] || Object.values(tab.channels)[0];
    const hasCustomTime = Boolean(
      primaryCh &&
        ch !== primaryCh &&
        (ch.t !== primaryCh.t || ch.t.length !== primaryCh.t.length || (ch.timeShiftSec || 0) !== 0)
    );
    const viewBounds = hasCustomTime && primaryCh ? getTimeBoundsForView(tab, primaryCh) : undefined;
    const detail = evaluateCustomMeasurementDetailed(
      customDef,
      ch,
      meas,
      tab.measurementGate,
      tab.view,
      tab.cursors,
      viewBounds ? { tStart: viewBounds.tStart, tEnd: viewBounds.tEnd } : undefined
    );
    entry.values[exprKey] = detail;
    return detail;
  }

  private lastMeasStripKey: string = '';
  private showMeasurementStats: boolean = false;

  public toggleMeasurementStats(): boolean {
    this.showMeasurementStats = !this.showMeasurementStats;
    const tab = this.getActiveTab();
    if (tab) this.renderMeasurementStrip(tab);
    return this.showMeasurementStats;
  }

  public async copyMeasurementStripTable(): Promise<boolean> {
    const tab = this.getActiveTab();
    if (!tab || !tab.selectedMeasurements || tab.selectedMeasurements.length === 0) {
      this.showToast('当前测量条为空，请先勾选测量项。', 'warn');
      return false;
    }
    const header = ['Channel', 'Metric', 'Value', 'Mean', 'Min', 'Max', 'StdDev', 'Cycles(N)', 'Gate'];
    const lines: string[] = [header.join('\t')];
    for (const item of tab.selectedMeasurements) {
      const ch = tab.channels[item.channelId];
      if (!ch) continue;
      const m = this.getCachedMeasurements(tab, ch);
      if (typeof item.metric === 'string' && item.metric.startsWith('custom:')) {
        const customDef = (tab.customMeasurements || []).find((c) => c.id === item.metric.slice(7));
        if (!customDef) continue;
        const detail = this.getCachedCustomMeasurementValue(tab, ch, customDef, m);
        const valStr = formatCustomMeasurementValue(detail.value, customDef, ch.unit);
        lines.push([ch.name, customDef.shortLabel || customDef.label, valStr, '--', '--', '--', '--', '--', tab.measurementGate].join('\t'));
      } else {
        const def = MEASUREMENT_DEFINITIONS.find((d) => d.key === item.metric);
        if (!def) continue;
        const valStr = formatMeasurementMetricValue(m, def, ch.unit);
        const stat = m.cycleStats?.[def.key];
        const meanStr = stat ? formatMetricScalarValue(stat.mean, def.unitType, ch.unit) : '--';
        const minStr = stat ? formatMetricScalarValue(stat.min, def.unitType, ch.unit) : '--';
        const maxStr = stat ? formatMetricScalarValue(stat.max, def.unitType, ch.unit) : '--';
        const stdStr = stat ? formatMetricScalarValue(stat.stdDev, def.unitType, ch.unit) : '--';
        const nStr = stat ? String(stat.count) : '--';
        lines.push([ch.name, def.shortLabel, valStr, meanStr, minStr, maxStr, stdStr, nStr, tab.measurementGate].join('\t'));
      }
    }
    const tsv = lines.join('\n');
    try {
      await navigator.clipboard.writeText(tsv);
      this.showToast(`已复制 ${lines.length - 1} 项测量统计表（可直接粘贴到 Excel）。`, 'info');
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = tsv;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      this.showToast(`已复制 ${lines.length - 1} 项测量统计表。`, 'info');
      return true;
    }
  }

  public renderMeasurementStrip(tab: TabState): void {
    const bar = document.getElementById('measurementStripBar');
    const container = document.getElementById('measurementCardsContainer');
    const gateSel = document.getElementById('stripMeasGateSelect') as HTMLSelectElement;
    const statsBtn = document.getElementById('stripMeasStatsToggleBtn');
    if (!bar || !container) return;

    if (statsBtn) {
      statsBtn.className = this.showMeasurementStats
        ? 'px-2 py-0.5 bg-cyan-600/25 border border-cyan-500/70 text-cyan-200 rounded-sm cursor-pointer whitespace-nowrap font-semibold'
        : 'px-2 py-0.5 bg-[#161b22] hover:bg-[#1e2530] border border-[#222933] text-slate-300 rounded-sm cursor-pointer whitespace-nowrap';
    }

    const items = tab.selectedMeasurements || [];
    if (items.length === 0) {
      if (this.lastMeasStripKey !== 'empty') {
        this.lastMeasStripKey = 'empty';
        bar.classList.add('hidden');
        container.innerHTML = '';
      }
      return;
    }

    const curKey = tab.measurementGate === 'cursors' ? `${tab.cursors.x1}_${tab.cursors.x2}` : '';
    const customDefsKey = (tab.customMeasurements || []).map((c) => `${c.id}:${c.expression}:${c.shortLabel}`).join(';');
    const itemsKey = items.map((i) => `${i.id}:${i.channelId}:${i.metric}:${tab.channels[i.channelId]?.color || ''}`).join('|');
    const stripKey = `${tab.id}_${this.themeId}_${tab.measurementGate}_${tab.view.startIndex}_${tab.view.endIndex}_${curKey}_${this.editVersion}_${this.showMeasurementStats ? 1 : 0}_${itemsKey}_${customDefsKey}`;
    if (this.lastMeasStripKey === stripKey) return;
    this.lastMeasStripKey = stripKey;

    bar.classList.remove('hidden');
    if (gateSel) gateSel.value = tab.measurementGate;

    const isLight = Boolean(this.theme.isLight);
    container.innerHTML = '';
    for (const item of items) {
      const ch = tab.channels[item.channelId];
      if (!ch) continue;
      const m = this.getCachedMeasurements(tab, ch);
      const chTextColor = resolveChannelTextColor(ch.color, isLight);

      let shortLabel = '';
      let valStr = '';
      let statsLineHtml = '';
      let cardInvalid = m.valid === false;
      let statusBadge: string | null = m.valid === false
        ? (m.status === 'NO_OVERLAP'
            ? 'NO OVERLAP'
            : m.status === 'INSUFFICIENT_DATA'
            ? 'NO DATA'
            : 'INVALID')
        : null;
      let statusTip = m.statusMessage || '';

      if (typeof item.metric === 'string' && item.metric.startsWith('custom:')) {
        const customId = item.metric.slice(7);
        const customDef = (tab.customMeasurements || []).find((c) => c.id === customId);
        if (!customDef) continue;
        const customDetail = this.getCachedCustomMeasurementValue(tab, ch, customDef, m);
        shortLabel = customDef.shortLabel || customDef.label;
        valStr = formatCustomMeasurementValue(customDetail.value, customDef, ch.unit);
        if (!customDetail.valid) {
          cardInvalid = true;
          statusBadge =
            customDetail.status === 'NO_OVERLAP'
              ? 'NO OVERLAP'
              : customDetail.status === 'INSUFFICIENT_DATA'
              ? 'NO DATA'
              : customDetail.status === 'EVAL_ERROR'
              ? 'EVAL ERR'
              : 'INVALID';
          statusTip = customDetail.reason || statusTip;
        }
      } else {
        const def = MEASUREMENT_DEFINITIONS.find((d) => d.key === item.metric);
        if (!def) continue;
        shortLabel = def.shortLabel;
        valStr = formatMeasurementMetricValue(m, def, ch.unit);
        if (this.showMeasurementStats && !cardInvalid) {
          const st = m.cycleStats?.[def.key];
          if (st && st.count >= 2) {
            const minS = formatMetricScalarValue(st.min, def.unitType, ch.unit);
            const maxS = formatMetricScalarValue(st.max, def.unitType, ch.unit);
            const stdS = formatMetricScalarValue(st.stdDev, def.unitType, ch.unit);
            statsLineHtml = `<span class="text-[9px] font-mono text-slate-400 tabular-nums mt-0.5">Min ${escapeHtml(minS)} · Max ${escapeHtml(maxS)} · σ ${escapeHtml(stdS)} (N=${st.count})</span>`;
          } else if (st && st.count === 1) {
            statsLineHtml = `<span class="text-[9px] font-mono text-slate-500 tabular-nums mt-0.5">单周期 (N=1)</span>`;
          }
        }
      }

      const card = document.createElement('div');
      const isComputed = isComputedChannel(ch);
      card.className = 'flex items-center gap-2 px-2.5 py-1 bg-[#12161c] border border-[#222933] rounded-sm text-[11px] shrink-0';
      card.style.borderTopWidth = '2px';
      card.style.borderTopStyle = isComputed ? 'dashed' : 'solid';
      card.style.borderTopColor = ch.color;
      if (statusTip) {
        card.title = statusTip;
      }

      const fxTag = isComputed ? `<span class="text-[9px] font-mono text-purple-300 mr-1">[${escapeHtml(ch.derivedBadge || 'fx')}]</span>` : '';
      const warnTag =
        cardInvalid
          ? `<span class="text-[9px] font-mono text-amber-400 ml-1" title="${escapeHtml(statusTip || '无效窗口')}">[${escapeHtml(statusBadge || 'INVALID')}]</span>`
          : (m.gapCount || 0) > 0
          ? `<span class="text-[9px] font-mono text-amber-300 ml-1" title="跨越 ${m.gapCount} 个时间缺口分段计算">[${m.gapCount}g]</span>`
          : '';
      const valStyle = cardInvalid ? '' : `style="color:${chTextColor}"`;
      card.innerHTML = `
        <div class="flex flex-col leading-tight">
          <span class="flex items-center gap-1 text-[10px] text-slate-400 truncate max-w-[175px]">
            <span class="w-1.5 h-1.5 rounded-xs shrink-0" style="background:${ch.color}"></span>
            ${fxTag}<span class="font-medium" style="color:${chTextColor}">${escapeHtml(ch.name)}</span>
            <span>· ${escapeHtml(shortLabel)}</span>${warnTag}
          </span>
          <span class="font-mono font-bold text-[12px] ${cardInvalid ? 'text-amber-300' : ''} tabular-nums" ${valStyle}>${escapeHtml(valStr)}</span>
          ${statsLineHtml}
        </div>
        <button class="meas-card-remove text-slate-500 hover:text-red-300 px-0.5 font-mono cursor-pointer" title="移除测量项">×</button>
      `;

      card.querySelector('.meas-card-remove')?.addEventListener('click', () => {
        this.removeMeasurementSelection(item.id);
      });

      container.appendChild(card);
    }
  }

  public getChannelMeasurementsSnapshot(tab: TabState, ch: WaveformChannel): ChannelMeasurements {
    return this.getCachedMeasurements(tab, ch);
  }

  private updateStatusBar(): void {
    const tab = this.getActiveTab();
    const statusEl = document.getElementById('statusBarContent');
    if (!statusEl) return;

    if (!tab) {
      statusEl.innerText = '就绪';
      return;
    }

    const mode =
      tab.plotMode === 'frequency'
        ? 'FFT 频谱'
        : tab.plotMode === 'xy'
        ? 'XY 李萨如'
        : tab.separateView
        ? '分栏视图'
        : '叠加视图';
    const toolMap: Record<string, string> = {
      areaZoom: '框选缩放',
      pointAnnotate: '标点标注',
      textAnnotate: '文本标注',
      areaAnnotate: '框测标注',
    };
    const tool = tab.activeTool && tab.activeTool !== 'pan' ? ` · 工具: ${toolMap[tab.activeTool] || tab.activeTool}` : '';
    const activeCh = tab.channels[tab.activeChannelId || tab.drawOrder[0]];
    const activeHtml = activeCh
      ? ` · 当前通道: <span style="color:${resolveChannelTextColor(activeCh.color, Boolean(this.theme.isLight))};font-weight:600">${escapeHtml(activeCh.name)}</span>`
      : '';

    statusEl.innerHTML = `<span>[${mode}] ${escapeHtml(tab.fileName)}</span>${activeHtml}<span>${escapeHtml(tool)}</span>`;
  }

  // --- Export Operations ---
  public exportEngineeringReport(): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    try {
      const dpr = window.devicePixelRatio || 1;
      const width = this.canvas.width / dpr || 1200;
      const height = this.canvas.height / dpr || 640;
      const goldenEval = this.getGoldenEvaluation(tab);
      const html = buildEngineeringReportHTML(
        tab,
        width,
        height,
        this.cachedSpectrum,
        goldenEval,
        tab.activeAnomalies,
        this.theme
      );
      const filename = downloadEngineeringReportHTML(html, tab.fileName);
      this.showToast(`已导出工程报告 ${filename}（在浏览器中打开即可打印/另存 PDF）。`, 'info');
    } catch (err: any) {
      this.showToast(`导出工程报告失败：${err.message}`, 'error');
    }
  }

  public exportPNG(): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    try {
      const dpr = window.devicePixelRatio || 1;
      const width = this.canvas.width / dpr || 1200;
      const height = this.canvas.height / dpr || 640;
      const file = captureCompositeScopePNG(tab, width, height, this.cachedSpectrum, this.theme);
      this.showToast(`已保存截图 ${file}`, 'info');
    } catch (err: any) {
      this.showToast(`截图失败：${err.message}`, 'error');
    }
  }

  public exportSVG(): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.width / dpr || 1200;
    const height = this.canvas.height / dpr || 640;
    const svgStr = generateWaveformSVG(tab, width, height, this.theme, this.cachedSpectrum);
    const blob = new Blob([svgStr], { type: 'image/svg+xml' });
    const link = document.createElement('a');
    link.download = `${tab.fileName}_scope.svg`;
    link.href = URL.createObjectURL(blob);
    link.click();
  }

  public exportWaveformCSV(): void {
    const tab = this.getActiveTab();
    if (!tab) return;

    const visibleChs = tab.drawOrder.map((id) => tab.channels[id]).filter((c) => c && c.visible);
    if (visibleChs.length === 0) return;

    // Choose a reference grid spanning the longest duration, or baseCh if identical grids
    let refCh = visibleChs[0];
    let maxSpan = refCh.t.length > 1 ? refCh.t[refCh.t.length - 1] - refCh.t[0] : 0;
    for (const ch of visibleChs) {
      const span = ch.t.length > 1 ? ch.t[ch.t.length - 1] - ch.t[0] : 0;
      if (span > maxSpan || (Math.abs(span - maxSpan) < 1e-15 && ch.t.length > refCh.t.length)) {
        maxSpan = span;
        refCh = ch;
      }
    }

    const n = refCh.t.length;
    const headerCells = ['Time(s)', ...visibleChs.map((c) => escapeCsvCell(`${c.name} (${c.unit || 'V'})`))];
    const lines: string[] = [headerCells.join(',')];

    for (let i = 0; i < n; i++) {
      const timeSec = refCh.t[i];
      if (!Number.isFinite(timeSec)) continue;
      const row = [timeSec.toExponential(6)];
      for (const ch of visibleChs) {
        let val: number | null;
        if (ch === refCh || (ch.t === refCh.t && ch.v.length === refCh.v.length)) {
          val = i < ch.v.length && Number.isFinite(ch.v[i]) ? ch.v[i] : null;
        } else {
          val = sampleChannelValueAtTime(ch, timeSec);
        }
        row.push(val !== null && Number.isFinite(val) ? val.toFixed(6) : '');
      }
      lines.push(row.join(','));
    }

    const csv = lines.join('\n') + '\n';
    const blob = new Blob([csv], { type: 'text/csv' });
    const link = document.createElement('a');
    link.download = `${tab.fileName}_waveform.csv`;
    link.href = URL.createObjectURL(blob);
    link.click();
  }

  public exportSpectrumCSV(): void {
    if (!this.cachedSpectrum) {
      this.showToast('请先切换到「频谱」模式以计算 FFT 数据。', 'warn');
      return;
    }

    const s = this.cachedSpectrum;
    const magUnit = s.sourceUnit || 'V';
    let csv = `${['Frequency(Hz)', escapeCsvCell(`Magnitude(${magUnit})`), 'Magnitude(dB)'].join(',')}\n`;
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
    if (this.tabs.length === 0) {
      this.showToast('当前没有可保存的波形标签页。', 'warn');
      return;
    }
    const json = serializeSession(this.tabs, this.activeTabIndex);
    const blob = new Blob([json], { type: 'application/json' });
    const link = document.createElement('a');
    link.download = `waveform_session_${Date.now()}.graphx`;
    link.href = URL.createObjectURL(blob);
    link.click();
  }
}
