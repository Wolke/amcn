// Protocol invariants, checked continuously rather than once at the end.
//
// The demos each verify a subset at the end of a run (Σ=0, chains, dual
// signatures, the fee schedule). That is enough to prove mechanics on a
// happy path, but a fault scenario needs a different question answered:
// was an invariant *ever* broken, including at the moment the network was
// cut in half. So the checks move here, take a ledger export (plus optional
// live samples), and return violations rather than printing.
//
// Everything here is computable by a third party from signed artefacts —
// that is the §20-4 promise, and keeping the checker export-only is what
// keeps us honest about it. The two exceptions take explicit live samples:
// pool liveness (a hub-side view) and stuck contracts (an agent-side view),
// both labelled as such.
'use strict';
const { verify, sha256, canon } = require('./wire');
const panel = require('./panel');
const eeff = require('./eeff');

// --- ledger-only ---------------------------------------------------------

// Σ of every balance is zero: mutual credit creates no units (FR-050/051).
function conservation(ex) {
  const sum = Object.values(ex.balances).reduce((s, v) => s + v, 0);
  return Math.abs(sum) < 1e-9 ? [] : [`Σ balances = ${sum.toFixed(9)} ≠ 0`];
}

// Per-account hash chains, and the last checkpoint's root and signature.
function chains(ex) {
  const bad = [];
  for (const [account, chain] of Object.entries(ex.chains || {})) {
    let balance = 0, prev = sha256(account);
    for (const e of chain) {
      const { hash, ...body } = e;
      if (sha256(canon(body)) !== hash) { bad.push(`hash ${account}#${e.seq}`); break; }
      if (e.prev_hash !== prev) { bad.push(`broken link ${account}#${e.seq}`); break; }
      balance = +(balance + e.delta_cc).toFixed(6);
      if (Math.abs(balance - e.balance_after) > 1e-6) {
        bad.push(`balance ${account}#${e.seq}`); break;
      }
      prev = hash;
    }
  }
  const last = (ex.checkpoints || []).at(-1);
  if (last) {
    const heads = {};
    for (const [account, chain] of Object.entries(ex.chains || {})) {
      heads[account] = chain.at(-1).hash;
    }
    if (sha256(canon(heads)) !== last.cp.root) bad.push('checkpoint root mismatch');
    if (ex.hub_pub && !verify(ex.hub_pub, last.cp, last.sig)) {
      bad.push('checkpoint signature invalid');
    }
  }
  return bad;
}

// Every dual-signed receipt carries two valid signatures.
function receiptSignatures(ex) {
  const bad = [];
  for (const r of ex.receipts) {
    for (const [role, sig] of Object.entries(r.sigs || {})) {
      const pub = ex.pubkeys[r.receipt[role]];
      if (!pub || !verify(pub, r.receipt, sig)) {
        bad.push(`${r.receipt.contract_id}: bad ${role} signature`);
      }
    }
  }
  return bad;
}

// A judge-quorum settlement must pay exactly the panel the seed checkpoint
// derives, and dsl-local must pay none (§4 #5/#6/#26).
function quorumBacked(ex) {
  const bad = [];
  for (const r of ex.receipts) {
    const rc = r.receipt;
    const paid = rc.postings
      .filter((p) => (rc.verifier_pool || []).includes(p.account) && p.amount_cc > 0)
      .map((p) => p.account);
    if (rc.acceptance_method !== 'judge-quorum') {
      if (paid.length) bad.push(`${rc.contract_id}: ${rc.acceptance_method} paid verifiers`);
      continue;
    }
    const seed = panel.checkpointAt(ex.checkpoints || [], rc.panel_seed_cp);
    if (!seed) { bad.push(`${rc.contract_id}: seed checkpoint #${rc.panel_seed_cp} missing`); continue; }
    const derived = panel.deriveDids(rc.verifier_pool, rc.contract_id, seed.cp.root);
    for (const acct of paid) {
      if (!derived.includes(acct)) {
        bad.push(`${rc.contract_id}: paid ${acct.slice(0, 18)} outside the derived panel`);
      }
    }
    if (paid.length < 2) {
      bad.push(`${rc.contract_id}: quorum settlement paid only ${paid.length}`);
    }
    const price = -(rc.postings.find((p) => p.account === rc.requester) || {}).amount_cc;
    const total = rc.postings
      .filter((p) => paid.includes(p.account))
      .reduce((t, p) => t + p.amount_cc, 0);
    if (Math.abs(total - price * eeff.VERIFIER_RATE) > 1e-3) {
      bad.push(`${rc.contract_id}: verifier fee ${total.toFixed(4)} ≠ ` +
        `${(price * eeff.VERIFIER_RATE).toFixed(4)}`);
    }
  }
  return bad;
}

// No account may sit below its own credit line (INV-C1's enforcement point).
function creditLimits(ex) {
  const bad = [];
  for (const [acct, v] of Object.entries(ex.balances)) {
    if (!acct.startsWith('did:') || v >= 0) continue;
    const line = ex.credit_lines[acct];
    if (line === undefined) continue;
    if (v < -line - 1e-6) {
      bad.push(`${acct.slice(0, 18)} at ${v.toFixed(2)} below credit line ${line.toFixed(1)}`);
    }
  }
  return bad;
}

// contract_id is the settlement idempotency key (W1 schema freeze).
function uniqueContractIds(ex) {
  const ids = ex.receipts.map((r) => r.receipt.contract_id);
  return new Set(ids).size === ids.length ? [] : ['duplicate contract_id in receipts'];
}

const LEDGER_CHECKS = {
  conservation, chains, receiptSignatures, quorumBacked, creditLimits,
  uniqueContractIds,
};

function checkLedger(ex, only = null) {
  const violations = [];
  for (const [name, fn] of Object.entries(LEDGER_CHECKS)) {
    if (only && !only.includes(name)) continue;
    for (const v of fn(ex)) violations.push(`${name}: ${v}`);
  }
  return violations;
}

// --- live samples --------------------------------------------------------

// The hub must not advertise a verifier it believes to be offline. Checked
// against the set the sampler saw disconnect — this is the shape #46 broke:
// the pool kept naming verifiers that were gone.
function poolLiveness({ advertised = [], knownGone = [] }) {
  const gone = new Set(knownGone);
  return advertised.filter((d) => gone.has(d))
    .map((d) => `pool still advertises ${d.slice(0, 18)} after it went away`);
}

// A contract open far longer than settlement should take is the observable
// form of "created but can never settle".
function noStuckContracts(consoles, maxOpenMs) {
  const bad = [];
  for (const [name, c] of Object.entries(consoles)) {
    if (!c || !c.contracts) continue;
    if (c.contracts.oldest_open_ms > maxOpenMs) {
      bad.push(`${name}: a contract has been open ` +
        `${(c.contracts.oldest_open_ms / 1000).toFixed(0)}s ` +
        `(limit ${(maxOpenMs / 1000).toFixed(0)}s), ${c.contracts.open} open`);
    }
  }
  return bad;
}

module.exports = {
  ...LEDGER_CHECKS, checkLedger, poolLiveness, noStuckContracts,
  names: () => Object.keys(LEDGER_CHECKS),
};
