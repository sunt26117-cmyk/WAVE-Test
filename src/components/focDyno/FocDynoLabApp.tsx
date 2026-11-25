import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import {
  DEMO_MOTOR_PARAMS,
  RawRuntimeLogEntry,
  buildDemoClosedLoopDataset,
  buildDemoOpenLoopDataset,
  buildDemoRuntimeLog,
} from '../../modules/focDyno/demoData';
import {
  DynoColumnMapping,
  EfficiencyFormat,
  KeSourceMode,
  RsFitMode,
  TabularDataset,
  TorqueUnit,
  autoMapColumns,
  normalizeDynoDataset,
  runStepwiseCalibration,
} from '../../modules/focDyno/dynoCalibrator';
import { MotorParams, getEffectiveRsOhm } from '../../modules/focDyno/motorPhysics';
import { PYTHON_BUNDLE_FILES, downloadPythonBundleZip } from '../../modules/focDyno/pythonBundle';
import { FocThermalHandoffPayload } from '../../modules/focDyno/scopeBridge';
import { TabState } from '../../types/models';
import { SidebarParams } from './SidebarParams';
import { Tab1DynoCalib } from './Tab1DynoCalib';
import { Tab2RuntimeEst } from './Tab2RuntimeEst';
import { Tab3ThermalExport } from './Tab3ThermalExport';
import { Tab4DynamicPmsm } from './Tab4DynamicPmsm';

export interface FocDynoLabAppProps {
  getActiveScopeTab: () => TabState | null;
  onSendTabToScope: (tab: TabState) => void;
  onSendToSixMosThermal: (payload: FocThermalHandoffPayload) => void;
  onNotify: (msg: string, level?: 'info' | 'warn' | 'error') => void;
}

export const FocDynoLabApp: React.FC<FocDynoLabAppProps> = ({
  getActiveScopeTab,
  onSendTabToScope,
  onSendToSixMosThermal,
  onNotify,
}) => {
  const [activeTab, setActiveTab] = useState<'tab1' | 'tab2' | 'tab3' | 'tab4'>('tab1');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [params, setParams] = useState<MotorParams>(() => ({ ...DEMO_MOTOR_PARAMS }));

  // Tab 1 Dyno state
  const [openLoopRaw, setOpenLoopRaw] = useState<TabularDataset>(() => buildDemoOpenLoopDataset());
  const [closedLoopRaw, setClosedLoopRaw] = useState<TabularDataset>(() => buildDemoClosedLoopDataset());
  const [openLoopMap, setOpenLoopMap] = useState<DynoColumnMapping>(() =>
    autoMapColumns(buildDemoOpenLoopDataset().headers)
  );
  const [closedLoopMap, setClosedLoopMap] = useState<DynoColumnMapping>(() =>
    autoMapColumns(buildDemoClosedLoopDataset().headers)
  );
  const [torqueUnit, setTorqueUnit] = useState<TorqueUnit>('Nm');
  const [etaFormat, setEtaFormat] = useState<EfficiencyFormat>('0-1');
  const [keSource, setKeSource] = useState<KeSourceMode>('open_loop_auto');
  const [manualN0Rpm, setManualN0Rpm] = useState<number>(1450);
  const [manualVTestV, setManualVTestV] = useState<number>(13.5);
  const [manualKv, setManualKv] = useState<number>(107.4);
  const [rsFitMode, setRsFitMode] = useState<RsFitMode>('locked');
  const [openLoopModDepth, setOpenLoopModDepth] = useState<number>(1.0);
  const [calibTrigger, setCalibTrigger] = useState(0);

  // Explicit provenance flags so demo baselines can never be mistaken for real hardware measurements
  const [isOpenLoopDemo, setIsOpenLoopDemo] = useState(true);
  const [isClosedLoopDemo, setIsClosedLoopDemo] = useState(true);
  const [isParamsDemo, setIsParamsDemo] = useState(true);
  const [isLogDemo, setIsLogDemo] = useState(true);
  const [isExportPointDemo, setIsExportPointDemo] = useState(true);

  // Tab 2 Runtime state
  const [logRows, setLogRows] = useState<RawRuntimeLogEntry[]>(() => buildDemoRuntimeLog());
  const [logFileName, setLogFileName] = useState<string>('demo_runtime_log_13V5_30W.csv');

  // Re-read active scope snapshot whenever entering Tab 2 or theme flips
  const [scopeTick, setScopeTick] = useState(0);
  useEffect(() => {
    const bump = () => setScopeTick((n) => n + 1);
    window.addEventListener('wvp-workspace-shown', bump);
    return () => window.removeEventListener('wvp-workspace-shown', bump);
  }, []);

  const activeScopeTab = useMemo(() => {
    void scopeTick;
    return getActiveScopeTab();
  }, [getActiveScopeTab, scopeTick, activeTab]);

  // Tab 3 Thermal export point
  const [exportPoint, setExportPoint] = useState({ vMeasV: 13.5, iBusA: 1.06, nRpm: 1000 });

  // Python source bundle modal
  const [showPythonModal, setShowPythonModal] = useState(false);
  const [selectedPyFile, setSelectedPyFile] = useState(PYTHON_BUNDLE_FILES[0].name);

  const showToast = useCallback(
    (msg: string) => {
      onNotify(msg, 'info');
    },
    [onNotify]
  );

  const { calibReport, normWarnings } = useMemo(() => {
    void calibTrigger;
    const olRes = normalizeDynoDataset(openLoopRaw, openLoopMap, 'Nm', '0-1', { requireTorque: false });
    const clRes = normalizeDynoDataset(closedLoopRaw, closedLoopMap, torqueUnit, etaFormat, { requireTorque: true });
    const report = runStepwiseCalibration(olRes.points, clRes.points, params, {
      keSource,
      manualN0Rpm,
      manualVTestV,
      manualKv,
      rsFitMode,
      openLoopModDepth,
    });
    return {
      calibReport: report,
      normWarnings: [...olRes.warnings, ...clRes.warnings, ...report.warnings],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
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
    params.polePairs,
    params.rLL25Ohm,
    params.tCoilC,
    params.lLLmH,
    params.iIdleA,
    params.etaInv,
    params.iDeadbandA,
    params.rLineOhm,
    params.rdsOnMOhm,
    params.tDeadNs,
    params.fSwKhz,
    params.vSdV,
    calibTrigger,
  ]);

  useEffect(() => {
    if (calibReport.status === 'failed') return;
    setParams((prev) => {
      const nextRsOverride = rsFitMode === 'locked' ? null : calibReport.rsEffOhm;
      if (
        Math.abs(prev.kePrime - calibReport.kePrime) < 1e-7 &&
        Math.abs(prev.n0Rpm - calibReport.n0Rpm) < 1e-3 &&
        Math.abs(prev.p0A - calibReport.p0A) < 1e-9 &&
        Math.abs(prev.p0B - calibReport.p0B) < 1e-11 &&
        Math.abs(prev.betaSat - calibReport.betaSat) < 1e-7 &&
        prev.rsEffOverrideOhm === nextRsOverride
      ) {
        return prev;
      }
      return {
        ...prev,
        kePrime: calibReport.kePrime,
        n0Rpm: calibReport.n0Rpm,
        p0A: calibReport.p0A,
        p0B: calibReport.p0B,
        betaSat: calibReport.betaSat,
        rsEffOverrideOhm: nextRsOverride,
      };
    });
  }, [calibReport, rsFitMode]);

  const handleLoadDemo = () => {
    const ol = buildDemoOpenLoopDataset();
    const cl = buildDemoClosedLoopDataset();
    setParams({ ...DEMO_MOTOR_PARAMS });
    setOpenLoopRaw(ol);
    setClosedLoopRaw(cl);
    setOpenLoopMap(autoMapColumns(ol.headers));
    setClosedLoopMap(autoMapColumns(cl.headers));
    setTorqueUnit('Nm');
    setEtaFormat('0-1');
    setKeSource('open_loop_auto');
    setRsFitMode('locked');
    setOpenLoopModDepth(1.0);
    setLogRows(buildDemoRuntimeLog());
    setLogFileName('demo_runtime_log_13V5_30W.csv');
    setExportPoint({ vMeasV: 13.5, iBusA: 1.06, nRpm: 1000 });
    setIsOpenLoopDemo(true);
    setIsClosedLoopDemo(true);
    setIsParamsDemo(true);
    setIsLogDemo(true);
    setIsExportPointDemo(true);
    setCalibTrigger((c) => c + 1);
    showToast('已载入 13.5V / 30W / 1000 RPM / 0.1 N·m 演示数据集并完成分步标定');
  };

  const activePyContent =
    PYTHON_BUNDLE_FILES.find((f) => f.name === selectedPyFile)?.content ?? PYTHON_BUNDLE_FILES[0].content;
  const rsEff = getEffectiveRsOhm(params);

  return (
    <div className="dyno-chassis flex min-h-full flex-col">
      {/* Sub-workspace Ribbon */}
      <div className="dyno-panel sticky top-0 z-20 flex flex-wrap items-center justify-between gap-4 border-b px-5 py-2">
        <div className="flex flex-wrap items-center gap-5">
          <button
            type="button"
            onClick={() => setSidebarOpen((v) => !v)}
            className="dyno-btn-ghost inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 text-xs whitespace-nowrap cursor-pointer"
          >
            {sidebarOpen ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeftOpen className="h-3.5 w-3.5" />}
            {sidebarOpen ? '收起参数栏' : '展开参数栏'}
          </button>

          <nav className="flex items-center gap-5 text-xs font-medium">
            {(
              [
                ['tab1', '01. 测功仪标定与 Map'],
                ['tab2', '02. 运行态推算与告警'],
                ['tab3', '03. 6-MOS 波形与导出'],
                ['tab4', '04. 动态 dq 瞬态仿真'],
              ] as const
            ).map(([k, lbl]) => (
              <button
                key={k}
                type="button"
                onClick={() => setActiveTab(k)}
                className={`border-b-2 py-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                  activeTab === k ? 'dyno-tab-active font-semibold' : 'border-transparent dyno-text-muted hover:dyno-text-primary'
                }`}
              >
                {lbl}
              </button>
            ))}

            <button
              type="button"
              onClick={() => setShowPythonModal(true)}
              className="border-b-2 border-transparent py-1.5 dyno-text-muted hover:dyno-accent-text whitespace-nowrap shrink-0 transition-colors cursor-pointer"
            >
              Python 源码包
            </button>
          </nav>
        </div>

        <div className="flex items-center gap-4">
          <span className="hidden xl:inline font-mono text-[11px] tabular-nums dyno-text-muted">
            p={params.polePairs} · Ke&apos;={params.kePrime.toFixed(5)} · Rs_eff={rsEff.toFixed(4)} Ω · β={params.betaSat.toFixed(5)}
          </span>
          <button
            type="button"
            onClick={handleLoadDemo}
            className="dyno-btn-primary rounded-sm px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer"
          >
            载入 13.5V/30W Demo
          </button>
        </div>
      </div>

      {/* Explicit Data Provenance Strip */}
      <div className="dyno-panel border-b px-5 py-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="dyno-text-muted font-medium">数据来源追踪:</span>
          {activeTab === 'tab1' && (
            <>
              <span
                className={`rounded-xs border px-2 py-0.5 font-mono ${
                  isOpenLoopDemo || isClosedLoopDemo ? 'dyno-alert-warn' : 'dyno-alert-ok border-emerald-500/40'
                }`}
              >
                {isOpenLoopDemo && isClosedLoopDemo
                  ? 'DEMO 示例测功数据 (13.5V/30W) — 请勿直接作为实机台架结论'
                  : isOpenLoopDemo || isClosedLoopDemo
                  ? `混合数据: 开环[${isOpenLoopDemo ? 'Demo' : '实测'}] · 闭环[${isClosedLoopDemo ? 'Demo' : '实测'}]`
                  : `用户实测台架表 (${openLoopRaw.fileName} / ${closedLoopRaw.fileName})`}
              </span>
              {isParamsDemo && (
                <span className="rounded-xs border px-2 py-0.5 dyno-alert-info">
                  电机基准参数仍为 Demo 默认值
                </span>
              )}
            </>
          )}
          {activeTab === 'tab2' && (
            <span
              className={`rounded-xs border px-2 py-0.5 font-mono ${
                isLogDemo || isParamsDemo ? 'dyno-alert-warn' : 'dyno-alert-ok border-emerald-500/40'
              }`}
            >
              日志: {isLogDemo ? `DEMO (${logFileName})` : `实测/示波器 (${logFileName})`} · 电机参数: {isParamsDemo && isClosedLoopDemo ? 'DEMO 基准' : '已标定/用户修改'}
            </span>
          )}
          {activeTab === 'tab3' && (
            <span
              className={`rounded-xs border px-2 py-0.5 font-mono ${
                isExportPointDemo || isParamsDemo ? 'dyno-alert-warn' : 'dyno-alert-ok border-emerald-500/40'
              }`}
            >
              工况点: {isExportPointDemo ? 'DEMO 额定工况 (13.5V / 1.06A / 1000RPM)' : '用户设定/日志传参'} · 波形属性: 理想对称稳态合成（非实测采样）
            </span>
          )}
          {activeTab === 'tab4' && (
            <span className="rounded-xs border px-2 py-0.5 font-mono dyno-alert-warn">
              来源: synthetic_assumed_uncalibrated · 独立动态 PMSM dq RK4 模型（与 Tab 1 稳态标定器隔离）
            </span>
          )}
        </div>
        <span className="dyno-text-muted hidden md:inline">
          实时辨识与逆向反推基于稳态 Y 型非凸极 Id=0 模型
        </span>
      </div>

      {/* Main Split Console */}
      <div className="flex flex-1 flex-col lg:flex-row">
        {sidebarOpen && (
          <SidebarParams
            params={params}
            onChange={(next) => {
              setIsParamsDemo(false);
              setParams(next);
            }}
            onResetDemoParams={() => {
              setParams({ ...DEMO_MOTOR_PARAMS });
              setIsParamsDemo(true);
              showToast('已重置为 13.5V / 30W 电机物理基准参数');
            }}
          />
        )}

        <div className="min-w-0 flex-1 p-5 lg:p-6">
          {activeTab === 'tab1' && (
            <Tab1DynoCalib
              params={params}
              openLoopRaw={openLoopRaw}
              closedLoopRaw={closedLoopRaw}
              openLoopMap={openLoopMap}
              closedLoopMap={closedLoopMap}
              torqueUnit={torqueUnit}
              etaFormat={etaFormat}
              keSource={keSource}
              manualN0Rpm={manualN0Rpm}
              manualVTestV={manualVTestV}
              manualKv={manualKv}
              rsFitMode={rsFitMode}
              openLoopModDepth={openLoopModDepth}
              report={calibReport}
              warnings={normWarnings}
              onUpdateOpenLoop={(ds, map) => {
                setOpenLoopRaw(ds);
                setOpenLoopMap(map);
                setIsOpenLoopDemo(false);
                showToast(`已导入开环表 ${ds.fileName}，自动完成分步标定`);
              }}
              onUpdateClosedLoop={(ds, map, detUnit, detEta) => {
                setClosedLoopRaw(ds);
                setClosedLoopMap(map);
                setIsClosedLoopDemo(false);
                const notes: string[] = [];
                if (detUnit) {
                  setTorqueUnit(detUnit);
                  notes.push(`自动识别扭矩单位=${detUnit}`);
                }
                if (detEta) {
                  setEtaFormat(detEta);
                  notes.push(`自动识别效率格式=${detEta === 'percent' ? '百分比(0-100%)' : '小数(0-1)'}`);
                }
                showToast(
                  `已导入闭环表 ${ds.fileName}${notes.length ? ` (${notes.join('，')})` : ''}，已更新标定`
                );
              }}
              onChangeOpenMap={setOpenLoopMap}
              onChangeClosedMap={setClosedLoopMap}
              onChangeTorqueUnit={setTorqueUnit}
              onChangeEtaFormat={setEtaFormat}
              onChangeKeSource={setKeSource}
              onChangeManualKe={(n0, vt, kv) => {
                setManualN0Rpm(n0);
                setManualVTestV(vt);
                setManualKv(kv);
              }}
              onChangeRsFitMode={setRsFitMode}
              onChangeOpenLoopModDepth={setOpenLoopModDepth}
              onRunCalibration={() => {
                setCalibTrigger((c) => c + 1);
                showToast('分步标定已重新执行');
              }}
              onNotify={showToast}
            />
          )}

          {activeTab === 'tab2' && (
            <Tab2RuntimeEst
              params={params}
              logRows={logRows}
              logFileName={logFileName}
              activeScopeTab={activeScopeTab}
              onUpdateLog={(rows, fname) => {
                setLogRows(rows);
                setLogFileName(fname);
                setIsLogDemo(false);
                showToast(`已载入运行日志 ${fname} (${rows.length} 行)`);
              }}
              onSendPointToExport={(pt) => {
                setExportPoint(pt);
                setIsExportPointDemo(false);
                setActiveTab('tab3');
                showToast('已将该稳态工况点同步至 Tab 3 波形合成区');
              }}
              onSendTabToScope={(tab) => {
                onSendTabToScope(tab);
                showToast(`已推送 ${tab.fileName} 到主示波器画布`);
              }}
              onNotify={showToast}
            />
          )}

          {activeTab === 'tab3' && (
            <Tab3ThermalExport
              params={params}
              onChangeParams={(next) => {
                setIsParamsDemo(false);
                setParams(next);
              }}
              exportPoint={exportPoint}
              onChangeExportPoint={(pt) => {
                setIsExportPointDemo(false);
                setExportPoint(pt);
              }}
              onSendTabToScope={(tab) => {
                onSendTabToScope(tab);
                showToast(`已打开 ${tab.fileName} 三相波形`);
              }}
              onSendToSixMosThermal={(payload) => {
                onSendToSixMosThermal(payload);
              }}
              onNotify={showToast}
            />
          )}

          {activeTab === 'tab4' && (
            <Tab4DynamicPmsm
              baseParams={params}
              onSendTabToScope={(tab) => {
                onSendTabToScope(tab);
                showToast(`已打开 ${tab.fileName} 动态仿真波形`);
              }}
              onNotify={showToast}
            />
          )}
        </div>
      </div>

      {/* Python / Streamlit Bundle Modal */}
      {showPythonModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className="dyno-card flex max-h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-sm border shadow-2xl">
            <div className="flex items-center justify-between border-b dyno-border px-5 py-3">
              <div>
                <h3 className="text-sm font-semibold dyno-text-primary">Python / Streamlit 本地工程源码包 (V2.0)</h3>
                <p className="text-xs dyno-text-muted">
                  含 requirements.txt、motor_physics.py、dyno_calibrator.py、thermal_exporter.py、dynamic_pmsm.py、app.py
                </p>
              </div>
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    void downloadPythonBundleZip();
                    showToast('已开始下载 bldc_foc_dyno_v2_python.zip');
                  }}
                  className="dyno-btn-primary inline-flex items-center gap-1.5 rounded-sm px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap cursor-pointer"
                >
                  <Download className="h-3.5 w-3.5" />
                  一键打包下载 .zip
                </button>
                <button
                  type="button"
                  onClick={() => setShowPythonModal(false)}
                  className="dyno-btn-ghost rounded-sm border p-1.5 cursor-pointer"
                  aria-label="关闭 Python 源码弹窗"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="flex flex-1 overflow-hidden">
              <div className="dyno-panel w-52 shrink-0 space-y-1 border-r p-2">
                {PYTHON_BUNDLE_FILES.map((f) => (
                  <button
                    key={f.name}
                    type="button"
                    onClick={() => setSelectedPyFile(f.name)}
                    className={`w-full rounded-xs px-3 py-1.5 text-left font-mono text-xs transition-colors cursor-pointer ${
                      selectedPyFile === f.name ? 'dyno-seg-active' : 'dyno-text-secondary hover:dyno-text-primary'
                    }`}
                  >
                    {f.name}
                  </button>
                ))}
              </div>
              <pre className="dyno-well flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed dyno-text-secondary">
                {activePyContent}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
