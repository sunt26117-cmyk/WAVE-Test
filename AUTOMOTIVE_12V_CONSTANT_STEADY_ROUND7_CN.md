# WAVE-Test Round 7：12V 汽车 BLDC FOC 恒定工况收敛

## 应用边界

- 典型母线电压：13.5 V。
- 常用工作范围：9～16 V。
- 六颗 MOS：同一型号，六管共用同一套电气器件参数；不引入六套独立型号/参数输入。
- 六管的相位电流方向、PWM 占空比、硬开关事件归属、平均损耗及结温仍分别计算。
- 只针对恒定 Id/Iq、fe、Fsw、调制方式、PF、死区、Tamb 的平均损耗与稳态热平衡，不扩展动态 FOC 或 PWM 瞬态。

## 本轮修改

### 1. 六颗同型号 MOS 的参数语义

`FocMosParams` 明确为六管共用的器件参数对象。Rds(on)、Esw、Qrr、Eoss、Vref/Iref、Rg 与 DPT LUT 均作为相同器件参数处理。六管差异仅由当前工作点的相电流/占空比以及各个安装位置的热网络产生。热路径非对称参数只代表焊接/铜箔/布局差异，不得解释为不同 MOS 型号参数。

### 2. 汽车 12V 电压基准

- FOC Vbus 默认值由 48 V 调整为 13.5 V。
- 单点 Esw 的 Vref 默认值由 48 V 调整为 13.5 V。
- 12V 汽车供电起算按钮设置 Vbus=13.5 V；不自动生成或覆盖 MOS 实测损耗、器件热阻、DPT 数据。
- DPT 导入路径继续使用真实 DPT 测得的 Vbus 自动刷新 Vref，避免把 13.5 V 误套到其他电压的测试数据上。

### 3. 9 / 13.5 / 16 V 边界评估

新增 `simulateFoc6MosVoltageEnvelope()` 与 UI 按钮。以当前导入工况为参考，在保持 Id/Iq、fe、Fsw、PF、死区及目标基波电压近似不变的条件下，按 Vdc 反比调整调制度。每个电压点独立调用稳态六管损耗和热求解。

结果状态：
- `CALCULATED`：电压能力和器件曲线覆盖均满足，已完成损耗/结温计算。
- `VOLTAGE_LIMITED`：所需调制度超过 SVPWM/DPWM1/SPWM 线性上限，不生成假损耗/假结温。
- `MODEL_OUT_OF_RANGE`：DPT LUT 或非线性 Eoss 曲线等模型数据不覆盖该电压，拒绝该点计算。
- `INVALID_INPUT`：输入值或热模型配置本身不合法，拒绝该点计算并显示具体错误原因。

此边界评估不是完整电机/FOC 重新求解。电压不足时真实系统可能无法维持相同 Id/Iq/转矩，需结合电机反电势、相电阻、电感、速度/转矩工作点和电流限幅继续评估。

### 4. 恒定热求解输入校验

稳态入口增加六位置数组严格校验：
- `perSwitchRjcScale` 必须为 6 个 0.01～100 的有限数值。
- `perSwitchPadOffsetCPerW` 必须为 6 个 0～1e6 的有限数值。
- 任意数组长度错误、NaN、Inf、负数或越界均直接报错，不再由 `buildPerSwitchJcChains()` 静默采用默认值。

### 5. 热稳态结果等级

稳态热失控或未收敛加入 `qualificationReasons` 并将完整损耗模型的结果等级降为 `ASSUMPTION_BASED`；若损耗输入本来就不完整，保留更严格的 `INCOMPLETE_LOSS_MODEL`。避免出现器件参数完整但热解未收敛，结果却仍标记 `DEVICE_PARAMETERIZED` 的情况。

## 验证

- `focThermalSteady.test.ts` + `focSteadyHandoff.test.ts`：20/20 通过。
- 核心模块严格 TypeScript 检查（`focThermal.ts`、`dptAnalyzer.ts`、`models.ts`）：通过。
- `thermalWorkbench.ts` 单独类型检查当前仅被项目依赖缺失 `xlsx` 阻塞，未报告本轮新增代码类型错误。
- 完整 `npm ci` 在当前执行环境超时；因此未宣称完整 Vite build、全项目 lint 或浏览器交互测试通过。
- 本轮未使用真实 MOS 型号、DPT 测试矩阵、PCB 热网络实测值，结果仍取决于工程师输入的器件和 PCB 数据。

## 后续不应再做的事

- 不增加六颗 MOS 各自独立的电气型号参数表，除非将来确实存在并联混料或不同器件。
- 不以相同型号推断六颗 MOS 结温必然相等；热路径、相位电流和工作状态仍可能造成差异。
- 不把 48 V DPT 演示数据直接当作 9～16 V 的实测模型。DPT LUT 必须覆盖目标电压、电流、Tj 和实际 Rg 范围。
- 不把 9 V 电压饱和点继续计算成一个“仍保持相同电流/转矩”的结温结果。
