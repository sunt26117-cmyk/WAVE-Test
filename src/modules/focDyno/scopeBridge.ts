/**
 * FOC DynoLab <-> Waveform Viewer Pro Bidirectional Data & Unit Bridge
 * Handles lossless in-memory TabState generation, explicit unit-safe channel import
 * from the Oscilloscope (RPM / rad/s / elec Hz; A / mA), and verified 6-MOS thermal handoff.
 */

import { TabState, WaveformChannel } from '../../types/models';
import { analyzeSamplingQuality } from '../qualityCheck';
import { getChannelDisplayValue, computeChannelMean } from '../oscilloscopeScale';
import { MotorParams, RuntimeLogRow } from './motorPhysics';
import { SynthesizedWaveform } from './thermalExporter';
import { RawRuntimeLogEntry } from './demoData';

export type ScopeSpeedUnit = 'rpm' | 'rad_s' | 'elec_hz';
export type ScopeCurrentUnit = 'A' | 'mA';

export interface FocThermalHandoffPayload {
  tab: TabState;
  iaChannelId: string;
  ibChannelId: string;
  icChannelId: string;
  vbusChannelId: string;
  daChannelId?: string;
  dbChannelId?: string;
  dcChannelId?: string;
  modulation?: 'SVPWM' | 'DPWM1';
  vBusConstV: number;
  tAmbC: number;
  modDepthM: number;
  pfAngleDeg: number;
  fswKhz: number;
  tDeadNs: number;
  rdsOnMOhm: number;
  vsdV: number;
  rsPhaseOhm?: number;
  handoffNote?: string;
}

function makeChannel(
  id: string,
  name: string,
  unit: string,
  color: string,
  t: Float64Array,
  v: Float32Array,
  fs: number,
  dt: number,
  meta: ReturnType<typeof analyzeSamplingQuality>,
  options?: { isMath?: boolean; badgeText?: string; expr?: string }
): WaveformChannel {
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < v.length; i++) {
    const val = v[i];
    if (!Number.isFinite(val)) continue;
    if (val < mn) mn = val;
    if (val > mx) mx = val;
  }
  if (!Number.isFinite(mn) || !Number.isFinite(mx)) {
    mn = -1;
    mx = 1;
  } else if (Math.abs(mx - mn) < 1e-6) {
    mn -= 0.5;
    mx += 0.5;
  } else {
    const pad = (mx - mn) * 0.1;
    mn -= pad;
    mx += pad;
  }

  return {
    id,
    name,
    unit,
    color,
    t,
    v,
    visible: true,
    vMin: mn,
    vMax: mx,
    coupling: 'DC',
    inverted: false,
    isMath: options?.isMath ?? false,
    channelKind: options?.isMath ? 'computed' : 'raw',
    derivedKind: options?.isMath ? 'math' : undefined,
    derivedBadge: options?.badgeText,
    mathExpression: options?.expr,
    sourceChannelIds: [],
    fs,
    dt,
    metadata: meta,
  };
}

export function buildOscilloscopeTabFromSixMos(
  synth: SynthesizedWaveform,
  nRpm: number
): TabState | null {
  const n = synth.samples.length;
  if (n < 2 || synth.error) return null;

  const t = new Float64Array(n);
  const ia = new Float32Array(n);
  const ib = new Float32Array(n);
  const ic = new Float32Array(n);
  const vbus = new Float32Array(n);

  const hasDuty = Boolean(synth.summary.includeDuty && synth.samples[0].da !== undefined);
  const da = hasDuty ? new Float32Array(n) : null;
  const db = hasDuty ? new Float32Array(n) : null;
  const dc = hasDuty ? new Float32Array(n) : null;

  for (let i = 0; i < n; i++) {
    const s = synth.samples[i];
    t[i] = s.timeS;
    ia[i] = s.iaA;
    ib[i] = s.ibA;
    ic[i] = s.icA;
    vbus[i] = s.vBusV;
    if (da && db && dc) {
      da[i] = s.da ?? 0.5;
      db[i] = s.db ?? 0.5;
      dc[i] = s.dc ?? 0.5;
    }
  }

  const dt = n >= 2 ? Math.max(1e-9, t[1] - t[0]) : 1 / 20000;
  const fs = 1 / dt;
  const meta = analyzeSamplingQuality(t);

  const chIa = makeChannel('ch_ia', 'Ia', 'A', '#facc15', t, ia, fs, dt, meta);
  const chIb = makeChannel('ch_ib', 'Ib', 'A', '#22d3ee', t, ib, fs, dt, meta);
  const chIc = makeChannel('ch_ic', 'Ic', 'A', '#4ade80', t, ic, fs, dt, meta);
  const chVbus = makeChannel('ch_vbus', 'Vbus_cap', 'V', '#fb923c', t, vbus, fs, dt, meta);

  const channels: Record<string, WaveformChannel> = {
    ch_ia: chIa,
    ch_ib: chIb,
    ch_ic: chIc,
    ch_vbus: chVbus,
  };
  const drawOrder = ['ch_ia', 'ch_ib', 'ch_ic', 'ch_vbus'];

  if (da && db && dc) {
    channels['ch_da'] = makeChannel('ch_da', 'Duty_A', '', '#a78bfa', t, da, fs, dt, meta);
    channels['ch_db'] = makeChannel('ch_db', 'Duty_B', '', '#f472b6', t, db, fs, dt, meta);
    channels['ch_dc'] = makeChannel('ch_dc', 'Duty_C', '', '#38bdf8', t, dc, fs, dt, meta);
    drawOrder.push('ch_da', 'ch_db', 'ch_dc');
  }

  return {
    id: `dyno_6mos_${Date.now()}`,
    fileName: `DynoLab_6MOS_${Math.round(nRpm)}rpm_${synth.summary.iqPeakA.toFixed(2)}A.csv`,
    channels,
    drawOrder,
    activeChannelId: 'ch_ia',
    separateView: true,
    plotMode: 'time',
    view: { startIndex: 0, endIndex: n },
    cursors: { enabled: false, mode: 'off', x1: null, x2: null, y1: null, y2: null, trackingChannel: 'ch_ia' },
    measurementGate: 'view',
    selectedMeasurements: [],
    triggerConfig: { enabled: false, channelId: 'ch_ia', type: 'rising', level: 0, positionPercent: 10 },
    fftOptions: { window: 'hann', scale: 'db', range: 'view', removeDC: true, zeroPadding: 1 },
    motorConfig: { enabled: false, rpm: Math.abs(Math.round(nRpm)) || null, polePairs: null },
    annotations: [],
    annotationMode: false,
    annotationsVisible: true,
    isOverlap: false,
  };
}

export function buildOscilloscopeTabFromBatchLog(
  rows: RuntimeLogRow[],
  sourceFileName: string
): TabState | null {
  const n = rows.length;
  if (n < 2) return null;

  const t = new Float64Array(n);
  const iq = new Float32Array(n);
  const iBusFilt = new Float32Array(n);
  const vqMotor = new Float32Array(n);
  const vqCmd = new Float32Array(n);
  const mCmd = new Float32Array(n);
  const vMeas = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const r = rows[i];
    t[i] = r.timeS;
    iq[i] = Number.isFinite(r.result.iqA) ? r.result.iqA : Number.NaN;
    iBusFilt[i] = Number.isFinite(r.iBusFilteredA) ? r.iBusFilteredA : Number.NaN;
    vqMotor[i] = Number.isFinite(r.result.vqMotorV) ? r.result.vqMotorV : Number.NaN;
    vqCmd[i] = Number.isFinite(r.result.vqCmdV) ? r.result.vqCmdV : Number.NaN;
    mCmd[i] = Number.isFinite(r.result.mCmd) ? r.result.mCmd : Number.NaN;
    vMeas[i] = r.vMeasV;
  }

  const dt = n >= 2 ? Math.max(1e-9, (t[n - 1] - t[0]) / (n - 1)) : 0.002;
  const fs = 1 / dt;
  const meta = analyzeSamplingQuality(t);

  const chIq = makeChannel('ch_iq', 'Iq_est', 'A', '#38bdf8', t, iq, fs, dt, meta, {
    isMath: true,
    badgeText: 'fx',
    expr: 'Inverse FOC Iq(Vbus, Ibus, n)',
  });
  const chIbus = makeChannel('ch_ibus', 'Ibus_filt', 'A', '#f59e0b', t, iBusFilt, fs, dt, meta);
  const chVqM = makeChannel('ch_vq_motor', 'Vq_motor', 'V', '#4ade80', t, vqMotor, fs, dt, meta, {
    isMath: true,
    badgeText: 'fx',
    expr: 'Eq + Rs*Iq',
  });
  const chVqC = makeChannel('ch_vq_cmd', 'Vq_cmd', 'V', '#f472b6', t, vqCmd, fs, dt, meta, {
    isMath: true,
    badgeText: 'fx',
    expr: 'Vq_motor + Rds*Iq + Vdead',
  });
  const chM = makeChannel('ch_m_cmd', 'm_cmd', '', '#a78bfa', t, mCmd, fs, dt, meta, {
    isMath: true,
    badgeText: 'fx',
    expr: 'Vph_cmd / (Vbus_cap/2)',
  });
  const chVbus = makeChannel('ch_vbus', 'Vbus_meas', 'V', '#fb923c', t, vMeas, fs, dt, meta);

  const baseName = sourceFileName.replace(/\.[^.]+$/, '');
  return {
    id: `dyno_batch_${Date.now()}`,
    fileName: `${baseName}_FOC_Inverse.csv`,
    channels: {
      ch_iq: chIq,
      ch_ibus: chIbus,
      ch_vq_motor: chVqM,
      ch_vq_cmd: chVqC,
      ch_m_cmd: chM,
      ch_vbus: chVbus,
    },
    drawOrder: ['ch_iq', 'ch_ibus', 'ch_vq_motor', 'ch_vq_cmd', 'ch_m_cmd', 'ch_vbus'],
    activeChannelId: 'ch_iq',
    separateView: true,
    plotMode: 'time',
    view: { startIndex: 0, endIndex: n },
    cursors: { enabled: false, mode: 'off', x1: null, x2: null, y1: null, y2: null, trackingChannel: 'ch_iq' },
    measurementGate: 'view',
    selectedMeasurements: [],
    triggerConfig: { enabled: false, channelId: 'ch_iq', type: 'rising', level: 0, positionPercent: 10 },
    fftOptions: { window: 'hann', scale: 'db', range: 'view', removeDC: true, zeroPadding: 1 },
    motorConfig: { enabled: false, rpm: null, polePairs: null },
    annotations: [],
    annotationMode: false,
    annotationsVisible: true,
    isOverlap: false,
  };
}

export function buildThermalHandoffFromSixMos(
  synth: SynthesizedWaveform,
  params: MotorParams,
  nRpm: number,
  tAmbC: number
): FocThermalHandoffPayload | null {
  const tab = buildOscilloscopeTabFromSixMos(synth, nRpm);
  if (!tab) return null;

  // Compute safe mCmd (clipped to 1.20 max to preserve full SVPWM linear ceiling 1.1547)
  // and 4-quadrant PF angle phiCmdDeg (-180..+180 deg)
  const rawM = Number.isFinite(synth.summary.mCmd) ? synth.summary.mCmd : 0.85;
  const modDepthM = Math.max(0, Math.min(1.2, rawM));
  const pfAngleDeg = Number.isFinite(synth.summary.phiCmdDeg) ? synth.summary.phiCmdDeg : 0;
  const hasDutyChs = Boolean(tab.channels['ch_da'] && tab.channels['ch_db'] && tab.channels['ch_dc']);

  const clampMsg = synth.clampedByLimit
    ? `【时长已截断】请求导出 ${synth.requestedDurationS.toFixed(3)} s (${synth.requestedSamples.toLocaleString()} 点)，受 ${synth.exportedSamples.toLocaleString()} 点上限约束实际仅导出 ${synth.actualDurationS.toFixed(3)} s，将直接减少热仿真积温时长。`
    : '';
  const baseNote =
    'DynoLab 仅标定系统级参数 (I_idle/η_inv) 并同步 Vbus_cap, m_cmd, φ_cmd, f_sw, t_dead, Rds25, V_SD, R_s(堵转)；开关损耗/结温参数 (α, Esw, Qrr, Vref, Iref) 仍沿用 MOS Thermal 数据手册设定。';

  return {
    tab,
    iaChannelId: 'ch_ia',
    ibChannelId: 'ch_ib',
    icChannelId: 'ch_ic',
    vbusChannelId: 'ch_vbus',
    daChannelId: hasDutyChs ? 'ch_da' : undefined,
    dbChannelId: hasDutyChs ? 'ch_db' : undefined,
    dcChannelId: hasDutyChs ? 'ch_dc' : undefined,
    modulation: synth.summary.modulationMode,
    vBusConstV: Number(synth.summary.vBusCapV.toFixed(3)),
    tAmbC,
    modDepthM: Number(modDepthM.toFixed(4)),
    pfAngleDeg: Number(pfAngleDeg.toFixed(2)),
    fswKhz: params.fSwKhz,
    tDeadNs: params.tDeadNs,
    rdsOnMOhm: params.rdsOnMOhm,
    vsdV: params.vSdV,
    rsPhaseOhm: Number.isFinite(synth.pointResult.rsOhm) ? Number(synth.pointResult.rsOhm.toFixed(5)) : undefined,
    handoffNote: clampMsg ? `${clampMsg} ${baseNote}` : baseNote,
  };
}

function sampleChannelAtTime(ch: WaveformChannel, tQuery: number, acOffset: number): number {
  const len = Math.min(ch.t.length, ch.v.length);
  if (len === 0 || !Number.isFinite(tQuery)) return Number.NaN;
  if (len === 1) return getChannelDisplayValue(ch, 0, acOffset);

  if (tQuery <= ch.t[0]) {
    for (let i = 0; i < Math.min(len, 16); i++) {
      const val = getChannelDisplayValue(ch, i, acOffset);
      if (Number.isFinite(val)) return val;
    }
    return Number.NaN;
  }
  if (tQuery >= ch.t[len - 1]) {
    for (let i = len - 1; i >= Math.max(0, len - 16); i--) {
      const val = getChannelDisplayValue(ch, i, acOffset);
      if (Number.isFinite(val)) return val;
    }
    return Number.NaN;
  }

  // Binary search for bracketing interval [lo, hi] where ch.t[lo] <= tQuery <= ch.t[hi]
  let lo = 0;
  let hi = len - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ch.t[mid] <= tQuery) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  let iL = lo;
  let v0 = getChannelDisplayValue(ch, iL, acOffset);
  while (!Number.isFinite(v0) && iL > 0) {
    iL--;
    v0 = getChannelDisplayValue(ch, iL, acOffset);
  }
  let iR = hi;
  let v1 = getChannelDisplayValue(ch, iR, acOffset);
  while (!Number.isFinite(v1) && iR < len - 1) {
    iR++;
    v1 = getChannelDisplayValue(ch, iR, acOffset);
  }
  if (!Number.isFinite(v0)) return v1;
  if (!Number.isFinite(v1)) return v0;
  const span = ch.t[iR] - ch.t[iL];
  if (span <= 1e-15) return v0;
  const alpha = (tQuery - ch.t[iL]) / span;
  return v0 + alpha * (v1 - v0);
}

/**
 * Extracts runtime log rows directly from active Oscilloscope channels with explicit unit conversions
 * and timestamp-aligned interpolation across channels + peak-preserving MinMax bucket downsampling.
 */
export function extractRuntimeLogFromScopeChannels(options: {
  vbusCh: WaveformChannel | null;
  vbusConstV: number;
  ibusCh: WaveformChannel;
  currentUnit: ScopeCurrentUnit;
  speedCh: WaveformChannel | null;
  speedConstRpm: number;
  speedUnit: ScopeSpeedUnit;
  polePairs: number;
  maxPoints?: number;
}): RawRuntimeLogEntry[] {
  const {
    vbusCh,
    vbusConstV,
    ibusCh,
    currentUnit,
    speedCh,
    speedConstRpm,
    speedUnit,
    polePairs,
    maxPoints = 4000,
  } = options;

  const n = Math.min(ibusCh.t.length, ibusCh.v.length);
  if (n < 2) return [];

  const acI = ibusCh.coupling === 'AC' ? computeChannelMean(ibusCh) : 0;
  const acV = vbusCh && vbusCh.coupling === 'AC' ? computeChannelMean(vbusCh) : 0;
  const acSpd = speedCh && speedCh.coupling === 'AC' ? computeChannelMean(speedCh) : 0;

  const iScale = currentUnit === 'mA' ? 1e-3 : 1;
  const p = Math.max(1, Math.round(polePairs));

  const convertSpeedToRpm = (val: number): number => {
    if (speedUnit === 'rad_s') return (val * 60) / (2 * Math.PI);
    if (speedUnit === 'elec_hz') return (val * 60) / p;
    return val;
  };

  // Build chronologically ordered sample indices (peak-preserving MinMax buckets if n > maxPoints)
  const indices: number[] = [];
  if (n <= maxPoints) {
    for (let i = 0; i < n; i++) indices.push(i);
  } else {
    const buckets = Math.max(1, Math.floor(maxPoints / 2));
    for (let b = 0; b < buckets; b++) {
      const start = Math.floor((b * n) / buckets);
      const end = Math.min(n, Math.floor(((b + 1) * n) / buckets));
      if (start >= end) continue;
      let minIdx = -1;
      let maxIdx = -1;
      let minVal = Infinity;
      let maxVal = -Infinity;
      for (let j = start; j < end; j++) {
        const val = getChannelDisplayValue(ibusCh, j, acI);
        if (!Number.isFinite(val)) continue;
        if (val < minVal) {
          minVal = val;
          minIdx = j;
        }
        if (val > maxVal) {
          maxVal = val;
          maxIdx = j;
        }
      }
      if (minIdx >= 0 && maxIdx >= 0) {
        if (minIdx === maxIdx) {
          indices.push(minIdx);
        } else if (minIdx < maxIdx) {
          indices.push(minIdx, maxIdx);
        } else {
          indices.push(maxIdx, minIdx);
        }
      }
    }
  }

  const sameVbusTimebase = Boolean(
    vbusCh && vbusCh.t === ibusCh.t && vbusCh.v.length >= n
  );
  const sameSpeedTimebase = Boolean(
    speedCh && speedCh.t === ibusCh.t && speedCh.v.length >= n
  );

  const rows: RawRuntimeLogEntry[] = [];
  for (const i of indices) {
    const t = ibusCh.t[i];
    const iVal = getChannelDisplayValue(ibusCh, i, acI) * iScale;
    const vVal = !vbusCh
      ? vbusConstV
      : sameVbusTimebase
      ? getChannelDisplayValue(vbusCh, i, acV)
      : sampleChannelAtTime(vbusCh, t, acV);
    const nVal = !speedCh
      ? speedConstRpm
      : convertSpeedToRpm(
          sameSpeedTimebase
            ? getChannelDisplayValue(speedCh, i, acSpd)
            : sampleChannelAtTime(speedCh, t, acSpd)
        );

    if (Number.isFinite(t) && Number.isFinite(iVal) && Number.isFinite(vVal) && Number.isFinite(nVal)) {
      rows.push({
        timeS: t,
        vMeasV: vVal,
        iBusA: iVal,
        nRpm: nVal,
      });
    }
  }

  return rows;
}
