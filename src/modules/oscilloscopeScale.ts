/**
 * Waveform Viewer Pro - Oscilloscope Scale, Offset, Timebase & Subplot Layout Engine
 * Provides authentic 1-2-5 step sequences for vertical (V/div) and horizontal (s/div) scales,
 * vertical offset/position management, AC/DC coupling & inversion helpers,
 * and unified subplot geometry for Overlap and Separate views.
 */

import { WaveformChannel, TabState, ViewState } from '../types/models';

export interface PlotArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SubplotRect {
  channel: WaveformChannel;
  area: PlotArea;
  index: number;
}

export const VERTICAL_DIVISIONS = 8;
export const HORIZONTAL_DIVISIONS = 10;

// Clean list of standard 1-2-5 steps from 1 ps/div (or pV/div) to 50 ks/div (or kV/div)
export const STANDARD_125_VALUES: number[] = (() => {
  const vals: number[] = [];
  for (let exp = -12; exp <= 4; exp++) {
    const base = Math.pow(10, exp);
    for (const mant of [1, 2, 5]) {
      vals.push(Number((mant * base).toPrecision(6)));
    }
  }
  return vals;
})();

/**
 * Snaps a positive value to the nearest standard 1-2-5 step.
 */
export function snapScale125(val: number): number {
  if (!isFinite(val) || val <= 0) return 1.0;
  let best = STANDARD_125_VALUES[0];
  let bestRatio = Infinity;
  for (const cand of STANDARD_125_VALUES) {
    const ratio = Math.max(val / cand, cand / val);
    if (ratio < bestRatio) {
      bestRatio = ratio;
      best = cand;
    }
  }
  return best;
}

/**
 * Steps a scale value up (direction = 1, coarser/larger V/div) or down (direction = -1, finer/smaller V/div)
 * along the exact 1-2-5 sequence.
 */
export function stepScale125(current: number, direction: 1 | -1): number {
  const snapped = snapScale125(current);
  const idx = STANDARD_125_VALUES.indexOf(snapped);
  if (idx === -1) return snapped;
  const nextIdx = Math.max(0, Math.min(STANDARD_125_VALUES.length - 1, idx + direction));
  return STANDARD_125_VALUES[nextIdx];
}

/**
 * Computes DC mean of a channel (used when AC coupling is enabled).
 */
export function computeChannelMean(ch: WaveformChannel): number {
  const v = ch.v;
  if (!v || v.length === 0) return 0;
  let sum = 0;
  let count = 0;
  const step = v.length > 50000 ? Math.floor(v.length / 20000) : 1;
  for (let i = 0; i < v.length; i += step) {
    const val = v[i];
    if (!isNaN(val) && isFinite(val)) {
      sum += val;
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Returns the displayed voltage value at index i accounting for AC coupling and Inversion.
 */
export function getChannelDisplayValue(ch: WaveformChannel, idx: number, cachedMean?: number): number {
  let val = ch.v[idx];
  if (isNaN(val)) return NaN;
  if (ch.coupling === 'AC') {
    const mean = cachedMean !== undefined ? cachedMean : computeChannelMean(ch);
    val -= mean;
  }
  if (ch.inverted) {
    val = -val;
  }
  return val;
}

/**
 * Ensures voltsPerDiv and vOffset are initialized from existing vMin / vMax.
 */
export function ensureChannelScaleOffset(ch: WaveformChannel): { voltsPerDiv: number; vOffset: number } {
  if (
    ch.voltsPerDiv !== undefined &&
    isFinite(ch.voltsPerDiv) &&
    ch.voltsPerDiv > 0 &&
    ch.vOffset !== undefined &&
    isFinite(ch.vOffset)
  ) {
    return { voltsPerDiv: ch.voltsPerDiv, vOffset: ch.vOffset };
  }

  const span = ch.vMax - ch.vMin;
  const voltsPerDiv = span > 0 && isFinite(span) ? span / VERTICAL_DIVISIONS : 1.0;
  const center = (ch.vMax + ch.vMin) / 2;
  // Center = -vOffset => vOffset = -center
  const vOffset = isFinite(center) ? -center : 0;

  ch.voltsPerDiv = voltsPerDiv;
  ch.vOffset = vOffset;
  return { voltsPerDiv, vOffset };
}

/**
 * Updates vMin and vMax cleanly from voltsPerDiv and vOffset (8 vertical divisions).
 * Convention:
 *   - 0V ground reference is at screen center when vOffset = 0.
 *   - Positive vOffset moves 0V and the waveform UP on screen.
 *   - Screen bottom = -4 * V/div - vOffset; Screen top = +4 * V/div - vOffset.
 */
export function syncChannelBoundsFromScaleOffset(ch: WaveformChannel): void {
  const { voltsPerDiv, vOffset } = ensureChannelScaleOffset(ch);
  const halfSpan = (VERTICAL_DIVISIONS / 2) * voltsPerDiv; // 4 * V/div
  ch.vMin = -halfSpan - vOffset;
  ch.vMax = halfSpan - vOffset;
}

/**
 * Auto-fits a channel using clean 1-2-5 V/div steps and centers it vertically.
 */
export function fitChannelTo125(ch: WaveformChannel): void {
  const v = ch.v;
  const n = v.length;
  if (n === 0) return;

  const mean = ch.coupling === 'AC' ? computeChannelMean(ch) : 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const val = getChannelDisplayValue(ch, i, mean);
    if (!isNaN(val) && isFinite(val)) {
      if (val < min) min = val;
      if (val > max) max = val;
    }
  }

  if (!isFinite(min) || !isFinite(max)) {
    ch.voltsPerDiv = 1.0;
    ch.vOffset = 0;
    syncChannelBoundsFromScaleOffset(ch);
    return;
  }

  const span = max - min;
  const rawVPerDiv = span > 1e-9 ? span / 6 : Math.max(Math.abs(max) / 2, 0.5);
  ch.voltsPerDiv = snapScale125(rawVPerDiv);
  const center = (max + min) / 2;
  // Place center of signal at screen vertical center (vOffset = -center)
  ch.vOffset = Math.abs(center) < ch.voltsPerDiv * 0.05 ? 0 : -center;
  syncChannelBoundsFromScaleOffset(ch);
}

/**
 * Computes global min/max index bounds (relative to the primary channel's grid)
 * across all channels in a tab, supporting negative indices and extended end indices
 * when Compare/shifted traces span beyond the primary waveform.
 */
export function getTabGlobalIndexBounds(tab: TabState): {
  minIdx: number;
  maxIdx: number;
  tMin: number;
  tMax: number;
} {
  const primaryCh = tab.channels[tab.drawOrder[0]] || Object.values(tab.channels)[0];
  if (!primaryCh || primaryCh.t.length === 0) {
    return { minIdx: 0, maxIdx: 0, tMin: 0, tMax: 0.01 };
  }

  const refT =
    primaryCh.timeShiftBaseT && primaryCh.timeShiftBaseT.length === primaryCh.t.length
      ? primaryCh.timeShiftBaseT
      : primaryCh.t;
  const n = refT.length;
  const dt = primaryCh.dt || (n > 1 ? (refT[n - 1] - refT[0]) / (n - 1) : 1e-4);
  const safeDt = dt > 0 && isFinite(dt) ? dt : 1e-4;

  let globalTMin = refT[0];
  let globalTMax = refT[n - 1];

  for (const id of tab.drawOrder) {
    const ch = tab.channels[id];
    if (!ch || !ch.t || ch.t.length === 0) continue;
    const t0 = ch.t[0];
    const t1 = ch.t[ch.t.length - 1];
    if (isFinite(t0) && t0 < globalTMin) globalTMin = t0;
    if (isFinite(t1) && t1 > globalTMax) globalTMax = t1;
  }

  const minIdx = globalTMin < refT[0] ? Math.floor((globalTMin - refT[0]) / safeDt) : 0;
  const extraRight =
    globalTMax > refT[n - 1] ? Math.ceil((globalTMax - refT[n - 1]) / safeDt) : 0;
  const maxIdx = Math.max(primaryCh.v.length, n + extraRight);

  return {
    minIdx,
    maxIdx,
    tMin: globalTMin,
    tMax: globalTMax,
  };
}

/**
 * Automatically extends tab.view bounds so the longest / widest waveform fits cleanly.
 */
export function extendTabViewToLongestChannel(tab: TabState): boolean {
  const bounds = getTabGlobalIndexBounds(tab);
  let changed = false;
  if (bounds.minIdx < tab.view.startIndex) {
    tab.view.startIndex = bounds.minIdx;
    changed = true;
  }
  if (bounds.maxIdx > tab.view.endIndex) {
    tab.view.endIndex = bounds.maxIdx;
    changed = true;
  }
  return changed;
}

/**
 * Computes horizontal timebase parameters for the active tab (10 horizontal divisions).
 */
export function getTimebaseInfo(tab: TabState): {
  secPerDiv: number;
  totalSpanSec: number;
  tStartSec: number;
  tEndSec: number;
  centerTimeSec: number;
  sampleRate: number | null;
  visiblePoints: number;
  totalPoints: number;
} {
  const primaryCh = tab.channels[tab.drawOrder[0]] || Object.values(tab.channels)[0];
  if (!primaryCh || primaryCh.t.length === 0) {
    return {
      secPerDiv: 1e-3,
      totalSpanSec: 1e-2,
      tStartSec: 0,
      tEndSec: 1e-2,
      centerTimeSec: 5e-3,
      sampleRate: null,
      visiblePoints: 0,
      totalPoints: 0,
    };
  }

  const refT =
    primaryCh.timeShiftBaseT && primaryCh.timeShiftBaseT.length === primaryCh.t.length
      ? primaryCh.timeShiftBaseT
      : primaryCh.t;
  const n = refT.length;
  const dt = primaryCh.dt || (n > 1 ? (refT[n - 1] - refT[0]) / (n - 1) : 1e-4);
  const bounds = getTabGlobalIndexBounds(tab);
  const totalPoints = Math.max(primaryCh.v.length, bounds.maxIdx - bounds.minIdx);

  const startIdx = tab.view.startIndex;
  const endIdx = Math.max(startIdx + 1, tab.view.endIndex);
  const visiblePoints = Math.max(1, endIdx - startIdx);

  let tStartSec: number;
  if (startIdx < 0) {
    tStartSec = refT[0] + startIdx * dt;
  } else if (startIdx < n) {
    tStartSec = refT[startIdx];
  } else {
    tStartSec = refT[n - 1] + (startIdx - n + 1) * dt;
  }

  let tEndSec: number;
  if (endIdx <= 0) {
    tEndSec = refT[0] + endIdx * dt;
  } else if (endIdx < n) {
    tEndSec = refT[endIdx];
  } else if (n >= 2) {
    tEndSec = refT[n - 1] + (endIdx - n) * dt;
  } else {
    tEndSec = refT[0] + endIdx * dt;
  }

  const totalSpanSec = Math.max(dt * 1e-3, tEndSec - tStartSec);
  const secPerDiv = totalSpanSec / HORIZONTAL_DIVISIONS;

  return {
    secPerDiv,
    totalSpanSec,
    tStartSec,
    tEndSec,
    centerTimeSec: (tStartSec + tEndSec) / 2,
    sampleRate: primaryCh.fs,
    visiblePoints,
    totalPoints,
  };
}

/**
 * Steps the horizontal timebase in 1-2-5 sequence around the view center.
 */
export function stepTimebase125(tab: TabState, direction: 1 | -1): ViewState {
  const primaryCh = tab.channels[tab.drawOrder[0]] || Object.values(tab.channels)[0];
  if (!primaryCh || primaryCh.v.length < 2) return tab.view;

  const refT =
    primaryCh.timeShiftBaseT && primaryCh.timeShiftBaseT.length === primaryCh.t.length
      ? primaryCh.timeShiftBaseT
      : primaryCh.t;
  const n = refT.length;
  const dt = primaryCh.dt || (n > 1 ? (refT[n - 1] - refT[0]) / (n - 1) : 1e-4);
  const bounds = getTabGlobalIndexBounds(tab);
  const totalSpanBounds = Math.max(2, bounds.maxIdx - bounds.minIdx);
  const minSpanPts = Math.min(totalSpanBounds, 2);
  const curSpanPts = Math.max(minSpanPts, tab.view.endIndex - tab.view.startIndex);
  const curSecPerDiv = (curSpanPts * dt) / HORIZONTAL_DIVISIONS;
  const nextSecPerDiv = stepScale125(curSecPerDiv, direction);
  const nextSpanPts = Math.max(
    minSpanPts,
    Math.min(totalSpanBounds, Math.round((nextSecPerDiv * HORIZONTAL_DIVISIONS) / dt))
  );

  const centerIdx = (tab.view.startIndex + tab.view.endIndex) / 2;
  let newStart = Math.round(centerIdx - nextSpanPts / 2);
  let newEnd = newStart + nextSpanPts;

  if (newStart < bounds.minIdx) {
    newStart = bounds.minIdx;
    newEnd = Math.min(bounds.maxIdx, bounds.minIdx + nextSpanPts);
  }
  if (newEnd > bounds.maxIdx) {
    newEnd = bounds.maxIdx;
    newStart = Math.max(bounds.minIdx, bounds.maxIdx - nextSpanPts);
  }

  return {
    ...tab.view,
    startIndex: newStart,
    endIndex: newEnd,
  };
}

/**
 * Pans horizontal view by a fractional number of divisions (e.g. -1 or +1).
 */
export function panHorizontalDivs(tab: TabState, divs: number): ViewState {
  const primaryCh = tab.channels[tab.drawOrder[0]] || Object.values(tab.channels)[0];
  if (!primaryCh || primaryCh.v.length < 2) return tab.view;

  const bounds = getTabGlobalIndexBounds(tab);
  const spanPts = Math.max(2, tab.view.endIndex - tab.view.startIndex);
  const shiftPts = Math.round((spanPts / HORIZONTAL_DIVISIONS) * divs);

  let newStart = tab.view.startIndex + shiftPts;
  let newEnd = tab.view.endIndex + shiftPts;

  if (newStart < bounds.minIdx) {
    newStart = bounds.minIdx;
    newEnd = Math.min(bounds.maxIdx, bounds.minIdx + spanPts);
  } else if (newEnd > bounds.maxIdx) {
    newEnd = bounds.maxIdx;
    newStart = Math.max(bounds.minIdx, bounds.maxIdx - spanPts);
  }

  return {
    ...tab.view,
    startIndex: newStart,
    endIndex: newEnd,
  };
}

/**
 * Computes exact subplot bounding boxes for Overlap or Separate view modes.
 * Used identically by rendering, axis labeling, GND handles, trigger handles, cursors, and hit-testing.
 */
export function getSubplotRects(
  p: PlotArea,
  visibleChannels: WaveformChannel[],
  separateView: boolean
): SubplotRect[] {
  if (visibleChannels.length === 0) return [];

  if (!separateView || visibleChannels.length === 1) {
    return visibleChannels.map((ch, idx) => ({
      channel: ch,
      area: { ...p },
      index: idx,
    }));
  }

  const gap = 10;
  const count = visibleChannels.length;
  const totalGap = (count - 1) * gap;
  const subH = Math.max(24, (p.height - totalGap) / count);

  return visibleChannels.map((ch, idx) => ({
    channel: ch,
    area: {
      x: p.x,
      y: p.y + idx * (subH + gap),
      width: p.width,
      height: subH,
    },
    index: idx,
  }));
}

export interface SyncSameUnitResult {
  unit: string;
  targetVoltsPerDiv: number;
  targetVOffset: number;
  syncedCount: number;
  driverChannelName: string;
  syncedChannelIds: string[];
}

/**
 * Unifies vertical scale (V/div), ground baseline, and vertical offset across all visible
 * channels sharing the active channel's unit. The channel with the largest peak-to-peak span
 * (or peak magnitude) determines the unified 1-2-5 V/div and baseline offset.
 */
export function syncSameUnitChannelsScale(
  tab: TabState,
  referenceChannelId?: string
): SyncSameUnitResult | null {
  const visibleChs = tab.drawOrder
    .map((id) => tab.channels[id])
    .filter((c) => c && c.visible && c.v.length > 0);
  if (visibleChs.length === 0) return null;

  const refCh =
    (referenceChannelId ? tab.channels[referenceChannelId] : null) ||
    (tab.activeChannelId ? tab.channels[tab.activeChannelId] : null) ||
    visibleChs[0];
  const rawUnit = (refCh.unit || 'V').trim();
  const normUnit = rawUnit.toUpperCase();

  const sameUnitChs = visibleChs.filter(
    (c) => (c.unit || 'V').trim().toUpperCase() === normUnit
  );
  if (sameUnitChs.length === 0) return null;

  let driverCh = sameUnitChs[0];
  let driverScore = -1;
  let driverMin = 0;
  let driverMax = 0;

  for (const ch of sameUnitChs) {
    const n = ch.v.length;
    const step = n > 100000 ? Math.floor(n / 50000) : 1;
    const mean = ch.coupling === 'AC' ? computeChannelMean(ch) : 0;
    let cMin = Infinity;
    let cMax = -Infinity;
    for (let i = 0; i < n; i += step) {
      const val = getChannelDisplayValue(ch, i, mean);
      if (!isNaN(val) && isFinite(val)) {
        if (val < cMin) cMin = val;
        if (val > cMax) cMax = val;
      }
    }
    if (!isFinite(cMin) || !isFinite(cMax)) continue;
    const span = cMax - cMin;
    const absPeak = Math.max(Math.abs(cMin), Math.abs(cMax));
    const score = span > 1e-12 ? span : absPeak;
    if (score > driverScore) {
      driverScore = score;
      driverCh = ch;
      driverMin = cMin;
      driverMax = cMax;
    }
  }

  if (driverScore < 0) return null;

  const driverSpan = driverMax - driverMin;
  const driverCenter = (driverMax + driverMin) / 2;
  const driverAbsPeak = Math.max(Math.abs(driverMin), Math.abs(driverMax));

  const rawVPerDiv =
    driverSpan > 1e-9
      ? driverSpan / 6
      : Math.max(driverAbsPeak / 2, 0.5);
  let targetVPerDiv = snapScale125(rawVPerDiv);

  // Align ground (0V) to center when the driving signal is roughly symmetric around 0V
  const targetVOffset =
    Math.abs(driverCenter) < targetVPerDiv * 0.25 ? 0 : -driverCenter;

  // Ensure the driving signal never clips outside the 8 vertical divisions
  for (let guard = 0; guard < 4; guard++) {
    const vMin = -(VERTICAL_DIVISIONS / 2) * targetVPerDiv - targetVOffset;
    const vMax = (VERTICAL_DIVISIONS / 2) * targetVPerDiv - targetVOffset;
    if (driverMin >= vMin && driverMax <= vMax) break;
    targetVPerDiv = stepScale125(targetVPerDiv, 1);
  }

  for (const ch of sameUnitChs) {
    ch.voltsPerDiv = targetVPerDiv;
    ch.vOffset = targetVOffset;
    syncChannelBoundsFromScaleOffset(ch);
  }

  return {
    unit: rawUnit,
    targetVoltsPerDiv: targetVPerDiv,
    targetVOffset,
    syncedCount: sameUnitChs.length,
    driverChannelName: driverCh.name,
    syncedChannelIds: sameUnitChs.map((c) => c.id),
  };
}
