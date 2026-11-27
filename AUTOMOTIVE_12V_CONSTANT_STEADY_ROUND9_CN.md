# WAVE-Test Round 9：Rds(on)-Tj 曲线闭环与开关能量口径核对

## 本轮边界

- 六颗 MOS 为同一型号，共用一套器件电气参数；不引入六套器件参数。
- 每个开关位置仍独立计算导通/开关/死区损耗，并保留各自热路径和结温。
- 典型母线 13.5V，运行评估范围 9～16V。
- 只完善固定 Id/Iq、PWM 和母线条件下的平均损耗与稳态结温模型，不扩展动态 FOC。

## 1. Rds(on)-Tj 曲线真正进入电热闭环

位置：`src/modules/focThermal.ts`、`src/modules/thermalWorkbench.ts`、`index.html`。

- 支持导入统一的归一化曲线：`Rds(on)(Tj) / Rds(on)(25°C)`。
- 曲线必须声明 25°C 参考点、参考 Vgs、来源和器件型号，并至少提供三个温度点。
- 温度轴严格递增；归一化曲线必须在 25°C 插值得到约 1.0；明显违反正温度系数趋势的数据会被拒绝。
- 使用线性分段插值；求解温度超出曲线范围时拒绝计算，不进行外推。
- 曲线作为六颗同型号 MOS 的共用器件属性，逐管按各自 Tj 计算 Rds 修正系数，并参与六管热稳态迭代。
- 曲线存在时优先于旧 α 线性模型；没有曲线时保留旧 α 模型兼容路径。

### 新增 Vgs 条件一致性约束

此前曲线虽然记录了数据手册测试 Vgs，但模型没有要求填写实际驱动的 Vgs,on，可能误用不匹配栅压下的 Rds 曲线。现在新增 `Vgs,on` 输入：

- 导入曲线时必须填写实际 MOS 导通期间的名义 Vgs,on。
- 实际值与曲线参考 Vgs 的差异必须不超过 ±0.10V。
- 缺失或不匹配时拒绝计算，不把曲线测试条件冒充实际驱动条件。
- 改动 Rds25、Vgs,on 或曲线 JSON 会清除 Rds25 人工确认勾选，要求重新核对。

界面示例不再预填看似真实的温度比值，模板使用空数据点，避免把示例曲线误当成目标 MOS 数据。

## 2. 明确 Qrr / Eoss 防重复计量

位置：`src/modules/focThermal.ts`、`src/modules/focThermalSteady.test.ts`。

模型仍保留两个明确的能量边界开关：

- `eonIncludesQrr=true`：认为 Esw/DPT Eon+Eoff 已包含反向恢复相关能量，不再额外叠加 `Qrr × Vbus`；否则按 Qrr 输入另计。
- `eossAlreadyIncludedInEsw=true`：认为 Esw 已包含所定义的 Eoss 项，独立 Eoss 标量/曲线不再叠加；否则单独计算。

稳态结果新增计量口径警告，明确当前 Qrr 与 Eoss 是合并处理、单独计入还是未计入。程序不根据数据来源名称擅自猜测 Eon 是否包含 Qrr，或 Esw 是否包含 Eoss。

新增组合回归覆盖 Qrr 包含/不包含与 Eoss 包含/不包含四种状态，核对开关能量只按选定口径计一次。

## 3. 回归与静态检查

- `focThermalSteady.test.ts` + `focSteadyHandoff.test.ts`：28/28 通过（25 项稳态/损耗测试 + 3 项 FOC handoff 集成测试）。
- 核心模块 TypeScript 检查（`focThermal.ts`、`dptAnalyzer.ts`、恒定工况测试）：通过。
- `thermalWorkbench.ts` 使用 TypeScript `transpileModule` 做语法转译检查；该检查不等同于完整项目类型检查。
- 全项目 `npm ci`、Vite 构建和真实浏览器 UI 操作未完成，原因是当前工作环境没有完整依赖安装；不宣称已经完成整包构建验收。

## 4. 尚待目标器件数据验证

本轮没有目标 MOS 的具体型号/数据手册，因此未伪造 Rds(on)-Tj 曲线。导入入口和闭环算法已经实现，但实际使用时仍需提供同型号、实际 Vgs,on 下的温度曲线，并确认 Rds(on)@25°C 与曲线采用同一测试栅压/测试条件。

另外，单点标量 Esw 仍是按参考 V/I 缩放的估算；Qrr 标量仍以 `Qrr × Vbus` 及参考电流比例估算；Eoss 标量仍以 V² 近似缩放。要提高这几项的器件级精度，应使用目标器件在 9V、13.5V、16V 及实际电流、Rg、Tj 条件下的 DPT 数据/LUT 与 Eoss(V)/Qoss(V) 曲线。没有这些数据时，结果必须保持假设估算属性。
