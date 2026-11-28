# WAVE-Test Round 10：Rds25 栅压绑定与热稳态结果有效性

## 本轮边界

- 六颗 MOS 同型号，共用同一套电气参数；不引入六套 MOS 参数。
- 典型 Vbus=13.5V，边界评估 9/13.5/16V。
- 只处理固定 FOC 工况下平均损耗与稳态结温的输入可信度和结果有效性。

## 1. 修正 Rds(on) 绝对值与温度归一化曲线可能跨 Vgs 混用的问题

位置：`src/modules/focThermal.ts`、`src/modules/thermalWorkbench.ts`、`index.html`。

此前只检查了 Rds(on)-Tj 归一化曲线的参考 Vgs 与实际 Vgs,on 是否一致，但 Rds(on)@25°C 的绝对值没有单独记录其测试 Vgs。这样存在一种输入错误：温度归一化曲线来自 Vgs=10V，而 Rds25 绝对值来自 Vgs=4.5V；归一化比值不会修正两个栅压条件下的绝对电阻差异。

本轮新增 `rds25ReferenceVgsV` 和界面输入 `Rds25 测试 Vgs`。曲线模式下必须同时满足：

- Rds(on)-Tj 曲线参考 Vgs 有效；
- 实际 MOS Vgs,on 与曲线参考 Vgs 的差异不超过 ±0.10V；
- Rds(on)@25°C 绝对值对应的测试 Vgs 与曲线参考 Vgs 的差异不超过 ±0.10V。

用户修改 Rds25、实际 Vgs,on、Rds25 测试 Vgs 或曲线 JSON 后，会清除 Rds25 人工确认勾选；新字段也进入输入指纹，避免旧结果复用。

## 2. 电压边界评估增加热稳态结果状态

位置：`src/modules/focThermal.ts`、`src/modules/thermalWorkbench.ts`。

此前电压边界评估只返回 CALCULATED / VOLTAGE_LIMITED / MODEL_OUT_OF_RANGE / INVALID_INPUT。即使热求解内部报告热失控或未收敛，也可能仍显示 CALCULATED，并附带一个中间迭代结温。

新增状态：

- `THERMAL_NOT_CONVERGED`：热稳态迭代未收敛；
- `THERMAL_RUNAWAY`：热反馈检测到热失控。

两种状态保留损耗求解诊断对象，但 UI 不显示其中间迭代值为稳态结温/损耗；表格温度、功耗列显示无效占位，并明确标出热失控或未收敛。直接恒定工况结果区也作相同处理。只有 `steadyConverged=true && thermalRunaway=false` 才显示稳态 Tj、板温和最终稳态损耗。

电压边界仍是保持参考基波电压、Id/Iq、fe、Fsw、PF、死区和热网络不变的敏感性评估，不代替重新求解电机工作点。

## 3. 回归测试

在原稳态 + FOC handoff 测试基础上新增：

1. Rds25 绝对值测试 Vgs 缺失时拒绝曲线计算；
2. Rds25 测试 Vgs 与曲线参考 Vgs 不一致时拒绝；
3. 三项 Vgs 条件一致时允许参与热闭环；
4. 电压边界出现热失控时，不再返回 CALCULATED。

当前专项测试执行结果：`focThermalSteady.test.ts` 27/27 + `focSteadyHandoff.test.ts` 3/3 = 30/30 通过。

核心检查：

- `focThermal.ts` + `dptAnalyzer.ts`：TypeScript noEmit 检查通过；
- `thermalWorkbench.ts`：TypeScript noEmit 检查通过，使用临时 xlsx 声明桩解决当前环境缺少 xlsx 包类型；
- Node 测试通过临时转译运行，xlsx 仅使用测试桩（测试未调用 Excel 导入功能）。

当前环境未安装完整 npm 依赖；`npm ci --offline` 因 esbuild 包未缓存失败。全项目 Vite build、完整 lint 和真实浏览器交互尚未验收。

## 4. 仍待目标器件和硬件数据验证

本轮没有改变或伪造 MOS 电气数据。以下内容仍需具体器件与实测数据：

- Rds(on)@25°C 与 Rds(on)-Tj 曲线应来自同型号、同 Vgs 条件；
- Eon/Eoff 应优先使用目标器件 DPT 数据或多工况 LUT；
- Qrr 与 Eoss 是否已包含在 Eon/Esw 中，需要根据测量积分边界/数据手册定义确认；
- Eoss 优先使用 Eoss(V)/Qoss(V)/Coss(V) 曲线；
- 六管热路径仍需目标 PCB 热阻/热容、热测或 FEA 数据标定。

软件回归通过不等于器件级热设计签核。
