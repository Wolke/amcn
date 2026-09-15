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
const { genIdentity, sign, verify, sha256, connect, connectLazy } = require('./lib/wire');
const { genBoxKeys, seal, open } = require('./lib/e2e');
const { runAsserts, assertsHash } = require('./lib/dsl');
const keystore = require('./lib/keystore');
const discovery = require('./lib/discovery');
const adapter = require('./adapter');

const cfg = process.env.AGENT_CONFIG
  ? JSON.parse(process.env.AGENT_CONFIG)
  : JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
const id = genIdentity();
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
const pendingFees = new Map();   // contract_id -> {role, provider, delivery_hash, output}
const console_ = { balance: 0, creditLine: 0, settled: [] };

function panelFor(contractId) { // seeded, checkpoint-locked (FR-041)
  const { verifiers, lock } = verifierDir;
  return [...verifiers]
    .sort((a, b) => sha256(lock.root + contractId + a.did)
      .localeCompare(sha256(lock.root + contractId + b.did)))
    .slice(0, 3);
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
  hub.send({ type: 'fee_quote', contract_id: contractId, requester, price });
}

// hubHost: "discover" opts into the UDP beacon (lib/discovery.js) instead of
// a hand-copied IP. Any other value, including absent, keeps the previous
// behaviour exactly — existing configs and demo.js are unaffected.
const hub = connectLazy(discovery.resolveHubTarget(cfg, log), async (msg) => {
  switch (msg.type) {
    case 'registered':
      console_.creditLine = msg.credit_line;
      log(`registered, dynamic credit line ${msg.credit_line.toFixed(1)} CC`);
      break;

    case 'verifiers': verifierDir = msg; break;

    case 'task': {
      if (!providing) break;
      const bid = {
        task_id: msg.task.task_id, provider: id.did,
        price_cc: +(msg.task.units * cfg.provide.pricePerUnit).toFixed(4),
        box_pub: box.boxPub,
      };
      hub.send({ type: 'bid', to: msg.task.requester, bid,
                 sig: sign(id.privateKey, bid), pub: id.pub });
      log(`bid ${bid.price_cc} CC on ${msg.task.task_id}`);
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
      log(`awarded ${c.contract_id} @ ${c.price_cc} CC (contract dual-signed, ` +
          `panel ${c.verifiers.length} verifiers) — executing locally`);
      const output = await adapter.complete(adapterCfg, payload);
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
      } else { // judge-quorum: fan out to the contract-locked panel
        log(`delivery on ${d.contract_id} → dispatching to verifier panel`);
        for (const v of ctx.panel) {
          const request = {
            contract_id: d.contract_id, requester: id.did, provider: d.provider,
            output: d.output, asserts: ctx.asserts,
            asserts_hash: ctx.contract.acceptance.asserts_hash,
            payload_box: seal(v.box_pub, ctx.payload),
          };
          hub.send({ type: 'verify_request', to: v.did, request,
                     sig: sign(id.privateKey, request), pub: id.pub });
        }
      }
      break;
    }

    case 'attestation': {
      const a = msg.attestation;
      const reqCtx = asRequester.get(a.contract_id);
      const provCtx = asProvider.get(a.contract_id);
      if (reqCtx) { // requester side: settle on 2-of-3 PASS (unless malicious)
        const v = reqCtx.panel.find((x) => x.did === a.verifier);
        if (!v || !verify(v.pub, a, msg.sig)) break;
        reqCtx.attest.push({ attestation: a, sig: msg.sig, pub: msg.pub });
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
        if (!provCtx.contract.verifiers.includes(a.verifier)) break;
        if (!verify(msg.pub, a, msg.sig)) break;
        provCtx.attest.push({ attestation: a, sig: msg.sig, pub: msg.pub });
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
      const receipt = {
        contract_id: msg.contract_id,
        requester: msg.requester,
        provider: pf.provider,
        delivery_hash: pf.delivery_hash,
        postings: [
          { account: msg.requester, amount_cc: -price },
          { account: pf.provider, amount_cc: +(price - fee - risk).toFixed(4) },
          { account: 'protocol:treasury', amount_cc: fee },
          { account: 'protocol:insurance', amount_cc: risk },
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
      hub.send({ type: 'receipt', receipt: r,
                 sigs: { requester: msg.sig, provider: sign(id.privateKey, r) } });
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
      }
      break;
    }

    case 'error': log(`hub error: ${msg.why} (${msg.ref})`); break;
  }
});

const regBody = { did: id.did, pub: id.pub, box_pub: box.boxPub };
hub.send({ type: 'register', ...regBody, sig: sign(id.privateKey, regBody) });
console.log(`DID ${cfg.name} ${id.did}`);

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
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      name: cfg.name, did: id.did,
      balance_cc: console_.balance,
      credit_line_cc: console_.creditLine,
      settled: console_.settled,
    }));
  }).listen(cfg.consolePort, '127.0.0.1',
    () => log(`owner console on http://127.0.0.1:${cfg.consolePort}/status`));
}

if (cfg.provide) {
  setTimeout(() => {
    providing = true;
    log(`now providing at ${cfg.provide.pricePerUnit} CC/unit` +
        (cfg.provide.repayment ? ' (repayment mode, UC-02)' : ''));
  }, cfg.provide.afterMs);
}

// postSeq restarts at 1 every process, and cfg.name is not unique either, so
// a bare `t-<name>-<seq>` collided across restarts: two different agents ended
// up holding receipts under one contract_id, which is the settlement
// idempotency key (W1 schema freeze). The DID tag makes it unique per
// identity, and genIdentity() runs per process.
const idTag = id.did.slice(-8);
let postSeq = 0;
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
        const panel = post.acceptance === 'judge-quorum' ? panelFor(contractId) : [];
        const contract = {
          contract_id: contractId,
          requester: id.did, provider: win.provider, price_cc: win.price_cc,
          payload_box: seal(win.box_pub, post.payload),
          acceptance: task.acceptance,
          asserts: post.asserts,
          verifiers: panel.map((v) => v.did),
          verifier_lock: verifierDir.lock,
        };
        const pre_auth = { contract_id: contractId, requester: id.did,
                           provider: win.provider, price_cc: win.price_cc,
                           condition: 'quorum-accepted' };
        asRequester.set(contractId, {
          contract, contract_sigs: {}, payload: post.payload,
          asserts: post.asserts, panel, providerPub: win.pub || null,
          attest: [], done: false,
        });
        log(`selected ${win.provider} @ ${win.price_cc} CC (${bids.length} bids)` +
            (panel.length ? `, panel locked: ${panel.length} verifiers` : ''));
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
  setTimeout(() => postTask(post), post.atMs);
}
