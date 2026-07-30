# AI生图补充：整体无缝详情页方案

## 用户需求
不要一块一块拼接的效果，要整张详情页像一幅完整的设计作品，模块之间无缝过渡，看不出是分块拼的。

## 实现方案：分段生成 + 统一色调 + 过渡融合

### 核心思路

不是逐块单独生成背景，而是：

1. 先规划整张详情页的**色调流**（从上到下的颜色变化节奏）
2. AI分段生成背景，但每段的prompt都包含上下段的色调信息，保证衔接
3. 相邻段的交界处用渐变融合，消除拼接痕迹
4. 最后在连续背景上叠加产品图和文字

### 第一步：设计"色调流"模板

每套主题定义一个从上到下的色调变化规划，例如：

```python
THEME_COLOR_FLOWS = {
    "classic-red": {
        "flow": [
            {"zone": "hero",       "bg_tone": "深蓝灰渐变到浅灰，大气商业氛围", "transition_to_next": "渐变到白色"},
            {"zone": "advantages", "bg_tone": "白色到极浅蓝灰", "transition_to_next": "渐变到浅暖灰"},
            {"zone": "story",      "bg_tone": "浅暖灰，柔和自然光", "transition_to_next": "渐变到深色"},
            {"zone": "specs",      "bg_tone": "深蓝灰，科技质感", "transition_to_next": "渐变到白色"},
            {"zone": "vs",         "bg_tone": "白色到浅灰", "transition_to_next": "渐变到品牌红"},
            {"zone": "cta",        "bg_tone": "品牌红渐变", "transition_to_next": "无"},
        ]
    },
    "tech-blue": {
        "flow": [
            {"zone": "hero",       "bg_tone": "深海蓝渐变，星光点缀", "transition_to_next": "渐变到浅蓝白"},
            {"zone": "advantages", "bg_tone": "浅蓝白，清新干净", "transition_to_next": "渐变到中蓝灰"},
            ...
        ]
    }
}
```

### 第二步：分段生成但带上下文

每段背景生成时，prompt包含3个信息：

```python
def build_segment_prompt(current_zone, prev_zone, next_zone, theme_flow):
    """
    生成单段背景的prompt，但包含上下段的色调信息，
    确保衔接自然。
    """
    current = theme_flow[current_zone]
    
    prompt = f"""
电商产品详情页背景的一个片段，专业商业设计风格。
这是一张连续长图的中间部分。

当前区域：{current['bg_tone']}

上方区域（需要从这个色调过渡过来）：{prev_zone['bg_tone'] if prev_zone else '无，这是顶部'}
下方区域（需要向这个色调过渡）：{next_zone['bg_tone'] if next_zone else '无，这是底部'}

要求：
- 顶部边缘的颜色要能和上方区域自然衔接
- 底部边缘的颜色要能向下方区域自然过渡
- 中间是当前区域的主体氛围
- 不要任何文字、产品、人物
- 纯背景氛围图，适合在上面叠加内容
- 尺寸 750像素宽
- 4K高清，专业商业摄影质感
"""
    return prompt
```

### 第三步：Pillow渐变融合

相邻两段背景在交界处有80-120像素的重叠区域，用alpha渐变混合：

```python
from PIL import Image, ImageFilter
import numpy as np

def blend_segments(top_img, bottom_img, overlap_px=100):
    """
    将两段背景图在交界处用渐变alpha混合，
    消除拼接痕迹。
    """
    top_arr = np.array(top_img)
    bottom_arr = np.array(bottom_img)
    
    # top_img的底部 overlap_px 像素 和 bottom_img的顶部 overlap_px 像素 融合
    # 创建线性渐变alpha蒙版
    alpha = np.linspace(1, 0, overlap_px).reshape(-1, 1, 1)
    
    # 融合区域
    top_overlap = top_arr[-overlap_px:].astype(float)
    bottom_overlap = bottom_arr[:overlap_px].astype(float)
    blended = (top_overlap * alpha + bottom_overlap * (1 - alpha)).astype(np.uint8)
    
    # 组装最终图片
    result = np.vstack([
        top_arr[:-overlap_px],   # top的非重叠部分
        blended,                  # 融合区域
        bottom_arr[overlap_px:]   # bottom的非重叠部分
    ])
    
    return Image.fromarray(result)

def compose_full_page(segment_images):
    """
    将所有段的背景图融合成一张无缝长图。
    """
    if not segment_images:
        return None
    
    result = segment_images[0]
    for next_seg in segment_images[1:]:
        result = blend_segments(result, next_seg, overlap_px=100)
    
    return result
```

### 第四步：在连续背景上合成内容

背景融合成一张连续长图后，用Pillow逐层叠加：

```python
def compose_final_detail_page(
    seamless_background,    # 融合后的连续背景长图
    product_images,         # [{image, x, y, width, height}, ...]
    text_elements,          # [{text, x, y, font_size, color, font_weight}, ...]
    decorations,            # [{type, x, y, params}, ...] 分割线、图标等
    output_path
):
    """
    在无缝背景上叠加所有内容元素，输出最终图片。
    
    叠加顺序：
    1. 背景（最底层）
    2. 装饰元素（分割线、色块、渐变条等）
    3. 产品图（带阴影）
    4. 文字（最上层）
    """
```

### 第五步：装饰元素让模块有节奏感

虽然背景是连续的，但模块之间需要视觉节奏，不能糊成一片。
用Pillow绘制轻微的装饰分隔（不是硬边线），例如：

- 极细的渐变分割线（1px, 透明度30%）
- 模块标题前的小色块装饰
- 浅色的矩形卡片底（圆角，带微弱阴影，让内容浮在背景上）

这些装饰让内容有层次，但不会打破背景的连续感。

---

## 整体流程汇总

```
用户上传产品图 + 粘贴文案
        ↓
AI解析产品参数 + 生成文案（DeepSeek）
        ↓
确定模块组合和顺序 + 每个模块的内容数据
        ↓
根据主题的"色调流"，分段生成AI背景（通义万相/豆包）
        ↓
Pillow渐变融合所有背景段 → 一张无缝连续背景长图
        ↓
在背景上叠加：装饰元素 → 产品图（带阴影）→ 文字
        ↓
输出：一张完整的、无缝的、设计师级详情页长图
```

## 和现有HTML流程的关系

- HTML渲染流程**保留**，作为"快速预览"和"低成本方案"
- AI精修流程是**额外选项**，用户点"AI精修"才触发
- 两种输出可以切换对比
- 导出时用户选择导出哪个版本

## 给 Claude Code 的执行指令

```
在现有AI生图基础上，实现"整体无缝详情页"方案：

1. 在 image_composer.py 中新增：
   - blend_segments(top, bottom, overlap_px) — 两段背景渐变融合
   - compose_full_page(segments) — 所有段融合成一张无缝长图
   - compose_final_detail_page(bg, products, texts, decorations, output) — 在背景上叠加全部内容

2. 新建 theme_color_flows.py：
   - 定义每套主题的色调流（从上到下的颜色变化节奏）
   - build_segment_prompt(zone, prev, next, theme) — 生成带上下文的背景prompt

3. 修改 ai_image.py / ai_image_volcengine.py：
   - generate_background 改为 generate_segment(zone, prompt) 
   - 支持自定义高度（不同模块高度不同）

4. 在 workspace.html 的"AI精修"流程中：
   - 按色调流逐段生成背景
   - 融合成一张长图
   - 叠加内容
   - 显示最终结果

5. 用一个真实产品测试：生成一套完整的无缝详情页，保存到 output/seamless_test.png

设计原则：
- 背景是连续渐变的，没有硬切割
- 模块之间用轻微的装饰（极细分割线、浮动卡片）创造节奏，但不打破连续感
- 文字全部用Pillow中文字体渲染，不依赖AI生成文字
- 产品图带 drop shadow 让它"浮"在背景上
```
