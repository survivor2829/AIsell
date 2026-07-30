"""
prompt_templates 实战验证：用通义万相跑 hero 屏背景，保存到 output/prompt_test/
"""
import os
import sys
from pathlib import Path

import ai_image
import ai_image_router
import prompt_templates


def main():
    api_key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if not api_key:
        # 兜底：尝试从 .env 读取（禁止写出 key，仅用于本地测试）
        env_path = Path(__file__).parent / ".env"
        if env_path.exists():
            for line in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
                if line.startswith("DASHSCOPE_API_KEY="):
                    api_key = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break

    if not api_key:
        print("[测试] 未找到 DASHSCOPE_API_KEY，跳过真实调用。")
        sys.exit(2)

    theme_id = "classic-red"
    screens = ["hero", "advantages", "specs", "vs", "scene", "brand", "cta"]
    plan = prompt_templates.get_prompts_for_theme(
        theme_id, screens, product_hint="商用清洁机器人"
    )
    hero = plan[0]

    print(f"[测试] 主题={theme_id} 屏幕={hero['zone']}/{hero['variant']}")
    print(f"[测试] prompt 长度={len(hero['prompt'])} 字符")
    print(f"[测试] 目标尺寸=750x{hero['height']}")
    print("-" * 60)
    print(hero["prompt"])
    print("-" * 60)

    out_dir = Path(__file__).parent / "output" / "prompt_test"
    out_dir.mkdir(parents=True, exist_ok=True)

    # 保存 prompt 文本存档
    (out_dir / "hero_prompt.txt").write_text(
        f"[theme={theme_id} variant={hero['variant']}]\n\n"
        f"POSITIVE:\n{hero['prompt']}\n\n"
        f"NEGATIVE:\n{hero['negative_prompt']}\n",
        encoding="utf-8",
    )

    print("[测试] 调用通义万相生成 hero 背景...")
    local = ai_image_router.generate_segment_to_local(
        engine="wanxiang",
        zone="hero",
        prompt=hero["prompt"],
        api_keys={"dashscope_api_key": api_key},
        save_dir=out_dir,
        width=750,
        height=hero["height"],
        filename="hero_classic-red_showroom.png",
    )

    if not local:
        print("[测试] 生成失败（见上方 SDK 错误日志）")
        sys.exit(1)

    print(f"[测试] ✅ 成功：{local}")
    print(f"[测试] prompt 已存档：{out_dir / 'hero_prompt.txt'}")


if __name__ == "__main__":
    main()
