# AI生图双引擎 — 需求文档 + 执行指令

> 生成日期：2026-04-13
> 状态：初版

## 一句话定义
HTML渲染保证文字和排版准确 → AI生图重绘背景提升视觉品质，同时接入通义万相和豆包两个引擎，用户可选。

## 核心工作流
```
用户上传产品图 + 粘贴文案
        ↓
   AI解析产品参数（DeepSeek，已有）
        ↓
   HTML模板渲染详情页（Playwright截图，已有）
        ↓
   ┌────────────────────┐
   │  AI整屏精修（新增）  │
   │                    │
   │  HTML截图 作为构图参考 │
   │  + 产品抠图          │
   │  + AI生成精美背景     │
   │  + Pillow合成最终图   │
   └────────────────────┘
        ↓
   输出：设计师级精美详情页
```

## 整屏精修的具体逻辑

每一屏的精修流程：

1. **HTML渲染截图** — 得到一张有准确文字和排版的基础图（已有）
2. **提取该屏的文字内容和产品图位置** — 从渲染数据中获取
3. **AI生成背景图** — 用提示词描述该屏需要的背景氛围（如"工厂车间环境，明亮干净，浅蓝灰色调"），不含任何文字
4. **Pillow合成** — 把AI背景 + 产品抠图 + 文字（用中文字体精确渲染）合成为最终图片
5. **输出** — 替换原来的HTML截图

这样做的好处：
- AI只负责背景和氛围，不需要生成文字（避免AI文字乱码问题）
- 文字用Pillow精确渲染，字号、位置、颜色完全可控
- 产品图是用户真实上传的，不会被AI篡改

---

## 双引擎注册指南

### 引擎1：通义万相（阿里云 DashScope）

Claude Code已经接入了dashscope SDK，API Key可能已经配置。如果没有：

1. 访问 https://dashscope.console.aliyun.com
2. 用支付宝或阿里云账号登录
3. 点"开通DashScope服务"（免费）
4. 左侧菜单 → "API-KEY管理" → "创建新的API-KEY"
5. 复制Key，格式为 sk-xxxxxxxx

免费额度：新用户送100次图像生成调用
推荐模型：wanx-v2（文生图）或 wanx2.1-t2i（最新版）
每张图成本：约0.04-0.08元

环境变量名：DASHSCOPE_API_KEY

### 引擎2：豆包 Seedream（字节跳动 火山引擎）

1. 访问 https://console.volcengine.com
2. 手机号注册 → 实名认证（个人即可）
3. 搜索"豆包大模型" → 开通
4. 左侧菜单 → "API访问密钥" → 创建密钥（Access Key ID + Secret Access Key）
5. 在"模型推理"中找到 Seedream 4.0 的 endpoint ID

免费额度：新用户有一定的免费token额度
推荐模型：seedream-4.0（画质最强）
每张图成本：约0.08-0.16元

环境变量名：VOLCENGINE_AK 和 VOLCENGINE_SK

---

## Claude Code 执行指令

### 使用 Agent Teams 并行开发

在Claude Code中输入以下指令：

```
创建一个 Agent Team，2个 teammate 并行开发AI生图双引擎：

Teammate 1 — 通义万相引擎（深化现有代码）：
1. 检查现有的 ai_image.py，确认 dashscope SDK 已正确接入
2. 优化生图 prompt 模板，针对每种屏幕类型设计不同的背景描述：
   - 英雄屏：大气的商业场景背景（商场/工厂/酒店大堂），光线明亮
   - 优势屏：简洁的渐变色或纹理背景，不抢产品焦点
   - 参数屏：科技感背景，深色调，适合放白色文字
   - VS对比屏：分屏背景，左侧明亮右侧暗沉
   - 场景屏：对应场景的真实环境照片
3. 实现 generate_background(screen_type, product_info, style) 函数
4. 用 wanx2.1-t2i 模型，分辨率设为 750x 对应高度
5. 测试：用一个真实产品生成5种不同屏幕的背景图，保存到 output/test_wanxiang/

Teammate 2 — 豆包 Seedream 引擎（新建）：
1. 安装火山引擎SDK：pip install volcengine-python-sdk --break-system-packages
2. 新建 ai_image_volcengine.py，实现和 ai_image.py 相同的接口
3. 实现 generate_background(screen_type, product_info, style) 函数
4. 用 seedream-4.0 模型
5. 注意：火山引擎的API格式和阿里云不同，需要查文档适配
6. 测试：用同一个产品生成5种背景图，保存到 output/test_seedream/

两个 teammate 完成后，由 team lead 负责：
1. 创建 ai_image_router.py 统一路由层，接口：
   generate_background(engine="wanxiang"|"seedream", screen_type, product_info, style)
2. 在 workspace.html 的 AI生图区域加一个引擎选择下拉框（通义万相 / 豆包）
3. 对比两个引擎的测试输出，生成对比报告
```

### Prompt 模板设计原则

每个屏幕类型的AI生图prompt必须遵守：

1. **只描述背景，不描述产品本身** — 产品图由Pillow合成叠加
2. **不要求AI写任何文字** — 文字由Pillow用字体文件渲染
3. **描述光影方向** — 确保和产品图的光影一致（通常从左上方打光）
4. **指定色调** — 和当前选中的主题色协调
5. **指定用途** — "电商产品详情页背景，专业商业摄影风格"

示例prompt模板：

英雄屏背景：
```
高端电商产品展示背景，{场景描述}，
光线从左上方照射，明亮通透，
浅{主题色}渐变色调，地面有轻微反光，
专业商业摄影风格，无文字无人物无产品，
只有纯净的环境背景，4K高清
```

参数屏背景：
```
深色科技感背景，{主题色}为主色调，
几何线条装饰，微弱的光点散景效果，
适合放置白色文字的暗色底图，
专业简约风格，无文字，4K高清
```

### Pillow 合成器优化

现有的 image_composer.py 需要增强，支持整屏合成：

```python
def compose_detail_screen(
    background_image,      # AI生成的背景图路径
    product_image,         # 产品抠图路径
    text_elements,         # 文字列表 [{text, x, y, font_size, color, font_weight}, ...]
    product_position,      # 产品图位置 {x, y, width, height}
    output_path,           # 输出路径
    width=750,             # 输出宽度
):
    """
    合成一屏详情页：
    1. 加载AI背景图，缩放到目标尺寸
    2. 叠加产品抠图到指定位置
    3. 用中文字体逐行渲染文字
    4. 保存最终图片
    """
```

文字渲染要求：
- 使用 Microsoft YaHei Bold（C:/Windows/Fonts/msyhbd.ttc）作为标题字体
- 使用 Microsoft YaHei（C:/Windows/Fonts/msyh.ttc）作为正文字体
- 支持文字阴影（给深色背景上的白色文字加轻微黑色阴影提升可读性）
- 支持文字描边（可选）

### 前端交互

在 workspace.html 中，生成完HTML预览后，增加一个"AI精修"按钮：

```
[✨ AI精修（高品质）]  引擎：[通义万相 ▼]
```

点击后：
1. 显示进度条："正在生成AI背景... (1/5)"
2. 逐屏调用AI生图 → Pillow合成
3. 完成后在预览区显示精修后的图片（替换HTML截图）
4. 用户可以切换查看"HTML原版"和"AI精修版"对比

### API端点

```python
@app.route('/api/build/<product_type>/generate-ai-detail', methods=['POST'])
@login_required
@csrf.exempt
def generate_ai_detail(product_type):
    """
    对整套详情页进行AI精修。
    
    请求体：
    {
      "parsed_data": { ... },
      "product_image": "/static/uploads/...",
      "scene_image": "",
      "theme_id": "classic-red",
      "engine": "wanxiang" | "seedream",
      "screens_to_refine": ["hero", "advantages", "params", "vs", "brand"]
    }
    
    返回：
    {
      "refined_images": [
        {"screen_id": "hero", "url": "/static/outputs/xxx/hero_refined.png"},
        {"screen_id": "advantages", "url": "/static/outputs/xxx/adv_refined.png"},
        ...
      ]
    }
    """
```

---

## 验收标准
- [ ] 通义万相引擎：能生成5种屏幕类型的背景图
- [ ] 豆包引擎：能生成5种屏幕类型的背景图
- [ ] 引擎路由层：统一接口，可切换引擎
- [ ] Pillow合成器：能把AI背景+产品图+中文文字合成最终图
- [ ] 前端有引擎选择下拉框和AI精修按钮
- [ ] 文字渲染清晰准确，无乱码
- [ ] 产品图位置和大小正确
- [ ] 两个引擎的测试对比截图保存在 output/

## 明确排除
- 不做AI生成产品细节图（如电池特写、水箱内部），这些需要用户上传真实照片
- 不做AI生成文字（所有文字都用Pillow字体渲染）
- 不做视频生成
- 不改现有的HTML渲染流程（AI精修是额外选项，HTML版本保留）

## 环境变量（在 .env 中配置）
```
# 通义万相（阿里云DashScope）
DASHSCOPE_API_KEY=sk-你的key

# 豆包（字节火山引擎）
VOLCENGINE_AK=你的AccessKeyID
VOLCENGINE_SK=你的SecretAccessKey
```
