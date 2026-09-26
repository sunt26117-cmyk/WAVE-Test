/**
 * Waveform Viewer Pro - Binary WFM Parsers
 * Full native support for Tektronix and Rigol oscilloscope .wfm files.
 */

import { WaveformChannel } from '../types/models';

export class TekWfmParser {
  private buffer: ArrayBuffer;
  private view: DataView;
  private littleEndian: boolean;

  constructor(arrayBuffer: ArrayBuffer) {
    this.buffer = arrayBuffer;
    this.view = new DataView(this.buffer);
    const byteOrder = this.view.getUint16(0, false);
    this.littleEndian = byteOrder === 0x0f0f;
  }

  private getUint8(o: number): number {
    return this.view.getUint8(o);
  }
  private getInt16(o: number): number {
    return this.view.getInt16(o, this.littleEndian);
  }
  private getInt32(o: number): number {
    return this.view.getInt32(o, this.littleEndian);
  }
  private getUint32(o: number): number {
    return this.view.getUint32(o, this.littleEndian);
  }
  private getFloat64(o: number): number {
    return this.view.getFloat64(o, this.littleEndian);
  }

  private getString(o: number, l: number): string {
    let s = '';
    for (let i = 0; i < l; i++) {
      const c = this.getUint8(o + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  isValid(): boolean {
    return this.getString(2, 8).startsWith(':WFM#00');
  }

  getTimeScale(): number {
    return this.getFloat64(478);
  }

  getNumDataPoints(): number {
    return this.getUint32(494);
  }

  getVoltageUnits(): string {
    const u = this.getString(186, 20).trim();
    return u || 'V';
  }

  getUserVoltsPerDiv(): number {
    return this.getFloat64(266);
  }

  getUserVerticalOffset(): number {
    return this.getFloat64(294);
  }

  isChannelWritten(ch: number): boolean {
    return ch === 1;
  }

  getChannelData(ch: number): Float32Array | null {
    if (ch !== 1) return null;
    const n = this.getNumDataPoints();
    const vS = this.getFloat64(166);
    const vO = this.getFloat64(174);
    const dSO = this.getInt32(16);
    const bPP = parseInt(this.getString(15, 1));
    const fmt = this.getInt32(238);

    if (fmt !== 0 || bPP !== 2) {
      throw new Error('Unsupported Tektronix WFM data format (must be 16-bit integer).');
    }
    if (dSO + n * bPP > this.buffer.byteLength) return null;

    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      d[i] = this.getInt16(dSO + i * bPP) * vS + vO;
    }
    return d;
  }
}

export class RigolWfmParser {
  private buffer: ArrayBuffer;
  private view: DataView;
  private littleEndian: boolean = true;
  private vScaOff = [0, 36, 60, 84, 108];
  private vOffOff = [0, 40, 64, 88, 112];
  private cWrtOff = [0, 49, 73, 97, 121];

  constructor(arrayBuffer: ArrayBuffer) {
    this.buffer = arrayBuffer;
    this.view = new DataView(this.buffer);
  }

  private getUint8(o: number): number {
    return this.view.getUint8(o);
  }
  private getInt16(o: number): number {
    return this.view.getInt16(o, this.littleEndian);
  }
  private getUint32(o: number): number {
    return this.view.getUint32(o, this.littleEndian);
  }
  private getFloat32(o: number): number {
    return this.view.getFloat32(o, this.littleEndian);
  }

  isValid(): boolean {
    return this.view.getUint16(0, true) === 0xa5a5;
  }

  getNumDataPoints(): number {
    return this.getUint32(28);
  }

  isChannelWritten(c: number): boolean {
    return (
      c > 0 &&
      c <= 4 &&
      this.cWrtOff[c] < this.view.byteLength &&
      this.getUint8(this.cWrtOff[c]) !== 0
    );
  }

  getTimeScale(): number {
    const fs = this.getSamplingFrequency();
    return fs > 0 ? 1 / fs : 1e-6;
  }

  getSamplingFrequency(): number {
    return this.getFloat32(100);
  }

  getVoltageUnits(): string {
    return 'V';
  }

  getVoltageScale(c: number): number {
    return c > 0 && c <= 4 ? this.getUint32(this.vScaOff[c]) * 1e-6 : 0;
  }

  getVoltageOffset(c: number): number {
    if (!this.isChannelWritten(c)) return 0;
    const rawPos = this.getInt16(this.vOffOff[c]);
    return -(rawPos / 25.0) * this.getVoltageScale(c) * 4;
  }

  getChannelData(c: number, vpd_override?: number): Float32Array | null {
    if (!this.isChannelWritten(c)) return null;
    const n = this.getNumDataPoints();
    const vPD = vpd_override || this.getVoltageScale(c);
    const iOff = -(this.getInt16(this.vOffOff[c]) / 25.0) * vPD * 4;
    const dSO = 272;

    let cDO = 0;
    for (let i = 1; i < c; i++) {
      if (this.isChannelWritten(i)) cDO += n;
    }

    const tO = dSO + cDO;
    if (tO + n > this.buffer.byteLength) return null;

    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      d[i] = ((125 - this.getUint8(tO + i)) / 25.0) * vPD + iOff;
    }
    return d;
  }
}

/**
 * Parses binary WFM buffer into unified WaveformChannels.
 */
export function parseWfmBuffer(
  buffer: ArrayBuffer,
  fileName: string,
  colors: string[]
): { channels: Record<string, WaveformChannel>; drawOrder: string[] } {
  const tek = new TekWfmParser(buffer);
  const channels: Record<string, WaveformChannel> = {};
  const drawOrder: string[] = [];

  if (tek.isValid()) {
    const dt = tek.getTimeScale();
    const n = tek.getNumDataPoints();
    const v = tek.getChannelData(1);
    if (!v) throw new Error('Could not extract Tektronix Channel 1 data.');

    const t = new Float64Array(n);
    for (let i = 0; i < n; i++) t[i] = i * dt;

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      if (v[i] < min) min = v[i];
      if (v[i] > max) max = v[i];
    }
    const margin = (max - min) * 0.1 || 1.0;

    const chId = 'channel1';
    channels[chId] = {
      id: chId,
      name: 'Channel 1',
      unit: tek.getVoltageUnits(),
      color: colors[0] || '#ffff00',
      visible: true,
      t,
      v,
      fs: dt > 0 ? 1 / dt : 1e6,
      dt,
      isMath: false,
      sourceChannelIds: [],
      metadata: {
        originalSampleCount: n,
        originalTimeStart: 0,
        originalTimeEnd: (n - 1) * dt,
        isUniformSampling: true,
        nominalDt: dt,
        medianDt: dt,
        meanDt: dt,
        minDt: dt,
        maxDt: dt,
        jitterRms: 0,
        jitterMax: 0,
        droppedSamples: 0,
        invalidSamples: 0,
        sampleRate: dt > 0 ? 1 / dt : 1e6,
        qualityStatus: 'uniform',
        gapCount: 0,
        gapIndices: [],
      },
      vMin: min - margin,
      vMax: max + margin,
    };
    drawOrder.push(chId);
    return { channels, drawOrder };
  }

  const rigol = new RigolWfmParser(buffer);
  if (rigol.isValid()) {
    const dt = rigol.getTimeScale();
    const n = rigol.getNumDataPoints();
    const t = new Float64Array(n);
    for (let i = 0; i < n; i++) t[i] = i * dt;

    let colorIdx = 0;
    for (let c = 1; c <= 4; c++) {
      if (rigol.isChannelWritten(c)) {
        const v = rigol.getChannelData(c);
        if (v) {
          let min = Infinity;
          let max = -Infinity;
          for (let i = 0; i < n; i++) {
            if (v[i] < min) min = v[i];
            if (v[i] > max) max = v[i];
          }
          const margin = (max - min) * 0.1 || 1.0;
          const chId = `ch${c}`;
          channels[chId] = {
            id: chId,
            name: `CH${c}`,
            unit: 'V',
            color: colors[colorIdx % colors.length] || '#00e5ff',
            visible: true,
            t,
            v,
            fs: dt > 0 ? 1 / dt : 1e6,
            dt,
            isMath: false,
            sourceChannelIds: [],
            metadata: {
              originalSampleCount: n,
              originalTimeStart: 0,
              originalTimeEnd: (n - 1) * dt,
              isUniformSampling: true,
              nominalDt: dt,
              medianDt: dt,
              meanDt: dt,
              minDt: dt,
              maxDt: dt,
              jitterRms: 0,
              jitterMax: 0,
              droppedSamples: 0,
              invalidSamples: 0,
              sampleRate: dt > 0 ? 1 / dt : 1e6,
              qualityStatus: 'uniform',
              gapCount: 0,
              gapIndices: [],
            },
            vMin: min - margin,
            vMax: max + margin,
          };
          drawOrder.push(chId);
          colorIdx++;
        }
      }
    }
    return { channels, drawOrder };
  }

  throw new Error('Unrecognized binary WFM format. File must be Tektronix or Rigol .wfm.');
}
