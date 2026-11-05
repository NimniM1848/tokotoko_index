/*
 * src/score.js のテストケース。Node.js(tests/run.js)でも、ブラウザ(tests/index.html)でも動く。
 * 設計書(DESIGN.md 第4章の具体例)の数値と、実データにあった風の文言、境界の値を確かめる。
 *
 * runTests(Tokotoko, params, weather) → [{ name, ok, message }]
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TokotokoCases = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SP = '　'; // 気象庁の風の文言の区切り(全角スペース)

  function runTests(T, params, weather) {
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
    const near = (actual, expected, tol, what) => {
      if (!(Math.abs(actual - expected) <= tol)) throw new Error(`${what || ''} 期待 ${expected}±${tol} / 実際 ${actual}`);
    };

    // 共通の入力。必要な項目だけ上書きして使う
    const base = { date: '2026-05-10', pop: 0, tmax: 20, normalMax: null, weatherCode: '100', windText: '' };
    const calc = (over, prefs) => T.calcIndex(Object.assign({}, base, over), { params, weather, prefs });
    const score = (over, prefs) => calc(over, prefs).score;

    // ---------------- DESIGN.md 第4章の具体例
    test('例1: 8月、最高33℃、降水確率10%、晴れ → 54点', () => {
      eq(score({ date: '2026-08-10', tmax: 33, pop: 10, weatherCode: '100' }), 54);
    });
    test('例1: 同じ日が曇り → 62点', () => {
      eq(score({ date: '2026-08-10', tmax: 33, pop: 10, weatherCode: '200' }), 62);
    });
    test('例2: 11月、札幌の最高4℃、降水確率60%、曇り、平年11.0℃ → 約57点(56.5)', () => {
      eq(score({ date: '2026-11-08', tmax: 4, pop: 60, weatherCode: '200', normalMax: 11.0 }), 57);
    });
    test('例2: 地域補正なし(全国共通のL=8)なら約52点', () => {
      const p = JSON.parse(JSON.stringify(params));
      p.score.region_alpha = 0;
      const r = T.calcIndex(Object.assign({}, base, { date: '2026-11-08', tmax: 4, pop: 60, weatherCode: '200', normalMax: 11.0 }), { params: p, weather });
      eq(r.score, 52);
    });
    test('例3: 最高26℃、降水確率0%、晴れ → 88点', () => {
      eq(score({ tmax: 26, pop: 0, weatherCode: '100' }), 88);
    });
    test('例3: 暑がり度+1.5℃(U=23.5) → 82点', () => {
      eq(score({ tmax: 26, pop: 0, weatherCode: '100' }, { hotOffset: 1.5 }), 82);
    });
    test('例: 11月の寒さの下限L。東京(平年18.1)は約10.1、那覇(26.0)は14.0、札幌(11.0)は6.5', () => {
      const L = (n) => T._internal.coldLimit(11, n, params, 0);
      near(L(18.1), 10.05, 0.001, '東京');
      near(L(26.0), 14.0, 0.001, '那覇');
      near(L(11.0), 6.5, 0.001, '札幌');
      near(T._internal.coldLimit(11, null, params, 0), 8, 0.001, '平年値なし');
    });

    // ---------------- 風の文言(実データにあったもの)
    const wind = (...tokens) => T.windLevel(tokens.join(SP));
    test('風: 強さの語が無い文言は null', () => {
      eq(wind('北の風'), null);
      eq(T.windLevel(''), null);
      eq(T.windLevel(null), null);
    });
    test('風: 「やや強く」と「強く」を取り違えない', () => {
      eq(wind('西の風', 'やや強く'), 'やや強く');
      eq(wind('西の風', '強く'), '強く');
      eq(wind('西の風', '非常に強く'), '非常に強く');
    });
    test('風: 海上や地域の節は除く', () => {
      eq(wind('北西の風', '海上', 'では', '北西の風', 'やや強く'), null);
      eq(wind('北西の風', '唐津地区', 'では', '北西の風', 'やや強く'), null);
      eq(wind('北西の風', 'やや強く', '東三河南部', 'では', '北西の風', '強く'), 'やや強く');
    });
    test('風: 本文に複数の強さがあれば最も強いもの(後・日中を含む)', () => {
      eq(wind('西の風', 'やや強く', '後', '北西の風', '強く'), '強く');
      eq(wind('北西の風', '後', 'やや強く', '海上', 'では', '北西の風', '強く'), 'やや強く');
      eq(wind('北東の風', '後', '西の風', '強く', '海上', 'では', '後', '西の風', '非常に強く'), '強く');
      eq(wind('北の風', '日中', 'やや強く'), 'やや強く');
    });
    test('風の減点: やや強く45点、強く65点、非常に強く85点、倍率0なら0点', () => {
      eq(score({ windText: ['西の風', 'やや強く'].join(SP) }), 55);
      eq(score({ windText: ['西の風', '強く'].join(SP) }), 35);
      eq(score({ windText: ['西の風', '非常に強く'].join(SP) }), 15);
      eq(score({ windText: ['西の風', '強く'].join(SP) }, { windScale: 0 }), 100);
      eq(score({ windText: ['西の風', 'やや強く'].join(SP) }, { windScale: 2 }), 10);
    });

    // ---------------- 区分の境界(雨NG度1.0で、降水確率から点数を作る)
    test('区分の境界: 80以上◎、60〜79○、40〜59△、20〜39▲、20未満✕', () => {
      const k1 = { rainNg: 1 };
      const at = (pop) => calc({ pop }, k1);
      const cases = [[20, 80, '◎'], [21, 79, '○'], [40, 60, '○'], [41, 59, '△'], [60, 40, '△'], [61, 39, '▲'], [80, 20, '▲'], [81, 19, '✕'], [100, 0, '✕']];
      for (const [pop, s, mark] of cases) {
        const r = at(pop);
        eq([r.score, r.grade.mark], [s, mark], `降水確率${pop}%`);
      }
    });
    test('0〜100に収める', () => {
      eq(score({ tmax: 40, pop: 100, weatherCode: '100' }), 0);
      eq(score({ tmax: 20, pop: 0 }), 100);
    });

    // ---------------- 好み調整
    test('好み: スライダーの範囲に収める。壊れた値は初期値', () => {
      const p = T.resolvePrefs(params, { rainNg: 5, coldOffset: -10, hotOffset: 'abc', sunEffect: null, windScale: -1 });
      eq(p, { rainNg: 1.0, coldOffset: -3, hotOffset: 0, sunEffect: 2, windScale: 0 });
      eq(T.resolvePrefs(params, undefined), T.defaultPrefs(params));
    });
    test('好み: 雨NG度は範囲の端(0.3〜1.0)で止まる', () => {
      // 8月33℃、降水確率10%、晴れ。rainNg=1.0 なら 100 - 10 - 40 = 50
      eq(score({ date: '2026-08-10', tmax: 33, pop: 10 }, { rainNg: 5 }), 50);
      eq(score({ date: '2026-08-10', tmax: 33, pop: 10 }, { rainNg: 0 }), 100 - 3 - 40);
    });
    test('好み: 寒がり度を上げると寒い日の点数が下がる', () => {
      const day = { date: '2026-11-08', tmax: 4, pop: 0, weatherCode: '200', normalMax: 11.0 };
      const normal = score(day);
      const colder = score(day, { coldOffset: 1 });
      eq(normal - colder, 3); // 1℃ × 3点
    });
    test('好み: 日差しの影響を0にすると、晴れでも曇りと同じ', () => {
      const day = { date: '2026-08-10', tmax: 33, pop: 10 };
      eq(score(Object.assign({ weatherCode: '100' }, day), { sunEffect: 0 }), score(Object.assign({ weatherCode: '200' }, day)));
    });

    // ---------------- 返り値の中身(体感気温や点数を出さない)
    test('返り値は 指数・区分・内訳・バッジ・欠けた項目 だけ', () => {
      const r = calc({ date: '2026-08-10', tmax: 33, pop: 10 });
      eq(Object.keys(r).sort(), ['badges', 'grade', 'missing', 'reasons', 'score']);
      eq(Object.keys(r.grade).sort(), ['id', 'mark']);
      eq(r.reasons.every((x) => typeof x === 'string'), true);
    });
    test('内訳は言葉のキーで、影響の大きい順。小さい減点は出さない', () => {
      eq(calc({ date: '2026-08-10', tmax: 33, pop: 10 }).reasons, ['heat', 'rain']); // 暑さ40点、雨6点
      eq(calc({ date: '2026-08-10', tmax: 33, pop: 0 }).reasons, ['heat']);
      eq(calc({ date: '2026-11-08', tmax: 4, pop: 60, weatherCode: '200', normalMax: 11.0 }).reasons, ['rain', 'cold']);
      eq(calc({ pop: 5 }).reasons, []); // 雨3点は基準(5点)未満
      eq(calc({ windText: ['西の風', 'やや強く'].join(SP) }).reasons, ['wind']);
    });

    // ---------------- バッジ
    test('バッジ: 雪・雷・風', () => {
      eq(calc({ weatherCode: '400' }).badges, ['snow']);
      eq(calc({ weatherCode: '350' }).badges, ['thunder']);
      eq(calc({ weatherCode: '450' }).badges, ['snow', 'thunder']);
      eq(calc({ weatherCode: '100' }).badges, []);
    });
    test('バッジ: 「雨か雪」「みぞれ」の天気コードは、雪の注意を出す', () => {
      eq(calc({ weatherCode: '304' }).badges, ['snow']);
      eq(calc({ weatherCode: '329' }).badges, ['snow']);
    });
    test('バッジ: 風は「やや強く」以上の本文があるときだけ', () => {
      eq(calc({ windText: ['西の風', 'やや強く'].join(SP) }).badges, ['wind']);
      eq(calc({ windText: ['西の風', '海上', 'では', '西の風', '強く'].join(SP) }).badges, []);
    });
    test('雪や雷は、バッジだけで減点しない', () => {
      eq(score({ weatherCode: '450' }), 100);
      eq(score({ weatherCode: '350' }), 100);
    });

    // ---------------- 欠けた入力
    test('週間予報のように風が無い(null)ときは、減点せず missing に wind', () => {
      const r = calc({ windText: null });
      eq(r.score, 100);
      eq(r.missing, ['wind']);
    });
    test('降水確率と最高気温がどちらも空なら、指数は null', () => {
      const r = calc({ pop: '', tmax: '' });
      eq(r.score, null);
      eq(r.grade, null);
    });
    test('最高気温だけ欠けたら、気温の減点なしで計算し missing に tmax', () => {
      const r = calc({ pop: 10, tmax: '' });
      eq(r.score, 94);
      eq(r.missing, ['tmax']);
    });
    test('表にない天気コードは中間の晴れ度で計算し、missing に weather', () => {
      const r = calc({ date: '2026-08-10', tmax: 33, pop: 10, weatherCode: '999' });
      // s=0.5 → T'=34 → 暑さ36点、雨6点
      eq(r.score, 58);
      eq(r.missing, ['weather']);
    });
    test('気象庁のJSONの値(文字列)のまま渡せる', () => {
      eq(score({ date: '2026-08-10', tmax: '33', pop: '10', normalMax: '' }), 54);
    });

    // ---------------- 月・今週のベスト
    test('月は日付の文字から読む', () => {
      eq([T.monthOf('2026-11-06'), T.monthOf('2026-12-31T00:00:00+09:00'), T.monthOf('x')], [11, 12, null]);
    });
    test('今週のベスト: 最高点の日(同点はすべて)。指数が無い日は除く', () => {
      eq(T.bestIndexes([{ score: 50 }, { score: 88 }, { score: null }, { score: 88 }, { score: 70 }]), [1, 3]);
      eq(T.bestIndexes([{ score: null }]), []);
    });

    // ---------------- 設定ファイルの前提
    test('設定: 11月の下限が8、区分の表が大きい順', () => {
      eq(params.score.cold_limit_by_month['11'], 8);
      const mins = params.grades.map((g) => g.min);
      eq(mins, mins.slice().sort((a, b) => b - a));
      for (let m = 1; m <= 12; m++) eq(typeof params.score.cold_limit_by_month[String(m)], 'number', `${m}月`);
    });
    test('設定: 天気コードの表の全コードに、晴れ度と3つのフラグがある', () => {
      for (const [code, v] of Object.entries(weather.codes)) {
        const ok = [0, 0.5, 1].includes(v.sunny) && ['rain', 'snow', 'thunder'].every((k) => typeof v[k] === 'boolean');
        if (!ok) throw new Error(`コード${code}: ${JSON.stringify(v)}`);
      }
    });

    return results;
  }

  return { runTests };
});
