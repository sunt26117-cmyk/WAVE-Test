/**
 * Waveform Viewer Pro - Smart Oscilloscope Cursor Engine
 * Handles Viewport Boundary Clamping (2% edge margin) so cursors never get lost off-screen
 * during pan/zoom/scale operations, plus one-click Center Cursors (25% / 75%) recall.
 */

import { TabState, WaveformChannel } from '../types/models';
import { ensureChannelScaleOffset, syncChannelBoundsFromScaleOffset } from './oscilloscopeScale';

const EDGE_MARGIN_RATIO = 0.02; // Keep 2% viewport edge margin

function computeViewTimeSpan(
  tab: TabState,
  ch?: WaveformChannel
): { tStart: number; tEnd: number; tSpan: number } {
  const baseCh = ch || tab.channels[tab.drawOrder[0]] || Object.values(tab.channels)[0];
  if (!baseCh || baseCh.t.length === 0) {
    return { tStart: 0, tEnd: 0.01, tSpan: 0.01 };
  }
  const n = baseCh.t.length;
  const dt = baseCh.dt || (n > 1 ? (baseCh.t[n - 1] - baseCh.t[0]) / (n - 1) : 1e-4);
  const sIdx = Math.max(0, Math.min(n - 1, tab.view.startIndex));
  const tStart = baseCh.t[sIdx];
  const eIdx = Math.max(sIdx + 1, tab.view.endIndex);
  const tEnd = eIdx < n ? baseCh.t[eIdx] : baseCh.t[n - 1] + (eIdx - (n - 1)) * dt;
  const tSpan = Math.max(dt * 1e-3, tEnd - tStart);
  return { tStart, tEnd, tSpan };
}

/**
 * Clamps active cursors (X1/X2, Y1/Y2) within the current viewport boundaries with a 2% margin,
 * preventing cursors from ever drifting off-screen during panning, zooming, or vertical rescaling.
 */
export function clampCursorsToViewport(tab: TabState): void {
  if (!tab.cursors.enabled || tab.cursors.mode === 'off') return;

  const targetId = tab.cursors.trackingChannel || tab.activeChannelId || tab.drawOrder[0];
  const targetCh = tab.channels[targetId] || tab.channels[tab.drawOrder[0]];
  if (!targetCh) return;

  const { tStart, tEnd, tSpan } = computeViewTimeSpan(tab, targetCh);
  const marginX = tSpan * EDGE_MARGIN_RATIO;
  const minX = tStart + marginX;
  const maxX = tEnd - marginX;

  if (minX <= maxX) {
    if (tab.cursors.x1 !== null) {
      tab.cursors.x1 = Math.max(minX, Math.min(maxX, tab.cursors.x1));
    }
    if (tab.cursors.x2 !== null) {
      tab.cursors.x2 = Math.max(minX, Math.min(maxX, tab.cursors.x2));
    }
  }

  ensureChannelScaleOffset(targetCh);
  syncChannelBoundsFromScaleOffset(targetCh);
  const vSpan = targetCh.vMax - targetCh.vMin;
  if (vSpan > 0 && isFinite(vSpan)) {
    const marginY = vSpan * EDGE_MARGIN_RATIO;
    const minY = targetCh.vMin + marginY;
    const maxY = targetCh.vMax - marginY;
    if (minY <= maxY) {
      if (tab.cursors.y1 !== null) {
        tab.cursors.y1 = Math.max(minY, Math.min(maxY, tab.cursors.y1));
      }
      if (tab.cursors.y2 !== null) {
        tab.cursors.y2 = Math.max(minY, Math.min(maxY, tab.cursors.y2));
      }
    }
  }
}

/**
 * Recalls cursors cleanly into the active viewport: X1 at 25%, X2 at 75%, Y1 at 72%, Y2 at 28%.
 * Automatically enables X+Y cursor mode if cursors were currently turned off.
 */
export function centerCursorsInViewport(tab: TabState): void {
  const targetId = tab.cursors.trackingChannel || tab.activeChannelId || tab.drawOrder[0];
  const targetCh = tab.channels[targetId] || tab.channels[tab.drawOrder[0]];
  if (!targetCh) return;

  if (!tab.cursors.enabled || tab.cursors.mode === 'off') {
    tab.cursors.mode = 'xy';
    tab.cursors.enabled = true;
  }
  tab.cursors.trackingChannel = targetCh.id;

  const { tStart, tSpan } = computeViewTimeSpan(tab, targetCh);
  tab.cursors.x1 = tStart + tSpan * 0.25;
  tab.cursors.x2 = tStart + tSpan * 0.75;

  ensureChannelScaleOffset(targetCh);
  syncChannelBoundsFromScaleOffset(targetCh);
  const vSpan = targetCh.vMax - targetCh.vMin;
  tab.cursors.y1 = targetCh.vMin + vSpan * 0.72;
  tab.cursors.y2 = targetCh.vMin + vSpan * 0.28;
}
