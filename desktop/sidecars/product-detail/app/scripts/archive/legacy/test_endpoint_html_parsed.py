"""
AI 合成管线 · 阶段三补:parsed_data 模式端点测试

模拟前端场景:只给 parsed_data + product_image + theme_id,
端点内部走 `_build_ctxs_from_parsed` 生成 7 屏 ctxs。
"""
import sys
from pathlib import Path


PARSED_DEMO = {
    "brand": "洁净工业",
    "model": "DZ50X",
    "product_name": "DZ50X 驾驶式洗地机",
    "product_type": "驾驶式洗地机",
    "main_title": "DZ50X",
    "slogan": "一台顶八人 效率3600",
    "sub_slogan": "商用清洁智能驾驶",
    "hero_subtitle": "商用清洁智能驾驶",
    "category_line": "驾驶式洗地机",

    "param_efficiency": "3600㎡/h",
    "param_width": "850mm",
    "param_capacity": "90L/100L",
    "param_runtime": "4小时",

    "detail_params": {
        "清洁效率": "3600㎡/h",
        "清扫宽度": "850mm",
        "清水容量": "90L",
        "污水容量": "100L",
        "续航时间": "4小时",
        "运行噪音": "≤68dB",
        "最小转弯": "1.2m",
        "整机重量": "380kg",
    },

    "advantages": [
        {"emoji": "⚡", "text": "高效清扫", "desc": "相当于8名保洁同时作业"},
        {"emoji": "💧", "text": "大水箱长续航", "desc": "90L/100L 双箱设计"},
        {"emoji": "🔋", "text": "锂电续航4小时", "desc": "一次充电覆盖全天班次"},
        {"emoji": "🔇", "text": "静音≤68dB", "desc": "商场酒店全时段可用"},
        {"emoji": "📐", "text": "精准转弯1.2m", "desc": "狭窄通道轻松穿行"},
        {"emoji": "🛡️", "text": "5重安全防护", "desc": "激光+红外+碰撞+边界+急停"},
    ],

    "vs_comparison": {
        "replace_count": "8",
        "left_title": "DZ50X 驾驶式",
        "right_title": "传统人工保洁",
        "compare_items": [
            {"label": "人力投入", "left_value": "1 人", "left_desc": "驾驶即可完成",
             "right_value": "8 人", "right_desc": "多人协同作业"},
            {"label": "清扫效率", "left_value": "3600 ㎡/h", "left_desc": "12 倍提效",
             "right_value": "300 ㎡/h", "right_desc": "人工拖地速度"},
            {"label": "月度成本", "left_value": "¥ 0", "left_desc": "设备摊销后",
             "right_value": "¥ 8000+", "right_desc": "单人月薪起"},
        ],
    },

    "scenes": [
        {"name": "商场超市", "desc": "千级㎡大卖场地面清洁"},
        {"name": "机场航站楼", "desc": "夜间深度清洁0扰客"},
        {"name": "物流仓储", "desc": "大面积地面油污清除"},
        {"name": "地下车库", "desc": "油污尘垢一次去除"},
    ],

    "brand_story": (
        "深耕商用清洁领域15年,服务全球3000+商业客户,"
        "专注为大空间场景提供高效、静音、耐用的智能清洁解决方案。"
    ),
    "brand_stats": [
        {"main": "15+", "label": "深耕年限"},
        {"main": "3000+", "label": "商用客户"},
        {"main": "12", "label": "发明专利"},
        {"main": "ISO", "label": "质量认证"},
    ],
}


def main():
    import app as app_module
    app = app_module.app
    app.config["LOGIN_DISABLED"] = True
    app.config["TESTING"] = True

    payload = {
        "parsed_data":  PARSED_DEMO,
        "product_image": "",  # 没传产品图,hero/specs 的 product_url 走模板条件隐藏
        "theme_id":      "classic-red",
        "out_jpg_name":  "test_parsed.jpg",
        "save_png":      False,
    }

    client = app.test_client()
    print(f"[test] POST /api/generate-ai-detail-html (parsed_data 模式)")
    print(f"[test]   parsed 字段: {list(PARSED_DEMO.keys())}")

    resp = client.post("/api/generate-ai-detail-html", json=payload)
    print(f"[test]   status: {resp.status_code}")

    if resp.status_code != 200:
        print(f"[FAIL] {resp.get_json() or resp.data.decode(errors='replace')}")
        sys.exit(1)

    result = resp.get_json()
    print()
    print("=" * 72)
    print(f"✅ parsed_data → ctxs → 长图 全链路通过")
    print(f"   image_url:     {result['image_url']}")
    print(f"   实际渲染的屏: {[s['type'] for s in result['segments']]}")
    for s in result["segments"]:
        print(f"     {s['type']:12s} {s['w']}×{s['h']}  {s['elapsed']:.2f}s")
    print(f"   total_elapsed: {result['total_elapsed']:.2f}s")
    jpg_mb = result["jpg_bytes"] / (1024 * 1024)
    print(f"   JPEG:         {jpg_mb:.2f} MB")

    jpg_path = Path(__file__).parent / result["image_url"].lstrip("/")
    if not jpg_path.exists():
        print(f"[FAIL] 文件缺失: {jpg_path}")
        sys.exit(1)
    print(f"   文件落盘:    {jpg_path}")
    print("=" * 72)


if __name__ == "__main__":
    main()
