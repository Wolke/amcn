#!/usr/bin/env node
// 跨語言信用額度對照（紅隊盤點 E5）。
//
// `sim/amcn_sim/agents.py` 與 `node/lib/eeff.js` 是同一條公式的兩份手抄
// 實作，而登記簿三次「數字打架」（#1、#20、#25）都是這個形態。讀程式碼
// 不算數：兩邊重放同一組流水，逐步比對，把分歧變成一個數字。
//
// Run:  node cl-compare.js
'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const FIX = path.join(__dirname, '..', 'sim', 'fixtures', 'cl-flows.json');
const simOut = execFileSync('python3', ['-m', 'amcn_sim.cl_trace', 'fixtures/cl-flows.json'],
  { cwd: path.join(__dirname, '..', 'sim'), encoding: 'utf8' });
const nodeOut = execFileSync(process.execPath, [path.join(__dirname, 'cl-trace.js'), FIX],
  { encoding: 'utf8' });
const sim = JSON.parse(simOut);
const nod = JSON.parse(nodeOut);

console.log('== 信用額度跨語言對照（同一組流水）==');
console.log(`   模擬器 ${sim.impl}（starter ${sim.starter_cc}）`);
console.log(`   原型   ${nod.impl}（starter ${nod.starter_cc}）\n`);

const agents = Object.keys(sim.steps[0].cl);
let worst = { diff: 0 };
const rows = [];
for (let i = 0; i < sim.steps.length; i++) {
  const a = sim.steps[i], b = nod.steps[i];
  for (const n of agents) {
    const d = Math.abs(a.cl[n] - b.cl[n]);
    const ratio = b.cl[n] ? a.cl[n] / b.cl[n] : NaN;
    if (d > worst.diff) worst = { diff: d, step: a.step, agent: n, sim: a.cl[n], node: b.cl[n], ratio };
    rows.push({ step: a.step, agent: n, sim: a.cl[n], node: b.cl[n], d, ratio });
  }
}
const show = [1, Math.ceil(sim.steps.length / 2), sim.steps.length];
console.log('步驟   agent   模擬器      原型        比值');
for (const s of show) {
  for (const n of agents) {
    const r = rows.find((x) => x.step === s && x.agent === n);
    console.log(`${String(s).padStart(4)}   ${n}      ` +
      `${r.sim.toFixed(2).padStart(8)}  ${r.node.toFixed(2).padStart(8)}  ` +
      `${(r.ratio || 0).toFixed(3)}`);
  }
}
const mean = rows.reduce((t, r) => t + r.d, 0) / rows.length;
const meanRatio = rows.reduce((t, r) => t + (r.ratio || 0), 0) / rows.length;
console.log(worst.agent
  ? `\n最大分歧  ${worst.diff.toFixed(2)} CC（第 ${worst.step} 步，${worst.agent}：` +
    `模擬器 ${worst.sim.toFixed(2)} vs 原型 ${worst.node.toFixed(2)}，比值 ${worst.ratio.toFixed(3)}）`
  : '\n最大分歧  0.00 CC — 兩個實作在每一步上完全一致');
console.log(`平均分歧  ${mean.toFixed(2)} CC，平均比值 ${meanRatio.toFixed(3)}`);
const agree = rows.filter((r) => r.d < 0.01).length;
console.log(`一致步數  ${agree}/${rows.length}`);
process.exit(agree === rows.length ? 0 : 1);
