/**
 * Waveform Viewer Pro - Dynamic Safe Operating Area (SOA) Engine
 * Evaluates instantaneous (|Vds|, |Id|, pulseWidth) stress trajectories against
 * multi-pulse-width log-log MOSFET SOA boundaries with safety margins & fault jump.
 */

import { WaveformChannel } from '../types/models';
import { computeChannelMean, getChannelDisplayValue } from './oscilloscopeScale';
import { parseSiUnitScale } from './thermalEngine';

export type SoaPulseKey = 'DC' | '10ms' | '1ms' | '100us' | '10us';

export interface SoaPoint {
  vds: number;
  id: number;
}

export interface SoaCurveSet {
  id: string;
  name: string;
  vdsMaxRated: number;
  isCustom?: boolean;
  curves: Record<SoaPulseKey, SoaPoint[]>;
}

const CUSTOM_SOA_STORAGE_KEY = 'wvpro_custom_soa_devices_v1';

export function cloneSoaPreset(preset: SoaCurveSet): SoaCurveSet {
  const curves = {} as Record<SoaPulseKey, SoaPoint[]>;
  (Object.keys(preset.curves) as SoaPulseKey[]).forEach((k) => {
    curves[k] = preset.curves[k].map((pt) => ({ ...pt }));
  });
  return {
    id: preset.id,
    name: preset.name,
    vdsMaxRated: preset.vdsMaxRated,
    isCustom: preset.isCustom,
    curves,
  };
}

export function loadCustomSoaPresets(): SoaCurveSet[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(CUSTOM_SOA_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((d) => d && typeof d.id === 'string' && typeof d.name === 'string' && d.curves)
      .map((d) => ({
        ...cloneSoaPreset(d),
        isCustom: true,
      }));
  } catch {
    return [];
  }
}

export function saveCustomSoaPresets(customList: SoaCurveSet[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const clean = customList.map((d) => ({
      ...cloneSoaPreset(d),
      isCustom: true,
    }));
    localStorage.setItem(CUSTOM_SOA_STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Ignore storage quota errors cleanly
  }
}

export function getAllSoaPresets(extraCustom?: SoaCurveSet[]): SoaCurveSet[] {
  const custom = extraCustom ?? loadCustomSoaPresets();
  return [...SOA_PRESETS.map((p) => ({ ...cloneSoaPreset(p), isCustom: false })), ...custom];
}

export function addOrUpdateCustomSoaPreset(
  device: SoaCurveSet,
  existingCustom?: SoaCurveSet[]
): { list: SoaCurveSet[]; saved: SoaCurveSet } {
  const list = (existingCustom ?? loadCustomSoaPresets()).map((d) => cloneSoaPreset(d));
  const cleanId =
    device.id && !SOA_PRESETS.some((p) => p.id === device.id)
      ? device.id
      : `custom_soa_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const saved: SoaCurveSet = {
    ...cloneSoaPreset(device),
    id: cleanId,
    name: (device.name || 'Custom MOSFET').trim(),
    vdsMaxRated: Math.max(1, Number(device.vdsMaxRated) || 60),
    isCustom: true,
  };
  const idx = list.findIndex((d) => d.id === cleanId);
  if (idx >= 0) {
    list[idx] = saved;
  } else {
    list.push(saved);
  }
  saveCustomSoaPresets(list);
  return { list, saved };
}

export function deleteCustomSoaPreset(id: string, existingCustom?: SoaCurveSet[]): SoaCurveSet[] {
  const list = (existingCustom ?? loadCustomSoaPresets()).filter((d) => d.id !== id);
  saveCustomSoaPresets(list);
  return list;
}

export const PULSE_DURATIONS_SEC: Record<SoaPulseKey, number> = {
  DC: 1.0,
  '10ms': 1e-2,
  '1ms': 1e-3,
  '100us': 1e-4,
  '10us': 1e-5,
};

export const SOA_PRESETS: SoaCurveSet[] = [
  {
    id: 'mos_60v_80a',
    name: '60V / 80A BLDC Power MOSFET (e.g. IPT015N06)',
    vdsMaxRated: 60,
    curves: {
      DC: [
        { vds: 0.2, id: 80 },
        { vds: 1.5, id: 80 },
        { vds: 10, id: 16 },
        { vds: 60, id: 1.8 },
      ],
      '10ms': [
        { vds: 0.3, id: 140 },
        { vds: 2.0, id: 140 },
        { vds: 10, id: 42 },
        { vds: 60, id: 5.5 },
      ],
      '1ms': [
        { vds: 0.4, id: 240 },
        { vds: 3.0, id: 240 },
        { vds: 15, id: 75 },
        { vds: 60, id: 18 },
      ],
      '100us': [
        { vds: 0.5, id: 320 },
        { vds: 4.0, id: 320 },
        { vds: 20, id: 145 },
        { vds: 60, id: 52 },
      ],
      '10us': [
        { vds: 0.5, id: 380 },
        { vds: 6.0, id: 380 },
        { vds: 30, id: 220 },
        { vds: 60, id: 120 },
      ],
    },
  },
  {
    id: 'mos_100v_120a',
    name: '100V / 120A Inverter MOSFET (e.g. IPT020N10)',
    vdsMaxRated: 100,
    curves: {
      DC: [
        { vds: 0.3, id: 120 },
        { vds: 2.0, id: 120 },
        { vds: 15, id: 20 },
        { vds: 100, id: 2.2 },
      ],
      '10ms': [
        { vds: 0.4, id: 200 },
        { vds: 3.0, id: 200 },
        { vds: 20, id: 48 },
        { vds: 100, id: 7.5 },
      ],
      '1ms': [
        { vds: 0.5, id: 320 },
        { vds: 5.0, id: 320 },
        { vds: 30, id: 90 },
        { vds: 100, id: 24 },
      ],
      '100us': [
        { vds: 0.5, id: 420 },
        { vds: 8.0, id: 420 },
        { vds: 40, id: 170 },
        { vds: 100, id: 68 },
      ],
      '10us': [
        { vds: 0.5, id: 480 },
        { vds: 12.0, id: 480 },
        { vds: 50, id: 280 },
        { vds: 100, id: 160 },
      ],
    },
  },
  {
    id: 'mos_40v_150a',
    name: '40V / 150A Low-Rds Automotive MOSFET',
    vdsMaxRated: 40,
    curves: {
      DC: [
        { vds: 0.2, id: 150 },
        { vds: 1.5, id: 150 },
        { vds: 10, id: 28 },
        { vds: 40, id: 5.0 },
      ],
      '10ms': [
        { vds: 0.3, id: 240 },
        { vds: 2.0, id: 240 },
        { vds: 12, id: 62 },
        { vds: 40, id: 14 },
      ],
      '1ms': [
        { vds: 0.4, id: 360 },
        { vds: 3.0, id: 360 },
        { vds: 15, id: 115 },
        { vds: 40, id: 40 },
      ],
      '100us': [
        { vds: 0.4, id: 480 },
        { vds: 4.0, id: 480 },
        { vds: 20, id: 210 },
        { vds: 40, id: 105 },
      ],
      '10us': [
        { vds: 0.5, id: 560 },
        { vds: 6.0, id: 560 },
        { vds: 25, id: 320 },
        { vds: 40, id: 210 },
      ],
    },
  },
];

/**
 * Log-log piecewise interpolation of Id_max at a single voltage along one pulse curve.
 */
export function interpolateSoaCurveAtVds(points: SoaPoint[], vdsAbs: number): number {
  const sorted = [...points].filter((p) => p.vds > 0 && p.id > 0).sort((a, b) => a.vds - b.vds);
  if (sorted.length === 0) return Infinity;
  const v = Math.max(1e-4, vdsAbs);
  if (v <= sorted[0].vds) return sorted[0].id;
  if (v >= sorted[sorted.length - 1].vds) return sorted[sorted.length - 1].id;

  const lv = Math.log10(v);
  for (let i = 0; i < sorted.length - 1; i++) {
    const p0 = sorted[i];
    const p1 = sorted[i + 1];
    if (v >= p0.vds && v <= p1.vds) {
      const l0 = Math.log10(p0.vds);
      const l1 = Math.log10(p1.vds);
      const frac = Math.abs(l1 - l0) > 1e-12 ? (lv - l0) / (l1 - l0) : 0;
      const lid = Math.log10(p0.id) + frac * (Math.log10(p1.id) - Math.log10(p0.id));
      return Math.pow(10, lid);
    }
  }
  return sorted[sorted.length - 1].id;
}

/**
 * Computes interpolated maximum allowable drain current Id_max(|Vds|, pulseWidthSec)
 * across adjacent pulse-width SOA curves on log-log axes.
 */
export function getSoaMaxId(curveSet: SoaCurveSet, vdsAbs: number, pulseWidthSec: number): number {
  if (vdsAbs > curveSet.vdsMaxRated) return 0; // Avalanche / BVDSS violation

  const keys: SoaPulseKey[] = ['10us', '100us', '1ms', '10ms', 'DC'];
  const dur = Math.max(1e-5, Math.min(1.0, pulseWidthSec));
  if (dur <= PULSE_DURATIONS_SEC['10us']) return interpolateSoaCurveAtVds(curveSet.curves['10us'], vdsAbs);
  if (dur >= PULSE_DURATIONS_SEC['DC']) return interpolateSoaCurveAtVds(curveSet.curves['DC'], vdsAbs);

  const lDur = Math.log10(dur);
  for (let i = 0; i < keys.length - 1; i++) {
    const kLo = keys[i];
    const kHi = keys[i + 1];
    const dLo = PULSE_DURATIONS_SEC[kLo];
    const dHi = PULSE_DURATIONS_SEC[kHi];
    if (dur >= dLo && dur <= dHi) {
      const frac = (lDur - Math.log10(dLo)) / (Math.log10(dHi) - Math.log10(dLo));
      const idLo = interpolateSoaCurveAtVds(curveSet.curves[kLo], vdsAbs);
      const idHi = interpolateSoaCurveAtVds(curveSet.curves[kHi], vdsAbs);
      const lid = Math.log10(Math.max(1e-6, idLo)) + frac * (Math.log10(Math.max(1e-6, idHi)) - Math.log10(Math.max(1e-6, idLo)));
      return Math.pow(10, lid);
    }
  }
  return interpolateSoaCurveAtVds(curveSet.curves['DC'], vdsAbs);
}

export interface SoaTrajectoryPoint {
  vds: number;
  id: number;
  time: number;
  index: number;
  pulseWidthSec: number;
  limitId: number;
  utilizationPct: number;
  violated: boolean;
}

export interface DynamicSoaResult {
  pass: boolean;
  totalSamples: number;
  violationCount: number;
  maxUtilizationPct: number;
  minMarginPct: number;
  worstIndex: number | null;
  worstTime: number | null;
  worstVds: number;
  worstId: number;
  worstPulseWidthSec: number;
  trajectoryPoints: SoaTrajectoryPoint[];
}

export function evaluateDynamicSoa(
  vdsCh: WaveformChannel,
  idsCh: WaveformChannel,
  curveSet: SoaCurveSet,
  opts?: { tStart?: number; tEnd?: number; forcedPulseKey?: SoaPulseKey | 'auto' }
): DynamicSoaResult {
  const nV = Math.min(vdsCh.t.length, vdsCh.v.length);
  const nI = Math.min(idsCh.t.length, idsCh.v.length);
  if (nV === 0 || nI === 0) {
    return {
      pass: true,
      totalSamples: 0,
      violationCount: 0,
      maxUtilizationPct: 0,
      minMarginPct: 100,
      worstIndex: null,
      worstTime: null,
      worstVds: 0,
      worstId: 0,
      worstPulseWidthSec: 1e-3,
      trajectoryPoints: [],
    };
  }

  let i0 = 0;
  let i1 = nV - 1;
  if (opts?.tStart !== undefined) while (i0 < nV && vdsCh.t[i0] < opts.tStart) i0++;
  if (opts?.tEnd !== undefined) while (i1 > i0 && vdsCh.t[i1] > opts.tEnd) i1--;

  const vScale = parseSiUnitScale(vdsCh.unit, 'V', vdsCh.name);
  const iScale = parseSiUnitScale(idsCh.unit, 'A', idsCh.name);
  const mV = vdsCh.coupling === 'AC' ? computeChannelMean(vdsCh) : 0;
  const mI = idsCh.coupling === 'AC' ? computeChannelMean(idsCh) : 0;

  const sameTimebase =
    nV === nI &&
    (vdsCh.t === idsCh.t ||
      (Math.abs(vdsCh.t[0] - idsCh.t[0]) <= 1e-15 &&
        Math.abs(vdsCh.t[nV >> 1] - idsCh.t[nI >> 1]) <= 1e-15 &&
        Math.abs(vdsCh.t[nV - 1] - idsCh.t[nI - 1]) <= 1e-15));

  const sampleIdsAt = (targetT: number, fallbackIdx: number): number => {
    if (sameTimebase) return getChannelDisplayValue(idsCh, fallbackIdx, mI) * iScale;
    const tArr = idsCh.t;
    if (targetT <= tArr[0]) return getChannelDisplayValue(idsCh, 0, mI) * iScale;
    if (targetT >= tArr[nI - 1]) return getChannelDisplayValue(idsCh, nI - 1, mI) * iScale;
    let lo = 0;
    let hi = nI - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (tArr[mid] <= targetT) lo = mid;
      else hi = mid;
    }
    const dt = tArr[hi] - tArr[lo];
    const frac = dt > 1e-18 ? (targetT - tArr[lo]) / dt : 0;
    const v0 = getChannelDisplayValue(idsCh, lo, mI) * iScale;
    const v1 = getChannelDisplayValue(idsCh, hi, mI) * iScale;
    return v0 + frac * (v1 - v0);
  };

  const len = Math.max(0, i1 - i0 + 1);
  if (len === 0) {
    return {
      pass: true,
      totalSamples: 0,
      violationCount: 0,
      maxUtilizationPct: 0,
      minMarginPct: 100,
      worstIndex: null,
      worstTime: null,
      worstVds: 0,
      worstId: 0,
      worstPulseWidthSec: 1e-3,
      trajectoryPoints: [],
    };
  }

  const vArr = new Float64Array(len);
  const iArr = new Float64Array(len);
  let maxAbsI = 0;
  for (let k = 0; k < len; k++) {
    const idx = i0 + k;
    const vv = getChannelDisplayValue(vdsCh, idx, mV) * vScale;
    const ii = sampleIdsAt(vdsCh.t[idx], idx);
    vArr[k] = isFinite(vv) ? Math.abs(vv) : 0;
    iArr[k] = isFinite(ii) ? Math.abs(ii) : 0;
    if (iArr[k] > maxAbsI) maxAbsI = iArr[k];
  }

  // Estimate contiguous pulse widths where |I| > max(1 mA, 10% peak)
  const activeThreshI = Math.max(1e-3, maxAbsI * 0.1);
  const pulseWidthForIdx = new Float64Array(len);
  const forcedDur =
    opts?.forcedPulseKey && opts.forcedPulseKey !== 'auto'
      ? PULSE_DURATIONS_SEC[opts.forcedPulseKey]
      : null;

  if (forcedDur !== null) {
    pulseWidthForIdx.fill(forcedDur);
  } else {
    let segStart = -1;
    for (let k = 0; k < len; k++) {
      const isAct = iArr[k] >= activeThreshI;
      if (isAct && segStart === -1) segStart = k;
      if ((!isAct || k === len - 1) && segStart !== -1) {
        const endK = isAct ? k : k - 1;
        const dur = Math.max(1e-5, Math.min(1.0, vdsCh.t[i0 + endK] - vdsCh.t[i0 + segStart] || 1e-4));
        for (let s = segStart; s <= endK; s++) pulseWidthForIdx[s] = dur;
        segStart = -1;
      }
      if (!isAct) pulseWidthForIdx[k] = 1e-3;
    }
  }

  let violationCount = 0;
  let maxUtil = 0;
  let worstIndex: number | null = null;
  let worstTime: number | null = null;
  let worstVds = 0;
  let worstId = 0;
  let worstPulse = 1e-3;

  const stride = Math.max(1, Math.floor(len / 900));
  const trajectoryPoints: SoaTrajectoryPoint[] = [];

  for (let k = 0; k < len; k++) {
    const idx = i0 + k;
    const vAbs = vArr[k];
    const iAbs = iArr[k];
    const pw = pulseWidthForIdx[k];
    const limitId = getSoaMaxId(curveSet, vAbs, pw);

    const util = vAbs > curveSet.vdsMaxRated
      ? 100 * (vAbs / Math.max(1e-3, curveSet.vdsMaxRated)) + 100
      : limitId > 1e-9
      ? (iAbs / limitId) * 100
      : iAbs > 0
      ? 999
      : 0;

    const violated = vAbs > curveSet.vdsMaxRated || iAbs > limitId;
    if (violated) violationCount++;

    if (util > maxUtil) {
      maxUtil = util;
      worstIndex = idx;
      worstTime = vdsCh.t[idx];
      worstVds = vAbs;
      worstId = iAbs;
      worstPulse = pw;
    }

    if ((k % stride === 0 || violated || idx === worstIndex) && vAbs > 1e-3 && iAbs > 1e-3) {
      trajectoryPoints.push({
        vds: vAbs,
        id: iAbs,
        time: vdsCh.t[idx],
        index: idx,
        pulseWidthSec: pw,
        limitId,
        utilizationPct: util,
        violated,
      });
    }
  }

  return {
    pass: violationCount === 0,
    totalSamples: len,
    violationCount,
    maxUtilizationPct: maxUtil,
    minMarginPct: 100 - maxUtil,
    worstIndex,
    worstTime,
    worstVds,
    worstId,
    worstPulseWidthSec: worstPulse,
    trajectoryPoints: trajectoryPoints.slice(0, 1200),
  };
}
