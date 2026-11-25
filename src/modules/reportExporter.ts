/**
 * Waveform Viewer Pro - Self-Contained Engineering Test Report Exporter (HTML + Print-to-PDF)
 */

import {
  AnomalyEvent,
  ChannelMeasurements,
  SpectrumResult,
  TabState,
} from '../types/models';
import { formatEng, formatMeasurementMetricValue, RenderTheme, DEFAULT_THEME } from '../engine/canvasRenderer';
import { renderCompositeScopeDataUrl } from './exporter';
import { computeMeasurements, MEASUREMENT_DEFINITIONS } from './measurements';
import { getTimebaseInfo } from './oscilloscopeScale';
import { GoldenEvaluationResult } from './anomalyScanner';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildEngineeringReportHTML(
  tab: TabState,
  canvasWidth: number,
  canvasHeight: number,
  cachedSpectrum?: SpectrumResult | null,
  goldenEval?: GoldenEvaluationResult | null,
  anomalies?: AnomalyEvent[],
  theme: RenderTheme = DEFAULT_THEME
): string {
  const { dataUrl } = renderCompositeScopeDataUrl(
    tab,
    Math.max(1040, canvasWidth),
    Math.max(520, canvasHeight),
    cachedSpectrum,
    theme
  );

  const tb = getTimebaseInfo(tab);
  const primaryCh = tab.channels[tab.drawOrder[0]];
  const meta = primaryCh?.metadata;
  const generatedAt = new Date().toLocaleString();

  // Compute full table of core metrics for all visible channels
  const visibleChs = tab.drawOrder.map((id) => tab.channels[id]).filter((c) => c && c.visible);
  const measCache: Record<string, ChannelMeasurements> = {};
  for (const ch of visibleChs) {
    measCache[ch.id] = computeMeasurements(ch, tab.measurementGate, tab.view, tab.cursors);
  }

  const keyMap: Record<string, (typeof MEASUREMENT_DEFINITIONS)[number] | undefined> = {};
  for (const d of MEASUREMENT_DEFINITIONS) {
    keyMap[d.key] = d;
  }

  const channelSummaryRows = visibleChs
    .map((ch) => {
      const m = measCache[ch.id];
      const fmt = (k: keyof ChannelMeasurements, defKey: string) => {
        const def = keyMap[defKey];
        if (!def) return '--';
        return formatMeasurementMetricValue(m, def, ch.unit);
      };
      const isComputed = ch.channelKind === 'computed' || !!ch.isMath;
      const swatchHtml = isComputed
        ? `<span style="display:inline-block;width:14px;height:0;border-top:2px dashed ${esc(ch.color)};margin-right:6px;vertical-align:middle;"></span>`
        : `<span style="display:inline-block;width:10px;height:10px;background:${esc(ch.color)};margin-right:6px;vertical-align:middle;"></span>`;
      const badgeHtml = isComputed
        ? ` <span style="font-size:9px;padding:1px 4px;border:1px solid #cbd5e1;border-radius:2px;color:#475569;">${esc(ch.derivedBadge || 'fx')}</span>`
        : '';
      return `
        <tr>
          <td>${swatchHtml}<strong>${esc(ch.name)}</strong>${badgeHtml}</td>
          <td>${esc(ch.unit)}</td>
          <td>${fmt('vpp', 'vpp')}</td>
          <td>${fmt('max', 'max')}</td>
          <td>${fmt('min', 'min')}</td>
          <td>${fmt('rms', 'rms')}</td>
          <td>${fmt('average', 'average')}</td>
          <td>${fmt('frequency', 'frequency')}</td>
          <td>${fmt('dutyCycle', 'dutyCycle')}</td>
          <td>${fmt('riseTime', 'riseTime')}</td>
          <td>${fmt('overshoot', 'overshoot')}</td>
        </tr>
      `;
    })
    .join('');

  const goldenSection = goldenEval
    ? `
      <section class="card">
        <h2>Golden Reference Tolerance Verification</h2>
        <div class="summary-grid">
          <div><span>Status</span><strong class="${goldenEval.status === 'PASS' ? 'pass' : goldenEval.status === 'FAIL' ? 'fail' : 'warn'}">${esc(goldenEval.status)}</strong></div>
          <div><span>Channel</span><strong>${esc(tab.channels[tab.goldenBand?.channelId || '']?.name || '--')}</strong></div>
          <div><span>Coverage</span><strong>${goldenEval.coveragePct.toFixed(1)}% (${goldenEval.totalCompared.toLocaleString()} / ${goldenEval.totalTargetSamples.toLocaleString()})</strong></div>
          <div><span>Tolerance Band</span><strong>±${formatEng(goldenEval.bandHalfWidth, tab.channels[tab.goldenBand?.channelId || '']?.unit || 'V', 3)}</strong></div>
          <div><span>Violations</span><strong>${goldenEval.violationCount.toLocaleString()} / ${goldenEval.totalCompared.toLocaleString()} pts</strong></div>
          <div><span>Max Deviation</span><strong>${formatEng(goldenEval.maxDeviation, tab.channels[tab.goldenBand?.channelId || '']?.unit || 'V', 3)}</strong></div>
        </div>
        ${goldenEval.invalidReason ? `<div style="margin-top:8px;font-size:11px;color:#b45309;">Note: ${esc(goldenEval.invalidReason)}</div>` : ''}
      </section>
    `
    : '';

  const anomalyRows = (anomalies || [])
    .slice(0, 40)
    .map(
      (a, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td>${esc(a.kind.toUpperCase())}</td>
        <td>${formatEng(a.time, 's', 4)}</td>
        <td>${a.value.toPrecision(5)}</td>
        <td>${esc(a.detail)}</td>
      </tr>
    `
    )
    .join('');

  const anomalySection =
    anomalies && anomalies.length > 0
      ? `
      <section class="card">
        <h2>Detected Anomalies (Showing ${Math.min(40, anomalies.length)} of ${anomalies.length})</h2>
        <table>
          <thead><tr><th>#</th><th>Type</th><th>Timestamp</th><th>Value</th><th>Detail</th></tr></thead>
          <tbody>${anomalyRows}</tbody>
        </table>
      </section>
    `
      : '';

  return `\x3C!doctype html>
\x3Chtml lang="en">
\x3Chead>
\x3Cmeta charset="utf-8" />
\x3Ctitle>Waveform Test Report - ${esc(tab.fileName)}\x3C/title>
\x3Cstyle>
  body { font-family: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #0f172a; background: #f8fafc; margin: 0; padding: 24px; }
  .container { max-width: 1120px; margin: 0 auto; background: #ffffff; border: 1px solid #cbd5e1; padding: 28px; }
  header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 20px; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: #334155; margin: 0 0 10px 0; }
  .meta { font-size: 12px; color: #475569; font-family: "JetBrains Mono", monospace; text-align: right; }
  .card { margin-bottom: 20px; border: 1px solid #e2e8f0; padding: 14px; background: #ffffff; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; font-size: 12px; }
  .summary-grid div { background: #f8fafc; border: 1px solid #e2e8f0; padding: 8px 10px; }
  .summary-grid span { display: block; font-size: 10px; text-transform: uppercase; color: #64748b; margin-bottom: 2px; }
  .summary-grid strong { font-family: "JetBrains Mono", monospace; font-size: 13px; }
  .pass { color: #059669; }
  .fail { color: #dc2626; }
  .warn { color: #d97706; }
  .shot { width: 100%; border: 1px solid #0f172a; display: block; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; font-family: "JetBrains Mono", monospace; }
  th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; }
  th { background: #f1f5f9; font-family: "IBM Plex Sans", sans-serif; font-weight: 600; color: #1e293b; }
  @media print { body { background: #ffffff; padding: 0; } .container { border: none; padding: 0; } }
\x3C/style>
\x3C/head>
\x3Cbody>
  <div class="container">
    <header>
      <div>
        <h1>Oscilloscope Engineering Test Report</h1>
        <div style="font-size:12px;color:#475569;margin-top:4px;">Capture: <strong>${esc(tab.fileName)}</strong></div>
      </div>
      <div class="meta">
        <div>Generated: ${esc(generatedAt)}</div>
        <div>Gate: ${esc(tab.measurementGate.toUpperCase())}</div>
      </div>
    </header>

    <section class="card">
      <h2>Acquisition &amp; Timing Audit</h2>
      <div class="summary-grid">
        <div><span>Sample Rate</span><strong>${tb.sampleRate ? formatEng(tb.sampleRate, 'Sa/s', 3) : 'Non-uniform'}</strong></div>
        <div><span>Total Samples</span><strong>${tb.totalPoints.toLocaleString()} pts</strong></div>
        <div><span>Timebase</span><strong>${formatEng(tb.secPerDiv, 's', 2)}/div</strong></div>
        <div><span>Timing Quality</span><strong>${esc(meta?.qualityStatus || 'N/A')}</strong></div>
        <div><span>Jitter RMS</span><strong>${meta?.jitterRms !== null && meta?.jitterRms !== undefined ? meta.jitterRms.toFixed(2) + '%' : 'N/A'}</strong></div>
      </div>
    </section>

    <section class="card">
      <h2>Oscilloscope Screen Capture</h2>
      <img class="shot" src="${dataUrl}" alt="Oscilloscope Capture" />
    </section>

    ${goldenSection}

    <section class="card">
      <h2>Channel Automated Measurements (${esc(tab.measurementGate.toUpperCase())})</h2>
      <table>
        <thead>
          <tr>
            <th>Channel</th><th>Unit</th><th>Vpp</th><th>Vmax</th><th>Vmin</th>
            <th>Vrms</th><th>Vmean</th><th>Freq</th><th>Duty</th><th>Rise(10-90)</th><th>Overshoot</th>
          </tr>
        </thead>
        <tbody>${channelSummaryRows}</tbody>
      </table>
    </section>

    ${anomalySection}
  </div>
\x3C/body>
\x3C/html>`;
}

export function downloadEngineeringReportHTML(html: string, sourceFileName: string): string {
  const stem = sourceFileName.replace(/\.[^.]+$/, '');
  const filename = `${stem}_TestReport_${Date.now()}.html`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const link = document.createElement('a');
  link.download = filename;
  link.href = URL.createObjectURL(blob);
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  return filename;
}
