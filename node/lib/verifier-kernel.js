// 驗證內核（FR-041／FR-044），從 verifier.js 抽出來共用。
//
// 抽出的理由是 #62：verifier 是原型裡唯一的吸收端（`soak-n6` 實測持有
// 210.44 CC、佔全部正餘額 97.5%），而它無處可花不是它的問題——是原型把
// verifier 與 agent 拆成兩個進程造成的。SDD 裡「驗證」是從 pool 抽選的**角色**
// （FR-041），不是另一種物種；擁有 verifier 節點的人一樣想要算力。
//
// 所以內核放在這裡，`verifier.js` 與 `agent.js`（`verify: true`）共用同一份。
// 複製一份會讓兩邊的裁決規則慢慢分岔，而那正是 #60 那一類錯誤的溫床——
// 兩個手抄的實作各自自洽、只有餵同一組輸入才看得出差異。
'use strict';
const crypto = require('node:crypto');
const { sign, verify, sha256, canon } = require('./wire');
const { open } = require('./e2e');
const { runAsserts, assertsHash } = require('./dsl');

// cfg 只用來讀對抗旗標（alwaysPass／silentReveal／copyVerdict），它們與
// agent.js 的 refuseToSettle 同一個模式：真的對手不會自願來測試。
function create({ id, box, log, send, cfg = {} }) {
  // contract_id -> {attestation, nonce, commitment, commitSig}
  const pending = new Map();

  function onVerifyRequest(msg) {
    const r = msg.request;
    if (!verify(msg.pub, r, msg.sig)) return;
    if (assertsHash(r.asserts) !== r.asserts_hash) {
      log(`REJECT ${r.contract_id}: assert set does not match locked hash`);
      return;   // FR-041：驗收規則在合約時就固定了
    }
    const payload = open(box.boxPriv, r.payload_box);
    const { pass, failures } = runAsserts(r.asserts, { payload, output: r.output });
    const verdict = cfg.alwaysPass ? 'PASS' : (pass ? 'PASS' : 'FAIL');
    const attestation = {
      contract_id: r.contract_id,
      verifier: id.did,
      verdict,
      failures: cfg.alwaysPass ? [] : failures,   // FR-044 機器可讀
    };
    // commit-reveal（§2.2，修 #6 的另一半）：先公布裁決的綁定雜湊。沒有它，
    // 先看到別人裁決的 verifier 可以直接抄多數——那既免費又無法證偽，panel
    // 看起來是三個獨立檢查而實際上是一個檢查被抄了三次。
    const nonce = crypto.randomBytes(16).toString('base64');
    const commitment = sha256(canon(attestation) + nonce);
    const commitBody = { contract_id: r.contract_id, verifier: id.did, commitment };
    const commitSig = sign(id.privateKey, commitBody);
    pending.set(r.contract_id, { attestation, nonce, commitment, commitSig });
    for (const to of [r.requester, r.provider]) {
      send({ type: 'attestation_commit', to, commit: commitBody,
             sig: commitSig, pub: id.pub });
    }
    log(`committed ${r.contract_id}: ${commitment.slice(0, 12)}…` +
        (cfg.alwaysPass ? ' (lazy: votes PASS regardless)' : ''));
  }

  function onRevealRequest(msg) {
    const p = pending.get(msg.contract_id);
    if (!p) return;
    // 承諾後沉默：它應該一毛都拿不到，因為 #26 只付給「揭示內容能開啟事前
    // 承諾」的人。對抗腳架，同 alwaysPass。
    if (cfg.silentReveal) {
      log(`ADVERSARY: committed ${msg.contract_id} and staying silent`);
      return;
    }
    if (!verify(msg.pub, { contract_id: msg.contract_id, reveal: true }, msg.sig)) return;
    // 看完多數再改票（D3）。commit-reveal 正是為此存在，所以應該發生的是
    // 揭示的 attestation 開不了承諾、那一票不被計入。
    const attest = cfg.copyVerdict
      ? { ...p.attestation,
          verdict: p.attestation.verdict === 'PASS' ? 'FAIL' : 'PASS',
          failures: [] }
      : p.attestation;
    if (cfg.copyVerdict) {
      log(`ADVERSARY: committed ${p.attestation.verdict} on ` +
          `${msg.contract_id}, revealing ${attest.verdict} instead`);
    }
    const sig = sign(id.privateKey, attest);
    for (const to of [msg.requester, msg.provider]) {
      send({ type: 'attestation', to, attestation: attest, sig,
             nonce: p.nonce, commitment: p.commitment,
             commit_sig: p.commitSig, pub: id.pub });
    }
    log(`revealed ${msg.contract_id}: ${attest.verdict}`);
  }

  return { onVerifyRequest, onRevealRequest, pending };
}

module.exports = { create };
