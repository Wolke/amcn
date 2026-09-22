// Identity + crypto helpers for the Phase 1 closed-loop prototype.
// Zero dependencies: node:crypto Ed25519.
//
// Framing and connections used to live here too, hard-wired to node:net.
// They moved to lib/channel.js and lib/transport-*.js so the transport layer
// has the alternative implementation §2.1 requires of it (§4 #10); what is
// left here is what every transport shares and none may redefine.
'use strict';
const crypto = require('node:crypto');

// --- identity ---------------------------------------------------------
function genIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const did = 'did:demo:' +
    crypto.createHash('sha256').update(pub).digest('hex').slice(0, 16);
  return { did, pub, privateKey };
}

// A reproducible identity from a seed. Needed because an authorisation like
// HUB_CANARY_DID has to be configured on the hub *before* the authorised
// process starts, which is impossible while every start draws a fresh
// keypair. Also the first step toward §4 #17: identities that survive a
// restart instead of leaving abandoned balances behind.
//
// The DER prefix is the fixed PKCS#8 header for an Ed25519 private key, so
// the 32-byte seed is the whole secret.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function identityFromSeed(seed) {
  const raw = crypto.createHash('sha256').update(String(seed)).digest();
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, raw]),
    format: 'der', type: 'pkcs8',
  });
  const pub = crypto.createPublicKey(privateKey)
    .export({ type: 'spki', format: 'der' }).toString('base64');
  const did = 'did:demo:' +
    crypto.createHash('sha256').update(pub).digest('hex').slice(0, 16);
  return { did, pub, privateKey };
}

// deterministic JSON: sorted keys, so signatures are stable
function canon(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canon).join(',') + ']';
  return '{' + Object.keys(obj).sort()
    .map((k) => JSON.stringify(k) + ':' + canon(obj[k])).join(',') + '}';
}

function sign(privateKey, obj) {
  return crypto.sign(null, Buffer.from(canon(obj)), privateKey).toString('base64');
}

// Inputs are attacker-controlled (any LAN peer can send a frame), so a
// malformed key or signature must be a failed verification, never a throw:
// createPublicKey() rejects bad DER by throwing, which would otherwise escape
// the socket 'data' handler and kill the process.
function verify(pubB64, obj, sigB64) {
  if (typeof pubB64 !== 'string' || typeof sigB64 !== 'string') return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(pubB64, 'base64'), type: 'spki', format: 'der',
    });
    return crypto.verify(null, Buffer.from(canon(obj)), key,
      Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key, s) =>
  crypto.createHmac('sha256', key).update(s).digest('hex').slice(0, 16);

// --- protocol version -------------------------------------------------
// §4 #33 / NFR-004. Carried on the message envelope, not inside signed
// bodies: receipt/contract/pre_auth signatures are computed over those exact
// objects, so adding a field to them would invalidate every signature and
// force both parties to agree on placement. The envelope is unsigned relay
// metadata, which is what a version negotiation needs anyway.
//
// A mismatch used to be a crash: a pre-W9 provider read c.verifiers.length on
// a W9 contract that no longer had the field and died mid-contract, taking
// the requester with it. Now it is a logged rejection.
// v2: registration became a three-way handshake (register → registered →
// register_ack). A v1 client would register, never acknowledge, and sit
// permanently not-online — a silent failure, which is precisely what the
// version gate exists to convert into a loud one.
// v3: receipts must declare tx_class (§20-9). A v2 client's receipt would
// otherwise be refused by the schedule validator with a confusing message
// instead of at the version gate, which is what #33 exists to prevent.
// v4: task/bid/contract/pre_authorization carry issued_at and expires_at,
// and the hub enforces them (§16 威脅 8). A v3 client's objects have no
// expiry; they would still be accepted, but a v3 *hub* would ignore a v4
// client's expiry entirely, which is the direction that matters.
// v5: collateral_post / collateral_release, and the credit line takes a
// collateral term with a haircut (#65). A v4 hub would ignore the messages
// entirely and the client would wait for an answer that never comes.
// v7: stake_release（#38）。押注從前只進不出，所以「不退押注」在原型裡沒有
// 對照面；v7 加上退還路徑（被測夠且通過率過關者可取回，取回即退出 pool）。
// 與 v5 同一個理由要升版：v6 的 Hub 會完全忽略這個訊息，而送出方會等一個
// 永遠不會來的答覆。
const PROTOCOL_VERSION = 7;   // v7：stake_release（#38）

module.exports = {
  genIdentity, identityFromSeed, canon, sign, verify, sha256, hmac,
  PROTOCOL_VERSION,
};
