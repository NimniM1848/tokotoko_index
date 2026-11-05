#!/usr/bin/env python3
"""気象庁の府県予報JSON(全58府県予報区)の構造を検証するスクリプト。

DESIGN.md 第3章の内容を、生のJSONで確かめるために使う。
サイト本体では使わない。結果を見て、整形処理や設計書を直す材料にする。

使い方:
    python3 -I scripts/inspect_jma.py            # 取得して検証(結果は .cache/jma/ に保存)
    python3 -I scripts/inspect_jma.py --offline  # 保存済みのJSONだけで検証(通信しない)

標準ライブラリだけで動く。取得は1件ずつ、間隔をあけて行う(気象庁のサーバーに負荷をかけない)。
JSONの値は加工せずに読むだけで、保存するのも取得したままの内容である。
"""

import argparse
import collections
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = "https://www.jma.go.jp/bosai"
AREA_URL = f"{BASE}/common/const/area.json"
FORECAST_URL = f"{BASE}/forecast/data/forecast/{{code}}.json"
USER_AGENT = "tokotoko-index-inspector (static site data check)"
INTERVAL_SEC = 0.5

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / ".cache" / "jma"


# ---------------------------------------------------------------- 取得

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as res:
        return res.read()


def load_json(name, url, offline):
    """キャッシュ(取得したままの生のバイト列)を使い、無ければ取得する。"""
    path = CACHE_DIR / name
    if offline:
        if not path.exists():
            return None, "キャッシュなし"
        return json.loads(path.read_bytes()), None
    try:
        raw = fetch(url)
        time.sleep(INTERVAL_SEC)
    except (urllib.error.URLError, TimeoutError) as e:
        return None, f"取得失敗: {e}"
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return json.loads(raw), None


# ---------------------------------------------------------------- 解析

def area_kind(area_entry):
    """areas の1要素が持つデータ項目(area以外のキー)を、並べ替えて返す。"""
    return tuple(sorted(k for k in area_entry if k != "area"))


def describe_series(ts):
    """timeSeries の1本を要約する。"""
    areas = ts.get("areas", [])
    kinds = collections.Counter(area_kind(a) for a in areas)
    return {
        "ts_keys": sorted(ts.keys()),
        "n_times": len(ts.get("timeDefines", [])),
        "n_areas": len(areas),
        "kinds": [list(k) for k in kinds],  # 地域ごとに項目が違えば複数になる
        "codes": [a["area"]["code"] for a in areas],
        "names": [a["area"]["name"] for a in areas],
    }


def empties(values):
    """値のうち、空文字・Noneの件数を数える。"""
    return sum(1 for v in values if v in ("", None))


def analyze_office(code, area_json, data):
    """1つの府県予報区のJSONを調べ、要約を返す。"""
    offices = area_json["offices"]
    class10s = area_json["class10s"]
    res = {"code": code, "name": offices[code]["name"], "issues": []}
    issue = res["issues"].append

    if not isinstance(data, list):
        issue(f"トップが配列ではない({type(data).__name__})")
        return res
    res["n_elements"] = len(data)
    if len(data) != 2:
        issue(f"トップの配列の長さが2ではない({len(data)})")
    if len(data) < 2:
        return res

    short, week = data[0], data[1]
    res["el_keys"] = [sorted(short.keys()), sorted(week.keys())]
    res["publishing_office"] = [short.get("publishingOffice"), week.get("publishingOffice")]
    res["report"] = [short.get("reportDatetime"), week.get("reportDatetime")]
    res["report_same"] = res["report"][0] == res["report"][1]

    for key in ("reportDatetime", "timeSeries"):
        for i, el in enumerate((short, week)):
            if key not in el:
                issue(f"要素{i}に {key} がない")
    for key in ("tempAverage", "precipAverage"):
        if key not in week:
            issue(f"要素1に {key} がない")
        if key in short:
            issue(f"要素0に {key} がある(想定外)")

    s_series = [describe_series(ts) for ts in short.get("timeSeries", [])]
    w_series = [describe_series(ts) for ts in week.get("timeSeries", [])]
    res["short_series"] = s_series
    res["week_series"] = w_series

    # 短期: 天気・降水確率・気温の3本が、この順に並ぶか
    s_kind_order = [s["kinds"][0] if s["kinds"] else [] for s in s_series]
    res["short_order"] = [
        "weather" if "weatherCodes" in k else
        "pops" if "pops" in k else
        "temps" if "temps" in k else "?" for k in s_kind_order
    ]
    w_kind_order = [w["kinds"][0] if w["kinds"] else [] for w in w_series]
    res["week_order"] = [
        "weather" if "weatherCodes" in k else
        "temps" if "tempsMax" in k else "?" for k in w_kind_order
    ]

    # weatherCodes の位置(areas の中か、timeSeries の直下か)
    wc_where = set()
    for ts in short.get("timeSeries", []):
        if "weatherCodes" in ts:
            wc_where.add("短期:timeSeries直下")
        if any("weatherCodes" in a for a in ts.get("areas", [])):
            wc_where.add("短期:areasの中")
    for ts in week.get("timeSeries", []):
        if "weatherCodes" in ts:
            wc_where.add("週間:timeSeries直下")
        if any("weatherCodes" in a for a in ts.get("areas", [])):
            wc_where.add("週間:areasの中")
    res["weathercodes_where"] = sorted(wc_where)

    # ---- 短期の地域と週間の地域の対応
    s_weather = next((s for s, o in zip(s_series, res["short_order"]) if o == "weather"), None)
    w_weather = next((s for s, o in zip(w_series, res["week_order"]) if o == "weather"), None)
    if s_weather and w_weather:
        s_codes, w_codes = s_weather["codes"], w_weather["codes"]
        res["short_area_codes"] = s_codes
        res["week_area_codes"] = w_codes
        # 週間の地域は、短期の地域と同じコードか、親(府県予報区)のコードか、
        # area.json にない「まとめ地域」(例: 下北・三八上北)のどれか。
        # まとめ地域は名前の「・」区切りで、どの短期の地域を含むかを推定する。
        s_names = dict(zip(s_codes, s_weather["names"]))
        w_names = dict(zip(w_codes, w_weather["names"]))
        mapping = {}
        cover_of = {}  # 短期の地域コード → それを含む週間の地域コード
        for sc in s_codes:
            parent = class10s.get(sc, {}).get("parent")
            if sc in w_codes:
                mapping[sc] = f"同じコード({sc})"
                cover_of[sc] = sc
                continue
            if parent in w_codes:
                mapping[sc] = f"親のコード({parent})"
                cover_of[sc] = parent
                continue
            hit = None
            for wc, wn in w_names.items():
                if wc in s_codes or wc in offices:
                    continue
                parts = wn.replace("地方", "").split("・")
                if any(s_names[sc].startswith(p) for p in parts if p):
                    hit = wc
                    break
            mapping[sc] = f"まとめ地域({hit} {w_names[hit]}。名前から推定)" if hit else None
            if hit:
                cover_of[sc] = hit
        res["area_mapping"] = mapping
        res["week_covers"] = {wc: [sc for sc in s_codes if cover_of.get(sc) == wc] for wc in w_codes}
        res["week_area_names"] = w_names
        res["short_area_names"] = s_names
        res["week_grouped_codes"] = [wc for wc in w_codes
                                     if wc not in s_codes and wc not in class10s and wc not in offices]
        unmatched = [sc for sc, m in mapping.items() if m is None]
        if unmatched:
            issue(f"短期の地域のうち週間と対応が付かないもの: {unmatched}")
        if len(w_temps_codes := [w["codes"] for w, o in zip(w_series, res["week_order"]) if o == "temps"][0:1]):
            if len(w_temps_codes[0]) != len(w_codes):
                issue(f"週間の気温の地点数({len(w_temps_codes[0])})と週間の地域数({len(w_codes)})が違う")
        if set(s_codes) == set(w_codes):
            res["area_relation"] = "短期と週間で同じ地域"
        elif w_codes == [code]:
            res["area_relation"] = "週間は府県予報区で1つにまとまる"
        else:
            res["area_relation"] = "一部が違う"
    else:
        issue("天気の系列が見つからない(短期か週間)")

    # ---- 気温の観測地点の対応
    s_temps = next((s for s, o in zip(s_series, res["short_order"]) if o == "temps"), None)
    w_temps = next((s for s, o in zip(w_series, res["week_order"]) if o == "temps"), None)
    if s_temps and w_temps:
        res["short_temp_points"] = s_temps["codes"]
        res["week_temp_points"] = w_temps["codes"]
        if set(s_temps["codes"]) != set(w_temps["codes"]):
            res["temp_points_differ"] = {
                "短期だけ": sorted(set(s_temps["codes"]) - set(w_temps["codes"])),
                "週間だけ": sorted(set(w_temps["codes"]) - set(s_temps["codes"])),
            }

    # ---- 値の中身
    detail = {}
    for ts in short.get("timeSeries", []):
        for a in ts.get("areas", []):
            n = len(ts["timeDefines"])
            for field in ("weatherCodes", "weathers", "winds", "waves", "pops", "temps"):
                if field in a and len(a[field]) != n:
                    issue(f"短期 {a['area']['name']} の {field} の長さ({len(a[field])})が時刻の数({n})と違う")
    for ts in week.get("timeSeries", []):
        for a in ts.get("areas", []):
            n = len(ts["timeDefines"])
            for field in ("weatherCodes", "pops", "reliabilities", "tempsMin", "tempsMinUpper",
                          "tempsMinLower", "tempsMax", "tempsMaxUpper", "tempsMaxLower"):
                if field in a and len(a[field]) != n:
                    issue(f"週間 {a['area']['name']} の {field} の長さ({len(a[field])})が時刻の数({n})と違う")

    # 週間の空文字の位置(先頭に何件あるか)と、信頼度の有無の位置
    lead_empty = collections.defaultdict(set)
    rel_pattern = set()
    for ts in week.get("timeSeries", []):
        for a in ts.get("areas", []):
            for field in ("pops", "tempsMin", "tempsMax", "tempsMinUpper", "tempsMaxLower"):
                if field in a:
                    vals = a[field]
                    lead = next((i for i, v in enumerate(vals) if v not in ("", None)), len(vals))
                    lead_empty[field].add(lead)
            if "reliabilities" in a:
                rel_pattern.add("".join(v if v else "-" for v in a["reliabilities"]))
    detail["week_leading_empty"] = {k: sorted(v) for k, v in lead_empty.items()}
    detail["week_reliability_patterns"] = sorted(rel_pattern)

    # 週間の時刻数と、先頭日・末尾日
    for ts, o in zip(week.get("timeSeries", []), res["week_order"]):
        if ts.get("timeDefines"):
            detail[f"week_{o}_dates"] = [ts["timeDefines"][0][:10], ts["timeDefines"][-1][:10],
                                          len(ts["timeDefines"])]

    # 短期の降水確率の時刻(何時始まりで何件か)
    for ts, o in zip(short.get("timeSeries", []), res["short_order"]):
        if o == "pops":
            detail["short_pops_times"] = [t[5:16] for t in ts["timeDefines"]]
        if o == "weather":
            detail["short_weather_times"] = [t[5:16] for t in ts["timeDefines"]]
        if o == "temps":
            detail["short_temps_times"] = [t[5:16] for t in ts["timeDefines"]]
    res["detail"] = detail

    # 末尾の平年値
    for key in ("tempAverage", "precipAverage"):
        v = week.get(key)
        if v is None:
            continue
        sub = collections.Counter()
        for a in v.get("areas", []):
            sub[tuple(sorted(k for k in a if k != "area"))] += 1
        res[key] = {
            "keys": sorted(v.keys()),
            "n_areas": len(v.get("areas", [])),
            "area_codes": [a["area"]["code"] for a in v.get("areas", [])],
            "fields": [list(k) for k in sub],
        }
        if key == "tempAverage":
            tp = res.get("week_temp_points", [])
            av = res[key]["area_codes"]
            if tp and set(av) != set(tp):
                issue(f"tempAverage の地点({av})が週間気温の地点({tp})と違う")

    # ---- 天気コード・風の文言の収集
    codes = collections.Counter()
    winds = []
    for el, label in ((short, "短期"), (week, "週間")):
        for ts in el.get("timeSeries", []):
            for a in ts.get("areas", []):
                for c in a.get("weatherCodes", []):
                    codes[(label, c)] += 1
                for w in a.get("winds", []):
                    winds.append(w)
    res["_weather_codes"] = {f"{l}:{c}": n for (l, c), n in codes.items()}
    res["_winds"] = winds
    return res


# ---------------------------------------------------------------- 設定ファイルの検査

CONFIG_PATH = ROOT / "config" / "station_area.json"


def series_areas(el, field):
    """要素(短期か週間)の中から、areas の最初の要素に field がある系列の areas を返す。"""
    for ts in el.get("timeSeries", []):
        areas = ts.get("areas", [])
        if areas and field in areas[0]:
            return areas
    return []


def check_config(config, results, raw):
    """config/station_area.json が、取得したJSONと食い違っていないかを調べる。

    気象庁がJSONの地域や地点を増減・改名したときに、対応表の直し忘れに気付くための検査。
    """
    problems = []
    cfg_offices = config["offices"]
    stations = config["stations"]
    for code in sorted(set(cfg_offices) - set(raw)):
        problems.append(f"{code}: 設定にあるが、JSONが無い")
    for code, data in sorted(raw.items()):
        entry = cfg_offices.get(code)
        if entry is None:
            problems.append(f"{code}: JSONにあるが、設定に無い")
            continue
        s_areas = series_areas(data[0], "weatherCodes")
        s_temps = series_areas(data[0], "temps")
        w_areas = series_areas(data[1], "weatherCodes")
        w_temps = series_areas(data[1], "tempsMax")
        tag = f"{code}{entry['name']}"

        # 短期: 地域が一致し、地点が漏れも重複もなく割り当てられている
        json_s = {a["area"]["code"]: a["area"]["name"] for a in s_areas}
        cfg_s = {c: v["name"] for c, v in entry["short"].items()}
        if json_s != cfg_s:
            problems.append(f"{tag}: 短期の地域が違う(JSON {json_s} / 設定 {cfg_s})")
        json_st = {a["area"]["code"]: a["area"]["name"] for a in s_temps}
        assigned = [c for v in entry["short"].values() for c in v["stations"]]
        if sorted(assigned) != sorted(json_st):
            problems.append(f"{tag}: 短期の地点が違う(JSONだけ {sorted(set(json_st) - set(assigned))}"
                            f" / 設定だけ {sorted(set(assigned) - set(json_st))}"
                            f" / 重複 {sorted({c for c in assigned if assigned.count(c) > 1})})")
        for c in assigned:
            if c in json_st and stations.get(c) != json_st[c]:
                problems.append(f"{tag}: 地点 {c} の名前が違う(JSON {json_st[c]} / 設定 {stations.get(c)})")
        for sc, v in entry["short"].items():
            if not v["stations"]:
                problems.append(f"{tag}: 短期の地域 {sc}{v['name']} に地点が無い")

        # 週間: 地域・地点が一致し、含む短期の地域が推定と同じで、地点が含む地域の地点の中にある
        json_w = {a["area"]["code"]: a["area"]["name"] for a in w_areas}
        cfg_w = {c: v["name"] for c, v in entry["week"].items()}
        if json_w != cfg_w:
            problems.append(f"{tag}: 週間の地域が違う(JSON {json_w} / 設定 {cfg_w})")
        json_wt = [a["area"]["code"] for a in w_temps]
        cfg_wt = [v["station"] for v in entry["week"].values()]
        if sorted(json_wt) != sorted(cfg_wt):
            problems.append(f"{tag}: 週間の地点が違う(JSON {json_wt} / 設定 {cfg_wt})")
        inferred = results[code].get("week_covers", {})
        for wc, v in entry["week"].items():
            if sorted(v["covers"]) != sorted(inferred.get(wc, [])):
                problems.append(f"{tag}: 週間 {wc}{v['name']} が含む短期の地域が、名前からの推定と違う"
                                f"(設定 {v['covers']} / 推定 {inferred.get(wc)})")
            pool = [c for sc in v["covers"] for c in entry["short"].get(sc, {}).get("stations", [])]
            if v["station"] not in pool:
                problems.append(f"{tag}: 週間 {wc}{v['name']} の地点 {v['station']} が、含む短期の地域の地点に無い")
        covered = [sc for v in entry["week"].values() for sc in v["covers"]]
        if sorted(covered) != sorted(entry["short"]):
            problems.append(f"{tag}: 週間の covers が、短期の地域を漏れ・重複なく覆っていない")
    return problems


# ---------------------------------------------------------------- 出力

def signature(res):
    """府県予報区の「形」。同じなら同じ形として束ねる。地域数や時刻数は含めない。"""
    return json.dumps({
        "n_elements": res.get("n_elements"),
        "el_keys": res.get("el_keys"),
        "short_order": res.get("short_order"),
        "week_order": res.get("week_order"),
        "wc": res.get("weathercodes_where"),
        "series_keys": [s["kinds"] for s in res.get("short_series", [])]
                       + [s["kinds"] for s in res.get("week_series", [])],
        "ts_keys": [s["ts_keys"] for s in res.get("short_series", [])]
                   + [s["ts_keys"] for s in res.get("week_series", [])],
        "avg": [res.get("tempAverage", {}).get("fields"), res.get("precipAverage", {}).get("fields")],
    }, ensure_ascii=False, sort_keys=True)


def section(title):
    print()
    print("=" * 70)
    print(title)
    print("=" * 70)


def report(results, missing):
    ok = [r for r in results if "n_elements" in r]
    section(f"1. 取得結果: {len(results)}件を検証(取得できなかったもの: {len(missing)}件)")
    for code, why in missing:
        covered = [f"{r['code']}{r['name']}" for r in ok if code in r.get("short_area_codes", [])]
        print(f"  {code}: {why}。この地域は次のファイルの短期の地域に含まれる: {covered or 'なし'}")

    section("2. JSONの「形」ごとの分類(キー構成・系列の順序・weatherCodesの位置など)")
    groups = collections.defaultdict(list)
    for r in ok:
        groups[signature(r)].append(r)
    ordered = sorted(groups.items(), key=lambda kv: -len(kv[1]))
    for i, (sig, members) in enumerate(ordered, 1):
        print(f"\n[形{i}] {len(members)}件")
        names = [f"{m['code']}{m['name']}" for m in members]
        print("  該当: " + "、".join(names if len(names) <= 12 else names[:12] + [f"ほか{len(names) - 12}件"]))
        s = json.loads(sig)
        print(f"  トップの要素数: {s['n_elements']}")
        print(f"  要素0のキー: {s['el_keys'][0]}")
        print(f"  要素1のキー: {s['el_keys'][1]}")
        print(f"  短期の系列の順序: {s['short_order']} / 週間: {s['week_order']}")
        print(f"  weatherCodesの位置: {s['wc']}")
        print(f"  areasの項目(系列ごと): {s['series_keys']}")
        print(f"  平年値の項目: {s['avg']}")
    if len(ordered) > 1:
        print("\n  → 形が複数ある。整形処理は、ここに出た差異を吸収する必要がある。")

    section("3. reportDatetime(要素0と要素1の発表時刻)")
    diff = [r for r in ok if not r["report_same"]]
    print(f"  要素0と要素1が同じ: {len(ok) - len(diff)}件 / 違う: {len(diff)}件")
    for r in diff:
        print(f"    {r['code']}{r['name']}: 短期 {r['report'][0]} / 週間 {r['report'][1]}")
    short_times = collections.Counter(r["report"][0][11:16] for r in ok)
    week_times = collections.Counter(r["report"][1][11:16] for r in ok)
    print(f"  短期の発表時刻(時:分)の分布: {dict(sorted(short_times.items()))}")
    print(f"  週間の発表時刻(時:分)の分布: {dict(sorted(week_times.items()))}")
    pub_same = sum(1 for r in ok if r["publishing_office"][0] == r["publishing_office"][1])
    pubs = collections.Counter(r["publishing_office"][0] for r in ok)
    print(f"  publishingOffice は要素0と要素1で同じ: {pub_same}件 / {len(ok)}件。"
          f"値は各地の気象台名({len(pubs)}種類。例: {list(pubs)[:3]})。東京都は「気象庁」")

    section("4. 短期の地域と週間の地域の対応")
    grouped = {(r["code"], c): r["week_area_names"][c] for r in ok for c in r.get("week_grouped_codes", [])}
    print(f"  area.json にない週間の「まとめ地域」: {len(grouped)}件")
    for (off, c), n in grouped.items():
        print(f"    {off} の {c} {n}")
    print()
    rel = collections.defaultdict(list)
    for r in ok:
        rel[r.get("area_relation", "判定不能")].append(r)
    for k, v in rel.items():
        print(f"  {k}: {len(v)}件")
    print()
    print("  地域ごとの対応の一覧(短期の地域 → 週間の地域):")
    for r in ok:
        mp = r.get("area_mapping", {})
        # 全地域が「同じコード」の府県は省略して見やすくする
        if mp and all(m and m.startswith("同じコード") for m in mp.values()):
            continue
        print(f"    {r['code']}{r['name']}: 週間の地域={[(c, n) for c, n in r.get('week_area_names', {}).items()]}")
        for sc, m in mp.items():
            print(f"        {sc} → {m}")
    print("  (上に出ていない府県は、短期と週間の地域コードがすべて一致)")

    section("5. weatherCodes の位置")
    where = collections.Counter(tuple(r["weathercodes_where"]) for r in ok)
    for k, n in where.items():
        print(f"  {list(k)}: {n}件")
    for r in ok:
        if "短期:areasの中" not in r["weathercodes_where"]:
            print(f"  ! {r['code']}{r['name']}: 短期のweatherCodesが areas の中にない {r['weathercodes_where']}")

    section("6. 気温の観測地点(短期と週間の対応、平年値の地点)")
    n_diff = 0
    for r in ok:
        d = r.get("temp_points_differ")
        if d:
            n_diff += 1
            print(f"  {r['code']}{r['name']}: 短期だけ {d['短期だけ']} / 週間だけ {d['週間だけ']}")
    print(f"  短期と週間で地点が違う府県: {n_diff}件 / {len(ok)}件")
    avg_counts = collections.Counter(r.get("tempAverage", {}).get("n_areas") for r in ok)
    print(f"  tempAverage の地点数の分布: {dict(sorted(avg_counts.items(), key=lambda kv: str(kv[0])))}")
    print(f"  tempAverage の項目: {collections.Counter(json.dumps(r.get('tempAverage', {}).get('fields')) for r in ok)}")

    section("7. 値の並び(空文字の位置、信頼度、日付範囲、時刻)")
    lead = collections.defaultdict(collections.Counter)
    for r in ok:
        for field, vals in r["detail"].get("week_leading_empty", {}).items():
            lead[field][tuple(vals)] += 1
    print("  週間の先頭の空文字の件数(項目 → 件数の組み合わせ: 府県数):")
    for field, c in lead.items():
        print(f"    {field}: {dict(c)}")
    pats = collections.Counter()
    for r in ok:
        for p in r["detail"].get("week_reliability_patterns", []):
            pats[p] += 1
    print(f"  週間の信頼度のパターン('-'は空)の種類: {dict(pats.most_common(8))}")
    for key in ("week_weather_dates", "week_temps_dates"):
        c = collections.Counter(tuple(r["detail"].get(key, [])) for r in ok)
        print(f"  {key}(先頭日, 末尾日, 件数): {dict(c.most_common(4))}")
    for key in ("short_pops_times", "short_weather_times", "short_temps_times"):
        c = collections.Counter(tuple(r["detail"].get(key, [])) for r in ok)
        print(f"  {key}:")
        for k, n in c.most_common(6):
            print(f"      {n}件: {list(k)}")

    section("8. 項目の長さの不一致・想定外(各府県の issues)")
    any_issue = False
    for r in results:
        for msg in r["issues"]:
            any_issue = True
            print(f"  {r['code']}{r['name']}: {msg}")
    if not any_issue:
        print("  なし")

    section("9. 天気コードの種類(次の作業「晴れ度と雨雪フラグの対応表」の入力)")
    codes = collections.Counter()
    for r in ok:
        for k, n in r["_weather_codes"].items():
            codes[k.split(":")[1]] += n
    print(f"  種類: {len(codes)}")
    print("  " + ", ".join(f"{c}({n})" for c, n in sorted(codes.items())))
    types = collections.Counter(type(c).__name__ for c in codes)
    print(f"  値の型: {dict(types)}")

    section("10. 風の文言の例(区切りの確認用。上位10種)")
    winds = collections.Counter(w for r in ok for w in r["_winds"])
    print(f"  種類: {len(winds)}")
    for w, n in winds.most_common(10):
        print(f"  {n:4d}件 {w!r}")
    print("  「やや強く」を含む: ", sum(n for w, n in winds.items() if "やや強く" in w), "件")
    print("  「強く」を含み「やや強く」でない: ", sum(n for w, n in winds.items() if "強く" in w and "やや強く" not in w), "件")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--offline", action="store_true", help="通信せず、保存済みのJSONだけで検証する")
    ap.add_argument("--json", metavar="PATH", help="検証結果をJSONでも書き出す")
    ap.add_argument("--check-config", action="store_true",
                    help="config/station_area.json が取得したJSONと合っているかだけを調べる(食い違いがあれば終了コード1)")
    args = ap.parse_args()

    area_json, err = load_json("area.json", AREA_URL, args.offline)
    if err:
        sys.exit(f"area.json を読めない: {err}")
    codes = sorted(area_json["offices"].keys())
    print(f"area.json の offices: {len(codes)}件", file=sys.stderr)

    results, missing, raw = [], [], {}
    for i, code in enumerate(codes, 1):
        data, err = load_json(f"{code}.json", FORECAST_URL.format(code=code), args.offline)
        if err:
            missing.append((code, err))
            print(f"  [{i}/{len(codes)}] {code} {err}", file=sys.stderr)
            continue
        raw[code] = data
        results.append(analyze_office(code, area_json, data))
        print(f"  [{i}/{len(codes)}] {code} OK", file=sys.stderr)

    if args.check_config:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        by_code = {r["code"]: r for r in results}
        known_missing = {c for c, _ in missing}
        problems = check_config(config, by_code, raw)
        problems = [p for p in problems if p.split(":")[0] not in known_missing]
        print(f"検査した府県: {len(raw)}件(JSONなし: {sorted(known_missing)})")
        if problems:
            print(f"設定とJSONの食い違い: {len(problems)}件")
            for p in problems:
                print("  " + p)
        else:
            print("設定とJSONの食い違い: なし")
        if config.get("to_confirm"):
            print("人の確認が済んでいない割り当て:")
            for c, why in config["to_confirm"].items():
                print(f"  {c}{config['stations'].get(c, '')}: {why}")
        sys.exit(1 if problems else 0)

    report(results, missing)

    if args.json:
        out = [{k: v for k, v in r.items() if not k.startswith("_")} for r in results]
        Path(args.json).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
