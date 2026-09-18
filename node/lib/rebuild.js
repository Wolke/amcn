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
    // A slash moves CC out of the stake account into insurance. Which
    // verifier lost it is not in the postings — the account is pooled — so
    // it comes from canary_stats below, and the two must agree.
  }

  // Stake holdings: derived from escrow minus slashing, and the account must
  // equal the sum of holdings.
  for (const [did, st] of Object.entries(ex.canary_stats || {})) {
    if (st && st.slashed_cc) {
      stakes.set(did, +((stakes.get(did) || 0) - st.slashed_cc).toFixed(4));
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
  const creditLines = {};
  for (const did of stats.keys()) {
    creditLines[did] = eeff.creditLine(did, stats.get(did), statsOf);
  }
  for (const [did, v] of Object.entries(ex.credit_lines || {})) {
    const mine = creditLines[did];
    if (mine === undefined) continue;   // an agent with no settlements yet
    if (Math.abs(mine - v) > 1e-3) {
      fail(`credit line mismatch ${did}: rebuilt ${mine.toFixed(3)} vs export ${v.toFixed(3)}`);
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
      fail(`export is from hub ${didOf(ex.hub_pub)}, expected ${expectHubDid}`);
    }
    let prevStored = null;
    for (const entry of cps) {
      if (!verify(ex.hub_pub, entry.cp, entry.sig)) {
        fail(`checkpoint #${entry.cp && entry.cp.seq} signature invalid`);
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

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
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
