/**
 * FOC 6-MOS Waveform Transient Simulator, 360-deg Locked-Rotor Stall Sweep & Control Sweep
 */
import type { WaveformChannel } from "../../types/models";
import { type CauerStage, parseSiUnitScale } from "../thermalEngine";
import { computeChannelMean, getChannelDisplayValue } from "../oscilloscopeScale";
import { inspectChannelSamplingGaps } from "../timeSync";
import type { DptAxisName, DptLutStatus, DptParameterProvenance } from "../dptAnalyzer";
import {
  DEFAULT_FOC_MODEL,
  FocControlParams,
  FocControlSweepResult,
  FocModulationMode,
  FocMosParams,
  FocResultQualification,
  FocSimulationOptions,
  FocSimulationResult,
  FocStallSweepOptions,
  FocStallSweepResult,
  FocThermalInitInfo,
  FocThermalModel,
  MOS_SWITCH_KEYS,
  MosSwitchKey,
  MosSwitchSummary,
  getModulationLinearCeiling,
} from "./types";
import {
  computePhaseMosLosses,
  getFocMosRdsFactorAtTj,
  qossCoveredByQr,
  reconstructSensorlessDutySample,
  resolveInitialThermalProbeTjC,
  validateMosEnergyAccounting,
  validateRdsOnTempCurveForMos,
} from "./lossModel";
import {
  StarCoupled6MosThermalSolver,
  buildPerSwitchJcChains,
  computeDominantCauerTauSec,
  resolveSpatialThermalNetwork,
  solveCoupledThermalSteadyState,
} from "./thermalNetwork";

/**
 * Main Phase 2 Transient Simulator:
 * Evaluates 6-MOS inverter junction temperatures & losses directly from FOC Ia, Ib, (Ic) + Vbus (+ optional Duty_A/B/C).
 */
export function simulateFoc6Mos(
  iaCh: WaveformChannel,
  ibCh: WaveformChannel,
  model: FocThermalModel,
  mos: FocMosParams,
  ctrl: FocControlParams,
  opts?: FocSimulationOptions
): FocSimulationResult {
  if (model.splitFeasible === false) {
    throw new Error(model.splitMeta?.warning || '热模型 ZthJC / Zth_board 手册约束拆分不可行，已拒绝代入 6-MOS 仿真。');
  }

  const finiteInRange = (value: number, min: number, max: number): boolean =>
    Number.isFinite(value) && value >= min && value <= max;
  if (!['SVPWM', 'DPWM1', 'SPWM'].includes(ctrl.modulation)) throw new Error('FOC 调制模式无效。');
  if (!finiteInRange(ctrl.fswHz, 1, 5e6)) throw new Error('开关频率 fswHz 必须为 1 Hz～5 MHz 的有限正数。');
  if (!finiteInRange(ctrl.tDeadNs, 0, 1e6)) throw new Error('死区时间 tDeadNs 必须为 0～1,000,000 ns。');
  if (!finiteInRange(ctrl.modDepthM, 0, 2)) throw new Error('调制深度 modDepthM 必须位于 0～2；线性区外会单独给出过调制告警。');
  if (!finiteInRange(ctrl.pfAngleDeg, -180, 180)) throw new Error('电压/电流相角 pfAngleDeg 必须位于 -180°～180°。');
  if (!Number.isFinite(ctrl.tAmbC) || ctrl.tAmbC <= -273.15 || ctrl.tAmbC > 1000) throw new Error('环境温度必须位于绝对零度以上且不超过 1000°C。');

  if (!finiteInRange(mos.rdsOn25Mohm, Number.EPSILON, 1e6)) throw new Error('MOS Rds(on)@25°C 必须为有限正数（mΩ）。');
  if (!mos.rdsOnTempCurve && !finiteInRange(mos.tempCoeffAlphaPerC, 0, 0.05)) throw new Error('MOS Rds 温度系数必须为 0～0.05 /°C；如使用器件曲线，该 α 输入不参与计算。');
  if (mos.rdsOnTempCurve) validateRdsOnTempCurveForMos(mos);
  if (!finiteInRange(mos.vsdV, 0, 10)) throw new Error('MOS 体二极管压降必须为 0～10 V。');
  if (!finiteInRange(mos.eonPlusEoffUj, 0, 1e9)) throw new Error('MOS Eon+Eoff 必须为非负有限值（µJ）。');
  if (!finiteInRange(mos.vRefV, Number.EPSILON, 1e6) || !finiteInRange(mos.iRefA, Number.EPSILON, 1e6)) {
    throw new Error('MOS 开关能量参考电压 Vref 和参考电流 Iref 必须为有限正数。');
  }
  if (!finiteInRange(mos.qrrNc, 0, 1e9) || (mos.qrrIrefA !== undefined && !finiteInRange(mos.qrrIrefA, Number.EPSILON, 1e6)) || (mos.eossUj !== undefined && !finiteInRange(mos.eossUj, 0, 1e9))) {
    throw new Error('MOS Qrr / Eoss 必须为非负有限值（nC / µJ）。');
  }

  const jcStages = model.zthJC.length > 0 ? model.zthJC : DEFAULT_FOC_MODEL.zthJC;
  const boardStages = model.zthBoard.length > 0 ? model.zthBoard : DEFAULT_FOC_MODEL.zthBoard;
  const validateThermalStages = (stages: CauerStage[], label: string): void => {
    if (stages.length === 0) throw new Error(`${label} 热阻网络不能为空。`);
    stages.forEach((stage, index) => {
      if (!Number.isFinite(stage.r) || stage.r <= 0 || !Number.isFinite(stage.c) || stage.c <= 0) {
        throw new Error(`${label} 第 ${index + 1} 阶 Cauer 阶梯的 R/C 必须为有限正数。`);
      }
    });
  };
  validateThermalStages(jcStages, 'ZthJC');
  validateThermalStages(boardStages, 'ZthBoard');
  if (model.perSwitchRjcScale && (model.perSwitchRjcScale.length !== 6 || model.perSwitchRjcScale.some((v) => !finiteInRange(v, 0.01, 100)))) {
    throw new Error('perSwitchRjcScale 必须是 6 个有限正数，范围 0.01～100。');
  }
  if (model.perSwitchPadOffsetCPerW && (model.perSwitchPadOffsetCPerW.length !== 6 || model.perSwitchPadOffsetCPerW.some((v) => !finiteInRange(v, 0, 1e6)))) {
    throw new Error('perSwitchPadOffsetCPerW 必须是 6 个有限非负热阻值。');
  }

  const validatePhysicalChannel = (ch: WaveformChannel | null | undefined, label: string): void => {
    if (!ch) return;
    if (ch.t.length !== ch.v.length) {
      throw new Error(`${label} 时间戳数量 (${ch.t.length}) 与数据点数量 (${ch.v.length}) 不一致，已阻止热仿真。`);
    }
    if (ch.t.length < 2) {
      throw new Error(`${label} 有效样本不足 (<2 点)，无法执行物理热仿真。`);
    }
    for (let idx = 0; idx < ch.t.length; idx++) {
      const tVal = ch.t[idx];
      if (!Number.isFinite(tVal)) {
        throw new Error(`${label} 时间轴在索引 ${idx} 处存在 NaN/Inf 无效时间戳，请先清洗数据。`);
      }
      if (idx > 0 && !(tVal > ch.t[idx - 1])) {
        const kind = tVal === ch.t[idx - 1] ? '重复时间戳 (dt=0)' : '时间倒退';
        throw new Error(`${label} 时间轴在索引 ${idx} 处存在${kind}，FOC 热积分要求严格递增时间轴，已阻止仿真。`);
      }
    }
  };
  validatePhysicalChannel(iaCh, 'Ia');
  validatePhysicalChannel(ibCh, 'Ib');
  validatePhysicalChannel(opts?.icCh, 'Ic');
  validatePhysicalChannel(opts?.vbusCh, 'Vbus');
  validatePhysicalChannel(opts?.dutyChs?.da, 'Duty_A');
  validatePhysicalChannel(opts?.dutyChs?.db, 'Duty_B');
  validatePhysicalChannel(opts?.dutyChs?.dc, 'Duty_C');

  const nIa = Math.min(iaCh.t.length, iaCh.v.length);
  const nIb = Math.min(ibCh.t.length, ibCh.v.length);
  if (nIa < 4 || nIb < 2) {
    throw new Error('At least 4 Ia samples and 2 Ib samples are required for BLDC FOC 6-MOS thermal evaluation.');
  }
  if (iaCh.id && ibCh.id && iaCh.id === ibCh.id) {
    throw new Error(
      'Ia 与 Ib 不能选择同一通道：单电阻 (Single-Shunt) 母线采样系统需先在示波器或控制器端重构三相相电流 Ia/Ib/Ic 后，再进行 6-MOS 热仿真。'
    );
  }

  const alignmentWarnings: string[] = [];
  let i0 = 0;
  let i1 = nIa - 1;
  if (opts?.tStart !== undefined) while (i0 < nIa && iaCh.t[i0] < opts.tStart) i0++;
  if (opts?.tEnd !== undefined) while (i1 > i0 && iaCh.t[i1] > opts.tEnd) i1--;

  // Ia and Ib are the two primary measured phase-current signals. If their
  // acquisition windows differ slightly, integrate only their true overlap;
  // never extend either channel by holding endpoint samples. Auxiliary inputs
  // (Ic/Vbus/Duty) must cover this already-clipped analysis interval in full.
  if (i0 < nIa && i1 >= i0) {
    const requestedStart = iaCh.t[i0];
    const requestedEnd = iaCh.t[i1];
    const ibStart = ibCh.t[0];
    const ibEnd = ibCh.t[nIb - 1];
    const overlapStart = Math.max(requestedStart, ibStart);
    const overlapEnd = Math.min(requestedEnd, ibEnd);
    if (!(overlapEnd > overlapStart)) {
      throw new Error('Ia 与 Ib 时间轴没有有效重叠区间，无法进行 6-MOS 热仿真。');
    }
    const eps = Math.max(1e-12, (requestedEnd - requestedStart) * 1e-9);
    while (i0 < i1 && iaCh.t[i0] < overlapStart - eps) i0++;
    while (i1 > i0 && iaCh.t[i1] > overlapEnd + eps) i1--;
    if (iaCh.t[i0] > requestedStart + eps || iaCh.t[i1] < requestedEnd - eps) {
      alignmentWarnings.push(
        `Ia/Ib 原始采集窗口不完全重合，仿真已裁剪到共同覆盖区间 [${iaCh.t[i0].toFixed(6)}s, ${iaCh.t[i1].toFixed(6)}s]；未使用端点保持或区间外推。`
      );
    }
  }
  const len = Math.max(0, i1 - i0 + 1);
  if (len < 4) {
    throw new Error('At least 4 samples inside gate are required for BLDC FOC 6-MOS thermal evaluation.');
  }
  if (iaCh.t[i1] - iaCh.t[i0] <= 1e-15) {
    throw new Error('选定时间门控内有效时间跨度为 0 s（全部为重复时间戳），无法积分热功耗与温升。');
  }

  const gateThermalMode: 'preheat' | 'cold' = opts?.gateThermalMode === 'cold' ? 'cold' : 'preheat';

  const mIa = iaCh.coupling === 'AC' ? computeChannelMean(iaCh) : 0;
  const mIb = ibCh.coupling === 'AC' ? computeChannelMean(ibCh) : 0;
  const icCh = opts?.icCh || null;
  if (icCh && icCh.id && (icCh.id === iaCh.id || icCh.id === ibCh.id)) {
    throw new Error('Ic 不能与 Ia 或 Ib 选择同一通道；若仅有两相电流采样，请将 Ic 设为 Auto: Ic = -(Ia + Ib)。');
  }
  const mIc = icCh && icCh.coupling === 'AC' ? computeChannelMean(icCh) : 0;
  const vbusCh = opts?.vbusCh || null;
  if (!vbusCh && !finiteInRange(ctrl.vBusConstV, 1e-6, 1e6)) {
    throw new Error('未选择 Vbus 波形时，恒定母线电压 vBusConstV 必须为有限正数。');
  }
  const mVbus = vbusCh && vbusCh.coupling === 'AC' ? computeChannelMean(vbusCh) : 0;

  const iaScale = parseSiUnitScale(iaCh.unit, 'A', iaCh.name, { strict: true });
  const ibScale = parseSiUnitScale(ibCh.unit, 'A', ibCh.name, { strict: true });
  const icScale = icCh ? parseSiUnitScale(icCh.unit, 'A', icCh.name, { strict: true }) : 1;
  const vbusScale = vbusCh ? parseSiUnitScale(vbusCh.unit, 'V', vbusCh.name, { strict: true }) : 1;

  const rawDa = opts?.dutyChs?.da || null;
  const rawDb = opts?.dutyChs?.db || null;
  const rawDc = opts?.dutyChs?.dc || null;
  const partialDutySelected =
    (rawDa || rawDb || rawDc) !== null && !(rawDa && rawDb && rawDc);
  const daCh = rawDa && rawDb && rawDc ? rawDa : null;
  const dbCh = rawDa && rawDb && rawDc ? rawDb : null;
  const dcCh = rawDa && rawDb && rawDc ? rawDc : null;

  const checkSameTb = (ch: WaveformChannel | null): boolean => {
    if (!ch) return false;
    // A same-timebase fast path is valid only when both arrays have exactly
    // the same sample count. A longer/shorter channel must use timestamp-based
    // interpolation over the real overlap, never silent prefix truncation.
    if (ch.t.length !== nIa || ch.v.length !== nIa) return false;
    const nc = nIa;
    if (ch.t === iaCh.t) return true;
    for (let i = 0; i < nc; i++) {
      if (!Number.isFinite(ch.t[i]) || Math.abs(ch.t[i] - iaCh.t[i]) > 1e-12) return false;
    }
    return true;
  };

  interface GapSafeSampler {
    sample: (targetT: number, idxHint: number) => number;
    repairedNanCount: number;
    finiteCount: number;
    completelyDisjoint: boolean;
    coverageComplete: boolean;
  }

  const buildGapSafeSampler = (
    ch: WaveformChannel,
    scale: number,
    meanAc: number,
    label: string,
    isSame: boolean,
    simStart: number,
    simEnd: number
  ): GapSafeSampler => {
    if (ch.t.length !== ch.v.length) {
      throw new Error(`${label} 时间戳数量 (${ch.t.length}) 与幅值数量 (${ch.v.length}) 不一致，已拒绝静默截断。`);
    }
    const nc = ch.t.length;
    if (nc < 2) throw new Error(`${label} 至少需要 2 个有效样本才能插值和进行热积分。`);
    const covSpan = Math.max(1e-9, simEnd - simStart);
    const covEps = Math.max(1e-12, covSpan * 1e-8);

    // Do not bridge large acquisition gaps that intersect the actual simulation
    // window. Samples outside a user-selected gate must not invalidate an otherwise
    // complete window; include the two bracketing source samples so interpolation
    // at a non-grid-aligned gate boundary is still checked.
    let firstAtOrAfterStart = 0;
    while (firstAtOrAfterStart < nc && ch.t[firstAtOrAfterStart] < simStart) firstAtOrAfterStart++;
    let firstAtOrAfterEnd = firstAtOrAfterStart;
    while (firstAtOrAfterEnd < nc && ch.t[firstAtOrAfterEnd] < simEnd) firstAtOrAfterEnd++;
    const startIsExact = firstAtOrAfterStart < nc && Math.abs(ch.t[firstAtOrAfterStart] - simStart) <= covEps;
    const gapStartIdx = startIsExact ? firstAtOrAfterStart : Math.max(0, firstAtOrAfterStart - 1);
    const gapEndIdx = Math.min(nc - 1, firstAtOrAfterEnd);
    // Linear interpolation over a missing switching/current interval can smooth
    // current peaks and understate conduction or switching-related loss.
    const gapReport = inspectChannelSamplingGaps(ch.t, gapStartIdx, gapEndIdx, 3.5);
    if (gapReport.gapCount > 0) {
      throw new Error(`${label} 时间轴检测到 ${gapReport.gapCount} 个内部采样缺口，最大间隔为 ${(gapReport.maxGapSec * 1e3).toFixed(3)} ms（中位采样间隔的 ${gapReport.maxGapRatio.toFixed(1)} 倍）；为避免跨缺口插值低估电流/损耗，FOC 热仿真已拒绝该通道。请缩小时间窗或补充连续采样数据。`);
    }

    // Do not repair invalid acquisition values in an engineering loss/thermal path.
    // Interpolation across an unknown sample can suppress peaks and understate loss.
    for (let i = 0; i < nc; i++) {
      const t = ch.t[i];
      if (!Number.isFinite(t)) {
        throw new Error(`通道 ${label} 时间轴在索引 ${i} 处含 NaN/Inf。`);
      }
      if (i > 0 && !(t > ch.t[i - 1])) {
        throw new Error(`通道 ${label} 时间轴在索引 ${i} 处非严格递增（重复或倒退）。`);
      }
      const value = getChannelDisplayValue(ch, i, meanAc) * scale;
      if (!Number.isFinite(value)) {
        throw new Error(`通道 ${label} 在索引 ${i}、t=${t.toExponential(6)}s 处含 NaN/Inf 幅值；FOC 热损耗计算拒绝插值修补无效采样。`);
      }
    }

    let completelyDisjoint = false;
    let coverageComplete = true;
    if (!isSame) {
      const cStart = ch.t[0];
      const cEnd = ch.t[nc - 1];
      if (cEnd < simStart - covEps || cStart > simEnd + covEps) {
        completelyDisjoint = true;
        coverageComplete = false;
      } else if (cStart > simStart + covEps || cEnd < simEnd - covEps) {
        coverageComplete = false;
        alignmentWarnings.push(
          `通道 ${label} 时间覆盖 [${cStart.toFixed(4)}s, ${cEnd.toFixed(4)}s] 未完整覆盖仿真区间 [${simStart.toFixed(4)}s, ${simEnd.toFixed(4)}s]，禁止使用首/尾边界值外推。`
        );
      }
    }

    const tArr = ch.t;
    const vArr = new Float64Array(nc);
    for (let i = 0; i < nc; i++) vArr[i] = getChannelDisplayValue(ch, i, meanAc) * scale;

    const sample = (targetT: number, idxHint: number): number => {
      if (!Number.isFinite(targetT)) return Number.NaN;
      if (isSame && idxHint >= 0 && idxHint < nc) return vArr[idxHint];
      if (targetT < tArr[0] - covEps || targetT > tArr[nc - 1] + covEps) return Number.NaN;
      if (targetT <= tArr[0]) return targetT >= tArr[0] - covEps ? vArr[0] : Number.NaN;
      if (targetT >= tArr[nc - 1]) return targetT <= tArr[nc - 1] + covEps ? vArr[nc - 1] : Number.NaN;
      let lo = 0;
      let hi = nc - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (tArr[mid] <= targetT) lo = mid;
        else hi = mid;
      }
      const dt = tArr[hi] - tArr[lo];
      if (!(dt > 0)) return Number.NaN;
      const frac = (targetT - tArr[lo]) / dt;
      return vArr[lo] + frac * (vArr[hi] - vArr[lo]);
    };

    return { sample, repairedNanCount: 0, finiteCount: nc, completelyDisjoint, coverageComplete };
  };

  // Preheat runs from the first timestamp jointly covered by Ia and Ib, not
  // blindly from Ia[0]. If the captures have different start times, begin at
  // the first Ia sample at/after the common acquisition start; never extrapolate
  // Ib backwards to the start of Ia.
  let preheatStartIdx = 0;
  if (gateThermalMode === 'preheat') {
    const commonCaptureStart = Math.max(iaCh.t[0], ibCh.t[0]);
    while (preheatStartIdx < i0 && iaCh.t[preheatStartIdx] < commonCaptureStart - 1e-12) {
      preheatStartIdx++;
    }
    if (preheatStartIdx >= i0) {
      preheatStartIdx = i0;
    }
    if (preheatStartIdx > 0 && iaCh.t[preheatStartIdx] > iaCh.t[0] + 1e-12) {
      alignmentWarnings.push(`热预热区间已从 Ia/Ib 首个共同采样时刻 ${iaCh.t[preheatStartIdx].toFixed(6)}s 开始；更早时段缺少完整双相电流数据，不参与预热。`);
    }
  }
  const simTStart = gateThermalMode === 'preheat' ? iaCh.t[preheatStartIdx] : iaCh.t[i0];
  const simTEnd = iaCh.t[i1];

  const sameIb = checkSameTb(ibCh);
  const sameIc = checkSameTb(icCh);
  const sameVbus = checkSameTb(vbusCh);
  const sameDa = checkSameTb(daCh);
  const sameDb = checkSameTb(dbCh);
  const sameDc = checkSameTb(dcCh);

  const iaSampler = buildGapSafeSampler(iaCh, iaScale, mIa, `Ia(${iaCh.name})`, true, simTStart, simTEnd);
  const ibSampler = buildGapSafeSampler(ibCh, ibScale, mIb, `Ib(${ibCh.name})`, sameIb, simTStart, simTEnd);
  if (iaSampler.finiteCount === 0 || ibSampler.finiteCount === 0) {
    throw new Error('Ia 或 Ib 通道缺少有效数值样本 (全为 NaN/Inf)，无法执行 6-MOS 热仿真。');
  }
  if (ibSampler.completelyDisjoint || !ibSampler.coverageComplete) {
    throw new Error(`Ib(${ibCh.name}) 未完整覆盖主通道 Ia 门控区间，已拒绝使用首/尾保持或外推值执行 6-MOS 热仿真。`);
  }
  const icSampler = icCh
    ? buildGapSafeSampler(icCh, icScale, mIc, `Ic(${icCh.name})`, sameIc, simTStart, simTEnd)
    : null;
  if (icSampler && (icSampler.finiteCount === 0 || icSampler.completelyDisjoint || !icSampler.coverageComplete)) {
    throw new Error(`Ic(${icCh!.name}) 全为无效样本或未完整覆盖仿真区间，请检查通道选择或改为 Auto (-Ia-Ib)。`);
  }
  const vbusSampler = vbusCh
    ? buildGapSafeSampler(vbusCh, vbusScale, mVbus, `Vbus(${vbusCh.name})`, sameVbus, simTStart, simTEnd)
    : null;
  if (vbusSampler && (vbusSampler.finiteCount === 0 || vbusSampler.completelyDisjoint || !vbusSampler.coverageComplete)) {
    throw new Error(`Vbus(${vbusCh!.name}) 全为无效样本或未完整覆盖仿真区间，请检查母线电压通道或使用恒定 Vbus。`);
  }

  // Determine each external Duty channel's own engineering scale. Do not apply
  // one global scale: mixed %, pu and fraction exports are common when channels
  // were assembled from different instruments/data sources.
  const useExternalDuty = Boolean(daCh && dbCh && dcCh);
  const dutyScales: [number, number, number] = [1, 1, 1];
  const dutyPctInferredChannels: string[] = [];
  let dutyBinaryPulseSuspected = false;

  if (useExternalDuty && daCh && dbCh && dcCh) {
    const dutyList = [daCh, dbCh, dcCh];
    let totalDutySamples = 0;
    let extremeBoundaryCount = 0;
    let finiteDutySum = 0;
    // Unlabelled channels in a single exported three-phase Duty group normally
    // share one unit convention. Infer percent for all *unlabelled* phases only
    // when at least one unlabelled phase provides >1.05 evidence. Explicit pu
    // channels remain fractional and are never globally rescaled.
    const groupUnitlessPercentEvidence = dutyList.some((ch) => {
      if ((ch.unit || '').trim().toLowerCase().replace(/\s+/g, '') !== '') return false;
      const n = Math.min(ch.t.length, ch.v.length);
      let max = -Infinity;
      for (let i = 0; i < n; i++) {
        const value = getChannelDisplayValue(ch, i, 0);
        if (Number.isFinite(value)) max = Math.max(max, value);
      }
      return max > 1.05 && max <= 100.5;
    });

    dutyList.forEach((ch, channelIndex) => {
      const u = (ch.unit || '').trim().toLowerCase().replace(/\s+/g, '');
      const nD = Math.min(ch.t.length, ch.v.length);
      if (nD < 2) throw new Error(`外部占空比通道 "${ch.name}" 有效样本不足。`);
      let minRaw = Infinity;
      let maxRaw = -Infinity;
      for (let i = 0; i < nD; i++) {
        const val = getChannelDisplayValue(ch, i, 0);
        if (!Number.isFinite(val)) {
          throw new Error(`外部占空比通道 "${ch.name}" 在索引 ${i} 含 NaN/Inf，拒绝用钳位或插值掩盖无效 Duty。`);
        }
        minRaw = Math.min(minRaw, val);
        maxRaw = Math.max(maxRaw, val);
      }

      const isPct = /^(%|pct|percent)$/.test(u);
      const isFraction = u === '' || /^(1|pu|p\.u\.)$/.test(u);
      if (!isPct && !isFraction) {
        throw new Error(`外部占空比通道 "${ch.name}" 的单位 "${ch.unit}" 未知；仅接受 % 或无量纲/pu，拒绝猜测单位。`);
      }

      let scale = isPct ? 0.01 : 1;
      if (!isPct && u === '' && groupUnitlessPercentEvidence) {
        scale = 0.01;
        dutyPctInferredChannels.push(ch.name);
      }
      if (maxRaw > 100.5) {
        throw new Error(`外部占空比通道 "${ch.name}" 最大值 ${maxRaw.toFixed(4)} 超过 100.5%，输入量程无效。`);
      }
      const minScaled = minRaw * scale;
      const maxScaled = maxRaw * scale;
      if (minScaled < -1e-4 || maxScaled > 1.0001) {
        throw new Error(`外部占空比通道 "${ch.name}" 换算后范围为 [${minScaled.toFixed(5)}, ${maxScaled.toFixed(5)}]，超出合法 [0,1]；请核对单位/通道，不再静默钳位。`);
      }
      dutyScales[channelIndex] = scale;

      const stride = nD > 20000 ? Math.floor(nD / 20000) : 1;
      for (let i = 0; i < nD; i += stride) {
        const dScaled = Math.max(0, Math.min(1, getChannelDisplayValue(ch, i, 0) * scale));
        totalDutySamples++;
        finiteDutySum += dScaled;
        if (dScaled <= 1e-4 || dScaled >= 1 - 1e-4) extremeBoundaryCount++;
      }
    });

    if (totalDutySamples >= 20) {
      const fracExtreme = extremeBoundaryCount / totalDutySamples;
      const meanDuty = finiteDutySum / totalDutySamples;
      if (fracExtreme > 0.95 && meanDuty > 0.05 && meanDuty < 0.95) dutyBinaryPulseSuspected = true;
    }
    if (dutyBinaryPulseSuspected) {
      throw new Error(
        '检测到外部 Duty_A/B/C 超过 95% 样本为精确 0 或 1（原始 PWM 二值开关脉冲而非周期平均占空比）；请先提取 PWM 周期平均占空比，或切换为无传感器 SVPWM 重构。'
      );
    }
  }

  const daSampler = daCh
    ? buildGapSafeSampler(daCh, dutyScales[0], 0, `Duty_A(${daCh.name})`, sameDa, simTStart, simTEnd)
    : null;
  const dbSampler = dbCh
    ? buildGapSafeSampler(dbCh, dutyScales[1], 0, `Duty_B(${dbCh.name})`, sameDb, simTStart, simTEnd)
    : null;
  const dcSampler = dcCh
    ? buildGapSafeSampler(dcCh, dutyScales[2], 0, `Duty_C(${dcCh.name})`, sameDc, simTStart, simTEnd)
    : null;
  for (const [lbl, smp] of [
    ['Duty_A', daSampler],
    ['Duty_B', dbSampler],
    ['Duty_C', dcSampler],
  ] as const) {
    if (smp && (smp.finiteCount === 0 || smp.completelyDisjoint || !smp.coverageComplete)) {
      throw new Error(`外部占空比通道 ${lbl} 全为无效样本或未完整覆盖仿真区间，已拒绝执行 6-MOS 仿真。`);
    }
  }

  const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
  let overmodulatedCount = 0;
  let zeroCurrentFallbackCount = 0;

  const hasDptLut = Boolean(mos.dptLut && mos.dptLut.length > 0);
  let lutVMin = Infinity;
  let lutVMax = -Infinity;
  let lutIMin = Infinity;
  let lutIMax = -Infinity;
  if (hasDptLut && mos.dptLut) {
    for (const pt of mos.dptLut) {
      if (pt.vBusV < lutVMin) lutVMin = pt.vBusV;
      if (pt.vBusV > lutVMax) lutVMax = pt.vBusV;
      if (pt.iLoadA < lutIMin) lutIMin = pt.iLoadA;
      if (pt.iLoadA > lutIMax) lutIMax = pt.iLoadA;
    }
  }
  let lutExtrapolatedSamples = 0;
  let scalarWideScaleSamples = 0;
  let opVMin = Infinity;
  let opVMax = -Infinity;
  let opIMax = 0;

  // Estimate electrical fundamental samples-per-cycle from raw Ia zero-crossings (DC stall keeps zeroCrossings < 3 -> null)
  let zeroCrossings = 0;
  let prevSign = 0;
  let maxAbsIa = 0;
  for (let idx = i0; idx <= i1; idx++) {
    const v = Math.abs(iaSampler.sample(iaCh.t[idx], idx));
    if (v > maxAbsIa) maxAbsIa = v;
  }
  const zEps = Math.max(1e-6, maxAbsIa * 0.02);
  for (let idx = i0; idx <= i1; idx++) {
    const v = iaSampler.sample(iaCh.t[idx], idx);
    const s = v > zEps ? 1 : v < -zEps ? -1 : 0;
    if (s !== 0) {
      if (prevSign !== 0 && s !== prevSign) zeroCrossings++;
      prevSign = s;
    }
  }
  const elecCycles = zeroCrossings >= 3 ? zeroCrossings / 2 : 0;
  const pointsPerElecCycle = elecCycles >= 1.5 ? len / elecCycles : null;

  let lutOutOfRangeCount = 0;
  let lutStatusLatest: DptLutStatus | undefined;
  let lutActiveDimsLatest: DptAxisName[] = [];
  let lutCollapsedDimsLatest: DptAxisName[] = [];
  let lutTjProvLatest: DptParameterProvenance = 'measured';
  let lutRgProvLatest: DptParameterProvenance = 'assumed';
  let eossCurveOutOfRangeCount = 0;

  const evalStepLossesAt = (
    idx: number,
    curTj: number[],
    countOvermod: boolean
  ): {
    da: number;
    db: number;
    dc: number;
    pStep: number[];
    pCondStep: number[];
    pCond25Step: number[];
    pSwStep: number[];
    pDeadStep: number[];
    ia: number;
    ib: number;
    ic: number;
  } => {
    const tCurr = iaCh.t[idx];
    const ia = iaSampler.sample(tCurr, idx);
    const ib = ibSampler.sample(tCurr, idx);
    const ic = icSampler ? icSampler.sample(tCurr, idx) : -(ia + ib);
    const vbus = vbusSampler ? vbusSampler.sample(tCurr, idx) : ctrl.vBusConstV;
    if (!Number.isFinite(vbus) || vbus <= 0) {
      throw new Error(`Vbus 在 t=${tCurr.toExponential(6)}s 处为非有限值或非正值；拒绝将无效母线电压钳位为 0V 继续计算。`);
    }

    let da: number;
    let db: number;
    let dc: number;
    if (useExternalDuty && daSampler && dbSampler && dcSampler) {
      da = clamp01(daSampler.sample(tCurr, idx));
      db = clamp01(dbSampler.sample(tCurr, idx));
      dc = clamp01(dcSampler.sample(tCurr, idx));
    } else {
      const rec = reconstructSensorlessDutySample(
        ia,
        ib,
        ic,
        ctrl.modulation,
        ctrl.modDepthM,
        ctrl.pfAngleDeg
      );
      da = rec.da;
      db = rec.db;
      dc = rec.dc;
      if (countOvermod && rec.overmodulated) {
        overmodulatedCount++;
      }
      if (countOvermod && rec.zeroCurrentFallback) {
        zeroCurrentFallbackCount++;
      }
    }

    if (countOvermod) {
      if (vbus < opVMin) opVMin = vbus;
      if (vbus > opVMax) opVMax = vbus;
      const stepMaxI = Math.max(Math.abs(ia), Math.abs(ib), Math.abs(ic));
      if (stepMaxI > opIMax) opIMax = stepMaxI;
      if (hasDptLut) {
        if (
          vbus < lutVMin - 1e-6 ||
          vbus > lutVMax + 1e-6 ||
          stepMaxI > lutIMax + 1e-6
        ) {
          lutExtrapolatedSamples++;
        }
      } else {
        const vRatio = vbus / Math.max(1e-3, mos.vRefV);
        const iRatio = stepMaxI / Math.max(1e-3, mos.iRefA);
        if (vRatio < 0.25 || vRatio > 2.0 || iRatio > 2.0) {
          scalarWideScaleSamples++;
        }
      }
    }

    const lA = computePhaseMosLosses(ia, da, vbus, curTj[0], curTj[1], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);
    const lB = computePhaseMosLosses(ib, db, vbus, curTj[2], curTj[3], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);
    const lC = computePhaseMosLosses(ic, dc, vbus, curTj[4], curTj[5], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);

    if (countOvermod) {
      for (const leg of [lA, lB, lC]) {
        if (leg.lutStatus) {
          lutStatusLatest = leg.lutStatus;
          if (leg.lutActiveDims) lutActiveDimsLatest = leg.lutActiveDims;
          if (leg.lutCollapsedDims) lutCollapsedDimsLatest = leg.lutCollapsedDims;
          if (leg.lutTjProvenance) lutTjProvLatest = leg.lutTjProvenance;
          if (leg.lutRgProvenance) lutRgProvLatest = leg.lutRgProvenance;
          if (leg.lutExtrapolated || leg.lutStatus === 'OUT_OF_RANGE') {
            lutOutOfRangeCount++;
          }
        }
        if (leg.eossOutOfRange) eossCurveOutOfRangeCount++;
      }
    }

    return {
      da,
      db,
      dc,
      pStep: [lA.pHighTotal, lA.pLowTotal, lB.pHighTotal, lB.pLowTotal, lC.pHighTotal, lC.pLowTotal],
      pCondStep: [lA.pHighCond, lA.pLowCond, lB.pHighCond, lB.pLowCond, lC.pHighCond, lC.pLowCond],
      pCond25Step: [lA.pHighCond25W, lA.pLowCond25W, lB.pHighCond25W, lB.pLowCond25W, lC.pHighCond25W, lC.pLowCond25W],
      pSwStep: [lA.pHighSw, lA.pLowSw, lB.pHighSw, lB.pLowSw, lC.pHighSw, lC.pLowSw],
      pDeadStep: [lA.pHighDead, lA.pLowDead, lB.pHighDead, lB.pLowDead, lC.pHighDead, lC.pLowDead],
      ia,
      ib,
      ic,
    };
  };

  const resolvedSpatial = resolveSpatialThermalNetwork(model);
  const solver = new StarCoupled6MosThermalSolver(model, ctrl.tAmbC);
  const preheatDurationSec = i0 > preheatStartIdx ? Math.max(0, iaCh.t[i0] - iaCh.t[preheatStartIdx]) : 0;

  if (i0 > preheatStartIdx && gateThermalMode === 'preheat') {
    for (let idx = preheatStartIdx; idx < i0; idx++) {
      const dtPre = Math.max(0, iaCh.t[idx + 1] - iaCh.t[idx]);
      if (dtPre <= 0) continue;
      const curTj = solver.getJunctionTemps();
      const { pStep } = evalStepLossesAt(idx, curTj, false);
      solver.step(dtPre, pStep);
    }
  }

  const tjInitial = solver.getJunctionTemps();
  const thermalInitInfo: FocThermalInitInfo = {
    gated: i0 > 0,
    mode: gateThermalMode,
    preheatDurationSec,
    tjInitialMaxC: Math.max(...tjInitial),
    tBoardInitialC: solver.getBoardTemp(),
  };

  const time = new Float64Array(len);
  const tj: Record<MosSwitchKey, Float32Array> = {
    AH: new Float32Array(len),
    AL: new Float32Array(len),
    BH: new Float32Array(len),
    BL: new Float32Array(len),
    CH: new Float32Array(len),
    CL: new Float32Array(len),
  };
  const pMos: Record<MosSwitchKey, Float32Array> = {
    AH: new Float32Array(len),
    AL: new Float32Array(len),
    BH: new Float32Array(len),
    BL: new Float32Array(len),
    CH: new Float32Array(len),
    CL: new Float32Array(len),
  };
  const pInvTotal = new Float32Array(len);
  const tBoard = new Float32Array(len);
  const duty = {
    a: new Float32Array(len),
    b: new Float32Array(len),
    c: new Float32Array(len),
  };

  const sumPEnergy = new Float64Array(6);
  const sumCondEnergy = new Float64Array(6);
  const sumCond25Energy = new Float64Array(6);
  const sumSwEnergy = new Float64Array(6);
  const sumDeadEnergy = new Float64Array(6);
  const sumTjDt = new Float64Array(6);
  const peakTj = new Float64Array(6).fill(-Infinity);

  // Fallback arithmetic accumulators only if total duration is zero
  const arithP = new Float64Array(6);
  const arithCond = new Float64Array(6);
  const arithSw = new Float64Array(6);
  const arithDead = new Float64Array(6);
  const arithTj = new Float64Array(6);
  let arithPInvSum = 0;

  const totalDt = Math.max(0, iaCh.t[i1] - iaCh.t[i0]);
  const rippleStartTime = iaCh.t[i0] + 0.7 * totalDt;
  const ripMin = new Float64Array(6).fill(Infinity);
  const ripMax = new Float64Array(6).fill(-Infinity);

  let pInvEnergy = 0;
  let accumulatedDt = 0;
  let phaseCurrentKclEnergyA2s = 0;
  let phaseCurrentReferenceEnergyA2s = 0;
  let phaseCurrentKclDurationSec = 0;
  let previousKclSqA2: number | null = null;
  let previousPhaseReferenceSqA2: number | null = null;
  let phaseCurrentKclMaxA = 0;
  let phaseCurrentKclSampleCount = 0;

  for (let k = 0; k < len; k++) {
    const idx = i0 + k;
    const tCurr = iaCh.t[idx];
    time[k] = tCurr;

    const curTj = solver.getJunctionTemps();
    const stepRes = evalStepLossesAt(idx, curTj, true);
    if (icSampler) {
      const kcl = stepRes.ia + stepRes.ib + stepRes.ic;
      const kclSq = kcl * kcl;
      const phaseReferenceSq = (stepRes.ia * stepRes.ia + stepRes.ib * stepRes.ib + stepRes.ic * stepRes.ic) / 3;
      if (k > 0 && previousKclSqA2 !== null && previousPhaseReferenceSqA2 !== null) {
        const dtKcl = tCurr - iaCh.t[idx - 1];
        if (!Number.isFinite(dtKcl) || dtKcl <= 0) {
          throw new Error(`三相电流 KCL 质量审计遇到非正或非有限时间步长：${dtKcl}。`);
        }
        // Time-weighted RMS is required because imported/manual-downsampled
        // source timestamps can be nonuniform. Equal sample weighting would
        // bias the KCL audit toward densely sampled sections.
        phaseCurrentKclEnergyA2s += 0.5 * (previousKclSqA2 + kclSq) * dtKcl;
        phaseCurrentReferenceEnergyA2s += 0.5 * (previousPhaseReferenceSqA2 + phaseReferenceSq) * dtKcl;
        phaseCurrentKclDurationSec += dtKcl;
      }
      previousKclSqA2 = kclSq;
      previousPhaseReferenceSqA2 = phaseReferenceSq;
      phaseCurrentKclMaxA = Math.max(phaseCurrentKclMaxA, Math.abs(kcl));
      phaseCurrentKclSampleCount++;
    }
    if (stepRes.pStep.some((p) => !Number.isFinite(p) || p < 0)) {
      throw new Error(`FOC 热损耗在 t=${tCurr.toExponential(6)}s 出现 NaN/Inf 或负功率；已阻止将非法损耗注入热网络。`);
    }

    duty.a[k] = stepRes.da;
    duty.b[k] = stepRes.db;
    duty.c[k] = stepRes.dc;

    let stepTotal = 0;
    for (let m = 0; m < 6; m++) {
      const key = MOS_SWITCH_KEYS[m];
      pMos[key][k] = stepRes.pStep[m];
      tj[key][k] = curTj[m];
      stepTotal += stepRes.pStep[m];

      arithP[m] += stepRes.pStep[m];
      arithCond[m] += stepRes.pCondStep[m];
      arithSw[m] += stepRes.pSwStep[m];
      arithDead[m] += stepRes.pDeadStep[m];
      arithTj[m] += curTj[m];

      if (curTj[m] > peakTj[m]) peakTj[m] = curTj[m];
      if (tCurr >= rippleStartTime - 1e-15) {
        if (curTj[m] < ripMin[m]) ripMin[m] = curTj[m];
        if (curTj[m] > ripMax[m]) ripMax[m] = curTj[m];
      }
    }

    pInvTotal[k] = stepTotal;
    arithPInvSum += stepTotal;
    tBoard[k] = solver.getBoardTemp();

    if (k < len - 1) {
      const dt = Math.max(0, iaCh.t[idx + 1] - iaCh.t[idx]);
      solver.step(dt, stepRes.pStep);
      const nextTj = solver.getJunctionTemps();
      if (dt > 0) {
        accumulatedDt += dt;
        pInvEnergy += stepTotal * dt;
        for (let m = 0; m < 6; m++) {
          sumPEnergy[m] += stepRes.pStep[m] * dt;
          sumCondEnergy[m] += stepRes.pCondStep[m] * dt;
          sumCond25Energy[m] += stepRes.pCond25Step[m] * dt;
          sumSwEnergy[m] += stepRes.pSwStep[m] * dt;
          sumDeadEnergy[m] += stepRes.pDeadStep[m] * dt;
          sumTjDt[m] += 0.5 * (curTj[m] + nextTj[m]) * dt;
        }
      }
    }
  }

  const useTimeAvg = accumulatedDt > 1e-15;
  const summaries: MosSwitchSummary[] = MOS_SWITCH_KEYS.map((key, m) => ({
    key,
    tjAvgC: useTimeAvg ? sumTjDt[m] / accumulatedDt : arithTj[m] / len,
    tjPeakC: peakTj[m],
    tjFinalC: tj[key][len - 1],
    tjRippleC: ripMax[m] > -Infinity && ripMin[m] < Infinity ? Math.max(0, ripMax[m] - ripMin[m]) : 0,
    pAvgW: useTimeAvg ? sumPEnergy[m] / accumulatedDt : arithP[m] / len,
    pCondAvgW: useTimeAvg ? sumCondEnergy[m] / accumulatedDt : arithCond[m] / len,
    pSwAvgW: useTimeAvg ? sumSwEnergy[m] / accumulatedDt : arithSw[m] / len,
    pDeadAvgW: useTimeAvg ? sumDeadEnergy[m] / accumulatedDt : arithDead[m] / len,
  }));

  let hottestKey: MosSwitchKey = 'AH';
  let tjMaxGlobalC = -Infinity;
  for (const s of summaries) {
    if (s.tjPeakC > tjMaxGlobalC) {
      tjMaxGlobalC = s.tjPeakC;
      hottestKey = s.key;
    }
  }

  const pInvMeanW = useTimeAvg ? pInvEnergy / accumulatedDt : arithPInvSum / len;
  const tBoardFinalC = tBoard[len - 1];

  // Coupled steady-state extrapolation (exact coupled thermal/Rds(on)(Tj) solve + runaway check)
  const armJcs = buildPerSwitchJcChains(model);
  const jcStagesForTau = armJcs[0];
  const brdStages = model.zthBoard.length > 0 ? model.zthBoard : DEFAULT_FOC_MODEL.zthBoard;
  const rJcTotalByArm = armJcs.map((chain) => chain.reduce((s, c) => s + c.r, 0));
  const rBrdTotal = brdStages.reduce((s, c) => s + c.r, 0);
  const tauMaxBoardSec = computeDominantCauerTauSec(jcStagesForTau, brdStages);

  const alpha = mos.tempCoeffAlphaPerC || 0;
  const evalSwSteadyAtTj =
    hasDptLut && lutActiveDimsLatest.includes('Tj') && mos.dptLut
      ? (tjCand: number[]): number[] => {
          const pSwEnergyCand = [0, 0, 0, 0, 0, 0];
          const evalCount = len > 1 && useTimeAvg ? len - 1 : len;
          const maxSteadySamples = 4096;
          let totalWeight = 0;
          if (useTimeAvg && len > 1) {
            // Use exact piecewise-constant elapsed-time weighting (matching the main energy loop).
            // For very long captures (>4096 samples), select samples by elapsed time so dense
            // low-current segments cannot starve coarse high-current segments.
            const tFirst = iaCh.t[i0];
            const tLast = iaCh.t[i0 + len - 1];
            const minSpanDt = evalCount > maxSteadySamples ? (tLast - tFirst) / maxSteadySamples : 0;
            let k = 0;
            while (k < len - 1) {
              const idx = i0 + k;
              const tCurr = iaCh.t[idx];
              let nextK = k + 1;
              if (minSpanDt > 0) {
                while (nextK < len - 1 && iaCh.t[i0 + nextK] - tCurr < minSpanDt) {
                  nextK++;
                }
              }
              const dtSpan = iaCh.t[i0 + nextK] - tCurr;
              if (Number.isFinite(dtSpan) && dtSpan > 0) {
                const ia = iaSampler.sample(tCurr, idx);
                const ib = ibSampler.sample(tCurr, idx);
                const ic = icSampler ? icSampler.sample(tCurr, idx) : -(ia + ib);
                const vbus = vbusSampler ? vbusSampler.sample(tCurr, idx) : ctrl.vBusConstV;
                const da = duty.a[k];
                const db = duty.b[k];
                const dc = duty.c[k];
                const lA = computePhaseMosLosses(ia, da, vbus, tjCand[0], tjCand[1], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);
                const lB = computePhaseMosLosses(ib, db, vbus, tjCand[2], tjCand[3], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);
                const lC = computePhaseMosLosses(ic, dc, vbus, tjCand[4], tjCand[5], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);
                pSwEnergyCand[0] += (lA.pHighSw + lA.pHighDead) * dtSpan;
                pSwEnergyCand[1] += (lA.pLowSw + lA.pLowDead) * dtSpan;
                pSwEnergyCand[2] += (lB.pHighSw + lB.pHighDead) * dtSpan;
                pSwEnergyCand[3] += (lB.pLowSw + lB.pLowDead) * dtSpan;
                pSwEnergyCand[4] += (lC.pHighSw + lC.pHighDead) * dtSpan;
                pSwEnergyCand[5] += (lC.pLowSw + lC.pLowDead) * dtSpan;
                totalWeight += dtSpan;
              }
              k = nextK;
            }
          } else {
            const strideSteady = Math.max(1, Math.floor(len / 240));
            for (let k = 0; k < len; k += strideSteady) {
              const idx = i0 + k;
              const tCurr = iaCh.t[idx];
              const ia = iaSampler.sample(tCurr, idx);
              const ib = ibSampler.sample(tCurr, idx);
              const ic = icSampler ? icSampler.sample(tCurr, idx) : -(ia + ib);
              const vbus = vbusSampler ? vbusSampler.sample(tCurr, idx) : ctrl.vBusConstV;
              const da = duty.a[k];
              const db = duty.b[k];
              const dc = duty.c[k];
              const lA = computePhaseMosLosses(ia, da, vbus, tjCand[0], tjCand[1], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);
              const lB = computePhaseMosLosses(ib, db, vbus, tjCand[2], tjCand[3], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);
              const lC = computePhaseMosLosses(ic, dc, vbus, tjCand[4], tjCand[5], ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos);
              pSwEnergyCand[0] += lA.pHighSw + lA.pHighDead;
              pSwEnergyCand[1] += lA.pLowSw + lA.pLowDead;
              pSwEnergyCand[2] += lB.pHighSw + lB.pHighDead;
              pSwEnergyCand[3] += lB.pLowSw + lB.pLowDead;
              pSwEnergyCand[4] += lC.pHighSw + lC.pHighDead;
              pSwEnergyCand[5] += lC.pLowSw + lC.pLowDead;
              totalWeight += 1;
            }
          }
          return pSwEnergyCand.map((v) => v / Math.max(1e-18, totalWeight));
        }
      : undefined;

  const steadySolve = solveCoupledThermalSteadyState({
    pCond25W: useTimeAvg
      ? Array.from(sumCond25Energy, (energy) => energy / accumulatedDt)
      : summaries.map((s) => s.pCondAvgW / Math.max(0.05, getFocMosRdsFactorAtTj(mos, s.tjAvgC))),
    pFixedW: summaries.map((s) => s.pSwAvgW + s.pDeadAvgW),
    alphaPerC: alpha,
    evalCondFactorAtTj: mos.rdsOnTempCurve
      ? (tjVec) => tjVec.map((tj) => getFocMosRdsFactorAtTj(mos, tj))
      : undefined,
    rJcTotalByArm,
    rBrdTotal,
    tAmbC: ctrl.tAmbC,
    tInitSeedC: summaries.map((s) => s.tjAvgC),
    spatial: resolvedSpatial,
    evalFixedPowerAtTj: evalSwSteadyAtTj,
  });

  const tBoardSteadyEstC = steadySolve.tBoardSteadyC;
  const tjSteadyEstByKey = {} as Record<MosSwitchKey, number>;
  let tjSteadyMaxEstC = -Infinity;
  MOS_SWITCH_KEYS.forEach((k, m) => {
    tjSteadyEstByKey[k] = steadySolve.tjSteadyC[m];
    if (steadySolve.tjSteadyC[m] > tjSteadyMaxEstC) tjSteadyMaxEstC = steadySolve.tjSteadyC[m];
  });

  const convergenceForTemperature = (steadyC: number, finalC: number): number => {
    const steadyRise = steadyC - ctrl.tAmbC;
    const finalRise = finalC - ctrl.tAmbC;
    if (steadySolve.thermalRunaway || !Number.isFinite(steadyRise) || !Number.isFinite(finalRise)) return 0;
    if (Math.abs(steadyRise) <= 0.05) return Math.abs(finalRise) <= 0.05 ? 100 : 0;
    return Math.max(0, Math.min(100, (finalRise / steadyRise) * 100));
  };
  const boardConvergencePct = convergenceForTemperature(tBoardSteadyEstC, tBoardFinalC);
  const junctionConvergenceByKey = MOS_SWITCH_KEYS.map((key) =>
    convergenceForTemperature(tjSteadyEstByKey[key], tj[key][len - 1])
  );
  const junctionConvergencePct = Math.min(...junctionConvergenceByKey);
  const thermalConvergencePct = Math.min(boardConvergencePct, junctionConvergencePct);
  const phaseCurrentKclRmsA = icSampler && phaseCurrentKclDurationSec > 0
    ? Math.sqrt(phaseCurrentKclEnergyA2s / phaseCurrentKclDurationSec)
    : null;
  const phaseCurrentReferenceRmsA = icSampler && phaseCurrentKclDurationSec > 0
    ? Math.sqrt(phaseCurrentReferenceEnergyA2s / phaseCurrentKclDurationSec)
    : null;
  const phaseCurrentKclRelativePct = phaseCurrentKclRmsA !== null && phaseCurrentReferenceRmsA !== null
    ? (phaseCurrentKclRmsA / Math.max(phaseCurrentReferenceRmsA, 1e-9)) * 100
    : null;

  const maxSubDtOverTau = solver.getMaxSubDtOverTau();
  const finalThermalState = solver.getStateSnapshot();
  const boardFinalVec = solver.getBoardTempsBySwitch();
  const tBoardByKey = {} as Record<MosSwitchKey, number>;
  MOS_SWITCH_KEYS.forEach((k, m) => {
    tBoardByKey[k] = boardFinalVec[m];
  });

  const eossSource: FocSimulationResult['eossSource'] = mos.eossAlreadyIncludedInEsw
    ? 'included_in_esw'
    : qossCoveredByQr(mos)
    ? 'included_in_qrr'
    : mos.eossCurve
    ? 'nonlinear_curve'
    : (mos.eossUj ?? 0) > 0
    ? 'vbus_sq_approx'
    : 'none';

  const warnings: string[] = [...alignmentWarnings];
  const missingLossInputs: string[] = [];
  const assumptionReasons: string[] = [];
  const hasSwitchingEnergyInput = hasDptLut || mos.eonPlusEoffUj > 0;
  if (!hasSwitchingEnergyInput) missingLossInputs.push('Eon+Eoff/DPT');
  if (!hasDptLut && !mos.eonIncludesQrr && mos.qrrNc <= 0) missingLossInputs.push('Qrr');
  if (!mos.eossAlreadyIncludedInEsw && !mos.eossCurve && (mos.eossUj ?? 0) <= 0 && !qossCoveredByQr(mos)) missingLossInputs.push('Eoss');
  if (mos.rdsDataConfirmed !== true) assumptionReasons.push('Rds(on)@25°C 未按目标器件 Vgs/测试条件确认');
  if (!hasDptLut) assumptionReasons.push('开关损耗采用单点 Eon+Eoff 标量缩放，而非多工况 DPT LUT');
  if (model.modelKind !== 'datasheet_constrained' || model.zthValidation?.passed !== true) {
    assumptionReasons.push('热网络未通过目标器件数据手册约束及拆分一致性验证');
  }
  if (missingLossInputs.length > 0) {
    warnings.push(`损耗模型输入不完整：缺少 ${missingLossInputs.join('、')}；对应损耗按 0 处理，P_inv 与 Tj 是已建模损耗下的偏低估算，不得用于器件热设计签核。`);
  }
  if (mos.rdsDataConfirmed !== true) {
    warnings.push('Rds(on)@25°C 当前按界面起算值参与导通损耗计算，但确认框未勾选；结果必须标为假设估算，不能解释为目标 MOS 实测/数据手册参数结果。');
  }
  const resultQualification: FocSimulationResult['resultQualification'] = missingLossInputs.length > 0
    ? 'INCOMPLETE_LOSS_MODEL'
    : assumptionReasons.length > 0
    ? 'ASSUMPTION_BASED'
    : 'DEVICE_PARAMETERIZED';
  const qualificationReasons = [...missingLossInputs.map((x) => `未提供 ${x} 损耗数据`), ...assumptionReasons];
  if (model.modelKind === 'fallback_default' || model.modelKind === 'demo_builtin' || !model.modelKind) {
    warnings.push(`当前热网络来源为 ${model.modelKind || '未标注模型'}，不是该 MOSFET/PCB 的实测热阻网络；Tj 只可用于方法验证或趋势比较，不得作为器件热设计签核值。`);
  }
  if (model.zthBoard.length === 0 || model.zthJC.length === 0) {
    warnings.push('输入热模型存在空 JC/Board 阶梯，仿真已使用内置默认阶梯补齐；结果不代表实际封装与 PCB 热路径。');
  }
  if (resolvedSpatial.mode === 'shared_board') {
    warnings.push('当前六管热网络采用六个器件支路汇入单一共享 Board 节点的集总模型；未输入 PCB 铜厚/铜箔/过孔/布局和六管互热阻矩阵时，不代表真实 PCB 空间温度场，热点结论仅适用于该集总网络。');
  } else {
    warnings.push(`已启用六管热拓扑模式：${resolvedSpatial.provenanceLabel}。`);
  }
  if (model.modelKind === 'fallback_default') {
    warnings.push('当前使用内置默认参考热网络（非具体 MOS 数据手册/实测 Zth）；结温仅为演示性或初步筛查估算，不得用于器件选型签核或安全裕量结论。');
  } else if (model.modelKind === 'pad_ambient') {
    warnings.push('警告：当前热网络源自 PCB/焊盘测温 (pad_ambient)，缺失真实芯片结-壳 ZthJC，算出的 Tj 仅代表传感器等效点温升！');
  } else if (model.modelKind === 'demo_builtin') {
    warnings.push('当前使用内置 FOC Demo 参考热模型，切换至实测波形时请在 Tab 1 反演或手动设定器件 Zth 参数。');
  }
  if (hasDptLut && mos.dptLut) {
    const activeLbl = lutActiveDimsLatest.length > 0 ? lutActiveDimsLatest.join('×') : '0D';
    const collapsedLbl = lutCollapsedDimsLatest.length > 0 ? `；退化常数维度: [${lutCollapsedDimsLatest.join(', ')}]` : '';
    warnings.push(
      `MOS 开关损耗已启用 ${mos.dptLut.length} 点 DPT 查找表 (${activeLbl} 插值, status=${lutStatusLatest || 'VALID'}, Tj来源=${lutTjProvLatest}, Rg来源=${lutRgProvLatest}${collapsedLbl})。`
    );
    if (lutExtrapolatedSamples > 0 || lutOutOfRangeCount > 0) {
      warnings.push(
        `注意：DPT LUT 共有 ${Math.max(lutExtrapolatedSamples, lutOutOfRangeCount)} 次查询超出实测凸包/边界 (OUT_OF_RANGE，Vbus=[${opVMin.toFixed(1)}~${opVMax.toFixed(1)}]V, I_max=${opIMax.toFixed(1)}A vs LUT [${lutVMin.toFixed(1)}~${lutVMax.toFixed(1)}]V × [${lutIMin.toFixed(1)}~${lutIMax.toFixed(1)}]A)。`
      );
    }
  } else {
    warnings.push('MOS 开关损耗当前采用参考 Eon+Eoff 标量按 V/I 缩放；其口径按“单颗硬开关 MOS、每 PWM 周期的 Eon+Eoff”解释，并按电流方向分配至对应硬开关器件，不代表整桥/半桥六管损耗合计值。若数据手册/DPT 的能量口径是双管或整桥合计，必须先换算。未提供覆盖 Vbus、Id、Tj、Rg 的器件 DPT/LUT 时，不应把该结果作为最坏开关损耗签核值。');
    if (scalarWideScaleSamples > 0) {
      warnings.push(
        `注意：共有 ${scalarWideScaleSamples} 步仿真工况相对单点参考 (Vref=${mos.vRefV.toFixed(1)}V, Iref=${mos.iRefA.toFixed(1)}A) 缩放倍率超过 2× 或低于 0.25×（仿真峰值 I_max=${opIMax.toFixed(1)}A, Vbus=[${opVMin.toFixed(1)}~${opVMax.toFixed(1)}]V），非线性开关损耗偏差可能较大。`
      );
    }
  }
  if (eossSource === 'vbus_sq_approx') {
    warnings.push('当前 Eoss 仅输入 Vref 处的单点能量，并按 Eoss∝Vbus² 低精度 V² 近似缩放（等效假设 Coss 不随电压变化）；真实 MOS Coss 通常强非线性，需用器件 Eoss(V)/Qoss(V) 曲线替代。');
  } else if (eossSource === 'nonlinear_curve') {
    warnings.push(`Eoss 已采用非线性 ${mos.eossCurve!.kind.toUpperCase()} 曲线 PCHIP 插值计算（来源=${mos.eossCurve!.provenance ?? 'unspecified'}）；超出曲线定义域的脉冲会拒绝计算，不使用边界截断值。`);
    if (mos.eossCurve!.referenceTemperatureC !== undefined) {
      const tjCurveDelta = Math.max(...summaries.map((summary) => Math.abs(summary.tjAvgC - mos.eossCurve!.referenceTemperatureC!)));
      if (tjCurveDelta > 10) {
        warnings.push(`Eoss 曲线参考温度为 ${mos.eossCurve!.referenceTemperatureC}°C，当前六管平均结温与参考温度最大偏差 ${tjCurveDelta.toFixed(1)}°C；当前曲线无温度维度，未进行温度修正，Eoss 结果属于参考温度曲线估算。`);
      }
    }
  } else if (eossSource === 'included_in_esw') {
    warnings.push('已启用 Eoss 防重算保护 (eossAlreadyIncludedInEsw=true)：Esw 已涵盖 Coss 充放电损耗，独立 Eoss 项置零。');
  } else if (eossSource === 'included_in_qrr') {
    warnings.push('当前 Qr 按 Nexperia 定义包含 Qoss（Qr=Qs+Qoss），已屏蔽独立 Eoss，避免同一换流电荷重复计量；Qr×Vbus 仍是总恢复能量的一阶近似，不等同于 DPT 波形能量积分。');
  }
  if (partialDutySelected) {
    warnings.push('仅选择了部分外部 Duty 通道，需同时指定 Duty_A / Duty_B / Duty_C 三路才会启用外部占空比，当前已回退为无传感器重构。');
  }
  if (useExternalDuty && dutyPctInferredChannels.length > 0) {
    warnings.push(`外部占空比通道 ${dutyPctInferredChannels.join('、')} 未标注单位，但同组三相数据提示按百分比 (0~100%) 解释；已仅对无单位通道按百分比缩放 0.01，明确标注 pu/% 的通道各自按其单位处理。建议在源文件明确标注单位。`);
  }
  if (useExternalDuty && dutyBinaryPulseSuspected) {
    warnings.push('外部 Duty_A/B/C 超过 95% 样本处于精确 0 或 1（疑似原始 PWM 开关方波脉冲而非周期平均占空比），开关损耗将被按钳位跳过。');
  }
  if (!steadySolve.converged && !steadySolve.thermalRunaway) {
    warnings.push('耦合热稳态求解器未达到收敛条件；稳态结温外推仅供诊断，不得作为稳态安全签核依据。');
  }
  if (junctionConvergencePct < 90) {
    warnings.push(`六颗 MOS 中最慢结温收敛度仅 ${junctionConvergencePct.toFixed(1)}%（Board=${boardConvergencePct.toFixed(1)}%）；当前瞬态时长不足以代表结温稳态，不能只依据 T_board 判断热稳定。`);
  }
  if (phaseCurrentKclRelativePct !== null && phaseCurrentKclRmsA !== null && phaseCurrentKclRelativePct > 5) {
    warnings.push(`三相电流 KCL 残差 RMS=${phaseCurrentKclRmsA.toFixed(3)}A，占三相 RMS 参考值 ${phaseCurrentKclRelativePct.toFixed(1)}%（峰值残差 ${phaseCurrentKclMaxA.toFixed(3)}A）；请检查相序、探头极性、采样同步或三相电流重构，六管损耗分配可能失真。`);
  }
  if (!useExternalDuty && overmodulatedCount > 0) {
    const ceiling = getModulationLinearCeiling(ctrl.modulation);
    warnings.push(
      `调制深度 m=${ctrl.modDepthM.toFixed(3)} 超出 ${ctrl.modulation} 线性区上限 (${ceiling.toFixed(4)})，共 ${overmodulatedCount} 采样点进入过调制削波区 [0, 1]，损耗未包含过调制谐波增幅。`
    );
  }
  if (!useExternalDuty && zeroCurrentFallbackCount > 0) {
    warnings.push(
      `共 ${zeroCurrentFallbackCount} 个采样点相电流矢量幅值 |I_αβ| < 1e-6 A（零电流/停机区间），无传感器占空比重构无法观测转子电角度，已安全回退为中点占空比 0.50（若需精确零电流 PWM 损耗请接入外部 Duty_A/B/C 或位置传感器）。`
    );
  }
  if (pointsPerElecCycle !== null && pointsPerElecCycle < 6) {
    warnings.push(
      `相电流基波电周期采样点数严重不足（约 ${pointsPerElecCycle.toFixed(1)} 点/电周期 < 6），峰值/RMS 与六管损耗分配可能明显失真；该波形不宜用于热设计签核。注意：该准则针对电流基波包络，并非开关载波采样判据。`
    );
  } else if (pointsPerElecCycle !== null && pointsPerElecCycle < 20) {
    warnings.push(
      `相电流基波采样分辨率偏低（约 ${pointsPerElecCycle.toFixed(1)} 点/电周期 < 20），热结果仅适合趋势估算；建议提高采样密度并确认峰值电流未被降采样丢失。该模型按平均开关损耗计算，不解析 PWM 载波边沿。`
    );
  }
  if (maxSubDtOverTau > 0.25) {
    warnings.push(
      `波形采样步长远大于最快热时间常数 τ_min=${(solver.getMinTau() * 1e3).toFixed(3)}ms，经 4096 级子步细分后仍有 max(subDt/τ_min)=${maxSubDtOverTau.toFixed(2)} > 0.25，快瞬态芯片结温峰值可能被数值平滑。`
    );
  }
  if (i0 > 0) {
    if (gateThermalMode === 'cold') {
      warnings.push(
        `时间门控从 t=${iaCh.t[i0].toFixed(4)}s 启动并选择了「冷启动重置至 T_amb=${ctrl.tAmbC.toFixed(1)}°C」，门控前 ${preheatDurationSec.toFixed(4)}s 的温升未计入。`
      );
    } else {
      warnings.push(
        `已继承门控前 ${preheatDurationSec.toFixed(4)}s 热历史：初值 Tj_max=${thermalInitInfo.tjInitialMaxC.toFixed(2)}°C, T_board=${thermalInitInfo.tBoardInitialC.toFixed(2)}°C。`
      );
    }
  }
  if (steadySolve.thermalRunaway) {
    warnings.push(
      `检测到正温度系数 α=${(alpha * 100).toFixed(2)}%/°C 与高热阻耦合引发热失控（稳态反馈环路增益 ≥ 1），结温不存在有限稳态平衡点（预览已钳位至 ${tjSteadyMaxEstC.toFixed(0)}°C）。`
    );
  } else if (tauMaxBoardSec > 0 && accumulatedDt < 2.5 * tauMaxBoardSec && thermalConvergencePct < 90) {
    warnings.push(
      `当前仿真时长 ${accumulatedDt.toFixed(3)}s 仅覆盖系统主导时间常数 τ_dom=${tauMaxBoardSec.toFixed(2)}s 的 ${(accumulatedDt / tauMaxBoardSec).toFixed(2)}×（T_board 收敛 ${thermalConvergencePct.toFixed(1)}%），稳态预测约为 T_board=${tBoardSteadyEstC.toFixed(1)}°C, Tj_max=${tjSteadyMaxEstC.toFixed(1)}°C。`
    );
  }

  return {
    resultQualification,
    qualificationReasons,
    time,
    tj,
    pMos,
    pInvTotal,
    tBoard,
    tBoardByKey,
    thermalTopologyMode: resolvedSpatial.mode,
    spatialThermalProvenance: resolvedSpatial.provenanceLabel,
    duty,
    summaries,
    hottestKey,
    tjMaxGlobalC,
    pInvMeanW,
    tBoardFinalC,
    durationSec: accumulatedDt,
    tauMaxBoardSec,
    tBoardSteadyEstC,
    tjSteadyMaxEstC,
    tjSteadyEstByKey,
    thermalConvergencePct,
    junctionConvergencePct,
    phaseCurrentKclRmsA,
    phaseCurrentKclRelativePct,
    steadyConverged: steadySolve.converged,
    steadyThermalRunaway: steadySolve.thermalRunaway,
    overmodulatedCount,
    zeroCurrentFallbackCount,
    maxSubDtOverTau,
    pointsPerElecCycle,
    finalThermalState,
    dutySource: useExternalDuty ? 'external' : 'reconstructed',
    dptLutDiagnostics: hasDptLut
      ? {
          status: lutStatusLatest || 'VALID',
          activeDimensions: lutActiveDimsLatest,
          collapsedDimensions: lutCollapsedDimsLatest,
          outOfRangeCount: lutOutOfRangeCount,
          tjProvenance: lutTjProvLatest,
          rgProvenance: lutRgProvLatest,
        }
      : undefined,
    eossSource,
    alignmentWarnings,
    warnings,
    thermalInitInfo,
  };
}

/**
 * Phase 2 Stall Sweep (Zero-Speed Locked-Rotor 0..360 deg Electrical Angle Scan):
 * Finds worst electrical angle and switch, checks steady-state margin vs Tj_limit,
 * solves exact safe stall time t_safe (s) and dual I^2*t thresholds (phase RMS and worst phase leg).
 */
export function runFocStallSweep(opts: FocStallSweepOptions): FocStallSweepResult {
  const finiteInRange = (value: number, min: number, max: number): boolean =>
    Number.isFinite(value) && value >= min && value <= max;
  if (!opts || !opts.model || !opts.mos) throw new Error('堵转热扫描缺少 MOS 参数或热模型。');
  if (opts.model.splitFeasible === false) {
    throw new Error(opts.model.splitMeta?.warning || '热模型 ZthJC / Zth_board 手册约束拆分不可行，已拒绝堵转热扫描。');
  }
  if (!finiteInRange(opts.iPeakA, 1e-6, 1e6)) throw new Error('堵转峰值电流 I_pk 必须为有限正数。');
  if (!finiteInRange(opts.tjLimitC, -273.14, 2000)) throw new Error('Tj_limit 必须高于绝对零度且不超过 2000°C。');
  if (!finiteInRange(opts.tAmbC, -273.14, 1000)) throw new Error('环境温度必须高于绝对零度且不超过 1000°C。');
  if (!finiteInRange(opts.vBusV, 1e-6, 2000)) throw new Error('堵转母线电压 Vbus 必须为有限正数且不超过 2000V。');
  if (!finiteInRange(opts.fswHz, 1, 5e6)) throw new Error('堵转开关频率 fswHz 必须为 1Hz～5MHz。');
  if (!finiteInRange(opts.tDeadNs, 0, 1e6)) throw new Error('堵转死区时间必须为 0～1,000,000ns。');
  if (!finiteInRange(opts.modDepthM, 0, 2)) throw new Error('堵转调制深度必须位于 0～2。');
  if (opts.pfAngleDeg !== undefined && !finiteInRange(opts.pfAngleDeg, -180, 180)) throw new Error('堵转 PF 相角必须位于 -180°～180°。');
  if (!['SVPWM', 'DPWM1', 'SPWM'].includes(opts.modulation)) throw new Error('堵转调制模式无效。');
  if (opts.horizonSec !== undefined && !finiteInRange(opts.horizonSec, 1e-3, 3600)) throw new Error('堵转热瞬态计算时域必须在 1ms～3600s。');
  if (opts.tInitialBoardC !== undefined && !finiteInRange(opts.tInitialBoardC, -273.14, 2000)) throw new Error('初始 Board 温度无效。');
  if (opts.rPhaseOhm !== undefined && !finiteInRange(opts.rPhaseOhm, 1e-9, 1e6)) throw new Error('相电阻 R_phase 必须为有限正数。');
  if (opts.mos.rdsOnTempCurve) validateRdsOnTempCurveForMos(opts.mos);
  validateMosEnergyAccounting(opts.mos);
  if (!finiteInRange(opts.mos.rdsOn25Mohm, Number.EPSILON, 1e6) ||
      (!opts.mos.rdsOnTempCurve && !finiteInRange(opts.mos.tempCoeffAlphaPerC, 0, 0.05)) ||
      !finiteInRange(opts.mos.vsdV, 0, 10) ||
      !finiteInRange(opts.mos.eonPlusEoffUj, 0, 1e9) ||
      !finiteInRange(opts.mos.vRefV, Number.EPSILON, 1e6) ||
      !finiteInRange(opts.mos.iRefA, Number.EPSILON, 1e6) ||
      !finiteInRange(opts.mos.qrrNc, 0, 1e9) ||
      (opts.mos.qrrIrefA !== undefined && !finiteInRange(opts.mos.qrrIrefA, Number.EPSILON, 1e6)) ||
      (opts.mos.eossUj !== undefined && !finiteInRange(opts.mos.eossUj, 0, 1e9))) {
    throw new Error('堵转扫描 MOS 损耗参数无效；请检查 Rds(on)、温度系数、Vsd、Eon/Eoff、Vref/Iref、Qrr/Eoss。');
  }
  const jcStages = opts.model.zthJC.length > 0 ? opts.model.zthJC : DEFAULT_FOC_MODEL.zthJC;
  const boardStages = opts.model.zthBoard.length > 0 ? opts.model.zthBoard : DEFAULT_FOC_MODEL.zthBoard;
  for (const [label, stages] of [['ZthJC', jcStages], ['ZthBoard', boardStages]] as const) {
    if (stages.length === 0 || stages.some((stage) => !finiteInRange(stage.r, Number.EPSILON, 1e9) || !finiteInRange(stage.c, Number.EPSILON, 1e12))) {
      throw new Error(`堵转扫描 ${label} Cauer 阶梯必须全部为有限正 R/C。`);
    }
  }
  if (opts.model.perSwitchRjcScale && (opts.model.perSwitchRjcScale.length !== 6 || opts.model.perSwitchRjcScale.some((v) => !finiteInRange(v, 0.01, 100)))) {
    throw new Error('堵转扫描 perSwitchRjcScale 必须是 6 个 0.01～100 的有限正数。');
  }
  if (opts.model.perSwitchPadOffsetCPerW && (opts.model.perSwitchPadOffsetCPerW.length !== 6 || opts.model.perSwitchPadOffsetCPerW.some((v) => !finiteInRange(v, 0, 1e6)))) {
    throw new Error('堵转扫描 perSwitchPadOffsetCPerW 必须是 6 个有限非负值。');
  }
  if (opts.initialThermalState) {
    const st = opts.initialThermalState;
    const armChains = buildPerSwitchJcChains(opts.model);
    if (!Array.isArray(st.armT) || st.armT.length !== 6 ||
        st.armT.some((chain, index) => !Array.isArray(chain) || chain.length !== armChains[index].length || chain.some((v) => !finiteInRange(v, -273.14, 2000))) ||
        !Array.isArray(st.brdT) || st.brdT.length !== boardStages.length || st.brdT.some((v) => !finiteInRange(v, -273.14, 2000)) ||
        !finiteInRange(st.tBoardC, -273.14, 2000)) {
      throw new Error('继承的热网络节点状态与当前 Cauer 模型阶数不匹配或包含非法温度，拒绝将旧状态映射到新热模型。请重新运行 MOS Thermal 或使用冷态初温。');
    }
  }
  const armJcs = buildPerSwitchJcChains(opts.model);
  const brd = opts.model.zthBoard.length > 0 ? opts.model.zthBoard : DEFAULT_FOC_MODEL.zthBoard;
  const rJcByArm = armJcs.map((chain) => chain.reduce((s, c) => s + c.r, 0));
  const rBrd = brd.reduce((s, c) => s + c.r, 0);

  const stallMode = opts.stallDutyMode === 'user_m' ? 'user_m' : 'resistive';
  const rPhaseUsedOhm =
    opts.rPhaseOhm !== undefined && Number.isFinite(opts.rPhaseOhm) && opts.rPhaseOhm > 0
      ? opts.rPhaseOhm
      : 0.25;
  const rTotalPhase = rPhaseUsedOhm + Math.max(0, opts.mos.rdsOn25Mohm * 1e-3);
  const svpwmCeiling = getModulationLinearCeiling('SVPWM');
  const deadEdgeDuty = opts.tDeadNs * 1e-9 * opts.fswHz;
  if (deadEdgeDuty >= 0.45) {
    throw new Error(`堵转死区占空比过大 (${(deadEdgeDuty * 100).toFixed(1)}%)，单边死区已占用 ≥45% 开关周期，无法建立有效 PWM 脉冲。`);
  }
  // True dead-time-safe linear SVPWM ceiling: max duty = 0.5 + (sqrt(3)/4)*m must stay strictly below (1 - deadEdgeDuty)
  // across all 72 swept electrical angles so narrow-pulse deletion is never entered silently.
  const svpwmUsableCeiling =
    deadEdgeDuty > 0
      ? svpwmCeiling * Math.max(0.01, 1 - 2 * deadEdgeDuty - 1e-5)
      : svpwmCeiling;
  const mReqStall = (2 * opts.iPeakA * rTotalPhase) / Math.max(1, opts.vBusV);
  const stallVoltageLimited = stallMode === 'resistive' && mReqStall > svpwmUsableCeiling + 1e-6;
  const effM =
    stallMode === 'resistive'
      ? Math.min(svpwmUsableCeiling, Math.max(0.005, mReqStall))
      : opts.modDepthM;
  const effMod: FocModulationMode = stallMode === 'resistive' ? 'SVPWM' : opts.modulation;
  const effPfAngleDeg = stallMode === 'user_m' ? (opts.pfAngleDeg ?? 0) : 0;

  const anglesDeg: number[] = [];
  const steadyMaxTjPerAngle: number[] = [];

  let worstAngleDeg = 0;
  let worstSwitch: MosSwitchKey = 'AH';
  let worstSteadyTjC = -Infinity;

  const twoPi3 = (2 * Math.PI) / 3;
  const iRmsPhase = opts.iPeakA / Math.SQRT2;
  // Preserve the physical Ipk^2/2 exactly; a fixed 1e-9 A² floor inflated
  // sinusoidal-equivalent I²t for small but valid requested currents.
  const iRmsSq = iRmsPhase * iRmsPhase;

  let stallSteadyConverged = true;
  let stallThermalRunaway = false;

  const stallSpatial = resolveSpatialThermalNetwork(opts.model);
  const probeTjC = resolveInitialThermalProbeTjC(opts.mos, opts.tAmbC);
  const seedTjC = resolveInitialThermalProbeTjC(opts.mos, opts.tAmbC + 10);
  for (let deg = 0; deg < 360; deg += 5) {
    const rad = (deg * Math.PI) / 180;
    const ia = opts.iPeakA * Math.cos(rad);
    const ib = opts.iPeakA * Math.cos(rad - twoPi3);
    const ic = opts.iPeakA * Math.cos(rad + twoPi3);

    const rec = reconstructSensorlessDutySample(ia, ib, ic, effMod, effM, effPfAngleDeg);

    const lBaseA = computePhaseMosLosses(ia, rec.da, opts.vBusV, probeTjC, probeTjC, effMod, opts.fswHz, opts.tDeadNs, opts.mos);
    const lBaseB = computePhaseMosLosses(ib, rec.db, opts.vBusV, probeTjC, probeTjC, effMod, opts.fswHz, opts.tDeadNs, opts.mos);
    const lBaseC = computePhaseMosLosses(ic, rec.dc, opts.vBusV, probeTjC, probeTjC, effMod, opts.fswHz, opts.tDeadNs, opts.mos);
    const hasDptTjAxis =
      Boolean(lBaseA.lutActiveDims?.includes('Tj')) ||
      Boolean(lBaseB.lutActiveDims?.includes('Tj')) ||
      Boolean(lBaseC.lutActiveDims?.includes('Tj'));
    const evalFixedPowerAtTj = hasDptTjAxis
      ? (tjCand: number[]): number[] => {
          const lA = computePhaseMosLosses(ia, rec.da, opts.vBusV, tjCand[0], tjCand[1], effMod, opts.fswHz, opts.tDeadNs, opts.mos);
          const lB = computePhaseMosLosses(ib, rec.db, opts.vBusV, tjCand[2], tjCand[3], effMod, opts.fswHz, opts.tDeadNs, opts.mos);
          const lC = computePhaseMosLosses(ic, rec.dc, opts.vBusV, tjCand[4], tjCand[5], effMod, opts.fswHz, opts.tDeadNs, opts.mos);
          return [
            lA.pHighSw + lA.pHighDead,
            lA.pLowSw + lA.pLowDead,
            lB.pHighSw + lB.pHighDead,
            lB.pLowSw + lB.pLowDead,
            lC.pHighSw + lC.pHighDead,
            lC.pLowSw + lC.pLowDead,
          ];
        }
      : undefined;
    const stallSteady = solveCoupledThermalSteadyState({
      pCond25W: [
        lBaseA.pHighCond25W,
        lBaseA.pLowCond25W,
        lBaseB.pHighCond25W,
        lBaseB.pLowCond25W,
        lBaseC.pHighCond25W,
        lBaseC.pLowCond25W,
      ],
      pFixedW: [
        lBaseA.pHighSw + lBaseA.pHighDead,
        lBaseA.pLowSw + lBaseA.pLowDead,
        lBaseB.pHighSw + lBaseB.pHighDead,
        lBaseB.pLowSw + lBaseB.pLowDead,
        lBaseC.pHighSw + lBaseC.pHighDead,
        lBaseC.pLowSw + lBaseC.pLowDead,
      ],
      alphaPerC: opts.mos.tempCoeffAlphaPerC || 0,
      evalCondFactorAtTj: opts.mos.rdsOnTempCurve
        ? (tjVec) => tjVec.map((tj) => getFocMosRdsFactorAtTj(opts.mos, tj))
        : undefined,
      rJcTotalByArm: rJcByArm,
      rBrdTotal: rBrd,
      tAmbC: opts.tAmbC,
      tInitSeedC: new Array<number>(6).fill(seedTjC),
      spatial: stallSpatial,
      evalFixedPowerAtTj,
    });
    const tjSteady = stallSteady.tjSteadyC;
    if (!stallSteady.converged) stallSteadyConverged = false;
    if (stallSteady.thermalRunaway) stallThermalRunaway = true;

    let maxAngTj = -Infinity;
    let maxAngIdx = 0;
    for (let m = 0; m < 6; m++) {
      if (tjSteady[m] > maxAngTj) {
        maxAngTj = tjSteady[m];
        maxAngIdx = m;
      }
    }

    anglesDeg.push(deg);
    steadyMaxTjPerAngle.push(maxAngTj);

    if (maxAngTj > worstSteadyTjC) {
      worstSteadyTjC = maxAngTj;
      worstAngleDeg = deg;
      worstSwitch = MOS_SWITCH_KEYS[maxAngIdx];
    }
  }

  // A nonuniform inherited junction-temperature vector can make the fastest
  // transient Tj-limit crossing occur at a different electrical angle than
  // the maximum steady-state angle. Evaluate the transient for every angle.
  // Honor the caller's requested horizon exactly. The earlier 5 s floor
  // contradicted the public 1 ms..3600 s validation and could report a t_safe
  // result outside the requested observation window. Keep a positive first
  // logarithmic step even for sub-millisecond-scale early dynamics.
  const horizon = opts.horizonSec ?? 120;
  const nPts = 280;
  const tMin = Math.min(1e-3, horizon / 1e3);
  const transientTime = new Float64Array(nPts);
  for (let i = 0; i < nPts; i++) {
    transientTime[i] = i === 0 ? 0 : tMin * Math.pow(horizon / tMin, (i - 1) / (nPts - 2));
  }

  const hasValidInitialState = Boolean(
    opts.initialThermalState &&
    Array.isArray(opts.initialThermalState.armT) &&
    opts.initialThermalState.armT.length === 6 &&
    Array.isArray(opts.initialThermalState.brdT) &&
    opts.initialThermalState.brdT.length > 0
  );
  const hasScalarBoardInit = opts.tInitialBoardC !== undefined && Number.isFinite(opts.tInitialBoardC);
  const inheritedHotState = hasValidInitialState || hasScalarBoardInit;

  let selectedTransient: {
    angleDeg: number;
    tSafeSec: number | null;
    terminalMaxTjC: number;
    worstSwitch: MosSwitchKey;
    phaseSquaredRatio: number;
    worstTj: Float32Array;
  } | null = null;

  for (let angleIndex = 0; angleIndex < anglesDeg.length; angleIndex++) {
    const angleDeg = anglesDeg[angleIndex];
    const angleRad = (angleDeg * Math.PI) / 180;
    const iaAngle = opts.iPeakA * Math.cos(angleRad);
    const ibAngle = opts.iPeakA * Math.cos(angleRad - twoPi3);
    const icAngle = opts.iPeakA * Math.cos(angleRad + twoPi3);
    const recAngle = reconstructSensorlessDutySample(iaAngle, ibAngle, icAngle, effMod, effM, effPfAngleDeg);
    const maxPhaseSq = Math.max(iaAngle * iaAngle, ibAngle * ibAngle, icAngle * icAngle);
    const phaseSquaredRatio = maxPhaseSq / iRmsSq;

    const solver = new StarCoupled6MosThermalSolver(
      opts.model,
      opts.tAmbC,
      opts.tInitialBoardC ?? opts.tAmbC,
      opts.initialThermalState
    );
    const angleTransientWorstTj = new Float32Array(nPts);
    let angleTSafeSec: number | null = null;
    let terminalMaxTjC = -Infinity;
    let angleWorstSwitch: MosSwitchKey = 'AH';
    let crossingWorstSwitch: MosSwitchKey | null = null;

    for (let i = 0; i < nPts; i++) {
      const cur = solver.getJunctionTemps();
      if (cur.some((v) => !Number.isFinite(v))) {
        throw new Error(`堵转热瞬态在 θ=${angleDeg}°、t=${transientTime[i].toExponential(4)}s 出现非有限结温；已阻止返回不可信 t_safe。`);
      }
      let maxNow = -Infinity;
      let maxIdx = 0;
      for (let m = 0; m < cur.length; m++) {
        if (cur[m] > maxNow) { maxNow = cur[m]; maxIdx = m; }
      }
      angleTransientWorstTj[i] = maxNow;
      angleWorstSwitch = MOS_SWITCH_KEYS[maxIdx];
      terminalMaxTjC = maxNow;

      if (i === 0 && maxNow >= opts.tjLimitC) {
        angleTSafeSec = 0;
        crossingWorstSwitch = MOS_SWITCH_KEYS[maxIdx];
      }

      if (i < nPts - 1) {
        const lA = computePhaseMosLosses(iaAngle, recAngle.da, opts.vBusV, cur[0], cur[1], effMod, opts.fswHz, opts.tDeadNs, opts.mos);
        const lB = computePhaseMosLosses(ibAngle, recAngle.db, opts.vBusV, cur[2], cur[3], effMod, opts.fswHz, opts.tDeadNs, opts.mos);
        const lC = computePhaseMosLosses(icAngle, recAngle.dc, opts.vBusV, cur[4], cur[5], effMod, opts.fswHz, opts.tDeadNs, opts.mos);
        const ps = [lA.pHighTotal, lA.pLowTotal, lB.pHighTotal, lB.pLowTotal, lC.pHighTotal, lC.pLowTotal];
        const dtStep = transientTime[i + 1] - transientTime[i];
        const stateBeforeStep = angleTSafeSec === null ? solver.getStateSnapshot() : null;
        solver.step(dtStep, ps);

        if (angleTSafeSec === null && stateBeforeStep) {
          const nextTemps = solver.getJunctionTemps();
          if (nextTemps.some((v) => !Number.isFinite(v))) {
            throw new Error(`堵转热瞬态在 θ=${angleDeg}°、t=${transientTime[i + 1].toExponential(4)}s 出现非有限结温；已阻止返回不可信 t_safe。`);
          }
          const nextMax = Math.max(...nextTemps);
          if (nextMax >= opts.tjLimitC) {
            // Refine the first crossing inside this logarithmic output interval.
            // Power is held constant over the interval, matching the main
            // solver's piecewise-constant loss update, while the implicit RC
            // network is replayed from the exact pre-step state.
            let lo = 0;
            let hi = dtStep;
            let crossingTemps = nextTemps;
            for (let refine = 0; refine < 18; refine++) {
              const mid = 0.5 * (lo + hi);
              const probe = new StarCoupled6MosThermalSolver(
                opts.model,
                opts.tAmbC,
                opts.tInitialBoardC ?? opts.tAmbC,
                stateBeforeStep
              );
              probe.step(mid, ps);
              const probeTemps = probe.getJunctionTemps();
              if (Math.max(...probeTemps) >= opts.tjLimitC) {
                hi = mid;
                crossingTemps = probeTemps;
              } else {
                lo = mid;
              }
            }
            angleTSafeSec = transientTime[i] + hi;
            let crossingIdx = 0;
            for (let m = 1; m < crossingTemps.length; m++) {
              if (crossingTemps[m] > crossingTemps[crossingIdx]) crossingIdx = m;
            }
            crossingWorstSwitch = MOS_SWITCH_KEYS[crossingIdx];
          }
        }
      }
    }

    const candidate = {
      angleDeg,
      tSafeSec: angleTSafeSec,
      terminalMaxTjC,
      worstSwitch: crossingWorstSwitch ?? angleWorstSwitch,
      phaseSquaredRatio,
      worstTj: angleTransientWorstTj,
    };
    if (!selectedTransient) {
      selectedTransient = candidate;
    } else {
      const currentSafe = selectedTransient.tSafeSec;
      const candidateSafe = candidate.tSafeSec;
      const shouldSelect = candidateSafe !== null
        ? currentSafe === null || candidateSafe < currentSafe - 1e-12 ||
          (Math.abs(candidateSafe - currentSafe) <= 1e-12 && candidate.angleDeg === worstAngleDeg)
        : currentSafe === null && candidate.terminalMaxTjC > selectedTransient.terminalMaxTjC;
      if (shouldSelect) selectedTransient = candidate;
    }
  }

  // Angles are always populated by the 5-degree sweep; keep a defensive guard
  // so a future sweep configuration cannot return empty transient results.
  if (!selectedTransient) throw new Error('堵转瞬态扫描未生成任何有效电角度轨迹。');
  const tSafeSec = selectedTransient.tSafeSec;
  const tSafeAngleDeg = selectedTransient.angleDeg;
  const transientWorstSwitch = selectedTransient.worstSwitch;
  const phaseSquaredRatioAtTransientWorst = selectedTransient.phaseSquaredRatio;
  const transientWorstTj = selectedTransient.worstTj;
  const inheritedBoardTempC = opts.initialThermalState?.tBoardC ?? opts.tInitialBoardC ?? opts.tAmbC;
  // A scalar Board temperature does not identify any junction temperature.
  // Keep Tj_max unknown instead of copying T_board into a misleading Tj field.
  const inheritedMaxTjC = hasValidInitialState
    ? Math.max(...opts.initialThermalState!.armT.map((chain) => chain[0]))
    : null;

  const missingLossInputs: string[] = [];
  const assumptionReasons: string[] = [];
  const hasDptLutForStall = Boolean(opts.mos.dptLut && opts.mos.dptLut.length > 0);
  if (!hasDptLutForStall && opts.mos.eonPlusEoffUj <= 0) missingLossInputs.push('Eon+Eoff/DPT');
  if (!hasDptLutForStall && !opts.mos.eonIncludesQrr && opts.mos.qrrNc <= 0) missingLossInputs.push('Qrr');
  if (!opts.mos.eossAlreadyIncludedInEsw && !opts.mos.eossCurve && (opts.mos.eossUj ?? 0) <= 0 && !qossCoveredByQr(opts.mos)) missingLossInputs.push('Eoss');
  if (opts.mos.rdsDataConfirmed !== true) assumptionReasons.push('Rds(on)@25°C 未按目标器件条件确认');
  if (!hasDptLutForStall) assumptionReasons.push('开关能量采用单点标量缩放，未使用多工况 DPT LUT');
  if (opts.model.modelKind !== 'datasheet_constrained' || opts.model.zthValidation?.passed !== true) {
    assumptionReasons.push('热网络未通过目标器件数据手册约束及拆分一致性验证');
  }
  const resultQualification: FocResultQualification = missingLossInputs.length > 0
    ? 'INCOMPLETE_LOSS_MODEL'
    : assumptionReasons.length > 0
    ? 'ASSUMPTION_BASED'
    : 'DEVICE_PARAMETERIZED';
  const qualificationReasons = [...missingLossInputs.map((x) => `未提供 ${x} 损耗数据`), ...assumptionReasons];
  const thermalSafeAtRequestedCurrent = stallSteadyConverged && !stallThermalRunaway &&
    Number.isFinite(worstSteadyTjC) && worstSteadyTjC <= opts.tjLimitC;
  // Keep the raw thermal-only result for diagnosis, but SAFE is fail-closed unless
  // the loss inputs and device thermal network are parameterized with explicit evidence.
  const steadySafe = thermalSafeAtRequestedCurrent && !stallVoltageLimited && resultQualification === 'DEVICE_PARAMETERIZED';
  const stallWarnings: string[] = [];
  if (resultQualification !== 'DEVICE_PARAMETERIZED') {
    stallWarnings.push(`堵转热安全等级=${resultQualification}；当前 t_safe/I²t 仅为模型条件估算，原因：${qualificationReasons.join('；')}。steadySafe 已强制为 false，不允许显示 SAFE。`);
  }
  if (!opts.mos.rdsDataConfirmed) {
    stallWarnings.push('Rds(on)@25°C 未确认时仍按当前起算值计算导通损耗；该结果必须按假设估算解释。');
  }
  if (!stallSteadyConverged) stallWarnings.push('堵转稳态热方程至少一个电角度未收敛；SAFE 判定已强制为 false，不能把稳态温度外推作为安全结论。');
  if (stallThermalRunaway) stallWarnings.push('堵转角度扫描检测到热失控；应按非安全工况处理。');
  if (stallVoltageLimited) {
    const deadNote =
      deadEdgeDuty > 0
        ? `（已计入死区最小脉冲宽度限制：deadEdgeDuty=${(deadEdgeDuty * 100).toFixed(2)}%，可用线性调制上限 m=${svpwmUsableCeiling.toFixed(4)}）`
        : '';
    stallWarnings.push(`目标 I_pk 在当前 Vbus、R_phase 和 SVPWM 线性电压能力${deadNote}下不可实现；本次热结果仍按用户请求电流强制计算，只能作为条件性上界估算，不得据此判定实际可运行工况 SAFE。`);
  }
  stallWarnings.push('堵转 I²t 的 RMS 字段采用平衡正弦电流等效参考 I_pk/√2；锁定转子固定电角度下各相电流是静态相量投影，不是实际随时间的相 RMS。i2tWorstLegA2s 按 t_safe 最不利电角度的单相静态电流平方积分。');
  stallWarnings.push('t_safe 已对 0°～355°、每 5° 的全部 72 个锁定转子电角度分别进行热瞬态扫描，并取最早 Tj_limit 越限时间；采用 280 点对数时间输出网格，并在首次越限区间进行 18 轮热网络重放二分细化；属于模型估计值，不替代实测堵转保护标定。');
  if (opts.rPhaseOhm === undefined) {
    stallWarnings.push('未提供绕组相电阻 R_phase，当前使用 0.25Ω 默认假设；该值可能显著改变堵转调制深度和损耗，请使用热态/冷态实测相电阻替换。');
  } else {
    stallWarnings.push(`堵转模型将 R_phase=${rPhaseUsedOhm.toFixed(4)}Ω 解释为单相等效绕组电阻；请确认已根据电机星形/三角形接法将线间实测值换算为相值，并按堵转时绕组温度修正电阻。若该数值仍是 UI 默认 0.25Ω，占位值不能视为实测输入。`);
  }
  const i2tRmsA2s = tSafeSec !== null ? iRmsSq * tSafeSec : null;
  const i2tWorstLegA2s = tSafeSec !== null ? phaseSquaredRatioAtTransientWorst * iRmsSq * tSafeSec : null;

  return {
    resultQualification,
    qualificationReasons,
    anglesDeg,
    steadyMaxTjPerAngle,
    worstAngleDeg,
    worstSwitch,
    worstSteadyTjC,
    steadySafe,
    thermalSafeAtRequestedCurrent,
    warnings: stallWarnings,
    i2tReferenceKind: 'balanced_sinusoidal_equivalent',
    tSafeSec,
    tSafeAngleDeg,
    transientWorstSwitch,
    i2tThresholdA2s: i2tRmsA2s,
    i2tRmsA2s,
    i2tWorstLegA2s,
    phaseSquaredRatioAtWorst: phaseSquaredRatioAtTransientWorst,
    effectiveStallModDepthM: effM,
    effectiveStallModulation: effMod,
    effectiveStallPfAngleDeg: effPfAngleDeg,
    rPhaseUsedOhm,
    stallVoltageLimited,
    stallSteadyConverged,
    stallThermalRunaway,
    inheritedHotState,
    inheritedFullThermalState: hasValidInitialState,
    inheritedBoardTempC,
    inheritedMaxTjC,
    transientTime,
    transientWorstTj,
  };
}

/**
 * Compares SVPWM vs DPWM1 vs SPWM and runs an f_sw carrier-frequency trade-off sweep.
 */
export function runFocControlSweep(
  iaCh: WaveformChannel,
  ibCh: WaveformChannel,
  model: FocThermalModel,
  mos: FocMosParams,
  ctrl: FocControlParams,
  opts?: FocSimulationOptions
): FocControlSweepResult {
  const sweepOpts: FocSimulationOptions | undefined = opts ? { ...opts, dutyChs: undefined } : undefined;
  const svpwm = simulateFoc6Mos(iaCh, ibCh, model, mos, { ...ctrl, modulation: 'SVPWM' }, sweepOpts);
  const dpwm1 = simulateFoc6Mos(iaCh, ibCh, model, mos, { ...ctrl, modulation: 'DPWM1' }, sweepOpts);
  const spwm = simulateFoc6Mos(iaCh, ibCh, model, mos, { ...ctrl, modulation: 'SPWM' }, sweepOpts);

  const fswListHz = [8000, 12000, 16000, 20000, 30000, 40000, 50000];
  const tjMaxSvpwmByFsw: number[] = [];
  const tjMaxDpwm1ByFsw: number[] = [];
  const pMeanSvpwmByFsw: number[] = [];
  const pMeanDpwm1ByFsw: number[] = [];

  for (const fsw of fswListHz) {
    const rS = simulateFoc6Mos(iaCh, ibCh, model, mos, { ...ctrl, modulation: 'SVPWM', fswHz: fsw }, sweepOpts);
    const rD = simulateFoc6Mos(iaCh, ibCh, model, mos, { ...ctrl, modulation: 'DPWM1', fswHz: fsw }, sweepOpts);
    tjMaxSvpwmByFsw.push(rS.tjMaxGlobalC);
    tjMaxDpwm1ByFsw.push(rD.tjMaxGlobalC);
    pMeanSvpwmByFsw.push(rS.pInvMeanW);
    pMeanDpwm1ByFsw.push(rD.pInvMeanW);
  }

  return {
    svpwm,
    dpwm1,
    spwm,
    fswListHz,
    tjMaxSvpwmByFsw,
    tjMaxDpwm1ByFsw,
    pMeanSvpwmByFsw,
    pMeanDpwm1ByFsw,
  };
}

