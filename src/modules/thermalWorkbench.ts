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
  NonlinearEossCurve,
  integrateQossToEossCurve,
  integrateCossToEossCurve,
  parseEossCurveImportJson,
  parseEossCurveCsv,
  createEossCurveImportTemplate,
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
  FocThermalTopologyMode,
  FocSimulationResult,
  FocStallSweepResult,
  FocControlSweepResult,
  FocSteadyOperatingPoint,
  FocSteadyStateResult,
  FocVoltageEnvelopeRow,
  FocMissionStage,
  FocMissionProfileResult,
  FocDeratingCurveResult,
  FocDeratingLimitReason,
  RdsOnTempCurve,
  parseRdsOnTempCurveImportJson,
  createRdsOnTempCurveImportTemplate,
  splitCauerToFocModel,
  focModelToSpice,
  validateFocSpiceNetlist,
  parsePcbSpatialImportJson,
  createPcbSpatialImportTemplate,
  summarizePcbSpatialNetwork,
  exportPcbSpatialDocumentFromModel,
  simulateFoc6Mos,
  simulateFoc6MosSteadyState,
  simulateFoc6MosVoltageEnvelope,
  runFocStallSweep,
  runFocControlSweep,
  createAutomotive12VMissionProfilePreset,
  simulateFocMissionProfile,
  computeFocThermalDeratingCurve,
} from './focThermal';
import { BUK7Q6R0_40H_PROFILE, createBuk7Q6R0_40HRdsCurveJson } from './focMosDeviceProfiles';
import {
  DptAnalysisResult,
  DptOperatingPoint,
  analyzeDoublePulseTest,
  generateDptDemoChannels,
  interpolateDptSwitchingLoss,
  createDptLutImportTemplate,
  createDptLutImportCsvTemplate,
  parseDptLutImportText,
  summarizeDptLutCoverage,
  serializeDptLutToJson,
} from './dptAnalyzer';
import { FocThermalHandoffPayload } from './focDyno/scopeBridge';

type WorkbenchTabKey = 'deconv' | 'loss' | 'soa' | 'foc' | 'dpt';
type DeconvSubPlotKey = 'spectrum' | 'structure' | 'residual';
type FocCanvasMode = 'tj' | 'stall' | 'sweep' | 'mission' | 'derating';

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
  private cauerSourceLabel: string = '软件回退 3 阶热网络（1.22 °C/W；非器件数据）';
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
  private activeFocSteadyPoint: FocSteadyOperatingPoint | null = null;
  private lastFocSteadyResult: FocSteadyStateResult | null = null;
  private lastFocVoltageEnvelope: FocVoltageEnvelopeRow[] | null = null;
  private missionStages: FocMissionStage[] = createAutomotive12VMissionProfilePreset();
  private lastMissionResult: FocMissionProfileResult | null = null;
  private lastDeratingResult: FocDeratingCurveResult | null = null;

  // P1: DPT State
  private lastDptResult: DptAnalysisResult | null = null;
  private dptMatrix: DptOperatingPoint[] = [];
  private useDptMatrixInFoc: boolean = false;

  constructor(app: OscilloscopeApp) {
    this.app = app;
    this.bindEvents();
    this.populateSoaPresets();
    this.renderSoaBreakpointTable();
    this.renderMissionStageTable();
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
    const isFallback = this.focModelSource === 'fallback_default';
    if (maxLbl) maxLbl.innerText = isPad ? (isFallback ? 'Tpad* Max（回退估算）' : 'Tpad Max (Equiv)') : isFallback ? 'Tj* Max（回退估算）' : 'Tj Max';
    if (deltaLbl) deltaLbl.innerText = isPad ? (isFallback ? 'ΔTpad* Peak（回退估算）' : 'ΔTpad Peak') : isFallback ? 'ΔTj* Peak（回退估算）' : 'ΔTj Peak';
    if (titleEl) {
      titleEl.innerText = isPad
        ? 'Stripped Switching Power P_loss(t) & Pad-Equivalent Temp Tpad(t)'
        : 'Stripped Switching Power P_loss(t) & Closed-Loop Junction Temp Tj(t)';
    }
    if (legendEl) legendEl.innerText = isPad ? '■ Tpad (°C)' : isFallback ? '■ Tj*（回退假设，非器件实测）' : '■ Tj (°C)';
    if (titleEl && isFallback && !isPad) titleEl.title = '当前使用软件回退 Cauer 网络，不对应特定 MOSFET；输出 Tj* 仅用于算法连通性/演示，不可用于器件热设计或 SOA 定型。';
    else if (titleEl) titleEl.title = isPad ? '焊盘到环境的等效热网络，输出为 Tpad，不是真实芯片结温。' : '基于已导入/反演热网络的结温估算；仍需器件数据与实测验证。';
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
    document.getElementById('focApplyStarterBtn')?.addEventListener('click', () => {
      const starterValues: Record<string, string> = {
        focVbusSelect: '__const__',
        focVbusConstInput: '13.5',
        focTambInput: '25',
        focModSelect: 'SVPWM',
        focModDepthInput: '0.85',
        focPfAngleInput: '0',
        focFswKhzInput: '20',
        focTdeadNsInput: '500',
        focAlphaInput: '0.45',
        focVsdInput: '0.9',
      };
      for (const [id, value] of Object.entries(starterValues)) {
        const input = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
        if (input) input.value = value;
      }
      this.invalidateFocCaches(true);
      this.refreshFocModelAndSpice();
      this.app.showToast('已应用 12V 汽车供电起算工况（标称 13.5V，常用边界 9～16V）；器件损耗与热参数仍须按实际 MOS/DPT/PCB 数据填写。', 'warn');
    });
    document.getElementById('focRunSimBtn')?.addEventListener('click', () => this.runFocSimulation());
    document.getElementById('focRunSteadyBtn')?.addEventListener('click', () => this.runFocSteadyState());
    document.getElementById('focRunVoltageEnvelopeBtn')?.addEventListener('click', () => this.runFocVoltageEnvelope());
    document.getElementById('focInjectBtn')?.addEventListener('click', () => this.injectFocTracesToScope());
    document.getElementById('focRunSweepBtn')?.addEventListener('click', () => this.runFocControlSweepAnalysis());
    document.getElementById('focRunStallBtn')?.addEventListener('click', () => this.runFocStallAnalysis());

    // Mission Profile controls
    document.getElementById('focMissionPresetBtn')?.addEventListener('click', () => {
      try {
        const { ctrl } = this.readFocParams();
        this.missionStages = createAutomotive12VMissionProfilePreset(ctrl);
      } catch {
        this.missionStages = createAutomotive12VMissionProfilePreset();
      }
      this.renderMissionStageTable();
      this.app.showToast('已载入 12V 汽车起动-巡航-堵转-冷却 4 阶段默认任务剖面。', 'info');
    });
    document.getElementById('focMissionAddStageBtn')?.addEventListener('click', () => {
      let baseVbus = 13.5;
      let baseTamb = 25;
      try {
        const { ctrl } = this.readFocParams();
        baseVbus = ctrl.vBusConstV;
        baseTamb = ctrl.tAmbC;
      } catch {
        // fallback defaults
      }
      this.missionStages.push({
        id: `stage_${Date.now().toString(36)}`,
        label: `阶段 ${this.missionStages.length + 1}`,
        mode: 'rotating',
        durationSec: 10,
        iqPeakA: 25,
        electricalFrequencyHz: 150,
        vBusV: baseVbus,
        modDepthM: 0.75,
        pfAngleDeg: 0,
        tAmbC: baseTamb,
      });
      this.renderMissionStageTable();
    });
    document.getElementById('focMissionExportBtn')?.addEventListener('click', () => {
      const payload = {
        schema: 'wave-test-foc-mission-profile-v1',
        repeatCycles: Math.max(1, Math.min(20, Math.round(this.readFiniteInput('focMissionCyclesInput', 3)))),
        tjLimitC: this.readFiniteInput('focMissionTjLimitInput', 150),
        stages: this.missionStages,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'foc-thermal-mission-profile.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 600);
      this.app.showToast(`已导出 ${this.missionStages.length} 阶段热任务剖面 JSON。`, 'info');
    });
    const missionFileInp = document.getElementById('focMissionFileInput') as HTMLInputElement | null;
    document.getElementById('focMissionImportBtn')?.addEventListener('click', () => missionFileInp?.click());
    missionFileInp?.addEventListener('change', async () => {
      const file = missionFileInp.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.stages) ? parsed.stages : null;
        if (!arr || arr.length === 0) throw new Error('JSON 须包含非空 stages 数组');
        this.missionStages = arr.map((raw: any, i: number) => ({
          id: typeof raw.id === 'string' ? raw.id : `imp_${i + 1}`,
          label: String(raw.label || `阶段 ${i + 1}`),
          mode: raw.mode === 'locked_rotor' ? 'locked_rotor' : 'rotating',
          durationSec: Math.max(0.05, Number(raw.durationSec) || 5),
          iqPeakA: Math.max(0, Number(raw.iqPeakA) || 0),
          idPeakA: Number.isFinite(Number(raw.idPeakA)) ? Number(raw.idPeakA) : undefined,
          electricalFrequencyHz: Math.max(0, Number(raw.electricalFrequencyHz) || 0),
          electricalAngleDeg: Number.isFinite(Number(raw.electricalAngleDeg)) ? Number(raw.electricalAngleDeg) : undefined,
          vBusV: Math.max(1, Number(raw.vBusV) || 13.5),
          modDepthM: Math.max(0, Number(raw.modDepthM) || 0.7),
          pfAngleDeg: Number.isFinite(Number(raw.pfAngleDeg)) ? Number(raw.pfAngleDeg) : 0,
          fswHz: Number.isFinite(Number(raw.fswHz)) ? Number(raw.fswHz) : undefined,
          tAmbC: Number.isFinite(Number(raw.tAmbC)) ? Number(raw.tAmbC) : undefined,
        }));
        if (Number.isFinite(Number(parsed?.repeatCycles))) {
          const cycEl = document.getElementById('focMissionCyclesInput') as HTMLInputElement | null;
          if (cycEl) cycEl.value = String(Math.max(1, Math.min(20, Math.round(Number(parsed.repeatCycles)))));
        }
        if (Number.isFinite(Number(parsed?.tjLimitC))) {
          const limEl = document.getElementById('focMissionTjLimitInput') as HTMLInputElement | null;
          if (limEl) limEl.value = String(Number(parsed.tjLimitC));
        }
        this.renderMissionStageTable();
        this.app.showToast(`已导入 ${this.missionStages.length} 阶段热任务剖面。`, 'info');
      } catch (err: any) {
        this.app.showToast(`任务剖面 JSON 导入失败：${err?.message || err}`, 'error');
      } finally {
        missionFileInp.value = '';
      }
    });
    document.getElementById('focRunMissionBtn')?.addEventListener('click', () => this.runFocMissionProfile());
    document.getElementById('focInjectMissionBtn')?.addEventListener('click', () => this.injectMissionResultToScope());

    // Derating Curve controls
    document.getElementById('focRunDeratingBtn')?.addEventListener('click', () => this.runFocDeratingCurve());
    document.getElementById('focExportDeratingCsvBtn')?.addEventListener('click', () => {
      if (!this.lastDeratingResult) {
        this.app.showToast('请先点击“计算降额曲线”，再导出 CSV 标定表。', 'warn');
        return;
      }
      const blob = new Blob([`\uFEFF${this.lastDeratingResult.csvContent}`], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `foc-thermal-derating-Tj${Math.round(this.lastDeratingResult.tjLimitC)}C.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 600);
      this.app.showToast(`已导出 ${this.lastDeratingResult.points.length} 点温度×电压降额标定 CSV。`, 'info');
    });
    document.getElementById('focTauSplitMsInput')?.addEventListener('change', () => this.refreshFocModelAndSpice());
    document.getElementById('focTambInput')?.addEventListener('change', () => this.refreshFocModelAndSpice());
    document.getElementById('focRjcOverrideInput')?.addEventListener('change', () => this.refreshFocModelAndSpice());
    document.getElementById('focRjcSpreadPctInput')?.addEventListener('change', () => this.refreshFocModelAndSpice());
    document.getElementById('focTopologyModeSelect')?.addEventListener('change', () => {
      this.refreshFocModelAndSpice();
      this.updatePcbSpatialSummaryBar();
    });
    document.getElementById('focPcbCopperOzInput')?.addEventListener('change', () => {
      this.refreshFocModelAndSpice();
      this.updatePcbSpatialSummaryBar();
    });
    document.getElementById('focPcbPitchMmInput')?.addEventListener('change', () => {
      this.refreshFocModelAndSpice();
      this.updatePcbSpatialSummaryBar();
    });
    document.getElementById('focPcbSpatialJsonInput')?.addEventListener('change', () => {
      try {
        this.refreshFocModelAndSpice();
        this.updatePcbSpatialSummaryBar();
      } catch (err) {
        this.updatePcbSpatialSummaryBar(err instanceof Error ? err.message : String(err));
        this.app.showToast(err instanceof Error ? err.message : String(err), 'error');
      }
    });
    document.getElementById('focPcbSpatialJsonFileInput')?.addEventListener('change', async (ev) => {
      const file = (ev.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const raw = await file.text();
        parsePcbSpatialImportJson(raw);
        const target = document.getElementById('focPcbSpatialJsonInput') as HTMLTextAreaElement | null;
        if (target) target.value = raw;
        this.refreshFocModelAndSpice();
        this.updatePcbSpatialSummaryBar();
        this.app.showToast(`已导入 PCB 热网络：${file.name}`, 'info');
      } catch (err) {
        const target = document.getElementById('focPcbSpatialJsonInput') as HTMLTextAreaElement | null;
        if (target) target.value = '';
        this.invalidateFocCaches(true);
        const msg = err instanceof Error ? err.message : String(err);
        this.updatePcbSpatialSummaryBar(msg);
        this.app.showToast(`PCB 热网络导入失败：${msg}`, 'error');
      }
    });
    document.getElementById('focPcbSpatialTemplateBtn')?.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(createPcbSpatialImportTemplate(), null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'wave-test-pcb-thermal-template.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    });
    document.getElementById('focPcbSpatialExportCurrentBtn')?.addEventListener('click', () => {
      try {
        const model = this.getActiveFocModel();
        const doc = exportPcbSpatialDocumentFromModel(model);
        const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'wave-test-pcb-thermal-current.json';
        document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        this.app.showToast('已导出当前六区 PCB 热网络 JSON 档案。', 'info');
      } catch (err) {
        this.app.showToast(`导出当前六区 PCB 热网络失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    });
    document.getElementById('focApplyBuk7ProfileBtn')?.addEventListener('click', () => {
      const setValue = (id: string, value: string) => {
        const input = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
        if (input) input.value = value;
      };
      const setChecked = (id: string, checked: boolean) => {
        const input = document.getElementById(id) as HTMLInputElement | null;
        if (input) input.checked = checked;
      };
      setValue('focRdsInput', String(BUK7Q6R0_40H_PROFILE.rdsOn.typicalMohm));
      setValue('focRds25ReferenceVgsInput', String(BUK7Q6R0_40H_PROFILE.rdsOn.referenceGateVoltageV));
      // 10 V is only the datasheet's RDS(on) test condition. The profile deliberately
      // leaves the user's confirmation unchecked until the actual gate waveform is verified.
      setValue('focRdsOperatingVgsInput', String(BUK7Q6R0_40H_PROFILE.rdsOn.referenceGateVoltageV));
      setValue('focRdsTempCurveJsonInput', createBuk7Q6R0_40HRdsCurveJson());
      setValue('focVsdInput', String(BUK7Q6R0_40H_PROFILE.bodyDiode.vsdTypicalV));
      setValue('focEswInput', '');
      setValue('focEossInput', '');
      setValue('focQrrInput', String(BUK7Q6R0_40H_PROFILE.recoveredCharge.qrNc));
      // Esw/Eoss reference conditions are independent from the datasheet Qr test conditions.
      setValue('focVrefInput', '13.5');
      setValue('focQrrIrefInput', String(BUK7Q6R0_40H_PROFILE.recoveredCharge.referenceCurrentA));
      setValue('focQrrReferenceVdsInput', String(BUK7Q6R0_40H_PROFILE.recoveredCharge.testVdsV));
      setValue('focQrrReferenceDiDtInput', String(BUK7Q6R0_40H_PROFILE.recoveredCharge.testDiDtAperUs));
      setValue('focQrrReferenceTjInput', String(BUK7Q6R0_40H_PROFILE.recoveredCharge.testJunctionTemperatureC));
      setValue('focQrrReferenceVgsInput', String(BUK7Q6R0_40H_PROFILE.recoveredCharge.testGateVoltageV));
      setValue('focRjcOverrideInput', String(BUK7Q6R0_40H_PROFILE.thermal.rthJunctionToMountingBaseMaxCPerW));
      setValue('focEossCurveModeSelect', 'scalar');
      setValue('focEossCurveInput', '');
      setValue('focEossCurveJsonInput', '');
      setValue('focEossCurveCsvInput', '');
      setChecked('focRdsConfirmedChk', false);
      setChecked('focEonIncludesQrrChk', false);
      setChecked('focEossIncludedChk', false);
      setChecked('focQrrIncludesQossChk', true);
      const profileNote = document.getElementById('focBuk7ProfileNote');
      if (profileNote) {
        profileNote.classList.remove('hidden');
        profileNote.innerHTML = [
          `<b>${BUK7Q6R0_40H_PROFILE.manufacturer} ${BUK7Q6R0_40H_PROFILE.partNumber}</b> 已载入：RDS(on)=${BUK7Q6R0_40H_PROFILE.rdsOn.typicalMohm.toFixed(1)}mΩ typ（25°C、VGS=10V、ID=20A；max=${BUK7Q6R0_40H_PROFILE.rdsOn.maxMohm.toFixed(1)}mΩ）；VSD=${BUK7Q6R0_40H_PROFILE.bodyDiode.vsdTypicalV.toFixed(1)}V typ；Qr=${BUK7Q6R0_40H_PROFILE.recoveredCharge.qrNc}nC（Is=16A、VDS=20V、di/dt=−100A/µs、VGS=0V、Tj=25°C，包含电容性恢复）；Rθ(j-mb)=${BUK7Q6R0_40H_PROFILE.thermal.rthJunctionToMountingBaseTypicalCPerW.toFixed(2)}°C/W typ / ${BUK7Q6R0_40H_PROFILE.thermal.rthJunctionToMountingBaseMaxCPerW.toFixed(2)}°C/W max。`,
          `<b>重要：</b>Esw/Eon/Eoff 数据手册未给出，保持空白；不要从 td(on)/tr/td(off)/tf 推算能量。Qr=13nC 的参考电流独立设为 16A；其测试 VDS=20V、di/dt=−100A/µs、VGS=0V、Tj=25°C。Esw/Eoss 的 Vref 仍设为 13.5V，绝不复用 Qr 测试 VDS。Qr 已按 Nexperia 定义包含 Qoss，本标量路径禁止再叠加独立 Eoss。温度曲线的表格锚点为精确典型值，其他点为 Fig.12 图线数字化近似。`,
          `<b>必须核实：</b>当前 Vgs,on 暂以 10V（数据手册测试条件）起算，必须与实际 MOS Gate-Source 导通波形核对；Rds 确认框保持未勾选。Rth(j-mb) 使用数据手册最大值 2.3°C/W 作保守的结到安装基准面热阻锚点；只有当热网络 JC 端确实对应器件 mounting base 时才可这样映射，绝不代表 PCB 到环境热阻。`,
          `<b>40V 额定值：</b>9–16V 是直流母线范围，不代表 VDS 峰值一定安全；还必须检查换流尖峰和线束/布局寄生造成的 VDS 过冲。`
        ].map((line) => `<div class="mb-1">${line}</div>`).join('');
      }
      this.activeFocHandoffNote = '已载入 Nexperia BUK7Q6R0-40H 数据手册预设；六管共用该器件参数。DPT LUT 若已启用，请确认其器件型号和测试口径一致。';
      this.invalidateFocCaches(true);
      this.refreshFocModelAndSpice();
      this.renderFocWarnings();
      this.app.showToast('已载入 BUK7Q6R0-40H 数据手册参数；Eon/Eoff 未伪造，仍需实际 DPT 数据。', 'success');
    });

    document.getElementById('focRdsTempCurveJsonInput')?.addEventListener('input', () => this.invalidateFocCaches(true));
    document.getElementById('focRdsTempCurveTemplateBtn')?.addEventListener('click', () => {
      const target = document.getElementById('focRdsTempCurveJsonInput') as HTMLTextAreaElement | null;
      if (target) target.value = JSON.stringify(createRdsOnTempCurveImportTemplate(), null, 2);
      this.invalidateFocCaches(true);
      this.app.showToast('已生成 Rds(on)-Tj JSON 模板；请替换为目标 MOS 数据手册/实测曲线，不能直接把空模板作为计算输入。', 'info');
    });
    document.getElementById('focRdsTempCurveJsonFileInput')?.addEventListener('change', async (ev) => {
      const file = (ev.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const raw = await file.text();
        parseRdsOnTempCurveImportJson(raw);
        const target = document.getElementById('focRdsTempCurveJsonInput') as HTMLTextAreaElement | null;
        if (target) target.value = raw;
        this.invalidateFocCaches(true);
        this.app.showToast(`已载入 Rds(on)-Tj 曲线：${file.name}`, 'info');
      } catch (err) {
        this.app.showToast(`Rds(on)-Tj 曲线导入失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    });
    document.getElementById('focEonIncludesQrrChk')?.addEventListener('change', () => this.invalidateFocCaches(true));
    document.getElementById('focEossCurveJsonInput')?.addEventListener('change', () => this.invalidateFocCaches(true));
    document.getElementById('focEossCurveJsonTemplateBtn')?.addEventListener('click', () => {
      const kind = ((document.getElementById('focEossCsvKindSelect') as HTMLSelectElement | null)?.value || 'qoss_nc') as 'eoss_uj' | 'qoss_nc' | 'coss_pf';
      const template = createEossCurveImportTemplate(kind);
      const target = document.getElementById('focEossCurveJsonInput') as HTMLTextAreaElement | null;
      if (target) target.value = JSON.stringify(template, null, 2);
      const mode = document.getElementById('focEossCurveModeSelect') as HTMLSelectElement | null;
      if (mode) mode.value = 'custom_json';
      this.invalidateFocCaches(true);
      this.app.showToast(`已生成 ${kind} 器件曲线 JSON 模板；请替换为具体器件数据后导入。`, 'info');
    });
    document.getElementById('focEossCurveJsonFileInput')?.addEventListener('change', async (ev) => {
      const file = (ev.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const raw = await file.text();
        parseEossCurveImportJson(raw);
        const target = document.getElementById('focEossCurveJsonInput') as HTMLTextAreaElement | null;
        if (target) target.value = raw;
        this.invalidateFocCaches(true);
        this.app.showToast(`已载入器件 Eoss JSON：${file.name}`, 'info');
      } catch (err) {
        const target = document.getElementById('focEossCurveJsonInput') as HTMLTextAreaElement | null;
        if (target) target.value = '';
        this.invalidateFocCaches(true);
        this.app.showToast(`Eoss JSON 导入失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    });
    document.getElementById('focEossCurveCsvInput')?.addEventListener('change', () => this.invalidateFocCaches(true));
    for (const id of ['focEossCsvKindSelect', 'focEossCsvVoltageUnitSelect', 'focEossCsvValueUnitSelect']) {
      document.getElementById(id)?.addEventListener('change', () => this.invalidateFocCaches(true));
    }
    document.getElementById('focEossCurveCsvFileInput')?.addEventListener('change', async (ev) => {
      const file = (ev.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const target = document.getElementById('focEossCurveCsvInput') as HTMLTextAreaElement | null;
        if (target) target.value = text;
        this.invalidateFocCaches(true);
        this.app.showToast(`已载入 Eoss CSV：${file.name}；请核对曲线类型和单位后运行。`, 'info');
      } catch (err) {
        this.app.showToast(`Eoss CSV 读取失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    });
    document.getElementById('focEossIncludedChk')?.addEventListener('change', () => this.invalidateFocCaches(true));
    document.getElementById('focEossCurveModeSelect')?.addEventListener('change', (ev) => {
      const mode = (ev.target as HTMLSelectElement).value;
      const inp = document.getElementById('focEossCurveInput') as HTMLInputElement | null;
      if (inp) {
        if (mode === 'preset_si_80v') inp.value = '0:0, 12:18, 24:31, 48:50, 60:58, 80:72';
        else if (mode === 'preset_sic_650v') inp.value = '0:1400, 25:620, 100:240, 200:145, 400:98, 650:78';
      }
      this.invalidateFocCaches(true);
    });
    document.getElementById('focEossCsvKindSelect')?.addEventListener('change', (ev) => {
      const kind = (ev.target as HTMLSelectElement).value;
      const unitSelect = document.getElementById('focEossCsvValueUnitSelect') as HTMLSelectElement | null;
      if (!unitSelect) return;
      const allowed = kind === 'eoss_uj' ? ['uJ', 'nJ', 'mJ'] : kind === 'qoss_nc' ? ['nC', 'uC'] : ['pF', 'nF'];
      unitSelect.innerHTML = allowed.map((u) => `<option value="${u}">${u}</option>`).join('');
      this.invalidateFocCaches(true);
    });

    // Tab 5 controls (DPT & multi-point LUT matrix)
    document.getElementById('dptLoadDemoBtn')?.addEventListener('click', () => this.loadDptDemoTab());
    document.getElementById('dptRunBtn')?.addEventListener('click', () => {
      const confirmation = document.getElementById('dptMatrixConditionConfirmedChk') as HTMLInputElement | null;
      if (confirmation) confirmation.checked = false;
      this.runDptAnalysis();
    });
    document.getElementById('dptApplyToFocBtn')?.addEventListener('click', () => this.applyDptResultsToFoc());
    document.getElementById('dptAddToMatrixBtn')?.addEventListener('click', () => this.addCurrentDptPointToMatrix());
    document.getElementById('dptApplyMatrixToFocBtn')?.addEventListener('click', () => this.applyDptMatrixToFoc());
    for (const id of ['dptMatrixTjInput', 'dptMatrixRgonInput', 'dptMatrixRgoffInput']) {
      document.getElementById(id)?.addEventListener('input', () => {
        const confirmation = document.getElementById('dptMatrixConditionConfirmedChk') as HTMLInputElement | null;
        if (confirmation) confirmation.checked = false;
      });
    }
    document.getElementById('dptClearMatrixBtn')?.addEventListener('click', () => {
      this.dptMatrix = [];
      this.useDptMatrixInFoc = false;
      this.renderDptMatrixTable();
    });
    document.getElementById('dptImportLutBtn')?.addEventListener('click', () => {
      const fileInput = document.getElementById('dptLutFileInput') as HTMLInputElement | null;
      if (fileInput) {
        fileInput.value = '';
        fileInput.click();
      }
    });
    document.getElementById('dptLutFileInput')?.addEventListener('change', async (ev) => {
      const file = (ev.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const raw = await file.text();
        const imported = parseDptLutImportText(raw);
        this.dptMatrix = imported.points;
        this.useDptMatrixInFoc = false;
        this.renderDptMatrixTable();
        this.app.showToast(
          `已导入 ${imported.points.length} 条 4D DPT 实测点（${imported.format.toUpperCase()}）· ${imported.summary.statusText}；点击「4D LUT 插值注入 FOC」生效。`,
          imported.summary.coversAutomotive9to16V ? 'success' : 'info'
        );
      } catch (err) {
        this.app.showToast(`4D DPT 导入被拦截：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    });
    document.getElementById('dptTemplateJsonBtn')?.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(createDptLutImportTemplate('BUK7Q6R0-40H'), null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'wave-test-dpt-4d-lut-template.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      this.app.showToast('已下载 4D DPT JSON 实测模板（空白能量字段为 null，填入实测数据后再导入）。', 'info');
    });
    document.getElementById('dptTemplateCsvBtn')?.addEventListener('click', () => {
      const blob = new Blob([createDptLutImportCsvTemplate('BUK7Q6R0-40H')], {
        type: 'text/csv;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'wave-test-dpt-4d-lut-template.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      this.app.showToast('已下载 4D DPT CSV 实测模板（覆盖 9/13.5/16V 骨架，填入实测数据后再导入）。', 'info');
    });
    document.getElementById('dptExportJsonBtn')?.addEventListener('click', () => {
      if (this.dptMatrix.length === 0) {
        this.app.showToast('当前 DPT 矩阵为空，无可导出数据。', 'warn');
        return;
      }
      const blob = new Blob([serializeDptLutToJson(this.dptMatrix, 'BUK7Q6R0-40H')], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'wave-test-dpt-4d-lut-export.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      this.app.showToast(`已导出当前 ${this.dptMatrix.length} 条 4D DPT 矩阵 JSON 档案。`, 'info');
    });

    const stallOnlyInputIds = new Set([
      'focStallIpkInput',
      'focStallLimitInput',
      'focStallRsInput',
      'focStallDutyModeSelect',
    ]);
    const manualEswIds = new Set(['focEswInput', 'focQrrInput', 'focVrefInput', 'focIrefInput', 'focQrrIrefInput', 'focQrrReferenceVdsInput', 'focQrrReferenceDiDtInput', 'focQrrReferenceTjInput', 'focQrrReferenceVgsInput']);
    const handleFocPanelMutation = (ev: Event) => {
      const target = ev.target as HTMLElement | null;
      if (!target || !target.id) return;
      if (manualEswIds.has(target.id) && this.useDptMatrixInFoc) {
        this.useDptMatrixInFoc = false;
        this.activeFocHandoffNote = '已手动修改单点 Esw/Qrr 参数，当前切换回单点标量 V/I 缩放模式。';
      }
      if (target.id === 'focRdsInput' || target.id === 'focRdsOperatingVgsInput' || target.id === 'focRds25ReferenceVgsInput' || target.id === 'focRdsTempCurveJsonInput') {
        const confirmed = document.getElementById('focRdsConfirmedChk') as HTMLInputElement | null;
        if (confirmed) confirmed.checked = false;
      }
      if (target.id === 'focRgonInput' || target.id === 'focRgoffInput') {
        const confirmed = document.getElementById('focRgDesignConfirmedChk') as HTMLInputElement | null;
        if (confirmed) confirmed.checked = false;
      }
      if (
        target.closest('#focMissionProfileCard') ||
        target.closest('#focDeratingCurveCard') ||
        target.id.startsWith('focMission') ||
        target.id.startsWith('focDerate')
      ) {
        return;
      }
      if (stallOnlyInputIds.has(target.id)) {
        this.invalidateFocCaches(false);
      } else {
        this.invalidateFocCaches(true);
      }
      this.renderFocSteadyOperatingPoint();
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
    document.getElementById('focViewMissionBtn')?.addEventListener('click', () => {
      this.focCanvasMode = 'mission';
      this.syncFocViewButtons();
      this.drawFocCanvas();
    });
    document.getElementById('focViewDeratingBtn')?.addEventListener('click', () => {
      this.focCanvasMode = 'derating';
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
    el.innerText = `${this.cauerSourceLabel} | 阶数=${this.activeCauerStages.length} | Rth=${rTot.toFixed(4)} °C/W`;
    const isFallback = this.focModelSource === 'fallback_default';
    el.classList.toggle('text-amber-300', isFallback);
    el.classList.toggle('text-emerald-300', !isFallback);
    el.title = isFallback
      ? '软件回退 RC 参数，不对应任何具体 MOSFET 或 PCB。仅用于演示和验证计算链路，不可将结果作为真实 Tj、热设计裕量或器件选型结论。请先导入/反演目标器件的 ZthJC(t) 或已验证 Cauer 网络。'
      : '当前网络来源于 Tab 1 热阻抗反演；请确认热路径与测温位置匹配。焊盘到环境模型输出为 Tpad 等效温度，不是芯片真实 Tj。';
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
    const tAmbRaw = (document.getElementById('thermLossTambInput') as HTMLInputElement)?.value?.trim() || '';
    const tAmbC = tAmbRaw === '' ? this.activeTambC : Number(tAmbRaw);
    const initTjRaw = (document.getElementById('thermLossInitTjInput') as HTMLInputElement)?.value?.trim() || '';
    const initTjParsed = initTjRaw === '' ? undefined : Number(initTjRaw);
    const deskewRaw = (document.getElementById('thermLossDeskewInput') as HTMLInputElement)?.value?.trim() || '';
    const deskewNs = deskewRaw === '' ? 0 : Number(deskewRaw);
    const eossRaw = (document.getElementById('thermLossEossInput') as HTMLInputElement)?.value?.trim() || '';
    const rdsRaw = (document.getElementById('thermLossRdsInput') as HTMLInputElement)?.value?.trim() || '';
    const alphaRaw = (document.getElementById('thermLossAlphaInput') as HTMLInputElement)?.value?.trim() || '';
    const eossUj = eossRaw === '' ? 0 : Number(eossRaw);
    const rdsOn25Mohm = rdsRaw === '' ? 0 : Number(rdsRaw);
    const alphaPct = alphaRaw === '' ? 0 : Number(alphaRaw);
    const rdsFeedbackEnabled = (document.getElementById('thermLossRdsFeedbackChk') as HTMLInputElement)?.checked ?? false;

    const rng = getChannelGateRange(tab, vdsCh, gate);
    try {
      if (!Number.isFinite(tAmbC) || tAmbC <= -273.15 || tAmbC > 1000) {
        throw new Error('环境/基准温度必须高于绝对零度且不超过 1000°C；不会在输入无效时静默回退到 25°C。');
      }
      if (initTjRaw !== '' && (initTjParsed === undefined || !Number.isFinite(initTjParsed) || initTjParsed <= -273.15 || initTjParsed > 1000)) {
        throw new Error('初始结温 Tj(0) 必须高于绝对零度且不超过 1000°C；留空表示采用 T_amb 冷启动。');
      }
      if (!Number.isFinite(deskewNs)) {
        throw new Error('探头 Deskew 必须为有限数值（ns）；留空表示 0 ns。');
      }
      if (rdsFeedbackEnabled && (!(rdsOn25Mohm > 0) || !(alphaPct > 0) || !Number.isFinite(rdsOn25Mohm) || !Number.isFinite(alphaPct))) {
        throw new Error('已启用 Rds(on)(Tj) 反馈，但 Rds25 或 α 为空/无效。请填入对应器件在 25°C 的 Rds(on) 与温度系数；不得使用通用默认值代替。');
      }
      if (eossRaw !== '' && (!Number.isFinite(eossUj) || eossUj < 0)) {
        throw new Error('Eoss 必须是非负有限值（µJ）；不使用 Eoss 修正时请留空。');
      }
      const res = computeLossWithDeskewAndEoss(vdsCh, idsCh, this.activeCauerStages, {
        deskewNs,
        eossUj: Number.isFinite(eossUj) ? eossUj : 0,
        rdsOn25Mohm: Number.isFinite(rdsOn25Mohm) && rdsOn25Mohm > 0 ? rdsOn25Mohm : 0,
        tempCoeffAlphaPerC: Number.isFinite(alphaPct) && alphaPct > 0 ? alphaPct / 100 : 0,
        rdsFeedbackEnabled,
        tAmbC,
        initialTjC: initTjParsed,
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

    const topoRaw = (document.getElementById('focTopologyModeSelect') as HTMLSelectElement | null)?.value || 'shared_board';
    const topologyMode: FocThermalTopologyMode =
      topoRaw === 'pcb_spatial_coupled' || topoRaw === 'independent' ? topoRaw : 'shared_board';
    const copperOzRaw = parseFloat((document.getElementById('focPcbCopperOzInput') as HTMLInputElement | null)?.value || '2.0');
    const pitchMmRaw = parseFloat((document.getElementById('focPcbPitchMmInput') as HTMLInputElement | null)?.value || '14');
    baseModel.thermalTopologyMode = topologyMode;
    if (topologyMode !== 'shared_board') {
      const pcbJson = (document.getElementById('focPcbSpatialJsonInput') as HTMLTextAreaElement | null)?.value?.trim() || '';
      if (pcbJson) {
        const imported = parsePcbSpatialImportJson(pcbJson);
        baseModel.spatialMatrix = imported.config;
        baseModel.modelKind = imported.config.provenance === 'measured' ? 'datasheet_constrained' : baseModel.modelKind;
        baseModel.provenanceNote = `${baseModel.provenanceNote || ''} PCB 网络来源：${imported.boardName || imported.deviceName || imported.config.sourceLabel || '导入 JSON'}。`;
        baseModel.thermalTopologyMode = 'pcb_spatial_coupled';
      } else {
        baseModel.spatialMatrix = {
          copperOz: Number.isFinite(copperOzRaw) && copperOzRaw > 0 ? copperOzRaw : 2.0,
          layoutPitchMm: Number.isFinite(pitchMmRaw) && pitchMmRaw >= 4 ? pitchMmRaw : 14,
          provenance: 'geometry_estimated',
          sourceLabel: 'UI 几何近邻默认估算；并非实际 PCB 提取数据',
        };
      }
    }

    return baseModel;
  }

  private updatePcbSpatialSummaryBar(errorMsg?: string): void {
    const bar = document.getElementById('focPcbSpatialSummaryBar');
    if (!bar) return;
    if (errorMsg) {
      bar.className = 'mt-1.5 font-mono tabular-nums text-[10px] text-rose-300';
      bar.textContent = `✖ PCB 热矩阵校验阻断：${errorMsg}`;
      return;
    }
    try {
      const model = this.getActiveFocModel();
      const s = summarizePcbSpatialNetwork(model);
      bar.className =
        s.statusGlyph === '●'
          ? 'mt-1.5 font-mono tabular-nums text-[10px] text-emerald-300'
          : 'mt-1.5 font-mono tabular-nums text-[10px] text-amber-300';
      bar.textContent =
        `${s.statusGlyph} ${s.statusText} · ` +
        `Cpcb ${s.cPcbRangeJPerC[0].toFixed(2)}–${s.cPcbRangeJPerC[1].toFixed(2)} J/°C · ` +
        `Rvert ${s.rVertRangeCPerW[0].toFixed(2)}–${s.rVertRangeCPerW[1].toFixed(2)} °C/W (并联 ${s.totalParallelRvertCPerW.toFixed(2)} °C/W) · ` +
        `互耦 ${s.couplingLinkCount} 条 (max G=${s.maxMutualConductanceWPerC.toFixed(3)} W/°C)`;
    } catch (err) {
      bar.className = 'mt-1.5 font-mono tabular-nums text-[10px] text-rose-300';
      bar.textContent = `✖ PCB 热矩阵校验失败：${err instanceof Error ? err.message : String(err)}`;
    }
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
      'focRdsOperatingVgsInput',
      'focRds25ReferenceVgsInput',
      'focRdsConfirmedChk',
      'focAlphaInput',
      'focRdsTempCurveJsonInput',
      'focVsdInput',
      'focEswInput',
      'focEossInput',
      'focQrrInput',
      'focVrefInput',
      'focIrefInput',
      'focQrrIrefInput',
      'focQrrReferenceVdsInput',
      'focQrrReferenceDiDtInput',
      'focQrrReferenceTjInput',
      'focQrrReferenceVgsInput',
      'focTauSplitMsInput',
      'focRjcOverrideInput',
      'focRgonInput',
      'focRgoffInput',
      'focRgDesignConfirmedChk',
      'focTopologyModeSelect',
      'focPcbCopperOzInput',
      'focPcbPitchMmInput',
      'focPcbSpatialJsonInput',
      'focPcbSpatialJsonFileInput',
      'focRjcSpreadPctInput',
      'focEossCurveModeSelect',
      'focEossCurveInput',
      'focEossCurveJsonInput',
      'focEossCurveJsonFileInput',
      'focEossCurveCsvInput',
      'focEossCsvKindSelect',
      'focEossCsvVoltageUnitSelect',
      'focEossCsvValueUnitSelect',
      'focEossCurveCsvFileInput',
    ];
    const eonInclQrr = (document.getElementById('focEonIncludesQrrChk') as HTMLInputElement | null)?.checked ? '1' : '0';
    const eossIncl = (document.getElementById('focEossIncludedChk') as HTMLInputElement | null)?.checked ? '1' : '0';
    const qrrInclQoss = (document.getElementById('focQrrIncludesQossChk') as HTMLInputElement | null)?.checked ? '1' : '0';
    const qrrIref = (document.getElementById('focQrrIrefInput') as HTMLInputElement | null)?.value?.trim() || '';
    const qrrReferenceVds = (document.getElementById('focQrrReferenceVdsInput') as HTMLInputElement | null)?.value?.trim() || '';
    const qrrReferenceDiDt = (document.getElementById('focQrrReferenceDiDtInput') as HTMLInputElement | null)?.value?.trim() || '';
    const qrrReferenceTj = (document.getElementById('focQrrReferenceTjInput') as HTMLInputElement | null)?.value?.trim() || '';
    const qrrReferenceVgs = (document.getElementById('focQrrReferenceVgsInput') as HTMLInputElement | null)?.value?.trim() || '';
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
      eossIncl,
      qrrInclQoss,
      qrrIref,
      qrrReferenceVds,
      qrrReferenceDiDt,
      qrrReferenceTj,
      qrrReferenceVgs,
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
      this.lastFocSteadyResult = null;
      this.lastFocVoltageEnvelope = null;
      const voltageBox = document.getElementById('focVoltageEnvelopeBox');
      if (voltageBox) voltageBox.classList.add('hidden');
      const steadyBox = document.getElementById('focSteadyResultBox');
      if (steadyBox) steadyBox.classList.add('hidden');
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

  private parseFocRdsOnTempCurve(): RdsOnTempCurve | undefined {
    const raw = (document.getElementById('focRdsTempCurveJsonInput') as HTMLTextAreaElement | null)?.value?.trim() || '';
    if (!raw) return undefined;
    return parseRdsOnTempCurveImportJson(raw);
  }

  private parseFocNonlinearEossCurve(): NonlinearEossCurve | undefined {
    const mode = (document.getElementById('focEossCurveModeSelect') as HTMLSelectElement | null)?.value || 'scalar';
    if (mode === 'scalar') return undefined;
    if (mode === 'custom_json') {
      const rawJson = (document.getElementById('focEossCurveJsonInput') as HTMLTextAreaElement | null)?.value?.trim() || '';
      if (!rawJson) throw new Error('请选择或粘贴 Eoss/Qoss/Coss JSON 曲线数据。');
      return parseEossCurveImportJson(rawJson);
    }
    if (mode === 'custom_csv') {
      const csv = (document.getElementById('focEossCurveCsvInput') as HTMLTextAreaElement | null)?.value?.trim() || '';
      if (!csv) throw new Error('请导入或粘贴 Eoss/Qoss/Coss CSV 两列数据。');
      const kind = ((document.getElementById('focEossCsvKindSelect') as HTMLSelectElement | null)?.value || 'eoss_uj') as 'eoss_uj' | 'qoss_nc' | 'coss_pf';
      const voltageUnit = ((document.getElementById('focEossCsvVoltageUnitSelect') as HTMLSelectElement | null)?.value || 'V') as 'V' | 'mV';
      const valueUnit = ((document.getElementById('focEossCsvValueUnitSelect') as HTMLSelectElement | null)?.value || 'uJ') as 'uJ' | 'nJ' | 'mJ' | 'nC' | 'uC' | 'pF' | 'nF';
      return parseEossCurveCsv(csv, kind, voltageUnit, valueUnit, {
        label: 'CSV 导入 Eoss/Qoss/Coss 曲线', provenance: 'user_import',
      });
    }

    if (mode === 'preset_si_80v') {
      return integrateQossToEossCurve(
        [
          { vdsV: 0, val: 0 },
          { vdsV: 12, val: 18 },
          { vdsV: 24, val: 31 },
          { vdsV: 48, val: 50 },
          { vdsV: 60, val: 58 },
          { vdsV: 80, val: 72 },
        ],
        '预设 Si 80V Qoss(V) 积分曲线'
      );
    }
    if (mode === 'preset_sic_650v') {
      return integrateCossToEossCurve(
        [
          { vdsV: 0, val: 1400 },
          { vdsV: 25, val: 620 },
          { vdsV: 100, val: 240 },
          { vdsV: 200, val: 145 },
          { vdsV: 400, val: 98 },
          { vdsV: 650, val: 78 },
        ],
        '预设 SiC 650V Coss(V) 积分曲线'
      );
    }

    const raw = (document.getElementById('focEossCurveInput') as HTMLInputElement | null)?.value?.trim() || '';
    const tokens = raw
      .split(/[,\n;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const pts = tokens.map((tok) => {
      const parts = tok.split(/[:\s/]+/).map((p) => parseFloat(p));
      if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
        throw new Error(`非线性 Eoss/Qoss/Coss 曲线格式错误 ("${tok}")，请使用 "V:val, V:val" 格式。`);
      }
      return { vdsV: parts[0], val: parts[1] };
    });
    if (pts.length < 2) {
      throw new Error('自定义非线性电容曲线至少需要 2 个 (V:val) 数据点。');
    }
    if (mode === 'custom_qoss') return integrateQossToEossCurve(pts, '自定义 Qoss(V) 曲线');
    if (mode === 'custom_coss') return integrateCossToEossCurve(pts, '自定义 Coss(V) 曲线');
    return { kind: 'eoss_uj', points: pts, label: '自定义 Eoss(V) 曲线' };
  }

  private readFocParams(): { mos: FocMosParams; ctrl: FocControlParams; model: FocThermalModel } {
    const fieldLabels: Record<string, string> = {
      focRdsInput: 'Rds(on)@25°C', focAlphaInput: 'Rds 温度系数 α', focVsdInput: '体二极管压降 Vsd',
      focEswInput: 'Eon+Eoff', focEossInput: 'Eoss', focQrrInput: 'Qrr', focVrefInput: '开关能量参考电压 Vref',
      focIrefInput: 'Eon/Eoff 参考电流 Iref', focQrrIrefInput: 'Qr/Qrr 参考电流', focQrrReferenceVdsInput: 'Qr/Qrr 测试 VDS', focQrrReferenceDiDtInput: 'Qr/Qrr 测试 di/dt', focQrrReferenceTjInput: 'Qr/Qrr 测试结温', focQrrReferenceVgsInput: 'Qr/Qrr 测试 Vgs', focFswKhzInput: 'PWM 频率 Fsw', focTdeadNsInput: '死区时间',
      focModDepthInput: '调制度 m', focPfAngleInput: '功率因数角', focTambInput: '环境温度 Tamb',
      focVbusConstInput: '母线电压 Vdc',
    };
    const num = (id: string, fallback: number) => {
      const raw = (document.getElementById(id) as HTMLInputElement | null)?.value?.trim() ?? '';
      if (!raw) return fallback;
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`${fieldLabels[id] ?? id} 必须填写有限数值，当前输入为“${raw}”。`);
      return value;
    };
    const mod = ((document.getElementById('focModSelect') as HTMLSelectElement)?.value || 'SVPWM') as FocModulationMode;
    const rgOnRaw = (document.getElementById('focRgonInput') as HTMLInputElement | null)?.value?.trim() || '';
    const rgOffRaw = (document.getElementById('focRgoffInput') as HTMLInputElement | null)?.value?.trim() || '';
    const rgOnParsed = parseFloat(rgOnRaw);
    const rgOffParsed = parseFloat(rgOffRaw);
    const rgDesignConfirmed = (document.getElementById('focRgDesignConfirmedChk') as HTMLInputElement | null)?.checked ?? false;
    const eossCurve = this.parseFocNonlinearEossCurve();
    const rdsOnTempCurve = this.parseFocRdsOnTempCurve();
    const rdsOperatingVgsRaw = (document.getElementById('focRdsOperatingVgsInput') as HTMLInputElement | null)?.value?.trim() || '';
    const rdsOperatingVgsV = rdsOperatingVgsRaw ? Number(rdsOperatingVgsRaw) : undefined;
    const rds25ReferenceVgsRaw = (document.getElementById('focRds25ReferenceVgsInput') as HTMLInputElement | null)?.value?.trim() || '';
    const rds25ReferenceVgsV = rds25ReferenceVgsRaw ? Number(rds25ReferenceVgsRaw) : undefined;
    const mos: FocMosParams = {
      rdsOn25Mohm: num('focRdsInput', 4.5),
      rdsDataConfirmed: (document.getElementById('focRdsConfirmedChk') as HTMLInputElement | null)?.checked ?? false,
      tempCoeffAlphaPerC: num('focAlphaInput', 0.45) / 100,
      rdsOnTempCurve,
      rdsOperatingVgsV,
      rds25ReferenceVgsV,
      vsdV: num('focVsdInput', 0.9),
      eonPlusEoffUj: num('focEswInput', 0),
      eossUj: num('focEossInput', 0),
      eossCurve,
      eossAlreadyIncludedInEsw: (document.getElementById('focEossIncludedChk') as HTMLInputElement | null)?.checked ?? false,
      qrrNc: num('focQrrInput', 0),
      vRefV: num('focVrefInput', 13.5),
      iRefA: num('focIrefInput', 30),
      qrrIrefA: num('focQrrIrefInput', num('focIrefInput', 30)),
      qrrReferenceVdsV: (() => { const raw = (document.getElementById('focQrrReferenceVdsInput') as HTMLInputElement | null)?.value?.trim() || ''; return raw ? num('focQrrReferenceVdsInput', 0) : undefined; })(),
      qrrReferenceDiDtAperUs: (() => { const raw = (document.getElementById('focQrrReferenceDiDtInput') as HTMLInputElement | null)?.value?.trim() || ''; return raw ? num('focQrrReferenceDiDtInput', 0) : undefined; })(),
      qrrReferenceTjC: (() => { const raw = (document.getElementById('focQrrReferenceTjInput') as HTMLInputElement | null)?.value?.trim() || ''; return raw ? num('focQrrReferenceTjInput', 25) : undefined; })(),
      qrrReferenceVgsV: (() => { const raw = (document.getElementById('focQrrReferenceVgsInput') as HTMLInputElement | null)?.value?.trim() || ''; return raw ? num('focQrrReferenceVgsInput', 0) : undefined; })(),
      rgOnOhm: rgOnRaw && Number.isFinite(rgOnParsed) && rgOnParsed >= 0 ? rgOnParsed : undefined,
      rgOffOhm: rgOffRaw && Number.isFinite(rgOffParsed) && rgOffParsed >= 0 ? rgOffParsed : undefined,
      // Gate resistors entered in the workbench are design/configuration values,
      // not oscilloscope measurements. The solver additionally requires both Rg_on
      // and Rg_off to be finite before accepting the 4D LUT query.
      rgProvenance:
        rgDesignConfirmed && rgOnRaw && rgOffRaw && Number.isFinite(rgOnParsed) && Number.isFinite(rgOffParsed)
          ? 'design_specified'
          : 'assumed',
      eonIncludesQrr: (document.getElementById('focEonIncludesQrrChk') as HTMLInputElement | null)?.checked ?? false,
      qrrIncludesQoss: (document.getElementById('focQrrIncludesQossChk') as HTMLInputElement | null)?.checked ?? false,
      dptLut: this.useDptMatrixInFoc && this.dptMatrix.length > 0 ? this.dptMatrix.map((pt) => ({ ...pt })) : undefined,
    };
    const ctrl: FocControlParams = {
      modulation: mod,
      fswHz: num('focFswKhzInput', 20) * 1e3,
      tDeadNs: num('focTdeadNsInput', 500),
      modDepthM: num('focModDepthInput', 0.85),
      pfAngleDeg: num('focPfAngleInput', 0),
      tAmbC: num('focTambInput', 25),
      vBusConstV: num('focVbusConstInput', 13.5),
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
    const rdsConfirmed = (document.getElementById('focRdsConfirmedChk') as HTMLInputElement | null)?.checked ?? false;
    if (!rdsConfirmed) {
      pushUnique('▲ Rds25 尚未确认为目标器件数据：当前数值 4.5 mΩ 只是界面示例起点，结温结果不能视为器件级已标定结果。');
    }
    const rdsCurveRaw = (document.getElementById('focRdsTempCurveJsonInput') as HTMLTextAreaElement | null)?.value?.trim() || '';
    if (rdsCurveRaw) {
      try {
        const curve = parseRdsOnTempCurveImportJson(rdsCurveRaw);
        const operatingVgs = (document.getElementById('focRdsOperatingVgsInput') as HTMLInputElement | null)?.value?.trim() || '未填写';
        pushUnique(`ℹ Rds(Tj) 使用归一化器件曲线，曲线测试 Vgs=${curve.referenceGateVoltageV.toFixed(2)}V，当前 MOS Vgs,on=${operatingVgs}V；两者必须匹配 ±0.10V。温度范围 ${curve.points[0].tjC}～${curve.points[curve.points.length - 1].tjC}°C，超出范围拒绝计算。${curve.sourceNote ? `曲线来源说明：${curve.sourceNote}` : ''}`);
      } catch (err) {
        pushUnique(`✖ Rds(Tj) 曲线无效：${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      pushUnique('ℹ Rds(Tj) 当前采用常数线性 α 模型；优先使用目标 MOS 在实际 Vgs 条件下的 Rds(on)-Tj 曲线。');
    }
    const eossCurveModeForWarning = (document.getElementById('focEossCurveModeSelect') as HTMLSelectElement | null)?.value || 'scalar';
    if (eossCurveModeForWarning === 'preset_si_80v' || eossCurveModeForWarning === 'preset_sic_650v') {
      pushUnique('▲ 当前选用的是示例 Eoss/Qoss/Coss 曲线，不代表目标器件；工程结论请替换为同型号、对应 Vds 条件的器件曲线。');
    }
    const eswRaw = (document.getElementById('focEswInput') as HTMLInputElement | null)?.value?.trim() || '';
    const eossRaw = (document.getElementById('focEossInput') as HTMLInputElement | null)?.value?.trim() || '';
    const qrrRaw = (document.getElementById('focQrrInput') as HTMLInputElement | null)?.value?.trim() || '';
    const qrrIncludesQoss = (document.getElementById('focQrrIncludesQossChk') as HTMLInputElement | null)?.checked ?? false;
    if (qrrIncludesQoss && qrrRaw) pushUnique('ℹ 当前 Qr 定义包含 Qoss/电容性恢复（Nexperia: Qr=Qs+Qoss）；已禁止再独立添加 Eoss。当前仍以 Qr×Vbus 估算总恢复能量，不等于 DPT 能量积分。');
    const eossCurveMode = (document.getElementById('focEossCurveModeSelect') as HTMLSelectElement | null)?.value || 'scalar';
    const hasEossCurve = eossCurveMode !== 'scalar';
    if (!this.useDptMatrixInFoc && !eswRaw && !qrrRaw && !eossRaw && !hasEossCurve) {
      pushUnique('▲ Esw/Qrr/Eoss 均未提供：当前排除开关能量、反向恢复与零电流 Coss 损耗，只保留导通及已启用的死区修正；结温可能明显偏低。');
    } else {
      if (!this.useDptMatrixInFoc && !eswRaw) pushUnique('▲ Esw 未输入：标量开关能量项为 0；若开关损耗不可忽略，请导入覆盖 Vds/Id/Rg/Tj 工况的 DPT LUT 或填写对应工况 Eon+Eoff。');
      if (!eossRaw && !hasEossCurve && !this.useDptMatrixInFoc && !qrrIncludesQoss) pushUnique('ℹ Eoss 未输入：零电流 Coss 充放电项按 0 处理；只有在 Esw 已含该项或确认该损耗可忽略时才保持空白。');
      if (!qrrRaw && !this.useDptMatrixInFoc && !(document.getElementById('focEonIncludesQrrChk') as HTMLInputElement | null)?.checked) {
        pushUnique('ℹ Qrr 未输入：额外反向恢复损耗按 0 处理；仅当 Esw 已包含 Qrr 或确认该项可忽略时才应保持空白。');
      }
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

    const tAmb = this.readFiniteInput('focTambInput', 25);
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
      ['mission', 'focViewMissionBtn'],
      ['derating', 'focViewDeratingBtn'],
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

  private renderFocSteadyOperatingPoint(): void {
    const hint = document.getElementById('focSteadyOperatingPointHint');
    if (!hint) return;
    const point = this.activeFocSteadyPoint;
    const angleWrap = document.getElementById('focSteadyAngleWrap');
    if (angleWrap) angleWrap.classList.toggle('hidden', point?.mode !== 'locked_rotor');
    if (!point) {
      hint.textContent = '尚未从 FOC DynoLab 导入固定工况。请先在 DynoLab Tab 3 计算并发送一个稳态工作点。';
      return;
    }
    const modeLabel = point.mode === 'locked_rotor' ? '零速固定电角度' : '恒定 dq 旋转工况';
    const angleInput = document.getElementById('focSteadyAngleInput') as HTMLInputElement | null;
    const electricalAngleDeg = point.mode === 'locked_rotor'
      ? (angleInput && Number.isFinite(Number(angleInput.value)) ? Number(angleInput.value) : (point.electricalAngleDeg ?? 90))
      : point.electricalAngleDeg;
    const read = (id: string, fallback: string): string => {
      const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
      return el?.value || fallback;
    };
    const conditions = [
      `Vdc=${read('focVbusConstInput', '--')} V`,
      `${read('focModSelect', 'SVPWM')} m=${read('focModDepthInput', '--')}`,
      `φ=${read('focPfAngleInput', '--')}°`,
      `fsw=${read('focFswKhzInput', '--')} kHz`,
      `td=${read('focTdeadNsInput', '--')} ns`,
      `Tamb=${read('focTambInput', '--')}°C`,
    ];
    const mechanics = Number.isFinite(point.mechanicalSpeedRpm) && Number.isFinite(point.torqueNm)
      ? ` · n=${point.mechanicalSpeedRpm!.toFixed(0)} rpm · T=${point.torqueNm!.toFixed(3)} N·m`
      : '';
    hint.textContent = `${modeLabel} · Id=${(point.idPeakA ?? 0).toFixed(3)} A(pk) · Iq=${point.iqPeakA.toFixed(3)} A(pk) · fe=${point.electricalFrequencyHz.toFixed(3)} Hz${mechanics} · ${conditions.join(' · ')}${point.mode === 'locked_rotor' ? ` · θe=${(electricalAngleDeg ?? 90).toFixed(1)}°` : ''}`;
  }

  private renderFocSteadyResult(result: FocSteadyStateResult): void {
    const box = document.getElementById('focSteadyResultBox');
    if (!box) return;
    const qualified = result.resultQualification === 'DEVICE_PARAMETERIZED' && result.steadyConverged && !result.thermalRunaway && result.powerBalanceStatus !== 'EXCEEDS_BUDGET';
    const qualificationEl = document.getElementById('focSteadyQualification');
    const powerEl = document.getElementById('focSteadyPower');
    const boardEl = document.getElementById('focSteadyBoard');
    const tjEl = document.getElementById('focSteadyTjMax');
    if (qualificationEl) {
      qualificationEl.textContent = `${result.resultQualification}${result.steadyConverged ? '' : ' · 未收敛'}${result.thermalRunaway ? ' · 热失控' : ''}`;
      qualificationEl.className = `font-semibold mt-0.5 ${qualified ? 'text-emerald-300' : 'text-amber-300'}`;
    }
    const thermalPointUsable = result.steadyConverged && !result.thermalRunaway;
    if (powerEl) powerEl.textContent = thermalPointUsable ? `${result.pInverterTotalW.toFixed(3)} W` : '--（热稳态无效）';
    if (boardEl) boardEl.textContent = thermalPointUsable ? `${result.tBoardSteadyC.toFixed(2)} °C` : '--（热稳态无效）';
    if (tjEl) tjEl.textContent = thermalPointUsable ? `${result.tjMaxSteadyC.toFixed(2)} °C · ${result.hottestKey}` : '--（不得作为稳态结温）';

    const tbody = document.getElementById('focSteadySwitchTableBody');
    if (tbody) {
      tbody.innerHTML = '';
      for (const row of result.perSwitch) {
        const tr = document.createElement('tr');
        tr.className = `border-t border-[#222933] ${thermalPointUsable && row.key === result.hottestKey ? 'bg-rose-950/25' : ''}`;
        const cells = [
          `${row.key}${thermalPointUsable && row.key === result.hottestKey ? ' ★' : ''}`,
          thermalPointUsable ? row.pCondW.toFixed(4) : '--',
          thermalPointUsable ? row.pSwitchingW.toFixed(4) : '--',
          thermalPointUsable ? row.pDeadTimeW.toFixed(4) : '--',
          thermalPointUsable ? row.pTotalW.toFixed(4) : '--',
          thermalPointUsable ? row.boardSteadyC.toFixed(2) : '--',
          thermalPointUsable ? row.tjSteadyC.toFixed(2) : '--',
        ];
        cells.forEach((value, index) => {
          const td = document.createElement('td');
          td.className = `px-2 py-1 ${index === 0 ? 'font-semibold text-cyan-300' : index === 4 ? 'text-amber-300' : index === 6 ? 'text-pink-300' : 'text-slate-200'}`;
          td.textContent = value;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
    }
    const detail = document.getElementById('focSteadyDetail');
    if (detail) {
      const lines = [
        `固定工况：Vdc=${result.vBusConstV.toFixed(3)} V · ${result.modulation} m=${result.modDepthM.toFixed(4)} · φ=${result.pfAngleDeg.toFixed(2)}° · fsw=${(result.fswHz / 1000).toFixed(3)} kHz · td=${result.tDeadNs.toFixed(1)} ns · Tamb=${result.tAmbC.toFixed(1)}°C`,
        `工作点：Id=${result.idPeakA.toFixed(3)} A(pk) · Iq=${result.iqPeakA.toFixed(3)} A(pk) · fe=${result.electricalFrequencyHz.toFixed(3)} Hz${result.mechanicalSpeedRpm === null ? '' : ` · n=${result.mechanicalSpeedRpm.toFixed(0)} rpm`}${result.torqueNm === null ? '' : ` · T=${result.torqueNm.toFixed(3)} N·m`}`,
        `按 ${result.integrationSamples} 个电角度点计算${result.mode === 'rotating' ? '完整电周期平均损耗' : `固定电角度 ${result.electricalAngleDeg?.toFixed(1)}°`}`,
        thermalPointUsable
          ? `Pcond=${result.pCondTotalW.toFixed(3)} W · Psw=${result.pSwitchingTotalW.toFixed(3)} W · Pdead=${result.pDeadTimeTotalW.toFixed(3)} W`
          : 'Pcond/Psw/Pdead/P6MOS：--（热稳态无效；当前内部值仅为迭代诊断，不作为结果）',
        result.busInputPowerW === null ? '' : `FOC 母线输入功率=${result.busInputPowerW.toFixed(3)} W`,
        result.mechanicalPowerW === null ? '' : `FOC 机械输出功率=${result.mechanicalPowerW.toFixed(3)} W`,
        result.dcLinkPowerW === null ? '' : `DC 链路功率=${result.dcLinkPowerW.toFixed(3)} W · 电机端电功率=${result.motorElectricalPowerW?.toFixed(3) ?? '--'} W`,
        !thermalPointUsable ? '热稳态无效：跳过六管损耗与 FOC 逆变器损耗预算比较。' : result.impliedInverterLossW === null ? '无可用 FOC 逆变器损耗预算，跳过功率平衡校验。' : `FOC 效率模型隐含逆变器损耗预算=${result.impliedInverterLossW.toFixed(3)} W · 六管损耗预算余量=${result.inverterLossBudgetMarginW?.toFixed(3) ?? '--'} W · ${result.powerBalanceStatus}`,
        result.integrationErrorPct === null ? '堵转点计算，不涉及电周期积分误差。' : `粗/细积分差异估计 ${result.integrationErrorPct.toFixed(4)}%。`,
        result.pwmCyclesPerElectricalCycle === null ? '静止转子，无电周期 PWM 比值。' : `fsw/fe=${result.pwmCyclesPerElectricalCycle.toFixed(1)} PWM 周期/电周期。`,
        ...result.qualificationReasons,
        ...result.warnings,
      ];
      detail.textContent = lines.join('\n');
    }
    box.classList.remove('hidden');
  }

  private renderFocVoltageEnvelope(rows: FocVoltageEnvelopeRow[], referenceVoltageV: number): void {
    const box = document.getElementById('focVoltageEnvelopeBox');
    const tbody = document.getElementById('focVoltageEnvelopeBody');
    const note = document.getElementById('focVoltageEnvelopeNote');
    const details = document.getElementById('focVoltageEnvelopeDetails');
    if (!box || !tbody) return;
    tbody.innerHTML = '';
    for (const row of rows) {
      const tr = document.createElement('tr');
      const result = row.result;
      const thermalFailure = row.status === 'THERMAL_NOT_CONVERGED' || row.status === 'THERMAL_RUNAWAY';
      const resultUsable = row.status === 'CALCULATED' && Boolean(result?.steadyConverged) && !result?.thermalRunaway;
      tr.className = `border-t border-[#222933] ${row.status === 'VOLTAGE_LIMITED' || row.status === 'THERMAL_RUNAWAY' ? 'bg-rose-950/20' : row.status === 'MODEL_OUT_OF_RANGE' || row.status === 'INVALID_INPUT' || thermalFailure ? 'bg-amber-950/20' : ''}`;
      const values = [
        `${row.vBusV.toFixed(1)} V`,
        row.requiredModDepthM.toFixed(4),
        resultUsable ? result!.pCondTotalW.toFixed(3) : '--',
        resultUsable ? result!.pSwitchingTotalW.toFixed(3) : '--',
        resultUsable ? result!.pDeadTimeTotalW.toFixed(3) : '--',
        resultUsable ? result!.pInverterTotalW.toFixed(3) : '--',
        resultUsable ? `${result!.tjMaxSteadyC.toFixed(2)} °C` : '--（无有效稳态 Tj）',
        row.status === 'VOLTAGE_LIMITED' ? '电压能力不足' : row.status === 'MODEL_OUT_OF_RANGE'
          ? '模型数据越界' : row.status === 'THERMAL_RUNAWAY' ? '热失控'
            : row.status === 'THERMAL_NOT_CONVERGED' ? '热稳态未收敛'
              : row.status === 'INVALID_INPUT' ? '输入/热模型错误' : `${result!.resultQualification}`, 
      ];
      values.forEach((value, index) => {
        const td = document.createElement('td');
        td.className = `px-2 py-1 ${index === 0 ? 'font-semibold text-cyan-300' : index === 5 ? 'text-amber-300' : index === 6 ? 'text-pink-300' : index === 7 ? (resultUsable ? 'text-emerald-300' : 'text-rose-300') : 'text-slate-200'}`;
        td.textContent = value;
        if (index === 7) td.title = row.note;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    if (note) {
      note.textContent = `参考母线 ${referenceVoltageV.toFixed(2)}V、参考调制度按 m·Vdc 恒定换算。Id/Iq、fe、Fsw、PF、死区、Tamb、MOS 共用器件参数和热网络保持不变。该评估用于电压边界敏感度；若低压点超过线性调制上限则标记电压能力不足，不伪造该点的损耗/结温。DPT/Eoss 数据超出 9～16V 覆盖范围时对应点会拒绝计算。`;
    }
    if (details) {
      details.textContent = rows.map((row) => `${row.vBusV.toFixed(1)}V · m_required=${row.requiredModDepthM.toFixed(4)} · ${row.note}`).join('\n');
    }
    box.classList.remove('hidden');
  }

  private runFocVoltageEnvelope(): void {
    const sourcePoint = this.activeFocSteadyPoint;
    if (!sourcePoint) {
      this.app.showToast('请先从 FOC DynoLab Tab 3 导入固定工况，再执行 9/13.5/16V 电压边界评估。', 'warn');
      return;
    }
    let point: FocSteadyOperatingPoint = sourcePoint;
    if (sourcePoint.mode === 'locked_rotor') {
      const angleRaw = (document.getElementById('focSteadyAngleInput') as HTMLInputElement | null)?.value.trim() ?? '';
      const angle = Number(angleRaw);
      if (!angleRaw || !Number.isFinite(angle) || angle < 0 || angle > 360) {
        this.app.showToast('零速堵转电压边界评估必须输入实际转子电角度 θe（0°～360°）。', 'error');
        return;
      }
      point = { ...sourcePoint, electricalAngleDeg: angle };
    }
    try {
      this.refreshFocModelAndSpice();
      const { mos, ctrl, model } = this.readFocParams();
      const rows = simulateFoc6MosVoltageEnvelope({
        model, mos, ctrl, operatingPoint: point,
        voltagePoints: [9, 13.5, 16],
        referenceVoltageV: ctrl.vBusConstV,
        integrationSamples: 1440,
      });
      this.lastFocVoltageEnvelope = rows;
      this.renderFocVoltageEnvelope(rows, ctrl.vBusConstV);
      const limited = rows.filter((row) => row.status === 'VOLTAGE_LIMITED').map((row) => `${row.vBusV}V`);
      const failed = rows.filter((row) => ['MODEL_OUT_OF_RANGE', 'INVALID_INPUT', 'THERMAL_NOT_CONVERGED', 'THERMAL_RUNAWAY'].includes(row.status)).map((row) => `${row.vBusV}V(${row.status})`);
      const calculated = rows.filter((row) => row.status === 'CALCULATED');
      this.app.showToast(
        `电压边界评估完成：收敛计算 ${calculated.length}/3；电压能力不足 ${limited.join(', ') || '无'}；模型/热求解异常 ${failed.join(', ') || '无'}。`,
        limited.length || failed.length ? 'warn' : 'info'
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastFocVoltageEnvelope = null;
      this.renderFocWarnings([`电压边界评估失败：${message}`]);
      this.app.showToast(`电压边界评估失败：${message}`, 'error');
    }
  }

  private runFocSteadyState(): void {
    const sourcePoint = this.activeFocSteadyPoint;
    if (!sourcePoint) {
      this.app.showToast('请先从 FOC DynoLab Tab 3 导入固定工况；恒定稳态计算不从瞬态波形反推 Id/Iq。', 'warn');
      this.renderFocSteadyOperatingPoint();
      return;
    }
    const angleInput = document.getElementById('focSteadyAngleInput') as HTMLInputElement | null;
    let point: FocSteadyOperatingPoint = sourcePoint;
    if (sourcePoint.mode === 'locked_rotor') {
      const angleRaw = angleInput?.value.trim() ?? '';
      if (!angleRaw) {
        this.app.showToast('零速堵转必须输入实际转子电角度 θe，不能留空。', 'error');
        return;
      }
      const angle = Number(angleRaw);
      if (!Number.isFinite(angle) || angle < 0 || angle > 360) {
        this.app.showToast('转子电角度 θe 必须是 0°～360° 的有限数值。', 'error');
        return;
      }
      point = { ...sourcePoint, electricalAngleDeg: angle };
    }
    try {
      this.refreshFocModelAndSpice();
      const { mos, ctrl, model } = this.readFocParams();
      const result = simulateFoc6MosSteadyState({ model, mos, ctrl, operatingPoint: point, integrationSamples: 1440 });
      this.lastFocSteadyResult = result;
      this.renderFocSteadyOperatingPoint();
      this.renderFocSteadyResult(result);
      this.renderFocWarnings(result.warnings);
      const thermalPointUsable = result.steadyConverged && !result.thermalRunaway;
      const isQualified = result.resultQualification === 'DEVICE_PARAMETERIZED' && thermalPointUsable && result.powerBalanceStatus !== 'EXCEEDS_BUDGET';
      const toastMessage = !thermalPointUsable
        ? `恒定工况已执行，但未得到有效热稳态（${result.thermalRunaway ? '热失控' : '热稳态未收敛'}）；不显示中间迭代功耗/结温。`
        : `恒定工况计算完成：P6MOS=${result.pInverterTotalW.toFixed(3)}W，Tj_max=${result.tjMaxSteadyC.toFixed(2)}°C（${result.resultQualification}${result.powerBalanceStatus === 'EXCEEDS_BUDGET' ? ' · 超出逆变器损耗预算' : ''}）`;
      this.app.showToast(toastMessage, isQualified ? 'info' : 'warn');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastFocSteadyResult = null;
      this.renderFocWarnings([`恒定工况计算失败：${message}`]);
      const box = document.getElementById('focSteadyResultBox');
      if (box) box.classList.add('hidden');
      this.app.showToast(`恒定工况计算失败：${message}`, 'error');
    }
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
      const extraMsgs = [...res.warnings];
      if (res.spatialThermalProvenance) {
        extraMsgs.push(`ℹ 热网络拓扑: ${res.spatialThermalProvenance}`);
      }
      if (res.dptLutDiagnostics) {
        extraMsgs.push(
          `ℹ 4D DPT LUT 状态=${res.dptLutDiagnostics.status} · 有效维度=[${res.dptLutDiagnostics.activeDimensions.join(',') || '无'}] · 退化维度=[${res.dptLutDiagnostics.collapsedDimensions.join(',') || '无'}] (Tj:${res.dptLutDiagnostics.tjProvenance}, Rg:${res.dptLutDiagnostics.rgProvenance})`
        );
      }
      this.renderFocWarnings(extraMsgs);

      const resultIsQualified = res.resultQualification === 'DEVICE_PARAMETERIZED';
      const resultPrefix = resultIsQualified ? '' : res.resultQualification === 'INCOMPLETE_LOSS_MODEL' ? '不完整模型估算* · ' : '假设模型估算* · ';
      const hotEl = document.getElementById('focKpiHottest');
      if (hotEl) {
        hotEl.innerText = `${resultPrefix}${res.hottestKey}: ${res.tjMaxGlobalC.toFixed(2)}°C (${
          res.steadyThermalRunaway ? '稳态热失控!' : `稳态~${res.tjSteadyMaxEstC.toFixed(1)}°C`
        })`;
      }
      const pwrEl = document.getElementById('focKpiPower');
      if (pwrEl) {
        pwrEl.innerText = `${res.pInvMeanW.toFixed(2)}${resultIsQualified ? '' : '*'} W / ${res.tBoardFinalC.toFixed(1)}${resultIsQualified ? '' : '*'}°C (${
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
            <td class="px-2 py-1" title="${resultIsQualified ? '参数化模型输出；仍需实际 PCB/器件数据验证' : '带 * 表示假设或不完整损耗模型估算，不可作为热设计签核值'}">${s.tjAvgC.toFixed(2)}${resultIsQualified ? '' : '*'} °C</td>
            <td class="px-2 py-1 text-pink-300" title="${resultIsQualified ? '参数化模型输出；仍需实际 PCB/器件数据验证' : '带 * 表示假设或不完整损耗模型估算，不可作为热设计签核值'}">${s.tjPeakC.toFixed(2)}${resultIsQualified ? '' : '*'} °C</td>
            <td class="px-2 py-1">${s.tjRippleC.toFixed(2)}${resultIsQualified ? '' : '*'} °C</td>
            <td class="px-2 py-1 text-amber-300">${s.pAvgW.toFixed(2)}${resultIsQualified ? '' : '*'} W</td>
            <td class="px-2 py-1">${s.pCondAvgW.toFixed(2)}${resultIsQualified ? '' : '*'} W</td>
            <td class="px-2 py-1">${s.pSwAvgW.toFixed(2)}${resultIsQualified ? '' : '*'} W</td>
            <td class="px-2 py-1">${s.pDeadAvgW.toFixed(2)}${resultIsQualified ? '' : '*'} W</td>
          `;
          tbody.appendChild(tr);
        });
      }

      this.drawFocCanvas();
      const dutyNote = res.dutySource === 'external' ? '外部 Duty_A/B/C' : ctrl.modulation;
      const steadyNote = res.steadyThermalRunaway ? '稳态热失控!' : `稳态~${res.tjSteadyMaxEstC.toFixed(1)}°C`;
      this.app.showToast(
        `6-MOS FOC (${dutyNote})${resultIsQualified ? ' [PARAMETERIZED]' : ` [${res.resultQualification}*]`}: ${res.hottestKey} Peak=${res.tjMaxGlobalC.toFixed(2)}°C (${steadyNote}), P_inv=${res.pInvMeanW.toFixed(2)}W`,
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
      name: `${sim.resultQualification === 'DEVICE_PARAMETERIZED' ? 'Tj' : 'Tj*'}_${key}`,
      unit: '°C',
      t: sim.time,
      values: sim.tj[key],
      color: colors[idx],
      badge: sim.resultQualification === 'DEVICE_PARAMETERIZED' ? 'FOC' : 'FOC*',
      expr: `6MOS(${key})`,
      sourceIds: iaId ? [iaId] : [],
      baseChannelId: iaId,
      pinMetrics: key === sim.hottestKey ? (['max'] as Array<'max' | 'average'>) : undefined,
    }));
    specs.push({
      replaceKey: 'foc_pinv_total',
      name: sim.resultQualification === 'DEVICE_PARAMETERIZED' ? 'P_inv_total' : 'P_inv_total*',
      unit: 'W',
      t: sim.time,
      values: sim.pInvTotal,
      color: '#fb923c',
      badge: sim.resultQualification === 'DEVICE_PARAMETERIZED' ? 'INV' : 'INV*',
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
          ? `${res.resultQualification !== 'DEVICE_PARAMETERIZED' ? `仅估算(${res.resultQualification}) · ` : ''}t_safe=${res.tSafeSec.toFixed(2)}s @ θ=${res.tSafeAngleDeg}°/${res.transientWorstSwitch} · 正弦等效 I²t:${res.i2tRmsA2s?.toFixed(0)} / 最不利相 I²t:${res.i2tWorstLegA2s?.toFixed(0)} A²s${res.stallVoltageLimited ? ' · 请求电流超出线性调制电压能力（条件估算）' : ''}`
          : !res.stallSteadyConverged
          ? '稳态求解未收敛（不可判 SAFE）'
          : res.stallThermalRunaway
          ? '热失控（不可判 SAFE）'
          : res.stallVoltageLimited
          ? '请求电流超出线性调制电压能力；热结果仅为强制电流假设，不可判 SAFE'
          : res.resultQualification !== 'DEVICE_PARAMETERIZED'
          ? `模型输入等级 ${res.resultQualification}；仅估算，不可判 SAFE`
          : res.steadySafe
          ? `稳态安全；本时域 ${res.transientTime[res.transientTime.length - 1].toFixed(0)}s 未越限`
          : `稳态超限；本时域未越限`;
        const transientThermalLimitCrossed = res.tSafeSec !== null;
        safeEl.className = res.steadySafe && !transientThermalLimitCrossed
          ? 'text-emerald-300 font-semibold'
          : res.resultQualification !== 'DEVICE_PARAMETERIZED' ? 'text-amber-300 font-semibold' : 'text-rose-300 font-semibold';
      }

      this.drawFocCanvas();
      this.app.showToast(
        `Stall Sweep [${res.resultQualification}] (${res.effectiveStallModulation}, m=${res.effectiveStallModDepthM.toFixed(3)}, R_s=${res.rPhaseUsedOhm.toFixed(3)}Ω, init=${res.inheritedBoardTempC.toFixed(1)}°C): Worst ${res.worstSwitch} @ θ=${res.worstAngleDeg}° (${res.stallThermalRunaway ? '热失控' : `${res.worstSteadyTjC.toFixed(1)}°C steady`})`,
        res.steadySafe && res.tSafeSec === null && !res.stallVoltageLimited && res.resultQualification === 'DEVICE_PARAMETERIZED' ? 'info' : 'warn'
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

      const extraNotes = [
        ...res.svpwm.warnings.map((w) => `SVPWM：${w}`),
        ...res.dpwm1.warnings.map((w) => `DPWM1：${w}`),
        ...res.spwm.warnings.map((w) => `SPWM：${w}`),
      ];
      if (sel.daCh && sel.dbCh && sel.dcCh) {
        extraNotes.push('调制策略扫频仅比较理论重构波形 (SVPWM vs DPWM1 vs SPWM)，已忽略外部 Duty_A/B/C 选择。');
      }
      this.renderFocWarnings(extraNotes);
      this.drawFocCanvas();

      const pSave = res.svpwm.pInvMeanW - res.dpwm1.pInvMeanW;
      this.app.showToast(
        `${[res.svpwm, res.dpwm1, res.spwm].some((r) => r.resultQualification !== 'DEVICE_PARAMETERIZED') ? '[ESTIMATE*] ' : '[PARAMETERIZED] '}SVPWM (${res.svpwm.pInvMeanW.toFixed(2)}W, ${res.svpwm.tjMaxGlobalC.toFixed(2)}°C) vs DPWM1 (${res.dpwm1.pInvMeanW.toFixed(2)}W, ${res.dpwm1.tjMaxGlobalC.toFixed(2)}°C) -> Saves ${pSave.toFixed(2)} W`,
        [res.svpwm, res.dpwm1, res.spwm].some((r) => r.resultQualification !== 'DEVICE_PARAMETERIZED') ? 'warn' : 'info'
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
    } else if (this.focCanvasMode === 'sweep') {
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
    } else if (this.focCanvasMode === 'mission') {
      if (titleEl) titleEl.innerText = '多阶段任务剖面循环 6-MOS Tj(t) & T_board(t)';
      const mp = this.lastMissionResult;
      if (!mp || mp.time.length < 2) {
        ctx.fillStyle = th.emptyText;
        ctx.font = '12px "IBM Plex Sans", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('请展开“多阶段任务剖面循环”并点击“运行任务剖面”', w / 2, h / 2);
        return;
      }
      const t0 = mp.time[0];
      const tSpan = Math.max(1e-6, mp.time[mp.time.length - 1] - t0);
      let yMin = Infinity;
      let yMax = mp.tjLimitC * 1.04;
      for (const k of MOS_SWITCH_KEYS) {
        const arr = mp.tj[k];
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] < yMin) yMin = arr[i];
          if (arr[i] > yMax) yMax = arr[i];
        }
      }
      for (let i = 0; i < mp.tBoard.length; i++) {
        if (mp.tBoard[i] < yMin) yMin = mp.tBoard[i];
      }
      if (!Number.isFinite(yMin)) yMin = 20;
      const ys = Math.max(5, yMax - yMin);
      yMin -= ys * 0.06;
      yMax += ys * 0.08;

      const xOf = (t: number) => pad.l + ((t - t0) / tSpan) * pw;
      const yOf = (v: number) => pad.t + ph - ((v - yMin) / (yMax - yMin)) * ph;

      // Stage alternating translucent bands
      mp.stageSummaries.forEach((s, idx) => {
        const x1 = xOf(s.tStartSec);
        const x2 = xOf(s.tEndSec);
        ctx.fillStyle = s.mode === 'locked_rotor'
          ? 'rgba(244, 63, 94, 0.10)'
          : idx % 2 === 0
          ? 'rgba(56, 189, 248, 0.05)'
          : 'rgba(148, 163, 184, 0.03)';
        ctx.fillRect(x1, pad.t, Math.max(1, x2 - x1), ph);
        if (x2 - x1 >= 34 && s.cycleIndex === 0) {
          ctx.fillStyle = th.axisText;
          ctx.font = '9px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText(s.label.slice(0, 8), (x1 + x2) / 2, pad.t + 11);
        }
      });

      drawGrid();

      // Tj_limit dashed red line
      if (mp.tjLimitC >= yMin && mp.tjLimitC <= yMax) {
        ctx.strokeStyle = th.redDashed;
        ctx.setLineDash([5, 3]);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(pad.l, yOf(mp.tjLimitC));
        ctx.lineTo(pad.l + pw, yOf(mp.tjLimitC));
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // T_board dashed
      ctx.strokeStyle = th.tBoard;
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      const step = Math.max(1, Math.floor(mp.time.length / 450));
      for (let i = 0; i < mp.time.length; i += step) {
        const px = xOf(mp.time[i]);
        const py = yOf(mp.tBoard[i]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      const colors = th.focColors;
      MOS_SWITCH_KEYS.forEach((key, idx) => {
        ctx.strokeStyle = colors[idx];
        ctx.lineWidth = key === mp.hottestKeyGlobal ? 2.2 : 1.2;
        ctx.beginPath();
        const arr = mp.tj[key];
        for (let i = 0; i < mp.time.length; i += step) {
          const px = xOf(mp.time[i]);
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
        ctx.fillText(`${val.toFixed(0)}°C`, pad.l - 6, pad.t + (ph * i) / 4 + 3);
      }
      ctx.textAlign = 'center';
      for (let i = 0; i <= 5; i++) {
        ctx.fillText(`${(t0 + (tSpan * i) / 5).toFixed(1)}s`, pad.l + (pw * i) / 5, pad.t + ph + 15);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = th.titleText;
      const ratchetTxt = mp.ratchetDeltaTjC !== null ? ` · 热棘轮 ΔTj=${mp.ratchetDeltaTjC >= 0 ? '+' : ''}${mp.ratchetDeltaTjC.toFixed(2)}°C` : '';
      ctx.fillText(`Peak ${mp.hottestKeyGlobal}=${mp.tjPeakGlobalC.toFixed(1)}°C / Limit ${mp.tjLimitC}°C${ratchetTxt}`, pad.l + 6, pad.t - 6);
    } else if (this.focCanvasMode === 'derating') {
      if (titleEl) titleEl.innerText = '环境温度 × 母线电压 电流降额曲线 I_rms,max(T_amb)';
      const dr = this.lastDeratingResult;
      if (!dr || dr.points.length === 0) {
        ctx.fillStyle = th.emptyText;
        ctx.font = '12px "IBM Plex Sans", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('请展开“温度 × 电压电流降额曲线”并点击“计算降额曲线”', w / 2, h / 2);
        return;
      }
      drawGrid();
      const xMin = Math.min(...dr.tAmbPointsC);
      const xMax = Math.max(...dr.tAmbPointsC);
      const xSpan = Math.max(1, xMax - xMin);
      const validI = dr.points
        .map((p) => (p.iRmsMaxA !== null ? p.iRmsMaxA : 0))
        .filter((v) => Number.isFinite(v));
      const yMin = 0;
      const yMax = Math.max(10, Math.max(...validI, 10) * 1.12);
      const xOf = (t: number) => pad.l + ((t - xMin) / xSpan) * pw;
      const yOf = (iVal: number) => pad.t + ph - ((iVal - yMin) / Math.max(1e-3, yMax - yMin)) * ph;

      const vColors = ['#f59e0b', '#22d3ee', '#4ade80', '#f472b6', '#a78bfa'];
      dr.vBusPointsV.forEach((vBus, vIdx) => {
        const color = vColors[vIdx % vColors.length];
        const pts = dr.points
          .filter((p) => Math.abs(p.vBusV - vBus) < 1e-6)
          .sort((a, b) => a.tAmbC - b.tAmbC);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        let started = false;
        for (const pt of pts) {
          if (pt.iRmsMaxA === null) {
            started = false;
            continue;
          }
          const px = xOf(pt.tAmbC);
          const py = yOf(pt.iRmsMaxA);
          if (!started) {
            ctx.moveTo(px, py);
            started = true;
          } else {
            ctx.lineTo(px, py);
          }
        }
        ctx.stroke();

        // Draw markers: filled circle for THERMAL_LIMIT, hollow square for LUT/ceiling, red X for VOLTAGE_LIMITED
        for (const pt of pts) {
          const px = xOf(pt.tAmbC);
          if (pt.iRmsMaxA !== null) {
            const py = yOf(pt.iRmsMaxA);
            ctx.fillStyle = color;
            ctx.strokeStyle = color;
            if (pt.limitReason === 'THERMAL_LIMIT' || pt.limitReason === 'ZERO_MARGIN') {
              ctx.beginPath();
              ctx.arc(px, py, 3.5, 0, Math.PI * 2);
              ctx.fill();
            } else {
              ctx.lineWidth = 1.6;
              ctx.strokeRect(px - 3.5, py - 3.5, 7, 7);
            }
          } else if (pt.limitReason === 'VOLTAGE_LIMITED') {
            const py = yOf(0) - 6;
            ctx.strokeStyle = th.red;
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.moveTo(px - 3.5, py - 3.5);
            ctx.lineTo(px + 3.5, py + 3.5);
            ctx.moveTo(px + 3.5, py - 3.5);
            ctx.lineTo(px - 3.5, py + 3.5);
            ctx.stroke();
          }
        }

        // Legend label top-right
        ctx.fillStyle = color;
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'right';
        ctx.fillText(`● ${vBus}V`, pad.l + pw - 6 - vIdx * 58, pad.t + 12);
      });

      ctx.fillStyle = th.axisText;
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      for (let i = 0; i <= 4; i++) {
        const val = yMax - ((yMax - yMin) * i) / 4;
        ctx.fillText(`${val.toFixed(1)}A`, pad.l - 6, pad.t + (ph * i) / 4 + 3);
      }
      ctx.textAlign = 'center';
      dr.tAmbPointsC.forEach((tAmb) => {
        ctx.fillText(`${tAmb}°C`, xOf(tAmb), pad.t + ph + 15);
      });
      ctx.textAlign = 'left';
      ctx.fillStyle = th.titleText;
      ctx.fillText(`Tj_limit=${dr.tjLimitC}°C · 实心圆=热受限 · 方框=LUT/上限 · 红叉=电压受限`, pad.l + 6, pad.t - 6);
    }
  }

  private renderMissionStageTable(): void {
    const tbody = document.getElementById('focMissionStageTableBody');
    const badge = document.getElementById('focMissionStageCountBadge');
    if (badge) {
      const totalDur = this.missionStages.reduce((a, s) => a + (Number.isFinite(s.durationSec) ? s.durationSec : 0), 0);
      badge.textContent = `${this.missionStages.length} 阶段 · 单循环 ${totalDur.toFixed(1)} s`;
    }
    if (!tbody) return;
    tbody.innerHTML = '';
    this.missionStages.forEach((stage, idx) => {
      const tr = document.createElement('tr');
      tr.className = 'border-t border-[#1b222c]';
      const isLock = stage.mode === 'locked_rotor';
      tr.innerHTML = `
        <td class="px-1.5 py-1 text-slate-500">${idx + 1}</td>
        <td class="px-1.5 py-1"><input data-field="label" type="text" value="${escapeHtml(stage.label)}" class="w-24 bg-[#12161c] border border-[#222933] rounded-xs px-1 py-0.5 text-slate-100" /></td>
        <td class="px-1.5 py-1">
          <select data-field="mode" class="bg-[#12161c] border border-[#222933] rounded-xs px-1 py-0.5 text-cyan-200">
            <option value="rotating" ${!isLock ? 'selected' : ''}>旋转</option>
            <option value="locked_rotor" ${isLock ? 'selected' : ''}>堵转</option>
          </select>
        </td>
        <td class="px-1.5 py-1"><input data-field="durationSec" type="number" step="0.5" min="0.05" value="${stage.durationSec}" class="w-14 bg-[#12161c] border border-[#222933] rounded-xs px-1 py-0.5 text-white" /></td>
        <td class="px-1.5 py-1"><input data-field="iqPeakA" type="number" step="1" min="0" value="${stage.iqPeakA}" class="w-14 bg-[#12161c] border border-[#222933] rounded-xs px-1 py-0.5 text-amber-200" /></td>
        <td class="px-1.5 py-1"><input data-field="freqOrAngle" type="number" step="5" value="${isLock ? (stage.electricalAngleDeg ?? 90) : stage.electricalFrequencyHz}" class="w-16 bg-[#12161c] border border-[#222933] rounded-xs px-1 py-0.5 text-slate-200" title="${isLock ? '转子电角度 θe (°)' : '电频率 fe (Hz)'}" /></td>
        <td class="px-1.5 py-1"><input data-field="vBusV" type="number" step="0.5" min="1" value="${stage.vBusV}" class="w-14 bg-[#12161c] border border-[#222933] rounded-xs px-1 py-0.5 text-cyan-200" /></td>
        <td class="px-1.5 py-1"><input data-field="modDepthM" type="number" step="0.05" min="0" max="1.1547" value="${stage.modDepthM}" class="w-14 bg-[#12161c] border border-[#222933] rounded-xs px-1 py-0.5 text-slate-200" /></td>
        <td class="px-1.5 py-1"><input data-field="tAmbC" type="number" step="5" value="${stage.tAmbC ?? 25}" class="w-12 bg-[#12161c] border border-[#222933] rounded-xs px-1 py-0.5 text-emerald-200" /></td>
        <td class="px-1.5 py-1"><button type="button" data-action="del" class="px-1.5 py-0.5 bg-[#161b22] hover:bg-red-950/60 border border-[#222933] text-slate-400 hover:text-red-300 rounded-xs cursor-pointer">删</button></td>
      `;
      tr.querySelectorAll('input, select').forEach((el) => {
        el.addEventListener('change', (ev) => {
          const t = ev.target as HTMLInputElement | HTMLSelectElement;
          const field = t.dataset.field;
          const cur = this.missionStages[idx];
          if (!cur || !field) return;
          if (field === 'label') cur.label = t.value.trim() || `阶段 ${idx + 1}`;
          else if (field === 'mode') {
            cur.mode = t.value === 'locked_rotor' ? 'locked_rotor' : 'rotating';
            if (cur.mode === 'locked_rotor' && cur.electricalAngleDeg === undefined) cur.electricalAngleDeg = 90;
            this.renderMissionStageTable();
            return;
          } else if (field === 'durationSec') cur.durationSec = Math.max(0.05, Number(t.value) || 1);
          else if (field === 'iqPeakA') cur.iqPeakA = Math.max(0, Number(t.value) || 0);
          else if (field === 'freqOrAngle') {
            if (cur.mode === 'locked_rotor') cur.electricalAngleDeg = Number(t.value) || 0;
            else cur.electricalFrequencyHz = Math.max(0, Number(t.value) || 0);
          } else if (field === 'vBusV') cur.vBusV = Math.max(1, Number(t.value) || 13.5);
          else if (field === 'modDepthM') cur.modDepthM = Math.max(0, Number(t.value) || 0);
          else if (field === 'tAmbC') cur.tAmbC = Number.isFinite(Number(t.value)) ? Number(t.value) : 25;
          const badgeEl = document.getElementById('focMissionStageCountBadge');
          if (badgeEl) {
            const totalDur = this.missionStages.reduce((a, s) => a + s.durationSec, 0);
            badgeEl.textContent = `${this.missionStages.length} 阶段 · 单循环 ${totalDur.toFixed(1)} s`;
          }
        });
      });
      tr.querySelector('[data-action="del"]')?.addEventListener('click', () => {
        if (this.missionStages.length <= 1) {
          this.app.showToast('任务剖面至少保留 1 个阶段。', 'warn');
          return;
        }
        this.missionStages.splice(idx, 1);
        this.renderMissionStageTable();
      });
      tbody.appendChild(tr);
    });
  }

  private runFocMissionProfile(): void {
    if (this.missionStages.length === 0) {
      this.app.showToast('任务剖面阶段列表为空，请先载入预设或新增阶段。', 'warn');
      return;
    }
    try {
      this.refreshFocModelAndSpice();
      const { mos, ctrl, model } = this.readFocParams();
      const repeatCycles = Math.max(1, Math.min(20, Math.round(this.readFiniteInput('focMissionCyclesInput', 3))));
      const tjLimitC = Math.max(40, this.readFiniteInput('focMissionTjLimitInput', 150));
      const dtSec = Math.max(0.005, Math.min(1, this.readFiniteInput('focMissionDtInput', 0.05)));
      const totalDur = this.missionStages.reduce((a, s) => a + s.durationSec, 0) * repeatCycles;
      const maxTimelinePoints = Math.max(200, Math.min(2400, Math.round(totalDur / dtSec)));

      const res = simulateFocMissionProfile({
        model,
        mos,
        baseCtrl: ctrl,
        stages: this.missionStages,
        repeatCycles,
        tjLimitC,
        maxTimelinePoints,
      });
      this.lastMissionResult = res;
      this.renderMissionProfileResult(res);
      this.renderFocWarnings(res.warnings);
      this.focCanvasMode = 'mission';
      this.syncFocViewButtons();
      this.drawFocCanvas();

      this.app.showToast(
        `任务剖面完成（${repeatCycles} 循环, ${res.totalDurationSec.toFixed(1)}s）：峰值 ${res.hottestKeyGlobal}=${res.tjPeakGlobalC.toFixed(1)}°C${res.exceededLimit ? ` · 超限 (${res.firstExceedTimeSec?.toFixed(2)}s)` : ' · 热安全'}`,
        res.exceededLimit ? 'warn' : 'info'
      );
    } catch (err: any) {
      this.app.showToast(`任务剖面计算失败：${err?.message || err}`, 'error');
    }
  }

  private renderMissionProfileResult(res: FocMissionProfileResult): void {
    const box = document.getElementById('focMissionResultBox');
    if (box) box.classList.remove('hidden');
    const peakEl = document.getElementById('focMissionKpiPeak');
    const boardEl = document.getElementById('focMissionKpiBoard');
    const ratchetEl = document.getElementById('focMissionKpiRatchet');
    const statusEl = document.getElementById('focMissionKpiStatus');
    if (peakEl) peakEl.textContent = `${res.tjPeakGlobalC.toFixed(2)} °C (${res.hottestKeyGlobal})`;
    if (boardEl) boardEl.textContent = `${res.tBoardPeakC.toFixed(2)} °C`;
    if (ratchetEl) {
      ratchetEl.textContent =
        res.ratchetDeltaTjC === null
          ? '单循环 (N/A)'
          : `${res.ratchetDeltaTjC >= 0 ? '+' : ''}${res.ratchetDeltaTjC.toFixed(2)} °C`;
    }
    if (statusEl) {
      statusEl.textContent = res.exceededLimit
        ? `越限 @ ${res.firstExceedTimeSec?.toFixed(2)}s (> ${res.tjLimitC}°C)`
        : `通过 (余量 ${(res.tjLimitC - res.tjPeakGlobalC).toFixed(1)}°C)`;
      statusEl.className = `font-semibold mt-0.5 ${res.exceededLimit ? 'text-rose-300' : 'text-emerald-300'}`;
    }

    const tbody = document.getElementById('focMissionSummaryTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    res.stageSummaries.forEach((s, idx) => {
      const tr = document.createElement('tr');
      tr.className = `border-t border-[#1b222c] ${s.exceededLimit ? 'bg-rose-950/30' : ''}`;
      const tjStart = idx === 0 ? s.tAmbC : res.stageSummaries[idx - 1].tjEndC;
      tr.innerHTML = `
        <td class="px-2 py-1 text-slate-200">C${s.cycleIndex + 1} · ${escapeHtml(s.label)}</td>
        <td class="px-2 py-1 text-slate-400">${s.tStartSec.toFixed(1)}~${s.tEndSec.toFixed(1)}</td>
        <td class="px-2 py-1 text-amber-300">${s.pInvAvgW.toFixed(2)}</td>
        <td class="px-2 py-1 text-slate-300">${tjStart.toFixed(1)}</td>
        <td class="px-2 py-1 ${s.exceededLimit ? 'text-rose-300 font-semibold' : 'text-pink-300'}">${s.tjPeakC.toFixed(1)}</td>
        <td class="px-2 py-1 text-slate-200">${s.tjEndC.toFixed(1)}</td>
        <td class="px-2 py-1 text-cyan-300">${s.hottestKey}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  private injectMissionResultToScope(): void {
    if (!this.lastMissionResult) {
      this.runFocMissionProfile();
      if (!this.lastMissionResult) return;
    }
    const mp = this.lastMissionResult;
    const colors = ['#f472b6', '#fb7185', '#22d3ee', '#38bdf8', '#4ade80', '#facc15'];
    const specs = MOS_SWITCH_KEYS.map((key, idx) => ({
      replaceKey: `foc_mission_tj_${key.toLowerCase()}`,
      name: `MP_Tj_${key}`,
      unit: '°C',
      t: mp.time,
      values: mp.tj[key],
      color: colors[idx],
      badge: 'MP',
      expr: `Mission(${key})`,
      sourceIds: [] as string[],
      pinMetrics: key === mp.hottestKeyGlobal ? (['max'] as Array<'max' | 'average'>) : undefined,
    }));
    specs.push({
      replaceKey: 'foc_mission_tboard',
      name: 'MP_Tboard',
      unit: '°C',
      t: mp.time,
      values: mp.tBoard,
      color: '#94a3b8',
      badge: 'MP',
      expr: 'Mission(Tboard)',
      sourceIds: [],
      pinMetrics: ['max'],
    });
    this.app.injectThermalTraces(specs as any, {
      separateView: true,
      toastMessage: `已注入任务剖面 6-MOS Tj(t) 与 Tboard (${mp.hottestKeyGlobal} Peak=${mp.tjPeakGlobalC.toFixed(1)}°C) 到示波器。`,
    });
  }

  private runFocDeratingCurve(): void {
    try {
      this.refreshFocModelAndSpice();
      const { mos, ctrl, model } = this.readFocParams();
      const tjLimitC = Math.max(40, this.readFiniteInput('focDerateTjLimitInput', 150));
      const iMaxSearchA = Math.max(5, this.readFiniteInput('focDerateImaxInput', 200));
      const parseList = (id: string, fallback: number[]): number[] => {
        const raw = (document.getElementById(id) as HTMLInputElement | null)?.value || '';
        const nums = raw
          .split(/[,;\s]+/)
          .map((s) => Number(s.trim()))
          .filter((v) => Number.isFinite(v));
        return nums.length > 0 ? nums : fallback;
      };
      const tAmbPointsC = parseList('focDerateTambListInput', [25, 45, 65, 85, 105, 125]);
      const vBusPointsV = parseList('focDerateVbusListInput', [9, 13.5, 16]);
      const template: Omit<FocSteadyOperatingPoint, 'iqPeakA'> & { iqPeakA?: number } = this.activeFocSteadyPoint
        ? {
            mode: this.activeFocSteadyPoint.mode || 'rotating',
            electricalFrequencyHz: this.activeFocSteadyPoint.electricalFrequencyHz || 100,
            electricalAngleDeg: this.activeFocSteadyPoint.electricalAngleDeg,
            idPeakA: this.activeFocSteadyPoint.idPeakA,
          }
        : {
            mode: 'rotating',
            electricalFrequencyHz: 150,
          };

      const res = computeFocThermalDeratingCurve({
        model,
        mos,
        ctrl,
        operatingPointTemplate: template,
        tjLimitC,
        tAmbPointsC,
        vBusPointsV,
        referenceVoltageV: ctrl.vBusConstV,
        iMaxSearchA,
      });
      this.lastDeratingResult = res;
      this.renderDeratingCurveResult(res);
      this.renderFocWarnings(res.warnings);
      this.focCanvasMode = 'derating';
      this.syncFocViewButtons();
      this.drawFocCanvas();
      this.app.showToast(`降额曲线计算完成：共 ${res.points.length} 个 (Tamb × Vbus) 工况点。`, 'info');
    } catch (err: any) {
      this.app.showToast(`降额曲线计算失败：${err?.message || err}`, 'error');
    }
  }

  private renderDeratingCurveResult(res: FocDeratingCurveResult): void {
    const box = document.getElementById('focDeratingResultBox');
    if (box) box.classList.remove('hidden');
    const tbody = document.getElementById('focDeratingTableBody');
    const noteEl = document.getElementById('focDeratingNote');
    const reasonLabel: Record<FocDeratingLimitReason, string> = {
      THERMAL_LIMIT: '结温热受限',
      THERMAL_RUNAWAY_BOUNDARY: '热失控临界边界',
      VOLTAGE_LIMITED: '母线电压调制受限',
      DPT_LUT_BOUND: 'DPT 电流网格边界',
      RDS_CURVE_BOUND: 'Rds(Tj) 曲线边界',
      ZERO_MARGIN: '零热余量 (Tamb≥Tj_limit)',
      SEARCH_CEILING_REACHED: '达搜索上限 (未触及热限)',
      INVALID_INPUT: '输入异常',
    };
    if (tbody) {
      tbody.innerHTML = '';
      for (const pt of res.points) {
        const tr = document.createElement('tr');
        tr.className = 'border-t border-[#1b222c]';
        const isWarn = pt.limitReason === 'VOLTAGE_LIMITED' || pt.limitReason === 'ZERO_MARGIN' || pt.limitReason === 'DPT_LUT_BOUND';
        tr.innerHTML = `
          <td class="px-2 py-1 text-slate-200">${pt.tAmbC.toFixed(0)}</td>
          <td class="px-2 py-1 text-cyan-200">${pt.vBusV.toFixed(1)}</td>
          <td class="px-2 py-1 text-cyan-300 font-semibold">${pt.iRmsMaxA !== null ? pt.iRmsMaxA.toFixed(2) : '--'}</td>
          <td class="px-2 py-1 text-slate-300">${pt.iPeakMaxA !== null ? pt.iPeakMaxA.toFixed(2) : '--'}</td>
          <td class="px-2 py-1 text-pink-300">${pt.tjAtMaxC !== null ? pt.tjAtMaxC.toFixed(1) : '--'}</td>
          <td class="px-2 py-1 text-amber-300">${pt.pInverterAtMaxW !== null ? pt.pInverterAtMaxW.toFixed(2) : '--'}</td>
          <td class="px-2 py-1 ${isWarn ? 'text-amber-300' : 'text-emerald-300'}" title="${escapeHtml(pt.note)}">${reasonLabel[pt.limitReason]}</td>
        `;
        tbody.appendChild(tr);
      }
    }
    if (noteEl) {
      noteEl.textContent = `模型等级: ${res.resultQualification} · 工况模式: ${res.mode === 'locked_rotor' ? '零速堵转' : '旋转稳态'} · 目标上限 Tj_limit=${res.tjLimitC}°C（每个结果均经高精度复算确认 Tj_max ≤ Tj_limit）。`;
    }
  }

  public appendMissionStageFromDyno(stage: FocMissionStage, openModal = true): void {
    this.missionStages.push({ ...stage });
    if (openModal) {
      this.openModal();
      this.switchTab('foc');
      const details = document.getElementById('focMissionProfileCard') as HTMLDetailsElement | null;
      if (details) details.open = true;
    }
    this.renderMissionStageTable();
    this.app.showToast(
      `已追加任务剖面阶段 #${this.missionStages.length}：${stage.label} (${stage.vBusV.toFixed(1)}V, Iq=${stage.iqPeakA.toFixed(1)}A, ${stage.durationSec.toFixed(1)}s)。`,
      'info'
    );
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
    this.activeFocSteadyPoint = null;
    this.lastFocSteadyResult = null;
    this.renderFocSteadyOperatingPoint();
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
    // External handoff values may be useful starting points, but do not inherit a
    // previous panel's manual confirmation for a different device.
    const rdsConfirmed = document.getElementById('focRdsConfirmedChk') as HTMLInputElement | null;
    if (rdsConfirmed) rdsConfirmed.checked = false;
    if (typeof payload.rsPhaseOhm === 'number' && Number.isFinite(payload.rsPhaseOhm) && payload.rsPhaseOhm > 0) {
      setVal('focStallRsInput', payload.rsPhaseOhm.toFixed(4));
    }

    this.activeFocHandoffNote =
      payload.handoffNote ||
      '已从外部导入固定 FOC 工况；开关/热系数 α、Esw、Eoss、Qrr、Vref、Iref 仍采用当前 MOS Thermal 面板数值。';
    this.activeFocSteadyPoint = payload.steadyOperatingPoint;
    this.renderFocSteadyOperatingPoint();
    // This workflow is explicitly constant-condition: calculate average losses and
    // coupled steady Tj directly. The waveform transient remains an explicit action.
    this.runFocSteadyState();
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
    const readRequired = (id: string): number | null => {
      const raw = (document.getElementById(id) as HTMLInputElement | null)?.value?.trim() || '';
      if (!raw) return null;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const tjVal = readRequired('dptMatrixTjInput');
    const rgOnOhm = readRequired('dptMatrixRgonInput');
    const rgOffOhm = readRequired('dptMatrixRgoffInput');
    const conditionConfirmed = (document.getElementById('dptMatrixConditionConfirmedChk') as HTMLInputElement | null)?.checked ?? false;
    if (tjVal === null || tjVal < -100 || tjVal > 300 || rgOnOhm === null || rgOnOhm < 0 || rgOffOhm === null || rgOffOhm < 0) {
      this.app.showToast('保存 DPT 点前必须填写有效的测试结温 Tj、Rg_on 和 Rg_off；不再自动填入 25°C / 4.7Ω。', 'error');
      return;
    }
    if (!conditionConfirmed) {
      this.app.showToast('请先确认 Tj、Rg_on、Rg_off 是本次 DPT 测试的实际工况，不是猜测或占位值。', 'warn');
      return;
    }
    this.dptMatrix.push({
      id: `dpt_${Date.now()}_${this.dptMatrix.length}`,
      vBusV: res.vBusSteadyV,
      iLoadA: res.iLoadA,
      tjC: tjVal,
      rgOhm: 0.5 * (rgOnOhm + rgOffOhm),
      rgOnOhm,
      rgOffOhm,
      eOnUj: res.eOnUj,
      eOffUj: res.eOffUj,
      qRrNc: res.qRrNc,
      eOnSansQrrUj: res.eOnSansQrrUj,
    });
    this.renderDptMatrixTable();
    this.app.showToast(
      `已保存已确认的 DPT 工况点到 4D LUT (Vbus=${res.vBusSteadyV.toFixed(1)}V, I=${res.iLoadA.toFixed(1)}A, Tj=${tjVal.toFixed(0)}°C, Rg=${rgOnOhm.toFixed(1)}/${rgOffOhm.toFixed(1)}Ω)。`,
      'info'
    );
  }

  private renderDptMatrixTable(): void {
    const tbody = document.getElementById('dptMatrixTableBody');
    const applyBtn = document.getElementById('dptApplyMatrixToFocBtn') as HTMLButtonElement | null;
    const exportBtn = document.getElementById('dptExportJsonBtn') as HTMLButtonElement | null;
    const covBar = document.getElementById('dptMatrixCoverageBar');
    if (applyBtn) applyBtn.disabled = this.dptMatrix.length === 0;
    if (exportBtn) exportBtn.disabled = this.dptMatrix.length === 0;
    if (covBar) {
      const cov = summarizeDptLutCoverage(this.dptMatrix);
      if (cov.pointCount === 0) {
        covBar.className = 'text-slate-400';
        covBar.textContent = '✖ 暂无实测 DPT 矩阵点 · 请由示波器分析保存或导入 4D 实测模板';
      } else {
        covBar.className = cov.coversAutomotive9to16V ? 'text-emerald-300' : 'text-amber-300';
        covBar.textContent =
          `${cov.statusGlyph} ${cov.statusText} · ` +
          `${cov.pointCount} 点 · ` +
          `Vbus ${cov.vBusRangeV![0].toFixed(1)}–${cov.vBusRangeV![1].toFixed(1)}V (${cov.uniqueVbusCount}) · ` +
          `I ${cov.iLoadRangeA![0].toFixed(0)}–${cov.iLoadRangeA![1].toFixed(0)}A (${cov.uniqueIloadCount}) · ` +
          `Tj ${cov.tjRangeC![0].toFixed(0)}–${cov.tjRangeC![1].toFixed(0)}°C (${cov.uniqueTjCount}) · ` +
          `Rg ${cov.rgRangeOhm![0].toFixed(1)}–${cov.rgRangeOhm![1].toFixed(1)}Ω (${cov.uniqueRgCount})`;
      }
    }
    if (!tbody) return;
    if (this.dptMatrix.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="9" class="px-2 py-2 text-center text-slate-500 font-sans">尚未保存 DPT 工况点；先运行 DPT 分析后点击「+ 保存当前点到矩阵」或点击「导入 4D DPT (JSON/CSV)」载入实测数据。</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    this.dptMatrix.forEach((pt, idx) => {
      const tr = document.createElement('tr');
      tr.className = 'border-t border-[#222933]';
      const rgOnStr = (pt.rgOnOhm ?? pt.rgOhm).toFixed(1);
      const rgOffStr = (pt.rgOffOhm ?? pt.rgOhm).toFixed(1);
      tr.innerHTML = `
        <td class="px-2 py-1">${pt.vBusV.toFixed(1)}</td>
        <td class="px-2 py-1">${pt.iLoadA.toFixed(1)}</td>
        <td class="px-2 py-1">${pt.tjC.toFixed(0)}</td>
        <td class="px-2 py-1">${rgOnStr} / ${rgOffStr}</td>
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
    const vTarget = Math.max(1, this.readFiniteInput('focVbusConstInput', 13.5));
    const iTarget = Math.max(1, this.readFiniteInput('focIrefInput', 30));
    const parseOptionalNonNegative = (id: string): number | undefined => {
      const raw = (document.getElementById(id) as HTMLInputElement | null)?.value?.trim() || '';
      if (!raw) return undefined;
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
    };
    const rgOnTarget = parseOptionalNonNegative('focRgonInput');
    const rgOffTarget = parseOptionalNonNegative('focRgoffInput');
    const hasKnownRg = rgOnTarget !== undefined && rgOffTarget !== undefined;
    const rgDesignConfirmed = (document.getElementById('focRgDesignConfirmedChk') as HTMLInputElement | null)?.checked ?? false;
    const interp = interpolateDptSwitchingLoss(this.dptMatrix, {
      vBusV: vTarget,
      iLoadA: iTarget,
      // Leave Tj unspecified here: interpolation uses the LUT midpoint only for
      // preflight coverage validation. The coupled FOC solver uses its own
      // per-device model-estimated Tj at every switching-loss evaluation.
      rgOnOhm: rgOnTarget,
      rgOffOhm: rgOffTarget,
      tjProvenance: 'assumed',
      rgProvenance: hasKnownRg && rgDesignConfirmed ? 'design_specified' : 'assumed',
    });
    const rgDimensionNeedsConfirmation = !!interp?.activeDimensions.includes('Rg') &&
      (!hasKnownRg || !rgDesignConfirmed || interp.rgProvenance === 'assumed');
    if (!interp || interp.status !== 'VALID' || rgDimensionNeedsConfirmation) {
      const status = interp?.status ?? 'NO_LUT_RESULT';
      const reason = rgDimensionNeedsConfirmation
        ? 'DPT LUT 的 Rg 轴存在变化；请填写实际 Rg_on/Rg_off 并确认与本机原理图/BOM 一致，禁止使用 4.7Ω 隐式默认值。'
        : '请补齐 Vbus/Iload/Tj/Rg 四维数据覆盖，并确保查询点位于实测凸包内。';
      this.app.showToast(
        `DPT LUT 当前状态为 ${status}，不能激活为 FOC 正式热模型：${reason}`,
        'error'
      );
      return;
    }

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
      ? `（注：参考点超出 LUT 范围 [${interp.outOfRangeAxes.join('/') || 'V/I'}], status=${interp.status}）`
      : `（status=${interp.status}）`;
    const dimNote = `有效维度=[${interp.activeDimensions.join(',') || '无'}]${interp.collapsedDimensions.length > 0 ? `, 退化维度=[${interp.collapsedDimensions.join(',')}]` : ''}`;
    const tjNote = interp.activeDimensions.includes('Tj')
      ? '预检查 Tj 使用 LUT 范围中值；实际运行逐 MOS 使用热模型迭代 Tj，超出 LUT 范围将拒绝计算'
      : 'Tj 为单值轴，不具备温度依赖性';
    const rgTargetNote = hasKnownRg ? `${rgOnTarget!.toFixed(1)}/${rgOffTarget!.toFixed(1)}Ω` : '未指定（仅单值轴时采用 LUT 中值）';
    this.activeFocHandoffNote = `已激活 Tab 5 的 ${this.dptMatrix.length} 点 DPT LUT 用于 6-MOS 闭环 (Vbus, |I_phase|, Tj, Rg_on/off) 插值${extrapNote}；${dimNote}；${tjNote}；预检查参考标量 @ (${vTarget.toFixed(1)}V, ${iTarget.toFixed(1)}A, Rg=${rgTargetNote}): Esw=${interp.eSwTotalUj.toFixed(2)}µJ, Qrr=${interp.qRrNc.toFixed(1)}nC。`;
    this.invalidateFocCaches(true);
    this.switchTab('foc');
    this.app.showToast(`已激活 ${this.dptMatrix.length} 点 DPT LUT (${interp.status})；运行时按六管热模型估算 Tj 查询，超出实测范围会拒绝计算。`, interp.extrapolated ? 'warn' : 'info');
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
