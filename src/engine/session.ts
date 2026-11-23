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
  CustomMeasurementDefinition,
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
    customMeasurements?: CustomMeasurementDefinition[];
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
      customMeasurements: tab.customMeasurements || [],
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
  let rawSession: unknown;
  try {
    rawSession = JSON.parse(jsonStr);
  } catch (err: any) {
    throw new Error(`Invalid .graphx JSON: ${err?.message || String(err)}`);
  }

  if (!rawSession || typeof rawSession !== 'object' || Array.isArray(rawSession)) {
    throw new Error('Corrupted .graphx file: root must be a JSON object.');
  }

  const session = rawSession as Partial<SerializedSession>;
  if (typeof session.version !== 'number' || !Number.isFinite(session.version) || session.version < 1 || session.version > 4) {
    throw new Error(`Unsupported .graphx session version: ${String(session.version)}`);
  }
  if (!Array.isArray(session.tabs) || session.tabs.length === 0) {
    throw new Error('Corrupted .graphx file: session contains no tabs.');
  }

  const restoredTabs: TabState[] = session.tabs.map((tab, tabIdx) => {
    if (!tab || typeof tab !== 'object' || !tab.channels || typeof tab.channels !== 'object') {
      throw new Error(`Corrupted .graphx file: tab #${tabIdx + 1} is malformed.`);
    }

    const channels: Record<string, WaveformChannel> = {};

    for (const [id, sCh] of Object.entries(tab.channels)) {
      if (!sCh || typeof sCh !== 'object') {
        throw new Error(`Corrupted channel entry "${id}" in tab #${tabIdx + 1}.`);
      }
      if (!Array.isArray(sCh.t) || !Array.isArray(sCh.v) || sCh.t.length === 0 || sCh.t.length !== sCh.v.length) {
        throw new Error(`Corrupted sample arrays for channel "${sCh.name || id}" (t/v length mismatch or empty).`);
      }
      const refV =
        Array.isArray(sCh.refV) && sCh.refV.length === sCh.t.length
          ? new Float32Array(sCh.refV.map((n) => (typeof n === 'number' ? n : NaN)))
          : undefined;

      const tArr = new Float64Array(sCh.t.length);
      for (let i = 0; i < sCh.t.length; i++) {
        const tv = Number(sCh.t[i]);
        if (!Number.isFinite(tv)) {
          throw new Error(`Corrupted non-finite timestamp in channel "${sCh.name || id}" at index ${i}.`);
        }
        tArr[i] = tv;
      }
      const vArr = new Float32Array(sCh.v.length);
      for (let i = 0; i < sCh.v.length; i++) {
        const vv = sCh.v[i];
        vArr[i] = vv === null || vv === undefined ? NaN : Number(vv);
      }

      const ch: WaveformChannel = {
        id: String(sCh.id || id),
        name: String(sCh.name || id),
        unit: typeof sCh.unit === 'string' ? sCh.unit : 'V',
        color: typeof sCh.color === 'string' ? sCh.color : '#22d3ee',
        visible: sCh.visible !== false,
        isMath: !!sCh.isMath,
        mathExpression: typeof sCh.mathExpression === 'string' ? sCh.mathExpression : undefined,
        sourceChannelIds: Array.isArray(sCh.sourceChannelIds) ? sCh.sourceChannelIds.map(String) : [],
        vMin: Number.isFinite(Number(sCh.vMin)) ? Number(sCh.vMin) : -1,
        vMax: Number.isFinite(Number(sCh.vMax)) ? Number(sCh.vMax) : 1,
        voltsPerDiv: sCh.voltsPerDiv,
        vOffset: sCh.vOffset,
        inverted: !!sCh.inverted,
        coupling: sCh.coupling === 'AC' ? 'AC' : 'DC',
        fs: typeof sCh.fs === 'number' && Number.isFinite(sCh.fs) ? sCh.fs : null,
        dt: typeof sCh.dt === 'number' && Number.isFinite(sCh.dt) ? sCh.dt : null,
        metadata: sCh.metadata || {},
        t: tArr,
        v: vArr,
        refV,
        hasEdits: !!sCh.hasEdits,
        showRef: sCh.showRef !== undefined ? !!sCh.showRef : true,
        showDiff: !!sCh.showDiff,
      };
      ensureChannelScaleOffset(ch);
      syncChannelBoundsFromScaleOffset(ch);
      channels[id] = ch;
    }

    const channelKeys = Object.keys(channels);
    if (channelKeys.length === 0) {
      throw new Error(`Corrupted .graphx file: tab "${tab.fileName || tabIdx + 1}" has zero channels.`);
    }

    const safeDrawOrder = Array.isArray(tab.drawOrder)
      ? tab.drawOrder.filter((cid) => typeof cid === 'string' && Boolean(channels[cid]))
      : [];
    const drawOrder = safeDrawOrder.length > 0 ? safeDrawOrder : channelKeys;

    // Deterministically recompute Math channels if expression is present
    for (const [id, ch] of Object.entries(channels)) {
      if (ch.isMath && ch.mathExpression) {
        try {
          const recomputed = evaluateMathExpression(
            ch.mathExpression,
            channels,
            drawOrder,
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

    const primaryLen = channels[drawOrder[0]].t.length;
    const rawStart = Number(tab.view?.startIndex);
    const rawEnd = Number(tab.view?.endIndex);
    const safeStart = Number.isFinite(rawStart) ? rawStart : 0;
    const safeEnd = Number.isFinite(rawEnd) && rawEnd > safeStart ? rawEnd : Math.max(1, primaryLen - 1);

    const safeCustomMeasurements: CustomMeasurementDefinition[] = Array.isArray(tab.customMeasurements)
      ? tab.customMeasurements
          .filter(
            (cm) =>
              cm &&
              typeof cm.id === 'string' &&
              typeof cm.label === 'string' &&
              typeof cm.expression === 'string' &&
              cm.expression.trim().length > 0
          )
          .map((cm) => ({
            id: cm.id,
            label: cm.label.trim(),
            shortLabel: (cm.shortLabel || cm.label).trim().slice(0, 12),
            expression: cm.expression.trim(),
            unitType: cm.unitType || 'signal',
            customUnit: cm.customUnit,
          }))
      : [];

    const safeSelectedMeasurements = Array.isArray(tab.selectedMeasurements)
      ? tab.selectedMeasurements.filter(
          (sm) => sm && typeof sm.channelId === 'string' && Boolean(channels[sm.channelId]) && typeof sm.metric === 'string'
        )
      : [];

    const pickValidCh = (candidate?: string, fallback?: string) =>
      candidate && channels[candidate] ? candidate : fallback && channels[fallback] ? fallback : drawOrder[0];

    return {
      id: String(tab.id || `tab_restored_${tabIdx}`),
      fileName: String(tab.fileName || `Session_${tabIdx + 1}`),
      channels,
      drawOrder,
      view: {
        startIndex: safeStart,
        endIndex: safeEnd,
        fMin: typeof tab.view?.fMin === 'number' ? tab.view.fMin : undefined,
        fMax: typeof tab.view?.fMax === 'number' ? tab.view.fMax : undefined,
      },
      cursors: {
        ...rawCursors,
        mode: cursorMode,
        enabled: cursorMode !== 'off',
      },
      annotations: Array.isArray(tab.annotations) ? tab.annotations : [],
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
      triggerConfig: tab.triggerConfig
        ? {
            ...tab.triggerConfig,
            channelId: pickValidCh(tab.triggerConfig.channelId),
          }
        : {
            enabled: false,
            channelId: drawOrder[0] || '',
            type: 'rising',
            level: 0,
            positionPercent: 50,
          },
      measurementGate: tab.measurementGate || 'view',
      selectedMeasurements: safeSelectedMeasurements,
      customMeasurements: safeCustomMeasurements,
      separateView: !!tab.separateView,
      activeChannelId: pickValidCh(tab.activeChannelId),
      selectedMeasurementChannelId: pickValidCh(tab.selectedMeasurementChannelId),
      selectedFftChannelId: pickValidCh(tab.selectedFftChannelId),
      activeTool: 'pan',
      xyConfig: tab.xyConfig
        ? {
            xChannelId: pickValidCh(tab.xyConfig.xChannelId),
            yChannelId: pickValidCh(tab.xyConfig.yChannelId, drawOrder[1] || drawOrder[0]),
            range: tab.xyConfig.range || 'view',
          }
        : {
            xChannelId: drawOrder[0] || '',
            yChannelId: drawOrder[1] || drawOrder[0] || '',
            range: 'view',
          },
    };
  });

  const rawIdx = typeof session.activeTabIndex === 'number' && Number.isFinite(session.activeTabIndex)
    ? Math.floor(session.activeTabIndex)
    : 0;
  const activeTabIndex = Math.max(0, Math.min(restoredTabs.length - 1, rawIdx));

  return {
    tabs: restoredTabs,
    activeTabIndex,
  };
}
