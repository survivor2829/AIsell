# Design Tokens — 小玺AI

> **生成日期**: 2026-04-22
> **来源**: `static/css/design-system.css` 提炼 + 基于现有 UI 风格扩展
> **用途**: 任务2 Loading pill 状态色 + 任务3 UI 美化 + 未来 block 模板 + 任何新增 UI
> **决策原则**: Webflow / Apple 美学 — 低对比 + 细微阴影 + 克制色彩

---

## 1. 颜色系统

### 1.1 主色（Primary）
```css
--color-primary:              #146ef5;    /* 品牌蓝 */
--color-primary-hover:        #0055d4;
--color-primary-light:        rgba(20,110,245,0.08);   /* 背景柔色 */
--color-primary-border:       rgba(20,110,245,0.25);
--color-primary-shadow:       rgba(20,110,245,0.18);
--color-primary-shadow-strong:rgba(20,110,245,0.24);
```
**使用**: 按钮主色、链接、focus outline、状态 processing 强调

### 1.2 文字色（Text）
```css
--color-text:              #080808;    /* 最深, 正文极重要 */
--color-title:             #212829;    /* 标题, 略柔于 text */
--color-text-secondary:    #363636;    /* 段落 / 表单 label */
--color-text-hint:         #5f5f5f;    /* 次要提示 */
--color-text-muted:        #999999;    /* 占位文字 / disabled */
--color-text-placeholder:  #ababab;    /* input placeholder */
```

### 1.3 表面色（Surfaces）
```css
--color-bg:          #ffffff;           /* 卡片白 */
--color-bg-page:     #f5f6f8;           /* 页面背景 */
--color-bg-subtle:   #f9fafb;           /* hover 态底色 */
--color-bg-hover:    rgba(0,0,0,0.02);  /* ghost 按钮 hover */
```

### 1.4 边框 / 分隔（Borders）
```css
--color-border:         #eeeeee;
--color-border-2:       #e2e2e2;
--color-divider:        #f1f1f3;        /* 清冷分隔 */
--color-border-hover:   #c9c9c9;
--color-border-focus:   var(--color-primary);
```

### 1.5 语义色（Status）— **任务2 pill 用这套**

| Token | 值 | 配套 bg | 用途 |
|---|---|---|---|
| `--color-success` | `#00d722` | `#ecfdf5` | **done** / 成功 |
| `--color-warning` | `#ffae13` | `#fffbeb` | **pending** / 警告 |
| `--color-error`   | `#ee1d36` | `#fef2f2` | **failed** / 错误 |
| `--color-info`    | `#146ef5` | `#eff6ff` | 普通信息提示 |
| `--color-primary` | `#146ef5` | `rgba(20,110,245,0.08)` | **processing** 各阶段 |

### 1.6 辅助强调色（Secondary Accents）
```css
--color-purple: #7a3dff;    /* 高亮 / 装饰 */
--color-pink:   #ed52cb;    /* 促销 / 标签 */
--color-green:  #00d722;    /* = success 别名 */
--color-orange: #ff6b00;    /* 强提醒 */
```
**使用规则**: 主 UI 不用这些色；仅用于装饰点缀、运营标签、统计图。

---

## 2. 字体层级

### 2.1 字体栈
```css
--font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'PingFang SC',
             'Noto Sans SC', 'Microsoft YaHei', sans-serif;
--font-mono: 'SF Mono', 'Fira Code', 'Consolas', monospace;
```
**注意**: 中文 fallback `PingFang SC > Noto Sans SC > Microsoft YaHei`。Emoji 由 fontconfig 自动匹配 Noto Color Emoji（见铁律11）。

### 2.2 字号层级

| 级别 | font-size | font-weight | line-height | letter-spacing | 用途 |
|---|---|---|---|---|---|
| **H1** | `32px` | 600 | 1.2 | -0.02em | 页面标题（index/workspace top） |
| **H2** | `24px` | 600 | 1.2 | -0.02em | 卡片大标题 |
| **H3** | `20px` | 600 | 1.2 | -0.02em | 分组标题 |
| **H4** | `16px` | 500 | 1.2 | -0.02em | 子标题 |
| **Body**| `14px`| 400 | 1.6 | 0 | 正文、按钮 |
| **Label** | `13px` | 500 | 1.5 | 0.01em | form label |
| **Caption** | `12px` | 400 | 1.5 | 0.02em | 小注释、lightbox caption |
| **Tiny** | `11px` | 500 | 1.4 | 0.05em | 徽章 / pill 文字 |

### 2.3 Pill 专用（任务2 状态）
```css
/* 状态 pill 统一字号 */
font-size: 12px;
font-weight: 500;
letter-spacing: 0.02em;
line-height: 1;
padding: 4px 10px;
border-radius: var(--radius-pill); /* 100px */
```

---

## 3. 间距尺度（Spacing）

8-base grid（Apple 惯例，乘法易算）：
```css
--space-1:  4px;
--space-2:  8px;
--space-3:  12px;
--space-4:  16px;
--space-5:  20px;
--space-6:  24px;
--space-8:  32px;
--space-10: 40px;
--space-12: 48px;
--space-16: 64px;
```
**用途**：`padding` / `gap` / `margin` 全部用这 10 个值。不自造 `15px` / `22px` 这种。

**常见组合**：
- 卡片 padding: `var(--space-6)` = 24
- form-group 间距: `var(--space-5)` = 20
- 按钮内 icon-text gap: `var(--space-2)` = 8

---

## 4. 圆角（Radius）

```css
--radius-sm:    4px;        /* 徽章、小按钮 */
--radius-panel: 6px;        /* 主按钮、浮层面板 */
--radius-md:    8px;        /* 卡片次级、模态次级 */
--radius-input: 10px;       /* 表单输入 */
--radius-lg:    12px;       /* 卡片主体、lightbox 容器 */
--radius-xl:    16px;       /* 大卡片、大模态 */
--radius-pill:  100px;      /* 胶囊 / pill / 状态徽章 */
--radius-full:  9999px;     /* 完全圆（头像、icon 按钮） */
```

---

## 5. 阴影（Shadows）

### 5.1 通用 5 档
```css
--shadow-xs:  0 1px 2px rgba(0,0,0,0.04);              /* 细边感 */
--shadow-sm:  0 1px 3px rgba(0,0,0,0.06),
              0 1px 2px rgba(0,0,0,0.04);              /* 按钮默认 */
--shadow-md:  0 4px 6px -1px rgba(0,0,0,0.06),
              0 2px 4px -1px rgba(0,0,0,0.04);         /* 卡片 hover */
--shadow-lg:  0 10px 15px -3px rgba(0,0,0,0.06),
              0 4px 6px -2px rgba(0,0,0,0.03);         /* 浮层 */
--shadow-xl:  0 20px 25px -5px rgba(0,0,0,0.06),
              0 10px 10px -5px rgba(0,0,0,0.03);       /* 大浮层 */
```

### 5.2 专用
```css
--shadow-card:  0 3px 7px rgba(0,0,0,0.06),
                0 13px 13px rgba(0,0,0,0.05),
                0 30px 18px rgba(0,0,0,0.03);
/* 深邃卡片, Webflow 风格, 4 层叠加 */

--shadow-float: 0 25px 50px -12px rgba(0,0,0,0.15);
/* 显著浮起, lightbox / dropdown */

--shadow-panel: 0 1px 2px rgba(0,0,0,0.03),
                0 4px 12px rgba(0,0,0,0.04);
/* + border-panel 组合, 用于次级面板 */
```

**Pill 专用**：不用阴影，用**边框 + 背景** 描边（Apple 规范，扁平化）。

---

## 6. 动效（Motion）

### 6.1 Duration
```css
--duration-fast:   150ms;   /* hover / focus / 按压 */
--duration-base:   200ms;   /* 通用过渡（原值, 保留） */
--duration-normal: 250ms;   /* 状态切换、pill 状态过渡 */
--duration-slow:   400ms;   /* 模态进入、大卡片 hover */
--duration-pulse:  1800ms;  /* 呼吸灯全周期（breathing pill） */
```

### 6.2 Easing
```css
--ease-out:        cubic-bezier(0.0, 0.0, 0.2, 1);       /* 进入 */
--ease-in:         cubic-bezier(0.4, 0.0, 1.0, 1);       /* 退出 */
--ease-in-out:     cubic-bezier(0.4, 0.0, 0.2, 1);       /* 默认 */
--ease-spring:     cubic-bezier(0.2, 0.9, 0.2, 1);       /* 弹性 (lightbox 用) */
```

### 6.3 Transition 预设
```css
--transition-fast: 150ms cubic-bezier(0.4, 0, 0.2, 1);
--transition-base: 200ms cubic-bezier(0.4, 0, 0.2, 1);
--transition-slow: 300ms cubic-bezier(0.4, 0, 0.2, 1);
```

### 6.4 Keyframes（任务2 状态 pill 用）

**Breathing**（呼吸 — processing 状态主动画，替代旋转圈）：
```css
@keyframes breathing {
  0%, 100% { opacity: 1;   transform: scale(1); }
  50%      { opacity: 0.6; transform: scale(0.985); }
}
.pill-processing {
  animation: breathing var(--duration-pulse) var(--ease-in-out) infinite;
}
```

**Pulse-dot**（小圆点脉冲 — 语义上"活着"）：
```css
@keyframes pulse-dot {
  0%   { box-shadow: 0 0 0 0   rgba(20,110,245,0.45); }
  70%  { box-shadow: 0 0 0 6px rgba(20,110,245,0);    }
  100% { box-shadow: 0 0 0 0   rgba(20,110,245,0);    }
}
.pill-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: currentColor;
  animation: pulse-dot var(--duration-pulse) ease-out infinite;
}
```

**Fade-in**（状态切换 — pill 从上一状态 fade 到下一状态）：
```css
@keyframes fade-in {
  from { opacity: 0; transform: translateY(-2px); }
  to   { opacity: 1; transform: translateY(0); }
}
.pill-enter {
  animation: fade-in var(--duration-normal) var(--ease-out);
}
```

**显式反对**: 不用 `spin` 旋转圈（俗气 + 无语义）。用 breathing 或 dot-pulse。

---

## 7. Z-index 层级

### 7.1 推荐层级（从底到顶，100 步长避免密集冲突）

| Token | 值 | 用途 | 现状对照 |
|---|---|---|---|
| `--z-base`              | 0    | 常规流 | — |
| `--z-sticky`            | 50   | sticky 底栏 / 顶栏容器 | workspace.html:231/297/407 已用 40/50 ✅ |
| `--z-topbar`            | 100  | 页面主 topbar | 现有约定 100 ✅ |
| `--z-dropdown`          | 200  | 下拉菜单 / 选项列表 | — |
| `--z-toast`             | 300  | **任务2 toast 通知**（整批完成） | 新 |
| `--z-modal-backdrop`    | 400  | 模态遮罩 | — |
| `--z-modal`             | 500  | 常规模态 | estimateModal 250 建议调到 500 |
| `--z-tooltip`           | 600  | tooltip | — |
| `--z-lightbox`          | 700  | 预览大图 | 原生 dialog showModal 自动顶层 |
| `--z-critical-overlay`  | 9999 | 进度条阻塞性覆盖层 | progress_overlay 现用 9999 ✅ |

### 7.2 使用规则

- **新 UI 必须用这些 token**（不要硬编码 `z-index: 250`）
- **现有 `250/9998` 不强拆**，等下次动到对应组件时按上表重调
- **决不超过 9999**（Linux 某些浏览器 / 屏幕阅读器兼容性问题）

---

## 8. 任务2 Pill 组件（基于以上 tokens 的组合方案）

```css
/* 通用 pill 基础 */
.stage-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.02em;
  line-height: 1;
  transition: background var(--duration-normal) var(--ease-in-out),
              color var(--duration-normal) var(--ease-in-out);
  user-select: none;
}

/* 阶段色方案（processing 用 primary 的淡变体） */
.stage-pending   { color: var(--color-text-hint); background: var(--color-bg-subtle); border: 1px solid var(--color-border); }
.stage-processing { color: var(--color-primary); background: var(--color-primary-light); border: 1px solid var(--color-primary-border); animation: breathing var(--duration-pulse) var(--ease-in-out) infinite; }
.stage-done      { color: var(--color-success); background: var(--color-success-bg); border: 1px solid var(--color-success); }
.stage-failed    { color: var(--color-error); background: var(--color-error-bg); border: 1px solid var(--color-error); }
.stage-warning   { color: var(--color-warning); background: var(--color-warning-bg); border: 1px solid var(--color-warning); }
```

**阶段 emoji 映射**（通过 JS 或模板填充 span）：
- pending: `⏳`
- parsing: `🧠`
- cutting: `✂️`
- rendering: `🎨`
- capturing: `📸`
- done: `✅`
- failed: `❌`

所有 emoji 依赖 **`fonts-noto-color-emoji`**（铁律11 已装）。

---

## 9. 实现清单（任务2 执行时对照）

- [ ] 把上述 CSS 变量扩展加进 `static/css/design-system.css` `:root` 块（`--duration-pulse`, `--ease-spring`, `--z-*` 系列）
- [ ] 在 `static/css/design-system.css` 尾部加 `@keyframes breathing / pulse-dot / fade-in` 三个关键帧
- [ ] `templates/batch/upload.html` 新增 `.stage-pill` 及其状态 variant（用上述 tokens）
- [ ] 后端 `batch_processor.py` 在每个 stage print 后 `publish(batch_id, {type:'stage', item_id, stage, ts})`
- [ ] 前端 WS `type=stage` 事件处理器 → 更新 row `.stage-pill` className

---

## 10. 与铁律 11/13/14 的呼应

- **铁律 11**: Docker 镜像已装 CJK + Emoji 字体，本文档里的 emoji pill 在服务端 Playwright 和客户端浏览器都能正确渲染
- **铁律 13**: 若 pill 实现用 `<dialog>` 或其他原生控件，必须 `width + max-width` 同写
- **铁律 14**: 任何新 UI 改动必须 `getComputedStyle()` 证明，不靠 F12 Elements 裸看

---

**签收**: 此文档为任务2/任务3 的视觉契约。未经讨论不自造新 token。所有魔数必须先回这里找，找不到再扩。
