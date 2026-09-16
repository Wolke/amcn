// Timestamps on every log line of a long-running process.
//
// Found by running the pilot rather than by review: no log line carried a
// time, so when the machine-3 panel dropped, the only available evidence was
// the log file's mtime. Every demo runs for 15-35 seconds, where ordering is
// enough and a clock is noise — but the W10 drill's central measurements are
// "how long until the outage was noticed" and "how long the takeover took",
// and neither can be reconstructed from an unstamped log.
//
// Implemented by wrapping console rather than by threading a logger through
// every call site: the lines that matter most during an outage come from
// lib/channel.js and lib/transport-*.js ([wire] socket error, disconnected,
// reconnecting), which no application-level logger would reach.
//
// UTC ISO-8601, because the drill correlates logs across three machines and
// local time invites a timezone or DST argument at exactly the wrong moment.
//
// The demo harnesses deliberately do NOT install this: their output is an
// acceptance report that gets read and compared, not a timeline.
'use strict';

let installed = false;

function install(env = process.env) {
  if (installed || env.AMCN_LOG_TIME === '0') return;
  installed = true;
  for (const method of ['log', 'error', 'warn']) {
    const orig = console[method].bind(console);
    console[method] = (...args) => orig(new Date().toISOString(), ...args);
  }
}

module.exports = { install };
