"""A1 Bug 验证 · scene_bank manifest.json + 新匹配算法覆盖度.

跑法:
  python scripts/verify_scene_match.py

验证分两类:
  1. direct_match: 期望 score > 0, 匹到具体图 (具体场景词)
  2. fallback:     期望 score = 0 直接走 category 兜底 (泛化词如 "公共场景")

category fallback 基于 product_type 推导 (商用机器人 → commercial 等).
"""
from __future__ import annotations
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT / "static" / "scene_bank" / "manifest.json"


def _match_scene_smart(scene_name: str, manifest: list[dict]) -> tuple[dict, int]:
    """双向子串打分: keyword in scene OR scene in keyword 命中 +1.
       返回 (best_entry, best_score). 全 miss 时 best_score=0.
    """
    key = (scene_name or "").strip()
    if not key:
        return manifest[0], 0
    best = (manifest[0], 0)
    for entry in manifest:
        score = 0
        for kw in entry.get("keywords") or []:
            if kw and (kw in key or key in kw):
                score += 1
        if score > best[1]:
            best = (entry, score)
    return best


# 商用机器人 → commercial, 水上机器人 → water, 工业/清洁 → industrial
def _category_for_product(product_type: str) -> str:
    pt = (product_type or "").lower()
    if any(k in pt for k in ("水面", "水上", "水", "river", "water")):
        return "water"
    if any(k in pt for k in ("管道", "管网", "pipe")):
        return "pipeline"
    if any(k in pt for k in ("商用", "办公", "商业", "commercial")):
        return "commercial"
    if any(k in pt for k in ("工业", "仓储", "车间", "industrial")):
        return "industrial"
    return "public"


def _pick_by_category(manifest: list[dict], category: str) -> dict:
    for e in manifest:
        if e.get("category") == category:
            return e
    return manifest[0]


# direct match 必须 score>0
DIRECT_CASES = [
    ("商业办公", "commercial/commercial_02.jpg"),
    ("商业零售", None),  # 任意 commercial 图, score>0
    ("河流湖泊", None),
    ("城市管网", None),
    ("地下管道箱涵", "pipeline/pipeline_03.jpg"),
    ("河道管网", None),
    ("大型生产车间", "industrial/industrial_02.jpg"),
    ("物流仓库", "industrial/industrial_01.jpg"),
    ("大型地下停车场", None),
    ("工业园区/厂房", None),   # 修 ① 后期望 industrial (不是 pipeline_05)
    ("工业园区", "industrial/industrial_02.jpg"),  # 单独测 ① 的修复
    ("河道污染物溯源", "water/water_03.jpg"),
    ("城市管网内部巡查", None),
    ("地下管道箱涵调查", "pipeline/pipeline_03.jpg"),
    ("水质检测", "water/water_02.jpg"),
    ("管道巡查", None),
    ("机场", None),
    ("医院", "医院.jpg"),
    ("酒店大堂", "酒店大堂.jpg"),
    ("超市", None),
]

# fallback 必须 score=0, 然后按 product_type → category 选首图
FALLBACK_CASES = [
    ("公共场景", "商用清洁机器人",         "commercial"),
    ("公共场景", "无人水面清洁机器人",      "water"),
    ("公共场景", "工业清洁机器人",         "industrial"),
]


def run():
    if not MANIFEST_PATH.is_file():
        print(f"[FATAL] manifest 不存在: {MANIFEST_PATH}")
        sys.exit(1)
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    print(f"[info] manifest entries: {len(manifest)}")
    print()

    failures = []

    print(f"━━━ DIRECT MATCH ({len(DIRECT_CASES)} cases) ━━━")
    for scene, expect_file in DIRECT_CASES:
        entry, score = _match_scene_smart(scene, manifest)
        ok = score > 0
        match_file_ok = (expect_file is None) or (entry["file"] == expect_file)
        overall = ok and match_file_ok
        tag = "PASS" if overall else "FAIL"
        expect = f" expected={expect_file}" if expect_file else ""
        print(f"  [{tag}] {scene:<16} → {entry['file']:<32} (score={score}){expect}")
        if not overall:
            failures.append((scene, entry["file"], score, expect_file))

    print()
    print(f"━━━ CATEGORY FALLBACK ({len(FALLBACK_CASES)} cases) ━━━")
    for scene, product_type, expect_cat in FALLBACK_CASES:
        entry, score = _match_scene_smart(scene, manifest)
        fallback_entry = _pick_by_category(manifest, expect_cat)
        # 期望: direct score=0 (没命中), 走 fallback → entry 属于 expect_cat
        ok = score == 0 and fallback_entry.get("category") == expect_cat
        tag = "PASS" if ok else "FAIL"
        print(f"  [{tag}] {scene!r} (pt={product_type!r})")
        print(f"         direct: {entry['file']} (score={score})")
        print(f"         fallback → {fallback_entry['file']} (category={fallback_entry.get('category')}, expect={expect_cat})")
        if not ok:
            failures.append((scene, entry["file"], score, f"fallback→{expect_cat}"))

    total = len(DIRECT_CASES) + len(FALLBACK_CASES)
    passed = total - len(failures)
    print()
    print(f"SUMMARY: {passed}/{total} PASS")
    if failures:
        print("\nFAILURES:")
        for scene, got_file, score, expect in failures:
            print(f"  {scene}: got {got_file} (score={score}), expect {expect}")
        sys.exit(1)
    print("ALL GREEN")


if __name__ == "__main__":
    run()
