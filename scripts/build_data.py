#!/usr/bin/env python3
"""気象庁の府県予報JSONを取得し、サイト用のデータ(data/)に整形する。GitHub Actions で1時間ごとに動かす。

気象庁の値は加工しない(文字列のまま、並べ直すだけ)。指数の計算は、利用者のブラウザで行う。
どの地域・地点がどう対応するかは config/station_area.json に持ち、このスクリプトは、
取得したJSONがその表と合っているかを確かめる(scripts/inspect_jma.py の check_config を使う)。

出力(--out の下):
    index.json             地方・府県・地域の一覧と、各府県の発表時刻。更新の検知にも使う
    forecast/{府県}.json   府県ごとの予報データ(下記)

forecast/{府県}.json の形:
    {
      "office", "name", "publishingOffice",
      "report":  {"short": 短期の発表時刻, "week": 週間の発表時刻},
      "short": {
        "times":    {"weather": [...], "pops": [...], "temps": [...]},   # 気象庁の timeDefines のまま
        "areas":    {地域コード: {"name", "weatherCodes", "weathers", "winds", "pops"}},
        "stations": {地点コード: {"name", "temps"}}
      },
      "week": {
        "times":    {"weather": [...], "temps": [...]},
        "areas":    {地域コード: {"name", "weatherCodes", "pops", "reliabilities"}},
        "stations": {地点コード: {"name", "tempsMin", "tempsMinUpper", "tempsMinLower",
                                  "tempsMax", "tempsMaxUpper", "tempsMaxLower", "normal": {"min", "max"}}}
      }
    }
    配列は気象庁のまま、times と同じ順に並ぶ。空文字も、そのまま残す。

使い方:
    python3 -I scripts/build_data.py --out _site/data
    python3 -I scripts/build_data.py --out _site/data --previous https://.../data/index.json
        前回の index.json と比べ、発表時刻が変わっていなければ changed=false を出す
    python3 -I scripts/build_data.py --out /tmp/x --offline-dir .cache/jma    # 通信せず、保存済みのJSONで試す

終了コード: 0 = 成功(一部の府県を除外した場合も含む)、1 = 取得に失敗した(前回のデータを残すため、配信しない)。
GitHub Actions では、changed を $GITHUB_OUTPUT に書き、除外した府県を警告に出す。
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import inspect_jma  # noqa: E402  (地域と地点の対応表の検査を共有する)

BASE = "https://www.jma.go.jp/bosai"
AREA_URL = f"{BASE}/common/const/area.json"
FORECAST_URL = f"{BASE}/forecast/data/forecast/{{code}}.json"
USER_AGENT = "tokotoko-index (static site build; contact via the GitHub repository)"
INTERVAL_SEC = 0.5
RETRIES = 3

SOURCE_NOTICE = "出典：気象庁ホームページ。気象庁の予報値を加工して作成。編集責任は当サイトにあります"

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "station_area.json"
PARAMS = json.loads((ROOT / "config" / "params.json").read_text(encoding="utf-8"))
JST = timezone(timedelta(hours=9))


class FetchError(Exception):
    pass


# ---------------------------------------------------------------- 取得

def fetch_json(url):
    last = None
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.loads(res.read())
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last = e
            time.sleep(2 * (attempt + 1))
    raise FetchError(f"{url}: {last}")


def load_source(name, url, offline_dir):
    if offline_dir:
        path = Path(offline_dir) / name
        if not path.exists():
            raise FetchError(f"{path} が無い")
        return json.loads(path.read_text(encoding="utf-8"))
    data = fetch_json(url)
    time.sleep(INTERVAL_SEC)
    return data


# ---------------------------------------------------------------- 整形

def find_series(element, field):
    """要素(短期か週間)から、areas の最初の要素に field がある系列を返す。位置には頼らない。"""
    for ts in element["timeSeries"]:
        if ts["areas"] and field in ts["areas"][0]:
            return ts
    raise ValueError(f"{field} の系列が無い")


def pick(entry, fields):
    return {f: entry[f] for f in fields if f in entry}


def check_short_temps(s_temps, s_stations):
    """短期の気温の時刻が想定どおり(0時=朝の最低、9時=日中の最高の目印)か、最高が最低以上かを確かめる。

    気象庁がこの並びを変えたとき、画面に別の気温を出さないよう、その府県を除外して気付けるようにする。
    """
    allowed = {PARAMS["forecast"]["short_temp_min_hour"], PARAMS["forecast"]["short_temp_max_hour"]}
    hours = [int(t[11:13]) for t in s_temps["timeDefines"]]
    bad = [h for h in hours if h not in allowed]
    if bad:
        raise ValueError(f"短期の気温の時刻が想定と違う(想定 {sorted(allowed)}時、実際 {hours}時)")
    by_date = {}
    for i, t in enumerate(s_temps["timeDefines"]):
        by_date.setdefault(t[:10], {})[int(t[11:13])] = i
    lo, hi = PARAMS["forecast"]["short_temp_min_hour"], PARAMS["forecast"]["short_temp_max_hour"]
    for st in s_stations.values():
        for d, idx in by_date.items():
            if lo in idx and hi in idx:
                tmin, tmax = st["temps"][idx[lo]], st["temps"][idx[hi]]
                if tmin != "" and tmax != "" and float(tmax) < float(tmin):
                    raise ValueError(f"短期の気温で、最高が最低より低い({st['name']} {d}: {tmax} < {tmin})")


def format_office(code, name, data):
    """1つの府県のJSONを、サイト用の形にする。形が想定と違えば、例外を出す。"""
    short, week = data[0], data[1]

    s_weather = find_series(short, "weatherCodes")
    s_pops = find_series(short, "pops")
    s_temps = find_series(short, "temps")
    w_weather = find_series(week, "weatherCodes")
    w_temps = find_series(week, "tempsMax")

    pops_by_area = {a["area"]["code"]: a["pops"] for a in s_pops["areas"]}
    s_areas = {}
    for a in s_weather["areas"]:
        ac = a["area"]["code"]
        if ac not in pops_by_area:
            raise ValueError(f"短期の降水確率に地域 {ac} が無い")
        s_areas[ac] = {"name": a["area"]["name"], **pick(a, ["weatherCodes", "weathers", "winds"]),
                       "pops": pops_by_area[ac]}

    s_stations = {a["area"]["code"]: {"name": a["area"]["name"], "temps": a["temps"]} for a in s_temps["areas"]}
    check_short_temps(s_temps, s_stations)

    w_areas = {}
    for a in w_weather["areas"]:
        w_areas[a["area"]["code"]] = {"name": a["area"]["name"],
                                       **pick(a, ["weatherCodes", "pops", "reliabilities"])}

    normals = {a["area"]["code"]: {"min": a.get("min", ""), "max": a.get("max", "")}
               for a in week.get("tempAverage", {}).get("areas", [])}
    temp_fields = ["tempsMin", "tempsMinUpper", "tempsMinLower", "tempsMax", "tempsMaxUpper", "tempsMaxLower"]
    w_stations = {}
    for a in w_temps["areas"]:
        sc = a["area"]["code"]
        w_stations[sc] = {"name": a["area"]["name"], **pick(a, temp_fields), "normal": normals.get(sc)}

    return {
        "office": code,
        "name": name,
        "publishingOffice": short.get("publishingOffice", ""),
        "report": {"short": short["reportDatetime"], "week": week["reportDatetime"]},
        "short": {
            "times": {"weather": s_weather["timeDefines"], "pops": s_pops["timeDefines"],
                      "temps": s_temps["timeDefines"]},
            "areas": s_areas,
            "stations": s_stations,
        },
        "week": {
            "times": {"weather": w_weather["timeDefines"], "temps": w_temps["timeDefines"]},
            "areas": w_areas,
            "stations": w_stations,
        },
    }


def validate_against_config(code, raw, formatted, config):
    """取得したJSONが、config/station_area.json の表と合っているか。合っていなければ、理由の一覧を返す。"""
    one = {"offices": {code: config["offices"][code]}, "stations": config["stations"]}
    result = inspect_jma.analyze_office(code, AREA_JSON_FOR_CHECK, raw)
    problems = list(result["issues"])
    problems += inspect_jma.check_config(one, {code: result}, {code: raw})
    return problems


AREA_JSON_FOR_CHECK = None  # main() で設定する(analyze_office が area.json を使うため)


# ---------------------------------------------------------------- 一覧・更新の検知

def build_index(area_json, formatted, excluded, generated_at):
    offices = {}
    for code, f in formatted.items():
        offices[code] = {
            "name": f["name"],
            "center": area_json["offices"][code]["parent"],
            "areas": [{"code": c, "name": a["name"]} for c, a in f["short"]["areas"].items()],
            "report": f["report"],
        }
    centers = []
    for ccode, c in area_json["centers"].items():
        members = [o for o in c.get("children", []) if o in offices]
        if members:
            centers.append({"code": ccode, "name": c["name"], "offices": members})
    return {
        "version": 1,
        "generatedAt": generated_at,
        "source": SOURCE_NOTICE,
        "centers": centers,
        "offices": offices,
        "excluded": excluded,
    }


def report_times(index):
    return {code: o["report"] for code, o in index.get("offices", {}).items()}


def load_previous(location):
    if not location:
        return None
    try:
        if location.startswith(("http://", "https://")):
            req = urllib.request.Request(location, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.loads(res.read())
        return json.loads(Path(location).read_text(encoding="utf-8"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError, TimeoutError):
        return None  # 前回が無い・読めないときは、更新ありとして扱う


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


# ---------------------------------------------------------------- main

def main():
    global AREA_JSON_FOR_CHECK
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="出力先(例: _site/data)")
    ap.add_argument("--previous", help="前回の index.json のURLかパス。発表時刻が同じなら changed=false")
    ap.add_argument("--offline-dir", help="通信せず、このフォルダの保存済みJSON(inspect_jma.py の .cache/jma)を使う")
    args = ap.parse_args()
    out = Path(args.out)

    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    try:
        area_json = load_source("area.json", AREA_URL, args.offline_dir)
        AREA_JSON_FOR_CHECK = area_json
        formatted, excluded = {}, {}
        for code in sorted(config["offices"]):
            raw = load_source(f"{code}.json", FORECAST_URL.format(code=code), args.offline_dir)
            name = config["offices"][code]["name"]
            try:
                f = format_office(code, name, raw)
                problems = validate_against_config(code, raw, f, config)
            except (KeyError, ValueError, IndexError, TypeError) as e:
                problems = [f"形が想定と違う: {type(e).__name__}: {e}"]
            if problems:
                excluded[code] = {"name": name, "reasons": problems[:5]}
                print(f"::warning::{code}{name} を除外: {'; '.join(problems[:3])}")
                continue
            formatted[code] = f
    except FetchError as e:
        print(f"::error::取得に失敗した: {e}", file=sys.stderr)
        return 1

    if not formatted:
        print("::error::使える府県が1件も無い", file=sys.stderr)
        return 1

    generated_at = datetime.now(JST).isoformat(timespec="seconds")
    index = build_index(area_json, formatted, excluded, generated_at)

    previous = load_previous(args.previous)
    changed = previous is None or report_times(previous) != report_times(index)

    for code, f in formatted.items():
        write_json(out / "forecast" / f"{code}.json", f)
    write_json(out / "index.json", index)

    print(f"府県 {len(formatted)}件を書き出した(除外 {len(excluded)}件)。更新あり: {changed}")
    gh_output = os.environ.get("GITHUB_OUTPUT")
    if gh_output:
        with open(gh_output, "a", encoding="utf-8") as fh:
            fh.write(f"changed={'true' if changed else 'false'}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
