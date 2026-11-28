# Waveform Viewer Pro — 界面与操作逻辑优化方案

基于 UI\_OPTIMIZATION\_BRIEF\_CN.md 与 wvp-ui-review-pack.zip 的审阅结果。范围：仅界面布局、视觉层级、交互流程、窗口管理与操作逻辑，不涉及底层算法。

**审阅范围**：完整读过 `index.html` 骨架、`index.css`、`toolDrawer.ts`、`uiController.ts` 的全部事件接线、两个导入弹窗的 HTML、FOC 壳层和 `switchWorkspace`。`canvasRenderer.ts`、`thermalWorkbench.ts`、`filterWorkbench.ts`、`Tab1–4` 正文、`main.ts` 的大部分只做了抽查或没读，涉及它们的建议标注“待确认”。

## 零、诊断结论（均有代码依据）

| # | 发现 | 证据 |
| --- | --- | --- |
| 1 | 主题体系是倒置的 | `index.html` 有 1331 处 `[#hex]` 任意值类和 656 处 `slate-*`；`main.ts` 为 164/109，`uiController.ts` 为 60/75。已定义的 `.wvp-btn`、`.surface-*`、`.text-theme-*`、`.wvp-seg-*` 在这些文件里使用次数为 0。`index.css` 靠约 75 条 `html:not(.dark) .bg-\[\#…\]` 加 65 个 `!important` 反向覆盖。 |
| 2 | FOC 侧反而是对的 | FOC 组件已用 `dyno-*` 语义类，`Charts.tsx` 有 26 处 `var(--…)`。统一方向应是把示波器迁到语义层，而不是让 FOC 学示波器。 |
| 3 | 开工具会吞掉通道控件 | `toolDrawer.ts` 在窗口小于 1520px 时整块隐藏 `#rightControlPanel`，而 V/div、偏移、Δt、游标都在里面。1366px 下抽屉最大 601px，画布约 765px；1600px 下抽屉 440 加右面板 312，画布约 848px。 |
| 4 | 工作区没有隔离 | `keydown`、`paste`、`drop` 是 `window` 级监听，`uiController.ts` 里没有任何 workspace 判断。在 FOC 页按 `A`/`F`/`U`/`1-8` 会作用到隐藏的示波器，拖文件会加载进示波器。顶栏的“打开文件/LTspice/导出/标签页”在 FOC 下仍显示，`switchWorkspace` 还硬写 className 字符串。 |
| 5 | 画布手势丰富但不可发现 | Y 轴槽滚轮（V/div）、拖拽（偏移）、双击（归零）、GND 手柄、Shift/Alt+滚轮、右键拖框选、双击适配。`contextmenu` 只做了 `preventDefault`，右键菜单空着。 |
| 6 | 两个导入弹窗割裂 | 宽度 `max-w-4xl` 对 `max-w-6xl`；标题色不同；CSV 全中文，Excel 含 `Header Row`、`First Data Row`、`Time Column Unit`、`Sample Rate Override`、`All/Numeric/None`、`Separate Tabs`、`0 selected`。 |
| 7 | 两个实际缺陷 | ① `pushUndoSnapshot` 在 GND/Y 轴槽 `mousedown` 无条件入栈，单击不拖也占一格，栈上限 30。② `showToast` 共 84 处调用，62 处是英文，界面却是中文；LTspice 徽标 HTML 写“实时”，`main.ts:156` 写 `LIVE/PAUSED`。 |
| 8 | Esc 优先级不合理 | 抽屉有标签时，Esc 先关抽屉，画布上的框选/标注工具要再按一次才取消。 |

## 一、信息架构与主工作区布局

### 顶栏（`index.html` 36–125）

- 左侧保持 Logo、工作区切换、`#tabsContainer`。
- 右侧只留三个：`#loadBtn`（唯一 primary）、`导出 ▾`、`更多 ▾`。
- `更多 ▾` 收纳 `#themeSelect`、LTspice 监听条（有监听条目时才展开，`#reloadLtspiceBtn` / `#autoLtspiceChk` / `#ltspiceWatchBadge` 现已按条件显示）、`工具` 菜单项、`#togglePanelBtn`。

### 工具栏（两行，196–260）

- 渲染模式 4 路（`renderMode*Btn`）和抽稀 2 路（`decim*Btn`）是一次设置、很少再动的选项，合并为一个 `显示 ▾` 弹层。
- 一行留给高频项：时基 H、平移、时域/FFT/XY、叠加/分栏、采样率与点数读数。
- 另一行留给动作：测量、数学、对比、滤波、热仿真、分析▾、对齐、自动设置、适配、框选、撤销重做、标注。

### 右面板与抽屉共生（三档）

| 窗口宽度 | 布局 |
| --- | --- |
| ≥1680 | 画布 + 右面板 312 + 抽屉（≤440） |
| 1366–1679 | 右面板收成“通道检查器”，其余 section 折叠；抽屉仍可开 |
| <1366 | 通道检查器移入软键条下方一行，右面板隐藏 |

通道检查器的做法：不要复制 DOM，而是把通道块用 `appendChild` 在右面板和软键条之间搬家，ID 和事件监听都保留。

- **P0 简版**：自动折叠不再 `hidden` 整个面板，只隐藏通道块以外的 section。改动点在 `toolDrawer.ts` 的 `syncRightPanelAutoCollapse`（约 202–220 行）和 `index.css`。
- **右面板其余 section** 改手风琴，状态持久化：FFT/XY 已按模式显隐，对比组/数学通道/文件摘要折叠。

### 底部

- `#channelSoftkeysBar` 增加：双击软键 = 仅显示该通道（再双击恢复）；Alt+点击 = 仅适配该通道。目前只有点击选择和色块显隐（`renderSoftkeysOnly`，约 4714 行）。
- `text-[9px]` 的徽标统一到 10px。

## 二、窗口/抽屉/弹窗体系规范

### 分类规则

| 类型 | 判据 | 归属 |
| --- | --- | --- |
| 停靠抽屉 | 调参数并需要同时看画布 | measure、filter、math、phase、anomaly、waveformEdit、cropExport、transform、motor |
| 宽窗 | 自带预览图或多栏 | compare、bldc、batch、thermal |
| 阻塞模态 | 必须确认才继续 | csv/excel 导入、textAnnotation |
| 一次性浮层 | 查完即走 | shortcutsModal（现在是 dockable，占抽屉不合理）、presetModal、testSuiteModal |

- `toolDrawer.ts` 的 `PREFERRED_TOOL_WIDTHS` 里也列了 compare/bldc/batch/thermal 的宽度，这几个是否也能停靠需确认。若可停靠，1600px 下 thermal 680 加右面板 312 会把画布压到约 608px，应禁止这四个在 <1680 时停靠。
- 宽窗增加“最大化到画布区”模式：只覆盖画布 section，保留顶栏。
- 抽屉同时打开标签数上限 3，超出时关闭最久未用的并提示。
- Esc 顺序改为：导入弹窗 → 画布活动工具 → 抽屉标签 → 阻塞模态（`uiController.ts` 约 2147–2165）。

### 导入弹窗统一（分两步，P0 不改 ID）

1. **视觉统一**：同宽 `max-w-6xl`，同标题样式，同页脚顺序 `[取消] [按原始加载] [加载并重采样]`（主按钮靠右），Excel 的英文标签全部中文化。
2. **结构统一（P1）**：抽 `src/modules/importShell.ts`，统一生成头部、多文件条、页脚；Excel 多一列 Sheet 列表，CSV 隐藏它。

两个弹窗的平行控件 ID 对照（均保留不改）：

| CSV | Excel |
| --- | --- |
| csvMultiFileBar / csvFilePillsWrap | xlsMultiFileBar / xlsFilePillsWrap |
| csvApplyRulesAllBtn | xlsApplyRulesBatchBtn |
| csvTimeUnitSelect | xlsTimeUnitSelect |
| csvSampleRatePresetSelect / csvCustomRateInput | xlsSampleRateSelect / xlsCustomRateInput |
| csvMergeTimeModeSelect | xlsMergeTimeModeSelect |
| csvAuditSummaryRow | xlsAuditBanner |
| csvPreviewContainer | xlsPreviewTableWrap |
| csvCancelBtn / csvLoadOriginalBtn / csvLoadResampleBtn | xlsCancelBtn / xlsLoadOriginalBtn / xlsPrimaryConfirmBtn |

## 三、操作逻辑与高频动线优化

### 画布右键菜单

- 右键拖仍是框选；位移小于 4px 的右键单击才弹菜单。
- 菜单项：适配视图、自动设置、归零该通道偏移、在此放置游标、在此添加标点、复制读数。
- 实现位置：`uiController.ts` 的 `contextmenu`（约 2083 行）和 `handleMouseUp`。

### 快捷键补充

避开现有的 `1-8 U A F Z T O S ←→↑↓ +/- Esc Ctrl+S/Z/Y`。

| 键 | 动作 |
| --- | --- |
| `Shift+↑/↓` | 当前通道偏移 ±0.5 格（对应右面板 `vOffsetUp/DownBtn`） |
| `C` | 游标模式循环 off→x→y→xy→track |
| `M` | 打开/聚焦测量抽屉 |
| `H` | 隐藏/显示当前通道 |
| `[` `]` | 前后切换通道（超过 8 个时有用） |
| `?` | 快捷键浮层（`uiController.ts` 里没看到 `?` 的处理，可能在 `main.ts`，待确认） |

### 可发现性与 Δt 对齐

- 鼠标停在 Y 轴槽时显示一行提示“滚轮=V/div · 拖拽=偏移 · 双击=归零”，首次出现后可关闭。
- Δt 对齐目前只能在右面板输入框、`chTimeShiftSnapBtn`、归零里操作。建议加 Alt+拖动波形 = 当前通道 Δt 平移。`handleMouseDown` 后半段（平移分支）未读完，需确认 Alt 未被占用。

### 撤销栈修复（P0）

把入栈从 `mousedown` 移到 `mouseup`，且仅在位移超过阈值时入栈。涉及 GND 手柄和 Y 轴槽两处，约 2266–2300 行。

### 反馈统一

- Toast 全部中文，四级：info / success / warn / error，沿用 `#scopeToast` 的画布底部居中位置。
- 可撤销动作的 toast 带 `[撤销]`，例如“已归零 CH2 偏移 \[撤销\]”。
- 建议 `src/modules/toastText.ts` 集中管理文案，替换 `uiController.ts` 和 `main.ts` 的 62 处英文。

## 四、视觉层级、配色与组件一致性

### Token 补全（`index.css`）

- 状态色：`--ok/--warn/--danger/--info` 各带 `-soft`、`-border`。`dyno-alert-*` 已有雏形，升格为 `.wvp-alert-*`。
- `--focus-ring` 和 `--bg-input`。
- z-index 与字号刻度：现在 `toolDrawer.ts` 的 `undockPanel` 硬写 `zIndex='75'`，模态是 `z-50`。

### 清理硬编码，不要手改 1331 处

1. 用 Tailwind v4 的 `@theme inline` 把变量映射成工具类：`--color-panel: var(--bg-panel)` 之类，得到 `bg-panel`、`bg-well`、`bg-elevated`、`border-line`、`text-fg-muted`。
2. 写一次性 codemod（正则或 ts-morph），按角色映射：

| 原值 | 次数 | 目标 |
| --- | --- | --- |
| `#222933` | 539 | `border-line` |
| `#0c0f13` | 197 | `bg-well` |
| `#12161c` | 195 | `bg-panel` |
| `#1e2530`（hover） | 150 | `hover:bg-hover` |
| `#161b22` | 125 | `bg-elevated` |
| `#2c3543` / `#2c3849` | — | `border-line-strong` |
| `#080b0f` | — | `bg-stage` |

`slate-100/200/300/400/500` 按文字角色分别映射到 primary / secondary / muted。

3. 先跑 `index.html`，再跑 JS 里拼接的 HTML 字符串（`main.ts`、`uiController.ts`、`thermalWorkbench.ts`、`excelImportModal.ts`）。
4. 每迁完一批，删除 `index.css` 里对应的 override；最终三套主题只差 token 值。
5. 加一条 CI 检查：出现 `\[#[0-9a-f]{3,8}\]` 的类名即报错。
6. 验收：3 主题 × 5 个关键视图（空状态、叠加、分栏、FFT、含抽屉）截图对比。

### 按钮层级（四级）

| 级别 | 用途 | 现状问题 |
| --- | --- | --- |
| Primary | 每视图仅一个：`打开文件` / `加载并重采样` | 顶栏之外，`热仿真`（cyan 实心边）和 `自动设置`（cyan 字）同时在抢强调 |
| Secondary | `.wvp-btn` | — |
| Ghost | 工具栏图标 | — |
| Danger | `清空标注`、`清除测量` | 仅 hover 变红，保持 |

建议 `热仿真` 用 `wvp-btn-accent-soft`，`自动设置` 降为 Secondary 并在按钮上标 `A`。

### 分段控件

现在有两套激活语言：`timeModeBtn` 是 cyan 实心，`overlapViewBtn` 是灰底。规则定为：一级模式（时域/FFT/XY、光标模式）用 accent 实心，二级选项（叠加/分栏、渲染、抽稀、Separate/Merge）用 `.wvp-seg-active`。`switchWorkspace` 改用 `aria-pressed` 加这套类，不再硬写 className。

## 五、FOC 测功台与示波器的视觉及操作对齐

- **顶部 chrome 过厚**：app 顶栏 40px、FOC 自己的 sticky 头（`px-5 py-2`）、数据来源条（约 30px），合计三层。把 FOC 头压到 `px-3 py-1` 与示波器工具栏等高。数据来源条在 DEMO/混合数据时保留（警示有价值），全为实测时折叠成一个 ✓ 徽标。
- **内容密度**：`p-5 lg:p-6` 降到 `p-3 lg:p-4`；按钮 `px-3.5 py-1.5` 对齐示波器的 `px-2.5 py-1`。
- **顶栏上下文**：给示波器专属元素加 `scope-only` 类，`<body data-workspace>` 切换时在 FOC 下隐藏 `#tabsContainer`、`#loadBtn`、LTspice 监听条、`导出`、`工具`，ID 全部不变。
- **事件隔离（P0）**：`uiController.ts` 的 `keydown`（约 2125）、`paste`（约 2088）、`drop`（约 2115）开头加 `document.body.dataset.workspace !== 'scope'` 守卫。在 FOC 拖文件时，路由给 FOC 当前 Tab 的导入器，或提示“切换到示波器？”。
- **侧栏折叠**：FOC 的 `sidebarOpen` 与示波器的“收起面板”用同一位置、同一文案、同一记忆方式（localStorage）。
- **Toast**：FOC 有自己的 `showToast`，换成与示波器同一个组件和位置。
- **回传示波器**：`onSendTabToScope` 已有，发送后是否自动切回示波器并提示，待确认；建议做。
- `Charts.tsx` 里残留 3 处 hex、1 处 slate，随 codemod 一并清掉。

## 六、分阶段落地优先级清单

### P0（高收益低风险，不改 DOM 结构）

| 项 | 文件 |
| --- | --- |
| 工作区事件隔离 + `data-workspace` | `uiController.ts`、`main.ts`（`switchWorkspace`）、`index.html` |
| 撤销栈改 mouseup + 位移阈值 | `uiController.ts`（约 2266–2300） |
| 右面板自动折叠保留通道块 | `toolDrawer.ts`（约 202–220）、`index.css` |
| Esc 优先级调整 | `uiController.ts`（约 2147–2165） |
| 文案中文化（toast、Excel 弹窗、LTspice 徽标） | `uiController.ts`、`main.ts`、`excelImportModal.ts`、`index.html`（641–760） |
| 导入弹窗视觉统一（宽度、标题、页脚） | `index.html`（552–760）、`excelImportModal.ts` |
| Token 基建（`@theme inline` + 状态色），暂不删旧覆盖 | `index.css` |

### P1（体验重塑）

| 项 | 文件 |
| --- | --- |
| codemod 清理硬编码并删除 override | `index.html`、`main.ts`、`uiController.ts`、`thermalWorkbench.ts`、`excelImportModal.ts`、`index.css` |
| 顶栏/工具栏重组、`显示 ▾` 弹层 | `index.html`（36–260）、`main.ts`（`bindToolbarActions`） |
| 右面板手风琴 + 通道检查器搬家 | `index.html`（324–530）、`uiController.ts` |
| 画布右键菜单、新快捷键、手势提示 | `uiController.ts`（2064–2260、2734） |
| 导入壳抽取 | 新建 `importShell.ts`、`excelImportModal.ts` |
| FOC chrome 压缩与状态徽标 | `FocDynoLabApp.tsx`（约 240–330）、`SidebarParams.tsx` |

### P2（细节打磨）

- 宽窗“最大化到画布区”；抽屉标签上限 3；记住上次导入选项。
- 无障碍：焦点环、`aria-pressed`、软键条键盘遍历。
- 三主题截图回归的自动化。

## 附：动 HTML 前必须先查的一件事

工具栏里的分段按钮（`renderMode*Btn`、`decim*Btn`、`timeModeBtn` 等）的激活态，很可能是在 `main.ts` / `uiController.ts` 里用 `className = '…'` 整串覆盖的（和 `switchWorkspace` 同一写法）。迁移前先 `grep -n "className *="` 这些 ID，改成 `data-active` 或 `aria-pressed` 之后再搬位置，否则弹层化后样式会错乱。
