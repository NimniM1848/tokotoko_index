/*
 * src/forecast.js のテストケース。Node.js(tests/run.js)でも、ブラウザ(tests/index.html)でも動く。
 * 期待値は、tests/fixtures/ の整形済みデータ(2026-11-05の発表。東京と青森)を読んで決めた。
 *
 * runTests(F, T, params, weather, stationArea, fixtures) → [{ name, ok, message }]
 *   F: TokotokoForecast、T: Tokotoko(score.js)、fixtures: { '130000': {...}, '020000': {...} }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TokotokoForecastCases = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function runTests(F, T, params, weather, stationArea, fixtures) {
    const results = [];
    const test = (name, fn) => {
      try {
        fn();
        results.push({ name, ok: true, message: '' });
      } catch (e) {
        results.push({ name, ok: false, message: e.message });
      }
    };
    const eq = (actual, expected, what) => {
      const a = JSON.stringify(actual);
      const b = JSON.stringify(expected);
      if (a !== b) throw new Error(`${what || ''} 期待 ${b} / 実際 ${a}`);
    };
    const clone = (o) => JSON.parse(JSON.stringify(o));
    const build = (office, area, options) => F.buildDays(office, area, stationArea, params, options);
    const day = (r, date) => {
      const d = r.days.find((x) => x.date === date);
      if (!d) throw new Error(`${date} の日が無い`);
      return d;
    };
    const SP = '　';

    const tokyo = fixtures['130000'];
    const aomori = fixtures['020000'];

    // ---------------- 東京地方(短期と週間の地域が同じ)
    test('東京地方: 日付は 11/5〜11/12 の8日(短期の3日と週間の7日の和)', () => {
      const r = build(tokyo, '130010');
      eq(r.days.map((d) => d.date), ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']);
      eq([r.area, r.office, r.stations], [{ code: '130010', name: '東京地方' }, { code: '130000', name: '東京都' }, { short: '44132', week: '44132' }]);
    });
    test('東京地方 11/5(発表日の夕方): 日中のコマが無いので、18時台の値を partial で使う。気温は無い', () => {
      const d = day(build(tokyo, '130010'), '2026-11-05');
      eq([d.weatherCode, d.windText, d.pop, d.popBasis, d.tmax, d.tmin], ['200', '北の風', 20, 'partial', null, null]);
    });
    test('東京地方 11/6: 降水確率は6〜12時と12〜18時の最大、気温は短期の値', () => {
      const d = day(build(tokyo, '130010'), '2026-11-06');
      eq([d.weatherCode, d.windText, d.pop, d.popBasis], ['100', '北の風', 0, 'daytime']);
      eq([d.tmax, d.tmin, d.tmaxUpper, d.tmaxLower, d.normalMax, d.reliability], [24, 14, null, null, 17.9, null]);
      eq(d.tempSource, 'short');
      eq(d.popSlots.map((s) => s.pop), [10, 0, 0, 0]);
    });
    test('東京地方 11/7: 天気と風は短期、降水確率と気温は週間(短期に無いため)', () => {
      const d = day(build(tokyo, '130010'), '2026-11-07');
      eq([d.weatherCode, d.windText, d.pop, d.popBasis], ['100', '北の風' + SP + 'やや強く', 10, 'daily']);
      eq([d.tmax, d.tmin, d.tmaxUpper, d.tmaxLower, d.tminUpper, d.tminLower], [21, 11, 22, 18, 13, 9]);
      eq(d.tempSource, 'week');
      eq([d.popSlots, d.reliability], [[], null]);
    });
    test('東京地方 11/8以降: 週間だけ。風は null、信頼度あり', () => {
      const r = build(tokyo, '130010');
      const d8 = day(r, '2026-11-08');
      eq([d8.weatherCode, d8.windText, d8.pop, d8.tmax, d8.reliability], ['201', null, 30, 17, 'A']);
      const d12 = day(r, '2026-11-12');
      eq([d12.weatherCode, d12.pop, d12.tmax, d12.tmin, d12.reliability], ['101', 20, 18, 8, 'A']);
    });
    test('今日より前の日は除ける(todayJst)', () => {
      const r = build(tokyo, '130010', { today: '2026-11-06' });
      eq([r.days.length, r.days[0].date], [7, '2026-11-06']);
    });
    test('todayJst: 日本時間の日付を、端末の時刻設定に関係なく返す', () => {
      eq(F.todayJst(Date.UTC(2026, 10, 5, 15, 30)), '2026-11-06'); // 日本時間 11/6 0:30
      eq(F.todayJst(Date.UTC(2026, 10, 5, 14, 59)), '2026-11-05'); // 日本時間 11/5 23:59
    });
    test('東京の全地域(伊豆諸島・小笠原を含む)で、7日以上の入力ができる', () => {
      for (const code of Object.keys(tokyo.short.areas)) {
        const r = build(tokyo, code, { today: '2026-11-06' });
        if (r.days.length < 7) throw new Error(`${code}: ${r.days.length}日`);
        if (!r.days.every((d) => d.weatherCode !== null)) throw new Error(`${code}: 天気コードの欠け`);
      }
    });

    // ---------------- 青森(週間の地域が短期の地域をまとめる)
    test('青森 下北: 週間の「下北・三八上北」と八戸の気温を使う。短期の代表地点はむつ', () => {
      const r = build(aomori, '020020');
      eq(r.stations, { short: '31111', week: '31602' });
      const d6 = day(r, '2026-11-06');
      eq([d6.weatherCode, d6.pop, d6.popBasis, d6.tmax, d6.tmin], ['203', 50, 'daytime', 17, 11]);
      const d7 = day(r, '2026-11-07');
      eq([d7.weatherCode, d7.pop, d7.popBasis, d7.tmax, d7.normalMax], ['270', 70, 'daily', 8, 13.6]);
    });
    test('青森 津軽: 同じ日でも、地域によって降水確率が違う(12〜18時の60%)', () => {
      const r = build(aomori, '020010');
      eq(r.stations, { short: '31312', week: '31312' });
      eq([day(r, '2026-11-06').pop, day(r, '2026-11-07').pop, day(r, '2026-11-07').normalMax], [60, 80, 13.2]);
    });
    test('青森 三八上北も、下北と同じ週間の地域(八戸)を使う', () => {
      const r = build(aomori, '020030');
      eq(r.stations.week, '31602');
    });

    // ---------------- 降水確率の選び方(窓の境界・欠け)
    const withPops = (pops, weekPop0) => {
      const o = clone(tokyo);
      o.short.areas['130010'].pops = pops; // 時刻: 11/5 18時、11/6 0・6・12・18時
      o.week.areas['130010'].pops[0] = weekPop0 === undefined ? '' : weekPop0;
      return build(o, '130010');
    };
    test('降水確率: 6時台と12時台の2コマだけを見る(0時台と18時台は見ない)', () => {
      const d = day(withPops(['', '90', '30', '70', '99']), '2026-11-06');
      eq([d.pop, d.popBasis], [70, 'daytime']);
    });
    test('降水確率: 日中のコマが空なら、週間の日別の値', () => {
      const d = day(withPops(['', '90', '', '', '80'], '40'), '2026-11-06');
      eq([d.pop, d.popBasis], [40, 'daily']);
    });
    test('降水確率: 日中も週間も空なら、その日の残りのコマの最大(partial)', () => {
      const d = day(withPops(['', '90', '', '', '80']), '2026-11-06');
      eq([d.pop, d.popBasis], [90, 'partial']);
    });
    test('降水確率: どこにも無ければ null', () => {
      const d = day(withPops(['', '', '', '', '']), '2026-11-06');
      eq([d.pop, d.popBasis], [null, null]);
    });
    test('降水確率: 窓は params.forecast で変えられる(12時から18時だけにすると 12時台の値)', () => {
      const p = clone(params);
      p.forecast.daytime_start_hour = 12;
      const o = clone(tokyo);
      o.short.areas['130010'].pops = ['', '', '30', '70', ''];
      eq(day(F.buildDays(o, '130010', stationArea, p), '2026-11-06').pop, 70);
      o.short.areas['130010'].pops = ['', '', '90', '10', ''];
      eq(day(F.buildDays(o, '130010', stationArea, p), '2026-11-06').pop, 10);
    });

    // ---------------- 欠けた入力・エラー
    test('短期の気温が空なら、週間の気温にはならず null(週間の11/6は空のため)', () => {
      const o = clone(tokyo);
      o.short.stations['44132'].temps = ['', ''];
      const d = day(build(o, '130010'), '2026-11-06');
      eq([d.tmax, d.tmin], [null, null]);
    });
    test('存在しない地域・設定に無い府県は、分かるエラーを出す', () => {
      let msg = '';
      try { build(tokyo, '999999'); } catch (e) { msg = e.message; }
      if (!msg.includes('999999')) throw new Error('エラーに地域コードが無い: ' + msg);
      msg = '';
      try { build(Object.assign(clone(tokyo), { office: '999999' }), '130010'); } catch (e) { msg = e.message; }
      if (!msg.includes('999999')) throw new Error('エラーに府県コードが無い: ' + msg);
    });

    // ---------------- 指数の計算とつなぐ(src/score.js)
    const index = (office, area, date) => {
      const d = day(build(office, area), date);
      return T.calcIndex(d, { params, weather });
    };
    test('つなぐ: 東京 11/6 は 96点◎(晴れで暑さがわずかに減点)', () => {
      const r = index(tokyo, '130010', '2026-11-06');
      eq([r.score, r.grade.mark, r.reasons, r.missing], [96, '◎', [], []]);
    });
    test('つなぐ: 東京 11/7 は 49点△(風が「やや強く」、雨6点)', () => {
      const r = index(tokyo, '130010', '2026-11-07');
      eq([r.score, r.grade.mark, r.reasons, r.badges], [49, '△', ['wind', 'rain'], ['wind']]);
    });
    test('つなぐ: 青森 下北 11/6 は 25点▲(雨30点、風45点。海上の節は除く)', () => {
      const r = index(aomori, '020020', '2026-11-06');
      eq([r.score, r.grade.mark, r.reasons], [25, '▲', ['wind', 'rain']]);
    });
    test('つなぐ: 週間だけの日(風なし)は、風が missing に入る', () => {
      const r = index(tokyo, '130010', '2026-11-08');
      eq(r.missing, ['wind']);
    });
    test('つなぐ: 今週のベストは、指数が最も高い日', () => {
      const r = build(tokyo, '130010', { today: '2026-11-06' });
      const scores = r.days.map((d) => T.calcIndex(d, { params, weather }));
      const best = T.bestIndexes(scores);
      const top = Math.max.apply(null, scores.map((s) => s.score));
      eq(best.every((i) => scores[i].score === top), true);
      eq(best.length >= 1, true);
    });

    return results;
  }

  return { runTests };
});
