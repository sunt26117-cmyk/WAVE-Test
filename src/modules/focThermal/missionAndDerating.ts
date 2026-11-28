/**
 * FOC 6-MOS Multi-Stage Thermal Mission Profile & Ambient/Voltage Derating Curve Solver
 *
 * Reuses the exact cycle-averaged 6-MOS loss physics (averageFocSteadyLosses),
 * Rds(on)(Tj) feedback, 4D DPT LUT guards, and StarCoupled6MosThermalSolver
 * without relaxing any physical or qualification safeguards.
 */

import type { CauerStage } from "../thermalEngine";
import {
  DEFAULT_FOC_MODEL,
  FocControlParams,
  FocDeratingCurveOptions,
  FocDeratingCurveResult,
  FocDeratingLimitReason,
  FocDeratingPoint,
  FocMissionProfileOptions,
  FocMissionProfileResult,
  FocMissionStage,
  FocMissionStageSummary,
  FocMosParams,
  FocResultQualification,
  FocSteadyOperatingPoint,
  FocThermalModel,
  MOS_SWITCH_KEYS,
  MosSwitchKey,
  getModulationLinearCeiling,
} from "./types";
import {
  getFocMosRdsFactorAtTj,
  qossCoveredByQr,
  resolveInitialThermalProbeTjC,
  validateMosEnergyAccounting,
  validateRdsOnTempCurveForMos,
} from "./lossModel";
import { StarCoupled6MosThermalSolver } from "./thermalNetwork";
import {
  averageFocSteadyLosses,
  simulateFoc6MosSteadyState,
} from "./steadySolver";

function assessModelQualification(
  model: FocThermalModel,
  mos: FocMosParams,
  extraAssumptions: string[] = []
): { qualification: FocResultQualification; reasons: string[] } {
  const missing: string[] = [];
  const assumptions: string[] = [];
  if (!mos.dptLut?.length && mos.eonPlusEoffUj <= 0) missing.push('Eon+Eoff/DPT');
  if (!mos.dptLut?.length && !mos.eonIncludesQrr && mos.qrrNc <= 0) missing.push('Qrr');
  if (!mos.eossAlreadyIncludedInEsw && !mos.eossCurve && (mos.eossUj ?? 0) <= 0 && !qossCoveredByQr(mos)) {
    missing.push('Eoss');
  }
  if (mos.rdsDataConfirmed !== true) {
    assumptions.push('Rds(on)@25°C 未按目标器件 Vgs/测试条件确认');
  }
  if (mos.rdsOnTempCurve && (mos.rdsOnTempCurve.provenance === 'assumed' || !mos.rdsOnTempCurve.partNumber?.trim())) {
    assumptions.push('Rds(on)-Tj 曲线来源为假设/未绑定具体器件型号');
  }
  if (!mos.dptLut?.length) {
    assumptions.push('开关能量使用单点标量 V/I 缩放，不是多工况 DPT LUT');
  }
  if (model.modelKind !== 'datasheet_constrained' || model.zthValidation?.passed !== true) {
    assumptions.push('热网络未通过目标器件数据手册约束及 JC/Board 拆分验证');
  }
  if (model.modelKind === 'fallback_default' || model.modelKind === 'demo_builtin' || !model.modelKind) {
    assumptions.push('使用默认/演示热网络，不代表目标 MOS 与 PCB 的实测热路径');
  }
  for (const note of extraAssumptions) {
    if (note && !assumptions.includes(note)) assumptions.push(note);
  }
  const qualification: FocResultQualification = missing.length > 0
    ? 'INCOMPLETE_LOSS_MODEL'
    : assumptions.length > 0
    ? 'ASSUMPTION_BASED'
    : 'DEVICE_PARAMETERIZED';
  return {
    qualification,
    reasons: [...missing.map((x) => `缺少 ${x}`), ...assumptions],
  };
}

function validateThermalModelAndMos(model: FocThermalModel, mos: FocMosParams): void {
  if (model.splitFeasible === false) {
    throw new Error(model.splitMeta?.warning || 'ZthJC / Zth_board 热路径拆分不可行，已阻止热仿真。');
  }
  const finite = (v: number) => Number.isFinite(v);
  if (!finite(mos.rdsOn25Mohm) || mos.rdsOn25Mohm <= 0) {
    throw new Error('Rds(on)@25°C 必须为有限正数（mΩ）。');
  }
  if (!mos.rdsOnTempCurve && (!finite(mos.tempCoeffAlphaPerC) || mos.tempCoeffAlphaPerC < 0 || mos.tempCoeffAlphaPerC > 0.05)) {
    throw new Error('Rds 温度系数必须为 0～0.05 /°C。');
  }
  if (mos.rdsOnTempCurve) validateRdsOnTempCurveForMos(mos);
  validateMosEnergyAccounting(mos);
  if (!finite(mos.vsdV) || mos.vsdV < 0 || mos.vsdV > 10) throw new Error('体二极管压降必须为 0～10 V。');
  if (!finite(mos.eonPlusEoffUj) || mos.eonPlusEoffUj < 0 || !finite(mos.qrrNc) || mos.qrrNc < 0) {
    throw new Error('Eon+Eoff 和 Qrr 必须为非负有限数值。');
  }
  if (!finite(mos.vRefV) || mos.vRefV <= 0 || !finite(mos.iRefA) || mos.iRefA <= 0) {
    throw new Error('开关能量参考电压 Vref 和参考电流 Iref 必须为有限正数。');
  }
  if (mos.dptLut && mos.dptLut.length > 0 &&
    (!(mos.rgOnOhm !== undefined && finite(mos.rgOnOhm) && mos.rgOnOhm >= 0) ||
      !(mos.rgOffOhm !== undefined && finite(mos.rgOffOhm) && mos.rgOffOhm >= 0))) {
    throw new Error('启用 DPT LUT 时必须明确输入 Rg_on 和 Rg_off。');
  }

  const jcStages = model.zthJC.length > 0 ? model.zthJC : DEFAULT_FOC_MODEL.zthJC;
  const boardStages = model.zthBoard.length > 0 ? model.zthBoard : DEFAULT_FOC_MODEL.zthBoard;
  const checkStages = (stages: CauerStage[], label: string) => {
    if (!stages.length) throw new Error(`${label} 热网络不能为空。`);
    stages.forEach((s, i) => {
      if (!finite(s.r) || s.r <= 0 || !finite(s.c) || s.c <= 0) {
        throw new Error(`${label} 第 ${i + 1} 阶 R/C 必须为有限正数。`);
      }
    });
  };
  checkStages(jcStages, 'ZthJC');
  checkStages(boardStages, 'ZthBoard');
}

/**
 * Default 12V automotive operating-cycle mission profile starter.
 * Only sets operating profile stages; never alters MOS device or thermal network parameters.
 */
export function createAutomotive12VMissionProfilePreset(baseCtrl?: Partial<FocControlParams>): FocMissionStage[] {
  const fswHz = baseCtrl && Number.isFinite(baseCtrl.fswHz) && (baseCtrl.fswHz as number) > 0 ? (baseCtrl.fswHz as number) : 20000;
  const tAmbC = baseCtrl && Number.isFinite(baseCtrl.tAmbC) ? (baseCtrl.tAmbC as number) : 85;
  return [
    {
      id: 'stage_crank',
      label: '9V 冷起动冲击',
      mode: 'rotating',
      durationSec: 3,
      iqPeakA: 45,
      idPeakA: 0,
      electricalFrequencyHz: 40,
      vBusV: 9.0,
      modDepthM: 0.85,
      pfAngleDeg: 10,
      fswHz,
      tAmbC,
    },
    {
      id: 'stage_cruise',
      label: '13.5V 额定巡航',
      mode: 'rotating',
      durationSec: 40,
      iqPeakA: 25,
      idPeakA: 0,
      electricalFrequencyHz: 180,
      vBusV: 13.5,
      modDepthM: 0.82,
      pfAngleDeg: 12,
      fswHz,
      tAmbC,
    },
    {
      id: 'stage_stall',
      label: '短时堵转过载 (90°)',
      mode: 'locked_rotor',
      durationSec: 3,
      iqPeakA: 40,
      idPeakA: 0,
      electricalFrequencyHz: 0,
      electricalAngleDeg: 90,
      vBusV: 13.5,
      modDepthM: 0.35,
      pfAngleDeg: 0,
      fswHz,
      tAmbC,
    },
    {
      id: 'stage_cool',
      label: '轻载冷却',
      mode: 'rotating',
      durationSec: 20,
      iqPeakA: 6,
      idPeakA: 0,
      electricalFrequencyHz: 60,
      vBusV: 13.5,
      modDepthM: 0.3,
      pfAngleDeg: 5,
      fswHz,
      tAmbC,
    },
  ];
}

/**
 * Runs a coupled multi-stage thermal mission profile across N consecutive cycles,
 * passing exact 6-MOS + PCB + Board Cauer thermal state continuously across stage transitions
 * with live Tj feedback into Rds(on)(Tj) and optional Tj-axis 4D DPT LUT.
 */
export function simulateFocMissionProfile(
  options: FocMissionProfileOptions
): FocMissionProfileResult {
  const { model, mos, baseCtrl, stages } = options;
  validateThermalModelAndMos(model, mos);
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new Error('任务剖面至少需要包含 1 个有效工况阶段。');
  }

  const repeatCycles = Math.round(options.repeatCycles ?? 1);
  if (!Number.isInteger(repeatCycles) || repeatCycles < 1 || repeatCycles > 20) {
    throw new Error('任务剖面循环次数必须为 1～20 的整数。');
  }
  const tjLimitC = options.tjLimitC ?? 150;
  if (!Number.isFinite(tjLimitC) || tjLimitC <= -50 || tjLimitC > 300) {
    throw new Error('目标结温上限 Tj_limit 必须位于 -50°C～300°C。');
  }
  const integrationSamples = Math.round(options.integrationSamplesPerCycle ?? 360);
  if (!Number.isInteger(integrationSamples) || integrationSamples < 72 || integrationSamples > 2048) {
    throw new Error('任务剖面电周期积分点数必须为 72～2048 的整数。');
  }
  const maxTimelinePoints = Math.max(200, Math.min(5000, Math.round(options.maxTimelinePoints ?? 1600)));
  const ceiling = getModulationLinearCeiling(baseCtrl.modulation);

  interface PreparedStage {
    stage: FocMissionStage;
    ctrl: FocControlParams;
    op: FocSteadyOperatingPoint;
    angleDeg: number;
    tAmbC: number;
    baseLoss: ReturnType<typeof averageFocSteadyLosses>;
    hasTjAxisLut: boolean;
  }

  const extraAssumptions: string[] = [];
  const warnings: string[] = [
    '任务剖面热循环采用各阶段电周期平均损耗（堵转阶段按固定电角度）耦合 6-MOS 瞬态热网络，不模拟单个 PWM 载波瞬态纹波。',
  ];

  const prepared: PreparedStage[] = stages.map((st, idx) => {
    const tag = `阶段 ${idx + 1} (${st.label || '未命名'})`;
    if (!Number.isFinite(st.durationSec) || st.durationSec <= 0 || st.durationSec > 86400) {
      throw new Error(`${tag} 持续时长必须位于 (0, 86400] 秒。`);
    }
    if (!Number.isFinite(st.vBusV) || st.vBusV <= 0 || st.vBusV > 1e5) {
      throw new Error(`${tag} 母线电压必须为有限正数。`);
    }
    if (!Number.isFinite(st.iqPeakA) || !Number.isFinite(st.idPeakA ?? 0)) {
      throw new Error(`${tag} Id/Iq 必须为有限峰值电流。`);
    }
    const fswHz = st.fswHz ?? baseCtrl.fswHz;
    if (!Number.isFinite(fswHz) || fswHz <= 0 || fswHz > 5e6) {
      throw new Error(`${tag} PWM 频率必须位于 (0, 5 MHz]。`);
    }
    const pfAngleDeg = st.pfAngleDeg ?? baseCtrl.pfAngleDeg;
    if (!Number.isFinite(pfAngleDeg) || pfAngleDeg < -180 || pfAngleDeg > 180) {
      throw new Error(`${tag} 功率因数角必须位于 -180°～180°。`);
    }
    const tAmbC = st.tAmbC ?? baseCtrl.tAmbC;
    if (!Number.isFinite(tAmbC) || tAmbC <= -273.15 || tAmbC > 1000) {
      throw new Error(`${tag} 环境温度超出合法物理范围。`);
    }
    if (!Number.isFinite(st.modDepthM) || st.modDepthM < 0 || st.modDepthM > ceiling + 1e-6) {
      throw new Error(`${tag} 调制度 m=${st.modDepthM} 超出 ${baseCtrl.modulation} 线性上限 ${ceiling.toFixed(4)}；任务剖面拒绝在过调制区继续估算。`);
    }
    if (st.mode === 'rotating') {
      if (!Number.isFinite(st.electricalFrequencyHz) || st.electricalFrequencyHz <= 0) {
        throw new Error(`${tag} 旋转模式电频率必须大于 0 Hz。`);
      }
      if (st.electricalFrequencyHz >= fswHz) {
        throw new Error(`${tag} 电频率 (${st.electricalFrequencyHz} Hz) 不得达到或超过 PWM 频率 (${fswHz} Hz)。`);
      }
      if (fswHz / st.electricalFrequencyHz < 20) {
        extraAssumptions.push(`${tag} 每电周期仅 ${(fswHz / st.electricalFrequencyHz).toFixed(1)} 个 PWM 周期`);
      }
    } else {
      if (Number.isFinite(st.electricalFrequencyHz) && st.electricalFrequencyHz > 1e-9) {
        throw new Error(`${tag} 堵转 (locked_rotor) 模式电频率必须为 0 Hz。`);
      }
    }
    const angleDeg = st.electricalAngleDeg ?? 90;
    if (!Number.isFinite(angleDeg) || angleDeg < 0 || angleDeg > 360) {
      throw new Error(`${tag} 堵转电角度必须位于 0°～360°。`);
    }

    const ctrl: FocControlParams = {
      ...baseCtrl,
      vBusConstV: st.vBusV,
      modDepthM: st.modDepthM,
      pfAngleDeg,
      fswHz,
      tAmbC,
    };
    const op: FocSteadyOperatingPoint = {
      iqPeakA: st.iqPeakA,
      idPeakA: st.idPeakA ?? 0,
      electricalFrequencyHz: st.mode === 'rotating' ? st.electricalFrequencyHz : 0,
      mode: st.mode,
      electricalAngleDeg: angleDeg,
    };
    const probeTjC = resolveInitialThermalProbeTjC(mos, tAmbC);
    const baseLoss = averageFocSteadyLosses(
      op,
      st.mode,
      integrationSamples,
      angleDeg,
      mos,
      ctrl,
      [probeTjC, probeTjC, probeTjC, probeTjC, probeTjC, probeTjC]
    );
    if (baseLoss.lutOutOfRangeCount > 0) {
      throw new Error(`${tag} 触发 4D DPT LUT 越界查询（Vbus=${st.vBusV}V, Iq=${st.iqPeakA}A），任务剖面已拒绝外推。`);
    }
    return {
      stage: st,
      ctrl,
      op,
      angleDeg,
      tAmbC,
      baseLoss,
      hasTjAxisLut: baseLoss.lutActiveDims.has('Tj'),
    };
  });

  const singleCycleDuration = prepared.reduce((acc, p) => acc + p.stage.durationSec, 0);
  const totalDurationSec = singleCycleDuration * repeatCycles;
  const totalStageCount = prepared.length * repeatCycles;

  // Allocate time steps per stage proportional to duration, with a minimum of 8 steps per stage
  const minStepsPerStage = Math.max(4, Math.min(12, Math.floor(maxTimelinePoints / Math.max(1, totalStageCount))));
  const remainingBudget = Math.max(0, maxTimelinePoints - 1 - minStepsPerStage * totalStageCount);
  const stepsByStageTemplate = prepared.map((p) => {
    const share = Math.round((p.stage.durationSec / Math.max(1e-9, singleCycleDuration)) * (remainingBudget / repeatCycles));
    return Math.max(minStepsPerStage, minStepsPerStage + share);
  });

  const totalSteps = stepsByStageTemplate.reduce((a, b) => a + b, 0) * repeatCycles;
  const sampleLen = totalSteps + 1;

  const time = new Float64Array(sampleLen);
  const tj: Record<MosSwitchKey, Float32Array> = {
    AH: new Float32Array(sampleLen),
    AL: new Float32Array(sampleLen),
    BH: new Float32Array(sampleLen),
    BL: new Float32Array(sampleLen),
    CH: new Float32Array(sampleLen),
    CL: new Float32Array(sampleLen),
  };
  const tBoard = new Float32Array(sampleLen);
  const pInvTotal = new Float32Array(sampleLen);
  const stageIdxAtSample = new Int16Array(sampleLen);

  const solver = new StarCoupled6MosThermalSolver(
    model,
    prepared[0].tAmbC,
    undefined,
    options.initialThermalState
  );

  const evalLossVectorAtTj = (prep: PreparedStage, curTj: number[]): number[] => {
    if (prep.hasTjAxisLut) {
      const liveLoss = averageFocSteadyLosses(
        prep.op,
        prep.stage.mode,
        Math.min(180, integrationSamples),
        prep.angleDeg,
        mos,
        prep.ctrl,
        curTj
      );
      if (liveLoss.lutOutOfRangeCount > 0) {
        throw new Error(`阶段 "${prep.stage.label}" 在瞬时结温 Tj=${Math.max(...curTj).toFixed(1)}°C 处超出 4D DPT LUT 温度覆盖范围，已拒绝外推。`);
      }
      return MOS_SWITCH_KEYS.map((_, m) => {
        const factor = getFocMosRdsFactorAtTj(mos, curTj[m]);
        return liveLoss.pCond25W[m] * factor + liveLoss.pSwitchingW[m] + liveLoss.pDeadTimeW[m];
      });
    }
    return MOS_SWITCH_KEYS.map((_, m) => {
      const factor = getFocMosRdsFactorAtTj(mos, curTj[m]);
      return prep.baseLoss.pCond25W[m] * factor + prep.baseLoss.pSwitchingW[m] + prep.baseLoss.pDeadTimeW[m];
    });
  };

  let cursor = 0;
  let elapsed = 0;
  let tjPeakGlobalC = -Infinity;
  let hottestKeyGlobal: MosSwitchKey = 'AH';
  let tBoardPeakC = -Infinity;
  let firstExceedTimeSec: number | null = null;
  const stageSummaries: FocMissionStageSummary[] = [];
  const cyclePeakTjC: number[] = [];

  // Record initial state at t=0
  const initTj = solver.getJunctionTemps();
  const initP = evalLossVectorAtTj(prepared[0], initTj);
  time[0] = 0;
  stageIdxAtSample[0] = 0;
  tBoard[0] = solver.getBoardTemp();
  pInvTotal[0] = initP.reduce((a, b) => a + b, 0);
  for (let m = 0; m < 6; m++) {
    const key = MOS_SWITCH_KEYS[m];
    tj[key][0] = initTj[m];
    if (initTj[m] > tjPeakGlobalC) {
      tjPeakGlobalC = initTj[m];
      hottestKeyGlobal = key;
    }
  }
  if (tBoard[0] > tBoardPeakC) tBoardPeakC = tBoard[0];
  if (tjPeakGlobalC > tjLimitC) firstExceedTimeSec = 0;

  for (let cyc = 0; cyc < repeatCycles; cyc++) {
    let cycPeak = -Infinity;

    for (let sIdx = 0; sIdx < prepared.length; sIdx++) {
      const prep = prepared[sIdx];
      const nSteps = stepsByStageTemplate[sIdx];
      const dt = prep.stage.durationSec / nSteps;
      const tStageStart = elapsed;

      solver.setAmbientTemp(prep.tAmbC);

      let stagePeak = -Infinity;
      let stageHotKey: MosSwitchKey = 'AH';
      let stagePEnergy = 0;

      for (let step = 0; step < nSteps; step++) {
        const curTj = solver.getJunctionTemps();
        const pStep = evalLossVectorAtTj(prep, curTj);
        const pTotal = pStep.reduce((a, b) => a + b, 0);
        if (!Number.isFinite(pTotal) || pStep.some((p) => !Number.isFinite(p) || p < 0)) {
          throw new Error(`阶段 "${prep.stage.label}" 在 t=${elapsed.toFixed(3)}s 处出现非法功率值。`);
        }

        // Guard against runaway divergence in transient stepping
        const maxCur = Math.max(...curTj);
        if (!Number.isFinite(maxCur) || maxCur > 1000) {
          throw new Error(`任务剖面在阶段 "${prep.stage.label}" (t=${elapsed.toFixed(2)}s) 结温发散超过 1000°C（疑似热失控），已中止积分。`);
        }

        solver.step(dt, pStep);
        elapsed += dt;
        stagePEnergy += pTotal * dt;
        cursor += 1;

        const nextTj = solver.getJunctionTemps();
        const nextBrd = solver.getBoardTemp();
        time[cursor] = elapsed;
        tBoard[cursor] = nextBrd;
        pInvTotal[cursor] = pTotal;
        stageIdxAtSample[cursor] = sIdx;

        for (let m = 0; m < 6; m++) {
          const key = MOS_SWITCH_KEYS[m];
          const val = nextTj[m];
          tj[key][cursor] = val;
          if (val > stagePeak) {
            stagePeak = val;
            stageHotKey = key;
          }
          if (val > cycPeak) cycPeak = val;
          if (val > tjPeakGlobalC) {
            tjPeakGlobalC = val;
            hottestKeyGlobal = key;
          }
        }
        if (nextBrd > tBoardPeakC) tBoardPeakC = nextBrd;
        if (firstExceedTimeSec === null && stagePeak > tjLimitC) {
          firstExceedTimeSec = elapsed;
        }
      }

      const endTj = solver.getJunctionTemps();
      const tjEndC = Math.max(...endTj);
      stageSummaries.push({
        cycleIndex: cyc + 1,
        stageIndex: sIdx + 1,
        label: prep.stage.label || `阶段 ${sIdx + 1}`,
        mode: prep.stage.mode,
        tStartSec: tStageStart,
        tEndSec: elapsed,
        durationSec: prep.stage.durationSec,
        vBusV: prep.stage.vBusV,
        iqPeakA: prep.stage.iqPeakA,
        tAmbC: prep.tAmbC,
        pInvAvgW: stagePEnergy / prep.stage.durationSec,
        tjPeakC: stagePeak,
        tjEndC,
        tBoardEndC: solver.getBoardTemp(),
        hottestKey: stageHotKey,
        marginToLimitC: tjLimitC - stagePeak,
        exceededLimit: stagePeak > tjLimitC,
      });
    }

    cyclePeakTjC.push(cycPeak);
  }

  const ratchetDeltaTjC =
    cyclePeakTjC.length >= 2
      ? cyclePeakTjC[cyclePeakTjC.length - 1] - cyclePeakTjC[cyclePeakTjC.length - 2]
      : null;

  if (ratchetDeltaTjC !== null && ratchetDeltaTjC > 1.0) {
    warnings.push(
      `末两轮循环峰值结温仍在爬升 (+${ratchetDeltaTjC.toFixed(2)}°C/循环)，尚未进入准周期热稳态；建议增加循环次数或检查散热路径。`
    );
  }
  if (firstExceedTimeSec !== null) {
    warnings.push(
      `结温在 t=${firstExceedTimeSec.toFixed(2)}s 首次超过设定限值 Tj_limit=${tjLimitC.toFixed(1)}°C（全局峰值 ${tjPeakGlobalC.toFixed(1)}°C @ ${hottestKeyGlobal}）。`
    );
  }

  const { qualification, reasons } = assessModelQualification(model, mos, extraAssumptions);

  return {
    resultQualification: qualification,
    qualificationReasons: reasons,
    warnings,
    repeatCycles,
    tjLimitC,
    totalDurationSec,
    time: time.subarray(0, cursor + 1),
    tj: {
      AH: tj.AH.subarray(0, cursor + 1),
      AL: tj.AL.subarray(0, cursor + 1),
      BH: tj.BH.subarray(0, cursor + 1),
      BL: tj.BL.subarray(0, cursor + 1),
      CH: tj.CH.subarray(0, cursor + 1),
      CL: tj.CL.subarray(0, cursor + 1),
    },
    tBoard: tBoard.subarray(0, cursor + 1),
    pInvTotal: pInvTotal.subarray(0, cursor + 1),
    stageIdxAtSample: stageIdxAtSample.subarray(0, cursor + 1),
    stageSummaries,
    cyclePeakTjC,
    ratchetDeltaTjC,
    tjPeakGlobalC,
    hottestKeyGlobal,
    tBoardPeakC,
    exceededLimit: tjPeakGlobalC > tjLimitC,
    firstExceedTimeSec,
    finalThermalState: solver.getStateSnapshot(),
  };
}

/**
 * Computes ambient temperature × bus voltage maximum sustainable phase current derating curves
 * using safeguarded monotone bisection over simulateFoc6MosSteadyState.
 * Never fabricates currents in voltage-limited, DPT-out-of-range, or thermal-runaway regions.
 */
export function computeFocThermalDeratingCurve(
  options: FocDeratingCurveOptions
): FocDeratingCurveResult {
  const { model, mos, ctrl, operatingPointTemplate } = options;
  validateThermalModelAndMos(model, mos);

  const tjLimitC = options.tjLimitC;
  if (!Number.isFinite(tjLimitC) || tjLimitC <= -50 || tjLimitC > 300) {
    throw new Error('降额曲线目标结温上限 Tj_limit 必须位于 -50°C～300°C。');
  }

  const tAmbPointsC = (options.tAmbPointsC && options.tAmbPointsC.length > 0
    ? options.tAmbPointsC
    : [25, 45, 65, 85, 105, 125]
  ).slice();
  if (tAmbPointsC.some((t) => !Number.isFinite(t) || t <= -273.15 || t > 300)) {
    throw new Error('降额曲线环境温度序列包含非法值。');
  }
  tAmbPointsC.sort((a, b) => a - b);

  const vBusPointsV = (options.vBusPointsV && options.vBusPointsV.length > 0
    ? options.vBusPointsV
    : [9, 13.5, 16]
  ).slice();
  if (vBusPointsV.some((v) => !Number.isFinite(v) || v <= 0)) {
    throw new Error('降额曲线母线电压序列必须全为有限正数。');
  }

  const referenceVoltageV = options.referenceVoltageV ?? ctrl.vBusConstV;
  if (!Number.isFinite(referenceVoltageV) || referenceVoltageV <= 0) {
    throw new Error('参考母线电压必须为有限正数。');
  }
  const iMaxSearchA = Math.max(1, Math.min(2000, options.iMaxSearchA ?? 200));
  const toleranceA = Math.max(0.02, options.toleranceA ?? 0.15);
  const ceiling = getModulationLinearCeiling(ctrl.modulation);
  const mode: 'rotating' | 'locked_rotor' =
    operatingPointTemplate.mode ??
    (operatingPointTemplate.electricalFrequencyHz > 1e-9 ? 'rotating' : 'locked_rotor');

  const idFixedA = operatingPointTemplate.idPeakA ?? 0;

  interface EvalProbe {
    ok: boolean;
    reason: FocDeratingLimitReason;
    tjMaxC: number | null;
    tBoardC: number | null;
    pInvW: number | null;
    hottestKey: MosSwitchKey | null;
    note: string;
  }

  const probeSteady = (
    vBusV: number,
    reqM: number,
    tAmbC: number,
    iqPeakA: number,
    integrationSamples: number
  ): EvalProbe => {
    try {
      const res = simulateFoc6MosSteadyState({
        model,
        mos,
        ctrl: {
          ...ctrl,
          vBusConstV: vBusV,
          modDepthM: reqM,
          tAmbC,
        },
        operatingPoint: {
          ...operatingPointTemplate,
          mode,
          iqPeakA,
          idPeakA: idFixedA,
          electricalFrequencyHz: mode === 'rotating' ? operatingPointTemplate.electricalFrequencyHz : 0,
        },
        integrationSamples,
      });
      if (res.thermalRunaway) {
        return {
          ok: false,
          reason: 'THERMAL_RUNAWAY_BOUNDARY',
          tjMaxC: null,
          tBoardC: null,
          pInvW: null,
          hottestKey: null,
          note: '达到热反馈失控边界（无有限稳态平衡点）。',
        };
      }
      if (!res.steadyConverged || !Number.isFinite(res.tjMaxSteadyC)) {
        return {
          ok: false,
          reason: 'THERMAL_RUNAWAY_BOUNDARY',
          tjMaxC: null,
          tBoardC: null,
          pInvW: null,
          hottestKey: null,
          note: '电热耦合稳态迭代未收敛。',
        };
      }
      if (res.tjMaxSteadyC <= tjLimitC + 1e-6) {
        return {
          ok: true,
          reason: 'THERMAL_LIMIT',
          tjMaxC: res.tjMaxSteadyC,
          tBoardC: res.tBoardSteadyC,
          pInvW: res.pInverterTotalW,
          hottestKey: res.hottestKey,
          note: '在稳态热限值内收敛。',
        };
      }
      return {
        ok: false,
        reason: 'THERMAL_LIMIT',
        tjMaxC: res.tjMaxSteadyC,
        tBoardC: res.tBoardSteadyC,
        pInvW: res.pInverterTotalW,
        hottestKey: res.hottestKey,
        note: `稳态结温 ${res.tjMaxSteadyC.toFixed(1)}°C 超过 Tj_limit=${tjLimitC.toFixed(1)}°C。`,
      };
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/DPT LUT.*(?:OUT_OF_RANGE|越界|超出)/i.test(msg)) {
        return {
          ok: false,
          reason: 'DPT_LUT_BOUND',
          tjMaxC: null,
          tBoardC: null,
          pInvW: null,
          hottestKey: null,
          note: '受 4D DPT LUT 实测电流/温度覆盖上限约束（未向外盲目外推）。',
        };
      }
      if (/Rds\(on\)-Tj.*曲线|曲线定义域|超出 Eoss/i.test(msg)) {
        return {
          ok: false,
          reason: 'RDS_CURVE_BOUND',
          tjMaxC: null,
          tBoardC: null,
          pInvW: null,
          hottestKey: null,
          note: msg,
        };
      }
      return {
        ok: false,
        reason: 'INVALID_INPUT',
        tjMaxC: null,
        tBoardC: null,
        pInvW: null,
        hottestKey: null,
        note: msg,
      };
    }
  };

  const points: FocDeratingPoint[] = [];
  const warnings: string[] = [
    `降额曲线基于恒定${mode === 'rotating' ? '旋转' : '堵转'}工况稳态模型求解最大允许电流，保持参考基波电压与开关频率不变（Tj_limit=${tjLimitC.toFixed(1)}°C）。`,
  ];

  for (const vBusV of vBusPointsV) {
    const reqM = (ctrl.modDepthM * referenceVoltageV) / vBusV;
    const voltageLimited = reqM > ceiling + 1e-6;

    for (const tAmbC of tAmbPointsC) {
      if (voltageLimited) {
        points.push({
          vBusV,
          tAmbC,
          requiredModDepthM: reqM,
          iPeakMaxA: null,
          iRmsMaxA: null,
          tjAtMaxC: null,
          tBoardAtMaxC: null,
          pInverterAtMaxW: null,
          hottestKey: null,
          limitReason: 'VOLTAGE_LIMITED',
          note: `维持参考基波电压需 m=${reqM.toFixed(3)} > ${ceiling.toFixed(3)}，超出线性调制区，未伪造允许电流。`,
        });
        continue;
      }

      if (tAmbC >= tjLimitC - 1e-6) {
        points.push({
          vBusV,
          tAmbC,
          requiredModDepthM: reqM,
          iPeakMaxA: 0,
          iRmsMaxA: mode === 'rotating' ? 0 : null,
          tjAtMaxC: tAmbC,
          tBoardAtMaxC: tAmbC,
          pInverterAtMaxW: 0,
          hottestKey: 'AH',
          limitReason: 'ZERO_MARGIN',
          note: `环境温度 Tamb=${tAmbC.toFixed(1)}°C 已达到或超过 Tj_limit=${tjLimitC.toFixed(1)}°C，无可用温升裕量。`,
        });
        continue;
      }

      // Check zero-current feasibility first (handles non-zero Eoss/fixed switching losses or LUT voltage out of range)
      const zeroProbe = probeSteady(vBusV, reqM, tAmbC, 0, 180);
      if (!zeroProbe.ok) {
        points.push({
          vBusV,
          tAmbC,
          requiredModDepthM: reqM,
          iPeakMaxA: zeroProbe.reason === 'THERMAL_LIMIT' || zeroProbe.reason === 'THERMAL_RUNAWAY_BOUNDARY' ? 0 : null,
          iRmsMaxA:
            mode === 'rotating' && (zeroProbe.reason === 'THERMAL_LIMIT' || zeroProbe.reason === 'THERMAL_RUNAWAY_BOUNDARY')
              ? 0
              : null,
          tjAtMaxC: zeroProbe.tjMaxC,
          tBoardAtMaxC: zeroProbe.tBoardC,
          pInverterAtMaxW: zeroProbe.pInvW,
          hottestKey: zeroProbe.hottestKey,
          limitReason: zeroProbe.reason === 'THERMAL_LIMIT' ? 'ZERO_MARGIN' : zeroProbe.reason,
          note: zeroProbe.note,
        });
        continue;
      }

      // Exponential bracketing from lo = 0
      let lo = 0;
      let hi = Math.min(iMaxSearchA, 10);
      let loProbe = zeroProbe;
      let hiReason: FocDeratingLimitReason = 'SEARCH_CEILING_REACHED';
      let hiNote = '';

      while (true) {
        const p = probeSteady(vBusV, reqM, tAmbC, hi, 180);
        if (p.ok) {
          lo = hi;
          loProbe = p;
          if (hi >= iMaxSearchA - 1e-9) {
            hiReason = 'SEARCH_CEILING_REACHED';
            hiNote = `达到设定电流搜索上限 ${iMaxSearchA.toFixed(1)} A_pk（此时 Tj=${(p.tjMaxC ?? 0).toFixed(1)}°C <= ${tjLimitC.toFixed(1)}°C）。`;
            break;
          }
          hi = Math.min(iMaxSearchA, hi * 2);
        } else {
          hiReason = p.reason;
          hiNote = p.note;
          break;
        }
      }

      // Safeguarded bisection within [lo, hi]
      if (hiReason !== 'SEARCH_CEILING_REACHED') {
        for (let iter = 0; iter < 28; iter++) {
          if (hi - lo <= Math.max(toleranceA, lo * 0.004)) break;
          const mid = 0.5 * (lo + hi);
          const p = probeSteady(vBusV, reqM, tAmbC, mid, 180);
          if (p.ok) {
            lo = mid;
            loProbe = p;
          } else {
            hi = mid;
            hiReason = p.reason;
            hiNote = p.note;
          }
        }
      }

      // Final high-resolution verification (720 pts) so reported I_max is guaranteed <= Tj_limit
      let finalIq = lo;
      let finalProbe = probeSteady(vBusV, reqM, tAmbC, finalIq, 720);
      for (let backoff = 0; backoff < 5 && !finalProbe.ok && finalIq > 0; backoff++) {
        finalIq = Math.max(0, finalIq * 0.992);
        finalProbe = probeSteady(vBusV, reqM, tAmbC, finalIq, 720);
      }
      if (!finalProbe.ok) {
        finalProbe = loProbe;
      }

      const iPeakTotal = Math.hypot(finalIq, idFixedA);
      points.push({
        vBusV,
        tAmbC,
        requiredModDepthM: reqM,
        iPeakMaxA: iPeakTotal,
        iRmsMaxA: mode === 'rotating' ? iPeakTotal / Math.sqrt(2) : null,
        tjAtMaxC: finalProbe.tjMaxC,
        tBoardAtMaxC: finalProbe.tBoardC,
        pInverterAtMaxW: finalProbe.pInvW,
        hottestKey: finalProbe.hottestKey,
        limitReason: hiReason,
        note:
          hiReason === 'THERMAL_LIMIT'
            ? `受稳态结温限值 Tj_limit=${tjLimitC.toFixed(1)}°C 约束`
            : hiNote,
      });
    }
  }

  const { qualification, reasons } = assessModelQualification(model, mos);

  const csvLines = [
    'Vbus_V,Tamb_C,Required_m,Ipeak_max_A,Irms_max_A,Tj_max_C,Tboard_C,P_inv_W,HottestSwitch,LimitReason,Note',
  ];
  for (const pt of points) {
    const f = (v: number | null, d = 3) => (v !== null && Number.isFinite(v) ? v.toFixed(d) : '');
    const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    csvLines.push(
      [
        pt.vBusV.toFixed(2),
        pt.tAmbC.toFixed(1),
        pt.requiredModDepthM.toFixed(4),
        f(pt.iPeakMaxA, 2),
        f(pt.iRmsMaxA, 2),
        f(pt.tjAtMaxC, 2),
        f(pt.tBoardAtMaxC, 2),
        f(pt.pInverterAtMaxW, 3),
        pt.hottestKey ?? '',
        pt.limitReason,
        esc(pt.note),
      ].join(',')
    );
  }

  return {
    resultQualification: qualification,
    qualificationReasons: reasons,
    warnings,
    tjLimitC,
    mode,
    tAmbPointsC,
    vBusPointsV,
    points,
    csvContent: csvLines.join('\n'),
  };
}
