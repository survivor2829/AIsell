"""
AI 图片生成模块 — 基于阿里云百炼 DashScope (通义万相)
用途：为产品详情页生成高质量背景图，再由 image_composer 合成最终图片
"""
import os
import time
import requests
from requests.adapters import HTTPAdapter
import dashscope
from dashscope.aigc.image_generation import ImageGeneration
from dashscope.api_entities.dashscope_response import Message
from pathlib import Path

# 阿里云百炼 API 配置
dashscope.base_http_api_url = 'https://dashscope.aliyuncs.com/api/v1'

# 复用 TCP/TLS 连接，多段下载时省去 ~200-400ms 握手开销
_SESSION = requests.Session()
# trust_env=False: 不读 HTTP_PROXY / HTTPS_PROXY 等环境变量, 避免 Clash 介入 DashScope CDN 下载
_SESSION.trust_env = False
_SESSION.mount("https://", HTTPAdapter(pool_connections=10, pool_maxsize=10))

# 默认模型
T2I_MODEL = "wan2.6-t2i"

# P4 §C.10 修复: 进程级一次性 unset 代理 env, 替代 per-request pop/restore
# (per audit stub C10 方案 A). 原 _clear_proxy/_restore_proxy 在 batch_queue
# 3-worker 并发时 race: A pop → B saved 空 → A restore → B 后续请求带回代理.
# DashScope SDK 不允许 session 级配置, 只能模块加载时一次性 unset (单线程, 0 race).
_PROXY_KEYS = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
               "http_proxy", "https_proxy", "all_proxy")


def _disable_proxy_for_dashscope() -> None:
    """模块加载时一次性 unset 代理 env. 进程级单次操作, 多线程安全."""
    for k in _PROXY_KEYS:
        os.environ.pop(k, None)


_disable_proxy_for_dashscope()


_DASHSCOPE_SIZES = ["768*1344", "960*1280", "960*1696", "1024*1024",
                    "1280*960", "1344*768", "1440*1440", "1696*960"]


def _pick_dashscope_size(width: int, height: int) -> str:
    """从 DashScope 支持的固定尺寸中选比例最接近的，避免 InvalidParameter。"""
    target_ratio = height / max(width, 1)
    best, best_diff = _DASHSCOPE_SIZES[0], 1e9
    for s in _DASHSCOPE_SIZES:
        w, h = (int(x) for x in s.split("*"))
        diff = abs(h / w - target_ratio)
        if diff < best_diff:
            best, best_diff = s, diff
    return best


def generate_background(prompt: str, api_key: str,
                        size: str = "960*1696",
                        negative_prompt: str = "",
                        n: int = 1) -> list[str]:
    """
    文生图：生成纯背景/场景图（不含文字）
    返回图片URL列表（24小时有效，需尽快下载）
    """
    neg = negative_prompt or "文字, 水印, 文字叠加, 模糊, 低质量, 变形, 扭曲, 噪点"

    msg = Message(role='user', content=[{'text': prompt}])

    # 代理已在模块加载时 _disable_proxy_for_dashscope() unset, 此处直接调
    rsp = ImageGeneration.call(
        model=T2I_MODEL,
        api_key=api_key,
        messages=[msg],
        negative_prompt=neg,
        prompt_extend=True,
        watermark=False,
        n=n,
        size=size,
    )

    if rsp.status_code != 200:
        print(f"[AI生图] 失败: {rsp.code} - {rsp.message}")
        return []

    urls = []
    for choice in rsp.output.choices:
        for content in choice.message.content:
            if content.get('type') == 'image':
                urls.append(content['image'])
    print(f"[AI生图] 成功生成 {len(urls)} 张背景图")
    return urls


def generate_segment(zone: str, prompt: str, api_key: str,
                     width: int = 750, height: int = 1334,
                     negative_prompt: str = "",
                     reference_image_url: str = "") -> list[str]:
    """
    无缝长图方案：为单段背景生成图片，按目标宽高自动选最接近的 DashScope 支持尺寸。
    返回 URL 列表（通常长度为 1）。

    reference_image_url: 通义万相 wan2.6-t2i 目前不支持 image-to-image,
        此参数为保持路由层签名统一而保留, 实际忽略并打 warning。
        如需 i2i 颜色保真请改用 seedream 引擎。
    """
    size = _pick_dashscope_size(width, height)
    print(f"[AI生图][段:{zone}] 目标 {width}x{height} → 选用 {size}")
    if reference_image_url:
        print(f"[AI生图][段:{zone}] ⚠️ 通义万相 {T2I_MODEL} 不支持 image-to-image, "
              f"参考图被忽略 (建议改用 seedream 引擎做颜色保真)")
    return generate_background(prompt, api_key, size=size,
                               negative_prompt=negative_prompt, n=1)


def download_image(url: str, save_dir: str | Path, filename: str = "") -> str:
    """下载图片到本地，返回本地路径"""
    save_dir = Path(save_dir)
    save_dir.mkdir(parents=True, exist_ok=True)

    if not filename:
        filename = f"ai_bg_{int(time.time())}_{os.urandom(4).hex()}.png"

    save_path = save_dir / filename
    # _SESSION.trust_env=False + 模块级 _disable_proxy_for_dashscope() 已是双保险
    try:
        resp = _SESSION.get(url, timeout=60)
        resp.raise_for_status()
        with open(save_path, 'wb') as f:
            f.write(resp.content)
        print(f"[AI生图] 下载完成: {save_path}")
        return str(save_path)
    except Exception as e:
        print(f"[AI生图] 下载失败: {e}")
        return ""


# ── 预设 Prompt 模板 ─────────────────────────────────────────────────

def prompt_hero(product_name: str, brand: str = "") -> str:
    """英雄屏背景：大气科技感展示台"""
    brand_hint = f"，{brand}品牌风格" if brand else ""
    return (
        f"高端商用产品展示场景，深色科技感背景，柔和的聚光灯从上方打下，"
        f"光滑的浅灰色展示平台，周围有微弱的蓝色氛围灯光，"
        f"极简主义风格，专业产品摄影{brand_hint}，"
        f"8K超清，无文字无水印，留出中央大面积空间放置产品"
    )


def prompt_scene(scene_name: str, product_type: str = "清洁机器人") -> str:
    """场景应用背景：真实商业环境"""
    scene_map = {
        "商超": "大型现代化商场内部，宽敞明亮的走廊，大理石地面反光，两侧是商铺橱窗",
        "医院": "现代医院走廊，洁白的环氧地坪，柔和的白色灯光，干净整洁的环境",
        "酒店": "五星级酒店大堂，奢华的大理石地面，金色暖光吊灯，优雅的室内装潢",
        "工厂": "现代化工厂车间，平整的环氧树脂地面，工业照明，宽敞整洁的空间",
        "写字楼": "甲级写字楼大堂，现代简约设计，抛光大理石地面，落地玻璃幕墙",
        "学校": "学校教学楼走廊，水磨石地面，明亮的自然光，整洁的校园环境",
        "机场": "国际机场候机大厅，超大面积抛光地面，高挑的天花板，现代化设计",
    }
    scene_desc = scene_map.get(scene_name, f"{scene_name}的室内环境，干净的地面，明亮的灯光")
    return (
        f"{scene_desc}，"
        f"专业室内摄影，透视感强，35mm广角镜头，"
        f"无人物无杂物，地面中央留空用于放置{product_type}，"
        f"8K超清，无文字无水印，写实风格"
    )


def prompt_specs_bg() -> str:
    """参数表背景：深色科技磨砂质感"""
    return (
        "深色科技感背景，深蓝色到深灰色渐变，"
        "带有细微的磨砂玻璃纹理和几何线条装饰，"
        "微光粒子效果，极简主义，"
        "8K超清，无文字无水印，适合作为产品参数展示的底图"
    )


def prompt_comparison_bg() -> str:
    """对比屏背景：左右分割"""
    return (
        "左右对称分割的背景设计，左侧明亮现代科技风（白色和蓝色调），"
        "右侧暗淡陈旧传统风（灰色和褐色调），"
        "中间有一道柔和的分割光线，"
        "极简主义，8K超清，无文字无水印"
    )


def prompt_brand_bg(brand: str = "") -> str:
    """品牌背书背景"""
    return (
        f"企业品牌形象展示背景，深色高端质感，"
        f"带有细微的金属纹理和几何图案，"
        f"顶部有柔和的金色光线点缀，"
        f"专业商务风格，8K超清，无文字无水印"
    )


def generate_detail_backgrounds(product_data: dict, api_key: str,
                                save_dir: str | Path) -> dict:
    """
    根据产品数据一次性生成所有需要的背景图
    返回 {"hero": local_path, "scene_xxx": local_path, "specs": local_path, ...}
    """
    save_dir = Path(save_dir)
    results = {}

    product_name = product_data.get("product_name", "商用清洁设备")
    brand = product_data.get("brand", "")
    product_type = product_data.get("product_type", "清洁机器人")

    # 生成任务列表
    tasks = [
        ("hero", prompt_hero(product_name, brand), "960*1696"),
        ("specs", prompt_specs_bg(), "960*1696"),
    ]

    # 根据产品数据决定是否生成场景图
    scenes = product_data.get("scenes", [])
    if scenes:
        for i, s in enumerate(scenes[:3]):
            name = s.get("name", f"场景{i+1}")
            tasks.append((f"scene_{name}", prompt_scene(name, product_type), "960*1696"))
    else:
        # 默认生成1张通用场景
        tasks.append(("scene_default", prompt_scene("商超", product_type), "960*1696"))

    # 逐个生成（避免并发限制）
    for task_name, prompt, size in tasks:
        print(f"[AI生图] 生成 {task_name}...")
        urls = generate_background(prompt, api_key, size=size)
        if urls:
            local = download_image(urls[0], save_dir, f"{task_name}.png")
            if local:
                results[task_name] = local

    return results
