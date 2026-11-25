import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  createExcelWorkbookSessionFromBuffer,
  parseExcelSheetToChannels,
  recomputeExcelSheetPreview,
  releaseExcelWorkbookSession,
} from './excelParser';

function createWorkbook(rows: unknown[][]): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Waveform');
  return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

test('Excel manual sample rate thins source Time rows and keeps each channel on the original timestamps', () => {
  const session = createExcelWorkbookSessionFromBuffer(
    createWorkbook([
      ['Time (ms)', 'Vds', 'Ids'],
      [10, 12, 1],
      [10.5, 13, 2],
      [11, 14, 3],
    ]),
    'time-decimation.xlsx'
  );

  try {
    const sheet = recomputeExcelSheetPreview(session, 0, {
      timeColIndex: 0,
      timeUnit: 'ms',
      sampleRateOverrideHz: 1000,
      preserveColumnRoles: true,
    });
    assert.ok(sheet);
    assert.equal(sheet!.timeColIndex, 0);

    const parsed = parseExcelSheetToChannels(session, 0, {
      resample: true,
      colors: ['#fff', '#000'],
    });
    const vds = parsed.channels[parsed.drawOrder[0]];
    const ids = parsed.channels[parsed.drawOrder[1]];

    assert.deepEqual(Array.from(vds.t), [0.01, 0.011]);
    assert.deepEqual(Array.from(vds.v), [12, 14]);
    assert.deepEqual(Array.from(ids.v), [1, 3]);
    assert.equal(vds.t.length, vds.v.length);
    assert.equal(ids.t.length, ids.v.length);
    assert.equal(parsed.quality.syntheticClockUsed, false);
    assert.equal(parsed.quality.sourceRowsDecimated, true);
    assert.equal(parsed.quality.decimatedSampleCount, 1);
    assert.equal(parsed.quality.requestedSampleRateHz, 1000);
  } finally {
    releaseExcelWorkbookSession(session);
  }
});

test('Excel manual sample rate uses an index timebase only when no Time column exists', () => {
  const session = createExcelWorkbookSessionFromBuffer(
    createWorkbook([
      ['Vds', 'Ids'],
      [12, 1],
      [13, 2],
      [14, 3],
    ]),
    'synthetic-time.xlsx'
  );

  try {
    const sheet = recomputeExcelSheetPreview(session, 0, {
      timeColIndex: -1,
      sampleRateOverrideHz: 500,
      preserveColumnRoles: true,
    });
    assert.ok(sheet);

    const parsed = parseExcelSheetToChannels(session, 0, {
      resample: false,
      colors: ['#fff', '#000'],
    });
    const vds = parsed.channels[parsed.drawOrder[0]];
    assert.deepEqual(Array.from(vds.t), [0, 0.002, 0.004]);
    assert.equal(parsed.quality.syntheticClockUsed, true);
    assert.equal(parsed.quality.sourceRowsDecimated, undefined);
    assert.equal(vds.fs, 500);
  } finally {
    releaseExcelWorkbookSession(session);
  }
});
