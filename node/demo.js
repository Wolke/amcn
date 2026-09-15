// Phase 1 demo, round 3: DSL acceptance, judge-quorum, dual-signed
// contracts + pre_authorization, FORCED settlement against a refusing
// requester (T-05), per-account hash chains + hub checkpoints with a
// tamper-evidence test, and a minimal Owner Console.
//
// Run:  node demo.js
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { connect, verify, sha256, canon, net } = require('./lib/wire');
const discovery = require('./lib/discovery');
const strategy = require('./lib/strategy');
const panelLib = require('./lib/panel');
const eeff = require('./lib/eeff');

// Every port is derived from one offset so the demo can run alongside a live
// pilot stack (which holds 47180 and the 47201 console) without colliding:
//   DEMO_PORT_OFFSET=100 node demo.js
const PORT_OFFSET = Number(process.env.DEMO_PORT_OFFSET || 0);
const PORT = 47180 + PORT_OFFSET;
const FAKE_A_PORT = 47191 + PORT_OFFSET;
const FAKE_B_PORT = 47192 + PORT_OFFSET;
const CONSOLE_A_PORT = 47201 + PORT_OFFSET;
const BEACON_PORT = 47179 + PORT_OFFSET;
const KEY_A = 'sk-demo-A-SECRET-9f3a1c';
const KEY_B = 'sk-demo-B-SECRET-77e0d2';
const PAYLOAD_1 = 'debug: TypeError in settle() when postings list is empty';
const PAYLOAD_2 = 'summarize: mutual credit conservation rules, 3 bullets';
const PAYLOAD_3 = 'classify: is this task spam? return JSON verdict';

// Frame shapes that used to crash the hub: bad DER pubkey, non-JSON, wrong
// field types, and handler-reachable frames with required fields missing.
const JUNK_FRAMES = [
  '{"type":"register","did":"did:demo:attacker","pub":"AAAA","box_pub":"AAAA","sig":"AAAA"}',
  'not json at all',
  '{"type":"register","did":"x","pub":null,"sig":12345}',
  '{"type":"receipt"}',
  '{"type":"forced_settlement"}',
];

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

// offline chain verification: anyone can do this from the export alone
function verifyChains(chains, checkpoints, hubPub) {
  for (const [account, chain] of Object.entries(chains)) {
    let balance = 0, prev = sha256(account);
    for (const e of chain) {
      const { hash, ...body } = e;
      if (sha256(canon(body)) !== hash) return `hash mismatch ${account}#${e.seq}`;
      if (e.prev_hash !== prev) return `broken link ${account}#${e.seq}`;
      balance = +(balance + e.delta_cc).toFixed(6);
      if (Math.abs(balance - e.balance_after) > 1e-6) {
        return `balance mismatch ${account}#${e.seq}`;
      }
      prev = hash;
    }
  }
  const last = checkpoints.at(-1);
  const heads = {};
  for (const [account, chain] of Object.entries(chains)) {
    heads[account] = chain.at(-1).hash;
  }
  if (sha256(canon(heads)) !== last.cp.root) return 'checkpoint root mismatch';
  if (!verify(hubPub, last.cp, last.sig)) return 'bad checkpoint signature';
  return null; // clean
}

async function main() {
  console.log('== AMCN Phase 1 round 3: quorum + forced settlement + hash chain ==\n');
  const procs = [];
  procs.push(spawnProc('hub.js',
    { HUB_PORT: String(PORT), HUB_BEACON_PORT: String(BEACON_PORT) }));
  procs.push(spawnProc('fake-provider.js', { FAKE_PORT: String(FAKE_A_PORT), FAKE_KEY: KEY_A }));
  procs.push(spawnProc('fake-provider.js', { FAKE_PORT: String(FAKE_B_PORT), FAKE_KEY: KEY_B }));
  await new Promise((r) => setTimeout(r, 300));
  for (const v of ['V1', 'V2', 'V3']) {
    procs.push(spawnProc('verifier.js', agentCfg({ name: v })));
  }

  const SHA_OK = [{ op: 'sha256_eq' }, { op: 'max_len', arg: 64 }];
  // A: borrows (T1), then provides; exposes an Owner Console
  procs.push(spawnProc('agent.js', agentCfg({
    name: 'A', consolePort: CONSOLE_A_PORT,
    adapter: { baseUrl: `http://127.0.0.1:${FAKE_A_PORT}`, key: { env: 'A_PROVIDER_KEY', service: 'amcn-demo-a' } },
    provide: { afterMs: 2200, pricePerUnit: 0.95, repayment: true },
    posts: [
      { atMs: 600, units: 40, maxPriceCC: 45, payload: PAYLOAD_1,
        acceptance: 'dsl-local', asserts: SHA_OK },
      // Non-essential, and timed inside A's repayment window (A settles its
      // borrow around 2s and climbs back out around 4s), so FR-055 must pause
      // it rather than let it consume while the node is under its band.
      { atMs: 3000, units: 5, maxPriceCC: 6, essential: false,
        payload: 'optional: nice-to-have cleanup task',
        acceptance: 'dsl-local', asserts: SHA_OK },
    ],
  }, { A_PROVIDER_KEY: KEY_A })));
  // B: provider; later a MALICIOUS requester who refuses to settle (T3)
  procs.push(spawnProc('agent.js', agentCfg({
    name: 'B', refuseToSettle: true,
    adapter: { baseUrl: `http://127.0.0.1:${FAKE_B_PORT}`, key: { env: 'B_PROVIDER_KEY', service: 'amcn-demo-b' } },
    provide: { afterMs: 0, pricePerUnit: 1.0 },
    posts: [{ atMs: 5200, units: 30, maxPriceCC: 35, payload: PAYLOAD_3,
              acceptance: 'judge-quorum', asserts: SHA_OK }],
  }, { B_PROVIDER_KEY: KEY_B })));
  // C: honest third party; quorum acceptance (T2)
  procs.push(spawnProc('agent.js', agentCfg({
    name: 'C', adapter: null, provide: null,
    posts: [{ atMs: 2800, units: 48, maxPriceCC: 55, payload: PAYLOAD_2,
              acceptance: 'judge-quorum', asserts: SHA_OK }],
  })));

  await new Promise((r) => setTimeout(r, 9000));

  const ex = await new Promise((resolve) => {
    const c = connect(PORT, (m) => { if (m.type === 'ledger_export') resolve(m); });
    c.send({ type: 'export' });
  });
  const consoleA = await (await fetch(`http://127.0.0.1:${CONSOLE_A_PORT}/status`)).json();

  // Discovery: an agent with no hand-copied IP must find the hub from its
  // signed UDP beacon, and a wrong pin must be rejected (otherwise anyone on
  // the broadcast domain could answer for the hub).
  const beacon = await discovery.discoverHub({ port: BEACON_PORT, timeoutMs: 4000 });
  const wrongPin = await discovery.discoverHub({
    port: BEACON_PORT, timeoutMs: 1200, pin: 'did:demo:0000000000000000',
  });

  // contract_id is the settlement idempotency key (W1 schema freeze). Replay a
  // receipt the hub already settled: it must be refused, and no balance may
  // move. `t-<name>-<seq>` alone used to collide across restarts, so two
  // agents held receipts under one id.
  const first = ex.receipts[0];
  const replay = await new Promise((resolve) => {
    const t = setTimeout(() => resolve('no reply'), 2500);
    const c = connect(PORT, (m) => {
      if (m.type === 'error' && m.ref === first.receipt.contract_id) {
        clearTimeout(t); c.sock.destroy(); resolve(m.why);
      }
    });
    c.send({ type: 'receipt', receipt: first.receipt, sigs: first.sigs });
  });
  const afterReplay = await new Promise((resolve) => {
    const c = connect(PORT, (m) => {
      if (m.type === 'ledger_export') { c.sock.destroy(); resolve(m); }
    });
    c.send({ type: 'export' });
  });
  const idsUnique = (() => {
    const ids = ex.receipts.map((r) => r.receipt.contract_id);
    return new Set(ids).size === ids.length;
  })();

  // Regression gate: a malformed frame from any LAN peer must not be able to
  // kill the hub. It could — createPublicKey() throws on bad DER and the throw
  // escaped the socket 'data' handler, taking the hub and every connected
  // verifier down with it. Probed after the export above, so the junk lands in
  // raw_log only after the NFR-005 plaintext scan has captured its copy.
  await new Promise((resolve) => {
    const c = connect(PORT, () => {});
    JUNK_FRAMES.forEach((line) => c.sock.write(line + '\n'));
    setTimeout(() => { c.sock.destroy(); resolve(); }, 200);
  });
  const hubSurvived = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 3000);
    const c = connect(PORT, (m) => {
      if (m.type === 'ledger_export') { clearTimeout(t); c.sock.destroy(); resolve(true); }
    });
    c.send({ type: 'export' });
  });

  procs.forEach((p) => p.kill());

  const { receipts, pubkeys, balances, credit_lines, chains, checkpoints,
          hub_pub, raw_log } = ex;
  console.log('\n== 驗收檢查 ==');

  check('§20-1/6 Key 隔離＋NFR-005 E2E（3 個 payload 明文皆不經 Hub）',
    !raw_log.includes('SECRET') && !raw_log.includes('TypeError in settle') &&
    !raw_log.includes('conservation rules') && !raw_log.includes('is this task spam'),
    `hub traffic ${raw_log.length}B clean`);

  const kinds = receipts.map((r) => r.kind);
  check('三筆結算：兩筆雙簽 + 一筆強制結算',
    receipts.length === 3 && kinds.filter((k) => k === 'dual').length === 2 &&
    kinds.filter((k) => k === 'forced').length === 1, kinds.join(', '));

  const dualOk = receipts.filter((r) => r.kind === 'dual').every(({ receipt, sigs }) =>
    verify(pubkeys[receipt.requester], receipt, sigs.requester) &&
    verify(pubkeys[receipt.provider], receipt, sigs.provider));
  check('雙簽收據簽章全部驗證通過', dualOk);

  const forced = receipts.find((r) => r.kind === 'forced');
  const fEv = forced?.evidence;
  const forcedOk = forced &&
    verify(pubkeys[forced.receipt.provider], forced.receipt,
      forced.sigs.provider) &&
    forced.sigs.requester.startsWith('pre_auth:') &&
    verify(pubkeys[forced.receipt.requester], fEv.pre_auth,
      fEv.pre_auth_sig) &&
    fEv.attestations.filter((a) => a.attestation.verdict === 'PASS' &&
      verify(pubkeys[a.attestation.verifier], a.attestation, a.sig)).length >= 2;
  check('T-05 反拒付：拒簽的 Requester 仍被 pre_auth＋2-of-3 quorum 強制記帳',
    !!forcedOk,
    forced && `B 被記 ${forced.receipt.postings.find((p) => p.account === forced.receipt.requester).amount_cc} CC，證據包離線可驗`);

  check('FR-041/FR-044 Verifier pool 於合約時釘住、attestation 機器可讀',
    !!fEv && fEv.contract.verifier_pool.length === 3 &&
    panelLib.poolHash(fEv.contract.verifier_pool) === fEv.contract.verifier_pool_hash &&
    fEv.attestations.every((a) => Array.isArray(a.attestation.failures)),
    `pool of ${fEv?.contract.verifier_pool.length} 與 pinned hash 相符, failures[] present`);

  // §4 #6: the seed must be a checkpoint that did not exist when the contract
  // was signed, and the attesting panel must be exactly what that root
  // selects — otherwise the requester could have fanned out to a panel of its
  // choosing, or ground the contract id against a root it already knew.
  const seedCp = fEv && checkpoints[fEv.contract.panel_seed_cp];
  const derived = seedCp && new Set(panelLib.deriveDids(
    fEv.contract.verifier_pool, fEv.contract.contract_id, seedCp.cp.root));
  const attesters = fEv && new Set(fEv.attestations.map((a) => a.attestation.verifier));
  check('§4 #6 抽選種子綁未來 checkpoint：種子序號 > 合約時已知序號，且實際 panel = 該 root 推導結果',
    !!seedCp && !!derived &&
    fEv.contract.verifier_lock.checkpoint_seq < fEv.contract.panel_seed_cp &&
    [...attesters].every((v) => derived.has(v)) && attesters.size >= 2,
    fEv && `合約時已知 #${fEv.contract.verifier_lock.checkpoint_seq} < 種子 ` +
      `#${fEv.contract.panel_seed_cp}, ${attesters?.size} 位 attester 全在推導出的 panel 內`);

  // §4 #5: the verification fee used to vanish from the flagship journal
  // entry. Every judge-quorum settlement must pay the derived panel, split
  // equally, out of the provider's gross — and a dsl-local settlement must pay
  // no verifiers at all.
  const verifierPaid = (r) => r.receipt.postings
    .filter((x) => r.receipt.verifier_pool.includes(x.account));
  const quorumReceipts = receipts.filter((r) => r.receipt.acceptance_method === 'judge-quorum');
  const localReceipts = receipts.filter((r) => r.receipt.acceptance_method !== 'judge-quorum');
  const feeOk = quorumReceipts.length >= 2 && quorumReceipts.every((r) => {
    const price = -r.receipt.postings.find((x) => x.account === r.receipt.requester).amount_cc;
    const paid = verifierPaid(r);
    const total = paid.reduce((t, x) => t + x.amount_cc, 0);
    const seed = checkpoints[r.receipt.panel_seed_cp];
    const derived = seed && panelLib.deriveDids(
      r.receipt.verifier_pool, r.receipt.contract_id, seed.cp.root);
    return paid.length === 3 && derived &&
      paid.every((x) => derived.includes(x.account)) &&
      Math.abs(total - price * eeff.VERIFIER_RATE) < 1e-3;
  }) && localReceipts.every((r) => verifierPaid(r).length === 0);
  check(`§4 #5 驗證費顯式入帳：judge-quorum 每筆付給推導出的 panel（${eeff.VERIFIER_RATE * 100}%，均分），dsl-local 不付`,
    feeOk,
    `${quorumReceipts.length} 筆 quorum 各付 3 位, ${localReceipts.length} 筆 dsl-local 付 0 位, ` +
    `verifier 期末餘額 ${Object.entries(balances)
      .filter(([a]) => quorumReceipts[0] && quorumReceipts[0].receipt.verifier_pool.includes(a))
      .map(([, v]) => v.toFixed(2)).join('/')}`);

  const chainErr = verifyChains(chains, checkpoints, hub_pub);
  check('NFR-006 hash chain＋checkpoint：全鏈離線重驗通過',
    chainErr === null, chainErr || `${Object.keys(chains).length} chains, ${checkpoints.length} checkpoints`);

  const tampered = JSON.parse(JSON.stringify(chains));
  tampered[Object.keys(tampered)[0]][0].delta_cc += 1; // forge 1 CC
  check('防竄改：偽造任一筆金額即被離線驗證抓出',
    verifyChains(tampered, checkpoints, hub_pub) !== null,
    `tamper detected: "${verifyChains(tampered, checkpoints, hub_pub)}"`);

  const rebuilt = {};
  for (const { receipt } of receipts) {
    for (const p of receipt.postings) {
      rebuilt[p.account] = +((rebuilt[p.account] || 0) + p.amount_cc).toFixed(6);
    }
  }
  const sum = Object.values(rebuilt).reduce((s, v) => s + v, 0);
  check('§20-4 Σ=0 且收據重建 = Hub 帳（含 treasury/insurance）',
    Math.abs(sum) < 1e-9 &&
    Object.entries(rebuilt).every(([a, v]) => Math.abs((balances[a] || 0) - v) < 1e-6),
    `Σ=${sum.toFixed(9)}, insurance=${balances['protocol:insurance'].toFixed(2)}`);

  const A = receipts[0].receipt.requester;
  const B = receipts[0].receipt.provider;
  check('§20-2/3 閉環：A 額度內借 40 → 服務第三方 → 期末轉正',
    receipts[0].receipt.postings.find((p) => p.account === A).amount_cc === -40 &&
    balances[A] > 0, `A: 0 → -40 → ${balances[A].toFixed(2)} CC`);

  // FR-055 / UC-02: A borrows 40, which puts it under -0.3 x CL, so it must
  // switch to repayment — discount its supply 10% and pause the non-essential
  // post — then climb back into the band and switch out again.
  const aSupplied = receipts.find((r) => r.receipt.provider === A);
  const paidToA = aSupplied &&
    -aSupplied.receipt.postings.find((p) => p.account === aSupplied.receipt.requester).amount_cc;
  const st = consoleA.strategy;
  // Percentages read from lib/strategy.js so this label cannot go stale the
  // way the "now providing" log did (§4 #19).
  const discPct = strategy.REPAY_DISCOUNT * 100;
  check(`FR-055 目標餘額區間＋還債排程：跌破 low → 供給折價 ${discPct}%、非必要消費暫停 → 回到區間（UC-02）`,
    !!st && st.repay_episodes >= 1 && st.paused_posts === 1 &&
    st.mode === 'normal' &&
    Math.abs(paidToA - 48 * strategy.priceFor(0.95, 'repay')) < 1e-6,
    st && `episodes=${st.repay_episodes}, paused=${st.paused_posts}, ` +
      `A 折價後收 ${paidToA} CC (48u × ${strategy.priceFor(0.95, 'repay')}), ` +
      `期末 mode=${st.mode}`);

  check('§20-10 平均還債時間可輸出',
    !!st && typeof st.avg_repayment_ms === 'number' && st.avg_repayment_ms > 0 &&
    st.in_repayment_since === null,
    st && `avg_repayment_ms=${st.avg_repayment_ms}`);

  check('F-1 反洗量即時生效：B 有收入但單一對手 → 信用零成長',
    credit_lines[B] <= 50 + 1e-6, `CL(B)=${credit_lines[B].toFixed(1)}`);

  check('FR-081 Owner Console：餘額/額度/結算史與 Hub 一致',
    consoleA.did === A &&
    Math.abs(consoleA.balance_cc - balances[A]) < 1e-6 &&
    consoleA.settled.length >= 2,
    `A console: ${consoleA.balance_cc.toFixed(2)} CC, ${consoleA.settled.length} settlements`);

  check('contract_id 冪等：重放已結算收據被拒、餘額不動、id 全域唯一（W1 schema）',
    /duplicate contract_id/.test(replay) && idsUnique &&
    afterReplay.receipts.length === ex.receipts.length &&
    Object.keys(balances).every((a) =>
      Math.abs((afterReplay.balances[a] || 0) - balances[a]) < 1e-9),
    `replay refused: "${replay}", ${ex.receipts.length} receipts unchanged`);

  // Same-host only: this agent and the hub run on one machine, so a green
  // result says nothing about cross-machine broadcast — machine 2 could not
  // discover the hub in the pilot and needed a hand-typed IP (§4 #18).
  check('UDP 發現（同機）：找到 Hub 且錯誤的 pin 被拒絕；跨機未驗證，見 §4 #18',
    !!beacon && beacon.port === PORT && beacon.pub === hub_pub && wrongPin === null,
    beacon ? `beacon → ${beacon.host}:${beacon.port} ${beacon.did}, wrong pin rejected` : 'no beacon heard');

  check('畸形 frame 不能打掉 Hub（§16 區網可用性回歸閘門）', hubSurvived,
    `${JUNK_FRAMES.length} 類畸形 frame 後 Hub 仍正常回應 export`);

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n結果：${results.length - failed}/${results.length} PASS`);
  console.log('期末餘額：', Object.entries(balances)
    .filter(([, v]) => Math.abs(v) > 1e-9 || true)
    .map(([a, v]) => `${a.startsWith('did') ? a.slice(0, 18) : a}=${v.toFixed(2)}`)
    .join('  '));
  process.exit(failed ? 1 : 0);
}

main();
