"""populate_scene_bank.py — 抓清洁行业场景图到 static/scene_bank/

跑法:
  UNSPLASH_ACCESS_KEY=xxx python scripts/populate_scene_bank.py  # 首选, 最清晰
  PEXELS_API_KEY=xxx python scripts/populate_scene_bank.py       # 次选
  python scripts/populate_scene_bank.py                          # 无 key, loremflickr (质量一般)

输出:
- static/scene_bank/{water,pipeline,industrial,commercial,public}/*.jpg
- static/scene_bank/manifest.json (含 keywords 标签, 供 _match_scene_smart 用)

约束 (用户指定):
- 5 子目录 × 5-6 张 = 25-30 张
- 每张 keywords ≥ 3
- 不覆盖已有文件 (重跑安全)
- 失败跳过打印统计, 不中断整批
"""
from __future__ import annotations
import os
import json
import time
import urllib.request
import urllib.parse
import urllib.error
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "static" / "scene_bank"

# 查询词 + 中文 keywords (≥ 3 每张). 关键词覆盖产品策略可能出现的场景名.
CATEGORIES: dict[str, list[dict]] = {
    "water": [
        {"q": "river surface water",     "kw": ["河道", "水面", "河流", "水上", "河岸"]},
        {"q": "lake water clean",        "kw": ["湖泊", "湖水", "水质检测", "清洁水"]},
        {"q": "river pollution surface", "kw": ["河道污染", "污染物", "水面污染", "溯源", "清污"]},
        {"q": "swimming pool blue",      "kw": ["游泳池", "泳池", "水池", "池水"]},
        {"q": "reservoir dam water",     "kw": ["水库", "水坝", "水源", "蓄水"]},
        {"q": "underwater drone boat",   "kw": ["无人船", "水下机器人", "水下作业", "巡查"]},
    ],
    "pipeline": [
        {"q": "sewer pipe concrete",       "kw": ["下水道", "排水管", "地下管网", "排水"]},
        {"q": "pipe inspection tunnel",    "kw": ["管道巡查", "管道检测", "管网巡查", "管道"]},
        {"q": "drainage culvert",          "kw": ["箱涵", "涵洞", "排水渠", "涵管"]},
        {"q": "storm drain street",        "kw": ["雨水管", "街道排水", "下水井", "雨污"]},
        {"q": "industrial pipeline plant", "kw": ["工业管道", "厂区管道", "化工管道"]},
        {"q": "underground tunnel pipe",   "kw": ["地下通道", "地下管道", "城市管廊"]},
    ],
    "industrial": [
        {"q": "warehouse concrete floor",       "kw": ["仓库", "仓储", "厂房地面", "水泥地"]},
        {"q": "factory production line floor",  "kw": ["工厂", "生产线", "车间"]},
        {"q": "industrial cleaning equipment",  "kw": ["工业清洁", "清扫机", "工厂清洁"]},
        {"q": "logistics center warehouse",     "kw": ["物流中心", "堆场", "物流"]},
        {"q": "parking garage underground",     "kw": ["地下车库", "停车场", "车库地面"]},
    ],
    "commercial": [
        {"q": "shopping mall interior",         "kw": ["商场", "购物中心", "商超", "大型商超"]},
        {"q": "office lobby clean",             "kw": ["写字楼", "办公楼", "大堂", "前台"]},
        {"q": "hotel lobby marble",             "kw": ["酒店大堂", "酒店", "大理石"]},
        {"q": "airport terminal hall",          "kw": ["机场", "候机楼", "航站楼"]},
        {"q": "supermarket aisle",              "kw": ["超市", "大卖场", "商超通道"]},
    ],
    "public": [
        {"q": "hospital corridor modern",       "kw": ["医院", "医院走廊", "医疗机构"]},
        {"q": "school hallway empty",           "kw": ["学校", "校园", "教学楼"]},
        {"q": "subway station platform",        "kw": ["地铁站", "地铁", "站台"]},
        {"q": "train station concourse",        "kw": ["火车站", "高铁站", "车站"]},
        {"q": "museum interior exhibition",     "kw": ["博物馆", "展厅", "展馆"]},
    ],
}


def fetch_unsplash(query: str, key: str) -> str:
    url = "https://api.unsplash.com/photos/random?" + urllib.parse.urlencode({
        "query": query, "orientation": "landscape", "content_filter": "high",
    })
    req = urllib.request.Request(url, headers={
        "Authorization": f"Client-ID {key}",
        "Accept-Version": "v1",
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.loads(r.read().decode("utf-8"))
    return data["urls"]["regular"]


def fetch_pexels(query: str, key: str) -> str:
    url = "https://api.pexels.com/v1/search?" + urllib.parse.urlencode({
        "query": query, "per_page": 1, "orientation": "landscape",
    })
    req = urllib.request.Request(url, headers={"Authorization": key})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.loads(r.read().decode("utf-8"))
    photos = data.get("photos") or []
    if not photos:
        raise ValueError(f"Pexels zero result for {query!r}")
    return photos[0]["src"]["large"]


def fetch_loremflickr(query: str) -> str:
    q = query.replace(" ", ",")
    return f"https://loremflickr.com/960/640/{q}"


def download(url: str, out_path: Path) -> int:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=45) as r:
        data = r.read()
    if len(data) < 8000:
        raise ValueError(f"image too small: {len(data)} bytes")
    out_path.write_bytes(data)
    return len(data)


def main():
    unsplash_key = os.environ.get("UNSPLASH_ACCESS_KEY", "").strip()
    pexels_key = os.environ.get("PEXELS_API_KEY", "").strip()

    if unsplash_key:
        mode = "unsplash"
        fetcher = lambda q: fetch_unsplash(q, unsplash_key)
    elif pexels_key:
        mode = "pexels"
        fetcher = lambda q: fetch_pexels(q, pexels_key)
    else:
        mode = "loremflickr"
        fetcher = fetch_loremflickr

    print(f"[populate] mode={mode}")
    print(f"[populate] out_dir={OUT_DIR}")
    print()

    manifest: list[dict] = []
    success = skipped = 0
    failed: list[tuple] = []
    total = sum(len(items) for items in CATEGORIES.values())
    idx = 0

    for cat, items in CATEGORIES.items():
        cat_dir = OUT_DIR / cat
        for i, item in enumerate(items, 1):
            idx += 1
            fname = f"{cat}_{i:02d}.jpg"
            rel = f"{cat}/{fname}"
            out_path = cat_dir / fname
            if out_path.is_file() and out_path.stat().st_size > 8000:
                print(f"[SKIP {idx}/{total}] {rel} (exists, {out_path.stat().st_size//1024}KB)")
                manifest.append({
                    "file": rel, "category": cat,
                    "keywords": item["kw"], "query": item["q"],
                })
                skipped += 1
                continue
            try:
                img_url = fetcher(item["q"])
                size = download(img_url, out_path)
                print(f"[OK   {idx}/{total}] {rel}  ({size//1024}KB) — {item['q']!r}")
                manifest.append({
                    "file": rel, "category": cat,
                    "keywords": item["kw"], "query": item["q"],
                })
                success += 1
                time.sleep(0.3)  # 被限流的话给个间隔
            except Exception as e:
                print(f"[FAIL {idx}/{total}] {rel} — {item['q']!r} → {type(e).__name__}: {e}")
                failed.append((rel, item["q"], f"{type(e).__name__}: {e}"))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print("\n" + "=" * 50)
    print(f"SUMMARY:")
    print(f"  success: {success}")
    print(f"  skipped: {skipped} (existing, kept)")
    print(f"  failed:  {len(failed)}")
    print(f"  total manifest: {len(manifest)} entries")
    print(f"  manifest: {OUT_DIR / 'manifest.json'}")
    if failed:
        print(f"\nFAILED ({len(failed)}):")
        for rel, q, err in failed:
            print(f"  {rel} | {q} | {err}")


if __name__ == "__main__":
    main()
