// ITransport implementation 2: HTTP — a long-lived chunked NDJSON response
// carries server→client frames, POSTs carry client→server frames.
//
// Chosen over a second socket dialect (unix sockets, a WebSocket dialect) on
// purpose: those share TCP's failure model, so swapping them would prove
// nothing. Here there is no connection state on the wire at all — a channel
// is a stream plus a correlation id, either half can vanish without the
// other noticing, and delivery is per-request rather than per-connection.
// That is the difference the W10 unplug drill is supposed to find.
//
// Still zero dependencies (node:http), and framing/versioning/isolation come
// from lib/channel.js, so both transports must produce the same ledger.
//
// Wire protocol:
//   GET  /amcn/stream?cid=<hex>   -> 200 application/x-ndjson, stays open
//   POST /amcn/send  x-amcn-cid   -> 204, body is one or more framed lines
//   GET  /amcn/health             -> 200 {"transport":"http"}
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { createChannel, MAX_LINE } = require('./channel');

const name = 'http';
// Intermediaries drop an idle response; a blank line is skipped by the
// framer, so it costs nothing to keep the stream warm.
const HEARTBEAT_MS = Number(process.env.AMCN_HTTP_HEARTBEAT_MS || 15000);
const MISMATCH = 'this endpoint speaks the AMCN http transport, ' +
  'but the peer used the tcp transport — run every node with the same ' +
  'AMCN_TRANSPORT';

const pass = (hook, text, deliver, remote) =>
  (hook ? hook(text, deliver, remote) : deliver(text));

function listen({ port, host = '127.0.0.1', onChannel, onError, onListening,
                 hooks = {} }) {
  const open = new Map(); // cid -> { chan, h }  (hooks are per connection)

  const server = http.createServer((req, res) => {
    // #13/#34 isolated frame handlers; the transport's own request handling
    // sat outside that. A ReferenceError in here took the whole hub down and
    // every client saw ECONNREFUSED — the failure looks like "the hub was
    // never up", which is exactly the misdiagnosis this guard prevents.
    try {
      handle(req, res);
    } catch (err) {
      console.error(`[wire] request handler threw: ${err.message}`);
      try { res.writeHead(500).end(); } catch { /* already sent */ }
    }
  });

  function handle(req, res) {
    const url = new URL(req.url, 'http://amcn.invalid');
    if (req.method === 'GET' && url.pathname === '/amcn/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ transport: name }) + '\n');
    }

    if (req.method === 'GET' && url.pathname === '/amcn/stream') {
      const cid = url.searchParams.get('cid') || '';
      if (!/^[0-9a-f]{8,64}$/.test(cid) || open.has(cid)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'transport_error',
          why: 'bad or duplicate connection id' }) + '\n');
      }
      res.writeHead(200, {
        'content-type': 'application/x-ndjson',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.flushHeaders();
      const remote = `${req.socket.remoteAddress} (http ${cid.slice(0, 8)})`;
      const rawWrite = (out) => res.write(out);
      let h = typeof hooks === 'function' ? {} : hooks;
      let chan;
      chan = createChannel({
        remote,
        write: (s) => pass(h.onWrite, s, rawWrite, remote),
        close: () => res.end(),
        isClosed: () => res.writableEnded || res.destroyed,
      });
      if (typeof hooks === 'function') h = hooks(chan, rawWrite) || {};
      open.set(cid, { chan, h });
      const hb = setInterval(() => {
        if (!chan.destroyed) res.write('\n');
      }, HEARTBEAT_MS);
      hb.unref();
      res.on('close', () => {
        clearInterval(hb);
        open.delete(cid);
        chan.emitClose();
      });
      onChannel(chan);
      return undefined;
    }

    if (req.method === 'POST' && url.pathname === '/amcn/send') {
      const conn = open.get(String(req.headers['x-amcn-cid'] || ''));
      if (!conn) {
        res.writeHead(409, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'transport_error',
          why: 'no open stream for this connection id' }) + '\n');
      }
      let body = '';
      let oversize = false;
      req.setEncoding('utf8');
      req.on('data', (d) => {
        if (oversize) return;
        body += d;
        if (body.length > MAX_LINE) {
          oversize = true;
          res.writeHead(413).end();
          req.destroy();
        }
      });
      req.on('end', () => {
        if (oversize) return;
        res.writeHead(204).end();
        pass(conn.h.onData, body, (out) => conn.chan.feed(out), conn.chan.remote);
      });
      return undefined;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ type: 'transport_error',
      why: `no such endpoint: ${req.method} ${url.pathname}` }) + '\n');
  }

  // A peer on the tcp transport sends '{"v":1,...}', which is not a request
  // line: node reports HPE_INVALID_METHOD and we would otherwise close in
  // silence. Reply with a framed error line, which that peer's framer can
  // read (lib/channel.js handles transport_error itself).
  server.on('clientError', (err, socket) => {
    if (socket.writableEnded) return;
    console.error(`[transport] refused a tcp peer on the http transport ` +
      `(${err.code || err.message})`);
    socket.end(JSON.stringify({ type: 'transport_error', why: MISMATCH }) + '\n');
  });
  if (onError) server.on('error', onError);
  server.listen(port, host, () => onListening && onListening({ port, host }));
  return {
    close: (cb) => {
      for (const { chan } of open.values()) chan.close();
      server.close(cb);
    },
    port, host, name,
  };
}

function dial({ port, host = '127.0.0.1', hooks = {} }) {
  const cid = crypto.randomBytes(16).toString('hex');
  // keepAlive + one socket: the POSTs of a channel must arrive in the order
  // they were sent. Concurrent requests on separate sockets would let
  // `task` overtake `register`, which no amount of application logic can
  // repair. This is the one place the http transport has to work for what
  // TCP gives away.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  let streaming = false, closed = false;
  let outbox = '', sending = false;

  const remote = `${host}:${port} (http)`;
  const rawWrite = (out) => { outbox += out; pump(); };
  let h = typeof hooks === 'function' ? {} : hooks;
  let chan;
  chan = createChannel({
    remote,
    write: (s) => pass(h.onWrite, s, rawWrite, remote),
    close: () => {
      closed = true;
      streamReq.destroy();
      agent.destroy();
    },
    isClosed: () => closed,
  });
  if (typeof hooks === 'function') h = hooks(chan, rawWrite) || {};

  function pump() {
    if (sending || closed || !streaming || !outbox) return;
    const body = outbox;
    outbox = '';
    sending = true;
    const req = http.request({
      host, port, agent, method: 'POST', path: '/amcn/send',
      headers: {
        'content-type': 'application/x-ndjson',
        'content-length': Buffer.byteLength(body),
        'x-amcn-cid': cid,
      },
    }, (res) => {
      res.resume();
      res.on('end', () => {
        sending = false;
        if (res.statusCode >= 400) {
          console.error(`[wire] send refused by ${host}:${port}: ` +
            `HTTP ${res.statusCode}`);
        }
        pump();
      });
    });
    // No retry, deliberately: a dropped write on a dead TCP socket is lost
    // too, and a transport that silently re-sends would break the idempotency
    // assumptions settlement makes (§4 #15).
    req.on('error', (err) => {
      sending = false;
      console.error(`[wire] send failed: ${err.code || err.message}`);
    });
    req.end(body);
  }

  const streamReq = http.request({
    host, port, agent: new http.Agent({ keepAlive: true, maxSockets: 1 }),
    method: 'GET', path: `/amcn/stream?cid=${cid}`,
    headers: { accept: 'application/x-ndjson' },
  }, (res) => {
    if (res.statusCode !== 200) {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        console.error(`[transport] ${host}:${port} refused the stream: ` +
          `HTTP ${res.statusCode} ${body.trim()}`);
        chan.emitClose();
      });
      return;
    }
    streaming = true;
    res.setEncoding('utf8');
    res.on('data', (t) => pass(h.onData, t, (out) => chan.feed(out), remote));
    res.on('close', () => chan.emitClose());
    pump();
  });
  streamReq.on('error', (err) => {
    console.error(`[wire] socket error: ${err.code || err.message}`);
    chan.emitClose();
  });
  streamReq.end();

  return chan;
}

function probe({ port, host = '127.0.0.1', timeoutMs = 4000 }) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, method: 'GET', path: '/amcn/health',
      timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

module.exports = { name, listen, dial, probe };
