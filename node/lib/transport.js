// ITransport — the replaceable transport seam (§2.2 "Transport / 撮合" row,
// and the W10 deliverable that #10 left open).
//
// §2.1 lets the MVP centralise transport only if it comes with the exit kit:
// in-protocol discovery (lib/discovery.js), state rebuildable from signed
// events (lib/rebuild.js), and *at least one alternative implementation*.
// Until this file existed the third condition was a promise, not a tested
// feature: wire.js spoke node:net directly from every call site.
//
// An implementation provides:
//
//   name                                  'tcp' | 'http' | 'secure' | 'tor'
//   listen({ port, host, onChannel, onError, onListening }) -> { close(), port }
//   dial({ port, host }) -> Channel
//   probe({ port, host, timeoutMs }) -> Promise<boolean>
//   dialLazy(resolveTarget, { onMessage, onOpen, label }) -> reconnecting handle
//
// A Channel (lib/channel.js, shared by both) provides:
//
//   send(obj) -> bool        stamps the envelope version, frames, writes
//   sendRaw(line) -> bool    exact bytes, for regression probes only
//   onMessage(fn(msg, chan)) / onRaw(fn(line)) / onClose(fn)
//   close() / destroyed / remote
//
// What a transport may NOT do: change framing, the envelope version gate, or
// handler isolation. Those are protocol, not plumbing, and they live in
// lib/channel.js so both transports inherit exactly one copy.
'use strict';

const IMPLS = {
  tcp: './transport-tcp',
  http: './transport-http',
  // Wraps one of the above and injects faults (§ fault-injection-plan).
  // Never a default: a scenario opts in with AMCN_TRANSPORT=chaos.
  chaos: './transport-chaos',
  // Encrypted + identity-authenticated, for links that leave the LAN (#44).
  secure: './transport-secure',
  // 不需要對外開任何埠的傳輸（#89）：Hub 只聽 127.0.0.1，由 onion service
  // 把外面的人帶進來。雙層 NAT／CGNAT 兩邊都不必設定，位址本身就是公鑰。
  tor: './transport-tor',
};

function get(name) {
  const key = String(name || 'tcp').toLowerCase();
  if (!IMPLS[key]) {
    throw new Error(`unknown transport "${name}" — available: ` +
      Object.keys(IMPLS).join(', '));
  }
  const impl = require(IMPLS[key]);
  // dialLazy is transport-independent, so it is implemented once here and
  // handed out bound: a caller holds one object and never has to know which
  // implementation it got.
  return {
    name: impl.name,
    listen: impl.listen,
    dial: impl.dial,
    probe: impl.probe,
    dialLazy: (resolveTarget, opts) => dialLazy(impl, resolveTarget, opts),
  };
}

// One env var for the whole stack: every process spawned by the demos
// inherits it, so a full run can be replayed on the other transport without
// touching a config file.
function fromEnv(env = process.env) {
  return get(env.AMCN_TRANSPORT || 'tcp');
}

const names = () => Object.keys(IMPLS);

// Exposed through get()'s facade as transport.dialLazy(resolveTarget, opts).
//
// The hub address may be unknown at module load (UDP discovery), so callers
// keep `const hub = dialLazy(...)` at module scope instead of restructuring
// into an async bootstrap.
//
// It also owns reconnection (§4 #40). Before this, resolveHubTarget ran once
// at startup and the channel was never revisited: when the hub went away,
// send() returned false, every caller ignored the return value, and the
// process went silently mute -- no reconnect, no re-discovery, not one log
// line, while the owner console still showed the last known balance. Two
// consequences worth naming, because they are why this is P0 rather than an
// inconvenience:
//
//   The rotation delivered in #14 did not work while running. Moving the hub
//   only took effect if every process restarted, which is the thing rotation
//   exists to avoid. So the target is re-resolved on every attempt -- with
//   hubHost "discover" that means listening for the beacon again, and a
//   moved hub is followed without touching a config file.
//
//   A dropped panel ended the network. Observed on the three-machine pilot:
//   the machine-3 panel disconnected (three ECONNRESETs), the hub correctly
//   marked the verifiers offline (#35), and nothing ever came back.
//
// Outbound frames while disconnected are dropped, not queued. Queuing was
// tempting, but no protocol object carries an expiry (a gap registered
// separately), so replaying a backlog of stale bids and attestations after a
// long outage would be worse than losing them -- and unbounded buffering in
// a process meant to run for hours is its own defect. Drops are counted and
// reported on reconnect, which is the part that was actually missing: they
// used to be invisible.
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 15000;

function dialLazy(transport, resolveTarget, opts = {}) {
  const { onMessage, onOpen, label = 'wire',
          ackType = null, handshakeMs = 5000 } = opts;
  let live = null;          // current channel, or null while disconnected
  let stopped = false;      // deliberate close(); do not reconnect
  let attempt = 0;          // consecutive failed/lost connections
  let dropped = 0;          // outbound frames lost while disconnected
  let downSince = null;     // when the current outage began
  let acked = false;        // has the peer answered our handshake?
  let hsTimer = null;

  // Exponential with jitter, capped. Jitter matters with a panel: three
  // verifiers that lost the same hub would otherwise retry in lockstep
  // forever.
  const nextDelay = () => {
    const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempt, 6));
    return Math.round(base * (0.8 + Math.random() * 0.4));
  };

  // Quiet enough to leave running overnight, loud enough to diagnose: the
  // first three attempts, then roughly once a minute at the capped delay.
  const shouldLog = () => attempt <= 3 || attempt % 4 === 0;

  async function attach() {
    if (stopped) return;
    attempt += 1;
    let target;
    try {
      target = await resolveTarget();
    } catch (err) {
      if (shouldLog()) {
        console.error(`[${label}] cannot resolve a hub address: ${err.message}` +
          ` — retrying in ${nextDelay()}ms (attempt ${attempt})`);
      }
      return schedule();
    }
    if (stopped) return;
    const chan = transport.dial(target);
    const where = `${target.host}:${target.port}`;
    let opened = false;

    chan.onMessage((msg, c) => {
      if (ackType && msg && msg.type === ackType) {
        acked = true;
        clearTimeout(hsTimer);
      }
      // The first frame back is proof the far end is really speaking AMCN;
      // a TCP connect alone is not (a transport mismatch connects fine).
      if (!opened) {
        opened = true;
        const downMs = downSince ? Date.now() - downSince : 0;
        if (attempt > 1 || downSince) {
          console.log(`[${label}] reconnected to ${where} after ` +
            `${attempt} attempt(s), ${(downMs / 1000).toFixed(1)}s offline` +
            (dropped ? `, ${dropped} outbound frame(s) dropped while down` : ''));
        }
        attempt = 0;
        dropped = 0;
        downSince = null;
      }
      if (onMessage) return onMessage(msg, c);
      return undefined;
    });

    chan.onClose(() => {
      clearTimeout(hsTimer);
      if (live === chan) live = null;
      if (stopped) return;
      if (downSince === null) downSince = Date.now();
      const delay = nextDelay();
      console.error(`[${label}] disconnected from ${where} — ` +
        `reconnecting in ${delay}ms`);
      // Deliberately NOT unref'd. A verifier has no other handle keeping its
      // event loop alive — its socket was the only one — so an unref'd retry
      // timer let the process exit silently the moment the hub died. Which is
      // the pilot's failure wearing a new hat: the panel disappears and the
      // pool stays empty. Waiting to reconnect is the reason to stay alive.
      setTimeout(attach, delay);
    });

    live = chan;
    acked = false;
    // Re-sent on every connection, not just the first: the hub keys agents
    // by DID, so a new channel is unknown to it until the identity registers
    // again. Re-registration keeps the existing stats and balance (#35), so
    // a reconnect resumes standing rather than resetting it.
    //
    // And retried until acknowledged, which fault injection showed is not
    // optional. A verifier reconnected during a blackhole, its register frame
    // was dropped, and then the fault cleared: pings flowed both ways, so
    // neither side's liveness timer ever fired again, while the hub had no
    // idea who the peer was. A live, anonymous, permanently invisible
    // connection — both sides reporting health. Fire-and-forget registration
    // cannot survive a single lost frame, which is also all that packet loss
    // needs to do.
    const shake = () => {
      if (!onOpen || stopped || chan.destroyed) return;
      onOpen(chan);
      if (!ackType) return;
      clearTimeout(hsTimer);
      hsTimer = setTimeout(() => {
        if (acked || stopped || chan.destroyed) return;
        console.error(`[${label}] no ${ackType} from ${where} — ` +
          'resending handshake (connection is up but anonymous)');
        shake();
      }, handshakeMs);
    };
    shake();
  }

  function schedule() {
    if (stopped) return;
    if (downSince === null) downSince = Date.now();
    setTimeout(attach, nextDelay());
  }

  attach();

  return {
    send: (obj) => {
      if (live && !live.destroyed) return live.send(obj);
      dropped += 1;
      return false;
    },
    // §4 #19: callers use this to say "armed but not connected" instead of
    // claiming a connection a timer knows nothing about.
    get connected() { return !!live && !live.destroyed; },
    get chan() { return live; },
    get droppedWhileDown() { return dropped; },
    close: () => { stopped = true; if (live) live.close(); },
  };
}

module.exports = { get, fromEnv, names, dialLazy };
