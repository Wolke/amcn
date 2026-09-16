// ITransport implementation 1: TCP JSON-lines. The behaviour every pilot so
// far has run on; moved here unchanged so it can be compared against a
// second implementation rather than assumed.
'use strict';
const net = require('node:net');
const { createChannel } = require('./channel');

const name = 'tcp';

// A peer configured for the http transport opens with an HTTP request line.
// Fed to the framer it would be dropped as unparseable, once per line,
// forever — the operator sees a client that hangs and a server that says
// nothing. Answer in HTTP instead, so the mismatch is a message.
const HTTP_REQUEST = /^(GET|POST|PUT|HEAD|DELETE|OPTIONS|PATCH) \S/;
const MISMATCH = 'this endpoint speaks the AMCN tcp transport, ' +
  'but the peer used the http transport — run every node with the same ' +
  'AMCN_TRANSPORT';

function refuseHttp(sock) {
  const body = JSON.stringify({ type: 'transport_error', why: MISMATCH }) + '\n';
  sock.end('HTTP/1.1 400 Bad Request\r\n' +
    'content-type: application/json\r\n' +
    `content-length: ${Buffer.byteLength(body)}\r\n` +
    'connection: close\r\n\r\n' + body);
  console.error(`[transport] refused an http peer on the tcp transport ` +
    `(${sock.remoteAddress})`);
}

// hooks let a wrapper (lib/transport-chaos.js) intervene at the byte level,
// which is where a network fault actually happens. Above the channel is the
// wrong place: the channel's own liveness pings go straight through `write`,
// so a fault injected above it leaves the heartbeat working and the partition
// undetectable — measured, after building it the wrong way round first.
const pass = (hook, text, deliver, remote) =>
  (hook ? hook(text, deliver, remote) : deliver(text));

function wrap(sock, remote, { sniff = false, hooks = {} } = {}) {
  const chan = createChannel({
    remote,
    write: (s) => pass(hooks.onWrite, s, (out) => sock.write(out), remote),
    close: () => sock.destroy(),
    isClosed: () => sock.destroyed,
  });
  // Unhandled 'error' on a socket is fatal to the process; a peer that
  // disconnects mid-frame (ECONNRESET) must not be able to do that. Log it
  // rather than swallowing it — silently dropping ECONNREFUSED turns "cannot
  // reach the hub" into a process that prints nothing at all.
  sock.on('error', (err) => {
    console.error(`[wire] socket error: ${err.code || err.message}`);
    sock.destroy();
  });
  sock.on('close', () => chan.emitClose());
  let sniffed = !sniff;
  sock.on('data', (chunk) => {
    if (!sniffed) {
      sniffed = true;
      if (HTTP_REQUEST.test(chunk.toString('latin1', 0, 24))) {
        return refuseHttp(sock);
      }
    }
    pass(hooks.onData, chunk.toString('utf8'), (out) => chan.feed(out), remote);
  });
  return chan;
}

function listen({ port, host = '127.0.0.1', onChannel, onError, onListening,
                 hooks }) {
  const server = net.createServer((sock) => {
    const chan = wrap(sock, `${sock.remoteAddress}:${sock.remotePort}`,
      { sniff: true, hooks });
    onChannel(chan);
  });
  if (onError) server.on('error', onError);
  server.listen(port, host, () => onListening && onListening({ port, host }));
  return { close: (cb) => server.close(cb), port, host, name };
}

function dial({ port, host = '127.0.0.1', hooks }) {
  return wrap(net.connect(port, host), `${host}:${port}`, { hooks });
}

// Fail with a useful message rather than N clients retrying quietly.
function probe({ port, host = '127.0.0.1', timeoutMs = 4000 }) {
  return new Promise((resolve) => {
    const sock = net.connect(port, host);
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

module.exports = { name, listen, dial, probe };
