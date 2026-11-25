import React, { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileSpreadsheet,
  Sliders,
  Upload,
} from 'lucide-react';
import {
  MotorParams,
  SVPWM_LINEAR_LIMIT,
  SinglePointResult,
  forwardVerifyPoint,
  isMonotonicTimestamps,
  processRuntimeLog,
  solveSinglePoint,
} from '../../modules/focDyno/motorPhysics';
import { RawRuntimeLogEntry } from '../../modules/focDyno/demoData';
import { detectHeaderEngineeringScale, parseSpreadsheetFile } from '../../modules/focDyno/dynoCalibrator';
import {
  ScopeCurrentUnit,
  ScopeSpeedUnit,
  buildOscilloscopeTabFromBatchLog,
  extractRuntimeLogWithAudit,
} from '../../modules/focDyno/scopeBridge';
import { TabState } from '../../types/models';
import { MultiChannelWaveChart } from './Charts';
import { SmoothNumberInput } from './SmoothNumberInput';

interface Tab2Props {
  params: MotorParams;
  logRows: RawRuntimeLogEntry[];
  logFileName: string;
  activeScopeTab: TabState | null;
  onUpdateLog: (rows: RawRuntimeLogEntry[], fileName: string) => void;
  onSendPointToExport: (pt: { vMeasV: number; iBusA: number; nRpm: number }) => void;
  onSendTabToScope: (tab: TabState) => void;
  onNotify: (msg: string) => void;
}

const MODE_LABELS: Record<SinglePointResult['mode'], string> = {
  motoring: '电动驱动 (Motoring)',
  regen: '发电制动 (Regen)',
  zero_drift: '空载零漂死区 (Iq=0)',
  regen_limit: '✖ 超发电极限 (Δ<0)',
  invalid_bus: '✖ 母线压降异常',
};

export const Tab2RuntimeEst: React.FC<Tab2Props> = ({
  params,
  logRows,
  logFileName,
  activeScopeTab,
  onUpdateLog,
  onSendPointToExport,
  onSendTabToScope,
  onNotify,
}) => {
  const [subMode, setSubMode] = useState<'single' | 'batch'>('single');

  // Single point inverse state
  const [vMeas, setVMeas] = useState<number>(13.5);
  const [iBus, setIBus] = useState<number>(1.06);
  const [nRpm, setNRpm] = useState<number>(1000);

  // Forward verification state
  const [fwdIq, setFwdIq] = useState<number>(1.44);
  const [fwdN, setFwdN] = useState<number>(1000);
  const [fwdV, setFwdV] = useState<number>(13.5);

  // Batch runtime filter
  const [filterMs, setFilterMs] = useState<number>(12);
  const [batchChartView, setBatchChartView] = useState<'currents' | 'mod' | 'voltages'>('currents');

  // Oscilloscope channel import drawer state
  const [showScopePicker, setShowScopePicker] = useState(false);
  const scopeChannels = useMemo(() => {
    if (!activeScopeTab) return [];
    return activeScopeTab.drawOrder.map((id) => activeScopeTab.channels[id]).filter(Boolean);
  }, [activeScopeTab]);

  const [selVbusId, setSelVbusId] = useState<string>('__const__');
  const [constVbusV, setConstVbusV] = useState<number>(13.5);
  const [selIbusId, setSelIbusId] = useState<string>('');
  const [currentUnit, setCurrentUnit] = useState<ScopeCurrentUnit>('A');
  const [selSpeedId, setSelSpeedId] = useState<string>('__const__');
  const [constSpeedRpm, setConstSpeedRpm] = useState<number>(1000);
  const [speedUnit, setSpeedUnit] = useState<ScopeSpeedUnit>('rpm');
  const [scopeExtractWarnings, setScopeExtractWarnings] = useState<string[]>([]);
  const [scopeVbusScaleNote, setScopeVbusScaleNote] = useState<string | null>(null);

  const singleRes = useMemo(() => solveSinglePoint(vMeas, iBus, nRpm, params), [vMeas, iBus, nRpm, params]);
  const fwdRes = useMemo(() => forwardVerifyPoint(fwdIq, fwdN, fwdV, params), [fwdIq, fwdN, fwdV, params]);

  const logProcessed = useMemo(
    () => processRuntimeLog(logRows, filterMs, params),
    [logRows, filterMs, params]
  );

  const batchAlertsSummary = useMemo(() => {
    let lowSpeed = 0;
    let cmdSat = 0;
    let motorSat = 0;
    let lowFreq = 0;
    let regenLimit = 0;
    let zeroDrift = 0;
    let invalidBus = 0;
    let iqSignAmbiguous = 0;
    for (const r of logProcessed) {
      if (r.result.alerts.lowSpeed) lowSpeed++;
      if (r.result.alerts.cmdSat) cmdSat++;
      if (r.result.alerts.motorSat) motorSat++;
      if (r.result.alerts.lowFreqThermal) lowFreq++;
      if (r.result.alerts.regenLimit) regenLimit++;
      if (r.result.alerts.zeroDrift) zeroDrift++;
      if (r.result.alerts.invalidBus) invalidBus++;
      if (r.result.alerts.iqSignAmbiguous) iqSignAmbiguous++;
    }
    return { lowSpeed, cmdSat, motorSat, lowFreq, regenLimit, zeroDrift, invalidBus, iqSignAmbiguous };
  }, [logProcessed]);

  const isLogTimeMonotonic = useMemo(
    () => isMonotonicTimestamps(logRows.map((r) => r.timeS)),
    [logRows]
  );

  const handleLogUpload = async (file: File | undefined) => {
    if (!file) return;
    try {
      const ds = await parseSpreadsheetFile(file);
      const find = (re: RegExp) => ds.headers.find((h) => re.test(h.trim().toLowerCase())) || '';
      const tCol = find(/^(time|t(_?(s|ms|us|µs|μs|ns|min))?(\s*[\[(（].*[\])）])?)$|time|timestamp|t_?sec|时间/);
      const vCol = find(/v_?bus|v_?meas|vbus|volt|电压/);
      const iCol = find(/i_?bus|ibus|curr|电流/);
      const nCol = find(/n_?rpm|rpm|speed|转速/);

      if (!vCol || !iCol || !nCol) {
        onNotify('运行日志必须至少包含 V_bus/V_meas、I_bus、n_rpm 三列。');
        return;
      }

      const detectTimeMultiplier = (header: string): number => {
        const lower = header.toLowerCase();
        if (/(\bms\b|msec|\(ms\)|\[ms\]|_ms$|毫秒)/.test(lower)) return 1e-3;
        if (/(\bus\b|usec|µs|μs|\(us\)|\[us\]|_us$|微秒)/.test(lower)) return 1e-6;
        if (/(\bns\b|nsec|\(ns\)|\[ns\]|_ns$|纳秒)/.test(lower)) return 1e-9;
        if (/(\bmin\b|\(min\)|\[min\]|分钟)/.test(lower)) return 60;
        return 1;
      };
      const tMult = tCol ? detectTimeMultiplier(tCol) : 1;
      const vScale = detectHeaderEngineeringScale(vCol, 'voltage');
      const iScale = detectHeaderEngineeringScale(iCol, 'current');
      const nScale = detectHeaderEngineeringScale(nCol, 'speed');
      const badUnit = [vScale, iScale, nScale].find((u) => u.invalidToken);
      if (badUnit?.invalidToken) {
        onNotify(`运行日志单位「${badUnit.invalidToken}」无法安全换算，请将列单位改为 V/mV、A/mA、RPM/krpm 或 rad/s。`);
        return;
      }

      const parseTimeStringSec = (raw: unknown): number => {
        if (typeof raw !== 'string') return Number.NaN;
        const m = raw.trim().match(/^(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)$/);
        if (!m) return Number.NaN;
        return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      };

      let tStrBase = Number.NaN;
      const parsed: RawRuntimeLogEntry[] = [];
      for (let idx = 0; idx < ds.rows.length; idx++) {
        const row = ds.rows[idx];
        const vRaw = Number(row[vCol]);
        const iRaw = Number(row[iCol]);
        const nRaw = Number(row[nCol]);
        // Ignore wholly blank/non-numeric data rows, but never fabricate a time
        // for a row carrying valid engineering values and a broken Time cell.
        if (!Number.isFinite(vRaw) || !Number.isFinite(iRaw) || !Number.isFinite(nRaw)) continue;

        let t = idx * 0.002;
        if (tCol) {
          const rawT = row[tCol];
          const numT = Number(rawT);
          if (Number.isFinite(numT) && String(rawT).trim() !== '') {
            t = numT * tMult;
          } else {
            const hms = parseTimeStringSec(rawT);
            if (Number.isFinite(hms)) {
              if (!Number.isFinite(tStrBase)) tStrBase = hms;
              t = hms - tStrBase;
            } else {
              throw new Error(`第 ${idx + 2} 行 Time 单元格无效；检测到 Time 列后禁止回退到合成 2 ms 时间轴。`);
            }
          }
        }

        const v = vRaw * vScale.scale;
        const i = iRaw * iScale.scale;
        const n = nRaw * nScale.scale;
        if (!Number.isFinite(v) || v <= 0 || !Number.isFinite(i) || !Number.isFinite(n)) {
          throw new Error(`第 ${idx + 2} 行 V_bus/I_bus/n_rpm 转换后无效（V_bus 必须大于 0）。`);
        }
        if (parsed.length > 0 && t <= parsed[parsed.length - 1].timeS) {
          throw new Error(`第 ${idx + 2} 行 Time 重复或倒退；请先按时间升序整理运行日志。`);
        }
        parsed.push({ timeS: t, vMeasV: v, iBusA: i, nRpm: n });
      }

      if (parsed.length === 0) {
        onNotify('未解析出有效的运行日志数值行。');
        return;
      }
      const importWarnings: string[] = [];
      if (!tCol) importWarnings.push('文件未包含 Time 列，按原始行号以 500 Sa/s（2 ms）重建时间轴。');
      if (!vScale.unit) importWarnings.push('V_bus 列未声明单位，按 V 处理。');
      if (!iScale.unit) importWarnings.push('I_bus 列未声明单位，按 A 处理。');
      if (!nScale.unit) importWarnings.push('n_rpm 列未声明单位，按 RPM 处理。');
      setScopeExtractWarnings(importWarnings);
      setScopeVbusScaleNote(null);
      onUpdateLog(parsed, ds.fileName);
    } catch (err) {
      onNotify(`读取运行日志失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const detectUnitFromChannel = (chId: string): ScopeCurrentUnit => {
    const ch = activeScopeTab?.channels[chId];
    return ch && /\bma\b/i.test((ch.unit || '').trim()) ? 'mA' : 'A';
  };

  const openScopeChannelImporter = () => {
    if (!activeScopeTab || scopeChannels.length === 0) {
      onNotify('当前示波器无已加载通道，请先在示波器打开波形文件。');
      return;
    }
    const guess = (re: RegExp) => scopeChannels.find((c) => re.test(c.name.toLowerCase()))?.id || '';
    const vGuess = guess(/v_?bus|vbus|v_?meas|bat|dc/);
    const iGuess = guess(/i_?bus|ibus|idc|i_?bat|i_?in/) || scopeChannels[0].id;
    const sGuess = guess(/rpm|speed|omega|freq/);

    setSelVbusId(vGuess || '__const__');
    setSelIbusId(iGuess);
    setCurrentUnit(detectUnitFromChannel(iGuess));
    setSelSpeedId(sGuess || '__const__');
    setShowScopePicker(true);
  };

  const confirmScopeImport = () => {
    if (!activeScopeTab) return;
    const ibusCh = activeScopeTab.channels[selIbusId];
    if (!ibusCh) {
      onNotify('请选择有效的母线电流通道。');
      return;
    }
    const vbusCh = selVbusId !== '__const__' ? activeScopeTab.channels[selVbusId] || null : null;
    const speedCh = selSpeedId !== '__const__' ? activeScopeTab.channels[selSpeedId] || null : null;
    const audit = extractRuntimeLogWithAudit({
      vbusCh,
      vbusConstV: constVbusV,
      ibusCh,
      currentUnit,
      speedCh,
      speedConstRpm: constSpeedRpm,
      speedUnit,
      polePairs: params.polePairs,
      maxPoints: 4000,
    });
    if (audit.rows.length < 2) {
      onNotify('提取到的有效采样点少于 2 个，无法生成运行日志。');
      return;
    }
    setScopeExtractWarnings(audit.warnings);
    setScopeVbusScaleNote(
      vbusCh && audit.vbusScaleV !== 1
        ? `已按 Vbus 通道单位 "${vbusCh.unit}" 自动乘以 ${audit.vbusScaleV} 换算为 V`
        : null
    );
    onUpdateLog(audit.rows, `Scope_${activeScopeTab.fileName}`);
    setShowScopePicker(false);
  };

  const handlePushBatchToScope = () => {
    const tab = buildOscilloscopeTabFromBatchLog(logProcessed, logFileName);
    if (!tab) {
      onNotify('日志不足或时间戳无效（NaN、重复、倒退），无法生成可靠时间轴；请检查日志时间列。');
      return;
    }
    onSendTabToScope(tab);
  };

  const renderAlertsBar = (res: SinglePointResult) => {
    const hasAnyWarn =
      res.alerts.lowSpeed ||
      res.alerts.cmdSat ||
      res.alerts.motorSat ||
      res.alerts.lowFreqThermal ||
      res.alerts.regenLimit ||
      res.alerts.invalidBus ||
      res.alerts.iqSignAmbiguous;

    return (
      <div className="dyno-card rounded-sm border p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-semibold tracking-wide dyno-text-primary">物理安全状态与工程边界实时诊断</h4>
          <div className="flex items-center gap-2 font-mono text-xs tabular-nums">
            <span className="dyno-text-muted">工况判别:</span>
            <span
              className={
                res.mode === 'invalid_bus' || res.mode === 'regen_limit'
                  ? 'text-rose-400 font-semibold'
                  : res.mode === 'zero_drift'
                  ? 'dyno-accent-text font-semibold'
                  : 'dyno-alert-ok font-semibold'
              }
            >
              {MODE_LABELS[res.mode]}
            </span>
          </div>
        </div>

        {(res.alerts.invalidBus || res.alerts.regenLimit) && (
          <div className="dyno-alert-danger rounded-sm border px-3.5 py-2 text-xs">
            {res.alerts.invalidBus
              ? `✖ 母线端有效电压塌陷：V_meas (${res.vMeasV.toFixed(2)}V) - I_bus·R_line <= 0.1V，物理无解。`
              : `✖ 该工况超出发电回馈最大制动功率极限 (Δ < 0)，控制器已无法反推有效相电流，已严格阻止全零输出。`}
          </div>
        )}

        {res.alerts.iqSignAmbiguous && (
          <div className="dyno-alert-warn rounded-sm border px-3.5 py-2 text-xs">
            ▲ 相电流方向/多根歧义：零速堵转 (±Iq 母线功耗对称) 或发电回馈工况存在二次方程双根（默认取铜耗更小解），请结合实际控制指令或转速方向核实。
          </div>
        )}

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          <div
            className={`flex items-start gap-2 rounded-sm border px-3 py-2 text-xs ${
              res.alerts.zeroDrift ? 'dyno-alert-info' : 'dyno-well dyno-text-muted'
            }`}
          >
            <Sliders className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              <div className="font-medium dyno-text-primary">微电流零漂保护 (|I_net| &lt; {params.iDeadbandA.toFixed(3)} A)</div>
              <div className="mt-0.5 font-mono text-[11px] tabular-nums">
                {res.alerts.zeroDrift
                  ? `零漂死区 (I_net=${res.iNetA.toFixed(3)}A)，Iq=0 空载滑行 (-P0)`
                  : `正常区间 (I_net=${res.iNetA.toFixed(3)} A)`}
              </div>
            </div>
          </div>

          <div
            className={`flex items-start gap-2 rounded-sm border px-3 py-2 text-xs ${
              res.alerts.lowSpeed ? 'dyno-alert-warn' : 'dyno-well dyno-text-muted'
            }`}
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              <div className="font-medium dyno-text-primary">低速信噪比告警 (|n| &lt; 0.08·n0)</div>
              <div className="mt-0.5 font-mono text-[11px] tabular-nums">
                {res.alerts.lowSpeed
                  ? `▲ |n|=${Math.abs(res.nRpm).toFixed(0)} < ${(0.08 * params.n0Rpm).toFixed(0)} RPM，反推误差放大`
                  : `正常 (|n|=${Math.abs(res.nRpm).toFixed(0)} ≥ ${(0.08 * params.n0Rpm).toFixed(0)} RPM)`}
              </div>
            </div>
          </div>

          <div
            className={`flex items-start gap-2 rounded-sm border px-3 py-2 text-xs ${
              res.alerts.motorSat || res.alerts.cmdSat ? 'dyno-alert-warn' : 'dyno-well dyno-text-muted'
            }`}
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              <div className="font-medium dyno-text-primary">双调制比饱和 (&gt; {SVPWM_LINEAR_LIMIT.toFixed(4)})</div>
              <div className="mt-0.5 font-mono text-[11px] tabular-nums">
                m_mot={Number.isFinite(res.mMotor) ? res.mMotor.toFixed(3) : '--'}
                {res.alerts.motorSat ? '[饱和]' : ''} · m_cmd={Number.isFinite(res.mCmd) ? res.mCmd.toFixed(3) : '--'}
                {res.alerts.cmdSat ? '[饱和]' : ''}
              </div>
            </div>
          </div>

          <div
            className={`flex items-start gap-2 rounded-sm border px-3 py-2 text-xs ${
              res.alerts.lowFreqThermal ? 'dyno-alert-danger' : 'dyno-well dyno-text-muted'
            }`}
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              <div className="font-medium dyno-text-primary">堵转 / 极低频发热 (f_e &lt; 3 Hz)</div>
              <div className="mt-0.5 font-mono text-[11px] tabular-nums">
                {res.alerts.lowFreqThermal
                  ? `✖ f_e=${res.feHz.toFixed(2)} Hz，单相管持续受流`
                  : `正常 (f_e=${res.feHz.toFixed(1)} Hz)`}
              </div>
            </div>
          </div>
        </div>

        {!hasAnyWarn && !res.alerts.zeroDrift && (
          <div className="flex items-center gap-1.5 text-[11px] dyno-alert-ok">
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span>运行边界正常，处于线性 SVPWM 与有效信噪比区间内。</span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* Sub-mode switcher */}
      <div className="dyno-card flex flex-wrap items-center justify-between gap-3 rounded-sm border px-4 py-2.5">
        <div className="dyno-well flex items-center gap-1 rounded-sm border p-0.5">
          <button
            type="button"
            onClick={() => setSubMode('single')}
            className={`rounded-xs px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
              subMode === 'single' ? 'dyno-seg-active' : 'dyno-text-muted hover:dyno-text-primary'
            }`}
          >
            单点实时推算与正向校验
          </button>
          <button
            type="button"
            onClick={() => setSubMode('batch')}
            className={`rounded-xs px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
              subMode === 'batch' ? 'dyno-seg-active' : 'dyno-text-muted hover:dyno-text-primary'
            }`}
          >
            批量运行日志与示波器联动
          </button>
        </div>

        {subMode === 'single' && (
          <button
            type="button"
            onClick={() => onSendPointToExport({ vMeasV: vMeas, iBusA: iBus, nRpm })}
            className="dyno-btn-ghost inline-flex items-center gap-1.5 rounded-sm border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer"
          >
            送入 Tab 3 合成三相波形
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {subMode === 'single' ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {/* Reverse Estimation Card */}
            <div className="dyno-card space-y-4 rounded-sm border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold dyno-text-primary">逆向推算：实测 (V_meas, I_bus, n) → Iq &amp; 双 Vq</h3>
                  <p className="text-xs dyno-text-muted">支持正/反转、发电制动、零漂死区与堵转</p>
                </div>
                <div className="flex flex-wrap gap-1 text-[11px]">
                  {[
                    { label: '额定 0.1Nm', v: 13.5, i: 1.06, n: 1000 },
                    { label: '零漂 0.045A', v: 13.52, i: 0.045, n: 1000 },
                    { label: '高速饱和', v: 13.5, i: 1.95, n: 1380 },
                    { label: '堵转态', v: 13.5, i: 0.65, n: 0 },
                  ].map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => {
                        setVMeas(preset.v);
                        setIBus(preset.i);
                        setNRpm(preset.n);
                      }}
                      className="dyno-btn-ghost rounded-xs border px-2 py-0.5 text-[11px] whitespace-nowrap cursor-pointer"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <label className="block text-xs">
                  <span className="mb-1 block dyno-text-muted">实测母线 V_meas (V)</span>
                  <SmoothNumberInput
                    step={0.1}
                    value={vMeas}
                    ariaLabel="实测母线 V_meas"
                    onChange={setVMeas}
                    className="dyno-input w-full rounded-sm border px-2.5 py-1.5 font-mono text-sm tabular-nums focus:outline-none"
                  />
                </label>
                <label className="block text-xs">
                  <span className="mb-1 block dyno-text-muted">实测电流 I_bus (A)</span>
                  <SmoothNumberInput
                    step={0.01}
                    value={iBus}
                    ariaLabel="实测电流 I_bus"
                    onChange={setIBus}
                    className="dyno-input w-full rounded-sm border px-2.5 py-1.5 font-mono text-sm tabular-nums focus:outline-none"
                  />
                </label>
                <label className="block text-xs">
                  <span className="mb-1 block dyno-text-muted">转速 n (RPM)</span>
                  <SmoothNumberInput
                    step={25}
                    value={nRpm}
                    ariaLabel="转速 n"
                    onChange={setNRpm}
                    className="dyno-input w-full rounded-sm border px-2.5 py-1.5 font-mono text-sm tabular-nums focus:outline-none"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3 border-t dyno-border pt-3 sm:grid-cols-3 font-mono tabular-nums">
                <div>
                  <div className="font-sans text-[11px] dyno-text-muted">相电流峰值 Iq</div>
                  <div className="text-lg font-semibold dyno-accent-text">
                    {Number.isFinite(singleRes.iqA) ? singleRes.iqA.toFixed(4) : 'NaN'}{' '}
                    <span className="text-xs font-normal dyno-text-muted">A</span>
                  </div>
                </div>
                <div>
                  <div className="font-sans text-[11px] dyno-text-muted">相电流有效值 Iph_rms</div>
                  <div className="text-lg font-semibold dyno-text-primary">
                    {Number.isFinite(singleRes.iphRmsA) ? singleRes.iphRmsA.toFixed(4) : 'NaN'}{' '}
                    <span className="text-xs font-normal dyno-text-muted">A</span>
                  </div>
                </div>
                <div>
                  <div className="font-sans text-[11px] dyno-text-muted">估算轴扭矩 T_est</div>
                  <div className="text-lg font-semibold dyno-text-primary">
                    {Number.isFinite(singleRes.tEstNm) ? singleRes.tEstNm.toFixed(4) : 'NaN'}{' '}
                    <span className="text-xs font-normal dyno-text-muted">N·m</span>
                  </div>
                </div>
                <div>
                  <div className="font-sans text-[11px] dyno-text-muted">电机端 Vq_motor / Vd</div>
                  <div className="text-sm font-medium dyno-text-secondary">
                    {Number.isFinite(singleRes.vqMotorV) ? singleRes.vqMotorV.toFixed(3) : '--'} /{' '}
                    {Number.isFinite(singleRes.vdV) ? singleRes.vdV.toFixed(3) : '--'} V
                  </div>
                </div>
                <div>
                  <div className="font-sans text-[11px] dyno-text-muted">逆变器指令端 Vq_cmd</div>
                  <div className="text-sm font-semibold text-amber-400">
                    {Number.isFinite(singleRes.vqCmdV) ? singleRes.vqCmdV.toFixed(3) : '--'} V
                  </div>
                </div>
                <div>
                  <div className="font-sans text-[11px] dyno-text-muted">电容端 Vbus_cap / η_est</div>
                  <div className="text-sm font-medium dyno-text-secondary">
                    {Number.isFinite(singleRes.vBusCapV) ? singleRes.vBusCapV.toFixed(3) : '--'} V /{' '}
                    {Number.isFinite(singleRes.etaEst) ? `${(singleRes.etaEst * 100).toFixed(1)}%` : '--'}
                  </div>
                </div>
              </div>
            </div>

            {/* Forward Verification Card */}
            <div className="dyno-card space-y-4 rounded-sm border p-4">
              <div>
                <h3 className="text-sm font-semibold dyno-text-primary">正向校验：给定 (Iq, n, V_meas) → 反算 I_bus</h3>
                <p className="text-xs dyno-text-muted">与逆向二次求解闭环互验，核对母线压降与端电压一致性</p>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <label className="block text-xs">
                  <span className="mb-1 block dyno-text-muted">给定相电流 Iq (A)</span>
                  <SmoothNumberInput
                    step={0.1}
                    value={fwdIq}
                    ariaLabel="给定相电流 Iq"
                    onChange={setFwdIq}
                    className="dyno-input w-full rounded-sm border px-2.5 py-1.5 font-mono text-sm tabular-nums focus:outline-none"
                  />
                </label>
                <label className="block text-xs">
                  <span className="mb-1 block dyno-text-muted">转速 n (RPM)</span>
                  <SmoothNumberInput
                    step={25}
                    value={fwdN}
                    ariaLabel="正向校验转速 n"
                    onChange={setFwdN}
                    className="dyno-input w-full rounded-sm border px-2.5 py-1.5 font-mono text-sm tabular-nums focus:outline-none"
                  />
                </label>
                <label className="block text-xs">
                  <span className="mb-1 block dyno-text-muted">母线 V_meas (V)</span>
                  <SmoothNumberInput
                    step={0.1}
                    value={fwdV}
                    ariaLabel="正向校验母线电压"
                    onChange={setFwdV}
                    className="dyno-input w-full rounded-sm border px-2.5 py-1.5 font-mono text-sm tabular-nums focus:outline-none"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3 border-t dyno-border pt-3 sm:grid-cols-3 font-mono tabular-nums">
                <div>
                  <div className="font-sans text-[11px] dyno-text-muted">正算母线电流 I_bus_est</div>
                  <div className="text-lg font-semibold dyno-accent-text">
                    {Number.isFinite(fwdRes.iBusEstA) ? fwdRes.iBusEstA.toFixed(4) : '母线塌陷'}{' '}
                    {Number.isFinite(fwdRes.iBusEstA) && <span className="text-xs font-normal dyno-text-muted">A</span>}
                  </div>
                </div>
                <div>
                  <div className="font-sans text-[11px] dyno-text-muted">轴输出扭矩 T_est</div>
                  <div className="text-lg font-semibold dyno-text-primary">
                    {fwdRes.tEstNm.toFixed(4)} <span className="text-xs font-normal dyno-text-muted">N·m</span>
                  </div>
                </div>
                <div>
                  <div className="font-sans text-[11px] dyno-text-muted">系统效率 η_est</div>
                  <div className="text-lg font-semibold dyno-text-primary">
                    {Number.isFinite(fwdRes.etaEst) ? (fwdRes.etaEst * 100).toFixed(1) : '--'}{' '}
                    <span className="text-xs font-normal dyno-text-muted">%</span>
                  </div>
                </div>
                <div>
                  <div className="font-sans text-[11px] dyno-text-muted">Vq_motor / Vq_cmd</div>
                  <div className="text-sm font-medium dyno-text-secondary">
                    {fwdRes.vqMotorV.toFixed(3)} / {Number.isFinite(fwdRes.vqCmdV) ? fwdRes.vqCmdV.toFixed(3) : '--'} V
                  </div>
                </div>
                <div>
                  <div className="font-sans text-[11px] dyno-text-muted">m_motor / m_cmd</div>
                  <div className="text-sm font-medium dyno-text-secondary">
                    {Number.isFinite(fwdRes.mMotor) ? fwdRes.mMotor.toFixed(4) : '--'} /{' '}
                    {Number.isFinite(fwdRes.mCmd) ? fwdRes.mCmd.toFixed(4) : '--'}
                  </div>
                </div>
                <div>
                  <div className="font-sans text-[11px] dyno-text-muted">闭环互验</div>
                  <button
                    type="button"
                    disabled={fwdRes.alerts.invalidBus || !Number.isFinite(fwdRes.iBusEstA)}
                    onClick={() => {
                      setVMeas(fwdV);
                      setIBus(Number(fwdRes.iBusEstA.toFixed(5)));
                      setNRpm(fwdN);
                    }}
                    className="dyno-btn-ghost mt-0.5 rounded-sm border px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer whitespace-nowrap"
                  >
                    填入左侧反推验证
                  </button>
                </div>
              </div>
            </div>
          </div>

          {renderAlertsBar(singleRes)}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="dyno-card flex flex-wrap items-center justify-between gap-4 rounded-sm border p-4">
            <div>
              <h3 className="text-sm font-semibold dyno-text-primary">批量运行日志动态推算 &amp; 示波器通道联动</h3>
              <p className="text-xs dyno-text-muted">
                当前日志: <span className="font-mono dyno-text-primary">{logFileName}</span> · 样本数{' '}
                <span className="font-mono tabular-nums dyno-accent-text">{logProcessed.length}</span>
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-xs">
                <span className="dyno-text-secondary">滤波窗口:</span>
                <input
                  type="range"
                  min={5}
                  max={20}
                  step={1}
                  value={filterMs}
                  onChange={(e) => setFilterMs(Number(e.target.value))}
                  className="w-28 accent-cyan-500 cursor-pointer"
                />
                <span className="w-12 font-mono tabular-nums dyno-accent-text">{filterMs} ms</span>
              </label>

              <button
                type="button"
                onClick={openScopeChannelImporter}
                className="dyno-btn-ghost inline-flex items-center gap-1.5 rounded-sm border px-3 py-1.5 text-xs font-medium whitespace-nowrap cursor-pointer"
              >
                <FileSpreadsheet className="h-3.5 w-3.5 dyno-accent-text" />
                从示波器读取通道
              </button>

              <label className="dyno-btn-ghost inline-flex cursor-pointer items-center gap-1.5 rounded-sm border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors">
                <Upload className="h-3.5 w-3.5 dyno-accent-text" />
                上传运行日志 CSV
                <input
                  type="file"
                  accept=".csv,.xlsx,.xls,.txt"
                  className="hidden"
                  onChange={(e) => {
                    void handleLogUpload(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </label>

              <button
                type="button"
                onClick={handlePushBatchToScope}
                className="dyno-btn-primary inline-flex items-center gap-1.5 rounded-sm px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap cursor-pointer"
              >
                <Activity className="h-3.5 w-3.5" />
                发送批次波形到示波器
              </button>
            </div>
          </div>

          {showScopePicker && (
            <div className="dyno-card rounded-sm border p-4 space-y-3">
              <div className="flex items-center justify-between border-b dyno-border pb-2">
                <span className="text-xs font-semibold dyno-text-primary">
                  从示波器导入运行日志 · 当前标签页：{activeScopeTab?.fileName}
                </span>
                <button
                  type="button"
                  onClick={() => setShowScopePicker(false)}
                  className="dyno-btn-ghost rounded-xs border px-2 py-0.5 text-[11px] cursor-pointer"
                >
                  取消
                </button>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3 text-xs">
                <div className="space-y-1.5">
                  <label className="block dyno-text-muted">母线电压通道 Vbus</label>
                  <select
                    value={selVbusId}
                    onChange={(e) => setSelVbusId(e.target.value)}
                    className="dyno-input w-full rounded-sm border px-2 py-1 font-mono text-xs"
                  >
                    <option value="__const__">-- 使用固定常值 --</option>
                    {scopeChannels.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.unit || 'V'})
                      </option>
                    ))}
                  </select>
                  {selVbusId === '__const__' && (
                    <SmoothNumberInput
                      value={constVbusV}
                      step={0.1}
                      min={1}
                      ariaLabel="固定母线电压 V"
                      onChange={setConstVbusV}
                      className="dyno-input w-full rounded-sm border px-2 py-1 font-mono text-xs"
                    />
                  )}
                </div>

                <div className="space-y-1.5">
                  <label className="block dyno-text-muted">母线电流通道 Ibus &amp; 单位</label>
                  <div className="flex gap-1.5">
                    <select
                      value={selIbusId}
                      onChange={(e) => {
                        const nextId = e.target.value;
                        setSelIbusId(nextId);
                        setCurrentUnit(detectUnitFromChannel(nextId));
                      }}
                      className="dyno-input flex-1 rounded-sm border px-2 py-1 font-mono text-xs"
                    >
                      {scopeChannels.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.unit || '?'})
                        </option>
                      ))}
                    </select>
                    <select
                      value={currentUnit}
                      onChange={(e) => setCurrentUnit(e.target.value as ScopeCurrentUnit)}
                      className="dyno-input w-20 rounded-sm border px-2 py-1 font-mono text-xs"
                    >
                      <option value="A">A</option>
                      <option value="mA">mA</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="block dyno-text-muted">转速通道 Speed &amp; 单位 (p={params.polePairs})</label>
                  <div className="flex gap-1.5">
                    <select
                      value={selSpeedId}
                      onChange={(e) => setSelSpeedId(e.target.value)}
                      className="dyno-input flex-1 rounded-sm border px-2 py-1 font-mono text-xs"
                    >
                      <option value="__const__">-- 固定 RPM --</option>
                      {scopeChannels.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.unit || '?'})
                        </option>
                      ))}
                    </select>
                    {selSpeedId === '__const__' ? (
                      <SmoothNumberInput
                        value={constSpeedRpm}
                        step={50}
                        ariaLabel="固定转速 RPM"
                        onChange={setConstSpeedRpm}
                        className="dyno-input w-24 rounded-sm border px-2 py-1 font-mono text-xs"
                      />
                    ) : (
                      <select
                        value={speedUnit}
                        onChange={(e) => setSpeedUnit(e.target.value as ScopeSpeedUnit)}
                        className="dyno-input w-24 rounded-sm border px-2 py-1 font-mono text-xs"
                      >
                        <option value="rpm">RPM</option>
                        <option value="rad_s">rad/s</option>
                        <option value="elec_hz">电频率 Hz</option>
                      </select>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={confirmScopeImport}
                  className="dyno-btn-primary rounded-sm px-4 py-1.5 text-xs font-semibold cursor-pointer"
                >
                  提取并执行批量逆向反推
                </button>
              </div>
            </div>
          )}

          {!isLogTimeMonotonic && (
            <div className="dyno-alert-warn rounded-sm border px-4 py-2 text-xs">
              ▲ 检测到日志时间戳非严格单调递增（可能拼接了多段采集或存在时间戳回绕），滑动窗口已自动降级为按正中位步长点数滤波。
            </div>
          )}

          {scopeVbusScaleNote && (
            <div className="dyno-alert-info rounded-sm border px-4 py-2 text-xs">
              ⓘ {scopeVbusScaleNote}
            </div>
          )}

          {scopeExtractWarnings.length > 0 && (
            <div className="dyno-alert-warn rounded-sm border px-4 py-2 text-xs space-y-1">
              {scopeExtractWarnings.map((w, idx) => (
                <div key={idx}>▲ {w}</div>
              ))}
            </div>
          )}

          <div className="dyno-well rounded-sm border px-3.5 py-1.5 text-[11px] dyno-text-muted">
            离线分析说明：I_bus 采用零相位双向中心时间窗 [t−W/2, t+W/2] 平滑（适合离线日志，实时控制器需考虑 W/2 相位延迟）；物理模型按稳态 Y 型接法 Id = 0 反推。
          </div>

          {(batchAlertsSummary.regenLimit > 0 || batchAlertsSummary.invalidBus > 0 || batchAlertsSummary.iqSignAmbiguous > 0) && (
            <div className="dyno-alert-warn rounded-sm border px-4 py-2 text-xs">
              ▲ 日志检测到 {batchAlertsSummary.regenLimit} 个超发电极限点、{batchAlertsSummary.invalidBus} 个母线压降异常点（在波形中断点留白），以及 {batchAlertsSummary.iqSignAmbiguous} 个多根/符号歧义点（发电回馈双根或零速 ±Iq 对称）。
            </div>
          )}

          {/* Unified Batch Alert Summary Strip */}
          <div className="dyno-card grid grid-cols-2 divide-y dyno-divide rounded-sm border font-mono text-xs tabular-nums md:grid-cols-5 md:divide-x md:divide-y-0">
            <div className="p-3">
              <div className="font-sans text-[11px] dyno-text-muted">空载零漂区样本</div>
              <div className="mt-1 text-base font-semibold dyno-accent-text">{batchAlertsSummary.zeroDrift} 点</div>
            </div>
            <div className="p-3">
              <div className="font-sans text-[11px] dyno-text-muted">低速告警 (&lt;0.08·n0)</div>
              <div className="mt-1 text-base font-semibold text-amber-400">{batchAlertsSummary.lowSpeed} 点</div>
            </div>
            <div className="p-3">
              <div className="font-sans text-[11px] dyno-text-muted">指令饱和 (m_cmd&gt;1.1547)</div>
              <div className="mt-1 text-base font-semibold text-amber-400">{batchAlertsSummary.cmdSat} 点</div>
            </div>
            <div className="p-3">
              <div className="font-sans text-[11px] dyno-text-muted">电机弱磁 (m_motor&gt;1.1547)</div>
              <div className="mt-1 text-base font-semibold text-amber-400">{batchAlertsSummary.motorSat} 点</div>
            </div>
            <div className="p-3">
              <div className="font-sans text-[11px] dyno-text-muted">低频发热 (f_e&lt;3 Hz)</div>
              <div className="mt-1 text-base font-semibold text-rose-400">{batchAlertsSummary.lowFreq} 点</div>
            </div>
          </div>

          {/* Chart selector */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="dyno-well flex items-center gap-1 rounded-sm border p-0.5">
              {(
                [
                  ['currents', '电流通道 (I_bus / Iq)'],
                  ['mod', '双调制比 (m_motor / m_cmd)'],
                  ['voltages', '双端电压 (Vq_motor / Vq_cmd)'],
                ] as const
              ).map(([k, lbl]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setBatchChartView(k)}
                  className={`rounded-xs px-3 py-1 text-xs font-medium whitespace-nowrap cursor-pointer ${
                    batchChartView === k ? 'dyno-seg-active' : 'dyno-text-muted hover:dyno-text-primary'
                  }`}
                >
                  {lbl}
                </button>
              ))}
            </div>
            <span className="text-xs dyno-text-muted">悬停可探针查看任意时刻反推值，或点击上方推送到主示波器做 FFT/游标分析</span>
          </div>

          {batchChartView === 'currents' && (
            <MultiChannelWaveChart
              times={logProcessed.map((r) => r.timeS)}
              yLabel="电流 (A)"
              series={[
                { label: 'I_bus_raw (A)', color: '#94A3B8', values: logProcessed.map((r) => r.iBusRawA), dashed: true },
                { label: 'I_bus_filt (A)', color: '#D97706', values: logProcessed.map((r) => r.iBusFilteredA) },
                { label: 'Iq_est (A)', color: '#06B6D4', values: logProcessed.map((r) => r.result.iqA) },
              ]}
            />
          )}

          {batchChartView === 'mod' && (
            <MultiChannelWaveChart
              times={logProcessed.map((r) => r.timeS)}
              yLabel="调制比 m"
              referenceLine={{ value: SVPWM_LINEAR_LIMIT, label: 'SVPWM 线性极限', color: '#D97706' }}
              series={[
                { label: 'm_motor', color: '#06B6D4', values: logProcessed.map((r) => r.result.mMotor) },
                { label: 'm_cmd', color: '#E11D48', values: logProcessed.map((r) => r.result.mCmd) },
              ]}
            />
          )}

          {batchChartView === 'voltages' && (
            <MultiChannelWaveChart
              times={logProcessed.map((r) => r.timeS)}
              yLabel="q轴电压 (V)"
              series={[
                { label: 'Vq_motor (V)', color: '#06B6D4', values: logProcessed.map((r) => r.result.vqMotorV) },
                { label: 'Vq_cmd (V)', color: '#D97706', values: logProcessed.map((r) => r.result.vqCmdV) },
              ]}
            />
          )}
        </div>
      )}
    </div>
  );
};
