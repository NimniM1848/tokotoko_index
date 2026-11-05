/*
 * 画面のうち、DOM に触れない部分(src/app.js から使う)。テストしやすいよう、ここに分けてある。
 *
 * ブラウザでは <script src="src/ui_logic.js"> で読むとグローバルに TokotokoUi ができる。
 * Node.js からは require('./src/ui_logic.js') で使える(テスト用)。
 *
 * 守ること(CLAUDE.md): 画面に出す言葉は、「予報」「警報」「注意報」を見出しに使わない。
 * 減点の内訳は点数ではなく言葉で出す(reasonWord)。体感気温や暑さのしきい値は出さない。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TokotokoUi = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  /** 月(1〜12)から季節。ヘッダーの色だけに使う。 */
  function seasonOf(month) {
    if (month >= 3 && month <= 5) return 'spring';
    if (month >= 6 && month <= 8) return 'summer';
    if (month >= 9 && month <= 11) return 'autumn';
    return 'winter';
  }

  /** '2026-11-06' → '11/6(金)' */
  function formatDate(date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date));
    if (!m) return String(date);
    const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return `${Number(m[2])}/${Number(m[3])}(${WEEKDAYS[dt.getUTCDay()]})`;
  }

  /** '2026-11-05T17:00:00+09:00' → '11月5日 17時'(文字から読むので、端末の時刻設定に左右されない) */
  function formatReport(iso) {
    const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):/.exec(String(iso));
    return m ? `${Number(m[1])}月${Number(m[2])}日 ${Number(m[3])}時` : String(iso);
  }

  /** 発表から hours 時間より長く経っているか。読めない時刻は false。 */
  function isStale(iso, nowMs, hours) {
    const t = Date.parse(iso);
    return Number.isFinite(t) && nowMs - t > hours * 3600 * 1000;
  }

  /** 6時間ごとの降水確率の1コマの名前。'…T06:00:00+09:00' → '6〜12時' */
  function slotLabel(from) {
    const h = parseInt(String(from).slice(11, 13), 10);
    return `${h}〜${h + 6}時`;
  }

  /**
   * その日の指数を画面に出してよいか。
   * 日中の降水確率(または日別の値)と最高気温がそろっていない日は、指数を出さない
   * (たとえば、発表日の夕方の「今日」は、日中がすでに終わっている)。
   */
  function dayState(day, result) {
    if (result.score === null) return { hasIndex: false, note: '指数を出すための値がありません' };
    if (day.tmax === null) return { hasIndex: false, note: '最高気温の値がありません' };
    if (day.popBasis !== 'daytime' && day.popBasis !== 'daily') {
      return { hasIndex: false, note: '日中の降水確率の値がありません' };
    }
    return { hasIndex: true, note: '' };
  }

  /** 降水確率の取り方の説明。 */
  function popBasisText(basis, params) {
    const f = params.forecast;
    if (basis === 'daytime') return `日中(${f.daytime_start_hour}〜${f.daytime_end_hour}時)の最大`;
    if (basis === 'daily') return '1日の値';
    if (basis === 'partial') return 'その日の残りの時間の最大';
    return '';
  }

  // 減点の内訳は、点数ではなく言葉で出す
  const REASON_WORDS = { rain: '雨が多め', heat: '暑さが気になる', cold: '寒さが気になる', wind: '風が強め' };
  const BADGE_WORDS = { snow: '雪に注意', thunder: '雷に注意', wind: '風に注意' };

  function reasonWord(key) {
    return REASON_WORDS[key] || '';
  }

  function badgeWord(key) {
    return BADGE_WORDS[key] || '';
  }

  /**
   * 天気コードの表(晴れ度と雨・雪・雷のフラグ)から、アイコンの部品を決める。
   * 返り値: { base: 'sun' | 'suncloud' | 'cloud', overlays: ['bolt' | 'rain' | 'snow', ...] }
   */
  function iconParts(info) {
    let base = info.sunny === 1 ? 'sun' : info.sunny === 0.5 ? 'suncloud' : 'cloud';
    const overlays = [];
    if (info.thunder) overlays.push('bolt');
    if (info.rain) overlays.push('rain');
    if (info.snow) overlays.push('snow');
    if (base === 'sun' && overlays.length) base = 'suncloud'; // 「晴一時雨」など。雲を添える
    return { base, overlays };
  }

  /**
   * 保存先の入れ物。localStorage が使えない環境(プライベートモードなど)でも、
   * 画面を開いている間は値を覚えておく。getStorage は、使える Storage を返す(失敗してもよい)関数。
   */
  function createStore(getStorage, prefix) {
    const memory = {};
    const storage = () => {
      try {
        return getStorage() || null;
      } catch (e) {
        return null;
      }
    };
    return {
      get(key) {
        try {
          const st = storage();
          if (st) {
            const v = st.getItem(prefix + key);
            if (v !== null && v !== undefined) return JSON.parse(v);
          }
        } catch (e) {
          // 読めない・壊れているときは、覚えている値にする
        }
        return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
      },
      set(key, value) {
        memory[key] = value;
        try {
          const st = storage();
          if (st) st.setItem(prefix + key, JSON.stringify(value));
        } catch (e) {
          // 保存できなくても、動作は続ける
        }
      },
      remove(key) {
        delete memory[key];
        try {
          const st = storage();
          if (st) st.removeItem(prefix + key);
        } catch (e) {
          // 同上
        }
      },
    };
  }

  /**
   * 保存した地域の選択を、いまのデータ(index.json)に合わせて直す。
   * 存在しない府県や地域は、初期の選択(東京都、無ければ先頭)にする。
   */
  function resolveSelection(index, saved) {
    const offices = index.offices;
    const fallback = offices['130000'] ? '130000' : Object.keys(offices)[0];
    const officeIsValid = Boolean(saved && saved.office && offices[saved.office]);
    const office = officeIsValid ? saved.office : fallback;
    const o = offices[office];
    // 保存した府県が無効なときは、地域も引き継がない(別の府県にたまたま同じコードがあっても使わない)
    const area = officeIsValid && o.areas.some((a) => a.code === saved.area) ? saved.area : o.areas[0].code;
    return { office, area };
  }

  /**
   * 好み調整のつまみの位置を、言葉にする(初期値からどちらへ、どれくらい動かしたか)。
   * d: { def: 初期値, min, max, low: 下げた側の言葉, high: 上げた側の言葉 }
   *   例: 暑がり度の low は「暑さに強い」、high は「暑がり」 → 「やや暑がり」「かなり暑さに強い」
   * 初期値から、端までの距離の半分までを「やや」、それより先を「かなり」とする。
   */
  function prefLevelText(value, d) {
    if (Math.abs(value - d.def) < 1e-9) return 'ふつう(初期値)';
    const up = value > d.def;
    const span = up ? d.max - d.def : d.def - d.min;
    const ratio = span > 0 ? Math.abs(value - d.def) / span : 1;
    // 小数の誤差で、ちょうど半分が「かなり」にならないよう、許容誤差を入れる
    return (ratio > 0.5 + 1e-9 ? 'かなり' : 'やや') + (up ? d.high : d.low);
  }

  /** 「−」「＋」ボタンで、つまみを1目盛り動かした値(最小値から数えた目盛りに合わせ、範囲に収める)。 */
  function stepValue(value, step, direction, min, max) {
    const n = Math.round((value + direction * step - min) / step);
    const v = min + n * step;
    return Number(Math.min(max, Math.max(min, v)).toFixed(6));
  }

  // 暑さについては、区分を自前で出さず、環境省のサイトへ案内する(DESIGN.md 第5章)
  const HEAT_INFO = { url: 'https://www.wbgt.env.go.jp/', label: '環境省 熱中症予防情報サイト' };

  return {
    HEAT_INFO,
    prefLevelText,
    stepValue,
    seasonOf,
    formatDate,
    formatReport,
    isStale,
    slotLabel,
    dayState,
    popBasisText,
    reasonWord,
    badgeWord,
    iconParts,
    createStore,
    resolveSelection,
  };
});
