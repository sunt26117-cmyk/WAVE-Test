/**
 * Waveform Viewer Pro - Core Type Definitions
 * Unified engineering data models for Web Oscilloscope & Waveform Analyzer.
 */

export type TimeQualityStatus = 'uniform' | 'non-uniform' | 'severe-jitter';

export interface SamplingMetadata {
  /** Distinguishes acquired instrument data from analytical/model-generated samples. */
  dataProvenance?: 'measured' | 'derived_estimate' | 'synthetic_steady_state' | 'simulated_switching' | 'synthetic_assumed_uncalibrated';
  sourceModel?: string;
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
  signalNanCount?: number;
  duplicateTimeCount?: number;
  nonMonotonicCount?: number;
  rawGapCount?: number;
  resampledFromNonUniform?: boolean;
  syntheticClockUsed?: boolean;
  /** User-requested thinning rate; selected measured timestamps remain authoritative. */
  requestedSampleRateHz?: number;
  /** Number of source rows intentionally omitted by time-domain thinning. */
  decimatedSampleCount?: number;
  /** True when only existing source rows were retained (no interpolation). */
  sourceRowsDecimated?: boolean;
  /** Preview thinning counts are based on a bounded row scan, not the full file. */
  decimationCountEstimated?: boolean;
}

export type ChannelCoupling = 'DC' | 'AC';
export type RenderMode = 'vector' | 'sinc' | 'dots' | 'vector-markers';
export type DecimationMode = 'minmax' | 'lttb';

export type MeasurementMetricKey =
  | 'max'
  | 'min'
  | 'vpp'
  | 'average'
  | 'absAverage'
  | 'rms'
  | 'vtop'
  | 'vbase'
  | 'overshoot'
  | 'frequency'
  | 'period'
  | 'riseTime'
  | 'fallTime'
  | 'posWidth'
  | 'negWidth'
  | 'dutyCycle'
  | 'maxDutyCycle'
  | 'minDutyCycle';

export type CustomMeasurementUnitType = 'signal' | 'percent' | 'freq' | 'time' | 'ratio' | 'custom';

export interface CustomMeasurementDefinition {
  id: string;
  label: string;
  shortLabel: string;
  expression: string;
  unitType: CustomMeasurementUnitType;
  customUnit?: string;
}

export interface SelectedMeasurementItem {
  id: string;
  channelId: string;
  metric: MeasurementMetricKey | string;
}

export type ThemeId = 'obsidian' | 'midnight' | 'daylight';
export type ChannelKind = 'raw' | 'computed';
export type DerivedKind = 'math' | 'filter' | 'transform' | 'power' | 'diff' | 'ref';

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
  channelKind?: ChannelKind;
  derivedKind?: DerivedKind;
  derivedBadge?: string;
  ltspiceStepLabel?: string;
  mathExpression?: string;
  sourceChannelIds: string[];

  // Data quality and provenance
  metadata: SamplingMetadata;

  // Unmodified raw source data (for auditing, export, and re-resampling)
  rawT?: Float64Array;
  rawV?: Float32Array;

  // Locked Reference waveform before user edits (for same-screen Ref & Diff comparison)
  refV?: Float32Array;
  hasEdits?: boolean;
  showRef?: boolean;
  showDiff?: boolean;

  // Real-time interactive horizontal time shift Δt relative to immutable timeShiftBaseT
  timeShiftSec?: number;
  timeShiftBaseT?: Float64Array;

  // Vertical scaling limits (8 divisions total: vMin = -4*voltsPerDiv - vOffset, vMax = +4*voltsPerDiv - vOffset)
  vMin: number;
  vMax: number;

  // Authentic oscilloscope vertical controls
  voltsPerDiv?: number;
  vOffset?: number; // Vertical position in signal units (positive shifts waveform UP; 0 = ground centered)
  inverted?: boolean;
  coupling?: ChannelCoupling;

  // Multi-waveform comparison group visual binding
  compareGroupId?: string;
  compareGroupName?: string;
  compareGroupColor?: string;
  compareRole?: 'target' | 'ref' | 'diff';
}

export type PlotMode = 'time' | 'frequency' | 'xy';

export interface XYConfig {
  xChannelId: string;
  yChannelId: string;
  range: 'view' | 'cursors' | 'entire';
}

export interface GoldenBandConfig {
  enabled: boolean;
  channelId: string;
  mode: 'percent' | 'absolute';
  tolerance: number;
  refLabel?: string;
  refUnit?: string;
  minCoveragePct?: number;
  refT?: Float64Array;
  refV?: Float32Array;
  /** Optional exact union-of-source-knots grid for cross-rate golden tolerance evaluation. */
  metricT?: Float64Array;
  metricTargetV?: Float64Array;
  metricRefV?: Float64Array;
  metricIntervalValid?: Uint8Array;
  removeDcOffset?: boolean;
}

export interface AnomalyEvent {
  index: number;
  time: number;
  value: number;
  kind: 'over' | 'under' | 'dvdt' | 'edge-gap';
  detail: string;
}

export interface WorkbenchPreset {
  id: string;
  name: string;
  createdAt: string;
  separateView: boolean;
  renderMode: RenderMode;
  decimationMode: DecimationMode;
  measurementGate: MeasurementGate;
  mathDefs: Array<{ name: string; expr: string; color: string }>;
  selectedMetricsByIndex: Array<{ chIdx: number; metric: MeasurementMetricKey | string }>;
  triggerRule?: { chIdx: number; type: TriggerType; positionPercent: number };
}

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
  db: number; // dBV or dB
  isFundamental?: boolean;
  order?: number; // harmonic order
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
  dbYMin?: number;
  dbYMax?: number;
  magYMin?: number;
  magYMax?: number;
  cappedWarning?: string;
  sourceUnit?: string;
  nonUniformWarning?: string;
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

  // Voltage / amplitude statistics
  max: number | null;
  min: number | null;
  average: number | null;
  absAverage: number | null;
  rms: number | null;
  vpp: number | null;
  peak: number | null;
  vtop: number | null;
  vbase: number | null;
  overshoot: number | null; // %
  undershoot: number | null; // %

  // Pulse & timing statistics
  period: number | null;
  frequency: number | null;
  dutyCycle: number | null; // %
  maxDutyCycle: number | null; // %
  minDutyCycle: number | null; // %
  riseTime: number | null; // s (10% to 90%)
  fallTime: number | null; // s (90% to 10%)
  posWidth: number | null; // s (+Width at 50%)
  negWidth: number | null; // s (-Width at 50%)

  valid?: boolean;
  status?: 'OK' | 'INVALID' | 'INSUFFICIENT_DATA' | 'NO_OVERLAP';
  coveragePct?: number;
  gapCount?: number;
  invalidSampleCount?: number;
  statusMessage?: string;
}

export type CursorMode = 'off' | 'x' | 'y' | 'xy' | 'track';

export interface CursorsState {
  enabled: boolean;
  mode?: CursorMode;
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

export type ActiveTool = 'pan' | 'areaZoom' | 'pointAnnotate' | 'textAnnotate' | 'areaAnnotate';

export interface ViewState {
  startIndex: number;
  endIndex: number;
  fMin?: number;
  fMax?: number;
}

export interface TabState {
  id: string;
  fileName: string;
  fileFingerprint?: string;
  channels: Record<string, WaveformChannel>;
  drawOrder: string[];
  view: ViewState;
  cursors: CursorsState;
  annotations: AnnotationItem[];
  annotationMode: boolean;
  annotationsVisible: boolean;
  isOverlap: boolean;
  plotMode: PlotMode;
  renderMode?: RenderMode;
  decimationMode?: DecimationMode;
  fftOptions: FFTOptions;
  motorConfig: MotorConfig;
  triggerConfig: TriggerConfig;
  measurementGate: MeasurementGate;
  selectedMeasurements?: SelectedMeasurementItem[];
  customMeasurements?: CustomMeasurementDefinition[];
  separateView: boolean;
  selectedMeasurementChannelId?: string;
  selectedFftChannelId?: string;
  activeChannelId?: string;
  activeTool?: ActiveTool;
  xyConfig?: XYConfig;
  goldenBand?: GoldenBandConfig;
  activeAnomalies?: AnomalyEvent[];
  selectedAnomalyIndex?: number | null;
}

export interface CsvColumnMapping {
  index: number;
  header: string;
  role: 'time' | 'channel' | 'ignore';
  channelName: string;
  unit: string;
}

export interface CsvPreviewInfo {
  headers: string[];
  delimiter: string;
  rows: string[][];
  totalRows: number;
  hasHeader: boolean;
  skipLines?: number;
  timeColIndex: number;
  timeUnit: 's' | 'ms' | 'us' | 'ns' | 'ps';
  sampleRateOverrideHz?: number | null;
  columnMappings: CsvColumnMapping[];
  quality: SamplingMetadata | null;
}

export interface ChannelFilterSpec {
  cutoffHz: number;
  order: 1 | 2 | 4;
  zeroPhase: boolean;
}
