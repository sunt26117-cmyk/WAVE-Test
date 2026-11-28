/**
 * Waveform Viewer Pro - LTspice (.raw & Exported .txt) Parser
 * Supports:
 * - LTspice IV / XVII / 24 Binary .raw (UTF-16LE or ASCII header + IEEE-754 float64 time & float32/float64 variables)
 * - LTspice ASCII .raw ("Values:" section)
 * - Complex AC .raw (extracts magnitude)
 * - Stepped (.step) multi-run .raw and .txt exports ("Step Information: ... (Run: k/N)")
 */

import { WaveformChannel } from '../types/models';
import { analyzeSamplingQuality } from '../modules/qualityCheck';
import { resampleUniform } from '../modules/resampler';

export interface LtspiceParseResult {
  channels: Record<string, WaveformChannel>;
  drawOrder: string[];
  plotName: string;
  title: string;
  stepCount: number;
}

function inferLtspiceUnit(varName: string, varType: string): string {
  const t = (varType || '').toLowerCase();
  const n = (varName || '').toLowerCase();
  if (t.includes('voltage') || n.startsWith('v(') || n.startsWith('v_')) return 'V';
  if (t.includes('current') || n.startsWith('i(') || n.startsWith('ix(') || n.startsWith('i_')) return 'A';
  if (t.includes('power') || n.startsWith('p(')) return 'W';
  if (t.includes('frequency') || n === 'frequency' || n === 'freq') return 'Hz';
  if (t.includes('time') || n === 'time') return 's';
  if (t.includes('temp')) return '°C';
  return 'V';
}

/**
 * Locates the byte offset where "Binary:" or "Values:" ends (newline after marker)
 * and decodes the header cleanly whether encoded as UTF-16LE (LTspice XVII/24) or UTF-8/ASCII.
 */
function extractRawHeaderAndBody(buf: ArrayBuffer): {
  headerText: string;
  mode: 'binary' | 'values';
  bodyByteOffset: number;
  isUtf16Le: boolean;
} {
  const bytes = new Uint8Array(buf);
  if (bytes.length < 16) {
    throw new Error('File is too small to be a valid LTspice .raw file.');
  }

  // Detect UTF-16LE: BOM FF FE, or ASCII "Title:" interleaved with 0x00 bytes
  const hasBom16 = bytes[0] === 0xff && bytes[1] === 0xfe;
  const looksInterleaved16 = bytes.length > 10 && bytes[1] === 0x00 && bytes[3] === 0x00 && bytes[5] === 0x00;
  const isUtf16Le = hasBom16 || looksInterleaved16;

  if (isUtf16Le) {
    const startByte = hasBom16 ? 2 : 0;
    const scanMax = Math.min(bytes.length, 256 * 1024);
    const dec = new TextDecoder('utf-16le');
    const chunk = dec.decode(bytes.subarray(startByte, scanMax));
    const binMatch = /(?:^|\r?\n)Binary:\r?\n/i.exec(chunk);
    const valMatch = /(?:^|\r?\n)Values:\r?\n/i.exec(chunk);
    const match = binMatch && (!valMatch || binMatch.index < valMatch.index) ? binMatch : valMatch;
    if (!match) {
      throw new Error('Invalid LTspice .raw header: missing Binary: or Values: marker.');
    }
    const mode: 'binary' | 'values' = match === binMatch ? 'binary' : 'values';
    const headerCharEnd = match.index + match[0].length;
    const headerText = chunk.slice(0, headerCharEnd);
    const bodyByteOffset = startByte + headerCharEnd * 2;
    return { headerText, mode, bodyByteOffset, isUtf16Le: true };
  }

  // UTF-8 / ASCII header
  const scanMax = Math.min(bytes.length, 256 * 1024);
  const dec = new TextDecoder('utf-8');
  const chunk = dec.decode(bytes.subarray(0, scanMax));
  const binMatch = /(?:^|\r?\n)Binary:\r?\n/i.exec(chunk);
  const valMatch = /(?:^|\r?\n)Values:\r?\n/i.exec(chunk);
  const match = binMatch && (!valMatch || binMatch.index < valMatch.index) ? binMatch : valMatch;
  if (!match) {
    throw new Error('Invalid LTspice .raw header: missing Binary: or Values: marker.');
  }
  const mode: 'binary' | 'values' = match === binMatch ? 'binary' : 'values';
  const headerCharEnd = match.index + match[0].length;
  const headerText = chunk.slice(0, headerCharEnd);
  const bodyByteOffset = new TextEncoder().encode(headerText).length;
  return { headerText, mode, bodyByteOffset, isUtf16Le: false };
}

interface RawVariableDef {
  index: number;
  name: string;
  type: string;
}

function parseRawHeader(headerText: string): {
  title: string;
  plotName: string;
  flags: string[];
  numVars: number;
  numPoints: number;
  variables: RawVariableDef[];
} {
  const lines = headerText.split(/\r?\n/);
  let title = 'LTspice Simulation';
  let plotName = 'Transient Analysis';
  let flags: string[] = [];
  let numVars = 0;
  let numPoints = 0;
  const variables: RawVariableDef[] = [];
  let inVars = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(Binary|Values):$/i.test(line)) {
      inVars = false;
      break;
    }
    if (inVars) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        const idx = parseInt(parts[0], 10);
        const name = parts[1];
        const type = parts.slice(2).join(' ') || 'voltage';
        if (!isNaN(idx)) {
          variables.push({ index: idx, name, type });
        }
      }
      continue;
    }

    if (line.startsWith('Title:')) title = line.slice(6).trim();
    else if (line.startsWith('Plotname:')) plotName = line.slice(9).trim();
    else if (line.startsWith('Flags:')) flags = line.slice(6).trim().toLowerCase().split(/\s+/);
    else if (line.startsWith('No. Variables:')) numVars = parseInt(line.slice(14).trim(), 10) || 0;
    else if (line.startsWith('No. Points:')) numPoints = parseInt(line.slice(11).trim(), 10) || 0;
    else if (line.startsWith('Variables:')) inVars = true;
  }

  if (numVars <= 0 || variables.length === 0) {
    throw new Error('LTspice .raw header contains no variables.');
  }
  return { title, plotName, flags, numVars, numPoints, variables };
}

function buildChannelsFromRuns(
  runs: Array<{ stepLabel?: string; t: number[]; vars: number[][] }>,
  varDefs: RawVariableDef[],
  colors: string[],
  maxChannelsPerFile: number = 24
): { channels: Record<string, WaveformChannel>; drawOrder: string[] } {
  const channels: Record<string, WaveformChannel> = {};
  const drawOrder: string[] = [];
  let createdCount = 0;
  const multiStep = runs.length > 1;

  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    if (run.t.length < 2) continue;

    const rawT = Float64Array.from(run.t);
    const baseQuality = analyzeSamplingQuality(rawT, 0);

    for (let vIdx = 1; vIdx < varDefs.length; vIdx++) {
      if (createdCount >= maxChannelsPerFile) break;
      const vDef = varDefs[vIdx];
      const rawV = Float32Array.from(run.vars[vIdx]);

      let finalT: Float64Array = rawT;
      let finalV: Float32Array = rawV;
      let fs = baseQuality.sampleRate;
      let dt = baseQuality.nominalDt;
      let chMeta = { ...baseQuality };

      // SPICE solvers use adaptive time steps; resample onto a uniform grid so FFT/Math/Trigger stay accurate
      if (!baseQuality.isUniformSampling || baseQuality.qualityStatus !== 'uniform') {
        const res = resampleUniform(rawT, rawV, { allowGapInterpolation: true });
        finalT = res.t;
        finalV = res.v;
        fs = res.fs;
        dt = res.dt;
        chMeta = {
          ...baseQuality,
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
        };
      }

      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < finalV.length; i++) {
        const val = finalV[i];
        if (isFinite(val)) {
          if (val < min) min = val;
          if (val > max) max = val;
        }
      }
      if (!isFinite(min)) min = -1;
      if (!isFinite(max)) max = 1;
      const margin = (max - min) * 0.1 || 1;

      const stepSuffix = multiStep ? ` [${run.stepLabel || `Run ${r + 1}`}]` : '';
      const chId = `lt_r${r}_v${vIdx}`;
      const color = colors[createdCount % colors.length] || '#22d3ee';

      channels[chId] = {
        id: chId,
        name: `${vDef.name}${stepSuffix}`,
        unit: inferLtspiceUnit(vDef.name, vDef.type),
        color,
        visible: r === 0 || createdCount < 8,
        t: finalT,
        v: finalV,
        fs,
        dt,
        isMath: false,
        channelKind: 'raw',
        ltspiceStepLabel: multiStep ? run.stepLabel || `Run ${r + 1}` : undefined,
        sourceChannelIds: [],
        metadata: chMeta,
        rawT,
        rawV,
        vMin: min - margin,
        vMax: max + margin,
      };
      drawOrder.push(chId);
      createdCount++;
    }
  }

  return { channels, drawOrder };
}

/**
 * Parses an LTspice Binary or ASCII `.raw` buffer into WaveformChannels.
 */
export function parseLtspiceRawBuffer(buf: ArrayBuffer, colors: string[]): LtspiceParseResult {
  const { headerText, mode, bodyByteOffset, isUtf16Le } = extractRawHeaderAndBody(buf);
  const header = parseRawHeader(headerText);
  const isComplex = header.flags.includes('complex');
  const isDouble = header.flags.includes('double');

  const runs: Array<{ stepLabel?: string; t: number[]; vars: number[][] }> = [];
  let currentRun: { stepLabel?: string; t: number[]; vars: number[][] } = {
    stepLabel: 'Run 1',
    t: [],
    vars: Array.from({ length: header.numVars }, () => []),
  };

  if (mode === 'binary') {
    const view = new DataView(buf);
    const var0Size = isComplex ? 16 : 8;
    const otherSize = isComplex ? 16 : isDouble ? 8 : 4;
    const pointBytes = var0Size + (header.numVars - 1) * otherSize;
    const availPoints = Math.floor((buf.byteLength - bodyByteOffset) / pointBytes);
    const totalPoints = header.numPoints > 0 ? Math.min(header.numPoints, availPoints) : availPoints;

    if (totalPoints < 2) {
      throw new Error('LTspice .raw contains fewer than 2 data points.');
    }

    let offset = bodyByteOffset;
    let prevT = -Infinity;

    for (let p = 0; p < totalPoints; p++) {
      // LTspice stores trapezoidal integration time with alternating sign; abs() recovers monotonic time
      const rawTVal = isComplex
        ? Math.hypot(view.getFloat64(offset, true), view.getFloat64(offset + 8, true))
        : Math.abs(view.getFloat64(offset, true));
      offset += var0Size;

      // Detect stepped simulation boundary when time resets backwards significantly
      if (currentRun.t.length > 2 && rawTVal < prevT * 0.5 && rawTVal <= currentRun.t[0] + Math.abs(prevT) * 0.05) {
        runs.push(currentRun);
        currentRun = {
          stepLabel: `Run ${runs.length + 1}`,
          t: [],
          vars: Array.from({ length: header.numVars }, () => []),
        };
      }
      prevT = rawTVal;
      currentRun.t.push(rawTVal);
      currentRun.vars[0].push(rawTVal);

      for (let v = 1; v < header.numVars; v++) {
        let val = 0;
        if (isComplex) {
          const re = view.getFloat64(offset, true);
          const im = view.getFloat64(offset + 8, true);
          val = Math.hypot(re, im);
        } else if (isDouble) {
          val = view.getFloat64(offset, true);
        } else {
          val = view.getFloat32(offset, true);
        }
        offset += otherSize;
        currentRun.vars[v].push(isFinite(val) ? val : NaN);
      }
    }
    if (currentRun.t.length > 0) runs.push(currentRun);
  } else {
    // ASCII Values: section
    const bodyBytes = new Uint8Array(buf, bodyByteOffset);
    const bodyText = new TextDecoder(isUtf16Le ? 'utf-16le' : 'utf-8').decode(bodyBytes);
    const tokens = bodyText.trim().split(/\s+/);
    let cursor = 0;
    let prevT = -Infinity;

    while (cursor < tokens.length) {
      // Format per point: "<pointIdx> <tVal> <v1> <v2> ..."
      cursor++; // skip point index token
      if (cursor >= tokens.length) break;

      const tTok = tokens[cursor++];
      const rawTVal = isComplex
        ? Math.hypot(parseFloat(tTok.split(',')[0]), parseFloat(tTok.split(',')[1] || '0'))
        : Math.abs(parseFloat(tTok));

      if (!isFinite(rawTVal)) break;

      if (currentRun.t.length > 2 && rawTVal < prevT * 0.5 && rawTVal <= currentRun.t[0] + Math.abs(prevT) * 0.05) {
        runs.push(currentRun);
        currentRun = {
          stepLabel: `Run ${runs.length + 1}`,
          t: [],
          vars: Array.from({ length: header.numVars }, () => []),
        };
      }
      prevT = rawTVal;
      currentRun.t.push(rawTVal);
      currentRun.vars[0].push(rawTVal);

      for (let v = 1; v < header.numVars; v++) {
        const tok = tokens[cursor++] || '0';
        let val = 0;
        if (isComplex && tok.includes(',')) {
          const [re, im] = tok.split(',').map(Number);
          val = Math.hypot(re, im);
        } else {
          val = parseFloat(tok);
        }
        currentRun.vars[v].push(isFinite(val) ? val : NaN);
      }
    }
    if (currentRun.t.length > 0) runs.push(currentRun);
  }

  const { channels, drawOrder } = buildChannelsFromRuns(runs, header.variables, colors);
  if (drawOrder.length === 0) {
    throw new Error('No plottable signal variables found in LTspice .raw file.');
  }

  return {
    channels,
    drawOrder,
    plotName: header.plotName,
    title: header.title,
    stepCount: runs.length,
  };
}

/**
 * Checks whether a text file is an LTspice "Export data as text" file (especially stepped runs).
 */
export function isLtspiceExportText(text: string): boolean {
  const head = text.slice(0, 4096);
  const hasStepInfo = /Step Information:/i.test(text);
  const firstLine = head.split(/\r?\n/).find((l) => l.trim().length > 0) || '';
  const looksLikeLtspiceHeader =
    /^time\t/i.test(firstLine) && /\b[VI]\([^)]+\)/i.test(firstLine);
  return hasStepInfo || looksLikeLtspiceHeader;
}

/**
 * Checks whether a text file is a multi-run stepped LTspice export ("Step Information:").
 * Single-run 2-column tab/space text exports are routed to the interactive import wizard.
 */
export function isLtspiceSteppedExportText(text: string): boolean {
  return /Step Information:/i.test(text);
}

/**
 * Parses LTspice exported `.txt` (including multi-run "Step Information: ... (Run: 1/3)" blocks).
 */
export function parseLtspiceText(text: string, colors: string[]): LtspiceParseResult {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = clean.split(/\r?\n/);

  let headerCols: string[] = [];
  let startLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    headerCols = trimmed.split(/\t+/).map((s) => s.trim());
    startLine = i + 1;
    break;
  }

  if (headerCols.length < 2) {
    throw new Error('Invalid LTspice text export header.');
  }

  const varDefs: RawVariableDef[] = headerCols.map((name, idx) => ({
    index: idx,
    name,
    type: idx === 0 ? 'time' : name.toLowerCase().startsWith('i(') ? 'current' : 'voltage',
  }));

  const runs: Array<{ stepLabel?: string; t: number[]; vars: number[][] }> = [];
  let currentRun: { stepLabel?: string; t: number[]; vars: number[][] } = {
    stepLabel: 'Run 1',
    t: [],
    vars: Array.from({ length: headerCols.length }, () => []),
  };

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('Step Information:')) {
      if (currentRun.t.length > 0) {
        runs.push(currentRun);
      }
      const stepDesc = line.replace('Step Information:', '').replace(/\(Run:\s*\d+\/\d+\)/i, '').trim();
      currentRun = {
        stepLabel: stepDesc || `Run ${runs.length + 1}`,
        t: [],
        vars: Array.from({ length: headerCols.length }, () => []),
      };
      continue;
    }

    const cells = line.split(/\t+/);
    if (cells.length < 2) continue;
    const tVal = parseFloat(cells[0]);
    if (!isFinite(tVal)) continue;

    currentRun.t.push(tVal);
    currentRun.vars[0].push(tVal);
    for (let c = 1; c < headerCols.length; c++) {
      const cell = (cells[c] || '').trim();
      let vVal = NaN;
      if (cell.startsWith('(') && cell.includes(',')) {
        // AC export format "( -3.2dB, -45° )" -> parse leading dB or magnitude
        const num = parseFloat(cell.slice(1));
        vVal = isFinite(num) ? num : NaN;
      } else {
        vVal = parseFloat(cell);
      }
      currentRun.vars[c].push(isFinite(vVal) ? vVal : NaN);
    }
  }

  if (currentRun.t.length > 0) {
    runs.push(currentRun);
  }

  const { channels, drawOrder } = buildChannelsFromRuns(runs, varDefs, colors);
  if (drawOrder.length === 0) {
    throw new Error('No waveform samples found in LTspice text export.');
  }

  return {
    channels,
    drawOrder,
    plotName: 'LTspice Text Export',
    title: 'LTspice Export',
    stepCount: runs.length,
  };
}
