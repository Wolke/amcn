// LAN discovery for the Coordination Hub, over UDP broadcast.
//
// final-architecture §2.1 binds every centralized layer to a "退場三件套",
// the first item of which is 協議內發現與輪替機制 — the Transport/撮合 layer
// was ruled to B 案 (central hub) without it, so a hub move meant editing a
// config file on every machine. This is the LAN-scope piece: the same job
// mDNS does inside a P2P stack (proposal-A §6.2 track 3).
//
// Scope, honestly: this finds a hub on the local broadcast domain. It is not
// a substitute for DHT/bootstrap discovery across networks (SDD §19 Phase 2).
//
// Zero dependencies: node:dgram + node:os.
'use strict';
const dgram = require('node:dgram');
const os = require('node:os');
const { sign, verify, sha256 } = require('./wire');

const BEACON_PORT = Number(process.env.HUB_BEACON_PORT || 47179);
const BEACON_INTERVAL_MS = 1000;
const MAX_SKEW_MS = 60_000;

// did:demo derivation must match wire.genIdentity, so a beacon is
// self-certifying: the DID is a hash of the key that signed it.
const didOf = (pub) => 'did:demo:' + sha256(pub).slice(0, 16);

// Per-interface broadcast addresses. 255.255.255.255 alone is unreliable
// across platforms once more than one interface is up.
function broadcastAddrs() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.push(ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return out.length ? [...new Set(out)] : ['255.255.255.255'];
}

// Where a hub may legitimately advertise itself: only addresses it actually
// serves. The listener derives the host from the datagram's source address, so
// sending to the right target is what makes that host correct — a loopback
// hub announcing on the LAN would hand out this machine's LAN IP, which it is
// not listening on, and every discovered connection would be refused.
const isLoopback = (bind) =>
  bind === '127.0.0.1' || bind === 'localhost' || bind === '::1';

function beaconTargets(bind) {
  if (isLoopback(bind)) return ['127.0.0.1'];
  if (bind === '0.0.0.0' || bind === '::') return [...broadcastAddrs(), '127.0.0.1'];
  return broadcastAddrs(); // bound to one specific interface
}

// Hub side: announce {port, pub} once a second, signed.
function startBeacon(hubId, hubPort, { port = BEACON_PORT, bind = '127.0.0.1' } = {}) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let timer = null;
  // A beacon is a convenience; a failing socket must never take the hub down.
  sock.on('error', () => {});
  sock.bind(() => {
    try { sock.setBroadcast(true); } catch { /* not permitted; sends will no-op */ }
    const targets = beaconTargets(bind);
    const announce = () => {
      // host is deliberately NOT in the signed body: the listener takes it
      // from the datagram source address, which is what is actually
      // reachable, and which a signature could not vouch for anyway.
      const body = { type: 'hub_beacon', port: hubPort, pub: hubId.pub, ts: Date.now() };
      const frame = Buffer.from(JSON.stringify(
        { ...body, sig: sign(hubId.privateKey, body) }));
      for (const to of targets) sock.send(frame, 0, frame.length, port, to, () => {});
    };
    announce();
    timer = setInterval(announce, BEACON_INTERVAL_MS);
    timer.unref();
  });
  return {
    port,
    targets: beaconTargets(bind),
    stop: () => { if (timer) clearInterval(timer); try { sock.close(); } catch {} },
  };
}

// Agent side: listen for a beacon. Resolves {host, port, pub, did} or null.
// `pin` is the hub DID the caller insists on — without it, any host on the
// broadcast domain can answer (see the threat note in node/README.md).
function discoverHub({ timeoutMs = 3000, port = BEACON_PORT, pin = null } = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.close(); } catch {}
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on('error', () => finish(null));
    sock.on('message', (buf, rinfo) => {
      let m;
      try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
      if (!m || m.type !== 'hub_beacon' || typeof m.port !== 'number') return;
      const { sig, ...body } = m;
      if (!verify(m.pub, body, sig)) return;
      if (Math.abs(Date.now() - m.ts) > MAX_SKEW_MS) return; // stale or replayed
      const did = didOf(m.pub);
      if (pin && pin !== did) return;
      finish({ host: rinfo.address, port: m.port, pub: m.pub, did });
    });
    sock.bind(port);
  });
}

// Resolve a hub target from an agent/verifier config. hubHost "discover" uses
// the beacon; any other value, including absent, keeps the static behaviour so
// existing configs are untouched.
async function resolveHubTarget(cfg, log = () => {}) {
  if (cfg.hubHost !== 'discover') {
    return { host: cfg.hubHost || '127.0.0.1', port: cfg.hubPort || 47180 };
  }
  const opts = { pin: cfg.hubPin || null, port: cfg.beaconPort || BEACON_PORT };
  for (let attempt = 1; ; attempt++) {
    const found = await discoverHub(opts);
    if (found) {
      log(`discovered hub ${found.host}:${found.port} (${found.did})` +
        (cfg.hubPin ? ' — matches pinned did' : ''));
      return { host: found.host, port: cfg.hubPort || found.port };
    }
    // Falling back to whatever is on localhost is exactly what a pin exists
    // to prevent, so keep listening instead of connecting to another hub.
    if (cfg.hubPin) {
      log(`no beacon matching pinned hub ${cfg.hubPin} (attempt ${attempt}) — ` +
        'still listening, will not connect elsewhere');
      continue;
    }
    log('no hub beacon heard; falling back to 127.0.0.1');
    return { host: '127.0.0.1', port: cfg.hubPort || 47180 };
  }
}

module.exports = {
  BEACON_PORT, startBeacon, discoverHub, resolveHubTarget, didOf,
  broadcastAddrs, beaconTargets,
};
