/**
 * Waveform Viewer Pro - Main Entry Point
 * Initializes oscilloscope workspace, binds toolbar controls, modals, and file dialogs.
 */

import './index.css';
import { OscilloscopeApp } from './engine/uiController';
import { runAllTests } from './tests/testSuite';
import { TabState, WaveformChannel } from './types/models';
import { OVERLAP_COLORS } from './engine/canvasRenderer';

let app: OscilloscopeApp;

window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('waveformCanvas') as HTMLCanvasElement;
  if (!canvas) return;

  app = new OscilloscopeApp(canvas);

  // Bind Main Toolbars
  bindToolbarActions();
  bindModals();

  // Run automated test suite in background to verify algorithm correctness
  const testResults = runAllTests();
  console.log('Oscilloscope Verification Test Results:', testResults);
});

function bindToolbarActions() {
  // Load File button
  const fileInput = document.getElementById('fileInput') as HTMLInputElement;
  const loadBtn = document.getElementById('loadBtn');
  if (loadBtn && fileInput) {
    loadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e: any) => {
      if (e.target.files && e.target.files.length > 0) {
        app.handleFiles(Array.from(e.target.files));
        fileInput.value = '';
      }
    });
  }

  // View Mode: Waveform vs Spectrum
  const timeModeBtn = document.getElementById('timeModeBtn');
  const freqModeBtn = document.getElementById('freqModeBtn');

  timeModeBtn?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) {
      tab.plotMode = 'time';
      timeModeBtn.classList.add('bg-[#0078d7]', 'text-white');
      timeModeBtn.classList.remove('bg-neutral-800', 'text-neutral-300');
      freqModeBtn?.classList.remove('bg-[#0078d7]', 'text-white');
      freqModeBtn?.classList.add('bg-neutral-800', 'text-neutral-300');
      app.renderSidebar();
      app.draw();
    }
  });

  freqModeBtn?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) {
      tab.plotMode = 'frequency';
      freqModeBtn.classList.add('bg-[#0078d7]', 'text-white');
      freqModeBtn.classList.remove('bg-neutral-800', 'text-neutral-300');
      timeModeBtn?.classList.remove('bg-[#0078d7]', 'text-white');
      timeModeBtn?.classList.add('bg-neutral-800', 'text-neutral-300');
      app.renderSidebar();
      app.draw();
    }
  });

  // AutoSet (1-2-5 scale)
  document.getElementById('autoSetBtn')?.addEventListener('click', () => {
    app.executeAutoSet();
  });

  // Reset / Fit View (F)
  document.getElementById('fitViewBtn')?.addEventListener('click', () => {
    app.fitView();
  });

  // Toggle Cursors
  document.getElementById('toggleCursorsBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) {
      tab.cursors.enabled = !tab.cursors.enabled;
      if (tab.cursors.enabled) {
        if (!tab.cursors.type) tab.cursors.type = 'x';
        app.ensureCursorPositions(tab);
      }
      app.renderSidebar();
      app.draw();
    }
  });

  const cursorTypeSelect = document.getElementById('cursorTypeSelect') as HTMLSelectElement;
  cursorTypeSelect?.addEventListener('change', () => {
    const tab = app.getActiveTab();
    if (tab) {
      const val = cursorTypeSelect.value;
      if (val === 'off') {
        tab.cursors.enabled = false;
      } else {
        tab.cursors.enabled = true;
        tab.cursors.type = val as any;
        app.ensureCursorPositions(tab);
      }
      app.renderSidebar();
      app.draw();
    }
  });

  // Toggle Separate Diagrams
  document.getElementById('toggleSeparateBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (tab) {
      tab.separateView = !tab.separateView;
      app.draw();
    }
  });

  // Trigger Modal
  document.getElementById('triggerBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    openTriggerModal(tab);
  });

  // Math Channel Modal
  document.getElementById('addMathBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    openMathModal(tab);
  });
  document.getElementById('sidebarAddMathBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    openMathModal(tab);
  });

  // Clarke / Park Transform Modal
  document.getElementById('transformBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    openTransformModal(tab);
  });
  document.getElementById('sidebarClarkeBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    openTransformModal(tab);
  });

  // FFT Controls live synchronization
  const spanSel = document.getElementById('fftSpanSelect') as HTMLSelectElement;
  spanSel?.addEventListener('change', () => {
    const tab = app.getActiveTab();
    if (tab) {
      app.applyFrequencySpan(tab, spanSel.value);
    }
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

  // BLDC Motor Modal
  document.getElementById('motorBtn')?.addEventListener('click', () => {
    const tab = app.getActiveTab();
    if (!tab) return;
    openMotorModal(tab);
  });

  // Export Dropdown
  document.getElementById('exportPngBtn')?.addEventListener('click', () => app.exportPNG());
  document.getElementById('exportCsvWaveformBtn')?.addEventListener('click', () => app.exportWaveformCSV());
  document.getElementById('exportCsvSpectrumBtn')?.addEventListener('click', () => app.exportSpectrumCSV());
  document.getElementById('saveSessionBtn')?.addEventListener('click', () => app.saveSessionFile());

  // Test Suite Dialog
  document.getElementById('testSuiteBtn')?.addEventListener('click', () => {
    openTestSuiteModal();
  });

  // Demo / Sample Waveform Generator
  document.getElementById('loadSampleSignalBtn')?.addEventListener('click', () => {
    loadSynthetic3PhaseMotorData();
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

    tab.triggerConfig.enabled = true;
    tab.triggerConfig.channelId = chSel.value;
    tab.triggerConfig.type = typeSel.value as 'rising' | 'falling';
    tab.triggerConfig.level = parseFloat(levelInput.value) || 0;

    app.applyTrigger();
    document.getElementById('triggerModal')!.style.display = 'none';
  });
  document.getElementById('triggerCancelBtn')?.addEventListener('click', () => {
    document.getElementById('triggerModal')!.style.display = 'none';
  });

  // Transform Modal
  document.getElementById('clarkeApplyBtn')?.addEventListener('click', () => {
    const ua = (document.getElementById('clarkeUaSelect') as HTMLSelectElement).value;
    const ub = (document.getElementById('clarkeUbSelect') as HTMLSelectElement).value;
    const uc = (document.getElementById('clarkeUcSelect') as HTMLSelectElement).value;
    app.executeClarkeTransform(ua, ub, uc);
    document.getElementById('transformModal')!.style.display = 'none';
  });
  document.getElementById('transformCancelBtn')?.addEventListener('click', () => {
    document.getElementById('transformModal')!.style.display = 'none';
  });

  // Motor Modal
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

  // Generic close for modal backdrops
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
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

  // Populate Available Channels with clickable badges
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
        'px-2 py-1 bg-neutral-800 hover:bg-neutral-700 text-cyan-300 rounded font-mono text-xs border border-neutral-700 hover:border-cyan-500 transition cursor-pointer';
      btn.innerText = `${alias}: ${ch.name}`;
      btn.title = `Click to insert ${alias} (${ch.name})`;
      btn.addEventListener('click', () => {
        insertAtCursor(exprInput, alias);
      });
      availContainer.appendChild(btn);
    });
  }

  // Wire Keypad buttons
  document.querySelectorAll('#mathKeypad .keypad-btn').forEach((btn) => {
    const newBtn = btn.cloneNode(true) as HTMLButtonElement;
    btn.parentNode?.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => {
      const textToInsert = newBtn.getAttribute('data-insert') || '';
      insertAtCursor(exprInput, textToInsert);
    });
  });

  // Render quick presets buttons
  const presetContainer = document.getElementById('quickMathPresets');
  if (presetContainer) {
    presetContainer.innerHTML = `
      <div class="flex flex-wrap gap-1.5 text-xs">
        <button type="button" class="preset-btn px-2 py-1 bg-neutral-800 hover:bg-neutral-700 rounded text-neutral-300 font-mono transition" data-formula="CH1 - CH2">Diff: CH1 - CH2</button>
        <button type="button" class="preset-btn px-2 py-1 bg-neutral-800 hover:bg-neutral-700 rounded text-neutral-300 font-mono transition" data-formula="CH1 * CH2">Product: CH1 * CH2</button>
        <button type="button" class="preset-btn px-2 py-1 bg-neutral-800 hover:bg-neutral-700 rounded text-neutral-300 font-mono transition" data-formula="CH1 - mean(CH1)">Ripple: CH1 - mean</button>
        <button type="button" class="preset-btn px-2 py-1 bg-neutral-800 hover:bg-neutral-700 rounded text-neutral-300 font-mono transition" data-formula="deriv(CH1)">dV/dt: deriv(CH1)</button>
        <button type="button" class="preset-btn px-2 py-1 bg-neutral-800 hover:bg-neutral-700 rounded text-neutral-300 font-mono transition" data-formula="abs(CH1)">Rectify: abs(CH1)</button>
        <button type="button" class="preset-btn px-2 py-1 bg-neutral-800 hover:bg-neutral-700 rounded text-neutral-300 font-mono transition" data-formula="sqrt(CH1^2 + CH2^2)">Mag: sqrt(CH1^2+CH2^2)</button>
        <button type="button" class="preset-btn px-2 py-1 bg-neutral-800 hover:bg-neutral-700 rounded text-neutral-300 font-mono transition" data-formula="max(CH1) - min(CH1)">Vpp: max - min</button>
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
  // If user inserted "()", place cursor inside the parentheses
  if (text.endsWith('()')) {
    newPos -= 1;
  }
  input.setSelectionRange(newPos, newPos);
}

function openTransformModal(tab: TabState) {
  const modal = document.getElementById('transformModal');
  if (!modal) return;

  const uaSel = document.getElementById('clarkeUaSelect') as HTMLSelectElement;
  const ubSel = document.getElementById('clarkeUbSelect') as HTMLSelectElement;
  const ucSel = document.getElementById('clarkeUcSelect') as HTMLSelectElement;

  [uaSel, ubSel, ucSel].forEach((sel, i) => {
    sel.innerHTML = '';
    tab.drawOrder.forEach((id, chIdx) => {
      const ch = tab.channels[id];
      if (ch) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.innerText = ch.name;
        if (chIdx === i) opt.selected = true;
        sel.appendChild(opt);
      }
    });
  });

  modal.style.display = 'flex';
}

function openMotorModal(tab: TabState) {
  const modal = document.getElementById('motorModal');
  if (!modal) return;

  const rpmInput = document.getElementById('motorRpmInput') as HTMLInputElement;
  const polesInput = document.getElementById('motorPolesInput') as HTMLInputElement;
  const enableChk = document.getElementById('motorEnableChk') as HTMLInputElement;

  rpmInput.value = tab.motorConfig.rpm ? tab.motorConfig.rpm.toString() : '';
  polesInput.value = tab.motorConfig.polePairs ? tab.motorConfig.polePairs.toString() : '4';
  enableChk.checked = tab.motorConfig.enabled;

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
      <div class="p-2.5 rounded text-xs font-mono border ${
        r.passed ? 'bg-green-950/40 border-green-700/60 text-green-200' : 'bg-red-950/40 border-red-700/60 text-red-200'
      }">
        <div class="flex justify-between font-bold">
          <span>${r.name}</span>
          <span>${r.passed ? 'PASS ✓' : 'FAIL ✗'}</span>
        </div>
        <div class="text-[11px] text-neutral-400 mt-1">${r.message}</div>
      </div>
    `;
  });
  html += '</div>';

  listEl.innerHTML = html;
  modal.style.display = 'flex';
}

/**
 * Generates synthetic 3-Phase BLDC motor data for initial instant interactive inspection.
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
    // 3-phase sinusoidal voltages with 10% 5th harmonic and switching noise
    const v5th = 0.1 * Math.sin(5 * angle);
    ua[i] = 24.0 * Math.sin(angle) + v5th;
    ub[i] = 24.0 * Math.sin(angle - (2 * Math.PI) / 3) + v5th;
    uc[i] = 24.0 * Math.sin(angle + (2 * Math.PI) / 3) + v5th;
    ia[i] = 8.0 * Math.sin(angle - 0.2); // Current with power factor lag
  }

  const createChannel = (id: string, name: string, data: Float32Array, color: string, unit: string): WaveformChannel => ({
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
    vMin: -30,
    vMax: 30,
  });

  const channels: Record<string, WaveformChannel> = {
    ua: createChannel('ua', 'Ua (Phase A)', ua, OVERLAP_COLORS[0], 'V'),
    ub: createChannel('ub', 'Ub (Phase B)', ub, OVERLAP_COLORS[1], 'V'),
    uc: createChannel('uc', 'Uc (Phase C)', uc, OVERLAP_COLORS[2], 'V'),
    ia: createChannel('ia', 'Ia (Current)', ia, OVERLAP_COLORS[3], 'A'),
  };

  const tab: TabState = {
    id: `tab_synthetic_${Date.now()}`,
    fileName: 'BLDC_3Phase_Drive_Sample.csv',
    channels,
    drawOrder: ['ua', 'ub', 'uc', 'ia'],
    view: { startIndex: 0, endIndex: n },
    cursors: {
      enabled: true,
      x1: 0.01,
      x2: 0.015,
      y1: null,
      y2: null,
      trackingChannel: 'ua',
    },
    annotations: [],
    annotationMode: false,
    annotationsVisible: true,
    isOverlap: false,
    plotMode: 'time',
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
    separateView: false,
  };

  app.addTab(tab);
}
