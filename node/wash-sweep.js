#!/usr/bin/env node
// E3（紅隊盤點）：洗量拓撲對信用額度的實際效果。
//
// 盤點表把 E3 記成「block？ ... 環狀是否被壓制**未驗證**」，這支就是去驗證它。
// F-1 的折減是**成對**的：w = 1 − (對手付給我的 / 對手的總支出)，所以要問的不是
// 「洗量會不會被抓」而是「哪一種洗量形狀會漏，漏多少」。
//
// 三種拓撲，同樣的每邊金額：
//   ring    A→B→C→…→A，每人只付下一個（規避成對偵測的直覺做法）
//   clique  每人付給每一個其他人（密集互刷）
//   star    一人付給所有人（單一金主）
//
// 報表的重點欄位是 leverage：買到的信用額度 ÷ 為此付出的手續費。攻擊者最後
// 會違約，所以額度是收益、手續費是成本，這個比值就是攻擊的報酬率。
'use strict';
const eeff = require('./lib/eeff');

const EDGE_CC = 10;          // 每條邊的金額
const AGE = 0;               // t=0，最不利於攻擊者（額度只有一半 starter）

function run(topology, n) {
  const names = Array.from({ length: n }, (_, i) => `x${i}`);
  const stats = new Map(names.map((x) => [x, eeff.newStats()]));
  const statsOf = (x) => stats.get(x);
  const edges = [];
  for (let i = 0; i < n; i++) {
    if (topology === 'ring') edges.push([names[i], names[(i + 1) % n]]);
    if (topology === 'clique') {
      for (let j = 0; j < n; j++) if (j !== i) edges.push([names[i], names[j]]);
    }
    if (topology === 'star' && i > 0) edges.push([names[0], names[i]]);
  }
  for (const [payer, payee] of edges) {
    stats.get(payee).earnedBy.set(payer,
      (stats.get(payee).earnedBy.get(payer) || 0) + EDGE_CC);
    stats.get(payer).paidTo.set(payee,
      (stats.get(payer).paidTo.get(payee) || 0) + EDGE_CC);
    stats.get(payee).completed += 1;
  }
  // 以「最好的那個身分」評估：攻擊者只需要一個身分借到錢就夠了。
  let best = null;
  for (const x of names) {
    const s = stats.get(x);
    const gross = [...s.earnedBy.values()].reduce((a, b) => a + b, 0);
    const eff = eeff.effectiveContribution(x, s, statsOf);
    const cl = eeff.creditLine(x, s, statsOf, AGE);
    if (!best || cl > best.cl) best = { x, gross, eff, cl, stats: s };
  }
  // 手續費：整個團體為了製造這些流水付出的總額（以最壞情況 thin 費率計，
  // 因為新身分本來就是 thin——這對攻擊者有利的方向是低估成本，所以要小心
  // 別用 base 費率讓 leverage 看起來更漂亮）。
  const volume = edges.length * EDGE_CC;
  const feeTotal = edges.reduce((sum, [payer]) =>
    sum + EDGE_CC * (eeff.FEE_RATE + eeff.riskRate(stats.get(payer))), 0);
  const baseline = eeff.creditLine('none', eeff.newStats(), () => null, AGE);
  const bought = best.cl - baseline;
  // 打平費率：手續費率降到多少，這個攻擊才開始有利可圖。這是整份報表最重要
  // 的數字，因為 #61 的方向是**調降**手續費（小網路被抽乾），而擋住團狀洗量
  // 的其實不是 F-1 折減而是手續費——兩個需求直接對撞。
  const feeRate = volume > 0 ? feeTotal / volume : 0;
  const breakEven = volume > 0 ? bought / volume : 0;
  return {
    topology, n, edges: edges.length, volume,
    gross: best.gross, eff: +best.eff.toFixed(3),
    effFrac: best.gross ? +(best.eff / best.gross).toFixed(3) : 0,
    cl: +best.cl.toFixed(2), bought: +bought.toFixed(2),
    fees: +feeTotal.toFixed(2),
    leverage: feeTotal > 0 ? +(bought / feeTotal).toFixed(2) : 0,
    feeRate: +(feeRate * 100).toFixed(2),
    breakEven: +(breakEven * 100).toFixed(2),
    margin: breakEven > 0 ? +(feeRate / breakEven).toFixed(2) : Infinity,
  };
}

const rows = [];
for (const topology of ['ring', 'clique', 'star']) {
  for (const n of [3, 4, 5, 6, 8, 10, 12, 16, 24]) rows.push(run(topology, n));
}

const base = eeff.creditLine('none', eeff.newStats(), () => null, AGE);
console.log(`== E3 洗量拓撲對信用額度的效果（starter ${eeff.STARTER_CC} CC、` +
  `age ${AGE} → 無貢獻時額度 ${base.toFixed(2)} CC、每邊 ${EDGE_CC} CC）==\n`);
console.log('拓撲     N   邊數   總量   收入  有效貢獻  有效率  額度   買到   手續費  槓桿  實付費率 打平費率 餘裕');
for (const r of rows) {
  if (r.n === 3 && r.topology !== 'ring') console.log('');
  console.log(
    `${r.topology.padEnd(7)} ${String(r.n).padStart(2)}  ` +
    `${String(r.edges).padStart(4)}  ${String(r.volume).padStart(5)}  ` +
    `${r.gross.toFixed(0).padStart(4)}  ${r.eff.toFixed(2).padStart(8)}  ` +
    `${(r.effFrac * 100).toFixed(1).padStart(5)}%  ` +
    `${r.cl.toFixed(1).padStart(5)}  ${r.bought.toFixed(1).padStart(5)}  ` +
    `${r.fees.toFixed(1).padStart(6)}  ${r.leverage.toFixed(2).padStart(5)}  ` +
    `${r.feeRate.toFixed(2).padStart(7)}% ${r.breakEven.toFixed(2).padStart(7)}% ` +
    `${(r.margin === Infinity ? '∞' : r.margin.toFixed(2) + '×').padStart(6)}`);
}
console.log('\n（有效率 = 有效貢獻 ÷ 帳面收入，100% 表示折減完全失效；' +
  '槓桿 = 買到的額度 ÷ 手續費，攻擊者最後違約所以額度是收益）');
