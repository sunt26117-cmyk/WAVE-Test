/**
 * FOC 6-MOS Electrical-Cycle Steady-State Solver & 9-16V Voltage Envelope Analysis
 */
import type { CauerStage } from "../thermalEngine";
import type { DptAxisName } from "../dptAnalyzer";
import {
  DEFAULT_FOC_MODEL,
  FocControlParams,
  FocMosParams,
  FocResultQualification,
  FocSteadyMosResult,
  FocSteadyOperatingPoint,
  FocSteadyStateOptions,
  FocSteadyStateResult,
  FocThermalModel,
  FocVoltageEnvelopeOptions,
  FocVoltageEnvelopeRow,
  FocVoltageEnvelopeStatus,
  MOS_SWITCH_KEYS,
  getModulationLinearCeiling,
} from "./types";
import {
  computeDutyFromVoltageAngle,
  computePhaseMosLosses,
  getFocMosRdsFactorAtTj,
  qossCoveredByQr,
  resolveInitialThermalProbeTjC,
  validateMosEnergyAccounting,
  validateRdsOnTempCurveForMos,
} from "./lossModel";
import {
  buildPerSwitchJcChains,
  resolveSpatialThermalNetwork,
  solveCoupledThermalSteadyState,
} from "./thermalNetwork";

export interface FocSteadyLossAverage {
  pCond25W: number[];
  pSwitchingW: number[];
  pDeadTimeW: number[];
  dutyMin: number;
  dutyMax: number;
  lutActiveDims: Set<DptAxisName>;
  lutCollapsedDims: Set<DptAxisName>;
  lutOutOfRangeCount: number;
}

export function averageFocSteadyLosses(
  point: FocSteadyOperatingPoint,
  modelMode: 'rotating' | 'locked_rotor',
  sampleCount: number,
  electricalAngleDeg: number,
  mos: FocMosParams,
  ctrl: FocControlParams,
  tjBySwitch: number[]
): FocSteadyLossAverage {
  const sums = {
    cond25: new Float64Array(6),
    sw: new Float64Array(6),
    dead: new Float64Array(6),
  };
  const activeDims = new Set<DptAxisName>();
  const collapsedDims = new Set<DptAxisName>();
  let outOfRangeCount = 0;
  let dutyMin = 1;
  let dutyMax = 0;
  const n = modelMode === 'locked_rotor' ? 1 : sampleCount;
  const angle0 = (electricalAngleDeg * Math.PI) / 180;
  const root3 = Math.sqrt(3);
  const vBus = ctrl.vBusConstV;

  for (let k = 0; k < n; k++) {
    // Midpoint integration avoids double-counting the 0/2π boundary.
    const theta = modelMode === 'locked_rotor' ? angle0 : (2 * Math.PI * (k + 0.5)) / n;
    // Inverse amplitude-invariant Park/Clarke convention. At Id=0 and
    // theta=90°, this reproduces the existing DynoLab stall vector:
    // Ia=Iq, Ib=Ic=-Iq/2.
    const id = point.idPeakA ?? 0;
    const iq = point.iqPeakA;
    const iAlpha = id * Math.cos(theta) + iq * Math.sin(theta);
    const iBeta = id * Math.sin(theta) - iq * Math.cos(theta);
    const ia = iAlpha;
    const ib = -0.5 * iAlpha + (root3 / 2) * iBeta;
    const ic = -0.5 * iAlpha - (root3 / 2) * iBeta;

    // The generated three-phase set is balanced by construction; use the
    // stationary-frame current vector directly for the voltage/current angle.
    // A zero-current rotating point still has a commanded voltage vector (e.g. back-EMF
    // cancellation / field weakening). Do not let the generic current-angle fallback
    // silently force 50% duty and suppress Eoss/switching events.
    const thetaI = Math.hypot(iAlpha, iBeta) >= 1e-9
      ? Math.atan2(iBeta, iAlpha)
      : theta - Math.PI / 2;
    const duty = computeDutyFromVoltageAngle(
      thetaI + (ctrl.pfAngleDeg * Math.PI) / 180, ctrl.modulation, ctrl.modDepthM
    );
    if (duty.overmodulated) {
      throw new Error(
        `恒定工况稳态模型目前只接受线性调制区：${ctrl.modulation} 请求 m=${ctrl.modDepthM.toFixed(4)}，上限=${duty.linearCeilingM.toFixed(4)}。请先降低调制度，避免把过调制波形当成线性 SVPWM/DPWM1 计算。`
      );
    }
    dutyMin = Math.min(dutyMin, duty.da, duty.db, duty.dc);
    dutyMax = Math.max(dutyMax, duty.da, duty.db, duty.dc);

    const phaseInputs: Array<[number, number, number, number]> = [
      [ia, duty.da, tjBySwitch[0], tjBySwitch[1]],
      [ib, duty.db, tjBySwitch[2], tjBySwitch[3]],
      [ic, duty.dc, tjBySwitch[4], tjBySwitch[5]],
    ];
    const legs = phaseInputs.map(([current, highDuty, tjHigh, tjLow]) =>
      computePhaseMosLosses(
        current, highDuty, vBus, tjHigh, tjLow,
        ctrl.modulation, ctrl.fswHz, ctrl.tDeadNs, mos
      )
    );
    const p25 = [
      legs[0].pHighCond25W, legs[0].pLowCond25W,
      legs[1].pHighCond25W, legs[1].pLowCond25W,
      legs[2].pHighCond25W, legs[2].pLowCond25W,
    ];
    const pSw = [
      legs[0].pHighSw, legs[0].pLowSw,
      legs[1].pHighSw, legs[1].pLowSw,
      legs[2].pHighSw, legs[2].pLowSw,
    ];
    const pDead = [
      legs[0].pHighDead, legs[0].pLowDead,
      legs[1].pHighDead, legs[1].pLowDead,
      legs[2].pHighDead, legs[2].pLowDead,
    ];
    for (let m = 0; m < 6; m++) {
      sums.cond25[m] += p25[m];
      sums.sw[m] += pSw[m];
      sums.dead[m] += pDead[m];
    }
    for (const leg of legs) {
      leg.lutActiveDims?.forEach((dim) => activeDims.add(dim));
      leg.lutCollapsedDims?.forEach((dim) => collapsedDims.add(dim));
      if (leg.lutExtrapolated || leg.lutStatus === 'OUT_OF_RANGE') outOfRangeCount++;
    }
  }

  const divisor = n;
  return {
    pCond25W: Array.from(sums.cond25, (v) => v / divisor),
    pSwitchingW: Array.from(sums.sw, (v) => v / divisor),
    pDeadTimeW: Array.from(sums.dead, (v) => v / divisor),
    dutyMin,
    dutyMax,
    lutActiveDims: activeDims,
    lutCollapsedDims: collapsedDims,
    lutOutOfRangeCount: outOfRangeCount,
  };
}

function compareSteadyLossIntegration(
  coarse: FocSteadyLossAverage,
  fine: FocSteadyLossAverage
): number {
  const pairs: Array<[number[], number[]]> = [
    [coarse.pCond25W, fine.pCond25W],
    [coarse.pSwitchingW, fine.pSwitchingW],
    [coarse.pDeadTimeW, fine.pDeadTimeW],
  ];
  let maxErrorPct = 0;
  for (const [a, b] of pairs) {
    for (let i = 0; i < b.length; i++) {
      const errorPct = Math.abs(b[i] - a[i]) / Math.max(Math.abs(b[i]), 1e-9) * 100;
      if (!Number.isFinite(errorPct)) return Infinity;
      maxErrorPct = Math.max(maxErrorPct, errorPct);
    }
  }
  return maxErrorPct;
}

/**
 * Direct constant-condition calculation. It averages the PWM-period loss model
 * over one electrical cycle (or one fixed rotor angle at standstill), then solves
 * the six-MOS coupled thermal steady state. It does not synthesize a time trace or
 * run a thermal transient; the existing simulateFoc6Mos() remains the waveform path.
 */
export function simulateFoc6MosSteadyState(options: FocSteadyStateOptions): FocSteadyStateResult {
  const { model, mos, ctrl, operatingPoint } = options;
  if (model.splitFeasible === false) {
    throw new Error(model.splitMeta?.warning || 'ZthJC / Zth_board 热路径拆分不可行，拒绝稳态结温计算。');
  }
  const finite = (v: number) => Number.isFinite(v);
  if (!['SVPWM', 'DPWM1', 'SPWM'].includes(ctrl.modulation)) throw new Error('调制模式无效。');
  if (!finite(ctrl.vBusConstV) || ctrl.vBusConstV <= 0) throw new Error('恒定母线电压必须为有限正数。');
  if (!finite(ctrl.fswHz) || ctrl.fswHz <= 0 || ctrl.fswHz > 5e6) throw new Error('恒定 PWM 频率必须位于 (0, 5 MHz]。');
  if (!finite(ctrl.tDeadNs) || ctrl.tDeadNs < 0 || ctrl.tDeadNs > 1e6) throw new Error('死区时间必须位于 0～1,000,000 ns。');
  if (!finite(ctrl.modDepthM) || ctrl.modDepthM < 0 || ctrl.modDepthM > 2) throw new Error('调制度必须位于 0～2。');
  if (!finite(ctrl.pfAngleDeg) || ctrl.pfAngleDeg < -180 || ctrl.pfAngleDeg > 180) throw new Error('功率因数角必须位于 -180°～180°。');
  if (!finite(ctrl.tAmbC) || ctrl.tAmbC <= -273.15 || ctrl.tAmbC > 1000) throw new Error('环境温度必须高于绝对零度且不超过 1000°C。');
  if (!finite(mos.rdsOn25Mohm) || mos.rdsOn25Mohm <= 0) throw new Error('Rds(on)@25°C 必须为有限正数（mΩ）。');
  if (!mos.rdsOnTempCurve && (!finite(mos.tempCoeffAlphaPerC) || mos.tempCoeffAlphaPerC < 0 || mos.tempCoeffAlphaPerC > 0.05)) throw new Error('Rds 温度系数必须为 0～0.05 /°C；如使用器件曲线，该 α 输入不参与计算。');
  if (mos.rdsOnTempCurve) validateRdsOnTempCurveForMos(mos);
  validateMosEnergyAccounting(mos);
  if (!finite(mos.vsdV) || mos.vsdV < 0 || mos.vsdV > 10) throw new Error('体二极管压降必须为 0～10 V。');
  if (!finite(mos.eonPlusEoffUj) || mos.eonPlusEoffUj < 0 || !finite(mos.qrrNc) || mos.qrrNc < 0) throw new Error('Eon+Eoff 和 Qrr 必须为非负有限数值。');
  if (!finite(mos.vRefV) || mos.vRefV <= 0 || !finite(mos.iRefA) || mos.iRefA <= 0) throw new Error('Eon/Eoff 参考电压和参考电流必须为有限正数。');
  if (mos.qrrIrefA !== undefined && (!finite(mos.qrrIrefA) || mos.qrrIrefA <= 0)) throw new Error('Qr/Qrr 独立参考电流必须为有限正数。');
  if (mos.eossUj !== undefined && (!finite(mos.eossUj) || mos.eossUj < 0)) throw new Error('Eoss 必须为非负有限数值。');
  if (!finite(operatingPoint.iqPeakA) || !finite(operatingPoint.idPeakA ?? 0)) throw new Error('Id/Iq 必须为有限峰值电流。');
  if (!finite(operatingPoint.electricalFrequencyHz) || operatingPoint.electricalFrequencyHz < 0) throw new Error('电频率必须为有限非负数。');

  const inferredMode: 'rotating' | 'locked_rotor' = operatingPoint.mode ??
    (operatingPoint.electricalFrequencyHz > 1e-9 ? 'rotating' : 'locked_rotor');
  if (inferredMode === 'rotating' && operatingPoint.electricalFrequencyHz <= 0) {
    throw new Error('旋转工况必须提供大于 0 的电频率；零速工况请选择 locked_rotor。');
  }
  if (inferredMode === 'locked_rotor' && operatingPoint.electricalFrequencyHz > 1e-9) {
    throw new Error('locked_rotor 固定电角度工况的电频率必须为 0；非零电频率请使用 rotating 模式。');
  }
  if (inferredMode === 'rotating' && operatingPoint.electricalFrequencyHz >= ctrl.fswHz) {
    throw new Error('电频率不得达到或超过 PWM 频率；当前工况不满足平均 PWM 损耗模型的基本采样关系。');
  }
  const pwmCyclesPerElectricalCycle = inferredMode === 'rotating'
    ? ctrl.fswHz / operatingPoint.electricalFrequencyHz
    : null;
  const electricalAngleDeg = operatingPoint.electricalAngleDeg ?? 90;
  if (!finite(electricalAngleDeg) || electricalAngleDeg < 0 || electricalAngleDeg > 360) {
    throw new Error('堵转电角度必须位于 0°～360°。');
  }
  const maxM = getModulationLinearCeiling(ctrl.modulation);
  if (ctrl.modDepthM > maxM + 1e-6) {
    throw new Error(`恒定工况稳态计算暂不支持过调制：${ctrl.modulation} 的线性上限为 ${maxM.toFixed(4)}，当前 m=${ctrl.modDepthM.toFixed(4)}。`);
  }
  if (mos.dptLut && mos.dptLut.length > 0 &&
      (!(mos.rgOnOhm !== undefined && finite(mos.rgOnOhm) && mos.rgOnOhm >= 0) ||
       !(mos.rgOffOhm !== undefined && finite(mos.rgOffOhm) && mos.rgOffOhm >= 0))) {
    throw new Error('启用 DPT LUT 时必须明确输入 Rg_on 和 Rg_off。');
  }

  const jcStages = model.zthJC.length > 0 ? model.zthJC : DEFAULT_FOC_MODEL.zthJC;
  const boardStages = model.zthBoard.length > 0 ? model.zthBoard : DEFAULT_FOC_MODEL.zthBoard;
  const validateStages = (stages: CauerStage[], label: string) => {
    if (!stages.length) throw new Error(`${label} 热网络不能为空。`);
    stages.forEach((stage, index) => {
      if (!finite(stage.r) || stage.r <= 0 || !finite(stage.c) || stage.c <= 0) {
        throw new Error(`${label} 第 ${index + 1} 阶 R/C 必须为有限正数。`);
      }
    });
  };
  validateStages(jcStages, 'ZthJC');
  validateStages(boardStages, 'ZthBoard');
  // The steady-state path must apply the same strict six-position thermal-input
  // validation as the transient path. Silent fallback here can mask bad PCB data.
  if (model.perSwitchRjcScale !== undefined && (
    !Array.isArray(model.perSwitchRjcScale) || model.perSwitchRjcScale.length !== 6 ||
    model.perSwitchRjcScale.some((v) => !Number.isFinite(v) || v < 0.01 || v > 100)
  )) {
    throw new Error('恒定工况 perSwitchRjcScale 必须严格包含 AH/AL/BH/BL/CH/CL 六个有限正数，范围 0.01～100。');
  }
  if (model.perSwitchPadOffsetCPerW !== undefined && (
    !Array.isArray(model.perSwitchPadOffsetCPerW) || model.perSwitchPadOffsetCPerW.length !== 6 ||
    model.perSwitchPadOffsetCPerW.some((v) => !Number.isFinite(v) || v < 0 || v > 1e6)
  )) {
    throw new Error('恒定工况 perSwitchPadOffsetCPerW 必须严格包含 AH/AL/BH/BL/CH/CL 六个有限非负热阻值。');
  }

  const requestedSamples = options.integrationSamples ?? 720;
  if (!Number.isInteger(requestedSamples) || requestedSamples < 72 || requestedSamples > 8192) {
    throw new Error('电周期积分点数必须为 72～8192 的整数。');
  }
  const maxIntegrationSamples = 16384;
  const operatingPointForSweep = { ...operatingPoint, electricalAngleDeg };
  const probeTjC = resolveInitialThermalProbeTjC(mos, ctrl.tAmbC);
  const seedTjC = resolveInitialThermalProbeTjC(mos, ctrl.tAmbC + 10);
  const zeroTj = new Array<number>(6).fill(probeTjC);
  let coarseSamples = inferredMode === 'rotating' ? requestedSamples : 1;
  let finalSamples = coarseSamples;
  let integrationErrorPct: number | null = null;
  let integrationAccuracyMet = true;
  let integrationBaseErrorPct: number | null = null;
  let integrationThermalErrorPct: number | null = null;
  let baseLoss!: FocSteadyLossAverage;
  let finalLoss!: FocSteadyLossAverage;
  let steady!: ReturnType<typeof solveCoupledThermalSteadyState>;
  const alpha = mos.tempCoeffAlphaPerC;
  const armChains = buildPerSwitchJcChains({ ...model, zthJC: jcStages, zthBoard: boardStages });
  const rJcTotalByArm = armChains.map((chain) => chain.reduce((sum, stage) => sum + stage.r, 0));
  const rBrdTotal = boardStages.reduce((sum, stage) => sum + stage.r, 0);
  const tolerancePct = 0.2;

  // Check convergence twice: first at the 25°C reference loss, then again at the
  // actual coupled steady-state junction temperatures. A DPT LUT can vary with Tj,
  // so convergence at 25°C alone is not sufficient to qualify the final loss result.
  // If either check fails, rerun the complete electro-thermal solve at twice the
  // angular resolution. The hard cap bounds UI cost; failure at the cap is reported
  // as ASSUMPTION_BASED rather than silently treated as a parameterized result.
  for (;;) {
    const solveSamples = inferredMode === 'rotating'
      ? Math.min(maxIntegrationSamples, coarseSamples * 2)
      : 1;
    const coarseBaseLoss = averageFocSteadyLosses(
      operatingPointForSweep, inferredMode, coarseSamples, electricalAngleDeg, mos, ctrl, zeroTj
    );
    const fineBaseLoss = solveSamples === coarseSamples
      ? coarseBaseLoss
      : averageFocSteadyLosses(
          operatingPointForSweep, inferredMode, solveSamples, electricalAngleDeg, mos, ctrl, zeroTj
        );
    integrationBaseErrorPct = inferredMode === 'rotating'
      ? compareSteadyLossIntegration(coarseBaseLoss, fineBaseLoss)
      : null;

    const activeDims = new Set<DptAxisName>(fineBaseLoss.lutActiveDims);
    const evalFixedPowerAtTj = activeDims.has('Tj')
      ? (tjCandidate: number[]): number[] => {
          const losses = averageFocSteadyLosses(
            operatingPointForSweep, inferredMode, solveSamples, electricalAngleDeg, mos, ctrl, tjCandidate
          );
          return losses.pSwitchingW.map((p, i) => p + losses.pDeadTimeW[i]);
        }
      : undefined;

    steady = solveCoupledThermalSteadyState({
      pCond25W: fineBaseLoss.pCond25W,
      pFixedW: fineBaseLoss.pSwitchingW.map((p, i) => p + fineBaseLoss.pDeadTimeW[i]),
      alphaPerC: alpha,
      evalCondFactorAtTj: mos.rdsOnTempCurve
        ? (tjVec) => tjVec.map((tj) => getFocMosRdsFactorAtTj(mos, tj))
        : undefined,
      rJcTotalByArm,
      rBrdTotal,
      tAmbC: ctrl.tAmbC,
      tInitSeedC: new Array<number>(6).fill(seedTjC),
      spatial: resolveSpatialThermalNetwork({ ...model, zthJC: jcStages, zthBoard: boardStages }),
      evalFixedPowerAtTj,
    });

    // A failed thermal solve has no final operating temperature. Do not query a
    // bounded Rds(Tj)/DPT curve with an intermediate or runaway temperature; retain
    // only the 25°C reference loss for diagnostics and let result qualification fail.
    const thermalPointUsable = steady.converged && !steady.thermalRunaway;
    finalLoss = thermalPointUsable
      ? averageFocSteadyLosses(
          operatingPointForSweep, inferredMode, solveSamples, electricalAngleDeg, mos, ctrl, steady.tjSteadyC
        )
      : fineBaseLoss;

    if (inferredMode === 'rotating' && thermalPointUsable) {
      let thermalCoarseLoss: FocSteadyLossAverage;
      let thermalFineLoss: FocSteadyLossAverage;
      if (solveSamples < maxIntegrationSamples) {
        thermalCoarseLoss = finalLoss;
        thermalFineLoss = averageFocSteadyLosses(
          operatingPointForSweep, inferredMode, Math.min(maxIntegrationSamples, solveSamples * 2),
          electricalAngleDeg, mos, ctrl, steady.tjSteadyC
        );
      } else {
        // At the cap compare the final 8192/16384 pair at the solved Tj.
        thermalCoarseLoss = averageFocSteadyLosses(
          operatingPointForSweep, inferredMode, Math.floor(solveSamples / 2),
          electricalAngleDeg, mos, ctrl, steady.tjSteadyC
        );
        thermalFineLoss = finalLoss;
      }
      integrationThermalErrorPct = compareSteadyLossIntegration(thermalCoarseLoss, thermalFineLoss);
    } else {
      integrationThermalErrorPct = null;
    }

    const errors = [integrationBaseErrorPct, integrationThermalErrorPct]
      .filter((value): value is number => value !== null);
    integrationErrorPct = errors.length > 0 ? Math.max(...errors) : null;
    finalSamples = solveSamples;
    baseLoss = fineBaseLoss;

    const needsMoreSamples = integrationErrorPct !== null && integrationErrorPct > tolerancePct;
    if (needsMoreSamples && solveSamples < maxIntegrationSamples) {
      coarseSamples = solveSamples;
      continue;
    }
    integrationAccuracyMet = !needsMoreSamples;
    break;
  }
  const thermalPointUsable = steady.converged && !steady.thermalRunaway;
  const keys = MOS_SWITCH_KEYS;
  const boardByKey = steady.tBoardSteadyByKey;
  const perSwitch: FocSteadyMosResult[] = keys.map((key, i) => {
    // Do not leak a thermal solver's last iterate as if it were an operating point.
    // NaN is intentional: consumers must check steadyConverged/thermalRunaway first.
    if (!thermalPointUsable) {
      return {
        key,
        pCondW: Number.NaN,
        pSwitchingW: Number.NaN,
        pDeadTimeW: Number.NaN,
        pTotalW: Number.NaN,
        pCondAt25CW: baseLoss.pCond25W[i],
        tjSteadyC: Number.NaN,
        boardSteadyC: Number.NaN,
      };
    }
    const factor = getFocMosRdsFactorAtTj(mos, steady.tjSteadyC[i]);
    const pCond = baseLoss.pCond25W[i] * factor;
    const pSw = finalLoss.pSwitchingW[i];
    const pDead = finalLoss.pDeadTimeW[i];
    return {
      key,
      pCondW: pCond,
      pSwitchingW: pSw,
      pDeadTimeW: pDead,
      pTotalW: pCond + pSw + pDead,
      pCondAt25CW: baseLoss.pCond25W[i],
      tjSteadyC: steady.tjSteadyC[i],
      boardSteadyC: boardByKey[i] ?? steady.tBoardSteadyC,
    };
  });
  const sum = (selector: (r: FocSteadyMosResult) => number) => perSwitch.reduce((a, r) => a + selector(r), 0);
  let hottestIndex = 0;
  for (let i = 1; i < perSwitch.length; i++) if (perSwitch[i].tjSteadyC > perSwitch[hottestIndex].tjSteadyC) hottestIndex = i;

  const missingLossInputs: string[] = [];
  const assumptionReasons: string[] = [];
  if (!mos.dptLut?.length && mos.eonPlusEoffUj <= 0) missingLossInputs.push('Eon+Eoff/DPT');
  if (!mos.dptLut?.length && !mos.eonIncludesQrr && mos.qrrNc <= 0) missingLossInputs.push('Qrr');
  if (!mos.eossAlreadyIncludedInEsw && !mos.eossCurve && (mos.eossUj ?? 0) <= 0 && !qossCoveredByQr(mos)) missingLossInputs.push('Eoss');
  if (mos.rdsDataConfirmed !== true) assumptionReasons.push('Rds(on)@25°C 未按目标器件 Vgs/测试条件确认');
  if (mos.rdsOnTempCurve && (mos.rdsOnTempCurve.provenance === 'assumed' || !mos.rdsOnTempCurve.partNumber?.trim())) {
    assumptionReasons.push('Rds(on)-Tj 曲线来源为假设/未绑定具体器件型号');
  }
  if (!mos.dptLut?.length) assumptionReasons.push('开关能量使用单点标量 V/I 缩放，不是多工况 DPT LUT');
  if (!mos.dptLut?.length && !mos.eonIncludesQrr && mos.qrrNc > 0) {
    assumptionReasons.push('Qr/Qrr 只使用单点电荷数据，按 |I| 线性缩放并以 Q×Vbus 一阶估算；未按工作 VDS、Tj、di/dt 和实际换流路径建立非线性模型');
  }
  const scalarLossLimitations: string[] = [];
  if (qossCoveredByQr(mos)) {
    scalarLossLimitations.push('数据口径：当前 Qr 输入已声明包含电容性恢复（Qr=Qs+Qoss）；独立 Eoss 不再叠加。');
  }
  if (!mos.dptLut?.length) {
    if (mos.eonPlusEoffUj > 0) scalarLossLimitations.push('标量 Eon+Eoff 采用 Vbus/Vref 与 |I|/Iref 的线性比例缩放；该近似不包含器件开关能量对结温、Rg、换流电流斜率及非线性 Coss 的完整依赖，不能替代多工况 DPT LUT。');
    if (!mos.eonIncludesQrr && mos.qrrNc > 0 && mos.qrrIncludesQoss) scalarLossLimitations.push(`当前输入为 Qr@${(mos.qrrIrefA ?? mos.iRefA).toFixed(1)}A（已声明包含 Qoss/电容性恢复）；按 Qr@${(mos.qrrIrefA ?? mos.iRefA).toFixed(1)}A × |I|/${(mos.qrrIrefA ?? mos.iRefA).toFixed(1)}A 与 Qr·Vbus 估算总恢复能量，并禁止额外叠加 Eoss。该近似未分别求解 Qs、Qoss 及其实际能量分配，也未建模 Tj、di/dt、Vgs 和换流寄生参数的非线性。`);
    else if (!mos.eonIncludesQrr && mos.qrrNc > 0) scalarLossLimitations.push('标量 Qrr 采用 Qrr@Iref × |I|/Iref，并按 Qrr·Vbus 估算恢复能量；未建模 Qrr 对 Tj、di/dt、Vgs 和换流回路寄生参数的非线性依赖。');
    if (!mos.eossAlreadyIncludedInEsw && !mos.eossCurve && (mos.eossUj ?? 0) > 0) scalarLossLimitations.push('标量 Eoss 采用 Eoss@Vref × (Vbus/Vref)^2；非线性 Coss 区域应优先导入 Eoss(V)/Qoss(V) 曲线。');
  }
  if (model.modelKind !== 'datasheet_constrained' || model.zthValidation?.passed !== true) {
    assumptionReasons.push('热网络未通过目标器件数据手册约束及 JC/Board 拆分验证');
  }
  if (model.modelKind === 'fallback_default' || model.modelKind === 'demo_builtin' || !model.modelKind) {
    assumptionReasons.push('使用默认/演示热网络，不代表目标 MOS 与 PCB 的实测热路径');
  }
  if (pwmCyclesPerElectricalCycle !== null && pwmCyclesPerElectricalCycle < 20) {
    assumptionReasons.push(`每个电周期仅 ${pwmCyclesPerElectricalCycle.toFixed(1)} 个 PWM 周期，平均 PWM 损耗假设偏弱`);
  }
  if (!integrationAccuracyMet) {
    assumptionReasons.push(`电周期积分在 ${finalSamples} 点上限仍未达到 0.2% 收敛门槛（25°C 基准误差=${integrationBaseErrorPct?.toFixed(4) ?? 'N/A'}%，稳态 Tj 误差=${integrationThermalErrorPct?.toFixed(4) ?? 'N/A'}%）；当前功耗/结温不具备参数化结果资格`);
  }
  const inverterLossBudgetW = Number.isFinite(operatingPoint.impliedInverterLossW)
    ? operatingPoint.impliedInverterLossW as number
    : null;
  const inverterLossBudgetMarginW = !thermalPointUsable || inverterLossBudgetW === null
    ? null
    : inverterLossBudgetW - sum((r) => r.pTotalW);
  const powerBalanceStatus: FocSteadyStateResult['powerBalanceStatus'] = !thermalPointUsable || inverterLossBudgetW === null
    ? 'NOT_AVAILABLE'
    : inverterLossBudgetW < -0.1 || (inverterLossBudgetMarginW as number) < -Math.max(0.1, 0.05 * Math.abs(inverterLossBudgetW))
      ? 'EXCEEDS_BUDGET'
      : 'WITHIN_BUDGET';
  if (powerBalanceStatus === 'EXCEEDS_BUDGET') {
    assumptionReasons.push('六管计算损耗超过 DynoLab 输入功率/电机电功率差所隐含的逆变器损耗预算；需核对效率定义、器件损耗参数及功率边界');
  }
  if (steady.thermalRunaway) {
    assumptionReasons.push('热稳态求解检测到热失控，不存在可用于工程判断的有限稳态结温。');
  } else if (!steady.converged) {
    assumptionReasons.push('热稳态求解未收敛，当前结温只能作为迭代中间值，不得用于安全或设计签核。');
  }
  const resultQualification: FocResultQualification = missingLossInputs.length > 0
    ? 'INCOMPLETE_LOSS_MODEL'
    : assumptionReasons.length > 0 ? 'ASSUMPTION_BASED' : 'DEVICE_PARAMETERIZED';
  const qualificationReasons = [...missingLossInputs.map((x) => `缺少 ${x}`), ...assumptionReasons];
  const warnings: string[] = [
    inferredMode === 'rotating'
      ? `恒定旋转工况：Id/Iq 保持恒定，按完整电周期 ${finalSamples} 点做平均损耗积分；fsw/fe=${(pwmCyclesPerElectricalCycle ?? 0).toFixed(1)}；不模拟 PWM 载波边沿与电流纹波。`
      : `恒定堵转工况：按电角度 ${electricalAngleDeg.toFixed(1)}° 固定 Id/Iq 计算；转子角度变化时结果可能不同。`,
    '恒定工况稳态结果不包含栅极驱动器静态/动态功耗、控制器功耗、母线电容 ESR、母排/连接器及 PCB 铜箔电阻损耗，除非这些损耗已另行纳入输入热源。',
    ...scalarLossLimitations,
  ];
  if (integrationErrorPct !== null) {
    warnings.push(integrationAccuracyMet
      ? `电周期积分已自动加密至 ${finalSamples} 点；25°C 基准积分误差=${integrationBaseErrorPct?.toFixed(4) ?? 'N/A'}%，稳态 Tj 积分误差=${integrationThermalErrorPct?.toFixed(4) ?? 'N/A'}%，最大差异 ${integrationErrorPct.toFixed(4)}%（门槛 0.2%）。`
      : `电周期积分已加密至上限 ${finalSamples} 点，但 25°C 基准/稳态 Tj 积分误差仍未全部达到 0.2%（基准=${integrationBaseErrorPct?.toFixed(4) ?? 'N/A'}%，稳态 Tj=${integrationThermalErrorPct?.toFixed(4) ?? 'N/A'}%）；结果已降级为假设估算。`);
  }
  if (missingLossInputs.length) {
    warnings.push(`损耗模型不完整：${missingLossInputs.join('、')} 缺失；对应损耗未计入，P_inv/Tj 是已知损耗下的偏低估算。`);
  }
  if (mos.rdsOnTempCurve) {
    const curve = mos.rdsOnTempCurve;
    warnings.push(`导通电阻温度反馈已使用器件 Rds(on)-Tj 归一化曲线（Vgs=${curve.referenceGateVoltageV.toFixed(2)}V，范围 ${curve.points[0].tjC}～${curve.points[curve.points.length - 1].tjC}°C，来源=${curve.provenance}）；曲线优先于线性 α。${curve.sourceNote ? `数据来源说明：${curve.sourceNote}` : ''}`);
  } else {
    warnings.push('Rds(on)-Tj 当前使用线性 α 近似；高结温外推优先替换为目标 MOS 在实际 Vgs 条件下的归一化曲线。');
  }
  if (mos.eonIncludesQrr) {
    warnings.push('反向恢复计量：Esw/DPT Eon+Eoff 已声明包含 Qrr，模型不再额外叠加 Qr·Vbus。');
  } else if (qossCoveredByQr(mos)) {
    warnings.push(`反向恢复/电容性恢复计量：当前使用 Qr=${mos.qrrNc.toFixed(2)} nC @ ${(mos.qrrIrefA ?? mos.iRefA).toFixed(1)}A，已声明包含电容性恢复（Qr=Qs+Qoss）；按 Qr·Vbus 一阶估算，不再额外叠加 Eoss。`);
    if (mos.qrrReferenceVdsV !== undefined || mos.qrrReferenceDiDtAperUs !== undefined || mos.qrrReferenceTjC !== undefined || mos.qrrReferenceVgsV !== undefined) {
      const refs = [
        mos.qrrReferenceVdsV !== undefined ? `VDS=${mos.qrrReferenceVdsV.toFixed(1)}V` : '',
        mos.qrrReferenceDiDtAperUs !== undefined ? `di/dt=${mos.qrrReferenceDiDtAperUs.toFixed(0)}A/µs` : '',
        mos.qrrReferenceVgsV !== undefined ? `VGS=${mos.qrrReferenceVgsV.toFixed(1)}V` : '',
        mos.qrrReferenceTjC !== undefined ? `Tj=${mos.qrrReferenceTjC.toFixed(0)}°C` : '',
      ].filter(Boolean).join('，');
      const vdsDeltaPct = mos.qrrReferenceVdsV !== undefined && mos.qrrReferenceVdsV > 0
        ? Math.abs(ctrl.vBusConstV - mos.qrrReferenceVdsV) / mos.qrrReferenceVdsV * 100
        : null;
      warnings.push(`Qr 数据手册参考测试条件：${refs}；当前 Vbus=${ctrl.vBusConstV.toFixed(2)}V${vdsDeltaPct === null ? '' : `（相对测试 VDS 差异 ${vdsDeltaPct.toFixed(1)}%）`}。该单点 Qr 没有 VDS/温度/di/dt 特性曲线，未对测试条件差异进行修正；此结果只能作为一阶估算。`);
    }
  } else {
    warnings.push(`反向恢复计量：Esw 未声明包含 Qrr${mos.qrrNc > 0 ? `，额外计入 Qrr·Vbus（Qrr=${mos.qrrNc.toFixed(2)} nC @ ${(mos.qrrIrefA ?? mos.iRefA).toFixed(1)} A）` : '，且 Qrr 输入为 0；未计入额外反向恢复能量'}。`);
  }
  if (mos.eossAlreadyIncludedInEsw) {
    warnings.push('输出电容计量：已启用 Eoss 防重复计量，独立 Eoss 曲线/标量不再叠加。');
  } else if (qossCoveredByQr(mos)) {
    warnings.push('输出电容计量：当前 Qr 已包含 Qoss/电容性恢复，独立 Eoss 曲线/标量被屏蔽，避免重复计量。');
  } else {
    warnings.push(`输出电容计量：独立计算 Eoss${mos.eossCurve ? '（非线性曲线）' : (mos.eossUj ?? 0) > 0 ? `（标量 ${(mos.eossUj ?? 0).toFixed(3)} µJ @ Vref）` : '输入为 0，未计入'}；请确认 Esw/Eon 数据是否已包含同一能量边界。`);
  }
  if (assumptionReasons.length) warnings.push(`结果属于假设估算：${assumptionReasons.join('；')}。`);
  if (powerBalanceStatus === 'EXCEEDS_BUDGET') {
    warnings.push(`功率平衡检查失败：六管损耗 ${sum((r) => r.pTotalW).toFixed(3)} W，FOC 效率模型隐含逆变器损耗预算 ${inverterLossBudgetW!.toFixed(3)} W，超出 ${(-inverterLossBudgetMarginW!).toFixed(3)} W。`);
  }
  if (baseLoss.lutOutOfRangeCount > 0 || finalLoss.lutOutOfRangeCount > 0) {
    throw new Error('恒定工况积分中存在 DPT LUT 越界查询，拒绝输出稳态结温。');
  }
  if (!steady.converged && !steady.thermalRunaway) {
    warnings.push('电热耦合稳态迭代未收敛；当前 Tj 不得用于安全或设计签核。');
  }
  if (steady.thermalRunaway) warnings.push('检测到热反馈导致无有限稳态平衡点（热失控）。');

  return {
    resultQualification,
    qualificationReasons,
    mode: inferredMode,
    iqPeakA: operatingPoint.iqPeakA,
    idPeakA: operatingPoint.idPeakA ?? 0,
    electricalFrequencyHz: operatingPoint.electricalFrequencyHz,
    pwmCyclesPerElectricalCycle,
    vBusConstV: ctrl.vBusConstV,
    modulation: ctrl.modulation,
    modDepthM: ctrl.modDepthM,
    pfAngleDeg: ctrl.pfAngleDeg,
    fswHz: ctrl.fswHz,
    tDeadNs: ctrl.tDeadNs,
    tAmbC: ctrl.tAmbC,
    mechanicalSpeedRpm: Number.isFinite(operatingPoint.mechanicalSpeedRpm) ? operatingPoint.mechanicalSpeedRpm as number : null,
    torqueNm: Number.isFinite(operatingPoint.torqueNm) ? operatingPoint.torqueNm as number : null,
    mechanicalPowerW: Number.isFinite(operatingPoint.mechanicalPowerW) ? operatingPoint.mechanicalPowerW as number : null,
    busInputPowerW: Number.isFinite(operatingPoint.busInputPowerW) ? operatingPoint.busInputPowerW as number : null,
    dcLinkPowerW: Number.isFinite(operatingPoint.dcLinkPowerW) ? operatingPoint.dcLinkPowerW as number : null,
    motorElectricalPowerW: Number.isFinite(operatingPoint.motorElectricalPowerW) ? operatingPoint.motorElectricalPowerW as number : null,
    impliedInverterLossW: inverterLossBudgetW,
    inverterLossBudgetMarginW,
    powerBalanceStatus,
    phaseCurrentPeakA: Math.hypot(operatingPoint.iqPeakA, operatingPoint.idPeakA ?? 0),
    phaseCurrentRmsA: inferredMode === 'rotating'
      ? Math.hypot(operatingPoint.iqPeakA, operatingPoint.idPeakA ?? 0) / Math.sqrt(2)
      : null,
    phaseCurrentA: inferredMode === 'locked_rotor'
      ? (() => {
          const theta = (electricalAngleDeg * Math.PI) / 180;
          const id = operatingPoint.idPeakA ?? 0;
          const iq = operatingPoint.iqPeakA;
          const alpha = id * Math.cos(theta) + iq * Math.sin(theta);
          const beta = id * Math.sin(theta) - iq * Math.cos(theta);
          return { a: alpha, b: -0.5 * alpha + (Math.sqrt(3) / 2) * beta, c: -0.5 * alpha - (Math.sqrt(3) / 2) * beta };
        })()
      : null,
    electricalAngleDeg: inferredMode === 'locked_rotor' ? electricalAngleDeg : null,
    integrationSamples: finalSamples,
    integrationErrorPct,
    integrationAccuracyMet,
    perSwitch,
    pCondTotalW: sum((r) => r.pCondW),
    pSwitchingTotalW: sum((r) => r.pSwitchingW),
    pDeadTimeTotalW: sum((r) => r.pDeadTimeW),
    pInverterTotalW: sum((r) => r.pTotalW),
    tBoardSteadyC: thermalPointUsable ? steady.tBoardSteadyC : Number.NaN,
    tjMaxSteadyC: thermalPointUsable ? perSwitch[hottestIndex].tjSteadyC : Number.NaN,
    hottestKey: perSwitch[hottestIndex].key,
    steadyConverged: steady.converged,
    thermalRunaway: steady.thermalRunaway,
    dutyMin: baseLoss.dutyMin,
    dutyMax: baseLoss.dutyMax,
    warnings,
  };
}

/**
 * Evaluate the 12-V vehicle bus envelope while preserving the requested motor
 * fundamental voltage. Id/Iq, electrical frequency, Fsw, dead time, PF and thermal
 * model remain fixed. Required modulation scales as Vref/Vbus; if it exceeds the
 * linear modulation ceiling, the case is reported as voltage-limited and no Tj is
 * fabricated. This is an operating-point sensitivity check, not a motor/FOC
 * re-solve: a full motor model is still required to recalculate current/torque.
 */
export function simulateFoc6MosVoltageEnvelope(options: FocVoltageEnvelopeOptions): FocVoltageEnvelopeRow[] {
  const referenceVoltageV = options.referenceVoltageV ?? options.ctrl.vBusConstV;
  if (!Number.isFinite(referenceVoltageV) || referenceVoltageV <= 0) {
    throw new Error('电压边界评估的参考母线电压必须为有限正数。');
  }
  const voltagePoints = options.voltagePoints ?? [9, 13.5, 16];
  if (!Array.isArray(voltagePoints) || voltagePoints.length < 2 ||
      voltagePoints.some((v) => !Number.isFinite(v) || v <= 0) ||
      new Set(voltagePoints).size !== voltagePoints.length) {
    throw new Error('电压边界评估至少需要两个互不重复的有限正母线电压点。');
  }
  if (!Number.isFinite(options.ctrl.modDepthM) || options.ctrl.modDepthM < 0) {
    throw new Error('参考调制度必须为有限非负数。');
  }
  const ceiling = getModulationLinearCeiling(options.ctrl.modulation);
  if (options.ctrl.modDepthM > ceiling + 1e-6) {
    throw new Error(`参考工况本身已超过 ${options.ctrl.modulation} 线性调制上限（m=${options.ctrl.modDepthM.toFixed(4)}，上限=${ceiling.toFixed(4)}）；不能以不可实现的参考点开展电压边界评估。`);
  }
  return voltagePoints.map((vBusV): FocVoltageEnvelopeRow => {
    const requiredModDepthM = options.ctrl.modDepthM * referenceVoltageV / vBusV;
    if (requiredModDepthM > ceiling + 1e-6) {
      return {
        vBusV,
        requiredModDepthM,
        modulationCeiling: ceiling,
        status: 'VOLTAGE_LIMITED',
        result: null,
        note: `维持参考基波电压需要 m=${requiredModDepthM.toFixed(4)}，超过 ${options.ctrl.modulation} 线性上限 ${ceiling.toFixed(4)}；不能假定原 Id/Iq 工作点仍可维持。`,
      };
    }
    try {
      const result = simulateFoc6MosSteadyState({
        ...options,
        ctrl: { ...options.ctrl, vBusConstV: vBusV, modDepthM: requiredModDepthM },
      });
      const status: FocVoltageEnvelopeStatus = result.thermalRunaway
        ? 'THERMAL_RUNAWAY'
        : !result.steadyConverged ? 'THERMAL_NOT_CONVERGED' : 'CALCULATED';
      return {
        vBusV,
        requiredModDepthM,
        modulationCeiling: ceiling,
        status,
        result,
        note: status === 'THERMAL_RUNAWAY'
          ? '热反馈迭代检测到热失控；保留损耗诊断信息，但不提供可用稳态结温。'
          : status === 'THERMAL_NOT_CONVERGED'
            ? '热稳态迭代未收敛；当前温度仅为中间迭代值，不得作为稳态结温或设计依据。'
            : '在固定 Id/Iq、fe、Fsw、PF 和参考基波电压假设下完成稳态计算。',
      };
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      const isCoverageFailure = /DPT LUT.*(?:OUT_OF_RANGE|越界|超出)|超出 Eoss(?:\(V\))?\/Qoss|曲线定义域|超出 Rds\(on\)-Tj 曲线范围/.test(note);
      return {
        vBusV,
        requiredModDepthM,
        modulationCeiling: ceiling,
        status: isCoverageFailure ? 'MODEL_OUT_OF_RANGE' : 'INVALID_INPUT',
        result: null,
        note,
      };
    }
  });
}
