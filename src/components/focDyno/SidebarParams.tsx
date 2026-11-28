import React, { useState } from 'react';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { MotorParams, calcLqH, calcRsAnchorOhm, getEffectiveRsOhm } from '../../modules/focDyno/motorPhysics';
import { SmoothNumberInput } from './SmoothNumberInput';

interface SidebarParamsProps {
  params: MotorParams;
  onChange: (next: MotorParams) => void;
  onResetDemoParams: () => void;
}

const SectionHeader: React.FC<{
  title: string;
  open: boolean;
  onToggle: () => void;
}> = ({ title, open, onToggle }) => (
  <button
    type="button"
    onClick={onToggle}
    aria-expanded={open}
    className="flex w-full items-center justify-between py-2 text-left text-xs font-semibold tracking-wide dyno-text-secondary hover:dyno-accent-text transition-colors cursor-pointer"
  >
    <span>{title}</span>
    {open ? <ChevronDown className="h-3.5 w-3.5 opacity-70" /> : <ChevronRight className="h-3.5 w-3.5 opacity-70" />}
  </button>
);

const NumberField: React.FC<{
  label: string;
  unit?: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  precision?: number;
  onChange: (v: number) => void;
}> = ({ label, unit, value, step = 0.01, min, max, precision, onChange }) => (
  <label className="flex items-center justify-between gap-2 py-1 text-xs">
    <span className="truncate dyno-text-secondary" title={label}>
      {label}
      {unit && <span className="ml-1 font-mono text-[10px] dyno-text-muted">({unit})</span>}
    </span>
    <SmoothNumberInput
      value={value}
      step={step}
      min={min}
      max={max}
      precision={precision}
      onChange={onChange}
      ariaLabel={label}
      className="dyno-input w-24 shrink-0 rounded-sm border px-2 py-1 text-right font-mono text-xs tabular-nums focus:outline-none"
    />
  </label>
);

export const SidebarParams: React.FC<SidebarParamsProps> = ({
  params,
  onChange,
  onResetDemoParams,
}) => {
  const [openSec, setOpenSec] = useState({
    motor: true,
    calib: true,
    inv: true,
    drop: true,
  });

  const rsAnchor = calcRsAnchorOhm(params.rLL25Ohm, params.tCoilC);
  const rsEff = getEffectiveRsOhm(params);
  const lqMh = calcLqH(params.lLLmH) * 1e3;

  const update = (patch: Partial<MotorParams>) => onChange({ ...params, ...patch });

  return (
    <aside className="dyno-panel w-full shrink-0 border-b lg:w-80 lg:border-b-0 lg:border-r lg:overflow-y-auto">
      <div className="border-b dyno-border px-3 py-2.5 space-y-2">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold tracking-wide dyno-text-primary">电机与驱动物理基准</h2>
          <p className="text-[11px] dyno-text-muted">等幅值变换 · 国际单位制 (SI)</p>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          <button
            type="button"
            onClick={() => update({
              iIdleA: 0,
              etaInv: 1,
              iDeadbandA: 0,
              rLineOhm: 0,
              rdsOnMOhm: 0,
              tDeadNs: 0,
              vSdV: 0,
            })}
            title="理想驱动基线：关闭逆变效率、线束、静态电流、MOS 压降与死区修正。用于隔离电机模型，不代表真实驱动器。"
            className="dyno-btn-ghost rounded-sm border px-2 py-1 text-[11px] font-medium whitespace-nowrap cursor-pointer text-center"
          >
            理想基线
          </button>
          <button
            type="button"
            onClick={() => update({
              iIdleA: 0.06,
              etaInv: 0.95,
              iDeadbandA: 0.02,
              rLineOhm: 0.04,
              tDeadNs: 450,
              fSwKhz: 20,
              vSdV: 0.85,
            })}
            title="仅供 12–24V 演示计算的示例假设，不是低压 BLDC 通用推荐值；须按实际驱动器、线束与波形复核。"
            className="dyno-btn-ghost rounded-sm border px-2 py-1 text-[11px] font-medium whitespace-nowrap cursor-pointer text-center"
          >
            演示假设
          </button>
          <button
            type="button"
            onClick={onResetDemoParams}
            title="恢复 13.5V 演示电机与驱动假设，不代表目标电机实测值"
            className="dyno-btn-ghost inline-flex items-center justify-center gap-1 rounded-sm border px-2 py-1 text-[11px] font-medium whitespace-nowrap cursor-pointer"
          >
            <RotateCcw className="h-3 w-3 shrink-0" />
            演示默认
          </button>
        </div>
      </div>

      <div className="px-4 pt-2.5 text-[10px] leading-relaxed dyno-text-muted">
        必要基准：极对数、Ke、R_LL、L_LL 和绕组温度应来自目标电机/测量。未辨识的 β、P0(a/b) 可设为 0 关闭对应修正；驱动器选填项设为中性值（0 或 η_inv=1）即关闭对应压降。
      </div>
      <div className="divide-y dyno-divide px-4 py-2">
        {/* 1. Motor Nameplate & Winding */}
        <div className="py-1.5">
          <SectionHeader
            title="电机铭牌与绕组基准"
            open={openSec.motor}
            onToggle={() => setOpenSec((s) => ({ ...s, motor: !s.motor }))}
          />
          {openSec.motor && (
            <div className="space-y-0.5 pb-2">
              <NumberField
                label="极对数 p"
                value={params.polePairs}
                step={1}
                min={1}
                max={40}
                precision={0}
                onChange={(v) => update({ polePairs: Math.max(1, Math.round(v)) })}
              />
              <NumberField
                label="空载反电势 Ke'"
                unit="Vp/(rad/s)"
                value={params.kePrime}
                step={0.0005}
                min={0.0001}
                precision={5}
                onChange={(v) => update({ kePrime: Math.max(1e-5, v) })}
              />
              <NumberField
                label="25°C 线电阻 R_LL"
                unit="Ω"
                value={params.rLL25Ohm}
                step={0.01}
                min={0.001}
                precision={3}
                onChange={(v) => update({ rLL25Ohm: Math.max(1e-4, v) })}
              />
              <NumberField
                label="绕组温度 T_coil"
                unit="°C"
                value={params.tCoilC}
                step={1}
                min={-40}
                max={200}
                precision={1}
                onChange={(v) => update({ tCoilC: v })}
              />
              <NumberField
                label="线电感 L_LL（电机专属；0 会使电压裕量偏乐观）"
                unit="mH"
                value={params.lLLmH}
                step={0.01}
                min={0}
                precision={3}
                onChange={(v) => update({ lLLmH: Math.max(0, v) })}
              />
              <div className="dyno-well mt-2 flex items-center justify-between rounded-sm border px-2.5 py-1.5 font-mono text-[10px] tabular-nums dyno-text-muted">
                <span>Rs_anchor: {rsAnchor.toFixed(4)} Ω</span>
                <span>Lq≈L_LL/2: {lqMh.toFixed(3)} mH</span>
              </div>
              <p className="px-1 pb-1 text-[10px] leading-relaxed dyno-text-muted">模型边界：Rs 温度修正固定按铜绕组 0.00393/°C 近似；T_coil 应是绕组温度，不是壳温。Lq=L_LL/2 是非凸极/简化换算，不包含独立 Ld、凸极效应及交叉饱和；IPMSM、弱磁或高电流工况应导入实测 Ld/Lq/磁链图，不能把本值当作完整电机磁模型。</p>
            </div>
          )}
        </div>

        {/* 2. Calibrated Saturation & Speed-Dependent Loss */}
        <div className="py-1.5">
          <SectionHeader
            title="标定参数（随速空载损 / 饱和）"
            open={openSec.calib}
            onToggle={() => setOpenSec((s) => ({ ...s, calib: !s.calib }))}
          />
          {openSec.calib && (
            <div className="space-y-0.5 pb-2">
              <NumberField
                label="参考空载转速 n0"
                unit="RPM"
                value={params.n0Rpm}
                step={50}
                min={50}
                precision={0}
                onChange={(v) => update({ n0Rpm: Math.max(10, v) })}
              />
              <NumberField
                label="磁饱和系数 β（0=不计饱和修正）"
                unit="1/A²"
                value={params.betaSat}
                step={0.0005}
                min={0}
                precision={5}
                onChange={(v) => update({ betaSat: Math.max(0, v) })}
              />
              <NumberField
                label="随速损一次项 a（0=不计该损耗项）"
                unit="W/RPM"
                value={params.p0A}
                step={0.00005}
                min={0}
                precision={6}
                onChange={(v) => update({ p0A: Math.max(0, v) })}
              />
              <NumberField
                label="随速损二次项 b（0=不计该损耗项）"
                unit="W/RPM²"
                value={params.p0B}
                step={1e-7}
                min={0}
                precision={8}
                onChange={(v) => update({ p0B: Math.max(0, v) })}
              />
              <div className="dyno-well mt-2 flex items-center justify-between rounded-sm border px-2.5 py-1.5 font-mono text-[10px] tabular-nums">
                <span className="dyno-text-muted">当前 Rs_eff</span>
                <span className="font-semibold dyno-accent-text">
                  {rsEff.toFixed(4)} Ω {params.rsEffOverrideOhm ? '(±15% 微调)' : '(锁定基准)'}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* 3. Inverter & Harness */}
        <div className="py-1.5">
          <SectionHeader
            title="驱动器与母线线损"
            open={openSec.inv}
            onToggle={() => setOpenSec((s) => ({ ...s, inv: !s.inv }))}
          />
          {openSec.inv && (
            <div className="space-y-0.5 pb-2">
              <NumberField
                label="静态偏置 I_idle（选填）"
                unit="A"
                value={params.iIdleA}
                step={0.005}
                min={0}
                precision={3}
                onChange={(v) => update({ iIdleA: Math.max(0, v) })}
              />
              <NumberField
                label="逆变器级效率 η_inv（选填，0<η≤1；1=不修正）"
                value={params.etaInv}
                step={0.005}
                min={0.001}
                max={1}
                precision={3}
                onChange={(v) => update({ etaInv: Math.min(1, Math.max(0.001, v)) })}
              />
              <NumberField
                label="零漂死区 I_deadband（选填）"
                unit="A"
                value={params.iDeadbandA}
                step={0.005}
                min={0}
                precision={3}
                onChange={(v) => update({ iDeadbandA: Math.max(0, v) })}
              />
              <NumberField
                label="线束内阻 R_line（选填）"
                unit="Ω"
                value={params.rLineOhm}
                step={0.005}
                min={0}
                precision={3}
                onChange={(v) => update({ rLineOhm: Math.max(0, v) })}
              />
            </div>
          )}
        </div>

        {/* 4. Vq_cmd Dead-time & MOSFET Drop */}
        <div className="py-1.5">
          <SectionHeader
            title="Vq_cmd 管压降与死区"
            open={openSec.drop}
            onToggle={() => setOpenSec((s) => ({ ...s, drop: !s.drop }))}
          />
          {openSec.drop && (
            <div className="space-y-0.5 pb-2">
              <NumberField
                label="MOSFET Rds(on)（选填）"
                unit="mΩ"
                value={params.rdsOnMOhm}
                step={0.5}
                min={0}
                precision={1}
                onChange={(v) => update({ rdsOnMOhm: Math.max(0, v) })}
              />
              <NumberField
                label="死区时间 t_dead（选填）"
                unit="ns"
                value={params.tDeadNs}
                step={10}
                min={0}
                precision={0}
                onChange={(v) => update({ tDeadNs: Math.max(0, v) })}
              />
              <NumberField
                label="PWM 载波 f_sw（t_dead>0 时必需）"
                unit="kHz"
                value={params.fSwKhz}
                step={1}
                min={0}
                precision={1}
                onChange={(v) => update({ fSwKhz: Math.max(0, v) })}
              />
              <NumberField
                label="体二极管压降 V_sd（选填）"
                unit="V"
                value={params.vSdV}
                step={0.05}
                min={0}
                precision={2}
                onChange={(v) => update({ vSdV: Math.max(0, v) })}
              />
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};
