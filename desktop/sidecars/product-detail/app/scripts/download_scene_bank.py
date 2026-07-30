"""
批量从 Wikipedia 词条页抓 Commons 直链,扩充 scene_bank。

幂等:已存在的 .jpg 直接跳过 — 支持反复重跑。
限流友好:每张间隔 1.5s;429 时退避 6s 重试一次。
分辨率宽容:优先 1280px,缺了回落 800px+(任意位数)。
词条备选:(filename, [primary, alt1, alt2]) — 第一个没图时自动换下一个。
"""
import re
import sys
import time
from pathlib import Path
import requests

# 国外站点走 Clash 代理;trust_env=False 避免 WinINET 注册表干扰
SESSION = requests.Session()
SESSION.trust_env = False
UA = {"User-Agent": "Mozilla/5.0 (SceneBankFetcher)"}
PROXIES = {
    "http":  "http://127.0.0.1:7890",
    "https": "http://127.0.0.1:7890",
}

BANK = Path(r"C:\Users\28293\clean-industry-ai-assistant\static\scene_bank")

# (目标文件名, [Wikipedia 词条候选列表 — 第一个没图自动换下一个])
MAPPING: list[tuple[str, list[str]]] = [
    ("街道.jpg",   ["Street"]),
    ("人行道.jpg", ["Sidewalk"]),
    ("小巷.jpg",   ["Alley", "Laneway", "Backstreet"]),
    ("广场.jpg",   ["Town_square"]),
    ("小区.jpg",   ["Residential_area", "Housing_estate", "Subdivision_(land)"]),
    ("公园.jpg",   ["Urban_park", "Park", "Public_park"]),
    ("码头.jpg",   ["Wharf", "Pier", "Dock_(maritime)"]),
    ("停车场.jpg", ["Parking_lot", "Car_park", "Parking"]),
    ("公交站.jpg", ["Bus_stop", "Bus_station"]),
    ("加油站.jpg", ["Filling_station", "Gas_station"]),
    ("景区.jpg",   ["Tourist_attraction"]),
    ("博物馆.jpg", ["Museum"]),
    ("咖啡馆.jpg", ["Coffeehouse", "Cafe", "Espresso_bar"]),
    ("公寓.jpg",   ["Apartment", "High-rise_building", "Apartment_building"]),
    ("高速.jpg",   ["Highway"]),
]

# 先 1280px 后 800+ 回落,确保优先拿最大缩略图
THUMB_RE_HD = re.compile(
    r"//upload\.wikimedia\.org/wikipedia/commons/thumb/[^\"' ]+\.(?:jpg|jpeg|png)/1280px-[^\"' ]+\.(?:jpg|jpeg|png)",
    re.IGNORECASE,
)
THUMB_RE_ANY = re.compile(
    r"//upload\.wikimedia\.org/wikipedia/commons/thumb/[^\"' ]+\.(?:jpg|jpeg|png)/(?:8\d\d|9\d\d|1[0-4]\d\d)px-[^\"' ]+\.(?:jpg|jpeg|png)",
    re.IGNORECASE,
)


def _fetch_thumb_url(wiki_title: str) -> str | None:
    """返回 HTTPS 直链,None 表示该词条页没可用缩略图。"""
    url = f"https://en.wikipedia.org/wiki/{wiki_title}"
    r = SESSION.get(url, headers=UA, proxies=PROXIES, timeout=30)
    r.raise_for_status()
    m = THUMB_RE_HD.search(r.text) or THUMB_RE_ANY.search(r.text)
    return ("https:" + m.group(0)) if m else None


def _download(img_url: str, retries_on_429: int = 1) -> bytes | None:
    """下载二进制;遇 429 退避重试一次。"""
    for attempt in range(retries_on_429 + 1):
        try:
            img = SESSION.get(img_url, headers=UA, proxies=PROXIES, timeout=60)
            img.raise_for_status()
            return img.content
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code == 429 and attempt < retries_on_429:
                time.sleep(6.0)  # 退避
                continue
            raise
    return None


results = {"ok": [], "skip": [], "fail": []}
for fname, candidates in MAPPING:
    target = BANK / fname
    if target.exists() and target.stat().st_size > 20 * 1024:
        print(f"[SKIP] {fname:12s}  (已存在,{target.stat().st_size // 1024}KB)")
        results["skip"].append(fname)
        continue

    time.sleep(1.5)  # 节流:Wikimedia 对密集请求会 429

    last_err = None
    saved = False
    for wiki in candidates:
        try:
            img_url = _fetch_thumb_url(wiki)
            if not img_url:
                last_err = f"{wiki}: no suitable thumbnail"
                continue
            data = _download(img_url)
            if data:
                target.write_bytes(data)
                kb = len(data) // 1024
                print(f"[OK]   {fname:12s} <- {wiki}  ({kb}KB)")
                results["ok"].append(fname)
                saved = True
                break
        except Exception as e:
            last_err = f"{wiki}: {type(e).__name__}: {e}"
            time.sleep(2.0)  # 失败后稍等再试下一候选
            continue

    if not saved:
        print(f"[FAIL] {fname:12s}  — {last_err}")
        results["fail"].append((fname, last_err))

print()
total = len(MAPPING)
print(f"Summary: OK={len(results['ok'])}  SKIP={len(results['skip'])}  FAIL={len(results['fail'])}  (of {total})")
if results["fail"]:
    print("失败列表:")
    for f, reason in results["fail"]:
        print(f"  - {f}: {reason}")

# 成功 = ok + skip,门槛 80%
ok_total = len(results["ok"]) + len(results["skip"])
sys.exit(0 if ok_total >= total * 0.8 else 1)
