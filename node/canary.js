#!/usr/bin/env node
// Canary issuer — W9's decoy auditor (proposal-C §7, §2.2 「金絲雀抽查」).
//
// A separate process, not a hub feature. proposal-C says the Treasury posts
// known-answer tasks under an identity, and making the hub originate tasks
// would turn the sequencer into a market participant — the thing §2.2's
// 「第一個排序器不是信任根」 is guarding against. The cost of keeping the hub
// out of it is a privileged DID: the hub acts on this identity's signed
// reports and pays the decoy's provider from Treasury, which is why the hub
// requires HUB_CANARY_DID to be set to this agent's DID explicitly.
//
// How a decoy has a knowable correct answer: acceptance here is a DSL, so
// the right verdict is computable. A canary task carries an assert set that
// no honest output can satisfy — max_len of 1 against a 64-character hash —
// so the only correct verdict is FAIL. A verifier that reveals PASS either
// never ran the asserts or lied, and either way it is not doing the job the
// fee pays for.
//
// Run:
//   node canary.js configs/canary.json
//   AGENT_CONFIG='{"hubHost":"127.0.0.1","hubPort":47180,"everyMs":6000}' node canary.js
//
// Print the DID it derives, set HUB_CANARY_DID to it on the hub, restart the
// hub, then start this.
'use strict';
const { genIdentity, identityFromSeed, sign, verify, sha256, canon,
        connectLazy } = require('./lib/wire');
const { genBoxKeys, seal } = require('./lib/e2e');
const { assertsHash } = require('./lib/dsl');
const discovery = require('./lib/discovery');
const panelLib = require('./lib/panel');

const cfg = process.env.AGENT_CONFIG
  ? JSON.parse(process.env.AGENT_CONFIG)
  : JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));

// A seeded identity, so HUB_CANARY_DID can be configured once: the hub has
// to authorise this DID before this process starts, which a fresh keypair
// every run makes impossible.
const id = cfg.seed ? identityFromSeed(cfg.seed) : genIdentity();
if (!cfg.seed) {
  console.log('警告：未設 seed，DID 每次啟動都會變，' +
    'HUB_CANARY_DID 會失效——正式使用請設 cfg.seed');
}
const box = genBoxKeys();
const name = cfg.name || 'canary';
const log = (m) => console.log(`[${name} ${id.did}] ${m}`);

// An assert set no honest output can satisfy, so FAIL is the only correct
// verdict. Kept deliberately simple: a verifier that runs the DSL at all
// gets this right.
const IMPOSSIBLE_ASSERTS = [{ op: 'max_len', arg: 1 }];
const UNITS = cfg.units || 2;
const MAX_PRICE_CC = cfg.maxPriceCC || UNITS * 1.3;
const EVERY_MS = cfg.everyMs || 8000;

const open = new Map();   // contract_id -> {panel, commits, attest, provider, seedRoot}
const cpRoots = new Map();
let verifierDir = { verifiers: [], lock: null };
let seq = 0;

const hub = connectLazy(discovery.resolveHubTarget(cfg, log), (msg) => {
  switch (msg.type) {
    case 'registered':
      log(`registered as canary issuer, hub credit line ${msg.credit_line.toFixed(1)} CC`);
      log('若 Hub 未設 HUB_CANARY_DID 為上面這個 DID，報告會被拒絕');
      break;

    case 'verifiers': verifierDir = msg; break;
    case 'checkpoint': cpRoots.set(msg.cp.seq, msg.cp.root); break;

    case 'bid': {
      const ctx = open.get(`c-${msg.bid.task_id}`);
      if (!ctx || ctx.awarded) break;
      if (!verify(msg.pub, msg.bid, msg.sig)) break;
      if (msg.bid.price_cc > ctx.maxPriceCC) break;
      ctx.awarded = true;
      ctx.provider = msg.bid.provider;
      ctx.price_cc = msg.bid.price_cc;
      const contract = {
        contract_id: ctx.contract_id,
        requester: id.did, provider: msg.bid.provider, price_cc: msg.bid.price_cc,
        payload_box: seal(msg.bid.box_pub, ctx.payload),
        acceptance: { method: 'judge-quorum', asserts_hash: assertsHash(IMPOSSIBLE_ASSERTS) },
        asserts: IMPOSSIBLE_ASSERTS,
        verifier_pool: ctx.pool.map((v) => v.did),
        verifier_pool_hash: panelLib.poolHash(ctx.pool.map((v) => v.did)),
        panel_seed_cp: ctx.seedCp,
        verifier_lock: ctx.lock,
      };
      // A canary settles out of Treasury on the hub's side, so no
      // pre_authorization is offered: there is nothing for the provider to
      // force-settle against this issuer.
      hub.send({ type: 'contract', to: msg.bid.provider, contract,
                 sig: sign(id.privateKey, contract), pub: id.pub });
      log(`decoy ${ctx.contract_id} awarded to ${msg.bid.provider.slice(0, 18)} ` +
          `@ ${msg.bid.price_cc} CC`);
      break;
    }

    case 'delivery': {
      const ctx = open.get(msg.delivery.contract_id);
      if (!ctx || ctx.fanned) break;
      const seedRoot = cpRoots.get(ctx.seedCp);
      if (seedRoot === undefined) break;   // wait for the seed checkpoint
      ctx.fanned = true;
      ctx.seedRoot = seedRoot;
      const dids = new Set(panelLib.deriveDids(
        ctx.pool.map((v) => v.did), ctx.contract_id, seedRoot));
      ctx.panel = ctx.pool.filter((v) => dids.has(v.did));
      ctx.commits = new Map();
      for (const v of ctx.panel) {
        const request = {
          contract_id: ctx.contract_id, requester: id.did, provider: ctx.provider,
          output: msg.delivery.output, asserts: IMPOSSIBLE_ASSERTS,
          asserts_hash: assertsHash(IMPOSSIBLE_ASSERTS),
          panel_seed_cp: ctx.seedCp,
          payload_box: seal(v.box_pub, ctx.payload),
        };
        hub.send({ type: 'verify_request', to: v.did, request,
                   sig: sign(id.privateKey, request), pub: id.pub });
      }
      log(`decoy ${ctx.contract_id} delivered → panel of ${ctx.panel.length} ` +
          `(correct verdict is FAIL)`);
      setTimeout(() => reveal(ctx.contract_id), cfg.revealGraceMs || 3000);
      break;
    }

    case 'attestation_commit': {
      const ctx = open.get(msg.commit.contract_id);
      if (!ctx || !ctx.commits) break;
      if (!verify(msg.pub, msg.commit, msg.sig)) break;
      ctx.commits.set(msg.commit.verifier,
        { commitment: msg.commit.commitment, commit_sig: msg.sig });
      if (ctx.panel && ctx.commits.size >= ctx.panel.length) reveal(ctx.contract_id);
      break;
    }

    case 'attestation': {
      const a = msg.attestation;
      const ctx = open.get(a && a.contract_id);
      if (!ctx || !ctx.commits) break;
      const held = ctx.commits.get(a.verifier);
      if (!held) break;
      if (typeof msg.nonce !== 'string' ||
          sha256(canon(a) + msg.nonce) !== held.commitment) {
        log(`REJECT reveal from ${a.verifier.slice(0, 18)}: does not open its commitment`);
        break;
      }
      ctx.attest = ctx.attest || [];
      if (ctx.attest.some((x) => x.attestation.verifier === a.verifier)) break;
      ctx.attest.push({ attestation: a, sig: msg.sig, nonce: msg.nonce,
                        commitment: held.commitment, commit_sig: held.commit_sig });
      if (ctx.attest.length >= ctx.panel.length) report(ctx.contract_id);
      break;
    }

    case 'canary_scored':
      log(`hub scored ${msg.contract_id}: ${msg.wrong} 位投 PASS（應為 FAIL）` +
          `，${msg.slashed} 位達到證據門檻被沒收押注`);
      break;

    case 'error': log(`hub error: ${msg.why} (${msg.ref})`); break;
  }
});

function reveal(contractId) {
  const ctx = open.get(contractId);
  if (!ctx || ctx.revealed || !ctx.commits || ctx.commits.size < 2) return;
  ctx.revealed = true;
  const body = { contract_id: contractId, reveal: true };
  const sig = sign(id.privateKey, body);
  for (const v of ctx.panel) {
    if (!ctx.commits.has(v.did)) continue;
    hub.send({ type: 'reveal_request', to: v.did, contract_id: contractId,
               requester: id.did, provider: ctx.provider, sig, pub: id.pub });
  }
  // Report on whatever revealed, so one silent verifier cannot bury the audit.
  setTimeout(() => report(contractId), 2500);
}

function report(contractId) {
  const ctx = open.get(contractId);
  if (!ctx || ctx.reported || !ctx.attest || !ctx.attest.length) return;
  ctx.reported = true;
  const wrong = ctx.attest.filter((x) => x.attestation.verdict === 'PASS').length;
  const reportBody = {
    contract_id: contractId, issuer: id.did, provider: ctx.provider,
    price_cc: ctx.price_cc, expected_verdict: 'FAIL',
    verifier_pool: ctx.pool.map((v) => v.did),
    verifier_pool_hash: panelLib.poolHash(ctx.pool.map((v) => v.did)),
    seed_root: ctx.seedRoot,
  };
  hub.send({ type: 'canary_result', report: reportBody,
             sig: sign(id.privateKey, reportBody), attestations: ctx.attest });
  log(`reported ${contractId}: ${ctx.attest.length} 份裁決，${wrong} 份錯誤（投 PASS）`);
  open.delete(contractId);
}

function post() {
  const pool = [...(verifierDir.verifiers || [])];
  if (pool.length < panelLib.PANEL_SIZE) {
    log(`skipping: judge-quorum needs ${panelLib.PANEL_SIZE} verifiers, ${pool.length} online`);
    return;
  }
  seq += 1;
  hub.send({ type: 'list_verifiers' });
  const taskId = `canary-${id.did.slice(-8)}-${seq}`;
  const contractId = `c-${taskId}`;
  const seedCp = verifierDir.next_checkpoint_seq != null
    ? verifierDir.next_checkpoint_seq : 0;
  const payload = `canary ${seq}: decoy with unsatisfiable asserts`;
  const task = {
    task_id: taskId, requester: id.did, units: UNITS,
    max_price_cc: MAX_PRICE_CC,
    acceptance: { method: 'judge-quorum', asserts_hash: assertsHash(IMPOSSIBLE_ASSERTS) },
  };
  open.set(contractId, {
    contract_id: contractId, payload, pool, seedCp, lock: verifierDir.lock,
    maxPriceCC: MAX_PRICE_CC, attest: [],
  });
  hub.send({ type: 'task', task, sig: sign(id.privateKey, task), pub: id.pub });
  log(`posted decoy ${taskId} (${UNITS}u, max ${MAX_PRICE_CC} CC)`);
}

const regBody = { did: id.did, pub: id.pub, box_pub: box.boxPub };
hub.send({ type: 'register', ...regBody, sig: sign(id.privateKey, regBody) });
console.log(`DID ${name} ${id.did}`);
console.log(`→ 在 Hub 設 HUB_CANARY_DID=${id.did} 後重啟 Hub，否則報告會被拒絕`);

hub.send({ type: 'list_verifiers' });
setTimeout(() => setInterval(post, EVERY_MS).unref(), 2000);
setTimeout(post, 2500);
