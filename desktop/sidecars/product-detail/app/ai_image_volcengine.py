"""
AI 图片生成模块 — 基于火山方舟 Ark (豆包 Seedream 4.0)
用途：为产品详情页生成高质量背景图，与 ai_image.py (通义万相) 接口对齐
调用方式：requests 直接 HTTP，无需 openai 包
"""
import os
import sys
import time
import traceback
import requests
from requests.adapters import HTTPAdapter
from pathlib import Path

# ── 模型与端点配置 ────────────────────────────────────────────
T2I_MODEL = "doubao-seedream-4-0-250828"
ARK_ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/images/generations"

# 复用 TCP/TLS 连接，多段下载时省去握手开销
_SESSION = requests.Session()
_SESSION.mount("https://", HTTPAdapter(pool_connections=10, pool_maxsize=10))
# CRITICAL: Windows 上 requests 会读注册表里的"系统代理"设置(Clash/Fiddler/等都会写这里),
# 国内 API(火山方舟/DeepSeek)走 Clash 会触发 SSL MITM 中断 → SSLError(UNEXPECTED_EOF)。
# trust_env=False 让 session 完全不读 环境变量 / 系统代理注册表,只认显式传的 proxies。
# Why: 仅清 os.environ 不够 — Windows WinINET 系统代理是独立通道,必须从 session 层级屏蔽。
_SESSION.trust_env = False

# ── 代理清除（火山方舟国内服务，不走 Clash）───────────────────
# P4 §C.10 修复: 删 _clear_proxy / _restore_proxy 全部.
# _SESSION.trust_env=False (line 25) + per-call proxies={} (双保险) 已能完全
# 阻断代理介入, 多线程下 0 race. 原 pop os.environ 模式在 batch_queue 3-worker
# 并发时可能让线程 B 看不到 saved 状态, 还原阶段引发污染.

# ── 核心生图函数 ──────────────────────────────────────────────

def generate_background(prompt: str, api_key: str,
                        size: str = "1024x1024",
                        negative_prompt: str = "",
                        n: int = 1,
                        reference_image_url: str = "") -> list[str]:
    """
    文生图：调用豆包 Seedream 4.0，返回图片 URL 列表
    size 格式：豆包原生 "WxH"（小写 x），如 "1024x1024" / "2048x2048"
    注意：返回 URL 有效期约 24 小时，请尽快下载

    reference_image_url: 可选参考图。支持 https:// URL 或 data:image/...;base64,... 格式。
                         传空字符串（默认）→ 纯文生图，行为与原来完全一致。
    """
    payload = {
        "model": T2I_MODEL,
        "prompt": prompt,
        "size": size,
        "n": n,
        "response_format": "url",
        "watermark": False,
    }
    # negative_prompt：Seedream 不在标准字段里，但可放到 prompt 前缀里
    if negative_prompt:
        payload["prompt"] = f"{prompt} --no {negative_prompt}"

    # image-to-image：有参考图时注入 image 字段
    if reference_image_url:
        payload["image"] = reference_image_url
        print(f"[豆包生图] 使用参考图 (image-to-image), len={len(reference_image_url)}")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    try:
        # proxies={} 双保险 — 即使 trust_env 漏网也绝不走代理
        resp = _SESSION.post(ARK_ENDPOINT, json=payload, headers=headers,
                             timeout=120, proxies={"http": "", "https": ""})
    except Exception:
        print("[豆包生图] 网络请求失败:")
        traceback.print_exc()
        return []

    # Parse response body regardless of HTTP status — API embeds error details in JSON
    try:
        data = resp.json()
    except Exception:
        print(f"[豆包生图] 响应非 JSON，状态码 {resp.status_code}: {resp.text[:300]}")
        return []

    # Check for business-level errors
    err = data.get("error", {})
    if err:
        code = err.get("code", "")
        msg = err.get("message", "")
        print(f"[豆包生图] API 错误 {code}: {msg}")
        if code == "ModelNotOpen":
            print("[豆包生图] 提示：请前往火山方舟控制台激活模型服务：")
            print("  https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement")
        return []

    urls = []
    for item in data.get("data", []):
        url = item.get("url") or item.get("b64_json")
        if url:
            urls.append(url)

    if urls:
        print(f"[豆包生图] 成功生成 {len(urls)} 张图，size={size}")
    else:
        print(f"[豆包生图] 返回数据无 URL，原始响应: {data}")
    return urls


_SEEDREAM_SIZES = ["1024x1024", "1024x1536", "1024x1792",
                   "1536x1024", "1792x1024", "2048x2048"]


def _pick_seedream_size(width: int, height: int) -> str:
    """从 Seedream 支持的固定尺寸中选比例最接近的"""
    target_ratio = height / max(width, 1)
    best, best_diff = _SEEDREAM_SIZES[0], 1e9
    for s in _SEEDREAM_SIZES:
        w, h = (int(x) for x in s.split("x"))
        diff = abs(h / w - target_ratio)
        if diff < best_diff:
            best, best_diff = s, diff
    return best


def generate_segment(zone: str, prompt: str, api_key: str,
                     width: int = 750, height: int = 1334,
                     negative_prompt: str = "",
                     reference_image_url: str = "") -> list[str]:
    """无缝长图方案：单段背景生成，按目标宽高自动选最接近的支持尺寸

    reference_image_url: 可选参考图。支持 https:// URL 或 data:image/...;base64,... 格式。
                         传空字符串（默认）→ 纯文生图路径，行为与原来完全一致。
    """
    size = _pick_seedream_size(width, height)
    print(f"[豆包生图][段:{zone}] 目标 {width}x{height} → 选用 {size}")
    return generate_background(prompt, api_key, size=size,
                               negative_prompt=negative_prompt, n=1,
                               reference_image_url=reference_image_url)


def download_image(url: str, save_dir, filename: str = "") -> str:
    """下载图片到本地，返回本地路径；失败返回空字符串"""
    save_dir = Path(save_dir)
    save_dir.mkdir(parents=True, exist_ok=True)

    if not filename:
        filename = f"doubao_bg_{int(time.time())}_{os.urandom(4).hex()}.png"

    save_path = save_dir / filename
    try:
        r = _SESSION.get(url, timeout=60, proxies={"http": "", "https": ""})
        r.raise_for_status()
        with open(save_path, "wb") as f:
            f.write(r.content)
        print(f"[豆包生图] 下载完成: {save_path}")
        return str(save_path)
    except Exception:
        print("[豆包生图] 下载失败:")
        traceback.print_exc()
        return ""


# ── 预设 Prompt 模板（与 ai_image.py 对齐，可针对豆包特性微调）────

def prompt_hero(product_name: str, brand: str = "") -> str:
    """英雄屏背景：大气科技感展示台"""
    brand_hint = f"，{brand}品牌风格" if brand else ""
    return (
        f"高端商用产品展示场景，深色科技感背景，柔和的聚光灯从上方打下，"
        f"光滑的浅灰色展示平台，周围有微弱的蓝色氛围灯光，"
        f"极简主义风格，专业产品摄影{brand_hint}，"
        f"超高清，无文字无水印，留出中央大面积空间放置产品"
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
        f"超高清，无文字无水印，写实风格"
    )


def prompt_specs_bg() -> str:
    """参数表背景：深色科技磨砂质感"""
    return (
        "深色科技感背景，深蓝色到深灰色渐变，"
        "带有细微的磨砂玻璃纹理和几何线条装饰，"
        "微光粒子效果，极简主义，"
        "超高清，无文字无水印，适合作为产品参数展示的底图"
    )


def prompt_comparison_bg() -> str:
    """对比屏背景：左右分割"""
    return (
        "左右对称分割的背景设计，左侧明亮现代科技风（白色和蓝色调），"
        "右侧暗淡陈旧传统风（灰色和褐色调），"
        "中间有一道柔和的分割光线，"
        "极简主义，超高清，无文字无水印"
    )


def prompt_brand_bg(brand: str = "") -> str:
    """品牌背书背景"""
    return (
        f"企业品牌形象展示背景，深色高端质感，"
        f"带有细微的金属纹理和几何图案，"
        f"顶部有柔和的金色光线点缀，"
        f"专业商务风格，超高清，无文字无水印"
    )


# ── 批量生成入口（签名与 ai_image.py 完全一致）────────────────

def generate_detail_backgrounds(product_data: dict, api_key: str,
                                save_dir) -> dict:
    """
    根据产品数据一次性生成所有需要的背景图
    返回 {"hero": local_path, "scene_xxx": local_path, "specs": local_path, ...}
    豆包默认用 1024x1024（正方形），裁图/拼接由 image_composer 处理
    """
    save_dir = Path(save_dir)
    results = {}

    product_name = product_data.get("product_name", "商用清洁设备")
    brand = product_data.get("brand", "")
    product_type = product_data.get("product_type", "清洁机器人")

    # 生成任务列表（豆包尺寸用 1024x1024；如需竖版可改为 1024x1792）
    tasks = [
        ("hero", prompt_hero(product_name, brand), "1024x1024"),
        ("specs", prompt_specs_bg(), "1024x1024"),
    ]

    scenes = product_data.get("scenes", [])
    if scenes:
        for i, s in enumerate(scenes[:3]):
            name = s.get("name", f"场景{i+1}")
            tasks.append((f"scene_{name}", prompt_scene(name, product_type), "1024x1024"))
    else:
        tasks.append(("scene_default", prompt_scene("商超", product_type), "1024x1024"))

    for task_name, prompt, size in tasks:
        print(f"[豆包生图] 生成 {task_name}...")
        urls = generate_background(prompt, api_key, size=size)
        if urls:
            local = download_image(urls[0], save_dir, f"{task_name}.png")
            if local:
                results[task_name] = local

    return results


# ── 自测入口 ──────────────────────────────────────────────────

if __name__ == "__main__":
    key = os.environ.get("ARK_API_KEY", "")
    if not key:
        # 尝试从 .env 加载
        env_path = Path(__file__).parent / ".env"
        if env_path.exists():
            for line in env_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith("ARK_API_KEY="):
                    key = line.split("=", 1)[1].strip()
                    break
    if not key:
        print("请先 export ARK_API_KEY=... 或在 .env 中配置")
        sys.exit(1)

    print(f"[豆包生图] 使用模型: {T2I_MODEL}")
    print(f"[豆包生图] Endpoint: {ARK_ENDPOINT}")

    urls = generate_background(
        "深色科技感背景，浅蓝色调，极简设计，适合产品展示，超高清，无文字无水印",
        api_key=key,
        size="1024x1024",
    )
    print("生成结果 URL：", urls)
    if urls:
        local = download_image(urls[0], "output/test_seedream", "test.png")
        print("本地路径：", local)
