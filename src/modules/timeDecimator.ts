/**
 * Time-domain sample thinning for measured waveform records.
 *
 * This is intentionally NOT a resampler: it only returns indices of rows that
 * already exist in the source capture. Callers must apply the same indices to
 * the timestamp array and every channel/value array.
 */
export function selectTimeDecimationIndices(
  time: ArrayLike<number>,
  targetSampleRateHz: number | null | undefined
): number[] {
  const n = time.length;
  if (!Number.isFinite(targetSampleRateHz) || !targetSampleRateHz || targetSampleRateHz <= 0) {
    return Array.from({ length: n }, (_, i) => i);
  }
  if (n === 0) return [];

  const minInterval = 1 / targetSampleRateHz;
  const firstTime = Number(time[0]);
  if (!Number.isFinite(firstTime)) {
    throw new Error('手动降采样失败：Time 列包含非有限时间戳。');
  }
  const indices: number[] = [0];
  let lastKeptTime = firstTime;
  let previousSourceTime = firstTime;

  for (let i = 1; i < n; i++) {
    const currentTime = Number(time[i]);
    if (!Number.isFinite(currentTime)) {
      throw new Error(`手动降采样失败：第 ${i + 1} 个时间戳不是有限数值。`);
    }
    if (currentTime < previousSourceTime) {
      throw new Error('手动降采样失败：时间戳必须按非递减顺序排列。');
    }
    previousSourceTime = currentTime;

    // Keep an original row only after the requested minimum time spacing.
    // Duplicate timestamps are not selected twice.
    if (currentTime - lastKeptTime >= minInterval || i === n - 1) {
      if (currentTime > lastKeptTime) {
        indices.push(i);
        lastKeptTime = currentTime;
      }
    }
  }

  // The final *timestamp* remains represented, even when the final source row
  // duplicates a previously retained timestamp. In that case we keep the first
  // row at that timestamp instead of creating a duplicate-time output point.
  return indices;
}

export function selectArrayByIndices<T extends Float32Array | Float64Array | Uint32Array>(
  source: T,
  indices: number[]
): T {
  const TypedArrayCtor = source.constructor as new (length: number) => T;
  const result = new TypedArrayCtor(indices.length);
  for (let i = 0; i < indices.length; i++) result[i] = source[indices[i]];
  return result;
}
