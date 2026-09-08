// Local Agent Node (prototype). One OS process per Owner device.
//
// P-02 by construction: the "provider API key" lives only in this
// process's memory (env var). The adapter uses it to serve inference;
// no protocol message ever contains it — the demo verifies this by
// scanning the hub's raw log.
//
// Config via AGENT_CONFIG env (JSON):
// { name, hubPort, apiKey,
//   provide: {afterMs, pricePerUnit} | null,
//   posts: [{atMs, units, maxPriceCC, payload}] }
'use strict';
const { genIdentity, sign, verify, sha256, hmac, connect } = require('./lib/wire');

const cfg = JSON.parse(process.env.AGENT_CONFIG);
const id = genIdentity();
const API_KEY = cfg.apiKey; // never leaves this process
const log = (m) => console.log(`[${cfg.name} ${id.did}] ${m}`);

// --- local model adapter (mock): key-gated deterministic "inference" ---
// Stands in for a real provider call; swap with an OpenAI-compatible
// client in Phase 1 proper. Refuses to run without its local key.
function adapterComplete(prompt) {
  if (!API_KEY) throw new Error('adapter: no local API key');
  return sha256(prompt); // deterministic → verifiable (SDD §20-7)
}

let providing = false;
let feeRate = 0.025;
const pendingBids = new Map();   // task_id -> {task, bids: [], timer}
const myContracts = new Map();   // contract_id -> {task, price, provider}

const hub = connect(cfg.hubPort, (msg) => {
  switch (msg.type) {
    case 'registered':
      feeRate = msg.fee_rate;
      log(`registered, credit line ${msg.credit_line} CC`);
      break;

    case 'task': { // I'm a potential provider
      if (!providing) break;
      const bid = {
        task_id: msg.task.task_id,
        provider: id.did,
        price_cc: +(msg.task.units * cfg.provide.pricePerUnit).toFixed(4),
      };
      hub.send({ type: 'bid', to: msg.task.requester, bid,
                 sig: sign(id.privateKey, bid), pub: id.pub });
      log(`bid ${bid.price_cc} CC on ${msg.task.task_id}`);
      break;
    }

    case 'bid': { // I'm the requester collecting bids
      const p = pendingBids.get(msg.bid.task_id);
      if (!p) break;
      if (!verify(msg.pub, msg.bid, msg.sig)) break;
      if (msg.bid.price_cc <= p.task.max_price_cc) p.bids.push(msg.bid);
      break;
    }

    case 'contract': { // I'm the awarded provider: execute locally
      const c = msg.contract;
      if (!verify(msg.pub, c, msg.sig)) break;
      log(`awarded ${c.contract_id} @ ${c.price_cc} CC — executing with LOCAL key`);
      const output = adapterComplete(c.payload);
      const delivery = {
        contract_id: c.contract_id,
        output,
        usage_proof: hmac(API_KEY, output), // proves key use, not the key
        provider: id.did,
      };
      myContracts.set(c.contract_id, { contract: c, requesterPub: msg.pub });
      hub.send({ type: 'delivery', to: c.requester, delivery,
                 sig: sign(id.privateKey, delivery), pub: id.pub });
      break;
    }

    case 'delivery': { // I'm the requester: verify + build receipt
      const d = msg.delivery;
      const c = myContracts.get(d.contract_id);
      if (!c || !verify(msg.pub, d, msg.sig)) break;
      const ok = d.output === sha256(c.contract.payload); // deterministic test
      if (!ok) { log(`REJECTED ${d.contract_id}: output mismatch`); break; }
      const fee = +(c.contract.price_cc * feeRate).toFixed(4);
      const receipt = {
        contract_id: d.contract_id,
        requester: id.did,
        provider: d.provider,
        delivery_hash: sha256(d.output),
        postings: [
          { account: id.did, amount_cc: -c.contract.price_cc },
          { account: d.provider, amount_cc: +(c.contract.price_cc - fee).toFixed(4) },
          { account: 'protocol:treasury', amount_cc: fee },
        ],
      };
      log(`verified ${d.contract_id} deterministically → signing receipt`);
      hub.send({ type: 'receipt_half', to: d.provider, receipt,
                 sig: sign(id.privateKey, receipt), pub: id.pub });
      break;
    }

    case 'receipt_half': { // I'm the provider: countersign and submit
      const r = msg.receipt;
      const mine = r.postings.find((p) => p.account === id.did);
      const total = r.postings.reduce((s, p) => s + p.amount_cc, 0);
      if (!verify(msg.pub, r, msg.sig) || !mine || mine.amount_cc <= 0 ||
          Math.abs(total) > 1e-9) break;
      hub.send({ type: 'receipt', receipt: r,
                 sigs: { requester: msg.sig, provider: sign(id.privateKey, r) } });
      log(`countersigned ${r.contract_id} → submitted for settlement`);
      break;
    }

    case 'settled': {
      const me = msg.receipt.postings.find((p) => p.account === id.did);
      if (me) log(`settled ${msg.receipt.contract_id}: my delta ${me.amount_cc.toFixed(2)} CC`);
      break;
    }
  }
});

hub.send({ type: 'register', did: id.did, pub: id.pub,
           sig: sign(id.privateKey, { did: id.did, pub: id.pub }) });
console.log(`DID ${cfg.name} ${id.did}`); // demo reads this line

// --- scripted plan ------------------------------------------------------
if (cfg.provide) {
  setTimeout(() => {
    providing = true;
    log(`now providing at ${cfg.provide.pricePerUnit} CC/unit` +
        (cfg.provide.repayment ? ' (repayment mode, UC-02)' : ''));
  }, cfg.provide.afterMs);
}
for (const post of cfg.posts || []) {
  setTimeout(() => {
    const task = {
      task_id: `t-${cfg.name}-${post.atMs}`,
      requester: id.did,
      units: post.units,
      max_price_cc: post.maxPriceCC,
      payload: post.payload, // demo sends in clear; Phase 1: E2E-encrypted
      acceptance: { method: 'sha256-of-payload' },
    };
    pendingBids.set(task.task_id, {
      task,
      bids: [],
      timer: setTimeout(() => { // bid window closes → pick cheapest
        const { bids } = pendingBids.get(task.task_id);
        if (!bids.length) { log(`no bids for ${task.task_id}`); return; }
        bids.sort((a, b) => a.price_cc - b.price_cc);
        const win = bids[0];
        const contract = {
          contract_id: `c-${task.task_id}`,
          requester: id.did,
          provider: win.provider,
          price_cc: win.price_cc,
          payload: task.payload,
        };
        myContracts.set(contract.contract_id, { contract });
        log(`selected ${win.provider} @ ${win.price_cc} CC (${bids.length} bids)`);
        hub.send({ type: 'contract', to: win.provider, contract,
                   sig: sign(id.privateKey, contract), pub: id.pub });
      }, 500),
    });
    log(`quota exhausted → posting ${task.task_id} (UC-01)`);
    hub.send({ type: 'task', task, sig: sign(id.privateKey, task) });
  }, post.atMs);
}
