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
        genIdentity, sign, net } = require('./lib/wire');
const eeff = require('./lib/eeff');
const discovery = require('./lib/discovery');
const panel = require('./lib/panel');

const PORT = Number(process.env.HUB_PORT || 47180);
const BIND = process.env.HUB_BIND || '127.0.0.1'; // 0.0.0.0 for LAN pilots
const TREASURY = 'protocol:treasury';
const INSURANCE = 'protocol:insurance';

const hubId = genIdentity(); // signs checkpoints
const settledIds = new Set(); // contract_id idempotency keys
const agents = new Map();    // did -> {pub, boxPub, sock, stats, role}
const balances = new Map();
const receipts = [];         // {kind:'dual'|'forced', receipt, sigs, evidence?}
const chains = new Map();    // account -> [{seq,prev_hash,receipt_idx,delta_cc,balance_after,hash}]
const checkpoints = [];
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
  const prev = chain.at(-1);
  const entry = {
    account,
    seq: chain.length,
    prev_hash: prev ? prev.hash : sha256(account),
    receipt_idx: receiptIdx,
    delta_cc: delta,
    balance_after: +(bal(account)).toFixed(6),
  };
  entry.hash = sha256(canon(entry));
  chain.push(entry);
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
  settledIds.add(receipt.contract_id);
  const cp = makeCheckpoint();
  console.log(`[hub] SETTLED(${kind}) ${receipt.contract_id}: ` +
    receipt.postings.map((p) => `${p.account.slice(0, 18)}=${p.amount_cc.toFixed(2)}`)
      .join(' ') + ` | checkpoint#${cp.seq} ${cp.root.slice(0, 12)}`);
  broadcast({ type: 'settled', receipt, kind });
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
          stats: prior ? prior.stats : eeff.newStats(),
          role: msg.role || 'agent',
        });
        balances.set(msg.did, bal(msg.did));
        sendLine(sock, { type: 'registered', did: msg.did,
                         credit_line: clOf(msg.did), fee_rate: eeff.FEE_RATE });
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
      case 'export': {
        sendLine(sock, {
          type: 'ledger_export',
          receipts,
          pubkeys: Object.fromEntries([...agents].map(([d, a]) => [d, a.pub])),
          balances: Object.fromEntries(balances),
          credit_lines: Object.fromEntries(
            [...agents].filter(([, a]) => a.role === 'agent')
              .map(([d]) => [d, clOf(d)])),
          chains: Object.fromEntries(chains),
          checkpoints,
          hub_pub: hubId.pub,
          raw_log: rawLog.join('\n'),
        });
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
    `starter CL ${eeff.STARTER_CC}, fee ${eeff.FEE_RATE * 100}%, ` +
    `risk ${eeff.RISK_THIN * 100}%/${eeff.RISK_BASE * 100}%, hash-chained + checkpointed`);
  if (process.env.HUB_BEACON === '0') {
    console.log('[hub] discovery beacon disabled (HUB_BEACON=0)');
  } else {
    // Targets follow BIND, so the hub only ever advertises addresses it serves.
    const b = discovery.startBeacon(hubId, PORT, { bind: BIND });
    console.log(`[hub] discovery beacon on udp/${b.port} → ${b.targets.join(', ')}, ` +
      `hub did ${discovery.didOf(hubId.pub)}`);
  }
});
