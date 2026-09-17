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
// Liveness has to prove the link works in *both* directions, which the
// first version did not. Under `freeze` (inbound dropped, outbound intact)
// the frozen peer kept sending pings, so the hub's "I received traffic"
// test stayed satisfied and it advertised verifiers that could not hear a
// word — every contract awarded in that window was doomed and later
// abandoned, with the provider unpaid. So a ping now demands a pong: if my
// pings go unanswered, the peer cannot hear me, whatever I am hearing from
// it.
const HEARTBEAT_MS = Number(process.env.AMCN_HEARTBEAT_MS || 5000);
const IDLE_TIMEOUT_MS = Number(process.env.AMCN_IDLE_TIMEOUT_MS || 20000);
// Underscore-prefixed because these are channel-layer frames, not protocol
// messages, and an application type called `ping` would otherwise be
// swallowed silently — which cost a debugging round the first time a test
// named a message `pong`. The prefix is reserved for the channel.
const PING = '_ping';
const PONG = '_pong';

function createChannel({ remote, write, close, isClosed, label = 'wire',
                        heartbeat = true }) {
  const onMsg = [], onRaw = [], onClose = [];
  let buf = '';
  let localClosed = false, closeEmitted = false;
  let lastRecvAt = Date.now(), lastPingAt = 0;
  let awaitingPongSince = null;   // set when a ping goes out unanswered
  let beat = null;

  const chan = {
    remote: remote || '(unknown)',
    get destroyed() { return localClosed || isClosed(); },

    send(obj) {
      if (chan.destroyed) return false;
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
        // Parse before anything else, because liveness frames have to be
        // answered and the audit log has to skip them — doing the skip first
        // (as an earlier version did) meant pings were never answered and
        // pongs never cleared the flag, so every channel declared its peer
        // dead after 20 seconds with no fault present at all.
        let msg;
        try { msg = JSON.parse(line); } catch { msg = null; }

        if (msg && msg.type === PING) {
          lastRecvAt = Date.now();
          // Answering is what makes the check bidirectional.
          if (!chan.destroyed) write(frame({ type: PONG, n: msg.n }));
          continue;
        }
        if (msg && msg.type === PONG) {
          lastRecvAt = Date.now();
          awaitingPongSince = null;
          continue;
        }

        // Every other line, parseable or not: the hub's full-traffic audit
        // log (the NFR-005 plaintext scan reads it). Liveness frames are
        // excluded above — they carry no protocol content and would multiply
        // the log, which rides along in every export (#41).
        lastRecvAt = Date.now();
        for (const fn of onRaw) {
          try { fn(line); } catch { /* audit log must not break the reader */ }
        }
        if (msg === null) continue;

        if (msg.type === TRANSPORT_ERROR) {
          console.error(`[transport] ${chan.remote} refused us: ${msg.why}`);
          continue;
        }
        // Refuse before a handler can misread a shape it does not know. An
        // absent v means a node older than versioning itself.
        if (msg.v !== PROTOCOL_VERSION) {
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
      const silent = now - lastRecvAt > IDLE_TIMEOUT_MS;
      const unanswered = awaitingPongSince !== null &&
        now - awaitingPongSince > IDLE_TIMEOUT_MS;
      if (silent || unanswered) {
        console.error(`[${label}] ${silent
          ? `no traffic from ${chan.remote} for ${Math.round((now - lastRecvAt) / 1000)}s`
          : `${chan.remote} stopped answering pings for ` +
            `${Math.round((now - awaitingPongSince) / 1000)}s (it cannot hear us)`
        } — treating it as gone`);
        chan.close();
        // The transport's close event may never arrive on a blackholed
        // socket, so the close has to be announced from here.
        chan.emitClose();
        return;
      }
      // Sent on a schedule, not only when the channel is idle. Gating it on
      // "have I sent anything recently" made the hub never ping at all — it
      // broadcasts a checkpoint every 1200ms — and outbound app traffic
      // proves nothing about whether the peer can hear it. One small frame
      // every HEARTBEAT_MS per channel buys the only guarantee that matters.
      if (now - lastPingAt >= HEARTBEAT_MS) {
        lastPingAt = now;
        if (awaitingPongSince === null) awaitingPongSince = now;
        write(frame({ type: PING, n: now }));
      }
    }, Math.max(500, Math.floor(HEARTBEAT_MS / 2)));
    beat.unref();
  }
  return chan;
}

module.exports = { createChannel, frame, stamp, MAX_LINE, TRANSPORT_ERROR,
                   HEARTBEAT_MS, IDLE_TIMEOUT_MS };
