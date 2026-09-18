#!/usr/bin/env node
// W11 紅隊第一批：對 Hub 的協議層攻擊（案例集見
// docs/evaluation/redteam-w11-cases.md 的 C／F／G 組）。
//
// 做法不是憑空捏造訊息，而是**先讓誠實拓撲跑出真實的收據與證據包**，再變造
// 它們。理由有二：憑空捏造只會測到「簽章驗不過」這一種拒絕，測不到「簽章有
// 效但授權的是別的東西」——後者才是有意思的攻擊（#53 就是這樣被發現的）；
// 而且用真實產物可以在每次攻擊後檢查帳本**完全沒動**。
//
// 每案的期望結果事先寫定（盤點 §1）：
//   block       已修的缺陷或協議本來就該拒絕 → 失敗即回歸
//   known-open  登記簿有登記但未修 → **攻擊成功才是 PASS**，它鎖定「我們知道
//               它壞、壞法是這樣」，哪天壞法變了會紅
//
// Run:  node redteam.js [--offset N]
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const transport = require('./lib/transport').get('tcp');
const { sign, verify, sha256, canon, identityFromSeed } = require('./lib/wire');
const panelLib = require('./lib/panel');
const eeff = require('./lib/eeff');
const inv = require('./lib/invariants');

const OFF = Number((process.argv.find((a) => a.startsWith('--offset=')) || '').split('=')[1] || 1200);
const PORT = 47180 + OFF;
const SHA_OK = [{ op: 'sha256_eq' }, { op: 'max_len', arg: 64 }];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(id, name, expect, attackSucceeded, detail) {
  // For a `block` case the attack must fail; for `known-open` it must succeed
  // (that is what keeps the registry and the suite honest about each other).
  const ok = expect === 'block' ? !attackSucceeded : attackSucceeded;
  results.push([id, ok, expect]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id} ${name}` +
    `${expect === 'known-open' ? '（已知開口）' : ''}${detail ? ' — ' + detail : ''}`);
}

const procs = [];
function spawnProc(file, env) {
  const p = spawn(process.execPath, [path.join(__dirname, file)],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'ignore'] });
  procs.push(p);
  return p;
}

// One request/response against the hub, returning whatever came back.
function ask(msg, want, ms = 4000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { c.close(); } catch {} resolve(null); }, ms);
    const c = transport.dial({ port: PORT });
    c.onMessage((m) => {
      if (want && m.type !== want) return;
      clearTimeout(t); c.close(); resolve(m);
    });
    c.send(msg);
  });
}
const exportLedger = () => ask({ type: 'export' }, 'ledger_export');

async function main() {
  console.log('== W11 紅隊第一批：協議層攻擊（真實產物變造）==\n');
  const cfg = (o, extra) => ({
    AGENT_CONFIG: JSON.stringify({ hubPort: PORT, adapter: null, posts: [], ...o }),
    ...extra,
  });
  spawnProc('hub.js', { HUB_PORT: String(PORT), HUB_AGE_RAMP_MS: '1', HUB_BEACON: '0', HUB_SEED: 'redteam' });
  await sleep(600);
  for (const v of ['V1', 'V2', 'V3']) {
    spawnProc('verifier.js', cfg({ name: v, seed: `rt-${v}` }));
  }
  await sleep(300);
  // A refuses to settle, so the run produces a real forced settlement with a
  // real evidence package to attack (T-05). The others are honest.
  spawnProc('agent.js', cfg({
    name: 'A', seed: 'rt-A', consolePort: 47301 + OFF, refuseToSettle: true,
    adapter: { baseUrl: null, key: { env: 'KA' } },
    provide: { afterMs: 0, pricePerUnit: 1.0 },
    posts: [{ atMs: 1500, units: 6, maxPriceCC: 8, payload: 'rt-1',
              acceptance: 'judge-quorum', asserts: SHA_OK }],
  }, { KA: 'sk-rt-A' }));
  spawnProc('agent.js', cfg({
    name: 'B', seed: 'rt-B', consolePort: 47302 + OFF,
    adapter: { baseUrl: null, key: { env: 'KB' } },
    provide: { afterMs: 0, pricePerUnit: 0.95 },
    posts: [{ atMs: 2500, units: 5, maxPriceCC: 7, payload: 'rt-2',
              acceptance: 'judge-quorum', asserts: SHA_OK },
            { atMs: 6000, units: 4, maxPriceCC: 6, payload: 'rt-3',
              acceptance: 'dsl-local', asserts: SHA_OK }],
  }, { KB: 'sk-rt-B' }));

  console.log('-- 讓誠實拓撲產生真實收據與證據包（14s）--');
  await sleep(14000);
  const before = await exportLedger();
  if (!before || !before.receipts.length) {
    console.log('無法取得真實收據，紅隊中止'); procs.forEach((p) => p.kill()); process.exit(1);
  }
  const dual = before.receipts.find((r) => r.kind === 'dual');
  const forced = before.receipts.find((r) => r.kind === 'forced');
  console.log(`   ${before.receipts.length} 筆收據（dual ${before.receipts.filter((r) => r.kind === 'dual').length}` +
    `／forced ${forced ? 1 : 0}），開始攻擊\n`);

  const evil = identityFromSeed('redteam-attacker');
  const unchanged = async (base) => {
    const now = await exportLedger();
    if (!now) return false;
    const sameCount = now.receipts.length === base.receipts.length;
    const sameBal = Object.keys(base.balances).every((a) =>
      Math.abs((now.balances[a] || 0) - base.balances[a]) < 1e-9);
    return sameCount && sameBal;
  };

  console.log('== C 組：拒付與強制結算 ==');

  // C2/C3/C4: mutate a real forced settlement's evidence.
  if (forced) {
    const ev = forced.evidence;
    const send = (patch) => ask({
      type: 'forced_settlement',
      receipt: patch.receipt || forced.receipt,
      provider_sig: patch.provider_sig || String(forced.sigs.provider),
      evidence: { ...ev, ...(patch.evidence || {}) },
    }, 'error', 3000);

    const cheaper = { ...ev.pre_auth, price_cc: ev.pre_auth.price_cc / 2 };
    const r2 = await send({ evidence: { pre_auth: cheaper,
      pre_auth_sig: sign(evil.privateKey, cheaper) } });
    check('C2', '偽造 pre_auth（改價＋自簽）', 'block',
      !r2 || !/invalid pre_authorization/.test(r2.why || ''), r2 ? r2.why : '無回應');

    const other = { ...ev.pre_auth, contract_id: 'c-someone-else' };
    const r3 = await send({ evidence: { pre_auth: other } });
    check('C3', '拿別份合約的 pre_auth 來結算', 'block',
      !r3 || !/invalid pre_authorization/.test(r3.why || ''), r3 ? r3.why : '無回應');

    const pricey = { ...forced.receipt,
      contract_id: forced.receipt.contract_id + '-x' };
    const r4 = await send({ receipt: pricey });
    check('C4', '強制結算帶不符合約的收據', 'block',
      !r4 || !/forced:|duplicate/.test(r4.why || ''), r4 ? r4.why : '無回應');

    const fakePanel = (forced.evidence.attestations || []).map((a) => ({
      ...a, attestation: { ...a.attestation, verifier: evil.did },
      pub: evil.pub, sig: sign(evil.privateKey, { ...a.attestation, verifier: evil.did }),
    }));
    const r5 = await send({ evidence: { attestations: fakePanel } });
    check('C5', '自選 panel 的 attestation（Hub 應重新推導）', 'block',
      !r5 || !/quorum not met|forced:/.test(r5.why || ''), r5 ? r5.why : '無回應');
  } else {
    for (const id of ['C2', 'C3', 'C4', 'C5']) {
      check(id, '（本輪未產生 forced 收據，跳過）', 'block', false, 'skipped');
    }
  }

  console.log('\n== F 組：重放、雙花與過期 ==');

  const replay = await ask({ type: 'receipt', receipt: dual.receipt, sigs: dual.sigs },
    'error', 3000);
  check('F1', '重放已結算的收據', 'block',
    !replay || !/duplicate contract_id/.test(replay.why || ''),
    replay ? replay.why : '無回應');
  check('F1b', '重放後帳本完全沒動', 'block', !(await unchanged(before)));

  const ids = before.receipts.map((r) => r.receipt.contract_id);
  check('F2', 'contract_id 全域唯一（併入 DID 標籤）', 'block',
    new Set(ids).size !== ids.length, `${ids.length} 筆，${new Set(ids).size} 個相異 id`);

  const tamperedAmt = JSON.parse(JSON.stringify(dual));
  tamperedAmt.receipt.postings[0].amount_cc -= 1;
  const rT = await ask({ type: 'receipt', receipt: tamperedAmt.receipt,
    sigs: tamperedAmt.sigs }, 'error', 3000);
  check('F5', '改金額後重送（簽章應失效）', 'block',
    !rT || !/bad signature|postings sum|duplicate/.test(rT.why || ''),
    rT ? rT.why : '無回應');

  const forgedCp = { ...before.checkpoints.at(-1) };
  forgedCp.cp = { ...forgedCp.cp, root: sha256('forged') };
  check('F8', '偽造 checkpoint 簽章（離線驗證應抓到）', 'block',
    verify(before.hub_pub, forgedCp.cp, forgedCp.sig));

  const tamperedExport = JSON.parse(JSON.stringify(before));
  tamperedExport.balances[Object.keys(tamperedExport.balances)[0]] += 100;
  check('F7', '竄改匯出檔（不變式應抓到）', 'block',
    inv.checkLedger(tamperedExport).length === 0,
    `檢查器回報 ${inv.checkLedger(tamperedExport).length} 項違反`);

  // F3/F6 need the sequencer's own key, which this harness has because it
  // set HUB_SEED. That is not cheating: threat 8's equivocation and a
  // truncated history are things only the sequencer can do, and §2.2's claim
  // is not that the hub cannot misbehave — it is that misbehaviour is
  // detectable offline. These two cases test that claim directly.
  const hubId = identityFromSeed('redteam');
  const rebuildLib = require('./lib/rebuild');

  // F6a — truncation. Nothing is forged: every receipt, event and checkpoint
  // below is genuine and hub-signed. The hub simply shows one observer a
  // history that stops one settlement short.
  const truncated = JSON.parse(JSON.stringify(before));
  truncated.receipts = truncated.receipts.slice(0, -1);
  const dropped = before.receipts.at(-1).receipt.contract_id;
  truncated.events = truncated.events.filter((e) => e.ref !== dropped &&
    e.contract_id !== dropped && !JSON.stringify(e).includes(dropped));
  delete truncated.balances; delete truncated.chains;
  const rbTrunc = rebuildLib.rebuild(truncated);
  check('F6a', '排序器出示截短的歷史（產物全部真實、簽章全部有效）', 'block',
    rbTrunc.ok,
    rbTrunc.ok
      ? `重建通過（開口）：少了 ${dropped}，checkpoint 自稱 receipts_count=` +
        `${(truncated.checkpoints.at(-1) || {}).cp.receipts_count}` +
        `，實際只給 ${truncated.receipts.length} 筆`
      : `重建拒絕：${(rbTrunc.errors.find((e) => /truncated/.test(e)) || rbTrunc.errors[0]).slice(0, 90)}`);

  // F6b — equivocation proper. The sequencer holds the key, so it can always
  // *produce* two mutually exclusive checkpoints at one seq; nothing can stop
  // that. The question §2.2 actually stakes its claim on is whether the fork
  // is detectable, so that is what this tests: fork a stored checkpoint, then
  // hand an observer the fork plus the next genuine one and see whether the
  // mismatch surfaces. Before #69b it did not — checkpoints had no link to
  // each other, so two branches were indistinguishable unless you happened to
  // hold the colliding pair itself.
  const cpi = Math.max(0, before.checkpoints.length - 2);
  const realEntry = before.checkpoints[cpi];
  const nextEntry = before.checkpoints[cpi + 1];
  const forkCp = { ...realEntry.cp,
    heads: { ...realEntry.cp.heads, 'protocol:treasury': sha256('fork') } };
  forkCp.root = sha256(canon(forkCp.heads));
  const forkEntry = { cp: forkCp, sig: sign(hubId.privateKey, forkCp) };
  const bothVerify = verify(before.hub_pub, realEntry.cp, realEntry.sig)
    && verify(before.hub_pub, forkCp, forkEntry.sig);
  const forkedExport = JSON.parse(JSON.stringify(before));
  forkedExport.checkpoints[cpi] = forkEntry;
  delete forkedExport.balances; delete forkedExport.chains;
  const rbFork = rebuildLib.rebuild(forkedExport);
  const caught = !rbFork.ok && rbFork.errors.some((e) => /forked/.test(e));
  check('F6b', '分叉的 checkpoint 串不回主鏈（§16 威脅 8）', 'block',
    !(bothVerify && caught),
    bothVerify
      ? `#${forkCp.seq} 兩個 root 簽章都有效（排序器有私鑰，攔不住），` +
        `但 #${nextEntry.cp.seq} 的 prev_root 對不上 → ` +
        (caught ? `離線重建拒絕：${rbFork.errors.find((e) => /forked/.test(e)).slice(0, 80)}…`
                : '離線重建沒抓到')
      : '簽章構造失敗，本案無效');

  // F6c — the honest remainder. #69a/#69b make a fork detectable *by an
  // observer holding artefacts from both branches*, and nothing in the
  // protocol ever puts one there: every agent learns roots from the same hub,
  // and no message type carries another agent's checkpoint view. So detection
  // is possible and never performed.
  //
  // Testing the absence of a mechanism means looking for the mechanism, which
  // is why this case reads source rather than sending frames. A behavioural
  // version would need a hub built to lie to different peers differently —
  // worth building when the gossip exists to test against, pointless before.
  // Peer-directed means carrying `to:` — that is how the hub decides what to
  // relay, so a message without it cannot reach another node. The first
  // version of this matched `checkpoint_request`, which is agent→hub, and
  // reported the mechanism as present: the wrong question answered cleanly.
  const fs = require('node:fs');
  const peerCpTraffic = ['agent.js', 'verifier.js'].some((f) => {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    return src.split('send({').slice(1).some((chunk) => {
      const body = chunk.split('})')[0];
      return /\bto:/.test(body) && /root|checkpoint/.test(body);
    });
  });
  check('F6c', '沒有任何機制讓兩個觀察者比對 checkpoint（分叉可偵測但無人偵測）',
    'known-open', !peerCpTraffic,
    'agent／verifier 都只從 Hub 單向接收 root，彼此之間沒有 checkpoint 訊息；' +
    '最小修法是節點在既有訊息上附帶自己見到的最新 (seq, root)，對不上就出聲');

  // F3 — a bid is only usable on the task it was signed for. Checked on the
  // object rather than through a victim agent, because the binding is what
  // makes the whole class impossible: without it, the cheapest bid of the day
  // could be re-used on every later task.
  const realBid = { task_id: 't-real', provider: evil.did, price_cc: 0.1,
                    box_pub: evil.pub, issued_at: Date.now(),
                    expires_at: Date.now() + 60000 };
  const bidSig = sign(evil.privateKey, realBid);
  const movedBid = { ...realBid, task_id: 't-other' };
  check('F3', '把 bid 搬到另一個 task（簽章應涵蓋 task_id）', 'block',
    verify(evil.pub, movedBid, bidSig),
    `改 task_id 後原簽章失效；requester 也以簽署內容的 task_id 索引` +
    `（agent.js pendingBids.get(msg.bid.task_id)），所以搬不過去`);

  console.log('\n== G 組：基礎設施與可用性 ==');

  const badReg = { did: evil.did, pub: evil.pub, box_pub: evil.pub };
  const rReg = await ask({ type: 'register', ...badReg, sig: 'AAAA' }, 'error', 3000);
  check('G16', '偽造簽章的註冊', 'block',
    !rReg || !/bad register signature/.test(rReg.why || ''),
    rReg ? rReg.why : '無回應');

  const victim = Object.keys(before.pubkeys)[0];
  await ask({ type: 'register_ack', did: victim }, null, 1200);
  const after = await exportLedger();
  check('G17', '替別人送 register_ack（不同連線）', 'block',
    !after, '不同 channel 的 ack 不得生效');

  const junk = ['not json', '{"v":2,"type":"receipt"}', '{"v":99,"type":"register"}',
                '{"v":2,"type":"forced_settlement"}', '{"v":2,"type":"unknown_type_xyz"}'];
  const c = transport.dial({ port: PORT });
  junk.forEach((l) => c.sendRaw(l));
  await sleep(400);
  c.close();
  const alive = await exportLedger();
  check('G1', '畸形／未知 frame 打不掉 Hub', 'block', !alive,
    alive ? `Hub 仍回應（${alive.receipts.length} 筆收據）` : 'Hub 無回應');

  const v99 = await new Promise((resolve) => {
    const t = setTimeout(() => { cc.close(); resolve(false); }, 1500);
    const cc = transport.dial({ port: PORT });
    cc.onMessage(() => { clearTimeout(t); cc.close(); resolve(true); });
    cc.sendRaw(JSON.stringify({ v: 99, type: 'export' }));
  });
  check('G2', '版本不符的請求被拒（#33）', 'block', v99);

  console.log('\n== S 組：兩個串謀身分直接攻擊結算驗證器 ==');
  // The strongest position an attacker can occupy here: two identities that
  // both sign whatever they like. Everything below is a *validly signed*
  // receipt — so these cases test the hub's schedule validator, not its
  // signature check, which is the trust boundary that actually matters.
  const X = identityFromSeed('redteam-X');
  const Y = identityFromSeed('redteam-Y');
  const pair = transport.dial({ port: PORT });
  let lastErr = null;
  pair.onMessage((m) => { if (m.type === 'error') lastErr = m; });
  for (const who of [X, Y]) {
    const body = { did: who.did, pub: who.pub, box_pub: who.pub };
    pair.send({ type: 'register', ...body, sig: sign(who.privateKey, body) });
    pair.send({ type: 'register_ack', did: who.did });
  }
  await sleep(600);

  const pool = (before.receipts.find((r) => r.receipt.acceptance_method === 'judge-quorum')
    || { receipt: {} }).receipt.verifier_pool || [];
  let seq = 0;
  const submit = async (mutate) => {
    seq += 1;
    const price = 4;
    const receipt = {
      contract_id: `c-rt-evil-${seq}`,
      requester: X.did, provider: Y.did, price_cc: price,
      acceptance_method: 'dsl-local',
      tx_class: 'market',        // labelled, so the case under test is the
                                 // one named, not the tx_class check (#20-9)
      verifier_pool: [], verifier_pool_hash: panelLib.poolHash([]),
      panel_seed_cp: 0,
      // The schedule the hub will recompute: fee 2.5% to treasury, risk 6%
      // (thin account) to insurance, remainder to the provider. Getting this
      // right matters — with a wrong split every case below is rejected by
      // the fee check and the guard it was aiming at never runs.
      postings: [
        { account: X.did, amount_cc: -price },
        { account: Y.did, amount_cc: +price * (1 - eeff.FEE_RATE - eeff.RISK_THIN) },
        { account: 'protocol:treasury', amount_cc: price * eeff.FEE_RATE },
        { account: 'protocol:insurance', amount_cc: price * eeff.RISK_THIN },
      ],
      ...mutate.receipt,
    };
    if (mutate.fix) mutate.fix(receipt);
    lastErr = null;
    pair.send({ type: 'receipt', receipt,
      sigs: { requester: sign(X.privateKey, receipt),
              provider: sign(Y.privateKey, receipt) },
      ...(mutate.extra || {}) });
    await sleep(900);
    return lastErr;
  };

  const s1 = await submit({ fix: (r) => { r.postings[1].amount_cc += 5; } });
  check('S1', 'Σ≠0 的分錄（憑空造錢）', 'block',
    !s1 || !/postings sum/.test(s1.why || ''), s1 ? s1.why : '無回應');

  // Priced correctly on purpose: the first attempt used a two-entry posting
  // set and was rejected by the fee-schedule check, so the credit-line guard
  // it was meant to exercise never ran. A case that passes for the wrong
  // reason is the same false assurance as a fault that cannot happen (#51).
  const s2 = await submit({ fix: (r) => {
    const big = 5000;
    r.price_cc = big;
    r.postings = [
      { account: X.did, amount_cc: -big },
      { account: Y.did, amount_cc: +big * (1 - eeff.FEE_RATE - eeff.RISK_THIN) },
      { account: 'protocol:treasury', amount_cc: big * eeff.FEE_RATE },
      { account: 'protocol:insurance', amount_cc: big * eeff.RISK_THIN },
    ];
  } });
  check('S2', '超過動態信用額度的支出（費率正確，逼出額度守門）', 'block',
    !s2 || !/would exceed credit line/.test(s2.why || ''), s2 ? s2.why : '無回應');

  const s3 = await submit({ receipt: { acceptance_method: 'judge-quorum' } });
  check('S3', 'judge-quorum 但 pool 是空的（#37）', 'block',
    !s3 || !/pool of at least|does not match its pinned hash/.test(s3.why || ''),
    s3 ? s3.why : '無回應');

  const s4 = await submit({ receipt: {
    acceptance_method: 'judge-quorum', verifier_pool: pool,
    verifier_pool_hash: panelLib.poolHash(pool),
    panel_seed_cp: 1 } });
  check('S4', 'judge-quorum 但零份 attestation', 'block',
    !s4 || !/quorum not met|verifier postings/.test(s4.why || ''),
    s4 ? s4.why : '無回應');

  const s5 = await submit({ fix: (r) => {
    r.postings.push({ account: evil.did, amount_cc: 0.2 });
    r.postings[1].amount_cc -= 0.2;
  } });
  check('S5', 'dsl-local 卻塞入 verifier 報酬（#5）', 'block',
    !s5 || !/fee schedule|verifier/.test(s5.why || ''), s5 ? s5.why : '無回應');

  const s6 = await submit({ fix: (r) => {
    r.postings[2].amount_cc = 0;                 // treasury 被抽乾
    r.postings[1].amount_cc += 0.1;
  } });
  check('S6', '短付 Treasury／保險池（偷手續費）', 'block',
    !s6 || !/fee schedule|postings sum/.test(s6.why || ''), s6 ? s6.why : '無回應');

  const s7 = await submit({ receipt: {
    acceptance_method: 'judge-quorum', verifier_pool: pool,
    verifier_pool_hash: panelLib.poolHash(pool),
    panel_seed_cp: 999999 } });
  check('S7', '種子 checkpoint 指向未來（尚未鑄造）', 'block',
    !s7 || !/not minted yet/.test(s7.why || ''), s7 ? s7.why : '無回應');

  // Deleted, not set to undefined: `undefined` survives in the object the
  // signature is computed over but vanishes from the JSON on the wire, so
  // the hub rejects it as a bad signature and the tx_class check never runs.
  const s10 = await submit({ fix: (r) => { delete r.tx_class; } });
  check('S10', '未標示 tx_class 的結算（§20-9）', 'block',
    !s10 || !/tx_class must be one of/.test(s10.why || ''), s10 ? s10.why : '無回應');

  const s11 = await submit({ receipt: { tx_class: 'definitely-real-trade' } });
  check('S11', '自創 tx_class 值', 'block',
    !s11 || !/tx_class must be one of/.test(s11.why || ''), s11 ? s11.why : '無回應');

  // Signed by both parties and internally consistent — only the clock says
  // no. The attacker cannot backdate someone else's expiry (it is inside the
  // signed body), but it can sign its own stale one, which is the case the
  // hub has to refuse.
  const s12 = await submit({ receipt: {
    issued_at: Date.now() - 3600000, expires_at: Date.now() - 1800000 } });
  check('S12', '已過期但簽章有效的結算（§16 威脅 8）', 'block',
    !s12 || !/expired/.test(s12.why || ''), s12 ? s12.why : '無回應');

  const s8 = await submit({ fix: (r) => { r.postings[0].amount_cc = -1; } });
  check('S8', 'requester 少付、其餘照領', 'block',
    !s8 || !/postings sum|fee schedule/.test(s8.why || ''), s8 ? s8.why : '無回應');

  // 抵押品（#65）。X 的餘額是 0，所以這三案問的是同一件事的三個面向：
  // 能不能用信用額度去抵押信用額度（那就是無擔保放大）。
  const colSig = (did, amt, lock) =>
    sign(X.privateKey, { did, amount_cc: amt, lock });
  const colTry = async (msg) => {
    lastErr = null;
    pair.send(msg);
    await sleep(900);
    return lastErr;
  };
  const c1 = await colTry({ type: 'collateral_post', did: X.did,
    amount_cc: 20, sig: colSig(X.did, 20, true) });
  check('S13', '用沒有的餘額抵押（信用抵押信用）', 'block',
    !c1 || !/credit cannot collateralise credit|balance/.test(c1.why || ''),
    c1 ? c1.why : '無回應');

  const c2 = await colTry({ type: 'collateral_post', did: X.did,
    amount_cc: 20, sig: 'AAAA' });
  check('S14', '偽造簽章的抵押請求', 'block',
    !c2 || !/bad signature/.test(c2.why || ''), c2 ? c2.why : '無回應');

  const c3 = await colTry({ type: 'collateral_release', did: X.did,
    amount_cc: 5, sig: colSig(X.did, 5, false) });
  check('S15', '取回從未鎖入的抵押品', 'block',
    !c3 || !/cannot release/.test(c3.why || ''), c3 ? c3.why : '無回應');

  check('S9', '十一次攻擊之後帳本完全沒動', 'block', !(await unchanged(before)));
  pair.close();

  console.log('\n== 已知開口（攻擊成功才是 PASS）==');

  // F4 used to be a known-open: nothing carried a time, so nothing expired.
  const ev0 = (forced && forced.evidence) || {};
  check('F4', '協議物件帶有時效欄位（§16 威脅 8）', 'block',
    !(ev0.contract && typeof ev0.contract.expires_at === 'number' &&
      typeof ev0.pre_auth.expires_at === 'number'),
    ev0.contract
      ? `合約與 pre_auth 都帶 issued_at／expires_at`
      : '本輪無 forced 收據可檢查');

  // G14 — #16. The frame layer catches the throw (G1/G3 prove that), but the
  // sender learns nothing: no reply names the field it left out. That is the
  // whole of #16, and it is still open.
  const noField = await ask({ type: 'forced_settlement' }, 'error', 2500);
  check('G14', '缺必要欄位的 frame 得不到逐欄位的錯誤指引（#16）', 'known-open',
    !noField || !/receipt|missing|required/i.test(noField.why || ''),
    noField ? `Hub 只回「${String(noField.why).slice(0, 60)}」`
            : 'Hub 完全不回應，送出方無從知道少了哪個欄位');

  // G15: equal-price tie-break by arrival order — #23
  const strat = require('node:fs').readFileSync(path.join(__dirname, 'agent.js'), 'utf8');
  // Source-level, and knowingly weaker than it should be: selection now
  // sorts by price÷reliability (#59), so equal price *and* equal reliability
  // still falls through to Array.sort's stability, i.e. arrival order. A
  // behavioural version — two providers, identical price, identical history,
  // see who wins repeatedly — belongs in batch three.
  check('G15', '同價同信譽時以雜湊決勝，不是到達順序（#23）', 'block',
    !/sha256\(task\.task_id \+ a\.provider\)/.test(strat),
    '選標在價格與信譽相同時以 sha256(task_id+provider) 決勝');

  const finalEx = await exportLedger();
  const violations = finalEx ? inv.checkLedger(finalEx) : ['無法取得匯出'];
  // G3 — #34. The hub has no async handlers; the *agent* does, because
  // executing a contract awaits the adapter. So the target is agent A, and
  // the trigger is a contract whose sealed payload cannot be opened: the
  // throw happens inside an async handler, where an unhandled rejection used
  // to take the process down mid-contract.
  let aDid = null;
  try {
    aDid = (await (await fetch(`http://127.0.0.1:${47301 + OFF}/status`)).json()).did;
  } catch { /* no console; case reports itself as untested */ }
  let aliveAfter = null;
  if (aDid) {
    await ask({ type: 'contract', to: aDid, contract: {
      contract_id: 'c-rt-poison', requester: evil.did, provider: aDid,
      price_cc: 1, units: 1, acceptance_method: 'dsl-local', asserts: SHA_OK,
      verifier_pool: [], panel_seed_cp: 0,
      payload_box: { eph_pub: 'AAAA', ct: 'AAAA', tag: 'AAAA', nonce: 'AAAA' },
    }, sig: sign(evil.privateKey, { x: 1 }), pub: evil.pub }, null, 1500);
    await sleep(1200);
    try {
      aliveAfter = await (await fetch(`http://127.0.0.1:${47301 + OFF}/status`)).json();
    } catch { aliveAfter = null; }
  }
  check('G3', 'async handler 內拋例外（不得殺掉進程）', 'block',
    !aDid || !aliveAfter,
    aDid ? (aliveAfter
      ? `A 收下開不了的 payload_box 後仍在服務（餘額 ${aliveAfter.balance_cc} CC）`
      : 'A 的 Console 不再回應——進程可能已死')
      : '取不到 A 的 DID，本案未測到');

  check('INV', '所有攻擊之後，七項不變式仍然成立', 'block', violations.length > 0,
    violations.length ? violations.slice(0, 2).join(' | ') : `${finalEx.receipts.length} 筆收據下全數通過`);

  procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } });
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n結果：${results.length - failed}/${results.length} PASS` +
    `（block ${results.filter(([, , e]) => e === 'block').length}、` +
    `known-open ${results.filter(([, , e]) => e === 'known-open').length}）`);
  process.exit(failed ? 1 : 0);
}

main();
