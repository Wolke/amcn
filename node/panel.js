#!/usr/bin/env node
// Dedicated Verifier panel host — the machine-3 role from INSTALL.md §6.
//
// §4 #31: running the panel on the same machine as the trading agents makes
// "2-of-3 quorum" decoration at the deployment level — one host, one OS, one
// owner, one failure domain, which is what FR-041's random selection exists
// to prevent. This launcher exists so moving the panel to its own machine is
// one command instead of three configs and three terminals.
//
// Cross-platform on purpose: plain Node, so Windows needs no PowerShell
// execution-policy change and no shell-quoted JSON (§4 #32).
//
// Usage:
//   node panel.js 192.168.1.10          hub IP (required for a remote hub)
//   node panel.js 192.168.1.10 47180 5  hub IP, hub port, panel size
//   node panel.js discover              find the hub by its signed UDP beacon
//   node panel.js                       defaults to 127.0.0.1:47180, 3 nodes
//
// `discover` is what makes this panel able to follow a hub that moves: the
// verifiers re-resolve the target on every reconnect attempt (§4 #40), so a
// standby sequencer taking over on another machine is picked up without
// anyone logging into this one. That is the W10 drill's whole point, and a
// hard-coded IP cannot do it. Pin the identity with AMCN_HUB_PIN so the panel
// refuses to follow anything but the hub it was told about — otherwise any
// host on the broadcast domain could answer for the hub.
//
// A Verifier needs no API key, no model, and no credit: it only needs to
// reach the hub. Ctrl-C stops the whole panel.
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const transport = require('./lib/transport').fromEnv();
require('./lib/log').install();

const [hostArg, portArg, sizeArg] = process.argv.slice(2);
const HOST = hostArg || '127.0.0.1';
const DISCOVER = HOST === 'discover';
// The hub DID to insist on. Without it, discovery would follow whichever
// beacon answers first.
const HUB_PIN = process.env.AMCN_HUB_PIN || null;
const PORT = Number(portArg || 47180);
const SIZE = Number(sizeArg || 3);
// AMCN_PANEL_SEED keeps verifier identities stable across restarts. Without
// it each restart abandons the panel's escrowed stake (§4 #17/#28).
const SEED = process.env.AMCN_PANEL_SEED || null;

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error(`Node ${process.versions.node} is too old — AMCN needs >= 20.`);
  process.exit(1);
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`bad hub port: ${portArg}`);
  process.exit(1);
}
if (!Number.isInteger(SIZE) || SIZE < 1 || SIZE > 20) {
  console.error(`bad panel size: ${sizeArg}`);
  process.exit(1);
}

// Fail with a useful message rather than three verifiers retrying quietly.
// Reachability is transport-specific (a live tcp socket vs. a 200 from
// /amcn/health), so the check belongs to the implementation.
const probe = (host, port, timeoutMs = 4000) =>
  transport.probe({ host, port, timeoutMs });

const children = [];
let stopping = false;

function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    try { c.kill(); } catch { /* already gone */ }
  }
  // Give them a moment to close their hub sockets before exiting.
  setTimeout(() => process.exit(code), 300);
}

async function main() {
  console.log(`AMCN Verifier panel → hub ` +
    `${DISCOVER ? 'via UDP beacon' : `${HOST}:${PORT}`}, ${SIZE} verifiers` +
    (SEED ? `, seeded identities (${SEED}-V1…)` : ', ephemeral identities'));
  if (!SEED) {
    console.log('提示：設 AMCN_PANEL_SEED 可讓 verifier 身分跨重啟不變，' +
      '否則每次重啟都會棄置已託管的押注（§4 #17/#28）');
  }
  console.log('（Verifier 不需要 API key、不需要模型、不參與信用）\n');

  if (DISCOVER) {
    // Report what the beacon says before starting anything, for the same
    // reason the probe exists: an operator should see a usable error rather
    // than N verifiers retrying quietly. The verifiers still resolve for
    // themselves, so a hub that moves later is followed.
    const discovery = require('./lib/discovery');
    const found = await discovery.discoverHub({ pin: HUB_PIN, timeoutMs: 6000 });
    if (!found) {
      console.error('no hub beacon heard' + (HUB_PIN ? ` matching ${HUB_PIN}` : '') + '.');
      console.error('  - is the hub running with HUB_BIND=0.0.0.0 and the beacon enabled?');
      console.error('  - same broadcast domain? guest networks, VLANs and Wi-Fi');
      console.error('    client isolation all block UDP broadcast — a hand-typed');
      console.error('    IP is unaffected, so try `node panel.js <hub ip>` to confirm.');
      console.error('  - on Windows, allow inbound UDP 47179 for node.');
      process.exit(1);
    }
    console.log(`hub discovered at ${found.host}:${found.port} (${found.did})` +
      (HUB_PIN ? ' — matches pinned did' : ' — no AMCN_HUB_PIN set, any beacon would do') + '\n');
  } else if (!await probe(HOST, PORT)) {
    console.error(`cannot reach the hub at ${HOST}:${PORT}.`);
    console.error('  - is the hub running there with HUB_BIND=0.0.0.0 ?');
    console.error('  - same subnet, and the host firewall allowing inbound ' +
      `TCP ${PORT} on that machine?`);
    console.error('  - check the IP with `ipconfig getifaddr en0` (macOS) or ' +
      '`ipconfig` (Windows) on the hub machine.');
    process.exit(1);
  }
  if (!DISCOVER) console.log(`hub reachable at ${HOST}:${PORT}\n`);

  let registered = 0;
  for (let i = 1; i <= SIZE; i++) {
    // Derived per verifier from one operator-supplied base, so a panel
    // restart keeps each verifier's identity — and therefore its stake.
    const cfg = DISCOVER
      ? { name: `V${i}`, hubHost: 'discover', hubPin: HUB_PIN }
      : { name: `V${i}`, hubHost: HOST, hubPort: PORT };
    if (SEED) cfg.seed = `${SEED}-V${i}`;
    const child = spawn(process.execPath, [path.join(__dirname, 'verifier.js')], {
      env: { ...process.env, AGENT_CONFIG: JSON.stringify(cfg) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    const tag = `V${i}`;
    const relay = (buf, stream) => {
      for (const line of buf.toString().split('\n')) {
        if (!line.trim()) continue;
        stream.write(`  [${tag}] ${line}\n`);
        if (line.includes('registered as verifier')) {
          registered += 1;
          if (registered === SIZE) {
            console.log(`\n全部 ${SIZE} 個 Verifier 已向 Hub 註冊。` +
              'Ctrl-C 停止整個 panel。\n');
          }
        }
      }
    };
    child.stdout.on('data', (b) => relay(b, process.stdout));
    child.stderr.on('data', (b) => relay(b, process.stderr));
    child.on('exit', (code) => {
      if (stopping) return;
      console.error(`  [${tag}] exited (code ${code}) — stopping the panel so ` +
        'a partial panel does not look healthy');
      stopAll(1);
    });
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log('\nstopping panel…');
      stopAll(0);
    });
  }
}

main();
