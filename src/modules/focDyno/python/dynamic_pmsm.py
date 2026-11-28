"""
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
    ref_t = float(params.reference_temp_c)
    wind_t = float(params.winding_temp_c if params.winding_temp_c is not None else ref_t)
    rs_eff = max(0.0, float(params.rs_ohm) * (1.0 + float(params.rs_temp_coeff_per_c) * (wind_t - ref_t)))

    if params.flux_map is not None:
        flux_map = params.flux_map
        validate_pmsm_flux_map(flux_map)
        sign = 1.0 if i_torque_cmd_a >= 0 else -1.0
        i_max_map = max(0.05, float(params.i_max_a))
        requested_iq = sign * min(abs(i_torque_cmd_a), i_max_map)
        if params.control_mode == "id_zero":
            return {
                "id_ref_a": 0.0,
                "iq_ref_a": requested_iq,
                "current_limited": abs(i_torque_cmd_a) > i_max_map + 1e-9,
                "field_weakening_active": False,
            }
        target_torque = calc_dynamic_pmsm_torque(0.0, requested_iq, params.pole_pairs, params.psi_f_vs, params.ld_h, params.lq_h, flux_map)
        v_max = max(0.5, float(v_bus_v)) / math.sqrt(3.0) * 0.96
        rs = rs_eff
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
            id_ref = (2.0 * dl * i_mag * i_mag) / (psi + math.sqrt(disc))
            id_bound = i_mag * 0.95
            if abs(id_ref) > id_bound:
                id_ref = math.copysign(id_bound, id_ref)
            iq_ref = sign_q * math.sqrt(max(0.0, i_mag * i_mag - id_ref * id_ref))

    v_max_eff = (max(0.5, float(v_bus_v)) / math.sqrt(3.0)) * 0.96
    abs_we = abs(omega_e_rad_s)
    fw_active = False
    if abs_we > 1.0 and params.control_mode == "mtpa_current_loop":
        vd_req = rs_eff * id_ref - omega_e_rad_s * params.lq_h * iq_ref
        vq_req = rs_eff * iq_ref + omega_e_rad_s * (params.ld_h * id_ref + params.psi_f_vs)
        v_req = math.hypot(vd_req, vq_req)
        if v_req > v_max_eff:
            fw_active = True
            lo_init = -i_max
            hi_init = id_ref
            abs_iq_target = abs(iq_ref)
            a_quad = rs_eff * rs_eff + omega_e_rad_s * omega_e_rad_s * params.lq_h * params.lq_h
            exact_id = None
            exact_i2 = float("inf")
            best_id = lo_init
            best_iq_abs = 0.0
            samples = 40
            for k in range(samples + 1):
                id_cand = lo_init + ((hi_init - lo_init) * k) / samples
                iq_cap_cur = math.sqrt(max(0.0, i_max * i_max - id_cand * id_cand))
                a0 = rs_eff * id_cand
                b0 = omega_e_rad_s * (params.ld_h * id_cand + params.psi_f_vs)
                b_quad = sign_q * rs_eff * omega_e_rad_s * ((params.ld_h - params.lq_h) * id_cand + params.psi_f_vs)
                c_quad = a0 * a0 + b0 * b0 - v_max_eff * v_max_eff
                disc_q = b_quad * b_quad - a_quad * c_quad
                if disc_q < 0.0:
                    continue
                sqrt_disc = math.sqrt(disc_q)
                x_lo = max(0.0, (-b_quad - sqrt_disc) / a_quad)
                x_hi = min(iq_cap_cur, (-b_quad + sqrt_disc) / a_quad)
                if x_hi < x_lo - 1e-12:
                    continue
                if abs_iq_target >= x_lo - 1e-12 and abs_iq_target <= x_hi + 1e-12:
                    cand_i2 = id_cand * id_cand + abs_iq_target * abs_iq_target
                    if cand_i2 < exact_i2:
                        exact_i2 = cand_i2
                        exact_id = id_cand
                iq_feas = min(abs_iq_target, x_hi)
                if iq_feas >= x_lo - 1e-12 and x_hi > best_iq_abs:
                    best_iq_abs = x_hi
                    best_id = id_cand
            if exact_id is not None:
                id_ref = exact_id
                iq_ref = sign_q * abs_iq_target
            else:
                id_ref = best_id
                iq_ref = sign_q * min(abs_iq_target, best_iq_abs)

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
        rs_temp_coeff_per_c=0.0,
        psi_temp_coeff_per_c=0.0,
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
            psi_d, psi_q, ldd, _ldq, _lqd, lqq = evaluate_pmsm_flux(cur_id, cur_iq, psi_f, ld, lq, params.flux_map)
            vd_cmd = (ldd * bw_i) * err_d + int_id - we * psi_q
            vq_cmd = (lqq * bw_i) * err_q + int_iq + we * psi_d

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
