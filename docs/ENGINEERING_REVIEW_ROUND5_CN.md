# WAVE-Test 工程审查与修复记录（Round 5）

日期：2026-11-27  
基础工程：用户上传的 `WAVE-Test-main-software-models-20261125.zip`  
本轮目标：FOC DynoLab、MOS Thermal、Compare、多 Excel 多通道合并导入。

> 本轮以源码中的实际调用路径为准。此前的 `IMPLEMENTATION_NOTES_20261127_CN.md` 记录的是上一轮状态，不能替代本报告；两者存在不一致时，以本报告与当前源码为准。

## 1. 本轮重新确认的高风险问题

### 1.1 MOS Thermal：未确认的 Rds 参数仍进入定量模型

FOC 6-MOS 面板有 `Rds25 已确认` 复选框，但此前 `readFocParams()` 只是读取 Rds 数值，复选框只用于警告，未进入模拟器参数契约。界面默认的 4.5 mΩ 和 0.45 %/°C 仍进入六管导通损耗和结温计算，用户容易把一个未确认起算值当成器件数据。

**处理：**
- 将 `rdsDataConfirmed` 作为 `FocMosParams` 的显式来源状态传入模型。
- `simulateFoc6Mos()` 生成 `resultQualification` 和 `qualificationReasons`，区分：
  - `INCOMPLETE_LOSS_MODEL`：Eon/Eoff、Qrr、Eoss 等必要损耗数据缺项，对应损耗按 0 处理，结果是已建模损耗下的偏低估算。
  - `ASSUMPTION_BASED`：损耗项虽有输入，但仍使用未确认 Rds、单点 Esw 缩放或未通过器件约束验证的热网络。
  - `DEVICE_PARAMETERIZED`：Rds 已确认、DPT LUT 可用、热网络通过数据手册约束及拆分一致性验证，且没有上述缺项。
- Tj、Tboard、P_inv、六管分项结果在非参数化状态下均标记 `*`；Scope 注入的 Tj/P_inv 通道名与 Badge 也加 `*`。
- 勾选确认并不代表模型完成验证或取得安全签核资格；只表示参数来源已由使用者确认。

### 1.2 FOC 堵转：原始热计算“低于限值”不应直接等价于 SAFE

此前堵转热扫描的 `steadySafe` 主要由结温限值和电压可实现性决定。若开关损耗或热网络输入不完整，即使数值温度低于限值，也可能得到过于乐观的安全状态。

**处理：**
- 堵转扫描保留 `thermalSafeAtRequestedCurrent` 作为“强制电流假设下的纯热计算结果”，供诊断使用。
- 新增同一套 `resultQualification` / `qualificationReasons`。
- `steadySafe` 增加证据门槛：只有 `DEVICE_PARAMETERIZED`、热稳态收敛、未热失控且电压可实现时才可能为 true。
- 不满足证据等级时，堵转 UI 将 `t_safe/I²t` 明确标为“仅估算”，并禁止显示 SAFE。
- FOC 策略扫频现在汇总 SVPWM、DPWM1、SPWM 三种策略各自的模型告警；此前只汇总 SVPWM 的对齐告警会遗漏另两种策略的风险提示。

### 1.3 Compare：目标采样网格可能漏掉更快参考记录里的窄脉冲

原流程主要在目标波形的采样时间点上评估参考波形。目标采样率较低时，短脉冲可能完全落在两个目标采样点之间，导致最大偏差、RMSE 与 Golden 容差判定漏检。

**处理：**
- 增加目标与参考时间节点并集网格，保留两份记录的全部分段线性拐点。
- 在共同有效时间区间上按分段线性信号进行时间积分；RMSE、MAE、相关性按持续时间加权，而不是让高采样密度区间获得额外权重。
- 最大绝对误差会检查并集节点，因此能够识别只出现在更快参考通道节点上的脉冲。
- 有效覆盖率按共同有效时间长度 / 目标记录总时长计算；NaN、采样断档和孤立点不构成有效覆盖。
- 新增联合网格 250 万节点上限。超过上限时阻止 Compare/Golden 定量判定并要求缩小分析窗口，不再以目标网格回退结果冒险给出 PASS。
- 修正“无重叠但样本数很大”可能被误报为“联合网格超限”的状态分类。
- Compare 控件继续保留 Δt 秒级直输、t0、XCorr、时间比例预设和最低覆盖率；t0/XCorr 的提示明确说明它们不证明两次采集真实同步。

### 1.4 多 Excel：通道样本数不同不能被当成共同时间轴索引

原视图的 X 轴以第一通道为基础，但合并通道的初始视窗曾使用所有通道的最大样本数作为结束索引。不同采样率或记录长度组合时，可能错误裁剪视窗。不同时间坐标域也不能仅凭“数值接近”被认作同一时间基准。

**处理：**
- 多文件/多工作表的数据映射成同一 Scope 标签页中的独立通道，每条通道保留各自 `t` 与 `rawT`，不强制重采样。
- 默认保留源时间；可选择首样本对齐 t=0。首样本对齐仅平移时间坐标，不修改 V/A 采样值。
- 时间窗按合并通道的真实时间跨度计算，不按最大样本数计算。
- Excel 绝对日期时间会恢复 Excel 日期系统对应的绝对时间；兼容 1900/1904 日期系统。
- 只有 HH:MM:SS 而没有日期的时间列会保留日内秒坐标并提示缺少日期；不能据此证明不同文件发生在同一天。
- 多个合成时间轴、绝对日期轴、相对数值轴等无法建立共同坐标含义的组合，在“保留源时间”模式下会被阻止，而不是仅显示警告后继续绘图。

## 2. FOC DynoLab 与物理模型边界

- 正向/反向求解的二次根式改为数值稳定形式，改善低功率、接近零负载时的消减误差。
- TypeScript 与内嵌 Python 对逆变效率的物理约束统一为 `0 < η_inv ≤ 1`；η=1 表示关闭效率修正，不再被 Python 单侧截断到 0.999。
- `t_dead > 0` 时 PWM 频率必须是有效正数；`t_dead = 0` 时允许 `f_sw = 0`，避免无死区的理论计算被不必要限制。
- DynoLab 的 KV 手动空载校准输入提示明确为 `Vdc × m_norm` 等效电压；不同厂商的 KV 定义不能在没有电压定义核对的情况下直接混用。
- 标明 `Lq ≈ L_LL/2` 是简化换算，不等于 IPMSM 的独立 Ld/Lq、磁饱和或交叉饱和模型。
- 铜电阻温度系数 0.00393/°C 只作为铜绕组近似；绕组温度不能直接用外壳温度代替。

## 3. MOS Thermal 模型边界与 DPT

- DPT 的 Rg_on 与 Rg_off 保持为独立物理维度；固定的 Rg_on 与固定的 Rg_off 数值不同，不能被误认成同一个变化维度。
- DPT 测试工况中的 Tj、Rg_on、Rg_off 必须显式填写并确认；不再静默填入 25°C 和 4.7Ω。
- 环境温度不能被当作 MOS 结温来查 DPT LUT；LUT 覆盖预检查和运行时逐颗 MOS 结温查询分别处理。
- Rds(Tj) 采用线性 α 模型时，必须清楚标注其近似属性；优先使用目标器件 Rds(on)-Tj 数据。
- 1.22 °C/W 三阶 Cauer 网络是软件回退网络，不是通用 MOS 热阻。结果标为 Tj* 回退估算；不能作为目标器件/PCB 真实结温或 SOA 签核依据。

## 4. 本轮新增/更新的关键文件

- `src/modules/focThermal.ts`：FOC 6-MOS 模型证据等级、损耗完整性、堵转 SAFE 门槛。
- `src/modules/thermalWorkbench.ts`：Rds 确认来源传递、Tj*/P_inv* 展示、Scope 导出标记、堵转 SAFE 提示、三种调制策略告警汇总。
- `src/modules/waveformCompare.ts`：联合时间网格、快速脉冲检测、时间积分指标、超大网格 fail-closed。
- `src/modules/anomalyScanner.ts`：Golden 容差使用联合网格和时间覆盖率门槛。
- `src/modules/temporalCompare.ts`：按实际有效时间长度统计覆盖率。
- `src/modules/excelTimeAlignment.ts` / `src/modules/excelTimeAlignment.test.ts`：多文件时间坐标语义、首样本对齐、时间范围视窗。
- `src/modules/excelImportModal.ts`、`src/parsers/excelParser.ts`、`src/engine/uiController.ts`：Excel 导入链路与 Scope 合并桥接。
- `src/modules/focDyno/motorPhysics.ts`、`src/modules/focDyno/pythonBundle.ts`：FOC 求解数值稳定性与 Python/TS 约束一致性。
- `src/modules/thermalEngine.test.ts`、`src/modules/timeSeriesModules.test.ts`、`src/modules/focDyno/focDyno.test.ts`：补充边界回归。
- `index.html`：参数提示和热模型回退来源提示。

## 5. 实际执行的测试

### 通过

| 测试范围 | 结果 | 说明 |
|---|---:|---|
| FOC DynoLab + Compare/Math/Measure/Analyze + Excel 时间轴/多表合并 | 61/61 | 完整执行，0 fail |
| MOS 热专项定向测试 | 5/5 | FOC 六管耦合；DPT 4D；Rg_on/Rg_off 独立轴；自适应 Cauer；非线性 Eoss |
| FOC 六管与堵转综合回归 | 1/1 | 覆盖损耗完整性等级、估算/参数化状态、SAFE 约束及已有热计算路径 |
| TS/TSX 语法扫描 | 74 个文件，0 错误 | 使用 TypeScript transpile diagnostics 做语法级扫描 |

### 未完成，不能视为通过

- 完整 `thermalEngine.test.ts` 全文件本轮尝试出现超时；只报告上表列出的 5 个 MOS 专项测试和 1 个 FOC 综合测试通过。
- 当前工作目录没有 `node_modules`，未执行 `npm run lint`、完整 `tsc --noEmit`、`npm run build`。
- 未进行真实浏览器中的交互回归；多 Excel 路径通过模块级合成测试，但尚未用用户实际 Excel 文件验证表头/日期格式兼容性。
- 未使用真实电机台架、目标 MOS DPT、器件 ZthJC(t)、真实 PCB 热网络或实测温度数据。模型的硬件精度尚不能据软件测试宣称已经验证。

## 6. 使用前必须知道的限制

1. Rds25 默认示例值 4.5 mΩ 和 α=0.45 %/°C 仍可用于趋势起算；没有勾选目标器件确认时结果会标为假设/不完整估算。它们不是通用推荐值。
2. 没有 Eon/Eoff、Qrr、Eoss 数据时，缺失损耗会按 0 处理，但结果会被标记为 `INCOMPLETE_LOSS_MODEL`，不得用于热设计签核。
3. `DEVICE_PARAMETERIZED` 只表示输入来源/模型参数达到软件定义的参数化门槛，不代表已经完成硬件验证、功能安全评估或客户认可。
4. 250 万节点以上的 Compare 联合时间网格会拒绝定量比较；请先缩小分析窗口，再复算。
5. 多 Excel 保留源时间时仍需确认这些文件的时钟/触发来源。时间坐标相同不等于真实同步。
6. `waveform-viewer-pro.html`、`public/waveform-viewer-standalone.html` 与 `public/waveform-viewer-offline.json` 是旧构建产物，本轮没有重新生成。请先在本地安装依赖，再执行 `npm run build`，使用新生成的 `waveform-viewer-pro.html`。

## 7. 本地构建

```bash
npm ci
npm run lint
npm run build
```

若完整类型检查或构建报错，请保存终端日志；本轮 74 个 TS/TSX 文件语法扫描不等同于完整项目类型检查或 Vite 构建。
