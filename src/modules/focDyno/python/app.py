"""
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
    p.eta_inv = st.number_input("逆变级效率 η_inv（0<η≤1；1=不修正）", 0.001, 1.0, float(p.eta_inv), format="%.3f")
    p.i_deadband = st.number_input("零漂死区 |I_net| < (A)", 0.0, 0.2, float(p.i_deadband), format="%.3f")
    p.r_line = st.number_input("母线线阻 R_line (Ω)", 0.0, 1.0, float(p.r_line), format="%.4f")
    p.rds_on_mohm = st.number_input("MOSFET Rds(on) (mΩ)", 0.5, 200.0, float(p.rds_on_mohm), format="%.1f")
    p.t_dead_ns = st.number_input("死区时间 t_dead (ns)", 0.0, 3000.0, float(p.t_dead_ns), format="%.0f")
    p.f_sw_khz = st.number_input("开关频率 f_sw (kHz；t_dead>0 时必需)", 0.0, 200.0, float(p.f_sw_khz), format="%.1f")
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
  