// ITransport implementation 3: fault injection.
//
// Why this exists: the three-machine pilot could not stage the faults it was
// meant to test. Scenario A aimed at a silent partition leaving half-open
// sockets; turning off Wi-Fi sent an RST and the hub noticed in two seconds,
// so what got tested was a clean close. And when the panel failed to come
// back, whether its processes had died or hung was written only on that
// machine's terminal — unreachable, unreproducible, gone.
//
// Faults belong at the transport seam, which W10 extracted for
// replaceability. No VM, no root, no real NIC: this wraps tcp or http and
// drops, delays, loses or blackholes frames on command.
//
// Deliberately a third implementation rather than flags on the other two.
// demo-transport.js asserts that tcp and http produce a byte-identical
// ledger; fault logic living inside them would make that guarantee
// meaningless.
//
//   AMCN_TRANSPORT=chaos
//   AMCN_CHAOS_BASE=tcp|http     (default tcp)
//   AMCN_CHAOS=path/to/fault.json   polled, so a scenario flips faults
//                                   mid-run without restarting anything
//   AMCN_CHAOS_SEED=<n>          deterministic loss, so a failure replays
//
// fault.json:
//   { "mode": "blackhole" | "reset" | "latency" | "loss" | "freeze" | "none",
//     "direction": "in" | "out" | "both",     // one-way partitions
//     "latencyMs": 80, "jitterMs": 40, "lossPct": 1,
//     "match": "127.0.0.1:47180" }            // substring of chan.remote
//
// The semantics that matter:
//   blackhole  writes succeed and vanish. The connection is never closed, so
//              neither side learns anything — this is the case a human cannot
//              stage reliably, and the one that exposes a missing keepalive.
//   reset      close immediately. What Wi-Fi-off actually does.
//   freeze     inbound delivery suspended, outbound still flows. A wedged
//              peer: TCP is alive, so keepalive would not help either.
'use strict';
const fs = require('node:fs');

const name = 'chaos';
const POLL_MS = Number(process.env.AMCN_CHAOS_POLL_MS || 200);
const base = () => require('./transport')
  .get(process.env.AMCN_CHAOS_BASE || 'tcp');

// --- fault state, reloaded from the control file ------------------------
let fault = { mode: 'none', direction: 'both' };
let loadedAt = 0;
let lastRaw = '';

function reload() {
  const file = process.env.AMCN_CHAOS;
  if (!file) return;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (raw === lastRaw) return;
    lastRaw = raw;
    const next = JSON.parse(raw);
    fault = { mode: 'none', direction: 'both', ...next };
    loadedAt = Date.now();
    console.log(`[chaos] fault → ${fault.mode}` +
      (fault.direction !== 'both' ? ` (${fault.direction})` : '') +
      (fault.latencyMs ? ` +${fault.latencyMs}±${fault.jitterMs || 0}ms` : '') +
      (fault.lossPct ? ` loss ${fault.lossPct}%` : '') +
      (fault.match ? ` match=${fault.match}` : ''));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[chaos] cannot read ${file}: ${err.message}`);
    }
  }
}
reload();
if (process.env.AMCN_CHAOS) setInterval(reload, POLL_MS).unref();

// Seeded so a loss pattern replays. Math.random would make a failing
// scenario a one-off anecdote, which is the thing this harness exists to
// stop producing.
let rngState = Number(process.env.AMCN_CHAOS_SEED || 1) | 0 || 1;
function rnd() {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
  return rngState / 0x7fffffff;
}

const matches = (remote) => !fault.match || String(remote).includes(fault.match);
const applies = (remote) => fault.mode !== 'none' && matches(remote);
const hits = (dir) => fault.direction === 'both' || fault.direction === dir;
const delayFor = () => {
  const l = fault.latencyMs || 0;
  const j = fault.jitterMs || 0;
  return Math.max(0, l + (j ? Math.round((rnd() * 2 - 1) * j) : 0));
};

// One decision per byte chunk, per direction. Applied *below* the channel, so
// the channel's own liveness pings are subject to it too — the first version
// wrapped above the channel and the pings sailed straight through, leaving a
// silent partition undetectable in the very test built to detect it.
function gate(dir) {
  return (text, deliver, remote) => {
    if (!applies(remote) || !hits(dir)) return deliver(text);
    switch (fault.mode) {
      case 'blackhole':
        return undefined;                       // vanishes; nothing is closed
      case 'freeze':
        return dir === 'in' ? undefined : deliver(text);
      case 'loss':
        return rnd() * 100 < (fault.lossPct || 0) ? undefined : deliver(text);
      case 'latency':
        setTimeout(() => deliver(text), delayFor());
        return undefined;
      default:
        return deliver(text);
    }
  };
}

const hooks = () => ({ onWrite: gate('out'), onData: gate('in') });

// reset is not a byte fault: it closes. Applied to channels as they appear,
// including ones opened while the fault is active.
function maybeReset(chan) {
  if (applies(chan.remote) && fault.mode === 'reset') setImmediate(() => chan.close());
  return chan;
}

function listen({ port, host, onChannel, onError, onListening }) {
  return base().listen({
    port, host, onError, onListening, hooks: hooks(),
    onChannel: (chan) => onChannel(maybeReset(chan)),
  });
}

const dial = (target) => maybeReset(base().dial({ ...target, hooks: hooks() }));
const probe = (target) => base().probe(target);

module.exports = { name, listen, dial, probe, _state: () => ({ fault, loadedAt }) };
