/*
 * 整形済みの予報データ(data/forecast/{府県}.json)から、地域ごと・日ごとの入力を作る。
 * 作った1日分は、そのまま Tokotoko.calcIndex(day, ctx) に渡せる(src/score.js)。
 *
 * ブラウザでは <script src="src/forecast.js"> で読むとグローバルに TokotokoForecast ができる。
 * Node.js からは require('./src/forecast.js') で使える(テスト用)。外部のライブラリは使わない。
 *
 * ここでは気象庁の値を選んで並べるだけで、天気や気温の予想はしない。値の取り方(DESIGN.md 第3・4章):
 *   - 天気コード・風: 短期(今日から明後日)にある日は短期、無い日は週間(風は週間に無いので null)
 *   - 降水確率: 短期の6時間ごとの値のうち、日中(params.forecast の窓)に収まるコマの最大。
 *     その日に日中のコマが無ければ、週間の日別の値。それも無ければ、その日にある短期のコマの最大(basis='partial')
 *   - 最高・最低気温: 短期にある日は短期(地域の代表地点)、無い日は週間(週間の地点)。
 *     短期の気温の時刻の目印は、0時が「朝の最低(0〜9時)」、9時が「日中の最高(9〜18時)」を表す。その時刻の気温ではない
 *   - 平年の最高気温: その地域を含む週間の地域の地点の、その週の平年値
 * 地域と地点の対応は config/station_area.json から読む。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TokotokoForecast = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SLOT_HOURS = 6; // 短期の降水確率の1コマの長さ(気象庁の定義)

  function toNumber(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' && v.trim() === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function textOrNull(v) {
    return v === undefined || v === null || v === '' ? null : v;
  }

  function dateOf(time) {
    return String(time).slice(0, 10);
  }

  function hourOf(time) {
    return parseInt(String(time).slice(11, 13), 10);
  }

  /** 'YYYY-MM-DD'(日本時間の今日)。端末の時刻設定に左右されないよう、UTCから9時間足して読む。 */
  function todayJst(nowMs) {
    return new Date(nowMs + 9 * 3600 * 1000).toISOString().slice(0, 10);
  }

  function maxOf(values) {
    const nums = values.filter((v) => v !== null);
    return nums.length ? Math.max.apply(null, nums) : null;
  }

  /**
   * ある地域の、日ごとの入力を作る。
   *
   * office:      data/forecast/{府県}.json の中身
   * areaCode:    短期の地域コード(一次細分。例: '130010')
   * stationArea: config/station_area.json
   * params:      config/params.json
   * options:     { today: 'YYYY-MM-DD' }  これより前の日は除く(省略すると全部)
   *
   * 返り値: { office, area, report, stations, days }
   *   days[i]: {
   *     date, weatherCode, weatherText, windText,
   *     pop, popBasis('daytime' | 'daily' | 'partial' | null), popSlots: [{ from, pop }],
   *     tmax, tmin, tempSource('short' | 'week' | null), tmaxUpper, tmaxLower, tminUpper, tminLower,   // 幅は、週間の値を使った日だけ
   *     normalMax, reliability
   *   }
   * 数値は数に、空文字は null にする。値そのものは変えない。
   */
  function buildDays(office, areaCode, stationArea, params, options) {
    const f = params.forecast;
    const opts = options || {};

    const cfgOffice = stationArea.offices[office.office];
    if (!cfgOffice) throw new Error('設定に府県が無い: ' + office.office);
    const shortCfg = cfgOffice.short[areaCode];
    if (!shortCfg) throw new Error('設定に地域が無い: ' + areaCode);
    const weekEntry = Object.entries(cfgOffice.week).find((e) => e[1].covers.includes(areaCode));
    if (!weekEntry) throw new Error('この地域を含む週間の地域が設定に無い: ' + areaCode);
    const weekCode = weekEntry[0];
    const weekCfg = weekEntry[1];

    const sArea = office.short.areas[areaCode];
    const wArea = office.week.areas[weekCode];
    const sStationCode = shortCfg.stations[0];
    const sStation = office.short.stations[sStationCode];
    const wStation = office.week.stations[weekCfg.station];
    if (!sArea) throw new Error('データに地域が無い: ' + areaCode);
    if (!wArea) throw new Error('データに週間の地域が無い: ' + weekCode);
    if (!sStation) throw new Error('データに短期の地点が無い: ' + sStationCode);
    if (!wStation) throw new Error('データに週間の地点が無い: ' + weekCfg.station);

    const dates = new Set();

    // ---- 短期: 天気・風
    const shortDay = {};
    office.short.times.weather.forEach((t, i) => {
      const d = dateOf(t);
      dates.add(d);
      shortDay[d] = {
        weatherCode: textOrNull(sArea.weatherCodes[i]),
        weatherText: sArea.weathers ? textOrNull(sArea.weathers[i]) : null,
        windText: sArea.winds ? textOrNull(sArea.winds[i]) : null,
      };
    });

    // ---- 短期: 降水確率(6時間ごと)
    const slotsByDate = {};
    office.short.times.pops.forEach((t, i) => {
      const d = dateOf(t);
      dates.add(d);
      (slotsByDate[d] = slotsByDate[d] || []).push({ from: t, hour: hourOf(t), pop: toNumber(sArea.pops[i]) });
    });

    // ---- 短期: 気温(代表地点)
    const shortTemp = {};
    office.short.times.temps.forEach((t, i) => {
      const d = dateOf(t);
      dates.add(d);
      const entry = (shortTemp[d] = shortTemp[d] || { tmin: null, tmax: null });
      const h = hourOf(t);
      if (h === f.short_temp_min_hour) entry.tmin = toNumber(sStation.temps[i]);
      if (h === f.short_temp_max_hour) entry.tmax = toNumber(sStation.temps[i]);
    });

    // ---- 週間: 天気・降水確率・信頼度
    const weekDay = {};
    office.week.times.weather.forEach((t, i) => {
      const d = dateOf(t);
      dates.add(d);
      weekDay[d] = {
        weatherCode: textOrNull(wArea.weatherCodes[i]),
        pop: toNumber(wArea.pops[i]),
        reliability: textOrNull(wArea.reliabilities ? wArea.reliabilities[i] : null),
      };
    });

    // ---- 週間: 気温(週間の地点)
    const weekTemp = {};
    office.week.times.temps.forEach((t, i) => {
      const d = dateOf(t);
      dates.add(d);
      const at = (key) => (wStation[key] ? toNumber(wStation[key][i]) : null);
      weekTemp[d] = {
        tmax: at('tempsMax'), tmin: at('tempsMin'),
        tmaxUpper: at('tempsMaxUpper'), tmaxLower: at('tempsMaxLower'),
        tminUpper: at('tempsMinUpper'), tminLower: at('tempsMinLower'),
      };
    });

    const normalMax = wStation.normal ? toNumber(wStation.normal.max) : null;

    const days = Array.from(dates)
      .sort()
      .filter((d) => !opts.today || d >= opts.today)
      .map((d) => {
        const s = shortDay[d];
        const w = weekDay[d];
        const slots = slotsByDate[d] || [];

        // 降水確率: 日中のコマの最大 → 週間の日別 → その日にあるコマの最大
        const inWindow = slots.filter(
          (x) => x.hour >= f.daytime_start_hour && x.hour + SLOT_HOURS <= f.daytime_end_hour
        );
        let pop = maxOf(inWindow.map((x) => x.pop));
        let popBasis = pop !== null ? 'daytime' : null;
        if (pop === null && w && w.pop !== null) {
          pop = w.pop;
          popBasis = 'daily';
        }
        if (pop === null) {
          pop = maxOf(slots.map((x) => x.pop));
          popBasis = pop !== null ? 'partial' : null;
        }

        // 気温: 短期の値があれば短期、無ければ週間
        const st = shortTemp[d];
        const wt = weekTemp[d];
        const tmaxFromShort = st && st.tmax !== null;
        const tminFromShort = st && st.tmin !== null;
        const tmax = tmaxFromShort ? st.tmax : wt ? wt.tmax : null;
        const tmin = tminFromShort ? st.tmin : wt ? wt.tmin : null;
        const fromWeekMax = !tmaxFromShort && wt && wt.tmax !== null;
        const fromWeekMin = !tminFromShort && wt && wt.tmin !== null;

        return {
          date: d,
          weatherCode: s && s.weatherCode !== null ? s.weatherCode : w ? w.weatherCode : null,
          weatherText: s ? s.weatherText : null,
          windText: s ? s.windText : null, // 週間には風が無い
          pop,
          popBasis,
          popSlots: slots.map((x) => ({ from: x.from, pop: x.pop })),
          tmax,
          tmin,
          tempSource: tmaxFromShort || tminFromShort ? 'short' : fromWeekMax || fromWeekMin ? 'week' : null,
          tmaxUpper: fromWeekMax ? wt.tmaxUpper : null,
          tmaxLower: fromWeekMax ? wt.tmaxLower : null,
          tminUpper: fromWeekMin ? wt.tminUpper : null,
          tminLower: fromWeekMin ? wt.tminLower : null,
          normalMax,
          reliability: w ? w.reliability : null,
        };
      });

    return {
      office: { code: office.office, name: office.name },
      area: { code: areaCode, name: sArea.name },
      report: office.report,
      stations: { short: sStationCode, week: weekCfg.station },
      days,
    };
  }

  return { buildDays, todayJst };
});
