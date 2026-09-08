// Local Agent Node (Phase 1). One OS process per Owner device.
//
// P-02 by construction: the provider API key is resolved via the local
// keystore (macOS Keychain or env) and used only by the local adapter to
// call the Owner's own provider endpoint. It never enters a protocol
// message. Task payloads travel E2E-sealed to the winning provider; the
// hub relays boxes it cannot open (NFR-005).
//
// Config via AGENT_CONFIG env (JSON):
// { name, hubPort,
//   adapter: {baseUrl, model, key: {service, env}} | null,
//   provide: {afterMs, pricePerUnit, repayment?} | null,
//   posts: [{atMs, units, maxPriceCC, payload}] }
'use strict';
const { genIdentity, sign, verify, sha256, connect } = require('./lib/wire');
const { genBoxKeys, seal, open } = require('./lib/e2e');
const keystore = require('./lib/keystore');
const adapter = require('./adapter');

const cfg = JSON.parse(process.env.AGENT_CONFIG);
const id = genIdentity();
const box = genBoxKeys();
const log = (m) => console.log(`[${cfg.name} ${id.did}] ${m}`);

const adapterCfg = cfg.adapter ? {
  baseUrl: cfg.adapter.baseUrl,
  model: cfg.adapter.model,
  apiKey: keystore.getKey(cfg.adapter.key), // resolved locally, stays here
} : null;

let providing = false;
const pendingBids = new Map();   // task_id -> {task, bids, timer}
const myContracts = new Map();   // contract_id -> {contract, payload}
const pendingFees = new Map();   // contract_id -> {delivery}

const hub = connect(cfg.hubPort, async (msg) => {
  switch (msg.type) {
    case 'registered':
      log(`registered, dynamic credit line ${msg.credit_line.toFixed(1)} CC`);
      break;

    case 'task': { // potential provider: task metadata only, no payload yet
      if (!providing) break;
      const bid = {
        task_id: msg.task.task_id,
        provider: id.did,
        price_cc: +(msg.task.units * cfg.provide.pricePerUnit).toFixed(4),
        box_pub: box.boxPub, // so the requester can seal the payload to us
      };
      hub.send({ type: 'bid', to: msg.task.requester, bid,
                 sig: sign(id.privateKey, bid), pub: id.pub });
      log(`bid ${bid.price_cc} CC on ${msg.task.task_id}`);
      break;
    }

    case 'bid': {
      const p = pendingBids.get(msg.bid.task_id);
      if (!p || !verify(msg.pub, msg.bid, msg.sig)) break;
      if (msg.bid.price_cc <= p.task.max_price_cc) p.bids.push(msg.bid);
      break;
    }

    case 'contract': { // awarded provider: open sealed payload, execute
      const c = msg.contract;
      if (!verify(msg.pub, c, msg.sig)) break;
      const payload = open(box.boxPriv, c.payload_box); // only we can open
      log(`awarded ${c.contract_id} @ ${c.price_cc} CC — ` +
          `payload unsealed locally, executing via ${adapterCfg.baseUrl || 'mock adapter'}`);
      const output = await adapter.complete(adapterCfg, payload);
      const delivery = { contract_id: c.contract_id, output, provider: id.did };
      hub.send({ type: 'delivery', to: c.requester, delivery,
                 sig: sign(id.privateKey, delivery), pub: id.pub });
      break;
    }

    case 'delivery': { // requester: deterministic verification
      const d = msg.delivery;
      const c = myContracts.get(d.contract_id);
      if (!c || !verify(msg.pub, d, msg.sig)) break;
      if (d.output !== sha256(c.payload)) {
        log(`REJECTED ${d.contract_id}: output mismatch`); break;
      }
      log(`verified ${d.contract_id} deterministically → asking fee terms`);
      pendingFees.set(d.contract_id, { delivery: d, contract: c.contract });
      hub.send({ type: 'fee_quote', contract_id: d.contract_id,
                 requester: id.did, price: c.contract.price_cc });
      break;
    }

    case 'fee_terms': { // build receipt with the hub's exact fee split
      const pf = pendingFees.get(msg.contract_id);
      if (!pf) break;
      const { fee, risk, price } = msg;
      const receipt = {
        contract_id: msg.contract_id,
        requester: id.did,
        provider: pf.delivery.provider,
        delivery_hash: sha256(pf.delivery.output),
        postings: [
          { account: id.did, amount_cc: -price },
          { account: pf.delivery.provider, amount_cc: +(price - fee - risk).toFixed(4) },
          { account: 'protocol:treasury', amount_cc: fee },
          { account: 'protocol:insurance', amount_cc: risk },
        ],
      };
      hub.send({ type: 'receipt_half', to: pf.delivery.provider, receipt,
                 sig: sign(id.privateKey, receipt), pub: id.pub });
      break;
    }

    case 'receipt_half': { // provider: countersign and submit
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

    case 'error': log(`hub error: ${msg.why} (${msg.ref})`); break;
  }
});

const regBody = { did: id.did, pub: id.pub, box_pub: box.boxPub };
hub.send({ type: 'register', ...regBody, sig: sign(id.privateKey, regBody) });
console.log(`DID ${cfg.name} ${id.did}`);

if (cfg.provide) {
  setTimeout(() => {
    providing = true;
    log(`now providing at ${cfg.provide.pricePerUnit} CC/unit` +
        (cfg.provide.repayment ? ' (repayment mode, UC-02)' : ''));
  }, cfg.provide.afterMs);
}
for (const post of cfg.posts || []) {
  setTimeout(() => {
    const task = { // metadata only — payload is sealed later, to the winner
      task_id: `t-${cfg.name}-${post.atMs}`,
      requester: id.did,
      units: post.units,
      max_price_cc: post.maxPriceCC,
      acceptance: { method: 'sha256-of-payload' },
    };
    pendingBids.set(task.task_id, {
      task, bids: [],
      timer: setTimeout(() => {
        const { bids } = pendingBids.get(task.task_id);
        if (!bids.length) { log(`no bids for ${task.task_id}`); return; }
        bids.sort((a, b) => a.price_cc - b.price_cc);
        const win = bids[0];
        const contract = {
          contract_id: `c-${task.task_id}`,
          requester: id.did,
          provider: win.provider,
          price_cc: win.price_cc,
          payload_box: seal(win.box_pub, post.payload), // E2E to winner only
        };
        myContracts.set(contract.contract_id,
          { contract, payload: post.payload });
        log(`selected ${win.provider} @ ${win.price_cc} CC (${bids.length} bids)`);
        hub.send({ type: 'contract', to: win.provider, contract,
                   sig: sign(id.privateKey, contract), pub: id.pub });
      }, 500),
    });
    log(`quota exhausted → posting ${task.task_id} (UC-01)`);
    hub.send({ type: 'task', task, sig: sign(id.privateKey, task) });
  }, post.atMs);
}
