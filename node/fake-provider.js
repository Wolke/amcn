// Local stand-in for a model provider's OpenAI-compatible endpoint, so the
// real HTTP adapter path can be exercised without paid API calls.
// Deterministic: replies with sha256 of the last user message (so the
// requester's deterministic verification still works).
//
// env: FAKE_PORT, FAKE_KEY (the only Bearer token it accepts)
'use strict';
const http = require('node:http');
const { sha256 } = require('./lib/wire');

const PORT = Number(process.env.FAKE_PORT);
const KEY = process.env.FAKE_KEY;
let requests = 0, authOk = 0;

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ requests, authOk }));
  }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404); return res.end();
  }
  requests += 1;
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    res.writeHead(401); return res.end('{"error":"bad key"}');
  }
  authOk += 1;
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const prompt = JSON.parse(body).messages.at(-1).content;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: sha256(prompt) } }],
    }));
  });
}).listen(PORT, '127.0.0.1', () =>
  console.log(`[fake-provider] :${PORT} up (key-gated OpenAI-compatible)`));
