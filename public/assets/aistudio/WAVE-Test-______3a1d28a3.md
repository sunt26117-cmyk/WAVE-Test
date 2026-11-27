# WAVE-Test 审核与优化交接书

> 给接手评审的 AI：**请先读完本文档再动手**。里面列的"已验证事实"是实测得到的，不是猜测；"已知陷阱"能省你几小时。

---

## 0. 一句话

纯浏览器端（零后端）的**网页示波器 + 波形分析 + 功率器件电热分析**工具，Vite + TypeScript，构建产物是**单个离线 HTML 文件**（双击即用、可发给同事、无任何运行时依赖）。

- 仓库：`https://github.com/sunt26117-cmyk/WAVE-Test`（分支 `main`）
- 规模：`src/` **78 个 TS/TSX 文件，64,947 行，2.7 MB**；39 个算法模块
- 产物：`waveform-viewer-pro.html` **2,376,060 字节**（minified bundle 1.9 MB）

---

## 1. 环境搭建（有两个坑，照抄即可）

```bash
git clone https://github.com/sunt26117-cmyk/WAVE-Test.git
cd WAVE-Test
npm install --registry=https://mirrors.cloud.tencent.com/npm --legacy-peer-deps
```

**坑 1**：`npm install` 必须加 `--legacy-peer-deps`。vite 8 生态的 peer 依赖在 npm 严格模式下冲突（上游用 bun 安装，仓库里有 `bun.lock`，所以作者没遇到过）。

**坑 2**：部分地区 `registry.npmjs.org` 不通（超时）。可用镜像：
- npm：`https://mirrors.cloud.tencent.com/npm`（推荐）或 `https://registry.npmmirror.com`
- PyPI（若需跑 Python 侧）：`https://pypi.tuna.tsinghua.edu.cn/simple`（腾讯的 PyPI 路径返回非法 Content-Type，pip 会跳过）

---

## 2. 基线状态（已实测，请以此为准）

```bash
npm run lint    # tsc --noEmit  ->  0 error
npm run build   # vite build + 内联  ->  waveform-viewer-pro.html 2,376,060 字节
```

| 检查 | 结果 |
|---|---|
| `npm run lint` | ✅ **0 错误** |
| `npm run build` | ✅ 成功；连跑 3 次字节稳定（已收敛） |
| `npm run test:foc-steady` | ✅ 35 tests / 35 pass |
| 10 个测试文件逐个跑 | ⚠️ **8 个全过（141 tests），2 个有失败（6 条）** |

### ⚠️ 最重要的问题：8 成的测试从来没被执行过

`package.json` 里只接了一个测试脚本：

```json
"test:foc-steady": "tsx --test src/modules/focThermalSteady.test.ts src/modules/focSteadyHandoff.test.ts"
```

而仓库里有 **10 个 `*.test.ts`，共约 6,000 行测试代码**。剩下 8 个没有任何 npm script 入口。**这是本次评审性价比最高的切入点。**

| 测试文件 | 行数 | 单独运行结果 |
|---|---|---|
| `focThermalSteady.test.ts` | 783 | ✅ 32 pass |
| `thermalEngine.test.ts` | 2,174 | ❌ **35 pass / 2 fail** |
| `focDyno/focDyno.test.ts` | 1,460 | ❌ **21 pass / 4 fail** |
| `timeSeriesModules.test.ts` | 878 | ✅ 28 pass |
| `filter.test.ts` | 300 | ✅ 7 pass |
| `excelTimeAlignment.test.ts` | 146 | ✅ 8 pass |
| `csvParser.test.ts` | 62 | ✅ 3 pass |
| `excelParser.test.ts` | 83 | ✅ 2 pass |
| `focSteadyHandoff.test.ts` | 162 | ✅ 3 pass |
| `focMosDeviceProfiles.test.ts` | 27 | ✅ 2 pass |

---

## 3. 已知的 6 条失败（附根因，别重复排查）

### 3.1 `thermalEngine.test.ts` —— 2 条，**真实的语义冲突**

```
✖ Dynamic SOA and BLDC FOC scale mA currents identically to A currents and guard stall divergence
✖ FOC 6-MOS: strict alignment, non-uniform time-weighted mean, gate preheat, overmod, Cauer split, SPICE nodal parity & dual I2t

Error: PWM 指令脉冲宽度不足：duty=0.998097，单边死区占空比=0.004000。
当前平均损耗模型无法判断 MCU/驱动器的窄脉冲删除与死区补偿行为，拒绝输出单管损耗/结温；
请确认实际 PWM 最小脉宽或导入实测 duty/gate 波形。
```

**根因**：最新一批提交加入了"窄脉冲保护"——当 `duty` 高到使某一侧导通脉宽小于死区时，拒绝出结果。这两个用例用的是 `duty≈0.998`，正好触发。

**这里需要你判断（不是简单改测试）**：
- 若保护逻辑正确 → 测试用例的工况本身已不物理，应改用例
- 若保护过严 → `duty=0.998` 时高边导通 `0.998-0.004=0.994`，低边只剩 `0.002`，2 µs@20 kHz 确实窄，但真实驱动器的窄脉冲删除行为需要确认
- **不要**为了让测试变绿就放宽保护——那是把一个真实的安全门限删掉

### 3.2 `focDyno/focDyno.test.ts` —— 4 条，**环境依赖，不是逻辑 bug**

```
AssertionError: python3 execution failed:  actual: 9009,  expected: 0
```

`9009` 是 Windows 的 `ERROR_FILE_NOT_FOUND`。这些用例**直接 spawn `python3`** 来和 TS 实现做数值对齐。本机只有 `python`，没有 `python3`。

**修法**：探测可用的解释器（`python3` / `python` / `sys.executable`），找不到时 **skip 而不是 fail**。这样在 CI 上也稳。

---

## 4. 已知陷阱（都是实测踩出来的）

### 4.1 构建产物不是严格字节可复现

**Tailwind v4 会扫描 `public/` 下已存在的单文件产物。** 如果目录里残留旧的 `waveform-viewer-pro.html` / `waveform-viewer-standalone.html`，首次构建会把旧文件里出现过的类名重新生成一遍。

实测：同一份源码，首次构建 2,372,818 → 第二次 2,376,060 → 之后稳定。多出来的是一条源码里根本不存在的 `.bg-red-500`。

**建议改进**：`scripts/generate-single-html.js` 里排除这些产物，或构建前清理 `public/`。

### 4.2 Python 导出包是"内嵌字符串"，改外面的 .py 文件无效

`src/modules/focDyno/pythonBundle.ts`（94 KB）用模板字符串内嵌了一整套 Python 包：

```
REQUIREMENTS_TXT / MOTOR_PHYSICS_PY / DYNO_CALIBRATOR_PY / THERMAL_EXPORTER_PY / APP_PY
```

网页端"下载 Python 包"时是把这些字符串打成 zip。**所以改磁盘上的 `.py` 完全不生效，必须改 `pythonBundle.ts`。**

这也意味着：**同一套物理模型在 TS 和 Python 里有两份实现**，天然存在漂移风险。`focDyno.test.ts` 里那些 python3 对齐用例就是为了防这个——但它们现在跑不起来（见 3.2）。

### 4.3 内嵌 Python 有 4 个已知未修项

（来自对导出包的实跑验证，可复现：抽出字符串 → `pip install -r requirements.txt` → `streamlit.testing.v1.AppTest`）

| 问题 | 位置 | 严重性 |
|---|---|---|
| `use_container_width` 已被 Streamlit 弃用，官方移除日期 **2025-12-31**（已过期） | `app.py` 共 4 处 `st.plotly_chart` | 高：升级 Streamlit 后 4 张图全废 |
| `exp_v` widget 同时传 `value=` 和 `key="exp_v"`，`value=` 被忽略并告警 | `app.py:458` | 低 |
| 运行日志推算产生 NaN 行（1200 行里有 1 行，对应 regen_limit） | `motor_physics.py` `process_runtime_log` | 中：图表断点 |
| 效率热力图 **16.1% 为 NaN**（`griddata(method="linear")` 凸包外） | `dyno_calibrator.py:712-716` | 中 |

### 4.4 一处 TS 类型系统的"假错误"（已加注释，别改回去）

```ts
if ((thermalSolverStatus as 'CONVERGED' | 'STEP_CAP_REACHED') === 'STEP_CAP_REACHED') {
```

`thermalSolverStatus` 只在闭包 `advanceCauerNodeT` 内被重新赋值，TS 流分析不跟踪闭包，会把变量错误收窄成初始字面量 `'CONVERGED'`。已验证 `advanceCauerAdaptive` 在 `hitStepCap=true` 时**正常 return 而不抛异常**，所以该分支真实可达，不是死代码。

---

## 5. 我建议你审的维度（按性价比排序）

### P0 — 建立测试可见性（预计 30 分钟，收益最大）

1. 把 10 个测试文件全部接进脚本，例如：
   ```json
   "test": "tsx --test src/**/*.test.ts",
   "test:foc-steady": "..."
   ```
2. 解决 3.2 的 `python3` 探测问题（skip 而非 fail）
3. 就 3.1 的两条给出**判断结论 + 依据**，而不是"改成通过"

### P1 — 数值正确性抽查（挑高风险函数，不要通读）

优先看这些，因为出错代价高且不易察觉：

| 模块 | 该验什么 |
|---|---|
| `fft.ts` | 窗函数相干增益（Rect=1.000 / Hann=0.500 / Hamming=0.540 / Blackman-Harris=0.358）、幅值归一化、非 2^n 长度、DC 去除、零填充 |
| `measurements.ts` | 上升/下降时间的插值定义（10%–90%）、占空比、Vtop/Vbase、RMS 在有 NaN 段时的语义 |
| `decimator.ts` | MinMax 是否保住尖峰、LTTB 是否保持单调、抽取后频率读数是否漂移 |
| `resampler.ts` | 非均匀（SPICE/PSIM 自适应步长）重采样是否引入伪频 |
| `filter.ts` | `-3 dB` 是否真在 `cutoffHz`（N 级级联的截止缩放）、zero-phase 是否相位为零、重复 Apply 是否幂等 |
| `oscilloscopeScale.ts` | 1-2-5 取整、8 格边界、AC 耦合均值基线、反相 |
| `mathParser.ts` | 表达式求值的优先级、除零、非法标识符 |
| `thermalEngine.ts` | Foster→Cauer 的 ΣR 守恒、ZOH 递推的解析解一致性、结构函数的物理排序 |

> 注意：`thermalEngine.test.ts` 已经 2174 行、覆盖很细（35 条通过），不要重复造。直接读它作为规格说明，比读实现快。

### P2 — 架构与可维护性（只提建议，别动手重构）

- **39 个模块 / 65k 行的组织**是否合理？`thermalWorkbench.ts`（167 KB）、`focThermal.ts`（114 KB）、`uiController.ts`（204 KB）三个巨型文件是否该拆
- **双实现漂移**：TS 与内嵌 Python 是同一套物理模型的两份代码。建议做一个 fixture 驱动的 parity 测试（把 Python 参考输出存成 JSON，TS 侧断言）
- **单文件产物 2.4 MB**：FOC DynoLab / 热分析工作台是否可以动态 import 拆出去，让主示波器先可用
- **无 CI**：建议加 GitHub Actions（`npm ci` + `lint` + `test` + `build`）

### P3 — 性能

- `uiController.ts` 的 `draw()` 是否有每帧重复分配
- 大文件（1 GSa/s 场景、50 万点 CSV）的导入路径是否全程 `Float64Array`
- `filterWorkbench` 的预览是否每次输入都全量重算

---

## 6. 硬约束（破了就是倒退）

1. **必须保持纯前端单文件离线运行**。不能引入后端、不能要求运行时 Python、不能依赖 CDN
2. **`npm run lint` 必须保持 0 错误**
3. **不要为了代码美观做大重构**。这是一个功能已经很多的工程，重写风险远大于收益。优先给**最小改动**（minimal diff）
4. **不要增加重型依赖**。bundle 已经 1.9 MB minified，再加依赖会直接恶化产物
5. **UI 里的中文是有意的**（面向中文工程师），不要"顺手翻译成英文"
6. **`Channel` / `TabState` 数据模型是对外契约**，改它要同步改所有消费者

---

## 7. 我希望你按这个格式输出

每条发现请包含：

1. **结论**（一句话说清是什么问题）
2. **位置**（`文件:行号`，精确到能跳转）
3. **证据**（实测数字 / 复现命令 / 失败输出；**不要只给"我觉得"**）
4. **分级**（P0 会算错或会崩 / P1 功能与承诺不符 / P2 可维护性 / P3 风格）
5. **最小修法**（直接给 diff 或精确编辑说明）
6. **验证方式**（改完用什么命令、看到什么才算修好）

另外请在开头注明：**哪些结论是"实际跑过验证的"，哪些是"只读了代码推断的"**。这两者价值差很远，不要混在一起。

---

## 8. 建议的开工顺序

```
1. npm install + npm run lint + npm run build        （确认基线，约 2 分钟）
2. 逐个跑 10 个测试文件，复现 6 条失败                （约 3 分钟）
3. 接测试脚本 + 修 python3 探测                      （P0，30 分钟）
4. 就 dead-time 那 2 条给判断                         （需要理解业务，别急着改）
5. 挑 2~3 个高风险数值模块做抽查                       （P1）
6. 出评审报告，等我确认后再动 P2                        （不要直接重构）
```
