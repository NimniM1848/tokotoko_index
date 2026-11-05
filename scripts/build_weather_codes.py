#!/usr/bin/env python3
"""気象庁の天気コード表から、晴れ度と雨・雪・雷のフラグの対応表(config/weather_codes.json)を作る。

元データ: 気象庁の予報ページが使っている天気コード表(forecast_const.js の TELOPS)。
  https://www.jma.go.jp/bosai/forecast/js/forecast_const.js
コードごとの日本語の天気名は、気象庁の表のまま使う。ここで決めるのは、天気名から導く次の4つだけ。

  sunny   晴れ度。晴れ系を1、晴れと曇りなどの混在を0.5、曇り・雨・雪を0とする(DESIGN.md 第4章)
  rain    雨を含む(みぞれも含める)
  snow    雪を含む(みぞれも含める)
  thunder 雷を含む

晴れ度は、天気名の文字から、下の `sunny_of()` の規則で決める。規則で決めにくいものだけ
`SUNNY_OVERRIDE` で直接決める。気象庁の天気の判断を変えるものではなく、
日差しによる暑さの補正(DESIGN.md の T' = Tmax + 2 × s)に使う目安である。

使い方:
    python3 -I scripts/build_weather_codes.py             # 表を作って config/weather_codes.json に書く
    python3 -I scripts/build_weather_codes.py --refresh   # 気象庁から取得し直す
"""

import argparse
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

URL = "https://www.jma.go.jp/bosai/forecast/js/forecast_const.js"
USER_AGENT = "tokotoko-index-inspector (static site data check)"

ROOT = Path(__file__).resolve().parent.parent
CONST_CACHE = ROOT / ".cache" / "jma_const" / "forecast_const.js"
FORECAST_CACHE = ROOT / ".cache" / "jma"
OUT = ROOT / "config" / "weather_codes.json"

# 規則で決めにくいもの。コード → 晴れ度
SUNNY_OVERRIDE = {
    "130": 1,  # 朝の内霧後晴: 霧は降水ではなく、日中は晴れ
}

# 表にない天気コードが来たときの値(中間にしておき、暑さの補正を強くも弱くもしない)
DEFAULT = {"sunny": 0.5, "rain": False, "snow": False, "thunder": False}


def load_table(refresh):
    if refresh or not CONST_CACHE.exists():
        CONST_CACHE.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(URL, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=30) as res:
            CONST_CACHE.write_bytes(res.read())
        time.sleep(0.5)
    text = CONST_CACHE.read_text(encoding="utf-8")
    # '100': ['100.svg', '500.svg', '100', '晴', 'CLEAR'],  → 天気コード、天気名
    rows = re.findall(r"'(\d{3})':\s*\['[^']*',\s*'[^']*',\s*'\d+',\s*'([^']*)'", text)
    if not rows:
        sys.exit("天気コード表を読み取れない(気象庁のファイルの形が変わった可能性がある)")
    return dict(rows)


def has_precip(name):
    return any(k in name for k in ("雨", "雪", "雷", "みぞれ"))


def sunny_of(code, name):
    """天気名から晴れ度(0、0.5、1)を決める。"""
    if code in SUNNY_OVERRIDE:
        return SUNNY_OVERRIDE[code]
    if "晴" not in name:
        return 0  # 曇、雨、雪、霧など
    if "曇" in name:
        return 0.5  # 晴れと曇りの混在(晴時々曇、曇後晴 など)
    if not name.startswith("晴"):
        # 雨時々晴、雨後晴 など。晴れは一部。ただし夜だけ晴れるものは日差しに関係しない
        return 0 if "夜は晴" in name else 0.5
    # 晴れで始まり、曇りを含まない
    if has_precip(name) and any(k in name for k in ("後", "から", "午後")):
        return 0.5  # 晴後雨、晴昼頃から雨 など。後半は降る
    return 1  # 晴、晴一時雨、晴夜は雨、晴山沿い雷雨 など


def flags_of(name):
    return {
        "rain": "雨" in name or "みぞれ" in name,
        "snow": "雪" in name or "みぞれ" in name,
        "thunder": "雷" in name,
    }


def seen_codes():
    """取得済みの府県予報JSON(検証用の .cache/jma/)に出てくる天気コード。"""
    seen = set()
    for f in FORECAST_CACHE.glob("[0-9]*.json"):
        for el in json.loads(f.read_text(encoding="utf-8")):
            for ts in el["timeSeries"]:
                for a in ts["areas"]:
                    seen.update(a.get("weatherCodes", []))
    return seen


def self_test(table):
    """DESIGN.md の前提と、判断が分かれやすい例を確かめる。"""
    expect = {
        "100": 1, "101": 0.5, "200": 0, "201": 0.5, "300": 0, "400": 0,
        "102": 1, "111": 0.5, "114": 0.5, "125": 0.5, "128": 1, "123": 1,
        "211": 0.5, "301": 0.5, "311": 0.5, "325": 0, "130": 1, "209": 0,
    }
    bad = [(c, table[c], sunny_of(c, table[c]), v) for c, v in expect.items() if sunny_of(c, table[c]) != v]
    if bad:
        sys.exit(f"自己検査に失敗: {bad}")
    assert flags_of(table["304"]) == {"rain": True, "snow": True, "thunder": False}  # 雨か雪
    assert flags_of(table["329"]) == {"rain": True, "snow": True, "thunder": False}  # 雨一時みぞれ
    assert flags_of(table["350"]) == {"rain": True, "snow": False, "thunder": True}  # 雨で雷を伴う
    assert flags_of(table["407"]) == {"rain": False, "snow": True, "thunder": False}  # 暴風雪
    assert flags_of(table["100"]) == {"rain": False, "snow": False, "thunder": False}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true", help="気象庁から天気コード表を取得し直す")
    args = ap.parse_args()

    table = load_table(args.refresh)
    self_test(table)
    seen = seen_codes()

    unknown = sorted(seen - set(table))
    if unknown:
        print(f"! 取得済みのJSONにあるが、表にない天気コード: {unknown}", file=sys.stderr)

    codes = {}
    for code in sorted(table):
        name = table[code]
        codes[code] = {"name": name, "sunny": sunny_of(code, name), **flags_of(name)}
        if code in seen:
            codes[code]["seen"] = True

    out = {
        "_説明": [
            "気象庁の天気コード表(forecast_const.js の TELOPS)をもとに、scripts/build_weather_codes.py で作った。",
            "name は気象庁の天気名のまま。sunny(晴れ度)、rain、snow、thunder は、天気名から規則で決めた目安。",
            "sunny: 晴れ系1、晴れと曇りなどの混在0.5、曇り・雨・雪0。日差しによる暑さの補正にだけ使う。",
            "rain、snow: みぞれは両方を立てる。雪と雷は減点せず、注意のバッジで知らせる。",
            "seen: 2026-11-05に取得したJSONに出てきたコード。",
            "default: 表にない天気コードが来たときの値。",
            "仮置き。実データを見ながら調整する。",
        ],
        "default": DEFAULT,
        "codes": codes,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    # 1コード1行にして、差分と目視確認をしやすくする
    lines = ["{", '  "_説明": [']
    lines += [("    " + json.dumps(t, ensure_ascii=False) + ",") for t in out["_説明"][:-1]]
    lines += ["    " + json.dumps(out["_説明"][-1], ensure_ascii=False), "  ],"]
    lines += ['  "default": ' + json.dumps(DEFAULT, ensure_ascii=False) + ",", '  "codes": {']
    items = [f'    "{c}": ' + json.dumps(v, ensure_ascii=False) for c, v in codes.items()]
    lines += [",\n".join(items), "  }", "}"]
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    json.loads(OUT.read_text(encoding="utf-8"))  # 書いたものが正しいJSONか

    n_seen = sum(1 for v in codes.values() if v.get("seen"))
    print(f"天気コード {len(codes)}種類を書き出した: {OUT.relative_to(ROOT)}(2026-11-05のJSONに出たもの: {n_seen}種類)")
    print("\n出現した天気コードの対応(確認用):")
    print(f"  {'コード':<5}{'晴れ度':<6}{'雨':<3}{'雪':<3}{'雷':<3}天気名")
    for c, v in codes.items():
        if v.get("seen"):
            print(f"  {c:<6}{v['sunny']:<8}{'○' if v['rain'] else '-':<3}{'○' if v['snow'] else '-':<3}"
                  f"{'○' if v['thunder'] else '-':<3}{v['name']}")


if __name__ == "__main__":
    main()
