/*
 * 感想による自動調整(DESIGN.md 第5章)。DOM に触れない判定の部分。src/app.js から使う。
 *
 * 出かけた日の感想を記録すると、好み調整のつまみが少しずつ動く。計算はすべてブラウザの中で行い、
 * サーバーには何も送らない。規則は config/params.json の feedback にある。
 *   - 感想の選択肢と、動かすつまみ・幅(step)
 *   - 同じ向きの感想が propose_after 回たまったら、動かしてよいか確認する(勝手には動かさない)
 *   - 「予報が外れたと思う」を選んだ日の感想は、どれも数えない
 *   - つまみは、範囲の端で止まる
 *
 * ブラウザでは <script src="src/feedback.js"> で読むとグローバルに TokotokoFeedback ができる。
 * Node.js からは require('./src/feedback.js') で使える(テスト用)。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TokotokoFeedback = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WRONG = 'wrong_forecast'; // 数えない印の感想
  const NEUTRAL = 'just_right'; // 他の感想と一緒に選べない感想
  const SETTINGS_VERSION = 1;
  const PREF_KEYS = ['rainNg', 'coldOffset', 'hotOffset', 'sunEffect', 'windScale']; // 共有URLの並び

  const round6 = (v) => Number(Number(v).toFixed(6));
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

  // ---------------------------------------------------------------- 日付

  /** 'YYYY-MM-DD' に n 日足した日付(月またぎ・年またぎに対応)。 */
  function addDays(date, n) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
    return d.toISOString().slice(0, 10);
  }

  // ---------------------------------------------------------------- 感想の選択

  function feelingDefs(params) {
    return params.feedback.feelings;
  }

  /** 選んだ感想を整える。知らない語と重複を除き、「ちょうどよかった」は他と一緒に選べない。 */
  function sanitizeFeelings(ids, params) {
    const known = new Set(feelingDefs(params).map((f) => f.id));
    const list = Array.from(new Set((Array.isArray(ids) ? ids : []).filter((id) => known.has(id))));
    return list.includes(NEUTRAL) ? [NEUTRAL] : list;
  }

  // ---------------------------------------------------------------- 感想の記録

  /**
   * 感想の記録を作る。その日の指数と入力値(snapshot)と、選んだ感想を持つ。
   * snapshot: { date, areaName, officeName, score, inputs: { pop, tmax, weatherCode, windText } }
   */
  function makeEntry(snapshot, feelings, now, params) {
    return {
      date: snapshot.date,
      areaName: snapshot.areaName || '',
      officeName: snapshot.officeName || '',
      score: snapshot.score,
      inputs: snapshot.inputs,
      feelings: sanitizeFeelings(feelings, params),
      consumed: [], // つまみの調整に使い終えた感想
      recordedAt: now,
    };
  }

  /** 記録を足す。同じ日の記録があるとき、感想が空のときは、足さずに null を返す。上限を超えたら古い日から捨てる。 */
  function addEntry(log, entry, params) {
    if (!entry.feelings.length) return null;
    if (log.some((e) => e.date === entry.date)) return null;
    const next = log.concat([entry]).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const max = params.feedback.max_log;
    return next.length > max ? next.slice(next.length - max) : next;
  }

  function removeEntry(log, date) {
    return log.filter((e) => e.date !== date);
  }

  // ---------------------------------------------------------------- 調整の提案

  /** つまみを動かす感想ごとに、まだ使っていない回数を数える。「予報が外れたと思う」の日は数えない。 */
  function pendingCounts(log, params) {
    const counts = {};
    feelingDefs(params).forEach((f) => {
      if (f.pref) counts[f.id] = 0;
    });
    log.forEach((e) => {
      if (e.feelings.includes(WRONG)) return;
      e.feelings.forEach((id) => {
        if (id in counts && !(e.consumed || []).includes(id)) counts[id] += 1;
      });
    });
    return counts;
  }

  /**
   * 動かしてよいか確認する提案。同じ向きの感想が propose_after 回たまったものを、設定の順に1つ返す。無ければ null。
   * 返り値: { id, label, prefLabel, pref, count, from, to, atLimit }
   *   to は、つまみの範囲の端で止めた値。すでに端なら atLimit が true で、from と to は同じ。
   */
  function nextProposal(log, prefs, params) {
    const counts = pendingCounts(log, params);
    for (const f of feelingDefs(params)) {
      if (!f.pref || counts[f.id] < params.feedback.propose_after) continue;
      const r = params.preferences[f.range];
      const from = prefs[f.pref];
      const to = round6(Math.min(r.max, Math.max(r.min, from + counts[f.id] * f.step)));
      return {
        id: f.id,
        label: f.label,
        prefLabel: f.prefLabel,
        pref: f.pref,
        count: counts[f.id],
        from,
        to,
        atLimit: Math.abs(to - from) < 1e-9,
      };
    }
    return null;
  }

  /** 提案を決めた(変更した・しなかった)あと、その感想を使い終えたことにする。 */
  function consume(log, feelingId) {
    return log.map((e) => {
      if (e.feelings.includes(WRONG) || !e.feelings.includes(feelingId) || (e.consumed || []).includes(feelingId)) return e;
      return Object.assign({}, e, { consumed: (e.consumed || []).concat([feelingId]) });
    });
  }

  function applyProposal(prefs, proposal) {
    return Object.assign({}, prefs, { [proposal.pref]: proposal.to });
  }

  // ---------------------------------------------------------------- その日の指数と入力値の保存

  /** 感想に付ける、その日の指数と入力値。指数を出せなかった日は作らない(null)。 */
  function makeSnapshot(built, day, result) {
    if (result.score === null) return null;
    return {
      date: day.date,
      areaCode: built.area.code,
      areaName: built.area.name,
      officeName: built.office.name,
      score: result.score,
      inputs: { pop: day.pop, tmax: day.tmax, weatherCode: day.weatherCode, windText: day.windText },
    };
  }

  /** snapshot_days より古い日を捨てる。 */
  function pruneSnapshots(snapshots, today, params) {
    const cutoff = addDays(today, -params.feedback.snapshot_days);
    const out = {};
    Object.keys(snapshots).forEach((d) => {
      if (d >= cutoff) out[d] = snapshots[d];
    });
    return out;
  }

  /** 指数を覚えていない日に付ける、中身の空の保存値。感想は、指数と入力値が無くても記録できる(つまみの調整には使わない情報なので)。 */
  function placeholderSnapshot(date, built) {
    return {
      date,
      areaName: built ? built.area.name : '',
      officeName: built ? built.office.name : '',
      score: null,
      inputs: {},
    };
  }

  /**
   * 感想の欄に出す日(新しい順)。今日までの直近 record_days 日のうち、
   * 直近 always_show_days 日(今日・前日・前々日)は、指数を覚えていなくても必ず出す。
   * それより前の日は、指数を覚えている日か、記録のある日だけ出す。
   */
  function displayDates(snapshots, log, today, params) {
    const f = params.feedback;
    const earliest = addDays(today, -(f.record_days - 1));
    const set = new Set();
    for (let i = 0; i < f.always_show_days; i++) set.add(addDays(today, -i));
    Object.keys(snapshots).forEach((d) => set.add(d));
    log.forEach((e) => set.add(e.date));
    return Array.from(set).filter((d) => d >= earliest && d <= today).sort().reverse();
  }

  /** 感想を付けられる日: 今日までの直近 days 日のうち、指数と入力値を覚えている日(新しい順)。 */
  function recordableDates(snapshots, today, days) {
    const from = addDays(today, -(days - 1));
    return Object.keys(snapshots).filter((d) => d >= from && d <= today).sort().reverse();
  }

  // ---------------------------------------------------------------- 設定の引き継ぎ

  /** 設定入りの短いURL用の文字列(# の後ろ)。サーバーには送られない。例: v1;0.6,0,0,2,1;130000,130010 */
  function encodeShare(prefs, selection) {
    return `v${SETTINGS_VERSION};${PREF_KEYS.map((k) => prefs[k]).join(',')};${selection.office},${selection.area}`;
  }

  /** encodeShare の逆。形が違えば null。つまみの値は範囲に収める(resolvePrefs は src/score.js のもの)。 */
  function decodeShare(text, params, resolvePrefs) {
    const m = /^v(\d+);([^;]+);(\d{6}),(\d{6})$/.exec(String(text));
    if (!m || Number(m[1]) !== SETTINGS_VERSION) return null;
    const nums = m[2].split(',').map(Number);
    if (nums.length !== PREF_KEYS.length || nums.some((n) => !Number.isFinite(n))) return null;
    const raw = {};
    PREF_KEYS.forEach((k, i) => { raw[k] = nums[i]; });
    return { prefs: resolvePrefs(params, raw), selection: { office: m[3], area: m[4] } };
  }

  /** ファイルに書き出す設定(つまみ・場所・表示・感想の記録・覚えている指数)。 */
  function exportSettings(data, now) {
    return {
      app: 'tokotoko',
      version: SETTINGS_VERSION,
      exportedAt: now,
      prefs: data.prefs,
      selection: data.selection,
      theme: data.theme,
      log: data.log,
      snapshots: data.snapshots,
    };
  }

  function cleanEntry(e, params) {
    if (!e || typeof e !== 'object' || !isDate(e.date)) return null;
    const feelings = sanitizeFeelings(e.feelings, params);
    if (!feelings.length) return null;
    const known = new Set(feelings);
    return {
      date: e.date,
      areaName: typeof e.areaName === 'string' ? e.areaName : '',
      officeName: typeof e.officeName === 'string' ? e.officeName : '',
      score: Number.isFinite(e.score) ? e.score : null,
      inputs: e.inputs && typeof e.inputs === 'object' ? e.inputs : {},
      feelings,
      consumed: (Array.isArray(e.consumed) ? e.consumed : []).filter((id) => known.has(id)),
      recordedAt: typeof e.recordedAt === 'string' ? e.recordedAt : '',
    };
  }

  /** 保存してある(または読み込んだ)感想の記録を整える。読めないものは捨て、同じ日は後のものを使う。 */
  function cleanLog(list, params) {
    const dedup = {};
    (Array.isArray(list) ? list : []).forEach((e) => {
      const c = cleanEntry(e, params);
      if (c) dedup[c.date] = c;
    });
    return Object.keys(dedup).sort().map((d) => dedup[d]).slice(-params.feedback.max_log);
  }

  /** 保存してある(または読み込んだ)、その日の指数と入力値を整える。 */
  function cleanSnapshots(obj) {
    const out = {};
    if (obj && typeof obj === 'object') {
      Object.keys(obj).forEach((d) => {
        const s = obj[d];
        if (isDate(d) && s && typeof s === 'object' && Number.isFinite(s.score)) out[d] = s;
      });
    }
    return out;
  }

  /**
   * 書き出したファイルの中身を読む。壊れているもの・別のアプリのものは { ok: false, reason }。
   * つまみの値は範囲に収め、感想の記録は形を確かめて、読めるものだけを使う。
   */
  function parseSettings(text, params, resolvePrefs) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { ok: false, reason: 'ファイルを読めません(設定ファイルではないようです)' };
    }
    if (!data || data.app !== 'tokotoko') return { ok: false, reason: 'とことこ指数の設定ファイルではありません' };
    if (data.version !== SETTINGS_VERSION) return { ok: false, reason: '設定ファイルの版が違います' };

    const sel = data.selection;
    const selection = sel && typeof sel.office === 'string' && typeof sel.area === 'string' ? { office: sel.office, area: sel.area } : null;
    return {
      ok: true,
      value: {
        prefs: resolvePrefs(params, data.prefs),
        selection,
        theme: ['auto', 'light', 'dark'].includes(data.theme) ? data.theme : null,
        log: cleanLog(data.log, params),
        snapshots: cleanSnapshots(data.snapshots),
      },
    };
  }

  return {
    WRONG,
    NEUTRAL,
    addDays,
    sanitizeFeelings,
    makeEntry,
    addEntry,
    removeEntry,
    pendingCounts,
    nextProposal,
    consume,
    applyProposal,
    makeSnapshot,
    pruneSnapshots,
    recordableDates,
    placeholderSnapshot,
    displayDates,
    encodeShare,
    decodeShare,
    cleanLog,
    cleanSnapshots,
    exportSettings,
    parseSettings,
  };
});
