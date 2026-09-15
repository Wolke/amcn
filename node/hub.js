// Coordination Hub — the "first sequencer, not a trust root" (proposal B).
//
// This round adds the ledger-integrity and anti-refusal layer:
// - per-account hash chains over settled postings + hub-signed checkpoints
//   after every settlement → tamper-evident history, rebuildable by anyone
// - verifier registry; verifier panels are fixed in the dual-signed
//   contract (FR-041)
// - forced settlement (threat T-05, "requester refuses to pay"): a
//   provider holding {dual-signed contract, requester's pre_authorization,
//   2-of-3 PASS attestations} can settle without the requester's receipt
//   signature — the pre_auth IS the requester's standing signature.
//
// The hub still cannot move balances on its own: every path requires
// either two receipt signatures or contract+pre_auth+quorum evidence,
// all verifiable offline from the export.
'use strict';
const { attachLineReader, sendLine, verify, sha256, canon, PROTOCOL_VERSION,
        genIdentity, identityFromSeed, sign, net } = require('./lib/wire');
const eeff = require('./lib/eeff');
const discovery = require('./lib/discovery');
const panel = require('./lib/panel');
const rebuildLib = require('./lib/rebuild');

const PORT = Number(process.env.HUB_PORT || 47180);
const BIND = process.env.HUB_BIND || '127.0.0.1'; // 0.0.0.0 for LAN pilots
const TREASURY = 'protocol:treasury';
const INSURANCE = 'protocol:insurance';
// §4 #28: a verifier's stake has to be real CC held somewhere, or "slashing"
// can only ever take what the verifier happened to have earned — which
// coupled deterrence to the fee rate, an implementation artifact rather than
// a design. proposal-C assumes a verifier posts a deposit up front, but a
// verifier here starts at 0 CC with no credit line, so pay-to-play is not
// available. Instead a share of each verification fee is escrowed until the
// target is met: a new verifier has little at risk and earns little, and
// works its way to full standing — the same shape as the credit line.
const STAKE = 'protocol:stake';
const STAKE_TARGET_CC = Number(process.env.HUB_STAKE_TARGET_CC || 5);
const STAKE_ESCROW_FRAC = Number(process.env.HUB_STAKE_ESCROW_FRAC || 0.5);
// proposal-C §7: 「Treasury 定期以隨機身分發布已知答案任務」. The issuer is a
// separate agent, not the hub: having the hub originate tasks would make the
// sequencer a market participant, which §2.2's "第一個排序器不是信任根" is
// specifically trying to avoid. The cost is a privileged DID — one identity
// whose signed canary reports the hub acts on, and which spends Treasury
// funds. That privilege is why it is operator-configured and named in the
// startup log rather than inferred.
const CANARY_DID = process.env.HUB_CANARY_DID || null;
// §4 #27/#30: punish a pattern, not a single unlucky verdict, and require an
// absolute count so a small sample cannot cross a rate threshold by luck.
const SLASH_FRAC = Number(process.env.HUB_SLASH_FRAC || 0.10);
const SLASH_THRESHOLD = Number(process.env.HUB_SLASH_THRESHOLD || 0.25);
const SLASH_MIN_SAMPLES = Number(process.env.HUB_SLASH_MIN_SAMPLES || 5);
const SLASH_MIN_FAILURES = Number(process.env.HUB_SLASH_MIN_FAILURES || 3);

// §4 #14: hubPin only meant anything for one hub lifetime, because a fresh
// keypair every start changed the identity agents were told to pin. With
// HUB_SEED the hub keeps its DID across restarts, which is what makes
// rotation a real operation: move the hub, keep the seed, and every pinned
// agent follows it to the new address.
const hubId = process.env.HUB_SEED
  ? identityFromSeed(process.env.HUB_SEED)
  : genIdentity(); // signs checkpoints
const settledIds = new Set(); // contract_id idempotency keys
const stakes = new Map();     // verifier did -> CC held in protocol:stake
const canaryStats = new Map(); // verifier did -> {seen, failed, slashed_cc}
const canarySeen = new Set();  // canary contract_ids already scored

// Post a balanced set that is not a settlement (escrow, slashing). Same
// conservation and hash-chain rules; kept separate so `receipts` stays the
// list of things two parties signed.
function applyPostings(kind, ref, postings) {
  const total = postings.reduce((t, p) => t + p.amount_cc, 0);
  if (Math.abs(total) > 1e-9) {
    console.error(`[hub] refusing ${kind} ${ref}: postings sum ${total} != 0`);
    return false;
  }
  const idx = receipts.length;
  for (const p of postings) {
    balances.set(p.account, bal(p.account) + p.amount_cc);
    chainAppend(p.account, idx, p.amount_cc);
  }
  events.push({ kind, ref, postings, receipt_idx: idx });
  makeCheckpoint();
  return true;
}
const agents = new Map();    // did -> {pub, boxPub, sock, stats, role}
const balances = new Map();
const receipts = [];         // {kind:'dual'|'forced', receipt, sigs, evidence?}
const chains = new Map();    // account -> [{seq,prev_hash,receipt_idx,delta_cc,balance_after,hash}]
const checkpoints = [];
// Every posting set applied, in order. §2.2 promises 「全部狀態可由公開簽署
// 事件重建」, and receipts alone cannot deliver that: stake escrow, slashing
// and canary payouts also move CC, and slashing/canary are not derivable
// from receipts at all. The simulator's ledger.py has always kept a full
// event list; this side only had receipts, so an export could not be
// rebuilt. W10's export->rebuild is what surfaced it.
const events = [];          // {kind, ref, postings, receipt_idx?}
// Stats replayed from an import, adopted when the DID registers.
const importedStats = new Map();
const rawLog = [];

const bal = (a) => balances.get(a) || 0;
const statsOf = (did) => agents.get(did)?.stats;
const clOf = (did) =>
  agents.has(did) ? eeff.creditLine(did, agents.get(did).stats, statsOf) : 0;

function broadcast(obj, exceptDid) {
  for (const [did, a] of agents) if (did !== exceptDid) sendLine(a.sock, obj);
}
function fail(sock, why, ref) {
  sendLine(sock, { type: 'error', why, ref });
  console.log(`[hub] REJECT ${ref || ''}: ${why}`);
}
function feeTerms(requesterDid, price, panelSize = 0) {
  const fee = +(price * eeff.FEE_RATE).toFixed(4);
  const risk = +(price * eeff.riskRate(agents.get(requesterDid).stats)).toFixed(4);
  // Equal split, and the remainder goes to the first verifier so the postings
  // still sum to zero at 4 decimals.
  const verifierTotal = panelSize
    ? +(price * eeff.VERIFIER_RATE).toFixed(4) : 0;
  const each = panelSize ? +(verifierTotal / panelSize).toFixed(4) : 0;
  const shares = [];
  for (let i = 0; i < panelSize; i++) shares.push(each);
  if (panelSize) {
    shares[0] = +(shares[0] + (verifierTotal - each * panelSize)).toFixed(4);
  }
  return { fee, risk, verifierTotal, verifierShares: shares };
}

// --- hash chain + checkpoints ------------------------------------------
function chainAppend(account, receiptIdx, delta) {
  const chain = chains.get(account) || [];
  // Shared with lib/rebuild.js so an append and a replay cannot disagree.
  chain.push(rebuildLib.chainEntry(account, chain, receiptIdx, delta, bal(account)));
  chains.set(account, chain);
}
function makeCheckpoint() {
  const heads = {};
  for (const [acct, chain] of chains) heads[acct] = chain.at(-1).hash;
  const cp = {
    seq: checkpoints.length,
    heads,
    root: sha256(canon(heads)),
    receipts_count: receipts.length,
  };
  const entry = { cp, sig: sign(hubId.privateKey, cp) };
  checkpoints.push(entry);
  // Panels are seeded from a checkpoint that does not exist yet (§4 #6), so
  // every agent needs to learn roots as they are minted.
  broadcast({ type: 'checkpoint', cp, sig: entry.sig });
  return cp;
}

// --- settlement core ----------------------------------------------------
// Which panel members actually produced an accountable PASS. A verdict
// counts only if the reveal opens a commitment the verifier signed before
// seeing anyone else's — that binding is what makes the three checks
// independent rather than one check copied twice (§2.2 commit-reveal).
function validAttesters(receipt, attestations, panelDids) {
  const ok = new Set();
  for (const e of attestations || []) {
    const a = e && e.attestation;
    if (!a || a.contract_id !== receipt.contract_id || a.verdict !== 'PASS') continue;
    const v = agents.get(a.verifier);
    if (!v || v.role !== 'verifier' || !panelDids.includes(a.verifier)) continue;
    if (!verify(v.pub, a, e.sig)) continue;
    // commitment must bind this exact verdict, and be signed by this verifier
    if (typeof e.nonce !== 'string' || typeof e.commitment !== 'string') continue;
    if (sha256(canon(a) + e.nonce) !== e.commitment) continue;
    const commitBody = { contract_id: a.contract_id, verifier: a.verifier,
                         commitment: e.commitment };
    if (!verify(v.pub, commitBody, e.commit_sig)) continue;
    ok.add(a.verifier);
  }
  return ok;
}

function validateSchedule(receipt, sock, ref, attestations) {
  // contract_id is the settlement idempotency key: one contract, one
  // settlement. Both the dual and forced paths come through here.
  if (settledIds.has(ref)) {
    fail(sock, 'duplicate contract_id: already settled', ref);
    return false;
  }
  const sum = receipt.postings.reduce((s, p) => s + p.amount_cc, 0);
  if (Math.abs(sum) > 1e-9) { fail(sock, `postings sum ${sum} != 0`, ref); return false; }
  const price = -receipt.postings.find((p) => p.account === receipt.requester).amount_cc;
  // §4 #5: a judge-quorum settlement must pay the panel, and the hub derives
  // that panel itself from the receipt's pinned pool and future seed — the
  // requester cannot invent payees. dsl-local acceptance pays no verifiers.
  let panelDids = [];
  if (receipt.acceptance_method === 'judge-quorum') {
    const seedEntry = checkpoints[receipt.panel_seed_cp];
    if (!seedEntry) {
      fail(sock, `seed checkpoint #${receipt.panel_seed_cp} not minted yet`, ref);
      return false;
    }
    if (panel.poolHash(receipt.verifier_pool) !== receipt.verifier_pool_hash) {
      fail(sock, 'verifier pool does not match its pinned hash', ref);
      return false;
    }
    panelDids = panel.deriveDids(receipt.verifier_pool, ref, seedEntry.cp.root);
  }
  // A judge-quorum settlement with an empty pool used to skip the quorum
  // check entirely, so a receipt could claim quorum acceptance while nobody
  // had verified anything — the ledger would record it as a quorum
  // settlement. Acceptance must not degrade silently just because the pool
  // was empty when the contract was written.
  if (receipt.acceptance_method === 'judge-quorum' &&
      panelDids.length < panel.PANEL_SIZE) {
    fail(sock, `judge-quorum needs a pool of at least ${panel.PANEL_SIZE}, ` +
      `got ${panelDids.length}`, ref);
    return false;
  }
  // §4 #26: only verifiers whose reveal opened a prior commitment get paid.
  // A panel member that stayed silent earns nothing.
  let payees = panelDids;
  if (panelDids.length) {
    const attesters = validAttesters(receipt, attestations, panelDids);
    if (attesters.size < 2) {
      fail(sock, `quorum not met: ${attesters.size} accountable PASS ` +
        `attestations (need 2)`, ref);
      return false;
    }
    payees = panelDids.filter((d) => attesters.has(d)); // panel order
  }
  const { fee, risk, verifierTotal, verifierShares } =
    feeTerms(receipt.requester, price, payees.length);
  const expect = {
    [receipt.provider]: +(price - fee - risk - verifierTotal).toFixed(4),
    [TREASURY]: fee, [INSURANCE]: risk,
  };
  payees.forEach((did, i) => { expect[did] = verifierShares[i]; });
  const namedVerifiers = receipt.postings
    .filter((p) => { const a = agents.get(p.account); return a && a.role === 'verifier'; })
    .map((p) => p.account);
  if (namedVerifiers.length !== payees.length ||
      namedVerifiers.some((d) => !payees.includes(d))) {
    fail(sock, `verifier postings ${namedVerifiers.length} != accountable ` +
      `attesters ${payees.length}`, ref);
    return false;
  }
  for (const [acct, amt] of Object.entries(expect)) {
    const p = receipt.postings.find((x) => x.account === acct);
    if (!p || Math.abs(p.amount_cc - amt) > 1e-6) {
      fail(sock, `posting ${acct} != fee schedule (${amt})`, ref); return false;
    }
  }
  for (const p of receipt.postings) {
    if (agents.has(p.account) &&
        bal(p.account) + p.amount_cc < -clOf(p.account) - 1e-9) {
      fail(sock, `${p.account} would exceed credit line ${clOf(p.account).toFixed(1)}`, ref);
      return false;
    }
  }
  return true;
}

function applySettlement(kind, receipt, sigs, evidence) {
  const idx = receipts.length;
  const price = -receipt.postings.find((p) => p.account === receipt.requester).amount_cc;
  const provNet = receipt.postings.find((p) => p.account === receipt.provider).amount_cc;
  for (const p of receipt.postings) {
    balances.set(p.account, bal(p.account) + p.amount_cc);
    chainAppend(p.account, idx, p.amount_cc);
  }
  const req = agents.get(receipt.requester), prov = agents.get(receipt.provider);
  req.stats.paidTo.set(receipt.provider,
    (req.stats.paidTo.get(receipt.provider) || 0) + price);
  prov.stats.earnedBy.set(receipt.requester,
    (prov.stats.earnedBy.get(receipt.requester) || 0) + provNet);
  prov.stats.completed += 1;
  receipts.push({ kind, receipt, sigs, evidence });
  events.push({ kind: 'settlement', ref: receipt.contract_id,
                postings: receipt.postings, receipt_idx: idx });
  settledIds.add(receipt.contract_id);
  const cp = makeCheckpoint();
  console.log(`[hub] SETTLED(${kind}) ${receipt.contract_id}: ` +
    receipt.postings.map((p) => `${p.account.slice(0, 18)}=${p.amount_cc.toFixed(2)}`)
      .join(' ') + ` | checkpoint#${cp.seq} ${cp.root.slice(0, 12)}`);
  broadcast({ type: 'settled', receipt, kind });
  // Escrow part of each verifier's fee into the stake account. A separate
  // posting set, not folded into the receipt: the receipt is what both
  // parties signed, and the hub must not be able to alter it after the fact.
  for (const p of receipt.postings) {
    const a = agents.get(p.account);
    if (!a || a.role !== 'verifier' || p.amount_cc <= 0) continue;
    const held = stakes.get(p.account) || 0;
    const room = +(STAKE_TARGET_CC - held).toFixed(4);
    if (room <= 0) continue;
    const take = +Math.min(room, p.amount_cc * STAKE_ESCROW_FRAC).toFixed(4);
    if (take <= 0) continue;
    stakes.set(p.account, +(held + take).toFixed(4));
    applyPostings('stake_escrow', receipt.contract_id,
      [{ account: p.account, amount_cc: -take }, { account: STAKE, amount_cc: take }]);
  }
  // The band's low bound is -0.3 x CL (FR-055), and CL moves with every
  // settlement, so each party needs its new line, not the one it got at
  // registration.
  for (const did of [receipt.requester, receipt.provider]) {
    const a = agents.get(did);
    if (a) sendLine(a.sock, { type: 'credit_update', did, credit_line: clOf(did) });
  }
}

function handleReceipt(msg, sock) {
  const { receipt, sigs } = msg;
  const req = agents.get(receipt.requester), prov = agents.get(receipt.provider);
  const ref = receipt.contract_id;
  if (!req || !prov) return fail(sock, 'unknown party', ref);
  if (!verify(req.pub, receipt, sigs.requester) ||
      !verify(prov.pub, receipt, sigs.provider)) {
    return fail(sock, 'bad signature: dual-signed receipt required', ref);
  }
  if (!validateSchedule(receipt, sock, ref, msg.attestations)) return;
  applySettlement('dual', receipt, sigs);
}

// A canary result: the issuer reports how the panel judged a decoy whose
// correct verdict is knowable. Recorded per verifier, and a pattern of
// passing known-bad work costs stake.
function handleCanaryResult(msg, sock) {
  const { report, sig, attestations } = msg;
  const ref = report && report.contract_id;
  if (!CANARY_DID) return fail(sock, 'canary reports not enabled on this hub', ref);
  const issuer = agents.get(report.issuer);
  if (!issuer || report.issuer !== CANARY_DID) {
    return fail(sock, 'canary report from an unauthorised issuer', ref);
  }
  if (!verify(issuer.pub, report, sig)) {
    return fail(sock, 'bad canary report signature', ref);
  }
  if (canarySeen.has(ref)) return fail(sock, 'canary already scored', ref);
  if (report.expected_verdict !== 'FAIL') {
    return fail(sock, 'canary must expect FAIL (its asserts are unsatisfiable)', ref);
  }
  const panelDids = panel.deriveDids(report.verifier_pool, ref, report.seed_root);
  if (panel.poolHash(report.verifier_pool) !== report.verifier_pool_hash) {
    return fail(sock, 'canary pool does not match its pinned hash', ref);
  }
  canarySeen.add(ref);

  const wrong = [];
  for (const e of attestations || []) {
    const a = e && e.attestation;
    if (!a || a.contract_id !== ref) continue;
    const v = agents.get(a.verifier);
    if (!v || v.role !== 'verifier' || !panelDids.includes(a.verifier)) continue;
    if (!verify(v.pub, a, e.sig)) continue;
    // Same accountability bar as a settlement: the reveal must open a
    // commitment made before the verifier saw anyone else's verdict.
    if (typeof e.nonce !== 'string' || sha256(canon(a) + e.nonce) !== e.commitment) continue;
    if (!verify(v.pub, { contract_id: ref, verifier: a.verifier,
                         commitment: e.commitment }, e.commit_sig)) continue;
    const st = canaryStats.get(a.verifier) || { seen: 0, failed: 0, slashed_cc: 0 };
    st.seen += 1;
    if (a.verdict === 'PASS') { st.failed += 1; wrong.push(a.verifier); }
    canaryStats.set(a.verifier, st);
  }

  const slashed = [];
  for (const did of wrong) {
    const st = canaryStats.get(did);
    const rate = st.failed / st.seen;
    if (st.seen < SLASH_MIN_SAMPLES || st.failed < SLASH_MIN_FAILURES ||
        rate < SLASH_THRESHOLD) continue;  // recorded, not punished
    const held = stakes.get(did) || 0;
    const take = +Math.min(held, STAKE_TARGET_CC * SLASH_FRAC).toFixed(4);
    if (take <= 0) continue;
    stakes.set(did, +(held - take).toFixed(4));
    st.slashed_cc = +(st.slashed_cc + take).toFixed(4);
    // Forfeited stake funds the insurance pool, which is what absorbs the
    // bad debt that undetected bad work produces.
    applyPostings('slash', ref, [{ account: STAKE, amount_cc: -take },
                                 { account: INSURANCE, amount_cc: take }]);
    slashed.push(`${did.slice(0, 18)}=-${take}`);
  }

  // FR-083: the decoy is real work for the provider, paid by Treasury and
  // marked a test transaction so it never counts as organic volume.
  const price = report.price_cc;
  if (price > 0 && agents.has(report.provider)) {
    applyPostings('canary', ref, [{ account: TREASURY, amount_cc: -price },
                                  { account: report.provider, amount_cc: price }]);
  }
  console.log(`[hub] CANARY ${ref}: ${panelDids.length} panel, ` +
    `${wrong.length} passed known-bad work` +
    (slashed.length ? `, slashed ${slashed.join(' ')}` : ', none above the evidence bar') +
    `, treasury paid provider ${price} CC`);
  sendLine(sock, { type: 'canary_scored', contract_id: ref,
                   wrong: wrong.length, slashed: slashed.length });
}

function handleForced(msg, sock) {
  const { receipt, provider_sig, evidence } = msg;
  const ref = receipt.contract_id;
  const req = agents.get(receipt.requester), prov = agents.get(receipt.provider);
  if (!req || !prov) return fail(sock, 'unknown party', ref);
  const { contract, contract_sigs, pre_auth, pre_auth_sig, attestations } = evidence;
  // 1. dual-signed contract binding both parties to price + verifier panel
  if (contract.contract_id !== ref || contract.requester !== receipt.requester ||
      contract.provider !== receipt.provider ||
      !verify(req.pub, contract, contract_sigs.requester) ||
      !verify(prov.pub, contract, contract_sigs.provider)) {
    return fail(sock, 'forced: contract not dual-signed by both parties', ref);
  }
  // 2. requester's standing pre_authorization ("quorum PASS ⇒ settle")
  if (pre_auth.contract_id !== ref || pre_auth.price_cc !== contract.price_cc ||
      pre_auth.condition !== 'quorum-accepted' ||
      !verify(req.pub, pre_auth, pre_auth_sig)) {
    return fail(sock, 'forced: invalid pre_authorization', ref);
  }
  // 3. 2-of-3 PASS attestations from the panel the seed checkpoint selects.
  // Re-derived here, not read off the contract: otherwise a requester could
  // fan out to a panel of its choosing and have the attestations accepted.
  const seedEntry = checkpoints[contract.panel_seed_cp];
  if (!seedEntry) {
    return fail(sock, `forced: seed checkpoint #${contract.panel_seed_cp} not minted yet`, ref);
  }
  if (panel.poolHash(contract.verifier_pool) !== contract.verifier_pool_hash) {
    return fail(sock, 'forced: verifier pool does not match its pinned hash', ref);
  }
  const expected = new Set(panel.deriveDids(
    contract.verifier_pool, ref, seedEntry.cp.root));
  const passers = new Set();
  for (const { attestation, sig } of attestations) {
    const v = agents.get(attestation.verifier);
    if (!v || v.role !== 'verifier') continue;
    if (!expected.has(attestation.verifier)) continue;
    if (attestation.contract_id !== ref || attestation.verdict !== 'PASS') continue;
    if (verify(v.pub, attestation, sig)) passers.add(attestation.verifier);
  }
  if (passers.size < 2) {
    return fail(sock, `forced: quorum not met (${passers.size}/2 PASS)`, ref);
  }
  // 4. provider signature over this exact receipt + fee schedule + CL
  if (!verify(prov.pub, receipt, provider_sig)) {
    return fail(sock, 'forced: bad provider signature', ref);
  }
  if (-receipt.postings.find((p) => p.account === receipt.requester).amount_cc
      !== contract.price_cc) {
    return fail(sock, 'forced: receipt price != contract price', ref);
  }
  if (!validateSchedule(receipt, sock, ref, attestations)) return;
  console.log(`[hub] FORCED settlement ${ref}: requester refused, ` +
    `pre_auth + ${passers.size}-of-${expected.size} quorum stands in ` +
    `(panel seeded from checkpoint #${contract.panel_seed_cp})`);
  applySettlement('forced', receipt,
    { requester: `pre_auth:${pre_auth_sig}`, provider: provider_sig }, evidence);
}

// One definition of the export, shared by the `export` message and the
// auto-dump, so a dumped ledger can never differ from a queried one.
function buildExport() {
  return {
    receipts,
    pubkeys: Object.fromEntries([...agents].map(([d, a]) => [d, a.pub])),
    balances: Object.fromEntries(balances),
    credit_lines: Object.fromEntries(
      [...agents].filter(([, a]) => a.role === 'agent')
        .map(([d]) => [d, clOf(d)])),
    chains: Object.fromEntries(chains),
    checkpoints,
    stakes: Object.fromEntries(stakes),
    canary_stats: Object.fromEntries(canaryStats),
    canary_scored: [...canarySeen],
    events,
    hub_pub: hubId.pub,
    raw_log: rawLog.join('\n'),
  };
}

// A disaster export you have to remember to take is not disaster recovery.
// The pilot proved it: export->import shipped, then the hub went down with
// nobody having run ledger-dump.js, and that ledger was gone regardless.
// HUB_DUMP_PATH writes the same artefact on a timer, so the most a crash
// costs is one interval.
function startAutoDump() {
  const file = process.env.HUB_DUMP_PATH;
  if (!file) return;
  const ms = Number(process.env.HUB_DUMP_MS || 10000);
  const fs = require('node:fs');
  fs.mkdirSync(require('node:path').dirname(file), { recursive: true });
  const write = () => {
    try {
      // Written to a temp path and renamed, so a crash mid-write cannot
      // leave a truncated file where a recoverable one used to be.
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(buildExport()));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error(`[hub] auto-dump failed: ${err.message}`);
    }
  };
  setInterval(write, ms).unref();
  write();
  console.log(`[hub] auto-dump every ${ms}ms → ${file}`);
}

// W10: start as a second sequencer from a disaster export. Verified, not
// trusted — see lib/rebuild.js. A refusal to start is the correct outcome
// when the export does not check out; carrying on with an unverified ledger
// would make the sequencer exactly the trust root §2.2 says it is not.
if (process.env.HUB_IMPORT) {
  const file = process.env.HUB_IMPORT;
  let ex;
  try {
    ex = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[hub] cannot read import ${file}: ${err.message}`);
    process.exit(1);
  }
  const r = rebuildLib.rebuild(ex, { expectHubDid: process.env.HUB_EXPECT_DID || null });
  if (!r.ok) {
    console.error(`[hub] REFUSING to start: import failed verification ` +
      `(${r.errors.length} problems)`);
    for (const e of r.errors.slice(0, 10)) console.error(`  - ${e}`);
    if (r.errors.length > 10) console.error(`  … and ${r.errors.length - 10} more`);
    process.exit(1);
  }
  for (const [k, v] of r.balances) balances.set(k, v);
  for (const [k, v] of r.chains) chains.set(k, v);
  for (const [k, v] of r.stakes) stakes.set(k, v);
  for (const [k, v] of r.canaryStats) canaryStats.set(k, v);
  for (const c of r.canaryScored) canarySeen.add(c);
  for (const c of r.settledIds) settledIds.add(c);
  receipts.push(...r.receipts);
  events.push(...r.events);
  checkpoints.push(...r.checkpoints);
  // Stats drive the credit line, and they were recomputed from the receipts
  // rather than copied, so an imported agent cannot inherit standing the
  // ledger does not justify. The agent entry is created on registration;
  // park the stats until then.
  for (const [did, st] of r.stats) importedStats.set(did, st);
  console.log(`[hub] rebuilt from ${file}: ${r.summary.receipts} receipts, ` +
    `${r.summary.events} events, ${r.summary.accounts} accounts, ` +
    `${r.summary.checkpoints} checkpoints — all signatures and chains verified` +
    (r.hubDid ? `, origin hub ${r.hubDid}` : ''));
}

// §2.2 calls for a periodic public checkpoint, and a future-seeded panel
// needs one: with checkpoints minted only on settlement, a contract awaiting
// verification in a quiet network would wait for a seed that never arrives.
const CHECKPOINT_MS = Number(process.env.HUB_CHECKPOINT_MS || 1200);
// Unconditionally, including before the first settlement. An empty-heads
// checkpoint is well-formed (root = hash of {}), and gating on chains.size
// deadlocked a fresh network: the first contract's panel seed is a checkpoint
// that only a settlement would have minted, and that settlement needed the
// panel. A network whose first task wanted a quorum could never start.
setInterval(makeCheckpoint, CHECKPOINT_MS).unref();

// --- server ---------------------------------------------------------------
const server = net.createServer((sock) => {
  // Departures matter for the verifier pool: a panel is drawn from the pool
  // pinned at contract time, so a verifier that has gone away keeps being
  // selected, produces no attestation, and silently blocks settlement once
  // the quorum cannot be met. Mark offline rather than delete — the stats
  // feed the credit line, and dropping them would reset an agent's standing
  // on reconnect while its balance persisted.
  sock.on('close', () => {
    for (const [did, a] of agents) {
      if (a.sock !== sock || a.online === false) continue;
      a.online = false;
      console.log(`[hub] ${did} disconnected (${a.role})`);
    }
  });
  attachLineReader(sock, (msg) => {
    switch (msg.type) {
      case 'register': {
        const body = { did: msg.did, pub: msg.pub, box_pub: msg.box_pub };
        if (msg.role) body.role = msg.role;
        if (!verify(msg.pub, body, msg.sig)) {
          return fail(sock, 'bad register signature', msg.did);
        }
        const prior = agents.get(msg.did);
        agents.set(msg.did, {
          pub: msg.pub, boxPub: msg.box_pub, sock, online: true,
          // Keep the history on reconnect: stats drive the credit line.
          stats: prior ? prior.stats
            : (importedStats.get(msg.did) || eeff.newStats()),
          role: msg.role || 'agent',
        });
        balances.set(msg.did, bal(msg.did));
        // Hand back what this identity already holds. A seeded agent that
        // restarts keeps its DID and therefore its debt (§4 #17), but its
        // own view starts at zero — and the strategy engine reads that
        // balance, so a restarted agent carrying real debt would believe it
        // was at zero, skip repayment mode, and overestimate what it can
        // spend until the hub refused it.
        sendLine(sock, { type: 'registered', did: msg.did,
                         credit_line: clOf(msg.did), fee_rate: eeff.FEE_RATE,
                         balance_cc: bal(msg.did),
                         stake_cc: stakes.get(msg.did) || 0,
                         settlements: receipts.filter((r) =>
                           r.receipt.postings.some((p) => p.account === msg.did)).length });
        console.log(`[hub] registered ${msg.did} (${msg.role || 'agent'}, CL ${clOf(msg.did).toFixed(1)})`);
        break;
      }
      case 'task': {
        const req = agents.get(msg.task.requester);
        if (!req || !verify(req.pub, msg.task, msg.sig)) {
          return fail(sock, 'bad task signature', msg.task.task_id);
        }
        console.log(`[hub] task ${msg.task.task_id} broadcast ` +
          `(${msg.task.units}u, max ${msg.task.max_price_cc} CC, ` +
          `acceptance ${msg.task.acceptance.method})`);
        broadcast(msg, msg.task.requester);
        break;
      }
      case 'list_verifiers': {
        const latest = checkpoints.at(-1);
        sendLine(sock, {
          type: 'verifiers',
          verifiers: [...agents]
            .filter(([, a]) => a.role === 'verifier' && a.online !== false)
            .map(([did, a]) => ({ did, pub: a.pub, box_pub: a.boxPub })),
          lock: { checkpoint_seq: latest ? latest.cp.seq : -1,
                  root: latest ? latest.cp.root : sha256('genesis') },
          // The seq a contract written now must seed its panel from: one that
          // has not been minted, so its root cannot be ground against.
          next_checkpoint_seq: checkpoints.length,
        });
        break;
      }
      case 'fee_quote': {
        const size = (msg.panel || []).length;
        const { fee, risk, verifierShares } =
          feeTerms(msg.requester, msg.price, size);
        sendLine(sock, { type: 'fee_terms', contract_id: msg.contract_id,
                         requester: msg.requester, price: msg.price, fee, risk,
                         panel: msg.panel || [], verifier_shares: verifierShares });
        break;
      }
      case 'bid': case 'contract': case 'contract_ack': case 'delivery':
      case 'receipt_half': case 'verify_request': case 'attestation':
      case 'attestation_commit': case 'reveal_request': {
        const to = agents.get(msg.to);
        if (to) sendLine(to.sock, msg);
        break;
      }
      case 'receipt': handleReceipt(msg, sock); break;
      case 'forced_settlement': handleForced(msg, sock); break;
      case 'canary_result': handleCanaryResult(msg, sock); break;
      case 'export': {
        sendLine(sock, { type: 'ledger_export', ...buildExport() });
        break;
      }

    }
  }, (line) => rawLog.push(line));
});

server.on('error', (err) => {
  console.error(`[hub] listen failed on ${BIND}:${PORT}: ${err.code || err.message}` +
    (err.code === 'EADDRINUSE' ? ' — another hub is already running, or set HUB_PORT' : ''));
  process.exit(1);
});

server.listen(PORT, BIND, () => {
  console.log(
    `[hub] listening on ${BIND}:${PORT} — protocol v${PROTOCOL_VERSION}, ` +
    // The DID an agent pins with hubPin, so it must not depend on whether
    // the beacon happens to be enabled.
    `hub did ${discovery.didOf(hubId.pub)}, ` +
    `starter CL ${eeff.STARTER_CC}, fee ${eeff.FEE_RATE * 100}%, ` +
    `risk ${eeff.RISK_THIN * 100}%/${eeff.RISK_BASE * 100}%, hash-chained + checkpointed`);
  if (process.env.HUB_BEACON === '0') {
    console.log('[hub] discovery beacon disabled (HUB_BEACON=0)');
  } else {
    // Targets follow BIND, so the hub only ever advertises addresses it serves.
    const b = discovery.startBeacon(hubId, PORT, { bind: BIND });
    console.log(`[hub] discovery beacon on udp/${b.port} → ${b.targets.join(', ')}`);
  }
  if (!process.env.HUB_SEED) {
    console.log('[hub] no HUB_SEED: this hub\'s DID changes on every restart, ' +
      'so agents pinning it (hubPin) must be reconfigured after a restart');
  }
  startAutoDump();
  if (CANARY_DID) {
    console.log(`[hub] canary issuer authorised: ${CANARY_DID} ` +
      '(may spend Treasury on decoy tasks)');
  }
});
