/**
 * Waveform Viewer Pro - Session Serialization & Deserialization
 * Saves and restores .graphx files containing channels, views, cursors, annotations,
 * math definitions, and FFT/Motor configuration.
 */

import { TabState, WaveformChannel, AnnotationItem } from '../types/models';
import { evaluateMathExpression } from '../modules/mathParser';

export interface SerializedChannel {
  id: string;
  name: string;
  unit: string;
  color: string;
  visible: boolean;
  isMath: boolean;
  mathExpression?: string;
  sourceChannelIds: string[];
  vMin: number;
  vMax: number;
  fs: number | null;
  dt: number | null;
  metadata: any;
  // Encoded Float arrays
  t: number[];
  v: number[];
}

export interface SerializedSession {
  version: number;
  createdAt: string;
  tabs: {
    id: string;
    fileName: string;
    drawOrder: string[];
    channels: Record<string, SerializedChannel>;
    view: { startIndex: number; endIndex: number; fMin?: number; fMax?: number };
    cursors: any;
    annotations: AnnotationItem[];
    plotMode: 'time' | 'frequency';
    fftOptions: any;
    motorConfig: any;
    triggerConfig: any;
    separateView: boolean;
  }[];
  activeTabIndex: number;
}

/**
 * Serializes active tabs into a JSON session object.
 */
export function serializeSession(tabs: TabState[], activeTabIndex: number): string {
  const serializedTabs = tabs.map((tab) => {
    const serializedChannels: Record<string, SerializedChannel> = {};

    for (const [id, ch] of Object.entries(tab.channels)) {
      // Convert Float32Array and Float64Array to standard arrays (or downsample if huge)
      const tArr = Array.from(ch.t);
      const vArr = Array.from(ch.v);

      serializedChannels[id] = {
        id: ch.id,
        name: ch.name,
        unit: ch.unit,
        color: ch.color,
        visible: ch.visible,
        isMath: ch.isMath,
        mathExpression: ch.mathExpression,
        sourceChannelIds: ch.sourceChannelIds,
        vMin: ch.vMin,
        vMax: ch.vMax,
        fs: ch.fs,
        dt: ch.dt,
        metadata: ch.metadata,
        t: tArr,
        v: vArr,
      };
    }

    return {
      id: tab.id,
      fileName: tab.fileName,
      drawOrder: tab.drawOrder,
      channels: serializedChannels,
      view: tab.view,
      cursors: tab.cursors,
      annotations: tab.annotations,
      plotMode: tab.plotMode,
      fftOptions: tab.fftOptions,
      motorConfig: tab.motorConfig,
      triggerConfig: tab.triggerConfig,
      separateView: tab.separateView,
    };
  });

  const sessionObj: SerializedSession = {
    version: 2,
    createdAt: new Date().toISOString(),
    tabs: serializedTabs,
    activeTabIndex,
  };

  return JSON.stringify(sessionObj);
}

/**
 * Deserializes JSON string into TabState array and re-evaluates math channels.
 */
export function deserializeSession(jsonStr: string): { tabs: TabState[]; activeTabIndex: number } {
  const session: SerializedSession = JSON.parse(jsonStr);

  const restoredTabs: TabState[] = session.tabs.map((tab) => {
    const channels: Record<string, WaveformChannel> = {};

    for (const [id, sCh] of Object.entries(tab.channels)) {
      channels[id] = {
        id: sCh.id,
        name: sCh.name,
        unit: sCh.unit,
        color: sCh.color,
        visible: sCh.visible,
        isMath: sCh.isMath,
        mathExpression: sCh.mathExpression,
        sourceChannelIds: sCh.sourceChannelIds || [],
        vMin: sCh.vMin,
        vMax: sCh.vMax,
        fs: sCh.fs,
        dt: sCh.dt,
        metadata: sCh.metadata,
        t: new Float64Array(sCh.t),
        v: new Float32Array(sCh.v),
      };
    }

    // Deterministically recompute Math channels if expression is present
    for (const [id, ch] of Object.entries(channels)) {
      if (ch.isMath && ch.mathExpression) {
        try {
          const recomputed = evaluateMathExpression(
            ch.mathExpression,
            channels,
            tab.drawOrder,
            id,
            ch.name
          );
          channels[id] = recomputed;
        } catch (e) {
          console.warn(`Could not re-evaluate math expression for ${id}:`, e);
        }
      }
    }

    return {
      id: tab.id,
      fileName: tab.fileName,
      channels,
      drawOrder: tab.drawOrder,
      view: tab.view,
      cursors: tab.cursors,
      annotations: tab.annotations || [],
      annotationMode: false,
      annotationsVisible: true,
      isOverlap: false,
      plotMode: tab.plotMode || 'time',
      fftOptions: tab.fftOptions || {
        range: 'view',
        window: 'hann',
        scale: 'db',
        zeroPadding: 1,
        removeDC: true,
      },
      motorConfig: tab.motorConfig || { rpm: null, polePairs: null, enabled: false },
      triggerConfig: tab.triggerConfig || {
        enabled: false,
        channelId: tab.drawOrder[0] || '',
        type: 'rising',
        level: 0,
        positionPercent: 50,
      },
      measurementGate: 'view',
      separateView: !!tab.separateView,
    };
  });

  return {
    tabs: restoredTabs,
    activeTabIndex: session.activeTabIndex || 0,
  };
}
