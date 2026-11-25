/**
 * FOC DynoLab V2 - Stepwise Dyno Calibration & 2D Efficiency Map Reconstruction
 * Supports Excel (.xlsx/.xls) & CSV ingestion, automatic column/unit detection,
 * cross-validation warnings (T*omega_m vs P_out, % vs 0-1), and anti-overfitting Rs anchoring.
 */

import * as XLSX from 'xlsx';
import {
  MotorParams,
  calcKeFromKv,
  calcKeFromNoLoad,
  calcOmegaM,
  calcP0LossW,
  calcRsAnchorOhm,
  forwardVerifyPoint,
  solveSinglePoint,
} from './motorPhysics';

export type TorqueUnit = 'Nm' | 'mNm' | 'kgf_cm';
export type EfficiencyFormat = '0-1' | 'percent';
export type RsFitMode = 'locked' | 'bounded_15pct';
export type KeSourceMode = 'open_loop_auto' | 'manual_n0_vtest' | 'manual_kv';

export interface TabularDataset {
  headers: string[];
  rows: Array<Record<string, unknown>>;
  fileName: string;
}

export interface DynoColumnMapping {
  n_rpm: string;
  T_Nm: string;
  V_bus: string;
  I_bus: string;
  P_in: string;
  P_out: string;
  eta: string;
}

export interface NormalizedDynoPoint {
  nRpm: number;
  tNm: number;
  vBusV: number;
  iBusA: number;
  pInW: number;
  pOutW: number;
  etaMeas: number;
}

export interface EvaluatedDynoPoint extends NormalizedDynoPoint {
  iqEstA: number;
  tEstNm: number;
  pOutEstW: number;
  etaEst: number;
  pInvLossW: number;
  pCuLossW: number;
  pIronWindLossW: number;
  errTorqueNm: number;
  errEta: number;
}

export interface ErrorMetrics {
  maeTorqueNm: number;
  rmseTorqueNm: number;
  mapeTorquePct: number;
  maeEtaPct: number;
  rmseEtaPct: number;
  mapeEtaPct: number;
}

export interface EfficiencyGrid2D {
  speeds: number[];
  torques: number[];
  zMeasured: Array<Array<number | null>>;
  zPredicted: Array<Array<number | null>>;
  minEta: number;
  maxEta: number;
  warning?: string;
}

export interface CalibrationValidationMetrics {
  holdoutCount: number;
  trainCount: number;
  fitSource: 'train_only';
  valMaeTorqueNm: number;
  validHoldoutCount: number;
  validHoldoutEtaCount: number;
  valMapeTorquePct: number;
  valMaeEtaPct: number;
}

export interface OperatingEnvelopeBounds {
  minRpm: number;
  maxRpm: number;
  minTorqueNm: number;
  maxTorqueNm: number;
  minVbusV: number;
  maxVbusV: number;
}

export interface CalibrationSensitivity {
  rsPlus10PctDeltaMaeNm: number;
  kePlus5PctDeltaMaeNm: number;
}

export type CalibrationStatus = 'ok' | 'warn' | 'failed';

export interface CalibrationReport {
  status: CalibrationStatus;
  warnings: string[];
  kePrime: number;
  n0Rpm: number;
  p0A: number;
  p0B: number;
  betaSat: number;
  rsAnchorOhm: number;
  rsEffOhm: number;
  rsFitMode: RsFitMode;
  evaluatedPoints: EvaluatedDynoPoint[];
  metrics: ErrorMetrics;
  validationMetrics?: CalibrationValidationMetrics;
  operatingEnvelope?: OperatingEnvelopeBounds;
  paramSensitivity?: CalibrationSensitivity;
  grid2D: EfficiencyGrid2D;
  fitNotes: string[];
}

export type ElectricalHeaderUnitFamily = 'voltage' | 'current' | 'speed';
export interface HeaderEngineeringScale {
  scale: number;
  unit: string | null;
  invalidToken: string | null;
}

/** Converts common engineering units stated in a dyno column header to V/A/RPM. */
export function detectHeaderEngineeringScale(
  header: string,
  family: ElectricalHeaderUnitFamily
): HeaderEngineeringScale {
  const raw = (header || '').trim();
  const bracket = raw.match(/[\(\[\{（]\s*([^\)\]\}）]+?)\s*[\)\]\}）]/);
  const suffix = raw.match(/(?:^|[_\s])(krpm|rpm|r\s*\/\s*min|rad\s*\/\s*s|rad_s|mV|kV|uV|µV|μV|V|mA|kA|uA|µA|μA|A)$/i);
  const token = (bracket?.[1] || suffix?.[1] || '').trim();
  if (!token) return { scale: 1, unit: null, invalidToken: null };
  const unit = token.toLowerCase().replace(/[\s_]/g, '');

  if (family === 'voltage') {
    if (['v', 'volt', 'volts'].includes(unit)) return { scale: 1, unit: token, invalidToken: null };
    if (['mv', 'millivolt', 'millivolts'].includes(unit)) return { scale: 1e-3, unit: token, invalidToken: null };
    if (['kv', 'kilovolt', 'kilovolts'].includes(unit)) return { scale: 1e3, unit: token, invalidToken: null };
    if (['uv', 'µv', 'μv', 'microvolt', 'microvolts'].includes(unit)) return { scale: 1e-6, unit: token, invalidToken: null };
  } else if (family === 'current') {
    if (['a', 'amp', 'amps', 'ampere', 'amperes'].includes(unit)) return { scale: 1, unit: token, invalidToken: null };
    if (['ma', 'milliamp', 'milliamps', 'milliampere', 'milliamperes'].includes(unit)) return { scale: 1e-3, unit: token, invalidToken: null };
    if (['ka', 'kiloamp', 'kiloamps'].includes(unit)) return { scale: 1e3, unit: token, invalidToken: null };
    if (['ua', 'µa', 'μa', 'microamp', 'microamps'].includes(unit)) return { scale: 1e-6, unit: token, invalidToken: null };
  } else {
    if (['rpm', 'r/min', 'rev/min'].includes(unit)) return { scale: 1, unit: token, invalidToken: null };
    if (['krpm'].includes(unit)) return { scale: 1e3, unit: token, invalidToken: null };
    if (['rad/s', 'rad/sec'].includes(unit)) return { scale: 60 / (2 * Math.PI), unit: token, invalidToken: null };
  }

  // A bracketed/suffixed token was explicitly supplied but is not safely
  // convertible. Do not silently reinterpret e.g. electrical Hz as mechanical RPM.
  return { scale: 1, unit: token, invalidToken: token };
}

export function torqueToNm(val: number, unit: TorqueUnit): number {
  if (!Number.isFinite(val)) return Number.NaN;
  if (unit === 'mNm') return val * 1e-3;
  if (unit === 'kgf_cm') return val * 0.0980665;
  return val;
}

export function detectHeaderTorqueUnit(torqueColName: string): TorqueUnit | null {
  const lower = torqueColName.toLowerCase();
  if (!lower) return null;
  if (lower.includes('mnm') || lower.includes('mn·m') || lower.includes('mn-m')) return 'mNm';
  if (lower.includes('kgf') || lower.includes('kg.cm') || lower.includes('kg·cm')) return 'kgf_cm';
  if (lower.includes('nm') || lower.includes('n·m') || lower.includes('n-m')) return 'Nm';
  return null;
}

export function detectHeaderEtaFormat(etaColName: string, rows: Array<Record<string, unknown>>): EfficiencyFormat | null {
  const lower = etaColName.toLowerCase();
  if (!lower) return null;
  if (lower.includes('%') || lower.includes('pct') || lower.includes('percent')) return 'percent';
  const vals: number[] = [];
  for (let i = 0; i < Math.min(rows.length, 50); i++) {
    const v = Number(rows[i]?.[etaColName]);
    if (Number.isFinite(v)) vals.push(v);
  }
  if (vals.length > 0 && Math.max(...vals) > 1.05) return 'percent';
  return null;
}

export function detectHeaderPowerScaleW(colName: string): { scaleW: number; invalidToken: string | null } {
  const raw = (colName || '').trim();
  if (!raw) return { scaleW: 1, invalidToken: null };
  const br = raw.match(/[\(\[\{（]\s*([^\)\]\}）]+?)\s*[\)\]\}）]/);
  const tok = br ? br[1].trim() : '';
  const parsePow = (t: string): number | null => {
    if (!t) return null;
    if (/^(?:W|watt|watts)$/i.test(t)) return 1;
    if (/^(?:kW|kilowatt|kilowatts)$/i.test(t)) return 1e3;
    if (/^(?:TW|terawatt|terawatts)$/.test(t) || /^(?:terawatt|terawatts)$/i.test(t)) return 1e12;
    if (/^(?:GW|gigawatt|gigawatts)$/.test(t) || /^(?:gigawatt|gigawatts)$/i.test(t)) return 1e9;
    if (/^(?:MW|megawatt|megawatts)$/.test(t) || /^(?:megawatt|megawatts)$/i.test(t)) return 1e6;
    if (/^(?:mW|mw|milliwatt|milliwatts)$/.test(t)) return 1e-3;
    if (/^(?:uW|µW|μW|uw|µw|μw|microwatt|microwatts)$/i.test(t)) return 1e-6;
    return null;
  };
  if (tok) {
    const sc = parsePow(tok);
    return sc !== null ? { scaleW: sc, invalidToken: null } : { scaleW: 1, invalidToken: tok };
  }
  // Recognize explicit power-unit suffixes regardless of capitalization where
  // SI meaning is unambiguous (kw => kW, mw => mW). Keep uppercase MW distinct
  // from lowercase mw. Reject explicit but unsupported units such as hp/VA;
  // otherwise a header like P_in_hp would silently be treated as watts.
  const sfx = raw.match(/(?:^|[_\s])([A-Za-zµμ]+)$/);
  if (sfx) {
    const suffixToken = sfx[1];
    const suffixKey = suffixToken.toLowerCase();
    const explicitPowerSuffixes = new Set([
      'w', 'kw', 'mw', 'gw', 'tw', 'uw', 'µw', 'μw',
      'watt', 'watts', 'kilowatt', 'kilowatts', 'megawatt', 'megawatts', 'gigawatt', 'gigawatts',
      'milliwatt', 'milliwatts', 'microwatt', 'microwatts',
      'hp', 'horsepower', 'ps', 'va', 'kva', 'mva', 'dbm',
      'wh', 'kwh', 'mwh', 'gwh', 'j', 'kj', 'mj', 'gj',
    ]);
    if (explicitPowerSuffixes.has(suffixKey)) {
      const sc = parsePow(suffixToken);
      return sc !== null ? { scaleW: sc, invalidToken: null } : { scaleW: 1, invalidToken: suffixToken };
    }
  }
  return { scaleW: 1, invalidToken: null };
}

function parsePowerCellW(raw: unknown, defaultScaleW: number): number {
  if (raw === null || raw === undefined || typeof raw === 'boolean') return Number.NaN;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw * defaultScaleW : Number.NaN;
  const s = String(raw).trim();
  if (!s) return Number.NaN;
  const num = Number(s);
  if (Number.isFinite(num)) return num * defaultScaleW;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(TW|GW|kW|MW|mW|uW|µW|μW|W)$/i.exec(s);
  if (m) {
    const v = Number(m[1]);
    if (!Number.isFinite(v)) return Number.NaN;
    const u = m[2];
    if (/^tw$/i.test(u)) return v * 1e12;
    if (/^gw$/i.test(u)) return v * 1e9;
    if (/^kw$/i.test(u)) return v * 1e3;
    if (u === 'MW') return v * 1e6;
    if (/^mw$/i.test(u)) return v * 1e-3;
    if (/^[uµμ]w$/i.test(u)) return v * 1e-6;
    return v;
  }
  return Number.NaN;
}

export function parseCsvText(csvText: string, fileName = 'data.csv'): TabularDataset {
  const lines = csvText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  if (lines.length === 0) {
    return { headers: [], rows: [], fileName };
  }

  const splitLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };

  const headers = splitLine(lines[0]).map((h) => h.replace(/^\uFEFF/, ''));
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const rec: Record<string, unknown> = {};
    headers.forEach((h, idx) => {
      const raw = cells[idx] ?? '';
      const num = Number(raw);
      rec[h] = raw !== '' && Number.isFinite(num) ? num : raw;
    });
    rows.push(rec);
  }

  return { headers, rows, fileName };
}

export async function parseSpreadsheetFile(file: File): Promise<TabularDataset> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    const text = await file.text();
    return parseCsvText(text, file.name);
  }
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
  const headers = json.length > 0 ? Object.keys(json[0]) : [];
  return { headers, rows: json, fileName: file.name };
}

export function autoMapColumns(headers: string[]): DynoColumnMapping {
  const findCol = (patterns: RegExp[]): string => {
    for (const p of patterns) {
      const match = headers.find((h) => p.test(h.toLowerCase()));
      if (match) return match;
    }
    return '';
  };

  return {
    n_rpm: findCol([/^n_?rpm$/, /rpm/, /speed/, /转速/]),
    T_Nm: findCol([/^t_?nm$/, /^t_?mnm$/, /torque/, /^t_load$/, /^trq$/, /扭矩/, /转矩/]),
    V_bus: findCol([/^v_?bus$/, /v_?meas/, /vbus/, /voltage/, /电压/]),
    I_bus: findCol([/^i_?bus$/, /ibus/, /current/, /电流/]),
    P_in: findCol([/^p_?in/, /pin/, /input.?power/, /输入功率/]),
    P_out: findCol([/^p_?out/, /pout/, /mech.?power/, /输出功率/]),
    eta: findCol([/^eta/, /eff/, /效率/]),
  };
}

export interface NormalizedDynoResult {
  points: NormalizedDynoPoint[];
  warnings: string[];
}

export function normalizeDynoDataset(
  dataset: TabularDataset,
  mapping: DynoColumnMapping,
  torqueUnit: TorqueUnit,
  etaFormat: EfficiencyFormat,
  options: { requireTorque?: boolean } = {}
): NormalizedDynoResult {
  const out: NormalizedDynoPoint[] = [];
  const warnings: string[] = [];
  let droppedTorqueCount = 0;
  let droppedElectricalCount = 0;
  let pInFallbackCount = 0;
  const nUnitInfo = detectHeaderEngineeringScale(mapping.n_rpm, 'speed');
  const vUnitInfo = detectHeaderEngineeringScale(mapping.V_bus, 'voltage');
  const iUnitInfo = detectHeaderEngineeringScale(mapping.I_bus, 'current');
  for (const [label, info] of [['n_rpm', nUnitInfo], ['V_bus', vUnitInfo], ['I_bus', iUnitInfo]] as const) {
    if (info.invalidToken) warnings.push(`${label} 列单位 "${info.invalidToken}" 无法安全换算到基础单位，已停止按该列生成标定点。`);
  }
  if (nUnitInfo.invalidToken || vUnitInfo.invalidToken || iUnitInfo.invalidToken) {
    return { points: [], warnings };
  }
  let quarantinedEtaCount = 0;
  const rawEtas: number[] = [];
  const poutDiscrepancies: number[] = [];

  const pInUnitInfo = mapping.P_in ? detectHeaderPowerScaleW(mapping.P_in) : { scaleW: 1, invalidToken: null };
  const pOutUnitInfo = mapping.P_out ? detectHeaderPowerScaleW(mapping.P_out) : { scaleW: 1, invalidToken: null };
  if (pInUnitInfo.invalidToken || pOutUnitInfo.invalidToken) {
    if (pInUnitInfo.invalidToken) warnings.push(`P_in 列 "${mapping.P_in}" 显式单位 "${pInUnitInfo.invalidToken}" 属于非标准功率单位，不在安全换算表 (W/kW/mW/MW/GW/TW) 中。`);
    if (pOutUnitInfo.invalidToken) warnings.push(`P_out 列 "${mapping.P_out}" 显式单位 "${pOutUnitInfo.invalidToken}" 属于非标准功率单位，不在安全换算表 (W/kW/mW/MW/GW/TW) 中。`);
    return { points: [], warnings: [...warnings, '功率列单位不明确，已停止标定点生成；请修正列单位或取消该功率列映射，不能默认按 W 解释。'] };
  }

  for (const row of dataset.rows) {
    const num = (col: string): number => {
      if (!col) return Number.NaN;
      const raw = row[col];
      if (raw === null || raw === undefined || typeof raw === 'boolean') return Number.NaN;
      if (typeof raw === 'string' && raw.trim() === '') return Number.NaN;
      const v = Number(raw);
      return Number.isFinite(v) ? v : Number.NaN;
    };

    const nRpm = num(mapping.n_rpm) * nUnitInfo.scale;
    const vBusV = num(mapping.V_bus) * vUnitInfo.scale;
    const iBusA = num(mapping.I_bus) * iUnitInfo.scale;
    const tRaw = num(mapping.T_Nm);
    let tNm = Number.isFinite(tRaw) ? torqueToNm(tRaw, torqueUnit) : Number.NaN;

    if (!Number.isFinite(nRpm) || !Number.isFinite(vBusV) || vBusV <= 0 || !Number.isFinite(iBusA)) {
      droppedElectricalCount++;
      continue;
    }

    let pInW = mapping.P_in ? parsePowerCellW(row[mapping.P_in], pInUnitInfo.scaleW) : Number.NaN;
    if (!Number.isFinite(pInW)) {
      pInW = vBusV * iBusA;
      if (mapping.P_in) pInFallbackCount++;
    }

    let pOutW = mapping.P_out ? parsePowerCellW(row[mapping.P_out], pOutUnitInfo.scaleW) : Number.NaN;
    if (!Number.isFinite(tNm) && Number.isFinite(pOutW) && Math.abs(nRpm) > 1e-6) {
      tNm = pOutW / calcOmegaM(nRpm);
    }

    if (!Number.isFinite(tNm)) {
      if (options.requireTorque) {
        droppedTorqueCount++;
        continue;
      }
      tNm = 0;
    }

    const pOutFromTorque = tNm * calcOmegaM(nRpm);
    if (Number.isFinite(pOutW)) {
      const denom = Math.max(Math.abs(pOutW), Math.abs(pOutFromTorque));
      if (denom > 0.2) {
        const relDiff = Math.abs(pOutW - pOutFromTorque) / denom;
        poutDiscrepancies.push(relDiff);
      }
    }
    if (!Number.isFinite(pOutW)) {
      pOutW = pOutFromTorque;
    }

    let etaMeas = num(mapping.eta);
    if (Number.isFinite(etaMeas)) {
      rawEtas.push(etaMeas);
      if (etaFormat === 'percent') {
        etaMeas = etaMeas / 100;
      }
    } else if (pInW > 1e-6 && pOutW >= 0) {
      etaMeas = pOutW / pInW;
    } else if (pInW < -1e-6 && pOutW < -1e-6) {
      etaMeas = Math.abs(pInW / pOutW);
    } else {
      etaMeas = Number.NaN;
    }

    let etaClean = etaMeas;
    if (!Number.isFinite(etaMeas) || etaMeas < 0 || etaMeas > 1.0) {
      quarantinedEtaCount++;
      etaClean = Number.NaN;
    }

    out.push({
      nRpm,
      tNm,
      vBusV,
      iBusA,
      pInW,
      pOutW,
      etaMeas: etaClean,
    });
  }

  if (droppedElectricalCount > 0) {
    warnings.push(`已剔除 ${droppedElectricalCount} 条 V_bus/I_bus/n_rpm 缺失或非法的记录；母线电压必须为正值。`);
  }
  if (pInFallbackCount > 0) {
    warnings.push(`P_in 列已映射，但有 ${pInFallbackCount} 条记录的 P_in 单元格为空/非法，已逐行回退为 V_bus × I_bus；请确认该列是否存在导出缺失，避免混合两种功率来源而不自知。`);
  }
  if (droppedTorqueCount > 0) {
    if (!mapping.T_Nm && !mapping.P_out) {
      warnings.push(`闭环数据未映射扭矩列 (T_Nm) 且无 P_out 可反算，已拦截 ${droppedTorqueCount} 条无效行（请先映射扭矩列）。`);
    } else {
      warnings.push(`已剔除 ${droppedTorqueCount} 条缺失扭矩的无效行（避免被当成 0 N·m 污染标定与 MAE）`);
    }
  }
  if (rawEtas.length > 0) {
    const maxRaw = Math.max(...rawEtas);
    const sortedEta = [...rawEtas].sort((a, b) => a - b);
    const medRaw = sortedEta[Math.floor(sortedEta.length / 2)];
    if (etaFormat === '0-1' && maxRaw > 1.05) {
      warnings.push(`效率列最大值 (${maxRaw.toFixed(2)}) > 1.05，疑似百分比格式，请切换为「百分比 (0–100%)」`);
    } else if (etaFormat === 'percent' && medRaw > 0 && medRaw < 1.0) {
      warnings.push(`效率列中位数 (${medRaw.toFixed(3)}) < 1.0，按 % 换算后不足 1%，疑似本就是「小数 (0–1)」`);
    }
  }
  if (quarantinedEtaCount > 0) {
    warnings.push(`检测到 ${quarantinedEtaCount} 条效率读数超出物理区间 [0, 1]，已隔离标记为 NaN；不再将越界值静默裁剪为 0% 或 100%，也不计入效率误差。`);
  }
  if (poutDiscrepancies.length > 0) {
    const medDisc = [...poutDiscrepancies].sort((a, b) => a - b)[Math.floor(poutDiscrepancies.length / 2)];
    if (medDisc > 0.15) {
      warnings.push(`实测 P_out 列与换算后的 T_Nm × ω_m 偏差达 ${(medDisc * 100).toFixed(0)}%，请核对扭矩单位或 P_out 单位`);
    }
  }

  return { points: out, warnings };
}

export function fitNonNegLinearP0(samples: Array<{ n: number; p0: number }>): { a: number; b: number } {
  if (samples.length === 0) return { a: 0, b: 0 };
  let s11 = 0;
  let s12 = 0;
  let s22 = 0;
  let r1 = 0;
  let r2 = 0;
  for (const s of samples) {
    const x1 = Math.abs(s.n);
    const x2 = s.n * s.n;
    s11 += x1 * x1;
    s12 += x1 * x2;
    s22 += x2 * x2;
    r1 += x1 * s.p0;
    r2 += x2 * s.p0;
  }

  const det = s11 * s22 - s12 * s12;
  let bestA = 0;
  let bestB = 0;
  let bestLoss = Infinity;

  const evalLoss = (a: number, b: number) => {
    let sum = 0;
    for (const s of samples) {
      const err = a * Math.abs(s.n) + b * s.n * s.n - s.p0;
      sum += err * err;
    }
    return sum;
  };

  if (Math.abs(det) > 1e-18) {
    const a = (r1 * s22 - r2 * s12) / det;
    const b = (s11 * r2 - s12 * r1) / det;
    if (a >= 0 && b >= 0) {
      return { a, b };
    }
  }

  const aOnly = s11 > 1e-18 ? Math.max(0, r1 / s11) : 0;
  const bOnly = s22 > 1e-18 ? Math.max(0, r2 / s22) : 0;
  const candidates: Array<[number, number]> = [
    [aOnly, 0],
    [0, bOnly],
    [0, 0],
  ];
  for (const [ca, cb] of candidates) {
    const l = evalLoss(ca, cb);
    if (l < bestLoss) {
      bestLoss = l;
      bestA = ca;
      bestB = cb;
    }
  }
  return { a: bestA, b: bestB };
}

export function runStepwiseCalibration(
  openLoopPoints: NormalizedDynoPoint[],
  closedLoopPoints: NormalizedDynoPoint[],
  baseParams: MotorParams,
  options: {
    keSource: KeSourceMode;
    manualN0Rpm: number;
    manualVTestV: number;
    manualKv: number;
    rsFitMode: RsFitMode;
    openLoopModDepth?: number;
  }
): CalibrationReport {
  const fitNotes: string[] = [];
  const warnings: string[] = [];
  let status: CalibrationStatus = 'ok';
  const elevateStatus = (next: CalibrationStatus) => {
    if (next === 'failed' || (next === 'warn' && status === 'ok')) status = next;
  };

  // Step 1: Determine Ke' and n0Rpm
  let kePrime = baseParams.kePrime;
  let calibratedN0Rpm = baseParams.n0Rpm;
  const requestedModScale =
    options.openLoopModDepth !== undefined && Number.isFinite(options.openLoopModDepth)
      ? options.openLoopModDepth
      : 1.0;
  const modScale = Math.max(0.1, Math.min(1.0, requestedModScale));
  if (options.keSource === 'open_loop_auto' && requestedModScale > 1.0 + 1e-6) {
    elevateStatus('warn');
    warnings.push(`输入 m_norm=${requestedModScale.toFixed(4)} 超过线性 SVPWM 定义上限 1.0，已限制为 1.0；请确认是否把调制深度 m 与归一化 m_norm 混淆。`);
  } else if (options.keSource === 'open_loop_auto' && requestedModScale < 0.1 - 1e-6) {
    elevateStatus('warn');
    warnings.push(`输入 m_norm=${requestedModScale.toFixed(4)} 低于可用下限 0.1，自动 Ke 已按 0.1 计算；请检查输入。`);
  }

  if (options.keSource === 'manual_n0_vtest') {
    kePrime = calcKeFromNoLoad(options.manualVTestV, options.manualN0Rpm);
    calibratedN0Rpm = options.manualN0Rpm;
    fitNotes.push(`Step 1: 由手动空载点 (${options.manualN0Rpm.toFixed(0)} RPM, ${options.manualVTestV.toFixed(2)} V) 锁定 Ke' = ${kePrime.toFixed(5)} Vpeak/(rad/s)`);
  } else if (options.keSource === 'manual_kv') {
    kePrime = calcKeFromKv(options.manualKv);
    fitNotes.push(`Step 1: 由 KV = ${options.manualKv.toFixed(1)} RPM/V 锁定 Ke' = ${kePrime.toFixed(5)} Vpeak/(rad/s)`);
  } else if (openLoopPoints.length > 0) {
    const validOl = openLoopPoints.filter((pt) => Number.isFinite(pt.nRpm) && pt.nRpm > 50 && Number.isFinite(pt.vBusV) && pt.vBusV > 0.5);
    if (validOl.length > 0) {
      const maxTorque = Math.max(...validOl.map((p) => Math.abs(p.tNm)), 0);
      const noLoadPts = validOl.filter((p) => maxTorque <= 0.02 || Math.abs(p.tNm) <= Math.max(0.02, maxTorque * 0.05));
      // Ke = V_phase_peak / omega is only valid for a measured no-load/back-EMF
      // point under the declared modulation assumption. Loaded points include
      // Rs·I and omega·L·I voltage drops; never use them as a fallback Ke proxy.
      const candidates = noLoadPts
        .map((p) => calcKeFromNoLoad(p.vBusV * modScale, p.nRpm))
        .filter((v) => Number.isFinite(v) && v > 0)
        .sort((a, b) => a - b);
      if (candidates.length >= 2) {
        const noLoadN0 = Math.max(...noLoadPts.map((p) => p.nRpm));
        calibratedN0Rpm = noLoadN0;
        const mid = candidates.length >> 1;
        kePrime = candidates.length % 2 === 0 ? 0.5 * (candidates[mid - 1] + candidates[mid]) : candidates[mid];
        fitNotes.push(
          `Step 1: 使用 ${candidates.length} 个有效空载点的 Ke 候选值中位数（最高空载转速 ${noLoadN0.toFixed(0)} RPM；输入 m_norm=${modScale.toFixed(3)}）提取 Ke' = ${kePrime.toFixed(5)} Vpeak/(rad/s)`
        );
        const relativeSpread = (Math.max(...candidates) - Math.min(...candidates)) / Math.max(1e-12, kePrime);
        if (relativeSpread > 0.12) {
          elevateStatus('warn');
          warnings.push(
            `多点 Ke 候选值极差/中位数为 ${(relativeSpread * 100).toFixed(1)}% (>12%)，测点可能不在同一调制深度/负载条件；自动 Ke 仅作为估计，建议核对相电压基波或使用独立空载反电势测量。`
          );
        }
      } else {
        elevateStatus('warn');
        warnings.push(`仅识别到 ${candidates.length} 个可用空载 Ke 候选点（至少需要 2 个）；没有使用带载点替代空载反电势，Ke'/n0 沿用基准参数。请补充不同转速下的空载数据，或改用手动 KV/(n0,V_test)。`);
        fitNotes.push(`Step 1: 有效空载 Ke 候选点不足 2 个；拒绝用带载 Vbus/RPM 伪估 Ke，沿用基准 Ke'=${kePrime.toFixed(5)} Vpeak/(rad/s)、n0=${calibratedN0Rpm.toFixed(0)} RPM`);
      }
    } else {
      elevateStatus('warn');
      warnings.push(`开环数据缺少 n > 50 RPM 且 V_bus > 0.5V 的有效空载点，无法自动提取 Ke'，已沿用设定值 Ke' = ${kePrime.toFixed(5)}。`);
      fitNotes.push(`Step 1: 开环有效空载点不足，沿用设定 Ke' = ${kePrime.toFixed(5)} Vpeak/(rad/s)`);
    }
  } else {
    fitNotes.push(`Step 1: 沿用当前设定 Ke' = ${kePrime.toFixed(5)} Vpeak/(rad/s)`);
  }

  if (options.keSource === 'open_loop_auto') {
    warnings.push('自动 Ke 仍依赖操作者输入的开环调制系数 m_norm（当前 UI 默认 1.0）；该输入不是由 Vbus/RPM 自动测出的实际相电压基波。若 m_norm 未经 PWM/相电压实测确认，Ke 只能作为假设条件下的估计值，不得作为电机参数签核依据。');
    fitNotes.push('Ke 适用边界：Vbus × m_norm 仅是相电压基波的简化估计；未接入实测相电压基波/调制波形时，Ke 结果带调制深度假设。');
    elevateStatus('warn');
  }

  if (!Number.isFinite(kePrime) || kePrime <= 0) {
    elevateStatus('failed');
    warnings.push(`Ke' 物理参数无效 (${kePrime})，请检查空载转速/电压或手动 KV 输入。`);
    kePrime = Math.max(1e-5, baseParams.kePrime || 0.05);
  }

  const rsAnchorOhm = calcRsAnchorOhm(baseParams.rLL25Ohm, baseParams.tCoilC);

  // Step 2: Fit speed-dependent core & windage loss P0(n) = a*n + b*n^2
  const p0Samples: Array<{ n: number; p0: number }> = [];
  const tempParamsForP0: MotorParams = {
    ...baseParams,
    kePrime,
    n0Rpm: calibratedN0Rpm,
    rsEffOverrideOhm: rsAnchorOhm,
    betaSat: 0,
    p0A: 0,
    p0B: 0,
  };

  if (openLoopPoints.length >= 2) {
    const maxOpenT = Math.max(...openLoopPoints.map((p) => Math.abs(p.tNm)), 0);
    const olNoLoad = openLoopPoints.filter((p) => (maxOpenT <= 0.02 || Math.abs(p.tNm) <= 0.02) && p.nRpm > 30);
    const olSubset = olNoLoad.length >= 2 ? olNoLoad : openLoopPoints.filter((p) => p.nRpm > 30);
    for (const pt of olSubset) {
      const res = solveSinglePoint(pt.vBusV, pt.iBusA, pt.nRpm, tempParamsForP0);
      if (Number.isFinite(res.iqA)) {
        const pAirgap = 1.5 * res.eqV * res.iqA;
        const p0Obs = Math.max(0, pAirgap - pt.pOutW);
        p0Samples.push({ n: pt.nRpm, p0: p0Obs });
      }
    }
    fitNotes.push(`Step 2: 使用 ${p0Samples.length} 个开环空载/轻载点拟合随速铁损+风摩损 P0(n) = a·n + b·n²`);
  }

  if (p0Samples.length < 3 && closedLoopPoints.length > 0) {
    const maxT = Math.max(...closedLoopPoints.map((p) => Math.abs(p.tNm)), 1e-4);
    const lightPoints = closedLoopPoints.filter((p) => Math.abs(p.tNm) <= 0.38 * maxT && p.nRpm > 50);
    const subset = lightPoints.length >= 3 ? lightPoints : closedLoopPoints.slice(0, Math.min(8, closedLoopPoints.length));
    for (const pt of subset) {
      const res = solveSinglePoint(pt.vBusV, pt.iBusA, pt.nRpm, tempParamsForP0);
      if (Number.isFinite(res.iqA)) {
        const pAirgap = 1.5 * res.eqV * res.iqA;
        const p0Obs = Math.max(0, pAirgap - pt.pOutW);
        p0Samples.push({ n: pt.nRpm, p0: p0Obs });
      }
    }
    fitNotes.push(`Step 2: 结合轻载测功点 (共 ${p0Samples.length} 点) 拟合非负 P0(n)`);
  }

  const p0FiniteSamples = p0Samples.filter((sample) =>
    Number.isFinite(sample.n) && Math.abs(sample.n) > 30 && Number.isFinite(sample.p0) && sample.p0 >= 0
  );
  const p0Speeds = [...new Set(p0FiniteSamples.map((sample) => Math.round(Math.abs(sample.n))))].sort((a, b) => a - b);
  const p0SpeedSpan = p0Speeds.length >= 2 ? p0Speeds[p0Speeds.length - 1] - p0Speeds[0] : 0;
  const p0SpeedReference = p0Speeds.length > 0 ? p0Speeds[p0Speeds.length - 1] : 0;
  // Normalize the two design columns x1=|n| and x2=n² before computing
  // their 2-norm condition number. This isolates geometric collinearity from
  // RPM units and sample weighting. A large condition number means a and b
  // can trade off dramatically while producing nearly identical P0 curves.
  const p0SumN2 = p0Speeds.reduce((sum, n) => sum + n * n, 0);
  const p0SumN3 = p0Speeds.reduce((sum, n) => sum + n * n * n, 0);
  const p0SumN4 = p0Speeds.reduce((sum, n) => sum + n * n * n * n, 0);
  const p0ColumnCorrelation = p0SumN2 > 0 && p0SumN4 > 0
    ? Math.min(1, Math.max(0, p0SumN3 / Math.sqrt(p0SumN2 * p0SumN4)))
    : 1;
  const p0DesignConditionNumber = p0ColumnCorrelation >= 1 - 1e-12
    ? Infinity
    : Math.sqrt((1 + p0ColumnCorrelation) / (1 - p0ColumnCorrelation));
  // In addition to sample count and speed span, require a dimensionless
  // normalized design condition <= 40. This is a conservative numerical
  // identifiability screen, not a universal motor-physics constant.
  const p0Identifiable = p0FiniteSamples.length >= 3 && p0Speeds.length >= 3 &&
    p0SpeedSpan >= Math.max(20, 0.08 * p0SpeedReference) && p0DesignConditionNumber <= 40;
  const { a: p0A, b: p0B } = p0Identifiable
    ? fitNonNegLinearP0(p0FiniteSamples)
    : { a: Math.max(0, baseParams.p0A), b: Math.max(0, baseParams.p0B) };
  if (!p0Identifiable) {
    elevateStatus('warn');
    warnings.push(`P0(n)=a·|n|+b·n² 的参数不可充分辨识：有效样本 ${p0FiniteSamples.length} 个、不同转速 ${p0Speeds.length} 档、转速跨度 ${p0SpeedSpan.toFixed(1)} RPM、归一化设计矩阵条件数 ${Number.isFinite(p0DesignConditionNumber) ? p0DesignConditionNumber.toFixed(1) : '∞'}；至少需要 3 个不同转速、跨度达到最高转速的 8%（或 20 RPM），且条件数 ≤40。已保留基准 P0 参数，不把病态拟合冒充标定结果。`);
  }
  fitNotes.push(
    p0Identifiable
      ? `Step 2 结果: 使用 ${p0FiniteSamples.length} 个样本 / ${p0Speeds.length} 个转速档拟合 a = ${p0A.toExponential(3)} W/RPM, b = ${p0B.toExponential(3)} W/RPM²`
      : `Step 2 参数不可辨识，沿用基准 P0 参数: a = ${p0A.toExponential(3)}, b = ${p0B.toExponential(3)}`
  );

  // Step 3: Anti-overfitting fitting of beta (>=0) and locked or +/-15% bounded Rs_eff
  const step3ParamsBase: MotorParams = {
    ...baseParams,
    kePrime,
    p0A,
    p0B,
    betaSat: 0,
    rsEffOverrideOhm: rsAnchorOhm,
  };

  let bestBeta = 0;
  let bestRs = rsAnchorOhm;

  if (closedLoopPoints.length > 0) {
    const evalObjective = (beta: number, rs: number): number => {
      const testParams: MotorParams = {
        ...step3ParamsBase,
        betaSat: beta,
        rsEffOverrideOhm: rs,
      };
      let loss = 0;
      let count = 0;
      for (const pt of closedLoopPoints) {
        const res = solveSinglePoint(pt.vBusV, pt.iBusA, pt.nRpm, testParams);
        if (!Number.isFinite(res.tEstNm)) {
          loss += 1e6;
          count++;
          continue;
        }
        const tErr = res.tEstNm - pt.tNm;
        if (Number.isFinite(res.etaEst) && Number.isFinite(pt.etaMeas)) {
          const etaErr = res.etaEst - pt.etaMeas;
          loss += 0.01 * etaErr * etaErr;
        }
        loss += tErr * tErr;
        count++;
      }
      return count > 0 ? loss / count : Infinity;
    };

    const rsMin = options.rsFitMode === 'locked' ? rsAnchorOhm : rsAnchorOhm * 0.85;
    const rsMax = options.rsFitMode === 'locked' ? rsAnchorOhm : rsAnchorOhm * 1.15;
    const rsSteps = options.rsFitMode === 'locked' ? [rsAnchorOhm] : Array.from({ length: 13 }, (_, i) => rsMin + ((rsMax - rsMin) * i) / 12);

    let bestLoss = Infinity;
    for (const rsCand of rsSteps) {
      for (let bi = 0; bi <= 50; bi++) {
        const bCand = bi * 0.002;
        const obj = evalObjective(bCand, rsCand);
        if (obj < bestLoss) {
          bestLoss = obj;
          bestBeta = bCand;
          bestRs = rsCand;
        }
      }
    }

    let dBeta = 0.001;
    let dRs = options.rsFitMode === 'locked' ? 0 : (rsMax - rsMin) * 0.04;
    for (let iter = 0; iter < 18; iter++) {
      const candidates: Array<[number, number]> = [
        [Math.max(0, bestBeta - dBeta), bestRs],
        [Math.min(0.5, bestBeta + dBeta), bestRs],
      ];
      if (options.rsFitMode === 'bounded_15pct') {
        candidates.push(
          [bestBeta, Math.max(rsMin, bestRs - dRs)],
          [bestBeta, Math.min(rsMax, bestRs + dRs)]
        );
      }
      let improved = false;
      for (const [cb, crs] of candidates) {
        const obj = evalObjective(cb, crs);
        if (obj < bestLoss) {
          bestLoss = obj;
          bestBeta = cb;
          bestRs = crs;
          improved = true;
        }
      }
      if (!improved) {
        dBeta *= 0.5;
        dRs *= 0.5;
      }
    }

    if (options.rsFitMode === 'locked') {
      fitNotes.push(`Step 3 (防过拟合锁定 Rs): Rs_eff = ${bestRs.toFixed(4)} Ω (R_LL/2 温修基准), 拟合 β = ${bestBeta.toFixed(5)} A⁻²`);
    } else {
      const pctDiff = ((bestRs - rsAnchorOhm) / rsAnchorOhm) * 100;
      fitNotes.push(`Step 3 (±15% 微调 Rs): Rs_eff = ${bestRs.toFixed(4)} Ω (${pctDiff >= 0 ? '+' : ''}${pctDiff.toFixed(1)}%), 拟合 β = ${bestBeta.toFixed(5)} A⁻²`);
    }
  }

  const finalParams: MotorParams = {
    ...step3ParamsBase,
    betaSat: bestBeta,
    rsEffOverrideOhm: bestRs,
  };

  let unsolvedCount = 0;
  const evaluatedPoints: EvaluatedDynoPoint[] = closedLoopPoints.map((pt) => {
    const res = solveSinglePoint(pt.vBusV, pt.iBusA, pt.nRpm, finalParams);
    if (!Number.isFinite(res.tEstNm)) {
      unsolvedCount++;
    }
    // A physically unsolved operating point is not a zero-torque / zero-loss
    // point. Preserve it as NaN so charts and metrics cannot disguise failure.
    const solved = Number.isFinite(res.tEstNm) && Number.isFinite(res.pElecW) && Number.isFinite(res.iqA);
    const pInvLossW = solved ? Math.max(0, pt.pInW - res.pElecW) : Number.NaN;
    const pCuLossW = solved && Number.isFinite(res.pCuW) ? res.pCuW : Number.NaN;
    const pIronWindLossW = solved && Number.isFinite(res.p0W) ? res.p0W : Number.NaN;
    const tEstNm = solved ? res.tEstNm : Number.NaN;
    const etaEst = solved && Number.isFinite(res.etaEst) ? res.etaEst : Number.NaN;
    const pOutEstW = solved && Number.isFinite(res.pOutW) ? res.pOutW : Number.NaN;
    const iqEstA = solved ? res.iqA : Number.NaN;
    return {
      ...pt,
      iqEstA,
      tEstNm,
      pOutEstW,
      etaEst,
      pInvLossW,
      pCuLossW,
      pIronWindLossW,
      errTorqueNm: solved ? tEstNm - pt.tNm : Number.NaN,
      errEta: Number.isFinite(etaEst) && Number.isFinite(pt.etaMeas) ? etaEst - pt.etaMeas : Number.NaN,
    };
  });

  const solvedEvaluatedPoints = evaluatedPoints.filter((p) =>
    Number.isFinite(p.tEstNm) && Number.isFinite(p.errTorqueNm)
  );
  let sumAbsT = 0;
  let sumSqT = 0;
  let sumPctT = 0;
  let countPctT = 0;
  let sumAbsEta = 0;
  let sumSqEta = 0;
  let sumPctEta = 0;
  let countPctEta = 0;
  let validEtaCount = 0;

  for (const p of solvedEvaluatedPoints) {
    sumAbsT += Math.abs(p.errTorqueNm);
    sumSqT += p.errTorqueNm * p.errTorqueNm;
    if (Math.abs(p.tNm) > 0.015) {
      sumPctT += (Math.abs(p.errTorqueNm) / Math.abs(p.tNm)) * 100;
      countPctT++;
    }
    if (Number.isFinite(p.etaMeas) && Number.isFinite(p.etaEst)) {
      const etaDiffPct = (p.etaEst - p.etaMeas) * 100;
      validEtaCount++;
      sumAbsEta += Math.abs(etaDiffPct);
      sumSqEta += etaDiffPct * etaDiffPct;
      if (p.etaMeas > 0.1) {
        sumPctEta += (Math.abs(p.etaEst - p.etaMeas) / p.etaMeas) * 100;
        countPctEta++;
      }
    }
  }

  const metrics: ErrorMetrics = {
    maeTorqueNm: solvedEvaluatedPoints.length > 0 ? sumAbsT / solvedEvaluatedPoints.length : Number.NaN,
    rmseTorqueNm: solvedEvaluatedPoints.length > 0 ? Math.sqrt(sumSqT / solvedEvaluatedPoints.length) : Number.NaN,
    mapeTorquePct: countPctT > 0 ? sumPctT / countPctT : Number.NaN,
    maeEtaPct: validEtaCount > 0 ? sumAbsEta / validEtaCount : Number.NaN,
    rmseEtaPct: validEtaCount > 0 ? Math.sqrt(sumSqEta / validEtaCount) : Number.NaN,
    mapeEtaPct: countPctEta > 0 ? sumPctEta / countPctEta : Number.NaN,
  };
  // Independent holdout validation: parameters are re-fitted only on trainPts.
  // The main all-data calibration must never seed validation parameters.
  let validationMetrics: CalibrationValidationMetrics | undefined;
  if (closedLoopPoints.length >= 10) {
    const trainPts: NormalizedDynoPoint[] = [];
    const valPts: NormalizedDynoPoint[] = [];
    const sortedCl = [...closedLoopPoints].sort((a, b) => a.nRpm - b.nRpm || a.tNm - b.tNm);
    sortedCl.forEach((p, idx) => {
      if (idx % 5 === 2) valPts.push(p);
      else trainPts.push(p);
    });
    if (valPts.length >= 2 && trainPts.length >= 6) {
      // P0 is sourced only from the independent open-loop set. If it is not sufficient,
      // use the caller's pre-existing baseline rather than a P0 fit containing validation rows.
      const cvP0Samples: Array<{ n: number; p0: number }> = [];
      if (openLoopPoints.length >= 2) {
        const maxOpenT = Math.max(...openLoopPoints.map((p) => Math.abs(p.tNm)), 0);
        const noLoad = openLoopPoints.filter((p) => (maxOpenT <= 0.02 || Math.abs(p.tNm) <= Math.max(0.02, maxOpenT * 0.05)) && p.nRpm > 30);
        const p0Source = noLoad.length >= 2 ? noLoad : openLoopPoints.filter((p) => p.nRpm > 30);
        const p0Params: MotorParams = {
          ...baseParams, kePrime, n0Rpm: calibratedN0Rpm, p0A: 0, p0B: 0,
          betaSat: 0, rsEffOverrideOhm: rsAnchorOhm,
        };
        for (const point of p0Source) {
          const r = solveSinglePoint(point.vBusV, point.iBusA, point.nRpm, p0Params);
          if (Number.isFinite(r.iqA)) cvP0Samples.push({ n: point.nRpm, p0: Math.max(0, 1.5 * r.eqV * r.iqA - point.pOutW) });
        }
      }
      const cvP0 = cvP0Samples.length >= 2
        ? fitNonNegLinearP0(cvP0Samples)
        : { a: Math.max(0, baseParams.p0A), b: Math.max(0, baseParams.p0B) };
      const cvBase: MotorParams = {
        ...baseParams, kePrime, n0Rpm: calibratedN0Rpm,
        p0A: cvP0.a, p0B: cvP0.b, betaSat: 0,
        rsEffOverrideOhm: rsAnchorOhm,
      };
      const rsMinCv = options.rsFitMode === 'locked' ? rsAnchorOhm : rsAnchorOhm * 0.85;
      const rsMaxCv = options.rsFitMode === 'locked' ? rsAnchorOhm : rsAnchorOhm * 1.15;
      const rsStepsCv = options.rsFitMode === 'locked'
        ? [rsAnchorOhm]
        : Array.from({ length: 13 }, (_, i) => rsMinCv + ((rsMaxCv - rsMinCv) * i) / 12);
      const objectiveCv = (beta: number, rs: number): number => {
        const params: MotorParams = { ...cvBase, betaSat: beta, rsEffOverrideOhm: rs };
        let loss = 0;
        let count = 0;
        for (const point of trainPts) {
          const r = solveSinglePoint(point.vBusV, point.iBusA, point.nRpm, params);
          if (!Number.isFinite(r.tEstNm)) { loss += 1e6; count++; continue; }
          const tErr = r.tEstNm - point.tNm;
          loss += tErr * tErr;
          if (Number.isFinite(point.etaMeas) && Number.isFinite(r.etaEst)) {
            const etaErr = r.etaEst - point.etaMeas;
            loss += 0.01 * etaErr * etaErr;
          }
          count++;
        }
        return count > 0 ? loss / count : Infinity;
      };
      let cvBeta = 0;
      let cvRs = rsAnchorOhm;
      let cvLoss = Infinity;
      for (const rs of rsStepsCv) {
        for (let bi = 0; bi <= 50; bi++) {
          const beta = bi * 0.002;
          const loss = objectiveCv(beta, rs);
          if (loss < cvLoss) { cvLoss = loss; cvBeta = beta; cvRs = rs; }
        }
      }
      let dBetaCv = 0.001;
      let dRsCv = options.rsFitMode === 'locked' ? 0 : (rsMaxCv - rsMinCv) * 0.04;
      for (let iter = 0; iter < 18; iter++) {
        const candidates: Array<[number, number]> = [
          [Math.max(0, cvBeta - dBetaCv), cvRs],
          [Math.min(0.5, cvBeta + dBetaCv), cvRs],
        ];
        if (options.rsFitMode === 'bounded_15pct') {
          candidates.push([cvBeta, Math.max(rsMinCv, cvRs - dRsCv)], [cvBeta, Math.min(rsMaxCv, cvRs + dRsCv)]);
        }
        let improved = false;
        for (const [beta, rs] of candidates) {
          const loss = objectiveCv(beta, rs);
          if (loss < cvLoss) { cvLoss = loss; cvBeta = beta; cvRs = rs; improved = true; }
        }
        if (!improved) { dBetaCv *= 0.5; dRsCv *= 0.5; }
      }
      const valParams: MotorParams = { ...cvBase, betaSat: cvBeta, rsEffOverrideOhm: cvRs };
      let vAbsT = 0;
      let vPctT = 0;
      let vPctCnt = 0;
      let vAbsEta = 0;
      let vEtaCnt = 0;
      let vSolvedCount = 0;
      for (const point of valPts) {
        const r = solveSinglePoint(point.vBusV, point.iBusA, point.nRpm, valParams);
        const te = Number.isFinite(r.tEstNm) ? r.tEstNm : Number.NaN;
        if (!Number.isFinite(te)) continue;
        vAbsT += Math.abs(te - point.tNm);
        vSolvedCount++;
        if (Math.abs(point.tNm) > 0.015) { vPctT += (Math.abs(te - point.tNm) / Math.abs(point.tNm)) * 100; vPctCnt++; }
        if (Number.isFinite(point.etaMeas) && Number.isFinite(r.etaEst)) { vAbsEta += Math.abs((r.etaEst - point.etaMeas) * 100); vEtaCnt++; }
      }
      validationMetrics = {
        holdoutCount: valPts.length,
        trainCount: trainPts.length,
        fitSource: 'train_only',
        valMaeTorqueNm: vSolvedCount > 0 ? vAbsT / vSolvedCount : Number.NaN,
        validHoldoutCount: vSolvedCount,
        valMapeTorquePct: vPctCnt > 0 ? vPctT / vPctCnt : Number.NaN,
        valMaeEtaPct: vEtaCnt > 0 ? vAbsEta / vEtaCnt : Number.NaN,
        validHoldoutEtaCount: vEtaCnt,
      };
      fitNotes.push(`独立留出验证：${trainPts.length} 个训练点重新拟合 β/Rs，${valPts.length} 个验证点未参与 Ke/P0/β/Rs 标定；其中 ${vSolvedCount} 个点通过物理求解并计入误差指标；P0 优先来自独立开环数据。`);
      if (vSolvedCount === 0) {
        warnings.push('独立留出集没有任何可物理解算的验证点，验证 MAE 已标记为 NaN，不能据此宣称标定通过。');
        elevateStatus('warn');
      } else if (vSolvedCount < valPts.length) {
        warnings.push(`独立留出验证中 ${valPts.length - vSolvedCount} 个点无法物理解算，验证 MAE 仅基于 ${vSolvedCount}/${valPts.length} 个有效点。`);
        elevateStatus('warn');
      }
    }
  }

  let operatingEnvelope: OperatingEnvelopeBounds | undefined;
  let paramSensitivity: CalibrationSensitivity | undefined;
  if (closedLoopPoints.length > 0) {
    operatingEnvelope = {
      minRpm: Math.min(...closedLoopPoints.map((p) => p.nRpm)),
      maxRpm: Math.max(...closedLoopPoints.map((p) => p.nRpm)),
      minTorqueNm: Math.min(...closedLoopPoints.map((p) => p.tNm)),
      maxTorqueNm: Math.max(...closedLoopPoints.map((p) => p.tNm)),
      minVbusV: Math.min(...closedLoopPoints.map((p) => p.vBusV)),
      maxVbusV: Math.max(...closedLoopPoints.map((p) => p.vBusV)),
    };
    const maeWith = (override: Partial<MotorParams>) => {
      const pTest: MotorParams = { ...finalParams, ...override };
      let s = 0;
      let count = 0;
      for (const pt of closedLoopPoints) {
        const r = solveSinglePoint(pt.vBusV, pt.iBusA, pt.nRpm, pTest);
        if (!Number.isFinite(r.tEstNm)) continue;
        s += Math.abs(r.tEstNm - pt.tNm);
        count++;
      }
      return count > 0 ? s / count : Number.NaN;
    };
    paramSensitivity = {
      rsPlus10PctDeltaMaeNm: maeWith({ rsEffOverrideOhm: bestRs * 1.1 }) - metrics.maeTorqueNm,
      kePlus5PctDeltaMaeNm: maeWith({ kePrime: kePrime * 1.05 }) - metrics.maeTorqueNm,
    };
  }

  if (closedLoopPoints.length === 0) {
    elevateStatus('failed');
    warnings.push('闭环测功有效测点为空，无法完成 Step 3 磁饱和与效率 Map 标定（请核对闭环数据及扭矩列映射）。');
  } else {
    if (!Number.isFinite(rsAnchorOhm) || rsAnchorOhm <= 0 || !Number.isFinite(bestRs) || bestRs <= 0 || !Number.isFinite(bestBeta) || bestBeta < 0) {
      elevateStatus('failed');
      warnings.push(`标定电阻/饱和系数越界 (Rs_eff=${bestRs}, β=${bestBeta})，请检查 R_LL@25°C 与 T_coil 参数。`);
    }
    if (solvedEvaluatedPoints.length === 0) {
      elevateStatus('failed');
      warnings.push('没有任何闭环测点得到物理可解结果；扭矩误差指标为 NaN，禁止使用该次标定结果。');
    }
    if (unsolvedCount === closedLoopPoints.length) {
      elevateStatus('failed');
      warnings.push(`全部 ${unsolvedCount} 个闭环测功点求解失败（母线塌陷或超发电极限），标定不可信。`);
    } else if (unsolvedCount > 0) {
      elevateStatus('warn');
      warnings.push(`有 ${unsolvedCount}/${closedLoopPoints.length} 个闭环测点物理求解失败；拟合目标中施加大惩罚，最终 MAE/RMSE 只统计物理可解点，失败点在输出中保留为 NaN。`);
    }
    const maxAbsT = Math.max(...closedLoopPoints.map((p) => Math.abs(p.tNm)), 0.05);
    if (metrics.maeTorqueNm > Math.max(0.25, 0.8 * maxAbsT)) {
      elevateStatus('failed');
      warnings.push(
        `扭矩回代误差过大 (MAE=${metrics.maeTorqueNm.toFixed(4)} N·m, MAPE=${metrics.mapeTorquePct.toFixed(1)}%)，模型未能收敛到有效物理匹配；请核对扭矩单位、极对数或改用手动 KV/n0。`
      );
    } else if (metrics.maeTorqueNm > Math.max(0.05, 0.25 * maxAbsT) || metrics.mapeTorquePct > 25) {
      elevateStatus('warn');
      warnings.push(
        `扭矩回代偏差较高 (MAE=${metrics.maeTorqueNm.toFixed(4)} N·m, MAPE=${metrics.mapeTorquePct.toFixed(1)}%)${
          options.keSource === 'open_loop_auto'
            ? '；若开环最高空载点受调制比/限幅约束未达 m_norm≈1，提取的 Ke\' 会偏高，建议切换手动 KV 或 (n0, V_test)。'
            : '，请核对扭矩/功率单位及电机基础参数。'
        }`
      );
    }
  }

  const grid2D = buildEfficiencyGrid2D(evaluatedPoints, finalParams);
  if (grid2D.warning) {
    warnings.push(grid2D.warning);
    elevateStatus('warn');
  }

  return {
    status,
    warnings,
    kePrime,
    n0Rpm: calibratedN0Rpm,
    p0A,
    p0B,
    betaSat: bestBeta,
    rsAnchorOhm,
    rsEffOhm: bestRs,
    rsFitMode: options.rsFitMode,
    evaluatedPoints,
    metrics,
    validationMetrics,
    operatingEnvelope,
    paramSensitivity,
    grid2D,
    fitNotes,
  };
}

function pointInConvexHull(px: number, py: number, hull: Array<[number, number]>): boolean {
  if (hull.length < 3) return false;
  let twiceArea = 0;
  for (let i = 0; i < hull.length; i++) {
    const [x1, y1] = hull[i];
    const [x2, y2] = hull[(i + 1) % hull.length];
    twiceArea += x1 * y2 - x2 * y1;
  }
  if (!Number.isFinite(twiceArea) || Math.abs(twiceArea) <= 1e-12) return false;

  // Convex hull is returned in a consistent monotonic-chain order. Permit a
  // small edge tolerance for normalized floating-point coordinates but never
  // let a degenerate (collinear) three-point set claim the whole grid as inside.
  let sign = 0;
  for (let i = 0; i < hull.length; i++) {
    const [x1, y1] = hull[i];
    const [x2, y2] = hull[(i + 1) % hull.length];
    const cross = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
    if (Math.abs(cross) > 1e-10) {
      const current = cross > 0 ? 1 : -1;
      if (sign === 0) sign = current;
      else if (current !== sign) return false;
    }
  }
  return sign !== 0;
}

function convexHull(pts: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...pts]
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
    .sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]))
    .filter((p, i, arr) => i === 0 || p[0] !== arr[i - 1][0] || p[1] !== arr[i - 1][1]);
  if (sorted.length < 3) return [];
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Array<[number, number]> = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 1e-12) lower.pop();
    lower.push(point);
  }
  const upper: Array<[number, number]> = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const point = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 1e-12) upper.pop();
    upper.push(point);
  }
  upper.pop();
  lower.pop();
  const hull = lower.concat(upper);
  if (hull.length < 3) return [];
  let twiceArea = 0;
  for (let i = 0; i < hull.length; i++) {
    const [x1, y1] = hull[i];
    const [x2, y2] = hull[(i + 1) % hull.length];
    twiceArea += x1 * y2 - x2 * y1;
  }
  return Math.abs(twiceArea) > 1e-12 ? hull : [];
}

export function buildEfficiencyGrid2D(
  points: EvaluatedDynoPoint[],
  params: MotorParams
): EfficiencyGrid2D {
  const nGrid = 28;
  const tGrid = 22;

  const busVoltages = points.map((p) => p.vBusV).filter((v) => Number.isFinite(v) && v > 0);
  if (busVoltages.length !== points.length || busVoltages.length < 4) {
    return {
      speeds: [], torques: [], zMeasured: [], zPredicted: [], minEta: 0, maxEta: 100,
      warning: '效率 Map 缺少完整、有效的 Vbus 数据；禁止将未知母线条件混合插值。',
    };
  }
  const minVbus = Math.min(...busVoltages);
  const maxVbus = Math.max(...busVoltages);
  const meanVbus = busVoltages.reduce((sum, v) => sum + v, 0) / busVoltages.length;
  const vbusSpreadPct = meanVbus > 0 ? ((maxVbus - minVbus) / meanVbus) * 100 : Infinity;
  if (vbusSpreadPct > 5) {
    return {
      speeds: [], torques: [], zMeasured: [], zPredicted: [], minEta: 0, maxEta: 100,
      warning: `效率 Map 的 Vbus 范围为 ${minVbus.toFixed(2)}～${maxVbus.toFixed(2)}V（相对均值跨度 ${vbusSpreadPct.toFixed(1)}%）；速度-扭矩二维图不能混合不同母线电压平面，已阻止生成误导性插值。请按 Vbus 分组生成独立 Map。`,
    };
  }

  const uniqueSpeeds = new Set(points.map((p) => Math.round(p.nRpm * 10))).size;
  const uniqueTorques = new Set(points.map((p) => Math.round(p.tNm * 1e4))).size;

  if (points.length < 4 || uniqueSpeeds < 2 || uniqueTorques < 2) {
    return {
      speeds: [],
      torques: [],
      zMeasured: [],
      zPredicted: [],
      minEta: 0,
      maxEta: 100,
    };
  }

  const minN = Math.min(...points.map((p) => p.nRpm));
  const maxN = Math.max(...points.map((p) => p.nRpm));
  const minT = Math.min(...points.map((p) => p.tNm));
  const maxT = Math.max(...points.map((p) => p.tNm));

  const spanN = Math.max(10, maxN - minN);
  const spanT = Math.max(0.01, maxT - minT);

  const speeds = Array.from({ length: nGrid }, (_, i) => minN + (spanN * i) / (nGrid - 1));
  const torques = Array.from({ length: tGrid }, (_, j) => minT + (spanT * j) / (tGrid - 1));

    const normPts = points.map((p) => ({
    nx: (p.nRpm - minN) / spanN,
    ny: (p.tNm - minT) / spanT,
    etaM: Number.isFinite(p.etaMeas) ? p.etaMeas * 100 : Number.NaN,
    vBus: p.vBusV,
  }));
  const hull = convexHull(normPts.map((p) => [p.nx, p.ny]));
  // Missing/invalid measured efficiency rows may still constrain the model's
  // operating envelope, but must never expand the measured-efficiency hull.
  const measuredEtaPoints = normPts.filter((p) => Number.isFinite(p.etaM));
  const measuredHull = convexHull(measuredEtaPoints.map((p) => [p.nx, p.ny]));

  const interpAt = (nx: number, ny: number, field: 'etaM' | 'vBus'): number => {
    let wSum = 0;
    let vSum = 0;
    for (const p of normPts) {
      const val = p[field];
      if (!Number.isFinite(val)) continue;
      const d2 = (nx - p.nx) ** 2 + (ny - p.ny) ** 2;
      if (d2 < 1e-8) return val;
      const w = 1 / Math.pow(d2, 1.5);
      wSum += w;
      vSum += w * val;
    }
    return wSum > 0 ? vSum / wSum : Number.NaN;
  };

  const zMeasured: Array<Array<number | null>> = [];
  const zPredicted: Array<Array<number | null>> = [];
  let minEta = Infinity;
  let maxEta = -Infinity;

  for (let j = 0; j < tGrid; j++) {
    const rowM: Array<number | null> = [];
    const rowP: Array<number | null> = [];
    const ny = (torques[j] - minT) / spanT;

    for (let i = 0; i < nGrid; i++) {
      const nx = (speeds[i] - minN) / spanN;
      const insideModelEnvelope = pointInConvexHull(nx, ny, hull);
      if (!insideModelEnvelope) {
        rowM.push(null);
        rowP.push(null);
        continue;
      }

      const insideMeasuredEnvelope = pointInConvexHull(nx, ny, measuredHull);
      const rawValM = insideMeasuredEnvelope ? interpAt(nx, ny, 'etaM') : Number.NaN;
      const valM = Number.isFinite(rawValM) ? Math.max(0, Math.min(99.5, rawValM)) : null;
      const localVbus = interpAt(nx, ny, 'vBus');
      const omegaM = calcOmegaM(speeds[i]);
      const p0 = calcP0LossW(speeds[i], params.p0A, params.p0B);
      const tEm = torques[j] + (Math.abs(omegaM) > 1e-6 ? p0 / omegaM : 0);
      const kt0 = Math.max(1e-6, 1.5 * params.kePrime);
      const beta = Math.max(0, params.betaSat);

      let iq: number | null = null;
      if (beta * Math.abs(tEm) < 1e-9) {
        iq = tEm / kt0;
      } else {
        const discSat = kt0 * kt0 - 4 * beta * tEm * tEm;
        if (discSat >= 0) {
          iq = (kt0 - Math.sqrt(discSat)) / (2 * beta * tEm);
        }
      }

      let valP: number | null = null;
      if (iq !== null && Number.isFinite(iq)) {
        const fwd = forwardVerifyPoint(iq, speeds[i], localVbus, params);
        if (!fwd.alerts.invalidBus && !fwd.alerts.cmdSat && Number.isFinite(fwd.etaEst)) {
          valP = Math.max(0, Math.min(99.5, fwd.etaEst * 100));
        }
      }

      rowM.push(valM);
      rowP.push(valP);
      if (valM !== null) {
        minEta = Math.min(minEta, valM);
        maxEta = Math.max(maxEta, valM);
      }
      if (valP !== null) {
        minEta = Math.min(minEta, valP);
        maxEta = Math.max(maxEta, valP);
      }
    }
    zMeasured.push(rowM);
    zPredicted.push(rowP);
  }

  if (!Number.isFinite(minEta)) {
    minEta = 0;
    maxEta = 100;
  }

  return {
    speeds,
    torques,
    zMeasured,
    zPredicted,
    minEta: Math.floor(minEta / 5) * 5,
    maxEta: Math.min(100, Math.ceil(maxEta / 5) * 5),
    ...(measuredHull.length < 3 ? { warning: `有效测量效率点仅 ${measuredEtaPoints.length} 个或几何分布退化；实测效率图不生成，只保留模型预测在运行包络内的结果。` } : {}),
  };
}
