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
}

export interface CalibrationReport {
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
  grid2D: EfficiencyGrid2D;
  fitNotes: string[];
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

export function parseCsvText(csvText: string, fileName = 'data.csv'): TabularDataset {
  const lines = csvText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

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
    T_Nm: findCol([/^t_?nm$/, /^t_?mnm$/, /torque/, /^t_/, /扭矩/, /转矩/]),
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
  const rawEtas: number[] = [];
  const poutDiscrepancies: number[] = [];

  for (const row of dataset.rows) {
    const num = (col: string): number => {
      if (!col) return Number.NaN;
      const raw = row[col];
      if (raw === null || raw === undefined || typeof raw === 'boolean') return Number.NaN;
      if (typeof raw === 'string' && raw.trim() === '') return Number.NaN;
      const v = Number(raw);
      return Number.isFinite(v) ? v : Number.NaN;
    };

    const nRpm = num(mapping.n_rpm);
    const vBusV = num(mapping.V_bus);
    const iBusA = num(mapping.I_bus);
    const tRaw = num(mapping.T_Nm);
    let tNm = Number.isFinite(tRaw) ? torqueToNm(tRaw, torqueUnit) : Number.NaN;

    if (!Number.isFinite(nRpm) || !Number.isFinite(vBusV) || !Number.isFinite(iBusA)) {
      continue;
    }

    let pInW = num(mapping.P_in);
    if (!Number.isFinite(pInW)) {
      pInW = vBusV * iBusA;
    }

    let pOutW = num(mapping.P_out);
    if (!Number.isFinite(tNm) && Number.isFinite(pOutW) && Math.abs(nRpm) > 1e-6) {
      tNm = pOutW / calcOmegaM(nRpm);
    }

    if (!Number.isFinite(tNm)) {
      if (options.requireTorque && mapping.T_Nm) {
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
    } else {
      etaMeas = pInW > 1e-6 && pOutW >= 0 ? pOutW / pInW : 0;
    }

    out.push({
      nRpm,
      tNm,
      vBusV,
      iBusA,
      pInW,
      pOutW,
      etaMeas: Math.max(0, Math.min(1.0, etaMeas)),
    });
  }

  if (droppedTorqueCount > 0) {
    warnings.push(`已剔除 ${droppedTorqueCount} 条缺失扭矩的无效行（避免被当成 0 N·m 污染标定与 MAE）`);
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
  if (poutDiscrepancies.length > 0) {
    const medDisc = [...poutDiscrepancies].sort((a, b) => a - b)[Math.floor(poutDiscrepancies.length / 2)];
    if (medDisc > 0.15) {
      warnings.push(`实测 P_out 列与换算后的 T_Nm × ω_m 偏差达 ${(medDisc * 100).toFixed(0)}%，请核对扭矩单位或 P_out 单位`);
    }
  }

  return { points: out, warnings };
}

function fitNonNegLinearP0(samples: Array<{ n: number; p0: number }>): { a: number; b: number } {
  if (samples.length === 0) return { a: 0, b: 0 };
  let s11 = 0;
  let s12 = 0;
  let s22 = 0;
  let r1 = 0;
  let r2 = 0;
  for (const s of samples) {
    const x1 = s.n;
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
      const err = a * s.n + b * s.n * s.n - s.p0;
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
  }
): CalibrationReport {
  const fitNotes: string[] = [];

  // Step 1: Determine Ke' and n0Rpm
  let kePrime = baseParams.kePrime;
  let calibratedN0Rpm = baseParams.n0Rpm;

  if (options.keSource === 'manual_n0_vtest') {
    kePrime = calcKeFromNoLoad(options.manualVTestV, options.manualN0Rpm);
    calibratedN0Rpm = options.manualN0Rpm;
    fitNotes.push(`Step 1: 由手动空载点 (${options.manualN0Rpm.toFixed(0)} RPM, ${options.manualVTestV.toFixed(2)} V) 锁定 Ke' = ${kePrime.toFixed(5)} Vpeak/(rad/s)`);
  } else if (options.keSource === 'manual_kv') {
    kePrime = calcKeFromKv(options.manualKv);
    fitNotes.push(`Step 1: 由 KV = ${options.manualKv.toFixed(1)} RPM/V 锁定 Ke' = ${kePrime.toFixed(5)} Vpeak/(rad/s)`);
  } else if (openLoopPoints.length > 0) {
    const validOl = openLoopPoints.filter((pt) => pt.nRpm > 50 && pt.vBusV > 0.5);
    if (validOl.length > 0) {
      const sortedBySpeed = [...validOl].sort((a, b) => b.nRpm - a.nRpm);
      const top = sortedBySpeed[0];
      kePrime = calcKeFromNoLoad(top.vBusV, top.nRpm);
      calibratedN0Rpm = top.nRpm;
      fitNotes.push(`Step 1: 由开环最高空载点 (${top.nRpm.toFixed(0)} RPM @ ${top.vBusV.toFixed(2)} V) 提取 Ke' = ${kePrime.toFixed(5)} Vpeak/(rad/s)`);
    }
  } else {
    fitNotes.push(`Step 1: 沿用当前设定 Ke' = ${kePrime.toFixed(5)} Vpeak/(rad/s)`);
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

  const { a: p0A, b: p0B } = fitNonNegLinearP0(p0Samples);
  fitNotes.push(`Step 2 结果: a = ${p0A.toExponential(3)} W/RPM, b = ${p0B.toExponential(3)} W/RPM²`);

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
        const etaErr = Number.isFinite(res.etaEst) ? res.etaEst - pt.etaMeas : 0;
        loss += tErr * tErr + 0.01 * etaErr * etaErr;
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

  const evaluatedPoints: EvaluatedDynoPoint[] = closedLoopPoints.map((pt) => {
    const res = solveSinglePoint(pt.vBusV, pt.iBusA, pt.nRpm, finalParams);
    const pInvLossW = Math.max(0, pt.pInW - res.pElecW);
    const pCuLossW = Number.isFinite(res.pCuW) ? res.pCuW : 0;
    const pIronWindLossW = res.p0W;
    const tEstNm = Number.isFinite(res.tEstNm) ? res.tEstNm : 0;
    const etaEst = Number.isFinite(res.etaEst) ? res.etaEst : 0;
    const pOutEstW = Number.isFinite(res.pOutW) ? res.pOutW : 0;
    const iqEstA = Number.isFinite(res.iqA) ? res.iqA : 0;
    return {
      ...pt,
      iqEstA,
      tEstNm,
      pOutEstW,
      etaEst,
      pInvLossW,
      pCuLossW,
      pIronWindLossW,
      errTorqueNm: tEstNm - pt.tNm,
      errEta: etaEst - pt.etaMeas,
    };
  });

  let sumAbsT = 0;
  let sumSqT = 0;
  let sumPctT = 0;
  let countPctT = 0;
  let sumAbsEta = 0;
  let sumSqEta = 0;
  let sumPctEta = 0;
  let countPctEta = 0;

  for (const p of evaluatedPoints) {
    sumAbsT += Math.abs(p.errTorqueNm);
    sumSqT += p.errTorqueNm * p.errTorqueNm;
    if (Math.abs(p.tNm) > 0.015) {
      sumPctT += (Math.abs(p.errTorqueNm) / Math.abs(p.tNm)) * 100;
      countPctT++;
    }
    const etaDiffPct = (p.etaEst - p.etaMeas) * 100;
    sumAbsEta += Math.abs(etaDiffPct);
    sumSqEta += etaDiffPct * etaDiffPct;
    if (p.etaMeas > 0.1) {
      sumPctEta += (Math.abs(p.etaEst - p.etaMeas) / p.etaMeas) * 100;
      countPctEta++;
    }
  }

  const nPts = Math.max(1, evaluatedPoints.length);
  const metrics: ErrorMetrics = {
    maeTorqueNm: sumAbsT / nPts,
    rmseTorqueNm: Math.sqrt(sumSqT / nPts),
    mapeTorquePct: countPctT > 0 ? sumPctT / countPctT : 0,
    maeEtaPct: sumAbsEta / nPts,
    rmseEtaPct: Math.sqrt(sumSqEta / nPts),
    mapeEtaPct: countPctEta > 0 ? sumPctEta / countPctEta : 0,
  };

  const grid2D = buildEfficiencyGrid2D(evaluatedPoints, finalParams);

  return {
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
    grid2D,
    fitNotes,
  };
}

function pointInConvexHull(px: number, py: number, hull: Array<[number, number]>): boolean {
  if (hull.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < hull.length; i++) {
    const [x1, y1] = hull[i];
    const [x2, y2] = hull[(i + 1) % hull.length];
    const cross = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
    if (Math.abs(cross) > 1e-12) {
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

function convexHull(pts: Array<[number, number]>): Array<[number, number]> {
  if (pts.length <= 3) return pts;
  const sorted = [...pts].sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Array<[number, number]> = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Array<[number, number]> = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export function buildEfficiencyGrid2D(
  points: EvaluatedDynoPoint[],
  params: MotorParams
): EfficiencyGrid2D {
  const nGrid = 28;
  const tGrid = 22;

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
    etaM: p.etaMeas * 100,
    etaP: p.etaEst * 100,
  }));
  const hull = convexHull(normPts.map((p) => [p.nx, p.ny]));

  const interpAt = (nx: number, ny: number, field: 'etaM' | 'etaP'): number => {
    let wSum = 0;
    let vSum = 0;
    for (const p of normPts) {
      const d2 = (nx - p.nx) ** 2 + (ny - p.ny) ** 2;
      if (d2 < 1e-8) return p[field];
      const w = 1 / Math.pow(d2, 1.5);
      wSum += w;
      vSum += w * p[field];
    }
    return wSum > 0 ? vSum / wSum : 0;
  };

  const zMeasured: Array<Array<number | null>> = [];
  const zPredicted: Array<Array<number | null>> = [];
  let minEta = Infinity;
  let maxEta = -Infinity;
  const avgVbus = points.reduce((acc, p) => acc + p.vBusV, 0) / points.length;

  for (let j = 0; j < tGrid; j++) {
    const rowM: Array<number | null> = [];
    const rowP: Array<number | null> = [];
    const ny = (torques[j] - minT) / spanT;

    for (let i = 0; i < nGrid; i++) {
      const nx = (speeds[i] - minN) / spanN;
      const inside = pointInConvexHull(nx, ny, hull);
      if (!inside) {
        rowM.push(null);
        rowP.push(null);
        continue;
      }

      const valM = Math.max(0, Math.min(99.5, interpAt(nx, ny, 'etaM')));
      const omegaM = calcOmegaM(speeds[i]);
      const p0 = calcP0LossW(speeds[i], params.p0A, params.p0B);
      const tEm = torques[j] + (Math.abs(omegaM) > 1e-6 ? p0 / omegaM : 0);
      const kt0 = Math.max(1e-6, 1.5 * params.kePrime);
      const beta = Math.max(0, params.betaSat);

      let iq: number;
      if (beta * Math.abs(tEm) < 1e-9) {
        iq = tEm / kt0;
      } else {
        const discSat = kt0 * kt0 - 4 * beta * tEm * tEm;
        if (discSat >= 0) {
          iq = (kt0 - Math.sqrt(discSat)) / (2 * beta * tEm);
        } else {
          iq = (tEm >= 0 ? 1 : -1) / Math.sqrt(beta);
        }
      }

      const fwd = forwardVerifyPoint(iq, speeds[i], avgVbus, params);
      const valP =
        !fwd.alerts.invalidBus && Number.isFinite(fwd.etaEst)
          ? Math.max(0, Math.min(99.5, fwd.etaEst * 100))
          : 0;

      rowM.push(valM);
      rowP.push(valP);
      minEta = Math.min(minEta, valM, valP);
      maxEta = Math.max(maxEta, valM, valP);
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
  };
}
