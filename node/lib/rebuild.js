// Ledger rebuild from an export — W10「帳本匯出重建」, and the mechanism §2.2
// promises when it says 「全部狀態可由公開簽署事件重建」.
//
// The point is that a *second* sequencer can reconstruct the ledger without
// trusting the first one, so almost nothing in the export is taken on faith:
//
//   receipts     re-verified signature by signature. A dual settlement needs
//                both parties over the exact receipt; a forced one needs the
//                provider's signature plus the requester's pre_authorization
//                from its evidence bundle, because in a forced settlement the
//                requester refused to sign — that is what T-05 is.
//   pubkeys      self-certifying: did:demo is sha256(pub), so the mapping is
//                checked rather than believed.
//   balances     recomputed by replaying the event log; the export's copy is
//                only ever compared against the result.
//   chains       hashes and links recomputed the same way the hub builds them.
//   stakes       recomputed from the escrow rule over settlement events.
//   credit lines recomputed from stats replayed out of the receipts, so an
//                importer never inherits a credit line it cannot justify.
//   checkpoints  the one thing that is not derivable, since periodic ones are
//                minted on a clock and correspond to no receipt. They are
//                verified against hub_pub, and the caller may pin the hub DID
//                it expects — a sequencer that reuses HUB_SEED continues the
//                same identity, which is what makes rotation work (§4 #14).
//
// Any mismatch is a refusal. A sequencer that starts from an unverified
// ledger is worse than one that will not start.
'use strict';
const { verify, sha256, canon } = require('./wire');
const eeff = require('./eeff');

const EPS = 1e-6;
const didOf = (pub) => 'did:demo:' + sha256(pub).slice(0, 16);

// The single definition of a hash-chain entry, used by the hub when it
// appends and by the rebuild when it replays. It lived in two places and the
// copies drifted — the replay omitted `account` and rounded delta_cc — so a
// clean export failed its own verification with "chain hash mismatch". One
// rule, one implementation.
// `at` is the first timestamp anywhere in the signed data. It is here
// because §20-10 wants average repayment time and that cannot be derived
// from a ledger with no clock — and because a replay must reproduce the
// hash, it has to be part of the hashed body and therefore supplied by the
// caller rather than read from Date.now() during verification.
//
// It does not close §4's "no protocol object carries an expiry": this is a
// record of when the hub applied a posting, not an expiry anyone can
// enforce. It also means dumps written before this change no longer verify.
function chainEntry(account, chain, receiptIdx, delta, balanceAfter, at) {
  const prev = chain.at(-1);
  const entry = {
    account,
    seq: chain.length,
    prev_hash: prev ? prev.hash : sha256(account),
    receipt_idx: receiptIdx,
    delta_cc: delta,
    balance_after: +balanceAfter.toFixed(6),
    at: at || 0,
  };
  entry.hash = sha256(canon(entry));
  return entry;
}

function rebuild(ex, opts = {}) {
  const errors = [];
  const fail = (m) => { errors.push(m); return null; };
  // 與 fail 分開：warn 是「這一項無從檢查」，不是「這一項不通過」。混在一起
  // 的話，修覆蓋率的人會以為自己在修守恆（#76 分「未測到」與「違反」同理）。
  const warnings = [];
  const warn = (m) => { warnings.push(m); console.error(`[rebuild] 注意：${m}`); };
  // notes 與 warnings 分開：接手是一個**事實**（這本帳換過排序器，而換得
  // 合法），不是「這一項無從檢查」。把它塞進 warnings 會讓一個正常的接手
  // 看起來像一個瑕疵，而那會訓練人忽略警告。
  const notes = [];
  const {
    stakeTargetCc = 5, stakeEscrowFrac = 0.5, expectHubDid = null,
  } = opts;

  if (!ex || !Array.isArray(ex.receipts) || !Array.isArray(ex.events)) {
    return { ok: false, errors: ['export missing receipts or events — an ' +
      'export without the full event log cannot be rebuilt (stake escrow, ' +
      'slashing and canary payouts are not derivable from receipts alone)'] };
  }

  // --- pubkeys must certify their own DIDs -----------------------------
  const pubkeys = ex.pubkeys || {};
  for (const [did, pub] of Object.entries(pubkeys)) {
    if (didOf(pub) !== did) fail(`pubkey does not hash to its DID: ${did}`);
  }

  // --- every receipt re-verified ---------------------------------------
  const byContract = new Map();
  ex.receipts.forEach((r, i) => {
    const rec = r && r.receipt;
    if (!rec) return fail(`receipt ${i} has no body`);
    if (byContract.has(rec.contract_id)) {
      fail(`duplicate contract_id in export: ${rec.contract_id}`);
    }
    byContract.set(rec.contract_id, r);
    const sum = rec.postings.reduce((t, p) => t + p.amount_cc, 0);
    if (Math.abs(sum) > 1e-9) fail(`receipt ${rec.contract_id} postings sum ${sum}`);
    const provPub = pubkeys[rec.provider];
    if (!provPub || !verify(provPub, rec, r.sigs && r.sigs.provider)) {
      fail(`receipt ${rec.contract_id}: provider signature invalid`);
    }
    const reqSig = r.sigs && r.sigs.requester;
    if (typeof reqSig === 'string' && reqSig.startsWith('pre_auth:')) {
      const ev = r.evidence || {};
      if (!ev.pre_auth || !verify(pubkeys[rec.requester], ev.pre_auth, ev.pre_auth_sig)) {
        fail(`receipt ${rec.contract_id}: forced settlement without a valid ` +
          'pre_authorization');
      }
      if (ev.pre_auth && ev.pre_auth.contract_id !== rec.contract_id) {
        fail(`receipt ${rec.contract_id}: pre_authorization is for another contract`);
      }
    } else if (!verify(pubkeys[rec.requester], rec, reqSig)) {
      fail(`receipt ${rec.contract_id}: requester signature invalid`);
    }
  });

  // --- replay the event log --------------------------------------------
  const balances = new Map();
  const chains = new Map();
  const stakes = new Map();
  const bal = (a) => balances.get(a) || 0;

  // The timestamp is taken from the export's own chain, because the replay
  // has to reproduce the hash the hub computed, not invent a new one. If the
  // export has tampered timestamps the hash check downstream catches it, so
  // reading them here is not trusting them.
  const atOf = (account, seq) => {
    const src = (ex.chains && ex.chains[account]) || [];
    return (src[seq] && src[seq].at) || 0;
  };

  const chainAppend = (account, receiptIdx, delta) => {
    const chain = chains.get(account) || [];
    chain.push(chainEntry(account, chain, receiptIdx, delta, bal(account),
      atOf(account, chain.length)));
    chains.set(account, chain);
  };
  for (const [i, e] of ex.events.entries()) {
    if (!e || !Array.isArray(e.postings)) { fail(`event ${i} malformed`); continue; }
    const sum = e.postings.reduce((t, p) => t + p.amount_cc, 0);
    if (Math.abs(sum) > 1e-9) { fail(`event ${i} (${e.kind}) sum ${sum} != 0`); continue; }
    // A settlement event must correspond to a receipt that verified above;
    // otherwise CC could be moved by an event nobody signed.
    if (e.kind === 'settlement' && !byContract.has(e.ref)) {
      fail(`settlement event ${i} has no signed receipt: ${e.ref}`);
      continue;
    }
    for (const p of e.postings) {
      balances.set(p.account, bal(p.account) + p.amount_cc);
      chainAppend(p.account, e.receipt_idx, p.amount_cc);
    }
    // An escrow event moves CC out of one verifier and into the stake
    // account, so the verifier's (negative) posting is what it now holds.
    if (e.kind === 'stake_escrow') {
      for (const p of e.postings) {
        if (p.account === 'protocol:stake' || p.amount_cc >= 0) continue;
        stakes.set(p.account, +((stakes.get(p.account) || 0) - p.amount_cc).toFixed(4));
      }
    }
    // 退還把 CC 從押注帳戶送回 verifier 自己的餘額（#38 的另一半）。這一筆
    // 的歸屬**在分錄裡**（正分錄的收款方就是它），所以不需要摘要欄位——與
    // slash／forfeit 的 pooled 分錄不同，那兩者才要靠 canary_stats。
    if (e.kind === 'stake_release') {
      for (const p of e.postings) {
        if (p.account === 'protocol:stake' || p.amount_cc <= 0) continue;
        stakes.set(p.account, +((stakes.get(p.account) || 0) - p.amount_cc).toFixed(4));
      }
    }
    // A slash moves CC out of the stake account into insurance. Which
    // verifier lost it is not in the postings — the account is pooled — so
    // it comes from canary_stats below, and the two must agree.
  }

  // Stake holdings: derived from escrow minus slashing, and the account must
  // equal the sum of holdings.
  // 兩種離開押注帳戶的路徑：被罰（slashed_cc，#27/#30）與棄權沒收
  // （forfeited_cc，#38 的離線且未被測夠）。兩者都是 STAKE → INSURANCE 的
  // pooled 分錄，歸屬只存在 canary_stats，所以兩個都要扣，Σ持有 才對得上。
  for (const [did, st] of Object.entries(ex.canary_stats || {})) {
    if (!st) continue;
    const out = (st.slashed_cc || 0) + (st.forfeited_cc || 0);
    if (out) stakes.set(did, +((stakes.get(did) || 0) - out).toFixed(4));
  }
  // 每一條路徑的總額也要各自對得上，不只是總和恰好平。Σ持有 = protocol:stake
  // 抓得到「憑空宣稱沒收」，但抓不到「把一筆 slash 記成 forfeit」——那會讓一個
  // 被罰的 verifier 看起來只是早退。兩個類別各自比對就把這件事關掉。
  for (const [kind, field] of [['slash', 'slashed_cc'], ['stake_forfeit', 'forfeited_cc']]) {
    const fromEvents = (ex.events || [])
      .filter((e) => e.kind === kind)
      .reduce((t, e) => t + (e.postings || [])
        .filter((p) => p.account === 'protocol:insurance')
        .reduce((u, p) => u + p.amount_cc, 0), 0);
    const attributed = Object.values(ex.canary_stats || {})
      .reduce((t, st) => t + ((st || {})[field] || 0), 0);
    if (Math.abs(fromEvents - attributed) > EPS) {
      fail(`${kind} total ${fromEvents.toFixed(4)} != canary_stats.${field} ` +
        `${attributed.toFixed(4)} — 押注流出的歸屬與事件不一致`);
    }
  }
  const stakeSum = [...stakes.values()].reduce((t, v) => t + v, 0);
  const stakeAccount = bal('protocol:stake');
  if (Math.abs(stakeSum - stakeAccount) > EPS) {
    fail(`rebuilt stake holdings ${stakeSum.toFixed(4)} != protocol:stake ` +
      `${stakeAccount.toFixed(4)}`);
  }

  // --- compare against the export's own copies -------------------------
  const conserved = [...balances.values()].reduce((t, v) => t + v, 0);
  if (Math.abs(conserved) > 1e-9) fail(`rebuilt Σ balances = ${conserved}`);

  for (const [acct, v] of Object.entries(ex.balances || {})) {
    if (Math.abs(bal(acct) - v) > EPS) {
      fail(`balance mismatch ${acct}: rebuilt ${bal(acct)} vs export ${v}`);
    }
  }
  for (const [acct, chain] of Object.entries(ex.chains || {})) {
    const mine = chains.get(acct) || [];
    if (mine.length !== chain.length) {
      fail(`chain length mismatch ${acct}: ${mine.length} vs ${chain.length}`);
      continue;
    }
    for (let i = 0; i < chain.length; i++) {
      if (mine[i].hash !== chain[i].hash) {
        fail(`chain hash mismatch ${acct}#${i}`);
        break;
      }
    }
  }

  // --- credit lines from replayed stats, never inherited ---------------
  const stats = new Map();
  const statsOf = (did) => stats.get(did) || null;
  const ensure = (did) => {
    if (!stats.has(did)) stats.set(did, eeff.newStats());
    return stats.get(did);
  };
  for (const r of ex.receipts) {
    const rec = r.receipt;
    const price = -rec.postings.find((p) => p.account === rec.requester).amount_cc;
    const provNet = rec.postings.find((p) => p.account === rec.provider).amount_cc;
    const req = ensure(rec.requester), prov = ensure(rec.provider);
    req.paidTo.set(rec.provider, (req.paidTo.get(rec.provider) || 0) + price);
    prov.earnedBy.set(rec.requester, (prov.earnedBy.get(rec.requester) || 0) + provNet);
    prov.completed += 1;
  }
  // #82：額度含**年齡**與**抵押品**兩項，而這裡原本兩個都沒傳——
  // `eeff.creditLine` 的 ageFactor 預設是 1，於是重建一律當成「帳戶已完全
  // 成熟」。starter 項在年齡 0 與 1 之間差整整一倍（`STARTER*(0.5+0.5*age)`），
  // 所以每個帳戶都會多出約 25 CC，匯入因此被拒。
  //
  // 三台試點是第一次用**生產預設**（30 天斜坡）跑的，也是第一次看到它：
  // 所有 demo 與 chaos 情境都設 `HUB_AGE_RAMP_MS=1`，斜坡在 1 毫秒內走完、
  // 兩邊都得到 age=1，於是這個分歧在 harness 裡結構上不可能出現。
  //
  // 年齡要以**匯出當下**為準，不是重建當下——重建必然比較晚，算出來的年齡
  // 會比較大。`exported_at` 就是為此而加（同 #78 的 `at`：衍生值需要產生它
  // 的輸入）。舊的匯出沒有這個欄位，那就跳過比對並說出來，而不是拿一個
  // 必定不同的值去判它有罪。
  const collateralNow = new Map();
  for (const [did, v] of Object.entries(ex.collateral || {})) {
    collateralNow.set(did, v);
  }
  const exportedAt = ex.exported_at || null;
  const creditLines = {};
  for (const did of stats.keys()) {
    // 斜坡長度取自匯出（#82）。用重建方自己的環境變數會在兩邊設定不同時
    // 靜默算出不同的額度——而「兩邊各算各的」正是這一條的成因。
    const af = exportedAt
      ? eeff.ageFactor((ex.joined_at || {})[did], exportedAt,
                       ex.age_ramp_ms || eeff.AGE_RAMP_MS)
      : 1;
    creditLines[did] = eeff.creditLine(did, stats.get(did), statsOf, af,
                                       collateralNow.get(did) || 0);
  }
  if (!exportedAt && Object.keys(ex.credit_lines || {}).length) {
    warn('匯出沒有 exported_at（#82 之前的格式）——信用額度的年齡項無從重算，' +
         '本次略過額度比對；其餘檢查照跑');
  } else {
    for (const [did, v] of Object.entries(ex.credit_lines || {})) {
      const mine = creditLines[did];
      if (mine === undefined) continue;   // an agent with no settlements yet
      if (Math.abs(mine - v) > 1e-3) {
        fail(`credit line mismatch ${did}: rebuilt ${mine.toFixed(3)} vs ` +
          `export ${v.toFixed(3)} — 年齡因子或 HUB_AGE_RAMP_MS 兩邊不一致？（#82）`);
      }
    }
  }

  // Collateral rebuilt from the event stream, not copied from the export:
  // §20-4 says balances come from signed events, and a locked amount that
  // only exists as a summary field could disagree with the postings that
  // produced it (#65).
  const collateral = new Map();
  for (const e of ex.events || []) {
    // write_off 也會動到抵押品（瀑布的第一層），漏掉它的話重建出來的鎖定額
    // 會比實際多，而那正是核對步驟會抓到的不一致。
    if (e.kind === 'collateral_post' || e.kind === 'collateral_release'
        || e.kind === 'write_off') {
      for (const p of e.postings || []) {
        if (p.account === 'protocol:collateral') continue;
        const cur = collateral.get(p.account) || 0;
        collateral.set(p.account, +(cur - p.amount_cc).toFixed(6));
      }
    }
  }
  for (const [did, c] of Object.entries(ex.collateral || {})) {
    const replayed = collateral.get(did) || 0;
    if (Math.abs(replayed - c) > 1e-6) {
      fail(`collateral mismatch ${did}: replayed ${replayed} vs export ${c}`);
    }
  }

  // --- checkpoints: the only signed-by-sequencer artefact --------------
  const cps = ex.checkpoints || [];
  if (ex.hub_pub) {
    if (expectHubDid && didOf(ex.hub_pub) !== expectHubDid) {
      // 接手之後，匯出來自**後繼者**，而釘住前任的人仍然要驗得過這本帳
      // （#95）。判準與 client 跟隨位址記錄時完全相同：能不能從我釘的那個
      // DID 經委派鏈走到這本帳的排序器。走不到才是「不是我要的那本帳」。
      const su = require('./succession');
      const path = su.chain(ex.succession || [],
        { from: expectHubDid, to: didOf(ex.hub_pub) });
      if (!path) {
        fail(`export is from hub ${didOf(ex.hub_pub)}, expected ${expectHubDid}` +
          (ex.succession ? '，而附帶的接手憑證裡沒有一條從它出發的鏈' : ''));
      } else {
        notes.push(`接手：這本帳的排序器 ${didOf(ex.hub_pub)} 由 ${expectHubDid} ` +
          `事先授權（${path.length} 段委派）`);
      }
    }
    // 接手之後，這本帳裡有**前任簽的** checkpoint（#95）。原本這裡只認一把
    // `hub_pub`，於是後繼者的匯出在第三方手上**驗不過**——而「任何人都可以
    // 自己驗這本帳」是這個設計的核心宣稱之一，所以那等於接手把帳弄成不可驗。
    // 閘門先抓到的就是這一條（`checkpoint #0 signature invalid`）。
    //
    // 允許的簽署者＝現任，加上**能經委派鏈走到現任的**每一個前任。鏈本身隨
    // 匯出出去（`ex.succession`），每一段都有自己的簽章，所以這不是放寬：
    // 一把不在鏈上的 key 簽的 checkpoint 仍然是偽造。
    const signers = [{ pub: ex.hub_pub, who: 'current' }];
    if (Array.isArray(ex.succession) && ex.succession.length) {
      const su = require('./succession');
      const hubDid = didOf(ex.hub_pub);
      for (const c of ex.succession) {
        const ok = su.checkCert(c);
        if (!ok) { fail('succession cert in export does not verify'); continue; }
        // 只收「從這個簽發者出發，能走到現任」的憑證：一張把排序權交給別人
        // 的憑證不會讓簽發者自己變成合法簽署者。
        if (ok.successor === hubDid ||
            su.chain(ex.succession, { from: ok.issuer, to: hubDid })) {
          signers.push({ pub: c.pub, who: `predecessor ${ok.issuer}` });
        }
      }
    }
    const signedByAny = (cp, sig) => signers.some((s) => {
      try { return verify(s.pub, cp, sig); } catch { return false; }
    });
    let prevStored = null;
    for (const entry of cps) {
      if (!signedByAny(entry.cp, entry.sig)) {
        fail(`checkpoint #${entry.cp && entry.cp.seq} signature invalid` +
          (signers.length > 1
            ? `（試過現任與 ${signers.length - 1} 個前任的 key）` : ''));
      }
      // §4 #69a — a truncated history. Every artefact in such an export is
      // genuine and hub-signed; what gives it away is that a checkpoint
      // counts more settlements than the export contains. Found by F6a,
      // which rebuilt a history one settlement short and was accepted.
      // `<=` not `===`: checkpoints are minted on a timer, so the newest one
      // legitimately lags a settlement that has not been checkpointed yet.
      if (entry.cp && typeof entry.cp.receipts_count === 'number'
          && entry.cp.receipts_count > ex.receipts.length) {
        fail(`checkpoint #${entry.cp.seq} counts ${entry.cp.receipts_count} ` +
          `receipts but the export carries ${ex.receipts.length} — history ` +
          'is truncated');
      }
      // §4 #69b — the checkpoint chain. Absent on exports written before
      // prev_root existed, so a missing field is not an error (same
      // compatibility rule as checkpoint_seq below).
      if (entry.cp && prevStored && typeof entry.cp.prev_root === 'string'
          && entry.cp.prev_root !== prevStored.cp.root) {
        fail(`checkpoint #${entry.cp.seq} links to root ` +
          `${entry.cp.prev_root.slice(0, 12)} but the preceding stored ` +
          `checkpoint #${prevStored.cp.seq} has root ` +
          `${prevStored.cp.root.slice(0, 12)} — checkpoint chain forked`);
      }
      prevStored = entry;
    }
  } else if (cps.length) {
    fail('checkpoints present but no hub_pub to verify them against');
  }

  // #78：checkpoint 的 root 必須真的概括**這本重建出來的帳**的 chain heads。
  // 上面驗的是簽章與 `prev_root` 的鏈接——兩者都不會注意到「重算出來的鏈
  // 根本不是被簽的那一條」。尾檔恢復就是這樣：`at` 只存在於鏈分錄裡，
  // 一旦遺失，每一筆的 `at` 變成 0、全部雜湊改變，而 `rebuild` 從前照樣回報
  // ok，於是一份還原後的帳與它自己已簽署的歷史悄悄分岔（§20-4 在 root 這一
  // 層失效，而 root 正是 #6 的 panel 種子與 #69c 分叉指控的依據）。
  //
  // 只對**最後一個保留的** checkpoint 比對：root 一動就會被保留（見 hub 的
  // `moved || heartbeat`），所以最後那個必然對應當下的 heads。
  const lastKept = cps.at(-1);
  if (lastKept && lastKept.cp && chains.size) {
    const heads = {};
    for (const [acct, chain] of chains) heads[acct] = chain.at(-1).hash;
    const root = sha256(canon(heads));
    if (root !== lastKept.cp.root) {
      fail(`checkpoint #${lastKept.cp.seq} commits to root ` +
        `${lastKept.cp.root.slice(0, 12)} but the chains rebuilt from the ` +
        `signed history hash to ${root.slice(0, 12)} — the reconstruction is ` +
        'not the ledger that was signed (§4 #78; a tail without chain ' +
        'entries loses every `at` and changes every hash)');
    }
  }

  if (errors.length) return { ok: false, errors, warnings, notes };
  return {
    ok: true,
    errors: [],
    warnings,
    notes,
    balances, chains, stakes,
    stats,
    creditLines,
    // Handed back so a rebuilt hub keeps every key it was given, rather
    // than re-deriving them from whoever happens to reconnect.
    pubkeys,
    collateral: Object.fromEntries(collateral),
    checkpoints: cps,
    // Sparse storage (§4 #41) means the array length no longer implies the
    // sequence position, so a rebuilt hub has to be told where to resume
    // numbering. Older exports have no such field; fall back to the last
    // stored seq, which was dense back then.
    checkpointSeq: ex.checkpoint_seq != null
      ? ex.checkpoint_seq
      : (cps.length ? cps.at(-1).cp.seq + 1 : 0),
    receipts: ex.receipts,
    events: ex.events,
    settledIds: new Set([...byContract.keys()]),
    canaryStats: new Map(Object.entries(ex.canary_stats || {})),
    canaryScored: new Set(ex.canary_scored || []),
    hubDid: ex.hub_pub ? didOf(ex.hub_pub) : null,
    summary: {
      receipts: ex.receipts.length,
      events: ex.events.length,
      accounts: balances.size,
      checkpoints: cps.length,
    },
  };
}

module.exports = { rebuild, didOf, chainEntry };
