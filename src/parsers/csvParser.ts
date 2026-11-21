/**
 * Waveform Viewer Pro - CSV & Clipboard Parser
 * Intelligent preamble/header detection, clock/ISO/numeric timestamp parsing,
 * live sampling quality audit, and Float64Array / Float32Array channel instantiation.
 */

import {
  WaveformChannel,
  CsvPreviewInfo,
  CsvColumnMapping,
  SamplingMetadata,
} from '../types/models';
import { analyzeSamplingQuality, getTimeUnitMultiplier } from '../modules/qualityCheck';
import { resampleUniform } from '../modules/resampler';

const TIME_HEADER_REGEX = /^(time|t|timestamp|date|datetime|time_s|time_ms|time_us|time_ns|time_ps|seconds|sec|t_sec|t_s|x)($|[\s_(\[])/i;

/**
 * Strips optional UTF-8 BOM from imported CSV text.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parses a numeric signal cell (supports scientific notation and optional trailing units like "1.25V").
 */
export function parseNumericCell(raw: string): number {
  const s = (raw || '').trim().replace(/^["']|["']$/g, '').trim();
  if (!s) return NaN;

  // Fast path pure numbers
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
    const v = Number(s);
    return isFinite(v) ? v : NaN;
  }

  // Tolerate trailing common engineering units (e.g. "3.30V", "-12.5 mV", "100uA")
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(?:m?V|uV|µV|kV|m?A|uA|µA|m?W|kW|Hz|kHz|MHz|GHz|Ω|ohm|deg|rad|%)$/i.exec(s);
  if (match) {
    const v = Number(match[1]);
    return isFinite(v) ? v : NaN;
  }

  return NaN;
}

/**
 * Parses a numeric or clock/ISO timestamp cell into raw time units (or epoch seconds for clock strings).
 */
export function parseTimeCell(raw: string): { value: number; isClock: boolean } {
  const s = (raw || '').trim().replace(/^["']|["']$/g, '').trim();
  if (!s) return { value: NaN, isClock: false };

  // Pure numeric (fast path, including scientific notation)
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
    return { value: Number(s), isClock: false };
  }

  // HH:MM:SS(.sss) clock format
  const hms = /^(\d{1,2}):(\d{2}):(\d{2})(\.\d+)?$/.exec(s);
  if (hms) {
    const h = parseInt(hms[1], 10);
    const m = parseInt(hms[2], 10);
    const sec = parseFloat(hms[3] + (hms[4] || ''));
    return { value: h * 3600 + m * 60 + sec, isClock: true };
  }

  // Full ISO / Date-Time string (e.g. 2026-11-19 08:00:01.250)
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(s)) {
    const ms = Date.parse(s);
    if (!isNaN(ms)) {
      return { value: ms / 1000, isClock: true };
    }
  }

  const fallback = parseNumericCell(s);
  return { value: isFinite(fallback) ? fallback : NaN, isClock: false };
}

/**
 * Checks whether a split CSV row is predominantly numeric data.
 */
function isNumericDataRow(fields: string[]): boolean {
  if (fields.length === 0) return false;
  let numericCount = 0;
  let nonEmptyCount = 0;
  for (let i = 0; i < fields.length; i++) {
    const cell = fields[i].trim();
    if (!cell) continue;
    nonEmptyCount++;
    const parsed = parseTimeCell(cell);
    if (!isNaN(parsed.value) && isFinite(parsed.value)) {
      numericCount++;
    }
  }
  return nonEmptyCount > 0 && numericCount >= Math.max(1, Math.ceil(nonEmptyCount * 0.6));
}

/**
 * Detects the most likely delimiter for the CSV text.
 */
export function detectDelimiter(text: string): string {
  const clean = stripBom(text);
  const allLines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0 && !l.trim().startsWith('#'));
  const firstLines = allLines.slice(-Math.min(allLines.length, 15));
  if (firstLines.length === 0) return ',';

  const candidates = [',', '\t', ';', ' '];
  let bestDelim = ',';
  let bestScore = -1;

  for (const delim of candidates) {
    const counts = firstLines.map((line) => {
      let count = 0;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === delim) count++;
      }
      return count;
    });

    const minCount = Math.min(...counts);
    const maxCount = Math.max(...counts);
    if (minCount > 0 && minCount === maxCount) {
      const score = minCount * 10;
      if (score > bestScore) {
        bestScore = score;
        bestDelim = delim;
      }
    } else if (minCount > 0 && maxCount - minCount <= 1) {
      const score = minCount * 5;
      if (score > bestScore) {
        bestScore = score;
        bestDelim = delim;
      }
    }
  }

  return bestDelim;
}

/**
 * Splits a CSV line taking quotes into account.
 */
export function splitCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Locates where the actual header + numeric table begins (skipping oscilloscope metadata preambles & comments).
 */
function findTableStart(lines: string[], delimiter: string): { skipLines: number; hasHeader: boolean } {
  const scanLimit = Math.min(lines.length, 40);
  let firstNumericIdx = -1;

  for (let i = 0; i < scanLimit; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const fields = splitCsvLine(trimmed, delimiter);
    if (isNumericDataRow(fields)) {
      firstNumericIdx = i;
      break;
    }
  }

  if (firstNumericIdx === -1) {
    return { skipLines: 0, hasHeader: true };
  }

  if (firstNumericIdx === 0) {
    return { skipLines: 0, hasHeader: false };
  }

  // Check if the line immediately preceding firstNumericIdx is a unit row (e.g. "s,V,V") with another header above it
  const dataCols = splitCsvLine(lines[firstNumericIdx], delimiter).length;
  const headerIdx = firstNumericIdx - 1;
  if (headerIdx >= 1) {
    const prevFields = splitCsvLine(lines[headerIdx], delimiter);
    const prevPrevFields = splitCsvLine(lines[headerIdx - 1], delimiter);
    const looksLikeUnits = prevFields.every((f) => /^[\[\(]?(s|ms|us|µs|ns|ps|v|mv|a|ma|hz|w|%)[\]\)]?$/i.test(f.trim()));
    if (looksLikeUnits && prevPrevFields.length >= dataCols) {
      return { skipLines: headerIdx - 1, hasHeader: true };
    }
  }

  return { skipLines: headerIdx, hasHeader: true };
}

/**
 * Computes SamplingMetadata preview from raw CSV text and current column/unit settings.
 */
export function computeCsvPreviewQuality(
  text: string,
  preview: CsvPreviewInfo,
  timeUnitOverride?: 's' | 'ms' | 'us' | 'ns' | 'ps',
  sampleRateOverrideHz?: number | null
): SamplingMetadata | null {
  const effectiveFs = sampleRateOverrideHz !== undefined ? sampleRateOverrideHz : preview.sampleRateOverrideHz;
  const clean = stripBom(text);
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const startLine = (preview.skipLines || 0) + (preview.hasHeader ? 1 : 0);
  const totalData = Math.max(0, lines.length - startLine);

  if (effectiveFs && effectiveFs > 0 && isFinite(effectiveFs)) {
    if (totalData < 2) return null;
    const dt = 1 / effectiveFs;
    const sampleCount = Math.min(totalData, 50000);
    const synthetic = new Float64Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      synthetic[i] = i * dt;
    }
    const meta = analyzeSamplingQuality(synthetic, 0);
    meta.originalSampleCount = totalData;
    meta.originalTimeEnd = (totalData - 1) * dt;
    meta.sampleRate = effectiveFs;
    meta.nominalDt = dt;
    meta.medianDt = dt;
    meta.meanDt = dt;
    return meta;
  }

  if (preview.timeColIndex < 0) return null;
  if (totalData < 2) return null;

  const maxScan = Math.min(lines.length, startLine + 50000);
  const mult = getTimeUnitMultiplier(timeUnitOverride || preview.timeUnit);
  const times: number[] = [];
  let baseClockT: number | null = null;
  let invalidCount = 0;

  for (let i = startLine; i < maxScan; i++) {
    const cols = splitCsvLine(lines[i], preview.delimiter);
    if (preview.timeColIndex >= cols.length) {
      invalidCount++;
      continue;
    }
    const parsed = parseTimeCell(cols[preview.timeColIndex]);
    if (isNaN(parsed.value) || !isFinite(parsed.value)) {
      invalidCount++;
      continue;
    }
    if (parsed.isClock) {
      if (baseClockT === null) baseClockT = parsed.value;
      times.push(parsed.value - baseClockT);
    } else {
      times.push(parsed.value * mult);
    }
  }

  if (times.length < 2) return null;
  times.sort((a, b) => a - b);
  return analyzeSamplingQuality(Float64Array.from(times), invalidCount);
}

/**
 * Parses initial CSV structure to generate preview information.
 */
export function previewCsv(text: string): CsvPreviewInfo {
  const clean = stripBom(text);
  const delimiter = detectDelimiter(clean);
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error('CSV file is empty.');
  }

  const { skipLines, hasHeader } = findTableStart(lines, delimiter);
  const headerOrFirstLine = splitCsvLine(lines[skipLines], delimiter);
  const dataStartLine = hasHeader ? skipLines + 1 : skipLines;

  const previewRows: string[][] = [];
  const maxPreview = Math.min(lines.length, dataStartLine + 25);
  for (let i = dataStartLine; i < maxPreview; i++) {
    const row = splitCsvLine(lines[i], delimiter);
    if (isNumericDataRow(row)) {
      previewRows.push(row);
    }
  }

  const colCount = Math.max(headerOrFirstLine.length, previewRows[0]?.length || 0);
  const headers: string[] = [];
  for (let idx = 0; idx < colCount; idx++) {
    if (!hasHeader) {
      headers.push(`Col_${idx + 1}`);
    } else {
      const h = headerOrFirstLine[idx];
      headers.push(h ? h.replace(/^["']|["']$/g, '').trim() : `Col_${idx + 1}`);
    }
  }

  // Detect time column index
  let timeColIndex = -1;
  if (headers.length >= 2) {
    for (let i = 0; i < headers.length; i++) {
      if (TIME_HEADER_REGEX.test(headers[i])) {
        timeColIndex = i;
        break;
      }
    }
  }

  // Detect time unit from header e.g. "Time (ms)" or "Time (ns)" or "Time (ps)"
  let timeUnit: 's' | 'ms' | 'us' | 'ns' | 'ps' = 's';
  if (timeColIndex >= 0) {
    const th = headers[timeColIndex].toLowerCase();
    if (th.includes('(ps)') || th.includes('[ps]') || th.includes('_ps')) timeUnit = 'ps';
    else if (th.includes('(ns)') || th.includes('[ns]') || th.includes('_ns')) timeUnit = 'ns';
    else if (th.includes('(us)') || th.includes('[us]') || th.includes('(µs)') || th.includes('[µs]') || th.includes('_us')) timeUnit = 'us';
    else if (th.includes('(ms)') || th.includes('[ms]') || th.includes('_ms')) timeUnit = 'ms';
    else if (th.includes('(s)') || th.includes('[s]') || th.includes('_s')) timeUnit = 's';
  }

  // If no explicit time column found and >= 2 columns, check if col 0 is strictly increasing
  if (timeColIndex === -1 && headers.length >= 2 && previewRows.length > 2) {
    let isNonDecreasing = true;
    let strictIncCount = 0;
    let prev = parseTimeCell(previewRows[0][0]).value;
    if (!isNaN(prev)) {
      for (let r = 1; r < previewRows.length; r++) {
        const cur = parseTimeCell(previewRows[r][0]).value;
        if (isNaN(cur) || cur < prev) {
          isNonDecreasing = false;
          break;
        }
        if (cur > prev) strictIncCount++;
        prev = cur;
      }
      if (isNonDecreasing && strictIncCount >= Math.max(1, Math.floor((previewRows.length - 1) * 0.5))) {
        timeColIndex = 0;
      }
    }
  }

  const columnMappings: CsvColumnMapping[] = headers.map((header, idx) => {
    if (idx === timeColIndex) {
      return {
        index: idx,
        header,
        role: 'time',
        channelName: 'Time',
        unit: timeUnit,
      };
    }
    return {
      index: idx,
      header,
      role: 'channel',
      channelName: header || `CH ${idx + 1}`,
      unit: 'V',
    };
  });

  const info: CsvPreviewInfo = {
    headers,
    delimiter,
    rows: previewRows,
    totalRows: Math.max(0, lines.length - dataStartLine),
    hasHeader,
    skipLines,
    timeColIndex,
    timeUnit,
    sampleRateOverrideHz: null,
    columnMappings,
    quality: null,
  };

  info.quality = computeCsvPreviewQuality(clean, info, timeUnit, null);
  return info;
}

export interface ParseCsvOptions {
  delimiter: string;
  hasHeader: boolean;
  skipLines?: number;
  timeColIndex: number;
  timeUnit: 's' | 'ms' | 'us' | 'ns' | 'ps';
  sampleRateOverrideHz?: number | null;
  columnMappings: CsvColumnMapping[];
  resample: boolean;
  colors: string[];
}

/**
 * Parses full CSV text with specified mappings and produces WaveformChannels.
 */
export function parseFullCsv(
  text: string,
  options: ParseCsvOptions
): {
  channels: Record<string, WaveformChannel>;
  drawOrder: string[];
  quality: any;
} {
  const clean = stripBom(text);
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error('File has no content.');

  const startIndex = (options.skipLines || 0) + (options.hasHeader ? 1 : 0);
  const numDataRows = lines.length - startIndex;
  if (numDataRows <= 0) throw new Error('No data rows found in CSV.');

  const timeMultiplier = getTimeUnitMultiplier(options.timeUnit);
  const overrideFs = options.sampleRateOverrideHz && options.sampleRateOverrideHz > 0 && isFinite(options.sampleRateOverrideHz)
    ? options.sampleRateOverrideHz
    : null;

  const rawTime = new Float64Array(numDataRows);
  const hasExplicitTime = options.timeColIndex >= 0 && overrideFs === null;
  let invalidRows = 0;
  let baseClockTime: number | null = null;

  const activeChannels = options.columnMappings.filter((m) => m.role === 'channel');
  if (activeChannels.length === 0) {
    throw new Error('No data channels selected for import.');
  }

  const rawValues: Float32Array[] = activeChannels.map(() => new Float32Array(numDataRows));

  let parsedRowIdx = 0;
  let needsSort = false;
  let prevTime = -Infinity;

  for (let lineIdx = startIndex; lineIdx < lines.length; lineIdx++) {
    const trimmed = lines[lineIdx].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const cols = splitCsvLine(trimmed, options.delimiter);

    let rowT = 0;
    if (overrideFs !== null) {
      rowT = parsedRowIdx / overrideFs;
    } else if (hasExplicitTime) {
      if (options.timeColIndex >= cols.length) {
        invalidRows++;
        continue;
      }
      const parsedT = parseTimeCell(cols[options.timeColIndex]);
      if (isNaN(parsedT.value) || !isFinite(parsedT.value)) {
        invalidRows++;
        continue;
      }
      if (parsedT.isClock) {
        if (baseClockTime === null) baseClockTime = parsedT.value;
        rowT = parsedT.value - baseClockTime;
      } else {
        rowT = parsedT.value * timeMultiplier;
      }
    } else {
      rowT = parsedRowIdx * 1e-4; // 10 kS/s default grid if file has no time column
    }

    if (parsedRowIdx > 0 && rowT < prevTime) {
      needsSort = true;
    }
    prevTime = rowT;
    rawTime[parsedRowIdx] = rowT;

    for (let c = 0; c < activeChannels.length; c++) {
      const colIdx = activeChannels[c].index;
      const cell = colIdx < cols.length ? cols[colIdx] : '';
      const vVal = parseNumericCell(cell);
      rawValues[c][parsedRowIdx] = isNaN(vVal) || !isFinite(vVal) ? NaN : vVal;
    }

    parsedRowIdx++;
  }

  const validCount = parsedRowIdx;
  if (validCount === 0) {
    throw new Error('No valid numeric samples found in CSV.');
  }

  let finalTime = rawTime.slice(0, validCount);
  const orderedValues: Float32Array[] = rawValues.map((arr) => arr.slice(0, validCount));

  // If timestamps are out of order, sort all channels chronologically so traces never jump backward or vanish
  if (needsSort) {
    const order = Array.from({ length: validCount }, (_, i) => i);
    order.sort((a, b) => finalTime[a] - finalTime[b]);
    const sortedTime = new Float64Array(validCount);
    for (let i = 0; i < validCount; i++) {
      sortedTime[i] = finalTime[order[i]];
    }
    finalTime = sortedTime;
    for (let c = 0; c < orderedValues.length; c++) {
      const src = orderedValues[c];
      const dst = new Float32Array(validCount);
      for (let i = 0; i < validCount; i++) {
        dst[i] = src[order[i]];
      }
      orderedValues[c] = dst;
    }
  }

  // Quality check
  const quality = analyzeSamplingQuality(finalTime, invalidRows);
  if (overrideFs !== null && validCount >= 2) {
    quality.isUniformSampling = true;
    quality.qualityStatus = 'uniform';
    quality.sampleRate = overrideFs;
    quality.nominalDt = 1 / overrideFs;
    quality.medianDt = 1 / overrideFs;
    quality.meanDt = 1 / overrideFs;
    quality.gapCount = 0;
    quality.gapIndices = [];
  }

  const channels: Record<string, WaveformChannel> = {};
  const drawOrder: string[] = [];

  for (let c = 0; c < activeChannels.length; c++) {
    const chMap = activeChannels[c];
    const chRawV = orderedValues[c];

    let finalT: Float64Array = finalTime;
    let finalV: Float32Array = chRawV;
    let fs = quality.sampleRate;
    let dt = quality.nominalDt;
    let chMetadata = {
      ...quality,
      sampleRate: fs,
      nominalDt: dt,
    };

    if (options.resample && overrideFs === null && (!quality.isUniformSampling || quality.qualityStatus !== 'uniform')) {
      // allowGapInterpolation: true guarantees Load + Resample never punches NaN holes into user captures
      const res = resampleUniform(finalTime, chRawV, { allowGapInterpolation: true });
      finalT = res.t;
      finalV = res.v;
      fs = res.fs;
      dt = res.dt;
      chMetadata = {
        ...quality,
        isUniformSampling: true,
        qualityStatus: 'uniform',
        sampleRate: fs,
        nominalDt: dt,
        medianDt: dt,
        meanDt: dt,
        minDt: dt,
        maxDt: dt,
        jitterRms: 0,
        jitterMax: 0,
        gapCount: 0,
        gapIndices: [],
      };
    }

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < finalV.length; i++) {
      const val = finalV[i];
      if (!isNaN(val) && isFinite(val)) {
        if (val < min) min = val;
        if (val > max) max = val;
      }
    }
    if (!isFinite(min)) min = -1;
    if (!isFinite(max)) max = 1;
    const margin = (max - min) * 0.1 || 1.0;

    const chId = `csv_ch_${chMap.index}_${c}`;
    const chColor = options.colors[c % options.colors.length] || '#00e5ff';

    channels[chId] = {
      id: chId,
      name: chMap.channelName || `CH ${c + 1}`,
      unit: chMap.unit || 'V',
      color: chColor,
      visible: true,
      t: finalT,
      v: finalV,
      fs,
      dt,
      isMath: false,
      sourceChannelIds: [],
      metadata: chMetadata,
      rawT: finalTime,
      rawV: chRawV,
      vMin: min - margin,
      vMax: max + margin,
    };

    drawOrder.push(chId);
  }

  return { channels, drawOrder, quality };
}
