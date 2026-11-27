# 最终恒定工况专项回归日志

日期：2026-11-27  
测试源：`src/modules/focThermalSteady.test.ts` + `src/modules/focSteadyHandoff.test.ts`  
执行方式：TypeScript `transpileModule` 临时编译为 CommonJS，再由 Node.js test runner 执行（不是完整 npm/tsx 项目构建）。

## 结果

- Tests: 32
- Passed: 32
- Failed: 0
- Skipped: 0

覆盖要点：

- 恒定 Id/Iq 工况交接及 FOC→六管稳态端到端调用；
- 正弦相电流平均导通损耗解析值；
- SVPWM / DPWM1 / SPWM 导通损耗一致性；
- 标量 Eon+Eoff 平均功率换算；
- 正负相电流下死区与体二极管损耗归属；
- 六管相同器件参数与热反馈；
- PWM 窄脉冲、非法输入、过调制和损耗预算边界；
- Rds(on)-Tj 曲线与 Vgs 条件匹配、曲线温度域；
- 9 / 13.5 / 16 V 电压边界与电压能力不足；
- 热失控不返回中间迭代值作为结温/最终损耗；
- Qrr / Eoss 包含关系与防重复计量。

## 静态检查

- `focThermal.ts` 独立 strict TypeScript 检查通过；
- `src` 下 76 个 TS/TSX 文件转译，0 语法诊断；
- `index.html` 检查 734 个 ID，0 重复。

## 未执行

完整项目安装依赖未完成（环境安装超时），因此完整 Vite build、全项目 lint 与浏览器实机交互未验收。
