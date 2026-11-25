import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Download, Lock, Play, SlidersHorizontal, Upload } from 'lucide-react';
import {
  CalibrationReport,
  DynoColumnMapping,
  EfficiencyFormat,
  KeSourceMode,
  RsFitMode,
  TabularDataset,
  TorqueUnit,
  autoMapColumns,
  detectHeaderEtaFormat,
  detectHeaderTorqueUnit,
  normalizeDynoDataset,
  parseSpreadsheetFile,
} from '../../modules/focDyno/dynoCalibrator';
import { MotorParams } from '../../modules/focDyno/motorPhysics';
import { DynoFitComparisonChart, EfficiencyHeatmap2D } from './Charts';
import { SmoothNumberInput } from './SmoothNumberInput';

interface Tab1Props {
  params: MotorParams;
  openLoopRaw: TabularDataset;
  closedLoopRaw: TabularDataset;
  openLoopMap: DynoColumnMapping;
  closedLoopMap: DynoColumnMapping;
  torqueUnit: TorqueUnit;
  etaFormat: EfficiencyFormat;
  keSource: KeSourceMode;
  manualN0Rpm: number;
  manualVTestV: number;
  manualKv: number;
  rsFitMode: RsFitMode;
  openLoopModDepth: number;
  report: CalibrationReport;
  warnings: string[];
  onUpdateOpenLoop: (ds: TabularDataset, map: DynoColumnMapping) => void;
  onUpdateClosedLoop: (
    ds: TabularDataset,
    map: DynoColumnMapping,
    detectedUnit: TorqueUnit | null,
    detectedEta: EfficiencyFormat | null
  ) => void;
  onChangeOpenMap: (map: DynoColumnMapping) => void;
  onChangeClosedMap: (map: DynoColumnMapping) => void;
  onChangeTorqueUnit: (u: TorqueUnit) => void;
  onChangeEtaFormat: (f: EfficiencyFormat) => void;
  onChangeKeSource: (k: KeSourceMode) => void;
  onChangeManualKe: (n0: number, vTest: number, kv: number) => void;
  onChangeRsFitMode: (m: RsFitMode) => void;
  onChangeOpenLoopModDepth: (m: number) => void;
  onRunCalibration: () => void;
  onNotify: (msg: string) => void;
}

const REQUIRED_FIELDS: Array<{ key: keyof DynoColumnMapping; label: string }> = [
  { key: 'n_rpm', label: '转速 n (RPM)' },
  { key: 'V_bus', label: '母线电压 V_bus (V)' },
  { key: 'I_bus', label: '母线电流 I_bus (A)' },
  { key: 'T_Nm', label: '扭矩 T' },
  { key: 'P_in', label: '输入功率 Pin (可选)' },
  { key: 'P_out', label: '机械功率 Pout (可选)' },
  { key: 'eta', label: '系统效率 η (可选)' },
];

export const Tab1DynoCalib: React.FC<Tab1Props> = ({
  openLoopRaw,
  closedLoopRaw,
  openLoopMap,
  closedLoopMap,
  torqueUnit,
  etaFormat,
  keSource,
  manualN0Rpm,
  manualVTestV,
  manualKv,
  rsFitMode,
  openLoopModDepth,
  report,
  warnings,
  onUpdateOpenLoop,
  onUpdateClosedLoop,
  onChangeOpenMap,
  onChangeClosedMap,
  onChangeTorqueUnit,
  onChangeEtaFormat,
  onChangeKeSource,
  onChangeManualKe,
  onChangeRsFitMode,
  onChangeOpenLoopModDepth,
  onRunCalibration,
  onNotify,
}) => {
  const [showMappingDrawer, setShowMappingDrawer] = useState(false);

  const openNormCount = useMemo(
    () => normalizeDynoDataset(openLoopRaw, openLoopMap, 'Nm', '0-1', { requireTorque: false }).points.length,
    [openLoopRaw, openLoopMap]
  );

  const closedNormCount = useMemo(
    () => normalizeDynoDataset(closedLoopRaw, closedLoopMap, torqueUnit, etaFormat, { requireTorque: true }).points.length,
    [closedLoopRaw, closedLoopMap, torqueUnit, etaFormat]
  );

  const handleFileUpload = async (file: File | undefined, kind: 'open' | 'closed') => {
    if (!file) return;
    try {
      const ds = await parseSpreadsheetFile(file);
      const map = autoMapColumns(ds.headers);
      if (kind === 'open') {
        onUpdateOpenLoop(ds, map);
      } else {
        const detUnit = map.T_Nm ? detectHeaderTorqueUnit(map.T_Nm) : null;
        const detEta = map.eta ? detectHeaderEtaFormat(map.eta, ds.rows) : null;
        onUpdateClosedLoop(ds, map, detUnit, detEta);
      }
    } catch (err) {
      onNotify(`读取表格失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const downloadCsvFromDataset = (ds: TabularDataset) => {
    if (ds.headers.length === 0) return;
    const lines = [ds.headers.join(',')];
    for (const r of ds.rows) {
      lines.push(
        ds.headers
          .map((h) => {
            const v = String(r[h] ?? '');
            return v.includes(',') ? `"${v.replace(/"/g, '""')}"` : v;
          })
          .join(',')
      );
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = ds.fileName.replace(/\.[^.]+$/, '') + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 500);
  };

  const { metrics } = report;

  return (
    <div className="space-y-4">
      {/* Compact Data Source & Calibration Control Strip */}
      <div className="dyno-card rounded-sm border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
            <div>
              <span className="dyno-text-muted">开环: </span>
              <span className="font-mono font-medium dyno-text-primary">{openLoopRaw.fileName}</span>
              <span className="ml-1 font-mono tabular-nums dyno-accent-text">({openNormCount}点)</span>
            </div>
            <span className="dyno-text-muted">·</span>
            <div>
              <span className="dyno-text-muted">闭环: </span>
              <span className="font-mono font-medium dyno-text-primary">{closedLoopRaw.fileName}</span>
              <span className="ml-1 font-mono tabular-nums dyno-accent-text">({closedNormCount}点)</span>
            </div>
            <span
              className={`rounded-xs border px-2 py-0.5 font-mono text-[11px] font-semibold ${
                report.status === 'failed'
                  ? 'dyno-alert-danger'
                  : report.status === 'warn'
                  ? 'dyno-alert-warn'
                  : 'dyno-alert-ok border-emerald-500/40'
              }`}
            >
              {report.status === 'failed'
                ? '✖ 标定失败'
                : report.status === 'warn'
                ? '▲ 标定存疑'
                : '✓ 标定收敛'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="dyno-btn-ghost inline-flex cursor-pointer items-center gap-1.5 rounded-sm border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors">
              <Upload className="h-3.5 w-3.5 dyno-accent-text" />
              导入开环表
              <input
                type="file"
                accept=".csv,.xlsx,.xls,.xlsm,.txt"
                className="hidden"
                onChange={(e) => {
                  void handleFileUpload(e.target.files?.[0], 'open');
                  e.target.value = '';
                }}
              />
            </label>

            <label className="dyno-btn-ghost inline-flex cursor-pointer items-center gap-1.5 rounded-sm border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors">
              <Upload className="h-3.5 w-3.5 dyno-accent-text" />
              导入闭环表
              <input
                type="file"
                accept=".csv,.xlsx,.xls,.xlsm,.txt"
                className="hidden"
                onChange={(e) => {
                  void handleFileUpload(e.target.files?.[0], 'closed');
                  e.target.value = '';
                }}
              />
            </label>

            <button
              type="button"
              onClick={() => setShowMappingDrawer((v) => !v)}
              aria-expanded={showMappingDrawer}
              className="dyno-btn-ghost inline-flex items-center gap-1.5 rounded-sm border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer"
            >
              {showMappingDrawer ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              列映射与 Ke&apos; 配置
            </button>

            <button
              type="button"
              onClick={onRunCalibration}
              className="dyno-btn-primary inline-flex items-center gap-1.5 rounded-sm px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer"
            >
              <Play className="h-3.5 w-3.5" />
              重新分步标定
            </button>
          </div>
        </div>

        {/* Always-accessible compact unit & anti-overfit strip */}
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t dyno-border pt-3 text-xs">
          <label className="flex items-center gap-2">
            <span className="dyno-text-muted">扭矩单位</span>
            <select
              value={torqueUnit}
              onChange={(e) => onChangeTorqueUnit(e.target.value as TorqueUnit)}
              className="dyno-input rounded-sm border px-2.5 py-1 font-mono text-xs focus:outline-none"
            >
              <option value="Nm">N·m (标准)</option>
              <option value="mNm">mN·m (×1e-3)</option>
              <option value="kgf_cm">kgf·cm (×0.09807)</option>
            </select>
          </label>

          <label className="flex items-center gap-2">
            <span className="dyno-text-muted">效率格式</span>
            <select
              value={etaFormat}
              onChange={(e) => onChangeEtaFormat(e.target.value as EfficiencyFormat)}
              className="dyno-input rounded-sm border px-2.5 py-1 font-mono text-xs focus:outline-none"
            >
              <option value="0-1">小数 (0–1)</option>
              <option value="percent">百分比 (0–100%)</option>
            </select>
          </label>

          <label className="flex items-center gap-2">
            <span className="dyno-text-muted">防过拟合 Rs_eff</span>
            <select
              value={rsFitMode}
              onChange={(e) => onChangeRsFitMode(e.target.value as RsFitMode)}
              className="dyno-input rounded-sm border px-2.5 py-1 text-xs focus:outline-none"
            >
              <option value="locked">严格锁定 R_LL/2 温修基准</option>
              <option value="bounded_15pct">在基准 ±15% 内微调</option>
            </select>
          </label>

          <button
            type="button"
            onClick={() => downloadCsvFromDataset(closedLoopRaw)}
            className="ml-auto inline-flex items-center gap-1 text-xs dyno-text-muted hover:dyno-accent-text transition-colors cursor-pointer whitespace-nowrap"
            title="导出当前闭环测功表以便换算校验"
          >
            <Download className="h-3.5 w-3.5" />
            导出当前闭环表
          </button>
        </div>

        {/* Collapsible Column Mapping & Ke' Source Drawer */}
        {showMappingDrawer && (
          <div className="mt-4 grid grid-cols-1 gap-5 border-t dyno-border pt-4 xl:grid-cols-2">
            <div className="space-y-3">
              <div className="text-xs font-semibold dyno-text-secondary">1A. 开环空载列映射与 Ke&apos; 提取策略</div>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                {REQUIRED_FIELDS.slice(0, 4).map((f) => (
                  <label key={f.key} className="block text-[11px]">
                    <span className="mb-1 block dyno-text-muted">{f.label}</span>
                    <select
                      value={openLoopMap[f.key]}
                      onChange={(e) => onChangeOpenMap({ ...openLoopMap, [f.key]: e.target.value })}
                      className="dyno-input w-full rounded-sm border px-2 py-1 font-mono text-xs focus:outline-none"
                    >
                      <option value="">-- 未映射 --</option>
                      {openLoopRaw.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-3 text-xs">
                <span className="dyno-text-muted">Ke&apos; 初值来源:</span>
                <select
                  value={keSource}
                  onChange={(e) => onChangeKeSource(e.target.value as KeSourceMode)}
                  className="dyno-input rounded-sm border px-2.5 py-1 text-xs focus:outline-none"
                >
                  <option value="open_loop_auto">自动取开环最高空载点</option>
                  <option value="manual_n0_vtest">手动空载点 (n0, V_test)</option>
                  <option value="manual_kv">手动输入电机 KV</option>
                </select>

                {keSource === 'open_loop_auto' && (
                  <div className="flex items-center gap-2 font-mono text-xs">
                    <span className="dyno-text-muted" title="必须填入实际开环调制系数；默认 1.0 只是满调制假设，未经实测确认时 Ke 仅为估计">
                      开环调制系数 m_norm（实测/确认值）:
                    </span>
                    <SmoothNumberInput
                      value={openLoopModDepth}
                      min={0.1}
                      max={1.0}
                      step={0.05}
                      precision={3}
                      ariaLabel="开环调制系数 m_norm"
                      onChange={(v) => onChangeOpenLoopModDepth(Math.max(0.1, Math.min(1.0, v)))}
                      className="dyno-input w-20 rounded-sm border px-2 py-1 text-right tabular-nums"
                    />
                  </div>
                )}

                {keSource === 'manual_n0_vtest' && (
                  <div className="flex items-center gap-2 font-mono text-xs">
                    <span className="dyno-text-muted">n0:</span>
                    <SmoothNumberInput
                      value={manualN0Rpm}
                      min={10}
                      step={50}
                      ariaLabel="空载转速 n0"
                      onChange={(v) => onChangeManualKe(v, manualVTestV, manualKv)}
                      className="dyno-input w-20 rounded-sm border px-2 py-1 text-right tabular-nums"
                    />
                    <span className="dyno-text-muted">V_test:</span>
                    <SmoothNumberInput
                      value={manualVTestV}
                      min={0.5}
                      step={0.1}
                      ariaLabel="空载测试电压 V_test"
                      onChange={(v) => onChangeManualKe(manualN0Rpm, v, manualKv)}
                      className="dyno-input w-16 rounded-sm border px-2 py-1 text-right tabular-nums"
                    />
                  </div>
                )}

                {keSource === 'manual_kv' && (
                  <div className="flex items-center gap-2 font-mono text-xs">
                    <span className="dyno-text-muted">KV (RPM/V):</span>
                    <SmoothNumberInput
                      value={manualKv}
                      min={1}
                      step={1}
                      ariaLabel="电机 KV"
                      onChange={(v) => onChangeManualKe(manualN0Rpm, manualVTestV, v)}
                      className="dyno-input w-24 rounded-sm border px-2 py-1 text-right tabular-nums"
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-3">
              <div className="text-xs font-semibold dyno-text-secondary">1B. 闭环负载列映射（缺失 Pin / Pout / eta 时自动补算）</div>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                {REQUIRED_FIELDS.map((f) => (
                  <label key={f.key} className="block text-[11px]">
                    <span className="mb-1 block dyno-text-muted">{f.label}</span>
                    <select
                      value={closedLoopMap[f.key]}
                      onChange={(e) => onChangeClosedMap({ ...closedLoopMap, [f.key]: e.target.value })}
                      className="dyno-input w-full rounded-sm border px-2 py-1 font-mono text-xs focus:outline-none"
                    >
                      <option value="">-- 自动补算/未映射 --</option>
                      {closedLoopRaw.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Data Quality / Unit / Convergence Warnings */}
      {warnings.length > 0 && (
        <div
          className={`${report.status === 'failed' ? 'dyno-alert-danger' : 'dyno-alert-warn'} rounded-sm border px-4 py-2.5 text-xs space-y-1`}
        >
          {warnings.map((w, i) => (
            <div key={i}>▲ {w}</div>
          ))}
        </div>
      )}

      {/* Unified 6-Metric KPI Strip */}
      <div className="dyno-card grid grid-cols-2 divide-y dyno-divide rounded-sm border md:grid-cols-3 md:divide-x xl:grid-cols-6 xl:divide-y-0">
        <div className="p-3.5">
          <div className="text-[11px] dyno-text-muted">标定 Ke&apos;</div>
          <div className="mt-1 font-mono text-lg font-semibold tabular-nums dyno-text-primary">
            {report.kePrime.toFixed(5)}
            <span className="ml-1 text-[10px] font-normal dyno-text-muted">Vp/(rad/s)</span>
          </div>
        </div>

        <div className="p-3.5">
          <div className="flex items-center gap-1 text-[11px] dyno-text-muted">
            {report.rsFitMode === 'locked' ? (
              <Lock className="h-3 w-3 dyno-accent-text" />
            ) : (
              <SlidersHorizontal className="h-3 w-3 text-amber-400" />
            )}
            等效相电阻 Rs_eff
          </div>
          <div className="mt-1 font-mono text-lg font-semibold tabular-nums dyno-text-primary">
            {report.rsEffOhm.toFixed(4)}
            <span className="ml-1 text-[10px] font-normal dyno-text-muted">Ω</span>
          </div>
          <div className="font-mono text-[10px] tabular-nums dyno-text-muted">
            基准 {report.rsAnchorOhm.toFixed(4)} Ω
          </div>
        </div>

        <div className="p-3.5">
          <div className="text-[11px] dyno-text-muted">磁饱和系数 β</div>
          <div className="mt-1 font-mono text-lg font-semibold tabular-nums dyno-accent-text">
            {report.betaSat.toFixed(5)}
            <span className="ml-1 text-[10px] font-normal dyno-text-muted">1/A²</span>
          </div>
        </div>

        <div className="p-3.5">
          <div className="text-[11px] dyno-text-muted">扭矩回代 MAE / RMSE</div>
          <div className="mt-1 font-mono text-base font-semibold tabular-nums dyno-text-primary">
            {Number.isFinite(metrics.maeTorqueNm) ? metrics.maeTorqueNm.toFixed(4) : 'N/A'} /{' '}
            {Number.isFinite(metrics.rmseTorqueNm) ? metrics.rmseTorqueNm.toFixed(4) : 'N/A'}
            <span className="ml-1 text-[10px] font-normal dyno-text-muted">N·m</span>
          </div>
        </div>

        <div className="p-3.5">
          <div className="text-[11px] dyno-text-muted">扭矩回代 MAPE</div>
          <div
            className={`mt-1 font-mono text-lg font-semibold tabular-nums ${
              Number.isFinite(metrics.mapeTorquePct) && metrics.mapeTorquePct <= 3.5
                ? 'dyno-alert-ok'
                : 'text-amber-400'
            }`}
          >
            {Number.isFinite(metrics.mapeTorquePct) ? metrics.mapeTorquePct.toFixed(2) : 'N/A'}
            <span className="ml-1 text-xs font-normal dyno-text-muted">%</span>
          </div>
        </div>

        <div className="p-3.5">
          <div className="text-[11px] dyno-text-muted">效率回代 MAE / MAPE</div>
          <div
            className={`mt-1 font-mono text-base font-semibold tabular-nums ${
              Number.isFinite(metrics.mapeEtaPct) && metrics.mapeEtaPct <= 3.5
                ? 'dyno-alert-ok'
                : 'text-amber-400'
            }`}
          >
            {Number.isFinite(metrics.maeEtaPct) ? `${metrics.maeEtaPct.toFixed(2)}pp` : 'N/A'} /{' '}
            {Number.isFinite(metrics.mapeEtaPct) ? `${metrics.mapeEtaPct.toFixed(2)}%` : 'N/A'}
          </div>
        </div>
      </div>

      {/* Measured vs Predicted & 3-Way Loss Chart */}
      <DynoFitComparisonChart points={report.evaluatedPoints} />

      {/* Side-by-Side 2D Efficiency Maps */}
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold dyno-text-primary">二维效率 Map η(n, T) 实测与模型重构对比</h3>
          <span className="text-xs dyno-text-muted">基于实测凸包安全插值与本地母线压降；超出饱和峰值或超调不可达区留白不外推</span>
        </div>
        <EfficiencyHeatmap2D grid={report.grid2D} points={report.evaluatedPoints} />
      </div>

      {/* Stepwise Fit Audit Log + Holdout CV + Operating Envelope */}
      <div className="dyno-card rounded-sm border px-4 py-3 text-xs dyno-text-secondary space-y-2">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 font-mono text-[11px]">
          {report.fitNotes.map((note, idx) => (
            <span key={idx}>{note}</span>
          ))}
        </div>
        {(report.validationMetrics || report.operatingEnvelope || report.paramSensitivity) && (
          <div className="grid grid-cols-1 gap-2 border-t dyno-border pt-2 font-mono text-[11px] md:grid-cols-3">
            {report.validationMetrics && (
              <div>
                <span className="dyno-text-muted">
                  20% Holdout 样本外验证（扭矩有效 {report.validationMetrics.validHoldoutCount}/{report.validationMetrics.holdoutCount} 点，效率有效 {report.validationMetrics.validHoldoutEtaCount} 点）：
                </span>
                <span className="dyno-text-primary font-semibold">
                  MAE={Number.isFinite(report.validationMetrics.valMaeTorqueNm) ? report.validationMetrics.valMaeTorqueNm.toFixed(4) : 'N/A'} N·m ({Number.isFinite(report.validationMetrics.valMapeTorquePct) ? `${report.validationMetrics.valMapeTorquePct.toFixed(2)}%` : 'MAPE N/A'}), η MAE={Number.isFinite(report.validationMetrics.valMaeEtaPct) ? `${report.validationMetrics.valMaeEtaPct.toFixed(2)}pp` : 'N/A'}
                </span>
              </div>
            )}
            {report.operatingEnvelope && (
              <div>
                <span className="dyno-text-muted">标定有效包络: </span>
                <span className="dyno-text-primary">
                  {report.operatingEnvelope.minRpm.toFixed(0)}–{report.operatingEnvelope.maxRpm.toFixed(0)} RPM ·{' '}
                  {report.operatingEnvelope.minTorqueNm.toFixed(3)}–{report.operatingEnvelope.maxTorqueNm.toFixed(3)} N·m ·{' '}
                  {report.operatingEnvelope.minVbusV.toFixed(1)}–{report.operatingEnvelope.maxVbusV.toFixed(1)} V
                </span>
              </div>
            )}
            {report.paramSensitivity && (
              <div>
                <span className="dyno-text-muted">参数灵敏度 (ΔMAE): </span>
                <span className="dyno-text-primary">
                  Rs+10% →{' '}
                  {Number.isFinite(report.paramSensitivity.rsPlus10PctDeltaMaeNm)
                    ? `${report.paramSensitivity.rsPlus10PctDeltaMaeNm >= 0 ? '+' : ''}${report.paramSensitivity.rsPlus10PctDeltaMaeNm.toFixed(4)}`
                    : 'N/A'}{' '}
                  N·m · Ke&apos;+5% →{' '}
                  {Number.isFinite(report.paramSensitivity.kePlus5PctDeltaMaeNm)
                    ? `${report.paramSensitivity.kePlus5PctDeltaMaeNm >= 0 ? '+' : ''}${report.paramSensitivity.kePlus5PctDeltaMaeNm.toFixed(4)}`
                    : 'N/A'}{' '}
                  N·m
                </span>
              </div>
            )}
          </div>
        )}
        <div className="text-[11px] dyno-text-muted">
          模型适用边界：稳态集总参数代数模型，假定 Y 型接法非凸极 SPMSM 且 Id = 0（不含高速弱磁 Id &lt; 0 与转子电感瞬态 dI/dt）。
        </div>
      </div>
    </div>
  );
};
