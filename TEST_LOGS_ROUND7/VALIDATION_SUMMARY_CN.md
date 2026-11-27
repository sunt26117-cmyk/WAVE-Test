# Round 7 验证摘要

## 本轮用户工况边界
- 六颗 MOS 默认同一型号，共用一套电气参数；不建立六套独立 MOS 电气参数。
- 标称母线电压 13.5 V；用户指定常用范围 9～16 V。
- 六个开关位置仍独立计算相位电流/占空比映射后的损耗和结温；热路径差异只用于表达 PCB/焊接/布局差异，不代表不同型号。

## 验证结果
- `focThermalSteady.test.ts` + `focSteadyHandoff.test.ts`：20/20 通过。
- `focThermal.ts`、`dptAnalyzer.ts`、`models.ts` 严格 TypeScript 检查：通过。
- `thermalWorkbench.ts` 严格 TypeScript 检查：通过，使用临时 `xlsx` 类型声明以绕过当前环境未安装该依赖的问题；没有将该类型桩打包进项目。
- `index.html` ID 静态检查：729 个 ID，无重复。
- 扩展回归尝试：68 项中 66 项通过，2 项因运行环境缺失 `xlsx` 依赖而无法导入测试模块（`focDyno.test.ts`、`thermalEngine.test.ts`），不是已确认的断言失败。

## 未完成的验证
- `npm ci` 在当前环境超时，未完成完整依赖安装。
- 因此本轮未宣称完整 Vite build、全项目测试、浏览器人工交互验收通过。
- 未导入用户实际 MOS 型号数据、DPT 测试矩阵和 PCB 实测热网络；结温精度仍取决于这些真实数据。

## 电压边界算法说明
边界评估按 `m(V)=m_ref*V_ref/V` 近似保持参考基波电压，逐点求六管平均损耗和稳态结温；超过对应调制方式线性上限时标记 `VOLTAGE_LIMITED` 且不生成结温。该计算不是电机/FOC 完整重求解，不能代替对低压下反电势、电流、转矩及电流限幅的联合求解。
