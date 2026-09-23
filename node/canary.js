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
const { genIdentity, identityFromSeed, sign, verify, sha256,
        canon } = require('./lib/wire');
const transport = require('./lib/transport').fromEnv();
require('./lib/log').install();
const { genBoxKeys, seal } = require('./lib/e2e');
const { assertsHash } = require('./lib/dsl');
const discovery = require('./lib/discovery');
const panelLib = require('./lib/panel');

const cfg = process.env.AGENT_CONFIG
  ? JSON.parse(process.env.AGENT_CONFIG)
  : JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));

const IMPOSSIBLE_ASSERTS = [{ op: 'max_len', arg: 1 }];
// 入門採購模式（#90）。同一個流程、同一個問責標準，只有兩件事相反：
// 斷言是**可以通過**的（而且是確定性的，所以發樁者自己算得出正確答案），
// 正確裁決因此是 PASS。金絲雀抓的是「不做事的 verifier」，入門採購買的是
// 「新人的第一次真交付」——兩者都靠「答案已知」這一件事才成立，所以共用
// 這支程式而不是各寫一份。
const ONBOARD_ASSERTS = [{ op: 'sha256_eq' }, { op: 'max_len', arg: 64 }];
const MODE = cfg.mode === 'onboard' ? 'onboard' : 'canary';
const ASSERTS = MODE === 'onboard' ? ONBOARD_ASSERTS : IMPOSSIBLE_ASSERTS;
const WANT = MODE === 'onboard' ? 'PASS' : 'FAIL';
const REPORT_TYPE = MODE === 'onboard' ? 'onboard_result' : 'canary_result';
const HUB_ENV = MODE === 'onboard' ? 'HUB_ONBOARD_DID' : 'HUB_CANARY_DID';

// A seeded identity, so HUB_CANARY_DID can be configured once: the hub has
// to authorise this DID before this process starts, which a fresh keypair
// every run makes impossible.
const id = cfg.seed ? identityFromSeed(cfg.seed) : genIdentity();
if (!cfg.seed) {
  console.log('警告：未設 seed，DID 每次啟動都會變，' +
    `${HUB_ENV} 會失效——正式使用請設 cfg.seed`);
}
const box = genBoxKeys();
const name = cfg.name || 'canary';
const log = (m) => console.log(`[${name} ${id.did}] ${m}`);

// An assert set no honest output can satisfy, so FAIL is the only correct
// verdict. Kept deliberately simple: a verifier that runs the DSL at all
// gets this right.
const UNITS = cfg.units || 2;
const MAX_PRICE_CC = cfg.maxPriceCC || UNITS * 1.3;
const EVERY_MS = cfg.everyMs || 8000;
// 入門採購的資格（「從沒收過 CC」）是在**交付之後**才由 Hub 檢查的（#100），
// 所以當線上所有帳戶都已經賺過錢時，這支會每 everyMs 發一輪、對方做一次工、
// 然後被拒絕——實測 live 節點 10 分鐘 10 筆全被拒。退避讓它安靜下來，而且
// 有人加入時會自己恢復（成功一次就重設）。
let rejectStreak = 0;
let backoffUntil = 0;
const BACKOFF_MAX_MS = Number(process.env.HUB_ONBOARD_BACKOFF_MAX_MS || 600000);

const open = new Map();   // contract_id -> {panel, commits, attest, provider, seedRoot}
const cpRoots = new Map();
let verifierDir = { verifiers: [], lock: null };
let seq = 0;

const regBody = { did: id.did, pub: id.pub, box_pub: box.boxPub };

const hub = transport.dialLazy(() => discovery.resolveHubTarget(cfg, log), {
  // Everything needed to be usable on this connection, because sends while
  // disconnected are dropped rather than queued. The directory request used
  // to sit at module scope and rely on the pre-connect queue; it also has to
  // be re-asked after a reconnect, since the pool and the checkpoint lock
  // both move while a client is away.
  onOpen: () => {
    hub.send({ type: 'register', ...regBody, sig: sign(id.privateKey, regBody) });
    hub.send({ type: 'list_verifiers' });
  },
  label: name,
  // Registration is a handshake, not a broadcast: retried until the hub
  // answers, because one lost frame used to leave a live but anonymous
  // connection that nothing ever noticed.
  ackType: 'registered',
  onMessage: (msg) => {
    switch (msg.type) {
      case 'registered':
        // The hub cannot tell a healthy client from one that only
        // talks unless the client proves it heard the reply (#49).
        hub.send({ type: 'register_ack', did: id.did });  // proof we can hear (#49)
        log(`registered as canary issuer, hub credit line ${msg.credit_line.toFixed(1)} CC`);
        log('若 Hub 未設 HUB_CANARY_DID 為上面這個 DID，報告會被拒絕');
        break;

      case 'onboard_paid': {
        // 有人真的通過了 → 市場狀態變了，退避解除。沒有這一條，退避就是一個
        // 只會變長的計時器（而那等於把發樁者關掉）。
        if (rejectStreak) {
          log(`有符合資格的新人了（${(msg.provider || '').slice(0, 18)}…）——退避解除`);
        }
        rejectStreak = 0;
        backoffUntil = 0;
        break;
      }

      case 'error': {
        // Hub 拒絕了一份報告。最常見的理由是「沒有符合資格的新人」，而那不是
        // 錯誤而是**市場狀態**——它值得說一次，然後閉嘴。
        if (MODE === 'onboard' && /never been paid/.test(msg.why || '')) {
          rejectStreak += 1;
          const wait = Math.min(BACKOFF_MAX_MS, EVERY_MS * 2 ** rejectStreak);
          backoffUntil = Date.now() + wait;
          if (rejectStreak === 1) {
            log('目前沒有符合資格的新人：線上的帳戶都已經賺過 CC，而入門採購只買' +
              '「從沒收過 CC 的身分」的第一份工作。這不是錯誤，是市場狀態——' +
              `改成每 ${Math.round(wait / 1000)}s 試一次，有人加入就會自己恢復。`);
          }
        } else {
          log(`Hub 拒絕：${msg.why}`);
        }
        break;
      }

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
          acceptance: { method: 'judge-quorum', asserts_hash: assertsHash(ASSERTS) },
          asserts: ASSERTS,
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
            output: msg.delivery.output, asserts: ASSERTS,
            asserts_hash: assertsHash(ASSERTS),
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
  },
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
  const passes = ctx.attest.filter((x) => x.attestation.verdict === 'PASS').length;
  const reportBody = {
    contract_id: contractId, issuer: id.did, provider: ctx.provider,
    price_cc: ctx.price_cc, expected_verdict: WANT,
    verifier_pool: ctx.pool.map((v) => v.did),
    verifier_pool_hash: panelLib.poolHash(ctx.pool.map((v) => v.did)),
    seed_root: ctx.seedRoot,
    // 入門採購要把斷言集一起送出：Hub 會檢查它含確定性斷言，否則那筆錢
    // 就是換個名目白給（登記簿 #90 的條件 i）。
    //
    // `outcome` 是**這一次面板的實際裁決**，而 `expected_verdict` 是「這份
    // 任務的正確答案是什麼」——兩個不同的東西。失敗也要報上來，因為 Hub
    // 要算「連續通過幾次」：實測連續 1 次時攻擊者每身分還能矇到 5.52 CC，
    // 連續 3 次才壓到 0.00（而誠實新人只從 196 人掉到 187 人）。只報成功
    // 的話 Hub 永遠算不出連續，那個旋鈕就不存在。
    ...(MODE === 'onboard'
      ? { asserts: ASSERTS, outcome: passes >= 2 ? 'PASS' : 'FAIL' }
      : {}),
  };
  hub.send({ type: REPORT_TYPE, report: reportBody,
             sig: sign(id.privateKey, reportBody), attestations: ctx.attest });
  log(MODE === 'onboard'
    ? `reported ${contractId}: ${ctx.attest.length} 份裁決，${passes} 份 PASS（期望 PASS）`
    : `reported ${contractId}: ${ctx.attest.length} 份裁決，${passes} 份錯誤（投 PASS）`);
  open.delete(contractId);
}

function post() {
  if (Date.now() < backoffUntil) return;
  const pool = [...(verifierDir.verifiers || [])];
  if (pool.length < panelLib.PANEL_SIZE) {
    log(`skipping: judge-quorum needs ${panelLib.PANEL_SIZE} verifiers, ${pool.length} online`);
    return;
  }
  seq += 1;
  hub.send({ type: 'list_verifiers' });
  const taskId = `${MODE}-${id.did.slice(-8)}-${seq}`;
  const contractId = `c-${taskId}`;
  const seedCp = verifierDir.next_checkpoint_seq != null
    ? verifierDir.next_checkpoint_seq : 0;
  const payload = MODE === 'onboard'
    ? `onboarding ${seq}: prove you can do the work (answer = sha256 of this)`
    : `canary ${seq}: decoy with unsatisfiable asserts`;
  const task = {
    task_id: taskId, requester: id.did, units: UNITS,
    max_price_cc: MAX_PRICE_CC,
    acceptance: { method: 'judge-quorum', asserts_hash: assertsHash(ASSERTS) },
  };
  open.set(contractId, {
    contract_id: contractId, payload, pool, seedCp, lock: verifierDir.lock,
    maxPriceCC: MAX_PRICE_CC, attest: [],
  });
  hub.send({ type: 'task', task, sig: sign(id.privateKey, task), pub: id.pub });
  log(`posted ${MODE === 'onboard' ? 'onboarding task' : 'decoy'} ${taskId} ` +
    `(${UNITS}u, max ${MAX_PRICE_CC} CC)`);
}


console.log(`DID ${name} ${id.did}`);
console.log(`→ 在 Hub 設 ${HUB_ENV}=${id.did} 後重啟 Hub，否則報告會被拒絕`);

setTimeout(() => setInterval(post, EVERY_MS).unref(), 2000);
setTimeout(post, 2500);
