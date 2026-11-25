# WAVE-Test 第四轮后修复记录（2026-11-25）

## 本轮基线

基于用户上传的 `WAVE-Test-main (2).zip` 修改。没有改动已经完成的公共时间序列契约，也没有重复重构 Math/Measure 基础算法。

## 本轮实际修改

### 1. DPT 四维 LUT 有效性和来源保护

涉及：
- `src/modules/dptAnalyzer.ts`
- `src/modules/focThermal.ts`
- `src/modules/thermalWorkbench.ts`
- `index.html`
- `src/modules/thermalEngine.test.ts`

修改内容：
- DPT 查询结果只有 `VALID` 才允许进入六管正式热损耗计算；`INSUFFICIENT_LUT`、`OUT_OF_RANGE`、`INVALID_DATA` 等状态不再继续产生可信热安全结果。
- 四维 LUT 若 Tj/Rg 轴退化为常数轴，不再作为完整四维模型使用。
- Tj 查询来源标记为 `model_estimated`，不再把热模型求得的 Tj 冒充传感器实测。
- 新增 `design_specified` Rg 来源。普通数值输入不再自动视为 `measured`。
- FOC UI 新增 Rg_on/Rg_off 设计核实复选框。未确认时按 `assumed` 处理；Rg 维度有效时禁止正式 DPT 热计算。
- 只有 `VALID` 且必要 Rg 条件已确认的 LUT 才能从 DPT 页面激活为 FOC 正式热模型。
- Rg_on、Rg_off 分别验证有效性；缺少任意一项不能通过伪造 provenance 绕过检查。

### 2. 普通 Cauer/MOS Thermal 瞬态求解失效保护

涉及：
- `src/modules/thermalEngine.ts`
- `src/modules/thermalEngine.test.ts`

修改内容：
- Cauer 输入时间和值数组必须等长且非空；时间戳有限并严格递增；功率必须有限且非负；R/C 必须有限正数。
- 不再通过 `Math.min()` 静默截断时间和值数组。
- 不再把 NaN/Inf/负功率静默替换成零功率。
- `simulateCauerZoh()` 检测到 `STEP_CAP_REACHED` 时抛出错误，不再把部分 Tj 曲线作为正常结果返回。
- `computeLossWithDeskewAndEoss()` 的内部热求解达到步长上限时，返回 `incomplete=true`，Tj 曲线和统计量置为 NaN，并保留诊断信息；调用端不能继续注入有效 Tj 结果。
- 非线性 Eoss 曲线在正式热损耗路径采用严格定义域查询；超出曲线范围拒绝计算，不再使用边界值截断/比例外推签核。

### 3. Runtime Log 滤波有效时间覆盖率

涉及：
- `src/modules/focDyno/motorPhysics.ts`
- `src/modules/focDyno/pythonBundle.ts`
- `src/components/focDyno/Tab2RuntimeEst.tsx`
- `src/modules/focDyno/focDyno.test.ts`

修改内容：
- Runtime Log 在连续片段边缘的移动平均窗口，至少需要 50% 的请求窗口时间支撑；低于该阈值标记 `LOW_COVERAGE`。
- 没有任何时间支撑（窗口小于样本间隔）也标记为 `LOW_COVERAGE`，不再把单点原始样本冒充时间窗口平均值。
- JS 与 Python 使用同一覆盖率阈值、边界处理和状态名称。
- `LOW_COVERAGE` 样本从电流反算和统计中剔除，滤波值写为 NaN；UI 明确显示被排除点数并在曲线上留空。
- 50% 阈值采用小数容差，避免边界浮点误差导致误判。

### 4. FOC 参数 Lq 来源标识

涉及：
- `src/modules/focDyno/dynoCalibrator.ts`
- `src/modules/focDyno/pythonBundle.ts`
- `src/modules/focDyno/focDyno.test.ts`

修改内容：
- Lq 在辨识报告中明确标记为 `FIXED`。
- 说明当前数值由用户输入线间电感按 Y 接假设换算得到，不是 Dyno 数据独立辨识值，也不是实测 Lq。
- TypeScript 和 Python 报告保持一致。

## 本轮验证

以下为本轮实际执行结果：

| 验证项 | 结果 |
|---|---:|
| `timeSeriesModules.test.ts` | 23/23 通过 |
| `thermalEngine.test.ts` 定向 MT-01～MT-04 | 4/4 通过 |
| `focDyno.test.ts` 定向 FD-01～FD-03 | 3/3 通过 |
| Python Runtime Log 低覆盖率实际执行（短片段/充足片段） | 通过 |
| TypeScript/TSX 语法转译扫描 | 71 个文件，0 项语法诊断 |

说明：Python 实际执行验证使用从当前 TypeScript Python bundle 导出的 `motor_physics.py`，覆盖 3 ms/100 ms 低覆盖率片段和 70 ms/100 ms 充足片段。

## 尚未完成 / 不能宣称完成

1. 当前归档环境缺少项目真实 npm 依赖。`tsc --noEmit` 因缺少 `vite/client` 类型而停止；没有完成真实依赖下的完整类型检查、lint 和 Vite 生产构建。
2. 本轮新增 `index.html` 的 Rg 确认控件，但没有依赖环境重新构建 Vite 单文件 HTML；压缩包内原有独立 HTML 仍是旧构建产物，需在正常依赖环境执行 `npm ci`、`npm run build` 后重新生成。
3. Excel/JSZip 的真实读写集成未验证。
4. PCB `pcb_spatial_coupled` 仍需要实际 PCB 几何、铜层/过孔信息或实测 6×6 热耦合矩阵。几何估算矩阵不等于实测热场。
5. Eoss 非线性曲线需要具体器件 Eoss(V)/Qoss(V) 数据；缺曲线时仍只能使用受限近似，不等于真实器件验证。
6. 四维 DPT 必须有完整且可信的 Vbus/Iload/Tj/Rg 工况数据。没有足够实测矩阵时会拒绝正式四维热安全结论。
7. FOC Lq 仍不是独立辨识结果；动态 PMSM 模型仍需真实电机参数和台架数据标定。

## 临时测试环境清理

测试时使用的 `xlsx`/`jszip` 临时导入桩未包含在交付包内；交付 ZIP 不包含 `node_modules`。
