/**
 * Waveform Viewer Pro - Main Entry Point
 * Initializes hardware-grade Web Oscilloscope workspace, binds all front-panel
 * vertical, horizontal, trigger, cursor, annotation, FFT, Math, and export controls.
 */

import './index.css';
import { OscilloscopeApp } from './engine/uiController';
import { runAllTests } from './tests/testSuite';
import { TabState, WaveformChannel, CursorMode, MeasurementGate, MeasurementMetricKey, ThemeId } from './types/models';
import { formatEng, getTimeBoundsForView, isComputedChannel } from './engine/canvasRenderer';
import { getSavedThemeId } from './modules/themeManager';
import { LtspiceFileWatcher } from './modules/ltspiceWatcher';
import { setupToolDrawer } from './modules/toolDrawer';
import { fitChannelTo125 } from './modules/oscilloscopeScale';
import { MEASUREMENT_DEFINITIONS } from './modules/measurements';
import { estimateSpeedFromSignal, computeTwoChannelPhaseDiff } from './modules/motorAnalysis';
import { runBatchAnalysisOnFiles, exportBatchResultsCSV, BatchFileRow } from './modules/batchAnalyzer';
import {
  loadPresets,
  savePresetToStorage,
  deletePresetFromStorage,
  capturePresetFromTab,
  applyPresetToTab,
} from './modules/presetManager';
import {
  COMPARE_GROUP_THEMES,
  getCompareGroupTraceColor,
  alignAndInterpolateReference,
  computeAutoTimeAlignShift,
  computeWaveformCompareMetrics,
  parseReferenceFileToChannels,
  computeFileFingerprint,
  detectRecommendedTimeScale,
  WaveformCompareMetrics,
} from './modules/waveformCompare';
import { evaluateGoldenTolerance } from './modules/anomalyScanner';
import { setupDraggableModals } from './modules/draggableModals';
import {
  analyzeThreePhaseBalance,
  analyzeBldcHallCommutation,
  analyzePwmSwitchingAndDeadTime,
  analyzeTorqueAndCurrentRipple,
  computeBldcDerivedTraces,
} from './modules/bldcAnalysis';

let batchQueuedFiles: File[] = [];
let lastBatchRows: BatchFileRow[] = [];
const BATCH_EXPORT_METRICS: MeasurementMetricKey[] = ['vpp', 'max', 'min', 'rms', 'average', 'frequency', 'dutyCycle', 'overshoot'];

interface CompareQueueEntry {
  id: string;
  sourceKey: string;
  label: string;
  channel: WaveformChannel;
  timeShiftSec: number;
  timeScale: number;
  fingerprint?: string;
  autoScaledFrom?: number;
  customColor?: string;
  computed?: {
    alignedRefV: Float32Array;
    diffV: Float32Array;
    metrics: WaveformCompareMetrics;
    pass: boolean;
    violationCount: number;
  };
}

let externalCompareRefs: Array<{ id: string; label: string; channel: WaveformChannel; fingerprint?: string }> = [];
let compareQueue: CompareQueueEntry[] = [];
const appliedCompareGroupQueues = new Map<string, CompareQueueEntry[]>();
let selectedCompareThemeId: string = 'emerald';
let compareGroupCounter: number = 1;
let editingCompareGroupId: string | null = null;

let app: OscilloscopeApp;
let ltspiceWatcher: LtspiceFileWatcher | null = null;

function syncLtspiceWatchUI() {
  const tab = app?.getActiveTab() || null;
  const entry = ltspiceWatcher?.getEntry(tab?.id || null) || null;
  const reloadBtn = document.getElementById('reloadLtspiceBtn');
  const autoWrap = document.getElementById('ltspiceAutoWrap');
  const autoChk = document.getElementById('autoLtspiceChk') as HTMLInputElement | null;
  const badge = document.getElementById('ltspiceWatchBadge');

  if (entry) {
    reloadBtn?.classList.remove('hidden');
    if (autoWrap) {
      autoWrap.classList.remove('hidden');
      autoWrap.classList.add('inline-flex');
    }
    if (autoChk) autoChk.checked = entry.autoReload;
    if (badge) {
      badge.classList.remove('hidden');
      badge.innerText = entry.autoReload ? 'LIVE' : 'PAUSED';
    }
  } else {
    reloadBtn?.classList.add('hidden');
    if (autoWrap) {
      autoWrap.classList.add('hidden');
      autoWrap.classList.remove('inline-flex');
    }
    badge?.classList.add('hidden');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('waveformCanvas') as HTMLCanvasElement;
  if (!canvas) return;

  app = new OscilloscopeApp(canvas);

  // Apply persisted oscilloscope theme before initial draw
  const initialTheme = getSavedThemeId();
  app.setTheme(initialTheme, false);
  const themeSel = document.getElementById('themeSelect') as HTMLSelectElement | null;
  if (themeSel) themeSel.value = initialTheme;

  app.onEditCompareGroup = (groupId: string) => {
    const tab = app.getActiveTab();
    if (tab) openCompareModal(tab, groupId);
  };

  // Dockable Side-by-Side Tool Drawer + Live LTspice Watcher
  setupToolDrawer(() => app.handleResize());
  ltspiceWatcher = new LtspiceFileWatcher(
    async (tabId, file) => {
      await app.reloadTabFromFile(tabId, file);
      syncLtspiceWatchUI();
    },
    () => syncLtspiceWatchUI()
  );

  // Re-measure Compare live preview canvas when switched/shown inside Tool Drawer
  window.addEventListener('wvp-drawer-panel-shown', (ev: Event) => {
    const detail = (ev as CustomEvent<{ id: string }>).detail;
    if (detail?.id === 'compareModal') {
      requestAnimationFrame(() => {
        const tab = app.getActiveTab();
        if (tab) recomputeComparePanel(tab);
      });
    }
  });

  bindToolbarActions();
  bindFrontPanelControls();
  bindModals();
  setupDraggableModals();

  // Load 3-phase BLDC sample on startup for immediate interactive oscilloscope workspace
  loadSynthetic3PhaseMotorData();
  syncLtspiceWatchUI();

  const testResults = runAllTests();
  console.log('Oscilloscope Verification Test Results:', testResults);
});

function bindToolbarActions() {
  // Load File button + empty state quick open + LTspice Live Watch
  const fileInput = document.getElementById('fileInput') as HTMLInputElement;
  const triggerOpen = () => fileInput?.click();
  document.getElementById('loadBtn')?.addEventListener('click', triggerOpen);
  document.getElementById('emptyLoadBtn')?.addEventListener('click', triggerOpen);
  document.getElementById('emptyDemoBtn')?.addEventListener('click', () => loadSynthetic3PhaseMotorData());

  fileInput?.addEventListener('change', (e: any) => {
    if (e.target.files && e.target.files.length > 0) {
      app.handleFiles(Array.from(e.target.files));
      fileInput.value = '';
    }
  });

  document.getElementById('watchLtspiceBtn')?.addEventListener('click', async () => {
    if (!ltspiceWatcher) return;
    const res = await ltspiceWatcher.pickAndWatch(async (file) => {
      return await app.openFileDirectInTab(file);
    });
    if (!res.ok && res.reason) {
      app.showToast(res.reason, 'warn');
    } else if (res.ok) {
      app.showToast('LTspice file linked. Auto-reload on simulation rerun is active.', 'info');
    }
    syncLtspiceWatchUI();
  });

  document.getElementById('reloadLtspiceBtn')?.addEventListener('click', async () => {
    const tab = app.getActiveTab();
    if (tab && ltspiceWatcher) {
      const ok = await ltspiceWatcher.forceReload(tab.id);
      if (!ok) app.showToast('No watched LTspice file handle linked to active tab.', 'warn');
    }
  });

  document.getElementById('autoLtspiceChk')?.addEventListener('change', () => {
    const tab = app.getActiveTab();
    if (tab && ltspiceWatcher) {
      ltspiceWatcher.toggleAutoReload(tab.id);
    }
  });

  document.getElementById('tabsContainer')?.addEventListener('click', () => {
    requestAnimationFrame(() => syncLtspiceWatchUI());
  });

  // Theme Selector
  document.getElementById('themeSelect')?.addEventListener('change', (e: any) => {
    const themeId = e.target.value as ThemeId;
    app.setTheme(themeId, true);
    const cmpModal = document.getElementById('compareModal');
    if (cmpModal && cmpModal.style.display === 'flex') {
      const tab = app.getActiveTab();
      if (tab) recomputeComparePanel(tab);
    }
  });

  // Click-toggled header/toolbar dropdowns (Tools, Export, Analyze)
  const closeAllDropdowns = () => {
    document.querySelectorAll('.wvp-dropdown-menu').forEach((menu) => {
      menu.classList.add('hidden');
      menu.classList.remove('flex');
    });
  };
  document.querySelectorAll('.wvp-dropdown-trigger').forEach((trigger) => {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const parent = trigger.closest('.wvp-dropdown');
      const menu = parent?.querySelector('.wvp-dropdown-menu');
      const isCurrentlyOpen = menu ? !menu.classList.contains('hidden') : false;
      closeAllDropdowns();
      if (menu && !isCurrentlyOpen) {
        menu.classList.remove('hidden');
        menu.classList.add('flex');
      }
    });
  });
  document.querySelectorAll('.wvp-dropdown-menu button').forEach((item) => {
    item.addEventListener('click', () => closeAllDropdowns());
  });
  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement)?.closest('.wvp-dropdown')) {
      closeAllDropdowns();
    }
  });

  // Timebase H (1-2-5 s/div) & Pan
  document.getElementById('timebaseDecBtn')?.addEventListener('click', () => app.stepTimebase(-1));
  document.getElementById('timebaseIncBtn')?.addEventListener('click', () => app.stepTimebase(1));
  document.getElementById('panLeftBtn')?.addEventListener('click', () => app.panTimebase(-1));
  document.getElementById('panRightBtn')?.addEventListener('click', () => app.panTimebase(1));

  // View Mode: Time vs Frequency vs XY
  document.getElementById('timeModeBtn')?.addEventListener('click', () => app.setPlotMode('time'));
  document.getElementById('freqModeBtn')?.addEventListener('click', () => app.setPlotMode('frequency'));
  document.getElementById('xyModeBtn')?.addEventListener('click', () => app.setPlotMode('xy'));

  // Layout Mode: Overlap vs Separate
  document.getElementById('overlapViewBtn')?.addEventListener('click', () => app.setSeparateView(false));
  document.getElementById('separateViewBtn')?.addEventListener('click', () => app.setSeparateView(true));

  // Render Mode: Vector | Sin(x)/x | Dots | Vector+Markers
  document.getElementById('renderModeVectorBtn')?.addEventListener('click', () => app.setRenderMode('vector'));
  document.getElementById('renderModeSincBtn')?.addEventListener('click', () => app.setRenderMode('sinc'));
  document.getElementById('renderModeDotsBtn')?.addEventListener('click', () => app.setRenderMode('dots'));
  document.getElementById('renderModeMarkersBtn')?.addEventListener('click', () => app.setRenderMode('vector-markers'));

  // Decimation Mode: Min-Max | LTTB
  document.getElementById('decimMinMaxBtn')?.addEventListener('click', () => app.setDecimationMode('minmax'));
  document.getElementById('decimLttbBtn')?.addEventListener('click', () => app.setDecimationMode('lttb'));

  // On-Demand Modals: Measure, Edit/Ref, Crop Export
  document.getElementById('openMeasureModalBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) openMeasureModal(tab);
  });
  document.getElementById('sidebarOpenMeasureBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) openMeasureModal(tab);
  });
  document.getElementById('openEditModalBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) openWaveformEditModal(tab);
  });
  document.getElementById('openCropExportBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) openCropExportModal(tab);
  });
  document.getElementById('openCropExportMenuBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) openCropExportModal(tab);
  });

  // Dynamic Measurement Strip Actions
  document.getElementById('stripAddMeasBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) openMeasureModal(tab);
  });
  document.getElementById('stripClearMeasBtn')?.addEventListener('click', () => app.clearAllMeasurements());
  document.getElementById('stripMeasGateSelect')?.addEventListener('change', (e: any) => {
    const tab = app.getActiveTab();
    if (tab) {
      tab.measurementGate = e.target.value as MeasurementGate;
      app.renderMeasurementStrip(tab);
    }
  });

  // AutoSet, Fit, Sync Same-Unit, Undo/Redo, Zoom Box, Annotations
  document.getElementById('syncUnitScaleBtn')?.addEventListener('click', () => app.syncSameUnitScales());
  document.getElementById('sidebarSyncUnitBtn')?.addEventListener('click', () => app.syncSameUnitScales());
  document.getElementById('undoBtn')?.addEventListener('click', () => app.undo());
  document.getElementById('redoBtn')?.addEventListener('click', () => app.redo());
  document.getElementById('autoSetBtn')?.addEventListener('click', () => app.executeAutoSet());
  document.getElementById('fitViewBtn')?.addEventListener('click', () => app.fitView());
  document.getElementById('toolZoomBtn')?.addEventListener('click', () => app.setActiveTool('areaZoom'));
  document.getElementById('toolPointBtn')?.addEventListener('click', () => app.setActiveTool('pointAnnotate'));
  document.getElementById('toolTextBtn')?.addEventListener('click', () => app.setActiveTool('textAnnotate'));
  document.getElementById('toolAreaBtn')?.addEventListener('click', () => app.setActiveTool('areaAnnotate'));
  document.getElementById('clearAnnBtn')?.addEventListener('click', () => app.clearAnnotations());

  // New Analysis & Workflow Modals
  document.getElementById('openCompareModalBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) openCompareModal(tab);
  });
  document.getElementById('sidebarOpenCompareBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) openCompareModal(tab);
  });
  document.getElementById('openPhaseModalBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) openPhaseModal(tab);
  });
  document.getElementById('openBldcModalBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) openBldcModal(tab);
  });
  document.getElementById('openAnomalyModalBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) openAnomalyModal(tab);
  });
  document.getElementById('openBatchModalBtn')?.addEventListener('click', () => openBatchModal());
  document.getElementById('openPresetModalBtn')?.addEventListener('click', () => openPresetModal());
  document.getElementById('openShortcutsModalBtn')?.addEventListener('click', () => openShortcutsModal());

  // Trigger quick pill opens trigger modal
  document.getElementById('triggerQuickBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) openTriggerModal(tab);
  });

  // Math & Transform & Motor buttons
  document.getElementById('addMathBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) openMathModal(tab);
  });
  document.getElementById('sidebarAddMathBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) openMathModal(tab);
  });
  document.getElementById('transformBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) openTransformModal(tab);
  });
  document.getElementById('sidebarClarkeBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) openTransformModal(tab);
  });
  document.getElementById('motorBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) openMotorModal(tab);
  });

  // Exports, Test Report, Panel Toggle, Session, Demo & Tests
  document.getElementById('exportPngBtn')?.addEventListener('click', () => app.exportPNG());
  document.getElementById('exportReportHtmlBtn')?.addEventListener('click', () => app.exportEngineeringReport());
  document.getElementById('togglePanelBtn')?.addEventListener('click', () => app.toggleRightPanel());
  document.getElementById('exportSvgBtn')?.addEventListener('click', () => app.exportSVG());
  document.getElementById('exportCsvWaveformBtn')?.addEventListener('click', () => app.exportWaveformCSV());
  document.getElementById('exportCsvSpectrumBtn')?.addEventListener('click', () => app.exportSpectrumCSV());
  const triggerOfflineHtmlDownload = async () => {
    if (window.location.protocol === 'file:') {
      app.showToast('You are already running the standalone offline HTML file.');
      return;
    }
    try {
      let htmlText = '';
      try {
        const jsonResp = await fetch('/waveform-viewer-offline.json', { cache: 'no-store' });
        if (jsonResp.ok && (jsonResp.headers.get('content-type') || '').includes('json')) {
          const payload = await jsonResp.json();
          if (payload && typeof payload.html === 'string' && payload.html.includes('</html>')) {
            htmlText = payload.html;
          }
        }
      } catch {
        // Fallback below
      }
      if (!htmlText) {
        const resp = await fetch('/waveform-viewer-standalone.html', { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        htmlText = await resp.text();
      }
      const blob = new Blob([htmlText], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'waveform-viewer-pro.html';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      app.showToast('Downloaded standalone offline HTML (waveform-viewer-pro.html).');
    } catch (err: any) {
      app.showToast(`Offline HTML download failed: ${err?.message || 'Unavailable'}`, 'error');
    }
  };
  document.getElementById('exportStandaloneHtmlBtn')?.addEventListener('click', triggerOfflineHtmlDownload);
  document.getElementById('saveSessionBtn')?.addEventListener('click', () => app.saveSessionFile());
  document.getElementById('testSuiteBtn')?.addEventListener('click', () => openTestSuiteModal());
  document.getElementById('loadSampleSignalBtn')?.addEventListener('click', () => loadSynthetic3PhaseMotorData());
}

function bindFrontPanelControls() {
  // --- 1. Vertical Channel Controls ---
  const activeChSel = document.getElementById('activeChannelSelect') as HTMLSelectElement;
  activeChSel?.addEventListener('change', () => {
    app.selectActiveChannel(activeChSel.value);
  });

  const colorInp = document.getElementById('activeChannelColor') as HTMLInputElement;
  colorInp?.addEventListener('input', () => {
    const tab = app.getActiveTab();
    const ch = tab && tab.channels[tab.activeChannelId || ''];
    if (ch) {
      ch.color = colorInp.value;
      app.renderSidebar();
      app.draw();
    }
  });

  document.getElementById('activeChVisibleBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab?.activeChannelId) app.toggleChannelVisible(tab.activeChannelId);
  });

  document.getElementById('activeChCouplingBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab?.activeChannelId) app.toggleChannelCoupling(tab.activeChannelId);
  });

  document.getElementById('activeChInvertBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab?.activeChannelId) app.toggleChannelInvert(tab.activeChannelId);
  });

  document.getElementById('activeChFitBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab?.activeChannelId) app.fitSingleChannel(tab.activeChannelId);
  });

  document.getElementById('vDivDecBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab?.activeChannelId) app.stepChannelScale(tab.activeChannelId, -1);
  });

  document.getElementById('vDivIncBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab?.activeChannelId) app.stepChannelScale(tab.activeChannelId, 1);
  });

  const vDivSel = document.getElementById('vDivSelect') as HTMLSelectElement;
  vDivSel?.addEventListener('change', () => {
    const tab = app.getActiveTab();
    const val = parseFloat(vDivSel.value);
    if (tab?.activeChannelId && isFinite(val) && val > 0) {
      app.setChannelScale(tab.activeChannelId, val);
    }
  });

  document.getElementById('vOffsetDownBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab?.activeChannelId) app.nudgeChannelOffsetDivs(tab.activeChannelId, -0.5);
  });

  document.getElementById('vOffsetUpBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab?.activeChannelId) app.nudgeChannelOffsetDivs(tab.activeChannelId, 0.5);
  });

  document.getElementById('vOffsetZeroBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab?.activeChannelId) app.zeroChannelOffset(tab.activeChannelId);
  });

  const offsetInput = document.getElementById('vOffsetInput') as HTMLInputElement;
  offsetInput?.addEventListener('change', () => {
    const tab = app.getActiveTab();
    const val = parseFloat(offsetInput.value);
    if (tab?.activeChannelId && isFinite(val)) {
      app.setChannelOffset(tab.activeChannelId, val);
    }
  });

  const offsetSlider = document.getElementById('vOffsetSlider') as HTMLInputElement;
  offsetSlider?.addEventListener('input', () => {
    const tab = app.getActiveTab();
    const ch = tab && tab.channels[tab.activeChannelId || ''];
    if (tab && ch) {
      const divs = parseFloat(offsetSlider.value);
      const vPerDiv = ch.voltsPerDiv || (ch.vMax - ch.vMin) / 8 || 1;
      app.setChannelOffset(ch.id, divs * vPerDiv);
    }
  });

  // --- 2. Quick Trigger Controls ---
  document.getElementById('trigEnableBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    tab.triggerConfig.enabled = !tab.triggerConfig.enabled;
    app.renderSidebar();
    app.draw();
  });

  document.getElementById('trigModalOpenBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) openTriggerModal(tab);
  });

  const trigChSel = document.getElementById('trigQuickChannelSelect') as HTMLSelectElement;
  trigChSel?.addEventListener('change', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    tab.triggerConfig.channelId = trigChSel.value;
    app.renderSidebar();
    app.draw();
  });

  document.getElementById('trigQuickSlopeBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    tab.triggerConfig.type = tab.triggerConfig.type === 'rising' ? 'falling' : 'rising';
    app.renderSidebar();
    app.draw();
  });

  document.getElementById('trigAlignBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    tab.triggerConfig.enabled = true;
    app.applyTrigger();
  });

  const trigLvlInput = document.getElementById('trigQuickLevelInput') as HTMLInputElement;
  trigLvlInput?.addEventListener('change', () => {
    const tab = app.getActiveTab();
    const val = parseFloat(trigLvlInput.value);
    if (tab && isFinite(val)) {
      tab.triggerConfig.level = val;
      app.draw();
    }
  });

  document.getElementById('trigLevelDecBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    const ch = tab && tab.channels[tab.triggerConfig.channelId];
    if (tab && ch) {
      const step = (ch.voltsPerDiv || (ch.vMax - ch.vMin) / 8) * 0.25;
      tab.triggerConfig.level -= step;
      app.renderSidebar();
      app.draw();
    }
  });

  document.getElementById('trigLevelIncBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    const ch = tab && tab.channels[tab.triggerConfig.channelId];
    if (tab && ch) {
      const step = (ch.voltsPerDiv || (ch.vMax - ch.vMin) / 8) * 0.25;
      tab.triggerConfig.level += step;
      app.renderSidebar();
      app.draw();
    }
  });

  document.getElementById('trigAuto50Btn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    const ch = tab && tab.channels[tab.triggerConfig.channelId];
    if (!tab || !ch || ch.v.length === 0) return;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < ch.v.length; i++) {
      const val = ch.v[i];
      if (isFinite(val)) {
        if (val < min) min = val;
        if (val > max) max = val;
      }
    }
    if (isFinite(min) && isFinite(max)) {
      tab.triggerConfig.level = (min + max) / 2;
      tab.triggerConfig.enabled = true;
      app.applyTrigger();
      app.renderSidebar();
      app.draw();
    }
  });

  // --- 3. Cursor Mode, Center Recall & Target Channel ---
  document.querySelectorAll('.cur-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-curmode') as CursorMode;
      if (mode) app.setCursorMode(mode);
    });
  });

  document.getElementById('centerCursorsBtn')?.addEventListener('click', () => {
    app.centerCursors();
  });

  const curChSel = document.getElementById('cursorChannelSelect') as HTMLSelectElement;
  curChSel?.addEventListener('change', () => {
    app.setCursorTargetChannel(curChSel.value);
  });

  // --- 4. FFT Controls ---
  const spanSel = document.getElementById('fftSpanSelect') as HTMLSelectElement;
  spanSel?.addEventListener('change', () => {
    const tab = app.getActiveTab();
    if (tab) app.applyFrequencySpan(tab, spanSel.value);
  });

  const rangeSel = document.getElementById('fftRangeSelect') as HTMLSelectElement;
  rangeSel?.addEventListener('change', () => {
    const tab = app.getActiveTab();
    if (tab) {
      tab.fftOptions.range = rangeSel.value as any;
      app.draw();
    }
  });

  const winSel = document.getElementById('fftWindowSelect') as HTMLSelectElement;
  winSel?.addEventListener('change', () => {
    const tab = app.getActiveTab();
    if (tab) {
      tab.fftOptions.window = winSel.value as any;
      app.draw();
    }
  });

  const scaleSel = document.getElementById('fftScaleSelect') as HTMLSelectElement;
  scaleSel?.addEventListener('change', () => {
    const tab = app.getActiveTab();
    if (tab) {
      tab.fftOptions.scale = scaleSel.value as any;
      app.draw();
    }
  });

  const padSel = document.getElementById('fftPaddingSelect') as HTMLSelectElement;
  padSel?.addEventListener('change', () => {
    const tab = app.getActiveTab();
    if (tab) {
      tab.fftOptions.zeroPadding = parseInt(padSel.value, 10) as any;
      app.draw();
    }
  });

  const dcChk = document.getElementById('fftRemoveDcChk') as HTMLInputElement;
  dcChk?.addEventListener('change', () => {
    const tab = app.getActiveTab();
    if (tab) {
      tab.fftOptions.removeDC = dcChk.checked;
      app.draw();
    }
  });

  // --- 5. XY Lissajous Sidebar Controls ---
  document.getElementById('xyXChannelSelect')?.addEventListener('change', (e: any) => {
    const tab = app.getActiveTab();
    if (tab?.xyConfig) {
      tab.xyConfig.xChannelId = e.target.value;
      app.renderSidebar();
      app.draw();
    }
  });
  document.getElementById('xyYChannelSelect')?.addEventListener('change', (e: any) => {
    const tab = app.getActiveTab();
    if (tab?.xyConfig) {
      tab.xyConfig.yChannelId = e.target.value;
      app.renderSidebar();
      app.draw();
    }
  });
  document.getElementById('xyRangeSelect')?.addEventListener('change', (e: any) => {
    const tab = app.getActiveTab();
    if (tab?.xyConfig) {
      tab.xyConfig.range = e.target.value;
      app.renderSidebar();
      app.draw();
    }
  });
}

function bindModals() {
  // CSV Modal Confirm Buttons
  document.getElementById('csvLoadOriginalBtn')?.addEventListener('click', () => {
    app.confirmCsvImport(false);
  });
  document.getElementById('csvLoadResampleBtn')?.addEventListener('click', () => {
    app.confirmCsvImport(true);
  });
  document.getElementById('csvCancelBtn')?.addEventListener('click', () => {
    const m = document.getElementById('csvQualityModal');
    if (m) m.style.display = 'none';
  });

  // Math Modal
  document.getElementById('mathApplyBtn')?.addEventListener('click', () => {
    const exprInput = document.getElementById('mathExprInput') as HTMLInputElement;
    const nameInput = document.getElementById('mathNameInput') as HTMLInputElement;
    const errBox = document.getElementById('mathModalError');
    const expr = exprInput ? exprInput.value.trim() : '';
    const name = nameInput ? nameInput.value.trim() || 'Math 1' : 'Math 1';

    if (!expr) {
      if (errBox) {
        errBox.innerText = 'Please enter or select a mathematical expression (e.g. CH1 - CH2).';
        errBox.classList.remove('hidden');
      }
      return;
    }

    const res = app.addMathChannel(expr, name);
    if (res.success) {
      if (errBox) errBox.classList.add('hidden');
      document.getElementById('mathModal')!.style.display = 'none';
    } else {
      if (errBox) {
        errBox.innerText = `Math Error: ${res.error}`;
        errBox.classList.remove('hidden');
      }
    }
  });

  document.getElementById('mathCancelBtn')?.addEventListener('click', () => {
    document.getElementById('mathModal')!.style.display = 'none';
  });
  document.getElementById('mathModalCloseBtn')?.addEventListener('click', () => {
    document.getElementById('mathModal')!.style.display = 'none';
  });

  // Trigger Modal
  document.getElementById('triggerApplyBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;

    const chSel = document.getElementById('trigChannelSelect') as HTMLSelectElement;
    const typeSel = document.getElementById('trigSlopeSelect') as HTMLSelectElement;
    const levelInput = document.getElementById('trigLevelInput') as HTMLInputElement;
    const posInput = document.getElementById('trigPosInput') as HTMLInputElement;

    tab.triggerConfig.enabled = true;
    tab.triggerConfig.channelId = chSel.value;
    tab.triggerConfig.type = typeSel.value as 'rising' | 'falling';
    tab.triggerConfig.level = parseFloat(levelInput.value) || 0;
    const pos = parseFloat(posInput?.value || '50');
    tab.triggerConfig.positionPercent = isFinite(pos) ? Math.max(5, Math.min(95, pos)) : 50;

    app.applyTrigger();
    document.getElementById('triggerModal')!.style.display = 'none';
  });
  document.getElementById('triggerCancelBtn')?.addEventListener('click', () => {
    document.getElementById('triggerModal')!.style.display = 'none';
  });

  // Transform Modal (Clarke αβ | Park dq0 | Power P(t))
  const closeTransformModal = () => {
    document.getElementById('transformModal')!.style.display = 'none';
  };
  const switchTfTab = (tabName: 'clarke' | 'park' | 'power') => {
    const tabs: Array<['clarke' | 'park' | 'power', string, string]> = [
      ['clarke', 'tfTabClarkeBtn', 'tfPanelClarke'],
      ['park', 'tfTabParkBtn', 'tfPanelPark'],
      ['power', 'tfTabPowerBtn', 'tfPanelPower'],
    ];
    for (const [key, btnId, panelId] of tabs) {
      const btn = document.getElementById(btnId);
      const panel = document.getElementById(panelId);
      if (btn) {
        btn.className =
          key === tabName
            ? 'tf-tab-btn py-1 rounded-sm bg-cyan-600 text-slate-950 font-semibold cursor-pointer'
            : 'tf-tab-btn py-1 rounded-sm text-slate-300 hover:text-white cursor-pointer';
      }
      if (panel) panel.classList.toggle('hidden', key !== tabName);
    }
  };
  document.getElementById('tfTabClarkeBtn')?.addEventListener('click', () => switchTfTab('clarke'));
  document.getElementById('tfTabParkBtn')?.addEventListener('click', () => switchTfTab('park'));
  document.getElementById('tfTabPowerBtn')?.addEventListener('click', () => switchTfTab('power'));
  document.getElementById('transformCloseTopBtn')?.addEventListener('click', closeTransformModal);
  document.getElementById('transformCancelBtn')?.addEventListener('click', closeTransformModal);
  document.getElementById('parkCancelBtn')?.addEventListener('click', closeTransformModal);
  document.getElementById('powerCancelBtn')?.addEventListener('click', closeTransformModal);

  document.getElementById('parkAngleModeSelect')?.addEventListener('change', (e: any) => {
    document.getElementById('parkAngleChannelWrap')?.classList.toggle('hidden', e.target.value !== 'channel');
  });
  document.getElementById('powerModeSelect')?.addEventListener('change', (e: any) => {
    const is1Ph = e.target.value === '1ph';
    document.getElementById('power3PhRowB')?.classList.toggle('hidden', is1Ph);
    document.getElementById('power3PhRowC')?.classList.toggle('hidden', is1Ph);
  });

  document.getElementById('clarkeApplyBtn')?.addEventListener('click', () => {
    const ua = (document.getElementById('clarkeUaSelect') as HTMLSelectElement).value;
    const ub = (document.getElementById('clarkeUbSelect') as HTMLSelectElement).value;
    const uc = (document.getElementById('clarkeUcSelect') as HTMLSelectElement).value;
    app.executeClarkeTransform(ua, ub, uc);
    closeTransformModal();
  });
  document.getElementById('parkApplyBtn')?.addEventListener('click', () => {
    const aId = (document.getElementById('parkAlphaSelect') as HTMLSelectElement).value;
    const bId = (document.getElementById('parkBetaSelect') as HTMLSelectElement).value;
    const angMode = ((document.getElementById('parkAngleModeSelect') as HTMLSelectElement).value as 'auto' | 'channel') || 'auto';
    const angId = (document.getElementById('parkAngleSelect') as HTMLSelectElement).value;
    const offDeg = parseFloat((document.getElementById('parkOffsetDegInput') as HTMLInputElement).value || '0');
    app.executeParkTransform(aId, bId, angMode, angId, offDeg);
    closeTransformModal();
  });
  document.getElementById('powerApplyBtn')?.addEventListener('click', () => {
    const mode = ((document.getElementById('powerModeSelect') as HTMLSelectElement).value as '3ph' | '1ph') || '3ph';
    const ua = (document.getElementById('powerUaSelect') as HTMLSelectElement).value;
    const ub = (document.getElementById('powerUbSelect') as HTMLSelectElement).value;
    const uc = (document.getElementById('powerUcSelect') as HTMLSelectElement).value;
    const ia = (document.getElementById('powerIaSelect') as HTMLSelectElement).value;
    const ib = (document.getElementById('powerIbSelect') as HTMLSelectElement).value;
    const ic = (document.getElementById('powerIcSelect') as HTMLSelectElement).value;
    app.executePowerCalculation(mode, ua, ub, uc, ia, ib, ic);
    closeTransformModal();
  });

  // Motor Modal + RPM Estimator
  document.getElementById('motorEstBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    const chId = (document.getElementById('motorEstChannelSelect') as HTMLSelectElement)?.value;
    const ch = tab.channels[chId];
    const poles = parseInt((document.getElementById('motorPolesInput') as HTMLInputElement)?.value || '4', 10) || 4;
    const outEl = document.getElementById('motorEstOutput');
    if (!ch) return;
    const b = getTimeBoundsForView(tab, ch);
    const est = estimateSpeedFromSignal(ch.t, ch.v, poles, b.tStart, b.tEnd);
    if (est.rpm !== null && est.freqHz !== null) {
      const rpmInput = document.getElementById('motorRpmInput') as HTMLInputElement;
      if (rpmInput) rpmInput.value = est.rpm.toFixed(1);
      if (outEl) {
        outEl.innerText = `Detected fe = ${formatEng(est.freqHz, 'Hz', 3)} (${est.zeroCrossings} crossings) -> ${est.rpm.toFixed(1)} RPM (p=${poles})`;
        outEl.className = 'font-mono text-[11px] text-emerald-300 tabular-nums';
      }
    } else if (outEl) {
      outEl.innerText = 'Need >= 2 rising zero-crossings in current viewport.';
      outEl.className = 'font-mono text-[11px] text-amber-300 tabular-nums';
    }
  });
  document.getElementById('motorApplyBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    const rpmInput = document.getElementById('motorRpmInput') as HTMLInputElement;
    const poleInput = document.getElementById('motorPolesInput') as HTMLInputElement;
    const enableChk = document.getElementById('motorEnableChk') as HTMLInputElement;

    const rpm = parseFloat(rpmInput.value);
    const poles = parseInt(poleInput.value, 10);

    tab.motorConfig.enabled = enableChk.checked;
    tab.motorConfig.rpm = !isNaN(rpm) && rpm > 0 ? rpm : null;
    tab.motorConfig.polePairs = !isNaN(poles) && poles > 0 ? poles : null;

    app.draw();
    document.getElementById('motorModal')!.style.display = 'none';
  });
  document.getElementById('motorCancelBtn')?.addEventListener('click', () => {
    document.getElementById('motorModal')!.style.display = 'none';
  });

  // Text Annotation Modal
  document.getElementById('textAnnApplyBtn')?.addEventListener('click', () => {
    const input = document.getElementById('textAnnInput') as HTMLInputElement;
    app.submitPendingTextAnnotation(input?.value || '');
    document.getElementById('textAnnotationModal')!.style.display = 'none';
  });
  document.getElementById('textAnnCancelBtn')?.addEventListener('click', () => {
    document.getElementById('textAnnotationModal')!.style.display = 'none';
  });
  document.getElementById('textAnnInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const input = document.getElementById('textAnnInput') as HTMLInputElement;
      app.submitPendingTextAnnotation(input?.value || '');
      document.getElementById('textAnnotationModal')!.style.display = 'none';
    }
  });

  // Test Suite Close Buttons
  const closeTestModal = () => {
    document.getElementById('testSuiteModal')!.style.display = 'none';
  };
  document.getElementById('testSuiteCloseTopBtn')?.addEventListener('click', closeTestModal);
  document.getElementById('testSuiteCloseBtn')?.addEventListener('click', closeTestModal);

  // Automated Measurements Modal
  const closeMeasureModal = () => {
    document.getElementById('measureModal')!.style.display = 'none';
  };
  document.getElementById('measureModalCloseTopBtn')?.addEventListener('click', closeMeasureModal);
  document.getElementById('measureModalDoneBtn')?.addEventListener('click', closeMeasureModal);
  document.getElementById('measureModalChannelSelect')?.addEventListener('change', () => {
    const tab = app.getActiveTab();
    if (tab) renderMeasureModalCheckboxes(tab);
  });
  document.getElementById('measureModalGateSelect')?.addEventListener('change', (e: any) => {
    const tab = app.getActiveTab();
    if (tab) {
      tab.measurementGate = e.target.value as MeasurementGate;
      app.renderMeasurementStrip(tab);
    }
  });
  document.getElementById('measureSelectAllChBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    const chSel = document.getElementById('measureModalChannelSelect') as HTMLSelectElement;
    if (tab && chSel?.value) {
      app.selectAllMeasurementsForChannel(chSel.value);
      renderMeasureModalCheckboxes(tab);
    }
  });
  document.getElementById('measureClearAllBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    app.clearAllMeasurements();
    if (tab) renderMeasureModalCheckboxes(tab);
  });

  // Waveform Edit & Ref Modal
  const closeEditModal = () => {
    document.getElementById('waveformEditModal')!.style.display = 'none';
  };
  document.getElementById('editModalCloseTopBtn')?.addEventListener('click', closeEditModal);
  document.getElementById('editModalCloseBtn')?.addEventListener('click', closeEditModal);
  document.getElementById('editModalChannelSelect')?.addEventListener('change', () => {
    const tab = app.getActiveTab();
    if (tab) syncWaveformEditModalState(tab);
  });
  document.getElementById('editApplyGlobalOffsetBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    const chId = (document.getElementById('editModalChannelSelect') as HTMLSelectElement)?.value;
    const val = parseFloat((document.getElementById('editGlobalOffsetInput') as HTMLInputElement)?.value || '0');
    if (tab && chId && isFinite(val)) {
      app.applyChannelGlobalEdit(chId, { type: 'offset', value: val });
      syncWaveformEditModalState(tab);
    }
  });
  document.getElementById('editApplyGlobalGainBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    const chId = (document.getElementById('editModalChannelSelect') as HTMLSelectElement)?.value;
    const val = parseFloat((document.getElementById('editGlobalGainInput') as HTMLInputElement)?.value || '1');
    if (tab && chId && isFinite(val)) {
      app.applyChannelGlobalEdit(chId, { type: 'gain', value: val });
      syncWaveformEditModalState(tab);
    }
  });
  document.getElementById('editApplySmoothBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    const chId = (document.getElementById('editModalChannelSelect') as HTMLSelectElement)?.value;
    const win = parseInt((document.getElementById('editSmoothWindowInput') as HTMLInputElement)?.value || '9', 10);
    if (tab && chId && isFinite(win)) {
      app.applyChannelGlobalEdit(chId, { type: 'smooth', window: win });
      syncWaveformEditModalState(tab);
    }
  });
  document.getElementById('editApplyLocalFlattenBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    const chId = (document.getElementById('editModalChannelSelect') as HTMLSelectElement)?.value;
    const val = parseFloat((document.getElementById('editLocalFlattenInput') as HTMLInputElement)?.value || '0');
    if (tab && chId && isFinite(val)) {
      app.applyChannelLocalEdit(chId, { type: 'flatten', value: val });
      syncWaveformEditModalState(tab);
    }
  });
  document.getElementById('editApplyLocalOffsetBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    const chId = (document.getElementById('editModalChannelSelect') as HTMLSelectElement)?.value;
    const val = parseFloat((document.getElementById('editLocalOffsetInput') as HTMLInputElement)?.value || '0');
    if (tab && chId && isFinite(val)) {
      app.applyChannelLocalEdit(chId, { type: 'offset', value: val });
      syncWaveformEditModalState(tab);
    }
  });
  document.getElementById('editApplyLocalGainBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    const chId = (document.getElementById('editModalChannelSelect') as HTMLSelectElement)?.value;
    const val = parseFloat((document.getElementById('editLocalGainInput') as HTMLInputElement)?.value || '1');
    if (tab && chId && isFinite(val)) {
      app.applyChannelLocalEdit(chId, { type: 'gain', value: val });
      syncWaveformEditModalState(tab);
    }
  });
  document.getElementById('editApplyLocalBridgeBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    const chId = (document.getElementById('editModalChannelSelect') as HTMLSelectElement)?.value;
    if (tab && chId) {
      app.applyChannelLocalEdit(chId, { type: 'bridge' });
      syncWaveformEditModalState(tab);
    }
  });
  document.getElementById('editShowRefChk')?.addEventListener('change', (e: any) => {
    const tab = app.getActiveTab();
    const chId = (document.getElementById('editModalChannelSelect') as HTMLSelectElement)?.value;
    const ch = tab && chId ? tab.channels[chId] : null;
    if (ch) {
      ch.showRef = !!e.target.checked;
      app.draw();
    }
  });
  document.getElementById('editShowDiffChk')?.addEventListener('change', (e: any) => {
    const tab = app.getActiveTab();
    const chId = (document.getElementById('editModalChannelSelect') as HTMLSelectElement)?.value;
    const ch = tab && chId ? tab.channels[chId] : null;
    if (ch) {
      ch.showDiff = !!e.target.checked;
      app.draw();
    }
  });
  document.getElementById('editRevertRefBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    const chId = (document.getElementById('editModalChannelSelect') as HTMLSelectElement)?.value;
    if (tab && chId) {
      app.revertChannelEdits(chId);
      syncWaveformEditModalState(tab);
    }
  });

  // Golden Reference Tolerance Envelope Controls inside Edit/Ref Modal
  const syncGoldenFromUI = (captureNewRef: boolean = false) => {
    const tab = app.getActiveTab();
    const chId = (document.getElementById('editModalChannelSelect') as HTMLSelectElement)?.value;
    if (!tab || !chId || !tab.channels[chId]) return;
    const enChk = document.getElementById('goldenEnableChk') as HTMLInputElement;
    const srcSel = document.getElementById('goldenSourceSelect') as HTMLSelectElement;
    const modeSel = document.getElementById('goldenModeSelect') as HTMLSelectElement;
    const tolInp = document.getElementById('goldenTolInput') as HTMLInputElement;

    const srcId = srcSel?.value || chId;
    const srcCh = tab.channels[srcId] || tab.channels[chId];
    if (!tab.goldenBand) {
      tab.goldenBand = { enabled: false, channelId: chId, mode: 'percent', tolerance: 5 };
    }
    tab.goldenBand.channelId = chId;
    tab.goldenBand.enabled = captureNewRef ? true : !!enChk?.checked;
    if (enChk && captureNewRef) enChk.checked = true;
    tab.goldenBand.mode = (modeSel?.value as 'percent' | 'absolute') || 'percent';
    tab.goldenBand.tolerance = Math.max(0.01, parseFloat(tolInp?.value || '5') || 5);
    if (captureNewRef || !tab.goldenBand.refV || srcId !== chId) {
      tab.goldenBand.refV = new Float32Array(srcCh.refV || srcCh.v);
      tab.goldenBand.refT = new Float64Array(srcCh.t);
      tab.goldenBand.refLabel = srcCh.name;
    }
    app.draw();
    syncWaveformEditModalState(tab);
  };
  document.getElementById('goldenEnableChk')?.addEventListener('change', () => syncGoldenFromUI(false));
  document.getElementById('goldenSourceSelect')?.addEventListener('change', () => syncGoldenFromUI(true));
  document.getElementById('goldenModeSelect')?.addEventListener('change', () => syncGoldenFromUI(false));
  document.getElementById('goldenTolInput')?.addEventListener('change', () => syncGoldenFromUI(false));
  document.getElementById('goldenCaptureBtn')?.addEventListener('click', () => {
    syncGoldenFromUI(true);
    app.showToast('Captured current waveform as Golden Tolerance Reference.', 'info');
  });

  // Crop Export Modal
  const closeCropModal = () => {
    document.getElementById('cropExportModal')!.style.display = 'none';
  };
  document.getElementById('cropExportCloseTopBtn')?.addEventListener('click', closeCropModal);
  document.getElementById('cropCancelBtn')?.addEventListener('click', closeCropModal);
  document.getElementById('cropRangeModeSelect')?.addEventListener('change', () => {
    const tab = app.getActiveTab();
    if (tab) updateCropModalPreview(tab);
  });
  const getCheckedCropChannelIds = (): string[] => {
    const ids: string[] = [];
    document.querySelectorAll('#cropChannelsList .crop-ch-chk:checked').forEach((el) => {
      const id = (el as HTMLInputElement).value;
      if (id) ids.push(id);
    });
    return ids;
  };
  document.getElementById('cropConfirmCsvBtn')?.addEventListener('click', () => {
    const mode = ((document.getElementById('cropRangeModeSelect') as HTMLSelectElement)?.value as 'view' | 'cursors') || 'view';
    app.exportCroppedSlice('csv', mode, getCheckedCropChannelIds());
    closeCropModal();
  });
  document.getElementById('cropConfirmJsonBtn')?.addEventListener('click', () => {
    const mode = ((document.getElementById('cropRangeModeSelect') as HTMLSelectElement)?.value as 'view' | 'cursors') || 'view';
    app.exportCroppedSlice('json', mode, getCheckedCropChannelIds());
    closeCropModal();
  });

  // Two-Channel Phase Difference (ΔΦ) Modal
  const closePhaseModal = () => {
    document.getElementById('phaseModal')!.style.display = 'none';
  };
  document.getElementById('phaseCloseTopBtn')?.addEventListener('click', closePhaseModal);
  document.getElementById('phaseCloseBtn')?.addEventListener('click', closePhaseModal);
  const refreshPhase = () => {
    const tab = app.getActiveTab();
    if (tab) computeAndRenderPhaseDiff(tab);
  };
  document.getElementById('phaseRefSelect')?.addEventListener('change', refreshPhase);
  document.getElementById('phaseTargetSelect')?.addEventListener('change', refreshPhase);
  document.getElementById('phaseGateSelect')?.addEventListener('change', refreshPhase);
  document.getElementById('phaseRecomputeBtn')?.addEventListener('click', refreshPhase);

  // Cross-File / Cross-Channel Multi-Waveform Compare Group Modal
  const closeCompareModal = () => {
    editingCompareGroupId = null;
    document.getElementById('compareModal')!.style.display = 'none';
  };
  document.getElementById('compareCloseTopBtn')?.addEventListener('click', closeCompareModal);
  document.getElementById('cmpCloseBtn')?.addEventListener('click', closeCompareModal);

  const getCompareTargetChannel = (tab: TabState): WaveformChannel | null => {
    const tgtId = (document.getElementById('cmpTargetSelect') as HTMLSelectElement)?.value;
    return tab.channels[tgtId] || tab.channels[tab.drawOrder[0]] || null;
  };

  const applyAutoAlignToEntry = (
    targetCh: WaveformChannel | null,
    entry: CompareQueueEntry,
    forceSpanFit: boolean = false
  ) => {
    const autoChk = (document.getElementById('cmpAutoFitOnAddChk') as HTMLInputElement)?.checked ?? true;
    if (!targetCh || (!autoChk && !forceSpanFit)) return;
    const rec = detectRecommendedTimeScale(targetCh, entry.channel);
    if (rec.isLargeMismatch) {
      entry.timeScale = rec.timeScale;
      entry.autoScaledFrom = rec.ratio;
    } else if (forceSpanFit && targetCh.t.length >= 2 && entry.channel.t.length >= 2) {
      const durT = Math.abs(targetCh.t[targetCh.t.length - 1] - targetCh.t[0]);
      const durR = Math.abs(entry.channel.t[entry.channel.t.length - 1] - entry.channel.t[0]);
      if (durT > 1e-18 && durR > 1e-18) {
        entry.timeScale = durT / durR;
        entry.autoScaledFrom = rec.ratio;
      }
    }
    entry.timeShiftSec = computeAutoTimeAlignShift(targetCh, entry.channel, 'start', entry.timeScale || 1);
  };

  const cmpFileInp = document.getElementById('cmpRefFileInput') as HTMLInputElement | null;
  document.getElementById('cmpLoadFileBtn')?.addEventListener('click', () => cmpFileInp?.click());
  cmpFileInp?.addEventListener('change', async (e: any) => {
    const files = e.target?.files ? (Array.from(e.target.files) as File[]) : [];
    if (files.length === 0) return;

    const tab = app.getActiveTab();
    const targetCh = tab ? getCompareTargetChannel(tab) : null;

    let addedCount = 0;
    let skippedDupCount = 0;
    let reusedTabCount = 0;
    let firstExtKey = '';

    for (const file of files) {
      try {
        const fp = await computeFileFingerprint(file);

        // 1. Check if identical filename + identical content is already in current Compare queue
        if (compareQueue.some((q) => q.fingerprint === fp)) {
          skippedDupCount++;
          continue;
        }

        // 2. Check if identical filename + content matches an already-open Tab
        const openMatch = app.findTabByFingerprint(fp);
        if (openMatch) {
          if (tab && openMatch.tab.id === tab.id) {
            // Identical to currently active baseline file -> skip duplicate load
            skippedDupCount++;
            continue;
          }
          const shortFile = openMatch.tab.fileName.replace(/\.[^.]+$/, '');
          const tabChannels = openMatch.tab.drawOrder
            .map((cid) => openMatch.tab.channels[cid])
            .filter((c): c is WaveformChannel => !!c && c.compareRole !== 'ref');
          tabChannels.forEach((ch) => {
            const key = `tab:${openMatch.tab.id}::${ch.id}`;
            if (compareQueue.some((q) => q.sourceKey === key || q.fingerprint === fp)) {
              skippedDupCount++;
              return;
            }
            const label = tabChannels.length > 1 ? `${shortFile}:${ch.name}` : shortFile;
            const entry: CompareQueueEntry = {
              id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              sourceKey: key,
              label,
              channel: ch,
              timeShiftSec: 0,
              timeScale: 1,
              fingerprint: fp,
            };
            applyAutoAlignToEntry(targetCh, entry, false);
            compareQueue.push(entry);
            if (!firstExtKey) firstExtKey = key;
            addedCount++;
            reusedTabCount++;
          });
          continue;
        }

        // 3. Check if identical file was already parsed into externalCompareRefs cache
        const cachedExt = externalCompareRefs.filter((ext) => ext.fingerprint === fp);
        if (cachedExt.length > 0) {
          cachedExt.forEach((ext) => {
            const refKey = `ext:${ext.id}`;
            const shortFile = file.name.replace(/\.[^.]+$/, '');
            const label = cachedExt.length > 1 ? `${shortFile}:${ext.channel.name}` : shortFile;
            const entry: CompareQueueEntry = {
              id: ext.id,
              sourceKey: refKey,
              label,
              channel: ext.channel,
              timeShiftSec: 0,
              timeScale: 1,
              fingerprint: fp,
            };
            applyAutoAlignToEntry(targetCh, entry, false);
            compareQueue.push(entry);
            if (!firstExtKey) firstExtKey = refKey;
            addedCount++;
          });
          continue;
        }

        // 4. Parse new unique file
        const parsed = await parseReferenceFileToChannels(file, app.getRawColors());
        if (parsed.channels.length === 0) continue;
        const shortFile = parsed.fileName.replace(/\.[^.]+$/, '');
        parsed.channels.forEach((ch, idx) => {
          const refId = `ext_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${idx}`;
          const refKey = `ext:${refId}`;
          const label = parsed.channels.length > 1 ? `${shortFile}:${ch.name}` : shortFile;
          externalCompareRefs.unshift({
            id: refId,
            label: `[File: ${parsed.fileName}] ${ch.name} (${ch.unit || 'V'})`,
            channel: ch,
            fingerprint: parsed.fingerprint,
          });
          const entry: CompareQueueEntry = {
            id: refId,
            sourceKey: refKey,
            label,
            channel: ch,
            timeShiftSec: 0,
            timeScale: 1,
            fingerprint: parsed.fingerprint,
          };
          applyAutoAlignToEntry(targetCh, entry, false);
          compareQueue.push(entry);
          if (!firstExtKey) firstExtKey = refKey;
          addedCount++;
        });
      } catch (err: any) {
        app.showToast(`Failed to load ${file.name}: ${err?.message || err}`, 'error');
      }
    }

    if (cmpFileInp) cmpFileInp.value = '';
    if (tab && addedCount > 0) {
      populateCompareDropdowns(tab, firstExtKey || undefined);
      recomputeComparePanel(tab);
      const parts: string[] = [`已加入 ${addedCount} 条波形`];
      if (reusedTabCount > 0) parts.push(`复用已打开标签页 ${reusedTabCount} 条`);
      if (skippedDupCount > 0) parts.push(`跳过重复文件 ${skippedDupCount} 个`);
      app.showToast(parts.join(' · '), 'info');
    } else if (skippedDupCount > 0) {
      app.showToast(`检测到 ${skippedDupCount} 个完全相同的文件（文件名+内容一致），已自动跳过重复加载。`, 'warn');
    } else if (addedCount === 0) {
      app.showToast('No waveform channels found in selected file(s).', 'warn');
    }
  });

  document.getElementById('cmpAddRefBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    const refVal = (document.getElementById('cmpRefSelect') as HTMLSelectElement)?.value || '';
    if (!tab || !refVal) return;
    if (compareQueue.some((q) => q.sourceKey === refVal)) {
      app.showToast('该波形已经在对比队列中，无需重复添加。', 'warn');
      return;
    }
    const resolved = resolveRefSourceByKey(refVal);
    if (!resolved) return;
    const targetCh = getCompareTargetChannel(tab);
    const entry: CompareQueueEntry = {
      id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      sourceKey: refVal,
      label: resolved.label,
      channel: resolved.channel,
      timeShiftSec: 0,
      timeScale: 1,
      fingerprint: resolved.fingerprint,
    };
    applyAutoAlignToEntry(targetCh, entry, false);
    compareQueue.push(entry);
    recomputeComparePanel(tab);
  });

  const refreshCompare = () => {
    const tab = app.getActiveTab();
    if (tab) recomputeComparePanel(tab);
  };
  document.getElementById('cmpTargetSelect')?.addEventListener('change', refreshCompare);
  document.getElementById('cmpPaletteModeSelect')?.addEventListener('change', refreshCompare);
  document.getElementById('cmpTagTargetChk')?.addEventListener('change', refreshCompare);
  document.getElementById('cmpGroupNameInput')?.addEventListener('input', refreshCompare);
  document.getElementById('cmpRemoveDcChk')?.addEventListener('change', refreshCompare);
  document.getElementById('cmpTolModeSelect')?.addEventListener('change', refreshCompare);
  document.getElementById('cmpTolValueInput')?.addEventListener('input', refreshCompare);

  const ensureQueueHasItem = (tab: TabState): boolean => {
    if (compareQueue.length > 0) return true;
    const refVal = (document.getElementById('cmpRefSelect') as HTMLSelectElement)?.value || '';
    const resolved = refVal ? resolveRefSourceByKey(refVal) : null;
    if (resolved) {
      const targetCh = getCompareTargetChannel(tab);
      const entry: CompareQueueEntry = {
        id: `q_${Date.now()}`,
        sourceKey: refVal,
        label: resolved.label,
        channel: resolved.channel,
        timeShiftSec: 0,
        timeScale: 1,
        fingerprint: resolved.fingerprint,
      };
      applyAutoAlignToEntry(targetCh, entry, false);
      compareQueue.push(entry);
      return true;
    }
    app.showToast('Add at least one file or channel to the comparison group first.', 'warn');
    return false;
  };

  const runCompareAutoAlignAll = (mode: 'start' | 'rising-edge' | 'first-peak' | 'xcorr') => {
    const tab = app.getActiveTab();
    if (!tab || !ensureQueueHasItem(tab)) return;
    const targetCh = getCompareTargetChannel(tab);
    if (!targetCh) return;
    compareQueue.forEach((entry) => {
      entry.timeShiftSec = computeAutoTimeAlignShift(targetCh, entry.channel, mode, entry.timeScale || 1);
    });
    recomputeComparePanel(tab);
  };
  document.getElementById('cmpAlignStartBtn')?.addEventListener('click', () => runCompareAutoAlignAll('start'));
  document.getElementById('cmpAlignEdgeBtn')?.addEventListener('click', () => runCompareAutoAlignAll('rising-edge'));
  document.getElementById('cmpAlignPeakBtn')?.addEventListener('click', () => runCompareAutoAlignAll('first-peak'));
  document.getElementById('cmpAlignXCorrBtn')?.addEventListener('click', () => runCompareAutoAlignAll('xcorr'));
  document.getElementById('cmpMatchSpanBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab || !ensureQueueHasItem(tab)) return;
    const targetCh = getCompareTargetChannel(tab);
    if (!targetCh) return;
    compareQueue.forEach((entry) => applyAutoAlignToEntry(targetCh, entry, true));
    recomputeComparePanel(tab);
    app.showToast('Matched time span (ms↔s) and aligned initial t0 for all queued waveforms.', 'info');
  });
  document.getElementById('cmpAlignResetBtn')?.addEventListener('click', () => {
    compareQueue.forEach((entry) => {
      entry.timeShiftSec = 0;
      entry.timeScale = 1;
      entry.autoScaledFrom = undefined;
    });
    refreshCompare();
  });

  document.getElementById('cmpClearQueueBtn')?.addEventListener('click', () => {
    compareQueue = [];
    refreshCompare();
  });
  document.getElementById('cmpClearBandBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    if (tab.goldenBand) tab.goldenBand.enabled = false;
    app.draw();
    app.showToast('Cleared Golden tolerance band.', 'info');
  });

  const applyCompareGroupFromUI = (opts: { overlayRefs: boolean; addDiffs: boolean }) => {
    const tab = app.getActiveTab();
    if (!tab || !ensureQueueHasItem(tab)) return;
    recomputeComparePanel(tab);

    const tgtId = (document.getElementById('cmpTargetSelect') as HTMLSelectElement)?.value || tab.drawOrder[0];
    const groupNameRaw = (document.getElementById('cmpGroupNameInput') as HTMLInputElement)?.value.trim() || `CMP${compareGroupCounter}`;
    const paletteMode = ((document.getElementById('cmpPaletteModeSelect') as HTMLSelectElement)?.value || 'family') as 'family' | 'distinct';
    const tagTarget = !!(document.getElementById('cmpTagTargetChk') as HTMLInputElement)?.checked;
    const enableGolden = !!(document.getElementById('cmpEnableGoldenChk') as HTMLInputElement)?.checked;
    const tolMode = ((document.getElementById('cmpTolModeSelect') as HTMLSelectElement)?.value || 'percent') as 'percent' | 'absolute';
    const tolVal = parseFloat((document.getElementById('cmpTolValueInput') as HTMLInputElement)?.value || '5');

    const theme = COMPARE_GROUP_THEMES.find((t) => t.id === selectedCompareThemeId) || COMPARE_GROUP_THEMES[0];
    const groupId = editingCompareGroupId || `grp_${groupNameRaw.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now().toString(36)}`;
    const colorOffset = tagTarget ? 1 : 0;

    const payloadItems = compareQueue
      .filter((e) => e.computed)
      .map((entry, idx) => ({
        id: entry.id,
        refLabel: entry.label,
        color: entry.customColor || getCompareGroupTraceColor(theme.id, idx + colorOffset, paletteMode),
        alignedRefV: entry.computed!.alignedRefV,
        diffV: entry.computed!.diffV,
      }));

    if (payloadItems.length === 0) return;

    app.applyMultiCompareGroup(
      tgtId,
      {
        groupId,
        replaceGroupId: editingCompareGroupId || undefined,
        groupName: groupNameRaw,
        groupColor: theme.badgeColor,
        targetColor: tagTarget && paletteMode === 'family' ? getCompareGroupTraceColor(theme.id, 0, 'family') : undefined,
        tagTargetChannel: tagTarget,
        overlayRefTraces: opts.overlayRefs,
        enableGoldenBand: opts.overlayRefs && enableGolden,
        goldenMode: tolMode,
        goldenTolerance: isFinite(tolVal) && tolVal > 0 ? tolVal : 5,
        addDiffChannels: opts.addDiffs,
      },
      payloadItems
    );

    appliedCompareGroupQueues.set(
      groupId,
      compareQueue.map((entry) => ({ ...entry, computed: undefined }))
    );
    compareQueue = [];

    if (!editingCompareGroupId) compareGroupCounter++;
    app.showToast(
      opts.addDiffs && !opts.overlayRefs
        ? `Added ${payloadItems.length} diff trace(s) in group [${groupNameRaw}].`
        : `Overlaid ${payloadItems.length} waveform(s) in group [${groupNameRaw}].`,
      'info'
    );
    closeCompareModal();
  };

  document.getElementById('cmpAddDiffBtn')?.addEventListener('click', () => {
    applyCompareGroupFromUI({ overlayRefs: false, addDiffs: true });
  });
  document.getElementById('cmpApplyOverlayBtn')?.addEventListener('click', () => {
    applyCompareGroupFromUI({ overlayRefs: true, addDiffs: false });
  });

  // Automated Anomaly Scanner Modal
  const closeAnomalyModal = () => {
    document.getElementById('anomalyModal')!.style.display = 'none';
  };
  document.getElementById('anomalyCloseTopBtn')?.addEventListener('click', closeAnomalyModal);
  document.getElementById('anomalyCloseBtn')?.addEventListener('click', closeAnomalyModal);
  document.getElementById('anomClearBtn')?.addEventListener('click', () => {
    app.clearAnomalies();
    const wrap = document.getElementById('anomResultsTableWrap');
    const cnt = document.getElementById('anomSummaryCount');
    if (cnt) cnt.innerText = 'Cleared anomaly markers.';
    if (wrap) wrap.innerHTML = '<div class="p-4 text-xs font-mono text-slate-500">Cleared.</div>';
  });
  document.getElementById('anomRunBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    const chId = (document.getElementById('anomChannelSelect') as HTMLSelectElement)?.value;
    const ch = tab.channels[chId];
    if (!ch) return;
    const parseOptNum = (id: string): number | null => {
      const v = parseFloat((document.getElementById(id) as HTMLInputElement)?.value || '');
      return isFinite(v) ? v : null;
    };
    const events = app.scanAnomalies(chId, {
      highThreshold: parseOptNum('anomHighInput'),
      lowThreshold: parseOptNum('anomLowInput'),
      minDvDt: parseOptNum('anomDvDtInput'),
      maxEdgeGapSec: parseOptNum('anomGapInput'),
    });
    renderAnomalyTable(events, ch.unit);
  });

  // Batch Multi-File / Folder Measurement Modal
  const closeBatchModal = () => {
    document.getElementById('batchModal')!.style.display = 'none';
  };
  document.getElementById('batchCloseTopBtn')?.addEventListener('click', closeBatchModal);
  document.getElementById('batchCloseBtn')?.addEventListener('click', closeBatchModal);
  const batchFilesInp = document.getElementById('batchFilesInput') as HTMLInputElement | null;
  const batchFolderInp = document.getElementById('batchFolderInput') as HTMLInputElement | null;
  document.getElementById('batchPickFilesBtn')?.addEventListener('click', () => batchFilesInp?.click());
  document.getElementById('batchPickFolderBtn')?.addEventListener('click', () => batchFolderInp?.click());
  const onBatchFilesSelected = (list: FileList | null) => {
    if (!list) return;
    batchQueuedFiles = Array.from(list).filter((f) => /\.(csv|txt|wfm|raw)$/i.test(f.name));
    const lbl = document.getElementById('batchFileCountLabel');
    if (lbl) lbl.innerText = `${batchQueuedFiles.length} supported file(s) queued.`;
  };
  batchFilesInp?.addEventListener('change', () => onBatchFilesSelected(batchFilesInp.files));
  batchFolderInp?.addEventListener('change', () => onBatchFilesSelected(batchFolderInp.files));
  document.getElementById('batchRunBtn')?.addEventListener('click', async () => {
    if (batchQueuedFiles.length === 0) {
      app.showToast('Select CSV/WFM files or a folder first.', 'warn');
      return;
    }
    const chIdx = Math.max(0, (parseInt((document.getElementById('batchChIndexInput') as HTMLInputElement)?.value || '1', 10) || 1) - 1);
    const ruleMetric = ((document.getElementById('batchRuleMetricSelect') as HTMLSelectElement)?.value || '') as MeasurementMetricKey | '';
    const minV = parseFloat((document.getElementById('batchMinLimitInput') as HTMLInputElement)?.value || '');
    const maxV = parseFloat((document.getElementById('batchMaxLimitInput') as HTMLInputElement)?.value || '');
    const lbl = document.getElementById('batchFileCountLabel');
    if (lbl) lbl.innerText = `Analyzing ${batchQueuedFiles.length} files...`;
    lastBatchRows = await runBatchAnalysisOnFiles(
      batchQueuedFiles,
      chIdx,
      BATCH_EXPORT_METRICS,
      'entire',
      ruleMetric
        ? {
            metric: ruleMetric,
            minLimit: isFinite(minV) ? minV : null,
            maxLimit: isFinite(maxV) ? maxV : null,
          }
        : undefined
    );
    if (lbl) lbl.innerText = `Completed: ${lastBatchRows.length} file(s).`;
    renderBatchTable(lastBatchRows);
  });
  document.getElementById('batchExportCsvBtn')?.addEventListener('click', () => {
    if (lastBatchRows.length === 0) {
      app.showToast('Run a batch measurement first before exporting.', 'warn');
      return;
    }
    const fname = exportBatchResultsCSV(lastBatchRows, BATCH_EXPORT_METRICS);
    app.showToast(`Exported ${fname}`, 'info');
  });

  // Workbench Presets Modal
  const closePresetModal = () => {
    document.getElementById('presetModal')!.style.display = 'none';
  };
  document.getElementById('presetCloseTopBtn')?.addEventListener('click', closePresetModal);
  document.getElementById('presetCloseBtn')?.addEventListener('click', closePresetModal);
  document.getElementById('presetSaveBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    const nameInp = document.getElementById('presetNameInput') as HTMLInputElement;
    const preset = capturePresetFromTab(tab, nameInp?.value || '');
    savePresetToStorage(preset);
    if (nameInp) nameInp.value = '';
    renderPresetsList();
    app.showToast(`Saved template "${preset.name}".`, 'info');
  });

  // BLDC Motor & Inverter Diagnostics Suite Modal
  const closeBldcModal = () => {
    document.getElementById('bldcModal')!.style.display = 'none';
  };
  document.getElementById('bldcCloseTopBtn')?.addEventListener('click', closeBldcModal);
  document.getElementById('bldcCloseBtn')?.addEventListener('click', closeBldcModal);
  document.getElementById('bldcTabBalanceBtn')?.addEventListener('click', () => setBldcTab('balance'));
  document.getElementById('bldcTabHallBtn')?.addEventListener('click', () => setBldcTab('hall'));
  document.getElementById('bldcTabPwmBtn')?.addEventListener('click', () => setBldcTab('pwm'));
  document.getElementById('bldcTabRippleBtn')?.addEventListener('click', () => setBldcTab('ripple'));

  document.getElementById('bldcBalRunBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) renderBldcBalance(tab);
  });
  document.getElementById('bldcHallRunBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) renderBldcHall(tab);
  });
  document.getElementById('bldcPwmRunBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) renderBldcPwm(tab);
  });
  document.getElementById('bldcRippleRunBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) renderBldcRipple(tab);
  });
  document.getElementById('bldcGateSelect')?.addEventListener('change', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    if (!document.getElementById('bldcPanelBalance')?.classList.contains('hidden')) renderBldcBalance(tab);
    if (!document.getElementById('bldcPanelHall')?.classList.contains('hidden')) renderBldcHall(tab);
    if (!document.getElementById('bldcPanelPwm')?.classList.contains('hidden')) renderBldcPwm(tab);
    if (!document.getElementById('bldcPanelRipple')?.classList.contains('hidden')) renderBldcRipple(tab);
  });

  const getSelected3PhaseForBldc = (tab: TabState) => {
    const uId = (document.getElementById('bldcBalUSelect') as HTMLSelectElement)?.value;
    const vId = (document.getElementById('bldcBalVSelect') as HTMLSelectElement)?.value;
    const wId = (document.getElementById('bldcBalWSelect') as HTMLSelectElement)?.value;
    const chU = tab.channels[uId];
    const chV = tab.channels[vId];
    const chW = tab.channels[wId];
    return chU && chV && chW ? { chU, chV, chW } : null;
  };

  document.getElementById('bldcGenLineToLineBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    const ph = getSelected3PhaseForBldc(tab);
    if (!ph) return;
    const derived = computeBldcDerivedTraces(ph.chU, ph.chV, ph.chW);
    const unit = ph.chU.unit || 'V';
    app.createDerivedMathTraces([
      {
        name: `Uuv (${ph.chU.name}-${ph.chV.name})`,
        unit,
        baseChannelId: ph.chU.id,
        values: derived.uuv,
        expr: `${ph.chU.name} - ${ph.chV.name}`,
        color: app.getNextComputedColor(0),
        sourceIds: [ph.chU.id, ph.chV.id],
      },
      {
        name: `Uvw (${ph.chV.name}-${ph.chW.name})`,
        unit,
        baseChannelId: ph.chV.id,
        values: derived.uvw,
        expr: `${ph.chV.name} - ${ph.chW.name}`,
        color: app.getNextComputedColor(1),
        sourceIds: [ph.chV.id, ph.chW.id],
      },
      {
        name: `Uwu (${ph.chW.name}-${ph.chU.name})`,
        unit,
        baseChannelId: ph.chW.id,
        values: derived.uwu,
        expr: `${ph.chW.name} - ${ph.chU.name}`,
        color: app.getNextComputedColor(2),
        sourceIds: [ph.chW.id, ph.chU.id],
      },
    ]);
    app.showToast('Added Line-to-Line traces: Uuv, Uvw, Uwu', 'info');
  });

  document.getElementById('bldcGenZeroSeqBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    const ph = getSelected3PhaseForBldc(tab);
    if (!ph) return;
    const derived = computeBldcDerivedTraces(ph.chU, ph.chV, ph.chW);
    app.createDerivedMathTraces([
      {
        name: 'Zero-Seq V0 ((U+V+W)/3)',
        unit: ph.chU.unit || 'V',
        baseChannelId: ph.chU.id,
        values: derived.v0,
        expr: `(${ph.chU.name}+${ph.chV.name}+${ph.chW.name})/3`,
        color: app.getNextComputedColor(0),
        sourceIds: [ph.chU.id, ph.chV.id, ph.chW.id],
      },
    ]);
    app.showToast('Added Zero-Sequence V0 trace', 'info');
  });

  document.getElementById('bldcGenSvmMagBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    const ph = getSelected3PhaseForBldc(tab);
    if (!ph) return;
    const derived = computeBldcDerivedTraces(ph.chU, ph.chV, ph.chW);
    app.createDerivedMathTraces([
      {
        name: 'Space Vector |Vs|',
        unit: ph.chU.unit || 'V',
        baseChannelId: ph.chU.id,
        values: derived.svmMag,
        expr: 'sqrt(Clarke_alpha^2 + Clarke_beta^2)',
        color: app.getNextComputedColor(0),
        sourceIds: [ph.chU.id, ph.chV.id, ph.chW.id],
      },
    ]);
    app.showToast('Added Space Vector Magnitude |Vs| trace', 'info');
  });

  // Keyboard Shortcuts Modal
  const closeShortcutsModal = () => {
    document.getElementById('shortcutsModal')!.style.display = 'none';
  };
  document.getElementById('shortcutsCloseTopBtn')?.addEventListener('click', closeShortcutsModal);
  document.getElementById('shortcutsCloseBtn')?.addEventListener('click', closeShortcutsModal);

  // Generic close for centered blocking modal backdrops (docked tool drawer panels ignore backdrop clicks)
  document.querySelectorAll('.modal-overlay:not(.tool-dockable)').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        (overlay as HTMLElement).style.display = 'none';
      }
    });
  });
}

function openTriggerModal(tab: TabState) {
  const modal = document.getElementById('triggerModal');
  if (!modal) return;

  const chSel = document.getElementById('trigChannelSelect') as HTMLSelectElement;
  chSel.innerHTML = '';
  tab.drawOrder.forEach((id) => {
    const ch = tab.channels[id];
    if (ch) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.innerText = ch.name;
      if (id === tab.triggerConfig.channelId) opt.selected = true;
      chSel.appendChild(opt);
    }
  });

  const levelInput = document.getElementById('trigLevelInput') as HTMLInputElement;
  levelInput.value = tab.triggerConfig.level.toString();

  const slopeSel = document.getElementById('trigSlopeSelect') as HTMLSelectElement;
  slopeSel.value = tab.triggerConfig.type;

  const posInput = document.getElementById('trigPosInput') as HTMLInputElement;
  if (posInput) posInput.value = (tab.triggerConfig.positionPercent ?? 50).toString();

  modal.style.display = 'flex';
}

function openMathModal(tab: TabState) {
  const modal = document.getElementById('mathModal');
  if (!modal) return;

  const errBox = document.getElementById('mathModalError');
  if (errBox) errBox.classList.add('hidden');

  const exprInput = document.getElementById('mathExprInput') as HTMLInputElement;
  const nameInput = document.getElementById('mathNameInput') as HTMLInputElement;

  const mathCount = tab.drawOrder.filter((id) => tab.channels[id]?.isMath).length;
  if (nameInput) nameInput.value = `Math ${mathCount + 1}`;
  if (exprInput && !exprInput.value.trim()) {
    exprInput.value = 'CH1 - CH2';
  }

  const availContainer = document.getElementById('mathAvailableChannels');
  if (availContainer) {
    availContainer.innerHTML = '';
    tab.drawOrder.forEach((id, idx) => {
      const ch = tab.channels[id];
      if (!ch) return;
      const alias = `CH${idx + 1}`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        'px-2 py-1 bg-[#161b22] hover:bg-[#1e2530] text-cyan-300 rounded-sm font-mono text-xs border border-[#222933] hover:border-cyan-500 transition cursor-pointer';
      btn.innerText = `${alias}: ${ch.name}`;
      btn.title = `Click to insert ${alias} (${ch.name})`;
      btn.addEventListener('click', () => {
        insertAtCursor(exprInput, alias);
      });
      availContainer.appendChild(btn);
    });
  }

  document.querySelectorAll('#mathKeypad .keypad-btn').forEach((btn) => {
    const newBtn = btn.cloneNode(true) as HTMLButtonElement;
    btn.parentNode?.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => {
      const textToInsert = newBtn.getAttribute('data-insert') || '';
      insertAtCursor(exprInput, textToInsert);
    });
  });

  const presetContainer = document.getElementById('quickMathPresets');
  if (presetContainer) {
    presetContainer.innerHTML = `
      <div class="flex flex-wrap gap-1.5 text-xs">
        <button type="button" class="preset-btn px-2 py-1 bg-[#161b22] hover:bg-[#1e2530] border border-[#222933] rounded-sm text-slate-300 font-mono transition cursor-pointer" data-formula="CH1 - CH2">Diff: CH1 - CH2</button>
        <button type="button" class="preset-btn px-2 py-1 bg-[#161b22] hover:bg-[#1e2530] border border-[#222933] rounded-sm text-slate-300 font-mono transition cursor-pointer" data-formula="CH1 * CH2">Product: CH1 * CH2</button>
        <button type="button" class="preset-btn px-2 py-1 bg-[#161b22] hover:bg-[#1e2530] border border-[#222933] rounded-sm text-slate-300 font-mono transition cursor-pointer" data-formula="CH1 - mean(CH1)">Ripple: CH1 - mean</button>
        <button type="button" class="preset-btn px-2 py-1 bg-[#161b22] hover:bg-[#1e2530] border border-[#222933] rounded-sm text-slate-300 font-mono transition cursor-pointer" data-formula="deriv(CH1)">dV/dt: deriv(CH1)</button>
        <button type="button" class="preset-btn px-2 py-1 bg-[#161b22] hover:bg-[#1e2530] border border-[#222933] rounded-sm text-slate-300 font-mono transition cursor-pointer" data-formula="abs(CH1)">Rectify: abs(CH1)</button>
        <button type="button" class="preset-btn px-2 py-1 bg-[#161b22] hover:bg-[#1e2530] border border-[#222933] rounded-sm text-slate-300 font-mono transition cursor-pointer" data-formula="sqrt(CH1^2 + CH2^2)">Mag: sqrt(CH1^2+CH2^2)</button>
      </div>
    `;

    presetContainer.querySelectorAll('.preset-btn').forEach((btn) => {
      btn.addEventListener('click', (e: any) => {
        if (exprInput) exprInput.value = e.target.dataset.formula;
      });
    });
  }

  modal.style.display = 'flex';
}

function insertAtCursor(input: HTMLInputElement, text: string) {
  if (!input) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const before = input.value.substring(0, start);
  const after = input.value.substring(end);
  input.value = before + text + after;
  input.focus();
  let newPos = start + text.length;
  if (text.endsWith('()')) newPos -= 1;
  input.setSelectionRange(newPos, newPos);
}

function openTransformModal(tab: TabState) {
  const modal = document.getElementById('transformModal');
  if (!modal) return;

  const populateChannelSelect = (sel: HTMLSelectElement | null, defaultIdx: number) => {
    if (!sel) return;
    sel.innerHTML = '';
    tab.drawOrder.forEach((id, chIdx) => {
      const ch = tab.channels[id];
      if (!ch) return;
      const opt = document.createElement('option');
      opt.value = id;
      opt.innerText = ch.name;
      if (chIdx === defaultIdx) opt.selected = true;
      sel.appendChild(opt);
    });
  };

  populateChannelSelect(document.getElementById('clarkeUaSelect') as HTMLSelectElement, 0);
  populateChannelSelect(document.getElementById('clarkeUbSelect') as HTMLSelectElement, 1);
  populateChannelSelect(document.getElementById('clarkeUcSelect') as HTMLSelectElement, 2);

  // Auto-prefer existing Clarke α / β for Park if available
  const alphaIdx = tab.drawOrder.findIndex((id) => /clarke.*α|alpha/i.test(tab.channels[id]?.name || ''));
  const betaIdx = tab.drawOrder.findIndex((id) => /clarke.*β|beta/i.test(tab.channels[id]?.name || ''));
  populateChannelSelect(document.getElementById('parkAlphaSelect') as HTMLSelectElement, alphaIdx >= 0 ? alphaIdx : 0);
  populateChannelSelect(document.getElementById('parkBetaSelect') as HTMLSelectElement, betaIdx >= 0 ? betaIdx : Math.min(1, tab.drawOrder.length - 1));
  populateChannelSelect(document.getElementById('parkAngleSelect') as HTMLSelectElement, Math.min(2, tab.drawOrder.length - 1));

  populateChannelSelect(document.getElementById('powerUaSelect') as HTMLSelectElement, 0);
  populateChannelSelect(document.getElementById('powerUbSelect') as HTMLSelectElement, Math.min(1, tab.drawOrder.length - 1));
  populateChannelSelect(document.getElementById('powerUcSelect') as HTMLSelectElement, Math.min(2, tab.drawOrder.length - 1));
  const firstCurrentIdx = tab.drawOrder.findIndex((id) => tab.channels[id]?.unit === 'A');
  const iaDef = firstCurrentIdx >= 0 ? firstCurrentIdx : Math.min(3, tab.drawOrder.length - 1);
  populateChannelSelect(document.getElementById('powerIaSelect') as HTMLSelectElement, iaDef);
  populateChannelSelect(document.getElementById('powerIbSelect') as HTMLSelectElement, iaDef);
  populateChannelSelect(document.getElementById('powerIcSelect') as HTMLSelectElement, iaDef);

  modal.style.display = 'flex';
}

function openMotorModal(tab: TabState) {
  const modal = document.getElementById('motorModal');
  if (!modal) return;

  const rpmInput = document.getElementById('motorRpmInput') as HTMLInputElement;
  const polesInput = document.getElementById('motorPolesInput') as HTMLInputElement;
  const enableChk = document.getElementById('motorEnableChk') as HTMLInputElement;
  const estSel = document.getElementById('motorEstChannelSelect') as HTMLSelectElement;

  rpmInput.value = tab.motorConfig.rpm ? tab.motorConfig.rpm.toString() : '';
  polesInput.value = tab.motorConfig.polePairs ? tab.motorConfig.polePairs.toString() : '4';
  enableChk.checked = tab.motorConfig.enabled;

  if (estSel) {
    estSel.innerHTML = '';
    tab.drawOrder.forEach((id, idx) => {
      const ch = tab.channels[id];
      if (!ch) return;
      const opt = document.createElement('option');
      opt.value = id;
      opt.innerText = ch.isMath ? `[M] ${ch.name}` : `CH${idx + 1}: ${ch.name}`;
      if (id === (tab.activeChannelId || tab.drawOrder[0])) opt.selected = true;
      estSel.appendChild(opt);
    });
  }

  modal.style.display = 'flex';
}

function openTestSuiteModal() {
  const modal = document.getElementById('testSuiteModal');
  if (!modal) return;

  const listEl = document.getElementById('testResultsList');
  if (!listEl) return;

  const results = runAllTests();
  let html = '<div class="space-y-2">';
  results.forEach((r) => {
    html += `
      <div class="p-2.5 rounded-sm text-xs font-mono border ${
        r.passed
          ? 'bg-emerald-950/30 border-emerald-700/60 text-emerald-200'
          : 'bg-red-950/30 border-red-700/60 text-red-200'
      }">
        <div class="flex justify-between font-semibold">
          <span>${r.name}</span>
          <span>${r.passed ? 'PASS' : 'FAIL'}</span>
        </div>
        <div class="text-[11px] text-slate-400 mt-1">${r.message}</div>
      </div>
    `;
  });
  html += '</div>';

  listEl.innerHTML = html;
  modal.style.display = 'flex';
}

function openMeasureModal(tab: TabState) {
  const modal = document.getElementById('measureModal');
  if (!modal) return;

  const chSel = document.getElementById('measureModalChannelSelect') as HTMLSelectElement;
  if (chSel) {
    chSel.innerHTML = '';
    tab.drawOrder.forEach((id, idx) => {
      const ch = tab.channels[id];
      if (!ch) return;
      const opt = document.createElement('option');
      opt.value = id;
      opt.innerText = ch.isMath ? `[M] ${ch.name}` : `CH${idx + 1}: ${ch.name}`;
      if (id === (tab.activeChannelId || tab.drawOrder[0])) opt.selected = true;
      chSel.appendChild(opt);
    });
  }

  const gateSel = document.getElementById('measureModalGateSelect') as HTMLSelectElement;
  if (gateSel) gateSel.value = tab.measurementGate;

  renderMeasureModalCheckboxes(tab);
  modal.style.display = 'flex';
}

function renderMeasureModalCheckboxes(tab: TabState) {
  const chSel = document.getElementById('measureModalChannelSelect') as HTMLSelectElement;
  const chId = chSel?.value || tab.activeChannelId || tab.drawOrder[0];
  const voltageBox = document.getElementById('measureVoltageList');
  const timingBox = document.getElementById('measureTimingList');
  if (!voltageBox || !timingBox || !chId) return;

  const selectedSet = new Set((tab.selectedMeasurements || []).map((m) => m.id));
  const buildGroup = (container: HTMLElement, group: 'voltage' | 'timing') => {
    container.innerHTML = '';
    MEASUREMENT_DEFINITIONS.filter((d) => d.group === group).forEach((def) => {
      const id = `${chId}::${def.key}`;
      const label = document.createElement('label');
      label.className = 'flex items-center justify-between gap-2 px-2 py-1 bg-[#12161c] hover:bg-[#1a222d] border border-[#222933] rounded-sm cursor-pointer';
      label.innerHTML = `
        <span class="flex items-center gap-2 text-slate-200">
          <input type="checkbox" class="accent-cyan-400 cursor-pointer" ${selectedSet.has(id) ? 'checked' : ''} />
          <span>${def.label}</span>
        </span>
        <span class="font-mono text-[10px] text-slate-500">${def.shortLabel}</span>
      `;
      label.querySelector('input')?.addEventListener('change', (e: any) => {
        app.toggleMeasurementSelection(chId, def.key, !!e.target.checked);
      });
      container.appendChild(label);
    });
  };

  buildGroup(voltageBox, 'voltage');
  buildGroup(timingBox, 'timing');
}

function openWaveformEditModal(tab: TabState) {
  const modal = document.getElementById('waveformEditModal');
  if (!modal) return;

  const chSel = document.getElementById('editModalChannelSelect') as HTMLSelectElement;
  if (chSel) {
    chSel.innerHTML = '';
    tab.drawOrder.forEach((id, idx) => {
      const ch = tab.channels[id];
      if (!ch) return;
      const opt = document.createElement('option');
      opt.value = id;
      opt.innerText = ch.isMath ? `[M] ${ch.name}` : `CH${idx + 1}: ${ch.name}`;
      if (id === (tab.activeChannelId || tab.drawOrder[0])) opt.selected = true;
      chSel.appendChild(opt);
    });
  }

  syncWaveformEditModalState(tab);
  modal.style.display = 'flex';
}

function syncWaveformEditModalState(tab: TabState) {
  const chSel = document.getElementById('editModalChannelSelect') as HTMLSelectElement;
  const ch = chSel?.value ? tab.channels[chSel.value] : tab.channels[tab.drawOrder[0]];
  if (!ch) return;

  const badge = document.getElementById('editModalRefBadge');
  if (badge) {
    if (ch.hasEdits && ch.refV) {
      badge.innerText = 'Modified · Ref Locked';
      badge.className = 'px-2 py-1 bg-rose-950/50 border border-rose-500/60 font-mono text-[11px] text-rose-200 rounded-sm';
    } else {
      badge.innerText = 'Original (Unmodified)';
      badge.className = 'px-2 py-1 bg-[#0c0f13] border border-[#222933] font-mono text-[11px] text-slate-400 rounded-sm';
    }
  }

  const rangeEl = document.getElementById('editLocalRangeDisplay');
  if (rangeEl) {
    if (tab.cursors.enabled && tab.cursors.x1 !== null && tab.cursors.x2 !== null) {
      const t1 = Math.min(tab.cursors.x1, tab.cursors.x2);
      const t2 = Math.max(tab.cursors.x1, tab.cursors.x2);
      rangeEl.innerText = `${formatEng(t1, 's', 3)} ~ ${formatEng(t2, 's', 3)}`;
    } else {
      const b = getTimeBoundsForView(tab, ch);
      rangeEl.innerText = `View: ${formatEng(b.tStart, 's', 3)} ~ ${formatEng(b.tEnd, 's', 3)}`;
    }
  }

  const showRefChk = document.getElementById('editShowRefChk') as HTMLInputElement;
  const showDiffChk = document.getElementById('editShowDiffChk') as HTMLInputElement;
  if (showRefChk) showRefChk.checked = ch.showRef !== false;
  if (showDiffChk) showDiffChk.checked = !!ch.showDiff;

  // Golden Tolerance Reference controls sync
  const gSrcSel = document.getElementById('goldenSourceSelect') as HTMLSelectElement | null;
  if (gSrcSel) {
    gSrcSel.innerHTML = '';
    tab.drawOrder.forEach((id, idx) => {
      const c = tab.channels[id];
      if (!c) return;
      const opt = document.createElement('option');
      opt.value = id;
      opt.innerText = `Ref: CH${idx + 1} ${c.name}`;
      if (id === (tab.goldenBand?.channelId || ch.id)) opt.selected = true;
      gSrcSel.appendChild(opt);
    });
  }
  const gEnChk = document.getElementById('goldenEnableChk') as HTMLInputElement | null;
  const gModeSel = document.getElementById('goldenModeSelect') as HTMLSelectElement | null;
  const gTolInp = document.getElementById('goldenTolInput') as HTMLInputElement | null;
  const gReadout = document.getElementById('goldenEvalReadout');
  if (gEnChk) gEnChk.checked = !!(tab.goldenBand?.enabled && tab.goldenBand.channelId === ch.id);
  if (gModeSel && tab.goldenBand) gModeSel.value = tab.goldenBand.mode;
  if (gTolInp && tab.goldenBand) gTolInp.value = String(tab.goldenBand.tolerance);
  const gEval = app.getGoldenEvaluation(tab);
  if (gReadout) {
    if (!gEval || tab.goldenBand?.channelId !== ch.id) {
      gReadout.innerText = 'Disabled';
      gReadout.className = 'font-mono text-[11px] text-slate-400 tabular-nums';
    } else if (gEval.pass) {
      gReadout.innerText = `PASS (Max dev ${formatEng(gEval.maxDeviation, ch.unit, 2)})`;
      gReadout.className = 'font-mono text-[11px] text-emerald-400 font-semibold tabular-nums';
    } else {
      gReadout.innerText = `FAIL · ${gEval.violationCount} pts out (Max ${formatEng(gEval.maxDeviation, ch.unit, 2)})`;
      gReadout.className = 'font-mono text-[11px] text-red-400 font-semibold tabular-nums';
    }
  }
}

function openCropExportModal(tab: TabState) {
  const modal = document.getElementById('cropExportModal');
  if (!modal) return;

  const rangeSel = document.getElementById('cropRangeModeSelect') as HTMLSelectElement;
  if (rangeSel) {
    rangeSel.value =
      tab.cursors.enabled && tab.cursors.x1 !== null && tab.cursors.x2 !== null ? 'cursors' : 'view';
  }

  const chBox = document.getElementById('cropChannelsList');
  if (chBox) {
    chBox.innerHTML = '';
    tab.drawOrder.forEach((id, idx) => {
      const ch = tab.channels[id];
      if (!ch) return;
      const lbl = document.createElement('label');
      lbl.className = 'flex items-center justify-between gap-2 px-2 py-1 bg-[#12161c] border border-[#222933] rounded-sm cursor-pointer';
      lbl.innerHTML = `
        <span class="flex items-center gap-2">
          <input type="checkbox" class="crop-ch-chk accent-cyan-400 cursor-pointer" value="${id}" ${ch.visible ? 'checked' : ''} />
          <span class="w-2.5 h-2.5 rounded-xs" style="background:${ch.color}"></span>
          <span class="text-slate-200 font-mono text-[11px]">${ch.isMath ? '[M]' : `CH${idx + 1}:`} ${ch.name}</span>
        </span>
        <span class="text-[10px] font-mono text-slate-400">${ch.hasEdits ? 'Edited+Ref' : ch.unit}</span>
      `;
      chBox.appendChild(lbl);
    });
  }

  updateCropModalPreview(tab);
  modal.style.display = 'flex';
}

function updateCropModalPreview(tab: TabState) {
  const rangeSel = document.getElementById('cropRangeModeSelect') as HTMLSelectElement;
  const preview = document.getElementById('cropSampleCountPreview');
  const baseCh = tab.channels[tab.drawOrder[0]];
  if (!preview || !baseCh) return;

  let tStart: number;
  let tEnd: number;
  if (rangeSel?.value === 'cursors' && tab.cursors.enabled && tab.cursors.x1 !== null && tab.cursors.x2 !== null) {
    tStart = Math.min(tab.cursors.x1, tab.cursors.x2);
    tEnd = Math.max(tab.cursors.x1, tab.cursors.x2);
  } else {
    const b = getTimeBoundsForView(tab, baseCh);
    tStart = b.tStart;
    tEnd = b.tEnd;
  }

  let count = 0;
  for (let i = 0; i < baseCh.t.length; i++) {
    if (baseCh.t[i] >= tStart && baseCh.t[i] <= tEnd) count++;
  }

  preview.innerText = `${formatEng(tStart, 's', 4)} ~ ${formatEng(tEnd, 's', 4)}  (${count.toLocaleString()} samples)`;
}

function openPhaseModal(tab: TabState) {
  const modal = document.getElementById('phaseModal');
  if (!modal) return;
  const refSel = document.getElementById('phaseRefSelect') as HTMLSelectElement;
  const tgtSel = document.getElementById('phaseTargetSelect') as HTMLSelectElement;
  [refSel, tgtSel].forEach((sel, sIdx) => {
    if (!sel) return;
    sel.innerHTML = '';
    tab.drawOrder.forEach((id, idx) => {
      const ch = tab.channels[id];
      if (!ch) return;
      const opt = document.createElement('option');
      opt.value = id;
      opt.innerText = ch.isMath ? `[M] ${ch.name}` : `CH${idx + 1}: ${ch.name}`;
      if (idx === Math.min(sIdx, tab.drawOrder.length - 1)) opt.selected = true;
      sel.appendChild(opt);
    });
  });
  computeAndRenderPhaseDiff(tab);
  modal.style.display = 'flex';
}

function computeAndRenderPhaseDiff(tab: TabState) {
  const refId = (document.getElementById('phaseRefSelect') as HTMLSelectElement)?.value;
  const tgtId = (document.getElementById('phaseTargetSelect') as HTMLSelectElement)?.value;
  const gate = (document.getElementById('phaseGateSelect') as HTMLSelectElement)?.value || 'view';
  const card = document.getElementById('phaseResultCard');
  if (!card || !refId || !tgtId) return;

  const refCh = tab.channels[refId];
  const tgtCh = tab.channels[tgtId];
  if (!refCh || !tgtCh) return;

  let tStart: number | undefined;
  let tEnd: number | undefined;
  if (gate === 'cursors' && tab.cursors.enabled && tab.cursors.x1 !== null && tab.cursors.x2 !== null) {
    tStart = Math.min(tab.cursors.x1, tab.cursors.x2);
    tEnd = Math.max(tab.cursors.x1, tab.cursors.x2);
  } else if (gate === 'view') {
    const b = getTimeBoundsForView(tab, refCh);
    tStart = b.tStart;
    tEnd = b.tEnd;
  }

  const res = computeTwoChannelPhaseDiff(refCh, tgtCh, tStart, tEnd);
  if (res.phaseDeg === null) {
    card.innerHTML = `<div class="text-amber-300">${res.status}</div>`;
    return;
  }
  card.innerHTML = `
    <div class="flex justify-between"><span class="text-slate-400">Phase ΔΦ (-180°~+180°):</span><span class="text-cyan-300 font-bold text-sm">${res.phaseDeg.toFixed(2)}°</span></div>
    <div class="flex justify-between"><span class="text-slate-400">Wrapped (0°~360°):</span><span class="text-slate-100">${res.phaseDeg360?.toFixed(2)}°</span></div>
    <div class="flex justify-between"><span class="text-slate-400">Time Shift Δt:</span><span class="text-slate-100">${res.deltaTimeSec !== null ? formatEng(res.deltaTimeSec, 's', 3) : '--'}</span></div>
    <div class="flex justify-between"><span class="text-slate-400">Fundamental Freq:</span><span class="text-slate-100">${res.frequencyHz !== null ? formatEng(res.frequencyHz, 'Hz', 3) : '--'}</span></div>
    <div class="flex justify-between"><span class="text-slate-400">Matched Cycles:</span><span class="text-emerald-300">${res.matchedCycles}</span></div>
  `;
}

function openAnomalyModal(tab: TabState) {
  const modal = document.getElementById('anomalyModal');
  if (!modal) return;
  const chSel = document.getElementById('anomChannelSelect') as HTMLSelectElement;
  if (chSel) {
    chSel.innerHTML = '';
    tab.drawOrder.forEach((id, idx) => {
      const ch = tab.channels[id];
      if (!ch) return;
      const opt = document.createElement('option');
      opt.value = id;
      opt.innerText = ch.isMath ? `[M] ${ch.name}` : `CH${idx + 1}: ${ch.name}`;
      if (id === (tab.activeChannelId || tab.drawOrder[0])) opt.selected = true;
      chSel.appendChild(opt);
    });
  }
  const activeCh = tab.channels[tab.activeChannelId || tab.drawOrder[0]];
  if (tab.activeAnomalies && tab.activeAnomalies.length > 0 && activeCh) {
    renderAnomalyTable(tab.activeAnomalies, activeCh.unit);
  }
  modal.style.display = 'flex';
}

function renderAnomalyTable(events: ReturnType<typeof app.scanAnomalies>, unit: string) {
  const wrap = document.getElementById('anomResultsTableWrap');
  const cnt = document.getElementById('anomSummaryCount');
  if (cnt) cnt.innerText = `${events.length} event(s) detected`;
  if (!wrap) return;

  if (events.length === 0) {
    wrap.innerHTML = '<div class="p-4 text-xs font-mono text-emerald-400">0 anomalies found — signal stayed within thresholds.</div>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'w-full text-xs font-mono border-collapse tabular-nums';
  table.innerHTML = `
    <thead class="bg-[#161b22] text-slate-300 sticky top-0">
      <tr>
        <th class="p-2 border-b border-[#222933] text-left">#</th>
        <th class="p-2 border-b border-[#222933] text-left">Type</th>
        <th class="p-2 border-b border-[#222933] text-left">Timestamp</th>
        <th class="p-2 border-b border-[#222933] text-left">Value</th>
        <th class="p-2 border-b border-[#222933] text-left">Detail</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody')!;
  events.forEach((ev, idx) => {
    const tr = document.createElement('tr');
    tr.className = 'border-b border-[#1b222c] hover:bg-amber-950/30 cursor-pointer text-slate-200';
    tr.innerHTML = `
      <td class="p-1.5 text-slate-400">${idx + 1}</td>
      <td class="p-1.5 text-amber-300 uppercase">${ev.kind}</td>
      <td class="p-1.5 text-cyan-300">${formatEng(ev.time, 's', 4)}</td>
      <td class="p-1.5">${formatEng(ev.value, unit, 3)}</td>
      <td class="p-1.5 text-slate-400">${ev.detail}</td>
    `;
    tr.addEventListener('click', () => {
      app.jumpToAnomaly(idx);
      document.getElementById('anomalyModal')!.style.display = 'none';
    });
    tbody.appendChild(tr);
  });
  wrap.innerHTML = '';
  wrap.appendChild(table);
}

function openBatchModal() {
  const modal = document.getElementById('batchModal');
  if (modal) modal.style.display = 'flex';
}

function renderBatchTable(rows: BatchFileRow[]) {
  const wrap = document.getElementById('batchResultsWrap');
  if (!wrap) return;
  if (rows.length === 0) {
    wrap.innerHTML = '<div class="p-4 text-xs font-mono text-slate-500">No CSV/WFM files processed.</div>';
    return;
  }
  const table = document.createElement('table');
  table.className = 'w-full text-[11px] font-mono border-collapse tabular-nums';
  table.innerHTML = `
    <thead class="bg-[#161b22] text-slate-300 sticky top-0">
      <tr>
        <th class="p-2 border-b border-[#222933] text-left">File</th>
        <th class="p-2 border-b border-[#222933] text-left">Ch</th>
        <th class="p-2 border-b border-[#222933] text-left">Rate</th>
        <th class="p-2 border-b border-[#222933] text-left">Vpp</th>
        <th class="p-2 border-b border-[#222933] text-left">Vrms</th>
        <th class="p-2 border-b border-[#222933] text-left">Freq</th>
        <th class="p-2 border-b border-[#222933] text-left">Duty</th>
        <th class="p-2 border-b border-[#222933] text-left">Status</th>
        <th class="p-2 border-b border-[#222933] text-right">Inspect</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody')!;
  rows.forEach((r) => {
    const m = r.measurements;
    const tr = document.createElement('tr');
    tr.className = 'border-b border-[#1b222c] hover:bg-[#161b22] text-slate-200';
    const badgeCls =
      r.passStatus === 'PASS'
        ? 'text-emerald-400 font-semibold'
        : r.passStatus === 'FAIL'
        ? 'text-red-400 font-semibold'
        : 'text-slate-400';
    tr.innerHTML = `
      <td class="p-1.5 max-w-[180px] truncate" title="${r.fileName}">${r.fileName}</td>
      <td class="p-1.5 text-slate-300">${r.channelName}</td>
      <td class="p-1.5">${r.sampleRateHz ? formatEng(r.sampleRateHz, 'Sa/s', 1) : '--'}</td>
      <td class="p-1.5">${m?.vpp !== null && m?.vpp !== undefined ? formatEng(m.vpp, r.unit, 2) : '--'}</td>
      <td class="p-1.5">${m?.rms !== null && m?.rms !== undefined ? formatEng(m.rms, r.unit, 2) : '--'}</td>
      <td class="p-1.5">${m?.frequency !== null && m?.frequency !== undefined ? formatEng(m.frequency, 'Hz', 2) : '--'}</td>
      <td class="p-1.5">${m?.dutyCycle !== null && m?.dutyCycle !== undefined ? m.dutyCycle.toFixed(1) + '%' : '--'}</td>
      <td class="p-1.5 ${badgeCls}">${r.status === 'error' ? 'ERR' : r.passStatus || 'OK'}</td>
      <td class="p-1.5 text-right"><button class="batch-open-btn px-2 py-0.5 bg-[#161b22] hover:bg-[#1e2530] border border-[#2c3543] text-cyan-300 rounded-sm cursor-pointer">Open</button></td>
    `;
    tr.querySelector('.batch-open-btn')?.addEventListener('click', async () => {
      const f = batchQueuedFiles.find((file) => file.name === r.fileName && file.size === r.fileSizeBytes);
      if (f) {
        await app.openFileDirectInTab(f);
        document.getElementById('batchModal')!.style.display = 'none';
      }
    });
    tbody.appendChild(tr);
  });
  wrap.innerHTML = '';
  wrap.appendChild(table);
}

function openPresetModal() {
  const modal = document.getElementById('presetModal');
  if (!modal) return;
  renderPresetsList();
  modal.style.display = 'flex';
}

function renderPresetsList() {
  const wrap = document.getElementById('presetListWrap');
  if (!wrap) return;
  const presets = loadPresets();
  wrap.innerHTML = '';
  if (presets.length === 0) {
    wrap.innerHTML = '<div class="p-3 text-xs font-mono text-slate-500">No saved templates yet. Configure Math, Measurements, and Layout, then click Save Current above.</div>';
    return;
  }
  presets.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between gap-2 p-2 bg-[#12161c] border border-[#222933] rounded-sm text-xs';
    row.innerHTML = `
      <div class="min-w-0">
        <div class="text-slate-100 font-medium truncate">${p.name}</div>
        <div class="text-[10px] font-mono text-slate-400">${p.mathDefs.length} Math · ${p.selectedMetricsByIndex.length} Metrics · ${p.separateView ? 'Separate' : 'Overlap'} · ${p.renderMode}</div>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <button class="preset-apply-btn px-2.5 py-1 bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-semibold rounded-sm cursor-pointer">Apply</button>
        <button class="preset-del-btn px-2 py-1 bg-[#161b22] hover:bg-red-950/60 border border-[#222933] text-red-300 rounded-sm cursor-pointer">Del</button>
      </div>
    `;
    row.querySelector('.preset-apply-btn')?.addEventListener('click', () => {
      const tab = app.getActiveTab();
      if (!tab) return;
      const res = applyPresetToTab(tab, p);
      app.renderSidebar();
      app.draw();
      app.showToast(`Applied "${p.name}": +${res.mathCreated} Math, ${res.metricsApplied} Metrics.`, 'info');
      document.getElementById('presetModal')!.style.display = 'none';
    });
    row.querySelector('.preset-del-btn')?.addEventListener('click', () => {
      deletePresetFromStorage(p.id);
      renderPresetsList();
    });
    wrap.appendChild(row);
  });
}

function openShortcutsModal() {
  const modal = document.getElementById('shortcutsModal');
  if (modal) modal.style.display = 'flex';
}

function resolveRefSourceByKey(refVal: string): { label: string; channel: WaveformChannel; fingerprint?: string } | null {
  if (refVal.startsWith('ext:')) {
    const extId = refVal.slice(4);
    const hit = externalCompareRefs.find((r) => r.id === extId);
    if (hit) return { label: hit.channel.name, channel: hit.channel, fingerprint: hit.fingerprint };
  } else if (refVal.startsWith('tab:')) {
    const rest = refVal.slice(4);
    const sep = rest.indexOf('::');
    if (sep > 0) {
      const tId = rest.slice(0, sep);
      const cId = rest.slice(sep + 2);
      const all = app.getAllTabChannelOptions();
      const hit = all.find((o) => o.tabId === tId && o.channelId === cId);
      if (hit) {
        const lbl = hit.isCurrentTab ? hit.channelName : `${hit.tabName.replace(/\.[^.]+$/, '')}:${hit.channelName}`;
        return { label: lbl, channel: hit.channel };
      }
    }
  }
  return null;
}

function renderCompareGroupSwatches() {
  const wrap = document.getElementById('cmpGroupColorSwatches');
  if (!wrap) return;
  wrap.innerHTML = '';
  COMPARE_GROUP_THEMES.forEach((theme) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const isSel = theme.id === selectedCompareThemeId;
    btn.title = `${theme.label} Group Theme`;
    btn.className = `w-6 h-6 rounded-sm border transition cursor-pointer flex items-center justify-center ${
      isSel ? 'border-white scale-110 ring-1 ring-white/60' : 'border-[#2c3543] opacity-75 hover:opacity-100'
    }`;
    btn.style.background = theme.badgeColor;
    if (isSel) {
      btn.innerHTML = '<span class="w-2 h-2 rounded-full bg-slate-950"></span>';
    }
    btn.addEventListener('click', () => {
      selectedCompareThemeId = theme.id;
      renderCompareGroupSwatches();
      const tab = app.getActiveTab();
      if (tab) recomputeComparePanel(tab);
    });
    wrap.appendChild(btn);
  });
}

function populateCompareDropdowns(tab: TabState, preferredRefKey?: string): string {
  const tgtSel = document.getElementById('cmpTargetSelect') as HTMLSelectElement | null;
  const refSel = document.getElementById('cmpRefSelect') as HTMLSelectElement | null;
  if (!tgtSel || !refSel) return '';

  const prevTgt = tgtSel.value;
  tgtSel.innerHTML = '';
  tab.drawOrder.forEach((id) => {
    const ch = tab.channels[id];
    if (!ch || ch.compareRole === 'ref') return;
    const opt = document.createElement('option');
    opt.value = id;
    opt.text = `${ch.name} (${ch.unit || 'V'})`;
    tgtSel.appendChild(opt);
  });
  tgtSel.value =
    prevTgt && tab.channels[prevTgt] && tab.channels[prevTgt].compareRole !== 'ref'
      ? prevTgt
      : tab.activeChannelId && tab.channels[tab.activeChannelId]?.compareRole !== 'ref'
      ? tab.activeChannelId
      : tab.drawOrder.find((id) => tab.channels[id]?.compareRole !== 'ref') || '';

  const prevRef = preferredRefKey || refSel.value;
  refSel.innerHTML = '';

  externalCompareRefs.forEach((ext) => {
    const opt = document.createElement('option');
    opt.value = `ext:${ext.id}`;
    opt.text = ext.label;
    refSel.appendChild(opt);
  });

  const allOpts = app.getAllTabChannelOptions();
  let defaultOtherKey = '';
  allOpts.forEach((o) => {
    if (o.channel.compareRole === 'ref') return;
    const key = `tab:${o.tabId}::${o.channelId}`;
    const opt = document.createElement('option');
    opt.value = key;
    opt.text = o.isCurrentTab
      ? `[Current] ${o.channelName} (${o.unit})`
      : `[${o.tabName}] ${o.channelName} (${o.unit})`;
    refSel.appendChild(opt);
    if (!defaultOtherKey && (o.tabId !== tab.id || o.channelId !== tgtSel.value)) {
      defaultOtherKey = key;
    }
  });

  if (prevRef && Array.from(refSel.options).some((o) => o.value === prevRef)) {
    refSel.value = prevRef;
  } else if (defaultOtherKey) {
    refSel.value = defaultOtherKey;
  }
  return refSel.value || '';
}

function renderComparePreviewCanvas(
  targetCh: WaveformChannel | null,
  paletteMode: 'family' | 'distinct',
  themeId: string,
  colorOffset: number
) {
  const canvas = document.getElementById('cmpPreviewCanvas') as HTMLCanvasElement | null;
  const banner = document.getElementById('cmpPreviewBanner');
  const warnBanner = document.getElementById('cmpScaleWarnBanner');
  if (!canvas) return;

  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(300, canvas.clientWidth || 640);
  const h = Math.max(120, canvas.clientHeight || 155);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const themeCanvas = app.getThemePreset().canvas;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.fillStyle = themeCanvas.bg;
  ctx.fillRect(0, 0, w, h);

  // Subtle oscilloscope 10x8 grid
  ctx.strokeStyle = themeCanvas.grid;
  ctx.lineWidth = 1;
  for (let gx = 1; gx < 10; gx++) {
    const x = (gx / 10) * w;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let gy = 1; gy < 8; gy++) {
    const y = (gy / 8) * h;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  if (!targetCh || targetCh.t.length < 2) {
    if (banner) banner.innerText = 'Live Overlay Preview — Select a target channel';
    if (warnBanner) warnBanner.classList.add('hidden');
    ctx.restore();
    return;
  }

  const n = targetCh.t.length;
  const tStart = targetCh.t[0];
  const tEnd = targetCh.t[n - 1];
  const tSpan = Math.max(1e-18, tEnd - tStart);

  // Find combined vertical bounds across Target and all aligned queue waves
  let yMin = Infinity;
  let yMax = -Infinity;
  const step = Math.max(1, Math.floor(n / 2000));
  for (let i = 0; i < n; i += step) {
    const tv = targetCh.v[i];
    if (isFinite(tv)) {
      if (tv < yMin) yMin = tv;
      if (tv > yMax) yMax = tv;
    }
    for (const entry of compareQueue) {
      const rv = entry.computed?.alignedRefV[i];
      if (rv !== undefined && isFinite(rv)) {
        if (rv < yMin) yMin = rv;
        if (rv > yMax) yMax = rv;
      }
    }
  }
  if (!isFinite(yMin) || !isFinite(yMax)) {
    yMin = -1;
    yMax = 1;
  }
  if (Math.abs(yMax - yMin) < 1e-12) {
    yMin -= 1;
    yMax += 1;
  }
  const pad = (yMax - yMin) * 0.12;
  yMin -= pad;
  yMax += pad;
  const ySpan = yMax - yMin;

  const plotSeries = (vArr: Float32Array, stroke: string, lineWidth: number, dashed: boolean) => {
    const buckets = Math.min(w, n);
    const ptsPerBucket = n / buckets;
    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    if (dashed) ctx.setLineDash([4, 3]);
    ctx.beginPath();
    let started = false;
    for (let b = 0; b < buckets; b++) {
      const i0 = Math.floor(b * ptsPerBucket);
      const i1 = Math.max(i0 + 1, Math.min(n, Math.floor((b + 1) * ptsPerBucket)));
      let bMin = Infinity;
      let bMax = -Infinity;
      let bLast = NaN;
      for (let i = i0; i < i1; i++) {
        const val = vArr[i];
        if (!isFinite(val)) continue;
        if (val < bMin) bMin = val;
        if (val > bMax) bMax = val;
        bLast = val;
      }
      if (!isFinite(bLast)) {
        started = false;
        continue;
      }
      const x = ((targetCh.t[i0] - tStart) / tSpan) * w;
      const yTop = h - ((bMax - yMin) / ySpan) * h;
      const yBot = h - ((bMin - yMin) / ySpan) * h;
      if (!started) {
        ctx.moveTo(x, yTop);
        started = true;
      } else {
        ctx.lineTo(x, yTop);
      }
      if (Math.abs(yBot - yTop) > 1) {
        ctx.lineTo(x, yBot);
      }
    }
    ctx.stroke();
    ctx.restore();
  };

  // Draw Target baseline first
  plotSeries(targetCh.v, targetCh.color || app.getRawColors()[0], 1.8, isComputedChannel(targetCh));

  // Draw each queued waveform in its assigned color
  let scaledCount = 0;
  let unscaledMismatchCount = 0;
  compareQueue.forEach((entry, idx) => {
    const color = entry.customColor || getCompareGroupTraceColor(themeId, idx + colorOffset, paletteMode);
    if (entry.computed?.alignedRefV) {
      plotSeries(entry.computed.alignedRefV, color, 1.4, isComputedChannel(entry.channel));
    }
    if (Math.abs((entry.timeScale || 1) - 1) > 1e-6) {
      scaledCount++;
    } else {
      const rec = detectRecommendedTimeScale(targetCh, entry.channel);
      if (rec.isLargeMismatch) unscaledMismatchCount++;
    }
  });

  if (banner) {
    banner.innerText = `Preview: Base "${targetCh.name}" (${formatEng(tSpan, 's', 2)}, t0=${formatEng(tStart, 's', 2)}) + ${compareQueue.length} ref(s)`;
  }
  if (warnBanner) {
    if (unscaledMismatchCount > 0) {
      warnBanner.classList.remove('hidden');
      warnBanner.className = 'text-amber-300 font-semibold';
      warnBanner.innerText = `⚠ ${unscaledMismatchCount} trace(s) have ≥10× time-span difference — click "Match Span (ms↔s)"`;
    } else if (scaledCount > 0) {
      warnBanner.classList.remove('hidden');
      warnBanner.className = 'text-emerald-300';
      warnBanner.innerText = `✓ Auto Time-Scaled (${scaledCount} trace${scaledCount > 1 ? 's' : ''}) & t0 aligned`;
    } else {
      warnBanner.classList.add('hidden');
    }
  }

  ctx.restore();
}

function recomputeComparePanel(tab: TabState) {
  const wrap = document.getElementById('cmpQueueTableWrap');
  const countBadge = document.getElementById('cmpQueueCountBadge');
  if (!wrap) return;

  const tgtId = (document.getElementById('cmpTargetSelect') as HTMLSelectElement)?.value;
  const targetCh = tab.channels[tgtId] || tab.channels[tab.drawOrder[0]] || null;
  const paletteMode = ((document.getElementById('cmpPaletteModeSelect') as HTMLSelectElement)?.value || 'family') as 'family' | 'distinct';
  const tagTarget = !!(document.getElementById('cmpTagTargetChk') as HTMLInputElement)?.checked;
  const groupName = (document.getElementById('cmpGroupNameInput') as HTMLInputElement)?.value.trim() || `CMP${compareGroupCounter}`;
  const theme = COMPARE_GROUP_THEMES.find((t) => t.id === selectedCompareThemeId) || COMPARE_GROUP_THEMES[0];
  const colorOffset = tagTarget ? 1 : 0;

  if (countBadge) {
    countBadge.innerText = `${compareQueue.length} waveform(s) in [${groupName}]`;
    countBadge.style.color = theme.badgeColor;
  }

  if (!targetCh || compareQueue.length === 0) {
    wrap.innerHTML =
      '<div class="p-4 text-xs font-mono text-slate-400">Click <span class="text-cyan-300 font-semibold">+ Load File(s)...</span> (可多选 CSV/WFM 文件，同文件自动跳过) or <span class="text-cyan-300 font-semibold">+ Add Channel</span> to build a comparison group.</div>';
    renderComparePreviewCanvas(targetCh, paletteMode, theme.id, colorOffset);
    return;
  }

  const removeDc = !!(document.getElementById('cmpRemoveDcChk') as HTMLInputElement)?.checked;
  const tolMode = ((document.getElementById('cmpTolModeSelect') as HTMLSelectElement)?.value || 'percent') as 'percent' | 'absolute';
  const tolVal = parseFloat((document.getElementById('cmpTolValueInput') as HTMLInputElement)?.value || '5');
  const tolLimit = isFinite(tolVal) && tolVal > 0 ? tolVal : 5;

  const u = targetCh.unit || 'V';
  const fmt = (val: number | null, unitStr: string) =>
    val !== null && isFinite(val) ? formatEng(val, unitStr, 2) : '--';

  const table = document.createElement('table');
  table.className = 'w-full text-[11px] font-mono border-collapse tabular-nums';
  table.innerHTML = `
    <thead class="bg-[#161b22] text-slate-300 sticky top-0 z-10">
      <tr>
        <th class="p-2 border-b border-[#222933] text-left">Color</th>
        <th class="p-2 border-b border-[#222933] text-left">Group Waveform</th>
        <th class="p-2 border-b border-[#222933] text-left">Time Scale</th>
        <th class="p-2 border-b border-[#222933] text-left">Shift Δt (s)</th>
        <th class="p-2 border-b border-[#222933] text-right">Sim % / r</th>
        <th class="p-2 border-b border-[#222933] text-right">RMSE / MAE</th>
        <th class="p-2 border-b border-[#222933] text-right">Max |Δ|</th>
        <th class="p-2 border-b border-[#222933] text-center">Tol</th>
        <th class="p-2 border-b border-[#222933] text-right">Actions</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody')!;

  const tgtDur =
    targetCh.t.length >= 2 ? Math.abs(targetCh.t[targetCh.t.length - 1] - targetCh.t[0]) : 0;

  compareQueue.forEach((entry, idx) => {
    const scale = isFinite(entry.timeScale) && entry.timeScale > 0 ? entry.timeScale : 1;
    const aligned = alignAndInterpolateReference(targetCh, entry.channel, entry.timeShiftSec || 0, removeDc, scale);
    const metrics = computeWaveformCompareMetrics(targetCh, aligned.alignedRefV, removeDc);
    const golden = evaluateGoldenTolerance(targetCh, {
      enabled: true,
      channelId: targetCh.id,
      mode: tolMode,
      tolerance: tolLimit,
      refV: aligned.alignedRefV,
      refLabel: entry.label,
    });

    entry.computed = {
      alignedRefV: aligned.alignedRefV,
      diffV: aligned.diffV,
      metrics,
      pass: golden.pass,
      violationCount: golden.violationCount,
    };

    const refDur =
      entry.channel.t.length >= 2
        ? Math.abs(entry.channel.t[entry.channel.t.length - 1] - entry.channel.t[0])
        : 0;
    const refDt =
      entry.channel.dt ||
      (entry.channel.t.length >= 2 ? Math.abs(entry.channel.t[1] - entry.channel.t[0]) : 0);
    const fitRatio = tgtDur > 1e-18 && refDur > 1e-18 ? tgtDur / refDur : 1;
    const presetScales = [1, 0.001, 1e-6, 1000, 1e6];
    const matchedPreset = presetScales.find((p) => Math.abs(scale - p) / p < 1e-4);

    const assignedColor = entry.customColor || getCompareGroupTraceColor(theme.id, idx + colorOffset, paletteMode);
    const tr = document.createElement('tr');
    tr.className = 'border-b border-[#1b222c] hover:bg-[#161b22]/80 text-slate-200';
    tr.innerHTML = `
      <td class="p-1.5">
        <div class="flex items-center gap-1">
          <span class="w-1 h-5 rounded-xs shrink-0" style="background:${theme.badgeColor}" title="Group [${groupName}]"></span>
          <input type="color" class="cmp-row-color w-6 h-5 bg-transparent border border-[#2c3543] rounded-xs cursor-pointer p-0" value="${assignedColor}" title="Trace color in group [${groupName}]" />
        </div>
      </td>
      <td class="p-1.5 max-w-[180px]">
        <div class="flex items-center gap-1 truncate" title="[${groupName}] ${entry.label}">
          <span class="text-[9px] font-bold px-1 rounded-xs border shrink-0" style="color:${theme.badgeColor};border-color:${theme.badgeColor}">${groupName}</span>
          <span class="truncate text-slate-100">${entry.label}</span>
        </div>
        <div class="text-[9px] text-slate-400 truncate">
          Span ${formatEng(refDur, 's', 2)} · dt ${formatEng(refDt, 's', 1)} · t0=${formatEng(entry.channel.t[0] || 0, 's', 1)}
        </div>
      </td>
      <td class="p-1.5">
        <select class="cmp-row-scale bg-[#12161c] border border-[#222933] rounded-xs px-1 py-0.5 text-[10px] text-cyan-200 font-mono">
          <option value="1" ${matchedPreset === 1 ? 'selected' : ''}>1×</option>
          <option value="0.001" ${matchedPreset === 0.001 ? 'selected' : ''}>×0.001 (ms→s)</option>
          <option value="0.000001" ${matchedPreset === 1e-6 ? 'selected' : ''}>×1e-6 (µs→s)</option>
          <option value="1000" ${matchedPreset === 1000 ? 'selected' : ''}>×1000 (s→ms)</option>
          <option value="1000000" ${matchedPreset === 1e6 ? 'selected' : ''}>×1e6 (s→µs)</option>
          <option value="fit">Fit Span (×${Number(fitRatio.toPrecision(3))})</option>
          ${!matchedPreset ? `<option value="${scale}" selected>×${Number(scale.toPrecision(3))}</option>` : ''}
        </select>
      </td>
      <td class="p-1.5">
        <div class="flex items-center gap-1">
          <input type="number" step="any" class="cmp-row-shift w-20 bg-[#12161c] border border-[#222933] rounded-xs px-1.5 py-0.5 text-white" value="${Number((entry.timeShiftSec || 0).toPrecision(5))}" />
          <button type="button" class="cmp-row-xcorr px-1.5 py-0.5 bg-[#161b22] hover:bg-[#1e2530] border border-[#2c3543] text-amber-300 rounded-xs cursor-pointer" title="Auto XCorr align this trace">Auto</button>
        </div>
      </td>
      <td class="p-1.5 text-right">
        <div class="text-cyan-300 font-semibold">${metrics.similarityPct !== null ? metrics.similarityPct.toFixed(1) + '%' : '--'}</div>
        <div class="text-[10px] text-slate-400">r=${metrics.correlation !== null ? metrics.correlation.toFixed(3) : '--'}</div>
      </td>
      <td class="p-1.5 text-right">
        <div>${fmt(metrics.rmse, u)}</div>
        <div class="text-[10px] text-slate-400">${fmt(metrics.mae, u)}</div>
      </td>
      <td class="p-1.5 text-right">
        <div class="text-amber-300">${fmt(metrics.maxAbsDiff, u)}</div>
        <div class="text-[10px] text-slate-400">@${fmt(metrics.maxAbsDiffTime, 's')}</div>
      </td>
      <td class="p-1.5 text-center">
        <span class="font-semibold ${golden.pass ? 'text-emerald-400' : 'text-red-400'}">${golden.pass ? 'PASS' : `FAIL(${golden.violationCount})`}</span>
      </td>
      <td class="p-1.5 text-right whitespace-nowrap">
        <button type="button" class="cmp-row-jump px-1.5 py-0.5 bg-[#161b22] hover:bg-[#1e2530] border border-amber-600/50 text-amber-300 rounded-xs cursor-pointer mr-1" title="Jump to Max |Δ|">Jump</button>
        <button type="button" class="cmp-row-del px-1.5 py-0.5 bg-[#161b22] hover:bg-red-950/60 border border-[#222933] text-red-300 rounded-xs cursor-pointer" title="Remove from group">✕</button>
      </td>
    `;

    tr.querySelector('.cmp-row-color')?.addEventListener('input', (e: any) => {
      entry.customColor = e.target.value;
      renderComparePreviewCanvas(targetCh, paletteMode, theme.id, colorOffset);
    });
    tr.querySelector('.cmp-row-scale')?.addEventListener('change', (e: any) => {
      const val = e.target.value;
      if (val === 'fit') {
        entry.timeScale = fitRatio;
        entry.timeShiftSec = computeAutoTimeAlignShift(targetCh, entry.channel, 'start', entry.timeScale);
      } else {
        const parsedScale = parseFloat(val);
        entry.timeScale = isFinite(parsedScale) && parsedScale > 0 ? parsedScale : 1;
      }
      recomputeComparePanel(tab);
    });
    tr.querySelector('.cmp-row-shift')?.addEventListener('change', (e: any) => {
      const v = parseFloat(e.target.value);
      entry.timeShiftSec = isFinite(v) ? v : 0;
      recomputeComparePanel(tab);
    });
    tr.querySelector('.cmp-row-xcorr')?.addEventListener('click', () => {
      entry.timeShiftSec = computeAutoTimeAlignShift(targetCh, entry.channel, 'xcorr', entry.timeScale || 1);
      recomputeComparePanel(tab);
    });
    tr.querySelector('.cmp-row-jump')?.addEventListener('click', () => {
      if (metrics.maxAbsDiffIndex !== null) {
        app.jumpToSampleIndex(targetCh.id, metrics.maxAbsDiffIndex);
        document.getElementById('compareModal')!.style.display = 'none';
      }
    });
    tr.querySelector('.cmp-row-del')?.addEventListener('click', () => {
      compareQueue = compareQueue.filter((q) => q.id !== entry.id);
      recomputeComparePanel(tab);
    });

    tbody.appendChild(tr);
  });

  wrap.innerHTML = '';
  wrap.appendChild(table);
  renderComparePreviewCanvas(targetCh, paletteMode, theme.id, colorOffset);
}

function openCompareModal(tab: TabState, editGroupId?: string) {
  const modal = document.getElementById('compareModal');
  if (!modal) return;

  editingCompareGroupId = editGroupId || null;

  const grpInp = document.getElementById('cmpGroupNameInput') as HTMLInputElement | null;
  if (editGroupId) {
    const groupMembers = tab.drawOrder
      .map((id) => tab.channels[id])
      .filter((c): c is WaveformChannel => !!c && c.compareGroupId === editGroupId);
    const sample = groupMembers[0];
    if (sample) {
      if (grpInp && sample.compareGroupName) grpInp.value = sample.compareGroupName;
      const matchedTheme = COMPARE_GROUP_THEMES.find((t) => t.badgeColor.toLowerCase() === (sample.compareGroupColor || '').toLowerCase());
      if (matchedTheme) selectedCompareThemeId = matchedTheme.id;
      const targetMember = groupMembers.find((m) => m.compareRole === 'target');
      const tgtSel = document.getElementById('cmpTargetSelect') as HTMLSelectElement | null;
      if (targetMember && tgtSel) {
        populateCompareDropdowns(tab);
        tgtSel.value = targetMember.id;
      }
    }
    const savedQueue = appliedCompareGroupQueues.get(editGroupId);
    if (savedQueue && savedQueue.length > 0) {
      compareQueue = savedQueue.map((e) => ({ ...e }));
    } else {
      const refMembers = groupMembers.filter((m) => m.compareRole === 'ref');
      const prefix = sample?.compareGroupName ? `[${sample.compareGroupName}] ` : '';
      compareQueue = refMembers.map((rm) => ({
        id: rm.id,
        sourceKey: `tab:${tab.id}::${rm.id}`,
        label: rm.name.startsWith(prefix) ? rm.name.slice(prefix.length) : rm.name,
        channel: rm,
        timeShiftSec: 0,
        timeScale: 1,
        customColor: rm.color,
      }));
    }
  } else {
    // Suggest next non-colliding group name like CMP1, CMP2...
    const existingGroupNames = new Set(
      tab.drawOrder
        .map((id) => tab.channels[id]?.compareGroupName)
        .filter((n): n is string => !!n)
    );
    while (existingGroupNames.has(`CMP${compareGroupCounter}`)) {
      compareGroupCounter++;
    }
    if (grpInp && (!grpInp.value.trim() || /^CMP\d+$/.test(grpInp.value.trim()) || existingGroupNames.has(grpInp.value.trim()))) {
      grpInp.value = `CMP${compareGroupCounter}`;
    }
  }

  renderCompareGroupSwatches();
  const defKey = populateCompareDropdowns(tab);
  if (compareQueue.length === 0 && defKey && !editGroupId) {
    const resolved = resolveRefSourceByKey(defKey);
    if (resolved) {
      const tgtSel = document.getElementById('cmpTargetSelect') as HTMLSelectElement | null;
      const targetCh = (tgtSel?.value && tab.channels[tgtSel.value]) || tab.channels[tab.drawOrder[0]] || null;
      const entry: CompareQueueEntry = {
        id: `q_init_${Date.now()}`,
        sourceKey: defKey,
        label: resolved.label,
        channel: resolved.channel,
        timeShiftSec: 0,
        timeScale: 1,
        fingerprint: resolved.fingerprint,
      };
      if (targetCh) {
        const rec = detectRecommendedTimeScale(targetCh, entry.channel);
        if (rec.isLargeMismatch) {
          entry.timeScale = rec.timeScale;
          entry.autoScaledFrom = rec.ratio;
        }
        entry.timeShiftSec = computeAutoTimeAlignShift(targetCh, entry.channel, 'start', entry.timeScale);
      }
      compareQueue.push(entry);
    }
  }
  modal.style.display = 'flex';
  requestAnimationFrame(() => recomputeComparePanel(tab));
}

function setBldcTab(tabKey: 'balance' | 'hall' | 'pwm' | 'ripple') {
  const tabs: Array<{ key: 'balance' | 'hall' | 'pwm' | 'ripple'; btnId: string; panelId: string }> = [
    { key: 'balance', btnId: 'bldcTabBalanceBtn', panelId: 'bldcPanelBalance' },
    { key: 'hall', btnId: 'bldcTabHallBtn', panelId: 'bldcPanelHall' },
    { key: 'pwm', btnId: 'bldcTabPwmBtn', panelId: 'bldcPanelPwm' },
    { key: 'ripple', btnId: 'bldcTabRippleBtn', panelId: 'bldcPanelRipple' },
  ];
  tabs.forEach((t) => {
    const btn = document.getElementById(t.btnId);
    const panel = document.getElementById(t.panelId);
    const active = t.key === tabKey;
    if (btn) {
      btn.className = active
        ? 'bldc-tab-btn py-1.5 rounded-sm bg-orange-600 text-slate-950 font-semibold cursor-pointer'
        : 'bldc-tab-btn py-1.5 rounded-sm text-slate-300 hover:text-white cursor-pointer';
    }
    if (panel) {
      panel.classList.toggle('hidden', !active);
    }
  });
}

function getBldcGateBounds(tab: TabState, baseCh: WaveformChannel): { tStart?: number; tEnd?: number } {
  const gate = (document.getElementById('bldcGateSelect') as HTMLSelectElement)?.value || 'view';
  if (gate === 'cursors' && tab.cursors.enabled && tab.cursors.x1 !== null && tab.cursors.x2 !== null) {
    return {
      tStart: Math.min(tab.cursors.x1, tab.cursors.x2),
      tEnd: Math.max(tab.cursors.x1, tab.cursors.x2),
    };
  }
  if (gate === 'view') {
    return getTimeBoundsForView(tab, baseCh);
  }
  return {};
}

function openBldcModal(tab: TabState, initialTab: 'balance' | 'hall' | 'pwm' | 'ripple' = 'balance') {
  const modal = document.getElementById('bldcModal');
  if (!modal) return;

  const populateSelect = (selId: string, preferredIdx: number, includeNone = false) => {
    const sel = document.getElementById(selId) as HTMLSelectElement | null;
    if (!sel) return;
    sel.innerHTML = '';
    if (includeNone) {
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.text = '(None — Single Channel Only)';
      sel.appendChild(noneOpt);
    }
    tab.drawOrder.forEach((id, idx) => {
      const ch = tab.channels[id];
      if (!ch) return;
      const opt = document.createElement('option');
      opt.value = id;
      opt.text = ch.isMath ? `[M] ${ch.name} (${ch.unit || 'V'})` : `CH${idx + 1}: ${ch.name} (${ch.unit || 'V'})`;
      if (idx === preferredIdx) opt.selected = true;
      sel.appendChild(opt);
    });
    if (includeNone && preferredIdx < 0) sel.value = '';
  };

  const maxIdx = Math.max(0, tab.drawOrder.length - 1);
  populateSelect('bldcBalUSelect', 0);
  populateSelect('bldcBalVSelect', Math.min(1, maxIdx));
  populateSelect('bldcBalWSelect', Math.min(2, maxIdx));

  const hallAIdx = tab.drawOrder.findIndex((id) => /hall.*a|h1|ha/i.test(tab.channels[id]?.name || ''));
  const hallBIdx = tab.drawOrder.findIndex((id) => /hall.*b|h2|hb/i.test(tab.channels[id]?.name || ''));
  const hallCIdx = tab.drawOrder.findIndex((id) => /hall.*c|h3|hc/i.test(tab.channels[id]?.name || ''));
  populateSelect('bldcHallASelect', hallAIdx >= 0 ? hallAIdx : 0);
  populateSelect('bldcHallBSelect', hallBIdx >= 0 ? hallBIdx : Math.min(1, maxIdx));
  populateSelect('bldcHallCSelect', hallCIdx >= 0 ? hallCIdx : Math.min(2, maxIdx));
  const polesInp = document.getElementById('bldcHallPolesInput') as HTMLInputElement | null;
  if (polesInp && tab.motorConfig.polePairs) polesInp.value = String(tab.motorConfig.polePairs);

  const pwmHIdx = tab.drawOrder.findIndex((id) => /pwm|gate|high|sw/i.test(tab.channels[id]?.name || ''));
  const pwmLIdx = tab.drawOrder.findIndex((id) => /low|gl|pwm_l/i.test(tab.channels[id]?.name || ''));
  populateSelect('bldcPwmHighSelect', pwmHIdx >= 0 ? pwmHIdx : 0);
  populateSelect('bldcPwmLowSelect', pwmLIdx >= 0 ? pwmLIdx : -1, true);

  const currIdx = tab.drawOrder.findIndex(
    (id) => tab.channels[id]?.unit === 'A' || /cur|iq|ia|ibus|torque|power/i.test(tab.channels[id]?.name || '')
  );
  populateSelect('bldcRippleChSelect', currIdx >= 0 ? currIdx : maxIdx);

  setBldcTab(initialTab);
  modal.style.display = 'flex';
  renderBldcBalance(tab);
}

function renderBldcBalance(tab: TabState) {
  const card = document.getElementById('bldcBalResultCard');
  if (!card) return;
  const uId = (document.getElementById('bldcBalUSelect') as HTMLSelectElement)?.value;
  const vId = (document.getElementById('bldcBalVSelect') as HTMLSelectElement)?.value;
  const wId = (document.getElementById('bldcBalWSelect') as HTMLSelectElement)?.value;
  const chU = tab.channels[uId];
  const chV = tab.channels[vId];
  const chW = tab.channels[wId];
  if (!chU || !chV || !chW) {
    card.innerHTML = '<div class="text-amber-300">Select 3 valid phase channels.</div>';
    return;
  }
  const { tStart, tEnd } = getBldcGateBounds(tab, chU);
  const res = analyzeThreePhaseBalance(chU, chV, chW, tStart, tEnd);
  const unit = chU.unit || 'V';
  const unbalOk = res.vppUnbalancePct <= 3 && res.rmsUnbalancePct <= 3;
  const angOk = res.maxPhaseErrorDeg === null || res.maxPhaseErrorDeg <= 3;

  card.innerHTML = `
    <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] pb-2 border-b border-[#222933]">
      <div class="bg-[#12161c] p-2 rounded-sm border border-[#1f2732]">
        <div class="text-slate-400">Vpp Unbalance</div>
        <div class="font-bold text-sm ${unbalOk ? 'text-emerald-400' : 'text-amber-300'}">${res.vppUnbalancePct.toFixed(2)}%</div>
      </div>
      <div class="bg-[#12161c] p-2 rounded-sm border border-[#1f2732]">
        <div class="text-slate-400">RMS Unbalance</div>
        <div class="font-bold text-sm ${unbalOk ? 'text-emerald-400' : 'text-amber-300'}">${res.rmsUnbalancePct.toFixed(2)}%</div>
      </div>
      <div class="bg-[#12161c] p-2 rounded-sm border border-[#1f2732]">
        <div class="text-slate-400">Zero-Seq V0 RMS</div>
        <div class="font-bold text-sm text-purple-300">${formatEng(res.zeroSeqRms, unit, 2)}</div>
      </div>
      <div class="bg-[#12161c] p-2 rounded-sm border border-[#1f2732]">
        <div class="text-slate-400">Max 120° Err</div>
        <div class="font-bold text-sm ${angOk ? 'text-cyan-300' : 'text-amber-300'}">${res.maxPhaseErrorDeg !== null ? res.maxPhaseErrorDeg.toFixed(2) + '°' : '--'}</div>
      </div>
    </div>
    <div class="grid grid-cols-3 gap-2 text-[11px] pt-1">
      ${res.phases
        .map(
          (p) => `
        <div class="bg-[#12161c] p-2 rounded-sm border border-[#1f2732]">
          <div class="text-slate-200 font-semibold truncate">${p.name}</div>
          <div class="text-slate-400">RMS: <span class="text-slate-100">${formatEng(p.rms, unit, 2)}</span></div>
          <div class="text-slate-400">Vpp: <span class="text-slate-100">${formatEng(p.vpp, unit, 2)}</span></div>
          <div class="text-slate-400">DC: <span class="text-slate-100">${formatEng(p.mean, unit, 2)}</span></div>
        </div>`
        )
        .join('')}
    </div>
    <div class="flex flex-wrap justify-between gap-2 text-[11px] text-slate-300 pt-1">
      <span>ΔΦ(U→V): <strong class="text-cyan-300">${res.angleUVDeg !== null ? res.angleUVDeg.toFixed(2) + '°' : '--'}</strong></span>
      <span>ΔΦ(V→W): <strong class="text-cyan-300">${res.angleVWDeg !== null ? res.angleVWDeg.toFixed(2) + '°' : '--'}</strong></span>
      <span>ΔΦ(W→U): <strong class="text-cyan-300">${res.angleWUDeg !== null ? res.angleWUDeg.toFixed(2) + '°' : '--'}</strong></span>
      <span>V0 Vpp: <strong class="text-purple-300">${formatEng(res.zeroSeqVpp, unit, 2)}</strong></span>
    </div>
  `;
}

function renderBldcHall(tab: TabState) {
  const card = document.getElementById('bldcHallResultCard');
  if (!card) return;
  const aId = (document.getElementById('bldcHallASelect') as HTMLSelectElement)?.value;
  const bId = (document.getElementById('bldcHallBSelect') as HTMLSelectElement)?.value;
  const cId = (document.getElementById('bldcHallCSelect') as HTMLSelectElement)?.value;
  const poles = parseInt((document.getElementById('bldcHallPolesInput') as HTMLInputElement)?.value || '4', 10) || 4;
  const chA = tab.channels[aId];
  const chB = tab.channels[bId];
  const chC = tab.channels[cId];
  if (!chA || !chB || !chC) {
    card.innerHTML = '<div class="text-amber-300">Select 3 Hall / Back-EMF channels.</div>';
    return;
  }
  const { tStart, tEnd } = getBldcGateBounds(tab, chA);
  const res = analyzeBldcHallCommutation(chA, chB, chC, poles, tStart, tEnd);

  if (res.commutationCount === 0) {
    card.innerHTML = `
      <div class="text-amber-300">No full 6-step commutation sectors detected in the selected gate window.</div>
      <div class="text-slate-400 text-[11px]">Illegal States: ${res.illegalStateCount} · Sequence Jumps: ${res.sequenceJumpCount} (Ensure digital Hall or BEMF signals span at least several transitions)</div>
    `;
    return;
  }

  card.innerHTML = `
    <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] pb-2 border-b border-[#222933]">
      <div class="bg-[#12161c] p-2 rounded-sm border border-[#1f2732]">
        <div class="text-slate-400">Direction / Seq</div>
        <div class="font-bold text-cyan-300">${res.direction}</div>
        <div class="text-[10px] text-slate-400">${res.sequence.join('→') || '--'}</div>
      </div>
      <div class="bg-[#12161c] p-2 rounded-sm border border-[#1f2732]">
        <div class="text-slate-400">Speed / Elec Freq</div>
        <div class="font-bold text-emerald-300">${res.avgRpm !== null ? res.avgRpm.toFixed(1) + ' RPM' : '--'}</div>
        <div class="text-[10px] text-slate-400">${res.avgElecFreqHz !== null ? formatEng(res.avgElecFreqHz, 'Hz', 2) : '--'}</div>
      </div>
      <div class="bg-[#12161c] p-2 rounded-sm border border-[#1f2732]">
        <div class="text-slate-400">Max 60° Sector Err</div>
        <div class="font-bold ${(res.maxSectorErrorDeg ?? 0) <= 3 ? 'text-emerald-300' : 'text-amber-300'}">${res.maxSectorErrorDeg !== null ? res.maxSectorErrorDeg.toFixed(2) + '°' : '--'}</div>
        <div class="text-[10px] text-slate-400">RPM Ripple: ${res.rpmRipplePct !== null ? res.rpmRipplePct.toFixed(2) + '%' : '--'}</div>
      </div>
      <div class="bg-[#12161c] p-2 rounded-sm border border-[#1f2732]">
        <div class="text-slate-400">Faults (000/111/Skip)</div>
        <div class="font-bold ${res.illegalStateCount + res.sequenceJumpCount === 0 ? 'text-emerald-400' : 'text-red-400'}">${res.illegalStateCount} Illegal / ${res.sequenceJumpCount} Skip</div>
        <div class="text-[10px] text-slate-400">Sectors: ${res.commutationCount}</div>
      </div>
    </div>
    <div class="grid grid-cols-3 md:grid-cols-6 gap-1.5 text-[10px] pt-1">
      ${res.sectorStats
        .map(
          (s) => `
        <div class="bg-[#12161c] p-1.5 rounded-sm border border-[#1f2732]">
          <div class="text-slate-200 font-semibold">State ${s.stateCode} (${s.stateCode.toString(2).padStart(3, '0')})</div>
          <div class="text-cyan-300">${s.avgDeg.toFixed(2)}°</div>
          <div class="${Math.abs(s.errorDeg) <= 2 ? 'text-emerald-400' : 'text-amber-300'}">Δ=${s.errorDeg >= 0 ? '+' : ''}${s.errorDeg.toFixed(2)}°</div>
        </div>`
        )
        .join('')}
    </div>
    ${
      res.events.length > 0
        ? `<div class="pt-2 space-y-1 max-h-28 overflow-y-auto">
            <div class="text-[10px] text-amber-300 font-semibold">Detected Commutation Anomalies (click to jump):</div>
            ${res.events
              .slice(0, 12)
              .map(
                (ev) => `
              <button type="button" class="bldc-hall-jump w-full text-left px-2 py-1 bg-[#161b22] hover:bg-amber-950/40 border border-[#222933] rounded-xs text-[10px] flex justify-between cursor-pointer" data-idx="${ev.index}">
                <span class="text-amber-300">${ev.detail}</span>
                <span class="text-cyan-300">@ ${formatEng(ev.time, 's', 4)}</span>
              </button>`
              )
              .join('')}
           </div>`
        : '<div class="text-[11px] text-emerald-400 pt-1">✓ Clean 6-step commutation ring — 0 illegal codes or step skips.</div>'
    }
  `;

  card.querySelectorAll('.bldc-hall-jump').forEach((btn) => {
    btn.addEventListener('click', (e: any) => {
      const idx = parseInt(e.currentTarget?.dataset?.idx || '-1', 10);
      if (idx >= 0) app.jumpToSampleIndex(chA.id, idx);
    });
  });
}

function renderBldcPwm(tab: TabState) {
  const card = document.getElementById('bldcPwmResultCard');
  if (!card) return;
  const hId = (document.getElementById('bldcPwmHighSelect') as HTMLSelectElement)?.value;
  const lId = (document.getElementById('bldcPwmLowSelect') as HTMLSelectElement)?.value;
  const chH = tab.channels[hId];
  const chL = lId ? tab.channels[lId] || null : null;
  if (!chH) {
    card.innerHTML = '<div class="text-amber-300">Select a High-Side / Switch Node channel.</div>';
    return;
  }
  const { tStart, tEnd } = getBldcGateBounds(tab, chH);
  const res = analyzePwmSwitchingAndDeadTime(chH, chL, tStart, tEnd);

  card.innerHTML = `
    <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] pb-2 border-b border-[#222933]">
      <div class="bg-[#12161c] p-2 rounded-sm border border-[#1f2732]">
        <div class="text-slate-400">Carrier Freq / Pulses</div>
        <div class="font-bold text-cyan-300">${res.pwmFreqHz !== null ? formatEng(res.pwmFreqHz, 'Hz', 2) : '--'}</div>
        <div class="text-[10px] text-slate-400">${res.pulseCount} pulses</div>
      </div>
      <div class="bg-[#12161c] p-2 rounded-sm border border-[#1f2732]">
        <div class="text-slate-400">Duty (Min / Avg / Max)</div>
        <div class="font-bold text-slate-100">${res.dutyAvgPct !== null ? res.dutyAvgPct.toFixed(1) + '%' : '--'}</div>
        <div class="text-[10px] text-slate-400">${res.dutyMinPct !== null ? res.dutyMinPct.toFixed(1) + '% ~ ' + res.dutyMaxPct?.toFixed(1) + '%' : '--'}</div>
      </div>
      <div class="bg-[#12161c] p-2 rounded-sm border border-[#1f2732]">
        <div class="text-slate-400">Max dV/dt &amp; Overshoot</div>
        <div class="font-bold text-amber-300">${res.maxDvDtVPerUs !== null ? res.maxDvDtVPerUs.toFixed(1) + ' V/µs' : '--'}</div>
        <div class="text-[10px] text-slate-400">Overshoot: ${res.overshootPct !== null ? res.overshootPct.toFixed(1) + '%' : '--'}</div>
      </div>
      <div class="bg-[#12161c] p-2 rounded-sm border border-[#1f2732]">
        <div class="text-slate-400">LC Ringing Freq</div>
        <div class="font-bold text-purple-300">${res.ringingFreqHz !== null ? formatEng(res.ringingFreqHz, 'Hz', 2) : '--'}</div>
        <div class="text-[10px] text-slate-400">Post-edge oscillation</div>
      </div>
    </div>
    ${
      chL
        ? `<div class="flex flex-wrap items-center justify-between gap-2 pt-2 text-[11px]">
            <div>
              Dead-Time (Min / Avg / Max):
              <strong class="text-emerald-300">
                ${res.deadTimeMinSec !== null ? formatEng(res.deadTimeMinSec, 's', 2) : '--'} /
                ${res.deadTimeAvgSec !== null ? formatEng(res.deadTimeAvgSec, 's', 2) : '--'} /
                ${res.deadTimeMaxSec !== null ? formatEng(res.deadTimeMaxSec, 's', 2) : '--'}
              </strong>
              <span class="text-slate-400">(${res.deadTimeCount} edges)</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="${res.shootThroughCount > 0 ? 'text-red-400 font-bold' : 'text-emerald-400'}">
                Shoot-Through Overlaps: ${res.shootThroughCount}
              </span>
              ${
                res.worstEventIndex !== null
                  ? `<button id="bldcPwmJumpWorstBtn" type="button" class="px-2 py-0.5 bg-[#161b22] hover:bg-amber-950/50 border border-amber-500/60 text-amber-300 rounded-xs cursor-pointer">Jump to Min/Fault @ ${formatEng(res.worstEventTime || 0, 's', 3)}</button>`
                  : ''
              }
            </div>
          </div>`
        : '<div class="text-[11px] text-slate-400 pt-1">Tip: Select a complementary Low-Side gate channel above to compute dead-time (ns) and shoot-through overlaps.</div>'
    }
  `;

  document.getElementById('bldcPwmJumpWorstBtn')?.addEventListener('click', () => {
    if (res.worstEventIndex !== null) app.jumpToSampleIndex(chH.id, res.worstEventIndex);
  });
}

function renderBldcRipple(tab: TabState) {
  const card = document.getElementById('bldcRippleResultCard');
  if (!card) return;
  const chId = (document.getElementById('bldcRippleChSelect') as HTMLSelectElement)?.value;
  const ch = tab.channels[chId];
  if (!ch) {
    card.innerHTML = '<div class="text-amber-300">Select a current, torque, or bus power channel.</div>';
    return;
  }
  const feRaw = parseFloat((document.getElementById('bldcRippleFeInput') as HTMLInputElement)?.value || '');
  const feOverride = isFinite(feRaw) && feRaw > 0 ? feRaw : null;
  const { tStart, tEnd } = getBldcGateBounds(tab, ch);
  const res = analyzeTorqueAndCurrentRipple(ch, feOverride, tStart, tEnd);
  const unit = ch.unit || 'A';

  card.innerHTML = `
    <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] pb-2 border-b border-[#222933]">
      <div class="bg-[#12161c] p-2 rounded-sm border border-[#1f2732]">
        <div class="text-slate-400">Mean / RMS</div>
        <div class="font-bold text-slate-100">${formatEng(res.mean, unit, 2)}</div>
        <div class="text-[10px] text-slate-400">RMS: ${formatEng(res.rms, unit, 2)}</div>
      </div>
      <div class="bg-[#12161c] p-2 rounded-sm border border-[#1f2732]">
        <div class="text-slate-400">P-P Ripple / Factor</div>
        <div class="font-bold text-amber-300">${formatEng(res.peakToPeakRipple, unit, 2)}</div>
        <div class="text-[10px] text-slate-400">Ripple: ${res.rippleFactorPct.toFixed(1)}% · RMS: ${res.rmsRipplePct.toFixed(1)}%</div>
      </div>
      <div class="bg-[#12161c] p-2 rounded-sm border border-[#1f2732]">
        <div class="text-slate-400">Base Elec Freq fe</div>
        <div class="font-bold text-cyan-300">${res.fundamentalElecHz !== null ? formatEng(res.fundamentalElecHz, 'Hz', 2) : '--'}</div>
        <div class="text-[10px] text-slate-400">Dom: ${res.dominantRippleFreqHz !== null ? formatEng(res.dominantRippleFreqHz, 'Hz', 2) : '--'}</div>
      </div>
      <div class="bg-[#12161c] p-2 rounded-sm border border-[#1f2732]">
        <div class="text-slate-400">6× Commutation Harmonic</div>
        <div class="font-bold text-orange-300">${res.harm6xAmp !== null ? formatEng(res.harm6xAmp, unit, 3) : '--'}</div>
        <div class="text-[10px] text-slate-400">${res.sixthHarmonicPctOfMean !== null ? res.sixthHarmonicPctOfMean.toFixed(2) + '% of ref' : '--'}</div>
      </div>
    </div>
    <div class="grid grid-cols-4 gap-2 text-[11px] pt-1">
      <div class="bg-[#12161c] p-1.5 rounded-sm border border-[#1f2732]">1× fe: <strong class="text-slate-100">${res.harm1xAmp !== null ? formatEng(res.harm1xAmp, unit, 2) : '--'}</strong></div>
      <div class="bg-[#12161c] p-1.5 rounded-sm border border-[#1f2732]">2× fe: <strong class="text-slate-100">${res.harm2xAmp !== null ? formatEng(res.harm2xAmp, unit, 2) : '--'}</strong></div>
      <div class="bg-[#12161c] p-1.5 rounded-sm border border-[#1f2732]">6× fe: <strong class="text-orange-300">${res.harm6xAmp !== null ? formatEng(res.harm6xAmp, unit, 2) : '--'}</strong></div>
      <div class="bg-[#12161c] p-1.5 rounded-sm border border-[#1f2732]">12× fe: <strong class="text-slate-100">${res.harm12xAmp !== null ? formatEng(res.harm12xAmp, unit, 2) : '--'}</strong></div>
    </div>
  `;
}

/**
 * Generates synthetic 3-Phase BLDC motor data with clean 1-2-5 oscilloscope scaling.
 */
function loadSynthetic3PhaseMotorData() {
  const fs = 100000; // 100 kS/s
  const duration = 0.05; // 50 ms
  const n = Math.round(fs * duration);
  const fe = 200; // 200 Hz electrical frequency

  const t = new Float64Array(n);
  const ua = new Float32Array(n);
  const ub = new Float32Array(n);
  const uc = new Float32Array(n);
  const ia = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    t[i] = i / fs;
    const angle = 2 * Math.PI * fe * t[i];
    const v5th = 1.4 * Math.sin(5 * angle);
    ua[i] = 24.0 * Math.sin(angle) + v5th;
    ub[i] = 24.0 * Math.sin(angle - (2 * Math.PI) / 3) + v5th;
    uc[i] = 24.0 * Math.sin(angle + (2 * Math.PI) / 3) + v5th;
    ia[i] = 8.0 * Math.sin(angle - 0.2);
  }

  const createChannel = (id: string, name: string, data: Float32Array, color: string, unit: string): WaveformChannel => {
    const ch: WaveformChannel = {
      id,
      name,
      unit,
      color,
      visible: true,
      t,
      v: data,
      fs,
      dt: 1 / fs,
      isMath: false,
      sourceChannelIds: [],
      coupling: 'DC',
      inverted: false,
      metadata: {
        originalSampleCount: n,
        originalTimeStart: 0,
        originalTimeEnd: t[n - 1],
        isUniformSampling: true,
        nominalDt: 1 / fs,
        medianDt: 1 / fs,
        meanDt: 1 / fs,
        minDt: 1 / fs,
        maxDt: 1 / fs,
        jitterRms: 0,
        jitterMax: 0,
        droppedSamples: 0,
        invalidSamples: 0,
        sampleRate: fs,
        qualityStatus: 'uniform',
        gapCount: 0,
        gapIndices: [],
      },
      vMin: -40,
      vMax: 40,
    };
    fitChannelTo125(ch);
    return ch;
  };

  const rawPalette = app.getRawColors();
  const channels: Record<string, WaveformChannel> = {
    ua: createChannel('ua', 'Ua (Phase A)', ua, rawPalette[0], 'V'),
    ub: createChannel('ub', 'Ub (Phase B)', ub, rawPalette[1], 'V'),
    uc: createChannel('uc', 'Uc (Phase C)', uc, rawPalette[2], 'V'),
    ia: createChannel('ia', 'Ia (Current)', ia, rawPalette[3], 'A'),
  };

  const tab: TabState = {
    id: `tab_synthetic_${Date.now()}`,
    fileName: 'BLDC_3Phase_Drive_Sample.csv',
    channels,
    drawOrder: ['ua', 'ub', 'uc', 'ia'],
    view: { startIndex: 0, endIndex: Math.min(n, 2000) },
    cursors: {
      enabled: true,
      mode: 'xy',
      x1: 0.004,
      x2: 0.009,
      y1: 24.0,
      y2: -24.0,
      trackingChannel: 'ua',
    },
    annotations: [],
    annotationMode: false,
    annotationsVisible: true,
    isOverlap: false,
    plotMode: 'time',
    renderMode: 'vector',
    decimationMode: 'minmax',
    fftOptions: {
      range: 'view',
      window: 'hann',
      scale: 'db',
      zeroPadding: 2,
      removeDC: true,
    },
    motorConfig: { rpm: 3000, polePairs: 4, enabled: true },
    triggerConfig: {
      enabled: true,
      channelId: 'ua',
      type: 'rising',
      level: 0,
      positionPercent: 50,
    },
    measurementGate: 'view',
    selectedMeasurements: [],
    separateView: false,
    activeChannelId: 'ua',
    activeTool: 'pan',
  };

  app.addTab(tab);
}
