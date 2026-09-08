// Wire + crypto helpers for the Phase 1 closed-loop prototype.
// Zero dependencies: node:crypto Ed25519 + TCP JSON-lines.
'use strict';
const crypto = require('node:crypto');
const net = require('node:net');

// --- identity ---------------------------------------------------------
function genIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
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

function verify(pubB64, obj, sigB64) {
  const key = crypto.createPublicKey({
    key: Buffer.from(pubB64, 'base64'), type: 'spki', format: 'der',
  });
  return crypto.verify(null, Buffer.from(canon(obj)), key,
    Buffer.from(sigB64, 'base64'));
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key, s) =>
  crypto.createHmac('sha256', key).update(s).digest('hex').slice(0, 16);

// --- TCP JSON-lines ---------------------------------------------------
function attachLineReader(sock, onMsg, onRaw) {
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      if (onRaw) onRaw(line);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      onMsg(msg, sock);
    }
  });
}

function sendLine(sock, obj) { sock.write(JSON.stringify(obj) + '\n'); }

function connect(port, onMsg) {
  const sock = net.connect(port, '127.0.0.1');
  attachLineReader(sock, onMsg);
  return { sock, send: (obj) => sendLine(sock, obj) };
}

module.exports = {
  genIdentity, canon, sign, verify, sha256, hmac,
  attachLineReader, sendLine, connect, net,
};
