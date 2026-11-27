/**
 * FOC DynoLab <-> Waveform Viewer Pro Bidirectional Data & Unit Bridge
 * Handles lossless in-memory TabState generation, explicit unit-safe channel import
 * from the Oscilloscope (RPM / rad/s / elec Hz; A / mA), and verified 6-MOS thermal handoff.
 */

import { TabState, WaveformChannel } from '../../types/models';
import { analyzeSamplingQuality } from '../qualityCheck';
import { getChannelDisplayValue, computeChannelMean } from '../oscilloscopeScale';
import { parseSiUnitScale } from '../thermalEngine';
import { inspectTimebase, areTimebasesSynchronized, inspectChannelSamplingGaps } from '../timeSync';
import { MotorParams, RuntimeLogRow } from './motorPhysics';
import { SynthesizedWaveform } from './thermalExporter';
import { RawRuntimeLogEntry } from './demoData';

export type ScopeSpeedUnit = 'rpm' | 'rad_s' | 'elec_hz';
export type ScopeCurrentUnit = 'A' | 'mA';

export interface FocThermalHandoffPayload {
  tab: TabState;
  /** Fixed FOC dq operating point used by the direct steady-state loss/thermal solver. */
  steadyOperatingPoint: {
    iqPeakA: number;
    idPeakA: number;
    electricalFrequencyHz: number;
    mode: 'rotating' | 'locked_rotor';
    electricalAngleDeg: number;
    mechanicalSpeedRpm?: number;
    torqueNm?: number;
    mechanicalPowerW?: number;
    busInputPowerW?: number;
    dcLinkPowerW?: number;
    motorElectricalPowerW?: number;
    impliedInverterLossW?: number;
  };
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

/** Scope channels share the same time vector. Reject ambiguous clocks rather than
 * assigning a nominal fs to data with duplicate, descending, or non-finite times. */
function hasStrictlyIncreasingFiniteTime(t: Float64Array): boolean {
  if (t.length < 2) return false;
  for (let i = 0; i < t.length; i++) {
    if (!Number.isFinite(t[i])) return false;
    if (i > 0 && !(t[i] > t[i - 1])) return false;
  }
  return true;
}

function getRobustTimebase(t: Float64Array) {
  const meta = analyzeSamplingQuality(t);
  const dt = meta.medianDt ?? meta.nominalDt;
  if (!Number.isFinite(dt) || (dt as number) <= 0) return null;
  const safeDt = dt as number;
  return { meta, dt: safeDt, fs: 1 / safeDt };
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
  options?: {
    isMath?: boolean;
    badgeText?: string;
    expr?: string;
    dataProvenance?: NonNullable<WaveformChannel['metadata']>['dataProvenance'];
    sourceModel?: string;
  }
): WaveformChannel {
  let mn = Infinity;
  let mx = -Infinity;
  let signalNanCount = 0;
  for (let i = 0; i < v.length; i++) {
    const val = v[i];
    if (!Number.isFinite(val)) {
      signalNanCount++;
      continue;
    }
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
    // Each signal has its own invalid-value count. Sharing the timebase object
    // must not make one channel's NaNs appear on every other channel.
    metadata: {
      ...meta,
      gapIndices: [...meta.gapIndices],
      signalNanCount,
      dataProvenance: options?.dataProvenance ?? meta.dataProvenance,
      sourceModel: options?.sourceModel ?? meta.sourceModel,
    },
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

  const hasDuty = Boolean(synth.summary.includeDuty);
  const da = hasDuty ? new Float32Array(n) : null;
  const db = hasDuty ? new Float32Array(n) : null;
  const dc = hasDuty ? new Float32Array(n) : null;

  for (let i = 0; i < n; i++) {
    const s = synth.samples[i];
    if (
      !Number.isFinite(s.timeS) ||
      !Number.isFinite(s.iaA) ||
      !Number.isFinite(s.ibA) ||
      !Number.isFinite(s.icA) ||
      !Number.isFinite(s.vBusV)
    ) return null;
    if (hasDuty && (
      !Number.isFinite(s.da) || !Number.isFinite(s.db) || !Number.isFinite(s.dc) ||
      (s.da as number) < 0 || (s.da as number) > 1 ||
      (s.db as number) < 0 || (s.db as number) > 1 ||
      (s.dc as number) < 0 || (s.dc as number) > 1
    )) return null;

    t[i] = s.timeS;
    ia[i] = s.iaA;
    ib[i] = s.ibA;
    ic[i] = s.icA;
    vbus[i] = s.vBusV;
    if (da && db && dc) {
      da[i] = s.da as number;
      db[i] = s.db as number;
      dc[i] = s.dc as number;
    }
  }

  if (!hasStrictlyIncreasingFiniteTime(t)) return null;
  const timebase = getRobustTimebase(t);
  if (!timebase) return null;
  const { dt, fs } = timebase;
  const meta = timebase.meta;
  meta.dataProvenance = synth.summary.dataProvenance;
  meta.sourceModel = synth.summary.waveformModel;

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

  if (!hasStrictlyIncreasingFiniteTime(t)) return null;
  const timebase = getRobustTimebase(t);
  if (!timebase) return null;
  const { dt, fs, meta } = timebase;

  const chIq = makeChannel('ch_iq', 'Iq_est', 'A', '#38bdf8', t, iq, fs, dt, meta, {
    isMath: true,
    badgeText: 'fx',
    expr: 'Inverse FOC Iq(Vbus, Ibus, n)',
    dataProvenance: 'derived_estimate',
    sourceModel: 'foc_inverse_steady_state_model',
  });
  const chIbus = makeChannel('ch_ibus', 'Ibus_filt', 'A', '#f59e0b', t, iBusFilt, fs, dt, meta, {
    dataProvenance: 'measured',
    sourceModel: 'dynolab_runtime_log_input',
  });
  const chVqM = makeChannel('ch_vq_motor', 'Vq_motor', 'V', '#4ade80', t, vqMotor, fs, dt, meta, {
    isMath: true,
    badgeText: 'fx',
    expr: 'Eq + Rs*Iq',
    dataProvenance: 'derived_estimate',
    sourceModel: 'foc_inverse_steady_state_model',
  });
  const chVqC = makeChannel('ch_vq_cmd', 'Vq_cmd', 'V', '#f472b6', t, vqCmd, fs, dt, meta, {
    isMath: true,
    badgeText: 'fx',
    expr: 'Vq_motor + Rds*Iq + Vdead',
    dataProvenance: 'derived_estimate',
    sourceModel: 'foc_inverse_steady_state_model',
  });
  const chM = makeChannel('ch_m_cmd', 'm_cmd', '', '#a78bfa', t, mCmd, fs, dt, meta, {
    isMath: true,
    badgeText: 'fx',
    expr: 'Vph_cmd / (Vbus_cap/2)',
    dataProvenance: 'derived_estimate',
    sourceModel: 'foc_inverse_steady_state_model',
  });
  const chVbus = makeChannel('ch_vbus', 'Vbus_meas', 'V', '#fb923c', t, vMeas, fs, dt, meta, {
    dataProvenance: 'measured',
    sourceModel: 'dynolab_runtime_log_input',
  });

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
  tAmbC: number,
  options?: { rdsRefTempC?: number; alphaPerC?: number }
): FocThermalHandoffPayload | null {
  const tab = buildOscilloscopeTabFromSixMos(synth, nRpm);
  if (!tab) return null;

  // Compute safe mCmd (clipped to 1.20 max to preserve full SVPWM linear ceiling 1.1547)
  // and 4-quadrant PF angle phiCmdDeg (-180..+180 deg)
  const rawM = Number.isFinite(synth.summary.mCmd) ? synth.summary.mCmd : 0.85;
  const modDepthM = Math.max(0, Math.min(1.2, rawM));
  const pfAngleDeg = Number.isFinite(synth.summary.phiCmdDeg) ? synth.summary.phiCmdDeg : 0;
  const hasDutyChs = Boolean(tab.channels['ch_da'] && tab.channels['ch_db'] && tab.channels['ch_dc']);

  // Convert DynoLab operating-Tj Rds(on) back to 25°C reference Rds25 when rdsRefTempC != 25
  const rdsRefC = options?.rdsRefTempC !== undefined && Number.isFinite(options.rdsRefTempC) ? options.rdsRefTempC : 25;
  const alphaPerC = options?.alphaPerC !== undefined && Number.isFinite(options.alphaPerC) ? options.alphaPerC : 0.0045;
  const tempFactor = Math.max(0.4, 1 + alphaPerC * (rdsRefC - 25));
  const rds25MOhm = rdsRefC !== 25 ? params.rdsOnMOhm / tempFactor : params.rdsOnMOhm;

  const clampMsg = synth.clampedByLimit
    ? `【时长已截断】请求导出 ${synth.requestedDurationS.toFixed(3)} s (${synth.requestedSamples.toLocaleString()} 点)，受 ${synth.exportedSamples.toLocaleString()} 点上限约束实际仅导出 ${synth.actualDurationS.toFixed(3)} s，将直接减少热仿真积温时长。`
    : '';
  const rdsConvNote =
    rdsRefC !== 25
      ? `（已将 ${rdsRefC.toFixed(0)}°C 热态 Rds=${params.rdsOnMOhm.toFixed(2)}mΩ 折算为 Rds25=${rds25MOhm.toFixed(2)}mΩ 以避免闭环温升重复放大）`
      : '';
  const provenanceNote = '【模型合成数据】理想正弦相电流与周期平均 Duty；无 PWM 载波、开关纹波、死区畸变、ADC 采样窗口及实测控制环动态，禁止作为实测开关损耗输入。';
  const baseNote =
    `${provenanceNote} DynoLab 标定电机参数 (Ke', P0, β) 并结合人工设定 I_idle/η_inv 同步 Vbus_cap, m_cmd, φ_cmd, f_sw, t_dead, Rds25${rdsConvNote}, V_SD, R_s(堵转)；开关损耗/热系数 (α, Esw, Eoss, Qrr, Vref, Iref) 仍沿用 MOS Thermal 面板设定。`;

  return {
    tab,
    steadyOperatingPoint: {
      iqPeakA: synth.summary.iqPeakA,
      idPeakA: 0,
      electricalFrequencyHz: Math.max(0, synth.summary.feHz),
      mode: synth.summary.isStall ? 'locked_rotor' : 'rotating',
      // The current DynoLab steady operating point is Id=0 / Iq-only. At standstill
      // the rotor electrical angle is not inferable from scalar bus power; 90° is
      // the same explicit phase convention used by thermalExporter (Ia=Iq).
      electricalAngleDeg: 90,
      mechanicalSpeedRpm: synth.pointResult.nRpm,
      torqueNm: synth.pointResult.tEstNm,
      mechanicalPowerW: synth.pointResult.pOutW,
      busInputPowerW: synth.pointResult.pInW,
      dcLinkPowerW: synth.pointResult.vBusCapV * synth.pointResult.iNetA,
      motorElectricalPowerW: synth.pointResult.pElecW,
      impliedInverterLossW: synth.pointResult.vBusCapV * synth.pointResult.iNetA - synth.pointResult.pElecW,
    },
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
    rdsOnMOhm: Number(rds25MOhm.toFixed(3)),
    vsdV: params.vSdV,
    rsPhaseOhm: Number.isFinite(synth.pointResult.rsOhm) ? Number(synth.pointResult.rsOhm.toFixed(5)) : undefined,
    handoffNote: clampMsg ? `${clampMsg} ${baseNote}` : baseNote,
  };
}

function validateScopeSourceChannel(
  ch: WaveformChannel,
  label: string,
  acOffset: number
): string | null {
  if (ch.t.length !== ch.v.length) {
    return `${label} 通道时间数组与数值数组长度不一致（${ch.t.length} vs ${ch.v.length}），拒绝截断对齐。`;
  }
  if (ch.t.length < 2) return `${label} 通道样本不足 2 点。`;
  for (let i = 0; i < ch.t.length; i++) {
    if (!Number.isFinite(ch.t[i])) return `${label} 通道第 ${i + 1} 个时间戳非有限。`;
    if (i > 0 && ch.t[i] <= ch.t[i - 1]) {
      return `${label} 通道时间戳必须严格递增；第 ${i + 1} 点重复或倒退。`;
    }
    if (!Number.isFinite(getChannelDisplayValue(ch, i, acOffset))) {
      return `${label} 通道第 ${i + 1} 个采样值无效；拒绝跨越 NaN/缺失段插值。`;
    }
  }
  return null;
}

function sampleChannelAtTime(ch: WaveformChannel, tQuery: number, acOffset: number): number {
  const len = ch.t.length;
  if (len !== ch.v.length || len < 2 || !Number.isFinite(tQuery)) return Number.NaN;
  // No endpoint extrapolation: a query outside the acquired interval is invalid.
  if (tQuery < ch.t[0] || tQuery > ch.t[len - 1]) return Number.NaN;

  let lo = 0;
  let hi = len - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ch.t[mid] < tQuery) lo = mid + 1;
    else hi = mid;
  }
  if (ch.t[lo] === tQuery) return getChannelDisplayValue(ch, lo, acOffset);
  if (lo === 0) return Number.NaN;

  const left = lo - 1;
  const t0 = ch.t[left];
  const t1 = ch.t[lo];
  const v0 = getChannelDisplayValue(ch, left, acOffset);
  const v1 = getChannelDisplayValue(ch, lo, acOffset);
  if (!(t1 > t0) || !Number.isFinite(v0) || !Number.isFinite(v1)) return Number.NaN;
  const alpha = (tQuery - t0) / (t1 - t0);
  return v0 + alpha * (v1 - v0);
}

export interface ScopeRuntimeExtractionAudit {
  rows: RawRuntimeLogEntry[];
  warnings: string[];
  vbusScaleV: number;
  ibusScaleA: number;
  isMonotonic: boolean;
}

export function extractRuntimeLogWithAudit(options: {
  vbusCh: WaveformChannel | null;
  vbusConstV: number;
  ibusCh: WaveformChannel;
  currentUnit: ScopeCurrentUnit;
  speedCh: WaveformChannel | null;
  speedConstRpm: number;
  speedUnit: ScopeSpeedUnit;
  polePairs: number;
  maxPoints?: number;
}): ScopeRuntimeExtractionAudit {
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

  const warnings: string[] = [];
  const n = ibusCh.t.length;
  const needsPolePairs = Boolean(speedCh && speedUnit === 'elec_hz');
  if (!Number.isInteger(maxPoints) || maxPoints < 2 || (needsPolePairs && (!Number.isInteger(polePairs) || polePairs < 1))) {
    return { rows: [], warnings: [needsPolePairs ? 'maxPoints 必须为不小于 2 的整数，电频率换算所需 polePairs 必须为正整数。' : 'maxPoints 必须为不小于 2 的整数。'], vbusScaleV: 1, ibusScaleA: 1, isMonotonic: false };
  }
  const pointLimit = Math.floor(maxPoints);
  if (!vbusCh && (!Number.isFinite(vbusConstV) || vbusConstV <= 0)) {
    return { rows: [], warnings: ['固定母线电压必须为有限正数。'], vbusScaleV: 1, ibusScaleA: currentUnit === 'mA' ? 1e-3 : 1, isMonotonic: false };
  }
  if (!speedCh && !Number.isFinite(speedConstRpm)) {
    return { rows: [], warnings: ['固定转速必须为有限数值。'], vbusScaleV: 1, ibusScaleA: currentUnit === 'mA' ? 1e-3 : 1, isMonotonic: false };
  }

  const acI = ibusCh.coupling === 'AC' ? computeChannelMean(ibusCh) : 0;
  const acV = vbusCh && vbusCh.coupling === 'AC' ? computeChannelMean(vbusCh) : 0;
  const acSpd = speedCh && speedCh.coupling === 'AC' ? computeChannelMean(speedCh) : 0;
  const iScale = currentUnit === 'mA' ? 1e-3 : 1;
  const p = needsPolePairs ? polePairs : 1;

  const ibusError = validateScopeSourceChannel(ibusCh, 'Ibus', acI);
  if (ibusError) {
    return { rows: [], warnings: [ibusError], vbusScaleV: 1, ibusScaleA: iScale, isMonotonic: false };
  }
  if (vbusCh) {
    const vbusError = validateScopeSourceChannel(vbusCh, 'Vbus', acV);
    if (vbusError) return { rows: [], warnings: [vbusError], vbusScaleV: 1, ibusScaleA: iScale, isMonotonic: false };
  }
  if (speedCh) {
    const speedError = validateScopeSourceChannel(speedCh, 'Speed', acSpd);
    if (speedError) return { rows: [], warnings: [speedError], vbusScaleV: 1, ibusScaleA: iScale, isMonotonic: false };
  }

  // Reject irregular internal acquisition gaps before interpolating Vbus/Speed
  // onto the Ibus master timebase. Regular channels may have different nominal
  // sampling rates; only anomalously large gaps relative to their own median dt
  // are blocked.
  const gapChecks: Array<[WaveformChannel, string]> = [[ibusCh, 'Ibus']];
  if (vbusCh) gapChecks.push([vbusCh, 'Vbus']);
  if (speedCh) gapChecks.push([speedCh, 'Speed']);
  for (const [channel, label] of gapChecks) {
    const gaps = inspectChannelSamplingGaps(channel.t, 0, channel.t.length - 1, 3.5);
    if (gaps.gapCount > 0) {
      return {
        rows: [],
        warnings: [`${label} 时间轴检测到 ${gaps.gapCount} 个内部采样缺口，最大间隔为 ${(gaps.maxGapSec * 1e3).toFixed(3)}ms（本通道中位采样间隔的 ${gaps.maxGapRatio.toFixed(1)} 倍）；DynoLab 不跨缺口插值或生成运行日志，请裁剪缺口或重新采集。`],
        vbusScaleV: 1,
        ibusScaleA: iScale,
        isMonotonic: true,
      };
    }
  }

  let vbusScaleV = 1;
  if (vbusCh) {
    try {
      vbusScaleV = parseSiUnitScale(vbusCh.unit, 'V', vbusCh.name);
    } catch (err: any) {
      return { rows: [], warnings: [err?.message || `Vbus 通道单位 "${vbusCh.unit}" 非标准电压单位。`], vbusScaleV: 1, ibusScaleA: iScale, isMonotonic: false };
    }
  }

  const tbI = inspectTimebase(ibusCh.t);
  const ibusStart = ibusCh.t[0];
  const ibusEnd = ibusCh.t[n - 1];
  if (vbusCh && (vbusCh.t[0] > ibusStart || vbusCh.t[vbusCh.t.length - 1] < ibusEnd)) {
    return { rows: [], warnings: ['Vbus 时间范围未完整覆盖 Ibus，不能进行端点外推；请裁剪到共同时间窗或重新导入。'], vbusScaleV, ibusScaleA: iScale, isMonotonic: tbI.monotonic };
  }
  if (speedCh && (speedCh.t[0] > ibusStart || speedCh.t[speedCh.t.length - 1] < ibusEnd)) {
    return { rows: [], warnings: ['Speed 时间范围未完整覆盖 Ibus，不能进行端点外推；请裁剪到共同时间窗或重新导入。'], vbusScaleV, ibusScaleA: iScale, isMonotonic: tbI.monotonic };
  }

  const convertSpeedToRpm = (val: number): number => {
    if (speedUnit === 'rad_s') return (val * 60) / (2 * Math.PI);
    if (speedUnit === 'elec_hz') return (val * 60) / p;
    return val;
  };
  const indices: number[] = [];
  if (n <= pointLimit) {
    for (let i = 0; i < n; i++) indices.push(i);
  } else {
    // Downsample against every signal that will be consumed downstream. Using
    // Ibus-only extrema can erase a Vbus sag or RPM transient even though the
    // retained row is later treated as a complete synchronized operating point.
    const signals: Array<{ channel: WaveformChannel; acOffset: number }> = [
      { channel: ibusCh, acOffset: acI },
    ];
    if (vbusCh) signals.push({ channel: vbusCh, acOffset: acV });
    if (speedCh) signals.push({ channel: speedCh, acOffset: acSpd });
    const minRequiredPoints = Math.max(2, signals.length * 2);
    if (pointLimit < minRequiredPoints) {
      return {
        rows: [],
        warnings: [`maxPoints=${pointLimit} 不足以保留 ${signals.length} 个运行信号的峰/谷特征；请至少设置为 ${minRequiredPoints}。`],
        vbusScaleV: 1,
        ibusScaleA: iScale,
        isMonotonic: tbI.monotonic,
      };
    }
    const buckets = Math.max(1, Math.floor(pointLimit / (2 * signals.length)));
    const selected = new Set<number>();
    let nonCoincidentExtremaCount = 0;
    const nearestIbusIndex = (queryTime: number): number => {
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ibusCh.t[mid] < queryTime) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0 && Math.abs(ibusCh.t[lo - 1] - queryTime) <= Math.abs(ibusCh.t[lo] - queryTime)) return lo - 1;
      return lo;
    };
    for (let b = 0; b < buckets; b++) {
      const start = Math.floor((b * n) / buckets);
      const end = Math.min(n, Math.floor(((b + 1) * n) / buckets));
      if (start >= end) continue;
      const bucketStartTime = ibusCh.t[start];
      const bucketEndTime = ibusCh.t[end - 1];
      for (const signal of signals) {
        let minIdx = -1;
        let maxIdx = -1;
        let minVal = Infinity;
        let maxVal = -Infinity;
        // Search the signal's own time/value arrays. Different channels are
        // allowed to have different lengths and sampling intervals.
        for (let j = 0; j < signal.channel.t.length; j++) {
          const signalTime = signal.channel.t[j];
          if (signalTime < bucketStartTime || signalTime > bucketEndTime) continue;
          const val = getChannelDisplayValue(signal.channel, j, signal.acOffset);
          if (!Number.isFinite(val)) continue;
          if (val < minVal) { minVal = val; minIdx = j; }
          if (val > maxVal) { maxVal = val; maxIdx = j; }
        }
        for (const sourceIdx of [minIdx, maxIdx]) {
          if (sourceIdx < 0) continue;
          const sourceTime = signal.channel.t[sourceIdx];
          const targetIdx = nearestIbusIndex(sourceTime);
          if (ibusCh.t[targetIdx] !== sourceTime) nonCoincidentExtremaCount++;
          selected.add(targetIdx);
        }
      }
    }
    indices.push(...Array.from(selected).sort((a, b) => a - b));
    if (indices.length > pointLimit) {
      // Bucket arithmetic should keep this bounded; fail closed if future
      // changes violate the public maxPoints contract.
      return {
        rows: [],
        warnings: [`多通道峰谷抽样产生 ${indices.length} 点，超过 maxPoints=${pointLimit}；已拒绝生成截断运行日志。`],
        vbusScaleV: 1,
        ibusScaleA: iScale,
        isMonotonic: tbI.monotonic,
      };
    }
    warnings.push(`运行日志已按 Ibus${vbusCh ? '、Vbus' : ''}${speedCh ? '、Speed' : ''} 各通道峰/谷联合降采样；保留 ${indices.length}/${n} 个 Ibus 时间点。`);
    if (nonCoincidentExtremaCount > 0) warnings.push(`有 ${nonCoincidentExtremaCount} 个 Vbus/Speed 峰谷发生在 Ibus 采样时刻之间，已映射到最近 Ibus 时间点并按时间戳插值取值；窄脉冲可能被低估，请提高 Ibus 采样率或在共同采集时钟下同步采样。`);
  }

  const sameVbusTimebase = Boolean(vbusCh && areTimebasesSynchronized(ibusCh.t, vbusCh.t));
  const sameSpeedTimebase = Boolean(speedCh && areTimebasesSynchronized(ibusCh.t, speedCh.t));
  if (vbusCh && !sameVbusTimebase) {
    warnings.push(`Vbus (${vbusCh.name}) 与 Ibus 时间轴不完全一致，已在共同覆盖区间内按相邻原始点线性插值对齐。`);
  }
  if (speedCh && !sameSpeedTimebase) {
    warnings.push(`Speed (${speedCh.name}) 与 Ibus 时间轴不完全一致，已在共同覆盖区间内按相邻原始点线性插值对齐。`);
  }

  const rows: RawRuntimeLogEntry[] = [];
  for (const i of indices) {
    const t = ibusCh.t[i];
    const iVal = getChannelDisplayValue(ibusCh, i, acI) * iScale;
    const vRaw = !vbusCh
      ? vbusConstV
      : sameVbusTimebase
      ? getChannelDisplayValue(vbusCh, i, acV)
      : sampleChannelAtTime(vbusCh, t, acV);
    const vVal = !vbusCh ? vRaw : vRaw * vbusScaleV;
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

  return {
    rows,
    warnings,
    vbusScaleV,
    ibusScaleA: iScale,
    isMonotonic: tbI.monotonic,
  };
}

/**
 * Extracts runtime log rows directly from active Oscilloscope channels with explicit unit conversions
 * and timestamp-aligned interpolation across channels + multi-signal peak/valley bucket downsampling
 * (Ibus, Vbus and Speed all contribute extrema; retained runtime rows stay on the Ibus master clock).
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
  return extractRuntimeLogWithAudit(options).rows;
}
