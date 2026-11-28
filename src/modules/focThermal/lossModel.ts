/**
 * FOC 6-MOS Device Loss Model, Rds(on)-Tj Curves & Sensorless PWM Duty Reconstruction
 */
import { evaluateNonlinearEossUj } from "../thermalEngine";
import {
  DptAxisName,
  DptLutStatus,
  DptParameterProvenance,
  interpolateDptSwitchingLoss,
} from "../dptAnalyzer";
import {
  FocModulationMode,
  FocMosParams,
  RdsOnTempCurve,
  RdsOnTempCurveImportDocument,
  RdsOnTempCurvePoint,
  RdsOnTempCurveProvenance,
  getModulationLinearCeiling,
} from "./types";

export function validateRdsOnTempCurve(curve: RdsOnTempCurve): void {
  if (!curve || curve.schema !== 'wave-test-rdson-temperature' || curve.schemaVersion !== 1 ||
      curve.referenceTemperatureC !== 25 || !Array.isArray(curve.points) || curve.points.length < 3) {
    throw new Error('Rds(on)-Tj 曲线格式无效：需要 wave-test-rdson-temperature v1、25°C 参考点和至少 3 个数据点。');
  }
  if (!Number.isFinite(curve.referenceGateVoltageV) || curve.referenceGateVoltageV <= 0 || curve.referenceGateVoltageV > 30) {
    throw new Error('Rds(on)-Tj 曲线必须填写有效的参考栅极驱动电压 Vgs（0～30V）。');
  }
  if (!['datasheet', 'measured', 'user_import', 'assumed'].includes(curve.provenance)) {
    throw new Error(`Rds(on)-Tj 曲线来源无效：${String(curve.provenance)}。`);
  }
  let previousT = -Infinity;
  let previousRatio = 0;
  for (let i = 0; i < curve.points.length; i++) {
    const point = curve.points[i];
    if (!point || !Number.isFinite(point.tjC) || !Number.isFinite(point.ratioTo25C) ||
        point.tjC < -100 || point.tjC > 250 || point.ratioTo25C < 0.05 || point.ratioTo25C > 10) {
      throw new Error(`Rds(on)-Tj 曲线第 ${i + 1} 点无效：温度需在 -100～250°C，归一化比值需在 0.05～10。`);
    }
    if (point.tjC <= previousT) throw new Error('Rds(on)-Tj 曲线温度轴必须严格递增，不能重复或倒序。');
    if (i > 0 && point.ratioTo25C + 0.02 < previousRatio) {
      throw new Error('当前低压硅 MOS Rds(on)-Tj 曲线出现明显负温度系数段；请检查单位、数据提取和器件工作区。');
    }
    previousT = point.tjC;
    previousRatio = point.ratioTo25C;
  }
  const at25 = interpolateRdsOnTempCurveUnchecked(curve, 25);
  if (Math.abs(at25 - 1) > 0.05) {
    throw new Error(`Rds(on)-Tj 曲线在 25°C 的归一化值应为 1.0，当前插值为 ${at25.toFixed(4)}；请确认归一化基准。`);
  }
}

function interpolateRdsOnTempCurveUnchecked(curve: RdsOnTempCurve, tjC: number): number {
  const points = curve.points;
  if (tjC < points[0].tjC - 1e-9 || tjC > points[points.length - 1].tjC + 1e-9) {
    throw new Error(`MOS 结温 ${tjC.toFixed(2)}°C 超出 Rds(on)-Tj 曲线范围 [${points[0].tjC}°C, ${points[points.length - 1].tjC}°C]；禁止线性外推。`);
  }
  if (tjC <= points[0].tjC) return points[0].ratioTo25C;
  if (tjC >= points[points.length - 1].tjC) return points[points.length - 1].ratioTo25C;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].tjC <= tjC) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const u = (tjC - a.tjC) / (b.tjC - a.tjC);
  return a.ratioTo25C + u * (b.ratioTo25C - a.ratioTo25C);
}

export function evaluateRdsOnTempCurveRatio(curve: RdsOnTempCurve, tjC: number): number {
  validateRdsOnTempCurve(curve);
  if (!Number.isFinite(tjC)) throw new Error('MOS 结温查询值必须为有限数值。');
  return interpolateRdsOnTempCurveUnchecked(curve, tjC);
}

export function parseRdsOnTempCurveImportJson(text: string): RdsOnTempCurve {
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch (err) { throw new Error(`Rds(on)-Tj JSON 解析失败：${err instanceof Error ? err.message : String(err)}`); }
  if (!raw || typeof raw !== 'object') throw new Error('Rds(on)-Tj 导入文件必须是 JSON 对象。');
  const doc = raw as Partial<RdsOnTempCurveImportDocument>;
  const curve = doc as RdsOnTempCurve;
  validateRdsOnTempCurve(curve);
  return {
    ...curve,
    points: curve.points.map((point) => ({ tjC: Number(point.tjC), ratioTo25C: Number(point.ratioTo25C) })),
  };
}

export function createRdsOnTempCurveImportTemplate(): RdsOnTempCurveImportDocument {
  return {
    schema: 'wave-test-rdson-temperature',
    schemaVersion: 1,
    referenceTemperatureC: 25,
    referenceGateVoltageV: 10,
    provenance: 'datasheet',
    label: '请替换为目标 MOS 数据手册 Rds(on)-Tj 归一化曲线',
    manufacturer: '',
    partNumber: '',
    points: [],
  };
}

export function validateRdsOnTempCurveForMos(mos: FocMosParams): void {
  const curve = mos.rdsOnTempCurve;
  if (!curve) return;
  validateRdsOnTempCurve(curve);
  const operatingVgs = mos.rdsOperatingVgsV;
  if (!Number.isFinite(operatingVgs) || (operatingVgs as number) <= 0 || (operatingVgs as number) > 30) {
    throw new Error('使用 Rds(on)-Tj 曲线时，必须填写 MOS 实际导通栅源电压 Vgs,on（0～30 V）；不能只填写曲线测试条件。');
  }
  if (Math.abs((operatingVgs as number) - curve.referenceGateVoltageV) > 0.1) {
    throw new Error(`Rds(on)-Tj 曲线测试 Vgs=${curve.referenceGateVoltageV.toFixed(2)} V，与当前实际 Vgs,on=${(operatingVgs as number).toFixed(2)} V 不一致（允许偏差 ±0.10 V）；请导入匹配实际驱动条件的曲线。`);
  }
  const rds25ReferenceVgs = mos.rds25ReferenceVgsV;
  if (!Number.isFinite(rds25ReferenceVgs) || (rds25ReferenceVgs as number) <= 0 || (rds25ReferenceVgs as number) > 30) {
    throw new Error('使用 Rds(on)-Tj 曲线时，必须填写 Rds(on)@25°C 绝对值对应的数据手册/实测 Vgs（0～30 V）。');
  }
  if (Math.abs((rds25ReferenceVgs as number) - curve.referenceGateVoltageV) > 0.1) {
    throw new Error(`Rds(on)@25°C 的参考 Vgs=${(rds25ReferenceVgs as number).toFixed(2)} V，与 Rds(on)-Tj 曲线参考 Vgs=${curve.referenceGateVoltageV.toFixed(2)} V 不一致（允许偏差 ±0.10 V）；归一化比例不能修正不同 Vgs 下的绝对 Rds 差异。`);
  }
}

export function getFocMosRdsFactorAtTj(mos: FocMosParams, tjC: number): number {
  if (mos.rdsOnTempCurve) {
    validateRdsOnTempCurveForMos(mos);
    return interpolateRdsOnTempCurveUnchecked(mos.rdsOnTempCurve, tjC);
  }
  // Preserve the legacy alpha model's lower clamp and runaway behavior. The
  // curve path has its own bounded ratios and never extrapolates out of range.
  const factor = Math.max(0.1, 1 + (mos.tempCoeffAlphaPerC || 0) * (tjC - 25));
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error(`Rds(on) 温度修正系数异常：Tj=${tjC.toFixed(2)}°C，factor=${factor}。`);
  }
  return factor;
}


/**
 * Computes sensorless high-side duties d_a, d_b, d_c from phase currents Ia, Ib, Ic using Clarke transform.
 * Reports overmodulation if requested m > linear ceiling of chosen modulation strategy or any phase duty saturates.
 */
export function computeDutyFromVoltageAngle(
  thetaV: number,
  modulation: FocModulationMode,
  modDepthM: number
): { da: number; db: number; dc: number; overmodulated: boolean; linearCeilingM: number } {
  const linearCeilingM = getModulationLinearCeiling(modulation);
  const reqM = Math.max(0, modDepthM);
  if (reqM <= 1e-6) {
    return { da: 0.5, db: 0.5, dc: 0.5, overmodulated: false, linearCeilingM };
  }
  const m = Math.min(1.2, reqM);
  const twoPi3 = (2 * Math.PI) / 3;
  const ua = m * Math.cos(thetaV);
  const ub = m * Math.cos(thetaV - twoPi3);
  const uc = m * Math.cos(thetaV + twoPi3);
  let u0 = 0;
  if (modulation === 'SVPWM') {
    u0 = -0.5 * (Math.max(ua, ub, uc) + Math.min(ua, ub, uc));
  } else if (modulation === 'DPWM1') {
    const absA = Math.abs(ua);
    const absB = Math.abs(ub);
    const absC = Math.abs(uc);
    let uk = ua;
    if (absB >= absA && absB >= absC) uk = ub;
    else if (absC >= absA && absC >= absB) uk = uc;
    u0 = (uk >= 0 ? 1 : -1) - uk;
  }
  const rawA = 0.5 + 0.5 * (ua + u0);
  const rawB = 0.5 + 0.5 * (ub + u0);
  const rawC = 0.5 + 0.5 * (uc + u0);
  const overmodulated = reqM > linearCeilingM + 1e-6 ||
    rawA < -1e-6 || rawA > 1 + 1e-6 ||
    rawB < -1e-6 || rawB > 1 + 1e-6 ||
    rawC < -1e-6 || rawC > 1 + 1e-6;
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  return { da: clamp01(rawA), db: clamp01(rawB), dc: clamp01(rawC), overmodulated, linearCeilingM };
}

/**
 * Computes sensorless high-side duties d_a, d_b, d_c from phase currents Ia, Ib, Ic using Clarke transform.
 * Reports overmodulation if requested m > linear ceiling of chosen modulation strategy or any phase duty saturates.
 */
export function reconstructSensorlessDutySample(
  ia: number,
  ib: number,
  ic: number,
  modulation: FocModulationMode,
  modDepthM: number,
  pfAngleDeg: number
): { da: number; db: number; dc: number; overmodulated: boolean; linearCeilingM: number; zeroCurrentFallback: boolean } {
  const sqrt3Inv = 1 / Math.sqrt(3);
  const iAlpha = (2 / 3) * (ia - 0.5 * (ib + ic));
  const iBeta = (ib - ic) * sqrt3Inv;
  const mag = Math.hypot(iAlpha, iBeta);
  if (mag < 1e-6) {
    return { ...computeDutyFromVoltageAngle(0, modulation, modDepthM), zeroCurrentFallback: true };
  }
  const thetaI = Math.atan2(iBeta, iAlpha);
  const thetaV = thetaI + (pfAngleDeg * Math.PI) / 180;
  return { ...computeDutyFromVoltageAngle(thetaV, modulation, modDepthM), zeroCurrentFallback: false };
}

/**
 * Computes instantaneous per-MOS conduction, hard-switching + Qrr, and dead-time body-diode losses
 * for one half-bridge phase (H = upper switch, L = lower switch), conserving high + low + dead-time period.
 */
/** Enforce one consistent energy boundary for datasheet Qr and separate Eoss. */
export function validateMosEnergyAccounting(mos: FocMosParams): void {
  if (mos.qrrReferenceVdsV !== undefined && (!Number.isFinite(mos.qrrReferenceVdsV) || mos.qrrReferenceVdsV <= 0)) {
    throw new Error('Qr/Qrr 参考测试 VDS 必须为有限正数。');
  }
  if (mos.qrrReferenceDiDtAperUs !== undefined && (!Number.isFinite(mos.qrrReferenceDiDtAperUs) || Math.abs(mos.qrrReferenceDiDtAperUs) <= 0 || Math.abs(mos.qrrReferenceDiDtAperUs) > 1e5)) {
    throw new Error('Qr/Qrr 参考 di/dt 必须为有限非零数值，单位 A/µs。');
  }
  if (mos.qrrReferenceTjC !== undefined && (!Number.isFinite(mos.qrrReferenceTjC) || mos.qrrReferenceTjC < -100 || mos.qrrReferenceTjC > 250)) {
    throw new Error('Qr/Qrr 参考结温必须位于 -100～250°C。');
  }
  if (mos.qrrReferenceVgsV !== undefined && (!Number.isFinite(mos.qrrReferenceVgsV) || mos.qrrReferenceVgsV < -20 || mos.qrrReferenceVgsV > 20)) {
    throw new Error('Qr/Qrr 参考测试 VGS 必须位于 -20～20V。');
  }
  const qrrIsActive = !mos.dptLut?.length && mos.qrrNc > 0 && mos.eonIncludesQrr !== true;
  const separateEossIsActive = mos.eossAlreadyIncludedInEsw !== true &&
    (Boolean(mos.eossCurve) || (mos.eossUj ?? 0) > 0);
  if (mos.qrrIncludesQoss === true && qrrIsActive && separateEossIsActive) {
    throw new Error(
      '当前 Qr 数据已包含 Qoss/电容性恢复；不能在同一标量换流能量账本中再独立叠加 Eoss。请清空 Eoss/曲线，或使用明确分离 Qs、Qoss 与互补管 Eoss 的 DPT 事件能量模型。'
    );
  }
}

export function qossCoveredByQr(mos: FocMosParams): boolean {
  return !mos.dptLut?.length && mos.qrrIncludesQoss === true && mos.qrrNc > 0 && mos.eonIncludesQrr !== true;
}

/**
 * Pick an initial probe/seed junction temperature clamped into any configured
 * Rds(on)-Tj curve and 4D DPT LUT Tj bounds so hot-range LUTs (e.g. [50, 150]°C)
 * do not spuriously fail OUT_OF_RANGE on the initial 25°C reference probe.
 */
export function resolveInitialThermalProbeTjC(mos: FocMosParams, preferredTjC: number): number {
  let lo = -Infinity;
  let hi = Infinity;
  if (mos.rdsOnTempCurve && mos.rdsOnTempCurve.points.length > 0) {
    lo = Math.max(lo, mos.rdsOnTempCurve.points[0].tjC);
    hi = Math.min(hi, mos.rdsOnTempCurve.points[mos.rdsOnTempCurve.points.length - 1].tjC);
  }
  if (mos.dptLut && mos.dptLut.length > 0) {
    let lutMin = Infinity;
    let lutMax = -Infinity;
    for (const pt of mos.dptLut) {
      if (Number.isFinite(pt.tjC)) {
        if (pt.tjC < lutMin) lutMin = pt.tjC;
        if (pt.tjC > lutMax) lutMax = pt.tjC;
      }
    }
    if (Number.isFinite(lutMin) && Number.isFinite(lutMax) && lutMin <= lutMax) {
      lo = Math.max(lo, lutMin);
      hi = Math.min(hi, lutMax);
    }
  }
  const base = Number.isFinite(preferredTjC) ? preferredTjC : 25;
  if (lo <= hi) {
    return Math.max(lo, Math.min(hi, base));
  }
  return base;
}

export function computePhaseMosLosses(
  iPhase: number,
  dutyHigh: number,
  vBus: number,
  tjHighC: number,
  tjLowC: number,
  _modulation: FocModulationMode,
  fswHz: number,
  tDeadNs: number,
  mos: FocMosParams
): {
  pHighTotal: number;
  pLowTotal: number;
  pHighCond: number;
  pLowCond: number;
  pHighCond25W: number;
  pLowCond25W: number;
  pHighSw: number;
  pLowSw: number;
  pHighDead: number;
  pLowDead: number;
  lutStatus?: DptLutStatus;
  lutActiveDims?: DptAxisName[];
  lutCollapsedDims?: DptAxisName[];
  lutExtrapolated?: boolean;
  lutTjProvenance?: DptParameterProvenance;
  lutRgProvenance?: DptParameterProvenance;
  eossOutOfRange?: boolean;
} {
  if (!Number.isFinite(iPhase)) throw new Error('相电流必须为有限数值。');
  if (!Number.isFinite(dutyHigh) || dutyHigh < 0 || dutyHigh > 1) {
    throw new Error(`PWM 高侧占空比必须位于 0～1，当前值=${String(dutyHigh)}。`);
  }
  if (!Number.isFinite(vBus) || vBus < 0) throw new Error('母线电压必须为有限非负数值。');
  if (!Number.isFinite(tjHighC) || !Number.isFinite(tjLowC)) throw new Error('上下管结温必须为有限数值。');
  if (!Number.isFinite(fswHz) || fswHz < 0 || fswHz > 5e6) throw new Error('PWM 频率必须为 0～5 MHz 的有限数值。');
  if (!Number.isFinite(tDeadNs) || tDeadNs < 0 || tDeadNs > 1e6) throw new Error('死区时间必须为 0～1,000,000 ns 的有限数值。');
  if (!Number.isFinite(mos.rdsOn25Mohm) || mos.rdsOn25Mohm <= 0) throw new Error('MOS Rds(on)@25°C 必须为有限正数。');
  if (!Number.isFinite(mos.vsdV) || mos.vsdV < 0 || mos.vsdV > 10) throw new Error('MOS 体二极管压降 Vsd 必须为 0～10 V 的有限数值。');
  if (!mos.rdsOnTempCurve && (!Number.isFinite(mos.tempCoeffAlphaPerC) || mos.tempCoeffAlphaPerC < 0 || mos.tempCoeffAlphaPerC > 0.05)) throw new Error('MOS Rds 温度系数 α 必须为 0～0.05 /°C 的有限数值。');
  if (!Number.isFinite(mos.vRefV) || mos.vRefV <= 0 || !Number.isFinite(mos.iRefA) || mos.iRefA <= 0) {
    throw new Error('Eon/Eoff 参考电压 Vref 和参考电流 Iref 必须为有限正数。');
  }
  if (mos.qrrIrefA !== undefined && (!Number.isFinite(mos.qrrIrefA) || mos.qrrIrefA <= 0)) {
    throw new Error('Qr/Qrr 独立参考电流 qrrIrefA 必须为有限正数。');
  }
  validateMosEnergyAccounting(mos);
  if (!Number.isFinite(mos.eonPlusEoffUj) || mos.eonPlusEoffUj < 0 ||
      !Number.isFinite(mos.qrrNc) || mos.qrrNc < 0 ||
      (mos.eossUj !== undefined && (!Number.isFinite(mos.eossUj) || mos.eossUj < 0))) {
    throw new Error('Eon+Eoff、Qrr 和 Eoss 必须为有限非负数值。');
  }
  const d = dutyHigh;
  const r25 = Math.max(1e-6, mos.rdsOn25Mohm * 1e-3);
  const rdsFactorHigh = getFocMosRdsFactorAtTj(mos, tjHighC);
  const rdsFactorLow = getFocMosRdsFactorAtTj(mos, tjLowC);
  const ronH = Math.max(1e-6, r25 * rdsFactorHigh);
  const ronL = Math.max(1e-6, r25 * rdsFactorLow);

  // PWM command duty is reduced by one dead-time interval at each active edge:
  // D_H,cond = d - t_dead*fsw; D_L,cond = (1-d) - t_dead*fsw.
  // Both dead-time intervals are carried by the same body diode for a given
  // current direction (low-side diode for positive phase current, high-side for
  // negative current). Do not subtract the full 2*t_dead*fsw from only one
  // channel: that preserves total leg loss but biases the individual MOS losses.
  // Only a mathematically clamped leg (0% or 100% within floating-point noise)
  // is treated as having no recurring PWM edges. A small but non-zero pulse is
  // still a real command and must be checked against the dead-time/min-pulse limit.
  const staticDutyClamp = d <= 1e-12 || d >= 1 - 1e-12;
  const tDeadSec = tDeadNs * 1e-9;
  const requestedDeadEdgeDuty = fswHz > 0 ? tDeadSec * fswHz : 0;
  // If a commanded pulse is no wider than one dead-time interval, the actual
  // result depends on MCU pulse deletion / dead-time compensation behavior. Do
  // not guess that behavior in a steady average model: reject this point and
  // require the real PWM/gate timing or a valid minimum-pulse constraint.
  if (!staticDutyClamp && requestedDeadEdgeDuty > 0 &&
      (d <= requestedDeadEdgeDuty || (1 - d) <= requestedDeadEdgeDuty)) {
    throw new Error(
      `PWM 指令脉冲宽度不足：duty=${d.toFixed(6)}，单边死区占空比=${requestedDeadEdgeDuty.toFixed(6)}。` +
      '当前平均损耗模型无法判断 MCU/驱动器的窄脉冲删除与死区补偿行为，拒绝输出单管损耗/结温；请确认实际 PWM 最小脉宽或导入实测 duty/gate 波形。'
    );
  }
  const deadEdgeDuty = staticDutyClamp ? 0 : requestedDeadEdgeDuty;
  const deadDuty = 2 * deadEdgeDuty;

  const highCondDuty = staticDutyClamp ? d : Math.max(0, d - deadEdgeDuty);
  const lowCondDuty = staticDutyClamp ? 1 - d : Math.max(0, 1 - d - deadEdgeDuty);

  const iSq = iPhase * iPhase;
  const pHighCond = iSq * ronH * highCondDuty;
  const pLowCond = iSq * ronL * lowCondDuty;
  const pHighCond25W = iSq * r25 * highCondDuty;
  const pLowCond25W = iSq * r25 * lowCondDuty;

  let pSw = 0;
  let pDead = 0;
  let lutStatus: DptLutStatus | undefined;
  let lutActiveDims: DptAxisName[] | undefined;
  let lutCollapsedDims: DptAxisName[] | undefined;
  let lutExtrapolated: boolean | undefined;
  let lutTjProvenance: DptParameterProvenance | undefined;
  let lutRgProvenance: DptParameterProvenance | undefined;
  let eossOutOfRange = false;

  if (!staticDutyClamp && fswHz > 0) {
    const iAbs = Math.abs(iPhase);
    const vPos = Math.max(0, vBus);
    const vScale = vPos / Math.max(1e-3, mos.vRefV);
    const activeTjC = iPhase >= 0 ? tjHighC : tjLowC;
    const rgOnKnown = mos.rgOnOhm !== undefined && Number.isFinite(mos.rgOnOhm);
    const rgOffKnown = mos.rgOffOhm !== undefined && Number.isFinite(mos.rgOffOhm);
    const lutInterp =
      mos.dptLut && mos.dptLut.length > 0
        ? interpolateDptSwitchingLoss(mos.dptLut, {
            vBusV: vPos,
            iLoadA: iAbs,
            tjC: activeTjC,
            rgOnOhm: mos.rgOnOhm,
            rgOffOhm: mos.rgOffOhm,
            tjProvenance: 'model_estimated',
            // Rg is usable as a measured LUT coordinate only when both switching
            // directions have explicit finite inputs. A caller-supplied provenance
            // label must never turn a missing Rg value (which the interpolator would
            // otherwise replace with a LUT midpoint) into a measured condition.
            rgProvenance: rgOnKnown && rgOffKnown ? (mos.rgProvenance ?? 'assumed') : 'assumed',
          })
        : null;
    let eSwJ: number;
    let eQrrJ: number;
    if (lutInterp) {
      if (lutInterp.status !== 'VALID') {
        const details = lutInterp.warnings.join('；') || `DPT LUT 状态为 ${lutInterp.status}`;
        throw new Error(
          `MOS 热损耗计算已拒绝非有效 DPT 查询 (${lutInterp.status})：${details}。请补齐 Vbus/Iload/Tj/Rg 四维实测范围后重新计算。`
        );
      }
      if (lutInterp.rgProvenance === 'assumed' && lutInterp.activeDimensions.includes('Rg')) {
        throw new Error('DPT LUT 的 Rg 维度有变化，但当前运行没有明确的 Rg_on/Rg_off 实际输入；禁止使用 LUT 中值冒充实际驱动条件。');
      }
      lutStatus = lutInterp.status;
      lutActiveDims = lutInterp.activeDimensions;
      lutCollapsedDims = lutInterp.collapsedDimensions;
      lutExtrapolated = lutInterp.extrapolated;
      lutTjProvenance = lutInterp.tjProvenance;
      lutRgProvenance = lutInterp.rgProvenance;

      if (mos.eonIncludesQrr) {
        eSwJ = Math.max(0, lutInterp.eSwTotalUj) * 1e-6;
        eQrrJ = 0;
      } else {
        eSwJ = Math.max(0, lutInterp.eOnSansQrrUj + lutInterp.eOffUj) * 1e-6;
        eQrrJ = Math.max(0, lutInterp.qRrNc) * 1e-9 * vPos;
      }
    } else {
      const iScale = iAbs / Math.max(1e-3, mos.iRefA);
      eSwJ = Math.max(0, mos.eonPlusEoffUj) * 1e-6 * vScale * iScale;
      const qrrCurrentScale = iAbs / Math.max(1e-3, mos.qrrIrefA ?? mos.iRefA);
      eQrrJ = mos.eonIncludesQrr ? 0 : Math.max(0, mos.qrrNc) * 1e-9 * vPos * qrrCurrentScale;
    }

    let eOssJ = 0;
    if (!mos.eossAlreadyIncludedInEsw) {
      if (mos.eossCurve) {
        const evalRes = evaluateNonlinearEossUj(mos.eossCurve, vPos, { allowOutOfDomainClamp: false });
        eOssJ = Math.max(0, evalRes.eossUj) * 1e-6;
        eossOutOfRange = evalRes.outOfRange;
      } else {
        eOssJ = Math.max(0, mos.eossUj ?? 0) * 1e-6 * vScale * vScale;
      }
    }
    pSw = fswHz * (eSwJ + eQrrJ + eOssJ);
    pDead = iAbs * Math.max(0, mos.vsdV) * deadDuty;
  }

  let pHighSw = 0;
  let pLowSw = 0;
  let pHighDead = 0;
  let pLowDead = 0;

  if (iPhase >= 0) {
    pHighSw = pSw;
    pLowDead = pDead;
  } else {
    pLowSw = pSw;
    pHighDead = pDead;
  }

  return {
    pHighTotal: pHighCond + pHighSw + pHighDead,
    pLowTotal: pLowCond + pLowSw + pLowDead,
    pHighCond,
    pLowCond,
    pHighCond25W,
    pLowCond25W,
    pHighSw,
    pLowSw,
    pHighDead,
    pLowDead,
    lutStatus,
    lutActiveDims,
    lutCollapsedDims,
    lutExtrapolated,
    lutTjProvenance,
    lutRgProvenance,
    eossOutOfRange,
  };
}
