import React, { useMemo, useState } from 'react';
import { Activity, AlertTriangle, Download, FileJson, Play, Trash2 } from 'lucide-react';
import {
  DynamicControlMode,
  DynamicPmsmParams,
  DynamicScenarioStep,
  type PmsmFluxMap,
  buildDynamicPmsmCsv,
  buildDynamicPmsmScopeTab,
  buildDynamicPresetScenario,
  createPmsmFluxMapImportTemplate,
  parsePmsmFluxMapJson,
  kePrimeToPsiF,
  simulateDynamicPmsm,
} from '../../modules/focDyno/dynamicPmsm';
import { MotorParams, getEffectiveRsOhm } from '../../modules/focDyno/motorPhysics';
import { TabState } from '../../types/models';
import { SmoothNumberInput } from './SmoothNumberInput';

interface Tab4DynamicPmsmProps {
  baseParams: MotorParams;
  onSendTabToScope: (tab: TabState) => void;
  onNotify: (msg: string) => void;
}

export const Tab4DynamicPmsm: React.FC<Tab4DynamicPmsmProps> = ({
  baseParams,
  onSendTabToScope,
  onNotify,
}) => {
  const [ldMh, setLdMh] = useState<number>(() => Math.max(0.02, baseParams.lLLmH * 0.5));
  const [lqMh, setLqMh] = useState<number>(() => Math.max(0.02, baseParams.lLLmH * 0.5));
  const [jKgM2, setJKgM2] = useState<number>(6.5e-5);
  const [bVisc, setBVisc] = useState<number>(8e-5);
  const [tCoulomb, setTCoulomb] = useState<number>(0.004);
  const [vBusV, setVBusV] = useState<number>(24);
  const [iMaxA, setIMaxA] = useState<number>(15);
  const [controlMode, setControlMode] = useState<DynamicControlMode>('mtpa_current_loop');
  const [durationSec, setDurationSec] = useState<number>(0.3);
  const [scenario, setScenario] = useState<DynamicScenarioStep[]>(() => buildDynamicPresetScenario('startup_load_step').config.scenario);
  const [fluxMap, setFluxMap] = useState<PmsmFluxMap | undefined>(undefined);
  const [fluxMapFileName, setFluxMapFileName] = useState<string>('');
  const [windingTempC, setWindingTempC] = useState<number>(25);
  const [magnetTempC, setMagnetTempC] = useState<number>(25);
  const [rsTempCoeffPpmPerC, setRsTempCoeffPpmPerC] = useState<number>(3930);
  const [psiTempCoeffPpmPerC, setPsiTempCoeffPpmPerC] = useState<number>(0);

  const handleFluxMapFile = async (file?: File) => {
    if (!file) return;
    try {
      const parsed = parsePmsmFluxMapJson(await file.text());
      setFluxMap(parsed);
      setFluxMapFileName(file.name);
      if (parsed.referenceTemperatureC !== undefined) setMagnetTempC(parsed.referenceTemperatureC);
      onNotify(`已导入 PMSM 非线性磁链 Map：${file.name}`);
    } catch (err) {
      setFluxMap(undefined);
      setFluxMapFileName('');
      onNotify(`磁链 Map 导入失败，已清除旧 Map 防止误用：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const downloadFluxMapTemplate = () => {
    const blob = new Blob([JSON.stringify(createPmsmFluxMapImportTemplate(), null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'pmsm-flux-map-template.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  const dynParams: DynamicPmsmParams = useMemo(
    () => ({
      polePairs: baseParams.polePairs,
      rsOhm: getEffectiveRsOhm(baseParams),
      ldH: Math.max(1e-6, ldMh * 1e-3),
      lqH: Math.max(1e-6, lqMh * 1e-3),
      psiFVs: kePrimeToPsiF(baseParams.kePrime, baseParams.polePairs),
      jKgM2: Math.max(1e-7, jKgM2),
      bNmSPerRad: Math.max(0, bVisc),
      tCoulombNm: Math.max(0, tCoulomb),
      vBusV: Math.max(2, vBusV),
      iMaxA: Math.max(0.5, iMaxA),
      controlMode,
      fluxMap,
      windingTempC,
      magnetTempC,
      referenceTempC: 25,
      rsTempCoeffPerC: rsTempCoeffPpmPerC * 1e-6,
      psiTempCoeffPerC: fluxMap ? 0 : psiTempCoeffPpmPerC * 1e-6,
    }),
    [baseParams, ldMh, lqMh, jKgM2, bVisc, tCoulomb, vBusV, iMaxA, controlMode, fluxMap, windingTempC, magnetTempC, rsTempCoeffPpmPerC, psiTempCoeffPpmPerC]
  );

  const simulation = useMemo(() => {
    try {
      return {
        result: simulateDynamicPmsm(dynParams, {
          durationSec,
          dtOutSec: Math.max(1e-4, durationSec / 800),
          initialSpeedRpm: 0,
          scenario,
        }),
        error: '',
      };
    } catch (err) {
      return { result: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [dynParams, durationSec, scenario]);
  const simResult = simulation.result;

  const applyPreset = (preset: 'startup_load_step' | 'four_quadrant_regen' | 'ipm_mtpa_fw') => {
    const p = buildDynamicPresetScenario(preset);
    if (p.paramsPatch.ldH !== undefined) setLdMh(p.paramsPatch.ldH * 1e3);
    if (p.paramsPatch.lqH !== undefined) setLqMh(p.paramsPatch.lqH * 1e3);
    if (p.paramsPatch.jKgM2 !== undefined) setJKgM2(p.paramsPatch.jKgM2);
    if (p.paramsPatch.bNmSPerRad !== undefined) setBVisc(p.paramsPatch.bNmSPerRad);
    if (p.paramsPatch.tCoulombNm !== undefined) setTCoulomb(p.paramsPatch.tCoulombNm);
    if (p.paramsPatch.vBusV !== undefined) setVBusV(p.paramsPatch.vBusV);
    if (p.paramsPatch.iMaxA !== undefined) setIMaxA(p.paramsPatch.iMaxA);
    if (p.paramsPatch.controlMode !== undefined) setControlMode(p.paramsPatch.controlMode);
    setDurationSec(p.config.durationSec);
    setScenario(p.config.scenario);
    onNotify(`已载入动态场景预设: ${preset}`);
  };

  const chartPaths = useMemo(() => {
    const w = 780;
    const h = 210;
    if (!simResult) return { w, h, pathSpeed: '', pathId: '', pathIq: '', pathTe: '', pathTload: '' };
    const padL = 46;
    const padR = 16;
    const padT = 14;
    const padB = 22;
    const n = simResult.time.length;
    const tMax = Math.max(1e-6, simResult.time[n - 1] ?? 1);
    const buildPath = (arr: Float64Array, minVal: number, maxVal: number) => {
      const span = Math.max(1e-6, maxVal - minVal);
      const pts: string[] = [];
      const stride = Math.max(1, Math.floor(n / 260));
      for (let i = 0; i < n; i += stride) {
        const x = padL + ((simResult.time[i] / tMax) * (w - padL - padR));
        const y = h - padB - (((arr[i] - minVal) / span) * (h - padT - padB));
        pts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
      }
      return pts.join(' ');
    };
    const minN = Math.min(0, simResult.minSpeedRpm);
    const maxN = Math.max(100, simResult.peakSpeedRpm);
    const iBound = Math.max(1, simResult.peakAbsCurrentA);
    const tBound = Math.max(0.05, simResult.peakAbsTorqueNm);
    return {
      w,
      h,
      pathSpeed: buildPath(simResult.nRpm, minN, maxN),
      pathId: buildPath(simResult.idA, -iBound, iBound),
      pathIq: buildPath(simResult.iqA, -iBound, iBound),
      pathTe: buildPath(simResult.teNm, -tBound, tBound),
      pathTload: buildPath(simResult.tLoadNm, -tBound, tBound),
    };
  }, [simResult]);

  const handleDownloadCsv = () => {
    if (!simResult) return;
    const csv = buildDynamicPmsmCsv(simResult);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dynamic_pmsm_dq_SYNTHETIC_UNCALIBRATED.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 500);
    onNotify('已导出动态 dq 仿真 CSV（含 synthetic_assumed_uncalibrated 来源标记）');
  };

  return (
    <div className="space-y-4">
      <div className="dyno-alert-warn flex flex-wrap items-center justify-between gap-2 rounded-sm border px-4 py-2.5 text-xs">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            <strong>合成假设动态模型 (synthetic_assumed_uncalibrated)</strong> · 本模块采用独立的 dq 轴微分方程 (RK4)，严格隔离于 Tab 1 稳态测功标定器与实测波形。
          </span>
        </div>
        <span className="font-mono text-[11px]">
          {simResult ? `h_rk4=${(simResult.dtInternalSec * 1e6).toFixed(1)} µs · substeps=${simResult.substepsPerOutput}` : '仿真未执行'}
        </span>
      </div>

      {simulation.error && <div className="rounded-sm border border-red-500/50 bg-red-500/10 px-3 py-2 text-xs text-red-300"><strong>动态 PMSM 仿真被阻止：</strong>{simulation.error}</div>}

      {/* Controls & Scenario Presets */}
      <div className="dyno-card rounded-sm border p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold dyno-text-primary flex items-center gap-2">
            <Activity className="h-4 w-4 dyno-accent-text" />
            独立动态 PMSM dq 瞬态仿真器 (MTPA / 弱磁 / 四象限限幅)
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => applyPreset('startup_load_step')} className="dyno-btn-ghost rounded-sm border px-2.5 py-1 text-xs cursor-pointer">
              启动 + 阶跃负载
            </button>
            <button type="button" onClick={() => applyPreset('four_quadrant_regen')} className="dyno-btn-ghost rounded-sm border px-2.5 py-1 text-xs cursor-pointer">
              四象限反转制动
            </button>
            <button type="button" onClick={() => applyPreset('ipm_mtpa_fw')} className="dyno-btn-ghost rounded-sm border px-2.5 py-1 text-xs cursor-pointer">
              IPM MTPA + 高速弱磁
            </button>
          </div>
        </div>

        <div className="rounded-sm border dyno-border p-3 space-y-2 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="font-semibold dyno-text-primary">非线性磁链 Map（可选）</div>
              <div className="dyno-text-muted">导入 ψd(Id,Iq)、ψq(Id,Iq) 网格；超出电流范围时仿真会拒绝外推。</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <label className="dyno-btn-ghost inline-flex cursor-pointer items-center gap-1 rounded-sm border px-2.5 py-1.5">
                <FileJson className="h-3.5 w-3.5" /> 导入 JSON
                <input type="file" accept=".json,application/json" className="hidden" onChange={(e) => { void handleFluxMapFile(e.target.files?.[0]); e.currentTarget.value = ''; }} />
              </label>
              <button type="button" onClick={downloadFluxMapTemplate} className="dyno-btn-ghost rounded-sm border px-2.5 py-1.5">下载模板</button>
              {fluxMap && <button type="button" onClick={() => { setFluxMap(undefined); setFluxMapFileName(''); }} className="dyno-btn-ghost inline-flex items-center gap-1 rounded-sm border px-2.5 py-1.5"><Trash2 className="h-3.5 w-3.5" />移除 Map</button>}
            </div>
          </div>
          {fluxMap ? (
            <div className="font-mono dyno-text-secondary">{fluxMapFileName} · {fluxMap.idAxisA.length}×{fluxMap.iqAxisA.length} 网格 · {fluxMap.provenance} · Id [{fluxMap.idAxisA[0]}, {fluxMap.idAxisA[fluxMap.idAxisA.length - 1]}] A · Iq [{fluxMap.iqAxisA[0]}, {fluxMap.iqAxisA[fluxMap.iqAxisA.length - 1]}] A · 参考温度 {fluxMap.referenceTemperatureC ?? '未指定'}°C</div>
          ) : <div className="dyno-text-muted">未导入时使用线性 ψd=ψf+Ld·Id、ψq=Lq·Iq 参数模型。模板中的数值仅用于验证导入流程，不是实际电机数据。</div>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label className="block"><span className="mb-1 block text-[11px] dyno-text-muted">绕组温度 (°C)</span><SmoothNumberInput value={windingTempC} step={5} precision={1} onChange={setWindingTempC} className="dyno-input w-full rounded-sm border px-2 py-1 font-mono text-xs" /></label>
            <label className="block"><span className="mb-1 block text-[11px] dyno-text-muted">Rs 温度系数 (ppm/°C)</span><SmoothNumberInput value={rsTempCoeffPpmPerC} min={0} step={100} precision={0} onChange={setRsTempCoeffPpmPerC} className="dyno-input w-full rounded-sm border px-2 py-1 font-mono text-xs" /></label>
            <label className="block"><span className="mb-1 block text-[11px] dyno-text-muted">磁体温度 (°C)</span><SmoothNumberInput value={magnetTempC} step={5} precision={1} onChange={setMagnetTempC} className="dyno-input w-full rounded-sm border px-2 py-1 font-mono text-xs" /></label>
            <label className="block"><span className="mb-1 block text-[11px] dyno-text-muted">ψf 温度系数 (ppm/°C，线性模型)</span><SmoothNumberInput value={psiTempCoeffPpmPerC} step={100} precision={0} onChange={setPsiTempCoeffPpmPerC} disabled={!!fluxMap} className="dyno-input w-full rounded-sm border px-2 py-1 font-mono text-xs disabled:opacity-40" /></label>
          </div>
          <div className="dyno-text-muted">3930 ppm/°C 仅为铜绕组常用起始假设，可按实际导线材料修正；非线性磁链 Map 温度不匹配时拒绝运行，不做温度外推。</div>
          {fluxMap && Math.abs(magnetTempC - (fluxMap.referenceTemperatureC ?? magnetTempC)) > 1e-6 && <div className="text-amber-500">磁体温度与 Map 参考温度不一致；当前单温度 Map 不支持温度外推，运行会被拒绝。</div>}
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8 text-xs">
          <label className="block">
            <span className="mb-1 block text-[11px] dyno-text-muted">d轴电感 Ld (mH)</span>
            <SmoothNumberInput value={ldMh} min={0.005} step={0.02} precision={3} onChange={setLdMh} className="dyno-input w-full rounded-sm border px-2 py-1 font-mono text-xs" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] dyno-text-muted">q轴电感 Lq (mH)</span>
            <SmoothNumberInput value={lqMh} min={0.005} step={0.02} precision={3} onChange={setLqMh} className="dyno-input w-full rounded-sm border px-2 py-1 font-mono text-xs" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] dyno-text-muted">转动惯量 J (kg·m²)</span>
            <SmoothNumberInput value={jKgM2} min={1e-6} step={1e-5} precision={6} onChange={setJKgM2} className="dyno-input w-full rounded-sm border px-2 py-1 font-mono text-xs" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] dyno-text-muted">阻尼 B (N·m·s/rad)</span>
            <SmoothNumberInput value={bVisc} min={0} step={1e-5} precision={6} onChange={setBVisc} className="dyno-input w-full rounded-sm border px-2 py-1 font-mono text-xs" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] dyno-text-muted">母线 Vbus (V)</span>
            <SmoothNumberInput value={vBusV} min={2} step={1} precision={1} onChange={setVBusV} className="dyno-input w-full rounded-sm border px-2 py-1 font-mono text-xs" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] dyno-text-muted">电流上限 Imax (A)</span>
            <SmoothNumberInput value={iMaxA} min={0.5} step={1} precision={1} onChange={setIMaxA} className="dyno-input w-full rounded-sm border px-2 py-1 font-mono text-xs" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] dyno-text-muted">控制律</span>
            <select
              value={controlMode}
              onChange={(e) => setControlMode(e.target.value as DynamicControlMode)}
              className="dyno-input w-full rounded-sm border px-2 py-1 text-xs"
            >
              <option value="mtpa_current_loop">MTPA + 弱磁闭环</option>
              <option value="id_zero">Id = 0 闭环</option>
              <option value="open_loop_vdq">开环 Vd/Vq</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] dyno-text-muted">总时长 (s)</span>
            <SmoothNumberInput value={durationSec} min={0.02} max={5} step={0.05} precision={2} onChange={setDurationSec} className="dyno-input w-full rounded-sm border px-2 py-1 font-mono text-xs" />
          </label>
        </div>

        {/* Scenario Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left font-mono text-[11px]">
            <thead>
              <tr className="border-b dyno-border dyno-text-muted">
                <th className="py-1 pr-2">分段</th>
                <th className="py-1 pr-2">t_start (s)</th>
                <th className="py-1 pr-2">t_end (s)</th>
                <th className="py-1 pr-2">负载 T_load (N·m)</th>
                <th className="py-1 pr-2">目标转速 speed_ref (RPM)</th>
              </tr>
            </thead>
            <tbody className="divide-y dyno-divide">
              {scenario.map((step, idx) => (
                <tr key={idx}>
                  <td className="py-1 pr-2 dyno-text-muted">#{idx + 1}</td>
                  <td className="py-1 pr-2">{step.tStartSec.toFixed(3)}</td>
                  <td className="py-1 pr-2">{step.tEndSec.toFixed(3)}</td>
                  <td className="py-1 pr-2">
                    <SmoothNumberInput
                      value={step.tLoadNm}
                      step={0.02}
                      precision={3}
                      onChange={(val) =>
                        setScenario((prev) => prev.map((s, i) => (i === idx ? { ...s, tLoadNm: val } : s)))
                      }
                      className="dyno-input w-24 rounded-sm border px-2 py-0.5 text-xs"
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <SmoothNumberInput
                      value={step.speedRefRpm ?? 0}
                      step={100}
                      precision={0}
                      onChange={(val) =>
                        setScenario((prev) => prev.map((s, i) => (i === idx ? { ...s, speedRefRpm: val } : s)))
                      }
                      className="dyno-input w-28 rounded-sm border px-2 py-0.5 text-xs"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t dyno-border pt-3">
          <div className="flex flex-wrap gap-4 font-mono text-[11px] dyno-text-secondary">
            <span>转速范围: <strong className="dyno-text-primary">{simResult ? `${simResult.minSpeedRpm.toFixed(0)}~${simResult.peakSpeedRpm.toFixed(0)} RPM` : '--'}</strong></span>
            <span>峰值相电流: <strong className="dyno-text-primary">{simResult ? `${simResult.peakAbsCurrentA.toFixed(2)} A` : '--'}</strong></span>
            <span>峰值扭矩: <strong className="dyno-text-primary">{simResult ? `${simResult.peakAbsTorqueNm.toFixed(4)} N·m` : '--'}</strong></span>
            <span>电压圆限幅: <strong className="dyno-text-primary">{simResult ? `${simResult.voltageLimitHits} 点` : '--'}</strong></span>
            <span>磁链模型: <strong className="dyno-text-primary">{simResult?.fluxMapProvenance ?? '--'}</strong></span>
            <span>最大电气功率平衡残差: <strong className="dyno-text-primary">{simResult ? Math.max(...Array.from(simResult.pElectricalBalanceResidualW, v => Math.abs(v))).toExponential(2) : '--'} W</strong></span>
            <span>最大机械功率平衡残差: <strong className="dyno-text-primary">{simResult ? Math.max(...Array.from(simResult.pMechanicalBalanceResidualW, v => Math.abs(v))).toExponential(2) : '--'} W</strong></span>
            <span>稳态代数核验 ΔTe: <strong className="dyno-text-primary">{simResult ? `${simResult.steadyCheck.torqueDiffNm.toExponential(2)} N·m` : '--'}</strong></span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!simResult}
              onClick={() => {
                if (!simResult) return;
                const tab = buildDynamicPmsmScopeTab(simResult);
                if (tab) {
                  onSendTabToScope(tab);
                  onNotify('已推送动态 dq 合成波形到主示波器（标记 synthetic_assumed_uncalibrated）');
                }
              }}
              className="dyno-btn-primary inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-semibold cursor-pointer disabled:opacity-40"
            >
              <Play className="h-3.5 w-3.5" />
              推送到示波器
            </button>
            <button
              type="button"
              onClick={handleDownloadCsv}
              disabled={!simResult}
              className="dyno-btn-ghost inline-flex items-center gap-1.5 rounded-sm border px-3 py-1.5 text-xs cursor-pointer disabled:opacity-40"
            >
              <Download className="h-3.5 w-3.5" />
              导出 CSV
            </button>
          </div>
        </div>
      </div>

      {/* Transient Plot */}
      {simResult && <div className="dyno-card rounded-sm border p-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="font-semibold dyno-text-primary">瞬态响应波形 (n_rpm / Id / Iq / Te / T_load)</span>
          <div className="flex flex-wrap items-center gap-3 font-mono text-[11px]">
            <span className="text-violet-400">— n (RPM)</span>
            <span className="text-sky-400">— Id (A)</span>
            <span className="text-pink-400">— Iq (A)</span>
            <span className="text-orange-400">— Te (N·m)</span>
            <span className="text-slate-400">- - T_load (N·m)</span>
          </div>
        </div>
        <svg viewBox={`0 0 ${chartPaths.w} ${chartPaths.h}`} className="w-full h-56 rounded-xs bg-slate-950/60 border border-slate-800">
          <path d={chartPaths.pathSpeed} fill="none" stroke="#a78bfa" strokeWidth="1.8" />
          <path d={chartPaths.pathId} fill="none" stroke="#60a5fa" strokeWidth="1.5" />
          <path d={chartPaths.pathIq} fill="none" stroke="#f472b6" strokeWidth="1.6" />
          <path d={chartPaths.pathTe} fill="none" stroke="#fb923c" strokeWidth="1.6" />
          <path d={chartPaths.pathTload} fill="none" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="4 3" />
        </svg>
      </div>}
    </div>
  );
};
