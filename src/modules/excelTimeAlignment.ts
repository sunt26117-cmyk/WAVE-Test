import type { WaveformChannel } from '../types/models';

export type ExcelMergeTimeMode = 'preserve' | 'align-start' | 'auto-best';
export type ExcelTimeOriginKind = 'absolute-date' | 'clock-of-day' | 'numeric' | 'synthetic';

export interface ExcelMergeSource {
  fileName: string;
  sheetName: string;
  channels: Record<string, WaveformChannel>;
  drawOrder: string[];
  timeOriginSec?: number | null;
  timeOriginKind?: ExcelTimeOriginKind;
}

export interface ExcelMergedTimeAuditRow {
  id: string;
  label: string;
  sampleCount: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  medianDtSec: number | null;
  jitterMaxPct: number | null;
  monotonic: boolean;
  originKind: ExcelTimeOriginKind;
}

export interface ExcelMergedChannelsResult {
  channels: Record<string, WaveformChannel>;
  drawOrder: string[];
  maxPoints: number;
  audit: ExcelMergedTimeAuditRow[];
  commonStartSec: number | null;
  commonEndSec: number | null;
  commonOverlapSec: number;
  minimumOverlapPct: number;
  hasCommonOverlap: boolean;
  /** False when preserving source time would mix unrelated coordinate systems or per-file synthetic clocks. */
  canMergePreservingTime: boolean;
  warnings: string[];
}

export interface ExcelMergedViewport {
  primaryChannelId: string;
  startIndex: number;
  endIndex: number;
  unionStartSec: number;
  unionEndSec: number;
}

/**
 * Resolve the initial time viewport from real timestamps, never from max sample count.
 * The channel with the earliest start (and longest span among ties) anchors the X axis;
 * the view is expanded through the union of all source time ranges.
 */
export function resolveExcelMergedViewport(result: ExcelMergedChannelsResult): ExcelMergedViewport | null {
  const validRows = result.audit.filter((row) => row.sampleCount >= 2 && row.monotonic &&
    Number.isFinite(row.startSec) && Number.isFinite(row.endSec) && row.endSec > row.startSec);
  if (!validRows.length) return null;
  const unionStartSec = Math.min(...validRows.map((row) => row.startSec));
  const unionEndSec = Math.max(...validRows.map((row) => row.endSec));
  const primaryRow = validRows
    .filter((row) => Math.abs(row.startSec - unionStartSec) <= Math.max(1e-12, Math.abs(unionStartSec) * 1e-12))
    .sort((a, b) => b.durationSec - a.durationSec || (a.medianDtSec ?? Infinity) - (b.medianDtSec ?? Infinity))[0];
  if (!primaryRow) return null;
  const primary = result.channels[primaryRow.id];
  if (!primary || primary.t.length < 2) return null;

  const lowerBound = (arr: Float64Array, value: number): number => {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const startIndex = Math.max(0, lowerBound(primary.t, unionStartSec) - 1);
  let endIndex: number;
  const lastT = primary.t[primary.t.length - 1];
  if (unionEndSec <= lastT) {
    endIndex = Math.max(startIndex + 2, lowerBound(primary.t, unionEndSec));
  } else {
    const medianDt = primaryRow.medianDtSec && primaryRow.medianDtSec > 0
      ? primaryRow.medianDtSec
      : primary.dt && primary.dt > 0
      ? primary.dt
      : (lastT - primary.t[0]) / (primary.t.length - 1);
    const extension = Math.ceil((unionEndSec - lastT) / Math.max(medianDt, 1e-15));
    endIndex = primary.t.length + Math.max(0, extension);
  }
  endIndex = Math.max(startIndex + 2, endIndex);
  return { primaryChannelId: primaryRow.id, startIndex, endIndex, unionStartSec, unionEndSec };
}

const DEFAULT_COLORS = ['#facc15', '#22d3ee', '#f472b6', '#4ade80', '#a78bfa', '#fb923c'];

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function buildAuditRow(
  id: string,
  label: string,
  t: Float64Array,
  originKind: ExcelTimeOriginKind
): ExcelMergedTimeAuditRow {
  const n = t.length;
  let monotonic = n >= 1;
  const diffs: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(t[i])) monotonic = false;
    if (i > 0) {
      const dt = t[i] - t[i - 1];
      if (!(dt > 0) || !Number.isFinite(dt)) monotonic = false;
      else diffs.push(dt);
    }
  }
  const med = median(diffs);
  let maxDeviation = 0;
  if (med && med > 0) {
    for (const dt of diffs) maxDeviation = Math.max(maxDeviation, Math.abs(dt - med));
  }
  const maxDev = med && med > 0 && diffs.length ? maxDeviation / med * 100 : null;
  const startSec = n ? t[0] : Number.NaN;
  const endSec = n ? t[n - 1] : Number.NaN;
  return {
    id,
    label,
    sampleCount: n,
    startSec,
    endSec,
    durationSec: n > 1 ? endSec - startSec : 0,
    medianDtSec: med,
    jitterMaxPct: maxDev,
    monotonic,
    originKind,
  };
}

/**
 * Combines independently sampled table traces without resampling or mutating source values.
 * - `preserve`: restores absolute Excel date-time / clock coordinates; numeric axes untouched; blocks mixed/multi-synthetic domains.
 * - `align-start`: translates every trace so its first sample is t=0.
 * - `auto-best`: anchors the X axis to the longest valid channel, preserves original time correspondence for
 *   same-domain overlapping traces, and translates non-overlapping / synthetic / cross-domain traces to match
 *   the anchor start (recording `timeShiftBaseT` and `timeShiftSec` for live Δt adjustment).
 */
export function mergeExcelChannelsByTime(
  items: ExcelMergeSource[],
  colors: string[] = DEFAULT_COLORS,
  timeMode: ExcelMergeTimeMode = 'preserve'
): ExcelMergedChannelsResult {
  const mergedChannels: Record<string, WaveformChannel> = {};
  const drawOrder: string[] = [];
  const audit: ExcelMergedTimeAuditRow[] = [];
  const warnings: string[] = [];
  const palette = colors.length ? colors : DEFAULT_COLORS;
  let maxPoints = 0;

  interface PreparedSourceChannel {
    item: ExcelMergeSource;
    sourceId: string;
    source: WaveformChannel;
    safeFileName: string;
    baseOffsetSec: number;
    baseStartSec: number;
    baseEndSec: number;
    durationSec: number;
    originKind: ExcelTimeOriginKind;
    monotonic: boolean;
    medianDtSec: number | null;
  }

  const prepared: PreparedSourceChannel[] = [];
  items.forEach((item, itemIndex) => {
    const safeFileName = item.fileName || `Workbook ${itemIndex + 1}`;
    const hasOrigin =
      (item.timeOriginKind === 'absolute-date' || item.timeOriginKind === 'clock-of-day') &&
      Number.isFinite(item.timeOriginSec);
    const baseOffsetSec = hasOrigin ? (item.timeOriginSec as number) : 0;
    const originKind: ExcelTimeOriginKind = item.timeOriginKind || 'numeric';

    item.drawOrder.forEach((sourceId) => {
      const source = item.channels[sourceId];
      if (!source) return;
      if (source.t.length !== source.v.length) {
        throw new Error(`${safeFileName} [${item.sheetName}] ${source.name}: 时间轴长度 ${source.t.length} 与数据长度 ${source.v.length} 不一致。`);
      }
      if (source.t.length === 0) {
        warnings.push(`${safeFileName} [${item.sheetName}] ${source.name}: 空通道已跳过。`);
        return;
      }

      const preAudit = buildAuditRow(sourceId, source.name, source.t, originKind);
      const baseStartSec = source.t[0] + baseOffsetSec;
      const baseEndSec = source.t[source.t.length - 1] + baseOffsetSec;
      prepared.push({
        item,
        sourceId,
        source,
        safeFileName,
        baseOffsetSec,
        baseStartSec,
        baseEndSec,
        durationSec: source.t.length > 1 ? baseEndSec - baseStartSec : 0,
        originKind,
        monotonic: preAudit.monotonic,
        medianDtSec: preAudit.medianDtSec,
      });
    });
  });

  // For 'auto-best', pick the longest valid monotonic trace as the horizontal axis anchor.
  let anchor: PreparedSourceChannel | null = null;
  if (timeMode === 'auto-best') {
    const candidates = prepared.filter(
      (p) =>
        p.source.t.length >= 2 &&
        p.monotonic &&
        Number.isFinite(p.baseStartSec) &&
        Number.isFinite(p.baseEndSec) &&
        p.durationSec > 0
    );
    if (candidates.length > 0) {
      candidates.sort(
        (a, b) =>
          b.durationSec - a.durationSec ||
          a.baseStartSec - b.baseStartSec ||
          (a.medianDtSec ?? Infinity) - (b.medianDtSec ?? Infinity)
      );
      anchor = candidates[0];
    }
  }

  let autoShiftedCount = 0;
  let preservedOverlapCount = 0;

  prepared.forEach((p) => {
    const { item, sourceId, source, safeFileName, baseOffsetSec, baseStartSec, baseEndSec } = p;
    const id = `${sourceId}_merged_${drawOrder.length}`;
    const label = item.sheetName && item.sheetName !== 'CSV'
      ? `[${safeFileName} · ${item.sheetName}] ${source.name}`
      : prepared.some((other) => other.safeFileName !== safeFileName)
      ? `[${safeFileName}] ${source.name}`
      : source.name;

    let alignShiftSec = 0;
    if (timeMode === 'align-start') {
      alignShiftSec = -baseStartSec;
    } else if (timeMode === 'auto-best' && anchor && p !== anchor) {
      const sameRealDomain =
        p.originKind === anchor.originKind && p.originKind !== 'synthetic';
      const hasRealOverlap =
        sameRealDomain &&
        Math.min(baseEndSec, anchor.baseEndSec) > Math.max(baseStartSec, anchor.baseStartSec);
      if (hasRealOverlap) {
        alignShiftSec = 0;
        preservedOverlapCount++;
      } else {
        alignShiftSec = anchor.baseStartSec - baseStartSec;
        if (Math.abs(alignShiftSec) > 1e-15) {
          autoShiftedCount++;
        }
      }
    }

    const totalOffsetSec =
      timeMode === 'align-start' ? -source.t[0] : baseOffsetSec + alignShiftSec;

    const baseT = new Float64Array(source.t.length);
    const t = new Float64Array(source.t.length);
    for (let i = 0; i < source.t.length; i++) {
      const restored = source.t[i] + (timeMode === 'align-start' ? -source.t[0] : baseOffsetSec);
      baseT[i] = restored;
      t[i] = source.t[i] + totalOffsetSec;
    }

    let rawT: Float64Array | undefined;
    if (source.rawT) {
      rawT = new Float64Array(source.rawT.length);
      for (let i = 0; i < source.rawT.length; i++) rawT[i] = source.rawT[i] + totalOffsetSec;
    }

    const hasUserAdjustShift = timeMode === 'auto-best' && Math.abs(alignShiftSec) > 1e-15;
    const cloned: WaveformChannel = {
      ...source,
      id,
      name: label,
      color: palette[drawOrder.length % palette.length] || source.color,
      t,
      rawT,
      timeShiftSec: hasUserAdjustShift ? alignShiftSec : 0,
      timeShiftBaseT: hasUserAdjustShift ? baseT : undefined,
    };
    mergedChannels[id] = cloned;
    drawOrder.push(id);
    maxPoints = Math.max(maxPoints, cloned.v.length);
    const rowOriginKind: ExcelTimeOriginKind =
      timeMode === 'align-start' || (timeMode === 'auto-best' && hasUserAdjustShift)
        ? 'numeric'
        : p.originKind;
    audit.push(buildAuditRow(id, label, t, rowOriginKind));
  });

  const validRows = audit.filter((row) => row.sampleCount >= 2 && row.monotonic && Number.isFinite(row.startSec) && Number.isFinite(row.endSec));
  const coordinateDomains = new Set(validRows.map((row) => row.originKind));
  const oneCoordinateDomain = coordinateDomains.size <= 1;
  const syntheticTimeCannotProveOverlap = timeMode === 'preserve' && coordinateDomains.has('synthetic');
  const overlapRows =
    timeMode === 'auto-best'
      ? validRows
      : oneCoordinateDomain && !syntheticTimeCannotProveOverlap
      ? validRows
      : [];
  const commonStartSec = overlapRows.length ? Math.max(...overlapRows.map((row) => row.startSec)) : null;
  const commonEndSec = overlapRows.length ? Math.min(...overlapRows.map((row) => row.endSec)) : null;
  const commonOverlapSec = commonStartSec !== null && commonEndSec !== null ? Math.max(0, commonEndSec - commonStartSec) : 0;
  const durationRows = overlapRows.filter((row) => row.durationSec > 0);
  const minimumOverlapPct = durationRows.length && commonOverlapSec > 0
    ? Math.min(...durationRows.map((row) => Math.min(100, commonOverlapSec / row.durationSec * 100)))
    : 0;
  const hasCommonOverlap =
    (timeMode === 'auto-best' || (oneCoordinateDomain && !syntheticTimeCannotProveOverlap)) &&
    overlapRows.length > 0 &&
    commonEndSec !== null &&
    commonStartSec !== null &&
    commonEndSec > commonStartSec;
  const activeSourceItems = items.filter((item) => item.drawOrder.some((id) => !!item.channels[id]?.t?.length));
  const multiSourceAxis = activeSourceItems.length > 1;
  const canMergePreservingTime =
    timeMode === 'auto-best' ||
    !(
      timeMode === 'preserve' && multiSourceAxis &&
      (!oneCoordinateDomain || syntheticTimeCannotProveOverlap)
    );

  if (audit.some((row) => !row.monotonic)) {
    warnings.push('至少一条合并通道的时间轴不是严格递增；请回到导入预览检查重复时间戳、乱序或无效时间。');
  }
  if (timeMode === 'auto-best') {
    if (autoShiftedCount > 0) {
      warnings.push(
        `已按最长波形建立时间轴：${preservedOverlapCount > 0 ? '保留了时间重叠通道的原始对应，' : ''}将 ${autoShiftedCount} 条时间起点不一致/合成时钟通道自动对齐到主起点，可在右侧面板直接微调 Δt。`
      );
    }
  } else {
    if (coordinateDomains.size > 1 && timeMode === 'preserve') {
      warnings.push('合并通道包含不同时间坐标类型（绝对日期、日内时刻、数值时间或合成时间）；未计算跨类型公共重叠，不能据此认定通道已同步。');
    } else if (syntheticTimeCannotProveOverlap) {
      warnings.push('所选工作表缺少真实时间列，合成采样时间仅表示各文件内部样本序号/采样率；不计算跨文件公共重叠，也不宣称同步。需要比较时请确认同触发起点后选择「首样本对齐」。');
    } else if (validRows.length > 1 && !hasCommonOverlap) {
      warnings.push('所选通道之间没有公共时间重叠区间；仍可同屏显示，但不能对无重叠区间进行有效 Compare。');
    }
    if (items.some((item) => item.timeOriginKind === 'clock-of-day') && timeMode === 'preserve') {
      warnings.push('至少一个文件只有 HH:MM:SS 时钟时间、没有日期；已保留秒/日坐标，但无法判断不同文件是否来自同一天或是否跨天。');
    }
    if (items.some((item) => item.timeOriginKind === 'synthetic')) {
      warnings.push(timeMode === 'align-start'
        ? '至少一个工作表使用合成采样时间；当前仅按首样本假定同一时刻，不证明各采集设备实际同时触发。'
        : '至少一个工作表没有可用时间列，使用合成采样时间；该通道不能据此与其他文件建立真实同步关系。');
    }
    if (timeMode === 'preserve' && coordinateDomains.size === 1 && coordinateDomains.has('numeric') && validRows.length > 1) {
      warnings.push('数值时间轴按导入的时间值计算重叠；若每个文件的 t=0 都是各自独立采集起点，数值重叠不等于实际同步，请确认共同触发基准。');
    }
    if (timeMode === 'align-start') {
      warnings.push('已按用户选择将每条通道首样本平移到 t=0；未进行插值或相位校正，默认首样本代表共同对齐点。');
    }
  }

  return {
    channels: mergedChannels,
    drawOrder,
    maxPoints,
    audit,
    commonStartSec,
    commonEndSec,
    commonOverlapSec,
    minimumOverlapPct,
    hasCommonOverlap,
    canMergePreservingTime,
    warnings: Array.from(new Set(warnings)),
  };
}
