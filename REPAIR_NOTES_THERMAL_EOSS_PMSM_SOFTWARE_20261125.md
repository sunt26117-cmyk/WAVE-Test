# WAVE-Test 软件层补齐记录：PCB 六区热网络 / Eoss / PMSM 动态模型

日期：2026-11-25  
基线：`WAVE-Test-main-fixed-20261125.zip`（对应本轮开始时的最新修复工程）

## 1. 本轮目标

在不依赖真实 PCB、DPT 和电机台架文件的前提下，把三个模块的软件结构、数据接口、数值求解、校验、UI 导入和 JS/Python 对应实现准备好。真实数据由用户后续导入；本轮不制造或冒充实测参数。

## 2. PCB 六管空间热网络

### 已实现

- 版本化 JSON schema：`wave-test-pcb-thermal` v1。
- 支持 AH/AL/BH/BL/CH/CL 六个局部热区域及 PCB 坐标、有效面积。
- 支持多层 stackup：厚度、面内导热率、穿层导热率、密度、比热和覆盖率。
- 可由导入的 stackup/区域面积估算局部 PCB 热容；可按各层穿层导热率计算局部垂直热阻。
- 支持显式热连接 `links`，按各层面内导热率和几何截面计算热导；也支持直接导入 6×6 对称互热导矩阵。
- 明确禁止同时导入 links 和 6×6 矩阵，避免重复计算互热。
- 对矩阵执行 6×6、对角为零、非负、对称检查；对坐标重合、层参数、热容/热阻和 links 几何参数执行输入校验。
- 未提供实际连线时，几何估算仅连接近邻区域，不再生成所有 MOS 两两直接导热的虚假 all-to-all 结构。
- 增加 `focPcbSpatialJsonFileInput` 文件导入与 JSON 模板下载按钮；解析失败会清除旧 JSON、使相关缓存失效，不会继续误用上一次配置。
- 模型来源标记区分 `measured`、`fea_extracted`、`user_matrix`、`datasheet_estimated`、`geometry_estimated`。

### 仍然依赖真实数据的部分

几何估算只是降阶热网络初值。实际板上热场仍需具体铜箔形状、过孔、层叠、器件位置、外壳边界及 FEA/温升测试提取的参数。当前不能声称已得到特定 PCB 的真实热阻抗矩阵。

## 3. Eoss / Qoss / Coss

### 已实现

- 版本化 JSON schema：`wave-test-eoss-curve` v1。
- JSON 和 CSV 文件导入；CSV 可选择曲线类型和电压/数值单位。
- 支持 Eoss(V)、Qoss(V)、Coss(V)；Qoss/Coss 可积分成 Eoss(V)。
- 支持 V/mV，uJ/nJ/mJ，nC/uC，pF/nF 的显式单位换算。
- 对曲线点执行有限值、非负、严格电压递增、Eoss 单调性检查。
- Qoss 必须包含 (0V,0nC) 原点；Coss 必须有 0V 起点，避免软件凭空补造未测低压段积分。
- 单调 PCHIP 插值；正式热损耗路径禁用越界截断/外推，越界时拒绝生成可信结温结果。
- 保留制造商、器件型号、参考温度、Vgs、Rg_on/Rg_off、数据来源等元数据；校验 provenance 和正 Rg。
- UI 增加 JSON/CSV 文件导入、曲线类型/单位选择及 JSON 模板生成。
- 六管损耗计算中保留 Eoss 与 Esw 已包含 Coss 损耗时的防重复计入逻辑。
- 当 Eoss 曲线只有单一参考温度且仿真结温偏离较大时，增加明确提示：当前没有温度维度，未进行无依据温度修正。

### 仍然依赖真实数据的部分

真实 Eoss/Qoss/Coss 曲线、温度条件和 DPT 测量尚未导入。本轮完成数据结构和计算接口，不代表任何具体 MOS 型号的器件损耗已被标定。

## 4. FOC 动态 PMSM

### 已实现

- 非线性磁链 Map JSON schema：`wave-test-pmsm-flux-map` v1。
- 支持 Id/Iq 轴、ψd/ψq 矩阵、器件信息、参考温度、来源和数据说明。
- 对轴严格递增、矩阵维度、有限值、0A 覆盖、参考温度、来源标记进行校验。
- 检查每个网格单元的局部微分电感矩阵正定性及交叉微分互易性。
- Map 插值越界不做边界保持或外推；控制器要求 Map 覆盖 ±Imax，否则拒绝仿真。
- 重要：非线性 Map 已接入动态 RK4 主积分，不是只导入/展示。主方程使用 Map 返回的 ψd/ψq 和局部 2×2 微分电感矩阵；转矩根据磁链计算。
- 非线性 Map 需要与其参考磁体温度匹配；没有温度维度时不允许把线性 ψf 温度系数套到整张 Map 上。
- 增加磁场储能变化率、机械动能变化率、电气功率平衡残差和机械功率平衡残差输出。
- Scope/CSV 导出包含模型来源和功率平衡诊断量。
- Python 动态 PMSM 模块同步非线性磁链 Map 校验、插值、RK4 计算和诊断输出。
- 修正 TS 动态 PMSM 的绕组电阻温度系数默认值为铜绕组 0.00393 /°C，与 Python 和 UI 默认值一致。
- UI 增加 Map JSON 导入、模板下载、错误清理及功率平衡残差展示。

### 仍然依赖真实数据的部分

当前动态模型输出保持 `synthetic_assumed_uncalibrated` 来源标记。没有电机实际 ψd/ψq Map、Rs、Ld/Lq、极对数、惯量、摩擦和台架验证数据时，不应当作已标定电机模型。

## 5. 修改文件

- `index.html`
- `src/components/focDyno/Tab4DynamicPmsm.tsx`
- `src/modules/focDyno/dynamicPmsm.ts`
- `src/modules/focDyno/focDyno.test.ts`
- `src/modules/focDyno/pythonBundle.ts`
- `src/modules/focThermal.ts`
- `src/modules/thermalEngine.test.ts`
- `src/modules/thermalEngine.ts`
- `src/modules/thermalWorkbench.ts`

## 6. 本轮验证

- FOC DynoLab 测试文件：24/24 通过；其中包括 Python 动态 PMSM 执行及非线性磁链 Map 的 TypeScript/Python 数值一致性测试。
- 热模型定向专项：6/6 通过，覆盖四维 DPT 插值、自适应 Cauer 步长、六区 PCB 空间热网络、非线性 Eoss、PCB JSON 模板校验、Eoss CSV/JSON 导入与单位校验。
- Python 导出包：`motor_physics.py`、`dyno_calibrator.py`、`thermal_exporter.py`、`dynamic_pmsm.py`、`app.py` 均通过 `python3 -m py_compile`。
- TypeScript/TSX 语法转译扫描：72 个文件，0 个语法诊断错误。此项不等于完整类型检查。

## 7. 未完成的构建/集成验证

- 当前环境没有完整 npm 依赖，`npm run build` 因 `vite: not found` 失败；完整 `tsc --noEmit` / lint 未完成。
- 完整 `thermalEngine.test.ts` 文件在本环境运行超过 5 分钟未结束；因此只报告本轮定向的 6 项热模型测试通过，不宣称整个 Thermal 测试文件通过。
- 最新源码 UI 已更新，但无法在当前环境重新生成正式独立离线 HTML；压缩包里的 HTML 仍是原有构建产物，不能宣称已与所有最新源码同步。
- 真实 PCB、DPT、Eoss/Qoss/Coss 和电机台架参数尚未导入，也未进行真实硬件精度验证。

## 8. 后续真实数据导入建议

1. PCB：填写六区坐标/面积、完整 stackup、局部 C/R 或导入 6×6 互热导矩阵，来源标记为 FEA/实测后再用于实际板级结温评估。
2. Eoss：按器件型号导入 Eoss(V) 或 Qoss(V)/Coss(V) 曲线，并填写参考温度、Vgs、Rg 等测试条件。
3. PMSM：导入统一 A/Vs 单位、同一参考温度下的 Id/Iq-ψd/ψq Map；另外提供 Rs、机械惯量、摩擦、磁链温度数据及独立台架验证集。
