/**
 * Waveform Viewer Pro - Data Editing & Same-Screen Reference Engine
 * Automatically snapshots unmodified channel data as a locked Reference (Ref) trace
 * prior to global/local edits, and supports Diff (New - Ref) computation and revert.
 */

import { WaveformChannel } from '../types/models';

export type GlobalEditOp =
  | { type: 'offset'; value: number }
  | { type: 'gain'; value: number }
  | { type: 'smooth'; window: number };

export type LocalEditOp =
  | { type: 'flatten'; value: number }
  | { type: 'bridge' }
  | { type: 'offset'; value: number }
  | { type: 'gain'; value: number };

/**
 * Locks the unmodified original data as Ref before any mutation occurs.
 */
export function ensureReferenceLocked(ch: WaveformChannel): void {
  if (!ch.refV) {
    ch.refV = new Float32Array(ch.v);
    ch.showRef = true;
  }
}

/**
 * Applies a global edit operation across all samples of a channel.
 */
export function applyGlobalEdit(ch: WaveformChannel, op: GlobalEditOp): void {
  if (!ch.v || ch.v.length === 0) return;
  ensureReferenceLocked(ch);

  const n = ch.v.length;

  if (op.type === 'offset') {
    if (!isFinite(op.value)) return;
    for (let i = 0; i < n; i++) {
      if (!isNaN(ch.v[i])) ch.v[i] += op.value;
    }
  } else if (op.type === 'gain') {
    if (!isFinite(op.value)) return;
    for (let i = 0; i < n; i++) {
      if (!isNaN(ch.v[i])) ch.v[i] *= op.value;
    }
  } else if (op.type === 'smooth') {
    let win = Math.max(3, Math.min(201, Math.round(op.window)));
    if (win % 2 === 0) win += 1;
    const half = Math.floor(win / 2);
    const src = new Float32Array(ch.v);

    for (let i = 0; i < n; i++) {
      if (isNaN(src[i])) continue;
      let sum = 0;
      let cnt = 0;
      const jStart = Math.max(0, i - half);
      const jEnd = Math.min(n - 1, i + half);
      for (let j = jStart; j <= jEnd; j++) {
        const val = src[j];
        if (!isNaN(val) && isFinite(val)) {
          sum += val;
          cnt++;
        }
      }
      if (cnt > 0) ch.v[i] = sum / cnt;
    }
  }

  ch.hasEdits = true;
}

/**
 * Applies a localized edit operation within [tStart, tEnd]. Returns count of modified samples.
 */
export function applyLocalEdit(
  ch: WaveformChannel,
  tStart: number,
  tEnd: number,
  op: LocalEditOp
): number {
  if (!ch.v || ch.v.length === 0 || ch.t.length === 0) return 0;
  const tMin = Math.min(tStart, tEnd);
  const tMax = Math.max(tStart, tEnd);

  let iStart = 0;
  while (iStart < ch.t.length && ch.t[iStart] < tMin) iStart++;
  let iEnd = iStart;
  while (iEnd < ch.t.length && ch.t[iEnd] <= tMax) iEnd++;

  if (iEnd <= iStart) return 0;

  ensureReferenceLocked(ch);

  const count = iEnd - iStart;
  if (op.type === 'flatten') {
    const targetVal = isFinite(op.value) ? op.value : 0;
    for (let i = iStart; i < iEnd; i++) {
      ch.v[i] = targetVal;
    }
  } else if (op.type === 'bridge') {
    const leftIdx = Math.max(0, iStart - 1);
    const rightIdx = Math.min(ch.v.length - 1, iEnd);
    const vLeft = isFinite(ch.v[leftIdx]) ? ch.v[leftIdx] : 0;
    const vRight = isFinite(ch.v[rightIdx]) ? ch.v[rightIdx] : vLeft;
    const denom = Math.max(1, rightIdx - leftIdx);
    for (let i = iStart; i < iEnd; i++) {
      const frac = (i - leftIdx) / denom;
      ch.v[i] = vLeft + frac * (vRight - vLeft);
    }
  } else if (op.type === 'offset') {
    if (isFinite(op.value)) {
      for (let i = iStart; i < iEnd; i++) {
        if (!isNaN(ch.v[i])) ch.v[i] += op.value;
      }
    }
  } else if (op.type === 'gain') {
    if (isFinite(op.value)) {
      for (let i = iStart; i < iEnd; i++) {
        if (!isNaN(ch.v[i])) ch.v[i] *= op.value;
      }
    }
  }

  ch.hasEdits = true;
  return count;
}

/**
 * Reverts a channel's active waveform back to its locked Ref snapshot.
 */
export function revertChannelToReference(ch: WaveformChannel): boolean {
  if (!ch.refV) return false;
  ch.v = new Float32Array(ch.refV);
  ch.hasEdits = false;
  ch.showDiff = false;
  return true;
}

/**
 * Computes sample-by-sample difference curve (New - Ref).
 */
export function computeDiffSeries(ch: WaveformChannel): Float32Array | null {
  if (!ch.refV || ch.refV.length !== ch.v.length) return null;
  const n = ch.v.length;
  const diff = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    diff[i] = ch.v[i] - ch.refV[i];
  }
  return diff;
}

/**
 * Applies a total horizontal time shift Δt (seconds) relative to the channel's original timebase.
 * Never mutates shared Float64Array time buffers across channels.
 */
export function applyChannelTimeShift(ch: WaveformChannel, totalShiftSec: number): void {
  if (!ch.t || ch.t.length === 0 || !isFinite(totalShiftSec)) return;
  if (!ch.timeShiftBaseT || ch.timeShiftBaseT.length !== ch.t.length) {
    ch.timeShiftBaseT = new Float64Array(ch.t);
  }
  const base = ch.timeShiftBaseT;
  const n = base.length;
  const nextT = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    nextT[i] = base[i] + totalShiftSec;
  }
  ch.t = nextT;
  ch.timeShiftSec = totalShiftSec;
}

/**
 * Resets a channel's horizontal time shift back to Δt = 0 using its original unshifted timebase.
 */
export function resetChannelTimeShift(ch: WaveformChannel): boolean {
  const hadShift = Boolean(
    (ch.timeShiftBaseT && ch.timeShiftBaseT.length === ch.t.length) ||
      (ch.timeShiftSec && Math.abs(ch.timeShiftSec) > 0)
  );
  if (ch.timeShiftBaseT && ch.timeShiftBaseT.length === ch.t.length) {
    ch.t = new Float64Array(ch.timeShiftBaseT);
  }
  ch.timeShiftSec = 0;
  delete ch.timeShiftBaseT;
  return hadShift;
}

