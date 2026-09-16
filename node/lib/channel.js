// A line-oriented AMCN channel: the one place that knows how a message
// becomes bytes and back.
//
// Both transports (tcp, http) build their channels here on purpose. §2.1
// makes replaceability of the centralised transport layer a binding
// condition, and §20-4 requires the ledger to be rebuildable from signed
// events — so the two transports must produce byte-for-byte the same
// messages, not merely similar ones. Framing, the envelope version gate
// (§4 #33) and handler isolation (§4 #13/#34) therefore live above the
// transport, and a transport only supplies write/close.
'use strict';
const { PROTOCOL_VERSION } = require('./wire');

// A peer that never sends '\n' would otherwise grow buf without bound.
const MAX_LINE = 16 * 1024 * 1024;

// Stamped in one place so no call site can forget it.
function stamp(obj) {
  return obj && obj.v === undefined ? { v: PROTOCOL_VERSION, ...obj } : obj;
}
const frame = (obj) => JSON.stringify(stamp(obj)) + '\n';

// A transport-level refusal, reported by the peer that could not speak our
// framing at all (see the mismatch paths in transport-tcp/transport-http).
// Handled here rather than passed to the application: a mixed-transport
// network is an operator error, and the app has no sensible response to it.
const TRANSPORT_ERROR = 'transport_error';

// --- liveness -----------------------------------------------------------
// Found by fault injection, not by review: under a silent partition (chaos
// `blackhole`) neither side noticed anything for as long as the fault ran.
// After 120 seconds the hub still handed agents a pool of three dead
// verifiers, and the verifiers never learned they were cut off, so #40's
// reconnect never fired. Contracts would be awarded that could never settle,
// with no log line anywhere explaining why — the state #37 called the worst
// one to diagnose.
//
// TCP keepalive alone does not fix this: node's setKeepAlive only sets the
// idle time, while the probe interval and count come from the OS (macOS
// defaults work out to ten minutes), and it cannot see a peer whose socket is
// alive but whose application has wedged. So liveness is application-level
// and symmetric: send a ping when the channel has been idle, and declare the
// peer gone when nothing has arrived for the timeout. A hub that stops
// hearing from an agent closes the channel, which marks it offline (#35); a
// client that stops hearing from the hub closes too, which starts
// reconnecting (#40). One implementation, both directions, both transports.
const HEARTBEAT_MS = Number(process.env.AMCN_HEARTBEAT_MS || 5000);
const IDLE_TIMEOUT_MS = Number(process.env.AMCN_IDLE_TIMEOUT_MS || 20000);
const PING = 'ping';

function createChannel({ remote, write, close, isClosed, label = 'wire',
                        heartbeat = true }) {
  const onMsg = [], onRaw = [], onClose = [];
  let buf = '';
  let localClosed = false, closeEmitted = false;
  let lastRecvAt = Date.now(), lastSendAt = 0;
  let beat = null;

  const chan = {
    remote: remote || '(unknown)',
    get destroyed() { return localClosed || isClosed(); },

    send(obj) {
      if (chan.destroyed) return false;
      lastSendAt = Date.now();
      write(frame(obj));
      return true;
    },
    // Raw, unstamped, unvalidated. Only for probes that must put an exact
    // byte sequence on the wire — the malformed-frame and wrong-version
    // regression gates in demo.js.
    sendRaw(line) {
      if (chan.destroyed) return false;
      write(line + '\n');
      return true;
    },

    onMessage(fn) { onMsg.push(fn); return chan; },
    // Every line, parseable or not: the hub's full-traffic audit log (the
    // NFR-005 plaintext scan reads it).
    onRaw(fn) { onRaw.push(fn); return chan; },
    onClose(fn) { onClose.push(fn); return chan; },

    close() {
      if (localClosed) return;
      localClosed = true;
      if (beat) clearInterval(beat);
      try { close(); } catch { /* already gone */ }
    },

    // Called by the transport when the underlying connection is really gone.
    emitClose() {
      if (beat) clearInterval(beat);
      if (closeEmitted) return;
      closeEmitted = true;
      localClosed = true;
      for (const fn of onClose) {
        try { fn(); } catch (err) {
          console.error(`[${label}] close handler threw: ${err.message}`);
        }
      }
    },

    feed(text) {
      buf += text;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        // Blank lines are the http transport's keepalive, and harmless noise
        // on any transport.
        if (!line.trim()) continue;
        // Pings carry no protocol content and would multiply the hub's audit
        // log, which is included in every export (#41).
        if (line.includes(`"type":"${PING}"`)) {
          lastRecvAt = Date.now();
          continue;
        }
        for (const fn of onRaw) {
          try { fn(line); } catch { /* audit log must not break the reader */ }
        }
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        lastRecvAt = Date.now();
        // Liveness only; never reaches a handler, and deliberately not
        // recorded as protocol traffic below either.
        if (msg && msg.type === PING) continue;
        if (msg && msg.type === TRANSPORT_ERROR) {
          console.error(`[transport] ${chan.remote} refused us: ${msg.why}`);
          continue;
        }
        // Refuse before a handler can misread a shape it does not know. An
        // absent v means a node older than versioning itself.
        if (msg && msg.v !== PROTOCOL_VERSION) {
          console.error(`[${label}] rejected ${msg.type || 'frame'}: protocol v` +
            `${msg.v === undefined ? '(none)' : msg.v} — this node speaks v` +
            `${PROTOCOL_VERSION}. Upgrade every machine, not one of them.`);
          continue;
        }
        for (const fn of onMsg) {
          // Handlers parse untrusted frames; isolate a throw to this one
          // frame so a malformed message degrades to "ignored", not
          // "network down".
          try {
            const r = fn(msg, chan);
            // agent.js's handler is async, and an async throw becomes an
            // unhandled rejection that kills the process. A pre-W9 provider
            // receiving a W9 contract died exactly this way, mid-contract,
            // on a live pilot.
            if (r && typeof r.then === 'function') {
              r.catch((err) => console.error(
                `[${label}] dropped frame (${msg && msg.type}): ${err.message}`));
            }
          } catch (err) {
            console.error(`[${label}] dropped frame (${msg && msg.type}): ${err.message}`);
          }
        }
      }
      if (buf.length > MAX_LINE) {
        console.error(`[${label}] oversized frame, dropping connection`);
        buf = '';
        chan.close();
      }
    },
  };
  if (heartbeat && HEARTBEAT_MS > 0) {
    beat = setInterval(() => {
      if (chan.destroyed) { clearInterval(beat); return; }
      const now = Date.now();
      if (now - lastRecvAt > IDLE_TIMEOUT_MS) {
        console.error(`[${label}] no traffic from ${chan.remote} for ` +
          `${Math.round((now - lastRecvAt) / 1000)}s — treating it as gone`);
        chan.close();
        // The transport's close event may never arrive on a blackholed
        // socket, so the close has to be announced from here.
        chan.emitClose();
        return;
      }
      if (now - lastSendAt >= HEARTBEAT_MS) {
        lastSendAt = now;
        write(frame({ type: PING }));
      }
    }, Math.max(500, Math.floor(HEARTBEAT_MS / 2)));
    beat.unref();
  }
  return chan;
}

module.exports = { createChannel, frame, stamp, MAX_LINE, TRANSPORT_ERROR,
                   HEARTBEAT_MS, IDLE_TIMEOUT_MS };
