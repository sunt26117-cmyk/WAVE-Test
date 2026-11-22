/**
 * Waveform Viewer Pro - Batch Folder/Multi-File Measurement Comparison Engine
 */

import {
  ChannelMeasurements,
  MeasurementGate,
  MeasurementMetricKey,
  WaveformChannel,
} from '../types/models';
import { previewCsv, parseFullCsv } from '../parsers/csvParser';
import { parseWfmBuffer } from '../parsers/wfmParser';
import {
  isExcelFileName,
  openExcelWorkbookSession,
  parseExcelSheetToChannels,
  releaseExcelWorkbookSession,
} from '../parsers/excelParser';
import type { ExcelImportedSheetPayload } from './excelImportModal';
import { computeMeasurements, MEASUREMENT_DEFINITIONS } from './measurements';

export interface BatchFileRow {
  fileName: string;
  fileSizeBytes: number;
  channelName: string;
  unit: string;
  sampleCount: number;
  sampleRateHz: number | null;
  status: 'ok' | 'error';
  errorMessage?: string;
  measurements: ChannelMeasurements | null;
  passStatus?: 'PASS' | 'FAIL' | 'N/A';
}

export interface BatchThresholds {
  metric?: MeasurementMetricKey;
  minLimit?: number | null;
  maxLimit?: number | null;
}

const DEFAULT_COLORS = ['#facc15', '#22d3ee', '#f472b6', '#4ade80'];

function evaluateSingleChannelBatchRow(
  displayFileName: string,
  fileSizeBytes: number,
  channels: Record<string, WaveformChannel>,
  drawOrder: string[],
  channelIndex: number,
  gate: MeasurementGate,
  thresholds?: BatchThresholds
): BatchFileRow {
  if (drawOrder.length === 0) {
    throw new Error('No waveform channels detected.');
  }

  const targetId = drawOrder[Math.min(Math.max(0, channelIndex), drawOrder.length - 1)];
  const ch = channels[targetId];
  if (!ch || ch.v.length === 0) {
    throw new Error('Selected channel has no samples.');
  }

  const effectiveGate: MeasurementGate = gate === 'cursors' ? 'entire' : gate;
  const m = computeMeasurements(ch, effectiveGate, { startIndex: 0, endIndex: ch.v.length }, {
    enabled: false,
    x1: null,
    x2: null,
    y1: null,
    y2: null,
    trackingChannel: null,
  });

  let passStatus: 'PASS' | 'FAIL' | 'N/A' = 'N/A';
  if (thresholds && thresholds.metric) {
    const val = (m as any)[thresholds.metric] as number | null;
    if (val === null || !isFinite(val)) {
      passStatus = 'FAIL';
    } else {
      const minOk =
        thresholds.minLimit === null ||
        thresholds.minLimit === undefined ||
        !isFinite(thresholds.minLimit) ||
        val >= thresholds.minLimit;
      const maxOk =
        thresholds.maxLimit === null ||
        thresholds.maxLimit === undefined ||
        !isFinite(thresholds.maxLimit) ||
        val <= thresholds.maxLimit;
      passStatus = minOk && maxOk ? 'PASS' : 'FAIL';
    }
  }

  return {
    fileName: displayFileName,
    fileSizeBytes,
    channelName: ch.name,
    unit: ch.unit || 'V',
    sampleCount: ch.v.length,
    sampleRateHz: ch.fs,
    status: 'ok',
    measurements: m,
    passStatus,
  };
}

export async function runBatchAnalysisOnFiles(
  files: File[],
  channelIndex: number,
  metrics: MeasurementMetricKey[],
  gate: MeasurementGate = 'entire',
  thresholds?: BatchThresholds,
  preExtractedExcelItems?: ExcelImportedSheetPayload[]
): Promise<BatchFileRow[]> {
  const rows: BatchFileRow[] = [];

  for (const file of files) {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (isExcelFileName(file.name)) {
      if (preExtractedExcelItems && preExtractedExcelItems.length > 0) {
        continue; // Handled below via user-confirmed Excel sheet payloads
      }
      let session: Awaited<ReturnType<typeof openExcelWorkbookSession>> | null = null;
      try {
        session = await openExcelWorkbookSession(file);
        const selSheets = session.sheets.filter((s) => s.selected);
        if (selSheets.length === 0) {
          throw new Error('No numeric sheets detected in workbook.');
        }
        for (const sh of selSheets) {
          try {
            const parsed = parseExcelSheetToChannels(session, sh.sheetIndex, {
              resample: !!(sh.quality && !sh.quality.isUniformSampling),
              colors: DEFAULT_COLORS,
            });
            rows.push(
              evaluateSingleChannelBatchRow(
                selSheets.length > 1 || session.sheets.length > 1
                  ? `${file.name} [${parsed.sheetName}]`
                  : file.name,
                file.size,
                parsed.channels,
                parsed.drawOrder,
                channelIndex,
                gate,
                thresholds
              )
            );
          } catch (sheetErr: any) {
            rows.push({
              fileName: `${file.name} [${sh.sheetName}]`,
              fileSizeBytes: file.size,
              channelName: '--',
              unit: '',
              sampleCount: 0,
              sampleRateHz: null,
              status: 'error',
              errorMessage: sheetErr?.message || 'Sheet parse failure',
              measurements: null,
              passStatus: 'FAIL',
            });
          }
        }
      } catch (err: any) {
        rows.push({
          fileName: file.name,
          fileSizeBytes: file.size,
          channelName: '--',
          unit: '',
          sampleCount: 0,
          sampleRateHz: null,
          status: 'error',
          errorMessage: err?.message || 'Excel parse failure',
          measurements: null,
          passStatus: 'FAIL',
        });
      } finally {
        releaseExcelWorkbookSession(session);
      }
      continue;
    }

    if (ext !== 'csv' && ext !== 'txt' && ext !== 'wfm') {
      continue;
    }

    try {
      let channels: Record<string, WaveformChannel>;
      let drawOrder: string[];

      if (ext === 'wfm') {
        const buf = await file.arrayBuffer();
        const parsed = parseWfmBuffer(buf, file.name, DEFAULT_COLORS);
        channels = parsed.channels;
        drawOrder = parsed.drawOrder;
      } else {
        const text = await file.text();
        const p = previewCsv(text);
        const shouldResample = !!(p.quality && !p.quality.isUniformSampling);
        const parsed = parseFullCsv(text, {
          delimiter: p.delimiter,
          hasHeader: p.hasHeader,
          skipLines: p.skipLines,
          timeColIndex: p.timeColIndex,
          timeUnit: p.timeUnit,
          sampleRateOverrideHz: p.sampleRateOverrideHz ?? null,
          columnMappings: p.columnMappings,
          resample: shouldResample,
          colors: DEFAULT_COLORS,
        });
        channels = parsed.channels;
        drawOrder = parsed.drawOrder;
      }

      rows.push(
        evaluateSingleChannelBatchRow(
          file.name,
          file.size,
          channels,
          drawOrder,
          channelIndex,
          gate,
          thresholds
        )
      );
    } catch (err: any) {
      rows.push({
        fileName: file.name,
        fileSizeBytes: file.size,
        channelName: '--',
        unit: '',
        sampleCount: 0,
        sampleRateHz: null,
        status: 'error',
        errorMessage: err?.message || 'Parse failure',
        measurements: null,
        passStatus: 'FAIL',
      });
    }
  }

  if (preExtractedExcelItems && preExtractedExcelItems.length > 0) {
    for (const item of preExtractedExcelItems) {
      const displayName = `${item.fileName} [${item.sheetName}]`;
      try {
        rows.push(
          evaluateSingleChannelBatchRow(
            displayName,
            item.fileSizeBytes,
            item.channels,
            item.drawOrder,
            channelIndex,
            gate,
            thresholds
          )
        );
      } catch (err: any) {
        rows.push({
          fileName: displayName,
          fileSizeBytes: item.fileSizeBytes,
          channelName: '--',
          unit: '',
          sampleCount: 0,
          sampleRateHz: null,
          status: 'error',
          errorMessage: err?.message || 'Excel parse failure',
          measurements: null,
          passStatus: 'FAIL',
        });
      }
    }
  }

  return rows;
}

export function exportBatchResultsCSV(rows: BatchFileRow[], metrics: MeasurementMetricKey[]): string {
  const defs = metrics
    .map((k) => MEASUREMENT_DEFINITIONS.find((d) => d.key === k))
    .filter((d): d is NonNullable<typeof d> => !!d);

  const headerCols = [
    'File',
    'Channel',
    'Samples',
    'SampleRate(Hz)',
    'Result',
    ...defs.map((d) => d.shortLabel),
    'Status/Error',
  ];

  const lines: string[] = [headerCols.join(',')];
  for (const r of rows) {
    const mVals = defs.map((d) => {
      if (!r.measurements) return '';
      const raw = (r.measurements as any)[d.key] as number | null;
      return raw !== null && isFinite(raw) ? raw.toPrecision(6) : '';
    });
    const cols = [
      `"${r.fileName.replace(/"/g, '""')}"`,
      `"${r.channelName.replace(/"/g, '""')}"`,
      `${r.sampleCount}`,
      `${r.sampleRateHz ?? ''}`,
      `${r.passStatus || 'N/A'}`,
      ...mVals,
      `"${r.errorMessage ? r.errorMessage.replace(/"/g, '""') : 'OK'}"`,
    ];
    lines.push(cols.join(','));
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  const filename = `Batch_Measurement_Summary_${Date.now()}.csv`;
  link.download = filename;
  link.href = URL.createObjectURL(blob);
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  return filename;
}
