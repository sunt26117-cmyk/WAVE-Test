"""
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
        vbus_spread_warn = _check_vbus_spread_warning(df_eval["V_bus"].tolist())
        if vbus_spread_warn:
            calib_warnings.append(vbus_spread_warn)
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


def _check_vbus_spread_warning(vbus_values) -> Optional[str]:
    vals = []
    for raw_v in vbus_values:
        if raw_v is None:
            continue
        try:
            fv = float(raw_v)
        except (TypeError, ValueError):
            continue
        if math.isfinite(fv) and fv > 0.0:
            vals.append(fv)
    if len(vals) < 2:
        return None
    v_min = min(vals)
    v_max = max(vals)
    v_mean = sum(vals) / len(vals)
    if v_mean > 1e-6 and (v_max - v_min) / v_mean > 0.05:
        spread_pct = ((v_max - v_min) / v_mean) * 100.0
        return (
            f"闭环测点母线电压离散度为 {spread_pct:.1f}% (>5%，范围 {v_min:.2f}V～{v_max:.2f}V)；"
            "单平面 2D 效率 Map 混合了不同母线电压工况，请按电压分组评估或以实测工况点为准。"
        )
    return None


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
