# Nexperia BUK7Q6R0-40H 器件参数接入与恒定工况模型核查

**工程基线：** WAVE-Test Round 10 恒定工况修订版  
**本次目标：** 将六颗相同的 Nexperia BUK7Q6R0-40H 建立为共用器件配置，不创建六套不同 MOS 参数。  
**系统边界：** 汽车 12V BLDC 三相两电平逆变器；典型 Vbus=13.5V，边界 9V / 16V；六个开关位置仍分别计算损耗与结温。

## 1. 本次接入的器件数据

来源为 Nexperia BUK7Q6R0-40H 官方数据手册（2025-05-07，Rev. 7）及对应官方产品页。

| 参数 | 数据手册数值 | 测试条件 / 模型处理 |
|---|---:|---|
| VDS 额定值 | 40V | 需另核实开关过冲；16V 母线不代表 VDS 峰值一定低于额定值 |
| RDS(on) typ | 5.0mΩ | VGS=10V、ID=20A、Tj=25°C |
| RDS(on) max | 6.0mΩ | 同上；一键预设采用 typ 5.0mΩ，设计上限分析可手动改为 6.0mΩ |
| RDS(on) typ @105°C | 6.8mΩ | VGS=10V、ID=20A |
| RDS(on) typ @125°C | 7.3mΩ | VGS=10V、ID=20A |
| VSD typ / max | 0.8V / 1.2V | IS=20A、VGS=0V、Tj=25°C；稳态死区模型使用 typ 起算值 |
| Qr | 13nC | IS=16A、VDS=20V、dIS/dt=−100A/µs、VGS=0V、Tj=25°C；数据手册脚注明确包含电容性恢复 |
| Coss typ | 386pF | VDS=25V、VGS=0V、f=1MHz、Tj=25°C；数据手册未提供可直接填入的数值 Eoss 表 |
| Rth(j-mb) typ / max | 1.92 / 2.3°C/W | 仅在热网络 JC 端节点确实对应 mounting base 时使用；不是 PCB-to-ambient 热阻 |
| Eon / Eoff | 未提供数值能量表 | 不从 td(on)、tr、td(off)、tf 推算；预设保持空白 |

### RDS(on)-Tj 曲线说明

- 曲线已作为六管共用的温度反馈曲线接入热稳态迭代。
- 25°C=1.00、105°C=1.36、125°C=1.46 为由数据手册表格数值直接归一化得到的锚点。
- 其余温度点来自数据手册 Fig.12 典型曲线数字化近似，已在曲线源说明中标识，不得视作保证的 min/max 温度曲线。
- 一键载入时 RDS25 测试 VGS 与实际 VGS,on 暂以 10V 起算，但“RDS 已确认”复选框保持未勾选。必须用实际 Gate-Source 导通平台电压核对；曲线 VGS、RDS25 测试 VGS、实际 VGS,on 必须在 ±0.10V 内一致。
- 预设采用 5mΩ typical。若做 25°C 电阻上限敏感性分析，可将 RDS25 改成 6mΩ；注意把 typical 曲线比例乘以 max 锚点并不等于数据手册保证的全温度 max 曲线。

## 2. Qr / Qoss / Eoss 计量边界

BUK7Q6R0-40H 的数据手册 Qr 脚注明确计入电容性恢复，不能将该 Qr 当成纯粹的少数载流子反向恢复电荷，再额外叠加一份 Eoss。

本次软件处理：

1. Qr 独立参考电流设为 16A，不再复用 Esw 的 Iref。
2. Qr 测试 VDS=20V、di/dt=−100A/µs、VGS=0V、Tj=25°C 单独记录；Qr 测试 VDS 不会写进 Esw/Eoss 的 Vref。
3. 勾选“Qr 包含 Qoss”后，在当前标量换流能量账本中禁止额外叠加独立 Eoss 标量或曲线，避免明显重复计量。
4. 当前仅使用 `Qr × Vbus` 的一阶能量估算，并按 `|I|/16A` 做线性电流缩放。它没有建立 Qr 对 VDS、Tj、di/dt、VGS 和换流寄生参数的非线性曲线，也没有把 Qs 与 Qoss 的能量分配分别求解。
5. 当 Vbus=13.5V 时，相对 Qr 测试 VDS=20V 的条件差异为 32.5%；9V 时为 55%；16V 时为 20%。软件记录并警告这些差异，不进行未经数据支持的曲线修正。

因此，这个 BUK 预设可作为一阶工程估算输入，但不会被标成完整器件动态参数化模型。

## 3. Eon / Eoff 处理

官方数据手册给出了特定条件下的开关时间参数，但没有提供 Eon/Eoff 数值能量表。开关时间不能直接转换成开关能量，因为能量取决于 VDS、ID、Tj、实际栅极驱动、Rg、换流回路寄生和续流器件行为。

所以本次预设：

- Eon+Eoff 保持空白；
- 不生成虚构能量值；
- 不将器件的 switching time 参数冒充 Eon/Eoff；
- 在没有 DPT LUT 或有效 Eon+Eoff 输入时，结果资格为 `INCOMPLETE_LOSS_MODEL`，并提示开关损耗未计入、已知损耗下的总功耗/结温可能偏低。

软件仍支持原有标量 Esw 输入和多工况 DPT LUT；标量输入仍属于线性缩放近似。对目标器件更准确的升级路径是导入覆盖实际 VDS、I、Tj、Rg_on、Rg_off 工况的 DPT 数据，或者由器件厂商模型/实测结果建立受控 LUT。

## 4. 工作台变化

- FOC / 6-MOS 参数区域增加“应用 BUK7Q6R0-40H 数据手册”按钮。
- 一键加载六管共用的 RDS(on) 温度曲线、RDS25=5mΩ typ、VSD typ、Qr=13nC 及完整 Qr 测试条件。
- Esw、Eoss 保持空白；Qr 包含 Qoss 默认勾选，避免再次增加独立 Eoss。
- 增加 Nexperia 官方该型号 Interactive Datasheet 快捷入口：
  `https://www.nexperia.com/interactive-datasheet?id=BUK7Q6R0-40H`
- 官方页面说明 Interactive Datasheet 基于 Nexperia MOSFET precision electrothermal models。当前快捷入口用于在线器件级交叉核对，不代表该厂商内部模型已经下载、嵌入或由 WAVE-Test 本地调用。
- Rth(j-mb)=2.3°C/W max 仅作为封装结到 mounting base 的边界锚点；不得直接替代实际 PCB 热路径。

## 5. 软件回归与静态验证

| 检查项 | 结果 |
|---|---:|
| FOC 恒定稳态 + BUK profile + FOC handoff 专项测试 | **37 / 37 通过** |
| 全部 `src` TypeScript / TSX 转译 | **78 文件，0 语法诊断** |
| `focThermal.ts` + BUK profile 严格 TypeScript 检查 | **通过** |
| `index.html` ID 检查 | **742 个 ID，0 重复** |
| 官方 Interactive Datasheet 链接 | 已加入工作台并通过静态检查 |

### 环境限制

- `npm run lint` 未通过：当前目录缺少依赖安装，TypeScript 报 `TS2688: Cannot find type definition file for 'vite/client'`。这属于当前构建环境依赖缺失，不能据此宣称完整项目 lint 通过。
- 完整 Vite build 和真实浏览器交互未验收。
- 本次 37 项专项测试通过，不等于实物 DPT、PCB 热网络、热像/热电偶结温或整车工况验证通过。

## 6. 最终工程判断

本次完成的是：**BUK7Q6R0-40H 器件数据手册可确认部分接入软件，并把不能由数据手册支持的 Eon/Eoff、Qr 非线性和 PCB 热路径限制明确表达出来。**

对当前 9–16V 汽车 BLDC 系统：

- RDS(on) 温度反馈已有目标器件典型曲线基础，但实际 VGS 与 max 温度离散性仍须核实。
- Qr 已避免与独立 Eoss 重复计量，但 `Qr×Vbus` 仍是单点条件一阶估算。
- Eon/Eoff 仍缺目标器件能量数据；在补齐之前，六管总损耗和结温不得作为完整、可签核的器件损耗结果。
- 40V 为 MOS 额定 VDS，必须检查开关尖峰和汽车瞬态，不能仅用 9–16V 的直流母线值判定裕量。
- 六颗 MOS 共用器件参数；六个开关位置仍各自计算损耗和热路径。

## 7. 官方来源

1. Nexperia BUK7Q6R0-40H 产品页：`https://www.nexperia.com/product/BUK7Q6R0-40H`
2. Nexperia BUK7Q6R0-40H 官方数据手册（Rev.7，7 May 2025）：`https://assets.nexperia.com/documents/data-sheet/BUK7Q6R0-40H.pdf`
3. Nexperia 官方 Interactive Datasheet：`https://www.nexperia.com/interactive-datasheet?id=BUK7Q6R0-40H`
4. Nexperia AN90034 精密电热 MOSFET 模型说明：`https://assets.nexperia.com/documents/application-note/AN90034.pdf`
