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
import { escapeHtml } from '../utils/html';
import {
  CauerStage,
  ThermalDeconvResult,
  ThermalInputMode,
  ThermalPathMode,
  LossSimulationResult,
  ViPowerResult,
  deconvolveThermalImpedance,
  detectThermalStepOnset,
  computePowerFromVISources,
  parseSiUnitScale,
  validateTemperatureChannel,
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
  DEFAULT_FOC_MODEL,
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
import {
  DptAnalysisResult,
  DptOperatingPoint,
  analyzeDoublePulseTest,
  generateDptDemoChannels,
  interpolateDptSwitchingLoss,
} from './dptAnalyzer';
import { FocThermalHandoffPayload } from './focDyno/scopeBridge';

type WorkbenchTabKey = 'deconv' | 'loss' | 'soa' | 'foc' | 'dpt';
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

function getSliceAbsTrapezoidalMean(ch: WaveformChannel, tStart?: number, tEnd?: number): number {
  const n = Math.min(ch.t.length, ch.v.length);
  if (n === 0) return 0;
  const meanAc = ch.coupling === 'AC' ? computeChannelMean(ch) : 0;
  let absEnergy = 0;
  let dur = 0;
  let fallbackSum = 0;
  let fallbackCnt = 0;
  let prevT: number | null = null;
  let prevV: number | null = null;

  for (let i = 0; i < n; i++) {
    const ti = ch.t[i];
    if (tStart !== undefined && ti < tStart) continue;
    if (tEnd !== undefined && ti > tEnd) break;
    const val = getChannelDisplayValue(ch, i, meanAc);
    if (!isFinite(val) || !isFinite(ti)) {
      prevT = null;
      prevV = null;
      continue;
    }
    fallbackSum += Math.abs(val);
    fallbackCnt++;
    if (prevT !== null && prevV !== null) {
      const dt = ti - prevT;
      if (dt > 0) {
        if ((prevV >= 0 && val >= 0) || (prevV <= 0 && val <= 0)) {
          absEnergy += 0.5 * (Math.abs(prevV) + Math.abs(val)) * dt;
        } else {
          const a0 = Math.abs(prevV);
          const a1 = Math.abs(val);
          const denom = a0 + a1;
          const frac = denom > 1e-18 ? a0 / denom : 0.5;
          absEnergy += 0.5 * a0 * (dt * frac) + 0.5 * a1 * (dt * (1 - frac));
        }
        dur += dt;
      }
    }
    prevT = ti;
    prevV = val;
  }

  if (dur > 0) return absEnergy / dur;
  return fallbackCnt > 0 ? fallbackSum / fallbackCnt : 0;
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
  private activePathMode: ThermalPathMode = 'junction_ambient';
  private cauerSourceLabel: string = 'Default 3-Stage MOSFET Fallback (1.22 °C/W)';
  private focModelSource: 'fallback_default' | 'default_demo' | 'tab1_extracted' = 'fallback_default';
  private activeTambC: number = 25;

  private lastLossResult: LossSimulationResult | null = null;
  private lastViPowerResult: ViPowerResult | null = null;
  private userSetPathMode: boolean = false;
  private userSetPowerMode: boolean = false;
  private lastActiveTabId: string | null = null;
  private allSoaPresets: SoaCurveSet[] = getAllSoaPresets();
  private soaCurveSet: SoaCurveSet = cloneSoaPreset(getAllSoaPresets()[0]);
  private soaEditCurveKey: SoaPulseKey = '1ms';
  private lastSoaResult: DynamicSoaResult | null = null;
  private lastSoaVdsChId: string = '';

  // Phase 2: BLDC FOC 6-MOS State
  private focCanvasMode: FocCanvasMode = 'tj';
  private lastFocSim: FocSimulationResult | null = null;
  private lastFocSimFingerprint: string | null = null;
  private lastFocStall: FocStallSweepResult | null = null;
  private lastFocSweep: FocControlSweepResult | null = null;
  private activeFocHandoffNote: string | null = null;

  // P1: DPT State
  private lastDptResult: DptAnalysisResult | null = null;
  private dptMatrix: DptOperatingPoint[] = [];
  private useDptMatrixInFoc: boolean = false;

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
    const activeTab = this.app.getActiveTab();
    const tabChanged = Boolean(activeTab && activeTab.id !== this.lastActiveTabId);
    if (tabChanged && activeTab) {
      this.lastActiveTabId = activeTab.id;
      this.userSetPathMode = false;
      this.userSetPowerMode = false;
      this.invalidateFocCaches(true);
    }
    this.populateChannelSelectors();
    if (this.lastFocSim && this.lastFocSimFingerprint !== this.computeFocInputFingerprint()) {
      this.invalidateFocCaches(true);
    }
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
      ['dpt', 'thermalTabDptBtn', 'thermalPanelDpt'],
    ];
    for (const [key, btnId, panelId] of map) {
      const btn = document.getElementById(btnId);
      const panel = document.getElementById(panelId);
      if (btn) {
        btn.className =
          key === next
            ? 'py-1.5 px-2 rounded-sm bg-cyan-600 text-slate-950 font-semibold text-xs cursor-pointer truncate'
            : 'py-1.5 px-2 rounded-sm text-slate-300 hover:text-white text-xs cursor-pointer truncate';
      }
      if (panel) panel.classList.toggle('hidden', key !== next);
    }
    requestAnimationFrame(() => this.redrawActivePlots());
  }

  private redrawActivePlots(): void {
    if (this.activeTab === 'deconv') {
      this.drawDeconvMainCanvas();
      this.drawDeconvSubCanvas();
    } else if (this.activeTab === 'loss') {
      this.drawLossPreviewCanvas();
    } else if (this.activeTab === 'soa') {
      this.drawSoaCanvas();
    } else if (this.activeTab === 'foc') {
      this.drawFocCanvas();
    } else if (this.activeTab === 'dpt') {
      this.drawDptCanvas();
    }
  }

  private populateChannelSelectors(): void {
    const tab = this.app.getActiveTab();
    const selIds = [
      'thermTempChSelect',
      'thermPowerChSelect',
      'thermVoltChSelect',
      'thermCurrChSelect',
      'thermLossVdsSelect',
      'thermLossIdsSelect',
      'thermSoaVdsSelect',
      'thermSoaIdsSelect',
      'focIaSelect',
      'focIbSelect',
      'focIcSelect',
      'focVbusSelect',
      'focDaSelect',
      'focDbSelect',
      'focDcSelect',
      'dptVgsSelect',
      'dptVdsSelect',
      'dptIdsSelect',
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

    const isTempCh = (c: WaveformChannel) => /temp|tj|tsep|t_pcb|tpcb|t_pad|tpad|pcb|pad|ntc|tc|th|°c|deg/i.test(`${c.name} ${c.unit}`);
    const isPowerCh = (c: WaveformChannel) =>
      /\b(pwr|power|p_mos|pmos|ploss|p_loss|watt)\b|^w$|mw$|kw$/i.test(`${c.name} ${c.unit}`.trim()) && !isTempCh(c);
    const isVoltCh = (c: WaveformChannel) =>
      (/vds|v_ds|vin|vbus|v_mos|vmos|vgs|volt|^v|mv$|uv$|kv$/i.test(`${c.name} ${c.unit}`.trim()) ||
        /^v$/i.test((c.unit || '').trim())) &&
      !isTempCh(c) &&
      !isPowerCh(c);
    const isCurrCh = (c: WaveformChannel) =>
      (/ids|i_ds|i_mos|imos|idrain|curr|^i_|ma$|ua$|ka$/i.test(`${c.name} ${c.unit}`.trim()) ||
        /^a$/i.test((c.unit || '').trim())) &&
      !isTempCh(c) &&
      !isPowerCh(c);

    fill('thermTempChSelect', isTempCh, 0);
    fill('thermPowerChSelect', isPowerCh, Math.min(1, Math.max(0, chs.length - 1)));
    fill('thermVoltChSelect', isVoltCh, 0, { value: '__const__', label: '恒定值 Const (V)' });
    fill('thermCurrChSelect', isCurrCh, Math.min(1, Math.max(0, chs.length - 1)), {
      value: '__const__',
      label: '恒定值 Const (A)',
    });
    fill('thermLossVdsSelect', isVoltCh, 0);
    fill('thermLossIdsSelect', isCurrCh, 1);
    fill('thermSoaVdsSelect', isVoltCh, 0);
    fill('thermSoaIdsSelect', isCurrCh, 1);

    fill('dptVgsSelect', (c) => /vgs|v_gs|gate/i.test(`${c.name}`), 0);
    fill('dptVdsSelect', (c) => /vds|v_ds|drain/i.test(`${c.name}`) || isVoltCh(c), Math.min(1, Math.max(0, chs.length - 1)));
    fill('dptIdsSelect', (c) => /ids|i_ds|idrain/i.test(`${c.name}`) || isCurrCh(c), Math.min(2, Math.max(0, chs.length - 1)));

    fill(
      'focIaSelect',
      (c) => !isTempCh(c) && (/\bia\b|i_a|phase.?a/i.test(`${c.name} ${c.unit}`) || /^ia$/i.test(c.name)),
      -1,
      { value: '', label: '-- 请选择相电流 Ia (A/mA) --' }
    );
    const selectedIaId = (document.getElementById('focIaSelect') as HTMLSelectElement | null)?.value || '';
    fill(
      'focIbSelect',
      (c) =>
        c.id !== selectedIaId &&
        !isTempCh(c) &&
        (/\bib\b|i_b|phase.?b/i.test(`${c.name} ${c.unit}`) || /^ib$/i.test(c.name)),
      -1,
      { value: '', label: '-- 请选择相电流 Ib (A/mA) --' }
    );
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
    fill(
      'focDaSelect',
      (c) => /(?:duty|pwm)[\s_-]*(?:a|u)(?:$|[\s_(\[])|^d_?(?:a|u)(?:$|[\s_(\[])/i.test(c.name.trim()),
      -1,
      { value: '__auto__', label: 'Auto: 无传感器重构' }
    );
    fill(
      'focDbSelect',
      (c) => /(?:duty|pwm)[\s_-]*(?:b|v)(?:$|[\s_(\[])|^d_?(?:b|v)(?:$|[\s_(\[])/i.test(c.name.trim()),
      -1,
      { value: '__auto__', label: 'Auto: 无传感器重构' }
    );
    fill(
      'focDcSelect',
      (c) => /(?:duty|pwm)[\s_-]*(?:c|w)(?:$|[\s_(\[])|^d_?(?:c|w)(?:$|[\s_(\[])/i.test(c.name.trim()),
      -1,
      { value: '__auto__', label: 'Auto: 无传感器重构' }
    );

    // Smart auto-detection of Thermal Path (PCB/Pad vs Junction) & Power Source (Auto V*I vs Power Ch)
    if (!this.userSetPathMode) {
      const tSel = document.getElementById('thermTempChSelect') as HTMLSelectElement | null;
      const tCh = tSel?.value ? tab.channels[tSel.value] : undefined;
      const pathSel = document.getElementById('thermPathModeSelect') as HTMLSelectElement | null;
      if (tCh && pathSel) {
        const looksLikePadOrPcb = /pcb|pad|board|ntc|case|tc|surf|焊盘|板温/i.test(`${tCh.name}`);
        pathSel.value = looksLikePadOrPcb ? 'pad_ambient' : 'junction_ambient';
      }
    }
    this.syncThermalPathUI();

    if (!this.userSetPowerMode) {
      const hasPower = chs.some(isPowerCh);
      const hasV = chs.some(isVoltCh);
      const hasI = chs.some(isCurrCh);
      const pModeSel = document.getElementById('thermPowerModeSelect') as HTMLSelectElement | null;
      if (pModeSel) {
        if ((hasV || hasI) && !hasPower) pModeSel.value = 'auto_vi';
        else if (hasPower) pModeSel.value = 'power_ch';
        else if (hasV || hasI) pModeSel.value = 'auto_vi';
        else pModeSel.value = 'manual';
      }
    }
    this.syncPowerSourceUI(true);
  }

  private syncThermalPathUI(): void {
    const pathMode = ((document.getElementById('thermPathModeSelect') as HTMLSelectElement)?.value || 'junction_ambient') as ThermalPathMode;
    const spreadWrap = document.getElementById('thermPadSpreadWrap');
    const spreadInp = document.getElementById('thermPadSpreadInput') as HTMLInputElement | null;
    if (spreadWrap) spreadWrap.classList.toggle('opacity-50', pathMode !== 'pad_ambient');
    if (spreadInp) spreadInp.disabled = pathMode !== 'pad_ambient';

    const rthLabel = document.getElementById('thermStatRthLabel');
    const spiceTitle = document.getElementById('thermSpiceTitle');
    if (rthLabel && !this.lastDeconv) {
      rthLabel.innerText = pathMode === 'pad_ambient' ? 'Rth,pad-a (焊盘→环境)' : 'Rth Total';
    }
    if (spiceTitle && !this.lastDeconv) {
      spiceTitle.innerText =
        pathMode === 'pad_ambient' ? 'LTspice .subckt PAD_THERM (PAD → TAMB)' : 'LTspice .subckt MOS_THERM';
    }
  }

  private syncLossPathLabels(pathMode: ThermalPathMode): void {
    const isPad = pathMode === 'pad_ambient';
    const maxLbl = document.getElementById('thermLossTjMaxLabel');
    const deltaLbl = document.getElementById('thermLossDeltaTjLabel');
    const titleEl = document.getElementById('thermLossPlotTitle');
    const legendEl = document.getElementById('thermLossTjLegend');
    if (maxLbl) maxLbl.innerText = isPad ? 'Tpad Max (Equiv)' : 'Tj Max';
    if (deltaLbl) deltaLbl.innerText = isPad ? 'ΔTpad Peak' : 'ΔTj Peak';
    if (titleEl) {
      titleEl.innerText = isPad
        ? 'Stripped Switching Power P_loss(t) & Pad-Equivalent Temp Tpad(t)'
        : 'Stripped Switching Power P_loss(t) & Closed-Loop Junction Temp Tj(t)';
    }
    if (legendEl) legendEl.innerText = isPad ? '■ Tpad (°C)' : '■ Tj (°C)';
  }

  private syncConstViInputsUI(): void {
    const vSel = (document.getElementById('thermVoltChSelect') as HTMLSelectElement | null)?.value;
    const iSel = (document.getElementById('thermCurrChSelect') as HTMLSelectElement | null)?.value;
    const vConstWrap = document.getElementById('thermConstVoltWrap');
    const iConstWrap = document.getElementById('thermConstCurrWrap');
    vConstWrap?.classList.toggle('hidden', vSel !== '__const__');
    iConstWrap?.classList.toggle('hidden', iSel !== '__const__');
  }

  private syncPowerSourceUI(autoCompute: boolean = false): void {
    const mode = (document.getElementById('thermPowerModeSelect') as HTMLSelectElement)?.value || 'auto_vi';
    const viVoltWrap = document.getElementById('thermViVoltWrap');
    const viCurrWrap = document.getElementById('thermViCurrWrap');
    const pwrChWrap = document.getElementById('thermPowerChWrap');
    const calcViBtn = document.getElementById('thermCalcViPowerBtn');
    const readPBtn = document.getElementById('thermReadPowerChBtn');
    const injectPBtn = document.getElementById('thermInjectViPowerBtn');
    const metaEl = document.getElementById('thermViPowerMeta');
    const powerInp = document.getElementById('thermPowerWInput') as HTMLInputElement | null;

    const isVi = mode === 'auto_vi';
    const isPwrCh = mode === 'power_ch';
    viVoltWrap?.classList.toggle('hidden', !isVi);
    viCurrWrap?.classList.toggle('hidden', !isVi);
    pwrChWrap?.classList.toggle('hidden', !isPwrCh);
    calcViBtn?.classList.toggle('hidden', !isVi);
    injectPBtn?.classList.toggle('hidden', !isVi);
    readPBtn?.classList.toggle('hidden', !isPwrCh);
    if (powerInp) powerInp.readOnly = false;
    this.syncConstViInputsUI();

    if (autoCompute) {
      if (isVi) {
        this.computeAndApplyViPower(false);
      } else if (isPwrCh) {
        this.readAndApplyPowerChannel(false);
      } else if (metaEl) {
        metaEl.innerText = 'Manual ΔP: 直接在 Step Power ΔP (W) 输入阶跃热功率。';
      }
    }
  }

  private getDetectedStepOnsetTime(tab: TabState): number | undefined {
    const autoT0 = (document.getElementById('thermAutoT0Chk') as HTMLInputElement)?.checked ?? true;
    if (!autoT0) return undefined;
    const tId = (document.getElementById('thermTempChSelect') as HTMLSelectElement)?.value;
    const tCh = tab.channels[tId];
    if (!tCh || tCh.t.length < 6) return undefined;
    const gate = ((document.getElementById('thermGateSelect') as HTMLSelectElement)?.value || 'entire') as 'entire' | 'view' | 'cursors';
    const rng = getChannelGateRange(tab, tCh, gate);
    const meanAc = tCh.coupling === 'AC' ? computeChannelMean(tCh) : 0;
    const tArr: number[] = [];
    const yArr: number[] = [];
    const n = Math.min(tCh.t.length, tCh.v.length);
    for (let i = 0; i < n; i++) {
      const ti = tCh.t[i];
      if (rng.tStart !== undefined && ti < rng.tStart) continue;
      if (rng.tEnd !== undefined && ti > rng.tEnd) break;
      tArr.push(ti);
      yArr.push(getChannelDisplayValue(tCh, i, meanAc));
    }
    if (tArr.length < 6) return undefined;
    const mode = ((document.getElementById('thermModeSelect') as HTMLSelectElement)?.value || 'heating') as ThermalInputMode;
    const onset = detectThermalStepOnset(Float64Array.from(tArr), Float64Array.from(yArr), mode);
    return onset.onsetIdx > 0 ? onset.t0 : undefined;
  }

  private computeAndApplyViPower(showToast: boolean = true): ViPowerResult | null {
    const tab = this.app.getActiveTab();
    const vId = (document.getElementById('thermVoltChSelect') as HTMLSelectElement)?.value;
    const iId = (document.getElementById('thermCurrChSelect') as HTMLSelectElement)?.value;
    const vIsConst = vId === '__const__';
    const iIsConst = iId === '__const__';
    const vCh = !vIsConst && tab ? tab.channels[vId] || null : null;
    const iCh = !iIsConst && tab ? tab.channels[iId] || null : null;
    const vConstVal = parseFloat((document.getElementById('thermConstVoltInput') as HTMLInputElement)?.value || '');
    const iConstVal = parseFloat((document.getElementById('thermConstCurrInput') as HTMLInputElement)?.value || '');

    const metaEl = document.getElementById('thermViPowerMeta');
    if (!tab) {
      if (metaEl) metaEl.innerText = 'Auto V×I: 请先加载波形文件。';
      if (showToast) this.app.showToast('Load a capture tab first.', 'warn');
      return null;
    }
    if ((!vIsConst && !vCh) || (!iIsConst && !iCh)) {
      if (metaEl) metaEl.innerText = 'Auto V×I: 请选择有效的电压/电流波形或切换到恒定值 (Const)。';
      if (showToast) this.app.showToast('Select valid V / I channels or switch to Const.', 'warn');
      return null;
    }
    if ((vIsConst && !isFinite(vConstVal)) || (iIsConst && !isFinite(iConstVal))) {
      if (metaEl) metaEl.innerText = 'Auto V×I: 恒定电压/电流数值无效。';
      if (showToast) this.app.showToast('Enter a finite constant Voltage/Current value.', 'warn');
      return null;
    }

    const tId = (document.getElementById('thermTempChSelect') as HTMLSelectElement)?.value;
    const gateRefCh = vCh || iCh || (tId ? tab.channels[tId] : undefined);
    const gate = ((document.getElementById('thermGateSelect') as HTMLSelectElement)?.value || 'entire') as 'entire' | 'view' | 'cursors';
    const rng = gateRefCh ? getChannelGateRange(tab, gateRefCh, gate) : {};
    const stepOnset = this.getDetectedStepOnsetTime(tab);
    try {
      const res = computePowerFromVISources(
        vIsConst ? { constantValue: vConstVal } : { channel: vCh },
        iIsConst ? { constantValue: iConstVal } : { channel: iCh },
        {
          tStart: rng.tStart,
          tEnd: rng.tEnd,
          stepOnsetTimeSec: stepOnset,
          useAbsPower: true,
        }
      );
      this.lastViPowerResult = res;
      const inp = document.getElementById('thermPowerWInput') as HTMLInputElement | null;
      const chosenPower = res.pStepActiveW > 1e-6 ? res.pStepActiveW : res.pGateMeanW;
      const validPower = isFinite(chosenPower) && chosenPower > 1e-9;
      if (inp) {
        inp.value = validPower
          ? chosenPower >= 10
            ? chosenPower.toFixed(3)
            : chosenPower.toPrecision(4)
          : '0';
      }
      const vLabel = vIsConst ? `Const ${vConstVal} V` : `${vCh!.name}(×${res.vUnitScale})`;
      const iLabel = iIsConst ? `Const ${iConstVal} A` : `${iCh!.name}(×${res.iUnitScale})`;
      if (!validPower) {
        if (metaEl) {
          metaEl.innerText = `V×I 功率无效 (${vLabel} · ${iLabel} → ${isFinite(chosenPower) ? chosenPower.toFixed(4) : 'NaN'} W ≤ 0)，请检查所选通道与区间。`;
        }
        if (showToast) {
          this.app.showToast('Auto V×I computed power <= 0 W; please check V / I channels.', 'warn');
        }
        return null;
      }
      if (metaEl) {
        const idleNote =
          res.activeFraction < 0.96
            ? ` · 有效阶跃占比 ${(res.activeFraction * 100).toFixed(1)}% (已剔除阶跃前待机)`
            : '';
        metaEl.innerText = `V×I 已计算: ${vLabel} · ${iLabel} → ΔP_step = ${res.pStepActiveW.toFixed(3)} W (Gate均 ${res.pGateMeanW.toFixed(3)} W · Peak ${res.pPeakW.toFixed(2)} W · E=${formatEng(res.energyJ, 'J', 3)})${idleNote}`;
      }
      if (showToast) {
        this.app.showToast(
          `Auto V×I: ΔP_step = ${res.pStepActiveW.toFixed(3)} W (${vLabel} × ${iLabel})`,
          'info'
        );
      }
      return res;
    } catch (err: any) {
      const inp = document.getElementById('thermPowerWInput') as HTMLInputElement | null;
      if (inp) inp.value = '0';
      if (metaEl) metaEl.innerText = `V×I 计算失败: ${err?.message || err}`;
      if (showToast) this.app.showToast(`V×I calculation failed: ${err?.message || err}`, 'warn');
      return null;
    }
  }

  private readAndApplyPowerChannel(showToast: boolean = true): number | null {
    const tab = this.app.getActiveTab();
    const chId = (document.getElementById('thermPowerChSelect') as HTMLSelectElement)?.value;
    const ch = tab?.channels[chId];
    const metaEl = document.getElementById('thermViPowerMeta');
    const inp = document.getElementById('thermPowerWInput') as HTMLInputElement | null;
    if (!tab || !ch) {
      if (inp) inp.value = '0';
      if (metaEl) metaEl.innerText = 'Power Ch: 未找到有效的功率通道。';
      if (showToast) this.app.showToast('Select a valid Power channel first.', 'warn');
      return null;
    }
    const gate = ((document.getElementById('thermGateSelect') as HTMLSelectElement)?.value || 'entire') as 'entire' | 'view' | 'cursors';
    const rng = getChannelGateRange(tab, ch, gate);
    const stepOnset = this.getDetectedStepOnsetTime(tab);
    const effStart =
      stepOnset !== undefined && (rng.tStart === undefined || stepOnset > rng.tStart) && (rng.tEnd === undefined || stepOnset < rng.tEnd)
        ? stepOnset
        : rng.tStart;
    const scaleW = parseSiUnitScale(ch.unit, 'W', ch.name);
    const meanDissW = getSliceAbsTrapezoidalMean(ch, effStart, rng.tEnd) * scaleW;
    if (!isFinite(meanDissW) || meanDissW <= 1e-9) {
      if (inp) inp.value = '0';
      if (metaEl) {
        metaEl.innerText = `Power Ch "${ch.name}" 耗散均值 = 0 W (无效或全零区间)，已阻止反演回退。`;
      }
      if (showToast) {
        this.app.showToast(`Power channel "${ch.name}" dissipation mean is <= 0 W.`, 'warn');
      }
      return null;
    }
    if (inp) inp.value = meanDissW >= 10 ? meanDissW.toFixed(3) : meanDissW.toPrecision(4);
    if (metaEl) {
      metaEl.innerText = `Power Ch "${ch.name}" (${ch.unit || 'W'}, ×${scaleW}): 非负耗散均ΔP = ${meanDissW.toFixed(3)} W`;
    }
    if (showToast) {
      this.app.showToast(`Power step set from "${ch.name}" dissipation mean = ${meanDissW.toFixed(3)} W`, 'info');
    }
    return meanDissW;
  }

  private bindEvents(): void {
    document.getElementById('thermCloseTopBtn')?.addEventListener('click', () => this.closeModal());
    document.getElementById('thermCloseBottomBtn')?.addEventListener('click', () => this.closeModal());

    // Tabs
    document.getElementById('thermalTabDeconvBtn')?.addEventListener('click', () => this.switchTab('deconv'));
    document.getElementById('thermalTabLossBtn')?.addEventListener('click', () => this.switchTab('loss'));
    document.getElementById('thermalTabSoaBtn')?.addEventListener('click', () => this.switchTab('soa'));
    document.getElementById('thermalTabFocBtn')?.addEventListener('click', () => this.switchTab('foc'));
    document.getElementById('thermalTabDptBtn')?.addEventListener('click', () => this.switchTab('dpt'));

    // Tab 1 controls
    document.getElementById('thermModeSelect')?.addEventListener('change', (e: any) => {
      const wrap = document.getElementById('thermTBlankWrap');
      if (wrap) wrap.classList.toggle('opacity-50', e.target.value !== 'cooling');
    });

    document.getElementById('thermPathModeSelect')?.addEventListener('change', () => {
      this.userSetPathMode = true;
      this.syncThermalPathUI();
      if (this.lastDeconv) this.runDeconvolution();
    });
    document.getElementById('thermTempChSelect')?.addEventListener('change', () => {
      const tab = this.app.getActiveTab();
      const tSel = document.getElementById('thermTempChSelect') as HTMLSelectElement | null;
      const pathSel = document.getElementById('thermPathModeSelect') as HTMLSelectElement | null;
      if (!this.userSetPathMode && tab && tSel?.value && pathSel) {
        const ch = tab.channels[tSel.value];
        if (ch) {
          pathSel.value = /pcb|pad|board|ntc|case|tc|surf|焊盘|板温/i.test(ch.name) ? 'pad_ambient' : 'junction_ambient';
          this.syncThermalPathUI();
        }
      }
      if ((document.getElementById('thermPowerModeSelect') as HTMLSelectElement)?.value === 'auto_vi') {
        this.computeAndApplyViPower(false);
      }
    });
    document.getElementById('thermPowerModeSelect')?.addEventListener('change', () => {
      this.userSetPowerMode = true;
      this.syncPowerSourceUI(true);
    });
    document.getElementById('thermVoltChSelect')?.addEventListener('change', () => {
      this.syncConstViInputsUI();
      if ((document.getElementById('thermPowerModeSelect') as HTMLSelectElement)?.value === 'auto_vi') {
        this.computeAndApplyViPower(false);
      }
    });
    document.getElementById('thermCurrChSelect')?.addEventListener('change', () => {
      this.syncConstViInputsUI();
      if ((document.getElementById('thermPowerModeSelect') as HTMLSelectElement)?.value === 'auto_vi') {
        this.computeAndApplyViPower(false);
      }
    });
    const onConstViInput = () => {
      if ((document.getElementById('thermPowerModeSelect') as HTMLSelectElement)?.value === 'auto_vi') {
        this.computeAndApplyViPower(false);
      }
    };
    document.getElementById('thermConstVoltInput')?.addEventListener('input', onConstViInput);
    document.getElementById('thermConstCurrInput')?.addEventListener('input', onConstViInput);
    document.getElementById('thermGateSelect')?.addEventListener('change', () => {
      const mode = (document.getElementById('thermPowerModeSelect') as HTMLSelectElement)?.value;
      if (mode === 'auto_vi') this.computeAndApplyViPower(false);
      else if (mode === 'power_ch') this.readAndApplyPowerChannel(false);
    });
    document.getElementById('thermCalcViPowerBtn')?.addEventListener('click', () => {
      this.computeAndApplyViPower(true);
    });
    document.getElementById('thermInjectViPowerBtn')?.addEventListener('click', () => {
      const res = this.computeAndApplyViPower(false);
      if (!res) return;
      const vId = (document.getElementById('thermVoltChSelect') as HTMLSelectElement)?.value;
      const iId = (document.getElementById('thermCurrChSelect') as HTMLSelectElement)?.value;
      const validSourceIds = [
        vId && vId !== '__const__' ? vId : '',
        iId && iId !== '__const__' ? iId : '',
      ].filter(Boolean);
      const tId = (document.getElementById('thermTempChSelect') as HTMLSelectElement)?.value || '';
      const baseId = validSourceIds[0] || tId;
      this.app.injectThermalTraces(
        [
          {
            replaceKey: 'vi_power',
            name: 'P_vi (V×I)',
            unit: 'W',
            t: res.time,
            values: res.powerW,
            color: '#f59e0b',
            badge: 'PWR',
            expr: vId === '__const__' || iId === '__const__' ? 'V*I(Const)' : 'V(t)*I(t)',
            sourceIds: validSourceIds,
            baseChannelId: baseId,
            pinMetrics: ['average'],
          },
        ],
        {
          separateView: true,
          toastMessage: `Injected P_vi(t) = V×I trace (ΔP_step=${res.pStepActiveW.toFixed(3)} W, E=${formatEng(res.energyJ, 'J', 3)}) onto scope.`,
        }
      );
    });

    document.getElementById('thermReadPowerChBtn')?.addEventListener('click', () => {
      this.readAndApplyPowerChannel(true);
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

    document.getElementById('thermOrderSelect')?.addEventListener('change', () => {
      if (this.lastDeconv) {
        this.runDeconvolution();
      }
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
      const subName = this.lastDeconv?.thermalPathMode === 'pad_ambient' ? 'PAD_THERM' : 'MOS_THERM';
      if (!box || !box.value.trim()) {
        this.app.showToast(`Run deconvolution first to generate ${subName}.lib.`, 'warn');
        return;
      }
      const blob = new Blob([box.value], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${subName}.lib`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.app.showToast(`Downloaded ${subName}.lib for LTspice.`, 'info');
    });

    document.getElementById('thermApplyToSimBtn')?.addEventListener('click', () => {
      if (!this.lastDeconv) {
        this.app.showToast('Run deconvolution first.', 'warn');
        return;
      }
      if (this.lastDeconv.physicsAudit.status === 'failed') {
        this.app.showToast('当前热模型未通过物理有效性检验，已阻止应用到闭环结温仿真。', 'error');
        return;
      }
      this.activeCauerStages = this.lastDeconv.reducedCauer.map((s) => ({ ...s }));
      this.activePathMode = this.lastDeconv.thermalPathMode;
      this.activeTambC = this.lastDeconv.tAmbC;
      this.focModelSource = 'tab1_extracted';
      const rthSym = this.lastDeconv.thermalPathMode === 'pad_ambient' ? 'Rth,pad-a' : 'Rth';
      this.cauerSourceLabel = `Tab 1 Extracted (${this.activeCauerStages.length}-Stage, ${rthSym}=${this.lastDeconv.totalRthCauer.toFixed(3)} °C/W)`;
      const tambInp = document.getElementById('thermLossTambInput') as HTMLInputElement | null;
      if (tambInp) {
        tambInp.value = this.lastDeconv.tAmbC.toFixed(1);
      }
      this.updateCauerSummaryBox();
      this.syncLossPathLabels(this.activePathMode);
      this.refreshFocModelAndSpice();
      this.invalidateFocCaches(true);
      this.switchTab('loss');
      this.app.showToast('Applied Cauer RC ladder to Closed-Loop simulator.', 'info');
    });

    document.getElementById('thermInjectSmoothBtn')?.addEventListener('click', () => {
      if (!this.lastDeconv) {
        this.app.showToast('Run deconvolution first.', 'warn');
        return;
      }
      if (this.lastDeconv.physicsAudit.status === 'failed') {
        this.app.showToast('当前热模型未通过物理有效性检验，已阻止注入拟合曲线。', 'error');
        return;
      }
      const chId = (document.getElementById('thermTempChSelect') as HTMLSelectElement)?.value;
      const isPad = this.lastDeconv.thermalPathMode === 'pad_ambient';
      this.app.injectThermalTraces(
        [
          {
            replaceKey: 'fit_tj',
            name: `${isPad ? 'Fit T_pad' : 'Fit Tj'} (${this.lastDeconv.reducedCauer.length}-RC)`,
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
    const nudgeDeskew = (deltaNs: number) => {
      if (!deskewInput) return;
      const parsed = parseFloat(deskewInput.value);
      const cur = Number.isFinite(parsed) ? parsed : 0;
      const next = Math.max(-100, Math.min(100, Math.round((cur + deltaNs) * 10) / 10));
      deskewInput.value = String(next);
      if (deskewSlider) deskewSlider.value = String(next);
    };
    document.getElementById('thermLossDeskewDecBtn')?.addEventListener('click', (ev) => {
      nudgeDeskew((ev as MouseEvent).shiftKey ? -5.0 : -0.5);
    });
    document.getElementById('thermLossDeskewIncBtn')?.addEventListener('click', (ev) => {
      nudgeDeskew((ev as MouseEvent).shiftKey ? 5.0 : 0.5);
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
    document.getElementById('focRjcOverrideInput')?.addEventListener('change', () => this.refreshFocModelAndSpice());
    document.getElementById('focRjcSpreadPctInput')?.addEventListener('change', () => this.refreshFocModelAndSpice());
    document.getElementById('focEonIncludesQrrChk')?.addEventListener('change', () => this.invalidateFocCaches(true));

    // Tab 5 controls (DPT & multi-point LUT matrix)
    document.getElementById('dptLoadDemoBtn')?.addEventListener('click', () => this.loadDptDemoTab());
    document.getElementById('dptRunBtn')?.addEventListener('click', () => this.runDptAnalysis());
    document.getElementById('dptApplyToFocBtn')?.addEventListener('click', () => this.applyDptResultsToFoc());
    document.getElementById('dptAddToMatrixBtn')?.addEventListener('click', () => this.addCurrentDptPointToMatrix());
    document.getElementById('dptApplyMatrixToFocBtn')?.addEventListener('click', () => this.applyDptMatrixToFoc());
    document.getElementById('dptClearMatrixBtn')?.addEventListener('click', () => {
      this.dptMatrix = [];
      this.useDptMatrixInFoc = false;
      this.renderDptMatrixTable();
    });

    const stallOnlyInputIds = new Set([
      'focStallIpkInput',
      'focStallLimitInput',
      'focStallRsInput',
      'focStallDutyModeSelect',
    ]);
    const manualEswIds = new Set(['focEswInput', 'focQrrInput', 'focVrefInput', 'focIrefInput']);
    const handleFocPanelMutation = (ev: Event) => {
      const target = ev.target as HTMLElement | null;
      if (!target || !target.id) return;
      if (manualEswIds.has(target.id) && this.useDptMatrixInFoc) {
        this.useDptMatrixInFoc = false;
        this.activeFocHandoffNote = '已手动修改单点 Esw/Qrr 参数，当前切换回单点标量 V/I 缩放模式。';
      }
      if (stallOnlyInputIds.has(target.id)) {
        this.invalidateFocCaches(false);
      } else {
        this.invalidateFocCaches(true);
      }
    };
    const focPanel = document.getElementById('thermalPanelFoc');
    focPanel?.addEventListener('input', handleFocPanelMutation);
    focPanel?.addEventListener('change', handleFocPanelMutation);

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

    const scheduleRedrawIfVisible = () => {
      const modal = document.getElementById('thermalModal');
      if (modal && getComputedStyle(modal).display !== 'none') {
        requestAnimationFrame(() => this.redrawActivePlots());
      }
    };

    window.addEventListener('wvp-drawer-panel-shown', (ev: Event) => {
      const detail = (ev as CustomEvent<{ id?: string }>).detail;
      if (detail?.id === 'thermalModal') {
        requestAnimationFrame(() => this.redrawActivePlots());
      }
    });

    window.addEventListener('wvp-drawer-resized', (ev: Event) => {
      const detail = (ev as CustomEvent<{ id?: string }>).detail;
      if (!detail?.id || detail.id === 'thermalModal') {
        scheduleRedrawIfVisible();
      }
    });

    window.addEventListener('resize', scheduleRedrawIfVisible);
    window.addEventListener('wvp-theme-changed', scheduleRedrawIfVisible);
  }

  private getCanvasTheme() {
    const preset = this.app.getThemePreset();
    const c = preset.canvas;
    const isLight = c.isLight;
    return {
      isLight,
      bg: c.bg,
      grid: c.grid,
      frame: c.frame,
      axisText: c.axisText,
      titleText: isLight ? '#0f172a' : '#cbd5e1',
      emptyText: isLight ? '#64748b' : '#64748b',
      yellowDot: isLight ? 'rgba(180, 83, 9, 0.85)' : 'rgba(250, 204, 21, 0.82)',
      yellow: isLight ? '#b45309' : '#facc15',
      cyan: isLight ? '#0284c7' : '#22d3ee',
      sky: isLight ? '#0369a1' : '#38bdf8',
      skyFill: isLight ? 'rgba(2, 132, 199, 0.28)' : 'rgba(56, 189, 248, 0.35)',
      green: isLight ? '#059669' : '#4ade80',
      orange: isLight ? '#c2410c' : '#fb923c',
      orangeStroke: isLight ? 'rgba(194, 65, 12, 0.85)' : 'rgba(251, 146, 60, 0.85)',
      orangeMarker: isLight ? 'rgba(234, 88, 12, 0.72)' : 'rgba(251, 146, 60, 0.7)',
      pink: isLight ? '#be185d' : '#f472b6',
      purple: isLight ? '#6d28d9' : '#a78bfa',
      rose: isLight ? '#e11d48' : '#fb7185',
      red: isLight ? '#dc2626' : '#f43f5e',
      redDashed: isLight ? 'rgba(220, 38, 38, 0.72)' : 'rgba(248, 113, 113, 0.75)',
      dashedRef: isLight ? 'rgba(71, 85, 105, 0.45)' : 'rgba(148, 163, 184, 0.35)',
      trajStroke: isLight ? 'rgba(51, 65, 85, 0.45)' : 'rgba(226, 232, 240, 0.45)',
      trajDot: isLight ? 'rgba(2, 132, 199, 0.72)' : 'rgba(34, 211, 238, 0.65)',
      tBoard: isLight ? '#475569' : '#94a3b8',
      focColors: isLight
        ? ['#be185d', '#e11d48', '#0284c7', '#2563eb', '#059669', '#d97706']
        : ['#f472b6', '#fb7185', '#22d3ee', '#38bdf8', '#4ade80', '#facc15'],
    };
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
      this.app.showToast('Please select a Temperature / PCB / TSEP channel.', 'warn');
      return;
    }

    const powerSourceMode = (document.getElementById('thermPowerModeSelect') as HTMLSelectElement)?.value || 'manual';
    if (powerSourceMode === 'auto_vi') {
      const viRes = this.computeAndApplyViPower(false);
      if (!viRes) {
        this.app.showToast('Auto V×I 功率计算失败或结果 ≤ 0 W，已阻断热阻反演。', 'error');
        return;
      }
    } else if (powerSourceMode === 'power_ch') {
      const pChVal = this.readAndApplyPowerChannel(false);
      if (pChVal === null || !isFinite(pChVal) || pChVal <= 0) {
        this.app.showToast('Power 通道平均耗散功率无效或 ≤ 0 W，已阻断热阻反演。', 'error');
        return;
      }
    }

    const mode = ((document.getElementById('thermModeSelect') as HTMLSelectElement)?.value || 'heating') as ThermalInputMode;
    const thermalPathMode = ((document.getElementById('thermPathModeSelect') as HTMLSelectElement)?.value || 'junction_ambient') as ThermalPathMode;
    const rawPadSpread = parseFloat((document.getElementById('thermPadSpreadInput') as HTMLInputElement)?.value ?? '0');
    const padSpreadRthCPerW = Number.isFinite(rawPadSpread) ? Math.max(0, rawPadSpread) : 0;
    const powerW = parseFloat((document.getElementById('thermPowerWInput') as HTMLInputElement)?.value || '');
    const gate = ((document.getElementById('thermGateSelect') as HTMLSelectElement)?.value || 'entire') as 'entire' | 'view' | 'cursors';
    const autoT0 = (document.getElementById('thermAutoT0Chk') as HTMLInputElement)?.checked ?? true;
    const tBlankMs = parseFloat((document.getElementById('thermTBlankMsInput') as HTMLInputElement)?.value || '0.15');
    const targetOrder = parseInt((document.getElementById('thermOrderSelect') as HTMLSelectElement)?.value || '4', 10);

    if (!isFinite(powerW) || powerW <= 0) {
      this.app.showToast('Step Power ΔP (W) 必须严格大于 0，已阻断热阻反演。', 'error');
      return;
    }

    const rng = getChannelGateRange(tab, ch, gate);
    try {
      const tempVal = validateTemperatureChannel(ch);
      const meanAc = ch.coupling === 'AC' ? computeChannelMean(ch) : 0;
      const tempArr = new Float64Array(ch.v.length);
      for (let i = 0; i < ch.v.length; i++) {
        tempArr[i] = getChannelDisplayValue(ch, i, meanAc) * tempVal.scale + tempVal.offsetC;
      }
      const res = deconvolveThermalImpedance(ch.t, tempArr, {
        mode,
        powerW,
        tStart: rng.tStart,
        tEnd: rng.tEnd,
        autoT0,
        tBlankSec: isFinite(tBlankMs) && tBlankMs >= 0 ? tBlankMs * 1e-3 : 0.15e-3,
        targetOrder,
        thermalPathMode,
        padSpreadRthCPerW,
      });
      if (tempVal.warning) {
        res.warnings.unshift(tempVal.warning);
      }

      this.lastDeconv = res;
      const rthTag = res.thermalPathMode === 'pad_ambient' ? 'Rth,pad-a' : 'Rth';
      const audit = res.physicsAudit;
      if (audit.status !== 'failed') {
        this.activeCauerStages = res.reducedCauer.map((s) => ({ ...s }));
        this.activePathMode = res.thermalPathMode;
        this.activeTambC = res.tAmbC;
        this.focModelSource = 'tab1_extracted';
        this.cauerSourceLabel = `Tab 1 Extracted (${res.reducedCauer.length}-Stage, ${rthTag}=${res.totalRthCauer.toFixed(3)} °C/W)`;
        this.updateCauerSummaryBox();
        this.refreshFocModelAndSpice();
        const tambInp = document.getElementById('thermLossTambInput') as HTMLInputElement | null;
        if (tambInp) tambInp.value = res.tAmbC.toFixed(1);
      }
      this.renderDeconvMetricsAndTables(res);
      this.drawDeconvMainCanvas();
      this.drawDeconvSubCanvas();

      if (audit.status === 'failed') {
        this.app.showToast(`热模型拟合判定失败：${audit.summary}`, 'error');
      } else if (audit.status === 'reduced') {
        this.app.showToast(
          `已自动重拟合并降阶至 ${audit.effectiveOrder} 阶 (${rthTag}=${res.totalRthCauer.toFixed(3)} °C/W, R²=${res.rSquared.toFixed(4)})`,
          'warn'
        );
      } else {
        this.app.showToast(
          `Extracted ${res.reducedCauer.length}-stage Cauer RC (R²=${res.rSquared.toFixed(4)}, ${rthTag}=${res.totalRthCauer.toFixed(3)} °C/W)`,
          'info'
        );
      }
    } catch (err: any) {
      this.app.showToast(`Thermal Deconvolution failed: ${err?.message || err}`, 'error');
    }
  }

  private renderDeconvMetricsAndTables(res: ThermalDeconvResult): void {
    const setText = (id: string, txt: string) => {
      const el = document.getElementById(id);
      if (el) el.innerText = txt;
    };
    const isPad = res.thermalPathMode === 'pad_ambient';
    const audit = res.physicsAudit;
    const isFailed = audit.status === 'failed';
    setText('thermStatRthLabel', isPad ? 'Rth,pad-a (焊盘→环境)' : 'Rth Total (Tj→环境)');
    const rthEl = document.getElementById('thermStatRth');
    if (rthEl) {
      rthEl.innerText = isFailed ? `${res.totalRthCauer.toFixed(4)} °C/W (无效)` : `${res.totalRthCauer.toFixed(4)} °C/W`;
      rthEl.className = isFailed
        ? 'text-rose-400 font-semibold mt-0.5'
        : audit.status === 'reduced'
        ? 'text-amber-300 font-semibold mt-0.5'
        : 'text-emerald-300 font-semibold mt-0.5';
    }
    setText('thermStatR2', res.rSquared.toFixed(5));
    setText('thermStatRmse', `${res.rmseC.toFixed(3)} °C`);
    setText('thermStatT0', `${formatEng(res.t0Sec, 's', 3)}`);
    setText('thermStatDt', `${formatEng(res.dtMedSec, 's', 2)} (${res.usedLogBinning ? 'Log-Bin' : 'Raw'})`);
    setText('thermStatLambda', `${res.selectedLambda.toExponential(1)}`);
    setText('thermSpiceTitle', isPad ? 'LTspice .subckt PAD_THERM (PAD → TAMB)' : 'LTspice .subckt MOS_THERM (TJ → TAMB)');

    // Physics Audit banner
    const auditBox = document.getElementById('thermPhysicsAuditBox');
    const physBadge = document.getElementById('thermPhysicsBadge');
    const physSum = document.getElementById('thermPhysicsSummary');
    const physMeta = document.getElementById('thermPhysicsMeta');
    const physChecks = document.getElementById('thermPhysicsChecks');
    if (auditBox) {
      auditBox.classList.remove('hidden');
      auditBox.className =
        audit.status === 'valid'
          ? 'bg-emerald-950/20 border border-emerald-600/40 rounded-sm p-2.5 space-y-1.5 text-[11px]'
          : audit.status === 'reduced'
          ? 'bg-amber-950/25 border border-amber-500/50 rounded-sm p-2.5 space-y-1.5 text-[11px]'
          : 'bg-rose-950/35 border border-rose-500/70 rounded-sm p-2.5 space-y-1.5 text-[11px]';
    }
    if (physBadge) {
      if (audit.status === 'valid') {
        physBadge.innerText = `PHYSICS VALID (${audit.effectiveOrder}-RC)`;
        physBadge.className =
          'px-2 py-0.5 bg-emerald-950/80 border border-emerald-500/60 text-emerald-300 font-mono text-[10px] font-semibold rounded-xs shrink-0';
      } else if (audit.status === 'reduced') {
        physBadge.innerText = `AUTO-REDUCED (${audit.requestedOrder}→${audit.effectiveOrder}-RC)`;
        physBadge.className =
          'px-2 py-0.5 bg-amber-950/80 border border-amber-500/60 text-amber-300 font-mono text-[10px] font-semibold rounded-xs shrink-0';
      } else {
        physBadge.innerText = 'FIT FAILED (拟合失败)';
        physBadge.className =
          'px-2 py-0.5 bg-rose-950/90 border border-rose-500/80 text-rose-200 font-mono text-[10px] font-semibold rounded-xs shrink-0';
      }
    }
    if (physSum) physSum.innerText = audit.summary;
    if (physMeta) {
      const extTxt = isFinite(audit.extrapolationRatio) ? `${audit.extrapolationRatio.toFixed(2)}×` : '∞';
      physMeta.innerText = `外推 ${extTxt} · Z_end=${audit.zMeasuredEnd.toFixed(3)} °C/W · 重拟 ${audit.refitCount} 次`;
    }
    if (physChecks) {
      physChecks.innerHTML = '';
      for (const ck of audit.checks) {
        const chip = document.createElement('span');
        chip.title = ck.detail;
        chip.className = ck.passed
          ? 'px-1.5 py-0.5 bg-[#12161c] border border-emerald-700/40 text-emerald-300 rounded-xs'
          : 'px-1.5 py-0.5 bg-rose-950/70 border border-rose-500/60 text-rose-200 rounded-xs';
        chip.innerText = `${ck.passed ? '✓' : '✗'} ${ck.label}`;
        physChecks.appendChild(chip);
      }
    }

    const applyBtn = document.getElementById('thermApplyToSimBtn') as HTMLButtonElement | null;
    if (applyBtn) {
      applyBtn.disabled = isFailed;
      applyBtn.classList.toggle('opacity-40', isFailed);
      applyBtn.classList.toggle('cursor-not-allowed', isFailed);
    }
    const injectSmoothBtn = document.getElementById('thermInjectSmoothBtn') as HTMLButtonElement | null;
    if (injectSmoothBtn) {
      injectSmoothBtn.disabled = isFailed;
      injectSmoothBtn.classList.toggle('opacity-40', isFailed);
      injectSmoothBtn.classList.toggle('cursor-not-allowed', isFailed);
    }

    // Warnings banner (skip duplicating audit.summary already displayed in thermPhysicsAuditBox)
    const warnEl = document.getElementById('thermWarningsBox');
    if (warnEl) {
      const extraWarnings = res.warnings.filter((w) => w !== audit.summary);
      if (extraWarnings.length > 0) {
        warnEl.classList.remove('hidden');
        warnEl.innerText = extraWarnings.join(' | ');
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
        tr.className = `border-t border-[#222933] hover:bg-[#1a222d]/60 ${isFailed ? 'opacity-65' : ''}`;
        tr.innerHTML = `
          <td class="px-2 py-1 text-cyan-300 font-semibold">RC${i + 1}</td>
          <td class="px-2 py-1">${f ? f.r.toFixed(4) : '--'}</td>
          <td class="px-2 py-1">${f ? f.c.toExponential(2) : '--'}</td>
          <td class="px-2 py-1">${f ? formatEng(f.tau, 's', 2) : '--'}</td>
          <td class="px-2 py-1 text-emerald-300">${c.r.toFixed(4)}</td>
          <td class="px-2 py-1 text-emerald-300">${c.c.toExponential(2)}</td>
          <td class="px-2 py-1 text-slate-300 font-sans">${escapeHtml(c.layerLabel)}</td>
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
      if (isFailed) {
        badge.innerText = 'FIT REJECTED';
        badge.className =
          'px-2 py-0.5 bg-rose-950/80 border border-rose-500/70 text-rose-200 font-mono text-[10px] rounded-xs';
      } else {
        badge.innerText = v.valid ? 'SPICE VALIDATED' : 'NETLIST ERROR';
        badge.className = v.valid
          ? 'px-2 py-0.5 bg-emerald-950/70 border border-emerald-500/60 text-emerald-300 font-mono text-[10px] rounded-xs'
          : 'px-2 py-0.5 bg-red-950/70 border border-red-500/60 text-red-300 font-mono text-[10px] rounded-xs';
      }
    }
    if (detail) {
      detail.innerText = isFailed
        ? `物理审计未通过，请勿直接用于仿真：${audit.summary}`
        : v.valid
        ? `C1@${v.heatNodeName}=${v.firstCapAtTJ} · Ck@Nk->0=${v.allCapsGroundedTo0} · NoTAMBShort=${v.noCapOnTamb} · Rn->TAMB=${v.finalResToTamb} · .ic=${v.hasDefensiveIc} · ΣR=${v.totalSpiceR.toFixed(4)}°C/W`
        : v.errors.join('; ');
    }
  }

  private drawDeconvMainCanvas(): void {
    const canvas = document.getElementById('thermMainCanvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const prep = prepareHiDpiCanvas(canvas);
    if (!prep) return;
    const { ctx, w, h } = prep;

    const th = this.getCanvasTheme();
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, w, h);

    const res = this.lastDeconv;
    if (!res || res.fitTimeRel.length === 0) {
      ctx.fillStyle = th.emptyText;
      ctx.font = '12px "IBM Plex Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Select Temperature/TSEP channel & click "Run Deconvolution"', w / 2, h / 2);
      return;
    }

    const pad = { l: 58, r: 16, t: 22, b: 28 };
    const pw = Math.max(20, w - pad.l - pad.r);
    const ph = Math.max(20, h - pad.t - pad.b);

    // Subtle grid
    ctx.strokeStyle = th.grid;
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
    ctx.strokeStyle = th.frame;
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
        ctx.strokeStyle = th.orangeMarker;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(xt0, pad.t);
        ctx.lineTo(xt0, pad.t + ph);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Measured points (t0 + fitTimeRel)
      ctx.fillStyle = th.yellowDot;
      const step = Math.max(1, Math.floor(tAbsMeas.length / 400));
      for (let i = 0; i < tAbsMeas.length; i += step) {
        const px = xOf(res.t0Sec + tAbsMeas[i]);
        const py = yOf(res.fitTempMeasured[i]);
        ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
      }

      // 12x Smooth Fit Curve
      ctx.strokeStyle = th.cyan;
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
      ctx.fillStyle = th.axisText;
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
      ctx.fillStyle = th.titleText;
      const pathTag = res.thermalPathMode === 'pad_ambient' ? 'T_pad(t)' : 'T(t)';
      ctx.fillText(`Lin-t ${pathTag}: Measured (amber) vs ${res.reducedCauer.length}-Stage Smooth Fit (blue) · t0=${formatEng(res.t0Sec, 's', 2)}`, pad.l + 6, pad.t - 6);
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

      ctx.fillStyle = th.yellowDot;
      for (const p of pts) {
        ctx.fillRect(xOf(p.dt) - 1.5, yOf(p.zMeas) - 1.5, 3, 3);
      }

      ctx.strokeStyle = th.cyan;
      ctx.lineWidth = 2;
      ctx.beginPath();
      pts.forEach((p, idx) => {
        const px = xOf(p.dt);
        const py = yOf(p.zPred);
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();

      ctx.fillStyle = th.axisText;
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
      ctx.fillStyle = th.titleText;
      const zLabel = res.thermalPathMode === 'pad_ambient' ? 'Zth,pad-a(Δt)' : 'Zth(Δt)';
      ctx.fillText(`Log-t: ${zLabel} [°C/W] vs Δt (s)`, pad.l + 6, pad.t - 6);
    }
  }

  private drawDeconvSubCanvas(): void {
    const canvas = document.getElementById('thermSubCanvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const prep = prepareHiDpiCanvas(canvas);
    if (!prep) return;
    const { ctx, w, h } = prep;

    const th = this.getCanvasTheme();
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, w, h);

    const res = this.lastDeconv;
    if (!res) {
      ctx.fillStyle = th.emptyText;
      ctx.font = '11px "IBM Plex Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Run deconvolution to inspect τ spectrum, Structure Function, or Residuals', w / 2, h / 2);
      return;
    }

    const pad = { l: 58, r: 16, t: 20, b: 26 };
    const pw = Math.max(20, w - pad.l - pad.r);
    const ph = Math.max(20, h - pad.t - pad.b);

    ctx.strokeStyle = th.grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = pad.t + (ph * i) / 3;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + pw, y);
      ctx.stroke();
    }
    ctx.strokeStyle = th.frame;
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
      ctx.fillStyle = th.skyFill;
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
        ctx.strokeStyle = th.green;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(x, pad.t + ph);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.fillStyle = th.green;
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`τ${idx + 1}`, x, Math.max(pad.t + 10, y - 6));
      });

      ctx.fillStyle = th.axisText;
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
      ctx.fillStyle = th.titleText;
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

      ctx.strokeStyle = th.purple;
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
        ctx.fillStyle = th.yellow;
        ctx.beginPath();
        ctx.arc(px, py, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.fillStyle = th.titleText;
        ctx.textAlign = idx === sf.length - 1 ? 'right' : 'left';
        ctx.fillText(`N${idx + 1}`, px + (idx === sf.length - 1 ? -4 : 4), Math.max(pad.t + 10, py - 5));
      });

      ctx.fillStyle = th.axisText;
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`1e${Math.round(lcMax)}`, pad.l - 6, pad.t + 8);
      ctx.fillText(`1e${Math.round(lcMin)}`, pad.l - 6, pad.t + ph);
      ctx.textAlign = 'center';
      for (let i = 0; i <= 4; i++) {
        ctx.fillText(`${((rMax * i) / 4).toFixed(2)}`, pad.l + (pw * i) / 4, pad.t + ph + 15);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = th.titleText;
      ctx.fillText('Cumulative Structure Function: log10(CΣ [J/°C]) vs RΣ [°C/W]', pad.l + 6, pad.t - 5);
    } else {
      // Residual
      const r = res.residualTemp;
      if (r.length < 2) return;
      let maxAbs = 0.05;
      for (let i = 0; i < r.length; i++) if (Math.abs(r[i]) > maxAbs) maxAbs = Math.abs(r[i]);
      maxAbs *= 1.15;

      const midY = pad.t + ph / 2;
      ctx.strokeStyle = th.dashedRef;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(pad.l, midY);
      ctx.lineTo(pad.l + pw, midY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.strokeStyle = th.rose;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < r.length; i++) {
        const px = pad.l + (i / (r.length - 1)) * pw;
        const py = midY - (r[i] / maxAbs) * (ph / 2);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();

      ctx.fillStyle = th.axisText;
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`+${maxAbs.toFixed(2)}°C`, pad.l - 6, pad.t + 8);
      ctx.fillText(`-${maxAbs.toFixed(2)}°C`, pad.l - 6, pad.t + ph);
      ctx.textAlign = 'left';
      ctx.fillStyle = th.titleText;
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
    const initTjRaw = (document.getElementById('thermLossInitTjInput') as HTMLInputElement)?.value?.trim() || '';
    const initTjParsed = parseFloat(initTjRaw);
    const deskewNs = parseFloat((document.getElementById('thermLossDeskewInput') as HTMLInputElement)?.value || '0');
    const eossUj = parseFloat((document.getElementById('thermLossEossInput') as HTMLInputElement)?.value || '12');
    const rdsOn25Mohm = parseFloat((document.getElementById('thermLossRdsInput') as HTMLInputElement)?.value || '4.5');
    const alphaPct = parseFloat((document.getElementById('thermLossAlphaInput') as HTMLInputElement)?.value || '0.45');
    const rdsFeedbackEnabled = (document.getElementById('thermLossRdsFeedbackChk') as HTMLInputElement)?.checked ?? false;

    const rng = getChannelGateRange(tab, vdsCh, gate);
    try {
      const res = computeLossWithDeskewAndEoss(vdsCh, idsCh, this.activeCauerStages, {
        deskewNs: isFinite(deskewNs) ? deskewNs : 0,
        eossUj: isFinite(eossUj) ? eossUj : 0,
        rdsOn25Mohm: isFinite(rdsOn25Mohm) && rdsOn25Mohm > 0 ? rdsOn25Mohm : 5,
        tempCoeffAlphaPerC: isFinite(alphaPct) ? alphaPct / 100 : 0.0045,
        rdsFeedbackEnabled,
        tAmbC: isFinite(tAmbC) ? tAmbC : 25,
        initialTjC: initTjRaw && isFinite(initTjParsed) ? initTjParsed : undefined,
        pathMode: this.activePathMode,
        tStart: rng.tStart,
        tEnd: rng.tEnd,
      });

      this.lastLossResult = res;
      this.syncLossPathLabels(res.thermalPathMode);
      const isPadPath = res.thermalPathMode === 'pad_ambient' || this.activePathMode === 'pad_ambient';

      const setText = (id: string, txt: string) => {
        const el = document.getElementById(id);
        if (el) el.innerText = txt;
      };

      const lossWarnBox = document.getElementById('thermLossWarningsBox');
      if (res.incomplete) {
        setText('thermLossRawE', 'INCOMPLETE');
        setText('thermLossDeskewE', '--');
        setText('thermLossStrippedE', '--');
        setText('thermLossPmean', '--');
        setText('thermLossTjMax', '--');
        setText('thermLossDeltaTj', '--');
        setText('thermLossSwCount', '0');
        if (lossWarnBox) {
          lossWarnBox.classList.remove('hidden');
          lossWarnBox.innerHTML = (res.incompleteReasons.length > 0 ? res.incompleteReasons : res.warnings)
            .map((w) => `<div class="text-rose-200">✖ ${escapeHtml(w)}</div>`)
            .join('');
        }
        this.drawLossPreviewCanvas();
        this.app.showToast(res.incompleteReasons[0] || '损耗积分存在无效点/覆盖不足，已拒绝对外输出 Tj(t) (INCOMPLETE)。', 'error');
        return;
      }

      setText('thermLossRawE', `${res.energyRawMj.toFixed(4)} mJ`);
      setText('thermLossDeskewE', `${res.energyDeskewedMj.toFixed(4)} mJ`);
      setText('thermLossStrippedE', `${res.energyStrippedMj.toFixed(4)} mJ`);
      setText('thermLossPmean', `${res.pLossMeanW.toFixed(3)} W`);
      setText('thermLossTjMax', `${res.tjMaxC.toFixed(2)} °C`);
      setText('thermLossDeltaTj', `${(res.tjMaxC - (isFinite(tAmbC) ? tAmbC : 25)).toFixed(2)} °C`);
      setText('thermLossSwCount', `${res.switchingEvents}`);

      if (lossWarnBox) {
        const msgs: string[] = [];
        if (this.focModelSource === 'fallback_default') {
          msgs.push('▲ 当前使用的是系统默认 Fallback 热网络 (非实测器件反演)，所得温升仅作演示参考。');
        } else if (this.focModelSource === 'tab1_extracted' && isPadPath) {
          msgs.push('▲ 当前 Cauer 模型基于焊盘/PCB 测温点 (Pad→Amb) 反演，所算温升已标注为等效 Tpad 而非芯片真实 Tj。');
        }
        for (const w of res.warnings) msgs.push(`▲ ${w}`);
        if (msgs.length > 0) {
          lossWarnBox.classList.remove('hidden');
          lossWarnBox.innerHTML = msgs.map((m) => `<div>${escapeHtml(m)}</div>`).join('');
        } else {
          lossWarnBox.classList.add('hidden');
          lossWarnBox.innerHTML = '';
        }
      }

      this.drawLossPreviewCanvas();

      const tempTraceName = isPadPath ? 'Tpad (Pad-Amb Equiv)' : 'Tj (Closed-Loop)';
      const tempBadge = isPadPath ? 'TPAD' : 'TJ';
      const tempMetricLabel = isPadPath ? 'Tpad Max' : 'Tj Max';
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
            replaceKey: isPadPath ? 'tpad_closed' : 'tj_closed',
            name: tempTraceName,
            unit: '°C',
            t: res.time,
            values: res.tjC,
            color: '#f472b6',
            badge: tempBadge,
            expr: `Cauer(${this.activeCauerStages.length}RC)+Rds(T)`,
            sourceIds: [vdsId, idsId],
            baseChannelId: vdsId,
            pinMetrics: ['max'],
          },
        ],
        {
          separateView: true,
          toastMessage: `Injected P_loss & ${tempTraceName} (${tempMetricLabel}=${res.tjMaxC.toFixed(2)} °C, Pmean=${res.pLossMeanW.toFixed(2)} W) + pinned to Measurement Strip.`,
        }
      );
    } catch (err: any) {
      this.app.showToast(`Loss & Tj(t) simulation failed: ${err?.message || err}`, 'error');
    }
  }

  private drawLossPreviewCanvas(): void {
    const canvas = document.getElementById('thermLossCanvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const prep = prepareHiDpiCanvas(canvas);
    if (!prep) return;
    const { ctx, w, h } = prep;

    const th = this.getCanvasTheme();
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, w, h);

    const res = this.lastLossResult;
    if (!res || res.time.length < 2) {
      ctx.fillStyle = th.emptyText;
      ctx.font = '11px "IBM Plex Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Run Loss & Tj(t) to preview stripped P_loss(t) & closed-loop Tj(t).', w / 2, h / 2);
      return;
    }
    if (res.incomplete) {
      ctx.fillStyle = th.red;
      ctx.font = '12px "IBM Plex Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('INCOMPLETE — 检测到 NaN/Inf、采样缺口或覆盖不足，已拒绝输出损耗积分与 Tj(t)', w / 2, h / 2);
      return;
    }

    const pad = { l: 56, r: 54, t: 22, b: 28 };
    const pw = Math.max(20, w - pad.l - pad.r);
    const ph = Math.max(20, h - pad.t - pad.b);

    ctx.strokeStyle = th.grid;
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
    ctx.strokeStyle = th.frame;
    ctx.strokeRect(pad.l, pad.t, pw, ph);

    const n = res.time.length;
    const tMin = res.time[0];
    const tMax = res.time[n - 1];
    const tSpan = Math.max(1e-12, tMax - tMin);

    let pMin = Infinity;
    let pMax = -Infinity;
    let tjMin = Infinity;
    let tjMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const p = res.pLossW[i];
      const tj = res.tjC[i];
      if (isFinite(p)) {
        if (p < pMin) pMin = p;
        if (p > pMax) pMax = p;
      }
      if (isFinite(tj)) {
        if (tj < tjMin) tjMin = tj;
        if (tj > tjMax) tjMax = tj;
      }
    }
    if (!isFinite(pMin) || !isFinite(pMax)) {
      pMin = 0;
      pMax = 1;
    }
    if (!isFinite(tjMin) || !isFinite(tjMax)) {
      tjMin = 20;
      tjMax = 30;
    }

    const pPad = Math.max(0.5, (pMax - pMin) * 0.08);
    pMin = Math.min(0, pMin - pPad * 0.25);
    pMax += pPad;
    const pSpan = Math.max(1e-6, pMax - pMin);

    const tjPad = Math.max(0.25, (tjMax - tjMin) * 0.12);
    tjMin -= tjPad;
    tjMax += tjPad;
    const tjSpan = Math.max(1e-6, tjMax - tjMin);

    const xOf = (t: number) => pad.l + ((t - tMin) / tSpan) * pw;
    const yOfP = (p: number) => pad.t + ph - ((p - pMin) / pSpan) * ph;
    const yOfTj = (tj: number) => pad.t + ph - ((tj - tjMin) / tjSpan) * ph;

    // Decimate min/max buckets when dense so transients remain sharp at any drawer width
    const stride = Math.max(1, Math.floor(n / Math.max(200, Math.round(pw * 1.5))));

    // P_loss(t) trace (amber-orange, left Y-axis)
    ctx.strokeStyle = th.orangeStroke;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    let startedP = false;
    for (let i = 0; i < n; i += stride) {
      let lo = Infinity;
      let hi = -Infinity;
      let loIdx = i;
      let hiIdx = i;
      const end = Math.min(n, i + stride);
      for (let j = i; j < end; j++) {
        const v = res.pLossW[j];
        if (!isFinite(v)) continue;
        if (v < lo) {
          lo = v;
          loIdx = j;
        }
        if (v > hi) {
          hi = v;
          hiIdx = j;
        }
      }
      if (!isFinite(lo)) continue;
      const ordered = loIdx <= hiIdx ? [loIdx, hiIdx] : [hiIdx, loIdx];
      for (const idx of ordered) {
        const px = xOf(res.time[idx]);
        const py = yOfP(res.pLossW[idx]);
        if (!startedP) {
          ctx.moveTo(px, py);
          startedP = true;
        } else {
          ctx.lineTo(px, py);
        }
      }
    }
    ctx.stroke();

    // Closed-loop Tj(t) trace (pink, right Y-axis)
    ctx.strokeStyle = th.pink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let startedTj = false;
    for (let i = 0; i < n; i += stride) {
      const tj = res.tjC[i];
      if (!isFinite(tj)) continue;
      const px = xOf(res.time[i]);
      const py = yOfTj(tj);
      if (!startedTj) {
        ctx.moveTo(px, py);
        startedTj = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    if (n > 0 && isFinite(res.tjC[n - 1])) {
      ctx.lineTo(xOf(res.time[n - 1]), yOfTj(res.tjC[n - 1]));
    }
    ctx.stroke();

    // Axis tick labels
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = th.orange;
    for (let i = 0; i <= 4; i++) {
      const pVal = pMax - (pSpan * i) / 4;
      ctx.fillText(`${pVal.toFixed(Math.abs(pVal) >= 100 ? 0 : 1)}W`, pad.l - 6, pad.t + (ph * i) / 4 + 3);
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = th.pink;
    for (let i = 0; i <= 4; i++) {
      const tjVal = tjMax - (tjSpan * i) / 4;
      ctx.fillText(`${tjVal.toFixed(1)}°C`, pad.l + pw + 6, pad.t + (ph * i) / 4 + 3);
    }

    ctx.textAlign = 'center';
    ctx.fillStyle = th.axisText;
    for (let i = 0; i <= 5; i++) {
      const tVal = tMin + (tSpan * i) / 5;
      ctx.fillText(formatEng(tVal, 's', 2), pad.l + (pw * i) / 5, pad.t + ph + 16);
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = th.titleText;
    const tLabel = res.thermalPathMode === 'pad_ambient' || this.activePathMode === 'pad_ambient' ? 'Tpad_max' : 'Tj_max';
    ctx.fillText(
      `Pmean=${res.pLossMeanW.toFixed(2)} W · ${tLabel}=${res.tjMaxC.toFixed(2)} °C · SW Events=${res.switchingEvents}`,
      pad.l + 6,
      pad.t - 6
    );
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
      if (res.status === 'INVALID') {
        statusBadge.innerText = 'SOA INVALID';
        statusBadge.className =
          'px-2.5 py-0.5 bg-red-950/80 border border-red-500/70 text-red-200 font-mono text-xs font-semibold rounded-xs';
      } else if (res.status === 'INDETERMINATE') {
        statusBadge.innerText = 'SOA INDETERMINATE';
        statusBadge.className =
          'px-2.5 py-0.5 bg-amber-950/80 border border-amber-500/70 text-amber-200 font-mono text-xs font-semibold rounded-xs';
      } else {
        statusBadge.innerText = res.pass ? 'SOA PASS' : `SOA FAIL (${res.violationCount} pts)`;
        statusBadge.className = res.pass
          ? 'px-2.5 py-0.5 bg-emerald-950/70 border border-emerald-500/60 text-emerald-300 font-mono text-xs font-semibold rounded-xs'
          : 'px-2.5 py-0.5 bg-red-950/80 border border-red-500/70 text-red-200 font-mono text-xs font-semibold rounded-xs';
      }
    }
    const setText = (id: string, txt: string) => {
      const el = document.getElementById(id);
      if (el) el.innerText = txt;
    };
    if (res.status === 'INVALID') {
      setText('thermSoaMaxUtil', '--');
      setText('thermSoaMinMargin', '--');
      setText('thermSoaWorstPoint', res.statusReason || 'Invalid SOA data');
    } else if (res.status === 'INDETERMINATE') {
      setText('thermSoaMaxUtil', res.validSampleCount > 0 ? `${res.maxUtilizationPct.toFixed(1)}% (局部)` : '--');
      setText('thermSoaMinMargin', res.validSampleCount > 0 ? `${res.minMarginPct.toFixed(1)}% (待定)` : '--');
      setText(
        'thermSoaWorstPoint',
        res.worstTime !== null
          ? `[缺口/无效] Vds=${res.worstVds.toFixed(2)}V, Id=${res.worstId.toFixed(2)}A @ ${formatEng(res.worstTime, 's', 3)}`
          : res.statusReason || 'Indeterminate SOA'
      );
    } else {
      setText('thermSoaMaxUtil', `${res.maxUtilizationPct.toFixed(1)}%`);
      setText('thermSoaMinMargin', `${res.minMarginPct.toFixed(1)}%`);
      setText(
        'thermSoaWorstPoint',
        res.worstTime !== null
          ? `Vds=${res.worstVds.toFixed(2)}V, Id=${res.worstId.toFixed(2)}A @ ${formatEng(res.worstTime, 's', 3)}`
          : '--'
      );
    }

    const soaWarnBox = document.getElementById('thermSoaWarningsBox');
    if (soaWarnBox) {
      const msgs = [...res.warnings];
      if (res.statusReason && !msgs.includes(res.statusReason)) msgs.unshift(res.statusReason);
      if (msgs.length > 0) {
        soaWarnBox.classList.remove('hidden');
        soaWarnBox.innerHTML = msgs.map((m) => `<div>▲ ${escapeHtml(m)}</div>`).join('');
      } else {
        soaWarnBox.classList.add('hidden');
        soaWarnBox.innerHTML = '';
      }
    }

    const jumpBtn = document.getElementById('thermSoaJumpBtn') as HTMLButtonElement | null;
    if (jumpBtn) jumpBtn.disabled = res.worstIndex === null || res.status === 'INVALID';

    this.drawSoaCanvas();
  }

  private drawSoaCanvas(): void {
    const canvas = document.getElementById('thermSoaCanvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const prep = prepareHiDpiCanvas(canvas);
    if (!prep) return;
    const { ctx, w, h } = prep;

    const th = this.getCanvasTheme();
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, w, h);

    const pad = { l: 54, r: 18, t: 22, b: 30 };
    const pw = Math.max(20, w - pad.l - pad.r);
    const ph = Math.max(20, h - pad.t - pad.b);

    let maxCurveId = 1000;
    (Object.keys(this.soaCurveSet.curves) as SoaPulseKey[]).forEach((k) => {
      for (const p of this.soaCurveSet.curves[k]) {
        if (isFinite(p.id) && p.id > maxCurveId) maxCurveId = p.id;
      }
    });
    if (this.lastSoaResult) {
      for (const p of this.lastSoaResult.trajectoryPoints) {
        if (isFinite(p.id) && p.id > maxCurveId) maxCurveId = p.id;
      }
    }
    const yAxisCap = Math.pow(10, Math.ceil(Math.log10(Math.max(1000, maxCurveId * 1.15))));

    const lxMin = Math.log10(0.1);
    const lxMax = Math.log10(Math.max(150, this.soaCurveSet.vdsMaxRated * 1.5));
    const lyMin = Math.log10(0.5);
    const lyMax = Math.log10(yAxisCap);
    const xOf = (v: number) => pad.l + ((Math.log10(Math.max(0.1, v)) - lxMin) / (lxMax - lxMin)) * pw;
    const yOf = (id: number) => pad.t + ph - ((Math.log10(Math.max(0.5, id)) - lyMin) / (lyMax - lyMin)) * ph;

    // Log grid decades
    ctx.strokeStyle = th.grid;
    ctx.lineWidth = 1;
    [0.1, 1, 10, 100, 1000].forEach((d) => {
      const gx = xOf(d);
      if (gx >= pad.l && gx <= pad.l + pw) {
        ctx.beginPath();
        ctx.moveTo(gx, pad.t);
        ctx.lineTo(gx, pad.t + ph);
        ctx.stroke();
      }
    });
    const yDecades = [1, 10, 100, 1000, 10000].filter((d) => d <= yAxisCap);
    yDecades.forEach((d) => {
      const gy = yOf(d);
      if (gy >= pad.t && gy <= pad.t + ph) {
        ctx.beginPath();
        ctx.moveTo(pad.l, gy);
        ctx.lineTo(pad.l + pw, gy);
        ctx.stroke();
      }
    });
    ctx.strokeStyle = th.frame;
    ctx.strokeRect(pad.l, pad.t, pw, ph);

    // Plot SOA boundary curves
    const curveStyles: Array<[SoaPulseKey, string]> = [
      ['10us', th.cyan],
      ['100us', th.sky],
      ['1ms', th.green],
      ['10ms', th.yellow],
      ['DC', th.orange],
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
    ctx.strokeStyle = th.redDashed;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(xMaxV, pad.t);
    ctx.lineTo(xMaxV, pad.t + ph);
    ctx.stroke();
    ctx.setLineDash([]);

    // Operating trajectory
    if (this.lastSoaResult && this.lastSoaResult.trajectoryPoints.length > 0) {
      const traj = this.lastSoaResult.trajectoryPoints;
      ctx.strokeStyle = th.trajStroke;
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
        ctx.fillStyle = p.violated ? th.red : th.trajDot;
        ctx.fillRect(px - (p.violated ? 2.5 : 1.2), py - (p.violated ? 2.5 : 1.2), p.violated ? 5 : 2.4, p.violated ? 5 : 2.4);
      }

      if (this.lastSoaResult.worstTime !== null) {
        const wx = xOf(Math.max(0.1, this.lastSoaResult.worstVds));
        const wy = yOf(Math.max(0.5, this.lastSoaResult.worstId));
        ctx.strokeStyle = th.rose;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(wx, wy, 6, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    ctx.fillStyle = th.axisText;
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    [0.1, 1, 10, 100, 1000].forEach((d) => {
      const gx = xOf(d);
      if (gx >= pad.l && gx <= pad.l + pw) ctx.fillText(`${d}V`, gx, pad.t + ph + 16);
    });
    ctx.textAlign = 'right';
    yDecades.forEach((d) => {
      const gy = yOf(d);
      if (gy >= pad.t && gy <= pad.t + ph) ctx.fillText(`${d}A`, pad.l - 6, gy + 3);
    });
    ctx.textAlign = 'left';
    ctx.fillStyle = th.titleText;
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
    this.userSetPathMode = false;
    this.userSetPowerMode = false;
    this.populateChannelSelectors();
    const pInp = document.getElementById('thermPowerWInput') as HTMLInputElement | null;
    if (pInp) pInp.value = '50';
    this.runDeconvolution();
  }

  // ==================== Phase 2: BLDC FOC 6-MOS Workbench Methods ====================

  private getActiveFocModel(): FocThermalModel {
    const tauSplitMs = parseFloat((document.getElementById('focTauSplitMsInput') as HTMLInputElement)?.value || '50');
    const tauSplitSec = isFinite(tauSplitMs) && tauSplitMs > 0 ? tauSplitMs * 1e-3 : 0.05;
    const rJcRaw = (document.getElementById('focRjcOverrideInput') as HTMLInputElement | null)?.value?.trim() || '';
    const rJcVal = parseFloat(rJcRaw);
    const rJcDatasheetOhm = rJcRaw && Number.isFinite(rJcVal) && rJcVal > 0 ? rJcVal : undefined;
    const spreadRaw = parseFloat((document.getElementById('focRjcSpreadPctInput') as HTMLInputElement | null)?.value || '0');
    const spreadPct = Number.isFinite(spreadRaw) ? Math.max(0, Math.min(60, spreadRaw)) : 0;

    let baseModel: FocThermalModel;
    if (this.focModelSource === 'default_demo' || this.activeCauerStages.length === 0) {
      baseModel = {
        zthJC: DEFAULT_FOC_MODEL.zthJC.map((s) => ({ ...s })),
        zthBoard: DEFAULT_FOC_MODEL.zthBoard.map((s) => ({ ...s })),
        modelKind: rJcDatasheetOhm ? 'datasheet_constrained' : 'demo_builtin',
        provenanceNote: rJcDatasheetOhm
          ? `FOC Demo 模型已应用手册 RθJC=${rJcDatasheetOhm.toFixed(3)} °C/W 约束。`
          : 'FOC Demo 内置默认 4 阶热网络，非实际器件反演结果。',
      };
      if (rJcDatasheetOhm && baseModel.zthJC.length > 0) {
        const curJc = baseModel.zthJC.reduce((a, s) => a + s.r, 0);
        const scale = curJc > 1e-6 ? rJcDatasheetOhm / curJc : 1;
        baseModel.zthJC = baseModel.zthJC.map((s) => ({ ...s, r: s.r * scale }));
      }
    } else {
      baseModel = splitCauerToFocModel(this.activeCauerStages, tauSplitSec, {
        pathMode: this.activePathMode,
        rJcDatasheetOhm,
      });
      if (this.focModelSource === 'fallback_default' && !rJcDatasheetOhm) {
        baseModel.modelKind = 'fallback_default';
        baseModel.provenanceNote =
          '当前使用的是系统默认 Fallback 热网络，非当前器件真实参数；请先在 Tab 1 反演真实器件。';
      }
    }

    if (spreadPct > 0) {
      const s = spreadPct / 100;
      // Q1(AH), Q2(AL): 1.0 | Q3(BH), Q4(BL): center leg +s | Q5(CH), Q6(CL): edge -0.5s
      baseModel.perSwitchRjcScale = [1, 1, 1 + s, 1 + s, Math.max(0.4, 1 - 0.5 * s), Math.max(0.4, 1 - 0.5 * s)];
      const rBrd = baseModel.zthBoard.reduce((a, c) => a + c.r, 0);
      baseModel.perSwitchPadOffsetCPerW = [0, 0, rBrd * s * 0.5, rBrd * s * 0.5, 0, 0];
    }

    return baseModel;
  }

  private computeFocInputFingerprint(): string {
    const tab = this.app.getActiveTab();
    const valOf = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value || '';
    const chSig = (chId: string) => {
      const ch = tab?.channels[chId];
      if (!ch) return chId;
      const n = ch.t.length;
      const t0 = n > 0 ? ch.t[0] : 0;
      const t1 = n > 0 ? ch.t[n - 1] : 0;
      return `${ch.id}:${ch.unit}:${ch.coupling}:${n}:${t0}:${t1}`;
    };
    const iaId = valOf('focIaSelect');
    const ibId = valOf('focIbSelect');
    const icId = valOf('focIcSelect');
    const vbusId = valOf('focVbusSelect');
    const daId = valOf('focDaSelect');
    const dbId = valOf('focDbSelect');
    const dcId = valOf('focDcSelect');
    const gate = valOf('focGateSelect');
    const gateInit = valOf('focGateInitSelect');
    const cauerSig = this.activeCauerStages.map((s) => `${s.r.toFixed(6)}:${s.c.toFixed(6)}`).join('|');
    const paramIds = [
      'focVbusConstInput',
      'focTambInput',
      'focModSelect',
      'focModDepthInput',
      'focPfAngleInput',
      'focFswKhzInput',
      'focTdeadNsInput',
      'focRdsInput',
      'focAlphaInput',
      'focVsdInput',
      'focEswInput',
      'focEossInput',
      'focQrrInput',
      'focVrefInput',
      'focIrefInput',
      'focTauSplitMsInput',
      'focRjcOverrideInput',
      'focRjcSpreadPctInput',
    ];
    const eonInclQrr = (document.getElementById('focEonIncludesQrrChk') as HTMLInputElement | null)?.checked ? '1' : '0';
    return JSON.stringify({
      tabId: tab?.id || '',
      view: tab?.view ? `${tab.view.startIndex}:${tab.view.endIndex}` : '',
      cursors: tab?.cursors ? `${tab.cursors.enabled}:${tab.cursors.x1}:${tab.cursors.x2}` : '',
      chs: [chSig(iaId), chSig(ibId), chSig(icId), chSig(vbusId), chSig(daId), chSig(dbId), chSig(dcId)],
      gate,
      gateInit,
      focModelSource: this.focModelSource,
      activePathMode: this.activePathMode,
      cauerSig,
      eonInclQrr,
      useDptMatrix: this.useDptMatrixInFoc,
      dptMatrixLen: this.dptMatrix.length,
      params: paramIds.map((id) => valOf(id)),
    });
  }

  private invalidateFocCaches(clearSim: boolean = true): void {
    this.lastFocStall = null;
    const stallAngEl = document.getElementById('focKpiStallAngle');
    const stallSafeEl = document.getElementById('focKpiStallSafe');
    if (stallAngEl) stallAngEl.innerText = '--';
    if (stallSafeEl) {
      stallSafeEl.innerText = '--';
      stallSafeEl.className = 'text-emerald-300 font-semibold mt-0.5';
    }
    if (clearSim) {
      this.lastFocSim = null;
      this.lastFocSimFingerprint = null;
      this.lastFocSweep = null;
      const hotEl = document.getElementById('focKpiHottest');
      const pwrEl = document.getElementById('focKpiPower');
      if (hotEl) hotEl.innerText = '--';
      if (pwrEl) pwrEl.innerText = '--';
      const tbody = document.getElementById('focSwitchTableBody');
      if (tbody) {
        tbody.innerHTML =
          '<tr><td colspan="8" class="px-2 py-3 text-center text-slate-500 font-sans">参数或通道已变更，请重新点击 Run 6-MOS Coupled Tj(t) 刷新结果。</td></tr>';
      }
      this.renderFocWarnings();
    }
    if (this.activeTab === 'foc') {
      this.drawFocCanvas();
    }
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
      eossUj: Math.max(0, num('focEossInput', 0)),
      qrrNc: Math.max(0, num('focQrrInput', 60)),
      vRefV: Math.max(1, num('focVrefInput', 48)),
      iRefA: Math.max(1, num('focIrefInput', 30)),
      eonIncludesQrr: (document.getElementById('focEonIncludesQrrChk') as HTMLInputElement | null)?.checked ?? false,
      dptLut: this.useDptMatrixInFoc && this.dptMatrix.length > 0 ? this.dptMatrix.map((pt) => ({ ...pt })) : undefined,
    };
    const ctrl: FocControlParams = {
      modulation: mod,
      fswHz: Math.max(100, num('focFswKhzInput', 20) * 1e3),
      tDeadNs: Math.max(0, num('focTdeadNsInput', 500)),
      modDepthM: Math.max(0, Math.min(1.2, num('focModDepthInput', 0.85))),
      pfAngleDeg: num('focPfAngleInput', 0),
      tAmbC: num('focTambInput', 25),
      vBusConstV: Math.max(1, num('focVbusConstInput', 48)),
    };
    return { mos, ctrl, model: this.getActiveFocModel() };
  }

  private readFiniteInput(id: string, fallback: number): number {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return fallback;
    const raw = el.value.trim();
    if (!raw) return fallback;
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private renderFocWarnings(extra: string[] = []): void {
    const box = document.getElementById('focSimWarningsBox');
    if (!box) return;
    const msgs: string[] = [];
    const seen = new Set<string>();
    const pushUnique = (line: string) => {
      if (!seen.has(line)) {
        seen.add(line);
        msgs.push(line);
      }
    };
    const model = this.getActiveFocModel();
    if (model.splitFeasible === false) {
      pushUnique(`✖ 物理拆分不可行 (splitFeasible=false): ${model.provenanceNote || 'RθJC 约束超过反演总热阻'}`);
    } else if (model.provenanceNote) {
      pushUnique(`▲ 模型来源: ${model.provenanceNote}`);
    }
    if (model.zthValidation && !model.zthValidation.passed) {
      pushUnique(
        `▲ Cauer Zth 拆分阶跃一致性检验未通过: 最大偏差 ${model.zthValidation.maxRelErrPct.toFixed(1)}% (R_orig=${model.zthValidation.rthOrig.toFixed(3)} vs R_split=${model.zthValidation.rthSplit.toFixed(3)})`
      );
    }
    if (model.splitMeta?.warning && !model.isHeuristicSingleStageSplit) {
      pushUnique(`▲ Cauer 拆分提示: ${model.splitMeta.warning}`);
    }
    if (model.perSwitchRjcScale && model.perSwitchRjcScale.some((v) => Math.abs(v - 1) > 1e-4)) {
      pushUnique(`ℹ 已启用 PCB 空间非对称热阻 (BH/BL 中臂与 CH/CL 边缘臂差异化耦合)。`);
    }
    if (this.activeFocHandoffNote) {
      pushUnique(`ℹ DynoLab 数据传递边界: ${this.activeFocHandoffNote}`);
    }
    for (const m of extra) {
      const formatted = m.startsWith('▲') || m.startsWith('ℹ') || m.startsWith('✖') ? m : `▲ ${m}`;
      pushUnique(formatted);
    }
    if (msgs.length === 0) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    box.classList.remove('hidden');
    box.innerHTML = msgs.map((m) => `<div>${escapeHtml(m)}</div>`).join('');
  }

  private refreshFocModelAndSpice(): void {
    const model = this.getActiveFocModel();
    const tAmb = this.readFiniteInput('focTambInput', 25);
    const rJc = model.zthJC.reduce((s, c) => s + c.r, 0);
    const rBrd = model.zthBoard.reduce((s, c) => s + c.r, 0);

    const badgeEl = document.getElementById('focModelSummaryBadge');
    if (badgeEl) {
      badgeEl.innerText = `JC(${model.zthJC.length})=${rJc.toFixed(3)} + Brd(${model.zthBoard.length})=${rBrd.toFixed(3)} °C/W`;
    }

    const zthBadge = document.getElementById('focZthValidBadge');
    if (zthBadge) {
      if (model.splitFeasible === false) {
        zthBadge.innerText = 'SPLIT INFEASIBLE';
        zthBadge.className = 'px-1.5 py-0.5 bg-red-950/75 border border-red-500/60 text-red-200 font-mono text-[10px] rounded-xs';
      } else if (model.zthValidation) {
        zthBadge.innerText = model.zthValidation.passed
          ? `Zth Split OK (${model.zthValidation.maxRelErrPct.toFixed(1)}%)`
          : `Zth Mismatch (${model.zthValidation.maxRelErrPct.toFixed(1)}%)`;
        zthBadge.className = model.zthValidation.passed
          ? 'px-1.5 py-0.5 bg-emerald-950/70 border border-emerald-500/60 text-emerald-300 font-mono text-[10px] rounded-xs'
          : 'px-1.5 py-0.5 bg-amber-950/75 border border-amber-500/60 text-amber-200 font-mono text-[10px] rounded-xs';
      } else {
        zthBadge.innerText = 'Zth Preset';
        zthBadge.className = 'px-1.5 py-0.5 bg-[#12161c] border border-[#222933] text-slate-300 font-mono text-[10px] rounded-xs';
      }
    }

    const srcBadge = document.getElementById('focModelSourceBadge');
    if (srcBadge) {
      if (model.splitFeasible === false) {
        srcBadge.innerText = '来源: RθJC 拆分冲突 (不可信)';
        srcBadge.className =
          'px-1.5 py-0.5 bg-red-950/75 border border-red-500/60 text-red-200 font-mono text-[10px] rounded-xs';
      } else if (this.focModelSource === 'tab1_extracted') {
        srcBadge.innerText = `来源: Tab 1 反演 (${this.activeCauerStages.length} 阶)`;
        srcBadge.className =
          'px-1.5 py-0.5 bg-emerald-950/70 border border-emerald-500/60 text-emerald-300 font-mono text-[10px] rounded-xs';
      } else if (this.focModelSource === 'default_demo') {
        srcBadge.innerText = '来源: Demo 自带默认模型';
        srcBadge.className =
          'px-1.5 py-0.5 bg-cyan-950/70 border border-cyan-500/60 text-cyan-300 font-mono text-[10px] rounded-xs';
      } else {
        srcBadge.innerText = '来源: 系统默认 Fallback 模型';
        srcBadge.className =
          'px-1.5 py-0.5 bg-slate-800 border border-slate-600/70 text-slate-300 font-mono text-[10px] rounded-xs';
      }
    }

    const singleWarn = document.getElementById('focSingleStageWarning');
    if (singleWarn) {
      singleWarn.classList.toggle('hidden', !model.isHeuristicSingleStageSplit);
    }

    const box = document.getElementById('focSpiceTextarea') as HTMLTextAreaElement | null;
    const spBadge = document.getElementById('focSpiceValidBadge');
    if (model.splitFeasible === false) {
      const reason =
        model.splitMeta?.warning ||
        'JC/Board 热路径拆分未通过物理约束校验（请补充器件手册 RθJC 约束），已阻止生成 6-MOS LTspice 热网络。';
      if (box) box.value = `* [SPICE EXPORT BLOCKED]\n* ${reason}`;
      if (spBadge) {
        spBadge.innerText = 'SPICE BLOCKED';
        spBadge.title = reason;
        spBadge.className = 'px-1.5 py-0.5 bg-red-950/75 border border-red-500/60 text-red-200 font-mono text-[10px] rounded-xs';
      }
      return;
    }

    const netlist = focModelToSpice(model, tAmb, 'INV_6MOS_THERM');
    const val = validateFocSpiceNetlist(netlist, model);
    if (box) box.value = netlist;

    if (spBadge) {
      spBadge.innerText = val.valid
        ? val.nodalMathVerified
          ? 'NETLIST & NODAL VERIFIED'
          : 'SYNTAX VALID'
        : 'NETLIST ERROR';
      spBadge.title = val.valid
        ? `Rjc=${val.rJcParsed.toFixed(4)} °C/W, Rbrd=${val.rBrdParsed.toFixed(4)} °C/W, DC nodal err=${val.dcCommonModeError.toExponential(1)}`
        : val.errors.join('; ');
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
    daCh: WaveformChannel | null;
    dbCh: WaveformChannel | null;
    dcCh: WaveformChannel | null;
    gateThermalMode: 'preheat' | 'cold';
    rng: { tStart?: number; tEnd?: number };
  } | null {
    const tab = this.app.getActiveTab();
    const iaId = (document.getElementById('focIaSelect') as HTMLSelectElement)?.value;
    const ibId = (document.getElementById('focIbSelect') as HTMLSelectElement)?.value;
    const icId = (document.getElementById('focIcSelect') as HTMLSelectElement)?.value;
    const vbusId = (document.getElementById('focVbusSelect') as HTMLSelectElement)?.value;
    const daId = (document.getElementById('focDaSelect') as HTMLSelectElement)?.value;
    const dbId = (document.getElementById('focDbSelect') as HTMLSelectElement)?.value;
    const dcId = (document.getElementById('focDcSelect') as HTMLSelectElement)?.value;
    const gate = ((document.getElementById('focGateSelect') as HTMLSelectElement)?.value || 'entire') as 'entire' | 'view' | 'cursors';
    const gateThermalMode = ((document.getElementById('focGateInitSelect') as HTMLSelectElement)?.value || 'preheat') as 'preheat' | 'cold';
    const iaCh = tab?.channels[iaId];
    const ibCh = tab?.channels[ibId];
    if (!tab || !iaCh || !ibCh) return null;
    const icCh = icId && icId !== '__auto__' ? tab.channels[icId] || null : null;
    const vbusCh = vbusId && vbusId !== '__const__' ? tab.channels[vbusId] || null : null;
    const daCh = daId && daId !== '__auto__' ? tab.channels[daId] || null : null;
    const dbCh = dbId && dbId !== '__auto__' ? tab.channels[dbId] || null : null;
    const dcCh = dcId && dcId !== '__auto__' ? tab.channels[dcId] || null : null;
    const rng = getChannelGateRange(tab, iaCh, gate);
    return { tab, iaCh, ibCh, icCh, vbusCh, daCh, dbCh, dcCh, gateThermalMode, rng };
  }

  private runFocSimulation(): void {
    const sel = this.getFocSelectedChannels();
    if (!sel) {
      this.app.showToast('Please select Ia & Ib phase current channels (or click Load FOC 3-Ph Demo).', 'warn');
      return;
    }
    if (sel.iaCh.id === sel.ibCh.id) {
      this.app.showToast(
        'Ia 与 Ib 不能选择同一通道：单电阻 (Single-Shunt) 采样系统需先重构三相相电流 Ia/Ib/Ic 后再仿真。',
        'error'
      );
      return;
    }
    try {
      this.refreshFocModelAndSpice();
      const { mos, ctrl, model } = this.readFocParams();
      const res = simulateFoc6Mos(sel.iaCh, sel.ibCh, model, mos, ctrl, {
        tStart: sel.rng.tStart,
        tEnd: sel.rng.tEnd,
        gateThermalMode: sel.gateThermalMode,
        icCh: sel.icCh,
        vbusCh: sel.vbusCh,
        dutyChs: sel.daCh || sel.dbCh || sel.dcCh ? { da: sel.daCh, db: sel.dbCh, dc: sel.dcCh } : undefined,
      });
      this.lastFocSim = res;
      this.lastFocSimFingerprint = this.computeFocInputFingerprint();
      this.lastFocStall = null;
      this.focCanvasMode = 'tj';
      this.syncFocViewButtons();
      this.renderFocWarnings(res.warnings);

      const hotEl = document.getElementById('focKpiHottest');
      if (hotEl) {
        hotEl.innerText = `${res.hottestKey}: ${res.tjMaxGlobalC.toFixed(2)}°C (${
          res.steadyThermalRunaway ? '稳态热失控!' : `稳态~${res.tjSteadyMaxEstC.toFixed(1)}°C`
        })`;
      }
      const pwrEl = document.getElementById('focKpiPower');
      if (pwrEl) {
        pwrEl.innerText = `${res.pInvMeanW.toFixed(2)} W / ${res.tBoardFinalC.toFixed(1)}°C (${
          res.steadyThermalRunaway ? '热失控' : `稳态~${res.tBoardSteadyEstC.toFixed(1)}°C`
        }, 保守收敛 ${res.thermalConvergencePct.toFixed(0)}% / 六结 ${res.junctionConvergencePct.toFixed(0)}%)`;
      }

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
      const dutyNote = res.dutySource === 'external' ? '外部 Duty_A/B/C' : ctrl.modulation;
      const steadyNote = res.steadyThermalRunaway ? '稳态热失控!' : `稳态~${res.tjSteadyMaxEstC.toFixed(1)}°C`;
      this.app.showToast(
        `6-MOS FOC (${dutyNote}): ${res.hottestKey} Peak=${res.tjMaxGlobalC.toFixed(2)}°C (${steadyNote}), P_inv=${res.pInvMeanW.toFixed(2)}W`,
        res.overmodulatedCount > 0 || res.warnings.length > 0 ? 'warn' : 'info'
      );
    } catch (err: any) {
      this.renderFocWarnings([`✖ ${err?.message || err}`]);
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
      toastMessage: `Injected Tj_AH..CL & P_inv_total (${sim.hottestKey} Peak=${sim.tjMaxGlobalC.toFixed(2)} °C) to scope.`,
    });
  }

  private runFocStallAnalysis(): void {
    try {
      this.refreshFocModelAndSpice();
      const { mos, ctrl, model } = this.readFocParams();
      const iPeakA = Math.max(0.5, this.readFiniteInput('focStallIpkInput', 35));
      const tjLimitC = Math.max(40, this.readFiniteInput('focStallLimitInput', 150));
      const rPhaseOhm = Math.max(0.001, this.readFiniteInput('focStallRsInput', 0.25));
      const stallDutyMode = ((document.getElementById('focStallDutyModeSelect') as HTMLSelectElement)?.value || 'resistive') as 'resistive' | 'user_m';

      const currentFingerprint = this.computeFocInputFingerprint();
      const validHotSim =
        this.lastFocSim && this.lastFocSimFingerprint === currentFingerprint ? this.lastFocSim : null;
      if (!validHotSim && this.lastFocSim) {
        this.lastFocSim = null;
        this.lastFocSimFingerprint = null;
      }

      const res = runFocStallSweep({
        iPeakA,
        tjLimitC,
        tAmbC: ctrl.tAmbC,
        tInitialBoardC: validHotSim ? validHotSim.tBoardFinalC : undefined,
        initialThermalState: validHotSim ? validHotSim.finalThermalState : undefined,
        modulation: ctrl.modulation,
        modDepthM: ctrl.modDepthM,
        pfAngleDeg: ctrl.pfAngleDeg,
        fswHz: ctrl.fswHz,
        tDeadNs: ctrl.tDeadNs,
        mos,
        model,
        vBusV: ctrl.vBusConstV,
        horizonSec: 120,
        stallDutyMode,
        rPhaseOhm,
      });
      this.lastFocStall = res;
      this.focCanvasMode = 'stall';
      this.syncFocViewButtons();

      const stallWarnings: string[] = [
        ...res.warnings,
        `堵转扫描条件: ${res.effectiveStallModulation} (m_eff=${res.effectiveStallModDepthM.toFixed(3)}, PF φ=${res.effectiveStallPfAngleDeg.toFixed(1)}°, R_s=${res.rPhaseUsedOhm.toFixed(3)}Ω), t_safe/I²t 基于宏观 Cauer Tj_limit=${tjLimitC}°C 热稳态/瞬态越限（非数据手册绝热短路 SOA 极限）。`,
      ];
      // inheritedMaxTjC is non-null exactly when inheritedFullThermalState is true
      // (both derive from hasValidInitialState in focThermal.ts), so this extra
      // check is a no-op at runtime but lets TypeScript narrow the nullable field.
      if (res.inheritedFullThermalState && res.inheritedMaxTjC !== null) {
        stallWarnings.push(
          `热态初温继承: 已加载最近一次 6-MOS 瞬态完整热网络节点状态 (T_board_init=${res.inheritedBoardTempC.toFixed(1)}°C, Tj_max_init=${res.inheritedMaxTjC.toFixed(1)}°C)。`
        );
      } else if (res.inheritedHotState) {
        stallWarnings.push(
          `热态初温继承: 仅使用标量 Board 初温 ${res.inheritedBoardTempC.toFixed(1)}°C 初始化所有热网络节点；没有完整 6-MOS 热历史，初始结温 Tj_max 未知，不能代表真实结温梯度。`
        );
      } else {
        stallWarnings.push(
          `冷态初温: 当前无有效 6-MOS 瞬态仿真历史，堵转扫描从环境温度 T_amb=${ctrl.tAmbC.toFixed(1)}°C 冷启动。`
        );
      }
      if (res.stallVoltageLimited) {
        stallWarnings.push(
          `▲ 堵转目标电流 I_pk=${iPeakA.toFixed(1)}A 在 R_s=${res.rPhaseUsedOhm.toFixed(3)}Ω 下所需调制比已触及 SVPWM 线性上限 (${res.effectiveStallModDepthM.toFixed(3)})，实际母线可能受限压能力约束。`
        );
      }
      if (res.stallThermalRunaway) {
        stallWarnings.push(
          `▲ 最热电角度 (${res.worstAngleDeg}°, ${res.worstSwitch}) 在 Rds(on) 正温度反馈下发生热失控或稳态未收敛。`
        );
      }
      this.renderFocWarnings(stallWarnings);

      const angEl = document.getElementById('focKpiStallAngle');
      if (angEl) {
        angEl.innerText = `${res.worstAngleDeg}° (${res.worstSwitch}: ${
          res.stallThermalRunaway ? '热失控!' : `${res.worstSteadyTjC.toFixed(1)}°C`
        })`;
      }
      const safeEl = document.getElementById('focKpiStallSafe');
      if (safeEl) {
        safeEl.innerText = res.tSafeSec !== null
          ? `t_safe=${res.tSafeSec.toFixed(2)}s @ θ=${res.tSafeAngleDeg}°/${res.transientWorstSwitch} · 正弦等效 I²t:${res.i2tRmsA2s?.toFixed(0)} / 最不利相 I²t:${res.i2tWorstLegA2s?.toFixed(0)} A²s${res.stallVoltageLimited ? ' · 请求电流超出线性调制电压能力（条件估算）' : ''}`
          : !res.stallSteadyConverged
          ? '稳态求解未收敛（不可判 SAFE）'
          : res.stallThermalRunaway
          ? '热失控（不可判 SAFE）'
          : res.stallVoltageLimited
          ? '请求电流超出线性调制电压能力；热结果仅为强制电流假设，不可判 SAFE'
          : res.steadySafe
          ? `稳态安全；本时域 ${res.transientTime[res.transientTime.length - 1].toFixed(0)}s 未越限`
          : `稳态超限；本时域未越限`;
        const transientThermalLimitCrossed = res.tSafeSec !== null;
        safeEl.className = res.steadySafe && !transientThermalLimitCrossed ? 'text-emerald-300 font-semibold' : 'text-rose-300 font-semibold';
      }

      this.drawFocCanvas();
      this.app.showToast(
        `Stall Sweep (${res.effectiveStallModulation}, m=${res.effectiveStallModDepthM.toFixed(3)}, R_s=${res.rPhaseUsedOhm.toFixed(3)}Ω, init=${res.inheritedBoardTempC.toFixed(1)}°C): Worst ${res.worstSwitch} @ θ=${res.worstAngleDeg}° (${res.stallThermalRunaway ? '热失控' : `${res.worstSteadyTjC.toFixed(1)}°C steady`})`,
        res.steadySafe && res.tSafeSec === null && !res.stallVoltageLimited ? 'info' : 'warn'
      );
    } catch (err: any) {
      this.app.showToast(`Stall sweep failed: ${err?.message || err}`, 'error');
    }
  }

  private runFocControlSweepAnalysis(): void {
    const sel = this.getFocSelectedChannels();
    if (!sel) {
      this.app.showToast('Please select Ia & Ib channels first (or Load FOC 3-Ph Demo).', 'warn');
      return;
    }
    if (sel.iaCh.id === sel.ibCh.id) {
      this.app.showToast(
        'Ia 与 Ib 不能选择同一通道：单电阻 (Single-Shunt) 采样系统需先重构三相相电流 Ia/Ib/Ic 后再扫频。',
        'error'
      );
      return;
    }
    try {
      this.refreshFocModelAndSpice();
      const { mos, ctrl, model } = this.readFocParams();
      const res = runFocControlSweep(sel.iaCh, sel.ibCh, model, mos, ctrl, {
        tStart: sel.rng.tStart,
        tEnd: sel.rng.tEnd,
        gateThermalMode: sel.gateThermalMode,
        icCh: sel.icCh,
        vbusCh: sel.vbusCh,
      });
      this.lastFocSweep = res;
      this.focCanvasMode = 'sweep';
      this.syncFocViewButtons();

      const extraNotes = [...res.svpwm.alignmentWarnings];
      if (sel.daCh && sel.dbCh && sel.dcCh) {
        extraNotes.push('调制策略扫频仅比较理论重构波形 (SVPWM vs DPWM1 vs SPWM)，已忽略外部 Duty_A/B/C 选择。');
      }
      this.renderFocWarnings(extraNotes);
      this.drawFocCanvas();

      const pSave = res.svpwm.pInvMeanW - res.dpwm1.pInvMeanW;
      this.app.showToast(
        `SVPWM (${res.svpwm.pInvMeanW.toFixed(2)}W, ${res.svpwm.tjMaxGlobalC.toFixed(2)}°C) vs DPWM1 (${res.dpwm1.pInvMeanW.toFixed(2)}W, ${res.dpwm1.tjMaxGlobalC.toFixed(2)}°C) -> Saves ${pSave.toFixed(2)} W`,
        'info'
      );
    } catch (err: any) {
      this.app.showToast(`FOC control sweep failed: ${err?.message || err}`, 'error');
    }
  }

  private drawFocCanvas(): void {
    const canvas = document.getElementById('focMainCanvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const prep = prepareHiDpiCanvas(canvas);
    if (!prep) return;
    const { ctx, w, h } = prep;
    const th = this.getCanvasTheme();
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, w, h);

    const pad = { l: 54, r: 18, t: 22, b: 28 };
    const pw = Math.max(20, w - pad.l - pad.r);
    const ph = Math.max(20, h - pad.t - pad.b);

    const drawGrid = () => {
      ctx.strokeStyle = th.grid;
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
      ctx.strokeStyle = th.frame;
      ctx.strokeRect(pad.l, pad.t, pw, ph);
    };

    const titleEl = document.getElementById('focCanvasTitle');

    if (this.focCanvasMode === 'tj') {
      if (titleEl) titleEl.innerText = '6-MOS Coupled Junction Temperature Tj(t)';
      const sim = this.lastFocSim;
      if (!sim || sim.time.length < 2) {
        ctx.fillStyle = th.emptyText;
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
      ctx.strokeStyle = th.tBoard;
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

      const colors = th.focColors;
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

      ctx.fillStyle = th.axisText;
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
      ctx.fillStyle = th.titleText;
      ctx.fillText(`6-MOS Tj(t) + T_board (dashed) · Peak ${sim.hottestKey}=${sim.tjMaxGlobalC.toFixed(2)}°C`, pad.l + 6, pad.t - 6);
    } else if (this.focCanvasMode === 'stall') {
      if (titleEl) titleEl.innerText = 'Locked-Rotor Steady Max Tj vs Electrical Angle (0°..360°)';
      const st = this.lastFocStall;
      if (!st || st.anglesDeg.length === 0) {
        ctx.fillStyle = th.emptyText;
        ctx.font = '12px "IBM Plex Sans", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Click "Run Stall Sweep & I²t Protection" to inspect 0°..360° thermal hotspots', w / 2, h / 2);
        return;
      }
      drawGrid();
      const tjLimit = Math.max(40, this.readFiniteInput('focStallLimitInput', 150));
      let yMin = Math.min(...st.steadyMaxTjPerAngle);
      let yMax = Math.max(tjLimit * 1.05, ...st.steadyMaxTjPerAngle);
      const ys = Math.max(5, yMax - yMin);
      yMin -= ys * 0.08;
      yMax += ys * 0.08;

      const xOf = (deg: number) => pad.l + (deg / 360) * pw;
      const yOf = (v: number) => pad.t + ph - ((v - yMin) / (yMax - yMin)) * ph;

      // Tj_limit line
      if (tjLimit >= yMin && tjLimit <= yMax) {
        ctx.strokeStyle = th.redDashed;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(pad.l, yOf(tjLimit));
        ctx.lineTo(pad.l + pw, yOf(tjLimit));
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.strokeStyle = th.orange;
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
      ctx.fillStyle = th.red;
      ctx.beginPath();
      ctx.arc(xOf(st.worstAngleDeg), yOf(st.worstSteadyTjC), 5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = th.axisText;
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
      ctx.fillStyle = th.titleText;
      ctx.fillText(`Steady worst: ${st.worstSwitch} @ ${st.worstAngleDeg}° · t_safe: ${st.tSafeSec === null ? `not crossed within ${st.transientTime[st.transientTime.length - 1].toFixed(2)}s` : `${st.tSafeSec.toFixed(2)}s @ ${st.tSafeAngleDeg}° / ${st.transientWorstSwitch}`} · I² ratio ${st.phaseSquaredRatioAtWorst.toFixed(2)}×`, pad.l + 6, pad.t - 6);
    } else {
      if (titleEl) titleEl.innerText = 'Carrier Frequency Trade-off: SVPWM vs DPWM1 Total Loss (W)';
      const sw = this.lastFocSweep;
      if (!sw || sw.fswListHz.length === 0) {
        ctx.fillStyle = th.emptyText;
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

      drawSeries(sw.pMeanSvpwmByFsw, th.cyan);
      drawSeries(sw.pMeanDpwm1ByFsw, th.green);

      ctx.fillStyle = th.axisText;
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      for (let i = 0; i <= 4; i++) {
        ctx.fillText(`${(yMax - ((yMax - yMin) * i) / 4).toFixed(1)}W`, pad.l - 6, pad.t + (ph * i) / 4 + 3);
      }
      ctx.textAlign = 'center';
      sw.fswListHz.forEach((f) => ctx.fillText(`${(f / 1000).toFixed(0)}k`, xOf(f), pad.t + ph + 15));
      ctx.textAlign = 'left';
      ctx.fillStyle = th.titleText;
      ctx.fillText('SVPWM (blue) vs DPWM1 60°-Clamp (green) Inverter Total Loss [W] vs f_sw (Hz)', pad.l + 6, pad.t - 6);
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
    this.lastActiveTabId = newTab.id;
    // Do NOT wipe Tab 2's activeCauerStages when loading FOC Demo!
    this.focModelSource = 'default_demo';
    this.activeFocHandoffNote = null;
    this.updateCauerSummaryBox();
    this.invalidateFocCaches(true);
    this.populateChannelSelectors();
    this.refreshFocModelAndSpice();
    this.runFocSimulation();
  }

  public loadExternalFocAnalysis(payload: FocThermalHandoffPayload): void {
    this.app.addTab(payload.tab);
    this.lastActiveTabId = payload.tab.id;
    this.openModal();
    this.switchTab('foc');
    this.invalidateFocCaches(true);
    this.populateChannelSelectors();

    const setVal = (id: string, val: string | number) => {
      const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
      if (el) el.value = String(val);
    };

    setVal('focIaSelect', payload.iaChannelId);
    setVal('focIbSelect', payload.ibChannelId);
    setVal('focIcSelect', payload.icChannelId);
    setVal('focVbusSelect', payload.vbusChannelId);
    setVal('focDaSelect', payload.daChannelId || '__auto__');
    setVal('focDbSelect', payload.dbChannelId || '__auto__');
    setVal('focDcSelect', payload.dcChannelId || '__auto__');
    setVal('focGateSelect', 'entire');
    setVal('focVbusConstInput', payload.vBusConstV);
    setVal('focTambInput', payload.tAmbC);
    setVal('focModSelect', payload.modulation || 'SVPWM');
    setVal('focModDepthInput', payload.modDepthM);
    setVal('focPfAngleInput', payload.pfAngleDeg);
    setVal('focFswKhzInput', payload.fswKhz);
    setVal('focTdeadNsInput', payload.tDeadNs);
    setVal('focRdsInput', payload.rdsOnMOhm);
    setVal('focVsdInput', payload.vsdV);
    if (typeof payload.rsPhaseOhm === 'number' && Number.isFinite(payload.rsPhaseOhm) && payload.rsPhaseOhm > 0) {
      setVal('focStallRsInput', payload.rsPhaseOhm.toFixed(4));
    }

    this.activeFocHandoffNote =
      payload.handoffNote ||
      '已从外部导入波形与基本参数；开关/热系数 α、Esw、Eoss、Qrr、Vref、Iref 仍采用当前 MOS Thermal 面板数值。';

    this.runFocSimulation();
  }

  // ==================== P1: Double Pulse Test (DPT) Methods ====================

  private loadDptDemoTab(): void {
    const { vgsCh, vdsCh, idsCh } = generateDptDemoChannels();
    const newTab: TabState = {
      id: `dpt_demo_${Date.now()}`,
      fileName: 'MOS_DPT_48V_45A_Demo.csv',
      channels: {
        [vgsCh.id]: vgsCh,
        [vdsCh.id]: vdsCh,
        [idsCh.id]: idsCh,
      },
      drawOrder: [vgsCh.id, vdsCh.id, idsCh.id],
      activeChannelId: vdsCh.id,
      separateView: true,
      plotMode: 'time',
      view: { startIndex: 0, endIndex: vdsCh.t.length },
      cursors: { enabled: false, mode: 'off', x1: null, x2: null, y1: null, y2: null, trackingChannel: vdsCh.id },
      measurementGate: 'view',
      selectedMeasurements: [],
      triggerConfig: { enabled: false, channelId: vgsCh.id, type: 'rising', level: 5, positionPercent: 10 },
      fftOptions: { window: 'hann', scale: 'db', range: 'view', removeDC: true, zeroPadding: 1 },
      motorConfig: { enabled: false, rpm: null, polePairs: null },
      annotations: [],
      annotationMode: false,
      annotationsVisible: true,
      isOverlap: false,
    };

    this.app.addTab(newTab);
    this.lastActiveTabId = newTab.id;
    this.populateChannelSelectors();
    const setSel = (id: string, val: string) => {
      const el = document.getElementById(id) as HTMLSelectElement | null;
      if (el) el.value = val;
    };
    setSel('dptVgsSelect', vgsCh.id);
    setSel('dptVdsSelect', vdsCh.id);
    setSel('dptIdsSelect', idsCh.id);
    setSel('dptGateSelect', 'entire');
    const deskewInp = document.getElementById('dptDeskewInput') as HTMLInputElement | null;
    if (deskewInp) deskewInp.value = '0';
    this.switchTab('dpt');
    this.runDptAnalysis();
  }

  private runDptAnalysis(): void {
    const tab = this.app.getActiveTab();
    const vgsId = (document.getElementById('dptVgsSelect') as HTMLSelectElement)?.value;
    const vdsId = (document.getElementById('dptVdsSelect') as HTMLSelectElement)?.value;
    const idsId = (document.getElementById('dptIdsSelect') as HTMLSelectElement)?.value;
    const vgsCh = tab?.channels[vgsId];
    const vdsCh = tab?.channels[vdsId];
    const idsCh = tab?.channels[idsId];
    if (!tab || !vgsCh || !vdsCh || !idsCh) {
      this.app.showToast('Please select Vgs, Vds, and Ids channels (or Load DPT Demo).', 'warn');
      return;
    }

    const gate = ((document.getElementById('dptGateSelect') as HTMLSelectElement)?.value || 'entire') as 'entire' | 'view' | 'cursors';
    const rng = getChannelGateRange(tab, vdsCh, gate);
    const deskewNs = parseFloat((document.getElementById('dptDeskewInput') as HTMLInputElement)?.value || '0');
    const vbusRaw = (document.getElementById('dptVbusOverrideInput') as HTMLInputElement)?.value?.trim() || '';
    const vbusVal = parseFloat(vbusRaw);

    try {
      const res = analyzeDoublePulseTest(vgsCh, vdsCh, idsCh, {
        tStart: rng.tStart,
        tEnd: rng.tEnd,
        idsDeskewNs: Number.isFinite(deskewNs) ? deskewNs : 0,
        vBusOverrideV: vbusRaw && Number.isFinite(vbusVal) && vbusVal > 0 ? vbusVal : undefined,
      });
      this.lastDptResult = res;

      const setText = (id: string, txt: string) => {
        const el = document.getElementById(id);
        if (el) el.innerText = txt;
      };
      setText(
        'dptKpiEon',
        res.hasTurnOn ? `${res.eOnUj.toFixed(2)} µJ (净 ${res.eOnSansQrrUj.toFixed(1)})` : '--'
      );
      setText('dptKpiEoff', res.hasTurnOff ? `${res.eOffUj.toFixed(2)} µJ` : '--');
      setText('dptKpiEsw', `${res.eSwTotalUj.toFixed(2)} µJ`);
      setText(
        'dptKpiVdsPeak',
        res.hasTurnOff
          ? `${res.vdsPeakV.toFixed(1)} V (+${res.overshootV.toFixed(1)}V / ${res.overshootPct.toFixed(1)}%)`
          : `${res.vdsPeakV.toFixed(1)} V`
      );
      setText(
        'dptKpiDvDiOff',
        res.hasTurnOff ? `${(res.dvDtOffVPerUs / 1000).toFixed(2)} V/ns · ${res.diDtOffAPerUs.toFixed(0)} A/µs` : '--'
      );
      setText(
        'dptKpiDvDiOn',
        res.hasTurnOn ? `${(res.dvDtOnVPerUs / 1000).toFixed(2)} V/ns · ${res.diDtOnAPerUs.toFixed(0)} A/µs` : '--'
      );
      setText(
        'dptKpiMiller',
        res.vMillerPlateauV !== null && res.tMillerNs !== null
          ? `${res.vMillerPlateauV.toFixed(2)} V / ${res.tMillerNs.toFixed(1)} ns`
          : '--'
      );
      setText(
        'dptKpiQrr',
        res.hasTurnOn ? `${res.iRrPeakA.toFixed(1)} A / ${res.qRrNc.toFixed(1)} nC / ${res.eRecUj.toFixed(2)} µJ` : '--'
      );
      const offR = res.fRingOffMHz !== null ? `${res.fRingOffMHz.toFixed(1)} MHz` : '--';
      const onR = res.fRingOnMHz !== null ? `${res.fRingOnMHz.toFixed(1)} MHz` : '--';
      setText('dptKpiRing', `Off: ${offR} · On: ${onR}`);

      const warnBox = document.getElementById('dptWarningsBox');
      if (warnBox) {
        if (res.warnings.length > 0) {
          warnBox.classList.remove('hidden');
          warnBox.innerHTML = res.warnings.map((w) => `<div>▲ ${escapeHtml(w)}</div>`).join('');
        } else {
          warnBox.classList.add('hidden');
          warnBox.innerHTML = '';
        }
      }

      const applyBtn = document.getElementById('dptApplyToFocBtn') as HTMLButtonElement | null;
      if (applyBtn) applyBtn.disabled = !res.valid || res.eSwTotalUj <= 0;

      this.drawDptCanvas();
      this.app.showToast(
        res.valid
          ? `DPT 提取完成: Eon=${res.eOnUj.toFixed(1)}µJ (含Qrr), Eoff=${res.eOffUj.toFixed(1)}µJ, Vds_peak=${res.vdsPeakV.toFixed(1)}V, Qrr=${res.qRrNc.toFixed(1)}nC`
          : `DPT 解析异常: ${res.warnings[0] || '无效波形'}`,
        res.valid ? 'info' : 'warn'
      );
    } catch (err: any) {
      this.app.showToast(`DPT analysis failed: ${err?.message || err}`, 'error');
    }
  }

  private applyDptResultsToFoc(): void {
    const res = this.lastDptResult;
    if (!res || !res.valid) {
      this.app.showToast('请先运行有效的 DPT 分析。', 'warn');
      return;
    }
    const setVal = (id: string, val: string) => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.value = val;
    };
    setVal('focEswInput', res.eSwTotalUj.toFixed(2));
    setVal('focQrrInput', res.qRrNc.toFixed(1));
    if (res.vBusSteadyV > 1) setVal('focVrefInput', res.vBusSteadyV.toFixed(1));
    if (res.iLoadA > 0.5) setVal('focIrefInput', res.iLoadA.toFixed(1));
    const qrrChk = document.getElementById('focEonIncludesQrrChk') as HTMLInputElement | null;
    if (qrrChk) qrrChk.checked = true;
    this.activeFocHandoffNote = `已同步 Tab 5 双脉冲实测开关损耗 (已自动勾选 Esw 含 Qrr 防重复叠加): Esw=${res.eSwTotalUj.toFixed(2)}µJ (Eon=${res.eOnUj.toFixed(1)} [净 ${res.eOnSansQrrUj.toFixed(1)}] + Eoff=${res.eOffUj.toFixed(1)}), Qrr=${res.qRrNc.toFixed(1)}nC @ Vref=${res.vBusSteadyV.toFixed(1)}V, Iref=${res.iLoadA.toFixed(1)}A。`;
    this.invalidateFocCaches(true);
    this.switchTab('foc');
    this.app.showToast('Synced DPT Esw, Qrr (eonIncludesQrr=true), Vref, Iref into Tab 4 FOC 6-MOS.', 'info');
  }

  private addCurrentDptPointToMatrix(): void {
    const res = this.lastDptResult;
    if (!res || !res.valid) {
      this.app.showToast('请先在 Tab 5 运行一次有效的 DPT 分析，再保存到矩阵。', 'warn');
      return;
    }
    const tjVal = parseFloat((document.getElementById('dptMatrixTjInput') as HTMLInputElement)?.value || '25');
    const rgVal = parseFloat((document.getElementById('dptMatrixRgInput') as HTMLInputElement)?.value || '4.7');
    this.dptMatrix.push({
      id: `dpt_${Date.now()}_${this.dptMatrix.length}`,
      vBusV: res.vBusSteadyV,
      iLoadA: res.iLoadA,
      tjC: Number.isFinite(tjVal) ? tjVal : 25,
      rgOhm: Number.isFinite(rgVal) && rgVal >= 0 ? rgVal : 4.7,
      eOnUj: res.eOnUj,
      eOffUj: res.eOffUj,
      qRrNc: res.qRrNc,
      eOnSansQrrUj: res.eOnSansQrrUj,
    });
    this.renderDptMatrixTable();
    this.app.showToast(
      `已保存工况点到 DPT LUT 矩阵 (Vbus=${res.vBusSteadyV.toFixed(1)}V, I=${res.iLoadA.toFixed(1)}A, Esw=${res.eSwTotalUj.toFixed(2)}µJ)。`,
      'info'
    );
  }

  private renderDptMatrixTable(): void {
    const tbody = document.getElementById('dptMatrixTableBody');
    const applyBtn = document.getElementById('dptApplyMatrixToFocBtn') as HTMLButtonElement | null;
    if (applyBtn) applyBtn.disabled = this.dptMatrix.length === 0;
    if (!tbody) return;
    if (this.dptMatrix.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="9" class="px-2 py-2 text-center text-slate-500 font-sans">尚未保存 DPT 工况点；先运行 DPT 分析后点击「+ 保存当前点到矩阵」积累多电压/电流插值表。</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    this.dptMatrix.forEach((pt, idx) => {
      const tr = document.createElement('tr');
      tr.className = 'border-t border-[#222933]';
      tr.innerHTML = `
        <td class="px-2 py-1">${pt.vBusV.toFixed(1)}</td>
        <td class="px-2 py-1">${pt.iLoadA.toFixed(1)}</td>
        <td class="px-2 py-1">${pt.tjC.toFixed(0)}</td>
        <td class="px-2 py-1">${pt.rgOhm.toFixed(1)}</td>
        <td class="px-2 py-1 text-emerald-300">${pt.eOnUj.toFixed(2)}</td>
        <td class="px-2 py-1 text-amber-300">${pt.eOffUj.toFixed(2)}</td>
        <td class="px-2 py-1 text-cyan-300">${(pt.eOnUj + pt.eOffUj).toFixed(2)}</td>
        <td class="px-2 py-1 text-pink-300">${pt.qRrNc.toFixed(1)}</td>
        <td class="px-2 py-1 text-center"><button type="button" data-dpt-del="${idx}" class="text-slate-400 hover:text-red-300 px-1 cursor-pointer">×</button></td>
      `;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('button[data-dpt-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-dpt-del') || '-1', 10);
        if (idx >= 0) {
          this.dptMatrix.splice(idx, 1);
          this.renderDptMatrixTable();
        }
      });
    });
  }

  private applyDptMatrixToFoc(): void {
    if (this.dptMatrix.length === 0) {
      this.app.showToast('DPT 查找表矩阵为空，请先保存至少 1 个工况点。', 'warn');
      return;
    }
    const vTarget = Math.max(1, this.readFiniteInput('focVbusConstInput', 48));
    const iTarget = Math.max(1, this.readFiniteInput('focIrefInput', 30));
    const interp = interpolateDptSwitchingLoss(this.dptMatrix, vTarget, iTarget);
    if (!interp) return;

    const setVal = (id: string, val: string) => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.value = val;
    };
    setVal('focEswInput', interp.eSwTotalUj.toFixed(2));
    setVal('focQrrInput', interp.qRrNc.toFixed(1));
    setVal('focVrefInput', vTarget.toFixed(1));
    const qrrChk = document.getElementById('focEonIncludesQrrChk') as HTMLInputElement | null;
    if (qrrChk) qrrChk.checked = true;
    this.useDptMatrixInFoc = true;
    const extrapNote = interp.extrapolated
      ? `（注：参考点超出 LUT 范围 [${interp.vRange[0].toFixed(1)}~${interp.vRange[1].toFixed(1)}]V × [${interp.iRange[0].toFixed(1)}~${interp.iRange[1].toFixed(1)}]A）`
      : '';
    this.activeFocHandoffNote = `已激活 Tab 5 的 ${this.dptMatrix.length} 点 DPT 查找表用于 6-MOS 逐点 (Vbus, |I_phase|) 插值 (eonIncludesQrr=true)${extrapNote}；参考标量 @ (${vTarget.toFixed(1)}V, ${iTarget.toFixed(1)}A): Esw=${interp.eSwTotalUj.toFixed(2)}µJ, Qrr=${interp.qRrNc.toFixed(1)}nC。`;
    this.invalidateFocCaches(true);
    this.switchTab('foc');
    this.app.showToast(`Activated ${this.dptMatrix.length}-point DPT LUT -> FOC Tab 4.`, interp.extrapolated ? 'warn' : 'info');
  }

  private drawDptCanvas(): void {
    const canvas = document.getElementById('dptPreviewCanvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const prep = prepareHiDpiCanvas(canvas);
    if (!prep) return;
    const { ctx, w, h } = prep;
    const th = this.getCanvasTheme();
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, w, h);

    const res = this.lastDptResult;
    if (!res || res.time.length < 4 || (!res.offWindow && !res.onWindow)) {
      ctx.fillStyle = th.emptyText;
      ctx.font = '11px "IBM Plex Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Click "Load DPT Demo" or select Vgs/Vds/Ids and run "Analyze DPT Pulse".', w / 2, h / 2);
      return;
    }

    const panels: Array<{ title: string; win: NonNullable<DptAnalysisResult['offWindow']>; eUj: number }> = [];
    if (res.offWindow) panels.push({ title: 'Turn-Off', win: res.offWindow, eUj: res.eOffUj });
    if (res.onWindow) panels.push({ title: 'Turn-On + Qrr', win: res.onWindow, eUj: res.eOnUj });

    const gap = 14;
    const panelW = panels.length === 2 ? Math.floor((w - gap) / 2) : w;

    panels.forEach((p, pIdx) => {
      const ox = pIdx * (panelW + gap);
      const pad = { l: 42, r: 10, t: 22, b: 24 };
      const pw = Math.max(20, panelW - pad.l - pad.r);
      const ph = Math.max(20, h - pad.t - pad.b);

      ctx.strokeStyle = th.grid;
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = pad.t + (ph * i) / 4;
        ctx.beginPath();
        ctx.moveTo(ox + pad.l, y);
        ctx.lineTo(ox + pad.l + pw, y);
        ctx.stroke();
      }
      ctx.strokeStyle = th.frame;
      ctx.strokeRect(ox + pad.l, pad.t, pw, ph);

      const i0 = Math.max(0, p.win.tStartIdx - Math.max(8, Math.round((p.win.tEndIdx - p.win.tStartIdx) * 0.45)));
      const i1 = Math.min(
        res.time.length - 1,
        p.win.tEndIdx + Math.max(12, Math.round((p.win.tEndIdx - p.win.tStartIdx) * 0.65))
      );
      const t0 = res.time[i0];
      const t1 = res.time[i1];
      const tSpan = Math.max(1e-12, t1 - t0);

      let vgsMin = Infinity, vgsMax = -Infinity;
      let vdsMin = Infinity, vdsMax = -Infinity;
      let idsMin = Infinity, idsMax = -Infinity;
      for (let i = i0; i <= i1; i++) {
        if (res.vgs[i] < vgsMin) vgsMin = res.vgs[i];
        if (res.vgs[i] > vgsMax) vgsMax = res.vgs[i];
        if (res.vds[i] < vdsMin) vdsMin = res.vds[i];
        if (res.vds[i] > vdsMax) vdsMax = res.vds[i];
        if (res.ids[i] < idsMin) idsMin = res.ids[i];
        if (res.ids[i] > idsMax) idsMax = res.ids[i];
      }
      vgsMin = Math.min(-2, vgsMin);
      vgsMax = Math.max(12, vgsMax * 1.1);
      vdsMin = Math.min(0, vdsMin);
      vdsMax = Math.max(10, vdsMax * 1.08);
      idsMin = Math.min(0, idsMin);
      idsMax = Math.max(5, idsMax * 1.12);

      const xOf = (t: number) => ox + pad.l + ((t - t0) / tSpan) * pw;
      const yNorm = (val: number, minV: number, maxV: number) =>
        pad.t + ph - ((val - minV) / Math.max(1e-6, maxV - minV)) * ph;

      // Shade active energy integration window
      const wx0 = xOf(p.win.startTime);
      const wx1 = xOf(p.win.endTime);
      ctx.fillStyle = th.isLight ? 'rgba(219, 39, 119, 0.12)' : 'rgba(244, 114, 182, 0.14)';
      ctx.fillRect(wx0, pad.t, Math.max(2, wx1 - wx0), ph);

      const drawTrace = (arr: Float32Array, minV: number, maxV: number, color: string, width: number) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        const step = Math.max(1, Math.floor((i1 - i0) / 360));
        for (let i = i0; i <= i1; i += step) {
          const px = xOf(res.time[i]);
          const py = yNorm(arr[i], minV, maxV);
          if (i === i0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.lineTo(xOf(res.time[i1]), yNorm(arr[i1], minV, maxV));
        ctx.stroke();
      };

      drawTrace(res.vgs, vgsMin, vgsMax, th.yellow, 1.5);
      drawTrace(res.vds, vdsMin, vdsMax, th.cyan, 1.8);
      drawTrace(res.ids, idsMin, idsMax, th.green, 1.8);

      ctx.fillStyle = th.axisText;
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${vdsMax.toFixed(0)}V`, ox + pad.l - 4, pad.t + 9);
      ctx.fillText(`${idsMax.toFixed(0)}A`, ox + pad.l - 4, pad.t + Math.round(ph * 0.52));
      ctx.fillText('0', ox + pad.l - 4, pad.t + ph);

      ctx.textAlign = 'center';
      const durNs = tSpan * 1e9;
      ctx.fillText(`0`, ox + pad.l, pad.t + ph + 15);
      ctx.fillText(`+${(durNs * 0.5).toFixed(0)}ns`, ox + pad.l + pw * 0.5, pad.t + ph + 15);
      ctx.fillText(`+${durNs.toFixed(0)}ns`, ox + pad.l + pw - 10, pad.t + ph + 15);

      ctx.textAlign = 'left';
      ctx.fillStyle = th.titleText;
      ctx.fillText(`${p.title} · E=${p.eUj.toFixed(2)} µJ`, ox + pad.l + 6, pad.t - 6);
    });
  }
}

export function initThermalWorkbench(app: OscilloscopeApp): ThermalWorkbenchController {
  const ctrl = new ThermalWorkbenchController(app);
  document.getElementById('openThermalModalBtn')?.addEventListener('click', () => ctrl.openModal());
  return ctrl;
}

export { cauerToSpice, validateCauerSpiceNetlist };
