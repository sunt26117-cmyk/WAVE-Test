# WAVE-Test 本轮修复记录（2026-11-25 追加审查）

## 1. 本轮结论

本轮对用户此前提出的波形时间轴、Dynamic SOA、MOS Thermal、FOC DynoLab、Analysis 和模块数据交接问题进行了代码修复与回归。

**代码层面的输入有效性、时间同步、错误放行和数据来源标识问题已补强；但有几项物理模型问题不能仅靠软件代码“彻底修好”，必须依赖具体 MOS 数据手册、DPT 多工况数据、PCB 结构/热测试、TSEP/ZthJC 和电机实测数据。** 对这些部分，本轮采用了拒绝不充分模型、标注适用边界、避免输出伪确定结论的处理方式，不宣称已经建立完整物理模型。

## 2. 手动采样率的真实语义：有 Time 列时按原始行降采样

用户的实际需求不是重建一个新采样时钟，而是在时间阶梯过密时减少导入的数据量。**原始 Time 列 + 手动采样率**表示按目标最小时间间隔从原始记录中抽取已存在的行；被抽掉的时间戳和该行全部通道值一起丢弃，不插值、不补零、不生成新时间戳。

### 修复

- CSV、Excel 统一使用 `src/modules/timeDecimator.ts` 的 `selectTimeDecimationIndices()` 选取原始行索引。
- 时间戳和每个通道数组共用同一组索引，避免时间和值错位。保留的时间戳继续使用源数据时间，不重新等间隔生成。
- 目标采样率对应最小时间间隔 `1/Fs`；保留首样本，并保留真实末样本以代表原始采集区间。末尾间隔可能短于目标间隔，因此实际采样率/非均匀度按导入后真实时间重新计算，不能把目标 Fs 冒充实测 Fs。
- 有 Time 列时，手动 Fs 执行降采样；没有 Time 列时才按 `t = rowIndex / Fs` 重建时间。两种路径明确区分。
- 显式 Time 的降采样不会再被后续 `resampleUniform` 反向插值填满。
- CSV/Excel 预览标明目标 Fs、测得的保留后 Fs 和降采样状态；预览统计受扫描上限影响时增加估算标记，正式导入记录精确丢弃数。

### 回归例

源 CSV：`Time (ms) = 10, 10.5, 11`，对应 `Vds = 12, 13, 14`，手动目标 1000 Sa/s。导入仅保留真实源行 `(10 ms, 12)` 和 `(11 ms, 14)`；`10.5 ms` 与其 `Vds=13` 一起丢弃，不生成 10.5 ms 的插值点。

没有 Time 列时，500 Sa/s 仍按样本序号生成 `0, 0.002, 0.004 s`。

## 3. 此前审查问题逐项处理

| 编号 | 问题 | 本轮处理 | 状态与边界 |
|---|---|---|---|
| 1 | Dynamic SOA 无效数据可能错误 PASS | 校验 SOA 曲线完整性、数组长度、单位、时间轴和有限值；曲线覆盖范围外不再平坦外推；缺失数据返回 INVALID/INDETERMINATE | **代码缺陷已修复** |
| 2 | MOS Vds/Ids 不同步却按数组下标计算 | 按真实时间戳对齐/插值；长度不一致、非单调时间、覆盖缺失和门控区间内 NaN/Inf 不再生成有效能量/结温结果 | **代码缺陷已修复**；无效样本返回 INCOMPLETE，不做补零 |
| 3 | 默认热阻网络与真实器件热模型混淆 | 为 fallback/demo 模型增加来源和不可签核警告；结果说明默认网络不是器件实测 Zth | **风险已限制**；默认模型仍可做演示/初筛，不等于具体器件模型 |
| 4 | 三相采样时间不一致污染 RMS、零序和空间矢量 | 三相分析统一经过公共时间轴验证/重采样；拒绝长度不一致、非单调时间和无效幅值 | **主要分析入口已修复** |
| 5 | SW 相节点被当成 Gate 信号用于死区/直通判断 | 区分 SW node 与 Gate waveform 角色；SW 输入不再输出可靠死区/直通结论 | **已修复** |
| 6 | 电流/功率纹波被误称为机械转矩纹波 | 结果区分 torque/current/power；只有数据来源标记为 measured 的 Torque/Nm 通道才标记为实测机械转矩，否则提示来源待确认 | **误标风险已限制**；用户导入的扭矩传感器数据仍需确认来源元数据 |
| 7 | 温度单位、长度和时间轴不严谨仍进入热反演 | 要求明确 °C/K；拒绝空单位、长度不匹配、NaN/Inf 温度和非严格递增时间轴，不再删除坏点后继续拟合 | **代码缺陷已修复** |
| 8 | Cauer 网络按 τ 或 40/60 经验比例拆成 JC/Board | 删除无 RθJC 锚点时的时间常数/经验比例拆分；单阶 Cauer 不拆；Pad/PCB→Ambient 不冒充 ZthJC；有手册 RθJC 时还需通过拆分前后阶跃响应校验 | **误拆分放行已限制**；即便校验通过仍是受约束等效拆分，不等于独立实测 ZthJC/ZthBoard，签核仍需 TSEP/器件与板级实测 |
| 9 | 六管热模型没有真实 PCB 空间差异 | 保留每管 RθJC 比例和局部 Pad 热阻差异；对“单一共享 Board 节点”的集总网络增加明确警告 | **部分处理**；真实 PCB 铜箔/过孔/布局与 6×6 热耦合矩阵尚未建立，不能宣称得到实际 PCB 热场 |
| 10 | MOS 开关损耗只按参考 Eon/Eoff 标量缩放；Rds 温升可能重复计入 | 对标量 Eon/Eoff、简化 Qrr/Eoss 增加不可作为 worst-case 签核值的警告；DPT Eon 已含 Qrr 时通过 `eonIncludesQrr` 避免重复；Thermal 的 Rds(on)(Tj) 反馈默认关闭，避免对已测 Vds×Ids 再次叠加导通增阻 | **重复计温默认风险已修复；开关损耗模型仍是受限估算**，需 Vbus/Id/Tj/Rg 多工况 DPT LUT 才能完成真实性能模型 |
| 11 | Ke 自动标定假定最高转速点等于满调制 | 改为使用多个开环空载/轻载点的 Ke 候选中位数并检查离散度；明确 `m_norm` 是操作人员输入，不是软件从 Vbus/RPM 推算出的实测调制深度 | **偏差识别和警告已补强**；Ke 仍需要实际相电压基波/调制波形或独立反电势测试确认 |
| 12 | FOC 电机模型过简化、验证集参数泄漏、效率数据被裁剪 | 越界效率隔离为 NaN，不裁剪成 100%；留出验证仅用训练集重拟合 β/Rs，P0 优先来自独立开环数据；UI 明示稳态 SPMSM、Id≈0、固定 Lq 的适用范围 | **验证泄漏和效率清洗问题已修复**；完整 dq 动态、Ld/Lq、MTPA/弱磁和参数置信区间仍未实现 |
| 14 | Runtime Log 时间戳异常后按样本数退回滤波 | 重复/倒退/非有限时间戳、NaN/Inf 电压电流转速和长度不一致直接拒绝；删除样本序号回退；Python bundle 同步 | **代码缺陷已修复** |
| 15 | DynoLab 合成波形被当作真实 FOC 实测波形 | 合成 CSV 写入 `WAVEFORM_PROVENANCE=MODEL_SYNTHETIC_STEADY_STATE` 等元数据；Scope bridge 与热仿真交接保留 `synthetic_steady_state`；文案改为理想基波电流/周期平均 Duty，不再称实测 PWM 波形 | **来源误标已修复**；合成波形仍只适合受限平均模型估算 |
| 16 | Clarke/Park/瞬时功率和 V×I 运算缺少统一时间轴 | 公共对齐工具严格检查长度、时间轴和有限值；V×I 入口不再 `Math.min()` 截断、不再端点保持或把无效功率置零 | **已覆盖的主要入口已修复**；新增计算入口必须继续复用公共同步工具 |
| 17 | 非均匀采样 FFT 与 NaN/Inf 幅值处理不可靠 | FFT 要求长度一致、时间严格递增、幅值有限；合法非均匀采样重采样；不再对 NaN/Inf 插值、边界保持或全零替代后输出频谱 | **代码缺陷已修复** |
| 18 | Hall 固定序列和 Hall offset 适配不足 | 增加可配置六步 Hall 顺序；Hall-only 页面明确提示 offset 只是记录值，因为没有 BEMF/编码器相位参考，不能将其用于真实相位误差校正 | **固定顺序问题已改善**；要让 offset 参与相位校准，仍需接入反电势/编码器参考通道 |

## 4. 本轮补充的关键修复

### FOC 六管热仿真时间覆盖

- Ia/Ib 两个主电流通道的有效区间取真实交集；若采集起止点不一致，只在交集内仿真并给出提示。
- 不再对 Ib 做区间外端点保持。
- Ic、Vbus、Duty 等辅助通道必须完整覆盖最终仿真区间。
- 任何必需通道长度不匹配、时间戳重复/倒退、NaN/Inf 幅值均拒绝热损耗计算。

### MOS 损耗与温升

- Vds/Ids 数组长度和时间轴严格检查。
- 门控区间内无效采样会生成 INCOMPLETE 结果，能量和结温不再伪造为有效数值。
- Rds(on)(Tj) 温度反馈默认关闭；只有确认输入为 25°C 参考态/模型 Vds 时才由工程师主动启用。

### 数据来源贯穿交接

- 合成数据从 DynoLab 导出 CSV 开始就有标记。
- CSV 解析器可识别合成标记。
- 示波器通道 SamplingMetadata 和 Thermal handoff note 保留来源与模型边界。

## 5. 修改文件

本轮修改涉及：

- `src/parsers/csvParser.ts`
- `src/parsers/csvParser.test.ts`（新增）
- `src/parsers/excelParser.ts`
- `src/parsers/excelParser.test.ts`（新增，当前环境未执行，详见第 8.4 节）
- `src/modules/timeDecimator.ts`（新增）
- `src/modules/excelImportModal.ts`
- `src/engine/uiController.ts`
- `src/modules/dynamicSoa.ts`
- `src/modules/timeSync.ts`
- `src/modules/fft.ts`
- `src/modules/thermalEngine.ts`
- `src/modules/focThermal.ts`
- `src/modules/thermalWorkbench.ts`
- `src/modules/bldcAnalysis.ts`
- `src/modules/focDyno/motorPhysics.ts`
- `src/modules/focDyno/pythonBundle.ts`
- `src/modules/focDyno/dynoCalibrator.ts`
- `src/modules/focDyno/thermalExporter.ts`
- `src/modules/focDyno/scopeBridge.ts`
- `src/components/focDyno/Tab1DynoCalib.tsx`
- `src/main.ts`
- `src/types/models.ts`
- `index.html`
- `src/modules/thermalEngine.test.ts`
- `src/modules/focDyno/focDyno.test.ts`

## 6. 回归验证

2026-11-25 在当前可用环境中，通过临时 TypeScript loader 调用 Node test runner，复测：

- `thermalEngine.test.ts`
- `focDyno.test.ts`
- `csvParser.test.ts`

结果：**37 / 37 tests passed**。该执行环境没有安装真实的 `xlsx` / `jszip` 依赖；为使测试模块能够加载，测试运行时使用了仅供导入的临时模块桩。测试未调用 Excel 文件读写或 JSZip 压缩 API，因此这 37 项结果不代表这些第三方库的集成行为已验证。

另外，对本次修改涉及的 24 个 TypeScript/TSX 文件执行 `typescript.transpileModule` 语法诊断，结果 **0 项语法诊断**。这不是完整类型检查，也不能替代真实依赖环境下的 `tsc --noEmit`。

## 7. 尚未完成的验证和不能虚称已完成的部分

1. 当前环境无法完成 `npm ci`（依赖下载网络超时），因此没有完成真实依赖环境下的 `npm run build` / 全项目 `npm run lint`。
2. `waveform-viewer-pro.html`、`public/waveform-viewer-standalone.html` 和 `public/waveform-viewer-offline.json` 是已有构建产物；本轮修改的是源码及 `index.html` UI 源模板，**尚未用 Vite 重新生成单文件离线 HTML**。需要在具备项目依赖的环境运行 `npm ci` 后执行 `npm run build`。
3. 真实 PCB 热耦合矩阵、完整器件 DPT 多变量损耗模型、独立 ZthJC/TSEP 物理边界、完整 PMSM dq 动态模型和 Hall offset 相位校准，都需要实际器件/PCB/电机采集数据和相应模型接口；当前代码已增加限制与警告，但不能说这些完整物理模型已建成。

建议在本机有网络的开发环境执行：

```bash
npm ci
npm run build
```

之后再用更新生成的 `waveform-viewer-pro.html` 或 `public/waveform-viewer-standalone.html` 进行离线操作验证。

## 8. 2026-11-25 追加深挖：MOS Thermal / FOC DynoLab / 手动采样

### 8.1 手动降采样与时间轴

- 增加共用 `src/modules/timeDecimator.ts`。输入含真实 Time 列时，使用贪心最小间隔 `1/Fs` 从源数据选取实际行，所有通道用同一索引表同步抽取；不插值、不补零、不合成新时间点。
- 首行与真实末行保留，以便保留采集区间边界；因此末尾剩余间隔可能小于目标间隔。实际采样率、非均匀度和 gap 以保留后的真实时间戳重新计算，目标 Fs 仅作为抽取间隔，不冒充测量 Fs。
- 没有 Time 列时才按 `t = rowIndex / Fs` 生成时间轴。CSV / Excel 预览展示目标 Fs 与保留后测量 Fs；预览只扫描部分数据时，丢弃数明确标为估算，完整导入后记录准确丢弃数。
- 限制：这是源行抽取，不包含抗混叠低通滤波。降采样后若用于 FFT、高频边沿、窄脉冲或开关损耗，应确认目标频带低于新 Nyquist 频率并有足够采样点；否则应导入更高采样率原始数据，不能把抽取后的波形当作高频原始波形。

### 8.2 MOS Thermal / FOC 六管热模型

- Ia/Ib 不同采集起点时，预热从两者第一个共同覆盖时刻开始，不再从 Ia 首点向前外推 Ib。
- Vbus 波形已选中时，不再因为未使用的恒定 Vbus 输入值为空/无效而提前拒绝；仿真逐点检查实际 Vbus 必须有限且大于 0。
- 每颗 MOS 的 `perSwitchRjcScale` 保留 0.01～100 的合法缩放，不再把 0.05 等小比例静默恢复为 1；输入阶梯、每管缩放和 Pad 热阻数组增加长度/范围校验。
- 时间和值数组不等长、时间轴重复/倒退、NaN/Inf、辅助通道覆盖不足、仿真区间内大采样缺口均 fail-closed，拒绝靠端点保持、跨 NaN 或跨大缺口线性插值补数据。
- 采样缺口检测只覆盖实际热仿真/预热区间及其必要边界样本，不会因为用户选定时间门外的缺口误拒绝干净的门控数据。
- 同时间轴按索引直取，只有时间数组和数值数组长度都与主通道完全一致时才启用，避免数组前缀被静默截断。
- 保留模型边界警告：默认热网络、单一共享 PCB Board 节点、简化 Eon/Eoff/Qrr/Eoss 仍不是具体 MOS+PCB 的实测 Zth / 多工况 DPT，不能作为最坏结温或器件签核结果。

### 8.3 FOC DynoLab / Scope Bridge

- 电压、电流和转速列名中的明确单位转换为 V/A/mechanical RPM；`mV`、`mA`、`krpm`、`rad/s` 有明确比例。显式 `Hz` 不会被误当成机械 RPM；未知显式单位拒绝生成标定点。
- 功率列的 W/kW/mW/MW 显式单位进行换算；例如 `P_in (hp)`、`P_in (rpm)` 不再默认当 W，而是阻止生成该批标定点并给出非标准功率单位原因。
- Scope Bridge 检查原始时间轴严格递增、数组长度一致、Vbus/Speed 完整覆盖 Ibus；不同采样率通道只在共同覆盖区间内按真实时间插值，不做端点外推。电频率换算需要正整数极对数，`maxPoints` 必须为不小于 2 的整数。
- 留出验证误差只按真正完成物理解算的点计算，并显示有效点数；没有有效验证点时显示 N/A / NaN，不以 0 MAE 暗示验证成功。
- 保留效率越界隔离、模型输入边界、仿真波形 `synthetic_steady_state` 来源标记以及“理想正弦电流/周期平均 Duty 不是实测 PWM”说明。

### 8.4 本次验证边界

- 37/37 项可执行回归通过；24 个变更 TS/TSX 文件语法诊断 0 项。
- 新增 `src/parsers/excelParser.test.ts` 覆盖真实 Excel Time 列降采样及无 Time 列时的索引时间轴；由于当前归档环境缺少真实 `xlsx` 包，该测试未执行。
- 当前未完成真实依赖安装、完整 `tsc --noEmit`、Vite 构建和离线单文件 HTML 重生成。`waveform-viewer-pro.html` / `public/waveform-viewer-standalone.html` 仍是原有构建产物，源码修改不会自动反映到这些静态文件中。

