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

function wrap(sock, remote, { sniff = false } = {}) {
  const chan = createChannel({
    remote,
    write: (s) => sock.write(s),
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
    chan.feed(chunk.toString('utf8'));
  });
  return chan;
}

function listen({ port, host = '127.0.0.1', onChannel, onError, onListening }) {
  const server = net.createServer((sock) => {
    const chan = wrap(sock, `${sock.remoteAddress}:${sock.remotePort}`,
      { sniff: true });
    onChannel(chan);
  });
  if (onError) server.on('error', onError);
  server.listen(port, host, () => onListening && onListening({ port, host }));
  return { close: (cb) => server.close(cb), port, host, name };
}

function dial({ port, host = '127.0.0.1' }) {
  return wrap(net.connect(port, host), `${host}:${port}`);
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
