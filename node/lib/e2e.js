// E2E payload encryption (NFR-005): X25519 ECDH (ephemeral) + HKDF-SHA256
// + AES-256-GCM. The hub relays sealed boxes and sees only metadata.
'use strict';
const crypto = require('node:crypto');

function genBoxKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    boxPub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    boxPriv: privateKey,
  };
}

const derPub = (b64) => crypto.createPublicKey({
  key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki',
});

function seal(recipientBoxPubB64, plaintext) {
  const eph = crypto.generateKeyPairSync('x25519');
  const secret = crypto.diffieHellman({
    privateKey: eph.privateKey, publicKey: derPub(recipientBoxPubB64),
  });
  const key = Buffer.from(
    crypto.hkdfSync('sha256', secret, Buffer.alloc(0), 'amcn-e2e-v1', 32));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return {
    epk: eph.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
  };
}

function open(boxPriv, box) {
  const secret = crypto.diffieHellman({
    privateKey: boxPriv, publicKey: derPub(box.epk),
  });
  const key = Buffer.from(
    crypto.hkdfSync('sha256', secret, Buffer.alloc(0), 'amcn-e2e-v1', 32));
  const d = crypto.createDecipheriv('aes-256-gcm', key,
    Buffer.from(box.iv, 'base64'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat(
    [d.update(Buffer.from(box.ct, 'base64')), d.final()]).toString('utf8');
}

module.exports = { genBoxKeys, seal, open };
