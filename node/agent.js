// Local Agent Node (Phase 1). One OS process per Owner device.
//
// This round: dual-signed contracts with a verifier panel locked at award
// time (FR-041), requester pre_authorization ("quorum PASS ⇒ settle"),
// judge-quorum acceptance via the DSL, forced settlement when a requester
// refuses to pay (T-05), and a minimal read-only Owner Console.
//
// Config: AGENT_CONFIG env (JSON) or `node agent.js <config.json>`:
// { name, hubPort, hubHost?, consolePort?,
//   adapter: {baseUrl, model, key:{service, env}} | null,
//   provide: {afterMs, pricePerUnit, repayment?} | null,
//   refuseToSettle?: bool,   // demo: act as a malicious non-payer
//   posts: [{atMs, units, maxPriceCC, payload,
//            acceptance: 'dsl-local'|'judge-quorum', asserts:[...]}] }
'use strict';
const http = require('node:http');
const { genIdentity, identityFromSeed, sign, verify, sha256, canon, connect,
        PROTOCOL_VERSION } = require('./lib/wire');
const transport = require('./lib/transport').fromEnv();
require('./lib/log').install();
const { genBoxKeys, seal, open } = require('./lib/e2e');
const { runAsserts, assertsHash } = require('./lib/dsl');
const keystore = require('./lib/keystore');
const discovery = require('./lib/discovery');
const strategy = require('./lib/strategy');
const demand = require('./lib/demand');
const panelLib = require('./lib/panel');
const adapter = require('./adapter');

const cfg = process.env.AGENT_CONFIG
  ? JSON.parse(process.env.AGENT_CONFIG)
  : JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
// §4 #17 / W10「帳本匯出重建」的前半：一個會活過重啟的身分。
// Without it every restart abandoned whatever the old DID held — this pilot
// left a +16.52 CC balance nobody can ever spend and a -10 CC debt nobody
// will ever repay, both belonging to identities that no longer exist. It is
// also the precondition for the ledger half: rebuilding a ledger whose
// account holders have all changed DIDs reconstructs balances for people who
// are not there.
//
// The hub already reuses an agent's stats when the same DID re-registers
// (§4 #35), so a stable DID keeps the credit-line history too, not just the
// balance.
const id = cfg.seed ? identityFromSeed(cfg.seed) : genIdentity();
const box = genBoxKeys();
const log = (m) => console.log(`[${cfg.name} ${id.did}] ${m}`);

const adapterCfg = cfg.adapter ? {
  baseUrl: cfg.adapter.baseUrl, model: cfg.adapter.model,
  apiKey: keystore.getKey(cfg.adapter.key),
  // Carried through to the adapter, which refuses third-party work on a real
  // upstream without an attested declaration (§4 #67).
  terms: cfg.adapter.terms || null,
  attribution: cfg.adapter.attribution || 'user',
} : null;

let providing = false;
let verifierDir = { verifiers: [], lock: null };
const pendingBids = new Map();   // task_id -> {task, post, bids, timer}
const asRequester = new Map();   // contract_id -> {contract, payload, panel, attest:[], done}
const asProvider = new Map();    // contract_id -> {contract, contract_sigs, pre_auth, pre_auth_sig, output, attest:[], timer, settled}
const bidUnits = new Map();     // task_id -> units bid on, to spend quota on award
const pendingFees = new Map();   // contract_id -> {role, provider, delivery_hash, output}
const console_ = { balance: 0, creditLine: 0, settled: [],
                   autoPosts: 0, manualPosts: 0, scriptedPosts: 0,
                   withheld: [], forks: 0 };
let mode = 'normal';
const repayTracker = strategy.newTracker();

// FR-055 / UC-02: recompute the target band from the live credit line and
// switch strategy when the balance leaves it. Called after registration and
// after every settlement or credit update.
function refreshMode(why) {
  const band = strategy.bandFor(cfg, console_.creditLine);
  const next = strategy.modeFor(console_.balance, band);
  if (next === mode) return;
  const closed = strategy.trackTransition(repayTracker, next);
  mode = next;
  log(`strategy → ${mode} (balance ${console_.balance.toFixed(2)} CC, ` +
      `band [${band.low.toFixed(2)}, ${band.high}], ${why})` +
      (closed !== null ? ` — repaid in ${(closed / 1000).toFixed(1)}s` : '') +
      (mode === 'repay'
        ? `; supply discounted ${strategy.REPAY_DISCOUNT * 100}%, non-essential posts paused`
        : ''));
}

// Roots of checkpoints as the hub mints them. A panel's seed is a checkpoint
// that does not exist when the contract is signed (§4 #6), so selection waits
// for it to arrive.
const cpRoots = new Map();      // seq -> root
// #69c：把自己見到的最新 (seq, root) 附在既有的對等訊息上，收到的一方與自己
// 的比對。單獨的 cpRoots 不夠用——它把 checkpoint_request 的回答（可能是更早
// 的條目）記在被問的 seq 上，兩個誠實節點因此可以對同一個 seq 持有不同 root，
// 拿來比對會產生假分叉。cpwatch 把兩者分開，只比廣播來的。
const cpw = require('./lib/cpwatch').create(log);
const pendingPanel = new Map(); // contract_id -> () => void

// FR-041 with the §2.2 fix: the pool is pinned at contract time, the
// selection is deferred to a future checkpoint's root.
function panelFor(contractId, ctx) {
  const root = cpRoots.get(ctx.contract.panel_seed_cp);
  if (root === undefined) return null;
  const dids = new Set(panelLib.deriveDids(
    ctx.contract.verifier_pool, contractId, root));
  return ctx.pool.filter((v) => dids.has(v.did));
}

function requestSettlement(contractId, role, provider, output) {
  pendingFees.set(contractId, {
    role, provider, output, delivery_hash: sha256(output),
  });
  const price = role === 'forced'
    ? asProvider.get(contractId).contract.price_cc
    : asRequester.get(contractId).contract.price_cc;
  const requester = role === 'forced'
    ? asProvider.get(contractId).contract.requester : id.did;
  // The panel earns a share of every judge-quorum settlement (§4 #5), so the
  // quote needs its size. Derived from the contract's pinned pool and future
  // seed — the same rule the hub re-runs when it validates the receipt.
  const contract = role === 'forced'
    ? asProvider.get(contractId).contract
    : asRequester.get(contractId).contract;
  let panel = [];
  if (contract.acceptance.method === 'judge-quorum') {
    const seedRoot = cpRoots.get(contract.panel_seed_cp);
    if (seedRoot === undefined) {
      log(`settlement for ${contractId} deferred: seed checkpoint ` +
          `#${contract.panel_seed_cp} not seen yet`);
      pendingPanel.set(contractId,
        () => requestSettlement(contractId, role, provider, output));
      return;
    }
    panel = panelLib.deriveDids(contract.verifier_pool, contractId, seedRoot);
    // Pay the verifiers who actually revealed, not the whole derived panel.
    // #26 fixed the hub side — it refuses a receipt whose verifier postings
    // do not match the accountable attesters — but the requester kept
    // building postings for all three. With 2-of-3 quorum satisfied and one
    // verifier silent, every settlement was rejected with "verifier postings
    // 3 != accountable attesters 2", forever: one non-revealing verifier (a
    // crash, a dropped link, or malice) halted every contract it was
    // selected for. Found by the red team's silent-verifier case; no demo
    // covered it, because in all of them every verifier reveals.
    const ctx = role === 'forced' ? asProvider.get(contractId)
      : asRequester.get(contractId);
    const revealed = new Set((ctx.attest || [])
      .filter((a) => a.nonce && a.commitment &&
        sha256(canon(a.attestation) + a.nonce) === a.commitment)
      .map((a) => a.attestation.verifier));
    if (revealed.size >= 2) {
      const accountable = panel.filter((d) => revealed.has(d));
      if (accountable.length !== panel.length) {
        log(`paying ${accountable.length}/${panel.length} of the panel on ` +
            `${contractId}: the rest never revealed`);
      }
      panel = accountable;
    }
    // The evidence bundle must name exactly the verifiers being paid. Paying
    // a filtered set while attaching everything held made the hub count more
    // accountable attesters than there were postings, so it refused and the
    // provider forced the settlement instead — a `dual` silently became a
    // `forced`. The set is decided once, here, and both halves read it.
    ctx.payPanel = panel;
  }
  pendingFees.get(contractId).contract = contract;
  hub.send({ type: 'fee_quote', contract_id: contractId, requester, price, panel });
}

// hubHost: "discover" opts into the UDP beacon (lib/discovery.js) instead of
// a hand-copied IP. Any other value, including absent, keeps the previous
// behaviour exactly — existing configs and demo.js are unaffected.
// Send the verify request to each selected verifier. The payload is sealed
// per verifier, so the panel can check the work without the hub or anyone
// else seeing it (NFR-005).
// Ask the panel to open their commitments. Fires when everyone has
// committed, or on the grace timer with whatever quorum exists.
function requestReveal(contractId, why = 'quorum') {
  const ctx = asRequester.get(contractId);
  if (!ctx || ctx.revealed || !ctx.panel) return;
  if (!ctx.commits || ctx.commits.size < 2) {
    // Not a failure yet: the grace timer may simply have fired before
    // cross-machine commitments landed. Record that the window has passed so
    // the commit handler can reveal the moment a quorum exists, instead of
    // waiting for the full panel that may never complete. Giving up here left
    // 16 contracts stalled on the live pilot — localhost demos never saw it,
    // because local commitments always beat the 1.5s window.
    log(`reveal deferred on ${contractId}: ${ctx.commits ? ctx.commits.size : 0} ` +
        'commitments so far, waiting for a quorum');
    return;
  }
  ctx.revealed = true;
  clearTimeout(ctx.revealTimer);
  const body = { contract_id: contractId, reveal: true };
  const sig = sign(id.privateKey, body);
  for (const v of ctx.panel) {
    if (!ctx.commits.has(v.did)) continue;
    hub.send({ type: 'reveal_request', to: v.did, contract_id: contractId,
               requester: id.did, provider: ctx.contract.provider, sig, pub: id.pub });
  }
  log(`reveal requested on ${contractId} (${ctx.commits.size} commitments, ${why})`);
}

// The award itself is a handshake and needs the same treatment as
// registration (#49): resend the contract until the provider acknowledges it.
// Without this, a single lost `contract` frame means the provider never
// learns it won and the requester waits for a delivery that cannot come.
function armSeedTimeout(contractId, seq) {
  const ctx = asRequester.get(contractId);
  if (!ctx) return;
  clearTimeout(ctx.seedTimer);
  ctx.seedTimer = setTimeout(() => {
    if (ctx.done || !pendingPanel.has(contractId)) return;
    ctx.seedAttempts = (ctx.seedAttempts || 0) + 1;
    if (ctx.seedAttempts > SEED_RETRIES) {
      pendingPanel.delete(contractId);
      ctx.done = true;
      ctx.abandoned = true;
      console_.abandoned = (console_.abandoned || 0) + 1;
      log(`ABANDONING ${contractId}: seed checkpoint #${seq} never arrived`);
      return;
    }
    log(`seed checkpoint #${seq} for ${contractId} not seen — asking the hub ` +
        `(${ctx.seedAttempts}/${SEED_RETRIES})`);
    hub.send({ type: 'checkpoint_request', seq });
    armSeedTimeout(contractId, seq);
  }, SEED_TIMEOUT_MS);
}

function armAwardTimeout(contractId, contract, pre_auth, provider) {
  const ctx = asRequester.get(contractId);
  if (!ctx) return;
  clearTimeout(ctx.awardTimer);
  ctx.awardTimer = setTimeout(() => {
    if (ctx.done || ctx.contract_sigs.provider) return;
    ctx.awardAttempts = (ctx.awardAttempts || 0) + 1;
    if (ctx.awardAttempts > AWARD_RETRIES) {
      ctx.done = true;
      ctx.abandoned = true;
      console_.abandoned = (console_.abandoned || 0) + 1;
      log(`ABANDONING ${contractId}: provider never acknowledged the award`);
      return;
    }
    log(`no contract_ack for ${contractId} — resending the award ` +
        `(${ctx.awardAttempts}/${AWARD_RETRIES})`);
    hub.send({ type: 'contract', to: provider, contract,
               sig: sign(id.privateKey, contract), pub: id.pub,
               pre_auth, pre_auth_sig: sign(id.privateKey, pre_auth) });
    armAwardTimeout(contractId, contract, pre_auth, provider);
  }, AWARD_TIMEOUT_MS);
}

// AWARDED→DELIVERED had no timeout, so a delivery lost in transit left the
// contract open forever with the work already done. Ask for a resend before
// giving up: under loss a retry is usually all that is needed.
function armDeliveryTimeout(contractId, provider) {
  const ctx = asRequester.get(contractId);
  if (!ctx) return;
  clearTimeout(ctx.deliverTimer);
  ctx.deliverTimer = setTimeout(() => {
    if (ctx.done || ctx.output) return;
    ctx.deliverAttempts = (ctx.deliverAttempts || 0) + 1;
    if (ctx.deliverAttempts <= DELIVER_RETRIES) {
      log(`no delivery for ${contractId} after ${DELIVER_TIMEOUT_MS}ms — ` +
          `asking the provider to resend (${ctx.deliverAttempts}/${DELIVER_RETRIES})`);
      hub.send({ type: 'delivery_request', to: provider, contract_id: contractId });
      armDeliveryTimeout(contractId, provider);
      return;
    }
    ctx.done = true;
    ctx.abandoned = true;
    noteProvider(provider, 'failed');
    console_.abandoned = (console_.abandoned || 0) + 1;
    log(`ABANDONING ${contractId}: no delivery after ` +
        `${DELIVER_RETRIES + 1} attempts`);
  }, DELIVER_TIMEOUT_MS);
}

function armVerifyTimeout(contractId, ctx) {
  clearTimeout(ctx.verifyTimer);
  ctx.verifyTimer = setTimeout(() => {
    if (ctx.done) return;
    const passes = (ctx.attest || [])
      .filter((a) => a.attestation.verdict === 'PASS').length;
    if (passes >= 2) return;            // the settlement path owns it now
    ctx.verifyAttempts = (ctx.verifyAttempts || 0) + 1;
    if (ctx.verifyAttempts <= VERIFY_RETRIES && ctx.fanOut) {
      log(`no quorum on ${contractId} after ${VERIFY_TIMEOUT_MS}ms — ` +
          `resending verify_request (${ctx.verifyAttempts}/${VERIFY_RETRIES})`);
      fanOut(ctx.fanOut.delivery, ctx, ctx.fanOut.chosen);
      return;
    }
    ctx.done = true;
    ctx.abandoned = true;
    console_.abandoned = (console_.abandoned || 0) + 1;
    log(`ABANDONING ${contractId}: no quorum after ${VERIFY_RETRIES + 1} ` +
        'attempts. The provider did the work and will not be paid — the ' +
        'panel is derived from a pinned pool, so a retry reaches the same ' +
        'verifiers. A re-seeded backup panel (§2.3) needs hub support.');
  }, VERIFY_TIMEOUT_MS);
}

function fanOut(delivery, ctx, chosen) {
  ctx.fanOut = { delivery, chosen };   // so a retry can repeat exactly this
  armVerifyTimeout(delivery.contract_id, ctx);
  for (const v of chosen) {
    const request = {
      contract_id: delivery.contract_id, requester: id.did,
      provider: delivery.provider, output: delivery.output,
      asserts: ctx.asserts,
      asserts_hash: ctx.contract.acceptance.asserts_hash,
      panel_seed_cp: ctx.contract.panel_seed_cp,
      payload_box: seal(v.box_pub, ctx.payload),
    };
    hub.send({ type: 'verify_request', to: v.did, request,
               sig: sign(id.privateKey, request), pub: id.pub });
  }
}

const regBody = { did: id.did, pub: id.pub, box_pub: box.boxPub };

// #69c：所有帶 `to` 的訊息（也就是經 Hub 轉發給對等節點的那些）都附上自己
// 見到的最新 checkpoint。放在這一層而不是逐個 case 改，是因為漏掉任何一種
// 訊息就等於在那條路徑上沒有偵測；而且 `cp` 掛在信封上、不進簽署本體，所以
// 不影響任何既有簽章。
function stampPeerSends(conn) {
  const raw = conn.send.bind(conn);
  conn.send = (m) => {
    if (m && m.to) {
      const cp = cpw.stamp();
      if (cp) return raw({ ...m, cp });
    }
    return raw(m);
  };
  return conn;
}

const hub = stampPeerSends(transport.dialLazy(() => discovery.resolveHubTarget(cfg, log), {
  // Re-sent on every connection: the hub cannot route to a DID whose
  // channel it does not know, and re-registering resumes the balance and
  // stats this identity already had (#35) rather than starting over.
  onOpen: () => {
    hub.send({ type: 'register', ...regBody, sig: sign(id.privateKey, regBody) });
    // The pool and the checkpoint lock moved while we were away.
    hub.send({ type: 'list_verifiers' });
  },
  label: cfg.name || 'agent',
  // Registration is a handshake, not a broadcast: retried until the hub
  // answers, because one lost frame used to leave a live but anonymous
  // connection that nothing ever noticed.
  ackType: 'registered',
  onMessage: async (msg) => {
    // #69c：對等訊息帶著送出方見到的最新 (seq, root)。比對只在雙方都見過
    // 同一個 seq 時才有意義——落後不是分叉。偵測到不否決任何東西，只是讓
    // 排序器對兩個人講不同故事這件事不再隱形。
    // `checkpoint` 自己的頂層 cp 是 Hub 的 checkpoint 而不是對等戳記，
    // 要排除——否則比對的是自己跟自己（第一版就這樣寫了）。
    if (msg.cp && msg.type !== 'checkpoint') {
      const why = cpw.check(msg.cp, `${msg.type} sender`);
      if (why) console_.forks = cpw.forkCount();
    }
    switch (msg.type) {
      case 'registered':
        // The hub cannot tell a healthy client from one that only
        // talks unless the client proves it heard the reply (#49).
        hub.send({ type: 'register_ack', did: id.did });  // proof we can hear (#49)
        console_.creditLine = msg.credit_line;
        // Adopt the hub's view rather than assuming a fresh start: a seeded
        // identity that restarts still owes what it owed (§4 #17).
        if (typeof msg.balance_cc === 'number') {
          console_.balance = msg.balance_cc;
          console_.resumedFrom = { balance_cc: msg.balance_cc,
                                   settlements: msg.settlements || 0 };
        }
        log(`registered, dynamic credit line ${msg.credit_line.toFixed(1)} CC` +
            (msg.balance_cc ? `, resuming at ${msg.balance_cc.toFixed(2)} CC ` +
              `after ${msg.settlements || 0} prior settlements` : ''));
        refreshMode('registered');
        break;

      case 'collateral':
      console_.collateral = { locked_cc: msg.locked_cc, ltv: msg.ltv };
      console_.creditLine = msg.credit_line;
      log(`collateral now ${msg.locked_cc} CC (LTV ${msg.ltv}), ` +
          `credit line ${msg.credit_line.toFixed(1)} CC`);
      break;

    case 'credit_update':
        console_.creditLine = msg.credit_line;
        refreshMode('credit line moved');
        break;

      case 'verifiers': verifierDir = msg; break;

      case 'checkpoint': {
        cpRoots.set(msg.cp.seq, msg.cp.root);
        // 廣播沒有 for_seq；有 for_seq 的是 checkpoint_request 的回答，
        // 那個 root 可能屬於更早的條目，不可拿來跨節點比對（#69c）。
        cpw.observe(msg.cp.seq, msg.cp.root, typeof msg.for_seq !== 'number');
        // The hub stores checkpoints sparsely (#41): a root requested for
        // seq N may arrive as the entry at or before N, so record it under
        // the seq that was asked for as well.
        if (typeof msg.for_seq === 'number' && msg.cp.seq <= msg.for_seq) {
          cpRoots.set(msg.for_seq, msg.cp.root);
          cpw.observe(msg.for_seq, msg.cp.root, false);
        }
        for (const [cid, release] of [...pendingPanel]) {
          const ctx = asRequester.get(cid);
          if (ctx && cpRoots.has(ctx.contract.panel_seed_cp)) {
            pendingPanel.delete(cid);
            release();
          }
        }
        break;
      }

      case 'task': {
        if (!providing) break;
        // Quota is the thing being sold. Bidding without checking it offers
        // capacity the agent does not have — the simulator's collect_offers has
        // always gated on remaining_quota and this side never did.
        if (console_.quota && console_.quota.remaining < msg.task.units) {
          break;
        }
        const unitPrice = strategy.priceFor(cfg.provide.pricePerUnit, mode);
        // A task past its own expiry gets no bid: bidding on it would produce
        // a contract the requester must refuse, which is worse than silence.
        if (msg.task.expires_at && Date.now() > msg.task.expires_at) {
          log(`ignoring expired task ${msg.task.task_id}`);
          break;
        }
        const bid = {
          task_id: msg.task.task_id, provider: id.did,
          price_cc: +(msg.task.units * unitPrice).toFixed(4),
          box_pub: box.boxPub,
          issued_at: Date.now(),
          expires_at: Date.now() + BID_TTL_MS,
        };
        bidUnits.set(bid.task_id, msg.task.units);
        hub.send({ type: 'bid', to: msg.task.requester, bid,
                   sig: sign(id.privateKey, bid), pub: id.pub });
        log(`bid ${bid.price_cc} CC on ${msg.task.task_id}` +
          (mode === 'repay' ? ` (repayment discount, ${unitPrice}/unit)` : ''));
        break;
      }

      case 'bid': {
        const p = pendingBids.get(msg.bid.task_id);
        if (!p || !verify(msg.pub, msg.bid, msg.sig)) break;
        if (msg.bid.price_cc <= p.task.max_price_cc) {
          p.bids.push({ ...msg.bid, pub: msg.pub });
        }
        // Wait a little longer for the rest of the field, bounded by the
        // deadline, so a slow link does not decide the auction.
        if (p.timer && p.fire) {
          clearTimeout(p.timer);
          const wait = Math.min(BID_QUIET_MS, Math.max(0, p.deadline - Date.now()));
          p.timer = setTimeout(p.fire, wait);
        }
        break;
      }

      case 'contract': { // I'm awarded: countersign, unseal, execute
        const c = msg.contract;
        if (!verify(msg.pub, c, msg.sig)) break;
        // A retried award must be acknowledged, never executed twice: the
        // requester resends the contract until it sees an ack, because one
        // lost frame otherwise leaves it waiting for a delivery from a
        // provider that never heard it was awarded.
        const already = asProvider.get(c.contract_id);
        if (already) {
          hub.send({ type: 'contract_ack', to: c.requester,
                     contract_id: c.contract_id,
                     sig: already.contract_sigs.provider, pub: id.pub });
          if (already.delivery) {
            hub.send({ type: 'delivery', to: c.requester,
                       delivery: already.delivery, sig: already.deliverySig,
                       pub: id.pub });
          }
          break;
        }
        const mySig = sign(id.privateKey, c);
        hub.send({ type: 'contract_ack', to: c.requester,
                   contract_id: c.contract_id, sig: mySig });
        const payload = open(box.boxPriv, c.payload_box);
        const soldUnits = bidUnits.get(c.contract_id.replace(/^c-/, '')) || 0;
        if (console_.quota && soldUnits) {
          console_.quota.remaining =
            +(console_.quota.remaining - soldUnits).toFixed(3);
          console_.quota.soldUnits =
            +((console_.quota.soldUnits || 0) + soldUnits).toFixed(3);
        }
        log(`awarded ${c.contract_id} @ ${c.price_cc} CC (contract dual-signed, ` +
            `pool ${(c.verifier_pool || []).length}, panel seeded from ` +
            `checkpoint #${c.panel_seed_cp}) — executing locally` +
            (soldUnits ? `, ${soldUnits}u quota spent` : ''));
        let output;
        try {
          // The requester's DID is the end-user identifier upstream: this
          // call is not our own work, and a provider's abuse report has to be
          // traceable back to a contract in our own ledger (§4 #67).
          output = await adapter.complete(adapterCfg, payload,
            { endUser: c.requester, contractId: c.contract_id });
        } catch (err) {
          // This handler is async, so a throw here escapes as an unhandled
          // rejection and kills the process mid-contract — a real provider
          // endpoint returning 500 was enough to do it.
          log(`execution FAILED on ${c.contract_id}: ${err.message} — ` +
              'no delivery will be sent; the requester may force-settle');
          asProvider.set(c.contract_id, {
            contract: c, contract_sigs: { requester: msg.sig, provider: mySig },
            pre_auth: msg.pre_auth, pre_auth_sig: msg.pre_auth_sig,
            output: null, attest: [], settled: false, failed: err.message,
            at: Date.now(),
          });
          break;
        }
        const provEntry = {
          contract: c, contract_sigs: { requester: msg.sig, provider: mySig },
          pre_auth: msg.pre_auth, pre_auth_sig: msg.pre_auth_sig,
          output, attest: [], settled: false, at: Date.now(),
        };
        // Mirror of the requester's timeout: without it a provider whose
        // panel never answered kept the contract open for the life of the
        // process, which is what the leak looked like from the supply side.
        provEntry.giveUp = setTimeout(() => {
          if (provEntry.settled) return;
          provEntry.failed = 'no quorum reached before the verify timeout';
          console_.abandoned = (console_.abandoned || 0) + 1;
          log(`giving up on ${c.contract_id}: no quorum before timeout — ` +
              'work delivered, not paid');
        }, VERIFY_TIMEOUT_MS * (VERIFY_RETRIES + 2));
        asProvider.set(c.contract_id, provEntry);
        const delivery = { contract_id: c.contract_id,
          output: cfg.corruptOutput ? `${output}-TAMPERED` : output,
          provider: id.did };
        // Kept so a lost delivery can be resent on request. Under 5% packet
        // loss the requester had no timeout for AWARDED→DELIVERED at all:
        // contracts sat open for 144s while the work was already done, and
        // the state machine requires every transition to have a timeout.
        provEntry.delivery = delivery;
        provEntry.deliverySig = sign(id.privateKey, delivery);
        // Adversary scaffolding, same rationale as refuseToSettle: a real
        // one does not volunteer for the test. neverDeliver takes the award
        // and goes quiet (threat 4, 收 credit 不做事); corruptOutput
        // delivers something the locked asserts cannot accept (threat 3).
        if (cfg.neverDeliver) {
          log(`ADVERSARY: awarded ${c.contract_id} and delivering nothing`);
          break;
        }
        hub.send({ type: 'delivery', to: c.requester, delivery,
                   sig: provEntry.deliverySig, pub: id.pub });
        break;
      }

      case 'delivery_request': { // requester never saw my delivery
        const p = asProvider.get(msg.contract_id);
        if (!p || !p.delivery) break;
        if (cfg.neverDeliver) break;   // adversary: stays quiet on resends too
        hub.send({ type: 'delivery', to: p.contract.requester,
                   delivery: p.delivery, sig: p.deliverySig, pub: id.pub });
        log(`resent delivery for ${msg.contract_id} on request`);
        break;
      }

      case 'contract_ack': { // provider countersigned
        const ctx = asRequester.get(msg.contract_id);
        if (ctx && verify(ctx.providerPub, ctx.contract, msg.sig)) {
          ctx.contract_sigs.provider = msg.sig;
          clearTimeout(ctx.awardTimer);
        }
        break;
      }

      case 'delivery': { // I'm the requester
        const d = msg.delivery;
        const ctx = asRequester.get(d.contract_id);
        if (!ctx || !verify(msg.pub, d, msg.sig)) break;
        clearTimeout(ctx.deliverTimer);
        if (ctx.output) break;            // a resend of what we already have
        noteProvider(d.provider, 'delivered');
        ctx.output = d.output;
        if (ctx.contract.acceptance.method === 'dsl-local') {
          const { pass, failures } = runAsserts(ctx.asserts,
            { payload: ctx.payload, output: d.output });
          if (!pass) { log(`REJECTED ${d.contract_id}: ${JSON.stringify(failures)}`); break; }
          log(`verified ${d.contract_id} via local DSL → settling`);
          requestSettlement(d.contract_id, 'requester', d.provider, d.output);
        } else { // judge-quorum: fan out to the future-seeded panel
          const dispatch = () => {
            const chosen = panelFor(d.contract_id, ctx);
            if (!chosen) { // still no seed; the checkpoint handler will retry
              pendingPanel.set(d.contract_id, dispatch);
              log(`delivery on ${d.contract_id} → waiting for seed ` +
                  `checkpoint #${ctx.contract.panel_seed_cp} before selecting a panel`);
              // Checkpoint broadcasts are fire-and-forget too, so a lost one
              // used to mean waiting forever: no panel, no verify timer, and
              // a contract that never closed. Ask for the root instead.
              armSeedTimeout(d.contract_id, ctx.contract.panel_seed_cp);
              return;
            }
            ctx.panel = chosen;
            ctx.commits = new Map();
            ctx.delivery = d;
            log(`delivery on ${d.contract_id} → panel selected from checkpoint ` +
                `#${ctx.contract.panel_seed_cp}: ${chosen.length} verifiers`);
            fanOut(d, ctx, chosen);
            // A verifier that never commits must not stall the contract, so
            // reveal on a quorum after a grace period.
            // Cross-machine commitments can take longer than a local round
            // trip, so the window is configurable and the timer only marks the
            // window closed — it never abandons the contract.
            const graceMs = (cfg.policy && cfg.policy.revealGraceMs) || 3000;
            ctx.revealTimer = setTimeout(() => {
              ctx.graceElapsed = true;
              requestReveal(d.contract_id, 'grace elapsed');
            }, graceMs);
          };
          dispatch();
        }
        break;
      }

      case 'attestation_commit': {
        const cid = msg.commit.contract_id;
        if (!verify(msg.pub, msg.commit, msg.sig)) break;
        for (const ctx of [asRequester.get(cid), asProvider.get(cid)]) {
          if (!ctx) continue;
          ctx.commits = ctx.commits || new Map();
          ctx.commits.set(msg.commit.verifier,
            { commitment: msg.commit.commitment, commit_sig: msg.sig, pub: msg.pub });
        }
        const reqC = asRequester.get(cid);
        // Only the requester drives the reveal; the provider just records
        // commitments so it can build a forced-settlement bundle.
        if (reqC && reqC.panel) {
          // Full panel: reveal at once. Past the grace window: reveal as soon
          // as a quorum exists, so a panel that never completes still settles.
          if (reqC.commits.size >= reqC.panel.length) {
            requestReveal(cid, 'full panel');
          } else if (reqC.graceElapsed && reqC.commits.size >= 2) {
            requestReveal(cid, 'quorum after grace');
          }
        }
        break;
      }

      case 'attestation': {
        const a = msg.attestation;
        // A reveal only counts if it opens the commitment this verifier made
        // before seeing anyone else's verdict.
        {
          const cid = a && a.contract_id;
          const ctx0 = asRequester.get(cid) || asProvider.get(cid);
          const held = ctx0 && ctx0.commits && ctx0.commits.get(a.verifier);
          if (held) {
            if (msg.nonce === undefined ||
                sha256(canon(a) + msg.nonce) !== held.commitment) {
              log(`REJECT reveal from ${a.verifier} on ${cid}: ` +
                  'does not open its commitment');
              break;
            }
            msg.commitment = held.commitment;
            msg.commit_sig = held.commit_sig;
          } else if (ctx0 && ctx0.contract &&
                     ctx0.contract.acceptance.method === 'judge-quorum') {
            log(`REJECT reveal from ${a.verifier} on ${cid}: no prior commitment`);
            break;
          }
        }
        const reqCtx = asRequester.get(a.contract_id);
        const provCtx = asProvider.get(a.contract_id);
        if (reqCtx) { // requester side: settle on 2-of-3 PASS (unless malicious)
          const v = reqCtx.panel.find((x) => x.did === a.verifier);
          if (!v || !verify(v.pub, a, msg.sig)) break;
          reqCtx.attest.push({ attestation: a, sig: msg.sig, pub: msg.pub,
                               nonce: msg.nonce, commitment: msg.commitment,
                               commit_sig: msg.commit_sig });
          const passes = reqCtx.attest.filter((x) => x.attestation.verdict === 'PASS').length;
          // Quorum is enough to settle, but settling the instant it is
          // reached punishes a verifier that reveals milliseconds later: it
          // did the work, quorum simply did not need it, and it now gets
          // nothing while the other two split its share. So wait out a short
          // grace for the rest of the panel — the same shape as #36's
          // commit-side grace — and settle early only once everyone has
          // revealed. A genuinely silent verifier costs one grace period,
          // and #58 still holds: it is not paid.
          const full = reqCtx.attest.length >= reqCtx.panel.length;
          if (passes >= 2 && !reqCtx.done && !full && !reqCtx.settleTimer) {
            const grace = (cfg.policy && cfg.policy.revealGraceMs) || 3000;
            reqCtx.settleTimer = setTimeout(() => {
              reqCtx.settleTimer = null;
              const ps = reqCtx.attest
                .filter((x) => x.attestation.verdict === 'PASS').length;
              if (ps >= 2 && !reqCtx.done) {
                reqCtx.done = true;
                clearTimeout(reqCtx.verifyTimer);
                if (cfg.refuseToSettle) {
                  log(`quorum PASS on ${a.contract_id} — REFUSING to settle (malicious demo)`);
                } else {
                  log(`quorum PASS on ${a.contract_id} (${reqCtx.attest.length}/` +
                      `${reqCtx.panel.length} revealed after grace) → settling`);
                  requestSettlement(a.contract_id, 'requester',
                    reqCtx.contract.provider, reqCtx.output);
                }
              }
            }, grace);
            break;
          }
          if (passes >= 2 && !reqCtx.done) {
            reqCtx.done = true;
            clearTimeout(reqCtx.settleTimer);
            reqCtx.settleTimer = null;
            clearTimeout(reqCtx.verifyTimer);
            if (cfg.refuseToSettle) {
              log(`quorum PASS on ${a.contract_id} — REFUSING to settle (malicious demo)`);
            } else {
              log(`quorum PASS on ${a.contract_id} → settling`);
              requestSettlement(a.contract_id, 'requester',
                reqCtx.contract.provider, reqCtx.output);
            }
          }
        }
        if (provCtx) { // provider side: arm forced settlement (T-05)
          // The panel is no longer on the contract, so check membership against
          // the same future-seeded derivation the hub will re-run. Without the
          // seed root yet, hold the attestation: the hub would reject it anyway.
          const seedRoot = cpRoots.get(provCtx.contract.panel_seed_cp);
          if (seedRoot === undefined) break;
          if (!panelLib.deriveDids(provCtx.contract.verifier_pool,
                a.contract_id, seedRoot).includes(a.verifier)) break;
          if (!verify(msg.pub, a, msg.sig)) break;
          provCtx.attest.push({ attestation: a, sig: msg.sig, pub: msg.pub,
                                nonce: msg.nonce, commitment: msg.commitment,
                                commit_sig: msg.commit_sig });
          const passes = provCtx.attest.filter((x) => x.attestation.verdict === 'PASS').length;
          if (passes >= 2 && !provCtx.timer && !provCtx.settled) {
            provCtx.timer = setTimeout(() => {
              if (provCtx.settled) return;
              log(`no settlement for ${a.contract_id} after quorum PASS → ` +
                  `FORCING with pre_auth + attestations`);
              requestSettlement(a.contract_id, 'forced', id.did, provCtx.output);
            }, FORCE_AFTER_MS);
          }
        }
        break;
      }

      case 'fee_terms': {
        const pf = pendingFees.get(msg.contract_id);
        if (!pf) break;
        const { fee, risk, price } = msg;
        const shares = msg.verifier_shares || [];
        const verifierTotal = shares.reduce((t, x) => +(t + x).toFixed(4), 0);
        const c = pf.contract;
        const receipt = {
          contract_id: msg.contract_id,
          requester: msg.requester,
          provider: pf.provider,
          delivery_hash: pf.delivery_hash,
          // Carried so the hub can re-derive the panel from a signed artifact
          // instead of trusting a payee list, and so the receipt is
          // self-contained for offline audit.
          acceptance_method: c.acceptance.method,
          // §20-9 / FR-083: test, subsidy and related-party trade must be
          // separable from real trade, or every market metric is a mix of
          // things that mean different things. Declared by the requester,
          // carried in the signed receipt, and checked by the hub — which
          // can only verify what it can observe, see the honesty note in
          // §4 #63.
          tx_class: (cfg.txClass) ||
            (cfg.relatedTo && cfg.relatedTo.includes(pf.provider)
              ? 'related-party' : 'market'),
          verifier_pool: c.verifier_pool || [],
          verifier_pool_hash: c.verifier_pool_hash || null,
          panel_seed_cp: c.panel_seed_cp,
          postings: [
            { account: msg.requester, amount_cc: -price },
            { account: pf.provider,
              amount_cc: +(price - fee - risk - verifierTotal).toFixed(4) },
            { account: 'protocol:treasury', amount_cc: fee },
            { account: 'protocol:insurance', amount_cc: risk },
            ...(msg.panel || []).map((did, i) => ({ account: did, amount_cc: shares[i] })),
          ],
        };
        if (pf.role === 'requester') {
          hub.send({ type: 'receipt_half', to: pf.provider, receipt,
                     sig: sign(id.privateKey, receipt), pub: id.pub });
        } else { // forced: evidence package instead of requester signature
          const e = asProvider.get(msg.contract_id);
          hub.send({
            type: 'forced_settlement', receipt,
            provider_sig: sign(id.privateKey, receipt),
            evidence: {
              contract: e.contract, contract_sigs: e.contract_sigs,
              pre_auth: e.pre_auth, pre_auth_sig: e.pre_auth_sig,
              attestations: (e.attest || []).filter((a) =>
                !e.payPanel || e.payPanel.includes(a.attestation.verifier)),
            },
          });
        }
        break;
      }

      case 'receipt_half': { // provider countersigns a voluntary receipt
        const r = msg.receipt;
        const mine = r.postings.find((p) => p.account === id.did);
        const total = r.postings.reduce((s, p) => s + p.amount_cc, 0);
        if (!verify(msg.pub, r, msg.sig) || !mine || mine.amount_cc <= 0 ||
            Math.abs(total) > 1e-9) break;
        const pc = asProvider.get(r.contract_id);
        hub.send({ type: 'receipt', receipt: r,
                   sigs: { requester: msg.sig, provider: sign(id.privateKey, r) },
                   // §4 #26: the hub pays the verifiers that actually revealed a
                   // verdict, so it needs the bundle, not just the receipt.
                   // Exactly the verifiers this receipt pays. The receipt
                   // itself is the source of truth — the countersigning
                   // provider has no view of which of them revealed in time,
                   // and attaching more than are paid makes the hub count
                   // more accountable attesters than there are postings and
                   // refuse the settlement.
                   attestations: (pc ? pc.attest : []).filter((a) =>
                     r.postings.some((x) => x.account === a.attestation.verifier
                       && x.amount_cc > 0)) });
        log(`countersigned ${r.contract_id} → submitted`);
        break;
      }

      case 'settled': {
        const me = msg.receipt.postings.find((p) => p.account === id.did);
        const provCtx = asProvider.get(msg.receipt.contract_id);
        if (provCtx) {
          provCtx.settled = true;
          clearTimeout(provCtx.timer);
          clearTimeout(provCtx.giveUp);
        }
        if (me) {
          console_.balance = +(console_.balance + me.amount_cc).toFixed(4);
          console_.settled.push({ contract_id: msg.receipt.contract_id,
                                  kind: msg.kind, delta_cc: me.amount_cc });
          log(`settled(${msg.kind}) ${msg.receipt.contract_id}: my delta ${me.amount_cc.toFixed(2)} CC`);
          refreshMode('settled');
        }
        break;
      }

      case 'error': log(`hub error: ${msg.why} (${msg.ref})`); break;
    }
  },
}));


console.log(`DID ${cfg.name} ${id.did} (protocol v${PROTOCOL_VERSION})`);

// minimal Owner Console (§9.9 / FR-081): GET /status for state,
// POST /post to manually publish a task (two-machine pilots).
// Localhost-only on purpose — this is the Owner's own control surface.
if (cfg.consolePort) {
  http.createServer((req, res) => {
    // 抵押品是 Owner 的決策而不是 agent 的自主行為（FR-081）：把自己的
    // 正餘額鎖起來換額度上限，是要不要承擔風險的判斷，不該由需求模型代勞。
    if (req.method === 'POST' && req.url === '/collateral') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        try {
          const { amount_cc, lock = true } = JSON.parse(body);
          if (!(Number(amount_cc) > 0)) throw new Error('amount_cc must be > 0');
          const sig = sign(id.privateKey,
            { did: id.did, amount_cc: Number(amount_cc), lock: !!lock });
          hub.send({ type: lock ? 'collateral_post' : 'collateral_release',
                     did: id.did, amount_cc: Number(amount_cc), sig });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, requested: amount_cc, lock }));
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/post') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        try {
          const post = JSON.parse(body);
          if (!post.acceptance || !Array.isArray(post.asserts)) {
            throw new Error('post needs acceptance + asserts (FR-011)');
          }
          console_.manualPosts += 1;   // Owner Console / MCP — attended
          const taskId = postTask(post);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, task_id: taskId }));
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }
    // GET /result?contract_id=... — the accepted output of a task this agent
    // requested, so the MCP entry point (§23.1) can hand work back to the
    // Owner's own agent once it has passed acceptance and settled.
    if (req.url.startsWith('/result')) {
      const want = new URL(req.url, 'http://127.0.0.1').searchParams
        .get('contract_id');
      const ctx = want && asRequester.get(want);
      const settled = console_.settled.find((x) => x.contract_id === want);
      res.writeHead(ctx ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ctx
        ? { contract_id: want, output: ctx.output ?? null,
            settled: !!settled, delta_cc: settled ? settled.delta_cc : null,
            provider: ctx.contract && ctx.contract.provider }
        : { error: 'unknown contract_id' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    const band = strategy.bandFor(cfg, console_.creditLine);
    res.end(JSON.stringify({
      name: cfg.name, did: id.did,
      balance_cc: console_.balance,
      credit_line_cc: console_.creditLine,
      settled: console_.settled,
      // #69c：這個節點從對等節點的戳記中發現的 checkpoint 分叉。0 是正常，
      // 非 0 表示排序器對不同節點講了不同的故事——Owner 必須看得到。
      checkpoint_forks: cpw.forkCount(),
      checkpoint_fork_detail: cpw.forks().slice(-3),
      // FR-055 strategy state + §20-10 平均還債時間
      strategy: {
        mode,
        target_band_cc: [band.low, band.high],
        supply_price_per_unit: cfg.provide
          ? strategy.priceFor(cfg.provide.pricePerUnit, mode) : null,
        repay_episodes: repayTracker.episodes.length,
        avg_repayment_ms: strategy.avgRepaymentMs(repayTracker),
        in_repayment_since: repayTracker.since,
        paused_posts: pausedPosts.length,
      },
      // Open contracts and how long they have been open. A blackholed link
      // produces contracts that can never settle (#46); nothing used to
      // measure whether any were stuck, so an invariant had nothing to read.
      contracts: (() => {
        const open = [
          ...[...asRequester.values()].filter((c) => !c.done),
          ...[...asProvider.values()].filter((c) => !c.settled && !c.failed),
        ];
        const now = Date.now();
        return {
          open: open.length,
          abandoned: console_.abandoned || 0,
          as_requester_open: [...asRequester.values()].filter((c) => !c.done).length,
          as_provider_open: [...asProvider.values()]
            .filter((c) => !c.settled && !c.failed).length,
          oldest_open_ms: open.length
            ? Math.max(...open.map((c) => now - (c.at || now))) : 0,
        };
      })(),
      collateral: console_.collateral || { locked_cc: 0, ltv: null },
      resumed_from: console_.resumedFrom || null,
      // §20-8: publishes that required a human, versus ones the policy made
      // on its own. An unattended run must show manual + scripted == 0.
      publishing: {
        auto_posts: console_.autoPosts,
        manual_posts: console_.manualPosts,
        scripted_posts: console_.scriptedPosts,
        withheld: console_.withheld,
      },
      quota: console_.quota ? {
        capacity_units: console_.quota.capacity,
        remaining_units: console_.quota.remaining,
        cycles: console_.quota.cycles,
        consumed_units: console_.quota.consumedUnits,
        expired_units: console_.quota.expiredUnits,
        shortfall_units: console_.quota.shortfallUnits,
        sold_units: console_.quota.soldUnits || 0,
        exhaustions: console_.quota.exhaustions,
      } : null,
    }));
  }).listen(cfg.consolePort, '127.0.0.1',
    () => log(`owner console on http://127.0.0.1:${cfg.consolePort}/status`));
}

// Bidding commits this agent to executing the work. Without a resolvable
// adapter it cannot, and the failure would land after the contract is
// dual-signed — leaving the requester to force-settle against a provider that
// never had a chance. So refuse to arm supply at all.
// #21 guarded against a missing adapter *config*, but a config whose key
// does not resolve is the same thing from the counterparty's point of view:
// the agent bids, wins, and fails at execution after the contract is signed.
// Seen in demo-rebuild.js, where the provider's key env var was unset and it
// kept winning work it could not do.
// The same argument covers the P-10 terms declaration (§4 #67): the adapter
// refuses another agent's request on a real upstream without it, and that
// refusal at execution time is precisely the after-the-contract failure this
// guard exists to prevent. Mock mode and a local model are exempt — there is
// no upstream agreement to comply with.
const termsOk = !!(adapterCfg
  && (!adapterCfg.baseUrl
      || (adapterCfg.terms && adapterCfg.terms.attested === true)));
const canExecute = !!(adapterCfg && adapterCfg.apiKey && termsOk);
if (cfg.provide && !canExecute) {
  log('supply NOT armed: ' + (!adapterCfg
    ? 'provide is set but no adapter is configured'
    : !adapterCfg.apiKey
      ? 'the adapter key did not resolve (check the env var or keystore)'
      : 'adapter.terms.attested is not set, so this node may not run other ' +
        'agents\' requests on this upstream (P-10, §4 #67 — see ' +
        'docs/evaluation/key-lending-verification.md)') +
    ' — an agent that cannot execute must not bid');
}
if (cfg.provide && canExecute) {
  setTimeout(() => {
    providing = true;
    // Says "armed", not "providing": this fires on a timer and proves nothing
    // about the hub connection (§4 #19). Bids only happen once registered.
    log(`supply armed at ${cfg.provide.pricePerUnit} CC/unit, strategy ${mode}` +
        (hub.connected ? '' : ' — WARNING: not connected to a hub yet'));
  }, cfg.provide.afterMs);
}

// postSeq restarts at 1 every process, and cfg.name is not unique either, so
// a bare `t-<name>-<seq>` collided across restarts: two different agents ended
// up holding receipts under one contract_id, which is the settlement
// idempotency key (W1 schema freeze). The DID tag makes it unique per
// identity, and genIdentity() runs per process.
// Timing that used to be loopback constants. Found by fault injection: with
// an 80ms±40 WAN profile the fixed 500ms bid window produced `no bids` on
// every single task — zero settlements in 90 seconds, where the same topology
// without latency settled 27 in 60. Same shape as #36, worse outcome: not a
// stuck contract but a market that never trades.
//
// The bid window is now event-driven rather than a guess: award once bids
// have stopped arriving for `bidQuietMs`, never before `bidWindowMs` (so a
// LAN still awards at 500ms) and never after `bidWindowMaxMs`. A constant
// that has to be right for both loopback and a WAN is the thing to remove,
// not to re-tune.
const T = (cfg.policy && cfg.policy.timing) || {};
const BID_WINDOW_MS = T.bidWindowMs || 500;
const BID_QUIET_MS = T.bidQuietMs || 250;
const BID_MAX_MS = T.bidWindowMaxMs || 3000;
const FORCE_AFTER_MS = T.forceAfterMs || 1200;
// VERIFYING has no timeout at all, which fault injection turned into a
// measurable leak: contracts awarded while the panel's link was blackholed
// were never settled and never closed — three agents held 12–18 open
// contracts, the oldest 155s and still growing, because verify_request went
// into the void and nothing ever retried it. §2.3 calls for a VERIFYING
// timeout with backup verifiers; a re-seeded panel needs hub-side support, so
// what is implemented here is the bounded part: retry the same panel, then
// abandon loudly instead of holding the contract open forever.
const VERIFY_TIMEOUT_MS = T.verifyTimeoutMs || 15000;
const VERIFY_RETRIES = T.verifyRetries == null ? 2 : T.verifyRetries;
const DELIVER_TIMEOUT_MS = T.deliverTimeoutMs || 12000;
const DELIVER_RETRIES = T.deliverRetries == null ? 2 : T.deliverRetries;
const AWARD_TIMEOUT_MS = T.awardTimeoutMs || 6000;
const AWARD_RETRIES = T.awardRetries == null ? 2 : T.awardRetries;
const SEED_TIMEOUT_MS = T.seedTimeoutMs || 8000;
const SEED_RETRIES = T.seedRetries == null ? 3 : T.seedRetries;
// §16 威脅 8 / §4 新開口 (a): until now no protocol object carried a time, so
// nothing expired and a months-old bid or pre_authorization was as valid as a
// fresh one. The only replay defence was settledIds, which knows about
// contract_ids that already settled and nothing else.
//
// Windows are generous relative to the protocol's own timeouts: a task must
// outlive the bid window, a contract must outlive verification plus its
// retries, and a pre_authorization must outlive the forced-settlement path —
// an expiry that fires during normal operation is worse than none, because it
// turns a working system into an intermittently broken one.
const TASK_TTL_MS = T.taskTtlMs || 60000;
const BID_TTL_MS = T.bidTtlMs || 60000;
const CONTRACT_TTL_MS = T.contractTtlMs || 600000;
const PREAUTH_TTL_MS = T.preAuthTtlMs || 900000;

// Local reliability, kept by this agent for its own selection decisions.
// FR-012 makes choosing a winner the requester's prerogative, and the hub's
// completed/failed stats feed the credit line, not the auction — so a
// provider that underbids everyone and delivers nothing won every task and
// the market stopped. Nothing was stolen (no delivery, no settlement, no
// payment), but that is a denial of service at near-zero cost: identities
// are free and providers post no stake. Found by the red team's
// never-deliver case; SDD §16 threat 4 is usually read as theft, and this
// is the other half of it.
//
// Laplace-smoothed so a newcomer starts at parity rather than being frozen
// out — the cold-start problem this system already worries about elsewhere.
const providerRep = new Map();
const repOf = (did) => {
  const r = providerRep.get(did) || { won: 0, delivered: 0, failed: 0 };
  return (r.delivered + 1) / (r.won + 1);
};
function noteProvider(did, field) {
  const r = providerRep.get(did) || { won: 0, delivered: 0, failed: 0 };
  r[field] += 1;
  providerRep.set(did, r);
}

const idTag = id.did.slice(-8);
let postSeq = 0;
const pausedPosts = [];
function postTask(post) {
  postSeq += 1;
  hub.send({ type: 'list_verifiers' }); // refresh panel directory + lock
  const now = Date.now();
  const task = {
      task_id: `t-${cfg.name}-${idTag}-${postSeq}`,
      requester: id.did,
      units: post.units,
      max_price_cc: post.maxPriceCC,
      issued_at: now,
      expires_at: now + TASK_TTL_MS,
      acceptance: { method: post.acceptance,
                    asserts_hash: assertsHash(post.asserts) },
    };
    const fire = () => {
        const { bids } = pendingBids.get(task.task_id);
        if (!bids.length) { log(`no bids for ${task.task_id}`); return; }
        // Effective price, not raw price: a provider that has taken awards
        // and delivered nothing has to be much cheaper to stay attractive,
        // and one that has failed twice with nothing delivered is skipped.
        const fresh = bids.filter((b) => !b.expires_at || Date.now() <= b.expires_at);
        if (fresh.length < bids.length) {
          log(`dropping ${bids.length - fresh.length} expired bid(s) on ${task.task_id}`);
        }
        const usable = fresh.filter((b) => {
          const r = providerRep.get(b.provider);
          return !(r && r.failed >= 2 && r.delivered === 0);
        });
        const field = usable.length ? usable : fresh;
        // §4 #23: equal effective price used to fall through to Array.sort's
        // stability, i.e. arrival order, so in a homogeneous price market the
        // earliest-started process won everything — a property of spawn order
        // rather than of the market. Ties now break on a hash of the task and
        // the bidder, the same trick the panel derivation uses: deterministic,
        // verifiable by both sides, and not gameable by connecting first.
        field.sort((a, b) => {
          const d = a.price_cc / repOf(a.provider) - b.price_cc / repOf(b.provider);
          if (Math.abs(d) > 1e-9) return d;
          return sha256(task.task_id + a.provider)
            .localeCompare(sha256(task.task_id + b.provider));
        });
        const win = field[0];
        if (usable.length < bids.length) {
          log(`skipping ${bids.length - usable.length} bid(s) from providers ` +
              'that took awards and never delivered');
        }
        const contractId = `c-${task.task_id}`;
        const pool = post.acceptance === 'judge-quorum'
          ? [...(verifierDir.verifiers || [])] : [];
        // Awarding a quorum contract against too small a pool produces a
        // contract that can never settle: the panel is short, attestations
        // never reach two, and the hub refuses. Twelve tasks stalled exactly
        // this way on the pilot when no verifier was online, with nothing in
        // the log to say why. Refuse up front and name the reason.
        if (post.acceptance === 'judge-quorum' && pool.length < panelLib.PANEL_SIZE) {
          log(`NOT awarding ${task.task_id}: judge-quorum needs ` +
              `${panelLib.PANEL_SIZE} verifiers in the pool, ${pool.length} online`);
          pendingBids.delete(task.task_id);
          return;
        }
        // §4 #6: the panel is not named here. The pool is pinned and the seed
        // is a checkpoint that does not exist yet, so grinding the contract id
        // would mean predicting a root that later settlements determine.
        const seedCp = verifierDir.next_checkpoint_seq != null
          ? verifierDir.next_checkpoint_seq
          : (verifierDir.lock ? verifierDir.lock.checkpoint_seq + 1 : 0);
        const awardedAt = Date.now();
        const contract = {
          contract_id: contractId,
          issued_at: awardedAt,
          expires_at: awardedAt + CONTRACT_TTL_MS,
          requester: id.did, provider: win.provider, price_cc: win.price_cc,
          payload_box: seal(win.box_pub, post.payload),
          acceptance: task.acceptance,
          asserts: post.asserts,
          verifier_pool: pool.map((v) => v.did),
          verifier_pool_hash: panelLib.poolHash(pool.map((v) => v.did)),
          panel_seed_cp: seedCp,
          verifier_lock: verifierDir.lock,
        };
        const pre_auth = { contract_id: contractId, requester: id.did,
                           provider: win.provider, price_cc: win.price_cc,
                           condition: 'quorum-accepted',
                           issued_at: awardedAt,
                           expires_at: awardedAt + PREAUTH_TTL_MS };
        asRequester.set(contractId, {
          contract, contract_sigs: {}, payload: post.payload,
          asserts: post.asserts, pool, panel: null,
          providerPub: win.pub || null, attest: [], done: false,
          // When the contract was opened, so an invariant can ask how long it
          // has been unsettled. A silent partition produces contracts that
          // can never settle (#46) and nothing measured their age.
          at: Date.now(),
        });
        noteProvider(win.provider, 'won');
        armDeliveryTimeout(contractId, win.provider);
        armAwardTimeout(contractId, contract, pre_auth, win.provider);
        log(`selected ${win.provider} @ ${win.price_cc} CC (${bids.length} bids)` +
            (pool.length
              ? `, pool of ${pool.length} pinned, panel seeded from future ` +
                `checkpoint #${seedCp}`
              : ''));
        hub.send({ type: 'contract', to: win.provider, contract,
                   sig: sign(id.privateKey, contract), pub: id.pub,
                   pre_auth, pre_auth_sig: sign(id.privateKey, pre_auth) });
    };
    pendingBids.set(task.task_id, {
      task, bids: [], fire,
      deadline: Date.now() + BID_MAX_MS,
      timer: setTimeout(fire, BID_WINDOW_MS),
    });
  log(`quota exhausted → posting ${task.task_id} (UC-01, ${post.acceptance})`);
  hub.send({ type: 'task', task, sig: sign(id.privateKey, task) });
  return task.task_id;
}

for (const post of cfg.posts || []) {
  setTimeout(() => {
    if (!strategy.mayPost(post, mode)) {
      log(`post paused (non-essential, mode ${mode}): ${post.units}u`);
      pausedPosts.push(post);
      return;
    }
    console_.scriptedPosts += 1;  // cfg.posts timetable — also not policy
    postTask(post);
  }, post.atMs);
}

// --- unattended demand loop (W8: UC-01 step 1, §20-8) --------------------
// The agent buys because it noticed its own quota ran out, with no timetable
// and nobody asking. §6.2 forbids requiring a human to find tasks per item.
if (cfg.policy && cfg.policy.demand) {
  const rng = demand.makeRng(cfg.seed != null
    ? cfg.seed : demand.seedFrom(id.did));
  const quota = demand.newQuota(cfg.policy);
  console_.quota = quota;
  const tickMs = cfg.policy.demand.tickMs || 1000;

  setInterval(() => {
    const expired = demand.maybeReset(quota);
    if (expired !== null) {
      log(`quota cycle reset: ${expired.toFixed(1)}u expired, ` +
          `back to ${quota.capacity}u`);
    }
    const units = demand.drawDemand(rng, cfg.policy);
    const { local, shortfall } = demand.consume(quota, units);
    if (shortfall <= 0) return;   // own quota covered it; no market activity

    // UC-01 steps 2-3: policy decides whether the shortfall may be bought.
    const plan = demand.planPurchase(shortfall, {
      balance: console_.balance, creditLine: console_.creditLine,
      policy: cfg.policy,
    });
    if (plan.withheld) {
      console_.withheld.push(plan.withheld);
      log(`quota exhausted, purchase withheld: ${plan.withheld}`);
      return;
    }
    // FR-055: while under the band, discretionary consumption waits. Buying
    // to cover a shortfall is the agent's own work, so it is essential only
    // if the Owner said so.
    const post = {
      units: plan.units,
      maxPriceCC: plan.maxPriceCC,
      payload: `auto: ${plan.units}u inference, own quota exhausted ` +
               `(cycle ${quota.cycles}, remaining ${quota.remaining}u)`,
      acceptance: (cfg.policy.acceptance || {}).method || 'judge-quorum',
      asserts: (cfg.policy.acceptance || {}).asserts
        || [{ op: 'sha256_eq' }, { op: 'max_len', arg: 512 }],
      essential: cfg.policy.essentialPurchases !== false,
    };
    if (!strategy.mayPost(post, mode)) {
      pausedPosts.push(post);
      log(`quota exhausted but purchase paused (non-essential, mode ${mode})`);
      return;
    }
    console_.autoPosts += 1;
    log(`quota exhausted (used ${local.toFixed(1)}u, short ` +
        `${shortfall.toFixed(1)}u) → auto-posting ${plan.units}u ` +
        `@ max ${plan.maxPriceCC} CC${plan.trimmed ? ' (trimmed to credit)' : ''}`);
    postTask(post);
  }, tickMs).unref();
}
