// Verifier Agent: fixed at contract time (FR-041), runs the contract's
// locked assert set and signs an attestation with machine-readable
// verdict (FR-044). Deterministic judge for the prototype; an LLM judge
// slots in behind the same message flow.
//
// env AGENT_CONFIG: { name, hubPort, hubHost?, hubPin?, beaconPort? }
// hubHost "discover" uses the UDP beacon instead of a hand-copied IP.
'use strict';
const { genIdentity, identityFromSeed, sign, verify, sha256, canon,
        connectLazy } = require('./lib/wire');
const crypto = require('node:crypto');
const discovery = require('./lib/discovery');
const { genBoxKeys, open } = require('./lib/e2e');
const { runAsserts, assertsHash } = require('./lib/dsl');

// Same resolution as agent.js: env for scripted runs, a file path for
// humans. configs/verifier.example.json shipped from the first commit but
// nothing could load it — env was the only path, which also meant every
// verifier had to be started with shell-quoted JSON (a real obstacle on
// PowerShell, where bash's single-quote form does not work).
const cfg = process.env.AGENT_CONFIG
  ? JSON.parse(process.env.AGENT_CONFIG)
  : JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
// A verifier without a stable identity abandons its escrowed stake on
// every restart (§4 #28), which is the same hole as #17 wearing a
// different hat — and it would make the stake unenforceable by simply
// restarting.
const id = cfg.seed ? identityFromSeed(cfg.seed) : genIdentity();
const box = genBoxKeys();
const log = (m) => console.log(`[${cfg.name} ${id.did}] ${m}`);
// contract_id -> {attestation, nonce, commitment, commitSig} held between
// commit and reveal.
const pending = new Map();

const hub = connectLazy(discovery.resolveHubTarget(cfg, log), (msg) => {
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
      // cfg.alwaysPass models the verifier the canary exists to catch: it
      // collects the fee and votes PASS without regard to the asserts. Same
      // kind of scaffolding as agent.js's refuseToSettle for T-05 — a real
      // adversary is not going to volunteer for the test.
      const verdict = cfg.alwaysPass ? 'PASS' : (pass ? 'PASS' : 'FAIL');
      const attestation = {
        contract_id: r.contract_id,
        verifier: id.did,
        verdict,
        failures: cfg.alwaysPass ? [] : failures, // FR-044 machine-readable
      };
      // commit-reveal (§2.2, fixes the other half of §4 #6): publish a
      // binding hash of the verdict first. Without it, a verifier that sees
      // the others' verdicts first can just copy the majority, which is both
      // free and unfalsifiable — the panel would look like three independent
      // checks while being one.
      const nonce = crypto.randomBytes(16).toString('base64');
      const commitment = sha256(canon(attestation) + nonce);
      pending.set(r.contract_id, { attestation, nonce, commitment });
      const commitBody = { contract_id: r.contract_id, verifier: id.did, commitment };
      const commitSig = sign(id.privateKey, commitBody);
      pending.get(r.contract_id).commitSig = commitSig;
      for (const to of [r.requester, r.provider]) {
        hub.send({ type: 'attestation_commit', to, commit: commitBody,
                   sig: commitSig, pub: id.pub });
      }
      log(`committed ${r.contract_id}: ${commitment.slice(0, 12)}…` +
          (cfg.alwaysPass ? ' (lazy: votes PASS regardless)' : ''));
      break;
    }

    case 'reveal_request': {
      const p = pending.get(msg.contract_id);
      if (!p) break;
      if (!verify(msg.pub, { contract_id: msg.contract_id, reveal: true }, msg.sig)) break;
      const sig = sign(id.privateKey, p.attestation);
      for (const to of [msg.requester, msg.provider]) {
        hub.send({ type: 'attestation', to, attestation: p.attestation, sig,
                   nonce: p.nonce, commitment: p.commitment,
                   commit_sig: p.commitSig, pub: id.pub });
      }
      log(`revealed ${msg.contract_id}: ${p.attestation.verdict}`);
      break;
    }
  }
});

const regBody = { did: id.did, pub: id.pub, box_pub: box.boxPub, role: 'verifier' };
hub.send({ type: 'register', ...regBody, sig: sign(id.privateKey, regBody) });
console.log(`DID ${cfg.name} ${id.did}`);
