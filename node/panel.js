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
//   node panel.js rv:<path|url>         follow a signed rendezvous record (#45)
//   node panel.js                       defaults to 127.0.0.1:47180, 3 nodes
//
// The `rv:` form is the one that works across networks and survives a move:
// the beacon is UDP broadcast, which no NAT or WAN path carries, and a
// hand-copied address dies the moment the entrance changes — and a resident
// entrance (an onion service, a sequencer that moved hosts) is exactly the
// kind that changes. The host serving the record is untrusted infrastructure:
// it can withhold or serve something stale, but it cannot impersonate the
// hub, because AMCN_HUB_PIN is checked against the record's signature.
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
// A rendezvous location (file path or https URL). The verifiers re-resolve it
// on every reconnect attempt (#40), so the panel follows the hub without
// anyone editing anything here; the port comes from the record, not argv.
const RENDEZVOUS = process.env.AMCN_RENDEZVOUS ||
  (hostArg && hostArg.startsWith('rv:') ? hostArg.slice(3) : null);
const HOST = RENDEZVOUS ? 'rendezvous' : (hostArg || '127.0.0.1');
const DISCOVER = HOST === 'discover';
// The hub DID to insist on. Without it, discovery would follow whichever
// beacon answers first.
const HUB_PIN = process.env.AMCN_HUB_PIN || null;
const PORT = Number(portArg || 47180);
const SIZE = Number(sizeArg || 3);
// AMCN_PANEL_SEED keeps verifier identities stable across restarts. Without
// it each restart abandons the panel's escrowed stake (§4 #17/#28) — and
// since protocol v7 that is not merely untidy: a verifier that leaves before
// the canaries have tested it enough **does not get its stake back** (#38).
// So an unset seed is no longer a warning, it is a default we have to supply:
// one is generated on first run and kept next to the configs. The env var
// still wins, which is what the multi-machine runbook uses.
const SEED_FILE = path.join(__dirname, 'configs', '.panel-seed');
function panelSeed() {
  if (process.env.AMCN_PANEL_SEED) return { seed: process.env.AMCN_PANEL_SEED, from: 'env' };
  const fs = require('node:fs');
  try {
    const kept = fs.readFileSync(SEED_FILE, 'utf8').trim();
    if (kept) return { seed: kept, from: 'file' };
  } catch { /* first run */ }
  const seed = `panel-${require('node:crypto').randomBytes(12).toString('hex')}`;
  try {
    fs.mkdirSync(path.dirname(SEED_FILE), { recursive: true });
    fs.writeFileSync(SEED_FILE, seed + '\n', { mode: 0o600 });
    return { seed, from: 'new' };
  } catch (e) {
    return { seed: null, from: `unwritable: ${e.message}` };
  }
}
const { seed: SEED, from: SEED_FROM } = panelSeed();

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
    `${RENDEZVOUS ? `via rendezvous ${RENDEZVOUS}`
      : DISCOVER ? 'via UDP beacon' : `${HOST}:${PORT}`}, ${SIZE} verifiers` +
    (SEED ? `, seeded identities (${SEED}-V1…)` : ', ephemeral identities'));
  if (SEED_FROM === 'new') {
    console.log(`已產生本機 panel 身分並存在 ${SEED_FILE}（0600）。` +
      '押注與受測紀錄綁在這組身分上，請備份這個檔案、也不要外流。');
  } else if (SEED_FROM === 'file') {
    console.log(`沿用 ${SEED_FILE} 的 panel 身分（押注與受測紀錄因此延續）。`);
  } else if (!SEED) {
    console.log(`提示：無法保存 panel 身分（${SEED_FROM}）——這次是臨時身分，` +
      '重啟就會棄置已託管的押注，而未被金絲雀測夠就離開的押注不退（#38）。' +
      '請設 AMCN_PANEL_SEED。');
  }
  console.log('（Verifier 不需要 API key、不需要模型、不參與信用）\n');

  if (RENDEZVOUS) {
    // Resolve once here for the same reason the probe below exists: an
    // operator should see a usable error instead of N verifiers retrying
    // quietly. The verifiers still resolve for themselves, so a hub that
    // moves *after* this point is followed anyway.
    const rv = require('./lib/rendezvous');
    const got = await rv.resolve(RENDEZVOUS, { pin: HUB_PIN });
    if (!got.ok) {
      console.error(`rendezvous ${RENDEZVOUS} unusable: ${got.why}`);
      console.error('  - a record older than AMCN_RENDEZVOUS_MAX_AGE_MS (預設 10 分鐘)');
      console.error('    means the hub stopped publishing, not that you are wrong.');
      console.error('  - "signed by … not the pinned hub" means the record is real');
      console.error('    but somebody else\'s — check AMCN_HUB_PIN with whoever invited you.');
      process.exit(1);
    }
    if (!HUB_PIN) {
      console.log('提示：沒有設 AMCN_HUB_PIN——任何簽得出記錄的人都會被跟隨。' +
        '向邀請你的人要 hub did 並釘住它。');
    }
    console.log(`rendezvous → ${got.host}:${got.port} (${got.did}, ` +
      `${(got.ageMs / 1000).toFixed(0)}s old)` +
      (HUB_PIN ? ' — matches pinned did' : ''));
    if (!await probe(got.host, got.port, 8000)) {
      console.error(`記錄指向 ${got.host}:${got.port}，但那裡連不上。`);
      console.error('  - .onion 位址要 AMCN_TRANSPORT=tor 並且本機的 tor 要在跑');
      console.error('  - 記錄是新的卻連不上，代表入口掛了或搬家還沒發出新記錄');
      process.exit(1);
    }
    console.log(`hub reachable at ${got.host}:${got.port}\n`);
  } else if (DISCOVER) {
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
    const cfg = RENDEZVOUS
      ? { name: `V${i}`, rendezvous: RENDEZVOUS, hubPin: HUB_PIN }
      : DISCOVER
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
