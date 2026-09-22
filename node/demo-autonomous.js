// W8: the §27 closed loop with nobody in the room.
//
// demo.js drives its agents from `posts: [{atMs, ...}]` timetables. That is a
// script, not a policy — it proves the mechanics work, not that they work
// unattended. §20-8 wants publish/bid/select/execute/settle to happen inside
// Owner Policy with no per-item operation, and §6.2 lists 逐筆找任務 and
// 手動追討互惠欠款 among the things normal trading must not require a human
// for. So here no agent has a `posts` array and nothing calls the Owner
// Console: every task exists because an agent noticed its own quota ran out
// (UC-01 step 1), and every repayment happens because the strategy engine
// found itself under its target band (UC-02).
//
// Run:  node demo-autonomous.js        (DEMO_PORT_OFFSET=100 to coexist)
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { verify, sha256, canon } = require('./lib/wire');
const transport = require('./lib/transport').fromEnv();

const OFFSET = Number(process.env.DEMO_PORT_OFFSET || 0);
const PORT = 47180 + OFFSET;
const CONSOLE_BASE = 47211 + OFFSET;
// Whether anyone crosses the band inside a fixed window is a property of
// burst timing, so asserting a completed repayment cycle after a flat sleep
// was asserting a probabilistic event as if it were deterministic — it
// passed 4 runs in a row, then 1 in 3. Three fixes were tried and rejected:
// loosening the assertion (hides the thing being demonstrated), making one
// agent demand-heavy so it reliably dips (it became a chronic debtor that
// dipped every run and returned in none, the mirror of the sink this
// population already guards against), and simply lengthening the window
// (raises the odds, does not remove the coin flip).
//
// So the harness watches for the phenomenon instead of betting on a window:
// it runs at least MIN_MS so the circulation checks have data, then polls
// until a repayment episode has actually closed, up to MAX_MS. In the common
// case this is faster than the old fixed sleep.
const MIN_MS = Number(process.env.DEMO_MIN_MS || 14000);
// The ceiling is generous on purpose. This assertion is about whether the
// economy closes a repayment loop unattended, not about how fast — and it
// flaked once at 75s under the http transport while the machine was also
// running the scenario suite. A gate that fails under load teaches people to
// ignore it, which costs more than the extra wall-clock of a run that
// usually exits at ~20s anyway (it polls and stops as soon as it sees one).
const MAX_MS = Number(process.env.DEMO_MAX_MS ||
  (process.env.AMCN_TRANSPORT && process.env.AMCN_TRANSPORT !== 'tcp' ? 150000 : 100000));
const POLL_MS = 1000;

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

const SHA_OK = [{ op: 'sha256_eq' }, { op: 'max_len', arg: 512 }];

// Three agents, described only by policy. No posts, no timetable.
//
// All three both buy and sell, and all three have a quota cycle that fires
// inside the run. Both properties are load-bearing and an earlier version of
// this file got them wrong, which produced a green run over a broken economy:
//
//   Quota must reset. UC-02 step 1 is "Requester 的月／週額度恢復" — selling
//   spends quota, so an agent whose quota never resets can never earn its way
//   back and just sinks to its credit ceiling.
//   Demand must be mutual. A near-zero-demand provider is a sink: credit
//   flows in and never circulates back, which is FR-056's 正餘額無處可花.
//   Everyone else then runs out of credit line and the loop cannot close.
//
// The seeds differ, so bursts land at different times: whoever bursts borrows,
// whoever has spare quota sells, and the credit circulates.
// Capacity has to exceed own demand, or there is no surplus to sell and the
// market cannot clear: ~19u of demand per 3.5s cycle against 60u of quota
// leaves ~40u sellable, while bursts still overrun the remainder and trigger
// UC-01. An earlier 25u capacity left almost no surplus and the run produced
// a single settlement.
// Capacity sits close to expected demand on purpose. Too tight and everyone
// runs a chronic deficit until their credit line is gone; too loose and UC-01
// never fires because nobody ever exhausts. ~34u of expected demand per 3.5s
// cycle against 40u of quota leaves the outcome to variance, and staggered
// reset phases mean a buyer's shortfall usually overlaps someone's surplus.
const BASE_POLICY = {
  quota: { capacityUnits: 40, cycleMs: 3500 },
  demand: { meanUnits: 5, tickMs: 900, burstProb: 0.25, burstMultiplier: 4 },
  budget: { maxPricePerUnit: 1.3, minUnits: 3, maxUnitsPerTask: 8 },
  acceptance: { method: 'judge-quorum', asserts: SHA_OK },
};

const withPhase = (ms) => ({
  ...BASE_POLICY,
  quota: { ...BASE_POLICY.quota, cycleOffsetMs: ms },
});

const POP = [
  // Prices differ. With an identical grid, bids tie and the requester's
  // price sort falls back to arrival order, so the last agent to start never
  // won anything — a property of spawn order, not of the market.
  { name: 'A', seed: 11, consolePort: CONSOLE_BASE,
    adapter: { baseUrl: null, key: { env: 'A_KEY' } },
    provide: { afterMs: 0, pricePerUnit: 1.0 }, policy: withPhase(0) },
  { name: 'B', seed: 22, consolePort: CONSOLE_BASE + 1,
    adapter: { baseUrl: null, key: { env: 'B_KEY' } },
    provide: { afterMs: 0, pricePerUnit: 1.05 }, policy: withPhase(1200) },
  { name: 'C', seed: 33, consolePort: CONSOLE_BASE + 2,
    adapter: { baseUrl: null, key: { env: 'C_KEY' } },
    provide: { afterMs: 0, pricePerUnit: 0.95 }, policy: withPhase(2400) },
];

const agentCfg = (o) => ({
  AGENT_CONFIG: JSON.stringify({ hubPort: PORT, adapter: null, posts: [], ...o }),
  // Mock-mode keys: the adapter is still key-gated, so a provider with no key
  // resolves nothing and never arms supply.
  A_KEY: 'sk-auto-A-SECRET-3f1a', B_KEY: 'sk-auto-B-SECRET-9c2e',
  C_KEY: 'sk-auto-C-SECRET-5d70',
});

async function main() {
  const procs = [];
  procs.push(spawnProc('hub.js', {
    // HUB_EXPORT_RAWLOG：這支要斷言「Agent 的內部推理沒有洩漏到流量上」，
    // 而流量記錄預設不隨匯出出去（#88）。閘門自己打開它。
    HUB_PORT: String(PORT), HUB_AGE_RAMP_MS: '1', HUB_BEACON: '0',
    HUB_EXPORT_RAWLOG: '1',
  }));
  await new Promise((r) => setTimeout(r, 400));
  for (const v of ['V1', 'V2', 'V3']) {
    procs.push(spawnProc('verifier.js', agentCfg({ name: v })));
  }
  await new Promise((r) => setTimeout(r, 300));
  for (const a of POP) procs.push(spawnProc('agent.js', agentCfg(a)));

  console.log(`\n-- 無人運行（最少 ${MIN_MS / 1000}s，最多 ${MAX_MS / 1000}s）：` +
    `沒有 posts 時間表，沒有 Console 呼叫 --\n`);
  const readConsoles = async () => {
    const out = {};
    for (const a of POP) {
      try {
        out[a.name] =
          await (await fetch(`http://127.0.0.1:${a.consolePort}/status`)).json();
      } catch { out[a.name] = null; }
    }
    return out;
  };
  const closedEpisode = (cs) => POP.some((a) => {
    const c = cs[a.name];
    return c && c.strategy.repay_episodes >= 1 && c.strategy.avg_repayment_ms > 0;
  });

  await new Promise((r) => setTimeout(r, MIN_MS));
  const deadline = Date.now() + (MAX_MS - MIN_MS);
  let observed = closedEpisode(await readConsoles());
  while (!observed && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    observed = closedEpisode(await readConsoles());
  }
  const elapsed = ((Date.now() - (deadline - (MAX_MS - MIN_MS)) + MIN_MS) / 1000).toFixed(1);
  console.log(`\n-- 觀察${observed ? '到' : '未觀察到'}完整還債週期，` +
    `執行 ${elapsed}s 後匯出 --\n`);

  const ex = await new Promise((resolve) => {
    const c = transport.dial({ port: PORT });
    c.onMessage((m) => { if (m.type === 'ledger_export') resolve(m); });
    c.send({ type: 'export' });
  });
  const consoles = {};
  for (const a of POP) {
    // A crashed agent must show up as a failed check, not as an unhandled
    // rejection that takes the harness down with it.
    try {
      consoles[a.name] =
        await (await fetch(`http://127.0.0.1:${a.consolePort}/status`)).json();
    } catch (err) {
      console.log(`  !! ${a.name} console unreachable: ${err.message}`);
      consoles[a.name] = null;
    }
  }
  const dead = POP.filter((a) => !consoles[a.name]).map((a) => a.name);
  procs.forEach((p) => p.kill());

  const { receipts, pubkeys, balances, credit_lines, chains, checkpoints,
          raw_log } = ex;
  const byName = (n) => consoles[n];

  console.log('\n== W8 驗收檢查 ==');

  check('三個 Agent 全程存活（無人運行不得靠人重啟）',
    dead.length === 0, dead.length ? `死亡: ${dead.join(', ')}` : 'A, B, C 皆在線');
  if (dead.length) {
    console.log(`\n結果：${results.filter(([, ok]) => ok).length}/${results.length} PASS` +
      ' — Agent 死亡，其餘檢查無法評估');
    process.exit(1);
  }

  // §20-8 / §6.2: the whole point. Nothing attended may have published.
  const attended = POP.reduce((s, a) =>
    s + byName(a.name).publishing.manual_posts
      + byName(a.name).publishing.scripted_posts, 0);
  const autoTotal = POP.reduce((s, a) =>
    s + byName(a.name).publishing.auto_posts, 0);
  check('§20-8／§6.2 全程零人工：無 Console 呼叫、無 posts 時間表，所有任務由政策自發',
    attended === 0 && autoTotal >= 2 && receipts.length >= 2,
    `attended=${attended}, 政策自發 ${autoTotal} 筆, 結算 ${receipts.length} 筆`);

  // UC-01 step 1: the trigger was the agent's own quota running out.
  const exhausted = POP.filter((a) => byName(a.name).quota.exhaustions > 0);
  check('UC-01 步驟 1：觸發源是 Agent 自行偵測額度耗盡（非時間表、非人為）',
    exhausted.length >= 2,
    exhausted.map((a) => `${a.name}: ${byName(a.name).quota.exhaustions} 次耗盡, ` +
      `缺口 ${byName(a.name).quota.shortfall_units}u`).join('; '));

  // §20-2: a borrower went negative, and stayed inside its credit line.
  const borrowers = Object.entries(balances)
    .filter(([acct, v]) => acct.startsWith('did') && v < 0);
  const withinLine = borrowers.every(([acct, v]) =>
    credit_lines[acct] === undefined || v >= -credit_lines[acct] - 1e-9);
  check('§20-2 負餘額形成且不超過動態信用額度',
    borrowers.length >= 1 && withinLine,
    borrowers.map(([a, v]) =>
      `${a.slice(0, 18)}=${v.toFixed(2)}/${(credit_lines[a] || 0).toFixed(1)}`).join(' '));

  // §20-3 / UC-02: somebody borrowed, then earned by serving a third party.
  const served = {};
  for (const r of receipts) {
    served[r.receipt.provider] = (served[r.receipt.provider] || 0) + 1;
  }
  // "Borrowed and also earned" is not a closed loop — an agent can do both
  // and still sink to its credit ceiling, which an earlier version of this
  // check reported as a pass. §27's last step is 「A 的負餘額被清償」, so the
  // balance has to actually come back inside the band.
  // A closed episode is itself the proof: strategy.js only closes one when
  // modeFor() reports the balance back at or above the band's low bound, so
  // the return is recorded at the moment it happened. Requiring the agent to
  // *also* be above the band at sampling time was over-specified — in a
  // continuously running economy, dipping under again is normal behaviour,
  // not a failure of the loop. (The weaker trap to avoid is the original
  // version of this check, which accepted "borrowed and also earned" and
  // passed over an economy where nobody ever returned at all.)
  const closers = POP.map((a) => byName(a.name)).filter((c) =>
    c.strategy.repay_episodes >= 1);
  // A 0ms episode is a transient dip in and out within the same millisecond;
  // it satisfies "returned to the band" without demonstrating that repayment
  // work actually happened, so at least one closer must have taken real time.
  const measured = closers.filter((c) => c.strategy.avg_repayment_ms > 0);
  check('§20-3／UC-02／§27 閉環真正閉合：跌破區間 → 替他人工作 → 餘額回到區間內（無人催收）',
    closers.length >= 1 && measured.length >= 1,
    closers.length
      ? closers.map((c) => `${c.name}: 完成 ${c.strategy.repay_episodes} 次還債` +
          `（回到 ≥ ${c.strategy.target_band_cc[0].toFixed(2)} CC，平均 ` +
          `${c.strategy.avg_repayment_ms}ms）` +
          (c.strategy.avg_repayment_ms > 0 ? '' : '（暫態，不計入）') +
          `；取樣時 ${c.balance_cc.toFixed(2)} CC/${c.strategy.mode}`).join('; ')
      : POP.map((a) => byName(a.name)).map((c) =>
          `${c.name}=${c.balance_cc.toFixed(2)}/${c.strategy.mode}`).join(' ') +
        ' — 無人回到區間，信用只流向一端');

  // FR-056's failure mode is 正餘額無處可花: an agent that only ever receives
  // and accumulates credit it cannot spend, which is what a near-zero-demand
  // provider became in an earlier version of this population (+77 CC while
  // everyone else hit their ceiling). An agent that only ever pays is just a
  // buyer, and losing every auction because you are the most expensive
  // provider is price competition working (UC-01 step 5), not a sink — so the
  // check is one-directional on purpose.
  const sinks = POP.map((a) => byName(a.name)).filter((c) => {
    const paid = c.settled.filter((s) => s.delta_cc < 0).length;
    const earned = c.settled.filter((s) => s.delta_cc > 0).length;
    return earned > 0 && paid === 0 && c.balance_cc > 0;
  });
  check('FR-056 無單向吸收端：沒有 Agent 只收不付並囤積無處可花的正餘額',
    sinks.length === 0,
    POP.map((a) => byName(a.name)).map((c) =>
      `${c.name}: 付 ${c.settled.filter((s) => s.delta_cc < 0).length}/` +
      `收 ${c.settled.filter((s) => s.delta_cc > 0).length} ` +
      `(${c.balance_cc.toFixed(2)} CC)`).join('  '));

  // Nobody should have been left stuck against its ceiling with demand it
  // could not meet — that is the failure mode the previous population hid.
  const stuck = POP.map((a) => byName(a.name)).filter((c) =>
    c.publishing.withheld.some((w) => w.includes('credit line exhausted')));
  check('無 Agent 卡死在信用上限（額度重置＋雙向需求的前提條件成立）',
    stuck.length === 0,
    stuck.length ? stuck.map((c) => `${c.name} 卡死`).join(', ') : '無');

  // FR-055 in the unattended path: the repayer discounted while under band.
  const repayHit = POP.map((a) => byName(a.name))
    .filter((c) => c.strategy.repay_episodes > 0 || c.strategy.in_repayment_since);
  check('FR-055 還債模式在無人路徑下自動觸發',
    repayHit.length >= 1,
    repayHit.map((c) => `${c.name}: episodes=${c.strategy.repay_episodes}, ` +
      `band=[${c.strategy.target_band_cc[0].toFixed(2)}, ` +
      `${c.strategy.target_band_cc[1]}]`).join('; ') || '無');

  // §20-4: conservation and reconstruction, same as the scripted demo.
  const sum = Object.values(balances).reduce((s, v) => s + v, 0);
  // Same derivation as demo.js: receipts plus the published rules. Stake
  // escrow (§4 #28) is a deterministic function of each receipt's verifier
  // postings, so a replay has to apply it too — I fixed demo.js first and
  // left this file replaying receipts alone, which reported a broken ledger
  // when the ledger was fine.
  const STAKE_TARGET_CC = 5, STAKE_ESCROW_FRAC = 0.5;
  const rebuilt = {};
  const heldStake = {};
  const addR = (acct, amt) => {
    rebuilt[acct] = +((rebuilt[acct] || 0) + amt).toFixed(6);
  };
  for (const r of receipts) {
    for (const p of r.receipt.postings) addR(p.account, p.amount_cc);
    for (const p of r.receipt.postings) {
      if (!(r.receipt.verifier_pool || []).includes(p.account) || p.amount_cc <= 0) continue;
      const room = +(STAKE_TARGET_CC - (heldStake[p.account] || 0)).toFixed(4);
      if (room <= 0) continue;
      const take = +Math.min(room, p.amount_cc * STAKE_ESCROW_FRAC).toFixed(4);
      if (take <= 0) continue;
      heldStake[p.account] = +((heldStake[p.account] || 0) + take).toFixed(4);
      addR(p.account, -take);
      addR('protocol:stake', take);
    }
  }
  check('§20-4 Σ=0 且收據重建 = Hub 帳',
    Math.abs(sum) < 1e-9 &&
    Object.entries(rebuilt).every(([a, v]) =>
      Math.abs((balances[a] || 0) - v) < 1e-6),
    `Σ=${sum.toFixed(9)}, ${receipts.length} 筆收據`);

  let sigBad = 0;
  for (const r of receipts) {
    for (const [role, sig] of Object.entries(r.sigs)) {
      if (!verify(pubkeys[r.receipt[role]], r.receipt, sig)) sigBad++;
    }
  }
  check('FR-050 雙簽收據簽章全部驗證通過',
    sigBad === 0, `${receipts.length * 2} 個簽章`);

  let chainErr = null;
  for (const [acct, ch] of Object.entries(chains)) {
    let bal = 0, prev = sha256(acct);
    for (const e of ch) {
      const { hash, ...body } = e;
      if (sha256(canon(body)) !== hash) { chainErr = `hash ${acct}#${e.seq}`; break; }
      if (e.prev_hash !== prev) { chainErr = `link ${acct}#${e.seq}`; break; }
      bal = +(bal + e.delta_cc).toFixed(6);
      if (Math.abs(bal - e.balance_after) > 1e-6) {
        chainErr = `balance ${acct}#${e.seq}`; break;
      }
      prev = hash;
    }
    if (chainErr) break;
  }
  check('NFR-006 hash chain＋checkpoint 離線重驗',
    chainErr === null,
    chainErr || `${Object.keys(chains).length} 條鏈, ${checkpoints.length} checkpoint`);

  // §20-1/6 + NFR-005: auto-generated payloads must not reach the hub either.
  const leaked = receipts.length && raw_log.includes('own quota exhausted');
  check('§20-1/6＋NFR-005 自動產生的 payload 明文同樣不經 Hub',
    !leaked, `hub traffic ${raw_log.length}B ${leaked ? '洩漏!' : 'clean'}`);

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n結果：${results.length - failed}/${results.length} PASS`);
  for (const a of POP) {
    const c = byName(a.name);
    console.log(`  ${a.name}: ${c.balance_cc.toFixed(2)} CC  CL ${c.credit_line_cc.toFixed(1)}  ` +
      `mode ${c.strategy.mode}  自發 ${c.publishing.auto_posts} 筆  ` +
      `額度用 ${c.quota.consumed_units}u/缺 ${c.quota.shortfall_units}u`);
  }
  console.log('  帳:', Object.entries(balances)
    .filter(([, v]) => Math.abs(v) > 1e-9)
    .map(([a, v]) => `${a.startsWith('did') ? a.slice(0, 14) : a}=${v.toFixed(2)}`)
    .join('  '));
  process.exit(failed ? 1 : 0);
}

main();
