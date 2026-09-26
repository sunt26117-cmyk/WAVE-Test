/**
 * Waveform Viewer Pro - Trigger Engine
 * Edge triggering algorithm for static/captured waveform inspection.
 * Locates trigger edge events and centers view horizontally on trigger point.
 */

import { TriggerConfig, WaveformChannel, ViewState } from '../types/models';

/**
 * Searches for a trigger event in the specified channel.
 */
export function findTriggerPoint(
  channel: WaveformChannel,
  config: TriggerConfig
): { triggerTime: number; triggerIndex: number } | null {
  const v = channel.v;
  const t = channel.t;
  const n = v.length;
  if (n < 2) return null;

  const level = config.level;
  const isRising = config.type === 'rising';

  for (let i = 1; i < n; i++) {
    const vPrev = v[i - 1];
    const vCurr = v[i];

    if (isRising) {
      if (vPrev < level && vCurr >= level) {
        // Interpolate exact crossing time
        const frac = (level - vPrev) / (vCurr - vPrev || 1e-12);
        const crossingTime = t[i - 1] + frac * (t[i] - t[i - 1]);
        return { triggerTime: crossingTime, triggerIndex: i };
      }
    } else {
      if (vPrev > level && vCurr <= level) {
        const frac = (level - vPrev) / (vCurr - vPrev || 1e-12);
        const crossingTime = t[i - 1] + frac * (t[i] - t[i - 1]);
        return { triggerTime: crossingTime, triggerIndex: i };
      }
    }
  }

  return null;
}

/**
 * Aligns the view so the trigger point sits at the specified screen position percent (default 50%).
 */
export function alignViewToTrigger(
  view: ViewState,
  channel: WaveformChannel,
  triggerIndex: number,
  positionPercent: number = 50
): ViewState {
  const totalN = channel.v.length;
  const currentSpan = view.endIndex - view.startIndex;
  const leftCount = Math.round((currentSpan * positionPercent) / 100);

  let newStart = triggerIndex - leftCount;
  let newEnd = newStart + currentSpan;

  if (newStart < 0) {
    newStart = 0;
    newEnd = Math.min(totalN, currentSpan);
  } else if (newEnd > totalN) {
    newEnd = totalN;
    newStart = Math.max(0, totalN - currentSpan);
  }

  return {
    ...view,
    startIndex: newStart,
    endIndex: newEnd,
  };
}
