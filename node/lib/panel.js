// Verifier panel selection (FR-041) — W9, fixes §4 #6.
//
// The seed used to be the *current* checkpoint root, which both parties know
// when the contract is written. A requester could therefore grind the one
// input it controls — the task id, and so the contract id — until the panel
// came out favourable. §4 #6 (from review A④) called that out and
// final-architecture §2.2 rules the fix: 抽選種子＝未來一輪 checkpoint hash.
//
// So a contract no longer names its panel. It pins the eligible pool and a
// checkpoint sequence number that does not exist yet; the panel is derived
// once that checkpoint is minted. Grinding the contract id now requires
// predicting a root that depends on settlements the requester does not
// control, across the whole network, after the contract is already signed.
//
// Both sides derive the panel from the same rule: the hub re-derives it when
// validating a forced settlement, so a requester cannot fan out to a panel of
// its choosing and have the attestations accepted.
'use strict';
const { sha256 } = require('./wire');

const PANEL_SIZE = 3;

// pool: [{did, pub, box_pub}] (or bare dids). Returns the selected entries in
// deterministic order.
function derive(pool, contractId, seedRoot, size = PANEL_SIZE) {
  const didOf = (v) => (typeof v === 'string' ? v : v.did);
  return [...pool]
    .sort((a, b) => sha256(seedRoot + contractId + didOf(a))
      .localeCompare(sha256(seedRoot + contractId + didOf(b))))
    .slice(0, size);
}

const deriveDids = (pool, contractId, seedRoot, size = PANEL_SIZE) =>
  derive(pool, contractId, seedRoot, size)
    .map((v) => (typeof v === 'string' ? v : v.did));

// The checkpoint stream is stored sparsely (§4 #41): an idle network minted
// ~3,000 identical-root checkpoints an hour and every auto-dump rewrote all
// of them, so only root *changes* (plus a slow heartbeat) are kept. Minting
// stays unconditional — #24 — because a pinned future seed only arrives if
// the sequence keeps advancing. The root in force at a given seq is therefore
// the last stored entry at or before it, and everyone resolving a
// `panel_seed_cp` must use this rule rather than indexing the array.
function checkpointAt(checkpoints, seq) {
  let found = null;
  for (const entry of checkpoints) {
    if (!entry || !entry.cp || entry.cp.seq > seq) break;
    found = entry;
  }
  return found;
}
const rootAt = (checkpoints, seq) => {
  const e = checkpointAt(checkpoints, seq);
  return e ? e.cp.root : null;
};

// The pool itself is pinned at contract time so neither party can add a
// friendly verifier afterwards; only the selection is deferred.
const poolHash = (pool) => sha256(
  [...pool].map((v) => (typeof v === 'string' ? v : v.did)).sort().join('|'));

module.exports = { PANEL_SIZE, derive, deriveDids, poolHash,
                   checkpointAt, rootAt };
