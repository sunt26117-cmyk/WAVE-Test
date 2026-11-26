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
DEFAULT_SAMPLING_GAP_FACTOR = 3.5
MIN_RUNTIME_LOG_FILTER_COVERAGE_RATIO = 0.5


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


def partition_continuous_time_segments(times: np.ndarray, gap_factor: float = DEFAULT_SAMPLING_GAP_FACTOR) -> tuple[list[tuple[int, int]], list[int], float, float]:
    n_pts = len(times)
    if n_pts == 0:
        return [], [], 0.0, float("inf")
    if n_pts == 1:
        return [(0, 0)], [], 0.0, float("inf")
    diffs = np.diff(times)
    pos_dts = diffs[np.isfinite(diffs) & (diffs > 0.0)]
    median_dt = float(np.median(pos_dts)) if len(pos_dts) > 0 else 0.0
    gap_threshold = max(1e-12, gap_factor * median_dt) if median_dt > 0.0 else float("inf")
    segments: list[tuple[int, int]] = []
    gap_indices: list[int] = []
    seg_start = 0
    for idx in range(1, n_pts):
        if float(diffs[idx - 1]) > gap_threshold:
            segments.append((seg_start, idx - 1))
            gap_indices.append(idx)
            seg_start = idx
    segments.append((seg_start, n_pts - 1))
    return segments, gap_indices, median_dt, gap_threshold


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

    segments, gap_indices, median_dt, gap_threshold = partition_continuous_time_segments(times)
    isolated_indices: list[int] = []
    low_coverage_indices: list[int] = []
    if n_pts == 0 or filter_window_ms <= 0.0:
        i_bus_filt = raw_i.copy()
    else:
        half_w = (filter_window_ms * 1e-3) * 0.5
        i_bus_filt = np.empty(n_pts, dtype=float)
        for s0, s1 in segments:
            if s0 == s1:
                if n_pts >= 2:
                    i_bus_filt[s0] = float("nan")
                    isolated_indices.append(s0)
                else:
                    i_bus_filt[s0] = raw_i[s0]
                continue
            seg_t = times[s0 : s1 + 1]
            seg_i = raw_i[s0 : s1 + 1]
            dts = np.diff(seg_t)
            trap_segs = 0.5 * (seg_i[:-1] + seg_i[1:]) * dts
            trap_prefix = np.concatenate([[0.0], np.cumsum(trap_segs)])
            left = s0
            right = s0
            for i in range(s0, s1 + 1):
                ti = times[i]
                while left < i and ti - times[left] > half_w + 1e-12:
                    left += 1
                if right < i:
                    right = i
                while right + 1 <= s1 and times[right + 1] - ti <= half_w + 1e-12:
                    right += 1
                span = times[right] - times[left]
                if span > 1e-12:
                    i_bus_filt[i] = (trap_prefix[right - s0] - trap_prefix[left - s0]) / span
                    if span + 1e-12 < MIN_RUNTIME_LOG_FILTER_COVERAGE_RATIO * (filter_window_ms * 1e-3) and (left == s0 or right == s1):
                        low_coverage_indices.append(i)
                else:
                    i_bus_filt[i] = raw_i[i]
                    low_coverage_indices.append(i)

    records = []
    held_cols = ("iq", "t_est", "m_motor", "m_cmd", "vq_motor", "vq_cmd")
    last_valid = {col: float("nan") for col in held_cols}
    isolated_set = set(isolated_indices)
    low_coverage_set = set(low_coverage_indices)
    for idx, (t, v, ib_raw, ib_f, n) in enumerate(zip(times, df["V_bus"], df["I_bus"], i_bus_filt, df["n_rpm"])):
        filter_quality = ("ISOLATED" if idx in isolated_set else ("LOW_COVERAGE" if idx in low_coverage_set else ("INVALID" if not math.isfinite(float(ib_f)) else "VALID")))
        filter_valid = filter_quality == "VALID"
        res = solve_single_point(float(v), float(ib_f) if filter_valid else float("nan"), float(n), params)
        sol_valid = bool(filter_valid and res["mode"] not in ("invalid_bus", "regen_limit") and math.isfinite(res["iq"]))
        res["time_s"] = float(t)
        res["i_bus_raw"] = float(ib_raw)
        res["i_bus_filt"] = float(ib_f) if filter_valid else float("nan")
        res["filter_valid"] = filter_valid
        res["filter_quality"] = filter_quality
        res["solution_valid"] = sol_valid
        res["is_held_prev_iq"] = bool((not sol_valid) and math.isfinite(last_valid["iq"]))
        for col in held_cols:
            if sol_valid and math.isfinite(res[col]):
                last_valid[col] = float(res[col])
                res[f"{col}_plot"] = float(res[col])
            else:
                res[f"{col}_plot"] = float(last_valid[col])
        records.append(res)
    out_df = pd.DataFrame(records)
    out_df.attrs["time_monotonic"] = monotonic
    out_df.attrs["gap_count"] = len(gap_indices)
    out_df.attrs["segment_count"] = len(segments)
    out_df.attrs["isolated_count"] = len(isolated_indices)
    out_df.attrs["low_coverage_count"] = len(low_coverage_indices)
    out_df.attrs["low_coverage_indices"] = low_coverage_indices
    out_df.attrs["median_dt_s"] = median_dt
    out_df.attrs["gap_threshold_s"] = gap_threshold
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
            "z_extrap_mask": None,
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

    # FD-02: Scaled/normalized Jacobian SVD identifiability, covariance, 95% CI & correlation matrix
    solved_cl_rows = []
    p_pre = MotorParams(**{**step3_base.__dict__, "beta_sat": best_beta, "rs_eff_override": best_rs})
    for _, row in df_closed.iterrows():
        rr = solve_single_point(float(row["V_bus"]), float(row["I_bus"]), float(row["n_rpm"]), p_pre)
        if math.isfinite(rr["t_est"]):
            solved_cl_rows.append((row, float(rr["t_est"])))

    fit_names = ["磁饱和系数 β", "等效相电阻 Rs_eff"] if rs_fit_mode == "bounded_15pct" else ["磁饱和系数 β"]
    fit_symbols = ["betaSat", "rsEff"] if rs_fit_mode == "bounded_15pct" else ["betaSat"]
    fit_units = ["A⁻²", "Ω"] if rs_fit_mode == "bounded_15pct" else ["A⁻²"]
    theta_vec = [best_beta, best_rs] if rs_fit_mode == "bounded_15pct" else [best_beta]
    scale_vec = [max(best_beta, 0.01), max(best_rs, 0.005)] if rs_fit_mode == "bounded_15pct" else [max(best_beta, 0.01)]
    j_rows = []
    res_vec = []
    h_beta = 2e-4
    h_rs = max(1e-5, 1e-3 * rs_anchor)
    for row, t_est0 in solved_cl_rows:
        vb, ib, nr, tm = float(row["V_bus"]), float(row["I_bus"]), float(row["n_rpm"]), float(row["T_Nm"])
        res_vec.append(t_est0 - tm)
        j_col = []
        if best_beta < h_beta:
            rp = solve_single_point(vb, ib, nr, MotorParams(**{**p_pre.__dict__, "beta_sat": best_beta + h_beta}))
            d_b = (rp["t_est"] - t_est0) / h_beta if math.isfinite(rp["t_est"]) else 0.0
        else:
            b_hi, b_lo = best_beta + h_beta, max(0.0, best_beta - h_beta)
            rp = solve_single_point(vb, ib, nr, MotorParams(**{**p_pre.__dict__, "beta_sat": b_hi}))
            rm = solve_single_point(vb, ib, nr, MotorParams(**{**p_pre.__dict__, "beta_sat": b_lo}))
            d_b = (rp["t_est"] - rm["t_est"]) / (b_hi - b_lo) if math.isfinite(rp["t_est"]) and math.isfinite(rm["t_est"]) and (b_hi - b_lo) > 0 else 0.0
        j_col.append(d_b)
        if rs_fit_mode == "bounded_15pct":
            rs_hi, rs_lo = best_rs + h_rs, max(1e-5, best_rs - h_rs)
            rp = solve_single_point(vb, ib, nr, MotorParams(**{**p_pre.__dict__, "rs_eff_override": rs_hi}))
            rm = solve_single_point(vb, ib, nr, MotorParams(**{**p_pre.__dict__, "rs_eff_override": rs_lo}))
            d_r = (rp["t_est"] - rm["t_est"]) / (rs_hi - rs_lo) if math.isfinite(rp["t_est"]) and math.isfinite(rm["t_est"]) and (rs_hi - rs_lo) > 0 else 0.0
            j_col.append(d_r)
        j_rows.append(j_col)

    svd_diag = _analyze_normalized_jacobian_svd(j_rows, res_vec, scale_vec, fit_names, fit_symbols, fit_units, theta_vec)
    full_rank = len(fit_symbols)
    step3_unidentifiable = (
        svd_diag["numerical_rank"] < full_rank
        or svd_diag["dof"] <= 0
        or (not math.isfinite(svd_diag["condition_number"]))
        or svd_diag["condition_number"] > 40.0
        or any(e["status"] == "NOT_IDENTIFIABLE" for e in svd_diag["entries"])
    )
    baseline_retained = False
    id_warnings = list(svd_diag["warnings"])
    if step3_unidentifiable:
        baseline_retained = True
        best_beta = max(0.0, base_params.beta_sat)
        best_rs = rs_anchor
        _elevate("warn")
        cond_txt = f"{svd_diag['condition_number']:.1f}" if math.isfinite(svd_diag["condition_number"]) else "∞"
        msg = f"闭环参数辨识退化 (NOT_IDENTIFIABLE: 秩 {svd_diag['numerical_rank']}/{full_rank}, κ={cond_txt}, dof={svd_diag['dof']})；已保留基准 β={best_beta:.5f}, Rs_eff={best_rs:.4f} Ω。"
        id_warnings.append(msg)
        calib_warnings.append(msg)
    elif svd_diag["overall_status"] == "WEAKLY_IDENTIFIABLE":
        _elevate("warn")
        msg = f"闭环参数弱可辨识 (WEAKLY_IDENTIFIABLE: κ={svd_diag['condition_number']:.1f})，建议补充跨负载/跨转速测点。"
        id_warnings.append(msg)
        calib_warnings.append(msg)

    identifiability_report = {
        "overall_status": "NOT_IDENTIFIABLE" if step3_unidentifiable else ("WEAKLY_IDENTIFIABLE" if (svd_diag["overall_status"] == "WEAKLY_IDENTIFIABLE" or not p0_identifiable) else "IDENTIFIABLE"),
        "condition_number": svd_diag["condition_number"],
        "numerical_rank": svd_diag["numerical_rank"],
        "full_rank": full_rank,
        "singular_values": svd_diag["singular_values"],
        "residual_rms_nm": svd_diag["residual_rms_nm"],
        "dof": svd_diag["dof"],
        "entries": [
            *[
                {**e, "value": (best_beta if idx == 0 else best_rs), "std_error": float("nan"), "ci95_low": float("nan"), "ci95_high": float("nan"), "status": "NOT_IDENTIFIABLE"}
                if step3_unidentifiable else e
                for idx, e in enumerate(svd_diag["entries"])
            ],
            {
                "name": "q 轴电感 Lq", "symbol": "Lq", "unit": "H",
                "value": calc_lq_h(base_params.l_ll_mh), "std_error": float("nan"),
                "ci95_low": float("nan"), "ci95_high": float("nan"), "relative_ci_pct": float("nan"),
                "status": "FIXED",
                "reason": f"由用户输入线间电感 L_LL={base_params.l_ll_mh:.4f}mH 按当前 Y 接假设换算为 Lq=L_LL/2；本次 Dyno 数据未独立辨识 Lq，也不是实测 Lq。",
            },
        ],
        "correlation_matrix": svd_diag["correlation_matrix"],
        "high_collinearity_pairs": svd_diag["high_collinearity_pairs"],
        "p0_condition_number": p0_design_condition_number,
        "p0_identifiable": p0_identifiable,
        "baseline_retained": baseline_retained,
        "warnings": id_warnings,
    }

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

    # Safe 2D Efficiency Map: linear interpolation inside convex hull, nearest-neighbor exterior fill marked untrusted
    grid_n = grid_t = z_meas = z_pred = z_extrap_mask = None
    if len(df_eval) >= 4 and df_eval["n_rpm"].nunique() >= 2 and df_eval["T_Nm"].nunique() >= 2:
        try:
            grid_n = np.linspace(df_eval["n_rpm"].min(), df_eval["n_rpm"].max(), 30)
            grid_t = np.linspace(df_eval["T_Nm"].min(), df_eval["T_Nm"].max(), 24)
            gn, gt = np.meshgrid(grid_n, grid_t)
            z_meas_linear = griddata((df_eval["n_rpm"], df_eval["T_Nm"]), df_eval["eta"] * 100.0, (gn, gt), method="linear")
            z_vbus_linear = griddata((df_eval["n_rpm"], df_eval["T_Nm"]), df_eval["V_bus"], (gn, gt), method="linear")
            z_extrap_mask = ~np.isfinite(z_meas_linear)
            z_meas_nearest = griddata((df_eval["n_rpm"], df_eval["T_Nm"]), df_eval["eta"] * 100.0, (gn, gt), method="nearest")
            z_vbus_nearest = griddata((df_eval["n_rpm"], df_eval["T_Nm"]), df_eval["V_bus"], (gn, gt), method="nearest")
            z_meas = np.where(z_extrap_mask, z_meas_nearest, z_meas_linear)
            z_vbus = np.where(~np.isfinite(z_vbus_linear), z_vbus_nearest, z_vbus_linear)
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
            grid_n = grid_t = z_meas = z_pred = z_extrap_mask = None

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
        "identifiability_report": identifiability_report,
        "grid_n": grid_n,
        "grid_t": grid_t,
        "z_meas": z_meas,
        "z_pred": z_pred,
        "z_extrap_mask": z_extrap_mask,
    }


def _t_critical_95(dof: int) -> float:
    if dof <= 0:
        return math.inf
    table = [
        12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
        2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
        2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
    ]
    return table[dof - 1] if dof <= 30 else 1.96


def _analyze_normalized_jacobian_svd(
    j_raw: list[list[float]],
    residuals: list[float],
    scales: list[float],
    names: list[str],
    symbols: list[str],
    units: list[str],
    values: list[float],
) -> dict:
    m = len(j_raw)
    p = len(symbols)
    warnings: list[str] = []
    if m == 0 or p == 0:
        return {
            "overall_status": "NOT_IDENTIFIABLE",
            "condition_number": math.inf,
            "numerical_rank": 0,
            "singular_values": [],
            "residual_rms_nm": float("nan"),
            "dof": 0,
            "entries": [
                {"name": names[i], "symbol": sym, "unit": units[i], "value": values[i],
                 "std_error": float("nan"), "ci95_low": float("nan"), "ci95_high": float("nan"),
                 "relative_ci_pct": float("nan"), "status": "NOT_IDENTIFIABLE", "reason": "有效样本不足"}
                for i, sym in enumerate(symbols)
            ],
            "correlation_matrix": {"names": symbols, "matrix": []},
            "high_collinearity_pairs": [],
            "warnings": ["有效样本为 0"],
        }

    j_mat = np.asarray(j_raw, dtype=float)
    s_vec = np.asarray(scales, dtype=float)
    j_norm = np.where(np.isfinite(j_mat), j_mat, 0.0) * s_vec[None, :]
    _u, sigmas, vt = np.linalg.svd(j_norm, full_matrices=False)
    v = vt.T
    s_max = float(sigmas[0]) if len(sigmas) else 0.0
    rank_tol = max(1e-8, max(m, p) * 1e-8 * max(s_max, 1e-12))
    rank = int(np.sum(sigmas > rank_tol))
    s_min = float(sigmas[p - 1]) if len(sigmas) == p else 0.0
    cond = float(s_max / s_min) if (rank == p and s_min > 1e-12) else math.inf

    r_arr = np.asarray(residuals, dtype=float)
    rss = float(np.sum(np.where(np.isfinite(r_arr), r_arr * r_arr, 0.0)))
    dof = max(0, m - rank)
    rms = math.sqrt(rss / dof) if dof > 0 else float("nan")
    s2 = rss / dof if dof > 0 else float("nan")
    t_crit = _t_critical_95(dof)

    null_energy = [float(np.sum(v[j, rank:] ** 2)) if rank < p else 0.0 for j in range(p)]
    cov = np.full((p, p), float("nan"), dtype=float)
    corr = np.full((p, p), float("nan"), dtype=float)
    for i in range(p):
        corr[i, i] = 1.0
    if math.isfinite(s2) and rank > 0:
        v_r = v[:, :rank]
        inv_s2 = 1.0 / (sigmas[:rank] ** 2)
        cov_norm = s2 * (v_r * inv_s2[None, :]) @ v_r.T
        cov = cov_norm * np.outer(s_vec, s_vec)

    high_pairs = []
    for a in range(p):
        for b in range(p):
            if a == b:
                continue
            if null_energy[a] < 0.05 and null_energy[b] < 0.05 and math.isfinite(cov[a, a]) and cov[a, a] > 0 and math.isfinite(cov[b, b]) and cov[b, b] > 0:
                c = max(-1.0, min(1.0, float(cov[a, b] / math.sqrt(cov[a, a] * cov[b, b]))))
                corr[a, b] = c
                if a < b and abs(c) >= 0.90:
                    high_pairs.append({"paramA": symbols[a], "paramB": symbols[b], "correlation": c})

    if high_pairs:
        warnings.append("检测到参数强共线性 (|r| >= 0.90)。")

    entries = []
    for j, sym in enumerate(symbols):
        is_null = null_energy[j] >= 0.05 or rank == 0
        se = math.sqrt(float(cov[j, j])) if (not is_null and math.isfinite(cov[j, j]) and cov[j, j] >= 0) else float("nan")
        ci_half = t_crit * se if math.isfinite(se) and math.isfinite(t_crit) else float("nan")
        rel_ci = (ci_half / max(abs(values[j]), scales[j] * 0.1) * 100.0) if math.isfinite(ci_half) else float("nan")
        if is_null or dof <= 0 or (not math.isfinite(cond)) or cond > 40.0:
            st_p = "NOT_IDENTIFIABLE"
            rsn = f"秩亏/条件数 κ={cond:.1f}" if math.isfinite(cond) else "奇异值退化或样本不足"
        elif cond > 15.0 or (math.isfinite(rel_ci) and rel_ci > 50.0) or any(pr["paramA"] == sym or pr["paramB"] == sym for pr in high_pairs):
            st_p = "WEAKLY_IDENTIFIABLE"
            rsn = f"条件数 κ={cond:.1f} 或相关性/CI 偏高"
        else:
            st_p = "IDENTIFIABLE"
            rsn = f"95% CI 相对半宽 {rel_ci:.1f}%"
        entries.append({
            "name": names[j],
            "symbol": sym,
            "unit": units[j],
            "value": float(values[j]),
            "std_error": se,
            "ci95_low": float(values[j] - ci_half) if math.isfinite(ci_half) else float("nan"),
            "ci95_high": float(values[j] + ci_half) if math.isfinite(ci_half) else float("nan"),
            "relative_ci_pct": rel_ci,
            "status": st_p,
            "reason": rsn,
        })

    overall = (
        "NOT_IDENTIFIABLE" if (rank < p or dof <= 0 or (not math.isfinite(cond)) or cond > 40.0 or any(e["status"] == "NOT_IDENTIFIABLE" for e in entries))
        else ("WEAKLY_IDENTIFIABLE" if (any(e["status"] == "WEAKLY_IDENTIFIABLE" for e in entries) or high_pairs) else "IDENTIFIABLE")
    )
    return {
        "overall_status": overall,
        "condition_number": cond,
        "numerical_rank": rank,
        "singular_values": [float(x) for x in sigmas],
        "residual_rms_nm": rms,
        "dof": dof,
        "entries": entries,
        "correlation_matrix": {"names": symbols, "matrix": [[float(x) for x in row] for row in corr]},
        "high_collinearity_pairs": high_pairs,
        "warnings": warnings,
    }


def analyze_dynamic_identifiability(
    samples: list[dict],
    baseline_j: float = 1e-4,
    baseline_b: float = 1e-4,
    baseline_kt: float = 0.08,
) -> dict:
    valid = [
        s for s in samples
        if all(math.isfinite(float(s.get(k, float("nan")))) for k in ("omega_m", "domega_dt", "iq", "t_load"))
    ]
    scales = [max(abs(baseline_j), 1e-4), max(abs(baseline_b), 1e-4), max(abs(baseline_kt), 0.05)]
    names = ["转动惯量 J", "粘滞阻尼 B", "转矩常数 Kt"]
    symbols = ["J", "B", "Kt"]
    units = ["kg·m²", "N·m·s/rad", "N·m/A"]
    if len(valid) < 4:
        return {
            "overall_status": "NOT_IDENTIFIABLE",
            "J": baseline_j, "B": baseline_b, "Kt": baseline_kt,
            "condition_number": math.inf, "numerical_rank": 0, "full_rank": 3,
            "baseline_retained": True, "warnings": ["动态样本不足 4 点，保留基准参数。"],
        }
    x_raw = [[-float(s["domega_dt"]), -float(s["omega_m"]), float(s["iq"])] for s in valid]
    x_norm = np.asarray(x_raw, dtype=float) * np.asarray(scales, dtype=float)[None, :]
    u, sigmas, vt = np.linalg.svd(x_norm, full_matrices=False)
    v = vt.T
    s_max = float(sigmas[0]) if len(sigmas) else 0.0
    rank_tol = max(1e-8, len(valid) * 1e-8 * max(s_max, 1e-12))
    rank = int(np.sum(sigmas > rank_tol))
    y_vec = np.asarray([float(s["t_load"]) for s in valid], dtype=float)
    theta_norm = np.zeros(3, dtype=float)
    if rank > 0:
        theta_norm = (v[:, :rank] @ ((u[:, :rank].T @ y_vec) / sigmas[:rank]))
    theta_hat = [float(theta_norm[j] * scales[j]) for j in range(3)]
    cond_pre = float(s_max / sigmas[2]) if (rank == 3 and sigmas[2] > 1e-12) else math.inf
    unident_pre = rank < 3 or (not math.isfinite(cond_pre)) or cond_pre > 40.0
    used_theta = [baseline_j, baseline_b, baseline_kt] if unident_pre else theta_hat
    residuals = [used_theta[2] * float(s["iq"]) - used_theta[0] * float(s["domega_dt"]) - used_theta[1] * float(s["omega_m"]) - float(s["t_load"]) for s in valid]
    diag = _analyze_normalized_jacobian_svd(x_raw, residuals, scales, names, symbols, units, used_theta)
    retained = diag["overall_status"] == "NOT_IDENTIFIABLE"
    final_theta = [baseline_j, baseline_b, baseline_kt] if retained else theta_hat
    return {
        "overall_status": diag["overall_status"],
        "J": final_theta[0], "B": final_theta[1], "Kt": final_theta[2],
        "condition_number": diag["condition_number"],
        "numerical_rank": diag["numerical_rank"],
        "full_rank": 3,
        "entries": diag["entries"],
        "correlation_matrix": diag["correlation_matrix"],
        "high_collinearity_pairs": diag["high_collinearity_pairs"],
        "baseline_retained": retained,
        "warnings": diag["warnings"],
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

const DYNAMIC_PMSM_PY = String.raw`"""
dynamic_pmsm.py - Standalone Dynamic PMSM dq-Axis Transient ODE Simulator (FD-03)

Strictly decoupled from steady-state SPMSM dyno calibration (dyno_calibrator.py / solve_single_point).
Amplitude-invariant Clarke/Park transient equations integrated with micro-stepped RK4:
  di_d/dt = (v_d - Rs * i_d + omega_e * Lq * i_q) / Ld
  di_q/dt = (v_q - Rs * i_q - omega_e * (Ld * i_d + psi_f)) / Lq
  Te      = 1.5 * p * (psi_f * i_q + (Ld - Lq) * i_d * i_q)
  domega_m/dt = (Te - B * omega_m - T_coulomb * tanh(omega_m / 0.5) - T_load) / J
  dtheta_e/dt = p * omega_m

Provenance: synthetic_assumed_uncalibrated
"""
from __future__ import annotations

from dataclasses import dataclass, field
import json
import math


@dataclass
class DynamicPmsmParams:
    pole_pairs: int = 7
    rs_ohm: float = 0.395
    ld_h: float = 2.2e-4
    lq_h: float = 2.2e-4
    psi_f_vs: float = 0.051332 / 7.0
    j_kg_m2: float = 1.2e-4
    b_nm_s_per_rad: float = 1.5e-4
    t_coulomb_nm: float = 0.005
    v_bus_v: float = 13.5
    i_max_a: float = 12.0
    control_mode: str = "mtpa_current_loop"  # mtpa_current_loop | id_zero | open_loop_vdq
    current_bandwidth_rad_s: float | None = None
    kp_speed: float | None = None
    ki_speed: float | None = None
    # Optional rectangular nonlinear flux-linkage map: dict with id_axis_a, iq_axis_a, psi_d_vs, psi_q_vs.
    flux_map: dict | None = None
    winding_temp_c: float | None = None
    magnet_temp_c: float | None = None
    reference_temp_c: float = 25.0
    rs_temp_coeff_per_c: float = 0.00393
    psi_temp_coeff_per_c: float = 0.0


@dataclass
class DynamicScenarioStep:
    t_start_sec: float
    t_end_sec: float
    t_load_nm: float = 0.0
    speed_ref_rpm: float | None = None
    iq_ref_a: float | None = None
    vd_ref_v: float = 0.0
    vq_ref_v: float = 0.0
    v_bus_v: float | None = None


@dataclass
class DynamicPmsmConfig:
    duration_sec: float = 0.3
    dt_out_sec: float = 2e-4
    initial_speed_rpm: float = 0.0
    initial_id_a: float = 0.0
    initial_iq_a: float = 0.0
    initial_theta_e_rad: float = 0.0
    scenario: list[DynamicScenarioStep] = field(default_factory=list)


def parse_pmsm_flux_map_json(text: str) -> dict:
    doc = json.loads(text)
    if not isinstance(doc, dict) or doc.get("schema") != "wave-test-pmsm-flux-map" or doc.get("schemaVersion") != 1 or doc.get("units") != {"current": "A", "fluxLinkage": "Vs"}:
        raise ValueError("PMSM flux-map JSON schema/units mismatch")
    provenance = doc.get("provenance", "user_import")
    if provenance not in ("fea_extracted", "measured", "user_import", "assumed"):
        raise ValueError("PMSM flux-map provenance must be fea_extracted/measured/user_import/assumed")
    result = {
        "id_axis_a": doc.get("idAxisA", []), "iq_axis_a": doc.get("iqAxisA", []),
        "psi_d_vs": doc.get("psiDVs", []), "psi_q_vs": doc.get("psiQVs", []),
        "provenance": provenance,
        "manufacturer": doc.get("manufacturer"), "part_number": doc.get("partNumber"),
        "reference_temperature_c": doc.get("referenceTemperatureC"), "source_note": doc.get("sourceNote"),
    }
    validate_pmsm_flux_map(result)
    return result


def ke_prime_to_psi_f(ke_prime: float, pole_pairs: int) -> float:
    return float(ke_prime) / max(1, int(pole_pairs))


def validate_pmsm_flux_map(flux_map: dict) -> None:
    id_axis = flux_map.get("id_axis_a") or []
    iq_axis = flux_map.get("iq_axis_a") or []
    psi_d = flux_map.get("psi_d_vs") or []
    psi_q = flux_map.get("psi_q_vs") or []
    if len(id_axis) < 2 or len(iq_axis) < 2 or any(not math.isfinite(float(v)) for v in id_axis + iq_axis):
        raise ValueError("PMSM flux-map axes require at least two finite values")
    if any(id_axis[k] <= id_axis[k-1] for k in range(1, len(id_axis))) or any(iq_axis[k] <= iq_axis[k-1] for k in range(1, len(iq_axis))):
        raise ValueError("PMSM flux-map axes must be strictly increasing")
    if id_axis[0] > 0.0 or id_axis[-1] < 0.0 or iq_axis[0] > 0.0 or iq_axis[-1] < 0.0:
        raise ValueError("PMSM flux-map Id/Iq axes must include zero current")
    ref_temp = flux_map.get("reference_temperature_c")
    if ref_temp is None or not math.isfinite(float(ref_temp)):
        raise ValueError("PMSM flux-map requires a finite reference_temperature_c")
    for matrix in (psi_d, psi_q):
        if len(matrix) != len(id_axis) or any(len(row) != len(iq_axis) for row in matrix):
            raise ValueError("PMSM flux-map matrix dimensions do not match axes")
        if any(not math.isfinite(float(v)) for row in matrix for v in row):
            raise ValueError("PMSM flux-map contains non-finite flux values")
    # Check positive-definite incremental inductance and reciprocal cross derivatives
    # at every cell centre, matching the TypeScript validator.
    for i in range(len(id_axis) - 1):
        did = id_axis[i+1] - id_axis[i]
        for j in range(len(iq_axis) - 1):
            diq = iq_axis[j+1] - iq_axis[j]
            ldd = 0.5 * ((psi_d[i+1][j] - psi_d[i][j]) + (psi_d[i+1][j+1] - psi_d[i][j+1])) / did
            ldq = 0.5 * ((psi_d[i][j+1] - psi_d[i][j]) + (psi_d[i+1][j+1] - psi_d[i+1][j])) / diq
            lqd = 0.5 * ((psi_q[i+1][j] - psi_q[i][j]) + (psi_q[i+1][j+1] - psi_q[i][j+1])) / did
            lqq = 0.5 * ((psi_q[i][j+1] - psi_q[i][j]) + (psi_q[i+1][j+1] - psi_q[i+1][j])) / diq
            scale = max(1e-9, abs(ldd), abs(ldq), abs(lqd), abs(lqq))
            if ldd <= 1e-9 * scale or lqq <= 1e-9 * scale or ldd*lqq - ldq*lqd <= 1e-12*scale*scale:
                raise ValueError(f"PMSM flux-map incremental inductance matrix is not positive definite in cell Id[{i}],Iq[{j}]")
            if abs(ldq-lqd) > 0.35 * scale:
                raise ValueError(f"PMSM flux-map cross differential inductances are not reciprocal in cell Id[{i}],Iq[{j}]")


def _axis_bracket(axis: list[float], value: float, label: str) -> tuple[int, int, float]:
    if value < axis[0] - 1e-9 or value > axis[-1] + 1e-9:
        raise ValueError(f"{label}={value:.6g} A outside PMSM flux-map [{axis[0]}, {axis[-1]}] A")
    x = min(axis[-1], max(axis[0], value))
    hi = 1
    while hi < len(axis) - 1 and axis[hi] < x:
        hi += 1
    lo = hi - 1
    return lo, hi, (x - axis[lo]) / (axis[hi] - axis[lo])


def evaluate_pmsm_flux(id_a: float, iq_a: float, psi_f_vs: float, ld_h: float, lq_h: float, flux_map: dict | None = None):
    if not math.isfinite(id_a) or not math.isfinite(iq_a):
        raise ValueError("PMSM dq current must be finite")
    if flux_map is None:
        return psi_f_vs + ld_h * id_a, lq_h * iq_a, ld_h, 0.0, 0.0, lq_h
    validate_pmsm_flux_map(flux_map)
    ia, ib, fi = _axis_bracket(flux_map["id_axis_a"], id_a, "Id")
    qa, qb, fq = _axis_bracket(flux_map["iq_axis_a"], iq_a, "Iq")
    dx = flux_map["id_axis_a"][ib] - flux_map["id_axis_a"][ia]
    dy = flux_map["iq_axis_a"][qb] - flux_map["iq_axis_a"][qa]
    def interpolate(matrix):
        v00, v10 = matrix[ia][qa], matrix[ib][qa]
        v01, v11 = matrix[ia][qb], matrix[ib][qb]
        value = (1-fi)*(1-fq)*v00 + fi*(1-fq)*v10 + (1-fi)*fq*v01 + fi*fq*v11
        did = ((1-fq)*(v10-v00) + fq*(v11-v01)) / dx
        diq = ((1-fi)*(v01-v00) + fi*(v11-v10)) / dy
        return value, did, diq
    d, ldd, ldq = interpolate(flux_map["psi_d_vs"])
    q, lqd, lqq = interpolate(flux_map["psi_q_vs"])
    det = ldd*lqq - ldq*lqd
    if ldd <= 0 or lqq <= 0 or det <= 0 or not all(math.isfinite(v) for v in (d,q,ldd,ldq,lqd,lqq)):
        raise ValueError("PMSM flux-map incremental inductance matrix is not positive definite")
    return d, q, ldd, ldq, lqd, lqq


def calc_dynamic_pmsm_torque(
    id_a: float, iq_a: float, pole_pairs: int, psi_f_vs: float, ld_h: float, lq_h: float, flux_map: dict | None = None
) -> float:
    psi_d, psi_q, *_ = evaluate_pmsm_flux(id_a, iq_a, psi_f_vs, ld_h, lq_h, flux_map)
    return 1.5 * pole_pairs * (psi_d * iq_a - psi_q * id_a)


def compute_mtpa_and_fw_target(
    i_torque_cmd_a: float,
    omega_e_rad_s: float,
    v_bus_v: float,
    params: DynamicPmsmParams,
) -> dict[str, float | bool]:
    if params.flux_map is not None:
        flux_map = params.flux_map
        validate_pmsm_flux_map(flux_map)
        sign = 1.0 if i_torque_cmd_a >= 0 else -1.0
        i_max_map = float(params.i_max_a)
        requested_iq = sign * min(abs(i_torque_cmd_a), i_max_map)
        target_torque = calc_dynamic_pmsm_torque(0.0, requested_iq, params.pole_pairs, params.psi_f_vs, params.ld_h, params.lq_h, flux_map)
        v_max = max(0.5, float(v_bus_v)) / math.sqrt(3.0) * 0.96
        rs = float(params.rs_ohm)
        best = None
        closest = None
        for k in range(49):
            id_c = -i_max_map + 2.0 * i_max_map * k / 48.0
            iq_cap = math.sqrt(max(0.0, i_max_map*i_max_map-id_c*id_c))
            if iq_cap <= 1e-10:
                continue
            tq_max = calc_dynamic_pmsm_torque(id_c, sign*iq_cap, params.pole_pairs, params.psi_f_vs, params.ld_h, params.lq_h, flux_map)
            lo, hi = 0.0, iq_cap
            if abs(tq_max) >= abs(target_torque):
                for _ in range(34):
                    mid = 0.5*(lo+hi)
                    tq = calc_dynamic_pmsm_torque(id_c, sign*mid, params.pole_pairs, params.psi_f_vs, params.ld_h, params.lq_h, flux_map)
                    if abs(tq) < abs(target_torque): lo = mid
                    else: hi = mid
            iq_c = sign*(0.5*(lo+hi) if abs(tq_max) >= abs(target_torque) else iq_cap)
            tq = calc_dynamic_pmsm_torque(id_c, iq_c, params.pole_pairs, params.psi_f_vs, params.ld_h, params.lq_h, flux_map)
            psi_d, psi_q, *_ = evaluate_pmsm_flux(id_c, iq_c, params.psi_f_vs, params.ld_h, params.lq_h, flux_map)
            we = omega_e_rad_s
            vmag = math.hypot(rs*id_c-we*psi_q, rs*iq_c+we*psi_d)
            item = (abs(tq-target_torque), id_c*id_c+iq_c*iq_c, vmag, id_c, iq_c)
            if closest is None or item[0]+max(0.0,vmag-v_max)*0.1 < closest[0]+max(0.0,closest[2]-v_max)*0.1:
                closest = item
            if vmag <= v_max and (best is None or item[0] < best[0]-1e-6 or (abs(item[0]-best[0]) <= 1e-6 and item[1] < best[1])):
                best = item
        chosen = best or closest
        if chosen is None:
            return {"id_ref_a":0.0,"iq_ref_a":0.0,"current_limited":True,"field_weakening_active":True}
        return {"id_ref_a":chosen[3],"iq_ref_a":chosen[4],"current_limited":abs(i_torque_cmd_a)>i_max_map+1e-9 or chosen[0]>max(1e-3,abs(target_torque)*0.02),"field_weakening_active":abs(omega_e_rad_s)>1 and chosen[3]<-0.05}

    i_max = max(0.05, float(params.i_max_a))
    abs_cmd = abs(i_torque_cmd_a)
    current_limited = abs_cmd > i_max + 1e-9
    i_mag = min(abs_cmd, i_max)
    sign_q = 1.0 if i_torque_cmd_a >= 0.0 else -1.0

    id_ref = 0.0
    iq_ref = sign_q * i_mag

    if params.control_mode == "mtpa_current_loop":
        dl = params.ld_h - params.lq_h
        if abs(dl) > 1e-9 and i_mag > 1e-9:
            psi = max(1e-6, params.psi_f_vs)
            disc = psi * psi + 8.0 * dl * dl * i_mag * i_mag
            id_ref = (-psi + math.sqrt(disc)) / (4.0 * dl)
            id_bound = i_mag * 0.95
            if abs(id_ref) > id_bound:
                id_ref = math.copysign(id_bound, id_ref)
            iq_ref = sign_q * math.sqrt(max(0.0, i_mag * i_mag - id_ref * id_ref))

    v_max_eff = (max(0.5, float(v_bus_v)) / math.sqrt(3.0)) * 0.96
    abs_we = abs(omega_e_rad_s)
    fw_active = False
    if abs_we > 1.0 and params.control_mode == "mtpa_current_loop":
        v_req = math.hypot(-abs_we * params.lq_h * iq_ref, abs_we * (params.ld_h * id_ref + params.psi_f_vs))
        if v_req > v_max_eff:
            fw_active = True
            lo_init = -i_max
            hi_init = id_ref
            best_id = lo_init
            best_iq_abs = 0.0
            samples = 40
            for k in range(samples + 1):
                id_cand = lo_init + ((hi_init - lo_init) * k) / samples
                iq_cap_cur = math.sqrt(max(0.0, i_max * i_max - id_cand * id_cand))
                vd_back = abs_we * (params.ld_h * id_cand + params.psi_f_vs)
                rem_v2 = v_max_eff * v_max_eff - vd_back * vd_back
                if rem_v2 <= 0.0:
                    continue
                iq_cap_volt = math.sqrt(rem_v2) / max(1e-7, abs_we * params.lq_h)
                iq_feas = min(iq_cap_cur, iq_cap_volt)
                if iq_feas > best_iq_abs:
                    best_iq_abs = iq_feas
                    best_id = id_cand
            id_ref = best_id
            iq_ref = sign_q * min(abs(iq_ref), best_iq_abs)

    return {
        "id_ref_a": id_ref,
        "iq_ref_a": iq_ref,
        "current_limited": current_limited,
        "field_weakening_active": fw_active,
    }


def _sample_scenario_at(
    t_sec: float, params: DynamicPmsmParams, scenario: list[DynamicScenarioStep]
) -> dict[str, float | None]:
    if not scenario:
        return {
            "t_load_nm": 0.0,
            "v_bus_v": params.v_bus_v,
            "speed_ref_rpm": None,
            "iq_ref_a": 0.0,
            "vd_ref_v": 0.0,
            "vq_ref_v": 0.0,
        }
    chosen = scenario[0]
    for step in scenario:
        if t_sec >= step.t_start_sec - 1e-12:
            chosen = step
        if step.t_start_sec - 1e-12 <= t_sec <= step.t_end_sec + 1e-12:
            break
    v_step = chosen.v_bus_v if (chosen.v_bus_v is not None and math.isfinite(chosen.v_bus_v) and chosen.v_bus_v > 0.5) else params.v_bus_v
    return {
        "t_load_nm": chosen.t_load_nm if math.isfinite(chosen.t_load_nm) else 0.0,
        "v_bus_v": float(v_step),
        "speed_ref_rpm": chosen.speed_ref_rpm,
        "iq_ref_a": chosen.iq_ref_a,
        "vd_ref_v": float(chosen.vd_ref_v) if math.isfinite(chosen.vd_ref_v) else 0.0,
        "vq_ref_v": float(chosen.vq_ref_v) if math.isfinite(chosen.vq_ref_v) else 0.0,
    }


def build_dynamic_preset_scenario(preset: str) -> tuple[dict[str, float | int | str], DynamicPmsmConfig]:
    if preset == "four_quadrant_regen":
        return (
            {"control_mode": "mtpa_current_loop", "i_max_a": 15.0, "v_bus_v": 24.0},
            DynamicPmsmConfig(
                duration_sec=0.35,
                dt_out_sec=2e-4,
                initial_speed_rpm=0.0,
                scenario=[
                    DynamicScenarioStep(0.0, 0.12, t_load_nm=0.05, speed_ref_rpm=1400.0),
                    DynamicScenarioStep(0.12, 0.24, t_load_nm=0.05, speed_ref_rpm=-900.0),
                    DynamicScenarioStep(0.24, 0.35, t_load_nm=-0.08, speed_ref_rpm=-900.0),
                ],
            ),
        )
    if preset == "ipm_mtpa_fw":
        return (
            {
                "pole_pairs": 4,
                "rs_ohm": 0.045,
                "ld_h": 0.18e-3,
                "lq_h": 0.42e-3,
                "psi_f_vs": 0.015,
                "j_kg_m2": 6.5e-5,
                "b_nm_s_per_rad": 8e-5,
                "t_coulomb_nm": 0.005,
                "v_bus_v": 24.0,
                "i_max_a": 18.0,
                "control_mode": "mtpa_current_loop",
            },
            DynamicPmsmConfig(
                duration_sec=0.25,
                dt_out_sec=2e-4,
                initial_speed_rpm=0.0,
                scenario=[
                    DynamicScenarioStep(0.0, 0.08, t_load_nm=0.25, speed_ref_rpm=1500.0),
                    DynamicScenarioStep(0.08, 0.25, t_load_nm=0.15, speed_ref_rpm=4800.0),
                ],
            ),
        )
    return (
        {"control_mode": "mtpa_current_loop"},
        DynamicPmsmConfig(
            duration_sec=0.3,
            dt_out_sec=2e-4,
            initial_speed_rpm=0.0,
            scenario=[
                DynamicScenarioStep(0.0, 0.12, t_load_nm=0.02, speed_ref_rpm=1000.0),
                DynamicScenarioStep(0.12, 0.22, t_load_nm=0.16, speed_ref_rpm=1000.0),
                DynamicScenarioStep(0.22, 0.3, t_load_nm=0.05, speed_ref_rpm=1300.0),
            ],
        ),
    )


def simulate_dynamic_pmsm(raw_params: DynamicPmsmParams, raw_config: DynamicPmsmConfig) -> dict:
    if int(raw_params.pole_pairs) != raw_params.pole_pairs or raw_params.pole_pairs < 1:
        raise ValueError("pole_pairs must be a positive integer")
    p = int(raw_params.pole_pairs)
    for name, value in (("rs_ohm",raw_params.rs_ohm),("ld_h",raw_params.ld_h),("lq_h",raw_params.lq_h),("psi_f_vs",raw_params.psi_f_vs),("j_kg_m2",raw_params.j_kg_m2),("v_bus_v",raw_params.v_bus_v),("i_max_a",raw_params.i_max_a)):
        if not math.isfinite(float(value)) or float(value) <= 0:
            raise ValueError(f"{name} must be finite and positive")
    if not math.isfinite(raw_params.b_nm_s_per_rad) or raw_params.b_nm_s_per_rad < 0 or not math.isfinite(raw_params.t_coulomb_nm) or raw_params.t_coulomb_nm < 0:
        raise ValueError("damping and Coulomb friction must be finite and nonnegative")
    rs_base = float(raw_params.rs_ohm)
    ld = float(raw_params.ld_h)
    lq = float(raw_params.lq_h)
    psi_f_base = float(raw_params.psi_f_vs)
    j_rot = float(raw_params.j_kg_m2)
    b_visc = float(raw_params.b_nm_s_per_rad)
    t_coul = float(raw_params.t_coulomb_nm)
    reference_temp = float(raw_params.reference_temp_c)
    winding_temp = float(raw_params.winding_temp_c if raw_params.winding_temp_c is not None else reference_temp)
    magnet_temp = float(raw_params.magnet_temp_c if raw_params.magnet_temp_c is not None else reference_temp)
    rs_alpha = float(raw_params.rs_temp_coeff_per_c)
    psi_alpha = float(raw_params.psi_temp_coeff_per_c)
    if not all(math.isfinite(v) for v in (reference_temp, winding_temp, magnet_temp, rs_alpha, psi_alpha)) or rs_alpha < 0:
        raise ValueError("temperature and temperature coefficients must be finite; Rs coefficient must be nonnegative")
    rs = rs_base * (1.0 + rs_alpha * (winding_temp-reference_temp))
    psi_f = psi_f_base * (1.0 + psi_alpha * (magnet_temp-reference_temp))
    if not math.isfinite(rs) or rs <= 0 or not math.isfinite(psi_f) or psi_f <= 0:
        raise ValueError("temperature-corrected Rs/psi_f is not positive and finite")
    if raw_params.flux_map is not None:
        validate_pmsm_flux_map(raw_params.flux_map)
        map_temp = float(raw_params.flux_map["reference_temperature_c"])
        if abs(magnet_temp-map_temp) > 1e-6:
            raise ValueError("magnet temperature differs from single-temperature flux map; import a map at the required temperature")
        if abs(psi_alpha) > 1e-15:
            raise ValueError("psi temperature coefficient cannot be applied to nonlinear flux map; import a map at the required temperature")
        if raw_params.flux_map["id_axis_a"][0] > -float(raw_params.i_max_a) or raw_params.flux_map["id_axis_a"][-1] < float(raw_params.i_max_a) or raw_params.flux_map["iq_axis_a"][0] > -float(raw_params.i_max_a) or raw_params.flux_map["iq_axis_a"][-1] < float(raw_params.i_max_a):
            raise ValueError(f"PMSM flux map must cover +/- Imax ({float(raw_params.i_max_a):.4g} A) on both Id/Iq axes")
    params = DynamicPmsmParams(
        pole_pairs=p,
        rs_ohm=rs,
        ld_h=ld,
        lq_h=lq,
        psi_f_vs=psi_f,
        j_kg_m2=j_rot,
        b_nm_s_per_rad=b_visc,
        t_coulomb_nm=t_coul,
        v_bus_v=float(raw_params.v_bus_v),
        i_max_a=float(raw_params.i_max_a),
        flux_map=raw_params.flux_map,
        winding_temp_c=raw_params.winding_temp_c,
        magnet_temp_c=raw_params.magnet_temp_c,
        reference_temp_c=raw_params.reference_temp_c,
        rs_temp_coeff_per_c=rs_alpha,
        psi_temp_coeff_per_c=psi_alpha,
        control_mode=raw_params.control_mode,
        current_bandwidth_rad_s=raw_params.current_bandwidth_rad_s,
        kp_speed=raw_params.kp_speed,
        ki_speed=raw_params.ki_speed,
    )

    duration = float(raw_config.duration_sec)
    dt_out = float(raw_config.dt_out_sec)
    if not math.isfinite(duration) or not 1e-3 <= duration <= 10.0:
        raise ValueError("duration_sec must be within 1 ms..10 s")
    if not math.isfinite(dt_out) or not 1e-5 <= dt_out <= 0.02:
        raise ValueError("dt_out_sec must be within 10 us..20 ms")
    n_out = int(math.floor(duration / dt_out)) + 1
    if not 2 <= n_out <= 4000:
        raise ValueError("output sample count outside supported range 2..4000")
    eff_dt_out = duration / (n_out - 1)
    prev_end = -float("inf")
    for idx, step in enumerate(raw_config.scenario):
        if not all(math.isfinite(float(v)) for v in (step.t_start_sec, step.t_end_sec, step.t_load_nm)) or step.t_start_sec < 0 or step.t_end_sec <= step.t_start_sec or step.t_end_sec > duration + 1e-9 or step.t_start_sec < prev_end - 1e-9:
            raise ValueError(f"scenario step #{idx+1} has invalid/overlapping time or load")
        if step.v_bus_v is not None and (not math.isfinite(step.v_bus_v) or step.v_bus_v <= 0):
            raise ValueError(f"scenario step #{idx+1} v_bus_v must be positive")
        prev_end = step.t_end_sec

    tau_elec_min = min(ld, lq) / rs
    max_step_h = min(2e-5, 0.05 * tau_elec_min, eff_dt_out)
    substeps = max(1, int(math.ceil(eff_dt_out / max(1e-7, max_step_h))))
    h = eff_dt_out / substeps
    if substeps > 20000 or substeps * (n_out - 1) > 20_000_000:
        raise ValueError("RK4 integration step budget exceeded")

    bw_i = max(100.0, float(raw_params.current_bandwidth_rad_s)) if raw_params.current_bandwidth_rad_s is not None else 2.0 * math.pi * 300.0
    kp_d = ld * bw_i
    ki_d = rs * bw_i
    kp_q = lq * bw_i
    ki_q = rs * bw_i

    kt0 = 1.5 * p * psi_f
    bw_w = min(bw_i * 0.15, 120.0)
    kp_w = float(raw_params.kp_speed) if raw_params.kp_speed is not None else (j_rot * bw_w) / max(1e-4, kt0)
    ki_w = float(raw_params.ki_speed) if raw_params.ki_speed is not None else (kp_w * bw_w * 0.25)

    warnings = [
        "此模块为合成假设动态模型 (synthetic_assumed_uncalibrated)，使用独立 dq 动态方程与 RK4 求解，不等同于实测示波器波形或已标定电机模型。"
    ]
    if params.flux_map is not None:
        warnings.append(f"已启用非线性磁链 Map：{params.flux_map.get('provenance')} / {params.flux_map.get('part_number') or '未标注型号'}；参考温度 {params.flux_map.get('reference_temperature_c')}°C。")
    else:
        warnings.append("当前使用线性磁链模型 ψd=ψf+Ld·Id、ψq=Lq·Iq。")
    if abs(winding_temp-reference_temp) > 1e-9:
        warnings.append(f"Rs 已按绕组温度 {winding_temp:g}°C 及参考温度 {reference_temp:g}°C 做静态温度修正；未模拟动态热反馈。")

    time_arr: list[float] = []
    theta_e_arr: list[float] = []
    omega_m_arr: list[float] = []
    n_rpm_arr: list[float] = []
    id_arr: list[float] = []
    iq_arr: list[float] = []
    vd_arr: list[float] = []
    vq_arr: list[float] = []
    psi_d_arr: list[float] = []
    psi_q_arr: list[float] = []
    p_elec_arr: list[float] = []
    p_copper_arr: list[float] = []
    p_mech_arr: list[float] = []
    p_load_arr: list[float] = []
    p_friction_arr: list[float] = []
    p_magnetic_stored_rate_arr: list[float] = []
    p_mechanical_stored_rate_arr: list[float] = []
    p_electrical_balance_residual_arr: list[float] = []
    p_mechanical_balance_residual_arr: list[float] = []
    ia_arr: list[float] = []
    ib_arr: list[float] = []
    ic_arr: list[float] = []
    te_arr: list[float] = []
    t_load_arr: list[float] = []
    v_bus_arr: list[float] = []
    m_norm_arr: list[float] = []
    volt_lim_arr: list[int] = []
    curr_lim_arr: list[int] = []
    quadrant_arr: list[str] = []

    id_a = float(raw_config.initial_id_a) if math.isfinite(raw_config.initial_id_a) else 0.0
    iq_a = float(raw_config.initial_iq_a) if math.isfinite(raw_config.initial_iq_a) else 0.0
    omega_m = (float(raw_config.initial_speed_rpm) * 2.0 * math.pi / 60.0) if math.isfinite(raw_config.initial_speed_rpm) else 0.0
    theta_e = float(raw_config.initial_theta_e_rad) if math.isfinite(raw_config.initial_theta_e_rad) else 0.0
    int_id = 0.0
    int_iq = 0.0
    int_w = 0.0

    def eval_control(t_sec: float, cur_id: float, cur_iq: float, cur_omega_m: float):
        cmd = _sample_scenario_at(t_sec, params, raw_config.scenario)
        v_bus = float(cmd["v_bus_v"])
        v_max = v_bus / math.sqrt(3.0)
        we = p * cur_omega_m
        vd_cmd = float(cmd["vd_ref_v"])
        vq_cmd = float(cmd["vq_ref_v"])
        curr_limited = False

        if params.control_mode != "open_loop_vdq":
            if cmd["iq_ref_a"] is not None and math.isfinite(cmd["iq_ref_a"]):
                i_torq_cmd = float(cmd["iq_ref_a"])
            else:
                w_ref = (float(cmd["speed_ref_rpm"] or 0.0) * 2.0 * math.pi) / 60.0
                i_torq_cmd = kp_w * (w_ref - cur_omega_m) + int_w
            tgt = compute_mtpa_and_fw_target(i_torq_cmd, we, v_bus, params)
            curr_limited = bool(tgt["current_limited"])
            err_d = float(tgt["id_ref_a"]) - cur_id
            err_q = float(tgt["iq_ref_a"]) - cur_iq
            psi_d, psi_q, *_ = evaluate_pmsm_flux(cur_id, cur_iq, psi_f, ld, lq, params.flux_map)
            vd_cmd = kp_d * err_d + int_id - we * psi_q
            vq_cmd = kp_q * err_q + int_iq + we * psi_d

        v_mag = math.hypot(vd_cmd, vq_cmd)
        v_limited = v_mag > v_max
        scale = (v_max / v_mag) if (v_limited and v_mag > 1e-12) else 1.0
        return {
            "cmd": cmd,
            "vd": vd_cmd * scale,
            "vq": vq_cmd * scale,
            "vd_cmd": vd_cmd,
            "vq_cmd": vq_cmd,
            "v_max": v_max,
            "v_limited": v_limited,
            "curr_limited": curr_limited,
        }

    def rhs(cur_id: float, cur_iq: float, cur_omega_m: float, vd: float, vq: float, t_load_nm: float):
        we = p * cur_omega_m
        psi_d, psi_q, ldd, ldq, lqd, lqq = evaluate_pmsm_flux(cur_id, cur_iq, psi_f, ld, lq, params.flux_map)
        f_d = vd - rs * cur_id + we * psi_q
        f_q = vq - rs * cur_iq - we * psi_d
        det = ldd * lqq - ldq * lqd
        if det <= 0 or not math.isfinite(det):
            raise ValueError("PMSM incremental inductance matrix lost positive definiteness")
        d_id = (f_d * lqq - ldq * f_q) / det
        d_iq = (ldd * f_q - lqd * f_d) / det
        te = 1.5 * p * (psi_d * cur_iq - psi_q * cur_id)
        fric = b_visc * cur_omega_m + t_coul * math.tanh(cur_omega_m / 0.5)
        d_omega_m = (te - fric - t_load_nm) / j_rot
        return d_id, d_iq, d_omega_m, we

    peak_abs_i = 0.0
    peak_abs_t = 0.0
    peak_rpm = -float("inf")
    min_rpm = float("inf")
    volt_hits = 0
    curr_hits = 0
    last_vd = 0.0
    last_vq = 0.0
    last_tload = 0.0

    for k in range(n_out):
        t_cur = k * eff_dt_out
        ctrl = eval_control(t_cur, id_a, iq_a, omega_m)
        te_now = calc_dynamic_pmsm_torque(id_a, iq_a, p, psi_f, ld, lq, params.flux_map)
        psi_d_now, psi_q_now, *_ = evaluate_pmsm_flux(id_a, iq_a, psi_f, ld, lq, params.flux_map)
        p_elec_now = 1.5 * (ctrl["vd"] * id_a + ctrl["vq"] * iq_a)
        p_copper_now = 1.5 * rs * (id_a * id_a + iq_a * iq_a)
        p_mech_now = te_now * omega_m
        p_load_now = float(ctrl["cmd"]["t_load_nm"]) * omega_m
        p_friction_now = (b_visc * omega_m + t_coul * math.tanh(omega_m / 0.5)) * omega_m
        rhs_now = rhs(id_a, iq_a, omega_m, ctrl["vd"], ctrl["vq"], float(ctrl["cmd"]["t_load_nm"]))
        _, _, ldd_now, ldq_now, lqd_now, lqq_now = evaluate_pmsm_flux(id_a, iq_a, psi_f, ld, lq, params.flux_map)
        dpsi_d_dt = ldd_now * rhs_now[0] + ldq_now * rhs_now[1]
        dpsi_q_dt = lqd_now * rhs_now[0] + lqq_now * rhs_now[1]
        p_magnetic_stored_rate_now = 1.5 * (id_a * dpsi_d_dt + iq_a * dpsi_q_dt)
        p_mechanical_stored_rate_now = j_rot * omega_m * rhs_now[2]
        p_electrical_balance_residual_now = p_elec_now - p_copper_now - p_mech_now - p_magnetic_stored_rate_now
        p_mechanical_balance_residual_now = p_mech_now - p_load_now - p_friction_now - p_mechanical_stored_rate_now
        n_rpm_now = (omega_m * 60.0) / (2.0 * math.pi)

        ia = id_a * math.cos(theta_e) - iq_a * math.sin(theta_e)
        ib = id_a * math.cos(theta_e - (2.0 * math.pi) / 3.0) - iq_a * math.sin(theta_e - (2.0 * math.pi) / 3.0)
        ic = -(ia + ib)

        v_mag = math.hypot(ctrl["vd"], ctrl["vq"])
        m_norm = (v_mag / ctrl["v_max"]) if ctrl["v_max"] > 0.0 else 0.0

        time_arr.append(t_cur)
        theta_e_arr.append(theta_e)
        omega_m_arr.append(omega_m)
        n_rpm_arr.append(n_rpm_now)
        id_arr.append(id_a)
        iq_arr.append(iq_a)
        vd_arr.append(ctrl["vd"])
        vq_arr.append(ctrl["vq"])
        psi_d_arr.append(psi_d_now)
        psi_q_arr.append(psi_q_now)
        p_elec_arr.append(p_elec_now)
        p_copper_arr.append(p_copper_now)
        p_mech_arr.append(p_mech_now)
        p_load_arr.append(p_load_now)
        p_friction_arr.append(p_friction_now)
        p_magnetic_stored_rate_arr.append(p_magnetic_stored_rate_now)
        p_mechanical_stored_rate_arr.append(p_mechanical_stored_rate_now)
        p_electrical_balance_residual_arr.append(p_electrical_balance_residual_now)
        p_mechanical_balance_residual_arr.append(p_mechanical_balance_residual_now)
        ia_arr.append(ia)
        ib_arr.append(ib)
        ic_arr.append(ic)
        te_arr.append(te_now)
        t_load_arr.append(float(ctrl["cmd"]["t_load_nm"]))
        v_bus_arr.append(float(ctrl["cmd"]["v_bus_v"]))
        m_norm_arr.append(m_norm)
        volt_lim_arr.append(1 if ctrl["v_limited"] else 0)
        actual_current_limited = math.hypot(id_a, iq_a) > params.i_max_a + 1e-6
        curr_lim_arr.append(1 if (ctrl["curr_limited"] or actual_current_limited) else 0)

        p_mech = omega_m * te_now
        if abs(omega_m) < 0.05 and abs(te_now) < 1e-3:
            q_mode = "standstill"
        elif p_mech < -1e-3:
            q_mode = "regen"
        else:
            q_mode = "motoring"
        quadrant_arr.append(q_mode)

        peak_abs_i = max(peak_abs_i, math.hypot(id_a, iq_a))
        peak_abs_t = max(peak_abs_t, abs(te_now))
        peak_rpm = max(peak_rpm, n_rpm_now)
        min_rpm = min(min_rpm, n_rpm_now)
        if ctrl["v_limited"]:
            volt_hits += 1
        if ctrl["curr_limited"] or math.hypot(id_a, iq_a) > params.i_max_a + 1e-6:
            curr_hits += 1
        last_vd = ctrl["vd"]
        last_vq = ctrl["vq"]
        last_tload = float(ctrl["cmd"]["t_load_nm"])

        if k == n_out - 1:
            break

        for s in range(substeps):
            ts = t_cur + s * h
            cs = eval_control(ts, id_a, iq_a, omega_m)
            t_ld = float(cs["cmd"]["t_load_nm"])
            k1 = rhs(id_a, iq_a, omega_m, cs["vd"], cs["vq"], t_ld)
            k2 = rhs(id_a + 0.5 * h * k1[0], iq_a + 0.5 * h * k1[1], omega_m + 0.5 * h * k1[2], cs["vd"], cs["vq"], t_ld)
            k3 = rhs(id_a + 0.5 * h * k2[0], iq_a + 0.5 * h * k2[1], omega_m + 0.5 * h * k2[2], cs["vd"], cs["vq"], t_ld)
            k4 = rhs(id_a + h * k3[0], iq_a + h * k3[1], omega_m + h * k3[2], cs["vd"], cs["vq"], t_ld)

            id_a += (h / 6.0) * (k1[0] + 2.0 * k2[0] + 2.0 * k3[0] + k4[0])
            iq_a += (h / 6.0) * (k1[1] + 2.0 * k2[1] + 2.0 * k3[1] + k4[1])
            omega_m += (h / 6.0) * (k1[2] + 2.0 * k2[2] + 2.0 * k3[2] + k4[2])
            theta_e += (h / 6.0) * (k1[3] + 2.0 * k2[3] + 2.0 * k3[3] + k4[3])

            if params.control_mode != "open_loop_vdq":
                we_n = p * omega_m
                if cs["cmd"]["iq_ref_a"] is not None and math.isfinite(cs["cmd"]["iq_ref_a"]):
                    i_torq_cmd = float(cs["cmd"]["iq_ref_a"])
                else:
                    w_ref = (float(cs["cmd"]["speed_ref_rpm"] or 0.0) * 2.0 * math.pi) / 60.0
                    err_w = w_ref - omega_m
                    unsat_i = kp_w * err_w + int_w
                    sat_i = max(-params.i_max_a, min(params.i_max_a, unsat_i))
                    int_w += h * (ki_w * err_w + 0.25 * bw_w * (sat_i - unsat_i))
                    i_torq_cmd = sat_i
                tgt = compute_mtpa_and_fw_target(i_torq_cmd, we_n, float(cs["cmd"]["v_bus_v"]), params)
                err_d = float(tgt["id_ref_a"]) - id_a
                err_q = float(tgt["iq_ref_a"]) - iq_a
                aw_d = (cs["vd"] - cs["vd_cmd"]) * 0.5 if cs["v_limited"] else 0.0
                aw_q = (cs["vq"] - cs["vq_cmd"]) * 0.5 if cs["v_limited"] else 0.0
                int_id += h * (ki_d * err_d + bw_i * aw_d)
                int_iq += h * (ki_q * err_q + bw_i * aw_q)

    we_end = p * omega_m
    psi_d_end, psi_q_end, *_ = evaluate_pmsm_flux(id_a, iq_a, psi_f, ld, lq, params.flux_map)
    analytical_vd = rs * id_a - we_end * psi_q_end
    analytical_vq = rs * iq_a + we_end * psi_d_end
    analytical_te = calc_dynamic_pmsm_torque(id_a, iq_a, p, psi_f, ld, lq, params.flux_map)
    end_rhs = rhs(id_a, iq_a, omega_m, last_vd, last_vq, last_tload)

    if volt_hits > 0:
        warnings.append(f"仿真中有 {volt_hits} 个采样点触发 SVPWM 电压圆限幅 (|Vdq| >= Vbus/sqrt(3))。")
    if curr_hits > 0:
        warnings.append(f"仿真中有 {curr_hits} 个采样点触发相电流上限限幅 (|I| >= {params.i_max_a:.1f} A)。")

    return {
        "provenance": "synthetic_assumed_uncalibrated",
        "source_model": "dynamic_pmsm_dq_rk4_flux_map" if params.flux_map is not None else "dynamic_pmsm_dq_rk4",
        "warnings": warnings,
        "dt_internal_sec": h,
        "substeps_per_output": substeps,
        "time": time_arr,
        "theta_e": theta_e_arr,
        "omega_m": omega_m_arr,
        "n_rpm": n_rpm_arr,
        "id_a": id_arr,
        "iq_a": iq_arr,
        "vd_v": vd_arr,
        "vq_v": vq_arr,
        "psi_d_vs": psi_d_arr,
        "psi_q_vs": psi_q_arr,
        "p_elec_w": p_elec_arr,
        "p_copper_w": p_copper_arr,
        "p_mech_w": p_mech_arr,
        "p_load_w": p_load_arr,
        "p_friction_w": p_friction_arr,
        "p_magnetic_stored_rate_w": p_magnetic_stored_rate_arr,
        "p_mechanical_stored_rate_w": p_mechanical_stored_rate_arr,
        "p_electrical_balance_residual_w": p_electrical_balance_residual_arr,
        "p_mechanical_balance_residual_w": p_mechanical_balance_residual_arr,
        "flux_map_provenance": (params.flux_map or {}).get("provenance", "linear_parameter_model"),
        "ia_a": ia_arr,
        "ib_a": ib_arr,
        "ic_a": ic_arr,
        "te_nm": te_arr,
        "t_load_nm": t_load_arr,
        "v_bus_v": v_bus_arr,
        "m_norm": m_norm_arr,
        "voltage_limited": volt_lim_arr,
        "current_limited": curr_lim_arr,
        "quadrant_mode": quadrant_arr,
        "peak_abs_current_a": peak_abs_i,
        "peak_abs_torque_nm": peak_abs_t,
        "peak_speed_rpm": peak_rpm,
        "min_speed_rpm": min_rpm,
        "voltage_limit_hits": volt_hits,
        "current_limit_hits": curr_hits,
        "steady_check": {
            "final_speed_rpm": (omega_m * 60.0) / (2.0 * math.pi),
            "final_id_a": id_a,
            "final_iq_a": iq_a,
            "analytical_te_nm": analytical_te,
            "analytical_vd_v": analytical_vd,
            "analytical_vq_v": analytical_vq,
            "sim_te_nm": te_arr[-1],
            "sim_vd_v": last_vd,
            "sim_vq_v": last_vq,
            "torque_diff_nm": abs(te_arr[-1] - analytical_te),
            "voltage_diff_v": math.hypot(last_vd - analytical_vd, last_vq - analytical_vq),
            "di_dt_norm_aps": math.hypot(end_rhs[0], end_rhs[1]),
            "domega_dt_norm_rad_s2": abs(end_rhs[2]),
        },
    }
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
from dynamic_pmsm import (
    DynamicPmsmConfig,
    DynamicPmsmParams,
    DynamicScenarioStep,
    build_dynamic_preset_scenario,
    parse_pmsm_flux_map_json,
    simulate_dynamic_pmsm,
)
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

tab1, tab2, tab3, tab4 = st.tabs([
    "Tab 1: 测功仪标定与 2D Map",
    "Tab 2: 运行态推算与告警",
    "Tab 3: 6-MOS 波形与参数导出",
    "Tab 4: 动态 dq 瞬态仿真 (非标定)",
])

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
            _fmt_t = f"{val_m['val_mae_T']:.4f} N·m" if np.isfinite(val_m['val_mae_T']) else "N/A"
            _fmt_mp = f"{val_m['val_mape_T_pct']:.1f}%" if np.isfinite(val_m['val_mape_T_pct']) else "N/A"
            _fmt_e = f"{val_m['val_mae_eta_pct']:.2f}%" if np.isfinite(val_m['val_mae_eta_pct']) else "N/A"
            audit_parts.append(
                f"20% 留出交叉验证 ({val_m['holdout_count']}点): MAE_T={_fmt_t}, MAPE_T={_fmt_mp}, MAE_η={_fmt_e}"
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
        id_rep = report.get("identifiability_report")
        if id_rep:
            cond_txt = f"{id_rep['condition_number']:.2f}" if math.isfinite(id_rep["condition_number"]) else "∞"
            st.info(
                f"参数可辨识性: {id_rep['overall_status']} | 秩={id_rep['numerical_rank']}/{id_rep['full_rank']} | "
                f"κ={cond_txt} | DOF={id_rep['dof']}"
                + (" | 已回退保留基准参数" if id_rep.get("baseline_retained") else "")
            )
            if id_rep.get("entries"):
                st.dataframe(pd.DataFrame(id_rep["entries"]), width="stretch", hide_index=True)

        df_eval = report["eval_df"].sort_values(["n_rpm", "T_Nm"]).reset_index(drop=True)
        fig_cmp = make_subplots(rows=1, cols=2, subplot_titles=("实测 vs 预测扭矩 (N·m)", "实测 vs 预测效率 (%)"))
        fig_cmp.add_trace(go.Scatter(y=df_eval["T_Nm"], name="T_meas", mode="lines+markers", line=dict(dash="dash", color="#94A3B8")), row=1, col=1)
        fig_cmp.add_trace(go.Scatter(y=df_eval["T_est"], name="T_est", mode="lines+markers", line=dict(color="#06B6D4")), row=1, col=1)
        fig_cmp.add_trace(go.Scatter(y=df_eval["eta"] * 100.0, name="eta_meas", mode="lines+markers", line=dict(dash="dash", color="#94A3B8")), row=1, col=2)
        fig_cmp.add_trace(go.Scatter(y=df_eval["eta_est"] * 100.0, name="eta_est", mode="lines+markers", line=dict(color="#F59E0B")), row=1, col=2)
        fig_cmp.update_layout(template="plotly_dark", height=340)
        st.plotly_chart(fig_cmp, width="stretch")

        if report["grid_n"] is not None:
            extrap_mask = report.get("z_extrap_mask")
            hover_labels = (
                np.where(extrap_mask, "⚠ 外推区不可信（最近邻填充）", "实测凸包内插")
                if extrap_mask is not None
                else None
            )
            fig = make_subplots(rows=1, cols=2, subplot_titles=("实测效率 Map η(n, T)", "模型重构效率 Map η(n, T)"))
            fig.add_trace(
                go.Heatmap(
                    x=report["grid_n"],
                    y=report["grid_t"],
                    z=report["z_meas"],
                    colorscale="Viridis",
                    customdata=hover_labels,
                    hovertemplate="n=%{x:.0f} RPM<br>T=%{y:.3f} N·m<br>η=%{z:.2f}%<br>%{customdata}<extra></extra>" if hover_labels is not None else None,
                ),
                row=1,
                col=1,
            )
            fig.add_trace(
                go.Heatmap(
                    x=report["grid_n"],
                    y=report["grid_t"],
                    z=report["z_pred"],
                    colorscale="Viridis",
                    customdata=hover_labels,
                    hovertemplate="n=%{x:.0f} RPM<br>T=%{y:.3f} N·m<br>η=%{z:.2f}%<br>%{customdata}<extra></extra>" if hover_labels is not None else None,
                ),
                row=1,
                col=2,
            )
            if extrap_mask is not None and np.any(extrap_mask):
                for col_idx in (1, 2):
                    fig.add_trace(
                        go.Contour(
                            x=report["grid_n"],
                            y=report["grid_t"],
                            z=extrap_mask.astype(float),
                            showscale=False,
                            contours=dict(start=0.5, end=0.5, size=1, coloring="none"),
                            line=dict(color="#F43F5E", width=2, dash="dot"),
                            name="凸包边界(外侧为外推区)",
                            hoverinfo="skip",
                        ),
                        row=1,
                        col=col_idx,
                    )
            fig.update_layout(template="plotly_dark", height=400)
            st.plotly_chart(fig, width="stretch")
            st.caption("注：红色虚线外侧已采用最近邻填充以保持连续视图，但属于实测凸包外区域——外推区不可信，仅作视觉参考。")
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
    if df_log_out.attrs.get("gap_count", 0) > 0:
        st.warning(
            f"检测到 {df_log_out.attrs['gap_count']} 处时间采样缺口（分为 {df_log_out.attrs.get('segment_count', 1)} 个连续片段），已在缺口边界重置平滑滤波状态，不跨缺口插值；"
            f"缺口孤立单点 ({df_log_out.attrs.get('isolated_count', 0)} 个) 已标记为 NaN；低覆盖率点 ({df_log_out.attrs.get('low_coverage_count', 0)} 个) 已从有效估算中剔除。"
        )
    elif df_log_out.attrs.get("low_coverage_count", 0) > 0:
        st.warning(
            f"当前滤波窗口有效时间覆盖不足的点共 {df_log_out.attrs['low_coverage_count']} 个，已标记为 LOW_COVERAGE 并从有效反算/统计中剔除。"
        )
    n_regen_lim = int(df_log_out["alert_regen_limit"].sum())
    n_inv_bus = int(df_log_out["alert_invalid_bus"].sum())
    invalid_rows = df_log_out.loc[~df_log_out["solution_valid"]]
    if n_regen_lim > 0 or n_inv_bus > 0:
        st.warning(f"日志中检测到 {n_regen_lim} 个超发电极限点、{n_inv_bus} 个母线压降异常点（该时刻无实数解，曲线中已标红点并用前值示踪，底层数值仍保持 NaN）。")

    fig_log = make_subplots(rows=3, cols=1, shared_xaxes=True, subplot_titles=("母线与相电流 (A)", "双调制比 m_motor / m_cmd", "双 q轴电压 Vq_motor / Vq_cmd (V)"))
    fig_log.add_trace(go.Scatter(x=df_log_out["time_s"], y=df_log_out["i_bus_raw"], name="I_bus_raw", line=dict(dash="dot", color="#64748B")), row=1, col=1)
    fig_log.add_trace(go.Scatter(x=df_log_out["time_s"], y=df_log_out["i_bus_filt"], name="I_bus_filt", line=dict(color="#F59E0B")), row=1, col=1)
    fig_log.add_trace(go.Scatter(x=df_log_out["time_s"], y=df_log_out["iq_plot"], name="Iq_est", line=dict(color="#06B6D4")), row=1, col=1)
    fig_log.add_trace(go.Scatter(x=df_log_out["time_s"], y=df_log_out["m_motor_plot"], name="m_motor", line=dict(color="#06B6D4")), row=2, col=1)
    fig_log.add_trace(go.Scatter(x=df_log_out["time_s"], y=df_log_out["m_cmd_plot"], name="m_cmd", line=dict(color="#F43F5E")), row=2, col=1)
    fig_log.add_hline(y=SVPWM_LINEAR_LIMIT, line_dash="dash", line_color="#F59E0B", row=2, col=1)
    fig_log.add_trace(go.Scatter(x=df_log_out["time_s"], y=df_log_out["vq_motor_plot"], name="Vq_motor", line=dict(color="#06B6D4")), row=3, col=1)
    fig_log.add_trace(go.Scatter(x=df_log_out["time_s"], y=df_log_out["vq_cmd_plot"], name="Vq_cmd", line=dict(color="#F59E0B")), row=3, col=1)
    if len(invalid_rows) > 0:
        fig_log.add_trace(
            go.Scatter(
                x=invalid_rows["time_s"],
                y=invalid_rows["iq_plot"],
                mode="markers",
                name="该时刻无实数解（已标红点，数值未虚构）",
                marker=dict(color="#EF4444", size=9, symbol="x"),
            ),
            row=1,
            col=1,
        )
        fig_log.add_trace(
            go.Scatter(
                x=invalid_rows["time_s"],
                y=invalid_rows["m_cmd_plot"],
                mode="markers",
                showlegend=False,
                marker=dict(color="#EF4444", size=9, symbol="x"),
            ),
            row=2,
            col=1,
        )
        fig_log.add_trace(
            go.Scatter(
                x=invalid_rows["time_s"],
                y=invalid_rows["vq_cmd_plot"],
                mode="markers",
                showlegend=False,
                marker=dict(color="#EF4444", size=9, symbol="x"),
            ),
            row=3,
            col=1,
        )
    fig_log.update_layout(template="plotly_dark", height=680)
    st.plotly_chart(fig_log, width="stretch")
    if len(invalid_rows) > 0:
        st.caption("注：红叉位置表示该时刻无实数解（已标红点，数值未虚构；DataFrame 底层仍保留 NaN 与告警标志）。")

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
    exp_v = c1.number_input("稳态 V_meas (V)", min_value=-20.0, max_value=200.0, format="%.2f", key="exp_v")
    exp_i = c2.number_input("稳态 I_bus (A)", min_value=-30.0, max_value=100.0, format="%.3f", key="exp_i")
    exp_n = c3.number_input("稳态转速 n (RPM, 0=堵转)", min_value=-30000.0, max_value=30000.0, format="%.1f", key="exp_n")
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
        st.plotly_chart(fig_w, width="stretch")

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

with tab4:
    st.subheader("独立 PMSM 动态 dq 轴 ODE 瞬态仿真 (FD-03)")
    flux_map_file = st.file_uploader("导入 PMSM 非线性磁链 Map JSON（ψd/ψq vs Id/Iq）", type=["json"], key="dynamic_pmsm_flux_map_json")
    if flux_map_file is not None:
        try:
            st.session_state["dynamic_pmsm_flux_map"] = parse_pmsm_flux_map_json(flux_map_file.getvalue().decode("utf-8-sig"))
            st.success(f"已加载磁链 Map：{flux_map_file.name}")
        except Exception as exc:
            st.error(f"磁链 Map 导入失败：{exc}")
            st.session_state.pop("dynamic_pmsm_flux_map", None)
    imported_flux_map = st.session_state.get("dynamic_pmsm_flux_map")
    if imported_flux_map:
        st.caption(f"非线性磁链 Map：{imported_flux_map.get('part_number') or '未标注型号'} · {imported_flux_map.get('provenance')} · 参考温度 {imported_flux_map.get('reference_temperature_c')}°C；超出 Id/Iq 范围将拒绝积分。")
    st.warning(
        "来源标识: synthetic_assumed_uncalibrated (MODEL_SYNTHETIC_DYNAMIC_ASSUMED_UNCALIBRATED) — "
        "本标签页仅执行独立的动态 dq 电磁-机械常微分方程仿真，参数 (Ld/Lq/J/B) 独立设定，绝不混入 Tab 1 稳态测功标定或实测示波器采集。"
    )
    d_preset = st.selectbox("快速场景预设", ["startup_load_step", "four_quadrant_regen", "ipm_mtpa_fw"], key="dyn_preset")
    patch, base_cfg = build_dynamic_preset_scenario(d_preset)

    dc1, dc2, dc3, dc4 = st.columns(4)
    d_ld = float(dc1.number_input("Ld (mH)", 0.01, 50.0, float(patch.get("ld_h", 0.22e-3)) * 1e3, format="%.3f")) * 1e-3
    d_lq = float(dc2.number_input("Lq (mH)", 0.01, 50.0, float(patch.get("lq_h", 0.22e-3)) * 1e3, format="%.3f")) * 1e-3
    d_j = float(dc3.number_input("转动惯量 J (kg·m²)", 1e-6, 1.0, float(patch.get("j_kg_m2", 1.2e-4)), format="%.6f"))
    d_b = float(dc4.number_input("粘滞阻尼 B (N·m·s/rad)", 0.0, 0.1, float(patch.get("b_nm_s_per_rad", 1.5e-4)), format="%.6f"))

    dc5, dc6, dc7 = st.columns(3)
    d_vbus = float(dc5.number_input("直流母线 Vbus (V)", 2.0, 400.0, float(patch.get("v_bus_v", 13.5)), format="%.2f"))
    d_imax = float(dc6.number_input("相电流上限 Imax (A)", 0.5, 200.0, float(patch.get("i_max_a", 12.0)), format="%.1f"))
    d_mode = dc7.selectbox("控制策略", ["mtpa_current_loop", "id_zero", "open_loop_vdq"], key="dyn_mode")

    tref_c, tw_c, tm_c, rs_a_c, psi_a_c = st.columns(5)
    d_tref = float(tref_c.number_input("参数参考温度 (°C)", -40.0, 200.0, 25.0, key="dyn_tref_c"))
    d_tw = float(tw_c.number_input("绕组温度 (°C)", -40.0, 250.0, 25.0, key="dyn_tw_c"))
    map_ref_temp = float(imported_flux_map.get("reference_temperature_c", 25.0)) if imported_flux_map else 25.0
    d_tm = float(tm_c.number_input("磁体温度 (°C)", -40.0, 200.0, map_ref_temp, key="dyn_tm_c"))
    d_rs_alpha_ppm = float(rs_a_c.number_input("Rs 温度系数 (ppm/°C)", 0.0, 10000.0, 3930.0, key="dyn_rs_alpha_ppm"))
    d_psi_alpha_ppm = float(psi_a_c.number_input("ψf 温度系数 (ppm/°C)", -10000.0, 10000.0, 0.0, key="dyn_psi_alpha_ppm"))
    if imported_flux_map:
        st.caption("非线性磁链 Map 按单一参考温度使用；磁体温度必须与 Map 参考温度一致，不能对整张 Map 额外乘温度系数。")

    dyn_p = DynamicPmsmParams(
        pole_pairs=int(patch.get("pole_pairs", st.session_state["params"].pole_pairs)),
        rs_ohm=float(patch.get("rs_ohm", 0.395)),
        ld_h=d_ld,
        lq_h=d_lq,
        psi_f_vs=float(patch.get("psi_f_vs", st.session_state["params"].ke_prime / max(1, st.session_state["params"].pole_pairs))),
        j_kg_m2=d_j,
        b_nm_s_per_rad=d_b,
        t_coulomb_nm=float(patch.get("t_coulomb_nm", 0.005)),
        v_bus_v=d_vbus,
        i_max_a=d_imax,
        control_mode=d_mode,
        flux_map=imported_flux_map,
        winding_temp_c=d_tw,
        magnet_temp_c=d_tm,
        reference_temp_c=d_tref,
        rs_temp_coeff_per_c=d_rs_alpha_ppm * 1e-6,
        psi_temp_coeff_per_c=d_psi_alpha_ppm * 1e-6,
    )
    try:
        dyn_res = simulate_dynamic_pmsm(dyn_p, base_cfg)
    except (ValueError, ArithmeticError) as exc:
        dyn_res = None
        st.error(f"动态 PMSM 仿真被输入/模型边界保护阻止：{exc}")
    if dyn_res is not None:
      for w in dyn_res["warnings"]:
        st.info(w)

      dm1, dm2, dm3, dm4 = st.columns(4)
      dm1.metric("峰值 |I| (A)", f"{dyn_res['peak_abs_current_a']:.3f}")
      dm2.metric("峰值 |Te| (N·m)", f"{dyn_res['peak_abs_torque_nm']:.4f}")
      dm3.metric("电压圆限幅点数", f"{dyn_res['voltage_limit_hits']}")
      dm4.metric("末态稳态电压残差 (V)", f"{dyn_res['steady_check']['voltage_diff_v']:.4f}")
      balance_cols = st.columns(2)
      balance_cols[0].metric("最大电气功率平衡残差 (W)", f"{max(abs(x) for x in dyn_res['p_electrical_balance_residual_w']):.3e}")
      balance_cols[1].metric("最大机械功率平衡残差 (W)", f"{max(abs(x) for x in dyn_res['p_mechanical_balance_residual_w']):.3e}")

      fig_dyn = make_subplots(rows=3, cols=1, shared_xaxes=True, subplot_titles=("dq 电流 Id / Iq (A)", "电磁与负载转矩 Te / T_load (N·m)", "机械转速 n (RPM)"))
      fig_dyn.add_trace(go.Scatter(x=dyn_res["time"], y=dyn_res["id_a"], name="Id (A)", line=dict(color="#60A5FA")), row=1, col=1)
      fig_dyn.add_trace(go.Scatter(x=dyn_res["time"], y=dyn_res["iq_a"], name="Iq (A)", line=dict(color="#F472B6")), row=1, col=1)
      fig_dyn.add_trace(go.Scatter(x=dyn_res["time"], y=dyn_res["te_nm"], name="Te (N·m)", line=dict(color="#FB923C")), row=2, col=1)
      fig_dyn.add_trace(go.Scatter(x=dyn_res["time"], y=dyn_res["t_load_nm"], name="T_load (N·m)", line=dict(dash="dash", color="#94A3B8")), row=2, col=1)
      fig_dyn.add_trace(go.Scatter(x=dyn_res["time"], y=dyn_res["n_rpm"], name="n (RPM)", line=dict(color="#A78BFA")), row=3, col=1)
      fig_dyn.update_layout(template="plotly_dark", height=620)
      st.plotly_chart(fig_dyn, width="stretch")

      df_dyn_csv = pd.DataFrame({
          "Time_s": dyn_res["time"],
          "n_rpm": dyn_res["n_rpm"],
          "Id_A": dyn_res["id_a"],
          "Iq_A": dyn_res["iq_a"],
          "Vd_V": dyn_res["vd_v"],
          "Vq_V": dyn_res["vq_v"],
          "PsiD_Vs": dyn_res["psi_d_vs"],
          "PsiQ_Vs": dyn_res["psi_q_vs"],
          "Pelec_W": dyn_res["p_elec_w"],
          "Pcu_W": dyn_res["p_copper_w"],
          "Pmech_W": dyn_res["p_mech_w"],
          "Pload_W": dyn_res["p_load_w"],
          "Pfriction_W": dyn_res["p_friction_w"],
          "PmagneticStoredRate_W": dyn_res["p_magnetic_stored_rate_w"],
          "PmechanicalStoredRate_W": dyn_res["p_mechanical_stored_rate_w"],
          "ElectricalBalanceResidual_W": dyn_res["p_electrical_balance_residual_w"],
          "MechanicalBalanceResidual_W": dyn_res["p_mechanical_balance_residual_w"],
          "Te_Nm": dyn_res["te_nm"],
          "T_load_Nm": dyn_res["t_load_nm"],
          "quadrant": dyn_res["quadrant_mode"],
      })
      csv_header = f"# WAVEFORM_PROVENANCE=MODEL_SYNTHETIC_DYNAMIC_ASSUMED_UNCALIBRATED\n# SOURCE_MODEL={('dynamic_pmsm_dq_rk4_flux_map' if imported_flux_map else 'dynamic_pmsm_dq_rk4')}\n"
      st.download_button(
          f"下载动态仿真 CSV ({len(df_dyn_csv)} 行)",
          data=(csv_header + df_dyn_csv.to_csv(index=False)).encode("utf-8"),
          file_name="dynamic_pmsm_synthetic.csv",
          mime="text/csv",
      )
  `;

  export async function downloadPythonBundleZip(): Promise<void> {
    const zip = new JSZip();
    zip.file('requirements.txt', REQUIREMENTS_TXT);
    zip.file('motor_physics.py', MOTOR_PHYSICS_PY);
    zip.file('dyno_calibrator.py', DYNO_CALIBRATOR_PY);
    zip.file('thermal_exporter.py', THERMAL_EXPORTER_PY);
    zip.file('dynamic_pmsm.py', DYNAMIC_PMSM_PY);
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
    { name: 'dynamic_pmsm.py', content: DYNAMIC_PMSM_PY },
    { name: 'app.py', content: APP_PY },
  ];
