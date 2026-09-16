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
//   name                                  'tcp' | 'http'
//   listen({ port, host, onChannel, onError, onListening }) -> { close(), port }
//   dial({ port, host }) -> Channel
//   probe({ port, host, timeoutMs }) -> Promise<boolean>
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
    dialLazy: (targetPromise, onMessage) =>
      dialLazy(impl, targetPromise, onMessage),
  };
}

// One env var for the whole stack: every process spawned by the demos
// inherits it, so a full run can be replayed on the other transport without
// touching a config file.
function fromEnv(env = process.env) {
  return get(env.AMCN_TRANSPORT || 'tcp');
}

const names = () => Object.keys(IMPLS);

// Exposed through get()'s facade as transport.dialLazy(promise, onMessage).
// The hub address may be unknown at module load (UDP discovery). Hand back a
// handle immediately and queue sends until the channel exists, so callers can
// keep `const hub = dialLazy(...)` at module scope instead of restructuring
// everything into an async bootstrap.
function dialLazy(transport, targetPromise, onMessage) {
  const queued = [];
  let live = null;
  targetPromise.then(({ host, port }) => {
    live = transport.dial({ host, port });
    if (onMessage) live.onMessage(onMessage);
    while (queued.length) live.send(queued.shift());
  });
  return {
    send: (obj) => { if (live) return live.send(obj); queued.push(obj); return true; },
    // §4 #19: callers use this to say "armed but not connected" instead of
    // claiming a connection a timer knows nothing about.
    get connected() { return !!live && !live.destroyed; },
    get chan() { return live; },
    close: () => { if (live) live.close(); },
  };
}

module.exports = { get, fromEnv, names, dialLazy };
