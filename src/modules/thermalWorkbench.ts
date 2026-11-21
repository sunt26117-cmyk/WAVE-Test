/**
 * Waveform Viewer Pro - MOS Electro-Thermal & Dynamic SOA Workbench (Phase 1)
 * Orchestrates:
 *   Tab 1: Thermal Impedance Deconvolution, Structure Function & LTspice .subckt Validation
 *   Tab 2: Loss Stripping (Deskew + Eoss) & Closed-Loop Cauer Tj(t) Simulation
 *   Tab 3: Dynamic SOA Log-Log Trajectory & Fault Jump Audit
 *   Tab 4: BLDC FOC 6-MOS Thermal Preview (Phase 2)
 */

import { OscilloscopeApp } from '../engine/uiController';
import { formatEng, getTimeBoundsForView } from '../engine/canvasRenderer';
import { TabState, WaveformChannel } from '../types/models';
import { computeChannelMean, getChannelDisplayValue } from './oscilloscopeScale';
import { analyzeSamplingQuality } from './qualityCheck';
import {
  CauerStage,
  ThermalDeconvResult,
  ThermalInputMode,
  LossSimulationResult,
  deconvolveThermalImpedance,
  computeLossWithDeskewAndEoss,
  cauerToSpice,
  validateCauerSpiceNetlist,
} from './thermalEngine';
import {
  SoaCurveSet,
  SoaPulseKey,
  DynamicSoaResult,
  cloneSoaPreset,
  getAllSoaPresets,
  addOrUpdateCustomSoaPreset,
  deleteCustomSoaPreset,
  evaluateDynamicSoa,
} from './dynamicSoa';
import {
  MOS_SWITCH_KEYS,
  FocModulationMode,
  FocMosParams,
  FocControlParams,
  FocThermalModel,
  FocSimulationResult,
  FocStallSweepResult,
  FocControlSweepResult,
  splitCauerToFocModel,
  focModelToSpice,
  validateFocSpiceNetlist,
  simulateFoc6Mos,
  runFocStallSweep,
  runFocControlSweep,
} from './focThermal';

type WorkbenchTabKey = 'deconv' | 'loss' | 'soa' | 'foc';
type DeconvSubPlotKey = 'spectrum' | 'structure' | 'residual';
type FocCanvasMode = 'tj' | 'stall' | 'sweep';

const DEFAULT_FALLBACK_CAUER: CauerStage[] = [
  { r: 0.14, c: 0.0035, tauEst: 0.00049, layerLabel: '芯片/焊料 (<10ms)' },
  { r: 0.36, c: 0.045, tauEst: 0.0162, layerLabel: '封装/基板 (10ms~1s)' },
  { r: 0.72, c: 0.58, tauEst: 0.4176, layerLabel: 'PCB/散热器 (>1s)' },
];

function getChannelGateRange(tab: TabState, ch: WaveformChannel, gate: 'entire' | 'view' | 'cursors'): { tStart?: number; tEnd?: number } {
  if (gate === 'entire') return {};
  if (gate === 'cursors' && tab.cursors.enabled && tab.cursors.x1 !== null && tab.cursors.x2 !== null) {
    return {
      tStart: Math.min(tab.cursors.x1, tab.cursors.x2),
      tEnd: Math.max(tab.cursors.x1, tab.cursors.x2),
    };
  }
  const b = getTimeBoundsForView(tab, ch);
  return { tStart: b.tStart, tEnd: b.tEnd };
}

function getSliceMean(ch: WaveformChannel, tStart?: number, tEnd?: number): number {
  const n = Math.min(ch.t.length, ch.v.length);
  if (n === 0) return 0;
  const meanAc = ch.coupling === 'AC' ? computeChannelMean(ch) : 0;
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    const ti = ch.t[i];
    if (tStart !== undefined && ti < tStart) continue;
    if (tEnd !== undefined && ti > tEnd) break;
    const val = getChannelDisplayValue(ch, i, meanAc);
    if (isFinite(val)) {
      sum += val;
      cnt++;
    }
  }
  return cnt > 0 ? sum / cnt : 0;
}

function prepareHiDpiCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(240, Math.round(rect.width || canvas.clientWidth || 520));
  const h = Math.max(140, Math.round(rect.height || canvas.clientHeight || 220));
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.round(w * dpr);
  const targetH = Math.round(h * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

export class ThermalWorkbenchController {
  private app: OscilloscopeApp;
  private activeTab: WorkbenchTabKey = 'deconv';
  private timeScaleMode: 'lin' | 'log' = 'lin';
  private subPlotMode: DeconvSubPlotKey = 'spectrum';

  private lastDeconv: ThermalDeconvResult | null = null;
  private activeCauerStages: CauerStage[] = DEFAULT_FALLBACK_CAUER.map((s) => ({ ...s }));
  private cauerSourceLabel: string = 'Default 3-Stage MOSFET Fallback (1.22 °C/W)';
  private activeTambC: number = 25;

  private lastLossResult: LossSimulationResult | null = null;
  private allSoaPresets: SoaCurveSet[] = getAllSoaPresets();
  private soaCurveSet: SoaCurveSet = cloneSoaPreset(getAllSoaPresets()[0]);
  private soaEditCurveKey: SoaPulseKey = '1ms';
  private lastSoaResult: DynamicSoaResult | null = null;
  private lastSoaVdsChId: string = '';

  // Phase 2: BLDC FOC 6-MOS State
  private focCanvasMode: FocCanvasMode = 'tj';
  private lastFocSim: FocSimulationResult | null = null;
  private lastFocStall: FocStallSweepResult | null = null;
  private lastFocSweep: FocControlSweepResult | null = null;

  constructor(app: OscilloscopeApp) {
    this.app = app;
    this.bindEvents();
    this.populateSoaPresets();
    this.renderSoaBreakpointTable();
    this.updateCauerSummaryBox();
    this.refreshFocModelAndSpice();
  }

  public openModal(): void {
    const modal = document.getElementById('thermalModal');
    if (!modal) return;
    this.populateChannelSelectors();
    modal.style.display = 'flex';
    this.switchTab(this.activeTab);
    requestAnimationFrame(() => {
      this.redrawActivePlots();
    });
  }

  public closeModal(): void {
    const modal = document.getElementById('thermalModal');
    if (modal) modal.style.display = 'none';
  }

  public switchTab(next: WorkbenchTabKey): void {
    this.activeTab = next;
    const map: Array<[WorkbenchTabKey, string, string]> = [
      ['deconv', 'thermalTabDeconvBtn', 'thermalPanelDeconv'],
      ['loss', 'thermalTabLossBtn', 'thermalPanelLoss'],
      ['soa', 'thermalTabSoaBtn', 'thermalPanelSoa'],
      ['foc', 'thermalTabFocBtn', 'thermalPanelFoc'],
    ];
    for (const [key, btnId, panelId] of map) {
      const btn = document.getElementById(btnId);
      const panel = document.getElementById(panelId);
      if (btn) {
        btn.className =
          key === next
            ? 'px-3 py-1.5 rounded-sm bg-cyan-600 text-slate-950 font-semibold text-xs cursor-pointer whitespace-nowrap'
            : 'px-3 py-1.5 rounded-sm bg-[#0c0f13] hover:bg-[#1e2530] border border-[#222933] text-slate-300 text-xs cursor-pointer whitespace-nowrap';
      }
      if (panel) panel.classList.toggle('hidden', key !== next);
    }
    requestAnimationFrame(() => this.redrawActivePlots());
  }

  private redrawActivePlots(): void {
    if (this.activeTab === 'deconv') {
      this.drawDeconvMainCanvas();
      this.drawDeconvSubCanvas();
    } else if (this.activeTab === 'soa') {
      this.drawSoaCanvas();
    } else if (this.activeTab === 'foc') {
      this.drawFocCanvas();
    }
  }

  private populateChannelSelectors(): void {
    const tab = this.app.getActiveTab();
    const selIds = [
      'thermTempChSelect',
      'thermPowerChSelect',
      'thermLossVdsSelect',
      'thermLossIdsSelect',
      'thermSoaVdsSelect',
      'thermSoaIdsSelect',
      'focIaSelect',
      'focIbSelect',
      'focIcSelect',
      'focVbusSelect',
    ];
    if (!tab) {
      selIds.forEach((id) => {
        const el = document.getElementById(id) as HTMLSelectElement | null;
        if (el) el.innerHTML = '<option value="">No channel</option>';
      });
      return;
    }

    const chs = tab.drawOrder.map((id) => tab.channels[id]).filter(Boolean);
    const fill = (
      id: string,
      matcher: (ch: WaveformChannel) => boolean,
      fallbackIdx: number,
      extraOption?: { value: string; label: string }
    ) => {
      const el = document.getElementById(id) as HTMLSelectElement | null;
      if (!el) return;
      const prev = el.value;
      el.innerHTML = '';
      if (extraOption) {
        const ex = document.createElement('option');
        ex.value = extraOption.value;
        ex.text = extraOption.label;
        el.appendChild(ex);
      }
      chs.forEach((ch) => {
        const opt = document.createElement('option');
        opt.value = ch.id;
        opt.text = `${ch.name} (${ch.unit || 'V'})`;
        el.appendChild(opt);
      });
      if (prev && (prev === extraOption?.value || tab.channels[prev])) {
        el.value = prev;
      } else {
        const hit = chs.find(matcher);
        if (hit) el.value = hit.id;
        else if (extraOption) el.value = extraOption.value;
        else if (chs.length > 0) el.value = chs[Math.min(fallbackIdx, chs.length - 1)].id;
      }
    };

    fill('thermTempChSelect', (c) => /temp|tj|tsep|tc|th|°c|deg/i.test(`${c.name} ${c.unit}`), 0);
    fill('thermPowerChSelect', (c) => /p|pwr|power|watt|^w$/i.test(`${c.name} ${c.unit}`), 1);
    fill('thermLossVdsSelect', (c) => /vds|v_ds|u|v\(|^v$/i.test(`${c.name} ${c.unit}`), 0);
    fill('thermLossIdsSelect', (c) => /ids|i_ds|id|i\(|^a$/i.test(`${c.name} ${c.unit}`), 1);
    fill('thermSoaVdsSelect', (c) => /vds|v_ds|u|v\(|^v$/i.test(`${c.name} ${c.unit}`), 0);
    fill('thermSoaIdsSelect', (c) => /ids|i_ds|id|i\(|^a$/i.test(`${c.name} ${c.unit}`), 1);

    fill('focIaSelect', (c) => /\bia\b|i_a|phase.?a.*a/i.test(`${c.name} ${c.unit}`) || /^ia$/i.test(c.name), 0);
    fill('focIbSelect', (c) => /\bib\b|i_b|phase.?b.*a/i.test(`${c.name} ${c.unit}`) || /^ib$/i.test(c.name), 1);
    fill(
      'focIcSelect',
      (c) => /\bic\b|i_c|phase.?c.*a/i.test(`${c.name} ${c.unit}`) || /^ic$/i.test(c.name),
      2,
      { value: '__auto__', label: 'Auto: Ic = -(Ia + Ib)' }
    );
    fill(
      'focVbusSelect',
      (c) => /vbus|v_bus|vdc|v_dc|dc.?link/i.test(`${c.name} ${c.unit}`),
      3,
      { value: '__const__', label: 'Use Vbus Const (V)' }
    );
  }

  private bindEvents(): void {
    document.getElementById('thermCloseTopBtn')?.addEventListener('click', () => this.closeModal());
    document.getElementById('thermCloseBottomBtn')?.addEventListener('click', () => this.closeModal());

    // Tabs
    document.getElementById('thermalTabDeconvBtn')?.addEventListener('click', () => this.switchTab('deconv'));
    document.getElementById('thermalTabLossBtn')?.addEventListener('click', () => this.switchTab('loss'));
    document.getElementById('thermalTabSoaBtn')?.addEventListener('click', () => this.switchTab('soa'));
    document.getElementById('thermalTabFocBtn')?.addEventListener('click', () => this.switchTab('foc'));

    // Tab 1 controls
    document.getElementById('thermModeSelect')?.addEventListener('change', (e: any) => {
      const wrap = document.getElementById('thermTBlankWrap');
      if (wrap) wrap.classList.toggle('opacity-50', e.target.value !== 'cooling');
    });

    document.getElementById('thermReadPowerChBtn')?.addEventListener('click', () => {
      const tab = this.app.getActiveTab();
      const chId = (document.getElementById('thermPowerChSelect') as HTMLSelectElement)?.value;
      const ch = tab?.channels[chId];
      if (!tab || !ch) {
        this.app.showToast('Select a valid Power channel first.', 'warn');
        return;
      }
      const gate = ((document.getElementById('thermGateSelect') as HTMLSelectElement)?.value || 'entire') as
        | 'entire'
        | 'view'
        | 'cursors';
      const rng = getChannelGateRange(tab, ch, gate);
      const meanP = Math.abs(getSliceMean(ch, rng.tStart, rng.tEnd));
      const inp = document.getElementById('thermPowerWInput') as HTMLInputElement | null;
      if (inp) inp.value = (meanP > 0 ? meanP : 40).toFixed(3);
      this.app.showToast(`Power step set from "${ch.name}" mean = ${meanP.toFixed(3)} W`, 'info');
    });

    document.getElementById('thermUseCursorsBtn')?.addEventListener('click', () => {
      const tab = this.app.getActiveTab();
      const gateSel = document.getElementById('thermGateSelect') as HTMLSelectElement | null;
      if (!tab || !tab.cursors.enabled || tab.cursors.x1 === null || tab.cursors.x2 === null) {
        this.app.showToast('Enable X cursors on the scope first.', 'warn');
        return;
      }
      if (gateSel) gateSel.value = 'cursors';
      const xMin = Math.min(tab.cursors.x1, tab.cursors.x2);
      const xMax = Math.max(tab.cursors.x1, tab.cursors.x2);
      this.app.showToast(`Thermal gate locked to Cursors [${formatEng(xMin, 's', 3)} ~ ${formatEng(xMax, 's', 3)}]`, 'info');
    });

    document.getElementById('thermLoadDemoBtn')?.addEventListener('click', () => {
      this.loadThermalAndSwitchingDemoTab();
    });

    document.getElementById('thermRunDeconvBtn')?.addEventListener('click', () => {
      this.runDeconvolution();
    });

    document.getElementById('thermLinTimeBtn')?.addEventListener('click', () => {
      this.timeScaleMode = 'lin';
      this.syncPlotButtons();
      this.drawDeconvMainCanvas();
    });
    document.getElementById('thermLogTimeBtn')?.addEventListener('click', () => {
      this.timeScaleMode = 'log';
      this.syncPlotButtons();
      this.drawDeconvMainCanvas();
    });

    document.getElementById('thermSubSpecBtn')?.addEventListener('click', () => {
      this.subPlotMode = 'spectrum';
      this.syncPlotButtons();
      this.drawDeconvSubCanvas();
    });
    document.getElementById('thermSubStructBtn')?.addEventListener('click', () => {
      this.subPlotMode = 'structure';
      this.syncPlotButtons();
      this.drawDeconvSubCanvas();
    });
    document.getElementById('thermSubResidBtn')?.addEventListener('click', () => {
      this.subPlotMode = 'residual';
      this.syncPlotButtons();
      this.drawDeconvSubCanvas();
    });

    document.getElementById('thermCopySpiceBtn')?.addEventListener('click', async () => {
      const box = document.getElementById('thermSpiceTextarea') as HTMLTextAreaElement | null;
      if (!box || !box.value.trim()) {
        this.app.showToast('Run deconvolution first to generate SPICE .subckt.', 'warn');
        return;
      }
      try {
        await navigator.clipboard.writeText(box.value);
        this.app.showToast('Copied LTspice .subckt MOS_THERM to clipboard.', 'info');
      } catch {
        box.select();
        document.execCommand('copy');
        this.app.showToast('Copied LTspice .subckt to clipboard.', 'info');
      }
    });

    document.getElementById('thermDownloadSpiceBtn')?.addEventListener('click', () => {
      const box = document.getElementById('thermSpiceTextarea') as HTMLTextAreaElement | null;
      if (!box || !box.value.trim()) {
        this.app.showToast('Run deconvolution first to generate MOS_THERM.lib.', 'warn');
        return;
      }
      const blob = new Blob([box.value], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'MOS_THERM.lib';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.app.showToast('Downloaded MOS_THERM.lib for LTspice.', 'info');
    });

    document.getElementById('thermApplyToSimBtn')?.addEventListener('click', () => {
      if (!this.lastDeconv) {
        this.app.showToast('Run deconvolution first.', 'warn');
        return;
      }
      this.activeCauerStages = this.lastDeconv.reducedCauer.map((s) => ({ ...s }));
      this.activeTambC = this.lastDeconv.tBaseC;
      this.cauerSourceLabel = `Tab 1 Extracted (${this.activeCauerStages.length}-Stage, Rth=${this.lastDeconv.totalRthCauer.toFixed(3)} °C/W)`;
      const tambInp = document.getElementById('thermLossTambInput') as HTMLInputElement | null;
      if (tambInp && this.lastDeconv.mode === 'heating') {
        tambInp.value = this.lastDeconv.tBaseC.toFixed(1);
      }
      this.updateCauerSummaryBox();
      this.switchTab('loss');
      this.app.showToast('Applied Cauer RC ladder to Closed-Loop Tj(t) simulator.', 'info');
    });

    document.getElementById('thermInjectSmoothBtn')?.addEventListener('click', () => {
      if (!this.lastDeconv) {
        this.app.showToast('Run deconvolution first.', 'warn');
        return;
      }
      const chId = (document.getElementById('thermTempChSelect') as HTMLSelectElement)?.value;
      this.app.injectThermalTraces(
        [
          {
            replaceKey: 'fit_tj',
            name: `Fit Tj (${this.lastDeconv.reducedCauer.length}-RC)`,
            unit: '°C',
            t: this.lastDeconv.smoothAbsTime,
            values: this.lastDeconv.smoothTemp,
            color: '#22d3ee',
            badge: 'FIT',
            expr: `Cauer(${this.lastDeconv.reducedCauer.length}RC)`,
            sourceIds: chId ? [chId] : [],
            baseChannelId: chId,
          },
        ],
        {
          toastMessage: `Injected 12x monotone smooth thermal fit (${this.lastDeconv.smoothTemp.length} pts) to scope.`,
        }
      );
    });

    document.getElementById('thermTriggerWatchBtn')?.addEventListener('click', () => {
      document.getElementById('watchLtspiceBtn')?.click();
    });

    // Tab 2 controls
    const deskewSlider = document.getElementById('thermLossDeskewSlider') as HTMLInputElement | null;
    const deskewInput = document.getElementById('thermLossDeskewInput') as HTMLInputElement | null;
    deskewSlider?.addEventListener('input', () => {
      if (deskewInput) deskewInput.value = deskewSlider.value;
    });
    deskewInput?.addEventListener('input', () => {
      const val = parseFloat(deskewInput.value);
      if (deskewSlider && isFinite(val)) {
        deskewSlider.value = String(Math.max(-100, Math.min(100, val)));
      }
    });
    document.getElementById('thermRunLossBtn')?.addEventListener('click', () => {
      this.runLossAndTjSimulation();
    });

    // Tab 3 controls (Preset + Custom Device Add / Update / Delete)
    document.getElementById('thermSoaPresetSelect')?.addEventListener('change', (e: any) => {
      this.allSoaPresets = getAllSoaPresets();
      const preset = this.allSoaPresets.find((p) => p.id === e.target.value);
      if (preset) {
        this.soaCurveSet = cloneSoaPreset(preset);
        this.syncSoaDeviceFields();
        this.renderSoaBreakpointTable();
        this.drawSoaCanvas();
      }
    });
    document.getElementById('thermSoaSaveNewBtn')?.addEventListener('click', () => {
      this.saveCurrentSoaDeviceAsNew();
    });
    document.getElementById('thermSoaUpdateBtn')?.addEventListener('click', () => {
      this.updateSelectedSoaDevice();
    });
    document.getElementById('thermSoaDeleteBtn')?.addEventListener('click', () => {
      this.deleteSelectedSoaDevice();
    });
    document.getElementById('thermSoaVdsMaxInput')?.addEventListener('change', () => {
      const vMaxInp = document.getElementById('thermSoaVdsMaxInput') as HTMLInputElement | null;
      const val = parseFloat(vMaxInp?.value || '60');
      if (isFinite(val) && val > 0) {
        this.soaCurveSet.vdsMaxRated = val;
        this.drawSoaCanvas();
      }
    });
    document.getElementById('thermSoaEditCurveSelect')?.addEventListener('change', (e: any) => {
      this.soaEditCurveKey = e.target.value as SoaPulseKey;
      this.renderSoaBreakpointTable();
    });
    document.getElementById('thermSoaAddRowBtn')?.addEventListener('click', () => {
      const pts = this.soaCurveSet.curves[this.soaEditCurveKey];
      const last = pts[pts.length - 1] || { vds: 10, id: 10 };
      pts.push({ vds: Number((last.vds * 1.2).toFixed(2)), id: Number((last.id * 0.8).toFixed(2)) });
      this.renderSoaBreakpointTable();
    });
    document.getElementById('thermSoaApplyTableBtn')?.addEventListener('click', () => {
      this.readSoaBreakpointTable();
      this.runDynamicSoa();
    });
    document.getElementById('thermRunSoaBtn')?.addEventListener('click', () => {
      this.readSoaBreakpointTable();
      this.runDynamicSoa();
    });
    document.getElementById('thermSoaJumpBtn')?.addEventListener('click', () => {
      if (!this.lastSoaResult || this.lastSoaResult.worstIndex === null || !this.lastSoaVdsChId) {
        this.app.showToast('No violation or worst stress sample index available.', 'warn');
        return;
      }
      this.app.jumpToSampleIndex(this.lastSoaVdsChId, this.lastSoaResult.worstIndex);
      this.app.showToast(
        `Jumped to worst SOA point @ ${formatEng(this.lastSoaResult.worstTime || 0, 's', 4)} (Vds=${this.lastSoaResult.worstVds.toFixed(1)}V, Id=${this.lastSoaResult.worstId.toFixed(1)}A)`,
        this.lastSoaResult.pass ? 'info' : 'warn'
      );
    });

    // Tab 4 controls (BLDC FOC 6-MOS)
    document.getElementById('focLoadDemoBtn')?.addEventListener('click', () => this.loadFoc3PhDemoTab());
    document.getElementById('focRunSimBtn')?.addEventListener('click', () => this.runFocSimulation());
    document.getElementById('focInjectBtn')?.addEventListener('click', () => this.injectFocTracesToScope());
    document.getElementById('focRunSweepBtn')?.addEventListener('click', () => this.runFocControlSweepAnalysis());
    document.getElementById('focRunStallBtn')?.addEventListener('click', () => this.runFocStallAnalysis());
    document.getElementById('focTauSplitMsInput')?.addEventListener('change', () => this.refreshFocModelAndSpice());
    document.getElementById('focTambInput')?.addEventListener('change', () => this.refreshFocModelAndSpice());

    document.getElementById('focViewTjBtn')?.addEventListener('click', () => {
      this.focCanvasMode = 'tj';
      this.syncFocViewButtons();
      this.drawFocCanvas();
    });
    document.getElementById('focViewStallBtn')?.addEventListener('click', () => {
      this.focCanvasMode = 'stall';
      this.syncFocViewButtons();
      this.drawFocCanvas();
    });
    document.getElementById('focViewSweepBtn')?.addEventListener('click', () => {
      this.focCanvasMode = 'sweep';
      this.syncFocViewButtons();
      this.drawFocCanvas();
    });

    document.getElementById('focCopySpiceBtn')?.addEventListener('click', async () => {
      const box = document.getElementById('focSpiceTextarea') as HTMLTextAreaElement | null;
      if (!box || !box.value.trim()) return;
      try {
        await navigator.clipboard.writeText(box.value);
        this.app.showToast('Copied 7-port .subckt INV_6MOS_THERM to clipboard.', 'info');
      } catch {
        box.select();
        document.execCommand('copy');
        this.app.showToast('Copied INV_6MOS_THERM .subckt to clipboard.', 'info');
      }
    });
    document.getElementById('focDownloadSpiceBtn')?.addEventListener('click', () => {
      const box = document.getElementById('focSpiceTextarea') as HTMLTextAreaElement | null;
      if (!box || !box.value.trim()) return;
      const blob = new Blob([box.value], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'INV_6MOS_THERM.lib';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.app.showToast('Downloaded INV_6MOS_THERM.lib for LTspice.', 'info');
    });

    window.addEventListener('resize', () => {
      const modal = document.getElementById('thermalModal');
      if (modal && getComputedStyle(modal).display !== 'none') {
        this.redrawActivePlots();
      }
    });
  }

  private syncPlotButtons(): void {
    const activeCls = 'px-2 py-0.5 rounded-xs bg-cyan-600 text-slate-950 font-semibold text-[11px] cursor-pointer';
    const idleCls = 'px-2 py-0.5 rounded-xs text-slate-300 hover:text-white text-[11px] cursor-pointer';
    const linBtn = document.getElementById('thermLinTimeBtn');
    const logBtn = document.getElementById('thermLogTimeBtn');
    if (linBtn) linBtn.className = this.timeScaleMode === 'lin' ? activeCls : idleCls;
    if (logBtn) logBtn.className = this.timeScaleMode === 'log' ? activeCls : idleCls;

    const specBtn = document.getElementById('thermSubSpecBtn');
    const structBtn = document.getElementById('thermSubStructBtn');
    const residBtn = document.getElementById('thermSubResidBtn');
    if (specBtn) specBtn.className = this.subPlotMode === 'spectrum' ? activeCls : idleCls;
    if (structBtn) structBtn.className = this.subPlotMode === 'structure' ? activeCls : idleCls;
    if (residBtn) residBtn.className = this.subPlotMode === 'residual' ? activeCls : idleCls;
  }

  private runDeconvolution(): void {
    const tab = this.app.getActiveTab();
    const chId = (document.getElementById('thermTempChSelect') as HTMLSelectElement)?.value;
    const ch = tab?.channels[chId];
    if (!tab || !ch) {
      this.app.showToast('Please select a Temperature / TSEP channel.', 'warn');
      return;
    }

    const mode = ((document.getElementById('thermModeSelect') as HTMLSelectElement)?.value || 'heating') as ThermalInputMode;
    const powerW = parseFloat((document.getElementById('thermPowerWInput') as HTMLInputElement)?.value || '40');
    const gate = ((document.getElementById('thermGateSelect') as HTMLSelectElement)?.value || 'entire') as 'entire' | 'view' | 'cursors';
    const autoT0 = (document.getElementById('thermAutoT0Chk') as HTMLInputElement)?.checked ?? true;
    const tBlankMs = parseFloat((document.getElementById('thermTBlankMsInput') as HTMLInputElement)?.value || '0.15');
    const targetOrder = parseInt((document.getElementById('thermOrderSelect') as HTMLSelectElement)?.value || '4', 10);

    if (!isFinite(powerW) || powerW <= 0) {
      this.app.showToast('Power step ΔP (W) must be > 0.', 'error');
      return;
    }

    const rng = getChannelGateRange(tab, ch, gate);
    try {
      const meanAc = ch.coupling === 'AC' ? computeChannelMean(ch) : 0;
      const tempArr = new Float64Array(ch.v.length);
      for (let i = 0; i < ch.v.length; i++) {
        tempArr[i] = getChannelDisplayValue(ch, i, meanAc);
      }
      const res = deconvolveThermalImpedance(ch.t, tempArr, {
        mode,
        powerW,
        tStart: rng.tStart,
        tEnd: rng.tEnd,
        autoT0,
        tBlankSec: isFinite(tBlankMs) && tBlankMs >= 0 ? tBlankMs * 1e-3 : 0.15e-3,
        targetOrder,
      });

      this.lastDeconv = res;
      this.activeCauerStages = res.reducedCauer.map((s) => ({ ...s }));
      this.activeTambC = res.tBaseC;
      this.cauerSourceLabel = `Tab 1 Extracted (${res.reducedCauer.length}-Stage, Rth=${res.totalRthCauer.toFixed(3)} °C/W)`;
      this.updateCauerSummaryBox();
      this.renderDeconvMetricsAndTables(res);
      this.drawDeconvMainCanvas();
      this.drawDeconvSubCanvas();
      this.app.showToast(
        `Extracted ${res.reducedCauer.length}-stage Cauer RC (R²=${res.rSquared.toFixed(4)}, Rth=${res.totalRthCauer.toFixed(3)} °C/W)`,
        'info'
      );
    } catch (err: any) {
      this.app.showToast(`Thermal Deconvolution failed: ${err?.message || err}`, 'error');
    }
  }

  private renderDeconvMetricsAndTables(res: ThermalDeconvResult): void {
    const setText = (id: string, txt: string) => {
      const el = document.getElementById(id);
      if (el) el.innerText = txt;
    };
    setText('thermStatRth', `${res.totalRthCauer.toFixed(4)} °C/W`);
    setText('thermStatR2', res.rSquared.toFixed(5));
    setText('thermStatRmse', `${res.rmseC.toFixed(3)} °C`);
    setText('thermStatT0', `${formatEng(res.t0Sec, 's', 3)}`);
    setText('thermStatDt', `${formatEng(res.dtMedSec, 's', 2)} (${res.usedLogBinning ? 'Log-Bin' : 'Raw'})`);
    setText('thermStatLambda', `${res.selectedLambda.toExponential(1)}`);

    // Warnings banner
    const warnEl = document.getElementById('thermWarningsBox');
    if (warnEl) {
      if (res.warnings.length > 0) {
        warnEl.classList.remove('hidden');
        warnEl.innerText = res.warnings.join(' | ');
      } else {
        warnEl.classList.add('hidden');
        warnEl.innerText = '';
      }
    }

    // RC Stage Table
    const tbody = document.getElementById('thermRcTableBody');
    if (tbody) {
      tbody.innerHTML = '';
      for (let i = 0; i < res.reducedCauer.length; i++) {
        const f = res.reducedFoster[i];
        const c = res.reducedCauer[i];
        const tr = document.createElement('tr');
        tr.className = 'border-t border-[#222933] hover:bg-[#1a222d]/60';
        tr.innerHTML = `
          <td class="px-2 py-1 text-cyan-300 font-semibold">RC${i + 1}</td>
          <td class="px-2 py-1">${f ? f.r.toFixed(4) : '--'}</td>
          <td class="px-2 py-1">${f ? f.c.toExponential(2) : '--'}</td>
          <td class="px-2 py-1">${f ? formatEng(f.tau, 's', 2) : '--'}</td>
          <td class="px-2 py-1 text-emerald-300">${c.r.toFixed(4)}</td>
          <td class="px-2 py-1 text-emerald-300">${c.c.toExponential(2)}</td>
          <td class="px-2 py-1 text-slate-300 font-sans">${c.layerLabel}</td>
        `;
        tbody.appendChild(tr);
      }
    }

    // SPICE Box + Validation
    const spiceArea = document.getElementById('thermSpiceTextarea') as HTMLTextAreaElement | null;
    if (spiceArea) spiceArea.value = res.spiceNetlist;

    const badge = document.getElementById('thermSpiceValidBadge');
    const detail = document.getElementById('thermSpiceValidDetail');
    const v = res.spiceValidation;
    if (badge) {
      badge.innerText = v.valid ? 'SPICE VALIDATED' : 'NETLIST ERROR';
      badge.className = v.valid
        ? 'px-2 py-0.5 bg-emerald-950/70 border border-emerald-500/60 text-emerald-300 font-mono text-[10px] rounded-xs'
        : 'px-2 py-0.5 bg-red-950/70 border border-red-500/60 text-red-300 font-mono text-[10px] rounded-xs';
    }
    if (detail) {
      detail.innerText = v.valid
        ? `C1@TJ=${v.firstCapAtTJ} · Ck@Nk->0=${v.allCapsGroundedTo0} · NoTAMBShort=${v.noCapOnTamb} · Rn->TAMB=${v.finalResToTamb} · .ic=${v.hasDefensiveIc} · ΣR=${v.totalSpiceR.toFixed(4)}Ω`
        : v.errors.join('; ');
    }
  }

  private drawDeconvMainCanvas(): void {
    const canvas = document.getElementById('thermMainCanvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const prep = prepareHiDpiCanvas(canvas);
    if (!prep) return;
    const { ctx, w, h } = prep;

    ctx.fillStyle = '#07090e';
    ctx.fillRect(0, 0, w, h);

    const res = this.lastDeconv;
    if (!res || res.fitTimeRel.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '12px "IBM Plex Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Select Temperature/TSEP channel & click "Run Deconvolution"', w / 2, h / 2);
      return;
    }

    const pad = { l: 58, r: 16, t: 22, b: 28 };
    const pw = Math.max(20, w - pad.l - pad.r);
    const ph = Math.max(20, h - pad.t - pad.b);

    // Subtle grid
    ctx.strokeStyle = '#1b2330';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (ph * i) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + pw, y);
      ctx.stroke();
    }
    for (let i = 0; i <= 5; i++) {
      const x = pad.l + (pw * i) / 5;
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + ph);
      ctx.stroke();
    }
    ctx.strokeStyle = '#334155';
    ctx.strokeRect(pad.l, pad.t, pw, ph);

    if (this.timeScaleMode === 'lin') {
      // Linear Time: Plot Absolute Temperature T(t) (°C) with measured dots + 12x smooth curve
      const tAbsMeas = res.fitTimeRel;
      const tMin = res.smoothAbsTime[0];
      const tMax = res.smoothAbsTime[res.smoothAbsTime.length - 1];
      const tSpan = Math.max(1e-9, tMax - tMin);

      let yMin = Infinity;
      let yMax = -Infinity;
      for (let i = 0; i < res.fitTempMeasured.length; i++) {
        if (res.fitTempMeasured[i] < yMin) yMin = res.fitTempMeasured[i];
        if (res.fitTempMeasured[i] > yMax) yMax = res.fitTempMeasured[i];
      }
      for (let i = 0; i < res.smoothTemp.length; i++) {
        if (res.smoothTemp[i] < yMin) yMin = res.smoothTemp[i];
        if (res.smoothTemp[i] > yMax) yMax = res.smoothTemp[i];
      }
      const ySpan = Math.max(0.5, yMax - yMin);
      yMin -= ySpan * 0.08;
      yMax += ySpan * 0.08;
      const effYSpan = yMax - yMin;

      const xOf = (tAbs: number) => pad.l + ((tAbs - tMin) / tSpan) * pw;
      const yOf = (val: number) => pad.t + ph - ((val - yMin) / effYSpan) * ph;

      // t0 vertical marker
      if (res.t0Sec >= tMin && res.t0Sec <= tMax) {
        const xt0 = xOf(res.t0Sec);
        ctx.strokeStyle = 'rgba(251, 146, 60, 0.7)';
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(xt0, pad.t);
        ctx.lineTo(xt0, pad.t + ph);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Measured points (t0 + fitTimeRel)
      ctx.fillStyle = 'rgba(250, 204, 21, 0.8)';
      const step = Math.max(1, Math.floor(tAbsMeas.length / 400));
      for (let i = 0; i < tAbsMeas.length; i += step) {
        const px = xOf(res.t0Sec + tAbsMeas[i]);
        const py = yOf(res.fitTempMeasured[i]);
        ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
      }

      // 12x Smooth Fit Curve
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < res.smoothAbsTime.length; i++) {
        const px = xOf(res.smoothAbsTime[i]);
        const py = yOf(res.smoothTemp[i]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();

      // Axis labels
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      for (let i = 0; i <= 4; i++) {
        const val = yMax - ((yMax - yMin) * i) / 4;
        ctx.fillText(`${val.toFixed(1)}°C`, pad.l - 6, pad.t + (ph * i) / 4 + 3);
      }
      ctx.textAlign = 'center';
      for (let i = 0; i <= 5; i++) {
        const tVal = tMin + (tSpan * i) / 5;
        ctx.fillText(formatEng(tVal, 's', 2), pad.l + (pw * i) / 5, pad.t + ph + 16);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(`Lin-t: Measured (yellow) vs ${res.reducedCauer.length}-Stage Smooth Fit (cyan) · t0=${formatEng(res.t0Sec, 's', 2)}`, pad.l + 6, pad.t - 6);
    } else {
      // Log-t: Plot Zth(Δt) (°C/W) vs log10(t - t0)
      const pts: Array<{ dt: number; zMeas: number; zPred: number }> = [];
      for (let i = 0; i < res.fitTimeRel.length; i++) {
        if (res.fitTimeRel[i] > 0) {
          pts.push({
            dt: res.fitTimeRel[i],
            zMeas: res.fitZthMeasured[i],
            zPred: res.fitZthPredicted[i],
          });
        }
      }
      if (pts.length < 2) return;
      const lxMin = Math.log10(pts[0].dt);
      const lxMax = Math.log10(pts[pts.length - 1].dt);
      const lxSpan = Math.max(0.5, lxMax - lxMin);

      let yMax = 0.05;
      for (const p of pts) {
        if (p.zMeas > yMax) yMax = p.zMeas;
        if (p.zPred > yMax) yMax = p.zPred;
      }
      yMax *= 1.1;

      const xOf = (dt: number) => pad.l + ((Math.log10(dt) - lxMin) / lxSpan) * pw;
      const yOf = (z: number) => pad.t + ph - (Math.max(0, z) / yMax) * ph;

      ctx.fillStyle = 'rgba(250, 204, 21, 0.82)';
      for (const p of pts) {
        ctx.fillRect(xOf(p.dt) - 1.5, yOf(p.zMeas) - 1.5, 3, 3);
      }

      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 2;
      ctx.beginPath();
      pts.forEach((p, idx) => {
        const px = xOf(p.dt);
        const py = yOf(p.zPred);
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();

      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      for (let i = 0; i <= 4; i++) {
        const val = yMax * (1 - i / 4);
        ctx.fillText(`${val.toFixed(3)}`, pad.l - 6, pad.t + (ph * i) / 4 + 3);
      }
      ctx.textAlign = 'center';
      for (let i = 0; i <= 5; i++) {
        const lx = lxMin + (lxSpan * i) / 5;
        ctx.fillText(formatEng(Math.pow(10, lx), 's', 1), pad.l + (pw * i) / 5, pad.t + ph + 16);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(`Log-t: Zth(Δt) [°C/W] vs Δt (s)`, pad.l + 6, pad.t - 6);
    }
  }

  private drawDeconvSubCanvas(): void {
    const canvas = document.getElementById('thermSubCanvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const prep = prepareHiDpiCanvas(canvas);
    if (!prep) return;
    const { ctx, w, h } = prep;

    ctx.fillStyle = '#07090e';
    ctx.fillRect(0, 0, w, h);

    const res = this.lastDeconv;
    if (!res) {
      ctx.fillStyle = '#64748b';
      ctx.font = '11px "IBM Plex Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Run deconvolution to inspect τ spectrum, Structure Function, or Residuals', w / 2, h / 2);
      return;
    }

    const pad = { l: 58, r: 16, t: 20, b: 26 };
    const pw = Math.max(20, w - pad.l - pad.r);
    const ph = Math.max(20, h - pad.t - pad.b);

    ctx.strokeStyle = '#1b2330';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = pad.t + (ph * i) / 3;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + pw, y);
      ctx.stroke();
    }
    ctx.strokeStyle = '#334155';
    ctx.strokeRect(pad.l, pad.t, pw, ph);

    if (this.subPlotMode === 'spectrum') {
      const bins = res.sparseSpectrum;
      if (bins.length === 0) return;
      const ltMin = Math.log10(Math.max(1e-6, res.tauMinSec));
      const ltMax = Math.log10(Math.max(res.tauMinSec * 10, res.tauMaxSec));
      const ltSpan = Math.max(0.5, ltMax - ltMin);

      let maxR = 1e-4;
      for (const b of bins) if (b.r > maxR) maxR = b.r;
      for (const m of res.reducedFoster) if (m.r > maxR) maxR = m.r;
      maxR *= 1.15;

      const xOfTau = (tau: number) => pad.l + ((Math.log10(Math.max(1e-6, tau)) - ltMin) / ltSpan) * pw;
      const yOfR = (r: number) => pad.t + ph - (r / maxR) * ph;

      // Dense sparse LASSO bins
      ctx.fillStyle = 'rgba(56, 189, 248, 0.35)';
      for (const b of bins) {
        if (b.r <= 0) continue;
        const x = xOfTau(b.tau);
        const y = yOfR(b.r);
        ctx.fillRect(x - 2, y, 4, pad.t + ph - y);
      }

      // Reduced Foster poles highlighted
      res.reducedFoster.forEach((p, idx) => {
        const x = xOfTau(p.tau);
        const y = yOfR(p.r);
        ctx.strokeStyle = '#4ade80';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(x, pad.t + ph);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.fillStyle = '#4ade80';
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`τ${idx + 1}`, x, Math.max(pad.t + 10, y - 6));
      });

      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${maxR.toFixed(3)}`, pad.l - 6, pad.t + 8);
      ctx.fillText('0', pad.l - 6, pad.t + ph);
      ctx.textAlign = 'center';
      for (let i = 0; i <= 4; i++) {
        const lt = ltMin + (ltSpan * i) / 4;
        ctx.fillText(formatEng(Math.pow(10, lt), 's', 1), pad.l + (pw * i) / 4, pad.t + ph + 15);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(`Time-Constant Spectrum R(τ) [°C/W] · ${res.mergedPoles.length} merged -> ${res.reducedFoster.length} poles`, pad.l + 6, pad.t - 5);
    } else if (this.subPlotMode === 'structure') {
      const sf = res.structureFunction;
      if (sf.length === 0) return;
      const rMax = Math.max(1e-4, sf[sf.length - 1].rCum * 1.05);
      const lcMin = Math.log10(Math.max(1e-7, sf[0].cCum * 0.5));
      const lcMax = Math.log10(Math.max(1e-5, sf[sf.length - 1].cCum * 2));
      const lcSpan = Math.max(0.5, lcMax - lcMin);

      const xOf = (r: number) => pad.l + (r / rMax) * pw;
      const yOf = (c: number) => pad.t + ph - ((Math.log10(Math.max(1e-7, c)) - lcMin) / lcSpan) * ph;

      ctx.strokeStyle = '#a78bfa';
      ctx.lineWidth = 2;
      ctx.beginPath();
      sf.forEach((pt, idx) => {
        const px = xOf(pt.rCum);
        const py = yOf(pt.cCum);
        if (idx === 0) ctx.moveTo(pad.l, py);
        ctx.lineTo(px, py);
      });
      ctx.stroke();

      sf.forEach((pt, idx) => {
        const px = xOf(pt.rCum);
        const py = yOf(pt.cCum);
        ctx.fillStyle = '#facc15';
        ctx.beginPath();
        ctx.arc(px, py, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.fillStyle = '#cbd5e1';
        ctx.textAlign = idx === sf.length - 1 ? 'right' : 'left';
        ctx.fillText(`N${idx + 1}`, px + (idx === sf.length - 1 ? -4 : 4), Math.max(pad.t + 10, py - 5));
      });

      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`1e${Math.round(lcMax)}`, pad.l - 6, pad.t + 8);
      ctx.fillText(`1e${Math.round(lcMin)}`, pad.l - 6, pad.t + ph);
      ctx.textAlign = 'center';
      for (let i = 0; i <= 4; i++) {
        ctx.fillText(`${((rMax * i) / 4).toFixed(2)}`, pad.l + (pw * i) / 4, pad.t + ph + 15);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText('Cumulative Structure Function: log10(CΣ [J/°C]) vs RΣ [°C/W]', pad.l + 6, pad.t - 5);
    } else {
      // Residual
      const r = res.residualTemp;
      if (r.length < 2) return;
      let maxAbs = 0.05;
      for (let i = 0; i < r.length; i++) if (Math.abs(r[i]) > maxAbs) maxAbs = Math.abs(r[i]);
      maxAbs *= 1.15;

      const midY = pad.t + ph / 2;
      ctx.strokeStyle = 'rgba(148,163,184,0.35)';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(pad.l, midY);
      ctx.lineTo(pad.l + pw, midY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.strokeStyle = '#fb7185';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < r.length; i++) {
        const px = pad.l + (i / (r.length - 1)) * pw;
        const py = midY - (r[i] / maxAbs) * (ph / 2);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();

      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`+${maxAbs.toFixed(2)}°C`, pad.l - 6, pad.t + 8);
      ctx.fillText(`-${maxAbs.toFixed(2)}°C`, pad.l - 6, pad.t + ph);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(`Fit Residual (T_meas − T_pred) · RMSE = ${res.rmseC.toFixed(3)} °C`, pad.l + 6, pad.t - 5);
    }
  }

  private updateCauerSummaryBox(): void {
    const el = document.getElementById('thermLossCauerSummary');
    if (!el) return;
    const rTot = this.activeCauerStages.reduce((s, st) => s + st.r, 0);
    el.innerText = `${this.cauerSourceLabel} | Stages=${this.activeCauerStages.length} | Rth=${rTot.toFixed(4)} °C/W`;
  }

  private runLossAndTjSimulation(): void {
    const tab = this.app.getActiveTab();
    const vdsId = (document.getElementById('thermLossVdsSelect') as HTMLSelectElement)?.value;
    const idsId = (document.getElementById('thermLossIdsSelect') as HTMLSelectElement)?.value;
    const vdsCh = tab?.channels[vdsId];
    const idsCh = tab?.channels[idsId];
    if (!tab || !vdsCh || !idsCh) {
      this.app.showToast('Please select valid Vds and Ids channels.', 'warn');
      return;
    }

    const gate = ((document.getElementById('thermLossGateSelect') as HTMLSelectElement)?.value || 'view') as 'entire' | 'view' | 'cursors';
    const tAmbC = parseFloat((document.getElementById('thermLossTambInput') as HTMLInputElement)?.value || String(this.activeTambC));
    const deskewNs = parseFloat((document.getElementById('thermLossDeskewInput') as HTMLInputElement)?.value || '0');
    const eossUj = parseFloat((document.getElementById('thermLossEossInput') as HTMLInputElement)?.value || '12');
    const rdsOn25Mohm = parseFloat((document.getElementById('thermLossRdsInput') as HTMLInputElement)?.value || '4.5');
    const alphaPct = parseFloat((document.getElementById('thermLossAlphaInput') as HTMLInputElement)?.value || '0.45');

    const rng = getChannelGateRange(tab, vdsCh, gate);
    try {
      const res = computeLossWithDeskewAndEoss(vdsCh, idsCh, this.activeCauerStages, {
        deskewNs: isFinite(deskewNs) ? deskewNs : 0,
        eossUj: isFinite(eossUj) ? eossUj : 0,
        rdsOn25Mohm: isFinite(rdsOn25Mohm) && rdsOn25Mohm > 0 ? rdsOn25Mohm : 5,
        tempCoeffAlphaPerC: isFinite(alphaPct) ? alphaPct / 100 : 0.0045,
        tAmbC: isFinite(tAmbC) ? tAmbC : 25,
        tStart: rng.tStart,
        tEnd: rng.tEnd,
      });

      this.lastLossResult = res;
      const setText = (id: string, txt: string) => {
        const el = document.getElementById(id);
        if (el) el.innerText = txt;
      };
      setText('thermLossRawE', `${res.energyRawMj.toFixed(4)} mJ`);
      setText('thermLossDeskewE', `${res.energyDeskewedMj.toFixed(4)} mJ`);
      setText('thermLossStrippedE', `${res.energyStrippedMj.toFixed(4)} mJ`);
      setText('thermLossPmean', `${res.pLossMeanW.toFixed(3)} W`);
      setText('thermLossTjMax', `${res.tjMaxC.toFixed(2)} °C`);
      setText('thermLossDeltaTj', `${(res.tjMaxC - (isFinite(tAmbC) ? tAmbC : 25)).toFixed(2)} °C`);
      setText('thermLossSwCount', `${res.switchingEvents}`);

      this.app.injectThermalTraces(
        [
          {
            replaceKey: 'ploss',
            name: 'P_loss (Stripped)',
            unit: 'W',
            t: res.time,
            values: res.pLossW,
            color: '#fb923c',
            badge: 'LOSS',
            expr: `Deskew(${deskewNs}ns)-Eoss(${eossUj}uJ)`,
            sourceIds: [vdsId, idsId],
            baseChannelId: vdsId,
            pinMetrics: ['average'],
          },
          {
            replaceKey: 'tj_closed',
            name: 'Tj (Closed-Loop)',
            unit: '°C',
            t: res.time,
            values: res.tjC,
            color: '#f472b6',
            badge: 'TJ',
            expr: `Cauer(${this.activeCauerStages.length}RC)+Rds(Tj)`,
            sourceIds: [vdsId, idsId],
            baseChannelId: vdsId,
            pinMetrics: ['max'],
          },
        ],
        {
          separateView: true,
          toastMessage: `Injected P_loss & Tj(t) (Tj Max=${res.tjMaxC.toFixed(2)} °C, Pmean=${res.pLossMeanW.toFixed(2)} W) + pinned to Measurement Strip.`,
        }
      );
    } catch (err: any) {
      this.app.showToast(`Loss & Tj(t) simulation failed: ${err?.message || err}`, 'error');
    }
  }

  private populateSoaPresets(): void {
    const sel = document.getElementById('thermSoaPresetSelect') as HTMLSelectElement | null;
    if (!sel) return;
    this.allSoaPresets = getAllSoaPresets();
    sel.innerHTML = '';
    this.allSoaPresets.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.text = p.isCustom ? `[Custom] ${p.name}` : p.name;
      sel.appendChild(opt);
    });
    if (this.allSoaPresets.some((p) => p.id === this.soaCurveSet.id)) {
      sel.value = this.soaCurveSet.id;
    } else if (this.allSoaPresets.length > 0) {
      this.soaCurveSet = cloneSoaPreset(this.allSoaPresets[0]);
      sel.value = this.soaCurveSet.id;
    }
    this.syncSoaDeviceFields();
  }

  private syncSoaDeviceFields(): void {
    const nameInp = document.getElementById('thermSoaNameInput') as HTMLInputElement | null;
    const vMaxInp = document.getElementById('thermSoaVdsMaxInput') as HTMLInputElement | null;
    const delBtn = document.getElementById('thermSoaDeleteBtn') as HTMLButtonElement | null;
    if (nameInp) nameInp.value = this.soaCurveSet.name;
    if (vMaxInp) vMaxInp.value = String(this.soaCurveSet.vdsMaxRated);
    if (delBtn) delBtn.disabled = !this.soaCurveSet.isCustom;
  }

  private saveCurrentSoaDeviceAsNew(): void {
    this.readSoaBreakpointTable();
    const nameInp = document.getElementById('thermSoaNameInput') as HTMLInputElement | null;
    const vMaxInp = document.getElementById('thermSoaVdsMaxInput') as HTMLInputElement | null;
    const rawName = (nameInp?.value || '').trim();
    const vMax = parseFloat(vMaxInp?.value || String(this.soaCurveSet.vdsMaxRated));

    const newDevice: SoaCurveSet = {
      ...cloneSoaPreset(this.soaCurveSet),
      id: `custom_soa_${Date.now()}`,
      name:
        rawName && rawName !== this.soaCurveSet.name
          ? rawName
          : `${this.soaCurveSet.name.replace(/\s*\(Custom\)$/i, '')} (Custom)`,
      vdsMaxRated: isFinite(vMax) && vMax > 0 ? vMax : this.soaCurveSet.vdsMaxRated,
      isCustom: true,
    };

    const { saved } = addOrUpdateCustomSoaPreset(newDevice);
    this.soaCurveSet = cloneSoaPreset(saved);
    this.populateSoaPresets();
    this.renderSoaBreakpointTable();
    this.drawSoaCanvas();
    this.app.showToast(`Added custom SOA device "${saved.name}" (Vds_max=${saved.vdsMaxRated}V).`, 'info');
  }

  private updateSelectedSoaDevice(): void {
    this.readSoaBreakpointTable();
    const nameInp = document.getElementById('thermSoaNameInput') as HTMLInputElement | null;
    const vMaxInp = document.getElementById('thermSoaVdsMaxInput') as HTMLInputElement | null;
    const nextName = (nameInp?.value || '').trim() || this.soaCurveSet.name;
    const nextVmax = parseFloat(vMaxInp?.value || String(this.soaCurveSet.vdsMaxRated));

    this.soaCurveSet.name = nextName;
    if (isFinite(nextVmax) && nextVmax > 0) this.soaCurveSet.vdsMaxRated = nextVmax;

    const { saved } = addOrUpdateCustomSoaPreset({
      ...cloneSoaPreset(this.soaCurveSet),
      id: this.soaCurveSet.isCustom ? this.soaCurveSet.id : `custom_soa_${Date.now()}`,
    });
    this.soaCurveSet = cloneSoaPreset(saved);
    this.populateSoaPresets();
    this.renderSoaBreakpointTable();
    this.drawSoaCanvas();
    this.app.showToast(`Saved SOA curves for "${saved.name}".`, 'info');
  }

  private deleteSelectedSoaDevice(): void {
    if (!this.soaCurveSet.isCustom) {
      this.app.showToast('Built-in presets cannot be deleted; select a [Custom] device.', 'warn');
      return;
    }
    const deletedName = this.soaCurveSet.name;
    deleteCustomSoaPreset(this.soaCurveSet.id);
    this.allSoaPresets = getAllSoaPresets();
    this.soaCurveSet = cloneSoaPreset(this.allSoaPresets[0]);
    this.populateSoaPresets();
    this.renderSoaBreakpointTable();
    this.drawSoaCanvas();
    this.app.showToast(`Deleted custom SOA device "${deletedName}".`, 'info');
  }

  private renderSoaBreakpointTable(): void {
    const tbody = document.getElementById('thermSoaPointsBody');
    if (!tbody) return;
    const pts = this.soaCurveSet.curves[this.soaEditCurveKey] || [];
    tbody.innerHTML = '';
    pts.forEach((pt, idx) => {
      const tr = document.createElement('tr');
      tr.className = 'border-t border-[#222933]';
      tr.innerHTML = `
        <td class="px-1.5 py-1 text-slate-400">#${idx + 1}</td>
        <td class="px-1.5 py-1"><input type="number" step="any" data-soa-col="vds" data-idx="${idx}" value="${pt.vds}" class="w-full bg-[#0c0f13] border border-[#222933] rounded-xs px-1.5 py-0.5 text-slate-100 font-mono text-[11px]" /></td>
        <td class="px-1.5 py-1"><input type="number" step="any" data-soa-col="id" data-idx="${idx}" value="${pt.id}" class="w-full bg-[#0c0f13] border border-[#222933] rounded-xs px-1.5 py-0.5 text-slate-100 font-mono text-[11px]" /></td>
        <td class="px-1.5 py-1 text-center"><button type="button" data-soa-del="${idx}" class="text-slate-500 hover:text-red-300 px-1 cursor-pointer">×</button></td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('button[data-soa-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-soa-del') || '-1', 10);
        if (idx >= 0 && this.soaCurveSet.curves[this.soaEditCurveKey].length > 2) {
          this.soaCurveSet.curves[this.soaEditCurveKey].splice(idx, 1);
          this.renderSoaBreakpointTable();
        }
      });
    });
  }

  private readSoaBreakpointTable(): void {
    const tbody = document.getElementById('thermSoaPointsBody');
    if (!tbody) return;
    const vdsInputs = tbody.querySelectorAll('input[data-soa-col="vds"]') as NodeListOf<HTMLInputElement>;
    const idInputs = tbody.querySelectorAll('input[data-soa-col="id"]') as NodeListOf<HTMLInputElement>;
    const nextPts: Array<{ vds: number; id: number }> = [];
    for (let i = 0; i < vdsInputs.length; i++) {
      const v = parseFloat(vdsInputs[i].value);
      const id = parseFloat(idInputs[i]?.value || '0');
      if (isFinite(v) && v > 0 && isFinite(id) && id > 0) {
        nextPts.push({ vds: v, id });
      }
    }
    if (nextPts.length >= 2) {
      nextPts.sort((a, b) => a.vds - b.vds);
      this.soaCurveSet.curves[this.soaEditCurveKey] = nextPts;
    }
    const vMaxInp = document.getElementById('thermSoaVdsMaxInput') as HTMLInputElement | null;
    const vMaxVal = parseFloat(vMaxInp?.value || '');
    if (isFinite(vMaxVal) && vMaxVal > 0) {
      this.soaCurveSet.vdsMaxRated = vMaxVal;
    }
  }

  private runDynamicSoa(): void {
    const tab = this.app.getActiveTab();
    const vdsId = (document.getElementById('thermSoaVdsSelect') as HTMLSelectElement)?.value;
    const idsId = (document.getElementById('thermSoaIdsSelect') as HTMLSelectElement)?.value;
    const vdsCh = tab?.channels[vdsId];
    const idsCh = tab?.channels[idsId];
    if (!tab || !vdsCh || !idsCh) {
      this.app.showToast('Please select valid Vds and Ids channels for Dynamic SOA.', 'warn');
      return;
    }

    const gate = ((document.getElementById('thermSoaGateSelect') as HTMLSelectElement)?.value || 'view') as 'entire' | 'view' | 'cursors';
    const pulseMode = ((document.getElementById('thermSoaPulseSelect') as HTMLSelectElement)?.value || 'auto') as SoaPulseKey | 'auto';
    const rng = getChannelGateRange(tab, vdsCh, gate);

    const res = evaluateDynamicSoa(vdsCh, idsCh, this.soaCurveSet, {
      tStart: rng.tStart,
      tEnd: rng.tEnd,
      forcedPulseKey: pulseMode,
    });
    this.lastSoaResult = res;
    this.lastSoaVdsChId = vdsId;

    const statusBadge = document.getElementById('thermSoaStatusBadge');
    if (statusBadge) {
      statusBadge.innerText = res.pass ? 'SOA PASS' : `SOA FAIL (${res.violationCount} pts)`;
      statusBadge.className = res.pass
        ? 'px-2.5 py-0.5 bg-emerald-950/70 border border-emerald-500/60 text-emerald-300 font-mono text-xs font-semibold rounded-xs'
        : 'px-2.5 py-0.5 bg-red-950/80 border border-red-500/70 text-red-200 font-mono text-xs font-semibold rounded-xs';
    }
    const setText = (id: string, txt: string) => {
      const el = document.getElementById(id);
      if (el) el.innerText = txt;
    };
    setText('thermSoaMaxUtil', `${res.maxUtilizationPct.toFixed(1)}%`);
    setText('thermSoaMinMargin', `${res.minMarginPct.toFixed(1)}%`);
    setText(
      'thermSoaWorstPoint',
      res.worstTime !== null
        ? `Vds=${res.worstVds.toFixed(2)}V, Id=${res.worstId.toFixed(2)}A @ ${formatEng(res.worstTime, 's', 3)}`
        : '--'
    );

    const jumpBtn = document.getElementById('thermSoaJumpBtn') as HTMLButtonElement | null;
    if (jumpBtn) jumpBtn.disabled = res.worstIndex === null;

    this.drawSoaCanvas();
  }

  private drawSoaCanvas(): void {
    const canvas = document.getElementById('thermSoaCanvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const prep = prepareHiDpiCanvas(canvas);
    if (!prep) return;
    const { ctx, w, h } = prep;

    ctx.fillStyle = '#07090e';
    ctx.fillRect(0, 0, w, h);

    const pad = { l: 54, r: 18, t: 22, b: 30 };
    const pw = Math.max(20, w - pad.l - pad.r);
    const ph = Math.max(20, h - pad.t - pad.b);

    const lxMin = Math.log10(0.1);
    const lxMax = Math.log10(Math.max(150, this.soaCurveSet.vdsMaxRated * 1.5));
    const lyMin = Math.log10(0.5);
    const lyMax = Math.log10(1000);
    const xOf = (v: number) => pad.l + ((Math.log10(Math.max(0.1, v)) - lxMin) / (lxMax - lxMin)) * pw;
    const yOf = (id: number) => pad.t + ph - ((Math.log10(Math.max(0.5, id)) - lyMin) / (lyMax - lyMin)) * ph;

    // Log grid decades
    ctx.strokeStyle = '#1b2330';
    ctx.lineWidth = 1;
    [0.1, 1, 10, 100].forEach((d) => {
      const gx = xOf(d);
      if (gx >= pad.l && gx <= pad.l + pw) {
        ctx.beginPath();
        ctx.moveTo(gx, pad.t);
        ctx.lineTo(gx, pad.t + ph);
        ctx.stroke();
      }
    });
    [1, 10, 100, 1000].forEach((d) => {
      const gy = yOf(d);
      if (gy >= pad.t && gy <= pad.t + ph) {
        ctx.beginPath();
        ctx.moveTo(pad.l, gy);
        ctx.lineTo(pad.l + pw, gy);
        ctx.stroke();
      }
    });
    ctx.strokeStyle = '#334155';
    ctx.strokeRect(pad.l, pad.t, pw, ph);

    // Plot SOA boundary curves
    const curveStyles: Array<[SoaPulseKey, string]> = [
      ['10us', '#22d3ee'],
      ['100us', '#38bdf8'],
      ['1ms', '#4ade80'],
      ['10ms', '#facc15'],
      ['DC', '#fb923c'],
    ];

    curveStyles.forEach(([key, color]) => {
      const pts = this.soaCurveSet.curves[key];
      if (!pts || pts.length === 0) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = key === this.soaEditCurveKey ? 2.4 : 1.5;
      ctx.beginPath();
      pts.forEach((p, idx) => {
        const px = xOf(p.vds);
        const py = yOf(p.id);
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();

      const last = pts[pts.length - 1];
      ctx.fillStyle = color;
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(key, Math.min(pad.l + pw - 28, xOf(last.vds) + 3), Math.max(pad.t + 10, yOf(last.id)));
    });

    // BVDSS vertical line
    const xMaxV = xOf(this.soaCurveSet.vdsMaxRated);
    ctx.strokeStyle = 'rgba(248, 113, 113, 0.7)';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(xMaxV, pad.t);
    ctx.lineTo(xMaxV, pad.t + ph);
    ctx.stroke();
    ctx.setLineDash([]);

    // Operating trajectory
    if (this.lastSoaResult && this.lastSoaResult.trajectoryPoints.length > 0) {
      const traj = this.lastSoaResult.trajectoryPoints;
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.45)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      traj.forEach((p, idx) => {
        const px = xOf(Math.max(0.1, p.vds));
        const py = yOf(Math.max(0.5, p.id));
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();

      for (const p of traj) {
        const px = xOf(Math.max(0.1, p.vds));
        const py = yOf(Math.max(0.5, p.id));
        ctx.fillStyle = p.violated ? '#f43f5e' : 'rgba(34, 211, 238, 0.65)';
        ctx.fillRect(px - (p.violated ? 2.5 : 1.2), py - (p.violated ? 2.5 : 1.2), p.violated ? 5 : 2.4, p.violated ? 5 : 2.4);
      }

      if (this.lastSoaResult.worstTime !== null) {
        const wx = xOf(Math.max(0.1, this.lastSoaResult.worstVds));
        const wy = yOf(Math.max(0.5, this.lastSoaResult.worstId));
        ctx.strokeStyle = '#fb7185';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(wx, wy, 6, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    [0.1, 1, 10, 100].forEach((d) => {
      const gx = xOf(d);
      if (gx >= pad.l && gx <= pad.l + pw) ctx.fillText(`${d}V`, gx, pad.t + ph + 16);
    });
    ctx.textAlign = 'right';
    [1, 10, 100, 1000].forEach((d) => {
      const gy = yOf(d);
      if (gy >= pad.t && gy <= pad.t + ph) ctx.fillText(`${d}A`, pad.l - 6, gy + 3);
    });
    ctx.textAlign = 'left';
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(`Log-Log Dynamic SOA (${this.soaCurveSet.name})`, pad.l + 6, pad.t - 6);
  }

  private loadThermalAndSwitchingDemoTab(): void {
    // 4000 pts across 0..4s (dt=1ms) with step onset at t=0.2s, P=50W, 3-stage thermal step + switching Vds/Ids
    const n = 4000;
    const dt = 0.001;
    const fs = 1 / dt;
    const t = new Float64Array(n);
    const tj = new Float32Array(n);
    const pCh = new Float32Array(n);
    const vds = new Float32Array(n);
    const ids = new Float32Array(n);

    const rF = [0.18, 0.42, 0.85];
    const tauF = [0.008, 0.12, 1.1];
    const pStep = 50;
    const t0 = 0.2;

    for (let i = 0; i < n; i++) {
      const ti = i * dt;
      t[i] = ti;
      if (ti < t0) {
        tj[i] = 25 + 0.04 * Math.sin(i * 0.7);
        pCh[i] = 0;
      } else {
        const rel = ti - t0;
        let zth = 0;
        for (let k = 0; k < 3; k++) zth += rF[k] * (1 - Math.exp(-rel / tauF[k]));
        tj[i] = 25 + pStep * zth + 0.04 * Math.sin(i * 0.7);
        pCh[i] = pStep;
      }
      // Synthetic switching pulse burst inside waveform for Tab 2 & Tab 3 demo
      const cyc = i % 20;
      if (cyc < 10) {
        vds[i] = cyc === 0 ? 32 : 0.45;
        ids[i] = cyc === 0 ? 48 : 38;
      } else {
        vds[i] = cyc === 10 ? 54 : 48;
        ids[i] = cyc === 10 ? 18 : 0.02;
      }
    }

    const meta = analyzeSamplingQuality(t);
    const mkCh = (id: string, name: string, unit: string, color: string, v: Float32Array, vMin: number, vMax: number): WaveformChannel => ({
      id,
      name,
      unit,
      color,
      t,
      v,
      visible: true,
      vMin,
      vMax,
      coupling: 'DC',
      inverted: false,
      isMath: false,
      sourceChannelIds: [],
      fs,
      dt,
      metadata: meta,
    });

    const newTab: TabState = {
      id: `therm_demo_${Date.now()}`,
      fileName: 'Thermal_Step_&_MOS_Demo.csv',
      channels: {
        ch_tj: mkCh('ch_tj', 'Tj_Meas', '°C', '#facc15', tj, 20, 105),
        ch_p: mkCh('ch_p', 'P_Step', 'W', '#22d3ee', pCh, -5, 65),
        ch_vds: mkCh('ch_vds', 'Vds_SW', 'V', '#fb923c', vds, -5, 65),
        ch_ids: mkCh('ch_ids', 'Ids_SW', 'A', '#4ade80', ids, -5, 60),
      },
      drawOrder: ['ch_tj', 'ch_p', 'ch_vds', 'ch_ids'],
      activeChannelId: 'ch_tj',
      separateView: true,
      plotMode: 'time',
      view: { startIndex: 0, endIndex: n },
      cursors: { enabled: false, mode: 'off', x1: null, x2: null, y1: null, y2: null, trackingChannel: 'ch_tj' },
      measurementGate: 'view',
      selectedMeasurements: [],
      triggerConfig: { enabled: false, channelId: 'ch_tj', type: 'rising', level: 30, positionPercent: 10 },
      fftOptions: { window: 'hann', scale: 'db', range: 'view', removeDC: true, zeroPadding: 1 },
      motorConfig: { enabled: false, rpm: null, polePairs: null },
      annotations: [],
      annotationMode: false,
      annotationsVisible: true,
      isOverlap: false,
    };

    this.app.addTab(newTab);
    this.populateChannelSelectors();
    const pInp = document.getElementById('thermPowerWInput') as HTMLInputElement | null;
    if (pInp) pInp.value = '50';
    this.runDeconvolution();
  }

  // ==================== Phase 2: BLDC FOC 6-MOS Workbench Methods ====================

  private getActiveFocModel(): FocThermalModel {
    const tauSplitMs = parseFloat((document.getElementById('focTauSplitMsInput') as HTMLInputElement)?.value || '50');
    return splitCauerToFocModel(this.activeCauerStages, isFinite(tauSplitMs) && tauSplitMs > 0 ? tauSplitMs * 1e-3 : 0.05);
  }

  private readFocParams(): { mos: FocMosParams; ctrl: FocControlParams; model: FocThermalModel } {
    const num = (id: string, fallback: number) => {
      const v = parseFloat((document.getElementById(id) as HTMLInputElement)?.value || '');
      return isFinite(v) ? v : fallback;
    };
    const mod = ((document.getElementById('focModSelect') as HTMLSelectElement)?.value || 'SVPWM') as FocModulationMode;
    const mos: FocMosParams = {
      rdsOn25Mohm: Math.max(0.1, num('focRdsInput', 4.5)),
      tempCoeffAlphaPerC: num('focAlphaInput', 0.45) / 100,
      vsdV: Math.max(0, num('focVsdInput', 0.9)),
      eonPlusEoffUj: Math.max(0, num('focEswInput', 35)),
      qrrNc: Math.max(0, num('focQrrInput', 60)),
      vRefV: Math.max(1, num('focVrefInput', 48)),
      iRefA: Math.max(1, num('focIrefInput', 30)),
    };
    const ctrl: FocControlParams = {
      modulation: mod,
      fswHz: Math.max(100, num('focFswKhzInput', 20) * 1e3),
      tDeadNs: Math.max(0, num('focTdeadNsInput', 500)),
      modDepthM: Math.max(0, Math.min(1.15, num('focModDepthInput', 0.85))),
      pfAngleDeg: num('focPfAngleInput', 0),
      tAmbC: num('focTambInput', 25),
      vBusConstV: Math.max(1, num('focVbusConstInput', 48)),
    };
    return { mos, ctrl, model: this.getActiveFocModel() };
  }

  private refreshFocModelAndSpice(): void {
    const model = this.getActiveFocModel();
    const tAmb = parseFloat((document.getElementById('focTambInput') as HTMLInputElement)?.value || '25') || 25;
    const rJc = model.zthJC.reduce((s, c) => s + c.r, 0);
    const rBrd = model.zthBoard.reduce((s, c) => s + c.r, 0);

    const badgeEl = document.getElementById('focModelSummaryBadge');
    if (badgeEl) {
      badgeEl.innerText = `JC(${model.zthJC.length})=${rJc.toFixed(3)} + Brd(${model.zthBoard.length})=${rBrd.toFixed(3)} °C/W`;
    }

    const netlist = focModelToSpice(model, tAmb, 'INV_6MOS_THERM');
    const val = validateFocSpiceNetlist(netlist);
    const box = document.getElementById('focSpiceTextarea') as HTMLTextAreaElement | null;
    if (box) box.value = netlist;

    const spBadge = document.getElementById('focSpiceValidBadge');
    if (spBadge) {
      spBadge.innerText = val.valid ? '7-PORT VALIDATED' : 'NETLIST ERROR';
      spBadge.className = val.valid
        ? 'px-1.5 py-0.5 bg-emerald-950/70 border border-emerald-500/60 text-emerald-300 font-mono text-[10px] rounded-xs'
        : 'px-1.5 py-0.5 bg-red-950/70 border border-red-500/60 text-red-300 font-mono text-[10px] rounded-xs';
    }
  }

  private syncFocViewButtons(): void {
    const activeCls = 'px-2 py-0.5 rounded-xs bg-cyan-600 text-slate-950 font-semibold text-[11px] cursor-pointer';
    const idleCls = 'px-2 py-0.5 rounded-xs text-slate-300 hover:text-white text-[11px] cursor-pointer';
    const map: Array<[FocCanvasMode, string]> = [
      ['tj', 'focViewTjBtn'],
      ['stall', 'focViewStallBtn'],
      ['sweep', 'focViewSweepBtn'],
    ];
    for (const [m, id] of map) {
      const btn = document.getElementById(id);
      if (btn) btn.className = this.focCanvasMode === m ? activeCls : idleCls;
    }
  }

  private getFocSelectedChannels(): {
    tab: TabState;
    iaCh: WaveformChannel;
    ibCh: WaveformChannel;
    icCh: WaveformChannel | null;
    vbusCh: WaveformChannel | null;
    rng: { tStart?: number; tEnd?: number };
  } | null {
    const tab = this.app.getActiveTab();
    const iaId = (document.getElementById('focIaSelect') as HTMLSelectElement)?.value;
    const ibId = (document.getElementById('focIbSelect') as HTMLSelectElement)?.value;
    const icId = (document.getElementById('focIcSelect') as HTMLSelectElement)?.value;
    const vbusId = (document.getElementById('focVbusSelect') as HTMLSelectElement)?.value;
    const gate = ((document.getElementById('focGateSelect') as HTMLSelectElement)?.value || 'entire') as 'entire' | 'view' | 'cursors';
    const iaCh = tab?.channels[iaId];
    const ibCh = tab?.channels[ibId];
    if (!tab || !iaCh || !ibCh) return null;
    const icCh = icId && icId !== '__auto__' ? tab.channels[icId] || null : null;
    const vbusCh = vbusId && vbusId !== '__const__' ? tab.channels[vbusId] || null : null;
    const rng = getChannelGateRange(tab, iaCh, gate);
    return { tab, iaCh, ibCh, icCh, vbusCh, rng };
  }

  private runFocSimulation(): void {
    const sel = this.getFocSelectedChannels();
    if (!sel) {
      this.app.showToast('Please select Ia & Ib phase current channels (or click Load FOC 3-Ph Demo).', 'warn');
      return;
    }
    try {
      this.refreshFocModelAndSpice();
      const { mos, ctrl, model } = this.readFocParams();
      const res = simulateFoc6Mos(sel.iaCh, sel.ibCh, model, mos, ctrl, {
        tStart: sel.rng.tStart,
        tEnd: sel.rng.tEnd,
        icCh: sel.icCh,
        vbusCh: sel.vbusCh,
      });
      this.lastFocSim = res;
      this.focCanvasMode = 'tj';
      this.syncFocViewButtons();

      const hotEl = document.getElementById('focKpiHottest');
      if (hotEl) hotEl.innerText = `${res.hottestKey}: ${res.tjMaxGlobalC.toFixed(2)} °C`;
      const pwrEl = document.getElementById('focKpiPower');
      if (pwrEl) pwrEl.innerText = `${res.pInvMeanW.toFixed(2)} W / ${res.tBoardFinalC.toFixed(1)} °C`;

      const tbody = document.getElementById('focSwitchTableBody');
      if (tbody) {
        tbody.innerHTML = '';
        res.summaries.forEach((s) => {
          const isHot = s.key === res.hottestKey;
          const tr = document.createElement('tr');
          tr.className = `border-t border-[#222933] ${isHot ? 'bg-rose-950/25' : ''}`;
          tr.innerHTML = `
            <td class="px-2 py-1 font-semibold ${isHot ? 'text-rose-300' : 'text-cyan-300'}">${s.key}${isHot ? ' ★' : ''}</td>
            <td class="px-2 py-1">${s.tjAvgC.toFixed(2)} °C</td>
            <td class="px-2 py-1 text-pink-300">${s.tjPeakC.toFixed(2)} °C</td>
            <td class="px-2 py-1">${s.tjRippleC.toFixed(2)} °C</td>
            <td class="px-2 py-1 text-amber-300">${s.pAvgW.toFixed(2)} W</td>
            <td class="px-2 py-1">${s.pCondAvgW.toFixed(2)} W</td>
            <td class="px-2 py-1">${s.pSwAvgW.toFixed(2)} W</td>
            <td class="px-2 py-1">${s.pDeadAvgW.toFixed(2)} W</td>
          `;
          tbody.appendChild(tr);
        });
      }

      this.drawFocCanvas();
      this.app.showToast(
        `6-MOS FOC evaluation done (${ctrl.modulation}): hottest ${res.hottestKey} = ${res.tjMaxGlobalC.toFixed(2)} °C, P_inv = ${res.pInvMeanW.toFixed(2)} W`,
        'info'
      );
    } catch (err: any) {
      this.app.showToast(`FOC 6-MOS simulation failed: ${err?.message || err}`, 'error');
    }
  }

  private injectFocTracesToScope(): void {
    if (!this.lastFocSim) {
      this.runFocSimulation();
      if (!this.lastFocSim) return;
    }
    const sim = this.lastFocSim;
    const iaId = (document.getElementById('focIaSelect') as HTMLSelectElement)?.value;
    const colors = ['#f472b6', '#fb7185', '#22d3ee', '#38bdf8', '#4ade80', '#facc15'];
    const specs = MOS_SWITCH_KEYS.map((key, idx) => ({
      replaceKey: `foc_tj_${key.toLowerCase()}`,
      name: `Tj_${key}`,
      unit: '°C',
      t: sim.time,
      values: sim.tj[key],
      color: colors[idx],
      badge: 'FOC',
      expr: `6MOS(${key})`,
      sourceIds: iaId ? [iaId] : [],
      baseChannelId: iaId,
      pinMetrics: key === sim.hottestKey ? (['max'] as Array<'max' | 'average'>) : undefined,
    }));
    specs.push({
      replaceKey: 'foc_pinv_total',
      name: 'P_inv_total',
      unit: 'W',
      t: sim.time,
      values: sim.pInvTotal,
      color: '#fb923c',
      badge: 'INV',
      expr: 'Sum(P_Q1..Q6)',
      sourceIds: iaId ? [iaId] : [],
      baseChannelId: iaId,
      pinMetrics: ['average'],
    });
    this.app.injectThermalTraces(specs as any, {
      separateView: true,
      toastMessage: `Injected Tj_AH..Tj_CL & P_inv_total (${sim.hottestKey} Peak=${sim.tjMaxGlobalC.toFixed(2)} °C) to scope.`,
    });
  }

  private runFocStallAnalysis(): void {
    this.refreshFocModelAndSpice();
    const { mos, ctrl, model } = this.readFocParams();
    const iPeakA = Math.max(0.5, parseFloat((document.getElementById('focStallIpkInput') as HTMLInputElement)?.value || '35'));
    const tjLimitC = Math.max(40, parseFloat((document.getElementById('focStallLimitInput') as HTMLInputElement)?.value || '150'));

    const res = runFocStallSweep({
      iPeakA,
      tjLimitC,
      tAmbC: ctrl.tAmbC,
      modulation: ctrl.modulation,
      modDepthM: ctrl.modDepthM,
      fswHz: ctrl.fswHz,
      tDeadNs: ctrl.tDeadNs,
      mos,
      model,
      vBusV: ctrl.vBusConstV,
      horizonSec: 120,
    });
    this.lastFocStall = res;
    this.focCanvasMode = 'stall';
    this.syncFocViewButtons();

    const angEl = document.getElementById('focKpiStallAngle');
    if (angEl) angEl.innerText = `${res.worstAngleDeg}° (${res.worstSwitch}: ${res.worstSteadyTjC.toFixed(1)}°C)`;
    const safeEl = document.getElementById('focKpiStallSafe');
    if (safeEl) {
      safeEl.innerText = res.steadySafe
        ? `SAFE (Steady ≤ ${tjLimitC}°C)`
        : res.tSafeSec !== null
        ? `t_safe=${res.tSafeSec.toFixed(2)}s · I²t=${res.i2tThresholdA2s?.toFixed(0)} A²s`
        : `EXCEEDS >120s`;
      safeEl.className = res.steadySafe ? 'text-emerald-300 font-semibold' : 'text-rose-300 font-semibold';
    }

    this.drawFocCanvas();
    this.app.showToast(
      `Stall Sweep: Worst ${res.worstSwitch} @ θ=${res.worstAngleDeg}° (Steady=${res.worstSteadyTjC.toFixed(1)}°C${res.tSafeSec ? `, t_safe=${res.tSafeSec.toFixed(2)}s` : ''})`,
      res.steadySafe ? 'info' : 'warn'
    );
  }

  private runFocControlSweepAnalysis(): void {
    const sel = this.getFocSelectedChannels();
    if (!sel) {
      this.app.showToast('Please select Ia & Ib channels first (or Load FOC 3-Ph Demo).', 'warn');
      return;
    }
    this.refreshFocModelAndSpice();
    const { mos, ctrl, model } = this.readFocParams();
    const res = runFocControlSweep(sel.iaCh, sel.ibCh, model, mos, ctrl, {
      tStart: sel.rng.tStart,
      tEnd: sel.rng.tEnd,
      icCh: sel.icCh,
      vbusCh: sel.vbusCh,
    });
    this.lastFocSweep = res;
    this.focCanvasMode = 'sweep';
    this.syncFocViewButtons();
    this.drawFocCanvas();

    const pSave = res.svpwm.pInvMeanW - res.dpwm1.pInvMeanW;
    this.app.showToast(
      `SVPWM (${res.svpwm.pInvMeanW.toFixed(2)}W, ${res.svpwm.tjMaxGlobalC.toFixed(2)}°C) vs DPWM1 (${res.dpwm1.pInvMeanW.toFixed(2)}W, ${res.dpwm1.tjMaxGlobalC.toFixed(2)}°C) -> Saves ${pSave.toFixed(2)} W`,
      'info'
    );
  }

  private drawFocCanvas(): void {
    const canvas = document.getElementById('focMainCanvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const prep = prepareHiDpiCanvas(canvas);
    if (!prep) return;
    const { ctx, w, h } = prep;
    ctx.fillStyle = '#07090e';
    ctx.fillRect(0, 0, w, h);

    const pad = { l: 54, r: 18, t: 22, b: 28 };
    const pw = Math.max(20, w - pad.l - pad.r);
    const ph = Math.max(20, h - pad.t - pad.b);

    const drawGrid = () => {
      ctx.strokeStyle = '#1b2330';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = pad.t + (ph * i) / 4;
        ctx.beginPath();
        ctx.moveTo(pad.l, y);
        ctx.lineTo(pad.l + pw, y);
        ctx.stroke();
      }
      for (let i = 0; i <= 5; i++) {
        const x = pad.l + (pw * i) / 5;
        ctx.beginPath();
        ctx.moveTo(x, pad.t);
        ctx.lineTo(x, pad.t + ph);
        ctx.stroke();
      }
      ctx.strokeStyle = '#334155';
      ctx.strokeRect(pad.l, pad.t, pw, ph);
    };

    const titleEl = document.getElementById('focCanvasTitle');

    if (this.focCanvasMode === 'tj') {
      if (titleEl) titleEl.innerText = '6-MOS Coupled Junction Temperature Tj(t)';
      const sim = this.lastFocSim;
      if (!sim || sim.time.length < 2) {
        ctx.fillStyle = '#64748b';
        ctx.font = '12px "IBM Plex Sans", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Click "Load FOC 3-Ph Demo" or "Run 6-MOS Coupled Tj(t)"', w / 2, h / 2);
        return;
      }
      drawGrid();
      const t0 = sim.time[0];
      const tSpan = Math.max(1e-9, sim.time[sim.time.length - 1] - t0);
      let yMin = Infinity;
      let yMax = -Infinity;
      for (const k of MOS_SWITCH_KEYS) {
        const arr = sim.tj[k];
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] < yMin) yMin = arr[i];
          if (arr[i] > yMax) yMax = arr[i];
        }
      }
      for (let i = 0; i < sim.tBoard.length; i++) {
        if (sim.tBoard[i] < yMin) yMin = sim.tBoard[i];
      }
      const ys = Math.max(0.5, yMax - yMin);
      yMin -= ys * 0.08;
      yMax += ys * 0.1;

      const xOf = (t: number) => pad.l + ((t - t0) / tSpan) * pw;
      const yOf = (v: number) => pad.t + ph - ((v - yMin) / (yMax - yMin)) * ph;

      // T_board dashed
      ctx.strokeStyle = '#94a3b8';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      const step = Math.max(1, Math.floor(sim.time.length / 400));
      for (let i = 0; i < sim.time.length; i += step) {
        const px = xOf(sim.time[i]);
        const py = yOf(sim.tBoard[i]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      const colors = ['#f472b6', '#fb7185', '#22d3ee', '#38bdf8', '#4ade80', '#facc15'];
      MOS_SWITCH_KEYS.forEach((key, idx) => {
        ctx.strokeStyle = colors[idx];
        ctx.lineWidth = key === sim.hottestKey ? 2.2 : 1.3;
        ctx.beginPath();
        const arr = sim.tj[key];
        for (let i = 0; i < sim.time.length; i += step) {
          const px = xOf(sim.time[i]);
          const py = yOf(arr[i]);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      });

      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      for (let i = 0; i <= 4; i++) {
        const val = yMax - ((yMax - yMin) * i) / 4;
        ctx.fillText(`${val.toFixed(1)}°C`, pad.l - 6, pad.t + (ph * i) / 4 + 3);
      }
      ctx.textAlign = 'center';
      for (let i = 0; i <= 5; i++) {
        ctx.fillText(formatEng(t0 + (tSpan * i) / 5, 's', 2), pad.l + (pw * i) / 5, pad.t + ph + 15);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(`6-MOS Tj(t) + T_board (dashed) · Peak ${sim.hottestKey}=${sim.tjMaxGlobalC.toFixed(2)}°C`, pad.l + 6, pad.t - 6);
    } else if (this.focCanvasMode === 'stall') {
      if (titleEl) titleEl.innerText = 'Locked-Rotor Steady Max Tj vs Electrical Angle (0°..360°)';
      const st = this.lastFocStall;
      if (!st || st.anglesDeg.length === 0) {
        ctx.fillStyle = '#64748b';
        ctx.font = '12px "IBM Plex Sans", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Click "Run Stall Sweep & I²t Protection" to inspect 0°..360° thermal hotspots', w / 2, h / 2);
        return;
      }
      drawGrid();
      const tjLimit = parseFloat((document.getElementById('focStallLimitInput') as HTMLInputElement)?.value || '150') || 150;
      let yMin = Math.min(...st.steadyMaxTjPerAngle);
      let yMax = Math.max(tjLimit * 1.05, ...st.steadyMaxTjPerAngle);
      const ys = Math.max(5, yMax - yMin);
      yMin -= ys * 0.08;
      yMax += ys * 0.08;

      const xOf = (deg: number) => pad.l + (deg / 360) * pw;
      const yOf = (v: number) => pad.t + ph - ((v - yMin) / (yMax - yMin)) * ph;

      // Tj_limit line
      if (tjLimit >= yMin && tjLimit <= yMax) {
        ctx.strokeStyle = 'rgba(248, 113, 113, 0.8)';
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(pad.l, yOf(tjLimit));
        ctx.lineTo(pad.l + pw, yOf(tjLimit));
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.strokeStyle = '#fb923c';
      ctx.lineWidth = 2;
      ctx.beginPath();
      st.anglesDeg.forEach((deg, idx) => {
        const px = xOf(deg);
        const py = yOf(st.steadyMaxTjPerAngle[idx]);
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();

      // Highlight worst angle
      ctx.fillStyle = '#f43f5e';
      ctx.beginPath();
      ctx.arc(xOf(st.worstAngleDeg), yOf(st.worstSteadyTjC), 5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      for (let i = 0; i <= 4; i++) {
        ctx.fillText(`${(yMax - ((yMax - yMin) * i) / 4).toFixed(0)}°C`, pad.l - 6, pad.t + (ph * i) / 4 + 3);
      }
      ctx.textAlign = 'center';
      for (let deg = 0; deg <= 360; deg += 60) {
        ctx.fillText(`${deg}°`, xOf(deg), pad.t + ph + 15);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(`Worst: ${st.worstSwitch} @ θ=${st.worstAngleDeg}° (${st.worstSteadyTjC.toFixed(1)}°C steady, ${st.phaseSquaredRatioAtWorst.toFixed(2)}× Irms²)`, pad.l + 6, pad.t - 6);
    } else {
      if (titleEl) titleEl.innerText = 'Carrier Frequency Trade-off: SVPWM vs DPWM1 Total Loss (W)';
      const sw = this.lastFocSweep;
      if (!sw || sw.fswListHz.length === 0) {
        ctx.fillStyle = '#64748b';
        ctx.font = '12px "IBM Plex Sans", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Click "SVPWM vs DPWM1 扫频" to compare carrier frequency loss curves', w / 2, h / 2);
        return;
      }
      drawGrid();
      const fMin = sw.fswListHz[0];
      const fMax = sw.fswListHz[sw.fswListHz.length - 1];
      const allP = [...sw.pMeanSvpwmByFsw, ...sw.pMeanDpwm1ByFsw];
      const yMin = Math.min(...allP) * 0.9;
      const yMax = Math.max(...allP) * 1.1;

      const xOf = (f: number) => pad.l + ((f - fMin) / Math.max(1, fMax - fMin)) * pw;
      const yOf = (p: number) => pad.t + ph - ((p - yMin) / Math.max(1e-3, yMax - yMin)) * ph;

      const drawSeries = (vals: number[], color: string) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        sw.fswListHz.forEach((f, idx) => {
          const px = xOf(f);
          const py = yOf(vals[idx]);
          if (idx === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
        sw.fswListHz.forEach((f, idx) => {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(xOf(f), yOf(vals[idx]), 3, 0, Math.PI * 2);
          ctx.fill();
        });
      };

      drawSeries(sw.pMeanSvpwmByFsw, '#22d3ee');
      drawSeries(sw.pMeanDpwm1ByFsw, '#4ade80');

      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      for (let i = 0; i <= 4; i++) {
        ctx.fillText(`${(yMax - ((yMax - yMin) * i) / 4).toFixed(1)}W`, pad.l - 6, pad.t + (ph * i) / 4 + 3);
      }
      ctx.textAlign = 'center';
      sw.fswListHz.forEach((f) => ctx.fillText(`${(f / 1000).toFixed(0)}k`, xOf(f), pad.t + ph + 15));
      ctx.textAlign = 'left';
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText('SVPWM (cyan) vs DPWM1 60°-Clamp (green) Inverter Total Loss [W] vs f_sw (Hz)', pad.l + 6, pad.t - 6);
    }
  }

  private loadFoc3PhDemoTab(): void {
    // 3000 pts across 0..0.15s (50us step, 20 kS/s) -> 30 electrical cycles at 200 Hz, 30 A peak, 48 V Vbus
    const n = 3000;
    const dt = 5e-5;
    const fs = 1 / dt;
    const t = new Float64Array(n);
    const ia = new Float32Array(n);
    const ib = new Float32Array(n);
    const ic = new Float32Array(n);
    const vbus = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const ti = i * dt;
      t[i] = ti;
      const th = 2 * Math.PI * 200 * ti;
      ia[i] = 30 * Math.cos(th);
      ib[i] = 30 * Math.cos(th - (2 * Math.PI) / 3);
      ic[i] = 30 * Math.cos(th + (2 * Math.PI) / 3);
      vbus[i] = 48 + 0.6 * Math.sin(6 * th);
    }

    const meta = analyzeSamplingQuality(t);
    const mkCh = (id: string, name: string, unit: string, color: string, v: Float32Array, vMin: number, vMax: number): WaveformChannel => ({
      id,
      name,
      unit,
      color,
      t,
      v,
      visible: true,
      vMin,
      vMax,
      coupling: 'DC',
      inverted: false,
      isMath: false,
      sourceChannelIds: [],
      fs,
      dt,
      metadata: meta,
    });

    const newTab: TabState = {
      id: `foc_demo_${Date.now()}`,
      fileName: 'BLDC_FOC_3Ph_48V_30A_Demo.csv',
      channels: {
        ch_ia: mkCh('ch_ia', 'Ia', 'A', '#facc15', ia, -40, 40),
        ch_ib: mkCh('ch_ib', 'Ib', 'A', '#22d3ee', ib, -40, 40),
        ch_ic: mkCh('ch_ic', 'Ic', 'A', '#4ade80', ic, -40, 40),
        ch_vbus: mkCh('ch_vbus', 'Vbus', 'V', '#fb923c', vbus, 0, 60),
      },
      drawOrder: ['ch_ia', 'ch_ib', 'ch_ic', 'ch_vbus'],
      activeChannelId: 'ch_ia',
      separateView: true,
      plotMode: 'time',
      view: { startIndex: 0, endIndex: n },
      cursors: { enabled: false, mode: 'off', x1: null, x2: null, y1: null, y2: null, trackingChannel: 'ch_ia' },
      measurementGate: 'view',
      selectedMeasurements: [],
      triggerConfig: { enabled: false, channelId: 'ch_ia', type: 'rising', level: 0, positionPercent: 10 },
      fftOptions: { window: 'hann', scale: 'db', range: 'view', removeDC: true, zeroPadding: 1 },
      motorConfig: { enabled: false, rpm: 3000, polePairs: 4 },
      annotations: [],
      annotationMode: false,
      annotationsVisible: true,
      isOverlap: false,
    };

    this.app.addTab(newTab);
    this.populateChannelSelectors();
    this.runFocSimulation();
  }
}

export function initThermalWorkbench(app: OscilloscopeApp): ThermalWorkbenchController {
  const ctrl = new ThermalWorkbenchController(app);
  document.getElementById('openThermalModalBtn')?.addEventListener('click', () => ctrl.openModal());
  document.getElementById('openThermalAnalyzeBtn')?.addEventListener('click', () => ctrl.openModal());
  return ctrl;
}

export { cauerToSpice, validateCauerSpiceNetlist };
