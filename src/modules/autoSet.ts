/**
 * Waveform Viewer Pro - AutoSet Engine
 * Implements 1-2-5 oscilloscope scale steps for horizontal and vertical axes,
 * auto-centering, and automatic trigger detection.
 */

import { WaveformChannel, ViewState, TriggerConfig } from '../types/models';
import { findTriggerPoint, alignViewToTrigger } from './trigger';

const STANDARD_125_STEPS = [1, 2, 5];

/**
 * Snaps a value to the nearest 1-2-5 scale step.
 */
export function snapTo125(value: number): number {
  if (value <= 0 || !isFinite(value)) return 1.0;
  const exponent = Math.floor(Math.log10(value));
  const mantissa = value / Math.pow(10, exponent);

  let bestStep = STANDARD_125_STEPS[0];
  let minDiff = Math.abs(mantissa - bestStep);

  for (let i = 1; i < STANDARD_125_STEPS.length; i++) {
    const diff = Math.abs(mantissa - STANDARD_125_STEPS[i]);
    if (diff < minDiff) {
      minDiff = diff;
      bestStep = STANDARD_125_STEPS[i];
    }
  }

  // Also check if closer to 10 * 10^exp
  if (Math.abs(mantissa - 10) < minDiff) {
    return 10 * Math.pow(10, exponent);
  }

  return bestStep * Math.pow(10, exponent);
}

export interface AutoSetResult {
  updatedChannels: Record<string, { vMin: number; vMax: number }>;
  view: ViewState;
  triggerConfig: TriggerConfig;
  statusMessage: string;
}

/**
 * Calculates optimal 1-2-5 view scales and trigger parameters based on active signal.
 */
export function performAutoSet(
  channels: Record<string, WaveformChannel>,
  drawOrder: string[],
  currentView: ViewState
): AutoSetResult {
  const visibleChannels = drawOrder
    .map((id) => channels[id])
    .filter((c) => c && c.visible && c.v.length > 1);

  if (visibleChannels.length === 0) {
    return {
      updatedChannels: {},
      view: currentView,
      triggerConfig: {
        enabled: false,
        channelId: '',
        type: 'rising',
        level: 0,
        positionPercent: 50,
      },
      statusMessage: 'No visible channels to AutoSet.',
    };
  }

  const primaryCh = visibleChannels[0];
  const v = primaryCh.v;
  const t = primaryCh.t;
  const totalN = v.length;

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < totalN; i++) {
    const val = v[i];
    if (!isNaN(val)) {
      if (val < min) min = val;
      if (val > max) max = val;
    }
  }

  const vpp = max - min;
  const midLevel = (max + min) / 2;

  // Approximate signal period via zero/mid crossings
  let cycleCount = 0;
  let firstCrossing = -1;
  let lastCrossing = -1;
  const hyst = 0.05 * vpp;

  for (let i = 1; i < totalN; i++) {
    if (v[i - 1] < midLevel - hyst && v[i] >= midLevel + hyst) {
      if (firstCrossing < 0) firstCrossing = i;
      lastCrossing = i;
      cycleCount++;
    }
  }

  let period = 0;
  if (cycleCount >= 2 && lastCrossing > firstCrossing) {
    const timeDelta = t[lastCrossing] - t[firstCrossing];
    period = timeDelta / (cycleCount - 1);
  }

  // Adjust horizontal view: target ~3 to 4 visible cycles across 10 divisions
  let newStart = 0;
  let newEnd = totalN;

  if (period > 0 && primaryCh.dt && primaryCh.dt > 0) {
    const targetSpanTime = period * 4;
    const targetPoints = Math.round(targetSpanTime / primaryCh.dt);
    if (targetPoints > 10 && targetPoints < totalN) {
      newStart = 0;
      newEnd = targetPoints;
    }
  }

  let updatedView: ViewState = {
    ...currentView,
    startIndex: newStart,
    endIndex: newEnd,
  };

  // Align trigger to mid-level
  const triggerConfig: TriggerConfig = {
    enabled: true,
    channelId: primaryCh.id,
    type: 'rising',
    level: midLevel,
    positionPercent: 50,
  };

  const trigPt = findTriggerPoint(primaryCh, triggerConfig);
  if (trigPt) {
    updatedView = alignViewToTrigger(updatedView, primaryCh, trigPt.triggerIndex, 50);
  }

  // Snap vertical scale using 1-2-5 sequence (8 divisions)
  const updatedChannels: Record<string, { vMin: number; vMax: number }> = {};
  for (const ch of visibleChannels) {
    let chMin = Infinity;
    let chMax = -Infinity;
    for (let i = 0; i < ch.v.length; i++) {
      const val = ch.v[i];
      if (!isNaN(val)) {
        if (val < chMin) chMin = val;
        if (val > chMax) chMax = val;
      }
    }
    const span = chMax - chMin || 1.0;
    const center = (chMax + chMin) / 2;
    const voltsPerDivRaw = span / 6; // Leave 1 division headroom top & bottom
    const voltsPerDivSnapped = snapTo125(voltsPerDivRaw);
    const fullSpan = voltsPerDivSnapped * 8;

    updatedChannels[ch.id] = {
      vMin: center - fullSpan / 2,
      vMax: center + fullSpan / 2,
    };
  }

  return {
    updatedChannels,
    view: updatedView,
    triggerConfig,
    statusMessage: `AutoSet applied: Trigger level ${midLevel.toFixed(3)} V, scale fitted to 1-2-5 steps.`,
  };
}
