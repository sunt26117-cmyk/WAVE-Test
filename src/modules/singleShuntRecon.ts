/**
 * Waveform Viewer Pro - Single-Shunt SVPWM DC-Bus Current Reconstruction
 * Reconstructs 3-phase currents (Ia, Ib, Ic) from a single DC-link shunt current trace (Idc)
 * paired with 3-phase duty cycles or gate signals (Da, Db, Dc), explicitly flagging active-vector
 * blind zones where window duration (ΔD * Tsw) < T_min.
 */

import { WaveformChannel } from '../types/models';
import { parseSiUnitScale } from './thermalEngine';
import { alignChannelsToCommonTimebase } from './timeSync';

export interface SingleShuntReconOptions {
  fswHz?: number;
  tMinSec?: number;
  tStart?: number;
  tEnd?: number;
}

export interface SingleShuntReconResult {
  valid: boolean;
  mode: 'switching_states' | 'continuous_duty';
  time: Float64Array;
  ia: Float32Array;
  ib: Float32Array;
  ic: Float32Array;
  blindMask: Uint8Array;
  blindCount: number;
  blindZoneFractionPct: number;
  warnings: string[];
}

function normalizeDutyArray(raw: Float32Array | Float64Array, unit: string, name: string, warnings: string[]): Float64Array {
  const n = raw.length;
  const out = new Float64Array(n);
  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
    const v = raw[i];
    if (Number.isFinite(v) && Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
  }
  const looksPercent = /%|pct/i.test(`${unit} ${name}`) || (maxAbs > 1.05 && maxAbs <= 105);
  const scale = looksPercent ? 0.01 : 1.0;
  if (looksPercent) {
    warnings.push(`占空比通道 "${name}" 按百分比 (0~100%) 自动归一化至 [0, 1]。`);
  } else if (maxAbs > 105) {
    warnings.push(`通道 "${name}" 幅值达 ${maxAbs.toFixed(1)}（非标准化 [0,1] 占空比），按逻辑门限归一化。`);
  }
  const threshScale = maxAbs > 105 ? 1 / maxAbs : scale;
  for (let i = 0; i < n; i++) {
    const v = raw[i] * threshScale;
    out[i] = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : Number.NaN;
  }
  return out;
}

export function reconstructSingleShuntPhaseCurrents(
  idcCh: WaveformChannel,
  daCh: WaveformChannel,
  dbCh: WaveformChannel,
  dcCh: WaveformChannel,
  opts?: SingleShuntReconOptions
): SingleShuntReconResult {
  const warnings: string[] = [];
  const emptyResult = (reason: string): SingleShuntReconResult => ({
    valid: false,
    mode: 'continuous_duty',
    time: new Float64Array(0),
    ia: new Float32Array(0),
    ib: new Float32Array(0),
    ic: new Float32Array(0),
    blindMask: new Uint8Array(0),
    blindCount: 0,
    blindZoneFractionPct: 0,
    warnings: [reason],
  });

  const aligned = alignChannelsToCommonTimebase(
    [idcCh, daCh, dbCh, dcCh],
    opts?.tStart,
    opts?.tEnd
  );
  if (!aligned.valid) {
    return emptyResult(aligned.invalidReason || '单电阻重构通道时间轴对齐失败 (Fail-Closed)。');
  }
  warnings.push(...aligned.warnings);

  const time = aligned.time;
  const n = time.length;
  if (n < 4) {
    return emptyResult('门控区间内有效采样点不足 4 点，无法执行单电阻相电流重构。');
  }

  let iScale = 1;
  try {
    iScale = parseSiUnitScale(idcCh.unit, 'A', idcCh.name, { strict: true });
  } catch (err: any) {
    return emptyResult(err?.message || `母线电流通道 "${idcCh.name}" 单位 "${idcCh.unit}" 无法解析为电流 (A/mA)。`);
  }
  if (!Number.isFinite(iScale) || iScale <= 0) {
    return emptyResult(`母线电流通道 "${idcCh.name}" 单位 "${idcCh.unit}" 无法解析为电流 (A/mA)。`);
  }

  const idcArr = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    idcArr[k] = aligned.values[0][k] * iScale;
  }

  const da = normalizeDutyArray(aligned.values[1], daCh.unit, daCh.name, warnings);
  const db = normalizeDutyArray(aligned.values[2], dbCh.unit, dbCh.name, warnings);
  const dc = normalizeDutyArray(aligned.values[3], dcCh.unit, dcCh.name, warnings);

  // Classify whether Da/Db/Dc are binary gate states {0,1} or continuous SVPWM duties [0..1]
  let binaryCount = 0;
  let finiteDutyCount = 0;
  for (let k = 0; k < n; k++) {
    const a = da[k], b = db[k], c = dc[k];
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) continue;
    finiteDutyCount++;
    const isBin = (v: number) => v <= 0.12 || v >= 0.88;
    if (isBin(a) && isBin(b) && isBin(c)) binaryCount++;
  }
  const isSwitchingStates = finiteDutyCount > 0 && binaryCount / finiteDutyCount >= 0.85;
  const mode: 'switching_states' | 'continuous_duty' = isSwitchingStates ? 'switching_states' : 'continuous_duty';

  const fswHz = Math.max(100, opts?.fswHz && Number.isFinite(opts.fswHz) ? opts.fswHz : 20000);
  const tSwSec = 1 / fswHz;
  const tMinSec = Math.max(0, opts?.tMinSec !== undefined && Number.isFinite(opts.tMinSec) ? opts.tMinSec : 1.5e-6);

  const ia = new Float32Array(n);
  const ib = new Float32Array(n);
  const ic = new Float32Array(n);
  const blindMask = new Uint8Array(n);

  let nonFiniteCount = 0;
  let blindCount = 0;

  if (mode === 'switching_states') {
    warnings.push(
      `识别为开关态门信号 (fsw=${(fswHz / 1e3).toFixed(1)}kHz, T_min=${(tMinSec * 1e6).toFixed(2)}µs)：在 1-高 / 2-高 非零矢量窗口解码两相电流并保持零矢量期间电流；脉宽 < T_min 区间标记为采样盲区。`
    );
    // Decode dwell runs of each 3-bit switching state
    const lastI = [0, 0, 0];
    let hasDecodedPhase = [false, false, false];
    let runStart = 0;
    const stateAt = (k: number): number => {
      if (!Number.isFinite(da[k]) || !Number.isFinite(db[k]) || !Number.isFinite(dc[k])) return -1;
      const sa = da[k] >= 0.5 ? 1 : 0;
      const sb = db[k] >= 0.5 ? 2 : 0;
      const sc = dc[k] >= 0.5 ? 4 : 0;
      return sa | sb | sc;
    };

    while (runStart < n) {
      const st = stateAt(runStart);
      let runEnd = runStart;
      while (runEnd + 1 < n && stateAt(runEnd + 1) === st) {
        runEnd++;
      }
      const dwellSec =
        (runEnd < n - 1 ? time[runEnd + 1] - time[runStart] : time[runEnd] - (runStart > 0 ? time[runStart - 1] : time[runStart]));
      const pop = st < 0 ? 0 : (st & 1) + ((st >> 1) & 1) + ((st >> 2) & 1);
      const activeRun = pop === 1 || pop === 2;
      const isBlindRun = activeRun && dwellSec < tMinSec;

      if (activeRun && !isBlindRun) {
        let sumIdc = 0;
        let cnt = 0;
        for (let k = runStart; k <= runEnd; k++) {
          if (Number.isFinite(idcArr[k])) {
            sumIdc += idcArr[k];
            cnt++;
          }
        }
        if (cnt > 0) {
          const iMeas = sumIdc / cnt;
          if (pop === 1) {
            const pIdx = st === 1 ? 0 : st === 2 ? 1 : 2;
            lastI[pIdx] = iMeas;
            hasDecodedPhase[pIdx] = true;
          } else {
            // pop === 2 -> only one phase is 0 => I_zeroPhase = -Idc
            const zeroIdx = (st & 1) === 0 ? 0 : (st & 2) === 0 ? 1 : 2;
            lastI[zeroIdx] = -iMeas;
            hasDecodedPhase[zeroIdx] = true;
          }
          // Close KCL once at least 2 phases are decoded
          const decodedCnt = (hasDecodedPhase[0] ? 1 : 0) + (hasDecodedPhase[1] ? 1 : 0) + (hasDecodedPhase[2] ? 1 : 0);
          if (decodedCnt >= 2) {
            if (!hasDecodedPhase[0]) {
              lastI[0] = -(lastI[1] + lastI[2]);
              hasDecodedPhase[0] = true;
            } else if (!hasDecodedPhase[1]) {
              lastI[1] = -(lastI[0] + lastI[2]);
              hasDecodedPhase[1] = true;
            } else if (!hasDecodedPhase[2]) {
              lastI[2] = -(lastI[0] + lastI[1]);
              hasDecodedPhase[2] = true;
            } else {
              // Enforce KCL balanced adjustment on remaining third phase
              const third =
                pop === 1
                  ? st === 1
                    ? 1
                    : 0
                  : (st & 1) === 0
                  ? 1
                  : 0;
              const o1 = (third + 1) % 3;
              const o2 = (third + 2) % 3;
              lastI[third] = -(lastI[o1] + lastI[o2]);
            }
          }
        }
      }

      for (let k = runStart; k <= runEnd; k++) {
        if (st < 0 || !Number.isFinite(idcArr[k])) {
          nonFiniteCount++;
          blindMask[k] = 1;
          blindCount++;
          ia[k] = Number.NaN;
          ib[k] = Number.NaN;
          ic[k] = Number.NaN;
        } else {
          if (isBlindRun) {
            blindMask[k] = 1;
            blindCount++;
          } else {
            blindMask[k] = 0;
          }
          ia[k] = lastI[0];
          ib[k] = lastI[1];
          ic[k] = lastI[2];
        }
      }
      runStart = runEnd + 1;
    }
  } else {
    warnings.push(
      `识别为连续 SVPWM 占空比 (fsw=${(fswHz / 1e3).toFixed(1)}kHz, T_min=${(tMinSec * 1e6).toFixed(2)}µs)：按直流母线功率投影反推三相电流基波（忽略 q/d 轴无功分量），并标记 ΔD·Tsw < T_min 的单电阻盲区。`
    );
    for (let k = 0; k < n; k++) {
      const a = da[k];
      const b = db[k];
      const c = dc[k];
      const idc = idcArr[k];
      if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(idc)) {
        nonFiniteCount++;
        blindMask[k] = 1;
        blindCount++;
        ia[k] = Number.NaN;
        ib[k] = Number.NaN;
        ic[k] = Number.NaN;
        continue;
      }

      // Check SVPWM active vector window widths against T_min
      const sorted = [a, b, c].sort((x, y) => y - x);
      const w1Sec = (sorted[0] - sorted[1]) * tSwSec;
      const w2Sec = (sorted[1] - sorted[2]) * tSwSec;

      const dMean = (a + b + c) / 3;
      const va = a - dMean;
      const vb = b - dMean;
      const vc = c - dMean;
      const vMagSq = va * va + vb * vb + vc * vc;

      const isBlind = w1Sec < tMinSec || w2Sec < tMinSec || vMagSq < 1e-6;
      if (isBlind) {
        blindMask[k] = 1;
        blindCount++;
      } else {
        blindMask[k] = 0;
      }

      if (vMagSq < 1e-6) {
        ia[k] = 0;
        ib[k] = 0;
        ic[k] = 0;
      } else {
        ia[k] = (idc * va) / vMagSq;
        ib[k] = (idc * vb) / vMagSq;
        ic[k] = -(ia[k] + ib[k]);
      }
    }
  }

  const blindZoneFractionPct = n > 0 ? (blindCount / n) * 100 : 0;
  if (nonFiniteCount > 0) {
    warnings.push(`检测到 ${nonFiniteCount} 个 NaN/Inf 无效采样点，已保留 NaN 标记。`);
  }
  if (blindZoneFractionPct > 0.5) {
    warnings.push(
      `单电阻采样盲区占比 ${blindZoneFractionPct.toFixed(1)}% (${blindCount}/${n} 点不满足 ΔD·Tsw ≥ ${(tMinSec * 1e6).toFixed(2)} µs)，对应扇区边界波形重构精度受限。`
    );
  }

  return {
    valid: true,
    mode,
    time,
    ia,
    ib,
    ic,
    blindMask,
    blindCount,
    blindZoneFractionPct,
    warnings,
  };
}
