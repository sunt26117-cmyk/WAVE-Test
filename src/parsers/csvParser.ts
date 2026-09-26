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
 * Detects the most likely delimiter for the CSV/Text text.
 * Fully supports Tab (\t), Comma (,), Semicolon (;), and single/multiple spaces (' ').
 */
export function detectDelimiter(text: string): string {
  const firstLines = text.split(/\r?\n/).slice(0, 15).filter((l) => l.trim().length > 0);
  if (firstLines.length === 0) return ',';

  // 1. Check for tab '\t' first (standard in TSV, LTspice, LabVIEW)
  const tabCounts = firstLines.map((l) => (l.match(/\t/g) || []).length);
  if (tabCounts.every((c) => c > 0 && c === tabCounts[0])) {
    return '\t';
  }

  // 2. Check for comma ','
  const commaCounts = firstLines.map((l) => (l.match(/,/g) || []).length);
  if (commaCounts.every((c) => c > 0 && c === commaCounts[0])) {
    return ',';
  }

  // 3. Check for semicolon ';'
  const semiCounts = firstLines.map((l) => (l.match(/;/g) || []).length);
  if (semiCounts.every((c) => c > 0 && c === semiCounts[0])) {
    return ';';
  }

  // 4. Check for space / multiple whitespace alignment
  // If each line has multiple tokens separated by whitespace (\s+), and token count is consistent (> 1)
  const whitespaceTokens = firstLines.map((l) => l.trim().split(/\s+/).length);
  if (whitespaceTokens.length > 0 && whitespaceTokens[0] > 1 && whitespaceTokens.every((c) => c === whitespaceTokens[0])) {
    return ' ';
  }

  // Fallback candidate scoring for slightly irregular lines
  const candidates = [',', '\t', ';', ' '];
  let bestDelim = ',';
  let bestScore = -1;

  for (const delim of candidates) {
    if (delim === ' ') {
      // Score whitespace token counts
      const counts = firstLines.map((l) => l.trim().split(/\s+/).length - 1);
      const min = Math.min(...counts);
      const max = Math.max(...counts);
      if (min > 0 && max - min <= 1) {
        const score = min * 8;
        if (score > bestScore) {
          bestScore = score;
          bestDelim = ' ';
        }
      }
    } else {
      const counts = firstLines.map((line) => {
        let count = 0;
        for (let i = 0; i < line.length; i++) {
          if (line[i] === delim) count++;
        }
        return count;
      });
      const min = Math.min(...counts);
      const max = Math.max(...counts);
      if (min > 0 && min === max) {
        const score = min * 10;
        if (score > bestScore) {
          bestScore = score;
          bestDelim = delim;
        }
      } else if (min > 0 && max - min <= 1) {
        const score = min * 5;
        if (score > bestScore) {
          bestScore = score;
          bestDelim = delim;
        }
      }
    }
  }

  return bestDelim;
}

/**
 * Splits a CSV/Text line taking quotes and whitespace into account.
 * When delimiter is ' ', treats one or more whitespace characters as a single delimiter.
 */
export function splitCsvLine(line: string, delimiter: string): string[] {
  if (delimiter === ' ') {
    const trimmed = line.trim();
    if (!trimmed) return [];
    if (!trimmed.includes('"')) {
      return trimmed.split(/\s+/);
    }
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === '"') {
        if (inQuotes && i + 1 < trimmed.length && trimmed[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (/\s/.test(ch) && !inQuotes) {
        if (current.length > 0) {
          fields.push(current);
          current = '';
        }
      } else {
        current += ch;
      }
    }
    if (current.length > 0) {
      fields.push(current);
    }
    return fields;
  }

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
 * Parses initial CSV/Text structure to generate preview information.
 * Allows customDelimiter override.
 */
export function previewCsv(text: string, customDelimiter?: string): CsvPreviewInfo {
  const delimiter = customDelimiter || detectDelimiter(text);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error('CSV file is empty.');

  const rawFirst = splitCsvLine(lines[0], delimiter);
  const firstNumeric = rawFirst.length > 0 && rawFirst.every((field) => {
    const n = Number(field);
    return field.trim() !== '' && isFinite(n);
  });

  const hasHeader = !firstNumeric;
  const dataStartLine = hasHeader ? 1 : 0;
  let headers = hasHeader
    ? rawFirst.map((h, idx) => h ? h.replace(/^["']|["']$/g, '').trim() : `Col_${idx + 1}`)
    : rawFirst.map((_, idx) => `Col_${idx + 1}`);

  let timeColIndex = -1;
  for (let i = 0; i < headers.length; i++) {
    if (TIME_HEADER_REGEX.test(headers[i])) {
      timeColIndex = i;
      break;
    }
  }

  // Find numeric data rows while ignoring simulator metadata such as
  // "Step Information: ..." between blocks.
  const candidateRows: string[][] = [];
  for (let i = dataStartLine; i < lines.length && candidateRows.length < 40; i++) {
    const cols = splitCsvLine(lines[i], delimiter);
    const timeNumeric = timeColIndex >= 0 && timeColIndex < cols.length && isFinite(Number(cols[timeColIndex]));
    const anyNumeric = cols.some((c) => c.trim() !== '' && isFinite(Number(c)));
    if ((timeColIndex >= 0 && timeNumeric) || (timeColIndex < 0 && anyNumeric)) candidateRows.push(cols);
  }

  if (timeColIndex === -1 && candidateRows.length > 2) {
    let monotonic = true;
    let prev = Number(candidateRows[0][0]);
    if (!isFinite(prev)) monotonic = false;
    for (let r = 1; monotonic && r < candidateRows.length; r++) {
      const cur = Number(candidateRows[r][0]);
      if (!isFinite(cur) || cur < prev) monotonic = false;
      prev = cur;
    }
    if (monotonic) timeColIndex = 0;
  }

  let timeUnit: 's' | 'ms' | 'us' | 'ns' = 's';
  if (timeColIndex >= 0) {
    const th = headers[timeColIndex].toLowerCase();
    if (th.includes('(ns)') || th.includes('[ns]')) timeUnit = 'ns';
    else if (th.includes('(us)') || th.includes('[us]') || th.includes('(µs)') || th.includes('[µs]')) timeUnit = 'us';
    else if (th.includes('(ms)') || th.includes('[ms]')) timeUnit = 'ms';
  }

  const columnMappings: CsvColumnMapping[] = headers.map((header, idx) => {
    if (idx === timeColIndex) {
      return { index: idx, header, role: 'time', channelName: 'Time', unit: timeUnit };
    }

    let detectedUnit = '';
    if (/^(i(?:\(|_|$)|current|curr(?:ent)?)/i.test(header) || /I\(/i.test(header)) detectedUnit = 'A';
    else if (/^(p(?:\(|_|$)|power)/i.test(header) || /P\(/i.test(header)) detectedUnit = 'W';
    else if (/^(u|v)(?:\(|_|$)|volt(?:age)?/i.test(header) || /U\(/i.test(header) || /V\(/i.test(header)) detectedUnit = 'V';
    else if (/temp|temperature|℃|degc/i.test(header)) detectedUnit = '°C';
    else if (/rpm|speed/i.test(header)) detectedUnit = 'rpm';

    return {
      index: idx,
      header,
      role: 'channel',
      channelName: header || `CH ${idx + 1}`,
      unit: detectedUnit,
    };
  });

  return {
    hasHeader,
    headers,
    delimiter,
    rows: candidateRows.slice(0, 25),
    totalRows: Math.max(0, lines.length - dataStartLine),
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
  options: ParseCsvOptions & { sampleRate?: number }
): {
  channels: Record<string, WaveformChannel>;
  drawOrder: string[];
  quality: any;
} {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error('File has no content.');

  const startIndex = options.hasHeader ? 1 : 0;
  const timeMultiplier = getTimeUnitMultiplier(options.timeUnit);
  const activeChannels = options.columnMappings.filter((m) => m.role === 'channel');
  if (activeChannels.length === 0) throw new Error('No data channels selected for import.');

  if (options.timeColIndex < 0 && (!options.sampleRate || !isFinite(options.sampleRate) || options.sampleRate <= 0)) {
    throw new Error('No time column was selected. Enter a valid sample rate before importing.');
  }

  const rawTime = new Float64Array(lines.length - startIndex);
  const rawValues = activeChannels.map(() => new Float32Array(lines.length - startIndex));
  let parsedRowIdx = 0;
  let invalidRows = 0;

  for (let lineIdx = startIndex; lineIdx < lines.length; lineIdx++) {
    const cols = splitCsvLine(lines[lineIdx], options.delimiter);
    if (!cols.length) continue;

    let rowT: number;
    if (options.timeColIndex >= 0) {
      const rawT = Number(cols[options.timeColIndex]);
      if (!isFinite(rawT)) {
        // Ignore non-data simulator metadata lines. Count malformed numeric rows
        // only when at least one other numeric field is present.
        const hasAnyNumeric = cols.some((c) => c.trim() !== '' && isFinite(Number(c)));
        if (hasAnyNumeric) invalidRows++;
        continue;
      }
      rowT = rawT * timeMultiplier;
    } else {
      rowT = parsedRowIdx / (options.sampleRate as number);
    }

    rawTime[parsedRowIdx] = rowT;
    let rowHasInvalidValue = false;
    for (let c = 0; c < activeChannels.length; c++) {
      const colIdx = activeChannels[c].index;
      const raw = colIdx < cols.length ? cols[colIdx].trim() : '';
      const value = raw === '' ? NaN : Number(raw);
      if (!isFinite(value)) rowHasInvalidValue = true;
      rawValues[c][parsedRowIdx] = isFinite(value) ? value : NaN;
    }
    if (rowHasInvalidValue) invalidRows++;
    parsedRowIdx++;
  }

  if (parsedRowIdx < 2) throw new Error('No usable numeric waveform rows found.');

  const finalTime = rawTime.slice(0, parsedRowIdx);
  const quality = analyzeSamplingQuality(finalTime, invalidRows);
  const channels: Record<string, WaveformChannel> = {};
  const drawOrder: string[] = [];

  for (let c = 0; c < activeChannels.length; c++) {
    const chMap = activeChannels[c];
    const chRawV = rawValues[c].slice(0, parsedRowIdx);

    let finalT = finalTime as Float64Array;
    let finalV = chRawV as Float32Array;
    let fs = quality.sampleRate;
    let dt = quality.nominalDt;

    if (options.resample) {
      if (!(quality.nominalDt && quality.nominalDt > 0)) throw new Error('Cannot resample: invalid source time base.');
      const res = resampleUniform(finalTime, chRawV, { nominalDt: quality.nominalDt });
      finalT = res.t;
      finalV = res.v;
      fs = res.fs;
      dt = res.dt;
    }

    let min = Infinity;
    let max = -Infinity;
    const invalidIndices: number[] = [];
    for (let i = 0; i < finalV.length; i++) {
      const val = finalV[i];
      if (isFinite(val)) {
        if (val < min) min = val;
        if (val > max) max = val;
      } else {
        invalidIndices.push(i);
      }
    }
    if (!isFinite(min)) min = -1;
    if (!isFinite(max)) max = 1;
    const margin = Math.max((max - min) * 0.1, 1e-12);

    const chId = `csv_ch_${chMap.index}_${c}`;
    const chColor = options.colors[c % Math.max(1, options.colors.length)] || '#00e5ff';
    channels[chId] = {
      id: chId,
      name: chMap.channelName || `CH ${c + 1}`,
      unit: chMap.unit || '',
      color: chColor,
      visible: true,
      t: finalT,
      v: finalV,
      fs: fs,
      dt: dt,
      isMath: false,
      sourceChannelIds: [],
      metadata: {
        ...quality,
        invalidSamples: invalidIndices.length,
        gapCount: invalidIndices.length,
        gapIndices: invalidIndices,
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
