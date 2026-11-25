/**
 * Waveform Viewer Pro - Signal Filtering & Circuit Conditioning Workbench Controller
 * Manages the dockable #filterModal panel: algorithm selection, physical RC / IIR / FIR / Time-domain
 * parameters, whole/partial [tStart, tEnd] region control, live Bode |H(f)| + Before/After time preview,
 * and one-click execution to derived channel or undoable in-place filtering.
 */

import { TabState, WaveformChannel } from '../types/models';
import { OscilloscopeApp } from '../engine/uiController';
import { formatEng, getTimeBoundsForView } from '../engine/canvasRenderer';
import {
  FilterAlgorithm,
  FilterConfig,
  FilterOutputMode,
  FilterRegionMode,
  FilterResponseType,
  FirWindowType,
  applyWaveformFilter,
  computeFilterBodeResponse,
  createDefaultFilterConfig,
  medianDt,
  nyquistOf,
  validateFilterConfig,
} from './filter';

type FreqUnit = 'Hz' | 'kHz' | 'MHz';
type TimeUnit = 's' | 'ms' | 'us';
type ResUnit = 'ohm' | 'kohm' | 'mohm';
type CapUnit = 'pF' | 'nF' | 'uF';
type PreviewMode = 'time' | 'bode';

const FREQ_MULT: Record<FreqUnit, number> = { Hz: 1, kHz: 1e3, MHz: 1e6 };
const TIME_MULT: Record<TimeUnit, number> = { s: 1, ms: 1e-3, us: 1e-6 };
const RES_MULT: Record<ResUnit, number> = { ohm: 1, kohm: 1e3, mohm: 1e6 };
const CAP_MULT: Record<CapUnit, number> = { pF: 1e-12, nF: 1e-9, uF: 1e-6 };

function pickFreqUnit(hz: number): FreqUnit {
  if (hz >= 1e6) return 'MHz';
  if (hz >= 1e3) return 'kHz';
  return 'Hz';
}

function pickTimeUnit(spanSec: number): TimeUnit {
  if (spanSec < 2e-3) return 'us';
  if (spanSec < 1) return 'ms';
  return 's';
}

export class FilterWorkbenchController {
  private app: OscilloscopeApp;
  private config: FilterConfig = createDefaultFilterConfig(100000);
  private previewMode: PreviewMode = 'time';
  private fcUnit: FreqUnit = 'kHz';
  private fcHighUnit: FreqUnit = 'kHz';
  private f0Unit: FreqUnit = 'Hz';
  private customTimeUnit: TimeUnit = 'ms';
  private resUnit: ResUnit = 'kohm';
  private capUnit: CapUnit = 'nF';
  private lastChannelKey: string = '';

  constructor(app: OscilloscopeApp) {
    this.app = app;
    this.bindEvents();
  }

  private el<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
  }

  public open(tab?: TabState | null): void {
    const activeTab = tab ?? this.app.getActiveTab();
    const modal = this.el('filterModal');
    if (!modal) return;
    if (!activeTab || activeTab.drawOrder.length === 0) {
      this.app.showToast('Load a waveform capture before opening Signal Filter.', 'warn');
      return;
    }
    this.syncWithTab(activeTab);
    modal.style.display = 'flex';
    requestAnimationFrame(() => this.refreshPreview());
  }

  public syncIfOpen(): void {
    const modal = this.el('filterModal');
    if (!modal || modal.style.display === 'none') return;
    const tab = this.app.getActiveTab();
    if (tab) this.syncWithTab(tab);
  }

  private getSelectedChannel(tab: TabState): WaveformChannel | null {
    const sel = this.el<HTMLSelectElement>('filtChannelSelect');
    const id = sel?.value;
    if (id && tab.channels[id]) return tab.channels[id];
    const fallbackId = tab.activeChannelId || tab.drawOrder[0];
    return tab.channels[fallbackId] || null;
  }

  public syncWithTab(tab: TabState): void {
    const chSel = this.el<HTMLSelectElement>('filtChannelSelect');
    if (!chSel) return;

    const prevId = chSel.value;
    chSel.innerHTML = '';
    tab.drawOrder.forEach((id, idx) => {
      const ch = tab.channels[id];
      if (!ch) return;
      const opt = document.createElement('option');
      opt.value = id;
      const tag = ch.isMath ? `[${ch.derivedBadge || 'fx'}]` : `CH${idx + 1}`;
      opt.innerText = `${tag} ${ch.name} (${ch.unit || 'V'})`;
      chSel.appendChild(opt);
    });

    const targetId =
      prevId && tab.channels[prevId]
        ? prevId
        : tab.activeChannelId && tab.channels[tab.activeChannelId]
        ? tab.activeChannelId
        : tab.drawOrder[0];
    if (targetId) chSel.value = targetId;

    const ch = this.getSelectedChannel(tab);
    if (!ch) return;

    const chKey = `${tab.id}::${ch.id}::${ch.t.length}`;
    if (chKey !== this.lastChannelKey) {
      this.lastChannelKey = chKey;
      const dt = medianDt(ch.t);
      const fs = dt > 0 ? 1 / dt : 100000;
      const nyq = fs / 2;
      // Preserve chosen algorithm/region/outputMode while re-centering cutoffs inside channel Nyquist
      if (this.config.cutoffHz >= nyq * 0.9 || this.config.cutoffHz <= nyq / 5000) {
        this.config.cutoffHz = Number(Math.max(0.1, nyq * 0.08).toPrecision(4));
      }
      if (this.config.cutoffHighHz >= nyq * 0.9 || this.config.cutoffHighHz <= this.config.cutoffHz) {
        this.config.cutoffHighHz = Number(Math.min(nyq * 0.75, this.config.cutoffHz * 4).toPrecision(4));
      }
      if (this.config.centerFreqHz >= nyq * 0.95) {
        this.config.centerFreqHz = Number(Math.max(1, Math.min(50, nyq * 0.25)).toPrecision(4));
      }
      this.fcUnit = pickFreqUnit(this.config.cutoffHz);
      this.fcHighUnit = pickFreqUnit(this.config.cutoffHighHz);
      this.f0Unit = pickFreqUnit(this.config.centerFreqHz);

      const bounds = getTimeBoundsForView(tab, ch);
      this.customTimeUnit = pickTimeUnit(ch.t[ch.t.length - 1] - ch.t[0]);
      this.config.tStart = bounds.tStart;
      this.config.tEnd = bounds.tEnd;
    }

    this.renderFormFromConfig(tab, ch);
    this.refreshPreview();
  }

  private renderFormFromConfig(tab: TabState, ch: WaveformChannel): void {
    const dt = medianDt(ch.t);
    const fs = dt > 0 ? 1 / dt : 1;
    const nyq = nyquistOf(ch.t);

    const chInfo = this.el('filtChannelMeta');
    if (chInfo) {
      const uniformTxt = ch.metadata?.isUniformSampling === false ? 'Adaptive Step (Auto-Resample)' : 'Uniform Grid';
      chInfo.innerText = `fs ≈ ${formatEng(fs, 'Hz', 3)} · f_Nyq = ${formatEng(nyq, 'Hz', 3)} · ${uniformTxt}`;
    }

    const setVal = (id: string, val: string) => {
      const node = this.el<HTMLInputElement | HTMLSelectElement>(id);
      if (node && document.activeElement !== node) node.value = val;
    };

    setVal('filtAlgoSelect', this.config.algorithm);
    setVal('filtResponseSelect', this.config.response);
    setVal('filtOrderSelect', String(this.config.order));
    setVal('filtRippleInput', String(this.config.rippleDb));
    setVal('filtQInput', String(this.config.qFactor));
    setVal('filtFirTapsInput', String(this.config.firTaps));
    setVal('filtFirWinSelect', this.config.firWindow);
    setVal('filtWinSamplesInput', String(this.config.windowSamples));
    setVal('filtMaModeSelect', this.config.maMode);
    setVal('filtEmaAlphaInput', String(this.config.emaAlpha));
    setVal('filtSgPolySelect', String(this.config.sgPolyOrder));
    setVal('filtEdgeBlendInput', String(this.config.edgeBlendPct));

    // Frequency inputs & units
    setVal('filtFcUnitSelect', this.fcUnit);
    setVal('filtFcInput', String(Number((this.config.cutoffHz / FREQ_MULT[this.fcUnit]).toPrecision(5))));
    setVal('filtFcHighUnitSelect', this.fcHighUnit);
    setVal('filtFcHighInput', String(Number((this.config.cutoffHighHz / FREQ_MULT[this.fcHighUnit]).toPrecision(5))));
    setVal('filtF0UnitSelect', this.f0Unit);
    setVal('filtF0Input', String(Number((this.config.centerFreqHz / FREQ_MULT[this.f0Unit]).toPrecision(5))));

    // RC physical values
    const useRcChk = this.el<HTMLInputElement>('filtUseRcChk');
    if (useRcChk) useRcChk.checked = this.config.useRcComponents;
    setVal('filtResUnitSelect', this.resUnit);
    setVal('filtResInput', String(Number((this.config.rOhm / RES_MULT[this.resUnit]).toPrecision(5))));
    setVal('filtCapUnitSelect', this.capUnit);
    setVal('filtCapInput', String(Number((this.config.cFarad / CAP_MULT[this.capUnit]).toPrecision(5))));
    const rcReadout = this.el('filtRcCalcReadout');
    if (rcReadout) {
      const tau = this.config.rOhm * this.config.cFarad;
      const fcCalc = tau > 0 ? 1 / (2 * Math.PI * tau) : 0;
      rcReadout.innerText = `τ = ${formatEng(tau, 's', 3)}  ·  f_c = ${formatEng(fcCalc, 'Hz', 4)}`;
    }

    // Sync log-cutoff slider
    const fcSlider = this.el<HTMLInputElement>('filtFcSlider');
    if (fcSlider && nyq > 0) {
      const fMin = Math.max(1e-3, nyq / 2000);
      const fMax = nyq * 0.92;
      const cur = Math.max(fMin, Math.min(fMax, this.config.cutoffHz));
      const frac = Math.log10(cur / fMin) / Math.max(1e-6, Math.log10(fMax / fMin));
      fcSlider.value = String(Math.max(0, Math.min(1000, Math.round(frac * 1000))));
    }

    const zeroPhaseChk = this.el<HTMLInputElement>('filtZeroPhaseChk');
    if (zeroPhaseChk) zeroPhaseChk.checked = this.config.zeroPhase;

    // Region mode active classes + custom time range display
    (['entire', 'view', 'cursors', 'custom'] as FilterRegionMode[]).forEach((m) => {
      const btn = this.el(`filtRegion_${m}`);
      if (!btn) return;
      const active = this.config.regionMode === m;
      btn.className = active
        ? 'px-2 py-0.5 rounded-xs bg-cyan-600 text-slate-950 font-semibold text-[11px] cursor-pointer whitespace-nowrap'
        : 'px-2 py-0.5 rounded-xs text-slate-300 hover:text-white text-[11px] cursor-pointer whitespace-nowrap';
    });

    // Output mode toggle
    (['new_channel', 'in_place'] as FilterOutputMode[]).forEach((m) => {
      const btn = this.el(`filtOut_${m}`);
      if (!btn) return;
      const active = this.config.outputMode === m;
      btn.className = active
        ? 'flex-1 py-0.5 px-2 rounded-xs bg-cyan-600 text-slate-950 font-semibold text-[11px] cursor-pointer whitespace-nowrap'
        : 'flex-1 py-0.5 px-2 rounded-xs text-slate-300 hover:text-white text-[11px] cursor-pointer whitespace-nowrap';
    });

    const revertBtn = this.el<HTMLButtonElement>('filtRevertRawBtn');
    if (revertBtn) {
      revertBtn.classList.toggle('hidden', !(ch.hasEdits && ch.refV && ch.refV.length === ch.v.length));
    }

    // Preview mode toggle
    (['time', 'bode'] as PreviewMode[]).forEach((pm) => {
      const btn = this.el(`filtPreviewMode_${pm}`);
      if (!btn) return;
      const active = this.previewMode === pm;
      btn.className = active
        ? 'px-2 py-0.5 rounded-xs bg-cyan-600 text-slate-950 font-semibold text-[11px] cursor-pointer'
        : 'px-2 py-0.5 rounded-xs text-slate-300 hover:text-white text-[11px] cursor-pointer';
    });

    // Cursor availability note & custom bounds inputs
    const regionMeta = this.el('filtRegionMeta');
    const customRow = this.el('filtCustomRangeRow');
    const edgeRow = this.el('filtPartialBlendRow');
    const hasCursors = tab.cursors.enabled && tab.cursors.x1 !== null && tab.cursors.x2 !== null;

    if (customRow) customRow.classList.toggle('hidden', this.config.regionMode !== 'custom');
    if (edgeRow) edgeRow.classList.toggle('hidden', this.config.regionMode === 'entire');

    setVal('filtCustomTimeUnitSelect', this.customTimeUnit);
    const mult = TIME_MULT[this.customTimeUnit];
    const t0Val = this.config.tStart ?? ch.t[0];
    const t1Val = this.config.tEnd ?? ch.t[ch.t.length - 1];
    setVal('filtCustomTStartInput', String(Number((t0Val / mult).toPrecision(5))));
    setVal('filtCustomTEndInput', String(Number((t1Val / mult).toPrecision(5))));

    if (regionMeta) {
      if (this.config.regionMode === 'entire') {
        regionMeta.innerText = `Full Trace: ${formatEng(ch.t[0], 's', 3)} ~ ${formatEng(ch.t[ch.t.length - 1], 's', 3)} (${ch.t.length.toLocaleString()} pts)`;
      } else if (this.config.regionMode === 'view') {
        const b = getTimeBoundsForView(tab, ch);
        regionMeta.innerText = `Viewport: ${formatEng(b.tStart, 's', 3)} ~ ${formatEng(b.tEnd, 's', 3)}`;
      } else if (this.config.regionMode === 'cursors') {
        regionMeta.innerText = hasCursors
          ? `Cursors: ${formatEng(Math.min(tab.cursors.x1!, tab.cursors.x2!), 's', 3)} ~ ${formatEng(Math.max(tab.cursors.x1!, tab.cursors.x2!), 's', 3)}`
          : '▲ Enable X1/X2 Cursors on scope first (partial filtering refuses full-trace fallback).';
      } else {
        regionMeta.innerText = `Custom Slice: ${formatEng(t0Val, 's', 3)} ~ ${formatEng(t1Val, 's', 3)}`;
      }
    }

    // Dynamic visibility of parameter groups based on selected algorithm & response
    const algo = this.config.algorithm;
    const isIirOrRc =
      algo === 'rc_passive' || algo === 'butterworth' || algo === 'bessel' || algo === 'chebyshev1';
    const supportsAll4Resp = algo === 'butterworth' || algo === 'chebyshev1' || algo === 'fir_sinc';
    const supportsLpHpOnly = algo === 'rc_passive' || algo === 'bessel';
    const showResp = supportsAll4Resp || supportsLpHpOnly;
    const isBand = (this.config.response === 'bandpass' || this.config.response === 'bandstop') && supportsAll4Resp;
    const showFc =
      algo === 'fir_sinc' ||
      ((algo === 'butterworth' || algo === 'bessel' || algo === 'chebyshev1')) ||
      (algo === 'rc_passive' && !this.config.useRcComponents);

    this.toggleEl('filtResponseWrap', showResp);
    // Restrict LP/HP-only options when RC or Bessel selected
    const respSel = this.el<HTMLSelectElement>('filtResponseSelect');
    if (respSel) {
      Array.from(respSel.options).forEach((opt) => {
        const isBandOpt = opt.value === 'bandpass' || opt.value === 'bandstop';
        opt.disabled = supportsLpHpOnly && isBandOpt;
      });
      if (supportsLpHpOnly && (this.config.response === 'bandpass' || this.config.response === 'bandstop')) {
        this.config.response = 'lowpass';
        respSel.value = 'lowpass';
      }
    }

    this.toggleEl('filtRcToggleWrap', algo === 'rc_passive');
    this.toggleEl('filtRcComponentsRow', algo === 'rc_passive' && this.config.useRcComponents);
    this.toggleEl('filtFcWrap', showFc);
    this.toggleEl('filtFcHighWrap', isBand);
    this.toggleEl('filtNotchWrap', algo === 'notch');
    this.toggleEl('filtOrderWrap', isIirOrRc);
    this.toggleEl('filtRippleWrap', algo === 'chebyshev1');
    this.toggleEl('filtFirWrap', algo === 'fir_sinc');
    this.toggleEl('filtWinSamplesWrap', algo === 'moving_avg' && this.config.maMode === 'boxcar' || algo === 'median' || algo === 'savgol');
    this.toggleEl('filtMaModeWrap', algo === 'moving_avg');
    this.toggleEl('filtEmaWrap', algo === 'moving_avg' && this.config.maMode === 'ema');
    this.toggleEl('filtSgPolyWrap', algo === 'savgol');
    this.toggleEl(
      'filtZeroPhaseWrap',
      isIirOrRc || algo === 'notch' || (algo === 'moving_avg' && this.config.maMode === 'ema')
    );

    // Restrict order dropdown valid values cleanly
    const ordSel = this.el<HTMLSelectElement>('filtOrderSelect');
    if (ordSel) {
      const maxOrd = algo === 'rc_passive' ? 4 : algo === 'bessel' ? 6 : 8;
      const minOrd = algo === 'chebyshev1' ? 2 : 1;
      Array.from(ordSel.options).forEach((opt) => {
        const v = Number(opt.value);
        opt.disabled = v < minOrd || v > maxOrd;
      });
      if (this.config.order < minOrd) this.config.order = minOrd;
      if (this.config.order > maxOrd) this.config.order = maxOrd;
      ordSel.value = String(this.config.order);
    }
  }

  private toggleEl(id: string, show: boolean): void {
    const node = this.el(id);
    if (node) node.classList.toggle('hidden', !show);
  }

  private refreshPreview(): void {
    const tab = this.app.getActiveTab();
    if (!tab) return;
    const ch = this.getSelectedChannel(tab);
    if (!ch) return;

    const statusBanner = this.el('filtValidationBanner');
    const applyBtn = this.el<HTMLButtonElement>('filtApplyBtn');
    const check = validateFilterConfig(this.config, ch.t);

    if (statusBanner) {
      if (!check.ok) {
        statusBanner.className = 'rounded-sm border px-2.5 py-1.5 text-[11px] bg-rose-950/50 border-rose-500/60 text-rose-200';
        statusBanner.innerText = `✖ ${check.message}`;
        statusBanner.classList.remove('hidden');
      } else if (check.warning) {
        statusBanner.className = 'rounded-sm border px-2.5 py-1.5 text-[11px] bg-amber-950/50 border-amber-500/60 text-amber-200';
        statusBanner.innerText = `▲ ${check.warning}`;
        statusBanner.classList.remove('hidden');
      } else {
        statusBanner.classList.add('hidden');
      }
    }
    if (applyBtn) applyBtn.disabled = !check.ok;

    if (!check.ok) {
      this.drawEmptyPreview(check.message || 'Invalid parameters');
      return;
    }

    const viewBounds = getTimeBoundsForView(tab, ch);
    const rawSourceV =
      this.config.outputMode === 'in_place' && ch.hasEdits && ch.refV && ch.refV.length === ch.v.length
        ? ch.refV
        : ch.v;
    const res = applyWaveformFilter(ch.t, rawSourceV, this.config, {
      viewStart: viewBounds.tStart,
      viewEnd: viewBounds.tEnd,
      cursorX1: tab.cursors.enabled ? tab.cursors.x1 : null,
      cursorX2: tab.cursors.enabled ? tab.cursors.x2 : null,
    });

    if (res.partialRegionSkipped) {
      if (statusBanner) {
        statusBanner.className = 'rounded-sm border px-2.5 py-1.5 text-[11px] bg-rose-950/50 border-rose-500/60 text-rose-200';
        statusBanner.innerText = `✖ ${res.warning || 'Partial filter window is invalid.'}`;
        statusBanner.classList.remove('hidden');
      }
      if (applyBtn) applyBtn.disabled = true;
      this.drawEmptyPreview(res.warning || 'Invalid partial filter slice');
      return;
    }

    if (statusBanner && res.warning && !check.warning) {
      statusBanner.className = 'rounded-sm border px-2.5 py-1.5 text-[11px] bg-amber-950/50 border-amber-500/60 text-amber-200';
      statusBanner.innerText = `▲ ${res.warning}`;
      statusBanner.classList.remove('hidden');
    }

    const m = res.metrics;
    const kpiPts = this.el('filtKpiPoints');
    const kpiRms = this.el('filtKpiNoiseRms');
    const kpiVpp = this.el('filtKpiVpp');
    const kpiBadge = this.el('filtKpiBadge');
    if (kpiPts) kpiPts.innerText = `${m.sampleCountFiltered.toLocaleString()} / ${m.sampleCountTotal.toLocaleString()}`;
    if (kpiRms) kpiRms.innerText = formatEng(m.rmsRemovedDiff, ch.unit || 'V', 3);
    if (kpiVpp) kpiVpp.innerText = `${formatEng(m.vppBefore, ch.unit || 'V', 2)} → ${formatEng(m.vppAfter, ch.unit || 'V', 2)}`;
    if (kpiBadge) kpiBadge.innerText = m.summaryText;

    if (this.previewMode === 'bode') {
      this.drawBodeCanvas(m.effectiveFsHz, m.nyquistHz);
    } else {
      this.drawTimePreviewCanvas(ch, rawSourceV, res.v, m.tStartApplied, m.tEndApplied);
    }
  }

  private getCanvasPalette() {
    const isDark = document.documentElement.classList.contains('dark');
    return isDark
      ? {
          bg: '#080b0f',
          grid: '#18212d',
          border: '#243040',
          text: '#94a3b8',
          raw: '#64748b',
          filtered: '#22d3ee',
          accent: '#f59e0b',
          regionFill: 'rgba(34, 211, 238, 0.08)',
        }
      : {
          bg: '#f8fafc',
          grid: '#e2e8f0',
          border: '#cbd5e1',
          text: '#475569',
          raw: '#94a3b8',
          filtered: '#0284c7',
          accent: '#d97706',
          regionFill: 'rgba(2, 132, 199, 0.08)',
        };
  }

  private setupHiDpiCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(260, Math.round(rect.width || 420));
    const h = Math.max(130, Math.round(rect.height || 152));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  private drawEmptyPreview(msg: string): void {
    const canvas = this.el<HTMLCanvasElement>('filtPreviewCanvas');
    if (!canvas) return;
    const setup = this.setupHiDpiCanvas(canvas);
    if (!setup) return;
    const { ctx, w, h } = setup;
    const pal = this.getCanvasPalette();
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = pal.text;
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(msg, w / 2, h / 2);
  }

  private drawTimePreviewCanvas(
    ch: WaveformChannel,
    rawSourceV: Float32Array,
    filtered: Float32Array,
    tStartApplied: number,
    tEndApplied: number
  ): void {
    const canvas = this.el<HTMLCanvasElement>('filtPreviewCanvas');
    if (!canvas) return;
    const setup = this.setupHiDpiCanvas(canvas);
    if (!setup) return;
    const { ctx, w, h } = setup;
    const pal = this.getCanvasPalette();

    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, w, h);

    const pad = { l: 46, r: 12, t: 16, b: 22 };
    const pw = Math.max(40, w - pad.l - pad.r);
    const ph = Math.max(40, h - pad.t - pad.b);

    const n = ch.t.length;
    const t0 = ch.t[0];
    const t1 = ch.t[n - 1];
    const tSpan = Math.max(1e-15, t1 - t0);

    // Find min/max across raw & filtered
    let vMin = Infinity;
    let vMax = -Infinity;
    const step = Math.max(1, Math.floor(n / 700));
    for (let i = 0; i < n; i += step) {
      const r = rawSourceV[i];
      const f = filtered[i];
      if (Number.isFinite(r)) {
        if (r < vMin) vMin = r;
        if (r > vMax) vMax = r;
      }
      if (Number.isFinite(f)) {
        if (f < vMin) vMin = f;
        if (f > vMax) vMax = f;
      }
    }
    if (!Number.isFinite(vMin) || !Number.isFinite(vMax)) {
      vMin = -1;
      vMax = 1;
    } else if (Math.abs(vMax - vMin) < 1e-9) {
      vMin -= 0.5;
      vMax += 0.5;
    } else {
      const m = (vMax - vMin) * 0.08;
      vMin -= m;
      vMax += m;
    }

    const toX = (tVal: number) => pad.l + ((tVal - t0) / tSpan) * pw;
    const toY = (vVal: number) => pad.t + (1 - (vVal - vMin) / (vMax - vMin)) * ph;

    // Highlight partial region if not whole
    if (this.config.regionMode !== 'entire') {
      const rx1 = Math.max(pad.l, Math.min(pad.l + pw, toX(tStartApplied)));
      const rx2 = Math.max(pad.l, Math.min(pad.l + pw, toX(tEndApplied)));
      if (rx2 > rx1) {
        ctx.fillStyle = pal.regionFill;
        ctx.fillRect(rx1, pad.t, rx2 - rx1, ph);
        ctx.strokeStyle = pal.filtered;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(rx1, pad.t);
        ctx.lineTo(rx1, pad.t + ph);
        ctx.moveTo(rx2, pad.t);
        ctx.lineTo(rx2, pad.t + ph);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Grid
    ctx.strokeStyle = pal.grid;
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const gy = pad.t + (ph * g) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.l, gy);
      ctx.lineTo(pad.l + pw, gy);
      ctx.stroke();
    }
    ctx.strokeRect(pad.l, pad.t, pw, ph);

    // Draw raw trace (dashed muted)
    ctx.strokeStyle = pal.raw;
    ctx.lineWidth = 1.1;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i += step) {
      const val = rawSourceV[i];
      if (!Number.isFinite(val)) {
        started = false;
        continue;
      }
      const x = toX(ch.t[i]);
      const y = toY(val);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw filtered trace (crisp solid)
    ctx.strokeStyle = pal.filtered;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    started = false;
    for (let i = 0; i < n; i += step) {
      const val = filtered[i];
      if (!Number.isFinite(val)) {
        started = false;
        continue;
      }
      const x = toX(ch.t[i]);
      const y = toY(val);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Axis labels & compact legend
    ctx.fillStyle = pal.text;
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText(formatEng(vMax, ch.unit || '', 2), pad.l - 4, pad.t + 8);
    ctx.fillText(formatEng(vMin, ch.unit || '', 2), pad.l - 4, pad.t + ph);
    ctx.textAlign = 'left';
    ctx.fillText(formatEng(t0, 's', 2), pad.l, h - 6);
    ctx.textAlign = 'right';
    ctx.fillText(formatEng(t1, 's', 2), pad.l + pw, h - 6);

    ctx.fillStyle = pal.bg;
    ctx.globalAlpha = 0.86;
    ctx.fillRect(pad.l + pw - 134, pad.t + 3, 130, 15);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = pal.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(pad.l + pw - 134, pad.t + 3, 130, 15);

    ctx.textAlign = 'left';
    ctx.fillStyle = pal.raw;
    ctx.fillText('--- Raw', pad.l + pw - 129, pad.t + 14);
    ctx.fillStyle = pal.filtered;
    ctx.fillText('─── Filtered', pad.l + pw - 74, pad.t + 14);
  }

  private drawBodeCanvas(fsHz: number, nyqHz: number): void {
    const canvas = this.el<HTMLCanvasElement>('filtPreviewCanvas');
    if (!canvas) return;
    const setup = this.setupHiDpiCanvas(canvas);
    if (!setup) return;
    const { ctx, w, h } = setup;
    const pal = this.getCanvasPalette();

    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, w, h);

    const bode = computeFilterBodeResponse(this.config, fsHz, 200);
    if (bode.length < 2) return;

    const pad = { l: 44, r: 14, t: 16, b: 22 };
    const pw = Math.max(40, w - pad.l - pad.r);
    const ph = Math.max(40, h - pad.t - pad.b);

    const fMin = bode[0].freqHz;
    const fMax = bode[bode.length - 1].freqHz;
    const logMin = Math.log10(fMin);
    const logMax = Math.log10(fMax);
    const dbMin = -80;
    const dbMax = 6;

    const toX = (f: number) =>
      pad.l + ((Math.log10(Math.max(fMin, f)) - logMin) / Math.max(1e-6, logMax - logMin)) * pw;
    const toY = (db: number) => pad.t + (1 - (Math.max(dbMin, Math.min(dbMax, db)) - dbMin) / (dbMax - dbMin)) * ph;

    // Grid lines at 0, -20, -40, -60, -80 dB
    ctx.strokeStyle = pal.grid;
    ctx.lineWidth = 1;
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillStyle = pal.text;
    [0, -20, -40, -60, -80].forEach((db) => {
      const y = toY(db);
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + pw, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(`${db}dB`, pad.l - 4, y + 3);
    });
    ctx.strokeRect(pad.l, pad.t, pw, ph);

    // -3 dB reference line
    const y3db = toY(-3.01);
    ctx.strokeStyle = pal.accent;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(pad.l, y3db);
    ctx.lineTo(pad.l + pw, y3db);
    ctx.stroke();

    // Cutoff vertical marker(s)
    const markers: number[] = [];
    if (this.config.algorithm === 'notch') {
      markers.push(this.config.centerFreqHz);
    } else if (
      this.config.algorithm === 'rc_passive' ||
      this.config.algorithm === 'butterworth' ||
      this.config.algorithm === 'bessel' ||
      this.config.algorithm === 'chebyshev1' ||
      this.config.algorithm === 'fir_sinc'
    ) {
      const fc =
        this.config.algorithm === 'rc_passive' && this.config.useRcComponents
          ? 1 / (2 * Math.PI * this.config.rOhm * this.config.cFarad)
          : this.config.cutoffHz;
      markers.push(fc);
      if (this.config.response === 'bandpass' || this.config.response === 'bandstop') {
        markers.push(this.config.cutoffHighHz);
      }
    }
    markers.forEach((mf) => {
      if (mf >= fMin && mf <= fMax) {
        const mx = toX(mf);
        ctx.beginPath();
        ctx.moveTo(mx, pad.t);
        ctx.lineTo(mx, pad.t + ph);
        ctx.stroke();
      }
    });
    ctx.setLineDash([]);

    // Bode magnitude curve
    ctx.strokeStyle = pal.filtered;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    bode.forEach((pt, idx) => {
      const x = toX(pt.freqHz);
      const y = toY(pt.magDb);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.fillStyle = pal.text;
    ctx.fillText(formatEng(fMin, 'Hz', 2), pad.l, h - 6);
    ctx.textAlign = 'right';
    ctx.fillText(`f_Nyq ≈ ${formatEng(nyqHz, 'Hz', 2)}`, pad.l + pw, h - 6);
    ctx.textAlign = 'left';
    ctx.fillStyle = pal.accent;
    ctx.fillText('-3 dB', pad.l + 6, y3db + 11);
  }

  private applyPreset(presetId: string): void {
    const tab = this.app.getActiveTab();
    const ch = tab ? this.getSelectedChannel(tab) : null;
    const fs = ch ? 1 / Math.max(1e-12, medianDt(ch.t)) : 100000;
    const nyq = fs / 2;

    if (presetId === 'sw_noise') {
      this.config.algorithm = 'butterworth';
      this.config.response = 'lowpass';
      this.config.order = 4;
      this.config.zeroPhase = true;
      this.config.cutoffHz = Number(Math.max(1, nyq * 0.05).toPrecision(3));
      this.fcUnit = pickFreqUnit(this.config.cutoffHz);
    } else if (presetId === 'rc_lpf') {
      this.config.algorithm = 'rc_passive';
      this.config.response = 'lowpass';
      this.config.order = 1;
      this.config.zeroPhase = true;
      this.config.useRcComponents = true;
      const targetFc = Math.max(1, nyq * 0.08);
      this.config.rOhm = 1000;
      this.config.cFarad = 1 / (2 * Math.PI * 1000 * targetFc);
      this.config.cutoffHz = targetFc;
      this.resUnit = 'kohm';
      this.capUnit = this.config.cFarad < 1e-9 ? 'pF' : this.config.cFarad < 1e-6 ? 'nF' : 'uF';
    } else if (presetId === 'hum_notch') {
      this.config.algorithm = 'notch';
      this.config.centerFreqHz = nyq > 70 ? 50 : Number((nyq * 0.4).toPrecision(3));
      this.config.qFactor = 12;
      this.config.zeroPhase = true;
      this.f0Unit = pickFreqUnit(this.config.centerFreqHz);
    } else if (presetId === 'median_glitch') {
      this.config.algorithm = 'median';
      this.config.windowSamples = 5;
    } else if (presetId === 'sg_smooth') {
      this.config.algorithm = 'savgol';
      this.config.windowSamples = 15;
      this.config.sgPolyOrder = 3;
    } else if (presetId === 'ac_couple') {
      this.config.algorithm = 'rc_passive';
      this.config.response = 'highpass';
      this.config.order = 1;
      this.config.zeroPhase = false;
      this.config.useRcComponents = false;
      this.config.cutoffHz = Number(Math.max(0.5, nyq * 0.005).toPrecision(3));
      this.fcUnit = pickFreqUnit(this.config.cutoffHz);
    }

    if (tab && ch) {
      this.renderFormFromConfig(tab, ch);
      this.refreshPreview();
    }
  }

  private bindEvents(): void {
    this.el('filtCloseTopBtn')?.addEventListener('click', () => {
      const m = this.el('filterModal');
      if (m) m.style.display = 'none';
    });
    this.el('filtCloseBottomBtn')?.addEventListener('click', () => {
      const m = this.el('filterModal');
      if (m) m.style.display = 'none';
    });

    this.el('filtChannelSelect')?.addEventListener('change', () => {
      const tab = this.app.getActiveTab();
      const ch = tab ? this.getSelectedChannel(tab) : null;
      if (tab && ch) {
        this.lastChannelKey = '';
        this.syncWithTab(tab);
      }
    });

    // Presets
    document.querySelectorAll('.filt-preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pid = (btn as HTMLElement).dataset.preset || '';
        this.applyPreset(pid);
      });
    });

    // Region & Output & Preview segmented buttons
    (['entire', 'view', 'cursors', 'custom'] as FilterRegionMode[]).forEach((m) => {
      this.el(`filtRegion_${m}`)?.addEventListener('click', () => {
        this.config.regionMode = m;
        const tab = this.app.getActiveTab();
        const ch = tab ? this.getSelectedChannel(tab) : null;
        if (tab && ch) {
          if (m === 'view') {
            const b = getTimeBoundsForView(tab, ch);
            this.config.tStart = b.tStart;
            this.config.tEnd = b.tEnd;
          } else if (m === 'cursors' && (!tab.cursors.enabled || tab.cursors.x1 === null || tab.cursors.x2 === null)) {
            this.app.setCursorMode('x');
          }
          this.renderFormFromConfig(tab, ch);
          this.refreshPreview();
        }
      });
    });

    (['new_channel', 'in_place'] as FilterOutputMode[]).forEach((m) => {
      this.el(`filtOut_${m}`)?.addEventListener('click', () => {
        this.config.outputMode = m;
        const tab = this.app.getActiveTab();
        const ch = tab ? this.getSelectedChannel(tab) : null;
        if (tab && ch) this.renderFormFromConfig(tab, ch);
      });
    });

    (['time', 'bode'] as PreviewMode[]).forEach((pm) => {
      this.el(`filtPreviewMode_${pm}`)?.addEventListener('click', () => {
        this.previewMode = pm;
        const tab = this.app.getActiveTab();
        const ch = tab ? this.getSelectedChannel(tab) : null;
        if (tab && ch) {
          this.renderFormFromConfig(tab, ch);
          this.refreshPreview();
        }
      });
    });

    // Parameter changes
    const rerenderAndPreview = (refreshForm: boolean = false) => {
      const tab = this.app.getActiveTab();
      const ch = tab ? this.getSelectedChannel(tab) : null;
      if (!tab || !ch) return;
      if (refreshForm) this.renderFormFromConfig(tab, ch);
      this.refreshPreview();
    };

    this.el<HTMLSelectElement>('filtAlgoSelect')?.addEventListener('change', (e) => {
      this.config.algorithm = (e.target as HTMLSelectElement).value as FilterAlgorithm;
      rerenderAndPreview(true);
    });
    this.el<HTMLSelectElement>('filtResponseSelect')?.addEventListener('change', (e) => {
      this.config.response = (e.target as HTMLSelectElement).value as FilterResponseType;
      rerenderAndPreview(true);
    });
    this.el<HTMLSelectElement>('filtOrderSelect')?.addEventListener('change', (e) => {
      this.config.order = Number((e.target as HTMLSelectElement).value) || 2;
      rerenderAndPreview(false);
    });
    this.el<HTMLInputElement>('filtRippleInput')?.addEventListener('input', (e) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(v) && v > 0) {
        this.config.rippleDb = v;
        rerenderAndPreview(false);
      }
    });

    // Cutoff fc + Unit + Log Slider
    this.el<HTMLInputElement>('filtFcInput')?.addEventListener('input', (e) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(v) && v > 0) {
        this.config.cutoffHz = v * FREQ_MULT[this.fcUnit];
        rerenderAndPreview(false);
      }
    });
    this.el<HTMLSelectElement>('filtFcUnitSelect')?.addEventListener('change', (e) => {
      this.fcUnit = (e.target as HTMLSelectElement).value as FreqUnit;
      rerenderAndPreview(true);
    });
    this.el<HTMLInputElement>('filtFcSlider')?.addEventListener('input', (e) => {
      const tab = this.app.getActiveTab();
      const ch = tab ? this.getSelectedChannel(tab) : null;
      if (!tab || !ch) return;
      const nyq = nyquistOf(ch.t);
      const fMin = Math.max(1e-3, nyq / 2000);
      const fMax = nyq * 0.92;
      const frac = Number((e.target as HTMLInputElement).value) / 1000;
      const fc = fMin * Math.pow(fMax / fMin, frac);
      this.config.cutoffHz = Number(fc.toPrecision(4));
      this.fcUnit = pickFreqUnit(this.config.cutoffHz);
      if (this.config.algorithm === 'rc_passive' && this.config.useRcComponents) {
        this.config.cFarad = 1 / (2 * Math.PI * Math.max(1e-3, this.config.rOhm) * fc);
      }
      rerenderAndPreview(true);
    });

    this.el<HTMLInputElement>('filtFcHighInput')?.addEventListener('input', (e) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(v) && v > 0) {
        this.config.cutoffHighHz = v * FREQ_MULT[this.fcHighUnit];
        rerenderAndPreview(false);
      }
    });
    this.el<HTMLSelectElement>('filtFcHighUnitSelect')?.addEventListener('change', (e) => {
      this.fcHighUnit = (e.target as HTMLSelectElement).value as FreqUnit;
      rerenderAndPreview(true);
    });

    // Notch parameters
    this.el<HTMLInputElement>('filtF0Input')?.addEventListener('input', (e) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(v) && v > 0) {
        this.config.centerFreqHz = v * FREQ_MULT[this.f0Unit];
        rerenderAndPreview(false);
      }
    });
    this.el<HTMLSelectElement>('filtF0UnitSelect')?.addEventListener('change', (e) => {
      this.f0Unit = (e.target as HTMLSelectElement).value as FreqUnit;
      rerenderAndPreview(true);
    });
    this.el<HTMLInputElement>('filtQInput')?.addEventListener('input', (e) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(v) && v > 0) {
        this.config.qFactor = v;
        rerenderAndPreview(false);
      }
    });

    // RC R & C physical components
    this.el<HTMLInputElement>('filtUseRcChk')?.addEventListener('change', (e) => {
      this.config.useRcComponents = (e.target as HTMLInputElement).checked;
      if (this.config.useRcComponents) {
        this.config.cFarad = 1 / (2 * Math.PI * Math.max(1e-3, this.config.rOhm) * Math.max(1e-3, this.config.cutoffHz));
      } else {
        this.config.cutoffHz = 1 / (2 * Math.PI * Math.max(1e-3, this.config.rOhm) * Math.max(1e-15, this.config.cFarad));
      }
      rerenderAndPreview(true);
    });
    const updateRc = () => {
      const rVal = parseFloat(this.el<HTMLInputElement>('filtResInput')?.value || '1');
      const cVal = parseFloat(this.el<HTMLInputElement>('filtCapInput')?.value || '100');
      if (Number.isFinite(rVal) && rVal > 0) this.config.rOhm = rVal * RES_MULT[this.resUnit];
      if (Number.isFinite(cVal) && cVal > 0) this.config.cFarad = cVal * CAP_MULT[this.capUnit];
      const tau = this.config.rOhm * this.config.cFarad;
      if (tau > 0) this.config.cutoffHz = 1 / (2 * Math.PI * tau);
      const rcReadout = this.el('filtRcCalcReadout');
      if (rcReadout) {
        rcReadout.innerText = `τ = ${formatEng(tau, 's', 3)}  ·  f_c = ${formatEng(this.config.cutoffHz, 'Hz', 4)}`;
      }
      rerenderAndPreview(false);
    };
    this.el('filtResInput')?.addEventListener('input', updateRc);
    this.el('filtCapInput')?.addEventListener('input', updateRc);
    this.el<HTMLSelectElement>('filtResUnitSelect')?.addEventListener('change', (e) => {
      this.resUnit = (e.target as HTMLSelectElement).value as ResUnit;
      rerenderAndPreview(true);
    });
    this.el<HTMLSelectElement>('filtCapUnitSelect')?.addEventListener('change', (e) => {
      this.capUnit = (e.target as HTMLSelectElement).value as CapUnit;
      rerenderAndPreview(true);
    });

    // FIR / Time-domain / Zero-phase / Custom bounds
    this.el<HTMLInputElement>('filtFirTapsInput')?.addEventListener('input', (e) => {
      const v = parseInt((e.target as HTMLInputElement).value, 10);
      if (Number.isFinite(v) && v >= 5) {
        this.config.firTaps = v % 2 === 0 ? v + 1 : v;
        rerenderAndPreview(false);
      }
    });
    this.el<HTMLSelectElement>('filtFirWinSelect')?.addEventListener('change', (e) => {
      this.config.firWindow = (e.target as HTMLSelectElement).value as FirWindowType;
      rerenderAndPreview(false);
    });
    this.el<HTMLInputElement>('filtWinSamplesInput')?.addEventListener('input', (e) => {
      const v = parseInt((e.target as HTMLInputElement).value, 10);
      if (Number.isFinite(v) && v >= 3) {
        this.config.windowSamples = v;
        rerenderAndPreview(false);
      }
    });
    this.el<HTMLSelectElement>('filtMaModeSelect')?.addEventListener('change', (e) => {
      this.config.maMode = (e.target as HTMLSelectElement).value as 'boxcar' | 'ema';
      rerenderAndPreview(true);
    });
    this.el<HTMLInputElement>('filtEmaAlphaInput')?.addEventListener('input', (e) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(v) && v > 0 && v < 1) {
        this.config.emaAlpha = v;
        rerenderAndPreview(false);
      }
    });
    this.el<HTMLSelectElement>('filtSgPolySelect')?.addEventListener('change', (e) => {
      this.config.sgPolyOrder = parseInt((e.target as HTMLSelectElement).value, 10) || 2;
      rerenderAndPreview(false);
    });
    this.el<HTMLInputElement>('filtZeroPhaseChk')?.addEventListener('change', (e) => {
      this.config.zeroPhase = (e.target as HTMLInputElement).checked;
      rerenderAndPreview(false);
    });
    this.el<HTMLInputElement>('filtEdgeBlendInput')?.addEventListener('input', (e) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(v)) {
        this.config.edgeBlendPct = Math.max(0, Math.min(25, v));
        rerenderAndPreview(false);
      }
    });

    const updateCustomBounds = () => {
      const mult = TIME_MULT[this.customTimeUnit];
      const sVal = parseFloat(this.el<HTMLInputElement>('filtCustomTStartInput')?.value || '0');
      const eVal = parseFloat(this.el<HTMLInputElement>('filtCustomTEndInput')?.value || '1');
      if (Number.isFinite(sVal)) this.config.tStart = sVal * mult;
      if (Number.isFinite(eVal)) this.config.tEnd = eVal * mult;
      rerenderAndPreview(false);
    };
    this.el('filtCustomTStartInput')?.addEventListener('input', updateCustomBounds);
    this.el('filtCustomTEndInput')?.addEventListener('input', updateCustomBounds);
    this.el<HTMLSelectElement>('filtCustomTimeUnitSelect')?.addEventListener('change', (e) => {
      this.customTimeUnit = (e.target as HTMLSelectElement).value as TimeUnit;
      rerenderAndPreview(true);
    });

    // Apply Filter button
    this.el('filtApplyBtn')?.addEventListener('click', () => {
      const tab = this.app.getActiveTab();
      const ch = tab ? this.getSelectedChannel(tab) : null;
      if (!tab || !ch) return;
      const out = this.app.applyFilterToChannel(ch.id, { ...this.config });
      if (out.ok) {
        this.syncIfOpen();
      }
    });

    this.el('filtRevertRawBtn')?.addEventListener('click', () => {
      const tab = this.app.getActiveTab();
      const ch = tab ? this.getSelectedChannel(tab) : null;
      if (!tab || !ch) return;
      this.app.revertChannelEdits(ch.id);
      this.syncIfOpen();
    });

    window.addEventListener('wvp-drawer-resized', (ev: any) => {
      if (ev?.detail?.id === 'filterModal') this.refreshPreview();
    });
  }
}
