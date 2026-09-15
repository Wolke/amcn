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

// --- TCP JSON-lines ---------------------------------------------------
// A peer that never sends '\n' would otherwise grow buf without bound.
const MAX_LINE = 16 * 1024 * 1024;

function attachLineReader(sock, onMsg, onRaw) {
  let buf = '';
  // Unhandled 'error' on a socket is fatal to the process; a peer that
  // disconnects mid-frame (ECONNRESET) must not be able to do that. Log it
  // rather than swallowing it — silently dropping ECONNREFUSED turns "cannot
  // reach the hub" into a process that prints nothing at all.
  sock.on('error', (err) => {
    console.error(`[wire] socket error: ${err.code || err.message}`);
    sock.destroy();
  });
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      // onRaw first and for every line, parseable or not: it is the hub's
      // full-traffic audit log (the NFR-005 plaintext scan reads it).
      try { if (onRaw) onRaw(line); } catch { /* audit log must not break the reader */ }
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      // Handlers parse untrusted frames; isolate a throw to this one frame
      // so a malformed message degrades to "ignored", not "network down".
      try {
        onMsg(msg, sock);
      } catch (err) {
        console.error(`[wire] dropped frame (${msg && msg.type}): ${err.message}`);
      }
    }
    if (buf.length > MAX_LINE) {
      console.error('[wire] oversized frame, dropping connection');
      buf = '';
      sock.destroy();
    }
  });
}

function sendLine(sock, obj) {
  if (!sock || sock.destroyed) return false;
  sock.write(JSON.stringify(obj) + '\n');
  return true;
}

// The hub address may be unknown at module load (UDP discovery). Hand back a
// handle immediately and queue sends until the socket exists, so callers can
// keep `const hub = connect(...)` at module scope instead of restructuring
// everything into an async bootstrap.
function connectLazy(targetPromise, onMsg) {
  const queued = [];
  let live = null;
  targetPromise.then(({ host, port }) => {
    live = connect(port, onMsg, host);
    while (queued.length) live.send(queued.shift());
  });
  return {
    send: (obj) => { if (live) live.send(obj); else queued.push(obj); },
    get sock() { return live && live.sock; },
  };
}

function connect(port, onMsg, host = '127.0.0.1') {
  const sock = net.connect(port, host);
  attachLineReader(sock, onMsg);
  return { sock, send: (obj) => sendLine(sock, obj) };
}

module.exports = {
  genIdentity, canon, sign, verify, sha256, hmac,
  attachLineReader, sendLine, connect, connectLazy, net,
};
