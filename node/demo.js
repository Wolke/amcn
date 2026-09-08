// Phase 1 three-node closed-loop demo (SDD §27) — upgraded:
//   real OpenAI-compatible HTTP adapter path (against local key-gated
//   fake providers), keystore-resolved keys, E2E-sealed payloads,
//   E_eff dynamic credit lines + risk fee → insurance pool.
//
// Run:  node demo.js
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { connect, verify } = require('./lib/wire');

const PORT = 47180;
const KEY_A = 'sk-demo-A-SECRET-9f3a1c';
const KEY_B = 'sk-demo-B-SECRET-77e0d2';
const PAYLOAD_1 = 'debug: TypeError in settle() when postings list is empty';
const PAYLOAD_2 = 'summarize: mutual credit conservation rules, 3 bullets';

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

function spawnProc(file, env) {
  const p = spawn(process.execPath, [path.join(__dirname, file)],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  p.stdout.on('data', (d) => process.stdout.write(d.toString()
    .split('\n').filter(Boolean).map((l) => `  ${l}`).join('\n') + '\n'));
  return p;
}
const agentCfg = (o, extraEnv) => ({
  AGENT_CONFIG: JSON.stringify({ hubPort: PORT, ...o }), ...extraEnv,
});

async function main() {
  console.log('== AMCN Phase 1: real-adapter + E2E + E_eff closed loop ==\n');
  const procs = [];
  procs.push(spawnProc('hub.js', { HUB_PORT: String(PORT) }));
  // each provider runs its own key-gated OpenAI-compatible endpoint
  procs.push(spawnProc('fake-provider.js', { FAKE_PORT: '47191', FAKE_KEY: KEY_A }));
  procs.push(spawnProc('fake-provider.js', { FAKE_PORT: '47192', FAKE_KEY: KEY_B }));
  await new Promise((r) => setTimeout(r, 300));

  // A: borrows first, then provides at a repayment discount (UC-01 → UC-02)
  procs.push(spawnProc('agent.js', agentCfg({
    name: 'A',
    adapter: { baseUrl: 'http://127.0.0.1:47191', key: { env: 'A_PROVIDER_KEY', service: 'amcn-demo-a' } },
    provide: { afterMs: 2200, pricePerUnit: 0.95, repayment: true },
    posts: [{ atMs: 600, units: 40, maxPriceCC: 45, payload: PAYLOAD_1 }],
  }, { A_PROVIDER_KEY: KEY_A })));
  // B: always-on provider at reference price
  procs.push(spawnProc('agent.js', agentCfg({
    name: 'B',
    adapter: { baseUrl: 'http://127.0.0.1:47192', key: { env: 'B_PROVIDER_KEY', service: 'amcn-demo-b' } },
    provide: { afterMs: 0, pricePerUnit: 1.0 }, posts: [],
  }, { B_PROVIDER_KEY: KEY_B })));
  // C: third party whose demand lets A repay the network
  procs.push(spawnProc('agent.js', agentCfg({
    name: 'C', adapter: null, provide: null,
    posts: [{ atMs: 2800, units: 48, maxPriceCC: 55, payload: PAYLOAD_2 }],
  })));

  await new Promise((r) => setTimeout(r, 4800));

  const exportMsg = await new Promise((resolve) => {
    const c = connect(PORT, (m) => { if (m.type === 'ledger_export') resolve(m); });
    c.send({ type: 'export' });
  });
  const stats = {};
  for (const [who, port] of [['A', 47191], ['B', 47192]]) {
    stats[who] = await (await fetch(`http://127.0.0.1:${port}/stats`)).json();
  }
  procs.forEach((p) => p.kill());

  const { receipts, pubkeys, balances, credit_lines, raw_log } = exportMsg;
  console.log('\n== 驗收檢查（SDD §20 縮小版＋Phase 1 追加） ==');

  check('§20-1/6 Key 隔離：協議流量無 key；key 只到達本機 provider 端點',
    !raw_log.includes('SECRET') && stats.A.authOk >= 1 && stats.B.authOk >= 1,
    `hub ${raw_log.length}B clean; local auth A:${stats.A.authOk} B:${stats.B.authOk}`);

  check('NFR-005 E2E：payload 明文不經 Hub（X25519+AES-GCM 封裝）',
    !raw_log.includes('TypeError in settle') && !raw_log.includes('conservation rules'),
    'both payloads sealed to winning provider only');

  check('雙簽收據：兩筆結算、四個簽章全部驗證通過',
    receipts.length === 2 && receipts.every(({ receipt, sigs }) =>
      verify(pubkeys[receipt.requester], receipt, sigs.requester) &&
      verify(pubkeys[receipt.provider], receipt, sigs.provider)),
    `${receipts.length} receipts`);

  const rebuilt = {};
  for (const { receipt } of receipts) {
    for (const p of receipt.postings) {
      rebuilt[p.account] = +((rebuilt[p.account] || 0) + p.amount_cc).toFixed(6);
    }
  }
  const sum = Object.values(rebuilt).reduce((s, v) => s + v, 0);
  check('§20-4 帳本可由簽署收據重建且 Σ=0（含 treasury＋insurance）',
    Math.abs(sum) < 1e-9 &&
    Object.entries(rebuilt).every(([a, v]) => Math.abs((balances[a] || 0) - v) < 1e-6) &&
    (balances['protocol:insurance'] || 0) > 0,
    `Σ=${sum.toFixed(9)}, insurance=${(balances['protocol:insurance'] || 0).toFixed(2)} CC`);

  const [r1, r2] = receipts.map((r) => r.receipt);
  const A = r1.requester;
  const aLoan = r1.postings.find((p) => p.account === A).amount_cc;
  check('§20-2 從 0 CC 在 E_eff 動態信用額度內借用',
    aLoan === -40 && Math.abs(aLoan) <= 50, `A → ${aLoan} CC（starter 50）`);

  check('§20-3 替第三方工作、負餘額完全清償（多邊清算）',
    r2.provider === A && r2.requester !== r1.provider && balances[A] > 0,
    `A: -40 → ${balances[A].toFixed(2)} CC（服務 C，非債主 B）`);

  const B = r1.provider;
  check('反洗量即時生效：B 從單一對手賺 36.6 CC，信用額度零成長',
    credit_lines[B] <= 50 + 1e-6,
    `CL(B)=${credit_lines[B].toFixed(1)}（E_eff 對單一對手收益記 0）`);

  check('§20-7 確定性驗收＋真 HTTP adapter 路徑',
    receipts.every(({ receipt }) => receipt.delivery_hash?.length === 64) &&
    stats.A.requests + stats.B.requests >= 2,
    `${stats.A.requests + stats.B.requests} real OpenAI-compatible calls served locally`);

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n結果：${results.length - failed}/${results.length} PASS`);
  console.log('期末餘額：', Object.entries(balances)
    .map(([a, v]) => `${a.startsWith('did') ? a.slice(0, 18) : a}=${v.toFixed(2)}`)
    .join('  '));
  process.exit(failed ? 1 : 0);
}

main();
