// ITransport implementation 4: an encrypted, identity-authenticated channel
// (§4 #44).
//
// Messages are signed and payloads are end-to-end encrypted (NFR-005), but
// the envelope has always been plaintext: who traded with whom, for how
// much, when, under which acceptance method, and every DID. On a trusted LAN
// that is a documented trade-off (INSTALL §8). The acceptance environment is
// machines in different places, so the traffic crosses the public internet
// and §16 threat 9 — "metadata leaks the owner's identity, work content and
// model usage" — is open to anyone on the path.
//
// This is not TLS, and the choice is deliberate. Node cannot mint an X.509
// certificate without either shelling out to openssl (not available
// everywhere, and this project ships zero dependencies) or hand-rolling an
// ASN.1 encoder for a security-critical artefact. More importantly a
// certificate chain is the wrong trust anchor here: there is no CA in this
// system, and clients already pin a hub by its DID. So the handshake
// authenticates the *identity* directly, with the same primitives lib/e2e.js
// already uses for payloads: ephemeral X25519 → HKDF → AES-256-GCM, with the
// ephemeral key signed by the long-term Ed25519 identity.
//
// What it protects: an observer on the path sees only frame timing and size.
// What it does not: the hub itself still sees metadata — that is what it is
// for, and why payloads stay end-to-end encrypted and receipts stay signed.
// These are different attackers and both layers are needed.
//
//   AMCN_TRANSPORT=secure
//   AMCN_SECURE_BASE=tcp|http   (default tcp)
//   AMCN_SECURE_SEED=<string>   this node's channel identity (the hub should
//                               reuse HUB_SEED so its DID is stable)
//   AMCN_SECURE_PIN=did:demo:…  refuse to speak to anyone else
'use strict';
const crypto = require('node:crypto');
const { sign, verify, genIdentity, identityFromSeed, sha256 } = require('./wire');

const name = 'secure';
const base = () => require('./transport').get(process.env.AMCN_SECURE_BASE || 'tcp');
const didOf = (pub) => 'did:demo:' + sha256(pub).slice(0, 16);

const id = () => (process.env.AMCN_SECURE_SEED
  ? identityFromSeed(process.env.AMCN_SECURE_SEED)
  : (module.exports._id || (module.exports._id = genIdentity())));

const derPub = (b64) => crypto.createPublicKey({
  key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki',
});

function hello(me) {
  const eph = crypto.generateKeyPairSync('x25519');
  const epk = eph.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const body = { type: 'sec_hello', epk, pub: me.pub, ts: Date.now() };
  return { eph, frame: { ...body, sig: sign(me.privateKey, body) } };
}

// Keys are directional and bound to both halves of the handshake, so a
// recorded frame cannot be replayed into the other direction or another
// session.
function derive(ephPriv, peerEpk, label, a, b) {
  const secret = crypto.diffieHellman({ privateKey: ephPriv, publicKey: derPub(peerEpk) });
  const info = `amcn-sec-v1:${label}:${a}:${b}`;
  return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), info, 32));
}

function seal(key, text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return JSON.stringify({ t: 'sec', i: iv.toString('base64'),
    c: ct.toString('base64'), g: c.getAuthTag().toString('base64') }) + '\n';
}

function unseal(key, obj) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(obj.i, 'base64'));
  d.setAuthTag(Buffer.from(obj.g, 'base64'));
  return Buffer.concat([d.update(Buffer.from(obj.c, 'base64')), d.final()]).toString('utf8');
}

// One handshake state machine, used by both ends. Until it completes,
// outbound plaintext is held; inbound is expected to be the peer's hello.
const dbg = process.env.AMCN_SECURE_DEBUG
  ? (...a) => console.error('[secure]', ...a) : () => {};

function secure(me, { pin = null, onReady = () => {} } = {}) {
  let sendKey = null, recvKey = null, peerDid = null;
  let out = '';                      // plaintext queued during the handshake
  let inbuf = '';
  const mine = hello(me);
  let deliverBytes = null;           // set when the base channel exists

  return {
    get ready() { return !!sendKey; },
    get peerDid() { return peerDid; },
    helloFrame: JSON.stringify(mine.frame) + '\n',

    // hook: outbound plaintext → ciphertext (or queue until ready)
    onWrite: (text, deliver) => {
      deliverBytes = deliver;
      if (!sendKey) { dbg('queueing', text.length, 'bytes (no key yet)'); out += text; return; }
      dbg('encrypting', text.length, 'bytes');
      for (const line of text.split('\n')) {
        if (line) deliver(seal(sendKey, line));
      }
    },

    // hook: inbound bytes → plaintext for the framer
    onData: (text, deliver) => {
      inbuf += text;
      let i;
      while ((i = inbuf.indexOf('\n')) >= 0) {
        const line = inbuf.slice(0, i);
        inbuf = inbuf.slice(i + 1);
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }

        if (obj.type === 'sec_hello') {
          const { sig, ...body } = obj;
          if (!verify(obj.pub, body, sig)) {
            console.error('[secure] handshake rejected: bad signature');
            return;
          }
          peerDid = didOf(obj.pub);
          if (pin && pin !== peerDid) {
            console.error(`[secure] handshake rejected: peer is ${peerDid}, ` +
              `not the pinned ${pin}`);
            return;
          }
          // Direction labels keep the two keys distinct; the DIDs bind them
          // to this pair so a transcript cannot be replayed elsewhere.
          const meDid = didOf(me.pub);
          sendKey = derive(mine.eph.privateKey, obj.epk, 'c2s', meDid, peerDid);
          recvKey = derive(mine.eph.privateKey, obj.epk, 'c2s', peerDid, meDid);
          const flush = out; out = '';
          if (flush && deliverBytes) {
            for (const l of flush.split('\n')) {
              if (l) deliverBytes(seal(sendKey, l));
            }
          }
          dbg('handshake done with', peerDid, 'keys set');
          onReady(peerDid);
          continue;
        }
        dbg('inbound line type', obj.type || obj.t, 'recvKey?', !!recvKey);
        if (obj.t === 'sec') {
          if (!recvKey) { console.error('[secure] ciphertext before handshake'); continue; }
          try { deliver(unseal(recvKey, obj) + '\n'); }
          catch { console.error('[secure] undecryptable frame dropped'); }
          continue;
        }
        console.error(`[secure] refusing plaintext frame (${obj.type || obj.t})`);
      }
    },
  };
}

function listen({ port, host, onChannel, onError, onListening }) {
  const me = id();
  return base().listen({
    port, host, onError, onListening, onChannel,
    // One handshake per connection, greeting immediately in plaintext:
    // the client has to learn who it is talking to before it sends
    // anything, and the greeting itself cannot be encrypted with a key
    // that does not exist yet.
    hooks: (chan, rawWrite) => {
      const sec = secure(me, {});
      rawWrite(sec.helloFrame);
      return { onWrite: sec.onWrite, onData: sec.onData };
    },
  });
}

function dial(target) {
  const me = id();
  const pin = process.env.AMCN_SECURE_PIN || target.pin || null;
  return base().dial({
    ...target,
    hooks: (chan, rawWrite) => {
      const sec = secure(me, { pin });
      rawWrite(sec.helloFrame);
      return { onWrite: sec.onWrite, onData: sec.onData };
    },
  });
}

const probe = (target) => base().probe(target);

module.exports = { name, listen, dial, probe, secure, didOf };
