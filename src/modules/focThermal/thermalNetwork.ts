/**
 * FOC 6-MOS Spatial PCB Thermal Network, Foster/Cauer Splitting, SPICE Netlist & ODE/Steady Solvers
 */
import { CauerStage, ThermalPathMode, simulateCauerZoh } from "../thermalEngine";
import {
  DEFAULT_FOC_MODEL,
  FocCauerSplitMeta,
  FocModelProvenanceKind,
  FocSpiceValidationResult,
  FocThermalModel,
  FocThermalTopologyMode,
  MOS_SWITCH_KEYS,
  MosSwitchKey,
  PcbSpatialImportDocument,
  PcbSpatialThermalMatrixConfig,
  PcbThermalLinkConfig,
  PcbZoneConfig,
  ResolvedSpatialNetwork,
  ThermalNetworkStateSnapshot,
} from "./types";

export function resolveSpatialThermalNetwork(model: FocThermalModel): ResolvedSpatialNetwork {
  const mode: FocThermalTopologyMode = model.thermalTopologyMode ?? 'shared_board';
  const brd = model.zthBoard.length > 0 ? model.zthBoard : DEFAULT_FOC_MODEL.zthBoard;
  const rBrdFirst = Math.max(0.05, brd[0]?.r ?? 0.45);
  const cBrdFirst = Math.max(0.05, brd[0]?.c ?? 0.85);
  const cfg = model.spatialMatrix;
  if (cfg) {
    const allowedProvenance: NonNullable<PcbSpatialThermalMatrixConfig['provenance']>[] = ['measured', 'geometry_estimated', 'user_matrix', 'fea_extracted', 'datasheet_estimated'];
    if (cfg.provenance !== undefined && !allowedProvenance.includes(cfg.provenance)) throw new Error(`PCB 热网络 provenance 非法：${String(cfg.provenance)}。`);
    if (cfg.stackup !== undefined && !Array.isArray(cfg.stackup)) throw new Error('PCB stackup 必须为数组。');
    if (cfg.links !== undefined && !Array.isArray(cfg.links)) throw new Error('PCB links 必须为数组。');
    if (cfg.zones !== undefined && !Array.isArray(cfg.zones)) throw new Error('PCB zones 必须为数组。');
  }

  const cPcb = new Float64Array(6);
  const rVert = new Float64Array(6);
  const gLat = Array.from({ length: 6 }, () => new Float64Array(6));

  if (mode === 'shared_board') {
    for (let m = 0; m < 6; m++) {
      cPcb[m] = cBrdFirst / 6;
      rVert[m] = 1e-6;
    }
    return {
      mode,
      cPcb,
      rVert,
      gLat,
      provenanceLabel: 'shared_board (单一集总 TBRD 节点)',
    };
  }

  if (mode === 'independent') {
    for (let m = 0; m < 6; m++) {
      const cap = cfg?.zoneThermalCapJPerC?.[m] ?? cfg?.zones?.[m]?.cPcbJPerC ?? cBrdFirst / 6;
      const rv = cfg?.zoneVerticalRthCPerW?.[m] ?? cfg?.zones?.[m]?.rVertCPerW ?? rBrdFirst * 0.4;
      if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(rv) || rv <= 0) {
        throw new Error(`独立热路径第 ${m + 1} 路 PCB 热容/热阻必须为有限正数。`);
      }
      cPcb[m] = cap;
      rVert[m] = rv;
    }
    return {
      mode,
      cPcb,
      rVert,
      gLat,
      provenanceLabel: 'independent (六管完全独立散热臂，G_ij = 0)',
    };
  }

  // pcb_spatial_coupled: physical six-zone network. Prefer an imported conductance
  // matrix or explicit copper links; geometry-only estimation creates a nearest-neighbour
  // graph instead of the previous unrealistic all-to-all coupling.
  const pitch = cfg?.layoutPitchMm ?? 14;
  if (!Number.isFinite(pitch) || pitch <= 0) throw new Error('PCB 布局节距必须为有限正数。');
  const defaultZones: PcbZoneConfig[] = [
    { xMm: 0, yMm: 0 },
    { xMm: 0, yMm: pitch * 0.65 },
    { xMm: pitch, yMm: 0 },
    { xMm: pitch, yMm: pitch * 0.65 },
    { xMm: 2 * pitch, yMm: 0 },
    { xMm: 2 * pitch, yMm: pitch * 0.65 },
  ];
  if (cfg?.zones && cfg.zones.length !== 6) {
    throw new Error(`PCB zones 必须严格包含 6 个区域 (AH/AL/BH/BL/CH/CL)，当前 ${cfg.zones.length} 个；禁止静默回退默认布局。`);
  }
  const zones = cfg?.zones ?? defaultZones;
  zones.forEach((z, i) => {
    if (!Number.isFinite(z.xMm) || !Number.isFinite(z.yMm)) {
      throw new Error(`PCB 区域 ${MOS_SWITCH_KEYS[i]} 的坐标必须为有限数值。`);
    }
    if (z.areaMm2 !== undefined && (!Number.isFinite(z.areaMm2) || z.areaMm2 <= 0)) {
      throw new Error(`PCB 区域 ${MOS_SWITCH_KEYS[i]} 的 areaMm2 必须为有限正数。`);
    }
  });
  for (let i = 0; i < 6; i++) {
    for (let j = i + 1; j < 6; j++) {
      if (Math.hypot(zones[i].xMm - zones[j].xMm, zones[i].yMm - zones[j].yMm) <= 1e-6) {
        throw new Error(`PCB 区域 ${MOS_SWITCH_KEYS[i]} 与 ${MOS_SWITCH_KEYS[j]} 坐标重合，无法建立空间热网络。`);
      }
    }
  }

  const copperOz = cfg?.copperOz ?? 2.0;
  const copperWidthMm = cfg?.copperWidthMm ?? 12.0;
  if (!Number.isFinite(copperOz) || copperOz <= 0 || !Number.isFinite(copperWidthMm) || copperWidthMm <= 0) {
    throw new Error('PCB 空间热网络铜厚 (oz) 与有效导热铜宽 (mm) 必须为有限正数。');
  }
  const copperThicknessMm = copperOz * 0.0348;
  const defaultKCu = 385.0;
  const stackup = cfg?.stackup ?? [];
  stackup.forEach((layer, i) => {
    if (
      !layer.name?.trim() || !Number.isFinite(layer.thicknessMm) || layer.thicknessMm <= 0 ||
      !Number.isFinite(layer.conductivityWPerMK) || layer.conductivityWPerMK <= 0 ||
      (layer.conductivityInPlaneWPerMK !== undefined && (!Number.isFinite(layer.conductivityInPlaneWPerMK) || layer.conductivityInPlaneWPerMK <= 0)) ||
      (layer.conductivityThroughPlaneWPerMK !== undefined && (!Number.isFinite(layer.conductivityThroughPlaneWPerMK) || layer.conductivityThroughPlaneWPerMK <= 0)) ||
      !Number.isFinite(layer.densityKgPerM3) || layer.densityKgPerM3 <= 0 ||
      !Number.isFinite(layer.specificHeatJPerKgK) || layer.specificHeatJPerKgK <= 0 ||
      (layer.coverageFraction !== undefined && (!Number.isFinite(layer.coverageFraction) || layer.coverageFraction < 0 || layer.coverageFraction > 1))
    ) throw new Error(`PCB stackup 第 ${i + 1} 层材料/厚度/热参数非法。`);
  });

  const padOffsets = model.perSwitchPadOffsetCPerW;
  if (padOffsets && padOffsets.length !== 6) throw new Error('perSwitchPadOffsetCPerW 必须为 6 个数值。');
  if (cfg?.zoneThermalCapJPerC && cfg.zoneThermalCapJPerC.length !== 6) throw new Error('zoneThermalCapJPerC 必须为 6 个数值。');
  if (cfg?.zoneVerticalRthCPerW && cfg.zoneVerticalRthCPerW.length !== 6) throw new Error('zoneVerticalRthCPerW 必须为 6 个数值。');

  const deriveZoneCap = (zone: PcbZoneConfig): number | undefined => {
    if (!zone.areaMm2 || stackup.length === 0) return undefined;
    const areaM2 = zone.areaMm2 * 1e-6;
    let cap = 0;
    for (const layer of stackup) {
      const volumeM3 = areaM2 * (layer.thicknessMm * 1e-3) * (layer.coverageFraction ?? 1);
      cap += volumeM3 * layer.densityKgPerM3 * layer.specificHeatJPerKgK;
    }
    return cap > 0 && Number.isFinite(cap) ? cap : undefined;
  };
  const deriveZoneVerticalR = (zone: PcbZoneConfig): number | undefined => {
    if (!zone.areaMm2 || stackup.length === 0) return undefined;
    const areaM2 = zone.areaMm2 * 1e-6;
    let resistance = 0;
    for (const layer of stackup) {
      const coverage = layer.coverageFraction ?? 1;
      if (coverage <= 0) continue;
      const kZ = layer.conductivityThroughPlaneWPerMK ?? layer.conductivityWPerMK;
      resistance += (layer.thicknessMm * 1e-3) / (kZ * areaM2 * coverage);
    }
    return resistance > 0 && Number.isFinite(resistance) ? resistance : undefined;
  };

  for (let m = 0; m < 6; m++) {
    const cap = cfg?.zoneThermalCapJPerC?.[m] ?? zones[m].cPcbJPerC ?? deriveZoneCap(zones[m]) ?? Math.max(0.04, cBrdFirst / 6);
    const baseRv = cfg?.zoneVerticalRthCPerW?.[m] ?? zones[m].rVertCPerW ?? deriveZoneVerticalR(zones[m]) ?? Math.max(0.15, rBrdFirst * 1.4);
    const extraPad = padOffsets ? padOffsets[m] : 0;
    if (extraPad !== undefined && (!Number.isFinite(extraPad) || extraPad < 0)) {
      throw new Error(`PCB 区域 ${MOS_SWITCH_KEYS[m]} 的 Pad 附加热阻必须为有限非负数。`);
    }
    const rv = baseRv + (extraPad ?? 0);
    if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(rv) || rv <= 0) {
      throw new Error(`PCB 空间区域 ${MOS_SWITCH_KEYS[m]} 的热容 C_pcb 或垂直热阻 R_vert 必须为有限正数。`);
    }
    cPcb[m] = cap;
    rVert[m] = rv;
  }

  const hasMatrix = Boolean(cfg?.mutualConductanceMatrixWPerC);
  const hasLinks = Boolean(cfg?.links && cfg.links.length > 0);
  if (hasMatrix && hasLinks) throw new Error('PCB 热网络不能同时提供 mutualConductanceMatrixWPerC 和 links；请选用一种互热定义，避免重复计入。');

  if (hasMatrix) {
    const mat = cfg!.mutualConductanceMatrixWPerC!;
    if (!Array.isArray(mat) || mat.length !== 6 || mat.some((row) => !Array.isArray(row) || row.length !== 6)) {
      throw new Error('PCB 互热导矩阵 mutualConductanceMatrixWPerC 必须为 6×6 矩阵。');
    }
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        const gij = mat[i][j];
        if (!Number.isFinite(gij) || gij < -1e-12) {
          throw new Error(`PCB 互热导矩阵 (${MOS_SWITCH_KEYS[i]}, ${MOS_SWITCH_KEYS[j]}) 必须为有限非负值。`);
        }
        if (i === j && Math.abs(gij) > 1e-9) throw new Error(`PCB 互热导矩阵对角线必须为 0；区域 ${MOS_SWITCH_KEYS[i]} 的对角值被忽略会掩盖输入错误。`);
        if (j > i) {
          const gji = mat[j][i];
          if (!Number.isFinite(gji) || gji < -1e-12) throw new Error(`PCB 互热导矩阵 (${MOS_SWITCH_KEYS[j]}, ${MOS_SWITCH_KEYS[i]}) 必须为有限非负值。`);
          if (Math.abs(gij - gji) > 1e-6 * Math.max(1, Math.abs(gij), Math.abs(gji))) {
            throw new Error(`PCB 互热导矩阵非对称 (${MOS_SWITCH_KEYS[i]}↔${MOS_SWITCH_KEYS[j]}: ${gij} vs ${gji})，违背热传导互易定理。`);
          }
          gLat[i][j] = gLat[j][i] = Math.max(0, 0.5 * (gij + gji));
        }
      }
    }
  } else if (hasLinks) {
    const zoneIndex = (v: number | MosSwitchKey): number => {
      const idx = typeof v === 'number' ? v : MOS_SWITCH_KEYS.indexOf(v);
      if (!Number.isInteger(idx) || idx < 0 || idx >= 6) throw new Error(`PCB thermal link 区域索引无效：${String(v)}。`);
      return idx;
    };
    const copperStackThicknessMm = stackup
      .filter((layer) => /cu|copper|铜/i.test(layer.name))
      .reduce((sum, layer) => sum + layer.thicknessMm * (layer.coverageFraction ?? 1), 0) || copperThicknessMm;
    for (const [linkIdx, link] of cfg!.links!.entries()) {
      const from = zoneIndex(link.fromZone);
      const to = zoneIndex(link.toZone);
      if (from === to) throw new Error(`PCB link #${linkIdx + 1} 不允许连接同一个区域。`);
      let g = link.conductanceWPerC;
      if (g === undefined) {
        const width = link.widthMm ?? copperWidthMm;
        const length = link.lengthMm ?? Math.hypot(zones[from].xMm - zones[to].xMm, zones[from].yMm - zones[to].yMm);
        const layers = link.parallelLayers ?? 1;
        if (![width, length, layers].every(Number.isFinite) || width <= 0 || length <= 0 || layers <= 0) {
          throw new Error(`PCB link #${linkIdx + 1} 的宽度、长度和并联路径数必须为有限正数。`);
        }
        if (link.conductivityWPerMK !== undefined || link.thicknessMm !== undefined || stackup.length === 0) {
          const thickness = link.thicknessMm ?? copperStackThicknessMm;
          const k = link.conductivityWPerMK ?? defaultKCu;
          if (![thickness, k].every(Number.isFinite) || thickness <= 0 || k <= 0) throw new Error(`PCB link #${linkIdx + 1} 的厚度或导热率非法。`);
          g = k * (width * 1e-3) * (thickness * 1e-3) * layers / (length * 1e-3);
        } else {
          // Parallel in-plane conduction through each imported PCB layer; directional kx/ky
          // is used instead of incorrectly applying through-plane FR4 conductivity.
          g = stackup.reduce((sum, layer) => {
            const kXY = layer.conductivityInPlaneWPerMK ?? layer.conductivityWPerMK;
            const aM2 = (width * 1e-3) * (layer.thicknessMm * 1e-3) * (layer.coverageFraction ?? 1);
            return sum + kXY * aM2 / (length * 1e-3);
          }, 0) * layers;
        }
      }
      if (!Number.isFinite(g) || g < 0) throw new Error(`PCB link #${linkIdx + 1} 的导热系数必须为有限非负值。`);
      gLat[from][to] += g;
      gLat[to][from] += g;
    }
  } else {
    // Geometry-only estimate: connect only nearest-neighbour zones. Do not create
    // artificial direct thermal paths between every pair of MOS regions.
    const minDistance = new Float64Array(6).fill(Infinity);
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) if (i !== j) {
        const d = Math.hypot(zones[i].xMm - zones[j].xMm, zones[i].yMm - zones[j].yMm);
        minDistance[i] = Math.min(minDistance[i], d);
      }
    }
    const thicknessM = copperThicknessMm * 1e-3;
    for (let i = 0; i < 6; i++) {
      for (let j = i + 1; j < 6; j++) {
        const distanceMm = Math.hypot(zones[i].xMm - zones[j].xMm, zones[i].yMm - zones[j].yMm);
        const neighbourLimit = 1.35 * Math.max(minDistance[i], minDistance[j]);
        if (distanceMm > neighbourLimit) continue;
        const gPair = defaultKCu * thicknessM * (copperWidthMm * 1e-3) / (distanceMm * 1e-3);
        gLat[i][j] = gPair;
        gLat[j][i] = gPair;
      }
    }
  }

  const prov = cfg?.provenance === 'measured'
    ? '实测热耦合矩阵 (measured)'
    : cfg?.provenance === 'fea_extracted'
    ? 'FEA 提取热网络 (fea_extracted)'
    : cfg?.provenance === 'user_matrix'
    ? '用户导入对称无源互导矩阵'
    : cfg?.provenance === 'datasheet_estimated'
    ? '材料/数据手册估算热网络'
    : `几何近邻估算 (${copperOz.toFixed(1)}oz, pitch=${pitch.toFixed(1)}mm)`;
  const source = cfg?.sourceLabel ? ` · ${cfg.sourceLabel}` : '';
  return {
    mode,
    cPcb,
    rVert,
    gLat,
    provenanceLabel: `pcb_spatial_coupled · ${prov}${source}`,
  };
}


/** Parse a versioned PCB thermal-network JSON document for future CAD/FEA/test imports. */
export function parsePcbSpatialImportJson(text: string): PcbSpatialImportDocument {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (err) {
    throw new Error(`PCB 热网络 JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== 'object') throw new Error('PCB 热网络导入文件必须是 JSON 对象。');
  const doc = raw as Partial<PcbSpatialImportDocument>;
  if (doc.schema !== 'wave-test-pcb-thermal' || doc.schemaVersion !== 1 || doc.units !== 'mm' || !doc.config || typeof doc.config !== 'object') {
    throw new Error('PCB 热网络文件格式不匹配：需要 schema=wave-test-pcb-thermal、schemaVersion=1、units=mm 和 config。');
  }
  const allowedProvenance: NonNullable<PcbSpatialThermalMatrixConfig['provenance']>[] = ['measured', 'geometry_estimated', 'user_matrix', 'fea_extracted', 'datasheet_estimated'];
  const provenance = doc.config.provenance ?? (doc.config.mutualConductanceMatrixWPerC ? 'user_matrix' : 'geometry_estimated');
  if (!allowedProvenance.includes(provenance)) throw new Error(`PCB 热网络 provenance 非法：${String(provenance)}。`);
  const config: PcbSpatialThermalMatrixConfig = {
    ...doc.config,
    provenance,
  };
  const testModel: FocThermalModel = {
    zthJC: DEFAULT_FOC_MODEL.zthJC,
    zthBoard: DEFAULT_FOC_MODEL.zthBoard,
    thermalTopologyMode: 'pcb_spatial_coupled',
    spatialMatrix: config,
  };
  resolveSpatialThermalNetwork(testModel); // Run the same physical/schema validation used by the solver.
  return { ...doc, config } as PcbSpatialImportDocument;
}

export function createPcbSpatialImportTemplate(): PcbSpatialImportDocument {
  return {
    schema: 'wave-test-pcb-thermal',
    schemaVersion: 1,
    deviceName: '请填写逆变器/MOS 型号',
    boardName: '请填写 PCB 版本',
    units: 'mm',
    config: {
      provenance: 'geometry_estimated',
      sourceLabel: 'CAD/FEA/热测试导入模板',
      copperOz: 2,
      copperWidthMm: 8,
      zones: MOS_SWITCH_KEYS.map((key, i) => ({
        xMm: Math.floor(i / 2) * 20,
        yMm: (i % 2) * 12,
        areaMm2: 120,
        rVertCPerW: 1.5,
      })),
      stackup: [
        { name: 'Top copper', thicknessMm: 0.07, conductivityWPerMK: 385, conductivityInPlaneWPerMK: 385, conductivityThroughPlaneWPerMK: 385, densityKgPerM3: 8960, specificHeatJPerKgK: 385, coverageFraction: 0.55 },
        { name: 'FR4 core', thicknessMm: 1.2, conductivityWPerMK: 0.35, conductivityInPlaneWPerMK: 0.35, conductivityThroughPlaneWPerMK: 0.28, densityKgPerM3: 1850, specificHeatJPerKgK: 1100, coverageFraction: 1 },
        { name: 'Bottom copper', thicknessMm: 0.07, conductivityWPerMK: 385, conductivityInPlaneWPerMK: 385, conductivityThroughPlaneWPerMK: 385, densityKgPerM3: 8960, specificHeatJPerKgK: 385, coverageFraction: 0.4 },
      ],
      links: [
        { fromZone: 'AH', toZone: 'BH', widthMm: 8, lengthMm: 20, parallelLayers: 1 },
        { fromZone: 'BH', toZone: 'CH', widthMm: 8, lengthMm: 20, parallelLayers: 1 },
        { fromZone: 'AL', toZone: 'BL', widthMm: 8, lengthMm: 20, parallelLayers: 1 },
        { fromZone: 'BL', toZone: 'CL', widthMm: 8, lengthMm: 20, parallelLayers: 1 },
        { fromZone: 'AH', toZone: 'AL', widthMm: 8, lengthMm: 12, parallelLayers: 1 },
        { fromZone: 'BH', toZone: 'BL', widthMm: 8, lengthMm: 12, parallelLayers: 1 },
        { fromZone: 'CH', toZone: 'CL', widthMm: 8, lengthMm: 12, parallelLayers: 1 },
      ],
    },
  };
}

export function buildPerSwitchJcChains(model: FocThermalModel): CauerStage[][] {
  const baseJc = model.zthJC.length > 0 ? model.zthJC : DEFAULT_FOC_MODEL.zthJC;
  const scales = model.perSwitchRjcScale;
  const padOffsets = model.perSwitchPadOffsetCPerW;
  const spatialMode = (model.thermalTopologyMode ?? 'shared_board') === 'pcb_spatial_coupled';
  return MOS_SWITCH_KEYS.map((_, m) => {
    const sc = scales && scales.length === 6 && Number.isFinite(scales[m]) && scales[m] > 0 ? scales[m] : 1.0;
    const padR = !spatialMode && padOffsets && padOffsets.length === 6 && Number.isFinite(padOffsets[m]) && padOffsets[m] > 0 ? padOffsets[m] : 0;
    const stages = baseJc.map((s) => ({
      r: s.r * sc,
      c: s.c,
      tauEst: s.r * sc * s.c,
      layerLabel: s.layerLabel,
    }));
    if (padR > 0 && stages.length > 0) {
      const last = stages[stages.length - 1];
      last.r += padR;
      last.tauEst = last.r * last.c;
    }
    return stages;
  });
}

function computeCauerSplitValidation(
  origStages: CauerStage[],
  splitChain: CauerStage[]
): { passed: boolean; maxRelErrPct: number; rthOrig: number; rthSplit: number } {
  const rthOrig = origStages.reduce((a, s) => a + Math.max(0, s.r), 0);
  const rthSplit = splitChain.reduce((a, s) => a + Math.max(0, s.r), 0);
  if (origStages.length === 0 || splitChain.length === 0 || rthOrig <= 1e-9) {
    return { passed: true, maxRelErrPct: 0, rthOrig, rthSplit };
  }
  const taus = [...origStages, ...splitChain].map((s) => Math.max(1e-5, s.r * s.c));
  const tMin = Math.max(1e-5, Math.min(...taus) * 0.25);
  const tMax = Math.max(tMin * 20, Math.max(...taus) * 3.5);
  const nPts = 80;
  const tArr = new Float64Array(nPts);
  const pArr = new Float32Array(nPts).fill(1);
  for (let i = 0; i < nPts; i++) {
    tArr[i] = i === 0 ? 0 : tMin * Math.pow(tMax / tMin, (i - 1) / Math.max(1, nPts - 2));
  }
  const zOrig = simulateCauerZoh(tArr, pArr, origStages, 0);
  const zSplit = simulateCauerZoh(tArr, pArr, splitChain, 0);
  let maxRelErr = 0;
  const rRef = Math.max(1e-4, rthOrig);
  for (let i = 1; i < nPts; i++) {
    const err = Math.abs(zSplit[i] - zOrig[i]) / Math.max(0.05 * rRef, Math.abs(zOrig[i]));
    if (err > maxRelErr) maxRelErr = err;
  }
  const maxRelErrPct = maxRelErr * 100;
  const rthRelErr = Math.abs(rthSplit - rthOrig) / rRef;
  return {
    passed: rthRelErr <= 0.02 && maxRelErrPct <= 45,
    maxRelErrPct,
    rthOrig,
    rthSplit,
  };
}

export function splitCauerToFocModel(
  fullCauer: CauerStage[],
  tauSplitSec = 0.05,
  options?: {
    pathMode?: ThermalPathMode;
    rJcDatasheetOhm?: number;
  }
): FocThermalModel {
  const pathMode: ThermalPathMode = options?.pathMode === 'pad_ambient' ? 'pad_ambient' : 'junction_ambient';
  const rJcConstraint =
    options?.rJcDatasheetOhm !== undefined && Number.isFinite(options.rJcDatasheetOhm) && options.rJcDatasheetOhm > 0
      ? options.rJcDatasheetOhm
      : null;

  if (!fullCauer || fullCauer.length === 0) {
    return {
      zthJC: DEFAULT_FOC_MODEL.zthJC.map((s) => ({ ...s })),
      zthBoard: DEFAULT_FOC_MODEL.zthBoard.map((s) => ({ ...s })),
      modelKind: 'fallback_default',
      provenanceNote: DEFAULT_FOC_MODEL.provenanceNote,
      isHeuristicSingleStageSplit: false,
      splitFeasible: true,
    };
  }

  // A measured Tj-to-ambient curve does not identify the physical JC/board
  // boundary by time-constant heuristics. Require a datasheet RθJC anchor and
  // at least two Cauer sections so a physical boundary can be selected.
  if (pathMode === 'pad_ambient') {
    const warning = '当前数据来自 PCB/焊盘测温，只能识别 Pad-to-Ambient 热响应；没有实测 TSEP/ZthJC 瞬态曲线，不能构造真实 Junction-to-Case 网络。已禁止进入六管结温仿真。';
    return {
      zthJC: [],
      zthBoard: fullCauer.map((s) => ({ ...s })),
      modelKind: 'pad_ambient',
      provenanceNote: warning,
      isHeuristicSingleStageSplit: false,
      splitFeasible: false,
      splitMeta: { tauSplitSec, boundaryIndex: 0, boundaryAdjusted: false, nonMonotonicTau: false, shuntCapRatioPct: 0, warning },
    };
  }
  if (rJcConstraint === null) {
    const warning = '缺少器件手册 RθJC 约束。整体 Tj-to-Ambient Cauer 网络无法仅凭 τ_split 唯一拆分为 Junction-to-Case 与 Board-to-Ambient；已拒绝经验时间常数拆分。';
    return {
      zthJC: fullCauer.map((s) => ({ ...s })),
      zthBoard: [],
      modelKind: 'junction_ambient',
      provenanceNote: warning,
      isHeuristicSingleStageSplit: fullCauer.length === 1,
      splitFeasible: false,
      splitMeta: { tauSplitSec, boundaryIndex: 0, boundaryAdjusted: false, nonMonotonicTau: false, shuntCapRatioPct: 0, warning },
    };
  }
  if (fullCauer.length < 2) {
    const warning = '实测 Cauer 仅有一个热段，无法在保持阶梯物理结构的前提下独立识别 JC 与 Board；需要更高时间分辨率的热瞬态数据或独立 ZthJC 曲线。';
    return {
      zthJC: fullCauer.map((s) => ({ ...s })),
      zthBoard: [],
      modelKind: 'junction_ambient',
      provenanceNote: warning,
      isHeuristicSingleStageSplit: true,
      splitFeasible: false,
      splitMeta: { tauSplitSec, boundaryIndex: 0, boundaryAdjusted: false, nonMonotonicTau: false, shuntCapRatioPct: 0, warning },
    };
  }

  // Physical boundary is only estimated from the datasheet RθJC resistance anchor.
  // The measured Tj→Ambient Foster/Cauer response alone cannot uniquely identify JC vs PCB.
  const totalR = fullCauer.reduce((acc, stage) => acc + stage.r, 0);
  const warningBase = '边界由器件手册 RθJC 锚定并通过整体阶跃响应校验；该等效拆分仍不等价于独立实测 ZthJC/ZthBoard，签核前必须由器件/PCB 实测验证。';
  if (!Number.isFinite(totalR) || totalR <= rJcConstraint! * 1.02) {
    const warning = `RθJC 约束 ${rJcConstraint!.toFixed(3)}°C/W 不小于可用实测总热阻 ${totalR.toFixed(3)}°C/W，无法建立正值 Board 热阻。`;
    return {
      zthJC: fullCauer.map((stage) => ({ ...stage })),
      zthBoard: [],
      modelKind: 'junction_ambient',
      provenanceNote: warning,
      isHeuristicSingleStageSplit: false,
      splitFeasible: false,
      splitMeta: { tauSplitSec, boundaryIndex: 0, boundaryAdjusted: false, nonMonotonicTau: false, shuntCapRatioPct: 0, warning },
    };
  }

  let nonMonotonicTau = false;
  for (let i = 1; i < fullCauer.length; i++) {
    if (!Number.isFinite(fullCauer[i].tauEst) || fullCauer[i].tauEst < fullCauer[i - 1].tauEst * 0.99) {
      nonMonotonicTau = true;
      break;
    }
  }

  // Select the RC-stage boundary whose cumulative R is closest to datasheet RθJC.
  let splitIdx = 1;
  let bestDiff = Infinity;
  let cumulativeR = 0;
  for (let i = 0; i < fullCauer.length - 1; i++) {
    cumulativeR += fullCauer[i].r;
    const diff = Math.abs(cumulativeR - rJcConstraint!);
    if (diff < bestDiff) {
      bestDiff = diff;
      splitIdx = i + 1;
    }
  }

  const candJc = fullCauer.slice(0, splitIdx).map((stage) => ({ ...stage }));
  const candBoard = fullCauer.slice(splitIdx).map((stage) => ({ ...stage }));
  const rawJcR = candJc.reduce((acc, stage) => acc + stage.r, 0);
  const deltaR = rawJcR - rJcConstraint!;
  if (candJc.length === 0 || candBoard.length === 0 || !(rawJcR > 0) || !(candBoard[0].r + deltaR > 1e-4)) {
    const warning = `按 RθJC=${rJcConstraint!.toFixed(3)}°C/W 选择的边界无法保持正值 JC/Board 热阻，已拒绝结温仿真。`;
    return {
      zthJC: candJc,
      zthBoard: candBoard,
      modelKind: 'junction_ambient',
      provenanceNote: warning,
      isHeuristicSingleStageSplit: false,
      splitFeasible: false,
      splitMeta: { tauSplitSec, boundaryIndex: splitIdx, boundaryAdjusted: false, nonMonotonicTau, shuntCapRatioPct: 0, warning },
    };
  }

  const scaleJc = rJcConstraint! / rawJcR;
  const jc = candJc.map((stage) => ({
    ...stage,
    r: stage.r * scaleJc,
    tauEst: stage.r * scaleJc * stage.c,
  }));
  const board = candBoard.map((stage) => ({ ...stage }));
  board[0] = {
    ...board[0],
    r: board[0].r + deltaR,
    tauEst: (board[0].r + deltaR) * board[0].c,
  };

  const sumJcCap = jc.reduce((acc, stage) => acc + stage.c, 0);
  const sumBoardCap = board.reduce((acc, stage) => acc + stage.c, 0);
  const shuntCapRatioPct = sumBoardCap > 1e-12 ? ((5 * sumJcCap) / sumBoardCap) * 100 : 0;
  const zthValidation = computeCauerSplitValidation(fullCauer, [...jc, ...board]);
  const splitFeasible = zthValidation.passed && [...jc, ...board].every((stage) =>
    Number.isFinite(stage.r) && stage.r > 0 && Number.isFinite(stage.c) && stage.c > 0
  );
  const warnings: string[] = [warningBase];
  if (nonMonotonicTau) warnings.push('原始 Cauer 阶梯 τ 非单调；边界仍按串联热阻锚定，需复核反演阶梯物理顺序。');
  if (shuntCapRatioPct > 35) warnings.push(`六臂星形网络的并联 JC 热容占比为 ${shuntCapRatioPct.toFixed(0)}%，共享 Board 节点会影响单管瞬态响应。`);
  if (!zthValidation.passed) {
    warnings.push(`拆分后整体阶跃响应校验未通过（最大相对偏差 ${zthValidation.maxRelErrPct.toFixed(1)}%）；已禁止进入 6-MOS 结温仿真。`);
  }

  return {
    zthJC: jc,
    zthBoard: board,
    modelKind: splitFeasible ? 'datasheet_constrained' : 'junction_ambient',
    provenanceNote: `来源：Tj-to-Ambient 热响应反演 + 手册 RθJC=${rJcConstraint!.toFixed(3)}°C/W 电阻锚定；${warningBase}`,
    isHeuristicSingleStageSplit: false,
    splitFeasible,
    zthValidation,
    splitMeta: {
      tauSplitSec,
      boundaryIndex: splitIdx,
      boundaryAdjusted: true,
      nonMonotonicTau,
      shuntCapRatioPct,
      warning: warnings.join('；'),
    },
  };
}

/**
 * Generates 7-port star-coupled LTspice thermal netlist:
 * .subckt INV_6MOS_THERM Q1 Q2 Q3 Q4 Q5 Q6 TAMB
 * Each MOS arm has its own grounded Cauer chain ZthJC meeting at shared TBRD -> Zth_board -> TAMB.
 */
export function focModelToSpice(
  model: FocThermalModel,
  tAmbC = 25,
  subcktName = 'INV_6MOS_THERM'
): string {
  if (model.splitFeasible === false) {
    throw new Error(model.splitMeta?.warning || 'JC/Board 热路径拆分未通过物理约束校验，拒绝导出 6-MOS LTspice 热网络。');
  }
  const armJcs = buildPerSwitchJcChains(model);
  const brd = model.zthBoard.length > 0 ? model.zthBoard : DEFAULT_FOC_MODEL.zthBoard;
  const spatial = resolveSpatialThermalNetwork(model);
  const lines: string[] = [
    `* Waveform Viewer Pro - 6-MOS BLDC Inverter Thermal Subcircuit (${spatial.mode})`,
    `* Provenance: ${model.provenanceNote || model.modelKind || 'Custom Model'} | Topology: ${spatial.provenanceLabel}`,
    `* Ports: Q1(AH) Q2(AL) Q3(BH) Q4(BL) Q5(CH) Q6(CL) TAMB`,
  ];
  if (spatial.mode === 'shared_board') {
    lines.push(`* Shared Board Node: TBRD`);
  } else if (spatial.mode === 'pcb_spatial_coupled') {
    lines.push(`* Spatial 6-Zone PCB Nodes: PCB_AH..PCB_CL -> Shared Heatsink TBRD -> TAMB`);
  } else {
    lines.push(`* Independent Per-MOS Board Paths: TBRD_AH..TBRD_CL -> TAMB (Zero Mutual Coupling)`);
  }
  lines.push(`.subckt ${subcktName} Q1 Q2 Q3 Q4 Q5 Q6 TAMB params: T_amb=${tAmbC.toFixed(2)}`);

  const icNodes: string[] = [];

  for (let m = 0; m < 6; m++) {
    const port = `Q${m + 1}`;
    const label = MOS_SWITCH_KEYS[m];
    const jc = armJcs[m];
    const endNode =
      spatial.mode === 'shared_board'
        ? 'TBRD'
        : spatial.mode === 'pcb_spatial_coupled'
        ? `PCB_${label}`
        : `TBRD_${label}`;
    icNodes.push(`V(${port})={T_amb}`);
    lines.push(`* --- MOSFET ${port} (${label}) ZthJC ---`);
    for (let k = 0; k < jc.length; k++) {
      const left = k === 0 ? port : `N${m + 1}_${k}`;
      const right = k === jc.length - 1 ? endNode : `N${m + 1}_${k + 1}`;
      if (k < jc.length - 1) icNodes.push(`V(N${m + 1}_${k + 1})={T_amb}`);
      lines.push(`C_${label}_${k + 1} ${left} 0 ${jc[k].c.toExponential(6)}`);
      lines.push(`R_${label}_${k + 1} ${left} ${right} ${jc[k].r.toExponential(6)}`);
    }
  }

  if (spatial.mode === 'pcb_spatial_coupled') {
    lines.push(`* --- 6-MOS PCB Spatial Zones (C_pcb, R_vert, Symmetric Lateral R_lat) ---`);
    for (let m = 0; m < 6; m++) {
      const label = MOS_SWITCH_KEYS[m];
      const pNode = `PCB_${label}`;
      icNodes.push(`V(${pNode})={T_amb}`);
      lines.push(`C_PCB_${label} ${pNode} 0 ${spatial.cPcb[m].toExponential(6)}`);
      lines.push(`R_VERT_${label} ${pNode} TBRD ${spatial.rVert[m].toExponential(6)}`);
    }
    for (let i = 0; i < 6; i++) {
      for (let j = i + 1; j < 6; j++) {
        const g = spatial.gLat[i][j];
        if (g > 1e-12) {
          lines.push(`R_LAT_${MOS_SWITCH_KEYS[i]}_${MOS_SWITCH_KEYS[j]} PCB_${MOS_SWITCH_KEYS[i]} PCB_${MOS_SWITCH_KEYS[j]} ${(1 / g).toExponential(6)}`);
        }
      }
    }
  }

  if (spatial.mode === 'independent') {
    lines.push(`* --- Independent Per-MOS PCB/Heatsink Chains (6x uncoupled) ---`);
    for (let m = 0; m < 6; m++) {
      const label = MOS_SWITCH_KEYS[m];
      const root = `TBRD_${label}`;
      icNodes.push(`V(${root})={T_amb}`);
      for (let k = 0; k < brd.length; k++) {
        const left = k === 0 ? root : `BRD_${label}_${k}`;
        const right = k === brd.length - 1 ? 'TAMB' : `BRD_${label}_${k + 1}`;
        if (k < brd.length - 1) icNodes.push(`V(BRD_${label}_${k + 1})={T_amb}`);
        const cStage = k === 0 ? spatial.cPcb[m] : brd[k].c / 6;
        lines.push(`C_BRD_${label}_${k + 1} ${left} 0 ${cStage.toExponential(6)}`);
        lines.push(`R_BRD_${label}_${k + 1} ${left} ${right} ${(brd[k].r * 6 + (k === 0 ? spatial.rVert[m] : 0)).toExponential(6)}`);
      }
    }
  } else {
    lines.push(`* --- Shared PCB / Heatsink Thermal Chain Zth_board ---`);
    icNodes.push(`V(TBRD)={T_amb}`);
    for (let k = 0; k < brd.length; k++) {
      const left = k === 0 ? 'TBRD' : `BRD_${k}`;
      const right = k === brd.length - 1 ? 'TAMB' : `BRD_${k + 1}`;
      if (k < brd.length - 1) icNodes.push(`V(BRD_${k + 1})={T_amb}`);
      lines.push(`C_BRD_${k + 1} ${left} 0 ${brd[k].c.toExponential(6)}`);
      lines.push(`R_BRD_${k + 1} ${left} ${right} ${brd[k].r.toExponential(6)}`);
    }
  }

  lines.push(`.ic ${icNodes.join(' ')}`);
  lines.push(`.ends ${subcktName}`);
  lines.push('');
  lines.push(`* --- Example LTspice 6-MOS Harness ---`);
  lines.push(`* X_INV Q1 Q2 Q3 Q4 Q5 Q6 AMB ${subcktName} T_amb=${tAmbC.toFixed(2)}`);
  lines.push(`* V_AMB AMB 0 ${tAmbC.toFixed(2)}`);
  return lines.join('\n');
}

function parseSpiceNumber(raw: string): number {
  const s = raw.trim().toLowerCase();
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(meg|t|g|k|m|u|µ|n|p|f)?/.exec(s);
  if (!m) return Number.NaN;
  const num = Number.parseFloat(m[1]);
  if (!Number.isFinite(num)) return Number.NaN;
  const suf = m[2] || '';
  const mul: Record<string, number> = {
    '': 1,
    f: 1e-15,
    p: 1e-12,
    n: 1e-9,
    u: 1e-6,
    µ: 1e-6,
    m: 1e-3,
    k: 1e3,
    meg: 1e6,
    g: 1e9,
    t: 1e12,
  };
  return num * (mul[suf] ?? 1);
}

function solveLinearSystem(A: Float64Array[], b: Float64Array): Float64Array | null {
  const n = b.length;
  if (n === 0) return null;
  const mat = A.map((row) => Float64Array.from(row));
  const rhs = Float64Array.from(b);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxAbs = Math.abs(mat[col][col]);
    for (let r = col + 1; r < n; r++) {
      const av = Math.abs(mat[r][col]);
      if (av > maxAbs) {
        maxAbs = av;
        pivotRow = r;
      }
    }
    if (!Number.isFinite(maxAbs) || maxAbs < 1e-15) return null;
    if (pivotRow !== col) {
      const tmpR = mat[col];
      mat[col] = mat[pivotRow];
      mat[pivotRow] = tmpR;
      const tmpB = rhs[col];
      rhs[col] = rhs[pivotRow];
      rhs[pivotRow] = tmpB;
    }
    const diag = mat[col][col];
    for (let r = col + 1; r < n; r++) {
      const factor = mat[r][col] / diag;
      if (factor === 0) continue;
      for (let c = col; c < n; c++) {
        mat[r][c] -= factor * mat[col][c];
      }
      rhs[r] -= factor * rhs[col];
    }
  }

  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let sum = rhs[r];
    for (let c = r + 1; c < n; c++) {
      sum -= mat[r][c] * x[c];
    }
    x[r] = sum / mat[r][r];
    if (!Number.isFinite(x[r])) return null;
  }
  return x;
}

export function validateFocSpiceNetlist(
  spiceText: string,
  expectedModel?: FocThermalModel
): FocSpiceValidationResult {
  const rawLines = spiceText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('*'));
  const subcktLine = rawLines.find((l) => l.toLowerCase().startsWith('.subckt'));
  const caps: Array<{ name: string; n1: string; n2: string; val: number }> = [];
  const ress: Array<{ name: string; n1: string; n2: string; val: number }> = [];
  let icText = '';

  for (const l of rawLines) {
    const clean = l.split(';')[0].trim();
    const parts = clean.split(/\s+/);
    const p0 = parts[0]?.toUpperCase() || '';
    if (p0.startsWith('C') && parts.length >= 4) {
      caps.push({
        name: p0,
        n1: parts[1].toUpperCase(),
        n2: parts[2].toUpperCase(),
        val: parseSpiceNumber(parts[3]),
      });
    } else if (p0.startsWith('R') && parts.length >= 4) {
      ress.push({
        name: p0,
        n1: parts[1].toUpperCase(),
        n2: parts[2].toUpperCase(),
        val: parseSpiceNumber(parts[3]),
      });
    } else if (p0 === '.IC') {
      icText += ' ' + clean;
    }
  }

  const topoMode: FocThermalTopologyMode = expectedModel?.thermalTopologyMode ?? (
    ress.some((r) => r.n1.startsWith('PCB_') || r.n2.startsWith('PCB_'))
      ? 'pcb_spatial_coupled'
      : ress.some((r) => r.n1.startsWith('TBRD_'))
      ? 'independent'
      : 'shared_board'
  );

  const errors: string[] = [];
  const has7Ports = Boolean(
    subcktLine && /\bQ1\b\s+\bQ2\b\s+\bQ3\b\s+\bQ4\b\s+\bQ5\b\s+\bQ6\b\s+\bTAMB\b/i.test(subcktLine)
  );
  if (!has7Ports) errors.push('Missing required 7 ports (Q1 Q2 Q3 Q4 Q5 Q6 TAMB) on .subckt line.');

  const allCapsGroundedTo0 = caps.length > 0 && caps.every((c) => c.n2 === '0');
  if (!allCapsGroundedTo0) errors.push('All capacitors must connect to global ground node 0.');

  const noCapOnTamb = caps.every((c) => c.n1 !== 'TAMB' && c.n2 !== 'TAMB');
  if (!noCapOnTamb) errors.push('Capacitor attached directly to TAMB would be shorted.');

  const hasSharedBoardNode =
    topoMode === 'independent'
      ? MOS_SWITCH_KEYS.every((k) => ress.some((r) => r.n2 === `TBRD_${k}` || r.n1 === `TBRD_${k}`))
      : ress.some((r) => r.n2 === 'TBRD') && ress.some((r) => r.n1 === 'TBRD');
  if (!hasSharedBoardNode) errors.push('Required board/PCB coupling nodes missing in netlist.');

  const requiredIc =
    topoMode === 'independent'
      ? ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', ...MOS_SWITCH_KEYS.map((k) => `TBRD_${k}`)]
      : topoMode === 'pcb_spatial_coupled'
      ? ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'TBRD', ...MOS_SWITCH_KEYS.map((k) => `PCB_${k}`)]
      : ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'TBRD'];
  const hasDefensiveIc = requiredIc.every((nd) => new RegExp(`V\\(${nd}\\)\\s*=`, 'i').test(icText));
  if (!hasDefensiveIc) errors.push('Missing .ic on one or more MOSFET/board/PCB nodes.');

  const allValsPositive =
    ress.length > 0 &&
    caps.length > 0 &&
    ress.every((r) => Number.isFinite(r.val) && r.val > 0) &&
    caps.every((c) => Number.isFinite(c.val) && c.val > 0);
  if (!allValsPositive) errors.push('One or more netlist R/C values are non-positive or unparseable.');

  let nodalMathVerified = false;
  let rJcParsed = Number.NaN;
  let rBrdParsed = Number.NaN;
  let dcCommonModeError = Number.NaN;

  if (allValsPositive) {
    const nodeIndex = new Map<string, number>();
    const addNode = (n: string) => {
      if (n === 'TAMB' || n === '0') return;
      if (!nodeIndex.has(n)) nodeIndex.set(n, nodeIndex.size);
    };
    for (const r of ress) {
      addNode(r.n1);
      addNode(r.n2);
    }

    const nNodes = nodeIndex.size;
    if (nNodes > 0 && requiredIc.every((nd) => nodeIndex.has(nd))) {
      const G = Array.from({ length: nNodes }, () => new Float64Array(nNodes));
      for (const r of ress) {
        const g = 1 / r.val;
        const i1 = nodeIndex.get(r.n1);
        const i2 = nodeIndex.get(r.n2);
        if (i1 !== undefined) G[i1][i1] += g;
        if (i2 !== undefined) G[i2][i2] += g;
        if (i1 !== undefined && i2 !== undefined) {
          G[i1][i2] -= g;
          G[i2][i1] -= g;
        }
      }

      const rhsCm = new Float64Array(nNodes);
      for (let m = 1; m <= 6; m++) rhsCm[nodeIndex.get(`Q${m}`)!] = 1.0;
      const solCm = solveLinearSystem(G, rhsCm);

      const rhsOne = new Float64Array(nNodes);
      rhsOne[nodeIndex.get('Q1')!] = 1.0;
      const solOne = solveLinearSystem(G, rhsOne);

      if (solCm && solOne) {
        if (topoMode === 'shared_board') {
          const tBrdCm = solCm[nodeIndex.get('TBRD')!];
          const rBrdCm = tBrdCm / 6;
          const rJcArms = [1, 2, 3, 4, 5, 6].map((m) => solCm[nodeIndex.get(`Q${m}`)!] - tBrdCm);
          const rJcMean = rJcArms.reduce((a, b) => a + b, 0) / 6;
          const tQ1One = solOne[nodeIndex.get('Q1')!];
          const tBrdOne = solOne[nodeIndex.get('TBRD')!];
          const oneArmErr = Math.abs(tQ1One - (rJcArms[0] + rBrdCm)) + Math.abs(tBrdOne - rBrdCm);
          rJcParsed = rJcMean;
          rBrdParsed = rBrdCm;
          let expectedErr = 0;
          let armMismatch = 0;
          if (expectedModel) {
            const armExps = buildPerSwitchJcChains(expectedModel).map((chain) => chain.reduce((s, c) => s + c.r, 0));
            for (let m = 0; m < 6; m++) {
              armMismatch = Math.max(armMismatch, Math.abs(rJcArms[m] - armExps[m]) / Math.max(1e-6, armExps[m]));
            }
            const brdExp = (expectedModel.zthBoard.length > 0 ? expectedModel.zthBoard : DEFAULT_FOC_MODEL.zthBoard).reduce((s, c) => s + c.r, 0);
            expectedErr = armMismatch + Math.abs(rBrdParsed - brdExp) / Math.max(1e-6, brdExp);
          } else {
            armMismatch = Math.max(...rJcArms.map((v) => Math.abs(v - rJcMean)));
          }
          dcCommonModeError = armMismatch + oneArmErr;
          if (armMismatch <= 1e-3 && oneArmErr <= 1e-4 && expectedErr <= 1e-3) {
            nodalMathVerified = true;
          } else {
            errors.push(`Nodal DC matrix verification mismatch (err=${dcCommonModeError.toExponential(2)}).`);
          }
        } else if (topoMode === 'pcb_spatial_coupled') {
          const tBrdCm = solCm[nodeIndex.get('TBRD')!];
          const rBrdCm = tBrdCm / 6;
          const rJcArms = MOS_SWITCH_KEYS.map((k, m) => solCm[nodeIndex.get(`Q${m + 1}`)!] - solCm[nodeIndex.get(`PCB_${k}`)!]);
          const rJcMean = rJcArms.reduce((a, b) => a + b, 0) / 6;
          // Verify lateral coupling: heating Q1 must induce nonzero rise at PCB_BH via lateral/board matrix, and DC reciprocity holds
          const tPcbBhOne = solOne[nodeIndex.get('PCB_BH')!];
          const rhsTwo = new Float64Array(nNodes);
          rhsTwo[nodeIndex.get('Q3')!] = 1.0;
          const solTwo = solveLinearSystem(G, rhsTwo);
          const recipErr = solTwo ? Math.abs(solOne[nodeIndex.get('Q3')!] - solTwo[nodeIndex.get('Q1')!]) : 1;
          rJcParsed = rJcMean;
          rBrdParsed = rBrdCm;
          dcCommonModeError = recipErr;
          if (tPcbBhOne > 0 && recipErr <= 1e-6) {
            nodalMathVerified = true;
          } else {
            errors.push(`Spatial PCB netlist failed passivity/reciprocity check (recipErr=${recipErr.toExponential(2)}).`);
          }
        } else {
          // Independent: heating Q1 must cause zero rise at Q3
          const rJcArms = MOS_SWITCH_KEYS.map((k, m) => solCm[nodeIndex.get(`Q${m + 1}`)!] - solCm[nodeIndex.get(`TBRD_${k}`)!]);
          rJcParsed = rJcArms.reduce((a, b) => a + b, 0) / 6;
          rBrdParsed = solCm[nodeIndex.get('TBRD_AH')!] / 6;
          const crossLeak = Math.abs(solOne[nodeIndex.get('Q3')!]);
          dcCommonModeError = crossLeak;
          if (crossLeak <= 1e-9) {
            nodalMathVerified = true;
          } else {
            errors.push(`Independent netlist has unexpected thermal cross-leakage (${crossLeak.toExponential(2)}).`);
          }
        }
      } else {
        errors.push('Parsed SPICE resistance matrix is singular or disconnected.');
      }
    } else {
      errors.push('Parsed netlist is missing required junction/board/PCB nodes.');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    has7Ports,
    allCapsGroundedTo0,
    noCapOnTamb,
    hasSharedBoardNode,
    hasDefensiveIc,
    nodalMathVerified,
    rJcParsed,
    rBrdParsed,
    dcCommonModeError,
  };
}

/**
 * Exact O(6*Kj + Kb) Implicit Backward-Euler 6-MOS thermal solver supporting:
 * - 'shared_board': 6 ZthJC arms -> shared TBRD -> Zth_board -> TAMB
 * - 'pcb_spatial_coupled': 6 ZthJC arms -> 6 PCB zones (C_pcb, symmetric G_ij, R_vert) -> TBRD -> Zth_board -> TAMB
 * - 'independent': 6 independent ZthJC + Zth_board arms -> TAMB (zero mutual coupling)
 */
export class StarCoupled6MosThermalSolver {
  private topoMode: FocThermalTopologyMode;
  private spatial: ResolvedSpatialNetwork;
  private armJcs: CauerStage[][]; // 6 x kj
  private brd: CauerStage[];
  private kj: number;
  private kb: number;
  private armT: Float64Array[]; // 6 x kj
  private pcbT: Float64Array; // 6 PCB zone temperatures
  private brdT: Float64Array; // kb shared board nodes
  private brdArmsT: Float64Array[]; // 6 x kb independent board nodes
  private tAmbC: number;
  private minTau: number;
  private maxSubDtOverTau: number = 0;

  private jcSubAll: Float64Array[];
  private jcDiagAll: Float64Array[];
  private jcSupAll: Float64Array[];
  private jcCPrimeAll: Float64Array[];
  private jcCkDtAll: Float64Array[];
  private jcDPrimesAll: Float64Array[];
  private jcGammaBoard: Float64Array;
  private jcGLast: Float64Array;
  private jcGArmEff: Float64Array;

  private brdSub: Float64Array;
  private brdDiag: Float64Array;
  private brdSup: Float64Array;
  private brdCPrime: Float64Array;
  private brdDPrime: Float64Array;
  private brdRhs: Float64Array;
  private brdCkDt: Float64Array;

  constructor(
    model: FocThermalModel,
    tAmbC: number,
    initialBoardTempC?: number,
    initialState?: ThermalNetworkStateSnapshot
  ) {
    this.spatial = resolveSpatialThermalNetwork(model);
    this.topoMode = this.spatial.mode;
    this.armJcs = buildPerSwitchJcChains(model);
    this.brd = model.zthBoard.length > 0 ? model.zthBoard : DEFAULT_FOC_MODEL.zthBoard;
    this.kj = this.armJcs[0].length;
    this.kb = this.brd.length;
    this.tAmbC = tAmbC;

    const fallbackBrdT =
      initialState && Number.isFinite(initialState.tBoardC)
        ? initialState.tBoardC
        : initialBoardTempC !== undefined && Number.isFinite(initialBoardTempC)
        ? initialBoardTempC
        : tAmbC;

    this.armT = Array.from({ length: 6 }, (_, m) => {
      const arr = new Float64Array(this.kj);
      const src = initialState?.armT?.[m];
      for (let k = 0; k < this.kj; k++) {
        arr[k] = src && src.length === this.kj && Number.isFinite(src[k]) ? src[k] : fallbackBrdT;
      }
      return arr;
    });
    this.pcbT = new Float64Array(6);
    for (let m = 0; m < 6; m++) {
      this.pcbT[m] =
        initialState?.pcbT && initialState.pcbT.length === 6 && Number.isFinite(initialState.pcbT[m])
          ? initialState.pcbT[m]
          : fallbackBrdT;
    }
    this.brdT = new Float64Array(this.kb);
    for (let k = 0; k < this.kb; k++) {
      this.brdT[k] =
        initialState?.brdT && initialState.brdT.length === this.kb && Number.isFinite(initialState.brdT[k])
          ? initialState.brdT[k]
          : fallbackBrdT;
    }
    this.brdArmsT = Array.from({ length: 6 }, (_, m) => {
      const arr = new Float64Array(this.kb);
      const src = initialState?.brdArmsT?.[m];
      for (let k = 0; k < this.kb; k++) {
        arr[k] = src && src.length === this.kb && Number.isFinite(src[k]) ? src[k] : this.brdT[k];
      }
      return arr;
    });

    let mt = Infinity;
    for (const s of [...this.armJcs.flat(), ...this.brd]) {
      const t = s.r * s.c;
      if (isFinite(t) && t > 1e-12 && t < mt) mt = t;
    }
    if (this.topoMode === 'pcb_spatial_coupled') {
      for (let m = 0; m < 6; m++) {
        let gSum = 1 / this.spatial.rVert[m];
        for (let j = 0; j < 6; j++) gSum += this.spatial.gLat[m][j];
        const tauPcb = this.spatial.cPcb[m] / Math.max(1e-9, gSum);
        if (isFinite(tauPcb) && tauPcb > 1e-12 && tauPcb < mt) mt = tauPcb;
      }
    }
    this.minTau = isFinite(mt) ? mt : 1e-4;

    this.jcSubAll = Array.from({ length: 6 }, () => new Float64Array(this.kj));
    this.jcDiagAll = Array.from({ length: 6 }, () => new Float64Array(this.kj));
    this.jcSupAll = Array.from({ length: 6 }, () => new Float64Array(this.kj));
    this.jcCPrimeAll = Array.from({ length: 6 }, () => new Float64Array(this.kj));
    this.jcCkDtAll = Array.from({ length: 6 }, () => new Float64Array(this.kj));
    this.jcDPrimesAll = Array.from({ length: 6 }, () => new Float64Array(this.kj));
    this.jcGammaBoard = new Float64Array(6);
    this.jcGLast = new Float64Array(6);
    this.jcGArmEff = new Float64Array(6);

    this.brdSub = new Float64Array(this.kb);
    this.brdDiag = new Float64Array(this.kb);
    this.brdSup = new Float64Array(this.kb);
    this.brdCPrime = new Float64Array(this.kb);
    this.brdDPrime = new Float64Array(this.kb);
    this.brdRhs = new Float64Array(this.kb);
    this.brdCkDt = new Float64Array(this.kb);
  }

  public setAmbientTemp(tAmbC: number): void {
    if (!Number.isFinite(tAmbC) || tAmbC <= -273.15 || tAmbC > 1000) {
      throw new Error(`环境温度 ${tAmbC}°C 超出合法物理范围。`);
    }
    this.tAmbC = tAmbC;
  }

  public getJunctionTemps(): number[] {
    return this.armT.map((arm) => arm[0]);
  }

  public getBoardTemp(): number {
    if (this.topoMode === 'pcb_spatial_coupled') {
      let s = 0;
      for (let m = 0; m < 6; m++) s += this.pcbT[m];
      return s / 6;
    }
    if (this.topoMode === 'independent') {
      let s = 0;
      for (let m = 0; m < 6; m++) s += this.brdArmsT[m][0];
      return s / 6;
    }
    return this.brdT[0];
  }

  public getBoardTempsBySwitch(): number[] {
    if (this.topoMode === 'pcb_spatial_coupled') return Array.from(this.pcbT);
    if (this.topoMode === 'independent') return this.brdArmsT.map((a) => a[0]);
    return new Array<number>(6).fill(this.brdT[0]);
  }

  public getMaxSubDtOverTau(): number {
    return this.maxSubDtOverTau;
  }

  public getMinTau(): number {
    return this.minTau;
  }

  public getStateSnapshot(): ThermalNetworkStateSnapshot {
    const tj = this.getJunctionTemps();
    return {
      armT: this.armT.map((arm) => Array.from(arm)),
      pcbT: this.topoMode === 'pcb_spatial_coupled' ? Array.from(this.pcbT) : undefined,
      brdT: Array.from(this.brdT),
      brdArmsT: this.topoMode === 'independent' ? this.brdArmsT.map((a) => Array.from(a)) : undefined,
      tBoardC: this.getBoardTemp(),
      tjMaxC: Math.max(...tj),
    };
  }

  public step(dt: number, powers: number[]): void {
    if (!Number.isFinite(dt) || dt < 0) throw new Error('热网络积分步长 dt 必须为有限非负秒数。');
    if (dt === 0) return;
    if (!Array.isArray(powers) || powers.length !== 6 || powers.some((p) => !Number.isFinite(p) || p < 0)) {
      throw new Error('六管热网络每一步必须提供 6 个有限非负 MOS 损耗功率；拒绝把 NaN/负功率静默替换为 0。');
    }
    const targetSubDt = Math.max(1e-8, 0.05 * this.minTau);
    const subSteps = Math.max(1, Math.min(4096, Math.ceil(dt / targetSubDt)));
    const subDt = dt / subSteps;
    if (this.minTau > 0) {
      const ratio = subDt / this.minTau;
      if (ratio > this.maxSubDtOverTau) this.maxSubDtOverTau = ratio;
    }

    const kj = this.kj;
    const kb = this.kb;

    // Factor each MOSFET JC arm matrix
    let gArms = 0;
    for (let m = 0; m < 6; m++) {
      const jc = this.armJcs[m];
      const sub = this.jcSubAll[m];
      const diag = this.jcDiagAll[m];
      const sup = this.jcSupAll[m];
      const cp = this.jcCPrimeAll[m];
      const ckDt = this.jcCkDtAll[m];

      for (let k = 0; k < kj; k++) {
        ckDt[k] = jc[k].c / subDt;
        const gL = k > 0 ? 1 / jc[k - 1].r : 0;
        const gR = 1 / jc[k].r;
        sub[k] = k > 0 ? -gL : 0;
        diag[k] = ckDt[k] + gL + gR;
        sup[k] = k < kj - 1 ? -gR : 0;
      }
      cp[0] = kj > 1 ? sup[0] / diag[0] : 0;
      let lastDenomJc = diag[0];
      for (let k = 1; k < kj; k++) {
        const denom = diag[k] - sub[k] * cp[k - 1];
        cp[k] = k < kj - 1 ? sup[k] / denom : 0;
        if (k === kj - 1) lastDenomJc = denom;
      }
      const gJcLast = 1 / jc[kj - 1].r;
      const gammaBoard = gJcLast / lastDenomJc;
      this.jcGLast[m] = gJcLast;
      this.jcGammaBoard[m] = gammaBoard;
      this.jcGArmEff[m] = gJcLast * (1 - gammaBoard);
      gArms += this.jcGArmEff[m];
    }

    if (this.topoMode === 'independent') {
      // Solve each of the 6 independent ZthJC + ZthBoard_m arms separately (G_ij = 0)
      const gVert = this.spatial.rVert.map((rv) => 1 / rv);
      for (let m = 0; m < 6; m++) {
        const brdSubM = new Float64Array(kb);
        const brdDiagM = new Float64Array(kb);
        const brdSupM = new Float64Array(kb);
        const brdCpM = new Float64Array(kb);
        const brdDpM = new Float64Array(kb);
        const brdRhsM = new Float64Array(kb);
        const brdCkDtM = new Float64Array(kb);
        for (let k = 0; k < kb; k++) {
          const rk = this.brd[k].r * 6 + (k === 0 ? this.spatial.rVert[m] : 0);
          const ck = k === 0 ? this.spatial.cPcb[m] : this.brd[k].c / 6;
          brdCkDtM[k] = ck / subDt;
          const gL = k > 0 ? 1 / (this.brd[k - 1].r * 6 + (k - 1 === 0 ? this.spatial.rVert[m] : 0)) : 0;
          const gR = 1 / rk;
          brdSubM[k] = k > 0 ? -gL : 0;
          brdDiagM[k] = brdCkDtM[k] + gL + gR + (k === 0 ? this.jcGArmEff[m] : 0);
          brdSupM[k] = k < kb - 1 ? -gR : 0;
        }
        brdCpM[0] = kb > 1 ? brdSupM[0] / brdDiagM[0] : 0;
        for (let k = 1; k < kb; k++) {
          const denom = brdDiagM[k] - brdSubM[k] * brdCpM[k - 1];
          brdCpM[k] = k < kb - 1 ? brdSupM[k] / denom : 0;
        }
        const gLastM = 1 / (this.brd[kb - 1].r * 6 + (kb - 1 === 0 ? this.spatial.rVert[m] : 0));
        const ambRhsM = this.tAmbC * gLastM;
        void gVert;

        const arm = this.armT[m];
        const dp = this.jcDPrimesAll[m];
        const subM = this.jcSubAll[m];
        const diagM = this.jcDiagAll[m];
        const cpM = this.jcCPrimeAll[m];
        const ckDtM = this.jcCkDtAll[m];
        const brdArm = this.brdArmsT[m];

        for (let sub = 0; sub < subSteps; sub++) {
          dp[0] = (ckDtM[0] * arm[0] + (powers[m] || 0)) / diagM[0];
          for (let k = 1; k < kj; k++) {
            const denom = diagM[k] - subM[k] * cpM[k - 1];
            dp[k] = (ckDtM[k] * arm[k] - subM[k] * dp[k - 1]) / denom;
          }
          const pArm = this.jcGLast[m] * dp[kj - 1];
          for (let k = 0; k < kb; k++) {
            brdRhsM[k] = brdCkDtM[k] * brdArm[k] + (k === 0 ? pArm : 0) + (k === kb - 1 ? ambRhsM : 0);
          }
          brdDpM[0] = brdRhsM[0] / brdDiagM[0];
          for (let k = 1; k < kb; k++) {
            const denom = brdDiagM[k] - brdSubM[k] * brdCpM[k - 1];
            brdDpM[k] = (brdRhsM[k] - brdSubM[k] * brdDpM[k - 1]) / denom;
          }
          brdArm[kb - 1] = brdDpM[kb - 1];
          for (let k = kb - 2; k >= 0; k--) {
            brdArm[k] = brdDpM[k] - brdCpM[k] * brdArm[k + 1];
          }
          arm[kj - 1] = dp[kj - 1] + this.jcGammaBoard[m] * brdArm[0];
          for (let k = kj - 2; k >= 0; k--) {
            arm[k] = dp[k] - cpM[k] * arm[k + 1];
          }
        }
      }
      return;
    }

    if (this.topoMode === 'pcb_spatial_coupled') {
      // Backward Schur elimination of board chain T_brd[1..kb-1] into T_brd[0],
      // then exact 6x6 symmetric linear system for PCB zones PCB_0..PCB_5
      const gVert = new Float64Array(6);
      let gVertSum = 0;
      for (let m = 0; m < 6; m++) {
        gVert[m] = 1 / this.spatial.rVert[m];
        gVertSum += gVert[m];
      }
      const brdCkDt = new Float64Array(kb);
      const uBrd = new Float64Array(kb);
      const invDenBrd = new Float64Array(kb);
      for (let k = kb - 1; k >= 0; k--) {
        brdCkDt[k] = this.brd[k].c / subDt;
        const gL = k > 0 ? 1 / this.brd[k - 1].r : 0;
        const gR = 1 / this.brd[k].r;
        const gNextEff = k < kb - 1 ? gR * (1 - uBrd[k + 1]) : gR;
        const diagK = brdCkDt[k] + gL + gNextEff + (k === 0 ? gVertSum : 0);
        invDenBrd[k] = 1 / diagK;
        uBrd[k] = k > 0 ? gL * invDenBrd[k] : 0;
      }

      // Build 6x6 SPD conductance+capacitance matrix M6 for PCB_0..PCB_5
      const M6 = Array.from({ length: 6 }, () => new Float64Array(6));
      for (let i = 0; i < 6; i++) {
        let latRowSum = 0;
        for (let j = 0; j < 6; j++) {
          if (i !== j) latRowSum += this.spatial.gLat[i][j];
        }
        const cOverDt = this.spatial.cPcb[i] / subDt;
        M6[i][i] = cOverDt + gVert[i] + latRowSum + this.jcGArmEff[i] - gVert[i] * gVert[i] * invDenBrd[0];
        for (let j = 0; j < 6; j++) {
          if (i !== j) {
            M6[i][j] = -this.spatial.gLat[i][j] - gVert[i] * gVert[j] * invDenBrd[0];
          }
        }
      }

      const gBrdLast = 1 / this.brd[kb - 1].r;
      const ambTerm = this.tAmbC * gBrdLast;
      const vBrd = new Float64Array(kb);
      const rhs6 = new Float64Array(6);
      const pArmsVec = new Float64Array(6);

      for (let sub = 0; sub < subSteps; sub++) {
        for (let m = 0; m < 6; m++) {
          const arm = this.armT[m];
          const dp = this.jcDPrimesAll[m];
          const subM = this.jcSubAll[m];
          const diagM = this.jcDiagAll[m];
          const cpM = this.jcCPrimeAll[m];
          const ckDtM = this.jcCkDtAll[m];

          dp[0] = (ckDtM[0] * arm[0] + (powers[m] || 0)) / diagM[0];
          for (let k = 1; k < kj; k++) {
            const denom = diagM[k] - subM[k] * cpM[k - 1];
            dp[k] = (ckDtM[k] * arm[k] - subM[k] * dp[k - 1]) / denom;
          }
          pArmsVec[m] = this.jcGLast[m] * dp[kj - 1];
        }

        // Backward sweep for vBrd[kb-1..0]
        for (let k = kb - 1; k >= 0; k--) {
          const gR = 1 / this.brd[k].r;
          const rhsK =
            brdCkDt[k] * this.brdT[k] +
            (k === kb - 1 ? ambTerm : gR * vBrd[k + 1]);
          vBrd[k] = rhsK * invDenBrd[k];
        }
        const offsetBrd0 = vBrd[0];

        for (let i = 0; i < 6; i++) {
          rhs6[i] = (this.spatial.cPcb[i] / subDt) * this.pcbT[i] + pArmsVec[i] + gVert[i] * offsetBrd0;
        }
        const nextPcb = solveLinearSystem(M6, rhs6);
        if (!nextPcb) {
          throw new Error('PCB 空间热耦合矩阵求解奇异，请检查 PCB 热阻/热容设置。');
        }
        let pcbVertFlux = 0;
        for (let m = 0; m < 6; m++) {
          this.pcbT[m] = nextPcb[m];
          pcbVertFlux += gVert[m] * nextPcb[m];
        }
        this.brdT[0] = offsetBrd0 + pcbVertFlux * invDenBrd[0];
        for (let k = 1; k < kb; k++) {
          this.brdT[k] = vBrd[k] + uBrd[k] * this.brdT[k - 1];
        }
        for (let m = 0; m < 6; m++) {
          const arm = this.armT[m];
          const dp = this.jcDPrimesAll[m];
          const cpM = this.jcCPrimeAll[m];
          arm[kj - 1] = dp[kj - 1] + this.jcGammaBoard[m] * this.pcbT[m];
          for (let k = kj - 2; k >= 0; k--) {
            arm[k] = dp[k] - cpM[k] * arm[k + 1];
          }
        }
      }
      return;
    }

    // Default 'shared_board': Factor Zth_board matrix including Schur coupling gArms on node 0 (TBRD)
    for (let k = 0; k < kb; k++) {
      this.brdCkDt[k] = this.brd[k].c / subDt;
      const gL = k > 0 ? 1 / this.brd[k - 1].r : 0;
      const gR = 1 / this.brd[k].r;
      this.brdSub[k] = k > 0 ? -gL : 0;
      this.brdDiag[k] = this.brdCkDt[k] + gL + gR + (k === 0 ? gArms : 0);
      this.brdSup[k] = k < kb - 1 ? -gR : 0;
    }
    this.brdCPrime[0] = kb > 1 ? this.brdSup[0] / this.brdDiag[0] : 0;
    for (let k = 1; k < kb; k++) {
      const denom = this.brdDiag[k] - this.brdSub[k] * this.brdCPrime[k - 1];
      this.brdCPrime[k] = k < kb - 1 ? this.brdSup[k] / denom : 0;
    }

    const gBrdLast = 1 / this.brd[kb - 1].r;
    const ambRhs = this.tAmbC * gBrdLast;

    for (let sub = 0; sub < subSteps; sub++) {
      let pArms = 0;
      for (let m = 0; m < 6; m++) {
        const arm = this.armT[m];
        const dp = this.jcDPrimesAll[m];
        const subM = this.jcSubAll[m];
        const diagM = this.jcDiagAll[m];
        const cpM = this.jcCPrimeAll[m];
        const ckDtM = this.jcCkDtAll[m];

        const r0 = ckDtM[0] * arm[0] + (powers[m] || 0);
        dp[0] = r0 / diagM[0];
        for (let k = 1; k < kj; k++) {
          const rk = ckDtM[k] * arm[k];
          const denom = diagM[k] - subM[k] * cpM[k - 1];
          dp[k] = (rk - subM[k] * dp[k - 1]) / denom;
        }
        pArms += this.jcGLast[m] * dp[kj - 1];
      }

      for (let k = 0; k < kb; k++) {
        this.brdRhs[k] =
          this.brdCkDt[k] * this.brdT[k] +
          (k === 0 ? pArms : 0) +
          (k === kb - 1 ? ambRhs : 0);
      }

      this.brdDPrime[0] = this.brdRhs[0] / this.brdDiag[0];
      for (let k = 1; k < kb; k++) {
        const denom = this.brdDiag[k] - this.brdSub[k] * this.brdCPrime[k - 1];
        this.brdDPrime[k] = (this.brdRhs[k] - this.brdSub[k] * this.brdDPrime[k - 1]) / denom;
      }

      this.brdT[kb - 1] = this.brdDPrime[kb - 1];
      for (let k = kb - 2; k >= 0; k--) {
        this.brdT[k] = this.brdDPrime[k] - this.brdCPrime[k] * this.brdT[k + 1];
      }

      const tBrd0 = this.brdT[0];
      for (let m = 0; m < 6; m++) {
        const arm = this.armT[m];
        const dp = this.jcDPrimesAll[m];
        const cpM = this.jcCPrimeAll[m];
        arm[kj - 1] = dp[kj - 1] + this.jcGammaBoard[m] * tBrd0;
        for (let k = kj - 2; k >= 0; k--) {
          arm[k] = dp[k] - cpM[k] * arm[k + 1];
        }
      }
    }
  }
}

export function computeDominantCauerTauSec(jcStages: CauerStage[], brdStages: CauerStage[]): number {
  const jc = jcStages.length > 0 ? jcStages : DEFAULT_FOC_MODEL.zthJC;
  const brd = brdStages.length > 0 ? brdStages : DEFAULT_FOC_MODEL.zthBoard;
  const rArr: number[] = [];
  const cArr: number[] = [];
  for (const s of jc) {
    rArr.push(Math.max(1e-9, s.r / 6));
    cArr.push(Math.max(1e-12, s.c * 6));
  }
  for (const s of brd) {
    rArr.push(Math.max(1e-9, s.r));
    cArr.push(Math.max(1e-12, s.c));
  }
  const n = rArr.length;
  if (n === 0) return 0;

  let elmoreSum = 0;
  let cumR = 0;
  for (let k = n - 1; k >= 0; k--) {
    cumR += rArr[k];
    elmoreSum += cArr[k] * cumR;
  }

  const G = Array.from({ length: n }, () => new Float64Array(n));
  for (let k = 0; k < n; k++) {
    const gL = k > 0 ? 1 / rArr[k - 1] : 0;
    const gR = 1 / rArr[k];
    G[k][k] = gL + gR;
    if (k > 0) G[k][k - 1] = -gL;
    if (k < n - 1) G[k][k + 1] = -gR;
  }

  let x = new Float64Array(n).fill(1 / Math.sqrt(n));
  let tauDom = elmoreSum;
  for (let it = 0; it < 28; it++) {
    const rhs = new Float64Array(n);
    for (let k = 0; k < n; k++) rhs[k] = cArr[k] * x[k];
    const y = solveLinearSystem(G, rhs);
    if (!y) return elmoreSum;

    let num = 0;
    let den = 0;
    let yNormSq = 0;
    for (let k = 0; k < n; k++) {
      num += x[k] * cArr[k] * y[k];
      den += x[k] * cArr[k] * x[k];
      yNormSq += y[k] * y[k];
    }
    if (den > 1e-18 && Number.isFinite(num)) {
      tauDom = num / den;
    }
    const yNorm = Math.sqrt(yNormSq);
    if (!Number.isFinite(yNorm) || yNorm <= 1e-18) break;
    const nextX = new Float64Array(n);
    for (let k = 0; k < n; k++) nextX[k] = y[k] / yNorm;
    x = nextX;
  }

  return Number.isFinite(tauDom) && tauDom > 0 ? tauDom : elmoreSum;
}

export function solveCoupledThermalSteadyState(params: {
  pCond25W: number[];
  pFixedW: number[];
  alphaPerC: number;
  /** Optional nonlinear per-switch Rds(Tj)/Rds25 factor; when supplied, supersedes alphaPerC. */
  evalCondFactorAtTj?: (tjVec: number[]) => number[];
  rJcTotalByArm: number[];
  rBrdTotal: number;
  tAmbC: number;
  tInitSeedC?: number[];
  spatial?: ResolvedSpatialNetwork;
  evalFixedPowerAtTj?: (tjVec: number[]) => number[] | null;
}): {
  tBoardSteadyC: number;
  tBoardSteadyByKey: number[];
  tjSteadyC: number[];
  converged: boolean;
  thermalRunaway: boolean;
} {
  const { pCond25W, pFixedW, alphaPerC, evalCondFactorAtTj, rJcTotalByArm, rBrdTotal, tAmbC, tInitSeedC, spatial, evalFixedPowerAtTj } = params;
  const kArm = pCond25W.map((p25) => alphaPerC * p25);
  const p0Arm = pCond25W.map((p25, m) => pFixedW[m] + p25 * (1 - 25 * alphaPerC));
  const useNonShared = Boolean(spatial && spatial.mode !== 'shared_board');
  const hasTjSwCoupling = Boolean(evalFixedPowerAtTj);

  if (!useNonShared && !hasTjSwCoupling && !evalCondFactorAtTj) {
    const armStable = kArm.every((km, m) => 1 - rJcTotalByArm[m] * km > 1e-6);
    let gLoop = Infinity;
    let analyticOk = false;
    let analyticBrd = tAmbC;
    const analyticTj = new Array<number>(6).fill(tAmbC);

    if (armStable) {
      let sumKOverDen = 0;
      let sumP0OverDen = 0;
      for (let m = 0; m < 6; m++) {
        const den = 1 - rJcTotalByArm[m] * kArm[m];
        sumKOverDen += kArm[m] / den;
        sumP0OverDen += p0Arm[m] / den;
      }
      gLoop = rBrdTotal * sumKOverDen;
      if (gLoop < 1 - 1e-6) {
        analyticBrd = (tAmbC + rBrdTotal * sumP0OverDen) / (1 - gLoop);
        let allInsidePiecewiseLinear = Number.isFinite(analyticBrd) && analyticBrd <= 2000;
        for (let m = 0; m < 6; m++) {
          const den = 1 - rJcTotalByArm[m] * kArm[m];
          const tm = (analyticBrd + rJcTotalByArm[m] * p0Arm[m]) / den;
          analyticTj[m] = tm;
          if (!Number.isFinite(tm) || tm > 2000 || 1 + alphaPerC * (tm - 25) < 0.1) {
            allInsidePiecewiseLinear = false;
          }
        }
        if (allInsidePiecewiseLinear) {
          analyticOk = true;
        }
      }
    }

    if (analyticOk) {
      return {
        tBoardSteadyC: analyticBrd,
        tBoardSteadyByKey: new Array<number>(6).fill(analyticBrd),
        tjSteadyC: analyticTj,
        converged: true,
        thermalRunaway: false,
      };
    }
  }

  // Build steady-state board/PCB conductance matrix G_steady (7x7 for pcb_spatial_coupled: PCB0..5 + TBRD, or independent diag)
  const gBrdTot = 1 / Math.max(1e-6, rBrdTotal);
  let gSpatialMat: Float64Array[] | null = null;
  if (spatial && spatial.mode === 'pcb_spatial_coupled') {
    gSpatialMat = Array.from({ length: 7 }, () => new Float64Array(7));
    let gVertSum = 0;
    for (let i = 0; i < 6; i++) {
      const gv = 1 / spatial.rVert[i];
      gVertSum += gv;
      let latSum = 0;
      for (let j = 0; j < 6; j++) {
        if (i !== j) {
          const gij = spatial.gLat[i][j];
          latSum += gij;
          gSpatialMat[i][j] = -gij;
        }
      }
      gSpatialMat[i][i] = gv + latSum;
      gSpatialMat[i][6] = -gv;
      gSpatialMat[6][i] = -gv;
    }
    gSpatialMat[6][6] = gVertSum + gBrdTot;
  }

  const tjVec = tInitSeedC ? [...tInitSeedC] : new Array<number>(6).fill(tAmbC + 10);
  let tBrdByKey = new Array<number>(6).fill(tAmbC);
  let tBrd = tAmbC;
  let converged = false;
  let runaway = false;

  for (let it = 0; it < 160; it++) {
    const dynFixed = evalFixedPowerAtTj ? evalFixedPowerAtTj(tjVec) : null;
    const pArm = new Array<number>(6);
    let pSum = 0;
    const condFactors = evalCondFactorAtTj ? evalCondFactorAtTj(tjVec) : null;
    if (condFactors && (condFactors.length !== 6 || condFactors.some((v) => !Number.isFinite(v) || v < 0.05 || v > 10))) {
      throw new Error('Rds(Tj) 曲线反馈必须返回六个 0.05～10 的有限正数系数。');
    }
    for (let m = 0; m < 6; m++) {
      const rFactor = condFactors ? condFactors[m] : Math.max(0.1, 1 + alphaPerC * (tjVec[m] - 25));
      const pF = dynFixed ? dynFixed[m] : pFixedW[m];
      pArm[m] = pF + pCond25W[m] * rFactor;
      pSum += pArm[m];
    }

    let maxDelta = 0;
    if (spatial?.mode === 'pcb_spatial_coupled' && gSpatialMat) {
      const rhs7 = new Float64Array(7);
      for (let m = 0; m < 6; m++) rhs7[m] = pArm[m];
      rhs7[6] = 0; // G * (T - tAmbC) = P
      const dT7 = solveLinearSystem(gSpatialMat, rhs7);
      if (!dT7) {
        runaway = true;
        break;
      }
      let brdSum = 0;
      const nextPcb: number[] = new Array(6);
      for (let m = 0; m < 6; m++) {
        nextPcb[m] = Math.min(2000, Math.max(-273.15, tAmbC + dT7[m]));
        maxDelta = Math.max(maxDelta, Math.abs(nextPcb[m] - tBrdByKey[m]));
        tBrdByKey[m] = nextPcb[m];
        brdSum += nextPcb[m];
      }
      tBrd = brdSum / 6;
    } else if (spatial?.mode === 'independent') {
      let brdSum = 0;
      for (let m = 0; m < 6; m++) {
        const nextBm = Math.min(2000, Math.max(-273.15, tAmbC + pArm[m] * (rBrdTotal * 6 + spatial.rVert[m])));
        maxDelta = Math.max(maxDelta, Math.abs(nextBm - tBrdByKey[m]));
        tBrdByKey[m] = nextBm;
        brdSum += nextBm;
      }
      tBrd = brdSum / 6;
    } else {
      const nextBrd = Math.min(2000, Math.max(-273.15, tAmbC + pSum * rBrdTotal));
      maxDelta = Math.abs(nextBrd - tBrd);
      tBrd = nextBrd;
      tBrdByKey = new Array<number>(6).fill(tBrd);
    }

    for (let m = 0; m < 6; m++) {
      const candT = tBrdByKey[m] + pArm[m] * rJcTotalByArm[m];
      const nextT = Number.isFinite(candT) ? Math.min(2000, Math.max(-273.15, candT)) : 2000;
      maxDelta = Math.max(maxDelta, Math.abs(nextT - tjVec[m]));
      tjVec[m] = nextT;
    }
    if (tBrd >= 1999.9 || tjVec.some((v) => v >= 1999.9)) {
      runaway = true;
    }
    if (maxDelta < 1e-3 && !runaway) {
      converged = true;
      break;
    }
  }

  return {
    tBoardSteadyC: tBrd,
    tBoardSteadyByKey: tBrdByKey,
    tjSteadyC: tjVec,
    converged: converged && !runaway,
    thermalRunaway: runaway,
  };
}

export interface PcbSpatialValidationSummary {
  valid: boolean;
  zoneCount: number;
  cPcbRangeJPerC: [number, number];
  rVertRangeCPerW: [number, number];
  totalParallelRvertCPerW: number;
  couplingLinkCount: number;
  maxMutualConductanceWPerC: number;
  symmetryErrorMaxWPerC: number;
  provenanceLabel: string;
  statusGlyph: '●' | '▲';
  statusText: string;
}

/**
 * Resolves and summarizes physical metrics (C_pcb range, R_vert range, parallel equivalent R_vert,
 * symmetric mutual conductance count and max coupling) of an imported or active 6-MOS PCB spatial model.
 */
export function summarizePcbSpatialNetwork(
  model: FocThermalModel,
  importedDoc?: PcbSpatialImportDocument
): PcbSpatialValidationSummary {
  const effectiveModel: FocThermalModel = importedDoc
    ? {
        ...model,
        thermalTopologyMode: 'pcb_spatial_coupled',
        spatialMatrix: importedDoc.config,
      }
    : model;
  const resolved = resolveSpatialThermalNetwork(effectiveModel);

  let cMin = Infinity;
  let cMax = -Infinity;
  let rMin = Infinity;
  let rMax = -Infinity;
  let gVertSum = 0;
  for (let i = 0; i < 6; i++) {
    const c = resolved.cPcb[i];
    const r = resolved.rVert[i];
    if (c < cMin) cMin = c;
    if (c > cMax) cMax = c;
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
    gVertSum += 1 / Math.max(1e-9, r);
  }

  let couplingLinkCount = 0;
  let maxMutual = 0;
  let symmetryErrMax = 0;
  for (let i = 0; i < 6; i++) {
    for (let j = i + 1; j < 6; j++) {
      const gij = resolved.gLat[i][j];
      const gji = resolved.gLat[j][i];
      const asym = Math.abs(gij - gji);
      if (asym > symmetryErrMax) symmetryErrMax = asym;
      if (gij > 1e-9) {
        couplingLinkCount++;
        if (gij > maxMutual) maxMutual = gij;
      }
    }
  }

  const totalParallelRvertCPerW = gVertSum > 0 ? 1 / gVertSum : Infinity;
  const prov = effectiveModel.spatialMatrix?.provenance;
  const isImportedMeasured =
    !!importedDoc || prov === 'measured' || prov === 'fea_extracted' || prov === 'user_matrix';
  return {
    valid: symmetryErrMax <= 1e-9 && Number.isFinite(totalParallelRvertCPerW),
    zoneCount: 6,
    cPcbRangeJPerC: [cMin, cMax],
    rVertRangeCPerW: [rMin, rMax],
    totalParallelRvertCPerW,
    couplingLinkCount,
    maxMutualConductanceWPerC: maxMutual,
    symmetryErrorMaxWPerC: symmetryErrMax,
    provenanceLabel: resolved.provenanceLabel,
    statusGlyph: isImportedMeasured ? '●' : '▲',
    statusText: isImportedMeasured
      ? '已验证实测/导入六区热矩阵'
      : '当前为几何近似估算（非实板热矩阵）',
  };
}

/**
 * Exports the currently active 6-MOS PCB spatial network as a re-importable wave-test-pcb-thermal v1 JSON document.
 */
export function exportPcbSpatialDocumentFromModel(
  model: FocThermalModel,
  boardName: string = 'WAVE-Test Active 6-MOS PCB'
): PcbSpatialImportDocument {
  const resolved = resolveSpatialThermalNetwork(model);
  const existing = model.spatialMatrix;
  const existingZones = existing?.zones;
  const pitchMm = existing?.layoutPitchMm ?? 14;
  const zones: PcbZoneConfig[] = MOS_SWITCH_KEYS.map((_, i) => ({
    xMm: existingZones?.[i]?.xMm ?? Math.floor(i / 2) * pitchMm,
    yMm: existingZones?.[i]?.yMm ?? (i % 2) * 10,
    areaMm2: existingZones?.[i]?.areaMm2 ?? 120,
    cPcbJPerC: Number(resolved.cPcb[i].toFixed(5)),
    rVertCPerW: Number(resolved.rVert[i].toFixed(5)),
  }));

  const mutualConductanceMatrixWPerC: number[][] = [];
  for (let i = 0; i < 6; i++) {
    const row: number[] = [];
    for (let j = 0; j < 6; j++) {
      row.push(i === j ? 0 : Number(resolved.gLat[i][j].toFixed(6)));
    }
    mutualConductanceMatrixWPerC.push(row);
  }

  return {
    schema: 'wave-test-pcb-thermal',
    schemaVersion: 1,
    boardName,
    units: 'mm',
    config: {
      provenance: existing?.provenance ?? 'user_matrix',
      sourceLabel: resolved.provenanceLabel,
      copperOz: existing?.copperOz ?? 2.0,
      layoutPitchMm: pitchMm,
      zones,
      zoneThermalCapJPerC: zones.map((z) => z.cPcbJPerC!),
      zoneVerticalRthCPerW: zones.map((z) => z.rVertCPerW!),
      mutualConductanceMatrixWPerC,
    },
  };
}

