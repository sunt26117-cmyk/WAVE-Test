/**
 * Waveform Viewer Pro - Core Type Definitions
 * Unified engineering data models for Web Oscilloscope & Waveform Analyzer.
 */

export type TimeQualityStatus = 'uniform' | 'non-uniform' | 'severe-jitter';

export interface SamplingMetadata {
  originalSampleCount: number;
  originalTimeStart: number;
  originalTimeEnd: number;
  isUniformSampling: boolean;
  nominalDt: number | null;
  medianDt: number | null;
  meanDt: number | null;
  minDt: number | null;
  maxDt: number | null;
  jitterRms: number | null;
  jitterMax: number | null;
  droppedSamples: number;
  invalidSamples: number;
  sampleRate: number | null; // in S/s
  qualityStatus: TimeQualityStatus;
  gapCount: number;
  gapIndices: number[];
}

export interface WaveformChannel {
  id: string;
  name: string;
  unit: string;
  color: string;
  visible: boolean;

  // Primary data arrays (Float64 for high-precision time, Float32 for voltages)
  t: Float64Array;
  v: Float32Array;

  fs: number | null; // Sampling frequency in Hz (null if non-uniform)
  dt: number | null; // Sampling interval in seconds

  isMath: boolean;
  mathExpression?: string;
  sourceChannelIds: string[];

  // Data quality and provenance
  metadata: SamplingMetadata;

  // Unmodified raw source data (for auditing, export, and re-resampling)
  rawT?: Float64Array;
  rawV?: Float32Array;

  // Vertical scaling limits
  vMin: number;
  vMax: number;
  vPerDiv?: number; // Volts per division (e.g. 8 vertical divisions)
  vOffset?: number; // Vertical offset in Volts
}

export type PlotMode = 'time' | 'frequency';

export type FFTWindowType = 'rectangular' | 'hann' | 'hamming' | 'blackman-harris';
export type FFTScaleType = 'magnitude' | 'db';
export type FFTRangeType = 'entire' | 'view' | 'cursors';
export type ZeroPaddingFactor = 1 | 2 | 4 | 8;

export interface FFTOptions {
  range: FFTRangeType;
  window: FFTWindowType;
  scale: FFTScaleType;
  zeroPadding: ZeroPaddingFactor;
  removeDC: boolean;
  peakThresholdDb?: number;
  minPeakDistanceHz?: number;
  maxPeaks?: number;
}

export interface SpectrumPeak {
  frequency: number; // Hz
  magnitude: number; // V (peak)
  db: number;        // dBV or dB
  isFundamental?: boolean;
  order?: number;    // harmonic order
}

export interface HarmonicMarker {
  order: number;
  label: string;
  frequency: number;
}

export interface SpectrumResult {
  frequencies: Float32Array;
  magnitudes: Float32Array;
  dbValues: Float32Array;
  sourceChannelId: string;
  sourceChannelName: string;
  sampleRate: number;
  fftSize: number;
  resolution: number; // df = fs / N
  coherentGain: number;
  window: FFTWindowType;
  peaks: SpectrumPeak[];
  startTime: number;
  endTime: number;
  sampleCount: number;
  yMin?: number;
  yMax?: number;
}

export interface MotorConfig {
  rpm: number | null;
  polePairs: number | null;
  enabled: boolean;
}

export type TriggerType = 'rising' | 'falling';

export interface TriggerConfig {
  enabled: boolean;
  channelId: string;
  type: TriggerType;
  level: number;
  positionPercent: number; // e.g. 50%
}

export type MeasurementGate = 'view' | 'cursors' | 'entire';

export interface ChannelMeasurements {
  channelId: string;
  channelName: string;
  unit: string;
  gate: MeasurementGate;
  sampleCount: number;
  timeStart: number;
  timeEnd: number;

  // Basic statistics
  max: number | null;
  min: number | null;
  average: number | null;
  rms: number | null;
  vpp: number | null;
  peak: number | null;

  // Pulse & timing statistics
  period: number | null;
  frequency: number | null;
  dutyCycle: number | null; // %
  riseTime: number | null;  // s (10% to 90%)
  fallTime: number | null;  // s (90% to 10%)
  overshoot: number | null; // %
  undershoot: number | null;// %

  statusMessage?: string;
}

export type CursorType = 'x' | 'y' | 'xy';

export interface CursorsState {
  enabled: boolean;
  type?: CursorType; // 'x' | 'y' | 'xy'
  x1: number | null;
  x2: number | null;
  y1: number | null;
  y2: number | null;
  trackingChannel: string | null;
}

export interface AnnotationItem {
  id: string;
  type: 'point' | 'text' | 'area';
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  text?: string;
  channelId?: string;
  color?: string;
}

export interface ViewState {
  startIndex: number;
  endIndex: number;
  // For frequency domain zoom
  fMin?: number;
  fMax?: number;
}

export interface TabState {
  id: string;
  fileName: string;
  channels: Record<string, WaveformChannel>;
  drawOrder: string[];
  view: ViewState;
  cursors: CursorsState;
  annotations: AnnotationItem[];
  annotationMode: boolean;
  annotationsVisible: boolean;
  isOverlap: boolean;
  plotMode: PlotMode;
  fftOptions: FFTOptions;
  motorConfig: MotorConfig;
  triggerConfig: TriggerConfig;
  measurementGate: MeasurementGate;
  separateView: boolean;
  selectedMeasurementChannelId?: string;
  selectedFftChannelId?: string;
}

export interface CsvColumnMapping {
  index: number;
  header: string;
  role: 'time' | 'channel' | 'ignore';
  channelName: string;
  unit: string;
}

export interface CsvPreviewInfo {
  /** True when the source contained a textual header row. */
  hasHeader: boolean;
  headers: string[];
  delimiter: string;
  rows: string[][];
  totalRows: number;
  timeColIndex: number;
  timeUnit: 's' | 'ms' | 'us' | 'ns';
  columnMappings: CsvColumnMapping[];
  quality: SamplingMetadata | null;
}
