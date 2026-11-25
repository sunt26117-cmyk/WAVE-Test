/**
 * Waveform Viewer Pro - Clarke & Park Transforms
 * Engineering transforms for three-phase motor drive and power electronics analysis.
 */

import { WaveformChannel } from '../types/models';
import { estimateElectricalAngleFromAlphaBeta } from './motorAnalysis';
import {
  alignChannelsToCommonTimebase,
  parsePhysicalUnit,
  resolveCompatibleSiGroupScale,
} from './timeSync';

export interface ClarkeResult {
  alpha: Float32Array;
  beta: Float32Array;
  zero: Float32Array;
}

export interface ParkResult {
  d: Float32Array;
  q: Float32Array;
}

/**
 * Computes standard Clarke Transform:
 *   alpha = (2/3) * Ua - (1/3) * Ub - (1/3) * Uc
 *   beta  = (1 / sqrt(3)) * (Ub - Uc)
 *   zero  = (1/3) * (Ua + Ub + Uc)
 */
export function computeClarke(
  ua: Float32Array,
  ub: Float32Array,
  uc: Float32Array
): ClarkeResult {
  const n = ua.length;
  if (ub.length !== n || uc.length !== n) {
    throw new Error('Phase arrays Ua, Ub, Uc must have identical lengths.');
  }

  const alpha = new Float32Array(n);
  const beta = new Float32Array(n);
  const zero = new Float32Array(n);

  const invSqrt3 = 1.0 / Math.sqrt(3.0);

  for (let i = 0; i < n; i++) {
    const a = ua[i];
    const b = ub[i];
    const c = uc[i];
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) {
      alpha[i] = Number.NaN;
      beta[i] = Number.NaN;
      zero[i] = Number.NaN;
      continue;
    }

    alpha[i] = (2.0 / 3.0) * a - (1.0 / 3.0) * b - (1.0 / 3.0) * c;
    beta[i] = invSqrt3 * (b - c);
    zero[i] = (1.0 / 3.0) * (a + b + c);
  }

  return { alpha, beta, zero };
}

/**
 * Computes Park Transform:
 *   d =  alpha * cos(theta) + beta * sin(theta)
 *   q = -alpha * sin(theta) + beta * cos(theta)
 *
 * @param alpha Float32Array
 * @param beta Float32Array
 * @param theta Float32Array of electrical rotor angle (in radians)
 */
export function computePark(
  alpha: Float32Array,
  beta: Float32Array,
  theta: Float32Array
): ParkResult {
  const n = alpha.length;
  if (beta.length !== n || theta.length !== n) {
    throw new Error('Alpha, Beta, and Theta arrays must have identical lengths.');
  }

  const d = new Float32Array(n);
  const q = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const a = alpha[i];
    const b = beta[i];
    const th = theta[i];
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(th)) {
      d[i] = Number.NaN;
      q[i] = Number.NaN;
      continue;
    }

    const cosTh = Math.cos(th);
    const sinTh = Math.sin(th);

    d[i] = a * cosTh + b * sinTh;
    q[i] = -a * sinTh + b * cosTh;
  }

  return { d, q };
}

/**
 * Computes Instantaneous Three-Phase Power:
 *   P(t) = Ua(t)*Ia(t) + Ub(t)*Ib(t) + Uc(t)*Ic(t)
 */
export function computeInstantaneousPower(
  ua: Float32Array,
  ub: Float32Array,
  uc: Float32Array,
  ia: Float32Array,
  ib: Float32Array,
  ic: Float32Array
): Float32Array {
  const n = ua.length;
  if (
    ub.length !== n ||
    uc.length !== n ||
    ia.length !== n ||
    ib.length !== n ||
    ic.length !== n
  ) {
    throw new Error('All 6 voltage and current arrays must have identical lengths.');
  }

  const power = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const va = ua[i];
    const vb = ub[i];
    const vc = uc[i];
    const ca = ia[i];
    const cb = ib[i];
    const cc = ic[i];
    if (
      !Number.isFinite(va) ||
      !Number.isFinite(vb) ||
      !Number.isFinite(vc) ||
      !Number.isFinite(ca) ||
      !Number.isFinite(cb) ||
      !Number.isFinite(cc)
    ) {
      power[i] = Number.NaN;
      continue;
    }
    power[i] = va * ca + vb * cb + vc * cc;
  }
  return power;
}

function scaleFloat32(arr: Float32Array, scale: number): Float32Array {
  if (Math.abs(scale - 1) <= 1e-12) return arr;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    out[i] = Number.isFinite(arr[i]) ? arr[i] * scale : Number.NaN;
  }
  return out;
}

export interface ChannelClarkeResult {
  valid: boolean;
  invalidReason: string | null;
  unit: string;
  time: Float64Array;
  alpha: Float32Array;
  beta: Float32Array;
  zero: Float32Array;
  resampled: boolean;
  warnings: string[];
}

export function computeClarkeFromChannels(
  chA: WaveformChannel,
  chB: WaveformChannel,
  chC: WaveformChannel
): ChannelClarkeResult {
  const unitInfo = resolveCompatibleSiGroupScale([chA, chB, chC]);
  if (!unitInfo.valid) {
    return {
      valid: false,
      invalidReason: unitInfo.reason,
      unit: unitInfo.baseUnit,
      time: new Float64Array(0),
      alpha: new Float32Array(0),
      beta: new Float32Array(0),
      zero: new Float32Array(0),
      resampled: false,
      warnings: [unitInfo.reason || 'Incompatible units'],
    };
  }
  const synced = alignChannelsToCommonTimebase([chA, chB, chC]);
  if (!synced.valid || synced.time.length < 2) {
    return {
      valid: false,
      invalidReason: synced.invalidReason || 'Timebase alignment failed',
      unit: unitInfo.baseUnit,
      time: new Float64Array(0),
      alpha: new Float32Array(0),
      beta: new Float32Array(0),
      zero: new Float32Array(0),
      resampled: synced.resampled,
      warnings: synced.warnings,
    };
  }
  const { alpha, beta, zero } = computeClarke(
    scaleFloat32(synced.values[0], unitInfo.scales[0]),
    scaleFloat32(synced.values[1], unitInfo.scales[1]),
    scaleFloat32(synced.values[2], unitInfo.scales[2])
  );
  return {
    valid: true,
    invalidReason: null,
    unit: unitInfo.baseUnit,
    time: synced.time,
    alpha,
    beta,
    zero,
    resampled: synced.resampled,
    warnings: unitInfo.normalizedNote ? [unitInfo.normalizedNote, ...synced.warnings] : synced.warnings,
  };
}

export interface ChannelParkResult {
  valid: boolean;
  invalidReason: string | null;
  frameType: 'rotor_measured' | 'self_aligned_vector';
  unit: string;
  time: Float64Array;
  d: Float32Array;
  q: Float32Array;
  theta: Float32Array;
  resampled: boolean;
  warnings: string[];
}

export function computeParkFromChannels(
  alphaCh: WaveformChannel,
  betaCh: WaveformChannel,
  thetaCh?: WaveformChannel,
  offsetRad = 0
): ChannelParkResult {
  const unitInfo = resolveCompatibleSiGroupScale([alphaCh, betaCh]);
  if (!unitInfo.valid) {
    return {
      valid: false,
      invalidReason: unitInfo.reason,
      frameType: thetaCh ? 'rotor_measured' : 'self_aligned_vector',
      unit: unitInfo.baseUnit,
      time: new Float64Array(0),
      d: new Float32Array(0),
      q: new Float32Array(0),
      theta: new Float32Array(0),
      resampled: false,
      warnings: [unitInfo.reason || 'Incompatible α/β units'],
    };
  }

  const warnings: string[] = [];
  if (unitInfo.normalizedNote) warnings.push(unitInfo.normalizedNote);

  let toRad = 1;
  if (thetaCh) {
    const rawUnit = (thetaCh.unit || '').trim();
    if (!rawUnit || rawUnit === '1' || rawUnit.toLowerCase() === 'pu') {
      warnings.push(`角度通道 "${thetaCh.name}" 未显式标注角度单位，已按弧度 (rad) 处理。`);
    } else {
      const angUnit = parsePhysicalUnit(rawUnit);
      if (!angUnit || (angUnit.domain !== 'angle_deg' && angUnit.domain !== 'angle_rad')) {
        const msg = `角度通道 "${thetaCh.name}" 单位 "${thetaCh.unit}" 非有效角度单位（仅支持 rad / deg / ° 或无量纲弧度），已拒绝 Park 变换。`;
        return {
          valid: false,
          invalidReason: msg,
          frameType: 'rotor_measured',
          unit: unitInfo.baseUnit,
          time: new Float64Array(0),
          d: new Float32Array(0),
          q: new Float32Array(0),
          theta: new Float32Array(0),
          resampled: false,
          warnings: [msg],
        };
      }
      toRad = angUnit.domain === 'angle_deg' ? Math.PI / 180 : 1;
    }
  } else {
    warnings.push(
      '未提供独立转子角度 θ(t) 通道：当前使用 Clarke α/β 瞬间合成矢量自对齐角 atan2(β, α) + offset（d_vec/q_vec），该变换会强制 q_vec≈0，不等同于真实电机转子 d/q 轴分量。'
    );
  }

  const list = thetaCh ? [alphaCh, betaCh, thetaCh] : [alphaCh, betaCh];
  const synced = alignChannelsToCommonTimebase(list);
  if (!synced.valid || synced.time.length < 2) {
    return {
      valid: false,
      invalidReason: synced.invalidReason || 'Timebase alignment failed',
      frameType: thetaCh ? 'rotor_measured' : 'self_aligned_vector',
      unit: unitInfo.baseUnit,
      time: new Float64Array(0),
      d: new Float32Array(0),
      q: new Float32Array(0),
      theta: new Float32Array(0),
      resampled: synced.resampled,
      warnings: [...warnings, ...synced.warnings],
    };
  }
  const aArr = scaleFloat32(synced.values[0], unitInfo.scales[0]);
  const bArr = scaleFloat32(synced.values[1], unitInfo.scales[1]);
  let theta: Float32Array;
  if (thetaCh) {
    theta = new Float32Array(synced.values[2].length);
    for (let i = 0; i < theta.length; i++) {
      theta[i] = Number.isFinite(synced.values[2][i])
        ? synced.values[2][i] * toRad + offsetRad
        : Number.NaN;
    }
  } else {
    theta = estimateElectricalAngleFromAlphaBeta(aArr, bArr, offsetRad);
  }
  const { d, q } = computePark(aArr, bArr, theta);
  return {
    valid: true,
    invalidReason: null,
    frameType: thetaCh ? 'rotor_measured' : 'self_aligned_vector',
    unit: unitInfo.baseUnit,
    time: synced.time,
    d,
    q,
    theta,
    resampled: synced.resampled,
    warnings: [...warnings, ...synced.warnings],
  };
}

export interface ChannelPowerResult {
  valid: boolean;
  invalidReason: string | null;
  time: Float64Array;
  power: Float32Array;
  resampled: boolean;
  siScaled: boolean;
  warnings: string[];
}

export function computeInstantaneousPowerFromChannels(
  voltageChannels: WaveformChannel[],
  currentChannels: WaveformChannel[]
): ChannelPowerResult {
  if (
    voltageChannels.length === 0 ||
    voltageChannels.length !== currentChannels.length ||
    (voltageChannels.length !== 1 && voltageChannels.length !== 3)
  ) {
    return {
      valid: false,
      invalidReason: '功率计算需要成对的 1 相 (1V+1I) 或 3 相 (3V+3I) 通道。',
      time: new Float64Array(0),
      power: new Float32Array(0),
      resampled: false,
      siScaled: false,
      warnings: [],
    };
  }

  const vScales: number[] = [];
  const iScales: number[] = [];
  for (const ch of voltageChannels) {
    const u = parsePhysicalUnit(ch.unit);
    if (u && u.domain !== 'voltage') {
      return {
        valid: false,
        invalidReason: `电压通道 "${ch.name}" 单位 "${ch.unit}" 不是电压量纲。`,
        time: new Float64Array(0),
        power: new Float32Array(0),
        resampled: false,
        siScaled: false,
        warnings: [],
      };
    }
    vScales.push(u ? u.scale : 1);
  }
  for (const ch of currentChannels) {
    const u = parsePhysicalUnit(ch.unit);
    if (u && u.domain !== 'current') {
      return {
        valid: false,
        invalidReason: `电流通道 "${ch.name}" 单位 "${ch.unit}" 不是电流量纲。`,
        time: new Float64Array(0),
        power: new Float32Array(0),
        resampled: false,
        siScaled: false,
        warnings: [],
      };
    }
    iScales.push(u ? u.scale : 1);
  }

  const synced = alignChannelsToCommonTimebase([...voltageChannels, ...currentChannels]);
  if (!synced.valid || synced.time.length < 2) {
    return {
      valid: false,
      invalidReason: synced.invalidReason || '电压与电流通道未能对齐至有效公共时间轴。',
      time: new Float64Array(0),
      power: new Float32Array(0),
      resampled: synced.resampled,
      siScaled: false,
      warnings: synced.warnings,
    };
  }

  const siScaled = [...vScales, ...iScales].some((s) => Math.abs(s - 1) > 1e-12);
  let power: Float32Array;
  if (voltageChannels.length === 1) {
    const vArr = synced.values[0];
    const iArr = synced.values[1];
    power = new Float32Array(synced.time.length);
    for (let k = 0; k < synced.time.length; k++) {
      const vv = vArr[k];
      const iv = iArr[k];
      power[k] = Number.isFinite(vv) && Number.isFinite(iv) ? vv * vScales[0] * (iv * iScales[0]) : Number.NaN;
    }
  } else {
    power = computeInstantaneousPower(
      scaleFloat32(synced.values[0], vScales[0]),
      scaleFloat32(synced.values[1], vScales[1]),
      scaleFloat32(synced.values[2], vScales[2]),
      scaleFloat32(synced.values[3], iScales[0]),
      scaleFloat32(synced.values[4], iScales[1]),
      scaleFloat32(synced.values[5], iScales[2])
    );
  }

  return {
    valid: true,
    invalidReason: null,
    time: synced.time,
    power,
    resampled: synced.resampled,
    siScaled,
    warnings: synced.warnings,
  };
}
