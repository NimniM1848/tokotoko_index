/*
 * src/feedback.js のテストケース。Node.js(tests/run.js)でも、ブラウザ(tests/index.html)でも動く。
 *
 * runTests(Fb, T, params) → [{ name, ok, message }]
 *   Fb: TokotokoFeedback、T: Tokotoko(score.js。resolvePrefs を使う)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TokotokoFeedbackCases = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function runTests(Fb, T, params) {
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
    const resolve = T.resolvePrefs;
    const defaults = T.defaultPrefs(params);

    const snap = (date, score) => ({ date, areaName: '東京地方', officeName: '東京都', score: score === undefined ? 70 : score, inputs: { pop: 10, tmax: 30, weatherCode: '100', windText: '北の風' } });
    const entryOf = (date, feelings) => Fb.makeEntry(snap(date), feelings, '2026-08-01T20:00:00+09:00', params);
    // 日付を変えながら、同じ感想の記録を n 件つくる
    const logOf = (feelings, n, extra) => {
      let log = [];
      for (let i = 0; i < n; i++) {
        log = Fb.addEntry(log, entryOf(`2026-08-${String(10 + i).padStart(2, '0')}`, feelings.concat(extra || [])), params);
      }
      return log;
    };

    // ---------------- 日付
    test('日付の計算: 月またぎ・年またぎ', () => {
      eq([Fb.addDays('2026-11-30', 1), Fb.addDays('2026-01-01', -1), Fb.addDays('2026-03-01', -1), Fb.addDays('2026-11-06', -13)], ['2026-12-01', '2025-12-31', '2026-02-28', '2026-10-24']);
    });

    // ---------------- 感想の選択
    test('感想の選択: 知らない語と重複を除く。「ちょうどよかった」は他と一緒にならない', () => {
      eq(Fb.sanitizeFeelings(['too_hot', 'too_hot', 'x', 'wind_bothered'], params), ['too_hot', 'wind_bothered']);
      eq(Fb.sanitizeFeelings(['too_hot', 'just_right'], params), ['just_right']);
      eq(Fb.sanitizeFeelings(null, params), []);
    });

    // ---------------- 記録
    test('記録: 同じ日は足さない。感想が空でも足さない。日付順に並ぶ', () => {
      let log = Fb.addEntry([], entryOf('2026-08-12', ['too_hot']), params);
      log = Fb.addEntry(log, entryOf('2026-08-10', ['too_cold']), params);
      eq(log.map((e) => e.date), ['2026-08-10', '2026-08-12']);
      eq(Fb.addEntry(log, entryOf('2026-08-10', ['too_hot']), params), null);
      eq(Fb.addEntry(log, entryOf('2026-08-20', []), params), null);
      eq(Fb.removeEntry(log, '2026-08-10').map((e) => e.date), ['2026-08-12']);
    });
    test('記録: 上限を超えたら、古い日から捨てる', () => {
      const p = clone(params);
      p.feedback.max_log = 3;
      let log = [];
      for (let d = 10; d <= 14; d++) log = Fb.addEntry(log, Fb.makeEntry(snap(`2026-08-${d}`), ['too_hot'], 'x', p), p);
      eq(log.map((e) => e.date), ['2026-08-12', '2026-08-13', '2026-08-14']);
    });
    test('記録: その日の指数と入力値を持ち、使い終えた感想は空から始まる', () => {
      const e = entryOf('2026-08-10', ['too_hot', 'sun_harsh']);
      eq([e.date, e.score, e.inputs.tmax, e.inputs.windText, e.feelings, e.consumed], ['2026-08-10', 70, 30, '北の風', ['too_hot', 'sun_harsh'], []]);
    });

    // ---------------- 調整の提案
    test('提案: 同じ向きの感想が3回たまるまでは出さない', () => {
      eq(Fb.nextProposal(logOf(['too_hot'], 2), defaults, params), null);
      const p = Fb.nextProposal(logOf(['too_hot'], 3), defaults, params);
      eq([p.id, p.count, p.pref, p.from, p.to, p.atLimit], ['too_hot', 3, 'hotOffset', 0, 1.5, false]);
    });
    test('提案: 感想ごとの幅(暑い+0.5℃、寒い+0.5℃、日差し+0.5℃、風+0.1、雨+0.05)×回数', () => {
      const prop = (id) => Fb.nextProposal(logOf([id], 3), defaults, params);
      eq([prop('too_hot').to, prop('too_cold').to, prop('sun_harsh').to, prop('wind_bothered').to, prop('rain_bothered').to], [1.5, 1.5, 3.5, 1.3, 0.75]);
    });
    test('提案: 「ちょうどよかった」はつまみを動かさない', () => {
      eq(Fb.nextProposal(logOf(['just_right'], 5), defaults, params), null);
    });
    test('提案: 「予報が外れたと思う」を選んだ日は、どの感想も数えない', () => {
      let log = logOf(['too_hot'], 2);
      log = Fb.addEntry(log, entryOf('2026-08-20', ['too_hot', 'wrong_forecast']), params);
      eq(Fb.pendingCounts(log, params).too_hot, 2);
      eq(Fb.nextProposal(log, defaults, params), null);
    });
    test('提案: つまみの範囲の端で止まる。すでに端なら atLimit', () => {
      const log = logOf(['too_hot'], 3);
      const near = Fb.nextProposal(log, Object.assign({}, defaults, { hotOffset: 2.5 }), params);
      eq([near.from, near.to, near.atLimit], [2.5, 3, false]); // +1.5 しようとしても、上限の+3で止まる
      const end = Fb.nextProposal(log, Object.assign({}, defaults, { hotOffset: 3 }), params);
      eq([end.from, end.to, end.atLimit], [3, 3, true]);
    });
    test('提案: 向きの違う感想は別々に数える(暑すぎ2回と寒すぎ2回では出ない)', () => {
      let log = [];
      ['too_hot', 'too_cold', 'too_hot', 'too_cold'].forEach((id, i) => { log = Fb.addEntry(log, entryOf(`2026-08-1${i}`, [id]), params); });
      eq(Fb.nextProposal(log, defaults, params), null);
    });
    test('提案: 1回の記録で複数の感想を選んでも、それぞれ数える', () => {
      const log = logOf(['too_hot', 'sun_harsh'], 3);
      eq(Fb.pendingCounts(log, params).too_hot, 3);
      eq(Fb.pendingCounts(log, params).sun_harsh, 3);
      eq(Fb.nextProposal(log, defaults, params).id, 'too_hot'); // 設定の順で、先のものから1つずつ
    });
    test('決めたあと: 使い終えた感想は数えず、新しく3回たまれば、また提案する', () => {
      let log = logOf(['too_hot'], 3);
      const p = Fb.nextProposal(log, defaults, params);
      const prefs2 = Fb.applyProposal(defaults, p);
      eq([prefs2.hotOffset, defaults.hotOffset], [1.5, 0]); // 元の設定は変えない
      log = Fb.consume(log, 'too_hot');
      eq(Fb.nextProposal(log, prefs2, params), null);
      eq(log.every((e) => e.consumed.includes('too_hot')), true);
      for (let i = 0; i < 3; i++) log = Fb.addEntry(log, entryOf(`2026-09-0${i + 1}`, ['too_hot']), params);
      const again = Fb.nextProposal(log, prefs2, params);
      eq([again.count, again.from, again.to], [3, 1.5, 3]);
    });
    test('決めたあと: 他の感想や、数えない日の記録は、使い終えたことにならない', () => {
      let log = logOf(['too_hot', 'wind_bothered'], 3);
      log = Fb.addEntry(log, entryOf('2026-08-30', ['too_hot', 'wrong_forecast']), params);
      const after = Fb.consume(log, 'too_hot');
      eq(Fb.pendingCounts(after, params).wind_bothered, 3);
      eq(after[after.length - 1].consumed, []); // 「予報が外れたと思う」の日
    });

    // ---------------- その日の指数と入力値の保存
    const built = { area: { code: '130010', name: '東京地方' }, office: { code: '130000', name: '東京都' } };
    test('保存: 指数を出せなかった日は作らない', () => {
      eq(Fb.makeSnapshot(built, { date: '2026-08-10', pop: 10, tmax: 30, weatherCode: '100', windText: null }, { score: null }), null);
      const s = Fb.makeSnapshot(built, { date: '2026-08-10', pop: 10, tmax: 30, weatherCode: '100', windText: '北の風' }, { score: 70 });
      eq([s.date, s.areaCode, s.areaName, s.officeName, s.score, s.inputs], ['2026-08-10', '130010', '東京地方', '東京都', 70, { pop: 10, tmax: 30, weatherCode: '100', windText: '北の風' }]);
    });
    test('保存: 14日より古い日を捨てる(ちょうど14日前は残す)', () => {
      const s = { '2026-10-22': {}, '2026-10-23': {}, '2026-11-06': {} };
      eq(Object.keys(Fb.pruneSnapshots(s, '2026-11-06', params)), ['2026-10-23', '2026-11-06']);
    });
    test('感想を付けられる日: 今日までの直近7日で、覚えている日(新しい順)', () => {
      const s = { '2026-10-30': {}, '2026-10-31': {}, '2026-11-02': {}, '2026-11-06': {}, '2026-11-07': {} };
      eq(Fb.recordableDates(s, '2026-11-06', 7), ['2026-11-06', '2026-11-02', '2026-10-31']);
    });

    test('感想の欄に出す日: 直近3日はいつも出す。古い日は、覚えている日か記録のある日だけ', () => {
      const today = '2026-11-06';
      // 何も覚えていなくても、今日・前日・前々日が出る(新しい順)
      eq(Fb.displayDates({}, [], today, params), ['2026-11-06', '2026-11-05', '2026-11-04']);
      // 覚えている日・記録のある日は、直近7日の範囲で足される。範囲より古い日と、未来の日は出さない
      const snaps = { '2026-11-01': { score: 1 }, '2026-10-30': { score: 1 }, '2026-11-07': { score: 1 } };
      const log = [{ date: '2026-11-02', feelings: ['too_hot'] }, { date: '2026-10-25', feelings: ['too_hot'] }];
      eq(Fb.displayDates(snaps, log, today, params), ['2026-11-06', '2026-11-05', '2026-11-04', '2026-11-02', '2026-11-01']);
    });
    test('指数を覚えていない日の感想: 空の保存値でも記録でき、つまみの調整には数える', () => {
      const ph = Fb.placeholderSnapshot('2026-11-05', { area: { name: '東京地方' }, office: { name: '東京都' } });
      eq([ph.date, ph.areaName, ph.score, ph.inputs], ['2026-11-05', '東京地方', null, {}]);
      eq(Fb.placeholderSnapshot('2026-11-05', null).areaName, '');
      let log = [];
      ['2026-11-03', '2026-11-04', '2026-11-05'].forEach((d) => {
        log = Fb.addEntry(log, Fb.makeEntry(Fb.placeholderSnapshot(d, null), ['too_hot'], 'x', params), params);
      });
      eq(log.length, 3);
      eq(Fb.nextProposal(log, defaults, params).count, 3);
      eq(Fb.cleanLog(log, params).length, 3); // 保存して読み直しても残る(score が null でも)
    });

    // ---------------- 設定の引き継ぎ
    const prefs = { rainNg: 0.75, coldOffset: -1, hotOffset: 1.5, sunEffect: 3.5, windScale: 1.3 };
    test('設定入りURL: 書いて読むと元に戻る', () => {
      const text = Fb.encodeShare(prefs, { office: '130000', area: '130010' });
      eq(text, 'v1;0.75,-1,1.5,3.5,1.3;130000,130010');
      eq(Fb.decodeShare(text, params, resolve), { prefs, selection: { office: '130000', area: '130010' } });
    });
    test('設定入りURL: 範囲の外の値は範囲に収め、形の違うものは読まない', () => {
      eq(Fb.decodeShare('v1;5,-9,9,9,9;130000,130010', params, resolve).prefs, { rainNg: 1, coldOffset: -3, hotOffset: 3, sunEffect: 4, windScale: 2 });
      ['v2;0.6,0,0,2,1;130000,130010', 'v1;0.6,0,0,2;130000,130010', 'v1;a,0,0,2,1;130000,130010', 'v1;0.6,0,0,2,1;13,1', '', 'x'].forEach((bad) => eq(Fb.decodeShare(bad, params, resolve), null, bad));
    });
    const data = () => ({
      prefs,
      selection: { office: '020000', area: '020020' },
      theme: 'dark',
      log: logOf(['too_hot'], 2),
      snapshots: { '2026-08-10': { score: 70, inputs: {} } },
    });
    test('書き出し・読み込み: 元に戻る', () => {
      const text = JSON.stringify(Fb.exportSettings(data(), '2026-08-12T00:00:00+09:00'));
      const r = Fb.parseSettings(text, params, resolve);
      eq(r.ok, true);
      eq([r.value.prefs, r.value.selection, r.value.theme, r.value.log.length, Object.keys(r.value.snapshots)], [prefs, { office: '020000', area: '020020' }, 'dark', 2, ['2026-08-10']]);
      eq(r.value.log, data().log);
    });
    test('読み込み: 壊れたファイル・別のアプリ・別の版は断る', () => {
      eq(Fb.parseSettings('壊れた', params, resolve).ok, false);
      eq(Fb.parseSettings('{"app":"other","version":1}', params, resolve).ok, false);
      eq(Fb.parseSettings('{"app":"tokotoko","version":99}', params, resolve).ok, false);
      eq(Fb.parseSettings('null', params, resolve).ok, false);
    });
    test('読み込み: 値は範囲に収め、読めない記録は捨てる(同じ日は後のもの)', () => {
      const text = JSON.stringify({
        app: 'tokotoko', version: 1, prefs: { rainNg: 99, hotOffset: 'x' }, theme: 'pink', selection: { office: 1 },
        log: [
          { date: '2026-08-10', feelings: ['too_hot', '知らない'], consumed: ['too_hot', 'wind_bothered'], score: 50 },
          { date: '壊れた日付', feelings: ['too_hot'] },
          { date: '2026-08-11', feelings: [] },
          { date: '2026-08-12', feelings: ['too_cold'] },
          { date: '2026-08-12', feelings: ['wind_bothered'] },
          'x',
        ],
        snapshots: { '2026-08-10': { score: 70 }, '2026-08-11': { score: 'x' }, x: { score: 1 } },
      });
      const v = Fb.parseSettings(text, params, resolve).value;
      eq([v.prefs.rainNg, v.prefs.hotOffset, v.theme, v.selection], [1, 0, null, null]);
      eq(v.log.map((e) => [e.date, e.feelings, e.consumed]), [['2026-08-10', ['too_hot'], ['too_hot']], ['2026-08-12', ['wind_bothered'], []]]);
      eq(Object.keys(v.snapshots), ['2026-08-10']);
    });

    test('保存してある記録の整形: 壊れた保存値でも、配列でなければ空になる', () => {
      eq([Fb.cleanLog(null, params), Fb.cleanLog('x', params), Fb.cleanLog({}, params)], [[], [], []]);
      eq(Fb.cleanLog([{ date: '2026-08-10', feelings: ['too_hot'] }, 5], params).length, 1);
      eq(Fb.cleanSnapshots(null), {});
      eq(Object.keys(Fb.cleanSnapshots({ '2026-08-10': { score: 1 }, '2026-08-11': null })), ['2026-08-10']);
    });

    // ---------------- 設定ファイルの前提
    test('設定: 感想の選択肢が7つ。つまみを動かすものは、範囲と幅が設定にある', () => {
      eq(params.feedback.feelings.length, 7);
      eq(params.feedback.propose_after, 3);
      params.feedback.feelings.filter((f) => f.pref).forEach((f) => {
        if (!params.preferences[f.range]) throw new Error(`${f.id}: 範囲 ${f.range} が無い`);
        if (!(f.step > 0)) throw new Error(`${f.id}: 幅が正でない`);
        if (!(f.pref in defaults)) throw new Error(`${f.id}: つまみ ${f.pref} が無い`);
      });
    });

    return results;
  }

  return { runTests };
});
