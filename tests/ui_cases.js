/*
 * src/ui_logic.js のテストケース。Node.js(tests/run.js)でも、ブラウザ(tests/index.html)でも動く。
 *
 * runTests(U, params, weather, indexSample) → [{ name, ok, message }]
 *   U: TokotokoUi
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TokotokoUiCases = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function runTests(U, params, weather) {
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

    test('季節: 3〜5月が春、6〜8月が夏、9〜11月が秋、12〜2月が冬', () => {
      eq([1, 2, 3, 5, 6, 8, 9, 11, 12].map(U.seasonOf), ['winter', 'winter', 'spring', 'spring', 'summer', 'summer', 'autumn', 'autumn', 'winter']);
    });

    test('日付の表示: 曜日つき。年をまたいでも合う', () => {
      eq([U.formatDate('2026-11-06'), U.formatDate('2026-11-05'), U.formatDate('2026-12-31')], ['11/6(金)', '11/5(木)', '12/31(木)']);
      eq(U.formatDate('x'), 'x');
    });

    test('発表時刻の表示は、文字から読む(端末の時刻設定に関係しない)', () => {
      eq(U.formatReport('2026-11-05T17:00:00+09:00'), '11月5日 17時');
      eq(U.formatReport('2026-01-02T05:00:00+09:00'), '1月2日 5時');
    });

    test('古いデータの判定', () => {
      const t = Date.parse('2026-11-05T17:00:00+09:00');
      eq(U.isStale('2026-11-05T17:00:00+09:00', t + 35 * 3600 * 1000, 36), false);
      eq(U.isStale('2026-11-05T17:00:00+09:00', t + 37 * 3600 * 1000, 36), true);
      eq(U.isStale('壊れた値', t, 36), false);
    });

    test('降水確率のコマの名前', () => {
      eq([U.slotLabel('2026-11-06T06:00:00+09:00'), U.slotLabel('2026-11-06T00:00:00+09:00'), U.slotLabel('2026-11-05T18:00:00+09:00')], ['6〜12時', '0〜6時', '18〜24時']);
    });

    test('指数を出す日: 日中の降水確率(または日別の値)と最高気温がそろっている日だけ', () => {
      const ok = { tmax: 20, popBasis: 'daytime' };
      eq(U.dayState(ok, { score: 80 }).hasIndex, true);
      eq(U.dayState({ tmax: 20, popBasis: 'daily' }, { score: 80 }).hasIndex, true);
      eq(U.dayState({ tmax: 20, popBasis: 'partial' }, { score: 80 }).hasIndex, false);
      eq(U.dayState({ tmax: null, popBasis: 'daytime' }, { score: 80 }).hasIndex, false);
      eq(U.dayState(ok, { score: null }).hasIndex, false);
      eq(U.dayState({ tmax: 20, popBasis: null }, { score: 80 }).note, '日中の降水確率の値がありません');
    });

    test('降水確率の取り方の説明(窓は設定から)', () => {
      eq(U.popBasisText('daytime', params), '日中(6〜18時)の最大');
      eq(U.popBasisText('daily', params), '1日の値');
      eq(U.popBasisText('partial', params), 'その日の残りの時間の最大');
      eq(U.popBasisText(null, params), '');
    });

    test('内訳とバッジの言葉(点数や気温は出さない)', () => {
      eq(['rain', 'heat', 'cold', 'wind'].map(U.reasonWord), ['雨が多め', '暑さが気になる', '寒さが気になる', '風が強め']);
      eq(['snow', 'thunder', 'wind'].map(U.badgeWord), ['雪に注意', '雷に注意', '風に注意']);
      eq(U.reasonWord('x'), '');
      const words = ['rain', 'heat', 'cold', 'wind'].map(U.reasonWord).concat(['snow', 'thunder', 'wind'].map(U.badgeWord)).join('');
      eq(/予報|警報|注意報|[0-9]/.test(words), false);
    });

    test('アイコン: 晴れ度と雨・雪・雷のフラグから決める', () => {
      const icon = (code) => U.iconParts(weather.codes[code]);
      eq(icon('100'), { base: 'sun', overlays: [] });
      eq(icon('101'), { base: 'suncloud', overlays: [] });
      eq(icon('200'), { base: 'cloud', overlays: [] });
      eq(icon('102'), { base: 'suncloud', overlays: ['rain'] }); // 晴一時雨: 雲を添える
      eq(icon('300'), { base: 'cloud', overlays: ['rain'] });
      eq(icon('400'), { base: 'cloud', overlays: ['snow'] });
      eq(icon('304'), { base: 'cloud', overlays: ['rain', 'snow'] });
      eq(icon('350'), { base: 'cloud', overlays: ['bolt', 'rain'] });
    });

    test('保存: 値を読み書きできる', () => {
      const data = {};
      const fake = { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = v; }, removeItem: (k) => { delete data[k]; } };
      const s = U.createStore(() => fake, 'tk.');
      eq(s.get('a'), null);
      s.set('a', { x: 1 });
      eq(s.get('a'), { x: 1 });
      eq(JSON.parse(data['tk.a']), { x: 1 });
      s.remove('a');
      eq(s.get('a'), null);
    });
    test('保存: 保存できない環境でも、開いている間は値を覚える', () => {
      const s = U.createStore(() => { throw new Error('使えない'); }, 'tk.');
      s.set('a', 5);
      eq(s.get('a'), 5);
      const s2 = U.createStore(() => ({ getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => {} }), 'tk.');
      s2.set('b', [1]);
      eq(s2.get('b'), [1]);
    });
    test('保存: 壊れた値は無かったことにする', () => {
      const s = U.createStore(() => ({ getItem: () => '{壊れた', setItem() {}, removeItem() {} }), 'tk.');
      eq(s.get('a'), null);
    });

    test('地域の選択: 存在しない保存値は、東京都に戻す', () => {
      const index = {
        offices: {
          '130000': { areas: [{ code: '130010' }, { code: '130020' }] },
          '020000': { areas: [{ code: '020010' }, { code: '020020' }] },
        },
      };
      eq(U.resolveSelection(index, null), { office: '130000', area: '130010' });
      eq(U.resolveSelection(index, { office: '020000', area: '020020' }), { office: '020000', area: '020020' });
      eq(U.resolveSelection(index, { office: '020000', area: '999999' }), { office: '020000', area: '020010' });
      eq(U.resolveSelection(index, { office: '999999', area: '130020' }), { office: '130000', area: '130010' });
    });
    test('好み調整: つまみの位置を言葉にする', () => {
      const d = { def: 0, min: -3, max: 3, low: '暑さに強い', high: '暑がり' };
      eq(U.prefLevelText(0, d), 'ふつう(初期値)');
      eq(U.prefLevelText(1.5, d), 'やや暑がり'); // 端までのちょうど半分は「やや」
      eq(U.prefLevelText(2, d), 'かなり暑がり');
      eq(U.prefLevelText(-1, d), 'やや暑さに強い');
      eq(U.prefLevelText(-3, d), 'かなり暑さに強い');
      // 初期値が範囲の真ん中でないとき(雨NG度: 0.3〜1.0、初期値0.6)
      const r = { def: 0.6, min: 0.3, max: 1.0, low: '雨を気にしない', high: '雨を避けたい' };
      eq([U.prefLevelText(0.6, r), U.prefLevelText(0.8, r), U.prefLevelText(1.0, r), U.prefLevelText(0.45, r), U.prefLevelText(0.3, r)],
        ['ふつう(初期値)', 'やや雨を避けたい', 'かなり雨を避けたい', 'やや雨を気にしない', 'かなり雨を気にしない']);
    });
    test('好み調整: 「−」「＋」ボタンは1目盛りずつ動き、範囲の端で止まる', () => {
      eq(U.stepValue(0.6, 0.05, 1, 0.3, 1.0), 0.65);
      eq(U.stepValue(0.6, 0.05, -1, 0.3, 1.0), 0.55);
      eq(U.stepValue(1.0, 0.05, 1, 0.3, 1.0), 1.0);
      eq(U.stepValue(0.3, 0.05, -1, 0.3, 1.0), 0.3);
      eq(U.stepValue(0, 0.5, 1, -3, 3), 0.5);
      eq(U.stepValue(2.9, 0.5, 1, -3, 3), 3); // 目盛りからずれた値は、目盛りに戻す
      eq(U.stepValue(1, 0.1, 1, 0, 2), 1.1);
      eq(U.stepValue(0.7, 0.1, 1, 0, 2), 0.8); // 0.7+0.1 の浮動小数の誤差が出ない
    });
    test('暑さの案内: 環境省の熱中症予防情報サイトへのリンク(https)', () => {
      eq(U.HEAT_INFO.url, 'https://www.wbgt.env.go.jp/');
      eq(/予報|警報|注意報/.test(U.HEAT_INFO.label), false);
    });
    test('地域の選択: 東京都が無いデータなら、先頭の府県', () => {
      const index = { offices: { '020000': { areas: [{ code: '020010' }] } } };
      eq(U.resolveSelection(index, null), { office: '020000', area: '020010' });
    });

    return results;
  }

  return { runTests };
});
