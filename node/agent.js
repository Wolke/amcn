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
        connectLazy, PROTOCOL_VERSION } = require('./lib/wire');
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
                   withheld: [] };
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

function fanOut(delivery, ctx, chosen) {
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

const hub = connectLazy(discovery.resolveHubTarget(cfg, log), async (msg) => {
  switch (msg.type) {
    case 'registered':
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

    case 'credit_update':
      console_.creditLine = msg.credit_line;
      refreshMode('credit line moved');
      break;

    case 'verifiers': verifierDir = msg; break;

    case 'checkpoint': {
      cpRoots.set(msg.cp.seq, msg.cp.root);
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
      const bid = {
        task_id: msg.task.task_id, provider: id.did,
        price_cc: +(msg.task.units * unitPrice).toFixed(4),
        box_pub: box.boxPub,
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
      break;
    }

    case 'contract': { // I'm awarded: countersign, unseal, execute
      const c = msg.contract;
      if (!verify(msg.pub, c, msg.sig)) break;
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
        output = await adapter.complete(adapterCfg, payload);
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
        });
        break;
      }
      asProvider.set(c.contract_id, {
        contract: c, contract_sigs: { requester: msg.sig, provider: mySig },
        pre_auth: msg.pre_auth, pre_auth_sig: msg.pre_auth_sig,
        output, attest: [], settled: false,
      });
      const delivery = { contract_id: c.contract_id, output, provider: id.did };
      hub.send({ type: 'delivery', to: c.requester, delivery,
                 sig: sign(id.privateKey, delivery), pub: id.pub });
      break;
    }

    case 'contract_ack': { // provider countersigned
      const ctx = asRequester.get(msg.contract_id);
      if (ctx && verify(ctx.providerPub, ctx.contract, msg.sig)) {
        ctx.contract_sigs.provider = msg.sig;
      }
      break;
    }

    case 'delivery': { // I'm the requester
      const d = msg.delivery;
      const ctx = asRequester.get(d.contract_id);
      if (!ctx || !verify(msg.pub, d, msg.sig)) break;
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
        if (passes >= 2 && !reqCtx.done) {
          reqCtx.done = true;
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
          }, 1200);
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
            attestations: e.attest,
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
                 attestations: pc ? pc.attest : [] });
      log(`countersigned ${r.contract_id} → submitted`);
      break;
    }

    case 'settled': {
      const me = msg.receipt.postings.find((p) => p.account === id.did);
      const provCtx = asProvider.get(msg.receipt.contract_id);
      if (provCtx) { provCtx.settled = true; clearTimeout(provCtx.timer); }
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
});

const regBody = { did: id.did, pub: id.pub, box_pub: box.boxPub };
hub.send({ type: 'register', ...regBody, sig: sign(id.privateKey, regBody) });
console.log(`DID ${cfg.name} ${id.did} (protocol v${PROTOCOL_VERSION})`);

// minimal Owner Console (§9.9 / FR-081): GET /status for state,
// POST /post to manually publish a task (two-machine pilots).
// Localhost-only on purpose — this is the Owner's own control surface.
if (cfg.consolePort) {
  http.createServer((req, res) => {
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
const canExecute = !!(adapterCfg && adapterCfg.apiKey);
if (cfg.provide && !canExecute) {
  log('supply NOT armed: ' + (adapterCfg
    ? 'the adapter key did not resolve (check the env var or keystore)'
    : 'provide is set but no adapter is configured') +
    ' — an agent that cannot execute must not bid');
}
if (cfg.provide && canExecute) {
  setTimeout(() => {
    providing = true;
    // Says "armed", not "providing": this fires on a timer and proves nothing
    // about the hub connection (§4 #19). Bids only happen once registered.
    log(`supply armed at ${cfg.provide.pricePerUnit} CC/unit, strategy ${mode}` +
        (hub.sock ? '' : ' — WARNING: not connected to a hub yet'));
  }, cfg.provide.afterMs);
}

// postSeq restarts at 1 every process, and cfg.name is not unique either, so
// a bare `t-<name>-<seq>` collided across restarts: two different agents ended
// up holding receipts under one contract_id, which is the settlement
// idempotency key (W1 schema freeze). The DID tag makes it unique per
// identity, and genIdentity() runs per process.
const idTag = id.did.slice(-8);
let postSeq = 0;
const pausedPosts = [];
function postTask(post) {
  postSeq += 1;
  hub.send({ type: 'list_verifiers' }); // refresh panel directory + lock
  const task = {
      task_id: `t-${cfg.name}-${idTag}-${postSeq}`,
      requester: id.did,
      units: post.units,
      max_price_cc: post.maxPriceCC,
      acceptance: { method: post.acceptance,
                    asserts_hash: assertsHash(post.asserts) },
    };
    pendingBids.set(task.task_id, {
      task, bids: [],
      timer: setTimeout(() => {
        const { bids } = pendingBids.get(task.task_id);
        if (!bids.length) { log(`no bids for ${task.task_id}`); return; }
        bids.sort((a, b) => a.price_cc - b.price_cc);
        const win = bids[0];
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
        const contract = {
          contract_id: contractId,
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
                           condition: 'quorum-accepted' };
        asRequester.set(contractId, {
          contract, contract_sigs: {}, payload: post.payload,
          asserts: post.asserts, pool, panel: null,
          providerPub: win.pub || null, attest: [], done: false,
        });
        log(`selected ${win.provider} @ ${win.price_cc} CC (${bids.length} bids)` +
            (pool.length
              ? `, pool of ${pool.length} pinned, panel seeded from future ` +
                `checkpoint #${seedCp}`
              : ''));
        hub.send({ type: 'contract', to: win.provider, contract,
                   sig: sign(id.privateKey, contract), pub: id.pub,
                   pre_auth, pre_auth_sig: sign(id.privateKey, pre_auth) });
      }, 500),
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
