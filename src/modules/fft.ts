/**
 * Waveform Viewer Pro - FFT Analysis Module
 * Pure radix-2 Cooley-Tukey FFT, windowing with coherent gain normalization,
 * sub-bin peak detection, and BLDC motor electrical frequency harmonic analysis.
 */

import {
  FFTOptions,
  FFTWindowType,
  SpectrumPeak,
  SpectrumResult,
  HarmonicMarker,
  MotorConfig,
} from '../types/models';

/**
 * Calculates radix-2 discrete Fourier transform in-place.
 * @param real Float64Array of real parts (length must be power of 2)
 * @param imag Float64Array of imaginary parts (length must be power of 2)
 */
export function radix2FFT(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  if ((n & (n - 1)) !== 0) {
    throw new Error(`FFT length must be a power of 2, received ${n}`);
  }

  // Bit reversal permutation
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      const tempR = real[i];
      real[i] = real[j];
      real[j] = tempR;

      const tempI = imag[i];
      imag[i] = imag[j];
      imag[j] = tempI;
    }
    let k = n >> 1;
    while (k <= j) {
      j -= k;
      k >>= 1;
    }
    j += k;
  }

  // Danielson-Lanczos section
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wStepR = Math.cos(angle);
    const wStepI = Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let wR = 1.0;
      let wI = 0.0;

      for (let k = 0; k < halfLen; k++) {
        const uR = real[i + k];
        const uI = imag[i + k];

        const pos = i + k + halfLen;
        const vR = real[pos] * wR - imag[pos] * wI;
        const vI = real[pos] * wI + imag[pos] * wR;

        real[i + k] = uR + vR;
        imag[i + k] = uI + vI;

        real[pos] = uR - vR;
        imag[pos] = uI - vI;

        const nextWR = wR * wStepR - wI * wStepI;
        const nextWI = wR * wStepI + wI * wStepR;
        wR = nextWR;
        wI = nextWI;
      }
    }
  }
}

/**
 * Computes window function values and coherent gain.
 */
export function getWindow(
  type: FFTWindowType,
  length: number
): { weights: Float64Array; coherentGain: number } {
  const weights = new Float64Array(length);
  let sum = 0;

  if (length <= 1) {
    weights[0] = 1.0;
    return { weights, coherentGain: 1.0 };
  }

  const denom = length - 1;

  for (let n = 0; n < length; n++) {
    let w = 1.0;
    switch (type) {
      case 'hann':
        w = 0.5 * (1 - Math.cos((2 * Math.PI * n) / denom));
        break;
      case 'hamming':
        w = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / denom);
        break;
      case 'blackman-harris': {
        const a0 = 0.35875;
        const a1 = 0.48829;
        const a2 = 0.14128;
        const a3 = 0.01168;
        w =
          a0 -
          a1 * Math.cos((2 * Math.PI * n) / denom) +
          a2 * Math.cos((4 * Math.PI * n) / denom) -
          a3 * Math.cos((6 * Math.PI * n) / denom);
        break;
      }
      case 'rectangular':
      default:
        w = 1.0;
        break;
    }
    weights[n] = w;
    sum += w;
  }

  const coherentGain = sum / length;
  return { weights, coherentGain };
}

/**
 * Largest power of 2 <= n.
 */
export function floorPowerOfTwo(n: number): number {
  if (n <= 1) return 1;
  let p = 1;
  while (p * 2 <= n) {
    p *= 2;
  }
  return p;
}

/**
 * Finds spectral peaks with parabolic interpolation to achieve sub-bin frequency accuracy.
 */
export function detectPeaks(
  frequencies: Float32Array,
  magnitudes: Float32Array,
  dbValues: Float32Array,
  options: {
    thresholdDb?: number;
    minDistanceHz?: number;
    maxPeaks?: number;
  } = {}
): SpectrumPeak[] {
  const numBins = magnitudes.length;
  if (numBins < 4) return [];

  const thresholdDb = options.thresholdDb ?? -60;
  const minDistanceHz = options.minDistanceHz ?? (frequencies[1] - frequencies[0]) * 3;
  const maxPeaks = options.maxPeaks ?? 10;

  const candidatePeaks: SpectrumPeak[] = [];

  // Ignore DC (bin 0) and bin 1 to prevent false low-frequency baseline peak
  for (let k = 2; k < numBins - 1; k++) {
    const currentMag = magnitudes[k];
    const prevMag = magnitudes[k - 1];
    const nextMag = magnitudes[k + 1];
    const currentDb = dbValues[k];

    if (currentMag > prevMag && currentMag > nextMag && currentDb >= thresholdDb) {
      // Parabolic interpolation for fine frequency and amplitude
      const y1 = prevMag;
      const y2 = currentMag;
      const y3 = nextMag;
      const denom = y1 - 2 * y2 + y3;
      let delta = 0;
      if (Math.abs(denom) > 1e-12) {
        delta = (0.5 * (y1 - y3)) / denom;
      }
      // Bound delta to [-0.5, 0.5]
      delta = Math.max(-0.5, Math.min(0.5, delta));

      const binWidth = frequencies[1] - frequencies[0];
      const fineFreq = (k + delta) * binWidth;
      const fineMag = y2 - 0.25 * (y1 - y3) * delta;
      const fineDb = 20 * Math.log10(Math.max(fineMag, 1e-12));

      candidatePeaks.push({
        frequency: fineFreq,
        magnitude: fineMag,
        db: fineDb,
      });
    }
  }

  // Sort candidate peaks by magnitude descending
  candidatePeaks.sort((a, b) => b.magnitude - a.magnitude);

  // Filter out peaks that are too close to higher peaks
  const filteredPeaks: SpectrumPeak[] = [];
  for (const peak of candidatePeaks) {
    let tooClose = false;
    for (const accepted of filteredPeaks) {
      if (Math.abs(accepted.frequency - peak.frequency) < minDistanceHz) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) {
      filteredPeaks.push(peak);
      if (filteredPeaks.length >= maxPeaks) break;
    }
  }

  // Re-sort selected peaks by frequency ascending for clear engineering display
  filteredPeaks.sort((a, b) => a.frequency - b.frequency);

  // Mark the highest peak as fundamental
  if (filteredPeaks.length > 0) {
    let maxIdx = 0;
    let maxMag = -Infinity;
    for (let i = 0; i < filteredPeaks.length; i++) {
      if (filteredPeaks[i].magnitude > maxMag) {
        maxMag = filteredPeaks[i].magnitude;
        maxIdx = i;
      }
    }
    filteredPeaks[maxIdx].isFundamental = true;
  }

  return filteredPeaks;
}

/**
 * Computes single-sided amplitude spectrum from time-domain signal.
 *
 * @param t Time array (Float64Array in seconds)
 * @param v Voltage/signal values (Float32Array)
 * @param sampleRate Sampling rate (in Hz)
 * @param options FFT options
 * @param channelId Source channel identifier
 * @param channelName Source channel name
 */
export function computeFFT(
  t: Float64Array,
  v: Float32Array,
  sampleRate: number,
  options: FFTOptions,
  channelId: string,
  channelName: string
): SpectrumResult {
  const totalSamples = v.length;
  if (totalSamples < 4 || sampleRate <= 0) {
    throw new Error('Insufficient points or invalid sample rate for FFT.');
  }

  // Choose power of 2 length
  const baseN = floorPowerOfTwo(totalSamples);
  const paddingFactor = options.zeroPadding || 1;
  const fftN = baseN * paddingFactor;

  // Extract base slice
  let sliceMean = 0;
  if (options.removeDC) {
    let sum = 0;
    for (let i = 0; i < baseN; i++) {
      sum += v[i];
    }
    sliceMean = sum / baseN;
  }

  // Compute Window
  const { weights, coherentGain } = getWindow(options.window, baseN);

  const real = new Float64Array(fftN);
  const imag = new Float64Array(fftN);

  for (let i = 0; i < baseN; i++) {
    const val = v[i] - sliceMean;
    real[i] = val * weights[i];
  }
  // Zero padding fills remainder with 0.0 automatically

  // Run Cooley-Tukey Radix-2
  radix2FFT(real, imag);

  // Single-sided spectrum has (fftN / 2) + 1 bins
  const numBins = (fftN >> 1) + 1;
  const frequencies = new Float32Array(numBins);
  const magnitudes = new Float32Array(numBins);
  const dbValues = new Float32Array(numBins);

  const binResolution = sampleRate / fftN;
  const normFactor = baseN * coherentGain;

  for (let k = 0; k < numBins; k++) {
    frequencies[k] = k * binResolution;

    const r = real[k];
    const im = imag[k];
    const rawMag = Math.sqrt(r * r + im * im);

    // Single-sided scaling:
    // DC (k=0) and Nyquist (k=numBins-1 when fftN is even) are unmultiplied by 2
    // All AC bins are multiplied by 2
    let mag: number;
    if (k === 0 || k === numBins - 1) {
      mag = rawMag / normFactor;
    } else {
      mag = (2.0 * rawMag) / normFactor;
    }

    magnitudes[k] = mag;
    const safeMag = Math.max(mag, 1e-12);
    dbValues[k] = 20 * Math.log10(safeMag); // relative to 1.0 V reference
  }

  // Peak detection
  const peaks = detectPeaks(frequencies, magnitudes, dbValues, {
    thresholdDb: options.peakThresholdDb ?? -60,
    minDistanceHz: options.minPeakDistanceHz,
    maxPeaks: options.maxPeaks ?? 8,
  });

  // Calculate dynamic range bounds
  let yMin = -120;
  let yMax = 20;
  if (options.scale === 'magnitude') {
    let maxMag = 0;
    for (let k = 0; k < numBins; k++) {
      if (magnitudes[k] > maxMag) maxMag = magnitudes[k];
    }
    yMin = 0;
    yMax = Math.max(0.1, maxMag * 1.15);
  } else {
    let maxDb = -Infinity;
    for (let k = 0; k < numBins; k++) {
      if (dbValues[k] > maxDb) maxDb = dbValues[k];
    }
    if (isFinite(maxDb)) {
      yMax = Math.ceil(maxDb / 10) * 10 + 10;
      yMin = yMax - 120;
    }
  }

  return {
    frequencies,
    magnitudes,
    dbValues,
    sourceChannelId: channelId,
    sourceChannelName: channelName,
    sampleRate,
    fftSize: fftN,
    resolution: binResolution,
    coherentGain,
    window: options.window,
    peaks,
    startTime: t[0],
    endTime: t[baseN - 1],
    sampleCount: baseN,
    yMin,
    yMax,
  };
}

/**
 * Computes BLDC motor electrical frequency and harmonic marker frequencies.
 * Strict Fail-Closed: If RPM or pole pairs is missing or invalid, returns null.
 */
export function computeBLDCHarmonics(
  motorConfig: MotorConfig
): {
  fe: number | null;
  markers: HarmonicMarker[];
  statusMessage: string;
} {
  if (!motorConfig.enabled) {
    return {
      fe: null,
      markers: [],
      statusMessage: 'Motor harmonic analysis disabled.',
    };
  }

  if (
    motorConfig.rpm === null ||
    isNaN(motorConfig.rpm) ||
    motorConfig.rpm <= 0
  ) {
    return {
      fe: null,
      markers: [],
      statusMessage: 'RPM is required. Provide valid motor RPM in Motor Analysis.',
    };
  }

  if (
    motorConfig.polePairs === null ||
    isNaN(motorConfig.polePairs) ||
    motorConfig.polePairs <= 0
  ) {
    return {
      fe: null,
      markers: [],
      statusMessage: 'Pole pairs is required (e.g., 2, 4, 7, 8).',
    };
  }

  // fe = polePairs * RPM / 60
  const fe = (motorConfig.polePairs * motorConfig.rpm) / 60;

  const orders = [1, 2, 3, 6, 12];
  const markers: HarmonicMarker[] = orders.map((order) => ({
    order,
    label: `${order}x (${formatFreq(order * fe)})`,
    frequency: order * fe,
  }));

  return {
    fe,
    markers,
    statusMessage: `Electrical Frequency fe = ${formatFreq(fe)} (RPM=${motorConfig.rpm}, Poles=${motorConfig.polePairs * 2})`,
  };
}

function formatFreq(f: number): string {
  if (f >= 1e6) return `${(f / 1e6).toFixed(3)} MHz`;
  if (f >= 1e3) return `${(f / 1e3).toFixed(3)} kHz`;
  return `${f.toFixed(2)} Hz`;
}
