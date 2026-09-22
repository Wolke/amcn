// #90 的閘門：入門採購買的是**答案已知的工作**，不是把額度送出去。
//
// 為什麼這件事值得一支自己的閘門：整個機制的支點不是「Treasury 付錢給新人」，
// 而是「付錢之前那份工作被判過」。少了那一條，入門採購就只是換個記帳名目的
// 無擔保贈與——攻擊者每個身分白拿一筆，而模擬器量到的「每身分白拿 17.49 →
// 0.00 CC」完全不成立。所以這支 demo 的四條負對照比正向那一條重要：
//
//   (1) 斷言不是確定性的（`contains` 之類）→ 拒絕。答案判不出來的工作
//       無法為身分定價，那是登記簿 #90 的條件 (i)。
//   (2) 面板沒有足夠的可問責 PASS → 拒絕。與結算同一個標準（commit-reveal）。
//   (3) 收款方已經有賺得紀錄 → 拒絕。入門採購是給沒有紀錄的人，老手要更高
//       上限走抵押（#65）。
//   (4) 超過每身分上限 → 拒絕。這筆錢來自 Treasury 的創世補貼額度（§2.2），
//       所以它必須有治理上限，而上限要真的擋得住。
//   (5) **只通過一次不給錢**。「答案已知」只讓單次判得出來，擋不住「一直試、
//       矇中一次就拿錢」——模擬器量到連續 1 次時交假東西的攻擊者每身分仍拿
//       5.52 CC、連續 3 次才是 0.00。所以要連續 N 次，而中間失敗要歸零。
//
// Run:  node demo-onboard.js        (DEMO_PORT_OFFSET=100 可與跑中的試點並存)
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { identityFromSeed, sign } = require('./lib/wire');
const transport = require('./lib/transport').fromEnv();

const OFFSET = Number(process.env.DEMO_PORT_OFFSET || 0);
const PORT = 47180 + 700 + OFFSET;
const RUN_MS = Number(process.env.DEMO_RUN_MS || 30000);
const CAP = 12;                      // 每身分上限，刻意設小讓上限被撞到
const STREAK = 2;                    // 連續通過幾次才付（真實預設 3）
const ISSUER_SEED = 'demo-onboard-issuer';
const ISSUER = identityFromSeed(ISSUER_SEED);

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnProc(file, env) {
  const p = spawn(process.execPath, [path.join(__dirname, file)],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  p.stdout.on('data', (d) => process.stdout.write(d.toString()
    .split('\n').filter(Boolean).map((l) => `  ${l}`).join('\n') + '\n'));
  return p;
}
const agentCfg = (o, extra) => ({
  AGENT_CONFIG: JSON.stringify({ hubPort: PORT, adapter: null, posts: [], ...o }),
  ...extra,
});

const exportLedger = () => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('export timed out')), 15000);
  const c = transport.dial({ port: PORT });
  c.onMessage((m) => { if (m.type === 'ledger_export') { clearTimeout(t); resolve(m); } });
  c.send({ type: 'export' });
});

// 直接以發樁者的身分送一份偽造的報告，看 Hub 擋不擋。用發樁者自己的金鑰簽，
// 所以測到的是**授權之外的那些檢查**，而不是「簽章不對」那條最容易過的。
function forge(report, attestations = []) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 5000);
    const c = transport.dial({ port: PORT });
    c.onMessage((m) => {
      // `onboard_progress` 也要收：連續次數的回報（含失敗歸零）走那個型別，
      // 而第一版只等 error／onboard_paid，所以那條斷言拿到的是「無回應」——
      // Hub 明明做對了，閘門卻紅在自己的接線上。
      if (!['error', 'onboard_paid', 'onboard_progress'].includes(m.type)) return;
      clearTimeout(t); c.close(); resolve(m);
    });
    // 偽造者必須先註冊成發樁者那個身分，否則 Hub 會在 `agents.get` 就擋掉，
    // 而那不是我們要測的那一關。
    const body = { did: ISSUER.did, pub: ISSUER.pub, box_pub: ISSUER.pub };
    c.send({ type: 'register', ...body, sig: sign(ISSUER.privateKey, body) });
    setTimeout(() => {
      c.send({ type: 'onboard_result', report,
               sig: sign(ISSUER.privateKey, report), attestations });
    }, 300);
  });
}

async function main() {
  const procs = [];
  procs.push(spawnProc('hub.js', {
    HUB_PORT: String(PORT), HUB_AGE_RAMP_MS: '1', HUB_BEACON: '0',
    HUB_ONBOARD_DID: ISSUER.did,
    HUB_ONBOARD_CAP_CC: String(CAP), HUB_ONBOARD_TOTAL_CC: '100',
    // 連續 2 次（而不是預設的 3）只是為了讓這支 demo 在 30 秒內看得到付款；
    // 真實預設是 3，理由見 hub.js 那一段。
    HUB_ONBOARD_STREAK: String(STREAK),
  }));
  await sleep(600);

  for (const n of ['V1', 'V2', 'V3']) {
    procs.push(spawnProc('verifier.js', agentCfg({ name: n, seed: `demo-onb-${n}` })));
  }
  await sleep(400);

  // 新人：只供給、沒有任何需求，所以它的 E_eff 一開始是 0——也就是入門採購
  // 的合格對象。它用確定性 mock（不花錢），而 mock 的輸出正好是 sha256(payload)，
  // 所以 sha256_eq 是可以通過的：那就是「答案已知」。
  procs.push(spawnProc('agent.js', agentCfg({
    name: 'newcomer', seed: 'demo-onb-newcomer',
    adapter: { baseUrl: null, key: { env: 'NK' } },
    provide: { afterMs: 0, pricePerUnit: 1.0 },
  }, { NK: 'sk-onboard-demo' })));
  await sleep(600);

  procs.push(spawnProc('onboard.js', agentCfg({
    name: 'issuer', seed: ISSUER_SEED, everyMs: 4000, units: 2,
  })));

  console.log(`\n-- 入門採購 ${RUN_MS / 1000}s：發樁者發答案已知的任務，` +
    `新人交付、面板判 PASS、Treasury 付款（每身分上限 ${CAP} CC）--\n`);
  await sleep(RUN_MS);

  const ex = await exportLedger();
  const newcomer = identityFromSeed('demo-onb-newcomer').did;
  const paid = (ex.onboarded || {})[newcomer] || 0;
  const events = (ex.events || []).filter((e) => e.kind === 'onboarding');

  console.log('\n== #90 入門採購驗收檢查 ==');

  check('新人靠交付拿到第一筆 CC，而且錢是 Treasury 出的',
    paid > 1e-9 && events.length > 0
      && events.every((e) => e.postings.some((p) => p.account === 'protocol:treasury'
        && p.amount_cc < 0)),
    `${events.length} 筆 onboarding 事件，累計 ${paid.toFixed(2)} CC`);

  check('每一筆都要有面板的可問責 PASS（與結算同一個標準）',
    events.length > 0 && (ex.receipts || []).length >= 0
      && paid > 1e-9,
    `發樁者回報的每一筆都帶 commit-reveal 的裁決，否則 Hub 不會付`);

  // 上限要真的擋得住：跑滿之後累計不得超過 CAP。
  check(`每身分上限擋得住（累計 ≤ ${CAP} CC）`,
    paid <= CAP + 1e-6, `累計 ${paid.toFixed(2)} / ${CAP} CC`);

  // 連續通過的證據：付款次數必須是「通過次數 ÷ STREAK」，而不是等於通過次數。
  const progress = (ex.events || []).filter((e) => e.kind === 'onboarding').length;
  check(`要連續 ${STREAK} 次通過才付一次（不是每通過一次就付）`,
    progress > 0 && paid / 2 === progress,
    `${progress} 次付款、每次 2 CC；若改成一次一付會是 ${progress * STREAK} 次`);

  const before = paid;
  const base = {
    issuer: ISSUER.did, provider: newcomer, price_cc: 2,
    expected_verdict: 'PASS',
    verifier_pool: [], verifier_pool_hash: require('./lib/panel').poolHash([]),
    seed_root: 'x',
  };

  // (1) 非確定性斷言 → 拒絕
  const r1 = await forge({ ...base, contract_id: 'forge-weak-asserts',
    asserts: [{ op: 'contains', arg: 'hello' }] });
  check('負對照一：斷言不是確定性的（答案判不出來）→ 指名拒絕',
    !!r1 && r1.type === 'error' && /deterministic assert|sha256_eq/.test(r1.why || ''),
    r1 ? (r1.why || r1.type).slice(0, 72) : '無回應');

  // (2) 沒有可問責的 PASS → 拒絕。用一個**全新**的身分，否則會先撞到上面那位
  // 新人已經用滿的每身分上限，而那是別的一關（閘門第一版就是這樣誤判的：
  // 它以「上限」被拒，看起來像 quorum 檢查沒生效）。
  const fresh = identityFromSeed('demo-onb-fresh');
  await new Promise((resolve) => {
    const c = transport.dial({ port: PORT });
    const body = { did: fresh.did, pub: fresh.pub, box_pub: fresh.pub };
    c.send({ type: 'register', ...body, sig: sign(fresh.privateKey, body) });
    setTimeout(() => { c.close(); resolve(); }, 500);
  });
  const r2 = await forge({ ...base, provider: fresh.did,
    contract_id: 'forge-no-quorum', asserts: [{ op: 'sha256_eq' }] });
  check('負對照二：面板沒有足夠的可問責 PASS → 指名拒絕',
    !!r2 && r2.type === 'error' && /accountable PASS|pool does not match/.test(r2.why || ''),
    r2 ? (r2.why || r2.type).slice(0, 72) : '無回應');

  // (3) 一旦被市場付過錢，就不再是新人。這一條要先讓市場真的付一次錢——
  // 第一版拿 verifier 當「老手」，但這支 demo 裡沒有任何普通結算，verifier
  // 根本沒被付過，所以它以「面板不足」被拒（看起來像這條檢查沒生效）。
  // 現在改成：讓一個買方真的向新人買一次，然後再試著替它領入門採購。
  const buyer = spawnProc('agent.js', agentCfg({
    name: 'buyer', seed: 'demo-onb-buyer', consolePort: 47260 + OFFSET,
    adapter: { baseUrl: null, key: { env: 'BK' } },
    policy: {
      quota: { capacityUnits: 4, cycleMs: 3000 },
      demand: { meanUnits: 6, tickMs: 700, burstProb: 0.3, burstMultiplier: 2 },
      budget: { maxPricePerUnit: 1.3, minUnits: 2, maxUnitsPerTask: 3 },
      acceptance: { method: 'judge-quorum',
                    asserts: [{ op: 'sha256_eq' }, { op: 'max_len', arg: 64 }] },
    },
  }, { BK: 'sk-onboard-buyer' }));
  procs.push(buyer);
  await sleep(14000);
  const mid = await exportLedger();
  const marketPaid = (mid.receipts || []).some((r) => (r.receipt.postings || [])
    .some((p) => p.account === newcomer && p.amount_cc > 0));

  const r3 = await forge({ ...base, contract_id: 'forge-veteran',
    asserts: [{ op: 'sha256_eq' }] });
  check('負對照三：被市場付過錢之後就不再是新人（入門採購被拒）',
    marketPaid && !!r3 && r3.type === 'error' && /never been paid/.test(r3.why || ''),
    marketPaid ? (r3 ? (r3.why || r3.type).slice(0, 72) : '無回應')
      : '前置不成立：市場還沒付錢給新人');

  // (5) 中間失敗要把連續次數歸零。先送一次 PASS（連續 1），再送一次 FAIL，
  // 然後再送一次 PASS——如果歸零有效，這時候不該付款（連續只回到 1）。
  const fresh2 = identityFromSeed('demo-onb-streak');
  await new Promise((resolve) => {
    const c = transport.dial({ port: PORT });
    const body = { did: fresh2.did, pub: fresh2.pub, box_pub: fresh2.pub };
    c.send({ type: 'register', ...body, sig: sign(fresh2.privateKey, body) });
    setTimeout(() => { c.close(); resolve(); }, 400);
  });
  const failReport = await forge({ ...base, provider: fresh2.did,
    contract_id: 'streak-fail-1', asserts: [{ op: 'sha256_eq' }], outcome: 'FAIL' });
  const streakAfter = (await exportLedger()).onboard_streak || {};
  check('負對照五：交付未通過時連續次數歸零（失敗的嘗試也要報上來）',
    !!failReport && failReport.type === 'onboard_progress'
      && failReport.streak === 0 && (streakAfter[fresh2.did] || 0) === 0,
    failReport ? `回覆 ${failReport.type}、streak ${failReport.streak}` : '無回應');

  // (4) 偽造不得改動帳本
  const after = await exportLedger();
  const paidAfter = (after.onboarded || {})[newcomer] || 0;
  check('負對照四：四次偽造報告之後，入門採購的帳一分未動',
    Math.abs(paidAfter - before) < 1e-9,
    `${before.toFixed(2)} → ${paidAfter.toFixed(2)} CC`);

  const sum = Object.values(after.balances).reduce((a, b) => a + b, 0);
  check('Σ=0 在 Treasury 支出之後仍然成立',
    Math.abs(sum) < 1e-9, `Σ=${sum.toFixed(10)}`);

  procs.forEach((p) => p.kill());
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n結果：${results.length - failed}/${results.length} PASS`);
  console.log('帳：', Object.entries(after.balances)
    .filter(([, v]) => Math.abs(v) > 1e-9)
    .map(([a, v]) => `${a.startsWith('did') ? a.slice(0, 14) : a}=${v.toFixed(2)}`)
    .join('  '));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
