/**
 * Waveform Viewer Pro - Session Serialization & Deserialization
 * Saves and restores .graphx files containing channels (including V/div, offset,
 * AC/DC coupling, inversion), views, cursors, annotations, math definitions, and FFT/Motor configuration.
 */

import {
  TabState,
  WaveformChannel,
  AnnotationItem,
  ChannelCoupling,
  RenderMode,
  DecimationMode,
  SelectedMeasurementItem,
  PlotMode,
  XYConfig,
} from '../types/models';
import { evaluateMathExpression } from '../modules/mathParser';
import { ensureChannelScaleOffset, syncChannelBoundsFromScaleOffset } from '../modules/oscilloscopeScale';

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
  voltsPerDiv?: number;
  vOffset?: number;
  inverted?: boolean;
  coupling?: ChannelCoupling;
  fs: number | null;
  dt: number | null;
  metadata: any;
  t: number[];
  v: number[];
  refV?: number[];
  hasEdits?: boolean;
  showRef?: boolean;
  showDiff?: boolean;
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
    annotationsVisible?: boolean;
    plotMode: PlotMode;
    renderMode?: RenderMode;
    decimationMode?: DecimationMode;
    fftOptions: any;
    motorConfig: any;
    triggerConfig: any;
    measurementGate?: 'view' | 'cursors' | 'entire';
    selectedMeasurements?: SelectedMeasurementItem[];
    separateView: boolean;
    activeChannelId?: string;
    selectedMeasurementChannelId?: string;
    selectedFftChannelId?: string;
    xyConfig?: XYConfig;
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
        voltsPerDiv: ch.voltsPerDiv,
        vOffset: ch.vOffset,
        inverted: ch.inverted,
        coupling: ch.coupling,
        fs: ch.fs,
        dt: ch.dt,
        metadata: ch.metadata,
        t: tArr,
        v: vArr,
        refV: ch.refV ? Array.from(ch.refV) : undefined,
        hasEdits: ch.hasEdits,
        showRef: ch.showRef,
        showDiff: ch.showDiff,
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
      annotationsVisible: tab.annotationsVisible,
      plotMode: tab.plotMode,
      renderMode: tab.renderMode || 'vector',
      decimationMode: tab.decimationMode || 'minmax',
      fftOptions: tab.fftOptions,
      motorConfig: tab.motorConfig,
      triggerConfig: tab.triggerConfig,
      measurementGate: tab.measurementGate,
      selectedMeasurements: tab.selectedMeasurements || [],
      separateView: tab.separateView,
      activeChannelId: tab.activeChannelId,
      selectedMeasurementChannelId: tab.selectedMeasurementChannelId,
      selectedFftChannelId: tab.selectedFftChannelId,
      xyConfig: tab.xyConfig,
    };
  });

  const sessionObj: SerializedSession = {
    version: 4,
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
      const ch: WaveformChannel = {
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
        voltsPerDiv: sCh.voltsPerDiv,
        vOffset: sCh.vOffset,
        inverted: !!sCh.inverted,
        coupling: sCh.coupling || 'DC',
        fs: sCh.fs,
        dt: sCh.dt,
        metadata: sCh.metadata,
        t: new Float64Array(sCh.t),
        v: new Float32Array(sCh.v),
        refV: sCh.refV ? new Float32Array(sCh.refV) : undefined,
        hasEdits: !!sCh.hasEdits,
        showRef: sCh.showRef !== undefined ? sCh.showRef : true,
        showDiff: !!sCh.showDiff,
      };
      ensureChannelScaleOffset(ch);
      syncChannelBoundsFromScaleOffset(ch);
      channels[id] = ch;
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
          recomputed.color = ch.color;
          recomputed.visible = ch.visible;
          recomputed.voltsPerDiv = ch.voltsPerDiv;
          recomputed.vOffset = ch.vOffset;
          recomputed.inverted = ch.inverted;
          recomputed.coupling = ch.coupling;
          ensureChannelScaleOffset(recomputed);
          syncChannelBoundsFromScaleOffset(recomputed);
          channels[id] = recomputed;
        } catch (e) {
          console.warn(`Could not re-evaluate math expression for ${id}:`, e);
        }
      }
    }

    const rawCursors = tab.cursors || {
      enabled: false,
      mode: 'off',
      x1: null,
      x2: null,
      y1: null,
      y2: null,
      trackingChannel: null,
    };
    const cursorMode = rawCursors.mode || (rawCursors.enabled ? 'x' : 'off');

    return {
      id: tab.id,
      fileName: tab.fileName,
      channels,
      drawOrder: tab.drawOrder,
      view: tab.view,
      cursors: {
        ...rawCursors,
        mode: cursorMode,
        enabled: cursorMode !== 'off',
      },
      annotations: tab.annotations || [],
      annotationMode: false,
      annotationsVisible: tab.annotationsVisible !== false,
      isOverlap: false,
      plotMode: tab.plotMode || 'time',
      renderMode: tab.renderMode || 'vector',
      decimationMode: tab.decimationMode || 'minmax',
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
      measurementGate: tab.measurementGate || 'view',
      selectedMeasurements: tab.selectedMeasurements || [],
      separateView: !!tab.separateView,
      activeChannelId: tab.activeChannelId || tab.drawOrder[0],
      selectedMeasurementChannelId: tab.selectedMeasurementChannelId || tab.drawOrder[0],
      selectedFftChannelId: tab.selectedFftChannelId || tab.drawOrder[0],
      activeTool: 'pan',
      xyConfig: tab.xyConfig || {
        xChannelId: tab.drawOrder[0] || '',
        yChannelId: tab.drawOrder[1] || tab.drawOrder[0] || '',
        range: 'view',
      },
    };
  });

  return {
    tabs: restoredTabs,
    activeTabIndex: session.activeTabIndex || 0,
  };
}
