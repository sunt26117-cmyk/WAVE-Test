/**
 * Waveform Viewer Pro - Multi-Sheet Excel (.xlsx / .xls / .xlsm / .xlsb) Parser
 * - Bounded 100-row preview scan (zero external Worker scripts; 100% offline-HTML compatible)
 * - Auto-header detection: firstDataRow - 1 (with Col A / Col B fallback when firstDataRow === 0)
 * - Strict cell-format priority for Excel serial dates (cell.t === 'd' / SSF.is_date) -> t[0] = 0 s
 * - Mixed pure-text/status column auto-filtering & all-NaN safety
 * - Explicit workbook memory release after modal close or import completion
 */

import * as XLSX from 'xlsx';
import {
  WaveformChannel,
  SamplingMetadata,
} from '../types/models';
import { parseNumericCell, parseTimeCell } from './csvParser';
import { analyzeSamplingQuality, getTimeUnitMultiplier } from '../modules/qualityCheck';
import { resampleUniform } from '../modules/resampler';
import { computeBufferFingerprint } from '../modules/waveformCompare';

const PREVIEW_ROW_LIMIT = 100;
const TIME_HEADER_REGEX = /^(time|t|timestamp|date|datetime|time_s|time_ms|time_us|time_ns|time_ps|seconds|sec|t_sec|t_s|x|时间|时刻)($|[\s_(\[])/i;
const UNIT_TOKEN_REGEX = /^[\[\(]?(s|sec|ms|us|µs|ns|ps|v|mv|uv|µv|kv|a|ma|ua|µa|ka|hz|khz|mhz|w|mw|kw|°c|℃|°f|k|deg|rad|rpm|%|n·m|nm)[\]\)]?$/i;

export type ExcelTimeSourceKind = 'numeric' | 'excel-date' | 'clock-string' | 'none';

export interface ExcelColumnMapping {
  index: number;
  colLetter: string;
  header: string;
  unit: string;
  role: 'time' | 'channel' | 'ignore';
  channelName: string;
  isTextColumn: boolean;
  numericRatio: number;
  selected: boolean;
}

export interface ExcelSheetPreview {
  sheetIndex: number;
  sheetName: string;
  selected: boolean;
  totalRows: number;
  totalCols: number;
  rangeStartRow: number;
  rangeStartCol: number;
  previewRowCount: number;
  previewRows: string[][];
  hasNumericData: boolean;
  detectedFirstDataRow: number;
  detectedHeaderRow: number | null;
  firstDataRow: number;
  headerRow: number | null;
  hasUnitRow: boolean;
  timeColIndex: number;
  timeSourceKind: ExcelTimeSourceKind;
  timeUnit: 's' | 'ms' | 'us' | 'ns' | 'ps';
  sampleRateOverrideHz: number | null;
  columnMappings: ExcelColumnMapping[];
  quality: SamplingMetadata | null;
}

export interface ExcelWorkbookSession {
  id: string;
  file?: File;
  fileName: string;
  fileSizeBytes: number;
  fingerprint: string;
  workbook: XLSX.WorkBook | null;
  sheets: ExcelSheetPreview[];
  activeSheetIndex: number;
  released: boolean;
}

interface PreviewCellMeta {
  display: string;
  isEmpty: boolean;
  isDateCell: boolean;
  isClockString: boolean;
  isNumeric: boolean;
  numericValue: number;
  timeSecondsValue: number;
}

// Held per-session in a WeakMap so releaseExcelWorkbookSession clears all preview caches cleanly
const previewMetaCache = new WeakMap<ExcelSheetPreview, PreviewCellMeta[][]>();

export function isExcelFileName(fileName: string): boolean {
  return /\.(xlsx|xls|xlsm|xlsb)$/i.test((fileName || '').trim());
}

/**
 * Checks whether a SheetJS cell uses an explicit Excel date/time format
 * (prioritizing cell.t === 'd' and SSF.is_date(cell.z) to avoid misclassifying ordinary index columns).
 */
export function isExcelDateFormattedCell(cell: XLSX.CellObject | undefined): boolean {
  if (!cell) return false;
  if (cell.t === 'd') return true;
  if (cell.t === 'n' && cell.z !== undefined && cell.z !== null) {
    const fmt = String(cell.z).trim();
    if (!fmt || fmt.toLowerCase() === 'general') return false;
    try {
      return XLSX.SSF.is_date(fmt);
    } catch {
      return false;
    }
  }
  return false;
}

function formatCellDisplay(cell: XLSX.CellObject | undefined): string {
  if (!cell) return '';
  if (cell.t === 'd' && cell.v instanceof Date) {
    return isNaN(cell.v.getTime()) ? '' : cell.v.toISOString().replace('T', ' ').replace('Z', '');
  }
  if (typeof cell.w === 'string' && cell.w.trim().length > 0) {
    return cell.w.trim();
  }
  if (cell.v === undefined || cell.v === null) return '';
  return String(cell.v).trim();
}

function inspectCellForPreview(cell: XLSX.CellObject | undefined): PreviewCellMeta {
  if (!cell || cell.t === 'z' || cell.v === undefined || cell.v === null) {
    return {
      display: '',
      isEmpty: true,
      isDateCell: false,
      isClockString: false,
      isNumeric: false,
      numericValue: NaN,
      timeSecondsValue: NaN,
    };
  }

  const display = formatCellDisplay(cell);
  if (!display && cell.t !== 'n' && cell.t !== 'd') {
    return {
      display: '',
      isEmpty: true,
      isDateCell: false,
      isClockString: false,
      isNumeric: false,
      numericValue: NaN,
      timeSecondsValue: NaN,
    };
  }

  if (cell.t === 'd' && cell.v instanceof Date) {
    const sec = cell.v.getTime() / 1000;
    const valid = isFinite(sec);
    return {
      display,
      isEmpty: false,
      isDateCell: valid,
      isClockString: false,
      isNumeric: valid,
      numericValue: valid ? sec : NaN,
      timeSecondsValue: valid ? sec : NaN,
    };
  }

  if (cell.t === 'n' && typeof cell.v === 'number') {
    const finite = isFinite(cell.v);
    const isDate = finite && isExcelDateFormattedCell(cell);
    return {
      display: display || String(cell.v),
      isEmpty: false,
      isDateCell: isDate,
      isClockString: false,
      isNumeric: finite,
      numericValue: finite ? cell.v : NaN,
      timeSecondsValue: finite ? (isDate ? (cell.v - 25569) * 86400 : cell.v) : NaN,
    };
  }

  if (cell.t === 'b') {
    return {
      display,
      isEmpty: false,
      isDateCell: false,
      isClockString: false,
      isNumeric: false,
      numericValue: NaN,
      timeSecondsValue: NaN,
    };
  }

  const timeParsed = parseTimeCell(display);
  const numParsed = parseNumericCell(display);
  const isClockStr = timeParsed.isClock && isFinite(timeParsed.value);
  const isNum = (!isNaN(numParsed) && isFinite(numParsed)) || isClockStr;

  return {
    display,
    isEmpty: display.length === 0,
    isDateCell: false,
    isClockString: isClockStr,
    isNumeric: isNum,
    numericValue: !isNaN(numParsed) && isFinite(numParsed) ? numParsed : timeParsed.value,
    timeSecondsValue: isFinite(timeParsed.value) ? timeParsed.value : NaN,
  };
}

export function inferUnitFromHeader(header: string, fallbackUnit: string = 'V'): string {
  const h = (header || '').trim();
  const bracketMatch = /[\(\[]\s*([a-zA-Z°℃µ%·/]+)\s*[\)\]]\s*$/.exec(h);
  if (bracketMatch && bracketMatch[1]) {
    const tok = bracketMatch[1];
    if (/^(%|pct|percent)$/i.test(tok)) return '%';
    if (/^(v|mv|uv|µv|kv)$/i.test(tok)) return 'V';
    if (/^(a|ma|ua|µa|ka)$/i.test(tok)) return 'A';
    if (/^(w|mw|kw)$/i.test(tok)) return 'W';
    if (/^(hz|khz|mhz)$/i.test(tok)) return 'Hz';
    if (/^(°c|℃|degc)$/i.test(tok)) return '°C';
    if (/^(rpm)$/i.test(tok)) return 'RPM';
    return tok;
  }
  const lower = h.toLowerCase();
  if (/duty|pwm_?(?:[abcuvw123]|d)|^d_?[abcuvw]$/i.test(lower)) return /%|pct|percent/.test(lower) ? '%' : '';
  if (/^(i_|ia|ib|ic|id|iq|curr|current|i\b)/.test(lower)) return 'A';
  if (/^(p_|pwr|power|loss|ploss)/.test(lower)) return 'W';
  if (/^(t_?j|temp|tj|tcase|temperature)/.test(lower)) return '°C';
  if (/^(rpm|speed|omega|vel)/.test(lower)) return 'RPM';
  return fallbackUnit;
}

function inferTimeUnitFromText(text: string): 's' | 'ms' | 'us' | 'ns' | 'ps' {
  const th = (text || '').toLowerCase();
  if (th.includes('(ps)') || th.includes('[ps]') || th.includes('_ps') || th === 'ps') return 'ps';
  if (th.includes('(ns)') || th.includes('[ns]') || th.includes('_ns') || th === 'ns') return 'ns';
  if (
    th.includes('(us)') ||
    th.includes('[us]') ||
    th.includes('(µs)') ||
    th.includes('[µs]') ||
    th.includes('_us') ||
    th === 'us' ||
    th === 'µs'
  ) {
    return 'us';
  }
  if (th.includes('(ms)') || th.includes('[ms]') || th.includes('_ms') || th === 'ms') return 'ms';
  return 's';
}

function findFirstNumericDataRow(metaRows: PreviewCellMeta[][], maxCols: number): number {
  const rowStats = metaRows.map((row) => {
    let nonEmpty = 0;
    let numericCount = 0;
    const numCols = new Set<number>();
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (!cell || cell.isEmpty) continue;
      nonEmpty++;
      if (cell.isNumeric || cell.isDateCell || cell.isClockString) {
        numericCount++;
        numCols.add(c);
      }
    }
    return { nonEmpty, numericCount, numCols };
  });

  if (maxCols <= 1) {
    for (let r = 0; r < rowStats.length; r++) {
      if (rowStats[r].nonEmpty === 1 && rowStats[r].numericCount === 1) return r;
    }
    return -1;
  }

  // Pass 1: Detect start of continuous numeric table (handles mixed numeric + text/status columns)
  for (let r = 0; r < rowStats.length; r++) {
    const st = rowStats[r];
    if (st.nonEmpty < 2 || st.numericCount < 2) continue;

    let nextNonEmptyIdx = -1;
    for (let k = r + 1; k < rowStats.length; k++) {
      if (rowStats[k].nonEmpty > 0) {
        nextNonEmptyIdx = k;
        break;
      }
    }
    // If immediately followed by a pure-text row (likely the table's real header), skip this preamble row
    if (nextNonEmptyIdx >= 0 && rowStats[nextNonEmptyIdx].numericCount === 0) {
      continue;
    }

    let overlappingNumCols = 0;
    if (nextNonEmptyIdx >= 0) {
      for (const c of st.numCols) {
        if (rowStats[nextNonEmptyIdx].numCols.has(c)) overlappingNumCols++;
      }
    }

    if (st.numericCount >= Math.max(2, Math.ceil(st.nonEmpty * 0.6)) || overlappingNumCols >= 2) {
      return r;
    }
  }

  // Pass 2: Fallback for single-row data tables with many text columns
  for (let r = 0; r < rowStats.length; r++) {
    const st = rowStats[r];
    if (st.numericCount >= 2 || (st.nonEmpty === 1 && st.numericCount === 1)) {
      return r;
    }
  }
  return -1;
}

function rowLooksLikeUnits(metaRow: PreviewCellMeta[] | undefined): boolean {
  if (!metaRow) return false;
  let nonEmpty = 0;
  let unitCount = 0;
  for (const cell of metaRow) {
    if (!cell || cell.isEmpty) continue;
    nonEmpty++;
    if (UNIT_TOKEN_REGEX.test(cell.display)) {
      unitCount++;
    }
  }
  return nonEmpty > 0 && unitCount === nonEmpty;
}

function buildColumnMappingsAndTime(
  metaRows: PreviewCellMeta[][],
  sheet: ExcelSheetPreview,
  preserveUserTimeSelection?: {
    timeColIndex?: number;
    timeUnit?: 's' | 'ms' | 'us' | 'ns' | 'ps';
    sampleRateOverrideHz?: number | null;
    previousRoles?: Map<number, { role: 'time' | 'channel' | 'ignore'; channelName?: string; unit?: string }>;
  }
): void {
  const numCols = sheet.totalCols;
  const headerIdx = sheet.headerRow;
  const dataStart = sheet.firstDataRow;
  const headerMeta = headerIdx !== null && headerIdx >= 0 && headerIdx < metaRows.length ? metaRows[headerIdx] : null;
  const unitMeta = sheet.hasUnitRow && dataStart > 0 && dataStart - 1 < metaRows.length ? metaRows[dataStart - 1] : null;

  const sampleLimit = Math.min(metaRows.length, dataStart + 80);
  const colStats: Array<{
    numericRatio: number;
    isTextColumn: boolean;
    dateRatio: number;
    clockRatio: number;
    isMonotonicNumeric: boolean;
  }> = [];

  for (let c = 0; c < numCols; c++) {
    let nonEmpty = 0;
    let numCount = 0;
    let dateCount = 0;
    let clockCount = 0;
    const seqVals: number[] = [];

    for (let r = dataStart; r < sampleLimit; r++) {
      const cell = metaRows[r]?.[c];
      if (!cell || cell.isEmpty) continue;
      nonEmpty++;
      if (cell.isNumeric) numCount++;
      if (cell.isDateCell) dateCount++;
      if (cell.isClockString) clockCount++;
      if (cell.isNumeric && isFinite(cell.timeSecondsValue)) {
        seqVals.push(cell.timeSecondsValue);
      }
    }

    const numericRatio = nonEmpty > 0 ? numCount / nonEmpty : 0;
    const isTextColumn = nonEmpty === 0 || numericRatio < 0.5;
    const dateRatio = nonEmpty > 0 ? dateCount / nonEmpty : 0;
    const clockRatio = nonEmpty > 0 ? clockCount / nonEmpty : 0;

    let isMonotonicNumeric = false;
    if (seqVals.length >= 3 && !isTextColumn) {
      let nonDec = true;
      let strictInc = 0;
      for (let i = 1; i < seqVals.length; i++) {
        if (seqVals[i] < seqVals[i - 1]) {
          nonDec = false;
          break;
        }
        if (seqVals[i] > seqVals[i - 1]) strictInc++;
      }
      isMonotonicNumeric = nonDec && strictInc >= Math.max(1, Math.floor((seqVals.length - 1) * 0.5));
    }

    colStats.push({ numericRatio, isTextColumn, dateRatio, clockRatio, isMonotonicNumeric });
  }

  const headers: string[] = [];
  const colLetters: string[] = [];
  for (let c = 0; c < numCols; c++) {
    const colLetter = XLSX.utils.encode_col(sheet.rangeStartCol + c);
    colLetters.push(colLetter);
    const defaultName = `Col ${colLetter}`;
    if (headerMeta && headerMeta[c] && !headerMeta[c].isEmpty) {
      headers.push(headerMeta[c].display);
    } else {
      headers.push(defaultName);
    }
  }

  // Detect or preserve Time Column
  let timeColIndex = preserveUserTimeSelection?.timeColIndex !== undefined
    ? preserveUserTimeSelection.timeColIndex
    : -1;

  if (preserveUserTimeSelection?.timeColIndex === undefined) {
    if (numCols >= 2) {
      // 1. Explicit header match on a numeric/date column
      for (let c = 0; c < numCols; c++) {
        if (!colStats[c].isTextColumn && TIME_HEADER_REGEX.test(headers[c])) {
          timeColIndex = c;
          break;
        }
      }
      // 2. Date-formatted or Clock-string column
      if (timeColIndex === -1) {
        for (let c = 0; c < numCols; c++) {
          if (colStats[c].dateRatio >= 0.5 || colStats[c].clockRatio >= 0.5) {
            timeColIndex = c;
            break;
          }
        }
      }
      // 3. Monotonically increasing first numeric column
      if (timeColIndex === -1 && colStats[0] && colStats[0].isMonotonicNumeric) {
        timeColIndex = 0;
      }
    }
  }

  sheet.timeColIndex = timeColIndex >= 0 && timeColIndex < numCols ? timeColIndex : -1;

  // Determine Time Source Kind (excel-date vs clock-string vs numeric)
  if (sheet.timeColIndex >= 0) {
    const st = colStats[sheet.timeColIndex];
    if (st.dateRatio >= 0.5) {
      sheet.timeSourceKind = 'excel-date';
    } else if (st.clockRatio >= 0.5) {
      sheet.timeSourceKind = 'clock-string';
    } else {
      sheet.timeSourceKind = 'numeric';
    }
  } else {
    sheet.timeSourceKind = 'none';
  }

  // Determine Time Unit
  if (preserveUserTimeSelection?.timeUnit) {
    sheet.timeUnit = preserveUserTimeSelection.timeUnit;
  } else if (sheet.timeSourceKind === 'excel-date' || sheet.timeSourceKind === 'clock-string') {
    sheet.timeUnit = 's';
  } else if (sheet.timeColIndex >= 0) {
    const unitCellText = unitMeta?.[sheet.timeColIndex]?.display || '';
    sheet.timeUnit = unitCellText
      ? inferTimeUnitFromText(unitCellText)
      : inferTimeUnitFromText(headers[sheet.timeColIndex]);
  } else {
    sheet.timeUnit = 's';
  }

  sheet.columnMappings = headers.map((header, c) => {
    const stat = colStats[c];
    const prev = preserveUserTimeSelection?.previousRoles?.get(c);
    const unitRaw = unitMeta?.[c]?.display?.replace(/^[\[\(]|[\]\)]$/g, '').trim() || '';
    const inferredUnit = unitRaw || inferUnitFromHeader(header, 'V');

    let role: 'time' | 'channel' | 'ignore';
    if (c === sheet.timeColIndex) {
      role = 'time';
    } else if (prev && prev.role !== 'time') {
      role = prev.role;
    } else {
      role = stat.isTextColumn ? 'ignore' : 'channel';
    }

    return {
      index: c,
      colLetter: colLetters[c],
      header,
      unit: c === sheet.timeColIndex ? sheet.timeUnit : prev?.unit || inferredUnit,
      role,
      channelName: prev?.channelName || (c === sheet.timeColIndex ? 'Time' : header),
      isTextColumn: stat.isTextColumn,
      numericRatio: stat.numericRatio,
      selected: role === 'channel',
    };
  });

  sheet.quality = computePreviewQualityFromMeta(metaRows, sheet);
}

function computePreviewQualityFromMeta(
  metaRows: PreviewCellMeta[][],
  sheet: ExcelSheetPreview
): SamplingMetadata | null {
  const totalData = Math.max(0, sheet.totalRows - sheet.firstDataRow);
  if (totalData < 2) return null;

  if (sheet.sampleRateOverrideHz && sheet.sampleRateOverrideHz > 0 && isFinite(sheet.sampleRateOverrideHz)) {
    const dt = 1 / sheet.sampleRateOverrideHz;
    const count = Math.min(totalData, 5000);
    const syn = new Float64Array(count);
    for (let i = 0; i < count; i++) syn[i] = i * dt;
    const meta = analyzeSamplingQuality(syn, 0);
    meta.originalSampleCount = totalData;
    meta.originalTimeEnd = (totalData - 1) * dt;
    meta.sampleRate = sheet.sampleRateOverrideHz;
    meta.nominalDt = dt;
    meta.medianDt = dt;
    meta.meanDt = dt;
    return meta;
  }

  if (sheet.timeColIndex < 0) return null;

  const mult = getTimeUnitMultiplier(sheet.timeUnit);
  const times: number[] = [];
  let invalid = 0;
  let baseClock: number | null = null;

  for (let r = sheet.firstDataRow; r < metaRows.length; r++) {
    const cell = metaRows[r]?.[sheet.timeColIndex];
    if (!cell || cell.isEmpty || !cell.isNumeric || !isFinite(cell.timeSecondsValue)) {
      invalid++;
      continue;
    }
    if (cell.isDateCell || cell.isClockString) {
      if (baseClock === null) baseClock = cell.timeSecondsValue;
      times.push(cell.timeSecondsValue - baseClock);
    } else {
      times.push(cell.numericValue * mult);
    }
  }

  if (times.length < 2) return null;
  times.sort((a, b) => a - b);
  const meta = analyzeSamplingQuality(Float64Array.from(times), invalid);
  meta.originalSampleCount = totalData;
  return meta;
}

function buildSheetPreview(
  ws: XLSX.WorkSheet | undefined,
  sheetName: string,
  sheetIndex: number
): ExcelSheetPreview {
  if (!ws || !ws['!ref']) {
    const empty: ExcelSheetPreview = {
      sheetIndex,
      sheetName,
      selected: false,
      totalRows: 0,
      totalCols: 0,
      rangeStartRow: 0,
      rangeStartCol: 0,
      previewRowCount: 0,
      previewRows: [],
      hasNumericData: false,
      detectedFirstDataRow: 0,
      detectedHeaderRow: null,
      firstDataRow: 0,
      headerRow: null,
      hasUnitRow: false,
      timeColIndex: -1,
      timeSourceKind: 'none',
      timeUnit: 's',
      sampleRateOverrideHz: null,
      columnMappings: [],
      quality: null,
    };
    previewMetaCache.set(empty, []);
    return empty;
  }

  const range = XLSX.utils.decode_range(ws['!ref']);
  const totalRows = Math.max(0, range.e.r - range.s.r + 1);
  const totalCols = Math.max(0, Math.min(256, range.e.c - range.s.c + 1));
  const previewRowCount = Math.min(totalRows, PREVIEW_ROW_LIMIT);

  const metaRows: PreviewCellMeta[][] = [];
  const previewRows: string[][] = [];

  for (let rOffset = 0; rOffset < previewRowCount; rOffset++) {
    const r = range.s.r + rOffset;
    const mRow: PreviewCellMeta[] = [];
    const sRow: string[] = [];
    for (let cOffset = 0; cOffset < totalCols; cOffset++) {
      const c = range.s.c + cOffset;
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr] as XLSX.CellObject | undefined;
      const meta = inspectCellForPreview(cell);
      mRow.push(meta);
      sRow.push(meta.display);
    }
    metaRows.push(mRow);
    previewRows.push(sRow);
  }

  const firstDataIdx = findFirstNumericDataRow(metaRows, totalCols);
  const hasNumericData = firstDataIdx >= 0;
  const effectiveFirstData = hasNumericData ? firstDataIdx : 0;

  let detectedHeaderRow: number | null = null;
  let hasUnitRow = false;
  if (hasNumericData && effectiveFirstData > 0) {
    if (effectiveFirstData >= 2 && rowLooksLikeUnits(metaRows[effectiveFirstData - 1])) {
      detectedHeaderRow = effectiveFirstData - 2;
      hasUnitRow = true;
    } else {
      detectedHeaderRow = effectiveFirstData - 1;
    }
  }

  const preview: ExcelSheetPreview = {
    sheetIndex,
    sheetName,
    selected: hasNumericData,
    totalRows,
    totalCols,
    rangeStartRow: range.s.r,
    rangeStartCol: range.s.c,
    previewRowCount,
    previewRows,
    hasNumericData,
    detectedFirstDataRow: effectiveFirstData,
    detectedHeaderRow,
    firstDataRow: effectiveFirstData,
    headerRow: detectedHeaderRow,
    hasUnitRow,
    timeColIndex: -1,
    timeSourceKind: 'none',
    timeUnit: 's',
    sampleRateOverrideHz: null,
    columnMappings: [],
    quality: null,
  };

  previewMetaCache.set(preview, metaRows);
  if (hasNumericData && totalCols > 0) {
    buildColumnMappingsAndTime(metaRows, preview);
    // If no active numeric channel columns survived filtering, default sheet unchecked
    if (!preview.columnMappings.some((m) => m.role === 'channel')) {
      preview.selected = false;
    }
  }

  return preview;
}

/**
 * Parses an ArrayBuffer into a bounded ExcelWorkbookSession (top 100 rows/sheet previewed immediately;
 * full extraction is deferred until user confirms Load).
 */
export function createExcelWorkbookSessionFromBuffer(
  buffer: ArrayBuffer,
  fileName: string,
  fileSizeBytes?: number,
  file?: File
): ExcelWorkbookSession {
  const workbook = XLSX.read(buffer, {
    type: 'array',
    cellDates: false,
    cellNF: true,
    cellText: true,
    cellStyles: false,
  });

  const sheets = workbook.SheetNames.map((name, idx) =>
    buildSheetPreview(workbook.Sheets[name], name, idx)
  );
  const firstNumericSheet = sheets.findIndex((s) => s.selected);
  const activeSheetIndex = firstNumericSheet >= 0 ? firstNumericSheet : 0;

  return {
    id: `xls_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    file,
    fileName,
    fileSizeBytes: fileSizeBytes ?? buffer.byteLength,
    fingerprint: computeBufferFingerprint(fileName, buffer),
    workbook,
    sheets,
    activeSheetIndex,
    released: false,
  };
}

/**
 * Opens a browser File into a bounded ExcelWorkbookSession.
 */
export async function openExcelWorkbookSession(file: File): Promise<ExcelWorkbookSession> {
  const buf = await file.arrayBuffer();
  return createExcelWorkbookSessionFromBuffer(buf, file.name, file.size, file);
}

/**
 * Recomputes a sheet's column mappings & quality audit after user adjusts headerRow,
 * firstDataRow, timeColIndex, timeUnit, sampleRateOverrideHz, or column roles.
 */
export function recomputeExcelSheetPreview(
  session: ExcelWorkbookSession,
  sheetIndex: number,
  updates?: {
    headerRow?: number | null;
    firstDataRow?: number;
    timeColIndex?: number;
    timeUnit?: 's' | 'ms' | 'us' | 'ns' | 'ps';
    sampleRateOverrideHz?: number | null;
    preserveColumnRoles?: boolean;
  }
): ExcelSheetPreview | null {
  const sheet = session.sheets[sheetIndex];
  if (!sheet) return null;
  const metaRows = previewMetaCache.get(sheet);
  if (!metaRows) return sheet;

  if (updates) {
    if (updates.firstDataRow !== undefined) {
      sheet.firstDataRow = Math.max(0, Math.min(Math.max(0, sheet.totalRows - 1), updates.firstDataRow));
    }
    if (updates.headerRow !== undefined) {
      sheet.headerRow =
        updates.headerRow === null || updates.headerRow < 0
          ? null
          : Math.min(Math.max(0, sheet.totalRows - 1), updates.headerRow);
      sheet.hasUnitRow =
        sheet.headerRow !== null &&
        sheet.firstDataRow - sheet.headerRow === 2 &&
        rowLooksLikeUnits(metaRows[sheet.firstDataRow - 1]);
    }
    if (updates.sampleRateOverrideHz !== undefined) {
      sheet.sampleRateOverrideHz = updates.sampleRateOverrideHz;
    }
  }

  const prevRoles = new Map<number, { role: 'time' | 'channel' | 'ignore'; channelName?: string; unit?: string }>();
  if (updates?.preserveColumnRoles) {
    for (const m of sheet.columnMappings) {
      prevRoles.set(m.index, { role: m.role, channelName: m.channelName, unit: m.unit });
    }
  }

  buildColumnMappingsAndTime(metaRows, sheet, {
    timeColIndex: updates?.timeColIndex,
    timeUnit: updates?.timeUnit,
    sampleRateOverrideHz: sheet.sampleRateOverrideHz,
    previousRoles: updates?.preserveColumnRoles ? prevRoles : undefined,
  });

  return sheet;
}

/**
 * Applies current sheet selection & header/column rules from a source session to another Excel session
 * (used by Batch Multi-File Measure's "Apply rules to remaining files" action).
 */
export function applyExcelRulesToTargetSession(
  sourceSession: ExcelWorkbookSession,
  targetSession: ExcelWorkbookSession
): void {
  const sourceSelected = sourceSession.sheets.filter((s) => s.selected);
  const selectedNames = new Set(sourceSelected.map((s) => s.sheetName));
  const selectedIndices = new Set(sourceSelected.map((s) => s.sheetIndex));
  const fallbackSource = sourceSession.sheets[sourceSession.activeSheetIndex] || sourceSelected[0];

  targetSession.sheets.forEach((targetSheet, idx) => {
    const matchingSource =
      sourceSession.sheets.find((s) => s.sheetName === targetSheet.sheetName) ||
      (sourceSession.sheets[idx] ? sourceSession.sheets[idx] : fallbackSource);

    if (!matchingSource) return;

    const matchedBySelection =
      selectedNames.has(targetSheet.sheetName) || selectedIndices.has(idx);
    targetSheet.selected = targetSheet.hasNumericData && matchedBySelection;

    // Preserve auto-detected header row if target differs, or copy explicit offset rule
    const usedAutoHeader =
      matchingSource.headerRow === matchingSource.detectedHeaderRow &&
      matchingSource.firstDataRow === matchingSource.detectedFirstDataRow;

    if (!usedAutoHeader) {
      targetSheet.firstDataRow = Math.min(
        Math.max(0, targetSheet.totalRows - 1),
        matchingSource.firstDataRow
      );
      targetSheet.headerRow =
        matchingSource.headerRow === null
          ? null
          : Math.min(Math.max(0, targetSheet.totalRows - 1), matchingSource.headerRow);
    }

    targetSheet.sampleRateOverrideHz = matchingSource.sampleRateOverrideHz;
    recomputeExcelSheetPreview(targetSession, idx, {
      headerRow: targetSheet.headerRow,
      firstDataRow: targetSheet.firstDataRow,
      timeColIndex: matchingSource.timeColIndex,
      timeUnit: matchingSource.timeUnit,
      sampleRateOverrideHz: matchingSource.sampleRateOverrideHz,
    });

    // Copy explicit ignore/channel column roles by index
    targetSheet.columnMappings.forEach((col, cIdx) => {
      const srcCol = matchingSource.columnMappings[cIdx];
      if (!srcCol) return;
      if (cIdx === targetSheet.timeColIndex) {
        col.role = 'time';
        col.selected = false;
      } else if (srcCol.role === 'ignore') {
        col.role = 'ignore';
        col.selected = false;
      } else if (srcCol.role === 'channel' && !col.isTextColumn) {
        col.role = 'channel';
        col.selected = true;
      }
    });
  });

  const firstSel = targetSession.sheets.findIndex((s) => s.selected);
  if (firstSel >= 0) targetSession.activeSheetIndex = firstSel;
}

/**
 * Syncs one column's role (or all columns from the active sheet) across all checked sheets
 * in the active session and any other loaded workbook sessions.
 * Matches by header name first (unless auto-generated Col A/B/...), falling back to column index.
 * Returns the number of target sheets updated.
 */
export function syncExcelColumnRuleAcrossSheets(
  sessions: ExcelWorkbookSession[],
  sourceSessionIndex: number,
  sourceSheetIndex: number,
  opts?: { columnIndex?: number; checkedOnly?: boolean }
): number {
  const srcSession = sessions[sourceSessionIndex];
  const srcSheet = srcSession?.sheets[sourceSheetIndex];
  if (!srcSession || !srcSheet) return 0;

  const colIndices =
    opts?.columnIndex !== undefined
      ? [opts.columnIndex]
      : srcSheet.columnMappings.map((_, i) => i);
  const checkedOnly = opts?.checkedOnly !== false;
  let updatedSheets = 0;

  sessions.forEach((tgtSession, sIdx) => {
    tgtSession.sheets.forEach((tgtSheet, tIdx) => {
      if (sIdx === sourceSessionIndex && tIdx === sourceSheetIndex) return;
      if (checkedOnly && !tgtSheet.selected) return;

      let sheetTouched = false;
      let needsRecompute = false;

      for (const cIdx of colIndices) {
        const srcCol = srcSheet.columnMappings[cIdx];
        if (!srcCol) continue;

        const normHeader = (srcCol.header || '').trim().toLowerCase();
        const isFallbackHeader = !normHeader || /^col\s+[a-z]+$/i.test(normHeader);
        let tgtCol = !isFallbackHeader
          ? tgtSheet.columnMappings.find(
              (c) => (c.header || '').trim().toLowerCase() === normHeader
            )
          : undefined;
        if (!tgtCol) {
          tgtCol = tgtSheet.columnMappings[srcCol.index];
        }
        if (!tgtCol) continue;

        if (srcCol.role === 'ignore') {
          if (tgtCol.role !== 'ignore' || tgtCol.selected) {
            tgtCol.role = 'ignore';
            tgtCol.selected = false;
            sheetTouched = true;
          }
          if (tgtSheet.timeColIndex === tgtCol.index) {
            tgtSheet.timeColIndex = -1;
            needsRecompute = true;
            sheetTouched = true;
          }
        } else if (srcCol.role === 'time') {
          if (tgtSheet.timeColIndex !== tgtCol.index || tgtCol.role !== 'time') {
            tgtSheet.timeColIndex = tgtCol.index;
            tgtSheet.columnMappings.forEach((m) => {
              if (m.index === tgtCol!.index) {
                m.role = 'time';
                m.selected = false;
              } else if (m.role === 'time') {
                m.role = m.isTextColumn ? 'ignore' : 'channel';
                m.selected = m.role === 'channel';
              }
            });
            needsRecompute = true;
            sheetTouched = true;
          }
        } else if (srcCol.role === 'channel' && !tgtCol.isTextColumn) {
          if (tgtSheet.timeColIndex === tgtCol.index) {
            tgtSheet.timeColIndex = -1;
            needsRecompute = true;
            sheetTouched = true;
          }
          if (tgtCol.role !== 'channel' || !tgtCol.selected) {
            tgtCol.role = 'channel';
            tgtCol.selected = true;
            sheetTouched = true;
          }
        }
      }

      if (needsRecompute) {
        recomputeExcelSheetPreview(tgtSession, tgtSheet.sheetIndex, {
          timeColIndex: tgtSheet.timeColIndex,
          timeUnit: tgtSheet.timeUnit,
          sampleRateOverrideHz: tgtSheet.sampleRateOverrideHz,
          preserveColumnRoles: true,
        });
      }
      if (sheetTouched) updatedSheets++;
    });
  });

  return updatedSheets;
}


/**
 * Extracts full-resolution WaveformChannels for a single checked sheet from the active workbook.
 * Automatically skips all-NaN columns and normalizes Excel serial dates / clock strings to relative seconds (t[0] = 0).
 */
export function parseExcelSheetToChannels(
  session: ExcelWorkbookSession,
  sheetIndex: number,
  options: {
    resample: boolean;
    colors: string[];
    idPrefix?: string;
  }
): {
  sheetName: string;
  channels: Record<string, WaveformChannel>;
  drawOrder: string[];
  quality: SamplingMetadata;
  skippedEmptyColumns: string[];
} {
  if (session.released || !session.workbook) {
    throw new Error('Excel workbook session has been released.');
  }
  const sheet = session.sheets[sheetIndex];
  if (!sheet) {
    throw new Error(`Worksheet index ${sheetIndex} not found.`);
  }
  const ws = session.workbook.Sheets[sheet.sheetName];
  if (!ws || !ws['!ref']) {
    throw new Error(`Worksheet "${sheet.sheetName}" is empty.`);
  }

  const activeCols = sheet.columnMappings.filter((m) => m.role === 'channel');
  if (activeCols.length === 0) {
    throw new Error(`No numeric channel columns selected in "${sheet.sheetName}".`);
  }

  const range = XLSX.utils.decode_range(ws['!ref']);
  const startR = range.s.r + Math.max(0, sheet.firstDataRow);
  const endR = range.e.r;
  const rowCap = endR - startR + 1;
  if (rowCap <= 0) {
    throw new Error(`No data rows found in "${sheet.sheetName}".`);
  }

  const timeMult = getTimeUnitMultiplier(sheet.timeUnit);
  const overrideFs =
    sheet.sampleRateOverrideHz && sheet.sampleRateOverrideHz > 0 && isFinite(sheet.sampleRateOverrideHz)
      ? sheet.sampleRateOverrideHz
      : null;
  const hasExplicitTime = sheet.timeColIndex >= 0 && overrideFs === null;

  const rawTime = new Float64Array(rowCap);
  const rawValues: Float32Array[] = activeCols.map(() => new Float32Array(rowCap));

  let validCount = 0;
  let invalidRows = 0;
  let baseClockSec: number | null = null;
  let needsSort = false;
  let prevTime = -Infinity;

  let nonMonotonicRawCount = 0;
  const syntheticClockUsed = overrideFs === null && !hasExplicitTime;
  const perChannelNanCounts = new Int32Array(activeCols.length);

  for (let r = startR; r <= endR; r++) {
    let rowHasAnyValue = false;
    const rowVals = new Float32Array(activeCols.length);
    for (let c = 0; c < activeCols.length; c++) {
      const colAbs = range.s.c + activeCols[c].index;
      const addr = XLSX.utils.encode_cell({ r, c: colAbs });
      const cell = ws[addr] as XLSX.CellObject | undefined;
      let val = NaN;
      const targetUnit = activeCols[c].unit;
      if (cell) {
        if (cell.t === 'n' && typeof cell.v === 'number') {
          val = isFinite(cell.v) ? cell.v : NaN;
        } else if (cell.t === 's' || typeof cell.v === 'string') {
          val = parseNumericCell(String(cell.v ?? cell.w ?? ''), targetUnit);
        } else if (cell.w) {
          val = parseNumericCell(cell.w, targetUnit);
        }
      }
      rowVals[c] = isFinite(val) ? val : NaN;
      if (isFinite(val)) rowHasAnyValue = true;
    }

    let rowT = 0;
    if (overrideFs !== null) {
      if (!rowHasAnyValue) continue;
      rowT = validCount / overrideFs;
    } else if (hasExplicitTime) {
      const tAddr = XLSX.utils.encode_cell({ r, c: range.s.c + sheet.timeColIndex });
      const tCell = ws[tAddr] as XLSX.CellObject | undefined;
      if (!tCell || tCell.v === undefined || tCell.v === null) {
        if (rowHasAnyValue) invalidRows++;
        continue;
      }

      let tRaw = NaN;
      let isDateOrClock = false;
      if (tCell.t === 'd' && tCell.v instanceof Date) {
        tRaw = tCell.v.getTime() / 1000;
        isDateOrClock = true;
      } else if (tCell.t === 'n' && typeof tCell.v === 'number') {
        if (isExcelDateFormattedCell(tCell)) {
          tRaw = (tCell.v - 25569) * 86400;
          isDateOrClock = true;
        } else {
          tRaw = tCell.v;
        }
      } else {
        const parsedT = parseTimeCell(formatCellDisplay(tCell));
        tRaw = parsedT.value;
        isDateOrClock = parsedT.isClock;
      }

      if (isNaN(tRaw) || !isFinite(tRaw)) {
        if (rowHasAnyValue) invalidRows++;
        continue;
      }

      if (isDateOrClock) {
        if (baseClockSec === null) baseClockSec = tRaw;
        rowT = tRaw - baseClockSec;
      } else {
        rowT = tRaw * timeMult;
      }
    } else {
      if (!rowHasAnyValue) continue;
      rowT = validCount * 1e-4;
    }

    if (validCount > 0 && rowT < prevTime) {
      needsSort = true;
      nonMonotonicRawCount++;
    }
    prevTime = rowT;
    rawTime[validCount] = rowT;
    for (let c = 0; c < activeCols.length; c++) {
      const rv = rowVals[c];
      rawValues[c][validCount] = rv;
      if (!Number.isFinite(rv)) perChannelNanCounts[c]++;
    }
    validCount++;
  }

  if (validCount === 0) {
    throw new Error(`No valid numeric rows extracted from "${sheet.sheetName}".`);
  }

  let finalTime = rawTime.slice(0, validCount);
  const orderedValues = rawValues.map((arr) => arr.slice(0, validCount));

  if (needsSort) {
    const order = Array.from({ length: validCount }, (_, i) => i);
    order.sort((a, b) => finalTime[a] - finalTime[b]);
    const sortedT = new Float64Array(validCount);
    for (let i = 0; i < validCount; i++) sortedT[i] = finalTime[order[i]];
    finalTime = sortedT;
    for (let c = 0; c < orderedValues.length; c++) {
      const src = orderedValues[c];
      const dst = new Float32Array(validCount);
      for (let i = 0; i < validCount; i++) dst[i] = src[order[i]];
      orderedValues[c] = dst;
    }
  }

  const totalSignalNanCount = perChannelNanCounts.reduce((a, b) => a + b, 0);
  const quality = analyzeSamplingQuality(finalTime, invalidRows, totalSignalNanCount);
  quality.nonMonotonicCount = (quality.nonMonotonicCount || 0) + nonMonotonicRawCount;
  quality.syntheticClockUsed = syntheticClockUsed;
  quality.rawGapCount = quality.gapCount;
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
  const skippedEmptyColumns: string[] = [];
  const idPrefix = options.idPrefix || `xls_s${sheet.sheetIndex}`;

  for (let c = 0; c < activeCols.length; c++) {
    const chMap = activeCols[c];
    const chRawV = orderedValues[c];
    const chNanCount = perChannelNanCounts[c];

    let finiteCount = 0;
    for (let i = 0; i < chRawV.length; i++) {
      if (!isNaN(chRawV[i]) && isFinite(chRawV[i])) finiteCount++;
    }
    if (finiteCount === 0) {
      skippedEmptyColumns.push(chMap.channelName || chMap.header);
      continue;
    }

    let finalT: Float64Array = finalTime;
    let finalV: Float32Array = chRawV;
    let fs = quality.sampleRate;
    let dt = quality.nominalDt;
    let chMeta: SamplingMetadata = {
      ...quality,
      sampleRate: fs,
      nominalDt: dt,
      signalNanCount: chNanCount,
    };

    if (
      options.resample &&
      overrideFs === null &&
      (!quality.isUniformSampling || quality.qualityStatus !== 'uniform') &&
      finalTime.length >= 2
    ) {
      const res = resampleUniform(finalTime, chRawV, { allowGapInterpolation: true });
      finalT = res.t;
      finalV = res.v;
      fs = res.fs;
      dt = res.dt;
      chMeta = {
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
        rawGapCount: quality.gapCount,
        resampledFromNonUniform: true,
        signalNanCount: chNanCount,
      };
    }

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < finalV.length; i++) {
      const v = finalV[i];
      if (!isNaN(v) && isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!isFinite(min)) min = -1;
    if (!isFinite(max)) max = 1;
    const margin = (max - min) * 0.1 || 1.0;

    const chIdx = drawOrder.length;
    const chId = `${idPrefix}_c${chMap.index}_${chIdx}`;
    const color = options.colors[chIdx % options.colors.length] || '#22d3ee';

    channels[chId] = {
      id: chId,
      name: chMap.channelName || chMap.header || `Col ${chMap.colLetter}`,
      unit: chMap.unit || 'V',
      color,
      visible: true,
      t: finalT,
      v: finalV,
      fs,
      dt,
      isMath: false,
      channelKind: 'raw',
      sourceChannelIds: [],
      metadata: chMeta,
      rawT: finalTime,
      rawV: chRawV,
      vMin: min - margin,
      vMax: max + margin,
    };
    drawOrder.push(chId);
  }

  if (drawOrder.length === 0) {
    throw new Error(`All selected columns in "${sheet.sheetName}" contained only text or empty values.`);
  }

  return {
    sheetName: sheet.sheetName,
    channels,
    drawOrder,
    quality,
    skippedEmptyColumns,
  };
}

/**
 * Releases cached SheetJS Workbook & preview buffers immediately after modal close or import completion.
 */
export function releaseExcelWorkbookSession(session: ExcelWorkbookSession | null | undefined): void {
  if (!session) return;
  session.workbook = null;
  session.file = undefined;
  for (const sheet of session.sheets) {
    previewMetaCache.delete(sheet);
    sheet.previewRows = [];
    sheet.columnMappings = [];
    sheet.quality = null;
  }
  session.sheets = [];
  session.released = true;
}
