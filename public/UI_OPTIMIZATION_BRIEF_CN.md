# Waveform Viewer Pro — 界面、视图与操作逻辑专项优化简报

## 一、任务目标与严格约束（必读）
你是一名资深工业仪器 / Web 示波器 UI/UX 架构师。本次任务**仅优化界面布局、视觉层级、交互流程、窗口管理与操作逻辑**，**不改动任何底层算法、物理仿真、信号处理、文件解析与计算公式**。
请直接基于以下工程信息输出**可落地的界面与交互优化方案**（包含具体控件调整、布局结构、交互流改进及对应的文件改动点），无需重写业务计算逻辑。

### 严格边界
1. **保持功能完整**：所有现有按钮功能、快捷键、通道联动、测量、热仿真、FOC 测功台子功能必须保留（可合并重复入口或重构分组，但不能丢失能力）。
2. **保护现有 DOM ID 与事件约定**：主示波器主体采用「原生 HTML + TypeScript DOM 控制器（`src/main.ts` + `src/engine/uiController.ts`）」驱动，大量逻辑通过 `document.getElementById(...)` 绑定；若调整 HTML 结构或拆分组件，必须明确标出哪些 `id` 需保留或如何迁移绑定。
3. **只阅读下方「UI/视图关注清单」内的文件**，切勿把 Token 浪费在解析器与数学/热仿真内核上。

---

## 二、技术栈与双视图架构总览
- **构建栈**：Vite + TypeScript + Tailwind CSS v4（`@import "tailwindcss";`）+ React 19（仅局部挂载于 FOC 测功台）。
- **真正入口**：`index.html` 加载 `/src/main.ts`（`src/App.tsx` 和 `src/main.tsx` 只是脚手架空壳，实际启动在 `src/main.ts`）。
- **两大工作区切换**（顶部 `#wsScopeBtn` / `#wsFocDynoBtn`）：
  1. **示波器工作区（`#scopeWorkspaceMain`）**：原生 DOM + `<canvas id="waveformCanvas">`，包含顶部工具栏、画布、底部动态测量条与通道软键、右侧 312px 控制面板、可停靠/分屏/悬浮工具抽屉、以及 19 个弹窗/工作台。
  2. **FOC 测功台工作区（`#focDynoLabView`）**：在 `src/main.ts` 中动态挂载 React 组件 `FocDynoLabApp.tsx`（含 4 个 Tab 与独立侧边参数栏）。

---

## 三、文件阅读清单（按优先级只看这些，省 Token）

### A. 核心必读（主界面骨架、主题与主控制器）
| 文件路径 | 行数 | 职责说明 |
| :--- | :--- | :--- |
| `index.html` | ~3210 | 顶部栏、两行工具栏、画布区、底部栏、右侧控制面板（1–549 行），以及 19 个模态框/抽屉的 HTML 结构（551–3210 行）。**建议按行段按需读取，勿整文件反复重读**。 |
| `src/index.css` | ~978 | Tailwind v4 入口 + 3 套主题 CSS 变量（`daylight` 现代浅灰默认 / `obsidian` 精密深灰 / `midnight` 深海蓝）+ 对旧暗色 Tailwind 类名（如 `bg-[#12161c]`、`text-slate-*`）的亮色主题映射覆盖规则 + 抽屉/悬浮窗样式。 |
| `src/modules/themeManager.ts` | ~338 | 3 套主题色板、画布配色、WCAG 对比度通道文字色计算 `resolveChannelTextColor`。 |
| `src/modules/toolDrawer.ts` | ~466 | 右侧非遮挡式工具抽屉 `#toolDrawerContainer`：支持多标签、上下双分屏（Split-2）、左缘拖拽调宽（360–820px）、小屏（<1520px）自动折叠 `#rightControlPanel`、抽屉↔居中悬浮弹窗双向切换。 |
| `src/modules/draggableModals.ts` | ~241 | 悬浮/宽屏弹窗的标题栏拖拽移动与边距限制。 |

### B. 视图渲染与交互逻辑（只看交互、事件与面板拼装）
| 文件路径 | 行数 | 关注重点（其余忽略） |
| :--- | :--- | :--- |
| `src/engine/uiController.ts` | ~5838 | 示波器主体交互控制器：**仅看**画布鼠标/滚轮/右键框选/拖拽偏移/快捷键交互、通道软键条渲染、测量卡片条渲染、游标/FFT/XY 侧栏联动、导入文件弹窗调度。**忽略**其中的数据重采样、数学通道求值调用细节。 |
| `src/engine/canvasRenderer.ts` | ~2754 | 示波器 `<canvas>` 2D 绘制：**仅看**网格/刻度尺/通道颜色标尺、分栏与叠加布局、游标 HUD、图例与标注绘制。 |
| `src/main.ts` | ~4214 | 顶部/工具栏/弹窗 DOM 事件接线、Compare/BLDC/Measure/Preset/Batch/Phase/Anomaly 面板 UI 渲染与更新。**只看 UI 事件绑定与 DOM 渲染片段**。 |
| `src/modules/excelImportModal.ts` | ~777 | Excel 多文件/多 Sheet 导入向导弹窗 UI 与交互（可对照 `index.html` 的 `#csvQualityModal` 一并看导入体验一致性）。 |
| `src/modules/filterWorkbench.ts` | ~1076 | 滤波工作台界面与交互逻辑（仅看 UI 渲染与控制联动，忽略 DSP 滤波算法）。 |
| `src/modules/thermalWorkbench.ts` | ~5524 | MOS 热仿真宽屏工作台（`#thermalModal` 内 6 个子标签页的交互逻辑，仅看面板切换与表单/图表联动）。 |

### C. FOC 测功台子工作区（React UI）
- `src/components/focDyno/FocDynoLabApp.tsx`（~530 行：整体壳层、左侧边栏折叠、4 Tab 切换）
- `src/components/focDyno/SidebarParams.tsx`（~349 行：左侧电机参数表单）
- `src/components/focDyno/Tab1DynoCalib.tsx`（~682 行） / `Tab2RuntimeEst.tsx`（~966 行） / `Tab3ThermalExport.tsx`（~522 行） / `Tab4DynamicPmsm.tsx`（~398 行）
- `src/components/focDyno/Charts.tsx`（~676 行：图表展示）
- `src/components/focDyno/SmoothNumberInput.tsx`（~96 行）

---

## 四、严禁读取/修改的黑名单（节省 Token，勿动逻辑）
以下文件纯属底层解析、数学、电机物理、热网络求解与单测，本次优化**完全不需要看，也不要修改**：
- `src/parsers/*`（CSV / Excel / WFM / LTspice `.raw`/`.txt` 解析）
- `src/modules/measurements.ts`、`bldcAnalysis.ts`、`motorAnalysis.ts`、`fft.ts`、`filter.ts`、`mathParser.ts`、`transforms.ts`、`resampler.ts`、`decimator.ts`、`timeDecimator.ts`、`timeSync.ts`、`excelTimeAlignment.ts`、`waveformCompare.ts`、`anomalyScanner.ts`、`dptAnalyzer.ts`、`dynamicSoa.ts`、`singleShuntRecon.ts`、`thermalEngine.ts`、`oscilloscopeScale.ts`、`autoSet.ts`、`trigger.ts`、`exporter.ts`、`reportExporter.ts`
- `src/modules/focThermal/*`、`src/modules/focThermal.ts`、`src/modules/focMosDeviceProfiles.ts`
- `src/modules/focDyno/*`（纯计算与桥接，除外层 React 组件）
- `src/engine/session.ts`、`src/tests/*`、`src/modules/*.test.ts`、根目录所有 `*.md` 审查报告

---

## 五、当前 UI 结构与已知痛点线索（供你快速切入）

1. **视觉与主题现状**：
   - 当前默认主题为 `daylight`（现代浅灰工程风：`--bg-chassis: #eef2f6`, `--bg-panel: #f8fafc`, `--canvas-stage: #ffffff`, `--accent: #0284c7`），并支持切换 `obsidian`（精密深灰）、`midnight`（深海蓝）。
   - **历史包袱**：`index.html` 和部分动态拼接 HTML 中仍写有大量硬编码暗色类名（如 `bg-[#0c0f13]`、`bg-[#12161c]`、`text-slate-200`、`border-[#222933]`），目前靠 `src/index.css` 里的 `html[data-theme="daylight"] .bg-\[\#12161c\]` 等 CSS 选择器强行覆盖，偶有边角弹窗、下拉、徽章或深色图标对比度/层次不够统一的问题。
2. **顶栏与工具栏密度**：
   - 顶栏（Header）左侧放了 Logo + `[示波器 | FOC 测功台]` + 标签页容器 `#tabsContainer`；右侧放了 `打开文件`、`LTspice 监听`、主题下拉、`工具`、`导出`、`收起面板`。标签页多时容易挤压。
   - 画布上方有 2 行工具栏（Row 1：时基 `H`、左右平移、采样率/点数、时域/FFT/XY、叠加/分栏、连线/插值/散点/线+点、峰谷/LTTB；Row 2：测量/数学/对比/滤波/MOS 热仿真/分析下拉、同量纲对齐/自动设置/全局适配/框选缩放/撤销重做/标点文本框测）。
3. **窗口停靠 vs 弹窗体验**：
   - 轻量工具（测量、滤波、数学、相角差、异常扫描、编辑、切片、三相/功率、电机转速、预设、快捷键）标记了 `.tool-dockable`，默认停靠在右侧 `#toolDrawerContainer` 并支持与另一个工具上下分屏或弹出悬浮；大面板（`compareModal`、`bldcModal`、`batchModal`、`thermalModal`）标记为 `.tool-wide-modal` 居中宽窗打开。
   - 现状需要重点审视：**多工具并行时的空间挤压**（画布 + 抽屉 + 右侧 312px 面板同时存在时在 1366~1600px 屏幕上的体验）、**抽屉与右面板功能定位是否重叠/混乱**、**各类弹窗尺寸/滚动/表单排布是否顺手**。
4. **操作与交互链路**：
   - 通道控制分布在「底部通道软键条 `#channelSoftkeysBar` + 右侧控制面板 `#rightControlPanel` + 画布左侧垂直标尺交互 + 顶部快捷按钮」，需要审视高频操作（切通道、调 V/div、偏移、Δt 对齐、游标定位、测量增删、导入向导）的点击步数与反馈提示是否够直观流畅。
   - 导入弹窗存在两套独立界面：`#csvQualityModal`（CSV/TXT）与 `#excelImportModal`（Excel），其交互逻辑与视觉语言是否可以进一步统一优化。

---

## 六、希望你输出的优化方案格式
请从以下 6 个维度给出**具体、可由工程师直接按图施工**的优化方案（无需贴大段无关代码，聚焦结构改动与交互设计）：
1. **信息架构与主工作区布局重组**（顶栏、工具栏、画布占比、底部测量条/通道条、右侧控制面板与工具抽屉的共生关系及响应式断点）。
2. **窗口/抽屉/弹窗体系规范**（哪些该侧边停靠、哪些该弹窗、哪些该并入 Tab/折叠面板；解决两个导入弹窗 `#csvQualityModal` 与 `#excelImportModal` 体验割裂的问题）。
3. **操作逻辑与高频动线优化**（鼠标/快捷键/右键菜单/通道切换/测量联动/游标/Δt 与对比操作的最短路径设计）。
4. **视觉层级、配色与组件一致性规范**（清理硬编码暗色类名、统一 3 套主题 Token、按钮主次层级、状态反馈 Toast/Badge 统一）。
5. **FOC 测功台（React 子视图）与主示波器的视觉及操作对齐**（确保切换过去像同一个产品，而不是两套风格）。
6. **分阶段落地优先级清单**（P0 高收益低风险 → P1 体验重塑 → P2 细节打磨，标明每项涉及的具体文件路径）。
