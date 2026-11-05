/*
 * とことこ指数の計算部分(DESIGN.md 第4章・第5章)。
 *
 * ブラウザでは <script src="src/score.js"> で読むと、グローバルに Tokotoko ができる。
 * Node.js からは require('./src/score.js') で使える(テスト用)。外部のライブラリは使わない。
 *
 * 係数としきい値は、このファイルに書かず、config/params.json と config/weather_codes.json から渡す。
 * この部分は、気象庁の予報値を「加工せずに」受け取り、指数を計算するだけで、天気や気温の予想はしない。
 *
 * 守ること(CLAUDE.md):
 *   - 体感気温 T' や、減点の点数など、T' や気温を逆算できる数値を、外に返さない
 *     (calcIndex の返り値には、指数・区分・内訳の言葉・バッジしか入れない)
 *   - _internal に出している関数は、テスト用。画面には使わない
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Tokotoko = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 風の強さの語。弱い順
  const WIND_LEVELS = ['やや強く', '強く', '非常に強く'];

  // ---------------------------------------------------------------- 入力の整え

  /** 気象庁のJSONの値("21"、""、null など)を数値にする。空や数でないものは null。 */
  function toNumber(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' && v.trim() === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  /** 'YYYY-MM-DD' や '2026-11-06T00:00:00+09:00' の月(1〜12)。時差の影響を受けないよう、文字から読む。 */
  function monthOf(dateString) {
    const m = /^\d{4}-(\d{2})-\d{2}/.exec(String(dateString));
    if (!m) return null;
    const month = parseInt(m[1], 10);
    return month >= 1 && month <= 12 ? month : null;
  }

  // ---------------------------------------------------------------- 天気コード・風

  /** 天気コードから、晴れ度と雨・雪・雷のフラグを引く。表にないコードは default を使う。 */
  function weatherInfo(code, weatherTable) {
    const entry = weatherTable.codes[String(code)];
    if (entry) return { known: true, sunny: entry.sunny, rain: entry.rain, snow: entry.snow, thunder: entry.thunder };
    const d = weatherTable.default;
    return { known: false, sunny: d.sunny, rain: d.rain, snow: d.snow, thunder: d.thunder };
  }

  /**
   * 風の文言のうち、全域に当たる部分(本文)の語に分ける。
   * 文言は全角スペース区切りで、「海上」「唐津地区」のような地域の節が「では」の後ろに付く。
   *   例: 「北の風　やや強く　海上　では　後　北西の風　強く」→ 本文は「北の風　やや強く」
   * 地域の節は、一部の地域だけに当たるので、指数の計算から外す(DESIGN.md 第5章)。
   */
  function windMainTokens(windText) {
    const tokens = String(windText).split(/\s+/).filter((t) => t !== '');
    const i = tokens.indexOf('では');
    return i > 0 ? tokens.slice(0, i - 1) : tokens;
  }

  /**
   * 風の文言から、本文に出てくる最も強い語を返す('やや強く'、'強く'、'非常に強く')。無ければ null。
   * 語の一致は完全一致で見る(「強く」が「やや強く」の中に含まれるため、部分一致にしない)。
   */
  function windLevel(windText) {
    if (windText === null || windText === undefined || windText === '') return null;
    let best = -1;
    for (const t of windMainTokens(windText)) {
      const rank = WIND_LEVELS.indexOf(t);
      if (rank > best) best = rank;
    }
    return best < 0 ? null : WIND_LEVELS[best];
  }

  // ---------------------------------------------------------------- 好み調整

  /** 好み調整の初期値。 */
  function defaultPrefs(params) {
    return {
      rainNg: params.score.rain_per_pop, // 雨NG度(k)
      coldOffset: 0, // 寒がり度(℃)。大きいほど寒さを気にする
      hotOffset: 0, // 暑がり度(℃)。大きいほど暑さを気にする
      sunEffect: params.score.sun_effect, // 日差しの影響(℃)
      windScale: 1, // 風の影響(倍率)
    };
  }

  /** 利用者の設定を、初期値で補い、スライダーの範囲に収める。壊れた値や欠けた値は初期値になる。 */
  function resolvePrefs(params, prefs) {
    const d = defaultPrefs(params);
    const given = prefs || {};
    const r = params.preferences;
    const pick = (key, range) => {
      const v = toNumber(given[key]);
      return clamp(v === null ? d[key] : v, range.min, range.max);
    };
    return {
      rainNg: pick('rainNg', r.rain_ng),
      coldOffset: pick('coldOffset', r.cold_offset),
      hotOffset: pick('hotOffset', r.hot_offset),
      sunEffect: pick('sunEffect', r.sun_effect),
      windScale: pick('windScale', r.wind_scale),
    };
  }

  // ---------------------------------------------------------------- 指数

  /** 日差し補正後の体感気温 T'。内部の計算だけに使い、画面に出さない。 */
  function feltTemp(tmax, sunny, sunEffect) {
    return tmax + sunEffect * sunny;
  }

  /**
   * 寒さの下限 L。これより T' が低いと減点する。画面に出さない。
   * L = (1 - α) × 月ごとの全国共通の下限 + α × (平年の最高気温 - Δ)。平年値が無ければ全国共通の下限だけ。
   * 寒がり度は、L をそのまま上げ下げする。
   */
  function coldLimit(month, normalMax, params, coldOffset) {
    const s = params.score;
    const national = s.cold_limit_by_month[String(month)];
    const limit =
      normalMax === null
        ? national
        : (1 - s.region_alpha) * national + s.region_alpha * (normalMax - s.cold_gap);
    return limit + (coldOffset || 0);
  }

  /** 要因ごとの減点を計算する(内部用)。入力が欠けた要因は 0 点にして、missing に入れる。 */
  function penalties(day, params, weather, prefs) {
    const s = params.score;
    const pop = toNumber(day.pop);
    const tmax = toNumber(day.tmax);
    const normalMax = toNumber(day.normalMax);
    const month = day.month !== undefined && day.month !== null ? day.month : monthOf(day.date);
    const missing = [];

    let rain = 0;
    if (pop === null) missing.push('pop');
    else rain = prefs.rainNg * pop;

    let heat = 0;
    let cold = 0;
    if (tmax === null) {
      missing.push('tmax');
    } else if (month === null) {
      missing.push('month');
    } else {
      const felt = feltTemp(tmax, weather.sunny, prefs.sunEffect);
      const upper = s.heat_upper - prefs.hotOffset;
      heat = s.heat_per_deg * Math.max(0, felt - upper);
      cold = s.cold_per_deg * Math.max(0, coldLimit(month, normalMax, params, prefs.coldOffset) - felt);
    }

    let wind = 0;
    if (day.windText === null || day.windText === undefined) {
      missing.push('wind'); // 週間予報には風が無い
    } else {
      const level = windLevel(day.windText);
      if (level !== null) wind = s.wind_penalty[level] * prefs.windScale;
    }

    return { rain, heat, cold, wind, missing };
  }

  /** 指数の区分(◎〜✕)。 */
  function gradeOf(score, params) {
    for (const g of params.grades) {
      if (score >= g.min) return { id: g.id, mark: g.mark };
    }
    return { id: 'bad', mark: '✕' };
  }

  /**
   * 1日分の指数を計算する。
   *
   * day: {
   *   date:        '2026-11-06'(月の判定に使う。month を直接渡してもよい)
   *   pop:         降水確率(%)。気象庁の値のまま("30" でも 30 でもよい)
   *   tmax:        最高気温(℃)
   *   normalMax:   その週の平年の最高気温(℃)。無ければ null
   *   weatherCode: 天気コード
   *   windText:    風の文言。週間予報のように無いときは null
   * }
   * ctx: { params: config/params.json, weather: config/weather_codes.json, prefs: 好み調整(省略可) }
   *
   * 返り値: {
   *   score:   0〜100の整数。降水確率も最高気温も無いときは null
   *   grade:   { id, mark }
   *   reasons: 減点の内訳。要因のキー('rain' | 'heat' | 'cold' | 'wind')を、影響が大きい順に
   *   badges:  注意のバッジ。'snow' | 'thunder' | 'wind'
   *   missing: 入力が足りなかった項目
   * }
   * 点数や気温は返さない。
   */
  function calcIndex(day, ctx) {
    const params = ctx.params;
    const prefs = resolvePrefs(params, ctx.prefs);
    const weather = weatherInfo(day.weatherCode, ctx.weather);
    const p = penalties(day, params, weather, prefs);

    const missing = p.missing.slice();
    if (!weather.known) missing.push('weather');

    const badges = [];
    if (weather.snow) badges.push('snow');
    if (weather.thunder) badges.push('thunder');
    if (windLevel(day.windText) !== null) badges.push('wind');

    if (missing.includes('pop') && missing.includes('tmax')) {
      return { score: null, grade: null, reasons: [], badges, missing };
    }

    const raw = clamp(params.score.base - p.rain - p.heat - p.cold - p.wind, 0, 100);
    // 小数の誤差で 56.5 が 56.49999 になるのを避けてから、整数に丸める
    const score = Math.round(Math.round(raw * 1e6) / 1e6);

    const minPoints = params.reasons.min_points;
    const reasons = ['rain', 'heat', 'cold', 'wind']
      .filter((k) => p[k] >= minPoints)
      .sort((a, b) => p[b] - p[a]);

    return { score, grade: gradeOf(score, params), reasons, badges, missing };
  }

  /** 今週のベスト: 指数が最も高い日の位置(同点はすべて)。指数が無い日は除く。 */
  function bestIndexes(results) {
    let max = -Infinity;
    results.forEach((r) => {
      if (r && r.score !== null && r.score > max) max = r.score;
    });
    if (max === -Infinity) return [];
    const out = [];
    results.forEach((r, i) => {
      if (r && r.score === max) out.push(i);
    });
    return out;
  }

  return {
    calcIndex,
    bestIndexes,
    resolvePrefs,
    defaultPrefs,
    weatherInfo,
    windLevel,
    monthOf,
    toNumber,
    // テスト用。T' や L は、気温を逆算できるので、画面には使わない
    _internal: { feltTemp, coldLimit },
  };
});
