import JSZip from 'jszip';

const REQUIREMENTS_TXT = `streamlit>=1.36.0
pandas>=2.2.0
numpy>=1.26.0
scipy>=1.13.0
plotly>=5.22.0
openpyxl>=3.1.2
`;

const MOTOR_PHYSICS_PY = String.raw`"""
motor_physics.py - Core BLDC/FOC Physics Engine (V2.0)
Amplitude-invariant Clarke/Park transformation + SI units.
Fixes:
- Signed quadratic root selection (copysign(1.0, eq)) for negative speed & stall eq==0
- invalid_bus detection when V_meas - I_bus * R_line <= 0.1 V (no silent clamp masking)
- 4-quadrant power factor angle phi_deg
- Zero-drift deadband protection
"""
from __future__ import annotations

from dataclasses import dataclass
import math
import numpy as np
import pandas as pd

SVPWM_LINEAR_LIMIT = 2.0 / math.sqrt(3.0)  # 1.1547005383792517


@dataclass
class MotorParams:
    pole_pairs: int = 7
    ke_prime: float = 0.051332  # V_peak / (rad/s_mech)
    r_ll_25: float = 0.72       # Line-to-line resistance at 25C [Ohm]
    t_coil: float = 45.0        # Winding temperature [C]
    l_ll_mh: float = 0.44       # Line-to-line inductance [mH]
    n0_rpm: float = 1450.0      # Reference no-load speed [RPM]
    beta_sat: float = 0.0065    # Magnetic saturation coeff [1/A^2]
    p0_a: float = 5.2e-4        # Speed-dependent iron+windage linear coeff [W/RPM]
    p0_b: float = 4.8e-7        # Speed-dependent iron+windage quadratic coeff [W/RPM^2]
    rs_eff_override: float | None = None

    i_idle: float = 0.06        # Inverter quiescent current [A]
    eta_inv: float = 0.95       # Inverter stage efficiency (0-1)
    i_deadband: float = 0.02    # Zero-drift deadband for |I_net| [A]
    r_line: float = 0.04        # Battery + harness resistance [Ohm]

    # Compact voltage-drop params for Vq_cmd & m_cmd estimation
    rds_on_mohm: float = 12.0   # Effective Rds(on) [mOhm]
    t_dead_ns: float = 450.0    # Dead time [ns]
    f_sw_khz: float = 20.0      # Switching frequency [kHz]
    v_sd: float = 0.85          # Body diode forward voltage [V]


def calc_omega_m(n_rpm: float) -> float:
    return (2.0 * math.pi * n_rpm) / 60.0


def calc_omega_e(n_rpm: float, pole_pairs: int) -> float:
    return pole_pairs * calc_omega_m(n_rpm)


def calc_fe_hz(n_rpm: float, pole_pairs: int) -> float:
    return (pole_pairs * abs(n_rpm)) / 60.0


def calc_rs_anchor(r_ll_25: float, t_coil: float) -> float:
    return (r_ll_25 / 2.0) * (1.0 + 0.00393 * (t_coil - 25.0))


def get_effective_rs(params: MotorParams) -> float:
    if params.rs_eff_override is not None and params.rs_eff_override > 0:
        return float(params.rs_eff_override)
    return calc_rs_anchor(params.r_ll_25, params.t_coil)


def calc_lq_h(l_ll_mh: float) -> float:
    return (l_ll_mh * 1e-3) / 2.0


def calc_ke_from_no_load(v_test: float, n0_rpm: float) -> float:
    if n0_rpm <= 0:
        return 0.0
    return (v_test / math.sqrt(3.0)) / calc_omega_m(n0_rpm)


def calc_ke_from_kv(kv_rpm_per_v: float) -> float:
    if kv_rpm_per_v <= 0:
        return 0.0
    return 60.0 / (2.0 * math.pi * math.sqrt(3.0) * kv_rpm_per_v)


def calc_ksat(iq: float, beta_sat: float) -> float:
    if not math.isfinite(iq):
        return 1.0
    return 1.0 / (1.0 + max(0.0, beta_sat) * (iq ** 2))


def calc_p0_loss(n_rpm: float, p0_a: float, p0_b: float) -> float:
    n_abs = abs(n_rpm)
    if n_abs <= 0:
        return 0.0
    return max(0.0, p0_a * n_abs + p0_b * (n_abs ** 2))


def calc_vq_cmd(vq_motor: float, iq: float, v_bus_cap: float, params: MotorParams) -> float:
    if not math.isfinite(iq):
        return float("nan")
    rds_ohm = max(0.0, params.rds_on_mohm) * 1e-3
    t_dead_s = max(0.0, params.t_dead_ns) * 1e-9
    f_sw_hz = max(0.0, params.f_sw_khz) * 1e3
    sign_iq = 0.0 if abs(iq) < 1e-9 else (1.0 if iq > 0 else -1.0)
    dead_drop = sign_iq * (4.0 / math.pi) * t_dead_s * f_sw_hz * max(0.0, v_bus_cap + params.v_sd)
    return vq_motor + rds_ohm * iq + dead_drop


def calc_phi_deg(vq: float, vd: float, iq: float) -> float:
    if not (math.isfinite(vq) and math.isfinite(vd) and math.isfinite(iq)):
        return float("nan")
    theta_v = math.atan2(vq, vd)
    theta_i = (math.pi / 2.0) if iq >= 0.0 else (-math.pi / 2.0)
    diff = (theta_v - theta_i + math.pi) % (2.0 * math.pi) - math.pi
    if diff <= -math.pi + 1e-12:
        diff = math.pi
    return math.degrees(diff)


def solve_single_point(v_meas: float, i_bus: float, n_rpm: float, params: MotorParams) -> dict:
    omega_m = calc_omega_m(n_rpm)
    omega_e = calc_omega_e(n_rpm, params.pole_pairs)
    fe_hz = calc_fe_hz(n_rpm, params.pole_pairs)
    rs = get_effective_rs(params)
    lq = calc_lq_h(params.l_ll_mh)

    r_line = max(0.0, params.r_line)
    v_bus_cap_raw = v_meas - i_bus * r_line
    invalid_bus = (not math.isfinite(v_bus_cap_raw)) or (v_bus_cap_raw <= 0.1)
    v_bus_cap = float("nan") if invalid_bus else v_bus_cap_raw

    eq0 = params.ke_prime * omega_m
    eq = eq0
    p0 = calc_p0_loss(n_rpm, params.p0_a, params.p0_b)
    p_in = v_meas * i_bus

    i_net = i_bus - params.i_idle
    eta_inv = min(0.999, max(0.1, params.eta_inv))
    deadband = max(0.0, params.i_deadband)

    if invalid_bus:
        mode = "invalid_bus"
        p_elec = float("nan")
    elif abs(i_net) < deadband:
        mode = "zero_drift"
        p_elec = 0.0
    elif i_net >= 0:
        mode = "motoring"
        p_elec = eta_inv * v_bus_cap * i_net
    else:
        mode = "regen"
        p_elec = (v_bus_cap * i_net) / eta_inv

    delta = float("nan") if invalid_bus else (eq0 * eq0 + (8.0 / 3.0) * rs * p_elec)

    iq = float("nan")
    iph_rms = float("nan")
    k_sat = 1.0
    kt = 1.5 * params.ke_prime
    t_est = float("nan")
    p_cu = float("nan")
    p_out = float("nan")
    eta_est = float("nan")
    vq_motor = float("nan")
    vq_cmd = float("nan")
    vd = float("nan")
    m_motor = float("nan")
    m_norm_motor = float("nan")
    m_cmd = float("nan")
    m_norm_cmd = float("nan")
    phi_deg = float("nan")
    phi_cmd_deg = float("nan")

    if mode == "invalid_bus":
        pass
    elif mode == "zero_drift":
        iq = 0.0
        iph_rms = 0.0
        p_cu = 0.0
        if abs(n_rpm) > 1e-6 and abs(omega_m) > 1e-6:
            t_est = -p0 / omega_m
            p_out = -p0
        else:
            t_est = 0.0
            p_out = 0.0
        eta_est = 0.0
        vq_motor = eq0
        vq_cmd = eq0
        vd = 0.0
        v_ph = abs(eq0)
        m_motor = v_ph / (v_bus_cap / 2.0)
        m_norm_motor = math.sqrt(3.0) * v_ph / v_bus_cap
        m_cmd = m_motor
        m_norm_cmd = m_norm_motor
        phi_deg = 0.0
        phi_cmd_deg = 0.0
    elif delta < 0:
        mode = "regen_limit"
    else:
        if abs(eq0) < 1e-12:
            iq = math.sqrt((2.0 * p_elec) / (3.0 * rs)) if p_elec >= 0 else -math.sqrt((-2.0 * p_elec) / (3.0 * rs))
            eq = 0.0
        else:
            sign_eq = 1.0 if eq0 >= 0.0 else -1.0
            beta = max(0.0, params.beta_sat)
            iq = (-eq0 + sign_eq * math.sqrt(delta)) / (2.0 * rs)
            if beta > 0.0 and math.isfinite(iq):
                hit_regen_limit = False
                for _ in range(30):
                    iq_sq = iq * iq
                    denom = 1.0 + beta * iq_sq
                    ks = 1.0 / denom
                    eq_cur = eq0 * ks
                    residual = 1.5 * (eq_cur * iq + rs * iq_sq) - p_elec
                    if abs(residual) <= 1e-11 * (1.0 + abs(p_elec)):
                        eq = eq_cur
                        delta = max(0.0, eq_cur * eq_cur + (8.0 / 3.0) * rs * p_elec)
                        break
                    d_eq_term = eq0 * ((1.0 - beta * iq_sq) / (denom * denom))
                    df = 1.5 * (d_eq_term + 2.0 * rs * iq)
                    d_iter = eq_cur * eq_cur + (8.0 / 3.0) * rs * p_elec
                    next_iq = float("nan")
                    if abs(df) > 1e-9 and math.isfinite(df):
                        cand = iq - residual / df
                        cand_sq = cand * cand
                        cand_res = 1.5 * ((eq0 / (1.0 + beta * cand_sq)) * cand + rs * cand_sq) - p_elec
                        if math.isfinite(cand_res) and abs(cand_res) < abs(residual):
                            next_iq = cand
                    if not math.isfinite(next_iq):
                        if d_iter < 0.0:
                            delta = d_iter
                            hit_regen_limit = True
                            break
                        fp = (-eq_cur + sign_eq * math.sqrt(d_iter)) / (2.0 * rs)
                        next_iq = 0.5 * iq + 0.5 * fp
                    iq = next_iq
                ks_final = calc_ksat(iq, beta)
                eq = eq0 * ks_final
                d_final = eq * eq + (8.0 / 3.0) * rs * p_elec
                final_res = 1.5 * (eq * iq + rs * iq * iq) - p_elec
                if hit_regen_limit or d_final < -1e-9 or (not math.isfinite(iq)) or abs(final_res) > 1e-3 * (1.0 + abs(p_elec)):
                    mode = "regen_limit"
                    iq = float("nan")
                    if d_final < delta:
                        delta = d_final
                else:
                    delta = max(0.0, d_final)

        if mode != "regen_limit" and math.isfinite(iq):
            iph_rms = abs(iq) / math.sqrt(2.0)
            k_sat = calc_ksat(iq, params.beta_sat)
            eq = eq0 * k_sat
            kt = 1.5 * params.ke_prime * k_sat
            p_cu = 1.5 * rs * (iq ** 2)
            if abs(n_rpm) > 1e-6 and abs(omega_m) > 1e-6:
                t_est = kt * iq - p0 / omega_m
                p_out = t_est * omega_m
            else:
                t_est = kt * iq
                p_out = 0.0

            if p_in > 1e-6 and p_out >= 0:
                eta_est = p_out / p_in
            elif p_in < -1e-6 and p_out < -1e-6:
                eta_est = abs(p_in / p_out)
            else:
                eta_est = 0.0

            vq_motor = eq + rs * iq
            vq_cmd = calc_vq_cmd(vq_motor, iq, v_bus_cap, params)
            vd = -omega_e * lq * iq
            v_ph_motor = math.hypot(vd, vq_motor)
            v_ph_cmd = math.hypot(vd, vq_cmd)

            m_motor = v_ph_motor / (v_bus_cap / 2.0)
            m_norm_motor = math.sqrt(3.0) * v_ph_motor / v_bus_cap
            m_cmd = v_ph_cmd / (v_bus_cap / 2.0)
            m_norm_cmd = math.sqrt(3.0) * v_ph_cmd / v_bus_cap
            phi_deg = calc_phi_deg(vq_motor, vd, iq)
            phi_cmd_deg = calc_phi_deg(vq_cmd, vd, iq)

    iq_sign_ambiguous = (
        mode not in ("invalid_bus", "regen_limit", "zero_drift")
        and math.isfinite(iq)
        and ((mode == "regen" and p_elec < -1e-12 and delta > 1e-12) or (abs(eq0) < 1e-12 and abs(iq) > 1e-9))
    )

    return {
        "v_meas": v_meas,
        "i_bus": i_bus,
        "n_rpm": n_rpm,
        "fe_hz": fe_hz,
        "v_bus_cap": v_bus_cap,
        "rs_ohm": rs,
        "eq": eq,
        "i_net": i_net,
        "p_elec": p_elec,
        "p0": p0,
        "p_cu": p_cu,
        "p_in": p_in,
        "p_out": p_out,
        "eta_est": eta_est,
        "delta": delta,
        "iq": iq,
        "iph_rms": iph_rms,
        "t_est": t_est,
        "vq_motor": vq_motor,
        "vq_cmd": vq_cmd,
        "vd": vd,
        "m_motor": m_motor,
        "m_norm_motor": m_norm_motor,
        "m_cmd": m_cmd,
        "m_norm_cmd": m_norm_cmd,
        "phi_deg": phi_deg,
        "phi_cmd_deg": phi_cmd_deg,
        "mode": mode,
        "alert_low_speed": abs(n_rpm) < 0.08 * params.n0_rpm,
        "alert_cmd_sat": math.isfinite(m_cmd) and m_cmd > SVPWM_LINEAR_LIMIT,
        "alert_motor_sat": math.isfinite(m_motor) and m_motor > SVPWM_LINEAR_LIMIT,
        "alert_low_freq": fe_hz < 3.0,
        "alert_regen_limit": mode == "regen_limit",
        "alert_zero_drift": mode == "zero_drift",
        "alert_invalid_bus": mode == "invalid_bus",
        "alert_iq_sign_ambiguous": iq_sign_ambiguous,
    }


def forward_verify_point(iq: float, n_rpm: float, v_meas: float, params: MotorParams) -> dict:
    omega_m = calc_omega_m(n_rpm)
    omega_e = calc_omega_e(n_rpm, params.pole_pairs)
    rs = get_effective_rs(params)
    lq = calc_lq_h(params.l_ll_mh)
    k_sat = calc_ksat(iq, params.beta_sat)
    eq = params.ke_prime * omega_m * k_sat
    p_elec = 1.5 * (eq * iq + rs * iq * iq)
    eta_inv = min(0.999, max(0.1, params.eta_inv))
    p_dc = p_elec / eta_inv if p_elec >= 0 else p_elec * eta_inv

    r_line = max(0.0, params.r_line)
    i_bus_est = float("nan")
    line_collapse = False
    if r_line < 1e-9:
        if v_meas <= 0.1:
            line_collapse = True
        else:
            i_bus_est = params.i_idle + p_dc / v_meas
    else:
        b = -(v_meas + r_line * params.i_idle)
        c = v_meas * params.i_idle + p_dc
        disc = b * b - 4.0 * r_line * c
        if disc < 0.0 or not math.isfinite(disc):
            line_collapse = True
        else:
            i_bus_est = (-b - math.sqrt(disc)) / (2.0 * r_line)

    v_bus_cap_raw = float("nan") if line_collapse else (v_meas - i_bus_est * r_line)
    invalid_bus = line_collapse or (not math.isfinite(v_bus_cap_raw)) or (v_bus_cap_raw <= 0.1)
    v_bus_cap = float("nan") if invalid_bus else v_bus_cap_raw

    p0 = calc_p0_loss(n_rpm, params.p0_a, params.p0_b)
    t_est = (1.5 * params.ke_prime * k_sat * iq - p0 / omega_m) if (abs(n_rpm) > 1e-6 and abs(omega_m) > 1e-6) else (1.5 * params.ke_prime * k_sat * iq)
    p_in = float("nan") if invalid_bus else (v_meas * i_bus_est)
    p_out = t_est * omega_m if abs(n_rpm) > 1e-6 else 0.0
    eta_est = (
        float("nan")
        if not math.isfinite(p_in)
        else ((p_out / p_in) if (p_in > 1e-6 and p_out >= 0) else (abs(p_in / p_out) if (p_in < -1e-6 and p_out < -1e-6) else 0.0))
    )

    vq_motor = eq + rs * iq
    vq_cmd = float("nan") if invalid_bus else calc_vq_cmd(vq_motor, iq, v_bus_cap, params)
    vd = -omega_e * lq * iq
    v_ph_motor = math.hypot(vd, vq_motor)
    v_ph_cmd = float("nan") if invalid_bus else math.hypot(vd, vq_cmd)

    return {
        "iq": iq,
        "n_rpm": n_rpm,
        "v_meas": v_meas,
        "i_bus_est": i_bus_est,
        "v_bus_cap": v_bus_cap,
        "t_est": t_est,
        "eta_est": eta_est,
        "vq_motor": vq_motor,
        "vq_cmd": vq_cmd,
        "vd": vd,
        "m_motor": float("nan") if invalid_bus else v_ph_motor / (v_bus_cap / 2.0),
        "m_norm_motor": float("nan") if invalid_bus else math.sqrt(3.0) * v_ph_motor / v_bus_cap,
        "m_cmd": float("nan") if invalid_bus else v_ph_cmd / (v_bus_cap / 2.0),
        "m_norm_cmd": float("nan") if invalid_bus else math.sqrt(3.0) * v_ph_cmd / v_bus_cap,
        "phi_deg": calc_phi_deg(vq_motor, vd, iq),
        "invalid_bus": invalid_bus,
    }


def is_monotonic_timestamps(times: np.ndarray) -> bool:
    if len(times) < 2:
        return True
    return bool(np.all(np.isfinite(times)) and np.all(np.diff(times) > 0.0))


def process_runtime_log(df: pd.DataFrame, filter_window_ms: float, params: MotorParams) -> pd.DataFrame:
    times = df["Time"].to_numpy(dtype=float)
    raw_i = df["I_bus"].to_numpy(dtype=float)
    v_bus = df["V_bus"].to_numpy(dtype=float)
    rpm = df["n_rpm"].to_numpy(dtype=float)
    n_pts = len(times)
    if not (len(raw_i) == len(v_bus) == len(rpm) == n_pts):
        raise ValueError("Runtime Log Time/V_bus/I_bus/n_rpm arrays must have identical lengths.")
    if not (np.all(np.isfinite(times)) and np.all(np.isfinite(raw_i)) and np.all(np.isfinite(v_bus)) and np.all(np.isfinite(rpm))):
        raise ValueError("Runtime Log contains NaN/Inf in required signals; refusing to produce a dynamic estimate.")
    monotonic = is_monotonic_timestamps(times)
    if n_pts > 1 and not monotonic:
        raise ValueError("Runtime Log timestamps must be strictly increasing; sample-index fallback is disabled.")

    if n_pts == 0 or filter_window_ms <= 0.0:
        i_bus_filt = raw_i.copy()
    elif monotonic:
        half_w = (filter_window_ms * 1e-3) * 0.5
        i_bus_filt = np.empty(n_pts, dtype=float)
        finite = np.isfinite(raw_i)
        prefix = np.concatenate([[0.0], np.cumsum(np.where(finite, raw_i, 0.0))])
        valid_prefix = np.concatenate([[0], np.cumsum(finite.astype(int))])
        has_nan = bool(valid_prefix[-1] < n_pts)
        if not has_nan:
            dts = np.diff(times)
            trap_segs = 0.5 * (raw_i[:-1] + raw_i[1:]) * dts
            trap_prefix = np.concatenate([[0.0], np.cumsum(trap_segs)])
        else:
            trap_prefix = None
        left = 0
        right = 0
        for i in range(n_pts):
            ti = times[i]
            while left < i and ti - times[left] > half_w + 1e-12:
                left += 1
            if right < i:
                right = i
            while right + 1 < n_pts and times[right + 1] - ti <= half_w + 1e-12:
                right += 1
            if trap_prefix is not None:
                span = times[right] - times[left]
                if span > 1e-12:
                    i_bus_filt[i] = (trap_prefix[right] - trap_prefix[left]) / span
                else:
                    cnt = right - left + 1
                    i_bus_filt[i] = (prefix[right + 1] - prefix[left]) / cnt
            else:
                area = 0.0
                first_t = float("nan")
                last_t = float("nan")
                prev_t = float("nan")
                prev_v = float("nan")
                f_sum = 0.0
                f_cnt = 0
                for k in range(left, right + 1):
                    vk = raw_i[k]
                    if not math.isfinite(vk):
                        continue
                    tk = times[k]
                    f_sum += vk
                    f_cnt += 1
                    if not math.isfinite(first_t):
                        first_t = tk
                    else:
                        area += 0.5 * (prev_v + vk) * (tk - prev_t)
                    last_t = tk
                    prev_t = tk
                    prev_v = vk
                span = (last_t - first_t) if (math.isfinite(first_t) and math.isfinite(last_t)) else 0.0
                i_bus_filt[i] = (area / span) if span > 1e-12 else ((f_sum / f_cnt) if f_cnt > 0 else float("nan"))

    records = []
    for t, v, ib_raw, ib_f, n in zip(times, df["V_bus"], df["I_bus"], i_bus_filt, df["n_rpm"]):
        res = solve_single_point(float(v), float(ib_f), float(n), params)
        res["time_s"] = float(t)
        res["i_bus_raw"] = float(ib_raw)
        res["i_bus_filt"] = float(ib_f)
        records.append(res)
    out_df = pd.DataFrame(records)
    out_df.attrs["time_monotonic"] = monotonic
    return out_df
`;

const DYNO_CALIBRATOR_PY = String.raw`"""
dyno_calibrator.py - Stepwise Anti-Overfitting Dyno Calibration & 2D Efficiency Map
Fixes:
- Empty closed-loop DataFrame protection (returns structured empty eval_df with columns & status)
- Missing T_Nm rows dropped (not filled with 0.0) when T_Nm is mapped
- eta_format mismatch & P_out unit inconsistency detection via df.attrs['warnings']
- Large penalty (1e3) for non-finite residuals in optimizer (never 0.0)
- Light-load filtering on open-loop data + 1D-safe griddata + n0_rpm sync
"""
from __future__ import annotations

import math
import re
import numpy as np
import pandas as pd
from scipy.interpolate import griddata

from motor_physics import (
    MotorParams,
    calc_ke_from_kv,
    calc_ke_from_no_load,
    calc_omega_m,
    calc_p0_loss,
    calc_rs_anchor,
    forward_verify_point,
    solve_single_point,
)

TORQUE_FACTORS = {
    "Nm": 1.0,
    "mNm": 1e-3,
    "kgf_cm": 0.0980665,
}

EVAL_COLUMNS = [
    "n_rpm", "T_Nm", "V_bus", "I_bus", "P_in", "P_out", "eta",
    "iq_est", "T_est", "eta_est", "P_inv_loss", "P_cu_loss",
    "P_iron_wind_loss", "err_T", "err_eta",
]


def auto_map_columns(headers: list[str]) -> dict[str, str]:
    patterns = {
        "n_rpm": [r"^n_?rpm$", r"rpm", r"speed", r"转速"],
        "T_Nm": [r"^t_?nm$", r"^t_?mnm$", r"torque", r"^t_load$", r"^trq$", r"扭矩", r"转矩"],
        "V_bus": [r"^v_?bus$", r"v_?meas", r"vbus", r"voltage", r"电压"],
        "I_bus": [r"^i_?bus$", r"ibus", r"current", r"电流"],
        "P_in": [r"^p_?in", r"pin", r"input.?power", r"输入功率"],
        "P_out": [r"^p_?out", r"pout", r"mech.?power", r"输出功率"],
        "eta": [r"^eta", r"eff", r"效率"],
    }
    mapping: dict[str, str] = {}
    for field, pats in patterns.items():
        matched = ""
        for pat in pats:
            for h in headers:
                if re.search(pat, str(h).lower()):
                    matched = h
                    break
            if matched:
                break
        mapping[field] = matched
    return mapping


def _detect_power_scale_w(col_name: str) -> tuple[float, str | None]:
    raw = str(col_name or "").strip()
    if not raw:
        return 1.0, None

    def _parse_pow(tok: str) -> float | None:
        if re.fullmatch(r"(?:W|watt|watts)", tok, flags=re.IGNORECASE):
            return 1.0
        if re.fullmatch(r"(?:kW|kilowatt|kilowatts)", tok, flags=re.IGNORECASE):
            return 1e3
        if tok == "TW" or re.fullmatch(r"(?:terawatt|terawatts)", tok, flags=re.IGNORECASE):
            return 1e12
        if tok == "GW" or re.fullmatch(r"(?:gigawatt|gigawatts)", tok, flags=re.IGNORECASE):
            return 1e9
        if tok == "MW" or re.fullmatch(r"(?:megawatt|megawatts)", tok, flags=re.IGNORECASE):
            return 1e6
        if tok in ("mW", "mw") or re.fullmatch(r"(?:milliwatt|milliwatts)", tok, flags=re.IGNORECASE):
            return 1e-3
        if re.fullmatch(r"(?:uW|µW|μW|microwatt|microwatts)", tok, flags=re.IGNORECASE):
            return 1e-6
        return None

    br = re.search(r"[\(\[\{（]\s*([^\)\]\}）]+?)\s*[\)\]\}）]", raw)
    if br:
        tok = br.group(1).strip()
        sc = _parse_pow(tok)
        return (sc, None) if sc is not None else (1.0, tok)
    # Explicit unit suffixes must be parsed or rejected; P_in_hp must not
    # silently become watts. Preserve SI case distinction: MW != mw.
    sfx = re.search(r"(?:^|[_\s])([A-Za-zµμ]+)$", raw)
    if sfx:
        tok = sfx.group(1)
        suffix_key = tok.lower()
        explicit_power_suffixes = {
            "w", "kw", "mw", "gw", "tw", "uw", "µw", "μw",
            "watt", "watts", "kilowatt", "kilowatts", "megawatt", "megawatts", "gigawatt", "gigawatts",
            "milliwatt", "milliwatts", "microwatt", "microwatts",
            "hp", "horsepower", "ps", "va", "kva", "mva", "dbm",
            "wh", "kwh", "mwh", "gwh", "j", "kj", "mj", "gj",
        }
        if suffix_key in explicit_power_suffixes:
            sc = _parse_pow(tok)
            return (sc, None) if sc is not None else (1.0, tok)
    return 1.0, None


def _fit_nonnegative_linear_p0(samples: list[tuple[float, float]]) -> tuple[float, float]:
    """Exact non-negative LS counterpart of TS fitNonNegLinearP0."""
    if not samples:
        return 0.0, 0.0
    s11 = s12 = s22 = r1 = r2 = 0.0
    for n, p0 in samples:
        x1 = abs(float(n))
        x2 = float(n) * float(n)
        y = float(p0)
        s11 += x1 * x1
        s12 += x1 * x2
        s22 += x2 * x2
        r1 += x1 * y
        r2 += x2 * y

    det = s11 * s22 - s12 * s12
    if abs(det) > 1e-18:
        a = (r1 * s22 - r2 * s12) / det
        b = (s11 * r2 - s12 * r1) / det
        if a >= 0.0 and b >= 0.0:
            return float(a), float(b)

    def _loss(a: float, b: float) -> float:
        return sum((a * abs(float(n)) + b * float(n) * float(n) - float(p0)) ** 2 for n, p0 in samples)

    a_only = max(0.0, r1 / s11) if s11 > 1e-18 else 0.0
    b_only = max(0.0, r2 / s22) if s22 > 1e-18 else 0.0
    candidates = [(a_only, 0.0), (0.0, b_only), (0.0, 0.0)]
    best_a, best_b = min(candidates, key=lambda ab: _loss(ab[0], ab[1]))
    return float(best_a), float(best_b)


def _parse_power_series_w(series: pd.Series, default_scale_w: float) -> pd.Series:
    num = pd.to_numeric(series, errors="coerce") * default_scale_w
    need_str = num.isna() & series.notna()
    if need_str.any():
        unit_scales = {"kw": 1e3, "mw": 1e-3, "uw": 1e-6, "µw": 1e-6, "μw": 1e-6, "w": 1.0}
        for idx, raw in series.loc[need_str].items():
            s = str(raw).strip()
            m = re.match(r"^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(TW|GW|kW|MW|mW|uW|µW|μW|W)$", s, flags=re.IGNORECASE)
            if m:
                val = float(m.group(1))
                u = m.group(2)
                sc = 1e12 if u.upper() == "TW" else (1e9 if u.upper() == "GW" else (1e6 if u == "MW" else unit_scales.get(u.lower(), 1.0)))
                num.loc[idx] = val * sc
    return num


def normalize_dyno_df(
    df: pd.DataFrame,
    col_map: dict[str, str],
    torque_unit: str = "Nm",
    eta_format: str = "0-1",
    require_torque: bool = True,
) -> pd.DataFrame:
    cols = ["n_rpm", "T_Nm", "V_bus", "I_bus", "P_in", "P_out", "eta"]
    if df is None or len(df) == 0 or not col_map.get("n_rpm") or not col_map.get("V_bus") or not col_map.get("I_bus"):
        empty = pd.DataFrame(columns=cols)
        empty.attrs["warnings"] = []
        return empty

    warnings: list[str] = []
    out = pd.DataFrame(index=df.index)
    out["n_rpm"] = pd.to_numeric(df[col_map["n_rpm"]], errors="coerce")
    out["V_bus"] = pd.to_numeric(df[col_map["V_bus"]], errors="coerce")
    out["I_bus"] = pd.to_numeric(df[col_map["I_bus"]], errors="coerce")

    factor = TORQUE_FACTORS.get(torque_unit, 1.0)
    t_mapped = bool(col_map.get("T_Nm"))
    if t_mapped:
        out["T_Nm"] = pd.to_numeric(df[col_map["T_Nm"]], errors="coerce") * factor
    else:
        out["T_Nm"] = np.nan

    pin_scale, pin_bad = _detect_power_scale_w(col_map.get("P_in", "")) if col_map.get("P_in") else (1.0, None)
    pout_mapped = bool(col_map.get("P_out"))
    pout_scale, pout_bad = _detect_power_scale_w(col_map.get("P_out", "")) if pout_mapped else (1.0, None)
    if pin_bad:
        warnings.append(f"P_in 列 \"{col_map['P_in']}\" 显式单位 \"{pin_bad}\" 属于非标准功率单位，不在安全换算表 (W/kW/mW/MW/GW/TW) 中。")
    if pout_bad:
        warnings.append(f"P_out 列 \"{col_map['P_out']}\" 显式单位 \"{pout_bad}\" 属于非标准功率单位，不在安全换算表 (W/kW/mW/MW/GW/TW) 中。")
    if pin_bad or pout_bad:
        # Match the browser calibrator: never reinterpret an unknown explicit
        # power unit as W, and never hide it by falling back to V_bus * I_bus.
        empty = pd.DataFrame(columns=cols)
        warnings.append("功率列单位不明确，已停止标定点生成；请修正列单位或取消该功率列映射，不能默认按 W 解释。")
        empty.attrs["warnings"] = warnings
        return empty

    if col_map.get("P_in"):
        out["P_in"] = _parse_power_series_w(df[col_map["P_in"]], pin_scale)
    else:
        out["P_in"] = out["V_bus"] * out["I_bus"]
    out["P_in"] = out["P_in"].fillna(out["V_bus"] * out["I_bus"])

    if pout_mapped:
        out["P_out"] = _parse_power_series_w(df[col_map["P_out"]], pout_scale)
    else:
        out["P_out"] = np.nan

    omega_m = 2.0 * math.pi * out["n_rpm"] / 60.0

    # Backfill missing T_Nm from P_out if possible
    missing_t = out["T_Nm"].isna() & out["P_out"].notna() & (out["n_rpm"].abs() > 1e-6)
    out.loc[missing_t, "T_Nm"] = out.loc[missing_t, "P_out"] / omega_m.loc[missing_t]

    # Do NOT silently fill missing T_Nm with 0.0 when require_torque=True (even if unmapped)
    if require_torque:
        n_missing_t = int(out["T_Nm"].isna().sum())
        if n_missing_t > 0:
            if not t_mapped and not pout_mapped:
                warnings.append(f"闭环数据未映射扭矩列 (T_Nm) 且无 P_out 可反算，已拦截 {n_missing_t} 条无效行（请先映射扭矩列）。")
            else:
                warnings.append(f"已剔除 {n_missing_t} 条缺失扭矩的无效行（避免被当成 0 N·m 污染标定与 MAE）")
            out = out.dropna(subset=["T_Nm"])
    else:
        out["T_Nm"] = out["T_Nm"].fillna(0.0)

    # Check consistency between mapped P_out and T_Nm * omega_m
    pout_calc = out["T_Nm"] * (2.0 * math.pi * out["n_rpm"] / 60.0)
    if pout_mapped and len(out) > 0:
        denom = np.maximum(out["P_out"].abs(), pout_calc.abs())
        valid_cmp = out["P_out"].notna() & (denom > 0.2)
        if valid_cmp.any():
            rel_diff = ((out.loc[valid_cmp, "P_out"] - pout_calc.loc[valid_cmp]).abs() / denom.loc[valid_cmp]).median()
            if rel_diff > 0.15:
                warnings.append(f"实测 P_out 列与换算后的 T_Nm × ω_m 偏差达 {rel_diff * 100:.0f}%，请核对扭矩单位或 P_out 单位是否为 W")
    out["P_out"] = out["P_out"].fillna(pout_calc)

    fallback_eta = np.where(
        (out["P_in"] > 1e-6) & (out["P_out"] >= 0),
        out["P_out"] / out["P_in"],
        np.where((out["P_in"] < -1e-6) & (out["P_out"] < -1e-6), np.abs(out["P_in"] / out["P_out"]), 0.0),
    )

    # Detect eta_format mismatch before clipping
    if col_map.get("eta"):
        eta_raw = pd.to_numeric(df.loc[out.index, col_map["eta"]], errors="coerce")
        valid_eta = eta_raw.dropna()
        if len(valid_eta) > 0:
            if eta_format == "0-1" and float(valid_eta.max()) > 1.05:
                warnings.append(f"效率列最大值 ({valid_eta.max():.2f}) > 1.05，疑似为百分比格式，请切换为「percent」")
            elif eta_format == "percent" and 0.0 < float(valid_eta.median()) < 1.0:
                warnings.append(f"效率列中位数 ({valid_eta.median():.3f}) < 1.0，按 % 换算后不足 1%，疑似本就是「0-1」格式")
        out["eta"] = (eta_raw / 100.0) if eta_format == "percent" else eta_raw
        out["eta"] = out["eta"].fillna(pd.Series(fallback_eta, index=out.index))
    else:
        out["eta"] = fallback_eta

    eta_vals = pd.to_numeric(out["eta"], errors="coerce")
    quarantine_mask = eta_vals.isna() | (eta_vals < -0.02) | (eta_vals > 1.05)
    drift_mask = (~quarantine_mask) & ((eta_vals < 0.0) | (eta_vals > 1.0))
    n_quarantine = int(quarantine_mask.sum())
    n_drift = int(drift_mask.sum())
    out.loc[quarantine_mask, "eta"] = np.nan
    out.loc[drift_mask, "eta"] = eta_vals.loc[drift_mask].clip(0.0, 1.0)
    if n_quarantine > 0:
        warnings.append(f"检测到 {n_quarantine} 条物理越界效率读数 (< -2% 或 > 105%)，已隔离标记为 NaN（未静默截断，不计入效率误差）。")
    if n_drift > 0:
        warnings.append(f"有 {n_drift} 条测点效率存在微小传感器零漂越界 (-2%~0% 或 100%~105%)，已微调至 [0, 1]。")
    out = out.dropna(subset=["n_rpm", "V_bus", "I_bus"]).reset_index(drop=True)
    out.attrs["warnings"] = warnings
    return out


def run_stepwise_calibration(
    df_open: pd.DataFrame,
    df_closed: pd.DataFrame,
    base_params: MotorParams,
    ke_source: str = "open_loop_auto",
    manual_n0: float = 1450.0,
    manual_vtest: float = 13.5,
    manual_kv: float = 107.4,
    rs_fit_mode: str = "locked",
    open_loop_mod_depth: float = 1.0,
) -> dict:
    calib_warnings: list[str] = []
    status = "ok"

    def _elevate(nxt: str) -> None:
        nonlocal status
        if nxt == "failed" or (nxt == "warn" and status == "ok"):
            status = nxt

    # Step 1: Ke' & n0_rpm
    calibrated_n0 = base_params.n0_rpm
    requested_mod_scale = float(open_loop_mod_depth) if math.isfinite(open_loop_mod_depth) else 1.0
    mod_scale = min(1.0, max(0.1, requested_mod_scale))
    if ke_source == "open_loop_auto" and requested_mod_scale > 1.0 + 1e-6:
        _elevate("warn")
        calib_warnings.append(f"输入 m_norm={requested_mod_scale:.4f} 超过线性 SVPWM 定义上限 1.0，已限制为 1.0；请确认是否把调制深度 m 与归一化 m_norm 混淆。")
    elif ke_source == "open_loop_auto" and requested_mod_scale < 0.1 - 1e-6:
        _elevate("warn")
        calib_warnings.append(f"输入 m_norm={requested_mod_scale:.4f} 低于可用下限 0.1，自动 Ke 已按 0.1 计算；请检查输入。")

    if ke_source == "manual_n0_vtest":
        ke_prime = calc_ke_from_no_load(manual_vtest, manual_n0)
        calibrated_n0 = float(manual_n0)
    elif ke_source == "manual_kv":
        ke_prime = calc_ke_from_kv(manual_kv)
    elif df_open is not None and len(df_open) > 0:
        valid_ol = df_open[(df_open["n_rpm"] > 50) & (df_open["V_bus"] > 0.5)]
        if len(valid_ol) > 0:
            max_open_torque = float(pd.to_numeric(valid_ol["T_Nm"], errors="coerce").abs().max())
            if not math.isfinite(max_open_torque):
                max_open_torque = 0.0
            no_load_pts = valid_ol[(max_open_torque <= 0.02) | (pd.to_numeric(valid_ol["T_Nm"], errors="coerce").abs() <= max(0.02, max_open_torque * 0.05))]
            ke_candidates = [
                calc_ke_from_no_load(float(row["V_bus"]) * mod_scale, float(row["n_rpm"]))
                for _, row in no_load_pts.iterrows()
            ]
            ke_candidates = sorted(v for v in ke_candidates if math.isfinite(v) and v > 0.0)
            # Loaded measurements include Rs*I and omega*L*I voltage drops;
            # never use them as a fallback back-EMF / Ke proxy.
            if len(ke_candidates) >= 2:
                mid = len(ke_candidates) // 2
                ke_prime = (0.5 * (ke_candidates[mid - 1] + ke_candidates[mid])
                            if len(ke_candidates) % 2 == 0 else ke_candidates[mid])
                calibrated_n0 = float(no_load_pts["n_rpm"].max())
                relative_spread = (max(ke_candidates) - min(ke_candidates)) / max(1e-12, ke_prime)
                if relative_spread > 0.12:
                    _elevate("warn")
                    calib_warnings.append(
                        f"多点 Ke 候选值极差/中位数为 {relative_spread * 100:.1f}% (>12%)，测点可能不在同一调制深度/负载条件；自动 Ke 仅作为估计，建议核对相电压基波或使用独立空载反电势测量。"
                    )
            else:
                ke_prime = base_params.ke_prime
                calibrated_n0 = base_params.n0_rpm
                _elevate("warn")
                calib_warnings.append(f"仅识别到 {len(ke_candidates)} 个有效空载 Ke 候选点（至少需要 2 个）；没有使用带载点替代空载反电势，Ke'/n0 沿用基准参数。请补充不同转速下的空载数据，或改用手动 KV/(n0,V_test)。")
        else:
            ke_prime = base_params.ke_prime
            _elevate("warn")
            calib_warnings.append("开环数据缺少 n > 50 RPM 且 V_bus > 0.5V 的有效空载点，无法自动提取 Ke'，已沿用设定值。")
    else:
        ke_prime = base_params.ke_prime

    if not math.isfinite(ke_prime) or ke_prime <= 0.0:
        _elevate("failed")
        calib_warnings.append(f"Ke' 物理参数无效 ({ke_prime})，请核对空载点或 KV 参数。")
        ke_prime = max(1e-5, float(base_params.ke_prime or 0.05))

    rs_anchor = calc_rs_anchor(base_params.r_ll_25, base_params.t_coil)

    # Step 2: Fit P0(n) = a*n + b*n^2 (a>=0, b>=0), filtering light-load points even on df_open
    temp_params = MotorParams(**{
        **base_params.__dict__,
        "ke_prime": ke_prime,
        "n0_rpm": calibrated_n0,
        "rs_eff_override": rs_anchor,
        "beta_sat": 0.0,
        "p0_a": 0.0,
        "p0_b": 0.0,
    })
    p0_n, p0_obs = [], []

    if df_open is not None and len(df_open) >= 2:
        max_open_t = float(pd.to_numeric(df_open["T_Nm"], errors="coerce").abs().max())
        if not math.isfinite(max_open_t):
            max_open_t = 0.0
        ol_no_load = df_open[((max_open_t <= 0.02) | (pd.to_numeric(df_open["T_Nm"], errors="coerce").abs() <= 0.02)) & (df_open["n_rpm"] > 30)]
        # Match the browser-side source selection: use true near-zero torque
        # points when at least two exist; otherwise use the open-loop speed
        # points as a low-confidence fallback and let the identifiability gate
        # decide whether P0 can actually be fitted.
        src_for_p0 = ol_no_load if len(ol_no_load) >= 2 else df_open[df_open["n_rpm"] > 30]
    else:
        src_for_p0 = pd.DataFrame()

    for _, row in src_for_p0.iterrows():
        if abs(float(row["n_rpm"])) <= 10:
            continue
        res = solve_single_point(float(row["V_bus"]), float(row["I_bus"]), float(row["n_rpm"]), temp_params)
        if math.isfinite(res["iq"]):
            p_airgap = 1.5 * res["eq"] * res["iq"]
            p0_n.append(abs(float(row["n_rpm"])))
            p0_obs.append(max(0.0, p_airgap - float(row["P_out"])))

    if len(p0_n) < 3 and df_closed is not None and len(df_closed) > 0:
        max_closed_t = max(1e-4, float(pd.to_numeric(df_closed["T_Nm"], errors="coerce").abs().max()))
        light_points = df_closed[(pd.to_numeric(df_closed["T_Nm"], errors="coerce").abs() <= 0.38 * max_closed_t) & (df_closed["n_rpm"] > 50)]
        src_closed_for_p0 = light_points if len(light_points) >= 3 else df_closed.head(min(8, len(df_closed)))
        for _, row in src_closed_for_p0.iterrows():
            if abs(float(row["n_rpm"])) <= 10:
                continue
            res = solve_single_point(float(row["V_bus"]), float(row["I_bus"]), float(row["n_rpm"]), temp_params)
            if math.isfinite(res["iq"]):
                p_airgap = 1.5 * res["eq"] * res["iq"]
                p0_n.append(abs(float(row["n_rpm"])))
                p0_obs.append(max(0.0, p_airgap - float(row["P_out"])))

    p0_pairs = [(abs(float(n)), float(p0)) for n, p0 in zip(p0_n, p0_obs)
                if math.isfinite(float(n)) and abs(float(n)) > 30 and math.isfinite(float(p0)) and float(p0) >= 0.0]
    p0_speed_levels = sorted({int(round(n)) for n, _ in p0_pairs})
    p0_speed_span = (p0_speed_levels[-1] - p0_speed_levels[0]) if len(p0_speed_levels) >= 2 else 0
    p0_speed_reference = p0_speed_levels[-1] if p0_speed_levels else 0
    # Dimensionless condition number of normalized design columns |n| and n^2.
    # Large values mean a and b can trade off strongly without changing the fit.
    p0_sum_n2 = sum(n * n for n in p0_speed_levels)
    p0_sum_n3 = sum(n * n * n for n in p0_speed_levels)
    p0_sum_n4 = sum(n * n * n * n for n in p0_speed_levels)
    p0_column_correlation = min(1.0, max(0.0, p0_sum_n3 / math.sqrt(p0_sum_n2 * p0_sum_n4))) if p0_sum_n2 > 0 and p0_sum_n4 > 0 else 1.0
    p0_design_condition_number = math.inf if p0_column_correlation >= 1.0 - 1e-12 else math.sqrt((1.0 + p0_column_correlation) / (1.0 - p0_column_correlation))
    p0_identifiable = (len(p0_pairs) >= 3 and len(p0_speed_levels) >= 3 and
                       p0_speed_span >= max(20.0, 0.08 * p0_speed_reference) and
                       p0_design_condition_number <= 40.0)

    if p0_identifiable:
        p0_a, p0_b = _fit_nonnegative_linear_p0(p0_pairs)
    else:
        p0_a, p0_b = max(0.0, base_params.p0_a), max(0.0, base_params.p0_b)
        _elevate("warn")
        condition_text = f"{p0_design_condition_number:.1f}" if math.isfinite(p0_design_condition_number) else "∞"
        calib_warnings.append(f"P0(n)=a·|n|+b·n² 的参数不可充分辨识：有效样本 {len(p0_pairs)} 个、不同转速 {len(p0_speed_levels)} 档、转速跨度 {p0_speed_span:.1f} RPM、归一化设计矩阵条件数 {condition_text}；至少需要 3 个不同转速、跨度达到最高转速的 8%（或 20 RPM），且条件数 ≤40。已保留基准 P0 参数。")

    # Step 3: Fit beta (>=0) with locked or +/-15% bounded Rs_eff
    step3_base = MotorParams(**{**base_params.__dict__, "ke_prime": ke_prime, "n0_rpm": calibrated_n0, "p0_a": p0_a, "p0_b": p0_b})
    best_beta = 0.0
    best_rs = rs_anchor

    if df_closed is None or len(df_closed) == 0:
        final_params = MotorParams(**{
            **step3_base.__dict__,
            "beta_sat": best_beta,
            "rs_eff_override": best_rs,
        })
        return {
            # Match the browser calibration status gate: empty closed-loop data is a failed calibration.
            "status": "failed",
            "warnings": calib_warnings + ["闭环测功有效测点为空，无法完成 Step 3 磁饱和与效率 Map 标定（请核对闭环数据及扭矩列映射）。"],
            "params": final_params,
            "rs_anchor": rs_anchor,
            "rs_eff": best_rs,
            "eval_df": pd.DataFrame(columns=EVAL_COLUMNS),
            "metrics": {
                # No closed-loop data means no validation evidence; never report zero error.
                "MAE_T": float("nan"),
                "RMSE_T": float("nan"),
                "MAPE_T_pct": float("nan"),
                "MAE_eta_pct": float("nan"),
                "RMSE_eta_pct": float("nan"),
                "MAPE_eta_pct": float("nan"),
            },
            "validation_metrics": None,
            "operating_envelope": None,
            "param_sensitivity": None,
            "grid_n": None,
            "grid_t": None,
            "z_meas": None,
            "z_pred": None,
        }

    def _step3_objective(points: pd.DataFrame, beta: float, rs: float) -> float:
        p_cand = MotorParams(**{**step3_base.__dict__, "beta_sat": float(beta), "rs_eff_override": float(rs)})
        loss = 0.0
        count = 0
        for _, row in points.iterrows():
            rr = solve_single_point(float(row["V_bus"]), float(row["I_bus"]), float(row["n_rpm"]), p_cand)
            if not math.isfinite(rr["t_est"]):
                loss += 1e6
                count += 1
                continue
            t_err = rr["t_est"] - float(row["T_Nm"])
            eta_row = float(row["eta"])
            if math.isfinite(rr["eta_est"]) and math.isfinite(eta_row):
                eta_err = rr["eta_est"] - eta_row
                loss += 0.01 * eta_err * eta_err
            loss += t_err * t_err
            count += 1
        return loss / count if count > 0 else math.inf

    rs_min = rs_anchor if rs_fit_mode == "locked" else rs_anchor * 0.85
    rs_max = rs_anchor if rs_fit_mode == "locked" else rs_anchor * 1.15
    rs_steps = [rs_anchor] if rs_fit_mode == "locked" else [rs_min + (rs_max - rs_min) * i / 12.0 for i in range(13)]
    best_beta = 0.0
    best_rs = rs_anchor
    best_loss = math.inf
    for rs_candidate in rs_steps:
        for bi in range(51):
            beta_candidate = bi * 0.002
            objective = _step3_objective(df_closed, beta_candidate, rs_candidate)
            if objective < best_loss:
                best_loss, best_beta, best_rs = objective, beta_candidate, rs_candidate

    d_beta = 0.001
    d_rs = 0.0 if rs_fit_mode == "locked" else (rs_max - rs_min) * 0.04
    for _ in range(18):
        candidates = [(max(0.0, best_beta - d_beta), best_rs), (min(0.5, best_beta + d_beta), best_rs)]
        if rs_fit_mode == "bounded_15pct":
            candidates.extend([(best_beta, max(rs_min, best_rs - d_rs)), (best_beta, min(rs_max, best_rs + d_rs))])
        improved = False
        for beta_candidate, rs_candidate in candidates:
            objective = _step3_objective(df_closed, beta_candidate, rs_candidate)
            if objective < best_loss:
                best_loss, best_beta, best_rs = objective, beta_candidate, rs_candidate
                improved = True
        if not improved:
            d_beta *= 0.5
            d_rs *= 0.5

    final_params = MotorParams(**{
        **step3_base.__dict__,
        "beta_sat": best_beta,
        # Match browser finalParams: the effective Rs selected by Step 3 is explicit
        # even in locked mode, so downstream consumers see the same fitted value.
        "rs_eff_override": best_rs,
    })

    eval_rows = []
    unsolved_count = 0
    for _, row in df_closed.iterrows():
        rr = solve_single_point(float(row["V_bus"]), float(row["I_bus"]), float(row["n_rpm"]), final_params)
        solved = (math.isfinite(rr["t_est"]) and math.isfinite(rr["p_elec"]) and math.isfinite(rr["iq"]))
        if not solved:
            unsolved_count += 1
        p_inv = max(0.0, float(row["P_in"]) - rr["p_elec"]) if solved else float("nan")
        p_cu = rr["p_cu"] if solved and math.isfinite(rr["p_cu"]) else float("nan")
        p0_loss = rr["p0"] if solved and math.isfinite(rr["p0"]) else float("nan")
        t_est = rr["t_est"] if solved else float("nan")
        eta_est = rr["eta_est"] if solved and math.isfinite(rr["eta_est"]) else float("nan")
        iq_est = rr["iq"] if solved else float("nan")
        eta_meas_val = float(row["eta"])
        err_eta_val = (eta_est - eta_meas_val) if math.isfinite(eta_est) and math.isfinite(eta_meas_val) else float("nan")
        eval_rows.append({
            **row.to_dict(),
            "iq_est": iq_est,
            "T_est": t_est,
            "eta_est": eta_est,
            "P_inv_loss": p_inv,
            "P_cu_loss": p_cu,
            "P_iron_wind_loss": p0_loss,
            "err_T": t_est - float(row["T_Nm"]) if math.isfinite(t_est) else float("nan"),
            "err_eta": err_eta_val,
        })
    df_eval = pd.DataFrame(eval_rows, columns=EVAL_COLUMNS)
    solved_eval = df_eval.loc[np.isfinite(pd.to_numeric(df_eval["err_T"], errors="coerce"))] if len(df_eval) else df_eval
    mae_t = float(solved_eval["err_T"].abs().mean()) if len(solved_eval) else float("nan")
    rmse_t = float(np.sqrt((solved_eval["err_T"] ** 2).mean())) if len(solved_eval) else float("nan")
    mask_t = solved_eval["T_Nm"].abs() > 0.015 if len(solved_eval) else pd.Series(dtype=bool)
    mape_t = float(((solved_eval.loc[mask_t, "err_T"].abs() / solved_eval.loc[mask_t, "T_Nm"].abs()) * 100.0).mean()) if len(solved_eval) and mask_t.any() else float("nan")
    valid_err_eta = solved_eval["err_eta"].dropna() if len(solved_eval) else pd.Series(dtype=float)
    mae_eta = float((valid_err_eta.abs() * 100.0).mean()) if len(valid_err_eta) else float("nan")
    rmse_eta = float(np.sqrt(((valid_err_eta * 100.0) ** 2).mean())) if len(valid_err_eta) else float("nan")
    mask_eta = solved_eval["eta"].notna() & (solved_eval["eta"] > 0.1) & solved_eval["err_eta"].notna() if len(solved_eval) else pd.Series(dtype=bool)
    mape_eta = float(((solved_eval.loc[mask_eta, "err_eta"].abs() / solved_eval.loc[mask_eta, "eta"]) * 100.0).mean()) if len(solved_eval) and mask_eta.any() else float("nan")

    # Independent holdout validation: refit beta/Rs on train points only.
    # P0 is sourced only from independent open-loop data; closed-loop holdout rows
    # must not leak into any parameter used for validation.
    validation_metrics = None
    if len(df_closed) >= 10:
        sorted_cl = df_closed.sort_values(["n_rpm", "T_Nm"]).reset_index(drop=True)
        val_mask = (np.arange(len(sorted_cl)) % 5) == 2
        val_df = sorted_cl.loc[val_mask]
        train_df = sorted_cl.loc[~val_mask]
        if len(val_df) >= 2 and len(train_df) >= 6:
            cv_p0_samples: list[tuple[float, float]] = []
            if df_open is not None and len(df_open) >= 2:
                open_torque = pd.to_numeric(df_open["T_Nm"], errors="coerce").abs()
                max_open_t = float(open_torque.max()) if open_torque.notna().any() else 0.0
                open_abs_t = pd.to_numeric(df_open["T_Nm"], errors="coerce").abs()
                no_load = df_open[((max_open_t <= 0.02) | (open_abs_t <= max(0.02, max_open_t * 0.05))) & (df_open["n_rpm"] > 30)]
                p0_source = no_load if len(no_load) >= 2 else df_open[df_open["n_rpm"] > 30]
                cv_p0_params = MotorParams(**{
                    **base_params.__dict__, "ke_prime": ke_prime, "n0_rpm": calibrated_n0,
                    "p0_a": 0.0, "p0_b": 0.0, "beta_sat": 0.0, "rs_eff_override": rs_anchor,
                })
                for _, point in p0_source.iterrows():
                    rr = solve_single_point(float(point["V_bus"]), float(point["I_bus"]), float(point["n_rpm"]), cv_p0_params)
                    if math.isfinite(rr["iq"]):
                        cv_p0_samples.append((float(point["n_rpm"]), max(0.0, 1.5 * rr["eq"] * rr["iq"] - float(point["P_out"]))))
            if len(cv_p0_samples) >= 2:
                cv_p0_a, cv_p0_b = _fit_nonnegative_linear_p0(cv_p0_samples)
            else:
                cv_p0_a, cv_p0_b = max(0.0, base_params.p0_a), max(0.0, base_params.p0_b)
            cv_base = MotorParams(**{
                **base_params.__dict__, "ke_prime": ke_prime, "n0_rpm": calibrated_n0,
                "p0_a": cv_p0_a, "p0_b": cv_p0_b, "beta_sat": 0.0, "rs_eff_override": rs_anchor,
            })

            def _cv_objective(beta: float, rs: float) -> float:
                p_cv = MotorParams(**{**cv_base.__dict__, "beta_sat": float(beta), "rs_eff_override": float(rs)})
                loss = 0.0
                count = 0
                for _, row in train_df.iterrows():
                    rr = solve_single_point(float(row["V_bus"]), float(row["I_bus"]), float(row["n_rpm"]), p_cv)
                    if not math.isfinite(rr["t_est"]):
                        loss += 1e6
                        count += 1
                        continue
                    t_err = rr["t_est"] - float(row["T_Nm"])
                    eta_row = float(row["eta"])
                    if math.isfinite(rr["eta_est"]) and math.isfinite(eta_row):
                        eta_err = rr["eta_est"] - eta_row
                        loss += 0.01 * eta_err * eta_err
                    loss += t_err * t_err
                    count += 1
                return loss / count if count > 0 else math.inf

            rs_min_cv = rs_anchor if rs_fit_mode == "locked" else rs_anchor * 0.85
            rs_max_cv = rs_anchor if rs_fit_mode == "locked" else rs_anchor * 1.15
            rs_steps_cv = [rs_anchor] if rs_fit_mode == "locked" else [rs_min_cv + (rs_max_cv - rs_min_cv) * i / 12.0 for i in range(13)]
            cv_beta, cv_rs, cv_loss = 0.0, rs_anchor, math.inf
            for rs_candidate in rs_steps_cv:
                for bi in range(51):
                    beta_candidate = bi * 0.002
                    objective = _cv_objective(beta_candidate, rs_candidate)
                    if objective < cv_loss:
                        cv_loss, cv_beta, cv_rs = objective, beta_candidate, rs_candidate
            d_beta_cv = 0.001
            d_rs_cv = 0.0 if rs_fit_mode == "locked" else (rs_max_cv - rs_min_cv) * 0.04
            for _ in range(18):
                candidates = [(max(0.0, cv_beta - d_beta_cv), cv_rs), (min(0.5, cv_beta + d_beta_cv), cv_rs)]
                if rs_fit_mode == "bounded_15pct":
                    candidates.extend([(cv_beta, max(rs_min_cv, cv_rs - d_rs_cv)), (cv_beta, min(rs_max_cv, cv_rs + d_rs_cv))])
                improved = False
                for beta_candidate, rs_candidate in candidates:
                    objective = _cv_objective(beta_candidate, rs_candidate)
                    if objective < cv_loss:
                        cv_loss, cv_beta, cv_rs = objective, beta_candidate, rs_candidate
                        improved = True
                if not improved:
                    d_beta_cv *= 0.5
                    d_rs_cv *= 0.5

            val_params = MotorParams(**{**cv_base.__dict__, "beta_sat": cv_beta, "rs_eff_override": cv_rs})
            v_abs_t, v_pct_t, v_abs_eta = [], [], []
            for _, row in val_df.iterrows():
                rr = solve_single_point(float(row["V_bus"]), float(row["I_bus"]), float(row["n_rpm"]), val_params)
                te = rr["t_est"] if math.isfinite(rr["t_est"]) else float("nan")
                if not math.isfinite(te):
                    continue
                tnm = float(row["T_Nm"])
                v_abs_t.append(abs(te - tnm))
                if abs(tnm) > 0.015:
                    v_pct_t.append(abs(te - tnm) / abs(tnm) * 100.0)
                eta_row = float(row["eta"])
                if math.isfinite(eta_row) and math.isfinite(rr["eta_est"]):
                    v_abs_eta.append(abs((rr["eta_est"] - eta_row) * 100.0))
            validation_metrics = {
                "holdout_count": int(len(val_df)),
                "train_count": int(len(train_df)),
                "fit_source": "train_only",
                "valid_holdout_count": int(len(v_abs_t)),
                "valid_holdout_eta_count": int(len(v_abs_eta)),
                "val_mae_T": float(np.mean(v_abs_t)) if v_abs_t else float("nan"),
                "val_mape_T_pct": float(np.mean(v_pct_t)) if v_pct_t else float("nan"),
                "val_mae_eta_pct": float(np.mean(v_abs_eta)) if v_abs_eta else float("nan"),
            }
            if not v_abs_t:
                _elevate("warn")
                calib_warnings.append("独立留出集没有任何可物理解算的验证点，验证 MAE 已标记为 NaN，不能据此宣称标定通过。")
            elif len(v_abs_t) < len(val_df):
                _elevate("warn")
                calib_warnings.append(f"独立留出验证中 {len(val_df) - len(v_abs_t)} 个点无法物理解算，验证 MAE 仅基于 {len(v_abs_t)}/{len(val_df)} 个有效点。")

    operating_envelope = {
        "min_rpm": float(df_closed["n_rpm"].min()),
        "max_rpm": float(df_closed["n_rpm"].max()),
        "min_T_Nm": float(df_closed["T_Nm"].min()),
        "max_T_Nm": float(df_closed["T_Nm"].max()),
        "min_V_bus": float(df_closed["V_bus"].min()),
        "max_V_bus": float(df_closed["V_bus"].max()),
    }
    def _eval_mae_with(**overrides) -> float:
        p_test = MotorParams(**{**final_params.__dict__, **overrides})
        errs_t = []
        for _, rw in df_closed.iterrows():
            rr = solve_single_point(float(rw["V_bus"]), float(rw["I_bus"]), float(rw["n_rpm"]), p_test)
            if math.isfinite(rr["t_est"]):
                errs_t.append(abs(rr["t_est"] - float(rw["T_Nm"])))
        return float(np.mean(errs_t)) if errs_t else float("nan")
    param_sensitivity = {
        "rs_plus_10pct_delta_mae": _eval_mae_with(rs_eff_override=best_rs * 1.1) - mae_t,
        "ke_plus_5pct_delta_mae": _eval_mae_with(ke_prime=ke_prime * 1.05) - mae_t,
    }

    if not math.isfinite(rs_anchor) or rs_anchor <= 0.0 or not math.isfinite(best_rs) or best_rs <= 0.0 or not math.isfinite(best_beta) or best_beta < 0.0:
        _elevate("failed")
        calib_warnings.append(f"标定电阻或饱和系数越界 (Rs_eff={best_rs}, β={best_beta})。")
    if unsolved_count == len(df_closed):
        _elevate("failed")
        calib_warnings.append(f"全部 {unsolved_count} 个闭环测点物理求解失败 (母线塌陷或超发电极限)。")
    elif unsolved_count > 0:
        _elevate("warn")
        calib_warnings.append(f"有 {unsolved_count}/{len(df_closed)} 个闭环测点物理求解失败 (NaN)。")

    max_abs_t = max(0.05, float(df_eval["T_Nm"].abs().max()))
    if mae_t > max(0.25, 0.8 * max_abs_t):
        _elevate("failed")
        calib_warnings.append(f"扭矩回代误差过大 (MAE={mae_t:.4f} N·m, MAPE={mape_t:.1f}%)，未能收敛至有效匹配。")
    elif mae_t > max(0.05, 0.25 * max_abs_t) or mape_t > 25.0:
        _elevate("warn")
        extra = "；若开环最高点受限幅未达 m_norm≈1，请改用手动 KV 或 (n0, V_test)。" if ke_source == "open_loop_auto" else "。"
        calib_warnings.append(f"扭矩回代偏差较高 (MAE={mae_t:.4f} N·m, MAPE={mape_t:.1f}%){extra}")

    # Safe 2D Efficiency Map via convex hull interpolation + true model forward reconstruction
    grid_n = grid_t = z_meas = z_pred = None
    if len(df_eval) >= 4 and df_eval["n_rpm"].nunique() >= 2 and df_eval["T_Nm"].nunique() >= 2:
        try:
            grid_n = np.linspace(df_eval["n_rpm"].min(), df_eval["n_rpm"].max(), 30)
            grid_t = np.linspace(df_eval["T_Nm"].min(), df_eval["T_Nm"].max(), 24)
            gn, gt = np.meshgrid(grid_n, grid_t)
            z_meas = griddata((df_eval["n_rpm"], df_eval["T_Nm"]), df_eval["eta"] * 100.0, (gn, gt), method="linear")
            z_vbus = griddata((df_eval["n_rpm"], df_eval["T_Nm"]), df_eval["V_bus"], (gn, gt), method="linear")
            z_pred = np.full_like(z_meas, np.nan, dtype=float)
            kt0 = max(1e-6, 1.5 * final_params.ke_prime)
            beta = max(0.0, final_params.beta_sat)
            for j in range(len(grid_t)):
                t_val = float(grid_t[j])
                for i in range(len(grid_n)):
                    if not math.isfinite(float(z_meas[j, i])):
                        continue
                    n_val = float(grid_n[i])
                    v_local = float(z_vbus[j, i]) if math.isfinite(float(z_vbus[j, i])) else float(df_eval["V_bus"].mean())
                    omega_m = calc_omega_m(n_val)
                    p0_val = calc_p0_loss(n_val, final_params.p0_a, final_params.p0_b)
                    t_em = t_val + (p0_val / omega_m if abs(omega_m) > 1e-6 else 0.0)
                    if beta * abs(t_em) < 1e-9:
                        iq_val = t_em / kt0
                    else:
                        disc_sat = kt0 * kt0 - 4.0 * beta * t_em * t_em
                        if disc_sat < 0.0:
                            continue
                        iq_val = (kt0 - math.sqrt(disc_sat)) / (2.0 * beta * t_em)
                    fwd = forward_verify_point(iq_val, n_val, v_local, final_params)
                    m_norm_c = fwd["m_norm_cmd"]
                    if (not fwd["invalid_bus"]) and math.isfinite(m_norm_c) and m_norm_c <= 1.0 + 1e-6 and math.isfinite(fwd["eta_est"]):
                        z_pred[j, i] = min(99.5, max(0.0, float(fwd["eta_est"]) * 100.0))
        except Exception:
            grid_n = grid_t = z_meas = z_pred = None

    return {
        "status": status,
        "warnings": calib_warnings,
        "params": final_params,
        "rs_anchor": rs_anchor,
        "rs_eff": best_rs,
        "eval_df": df_eval,
        "metrics": {
            "MAE_T": mae_t,
            "RMSE_T": rmse_t,
            "MAPE_T_pct": mape_t,
            "MAE_eta_pct": mae_eta,
            "RMSE_eta_pct": rmse_eta,
            "MAPE_eta_pct": mape_eta,
        },
        "validation_metrics": validation_metrics,
        "operating_envelope": operating_envelope,
        "param_sensitivity": param_sensitivity,
        "grid_n": grid_n,
        "grid_t": grid_t,
        "z_meas": z_meas,
        "z_pred": z_pred,
    }
`;

const THERMAL_EXPORTER_PY = String.raw`"""
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
`;

const APP_PY = String.raw`"""
app.py - BLDC/FOC Dyno Calibration, Runtime Iq/Vq Estimation & 6-MOS Exporter (V2.0)
Run locally with: streamlit run app.py
"""
from __future__ import annotations

import math
import re
import numpy as np
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import streamlit as st

from dyno_calibrator import auto_map_columns, normalize_dyno_df, run_stepwise_calibration
from motor_physics import (
    MotorParams,
    SVPWM_LINEAR_LIMIT,
    calc_ke_from_no_load,
    calc_ksat,
    calc_omega_m,
    calc_p0_loss,
    calc_rs_anchor,
    forward_verify_point,
    process_runtime_log,
    solve_single_point,
)
from thermal_exporter import MAX_EXPORT_SAMPLES, synthesize_6mos_csv

st.set_page_config(page_title="FOC DynoLab V2", layout="wide")
st.markdown(
    "<style>body, .stApp { background-color: #11141B; color: #E5E9F0; }</style>",
    unsafe_allow_html=True,
)


def read_uploaded_table(uploaded_file) -> pd.DataFrame:
    name = uploaded_file.name.lower()
    if name.endswith(".csv") or name.endswith(".txt"):
        return pd.read_csv(uploaded_file)
    return pd.read_excel(uploaded_file)


def _detect_time_scale_sec(header: str) -> float:
    low = str(header).strip().lower()
    if re.search(r"(?:^|[\s_(\[（])(?:ms|msec|毫秒)(?:$|[\s_)\]）])", low):
        return 1e-3
    if re.search(r"(?:^|[\s_(\[（])(?:us|usec|µs|μs|微秒)(?:$|[\s_)\]）])", low):
        return 1e-6
    if re.search(r"(?:^|[\s_(\[（])(?:ns|nsec|纳秒)(?:$|[\s_)\]）])", low):
        return 1e-9
    if re.search(r"(?:^|[\s_(\[（])(?:min|mins|minute|minutes|分钟)(?:$|[\s_)\]）])", low):
        return 60.0
    return 1.0


def make_demo_datasets() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    rng = np.random.default_rng(13530)
    ke_true = calc_ke_from_no_load(13.5, 1450.0)
    rs_true = calc_rs_anchor(0.72, 45.0)
    beta_true = 0.0065
    p0_a, p0_b = 5.2e-4, 4.8e-7

    ol_rows = []
    for n in [300, 450, 600, 750, 900, 1050, 1200, 1350, 1450]:
        om = calc_omega_m(n)
        v_test = (n / 1450.0) * 13.5
        eq = ke_true * om
        p0 = calc_p0_loss(n, p0_a, p0_b)
        iq0 = p0 / (1.5 * eq)
        p_elec = 1.5 * (eq * iq0 + rs_true * iq0 * iq0)
        i_bus = max(0.03, 0.06 + p_elec / (0.95 * max(1.5, v_test)) + rng.uniform(-0.004, 0.004))
        v_meas = v_test + i_bus * 0.04
        ol_rows.append({"n_rpm": n, "T_Nm": 0.0, "V_bus": v_meas, "I_bus": i_bus, "P_in": v_meas * i_bus, "P_out": 0.0, "eta": 0.0})

    cl_rows = []
    for n in [300, 500, 750, 1000, 1200, 1350]:
        om = calc_omega_m(n)
        for t_tgt in [0.03, 0.06, 0.10, 0.15, 0.21, 0.27]:
            if n >= 1350 and t_tgt > 0.16:
                continue
            if n >= 1200 and t_tgt > 0.21:
                continue
            t_em = t_tgt + calc_p0_loss(n, p0_a, p0_b) / om
            iq = t_em / (1.5 * ke_true)
            for _ in range(15):
                iq = t_em / (1.5 * ke_true * calc_ksat(iq, beta_true))
            eq = ke_true * om * calc_ksat(iq, beta_true)
            p_elec = 1.5 * (eq * iq + rs_true * iq * iq)
            v_cap = 13.5 - 0.04 * (p_elec / (13.5 * 0.95))
            i_true = 0.06 + p_elec / (0.95 * v_cap)
            t_meas = t_tgt * (1.0 + rng.uniform(-0.011, 0.011))
            i_meas = i_true * (1.0 + rng.uniform(-0.009, 0.009))
            v_meas = v_cap + i_meas * 0.04 + rng.uniform(-0.015, 0.015)
            p_in = v_meas * i_meas
            p_out = t_meas * om
            cl_rows.append({"n_rpm": n, "T_Nm": t_meas, "V_bus": v_meas, "I_bus": i_meas, "P_in": p_in, "P_out": p_out, "eta": p_out / p_in})

    dt = 0.002
    log_rows = []
    for i in range(1200):
        t = i * dt
        if t < 0.35:
            n, i_bus, v_meas = 1000.0, 0.052 + rng.uniform(-0.009, 0.009), 13.52
        else:
            if t < 0.90:
                n, iq = 1000.0, 1.44
            elif t < 1.35:
                n, iq = 950.0, 3.55
            elif t < 1.75:
                n, iq = 1380.0, 2.05
            elif t < 2.10:
                n, iq = 1100.0, -1.1
            else:
                n, iq = 18.0, 2.4
            om = calc_omega_m(n)
            eq = ke_true * om * calc_ksat(iq, beta_true)
            p_elec = 1.5 * (eq * iq + rs_true * iq * iq)
            p_dc = p_elec / 0.95 if p_elec >= 0 else p_elec * 0.95
            i_bus = 0.06 + p_dc / 13.5 + 0.08 * np.sin(2.0 * np.pi * 140.0 * t) + rng.uniform(-0.03, 0.03)
            v_meas = 13.5 + i_bus * 0.04
        log_rows.append({"Time": round(t, 4), "V_bus": round(v_meas, 4), "I_bus": round(i_bus, 4), "n_rpm": n})

    return pd.DataFrame(ol_rows), pd.DataFrame(cl_rows), pd.DataFrame(log_rows)


def trigger_calibration(ol_map: dict[str, str], cl_map: dict[str, str], torque_unit: str, eta_fmt: str, ke_source: str, man_n0: float, man_vtest: float, man_kv: float, rs_mode: str, ol_mod_depth: float = 1.0) -> None:
    norm_ol = normalize_dyno_df(st.session_state["df_ol"], ol_map, torque_unit=torque_unit, eta_format=eta_fmt, require_torque=False)
    norm_cl = normalize_dyno_df(st.session_state["df_cl"], cl_map, torque_unit=torque_unit, eta_format=eta_fmt, require_torque=True)
    report = run_stepwise_calibration(
        norm_ol,
        norm_cl,
        st.session_state["params"],
        ke_source=ke_source,
        manual_n0=man_n0,
        manual_vtest=man_vtest,
        manual_kv=man_kv,
        rs_fit_mode=rs_mode,
        open_loop_mod_depth=ol_mod_depth,
    )
    report["warnings"] = list(norm_ol.attrs.get("warnings", [])) + list(norm_cl.attrs.get("warnings", [])) + list(report.get("warnings", []))
    st.session_state["calib_report"] = report
    st.session_state["params"] = report["params"]


if "params" not in st.session_state:
    st.session_state["params"] = MotorParams()
if "df_ol" not in st.session_state:
    ol, cl, lg = make_demo_datasets()
    st.session_state["df_ol"] = ol
    st.session_state["df_cl"] = cl
    st.session_state["df_log"] = lg
    st.session_state["ol_sig"] = "demo"
    st.session_state["cl_sig"] = "demo"
if "tab2_point" not in st.session_state:
    st.session_state["tab2_point"] = {"v": 13.5, "i": 1.06, "n": 1000.0}
if "exp_v" not in st.session_state:
    st.session_state["exp_v"] = 13.5
    st.session_state["exp_i"] = 1.06
    st.session_state["exp_n"] = 1000.0

if "calib_report" not in st.session_state:
    default_map = {c: c for c in ["n_rpm", "T_Nm", "V_bus", "I_bus", "P_in", "P_out", "eta"]}
    trigger_calibration(default_map, default_map, "Nm", "0-1", "open_loop_auto", 1450.0, 13.5, 107.4, "locked")

hdr_l, hdr_r = st.columns([4, 1])
hdr_l.title("FOC DynoLab V2 — BLDC/FOC 测功仪标定、运行态推算与 6-MOS 波形导出")
if hdr_r.button("载入 13.5V/30W Demo 数据", type="primary"):
    st.session_state["params"] = MotorParams()
    ol, cl, lg = make_demo_datasets()
    st.session_state["df_ol"] = ol
    st.session_state["df_cl"] = cl
    st.session_state["df_log"] = lg
    st.session_state["ol_sig"] = "demo"
    st.session_state["cl_sig"] = "demo"
    default_map = {c: c for c in ["n_rpm", "T_Nm", "V_bus", "I_bus", "P_in", "P_out", "eta"]}
    trigger_calibration(default_map, default_map, "Nm", "0-1", "open_loop_auto", 1450.0, 13.5, 107.4, "locked")
    st.rerun()

with st.sidebar:
    st.header("电机与逆变器参数")
    p = st.session_state["params"]
    p.pole_pairs = int(st.number_input("极对数 p", 1, 40, int(p.pole_pairs)))
    p.r_ll_25 = st.number_input("线电阻 R_LL@25°C (Ω)", 0.005, 50.0, float(p.r_ll_25), format="%.4f")
    p.t_coil = st.number_input("绕组温度 T_coil (°C)", -20.0, 180.0, float(p.t_coil))
    p.l_ll_mh = st.number_input("线电感 L_LL (mH)", 0.01, 50.0, float(p.l_ll_mh), format="%.3f")
    p.n0_rpm = st.number_input("空载参考转速 n0 (RPM)", 10.0, 30000.0, float(p.n0_rpm), format="%.1f")
    p.ke_prime = st.number_input("反电势常数 Ke' (Vpeak/(rad/s))", 0.001, 5.0, float(p.ke_prime), format="%.5f")
    p.beta_sat = st.number_input("磁饱和系数 β (1/A²)", 0.0, 0.5, float(p.beta_sat), format="%.5f")
    p.p0_a = st.number_input("铁损线性系数 a (W/RPM)", 0.0, 1.0, float(p.p0_a), format="%.6f")
    p.p0_b = st.number_input("风摩二次系数 b (W/RPM²)", 0.0, 0.01, float(p.p0_b), format="%.8f")
    p.i_idle = st.number_input("逆变器静态电流 I_idle (A)", 0.0, 5.0, float(p.i_idle), format="%.3f")
    p.eta_inv = st.number_input("逆变级效率 η_inv", 0.5, 0.999, float(p.eta_inv), format="%.3f")
    p.i_deadband = st.number_input("零漂死区 |I_net| < (A)", 0.0, 0.2, float(p.i_deadband), format="%.3f")
    p.r_line = st.number_input("母线线阻 R_line (Ω)", 0.0, 1.0, float(p.r_line), format="%.4f")
    p.rds_on_mohm = st.number_input("MOSFET Rds(on) (mΩ)", 0.5, 200.0, float(p.rds_on_mohm), format="%.1f")
    p.t_dead_ns = st.number_input("死区时间 t_dead (ns)", 0.0, 3000.0, float(p.t_dead_ns), format="%.0f")
    p.f_sw_khz = st.number_input("开关频率 f_sw (kHz)", 1.0, 200.0, float(p.f_sw_khz), format="%.1f")
    p.v_sd = st.number_input("体二极管压降 V_SD (V)", 0.2, 2.5, float(p.v_sd), format="%.2f")

tab1, tab2, tab3 = st.tabs(["Tab 1: 测功仪标定与 2D Map", "Tab 2: 运行态推算与告警", "Tab 3: 6-MOS 波形与参数导出"])

with tab1:
    u_col1, u_col2 = st.columns(2)
    with u_col1:
        st.subheader("1A. 开环空载特性数据")
        up_ol = st.file_uploader("上传开环 CSV / Excel", type=["csv", "xlsx", "xls", "txt"], key="up_ol")
        if up_ol is not None:
            sig = f"{up_ol.name}:{up_ol.size}"
            if sig != st.session_state.get("ol_sig"):
                st.session_state["df_ol"] = read_uploaded_table(up_ol)
                st.session_state["ol_sig"] = sig
                st.session_state["need_recalib"] = True

        ol_cols = [""] + list(st.session_state["df_ol"].columns)
        ol_auto = auto_map_columns(list(st.session_state["df_ol"].columns))
        oc1, oc2, oc3, oc4 = st.columns(4)
        ol_map = {
            "n_rpm": oc1.selectbox("开环转速", ol_cols, index=ol_cols.index(ol_auto["n_rpm"]) if ol_auto["n_rpm"] in ol_cols else 0, key="ol_n"),
            "T_Nm": oc2.selectbox("开环扭矩(可选)", ol_cols, index=ol_cols.index(ol_auto["T_Nm"]) if ol_auto["T_Nm"] in ol_cols else 0, key="ol_t"),
            "V_bus": oc3.selectbox("开环电压", ol_cols, index=ol_cols.index(ol_auto["V_bus"]) if ol_auto["V_bus"] in ol_cols else 0, key="ol_v"),
            "I_bus": oc4.selectbox("开环电流", ol_cols, index=ol_cols.index(ol_auto["I_bus"]) if ol_auto["I_bus"] in ol_cols else 0, key="ol_i"),
        }

        ke_source = st.selectbox("Ke' 初值来源", ["open_loop_auto", "manual_n0_vtest", "manual_kv"], key="ke_src")
        man_n0, man_vtest, man_kv, ol_mod_depth = 1450.0, 13.5, 107.4, 1.0
        if ke_source == "open_loop_auto":
            ol_mod_depth = float(st.number_input("开环调制比 m_norm (若非满调制可修正；线性 SVPWM 上限 1.0)", 0.1, 1.0, 1.0, format="%.3f", key="ol_mod"))
        elif ke_source == "manual_n0_vtest":
            kc1, kc2 = st.columns(2)
            man_n0 = kc1.number_input("空载转速 n0 (RPM)", 10.0, 30000.0, 1450.0)
            man_vtest = kc2.number_input("测试母线 V_test (V)", 1.0, 200.0, 13.5)
        elif ke_source == "manual_kv":
            man_kv = st.number_input("电机 KV (RPM/V)", 1.0, 10000.0, 107.4)

    with u_col2:
        st.subheader("1B. 闭环测功仪负载数据")
        up_cl = st.file_uploader("上传闭环 CSV / Excel", type=["csv", "xlsx", "xls", "txt"], key="up_cl")
        if up_cl is not None:
            sig = f"{up_cl.name}:{up_cl.size}"
            if sig != st.session_state.get("cl_sig"):
                st.session_state["df_cl"] = read_uploaded_table(up_cl)
                st.session_state["cl_sig"] = sig
                st.session_state["need_recalib"] = True

        cl_cols = [""] + list(st.session_state["df_cl"].columns)
        cl_auto = auto_map_columns(list(st.session_state["df_cl"].columns))
        cc1, cc2, cc3, cc4 = st.columns(4)
        cl_map = {
            "n_rpm": cc1.selectbox("转速 n_rpm", cl_cols, index=cl_cols.index(cl_auto["n_rpm"]) if cl_auto["n_rpm"] in cl_cols else 0, key="cl_n"),
            "T_Nm": cc2.selectbox("扭矩 T", cl_cols, index=cl_cols.index(cl_auto["T_Nm"]) if cl_auto["T_Nm"] in cl_cols else 0, key="cl_t"),
            "V_bus": cc3.selectbox("母线 V_bus", cl_cols, index=cl_cols.index(cl_auto["V_bus"]) if cl_auto["V_bus"] in cl_cols else 0, key="cl_v"),
            "I_bus": cc4.selectbox("电流 I_bus", cl_cols, index=cl_cols.index(cl_auto["I_bus"]) if cl_auto["I_bus"] in cl_cols else 0, key="cl_i"),
        }
        cc5, cc6, cc7 = st.columns(3)
        cl_map["P_in"] = cc5.selectbox("P_in (缺省补算)", cl_cols, index=cl_cols.index(cl_auto["P_in"]) if cl_auto["P_in"] in cl_cols else 0, key="cl_pin")
        cl_map["P_out"] = cc6.selectbox("P_out (缺省补算)", cl_cols, index=cl_cols.index(cl_auto["P_out"]) if cl_auto["P_out"] in cl_cols else 0, key="cl_pout")
        cl_map["eta"] = cc7.selectbox("效率 eta (缺省补算)", cl_cols, index=cl_cols.index(cl_auto["eta"]) if cl_auto["eta"] in cl_cols else 0, key="cl_eta")

        sc1, sc2, sc3 = st.columns(3)
        torque_unit = sc1.selectbox("扭矩单位", ["Nm", "mNm", "kgf_cm"])
        eta_fmt = sc2.selectbox("效率格式", ["0-1", "percent"])
        rs_mode = sc3.selectbox("Rs_eff 防过拟合策略", ["locked", "bounded_15pct"])

    run_btn = st.button("执行分步标定", type="primary")
    if run_btn or st.session_state.pop("need_recalib", False):
        trigger_calibration(ol_map, cl_map, torque_unit, eta_fmt, ke_source, man_n0, man_vtest, man_kv, rs_mode, ol_mod_depth)
        st.rerun()

    report = st.session_state["calib_report"]
    calib_status = report.get("status", "ok")
    if calib_status == "failed":
        st.error("标定状态：FAILED（参数或残差异常，结果不可信，请检查下方告警）")
    elif calib_status == "warn":
        st.warning("标定状态：WARN（存在收敛/偏差/数据源提示，请核对下方告警）")
    for w in report.get("warnings", []):
        st.warning(w)

    if report.get("status") == "empty_data":
        st.warning("闭环有效测点为空，请先上传有效测功数据并核对列名映射。")
    else:
        m = report["metrics"]
        k1, k2, k3, k4 = st.columns(4)
        k1.metric("Torque MAE / RMSE", f"{m['MAE_T']:.4f} / {m['RMSE_T']:.4f} N·m")
        k2.metric("Torque MAPE", f"{m['MAPE_T_pct']:.2f} %")
        k3.metric("Eta MAPE", f"{m['MAPE_eta_pct']:.2f} %")
        k4.metric("Rs_eff / β", f"{report['rs_eff']:.4f} Ω / {report['params'].beta_sat:.5f}")

        val_m = report.get("validation_metrics")
        env = report.get("operating_envelope")
        sens = report.get("param_sensitivity")
        audit_parts = []
        if val_m:
            audit_parts.append(
                f"20% 留出交叉验证 ({val_m['holdout_count']}点): MAE_T={val_m['val_mae_T']:.4f} N·m, MAPE_T={val_m['val_mape_T_pct']:.1f}%, MAE_η={val_m['val_mae_eta_pct']:.2f}%"
            )
        if env:
            audit_parts.append(
                f"有效测功边界: {env['min_rpm']:.0f}~{env['max_rpm']:.0f} RPM, {env['min_T_Nm']:.3f}~{env['max_T_Nm']:.3f} N·m, {env['min_V_bus']:.1f}~{env['max_V_bus']:.1f} V"
            )
        if sens:
            audit_parts.append(
                f"参数敏感度: Rs+10%→ΔMAE {sens['rs_plus_10pct_delta_mae']:+.4f} N·m, Ke'+5%→ΔMAE {sens['ke_plus_5pct_delta_mae']:+.4f} N·m"
            )
        if audit_parts:
            st.caption(" | ".join(audit_parts))

        df_eval = report["eval_df"].sort_values(["n_rpm", "T_Nm"]).reset_index(drop=True)
        fig_cmp = make_subplots(rows=1, cols=2, subplot_titles=("实测 vs 预测扭矩 (N·m)", "实测 vs 预测效率 (%)"))
        fig_cmp.add_trace(go.Scatter(y=df_eval["T_Nm"], name="T_meas", mode="lines+markers", line=dict(dash="dash", color="#94A3B8")), row=1, col=1)
        fig_cmp.add_trace(go.Scatter(y=df_eval["T_est"], name="T_est", mode="lines+markers", line=dict(color="#06B6D4")), row=1, col=1)
        fig_cmp.add_trace(go.Scatter(y=df_eval["eta"] * 100.0, name="eta_meas", mode="lines+markers", line=dict(dash="dash", color="#94A3B8")), row=1, col=2)
        fig_cmp.add_trace(go.Scatter(y=df_eval["eta_est"] * 100.0, name="eta_est", mode="lines+markers", line=dict(color="#F59E0B")), row=1, col=2)
        fig_cmp.update_layout(template="plotly_dark", height=340)
        st.plotly_chart(fig_cmp, use_container_width=True)

        if report["grid_n"] is not None:
            fig = make_subplots(rows=1, cols=2, subplot_titles=("实测效率 Map η(n, T)", "模型重构效率 Map η(n, T)"))
            fig.add_trace(go.Heatmap(x=report["grid_n"], y=report["grid_t"], z=report["z_meas"], colorscale="Viridis"), row=1, col=1)
            fig.add_trace(go.Heatmap(x=report["grid_n"], y=report["grid_t"], z=report["z_pred"], colorscale="Viridis"), row=1, col=2)
            fig.update_layout(template="plotly_dark", height=400)
            st.plotly_chart(fig, use_container_width=True)
            st.caption("注：图中空白四角为实测凸包外区域（不做盲目外推）。")
        else:
            st.info("当前数据为单转速或单扭矩 1D 曲线（或点数不足 4 个），已自动跳过 2D 效率 Map 插值。")

with tab2:
    col_rev, col_fwd = st.columns(2)
    with col_rev:
        st.subheader("逆向推算：(V_meas, I_bus, n) → Iq & 双 Vq")
        c1, c2, c3 = st.columns(3)
        v_pt = c1.number_input("实测母线 V_meas (V)", -20.0, 200.0, float(st.session_state["tab2_point"]["v"]), format="%.2f")
        i_pt = c2.number_input("实测母线电流 I_bus (A)", -30.0, 100.0, float(st.session_state["tab2_point"]["i"]), format="%.3f")
        n_pt = c3.number_input("电机转速 n (RPM)", -30000.0, 30000.0, float(st.session_state["tab2_point"]["n"]), format="%.1f")
        st.session_state["tab2_point"] = {"v": v_pt, "i": i_pt, "n": n_pt}

        res = solve_single_point(v_pt, i_pt, n_pt, st.session_state["params"])
        st.write({
            "Iq (A)": round(res["iq"], 4) if math.isfinite(res["iq"]) else None,
            "Iph_rms (A)": round(res["iph_rms"], 4) if math.isfinite(res["iph_rms"]) else None,
            "T_est (N·m)": round(res["t_est"], 5) if math.isfinite(res["t_est"]) else None,
            "Vq_motor (V)": round(res["vq_motor"], 3) if math.isfinite(res["vq_motor"]) else None,
            "Vq_cmd (V)": round(res["vq_cmd"], 3) if math.isfinite(res["vq_cmd"]) else None,
            "m_motor": round(res["m_motor"], 4) if math.isfinite(res["m_motor"]) else None,
            "m_cmd": round(res["m_cmd"], 4) if math.isfinite(res["m_cmd"]) else None,
            "phi (°)": round(res["phi_deg"], 2) if math.isfinite(res["phi_deg"]) else None,
            "mode": res["mode"],
        })
        if st.button("发送当前单点到 Tab 3 导出区"):
            st.session_state["exp_v"] = v_pt
            st.session_state["exp_i"] = i_pt
            st.session_state["exp_n"] = n_pt
            st.success("已同步至 Tab 3（可切换至 Tab 3 查看并下载 CSV）。")

    with col_fwd:
        st.subheader("正向校验：(Iq, n, V_meas) → 反算 I_bus")
        fc1, fc2, fc3 = st.columns(3)
        f_iq = fc1.number_input("给定相电流 Iq (A)", -50.0, 100.0, 1.44, format="%.3f")
        f_n = fc2.number_input("转速 n (RPM)", -30000.0, 30000.0, 1000.0, format="%.1f", key="fwd_n")
        f_v = fc3.number_input("母线 V_meas (V)", 0.5, 200.0, 13.5, format="%.2f", key="fwd_v")
        fwd = forward_verify_point(f_iq, f_n, f_v, st.session_state["params"])
        st.write({
            "I_bus_est (A)": round(fwd["i_bus_est"], 5),
            "T_est (N·m)": round(fwd["t_est"], 5),
            "Vq_motor (V)": round(fwd["vq_motor"], 3),
            "Vq_cmd (V)": round(fwd["vq_cmd"], 3) if math.isfinite(fwd["vq_cmd"]) else None,
            "m_motor / m_cmd": f"{fwd['m_motor']:.4f} / {fwd['m_cmd']:.4f}" if math.isfinite(fwd["m_motor"]) else "invalid_bus",
            "phi (°)": round(fwd["phi_deg"], 2),
        })

    if res["alert_invalid_bus"]:
        st.error(f"母线压降异常：V_meas ({v_pt:.2f}V) - I_bus·R_line <= 0.1V，已拒绝计算失真数据。")
    if res["alert_regen_limit"]:
        st.error(f"超出最大发电回馈功率极限 Eq²/(4·Rs) (Δ = {res['delta']:.3f} < 0)，反推相电流无实数解。")
    if res["alert_zero_drift"]:
        st.info(f"空载零漂区 (|I_net| < {st.session_state['params'].i_deadband:.3f} A)：按 Iq=0 空载滑行处理（T_est = -P0/ω_m），避免误判为发电回馈。")
    if res["alert_iq_sign_ambiguous"]:
        st.warning("相电流符号/多根歧义：零速堵转 (±Iq 功耗对称) 或发电制动存在二次方程双根（当前取铜耗较小根），请结合相电流/转速方向确认。")
    if res["alert_low_speed"]:
        st.warning(f"低速信噪比告警：|n|={abs(n_pt):.0f} < 0.08·n0 ({0.08 * st.session_state['params'].n0_rpm:.0f} RPM)")
    if res["alert_cmd_sat"] or res["alert_motor_sat"]:
        st.warning(f"电压饱和告警：m_motor={res['m_motor']:.3f}, m_cmd={res['m_cmd']:.3f} (SVPWM 极限 {SVPWM_LINEAR_LIMIT:.4f})")
    if res["alert_low_freq"]:
        st.error(f"堵转/极低频发热告警：f_e = {res['fe_hz']:.2f} Hz < 3 Hz")

    st.divider()
    st.subheader("批量运行日志 CSV 推算与滤波")
    up_log = st.file_uploader("上传运行日志 CSV (Time, V_bus, I_bus, n_rpm)", type=["csv", "xlsx", "xls", "txt"], key="up_log")
    if up_log is not None:
        df_raw_log = read_uploaded_table(up_log)
        t_col = ""
        v_col = ""
        i_col = ""
        n_col = ""
        for col in df_raw_log.columns:
            low = str(col).strip().lower()
            if not t_col and re.search(r"^(time|t(_?(s|ms|us|usec|µs|μs|ns|min))?(\s*[\[(（].*[\])）])?)$|time|timestamp|t_?sec|时间", low):
                t_col = col
            elif not v_col and re.search(r"v_?bus|v_?meas|vbus|volt|电压", low):
                v_col = col
            elif not i_col and re.search(r"i_?bus|ibus|curr|电流", low):
                i_col = col
            elif not n_col and re.search(r"n_?rpm|rpm|speed|转速", low):
                n_col = col
        if v_col and i_col and n_col:
            df_clean = pd.DataFrame({
                "V_bus": pd.to_numeric(df_raw_log[v_col], errors="coerce"),
                "I_bus": pd.to_numeric(df_raw_log[i_col], errors="coerce"),
                "n_rpm": pd.to_numeric(df_raw_log[n_col], errors="coerce"),
            })
            if t_col:
                t_scale = _detect_time_scale_sec(t_col)
                df_clean["Time"] = pd.to_numeric(df_raw_log[t_col], errors="coerce") * t_scale
            else:
                df_clean["Time"] = np.arange(len(df_clean)) * 0.002
            df_clean = df_clean.dropna(subset=["V_bus", "I_bus", "n_rpm"]).reset_index(drop=True)
            if df_clean["Time"].isna().any():
                df_clean["Time"] = np.arange(len(df_clean)) * 0.002
            st.session_state["df_log"] = df_clean
        else:
            st.error("日志缺少 V_bus / I_bus / n_rpm 列。")

    win_ms = st.slider("滑动平均滤波窗口 (ms，离线零相位中心窗)", 5, 20, 10)
    df_log_out = process_runtime_log(st.session_state["df_log"], win_ms, st.session_state["params"])
    if not df_log_out.attrs.get("time_monotonic", True):
        st.warning("检测到日志时间戳非严格单调递增，已降级为按正中位步长点数滑动滤波。")
    n_regen_lim = int(df_log_out["alert_regen_limit"].sum())
    n_inv_bus = int(df_log_out["alert_invalid_bus"].sum())
    if n_regen_lim > 0 or n_inv_bus > 0:
        st.warning(f"日志中检测到 {n_regen_lim} 个超发电极限点、{n_inv_bus} 个母线压降异常点（在曲线中以断点显示）。")

    fig_log = make_subplots(rows=3, cols=1, shared_xaxes=True, subplot_titles=("母线与相电流 (A)", "双调制比 m_motor / m_cmd", "双 q轴电压 Vq_motor / Vq_cmd (V)"))
    fig_log.add_trace(go.Scatter(x=df_log_out["time_s"], y=df_log_out["i_bus_raw"], name="I_bus_raw", line=dict(dash="dot", color="#64748B")), row=1, col=1)
    fig_log.add_trace(go.Scatter(x=df_log_out["time_s"], y=df_log_out["i_bus_filt"], name="I_bus_filt", line=dict(color="#F59E0B")), row=1, col=1)
    fig_log.add_trace(go.Scatter(x=df_log_out["time_s"], y=df_log_out["iq"], name="Iq_est", line=dict(color="#06B6D4")), row=1, col=1)
    fig_log.add_trace(go.Scatter(x=df_log_out["time_s"], y=df_log_out["m_motor"], name="m_motor", line=dict(color="#06B6D4")), row=2, col=1)
    fig_log.add_trace(go.Scatter(x=df_log_out["time_s"], y=df_log_out["m_cmd"], name="m_cmd", line=dict(color="#F43F5E")), row=2, col=1)
    fig_log.add_hline(y=SVPWM_LINEAR_LIMIT, line_dash="dash", line_color="#F59E0B", row=2, col=1)
    fig_log.add_trace(go.Scatter(x=df_log_out["time_s"], y=df_log_out["vq_motor"], name="Vq_motor", line=dict(color="#06B6D4")), row=3, col=1)
    fig_log.add_trace(go.Scatter(x=df_log_out["time_s"], y=df_log_out["vq_cmd"], name="Vq_cmd", line=dict(color="#F59E0B")), row=3, col=1)
    fig_log.update_layout(template="plotly_dark", height=680)
    st.plotly_chart(fig_log, use_container_width=True)

with tab3:
    top_t3_l, top_t3_r = st.columns([3, 1])
    top_t3_l.subheader("6-MOS 瞬态结温软件波形与参数导出区")
    if top_t3_r.button("继承 Tab 2 工况点"):
        pt = st.session_state["tab2_point"]
        st.session_state["exp_v"] = pt["v"]
        st.session_state["exp_i"] = pt["i"]
        st.session_state["exp_n"] = pt["n"]
        st.rerun()

    c1, c2, c3, c4 = st.columns(4)
    exp_v = c1.number_input("稳态 V_meas (V)", -20.0, 200.0, float(st.session_state["exp_v"]), format="%.2f", key="exp_v")
    exp_i = c2.number_input("稳态 I_bus (A)", -30.0, 100.0, float(st.session_state["exp_i"]), format="%.3f", key="exp_i")
    exp_n = c3.number_input("稳态转速 n (RPM, 0=堵转)", -30000.0, 30000.0, float(st.session_state["exp_n"]), format="%.1f", key="exp_n")
    exp_mod = c4.selectbox("占空比调制方式 (用于 Duty_A/B/C)", ["SVPWM", "DPWM1"])

    d1, d2, d3, d4 = st.columns(4)
    fs_hz = int(d1.number_input("采样率 fs (Hz)", 1000, 200000, 20000, step=1000))
    dur_s = float(d2.number_input("导出时长 (s)", 0.05, 20.0, 0.5, step=0.05))
    t_amb = float(d3.number_input("环境温度 T_amb (°C)", -20.0, 120.0, 25.0))
    inc_duty = d4.checkbox("附加 Duty_A/B/C 占空比列", value=False)

    if fs_hz * dur_s > MAX_EXPORT_SAMPLES:
        act_dur = (MAX_EXPORT_SAMPLES - 1) / float(fs_hz)
        st.warning(f"请求点数超过 {MAX_EXPORT_SAMPLES:,} 上限，实际导出时长已由 {dur_s:.3f} s 缩短为 {act_dur:.3f} s（将影响热预热与稳态收敛估算）。")

    try:
        df_wave, summary = synthesize_6mos_csv(
            exp_v, exp_i, exp_n, t_amb, exp_mod, fs_hz, dur_s, st.session_state["params"], include_duty=inc_duty
        )
        fe_val = summary["f_e (Hz)"] or 0.0
        n_preview = min(len(df_wave), 400 if fe_val < 1.0 else max(60, int(round(min(dur_s, max(0.015, 3.0 / fe_val)) * fs_hz))))
        df_prev = df_wave.iloc[:n_preview]

        st.caption("注：以下导出的波形为依据电机与逆变器物理方程合成的稳态相电流/占空比（不含实测示波器开关振铃与死区畸变）。")
        fig_w = go.Figure()
        fig_w.add_trace(go.Scatter(x=df_prev["Time"], y=df_prev["Ia"], name="Ia (A)", line=dict(color="#06B6D4")))
        fig_w.add_trace(go.Scatter(x=df_prev["Time"], y=df_prev["Ib"], name="Ib (A)", line=dict(color="#F59E0B")))
        fig_w.add_trace(go.Scatter(x=df_prev["Time"], y=df_prev["Ic"], name="Ic (A)", line=dict(color="#10B981")))
        fig_w.update_layout(template="plotly_dark", title="导出波形预览 (前 3 个电周期或堵转直流偏相)", xaxis_title="Time (s)", yaxis_title="Current (A)", height=340)
        st.plotly_chart(fig_w, use_container_width=True)

        st.subheader("对齐 6-MOS 模拟器参数摘要卡（同时列明 m 与 m_norm）")
        st.json(summary)
        st.download_button(
            f"下载 CSV ({len(df_wave)} 行)",
            data=df_wave.to_csv(index=False).encode("utf-8"),
            file_name="foc_6mos_waveform.csv",
            mime="text/csv",
            type="primary",
        )
    except ValueError as exc:
        st.error(f"无法导出波形：{exc}")
`;

export async function downloadPythonBundleZip(): Promise<void> {
  const zip = new JSZip();
  zip.file('requirements.txt', REQUIREMENTS_TXT);
  zip.file('motor_physics.py', MOTOR_PHYSICS_PY);
  zip.file('dyno_calibrator.py', DYNO_CALIBRATOR_PY);
  zip.file('thermal_exporter.py', THERMAL_EXPORTER_PY);
  zip.file('app.py', APP_PY);

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'bldc_foc_dyno_v2_python.zip';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export const PYTHON_BUNDLE_FILES: Array<{ name: string; content: string }> = [
  { name: 'requirements.txt', content: REQUIREMENTS_TXT },
  { name: 'motor_physics.py', content: MOTOR_PHYSICS_PY },
  { name: 'dyno_calibrator.py', content: DYNO_CALIBRATOR_PY },
  { name: 'thermal_exporter.py', content: THERMAL_EXPORTER_PY },
  { name: 'app.py', content: APP_PY },
];
