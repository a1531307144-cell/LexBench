# LexBench 大 R 角 / 连续曲率（Squircle）实施规范 v1.3（定稿）

日期：2026-10-18
状态：定稿，待实施
范围：应用窗口内部的浮层、面板、卡片、按钮、输入框、列表行、徽标；**窗口外角保持系统圆角（约 8px）**
依赖政策：零新增运行时依赖；纯 CSS 实现，不新增 TS 模块

---

## 0. 一句话结论

保留 v1.2 的**设计方向**（统一令牌、角色化圆角、同心、浮层大 R），
替换其**实现方式**：用 Electron 内置 Chromium 已支持的原生 `corner-shape: squircle`，
不再使用 `clip-path` + `squircle.ts` + `useSquircle.ts` + `LbSurface.vue` + 阴影兄弟层。

---

## 1. v1.2 → v1.3 变更摘要

1. **原生连续曲率**：`border-radius` + `corner-shape: squircle`，浏览器原生绘制。
   `background / border / outline / box-shadow / overflow / backdrop-filter` 均跟随该形状。
2. **删除 clip-path 引擎**：不再需要 `src/shared/squircle.ts`、`useSquircle.ts`、
   `LbSurface.vue`、`ResizeObserver` 重绘、`.lb-plate` 阴影层、SVG 渐变描边。
3. **修正 v1.2 的阴影实现错误**：`clip-path` 与 `filter: blur()` 同元素时，
   规范顺序是 filter → clip-path → mask，模糊结果会被路径裁掉，软阴影变成硬边轮廓。
   v1.3 直接用普通 `box-shadow`（它会跟随 squircle 形状）。
4. **窗口外角定稿**：Windows 11 由系统 DWM 绘制约 8px 圆角；Electron 只能开关、不能设半径。
   本期**不引入** `transparent: true`（会失去边缘缩放、原生阴影、Snap 布局）。
5. **一期不做玻璃、不做内高光**：`backdrop-filter` 与 SVG 渐变描边移到二期单独评估。
6. **保留既有令牌命名**：继续使用 `--lb-radius-s` / `--lb-radius-l`，只重定义值并补档；
   不引入 `-sm / -md / -lg` 造成混用。
7. **锁定强度**：弹窗 26px / 卡片与浮层 18px / 按钮输入 12px / 小件 8px。
8. **明确例外**：顶栏、正文行、行内高亮、进度条、胶囊、圆形不做大 R；
   左侧导航展开面板改为悬浮大 R 面板（26px，四周留 8px）。
9. **页面分割 = 4px 呼吸缝 + 32px 渐隐线 + 26px 内凹圆角**：去掉通到底的 1px 直线；
   内容区四周留 4px 近白呼吸缝（不回到 8px 灰缝的浮卡观感）；
   顶栏底边、竖排右边、阅读顶栏改为两端 32px 渐隐的 1px 线；
   内容区四角 26px 连续曲率（左上角即顶栏/竖排交汇处内凹，保持 26px）。

---

## 2. 技术前提（已核实）

- 项目 `electron: ^44.0.0` → Chromium **152**。
- `corner-shape` 自 Chrome 139 起正式支持，Chromium 152 完整可用。
- 可在运行时探针确认：

```js
CSS.supports('corner-shape', 'squircle') // Electron 44 应为 true
```

- 不支持时属性被忽略，`border-radius` 仍生效，天然回退，无需 `@supports` 包裹。
- `corner-shape` **不继承**，必须逐表面声明。
- `corner-shape` **不改变 hit-testing**：点击区域仍是矩形，现有自测与真实点击不受影响。
- `squircle` 等价于 `superellipse(2)`（约 Lamé n=4）；
  如需更接近 n=5 的观感，可调 `superellipse(2.32)`，默认先用 `squircle`。

---

## 3. 设计规则

### 3.1 连续曲率

- **R ≥ 18 的表面**：`border-radius` + `corner-shape: squircle`。
- **R = 12 的控件**（按钮/输入/列表项/导图节点）：普通圆角，不强制 squircle。
  - 原因：12px 量级连续曲率肉眼差异极小；同时避免带 spread 的聚焦环在超椭圆角上偏移。
- **R = 8 及以下**：普通圆角。
- **胶囊（full）与圆形（50%）**：保持普通圆角，不套 squircle（超椭圆会把端点形状拉怪）。

### 3.2 同心

- 公式：`内层 R = 外层 R − 外层到内层的实际间距`。
- 仅用于**间距小且可见**的嵌套（如 Popover 内菜单项、卡片内图片容器）。
- 加最小半径：`内层 R = max(8px, 外层 R − 间距)`。
- 现有对话框 padding 多为 16–22px，内嵌块**不要**按 8px 间距硬算成 18px；
  这类大间距嵌套按角色取 12px 即可，视觉上不追求数学严格同心。
- 对 squircle 而言该公式是近似；8px 量级间距下不可辨，无需引入运行时计算。

### 3.3 圆角阶梯（沿用既有命名）

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--lb-radius-micro` | 4px | 行内高亮、进度条、滚动条、批注下划线、正文行悬停、微型图标按钮 |
| `--lb-radius-xs` | 8px | 小按钮、关闭键、列表行、代码块、系列选择项 |
| `--lb-radius-s` | 12px | 按钮、输入框、搜索项、列表项、导图节点、紧凑内嵌块 |
| `--lb-radius-l` | 18px | 卡片、Popover、菜单、Toast |
| `--lb-radius-xl` | 26px | 对话框、大浮层 |
| `--lb-radius-full` | 999px | 胶囊、Tag、计数徽标、头像/圆形 |

> 不新增 `--lb-radius-window`：窗口外角由系统管理，CSS 不参与。

### 3.4 角色映射

| 角色 | 选择器 | 目标 |
| --- | --- | --- |
| 对话框 | `.cm-dialog` `.dialog` `.ab-dialog` `.as-dialog` `.bd-dialog` `.id-card` | 26 + squircle + `--lb-shadow-3` |
| 左侧导航悬浮面板 | `.rail-panel` | 26 + squircle + `--lb-shadow-2`；上/下/左各留 8px |
| 内容画布 | `.body > main` | 四边 4px 近白留缝 + 26 全角 squircle；无阴影 |
| Popover / 菜单 / Toast | `.search-pop` `.mode-pop` `.ol-picker-card` `.ol-menu` `.rv-pop` `.sv-search-pop` `.sv-anno-pop` `.update-card` | 18 + squircle + `--lb-shadow-2` |
| 卡片 | `.doc-card` `.ai-card` `.ai-answer` | 18 + squircle；悬停 `--lb-shadow-1` |
| 按钮 / 输入 / 搜索项 / 列表项 | 现用 `var(--lb-radius-s)` 的全部选择器 | 12（普通圆角） |
| 小按钮 / 关闭键 / 列表行 / 代码块 | 现为 5–8px 的选择器 | 8 |
| 卡片型小件 | `.ab-btn` `.id-item` `.ol-img` | 12 |
| 计数徽标 | `.ai-count` `.np-star-count` | full |
| 胶囊 / Tag / 顶栏按钮 | 现为 999px / 980px 的选择器 | full |
| 导图节点 / 导航项 / 品牌方块 | `jmnode` `.rail-item` `.ab-mark` `.brand-mark` | 12 |
| 拖拽提示 | `.drag-hint` | 18 + squircle |
| 微角 | 现为 2–4px 的选择器 | 4 |
| 圆形 | 现为 50% 的选择器 | 保持 50% |

### 3.5 例外清单（明确不做大 R）

- **flush 表面**：窗口外角、`.topbar`、`.rail`、`.error-bar`、`.win-bar`、`.ai-win`、
  `.ai-win-top`、各类 mask、`.drag-overlay`。
- **左侧导航面板**：`.rail-panel` 不再是 flush 侧栏，改为悬浮面板——
  `top/bottom: 8px`、`left: 68px`、26px 连续曲率、`--lb-shadow-2`、整圈 1px 边框、`overflow: hidden`。
- **内容画布**：`.body > main`（含 `.main` / `.reading-full`）四周留 4px 近白呼吸缝；
  四角 26px 连续曲率（左上角即顶栏/竖排交汇处内凹，保持 26px），白底、`overflow: hidden`、无阴影；
  顶栏底边、竖排右边、阅读顶栏（`.sv-top` / `.rv-top`）改为两端 32px 渐隐的 1px 线。
  `.notes-main` 在画布内部，保持白底，不再单独作为 flush 分区。
- **正文与行级元素**：`.sv-article`、`.para`、`mark`、行内 `code`、批注下划线、进度条。
- **胶囊 / 圆形**：所有 999/980/50% 元素。
- **窗口本身**：系统约 8px，CSS 不参与。

---

## 4. 令牌定义 — `src/renderer/src/styles/tokens.css`

```css
/* 法研台全局设计令牌：主窗口与 AI 独立窗口共用 */
:root {
  /* 窗口 chrome 底色：顶栏 / 竖排 / 内容画布外沿留白共用 */
  --lb-chrome: #fbfbfd;

  /* 圆角阶梯（沿用既有 -s/-l 命名，避免全量改名） */
  --lb-radius-micro: 4px;
  --lb-radius-xs: 8px;
  --lb-radius-s: 12px;
  --lb-radius-l: 18px;
  --lb-radius-xl: 26px;
  --lb-radius-full: 999px;

  /* 连续曲率：仅 R >= 18 的表面使用；不继承，需逐表面声明 */
  --lb-corner-shape: squircle;

  /* 表面阴影三档 */
  --lb-shadow-1: 0 1px 2px rgba(20, 24, 38, 0.04), 0 4px 12px rgba(20, 24, 38, 0.06);
  --lb-shadow-2: 0 2px 6px rgba(20, 24, 38, 0.05), 0 10px 28px rgba(20, 24, 38, 0.1);
  --lb-shadow-3: 0 4px 12px rgba(20, 24, 38, 0.06), 0 24px 64px rgba(20, 24, 38, 0.16);
}
```

引入方式（`src/renderer/src/main.ts`，放在 `base.css` 之后）：

```ts
import './styles/base.css'
import './styles/tokens.css'
```

同时删除 `App.vue` 末尾的非 scoped `:root { ... }` 令牌块（颜色/字体/圆角令牌一并迁入 tokens.css，
或保留在原处但只迁走圆角与阴影；推荐全部迁入，主窗与 AI 窗同源）。

---

## 5. 表面阴影规范

只统一**浮层/卡片**的投影，不改功能性阴影（聚焦环、搜索柔光、拖拽插入线、批注下划线）。

| 场景 | 选择器 | 令牌 |
| --- | --- | --- |
| 对话框 | `.cm-dialog` `.dialog` `.ab-dialog` `.as-dialog` `.bd-dialog` `.id-card` | `--lb-shadow-3` |
| Popover / 菜单 / Toast | `.search-pop` `.mode-pop` `.ol-picker-card` `.ol-menu` `.rv-pop` `.sv-search-pop` `.sv-anno-pop` `.update-card` | `--lb-shadow-2` |
| 卡片 / 结果项悬停 | `.doc-card:hover`、`.item:hover`、`.ol-picker-item:hover` | `--lb-shadow-1` |
| 左侧导航悬浮面板 | `.rail-panel` | `--lb-shadow-2` |
| 导图节点 | `jmnode` | `--lb-shadow-1` |

保留不动：`0 0 0 3px/6px` 聚焦环、`0 2px 10px rgba(0,113,227,.16)` 搜索柔光、
`inset 0 ±2px 0` 拖拽插入线、`inset 0 -2px 0` 批注下划线。

---

## 6. 实施步骤

### 6.1 新建令牌文件并接入

1. 新建 `src/renderer/src/styles/tokens.css`，内容见 §4。
2. `main.ts` 在 `base.css` 之后引入。
3. 删除 `App.vue` 的 `:root` 块（或迁移其中非圆角令牌）。
4. 确认 AI 独立窗口（`?aiWindow=1`）仍能取到全部 `--lb-*` 令牌。

### 6.2 重定义既有令牌

- `--lb-radius-s`: 10px → **12px**（42 处自动生效）。
- `--lb-radius-l`: 14px → **18px**（12 处自动生效）。
- 新增 `--lb-radius-micro/-xs/-xl/-full`。

### 6.3 对话框改 `-xl`

把以下规则的 `border-radius` 从 `var(--lb-radius-l)` 改为 `var(--lb-radius-xl)`，
并在下一行加 `corner-shape: var(--lb-corner-shape);`，阴影改 `var(--lb-shadow-3)`：

- `ConfirmModal.vue` `.cm-dialog`
- `ImportDialog.vue` `.dialog`
- `AboutDialog.vue` `.ab-dialog`
- `AiSettingsDialog.vue` `.as-dialog`
- `BackupDialog.vue` `.bd-dialog`
- `ImportOutlineDialog.vue` `.id-card`

### 6.4 浮层 / 卡片加 squircle

以下规则保持 `var(--lb-radius-l)`（自动变 18），加
`corner-shape: var(--lb-corner-shape);`，阴影改 `var(--lb-shadow-2)`：

- `App.vue` `.search-pop` `.mode-pop`
- `OutlineEditor.vue` `.ol-picker-card` `.ol-menu`（`.ol-menu` 原 12px → 18px）
- `ReadingView.vue` `.rv-pop`
- `StatuteReadingView.vue` `.sv-search-pop` `.sv-anno-pop`
- `UpdateToast.vue` `.update-card`（去掉 `, 14px` 回退）

卡片：

- `DocLibrary.vue` `.doc-card`：`-s` → `-l`（18）+ squircle；悬停阴影 `--lb-shadow-1`。
- `AiPanel.vue` `.ai-card` `.ai-answer`：`-s` → `-l`（18）+ squircle。
- `App.vue` `.drag-hint`：14px → `-l`（18）+ squircle。
- `App.vue` `.rail-panel`：改为悬浮面板——`top/bottom: 8px`、`left: 68px`、
  `border-radius: -xl`（26）+ squircle、`--lb-shadow-2`、整圈 1px 边框、`overflow: hidden`。
- `App.vue` `.body > main`：`margin: 4px`、`border-radius: -xl`（26）+ squircle、
  白底、`overflow: hidden`、无阴影；同时删除 `.topbar` 的 `border-bottom` 与
  `.rail` 的 `border-right`，改用 `.topbar::after` / `.rail::after` 两端 **32px** 渐隐的 1px 分割线。
  `.body` 底色用 `--lb-chrome`（近白呼吸缝）；顶栏/竖排底色同 `--lb-chrome`。
- `StatuteReadingView.vue` `.sv-top`、`ReadingView.vue` `.rv-top`：移除 `border-bottom`，
  用 `::after` 两端 32px 渐隐的 1px 线（透明度 .06）；`AiFloatWindow.vue` `.ai-win-top` 同主窗（.08）。

### 6.5 小件与微角收敛

| 现值 | 目标 | 说明 |
| --- | --- | --- |
| 5px / 6px | `--lb-radius-xs`（8） | 关闭键、小动作、列表行、代码块、行内输入等（逐条见 §3.4） |
| 8px | 多数保持 `--lb-radius-xs`（8） | 小按钮/图标键/编辑器输入 |
| 8px（卡片型） | `--lb-radius-s`（12） | `.ab-btn` `.id-item` `.ol-img` |
| 9px | `--lb-radius-full` | `.ai-count` `.np-star-count` 计数徽标 |
| 10px | `--lb-radius-s`（12） | `.rail-item` `.ab-mark` `jmnode` |
| 12px | `.ol-menu` → `-l`（18）；其余 `-s`（12） | |
| 14px | 对话框 → `-xl`；浮层 → `-l` | |
| 999px / 980px | `--lb-radius-full` | 纯替换，视觉不变 |
| 2–4px | `--lb-radius-micro`（4） | 行内高亮/进度条/滚动条/正文行悬停 |
| 50% | 保持 50% | 圆形几何 |
| 0 / 无圆角 | 保持 | flush 表面 |

### 6.6 明确不做

- 不新增 `squircle.ts` / `useSquircle.ts` / `LbSurface.vue` / `examples/`。
- 不新增 `backdrop-filter`、玻璃材质、祖先检测。
- 不新增 SVG 渐变描边、每实例渐变 id。
- 不新增 `clip-path`、`.lb-plate` 阴影层、`filter: blur` 阴影。
- 不改窗口 `transparent` / `roundedCorners` / `backgroundMaterial`。
- 不把 `.rail-panel` 改回 flush 直角；它已按 2026-10-18 用户反馈改为 26px 悬浮面板。
- 不把内容区改回 8px 灰缝浮卡；页面分割由“4px 近白呼吸缝 + 32px 两端渐隐线 + 26px 全角连续曲率”承担。

---

## 7. 验收标准

1. `CSS.supports('corner-shape', 'squircle')` 为 true。
2. 计算样式核对：
   - 对话框 `border-radius: 26px`、`corner-shape: squircle`；
   - `.rail-panel` `26px` + squircle + `--lb-shadow-2`，四周 8px 间距；
   - `.body > main` `margin: 4px`、四角 `26px` + squircle、无阴影；
   - 顶栏 `border-bottom` / 竖排 `border-right` / 阅读顶栏 `border-bottom` 均为 0；
     对应 `::after` 渐隐线存在，两端 32px；
   - `.body` 与顶栏/竖排底色均为 `--lb-chrome`；
   - Popover/卡片 `18px` + `squircle`；
   - 按钮/输入 `12px`；列表行 `8px`；胶囊 `999px`。
3. 所有 R ≥ 18 的表面都有 `corner-shape`；例外清单中的元素不受影响。
4. 阴影贴合 squircle 轮廓，无硬边轮廓、无被裁切的模糊。
5. 聚焦环、拖拽插入线、搜索柔光、批注下划线保持原样。
6. 窗口缩放/最大化/还原正常，系统圆角保持，无布局跳动。
7. 无新增控制台报错、无新增监听器/重绘。
8. `tsc` / `vitest` / `build` / 现有七套 CDP 自测全绿。
9. 截图对比通过：主窗、文档库面板、检索浮窗、确认弹窗、导入弹窗、
   笔记编辑器、阅读页、AI 独立窗。
10. 不新增任何运行时依赖。

---

## 8. 允许调优的参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--lb-corner-shape` | `squircle` | 可改 `superellipse(2.32)`（更接近 n=5，略更“方”） |
| 对话框 R | 26px | 视觉评审后可 22–28px |
| 卡片 / 浮层 R | 18px | 可 16–20px |
| 控件 R | 12px | 可 10–14px |
| 小件 R | 8px | 可 8–10px |
| 三档阴影 | 见 §4 | 可按截图明暗微调不透明度/模糊 |
| squircle 应用阈值 | R ≥ 18 | 若评审希望控件也连续，可下调到 12 并复查聚焦环 |

---

## 9. 禁止改动

- 令牌命名域 `--lb-*`；不重命名既有 `-s/-l`。
- 窗口圆角管理方式（系统 8px，不引入透明窗口）。
- 同心规则的方向（内 R = 外 R − 间距，含 minimum）。
- 例外清单（flush 表面、正文行、微角、胶囊/圆形）。
- 左侧导航面板的悬浮形态（26px + 四边 8px 间距）。
- 页面分割方式：4px 近白呼吸缝 + 32px 两端渐隐线 + 26px 全角连续曲率（不用通栏直线）。
- 零依赖政策与“组件内 scoped CSS + 全局 `--lb-*`”的样式分层。
- 公开材料中的品牌指向（一律用“连续曲率 / 业界通用惯例”表述）。

---

## 10. 已知坑与规避

| 坑 | 规避 |
| --- | --- |
| `clip-path` + `filter: blur` 同元素：模糊被裁掉，软阴影变硬边 | 不用该组合；阴影一律普通 `box-shadow` |
| `corner-shape` 不继承 | 每个表面单独声明，或使用同一工具类 |
| 超椭圆带 spread 的 `box-shadow` 在角上偏移 | 聚焦环尽量保留普通圆角；必要时改 `outline` |
| 胶囊/圆形套 squircle 会变形 | 只对 R ≥ 18 的矩形表面启用 |
| 误以为 `corner-shape` 会裁剪点击区域 | 不会；hit-testing 仍是矩形，自测无需改 |
| 透明窗口换大 R | 会失去边缘缩放/原生阴影/Snap；本期不做 |
| 侧栏面板浮层化后与竖排/顶栏脱节 | `.rail-panel` 四边留 8px、26px squircle；悬停热区仍靠 150ms 缓冲衔接 |
| 内容画布 `overflow: hidden` 裁掉内部弹层 | 阅读批注/笔记插入浮层用 `position: fixed`（不受祖先裁剪）；absolute 弹层保持在内边距内；自测/目检覆盖 |
| 去掉顶栏/竖排分隔线后层次变弱 | 32px 两端渐隐的 `::after` 分割线 + 26px 全角内容画布 + chrome/content 底色差建立分区 |
| 内容区留缝后像浮卡/胶囊 | 只用 4px 近白缝（`--lb-chrome`），不回到 8px 灰缝；不加阴影 |
| 阅读顶栏底边过抢 | `.sv-top` / `.rv-top` 用 32px 渐隐线（.06），与主窗顶栏同一套 |
| AI 窗取不到令牌 | tokens.css 必须在 `main.ts` 全局引入 |
| `UpdateToast` 的 `, 14px` 回退吞掉令牌 | 删除回退，统一走 `--lb-radius-l` |
| 把功能性阴影一起换掉 | 只替换浮层/卡片投影；聚焦环/插入线/柔光保持 |
| 二期加玻璃时嵌套叠加模糊 | 只给最外层浮层加，不做祖先继承；实测性能与对比度 |

---

## 11. 自检清单（实施后逐条打勾）

- [ ] 令牌冲突：`--lb-radius-*` / `--lb-shadow-*` / `--lb-corner-shape` 无重复定义
- [ ] 路径对齐：实际目录为 `src/renderer/src/...`
- [ ] AI 独立窗令牌正常
- [ ] 对话框 26 + squircle + shadow-3
- [ ] 浮层/卡片 18 + squircle + shadow-2/1
- [ ] 控件 12、小件 8、微角 4、胶囊 full
- [ ] flush 表面与正文行未加大 R；`.rail-panel` 为 26px 悬浮面板（8px 间距）
- [ ] `.body > main` 4px 近白缝、四角 26px；顶栏/竖排/阅读顶栏为 32px 两端渐隐线，无通栏直线
- [ ] 内容画布内阅读/笔记的浮层未被 `overflow: hidden` 裁掉
- [ ] 无 `clip-path` / `filter: blur` 阴影残留
- [ ] 无新增依赖、无新增 TS 模块
- [ ] 聚焦环/拖拽插入线/搜索柔光目检正常
- [ ] 窗口缩放/最大化/还原目检正常
- [ ] `tsc` / `vitest` / `build` / 七套自测全绿
- [ ] 八处关键界面截图对比通过
- [ ] 临时验证文件已清理
