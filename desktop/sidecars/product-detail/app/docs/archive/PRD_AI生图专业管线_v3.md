# 小玺AI · AI生图专业管线 需求文档

> 生成日期：2026-04-14
> 状态：初版
> 前置文档：电商AI生图技术全景研究报告

## 一句话定义
对标黑米AI，用"抠图→AI场景背景生成→产品原图合成→HTML/CSS文字排版→Playwright截图"的分层管线，生成专业设计师级电商产品详情页。

## 目标用户
公司内部运营人员，上传产品白底图+粘贴文案，一键生成可直接上架的精美详情页长图。

---

## 核心技术路线

```
用户上传产品白底图 + 粘贴产品文案
        ↓
  ┌─────────────────────┐
  │ 1. AI解析产品参数     │ ← DeepSeek（已有）
  └─────────────────────┘
        ↓
  ┌─────────────────────┐
  │ 2. 产品抠图           │ ← rembg/BiRefNet
  │    输出：透明底PNG     │    产品像素不被AI触碰
  └─────────────────────┘
        ↓
  ┌─────────────────────┐
  │ 3. AI场景背景生成      │ ← 豆包 Seedream 4.0
  │    每屏独立生成背景     │    专业prompt模板库（已有）
  │    产品不在背景图中     │    背景预留产品和文字空间
  └─────────────────────┘
        ↓
  ┌─────────────────────┐
  │ 4. HTML/CSS分层合成    │ ← 新的核心模块
  │                      │
  │  AI背景 → background-image
  │  产品抠图 → <img> 绝对定位 + drop-shadow
  │  文字排版 → CSS精确控制字号/间距/颜色
  │  装饰元素 → CSS渐变/图标/分割线
  │                      │
  │  每屏一个独立HTML页面   │
  └─────────────────────┘
        ↓
  ┌─────────────────────┐
  │ 5. Playwright截图     │ ← 已有能力
  │    每屏截图 750px宽    │
  │    拼接成完整长图       │
  └─────────────────────┘
        ↓
  ┌─────────────────────┐
  │ 6. 光影融合（可选）    │ ← Seedream img2img
  │    denoising ≤ 0.25   │    只调光影不改外观
  │    输出"安全版"+"融合版"│    用户对比选择
  └─────────────────────┘
        ↓
  输出：专业设计师级详情页长图
```

## 与现有流程的关系

```
现有流程（保留）：
  产品数据 → HTML模板渲染 → Playwright截图 → 基础版详情页
  ✅ 免费、速度快、文字准确
  ❌ 视觉效果一般，模板感强

AI精修流程（新增）：
  产品数据 → 抠图 + AI背景生成 → HTML/CSS分层合成 → Playwright截图 → 专业版详情页
  ✅ 视觉品质对标黑米AI
  ❌ 需要API费用，生成时间较长（约60-90秒）

用户在workspace界面可以选择：
  [⚡ 快速生成（HTML模板）]  [✨ AI精修（专业版）]
```

---

## 核心功能（必须实现）

### F1. 产品抠图模块
- 输入：用户上传的产品图（白底或任意背景）
- 输出：透明底PNG
- 技术：rembg（已集成）或 BiRefNet
- 要求：边缘干净，无白边残留
- 抠图结果缓存，同一产品不重复抠

### F1.5 光影融合后处理（可选步骤）
- 在HTML合成+Playwright截图之后，额外执行一次**低重绘幅度的图生图**
- 目的：让产品的光影、反射、环境色和AI背景自然融合，消除"贴上去"的感觉
- 技术参数：Seedream img2img，denoising_strength = 0.15~0.25（极低，只改光影不改外观）
- 安全机制：
  - 重绘幅度硬限制不超过0.3，超过会导致产品变形
  - 同时提供"融合前"和"融合后"两个版本供用户对比选择
  - prompt中强制包含 "preserve exact product shape and details, only harmonize lighting and reflections"
  - negative prompt 包含 "deformed product, changed proportions, altered labels, modified logo"
- 前端交互：AI精修完成后显示两个标签页 [安全版（原图合成）] [融合版（光影优化）]
- 默认显示安全版，用户可以切换查看融合版效果再决定用哪个

### F2. AI场景背景生成（已有，需优化）
- 引擎：豆包 Seedream 4.0（默认）
- 每屏独立生成，使用 prompt_templates.py 的专业模板
- 背景图尺寸：750 × 对应屏幕高度
- 背景中**不包含产品、不包含文字**
- 背景预留产品放置区域和文字排版区域（通过prompt的composition维度控制）
- 相邻屏背景色调自然过渡（通过prompt的过渡提示控制）

### F3. HTML/CSS分层合成模板（核心新增）
- 替代Pillow合成，用HTML+CSS实现专业排版
- 每种屏幕类型（hero/advantages/specs/vs/scene/brand/cta）有独立的HTML合成模板
- 模板结构：

```html
<!-- 每屏的合成模板示例：hero屏 -->
<div class="screen hero" style="
  width: 750px;
  height: 1000px;
  background-image: url('ai_bg_hero.png');
  background-size: cover;
  position: relative;
">
  <!-- 产品图层 -->
  <img src="product_cutout.png" style="
    position: absolute;
    bottom: 10%;
    left: 50%;
    transform: translateX(-50%);
    width: 60%;
    filter: drop-shadow(0 20px 40px rgba(0,0,0,0.3));
  "/>

  <!-- 文字层 -->
  <div class="title" style="
    position: absolute;
    top: 8%;
    width: 100%;
    text-align: center;
    font-size: 48px;
    font-weight: 700;
    color: white;
    text-shadow: 0 2px 8px rgba(0,0,0,0.5);
    font-family: 'Microsoft YaHei', sans-serif;
  ">DZ50X</div>

  <div class="subtitle" style="...">
    驾驶式洗地机 · 高效清洁专家
  </div>

  <!-- KPI指标条 -->
  <div class="kpi-bar" style="
    position: absolute;
    bottom: 0;
    width: 100%;
    display: flex;
    background: rgba(255,255,255,0.95);
    backdrop-filter: blur(10px);
  ">
    <div class="kpi-item">3600㎡/h<span>清洗效率</span></div>
    <div class="kpi-item">850mm<span>清洗宽度</span></div>
    ...
  </div>
</div>
```

- 每种屏幕模板需要设计以下元素的CSS：
  - 产品图的位置、大小、阴影效果
  - 标题/副标题的字号、颜色、阴影
  - 卖点/参数的排版布局（卡片式、两列式等）
  - 装饰元素（渐变遮罩、半透明卡片、图标等）
  - 所有颜色使用CSS变量，支持主题切换

### F4. Playwright截图 + 长图拼接
- 对每屏的合成HTML页面用Playwright截图
- 截图宽度固定750px
- 所有屏幕截图纵向拼接成一张完整长图
- 相邻屏之间无缝衔接（背景过渡由AI背景+CSS渐变遮罩保证）

### F5. 前端交互
- workspace.html 现有的 [✨ AI精修] 按钮保留
- 点击后显示进度：
  ```
  正在抠图... (1/5)
  正在生成AI背景... (2/5)
  正在合成hero屏... (3/5)
  正在合成优势屏... (4/5)
  正在拼接长图... (5/5)
  ```
- 完成后在预览区显示AI精修版
- 支持"HTML原版"和"AI精修版"切换对比
- 引擎选择下拉框保留（默认Seedream）

---

## 可选功能（后续迭代）

1. **细节特写图生成** — VLM识别产品部件 → 裁切 → AI超分放大
2. **AI直接生成带文字的图** — 等Seedream中文渲染能力更成熟后尝试
3. **ComfyUI工作流集成** — 需要GPU服务器，作为高级部署选项
4. **IC-Light产品重照明** — 让产品光影和AI背景完全一致
5. **多产品对比图** — 同一背景放两个产品做对比
6. **视频生成** — 从详情页图片生成短视频

---

## 明确排除（不做的事）

1. **不用高重绘幅度处理产品图** — 光影融合的重绘幅度硬限制≤0.3，防止产品变形
2. **不用Pillow做最终合成** — 全部改用HTML/CSS + Playwright
3. **不做AI直接生成文字** — 文字100%由HTML/CSS渲染
4. **不做细节特写图（本期）** — 后续迭代
5. **不部署ComfyUI（本期）** — 先用API方案跑通

---

## 七种屏幕的合成模板设计规范

### 1. Hero英雄屏（1000px高）
- 布局：产品居中偏下，标题顶部居中，KPI指标条底部
- 产品图：占画面宽度50-60%，带强投影
- 文字：大标题48px加粗 + 副标题24px + KPI条

### 2. Advantages优势屏（900px高）
- 布局：标题顶部 + 2列×3行卖点卡片
- 每个卖点：图标 + 标题 + 一行描述
- 卡片：半透明白底圆角卡片，backdrop-filter模糊
- 无产品图

### 3. Specs参数屏（800px高）
- 布局：标题 + 产品图左侧 + 参数列表右侧
- 参数：标签+数值的两列表格布局
- 深色背景 + 白色文字 + 半透明分割线

### 4. VS对比屏（900px高）
- 布局：左右分栏，左侧"传统人工"右侧"我们的设备"
- 中间分割线 + VS标志
- 左侧灰暗色调，右侧品牌色调
- 对比项：效率/成本/效果等3-5项

### 5. Scene场景屏（800px高）
- 布局：场景标题 + 场景图片网格（2×2或3列）
- 每个场景：场景名+小图
- 场景图可以是用户上传或AI生成的场景照片

### 6. Brand品牌屏（700px高）
- 布局：品牌logo + 品牌名 + 品牌故事一句话 + 资质图标
- 深色大气背景，金色或品牌色点缀

### 7. CTA行动屏（500px高）
- 布局：产品小图 + 一句话号召 + 联系方式/二维码
- 品牌色渐变背景，最有视觉冲击力的一屏

---

## 对接/依赖

- **豆包 Seedream 4.0 API**（ARK_API_KEY，已配置）
- **DeepSeek API**（产品参数解析，已有）
- **rembg**（产品抠图，已集成）
- **Playwright + Chromium**（截图，已有）
- **中文字体**：Microsoft YaHei Bold（标题）、Microsoft YaHei（正文）

## 环境变量
```
ARK_API_KEY=你的火山方舟key（已有）
DEEPSEEK_API_KEY=你的key（已有）
```

---

## 验收标准

- [ ] 上传一张洗地机白底图 + 粘贴文案，能一键生成5屏以上的AI精修详情页
- [ ] 安全版：产品图清晰无变形，和原图完全一致
- [ ] 融合版：产品光影和背景自然一致，产品外观不变形
- [ ] 用户可以在安全版和融合版之间切换对比
- [ ] 文字100%准确可读，排版有设计感
- [ ] 每屏背景精美，有专业摄影质感
- [ ] 相邻屏之间视觉过渡自然
- [ ] 整体效果接近专业电商设计师水准
- [ ] 生成时间控制在120秒以内
- [ ] 现有HTML模板渲染流程不受影响

---

## 用户流程

1. 用户打开workspace → 上传产品白底图 + 粘贴文案
2. 点击[⚡ 快速生成] → 走现有HTML模板流程（秒出）
3. 点击[✨ AI精修] → 进度条显示各步骤状态
4. 60-120秒后 → 预览区显示AI精修版详情页
5. 用户可切换对比"HTML版"和"AI精修版"
6. 确认后点击导出 → 下载750px宽的长图PNG

---

## 给 Claude Code 的执行路径

### 阶段一：AI背景 + HTML合成模板（3-4轮）
1. 创建 `templates/ai_compose/` 目录，放7种屏幕的HTML合成模板
2. 每个模板用CSS变量控制主题色，AI背景作为background-image
3. 产品抠图用`<img>`绝对定位 + drop-shadow
4. 文字用CSS精确排版
5. 用一个真实洗地机测试hero屏合成效果

### 阶段二：Playwright截图 + 拼接（2轮）
1. 写截图函数：对每屏HTML合成页面用Playwright截图
2. 拼接所有屏幕截图为一张长图
3. 测试完整5屏输出

### 阶段三：API端点 + 前端集成（2-3轮）
1. 新建或改造 `/api/generate-ai-detail` 端点
2. 串联：抠图 → AI背景生成 → 填充HTML模板 → Playwright截图 → 拼接
3. workspace.html 的 AI精修 按钮对接新端点
4. 进度条实时显示

### 阶段三.5：光影融合后处理（1-2轮）
1. 对拼接后的每屏截图，调用Seedream img2img（denoising=0.2）做光影融合
2. 同时输出"安全版"和"融合版"
3. 前端加两个标签页切换对比
4. 用真实产品测试，确认产品外观不变形

### 阶段四：样式精修 + 四品类适配（2-3轮）
1. 用黑米AI的设计规范（已提取到himiai-clone/docs/research/）精修CSS
2. 适配四大品类：设备/耗材/工具/配件的差异化模板
3. 多产品测试，调优prompt和排版
