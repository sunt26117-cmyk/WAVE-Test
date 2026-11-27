import React, { useMemo, useState } from 'react';
import { Activity, AlertTriangle, Check, Copy, Download, Flame } from 'lucide-react';
import { MotorParams, SVPWM_LINEAR_LIMIT } from '../../modules/focDyno/motorPhysics';
import { MAX_EXPORT_SAMPLES, ExporterModulationMode, synthesizeSixMosWaveform } from '../../modules/focDyno/thermalExporter';
import {
  FocThermalHandoffPayload,
  buildOscilloscopeTabFromSixMos,
  buildThermalHandoffFromSixMos,
} from '../../modules/focDyno/scopeBridge';
import { TabState } from '../../types/models';
import { MultiChannelWaveChart } from './Charts';
import { SmoothNumberInput } from './SmoothNumberInput';

interface Tab3Props {
  params: MotorParams;
  onChangeParams: (next: MotorParams) => void;
  exportPoint: { vMeasV: number; iBusA: number; nRpm: number };
  onChangeExportPoint: (pt: { vMeasV: number; iBusA: number; nRpm: number }) => void;
  onSendTabToScope: (tab: TabState) => void;
  onSendToSixMosThermal: (payload: FocThermalHandoffPayload) => void;
  onNotify: (msg: string) => void;
}

export const Tab3ThermalExport: React.FC<Tab3Props> = ({
  params,
  onChangeParams,
  exportPoint,
  onChangeExportPoint,
  onSendTabToScope,
  onSendToSixMosThermal,
  onNotify,
}) => {
  const [tAmbC, setTAmbC] = useState(25);
  const [fsHz, setFsHz] = useState(20000);
  const [durationS, setDurationS] = useState(0.5);
  const [modulation, setModulation] = useState<ExporterModulationMode>('SVPWM');
  const [includeDuty, setIncludeDuty] = useState(false);
  const [rdsRefTempC, setRdsRefTempC] = useState(25);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const synth = useMemo(
    () =>
      synthesizeSixMosWaveform(
        {
          vMeasV: exportPoint.vMeasV,
          iBusA: exportPoint.iBusA,
          nRpm: exportPoint.nRpm,
          tAmbC,
          fsHz,
          durationS,
          modulation,
          includeDuty,
        },
        params
      ),
    [exportPoint, tAmbC, fsHz, durationS, modulation, includeDuty, params]
  );

  const previewSamples = useMemo(() => {
    const { samples, summary } = synth;
    if (samples.length === 0) return [];
    if (summary.isStall || summary.feHz < 1) {
      return samples.slice(0, Math.min(samples.length, 400));
    }
    const threeCyclesS = Math.min(durationS, Math.max(0.015, 3 / summary.feHz));
    const maxCount = Math.min(samples.length, Math.max(60, Math.round(threeCyclesS * fsHz)));
    return samples.slice(0, maxCount);
  }, [synth, durationS, fsHz]);

  const handleDownloadCsv = () => {
    if (synth.error || !synth.csvContent) return;
    const blob = new Blob([synth.csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `foc_6mos_${exportPoint.nRpm.toFixed(0)}rpm_${synth.summary.iqPeakA.toFixed(2)}A_${fsHz}Hz.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 500);
  };

  const handleViewInScope = () => {
    const tab = buildOscilloscopeTabFromSixMos(synth, exportPoint.nRpm);
    if (!tab) {
      onNotify(synth.error || '当前工况无物理实数解，无法生成示波器波形。');
      return;
    }
    onSendTabToScope(tab);
  };

  const convertedRds25MOhm = useMemo(() => {
    if (rdsRefTempC === 25) return params.rdsOnMOhm;
    const factor = Math.max(0.4, 1 + 0.0045 * (rdsRefTempC - 25));
    return params.rdsOnMOhm / factor;
  }, [params.rdsOnMOhm, rdsRefTempC]);

  const handleImportToThermal = () => {
    const payload = buildThermalHandoffFromSixMos(synth, params, exportPoint.nRpm, tAmbC, { rdsRefTempC });
    if (!payload) {
      onNotify(synth.error || '当前工况无物理实数解，无法导入 6-MOS 热评估。');
      return;
    }
    onSendToSixMosThermal(payload);
  };

  const copyValue = (key: string, val: string) => {
    navigator.clipboard?.writeText(val);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1400);
  };

  const { summary, pointResult } = synth;
  const fmt = (v: number, d: number) => (Number.isFinite(v) ? v.toFixed(d) : '无效');

  const summaryRows: Array<{ key: string; label: string; value: string; hint?: string; highlight?: boolean }> = [
    { key: 'ia', label: 'Phase Ia (A)', value: 'Ia', hint: '自动映射 Ia 列' },
    { key: 'ib', label: 'Phase Ib (A)', value: 'Ib', hint: '自动映射 Ib 列' },
    { key: 'ic', label: 'Phase Ic (or -Ia-Ib)', value: 'Ic', hint: 'Auto: Ic = -(Ia + Ib)' },
    { key: 'vbus', label: 'Vbus (V)', value: fmt(summary.vBusCapV, 3), hint: '自动映射 Vbus_cap 通道与常值备选' },
    { key: 'tamb', label: 'T_amb (°C)', value: summary.tAmbC.toFixed(1) },
    { key: 'fsw', label: 'MOS PWM 开关频率 Fsw (kHz)', value: fmt(params.fSwKhz, 2), hint: '此值来自电机/逆变器参数，直接用于六管稳态开关损耗；与下方辅助波形导出采样率 fs 不同。' },
    { key: 'mod', label: 'Modulation', value: includeDuty ? `${modulation} (含 Duty_A/B/C)` : modulation, hint: summary.modulationNote },
    {
      key: 'm_cmd',
      label: 'Mod Depth m_cmd [上限 1.1547] (热评估写入值)',
      value: fmt(summary.mCmd, 4),
      hint: `电机端 m_motor = ${fmt(summary.mMotor, 4)} · 归一化 m_norm = ${fmt(summary.mNormCmd, 4)}`,
      highlight: true,
    },
    {
      key: 'phi_cmd',
      label: 'PF Angle φ_cmd (°) [4象限 -180~+180]',
      value: fmt(summary.phiCmdDeg, 2),
      hint: `电机端 φ_motor = ${fmt(summary.phiDeg, 2)}°`,
      highlight: true,
    },
    {
      key: 'fe',
      label: '电频率 f_e (Hz)',
      value: summary.feHz.toFixed(2),
      hint: summary.isStall
        ? '堵转状态: 单相最大直流偏相 (Ia=Iq, Ib=Ic=-Iq/2)'
        : `Iq 峰值 = ${fmt(summary.iqPeakA, 3)} A (RMS ${fmt(summary.iphRmsA, 3)} A)`,
    },
  ];

  return (
    <div className="space-y-4">
      {/* Steady-state point & Export Configuration */}
      <div className="dyno-card space-y-4 rounded-sm border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold dyno-text-primary">固定工况稳态损耗 / 结温评估 &amp; 辅助波形导出</h3>
            <p className="text-xs dyno-text-muted">
              热评估按固定 Id/Iq、Vdc、PWM 条件直接计算周期平均损耗与稳态 Tj；示波器合成波形仅为辅助显示，不作为稳态求解输入
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={Boolean(synth.error)}
              onClick={handleViewInScope}
              className="dyno-btn-ghost inline-flex items-center gap-1.5 rounded-sm border px-3 py-1.5 text-xs font-medium whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
            >
              <Activity className="h-3.5 w-3.5 dyno-accent-text" />
              在示波器查看三相波形
            </button>

            <button
              type="button"
              disabled={Boolean(synth.error)}
              onClick={handleDownloadCsv}
              className="dyno-btn-ghost inline-flex items-center gap-1.5 rounded-sm border px-3 py-1.5 text-xs font-medium whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
            >
              <Download className="h-3.5 w-3.5" />
              下载 CSV ({synth.samples.length} 点)
            </button>

            <button
              type="button"
              disabled={Boolean(synth.error)}
              onClick={handleImportToThermal}
              className="dyno-btn-primary inline-flex items-center gap-1.5 rounded-sm px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
            >
              <Flame className="h-3.5 w-3.5" />
              {synth.error ? '工况无解' : '导入恒定工况到 MOS Thermal'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          <label className="block text-xs">
            <span className="mb-1 block dyno-text-muted">实测 V_meas (V)</span>
            <SmoothNumberInput
              step={0.1}
              value={exportPoint.vMeasV}
              ariaLabel="导出工况 V_meas"
              onChange={(v) => onChangeExportPoint({ ...exportPoint, vMeasV: v })}
              className="dyno-input w-full rounded-sm border px-2.5 py-1.5 font-mono text-xs tabular-nums focus:outline-none"
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block dyno-text-muted">母线 I_bus (A)</span>
            <SmoothNumberInput
              step={0.01}
              value={exportPoint.iBusA}
              ariaLabel="导出工况 I_bus"
              onChange={(v) => onChangeExportPoint({ ...exportPoint, iBusA: v })}
              className="dyno-input w-full rounded-sm border px-2.5 py-1.5 font-mono text-xs tabular-nums focus:outline-none"
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block dyno-text-muted">转速 n (RPM, 0=堵转)</span>
            <SmoothNumberInput
              step={50}
              value={exportPoint.nRpm}
              ariaLabel="导出工况转速 n"
              onChange={(v) => onChangeExportPoint({ ...exportPoint, nRpm: v })}
              className="dyno-input w-full rounded-sm border px-2.5 py-1.5 font-mono text-xs tabular-nums focus:outline-none"
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block dyno-text-muted">环境温度 T_amb (°C)</span>
            <SmoothNumberInput
              step={1}
              value={tAmbC}
              ariaLabel="环境温度 T_amb"
              onChange={setTAmbC}
              className="dyno-input w-full rounded-sm border px-2.5 py-1.5 font-mono text-xs tabular-nums focus:outline-none"
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block dyno-text-muted" title="仅控制导出/预览 CSV 的采样率，不是 MOS 损耗模型中的 PWM 开关频率">波形导出采样率 f_s (Hz)</span>
            <SmoothNumberInput
              step={1000}
              min={1000}
              max={200000}
              value={fsHz}
              ariaLabel="采样率 f_s"
              onChange={(v) => setFsHz(Math.max(1000, Math.round(v)))}
              className="dyno-input w-full rounded-sm border px-2.5 py-1.5 font-mono text-xs tabular-nums focus:outline-none"
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block dyno-text-muted" title="仅控制合成波形导出的记录长度，不影响恒定工况平均损耗与稳态热平衡">辅助波形导出时长 (s)</span>
            <SmoothNumberInput
              step={0.05}
              min={0.05}
              max={20}
              value={durationS}
              ariaLabel="导出时长"
              onChange={(v) => setDurationS(Math.max(0.05, Math.min(20, v)))}
              className="dyno-input w-full rounded-sm border px-2.5 py-1.5 font-mono text-xs tabular-nums focus:outline-none"
            />
          </label>

          <div className="grid grid-cols-2 gap-1.5">
            <label className="block text-xs">
              <span className="mb-1 block dyno-text-muted">I_idle (A)</span>
              <SmoothNumberInput
                step={0.005}
                min={0}
                precision={3}
                value={params.iIdleA}
                ariaLabel="I_idle"
                onChange={(v) => onChangeParams({ ...params, iIdleA: Math.max(0, v) })}
                className="dyno-input w-full rounded-sm border px-1.5 py-1.5 font-mono text-xs tabular-nums focus:outline-none"
              />
            </label>
            <label className="block text-xs">
              <span className="mb-1 block dyno-text-muted">η_inv</span>
              <SmoothNumberInput
                step={0.01}
                min={0.3}
                max={0.999}
                precision={3}
                value={params.etaInv}
                ariaLabel="逆变器效率"
                onChange={(v) => onChangeParams({ ...params, etaInv: Math.min(0.999, Math.max(0.3, v)) })}
                className="dyno-input w-full rounded-sm border px-1.5 py-1.5 font-mono text-xs tabular-nums focus:outline-none"
              />
            </label>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t dyno-border pt-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="dyno-text-muted">采样率:</span>
            {[10000, 20000, 50000].map((rate) => (
              <button
                key={rate}
                type="button"
                onClick={() => setFsHz(rate)}
                className={`rounded-xs border px-2 py-0.5 font-mono text-[11px] transition-colors cursor-pointer ${
                  fsHz === rate ? 'dyno-seg-active border-transparent' : 'dyno-btn-ghost'
                }`}
              >
                {rate / 1000} kHz
              </button>
            ))}
            <span className="mx-1 dyno-text-muted">|</span>
            <button
              type="button"
              onClick={() => onChangeExportPoint({ vMeasV: 13.5, iBusA: 1.06, nRpm: 1000 })}
              className="dyno-btn-ghost rounded-xs border px-2 py-0.5 text-[11px] cursor-pointer"
            >
              1000 RPM 额定点
            </button>
            <button
              type="button"
              onClick={() => onChangeExportPoint({ vMeasV: 13.5, iBusA: 0.65, nRpm: 0 })}
              className="dyno-btn-ghost rounded-xs border px-2 py-0.5 text-[11px] text-amber-400 cursor-pointer"
            >
              n=0 堵转直流偏相
            </button>
            <span className="mx-1 dyno-text-muted">|</span>
            <select
              aria-label="PWM 调制方式"
              value={modulation}
              onChange={(e) => setModulation(e.target.value as ExporterModulationMode)}
              className="dyno-input rounded-xs border px-1.5 py-0.5 font-mono text-[11px] focus:outline-none"
            >
              <option value="SVPWM">SVPWM</option>
              <option value="DPWM1">DPWM1</option>
            </select>
            <label className="inline-flex items-center gap-1.5 cursor-pointer select-none text-[11px] dyno-text-secondary">
              <input
                type="checkbox"
                checked={includeDuty}
                onChange={(e) => setIncludeDuty(e.target.checked)}
                className="accent-cyan-500 cursor-pointer"
              />
              <span title="仅把理想周期平均 Duty 导出到 Scope；恒定损耗求解会由 Vdc、m、PF 和调制方式独立重建平均 Duty">导出辅助 Duty_A/B/C</span>
            </label>
          </div>
          <div className="font-mono text-[11px] tabular-nums dyno-text-muted">
            Iq={fmt(summary.iqPeakA, 3)} A · T_est={fmt(pointResult.tEstNm, 4)} N·m · Rds={params.rdsOnMOhm.toFixed(1)} mΩ
            {(pointResult.alerts.cmdSat || pointResult.alerts.motorSat) && (
              <span className="ml-2 inline-flex items-center gap-1 text-amber-400">
                <AlertTriangle className="h-3 w-3" />
                调制比超 {SVPWM_LINEAR_LIMIT.toFixed(4)}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t dyno-border pt-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="dyno-text-muted">Dyno Rds 参考结温 (导出至热评估时自动折算为 Rds25):</span>
            {[25, 85, 100].map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setRdsRefTempC(t)}
                className={`rounded-xs border px-2 py-0.5 font-mono text-[11px] cursor-pointer ${
                  rdsRefTempC === t ? 'dyno-seg-active border-transparent' : 'dyno-btn-ghost'
                }`}
              >
                {t}°C{t === 25 ? ' (Rds25)' : ' (热态)'}
              </button>
            ))}
            <SmoothNumberInput
              value={rdsRefTempC}
              min={-40}
              max={175}
              step={5}
              ariaLabel="Rds 参考结温"
              onChange={(v) => setRdsRefTempC(Math.max(-40, Math.min(175, v)))}
              className="dyno-input w-16 rounded-sm border px-2 py-0.5 font-mono text-[11px] text-right tabular-nums"
            />
            <span className="font-mono text-[11px] dyno-accent-text">
              → 导出 Rds25 = {convertedRds25MOhm.toFixed(2)} mΩ
            </span>
          </div>
          <span className="text-[11px] dyno-text-muted">
            防止热态 Rds 叠加 6-MOS α 温升系数造成双重放大
          </span>
        </div>

        <div className="dyno-alert-info rounded-sm border px-3.5 py-2 text-xs">
          ⓘ 恒定工况边界：MOS Thermal 稳态求解使用 FOC 固定工作点、Vdc、实际 PWM 开关频率（来自电机参数 Fsw）、调制度、功率因数角及死区；这里的波形采样率/导出时长只影响辅助 CSV/Scope 预览，不影响稳态损耗。辅助 Ia/Ib/Ic 与 Duty 为理想模型，不含 PWM 载波纹波、寄生振铃及实测不平衡。
        </div>

        {synth.error && <div className="dyno-alert-danger rounded-sm border px-3.5 py-2 text-xs">✖ {synth.error}</div>}
        {synth.clampedByLimit && (
          <div className="dyno-alert-warn rounded-sm border px-3.5 py-2 text-xs">
            ▲ 请求时长 {synth.requestedDurationS.toFixed(3)} s（需 {synth.requestedSamples.toLocaleString()} 点）超出 {MAX_EXPORT_SAMPLES.toLocaleString()} 点上限，实际仅导出{' '}
            <strong className="font-mono">{synth.actualDurationS.toFixed(3)} s</strong>（{synth.exportedSamples.toLocaleString()} 行），会直接缩短后续热预热与稳态收敛观察窗口。
          </div>
        )}
      </div>

      {/* Main Split: Waveform Preview + Copyable 6-MOS Summary Card */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="space-y-3 xl:col-span-7">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold tracking-wide dyno-text-primary">
              导出波形预览 ({summary.isStall ? '堵转单相直流偏相 Ia=Iq, Ib=Ic=-Iq/2' : `三相正弦 Ia, Ib, Ic @ f_e = ${summary.feHz.toFixed(2)} Hz`})
            </h4>
            <span className="font-mono text-[11px] dyno-text-muted">
              预览前 {previewSamples.length} 点 / 全长 {synth.samples.length} 点
            </span>
          </div>

          {previewSamples.length > 0 ? (
            <>
              <MultiChannelWaveChart
                times={previewSamples.map((s) => s.timeS)}
                yLabel="相电流 (A)"
                height={292}
                series={[
                  { label: 'Ia (A)', color: '#06B6D4', values: previewSamples.map((s) => s.iaA) },
                  { label: 'Ib (A)', color: '#F59E0B', values: previewSamples.map((s) => s.ibA) },
                  { label: 'Ic (A)', color: '#10B981', values: previewSamples.map((s) => s.icA) },
                ]}
              />
              <div className="dyno-card rounded-sm border p-3.5">
                <div className="mb-1.5 text-[11px] dyno-text-muted">CSV 前 4 行格式预览 (UTF-8, Time 单位: s)</div>
                <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed tabular-nums dyno-text-secondary">
                  {synth.csvContent.split('\n').slice(0, 5).join('\n')}
                </pre>
              </div>
            </>
          ) : (
            <div className="dyno-card flex h-64 items-center justify-center rounded-sm border px-6 text-center text-sm text-rose-400">
              当前输入工况无物理实数解，请调整 V_meas / I_bus / n 后导出。
            </div>
          )}
        </div>

        {/* Strictly Aligned 6-MOS Simulator Parameter Summary Card */}
        <div className="dyno-card rounded-sm border p-3.5 xl:col-span-5">
          <div className="mb-2 border-b dyno-border pb-2">
            <h4 className="text-sm font-semibold dyno-text-primary">对齐 6-MOS 结温评估参数摘要卡</h4>
            <p className="mt-1 text-xs leading-relaxed dyno-text-muted">
              自动同步 Vbus_cap、m_cmd (SVPWM 线性上限 {SVPWM_LINEAR_LIMIT.toFixed(4)})、φ_cmd、f_sw、t_dead、Rds25 ({convertedRds25MOhm.toFixed(2)} mΩ @ 25°C)、V_SD{includeDuty ? ' 与 Duty_A/B/C' : ''}；其中 Ke&apos;/P0/β 由 Dyno 标定，I_idle/η_inv 为手动基准；开关损耗/热系数 α、Esw、Qrr、Vref、Iref 仍以 MOS Thermal 面板为准。
            </p>
          </div>

          <div className="divide-y dyno-divide">
            {summaryRows.map((row) => (
              <div
                key={row.key}
                className={`flex items-center justify-between gap-3 py-1.5 ${
                  row.highlight ? 'dyno-highlight-row -mx-2 rounded-xs px-2' : ''
                }`}
              >
                <div className="min-w-0">
                  <div className="text-xs font-medium dyno-text-primary">{row.label}</div>
                  {row.hint && <div className="font-mono text-[11px] dyno-text-muted">{row.hint}</div>}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <span
                    className={`font-mono text-xs font-semibold tabular-nums ${
                      row.highlight ? 'dyno-accent-text' : 'dyno-text-primary'
                    }`}
                  >
                    {row.value}
                  </span>
                  <button
                    type="button"
                    onClick={() => copyValue(row.key, row.value)}
                    className="dyno-btn-ghost rounded-xs border p-1 cursor-pointer"
                    title="复制数值"
                    aria-label={`复制 ${row.label}`}
                  >
                    {copiedKey === row.key ? <Check className="h-3 w-3 dyno-alert-ok" /> : <Copy className="h-3 w-3" />}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
