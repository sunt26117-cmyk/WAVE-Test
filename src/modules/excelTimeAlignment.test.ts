import test from 'node:test';
import assert from 'node:assert/strict';
import type { WaveformChannel } from '../types/models';
import { mergeExcelChannelsByTime, resolveExcelMergedViewport } from './excelTimeAlignment';

function channel(id: string, t: number[], v: number[], rawT = t): WaveformChannel {
  return {
    id,
    name: id,
    unit: 'V',
    color: '#ffffff',
    visible: true,
    t: Float64Array.from(t),
    v: Float32Array.from(v),
    rawT: Float64Array.from(rawT),
    rawV: Float32Array.from(v),
    fs: null,
    dt: null,
    isMath: false,
    sourceChannelIds: [],
    metadata: {
      originalSampleCount: t.length,
      originalTimeStart: t[0] ?? 0,
      originalTimeEnd: t[t.length - 1] ?? 0,
      isUniformSampling: false,
      nominalDt: null,
      medianDt: null,
      meanDt: null,
      minDt: null,
      maxDt: null,
      jitterRms: null,
      jitterMax: null,
      droppedSamples: 0,
      invalidSamples: 0,
      sampleRate: null,
      qualityStatus: 'non-uniform',
      gapCount: 0,
      gapIndices: [],
    },
    vMin: Math.min(...v),
    vMax: Math.max(...v),
  };
}

test('Excel merge preserves independent numeric time axes and reports common overlap', () => {
  const a = channel('a', [0, 0.1, 0.2], [1, 2, 3]);
  const b = channel('b', [0.02, 0.12, 0.22], [4, 5, 6]);
  const result = mergeExcelChannelsByTime([
    { fileName: 'a.xlsx', sheetName: 'A', channels: { a }, drawOrder: ['a'], timeOriginKind: 'numeric' },
    { fileName: 'b.xlsx', sheetName: 'B', channels: { b }, drawOrder: ['b'], timeOriginKind: 'numeric' },
  ]);

  assert.equal(result.drawOrder.length, 2);
  assert.deepEqual(Array.from(result.channels[result.drawOrder[0]].t), [0, 0.1, 0.2]);
  assert.deepEqual(Array.from(result.channels[result.drawOrder[1]].t), [0.02, 0.12, 0.22]);
  assert.ok(result.hasCommonOverlap);
  assert.ok(Math.abs(result.commonOverlapSec - 0.18) < 1e-12);
  assert.ok(Math.abs(result.minimumOverlapPct - 90) < 1e-9);
  assert.ok(result.warnings.some((warning) => warning.includes('共同触发基准')));
});

test('Excel merge restores absolute Excel date-time origins before overlap calculation', () => {
  const a = channel('a', [0, 0.1, 0.2], [1, 2, 3]);
  const b = channel('b', [0, 0.1, 0.2], [4, 5, 6]);
  const result = mergeExcelChannelsByTime([
    { fileName: 'a.xlsx', sheetName: 'A', channels: { a }, drawOrder: ['a'], timeOriginSec: 1_000_000_000, timeOriginKind: 'absolute-date' },
    { fileName: 'b.xlsx', sheetName: 'B', channels: { b }, drawOrder: ['b'], timeOriginSec: 1_000_000_000.05, timeOriginKind: 'absolute-date' },
  ]);

  assert.ok(result.hasCommonOverlap);
  assert.ok(Math.abs(result.commonOverlapSec - 0.15) < 5e-7);
  assert.ok(Math.abs(result.channels[result.drawOrder[1]].t[0] - 1_000_000_000.05) < 1e-6);
});

test('Excel merge refuses to claim overlap across incompatible time coordinate domains', () => {
  const a = channel('a', [0, 0.1, 0.2], [1, 2, 3]);
  const b = channel('b', [0, 0.1, 0.2], [4, 5, 6]);
  const result = mergeExcelChannelsByTime([
    { fileName: 'date.xlsx', sheetName: 'A', channels: { a }, drawOrder: ['a'], timeOriginSec: 1_000_000_000, timeOriginKind: 'absolute-date' },
    { fileName: 'numeric.xlsx', sheetName: 'B', channels: { b }, drawOrder: ['b'], timeOriginKind: 'numeric' },
  ]);

  assert.equal(result.hasCommonOverlap, false);
  assert.equal(result.commonStartSec, null);
  assert.ok(result.warnings.some((warning) => warning.includes('不同时间坐标类型')));
  assert.equal(result.canMergePreservingTime, false);
});

test('Excel merge does not infer cross-file synchronization from synthetic time axes', () => {
  const a = channel('a', [0, 0.1, 0.2], [1, 2, 3]);
  const b = channel('b', [0, 0.1, 0.2], [4, 5, 6]);
  const result = mergeExcelChannelsByTime([
    { fileName: 'a.xlsx', sheetName: 'A', channels: { a }, drawOrder: ['a'], timeOriginKind: 'synthetic' },
    { fileName: 'b.xlsx', sheetName: 'B', channels: { b }, drawOrder: ['b'], timeOriginKind: 'synthetic' },
  ]);

  assert.equal(result.hasCommonOverlap, false);
  assert.ok(result.warnings.some((warning) => warning.includes('不计算跨文件公共重叠')));
  assert.equal(result.canMergePreservingTime, false);
});

test('Excel merge align-start translates t and rawT only, without changing signal samples', () => {
  const a = channel('a', [10, 10.1, 10.2], [1, 2, 3]);
  const b = channel('b', [20, 20.1, 20.2], [4, 5, 6]);
  const originalA = Array.from(a.v);
  const originalB = Array.from(b.v);
  const result = mergeExcelChannelsByTime([
    { fileName: 'a.xlsx', sheetName: 'A', channels: { a }, drawOrder: ['a'], timeOriginKind: 'numeric' },
    { fileName: 'b.xlsx', sheetName: 'B', channels: { b }, drawOrder: ['b'], timeOriginKind: 'numeric' },
  ], undefined, 'align-start');

  const alignedA = result.channels[result.drawOrder[0]].t;
  assert.ok(Math.abs(alignedA[0]) < 1e-12);
  assert.ok(Math.abs(alignedA[1] - 0.1) < 1e-12);
  assert.ok(Math.abs(alignedA[2] - 0.2) < 1e-12);
  assert.ok(Math.abs(result.channels[result.drawOrder[1]].t[0]) < 1e-12);
  assert.ok(Math.abs(result.channels[result.drawOrder[1]].rawT![0]) < 1e-12);
  assert.deepEqual(Array.from(result.channels[result.drawOrder[0]].v), originalA);
  assert.deepEqual(Array.from(result.channels[result.drawOrder[1]].v), originalB);
  assert.ok(result.warnings.some((warning) => warning.includes('首样本平移')));
});

test('Excel merge keeps clock-only ambiguity visible', () => {
  const a = channel('a', [0, 1, 2], [1, 2, 3]);
  const b = channel('b', [0, 1, 2], [4, 5, 6]);
  const result = mergeExcelChannelsByTime([
    { fileName: 'a.xlsx', sheetName: 'A', channels: { a }, drawOrder: ['a'], timeOriginSec: 86_399, timeOriginKind: 'clock-of-day' },
    { fileName: 'b.xlsx', sheetName: 'B', channels: { b }, drawOrder: ['b'], timeOriginSec: 1, timeOriginKind: 'clock-of-day' },
  ]);

  assert.ok(result.warnings.some((warning) => warning.includes('没有日期')));
});


test('Excel merged viewport is derived from time span, not the maximum sample count', () => {
  const fastShort = channel('fast', [1, 1.001, 1.002], [1, 2, 3]);
  const slowLong = channel('slow', [1.0005, 1.01, 1.02, 1.03, 1.04], [4, 5, 6, 7, 8]);
  const result = mergeExcelChannelsByTime([
    { fileName: 'fast.xlsx', sheetName: 'A', channels: { fast: fastShort }, drawOrder: ['fast'], timeOriginKind: 'numeric' },
    { fileName: 'slow.xlsx', sheetName: 'B', channels: { slow: slowLong }, drawOrder: ['slow'], timeOriginKind: 'numeric' },
  ]);
  const viewport = resolveExcelMergedViewport(result);
  assert.ok(viewport);
  assert.equal(viewport!.primaryChannelId, result.drawOrder[0]);
  // The X window extends through the 40 ms union span despite the primary channel having 1 ms steps.
  assert.ok(viewport!.endIndex >= 39, `Expected time-based extension, got endIndex ${viewport!.endIndex}`);
  assert.ok(Math.abs(viewport!.unionEndSec - 1.04) < 1e-12);
});

test('A single synthetic worksheet may merge its own channels, but multiple synthetic source axes may not be preserved together', () => {
  const a = channel('a', [0, 0.1, 0.2], [1, 2, 3]);
  const b = channel('b', [0, 0.1, 0.2], [4, 5, 6]);
  const oneSource = mergeExcelChannelsByTime([
    { fileName: 'one.xlsx', sheetName: 'one', channels: { a, b }, drawOrder: ['a', 'b'], timeOriginKind: 'synthetic' },
  ]);
  assert.equal(oneSource.canMergePreservingTime, true);
  const twoSources = mergeExcelChannelsByTime([
    { fileName: 'one.xlsx', sheetName: 'one', channels: { a }, drawOrder: ['a'], timeOriginKind: 'synthetic' },
    { fileName: 'two.xlsx', sheetName: 'two', channels: { b }, drawOrder: ['b'], timeOriginKind: 'synthetic' },
  ]);
  assert.equal(twoSources.canMergePreservingTime, false);
});
