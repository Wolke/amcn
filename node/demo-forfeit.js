// #38 的修法閘門：**還沒被測夠就丟掉身分的 verifier，押注拿不回來——而被測夠
// 的拿得回來。** 兩句缺一句都不成立。
//
// 為什麼需要這條規則：偷懶的 verifier（不看斷言就投 PASS）唯一的成本是金絲雀
// 稽核累積到證據門檻後被沒收押注（demo-canary.js）。但押注是從它自己的驗證
// 收入託管來的，而 DID 是免費的——所以「在被測夠之前換一個身分」可以把押注
// 留在舊 DID 上，誰也沒拿走。模擬器量到 2 天換一次身分就從 −0.30 轉為 +0.30
// CC 的優勢（登記簿 #38，c99869b）。
//
// 修法（與模擬器的 `stake_forfeit_on_churn` 同一條）：離線超過門檻、而金絲雀
// 樣本數還沒到 `HUB_SLASH_MIN_SAMPLES`，託管的押注轉入保險池。
//
// **而沒收要有意義，就必須存在「拿得回來」的情形。** 原型的押注從前只進不出
// （託管 → 罰沒），所以第一版的「沒收」其實是純記帳：那筆 CC 早就不在 verifier
// 的餘額裡，沒收與不沒收對離開的人一模一樣。v7 的 `stake_release` 補上另一側
// ——被測夠且失敗率過關者可取回，取回即退出 pool（抽走押注還繼續驗證的人身上
// 沒有東西可罰，那是 pay-to-play 的反面）。
//
// 這支 demo 的表格就是那個 2×2，因為「一律沒收」與「一律退還」都是錯的答案：
//
//              被測夠（seen ≥ 5）        沒被測夠（seen < 5）
//   離線        押注留在託管，未沒收       **全額沒收轉入保險池**
//   在線        **可取回、退出 pool**     取回被拒（沒被測過的不退）
//
// Run:  node demo-forfeit.js      (DEMO_PORT_OFFSET=100 可與跑中的試點並存)
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { identityFromSeed } = require('./lib/wire');
const transport = require('./lib/transport').fromEnv();
const { rebuild } = require('./lib/rebuild');

const OFFSET = Number(process.env.DEMO_PORT_OFFSET || 0);
const PORT = 47180 + OFFSET;
const AUDIT_MS = Number(process.env.DEMO_AUDIT_MS || 22000);  // 金絲雀稽核期
const LATE_MS = Number(process.env.DEMO_LATE_MS || 20000);    // 晚到者賺押注
const FORFEIT_AFTER_MS = 4000;
const RELEASE_AT_MS = AUDIT_MS + LATE_MS + 3000;  // 在 before 快照之後才發生
const WAIT_MS = FORFEIT_AFTER_MS + 6000;
const MIN_SAMPLES = 5;
const CANARY_SEED = 'demo-forfeit-issuer';
const CANARY = identityFromSeed(CANARY_SEED);

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 子行程的輸出留一份，因為有一條斷言是「Hub 拒絕了退還請求」——那件事只在
// 被拒者的 log 裡看得到（帳上看不到「沒有發生的事」）。
const logs = new Map();
function spawnProc(file, env, label) {
  const p = spawn(process.execPath, [path.join(__dirname, file)],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  p.stdout.on('data', (d) => {
    const text = d.toString();
    if (label) logs.set(label, (logs.get(label) || '') + text);
    process.stdout.write(text.split('\n').filter(Boolean)
      .map((l) => `  ${l}`).join('\n') + '\n');
  });
  return p;
}

const SHA_OK = [{ op: 'sha256_eq' }, { op: 'max_len', arg: 512 }];
const agentCfg = (o, extra) => ({
  AGENT_CONFIG: JSON.stringify({ hubPort: PORT, adapter: null, posts: [], ...o }),
  ...extra,
});

function ask(type, extra, want) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${type} timed out`)), 15000);
    const c = transport.dial({ port: PORT });
    c.onMessage((m) => {
      if (m.type !== want) return;
      clearTimeout(t); resolve(m);
    });
    c.send({ type, ...extra });
  });
}
const exportLedger = () => ask('export', {}, 'ledger_export');

// 押注是按 DID 記的，而每個 verifier 的 DID 由種子決定，所以 demo 能在匯出裡
// 指名道姓地找到它——否則只能看到一堆 did:key，分不出誰是晚到者。
const seedOf = (name) => `demo-forfeit-${name}`;
const didOf = (name) => identityFromSeed(seedOf(name)).did;

async function main() {
  const procs = [];
  procs.push(spawnProc('hub.js', {
    HUB_PORT: String(PORT), HUB_AGE_RAMP_MS: '1', HUB_BEACON: '0',
    HUB_CANARY_DID: CANARY.did,
    HUB_SLASH_MIN_SAMPLES: String(MIN_SAMPLES), HUB_SLASH_MIN_FAILURES: '3',
    // 門檻壓到 4 秒、掃描 1 秒；生產預設是 14 天，不壓縮的話這條路徑
    // 沒有任何測試跑得到（同 HUB_DEFAULT_AFTER_MS 的處理）。
    HUB_STAKE_FORFEIT_AFTER_MS: String(FORFEIT_AFTER_MS),
    HUB_DEFAULT_SWEEP_MS: '1000',
  }, 'hub'));
  await sleep(500);

  // V1 收工（被測夠 → 取回押注），V2 離線（被測夠 → 押注不動），V3 留著顧 quorum。
  const early = ['V1', 'V2', 'V3'];
  for (const n of early) {
    procs.push(spawnProc('verifier.js', agentCfg({
      name: n, seed: seedOf(n),
      ...(n === 'V1' ? { releaseStakeAfterMs: RELEASE_AT_MS } : {}),
    }), n));
  }
  await sleep(400);

  // 真實流量：押注只從驗證費託管而來（§4 #28），沒有真的工作就沒有押注可沒收。
  //
  // 三個**雙向**交易者，不是一買一賣。第一版用 P（只賣）＋ R（只買），結果
  // R 在 22 秒內就把額度用光（`credit line exhausted`，全程只有 6 筆收據），
  // 於是晚到的 verifier 一次 panel 都沒進到、押注是 0——閘門的前置條件根本沒
  // 成立。CC 要循環才有持續的驗證費，這也是 chaos-run 的流量長那樣的原因。
  for (let i = 0; i < 3; i++) {
    const name = String.fromCharCode(65 + i);
    procs.push(spawnProc('agent.js', agentCfg({
      name, seed: `forfeit-${name}`,
      adapter: { baseUrl: null, key: { env: `K${name}` } },
      provide: { afterMs: 0, pricePerUnit: 1 + i * 0.05, repayment: true },
      policy: {
        quota: { capacityUnits: [40, 56, 28][i], cycleMs: 3500, cycleOffsetMs: i * 1200 },
        demand: { meanUnits: [5, 7, 3.5][i], tickMs: 900, burstProb: 0.25, burstMultiplier: 4 },
        budget: { maxPricePerUnit: 1.3, minUnits: 3, maxUnitsPerTask: 8 },
        acceptance: { method: 'judge-quorum', asserts: SHA_OK },
      },
    }, { [`K${name}`]: `sk-forfeit-${name}` }), name));
  }
  await sleep(600);

  const canaryProc = spawnProc('canary.js', agentCfg({
    name: 'canary', seed: CANARY_SEED, everyMs: 1800, units: 2,
  }), 'canary');
  procs.push(canaryProc);

  console.log(`\n-- 第一階段 ${AUDIT_MS / 1000}s：V1–V3 累積金絲雀樣本與押注 --\n`);
  await sleep(AUDIT_MS);

  // 稽核停掉，之後加入的人永遠不會被測到——這正是 #38 的攻擊者想要的處境。
  // 三位晚到者全部都會請求取回押注，而三位都應該被拒（沒被測過的不退）。
  canaryProc.kill();
  const late = ['V4', 'V5', 'V6'];
  for (const n of late) {
    procs.push(spawnProc('verifier.js', agentCfg({
      // 早一點問，因為受害者會在第三階段開頭被殺——第一版問在 LATE_MS+3s，
      // 而那已經是它被殺之後，於是「三位都被拒」只收到 2/3（拒絕沒發生，
      // 不是規則沒生效）。Hub 的拒絕理由不依賴託管時序，所以早問一樣被拒。
      name: n, seed: seedOf(n), releaseStakeAfterMs: 6000,
    }), n));
  }
  console.log(`\n-- 第二階段 ${LATE_MS / 1000}s：${late.join('／')} 晚到，沒有金絲雀，只賺押注 --\n`);
  await sleep(LATE_MS);

  const before = await exportLedger();
  const stakeBefore = before.stakes || {};
  const statsBefore = before.canary_stats || {};
  const balBefore = before.balances || {};
  const insBefore = balBefore['protocol:insurance'] || 0;

  // 誰當受害者是從帳上挑的，不是寫死的。panel 是每筆合約從池子裡推導的，所以
  // 晚到的哪一位先賺到押注是運氣——第一版寫死 V4，而那一次 panel 剛好每次都
  // 選到 V5，於是 V4 押注是 0、閘門的前置條件空掉（6/9 PASS 但關鍵三條全空）。
  const order = [...early, ...late];
  const eligible = late.filter((n) => (stakeBefore[didOf(n)] || 0) > 1e-9
    && (((statsBefore[didOf(n)] || {}).seen) || 0) < MIN_SAMPLES);
  const victim = eligible[0];
  console.log(`\n-- 第三階段：V2（被測夠）與 ${victim || '(無合格晚到者)'}` +
    `（未被測夠）同時離線；V1 收工取回押注 --\n`);
  const verifierProcs = procs.filter((p) =>
    p.spawnargs.some((a) => a.endsWith('verifier.js')));
  for (let i = 0; i < verifierProcs.length; i++) {
    if (order[i] === 'V2' || order[i] === victim) verifierProcs[i].kill();
  }
  await sleep(WAIT_MS);

  const pool = await ask('list_verifiers', {}, 'verifiers');

  // 第四階段：V1 取回押注之後**重新註冊**。這是 stake_release 自己帶出來的
  // 攻擊面，而且比 #38 原本那條更省事——不必換身分，只要斷線重連，就能帶著
  // 乾淨的受測紀錄（樣本 12、零失敗）回到 pool，而身上押注是 0，被罰也罰不
  // 到東西。所以退出的紀錄不能掛在 agent 記錄上（`register` 會整筆換掉），
  // 而且必須能由事件流重建。
  console.log('\n-- 第四階段：V1 重新註冊（同一個 DID、同一份乾淨紀錄、零押注）--\n');
  verifierProcs[0].kill();
  await sleep(500);
  procs.push(spawnProc('verifier.js', agentCfg({ name: 'V1b', seed: seedOf('V1') }), 'V1b'));
  await sleep(4000);
  const poolAfter = await ask('list_verifiers', {}, 'verifiers');

  const ex = await exportLedger();
  procs.forEach((p) => p.kill());

  const { balances = {}, stakes = {}, canary_stats = {} } = ex;
  const nm = Object.fromEntries(order.map((n) => [didOf(n), n]));
  const stakeOf = (n) => stakes[didOf(n)] || 0;
  const forfOf = (n) => (canary_stats[didOf(n)] || {}).forfeited_cc || 0;
  const preStake = (n) => stakeBefore[didOf(n)] || 0;
  const preSeen = (n) => (statsBefore[didOf(n)] || {}).seen || 0;
  const evOf = (kind, n) => (ex.events || []).filter((e) => e.kind === kind
    && (e.postings || []).some((p) => p.account === didOf(n)));

  console.log('\n== #38 押注沒收／退還驗收檢查 ==');

  // 前置條件先驗：沒有押注可沒收、或晚到者其實被測過，下面幾條就都是空話。
  check('前置：至少一位晚到者在離線前有押注託管、且金絲雀樣本未達標',
    !!victim,
    `合格晚到者 ${eligible.length} 位：` + (late.map((n) =>
      `${n} 押注 ${(stakeBefore[didOf(n)] || 0).toFixed(4)}／樣本 ` +
      `${((statsBefore[didOf(n)] || {}).seen) || 0}`).join('、')));
  check('前置：V1／V2 在第一階段已被測夠（兩組負對照的前提）',
    preSeen('V1') >= MIN_SAMPLES && preSeen('V2') >= MIN_SAMPLES,
    `V1 樣本 ${preSeen('V1')}、V2 樣本 ${preSeen('V2')}（門檻 ${MIN_SAMPLES}）`);

  check('#38 修法生效：未被測夠就離線 → 押注歸零並轉入保險池',
    !!victim && forfOf(victim) > 1e-9 && stakeOf(victim) < 1e-9
      && Math.abs(forfOf(victim) - preStake(victim)) < 1e-6,
    victim ? `${victim} 沒收 ${forfOf(victim).toFixed(4)} CC（離線前 ` +
      `${preStake(victim).toFixed(4)}）、餘押注 ${stakeOf(victim).toFixed(4)} CC`
      : '沒有合格的晚到者可測');

  // 沒收有意義的前提：存在拿得回來的情形。
  //
  // 取回之後押注**可以再長回來**，而那是對的：退出只對**新的** pool 生效，
  // 已經在飛的合約還是會結算、驗證費照樣託管——也就是回到新人的處境，不是
  // 免疫。所以這裡比的是「退了多少」與「餘額進了多少」，不是「押注是否為 0」
  // （第一版寫成後者，於是 V1 在取回 0.2822 之後又託管到 0.0534 就 FAIL 了）。
  const evs = ex.events || [];
  const relIdx = evs.findIndex((e) => e.kind === 'stake_release'
    && (e.postings || []).some((p) => p.account === didOf('V1')));
  const rel = relIdx >= 0 ? [evs[relIdx]] : [];
  const relAmt = rel.length
    ? (rel[0].postings.find((p) => p.account === didOf('V1')) || {}).amount_cc || 0 : 0;
  const gotBack = (balances[didOf('V1')] || 0) - (balBefore[didOf('V1')] || 0);
  // 取回之後押注**又長回 0.05 左右**，而那是對的：退出只對**新的** pool 生效，
  // 已經在飛的合約仍會結算、驗證費照樣託管——回到新人的處境，不是免疫。所以
  // 這裡不比「押注是否為 0」（第一版比了，於是正確的行為被判成 FAIL），而是比
  // 「現在的押注 ＝ 取回之後才發生的託管」，也就是舊的那一筆確實全退了。
  const escrowAfter = evs.slice(relIdx + 1)
    .filter((e) => e.kind === 'stake_escrow')
    .reduce((t, e) => t - ((e.postings || [])
      .filter((p) => p.account === didOf('V1'))
      .reduce((u, p) => u + p.amount_cc, 0)), 0);
  check('另一側成立：被測夠者收工可取回押注，CC 回到自己的餘額',
    rel.length === 1 && relAmt > 1e-9 && gotBack >= relAmt - 1e-6
      && Math.abs(stakeOf('V1') - escrowAfter) < 1e-6,
    `V1 取回 ${relAmt.toFixed(4)} CC（餘額 +${gotBack.toFixed(4)}）、押注 ` +
    `${preStake('V1').toFixed(4)} → ${stakeOf('V1').toFixed(4)}，而現有的 ` +
    `${escrowAfter.toFixed(4)} 全是取回之後才託管的（退出不是免疫）`);

  check('取回即退出 pool（抽走押注還繼續驗證的人身上沒有東西可罰）',
    !(pool.verifiers || []).some((v) => v.did === didOf('V1'))
      && (pool.verifiers || []).length >= 1,
    `pool 現有 ${(pool.verifiers || []).map((v) => nm[v.did] || v.did.slice(0, 10))
      .join('、') || '(空)'}`);

  check('重新註冊也回不去：取回押注 ＝ 結束這個 DID 的驗證生涯',
    !(poolAfter.verifiers || []).some((v) => v.did === didOf('V1'))
      && (poolAfter.verifiers || []).length >= 1,
    `重連後 pool 現有 ${(poolAfter.verifiers || [])
      .map((v) => nm[v.did] || v.did.slice(0, 10)).join('、') || '(空)'}`);

  check('負對照一：被測夠的 V2 離線但沒收工，押注留在託管、未被沒收',
    forfOf('V2') < 1e-9 && Math.abs(stakeOf('V2') - preStake('V2')) < 1e-6,
    `V2 押注 ${preStake('V2').toFixed(4)} → ${stakeOf('V2').toFixed(4)} CC`);

  const refused = late.filter((n) => /released only after/.test(logs.get(n) || ''));
  const lateReleases = late.flatMap((n) => evOf('stake_release', n));
  check('負對照二：沒被測夠者請求取回押注一律被拒（否則沒收有繞道）',
    refused.length === late.length && lateReleases.length === 0,
    `${refused.length}/${late.length} 位被拒、${lateReleases.length} 筆晚到者的 stake_release`);

  const stillOn = late.filter((n) => n !== victim);
  check('負對照三：未被測夠但仍在線上者，押注只增不減（沒被測到不是罪）',
    stillOn.every((n) => forfOf(n) < 1e-9 && stakeOf(n) >= preStake(n) - 1e-6),
    stillOn.map((n) => `${n} ${preStake(n).toFixed(4)} → ${stakeOf(n).toFixed(4)}`).join('、'));

  // 沒收去哪裡要能對帳：事件裡的 stake_forfeit 總額 = 保險池的增額。
  const forfEvents = (ex.events || []).filter((e) => e.kind === 'stake_forfeit');
  const evTotal = forfEvents.reduce((t, e) => t +
    (e.postings.find((p) => p.account === 'protocol:insurance') || { amount_cc: 0 })
      .amount_cc, 0);
  const statTotal = Object.values(canary_stats)
    .reduce((t, st) => t + (st.forfeited_cc || 0), 0);
  const insDelta = (balances['protocol:insurance'] || 0) - insBefore;
  check('沒收的押注流向保險池且可對帳：事件總額 = canary_stats 歸屬 = 保險池增額',
    forfEvents.length > 0 && Math.abs(evTotal - statTotal) < 1e-6
      && insDelta >= evTotal - 1e-6,
    `${forfEvents.length} 筆 stake_forfeit，事件 ${evTotal.toFixed(4)} = ` +
    `歸屬 ${statTotal.toFixed(4)}，保險池 +${insDelta.toFixed(4)} CC`);

  const stakeAccount = balances['protocol:stake'] || 0;
  const stakeSum = Object.values(stakes).reduce((t, v) => t + v, 0);
  check('§4 #28 押注帳務一致：沒收與退還之後 protocol:stake = 各自持有額之和',
    Math.abs(stakeAccount - stakeSum) < 1e-6,
    `protocol:stake=${stakeAccount.toFixed(4)} = Σ持有 ${stakeSum.toFixed(4)}`);

  const sum = Object.values(balances).reduce((s, v) => s + v, 0);
  check('Σ=0 在沒收與退還之後依然成立', Math.abs(sum) < 1e-9, `Σ=${sum.toFixed(10)}`);

  // #82：重建是獨立的驗證路徑，押注的沒收與退還都必須從事件流重算得出來。
  const r = rebuild(ex);
  check('獨立重建路徑同意這本帳（沒收與退還都可由事件流重算）',
    r.ok, r.ok ? `${r.receipts.length} 筆收據、${(r.warnings || []).length} 個警告`
      : r.errors.slice(0, 3).join('; '));

  // 負對照四（針對重建的歸屬檢查）：把同一筆金額從「被沒收」改記成「被罰」，
  // 總額不變、Σ 也不變，所以 Σ持有 = protocol:stake 那條檢查抓不到它——但它把
  // 一個早退者寫成了一個作弊被罰的人。重建必須拒絕。
  const forged = JSON.parse(JSON.stringify(ex));
  if (victim) {
    const st = forged.canary_stats[didOf(victim)];
    st.slashed_cc = (st.slashed_cc || 0) + st.forfeited_cc;
    st.forfeited_cc = 0;
  }
  const rf = rebuild(forged);
  check('負對照四：把沒收改記成罰款（總額不變）會被重建拒絕',
    !!victim && !rf.ok && rf.errors.some((e) => /slash|forfeit/.test(e)),
    rf.ok ? '重建接受了被改寫歸屬的匯出' : (rf.errors[0] || '').slice(0, 120));

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n結果：${results.length - failed}/${results.length} PASS`);
  console.log('verifier 明細：');
  for (const n of order) {
    const st = canary_stats[didOf(n)] || {};
    console.log(`  ${n}  ${didOf(n).slice(0, 18)}  樣本 ${st.seen || 0}  ` +
      `離線前押注 ${preStake(n).toFixed(4)}  現押注 ${stakeOf(n).toFixed(4)}  ` +
      `被罰 ${(st.slashed_cc || 0).toFixed(4)}  被沒收 ${(st.forfeited_cc || 0).toFixed(4)}  ` +
      `取回 ${evOf('stake_release', n).length ? '是' : '否'}`);
  }
  console.log('帳：', Object.entries(balances)
    .filter(([, v]) => Math.abs(v) > 1e-9)
    .map(([a, v]) => `${a.startsWith('did') ? (nm[a] || a.slice(0, 14)) : a}=${v.toFixed(2)}`)
    .join('  '));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
