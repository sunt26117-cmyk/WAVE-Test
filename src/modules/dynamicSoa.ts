/**
 * Waveform Viewer Pro - Dynamic Safe Operating Area (SOA) Engine
 * Evaluates instantaneous (|Vds|, |Id|, pulseWidth) stress trajectories against
 * multi-pulse-width log-log MOSFET SOA boundaries with safety margins & fault jump.
 */

import { WaveformChannel } from '../types/models';
import { computeChannelMean, getChannelDisplayValue } from './oscilloscopeScale';
import { parseSiUnitScale } from './thermalEngine';
import { areTimebasesSynchronized, inspectChannelSamplingGaps, inspectTimebase, sampleSeriesAtTime } from './timeSync';

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
  const sorted = [...points]
    .filter((p) => Number.isFinite(p?.vds) && Number.isFinite(p?.id) && p.vds > 0 && p.id > 0)
    .sort((a, b) => a.vds - b.vds);
  // An undefined SOA envelope must never be interpreted as unlimited current.
  if (sorted.length < 2 || !Number.isFinite(vdsAbs) || vdsAbs < 0) return Number.NaN;
  for (let i = 1; i < sorted.length; i++) {
    if (!(sorted[i].vds > sorted[i - 1].vds)) return Number.NaN;
  }
  const v = Math.max(1e-4, vdsAbs);
  if (v <= sorted[0].vds) return sorted[0].id;
  // Do not flat-extrapolate the last current limit beyond the datasheet curve.
  if (v > sorted[sorted.length - 1].vds) return Number.NaN;
  if (v === sorted[sorted.length - 1].vds) return sorted[sorted.length - 1].id;

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
  if (!Number.isFinite(vdsAbs) || vdsAbs < 0 || !Number.isFinite(pulseWidthSec) || pulseWidthSec <= 0) {
    return Number.NaN;
  }
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

const SOA_CURVE_KEYS: SoaPulseKey[] = ['DC', '10ms', '1ms', '100us', '10us'];

/**
 * A missing or truncated user-edited SOA curve is a data-integrity failure, not
 * an unlimited-current envelope. Every pulse curve must cover the declared Vds
 * rating so interpolation never silently flat-extrapolates outside source data.
 */
function validateSoaCurveSet(curveSet: SoaCurveSet): string | null {
  if (
    !curveSet ||
    typeof curveSet.name !== 'string' ||
    !Number.isFinite(curveSet.vdsMaxRated) ||
    curveSet.vdsMaxRated <= 0
  ) {
    return 'SOA 器件配置缺少有效名称或 Vds 额定值，已阻止判定。';
  }

  for (const key of SOA_CURVE_KEYS) {
    const points = curveSet.curves?.[key];
    if (!Array.isArray(points) || points.length < 2) {
      return `SOA ${key} 曲线缺失或少于 2 个有效点，不能将缺失边界视为无限安全电流。`;
    }
    const sorted = [...points].sort((a, b) => (a?.vds ?? Infinity) - (b?.vds ?? Infinity));
    for (let i = 0; i < sorted.length; i++) {
      const point = sorted[i];
      if (!Number.isFinite(point?.vds) || !Number.isFinite(point?.id) || point.vds <= 0 || point.id <= 0) {
        return `SOA ${key} 曲线第 ${i + 1} 个点包含非有限或非正 Vds/Ids 数据。`;
      }
      if (i > 0 && !(point.vds > sorted[i - 1].vds)) {
        return `SOA ${key} 曲线存在重复 Vds 坐标，无法进行可靠对数插值。`;
      }
    }
    if (sorted[sorted.length - 1].vds < curveSet.vdsMaxRated * 0.999) {
      return `SOA ${key} 曲线仅覆盖至 ${sorted[sorted.length - 1].vds} V，低于声明的额定电压 ${curveSet.vdsMaxRated} V；禁止在曲线范围外外推。`;
    }
  }
  return null;
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
  status: 'PASS' | 'FAIL' | 'INVALID' | 'INDETERMINATE';
  invalidData: boolean;
  statusReason: string | null;
  totalSamples: number;
  validSampleCount: number;
  invalidSampleCount: number;
  gapCount: number;
  violationCount: number;
  maxUtilizationPct: number;
  minMarginPct: number;
  worstIndex: number | null;
  worstTime: number | null;
  worstVds: number;
  worstId: number;
  worstPulseWidthSec: number;
  trajectoryPoints: SoaTrajectoryPoint[];
  warnings: string[];
}

function buildInvalidSoaResult(reason: string, totalSamples = 0, invalidSampleCount = 0): DynamicSoaResult {
  return {
    pass: false,
    status: 'INVALID',
    invalidData: true,
    statusReason: reason,
    totalSamples,
    validSampleCount: 0,
    invalidSampleCount,
    gapCount: 0,
    violationCount: 0,
    maxUtilizationPct: 0,
    minMarginPct: 0,
    worstIndex: null,
    worstTime: null,
    worstVds: 0,
    worstId: 0,
    worstPulseWidthSec: 1e-3,
    trajectoryPoints: [],
    warnings: [reason],
  };
}

export function evaluateDynamicSoa(
  vdsCh: WaveformChannel,
  idsCh: WaveformChannel,
  curveSet: SoaCurveSet,
  opts?: { tStart?: number; tEnd?: number; forcedPulseKey?: SoaPulseKey | 'auto' }
): DynamicSoaResult {
  const curveError = validateSoaCurveSet(curveSet);
  if (curveError) return buildInvalidSoaResult(`${curveError} SOA 状态：INVALID（禁止放行 PASS）。`);

  if (vdsCh.t.length !== vdsCh.v.length || idsCh.t.length !== idsCh.v.length) {
    return buildInvalidSoaResult('Vds 或 Ids 的时间戳数量与数据点数量不一致，无法确定逐点物理对应关系。');
  }
  const nV = vdsCh.t.length;
  const nI = idsCh.t.length;
  if (nV < 2 || nI < 2) {
    return buildInvalidSoaResult('Vds 或 Ids 有效样本少于 2 点，无法判定 Dynamic SOA。');
  }

  let vScale: number;
  let iScale: number;
  try {
    vScale = parseSiUnitScale(vdsCh.unit, 'V', vdsCh.name, { strict: true });
    iScale = parseSiUnitScale(idsCh.unit, 'A', idsCh.name, { strict: true });
  } catch (error: any) {
    return buildInvalidSoaResult(`Dynamic SOA 单位校验失败：${error?.message || 'Vds 必须为电压、Ids 必须为电流单位。'}`);
  }

  const tbV = inspectTimebase(vdsCh.t, 0, nV - 1);
  const tbI = inspectTimebase(idsCh.t, 0, nI - 1);
  if (!tbV.monotonic || !tbI.monotonic) {
    return buildInvalidSoaResult(
      `时间轴存在非单调递增或 NaN/Inf 时间戳 (${!tbV.monotonic ? vdsCh.name : idsCh.name} @ 索引 ${!tbV.monotonic ? tbV.nonMonotonicIndex : tbI.nonMonotonicIndex})，无法执行可靠 SOA 评估。`
    );
  }

  const overlapStart = Math.max(
    vdsCh.t[0],
    idsCh.t[0],
    opts?.tStart !== undefined && Number.isFinite(opts.tStart) ? opts.tStart : -Infinity
  );
  const overlapEnd = Math.min(
    vdsCh.t[nV - 1],
    idsCh.t[nI - 1],
    opts?.tEnd !== undefined && Number.isFinite(opts.tEnd) ? opts.tEnd : Infinity
  );
  if (!Number.isFinite(overlapStart) || !Number.isFinite(overlapEnd) || overlapEnd < overlapStart) {
    return buildInvalidSoaResult('Vds 与 Ids 在当前门控区间内没有时间重叠区域，无法同步评估 SOA。');
  }

  let i0 = 0;
  let i1 = nV - 1;
  while (i0 < nV && vdsCh.t[i0] < overlapStart) i0++;
  while (i1 > i0 && vdsCh.t[i1] > overlapEnd) i1--;

  const len = Math.max(0, i1 - i0 + 1);
  if (len === 0) {
    return buildInvalidSoaResult('门控区间内没有重叠的 Vds/Ids 有效样本点（INVALID）。');
  }

  const mV = vdsCh.coupling === 'AC' ? computeChannelMean(vdsCh) : 0;
  const mI = idsCh.coupling === 'AC' ? computeChannelMean(idsCh) : 0;
  const sameTimebase = areTimebasesSynchronized(vdsCh.t, idsCh.t);
  const warnings: string[] = [];
  if (!sameTimebase) {
    warnings.push('检测到 Vds 与 Ids 采样时刻未逐点同步，已按真实重叠时间窗逐点线性插值对齐（零外推）。');
  }

  const validIndices: number[] = [];
  const validT: number[] = [];
  const validV: number[] = [];
  const validI: number[] = [];
  let invalidSampleCount = 0;
  let maxAbsI = 0;

  for (let k = 0; k < len; k++) {
    const idx = i0 + k;
    const tVal = vdsCh.t[idx];
    const vv = getChannelDisplayValue(vdsCh, idx, mV) * vScale;
    const iiRaw = sameTimebase
      ? getChannelDisplayValue(idsCh, idx, mI) * iScale
      : sampleSeriesAtTime(idsCh.t, idsCh, tVal, mI) * iScale;

    if (!Number.isFinite(vv) || !Number.isFinite(iiRaw)) {
      invalidSampleCount++;
      continue;
    }

    const vAbs = Math.abs(vv);
    const iAbs = Math.abs(iiRaw);
    validIndices.push(idx);
    validT.push(tVal);
    validV.push(vAbs);
    validI.push(iAbs);
    if (iAbs > maxAbsI) maxAbsI = iAbs;
  }

  let j0 = 0;
  let j1 = nI - 1;
  while (j0 < nI && idsCh.t[j0] < overlapStart) j0++;
  while (j1 > j0 && idsCh.t[j1] > overlapEnd) j1--;
  const vGapRep = inspectChannelSamplingGaps(vdsCh.t, i0, i1);
  const iGapRep = inspectChannelSamplingGaps(idsCh.t, j0, j1);
  const gapCount = vGapRep.gapCount + iGapRep.gapCount;
  if (gapCount > 0) {
    warnings.push(
      `检测到评估门控内存在 ${gapCount} 处采样时间缺口 (最大空窗 ${formatGapSec(Math.max(vGapRep.maxGapSec, iGapRep.maxGapSec))}，约 ${Math.max(vGapRep.maxGapRatio, iGapRep.maxGapRatio).toFixed(1)}× 中位步长)，缺口内尖峰/脉宽无法被直接观测。`
    );
  }

  if (validIndices.length === 0) {
    return buildInvalidSoaResult(
      `门控窗口内全部 ${len} 个样本均为 NaN/Inf 无效测量数据（禁止伪装成 0V/0A 通过 SOA）。`,
      len,
      invalidSampleCount
    );
  }

  if (invalidSampleCount > 0) {
    warnings.push(
      `门控窗口内包含 ${invalidSampleCount}/${len} 个 NaN/Inf 无效样本点，已剔除（缺失区应力未知，不能直接判定安全 PASS）。`
    );
  }

  const validCount = validIndices.length;
  const activeThreshI = Math.max(1e-3, maxAbsI * 0.1);
  const pulseWidthForIdx = new Float64Array(validCount);
  const forcedDur =
    opts?.forcedPulseKey && opts.forcedPulseKey !== 'auto'
      ? PULSE_DURATIONS_SEC[opts.forcedPulseKey]
      : null;

  if (forcedDur !== null) {
    pulseWidthForIdx.fill(forcedDur);
  } else {
    let segStart = -1;
    for (let k = 0; k < validCount; k++) {
      const isAct = validI[k] >= activeThreshI;
      if (isAct && segStart === -1) segStart = k;
      if ((!isAct || k === validCount - 1) && segStart !== -1) {
        const endK = isAct ? k : k - 1;
        const dur = Math.max(1e-5, Math.min(1.0, validT[endK] - validT[segStart] || 1e-4));
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

  const stride = Math.max(1, Math.floor(validCount / 900));
  const trajectoryPoints: SoaTrajectoryPoint[] = [];

  for (let k = 0; k < validCount; k++) {
    const idx = validIndices[k];
    const vAbs = validV[k];
    const iAbs = validI[k];
    const pw = pulseWidthForIdx[k];
    const limitId = getSoaMaxId(curveSet, vAbs, pw);

    if (!Number.isFinite(limitId)) {
      return buildInvalidSoaResult(
        `Vds=${vAbs.toFixed(3)}V 超出当前 SOA 曲线数据覆盖范围，无法建立 Ids 安全上限；禁止外推并判定 PASS。`,
        len,
        invalidSampleCount
      );
    }

    const util =
      vAbs > curveSet.vdsMaxRated
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
      worstTime = validT[k];
      worstVds = vAbs;
      worstId = iAbs;
      worstPulse = pw;
    }

    if ((k % stride === 0 || violated || idx === worstIndex) && vAbs > 1e-3 && iAbs > 1e-3) {
      trajectoryPoints.push({
        vds: vAbs,
        id: iAbs,
        time: validT[k],
        index: idx,
        pulseWidthSec: pw,
        limitId,
        utilizationPct: util,
        violated,
      });
    }
  }

  const hasCoverageUncertainty = invalidSampleCount > 0 || gapCount > 0;
  const status: DynamicSoaResult['status'] =
    violationCount > 0 ? 'FAIL' : hasCoverageUncertainty ? 'INDETERMINATE' : 'PASS';
  const pass = status === 'PASS';
  const statusReason =
    status === 'INDETERMINATE'
      ? `评估区间存在 ${invalidSampleCount} 个无效点 (NaN/Inf) 与 ${gapCount} 处采样缺口，可能遗漏瞬态 Vds/Ids 峰值或畸变脉宽，判定为 INDETERMINATE（禁止放行 PASS）。`
      : null;

  return {
    pass,
    status,
    invalidData: hasCoverageUncertainty,
    statusReason,
    totalSamples: len,
    validSampleCount: validCount,
    invalidSampleCount,
    gapCount,
    violationCount,
    maxUtilizationPct: maxUtil,
    minMarginPct: 100 - maxUtil,
    worstIndex,
    worstTime,
    worstVds,
    worstId,
    worstPulseWidthSec: worstPulse,
    trajectoryPoints: trajectoryPoints.slice(0, 1200),
    warnings,
  };
}

function formatGapSec(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0s';
  if (sec < 1e-6) return `${(sec * 1e9).toFixed(1)}ns`;
  if (sec < 1e-3) return `${(sec * 1e6).toFixed(2)}µs`;
  if (sec < 1) return `${(sec * 1e3).toFixed(2)}ms`;
  return `${sec.toFixed(3)}s`;
}
