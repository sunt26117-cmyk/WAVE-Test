import React, { useState } from 'react';
import { EfficiencyGrid2D, EvaluatedDynoPoint } from '../../modules/focDyno/dynoCalibrator';
import { SVPWM_LINEAR_LIMIT } from '../../modules/focDyno/motorPhysics';

const VIRIDIS_STOPS: Array<[number, [number, number, number]]> = [
  [0.0, [49, 46, 129]],
  [0.25, [14, 116, 144]],
  [0.5, [2, 132, 199]],
  [0.75, [16, 185, 129]],
  [0.9, [245, 158, 11]],
  [1.0, [250, 204, 21]],
];

function sampleColor(norm: number): string {
  const t = Math.max(0, Math.min(1, norm));
  for (let i = 0; i < VIRIDIS_STOPS.length - 1; i++) {
    const [t0, c0] = VIRIDIS_STOPS[i];
    const [t1, c1] = VIRIDIS_STOPS[i + 1];
    if (t >= t0 && t <= t1) {
      const f = (t - t0) / Math.max(1e-6, t1 - t0);
      const r = Math.round(c0[0] + f * (c1[0] - c0[0]));
      const g = Math.round(c0[1] + f * (c1[1] - c0[1]));
      const b = Math.round(c0[2] + f * (c1[2] - c0[2]));
      return `rgb(${r}, ${g}, ${b})`;
    }
  }
  return 'rgb(250, 204, 21)';
}

interface HeatmapProps {
  grid: EfficiencyGrid2D;
  points: EvaluatedDynoPoint[];
}

export const EfficiencyHeatmap2D: React.FC<HeatmapProps> = ({ grid, points }) => {
  const [hoverCell, setHoverCell] = useState<{
    i: number;
    j: number;
    speed: number;
    torque: number;
    etaM: number | null;
    etaP: number | null;
  } | null>(null);

  if (grid.speeds.length === 0 || grid.torques.length === 0) {
    return (
      <div className="dyno-card flex h-56 items-center justify-center rounded-sm border px-6 text-center text-xs dyno-text-muted">
        当前数据不足以构建二维效率 Map（需至少包含 4 个测点、≥2 个独立转速与 ≥2 个独立扭矩，单转速/单扭矩 1D 曲线自动跳过二维插值）。
      </div>
    );
  }

  const w = 460;
  const h = 290;
  const padL = 56;
  const padR = 16;
  const padT = 16;
  const padB = 42;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const nSpeed = grid.speeds.length;
  const nTorq = grid.torques.length;
  const cellW = plotW / nSpeed;
  const cellH = plotH / nTorq;

  const minN = grid.speeds[0];
  const maxN = grid.speeds[nSpeed - 1];
  const minT = grid.torques[0];
  const maxT = grid.torques[nTorq - 1];
  const spanEta = Math.max(1e-3, grid.maxEta - grid.minEta);
  const midEta = (grid.minEta + grid.maxEta) / 2;

  const renderSingleMap = (title: string, zMatrix: Array<Array<number | null>>) => (
    <div className="dyno-card rounded-sm border p-3.5">
      <div className="mb-2 flex items-center justify-between text-xs font-semibold dyno-text-primary">
        <span>{title}</span>
        <span className="font-mono text-[10px] font-normal dyno-text-muted">凸包插值边界安全模式</span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full cursor-crosshair select-none"
        onMouseLeave={() => setHoverCell(null)}
      >
        <rect
          x={padL}
          y={padT}
          width={plotW}
          height={plotH}
          rx={2}
          fill="var(--bg-well)"
          stroke="var(--border-subtle)"
        />

        {zMatrix.map((row, j) =>
          row.map((val, i) => {
            if (val === null) return null;
            const norm = (val - grid.minEta) / spanEta;
            const x = padL + i * cellW;
            const y = padT + (nTorq - 1 - j) * cellH;
            const isHovered = hoverCell?.i === i && hoverCell?.j === j;
            return (
              <rect
                key={`${i}-${j}`}
                x={x}
                y={y}
                width={cellW + 0.6}
                height={cellH + 0.6}
                fill={sampleColor(norm)}
                stroke={isHovered ? '#FFFFFF' : 'none'}
                strokeWidth={isHovered ? 1.4 : 0}
                onMouseEnter={() =>
                  setHoverCell({
                    i,
                    j,
                    speed: grid.speeds[i],
                    torque: grid.torques[j],
                    etaM: grid.zMeasured[j]?.[i] ?? null,
                    etaP: grid.zPredicted[j]?.[i] ?? null,
                  })
                }
              />
            );
          })
        )}

        {points.map((pt, idx) => {
          const cx = padL + ((pt.nRpm - minN) / Math.max(1e-6, maxN - minN)) * plotW;
          const cy = padT + plotH - ((pt.tNm - minT) / Math.max(1e-6, maxT - minT)) * plotH;
          return (
            <circle
              key={idx}
              cx={cx}
              cy={cy}
              r={2.2}
              fill="rgba(12,16,22,0.75)"
              stroke="rgba(255,255,255,0.88)"
              strokeWidth={0.8}
              className="pointer-events-none"
            />
          );
        })}

        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const x = padL + f * plotW;
          const val = minN + f * (maxN - minN);
          return (
            <g key={`x-${f}`}>
              <line x1={x} y1={padT + plotH} x2={x} y2={padT + plotH + 4} stroke="var(--border-strong)" />
              <text
                x={x}
                y={padT + plotH + 16}
                textAnchor="middle"
                fill="var(--text-muted)"
                className="font-mono text-[10px] tabular-nums"
              >
                {val.toFixed(0)}
              </text>
            </g>
          );
        })}
        <text x={padL + plotW / 2} y={h - 6} textAnchor="middle" fill="var(--text-muted)" className="text-[10px]">
          转速 n (RPM)
        </text>

        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const y = padT + plotH - f * plotH;
          const val = minT + f * (maxT - minT);
          return (
            <g key={`y-${f}`}>
              <line x1={padL - 4} y1={y} x2={padL} y2={y} stroke="var(--border-strong)" />
              <text
                x={padL - 7}
                y={y + 3}
                textAnchor="end"
                fill="var(--text-muted)"
                className="font-mono text-[10px] tabular-nums"
              >
                {val.toFixed(2)}
              </text>
            </g>
          );
        })}
        <text
          x={14}
          y={padT + plotH / 2}
          textAnchor="middle"
          transform={`rotate(-90 14 ${padT + plotH / 2})`}
          fill="var(--text-muted)"
          className="text-[10px]"
        >
          扭矩 T (N·m)
        </text>
      </svg>
    </div>
  );

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {renderSingleMap('实测效率 Map η_meas(n, T)', grid.zMeasured)}
        {renderSingleMap('模型重构效率 Map η_est(n, T)', grid.zPredicted)}
      </div>

      <div className="dyno-card flex flex-wrap items-center justify-between gap-4 rounded-sm border px-4 py-2 text-xs">
        <div className="flex items-center gap-2.5">
          <span className="dyno-text-muted">效率色标</span>
          <span className="font-mono tabular-nums dyno-text-secondary">{grid.minEta.toFixed(0)}%</span>
          <div
            className="h-2.5 w-44 rounded-xs border dyno-border"
            style={{
              background:
                'linear-gradient(90deg, rgb(49,46,129) 0%, rgb(14,116,144) 25%, rgb(2,132,199) 50%, rgb(16,185,129) 75%, rgb(245,158,11) 90%, rgb(250,204,21) 100%)',
            }}
          />
          <span className="font-mono tabular-nums dyno-text-muted">{midEta.toFixed(0)}%</span>
          <span className="font-mono tabular-nums dyno-text-secondary">{grid.maxEta.toFixed(0)}%</span>
        </div>
        <div className="font-mono text-xs tabular-nums dyno-text-secondary">
          {hoverCell ? (
            <span>
              n={hoverCell.speed.toFixed(0)} RPM · T={hoverCell.torque.toFixed(3)} N·m · 实测=
              <strong className="ml-1 dyno-accent-text">
                {hoverCell.etaM !== null ? `${hoverCell.etaM.toFixed(1)}%` : '--'}
              </strong>{' '}
              · 重构=
              <strong className="ml-1 text-amber-400">
                {hoverCell.etaP !== null ? `${hoverCell.etaP.toFixed(1)}%` : '--'}
              </strong>
            </span>
          ) : (
            <span className="dyno-text-muted">悬停热力图格点查看坐标与实测/预测效率（边界外保留留白）</span>
          )}
        </div>
      </div>
    </div>
  );
};

interface FitCompareProps {
  points: EvaluatedDynoPoint[];
}

export const DynoFitComparisonChart: React.FC<FitCompareProps> = ({ points }) => {
  const [metricView, setMetricView] = useState<'torque' | 'eta' | 'losses'>('torque');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (points.length === 0) return null;

  const w = 780;
  const h = 248;
  const padL = 56;
  const padR = 20;
  const padT = 18;
  const padB = 34;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const sorted = [...points].sort((a, b) => (a.nRpm !== b.nRpm ? a.nRpm - b.nRpm : a.tNm - b.tNm));

  const renderParityOrLine = (isTorque: boolean) => {
    const valsM = sorted.map((p) => (isTorque ? p.tNm : p.etaMeas * 100));
    const valsP = sorted.map((p) => (isTorque ? p.tEstNm : p.etaEst * 100));
    const maxV = Math.max(...valsM, ...valsP, isTorque ? 0.05 : 10) * 1.08;
    const minV = Math.min(0, ...valsM, ...valsP);
    const spanV = Math.max(1e-4, maxV - minV);

    const xOf = (idx: number) => padL + (idx / Math.max(1, sorted.length - 1)) * plotW;
    const yOf = (v: number) => padT + plotH - ((v - minV) / spanV) * plotH;

    const pathM = sorted.map((_, idx) => `${idx === 0 ? 'M' : 'L'}${xOf(idx).toFixed(1)},${yOf(valsM[idx]).toFixed(1)}`).join(' ');
    const pathP = sorted.map((_, idx) => `${idx === 0 ? 'M' : 'L'}${xOf(idx).toFixed(1)},${yOf(valsP[idx]).toFixed(1)}`).join(' ');

    return (
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full cursor-crosshair select-none" onMouseLeave={() => setHoverIdx(null)}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const y = padT + plotH - f * plotH;
          const v = minV + f * spanV;
          return (
            <g key={f}>
              <line x1={padL} y1={y} x2={padL + plotW} y2={y} stroke="var(--border-subtle)" strokeDasharray="3 3" />
              <text x={padL - 8} y={y + 3} textAnchor="end" fill="var(--text-muted)" className="font-mono text-[10px] tabular-nums">
                {isTorque ? v.toFixed(2) : v.toFixed(0)}
              </text>
            </g>
          );
        })}

        <path d={pathM} fill="none" stroke="var(--text-muted)" strokeWidth={1.6} strokeDasharray="4 3" />
        <path d={pathP} fill="none" stroke="var(--accent)" strokeWidth={2.2} />

        {sorted.map((pt, idx) => {
          const x = xOf(idx);
          const ym = yOf(valsM[idx]);
          const yp = yOf(valsP[idx]);
          return (
            <g key={idx}>
              <circle cx={x} cy={ym} r={2.5} fill="var(--text-muted)" />
              <circle cx={x} cy={yp} r={2.7} fill="var(--accent)" />
              <rect
                x={x - plotW / sorted.length / 2}
                y={padT}
                width={Math.max(8, plotW / sorted.length)}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHoverIdx(idx)}
              />
            </g>
          );
        })}

        {hoverIdx !== null && sorted[hoverIdx] && (
          <line x1={xOf(hoverIdx)} y1={padT} x2={xOf(hoverIdx)} y2={padT + plotH} stroke="#f59e0b" strokeWidth={1.1} strokeDasharray="2 2" />
        )}

        <text x={14} y={padT + plotH / 2} textAnchor="middle" transform={`rotate(-90 14 ${padT + plotH / 2})`} fill="var(--text-muted)" className="text-[10px]">
          {isTorque ? '轴扭矩 T (N·m)' : '系统效率 η (%)'}
        </text>
        <text x={padL + plotW / 2} y={h - 6} textAnchor="middle" fill="var(--text-muted)" className="text-[10px]">
          测功点编号（按转速 → 扭矩排序，虚线：实测值 · 实线：模型反算回代）
        </text>
      </svg>
    );
  };

  const renderLosses = () => {
    const totals = sorted.map((p) => p.pInvLossW + p.pCuLossW + p.pIronWindLossW);
    const maxLoss = Math.max(...totals, 1) * 1.12;
    const barW = Math.max(4, Math.min(20, (plotW / sorted.length) * 0.68));

    return (
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full cursor-crosshair select-none" onMouseLeave={() => setHoverIdx(null)}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const y = padT + plotH - f * plotH;
          const v = f * maxLoss;
          return (
            <g key={f}>
              <line x1={padL} y1={y} x2={padL + plotW} y2={y} stroke="var(--border-subtle)" strokeDasharray="3 3" />
              <text x={padL - 8} y={y + 3} textAnchor="end" fill="var(--text-muted)" className="font-mono text-[10px] tabular-nums">
                {v.toFixed(1)}
              </text>
            </g>
          );
        })}

        {sorted.map((p, idx) => {
          const cx = padL + ((idx + 0.5) / sorted.length) * plotW;
          const hInv = (p.pInvLossW / maxLoss) * plotH;
          const hCu = (p.pCuLossW / maxLoss) * plotH;
          const hFe = (p.pIronWindLossW / maxLoss) * plotH;
          const yInv = padT + plotH - hInv;
          const yCu = yInv - hCu;
          const yFe = yCu - hFe;

          return (
            <g key={idx} onMouseEnter={() => setHoverIdx(idx)}>
              <rect x={cx - barW / 2} y={yInv} width={barW} height={hInv} fill="var(--text-muted)" />
              <rect x={cx - barW / 2} y={yCu} width={barW} height={hCu} fill="var(--warn)" />
              <rect x={cx - barW / 2} y={yFe} width={barW} height={hFe} fill="var(--accent)" />
              <rect x={cx - plotW / sorted.length / 2} y={padT} width={plotW / sorted.length} height={plotH} fill="transparent" />
            </g>
          );
        })}

        <text x={14} y={padT + plotH / 2} textAnchor="middle" transform={`rotate(-90 14 ${padT + plotH / 2})`} fill="var(--text-muted)" className="text-[10px]">
          损耗功率 (W)
        </text>
        <text x={padL + plotW / 2} y={h - 6} textAnchor="middle" fill="var(--text-muted)" className="text-[10px]">
          三项功率损耗物理拆解（逆变器线损 + 绕组铜耗 + 随速铁损风摩）
        </text>
      </svg>
    );
  };

  const hovered = hoverIdx !== null ? sorted[hoverIdx] : null;

  return (
    <div className="dyno-card rounded-sm border p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h3 className="text-xs font-semibold tracking-wide dyno-text-primary">测功标定拟合精度与三项损耗拆解</h3>
          <div className="flex items-center gap-3 text-[11px] dyno-text-muted">
            {metricView === 'losses' ? (
              <>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-xs" style={{ backgroundColor: 'var(--accent)' }} />
                  铁损+风摩 P0
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-xs" style={{ backgroundColor: 'var(--warn)' }} />
                  铜耗 1.5RsIq²
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-xs" style={{ backgroundColor: 'var(--text-muted)' }} />
                  逆变器/线损
                </span>
              </>
            ) : (
              <>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-0.5 w-3 border-t-2 border-dashed" style={{ borderColor: 'var(--text-muted)' }} />
                  实测值
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-0.5 w-3" style={{ backgroundColor: 'var(--accent)' }} />
                  物理模型预测
                </span>
              </>
            )}
          </div>
        </div>

        <div className="dyno-well flex items-center gap-1 rounded-sm border p-0.5">
          {(
            [
              ['torque', '扭矩回代对比'],
              ['eta', '效率回代对比'],
              ['losses', '三项损耗拆解'],
            ] as const
          ).map(([k, lbl]) => (
            <button
              key={k}
              type="button"
              onClick={() => setMetricView(k)}
              className={`rounded-xs px-2.5 py-1 text-[11px] font-medium whitespace-nowrap transition-colors cursor-pointer ${
                metricView === k ? 'dyno-seg-active' : 'dyno-text-muted hover:dyno-text-primary'
              }`}
            >
              {lbl}
            </button>
          ))}
        </div>
      </div>

      {metricView === 'torque' && renderParityOrLine(true)}
      {metricView === 'eta' && renderParityOrLine(false)}
      {metricView === 'losses' && renderLosses()}

      <div className="dyno-well mt-2 flex flex-wrap items-center justify-between gap-2 rounded-sm border px-3 py-1.5 font-mono text-[11px] tabular-nums dyno-text-secondary">
        {hovered ? (
          <>
            <span>
              n={hovered.nRpm.toFixed(0)} RPM · V={hovered.vBusV.toFixed(2)}V · I={hovered.iBusA.toFixed(3)}A · Iq={hovered.iqEstA.toFixed(3)}A
            </span>
            <span>
              T实={hovered.tNm.toFixed(4)} vs T预={hovered.tEstNm.toFixed(4)} N·m (Δ={hovered.errTorqueNm >= 0 ? '+' : ''}
              {hovered.errTorqueNm.toFixed(4)}) · η={(hovered.etaMeas * 100).toFixed(1)}% vs {(hovered.etaEst * 100).toFixed(1)}%
            </span>
          </>
        ) : (
          <span className="dyno-text-muted">悬停曲线或柱状图查看对应工况点的实测/模型误差及损耗分项</span>
        )}
      </div>
    </div>
  );
};

interface WaveSeries {
  label: string;
  color: string;
  values: number[];
  dashed?: boolean;
}

interface MultiWaveChartProps {
  times: number[];
  series: WaveSeries[];
  yLabel: string;
  referenceLine?: { value: number; label: string; color: string };
  height?: number;
}

export const MultiChannelWaveChart: React.FC<MultiWaveChartProps> = ({
  times,
  series,
  yLabel,
  referenceLine = { value: Number.NaN, label: '', color: '' },
  height = 256,
}) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (times.length === 0) {
    return (
      <div className="dyno-card flex h-56 items-center justify-center rounded-sm border text-xs dyno-text-muted">
        暂无可绘制的波形样本数据。
      </div>
    );
  }

  const w = 780;
  const h = height;
  const padL = 56;
  const padR = 20;
  const padT = 18;
  const padB = 34;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const stride = Math.max(1, Math.floor(times.length / 450));
  const indices: number[] = [];
  for (let i = 0; i < times.length; i += stride) indices.push(i);
  if (indices[indices.length - 1] !== times.length - 1) indices.push(times.length - 1);

  const finiteVals: number[] = [];
  for (const s of series) {
    for (const i of indices) {
      if (Number.isFinite(s.values[i])) finiteVals.push(s.values[i]);
    }
  }
  if (Number.isFinite(referenceLine.value)) finiteVals.push(referenceLine.value);

  const rawMin = finiteVals.length > 0 ? Math.min(...finiteVals) : -1;
  const rawMax = finiteVals.length > 0 ? Math.max(...finiteVals) : 1;
  const padY = Math.max(0.1, (rawMax - rawMin) * 0.1);
  const yMin = rawMin - padY;
  const yMax = rawMax + padY;
  const tMin = times[0];
  const tMax = Math.max(tMin + 1e-6, times[times.length - 1]);

  const xOf = (t: number) => padL + ((t - tMin) / (tMax - tMin)) * plotW;
  const yOf = (v: number) => padT + plotH - ((v - yMin) / Math.max(1e-6, yMax - yMin)) * plotH;

  const buildPath = (vals: number[]): string => {
    let d = '';
    let drawing = false;
    for (const idx of indices) {
      const v = vals[idx];
      if (!Number.isFinite(v)) {
        drawing = false;
        continue;
      }
      const x = xOf(times[idx]).toFixed(1);
      const y = yOf(v).toFixed(1);
      d += `${drawing ? 'L' : 'M'}${x},${y} `;
      drawing = true;
    }
    return d;
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * w;
    const frac = (relX - padL) / plotW;
    if (frac < 0 || frac > 1) {
      setHoverIdx(null);
      return;
    }
    const targetT = tMin + frac * (tMax - tMin);
    let best = 0;
    let bestDist = Infinity;
    for (const idx of indices) {
      const dist = Math.abs(times[idx] - targetT);
      if (dist < bestDist) {
        bestDist = dist;
        best = idx;
      }
    }
    setHoverIdx(best);
  };

  return (
    <div className="dyno-card rounded-sm border p-3.5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          {series.map((s) => (
            <span key={s.label} className="inline-flex items-center gap-1.5 font-mono text-[11px] dyno-text-secondary">
              <span
                className="h-0.5 w-3"
                style={{
                  backgroundColor: s.dashed ? 'transparent' : s.color,
                  borderTop: s.dashed ? `2px dashed ${s.color}` : 'none',
                }}
              />
              {s.label}
            </span>
          ))}
        </div>
        {hoverIdx !== null ? (
          <div className="flex flex-wrap items-center gap-2.5 font-mono text-[11px] tabular-nums dyno-text-primary">
            <span className="dyno-text-muted">t={times[hoverIdx].toFixed(4)}s</span>
            {series.map((s) => (
              <span key={s.label} style={{ color: s.color }}>
                {s.label.split(' ')[0]}={Number.isFinite(s.values[hoverIdx]) ? s.values[hoverIdx].toFixed(3) : 'NaN'}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-[11px] dyno-text-muted">SVPWM 线性调制限 {SVPWM_LINEAR_LIMIT.toFixed(4)}</span>
        )}
      </div>

      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full cursor-crosshair select-none"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const y = padT + plotH - f * plotH;
          const v = yMin + f * (yMax - yMin);
          return (
            <g key={`gy-${f}`}>
              <line x1={padL} y1={y} x2={padL + plotW} y2={y} stroke="var(--border-subtle)" strokeDasharray="3 3" />
              <text x={padL - 8} y={y + 3} textAnchor="end" fill="var(--text-muted)" className="font-mono text-[10px] tabular-nums">
                {v.toFixed(2)}
              </text>
            </g>
          );
        })}

        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const x = padL + f * plotW;
          const tv = tMin + f * (tMax - tMin);
          return (
            <g key={`gx-${f}`}>
              <line x1={x} y1={padT} x2={x} y2={padT + plotH} stroke="var(--border-subtle)" strokeOpacity={0.45} />
              <text x={x} y={padT + plotH + 15} textAnchor="middle" fill="var(--text-muted)" className="font-mono text-[10px] tabular-nums">
                {tv.toFixed(3)}s
              </text>
            </g>
          );
        })}

        {Number.isFinite(referenceLine.value) && (
          <g>
            <line
              x1={padL}
              y1={yOf(referenceLine.value)}
              x2={padL + plotW}
              y2={yOf(referenceLine.value)}
              stroke={referenceLine.color}
              strokeWidth={1.3}
              strokeDasharray="5 3"
            />
            <text
              x={padL + plotW - 6}
              y={yOf(referenceLine.value) - 5}
              textAnchor="end"
              fill={referenceLine.color}
              className="font-mono text-[10px]"
            >
              {referenceLine.label} ({referenceLine.value.toFixed(4)})
            </text>
          </g>
        )}

        {series.map((s) => (
          <path
            key={s.label}
            d={buildPath(s.values)}
            fill="none"
            stroke={s.color}
            strokeWidth={s.dashed ? 1.4 : 2}
            strokeDasharray={s.dashed ? '4 3' : undefined}
          />
        ))}

        {hoverIdx !== null && (
          <line
            x1={xOf(times[hoverIdx])}
            y1={padT}
            x2={xOf(times[hoverIdx])}
            y2={padT + plotH}
            stroke="#f59e0b"
            strokeWidth={1.1}
            strokeDasharray="2 2"
          />
        )}

        <text x={14} y={padT + plotH / 2} textAnchor="middle" transform={`rotate(-90 14 ${padT + plotH / 2})`} fill="var(--text-muted)" className="text-[10px]">
          {yLabel}
        </text>
      </svg>
    </div>
  );
};
