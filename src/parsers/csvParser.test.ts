import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCsvPreviewQuality, parseFullCsv, previewCsv } from './csvParser';

function parseWithOverride(csv: string, sampleRateOverrideHz: number) {
  const preview = previewCsv(csv);
  const parsed = parseFullCsv(csv, {
    delimiter: preview.delimiter,
    hasHeader: preview.hasHeader,
    skipLines: preview.skipLines,
    timeColIndex: preview.timeColIndex,
    timeUnit: preview.timeUnit,
    sampleRateOverrideHz,
    columnMappings: preview.columnMappings,
    resample: false,
    colors: ['#ffffff'],
  });
  return { preview, parsed };
}

test('manual sample rate thins explicit Time rows without synthesizing timestamps or values', () => {
  const csv = 'Time (ms),Vds\n10,12\n10.5,13\n11,14';
  const { preview, parsed } = parseWithOverride(csv, 1000);
  const channel = parsed.channels[parsed.drawOrder[0]];

  assert.equal(preview.timeColIndex, 0);
  assert.deepEqual(Array.from(channel.t), [0.01, 0.011]);
  assert.deepEqual(Array.from(channel.v), [12, 14]);
  assert.ok(channel.fs !== null && Math.abs(channel.fs - 1000) < 1e-6);
  assert.equal(parsed.quality.decimatedSampleCount, 1);
  assert.equal(parsed.quality.sourceRowsDecimated, true);
  assert.equal(parsed.quality.syntheticClockUsed, false);

  const previewQuality = computeCsvPreviewQuality(csv, preview, 'ms', 1000);
  assert.ok(previewQuality);
  assert.ok(Math.abs((previewQuality!.sampleRate || 0) - 1000) < 1e-6);
  assert.equal(previewQuality!.decimatedSampleCount, 1);
});

test('manual sample rate creates an index-based timebase only when source Time is absent', () => {
  const csv = 'Vds,Ids\n12,1\n13,2\n11,3';
  const { preview, parsed } = parseWithOverride(csv, 500);
  const channel = parsed.channels[parsed.drawOrder[0]];

  assert.equal(preview.timeColIndex, -1);
  assert.deepEqual(Array.from(channel.t), [0, 0.002, 0.004]);
  assert.equal(channel.fs, 500);
  assert.equal(parsed.quality.syntheticClockUsed, true);
});


test('manual Time-column thinning uses original rows on irregular timestamps and keeps channel alignment', () => {
  const csv = 'Time (us),Ia,Ib\n0,10,20\n10,11,21\n20.5,12,22\n31,13,23\n45,14,24\n';
  const preview = previewCsv(csv);
  const parsed = parseFullCsv(csv, {
    delimiter: ',', hasHeader: true, skipLines: 0, timeColIndex: preview.timeColIndex,
    timeUnit: 'us', sampleRateOverrideHz: 50000,
    columnMappings: preview.columnMappings, resample: true, colors: ['#fff', '#000'],
  });
  const ia = parsed.channels[parsed.drawOrder[0]];
  const ib = parsed.channels[parsed.drawOrder[1]];
  const expectedTimes = [0, 20.5e-6, 45e-6];
  assert.equal(ia.t.length, expectedTimes.length);
  expectedTimes.forEach((expected, index) => assert.ok(Math.abs(ia.t[index] - expected) < 1e-15));
  assert.deepEqual(Array.from(ia.v), [10, 12, 14]);
  assert.deepEqual(Array.from(ib.v), [20, 22, 24]);
  assert.equal(ia.t.length, ia.v.length);
  assert.equal(parsed.quality.decimatedSampleCount, 2);
  assert.equal(parsed.quality.requestedSampleRateHz, 50000);
});
