// Verifier Agent: fixed at contract time (FR-041), runs the contract's
// locked assert set and signs an attestation with machine-readable
// verdict (FR-044). Deterministic judge for the prototype; an LLM judge
// slots in behind the same message flow.
//
// env AGENT_CONFIG: { name, hubPort }
'use strict';
const { genIdentity, sign, verify, connect } = require('./lib/wire');
const { genBoxKeys, open } = require('./lib/e2e');
const { runAsserts, assertsHash } = require('./lib/dsl');

const cfg = JSON.parse(process.env.AGENT_CONFIG);
const id = genIdentity();
const box = genBoxKeys();
const log = (m) => console.log(`[${cfg.name} ${id.did}] ${m}`);

const hub = connect(cfg.hubPort, (msg) => {
  switch (msg.type) {
    case 'registered':
      log('registered as verifier');
      break;
    case 'verify_request': {
      const r = msg.request;
      if (!verify(msg.pub, r, msg.sig)) break;
      if (assertsHash(r.asserts) !== r.asserts_hash) {
        log(`REJECT ${r.contract_id}: assert set does not match locked hash`);
        break; // FR-041: the acceptance rules were fixed at contract time
      }
      const payload = open(box.boxPriv, r.payload_box);
      const { pass, failures } = runAsserts(r.asserts, { payload, output: r.output });
      const attestation = {
        contract_id: r.contract_id,
        verifier: id.did,
        verdict: pass ? 'PASS' : 'FAIL',
        failures, // machine-readable reasons (FR-044)
      };
      const sig = sign(id.privateKey, attestation);
      // both parties get a copy (provider needs it for forced settlement)
      for (const to of [r.requester, r.provider]) {
        hub.send({ type: 'attestation', to, attestation, sig, pub: id.pub });
      }
      log(`attested ${r.contract_id}: ${attestation.verdict}`);
      break;
    }
  }
});

const regBody = { did: id.did, pub: id.pub, box_pub: box.boxPub, role: 'verifier' };
hub.send({ type: 'register', ...regBody, sig: sign(id.privateKey, regBody) });
console.log(`DID ${cfg.name} ${id.did}`);
