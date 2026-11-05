// Node.js でテストを走らせる: node tests/run.js
// ブラウザで見るときは tests/index.html(簡易サーバー経由)を使う。
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

const Tokotoko = require(path.join(root, 'src', 'score.js'));
const TokotokoForecast = require(path.join(root, 'src', 'forecast.js'));
const scoreCases = require(path.join(__dirname, 'cases.js'));
const forecastCases = require(path.join(__dirname, 'forecast_cases.js'));
const uiCases = require(path.join(__dirname, 'ui_cases.js'));
const feedbackCases = require(path.join(__dirname, 'feedback_cases.js'));
const TokotokoFeedback = require(path.join(root, 'src', 'feedback.js'));
const TokotokoUi = require(path.join(root, 'src', 'ui_logic.js'));

const params = readJson('config/params.json');
const weather = readJson('config/weather_codes.json');
const stationArea = readJson('config/station_area.json');
const fixtures = {};
for (const f of fs.readdirSync(path.join(__dirname, 'fixtures'))) {
  fixtures[f.replace(/\.json$/, '')] = readJson(path.join('tests', 'fixtures', f));
}

const groups = [
  ['指数の計算(src/score.js)', scoreCases.runTests(Tokotoko, params, weather)],
  ['日ごとの入力(src/forecast.js)', forecastCases.runTests(TokotokoForecast, Tokotoko, params, weather, stationArea, fixtures)],
  ['画面の部品(src/ui_logic.js)', uiCases.runTests(TokotokoUi, params, weather)],
  ['感想による調整(src/feedback.js)', feedbackCases.runTests(TokotokoFeedback, Tokotoko, params)],
];

let total = 0;
let failed = 0;
for (const [title, results] of groups) {
  console.log(`\n${title}`);
  for (const r of results) {
    total++;
    if (r.ok) {
      console.log(`  ok   ${r.name}`);
    } else {
      failed++;
      console.log(`  FAIL ${r.name}\n         ${r.message}`);
    }
  }
}
console.log(`\n${total - failed} / ${total} 件が成功`);
process.exit(failed === 0 ? 0 : 1);
