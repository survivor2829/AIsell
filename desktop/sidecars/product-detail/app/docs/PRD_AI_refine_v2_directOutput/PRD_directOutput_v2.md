# AI 精修 v2 · 详情页直出版 需求文档（v2 修订版）

> **生成日期**：2026-04-26  
> **版本**：v2（在 v1 基础上补 5 个洞）  
> **状态**：待执行（迭代护栏接手）  
> **前置背景**：纠偏 4/22-4/24 那次"6 张拼接不是详情页"的方向错误后的二次校准

---

## v2 修订说明（vs v1 改了什么）

| 修订点 | v1 状态 | v2 修订 |
|---|---|---|
| 屏型规划 | 没规定，DeepSeek 完全自由 | **第一版自由发挥 + YAML 屏型库 fallback 待命** |
| 画布尺寸 | "建议 1024×1536 或 1536×2048" 模糊 | **锁定 1536×2048（3:4 @ 2k 高清）** |
| 画质验收 | "比 H650Plus 更精美" 空话 | **盲测 + 4 项量化扣分** |
| 真测安全阀 | 直接 ¥5 全条 | **3 关阶梯：¥0.7 → ¥2.1 → ¥5** |
| DeepSeek prompt 能力 | 假设它能写 | **阶段一单独验证 + meta-prompt 兜底** |

---

## 一句话定义

**用 gpt-image-2 一张图直出一屏完整电商详情页，DeepSeek 动态规划 6-10 屏 + 风格 DNA，并发生图后纵向拼接，做"画质/排版/电影感全顶"的爆款详情页生成器。**

---

## 目标用户

- **直接用户**：清洁设备厂商运营/电商人员（玺联惠客户）
- **使用场景**：要在淘宝/拼多多/天猫上挂新品，需要一套**爆款级**详情页（不是日常款）
- **心理价位**：能接受 ¥7-10/条，几分钟出图，换"自己做要 2-3 天 + 设计师费用"
- **对比项**：v1 模板版（¥0.5/条、20 秒出图）已存在并保留，v2 是**爆款款产品线**

---

## 核心功能（必须实现）

### 1. DeepSeek 详情页编排器（含 prompt 工程师能力验证）

输入产品文案 + 产品图，输出：
- `style_dna`：这条详情页独有的视觉基调（色彩、光线、构图、情绪等）
- `screen_count`：6-10 屏（DeepSeek 自由决定）
- 每屏完整 prompt：包含统一的 style_dna 段落 + 该屏的具体内容描述

**关键约束**：DeepSeek 输出的每屏 prompt 必须是"导演视角"的自然语言描述，不是 keyword list。

**Meta-prompt 兜底机制**：在 DeepSeek 之上加一层指导性 prompt，明确告诉它"你是为 gpt-image-2 写 prompt 的提示词工程师，不是写 SEO 关键词的运营"。

### 2. 费用预估弹窗

DeepSeek 规划完成后，UI 弹窗给用户：
> "本次将生成 N 屏，预计 ¥X.X，预计 X 分钟，确认开始？"

用户确认才烧 gpt-image-2 的钱。点取消则停在规划阶段，DeepSeek 那次规划的钱已经花了（约 ¥0.01）但 gpt-image-2 没动。

### 3. gpt-image-2 并发直出 N 屏

- **画布尺寸**：固定 **1536×2048（3:4 @ 2k）**——单屏 ¥0.7
- **并发**：3 路并发（rate limit 安全值）
- **每屏内容**：图 + 文字 + 图标 + 卡片 一张图直出，不分层

### 4. PIL 纵向拼接长图

- 输入：N 张 1536×2048 PNG
- 输出：1 张 1536 × (2048×N) PNG（如 8 屏 → 1536×16384）
- **不再用 Playwright 渲染 HTML**，纯 PIL/Pillow 处理

### 5. 保留 v1 老路径不动

- v1"一键生成详情页"按钮 + Jinja2 + Playwright 完整保留
- 作为快+便宜款（¥0.5/20 秒），日常款产品线
- v2 与 v1 完全独立，互不影响

### 6. YAML 屏型库（fallback 机制，第一版默认不启用）

> ⚠️ **第一版走 C 真自由发挥，但屏型库要在阶段一就写好待命，默认不启用**

文件位置：`ai_refine_v2/screen_types.yaml`（不是代码硬编码，是配置文件）

内容范例：
```yaml
# screen_types.yaml — 屏型库，YAML 配置可后台编辑
# 默认不启用，仅当 DeepSeek 自由发挥跑废时启用
enabled: false  # 第一版默认 false

screen_types:
  - id: hero
    name: 首屏
    purpose: 抓眼球、立 slogan、产品主视觉
    
  - id: feature_wall
    name: 卖点墙
    purpose: 用图标矩阵呈现 N 个核心优势
    
  - id: vs_compare
    name: VS 对比
    purpose: 与竞品/旧款/人工对比，破除疑虑
    
  - id: scenario
    name: 应用场景
    purpose: 多宫格展示产品在不同场景下的使用
    
  - id: detail_zoom
    name: 细节特写
    purpose: 局部特写 + 标注，彰显工艺品质
    
  - id: spec_table
    name: 参数表
    purpose: 产品参数 + 尺寸图，专业背书
    
  - id: value_story
    name: 价值故事
    purpose: 用一组数据/场景讲产品带来的实际价值
    
  - id: brand_quality
    name: 品质工艺
    purpose: 多个细节图拼接，强调用料与工艺
```

**fallback 启用条件**（写进代码逻辑）：
- 真测 5-10 条详情页后人工评审
- 如果 DeepSeek 自由发挥的屏型组合"叙事节奏失控"（如 10 张全是 hero / 全是参数表）
- 改 `screen_types.yaml` 的 `enabled: true` 即可启用，不需要改代码

---

## 可选功能（后续迭代）

1. **风格参考图上传**：客户 UI 上传一张参考图 → DeepSeek 多模态识图翻译成 style_dna，覆盖自动生成版
2. **风格库 + DeepSeek 选择**：沉淀 5-10 种品牌级风格，DeepSeek 从库里选而不是凭空生成
3. **首屏锚图模式**：高级模式下首屏作为后续屏的图生图参考图，强制风格一致——但接受耗时翻倍
4. **品牌 logo 上传 UI**：客户传 logo PNG，程序在拼接阶段叠加水印（AI 不画 logo，避免品牌字失真）
5. **单屏重画**：客户对某一屏不满意，可只重画那一屏不重画整条
6. **客户自选屏数上限**：让客户在弹窗里手动调整 6/8/10 屏

---

## 明确排除（不做的事）

1. **不动 v1 任何代码**：refine_processor.py、v1 templates/、v1 那条管线全部冻结，v2 是独立产品线
2. **不让 gpt-image-2 画品牌 logo**：5%-10% 失真风险不接受，logo 走"客户提供 + 程序合成"路径
3. **不串行生图（第一版）**：选项 D 渐进式中明确"第一版走选项 A"——并发 3 路跑，不做首屏锚图依赖
4. **不在第一版做风格库**：DeepSeek 自由生成 style_dna，跑 50 条积累后再决定要不要
5. **不动 ai_refine_v2/ 已写的基础设施**：60 单测、ProxyHandler 绕代理、raw_url 救图、size guard、cost tracking 全部保留
6. **不做"屏数硬编码"任何变体**：6-10 是 DeepSeek 的输出范围，不是代码里的 if 分支
7. **不做客户上传参考图**：先验证自动生成够不够好，再决定要不要这个 UI
8. **第一版屏型库默认不启用**：只是 fallback 待命，不影响 DeepSeek 自由发挥

---

## 技术可行性备注（带条件和日期）

- **[2026-04-26]** 条件：gpt-image-2-official via APIMart，¥0.7/张 high 质量。**发现**：单图 ~46 秒；3 并发 + 间隔 2 秒不触发 429；总像素 ≤8.3M

- **[2026-04-26]** 条件：1536×2048 (3:4 @ 2k) 单屏。**发现**：是详情页放大看细节的最低可接受清晰度；单屏 ¥0.7；10 屏拼接长图为 1536×20480

- **[2026-04-26]** 条件：DeepSeek 通过 OpenAI 兼容协议调用。**发现**：deepseek-chat 模型支持结构化 JSON 输出；**未验证**：DeepSeek 写"导演视角"prompt 的能力（阶段一专项验证）

- **[2026-04-26]** 条件：APIMart 中转 gpt-image-2。**发现**：异步任务模式 (submit→poll)，task_id 轮询 3-5 秒一次，超时建议 ≥180 秒；APIMart 图片 URL 可能短时效（4/24 那次 5/5 都 403 推测是 token 过期，不是代理问题）

- **[2026-04-26]** 条件：风格 DNA 由 DeepSeek 自由生成。**风险标记**：DeepSeek 审美判断力未经验证，可能出现 style_dna 过于平庸（"现代简约科技感"这类无差别描述）。**应对**：跑 5-10 条真实产品后人工评审 style_dna 输出，不达标降级到风格库方案

- **[2026-04-26]** 条件：DeepSeek 自由决定屏型组合。**风险标记**：DeepSeek 没训练过"电商详情页商业叙事节奏"，可能出现 10 张全 hero 或全参数表。**应对**：跑 5-10 条后评审，叙事乱则启用 `screen_types.yaml` fallback

- **[2026-04-26]** 条件：6-10 屏并发生图。**预估成本**：¥4.2-7.0/条；**预估耗时**：3 并发下 3-5 分钟；客户确认弹窗必须在 DeepSeek 规划后、gpt-image-2 调用前

---

## 对接/依赖

- **DeepSeek API**：复用现有 `DEEPSEEK_API_KEY`（.env 配置）
- **APIMart gpt-image-2**：复用现有 `GPT_IMAGE_API_KEY`（.env 配置）；base_url `https://api.apimart.ai/v1`
- **Python PIL/Pillow**：替代 Playwright 做纵向拼接
- **保留依赖**：ai_refine_v2/ 现有的 ProxyHandler、raw_url 持久化、size guard、cost tracking 全部保留
- **可弃用**：v2 不再需要 Jinja2 + Playwright（v1 还在用，不卸载库）

---

## 用户流程

1. 客户在 workspace 页上传产品图 + 粘文案 + 填标题
2. 点 🎨 **AI精修（专业版）** 绿色按钮
3. UI 显示 "DeepSeek 正在为您规划详情页..." (~10 秒)
4. **弹窗**："本次将生成 8 屏，预计 ¥5.6，预计 4 分钟。是否继续？" → 客户点【确认】或【取消】
5. UI 显示进度条 "AI 精修中 1/8、2/8...8/8" (~3-5 分钟)
6. 完成后中央预览区显示**完整长图**（N 屏纵向拼接），上方显示 "AI 精修版 · N 屏 · XXXs · ¥X.XX"
7. 客户点【下载详情图】保存 PNG

---

## 三关阶梯式真测计划（核心安全阀）⭐

> 这是 v2 修订版最关键的新增内容——避免一次性烧 ¥5 测试翻车

### 第 1 关：单屏验证（成本上限 ¥0.7）

**做什么**：随便一个产品（用 DZ600M 现成的），让 DeepSeek 生成首屏 prompt，gpt-image-2 真出 1 张图。

**验证什么**：
- 文字有没有乱码（中文产品名、参数标注）
- 画质够不够"电影感"（光线、构图、产品质感）
- 1536×2048 这个尺寸够不够清晰

**通过标准**：单张图能用 → 进第 2 关
**翻车标准**：文字乱码或画质差 → **停止**，诊断是 prompt 不行还是 gpt-image-2 高估了

### 第 2 关：风格一致性验证（成本上限 ¥2.1）

**做什么**：让 DeepSeek 出 3 屏 prompt（hero + 2 个不同卖点屏），gpt-image-2 真出 3 张图。

**验证什么**：
- 3 张图的色调、光线、整体调性是否统一
- DeepSeek 写的 style_dna 段落能不能锚住风格
- 不同屏型（hero vs 卖点）的视觉差异是否合理

**通过标准**：3 张图风格统一 → 进第 3 关
**翻车标准**：风格跑偏 → **停止**，启动 style_dna meta-prompt 调优 + 重测第 2 关

### 第 3 关：完整链路验证（成本上限 ¥7）

**做什么**：DZ600M 完整跑通，DeepSeek 决定 6-10 屏，gpt-image-2 全跑，PIL 拼成长图。

**验证什么**：
- 完整长图的商业叙事节奏（屏型组合是否合理）
- 详情页放大看细节是否清晰
- 总耗时和总成本符合预估

**通过标准**：长图能直接交付客户 → MVP 完成
**翻车标准**：屏型组合乱（10 张全 hero）→ 启用 `screen_types.yaml` fallback；其他问题视情况

---

## 验收标准

### 第一版 MVP 验收

#### 客观指标（量化）

- [ ] **第 1 关通过**：单屏画质合格，¥0.7 烧出可用图
- [ ] **第 2 关通过**：3 屏风格统一，¥2.1 烧出风格 DNA 锚定
- [ ] **第 3 关通过**：完整长图可交付，单条总成本 ≤¥7、总耗时 ≤8 分钟
- [ ] **mock 模式仍能跑**：缺 key 时进 mock 模式，便于无成本调试
- [ ] **失败响亮**：任意一屏失败 → 整条 status=failed + 红字明示哪屏挂了 + raw_urls 已存
- [ ] **v1 完全不受影响**：v2 上线后，v1 的"一键生成详情页"按钮仍然 ¥0.5/20 秒正常工作

#### 主观指标（盲测 + 4 项量化扣分）⭐ 核心

**盲测方法**：
1. 找 5 个同事（清洁行业相关最好，不相关也可）
2. 给他们看 v2 详情页 vs H650Plus 详情页（不告诉哪个是 AI 生成）
3. 问"哪个更专业、更想买"

**通过标准**：5 人中至少 3 人选 v2 → 通过

**4 项量化扣分项**（任一项不达标都不算通过）：
- [ ] **无文字乱码**：所有屏的中文、英文、数字都准确无错字
- [ ] **无肢体畸形**：如果出现人物，手部、面部、身体比例正常（gpt-image-2 这点应该不是问题，但要验证）
- [ ] **无品牌错乱**：没有出现错误的品牌字样（"坦虎"不能写成"坦户"）
- [ ] **风格统一**：N 屏的色调、光线、整体调性一致，不出现首屏冷蓝、第 5 屏暖橙

### 业务级验收（跑 5-10 条真实产品后判断）

- [ ] **DeepSeek 的 style_dna 输出质量**：人工评审 5-10 条不同产品的 style_dna，是否每条都有针对性、不平庸 → 不达标启动风格库升级
- [ ] **DeepSeek 屏型组合质量**：评审屏型组合是否合理 → 不达标启用 `screen_types.yaml` fallback
- [ ] **客户审美接受度**：拿 v2 详情页给 2-3 个真实清洁设备客户看，"愿不愿意为这个画质付 ¥7-10/条"

---

## 任务拆解（迭代护栏接手）

### 阶段一 · planner 改造 + prompt 工程师能力验证

**任务 1.1**：改造 DeepSeek prompt
- 输出 style_dna + N 屏 prompt 序列
- 加 meta-prompt：明确告诉 DeepSeek"导演视角写 prompt"
- 输出 JSON 结构定义清楚

**任务 1.2**：写 `screen_types.yaml`
- 8 种屏型描述写好
- `enabled: false` 默认不启用
- 加配置加载逻辑（不在第一版调用，但代码框架要建好）

**任务 1.3**：人工评审 DeepSeek 输出（不烧 gpt-image-2）
- 跑 3 个真实产品（DZ600M、H650Plus、随便一个简单产品）
- 看 DeepSeek 输出的每屏 prompt 是不是"导演视角"
- 看 style_dna 是不是有针对性、不平庸
- 不达标 → 调 meta-prompt 重跑

### 阶段二 · generator 改造（mock 验证）

**任务 2.1**：refine_generator 改成"调 gpt-image-2 直出整屏"
- 不再画背景换装
- 1536×2048 high 质量
- 保留 ProxyHandler、raw_url、size guard 这些基础设施

**任务 2.2**：mock 模式覆盖
- 缺 key 时仍能进 mock 模式
- mock 模式用本地占位图（继承 4/26 那次跑通的逻辑）

### 阶段三 · assembler 替换

**任务 3.1**：从 Playwright HTML 渲染改为 PIL 纵向拼接
- 输入 N 张 PNG，输出 1 张长图
- 单元测试：6 张 mock 图能拼出完整长图

### 阶段四 · 弹窗集成

**任务 4.1**：DeepSeek 规划完先返回预估
**任务 4.2**：前端弹窗确认才继续
**任务 4.3**：UI 真测，确认弹窗逻辑

### 阶段五 · 三关阶梯式真测 ⭐

> 每关之间必须停下问 Scott，不许直接连续烧

**第 1 关**：¥0.7 单屏 → Scott 验证 → 通过才进第 2 关
**第 2 关**：¥2.1 三屏 → Scott 验证 → 通过才进第 3 关
**第 3 关**：¥5-7 完整 → Scott 验证 → MVP 完成

### 阶段六 · 业务级验收

**任务 6.1**：跑 5-10 条不同产品
**任务 6.2**：人工评审 style_dna 和屏型组合质量
**任务 6.3**：决定是否启用 `screen_types.yaml` fallback

---

## 关键护栏（不准让 Claude Code 越界的事）

1. **绝对不动 ai_refine_v2/ 已有 60 单测覆盖的部分**——pipeline_runner 三段式架构、ProxyHandler、raw_urls、size guard、cost tracking 全保留
2. **绝对不动 v1**——refine_processor.py、v1 templates/ 完全冻结
3. **每次真调 gpt-image-2 前必须问 Scott**——预算控制
4. **修两次同一个 bug 没修对就停下重新诊断**——铁律
5. **mock 模式必须始终可用**——任何阶段都允许在缺 key 时进 mock，便于无成本调试
6. **三关阶梯不许跳关**——必须 ¥0.7 → ¥2.1 → ¥5 顺序，每关 Scott 验证才进下一关
7. **`screen_types.yaml` 第一版默认 `enabled: false`**——第一版必须真自由发挥，不许偷偷启用 fallback

---

## 一份诚实的总结

这个 PRD 的本质：**砍掉 4/22-4/24 写的 generator 内部逻辑（画背景换装那部分），保留 60 单测保护的基础设施层，换上"AI 直出整屏 + DeepSeek 风格 DNA + PIL 拼接 + 三关阶梯真测"的新内核。**

改动量预估：
- generator 模块约 **60% 重写**
- planner **改 prompt + 加 meta-prompt + 输出 style_dna**
- assembler **整个换实现**（Playwright → PIL）
- 新增 `screen_types.yaml`（fallback 待命）

代码量预估：1-2 个工作日完成阶段一到阶段四，阶段五真测要看运气。

**最大未验证假设**：DeepSeek 写 gpt-image-2 prompt 的能力。阶段一会单独验证，不达标就加 meta-prompt 兜底。

**最大成本风险**：阶段五三关阶梯，最坏总烧 ~¥10（0.7 + 2.1 + 7），但每关失败就停，不会一口气烧光。

---

## 关键文件位置（执行时落到这里）

- **PRD（这份）**：`docs/PRD_AI_refine_v2_directOutput/PRD_directOutput_v2.md`
- **决策日志**：`docs/PRD_AI_refine_v2_directOutput/DECISION_LOG.md`
- **屏型库 fallback**：`ai_refine_v2/screen_types.yaml`
- **新版 planner prompt**：`ai_refine_v2/refine_planner.py`（保留单测，改 prompt 模板）
- **新版 generator**：`ai_refine_v2/refine_generator.py`（保留 ProxyHandler 等基础设施，重写整屏直出逻辑）
- **新版 assembler**：`ai_refine_v2/refine_assembler.py`（新建，PIL 拼接）
- **真测脚本**：`scripts/real_test_step1.py` / `step2.py` / `step3.py`（三关阶梯专用）
