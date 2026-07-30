"""
端到端冒烟测试（不调 AI API）：
用 static/scene_bank/ 里现成的图片当作"已生成的段背景"，
跑通 plan_seamless_page → compose_seamless_detail_page，验证完整链路。
"""
import os
from pathlib import Path

import theme_color_flows
import image_composer
import ai_image_router

BASE = Path(__file__).parent
OUT = BASE / "output"
OUT.mkdir(exist_ok=True)

# 1. 引擎列表
print("=" * 60)
print("引擎列表:")
for e in ai_image_router.list_engines():
    print(f"  - {e['id']:10s} {e['label']:20s} 模型={e['model']}  key_env={e['key_env']}")

# 2. 色调流规划
print("=" * 60)
plan = theme_color_flows.plan_seamless_page("classic-red", product_hint="商用清洁机器人")
print(f"色调流规划: {len(plan)} 段")
for p in plan:
    print(f"  - {p['zone']:12s} h={p['height']:5d}  overlap={p['overlap_bottom']:3d}  prompt={p['prompt'][:40]!r}...")

# 3. 用 scene_bank 现成图片当段背景（模拟 AI 已生成）
scene_bank = BASE / "static" / "scene_bank"
candidates = sorted(scene_bank.glob("*.jpg"))[:len(plan)]
if len(candidates) < len(plan):
    candidates = (candidates * (len(plan) // len(candidates) + 1))[:len(plan)]
segment_paths = [str(c) for c in candidates]
print("=" * 60)
print(f"段输入: {len(segment_paths)} 张")
for s in segment_paths[:3]:
    print(f"  - {s}")

# 4. mock product_data
product_data = {
    "brand": "德威莱克", "brand_text": "德威莱克",
    "model": "DZ50X", "model_name": "DZ50X",
    "product_name": "驾驶式洗地机", "product_type": "驾驶式洗地机",
    "category_line": "驾驶式洗地机",
    "main_title": "DZ50X 驾驶式洗地机",
    "tagline_line1": "一台顶八人", "tagline_line2": "效率 3600㎡/h",
    "sub_slogan": "商用清洁，从未如此简单",
    "param_1_label": "清扫效率", "param_1_value": "3600㎡/h",
    "param_2_label": "清扫宽度", "param_2_value": "1800mm",
    "param_3_label": "续航时间", "param_3_value": "3.5小时",
    "param_4_label": "运行噪音", "param_4_value": "≤65dB",
    "advantages": [
        {"icon": "⚡", "label": "高效清扫", "desc": "3600㎡/h 大面积"},
        {"icon": "💧", "label": "智能水控", "desc": "90L 大水箱"},
        {"icon": "🔋", "label": "长续航",  "desc": "3.5小时连续"},
        {"icon": "🔇", "label": "静音设计", "desc": "≤65dB 不扰客"},
        {"icon": "📐", "label": "精准转弯", "desc": "1.2m 转弯半径"},
        {"icon": "🛡️", "label": "安全防护", "desc": "多重急停"},
    ],
    "specs": [
        {"label": "整机尺寸", "value": "1450×800×1180mm"},
        {"label": "整机重量", "value": "320kg"},
        {"label": "水箱容量", "value": "清水90L / 污水100L"},
        {"label": "电池规格", "value": "锂电 24V/200Ah"},
    ],
    "story_title_1": "更快", "story_desc_1": "效率提升 3 倍，告别低效手推",
    "story_title_2": "更净", "story_desc_2": "刷盘+吸水一次完成，地面光亮如新",
    "vs_comparison": {
        "left_title": "传统人工",
        "left_items": ["效率 200㎡/h", "8人轮班", "成本 2万/月"],
        "right_title": "DZ50X",
        "right_items": ["效率 3600㎡/h", "1人操作", "成本 0.5万/月"],
    },
    "scenes": [
        {"name": "商场超市", "desc": "宽敞地面快速清扫"},
        {"name": "酒店大堂", "desc": "静音不扰客"},
        {"name": "工厂车间", "desc": "重型粉尘清理"},
        {"name": "地下车库", "desc": "油污去除"},
    ],
    "footer_note": "*产品参数以实物为准，图片仅供参考",
}

# 5. 找一张产品图（任意）
prod_imgs = sorted((BASE / "static").glob("**/*.png"))
product_image = ""
for p in prod_imgs:
    if "uploads" in str(p) or "设备类" in str(p):
        product_image = str(p)
        break
print("=" * 60)
print(f"产品图: {product_image or '无（hero zone 不叠产品图）'}")

# 6. 端到端合成
out_path = OUT / "test_e2e_seamless.png"
print("=" * 60)
print(f"开始合成 → {out_path}")
result = image_composer.compose_seamless_detail_page(
    product_data=product_data,
    plan=plan,
    segment_paths=segment_paths,
    product_image=product_image,
    output_path=str(out_path),
    theme_primary="#E8231A",
)

# 7. 检查输出
from PIL import Image
img = Image.open(result)
print(f"=" * 60)
print(f"OK -> {result}")
print(f"  尺寸: {img.width} x {img.height}")
print(f"  文件大小: {Path(result).stat().st_size / 1024:.1f} KB")
