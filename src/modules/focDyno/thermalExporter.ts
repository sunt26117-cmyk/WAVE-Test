/**
 * FOC DynoLab V2 - 6-MOS Transient Waveform Synthesizer
 * Generates Time,Ia,Ib,Ic,Vbus (and optional Duty_A,Duty_B,Duty_C for SVPWM/DPWM1)
 * with strictly aligned SVPWM modulation depth (mCmd & mNormCmd) and 4-quadrant PF angle.
 */

import { MotorParams, SinglePointResult, solveSinglePoint } from './motorPhysics';

export type ExporterModulationMode = 'SVPWM' | 'DPWM1';

export interface ThermalExportPoint {
  vMeasV: number;
  iBusA: number;
  nRpm: number;
  tAmbC: number;
  fsHz: number;
  durationS: number;
  modulation?: ExporterModulationMode;
  includeDuty?: boolean;
}

export interface WaveformSample {
  timeS: number;
  iaA: number;
  ibA: number;
  icA: number;
  vBusV: number;
  da?: number;
  db?: number;
  dc?: number;
}

export interface SixMosSummary {
  phaseIaMapping: string;
  phaseIbMapping: string;
  phaseIcMapping: string;
  vBusCapV: number;
  tAmbC: number;
  modulationMode: ExporterModulationMode;
  includeDuty: boolean;
  modulationNote: string;
  feHz: number;
  iqPeakA: number;
  iphRmsA: number;
  isStall: boolean;
  mMotor: number;
  mNormMotor: number;
  mCmd: number;
  mNormCmd: number;
  phiDeg: number;
  phiCmdDeg: number;
}

export interface SynthesizedWaveform {
  samples: WaveformSample[];
  csvContent: string;
  pointResult: SinglePointResult;
  summary: SixMosSummary;
  error: string | null;
  clampedByLimit: boolean;
  requestedSamples: number;
  exportedSamples: number;
  requestedDurationS: number;
  actualDurationS: number;
}

export const MAX_EXPORT_SAMPLES = 200000;

function computeDutySample(
  angRad: number,
  mNorm: number,
  modulation: ExporterModulationMode
): { da: number; db: number; dc: number } {
  const vAmp = Math.min(1.0, Math.max(0.0, mNorm)) / Math.sqrt(3);
  const twoPi3 = (2 * Math.PI) / 3;
  const va = vAmp * Math.sin(angRad);
  const vb = vAmp * Math.sin(angRad - twoPi3);
  const vc = -(va + vb);

  let vCm = 0;
  if (modulation === 'DPWM1') {
    if (vAmp > 1e-6) {
      const aA = Math.abs(va);
      const aB = Math.abs(vb);
      const aC = Math.abs(vc);
      let vDom = va;
      if (aB >= aA && aB >= aC) vDom = vb;
      else if (aC >= aA && aC >= aB) vDom = vc;
      vCm = vDom >= 0 ? 0.5 - vDom : -0.5 - vDom;
    }
  } else {
    const vMax = Math.max(va, vb, vc);
    const vMin = Math.min(va, vb, vc);
    vCm = -0.5 * (vMax + vMin);
  }

  const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
  return {
    da: clamp01(0.5 + va + vCm),
    db: clamp01(0.5 + vb + vCm),
    dc: clamp01(0.5 + vc + vCm),
  };
}

export function synthesizeSixMosWaveform(
  exportPt: ThermalExportPoint,
  params: MotorParams
): SynthesizedWaveform {
  const res = solveSinglePoint(exportPt.vMeasV, exportPt.iBusA, exportPt.nRpm, params);
  const modulation: ExporterModulationMode = exportPt.modulation === 'DPWM1' ? 'DPWM1' : 'SVPWM';
  const includeDuty = Boolean(exportPt.includeDuty);

  const fsHz = Math.max(1000, Math.min(200000, Math.round(exportPt.fsHz)));
  const durationS = Math.max(0.02, Math.min(20.0, exportPt.durationS));
  const requestedSamples = Math.max(2, Math.round(fsHz * durationS));
  const clampedByLimit = requestedSamples > MAX_EXPORT_SAMPLES;
  const totalSamples = Math.min(MAX_EXPORT_SAMPLES, requestedSamples);

  const isOverMod =
    res.alerts.cmdSat ||
    res.alerts.motorSat ||
    (Number.isFinite(res.mNormCmd) && res.mNormCmd > 1.0 + 1e-6) ||
    (Number.isFinite(res.mNormMotor) && res.mNormMotor > 1.0 + 1e-6);

  if (res.mode === 'invalid_bus' || res.mode === 'regen_limit' || isOverMod || !Number.isFinite(res.iqA)) {
    const mShow = Number.isFinite(res.mNormCmd) ? res.mNormCmd : res.mNormMotor;
    const error =
      res.mode === 'invalid_bus'
        ? `母线压降异常：V_meas (${exportPt.vMeasV.toFixed(2)}V) - I_bus·R_line <= 0.1V，无法合成波形。`
        : isOverMod
        ? `工况超调：调制深度 m_norm = ${Number.isFinite(mShow) ? mShow.toFixed(3) : '--'} > 1.0，超出线性 SVPWM 能力（电压饱和），无法导出物理可信的波形。`
        : `该工况已超出发电回馈最大制动功率极限 Eq²/(4·Rs) (Δ < 0)，无法反推相电流，已阻止导出全零波形。`;

    return {
      samples: [],
      csvContent: '',
      pointResult: res,
      error,
      clampedByLimit: false,
      requestedSamples,
      exportedSamples: 0,
      requestedDurationS: durationS,
      actualDurationS: 0,
      summary: {
        phaseIaMapping: 'Ia (CSV 列: Ia)',
        phaseIbMapping: 'Ib (CSV 列: Ib)',
        phaseIcMapping: 'Auto: Ic = -(Ia + Ib) 或 Ic 列',
        vBusCapV: Number.NaN,
        tAmbC: exportPt.tAmbC,
        modulationMode: modulation,
        includeDuty,
        modulationNote: '支持直接一键导入本软件「MOS Thermal → 4. BLDC FOC 6-MOS」评估（SVPWM / DPWM1）',
        feHz: res.feHz,
        iqPeakA: Number.NaN,
        iphRmsA: Number.NaN,
        isStall: Math.abs(exportPt.nRpm) < 1e-6,
        mMotor: Number.NaN,
        mNormMotor: Number.NaN,
        mCmd: Number.NaN,
        mNormCmd: Number.NaN,
        phiDeg: Number.NaN,
        phiCmdDeg: Number.NaN,
      },
    };
  }

  const iq = res.iqA;
  const vBus = res.vBusCapV;
  const isStall = Math.abs(exportPt.nRpm) < 1e-6;
  const omegaE = (exportPt.nRpm >= 0 ? 1 : -1) * 2 * Math.PI * res.feHz;
  const phiCmdRad = Number.isFinite(res.phiCmdDeg) ? (res.phiCmdDeg * Math.PI) / 180 : 0;
  const mNormCmd = Number.isFinite(res.mNormCmd) ? res.mNormCmd : 0;

  const samples: WaveformSample[] = new Array(totalSamples);
  const lines: string[] = [
    includeDuty ? 'Time,Ia,Ib,Ic,Vbus,Duty_A,Duty_B,Duty_C' : 'Time,Ia,Ib,Ic,Vbus',
  ];

  for (let i = 0; i < totalSamples; i++) {
    const t = i / fsHz;
    let ia: number;
    let ib: number;
    let ic: number;
    let theta: number;
    if (isStall) {
      theta = Math.PI / 2;
      ia = iq;
      ib = -0.5 * iq;
      ic = -0.5 * iq;
    } else {
      theta = omegaE * t;
      ia = iq * Math.sin(theta);
      ib = iq * Math.sin(theta - (2 * Math.PI) / 3);
      ic = -(ia + ib);
    }

    if (includeDuty) {
      const iqPhaseShift = iq < 0 ? Math.PI : 0;
      const { da, db, dc } = computeDutySample(theta + iqPhaseShift + phiCmdRad, mNormCmd, modulation);
      samples[i] = { timeS: t, iaA: ia, ibA: ib, icA: ic, vBusV: vBus, da, db, dc };
      lines.push(
        `${t.toFixed(9)},${ia.toFixed(5)},${ib.toFixed(5)},${ic.toFixed(5)},${vBus.toFixed(4)},${da.toFixed(5)},${db.toFixed(5)},${dc.toFixed(5)}`
      );
    } else {
      samples[i] = { timeS: t, iaA: ia, ibA: ib, icA: ic, vBusV: vBus };
      lines.push(`${t.toFixed(9)},${ia.toFixed(5)},${ib.toFixed(5)},${ic.toFixed(5)},${vBus.toFixed(4)}`);
    }
  }

  const actualDurationS = totalSamples > 1 ? (totalSamples - 1) / fsHz : 0;
  const summary: SixMosSummary = {
    phaseIaMapping: 'Ia (CSV 列: Ia)',
    phaseIbMapping: 'Ib (CSV 列: Ib)',
    phaseIcMapping: 'Auto: Ic = -(Ia + Ib) 或 Ic 列',
    vBusCapV: vBus,
    tAmbC: exportPt.tAmbC,
    modulationMode: modulation,
    includeDuty,
    modulationNote: includeDuty
      ? `已生成 ${modulation} Duty_A/B/C 实测占空比序列，可直接驱动 6-MOS 损耗计算`
      : '可直接一键注入本软件「MOS Thermal → BLDC FOC 6-MOS」执行结温仿真',
    feHz: res.feHz,
    iqPeakA: iq,
    iphRmsA: Number.isFinite(res.iphRmsA) ? res.iphRmsA : 0,
    isStall,
    mMotor: Number.isFinite(res.mMotor) ? res.mMotor : 0,
    mNormMotor: Number.isFinite(res.mNormMotor) ? res.mNormMotor : 0,
    mCmd: Number.isFinite(res.mCmd) ? res.mCmd : 0,
    mNormCmd: Number.isFinite(res.mNormCmd) ? res.mNormCmd : 0,
    phiDeg: Number.isFinite(res.phiDeg) ? res.phiDeg : 0,
    phiCmdDeg: Number.isFinite(res.phiCmdDeg) ? res.phiCmdDeg : 0,
  };

  return {
    samples,
    csvContent: lines.join('\n'),
    pointResult: res,
    summary,
    error: null,
    clampedByLimit,
    requestedSamples,
    exportedSamples: totalSamples,
    requestedDurationS: durationS,
    actualDurationS,
  };
}
