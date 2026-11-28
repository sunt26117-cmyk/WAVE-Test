"""
thermal_exporter.py - Pure 6-MOS Transient Thermal Simulator Waveform & Summary Exporter
Fixes:
- Raises ValueError on regen_limit / invalid_bus instead of silently exporting all-zero waveforms
- Computes genuine SVPWM min-max vs DPWM1 60-deg bus-clamped duty sequences (Duty_A, Duty_B, Duty_C)
- Caps total exported rows at 200,000 to prevent UI/browser freeze
- Safe NaN-guarded rounding on summary dictionary
"""
from __future__ import annotations

import math
import numpy as np
import pandas as pd

from motor_physics import MotorParams, solve_single_point

MAX_EXPORT_SAMPLES = 200_000


def _safe_round(val: float, ndigits: int) -> float | None:
    if val is None or not math.isfinite(val):
        return None
    return round(float(val), ndigits)


def _compute_pwm_duties(
    theta: np.ndarray,
    m_norm: float,
    phi_rad: float,
    modulation: str,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    if not math.isfinite(m_norm) or m_norm > 1.0 + 1e-6:
        raise ValueError(f"工况超调：m_norm={m_norm:.3f} > 1.0，超出线性 SVPWM 调制极限，拒绝裁剪并合成 PWM 占空比。")
    v_amp = min(1.0, max(0.0, m_norm)) / math.sqrt(3.0)
    if v_amp <= 1e-6:
        half = np.full_like(theta, 0.5, dtype=float)
        return half.copy(), half.copy(), half.copy()
    ang = theta + phi_rad
    va = v_amp * np.sin(ang)
    vb = v_amp * np.sin(ang - 2.0 * math.pi / 3.0)
    vc = -(va + vb)

    if modulation.upper() == "DPWM1":
        stack = np.vstack([va, vb, vc])
        idx_max = np.argmax(np.abs(stack), axis=0)
        v_dom = stack[idx_max, np.arange(len(theta))]
        v_cm = np.where(v_dom >= 0.0, 0.5 - v_dom, -0.5 - v_dom)
    else:
        # SVPWM zero-sequence min-max centering
        v_max = np.maximum(np.maximum(va, vb), vc)
        v_min = np.minimum(np.minimum(va, vb), vc)
        v_cm = -0.5 * (v_max + v_min)

    da = np.clip(0.5 + va + v_cm, 0.0, 1.0)
    db = np.clip(0.5 + vb + v_cm, 0.0, 1.0)
    dc = np.clip(0.5 + vc + v_cm, 0.0, 1.0)
    return da, db, dc


def synthesize_6mos_csv(
    v_meas: float,
    i_bus: float,
    n_rpm: float,
    t_amb: float,
    modulation: str,
    fs_hz: int,
    duration_s: float,
    params: MotorParams,
    include_duty: bool = True,
) -> tuple[pd.DataFrame, dict]:
    res = solve_single_point(v_meas, i_bus, n_rpm, params)

    is_over_mod = (
        res["alert_cmd_sat"]
        or res["alert_motor_sat"]
        or (math.isfinite(res["m_norm_cmd"]) and res["m_norm_cmd"] > 1.0 + 1e-6)
        or (math.isfinite(res["m_norm_motor"]) and res["m_norm_motor"] > 1.0 + 1e-6)
    )
    if res["mode"] in ("regen_limit", "invalid_bus") or is_over_mod or not math.isfinite(res["iq"]):
        if res["mode"] == "invalid_bus":
            raise ValueError(f"母线压降异常 (V_meas={v_meas:.2f}V, Vbus_cap<=0.1V)，无法合成波形。")
        if is_over_mod:
            m_show = res["m_norm_cmd"] if math.isfinite(res["m_norm_cmd"]) else res["m_norm_motor"]
            raise ValueError(f"工况超调：调制深度 m_norm={m_show:.3f} > 1.0，超出线性 SVPWM 能力（电压饱和），无法导出物理可信的波形。")
        raise ValueError("该工况已超出发电回馈最大制动功率极限 Eq²/(4·Rs) (Δ < 0)，无法反推相电流。")

    iq = float(res["iq"])
    v_bus = float(res["v_bus_cap"])
    is_stall = abs(n_rpm) < 1e-6

    req_samples = max(2, int(round(fs_hz * duration_s)))
    clamped_by_limit = req_samples > MAX_EXPORT_SAMPLES
    n_samples = min(MAX_EXPORT_SAMPLES, req_samples)
    actual_duration_s = (n_samples - 1) / float(fs_hz) if n_samples > 1 else 0.0
    t_arr = np.arange(n_samples, dtype=float) / float(fs_hz)

    if is_stall:
        theta = np.full(n_samples, math.pi / 2.0, dtype=float)
        ia = np.full(n_samples, iq, dtype=float)
        ib = np.full(n_samples, -0.5 * iq, dtype=float)
        ic = np.full(n_samples, -0.5 * iq, dtype=float)
    else:
        omega_e = (1.0 if n_rpm >= 0 else -1.0) * 2.0 * math.pi * res["fe_hz"]
        theta = omega_e * t_arr
        ia = iq * np.sin(theta)
        ib = iq * np.sin(theta - 2.0 * math.pi / 3.0)
        ic = -(ia + ib)

    data = {
        "Time": np.round(t_arr, 9),
        "Ia": np.round(ia, 5),
        "Ib": np.round(ib, 5),
        "Ic": np.round(ic, 5),
        "Vbus": np.round(np.full(n_samples, v_bus), 4),
    }

    if include_duty:
        phi_rad = math.radians(res["phi_cmd_deg"]) if math.isfinite(res["phi_cmd_deg"]) else 0.0
        m_norm = res["m_norm_cmd"] if math.isfinite(res["m_norm_cmd"]) else 0.0
        iq_phase_shift = 0.0 if iq >= 0.0 else math.pi
        da, db, dc = _compute_pwm_duties(theta + iq_phase_shift, m_norm, phi_rad, modulation)
        data["Duty_A"] = np.round(da, 5)
        data["Duty_B"] = np.round(db, 5)
        data["Duty_C"] = np.round(dc, 5)

    df_wave = pd.DataFrame(data)

    summary = {
        "Phase Ia (A)": "Ia",
        "Phase Ib (A)": "Ib",
        "Phase Ic": "Auto: Ic = -(Ia + Ib)",
        "Vbus (V)": _safe_round(v_bus, 3),
        "T_amb (°C)": _safe_round(t_amb, 1),
        "Modulation": modulation,
        "f_e (Hz)": _safe_round(res["fe_hz"], 2),
        "Iq_peak (A)": _safe_round(iq, 3),
        "Iph_rms (A)": _safe_round(res["iph_rms"], 3),
        "Mod Depth m [Vph/(Vbus/2), max 1.1547] (motor)": _safe_round(res["m_motor"], 4),
        "Mod Depth m_norm [sqrt(3)*Vph/Vbus, max 1.0] (motor)": _safe_round(res["m_norm_motor"], 4),
        "Mod Depth m [Vph/(Vbus/2), max 1.1547] (cmd)": _safe_round(res["m_cmd"], 4),
        "Mod Depth m_norm [sqrt(3)*Vph/Vbus, max 1.0] (cmd)": _safe_round(res["m_norm_cmd"], 4),
        "PF Angle φ (°)": _safe_round(res["phi_deg"], 2),
        "requested_duration_s": _safe_round(duration_s, 4),
        "actual_duration_s": _safe_round(actual_duration_s, 4),
        "clamped_by_limit": clamped_by_limit,
        "mode": res["mode"],
        "Synthetic Waveform Notice": "物理方程合成稳态相电流/占空比（非实测示波器瞬态谐波/死区畸变）",
        "Rds(on) Note": f"Sidebar Rds={params.rds_on_mohm:.1f} mOhm (MOS Thermal 面板使用 Rds@25C + alpha*dTj)",
    }
    return df_wave, summary
