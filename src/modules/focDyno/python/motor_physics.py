"""
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


def validate_motor_params(params: MotorParams) -> None:
    """Keep Python input constraints identical to the TypeScript solver."""
    finite_fields = {
        "pole_pairs": params.pole_pairs, "ke_prime": params.ke_prime,
        "r_ll_25": params.r_ll_25, "t_coil": params.t_coil,
        "l_ll_mh": params.l_ll_mh, "n0_rpm": params.n0_rpm,
        "beta_sat": params.beta_sat, "p0_a": params.p0_a, "p0_b": params.p0_b,
        "i_idle": params.i_idle, "eta_inv": params.eta_inv,
        "i_deadband": params.i_deadband, "r_line": params.r_line,
        "rds_on_mohm": params.rds_on_mohm, "t_dead_ns": params.t_dead_ns,
        "f_sw_khz": params.f_sw_khz, "v_sd": params.v_sd,
    }
    for label, value in finite_fields.items():
        if not math.isfinite(float(value)):
            raise ValueError(f"{label} must be a finite number")
    if isinstance(params.pole_pairs, bool) or int(params.pole_pairs) != params.pole_pairs or not (1 <= params.pole_pairs <= 100):
        raise ValueError("pole_pairs must be an integer in [1, 100]")
    if params.ke_prime <= 0 or params.r_ll_25 <= 0 or params.n0_rpm <= 0:
        raise ValueError("ke_prime, r_ll_25 and n0_rpm must be > 0")
    if params.t_coil <= -273.15 or params.l_ll_mh < 0:
        raise ValueError("t_coil must be above absolute zero and l_ll_mh must be >= 0")
    if min(params.beta_sat, params.p0_a, params.p0_b) < 0:
        raise ValueError("beta_sat and P0 coefficients must be >= 0")
    if params.rs_eff_override is not None and (not math.isfinite(params.rs_eff_override) or params.rs_eff_override <= 0):
        raise ValueError("rs_eff_override must be None or > 0")
    if min(params.i_idle, params.i_deadband, params.r_line, params.rds_on_mohm,
           params.t_dead_ns, params.f_sw_khz, params.v_sd) < 0:
        raise ValueError("drive parameters must be >= 0")
    if not (math.isfinite(params.eta_inv) and 0.0 < params.eta_inv <= 1.0):
        raise ValueError("eta_inv must satisfy 0 < eta_inv <= 1.0; 1.0 disables inverter-efficiency correction")
    if params.t_dead_ns > 0 and params.f_sw_khz <= 0:
        raise ValueError("f_sw_khz must be > 0 when deadtime correction is enabled; set t_dead_ns to 0 to disable it")


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
    validate_motor_params(params)
    if not math.isfinite(v_meas) or not math.isfinite(n_rpm) or math.isinf(i_bus):
        raise ValueError("v_meas and n_rpm must be finite; i_bus may be NaN only for invalid samples")
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
    eta_inv = params.eta_inv
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
            # Rationalized root avoids catastrophic cancellation near zero load.
            iq = sign_eq * (4.0 / 3.0) * p_elec / (math.sqrt(delta) + abs(eq0))
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
                        stable_denom = math.sqrt(d_iter) + abs(eq_cur)
                        fp = sign_eq * (4.0 / 3.0) * p_elec / stable_denom if stable_denom > 0.0 else 0.0
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
    validate_motor_params(params)
    if not math.isfinite(iq) or not math.isfinite(n_rpm) or not math.isfinite(v_meas):
        raise ValueError("iq, n_rpm and v_meas must be finite")
    omega_m = calc_omega_m(n_rpm)
    omega_e = calc_omega_e(n_rpm, params.pole_pairs)
    rs = get_effective_rs(params)
    lq = calc_lq_h(params.l_ll_mh)
    k_sat = calc_ksat(iq, params.beta_sat)
    eq = params.ke_prime * omega_m * k_sat
    p_elec = 1.5 * (eq * iq + rs * iq * iq)
    eta_inv = params.eta_inv
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
            # Stable low-current root; avoid cancellation for small electrical power.
            stable_denom = -b + math.sqrt(disc)
            if stable_denom > 0.0:
                i_bus_est = (2.0 * c) / stable_denom
            else:
                line_collapse = True

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
