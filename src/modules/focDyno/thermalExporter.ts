/**
 * FOC DynoLab V2 - 6-MOS Transient Waveform Synthesizer
 * Generates Time,Ia,Ib,Ic,Vbus waveforms (sinusoidal or stalled single-phase DC bias)
 * with strictly aligned SVPWM modulation depth (mCmd & mNormCmd) and 4-quadrant PF angle.
 */

import { MotorParams, SinglePointResult, solveSinglePoint } from './motorPhysics';

export interface ThermalExportPoint {
  vMeasV: number;
  iBusA: number;
  nRpm: number;
  tAmbC: number;
  fsHz: number;
  durationS: number;
}

export interface WaveformSample {
  timeS: number;
  iaA: number;
  ibA: number;
  icA: number;
  vBusV: number;
}

export interface SixMosSummary {
  phaseIaMapping: string;
  phaseIbMapping: string;
  phaseIcMapping: string;
  vBusCapV: number;
  tAmbC: number;
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
}

export const MAX_EXPORT_SAMPLES = 200000;

export function synthesizeSixMosWaveform(
  exportPt: ThermalExportPoint,
  params: MotorParams
): SynthesizedWaveform {
  const res = solveSinglePoint(exportPt.vMeasV, exportPt.iBusA, exportPt.nRpm, params);

  const fsHz = Math.max(1000, Math.min(200000, Math.round(exportPt.fsHz)));
  const durationS = Math.max(0.02, Math.min(5.0, exportPt.durationS));
  const requestedSamples = Math.max(2, Math.round(fsHz * durationS));
  const clampedByLimit = requestedSamples > MAX_EXPORT_SAMPLES;
  const totalSamples = Math.min(MAX_EXPORT_SAMPLES, requestedSamples);

  if (res.mode === 'invalid_bus' || res.mode === 'regen_limit' || !Number.isFinite(res.iqA)) {
    const error =
      res.mode === 'invalid_bus'
        ? `母线压降异常：V_meas (${exportPt.vMeasV.toFixed(2)}V) - I_bus·R_line <= 0.1V，无法合成波形。`
        : `该工况已超出发电回馈最大制动功率极限 Eq²/(4·Rs) (Δ < 0)，无法反推相电流，已阻止导出全零波形。`;

    return {
      samples: [],
      csvContent: '',
      pointResult: res,
      error,
      clampedByLimit: false,
      summary: {
        phaseIaMapping: 'Ia (CSV 列: Ia)',
        phaseIbMapping: 'Ib (CSV 列: Ib)',
        phaseIcMapping: 'Auto: Ic = -(Ia + Ib) 或 Ic 列',
        vBusCapV: Number.NaN,
        tAmbC: exportPt.tAmbC,
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

  const samples: WaveformSample[] = new Array(totalSamples);
  const lines: string[] = ['Time,Ia,Ib,Ic,Vbus'];

  for (let i = 0; i < totalSamples; i++) {
    const t = i / fsHz;
    let ia: number;
    let ib: number;
    let ic: number;
    if (isStall) {
      ia = iq;
      ib = -0.5 * iq;
      ic = -0.5 * iq;
    } else {
      const theta = omegaE * t;
      ia = iq * Math.sin(theta);
      ib = iq * Math.sin(theta - (2 * Math.PI) / 3);
      ic = -(ia + ib);
    }

    samples[i] = {
      timeS: t,
      iaA: ia,
      ibA: ib,
      icA: ic,
      vBusV: vBus,
    };
    lines.push(`${t.toFixed(6)},${ia.toFixed(5)},${ib.toFixed(5)},${ic.toFixed(5)},${vBus.toFixed(4)}`);
  }

  const summary: SixMosSummary = {
    phaseIaMapping: 'Ia (CSV 列: Ia)',
    phaseIbMapping: 'Ib (CSV 列: Ib)',
    phaseIcMapping: 'Auto: Ic = -(Ia + Ib) 或 Ic 列',
    vBusCapV: vBus,
    tAmbC: exportPt.tAmbC,
    modulationNote: '可直接一键注入本软件「MOS Thermal → BLDC FOC 6-MOS」执行结温仿真',
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
  };
}
