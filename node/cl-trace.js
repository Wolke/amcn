#!/usr/bin/env node
// 重放共用流水，輸出每一步的信用額度（紅隊盤點 E5，node 側）。
// 對照組是 sim/amcn_sim/cl_trace.py，兩邊吃同一份 fixture。
'use strict';
const fs = require('node:fs');
const eeff = require('./lib/eeff');

const path = process.argv[2] || '../sim/fixtures/cl-flows.json';
const fx = JSON.parse(fs.readFileSync(path, 'utf8'));
// The fixture declares the account age both sides must assume; the
// simulator's tick-0 agents ramp from there (min(1, age/30d)).
const AGE = Math.max(0, Math.min(1, (fx.age_days != null ? fx.age_days : 0) / 30));
const stats = new Map();
const of = (n) => {
  if (!stats.has(n)) stats.set(n, eeff.newStats());
  return stats.get(n);
};
fx.agents.forEach(of);
const statsOf = (n) => stats.get(n);

const steps = fx.flows.map((f, i) => {
  const payer = of(f.payer), payee = of(f.payee);
  payee.earnedBy.set(f.payer, (payee.earnedBy.get(f.payer) || 0) + f.amount);
  payer.paidTo.set(f.payee, (payer.paidTo.get(f.payee) || 0) + f.amount);
  payee.completed += 1;
  const cl = {};
  for (const n of fx.agents) {
    cl[n] = +eeff.creditLine(n, of(n), statsOf, AGE).toFixed(6);
  }
  return { step: i + 1, flow: `${f.payer}->${f.payee}:${f.amount}`, cl };
});

console.log(JSON.stringify({ impl: 'node/lib/eeff.js',
  starter_cc: eeff.STARTER_CC, steps }));
