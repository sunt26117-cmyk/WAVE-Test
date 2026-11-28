/**
 * Waveform Viewer Pro - Main Entry Point
 * Initializes hardware-grade Web Oscilloscope workspace, binds all front-panel
 * vertical, horizontal, trigger, cursor, annotation, FFT, Math, and export controls.
 */

import './index.css';
import { OscilloscopeApp } from './engine/uiController';
import { runAllTests } from './tests/testSuite';
import { TabState, WaveformChannel, CursorMode, MeasurementGate, MeasurementMetricKey, ThemeId, CustomMeasurementUnitType } from './types/models';
import { formatEng, formatMeasurementMetricValue, getTimeBoundsForView, isComputedChannel } from './engine/canvasRenderer';
import { getSavedThemeId, resolveChannelTextColor, THEME_PRESETS } from './modules/themeManager';
import { LtspiceFileWatcher } from './modules/ltspiceWatcher';
import { setupToolDrawer } from './modules/toolDrawer';
import { fitChannelTo125, getTimebaseInfo } from './modules/oscilloscopeScale';
import { MEASUREMENT_DEFINITIONS, CUSTOM_MEASUREMENT_PRESETS } from './modules/measurements';
import { estimateSpeedFromSignal, computeTwoChannelPhaseDiff } from './modules/motorAnalysis';
import { runBatchAnalysisOnFiles, exportBatchResultsCSV, BatchFileRow } from './modules/batchAnalyzer';
import { escapeHtml } from './utils/html';
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
  buildMappedReferenceTrace,
  computeAutoTimeAlignShift,
  computeAutoTimeAlignDetailed,
  computeWaveformCompareMetrics,
  exportCompareSummaryCsv,
  parseReferenceFileToChannels,
  computeFileFingerprint,
  detectRecommendedTimeScale,
  canApplyCompareOverlay,
  AutoAlignMode,
  CompareStatus,
  WaveformCompareMetrics,
} from './modules/waveformCompare';
import { previewMathExpression } from './modules/mathParser';
import { FocMissionStage } from './modules/focThermal';
import { evaluateGoldenTolerance } from './modules/anomalyScanner';
import { setupDraggableModals } from './modules/draggableModals';
import {
  analyzeThreePhaseBalance,
  analyzeBldcHallCommutation,
  analyzePwmSwitchingAndDeadTime,
  analyzeTorqueAndCurrentRipple,
  computeBldcDerivedTraces,
  HALL_SEQUENCE_PRESETS,
  parseHallSequenceText,
  PwmHighSignalRole,
} from './modules/bldcAnalysis';
import { reconstructSingleShuntPhaseCurrents } from './modules/singleShuntRecon';
import { initThermalWorkbench, ThermalWorkbenchController } from './modules/thermalWorkbench';
import { FilterWorkbenchController } from './modules/filterWorkbench';
import { isExcelFileName } from './parsers/excelParser';
import { excelImportModal } from './modules/excelImportModal';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { FocDynoLabApp } from './components/focDyno/FocDynoLabApp';

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
    fullRefT: Float64Array;
    fullRefV: Float32Array;
    metrics: WaveformCompareMetrics;
    pass: boolean;
    violationCount: number;
    valid: boolean;
    status?: CompareStatus;
    reason?: string;
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
let thermalCtrl: ThermalWorkbenchController | null = null;
let filterCtrl: FilterWorkbenchController | null = null;
let activeWorkspace: 'scope' | 'focDyno' = 'scope';

function switchWorkspace(target: 'scope' | 'focDyno') {
  activeWorkspace = target;
  document.body.dataset.workspace = target;
  const scopeMain = document.getElementById('scopeWorkspaceMain');
  const dynoView = document.getElementById('focDynoLabView');
  const wsScopeBtn = document.getElementById('wsScopeBtn');
  const wsDynoBtn = document.getElementById('wsFocDynoBtn');
  const togglePanelBtn = document.getElementById('togglePanelBtn');

  const isScope = target === 'scope';
  if (scopeMain) scopeMain.classList.toggle('hidden', !isScope);
  if (dynoView) dynoView.classList.toggle('hidden', isScope);
  if (togglePanelBtn) togglePanelBtn.classList.toggle('hidden', !isScope);

  wsScopeBtn?.setAttribute('aria-pressed', isScope ? 'true' : 'false');
  wsDynoBtn?.setAttribute('aria-pressed', !isScope ? 'true' : 'false');

  if (isScope) {
    requestAnimationFrame(() => app?.handleResize());
  } else {
    window.dispatchEvent(new CustomEvent('wvp-workspace-shown'));
  }
}

function syncLtspiceWatchUI() {
  const tab = app?.getActiveTab() || null;
  const entry = ltspiceWatcher?.getEntry(tab?.id || null) || null;
  const strip = document.getElementById('ltspiceHeaderStatusStrip');
  const reloadBtn = document.getElementById('reloadLtspiceBtn');
  const autoWrap = document.getElementById('ltspiceAutoWrap');
  const autoChk = document.getElementById('autoLtspiceChk') as HTMLInputElement | null;
  const badge = document.getElementById('ltspiceWatchBadge');

  if (entry) {
    if (strip) {
      strip.classList.remove('hidden');
      strip.classList.add('flex');
    }
    reloadBtn?.classList.remove('hidden');
    if (autoWrap) {
      autoWrap.classList.remove('hidden');
      autoWrap.classList.add('inline-flex');
    }
    if (autoChk) autoChk.checked = entry.autoReload;
    if (badge) {
      badge.classList.remove('hidden');
      badge.innerText = entry.autoReload ? '实时' : '暂停';
    }
  } else {
    if (strip) {
      strip.classList.add('hidden');
      strip.classList.remove('flex');
    }
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

  // Re-measure Compare / Filter live preview canvas when switched/shown inside Tool Drawer
  window.addEventListener('wvp-drawer-panel-shown', (ev: Event) => {
    const detail = (ev as CustomEvent<{ id: string }>).detail;
    if (detail?.id === 'compareModal') {
      requestAnimationFrame(() => {
        const tab = app.getActiveTab();
        if (tab) recomputeComparePanel(tab);
      });
    } else if (detail?.id === 'filterModal') {
      requestAnimationFrame(() => filterCtrl?.syncIfOpen());
    }
  });

  // Forward Tool Drawer notifications (e.g. max 3 tabs eviction) to unified Toast
  window.addEventListener('wvp-drawer-notify', (ev: Event) => {
    const detail = (ev as CustomEvent<{ message: string; level?: 'info' | 'warn' | 'error' }>).detail;
    if (detail?.message) {
      app.showToast(detail.message, detail.level || 'info');
    }
  });

  // Right-panel collapsible accordions with localStorage persistence
  const accordionStorageKey = 'wvp_right_accordions_v1';
  let savedAccordions: Record<string, boolean> = {};
  try {
    const raw = localStorage.getItem(accordionStorageKey);
    if (raw) savedAccordions = JSON.parse(raw) || {};
  } catch {
    savedAccordions = {};
  }
  document.querySelectorAll('.wvp-accordion-section[data-accordion-key]').forEach((sec) => {
    const key = sec.getAttribute('data-accordion-key') || '';
    if (key && savedAccordions[key] === true) {
      sec.classList.add('is-collapsed');
    }
    const header = sec.querySelector('.wvp-accordion-header');
    header?.addEventListener('click', () => {
      const collapsed = sec.classList.toggle('is-collapsed');
      if (key) {
        savedAccordions[key] = collapsed;
        try {
          localStorage.setItem(accordionStorageKey, JSON.stringify(savedAccordions));
        } catch {
          // ignore storage error
        }
      }
    });
  });

  bindToolbarActions();
  bindFrontPanelControls();
  bindModals();
  thermalCtrl = initThermalWorkbench(app);
  filterCtrl = new FilterWorkbenchController(app);
  setupDraggableModals();

  // Workspace switcher buttons
  document.getElementById('wsScopeBtn')?.addEventListener('click', () => switchWorkspace('scope'));
  document.getElementById('wsFocDynoBtn')?.addEventListener('click', () => switchWorkspace('focDyno'));

  // Mount embedded FOC DynoLab V2 workspace
  const dynoRootEl = document.getElementById('focDynoLabView');
  if (dynoRootEl) {
    const reactRoot = createRoot(dynoRootEl);
    reactRoot.render(
      React.createElement(FocDynoLabApp, {
        getActiveScopeTab: () => app.getActiveTab(),
        onSendTabToScope: (tab) => {
          app.addTab(tab);
          switchWorkspace('scope');
        },
        onSendToSixMosThermal: (payload) => {
          switchWorkspace('scope');
          requestAnimationFrame(() => {
            thermalCtrl?.loadExternalFocAnalysis(payload);
          });
        },
        onAppendMissionStage: (stage: FocMissionStage) => {
          switchWorkspace('scope');
          requestAnimationFrame(() => {
            thermalCtrl?.appendMissionStageFromDyno(stage, true);
          });
        },
        onNotify: (msg, level = 'info') => app.showToast(msg, level),
      })
    );
  }

  syncLtspiceWatchUI();
});

function bindToolbarActions() {
  // Load File button + empty state quick open + LTspice Live Watch
  const fileInput = document.getElementById('fileInput') as HTMLInputElement;
  const triggerOpen = () => fileInput?.click();
  document.getElementById('loadBtn')?.addEventListener('click', triggerOpen);
  document.getElementById('emptyLoadBtn')?.addEventListener('click', triggerOpen);

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
      app.showToast('已关联 LTspice 文件，仿真重跑后将自动重载波形。', 'info');
    }
    syncLtspiceWatchUI();
  });

  document.getElementById('reloadLtspiceBtn')?.addEventListener('click', async () => {
    const tab = app.getActiveTab();
    if (tab && ltspiceWatcher) {
      const ok = await ltspiceWatcher.forceReload(tab.id);
      if (!ok) app.showToast('当前标签页未关联可热重载的 LTspice 文件。', 'warn');
    }
  });

  document.getElementById('autoLtspiceChk')?.addEventListener('change', () => {
    const tab = app.getActiveTab();
    if (tab && ltspiceWatcher) {
      ltspiceWatcher.toggleAutoReload(tab.id);
    }
  });

  document.getElementById('tabsContainer')?.addEventListener('click', () => {
    requestAnimationFrame(() => {
      syncLtspiceWatchUI();
      filterCtrl?.syncIfOpen();
    });
  });

  // Theme Selector
  document.getElementById('themeSelect')?.addEventListener('change', (e: any) => {
    const themeId = e.target.value as ThemeId;
    app.setTheme(themeId, true);
    const tab = app.getActiveTab();
    const cmpModal = document.getElementById('compareModal');
    if (cmpModal && cmpModal.style.display === 'flex' && tab) {
      recomputeComparePanel(tab);
    }
    const measModal = document.getElementById('measureModal');
    if (measModal && measModal.style.display === 'flex' && tab) {
      renderMeasureModalCheckboxes(tab);
    }
    filterCtrl?.syncIfOpen();
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
    item.addEventListener('click', () => {
      if (!item.closest('.wvp-dropdown-keep-open')) {
        closeAllDropdowns();
      }
    });
  });
  document.querySelectorAll('.wvp-dropdown-keep-open').forEach((el) => {
    el.addEventListener('click', (e) => e.stopPropagation());
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
  document.getElementById('openEditModalBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) openWaveformEditModal(tab);
  });
  document.getElementById('openCropExportMenuBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) openCropExportModal(tab);
  });

  // Dynamic Measurement Strip Actions
  document.getElementById('stripMeasStatsToggleBtn')?.addEventListener('click', () => {
    app.toggleMeasurementStats();
  });
  document.getElementById('stripCopyMeasBtn')?.addEventListener('click', () => {
    void app.copyMeasurementStripTable();
  });
  document.getElementById('stripAddMeasBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) openMeasureModal(tab);
  });
  document.getElementById('stripClearMeasBtn')?.addEventListener('click', () => app.clearAllMeasurements());
  document.getElementById('stripMeasGateSelect')?.addEventListener('change', (e: any) => {
    const tab = app.getActiveTab();
    if (tab) {
      tab.measurementGate = e.target.value as MeasurementGate;
      const modalGate = document.getElementById('measureModalGateSelect') as HTMLSelectElement | null;
      if (modalGate) modalGate.value = tab.measurementGate;
      app.renderMeasurementStrip(tab);
      const measModal = document.getElementById('measureModal');
      if (measModal && measModal.style.display === 'flex') {
        renderMeasureModalCheckboxes(tab);
      }
    }
  });

  // AutoSet, Fit, Sync Same-Unit, Undo/Redo, Zoom Box, Annotations
  document.getElementById('syncUnitScaleBtn')?.addEventListener('click', () => app.syncSameUnitScales());
  document.getElementById('undoBtn')?.addEventListener('click', () => {
    app.undo();
    filterCtrl?.syncIfOpen();
  });
  document.getElementById('redoBtn')?.addEventListener('click', () => {
    app.redo();
    filterCtrl?.syncIfOpen();
  });
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
  document.getElementById('openFilterModalBtn')?.addEventListener('click', () => {
    filterCtrl?.open(app.getActiveTab());
  });
  document.getElementById('openFilterMenuBtn')?.addEventListener('click', () => {
    filterCtrl?.open(app.getActiveTab());
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

  // Math & Transform & Motor buttons
  document.getElementById('addMathBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) openMathModal(tab);
  });
  document.getElementById('transformBtn')?.addEventListener('click', () => {
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
      app.showToast('当前已经在运行独立的离线 HTML 文件。');
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
      app.showToast('已下载离线独立单页版（waveform-viewer-pro.html）。');
    } catch (err: any) {
      app.showToast(`离线 HTML 下载失败：${err?.message || '暂不可用'}`, 'error');
    }
  };
  document.getElementById('exportStandaloneHtmlBtn')?.addEventListener('click', triggerOfflineHtmlDownload);
  document.getElementById('saveSessionBtn')?.addEventListener('click', () => app.saveSessionFile());
  document.getElementById('testSuiteBtn')?.addEventListener('click', () => openTestSuiteModal());
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
    if (tab && ch) {
      ch.color = colorInp.value;
      app.renderSidebar();
      app.renderMeasurementStrip(tab);
      const measModal = document.getElementById('measureModal');
      if (measModal && measModal.style.display === 'flex') {
        renderMeasureModalCheckboxes(tab);
      }
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

  // --- 1b. Direct Per-Channel Horizontal Time Shift Δt Controls ---
  const getTimeShiftNudgeStep = (tab: TabState, ch: WaveformChannel, shiftKey: boolean): number => {
    const tb = getTimebaseInfo(tab);
    const chDt = ch.dt || (ch.t.length >= 2 ? Math.abs(ch.t[1] - ch.t[0]) : 1e-4);
    const spanStep = tb.totalSpanSec > 0 ? tb.totalSpanSec * 0.01 : 1e-4;
    const baseStep = Math.max(1e-12, Math.min(chDt > 0 ? chDt * 10 : spanStep, spanStep));
    return baseStep * (shiftKey ? 10 : 1);
  };

  document.getElementById('chTimeShiftDecBtn')?.addEventListener('click', (ev) => {
    const tab = app.getActiveTab();
    const ch = tab && tab.channels[tab.activeChannelId || ''];
    if (!tab || !ch) return;
    const step = getTimeShiftNudgeStep(tab, ch, (ev as MouseEvent).shiftKey);
    app.setChannelsTimeShift([ch.id], (ch.timeShiftSec || 0) - step, true);
  });

  document.getElementById('chTimeShiftIncBtn')?.addEventListener('click', (ev) => {
    const tab = app.getActiveTab();
    const ch = tab && tab.channels[tab.activeChannelId || ''];
    if (!tab || !ch) return;
    const step = getTimeShiftNudgeStep(tab, ch, (ev as MouseEvent).shiftKey);
    app.setChannelsTimeShift([ch.id], (ch.timeShiftSec || 0) + step, true);
  });

  const chTimeShiftInp = document.getElementById('chTimeShiftInput') as HTMLInputElement | null;
  chTimeShiftInp?.addEventListener('change', () => {
    const tab = app.getActiveTab();
    const ch = tab && tab.channels[tab.activeChannelId || ''];
    if (!tab || !ch) return;
    const val = parseFloat(chTimeShiftInp.value);
    if (!Number.isFinite(val)) {
      chTimeShiftInp.value = String(ch.timeShiftSec || 0);
      return;
    }
    app.setChannelsTimeShift([ch.id], val, true);
  });

  document.getElementById('chTimeShiftSnapBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab?.activeChannelId) {
      app.snapChannelStartToPrimary(tab.activeChannelId);
    }
  });

  document.getElementById('chTimeShiftZeroBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab?.activeChannelId) {
      app.resetChannelsTimeShift([tab.activeChannelId], true);
    }
  });

  // --- 2. Cursor Mode, Center Recall & Target Channel ---
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
  document.getElementById('csvApplyRulesAllBtn')?.addEventListener('click', () => {
    app.applyCsvRulesToAllQueued();
  });
  const closeCsvImportModal = () => {
    app.clearPendingCsvImport();
    const m = document.getElementById('csvQualityModal');
    if (m) m.style.display = 'none';
  };
  document.getElementById('csvCancelBtn')?.addEventListener('click', closeCsvImportModal);
  document.getElementById('csvCancelBottomBtn')?.addEventListener('click', closeCsvImportModal);

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

  let mathPreviewTimer: number | null = null;
  document.getElementById('mathExprInput')?.addEventListener('input', () => {
    if (mathPreviewTimer !== null) window.clearTimeout(mathPreviewTimer);
    mathPreviewTimer = window.setTimeout(() => {
      mathPreviewTimer = null;
      const tab = app.getActiveTab();
      if (tab) updateMathLivePreview(tab);
    }, 120);
  });

  document.getElementById('mathCancelBtn')?.addEventListener('click', () => {
    document.getElementById('mathModal')!.style.display = 'none';
  });
  document.getElementById('mathModalCloseBtn')?.addEventListener('click', () => {
    document.getElementById('mathModal')!.style.display = 'none';
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
    const polesRaw = (document.getElementById('motorPolesInput') as HTMLInputElement)?.value.trim() || '';
    const poles = Number(polesRaw);
    const outEl = document.getElementById('motorEstOutput');
    if (!ch) return;
    if (!polesRaw || !Number.isInteger(poles) || poles <= 0) {
      if (outEl) {
        outEl.innerText = 'Enter rotor pole pairs (integer p >= 1) first — no default assumed.';
        outEl.className = 'font-mono text-[11px] text-amber-300 tabular-nums';
      }
      return;
    }
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
    const polesRaw = poleInput.value.trim();
    const poles = Number(polesRaw);
    const validPoles = Boolean(polesRaw) && Number.isInteger(poles) && poles > 0;
    const validRpm = Number.isFinite(rpm) && rpm > 0;

    if (enableChk.checked && (!validRpm || !validPoles)) {
      app.showToast('谐波标尺需要有效的转速 RPM (> 0) 与整数极对数 (p ≥ 1)。', 'warn');
    }

    tab.motorConfig.enabled = enableChk.checked;
    tab.motorConfig.rpm = validRpm ? rpm : null;
    tab.motorConfig.polePairs = validPoles ? poles : null;

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
      const stripGate = document.getElementById('stripMeasGateSelect') as HTMLSelectElement | null;
      if (stripGate) stripGate.value = tab.measurementGate;
      app.renderMeasurementStrip(tab);
      renderMeasureModalCheckboxes(tab);
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
  document.getElementById('measureCustomUnitSelect')?.addEventListener('change', (e: any) => {
    const customInp = document.getElementById('measureCustomUnitCustomInput');
    if (customInp) {
      customInp.classList.toggle('hidden', e.target.value !== 'custom');
    }
  });
  document.getElementById('measureCustomAddBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    const chSel = document.getElementById('measureModalChannelSelect') as HTMLSelectElement | null;
    const labelInp = document.getElementById('measureCustomLabelInput') as HTMLInputElement | null;
    const exprInp = document.getElementById('measureCustomExprInput') as HTMLInputElement | null;
    const unitSel = document.getElementById('measureCustomUnitSelect') as HTMLSelectElement | null;
    const customUnitInp = document.getElementById('measureCustomUnitCustomInput') as HTMLInputElement | null;

    const label = labelInp?.value.trim() || '';
    const expression = exprInp?.value.trim() || '';
    const unitType = (unitSel?.value || 'signal') as CustomMeasurementUnitType;
    const customUnit = unitType === 'custom' ? customUnitInp?.value.trim() || '' : undefined;

    try {
      const chId = chSel?.value || tab.activeChannelId || tab.drawOrder[0];
      app.addCustomMeasurement(
        {
          label,
          shortLabel: label.slice(0, 12),
          expression,
          unitType,
          customUnit,
        },
        chId
      );
      if (labelInp) labelInp.value = '';
      if (exprInp) exprInp.value = '';
      renderMeasureModalCheckboxes(tab);
      app.showToast(`已添加自定义测量项「${label}」。`, 'info');
    } catch (err: any) {
      app.showToast(err?.message || '添加自定义测量项失败。', 'error');
    }
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
    app.showToast('已捕获当前波形作为 Golden 容差基准包络。', 'info');
  });

  // Real-Time Proportional Δt Shift Controls inside Edit/Ref Modal
  const getCheckedShiftIds = (tab: TabState): string[] => {
    const ids: string[] = [];
    document.querySelectorAll('#editShiftChannelsList .edit-shift-ch-chk:checked').forEach((el) => {
      const id = (el as HTMLInputElement).value;
      if (id && tab.channels[id]) ids.push(id);
    });
    if (ids.length === 0) {
      const fallback = (document.getElementById('editModalChannelSelect') as HTMLSelectElement)?.value || tab.activeChannelId || tab.drawOrder[0];
      if (fallback && tab.channels[fallback]) ids.push(fallback);
    }
    return ids;
  };
  let shiftUndoPushedForDrag = false;
  const shiftSlider = document.getElementById('editTimeShiftSlider') as HTMLInputElement | null;
  shiftSlider?.addEventListener('pointerdown', () => { shiftUndoPushedForDrag = false; });
  shiftSlider?.addEventListener('keydown', () => { shiftUndoPushedForDrag = false; });
  shiftSlider?.addEventListener('input', () => {
    const tab = app.getActiveTab();
    if (!tab || !shiftSlider) return;
    const ids = getCheckedShiftIds(tab);
    if (ids.length === 0) return;
    const pct = parseFloat(shiftSlider.value) || 0;
    const primaryCh = tab.channels[tab.activeChannelId || tab.drawOrder[0]];
    const tView = primaryCh ? getTimeBoundsForView(tab, primaryCh).tSpan : 0;
    const shiftSec = (pct / 100) * tView;
    app.setChannelsTimeShift(ids, shiftSec, !shiftUndoPushedForDrag);
    shiftUndoPushedForDrag = true;
    syncEditTimeShiftUI(tab, false);
  });
  shiftSlider?.addEventListener('change', () => { shiftUndoPushedForDrag = false; });
  const nudgeEditTimeShift = (deltaPct: number) => {
    const tab = app.getActiveTab();
    if (!tab || !shiftSlider) return;
    const ids = getCheckedShiftIds(tab);
    if (ids.length === 0) return;
    const curPct = parseFloat(shiftSlider.value) || 0;
    const nextPct = Math.max(-100, Math.min(100, Math.round((curPct + deltaPct) * 10) / 10));
    shiftSlider.value = nextPct.toFixed(1);
    const primaryCh = tab.channels[tab.activeChannelId || tab.drawOrder[0]];
    const tView = primaryCh ? getTimeBoundsForView(tab, primaryCh).tSpan : 0;
    const shiftSec = (nextPct / 100) * tView;
    app.setChannelsTimeShift(ids, shiftSec, true);
    syncEditTimeShiftUI(tab, false);
  };
  document.getElementById('editTimeShiftDecBtn')?.addEventListener('click', (ev) => {
    nudgeEditTimeShift((ev as MouseEvent).shiftKey ? -1.0 : -0.1);
  });
  document.getElementById('editTimeShiftIncBtn')?.addEventListener('click', (ev) => {
    nudgeEditTimeShift((ev as MouseEvent).shiftKey ? 1.0 : 0.1);
  });
  document.getElementById('editTimeShiftResetBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    const ids = getCheckedShiftIds(tab);
    if (ids.length === 0) return;
    app.resetChannelsTimeShift(ids, true);
    if (shiftSlider) shiftSlider.value = '0';
    syncEditTimeShiftUI(tab, true);
  });
  document.getElementById('editShiftSelCompareBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    const cmpIds = tab.drawOrder.filter((id) => {
      const c = tab.channels[id];
      return c && (c.compareRole === 'ref' || id.startsWith('cmp_'));
    });
    const targets = new Set(cmpIds.length > 0 ? cmpIds : [tab.activeChannelId || tab.drawOrder[0]]);
    document.querySelectorAll('#editShiftChannelsList .edit-shift-ch-chk').forEach((el) => {
      const inp = el as HTMLInputElement;
      inp.checked = targets.has(inp.value);
    });
    syncEditTimeShiftUI(tab, true);
  });
  document.getElementById('editShiftSelActiveBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    const activeId = (document.getElementById('editModalChannelSelect') as HTMLSelectElement)?.value || tab.activeChannelId || tab.drawOrder[0];
    document.querySelectorAll('#editShiftChannelsList .edit-shift-ch-chk').forEach((el) => {
      const inp = el as HTMLInputElement;
      inp.checked = inp.value === activeId;
    });
    syncEditTimeShiftUI(tab, true);
  });
  document.getElementById('editShiftSelAllBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    document.querySelectorAll('#editShiftChannelsList .edit-shift-ch-chk').forEach((el) => {
      (el as HTMLInputElement).checked = true;
    });
    syncEditTimeShiftUI(tab, true);
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

    const excelFiles = files.filter((f) => isExcelFileName(f.name));
    const standardFiles = files.filter((f) => !isExcelFileName(f.name));

    let addedCount = 0;
    let skippedDupCount = 0;
    let reusedTabCount = 0;
    let firstExtKey = '';

    for (const file of standardFiles) {
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
        app.showToast(`加载 ${file.name} 失败：${err?.message || err}`, 'error');
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
    } else if (skippedDupCount > 0 && excelFiles.length === 0) {
      app.showToast(`检测到 ${skippedDupCount} 个完全相同的文件（文件名+内容一致），已自动跳过重复加载。`, 'warn');
    } else if (addedCount === 0 && excelFiles.length === 0) {
      app.showToast('所选文件中未检测到有效波形通道。', 'warn');
    }

    if (excelFiles.length > 0) {
      void excelImportModal.open({
        mode: 'compare',
        files: excelFiles,
        colors: app.getRawColors(),
        onConfirm: (res) => {
          const activeTab = app.getActiveTab();
          const tgt = activeTab ? getCompareTargetChannel(activeTab) : targetCh;
          let xlsAdded = 0;
          let xlsFirstKey = '';

          for (const item of res.items) {
            const shortFile = item.fileName.replace(/\.[^.]+$/, '');
            item.drawOrder.forEach((cid, idx) => {
              const ch = item.channels[cid];
              if (!ch) return;
              const entryFp = `${item.fingerprint}::${item.sheetName}::${ch.id}`;
              if (compareQueue.some((q) => q.fingerprint === entryFp)) return;
              const refId = `ext_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${idx}`;
              const refKey = `ext:${refId}`;
              const label =
                item.drawOrder.length > 1
                  ? `${shortFile}[${item.sheetName}]:${ch.name}`
                  : `${shortFile}[${item.sheetName}]`;

              externalCompareRefs.unshift({
                id: refId,
                label: `[Excel: ${item.fileName} / ${item.sheetName}] ${ch.name} (${ch.unit || 'V'})`,
                channel: ch,
                fingerprint: entryFp,
              });
              const entry: CompareQueueEntry = {
                id: refId,
                sourceKey: refKey,
                label,
                channel: ch,
                timeShiftSec: 0,
                timeScale: 1,
                fingerprint: entryFp,
              };
              applyAutoAlignToEntry(tgt, entry, false);
              compareQueue.push(entry);
              if (!xlsFirstKey) xlsFirstKey = refKey;
              xlsAdded++;
            });
          }

          if (activeTab && xlsAdded > 0) {
            populateCompareDropdowns(activeTab, xlsFirstKey || undefined);
            recomputeComparePanel(activeTab);
            app.showToast(`已从 Excel 加入 ${xlsAdded} 条波形到对比组。`, 'info');
          }
        },
        onNotify: (msg, level) => app.showToast(msg, level),
      });
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
  document.getElementById('cmpTargetSelect')?.addEventListener('change', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    const autoChk = (document.getElementById('cmpAutoFitOnAddChk') as HTMLInputElement)?.checked ?? true;
    const newTarget = getCompareTargetChannel(tab);
    if (autoChk && newTarget) {
      compareQueue.forEach((entry) => {
        const rec = detectRecommendedTimeScale(newTarget, entry.channel);
        const curScale = entry.timeScale || 1;
        const rT0 = entry.channel.t[0] ?? 0;
        const rT1 = rT0 + ((entry.channel.t[entry.channel.t.length - 1] ?? rT0) - rT0) * curScale + (entry.timeShiftSec || 0);
        const rS0 = rT0 + (entry.timeShiftSec || 0);
        const tS0 = newTarget.t[0] ?? 0;
        const tS1 = newTarget.t[newTarget.t.length - 1] ?? tS0;
        const hasOverlap = Math.min(rT1, tS1) > Math.max(rS0, tS0);
        if (!hasOverlap || rec.isLargeMismatch) {
          applyAutoAlignToEntry(newTarget, entry, false);
        }
      });
    }
    recomputeComparePanel(tab);
  });
  document.getElementById('cmpPaletteModeSelect')?.addEventListener('change', refreshCompare);
  document.getElementById('cmpTagTargetChk')?.addEventListener('change', refreshCompare);
  document.getElementById('cmpGroupNameInput')?.addEventListener('input', refreshCompare);
  document.getElementById('cmpRemoveDcChk')?.addEventListener('change', refreshCompare);
  document.getElementById('cmpTolModeSelect')?.addEventListener('change', refreshCompare);
  document.getElementById('cmpTolValueInput')?.addEventListener('input', refreshCompare);
  document.getElementById('cmpMinCoverageSelect')?.addEventListener('change', refreshCompare);

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
    app.showToast('请先向对比组添加至少一个文件或参考通道。', 'warn');
    return false;
  };

  const runCompareAutoAlignAll = (mode: AutoAlignMode) => {
    const tab = app.getActiveTab();
    if (!tab || !ensureQueueHasItem(tab)) return;
    const targetCh = getCompareTargetChannel(tab);
    if (!targetCh) return;
    const thresholdPct = parseFloat((document.getElementById('cmpEdgeThreshSelect') as HTMLSelectElement)?.value || '50') || 50;
    const viewOnly = !!(document.getElementById('cmpAlignViewOnlyChk') as HTMLInputElement)?.checked;
    const targetWindow = viewOnly ? getTimeBoundsForView(tab, targetCh) : undefined;
    const diagLines: string[] = [];
    let hasWarning = false;
    compareQueue.forEach((entry) => {
      const detail = computeAutoTimeAlignDetailed(targetCh, entry.channel, mode, entry.timeScale || 1, {
        thresholdPct,
        targetTimeWindow: targetWindow ? { tStart: targetWindow.tStart, tEnd: targetWindow.tEnd } : undefined,
      });
      entry.timeShiftSec = detail.shiftSec;
      const shiftStr = formatEng(detail.shiftSec, 's', 3);
      if (detail.warning) {
        hasWarning = true;
        diagLines.push(`▲ ${entry.label}: Δt=${shiftStr} · ${detail.warning}`);
      } else if (typeof detail.confidenceR === 'number') {
        diagLines.push(`${entry.label}: Δt=${shiftStr} · 相关系数 r=${detail.confidenceR.toFixed(4)}`);
      } else {
        diagLines.push(`${entry.label}: Δt=${shiftStr}`);
      }
    });
    const diagEl = document.getElementById('cmpAlignDiagBanner');
    if (diagEl) {
      if (diagLines.length > 0) {
        diagEl.textContent = diagLines.slice(0, 3).join('  |  ') + (diagLines.length > 3 ? ` (+${diagLines.length - 3}条)` : '');
        diagEl.className = hasWarning
          ? 'w-full px-2 py-1 rounded-xs bg-amber-950/50 border border-amber-500/60 font-mono text-[11px] text-amber-200'
          : 'w-full px-2 py-1 rounded-xs bg-[#111821] border border-[#26313d] font-mono text-[11px] text-cyan-200';
      } else {
        diagEl.classList.add('hidden');
      }
    }
    recomputeComparePanel(tab);
  };
  document.getElementById('cmpAlignStartBtn')?.addEventListener('click', () => runCompareAutoAlignAll('start'));
  document.getElementById('cmpAlignEdgeBtn')?.addEventListener('click', () => runCompareAutoAlignAll('rising-edge'));
  document.getElementById('cmpAlignFallEdgeBtn')?.addEventListener('click', () => runCompareAutoAlignAll('falling-edge'));
  document.getElementById('cmpAlignPeakBtn')?.addEventListener('click', () => runCompareAutoAlignAll('first-peak'));
  document.getElementById('cmpAlignXCorrBtn')?.addEventListener('click', () => runCompareAutoAlignAll('xcorr'));
  document.getElementById('cmpMatchSpanBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab || !ensureQueueHasItem(tab)) return;
    const targetCh = getCompareTargetChannel(tab);
    if (!targetCh) return;
    compareQueue.forEach((entry) => applyAutoAlignToEntry(targetCh, entry, true));
    recomputeComparePanel(tab);
    app.showToast('已为队列中所有参考波形匹配时间量纲（ms↔s）并对齐初始起点 t₀。', 'info');
  });
  document.getElementById('cmpAlignResetBtn')?.addEventListener('click', () => {
    compareQueue.forEach((entry) => {
      entry.timeShiftSec = 0;
      entry.timeScale = 1;
      entry.autoScaledFrom = undefined;
    });
    const diagEl = document.getElementById('cmpAlignDiagBanner');
    if (diagEl) diagEl.classList.add('hidden');
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
    app.showToast('已清除 Golden 容差带。', 'info');
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
    const minCoveragePct = Math.max(0, Math.min(100, parseFloat((document.getElementById('cmpMinCoverageSelect') as HTMLSelectElement)?.value || '80') || 80));

    const theme = COMPARE_GROUP_THEMES.find((t) => t.id === selectedCompareThemeId) || COMPARE_GROUP_THEMES[0];
    const groupId = editingCompareGroupId || `grp_${groupNameRaw.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now().toString(36)}`;
    const colorOffset = tagTarget ? 1 : 0;

    const validEntries = compareQueue.filter((e) =>
      canApplyCompareOverlay(
        e.computed?.status,
        e.computed?.fullRefT,
        opts.overlayRefs,
        Boolean(e.computed?.valid)
      )
    );
    const skippedCount = compareQueue.length - validEntries.length;
    if (validEntries.length === 0) {
      const firstReason = compareQueue.find((e) => e.computed?.reason)?.computed?.reason;
      app.showToast(
        opts.overlayRefs
          ? firstReason || '无法叠加到 Scope：参考波形单位不兼容或缺少有效时间样本。'
          : firstReason || '无法生成差值通道：请先调整 Δt 使参考波形与目标产生重叠，或点击「应用到 Scope」直接叠加查看。',
        'error'
      );
      return;
    }

    const payloadItems = validEntries.map((entry, idx) => ({
      id: entry.id,
      refLabel: entry.label,
      color: entry.customColor || getCompareGroupTraceColor(theme.id, idx + colorOffset, paletteMode),
      alignedRefV: entry.computed!.alignedRefV,
      diffV: entry.computed!.diffV,
      fullRefT: entry.computed!.fullRefT,
      fullRefV: entry.computed!.fullRefV,
    }));

    const hasPartialDisjoint = opts.overlayRefs && validEntries.some((e) => !e.computed?.valid);
    if (skippedCount > 0) {
      app.showToast(`已跳过 ${skippedCount} 条单位不兼容或无重叠的参考波形。`, 'warn');
    }

    const canDrawGolden = Boolean(opts.overlayRefs && enableGolden && validEntries[0]?.computed?.valid);

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
        enableGoldenBand: canDrawGolden,
        goldenMode: tolMode,
        goldenTolerance: isFinite(tolVal) && tolVal > 0 ? tolVal : 5,
        minCoveragePct,
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
        ? `已在对比组 [${groupNameRaw}] 中生成 ${payloadItems.length} 条差值通道。`
        : hasPartialDisjoint
        ? `已将 ${payloadItems.length} 条波形叠加到 Scope（部分时间轴暂未重叠，时间轴已按最长展开，可微调 Δt）。`
        : `已在对比组 [${groupNameRaw}] 中叠加 ${payloadItems.length} 条波形到 Scope。`,
      hasPartialDisjoint ? 'warn' : 'info'
    );
    closeCompareModal();
  };

  document.getElementById('cmpExportCsvBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab || compareQueue.length === 0) {
      app.showToast('对比队列为空，请先添加参考波形。', 'warn');
      return;
    }
    recomputeComparePanel(tab);
    const targetCh = getCompareTargetChannel(tab);
    const targetLabel = targetCh ? `${targetCh.name} (${targetCh.unit || 'V'})` : 'Target';
    const validRows = compareQueue
      .filter((entry) => Boolean(entry.computed?.metrics))
      .map((entry) => ({
        refLabel: entry.label,
        sourceName: entry.channel.name,
        unit: entry.channel.unit || 'V',
        timeScale: entry.timeScale || 1,
        timeShiftSec: entry.timeShiftSec || 0,
        metrics: entry.computed!.metrics,
        toleranceStatus: !entry.computed!.valid
          ? `INVALID (${entry.computed!.reason || 'validation failed'})`
          : entry.computed!.pass
          ? 'PASS'
          : `FAIL (${entry.computed!.violationCount} violations)`,
      }));
    const csv = exportCompareSummaryCsv(targetLabel, validRows);
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wave-compare-summary-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 600);
    app.showToast(`已导出 ${compareQueue.length} 条对比指标 CSV 报表。`, 'info');
  });
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
    batchQueuedFiles = Array.from(list).filter((f) => /\.(csv|txt|wfm|raw|xlsx|xls|xlsm|xlsb)$/i.test(f.name));
    const lbl = document.getElementById('batchFileCountLabel');
    if (lbl) lbl.innerText = `${batchQueuedFiles.length} supported file(s) queued.`;
  };
  batchFilesInp?.addEventListener('change', () => onBatchFilesSelected(batchFilesInp.files));
  batchFolderInp?.addEventListener('change', () => onBatchFilesSelected(batchFolderInp.files));
  document.getElementById('batchRunBtn')?.addEventListener('click', async () => {
    if (batchQueuedFiles.length === 0) {
      app.showToast('请先选择 CSV / Excel / WFM 文件或文件夹。', 'warn');
      return;
    }
    const chIdx = Math.max(0, (parseInt((document.getElementById('batchChIndexInput') as HTMLInputElement)?.value || '1', 10) || 1) - 1);
    const ruleMetric = ((document.getElementById('batchRuleMetricSelect') as HTMLSelectElement)?.value || '') as MeasurementMetricKey | '';
    const minV = parseFloat((document.getElementById('batchMinLimitInput') as HTMLInputElement)?.value || '');
    const maxV = parseFloat((document.getElementById('batchMaxLimitInput') as HTMLInputElement)?.value || '');
    const thresholds = ruleMetric
      ? {
          metric: ruleMetric,
          minLimit: isFinite(minV) ? minV : null,
          maxLimit: isFinite(maxV) ? maxV : null,
        }
      : undefined;

    const lbl = document.getElementById('batchFileCountLabel');
    const excelFiles = batchQueuedFiles.filter((f) => isExcelFileName(f.name));
    const standardFiles = batchQueuedFiles.filter((f) => !isExcelFileName(f.name));

    if (excelFiles.length > 0) {
      await excelImportModal.open({
        mode: 'batch',
        files: excelFiles,
        colors: ['#facc15', '#22d3ee', '#f472b6', '#4ade80'],
        onConfirm: async (res) => {
          if (lbl) lbl.innerText = `正在分析 ${standardFiles.length + res.items.length} 个文件/工作表...`;
          lastBatchRows = await runBatchAnalysisOnFiles(
            standardFiles,
            chIdx,
            BATCH_EXPORT_METRICS,
            'entire',
            thresholds,
            res.items
          );
          if (lbl) lbl.innerText = `已完成：共 ${lastBatchRows.length} 项。`;
          renderBatchTable(lastBatchRows);
        },
        onNotify: (msg, level) => app.showToast(msg, level),
      });
      return;
    }

    if (lbl) lbl.innerText = `正在分析 ${batchQueuedFiles.length} 个文件...`;
    lastBatchRows = await runBatchAnalysisOnFiles(
      batchQueuedFiles,
      chIdx,
      BATCH_EXPORT_METRICS,
      'entire',
      thresholds
    );
    if (lbl) lbl.innerText = `已完成：共 ${lastBatchRows.length} 个文件。`;
    renderBatchTable(lastBatchRows);
  });
  document.getElementById('batchExportCsvBtn')?.addEventListener('click', () => {
    if (lastBatchRows.length === 0) {
      app.showToast('请先执行批量测量后再导出汇总表。', 'warn');
      return;
    }
    const fname = exportBatchResultsCSV(lastBatchRows, BATCH_EXPORT_METRICS);
    app.showToast(`已导出 ${fname}`, 'info');
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
    app.showToast(`已保存分析模板「${preset.name}」。`, 'info');
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

  document.getElementById('bldcHallSeqPresetSelect')?.addEventListener('change', (e) => {
    const val = (e.target as HTMLSelectElement).value;
    const preset = HALL_SEQUENCE_PRESETS.find((p) => p.id === val);
    const customInp = document.getElementById('bldcHallCustomSeqInput') as HTMLInputElement | null;
    if (preset && customInp) {
      customInp.value = preset.ring.join(',');
    }
  });
  document.getElementById('bldcHallCustomSeqInput')?.addEventListener('input', () => {
    const sel = document.getElementById('bldcHallSeqPresetSelect') as HTMLSelectElement | null;
    if (sel) sel.value = 'custom';
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
    if (!derived.valid || derived.time.length < 2) {
      app.showToast(derived.warnings[0] || '三相波形缺少有效同步时间基准或单位不兼容。', 'error');
      return;
    }
    const unit = derived.unit || ph.chU.unit || 'V';
    app.createDerivedMathTraces([
      {
        name: `Uuv (${ph.chU.name}-${ph.chV.name})`,
        unit,
        baseChannelId: ph.chU.id,
        time: derived.time,
        values: derived.uuv,
        expr: `${ph.chU.name} - ${ph.chV.name}`,
        color: app.getNextComputedColor(0),
        sourceIds: [ph.chU.id, ph.chV.id],
      },
      {
        name: `Uvw (${ph.chV.name}-${ph.chW.name})`,
        unit,
        baseChannelId: ph.chV.id,
        time: derived.time,
        values: derived.uvw,
        expr: `${ph.chV.name} - ${ph.chW.name}`,
        color: app.getNextComputedColor(1),
        sourceIds: [ph.chV.id, ph.chW.id],
      },
      {
        name: `Uwu (${ph.chW.name}-${ph.chU.name})`,
        unit,
        baseChannelId: ph.chW.id,
        time: derived.time,
        values: derived.uwu,
        expr: `${ph.chW.name} - ${ph.chU.name}`,
        color: app.getNextComputedColor(2),
        sourceIds: [ph.chW.id, ph.chU.id],
      },
    ]);
    app.showToast(
      derived.warnings.length > 0 ? `已添加线间波形（${derived.warnings[0]}）` : '已添加线间波形：Uuv、Uvw、Uwu',
      derived.warnings.length > 0 ? 'warn' : 'info'
    );
  });

  document.getElementById('bldcGenZeroSeqBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    const ph = getSelected3PhaseForBldc(tab);
    if (!ph) return;
    const derived = computeBldcDerivedTraces(ph.chU, ph.chV, ph.chW);
    if (!derived.valid || derived.time.length < 2) {
      app.showToast(derived.warnings[0] || '三相波形缺少有效同步时间基准或单位不兼容。', 'error');
      return;
    }
    const unit = derived.unit || ph.chU.unit || 'V';
    app.createDerivedMathTraces([
      {
        name: 'Zero-Seq V0 ((U+V+W)/3)',
        unit,
        baseChannelId: ph.chU.id,
        time: derived.time,
        values: derived.v0,
        expr: `(${ph.chU.name}+${ph.chV.name}+${ph.chW.name})/3`,
        color: app.getNextComputedColor(0),
        sourceIds: [ph.chU.id, ph.chV.id, ph.chW.id],
      },
    ]);
    app.showToast(
      derived.warnings.length > 0 ? `已添加零序分量 V0（${derived.warnings[0]}）` : '已添加零序分量 V0 波形',
      derived.warnings.length > 0 ? 'warn' : 'info'
    );
  });

  document.getElementById('bldcGenSvmMagBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    const ph = getSelected3PhaseForBldc(tab);
    if (!ph) return;
    const derived = computeBldcDerivedTraces(ph.chU, ph.chV, ph.chW);
    if (!derived.valid || derived.time.length < 2) {
      app.showToast(derived.warnings[0] || '三相波形缺少有效同步时间基准或单位不兼容。', 'error');
      return;
    }
    const unit = derived.unit || ph.chU.unit || 'V';
    app.createDerivedMathTraces([
      {
        name: 'Space Vector |Vs|',
        unit,
        baseChannelId: ph.chU.id,
        time: derived.time,
        values: derived.svmMag,
        expr: 'sqrt(Clarke_alpha^2 + Clarke_beta^2)',
        color: app.getNextComputedColor(0),
        sourceIds: [ph.chU.id, ph.chV.id, ph.chW.id],
      },
    ]);
    app.showToast(
      derived.warnings.length > 0 ? `已添加空间矢量幅值 |Vs|（${derived.warnings[0]}）` : '已添加空间矢量幅值 |Vs| 波形',
      derived.warnings.length > 0 ? 'warn' : 'info'
    );
  });

  document.getElementById('bldcSsRunBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    const idcId = (document.getElementById('bldcSsIdcSelect') as HTMLSelectElement)?.value;
    const daId = (document.getElementById('bldcSsDaSelect') as HTMLSelectElement)?.value;
    const dbId = (document.getElementById('bldcSsDbSelect') as HTMLSelectElement)?.value;
    const dcId = (document.getElementById('bldcSsDcSelect') as HTMLSelectElement)?.value;
    const chIdc = tab.channels[idcId];
    const chDa = tab.channels[daId];
    const chDb = tab.channels[dbId];
    const chDc = tab.channels[dcId];
    const resEl = document.getElementById('bldcSsResultCard');
    if (!chIdc || !chDa || !chDb || !chDc) {
      if (resEl) resEl.innerHTML = '<span class="text-amber-300">请选择 Idc 与三路 Duty/PWM 通道。</span>';
      return;
    }
    const fswKhz = parseFloat((document.getElementById('bldcSsFswKhzInput') as HTMLInputElement)?.value || '20');
    const tMinUs = parseFloat((document.getElementById('bldcSsTminUsInput') as HTMLInputElement)?.value || '1.5');
    const { tStart, tEnd } = getBldcGateBounds(tab, chIdc);
    const res = reconstructSingleShuntPhaseCurrents(chIdc, chDa, chDb, chDc, {
      fswHz: Number.isFinite(fswKhz) && fswKhz > 0 ? fswKhz * 1e3 : 20000,
      tMinSec: Number.isFinite(tMinUs) && tMinUs >= 0 ? tMinUs * 1e-6 : 1.5e-6,
      tStart,
      tEnd,
    });
    if (!res.valid) {
      if (resEl) resEl.innerHTML = `<span class="text-red-300">✖ ${escapeHtml(res.warnings[0] || '重构失败')}</span>`;
      app.showToast(res.warnings[0] || '单电阻相电流重构失败 (Fail-Closed)', 'error');
      return;
    }
    app.createDerivedMathTraces([
      {
        name: 'Ia (1-Shunt Recon)',
        unit: 'A',
        baseChannelId: chIdc.id,
        time: res.time,
        values: res.ia,
        expr: `SingleShunt(${chIdc.name},${chDa.name})`,
        color: app.getNextComputedColor(0),
        sourceIds: [chIdc.id, chDa.id, chDb.id, chDc.id],
      },
      {
        name: 'Ib (1-Shunt Recon)',
        unit: 'A',
        baseChannelId: chIdc.id,
        time: res.time,
        values: res.ib,
        expr: `SingleShunt(${chIdc.name},${chDb.name})`,
        color: app.getNextComputedColor(1),
        sourceIds: [chIdc.id, chDa.id, chDb.id, chDc.id],
      },
      {
        name: 'Ic (1-Shunt Recon)',
        unit: 'A',
        baseChannelId: chIdc.id,
        time: res.time,
        values: res.ic,
        expr: `SingleShunt(${chIdc.name},${chDc.name})`,
        color: app.getNextComputedColor(2),
        sourceIds: [chIdc.id, chDa.id, chDb.id, chDc.id],
      },
    ]);
    const modeLabel = res.mode === 'switching_states' ? '开关态门限解码' : 'SVPWM 占空比投影';
    const blindNote = `盲区占比 ${res.blindZoneFractionPct.toFixed(1)}% (${res.blindCount}/${res.time.length})`;
    if (resEl) {
      resEl.innerHTML = `<span class="${res.blindZoneFractionPct > 5 ? 'text-amber-300' : 'text-emerald-300'}">✓ 已注入 Ia/Ib/Ic (${modeLabel} · ${blindNote})</span>`;
      resEl.title = res.warnings.join('\n');
    }
    app.showToast(`已重构并注入 Ia/Ib/Ic (${modeLabel}, ${blindNote})`, res.blindZoneFractionPct > 5 ? 'warn' : 'info');
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
        updateMathLivePreview(tab);
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
      updateMathLivePreview(tab);
    });
  });

  const presetContainer = document.getElementById('quickMathPresets');
  if (presetContainer) {
    presetContainer.innerHTML = `
      <div class="space-y-1.5 text-[11px]">
        <div class="flex flex-wrap items-center gap-1">
          <span class="text-[10px] text-amber-300 font-semibold w-14 shrink-0">功率/能量</span>
          <button type="button" class="preset-btn px-2 py-0.5 bg-[#161b22] hover:bg-[#1e2530] border border-[#222933] rounded-sm text-slate-300 font-mono transition cursor-pointer" data-formula="CH1 * CH2" data-name="P_inst">瞬时功率 CH1*CH2</button>
          <button type="button" class="preset-btn px-2 py-0.5 bg-[#161b22] hover:bg-[#1e2530] border border-[#222933] rounded-sm text-slate-300 font-mono transition cursor-pointer" data-formula="integ(CH1 * CH2)" data-name="E_switch">开关能量 integ(CH1*CH2)</button>
          <button type="button" class="preset-btn px-2 py-0.5 bg-[#161b22] hover:bg-[#1e2530] border border-[#222933] rounded-sm text-slate-300 font-mono transition cursor-pointer" data-formula="CH1 - mean(CH1)" data-name="AC_Ripple">母线纹波 CH1-mean</button>
        </div>
        <div class="flex flex-wrap items-center gap-1">
          <span class="text-[10px] text-cyan-300 font-semibold w-14 shrink-0">包络/斜率</span>
          <button type="button" class="preset-btn px-2 py-0.5 bg-[#161b22] hover:bg-[#1e2530] border border-[#222933] rounded-sm text-slate-300 font-mono transition cursor-pointer" data-formula="movrms(CH1, 0.01)" data-name="I_movrms">滑动RMS (10ms)</button>
          <button type="button" class="preset-btn px-2 py-0.5 bg-[#161b22] hover:bg-[#1e2530] border border-[#222933] rounded-sm text-slate-300 font-mono transition cursor-pointer" data-formula="movavg(CH1, 0.005)" data-name="V_movavg">滑动均值 (5ms)</button>
          <button type="button" class="preset-btn px-2 py-0.5 bg-[#161b22] hover:bg-[#1e2530] border border-[#222933] rounded-sm text-slate-300 font-mono transition cursor-pointer" data-formula="deriv(CH1)" data-name="dV_dt">斜率 deriv(CH1)</button>
        </div>
        <div class="flex flex-wrap items-center gap-1">
          <span class="text-[10px] text-emerald-300 font-semibold w-14 shrink-0">三相/向量</span>
          <button type="button" class="preset-btn px-2 py-0.5 bg-[#161b22] hover:bg-[#1e2530] border border-[#222933] rounded-sm text-slate-300 font-mono transition cursor-pointer" data-formula="CH1 - CH2" data-name="V_line">差分 CH1-CH2</button>
          <button type="button" class="preset-btn px-2 py-0.5 bg-[#161b22] hover:bg-[#1e2530] border border-[#222933] rounded-sm text-slate-300 font-mono transition cursor-pointer" data-formula="CH1 + CH2 + CH3" data-name="I_zero">零序 CH1+CH2+CH3</button>
          <button type="button" class="preset-btn px-2 py-0.5 bg-[#161b22] hover:bg-[#1e2530] border border-[#222933] rounded-sm text-slate-300 font-mono transition cursor-pointer" data-formula="hypot(CH1, CH2)" data-name="Vec_Mag">幅值 hypot(CH1,CH2)</button>
          <button type="button" class="preset-btn px-2 py-0.5 bg-[#161b22] hover:bg-[#1e2530] border border-[#222933] rounded-sm text-slate-300 font-mono transition cursor-pointer" data-formula="atan2(CH2, CH1)" data-name="Vec_Angle">相角 atan2(CH2,CH1)</button>
        </div>
      </div>
    `;

    presetContainer.querySelectorAll('.preset-btn').forEach((btn) => {
      btn.addEventListener('click', (e: any) => {
        const el = e.currentTarget as HTMLElement;
        if (exprInput && el.dataset.formula) exprInput.value = el.dataset.formula;
        if (nameInput && el.dataset.name && /^Math \d+$/.test(nameInput.value.trim())) {
          nameInput.value = el.dataset.name;
        }
        updateMathLivePreview(tab);
      });
    });
  }

  updateMathLivePreview(tab);
  modal.style.display = 'flex';
}

function updateMathLivePreview(tab: TabState) {
  const previewEl = document.getElementById('mathLivePreview');
  const exprInput = document.getElementById('mathExprInput') as HTMLInputElement | null;
  if (!previewEl || !exprInput) return;
  const expr = exprInput.value.trim();
  if (!expr) {
    previewEl.className = 'mt-1 px-2 py-1 rounded-xs bg-[#0c0f13] border border-[#222933] font-mono text-[11px] text-slate-500';
    previewEl.textContent = '输入公式实时校验语法、参数个数与推演量纲…';
    return;
  }
  const res = previewMathExpression(expr, tab.channels, tab.drawOrder);
  if (res.valid) {
    const chNames = res.referencedChannels
      .slice(0, 4)
      .join(', ');
    previewEl.className = 'mt-1 px-2 py-1 rounded-xs bg-emerald-950/35 border border-emerald-600/50 font-mono text-[11px] text-emerald-200';
    previewEl.textContent = `✓ 语法有效 · 推演单位: ${res.inferredUnit || '(无量纲)'}${chNames ? ` · 引用通道: ${chNames}` : ''}`;
  } else {
    previewEl.className = 'mt-1 px-2 py-1 rounded-xs bg-red-950/50 border border-red-600/60 font-mono text-[11px] text-red-200';
    previewEl.textContent = `✖ ${res.error || '表达式语法错误'}`;
  }
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
  polesInput.value = tab.motorConfig.polePairs ? tab.motorConfig.polePairs.toString() : '';
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
          <span>${escapeHtml(r.name)}</span>
          <span>${r.passed ? 'PASS' : 'FAIL'}</span>
        </div>
        <div class="text-[11px] text-slate-400 mt-1">${escapeHtml(r.message)}</div>
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

  const ch = tab.channels[chId];
  const isLight = Boolean(THEME_PRESETS[app.getThemeId()]?.isLight);
  const chTextColor = ch ? resolveChannelTextColor(ch.color, isLight) : (isLight ? '#0369a1' : '#38bdf8');
  if (chSel && ch) {
    chSel.style.borderLeftWidth = '3px';
    chSel.style.borderLeftColor = ch.color;
    chSel.style.color = chTextColor;
  }
  const liveMeas = ch ? app.getChannelMeasurementsSnapshot(tab, ch) : null;

  const selectedSet = new Set((tab.selectedMeasurements || []).map((m) => m.id));
  const buildGroup = (container: HTMLElement, group: 'voltage' | 'timing') => {
    container.innerHTML = '';
    MEASUREMENT_DEFINITIONS.filter((d) => d.group === group).forEach((def) => {
      const id = `${chId}::${def.key}`;
      const previewVal =
        ch && liveMeas && liveMeas.valid !== false
          ? formatMeasurementMetricValue(liveMeas, def, ch.unit)
          : '--';
      const label = document.createElement('label');
      label.className = 'flex items-center justify-between gap-2 px-2 py-1 bg-[#12161c] hover:bg-[#1a222d] border border-[#222933] rounded-sm cursor-pointer';
      label.innerHTML = `
        <span class="flex items-center gap-2 text-slate-200 min-w-0">
          <input type="checkbox" class="accent-cyan-400 cursor-pointer shrink-0" ${selectedSet.has(id) ? 'checked' : ''} />
          <span class="truncate">${escapeHtml(def.label)}</span>
        </span>
        <span class="font-mono text-[11px] font-semibold tabular-nums shrink-0" style="color:${chTextColor}">${escapeHtml(previewVal)}</span>
      `;
      label.querySelector('input')?.addEventListener('change', (e: any) => {
        app.toggleMeasurementSelection(chId, def.key, !!e.target.checked);
      });
      container.appendChild(label);
    });
  };

  buildGroup(voltageBox, 'voltage');
  buildGroup(timingBox, 'timing');

  const presetsWrap = document.getElementById('measureCustomPresets');
  if (presetsWrap) {
    presetsWrap.innerHTML = '';
    CUSTOM_MEASUREMENT_PRESETS.forEach((preset) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        'px-2 py-0.5 bg-[#12161c] hover:bg-[#1a222d] border border-[#222933] hover:border-emerald-500/60 rounded-xs text-[10px] font-mono text-emerald-200 cursor-pointer';
      btn.innerText = `+ ${preset.shortLabel}: ${preset.expression}`;
      btn.title = preset.label;
      btn.addEventListener('click', () => {
        const exists = (tab.customMeasurements || []).find(
          (cm) => cm.expression.trim() === preset.expression.trim() && cm.label.trim() === preset.label.trim()
        );
        if (exists) {
          app.toggleMeasurementSelection(chId, `custom:${exists.id}`, true);
        } else {
          app.addCustomMeasurement(preset, chId);
        }
        renderMeasureModalCheckboxes(tab);
      });
      presetsWrap.appendChild(btn);
    });
  }

  const customList = document.getElementById('measureCustomList');
  if (customList) {
    customList.innerHTML = '';
    const defs = tab.customMeasurements || [];
    if (defs.length === 0) {
      customList.innerHTML =
        '<div class="text-[10px] font-mono text-slate-500 py-1">No custom metrics defined yet. Click a preset above or enter a formula.</div>';
    } else {
      defs.forEach((cm) => {
        const metricKey = `custom:${cm.id}`;
        const selId = `${chId}::${metricKey}`;
        const row = document.createElement('div');
        row.className =
          'flex items-center justify-between gap-2 px-2 py-1 bg-[#12161c] border border-[#222933] rounded-sm text-[11px]';
        const unitDesc = cm.unitType === 'custom' ? cm.customUnit || '' : cm.unitType;
        row.innerHTML = `
          <label class="flex items-center gap-2 min-w-0 flex-1 cursor-pointer">
            <input type="checkbox" class="measure-custom-chk accent-emerald-400 cursor-pointer shrink-0" ${selectedSet.has(selId) ? 'checked' : ''} />
            <span class="text-slate-100 truncate">${escapeHtml(cm.label)}</span>
            <span class="font-mono text-[10px] text-cyan-300 truncate">= ${escapeHtml(cm.expression)}</span>
            <span class="font-mono text-[10px] text-slate-500 shrink-0">[${escapeHtml(unitDesc)}]</span>
          </label>
          <button type="button" class="measure-custom-del px-1.5 py-0.5 text-[10px] font-mono text-slate-400 hover:text-red-300 cursor-pointer" title="Delete custom metric">✕</button>
        `;
        row.querySelector('.measure-custom-chk')?.addEventListener('change', (e: any) => {
          app.toggleMeasurementSelection(chId, metricKey, !!e.target.checked);
        });
        row.querySelector('.measure-custom-del')?.addEventListener('click', () => {
          app.removeCustomMeasurement(cm.id);
          renderMeasureModalCheckboxes(tab);
        });
        customList.appendChild(row);
      });
    }
  }
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

  const shiftBox = document.getElementById('editShiftChannelsList');
  if (shiftBox) {
    const hasCompareRef = tab.drawOrder.some((id) => {
      const c = tab.channels[id];
      return c && (c.compareRole === 'ref' || id.startsWith('cmp_ref_'));
    });
    shiftBox.innerHTML = '';
    tab.drawOrder.forEach((id, idx) => {
      const ch = tab.channels[id];
      if (!ch) return;
      const defaultChecked = hasCompareRef
        ? ch.compareRole === 'ref' || id.startsWith('cmp_ref_')
        : id === (tab.activeChannelId || tab.drawOrder[0]);
      const lbl = document.createElement('label');
      lbl.className = 'flex items-center gap-1.5 px-2 py-0.5 bg-[#0c0f13] border border-[#222933] rounded-xs cursor-pointer text-[11px] font-mono';
      lbl.innerHTML = `
        <input type="checkbox" class="edit-shift-ch-chk accent-cyan-400 cursor-pointer" value="${escapeHtml(id)}" ${defaultChecked ? 'checked' : ''} />
        <span class="w-2 h-2 rounded-xs shrink-0" style="background:${escapeHtml(ch.color)}"></span>
        <span class="text-slate-200 truncate max-w-[140px]">${ch.isMath ? '' : `CH${idx + 1}: `}${escapeHtml(ch.name)}</span>
        <span class="edit-shift-ch-dt text-[10px] text-cyan-300 tabular-nums" data-dt-id="${escapeHtml(id)}"></span>
      `;
      lbl.querySelector('.edit-shift-ch-chk')?.addEventListener('change', () => {
        syncEditTimeShiftUI(tab, true);
      });
      shiftBox.appendChild(lbl);
    });
  }

  syncWaveformEditModalState(tab);
  modal.style.display = 'flex';
}

function syncEditTimeShiftUI(tab: TabState, updateSliderValue: boolean = true) {
  document.querySelectorAll('#editShiftChannelsList .edit-shift-ch-dt').forEach((el) => {
    const id = el.getAttribute('data-dt-id') || '';
    const ch = tab.channels[id];
    const dt = ch?.timeShiftSec || 0;
    (el as HTMLElement).innerText = Math.abs(dt) > 1e-18 ? `Δt=${formatEng(dt, 's', 2)}` : '0s';
  });

  const primaryCh = tab.channels[tab.activeChannelId || tab.drawOrder[0]];
  const tView = primaryCh ? getTimeBoundsForView(tab, primaryCh).tSpan : 0;

  let refShiftSec = 0;
  const checkedFirst = document.querySelector('#editShiftChannelsList .edit-shift-ch-chk:checked') as HTMLInputElement | null;
  if (checkedFirst && tab.channels[checkedFirst.value]) {
    refShiftSec = tab.channels[checkedFirst.value].timeShiftSec || 0;
  }

  const slider = document.getElementById('editTimeShiftSlider') as HTMLInputElement | null;
  let pct = tView > 1e-18 ? (refShiftSec / tView) * 100 : 0;
  pct = Math.max(-100, Math.min(100, pct));
  if (updateSliderValue && slider) {
    slider.value = pct.toFixed(1);
  } else if (slider) {
    pct = parseFloat(slider.value) || 0;
  }

  const readout = document.getElementById('editTimeShiftReadout');
  if (readout) {
    const effectiveShift = updateSliderValue ? refShiftSec : (pct / 100) * tView;
    readout.innerText = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% · ${formatEng(effectiveShift, 's', 2)} (T_view = ${formatEng(tView, 's', 2)})`;
  }
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
    } else if (gEval.status === 'PASS') {
      gReadout.innerText = `PASS (Max dev ${formatEng(gEval.maxDeviation, ch.unit, 2)} · Cov ${gEval.coveragePct.toFixed(0)}%)`;
      gReadout.className = 'font-mono text-[11px] text-emerald-400 font-semibold tabular-nums';
    } else if (gEval.status === 'FAIL') {
      gReadout.innerText = `FAIL · ${gEval.violationCount} pts out (Max ${formatEng(gEval.maxDeviation, ch.unit, 2)} · Cov ${gEval.coveragePct.toFixed(0)}%)`;
      gReadout.className = 'font-mono text-[11px] text-red-400 font-semibold tabular-nums';
    } else {
      gReadout.innerText = `${gEval.status} · Cov ${gEval.coveragePct.toFixed(0)}%${gEval.invalidReason ? ` (${gEval.invalidReason})` : ''}`;
      gReadout.className = 'font-mono text-[11px] text-amber-300 font-semibold tabular-nums';
    }
  }

  syncEditTimeShiftUI(tab, true);
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
          <input type="checkbox" class="crop-ch-chk accent-cyan-400 cursor-pointer" value="${escapeHtml(id)}" ${ch.visible ? 'checked' : ''} />
          <span class="w-2.5 h-2.5 rounded-xs" style="background:${escapeHtml(ch.color)}"></span>
          <span class="text-slate-200 font-mono text-[11px]">${ch.isMath ? '[M]' : `CH${idx + 1}:`} ${escapeHtml(ch.name)}</span>
        </span>
        <span class="text-[10px] font-mono text-slate-400">${ch.hasEdits ? 'Edited+Ref' : escapeHtml(ch.unit)}</span>
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
    card.innerHTML = `<div class="text-amber-300">${escapeHtml(res.status)}</div>`;
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
      <td class="p-1.5 text-amber-300 uppercase">${escapeHtml(ev.kind)}</td>
      <td class="p-1.5 text-cyan-300">${formatEng(ev.time, 's', 4)}</td>
      <td class="p-1.5">${formatEng(ev.value, unit, 3)}</td>
      <td class="p-1.5 text-slate-400">${escapeHtml(ev.detail)}</td>
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
      <td class="p-1.5 max-w-[180px] truncate" title="${escapeHtml(r.fileName)}">${escapeHtml(r.fileName)}</td>
      <td class="p-1.5 text-slate-300">${escapeHtml(r.channelName)}</td>
      <td class="p-1.5">${r.sampleRateHz ? formatEng(r.sampleRateHz, 'Sa/s', 1) : '--'}</td>
      <td class="p-1.5">${m?.vpp !== null && m?.vpp !== undefined ? formatEng(m.vpp, r.unit, 2) : '--'}</td>
      <td class="p-1.5">${m?.rms !== null && m?.rms !== undefined ? formatEng(m.rms, r.unit, 2) : '--'}</td>
      <td class="p-1.5">${m?.frequency !== null && m?.frequency !== undefined ? formatEng(m.frequency, 'Hz', 2) : '--'}</td>
      <td class="p-1.5">${m?.dutyCycle !== null && m?.dutyCycle !== undefined ? m.dutyCycle.toFixed(1) + '%' : '--'}</td>
      <td class="p-1.5 ${badgeCls}">${r.status === 'error' ? 'ERR' : escapeHtml(r.passStatus || 'OK')}</td>
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
    row.className = 'flex items-center justify-between gap-2 p-2 bg-well border border-line rounded-sm text-xs';
    row.innerHTML = `
      <div class="min-w-0">
        <div class="text-fg font-medium truncate">${escapeHtml(p.name)}</div>
        <div class="text-[10px] font-mono text-fg-muted">${p.mathDefs.length} 数学 · ${p.selectedMetricsByIndex.length} 测量 · ${p.separateView ? '独立分屏' : '重叠视图'} · ${escapeHtml(p.renderMode)}</div>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <button class="preset-apply-btn wvp-btn-primary px-2.5 py-1 text-xs">应用</button>
        <button class="preset-del-btn wvp-btn-danger-ghost px-2 py-1 border border-line text-xs">删除</button>
      </div>
    `;
    row.querySelector('.preset-apply-btn')?.addEventListener('click', () => {
      const tab = app.getActiveTab();
      if (!tab) return;
      const res = applyPresetToTab(tab, p);
      app.renderSidebar();
      app.draw();
      app.showToast(`已应用模板「${p.name}」：新增 ${res.mathCreated} 数学通道，应用 ${res.metricsApplied} 项测量。`, 'info');
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
      isSel ? 'border-slate-900 scale-110 ring-2 ring-cyan-500/70' : 'border-[#2c3543] opacity-75 hover:opacity-100'
    }`;
    btn.style.background = theme.badgeColor;
    if (isSel) {
      btn.innerHTML = '<span class="w-2 h-2 rounded-full bg-white shadow-xs"></span>';
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
  const tgtStart = targetCh.t[0];
  const tgtEnd = targetCh.t[n - 1];
  let tStart = tgtStart;
  let tEnd = tgtEnd;

  // Adaptive horizontal bounds across Target and all full mapped queue traces
  for (const entry of compareQueue) {
    const ft = entry.computed?.fullRefT;
    if (ft && ft.length > 0) {
      const f0 = ft[0];
      const f1 = ft[ft.length - 1];
      if (isFinite(f0) && f0 < tStart) tStart = f0;
      if (isFinite(f1) && f1 > tEnd) tEnd = f1;
    }
  }
  const tSpan = Math.max(1e-18, tEnd - tStart);
  const extendedByCompare = tStart < tgtStart - 1e-15 || tEnd > tgtEnd + 1e-15;

  // Find combined vertical bounds across Target and all full queue traces
  let yMin = Infinity;
  let yMax = -Infinity;
  const scanRange = (vArr: Float32Array) => {
    const len = vArr.length;
    if (len === 0) return;
    const step = Math.max(1, Math.floor(len / 2000));
    for (let i = 0; i < len; i += step) {
      const val = vArr[i];
      if (isFinite(val)) {
        if (val < yMin) yMin = val;
        if (val > yMax) yMax = val;
      }
    }
  };
  scanRange(targetCh.v);
  for (const entry of compareQueue) {
    if (entry.computed?.fullRefV) {
      scanRange(entry.computed.fullRefV);
    } else if (entry.computed?.alignedRefV) {
      scanRange(entry.computed.alignedRefV);
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

  const plotSeries = (tArr: Float64Array, vArr: Float32Array, stroke: string, lineWidth: number, dashed: boolean) => {
    const len = Math.min(tArr.length, vArr.length);
    if (len < 2) return;
    const buckets = Math.min(w, len);
    const ptsPerBucket = len / buckets;
    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    if (dashed) ctx.setLineDash([4, 3]);
    ctx.beginPath();
    let started = false;
    for (let b = 0; b < buckets; b++) {
      const i0 = Math.floor(b * ptsPerBucket);
      const i1 = Math.max(i0 + 1, Math.min(len, Math.floor((b + 1) * ptsPerBucket)));
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
      const x = ((tArr[i0] - tStart) / tSpan) * w;
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
  plotSeries(targetCh.t, targetCh.v, targetCh.color || app.getRawColors()[0], 1.8, isComputedChannel(targetCh));

  // Draw each queued waveform in its assigned color across its full mapped duration
  let scaledCount = 0;
  let unscaledMismatchCount = 0;
  compareQueue.forEach((entry, idx) => {
    const color = entry.customColor || getCompareGroupTraceColor(themeId, idx + colorOffset, paletteMode);
    if (entry.computed?.fullRefT && entry.computed?.fullRefV) {
      plotSeries(entry.computed.fullRefT, entry.computed.fullRefV, color, 1.4, isComputedChannel(entry.channel));
    } else if (entry.computed?.alignedRefV) {
      plotSeries(targetCh.t, entry.computed.alignedRefV, color, 1.4, isComputedChannel(entry.channel));
    }
    if (Math.abs((entry.timeScale || 1) - 1) > 1e-6) {
      scaledCount++;
    } else {
      const rec = detectRecommendedTimeScale(targetCh, entry.channel);
      if (rec.isLargeMismatch) unscaledMismatchCount++;
    }
  });

  if (banner) {
    banner.innerText = `预览：目标「${targetCh.name}」+ ${compareQueue.length} 条参考 · 时间窗 ${formatEng(tSpan, 's', 2)}（${formatEng(tStart, 's', 2)} ~ ${formatEng(tEnd, 's', 2)}）${extendedByCompare ? '（按参考波形扩展）' : ''}`;
  }
  if (warnBanner) {
    if (unscaledMismatchCount > 0) {
      warnBanner.classList.remove('hidden');
      warnBanner.className = 'text-amber-300 font-semibold';
      warnBanner.innerText = `⚠ ${unscaledMismatchCount} 条波形的时间跨度相差 ≥10 倍；请先使用「自动匹配时长/单位」检查 ms、s、µs 单位`;
    } else if (scaledCount > 0) {
      warnBanner.classList.remove('hidden');
      warnBanner.className = 'text-emerald-300';
      warnBanner.innerText = `✓ 已缩放 ${scaledCount} 条参考波形并按首样本对齐；仅修正时间单位/跨度，不证明采集同步`;
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
    countBadge.innerText = `${compareQueue.length} 条参考波形 · [${groupName}]`;
    countBadge.style.color = theme.badgeColor;
  }

  if (!targetCh || compareQueue.length === 0) {
    wrap.innerHTML =
      '<div class="p-4 text-xs text-slate-400">先选择目标波形，再点击 <span class="text-cyan-300 font-semibold">＋导入文件</span>（支持多选）或 <span class="text-cyan-300 font-semibold">＋添加通道</span>。同一文件/通道会自动去重。</div>';
    renderComparePreviewCanvas(targetCh, paletteMode, theme.id, colorOffset);
    return;
  }

  const removeDc = !!(document.getElementById('cmpRemoveDcChk') as HTMLInputElement)?.checked;
  const tolMode = ((document.getElementById('cmpTolModeSelect') as HTMLSelectElement)?.value || 'percent') as 'percent' | 'absolute';
  const tolVal = parseFloat((document.getElementById('cmpTolValueInput') as HTMLInputElement)?.value || '5');
  const tolLimit = isFinite(tolVal) && tolVal > 0 ? tolVal : 5;
  const minCoverageRaw = parseFloat((document.getElementById('cmpMinCoverageSelect') as HTMLSelectElement)?.value || '80');
  const minCoveragePct = Number.isFinite(minCoverageRaw) ? Math.max(0, Math.min(100, minCoverageRaw)) : 80;

  const u = targetCh.unit || 'V';
  const fmt = (val: number | null, unitStr: string) =>
    val !== null && isFinite(val) ? formatEng(val, unitStr, 2) : '--';

  const table = document.createElement('table');
  table.className = 'w-full text-[11px] font-mono border-collapse tabular-nums';
  table.innerHTML = `
    <thead class="bg-[#161b22] text-slate-300 sticky top-0 z-10">
      <tr>
        <th class="p-2 border-b border-[#222933] text-left">颜色</th>
        <th class="p-2 border-b border-[#222933] text-left">参考波形</th>
        <th class="p-2 border-b border-[#222933] text-left" title="只缩放时间坐标，不改变采样数据；匹配时长不等于同步。">时间比例</th>
        <th class="p-2 border-b border-[#222933] text-left" title="参考波形相对于目标波形的时间平移量；正值表示参考波形向后移动。可直接输入秒，也可用小步进微调。">时间偏移 Δt(s)</th>
        <th class="p-2 border-b border-[#222933] text-right">相似度 / r</th>
        <th class="p-2 border-b border-[#222933] text-right" title="按两份记录时间节点的并集进行分段线性积分；不会因采样点密集获得额外权重，也不会漏掉只出现在较快通道节点上的脉冲。">RMSE / MAE</th>
        <th class="p-2 border-b border-[#222933] text-right">最大偏差 |Δ|</th>
        <th class="p-2 border-b border-[#222933] text-center">容差状态</th>
        <th class="p-2 border-b border-[#222933] text-right">操作</th>
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
    const mappedFull = buildMappedReferenceTrace(
      targetCh,
      entry.channel,
      entry.timeShiftSec || 0,
      removeDc,
      scale,
      aligned.targetMeanApplied,
      aligned.refMeanApplied
    );
    const metrics = computeWaveformCompareMetrics(targetCh, aligned.alignedRefV, removeDc, aligned);
    const golden = evaluateGoldenTolerance(targetCh, {
      enabled: true,
      channelId: targetCh.id,
      mode: tolMode,
      tolerance: tolLimit,
      refT: targetCh.t,
      refV: aligned.alignedRefV,
      refUnit: targetCh.unit,
      refLabel: entry.label,
      minCoveragePct,
      metricT: aligned.metricT,
      metricTargetV: aligned.metricTargetV,
      metricRefV: aligned.metricRefV,
      metricIntervalValid: aligned.metricIntervalValid,
      removeDcOffset: removeDc,
    });
    const cmpValid = aligned.valid && metrics.valid;
    const cmpStatus: CompareStatus = !aligned.valid
      ? aligned.status
      : !metrics.valid
      ? metrics.status
      : golden.status === 'INSUFFICIENT_DATA' || golden.status === 'INVALID'
      ? golden.status
      : 'OK';
    const cmpReason = aligned.invalidReason || metrics.invalidReason || golden.invalidReason || aligned.metricGridWarning || null;
    const cmpStatusLabel = cmpValid
      ? golden.status === 'PASS'
        ? '合格 PASS'
        : golden.status === 'FAIL'
        ? `超差 FAIL（${golden.violationCount} 点）`
        : golden.status === 'INSUFFICIENT_DATA'
        ? '覆盖不足 (可叠加)'
        : '数据无效'
      : cmpStatus === 'INVALID'
      ? '数据/单位无效'
      : mappedFull.t.length >= 2
      ? '时间轴未重叠 (可叠加)'
      : '无连续有效区间';

    entry.computed = {
      alignedRefV: aligned.alignedRefV,
      diffV: aligned.diffV,
      fullRefT: mappedFull.t,
      fullRefV: mappedFull.v,
      metrics,
      pass: golden.pass,
      violationCount: golden.violationCount,
      valid: cmpValid,
      status: cmpStatus,
      reason: cmpReason || undefined,
    };

    const refDur =
      entry.channel.t.length >= 2
        ? Math.abs(entry.channel.t[entry.channel.t.length - 1] - entry.channel.t[0])
        : 0;
    const refDt =
      entry.channel.dt ||
      (entry.channel.t.length >= 2 ? Math.abs(entry.channel.t[1] - entry.channel.t[0]) : 0);
    const targetDt =
      targetCh.dt ||
      (targetCh.t.length >= 2 ? Math.abs(targetCh.t[1] - targetCh.t[0]) : 0);
    const scaledRefDt = refDt * scale;
    const fineShiftStep = Math.max(
      1e-12,
      Math.min(
        targetDt > 0 ? targetDt / 10 : Infinity,
        scaledRefDt > 0 ? scaledRefDt / 10 : Infinity,
        (tgtDur || refDur || 1) * 0.001
      )
    );
    const fitRatio = tgtDur > 1e-18 && refDur > 1e-18 ? tgtDur / refDur : 1;
    const presetScales = [1, 0.001, 1e-6, 1000, 1e6];
    const matchedPreset = presetScales.find((p) => Math.abs(scale - p) / p < 1e-4);

    const assignedColor = entry.customColor || getCompareGroupTraceColor(theme.id, idx + colorOffset, paletteMode);
    const tr = document.createElement('tr');
    tr.className = 'border-b border-[#1b222c] hover:bg-[#161b22]/80 text-slate-200';
    tr.innerHTML = `
      <td class="p-1.5">
        <div class="flex items-center gap-1">
          <span class="w-1 h-5 rounded-xs shrink-0" style="background:${escapeHtml(theme.badgeColor)}" title="比较组 [${escapeHtml(groupName)}]"></span>
          <input type="color" class="cmp-row-color w-6 h-5 bg-transparent border border-[#2c3543] rounded-xs cursor-pointer p-0" value="${escapeHtml(assignedColor)}" title="[${escapeHtml(groupName)}] 参考波形颜色" />
        </div>
      </td>
      <td class="p-1.5 max-w-[180px]">
        <div class="flex items-center gap-1 truncate" title="[${escapeHtml(groupName)}] ${escapeHtml(entry.label)}">
          <span class="text-[9px] font-bold px-1 rounded-xs border shrink-0" style="color:${escapeHtml(theme.badgeColor)};border-color:${escapeHtml(theme.badgeColor)}">${escapeHtml(groupName)}</span>
          <span class="truncate text-slate-100">${escapeHtml(entry.label)}</span>
        </div>
        <div class="text-[9px] text-slate-400 truncate">
          时长 ${formatEng(refDur * scale, 's', 2)} · 当前采样间隔 ${formatEng(scaledRefDt, 's', 3)} · 源间隔 ${formatEng(refDt, 's', 3)} · 起点 ${formatEng(entry.channel.t[0] || 0, 's', 3)}
        </div>
      </td>
      <td class="p-1.5">
        <select class="cmp-row-scale bg-[#12161c] border border-[#222933] rounded-xs px-1 py-0.5 text-[10px] text-cyan-200 font-mono">
          <option value="1" ${matchedPreset === 1 ? 'selected' : ''}>1×</option>
          <option value="0.001" ${matchedPreset === 0.001 ? 'selected' : ''}>×0.001 (ms→s)</option>
          <option value="0.000001" ${matchedPreset === 1e-6 ? 'selected' : ''}>×1e-6 (µs→s)</option>
          <option value="1000" ${matchedPreset === 1000 ? 'selected' : ''}>×1000 (s→ms)</option>
          <option value="1000000" ${matchedPreset === 1e6 ? 'selected' : ''}>×1e6 (s→µs)</option>
          <option value="fit">匹配时长（×${Number(fitRatio.toPrecision(3))}）</option>
          ${!matchedPreset ? `<option value="${scale}" selected>×${Number(scale.toPrecision(3))}</option>` : ''}
        </select>
      </td>
      <td class="p-1.5">
        <div class="flex items-center gap-1">
          <button type="button" class="cmp-row-dt-dec px-1.5 py-0.5 bg-[#161b22] hover:bg-[#1e2530] border border-[#2c3543] text-cyan-300 font-bold rounded-xs cursor-pointer select-none" title="按较小的有效采样间隔的 1/10 微调；按住 Shift 点击为 10 倍步长">−</button>
          <input type="number" class="cmp-row-dt-input w-[92px] min-w-0 bg-[#0c0f13] border border-cyan-700/60 rounded-xs px-1 py-0.5 text-cyan-100 text-right font-mono tabular-nums" step="${fineShiftStep.toExponential(3)}" value="${Number((entry.timeShiftSec || 0).toPrecision(10))}" title="输入参考波形时间平移 Δt，单位秒；正值向后移动。微调步长按缩放后的参考与目标采样间隔估算。" />
          <button type="button" class="cmp-row-dt-inc px-1.5 py-0.5 bg-[#161b22] hover:bg-[#1e2530] border border-[#2c3543] text-cyan-300 font-bold rounded-xs cursor-pointer select-none" title="按较小的有效采样间隔的 1/10 微调；按住 Shift 点击为 10 倍步长">+</button>
          <button type="button" class="cmp-row-t0 px-1.5 py-0.5 bg-[#161b22] hover:bg-[#1e2530] border border-[#2c3543] text-emerald-300 rounded-xs cursor-pointer" title="仅将参考波形首样本与目标首样本对齐；不改变时间比例，也不证明两次采集真实同步">t0</button>
          <button type="button" class="cmp-row-xcorr px-1.5 py-0.5 bg-[#161b22] hover:bg-[#1e2530] border border-[#2c3543] text-amber-300 rounded-xs cursor-pointer" title="根据两条波形的形状相关性估算最佳时间平移；仅适用于具有共同变化特征的信号">XCorr</button>
        </div>
        <div class="mt-0.5 text-[9px] text-slate-500">${`Δt ${formatEng(entry.timeShiftSec || 0, 's', 3)} · 有效时间覆盖 ${metrics.coveragePct.toFixed(1)}%（${formatEng(metrics.coveredDurationSec, 's', 2)} / ${formatEng(metrics.targetDurationSec, 's', 2)}）`}</div>
      </td>
      <td class="p-1.5 text-right">
        <div class="text-cyan-300 font-semibold">${cmpValid && metrics.similarityPct !== null ? metrics.similarityPct.toFixed(1) + '%' : '--'}</div>
        <div class="text-[10px] text-slate-400">${cmpValid && metrics.correlation !== null ? `r=${metrics.correlation.toFixed(3)}` : `Cov ${metrics.coveragePct.toFixed(0)}%`}</div>
      </td>
      <td class="p-1.5 text-right">
        <div>${cmpValid ? fmt(metrics.rmse, u) : '--'}</div>
        <div class="text-[10px] text-slate-400">${cmpValid ? fmt(metrics.mae, u) : '--'}</div>
      </td>
      <td class="p-1.5 text-right">
        <div class="text-amber-300">${cmpValid ? fmt(metrics.maxAbsDiff, u) : '--'}</div>
        <div class="text-[10px] text-slate-400">${cmpValid ? `@${fmt(metrics.maxAbsDiffTime, 's')}` : '--'}</div>
      </td>
      <td class="p-1.5 text-center" title="${escapeHtml(cmpReason || '')}">
        <span class="font-semibold ${
          cmpValid && golden.status === 'PASS'
            ? 'text-emerald-400'
            : !cmpValid || cmpStatus === 'INVALID' || cmpStatus === 'INSUFFICIENT_DATA'
            ? 'text-amber-300'
            : 'text-red-400'
        }">${
          cmpStatusLabel
        }</span>
      </td>
      <td class="p-1.5 text-right whitespace-nowrap">
        <button type="button" class="cmp-row-jump px-1.5 py-0.5 bg-[#161b22] hover:bg-[#1e2530] border border-amber-600/50 text-amber-300 rounded-xs cursor-pointer mr-1" title="定位目标波形最大偏差时间点">定位</button>
        <button type="button" class="cmp-row-del px-1.5 py-0.5 bg-[#161b22] hover:bg-red-950/60 border border-[#222933] text-red-300 rounded-xs cursor-pointer" title="从比较组移除此参考波形">移除</button>
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
    tr.querySelector('.cmp-row-dt-input')?.addEventListener('change', (ev: any) => {
      const value = Number.parseFloat(String(ev.target?.value ?? ''));
      if (!Number.isFinite(value)) {
        ev.target.value = String(Number((entry.timeShiftSec || 0).toPrecision(10)));
        return;
      }
      entry.timeShiftSec = value;
      recomputeComparePanel(tab);
    });
    tr.querySelector('.cmp-row-t0')?.addEventListener('click', () => {
      entry.timeShiftSec = computeAutoTimeAlignShift(targetCh, entry.channel, 'start', entry.timeScale || 1);
      recomputeComparePanel(tab);
    });
    tr.querySelector('.cmp-row-dt-dec')?.addEventListener('click', (ev) => {
      const nudge = fineShiftStep * ((ev as MouseEvent).shiftKey ? 10 : 1);
      entry.timeShiftSec = (entry.timeShiftSec || 0) - nudge;
      recomputeComparePanel(tab);
    });
    tr.querySelector('.cmp-row-dt-inc')?.addEventListener('click', (ev) => {
      const nudge = fineShiftStep * ((ev as MouseEvent).shiftKey ? 10 : 1);
      entry.timeShiftSec = (entry.timeShiftSec || 0) + nudge;
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
  const legend = document.createElement('div');
  legend.className = 'px-2 py-1.5 text-[10px] text-fg-muted border-t border-line';
  legend.textContent = '指标口径：RMSE/MAE 按时间积分（非均匀采样不按点数加权）；时间覆盖率按连续有效时长计算；PASS 需满足最低覆盖率且全部有效比较点落在容差带内。匹配时长或首样本对齐不代表采集同步。';
  wrap.appendChild(legend);
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
  if (editGroupId) {
    const targetId = (document.getElementById('cmpTargetSelect') as HTMLSelectElement | null)?.value;
    const existingBand = tab.goldenBand;
    if (existingBand?.enabled && (!targetId || existingBand.channelId === targetId)) {
      const tolModeEl = document.getElementById('cmpTolModeSelect') as HTMLSelectElement | null;
      const tolValueEl = document.getElementById('cmpTolValueInput') as HTMLInputElement | null;
      const minCoverageEl = document.getElementById('cmpMinCoverageSelect') as HTMLSelectElement | null;
      const enableGoldenEl = document.getElementById('cmpEnableGoldenChk') as HTMLInputElement | null;
      if (tolModeEl) tolModeEl.value = existingBand.mode;
      if (tolValueEl) tolValueEl.value = String(existingBand.tolerance);
      if (minCoverageEl) minCoverageEl.value = String(existingBand.minCoveragePct ?? 80);
      if (enableGoldenEl) enableGoldenEl.checked = true;
    }
  }
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

  const idcIdx = tab.drawOrder.findIndex((id) => /ibus|i_bus|idc|i_dc|shunt/i.test(tab.channels[id]?.name || ''));
  const daIdx = tab.drawOrder.findIndex((id) => /(?:duty|pwm)[\s_-]*(?:a|u)|\bda\b/i.test(tab.channels[id]?.name || ''));
  const dbIdx = tab.drawOrder.findIndex((id) => /(?:duty|pwm)[\s_-]*(?:b|v)|\bdb\b/i.test(tab.channels[id]?.name || ''));
  const dcIdx = tab.drawOrder.findIndex((id) => /(?:duty|pwm)[\s_-]*(?:c|w)|\bdc\b/i.test(tab.channels[id]?.name || ''));
  populateSelect('bldcSsIdcSelect', idcIdx >= 0 ? idcIdx : (currIdx >= 0 ? currIdx : 0));
  populateSelect('bldcSsDaSelect', daIdx >= 0 ? daIdx : Math.min(1, maxIdx));
  populateSelect('bldcSsDbSelect', dbIdx >= 0 ? dbIdx : Math.min(2, maxIdx));
  populateSelect('bldcSsDcSelect', dcIdx >= 0 ? dcIdx : Math.min(3, maxIdx));

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
  if (!res.valid) {
    card.innerHTML = `
      <div class="bg-red-950/55 border border-red-500/60 text-red-200 px-3 py-2 rounded-xs text-[11px] space-y-1">
        <div class="font-bold text-red-300">INVALID · 三相诊断已拒绝执行 (Fail-Closed)</div>
        ${res.warnings.map((w) => `<div>✖ ${escapeHtml(w)}</div>`).join('')}
      </div>
    `;
    return;
  }
  const unit = res.unit || chU.unit || 'V';
  const unbalOk = res.vppUnbalancePct <= 3 && res.rmsUnbalancePct <= 3;
  const angOk = res.maxPhaseErrorDeg === null || res.maxPhaseErrorDeg <= 3;
  const warnBanner =
    res.warnings.length > 0
      ? `<div class="bg-amber-950/45 border border-amber-500/50 text-amber-200 px-2.5 py-1.5 rounded-xs text-[10px] space-y-0.5">${res.warnings.map((w) => `<div>⚠ ${escapeHtml(w)}</div>`).join('')}</div>`
      : '';

  card.innerHTML = `
    ${warnBanner}
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
          <div class="text-slate-200 font-semibold truncate">${escapeHtml(p.name)}</div>
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
  const rawPolesStr = ((document.getElementById('bldcHallPolesInput') as HTMLInputElement)?.value ?? '').trim();
  const poles = rawPolesStr === '' ? Number.NaN : Number(rawPolesStr);
  const presetVal = (document.getElementById('bldcHallSeqPresetSelect') as HTMLSelectElement)?.value || 'std_120';
  const customSeqRaw = (document.getElementById('bldcHallCustomSeqInput') as HTMLInputElement)?.value || '';
  const offsetDeg = parseFloat((document.getElementById('bldcHallOffsetInput') as HTMLInputElement)?.value || '0') || 0;
  const presetRing = HALL_SEQUENCE_PRESETS.find((p) => p.id === presetVal)?.ring;
  const customRing = parseHallSequenceText(customSeqRaw) || undefined;
  const activeCustomRing = presetVal === 'custom' ? customRing : presetRing ?? customRing;

  const chA = tab.channels[aId];
  const chB = tab.channels[bId];
  const chC = tab.channels[cId];
  if (!chA || !chB || !chC) {
    card.innerHTML = '<div class="text-amber-300">Select 3 Hall / Back-EMF channels.</div>';
    return;
  }
  const { tStart, tEnd } = getBldcGateBounds(tab, chA);
  const res = analyzeBldcHallCommutation(chA, chB, chC, poles, {
    tStart,
    tEnd,
    customSequence: activeCustomRing,
    hallOffsetDeg: offsetDeg,
  });

  if (!res.valid) {
    card.innerHTML = `
      <div class="bg-red-950/55 border border-red-500/60 text-red-200 px-3 py-2 rounded-xs text-[11px] space-y-1">
        <div class="font-bold text-red-300">INVALID · Hall 换相解码已拒绝执行 (Fail-Closed)</div>
        ${res.warnings.map((w) => `<div>✖ ${escapeHtml(w)}</div>`).join('')}
      </div>
    `;
    return;
  }

  const warnBanner =
    res.warnings.length > 0
      ? `<div class="bg-amber-950/45 border border-amber-500/50 text-amber-200 px-2.5 py-1.5 rounded-xs text-[10px] space-y-0.5">${res.warnings.map((w) => `<div>⚠ ${escapeHtml(w)}</div>`).join('')}</div>`
      : '';

  if (res.commutationCount === 0) {
    card.innerHTML = `
      ${warnBanner}
      <div class="text-amber-300">No full 6-step commutation sectors detected in the selected gate window.</div>
      <div class="text-slate-400 text-[11px]">Illegal States: ${res.illegalStateCount} · Sequence Jumps: ${res.sequenceJumpCount} · Ring: [${res.activeRing.join('→')}]</div>
    `;
    return;
  }

  card.innerHTML = `
    ${warnBanner}
    <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] pb-2 border-b border-[#222933]">
      <div class="bg-[#12161c] p-2 rounded-sm border border-[#1f2732]">
        <div class="text-slate-400">Direction / Seq</div>
        <div class="font-bold text-cyan-300">${res.direction}</div>
        <div class="text-[10px] text-slate-400">${res.sequence.join('→') || '--'} (Ref: ${res.activeRing.join('→')})</div>
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
        <div class="text-slate-400">Faults (Illegal/Skip)</div>
        <div class="font-bold ${res.illegalStateCount + res.sequenceJumpCount === 0 ? 'text-emerald-400' : 'text-red-400'}">${res.illegalStateCount} Illegal / ${res.sequenceJumpCount} Skip</div>
        <div class="text-[10px] text-slate-400">Sectors: ${res.commutationCount} · Offset: ${res.hallOffsetDeg.toFixed(1)}°</div>
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
                <span class="text-amber-300">${escapeHtml(ev.detail)}</span>
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
  const role = ((document.getElementById('bldcPwmRoleSelect') as HTMLSelectElement)?.value || 'gate_h') as PwmHighSignalRole;
  const chH = tab.channels[hId];
  const chL = lId ? tab.channels[lId] || null : null;
  if (!chH) {
    card.innerHTML = '<div class="text-amber-300">Select a High-Side Gate or SW Node channel.</div>';
    return;
  }
  const { tStart, tEnd } = getBldcGateBounds(tab, chH);
  const res = analyzePwmSwitchingAndDeadTime(chH, chL, {
    tStart,
    tEnd,
    highSignalRole: role,
  });

  if (!res.valid) {
    card.innerHTML = `
      <div class="bg-red-950/55 border border-red-500/60 text-red-200 px-3 py-2 rounded-xs text-[11px] space-y-1">
        <div class="font-bold text-red-300">INVALID · PWM / 死区分析已拒绝执行 (Fail-Closed)</div>
        ${res.warnings.map((w) => `<div>✖ ${escapeHtml(w)}</div>`).join('')}
      </div>
    `;
    return;
  }

  const qualBadge = (q: string) => {
    if (q === 'RELIABLE') {
      return '<span class="ml-1 px-1 py-px text-[9px] rounded-xs bg-emerald-950/70 border border-emerald-500/50 text-emerald-300">RELIABLE</span>';
    }
    if (q === 'APPROXIMATE') {
      return '<span class="ml-1 px-1 py-px text-[9px] rounded-xs bg-amber-950/70 border border-amber-500/50 text-amber-300">APPROX</span>';
    }
    if (q === 'INSUFFICIENT_RESOLUTION') {
      return '<span class="ml-1 px-1 py-px text-[9px] rounded-xs bg-orange-950/70 border border-orange-500/50 text-orange-300">LOW RES</span>';
    }
    return '<span class="ml-1 px-1 py-px text-[9px] rounded-xs bg-red-950/70 border border-red-500/50 text-red-300">INVALID</span>';
  };

  const warnBanner =
    res.warnings.length > 0
      ? `<div class="bg-amber-950/45 border border-amber-500/50 text-amber-200 px-2.5 py-1.5 rounded-xs text-[10px] space-y-0.5">${res.warnings.map((w) => `<div>⚠ ${escapeHtml(w)}</div>`).join('')}</div>`
      : '';
  const deadTimeDisableReason =
    res.warnings.find((w) => w.includes('死区') || w.includes('直通') || w.includes('降采样') || w.includes('SW') || w.includes('单位') || w.includes('摆幅') || w.includes('分辨率')) ||
    '死区与直通判定已降级/禁用：请确认双路均为有效 Vgs_H / Vgs_L 电压栅极驱动信号且边沿采样分辨率充足。';

  card.innerHTML = `
    ${warnBanner}
    <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] pb-2 border-b border-[#222933]">
      <div class="bg-[#12161c] p-2 rounded-sm border border-[#1f2732]">
        <div class="text-slate-400 flex items-center justify-between"><span>Carrier Freq</span>${qualBadge(res.freqQuality)}</div>
        <div class="font-bold text-cyan-300">${res.pwmFreqHz !== null ? formatEng(res.pwmFreqHz, 'Hz', 2) : '--'}</div>
        <div class="text-[10px] text-slate-400">${res.pulseCount} pulses</div>
      </div>
      <div class="bg-[#12161c] p-2 rounded-sm border border-[#1f2732]">
        <div class="text-slate-400 flex items-center justify-between"><span>Duty</span>${qualBadge(res.dutyQuality)}</div>
        <div class="font-bold text-slate-100">${res.dutyAvgPct !== null ? res.dutyAvgPct.toFixed(1) + '%' : '--'}</div>
        <div class="text-[10px] text-slate-400">${res.dutyMinPct !== null ? res.dutyMinPct.toFixed(1) + '% ~ ' + res.dutyMaxPct?.toFixed(1) + '%' : '--'}</div>
      </div>
      <div class="bg-[#12161c] p-2 rounded-sm border border-[#1f2732]">
        <div class="text-slate-400 flex items-center justify-between"><span>Max dV/dt</span>${qualBadge(res.dvDtQuality)}</div>
        <div class="font-bold text-amber-300">${res.maxDvDtVPerUs !== null ? res.maxDvDtVPerUs.toFixed(1) + ' V/µs' : '--'}</div>
        <div class="text-[10px] text-slate-400">Overshoot: ${res.overshootPct !== null ? res.overshootPct.toFixed(1) + '%' : '--'}</div>
      </div>
      <div class="bg-[#12161c] p-2 rounded-sm border border-[#1f2732]">
        <div class="text-slate-400 flex items-center justify-between"><span>LC Ringing</span>${qualBadge(res.ringingQuality)}</div>
        <div class="font-bold text-purple-300">${res.ringingFreqHz !== null ? formatEng(res.ringingFreqHz, 'Hz', 2) : '--'}</div>
        <div class="text-[10px] text-slate-400">${res.edgeTimeResolutionSec !== null ? 'Edge dt: ' + formatEng(res.edgeTimeResolutionSec, 's', 2) : 'Post-edge oscillation'}</div>
      </div>
    </div>
    ${
      chL
        ? res.deadTimeReliable && res.deadTimeQuality === 'RELIABLE'
          ? `<div class="flex flex-wrap items-center justify-between gap-2 pt-2 text-[11px]">
              <div class="flex items-center flex-wrap gap-1">
                <span>Dead-Time (Min / Avg / Max):</span>
                <strong class="text-emerald-300">
                  ${res.deadTimeMinSec !== null ? formatEng(res.deadTimeMinSec, 's', 2) : '--'} /
                  ${res.deadTimeAvgSec !== null ? formatEng(res.deadTimeAvgSec, 's', 2) : '--'} /
                  ${res.deadTimeMaxSec !== null ? formatEng(res.deadTimeMaxSec, 's', 2) : '--'}
                </strong>
                ${qualBadge(res.deadTimeQuality)}
                <span class="text-slate-400">(${res.deadTimeCount} edges)</span>
              </div>
              <div class="flex items-center gap-2">
                <span class="${res.shootThroughCount > 0 ? 'text-red-400 font-bold' : 'text-emerald-400'}">
                  Shoot-Through Overlaps: ${res.shootThroughCount}
                </span>
                ${qualBadge(res.shootThroughQuality)}
                ${
                  res.worstEventIndex !== null
                    ? `<button id="bldcPwmJumpWorstBtn" type="button" class="px-2 py-0.5 bg-[#161b22] hover:bg-amber-950/50 border border-amber-500/60 text-amber-300 rounded-xs cursor-pointer">Jump to Min/Fault @ ${formatEng(res.worstEventTime || 0, 's', 3)}</button>`
                    : ''
                }
              </div>
            </div>`
          : res.deadTimeQuality === 'APPROXIMATE'
          ? `<div class="space-y-1 pt-2 text-[11px]">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center flex-wrap gap-1">
                  <span>Dead-Time (Approx Min / Avg / Max):</span>
                  <strong class="text-amber-300">
                    ${res.deadTimeMinSec !== null ? formatEng(res.deadTimeMinSec, 's', 2) : '--'} /
                    ${res.deadTimeAvgSec !== null ? formatEng(res.deadTimeAvgSec, 's', 2) : '--'} /
                    ${res.deadTimeMaxSec !== null ? formatEng(res.deadTimeMaxSec, 's', 2) : '--'}
                  </strong>
                  ${qualBadge(res.deadTimeQuality)}
                  ${res.edgeTimeResolutionSec !== null ? `<span class="text-amber-200/80">(±${formatEng(res.edgeTimeResolutionSec, 's', 2)})</span>` : ''}
                </div>
                <div class="flex items-center gap-2">
                  <span class="${res.shootThroughCount > 0 ? 'text-red-400 font-bold' : 'text-amber-300'}">
                    Shoot-Through: ${res.shootThroughCount}
                  </span>
                  ${qualBadge(res.shootThroughQuality)}
                </div>
              </div>
              <div class="text-[10px] text-amber-300">${escapeHtml(deadTimeDisableReason)}</div>
            </div>`
          : `<div class="space-y-1 pt-1.5 text-[11px]">
              <div class="flex items-center gap-2 text-orange-300">
                <span>Dead-Time / Shoot-Through Status:</span>
                ${qualBadge(res.deadTimeQuality)}
              </div>
              <div class="text-amber-300">${escapeHtml(deadTimeDisableReason)}</div>
            </div>`
        : '<div class="text-[11px] text-slate-400 pt-1">Tip: Select a complementary Low-Side gate channel above (with Vgs_H) to compute dead-time (ns) and shoot-through overlaps.</div>'
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
  if (!res.valid) {
    card.innerHTML = `<div class="text-rose-300 text-xs">${escapeHtml(res.invalidReason || '输入波形无效，已拒绝计算。')}</div>`;
    return;
  }
  const unit = ch.unit || 'A';
  const kindBadge =
    res.isTrueMechanicalTorque
      ? '<span class="px-1.5 py-0.5 bg-emerald-950/70 border border-emerald-500/50 text-emerald-300 rounded-xs text-[10px]">已标记实测轴转矩</span>'
      : res.signalKind === 'torque'
      ? '<span class="px-1.5 py-0.5 bg-amber-950/70 border border-amber-500/50 text-amber-200 rounded-xs text-[10px]">转矩量（实测来源待核实）</span>'
      : res.signalKind === 'current'
      ? '<span class="px-1.5 py-0.5 bg-amber-950/70 border border-amber-500/50 text-amber-200 rounded-xs text-[10px]">电流纹波 (非机械转矩)</span>'
      : res.signalKind === 'power'
      ? '<span class="px-1.5 py-0.5 bg-amber-950/70 border border-amber-500/50 text-amber-200 rounded-xs text-[10px]">电功率脉动 (非机械转矩)</span>'
      : '<span class="px-1.5 py-0.5 bg-[#161b22] border border-[#2c3543] text-slate-300 rounded-xs text-[10px]">通用通道脉动</span>';

  card.innerHTML = `
    <div class="flex flex-wrap items-center gap-2">
      ${kindBadge}
      ${res.warning ? `<span class="text-[10px] text-amber-300">${escapeHtml(res.warning)}</span>` : ''}
    </div>
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


