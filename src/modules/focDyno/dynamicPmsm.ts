/**
 * Standalone Dynamic PMSM dq-Axis Transient ODE Simulator (FD-03)
 *
 * Strictly decoupled from the steady-state SPMSM dyno calibrator (dynoCalibrator.ts / solveSinglePoint).
 * Models transient electrical & mechanical dynamics in amplitude-invariant Clarke/Park coordinates:
 *   di_d/dt = (v_d - Rs * i_d + omega_e * Lq * i_q) / Ld
 *   di_q/dt = (v_q - Rs * i_q - omega_e * (Ld * i_d + psi_f)) / Lq
 *   Te      = 1.5 * p * (psi_f * i_q + (Ld - Lq) * i_d * i_q)
 *   domega_m/dt = (Te - B * omega_m - T_load - T_coulomb * tanh(omega_m / 0.5)) / J
 *   dtheta_e/dt = p * omega_m
 *
 * Provenance: EVERY output is explicitly labeled 'synthetic_assumed_uncalibrated' and must never be
 * mixed into steady-state calibration metrics or presented as measured oscilloscope waveforms.
 */

import { TabState, WaveformChannel } from '../../types/models';
import { analyzeSamplingQuality } from '../qualityCheck';

export type DynamicControlMode = 'mtpa_current_loop' | 'id_zero' | 'open_loop_vdq';
export type DynamicQuadrantMode = 'motoring' | 'regen' | 'standstill';

export interface DynamicPmsmParams {
  polePairs: number;
  rsOhm: number;
  ldH: number;
  lqH: number;
  /** Permanent magnet flux linkage psi_f [V·s] (= Ke' / p in amplitude-invariant convention). */
  psiFVs: number;
  jKgM2: number;
  bNmSPerRad: number;
  tCoulombNm: number;
  vBusV: number;
  iMaxA: number;
  controlMode: DynamicControlMode;
  /** Optional current-loop bandwidth [rad/s] (default 2*pi*250). */
  currentBandwidthRadS?: number;
  /** Optional speed-loop PI gains (used when step specifies speedRefRpm). */
  kpSpeed?: number;
  kiSpeed?: number;
}

export interface DynamicScenarioStep {
  tStartSec: number;
  tEndSec: number;
  tLoadNm: number;
  /** Closed-loop speed target [RPM] (used in mtpa_current_loop / id_zero if iqRefA is omitted). */
  speedRefRpm?: number;
  /** Direct current magnitude/torque-producing reference [A] (overrides speed loop if finite). */
  iqRefA?: number;
  /** Open-loop dq voltage command [V] (used when controlMode === 'open_loop_vdq'). */
  vdRefV?: number;
  vqRefV?: number;
  /** Optional step override for bus voltage [V]. */
  vBusV?: number;
}

export interface DynamicPmsmConfig {
  durationSec: number;
  /** Output sampling interval [s] (internal RK4 micro-step auto-refines below L/R). */
  dtOutSec: number;
  initialSpeedRpm?: number;
  initialIdA?: number;
  initialIqA?: number;
  initialThetaERad?: number;
  scenario: DynamicScenarioStep[];
}

export interface DynamicSteadyCheck {
  finalSpeedRpm: number;
  finalIdA: number;
  finalIqA: number;
  analyticalTeNm: number;
  analyticalVdV: number;
  analyticalVqV: number;
  simTeNm: number;
  simVdV: number;
  simVqV: number;
  torqueDiffNm: number;
  voltageDiffV: number;
  diDtNormAps: number;
  dOmegaDtNormRadS2: number;
}

export interface DynamicPmsmResult {
  provenance: 'synthetic_assumed_uncalibrated';
  sourceModel: 'dynamic_pmsm_dq_rk4';
  warnings: string[];
  dtInternalSec: number;
  substepsPerOutput: number;
  time: Float64Array;
  thetaE: Float64Array;
  omegaM: Float64Array;
  nRpm: Float64Array;
  idA: Float64Array;
  iqA: Float64Array;
  vdV: Float64Array;
  vqV: Float64Array;
  iaA: Float64Array;
  ibA: Float64Array;
  icA: Float64Array;
  teNm: Float64Array;
  tLoadNm: Float64Array;
  vBusV: Float64Array;
  mNorm: Float64Array;
  voltageLimited: Uint8Array;
  currentLimited: Uint8Array;
  quadrantMode: DynamicQuadrantMode[];
  peakAbsCurrentA: number;
  peakAbsTorqueNm: number;
  peakSpeedRpm: number;
  minSpeedRpm: number;
  voltageLimitHits: number;
  currentLimitHits: number;
  steadyCheck: DynamicSteadyCheck;
}

export interface DynamicCommandTarget {
  tLoadNm: number;
  vBusV: number;
  speedRefRpm?: number;
  iqRefA?: number;
  vdRefV: number;
  vqRefV: number;
}

/** Convert amplitude-invariant Ke' [Vp/(rad/s_mech)] to magnet flux linkage psi_f [V·s]. */
export function kePrimeToPsiF(kePrime: number, polePairs: number): number {
  return kePrime / Math.max(1, polePairs);
}

/** Compute electromagnetic torque Te = 1.5 * p * (psi_f * iq + (Ld - Lq) * id * iq). */
export function calcDynamicPmsmTorque(
  idA: number,
  iqA: number,
  polePairs: number,
  psiFVs: number,
  ldH: number,
  lqH: number
): number {
  return 1.5 * polePairs * (psiFVs * iqA + (ldH - lqH) * idA * iqA);
}

/**
 * Compute analytical MTPA (id*, iq*) for IPM (Ld != Lq) or SPMSM (Ld == Lq -> id*=0),
 * plus current-circle clamp (<= Imax) and high-speed field-weakening inside Vmax = Vbus/sqrt(3).
 */
export function computeMtpaAndFieldWeakeningTarget(
  iTorqueCmdA: number,
  omegaERadS: number,
  vBusV: number,
  params: DynamicPmsmParams
): { idRefA: number; iqRefA: number; currentLimited: boolean; fieldWeakeningActive: boolean } {
  const iMax = Math.max(0.05, params.iMaxA);
  const absCmd = Math.abs(iTorqueCmdA);
  const currentLimited = absCmd > iMax + 1e-9;
  const iMag = Math.min(absCmd, iMax);
  const signQ = iTorqueCmdA >= 0 ? 1 : -1;

  let idRef = 0;
  let iqRef = signQ * iMag;

  if (params.controlMode === 'mtpa_current_loop') {
    const dL = params.ldH - params.lqH;
    if (Math.abs(dL) > 1e-9 && iMag > 1e-9) {
      // Exact MTPA root minimizing |I| for given Te (negative id when Ld < Lq)
      const psi = Math.max(1e-6, params.psiFVs);
      const disc = psi * psi + 8 * dL * dL * iMag * iMag;
      idRef = (-psi + Math.sqrt(disc)) / (4 * dL);
      // Clamp |idRef| <= iMag/sqrt(2) safety
      const idBound = iMag * 0.95;
      if (Math.abs(idRef) > idBound) idRef = Math.sign(idRef) * idBound;
      iqRef = signQ * Math.sqrt(Math.max(0, iMag * iMag - idRef * idRef));
    }
  }

  // Voltage-ellipse check for field weakening (SVPWM linear limit Vmax = Vbus / sqrt(3))
  const vMaxEff = (Math.max(0.5, vBusV) / Math.sqrt(3)) * 0.96;
  const absWe = Math.abs(omegaERadS);
  let fieldWeakeningActive = false;
  if (absWe > 1.0 && params.controlMode === 'mtpa_current_loop') {
    const vReq = Math.hypot(-absWe * params.lqH * iqRef, absWe * (params.ldH * idRef + params.psiFVs));
    if (vReq > vMaxEff) {
      fieldWeakeningActive = true;
      // Solve voltage ellipse boundary for maximum feasible |iq| while pushing id < 0
      // Try bisection on id in [-iMax, idRef] maximizing |iq| inside both current & voltage circles
      const loInit = -iMax;
      const hiInit = idRef;
      let bestId = loInit;
      let bestIqAbs = 0;
      const samples = 40;
      for (let k = 0; k <= samples; k++) {
        const idCand = loInit + ((hiInit - loInit) * k) / samples;
        const iqCapCur = Math.sqrt(Math.max(0, iMax * iMax - idCand * idCand));
        const vdBack = absWe * (params.ldH * idCand + params.psiFVs);
        const remV2 = vMaxEff * vMaxEff - vdBack * vdBack;
        if (remV2 <= 0) continue;
        const iqCapVolt = Math.sqrt(remV2) / Math.max(1e-7, absWe * params.lqH);
        const iqFeas = Math.min(iqCapCur, iqCapVolt);
        if (iqFeas > bestIqAbs) {
          bestIqAbs = iqFeas;
          bestId = idCand;
        }
      }
      idRef = bestId;
      iqRef = signQ * Math.min(Math.abs(iqRef), bestIqAbs);
    }
  }

  return { idRefA: idRef, iqRefA: iqRef, currentLimited, fieldWeakeningActive };
}

function sampleScenarioAt(tSec: number, params: DynamicPmsmParams, scenario: DynamicScenarioStep[]): DynamicCommandTarget {
  if (scenario.length === 0) {
    return { tLoadNm: 0, vBusV: params.vBusV, iqRefA: 0, vdRefV: 0, vqRefV: 0 };
  }
  let chosen = scenario[scenario.length - 1];
  for (const step of scenario) {
    if (tSec >= step.tStartSec - 1e-12 && tSec <= step.tEndSec + 1e-12) {
      chosen = step;
      break;
    }
  }
  return {
    tLoadNm: Number.isFinite(chosen.tLoadNm) ? chosen.tLoadNm : 0,
    vBusV: chosen.vBusV !== undefined && Number.isFinite(chosen.vBusV) && chosen.vBusV > 0.5 ? chosen.vBusV : params.vBusV,
    speedRefRpm: chosen.speedRefRpm,
    iqRefA: chosen.iqRefA,
    vdRefV: Number.isFinite(chosen.vdRefV) ? (chosen.vdRefV as number) : 0,
    vqRefV: Number.isFinite(chosen.vqRefV) ? (chosen.vqRefV as number) : 0,
  };
}

/**
 * Build standard presets demonstrating 4-quadrant dynamics, load steps, and IPM MTPA + field weakening.
 */
export function buildDynamicPresetScenario(
  preset: 'startup_load_step' | 'four_quadrant_regen' | 'ipm_mtpa_fw'
): { paramsPatch: Partial<DynamicPmsmParams>; config: DynamicPmsmConfig } {
  if (preset === 'four_quadrant_regen') {
    return {
      paramsPatch: { controlMode: 'mtpa_current_loop', iMaxA: 15, vBusV: 24 },
      config: {
        durationSec: 0.35,
        dtOutSec: 2e-4,
        initialSpeedRpm: 0,
        scenario: [
          { tStartSec: 0, tEndSec: 0.12, tLoadNm: 0.05, speedRefRpm: 1400 },
          { tStartSec: 0.12, tEndSec: 0.24, tLoadNm: 0.05, speedRefRpm: -900 },
          { tStartSec: 0.24, tEndSec: 0.35, tLoadNm: -0.08, speedRefRpm: -900 },
        ],
      },
    };
  }
  if (preset === 'ipm_mtpa_fw') {
    return {
      paramsPatch: {
        polePairs: 4,
        rsOhm: 0.045,
        ldH: 0.18e-3,
        lqH: 0.42e-3, // salient IPM: Lq > Ld -> MTPA yields id < 0
        psiFVs: 0.015,
        jKgM2: 6.5e-5,
        bNmSPerRad: 8e-5,
        tCoulombNm: 0.005,
        vBusV: 24,
        iMaxA: 18,
        controlMode: 'mtpa_current_loop',
      },
      config: {
        durationSec: 0.25,
        dtOutSec: 2e-4,
        initialSpeedRpm: 0,
        scenario: [
          { tStartSec: 0, tEndSec: 0.08, tLoadNm: 0.25, speedRefRpm: 1500 },
          { tStartSec: 0.08, tEndSec: 0.25, tLoadNm: 0.15, speedRefRpm: 4800 },
        ],
      },
    };
  }
  return {
    paramsPatch: { controlMode: 'mtpa_current_loop' },
    config: {
      durationSec: 0.3,
      dtOutSec: 2e-4,
      initialSpeedRpm: 0,
      scenario: [
        { tStartSec: 0, tEndSec: 0.12, tLoadNm: 0.02, speedRefRpm: 1000 },
        { tStartSec: 0.12, tEndSec: 0.22, tLoadNm: 0.16, speedRefRpm: 1000 },
        { tStartSec: 0.22, tEndSec: 0.3, tLoadNm: 0.05, speedRefRpm: 1300 },
      ],
    },
  };
}

export function simulateDynamicPmsm(
  rawParams: DynamicPmsmParams,
  rawConfig: DynamicPmsmConfig
): DynamicPmsmResult {
  const p = Math.max(1, Math.round(rawParams.polePairs));
  const rs = Math.max(1e-4, rawParams.rsOhm);
  const ld = Math.max(1e-6, rawParams.ldH);
  const lq = Math.max(1e-6, rawParams.lqH);
  const psiF = Math.max(1e-5, rawParams.psiFVs);
  const jRot = Math.max(1e-7, rawParams.jKgM2);
  const bVisc = Math.max(0, rawParams.bNmSPerRad);
  const tCoul = Math.max(0, rawParams.tCoulombNm);
  const params: DynamicPmsmParams = {
    ...rawParams,
    polePairs: p,
    rsOhm: rs,
    ldH: ld,
    lqH: lq,
    psiFVs: psiF,
    jKgM2: jRot,
    bNmSPerRad: bVisc,
    tCoulombNm: tCoul,
    vBusV: Math.max(1, rawParams.vBusV),
    iMaxA: Math.max(0.1, rawParams.iMaxA),
  };

  const duration = Math.max(1e-3, Math.min(10, rawConfig.durationSec));
  const dtOut = Math.max(1e-5, Math.min(0.02, rawConfig.dtOutSec));
  const nOut = Math.max(2, Math.min(4000, Math.floor(duration / dtOut) + 1));
  const effDtOut = duration / (nOut - 1);

  const tauElecMin = Math.min(ld, lq) / rs;
  const maxStepH = Math.min(2e-5, 0.05 * tauElecMin, effDtOut);
  const substeps = Math.max(1, Math.ceil(effDtOut / Math.max(1e-7, maxStepH)));
  const h = effDtOut / substeps;

  // Current PI gains (pole placement at omega_bw_i)
  const bwI = Math.max(100, rawParams.currentBandwidthRadS ?? 2 * Math.PI * 300);
  const kpD = ld * bwI;
  const kiD = rs * bwI;
  const kpQ = lq * bwI;
  const kiQ = rs * bwI;

  // Speed PI gains (tuned relative to J & Kt0)
  const kt0 = 1.5 * p * psiF;
  const bwW = Math.min(bwI * 0.15, 120);
  const kpW = rawParams.kpSpeed ?? (jRot * bwW) / Math.max(1e-4, kt0);
  const kiW = rawParams.kiSpeed ?? (kpW * bwW * 0.25);

  const warnings: string[] = [
    '此模块为合成假设动态模型 (synthetic_assumed_uncalibrated)，使用独立的 Ld/Lq/J/B 参数与 RK4 求解，不等同于 Tab 1 稳态测功标定或实测示波器采集。',
  ];

  const time = new Float64Array(nOut);
  const thetaEArr = new Float64Array(nOut);
  const omegaMArr = new Float64Array(nOut);
  const nRpmArr = new Float64Array(nOut);
  const idArr = new Float64Array(nOut);
  const iqArr = new Float64Array(nOut);
  const vdArr = new Float64Array(nOut);
  const vqArr = new Float64Array(nOut);
  const iaArr = new Float64Array(nOut);
  const ibArr = new Float64Array(nOut);
  const icArr = new Float64Array(nOut);
  const teArr = new Float64Array(nOut);
  const tLoadArr = new Float64Array(nOut);
  const vBusArr = new Float64Array(nOut);
  const mNormArr = new Float64Array(nOut);
  const voltLimArr = new Uint8Array(nOut);
  const currLimArr = new Uint8Array(nOut);
  const quadrantMode: DynamicQuadrantMode[] = [];

  let id = Number.isFinite(rawConfig.initialIdA) ? (rawConfig.initialIdA as number) : 0;
  let iq = Number.isFinite(rawConfig.initialIqA) ? (rawConfig.initialIqA as number) : 0;
  let omegaM = ((Number.isFinite(rawConfig.initialSpeedRpm) ? (rawConfig.initialSpeedRpm as number) : 0) * 2 * Math.PI) / 60;
  let thetaE = Number.isFinite(rawConfig.initialThetaERad) ? (rawConfig.initialThetaERad as number) : 0;

  let intId = 0;
  let intIq = 0;
  let intW = 0;

  const evalControl = (tSec: number, curId: number, curIq: number, curOmegaM: number) => {
    const cmd = sampleScenarioAt(tSec, params, rawConfig.scenario);
    const vMax = cmd.vBusV / Math.sqrt(3);
    const we = p * curOmegaM;

    let vdCmd = cmd.vdRefV;
    let vqCmd = cmd.vqRefV;
    let iCurrLimited = false;

    if (params.controlMode !== 'open_loop_vdq') {
      let iTorqCmd = 0;
      if (cmd.iqRefA !== undefined && Number.isFinite(cmd.iqRefA)) {
        iTorqCmd = cmd.iqRefA;
      } else {
        const wRef = ((cmd.speedRefRpm ?? 0) * 2 * Math.PI) / 60;
        const errW = wRef - curOmegaM;
        const unsatI = kpW * errW + intW;
        iTorqCmd = unsatI;
      }
      const target = computeMtpaAndFieldWeakeningTarget(iTorqCmd, we, cmd.vBusV, params);
      iCurrLimited = target.currentLimited;

      const errD = target.idRefA - curId;
      const errQ = target.iqRefA - curIq;
      // Decoupled dq voltage command
      vdCmd = kpD * errD + intId - we * lq * curIq;
      vqCmd = kpQ * errQ + intIq + we * (ld * curId + psiF);
    }

    const vMag = Math.hypot(vdCmd, vqCmd);
    const vLimited = vMag > vMax;
    const scale = vLimited && vMag > 1e-12 ? vMax / vMag : 1;
    const vd = vdCmd * scale;
    const vq = vqCmd * scale;
    return { cmd, vd, vq, vdCmd, vqCmd, vMax, vLimited, iCurrLimited };
  };

  const rhs = (curId: number, curIq: number, curOmegaM: number, vd: number, vq: number, tLoadNm: number) => {
    const we = p * curOmegaM;
    const dId = (vd - rs * curId + we * lq * curIq) / ld;
    const dIq = (vq - rs * curIq - we * (ld * curId + psiF)) / lq;
    const te = calcDynamicPmsmTorque(curId, curIq, p, psiF, ld, lq);
    const fric = bVisc * curOmegaM + tCoul * Math.tanh(curOmegaM / 0.5);
    const dOmegaM = (te - fric - tLoadNm) / jRot;
    const dThetaE = we;
    return { dId, dIq, dOmegaM, dThetaE, te };
  };

  let peakAbsCurrentA = 0;
  let peakAbsTorqueNm = 0;
  let peakSpeedRpm = -Infinity;
  let minSpeedRpm = Infinity;
  let voltageLimitHits = 0;
  let currentLimitHits = 0;

  let lastVd = 0;
  let lastVq = 0;
  let lastTload = 0;

  for (let k = 0; k < nOut; k++) {
    const tCur = k * effDtOut;
    const ctrl = evalControl(tCur, id, iq, omegaM);
    const teNow = calcDynamicPmsmTorque(id, iq, p, psiF, ld, lq);
    const nRpmNow = (omegaM * 60) / (2 * Math.PI);

    const cosT = Math.cos(thetaE);
    const sinT = Math.sin(thetaE);
    const cosTm = Math.cos(thetaE - (2 * Math.PI) / 3);
    const sinTm = Math.sin(thetaE - (2 * Math.PI) / 3);
    const ia = id * cosT - iq * sinT;
    const ib = id * cosTm - iq * sinTm;
    const ic = -(ia + ib);

    const vMag = Math.hypot(ctrl.vd, ctrl.vq);
    const mNorm = ctrl.vMax > 0 ? vMag / ctrl.vMax : 0;

    time[k] = tCur;
    thetaEArr[k] = thetaE;
    omegaMArr[k] = omegaM;
    nRpmArr[k] = nRpmNow;
    idArr[k] = id;
    iqArr[k] = iq;
    vdArr[k] = ctrl.vd;
    vqArr[k] = ctrl.vq;
    iaArr[k] = ia;
    ibArr[k] = ib;
    icArr[k] = ic;
    teArr[k] = teNow;
    tLoadArr[k] = ctrl.cmd.tLoadNm;
    vBusArr[k] = ctrl.cmd.vBusV;
    mNormArr[k] = mNorm;
    voltLimArr[k] = ctrl.vLimited ? 1 : 0;
    currLimArr[k] = ctrl.iCurrLimited ? 1 : 0;

    const pMech = omegaM * teNow;
    const qMode: DynamicQuadrantMode =
      Math.abs(omegaM) < 0.05 && Math.abs(teNow) < 1e-3
        ? 'standstill'
        : pMech < -1e-3
        ? 'regen'
        : 'motoring';
    quadrantMode.push(qMode);

    peakAbsCurrentA = Math.max(peakAbsCurrentA, Math.hypot(id, iq));
    peakAbsTorqueNm = Math.max(peakAbsTorqueNm, Math.abs(teNow));
    peakSpeedRpm = Math.max(peakSpeedRpm, nRpmNow);
    minSpeedRpm = Math.min(minSpeedRpm, nRpmNow);
    if (ctrl.vLimited) voltageLimitHits++;
    if (ctrl.iCurrLimited) currentLimitHits++;
    lastVd = ctrl.vd;
    lastVq = ctrl.vq;
    lastTload = ctrl.cmd.tLoadNm;

    if (k === nOut - 1) break;

    for (let s = 0; s < substeps; s++) {
      const ts = tCur + s * h;
      const cStep = evalControl(ts, id, iq, omegaM);
      const k1 = rhs(id, iq, omegaM, cStep.vd, cStep.vq, cStep.cmd.tLoadNm);
      const k2 = rhs(
        id + 0.5 * h * k1.dId,
        iq + 0.5 * h * k1.dIq,
        omegaM + 0.5 * h * k1.dOmegaM,
        cStep.vd,
        cStep.vq,
        cStep.cmd.tLoadNm
      );
      const k3 = rhs(
        id + 0.5 * h * k2.dId,
        iq + 0.5 * h * k2.dIq,
        omegaM + 0.5 * h * k2.dOmegaM,
        cStep.vd,
        cStep.vq,
        cStep.cmd.tLoadNm
      );
      const k4 = rhs(
        id + h * k3.dId,
        iq + h * k3.dIq,
        omegaM + h * k3.dOmegaM,
        cStep.vd,
        cStep.vq,
        cStep.cmd.tLoadNm
      );

      id += (h / 6) * (k1.dId + 2 * k2.dId + 2 * k3.dId + k4.dId);
      iq += (h / 6) * (k1.dIq + 2 * k2.dIq + 2 * k3.dIq + k4.dIq);
      omegaM += (h / 6) * (k1.dOmegaM + 2 * k2.dOmegaM + 2 * k3.dOmegaM + k4.dOmegaM);
      thetaE += (h / 6) * (k1.dThetaE + 2 * k2.dThetaE + 2 * k3.dThetaE + k4.dThetaE);

      if (params.controlMode !== 'open_loop_vdq') {
        const we = p * omegaM;
        let iTorqCmd = 0;
        if (cStep.cmd.iqRefA !== undefined && Number.isFinite(cStep.cmd.iqRefA)) {
          iTorqCmd = cStep.cmd.iqRefA;
        } else {
          const wRef = ((cStep.cmd.speedRefRpm ?? 0) * 2 * Math.PI) / 60;
          const errW = wRef - omegaM;
          const unsatI = kpW * errW + intW;
          const satI = Math.max(-params.iMaxA, Math.min(params.iMaxA, unsatI));
          // Anti-windup back-calculation
          intW += h * (kiW * errW + 0.25 * bwW * (satI - unsatI));
          iTorqCmd = satI;
        }
        const tgt = computeMtpaAndFieldWeakeningTarget(iTorqCmd, we, cStep.cmd.vBusV, params);
        const errD = tgt.idRefA - id;
        const errQ = tgt.iqRefA - iq;
        // Back-calculation anti-windup on voltage circle clamp
        const awD = cStep.vLimited ? (cStep.vd - cStep.vdCmd) * 0.5 : 0;
        const awQ = cStep.vLimited ? (cStep.vq - cStep.vqCmd) * 0.5 : 0;
        intId += h * (kiD * errD + bwI * awD);
        intIq += h * (kiQ * errQ + bwI * awQ);
      }
    }
  }

  // Analytical steady-state parity check at final state
  const weEnd = p * omegaM;
  const analyticalVdV = rs * id - weEnd * lq * iq;
  const analyticalVqV = rs * iq + weEnd * (ld * id + psiF);
  const analyticalTeNm = calcDynamicPmsmTorque(id, iq, p, psiF, ld, lq);
  const endRhs = rhs(id, iq, omegaM, lastVd, lastVq, lastTload);

  if (voltageLimitHits > 0) {
    warnings.push(`仿真中有 ${voltageLimitHits} 个采样点触发 SVPWM 电压圆限幅 (|Vdq| ≥ Vbus/√3)。`);
  }
  if (currentLimitHits > 0) {
    warnings.push(`仿真中有 ${currentLimitHits} 个采样点触发相电流上限限幅 (|I| ≥ ${params.iMaxA.toFixed(1)} A)。`);
  }

  return {
    provenance: 'synthetic_assumed_uncalibrated',
    sourceModel: 'dynamic_pmsm_dq_rk4',
    warnings,
    dtInternalSec: h,
    substepsPerOutput: substeps,
    time,
    thetaE: thetaEArr,
    omegaM: omegaMArr,
    nRpm: nRpmArr,
    idA: idArr,
    iqA: iqArr,
    vdV: vdArr,
    vqV: vqArr,
    iaA: iaArr,
    ibA: ibArr,
    icA: icArr,
    teNm: teArr,
    tLoadNm: tLoadArr,
    vBusV: vBusArr,
    mNorm: mNormArr,
    voltageLimited: voltLimArr,
    currentLimited: currLimArr,
    quadrantMode,
    peakAbsCurrentA,
    peakAbsTorqueNm,
    peakSpeedRpm,
    minSpeedRpm,
    voltageLimitHits,
    currentLimitHits,
    steadyCheck: {
      finalSpeedRpm: (omegaM * 60) / (2 * Math.PI),
      finalIdA: id,
      finalIqA: iq,
      analyticalTeNm,
      analyticalVdV,
      analyticalVqV,
      simTeNm: teArr[nOut - 1],
      simVdV: lastVd,
      simVqV: lastVq,
      torqueDiffNm: Math.abs(teArr[nOut - 1] - analyticalTeNm),
      voltageDiffV: Math.hypot(lastVd - analyticalVdV, lastVq - analyticalVqV),
      diDtNormAps: Math.hypot(endRhs.dId, endRhs.dIq),
      dOmegaDtNormRadS2: Math.abs(endRhs.dOmegaM),
    },
  };
}

function makeDynChannel(
  id: string,
  name: string,
  unit: string,
  color: string,
  t: Float64Array,
  vSrc: Float64Array,
  fs: number,
  dt: number,
  meta: ReturnType<typeof analyzeSamplingQuality>
): WaveformChannel {
  const v = new Float32Array(vSrc.length);
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < vSrc.length; i++) {
    const val = vSrc[i];
    v[i] = val;
    if (Number.isFinite(val)) {
      if (val < mn) mn = val;
      if (val > mx) mx = val;
    }
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
    isMath: false,
    channelKind: 'computed',
    derivedBadge: 'SIM dq',
    sourceChannelIds: [],
    fs,
    dt,
    metadata: {
      ...meta,
      gapIndices: [...meta.gapIndices],
      signalNanCount: 0,
      dataProvenance: 'synthetic_assumed_uncalibrated',
      sourceModel: 'dynamic_pmsm_dq_rk4',
    },
  };
}

export function buildDynamicPmsmScopeTab(result: DynamicPmsmResult, label = 'Dynamic_PMSM_dq'): TabState | null {
  const n = result.time.length;
  if (n < 2) return null;
  const meta = analyzeSamplingQuality(result.time);
  const dt = meta.medianDt ?? meta.nominalDt ?? (result.time[n - 1] - result.time[0]) / (n - 1);
  const fs = dt > 0 ? 1 / dt : 1000;
  meta.dataProvenance = 'synthetic_assumed_uncalibrated';
  meta.sourceModel = 'dynamic_pmsm_dq_rk4';

  const channels: Record<string, WaveformChannel> = {
    ch_ia: makeDynChannel('ch_ia', 'Ia (sim dq)', 'A', '#facc15', result.time, result.iaA, fs, dt, meta),
    ch_ib: makeDynChannel('ch_ib', 'Ib (sim dq)', 'A', '#22d3ee', result.time, result.ibA, fs, dt, meta),
    ch_ic: makeDynChannel('ch_ic', 'Ic (sim dq)', 'A', '#4ade80', result.time, result.icA, fs, dt, meta),
    ch_id: makeDynChannel('ch_id', 'Id (sim dq)', 'A', '#60a5fa', result.time, result.idA, fs, dt, meta),
    ch_iq: makeDynChannel('ch_iq', 'Iq (sim dq)', 'A', '#f472b6', result.time, result.iqA, fs, dt, meta),
    ch_n: makeDynChannel('ch_n', 'Speed (sim)', 'RPM', '#a78bfa', result.time, result.nRpm, fs, dt, meta),
    ch_te: makeDynChannel('ch_te', 'Te (sim)', 'Nm', '#fb923c', result.time, result.teNm, fs, dt, meta),
    ch_tload: makeDynChannel('ch_tload', 'T_load', 'Nm', '#94a3b8', result.time, result.tLoadNm, fs, dt, meta),
  };

  return {
    id: `dyno_dyn_pmsm_${Date.now()}`,
    fileName: `${label}_SYNTHETIC_UNCALIBRATED.csv`,
    channels,
    drawOrder: ['ch_ia', 'ch_ib', 'ch_ic', 'ch_id', 'ch_iq', 'ch_n', 'ch_te', 'ch_tload'],
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

export function buildDynamicPmsmCsv(result: DynamicPmsmResult): string {
  const lines = [
    '# WAVEFORM_PROVENANCE=MODEL_SYNTHETIC_DYNAMIC_ASSUMED_UNCALIBRATED',
    '# SOURCE_MODEL=dynamic_pmsm_dq_rk4',
    'Time_s,n_rpm,Id_A,Iq_A,Vd_V,Vq_V,Ia_A,Ib_A,Ic_A,Te_Nm,T_load_Nm,Vbus_V,m_norm,voltage_limited,current_limited,quadrant',
  ];
  for (let i = 0; i < result.time.length; i++) {
    lines.push(
      [
        result.time[i].toFixed(6),
        result.nRpm[i].toFixed(2),
        result.idA[i].toFixed(4),
        result.iqA[i].toFixed(4),
        result.vdV[i].toFixed(4),
        result.vqV[i].toFixed(4),
        result.iaA[i].toFixed(4),
        result.ibA[i].toFixed(4),
        result.icA[i].toFixed(4),
        result.teNm[i].toFixed(5),
        result.tLoadNm[i].toFixed(5),
        result.vBusV[i].toFixed(3),
        result.mNorm[i].toFixed(4),
        result.voltageLimited[i],
        result.currentLimited[i],
        result.quadrantMode[i],
      ].join(',')
    );
  }
  return lines.join('\n');
}
