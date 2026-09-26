/**
 * Waveform Viewer Pro - CSV & Clipboard Parser
 * Intelligent column role detection, time unit scaling, sampling quality audit,
 * and robust Float64Array / Float32Array channel instantiation.
 */

import {
  WaveformChannel,
  CsvPreviewInfo,
  CsvColumnMapping,
} from '../types/models';
import { analyzeSamplingQuality, getTimeUnitMultiplier } from '../modules/qualityCheck';
import { resampleUniform } from '../modules/resampler';

const TIME_HEADER_REGEX = /^(time|t|timestamp|time_s|time_ms|seconds|sec|t_sec|t_s)($|[\s_(\[])/i;

/**
 * Detects the most likely delimiter for the CSV text.
 */
export function detectDelimiter(text: string): string {
  const firstLines = text.split(/\r?\n/).slice(0, 10).filter((l) => l.trim().length > 0);
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

    // Check consistency across lines
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
        i++; // skip escaped quote
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
 * Parses initial CSV structure to generate preview information.
 */
export function previewCsv(text: string): CsvPreviewInfo {
  const delimiter = detectDelimiter(text);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error('CSV file is empty.');
  }

  const rawHeaderLine = splitCsvLine(lines[0], delimiter);
  // Check if first line contains numeric values or headers
  const isFirstLineNumeric = rawHeaderLine.every((field) => {
    const num = parseFloat(field);
    return !isNaN(num) && isFinite(num);
  });

  let headers: string[] = [];
  let dataStartLine = 0;

  if (isFirstLineNumeric) {
    headers = rawHeaderLine.map((_, idx) => `Col_${idx + 1}`);
    dataStartLine = 0;
  } else {
    headers = rawHeaderLine.map((h, idx) => (h ? h.replace(/^["']|["']$/g, '').trim() : `Col_${idx + 1}`));
    dataStartLine = 1;
  }

  // Sample first 20 rows
  const previewRows: string[][] = [];
  const maxPreview = Math.min(lines.length, dataStartLine + 25);
  for (let i = dataStartLine; i < maxPreview; i++) {
    previewRows.push(splitCsvLine(lines[i], delimiter));
  }

  // Detect time column index
  let timeColIndex = -1;
  for (let i = 0; i < headers.length; i++) {
    if (TIME_HEADER_REGEX.test(headers[i])) {
      timeColIndex = i;
      break;
    }
  }

  // Detect time unit from header e.g. "Time (ms)"
  let timeUnit: 's' | 'ms' | 'us' | 'ns' = 's';
  if (timeColIndex >= 0) {
    const th = headers[timeColIndex].toLowerCase();
    if (th.includes('(ns)') || th.includes('[ns]')) timeUnit = 'ns';
    else if (th.includes('(us)') || th.includes('[us]') || th.includes('(µs)') || th.includes('[µs]')) timeUnit = 'us';
    else if (th.includes('(ms)') || th.includes('[ms]')) timeUnit = 'ms';
    else if (th.includes('(s)') || th.includes('[s]')) timeUnit = 's';
  }

  // If no explicit time column found, check first column monotonicity
  if (timeColIndex === -1 && previewRows.length > 2) {
    let isMonotonic = true;
    let prev = parseFloat(previewRows[0][0]);
    for (let r = 1; r < previewRows.length; r++) {
      const cur = parseFloat(previewRows[r][0]);
      if (isNaN(cur) || cur < prev) {
        isMonotonic = false;
        break;
      }
      prev = cur;
    }
    if (isMonotonic) {
      timeColIndex = 0;
    }
  }

  // Setup default column mappings
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

  return {
    headers,
    delimiter,
    rows: previewRows,
    totalRows: lines.length - dataStartLine,
    timeColIndex,
    timeUnit,
    columnMappings,
    quality: null,
  };
}

export interface ParseCsvOptions {
  delimiter: string;
  hasHeader: boolean;
  timeColIndex: number;
  timeUnit: 's' | 'ms' | 'us' | 'ns';
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
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error('File has no content.');

  const startIndex = options.hasHeader ? 1 : 0;
  const numDataRows = lines.length - startIndex;
  if (numDataRows <= 0) throw new Error('No data rows found in CSV.');

  const timeMultiplier = getTimeUnitMultiplier(options.timeUnit);

  // Parse time column
  const rawTime = new Float64Array(numDataRows);
  let hasExplicitTime = options.timeColIndex >= 0;
  let invalidRows = 0;

  // Active channel columns
  const activeChannels = options.columnMappings.filter((m) => m.role === 'channel');
  if (activeChannels.length === 0) {
    throw new Error('No data channels selected for import.');
  }

  const rawValues: Float32Array[] = activeChannels.map(() => new Float32Array(numDataRows));

  let parsedRowIdx = 0;
  for (let lineIdx = startIndex; lineIdx < lines.length; lineIdx++) {
    const cols = splitCsvLine(lines[lineIdx], options.delimiter);

    let rowT = 0;
    if (hasExplicitTime) {
      const rawTVal = parseFloat(cols[options.timeColIndex]);
      if (isNaN(rawTVal)) {
        invalidRows++;
        continue;
      }
      rowT = rawTVal * timeMultiplier;
    } else {
      rowT = parsedRowIdx * 1e-4; // 10 kS/s default time grid if no time column
    }

    rawTime[parsedRowIdx] = rowT;

    for (let c = 0; c < activeChannels.length; c++) {
      const colIdx = activeChannels[c].index;
      const vVal = colIdx < cols.length ? parseFloat(cols[colIdx]) : 0;
      rawValues[c][parsedRowIdx] = isNaN(vVal) ? 0 : vVal;
    }

    parsedRowIdx++;
  }

  const validCount = parsedRowIdx;
  const finalTime = rawTime.slice(0, validCount);

  // Quality check
  const quality = analyzeSamplingQuality(finalTime, invalidRows);

  const channels: Record<string, WaveformChannel> = {};
  const drawOrder: string[] = [];

  for (let c = 0; c < activeChannels.length; c++) {
    const chMap = activeChannels[c];
    const chRawV = rawValues[c].slice(0, validCount);

    let finalT: Float64Array = finalTime;
    let finalV: Float32Array = chRawV;
    let fs = quality.sampleRate;
    let dt = quality.nominalDt;

    // Resample if requested or non-uniform
    if (options.resample && (!quality.isUniformSampling || quality.qualityStatus !== 'uniform')) {
      const res = resampleUniform(finalTime, chRawV);
      finalT = res.t;
      finalV = res.v;
      fs = res.fs;
      dt = res.dt;
    }

    // Min and Max
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < finalV.length; i++) {
      const val = finalV[i];
      if (!isNaN(val)) {
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
      metadata: {
        ...quality,
        sampleRate: fs,
        nominalDt: dt,
      },
      rawT: finalTime,
      rawV: chRawV,
      vMin: min - margin,
      vMax: max + margin,
    };

    drawOrder.push(chId);
  }

  return { channels, drawOrder, quality };
}
