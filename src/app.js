/*
 * とことこ指数の画面(DOM の組み立て)。計算は src/score.js、日ごとの入力は src/forecast.js、
 * DOM に触れない部品は src/ui_logic.js にある。
 *
 * 守ること(CLAUDE.md):
 *   - 体感気温や、気温を逆算できる数値(減点の点数など)を出さない。減点の内訳は言葉で出す
 *   - 「予報」「警報」「注意報」を、サイトの名称や見出しに使わない
 *   - 出典表記は index.html のフッターにある
 * 気象庁の文言は textContent で入れ、HTML として解釈しない。
 */
(function () {
  'use strict';

  const T = window.Tokotoko;
  const F = window.TokotokoForecast;
  const U = window.TokotokoUi;
  const FB = window.TokotokoFeedback;

  const store = U.createStore(() => window.localStorage, 'tokotoko.');
  const $ = (id) => document.getElementById(id);

  const state = {
    params: null,
    weather: null,
    stationArea: null,
    index: null,
    officeCache: {},
    data: null, // 選んだ府県のデータ
    sel: null, // { office, area }
    prefs: null,
    selectedDate: null,
    view: null,
    theme: 'auto',
    log: [], // 感想の記録
    snapshots: {}, // 日ごとの指数と入力値(感想に付ける)
    formDate: null, // 感想を入力中の日
    formChecked: new Set(),
  };

  // ---------------------------------------------------------------- 小さな部品

  function h(tag, props, ...children) {
    const e = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v);
    });
    children.forEach((c) => {
      if (c !== null && c !== undefined) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }

  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${url} (${res.status})`);
    return res.json();
  }

  function showStatus(text) {
    const s = $('status');
    s.textContent = text;
    s.hidden = false;
  }

  function hideStatus() {
    $('status').hidden = true;
  }

  const num = (v) => (v === null || v === undefined ? '—' : String(v));
  const range = (lower, upper) => (lower !== null && upper !== null ? `(${lower}〜${upper})` : '');

  // ---------------------------------------------------------------- 表示の明るさ(ダークモード)

  const THEMES = ['auto', 'light', 'dark'];
  const THEME_LABEL = { auto: '自動', light: 'ライト', dark: 'ダーク' };

  function applyTheme(theme) {
    state.theme = THEMES.includes(theme) ? theme : 'auto';
    if (state.theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', state.theme);
    $('theme-btn').textContent = '表示: ' + THEME_LABEL[state.theme];
  }

  function cycleTheme() {
    const next = THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length];
    applyTheme(next);
    store.set('theme', next);
  }

  // ---------------------------------------------------------------- 天気アイコン(手描き風の小さなSVG)

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function svg(tag, attrs) {
    const e = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs || {}).forEach(([k, v]) => e.setAttribute(k, v));
    return e;
  }

  function sunShape(cx, cy, scale) {
    const g = svg('g', { transform: `translate(${cx} ${cy}) scale(${scale})` });
    g.appendChild(svg('circle', { r: 9, class: 'ic-sun' }));
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI / 4) * i;
      g.appendChild(svg('line', {
        x1: (Math.cos(a) * 13).toFixed(2), y1: (Math.sin(a) * 13).toFixed(2),
        x2: (Math.cos(a) * 18).toFixed(2), y2: (Math.sin(a) * 18).toFixed(2),
        class: 'ic-ray',
      }));
    }
    return g;
  }

  function cloudShape(dx, dy) {
    return svg('path', {
      d: 'M12 36h22a8 8 0 0 0 1-15.9A11 11 0 0 0 13.6 23 7 7 0 0 0 12 36z',
      transform: `translate(${dx} ${dy})`,
      class: 'ic-cloud',
    });
  }

  function overlayShape(kind, x) {
    if (kind === 'rain') return svg('path', { d: `M${x + 1} 35l-3 8`, class: 'ic-rain' });
    if (kind === 'snow') {
      return svg('path', {
        d: `M${x} 36v8M${x - 4} 40h8M${x - 3} 37l6 6M${x + 3} 37l-6 6`,
        class: 'ic-snow',
      });
    }
    const p = [[2, 33], [-5, 41], [0, 41], [-2, 47], [6, 38], [1, 38], [4, 33]];
    return svg('polygon', { points: p.map(([dx, y]) => `${x + dx},${y}`).join(' '), class: 'ic-bolt' });
  }

  function weatherIcon(info, label) {
    const parts = U.iconParts(info);
    const root = svg('svg', { viewBox: '0 0 48 48', role: 'img', 'aria-label': label });
    const g = svg('g', { transform: `translate(0 ${parts.overlays.length ? -4 : 0})` });
    if (parts.base === 'sun') g.appendChild(sunShape(24, 24, 1));
    if (parts.base === 'suncloud') {
      g.appendChild(sunShape(17, 17, 0.65));
      g.appendChild(cloudShape(4, 2));
    }
    if (parts.base === 'cloud') g.appendChild(cloudShape(0, 0));
    root.appendChild(g);
    const n = parts.overlays.length;
    const xs = n === 1 ? [24] : n === 2 ? [16, 32] : [12, 24, 36];
    parts.overlays.forEach((kind, i) => root.appendChild(overlayShape(kind, xs[i])));
    return root;
  }

  // ---------------------------------------------------------------- 日ごとの計算

  function computeView() {
    const { data, sel, stationArea, params, weather, prefs } = state;
    const built = F.buildDays(data, sel.area, stationArea, params, { today: F.todayJst(Date.now()) });
    const days = built.days.slice(0, 7).map((day) => {
      const result = T.calcIndex(day, { params, weather, prefs });
      return {
        day,
        result,
        st: U.dayState(day, result),
        info: T.weatherInfo(day.weatherCode, weather),
        name: weather.codes[day.weatherCode] ? weather.codes[day.weatherCode].name : '',
      };
    });
    const best = T.bestIndexes(days.map((d) => (d.st.hasIndex ? d.result : null)));
    return { built, days, best };
  }

  function gradeOf(result) {
    return state.params.grades.find((g) => g.id === result.grade.id);
  }

  function gradeEl(d) {
    if (!d.st.hasIndex) return h('span', { class: 'grade grade-none' }, h('span', { class: 'mark', text: '—' }));
    const g = gradeOf(d.result);
    return h('span', { class: `grade grade-${g.id}` },
      h('span', { class: 'mark', text: g.mark }),
      h('span', { class: 'score', text: String(d.result.score) }),
      h('span', { class: 'label', text: g.label }));
  }

  function badgesEl(d) {
    if (!d.result.badges.length) return null;
    return h('ul', { class: 'badges' }, ...d.result.badges.map((b) => h('li', { class: 'badge', text: U.badgeWord(b) })));
  }

  // ---------------------------------------------------------------- 7日分のカード

  function cardEl(d, isBest) {
    const { day } = d;
    const card = h('button', { class: 'card', type: 'button', 'aria-pressed': String(day.date === state.selectedDate), 'data-date': day.date });

    card.appendChild(h('span', { class: 'card-head' },
      h('span', { text: U.formatDate(day.date) }),
      isBest ? h('span', { class: 'best', text: '今週のベスト' }) : null));

    card.appendChild(h('span', { class: 'card-weather' },
      weatherIcon(d.info, d.name || '天気'),
      h('span', { class: 'weather-name', text: d.name })));

    card.appendChild(gradeEl(d));

    const facts = h('ul', { class: 'facts' });
    facts.appendChild(h('li', { text: `降水確率 ${day.pop === null ? '—' : day.pop + '%'}` }));
    facts.appendChild(h('li', { text: `最高 ${num(day.tmax)}℃ ${range(day.tmaxLower, day.tmaxUpper)}`.trim() }));
    facts.appendChild(h('li', { text: `最低 ${num(day.tmin)}℃ ${range(day.tminLower, day.tminUpper)}`.trim() }));
    if (day.reliability) facts.appendChild(h('li', { text: `信頼度 ${day.reliability}` }));
    card.appendChild(facts);

    const badges = badgesEl(d);
    if (badges) card.appendChild(badges);
    if (!d.st.hasIndex) card.appendChild(h('span', { class: 'card-note', text: d.st.note }));

    card.appendChild(h('span', { class: 'card-more' })); // 文言は updateCardMarks が入れる
    card.addEventListener('click', () => (state.selectedDate === day.date ? closeDetail() : openDetail(day.date)));
    return card;
  }

  function renderCards(view) {
    const box = $('cards');
    box.textContent = '';
    view.days.forEach((d, i) => box.appendChild(cardEl(d, view.best.includes(i))));
    updateCardMarks();
  }

  /** 選んだカードを目立たせ、全部のカードに「くわしく」の目印を出す。 */
  function updateCardMarks() {
    $('cards').querySelectorAll('.card').forEach((c) => {
      const open = c.dataset.date === state.selectedDate;
      c.setAttribute('aria-pressed', String(open));
      c.classList.toggle('is-open', open);
      c.querySelector('.card-more').textContent = open ? '▼ 下に開いています' : 'くわしく ＞';
    });
  }

  function openDetail(date) {
    state.selectedDate = date;
    updateCardMarks();
    renderDetail(state.view);
    const box = $('detail');
    box.classList.remove('opened');
    void box.offsetWidth; // アニメーションをやり直すため
    box.classList.add('opened');
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    box.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    box.focus({ preventScroll: true });
  }

  function closeDetail() {
    const date = state.selectedDate;
    state.selectedDate = null;
    updateCardMarks();
    renderDetail(state.view);
    const card = $('cards').querySelector(`.card[data-date="${date}"]`);
    if (card) card.focus(); // 元のカードに戻る(画面もそこへ動く)
  }

  // ---------------------------------------------------------------- くわしく

  function renderDetail(view) {
    const box = $('detail');
    const d = state.selectedDate ? view.days.find((x) => x.day.date === state.selectedDate) : null;
    if (!d) {
      box.hidden = true;
      return;
    }
    const { day } = d;
    const { data } = state;
    box.hidden = false;
    box.textContent = '';
    box.classList.add('detail');

    const close = h('button', { type: 'button', class: 'btn btn-small', text: '閉じる' });
    close.addEventListener('click', closeDetail);
    box.appendChild(h('div', { class: 'detail-head' }, h('h2', { text: `くわしく ${U.formatDate(day.date)}` }), close));
    box.appendChild(h('div', { class: 'detail-grade' }, gradeEl(d), badgesEl(d)));

    const dl = h('dl');
    const row = (term, ...desc) => {
      dl.appendChild(h('dt', { text: term }));
      dl.appendChild(h('dd', {}, ...desc));
    };

    row('天気', day.weatherText || d.name || '—');

    if (d.st.hasIndex) {
      if (d.result.reasons.length) {
        row('気になる点', h('ul', { class: 'reasons' }, ...d.result.reasons.map((k) => h('li', { text: U.reasonWord(k) }))));
      } else {
        row('気になる点', 'とくにありません');
      }
    } else {
      row('指数', d.st.note);
    }

    if (d.st.hasIndex && d.result.reasons.includes('heat')) {
      row('暑さについて', '体調管理のため、',
        h('a', { href: U.HEAT_INFO.url, target: '_blank', rel: 'noopener', text: U.HEAT_INFO.label }),
        'も確認してください。');
    }

    const popText = day.pop === null ? '—' : `${day.pop}%`;
    const basis = U.popBasisText(day.popBasis, state.params);
    row('降水確率', `${popText}${basis ? `(${basis})` : ''}`);
    if (day.popSlots.length) {
      row('6時間ごと', h('ul', { class: 'slots' }, ...day.popSlots.map((s) => h('li', { text: `${U.slotLabel(s.from)} ${s.pop === null ? '—' : s.pop + '%'}` }))));
    }

    row('気温', `最高 ${num(day.tmax)}℃ ${range(day.tmaxLower, day.tmaxUpper)}  最低 ${num(day.tmin)}℃ ${range(day.tminLower, day.tminUpper)}`.replace(/\s+$/, ''));
    row('風', day.windText !== null ? day.windText : 'この日の風の情報はありません');
    if (day.reliability) row('信頼度', `${day.reliability}(気象庁の示す目安。Aが最も高い)`);

    const stationName = day.tempSource === 'week'
      ? (data.week.stations[view.built.stations.week] || {}).name
      : day.tempSource === 'short'
        ? (data.short.stations[view.built.stations.short] || {}).name
        : null;
    row('地域', `${view.built.area.name}(${view.built.office.name})${stationName ? `。気温の地点は${stationName}` : ''}`);

    box.appendChild(dl);
  }

  // ---------------------------------------------------------------- 画面全体

  function renderReportInfo(view) {
    const r = view.built.report;
    const { params, index } = state;
    const parts = [`気象庁の発表: 3日先まで ${U.formatReport(r.short)} / 週間 ${U.formatReport(r.week)}`];
    if (U.isStale(r.short, Date.now(), params.ui.stale_hours) && U.isStale(r.week, Date.now(), params.ui.stale_hours)) {
      parts.push('データが古くなっています。');
    }
    const excluded = Object.values(index.excluded || {}).map((x) => x.name);
    if (excluded.length) parts.push(`${excluded.join('、')}は、いま表示できません。`);
    $('report-info').textContent = parts.join('  ');
  }

  function render() {
    if (!state.data) return;
    let view;
    try {
      view = computeView();
    } catch (e) {
      showStatus('この地域のデータを表示できませんでした。別の地域を選ぶか、時間をおいてもう一度お試しください。');
      $('cards').textContent = '';
      $('detail').hidden = true;
      return;
    }
    hideStatus();
    state.view = view;
    if (!view.days.some((d) => d.day.date === state.selectedDate)) state.selectedDate = null;
    renderReportInfo(view);
    renderCards(view);
    renderDetail(view);
    renderPrefsPreview(view);
    renderFeedback();
    updateShareUrl();
  }

  // ---------------------------------------------------------------- 場所の選択

  function fillSelect(select, options, value) {
    select.textContent = '';
    options.forEach((o) => select.appendChild(h('option', { value: o.value, text: o.label })));
    select.value = value;
  }

  function renderSelectors() {
    const { index, sel } = state;
    const office = index.offices[sel.office];
    const center = index.centers.find((c) => c.code === office.center) || index.centers[0];
    fillSelect($('sel-center'), index.centers.map((c) => ({ value: c.code, label: c.name })), center.code);
    fillSelect($('sel-office'), center.offices.map((c) => ({ value: c, label: index.offices[c].name })), sel.office);
    fillSelect($('sel-area'), office.areas.map((a) => ({ value: a.code, label: a.name })), sel.area);
  }

  async function loadOffice(code) {
    if (!state.officeCache[code]) state.officeCache[code] = await getJson(`data/forecast/${code}.json`);
    return state.officeCache[code];
  }

  async function applySelection(sel) {
    state.sel = sel;
    store.set('area', sel);
    renderSelectors();
    try {
      state.data = await loadOffice(sel.office);
    } catch (e) {
      state.data = null;
      $('cards').textContent = '';
      $('detail').hidden = true;
      showStatus('この地域のデータを読み込めませんでした。時間をおいて、もう一度お試しください。');
      return;
    }
    render();
    maybeSnapshot();
    renderFeedback();
  }

  function onCenterChange() {
    const center = state.index.centers.find((c) => c.code === $('sel-center').value);
    const office = center.offices[0];
    applySelection({ office, area: state.index.offices[office].areas[0].code });
  }

  function onOfficeChange() {
    const office = $('sel-office').value;
    applySelection({ office, area: state.index.offices[office].areas[0].code });
  }

  function onAreaChange() {
    applySelection({ office: state.sel.office, area: $('sel-area').value });
  }

  // ---------------------------------------------------------------- 好み調整

  const signed = (v) => (v > 0 ? '+' : '') + v.toFixed(1);
  // low / high: つまみを初期値より下げた・上げたときの言葉。ends: スライダーの両端の言葉
  const PREF_DEFS = [
    { key: 'rainNg', range: 'rain_ng', label: '雨NG度', hint: '雨(降水確率)をどれくらい避けたいか', low: '雨を気にしない', high: '雨を避けたい', ends: ['気にしない', '避けたい'], fmt: (v) => v.toFixed(2) },
    { key: 'coldOffset', range: 'cold_offset', label: '寒がり度', hint: '右へ動かすほど、寒い日の指数が下がります', low: '寒さに強い', high: '寒がり', ends: ['寒さに強い', '寒がり'], fmt: (v) => signed(v) + '℃' },
    { key: 'hotOffset', range: 'hot_offset', label: '暑がり度', hint: '右へ動かすほど、暑い日の指数が下がります', low: '暑さに強い', high: '暑がり', ends: ['暑さに強い', '暑がり'], fmt: (v) => signed(v) + '℃' },
    { key: 'sunEffect', range: 'sun_effect', label: '日差しの影響', hint: '右へ動かすほど、晴れの日を暑く感じます(左端で日差しを無視)', low: '日差しを気にしない', high: '日差しがつらい', ends: ['気にしない', 'つらい'], fmt: (v) => v.toFixed(1) + '℃' },
    { key: 'windScale', range: 'wind_scale', label: '風の影響', hint: '右へ動かすほど、風の強い日の指数が下がります(左端で風を無視)', low: '風を気にしない', high: '風を気にする', ends: ['気にしない', '気にする'], fmt: (v) => '×' + v.toFixed(1) },
  ];

  function buildPrefsUi() {
    const box = $('prefs');
    box.textContent = '';
    const defaults = T.defaultPrefs(state.params);
    PREF_DEFS.forEach((def) => {
      const r = state.params.preferences[def.range];
      const levelInfo = { def: defaults[def.key], min: r.min, max: r.max, low: def.low, high: def.high };
      const level = h('span', { class: 'level' });
      const value = h('span', { class: 'value' });
      const input = h('input', { type: 'range', id: `pref-${def.key}`, min: r.min, max: r.max, step: r.step });

      const refresh = () => {
        const v = state.prefs[def.key];
        level.textContent = U.prefLevelText(v, levelInfo);
        value.textContent = `(${def.fmt(v)})`;
        input.value = v;
      };
      const setValue = (v, save) => {
        state.prefs[def.key] = v;
        refresh();
        render();
        if (save) store.set('prefs', state.prefs);
      };
      input.addEventListener('input', () => setValue(Number(input.value), false));
      input.addEventListener('change', () => store.set('prefs', state.prefs));

      const stepButton = (direction, text, word) => {
        const b = h('button', { type: 'button', class: 'btn btn-step', 'aria-label': `${def.label}を${word}`, text });
        b.addEventListener('click', () => setValue(U.stepValue(state.prefs[def.key], r.step, direction, r.min, r.max), true));
        return b;
      };

      // 初期値の位置の印(つまみの動く幅に合わせて、位置を補正する)
      const pct = ((levelInfo.def - r.min) / (r.max - r.min)) * 100;
      const mark = h('span', { class: 'default-mark', style: `left: calc(${pct}% + ${(0.5 - pct / 100).toFixed(3)} * var(--thumb))`, 'aria-hidden': 'true' }, '初期値');

      box.appendChild(h('div', { class: 'pref' },
        h('div', { class: 'pref-top' },
          h('label', { for: input.id, class: 'name', text: def.label }),
          h('span', { class: 'state' }, level, ' ', value)),
        h('div', { class: 'slider-row' },
          stepButton(-1, '−', '1つ下げる'),
          h('div', { class: 'slider-wrap' }, input, mark),
          stepButton(1, '＋', '1つ上げる')),
        h('div', { class: 'ends' }, h('span', { text: def.ends[0] }), h('span', { text: def.ends[1] })),
        h('p', { class: 'hint', text: def.hint })));
      refresh();
    });
  }

  /** いまの設定での、7日分の指数(スライダーの上に固定して、動かした結果をその場で見せる)。 */
  function renderPrefsPreview(view) {
    const box = $('prefs-preview');
    box.textContent = '';
    box.appendChild(h('span', { class: 'preview-title', text: 'いまの設定での指数' }));
    const list = h('ul', { class: 'preview-list' });
    view.days.forEach((d) => {
      const g = d.st.hasIndex ? gradeOf(d.result) : null;
      list.appendChild(h('li', { class: `chip grade-${g ? g.id : 'none'}` },
        h('span', { text: U.formatDate(d.day.date) }),
        h('span', { class: 'chip-val', text: g ? `${g.mark}${d.result.score}` : '—' })));
    });
    box.appendChild(list);
  }

  function resetPrefs() {
    state.prefs = T.defaultPrefs(state.params);
    store.remove('prefs');
    buildPrefsUi();
    render();
  }

  // ---------------------------------------------------------------- 感想で調整

  const saveLog = () => store.set('log', state.log);
  const saveSnapshots = () => store.set('snapshots', state.snapshots);

  function gradeMarkOf(score) {
    const g = state.params.grades.find((x) => score >= x.min);
    return g ? g.mark : '';
  }

  /**
   * 今日の指数が出せているあいだに、その日の指数と入力値を覚えておく。
   * 夕方には、その日の日中の降水確率がデータから無くなり、指数が出せなくなるため。感想は、この覚えた値に付ける。
   */
  function maybeSnapshot() {
    if (!state.view) return;
    const today = F.todayJst(Date.now());
    // 先の日も覚えておく。その日に画面を開けなくても、前日までに見た指数と入力値が残る(開くたびに、新しい値に置き換わる)
    state.view.days.forEach((d) => {
      if (!d.st.hasIndex) return;
      const snap = FB.makeSnapshot(state.view.built, d.day, d.result);
      if (snap) state.snapshots[d.day.date] = snap;
    });
    state.snapshots = FB.pruneSnapshots(state.snapshots, today, state.params);
    saveSnapshots();
  }

  function feelingLabel(id) {
    const def = state.params.feedback.feelings.find((f) => f.id === id);
    return def ? def.label : id;
  }

  function renderFeedback() {
    if (!state.params) return;
    const n = state.params.feedback.propose_after;
    $('fb-intro').textContent = `出かけた日の感想を記録すると、好み調整のつまみが少しずつ動きます。同じ感想が${n}回たまると、動かしてよいか確認します(勝手には動かしません)。記録は、このブラウザの中だけに保存され、サーバーには送りません。`;
    renderProposal();
    renderFeedbackDays();
  }

  function renderProposal() {
    const box = $('fb-proposal');
    box.textContent = '';
    box.className = '';
    const prop = FB.nextProposal(state.log, state.prefs, state.params);
    if (!prop) return;
    box.className = 'fb-proposal';
    const def = PREF_DEFS.find((x) => x.key === prop.pref);
    const actions = h('div', { class: 'fb-actions' });
    if (prop.atLimit) {
      box.appendChild(h('p', { text: `「${prop.label}」の感想が${prop.count}回たまりましたが、${prop.prefLabel}は、これ以上動かせません。` }));
      const ok = h('button', { type: 'button', class: 'btn', text: '了解' });
      ok.addEventListener('click', () => decideProposal(prop, false));
      actions.appendChild(ok);
    } else {
      box.appendChild(h('p', { text: `「${prop.label}」の感想が${prop.count}回たまりました。${prop.prefLabel}を ${def.fmt(prop.from)} から ${def.fmt(prop.to)} にしますか?` }));
      const yes = h('button', { type: 'button', class: 'btn', text: '変更する' });
      yes.addEventListener('click', () => decideProposal(prop, true));
      const no = h('button', { type: 'button', class: 'btn', text: '今回は変更しない' });
      no.addEventListener('click', () => decideProposal(prop, false));
      actions.appendChild(yes);
      actions.appendChild(no);
    }
    box.appendChild(actions);
  }

  /** 提案に答える。どちらでも、その感想は使い終えたことにして、同じ確認を繰り返さない。 */
  function decideProposal(prop, accept) {
    if (accept && !prop.atLimit) {
      state.prefs = FB.applyProposal(state.prefs, prop);
      store.set('prefs', state.prefs);
      buildPrefsUi();
    }
    state.log = FB.consume(state.log, prop.id);
    saveLog();
    render();
    renderFeedback();
  }

  function renderFeedbackDays() {
    const box = $('fb-days');
    box.textContent = '';
    const today = F.todayJst(Date.now());
    FB.displayDates(state.snapshots, state.log, today, state.params).forEach((date) => box.appendChild(feedbackDayEl(date)));
    box.appendChild(h('p', { class: 'small muted', text: '今日・前日・前々日は、いつも出ます。指数を覚えていない日も、感想は記録できます。このページを開くと、先の日の指数と入力値も覚えます。' }));
  }

  function feedbackDayEl(date) {
    const entry = state.log.find((e) => e.date === date);
    const snap = state.snapshots[date];
    const row = h('div', { class: 'fb-day' });
    const head = h('div', { class: 'fb-day-head' }, h('span', { class: 'date', text: U.formatDate(date) }));
    head.appendChild(h('span', { class: 'small muted', text: snap ? `${snap.areaName}  指数 ${gradeMarkOf(snap.score)}${snap.score}` : '指数は覚えていません' }));

    if (entry) {
      const undo = h('button', { type: 'button', class: 'btn btn-small', text: '取り消す' });
      undo.addEventListener('click', () => {
        state.log = FB.removeEntry(state.log, date);
        saveLog();
        renderFeedback();
      });
      head.appendChild(undo);
      row.appendChild(head);
      row.appendChild(h('p', { class: 'fb-recorded', text: `記録済み: ${entry.feelings.map(feelingLabel).join('、')}` }));
      return row;
    }

    const open = state.formDate === date;
    const toggle = h('button', { type: 'button', class: 'btn btn-small', text: open ? '閉じる' : '感想を記録する', 'aria-expanded': String(open) });
    toggle.addEventListener('click', () => {
      state.formDate = open ? null : date;
      state.formChecked = new Set();
      renderFeedbackDays();
    });
    head.appendChild(toggle);
    row.appendChild(head);
    if (open) row.appendChild(feelingForm(date, snap || FB.placeholderSnapshot(date, state.view && state.view.built)));
    return row;
  }

  function feelingForm(date, snap) {
    const form = h('div', { class: 'fb-form' });
    const fs = h('fieldset', { class: 'feelings' }, h('legend', { text: 'その日の感想(いくつでも選べます)' }));
    const note = h('p', { class: 'fb-note' });
    const save = h('button', { type: 'button', class: 'btn', text: '記録する' });
    const inputs = [];

    const sync = () => {
      inputs.forEach((i) => { i.checked = state.formChecked.has(i.value); });
      save.disabled = state.formChecked.size === 0;
      note.textContent = state.formChecked.has(FB.WRONG)
        ? `「${feelingLabel(FB.WRONG)}」を選ぶと、この日の感想では、つまみは動きません。`
        : '';
    };

    state.params.feedback.feelings.forEach((def) => {
      const input = h('input', { type: 'checkbox', value: def.id });
      input.addEventListener('change', () => {
        if (input.checked) {
          if (def.id === FB.NEUTRAL) state.formChecked = new Set([FB.NEUTRAL]); // 他の感想とは一緒に選べない
          else {
            state.formChecked.delete(FB.NEUTRAL);
            state.formChecked.add(def.id);
          }
        } else {
          state.formChecked.delete(def.id);
        }
        sync();
      });
      inputs.push(input);
      fs.appendChild(h('label', { class: 'feeling' }, input, def.label));
    });

    save.addEventListener('click', () => {
      const entry = FB.makeEntry(snap, Array.from(state.formChecked), new Date().toISOString(), state.params);
      const next = FB.addEntry(state.log, entry, state.params);
      if (!next) return;
      state.log = next;
      saveLog();
      state.formDate = null;
      state.formChecked = new Set();
      renderFeedback();
    });

    form.appendChild(fs);
    form.appendChild(note);
    form.appendChild(save);
    sync();
    return form;
  }

  function clearLog() {
    if (!state.log.length) return;
    if (!window.confirm('感想の記録をすべて消します。つまみの設定は、いまのままです。よろしいですか?')) return;
    state.log = [];
    saveLog();
    renderFeedback();
  }

  // ---------------------------------------------------------------- 設定の引き継ぎ

  const say = (text) => { $('transfer-msg').textContent = text; };

  function shareUrl() {
    return `${location.href.split('#')[0]}#s=${FB.encodeShare(state.prefs, state.sel)}`;
  }

  function updateShareUrl() {
    if (state.sel && state.prefs) $('share-url').value = shareUrl();
  }

  async function copyShareUrl() {
    const box = $('share-url');
    try {
      await navigator.clipboard.writeText(box.value);
      say('URLをコピーしました。');
    } catch (e) {
      box.select();
      say('コピーできませんでした。選択した文字を、手でコピーしてください。');
    }
  }

  function exportFile() {
    const data = FB.exportSettings(
      { prefs: state.prefs, selection: state.sel, theme: state.theme, log: state.log, snapshots: state.snapshots },
      new Date().toISOString()
    );
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
    const a = h('a', { href: url, download: 'tokotoko-settings.json' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say('ファイルに書き出しました。');
  }

  async function importFile(ev) {
    const file = ev.target.files[0];
    ev.target.value = ''; // 同じファイルをもう一度選べるように
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      say('ファイルが大きすぎます。');
      return;
    }
    const r = FB.parseSettings(await file.text(), state.params, T.resolvePrefs);
    if (!r.ok) {
      say(r.reason);
      return;
    }
    if (!window.confirm('いまの設定と感想の記録を、読み込む内容で置き換えます。よろしいですか?')) return;
    const v = r.value;
    state.prefs = v.prefs;
    store.set('prefs', v.prefs);
    state.log = v.log;
    saveLog();
    state.snapshots = v.snapshots;
    saveSnapshots();
    if (v.theme) {
      applyTheme(v.theme);
      store.set('theme', v.theme);
    }
    buildPrefsUi();
    if (v.selection) await applySelection(U.resolveSelection(state.index, v.selection));
    else render();
    say('設定を読み込みました。');
  }

  /** 設定入りのURL(#s=…)で開いたとき、その設定を読む。読んだあとは、URLからその部分を消す。 */
  function readShareFromHash() {
    const m = /^#s=(.+)$/.exec(location.hash);
    if (!m) return null;
    let shared = null;
    try {
      shared = FB.decodeShare(decodeURIComponent(m[1]), state.params, T.resolvePrefs);
    } catch (e) {
      shared = null;
    }
    history.replaceState(null, '', location.href.split('#')[0]);
    return shared;
  }

  // ---------------------------------------------------------------- 起動

  async function boot() {
    applyTheme(store.get('theme') || 'auto');
    $('theme-btn').addEventListener('click', cycleTheme);

    const today = F.todayJst(Date.now());
    document.body.dataset.season = U.seasonOf(Number(today.slice(5, 7)));

    try {
      const [params, weather, stationArea, index] = await Promise.all([
        getJson('config/params.json'),
        getJson('config/weather_codes.json'),
        getJson('config/station_area.json'),
        getJson('data/index.json'),
      ]);
      Object.assign(state, { params, weather, stationArea, index });
    } catch (e) {
      showStatus('データを読み込めませんでした。時間をおいて、もう一度開いてください。');
      return;
    }

    state.prefs = T.resolvePrefs(state.params, store.get('prefs'));
    state.log = FB.cleanLog(store.get('log'), state.params);
    state.snapshots = FB.cleanSnapshots(store.get('snapshots'));
    const shared = readShareFromHash();
    if (shared) {
      state.prefs = shared.prefs;
      store.set('prefs', state.prefs);
    }
    buildPrefsUi();
    $('prefs-reset').addEventListener('click', resetPrefs);
    $('fb-clear').addEventListener('click', clearLog);
    $('share-copy').addEventListener('click', copyShareUrl);
    $('export-btn').addEventListener('click', exportFile);
    $('import-file').addEventListener('change', importFile);

    $('sel-center').addEventListener('change', onCenterChange);
    $('sel-office').addEventListener('change', onOfficeChange);
    $('sel-area').addEventListener('change', onAreaChange);

    await applySelection(U.resolveSelection(state.index, shared ? shared.selection : store.get('area')));
    if (shared) say('URLの設定を読み込みました。');
  }

  boot();
})();
